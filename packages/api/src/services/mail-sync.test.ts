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
  connectCalls = 0;
  disconnectCalls = 0;
  connectError: Error | null = null;
  listError: Error | null = null;
  statusError: Error | null = null;
  addFlagsError: Error | null = null;
  idleError: Error | null = null;
  idleEntries = 0;
  /** uid -> how many more times fetchRaw should throw for it. */
  readonly fetchRawFailures = new Map<number, number>();
  /** uids fetchRaw reports as expunged. */
  readonly vanished = new Set<number>();
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
      return { uidvalidity: this.folder(folder).uidvalidity };
    });
  }

  async fetchNewer(folder: string, options: FetchNewerOptions): Promise<ImapMessageDescriptor[]> {
    return this.track({ op: "fetchNewer", folder }, () => {
      this.fetchNewerOptions.push(options);
      const target = this.folder(folder);
      return [...target.messages.entries()]
        .filter(([uid]) => uid > options.sinceUid)
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
    expect(clock.requested[0]).toBe(60_000);

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
    for (let failure = 1; failure <= 8; failure += 1) {
      await waitFor(() => sync.stats.failures >= failure, `failure ${failure}`);
      await waitFor(() => clock.pendingCount() > 0, `backoff wait ${failure}`);
      clock.fire();
    }
    expect(clock.requested.slice(0, 8)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 1_920_000, 1_920_000,
    ]);
    expect((await accountRow(accountId)).status).toBe("error");

    client.connectError = null;
    await waitFor(() => sync.stats.passes >= 1, "the recovery pass");
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
