import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bulkThreadResultSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
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
  userId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  // Any user may act on any thread -- mail is shared-visibility, and actorId
  // is audit context only (see the service's OWNERSHIP note). A second user
  // acting on the first's account is therefore the ordinary case, not an
  // authorization test.
  actorId = (await resolveUser(handle.db, { username: "sam", email: null, fullName: null })).id;
  hints = [];
  unsubscribe = subscribe((hint) => { hints.push(hint); });
});

afterEach(() => { unsubscribe(); });

afterAll(async () => { await handle.close(); });

const silentLogger: SyncLogger = { info: () => {}, warn: () => {}, error: () => {} };

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

/** Zero-padded into the Message-ID below, so ordering rows by message_id is
 * insertion order -- what every assertion here reads. An unpadded counter
 * sorts "m10" before "m9" and quietly reorders the expectations. */
let messageSeq = 0;

async function makeMessage(input: {
  threadId: string; accountId: string; folder: string; imapUid: number | null;
}): Promise<string> {
  messageSeq += 1;
  const [message] = await handle.db.insert(mailMessages).values({
    accountId: input.accountId, threadId: input.threadId,
    messageId: `m${String(messageSeq).padStart(4, "0")}@example.com`,
    fromAddr: "alice@example.com", toAddrs: [{ address: "chris@example.com" }],
    sentAt: new Date("2026-08-19T09:00:00.000Z"),
    folder: input.folder, imapUid: input.imapUid, direction: "inbound",
  }).returning();
  return message!.id;
}

async function messageRows(threadId?: string) {
  const rows = await handle.db.select({
    id: mailMessages.id, threadId: mailMessages.threadId, folder: mailMessages.folder,
    imapUid: mailMessages.imapUid, accountId: mailMessages.accountId,
  }).from(mailMessages).orderBy(asc(mailMessages.messageId));
  return threadId === undefined ? rows : rows.filter((row) => row.threadId === threadId);
}

async function threadRow(threadId: string) {
  const [row] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, threadId));
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

  moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void> {
    this.calls.push({ folder, uids: [...uids], targetFolder });
    if (this.error !== null) return Promise.reject(this.error);
    if (this.failCall === this.calls.length) return Promise.reject(this.failError);
    return Promise.resolve();
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], folder: "Sent", action: "trash" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "Sent", uids: [31], targetFolder: "Trash" }]);
  });

  it("sends trash to trash_folder and archive to archive_folder", async () => {
    const accountId = await makeAccount({ trashFolder: "Deleted Items", archiveFolder: "All Mail" });
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 41 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 42 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    await moveThreads(handle.db, actorId, { threadIds: [first], folder: "INBOX", action: "trash" }, deps(manager));
    await moveThreads(handle.db, actorId, { threadIds: [second], folder: "INBOX", action: "archive" }, deps(manager));

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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // A successful no-op, not a failure: it self-heals the moment the next
    // pass fills the UID in and the user asks again.
    expect(result.results).toEqual([{ threadId, ok: true, skipped: true }]);
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true, skipped: true }]);
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
      handle.db, actorId, { threadIds: [missing, threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([
      { threadId: missing, ok: false, error: "mail thread 00000000-0000-4000-8000-000000000000 not found" },
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
      handle.db, actorId, { threadIds: [threadId, threadId], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId,
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
      handle.db, actorId, { threadIds: [good, bad], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId, ok: true }]);
    expect(sync.calls).toEqual([{ folder: "INBOX", uids: [151], targetFolder: "Archive" }]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Clients", 152]]);
  });

  it("never fails a thread for an ARCHIVED account's rows, so it stays archivable forever", async () => {
    // Archiving a mail account keeps its messages (archive-not-delete) but
    // tears its sync loop down for good. Reporting those rows as a failure
    // would make every thread carrying one permanently un-archivable from any
    // view, for a reason no user could act on.
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // Same shape as a thread awaiting reconciliation: nothing eligible, so a
    // successful no-op rather than an error the user cannot clear.
    expect(result.results).toEqual([{ threadId, ok: true, skipped: true }]);
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // Moving the rows with nothing to carry the MOVE out would leave the CRM
    // showing a folder the message never reached, and NOTHING would ever
    // correct it -- the source folder's cursor is already past it.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toContain("mail sync is not running");
    expect((await messageRows(threadId))[0]).toMatchObject({ folder: "INBOX", imapUid: 91 });
    expect(threadHints()).toHaveLength(0);
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "trash" }, deps(manager),
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

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
    );

    // The CRM must never claim a move the server refused: the row goes back
    // exactly as it was, UID included.
    expect(result.results).toEqual([{ threadId, ok: false, error: "MOVE from INBOX to Archive was refused" }]);
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
      handle.db, actorId, { threadIds: [threadId], folder: "INBOX", action: "archive" }, deps(manager),
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
      handle.db, actorId, { threadIds: [threadId], action: "archive" }, deps(manager),
    );

    expect(result.results).toEqual([
      { threadId, ok: false, error: "MOVE from Clients to Archive was refused" },
    ]);
    expect((await messageRows(threadId)).map((row) => [row.folder, row.imapUid]))
      .toEqual([["Archive", null], ["Clients", 132]]);
  });
});

// --- Hide in CRM ------------------------------------------------------------

describe("moveThreads: hide", () => {
  it("archives the threads CRM-side and touches no mailbox", async () => {
    const accountId = await makeAccount();
    const first = await makeThread("one");
    const second = await makeThread("two");
    await makeMessage({ threadId: first, accountId, folder: "INBOX", imapUid: 141 });
    await makeMessage({ threadId: second, accountId, folder: "INBOX", imapUid: 142 });
    const manager = new FakeManager();
    const sync = manager.for(accountId);

    // `folder` is supplied and must be ignored: a CRM-side flag has no
    // concept of an IMAP folder.
    const result = await moveThreads(
      handle.db, actorId, { threadIds: [first, second], folder: "INBOX", action: "hide" }, deps(manager),
    );

    expect(result.results).toEqual([{ threadId: first, ok: true }, { threadId: second, ok: true }]);
    expect((await threadRow(first))?.archivedAt).not.toBeNull();
    expect((await threadRow(second))?.archivedAt).not.toBeNull();
    expect(sync.calls).toEqual([]);
    // Nothing moved: the user's own mail client sees no change at all.
    expect((await messageRows()).map((row) => [row.folder, row.imapUid]))
      .toEqual([["INBOX", 141], ["INBOX", 142]]);
  });

  it("fails an unknown thread and still hides the others", async () => {
    const threadId = await makeThread();
    const missing = "00000000-0000-4000-8000-000000000001";

    const result = await moveThreads(
      handle.db, actorId, { threadIds: [missing, threadId], action: "hide" }, deps(null),
    );

    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toContain("not found");
    expect(result.results[1]).toEqual({ threadId, ok: true });
    expect((await threadRow(threadId))?.archivedAt).not.toBeNull();
  });
});
