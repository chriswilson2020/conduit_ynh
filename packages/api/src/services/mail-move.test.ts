import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { bulkThreadResultSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import {
  mailAccountFolders, mailAccounts, mailMessages, mailThreadHides, mailThreads, projects,
} from "../db/schema.js";
import type { SyncLogger } from "./mail-imap.js";
import { hideThread, listThreads, unhideThread } from "./mail-threads.js";
import { moveMessages, moveThreads, type MoveSyncAccount, type MoveSyncManager } from "./mail-move.js";
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

/**
 * One row of mail_account_folders -- what `file` resolves its destination
 * against (Phase 4.4). `syncEnabled: false` is the case the filing rule is
 * about, so it is the default here rather than the other way round: a test
 * that wants the already-syncing folder says so.
 */
async function makeFolder(input: {
  accountId: string; folder: string; syncEnabled?: boolean; selectable?: boolean;
}): Promise<void> {
  await handle.db.insert(mailAccountFolders).values({
    accountId: input.accountId, folder: input.folder,
    syncEnabled: input.syncEnabled ?? false, selectable: input.selectable ?? true,
    lastDiscoveredAt: new Date("2026-09-01T09:00:00.000Z"),
  });
}

async function folderRow(accountId: string, folder: string) {
  const [row] = await handle.db.select().from(mailAccountFolders).where(
    and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, folder)),
  );
  return row;
}

/** The mail_threads row itself, for the per-message assertions that a filed
 * message leaves its CONVERSATION untouched -- subject, links and above all
 * last_message_at, since filing is not receiving and nothing about it may
 * reorder the list. */
async function threadRow(threadId: string) {
  const [row] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, threadId));
  return row;
}

/**
 * Does the THREAD LIST show this thread in that folder's view?
 *
 * Asked of listThreads itself rather than of a hand-written EXISTS: the whole
 * question these tests settle is what a user sees after one message is filed
 * out of a conversation, and a re-implementation of the folder filter here
 * could agree with itself while disagreeing with the list.
 */
async function threadIsInFolder(threadId: string, folder: string): Promise<boolean> {
  const { items } = await listThreads(handle.db, userId, { folder });
  return items.some((row) => row.id === threadId);
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
  /**
   * A DIFFERENT error per call, 1-based, for the tests that ask WHICH of
   * several refusals a caller reports. `error` above cannot answer that: it
   * throws one object for every call, so first and last are the same string.
   */
  readonly errorPerCall: (Error | undefined)[] = [];
  /** While set, every call parks on this after recording itself -- which is
   * how two bulk requests can be held in flight at once. */
  gate: Promise<void> | null = null;
  /**
   * Run at the moment the first MOVE is queued, before anything else this call
   * does. The seam for asserting ORDER rather than outcome: a test can read
   * the database as the server sees the request arrive, which is how Phase
   * 4.4's "the sync switch happens before the move" is pinned by observation
   * instead of by argument.
   */
  beforeMove: (() => Promise<void>) | null = null;

  async moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void> {
    const call = this.calls.push({ folder, uids: [...uids], targetFolder });
    if (this.beforeMove !== null) await this.beforeMove();
    if (this.gate !== null) await this.gate;
    const perCall = this.errorPerCall[call - 1];
    if (perCall !== undefined) throw perCall;
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
    // membership changed), the thread itself, the unread count (a message
    // moved into an unsynced Trash leaves the counted set), and -- since
    // Phase 5 put mail on the record timeline -- `events`, because the bulk
    // hide path routes through this same publish and a hidden thread's
    // entries leave that viewer's timelines.
    const published = threadHints();
    expect(published).toHaveLength(1);
    expect(published[0]?.keys).toEqual([["mail-threads"], ["mail-unread"], ["mail-thread", threadId], ["events"]]);
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

  it("reports the FIRST refusal's text when two of one thread's chunks both fail", async () => {
    // Outcomes promises "the FIRST failure's message is the one reported", and
    // until Phase 4.4 this path quietly delivered the LAST one instead: the
    // queue's failures were keyed by THREAD, so a second failing chunk
    // overwrote the first in the map before Outcomes ever saw it. Keying them
    // per MESSAGE (which the per-message path needs anyway) made the promise
    // true, and nothing covered the difference, so this is where it is pinned.
    const accountId = await makeAccount();
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 141 });
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 142 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.errorPerCall.push(
      new Error("first: MOVE from INBOX was refused"),
      new Error("second: MOVE from Clients was refused"),
    );

    const result = await moveThreads(
      handle.db, userId, { threadIds: [threadId], action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{
      threadId, ok: false, reason: "server_refused",
      error: "first: MOVE from INBOX was refused",
    }]);
    // Both chunks were attempted and both were put back, so the thread is
    // exactly where it started.
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 141], ["Clients", 142]]);
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
      ["mail-threads"], ["mail-unread"], ["mail-thread", first], ["mail-thread", second], ["events"],
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

  // The single-thread path's half of the trade hideThreads' header states:
  // hideThread/unhideThread publish only when the actor's hide row was
  // actually WRITTEN or DELETED, so an idempotent no-op costs no client a
  // refetch. (The bulk path deliberately cannot tell and publishes one
  // batch frame either way -- the tests above pin that side.)
  it("publishes one hint per real hide or unhide and none for the idempotent no-ops", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 161 });

    await hideThread(handle.db, actorId, threadId);
    expect(threadHints()).toHaveLength(1);
    await hideThread(handle.db, actorId, threadId);
    expect(threadHints()).toHaveLength(1);

    await unhideThread(handle.db, actorId, threadId);
    expect(threadHints()).toHaveLength(2);
    await unhideThread(handle.db, actorId, threadId);
    expect(threadHints()).toHaveLength(2);
  });
});

// --- Unhide (Phase 4.4) ------------------------------------------------------

describe("moveThreads: unhide", () => {
  it("removes the ACTOR'S OWN hide rows and leaves every other viewer's alone", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 171 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 172 });
    // Both viewers file both threads away; only the actor's filing is undone.
    for (const threadId of [first, second]) {
      await hideThread(handle.db, actorId, threadId);
      await hideThread(handle.db, userId, threadId);
    }
    hints = [];
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [first, second], folder: "INBOX", action: "unhide" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId: first, ok: true }, { threadId: second, ok: true }]);
    expect(await hideRowFor(first, actorId)).toBeUndefined();
    expect(await hideRowFor(second, actorId)).toBeUndefined();
    // The owner's own filing survives: unhiding is per-actor exactly as hiding is.
    expect(await hideRowFor(first, userId)).toBeDefined();
    expect(await hideRowFor(second, userId)).toBeDefined();
    // No mailbox is touched, and `folder` is ignored -- the CRM-side pair has
    // no concept of an IMAP folder in either direction.
    expect(sync.calls).toEqual([]);
    expect((await messageRows()).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 171], ["INBOX", 172]]);
    // ONE hint for the batch, carrying both threads' keys, symmetric with hide.
    const published = threadHints();
    expect(published).toHaveLength(1);
    expect(published[0]?.keys).toEqual([
      ["mail-threads"], ["mail-unread"], ["mail-thread", first], ["mail-thread", second], ["events"],
    ]);
  });

  it("reports a thread that was never hidden as an ordinary success", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 173 });

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], action: "unhide" }, deps(null),
    );

    // Idempotent, and NOT a skip: the state the caller asked for holds, and
    // mail-threads' setHidden reports the thread either way.
    expect(result.results).toEqual([{ threadId, ok: true }]);
  });

  it("fails an unknown thread and still unhides the others", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 174 });
    await hideThread(handle.db, actorId, threadId);
    const missing = "00000000-0000-4000-8000-000000000002";

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [missing, threadId], action: "unhide" }, deps(null),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reason).toBe("not_found");
    expect(result.results[1]).toEqual({ threadId, ok: true });
    expect(await hideRowFor(threadId, actorId)).toBeUndefined();
  });

  // The same indistinguishable answer hide gives: unhiding an id the actor
  // cannot see must not confirm that it names anything.
  it("fails a thread the actor cannot see exactly like an unknown one", async () => {
    const privateAccount = await makeAccount();
    const invisible = await makeThread("private to chris");
    await makeMessage({ threadId: invisible, accountId: privateAccount, folder: "INBOX", imapUid: 175 });
    await hideThread(handle.db, userId, invisible);

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [invisible], action: "unhide" }, deps(null),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reason).toBe("not_found");
    // And the owner's filing is untouched -- nothing was written or removed.
    expect(await hideRowFor(invisible, userId)).toBeDefined();
  });
});

// --- File into an arbitrary folder (Phase 4.4) -------------------------------

describe("moveThreads: file", () => {
  it("moves the view folder's messages into the folder the REQUEST names", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 201 });
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 202 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // `folder` is the SOURCE and `targetFolder` the DESTINATION: 4.3's
    // folder-scoped ruling still applies, so only the INBOX copy moves, and it
    // moves to the folder this request named rather than to any account column.
    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [201], targetFolder: "Clients" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Clients", null], ["Sent", 202]]);
  });

  it("files the whole thread except Sent when no source folder is given", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 211 });
    await makeMessage({ threadId, accountId, folder: "Archive", imapUid: 212 });
    await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 213 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // Whole-thread mode's Sent carve-out holds for `file` too: filing a
    // conversation away must not empty the Sent folder any more than
    // archiving one may.
    expect(sync.calls).toEqual([
      { folder: "INBOX", uids: [211], targetFolder: "Clients" },
      { folder: "Archive", uids: [212], targetFolder: "Clients" },
    ]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Clients", null], ["Clients", null], ["Sent", 213]]);
  });

  it("skips a message already sitting in the destination", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 221 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { threadId, ok: true, skipped: true, reason: "already_in_target" },
    ]);
    expect(sync.calls).toEqual([]);
  });

  // ---- The filing rule: an unsynced destination is SWITCHED ON --------------

  it("turns the destination folder's sync ON, and says so in the response", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 231 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // Not a warning and not a refusal: the move went through AND the folder is
    // now synced. Filing into a folder IS the statement that the folder
    // matters (see the service header for the rejected warn-instead design).
    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect((await folderRow(accountId, "Clients"))?.syncEnabled).toBe(true);
    // Said afterwards, quietly: enabling a sync is a real consequence and the
    // client renders this as a note beside the summary.
    expect(result.syncEnabled).toBe("Clients");
  });

  it("says nothing when the destination was already syncing", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 241 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // The notification exists because a sync was SWITCHED, not because one is
    // on. A message about a folder that was already syncing would be noise
    // attached to every ordinary filing.
    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect("syncEnabled" in result).toBe(false);
  });

  // INBOX and the account's Sent folder are always walked, and
  // setFolderSyncEnabled refuses to toggle either IN BOTH DIRECTIONS -- so a
  // filing rule that asked it to would turn "move this back to my Inbox" into
  // a 409. The locked check is what keeps that from happening.
  it("files into a LOCKED folder without trying to toggle its sync", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "INBOX", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "Archive", imapUid: 251 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "Archive", targetFolder: "INBOX", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "Archive", uids: [251], targetFolder: "INBOX" }]);
    // No toggle was attempted, so no ConflictError took the whole request with
    // it -- and nothing claims to have switched anything on.
    expect("syncEnabled" in result).toBe(false);
  });

  it("does not switch sync on for an account that filed nothing", async () => {
    // Two accounts, both with an unsynced "Clients". Only the first has a
    // message in the source folder, so only the first files anything.
    const filing = await makeAccount({ label: "Filing" });
    const bystander = await makeAccount({ label: "Bystander" });
    await makeFolder({ accountId: filing, folder: "Clients", syncEnabled: false });
    await makeFolder({ accountId: bystander, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId: filing, folder: "INBOX", imapUid: 261 });
    await makeMessage({ threadId, accountId: bystander, folder: "Archive", imapUid: 262 });
    const manager = new FakeManager();
    manager.for(filing);
    manager.for(bystander);

    await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // The rule is "filing into a folder turns its sync on". The bystander
    // account filed nothing -- its only message was outside the view folder --
    // so turning its Clients on would be bandwidth spent for a cause that
    // never happened.
    expect((await folderRow(filing, "Clients"))?.syncEnabled).toBe(true);
    expect((await folderRow(bystander, "Clients"))?.syncEnabled).toBe(false);
  });

  // THE TWO-SYSTEM WRITE, pinned by observation rather than by argument: the
  // fake reads the folder row from inside moveMessages, so this asserts the
  // ORDER of the local switch and the server MOVE, not merely their outcomes.
  // Enabling after a successful move would leave the failure mode the whole
  // rule exists to prevent -- mail filed into a folder Conduit does not watch.
  it("switches the sync on BEFORE the server move is queued", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 271 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    let syncedWhenMoved: boolean | undefined;
    sync.beforeMove = async () => {
      syncedWhenMoved = (await folderRow(accountId, "Clients"))?.syncEnabled;
    };

    await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(syncedWhenMoved).toBe(true);
  });

  it("leaves the sync ON when the server then refuses the move", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 281 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.error = new Error("MOVE from INBOX to Clients was refused");

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // The reachable half of the two-system write, and it is the harmless
    // half: a folder syncing that need not be, undone with one click in the
    // picker. The message itself is compensated back exactly as any refused
    // move is, so nothing claims a move the server refused.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reason).toBe("server_refused");
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 281]]);
    expect((await folderRow(accountId, "Clients"))?.syncEnabled).toBe(true);
    expect(result.syncEnabled).toBe("Clients");
  });

  // ---- Destinations this account cannot take -------------------------------

  it("fails a destination the account has no folder for, and moves nothing", async () => {
    const accountId = await makeAccount({ label: "Work" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 291 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results[0]?.ok).toBe(false);
    // Its own reason, NOT no_target: the remedy is to pick a different folder
    // or make that one in a mail client, and no_target's sentence would send
    // the user to a Settings page that cannot help.
    expect(result.results[0]?.reason).toBe("unknown_target");
    expect(result.results[0]?.error).toContain("Work");
    expect(result.results[0]?.error).toContain("Clients");
    expect(sync.calls).toEqual([]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 291]]);
  });

  it("fails a \\Noselect destination BEFORE the optimistic write", async () => {
    const accountId = await makeAccount({ label: "Work" });
    await makeFolder({ accountId, folder: "Projects", syncEnabled: false, selectable: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 301 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Projects", action: "file" },
      deps(manager),
    );

    // A hierarchy node holds no messages, so the server would refuse the MOVE
    // and the compensation would put the row back -- honest, but only after a
    // write, a round trip and a revert, reported in the server's words. And
    // setFolderSyncEnabled refuses an unselectable folder, so the filing rule
    // would have 409'd the whole request first.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.reason).toBe("unknown_target");
    expect(result.results[0]?.error).toContain("Noselect");
    expect(sync.calls).toEqual([]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 301]]);
    expect((await folderRow(accountId, "Projects"))?.syncEnabled).toBe(false);
  });

  it("files on the accounts that have the folder and refuses only the ones that do not", async () => {
    const has = await makeAccount({ label: "Has it" });
    const lacks = await makeAccount({ label: "Lacks it" });
    await makeFolder({ accountId: has, folder: "Clients", syncEnabled: true });
    const filed = await makeThread("filed");
    const refused = await makeThread("refused");
    await makeMessage({ threadId: filed, accountId: has, folder: "INBOX", imapUid: 311 });
    await makeMessage({ threadId: refused, accountId: lacks, folder: "INBOX", imapUid: 312 });
    const manager = new FakeManager();
    const good = manager.for(has);
    const bad = manager.for(lacks);

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [filed, refused], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    // The partial-success shape the bulk contract already promises: one
    // account's missing folder must not cost the other account its filing.
    expect(result.results[0]).toEqual({ threadId: filed, ok: true });
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.reason).toBe("unknown_target");
    expect(good.calls).toEqual([{ folder: "INBOX", uids: [311], targetFolder: "Clients" }]);
    expect(bad.calls).toEqual([]);
  });

  it("refuses a folder whose name differs only in case, rather than matching it loosely", async () => {
    const accountId = await makeAccount({ label: "Work" });
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 321 });

    const result = await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "clients", action: "file" },
      deps(new FakeManager()),
    );

    // An IMAP mailbox name is compared byte for byte everywhere downstream
    // (shared: folderNameSchema), and this mutation decides which mailbox a
    // user's mail lands in. A fuzzy match here would file into a folder the
    // request did not name.
    expect(result.results[0]?.reason).toBe("unknown_target");
  });

  it("keeps the owner-only move rule: a message on someone else's account is skipped", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 331 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    // sam can SEE the shared account's thread and cannot move its mail.
    const result = await moveThreads(
      handle.db, actorId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "not_owner" }]);
    expect(sync.calls).toEqual([]);
    // And nothing was filed, so nothing turned a sync on in someone else's
    // mailbox -- the ownership drop runs before any of this.
    expect((await folderRow(accountId, "Clients"))?.syncEnabled).toBe(false);
  });

  // The ownership-before-refusal ordering, restated for `file` because its
  // refusal says MORE than the other two do: unknown_target's sentence names
  // the account's label AND asserts which folders that mailbox does not have.
  // Given about a mailbox the actor has no rights over, that is a fact about
  // someone else's folder tree, arrived at by ticking a row. The row loop
  // settles ownership first, so the refusal never fires for an unowned
  // account; this is the test that says so rather than leaving it to the
  // reading order.
  it("never names an unowned account's missing folder -- ownership answers first", async () => {
    const accountId = await makeAccount({ visibility: "shared", label: "Chris's mailbox" });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 351 });

    const result = await moveThreads(
      handle.db, actorId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      deps(new FakeManager()),
    );

    // The account genuinely has no "Clients" row, so the refusal WOULD fire on
    // an owned account -- which is what makes this discriminating rather than
    // vacuous (the test above, with the folder present, cannot tell the
    // orderings apart).
    expect(result.results).toEqual([{ threadId, ok: true, skipped: true, reason: "not_owner" }]);
    expect(JSON.stringify(result)).not.toContain("Chris's mailbox");
    expect(JSON.stringify(result)).not.toContain("Clients");
  });

  it("records the destination and the sync switch on the summary line", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 341 });
    const manager = new FakeManager();
    manager.for(accountId);
    const logger = new RecordingLogger();

    await moveThreads(
      handle.db, userId,
      { threadIds: [threadId], folder: "INBOX", targetFolder: "Clients", action: "file" },
      { syncManager: manager, logger },
    );

    // The one thing this endpoint does that OUTLIVES the request, so an
    // operator asking later why Conduit started walking Clients finds it in
    // the journal rather than in a bandwidth graph.
    const [line] = logger.infos;
    expect(line?.details).toMatchObject({
      action: "file", folder: "INBOX", targetFolder: "Clients", syncEnabled: "Clients",
    });
  });
});

// --- Per-message selection (Phase 4.4 Task 2) -------------------------------

describe("moveMessages: what a message id names", () => {
  it("files ONE message out of a thread and leaves every other message where it was", async () => {
    // The whole point of the second entry point. The thread is untouched: its
    // other messages keep their folder and uid, and the row itself keeps its
    // subject and last_message_at -- filing is not receiving, so nothing about
    // this reorders the list.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread("Quarterly review");
    const filed = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 401 });
    await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 402 });
    const before = await threadRow(threadId);
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [filed], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{ messageId: filed, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [401], targetFolder: "Clients" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Clients", null], ["INBOX", 402]]);
    // THE THREAD SURVIVES INTACT. What the list shows for it now follows the
    // existing folder rule -- a thread is "in" a folder when any of its
    // messages is -- so it stays in the INBOX view (message 402 is still
    // there) AND joins the Clients view. Listed in both at once, which is what
    // a conversation spread across two mailboxes honestly is.
    expect(await threadRow(threadId)).toEqual(before);
  });

  it("leaves the source folder's view only when the filed message was its last one", async () => {
    // The other half of the same rule, asserted on the EXISTS the thread list
    // actually uses rather than on prose about it.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const only = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 411 });
    const manager = new FakeManager();
    manager.for(accountId);

    expect(await threadIsInFolder(threadId, "INBOX")).toBe(true);
    await moveMessages(
      handle.db, userId, { messageIds: [only], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(await threadIsInFolder(threadId, "INBOX")).toBe(false);
    expect(await threadIsInFolder(threadId, "Clients")).toBe(true);
    // And the thread row itself is still there: nothing about filing its last
    // INBOX message deletes a conversation.
    expect(await threadRow(threadId)).toBeDefined();
  });

  it("answers two messages of ONE thread independently", async () => {
    // The case a threadId-keyed result cannot express, and therefore the
    // reason this response is keyed on messageId at all: one moves, one is
    // already where it was going.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const moving = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 421 });
    const settled = await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 422 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId,
      { messageIds: [moving, settled], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId: moving, ok: true },
      { messageId: settled, ok: true, skipped: true, reason: "already_in_target" },
    ]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [421], targetFolder: "Clients" }]);
  });

  it("moves a message OUT OF SENT when it was named by id", async () => {
    // The deliberate difference from whole-thread mode, which excludes Sent so
    // that archiving a CONVERSATION cannot empty it. Ticking one message you
    // sent and filing it is an instruction about that message; carving it out
    // would silently refuse the thing the user pointed at.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const sent = await makeMessage({ threadId, accountId, folder: "Sent", imapUid: 431 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [sent], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{ messageId: sent, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "Sent", uids: [431], targetFolder: "Clients" }]);
  });

  it("takes messages from several folders and several threads in one request", async () => {
    // There is no view folder to be scoped to, so nothing here is filtered by
    // where the messages happen to sit -- the ids ARE the scope.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const first = await makeThread("one");
    const second = await makeThread("two");
    const a = await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 441 });
    const b = await makeMessage({ threadId: second, accountId, folder: "Archive", imapUid: 442 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [a, b], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{ messageId: a, ok: true }, { messageId: b, ok: true }]);
    expect(sync.calls).toEqual([
      { folder: "INBOX", uids: [441], targetFolder: "Clients" },
      { folder: "Archive", uids: [442], targetFolder: "Clients" },
    ]);
  });

  it("sends trash and archive to the account's own columns, exactly as the thread path does", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread();
    const toTrash = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 451 });
    const toArchive = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 452 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    await moveMessages(handle.db, userId, { messageIds: [toTrash], action: "trash" }, deps(manager));
    await moveMessages(handle.db, userId, { messageIds: [toArchive], action: "archive" }, deps(manager));

    expect(sync.calls).toEqual([
      { folder: "INBOX", uids: [451], targetFolder: "Trash" },
      { folder: "INBOX", uids: [452], targetFolder: "Archive" },
    ]);
  });

  it("answers once per REQUESTED id, in order, duplicates included, and moves once", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 461 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId,
      { messageIds: [messageId, messageId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId, ok: true }, { messageId, ok: true },
    ]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [461], targetFolder: "Clients" }]);
  });
});

describe("moveMessages: nothing to move", () => {
  it("never answers out_of_scope -- a named message is always looked at", async () => {
    // The contract's narrower skip enum, proved rather than asserted in a
    // comment: every reachable no-op here carries a reason NOTED against the
    // row, because there is no scope for the row to have fallen outside of.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const awaiting = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: null });
    const settled = await makeMessage({ threadId, accountId, folder: "Clients", imapUid: 471 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId,
      { messageIds: [awaiting, settled], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId: awaiting, ok: true, skipped: true, reason: "awaiting_reconciliation" },
      { messageId: settled, ok: true, skipped: true, reason: "already_in_target" },
    ]);
    // There is deliberately no `expect(... !== "out_of_scope")` line here: the
    // first draft had one and it would not COMPILE, because BulkMessageResult's
    // reason union does not contain that value, so tsc rejects the comparison
    // as having no overlap. The narrower enum plus the narrower Outcomes
    // generic make it unrepresentable rather than merely absent, which is a
    // stronger guarantee than any assertion this test could make -- and the
    // two reasons above are what proves the reachable half still answers.
  });

  it("skips a message on an ARCHIVED account rather than failing it", async () => {
    const accountId = await makeAccount({ archivedAt: new Date("2026-09-01T09:00:00.000Z") });
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 481 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [messageId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId, ok: true, skipped: true, reason: "archived_account" },
    ]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 481 });
  });

  it("fails a destination the account has no folder for, and moves nothing", async () => {
    const accountId = await makeAccount({ label: "Work" });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 491 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [messageId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([{
      messageId, ok: false, reason: "unknown_target",
      error: 'account "Work" has no folder named "Clients"'
        + " -- pick one of its own folders, or wait for a sync pass to discover it",
    }]);
    expect(sync.calls).toEqual([]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 491 });
  });

  it("fails an account with no running sync loop, and writes nothing for it", async () => {
    const accountId = await makeAccount({ label: "Work" });
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 501 });

    const result = await moveMessages(
      handle.db, userId, { messageIds: [messageId], targetFolder: "Clients", action: "file" },
      // A manager that knows nothing of this account: the loop is not running,
      // and moving the row with nothing to carry the MOVE out would leave the
      // CRM claiming a move that never happened.
      deps(new FakeManager()),
    );

    expect(result.results).toEqual([{
      messageId, ok: false, reason: "no_sync",
      error: 'mail sync is not running for account "Work"',
    }]);
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 501 });
  });
});

describe("moveMessages: visibility and ownership", () => {
  it("answers an invisible message byte-for-byte like a nonexistent one", async () => {
    // The thread gate's ruling, one level down. A distinguishable answer here
    // would confirm that mail exists in a mailbox the actor may not know about
    // -- and the account label in an unknown_target refusal is exactly the
    // kind of fact that would leak through one.
    const accountId = await makeAccount({ label: "Chris private" });
    const threadId = await makeThread("private to chris");
    const invisible = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 511 });
    const manager = new FakeManager();
    manager.for(accountId);
    const missing = "00000000-0000-4000-8000-000000000009";

    const result = await moveMessages(
      handle.db, actorId, { messageIds: [invisible, missing], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    const [gated, unknown] = result.results;
    expect(unknown).toEqual({
      messageId: missing, ok: false, reason: "not_found",
      error: `mail message ${missing} not found`,
    });
    // Substituting the id is the ONLY thing separating the two serialized
    // answers: same keys, same order, same error text shape.
    expect(JSON.stringify(gated).replaceAll(invisible, missing)).toBe(JSON.stringify(unknown));
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 511 });
    expect(threadHints()).toHaveLength(0);
  });

  it("skips a message the actor can SEE but does not own, and files their own beside it", async () => {
    // Move rights are owner-only (spec): a colleague must never reorganise
    // your actual mailbox, however visible the conversation is to them. A
    // project link is what makes chris's message visible to sam here.
    const chrisAccount = await makeAccount();
    const [project] = await handle.db.insert(projects).values({ name: "Rollout" }).returning();
    const threadId = await makeThread();
    await handle.db.update(mailThreads)
      .set({ projectId: project!.id }).where(eq(mailThreads.id, threadId));
    const chrisMessage = await makeMessage({
      threadId, accountId: chrisAccount, folder: "INBOX", imapUid: 521,
    });
    const samAccount = await makeAccount({ userId: actorId, label: "Sams" });
    await makeFolder({ accountId: samAccount, folder: "Clients", syncEnabled: true });
    const samMessage = await makeMessage({
      threadId, accountId: samAccount, folder: "INBOX", imapUid: 522,
    });
    const manager = new FakeManager();
    manager.for(chrisAccount);
    const samSync = manager.for(samAccount);

    const result = await moveMessages(
      handle.db, actorId,
      { messageIds: [chrisMessage, samMessage], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId: chrisMessage, ok: true, skipped: true, reason: "not_owner" },
      { messageId: samMessage, ok: true },
    ]);
    // And the unowned account's own missing "Clients" folder never surfaces:
    // ownership answers before any refusal can name a mailbox the actor has no
    // rights over.
    expect(samSync.calls).toEqual([{ folder: "INBOX", uids: [522], targetFolder: "Clients" }]);
  });
});

describe("moveMessages: the filing rule and compensation", () => {
  it("turns the destination folder's sync ON before the move is queued, and says so", async () => {
    // Task 1's rule and Task 1's ORDERING, reached by calling the same path
    // rather than by deciding again. Pinned by OBSERVATION: the fake reads the
    // folder row from inside moveMessages, at the moment the server sees the
    // request arrive.
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 531 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    let enabledWhenQueued: boolean | undefined;
    sync.beforeMove = async () => {
      enabledWhenQueued = (await folderRow(accountId, "Clients"))?.syncEnabled;
    };

    const result = await moveMessages(
      handle.db, userId, { messageIds: [messageId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(enabledWhenQueued).toBe(true);
    expect(result.syncEnabled).toBe("Clients");
    expect((await folderRow(accountId, "Clients"))?.syncEnabled).toBe(true);
  });

  it("says nothing about sync when the destination was already syncing", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    const messageId = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 541 });
    const manager = new FakeManager();
    manager.for(accountId);

    const result = await moveMessages(
      handle.db, userId, { messageIds: [messageId], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect("syncEnabled" in result).toBe(false);
  });

  it("does not switch sync on for an account whose only named message was skipped", async () => {
    // "Filing into a folder turns its sync on", and an account that moved
    // nothing did not file into it -- so its Clients folder must not start
    // being walked because a message the user ticked happened to sit there and
    // was then skipped.
    //
    // TWO ACCOUNTS, and the second one is what makes this test bite. With one
    // account contributing nothing, `candidates.length > 0` short-circuits the
    // whole sync step and the narrowing is never consulted -- the first
    // version of this test had exactly that shape and survived deleting the
    // filter it was written to protect. The moving account's own destination
    // is already syncing, so anything that flips is the SKIPPED account's.
    const moving = await makeAccount({ label: "Moves" });
    const idle = await makeAccount({ label: "Idle" });
    await makeFolder({ accountId: moving, folder: "Clients", syncEnabled: true });
    await makeFolder({ accountId: idle, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    const moved = await makeMessage({ threadId, accountId: moving, folder: "INBOX", imapUid: 571 });
    const awaiting = await makeMessage({
      threadId, accountId: idle, folder: "INBOX", imapUid: null,
    });
    const manager = new FakeManager();
    manager.for(moving);
    manager.for(idle);

    const result = await moveMessages(
      handle.db, userId,
      { messageIds: [moved, awaiting], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId: moved, ok: true },
      { messageId: awaiting, ok: true, skipped: true, reason: "awaiting_reconciliation" },
    ]);
    expect("syncEnabled" in result).toBe(false);
    expect((await folderRow(idle, "Clients"))?.syncEnabled).toBe(false);
  });

  it("reverts the row and fails only that message when the server refuses", async () => {
    const accountId = await makeAccount();
    await makeFolder({ accountId, folder: "Clients", syncEnabled: true });
    const threadId = await makeThread();
    // Two source folders, so the queue makes two calls and only the second is
    // refused: the accepted one stays moved, which is the partial success the
    // bulk contract promises and which a thread-keyed answer would have had to
    // report as a single failure.
    const kept = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 551 });
    const refused = await makeMessage({ threadId, accountId, folder: "Archive", imapUid: 552 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);
    sync.failCall = 2;
    sync.failError = new Error("MOVE from Archive to Clients was refused");

    const result = await moveMessages(
      handle.db, userId,
      { messageIds: [kept, refused], targetFolder: "Clients", action: "file" },
      deps(manager),
    );

    expect(result.results).toEqual([
      { messageId: kept, ok: true },
      {
        messageId: refused, ok: false, reason: "server_refused",
        error: "MOVE from Archive to Clients was refused",
      },
    ]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Clients", null], ["Archive", 552]]);
  });

  it("counts off the answers on its own summary line", async () => {
    const accountId = await makeAccount({ label: "Work" });
    await makeFolder({ accountId, folder: "Clients", syncEnabled: false });
    const threadId = await makeThread();
    const moved = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: 561 });
    const awaiting = await makeMessage({ threadId, accountId, folder: "INBOX", imapUid: null });
    const missing = "00000000-0000-4000-8000-000000000011";
    const manager = new FakeManager();
    manager.for(accountId);
    const logger = new RecordingLogger();

    await moveMessages(
      handle.db, userId,
      { messageIds: [moved, awaiting, missing], targetFolder: "Clients", action: "file" },
      { syncManager: manager, logger },
    );

    const [line] = logger.infos;
    expect(line?.message).toBe("mail-move: bulk message action");
    expect(line?.details).toMatchObject({
      action: "file", targetFolder: "Clients", syncEnabled: "Clients",
      messages: 3, moved: 1, failed: 1, skipped: 1,
    });
  });
});
