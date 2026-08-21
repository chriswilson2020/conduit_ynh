import { test, expect } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { ImapFlow } from "imapflow";

/**
 * One serial journey through the Phase 4 mail flows: seed a mailbox over
 * IMAP, add the account through the settings form, watch the sync populate
 * the inbox, read the conversation, link a deal to it, reply, and find it
 * again through the filters, global search and the contact's Mail tab.
 * Phase 4.2 extends the same journey with a SECOND USER (see the 4.2 section
 * at the bottom): the private-by-default visibility model, the deal link as
 * the deliberate sharing act, the Settings toggle, and the owner-only move
 * rights, each asserted from user B's browser context.
 *
 * HOW THE SECOND USER WORKS, verified against the API's auth path rather
 * than assumed: identityFromHeaders (api: auth.ts) uses the `ynh-user`
 * header whenever the key is PRESENT, and falls back to CONDUIT_DEV_USER
 * only when it is entirely absent -- in production SSOwat overwrites the
 * header before proxying, but the e2e webServer has no SSOwat in front of
 * it, so a context created with `extraHTTPHeaders: { "ynh-user": ... }` IS
 * that user for every request it makes (page loads, fetches, SSE alike),
 * and resolveUser (api: users.ts) upserts the row on first sight. That
 * makes the spec's two-user journey a real journey here, not a seeded
 * approximation.
 *
 * THIS FILE NEEDS THE CI MAIL FIXTURE and has no other home: it talks to the
 * Dovecot and Mailpit containers .github/workflows/test.yml's e2e job starts,
 * through the E2E_MAIL_ and E2E_MAILPIT_URL env that job sets (the defaults
 * below are the same values, so a local run with those containers up would
 * work too). It is not gated behind an env check the way the vitest
 * integration suite is: the whole Playwright suite is CI-only for this
 * project, so a "skip when the fixture is absent" would only ever hide a
 * fixture that had gone missing in the one place it must not.
 *
 * RETRY SAFETY IS RUN-ID SCOPING, and it is load-bearing here in a way it is
 * not in the other specs. Nothing empties the Dovecot mailbox and nothing
 * resets the database between Playwright retries, so a second attempt starts
 * with the previous attempt's mail already in INBOX and its threads already
 * in the database. Every fixture subject, address and body marker therefore
 * carries a run id, every assertion matches a run-id-scoped SET rather than a
 * bare count, and the one genuinely global number in the app -- the nav's
 * unread badge -- is asserted as a DELTA against what it read before the
 * step, never as an absolute. The one thing scoping cannot fix is a second
 * live mail account pointed at the same mailbox (each account ingests the
 * same message into the same thread, so the conversation would show every
 * message twice), which is why beforeAll archives whatever accounts a
 * previous attempt left behind.
 *
 * Tests run in file order and share a single page; state (the contact, thread
 * and deal ids) accumulates across them, and a failure stops the rest rather
 * than cascading.
 */

const IMAP_HOST = process.env.E2E_MAIL_IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.E2E_MAIL_IMAP_PORT ?? 993);
const SMTP_HOST = process.env.E2E_MAIL_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.E2E_MAIL_SMTP_PORT ?? 1025);
const USERNAME = process.env.E2E_MAIL_USERNAME ?? "conduit@test.local";
const PASSWORD = process.env.E2E_MAIL_PASSWORD ?? "testpass";
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8025";

/** How long a sync pass, an SSE hint and a refetch get to produce something.
 * Generous: the first pass includes an IMAP connect and LOGIN, and CI's CPU
 * is shared. */
const SYNC_TIMEOUT_MS = 60_000;
/** Per-attempt budget inside pollWithReload, so a failing check reloads
 * rather than burning the whole deadline on one assertion. */
const ATTEMPT_TIMEOUT_MS = 5_000;
/** What one bulk action gets. It is not a fetch: the IMAP MOVEs it queues run
 * on the account's SERIAL sync loop, behind whatever pass that loop is already
 * in the middle of, so this is a mail server's budget rather than an HTTP
 * one. */
const BULK_TIMEOUT_MS = 60_000;
/** And what the list refetch that follows one gets -- an ordinary invalidation,
 * with room for CI's shared CPU. */
const REFETCH_TIMEOUT_MS = 20_000;

const MINUTE_MS = 60_000;

/**
 * The fixture mailboxes, byte-exact as .github/scripts/start-dovecot.sh
 * declares them -- which is how the folders endpoint serves them, how the
 * `folder-<NAME>` testids spell them, and how the bulk request matches them
 * server-side. An IMAP mailbox name is bytes all the way down; nothing here is
 * display-cased or normalized.
 *
 * Junk is the journey's "extra folder" and the fixture carries `\Junk` for
 * exactly that reason: junk and trash are the two roles the CRM leaves
 * switched OFF when it first sees them, so this is the one seeded folder whose
 * message stays out of the CRM until the Settings picker turns it on.
 */
const INBOX_FOLDER = "INBOX";
const JUNK_FOLDER = "Junk";
const TRASH_FOLDER = "Trash";
const ARCHIVE_FOLDER = "Archive";

test.describe.serial("Mail journey", () => {
  // Playwright's default test timeout is 30s, which is LESS than the sync
  // budget below -- so without this the deadline in pollWithReload could
  // never be reached, and a slow sync would report "test timeout of 30000ms
  // exceeded" instead of the assertion that was actually still failing.
  // Applied to the whole group: several tests here wait on a background sync
  // pass, and the ones that do not are unaffected by having headroom they
  // never use.
  test.setTimeout(90_000);

  const runId = Date.now().toString(36);

  const aliceAddress = `alice-${runId}@example.com`;
  const bobAddress = `bob-${runId}@example.com`;
  const contactName = `Alice ${runId}`;
  const aliceSubject = `Renewal ${runId}`;
  const bobSubject = `Logistics ${runId}`;
  // Single alphanumeric tokens, deliberately: these are matched through
  // Postgres full-text search (websearch_to_tsquery) and through an iframe's
  // text content, and a hyphen or a space would split them into two lexemes
  // and turn one exact assertion into two fuzzy ones.
  const textMarker = `plainmarker${runId}`;
  const htmlMarker = `htmlmarker${runId}`;
  const replyBody = `Thanks Alice ${runId}`;
  const accountLabel = `CI Dovecot ${runId}`;
  const pipelineName = `Mail pipeline ${runId}`;
  const dealTitle = `Renewal deal ${runId}`;
  let page: Page;
  let contactId: string;
  let aliceThreadId: string;
  let dealId: string;
  let accountId: string;

  /**
   * User B (Phase 4.2): a second, accountless CRM user, driven through a
   * second browser context whose every request carries `ynh-user` (see the
   * file comment for why the API honours it here). The username is a plain
   * constant, not runId-scoped: resolveUser upserts, so re-seeing the same
   * user across runs and retries is exactly the production shape -- and B's
   * world is defined by the visibility predicate, not by fixtures, so a
   * stable identity leaks nothing between attempts PROVIDED no shared
   * account outlives an attempt (the beforeAll reset below is what makes
   * that hold).
   *
   * NOT a name containing "e2euser": both users live in every user picker
   * from here on (resolveUser rows are global), and a B name that carried
   * the dev user's name as a substring turned every loose
   * getByRole(..., { name: "e2euser" }) into a strict-mode ambiguity --
   * tasks.spec.ts's assignee pick was the real casualty.
   */
  const B_USERNAME = "e2e-second-user";
  let bContext: BrowserContext;
  let bPage: Page;

  /**
   * THE FOUR SUBJECTS BELOW ARE SCOPED PER ATTEMPT, not per run, and that is
   * the difference between a retry that can pass and one that cannot.
   *
   * Everything Alice and Bob assert is a SET -- "this thread is here" -- which
   * a previous attempt's leftovers cannot break. The folder journey opens with
   * the opposite shape: "the Junk message is NOWHERE in the CRM yet", which is
   * a statement about the whole list. A previous attempt that got as far as
   * ticking the folder left a junk thread behind, and archiving its account
   * does not unlist it (archive-not-delete; the threads deliberately stay), so
   * a subject shared with that attempt would make this assertion unrecoverable
   * -- failing every retry for a reason no retry can clear.
   *
   * `runId` is not enough on its own: it is module scope, and whether that is
   * re-evaluated between attempts is Playwright's business (it discards the
   * worker on failure today), not something this file should rest an
   * unrecoverable assertion on. The retry INDEX is the fact that is true
   * regardless, so it is what these are stamped with, in beforeAll.
   */
  let junkSubject = "";
  /** The two archived in one gesture, and the one trashed after them. Kept
   * apart from Alice's and Bob's threads so the earlier tests' assertions
   * describe the same conversations afterwards as before. */
  let archiveSubjects: [string, string] = ["", ""];
  let trashSubject = "";

  // -- fixtures --------------------------------------------------------

  /** One message, CRLF-terminated the way it goes onto the wire: this buffer
   * is APPENDed verbatim and parsed by mailparser at the other end. */
  function rfc822(headers: string[], body: string): Buffer {
    return Buffer.from([...headers, "", body, ""].join("\r\n"), "utf8");
  }

  /**
   * A two-message thread from Alice plus one unrelated message from Bob.
   *
   * The thread is a real References chain (not two messages that merely share
   * a subject), because that is what mail-ingest's threading actually
   * consults. Its second message is text/html and its first is text/plain, so
   * the conversation renders one of each: the html body in an iframe (the
   * frameLocator leg) and the plain one in a <pre> (the direct leg).
   *
   * Dates are minutes old, not days: the account is created with the form's
   * default 90-day backfill window, and the first pass filters on
   * INTERNALDATE, which is what append's third argument sets.
   */
  function fixtures(): { raw: Buffer; date: Date; folder: string }[] {
    const now = Date.now();
    const aliceFirstAt = new Date(now - 30 * MINUTE_MS);
    const aliceSecondAt = new Date(now - 20 * MINUTE_MS);
    const bobAt = new Date(now - 10 * MINUTE_MS);
    const rootId = `<alice-1-${runId}@example.com>`;

    return [
      {
        folder: INBOX_FOLDER,
        date: aliceFirstAt,
        raw: rfc822([
          `From: Alice Example <${aliceAddress}>`,
          `To: Conduit <${USERNAME}>`,
          `Subject: ${aliceSubject}`,
          `Message-ID: ${rootId}`,
          `Date: ${aliceFirstAt.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
        ], `Hello from Alice. Marker ${textMarker}.`),
      },
      {
        folder: INBOX_FOLDER,
        date: aliceSecondAt,
        raw: rfc822([
          `From: Alice Example <${aliceAddress}>`,
          `To: Conduit <${USERNAME}>`,
          // "Re:" is stripped by normalizeSubject, so the THREAD is titled
          // aliceSubject -- which is what every assertion below matches on.
          `Subject: Re: ${aliceSubject}`,
          `Message-ID: <alice-2-${runId}@example.com>`,
          `In-Reply-To: ${rootId}`,
          `References: ${rootId}`,
          `Date: ${aliceSecondAt.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8",
        ], `<html><body><p>Second one. Marker ${htmlMarker}.</p></body></html>`),
      },
      {
        folder: INBOX_FOLDER,
        date: bobAt,
        raw: rfc822([
          `From: Bob Unrelated <${bobAddress}>`,
          `To: Conduit <${USERNAME}>`,
          `Subject: ${bobSubject}`,
          `Message-ID: <bob-1-${runId}@example.com>`,
          `Date: ${bobAt.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
        ], `Nothing to do with Alice, and nobody in the CRM has this address.`),
      },
      ...folderFixtures(now),
    ];
  }

  /**
   * The Phase 4.1 fixtures: one message in the folder the CRM does not sync
   * until it is told to, and three in INBOX for the bulk actions.
   *
   * THE BULK THREE ARE SECONDS APART, not minutes, and that is what makes a
   * shift-range over two of them deterministic. A range selection takes every
   * row BETWEEN the two clicked ones, so the two archived here have to be
   * neighbours in a list that is ordered by each thread's latest message and
   * may also hold a previous attempt's threads (nothing empties the mailbox
   * between Playwright retries). Nothing else in this mailbox -- from this
   * attempt or any earlier one -- can carry a timestamp inside a window three
   * seconds wide that was opened when this attempt started, so nothing can sort
   * between them.
   */
  function folderFixtures(now: number): { raw: Buffer; date: Date; folder: string }[] {
    const message = (subject: string, folder: string, date: Date) => ({
      folder,
      date,
      raw: rfc822([
        `From: Carol Vendor <carol-${runId}@example.com>`,
        `To: Conduit <${USERNAME}>`,
        `Subject: ${subject}`,
        `Message-ID: <${subject.replace(/[^a-z0-9]+/gi, "-")}@example.com>`,
        `Date: ${date.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ], `Filed under ${folder}.`),
    });

    return [
      message(junkSubject, JUNK_FOLDER, new Date(now - 5 * MINUTE_MS)),
      message(archiveSubjects[0], INBOX_FOLDER, new Date(now - 3_000)),
      message(archiveSubjects[1], INBOX_FOLDER, new Date(now - 2_000)),
      message(trashSubject, INBOX_FOLDER, new Date(now - 1_000)),
    ];
  }

  /**
   * Put the fixtures in the mailbox, over IMAP, before any account exists to
   * sync them -- so the account's very first pass is what ingests them, and
   * the contact created before that is there for auto-linking to find.
   *
   * No flags on the APPEND: the messages have to arrive UNSEEN for the unread
   * badge and the mark-read step to mean anything. rejectUnauthorized is off
   * because CI's Dovecot serves a self-signed certificate (the same reason
   * the workflow sets MAIL_TLS_REJECT_UNAUTHORIZED=0 for the app itself).
   */
  async function seedMailbox(): Promise<void> {
    await withImap(async (client) => {
      for (const fixture of fixtures()) {
        await client.append(fixture.folder, fixture.raw, [], fixture.date);
      }
    });
  }

  /**
   * One short-lived IMAP connection, for the two things this spec does outside
   * the app: seeding the mailbox before any account exists, and reading a
   * folder back afterwards to see where the CRM's moves actually put the mail.
   *
   * Raw imapflow rather than the app's adapter, deliberately and unlike the
   * vitest integration suite: the point of the check below is that the MESSAGE
   * IS ON THE SERVER, and asking the same code that moved it would be asking
   * the app to mark its own homework.
   */
  async function withImap<T>(use: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: USERNAME, pass: PASSWORD },
      tls: { rejectUnauthorized: false },
      logger: false,
    });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.logout();
    }
  }

  /** Every subject currently in `folder`, straight off the server. Read-only,
   * so this cannot be what marks a fixture \Seen. */
  async function subjectsIn(folder: string): Promise<string[]> {
    return await withImap(async (client) => {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      if (mailbox.exists === 0) return [];
      const subjects: string[] = [];
      for await (const message of client.fetch("1:*", { envelope: true })) {
        subjects.push(message.envelope?.subject ?? "");
      }
      return subjects;
    });
  }

  // -- helpers ---------------------------------------------------------

  /**
   * Retry `check` across page reloads until it passes or the deadline runs
   * out.
   *
   * The inbox IS live over SSE, so most of these pass on the first attempt.
   * The reload is the belt to that braces: what is being waited for here is a
   * background sync pass on the server, and a spec that could only ever learn
   * about it through one SSE hint would turn any lost hint into a hard
   * failure minutes later with nothing to read. Each check uses short
   * assertion timeouts so the loop actually gets to iterate.
   */
  async function pollWithReload(check: () => Promise<void>, timeoutMs = SYNC_TIMEOUT_MS): Promise<void> {
    return pollWithReloadOn(page, check, timeoutMs);
  }

  /** The same loop against an explicit page -- the 4.2 tests drive user B's
   * context through it while A's page holds its own state. */
  async function pollWithReloadOn(
    target: Page, check: () => Promise<void>, timeoutMs = SYNC_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await target.reload();
      }
    }
  }

  /** Thread rows are addressed by their subject, not by an id this spec would
   * have to know in advance -- the same shape pipeline.spec.ts's columnByName
   * uses, and every subject carries the run id. */
  function threadRow(subject: string): Locator {
    return threadRowOn(page, subject);
  }

  function threadRowOn(target: Page, subject: string): Locator {
    return target.locator('[data-testid^="thread-row-"]').filter({ hasText: subject });
  }

  async function idOf(locator: Locator, prefix: string): Promise<string> {
    const testId = await locator.getAttribute("data-testid");
    return (testId as string).replace(prefix, "");
  }

  /** The nav badge's number, with ABSENT read as zero -- shell.tsx renders
   * nothing at all at zero rather than a "0". */
  async function unreadBadge(): Promise<number> {
    const badge = page.getByTestId("unread-badge");
    if ((await badge.count()) === 0) return 0;
    return Number(((await badge.textContent()) ?? "0").trim());
  }

  async function expectUnreadBadge(expected: number): Promise<void> {
    const badge = page.getByTestId("unread-badge");
    if (expected === 0) await expect(badge).toHaveCount(0, { timeout: ATTEMPT_TIMEOUT_MS });
    else await expect(badge).toHaveText(String(expected), { timeout: ATTEMPT_TIMEOUT_MS });
  }

  /** One input in the account dialog. The form wraps each control in a
   * `field-<name>` testid (settings-mail.tsx's Field) precisely so a test can
   * reach the input inside a control that may not be a plain input. */
  function accountField(name: string): Locator {
    return page.getByTestId("account-form").getByTestId(`field-${name}`).locator("input");
  }

  /**
   * Tick the box beside a row.
   *
   * The checkbox is a SIBLING of the row button rather than a child of it (a
   * checkbox inside a button is invalid markup, and every tick would open the
   * conversation), so it is addressed by the thread's own id rather than
   * through the row locator. With `shift` it extends the selection to a RANGE:
   * React maps a checkbox's onChange onto the native click, which is what
   * carries the modifier through to the list's range logic.
   */
  async function tickThread(subject: string, options: { shift?: boolean } = {}): Promise<void> {
    const id = await idOf(threadRow(subject), "thread-row-");
    await page.getByTestId(`thread-checkbox-${id}`)
      .click(options.shift === true ? { modifiers: ["Shift"] } : {});
  }

  // --------------------------------------------------------------------

  test.beforeAll(async ({ browser }, testInfo) => {
    page = await browser.newPage();
    // User B rides a context of their own; @playwright/test's newContext
    // still applies the config's baseURL, and merges these headers into
    // every request the context makes.
    bContext = await browser.newContext({ extraHTTPHeaders: { "ynh-user": B_USERNAME } });
    bPage = await bContext.newPage();

    // The per-ATTEMPT half of the scoping (see the declarations above): the
    // retry index is what distinguishes this attempt's fixtures from the ones
    // a previous attempt left in the mailbox and in the database, whether or
    // not the module was re-evaluated in between. Assigned before seedMailbox
    // below, which is what puts these subjects on the server.
    const attemptId = `${runId}x${testInfo.retry}`;
    junkSubject = `Newsletter ${attemptId}`;
    archiveSubjects = [`Invoice ${attemptId}`, `Shipping ${attemptId}`];
    trashSubject = `Offer ${attemptId}`;

    // A previous attempt's account would sync this same mailbox alongside the
    // one added below, ingesting every message twice (once per account, into
    // the same thread) and doubling the conversation. Archiving stops its
    // sync and leaves its messages alone, which run-id scoping already
    // handles. A no-op on the first attempt, where there are no accounts.
    const response = await page.request.get("/api/mail/accounts");
    expect(response.ok()).toBe(true);
    const { own } = await response.json() as {
      own: { id: string; archivedAt: string | null; visibility: "private" | "shared" }[];
    };
    // Only LIVE accounts need (or admit) the visibility reset -- a
    // shared+archived leftover would be uncleanable from here (the PATCH
    // refuses archived rows) and would poison B's empty-inbox assertions
    // permanently, but that state cannot arise in this suite, by
    // construction: CI's postgres is fresh per run, and within a run the
    // ONLY archiver of accounts is this very block, which always flips a
    // shared account private FIRST -- the journey's own tests flip
    // visibility but never archive, so every account this loop archives is
    // private at that moment, and nothing can re-share it afterwards (the
    // toggle does not render on archived cards and the PATCH refuses them).
    // If this spec is ever pointed at a PERSISTENT database where that
    // invariant does not hold, widen the flip to unarchive -> flip ->
    // re-archive (the documented recovery road) rather than deleting this
    // comment.
    for (const account of own) {
      if (account.archivedAt === null) {
        // Phase 4.2 retry hygiene, and it must run BEFORE the archive below:
        // an attempt that failed between the shared flip and the flip back
        // would leave a SHARED account behind, archiving does not clear
        // visibility, and the account PATCH refuses archived rows -- so this
        // is the one moment the leftover can be made private again. Without
        // it, every previous attempt's threads would sit in user B's inbox
        // and the 4.2 "empty" assertions would fail every retry for a reason
        // no retry could clear (the same unrecoverability class the
        // per-attempt subjects above exist for).
        if (account.visibility === "shared") {
          const flipped = await page.request.patch(`/api/mail/accounts/${account.id}`, {
            data: { visibility: "private" },
          });
          expect(flipped.ok()).toBe(true);
        }
        // Checked, not fired and forgotten: this POST is the whole of what
        // stands between a retry and a double-ingested conversation, and it
        // is a line that only ever runs ON a retry -- so a 4xx here has to
        // fail with "the archive was refused" rather than surface two steps
        // later as a conversation with twice the messages it should have.
        const archived = await page.request.post(`/api/mail/accounts/${account.id}/archive`);
        expect(archived.ok()).toBe(true);
      }
    }

    await seedMailbox();
  });

  test.afterAll(async () => {
    await page.close();
    await bContext.close();
  });

  test("creates the contact the inbound mail will auto-link to", async () => {
    await page.goto("/contacts");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("First name").fill(contactName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    contactId = page.url().split("/").pop() as string;

    // Auto-linking is an exact address match against contacts.emails, so this
    // field is the entire reason the thread will find her.
    const emails = page.getByTestId("field-emails");
    await emails.click();
    await emails.locator("input").fill(aliceAddress);
    await emails.locator("input").press("Enter");
    await expect(emails).toContainText(aliceAddress);
  });

  test("adds the mail account from the Dovecot preset and tests both protocols", async () => {
    await page.goto("/settings/mail");
    await expect(page.getByTestId("mail-settings")).toBeVisible();
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("account-form")).toBeVisible();

    await accountField("label").fill(accountLabel);
    await accountField("email").fill(USERNAME);

    // The preset first, then the overrides: it fills the YunoHost mail
    // stack's standard ports (993/tls, 587/starttls) and the signed-in user's
    // name, none of which is where CI's containers are. The SECURITY halves
    // it sets are right as they stand -- Dovecot serves IMAPS and Mailpit
    // demands the STARTTLS upgrade -- so only host, port, username and
    // password are typed over.
    await page.getByRole("button", { name: "Local Dovecot" }).click();
    await accountField("imap-host").fill(IMAP_HOST);
    await accountField("imap-port").fill(String(IMAP_PORT));
    await accountField("smtp-host").fill(SMTP_HOST);
    await accountField("smtp-port").fill(String(SMTP_PORT));
    await accountField("username").fill(USERNAME);
    await accountField("password").fill(PASSWORD);

    const form = page.getByTestId("account-form");
    await form.getByRole("button", { name: "Test connection" }).click();
    const testResult = form.getByTestId("account-test-result");
    // A failure renders "IMAP: <error>", never "IMAP connected", so this is
    // an assertion about success rather than about the panel existing.
    await expect(testResult).toContainText("IMAP connected", { timeout: 30_000 });
    await expect(testResult).toContainText("SMTP connected");

    await form.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("account-form")).toBeHidden();
    // The card carries the account id in its testid; the label is what makes
    // it this run's card.
    await expect(
      page.locator('[data-testid^="mail-account-"]').filter({ hasText: accountLabel }),
    ).toBeVisible();
  });

  test("syncs the seeded mail into the inbox and auto-links Alice's thread", async () => {
    await page.goto("/mail");

    // SETS, not counts: the inbox may also hold threads a previous attempt
    // ingested, and the assertion is that THESE two arrived.
    await pollWithReload(async () => {
      await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await expect(threadRow(bobSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      // The html message's snippet, which only exists once the SECOND message
      // of the thread has been ingested. Waiting for it here is what keeps
      // the mark-read step below honest: a message arriving after a thread
      // was marked read would make it unread again, and the conversation is
      // only marked once per mount.
      await expect(threadRow(aliceSubject)).toContainText(htmlMarker, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    aliceThreadId = await idOf(threadRow(aliceSubject), "thread-row-");

    // Auto-linked: the row carries her contact chip, by name.
    await expect(threadRow(aliceSubject)).toContainText(contactName);
    // ...and Bob's does not, since no contact holds his address.
    await expect(threadRow(bobSubject)).not.toContainText(contactName);

    // The account filter is deliberately ABSENT with a single account (Task
    // 10: "All accounts" versus the one account is a no-op picker); the three
    // toggles are always there.
    await expect(page.getByTestId("filter-account")).toHaveCount(0);
    await expect(page.getByTestId("filter-unread")).toBeVisible();
  });

  test("opens the conversation, renders both bodies, and clears the thread's unread badge", async () => {
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toBeVisible();

    // Read BEFORE opening anything: the badge counts every unread thread in
    // the installation, so the only claim this spec can make about it is a
    // delta of its own making. Waited for rather than read straight off the
    // page -- an absent badge means zero, which is also what it looks like
    // while its first fetch is still in flight.
    await expect(page.getByTestId("unread-badge")).toBeVisible();
    const before = await unreadBadge();
    expect(before).toBeGreaterThanOrEqual(2);

    await threadRow(aliceSubject).click();
    await expect(page).toHaveURL(`/mail?thread=${aliceThreadId}`);
    const conversation = page.getByTestId("conversation");
    await expect(conversation).toBeVisible();

    // `message-<id>` is prefix-matched; the body testids are `body-<id>`
    // precisely so they do not double this count (conversation.tsx).
    const messages = conversation.locator('[data-testid^="message-"]');
    await expect(messages).toHaveCount(2);

    // The newest message is the html one and is expanded by default, so it is
    // the one iframe on the page. data-body-kind is how a test tells the two
    // renderings apart without guessing.
    const htmlBody = page.locator('[data-body-kind="html"]');
    await expect(htmlBody).toHaveCount(1);
    await expect(page.frameLocator('[data-body-kind="html"]').locator("body")).toContainText(htmlMarker);

    // The older, text-only message renders as a <pre> once expanded -- no
    // iframe, nothing to reach through. Addressed by its collapsed state
    // rather than by position: the header toggle is the button carrying
    // aria-expanded, which is what makes it the one to click.
    const plain = messages.first();
    await plain.getByRole("button", { expanded: false }).click();
    await expect(plain.locator('[data-body-kind="text"]')).toContainText(textMarker);

    // Opening marked it read: the row's unread dot is gone and the badge is
    // down by exactly this one thread (Bob's is still unread). Through
    // pollWithReload because a reload re-mounts the conversation and re-marks
    // it -- which is what makes this converge rather than latch, in the
    // window where a stray ingest could have re-flagged the thread.
    await pollWithReload(async () => {
      await expect(threadRow(aliceSubject).getByRole("img", { name: "Unread" }))
        .toHaveCount(0, { timeout: ATTEMPT_TIMEOUT_MS });
      await expectUnreadBadge(before - 1);
    });
    await expect(threadRow(bobSubject).getByRole("img", { name: "Unread" })).toHaveCount(1);
  });

  test("suggests Alice's open deal on the conversation and links it", async () => {
    // A pipeline, a stage and a deal, through the board the way a user makes
    // one.
    await page.goto("/pipelines");
    await page.getByRole("button", { name: "New pipeline" }).click();
    await page.getByPlaceholder("Pipeline name").fill(pipelineName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "+ Stage", exact: true }).click();
    await page.getByPlaceholder("Stage name").fill("Lead");
    await page.getByRole("button", { name: "Add" }).click();
    // The tile collapsing back is the signal the stage landed (pipeline.spec's
    // addStage makes the same wait for the same reason).
    await expect(page.getByRole("button", { name: "+ Stage", exact: true })).toBeVisible();

    const column = page.locator('[data-testid^="column-"]').first();
    await column.getByRole("button", { name: "New deal" }).click();
    await page.getByPlaceholder("Deal title").fill(dealTitle);
    await page.getByRole("button", { name: "Create" }).click();
    const card = column.locator('[data-testid^="card-"]').filter({ hasText: dealTitle });
    await expect(card).toBeVisible();
    dealId = await idOf(card, "card-");

    // THE ONE STEP THAT IS NOT THE UI, because there is no UI for it: a
    // deal's contact is rendered read-only on the deal page (a Link or a
    // dash) and the board's New deal dialog takes a title and a value, so
    // deals.contact_id is reachable only through PATCH /api/deals/:id today.
    // The suggestion being tested is the server's -- open deals of whoever
    // the thread is linked to -- and it needs that column set somehow.
    const patched = await page.request.patch(`/api/deals/${dealId}`, { data: { contactId } });
    expect(patched.ok()).toBe(true);

    await page.goto(`/mail?thread=${aliceThreadId}`);
    const suggestion = page.getByTestId(`deal-suggestion-${dealId}`);
    await pollWithReload(async () => {
      await expect(suggestion).toBeVisible({ timeout: ATTEMPT_TIMEOUT_MS });
    });
    await suggestion.click();

    // Linked: the chip replaces the suggestion, and the suggestion is gone
    // because a thread that HAS a deal gets none.
    const dealChip = page.getByTestId("link-panel").getByTestId("thread-link-deal");
    await expect(dealChip).toBeVisible();
    await expect(dealChip).toContainText(dealTitle);
    await expect(suggestion).toHaveCount(0);
  });

  test("replies through the composer, and the reply reaches Mailpit and the conversation", async () => {
    await page.goto(`/mail?thread=${aliceThreadId}`);
    await expect(page.getByTestId("conversation")).toBeVisible();

    await page.getByTestId("reply-button").click();
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();

    // To and Subject arrive seeded from the thread (Alice, "Re: <subject>");
    // only the body is typed. Real key events rather than fill(): the body is
    // a TipTap document, not an input, and its model is built from what the
    // editor sees happen to it.
    await expect(composer).toContainText(aliceAddress);
    await expect(page.getByTestId("composer-subject")).toHaveValue(`Re: ${aliceSubject}`);
    await page.getByTestId("composer-body").click();
    await page.keyboard.type(replyBody);
    await page.getByTestId("composer-send").click();
    await expect(composer).toBeHidden({ timeout: 30_000 });

    // It really went out over SMTP: Mailpit holds what the app submitted,
    // addressed to Alice and subject-threaded as a reply.
    const expectedSubject = `Re: ${aliceSubject}`;
    await expect.poll(async () => {
      const response = await page.request.get(`${MAILPIT_URL}/api/v1/messages?limit=200`);
      if (!response.ok()) return null;
      const body = await response.json() as {
        messages?: { Subject?: string; To?: { Address?: string }[] }[];
      };
      return (body.messages ?? []).find((message) =>
        message.Subject === expectedSubject
        && (message.To ?? []).some((entry) => entry.Address === aliceAddress)) ?? null;
    }, { timeout: 20_000 }).not.toBeNull();

    // ...and it is in the conversation, as an outbound third message. It
    // lands there through the send's own response, so this needs no sync
    // pass; the poll is for the invalidation to have been applied.
    const messages = page.getByTestId("conversation").locator('[data-testid^="message-"]');
    await pollWithReload(async () => {
      await expect(messages).toHaveCount(3, { timeout: ATTEMPT_TIMEOUT_MS });
    });
    const sent = messages.last();
    await expect(sent).toContainText(USERNAME);
    // The composer writes html, so the sent body is an iframe like any other
    // html message -- and being the newest, it is the expanded one.
    await expect(sent.frameLocator('[data-body-kind="html"]').locator("body")).toContainText(replyBody);
  });

  test("hides the linked thread behind the unlinked filter and brings it back", async () => {
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toHaveCount(1);

    await page.getByTestId("filter-unlinked").click();
    // Alice's thread is claimed (contact and deal); Bob's is claimed by
    // nothing, which is exactly what the triage filter is for.
    await expect(threadRow(aliceSubject)).toHaveCount(0);
    await expect(threadRow(bobSubject)).toHaveCount(1);

    await page.getByTestId("filter-unlinked").click();
    await expect(threadRow(aliceSubject)).toHaveCount(1);
    await expect(threadRow(bobSubject)).toHaveCount(1);
  });

  test("finds the conversation by a body term through global search", async () => {
    await page.goto("/mail");
    // A word from the first message's BODY, not its subject: the mail group
    // is the only full-text one in the search, over mail_messages' tsvector.
    await page.getByTestId("search-input").fill(textMarker);

    const result = page.getByTestId("search-result").filter({ hasText: aliceSubject });
    await expect(result).toBeVisible();
    await result.click();
    await expect(page).toHaveURL(`/mail?thread=${aliceThreadId}`);
    await expect(page.getByTestId("conversation")).toContainText(aliceSubject);
  });

  test("lists the conversation on the contact's Mail tab", async () => {
    await page.goto(`/contacts/${contactId}`);
    await page.getByTestId("mail-tab").click();

    // The rail is the shared thread list with a record filter, so the row is
    // the same testid family -- and Bob's thread, linked to nobody, is not
    // here.
    await expect(threadRow(aliceSubject)).toHaveCount(1);
    await expect(threadRow(bobSubject)).toHaveCount(0);
  });

  // -- Phase 4.1: folders, and the two moves that are real IMAP moves ------

  test("classifies the move targets and switches the extra folder on from Settings", async () => {
    // The seeded Junk message is nowhere in the CRM: junk and trash are the two
    // roles a folder is left switched OFF in when it is first seen, so nothing
    // has ever walked that mailbox. Alice's row is waited for first, so the
    // absence below is an absence from a LOADED list rather than from one that
    // has not arrived yet.
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRow(junkSubject)).toHaveCount(0);

    await page.goto("/settings/mail");
    const card = page.locator('[data-testid^="mail-account-"]').filter({ hasText: accountLabel });
    await expect(card).toBeVisible();
    accountId = await idOf(card, "mail-account-");
    await page.getByTestId(`folders-toggle-${accountId}`).click();

    // Discovery read the fixture's SPECIAL-USE attributes and filled the
    // account's two move targets from them. Not decoration: an account with
    // neither a stored nor a detected target refuses every thread of a bulk
    // Archive or Trash with `no_target`, so both actions below rest on this.
    await expect(page.getByTestId(`trash-folder-${accountId}`))
      .toHaveValue(TRASH_FOLDER, { timeout: REFETCH_TIMEOUT_MS });
    await expect(page.getByTestId(`archive-folder-${accountId}`)).toHaveValue(ARCHIVE_FOLDER);

    // The picker addresses folders by their byte-exact server name, which is
    // also what the sidebar row and the bulk request will carry.
    const junkBox = page.getByTestId(`folder-picker-${JUNK_FOLDER}`);
    await expect(junkBox).not.toBeChecked({ timeout: REFETCH_TIMEOUT_MS });
    // click(), NOT check(): the box is a CONTROLLED input whose `checked` comes
    // from the folders query, so React puts it straight back to false while the
    // PATCH is in flight -- and check() verifies the state immediately after
    // clicking and fails with "clicking the checkbox did not change its state".
    // The tick appears when the request lands and the query refetches, which is
    // what the assertion below waits for.
    await junkBox.click();
    await expect(junkBox).toBeChecked({ timeout: REFETCH_TIMEOUT_MS });
  });

  test("syncs the enabled folder and shows its message under the folder filter", async () => {
    await page.goto("/mail");
    // Enabling ASKED for a pass rather than waiting for one, so this is that
    // pass walking the folder for the first time.
    await pollWithReload(async () => {
      await expect(threadRow(junkSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // NOTHING FROM HERE ON MAY RELOAD THE PAGE. The folder view is the inbox's
    // own state, not a URL parameter, so a reload puts the list back to "All
    // mail" -- and every assertion below is about a folder-scoped view.
    const junkRow = page.getByTestId(`folder-${JUNK_FOLDER}`);
    await expect(junkRow).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await junkRow.click();
    await expect(junkRow).toHaveAttribute("aria-current", "true");

    await expect(threadRow(junkSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    // A real filter, not a highlight: Alice's conversation has no message here.
    await expect(threadRow(aliceSubject)).toHaveCount(0);
  });

  test("archives two conversations in one gesture, and Dovecot has them in Archive", async () => {
    await page.goto("/mail");
    const inboxRow = page.getByTestId(`folder-${INBOX_FOLDER}`);
    await inboxRow.click();
    await expect(inboxRow).toHaveAttribute("aria-current", "true");
    await expect(threadRow(archiveSubjects[0])).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    // A tick and then a shift-click: the range takes every row BETWEEN the two,
    // and these two are neighbours by construction (see folderFixtures). The
    // count is the assertion that says so -- a range that had swept up a third
    // row reads "3 selected" here rather than failing three assertions later.
    await tickThread(archiveSubjects[1]);
    await tickThread(archiveSubjects[0], { shift: true });
    await expect(page.getByTestId("bulk-count")).toHaveText("2 selected");

    await page.getByTestId("bulk-archive").click();

    // `bulk-result` filling IS the wait for `bulk-pending` to clear: the bar
    // unmounts as the result arrives and the two are never on screen together.
    // Given a mail server's budget, not a fetch's -- the MOVEs queue behind
    // whatever pass the account's serial loop is already running.
    await expect(page.getByTestId("bulk-result"))
      .toContainText("2 archived", { timeout: BULK_TIMEOUT_MS });
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);

    // Out of the folder they were archived from...
    await expect(threadRow(archiveSubjects[0])).toHaveCount(0, { timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRow(archiveSubjects[1])).toHaveCount(0);

    // ...and really on the server. Asked of Dovecot directly rather than of the
    // app that says it put them there.
    await expect.poll(() => subjectsIn(ARCHIVE_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toEqual(expect.arrayContaining(archiveSubjects));
  });

  test("moves the third to Trash, where the conversation still says where it went", async () => {
    await page.goto("/mail");
    const inboxRow = page.getByTestId(`folder-${INBOX_FOLDER}`);
    await inboxRow.click();
    // Asserted, not assumed: a click that did not land would leave the list in
    // the "All mail" view, and a bulk action made there is the WHOLE-THREAD
    // mode rather than the folder-scoped one -- a different request, silently.
    await expect(inboxRow).toHaveAttribute("aria-current", "true");
    await expect(threadRow(trashSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    await tickThread(trashSubject);
    await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");
    await page.getByTestId("bulk-trash").click();

    await expect(page.getByTestId("bulk-result"))
      .toContainText("1 moved to Trash", { timeout: BULK_TIMEOUT_MS });
    await expect(threadRow(trashSubject)).toHaveCount(0, { timeout: REFETCH_TIMEOUT_MS });
    await expect.poll(() => subjectsIn(TRASH_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(trashSubject);

    // THE CRM NEVER EXPUNGES. The conversation is still there to read -- "All
    // mail" reaches it, since it has left the INBOX view for good -- and it
    // says where its message now lives.
    await page.getByTestId("folder-view-all").click();
    await expect(threadRow(trashSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await threadRow(trashSubject).click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await expect(page.getByTestId("trash-chip")).toBeVisible();
  });

  // -- Phase 4.2: private by default, the deal link as the sharing act, the
  //    Settings toggle, owner-only moves -- all from user B's own context ----

  test("keeps the private mailbox out of the second user's inbox entirely", async () => {
    await bPage.goto("/mail");
    // The loaded-list sentinel and the assertion in one: B owns no mail
    // account, so an EMPTY list renders the no-account pointer -- if any of
    // A's threads leaked in, this node would not render at all. Absolute
    // emptiness is safe across retries only because beforeAll flips every
    // leftover account back to private: B's inbox is defined by the
    // predicate (own OR shared accounts), not by this run's fixtures.
    await expect(bPage.getByTestId("inbox-no-account")).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(0);
    await expect(threadRowOn(bPage, bobSubject)).toHaveCount(0);
    // The unread computations agree: nothing is WAITING in B's mailbox, so
    // the nav badge is absent (shell.tsx renders nothing at zero).
    await expect(bPage.getByTestId("unread-badge")).toHaveCount(0);
  });

  test("carries the deal-linked thread to the second user on the record and in search, not the inbox", async () => {
    // The deal page is ordinary shared CRM; its Mail tab runs at record scope,
    // where the deliberate deal link (made by A, clicks ago) IS the share.
    await bPage.goto(`/deals/${dealId}`);
    await bPage.getByTestId("mail-tab").click();
    await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    // ...and ONLY that thread: Bob's, linked to nothing, stays A's alone.
    await expect(threadRowOn(bPage, bobSubject)).toHaveCount(0);

    // The row opens the full conversation for B (record-visible detail)...
    await threadRowOn(bPage, aliceSubject).click();
    await expect(bPage).toHaveURL(`/mail?thread=${aliceThreadId}`);
    const conversation = bPage.getByTestId("conversation");
    await expect(conversation).toBeVisible();
    await expect(conversation).toContainText(aliceSubject);
    // ...with the SERVER moves absent -- B owns no account this thread rides
    // on, and a colleague must never reorganise A's actual mailbox -- while
    // Hide in CRM stays, available to every viewer.
    await expect(bPage.getByTestId("conversation-archive")).toHaveCount(0);
    await expect(bPage.getByTestId("conversation-trash")).toHaveCount(0);
    await expect(bPage.getByTestId("hide-thread")).toBeVisible();

    // Search runs at record scope too: the linked thread is findable by body
    // text from B's context.
    await bPage.getByTestId("search-input").fill(textMarker);
    await expect(
      bPage.getByTestId("search-result").filter({ hasText: aliceSubject }),
    ).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });

    // But the INBOX is a mailbox view (the coordinator's inbox-scope ruling):
    // the deliberately-linked thread surfaces on the record and in search,
    // never in B's personal inbox.
    await bPage.goto("/mail");
    await expect(bPage.getByTestId("inbox-no-account")).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(0);
  });

  test("flips the mailbox to Shared from Settings, which opens B's inbox but not B's move rights", async () => {
    await page.goto("/settings/mail");
    const toggle = page.getByTestId(`visibility-toggle-${accountId}`);
    await expect(toggle).toHaveText("Private", { timeout: REFETCH_TIMEOUT_MS });
    await toggle.click();
    // The switch is NOT optimistic (a same-value submit echoes nothing, so
    // there is nothing to wait on): its label moves when the PATCH lands and
    // the accounts query refetches, which is exactly what this waits for.
    await expect(toggle).toHaveText("Shared", { timeout: REFETCH_TIMEOUT_MS });
    // Persisted, not painted: a fresh load reads the stored row.
    await page.reload();
    await expect(page.getByTestId(`visibility-toggle-${accountId}`))
      .toHaveText("Shared", { timeout: REFETCH_TIMEOUT_MS });

    // B's inbox now carries the shared mailbox's threads -- the badge and the
    // rows change for another user off one Settings click (the three-family
    // SSE frame; the reload inside the poll is the belt to that braces).
    await bPage.goto("/mail");
    await pollWithReloadOn(bPage, async () => {
      await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await expect(threadRowOn(bPage, bobSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // Shared is readable, not movable: selecting a row greys Archive/Trash
    // with the reason as TEXT on the bar, and Hide in CRM stays live.
    const bobThreadId = await idOf(threadRowOn(bPage, bobSubject), "thread-row-");
    await bPage.getByTestId(`thread-checkbox-${bobThreadId}`).click();
    await expect(bPage.getByTestId("bulk-count")).toHaveText("1 selected");
    await expect(bPage.getByTestId("bulk-archive")).toBeDisabled();
    await expect(bPage.getByTestId("bulk-trash")).toBeDisabled();
    await expect(bPage.getByTestId("bulk-hide")).toBeEnabled();
    await expect(bPage.getByTestId("bulk-owner-blocked"))
      .toContainText("only the mailbox owner can archive or trash");
    await bPage.getByTestId("bulk-clear").click();

    // The conversation view agrees with the bar, and stays open for the next
    // test's stale-pane check.
    await threadRowOn(bPage, bobSubject).click();
    await expect(bPage.getByTestId("conversation")).toBeVisible();
    await expect(bPage.getByTestId("conversation-archive")).toHaveCount(0);
    await expect(bPage.getByTestId("conversation-trash")).toHaveCount(0);
    await expect(bPage.getByTestId("hide-thread")).toBeVisible();
  });

  test("flipping back to Private ends B's window with the calm gone state, not an error", async () => {
    // B is parked on the open bobSubject conversation from the previous test.
    await expect(bPage.getByTestId("conversation")).toBeVisible();

    await page.goto("/settings/mail");
    const toggle = page.getByTestId(`visibility-toggle-${accountId}`);
    await expect(toggle).toHaveText("Shared", { timeout: REFETCH_TIMEOUT_MS });
    await toggle.click();
    await expect(toggle).toHaveText("Private", { timeout: REFETCH_TIMEOUT_MS });

    // The flip's SSE frame deliberately carries no per-thread key (spec
    // Amendment 5), so B's open pane lives on its cached bytes until its own
    // next refetch -- the accepted, bounded staleness. The reload IS that
    // refetch, made deterministic: the detail now answers the
    // indistinguishable 404, and the pane must meet it with the calm gone
    // state rather than a raw error line.
    await pollWithReloadOn(bPage, async () => {
      await expect(bPage.getByTestId("conversation-gone")).toBeVisible({ timeout: ATTEMPT_TIMEOUT_MS });
    });
    await expect(bPage.getByTestId("conversation-gone"))
      .toContainText("This conversation is no longer available.");

    // B's inbox is empty again; the deal-linked thread remains reachable on
    // the record (asserted two tests up), which is the retroactive-unsharing
    // semantics the spec settled: flipping back re-applies the predicate,
    // nothing more. This flip is also the run's own hygiene -- the mailbox
    // ends private, the state every attempt starts from.
    await bPage.goto("/mail");
    await expect(bPage.getByTestId("inbox-no-account")).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRowOn(bPage, bobSubject)).toHaveCount(0);
    await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(0);
  });
});
