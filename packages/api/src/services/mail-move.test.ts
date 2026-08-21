import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { bulkThreadResultSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts, mailMessages, mailThreadHides, mailThreads, projects } from "../db/schema.js";
import type { SyncLogger } from "./mail-imap.js";
import { moveThreads, type MoveSyncAccount, type MoveSyncManager } from "./mail-move.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let userId: string;
let actorId: string;
let hints: SseHint[];
let unsubscribe: () => void;

beforeEach(async () => {
  await truncateAll(handle);
  // The account owner. The MOVE tests act as this user because Phase 4.2 made
  // move rights owner-only -- an actor who owns nothing in a thread gets a
  // not_owner skip, and one who cannot SEE it gets the nonexistent-id answer
  // (see the service's VISIBILITY FIRST, OWNERSHIP SECOND header).
  userId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  // A second user, for the other side of those rules: the hide tests make sam
  // a viewer (hide stays available to every viewer of a visible thread), and
  // the visibility/ownership tests act as sam against chris's accounts.
  actorId = (await resolveUser(handle.db, { username: "sam", email: null, fullName: null })).id;
  hints = [];
  unsubscribe = subscribe((hint) => { hints.push(hint); });
});

afterEach(() => { unsubscribe(); });

afterAll(async () => { await handle.close(); });

const silentLogger: SyncLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface LogLine {
  details: Record<string, unknown>;
  message: string;
}

/** Keeps what the service logged, for the paths whose whole point IS the log
 * line: the unrecoverable-divergence error, and the summary counts. */
class RecordingLogger implements SyncLogger {
  readonly infos: LogLine[] = [];
  readonly warns: LogLine[] = [];
  readonly errors: LogLine[] = [];

  info(details: Record<string, unknown>, message: string): void { this.infos.push({ details, message }); }
  warn(details: Record<string, unknown>, message: string): void { this.warns.push({ details, message }); }
  error(details: Record<string, unknown>, message: string): void { this.errors.push({ details, message }); }
}

// --- Fixtures ---------------------------------------------------------------

/** One account per call, with its own address: mail_accounts is UNIQUE on
 * (user_id, lower(email)) among active rows, so the two-account tests below
 * cannot share one. */
let accountSeq = 0;

async function makeAccount(
  overrides: Partial<typeof mailAccounts.$inferInsert> = {},
): Promise<string> {
  accountSeq += 1;
  const [account] = await handle.db.insert(mailAccounts).values({
    userId, label: "Work", email: `chris+${accountSeq}@example.com`,
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
    username: "chris", credentialsCiphertext: "v1:iv:tag:data",
    sentFolder: "Sent", trashFolder: "Trash", archiveFolder: "Archive",
    ...overrides,
  }).returning();
  return account!.id;
}

async function makeThread(subject = "Hello"): Promise<string> {
  const [thread] = await handle.db.insert(mailThreads)
    .values({ subject, lastMessageAt: new Date("2026-08-19T09:00:00.000Z") }).returning();
  return thread!.id;
}

/**
 * Zero-padded into the Message-ID below, so ordering rows by message_id is
 * insertion order -- what every assertion here reads. An unpadded counter sorts
 * "m10" before "m9" and quietly reorders the expectations.
 *
 * FOUR DIGITS is the bound, shared with the bulk fixture's own "bulk%04d" ids:
 * the counter never resets (it is module-level, while the tables are truncated
 * per test), so a file that grew past 9,999 messages would start overflowing
 * the padding and reintroduce exactly the mis-ordering it prevents. Widen both
 * if that day comes; today the whole file inserts a few hundred.
 */
let messageSeq = 0;

async function makeMessage(input: {
  threadId: string; accountId: string; folder: string; imapUid: number | null; seen?: boolean;
}): Promise<string> {
  messageSeq += 1;
  const [message] = await handle.db.insert(mailMessages).values({
    accountId: input.accountId, threadId: input.threadId,
    messageId: `m${String(messageSeq).padStart(4, "0")}@example.com`,
    fromAddr: "alice@example.com", toAddrs: [{ address: "chris@example.com" }],
    sentAt: new Date("2026-08-19T09:00:00.000Z"),
    folder: input.folder, imapUid: input.imapUid, direction: "inbound",
    seen: input.seen ?? false,
  }).returning();
  return message!.id;
}

async function messageRows(threadId?: string) {
  const rows = await handle.db.select({
    id: mailMessages.id, threadId: mailMessages.threadId, folder: mailMessages.folder,
    imapUid: mailMessages.imapUid, accountId: mailMessages.accountId, seen: mailMessages.seen,
  }).from(mailMessages).orderBy(asc(mailMessages.messageId));
  return threadId === undefined ? rows : rows.filter((row) => row.threadId === threadId);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One user's hide row for a thread, or undefined (Phase 4.3: `hide` writes
 * mail_thread_hides for the ACTOR alone -- what these tests assert instead
 * of the retired thread-global column). */
async function hideRowFor(threadId: string, forUserId: string) {
  const [row] = await handle.db.select().from(mailThreadHides).where(
    and(eq(mailThreadHides.threadId, threadId), eq(mailThreadHides.userId, forUserId)),
  );
  return row;
}

function threadHints(): SseHint[] {
  return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-threads"));
}

// --- The sync seam ----------------------------------------------------------

interface MoveCall {
  folder: string;
  uids: number[];
  targetFolder: string;
}

/**
 * One account's queued-move seam. Records every call, and can fail a chosen
 * one -- which is how the compensation and the partial-chunk case are driven
 * without a mail server.
 */
class FakeSync implements MoveSyncAccount {
  readonly calls: MoveCall[] = [];
  /** Thrown by every call while set. */
  error: Error | null = null;
  /** 1-based index of the single call that should fail, or null. */
  failCall: number | null = null;
  failError = new Error("MOVE from INBOX to Archive was refused");
  /** While set, every call parks on this after recording itself -- which is
   * how two bulk requests can be held in flight at once. */
  gate: Promise<void> | null = null;

  async moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void> {
    const call = this.calls.push({ folder, uids: [...uids], targetFolder });
    if (this.gate !== null) await this.gate;
    if (this.error !== null) throw this.error;
    if (this.failCall === call) throw this.failError;
  }
}

class FakeManager implements MoveSyncManager {
  readonly syncs = new Map<string, FakeSync>();

  for(accountId: string): FakeSync {
    const existing = this.syncs.get(accountId);
    if (existing !== undefined) return existing;
    const created = new FakeSync();
    this.syncs.set(accountId, created);
    return created;
  }

  get(accountId: string): FakeSync | undefined {
    return this.syncs.get(accountId);
  }
}

function deps(syncManager: MoveSyncManager | null) {
  return { syncManager, logger: silentLogger };
}

// --- Folder-scoped vs whole-thread ------------------------------------------

describe("moveThreads: the two modes", () => {
  it("moves only the messages in the view folder when one is given", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 11 });
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 12 });
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 13 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // The selection-granularity ruling: a bulk action from the INBOX view acts
    // on what the user could actually see and tick, not on the whole
    // conversation.
    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [11], targetFolder: "Archive" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Sent", 12], ["Clients", 13]]);
  });

  it("moves the whole thread except Sent and anything already in the target when no folder is given", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 21 });
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 22 });
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 23 });
    await makeMessage({ threadId, accountId, folder: "Archive", imapUid: 24 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    // One queued call per SOURCE folder, because that is the mailbox the
    // server has to SELECT. Sent is carved out -- archiving a conversation
    // must never empty it -- and the message already in Archive is nothing to
    // do rather than a move onto itself.
    expect(sync.calls).toEqual([
      { folder: "INBOX", uids: [21], targetFolder: "Archive" },
      { folder: "Clients", uids: [23], targetFolder: "Archive" },
    ]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Sent", 22], ["Archive", null], ["Archive", 24]]);
  });

  it("keeps the Sent carve-out out of the folder-scoped mode", async () => {
    // A user looking AT the Sent folder and trashing a message means it. The
    // carve-out exists for the whole-thread buttons, which the user pressed
    // somewhere else entirely.
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 31 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "Sent", action: "trash" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "Sent", uids: [31], targetFolder: "Trash" }]);
  });

  it("matches the view folder on the IMAP case rule, not byte for byte", async () => {
    // INBOX is the one mailbox name RFC 3501 makes case-insensitive, so a view
    // of "inbox" IS the folder the message is stored under -- while "Clients"
    // and "clients" stay two different mailboxes.
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 191 });
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 192 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const matched = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "inbox", action: "archive" }, deps(manager),
    );
    expect(matched.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [191], targetFolder: "Archive" }]);

    // The other half of the same rule: a differently-cased ordinary folder
    // matches nothing, so the action is a no-op rather than a wrong move.
    const missed = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "clients", action: "archive" }, deps(manager),
    );
    // Nothing of this thread was in the named view, so the action never
    // applied to it -- which is its own reason, not "already done".
    expect(missed.results).toEqual([{ threadId, ok: true, skipped: true, reason: "out_of_scope" }]);
    expect(sync.calls).toHaveLength(1);
    expect((await messageRows(threadId))[1]).toMatchObject({ folder: "Clients", imapUid: 192 });
  });

  it("trims the account's stored folder names before comparing or targeting", async () => {
    // A stored " Sent " must not become a second mailbox: untrimmed, the
    // carve-out would miss and the conversation's Sent copy would be archived
    // -- and the MOVE would name a mailbox no server has.
    const accountId = await makeAccount({ sentFolder: "  Sent  ", archiveFolder: "  Archive  " });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 201 });
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 202 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [201], targetFolder: "Archive" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Sent", 202]]);
  });

  it("never touches `seen`, in either direction", async () => {
    // Trashing an unread message does not mark it read -- it is unread mail
    // that now lives in the Trash. The unread BADGE stops counting it, but
    // that is the counting's job (Task 4 excludes each account's trash_folder
    // from the unread queries, per the coordinator's ruling), never a flag
    // this service writes behind the user's back.
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 211, seen: false });
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 212, seen: true });
    const manager = new FakeManager();
    manager.for(accountId);

    await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "trash" }, deps(manager),
    );

    expect((await messageRows(threadId)).map((row) => [row.folder, row.seen]))
      .toEqual([["Trash", false], ["Trash", true]]);
  });

  it("sends trash to trash_folder and archive to archive_folder", async () => {
    const accountId = await makeAccount({ trashFolder: "Deleted Items", archiveFolder: "All Mail" });
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 41 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 42 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    await moveThreads(handle.db, userId, { threadIds: [first], folder: "INBOX", action: "trash" }, deps(manager));
    await moveThreads(handle.db, userId, { threadIds: [second], folder: "INBOX", action: "archive" }, deps(manager));

    // The account's own names, whatever they are -- the CRM never guesses
    // "Trash" or "Archive" (spec: only Trash/Archive targets, resolved per
    // account).
    expect(sync.calls.map((call) => call.targetFolder)).toEqual(["Deleted Items", "All Mail"]);
    expect((await messageRows(first))[0]?.folder).toBe("Deleted Items");
    expect((await messageRows(second))[0]?.folder).toBe("All Mail");
  });
});

// --- Nothing to move --------------------------------------------------------

describe("moveThreads: nothing to move", () => {
  it("skips a thread whose eligible messages all await reconciliation", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    // A just-sent message the Sent pass has not re-sighted yet: no UID, so
    // there is no way to name it to the server.
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: null });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // A successful no-op, not a failure: it self-heals the moment the next
    // pass fills the UID in and the user asks again -- which is what the
    // reason code tells a client, so it can say so rather than guessing.
    expect(result.results).toEqual([
      { threadId, ok: true, skipped: true, reason: "awaiting_reconciliation" },
    ]);
    expect(sync.calls).toEqual([]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: null });
    expect(threadHints()).toHaveLength(0);
  });

  it("skips a thread that has no message in the view folder at all", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 51 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "out_of_scope" }]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "Clients", imapUid: 51 });
  });

  it("reports an unknown thread as a failure and still moves the rest", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 61 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    const missing = "00000000-0000-4000-8000-000000000000";

    const result = await moveThreads(
      handle.db, userId, { threadIds: [missing, threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([
      {
        threadId: missing, ok: false, reason: "not_found",
        error: "mail thread 00000000-0000-4000-8000-000000000000 not found",
      },
      { threadId, ok: true },
    ]);
    expect(sync.calls).toHaveLength(1);
  });

  it("answers once per REQUESTED id, in order, duplicates included", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 71 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId, threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // The response is a per-request answer the client zips back onto rows, so
    // a repeated id gets a repeated entry -- but its messages move ONCE.
    expect(result.results).toEqual([{ threadId, ok: true }, { threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [71], targetFolder: "Archive" }]);
  });

  it("produces results the shared bulk contract accepts, all three shapes at once", async () => {
    const accountId = await makeAccount();
    const moved = await makeThread("moved");
    const stalled = await makeThread("stalled");
    await makeMessage({ threadId: moved, accountId, folder: "INBOX", imapUid: 72 });
    await makeMessage({ threadId: stalled, accountId, folder: "INBOX", imapUid: null });
    const manager = new FakeManager();
    manager.for(accountId);
    const missing = "00000000-0000-4000-8000-000000000002";

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [moved, stalled, missing], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // The two correlations bulkThreadResultItemSchema enforces structurally --
    // `error` iff !ok, and `skipped` only alongside ok -- are the ones this
    // service has to satisfy for the route to be able to return its output
    // unchanged.
    expect(bulkThreadResultSchema.parse(result)).toEqual(result);
    expect(result.results.map((item) => [item.ok, item.skipped ?? false, item.error !== undefined]))
      .toEqual([[true, false, false], [true, true, false], [false, false, true]]);
  });
});

// --- Per-account resolution -------------------------------------------------

describe("moveThreads: per account", () => {
  it("fails only the threads of an account with no resolved target", async () => {
    const withTarget = await makeAccount();
    const without = await makeAccount({ label: "Personal", archiveFolder: null });
    const good = await makeThread("good");
    const bad = await makeThread("bad");
    await makeMessage({ threadId: good, accountId: withTarget, folder: "INBOX", imapUid: 81 });
    await makeMessage({ threadId: bad, accountId: without, folder: "INBOX", imapUid: 82 });
    const manager = new FakeManager();
    manager.for(withTarget);
    const idleSync = manager.for(without);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [good, bad], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // NULL means "nothing has ever classified one", which is a sentence the
    // user can act on -- never a guessed folder name.
    expect(result.results[0]).toEqual({ threadId: good, ok: true });
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.error).toContain('account "Personal" has no Archive folder yet');
    expect(idleSync.calls).toEqual([]);
    expect((await messageRows(bad))[0]).toMatchObject({ folder: "INBOX", imapUid: 82 });
    expect((await messageRows(good))[0]).toMatchObject({ folder: "Archive", imapUid: null });
  });

  it("does not fail a thread when the refusing account had nothing in scope anyway", async () => {
    // The refusal is a statement about messages this action WOULD have moved.
    // Account B cannot move -- but its only message in this thread sits
    // outside the view folder, so the user's INBOX archive has nothing to do
    // with it, and failing the thread would be a report about a mailbox they
    // were not acting on.
    const good = await makeAccount();
    const stuck = await makeAccount({ label: "Personal", archiveFolder: null });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: good, folder: "INBOX", imapUid: 151 });
    await makeMessage({ threadId, accountId: stuck, folder: "Clients", imapUid: 152 });
    const manager = new FakeManager();
    const sync = manager.for(good);
    manager.for(stuck);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [151], targetFolder: "Archive" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Clients", 152]]);
  });

  it("never fails a thread for an ARCHIVED account's rows, so its live half still archives", async () => {
    // Archiving a mail account keeps its messages (archive-not-delete) while
    // its sync loop stays torn down until someone unarchives it. Reporting
    // those rows as a failure would fail every thread carrying one for a
    // reason nothing in the mail view connects to, or can act on -- the remedy
    // is in Settings.
    const live = await makeAccount();
    const gone = await makeAccount({ label: "Old" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: live, folder: "INBOX", imapUid: 161 });
    await makeMessage({ threadId, accountId: gone, folder: "INBOX", imapUid: 162 });
    await handle.db.update(mailAccounts)
      .set({ archivedAt: new Date("2026-08-01T00:00:00.000Z") }).where(eq(mailAccounts.id, gone));
    // The manager knows nothing about it, exactly as SyncManager does not
    // after tearing an archived account's loop down.
    const manager = new FakeManager();
    const sync = manager.for(live);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [161], targetFolder: "Archive" }]);
    // The archived account's row keeps its folder and UID: excluded, not moved
    // and not reverted.
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["INBOX", 162]]);
  });

  it("skips a thread whose whole in-scope set sits on an archived account", async () => {
    const gone = await makeAccount({ label: "Old" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: gone, folder: "INBOX", imapUid: 171 });
    await handle.db.update(mailAccounts)
      .set({ archivedAt: new Date("2026-08-01T00:00:00.000Z") }).where(eq(mailAccounts.id, gone));
    const manager = new FakeManager();

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // Same shape as a thread awaiting reconciliation: nothing eligible, so a
    // successful no-op rather than an error the user cannot clear -- but its
    // OWN reason code, because this one is fixed in Settings (unarchive the
    // account) rather than by waiting, and only the code can say which.
    expect(result.results).toEqual([
      { threadId, ok: true, skipped: true, reason: "archived_account" },
    ]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 171 });
    expect(threadHints()).toHaveLength(0);
  });

  it("fails an account with no running sync loop, and writes nothing for it", async () => {
    const accountId = await makeAccount({ label: "Personal" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 91 });
    // A manager that knows nothing about this account: sync disabled, or the
    // loop not started yet.
    const manager = new FakeManager();

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // Moving the rows with nothing to carry the MOVE out would leave the CRM
    // showing a folder the message never reached, and NOTHING would ever
    // correct it -- the source folder's cursor is already past it.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toContain("mail sync is not running");
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 91 });
    expect(threadHints()).toHaveLength(0);
  });

  it("fails a thread whose in-scope messages span a ready and a refused account", async () => {
    // Both halves are in the view folder this time, so the refusal really does
    // apply to something the action would have moved. Failure wins for the
    // thread -- and the half that DID move stays moved, because there is no
    // un-MOVE and the database now agrees with that server.
    const ready = await makeAccount();
    const stuck = await makeAccount({ label: "Personal", archiveFolder: null });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: ready, folder: "INBOX", imapUid: 221 });
    await makeMessage({ threadId, accountId: stuck, folder: "INBOX", imapUid: 222 });
    const manager = new FakeManager();
    const sync = manager.for(ready);
    manager.for(stuck);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toContain('account "Personal" has no Archive folder yet');
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [221], targetFolder: "Archive" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["INBOX", 222]]);
  });

  it("groups one thread's messages by account, each with its own target and loop", async () => {
    // A conversation both accounts are on -- one thread, messages on two
    // mailboxes (mail_threads is global; the account lives on the message).
    const work = await makeAccount({ archiveFolder: "Archive" });
    const personal = await makeAccount({ label: "Personal", archiveFolder: "All Mail" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: work, folder: "INBOX", imapUid: 101 });
    await makeMessage({ threadId, accountId: personal, folder: "INBOX", imapUid: 102 });
    const manager = new FakeManager();
    const workSync = manager.for(work);
    const personalSync = manager.for(personal);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    // Each account's own loop, under its own credentials, to its own target.
    expect(workSync.calls).toEqual([{ folder: "INBOX", uids: [101], targetFolder: "Archive" }]);
    expect(personalSync.calls).toEqual([{ folder: "INBOX", uids: [102], targetFolder: "All Mail" }]);
    expect((await messageRows(threadId)).map((row) => row.folder)).toEqual(["Archive", "All Mail"]);
  });
});

// --- Optimistic write and compensation --------------------------------------

describe("moveThreads: compensation", () => {
  it("publishes the thread's keys once the optimistic rows are committed", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 111 });
    const manager = new FakeManager();
    manager.for(accountId);

    await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "trash" }, deps(manager),
    );

    // One publish carrying every key, after the commit: the list (folder
    // membership changed), the thread itself, and the unread count (a message
    // moved into an unsynced Trash leaves the counted set).
    const published = threadHints();
    expect(published).toHaveLength(1);
    expect(published[0]?.keys).toEqual([["mail-threads"], ["mail-unread"], ["mail-thread", threadId]]);
  });

  it("reverts the rows and fails the thread when the server refuses the move", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 121 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.error = new Error("MOVE from INBOX to Archive was refused");
    const logger = new RecordingLogger();

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      { syncManager: manager, logger },
    );

    // The revert itself must have worked: its failure is logged at error and
    // swallowed, so an empty error log is the proof the rows below came back
    // rather than never having moved.
    expect(logger.errors).toEqual([]);

    // The CRM must never claim a move the server refused: the row goes back
    // exactly as it was, UID included.
    expect(result.results).toEqual([
      { threadId, ok: false, reason: "server_refused", error: "MOVE from INBOX to Archive was refused" },
    ]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 121 });
    // Two hints: the optimistic move, then the revert -- clients holding the
    // optimistic view have to be told it came back.
    expect(threadHints()).toHaveLength(2);
  });

  it("partitions by UID_CHUNK, reverting only the failed chunk and leaving the accepted one moved", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    const rows = Array.from({ length: 600 }, (_, index) => ({
      accountId, threadId,
      messageId: `bulk${String(index + 1).padStart(4, "0")}@example.com`,
      fromAddr: "alice@example.com", toAddrs: [{ address: "chris@example.com" }],
      sentAt: new Date("2026-08-19T09:00:00.000Z"),
      folder: "INBOX", imapUid: index + 1, direction: "inbound",
    }));
    await handle.db.insert(mailMessages).values(rows);
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.failCall = 2;

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // Two commands, not one with 600 UIDs in it.
    expect(sync.calls.map((call) => call.uids.length)).toEqual([500, 100]);
    expect(result.results[0]?.ok).toBe(false);

    const stored = await handle.db.select({ imapUid: mailMessages.imapUid, folder: mailMessages.folder })
      .from(mailMessages).orderBy(asc(mailMessages.messageId));
    // The accepted chunk stays moved -- there is no un-MOVE, and the database
    // agrees with the server. Only the refused chunk goes back.
    expect(stored.slice(0, 500).every((row) => row.folder === "Archive" && row.imapUid === null)).toBe(true);
    expect(stored.slice(500).every((row) => row.folder === "INBOX")).toBe(true);
    expect(stored[500]?.imapUid).toBe(501);
    expect(stored[599]?.imapUid).toBe(600);
  });

  it("logs the affected rows and carries on when the compensating revert itself fails", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 231 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.error = new Error("MOVE from INBOX to Archive was refused");
    const logger = new RecordingLogger();
    // The database goes away between the MOVE's rejection and the revert.
    // revertMove is the only caller of db.execute on this path, so failing it
    // reproduces exactly that window.
    const failingDb = new Proxy(handle.db, {
      get(target, property, receiver: unknown) {
        if (property === "execute") {
          return () => Promise.reject(new Error("connection terminated unexpectedly"));
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await moveThreads(
      failingDb, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      { syncManager: manager, logger },
    );

    // The thread is reported with the MOVE's failure, not the database's: the
    // compensation is an attempt to clean up after that failure, not a second
    // thing that happened to the user.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toBe("MOVE from INBOX to Archive was refused");
    // Swallowed, so the remaining groups would still have been queued...
    expect(logger.errors).toHaveLength(1);
    // ...but LOUD, because this is the one unrecoverable state: the row now
    // claims a folder the message never reached, and no pass re-sights it (the
    // source folder's cursor is already past that UID). These fields are an
    // operator's only handle on it.
    expect(logger.errors[0]?.message).toContain("could not revert an optimistic move");
    expect(logger.errors[0]?.details).toMatchObject({
      accountId, folder: "INBOX", targetFolder: "Archive",
      messages: 1, messageIds: [messageId],
    });
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "Archive", imapUid: null });
  });

  it("keeps two overlapping bulk actions apart", async () => {
    const accountId = await makeAccount();
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 241 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 242 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    let release = (): void => {};
    sync.gate = new Promise<void>((resolve) => { release = resolve; });

    // Two requests in flight at once -- one archiving, one trashing -- both
    // parked on the seam before either finishes.
    const archiving = moveThreads(
      handle.db, userId, { threadIds: [first], folder: "INBOX", action: "archive" }, deps(manager),
    );
    const trashing = moveThreads(
      handle.db, userId, { threadIds: [second], folder: "INBOX", action: "trash" }, deps(manager),
    );
    await waitFor(() => sync.calls.length === 2, "both moves to reach the sync seam");
    release();
    const [archived, trashed] = await Promise.all([archiving, trashing]);

    // Nothing is shared between two calls: each collected its own rows, its own
    // target and its own outcomes.
    expect(archived.results).toEqual([{ threadId: first, ok: true }]);
    expect(trashed.results).toEqual([{ threadId: second, ok: true }]);
    expect([...sync.calls].sort((a, b) => (a.uids[0] ?? 0) - (b.uids[0] ?? 0))).toEqual([
      { folder: "INBOX", uids: [241], targetFolder: "Archive" },
      { folder: "INBOX", uids: [242], targetFolder: "Trash" },
    ]);
    expect((await messageRows()).map((row) => row.folder)).toEqual(["Archive", "Trash"]);
  });

  it("fails the whole thread when only part of it was refused", async () => {
    // A thread with messages in two source folders: one call succeeds, one is
    // refused. Calling that a success because something worked is exactly the
    // dishonesty the compensation exists to prevent.
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 131 });
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 132 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.failCall = 2;
    sync.failError = new Error("MOVE from Clients to Archive was refused");

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([
      { threadId, ok: false, reason: "server_refused", error: "MOVE from Clients to Archive was refused" },
    ]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Clients", 132]]);
  });
});

// --- The summary log --------------------------------------------------------

describe("moveThreads: the summary line", () => {
  it("counts off the answers, so a wholly failed bulk does not log failed: 0", async () => {
    // Nothing here reaches the queue: one thread is refused at the account
    // level, one id does not exist, and one has only a message awaiting
    // reconciliation. A counter derived from the QUEUE's failures reported
    // `failed: 0` for all of it -- exactly the shape an operator goes looking
    // for after a user says "none of them worked".
    const stuck = await makeAccount({ label: "Personal", archiveFolder: null });
    const ready = await makeAccount();
    const refusedThread = await makeThread("refused");
    const stalledThread = await makeThread("stalled");
    await makeMessage({ threadId: refusedThread, accountId: stuck, folder: "INBOX", imapUid: 251 });
    await makeMessage({ threadId: stalledThread, accountId: ready, folder: "INBOX", imapUid: null });
    const manager = new FakeManager();
    manager.for(stuck);
    manager.for(ready);
    const logger = new RecordingLogger();
    const missing = "00000000-0000-4000-8000-000000000003";

    await moveThreads(
      handle.db, userId,
      { threadIds: [refusedThread, stalledThread, missing], folder: "INBOX", action: "archive" },
      { syncManager: manager, logger },
    );

    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]?.details).toMatchObject({
      actorId: userId, action: "archive", folder: "INBOX",
      threads: 3, messages: 0, failed: 2, skipped: 1,
      // The account that refused something. An account that refuses but has
      // nothing in scope is deliberately not counted here.
      refusedAccounts: 1,
    });
  });
});

// --- Visibility, then ownership (Phase 4.2) ---------------------------------

describe("moveThreads: visibility and ownership", () => {
  it("skips a whole thread the actor can see but does not own, before any refusal can name it", async () => {
    // chris's SHARED account: sam can see the thread (so not_found would be a
    // lie) but owns no message in it (so nothing may move). The manager knows
    // nothing about the account ON PURPOSE -- unowned, that dead loop would
    // have been a no_sync failure naming chris's account, and the ownership
    // drop running before the refusal check is what keeps it out of the
    // answer.
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 301 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "not_owner" }]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 301 });
    expect(threadHints()).toHaveLength(0);
  });

  it("moves only the owned half of a mixed-ownership thread", async () => {
    // One conversation, two mailboxes, two owners. sam's account is SHARED so
    // his half is VISIBLE to chris -- in scope, examined, and dropped by the
    // ownership check specifically (a private foreign half would instead
    // never enter scope at all; the folder-crafted test below pins that).
    const mine = await makeAccount();
    const theirs = await makeAccount({ userId: actorId, label: "Sams", visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: mine, folder: "INBOX", imapUid: 311 });
    await makeMessage({ threadId, accountId: theirs, folder: "INBOX", imapUid: 312 });
    const manager = new FakeManager();
    const mySync = manager.for(mine);
    const theirSync = manager.for(theirs);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // The owned half moves and the thread reports plain success (a move
    // happened; the noted not_owner is only ever the answer when NOTHING
    // moved). The unowned half is untouched in both places: no queued call
    // ever reaches the other user's loop, and its row keeps folder and uid.
    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(mySync.calls).toEqual([{ folder: "INBOX", uids: [311], targetFolder: "Archive" }]);
    expect(theirSync.calls).toEqual([]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["INBOX", 312]]);
  });

  it("reports archived_account, not not_owner, when both are true of the account", async () => {
    // SKIP_REASON_RANK's continuity rule, pinned end to end: an archived
    // account someone else owns keeps saying archived_account, exactly what a
    // mixed thread reported before 4.2 -- which also pins the per-row check
    // order (the archived_account drop runs before the ownership drop).
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 321 });
    await handle.db.update(mailAccounts)
      .set({ archivedAt: new Date("2026-08-01T00:00:00.000Z") }).where(eq(mailAccounts.id, accountId));

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "archived_account" }]);
  });

  it("answers an invisible thread byte-for-byte like a nonexistent one", async () => {
    // The exact leak the 4.2 spec review probed: a private account with NO
    // archive target used to answer no_target, carrying the account's label
    // to a user who may not even know the account exists. Visibility is
    // decided before that account is ever examined, so the label -- and every
    // other fact -- stays out of the answer.
    const accountId = await makeAccount({ label: "Chris private", archiveFolder: null });
    const invisible = await makeThread("private to chris");
    await makeMessage({ threadId: invisible, accountId, folder: "INBOX", imapUid: 331 });
    const manager = new FakeManager();
    manager.for(accountId);
    const missing = "00000000-0000-4000-8000-000000000004";

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [invisible, missing], folder: "INBOX", action: "archive" },
      deps(manager),
    );

    const [gated, unknown] = result.results;
    expect(unknown).toEqual({
      threadId: missing, ok: false, reason: "not_found",
      error: `mail thread ${missing} not found`,
    });
    // Substituting the id is the ONLY thing separating the two serialized
    // answers: same keys, same order, same error text shape.
    expect(JSON.stringify(gated).replaceAll(invisible, missing)).toBe(JSON.stringify(unknown));
    // And nothing about the invisible thread happened: no move, no hint.
    expect((await messageRows(invisible))[0]).toMatchObject({ folder: "INBOX", imapUid: 331 });
    expect(threadHints()).toHaveLength(0);
  });

  it("treats a record-linked private thread as visible, and then refuses it as not_owner", async () => {
    // Visibility and ownership are different answers. A project link makes
    // chris's private conversation record-visible to sam (the gate shares the
    // detail route's scope), so the honest per-thread answer is "not yours to
    // move" -- never the 404 that would deny a thread sam can open.
    const accountId = await makeAccount();
    const [project] = await handle.db.insert(projects).values({ name: "Rollout" }).returning();
    const threadId = await makeThread();
    await handle.db.update(mailThreads)
      .set({ projectId: project!.id }).where(eq(mailThreads.id, threadId));
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 341 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "trash" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "not_owner" }]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 341 });
  });

  it("keeps invisible messages out of scope: a folder holding only foreign private copies is out_of_scope", async () => {
    // Spec Amendment 4 (the D6 ruling). The thread is visible to chris
    // through his own INBOX copy, but sam's PRIVATE copies in "Projects" are
    // not chris's to see -- so a folder-scoped move on Projects answers with
    // chris's own world (nothing of this thread there), never a not_owner
    // that would disclose invisible messages sitting in that folder.
    const mine = await makeAccount();
    const theirs = await makeAccount({ userId: actorId, label: "Sams" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: mine, folder: "INBOX", imapUid: 361 });
    await makeMessage({ threadId, accountId: theirs, folder: "Projects", imapUid: 362 });

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "Projects", action: "archive" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "out_of_scope" }]);
    expect((await messageRows(threadId))[1]).toMatchObject({ folder: "Projects", imapUid: 362 });
  });

  it("reports the viewer's own awaiting_reconciliation, never a foreign invisible copy's not_owner", async () => {
    // The other half of the same ruling: chris's own copy is merely
    // un-re-sighted (NULL uid, self-healing), and sam's private copy must not
    // outrank that with a "not yours" about messages chris cannot see --
    // not_owner (rank 1) would beat awaiting_reconciliation (rank 2) if the
    // invisible row were ever noted.
    const mine = await makeAccount();
    const theirs = await makeAccount({ userId: actorId, label: "Sams" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: mine, folder: "INBOX", imapUid: null });
    await makeMessage({ threadId, accountId: theirs, folder: "INBOX", imapUid: 371 });
    const manager = new FakeManager();
    manager.for(mine);

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([
      { threadId, ok: true, skipped: true, reason: "awaiting_reconciliation" },
    ]);
    expect((await messageRows(threadId))[1]).toMatchObject({ folder: "INBOX", imapUid: 371 });
  });

  it("answers not_owner for a visible unowned message awaiting reconciliation", async () => {
    // The row loop gives each row ONE answer, at the first check that
    // settles it -- and ownership settles this row before its NULL uid is
    // ever consulted, landing where the rank would have anyway (1 beats 2).
    // Reporting awaiting_reconciliation instead would tell the actor to wait
    // for a pass that can never make this mail theirs to move.
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: null });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "not_owner" }]);
  });

  it("answers already_in_target for a visible unowned row already in the foreign target", async () => {
    // The D5 ruling, pinned: the row loop asks "does the goal already hold?"
    // before any ownership question -- a finished answer that needs no rights
    // to be true, and (with invisible rows out of scope) one only ever given
    // about a row the viewer can see. So the per-row order deliberately
    // differs from SKIP_REASON_RANK here: rank 3 wins over rank 1.
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Archive", imapUid: 381 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], action: "archive" }, deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "already_in_target" }]);
  });

  it("gives no ownership answer for an unowned row outside the view folder", async () => {
    // Scope is decided first, unchanged by 4.2: the INBOX view held nothing
    // of this thread, so the action never applied to it -- out_of_scope, not
    // a not_owner statement about a folder the actor was not acting on.
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 351 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" },
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "out_of_scope" }]);
  });
});

// --- Hide in CRM ------------------------------------------------------------

describe("moveThreads: hide", () => {
  it("hides the threads for the ACTOR alone, CRM-side, and touches no mailbox", async () => {
    // Shared account: sam (the actor) is a viewer of these threads, which is
    // what "Hide-in-CRM stays available to every viewer" means -- hide's
    // thread lookup goes through the Phase 4.2 visibility gate.
    const accountId = await makeAccount({ visibility: "shared" });
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 141 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 142 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    // `folder` is supplied and must be ignored: a CRM-side filing act has no
    // concept of an IMAP folder.
    const result = await moveThreads(
      handle.db, actorId, { threadIds: [first, second], folder: "INBOX", action: "hide" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId: first, ok: true }, { threadId: second, ok: true }]);
    // Per-actor (Phase 4.3): sam's hide rows exist, and the mailbox OWNER
    // gets none -- a bulk hide files the actor's own views and nobody else's.
    expect(await hideRowFor(first, actorId)).toBeDefined();
    expect(await hideRowFor(second, actorId)).toBeDefined();
    expect(await hideRowFor(first, userId)).toBeUndefined();
    expect(await hideRowFor(second, userId)).toBeUndefined();
    expect(sync.calls).toEqual([]);
    // Nothing moved: the user's own mail client sees no change at all.
    expect((await messageRows()).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 141], ["INBOX", 142]]);
    // ONE hint for the batch, carrying both threads' keys -- not one publish
    // per thread. At the contract's 200-thread cap that is the difference
    // between one invalidation round and two hundred.
    const published = threadHints();
    expect(published).toHaveLength(1);
    expect(published[0]?.keys).toEqual([
      ["mail-threads"], ["mail-unread"], ["mail-thread", first], ["mail-thread", second],
    ]);
  });

  it("fails an unknown thread and still hides the others", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 151 });
    const missing = "00000000-0000-4000-8000-000000000001";

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [missing, threadId], action: "hide" }, deps(null),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toContain("not found");
    expect(result.results[1]).toEqual({ threadId, ok: true });
    expect(await hideRowFor(threadId, actorId)).toBeDefined();
  });

  // The same NotFoundError, from the same seam (mail-threads' mustGetThread):
  // "a thread the actor cannot see" and "no such thread" are one per-thread
  // failure, indistinguishable by design -- hide never confirms the existence
  // of someone else's private conversation.
  it("fails a thread the actor cannot see exactly like an unknown one", async () => {
    const privateAccount = await makeAccount();
    const invisible = await makeThread("private to chris");
    await makeMessage({ threadId: invisible, accountId: privateAccount, folder: "INBOX", imapUid: 152 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [invisible], action: "hide" }, deps(null),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reason).toBe("not_found");
    expect(result.results[0]?.error).toContain("not found");
    // Nothing was hidden: no hide row was written for anyone.
    expect(await hideRowFor(invisible, actorId)).toBeUndefined();
    expect(await hideRowFor(invisible, userId)).toBeUndefined();
  });
});
