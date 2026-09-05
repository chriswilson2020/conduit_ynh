import { test, expect } from "@playwright/test";
import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { ImapFlow } from "imapflow";
import postgres from "postgres";
import { typeIntoEditor } from "./helpers.js";

/**
 * One serial journey through the Phase 4 mail flows: seed a mailbox over
 * IMAP, add the account through the settings form, watch the sync populate
 * the inbox, read the conversation, link a deal to it, reply, and find it
 * again through the filters, global search and the contact's Mail tab.
 * Phase 4.2 extends the same journey with a SECOND USER (see the 4.2 section
 * at the bottom): the private-by-default visibility model, the deal link as
 * the deliberate sharing act, the Settings toggle, and the owner-only move
 * rights, each asserted from user B's browser context. Phase 4.3 continues
 * with the detail cap's Show earlier on a 51-message fixture thread,
 * the 1280px conversation-header containment guard, forward re-attach
 * verified in Mailpit's copy of the outgoing mail, and the per-user hide
 * journey (A's filing changes A's surfaces alone; B keeps reading).
 * Phase 5 closes the file with mail on the RECORD TIMELINE: an auto-linked
 * conversation becomes an entry on its contact's timeline, carrying that
 * thread's subject rendered live and a link back to the conversation -- and
 * the same entry is absent, entirely rather than redacted, from the second
 * user's view of that same record. That leg lives here rather than in
 * e2e/meetings.spec.ts because it needs both of this file's fixtures: a real
 * ingested thread on a PRIVATE mailbox, and a second browser context that is
 * genuinely a different user.
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
 * RETRY SAFETY IS A RESET (see resetForRetry below), and this file is the
 * only spec in the suite that needs one. It is one `describe.serial` block, so
 * a failure anywhere skips the rest and Playwright re-runs the WHOLE block --
 * and the two stores this journey writes to, the Dovecot mailbox and the
 * database, live outside Playwright and outlive the worker it discards.
 * Until 2026-09-05 nothing emptied either of them, and the consequence was
 * measured rather than guessed: each attempt re-seeded a full fixture set on
 * top of the last one's leftovers and died EARLIER than the attempt before it,
 * so the retry budget was spent on failures the retries themselves created and
 * the first-trial failure was never re-run at all. Six red runs in twenty-six
 * attempts, and a retry recovery rate of 0 of 6 where every other e2e
 * intermittent in this repository's history is 36 of 36
 * (docs/superpowers/reports/2026-09-05-mail-e2e-intermittent.md).
 *
 * So `beforeAll` empties both stores whenever `testInfo.retry > 0`, and a
 * retry now means what Playwright intends by it: the same attempt again, not a
 * compounding one.
 *
 * THE RUN-ID SCOPING BELOW STAYS, and not out of sentiment. The reset asserts
 * its own postconditions and fails the attempt loudly if either store is still
 * dirty, but scoping is what makes the assertions in this file describe THIS
 * attempt's fixtures rather than a count of everything present -- which is the
 * right shape for a spec sharing a mailbox with e2e/mobile.spec.ts whatever
 * the reset does. Every fixture subject, address and body marker carries a run
 * id, every assertion matches a scoped SET rather than a bare count, and the
 * one genuinely global number in the app -- the nav's unread badge -- is
 * asserted as a DELTA against what it read before the step, never as an
 * absolute. What scoping never could fix is a second live mail account pointed
 * at the same mailbox (each account ingests the same message into the same
 * thread, so the conversation would show every message twice), which is why
 * beforeAll archives whatever accounts it finds before it resets anything.
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

/**
 * The database under test, for the ONE thing no app surface can do: put the
 * mail tables back to empty between Playwright attempts (see resetForRetry).
 *
 * Conduit is archive-not-delete all the way down -- an account archives, a
 * thread hides, and neither leaves the list. That is the right product
 * behaviour and this file asserts it in several places; it is also why the
 * harness cannot ask the app to undo an attempt. The same reasoning
 * `emptyOnServer` already follows for Dovecot, one store along: a reset is
 * the harness's business, and asking the app to clean up after itself would
 * be asking it to mark its own homework.
 *
 * Spelled exactly like playwright.config.ts's webServer DATABASE_URL, because
 * it has to be the same database the app under test is using -- a full TCP
 * connection string in CI, with a local socket fallback for a machine running
 * this against its own PostgreSQL.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres:///conduit_test";

/** One `postgres` client, named so the two wipe helpers can take it rather
 * than each opening a connection of their own. */
type DatabaseHandle = ReturnType<typeof postgres>;

/**
 * Every mail table, CHILD FIRST: this list is a delete order, not a set. The
 * FKs are plain no-action ones (schema.ts), so a parent deleted before its
 * children fails outright rather than cascading.
 *
 * `resetForRetry` checks this list against the database's own catalogue before
 * it deletes anything, so a mail table added in a later phase stops a retry
 * with a message naming itself rather than silently leaving its rows behind --
 * which is precisely the failure mode this whole reset exists to end.
 */
const MAIL_TABLES = [
  "mail_attachments",
  "mail_messages",
  "mail_thread_hides",
  "mail_threads",
  "mail_account_folders",
  "mail_folder_state",
  "mail_accounts",
] as const;

/**
 * The mailboxes this spec CREATES, by prefix, so a reset can take them away
 * again. Kept beside the names they are built from in beforeAll
 * (`Retainers-${attemptId}` and its renamed form) -- matching on the run id
 * instead would not do, because a retry runs in a fresh worker and may well
 * re-evaluate this module, giving the leftovers a run id this attempt has
 * never heard of.
 *
 * Nothing else in the mailbox is deleted as a MAILBOX: the fixture folders
 * belong to .github/scripts/start-dovecot.sh and to seedMailbox, which both
 * tolerate finding them already there.
 */
const SPEC_MADE_FOLDER_PREFIXES = ["Retainers-", "Clients-Retainers-"];

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

/**
 * Phase 4.4's filing destination, and the ONE fixture folder this spec makes
 * for itself (seedMailbox creates it over IMAP rather than start-dovecot.sh
 * declaring it, because it is this journey's alone and nothing else asserts
 * against it).
 *
 * IT HAS TO BE A FOLDER CONDUIT IS NOT SYNCING, which is the whole point:
 * filing into one turns its sync on, and a destination that was already
 * syncing could not tell that rule working from that rule missing. Junk and
 * trash are the only two roles the CRM leaves switched OFF on first sight, and
 * the fixture Junk mailbox is already spoken for by the Settings-picker test
 * earlier in this journey -- so this one is named to be classified junk by
 * mail-folders.ts's NAME heuristic (no SPECIAL-USE attribute is set on it, and
 * imapflow resolves competing \Junk claims to a single winner, which must stay
 * the fixture Junk).
 */
const SPAM_FOLDER = "Spam";

/**
 * Phase 4.4 Task 2's destination, and the second fixture folder this spec
 * makes for itself.
 *
 * A PLAIN, ORDINARY FOLDER, deliberately unlike SPAM_FOLDER above: nothing
 * classifies "Clients", so the CRM syncs it from first sight and filing into
 * it switches nothing on. That is what these two tests want -- they are about
 * the two NEW ENTRANCES to filing (from inside a conversation, and per
 * message), and the sync rule they both inherit is already proved by the test
 * above through the same server call. A shared destination would also have let
 * that test's assertions and these interfere.
 */
const CLIENTS_FOLDER = "Clients";

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
  /** Phase 4.4: the one filed into an arbitrary folder, which is also what
   * turns that folder's sync on. */
  let fileSubject = "";
  /**
   * Phase 4.4 Task 2's two conversations, each a real two-message References
   * chain because both tests turn on what happens to a thread's OTHER
   * messages: one is filed WHOLE from inside itself, and one has a single
   * message filed out of it while the rest stays put.
   *
   * Two threads rather than one reused, because these tests share a mailbox
   * and run in order: filing the first one whole empties its INBOX copies,
   * which is exactly the state the second test needs NOT to be in.
   */
  let convFileSubject = "";
  let splitSubject = "";
  /**
   * Phase 4.4 Task 4's folder, before and after its rename.
   *
   * PER ATTEMPT, unlike every other folder constant in this file, and that is
   * forced rather than tidy: these two are the only mailboxes this spec CREATES
   * through the app, and a CREATE of a name that already exists is refused. A
   * fixed name would pass once and then fail every retry and every later run
   * against the same Dovecot, because the mailbox the first attempt made is
   * still sitting there. The delete leg removes the second name; the first is
   * gone by then because the rename moved it.
   */
  let madeFolder = "";
  let renamedFolder = "";

  /**
   * The Phase 4.3 fixtures, per-attempt for the same unrecoverability
   * reasons as the folder journey's above: the detail-cap test asserts a
   * message COUNT (exactly 50 of 51), and the hide journey asserts
   * whole-list negatives ("gone from A's inbox and search") -- both shapes
   * a previous attempt's same-subject leftovers would fail forever.
   * `attemptTag` is the same `${runId}x${retry}` stamp, kept whole because
   * the fixtures' Message-IDs need it too (a retried APPEND with a reused
   * Message-ID would thread into the previous attempt's conversation).
   */
  let attemptTag = "";
  /** The 51-message thread the detail cap truncates to 50. */
  let longSubject = "";
  /** The one-message thread whose stored attachment the forward re-attaches. */
  let attachSubject = "";
  let attachmentName = "";
  /** The thread A hides, and the never-hidden thread sharing its body
   * marker -- the sentinel that keeps the post-hide search negative a
   * statement about a LOADED result list (the dropdown's "No results" also
   * renders while the query is still in flight, so absence alone proves
   * nothing). */
  let hideSubject = "";
  let sentinelSubject = "";
  let hideMarker = "";

  /**
   * Phase 4.4 Task 3's fixtures: enough conversations to push the reader PAST
   * PAGE ONE, plus the two arrivals the live list has to treat differently.
   *
   * WHY A BACKLOG AT ALL. The whole task is that the list is live beyond page
   * one -- before it, the observed query after "load more" was page TWO, so
   * page one, where new mail lands, had no observer and never refetched. A
   * journey that never pages proves the paging query alone, which is the case
   * that already worked. Thirty is simply more than the list's 25.
   *
   * THEY ARE DAYS OLD AND ALREADY \Seen, which is what keeps them out of every
   * earlier test's way on a retry: dated below every other fixture they cannot
   * disturb page-one geography (the same trick the 4.3 fixtures use for the
   * same reason, one order of magnitude further back), and flagged \Seen they
   * cannot move the unread badge those tests count.
   *
   * EACH ATTEMPT'S SET IS NEWER THAN THE LAST'S (see backlogBaseMs), so this
   * attempt's backlog always sits directly under the live fixtures rather than
   * under a previous attempt's leftovers -- which is what keeps the target
   * row's depth predictable however many attempts have run.
   */
  const BACKLOG_COUNT = 30;
  /**
   * Which backlog conversation the reply lands in, counted from the OLDEST.
   * Low on purpose: the backlog is the bottom of the list, so a low index is
   * deep, and the test asserts its actual depth rather than trusting this.
   */
  const BACKLOG_TARGET = 2;
  let backlogPrefix = "";
  let backlogBaseMs = 0;
  /** A body marker, one alphanumeric token: it is read off the list ROW, whose
   * snippet is the newest message's body -- so this appearing in place is the
   * refresh happening without the row moving. */
  let backlogReplyMarker = "";
  /** The conversation that arrives while the reader is looking at the list and
   * must NOT appear until they ask for it. */
  let liveSubject = "";
  /** The target row's testid, captured in one test and asserted in the next:
   * after the reveal it takes the position the server has had it in all along. */
  let targetRowId = "";
  /**
   * WHEN the backlog reply was dated, carried into the next test so the
   * conversation that arrives there can be dated STRICTLY LATER.
   *
   * A COIN FLIP LIVED HERE, and it is what turned CI run 33947079397 red on
   * its first trial -- a docs-only commit, on a mailbox holding nothing but
   * its own fixtures. Both arrivals were dated `new Date()` and the two tests
   * run about 0.8 s apart, but an RFC 2822 `Date:` header carries WHOLE
   * SECONDS; mail-ingest takes `last_message_at` from that header verbatim,
   * and the list orders `desc(last_message_at), desc(id)` over an `id` that is
   * a RANDOM UUID (services/mail-threads.ts, db/schema.ts). Two arrivals
   * inside one clock second therefore TIE on the sort key, and the order of
   * the two rows the reveal test names by index is then decided by a toss.
   * About one run in five put both appends in the same second; the run above
   * is one that lost.
   *
   * Dating the second arrival one clear second after the first makes that
   * order a fact about the data instead. Derived from this value rather than
   * waited out, so there is no window in which the two can tie however CI's
   * clock behaves and no second spent not tying.
   */
  let backlogReplyAt = new Date(0);
  const backlogSubject = (index: number) => `${backlogPrefix} ${String(index).padStart(2, "0")}`;
  const backlogId = (index: number) => `<backlog-${attemptTag}-${index}@example.com>`;

  /**
   * The Phase 5 timeline fixture: one inbound message from a contact who
   * exists in the CRM before the first sync pass, so the auto-linker binds
   * the thread to her -- and to her ALONE. No deal, no project: under the
   * record-visibility rule those two links are the deliberate sharing act,
   * and a contact link is not, so this conversation stays A's while A's
   * mailbox is private. That is what makes it the honest subject of the
   * privacy leg at the bottom of this file.
   *
   * PER ATTEMPT, address included, and that is not decoration. Auto-linking
   * is an exact address match resolved once, at ingest: a previous attempt's
   * contact holding the same address could take this attempt's thread, and
   * this attempt's contact -- whose timeline both the positive and the
   * negative are asserted against -- would then be a record nothing ever
   * happened on. Failing forever, on every retry, for a reason no retry
   * could clear.
   */
  let timelineContactName = "";
  let timelineAddress = "";
  let timelineSubject = "";
  let timelineContactId = "";
  let timelineThreadId = "";
  let timelineReplyBody = "";

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
      ...phase43Fixtures(now),
      ...phase5Fixtures(now),
    ];
  }

  /**
   * The Phase 5 fixture: one message from a contact the CRM already knows,
   * which the ingest auto-links and -- Phase 5 being what it is -- turns into
   * a timeline entry on her record.
   *
   * Dated with the 4.3 set rather than with the minutes-old opening ones, for
   * the same two reasons: inside the account form's default 90-day backfill
   * window, and nowhere near the bulk trio's seconds-wide range window.
   */
  function phase5Fixtures(now: number): { raw: Buffer; date: Date; folder: string }[] {
    const at = new Date(now - 75 * MINUTE_MS);
    return [{
      folder: INBOX_FOLDER,
      date: at,
      raw: rfc822([
        `From: Cora Vendor <${timelineAddress}>`,
        `To: Conduit <${USERNAME}>`,
        `Subject: ${timelineSubject}`,
        `Message-ID: <timeline-1-${attemptTag}@example.com>`,
        `Date: ${at.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ], "Here is the quote you asked for."),
    }];
  }

  /**
   * The Phase 4.3 fixtures: a 51-message thread for the detail cap (the cap
   * is 50, so exactly one message -- the root -- falls off the capped page),
   * one message carrying a real MIME attachment for the forward re-attach
   * journey, and the hide journey's thread plus its search sentinel (see the
   * declarations above for why the sentinel exists).
   *
   * All dates sit HOURS old: inside the account form's default 90-day
   * backfill window, older than every Phase 4/4.1 fixture (so the earlier
   * journeys' rows keep their list positions), and far outside the bulk
   * trio's seconds-wide window (so the shift-range there still cannot sweep
   * anything else up).
   */
  function phase43Fixtures(now: number): { raw: Buffer; date: Date; folder: string }[] {
    // The long thread is a real References chain onto one root, like Alice's:
    // that is what mail-ingest's threading consults. Each body names its own
    // ordinal, so the ROW's snippet reading "Message 51" is the signal the
    // whole thread has been ingested (the sync test waits on it).
    const longStart = now - 240 * MINUTE_MS;
    const longRootId = `<long-0-${attemptTag}@example.com>`;
    const longThread = Array.from({ length: 51 }, (_, index) => {
      const date = new Date(longStart + index * MINUTE_MS);
      return {
        folder: INBOX_FOLDER,
        date,
        raw: rfc822([
          `From: Frank Longwind <frank-${runId}@example.com>`,
          `To: Conduit <${USERNAME}>`,
          `Subject: ${index === 0 ? longSubject : `Re: ${longSubject}`}`,
          `Message-ID: <long-${index}-${attemptTag}@example.com>`,
          ...(index === 0 ? [] : [`In-Reply-To: ${longRootId}`, `References: ${longRootId}`]),
          `Date: ${date.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
        ], `Message ${index + 1} of the long thread.`),
      };
    });

    // One text part plus one base64 attachment part -- the smallest honest
    // multipart/mixed. The attachment lands as a mail_attachments row with
    // stored bytes, which is exactly what the forward re-attaches.
    const attachAt = new Date(now - 90 * MINUTE_MS);
    const boundary = `b-${attemptTag}`;
    const attachmentBase64 = Buffer.from(`Forwarded fixture payload ${attemptTag}.`, "utf8").toString("base64");
    const attachMessage = {
      folder: INBOX_FOLDER,
      date: attachAt,
      raw: rfc822([
        `From: Grace Sender <grace-${runId}@example.com>`,
        `To: Conduit <${USERNAME}>`,
        `Subject: ${attachSubject}`,
        `Message-ID: <attach-1-${attemptTag}@example.com>`,
        `Date: ${attachAt.toUTCString()}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ], [
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The spec is attached.",
        `--${boundary}`,
        `Content-Type: text/plain; name="${attachmentName}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${attachmentName}"`,
        "",
        attachmentBase64,
        `--${boundary}--`,
      ].join("\r\n")),
    };

    // The hide pair. BOTH bodies carry hideMarker: after A hides the
    // Handover thread, a search for the marker must still find the Briefing
    // one -- which is what makes "Handover is absent from the results" an
    // absence from a loaded list rather than from a query still in flight.
    const hidePair = [
      { subject: hideSubject, from: `Dana Handover <dana-${runId}@example.com>`, id: "hide", at: new Date(now - 60 * MINUTE_MS) },
      { subject: sentinelSubject, from: `Erik Briefing <erik-${runId}@example.com>`, id: "sentinel", at: new Date(now - 55 * MINUTE_MS) },
    ].map(({ subject, from, id, at }) => ({
      folder: INBOX_FOLDER,
      date: at,
      raw: rfc822([
        `From: ${from}`,
        `To: Conduit <${USERNAME}>`,
        `Subject: ${subject}`,
        `Message-ID: <${id}-1-${attemptTag}@example.com>`,
        `Date: ${at.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ], `Please read this. Marker ${hideMarker}.`),
    }));

    return [...longThread, attachMessage, ...hidePair];
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
      // OLDER THAN THE ARCHIVE PAIR, deliberately: the shift-range above takes
      // every row BETWEEN the two it is given, so a fourth INBOX fixture must
      // not be able to sort between them. now - 4s is outside the three-second
      // window the comment above reserves for exactly that.
      message(fileSubject, INBOX_FOLDER, new Date(now - 4_000)),
      message(archiveSubjects[0], INBOX_FOLDER, new Date(now - 3_000)),
      message(archiveSubjects[1], INBOX_FOLDER, new Date(now - 2_000)),
      message(trashSubject, INBOX_FOLDER, new Date(now - 1_000)),
      ...task2Fixtures(now),
    ];
  }

  /**
   * Phase 4.4 Task 2: two INBOX conversations of TWO messages each, threaded
   * on a real References chain (what mail-ingest actually consults -- a shared
   * subject is not a thread).
   *
   * Two messages is the minimum that can prove either half. Filing a whole
   * conversation from inside it has to move BOTH; filing one message out of it
   * has to move exactly one and leave the other where it was, which a
   * one-message thread cannot distinguish from moving the thread.
   *
   * MINUTES OLD, not seconds, and outside the three-second window the archive
   * pair reserves for its shift-range (see folderFixtures): these four must not
   * be able to sort between those two.
   */
  function task2Fixtures(now: number): { raw: Buffer; date: Date; folder: string }[] {
    const pair = (subject: string, at: number) => {
      const slug = subject.replace(/[^a-z0-9]+/gi, "-");
      const rootId = `<${slug}-1@example.com>`;
      const message = (extra: string[], id: string, date: Date, body: string) => rfc822([
        `From: Dana Renewals <dana-${runId}@example.com>`,
        `To: Conduit <${USERNAME}>`,
        ...extra,
        `Message-ID: ${id}`,
        `Date: ${date.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ], body);
      const firstAt = new Date(now - at);
      const secondAt = new Date(now - at + 30_000);
      return [
        {
          folder: INBOX_FOLDER, date: firstAt,
          raw: message([`Subject: ${subject}`], rootId, firstAt, `Opening ${subject}.`),
        },
        {
          folder: INBOX_FOLDER, date: secondAt,
          // "Re:" is stripped by normalizeSubject, so the THREAD is titled
          // `subject` -- which is what threadRow matches on. The reply keeps
          // the prefix on the SERVER, which is how subjectsIn tells the two
          // messages apart after one of them has moved.
          //
          // ITS BODY DIFFERS FROM THE ROOT'S, which is not decoration: the
          // list row's snippet is the NEWEST message's body, so two messages
          // sharing one body would leave nothing on screen to say whether the
          // reply had been ingested yet -- the very thing the sync test waits
          // on before the badge-delta test runs.
          raw: message(
            [`Subject: Re: ${subject}`, `In-Reply-To: ${rootId}`, `References: ${rootId}`],
            `<${slug}-2@example.com>`, secondAt, `Replying about ${subject}.`,
          ),
        },
      ];
    };
    return [...pair(convFileSubject, 9 * MINUTE_MS), ...pair(splitSubject, 7 * MINUTE_MS)];
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
      // Phase 4.4's filing destination, made before the account exists so the
      // very first pass discovers it -- unsynced, because its name classifies
      // junk (see SPAM_FOLDER). A retry finds it already there, which is not
      // an error: the folder is per-run, while the mail_account_folders rows
      // that decide its sync state belong to the account this attempt creates.
      await client.mailboxCreate(SPAM_FOLDER).catch(() => undefined);
      // Task 2's destination, for the same reason and with the same
      // already-there-is-not-an-error tolerance.
      await client.mailboxCreate(CLIENTS_FOLDER).catch(() => undefined);
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

  /**
   * Move every message out of `folder` and into `target`, over raw IMAP.
   *
   * The harness's way to reach an empty mailbox, not the app's -- see the
   * delete case for why it must not be the app's there.
   */
  async function emptyOnServer(folder: string, target: string): Promise<void> {
    await withImap(async (client) => {
      const mailbox = await client.mailboxOpen(folder);
      if (mailbox.exists > 0) await client.messageMove("1:*", target);
      await client.mailboxClose();
    });
  }

  /** Every mailbox the server LISTs. The only way to ask "is this folder gone"
   * of the server rather than of the CRM, which is exactly the question the
   * delete leg has to answer -- Conduit deliberately keeps its own row. */
  async function listFolders(): Promise<string[]> {
    return await withImap(async (client) => (await client.list()).map((entry) => entry.path));
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

  // -- the retry reset --------------------------------------------------

  /**
   * Empty the Dovecot mailbox: every message out of every selectable folder,
   * and the folders this spec made for itself removed with them.
   *
   * EXPUNGED, not moved. `emptyOnServer` above moves, because the tests that
   * use it are asserting where mail ENDED UP and a harness that deleted the
   * evidence would be no harness at all. Here the point is the opposite:
   * nothing from a previous attempt may survive anywhere the CRM can see it,
   * and Trash and Archive are two of the places it looks.
   *
   * `\Noselect` mailboxes are skipped because they cannot be opened at all --
   * they are path components (a parent of `a/b` that holds no mail), not
   * mailboxes.
   */
  async function emptyMailboxForRetry(): Promise<void> {
    await withImap(async (client) => {
      const mailboxes = await client.list();
      for (const mailbox of mailboxes) {
        if (mailbox.flags.has("\\Noselect")) continue;
        const opened = await client.mailboxOpen(mailbox.path);
        if (opened.exists > 0) await client.messageDelete("1:*");
        await client.mailboxClose();
      }
      // After the emptying, not before: Dovecot refuses to delete a mailbox
      // that is open, and an empty one is also the only kind whose deletion
      // can be read as "the reset worked" rather than as data loss.
      for (const mailbox of mailboxes) {
        if (!SPEC_MADE_FOLDER_PREFIXES.some((prefix) => mailbox.path.startsWith(prefix))) continue;
        await client.mailboxDelete(mailbox.path);
      }
    });
  }

  /** What the server still holds, per mailbox, so the postcondition below can
   * say WHICH folder is dirty rather than merely that one is. */
  async function remainingOnServer(): Promise<Record<string, number>> {
    return await withImap(async (client) => {
      const left: Record<string, number> = {};
      for (const mailbox of await client.list()) {
        if (mailbox.flags.has("\\Noselect")) continue;
        const opened = await client.mailboxOpen(mailbox.path, { readOnly: true });
        if (opened.exists > 0) left[mailbox.path] = opened.exists;
        await client.mailboxClose();
      }
      return left;
    });
  }

  /**
   * Empty the mail tables, in one transaction.
   *
   * `events` FIRST and by predicate, not by truncation: Phase 5 puts a
   * `mail_thread_id` pointer on the timeline, so those rows reference threads
   * this deletes -- but the same table carries every other record's timeline
   * too, and the specs that ran before this one in the same database own
   * those. `WHERE mail_thread_id IS NOT NULL` takes exactly the mail entries.
   * (This is also why the tables below are DELETEd rather than TRUNCATEd:
   * TRUNCATE refuses a table an FK references unless the referencing table
   * goes with it, which for `events` would mean everybody's timeline.)
   */
  async function wipeMailTables(sql: DatabaseHandle): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM events WHERE mail_thread_id IS NOT NULL`;
      for (const table of MAIL_TABLES) await tx`DELETE FROM ${tx(table)}`;
    });
  }

  /**
   * MAIL_TABLES against the database's own catalogue, once per reset.
   *
   * A mail table this file has never heard of is a table the wipe leaves full,
   * which is the exact defect the reset exists to close -- so it stops the
   * attempt here, naming itself, rather than surfacing fifteen tests later as
   * a list with somebody else's conversations in it.
   */
  async function assertMailTablesKnown(sql: DatabaseHandle): Promise<void> {
    // starts_with rather than LIKE 'mail\_%': the underscore would have to be
    // escaped to mean itself, and a backslash inside a tagged template is
    // eaten by JavaScript before postgres ever sees it.
    const present = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND starts_with(table_name, 'mail_')
    `;
    const unknown = present
      .map((row) => row.table_name)
      .filter((name) => !(MAIL_TABLES as readonly string[]).includes(name));
    expect(
      unknown,
      "MAIL_TABLES in e2e/mail.spec.ts no longer covers every mail_* table; "
      + "add these to it, child-first, or a retry will start dirty",
    ).toEqual([]);
  }

  /**
   * Put both stores back to what a first attempt sees.
   *
   * WHY THIS EXISTS AT ALL is the file header's subject and is not repeated
   * here. What belongs here is the ORDER, because each step depends on the one
   * before it:
   *
   *   1. The live accounts are archived by the caller, BEFORE this runs. That
   *      is what stops the previous attempt's sync loop: mail-sync.ts's
   *      `loadAccount` re-reads the row every pass and treats an archived (or
   *      absent) one as teardown. Wiping the rows under a running loop would
   *      work too -- NotFoundError is a teardown error as well -- but only
   *      after that loop had finished whatever pass it was in the middle of,
   *      and a pass finishing after the wipe would ingest straight back into
   *      the tables just emptied.
   *   2. Dovecot is emptied next, so a straggling pass has nothing left to
   *      find even if it does come round again.
   *   3. The tables go last.
   *
   * AND THEN IT CHECKS, which is the half that keeps this honest. This code
   * runs only on a retry, so on a green run it is never exercised at all --
   * a reset that had quietly stopped working would show up as the retry
   * cascade coming back, months later, looking exactly like a new
   * intermittent. The postconditions are asked of the SERVER and of the API
   * rather than of the statements just executed, and they are what fails when
   * one of them is not true.
   *
   * The loop is for the race in (1): archiving is noticed at a pass boundary,
   * so a pass already in flight can still insert after the wipe. One more
   * round of the same wipe is what clears that, and the attempt count is a
   * deadline rather than a hope.
   */
  async function resetForRetry(): Promise<void> {
    // Mirrors packages/api/src/test/global-setup.ts: a bare "postgres:///db"
    // URL with no ambient PGHOST connects over TCP to localhost, which needs a
    // password this role does not have. In CI the URL is a full TCP one and
    // this never comes into play.
    process.env.PGHOST ??= "/run/postgresql";
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    let left: Record<string, number> = {};
    let threads = -1;
    try {
      await assertMailTablesKnown(sql);
      for (let round = 0; round < 5; round += 1) {
        const last = round === 4;
        await emptyMailboxForRetry();
        try {
          await wipeMailTables(sql);
        } catch (error) {
          // The straggling pass again, and this is the shape it takes when it
          // wins the race outright: an INSERT of a message referencing the
          // account this transaction is deleting makes the parent DELETE fail
          // on the foreign key rather than merely leave a row behind. By the
          // next round that pass has reached its own loadAccount and stopped
          // itself, so the same wipe goes through. Re-thrown as ITSELF on the
          // last round -- a genuinely broken statement has to read as the
          // statement it is, not as "the reset did not take".
          if (last) throw error;
          await page.waitForTimeout(1_000);
          continue;
        }

        left = await remainingOnServer();
        const listed = await page.request.get("/api/mail/threads");
        expect(listed.ok()).toBe(true);
        threads = ((await listed.json()) as { items: unknown[] }).items.length;
        if (Object.keys(left).length === 0 && threads === 0) return;
        // A pass that was in flight when the archive landed and got its rows
        // in before the wipe. Give it a beat to unwind, and take what it wrote
        // with the next round.
        if (!last) await page.waitForTimeout(1_000);
      }
    } finally {
      await sql.end();
    }
    throw new Error(
      "the retry reset did not take: the mail tables and the Dovecot mailbox have to be empty "
      + "before this attempt seeds, or it will fail somewhere it has no business failing "
      + `(threads still listed: ${threads}; messages still on the server: ${JSON.stringify(left)})`,
    );
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

  /**
   * Every visible thread row's testid, in the order they are painted.
   *
   * The Task 3 tests compare this array before and after new mail lands, which
   * is the only assertion shape that says "nothing moved" rather than "the
   * thing I thought about did not move": an inserted row, a removed one and a
   * re-ordered one all change it, and a row REFRESHED in place does not.
   */
  async function rowIds(): Promise<string[]> {
    return page.locator('[data-testid^="thread-row-"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
  }

  async function idOf(locator: Locator, prefix: string): Promise<string> {
    const testId = await locator.getAttribute("data-testid");
    return (testId as string).replace(prefix, "");
  }

  /**
   * Click "Load more" until every page of the thread list is on screen.
   *
   * A row assertion made after this helper is about the WHOLE list rather
   * than about page one, which is the only honest shape for the hide
   * journey's absence claims and for the Task 3 backlog's thirty rows.
   *
   * IT USED TO BE ABOUT RETRIES TOO -- the Phase 4.3 fixtures are dated hours
   * old so they cannot disturb the earlier journeys' page-one geography, and
   * previous attempts' leftovers piled newest-first above them used to push
   * them past the first page of 25. resetForRetry has ended that; what is
   * left is the ordinary reason, that this file's own fixture set has grown
   * twice and page one is 25 rows. Bounded rather than clever: if the list
   * never finishes materializing it is the caller's own row assertion that
   * should fail, with the better message.
   */
  async function loadAllThreadsOn(target: Page): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      const more = target.getByTestId("thread-list-more");
      if ((await more.count()) === 0) return;
      try {
        // A short timeout: the button is disabled while its page is in
        // flight, and waiting out actionability here IS the pacing.
        await more.click({ timeout: 1_000 });
      } catch {
        // Disabled, or unmounted between the count and the click (the last
        // page landed) -- either way, look again after a beat.
        await target.waitForTimeout(250);
      }
    }
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
    fileSubject = `Contract ${attemptId}`;
    // No subject here is a substring of another, NOR OF ANY PER-RUN ONE, which
    // is the half that is easy to miss: threadRow matches by hasText, and
    // `attemptId` is `runId` plus a suffix, so a `Word ${attemptId}` fixture
    // silently CONTAINS the `Word ${runId}` one declared at the top of this
    // file. The first draft of this line was `Renewal ${attemptId}` against
    // aliceSubject's `Renewal ${runId}`, which made Alice's thread match two
    // rows and failed the sync test three retries deep.
    convFileSubject = `Statement ${attemptId}`;
    splitSubject = `Proposal ${attemptId}`;
    // No space in either: these two are folder NAMES rather than subjects, and
    // a name is what the picker's data-testid is built from.
    madeFolder = `Retainers-${attemptId}`;
    renamedFolder = `Clients-Retainers-${attemptId}`;

    // The Phase 4.3 set (see the declarations above). No subject here is a
    // substring of another, because threadRow matches by hasText.
    attemptTag = attemptId;
    longSubject = `Longthread ${attemptId}`;
    attachSubject = `Spec attached ${attemptId}`;
    attachmentName = `spec-${attemptId}.txt`;
    hideSubject = `Handover ${attemptId}`;
    sentinelSubject = `Briefing ${attemptId}`;
    // One alphanumeric token, same reason as textMarker above: it travels
    // through websearch_to_tsquery as a single lexeme.
    hideMarker = `hidemarker${attemptId}`;

    // The Phase 4.4 Task 3 set (see the declarations above). Two-digit indices
    // so that no backlog subject is a substring of another -- `Backlog X 1`
    // would match the row for `Backlog X 10` under threadRow's hasText, which
    // is the bug the per-attempt naming rules above were written after.
    backlogPrefix = `Backlog ${attemptId}`;
    backlogReplyMarker = `backlogreply${attemptId}`;
    liveSubject = `Latebreaking ${attemptId}`;
    // Five days back, on every attempt alike: older than every other fixture
    // in this file, which are minutes or hours old, and still well inside the
    // account form's default 90-day backfill.
    //
    // IT USED TO BE `5 - testInfo.retry`, so that each attempt's backlog was
    // newer than the last one's and the target row's depth stayed predictable
    // however many attempts had run. That was a workaround for leftovers, and
    // resetForRetry has taken the leftovers away: a retry now sees the same
    // mailbox a first attempt sees, so it should compute the same fixture
    // dates from it. An attempt that is not identical to the first one is
    // exactly what this file spent six red runs learning to distrust.
    backlogBaseMs = Date.now() - 5 * 24 * 60 * MINUTE_MS;

    // The Phase 5 set (see the declarations above for why the ADDRESS is
    // per-attempt and not merely per-run).
    timelineContactName = `Cora ${attemptId}`;
    timelineAddress = `cora-${attemptId}@example.com`;
    timelineSubject = `Pilot quote ${attemptId}`;
    timelineReplyBody = `Thanks Cora ${attemptId}`;

    // A live account not this attempt's own would sync this same mailbox
    // alongside the one added below, ingesting every message twice (once per
    // account, into the same thread) and doubling the conversation. There are
    // two ways one can be here: a previous attempt of this block left it, or
    // some other spec did (e2e/mobile.spec.ts adds one to this same mailbox,
    // and refuses to run at more than one worker for exactly this reason).
    //
    // UNCONDITIONAL, unlike the reset below, because the second case has
    // nothing to do with retries. On a retry it is also step one of the reset:
    // archiving is what stops the previous attempt's sync loop before
    // resetForRetry empties the tables under it (see that function's ORDER).
    const response = await page.request.get("/api/mail/accounts");
    expect(response.ok()).toBe(true);
    const { own } = await response.json() as {
      own: { id: string; archivedAt: string | null }[];
    };
    for (const account of own) {
      if (account.archivedAt !== null) continue;
      // Checked, not fired and forgotten: a 4xx here has to fail with "the
      // archive was refused" rather than surface two steps later as a
      // conversation with twice the messages it should have.
      const archived = await page.request.post(`/api/mail/accounts/${account.id}/archive`);
      expect(archived.ok()).toBe(true);
    }

    // THE RESET, and the file header says why it is the whole answer to a
    // retry. Only on a retry: on a first attempt both stores are already what
    // this makes them, and emptying a mailbox is the one destructive thing
    // this file does -- it should happen when there is a reason for it and
    // not as a matter of course.
    if (testInfo.retry > 0) {
      // A hook gets the test timeout, and seedMailbox's ~65 APPENDs already
      // spend a good part of it. The reset walks every mailbox on the server
      // twice and empties seven tables, so a retry is asked to do noticeably
      // more work in the same budget than a first attempt -- and a reset that
      // ran out of time would present as a hook timeout with nothing said
      // about the mailbox, which is the least useful failure this file could
      // produce.
      testInfo.setTimeout(testInfo.timeout + 60_000);
      await resetForRetry();
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

  // Phase 5. Created HERE, beside Alice, rather than down in the Phase 5
  // section where it is used: auto-linking happens once, at ingest, so a
  // contact created after the account below has synced would never be found
  // by the message already in the mailbox -- and a thread linked to her by
  // hand afterwards would still emit no timeline entry, because an entry's
  // record links are a snapshot taken when the message arrived.
  test("creates the contact whose private thread the timeline leg needs", async () => {
    await page.goto("/contacts");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("First name").fill(timelineContactName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    timelineContactId = page.url().split("/").pop() as string;

    const emails = page.getByTestId("field-emails");
    await emails.click();
    await emails.locator("input").fill(timelineAddress);
    await emails.locator("input").press("Enter");
    await expect(emails).toContainText(timelineAddress);
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
      // The Phase 4.3 fixtures too, INCLUDING the long thread's final
      // message (its row's snippet is the newest body, so "Message 51" means
      // the whole chain is in). Waited for here, not in the 4.3 tests
      // themselves, because the unread-badge test below reads the badge as a
      // delta of its own making -- a fixture still trickling in AFTER this
      // test would move the badge between that test's before-read and its
      // assertion, a race no per-test poll further down could close.
      //
      // The load-all is what makes the four assertions below about the whole
      // list; it is a no-op today, because this attempt's own fixtures are
      // thirteen threads and page one is 25. Alice's and Bob's rows above are
      // deliberately NOT behind it: those two are minutes old, they are the
      // newest things in the mailbox at this point in the journey, and a load
      // -all that had to run before them would be saying that this attempt
      // could be looking at somebody else's mail. Since resetForRetry it
      // cannot be.
      await loadAllThreadsOn(page);
      await expect(threadRow(longSubject)).toContainText("Message 51", { timeout: ATTEMPT_TIMEOUT_MS });
      await expect(threadRow(attachSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await expect(threadRow(hideSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await expect(threadRow(sentinelSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      // The Phase 5 fixture, waited for HERE for the badge reason spelled
      // out above and not merely for tidiness: it arrives unread like every
      // other fixture, so one still trickling in after this test would move
      // the badge between the next test's before-read and its delta.
      await expect(threadRow(timelineSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      // Phase 4.4 Task 2's two conversations, waited for here for the badge
      // reason above -- they arrive unread like every other fixture. Both are
      // two-message chains, and the SECOND message is what these assert on
      // (the row's snippet is the newest body): a thread whose reply had not
      // landed yet would file or split only half of itself later, and the
      // tests that do would fail describing the wrong thing.
      for (const subject of [convFileSubject, splitSubject]) {
        await expect(threadRow(subject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
        await expect(threadRow(subject))
          .toContainText(`Replying about ${subject}`, { timeout: ATTEMPT_TIMEOUT_MS });
      }
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
    // editor sees happen to it -- through typeIntoEditor (e2e/helpers.ts),
    // which is what makes "the editor did not take this" fail here rather
    // than as an empty body several tests down.
    await expect(composer).toContainText(aliceAddress);
    await expect(page.getByTestId("composer-subject")).toHaveValue(`Re: ${aliceSubject}`);
    // v1.2.0: BOTH of those being seeded is what sends the caret to the body,
    // and this is the only fixture in the suite that produces that seed --
    // e2e/composer-focus.spec.ts covers every other case but cannot reach a
    // reply without a synced thread. Before it, this dialog opened on the
    // Close button (390) or the From combobox (1280). toBeFocused rather than
    // a read of activeElement because the body is a TipTap editor that is
    // built asynchronously: the caret is parked on the dialog first, for
    // 38-65ms measured over five opens IN A FOREGROUND TAB. That bound is a
    // foreground bound only -- TipTap defers the DOM focus into a
    // requestAnimationFrame, which a hidden tab does not run -- so what this
    // relies on is toBeFocused's polling, not the figure.
    await expect(page.getByTestId("composer-body")).toBeFocused();
    await typeIntoEditor(page.getByTestId("composer-body"), replyBody);
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

  /**
   * THE CARET AND THE SIGNATURE, WHICH FOUGHT AND WHOSE FIGHT NOTHING COULD SEE
   * UNTIL v1.2.0 PUT A CARET IN THIS EDITOR.
   *
   * The composer appends the account's signature at the end of the body once
   * the editor announces itself, and rich-text.tsx's appendAtEnd says in its
   * own comment that it must not yank the caret. It did not yank FOCUS, which
   * is what that comment was about -- but TipTap's insertContentAt updates the
   * SELECTION by default, so the caret ended up after the appended block.
   * Nothing noticed while the composer opened on Close or on the From combobox,
   * because there was no caret in the document to move.
   *
   * MEASURED against the fix reverted: a reply opened and typed straight into
   * put "TOPLINE" inside the signature -- "-- Vriendelijke groet, sNNNNNN" came
   * back as "-- Vriendelijke groet, sNNNNNNTOPLINE". Two lines in rich-text.tsx
   * settle it: `updateSelection: false` on the append, and `"start"` on the
   * focus.
   *
   * THIS TEST HOLDS ONE OF THOSE TWO, AND THE SENTENCE HERE USED TO CLAIM BOTH.
   * On the WARM path -- which is what this test is, the accounts being cached
   * by the time Reply is clicked -- the append and the caret placement run on
   * the same editor epoch, append first, and `focus("start")` then states the
   * caret's position outright. Whatever the append did to the SELECTION is
   * overwritten a line later, so no assertion this test can make separates
   * `updateSelection: false` from its absence. Measured on CI run 33352477158
   * with that option deleted: this test passed all three attempts, while the
   * cold reply below failed all three ("TOPLINE -- Koud ...MORE"),
   * e2e/composer-focus.spec.ts's account-switch journey failed all three, and
   * composer-focus.test.ts's source guard over that exact string failed in the
   * unit job. Those three are what hold it.
   *
   * WHAT IT DOES HOLD, and nothing else in the suite does: the reply's opening
   * focus landing in the BODY (composer-focus.spec.ts covers every seed that
   * needs no mail server and cannot reach a reply), the signature arriving on
   * the warm path at all, and `focus("start")` against `focus("end")` -- with
   * the signature already in the document, "end" puts the caret after it.
   * Measured on CI run 33352506359: this was the run's only red test, three
   * attempts out of three, "typed text landed inside the signature: --
   * Groeten ...TOPLINE" -- 141 others passed and the rest of this serial group
   * was skipped behind it. The cold test below cannot hold that one: it
   * focuses an EMPTY document, where "start" and "end" are the same position.
   *
   * NO CLICK, DELIBERATELY, and it is the only place in this suite that types
   * into the body without one. typeIntoEditor clicks first and so places the
   * caret itself, which is right for every other journey and blind to exactly
   * this: the question here is where the caret was ALREADY, on open.
   *
   * The signature is set and cleared inside this test so the group's shared
   * account leaves it as it found it.
   */
  test("a reply opens with the caret above the signature, not inside it", async () => {
    const accounts = await page.request.get("/api/mail/accounts");
    expect(accounts.status()).toBe(200);
    const own = ((await accounts.json()) as { own: { id: string; label: string }[] }).own
      .find((account) => account.label === accountLabel);
    expect(own, `no account labelled ${accountLabel}`).toBeDefined();
    const accountId = own?.id ?? "";
    const marker = `Groeten ${attemptTag}`;
    const patched = await page.request.patch(`/api/mail/accounts/${accountId}`, {
      data: { signatureHtml: `<p>-- ${marker}</p>` },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    try {
      await page.goto(`/mail?thread=${aliceThreadId}`);
      await expect(page.getByTestId("conversation")).toBeVisible();
      await page.getByTestId("reply-button").click();
      const body = page.getByTestId("composer-body");
      await expect(body).toBeFocused();
      // The signature has to be IN the document before the caret's position
      // relative to it means anything.
      await expect(body).toContainText(marker);

      await page.keyboard.type("TOPLINE");
      const text = (await body.innerText()).replace(/\s+/g, " ").trim();
      expect(text).toContain("TOPLINE");
      expect(text.indexOf("TOPLINE"), `typed text landed inside the signature: ${text}`)
        .toBeLessThan(text.indexOf(marker));
      // And it is not merely before it -- it is its own line, at the top.
      expect(text.startsWith("TOPLINE"), `body reads: ${text}`).toBe(true);

      // Scoped to the composer: the page behind it has buttons of its own, and
      // Radix's modal aria-hidden is not something a locator should have to
      // rely on to stay unambiguous.
      await page.getByTestId("composer").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("composer")).toBeHidden();
    } finally {
      await page.request.patch(`/api/mail/accounts/${accountId}`, { data: { signatureHtml: null } });
    }
  });

  /**
   * THE SAME REPLY WITH THE ACCOUNTS QUERY STILL IN FLIGHT, WHICH REVERSES THE
   * ORDER THE TEST ABOVE MEASURES and is the case rich-text.tsx's
   * `updateSelection: false` actually exists for on this path.
   *
   * Above, the accounts are cached by the time Reply is clicked, so the
   * signature is appended on the epoch that also places the caret -- the
   * append happens FIRST and the caret lands after it. Here the list has not
   * arrived: `selectedAccountId` is null on that epoch (the reply's seed
   * carries an accountId only when conversation.tsx could already read one
   * from this very query), so the signature effect claims nothing, the caret
   * is placed into an empty document, and the append runs on the LATER pass
   * that follows the accounts landing -- underneath a caret the user may
   * already be typing at.
   *
   * NOTHING IS SEEDED OR STUBBED TO GET THERE. The only intervention is a
   * delay on the accounts response, and it is what makes the race a schedule
   * instead of a coin toss; a user on a cold page reaches the same state by
   * clicking Reply promptly. The delay is scoped to the LIST url so the
   * signature PATCH and the account lookup around this test are untouched.
   *
   * IT HAS TO TYPE AFTER THE APPEND, AND THE FIRST VERSION OF THIS TEST DID
   * NOT -- IT WAS VACUOUS AND CI PROVED IT. That version typed once, before
   * the signature existed, and asserted the typed word came out above the
   * marker. It does: the append lands at the END of the document whatever it
   * does to the SELECTION, so the assertion held with updateSelection:false
   * deleted (measured, on a throwaway branch: this test and the warm one above
   * both passed while composer-focus.spec.ts's account-switch journey failed
   * three times out of three). Where the caret ended up is only observable by
   * typing AGAIN afterwards, so the assertion is on the two typed fragments
   * being contiguous.
   *
   * MEASURED, with the accounts held and the option deleted: "TOPLINE
   * -- <marker>MORE" -- the continuation went into the signature. With it:
   * "TOPLINEMORE -- <marker>".
   */
  test("a reply opened before the accounts land still keeps the caret above the signature", async () => {
    const accounts = await page.request.get("/api/mail/accounts");
    expect(accounts.status()).toBe(200);
    const own = ((await accounts.json()) as { own: { id: string; label: string }[] }).own
      .find((account) => account.label === accountLabel);
    expect(own, `no account labelled ${accountLabel}`).toBeDefined();
    const accountId = own?.id ?? "";
    const marker = `Koud ${attemptTag}`;
    const patched = await page.request.patch(`/api/mail/accounts/${accountId}`, {
      data: { signatureHtml: `<p>-- ${marker}</p>` },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    // Long enough that the editor is built and its caret placed well before
    // the list arrives, short enough to leave the rest of the test its budget.
    const ACCOUNTS_DELAY_MS = 3_000;
    // ONLY THE FIRST REQUEST IS HELD, and the rest of this handler is teardown
    // safety rather than ceremony. A handler that sleeps and then continues is
    // a landmine for the tests after it: the poll, the SSE invalidation and a
    // refocus all re-fetch this list, so a request can still be parked in the
    // sleep when the test ends -- and `route.continue()` on a route whose page
    // has moved on throws "Route is already handled!" asynchronously, which
    // lands on WHICHEVER test is running by then. It did: the first version of
    // this test failed "keeps the private mailbox out of the second user's
    // inbox entirely" and "carries the deal-linked thread to the second user"
    // on two different CI runs, and was reported as a flake in a test it has
    // nothing to do with.
    let held = false;
    const holdAccounts = async (route: Route) => {
      if (held) {
        await route.continue().catch(() => undefined);
        return;
      }
      held = true;
      await new Promise((resolve) => setTimeout(resolve, ACCOUNTS_DELAY_MS));
      await route.continue().catch(() => undefined);
    };
    await page.route("**/api/mail/accounts", holdAccounts);

    try {
      await page.goto(`/mail?thread=${aliceThreadId}`);
      await expect(page.getByTestId("conversation")).toBeVisible();
      await page.getByTestId("reply-button").click();
      const body = page.getByTestId("composer-body");
      await expect(body).toBeFocused();
      // THE INSTRUMENT, AND POSITIVE ON PURPOSE: the composer's From slot
      // shows this text only while `accountsLoading` is true, so it proves the
      // query really was in flight. Asserting the absence of the From combobox
      // instead would also pass for a control that never existed at all.
      await expect(
        page.getByTestId("composer").getByText("Loading accounts..."),
        "the accounts arrived before the composer opened, so this is not the case this test exists for",
      ).toBeVisible();

      // Typed BEFORE the signature exists, which is the whole point: this is
      // the user who starts writing the instant the reply opens.
      await page.keyboard.type("TOPLINE");
      await expect(body, "the deferred append never ran").toContainText(marker);

      // AND AGAIN AFTERWARDS, which is the only step that can see where the
      // append left the caret. No click in between: a click would place the
      // caret itself and prove nothing, exactly as the warm test above notes.
      await page.keyboard.type("MORE");
      const text = (await body.innerText()).replace(/\s+/g, " ").trim();
      expect(text, `the deferred append dragged the caret into the signature: ${text}`)
        .toContain("TOPLINEMORE");
      expect(text.indexOf("TOPLINEMORE")).toBeLessThan(text.indexOf(marker));
      expect(text.startsWith("TOPLINEMORE"), `body reads: ${text}`).toBe(true);

      await page.getByTestId("composer").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("composer")).toBeHidden();
    } finally {
      await page.unroute("**/api/mail/accounts", holdAccounts);
      await page.request.patch(`/api/mail/accounts/${accountId}`, { data: { signatureHtml: null } });
    }
  });

  test("hides the linked thread behind the unlinked filter and brings it back", async () => {
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toHaveCount(1);

    await page.getByTestId("filter-unlinked").click();
    // Alice's thread is claimed (contact and deal); Bob's is claimed by
    // nothing, which is exactly what the triage filter is for.
    //
    // BOB FIRST, AND THAT IS THE WHOLE OF THE ORDER'S JOB. A filter toggle
    // changes the list's QUERY KEY, and thread-list.tsx renders
    // `pages.key === key ? flatten(pages) : []` -- so between the click and
    // the new page landing there are no rows at all, and Alice's absence is
    // satisfied by a list that has not answered yet. Bob's presence is that
    // list answering.
    //
    // MEASURED WITH THE SERVER'S `unlinked` PREDICATE MADE A NO-OP, so Alice's
    // thread stays in the filtered list and this test is looking straight at
    // the state it exists to refuse. In the old order -- Alice's absence
    // first -- run 33353893938's e2e job was GREEN, all 164 tests, this one
    // among them. In this order, run 33353484548 failed it three attempts out
    // of three.
    await expect(threadRow(bobSubject)).toHaveCount(1);
    await expect(threadRow(aliceSubject)).toHaveCount(0);

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

  /**
   * Phase 4.4, and the rule this whole task turns on: FILING INTO A FOLDER
   * CONDUIT IS NOT SYNCING TURNS THAT SYNC ON. No warning, no confirm, no
   * second request -- filing a thread into a folder IS the statement that the
   * folder matters, and the app's job is to act on it and then say what it
   * did.
   *
   * The destination is chosen so the rule has something to prove: SPAM_FOLDER
   * classifies junk by name, so the CRM leaves it switched off on first sight
   * (see that constant), and the picker offers it anyway -- offering only
   * folders Conduit already syncs would make this feature useless for exactly
   * the folders people file into.
   */
  test("files a conversation into an unsynced folder, which starts syncing because of it", async () => {
    await page.goto("/mail");
    const inboxRow = page.getByTestId(`folder-${INBOX_FOLDER}`);
    await inboxRow.click();
    // Same reason the trash test asserts this: a click that did not land
    // leaves the list in "All mail", which is a different (whole-thread)
    // request -- and, for filing, a view with no single account, where the
    // picker is deliberately disabled.
    await expect(inboxRow).toHaveAttribute("aria-current", "true");
    await expect(threadRow(fileSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    // The folder is NOT in the rail yet -- an unsynced folder with nothing
    // unread in it has no row -- which is what makes its arrival below mean
    // something.
    await expect(page.getByTestId(`folder-${SPAM_FOLDER}`)).toHaveCount(0);

    await tickThread(fileSubject);
    await expect(page.getByTestId("bulk-count")).toHaveText("1 selected");

    // PICKING THE FOLDER IS THE GESTURE. There is no second button to press:
    // the choice is the instruction, the same single click the other three
    // actions take.
    await page.getByTestId("bulk-file").click();
    await page.getByRole("option", { name: SPAM_FOLDER, exact: true }).click();

    await expect(page.getByTestId("bulk-result"))
      .toContainText(`1 filed into \u201c${SPAM_FOLDER}\u201d`, { timeout: BULK_TIMEOUT_MS });
    // The consequence, said AFTER the fact and quietly -- a notification, not
    // a gate. Enabling a sync is real (a folder Conduit now walks every pass),
    // and nobody should have to discover it from a bandwidth graph.
    await expect(page.getByTestId("bulk-result"))
      .toContainText(`Conduit is now syncing \u201c${SPAM_FOLDER}\u201d`);

    // Out of the folder it was filed from...
    await expect(threadRow(fileSubject)).toHaveCount(0, { timeout: REFETCH_TIMEOUT_MS });
    // ...really on the server, asked of Dovecot rather than of the app that
    // says it put it there...
    await expect.poll(() => subjectsIn(SPAM_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(fileSubject);
    // ...and the conversation is still reachable rather than having quietly
    // left the CRM's view, which is the outcome the rule exists to prevent.
    await expect(page.getByTestId(`folder-${SPAM_FOLDER}`))
      .toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await page.getByTestId(`folder-${SPAM_FOLDER}`).click();
    await expect(threadRow(fileSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    // THE SWITCH ITSELF, read where a user would read it. The rail row above
    // is suggestive rather than conclusive -- a folder holding unread mail
    // gets a row whether or not it syncs -- so the claim is settled against
    // the Settings picker, which renders sync_enabled directly. The picker
    // and the filing rule write the same column through the same call
    // (setFolderSyncEnabled), and this is where that shows.
    await page.goto("/settings/mail");
    await page.getByTestId(`folders-toggle-${accountId}`).click();
    await expect(page.getByTestId(`folder-picker-${SPAM_FOLDER}`))
      .toBeChecked({ timeout: REFETCH_TIMEOUT_MS });
  });

  /**
   * Phase 4.4 Task 2, first half: FILING FROM INSIDE THE CONVERSATION.
   *
   * Task 1 built filing on the list only, so reading a thread and wanting to
   * file it meant going back, finding it again and selecting it -- three steps
   * to undo one navigation. This is a second ENTRANCE to that action, not a
   * second implementation, and what the test proves is the wiring: the same
   * endpoint, in the same whole-thread mode the Archive and Trash buttons
   * beside it already use.
   *
   * WHOLE-THREAD IS THE ASSERTION THAT MATTERS. Both of this conversation's
   * messages move, from one gesture, without either ever being selected --
   * which is exactly what the list's folder-scoped selection could not do.
   */
  test("files a whole conversation from inside it, both messages at once", async () => {
    await page.goto("/mail");
    const inboxRow = page.getByTestId(`folder-${INBOX_FOLDER}`);
    await inboxRow.click();
    await expect(inboxRow).toHaveAttribute("aria-current", "true");
    // These fixtures are MINUTES old, not seconds like the archive/trash trio
    // above, so on a retry -- where the mailbox also holds every earlier
    // attempt's threads -- they can sit past the list's first page. Same
    // reason the sync test loads all before reading the 4.3 rows.
    await loadAllThreadsOn(page);
    await expect(threadRow(convFileSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    await threadRow(convFileSubject).click();
    const conversation = page.getByTestId("conversation");
    await expect(conversation).toBeVisible();
    // The fixture really did thread: two messages, one conversation. Every
    // claim below about "both" rests on this.
    await expect(conversation.locator('[data-testid^="message-"]')).toHaveCount(2);

    // PICKING THE FOLDER IS THE GESTURE, here as on the list's bar: no second
    // button to press, because the choice is the instruction.
    await page.getByTestId("conversation-file").click();
    await page.getByRole("option", { name: CLIENTS_FOLDER, exact: true }).click();

    await expect(page.getByTestId("conversation-move-result"))
      .toContainText(`1 filed into \u201c${CLIENTS_FOLDER}\u201d`, { timeout: BULK_TIMEOUT_MS });

    // ONE conversation filed, but BOTH its messages moved -- asked of Dovecot
    // rather than of the app that says it moved them. The reply keeps its
    // "Re:" on the server, which is what makes the pair nameable apart.
    await expect.poll(() => subjectsIn(CLIENTS_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toEqual(expect.arrayContaining([convFileSubject, `Re: ${convFileSubject}`]));
    // Plain, not polled: the poll above has already waited for the move to
    // land, and a polled NEGATIVE would pass on its first attempt for a move
    // that had not happened yet.
    const inboxAfter = await subjectsIn(INBOX_FOLDER);
    expect(inboxAfter).not.toContain(convFileSubject);
    expect(inboxAfter).not.toContain(`Re: ${convFileSubject}`);
  });

  /**
   * Phase 4.4 Task 2, second half: ONE MESSAGE FILED OUT OF A THREAD.
   *
   * Selection has been per THREAD since 4.3, and this is the gesture that is
   * not expressible that way at all: file the first message of a conversation
   * and leave the rest where it is. It goes to its own endpoint
   * (/api/mail/messages/bulk) with its own results, keyed per message.
   *
   * WHAT THE APP SHOWS AFTERWARDS IS THE POINT OF THE LAST HALF OF THIS TEST,
   * and it is a decision rather than a consequence: the thread is INTACT. Its
   * row is untouched, the conversation still renders both messages (the
   * conversation is not folder-scoped), and the thread is now listed in BOTH
   * folder views at once -- because a thread is "in" a folder when any of its
   * messages is, which is 4.1's existing rule and not a new one. The
   * alternative would have been splitting the conversation, which destroys the
   * reply chain threading exists for.
   */
  test("files ONE message out of a conversation, leaving the thread intact", async () => {
    await page.goto("/mail");
    const inboxRow = page.getByTestId(`folder-${INBOX_FOLDER}`);
    await inboxRow.click();
    await expect(inboxRow).toHaveAttribute("aria-current", "true");
    await loadAllThreadsOn(page);
    await expect(threadRow(splitSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    await threadRow(splitSubject).click();
    const conversation = page.getByTestId("conversation");
    await expect(conversation.locator('[data-testid^="message-"]')).toHaveCount(2);

    // The conversation renders oldest-first, so the first checkbox is the
    // thread's root -- the one whose subject carries no "Re:", which is how
    // the server-side assertions below tell which message moved.
    await conversation.locator('[data-testid^="select-message-"]').first().check();
    await expect(page.getByTestId("selection-count")).toHaveText("1 selected");

    await page.getByTestId("selection-file").click();
    await page.getByRole("option", { name: CLIENTS_FOLDER, exact: true }).click();

    // "1 filed" counts a MESSAGE here, not a conversation -- the response is
    // keyed per message, which is the whole reason this path is its own.
    await expect(page.getByTestId("conversation-move-result"))
      .toContainText(`1 filed into \u201c${CLIENTS_FOLDER}\u201d`, { timeout: BULK_TIMEOUT_MS });
    // The bar goes with the selection it described: nothing may invite a blind
    // retry of a move that has already landed.
    await expect(page.getByTestId("selection-bar")).toHaveCount(0);

    // EXACTLY ONE of the two moved, asked of the server. The root is in
    // Clients; its reply is still in INBOX.
    await expect.poll(() => subjectsIn(CLIENTS_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(splitSubject);
    await expect.poll(() => subjectsIn(INBOX_FOLDER), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(`Re: ${splitSubject}`);
    expect(await subjectsIn(INBOX_FOLDER)).not.toContain(splitSubject);

    // THE THREAD IS INTACT. The conversation still holds both messages --
    // filing one out of it moves mail between mailboxes, it does not split a
    // conversation -- and the CRM has not expunged anything.
    await expect(conversation.locator('[data-testid^="message-"]'))
      .toHaveCount(2, { timeout: REFETCH_TIMEOUT_MS });

    // AND IT IS NOW LISTED IN BOTH FOLDER VIEWS, which is the decision this
    // test exists to pin. It stays in INBOX because its reply is still there,
    // and it appears in Clients because its root now is. Neither is a special
    // case: both fall out of the folder rule 4.1 already had.
    await page.getByTestId(`folder-${INBOX_FOLDER}`).click();
    await loadAllThreadsOn(page);
    await expect(threadRow(splitSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await page.getByTestId(`folder-${CLIENTS_FOLDER}`).click();
    await loadAllThreadsOn(page);
    await expect(threadRow(splitSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
  });

  // -- Phase 4.4 Task 4: folder management, against the real server ---------

  test("makes a folder from Settings, and it is on the server and filable into", async () => {
    await page.goto("/settings/mail");
    await page.getByTestId(`folders-toggle-${accountId}`).click();
    await page.getByTestId(`folder-create-input-${accountId}`).fill(madeFolder);
    await page.getByTestId(`folder-create-${accountId}`).click();

    // BORN SYNCING, unlike a folder Conduit merely discovers: making one here
    // is the statement that it matters, so its box is ticked from the start.
    const box = page.getByTestId(`folder-picker-${madeFolder}`);
    await expect(box).toBeChecked({ timeout: REFETCH_TIMEOUT_MS });
    // And it really is a mailbox: asked of Dovecot, not of the CRM.
    await expect.poll(() => subjectsIn(madeFolder), { timeout: REFETCH_TIMEOUT_MS }).toEqual([]);

    // It is offered as a filing destination straight away -- the create
    // invalidates the folders query the picker reads.
    //
    // `junkSubject` and not one of the already-filed fixtures, and the reason
    // is worth keeping because it cost a CI run to find: a move NULLS the
    // stored `imap_uid` and the next pass of the TARGET folder restores it, so
    // a message that has just been filed is ineligible for a second move until
    // that pass lands ("1 will complete after the next sync pass"). junkSubject
    // was INGESTED by the pass that walked Junk and has never been moved, so
    // its UID is real. It is also a single message, which is what makes the
    // rename's "1 stored message moved with it" exact rather than approximate.
    await page.goto("/mail");
    await page.getByTestId(`folder-${JUNK_FOLDER}`).click();
    await loadAllThreadsOn(page);
    await tickThread(junkSubject);
    await page.getByTestId("bulk-file").click();
    await page.getByRole("option", { name: madeFolder, exact: true }).click();
    await expect(page.getByTestId("bulk-result"))
      .toContainText("1 filed", { timeout: BULK_TIMEOUT_MS });
    await expect.poll(() => subjectsIn(madeFolder), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(junkSubject);
  });

  test("renames it, and the stored mail moves with it on BOTH sides", async () => {
    await page.goto("/settings/mail");
    await page.getByTestId(`folders-toggle-${accountId}`).click();
    await expect(page.getByTestId(`folder-picker-${madeFolder}`))
      .toBeVisible({ timeout: REFETCH_TIMEOUT_MS });

    await page.getByTestId(`folder-rename-${madeFolder}`).click();
    await page.getByTestId(`folder-rename-input-${madeFolder}`).fill(renamedFolder);
    await page.getByTestId(`folder-rename-save-${madeFolder}`).click();

    // The row is RE-KEYED IN PLACE: the new name appears and the old one is
    // gone entirely, rather than a second row arriving beside a stale first.
    // That is the whole difference between renaming through Conduit and
    // renaming in another client, and it is what stops the filing picker
    // going on offering a folder that is not there.
    await expect(page.getByTestId(`folder-picker-${renamedFolder}`))
      .toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await expect(page.getByTestId(`folder-picker-${madeFolder}`)).toHaveCount(0);
    // Said afterwards, because a rename silently re-keys stored mail and an
    // operator who is not told finds out from a search that stops matching.
    await expect(page.getByText(/1 stored message moved with it/)).toBeVisible();

    // THE SERVER MOVED TOO, and the message went with the mailbox.
    await expect.poll(() => subjectsIn(renamedFolder), { timeout: REFETCH_TIMEOUT_MS })
      .toContain(junkSubject);

    // AND THE DATABASE AGREES: the conversation is listed under the NEW folder
    // and under no other. A re-key that had missed mail_messages would leave
    // this view empty while the server held the mail.
    await page.goto("/mail");
    await page.getByTestId(`folder-${renamedFolder}`).click();
    await loadAllThreadsOn(page);
    await expect(threadRow(junkSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
  });

  test("REFUSES to delete it while it still holds mail, then deletes it once empty", async () => {
    await page.goto("/settings/mail");
    await page.getByTestId(`folders-toggle-${accountId}`).click();
    await expect(page.getByTestId(`folder-picker-${renamedFolder}`))
      .toBeVisible({ timeout: REFETCH_TIMEOUT_MS });

    await page.getByTestId(`folder-delete-${renamedFolder}`).click();
    // WHAT HAPPENS IS SAID BEFORE IT HAPPENS -- the spec's requirement, and the
    // sentence that keeps this from being the product's first expunge.
    await expect(page.getByText(/Every message Conduit has already stored from it is KEPT/))
      .toBeVisible();
    await page.getByTestId("folder-delete-confirm").click();

    // Refused BY THE SERVER'S OWN COUNT, and the folder is still there. No mail
    // server refuses this for us: Dovecot deletes a full mailbox without
    // complaint, so this refusal is the only thing between a click and
    // destroyed mail.
    // Scoped to the dialog: the settings page can carry other alerts, and the
    // refusal has to be where the question was asked.
    await expect(page.getByRole("dialog").getByRole("alert"))
      .toContainText(/still holds 1 message on the mail server/, { timeout: BULK_TIMEOUT_MS });
    expect(await subjectsIn(renamedFolder)).toContain(junkSubject);

    // THE APP'S way out is the filing action the refusal names, and this leg
    // has already shown filing INTO this folder work. Emptying it again is done
    // over RAW IMAP instead, deliberately: filing the message OUT would need
    // its `imap_uid` back, and a move nulls that until the target folder's next
    // pass re-sights it -- so routing the tidy-up through the app would make
    // this delete case wait on a sync pass to test something that has nothing
    // to do with one. Conduit is NOT told, which is better still: it goes on
    // holding the stored message, so the count it reports below is the promise
    // being kept rather than a coincidence.
    await emptyOnServer(renamedFolder, ARCHIVE_FOLDER);
    await expect.poll(() => subjectsIn(renamedFolder), { timeout: REFETCH_TIMEOUT_MS }).toEqual([]);

    await page.goto("/settings/mail");
    await page.getByTestId(`folders-toggle-${accountId}`).click();
    await page.getByTestId(`folder-delete-${renamedFolder}`).click();
    await page.getByTestId("folder-delete-confirm").click();

    // Gone from the server, and the count says what was KEPT rather than what
    // was removed -- the promise the confirmation made, restated as a fact.
    await expect(page.getByText(/Deleted from the mail server\. Conduit kept 1 stored message/))
      .toBeVisible({ timeout: BULK_TIMEOUT_MS });
    await expect.poll(async () => (await listFolders()).includes(renamedFolder), {
      timeout: REFETCH_TIMEOUT_MS,
    }).toBe(false);
    // ...and the ROW SURVIVES, switched off, because rows in that table are
    // never deleted and the mail Conduit stored from this folder still has to
    // have a folder to be listed under. The mail is still there, too.
    const box = page.getByTestId(`folder-picker-${renamedFolder}`);
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
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
    // Filing is a server move too, so the owner-only rule takes it as well
    // (Phase 4.4) -- a colleague must never reorganise your mailbox, whichever
    // folder they were reorganising it into. B is over-determined here (they
    // own no mail account of their own either, which alone would empty the
    // picker); the unit suite is where the two reasons are told apart, and
    // what matters on this screen is that the control is not offered.
    await expect(bPage.getByTestId("bulk-file")).toBeDisabled();
    await expect(bPage.getByTestId("bulk-hide")).toBeEnabled();
    await expect(bPage.getByTestId("bulk-owner-blocked"))
      .toContainText("only the mailbox owner can file, archive or trash");
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

  // -- Phase 4.3: the detail cap's Show earlier, the 1280px header guard,
  //    forward re-attach over the wire, and the per-user hide journey -------

  test("caps the 51-message conversation at 50 and Show earlier loads the rest", async () => {
    await page.goto("/mail");
    // Alice's row is the loaded-list sentinel; the long thread, dated hours
    // old, can sit past page one on a retry (see loadAllThreadsOn).
    await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await loadAllThreadsOn(page);
    await expect(threadRow(longSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    await threadRow(longSubject).click();

    const conversation = page.getByTestId("conversation");
    await expect(conversation).toBeVisible();
    // The payload bound: the newest 50 of 51, plus the control saying
    // exactly what it is holding back.
    const messages = conversation.locator('[data-testid^="message-"]');
    await expect(messages).toHaveCount(50, { timeout: REFETCH_TIMEOUT_MS });
    const showEarlier = page.getByTestId("show-earlier");
    await expect(showEarlier).toHaveText("Show earlier messages (1 more)");

    await showEarlier.click();
    await expect(messages).toHaveCount(51, { timeout: REFETCH_TIMEOUT_MS });
    // Nothing held back any more: the uncapped payload is not truncated, so
    // the control has nothing to offer and unmounts.
    await expect(showEarlier).toHaveCount(0);
  });

  test("keeps the conversation header's actions inside the pane at 1280px wide", async () => {
    // Set explicitly rather than inherited from Playwright's default, so a
    // future default change cannot quietly turn this into an assertion
    // about some other width. This is the overlap fix's only guard: before
    // the Task 3 flex-wrap fix, the four header actions overflowed the
    // ~416px conversation pane at exactly this viewport and clipped at its
    // edge -- so the assertion is horizontal CONTAINMENT in the pane, which
    // clipping cannot satisfy, not mere visibility, which it can.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/mail?thread=${aliceThreadId}`);
    const conversation = page.getByTestId("conversation");
    await expect(conversation).toBeVisible();

    // A's own conversation renders all four actions: the remote-images
    // opt-in, the two owner-only server moves, and the CRM-side Hide.
    const actionIds = ["load-remote-images", "conversation-archive", "conversation-trash", "hide-thread"];
    for (const testId of actionIds) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    // The containment math is POLLED rather than snapshotted once: a late
    // web-font load can reflow widths after first paint. Hardening only --
    // no flake was observed with the single-shot form.
    await expect.poll(async () => {
      const pane = await conversation.boundingBox();
      if (pane === null) return "conversation: no bounding box";
      const overflowing: string[] = [];
      for (const testId of actionIds) {
        const box = await page.getByTestId(testId).boundingBox();
        if (box === null || box.x < pane.x - 1 || box.x + box.width > pane.x + pane.width + 1) {
          overflowing.push(testId);
        }
      }
      return overflowing.length === 0 ? "contained" : `overflowing: ${overflowing.join(", ")}`;
    }).toBe("contained");

    // Put the shared page back on Playwright's default viewport: this
    // serial file shares one page, and the +80px of height would otherwise
    // ride silently into every test after this one.
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test("forwards the fixture message and the stored attachment rides to Mailpit", async () => {
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await loadAllThreadsOn(page);
    await expect(threadRow(attachSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    await threadRow(attachSubject).click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    // The ingested original's attachment chip, on the (newest, expanded)
    // message: the stored blob the forward will re-attach.
    await expect(
      page.locator('[data-testid^="attachment-"]').filter({ hasText: attachmentName }),
    ).toBeVisible();

    await page.getByTestId("forward-button").click();
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();
    // Seeded as a removable chip carrying the attachment's id -- the Task 3
    // composer surface, exercised for real for the first time here.
    const chip = composer.locator('[data-testid^="composer-forward-attachment-"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText(attachmentName);
    await expect(page.getByTestId("composer-subject")).toHaveValue(`Fwd: ${attachSubject}`);
    // v1.2.0: a forward arrives with a subject and a quoted body but NO
    // recipient, so To is the first empty field and the caret belongs there.
    // (An earlier version of this comment called it the row the plan's
    // "a reply focuses the body" rule got wrong. It is not: openForward above
    // sets no threadId, so the plan's rule calls a forward a new compose and
    // reaches To as well. The row the plan misses is a record's Mail tab --
    // see mail-lib.ts's composerInitialFocus.)
    // The fill() below would have worked either way -- it does not need
    // focus -- which is exactly why this is asserted separately.
    await expect(page.getByTestId("composer-to")).toBeFocused();

    const forwardTarget = `fwd-target-${attemptTag}@example.com`;
    await page.getByTestId("composer-to").fill(forwardTarget);
    await page.getByTestId("composer-to").press("Enter");
    await page.getByTestId("composer-send").click();
    await expect(composer).toBeHidden({ timeout: 30_000 });

    // Mailpit holds the forward, addressed as typed. The chip alone would
    // only prove the composer UI; the wire is where re-attach either works
    // or does not.
    const expectedSubject = `Fwd: ${attachSubject}`;
    let mailpitId = "";
    await expect.poll(async () => {
      const response = await page.request.get(`${MAILPIT_URL}/api/v1/messages?limit=200`);
      if (!response.ok()) return null;
      const body = await response.json() as {
        messages?: { ID?: string; Subject?: string; To?: { Address?: string }[] }[];
      };
      const hit = (body.messages ?? []).find((message) =>
        message.Subject === expectedSubject
        && (message.To ?? []).some((entry) => entry.Address === forwardTarget)) ?? null;
      mailpitId = hit?.ID ?? "";
      return hit;
    }, { timeout: 20_000 }).not.toBeNull();

    // ...and its detail lists the re-attached file by name: the bytes
    // crossed SMTP as a real attachment part.
    const detail = await page.request.get(`${MAILPIT_URL}/api/v1/message/${mailpitId}`);
    expect(detail.ok()).toBe(true);
    const parsed = await detail.json() as { Attachments?: { FileName?: string }[] };
    expect((parsed.Attachments ?? []).map((entry) => entry.FileName)).toContain(attachmentName);
  });

  test("shares the mailbox again and A hides the handover thread for A alone", async () => {
    // The hide journey needs the SAME thread in two inboxes, and only a
    // shared account puts it in B's -- so the 4.2 closer's hygiene flip is
    // undone here and redone at the end of the journey.
    await page.goto("/settings/mail");
    const toggle = page.getByTestId(`visibility-toggle-${accountId}`);
    await expect(toggle).toHaveText("Private", { timeout: REFETCH_TIMEOUT_MS });
    await toggle.click();
    await expect(toggle).toHaveText("Shared", { timeout: REFETCH_TIMEOUT_MS });

    // B's inbox carries the handover thread now.
    await bPage.goto("/mail");
    await pollWithReloadOn(bPage, async () => {
      await loadAllThreadsOn(bPage);
      await expect(threadRowOn(bPage, hideSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // A's inbox and search both find it -- the positive halves that make
    // the post-hide negatives statements about something that was there.
    await page.goto("/mail");
    await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await loadAllThreadsOn(page);
    await expect(threadRow(hideSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    await page.getByTestId("search-input").fill(hideMarker);
    const hideResult = page.getByTestId("search-result").filter({ hasText: hideSubject });
    await expect(hideResult).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    await expect(page.getByTestId("search-result").filter({ hasText: sentinelSubject })).toBeVisible();

    // Open through the result (which also closes the dropdown) and hide.
    // The conversation STAYS OPEN -- a hide is a filing act, not a lock --
    // with the button flipped to Unhide: the hiddenAt-driven button state,
    // exercised on screen.
    await hideResult.click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await page.getByTestId("hide-thread").click();
    await expect(page.getByTestId("unhide-thread")).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });

    // Gone from A's default inbox: an absence from the WHOLE loaded list,
    // with Alice's row as the loaded sentinel.
    await page.goto("/mail");
    await pollWithReload(async () => {
      await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await loadAllThreadsOn(page);
      await expect(threadRow(hideSubject)).toHaveCount(0);
    });

    // ...and from A's search, where the sentinel thread -- same body
    // marker, never hidden -- still answering is what proves the result
    // list loaded rather than merely not having arrived ("No results" also
    // renders while the query is in flight).
    await pollWithReload(async () => {
      await page.getByTestId("search-input").fill(hideMarker);
      await expect(page.getByTestId("search-result").filter({ hasText: sentinelSubject }))
        .toBeVisible({ timeout: ATTEMPT_TIMEOUT_MS });
      await expect(page.getByTestId("search-result").filter({ hasText: hideSubject })).toHaveCount(0);
    });
  });

  test("keeps B's inbox untouched and lists the hidden thread in A's Hidden view", async () => {
    // B first: A's filing is A's alone, and B's default inbox still lists
    // the thread A just hid.
    await bPage.goto("/mail");
    await expect(threadRowOn(bPage, aliceSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await loadAllThreadsOn(bPage);
    await expect(threadRowOn(bPage, hideSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });

    // A's Hidden view: the same list machinery with the inverted hide arm.
    // The row wears the viewer's own filing moment as its chip; Alice's
    // live thread has no business here.
    await page.goto("/mail");
    await page.getByTestId("filter-hidden").click();
    await expect(threadRow(hideSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await expect(threadRow(hideSubject).getByTestId("hidden-chip")).toBeVisible();
    await expect(threadRow(hideSubject).getByTestId("hidden-chip")).toContainText("Hidden");
    await expect(threadRow(aliceSubject)).toHaveCount(0);

    // Phase 4.4: in the Hidden view the bulk bar's CRM-side button is the
    // INVERSE, swapped rather than added -- the same choice the conversation
    // makes from a thread's own hiddenAt. Exactly one of the pair is the
    // useful gesture for a selection here, and rendering both would put a
    // permanent no-op beside the one the user wants. Asserted without running
    // it: the next test needs this thread still hidden, and unhide's behaviour
    // is pinned in the unit and route suites.
    await tickThread(hideSubject);
    await expect(page.getByTestId("bulk-unhide")).toBeEnabled();
    await expect(page.getByTestId("bulk-hide")).toHaveCount(0);
    await page.getByTestId("bulk-clear").click();
  });

  test("unhides from the conversation, restoring A's inbox, and re-privatizes the mailbox", async () => {
    // Unhide lives in the conversation, reached here the way a user would:
    // from the Hidden view's row.
    await page.goto("/mail");
    await page.getByTestId("filter-hidden").click();
    await expect(threadRow(hideSubject)).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await threadRow(hideSubject).click();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await page.getByTestId("unhide-thread").click();
    await expect(page.getByTestId("hide-thread")).toBeVisible({ timeout: REFETCH_TIMEOUT_MS });
    // The Hidden list beside the pane lets go of the row as the unhide
    // lands -- the conversation itself stays open -- and the emptied view
    // says so out loud: the empty label is this negative's loaded-list
    // sentinel (beforeAll's unhide hygiene is what makes "empty" hold even
    // on a retry after a mid-journey failure).
    await expect(threadRow(hideSubject)).toHaveCount(0, { timeout: REFETCH_TIMEOUT_MS });
    await expect(page.getByTestId("thread-list")).toContainText("No hidden conversations");

    // Restored to the default inbox (a fresh load resets the filter).
    await page.goto("/mail");
    await pollWithReload(async () => {
      await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      await loadAllThreadsOn(page);
      await expect(threadRow(hideSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // The journey's own hygiene, mirroring the 4.2 closer: the mailbox ends
    // Private, the state every attempt starts from.
    await page.goto("/settings/mail");
    const toggle = page.getByTestId(`visibility-toggle-${accountId}`);
    await expect(toggle).toHaveText("Shared", { timeout: REFETCH_TIMEOUT_MS });
    await toggle.click();
    await expect(toggle).toHaveText("Private", { timeout: REFETCH_TIMEOUT_MS });
  });

  // -- Phase 5: mail on the record timeline, the two-user privacy leg, and
  //    the link panel's picker ------------------------------------------
  //
  // The mailbox is PRIVATE by the time these run (the two tests above each
  // end by putting it back), which is the state the privacy leg is about.

  test("puts the conversation on its contact's timeline, with the subject rendered live", async () => {
    await page.goto(`/contacts/${timelineContactId}`);
    // Timeline is the rail's default tab. Nothing here clicks "Load more":
    // this contact's timeline holds three entries at most, and a paginated
    // timeline freezes its first page.
    await expect(page.getByTestId("timeline")).toBeVisible();
    const entry = page.getByTestId("timeline-entry")
      .filter({ hasText: `received mail "${timelineSubject}"` });
    await expect(entry).toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });

    // THE SUBJECT ON THAT ENTRY IS NOT STORED ON IT. The event carries a
    // pointer to the thread and no content at all; the subject is read
    // through the visibility rules at request time, which is exactly why the
    // next test can be true. What the reader gets is the conversation.
    await entry.getByTestId("timeline-thread-link").click();
    await expect(page).toHaveURL(/\/mail\?thread=[0-9a-f-]{36}$/);
    await expect(page.getByTestId("conversation")).toContainText(timelineSubject);
    // Where the entry led IS the thread id, so it is taken from the link's
    // own destination rather than looked up: the next test replies on it.
    timelineThreadId = new URL(page.url()).searchParams.get("thread") as string;
  });

  test("puts the reply to her on that same timeline as an outbound entry", async () => {
    // THE SPEC'S TESTING LINE IS ABOUT AN EXCHANGE, and the outbound half
    // rides the same emission with the opposite verb -- mail-send has no
    // insert path of its own, it hands what it sent to the same ingest.
    //
    // ON HER THREAD, NOT ON ALICE'S DEAL-LINKED ONE, and that is a retry
    // decision rather than a stylistic one. The throttle is one entry per
    // thread per direction per UTC day, so a second attempt's reply on a
    // thread that already emitted today emits nothing at all -- and Alice's
    // thread and her deal are scoped per RUN, so an attempt that re-created
    // the deal would be asserting against a record no entry can reach until
    // tomorrow. Cora's thread is per-attempt down to its Message-ID, which
    // makes every attempt's reply a first sighting.
    await page.goto(`/mail?thread=${timelineThreadId}`);
    await expect(page.getByTestId("conversation")).toBeVisible();
    await page.getByTestId("reply-button").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    // Real key events, as the Alice reply above: the body is a TipTap
    // document, not an input.
    await typeIntoEditor(page.getByTestId("composer-body"), timelineReplyBody);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("composer")).toBeHidden({ timeout: 30_000 });

    // Both halves of the exchange, on the record: one entry per direction,
    // each carrying the thread's subject and neither carrying its content.
    await page.goto(`/contacts/${timelineContactId}`);
    await expect(page.getByTestId("timeline")).toBeVisible();
    await expect(page.getByTestId("timeline-entry")
      .filter({ hasText: `sent mail "${timelineSubject}"` }))
      .toHaveCount(1, { timeout: REFETCH_TIMEOUT_MS });
    await expect(page.getByTestId("timeline-entry")
      .filter({ hasText: `received mail "${timelineSubject}"` }))
      .toHaveCount(1);
  });

  test("keeps that private conversation off the second user's timeline for the same contact", async () => {
    await bPage.goto(`/contacts/${timelineContactId}`);

    // THE LOADED-LIST SENTINEL, and it has to come first: the contact's own
    // creation entry is ordinary CRM activity that every user can see, so
    // its arrival is what makes the absence below a statement about a
    // timeline that LOADED rather than one that has not answered yet.
    await expect(bPage.getByTestId("timeline-entry").filter({ hasText: "created" }))
      .toBeVisible({ timeout: REFETCH_TIMEOUT_MS });

    // ...and A's mail is not there -- NEITHER DIRECTION, the inbound entry
    // or the reply A just sent. Not a redacted stub, not an "activity you
    // cannot see" placeholder: an entry like that would leak both the
    // existence and the timing of someone else's mail. NO ROW AT ALL.
    //
    // THREE ASSERTIONS, AND NONE OF THEM IS THE OTHERS' SPELLING. This is
    // the phase's most important test and the trio is what it is worth;
    // delete one and the leg still passes while covering less:
    //
    //   1. the SUBJECT, which is the content itself -- a row rendered from a
    //      thread B may not read.
    //   2. the LINK, which is the one element a mail entry has and no other
    //      entry does -- a row that showed no subject but still offered
    //      "View conversation".
    //   3. the WORD, which is the row carrying neither: a deliberate
    //      redacted placeholder. Nothing renders one today (it would take
    //      the API deciding to serve the row AND the web deciding to draw
    //      it), but if anything ever does it goes through summarize()'s
    //      mail_received/mail_sent arms (web: rail/timeline-lib.ts), and
    //      "received mail"/"sent mail" is the part of those a redaction has
    //      no reason to remove. That is the shape assertions 1 and 2 both
    //      miss.
    //
    // \b rather than a bare /mail/: this very contact's Emails field was
    // filled in beforeAll, so her timeline carries an "updated emails" entry
    // -- ordinary CRM activity, which B can and should see. The boundaries
    // are what keep the third assertion about mail rather than about the
    // word inside "emails". The recorded backlog item asked for a bare
    // /mail/, which would have failed on every run for exactly that reason.
    // Case-insensitive because a placeholder is as likely to open with a
    // capital: the boundaries already exclude "Emails", so the `i` costs
    // nothing and closes "Mail activity you cannot see".
    await expect(bPage.getByTestId("timeline-entry").filter({ hasText: timelineSubject }))
      .toHaveCount(0);
    await expect(bPage.getByTestId("timeline").getByTestId("timeline-thread-link")).toHaveCount(0);
    await expect(bPage.getByTestId("timeline-entry").filter({ hasText: /\bmail\b/i }))
      .toHaveCount(0);
    // 4. AND NOTHING ELSE IS THERE AT ALL. The three above are shape-specific:
    //    a placeholder carrying no subject, no link and no mail-ish word --
    //    "Private activity", "1 hidden item", an empty row -- walks past all
    //    of them. Today that shape cannot exist, because timeline.tsx renders
    //    every entry through summarize(), whose only mail arms produce the
    //    wording assertion 3 catches; but that is a fact about one call site,
    //    not a property of the API, and this is the leg that proves a private
    //    mailbox stays private. B's view of this contact is deterministic:
    //    the contact's own "created" row and the "updated emails" row from
    //    beforeAll. Counting them closes the class outright.
    //
    //    WHEN THIS FAILS AT 3: do not raise the number to make it pass. A new
    //    entry on B's timeline is either an ordinary CRM event the fixture
    //    now produces -- in which case say which, here -- or it is the leak
    //    this assertion exists to catch.
    await expect(bPage.getByTestId("timeline-entry")).toHaveCount(2);
  });

  test("opens the link panel's contact picker on the conversation", async () => {
    // The app's ONE entity picker moved out of this panel in Phase 5, so the
    // Meetings tab's attendee input could use it (e2e/meetings.spec.ts picks
    // a contact through the other copy). Nothing asserted its addresses from
    // outside before, in either place: this is the mail half of closing that.
    await page.goto(`/mail?thread=${aliceThreadId}`);
    await expect(page.getByTestId("conversation")).toBeVisible();

    const panel = page.getByTestId("link-panel");
    await panel.getByTestId("link-contact").click();
    const search = panel.getByTestId("link-search-contact");
    await expect(search).toBeVisible();
    await search.fill(contactName);
    await expect(panel.getByTestId(`link-option-${contactId}`)).toBeVisible();

    // Cancelled rather than picked: this thread is already linked to Alice
    // (auto-linked at ingest, asserted several tests up), and re-linking her
    // would prove nothing while moving state the earlier assertions describe.
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByTestId("link-search-contact")).toHaveCount(0);
  });

  // -- Phase 4.4 Task 3: the list is live, and it does not move ------------
  //
  // THESE THREE RUN LAST AND SHARE ONE PAGE, deliberately and in this order.
  // Nothing between them navigates or reloads, because "without a reload" is
  // the property: the reader loads a deep list once and everything after that
  // has to reach them over SSE. A goto in the middle would reset the
  // accumulation and prove the first page instead.

  test("pages past the first page of a backlog deep enough to have one", async () => {
    // Appended AFTER the account exists, unlike seedMailbox's fixtures: the
    // incremental pass fetches by UID and only applies the backfill window
    // while the cursor is still at zero (api: mail-sync.ts), so a message with
    // an old INTERNALDATE arriving now is ingested on its UID and lands at the
    // BOTTOM of the list -- which is exactly where a backlog belongs.
    await withImap(async (client) => {
      for (let index = 0; index < BACKLOG_COUNT; index += 1) {
        await client.append(
          INBOX_FOLDER,
          rfc822([
            `From: Backlog Sender <backlog-${attemptTag}@example.com>`,
            `To: Conduit <${USERNAME}>`,
            `Subject: ${backlogSubject(index)}`,
            `Message-ID: ${backlogId(index)}`,
            `Date: ${new Date(backlogBaseMs + index * MINUTE_MS).toUTCString()}`,
            "Content-Type: text/plain; charset=utf-8",
          ], `Backlog item ${index}.`),
          // \Seen on purpose: the unread badge is counted exactly by earlier
          // tests in this file, and on a retry these messages exist while
          // those run.
          ["\\Seen"],
          new Date(backlogBaseMs + index * MINUTE_MS),
        );
      }
    });

    await page.goto("/mail");
    // The RELOAD IS ALLOWED HERE and nowhere below: this is setup waiting on a
    // background sync pass, not the property under test. Load-more runs inside
    // the check because a reload resets the accumulation with it.
    await pollWithReload(async () => {
      await loadAllThreadsOn(page);
      // THE LAST ONE APPENDED, AND IT IS THE SENTINEL FOR THE WHOLE SET.
      //
      // This wait used to name backlogSubject(0) alone, which is the FIRST of
      // the thirty appended and therefore the first ingested -- the pass walks
      // by ascending UID (mail-sync.ts) and these went up in a loop, so item 00
      // appearing says one of thirty has landed and nothing at all about the
      // other twenty-nine. The index assertion below needs all of them: it
      // counts the rows above the target, and rows that have not been ingested
      // yet cannot be among them.
      //
      // Measured, not reasoned about after the fact: CI run 33953041155 read
      // `indexOf` as 17 where it wanted >= 25. Thirteen fixture threads plus
      // backlog 03, 04 and 05 above a target of 02 is exactly 16 -- i.e. six
      // of the thirty had arrived, item 00 among them, and the poll let the
      // test through. Item 29 is the one whose arrival means the set is whole.
      await expect(threadRow(backlogSubject(BACKLOG_COUNT - 1)))
        .toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      // And the oldest, which is the half about PAGING rather than ingest: it
      // sorts to the very bottom, so seeing it means every page is on screen.
      await expect(threadRow(backlogSubject(0))).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // The row the next test replies into, and PROOF THAT IT IS BEYOND PAGE ONE
    // rather than a hope about how the fixtures stacked up. Page one is 25
    // rows (thread-list.tsx's DEFAULT_LIMIT), so an index of 25 or more is a
    // row only the accumulated pages are showing -- the rows that had no live
    // query at all before this task.
    targetRowId = (await threadRow(backlogSubject(BACKLOG_TARGET))
      .getAttribute("data-testid")) as string;
    expect((await rowIds()).indexOf(targetRowId)).toBeGreaterThanOrEqual(25);
  });

  /**
   * The half that stops "does not move" from meaning "goes stale". New mail in
   * a conversation the reader can SEE arrives where that conversation already
   * is -- new snippet, unread again -- and the list does not re-order itself
   * around it, even though the server now sorts that thread first.
   *
   * It also proves the cross-page refresh: the row being refreshed is beyond
   * page one, and the only fetch carrying its new copy is page one's, because
   * a conversation with new mail is by definition among the newest.
   */
  test("brings new mail to a listed conversation without moving its row", async () => {
    const before = await rowIds();
    await expect(page.getByTestId("thread-list-new-show")).toHaveCount(0);

    // Captured, because the arrival in the NEXT test has to be dated strictly
    // after this one or the two rows tie and the reveal order is a toss (the
    // whole story is on backlogReplyAt). Used for both the header and the
    // INTERNALDATE, so the two cannot drift apart.
    backlogReplyAt = new Date();
    await withImap(async (client) => {
      await client.append(
        INBOX_FOLDER,
        rfc822([
          `From: Backlog Sender <backlog-${attemptTag}@example.com>`,
          `To: Conduit <${USERNAME}>`,
          `Subject: Re: ${backlogSubject(BACKLOG_TARGET)}`,
          `Message-ID: <backlog-reply-${attemptTag}@example.com>`,
          `In-Reply-To: ${backlogId(BACKLOG_TARGET)}`,
          `References: ${backlogId(BACKLOG_TARGET)}`,
          `Date: ${backlogReplyAt.toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
        ], `Replying about the backlog ${backlogReplyMarker}.`),
        [],
        backlogReplyAt,
      );
    });

    // NO RELOAD. The snippet is the newest message's body, so the marker
    // appearing in this row IS the SSE hint arriving, the page-one refetch
    // landing and the row being refreshed where it stands.
    const target = threadRow(backlogSubject(BACKLOG_TARGET));
    await expect(target).toContainText(backlogReplyMarker, { timeout: SYNC_TIMEOUT_MS });
    // ...and the row is unread again, which is the other half of the copy
    // being replaced rather than merely re-rendered.
    await expect(target.getByRole("img", { name: "Unread" })).toBeVisible();

    // NOTHING MOVED. Not the replied-to row, which the server now sorts first;
    // not the rows it would have passed on its way there; and nothing was
    // added or dropped anywhere in the list.
    expect(await rowIds()).toEqual(before);
    // And no offer to reveal it, because there is nothing to reveal: the mail
    // is already on screen. A count here would point at a row the reader can
    // see.
    await expect(page.getByTestId("thread-list-new-show")).toHaveCount(0);
  });

  /**
   * The other half: a conversation the reader CANNOT see is counted rather
   * than inserted, and the reader decides when to lose their place.
   */
  test("counts a new conversation instead of showing it, until the reader asks", async () => {
    const before = await rowIds();

    // ONE CLEAR SECOND AFTER THE REPLY IN THE TEST ABOVE, which is what makes
    // the two index assertions at the foot of this test claims about the
    // server's order rather than about a coin (see backlogReplyAt). `max` so
    // this is never dated further ahead than it has to be: about 0.8 s of test
    // usually passes between the two appends, and then this IS the wall clock.
    const liveAt = new Date(Math.max(Date.now(), backlogReplyAt.getTime() + 1_000));
    // Stated rather than trusted. An edit that dates this `new Date()` again
    // fails here, on the header it changed, instead of one run in five on a
    // row order two assertions further down with two UUIDs to compare.
    expect(
      Math.floor(liveAt.getTime() / 1_000),
      "the two live arrivals must not share a clock second: a Date: header is whole seconds, "
      + "and threads that tie on last_message_at are ordered by a random UUID",
    ).toBeGreaterThan(Math.floor(backlogReplyAt.getTime() / 1_000));

    await withImap(async (client) => {
      await client.append(
        INBOX_FOLDER,
        rfc822([
          `From: Helen Late <helen-${attemptTag}@example.com>`,
          `To: Conduit <${USERNAME}>`,
          `Subject: ${liveSubject}`,
          `Message-ID: <late-${attemptTag}@example.com>`,
          `Date: ${liveAt.toUTCString()}`,
          "Content-Type: text/plain; charset=utf-8",
        ], "Something has just come up."),
        [],
        liveAt,
      );
    });

    // NO RELOAD, again: this arriving is the liveness, and the exact wording
    // is the count being right. Not "1+": that suffix is for a page one that
    // is unseen all the way down with more behind it (mail-lib's
    // pendingArrivals), and one arrival among twenty-five listed rows is not.
    const show = page.getByTestId("thread-list-new-show");
    await expect(show).toHaveText("Show 1 new conversation", { timeout: SYNC_TIMEOUT_MS });

    // The reader's list is untouched while that offer stands -- same rows,
    // same order -- and the new conversation is nowhere in it.
    expect(await rowIds()).toEqual(before);
    await expect(threadRow(liveSubject)).toHaveCount(0);

    await show.click();
    await expect(threadRow(liveSubject)).toHaveCount(1);
    const after = await rowIds();
    expect(after[0]).toBe(await threadRow(liveSubject).getAttribute("data-testid"));
    // AND THE ROW FROM THE TEST ABOVE IS NOW SECOND, which is the whole point
    // said backwards: the server has sorted that conversation first since its
    // reply landed, and the list was holding it in place. Asking is what
    // takes the server's order -- the reader's place is lost when they choose
    // to lose it, and not before.
    //
    // BOTH INDICES ARE CLAIMS ABOUT THE SERVER'S ORDER, and are worth making
    // only while that order is determined. What determines it is the clear
    // second between the two `Date:` headers at the top of this test; without
    // it these two threads tie on `last_message_at` and this pair of lines is
    // a coin toss (see backlogReplyAt).
    expect(after[1]).toBe(targetRowId);
    await expect(show).toHaveCount(0);
  });
});
