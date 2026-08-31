import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { MailAccountCreateInput } from "@conduit/shared";
import type { SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccountFolders, mailAccounts, mailFolderState, mailMessages, mailThreads } from "../db/schema.js";
import { MailIngestError, NotFoundError } from "./errors.js";
import { archiveAccount, createAccount, updateAccount } from "./mail-accounts.js";
import { ingestMessage } from "./mail-ingest.js";
import { moveThreads } from "./mail-move.js";
import {
  AccountSync, SyncManager, SyncStoppedError, SyncUnavailableError, startSyncManager,
  type FetchNewerOptions, type IdleOutcome, type ImapClient, type ImapConnectionSettings,
  type ImapFolderListing, type ImapMessageDescriptor, type IngestMessageFn,
  type SyncClock, type SyncLogger,
} from "./mail-sync.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let actorId: string;
let dir: string;
let keyPath: string;
let dataDir: string;
let hints: SseHint[];
let unsubscribe: () => void;
/** Everything a test started, stopped in afterEach so no loop outlives its case. */
let running: { stop(): Promise<void> }[];
/** When the current case's BODY began, for waitFor's budget. See that function. */
let caseStartedAt = 0;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-sync-"));
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
  dataDir = path.join(dir, "data");
  hints = [];
  unsubscribe = subscribe((hint) => { hints.push(hint); });
  running = [];
  // LAST, not first. Vitest's testTimeout excludes hook time -- measured
  // against this repo's vitest: a 3500ms beforeEach plus a 3000ms body passes
  // at 6510ms, while a 5600ms body alone dies at 5006ms. Stamped at the top of
  // this hook instead, waitFor's budget would be `4000 - whatever setup cost`
  // against vitest's full 5000, and `truncateAll` takes ACCESS EXCLUSIVE on
  // every table in a database this project deliberately loads with a second
  // vitest process when hunting flakes. Stamped here, the budget is measured
  // from the same instant vitest measures from.
  caseStartedAt = Date.now();
});

afterEach(async () => {
  // Stopped BEFORE the temp directory goes away: a loop still ingesting would
  // be writing attachment blobs into it.
  for (const item of running) await item.stop();
  unsubscribe();
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => { await handle.close(); });

// --- Fixtures ---------------------------------------------------------------

const baseInput: MailAccountCreateInput = {
  label: "Work", email: "chris@example.com",
  imapHost: "mail.example.com", imapPort: 993, imapSecurity: "tls",
  smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "hunter2",
};

async function makeAccount(overrides: Partial<MailAccountCreateInput> = {}): Promise<string> {
  const account = await createAccount(handle.db, actorId, { ...baseInput, ...overrides }, keyPath);
  return account.id;
}

/** A minimal RFC822 message. ASCII only, like every other mail fixture here. */
function rawMail(options: { messageId: string; subject?: string; from?: string; text?: string }): string {
  return [
    `Message-ID: <${options.messageId}>`,
    `From: ${options.from ?? "Alice Example <alice@example.com>"}`,
    "To: chris@example.com",
    `Subject: ${options.subject ?? "Hello"}`,
    "Date: Tue, 18 Aug 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text ?? "Body text.",
    "",
  ].join("\r\n");
}

/**
 * A genuinely unreadable message: its header block is past mail-ingest.ts's
 * 64KB cap, so the real ingest raises MailIngestError before simpleParser
 * every single time. Nothing is mocked -- this is what a poison message
 * actually looks like to the loop.
 */
function poisonMail(messageId: string): string {
  return [
    `Message-ID: <${messageId}>`,
    "From: alice@example.com",
    "To: chris@example.com",
    `X-Filler: ${"y".repeat(70 * 1024)}`,
    "Subject: poison",
    "",
    "body",
    "",
  ].join("\r\n");
}

// --- Fake IMAP client -------------------------------------------------------

interface FakeMessage {
  raw: string;
  flags: string[];
  internalDate: Date;
}

class FakeFolder {
  uidvalidity = 1;
  readonly messages = new Map<number, FakeMessage>();

  add(uid: number, raw: string, options: { flags?: string[]; internalDate?: Date } = {}): void {
    this.messages.set(uid, {
      raw,
      flags: options.flags ?? [],
      internalDate: options.internalDate ?? new Date("2026-08-18T09:00:00.000Z"),
    });
  }
}

interface FakeCall {
  op: string;
  folder?: string;
  uid?: number;
  uids?: number[];
}

/**
 * In-memory ImapClient. Records every call (so ordering and serialisation are
 * assertable), and every failure mode the loop has to handle is a field
 * rather than a mock: a connect that refuses, a fetch that throws, a message
 * that vanished, an IDLE the server does not support.
 */
class FakeImapClient implements ImapClient {
  readonly folders = new Map<string, FakeFolder>();
  readonly calls: FakeCall[] = [];
  readonly fetchNewerOptions: FetchNewerOptions[] = [];
  readonly fetchNewerFolders: string[] = [];
  readonly settings: ImapConnectionSettings;
  /**
   * What LIST reports, mutable per test.
   *
   * The default is INBOX + Sent deliberately: those are exactly the two
   * folders the walk has always covered, so every test written before folder
   * discovery existed sees the same world it did -- discovery records the two
   * it already syncs and resolves no move targets (neither is trash or
   * archive), leaving the account row untouched.
   */
  listed: ImapFolderListing[] = [
    { folder: "INBOX", selectable: true, delimiter: "/" },
    { folder: "Sent", specialUse: "sent", selectable: true, delimiter: "/" },
  ];
  /**
   * Folders the server no longer has: SELECTing one fails, exactly as a real
   * server answers for a mailbox that was deleted or renamed underneath the
   * CRM. Separate from `listed` rather than derived from it so a test can
   * stage the two independently -- the interesting case for Task 3's walk is
   * a row that mail_account_folders still HOLDS (rows are never deleted)
   * while LIST has stopped reporting it, and asserting that costs nothing to
   * the pass requires being able to build exactly that mismatch.
   */
  readonly missingFolders = new Set<string>();
  connectCalls = 0;
  disconnectCalls = 0;
  connectError: Error | null = null;
  listError: Error | null = null;
  statusError: Error | null = null;
  addFlagsError: Error | null = null;
  moveError: Error | null = null;
  idleError: Error | null = null;
  idleEntries = 0;
  /** uid -> how many more times fetchRaw should throw for it. */
  readonly fetchRawFailures = new Map<number, number>();
  /** uids fetchRaw reports as expunged. */
  readonly vanished = new Set<number>();
  /**
   * UIDs this connection's view of the mailbox has not caught up with yet:
   * fetchNewer does not list them, so the walk never learns they exist.
   *
   * A LAGGING VIEW, not a missing message. fetchRaw and fetchFlags ignore
   * this set on purpose -- the messages really are on the server, and
   * anything the walk does ask for by UID answers normally. What is being
   * staged is the LISTING coming back short, which is the only thing the
   * four CI sightings of the storm case ever showed.
   *
   * Applied before `limit`, because a view that has not caught up genuinely
   * has nothing to hand out for those UIDs. Mutable so a case can stage one
   * pass short and the next complete.
   */
  readonly unlisted = new Set<number>();
  /** While set, fetchRaw blocks on it -- used to hold a pass open. */
  gate: Promise<void> | null = null;
  /** While set, disconnect() blocks on it -- a socket that will not go away,
   * which is what a real adapter's timeouts (not this interface) bound. */
  disconnectGate: Promise<void> | null = null;
  /** Highest number of the tracked operations in flight at once. Proves the
   * loop never runs two things against one account concurrently. (idle is
   * excluded on purpose: it is a long poll, and "in flight" is meaningless
   * for something whose whole job is to sit there.) */
  maxInFlight = 0;
  private inFlight = 0;
  private idleResolve: ((outcome: IdleOutcome) => void) | null = null;

  constructor(settings: ImapConnectionSettings) {
    this.settings = settings;
  }

  folder(name: string): FakeFolder {
    const existing = this.folders.get(name);
    if (existing !== undefined) return existing;
    const created = new FakeFolder();
    this.folders.set(name, created);
    return created;
  }

  private async track<T>(call: FakeCall, run: () => Promise<T> | T): Promise<T> {
    this.calls.push(call);
    this.inFlight += 1;
    if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight;
    try {
      return await run();
    } finally {
      this.inFlight -= 1;
    }
  }

  async connect(): Promise<void> {
    await this.track({ op: "connect" }, () => {
      this.connectCalls += 1;
      if (this.connectError !== null) throw this.connectError;
    });
  }

  async disconnect(): Promise<void> {
    this.calls.push({ op: "disconnect" });
    this.disconnectCalls += 1;
    // Any parked IDLE dies with the connection.
    this.idleResolve?.("aborted");
    this.idleResolve = null;
    if (this.disconnectGate !== null) await this.disconnectGate;
  }

  /** Tracked like every other call, so the serialisation invariant
   * (maxInFlight) and the pass's call ORDER both cover discovery. */
  async list(): Promise<ImapFolderListing[]> {
    return this.track({ op: "list" }, () => {
      if (this.listError !== null) throw this.listError;
      return this.listed.map((entry) => ({ ...entry }));
    });
  }

  async status(folder: string): Promise<{ uidvalidity: number }> {
    return this.track({ op: "status", folder }, () => {
      if (this.statusError !== null) throw this.statusError;
      // The real server's answer for a mailbox that is not there. It reads
      // as a pass-level failure, which is the whole hazard: a stale row
      // walked once is a pass that fails, and walked every pass is an
      // account permanently in backoff.
      if (this.missingFolders.has(folder)) {
        throw new Error(`Command failed: Mailbox doesn't exist: ${folder}`);
      }
      return { uidvalidity: this.folder(folder).uidvalidity };
    });
  }

  async fetchNewer(folder: string, options: FetchNewerOptions): Promise<ImapMessageDescriptor[]> {
    return this.track({ op: "fetchNewer", folder }, () => {
      if (this.missingFolders.has(folder)) {
        throw new Error(`Command failed: Mailbox doesn't exist: ${folder}`);
      }
      this.fetchNewerOptions.push(options);
      // Parallel to fetchNewerOptions, so a test can say which FOLDER a
      // window belonged to instead of inferring it from call order -- which
      // stopped being reliable once a pass could walk more than two folders.
      this.fetchNewerFolders.push(folder);
      const target = this.folder(folder);
      return [...target.messages.entries()]
        .filter(([uid]) => uid > options.sinceUid)
        // Before `limit`, not after: see the field's comment.
        .filter(([uid]) => !this.unlisted.has(uid))
        .filter(([, message]) => options.sinceDate === null || message.internalDate >= options.sinceDate)
        .sort((a, b) => a[0] - b[0])
        .slice(0, options.limit)
        .map(([uid, message]) => ({ uid, flags: [...message.flags] }));
    });
  }

  async fetchRaw(folder: string, uid: number): Promise<Buffer | null> {
    return this.track({ op: "fetchRaw", folder, uid }, async () => {
      const remaining = this.fetchRawFailures.get(uid) ?? 0;
      if (remaining > 0) {
        this.fetchRawFailures.set(uid, remaining - 1);
        throw new Error(`fetch failed for uid ${uid}`);
      }
      if (this.gate !== null) await this.gate;
      if (this.vanished.has(uid)) return null;
      const message = this.folder(folder).messages.get(uid);
      return message === undefined ? null : Buffer.from(message.raw, "utf8");
    });
  }

  readonly fetchFlagsSince: Date[] = [];

  async fetchFlags(folder: string, sinceDate: Date): Promise<ImapMessageDescriptor[]> {
    return this.track({ op: "fetchFlags", folder }, () => {
      this.fetchFlagsSince.push(sinceDate);
      return [...this.folder(folder).messages.entries()]
        .filter(([, message]) => message.internalDate >= sinceDate)
        .sort((a, b) => a[0] - b[0])
        .map(([uid, message]) => ({ uid, flags: [...message.flags] }));
    });
  }

  async append(folder: string, raw: Buffer | string, flags: string[]): Promise<void> {
    await this.track({ op: "append", folder }, () => {
      const target = this.folder(folder);
      const nextUid = Math.max(0, ...target.messages.keys()) + 1;
      target.add(nextUid, typeof raw === "string" ? raw : raw.toString("utf8"), { flags: [...flags] });
    });
  }

  async addFlags(folder: string, uids: number[], flags: string[]): Promise<void> {
    await this.track({ op: "addFlags", folder, uids: [...uids] }, () => {
      if (this.addFlagsError !== null) throw this.addFlagsError;
      const target = this.folder(folder);
      for (const uid of uids) {
        const message = target.messages.get(uid);
        if (message === undefined) continue;
        for (const flag of flags) if (!message.flags.includes(flag)) message.flags.push(flag);
      }
    });
  }

  /**
   * MOVE, as a server does it: the source loses the messages and the target
   * gains them under NEW uids. The renumbering is the point rather than
   * bookkeeping -- a UID names a message IN A MAILBOX, which is exactly why
   * the move service nulls its stored one and waits for the re-sighting to
   * fill in whatever the target folder ended up calling it.
   */
  async move(folder: string, uids: number[], targetFolder: string): Promise<void> {
    await this.track({ op: "move", folder, uids: [...uids] }, () => {
      if (this.moveError !== null) throw this.moveError;
      // BOTH ends are checked. A real server refuses a MOVE naming a missing
      // source (its SELECT fails) or a missing destination (NO [TRYCREATE]) --
      // and the missing-destination case is the one the bulk action's
      // per-thread error message exists for.
      for (const name of [folder, targetFolder]) {
        if (this.missingFolders.has(name)) {
          throw new Error(`Command failed: Mailbox doesn't exist: ${name}`);
        }
      }
      const source = this.folder(folder);
      const target = this.folder(targetFolder);
      let nextUid = Math.max(0, ...target.messages.keys()) + 1;
      for (const uid of uids) {
        const message = source.messages.get(uid);
        // A uid the source no longer holds is skipped rather than failing the
        // command: the CRM's stored uid can be one message behind the server.
        if (message === undefined) continue;
        source.messages.delete(uid);
        target.messages.set(nextUid, message);
        nextUid += 1;
      }
    });
  }

  idle(signal: AbortSignal): Promise<IdleOutcome> {
    this.calls.push({ op: "idle", folder: "INBOX" });
    this.idleEntries += 1;
    if (this.idleError !== null) return Promise.reject(this.idleError);
    if (signal.aborted) return Promise.resolve("aborted");
    return new Promise<IdleOutcome>((resolve) => {
      this.idleResolve = resolve;
      signal.addEventListener("abort", () => {
        this.idleResolve = null;
        resolve("aborted");
      }, { once: true });
    });
  }

  /** Server-push: what an arriving message does to a parked IDLE. */
  deliverNewMail(): void {
    const resolve = this.idleResolve;
    this.idleResolve = null;
    resolve?.("new-mail");
  }

  opsOf(op: string): FakeCall[] {
    return this.calls.filter((call) => call.op === op);
  }
}

// --- Manual clock -----------------------------------------------------------

interface PendingWait {
  ms: number;
  done: boolean;
  resolve: () => void;
}

/** Nothing in the suite ever waits on real time. Every wait the loop asks for
 * is recorded (so backoff arithmetic is assertable) and only ends when the
 * test fires it or the loop aborts it. */
class ManualClock implements SyncClock {
  readonly requested: number[] = [];
  private current = new Date("2026-08-19T12:00:00.000Z");
  private pending: PendingWait[] = [];

  now(): Date { return new Date(this.current); }
  setNow(value: Date): void { this.current = value; }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    this.requested.push(ms);
    if (signal.aborted) return Promise.resolve();
    // A zero-length wait resolves on its own, exactly as setTimeout(0) does.
    // This is not a harness convenience: an already-expired deadline asks for
    // 0, and parking on it would be the very starvation the deadline exists
    // to prevent.
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry: PendingWait = { ms, done: false, resolve };
      this.pending.push(entry);
      signal.addEventListener("abort", () => {
        if (entry.done) return;
        entry.done = true;
        resolve();
      }, { once: true });
    });
  }

  pendingCount(): number {
    return this.pending.filter((entry) => !entry.done).length;
  }

  /**
   * End every wait currently outstanding, as if its timer had elapsed --
   * and ADVANCE `now` by the longest of them. Time really passing is not
   * cosmetic here: the loop's poll and backoff waits are deadlines, so a
   * clock frozen at one instant would make every re-entry compute the full
   * remaining interval again and the deadline behaviour would be untested.
   */
  fire(): void {
    const snapshot = this.pending;
    this.pending = [];
    let longest = 0;
    for (const entry of snapshot) {
      if (entry.done) continue;
      if (entry.ms > longest) longest = entry.ms;
      entry.done = true;
      entry.resolve();
    }
    this.current = new Date(this.current.getTime() + longest);
  }

  /** Move `now` forward without ending any wait -- for exercising a
   * deadline that is partly, but not fully, spent. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const silentLogger: SyncLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Poll until the loop makes `predicate` true. Everything waited on here is
 * something the loop is already on its way to doing, so the budget is a
 * DIAGNOSTIC rather than a synchronisation device -- and a diagnostic that
 * expires second says nothing at all.
 *
 * That is why it is neither ten seconds nor measured from this call. Vitest's
 * default `testTimeout` is 5000ms and `vitest.config.ts` does not raise it, so
 * the ten-second budget this used to carry could never fire. The sightings of
 * this file's intermittent are listed in the backlog's intermittents section
 * (`docs/superpowers/plans/2026-08-30-conduit-backlog.md`); each one whose
 * message survives is vitest's own anonymous "Test timed out in 5000ms", with
 * no indication of WHICH wait had stopped moving, and the one exception is no
 * better -- its tail was truncated, so it has no message at all. A per-call
 * budget has the same hole from the other side -- an earlier wait can spend
 * the case's five seconds and leave the label just as unreachable -- so the
 * budget runs from the start of the case BODY (see the stamp at the end of
 * beforeEach, and why it is at the end) and stops short of vitest's, which
 * makes the label reachable from any wait in any case.
 *
 * 4000ms is a measurement, not a round number. Over 24 runs of this file on
 * the dev server with four busy loops and a second vitest process alongside,
 * the slowest single wait was 1369ms (always "the first pass") and the slowest
 * whole case was 1942ms. So the budget is a little over twice the worst case
 * seen under load, and -- because the stamp and vitest now start counting at
 * the same instant -- a full second clear of vitest whatever setup cost. That
 * second is enough for the label to appear, which it does: with this budget a
 * wedged wait reports at 4120ms.
 */
async function waitFor(predicate: () => boolean, label: string, budgetMs = 4_000): Promise<void> {
  // A wait outside any case would otherwise get a deadline in 1970 and throw
  // instantly, naming a wait that never had a chance. Unreachable today.
  const start = caseStartedAt === 0 ? Date.now() : caseStartedAt;
  const deadline = start + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  sync: AccountSync;
  client: FakeImapClient;
  clock: ManualClock;
}

function makeSync(
  accountId: string,
  options: {
    clock?: ManualClock; ingest?: IngestMessageFn; pollIntervalMs?: number; logger?: SyncLogger;
  } = {},
): Harness {
  const clock = options.clock ?? new ManualClock();
  const client = new FakeImapClient({
    accountId, host: "mail.example.com", port: 993, security: "tls", username: "chris", password: "hunter2",
  });
  const sync = new AccountSync({
    db: handle.db,
    accountId,
    dataDir,
    mailKeyPath: keyPath,
    // The same fake across reconnects, so connectCalls/disconnectCalls count
    // the loop's real connection churn.
    clientFactory: () => client,
    clock,
    logger: options.logger ?? silentLogger,
    pollIntervalMs: options.pollIntervalMs ?? 300_000,
    ...(options.ingest === undefined ? {} : { ingest: options.ingest }),
  });
  running.push(sync);
  return { sync, client, clock };
}

// --- Database readers -------------------------------------------------------

async function messageRows() {
  return handle.db.select({
    id: mailMessages.id, messageId: mailMessages.messageId, folder: mailMessages.folder,
    imapUid: mailMessages.imapUid, seen: mailMessages.seen, threadId: mailMessages.threadId,
  }).from(mailMessages).orderBy(asc(mailMessages.imapUid), asc(mailMessages.messageId));
}

async function cursorFor(accountId: string, folder: string) {
  const [row] = await handle.db.select().from(mailFolderState)
    .where(and(eq(mailFolderState.accountId, accountId), eq(mailFolderState.folder, folder)));
  return row;
}

async function cursorRows(accountId: string) {
  return handle.db.select().from(mailFolderState)
    .where(eq(mailFolderState.accountId, accountId))
    .orderBy(asc(mailFolderState.folder));
}

async function accountRow(accountId: string) {
  const [row] = await handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
  if (row === undefined) throw new Error("account row vanished");
  return row;
}

function accountHints(): SseHint[] {
  return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-accounts"));
}

/** The per-account folder-set family (Phase 4.1): `[["mail-folders", id]]`. */
function folderHints(): SseHint[] {
  return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-folders"));
}

// --- Backfill and cursors ---------------------------------------------------

describe("AccountSync: backfill and cursor", () => {
  it("honours backfill_days on the first pass and drops the window once the cursor moves", async () => {
    const accountId = await makeAccount({ backfillDays: 30 });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    inbox.add(1, rawMail({ messageId: "ancient@example.com" }), {
      internalDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    inbox.add(2, rawMail({ messageId: "recent@example.com" }), {
      internalDate: new Date("2026-08-18T00:00:00.000Z"),
    });

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    const stored = await messageRows();
    expect(stored.map((row) => row.messageId)).toEqual(["recent@example.com"]);
    const firstOptions = client.fetchNewerOptions[0];
    expect(firstOptions?.sinceUid).toBe(0);
    expect(firstOptions?.limit).toBe(50);
    // 30 days before the clock's "now", not an arbitrary date.
    expect(firstOptions?.sinceDate?.toISOString()).toBe("2026-07-20T12:00:00.000Z");

    // Second pass: the cursor has moved, so there is no window any more --
    // everything above the cursor is wanted whatever its INTERNALDATE.
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the second pass");
    const laterInbox = client.fetchNewerOptions.filter((_, index) => index > 0);
    expect(laterInbox.some((options) => options.sinceUid === 2 && options.sinceDate === null)).toBe(true);
  });

  it("treats a NULL backfill_days as sync-everything", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "ancient@example.com" }), {
      internalDate: new Date("2001-01-01T00:00:00.000Z"),
    });

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    expect(client.fetchNewerOptions[0]?.sinceDate).toBeNull();
    expect((await messageRows()).map((row) => row.messageId)).toEqual(["ancient@example.com"]);
  });

  it("advances the cursor once per batch of 50, ascending", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 120; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // The sequence of lower bounds is the proof: each batch resumed from the
    // previous batch's highest UID, not from 0. Three batches (50/50/20), and
    // the short third one ends the folder without a fourth round trip.
    const inboxBounds = client.fetchNewerOptions.slice(0, 3).map((options) => options.sinceUid);
    expect(inboxBounds).toEqual([0, 50, 100]);
    expect((await messageRows())).toHaveLength(120);
    const [cursor] = await cursorRows(accountId);
    expect(cursor?.lastSeenUid).toBe(120);
  });

  it("resumes from the last completed batch after a pass crashes mid-batch", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 120; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));
    // A connection failure part-way through the SECOND batch: batch one is
    // committed, batch two is not.
    client.fetchRawFailures.set(75, 1);

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the crashed pass");

    const midCursor = await cursorFor(accountId, "INBOX");
    expect(midCursor?.lastSeenUid).toBe(50);
    // Everything before the failure did land -- the crash cost the cursor,
    // not the work.
    expect((await messageRows()).length).toBeGreaterThanOrEqual(74);

    // Backoff, then a clean pass that re-walks from 50 and converges.
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 1, "the recovery pass");

    const stored = await messageRows();
    expect(stored).toHaveLength(120);
    expect(new Set(stored.map((row) => row.messageId)).size).toBe(120);
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(120);
  });

  it("resets the cursor on a UIDVALIDITY change and converges without duplicates", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 3; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect((await messageRows())).toHaveLength(3);

    inbox.uidvalidity = 77;
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after the reset");

    // Refetched from 0 and deduped by UNIQUE (account_id, message_id): three
    // messages, still three, and the cursor is back where it belongs.
    expect((await messageRows())).toHaveLength(3);
    expect((await handle.db.select().from(mailThreads))).toHaveLength(3);
    const cursor = await cursorFor(accountId, "INBOX");
    expect(cursor?.uidvalidity).toBe(77);
    expect(cursor?.lastSeenUid).toBe(3);
  });

  it("clears stored UIDs on a UIDVALIDITY re-walk, so a renumbered mailbox cannot cross-apply flags", async () => {
    // The re-walk is WINDOWED (backfill_days), so it only re-sights recent
    // messages -- anything older would otherwise keep a UID from the dead
    // namespace, and reconcileFlags matches on (account, folder, imap_uid).
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    inbox.add(1, rawMail({ messageId: "old@example.com" }), {
      internalDate: new Date("2000-01-01T00:00:00.000Z"),
    });
    inbox.add(2, rawMail({ messageId: "recent@example.com" }), {
      internalDate: new Date("2026-08-18T00:00:00.000Z"),
    });

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect((await messageRows()).map((row) => [row.messageId, row.imapUid, row.seen]))
      .toEqual([["old@example.com", 1, false], ["recent@example.com", 2, false]]);

    // The window shrinks...
    await handle.db.update(mailAccounts)
      .set({ backfillDays: 30 }).where(eq(mailAccounts.id, accountId));
    // ...and the mailbox is renumbered, with recent@ landing on the very UID
    // old@ is still stored under. That collision is the whole defect.
    inbox.messages.clear();
    inbox.uidvalidity = 99;
    inbox.add(1, rawMail({ messageId: "recent@example.com" }), {
      internalDate: new Date("2026-08-18T00:00:00.000Z"), flags: ["\\Seen"],
    });
    inbox.add(5, rawMail({ messageId: "old@example.com" }), {
      internalDate: new Date("2000-01-01T00:00:00.000Z"),
    });

    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the re-walk");

    const rows = await messageRows();
    const old = rows.find((row) => row.messageId === "old@example.com");
    const recent = rows.find((row) => row.messageId === "recent@example.com");
    // Outside the window, so never re-sighted: its read state is untouched
    // by the message that now holds the number it used to have, because its
    // stale UID was cleared and is no longer matchable. (Asserted in this
    // order deliberately -- the read state IS the harm; the null UID is the
    // mechanism. Without the clear, both of these fail.)
    expect(old?.seen).toBe(false);
    expect(old?.imapUid).toBeNull();
    // Inside the window: refreshed by the re-walk, flags and all.
    expect(recent?.imapUid).toBe(1);
    expect(recent?.seen).toBe(true);
  });

  it("syncs the Sent folder alongside INBOX, keeping a cursor for each", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "in@example.com" }));
    client.folder("Sent").add(9, rawMail({ messageId: "out@example.com", from: "chris@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    const cursors = await cursorRows(accountId);
    expect(cursors.map((row) => [row.folder, row.lastSeenUid])).toEqual([["INBOX", 1], ["Sent", 9]]);
    const stored = await messageRows();
    expect(stored.map((row) => row.folder).sort()).toEqual(["INBOX", "Sent"]);
  });

  it("ends the folder pass rather than spinning when a batch does not advance the cursor", async () => {
    // An adapter that keeps handing back UIDs at or below the cursor would
    // otherwise loop forever, re-ingesting the same messages inside one
    // pass. The bail is the difference between a bug and a hang.
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "stuck@example.com" }));
    // Ignores sinceUid entirely -- always the same descriptor.
    client.fetchNewer = async (folder: string) => {
      client.calls.push({ op: "fetchNewer", folder });
      return folder === "INBOX" ? [{ uid: 1, flags: [] }] : [];
    };

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the pass to finish rather than hang");
    // Two calls at most for INBOX: the first returns uid 1 and advances the
    // cursor to 1, the second returns uid 1 again and bails.
    expect(client.opsOf("fetchNewer").filter((call) => call.folder === "INBOX").length)
      .toBeLessThanOrEqual(3);
    expect((await messageRows())).toHaveLength(1);
    expect((await accountRow(accountId)).status).toBe("active");
  });

  it("does not walk the sent folder twice when it is a differently-cased INBOX", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "inbox" });
    const { sync, client } = makeSync(accountId);
    // A mailbox with nothing but INBOX in it, so the only folder the walk
    // could name twice is the one under test. (The fake's default listing
    // carries a Sent folder, which the generalised walk would rightly sync as
    // a discovered, sync-enabled folder -- a different claim from this one.)
    client.listed = [{ folder: "INBOX", selectable: true, delimiter: "/" }];
    client.folder("INBOX").add(1, rawMail({ messageId: "one@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // INBOX is the one case-insensitive mailbox name in IMAP (RFC 3501), so
    // "inbox" is the SAME folder -- walking it twice would double every
    // status/fetch round for nothing.
    expect(client.opsOf("status").map((call) => call.folder)).toEqual(["INBOX"]);
    expect((await cursorRows(accountId)).map((row) => row.folder)).toEqual(["INBOX"]);
  });

  it("skips a message that was expunged between the listing and the fetch", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    inbox.add(1, rawMail({ messageId: "here@example.com" }));
    inbox.add(2, rawMail({ messageId: "gone@example.com" }));
    client.vanished.add(2);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    expect((await messageRows()).map((row) => row.messageId)).toEqual(["here@example.com"]);
    // Not poison, not an error: the cursor simply moved past it.
    expect(sync.stats.poisonSkips).toBe(0);
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(2);
    expect((await accountRow(accountId)).status).toBe("active");
  });
});

// --- A short view of the folder ---------------------------------------------

/**
 * THE RECOVERY PROPERTY, AND ITS CONTROL.
 *
 * v1.2.1 measured mail-integration.test.ts's storm case failing about 1
 * attempt in 44, always with a PARTIAL view of the twenty messages. The
 * v1.2.2 diagnosis found the surviving failure output carried the UID list
 * twice, and both were the same contiguous prefix -- so the question the
 * sightings really posed was whether a short view costs a PASS or a MESSAGE.
 *
 * These two cases are the answer, and they only mean anything as a pair.
 * `syncFolder` saves the cursor as the highest UID in the batch and the next
 * pass searches above it, so:
 *
 *   a PREFIX is recovered by the next pass    -- the first case;
 *   a HOLE is skipped forever                 -- the second.
 *
 * The second is the load-bearing one, for two measured reasons.
 *
 * It is what makes the distinction real rather than cosmetic: the first case
 * on its own passes just as happily against a loop that re-walks every folder
 * from zero every time, which would prove nothing about cursors at all.
 * (Measured: with loadCursor stubbed to return 0, the first case still goes
 * green on its counts and fails only on its last line, while this one fails
 * on the messages themselves.)
 *
 * And it is the only thing in the codebase that notices the cursor rule
 * loosening in the direction that would matter. Every other cursor test walks
 * a COMPLETE view, where "highest UID in the batch" and "highest contiguous
 * UID" are the same number -- so a `syncFolder` changed to advance only over
 * a contiguous run leaves the whole suite green except for this one case.
 * (Measured: 2460 passed, this one failed.) Nothing downstream would catch it
 * either, because `reconcileFlags` only UPDATEs rows matched on (account,
 * folder, imap_uid) and never ingests, so no later pass ever goes looking for
 * a UID that was skipped.
 *
 * So the second case PINS BEHAVIOUR RATHER THAN GUARANTEEING SAFETY. If a
 * backstop for holes is ever built, this case is supposed to go red, and the
 * right response is to rewrite it deliberately -- not to widen it until it
 * tolerates both answers.
 */
describe("AccountSync: a short view of the folder", () => {
  /** The storm case's shape: twenty messages, eleven of them visible. */
  const STORM = 20;

  async function stormInbox(): Promise<{ accountId: string } & Harness> {
    const accountId = await makeAccount({ backfillDays: null });
    const harness = makeSync(accountId);
    const inbox = harness.client.folder("INBOX");
    for (let uid = 1; uid <= STORM; uid += 1) {
      inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));
    }
    return { accountId, ...harness };
  }

  function uidsOf(rows: { imapUid: number | null }[]): (number | null)[] {
    return rows.map((row) => row.imapUid);
  }

  it("recovers a contiguous prefix on the next pass: a short view costs a pass", async () => {
    const { accountId, sync, client } = await stormInbox();
    // Eleven of twenty, contiguous from the bottom: the shape CI printed in
    // both sightings whose output survived -- the same [2..12], four days
    // apart on different branches -- renumbered to start at 1.
    for (let uid = 12; uid <= STORM; uid += 1) client.unlisted.add(uid);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the short first pass");

    // The pass is not wrong, just early: it stored everything it was shown
    // and left the cursor at the top of what it saw.
    expect(await messageRows()).toHaveLength(11);
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(11);

    // The view catches up. Nothing else changes -- same folder, same
    // messages, same cursor in the database.
    client.unlisted.clear();
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass that catches up");

    const stored = await messageRows();
    expect(stored).toHaveLength(STORM);
    expect(uidsOf(stored)).toEqual(Array.from({ length: STORM }, (_, index) => index + 1));
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(STORM);
    // And the recovery really was a walk from the cursor rather than a
    // re-walk of the folder: the second pass asked for what was above 11.
    expect(client.fetchNewerOptions.some((options) => options.sinceUid === 11)).toBe(true);
  });

  it("never comes back for the UIDs a holey view skipped: a hole costs the messages", async () => {
    const { accountId, sync, client } = await stormInbox();
    // The SAME eleven visible and nine missing as the case above. The only
    // difference is where the gap sits: 1, 2, then nothing until 12.
    for (let uid = 3; uid <= 11; uid += 1) client.unlisted.add(uid);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the holey first pass");

    // The cursor took the batch's highest UID, which is above the gap.
    expect(await messageRows()).toHaveLength(11);
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(STORM);

    // THE ANTI-VACUITY CHECK, and the case is worthless without it. It has to
    // run HERE, while the short view is still in force -- after the clear
    // below it could not fail, whatever the fixture did. The nine are absent
    // from the walk because the LISTING was short, not because the fixture
    // deleted them: ask for one by UID, the way the walk would have if it had
    // ever been told it existed, and the server hands it over.
    expect(await client.fetchRaw("INBOX", 7)).not.toBeNull();
    // Which is also why reconcileFlags is no backstop. Its own view is the
    // whole mailbox -- all twenty, the skipped ones included -- and it has
    // ingested nothing, because it only UPDATEs rows matched on (account,
    // folder, imap_uid) and those nine have no row to match.
    expect(client.opsOf("fetchFlags").some((call) => call.folder === "INBOX")).toBe(true);
    expect(await client.fetchFlags("INBOX", new Date(0))).toHaveLength(STORM);
    expect(await messageRows()).toHaveLength(11);

    // Give it every chance the prefix case got, and one more: the view
    // catches up completely, and two further passes run over it.
    client.unlisted.clear();
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after the view caught up");
    sync.wake();
    await waitFor(() => sync.stats.passes >= 3, "one more pass, for good measure");

    // Still eleven. 3..11 are on the server, were never listed to the walk,
    // and are now below a cursor that only ever moves up.
    const stored = await messageRows();
    expect(stored).toHaveLength(11);
    expect(uidsOf(stored)).toEqual([1, 2, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    // Not an error, not a poison skip, not a warning -- which is exactly why
    // a hole would be undetectable in production.
    expect(sync.stats.poisonSkips).toBe(0);
    expect(sync.stats.failures).toBe(0);
    expect((await accountRow(accountId)).status).toBe("active");
  });
});

// --- Folder discovery in the pass -------------------------------------------

describe("AccountSync: folder discovery", () => {
  async function folderRows(accountId: string) {
    return handle.db.select().from(mailAccountFolders)
      .where(eq(mailAccountFolders.accountId, accountId))
      .orderBy(asc(mailAccountFolders.folder));
  }

  it("runs LIST as the pass's first act, before any folder is walked", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "a@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // The ORDER is the contract, not an implementation detail: discovery
    // ahead of the walk is what lets a folder that appeared since the last
    // pass be synced by THIS one (Task 3's generalised foldersOf reads the
    // rows this call writes) rather than a poll interval later.
    const ops = client.calls.map((call) => call.op);
    expect(ops[0]).toBe("connect");
    expect(ops[1]).toBe("list");
    expect(ops.indexOf("list")).toBeLessThan(ops.indexOf("status"));
    // ...and it is one LIST per pass, not one per folder.
    expect(client.opsOf("list")).toHaveLength(1);
    // Discovery goes through the same serial loop as everything else.
    expect(client.maxInFlight).toBe(1);
  });

  it("records the listed folders with their classification and defaults", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.listed = [
      { folder: "INBOX", selectable: true, delimiter: "/" },
      { folder: "Sent", specialUse: "sent", selectable: true, delimiter: "/" },
      { folder: "Junk", specialUse: "junk", selectable: true, delimiter: "/" },
      { folder: "Clients", selectable: true, delimiter: "/" },
    ];

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    expect((await folderRows(accountId)).map((row) => [row.folder, row.specialUse, row.syncEnabled]))
      .toEqual([
        ["Clients", null, true], ["INBOX", null, true],
        ["Junk", "junk", false], ["Sent", "sent", true],
      ]);
  });

  it("discovers a folder that appeared since the last pass, in the pass it appears", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect((await folderRows(accountId)).map((row) => row.folder)).toEqual(["INBOX", "Sent"]);

    // A sieve rule creates a folder between passes -- the case that made
    // discovery ride the pass at all (Chris's sieve-filed mail was invisible).
    client.listed = [...client.listed, { folder: "Clients", selectable: true, delimiter: "/" }];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass that sees it");

    expect((await folderRows(accountId)).map((row) => row.folder)).toEqual(["Clients", "INBOX", "Sent"]);
  });

  it("publishes the account's folder hint when a pass creates or reclassifies a folder, and not otherwise", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    // The first pass creates INBOX and Sent, so it publishes.
    expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);

    // A settled mailbox re-sights the same folders and publishes NOTHING --
    // this runs on every pass of every account, so an ungated hint would be a
    // refetch storm on the poll interval.
    hints = [];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "a settled pass");
    expect(folderHints()).toEqual([]);

    // A folder appears: the sidebar and the picker are now stale.
    client.listed = [...client.listed, { folder: "Clients", selectable: true, delimiter: "/" }];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 3, "the pass that sees it");
    expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);

    // And a RECLASSIFICATION counts too: the picker renders the role.
    hints = [];
    client.listed = client.listed.map((entry) => entry.folder === "Clients"
      ? { ...entry, specialUse: "archive" as const } : entry);
    sync.wake();
    await waitFor(() => sync.stats.passes >= 4, "the pass that reclassifies it");
    expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);

    await sync.stop();
  });

  it("treats a LIST failure as a pass-level failure, not a poison skip", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "a@example.com" }));
    client.listError = new Error("NO [SERVERBUG] LIST refused");

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the failed pass");

    // Backoff, error status, error text -- the same handling a failed connect
    // gets. Nothing was walked: LIST runs before the first status(), so the
    // pass has no partial work to keep, which is exactly why this is the
    // right failure class rather than the poison path (that exists to stop
    // ONE unreadable message stalling a folder, and no message is involved).
    const row = await accountRow(accountId);
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("LIST refused");
    expect(client.opsOf("status")).toHaveLength(0);
    expect(await folderRows(accountId)).toEqual([]);
    // It backs off like any other pass-level failure. Asserted as PARITY --
    // one failure counted, one wait outstanding -- rather than by restating
    // the 60s/2min/4min schedule, which the backoff test above owns. Two
    // copies of a literal schedule is one place for them to disagree, and the
    // claim here is "LIST failures take the ordinary path", not "the ordinary
    // path is 60 seconds".
    expect(sync.stats.failures).toBe(1);
    expect(clock.requested).toHaveLength(1);

    // And it recovers like any other pass-level failure.
    client.listError = null;
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 1, "the recovery pass");
    expect((await accountRow(accountId)).status).toBe("active");
    expect((await folderRows(accountId)).map((row) => row.folder)).toEqual(["INBOX", "Sent"]);
  });

  it("fills the account's move targets from the first pass that can classify them", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    expect(await accountRow(accountId)).toMatchObject({ trashFolder: null, archiveFolder: null });

    client.listed = [
      { folder: "INBOX", selectable: true, delimiter: "/" },
      { folder: "Trash", specialUse: "trash", selectable: true, delimiter: "/" },
      { folder: "Archive", specialUse: "archive", selectable: true, delimiter: "/" },
    ];
    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    expect(await accountRow(accountId)).toMatchObject({ trashFolder: "Trash", archiveFolder: "Archive" });
  });
});

// --- The generalised walk ---------------------------------------------------

describe("AccountSync: the generalised walk", () => {
  /** INBOX, Sent (the locked pair), an ordinary folder, a Junk that defaults
   * off, and a \Noselect hierarchy node. */
  const mixedListing: ImapFolderListing[] = [
    { folder: "INBOX", selectable: true, delimiter: "/" },
    { folder: "Sent", specialUse: "sent", selectable: true, delimiter: "/" },
    { folder: "Clients", selectable: true, delimiter: "/" },
    { folder: "Junk", specialUse: "junk", selectable: true, delimiter: "/" },
    { folder: "Lists", selectable: false, delimiter: "/" },
  ];

  function walkedFolders(client: FakeImapClient): string[] {
    return client.opsOf("status").map((call) => call.folder ?? "");
  }

  it("walks every sync-enabled selectable folder this pass listed, and nothing else", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.listed = mixedListing;
    client.folder("INBOX").add(1, rawMail({ messageId: "in@example.com" }));
    client.folder("Clients").add(1, rawMail({ messageId: "client@example.com" }));
    client.folder("Junk").add(1, rawMail({ messageId: "spam@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // Clients joins the walk because discovery defaulted it on; Junk does not
    // (junk/trash default off, spec); Lists does not because a \Noselect
    // mailbox cannot be SELECTed at all, whatever its sync_enabled says.
    expect(walkedFolders(client)).toEqual(["INBOX", "Sent", "Clients"]);
    expect((await messageRows()).map((row) => row.messageId).sort())
      .toEqual(["client@example.com", "in@example.com"]);
    expect((await cursorRows(accountId)).map((row) => row.folder)).toEqual(["Clients", "INBOX", "Sent"]);
  });

  it("always walks INBOX and the sent folder, however the picker is set", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.listed = mixedListing;

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // The picker switching everything off, including the two rows Task 4's
    // route renders as locked.
    await handle.db.update(mailAccountFolders).set({ syncEnabled: false })
      .where(eq(mailAccountFolders.accountId, accountId));
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after the toggles");

    // The send path APPENDs to Sent and direction detection depends on both,
    // so these two are not a choice on offer.
    const second = walkedFolders(client).slice(3);
    expect(second).toEqual(["INBOX", "Sent"]);
  });

  it("does not walk a folder whose row survives but which LIST no longer reports", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.listed = [...mixedListing];
    client.folder("Clients").add(1, rawMail({ messageId: "client@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect(walkedFolders(client)).toContain("Clients");

    // The user deletes (or renames) the folder on the server. Its row stays --
    // rows are never deleted, staleness is read off last_discovered_at -- so
    // this is exactly the mismatch a walk driven off a TABLE QUERY would fall
    // into: SELECTing a mailbox the server does not have is a pass-level
    // failure, on every pass, forever.
    client.listed = mixedListing.filter((entry) => entry.folder !== "Clients");
    client.missingFolders.add("Clients");
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after it vanished");

    expect(walkedFolders(client).slice(3)).toEqual(["INBOX", "Sent"]);
    expect(sync.stats.failures).toBe(0);
    expect((await accountRow(accountId)).status).toBe("active");
    // The row (and the message ingested under it) survives untouched.
    const rows = await handle.db.select().from(mailAccountFolders)
      .where(eq(mailAccountFolders.accountId, accountId)).orderBy(asc(mailAccountFolders.folder));
    expect(rows.map((row) => row.folder)).toContain("Clients");
    expect((await messageRows()).map((row) => row.folder)).toEqual(["Clients"]);
  });

  it("backfills a folder enabled mid-life from its own first sync, inside the window", async () => {
    // The engine's existing first-sync semantics -- cursor absent means the
    // backfill window applies -- now hold PER FOLDER, so a folder switched on
    // months into an account's life backfills exactly as a new account does.
    const accountId = await makeAccount({ backfillDays: 30, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.listed = mixedListing;
    client.folder("INBOX").add(1, rawMail({ messageId: "in@example.com" }));
    client.folder("Junk").add(1, rawMail({ messageId: "old@example.com" }), {
      internalDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    client.folder("Junk").add(2, rawMail({ messageId: "recent@example.com" }), {
      internalDate: new Date("2026-08-18T00:00:00.000Z"),
    });

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect(walkedFolders(client)).not.toContain("Junk");
    const before = client.fetchNewerFolders.length;

    // The user opts Junk in from the picker.
    await handle.db.update(mailAccountFolders).set({ syncEnabled: true })
      .where(and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, "Junk")));
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass that picks it up");

    const junkWindows = client.fetchNewerFolders
      .map((folder, index) => ({ folder, options: client.fetchNewerOptions[index] }))
      .filter((entry, index) => index >= before && entry.folder === "Junk");
    // A fresh cursor (no row yet) and the account's backfill window measured
    // from now -- not from the account's creation, and not unbounded.
    expect(junkWindows[0]?.options?.sinceUid).toBe(0);
    expect(junkWindows[0]?.options?.sinceDate?.toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect((await messageRows()).map((row) => row.messageId).sort())
      .toEqual(["in@example.com", "recent@example.com"]);
    expect((await cursorFor(accountId, "Junk"))?.lastSeenUid).toBe(2);
  });
});

// --- Flag reconcile ---------------------------------------------------------

describe("AccountSync: flag reconcile", () => {
  it("mirrors \\Seen in both directions and publishes only when something changed", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    inbox.add(1, rawMail({ messageId: "a@example.com" }));
    inbox.add(2, rawMail({ messageId: "b@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    expect((await messageRows()).map((row) => row.seen)).toEqual([false, false]);

    // Read in another mail client.
    inbox.messages.get(1)?.flags.push("\\Seen");
    hints = [];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the reconciling pass");
    expect((await messageRows()).map((row) => row.seen)).toEqual([true, false]);
    expect(hints.some((hint) => hint.keys.some((key) => key[0] === "mail-unread"))).toBe(true);

    // ...and marked unread again there.
    const message = inbox.messages.get(1);
    if (message !== undefined) message.flags = [];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 3, "the un-reading pass");
    expect((await messageRows()).map((row) => row.seen)).toEqual([false, false]);

    // A pass that changes nothing publishes nothing.
    hints = [];
    sync.wake();
    await waitFor(() => sync.stats.passes >= 4, "the quiet pass");
    expect(hints).toEqual([]);
  });

  it("asks for flags over a 30-day window that moves with the clock", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    // Both folders, both windows: 30 days before the pass, whenever it ran.
    const firstPassWindows = [...client.fetchFlagsSince];
    expect(firstPassWindows).toHaveLength(2);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    for (const since of firstPassWindows) {
      expect(clock.now().getTime() - since.getTime()).toBe(thirtyDaysMs);
    }

    // Asserted as a relationship to "now", never as a fixed timestamp: the
    // window has to MOVE, and a frozen expectation would pass even if it
    // were computed once and cached forever.
    await waitFor(() => clock.pendingCount() > 0, "the poll wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 2, "the second pass");
    const latest = client.fetchFlagsSince[client.fetchFlagsSince.length - 1];
    expect(latest).toBeDefined();
    expect(clock.now().getTime() - (latest as Date).getTime()).toBe(thirtyDaysMs);
    expect((latest as Date).getTime()).toBeGreaterThan((firstPassWindows[0] as Date).getTime());
  });
});

// --- Waking up --------------------------------------------------------------

describe("AccountSync: idle and polling", () => {
  it("runs the next pass when IDLE reports new mail", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "first@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => client.idleEntries >= 1, "the loop to park on IDLE");

    client.folder("INBOX").add(2, rawMail({ messageId: "second@example.com" }));
    client.deliverNewMail();

    await waitFor(() => sync.stats.passes >= 2, "the pass IDLE triggered");
    expect(sync.stats.idleWakes).toBe(1);
    expect((await messageRows())).toHaveLength(2);
  });

  it("caps IDLE at the poll interval and runs a pass when it elapses", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId, { pollIntervalMs: 300_000 });

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => clock.pendingCount() > 0, "the poll cap to be armed");
    expect(clock.requested).toContain(300_000);

    clock.fire();
    await waitFor(() => sync.stats.passes >= 2, "the polled pass");
    expect(sync.stats.idleWakes).toBe(0);
    expect(client.idleEntries).toBeGreaterThanOrEqual(1);
  });

  it("degrades to poll-only when the server has no IDLE, without spinning, and asks only once", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const logs: { level: string; message: string }[] = [];
    const logger: SyncLogger = {
      info: (_d, message) => { logs.push({ level: "info", message }); },
      warn: (_d, message) => { logs.push({ level: "warn", message }); },
      error: (_d, message) => { logs.push({ level: "error", message }); },
    };
    const { sync, client, clock } = makeSync(accountId, { logger });
    client.idleError = new Error("IDLE not supported");

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => client.idleEntries >= 1, "the failed IDLE");

    // The pass count must NOT be climbing: a failed IDLE waits out the poll
    // interval instead of returning straight into another pass.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sync.stats.passes).toBe(1);
    const idleLogs = () => logs.filter((entry) => entry.message.includes("IDLE unavailable"));
    expect(idleLogs()).toHaveLength(1);
    // Info, not warn: a server without IDLE is a property of that server,
    // not an incident to page anyone about.
    expect(idleLogs()[0]?.level).toBe("info");

    await waitFor(() => clock.pendingCount() > 0, "the poll wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 2, "the polled pass");
    // Latched: the second wait does not ask again, and does not log again.
    // Unlatched this cost one WARN plus one reconnect-and-LOGIN per poll --
    // 288 of each per day, per account, none of them changing the answer.
    const entriesAfterSecondPass = client.idleEntries;
    await waitFor(() => clock.pendingCount() > 0, "the second poll wait");
    expect(client.idleEntries).toBe(entriesAfterSecondPass);
    expect(idleLogs()).toHaveLength(1);
  });
});

// --- Errors and backoff -----------------------------------------------------

describe("AccountSync: pass failures", () => {
  it("backs off exponentially to a 32-minute cap and resets after a good pass", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.connectError = new Error("ECONNREFUSED");

    sync.start();
    // Seven rounds of "let the pass fail, then let its backoff elapse". The
    // eighth backoff is deliberately NOT fired in here: firing a backoff is
    // what starts the next pass, and the next pass after the eighth is the one
    // that has to succeed.
    for (let failure = 1; failure <= 7; failure += 1) {
      await waitFor(() => sync.stats.failures >= failure, `failure ${failure}`);
      await waitFor(() => clock.pendingCount() > 0, `backoff wait ${failure}`);
      clock.fire();
    }
    await waitFor(() => sync.stats.failures >= 8, "failure 8");
    await waitFor(() => clock.pendingCount() > 0, "backoff wait 8");

    // EVERYTHING FROM HERE TO THE FIRE HAPPENS WHILE THE LOOP IS PARKED, AND
    // THAT IS THE WHOLE POINT. `clock.fire()` resolves the wait and hands
    // control straight to the loop, which loads the account, reads the
    // credentials and only then calls connect(). Repairing the account AFTER
    // the fire raced exactly that, and the race was decided by whether one
    // database round trip on this side finished before two plus a key file
    // read on the loop's. Instrumented over 20 runs under load, the test won
    // by a median of 7.3ms and by as little as 3.3ms. Lose it -- a GC pause, a
    // busy box, another suite on the same machine -- and the pass this fire
    // starts reads the old error, fails, and parks the loop in a NINTH
    // 32-minute backoff that nothing here ever fires, so the wait for the
    // recovery pass can never end. That is the intermittent the backlog
    // records against this case, and it is why the repair is above the fire.
    //
    // The whole-array `toEqual` below pins the LENGTH, which `slice(0, 8)` did
    // not. It does not catch a ninth wait: measured at that position in the old
    // source, `clock.requested.length` is 8 with no await after the fire and
    // still 8 after one microtask -- the ninth entry needs the ninth pass to
    // have failed first, which takes two database round trips.
    expect(clock.requested).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 1_920_000, 1_920_000,
    ]);
    expect((await accountRow(accountId)).status).toBe("error");
    // A REARRANGEMENT TRIPWIRE, and only that. It reads 8 because the fire is
    // still below it and the loop is parked; move this block or the fire past
    // one another and it reads 9. It does NOT catch the repair alone drifting
    // back below the fire -- that leaves this line where it is, still reading
    // 8, and the escape below the fire is what catches that one.
    expect(client.connectCalls).toBe(8);
    client.connectError = null;

    clock.fire();
    // `failures > 8` is an ESCAPE, not an expectation. If the pass this fire
    // starts ever fails -- for this reason or any other -- the loop parks in a
    // backoff nothing here fires, and waiting only on `passes` would hang until
    // vitest killed the case with no name. Ending on either outcome turns that
    // into the assertion below, which says which one happened.
    await waitFor(() => sync.stats.passes >= 1 || sync.stats.failures > 8, "the recovery pass");
    expect(sync.stats.failures).toBe(8);
    expect(sync.stats.attempt).toBe(0);
    const row = await accountRow(accountId);
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it("records a truncated last_error and publishes only on a real status flip", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.connectError = new Error(`refused: ${"x".repeat(2000)}`);
    // createAccount published one of its own; only the loop's hints matter here.
    hints = [];

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the first failure");
    const errored = await accountRow(accountId);
    expect(errored.status).toBe("error");
    expect(errored.lastError?.length).toBeLessThanOrEqual(503);
    expect(errored.lastError?.startsWith("refused: xxx")).toBe(true);
    expect(accountHints()).toHaveLength(1);

    // A second identical failure changes neither field, so it must not fire
    // another hint -- otherwise a permanently broken account would publish
    // forever, once per backoff.
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    clock.fire();
    await waitFor(() => sync.stats.failures >= 2, "the second failure");
    expect(accountHints()).toHaveLength(1);

    client.connectError = null;
    await waitFor(() => clock.pendingCount() > 0, "the second backoff wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 1, "the recovery pass");
    expect(accountHints()).toHaveLength(2);
  });

  it("keeps a failing account's loop alive and never rejects out of start()", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.statusError = new Error("NO [SERVERBUG]");

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the first failure");
    // Dropped after every failure, so the next pass reconnects rather than
    // reusing a connection that just misbehaved.
    expect(client.disconnectCalls).toBeGreaterThanOrEqual(1);
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    clock.fire();
    await waitFor(() => sync.stats.failures >= 2, "the second failure");
    expect(client.connectCalls).toBeGreaterThanOrEqual(2);
    expect(sync.stats.stopped).toBe(false);
  });
});

// --- Poison messages --------------------------------------------------------

describe("AccountSync: poison-message contract", () => {
  it("retries a failed ingest once inside the same pass", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    let calls = 0;
    const flaky: IngestMessageFn = async (db, dir_, input) => {
      calls += 1;
      if (calls === 1) {
        // The designed transient case: mail-ingest.ts rolls back when another
        // writer wins the race for the same (account, message id).
        throw new MailIngestError(
          { accountId: input.accountId, folder: input.folder, uid: input.uid },
          "mail ingest raced another writer",
        );
      }
      return ingestMessage(db, dir_, input);
    };
    const { sync, client } = makeSync(accountId, { ingest: flaky });
    client.folder("INBOX").add(1, rawMail({ messageId: "retry@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    expect(calls).toBe(2);
    expect((await messageRows()).map((row) => row.messageId)).toEqual(["retry@example.com"]);
    expect(sync.stats.poisonSkips).toBe(0);
    // Only ONE fetch: the retry re-uses the raw body it already has.
    expect(client.opsOf("fetchRaw")).toHaveLength(1);
    const row = await accountRow(accountId);
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
  });

  it("skips the UID after a second failure, keeps the account active, and notes it", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    inbox.add(1, rawMail({ messageId: "before@example.com" }));
    inbox.add(2, poisonMail("poison@example.com"));
    inbox.add(3, rawMail({ messageId: "after@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // The mailbox is NOT wedged: everything after the bad message landed.
    expect((await messageRows()).map((row) => row.messageId))
      .toEqual(["before@example.com", "after@example.com"]);
    // The cursor moved PAST the poison UID, which is what stops it from
    // being re-fetched forever.
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(3);
    expect(sync.stats.poisonSkips).toBe(1);

    const row = await accountRow(accountId);
    // The one error class that does not flip the account.
    expect(row.status).toBe("active");
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.lastError).toContain("skipped 1 unreadable message");
    expect(row.lastError).toContain("INBOX/2");
    expect(row.lastError).toContain("header block");

    // Attempted exactly twice, then never again: the next pass starts above
    // the skipped UID.
    expect(client.opsOf("fetchRaw").filter((call) => call.uid === 2)).toHaveLength(1);
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the second pass");
    expect(sync.stats.poisonSkips).toBe(1);
    // And a clean pass clears the note.
    expect((await accountRow(accountId)).lastError).toBeNull();
  });

  it("treats a non-MailIngestError from ingest as a pass-level failure, not poison", async () => {
    // Poison-skipping is for messages ingest has JUDGED unreadable. Anything
    // else escaping is a bug or an outage, and silently skipping UIDs for it
    // would walk an entire mailbox one lost message at a time.
    const accountId = await makeAccount({ backfillDays: null });
    const broken: IngestMessageFn = () => Promise.reject(new TypeError("cannot read properties of undefined"));
    const { sync, client } = makeSync(accountId, { ingest: broken });
    client.folder("INBOX").add(1, rawMail({ messageId: "boom@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the pass-level failure");
    expect(sync.stats.poisonSkips).toBe(0);
    const row = await accountRow(accountId);
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("cannot read properties");
    // The cursor stayed put, so nothing was silently skipped.
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(0);
  });

  it("treats an account deleted mid-ingest as teardown, not as a poison message", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const gone: IngestMessageFn = async (_db, _dir, input) => {
      // What ingest raises when its account row is not there any more.
      throw new MailIngestError(
        { accountId: input.accountId, folder: input.folder, uid: input.uid },
        "mail account not found",
        { cause: new NotFoundError("mail account", input.accountId) },
      );
    };
    const { sync, client } = makeSync(accountId, { ingest: gone });
    client.folder("INBOX").add(1, rawMail({ messageId: "orphan@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.stopped, "the sync to tear itself down");
    expect(sync.stats.poisonSkips).toBe(0);
    expect(sync.stats.failures).toBe(0);
    expect(client.disconnectCalls).toBeGreaterThanOrEqual(1);
  });
});

// --- Teardown ---------------------------------------------------------------

describe("AccountSync: teardown", () => {
  it("stops itself when its account row is gone", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const stoppedIds: string[] = [];
    const clock = new ManualClock();
    const client = new FakeImapClient({
      accountId, host: "mail.example.com", port: 993, security: "tls", username: "chris", password: "hunter2",
    });
    const sync = new AccountSync({
      db: handle.db, accountId, dataDir, mailKeyPath: keyPath,
      clientFactory: () => client, clock, logger: silentLogger, pollIntervalMs: 300_000,
      onStopped: (id) => { stoppedIds.push(id); },
    });
    running.push(sync);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // Every child row first: this manufactures a state the app itself never
    // produces (accounts are archived, never deleted -- archive-not-delete),
    // so the foreign keys have to be cleared by hand. mail_account_folders
    // joined the list when discovery started riding the pass.
    await handle.db.delete(mailFolderState).where(eq(mailFolderState.accountId, accountId));
    await handle.db.delete(mailAccountFolders).where(eq(mailAccountFolders.accountId, accountId));
    await handle.db.delete(mailAccounts).where(eq(mailAccounts.id, accountId));

    sync.wake();
    await waitFor(() => sync.stats.stopped, "the sync to notice the account is gone");
    expect(stoppedIds).toEqual([accountId]);
    expect(sync.stats.failures).toBe(0);
    expect(client.disconnectCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops itself when its account is archived", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    // Archived directly rather than through archiveAccount, so this exercises
    // the loop's own guard rather than the manager's teardown. The same
    // predicate covers getAccountCredentialsAsSystem's ArchivedError on the
    // reconnect path.
    await handle.db.update(mailAccounts)
      .set({ archivedAt: new Date() }).where(eq(mailAccounts.id, accountId));

    sync.wake();
    await waitFor(() => sync.stats.stopped, "the sync to notice the archive");
    expect(sync.stats.failures).toBe(0);
  });

  it("stops mid-pass without waiting for the rest of the folder", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 10; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));

    let release = (): void => {};
    client.gate = new Promise<void>((resolve) => { release = resolve; });

    sync.start();
    await waitFor(() => client.opsOf("fetchRaw").length >= 1, "the pass to reach a fetch");
    const stopping = sync.stop();
    client.gate = null;
    release();
    await stopping;

    expect(sync.stats.stopped).toBe(true);
    expect(client.disconnectCalls).toBe(1);
    // The folder walk abandoned the rest rather than draining all ten, and
    // the cursor never advanced past the batch it was in -- the next start
    // resumes from the database and re-ingests idempotently.
    expect(client.opsOf("fetchRaw").length).toBeLessThan(10);
    expect((await cursorFor(accountId, "INBOX"))?.lastSeenUid).toBe(0);
  });

  it("stops cleanly: disconnects, leaves no wait pending, and refuses new work", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => clock.pendingCount() > 0, "the loop to park");

    await sync.stop();
    expect(sync.stats.stopped).toBe(true);
    expect(client.disconnectCalls).toBe(1);
    expect(clock.pendingCount()).toBe(0);
    await expect(sync.markSeen("INBOX", [1])).rejects.toBeInstanceOf(SyncStoppedError);
    // Idempotent.
    await sync.stop();
    expect(client.disconnectCalls).toBe(1);
  });
});

// --- Queued work ------------------------------------------------------------

describe("AccountSync: queued work", () => {
  it("runs markSeen between passes, never alongside one", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 3; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));

    // Hold the first pass open in the middle of its fetches.
    let release = (): void => {};
    client.gate = new Promise<void>((resolve) => { release = resolve; });

    sync.start();
    await waitFor(() => client.opsOf("fetchRaw").length >= 1, "the pass to reach a fetch");
    const queued = sync.markSeen("INBOX", [1, 2]);
    // Still queued: the loop is busy.
    expect(client.opsOf("addFlags")).toHaveLength(0);

    client.gate = null;
    release();
    await queued;

    expect(client.maxInFlight).toBe(1);
    const addFlagsIndex = client.calls.findIndex((call) => call.op === "addFlags");
    const lastFetchIndex = client.calls.map((call) => call.op).lastIndexOf("fetchRaw");
    expect(addFlagsIndex).toBeGreaterThan(lastFetchIndex);
    expect(client.opsOf("addFlags")[0]?.uids).toEqual([1, 2]);
    expect(inbox.messages.get(1)?.flags).toContain("\\Seen");
  });

  it("appends a sent message to the account's current sent folder", async () => {
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await sync.appendSent(rawMail({ messageId: "sent@example.com", from: "chris@example.com" }));

    expect(client.opsOf("append")[0]?.folder).toBe("Sent");
    const appended = client.folder("Sent").messages.get(1);
    expect(appended?.flags).toEqual(["\\Seen"]);

    // The folder is read at run time, so an edit takes effect without a
    // restart of the loop.
    await handle.db.update(mailAccounts)
      .set({ sentFolder: "INBOX.Sent" }).where(eq(mailAccounts.id, accountId));
    await sync.appendSent(rawMail({ messageId: "sent2@example.com", from: "chris@example.com" }));
    expect(client.opsOf("append")[1]?.folder).toBe("INBOX.Sent");
  });

  it("rejects a queued task that fails, without flipping the account to error", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "m1@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");

    client.addFlagsError = new Error("connection lost");
    // A user pressing "mark read" while the mail server is misbehaving gets
    // the failure back -- but it must not be what marks their account broken.
    await expect(sync.markSeen("INBOX", [1])).rejects.toThrow("connection lost");
    expect((await accountRow(accountId)).status).toBe("active");
    expect(sync.stats.failures).toBe(0);
    expect(sync.stats.stopped).toBe(false);

    // And the loop carries on: the next pass still runs.
    client.addFlagsError = null;
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after the failed task");
  });

  it("drains queued work without running a pass, and still passes on the next poll", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.folder("INBOX").add(1, rawMail({ messageId: "m1@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => client.idleEntries >= 1, "the loop to park on IDLE");
    const fetches = client.opsOf("fetchNewer").length;
    const statuses = client.opsOf("status").length;

    await sync.markSeen("INBOX", [1]);

    // The flag write ran; NOTHING else did. Task 7 calls this once per thread
    // the user opens, and a full status/fetch/reconcile round per click would
    // be pure waste.
    expect(client.opsOf("addFlags")).toHaveLength(1);
    expect(client.opsOf("fetchNewer")).toHaveLength(fetches);
    expect(client.opsOf("status")).toHaveLength(statuses);
    expect(client.opsOf("fetchFlags")).toHaveLength(2);
    expect(sync.stats.passes).toBe(1);

    // And the loop went straight back to waiting, so a real trigger still
    // produces a real pass.
    await waitFor(() => clock.pendingCount() > 0, "the loop to park again");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 2, "the polled pass");
    expect(client.opsOf("fetchNewer").length).toBeGreaterThan(fetches);
  });

  it("refuses queued work during a backoff, immediately and with the reason", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.statusError = new Error("NO [SERVERBUG] mailbox unavailable");

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the first failure");
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    const connects = client.connectCalls;

    // Without this, every click during an outage opens a fresh TCP
    // connection and LOGIN -- straight through the rate limit the backoff
    // exists to impose -- and the user waits out a connect timeout to be
    // told nothing useful.
    const error = await sync.markSeen("INBOX", [1]).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(SyncUnavailableError);
    expect((error as SyncUnavailableError).lastError).toContain("SERVERBUG");
    expect(client.connectCalls).toBe(connects);
    expect(client.opsOf("addFlags")).toHaveLength(0);
    expect(sync.stats.failures).toBe(1);
    expect(sync.stats.passes).toBe(0);

    // And it is allowed again as soon as a pass succeeds.
    client.statusError = null;
    clock.fire();
    await waitFor(() => sync.stats.passes >= 1, "the recovery pass");
    await sync.markSeen("INBOX", [1]);
    expect(client.opsOf("addFlags")).toHaveLength(1);
  });

  it("keeps polling on a deadline, so repeated queued work cannot starve it", async () => {
    // The failure this pins down is total on a server without IDLE: there,
    // the poll is the ONLY thing that fetches mail, and a fresh timer per
    // wait entry means a mailbox getting a mark-read every four minutes
    // would restart a five-minute wait forever and never sync again.
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId, { pollIntervalMs: 300_000 });
    client.idleError = new Error("IDLE not supported");
    client.folder("INBOX").add(1, rawMail({ messageId: "m1@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => clock.pendingCount() > 0, "the poll wait");
    expect(clock.requested[clock.requested.length - 1]).toBe(300_000);

    // Four minutes in, a mark-read cuts the wait short.
    clock.advance(240_000);
    await sync.markSeen("INBOX", [1]);
    await waitFor(() => clock.pendingCount() > 0, "the resumed poll wait");
    // RESUMED, not restarted: one minute of the five is left. A fresh timer
    // here is the bug -- it would ask for 300_000 again, forever.
    expect(clock.requested[clock.requested.length - 1]).toBe(60_000);

    // Another four minutes takes it past the deadline, so the poll is due
    // immediately rather than being pushed out a third time.
    clock.advance(240_000);
    await sync.markSeen("INBOX", [1]);
    await waitFor(() => sync.stats.passes >= 2, "the poll that queued work could not starve");
    expect(client.opsOf("addFlags")).toHaveLength(2);
  });

  it("trims a stored sent folder once, so the walk and the APPEND agree", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    await handle.db.update(mailAccounts)
      .set({ sentFolder: "  Sent  " }).where(eq(mailAccounts.id, accountId));
    const { sync, client } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await sync.appendSent(rawMail({ messageId: "sent@example.com", from: "chris@example.com" }));

    // Untrimmed, the pass would walk `Sent` while the APPEND went to
    // `"  Sent  "` -- two different mailboxes to an IMAP server.
    expect(client.opsOf("status").map((call) => call.folder)).toEqual(["INBOX", "Sent"]);
    expect(client.opsOf("append")[0]?.folder).toBe("Sent");
    expect([...client.folders.keys()]).not.toContain("  Sent  ");
    expect((await cursorRows(accountId)).map((row) => row.folder)).toEqual(["INBOX", "Sent"]);
  });

  it("markSeen with no uids does nothing at all", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await sync.markSeen("INBOX", []);
    expect(client.opsOf("addFlags")).toHaveLength(0);
  });
});

// --- Queued moves -----------------------------------------------------------

describe("AccountSync: queued moves", () => {
  const withArchive: ImapFolderListing[] = [
    { folder: "INBOX", selectable: true, delimiter: "/" },
    { folder: "Sent", specialUse: "sent", selectable: true, delimiter: "/" },
    { folder: "Archive", specialUse: "archive", selectable: true, delimiter: "/" },
  ];

  it("runs a queued move between passes, never alongside one", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    const inbox = client.folder("INBOX");
    for (let uid = 1; uid <= 3; uid += 1) inbox.add(uid, rawMail({ messageId: `m${uid}@example.com` }));

    // Hold the pass open mid-fetch, then race a move against it.
    let release = (): void => {};
    client.gate = new Promise<void>((resolve) => { release = resolve; });

    sync.start();
    await waitFor(() => client.opsOf("fetchRaw").length >= 1, "the pass to reach a fetch");
    const queued = sync.moveMessages("INBOX", [1, 2], "Archive");
    expect(client.opsOf("move")).toHaveLength(0);

    client.gate = null;
    release();
    await queued;

    // The whole point of the one serial loop: a move can never overlap the
    // walk of the folder it is moving messages OUT of.
    expect(client.maxInFlight).toBe(1);
    const moveIndex = client.calls.findIndex((call) => call.op === "move");
    const lastFetchIndex = client.calls.map((call) => call.op).lastIndexOf("fetchRaw");
    expect(moveIndex).toBeGreaterThan(lastFetchIndex);
    expect(client.opsOf("move")[0]).toMatchObject({ folder: "INBOX", uids: [1, 2] });
    expect([...client.folder("Archive").messages.keys()]).toEqual([1, 2]);
    expect([...inbox.messages.keys()]).toEqual([3]);
  });

  it("chunks one move into UID_CHUNK-sized commands", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    const uids = Array.from({ length: 600 }, (_, index) => index + 1);
    await sync.moveMessages("INBOX", uids, "Archive");

    // One mailbox-wide action must never become a single command carrying
    // thousands of UIDs.
    const moves = client.opsOf("move");
    expect(moves.map((call) => call.uids?.length)).toEqual([500, 100]);
    expect(moves[0]?.uids?.[0]).toBe(1);
    expect(moves[1]?.uids?.[99]).toBe(600);
  });

  it("refuses a move during a backoff, immediately and with the reason", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.statusError = new Error("NO [SERVERBUG] mailbox unavailable");

    sync.start();
    await waitFor(() => sync.stats.failures >= 1, "the first failure");
    await waitFor(() => clock.pendingCount() > 0, "the backoff wait");
    const connects = client.connectCalls;

    // The bulk action's per-thread error for an account in backoff comes from
    // exactly this rejection -- immediately, with the stored reason, and
    // without a connect attempt the backoff exists to prevent.
    const error = await sync.moveMessages("INBOX", [1], "Archive")
      .then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(SyncUnavailableError);
    expect((error as SyncUnavailableError).lastError).toContain("SERVERBUG");
    expect(client.connectCalls).toBe(connects);
    expect(client.opsOf("move")).toHaveLength(0);
  });

  it("moveMessages with no uids does nothing at all", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await sync.moveMessages("INBOX", [], "Archive");
    expect(client.opsOf("move")).toHaveLength(0);
  });

  it("converges after a real move: the target folder's next pass restores the UID, on one row", async () => {
    // End to end through the REAL ingest: the move service writes the
    // optimistic row, the engine moves the message, and the Phase 4
    // reconciliation machinery -- UNIQUE (account_id, message_id) -- is what
    // makes the re-sighting an UPDATE rather than a second row.
    const accountId = await makeAccount({ backfillDays: null, sentFolder: "Sent" });
    const { sync, client } = makeSync(accountId);
    client.listed = withArchive;
    client.folder("INBOX").add(1, rawMail({ messageId: "one@example.com" }));

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    const [stored] = await messageRows();
    expect(stored).toMatchObject({ folder: "INBOX", imapUid: 1 });

    const result = await moveThreads(
      handle.db, actorId,
      { threadIds: [stored?.threadId ?? ""], folder: "INBOX", action: "archive" },
      { syncManager: { get: () => sync }, logger: silentLogger },
    );
    expect(result.results).toEqual([{ threadId: stored?.threadId, ok: true }]);

    // Optimistic and correct: the message really has left INBOX, and its UID
    // is NULL because the old number names nothing in the new mailbox.
    expect([...client.folder("INBOX").messages.keys()]).toEqual([]);
    expect([...client.folder("Archive").messages.keys()]).toEqual([1]);
    expect((await messageRows())[0]).toMatchObject({ folder: "Archive", imapUid: null });

    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass that re-sights it");

    const after = await messageRows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ folder: "Archive", imapUid: 1, threadId: stored?.threadId });
    expect(await handle.db.select().from(mailThreads)).toHaveLength(1);
  });
});

// --- SyncManager ------------------------------------------------------------

describe("SyncManager", () => {
  const clients: FakeImapClient[] = [];

  function makeManager(clock: ManualClock = new ManualClock()): SyncManager {
    const manager = new SyncManager({
      db: handle.db, dataDir, mailKeyPath: keyPath,
      clientFactory: (settings) => {
        const client = new FakeImapClient(settings);
        clients.push(client);
        return client;
      },
      clock,
      logger: silentLogger,
      pollIntervalMs: 300_000,
    });
    running.push(manager);
    return manager;
  }

  beforeEach(() => { clients.length = 0; });

  it("starts one AccountSync per non-archived account", async () => {
    const first = await makeAccount({ email: "one@example.com", label: "One" });
    const second = await makeAccount({ email: "two@example.com", label: "Two" });
    const archived = await makeAccount({ email: "three@example.com", label: "Three" });
    await archiveAccount(handle.db, actorId, archived);

    const manager = makeManager();
    await manager.start();

    expect(manager.get(first)).toBeDefined();
    expect(manager.get(second)).toBeDefined();
    expect(manager.get(archived)).toBeUndefined();
    await waitFor(() => (manager.get(first)?.stats.passes ?? 0) >= 1, "the first account's pass");
  });

  it("creates, restarts and tears down a sync as accounts change", async () => {
    const manager = makeManager();
    await manager.start();

    // Create: the hook fires from inside createAccount.
    const accountId = await makeAccount();
    await waitFor(() => manager.get(accountId) !== undefined, "the new account's sync");
    const created = manager.get(accountId);
    await waitFor(() => (created?.stats.passes ?? 0) >= 1, "its first pass");

    // Update to a connection field: restarted, so the next pass uses the new
    // settings. A restart is a NEW AccountSync, not the same one resumed.
    await updateAccount(handle.db, actorId, accountId, { username: "someone-else" }, keyPath);
    await waitFor(() => manager.get(accountId) !== undefined && manager.get(accountId) !== created,
      "the restarted sync");
    expect(created?.stats.stopped).toBe(true);

    // Archive: torn down.
    await archiveAccount(handle.db, actorId, accountId);
    await waitFor(() => manager.get(accountId) === undefined, "the sync to be torn down");
  });

  it("serialises overlapping reconciles for one account", async () => {
    const manager = makeManager();
    await manager.start();
    const accountId = await makeAccount();
    await waitFor(() => manager.get(accountId) !== undefined, "the initial sync");

    await Promise.all([
      manager.accountChanged(accountId),
      manager.accountChanged(accountId),
      manager.accountChanged(accountId),
    ]);
    // Exactly one survivor, and it must be ALIVE. Waiting for the survivor
    // to complete a pass is what makes that real: asserting only "at most
    // one live client" would pass with two loops running (before either
    // connected) and would also pass with everything dead.
    const survivor = manager.get(accountId);
    expect(survivor).toBeDefined();
    await waitFor(() => (survivor?.stats.passes ?? 0) >= 1, "the surviving sync's pass");
    const live = clients.filter((client) => client.connectCalls > 0 && client.disconnectCalls === 0);
    expect(live).toHaveLength(1);
  });

  it("restarts on a connection change but only wakes on any other edit", async () => {
    const manager = makeManager();
    await manager.start();
    const accountId = await makeAccount();
    await waitFor(() => manager.get(accountId) !== undefined, "the new account's sync");
    const original = manager.get(accountId);
    await waitFor(() => (original?.stats.passes ?? 0) >= 1, "its first pass");

    // Task 9's settings form autosaves the signature editor. Dropping the
    // IMAP connection and re-LOGINing per keystroke-debounce would be absurd
    // -- the running loop re-reads the account row every pass anyway.
    await updateAccount(handle.db, actorId, accountId, { label: "Renamed" }, keyPath);
    await waitFor(() => (original?.stats.passes ?? 0) >= 2, "the woken pass");
    expect(manager.get(accountId)).toBe(original);
    expect(original?.stats.stopped).toBe(false);

    // A host change, though, invalidates the live connection entirely.
    await updateAccount(handle.db, actorId, accountId, { imapHost: "elsewhere.example.com" }, keyPath);
    await waitFor(() => manager.get(accountId) !== undefined && manager.get(accountId) !== original,
      "the restarted sync");
    expect(original?.stats.stopped).toBe(true);
  });

  it("syncNow wakes an existing sync and creates one that is missing", async () => {
    const accountId = await makeAccount();
    const manager = makeManager();
    await manager.start();
    const sync = manager.get(accountId);
    await waitFor(() => (sync?.stats.passes ?? 0) >= 1, "the first pass");

    await manager.syncNow(accountId);
    await waitFor(() => (sync?.stats.passes ?? 0) >= 2, "the requested pass");

    // Now with no sync in the map at all: a stopped sync removes itself, and
    // syncNow has to build a new one rather than doing nothing.
    const other = await makeAccount({ email: "other@example.com", label: "Other" });
    await waitFor(() => manager.get(other) !== undefined, "the second account's sync");
    await manager.get(other)?.stop();
    await waitFor(() => manager.get(other) === undefined, "the stopped sync to drop out of the map");
    await manager.syncNow(other);
    expect(manager.get(other)).toBeDefined();
  });

  it("stops every sync and unregisters its hook", async () => {
    const manager = makeManager();
    await manager.start();
    const accountId = await makeAccount();
    await waitFor(() => manager.get(accountId) !== undefined, "the new account's sync");
    const sync = manager.get(accountId);

    await manager.stop();
    expect(sync?.stats.stopped).toBe(true);
    expect(manager.get(accountId)).toBeUndefined();

    // The hook is gone: further CRUD must not resurrect anything.
    const late = await makeAccount({ email: "late@example.com", label: "Late" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.get(late)).toBeUndefined();
  });

  it("bounds the wait for a WEDGED reconcile, not just for the syncs", async () => {
    const clock = new ManualClock();
    const manager = makeManager(clock);
    await manager.start();
    const accountId = await makeAccount();
    await waitFor(() => manager.get(accountId) !== undefined, "the account's sync");
    await waitFor(() => (manager.get(accountId)?.stats.passes ?? 0) >= 1, "its first pass");

    // A reconcile's own await is `existing.stop()`, so a teardown that never
    // finishes wedges the chain that is stopping it. Nothing in the
    // ImapClient contract is cancellable except idle(), so this is exactly
    // what a socket sitting inside an adapter's timeout looks like from here.
    let release = (): void => { /* replaced below */ };
    const wedge = new Promise<void>((resolve) => { release = resolve; });
    for (const client of clients) client.disconnectGate = wedge;
    const reconcile = manager.accountChanged(accountId);
    await waitFor(() => clients.some((client) => client.disconnectCalls > 0), "the wedged teardown");

    // stop() must still return: the drain is inside the deadline now, so the
    // timeout can fire. (Before, the drain ran to completion FIRST and this
    // wait would never even be requested -- the 15s cap was there while
    // nothing needed capping.)
    const stopping = manager.stop();
    await waitFor(() => clock.pendingCount() > 0, "the stop deadline");
    clock.fire();
    await stopping;

    // Let the abandoned reconcile unwind, so nothing outlives the test.
    release();
    await reconcile;
  });
});

describe("startSyncManager", () => {
  const options = () => ({
    db: handle.db, dataDir, mailKeyPath: keyPath, logger: silentLogger,
    clientFactory: (settings: ImapConnectionSettings) => new FakeImapClient(settings),
  });

  it("starts nothing under NODE_ENV=test", async () => {
    await makeAccount();
    expect(await startSyncManager({ ...options(), nodeEnv: "test" })).toBeNull();
  });

  it("starts nothing when the process environment says test, whatever the config says", async () => {
    // The backstop for a caller that builds these options by hand.
    expect(process.env.NODE_ENV).toBe("test");
    expect(await startSyncManager({ ...options(), nodeEnv: "production" })).toBeNull();
  });

  it("starts nothing until an IMAP adapter is supplied", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { clientFactory, ...withoutFactory } = options();
      void clientFactory;
      expect(await startSyncManager({ ...withoutFactory, nodeEnv: "production" })).toBeNull();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("starts the manager outside tests once an adapter exists", async () => {
    const accountId = await makeAccount();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let manager: SyncManager | null = null;
    try {
      manager = await startSyncManager({ ...options(), nodeEnv: "production", clock: new ManualClock() });
      expect(manager).not.toBeNull();
      expect(manager?.get(accountId)).toBeDefined();
    } finally {
      process.env.NODE_ENV = previous;
      if (manager !== null) await manager.stop();
    }
  });
});
