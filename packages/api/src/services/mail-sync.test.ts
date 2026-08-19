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
import { mailAccounts, mailFolderState, mailMessages, mailThreads } from "../db/schema.js";
import { MailIngestError, NotFoundError } from "./errors.js";
import { archiveAccount, createAccount, updateAccount } from "./mail-accounts.js";
import { ingestMessage } from "./mail-ingest.js";
import {
  AccountSync, SyncManager, SyncStoppedError, startSyncManager,
  type FetchNewerOptions, type IdleOutcome, type ImapClient, type ImapConnectionSettings,
  type ImapMessageDescriptor, type IngestMessageFn, type SyncClock, type SyncLogger,
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
  connectCalls = 0;
  disconnectCalls = 0;
  connectError: Error | null = null;
  statusError: Error | null = null;
  setFlagsError: Error | null = null;
  idleError: Error | null = null;
  idleEntries = 0;
  /** uid -> how many more times fetchRaw should throw for it. */
  readonly fetchRawFailures = new Map<number, number>();
  /** uids fetchRaw reports as expunged. */
  readonly vanished = new Set<number>();
  /** While set, fetchRaw blocks on it -- used to hold a pass open. */
  gate: Promise<void> | null = null;
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
  }

  async status(folder: string): Promise<{ uidvalidity: number; uidnext: number }> {
    return this.track({ op: "status", folder }, () => {
      if (this.statusError !== null) throw this.statusError;
      const target = this.folder(folder);
      const uids = [...target.messages.keys()];
      return { uidvalidity: target.uidvalidity, uidnext: Math.max(0, ...uids) + 1 };
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

  async fetchFlags(folder: string, sinceDate: Date): Promise<ImapMessageDescriptor[]> {
    return this.track({ op: "fetchFlags", folder }, () => {
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

  async setFlags(folder: string, uids: number[], flags: string[]): Promise<void> {
    await this.track({ op: "setFlags", folder, uids: [...uids] }, () => {
      if (this.setFlagsError !== null) throw this.setFlagsError;
      const target = this.folder(folder);
      for (const uid of uids) {
        const message = target.messages.get(uid);
        if (message === undefined) continue;
        for (const flag of flags) if (!message.flags.includes(flag)) message.flags.push(flag);
      }
    });
  }

  idle(folder: string, signal: AbortSignal): Promise<IdleOutcome> {
    this.calls.push({ op: "idle", folder });
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

  /** End every wait currently outstanding, as if its timer had elapsed. */
  fire(): void {
    const snapshot = this.pending;
    this.pending = [];
    for (const entry of snapshot) {
      if (entry.done) continue;
      entry.done = true;
      entry.resolve();
    }
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
  options: { clock?: ManualClock; ingest?: IngestMessageFn; pollIntervalMs?: number } = {},
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
    logger: silentLogger,
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

  it("degrades to poll-only when the server has no IDLE, without spinning", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client, clock } = makeSync(accountId);
    client.idleError = new Error("IDLE not supported");

    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await waitFor(() => client.idleEntries >= 1, "the failed IDLE");

    // The pass count must NOT be climbing: a failed IDLE waits out the poll
    // interval instead of returning straight into another pass.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sync.stats.passes).toBe(1);
    await waitFor(() => clock.pendingCount() > 0, "the poll wait");
    clock.fire();
    await waitFor(() => sync.stats.passes >= 2, "the polled pass");
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

    await handle.db.delete(mailFolderState).where(eq(mailFolderState.accountId, accountId));
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
    expect(client.opsOf("setFlags")).toHaveLength(0);

    client.gate = null;
    release();
    await queued;

    expect(client.maxInFlight).toBe(1);
    const setFlagsIndex = client.calls.findIndex((call) => call.op === "setFlags");
    const lastFetchIndex = client.calls.map((call) => call.op).lastIndexOf("fetchRaw");
    expect(setFlagsIndex).toBeGreaterThan(lastFetchIndex);
    expect(client.opsOf("setFlags")[0]?.uids).toEqual([1, 2]);
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

    client.setFlagsError = new Error("connection lost");
    // A user pressing "mark read" while the mail server is misbehaving gets
    // the failure back -- but it must not be what marks their account broken.
    await expect(sync.markSeen("INBOX", [1])).rejects.toThrow("connection lost");
    expect((await accountRow(accountId)).status).toBe("active");
    expect(sync.stats.failures).toBe(0);
    expect(sync.stats.stopped).toBe(false);

    // And the loop carries on: the next pass still runs.
    client.setFlagsError = null;
    sync.wake();
    await waitFor(() => sync.stats.passes >= 2, "the pass after the failed task");
  });

  it("markSeen with no uids does nothing at all", async () => {
    const accountId = await makeAccount({ backfillDays: null });
    const { sync, client } = makeSync(accountId);
    sync.start();
    await waitFor(() => sync.stats.passes >= 1, "the first pass");
    await sync.markSeen("INBOX", []);
    expect(client.opsOf("setFlags")).toHaveLength(0);
  });
});

// --- SyncManager ------------------------------------------------------------

describe("SyncManager", () => {
  const clients: FakeImapClient[] = [];

  function makeManager(): SyncManager {
    const manager = new SyncManager({
      db: handle.db, dataDir, mailKeyPath: keyPath,
      clientFactory: (settings) => {
        const client = new FakeImapClient(settings);
        clients.push(client);
        return client;
      },
      clock: new ManualClock(),
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

    // Update: restarted, so the next pass uses the new settings. A restart is
    // a NEW AccountSync, not the same one resumed.
    await updateAccount(handle.db, actorId, accountId, { label: "Renamed" }, keyPath);
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
    // Exactly one survivor -- overlapping reconciles must never leave two
    // loops ingesting one mailbox.
    expect(manager.get(accountId)).toBeDefined();
    const live = clients.filter((client) => client.disconnectCalls === 0);
    expect(live.length).toBeLessThanOrEqual(1);
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
