import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ImapFlow } from "imapflow";

/**
 * One serial journey through the Phase 4 mail flows: seed a mailbox over
 * IMAP, add the account through the settings form, watch the sync populate
 * the inbox, read the conversation, link a deal to it, reply, and find it
 * again through the filters, global search and the contact's Mail tab.
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

const MINUTE_MS = 60_000;

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
  function fixtures(): { raw: Buffer; date: Date }[] {
    const now = Date.now();
    const aliceFirstAt = new Date(now - 30 * MINUTE_MS);
    const aliceSecondAt = new Date(now - 20 * MINUTE_MS);
    const bobAt = new Date(now - 10 * MINUTE_MS);
    const rootId = `<alice-1-${runId}@example.com>`;

    return [
      {
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
      for (const fixture of fixtures()) {
        await client.append("INBOX", fixture.raw, [], fixture.date);
      }
    } finally {
      await client.logout();
    }
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
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await page.reload();
      }
    }
  }

  /** Thread rows are addressed by their subject, not by an id this spec would
   * have to know in advance -- the same shape pipeline.spec.ts's columnByName
   * uses, and every subject carries the run id. */
  function threadRow(subject: string): Locator {
    return page.locator('[data-testid^="thread-row-"]').filter({ hasText: subject });
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

  // --------------------------------------------------------------------

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();

    // A previous attempt's account would sync this same mailbox alongside the
    // one added below, ingesting every message twice (once per account, into
    // the same thread) and doubling the conversation. Archiving stops its
    // sync and leaves its messages alone, which run-id scoping already
    // handles. A no-op on the first attempt, where there are no accounts.
    const response = await page.request.get("/api/mail/accounts");
    expect(response.ok()).toBe(true);
    const { own } = await response.json() as { own: { id: string; archivedAt: string | null }[] };
    for (const account of own) {
      if (account.archivedAt === null) {
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
});
