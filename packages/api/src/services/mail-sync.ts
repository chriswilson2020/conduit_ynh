import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { MailSecurity } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, mailFolderState, mailMessages, type MailAccountRow } from "../db/schema.js";
import { ArchivedError, MailIngestError, NotFoundError } from "./errors.js";
import {
  consoleSyncLogger, systemClock as systemSyncClock,
  type ImapClient, type ImapClientFactory, type ImapMessageDescriptor,
  type IngestMessageFn, type SyncClock, type SyncLogger,
} from "./mail-imap.js";
import { getAccountCredentialsAsSystem, setAccountChangedHook } from "./mail-accounts.js";
import { ingestMessage } from "./mail-ingest.js";
import { publish } from "./sse.js";

/**
 * The sync engine: one `AccountSync` per non-archived mail account, owned by
 * a process-wide `SyncManager` that starts after the server is listening.
 *
 * The whole design rests on one property: an AccountSync is a SINGLE async
 * loop, so everything it does to one account -- passes, queued \Seen
 * write-backs, APPENDs -- is serialised by construction rather than by
 * locking. That is the in-process analogue of the Phase 2/3 advisory-lock
 * convention, and it is why mail folder cursors need no database lock: no
 * two writers ever race one (account, folder) cursor. (Thread resolution is
 * the exception and takes a global advisory lock -- see mail-ingest.ts.)
 *
 * Nothing in here may take the server down. Every entry point is
 * exception-guarded, every wait is abortable, and the two failure classes are
 * deliberately kept apart:
 *
 * - A PASS-LEVEL failure (connect, status, fetch, or a database error) flips
 *   the account to `status='error'` with a truncated `last_error` and backs
 *   off 60s * 2^attempt to a 32-minute cap.
 * - A POISON MESSAGE (one message that will not ingest) does NOT. It is
 *   retried once, then its UID is skipped and the cursor moves past it, with
 *   a note in `last_error` and the account still `active`. One unparseable
 *   or hostile message must never wedge a mailbox behind a cursor that will
 *   not advance.
 */

/** The folder every account syncs, alongside its own `sent_folder`. */
export const INBOX = "INBOX";

/** UIDs fetched per batch. The cursor advances once per batch, so this is
 * also the most work an interrupted pass can have to redo. */
const BATCH_SIZE = 50;

/** How far back each pass reconciles `\Seen` (spec: "a cheap FLAGS-only
 * fetch for messages from the last 30 days"). Older mail's read state is
 * whatever the CRM last saw; nobody goes back and un-reads year-old mail. */
const FLAG_RECONCILE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Spec: "Poll interval 5 minutes." Injectable so tests do not wait. */
export const DEFAULT_POLL_INTERVAL_MS = 300_000;

/** Spec: per-account exponential backoff, 1min -> 32min cap. */
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 32 * 60_000;

/**
 * Retries of one message's ingest inside a single pass before its UID is
 * skipped (poison contract). One retry, not more: the failures a retry
 * genuinely fixes are transient and immediate (a serialisation failure, the
 * "raced another writer" rollback in mail-ingest.ts), while the failures it
 * cannot fix -- an oversized header block, a message that breaks the parser
 * -- are pure functions of the bytes and would fail identically forever.
 */
const POISON_RETRIES = 1;

/** UIDs per addFlags/UPDATE statement, so a mailbox-wide operation cannot
 * become one statement with tens of thousands of bind parameters. */
const UID_CHUNK = 500;

/** mail_accounts.last_error is rendered verbatim in the settings UI, so a
 * driver error quoting a megabyte of SQL parameters must not become a
 * megabyte row. (MailIngestError truncates its own `reason` to 200 already;
 * this covers everything else.) */
const MAX_LAST_ERROR_CHARS = 500;

const SEEN_FLAG = "\\Seen";

/** How long SyncManager.stop() waits for its syncs before abandoning them.
 * Generous enough for any operation that is merely slow, short enough that a
 * systemd restart does not stall behind one wedged socket. */
const STOP_TIMEOUT_MS = 15_000;

// --- The IMAP seam ---------------------------------------------------------
//
// The interface, its types, the clock and the logger live in mail-imap.ts --
// that is the file Task 6's adapter is written against, and it carries the
// full adapter contract as doc comments. Re-exported here so nothing that
// already imports them from mail-sync.ts has to move.

export type {
  ImapClient, ImapClientFactory, ImapConnectionSettings, ImapFolderStatus,
  ImapMessageDescriptor, FetchNewerOptions, IdleOutcome,
  SyncClock, SyncLogger, IngestMessageFn,
} from "./mail-imap.js";
export { systemClock } from "./mail-imap.js";

// --- Helpers ---------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** IMAP system flags are case-insensitive (RFC 3501). */
function hasSeenFlag(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === "\\seen");
}

/**
 * "This account should not be syncing at all any more", as opposed to "this
 * pass failed". Deleting or archiving an account is not an error to back off
 * from -- there is nothing to retry, so the AccountSync tears itself down.
 *
 * The MailIngestError branch covers a deletion that lands mid-pass: ingest
 * wraps the original failure on `cause`, and the only NotFoundError ingest
 * can raise for a sync caller is the missing account row (the other one,
 * an unknown thread, needs an explicit `threadId` that only mail-send
 * passes).
 */
function isTeardownError(error: unknown): boolean {
  if (error instanceof NotFoundError || error instanceof ArchivedError) return true;
  if (error instanceof MailIngestError) return error.cause instanceof NotFoundError;
  return false;
}

/** Rejection handed to queued work that never got to run. */
export class SyncStoppedError extends Error {
  constructor(accountId: string) {
    super(`mail sync for account ${accountId} has stopped`);
  }
}

/**
 * Queued work refused WITHOUT touching the network, because the account is
 * in backoff after a failed pass. Two reasons it fails fast rather than
 * trying: the connection is known to be broken, so the attempt would only
 * add another connect to the rate the backoff exists to limit; and Task 7's
 * route gets an immediate, explanatory answer for the user instead of one
 * that arrives a connect-timeout later with nothing useful in it. The stored
 * `last_error` rides along for exactly that.
 */
export class SyncUnavailableError extends Error {
  readonly lastError: string | null;
  constructor(accountId: string, lastError: string | null) {
    super(
      `mail sync for account ${accountId} is in backoff after a failed pass`
      + (lastError === null ? "" : `: ${lastError}`),
    );
    this.lastError = lastError;
  }
}

interface QueuedTask {
  readonly label: string;
  run(client: ImapClient, account: MailAccountRow): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

type PassOutcome = "ok" | "failed" | "teardown";

export interface AccountSyncStats {
  /** Passes that completed without a pass-level failure. */
  passes: number;
  failures: number;
  /** Messages ingested (new or re-sighted), across all passes. */
  ingested: number;
  /** Messages whose UID was skipped by the poison contract. */
  poisonSkips: number;
  /** IDLE returns that reported new mail (as opposed to a poll timeout). */
  idleWakes: number;
  /** Consecutive failures; drives the backoff. */
  attempt: number;
  stopped: boolean;
}

export interface AccountSyncOptions {
  db: Database;
  accountId: string;
  /** Blob storage root, threaded to ingest (see mail-ingest.ts). */
  dataDir: string;
  mailKeyPath: string;
  clientFactory: ImapClientFactory;
  clock?: SyncClock;
  logger?: SyncLogger;
  pollIntervalMs?: number;
  /** Test seam only -- see IngestMessageFn. */
  ingest?: IngestMessageFn;
  /** Invoked once when the loop has finished, however it ended. The manager
   * uses it to drop a sync that tore itself down (account deleted/archived
   * mid-pass) instead of leaving a dead entry in its map. */
  onStopped?: (accountId: string) => void;
}

// --- AccountSync -----------------------------------------------------------

/**
 * One account's sync loop. Created stopped; `start()` kicks the loop, which
 * then runs until `stop()` or until the account goes away.
 *
 * One iteration is: drain queued work -> run a pass -> wait (IDLE capped at
 * the poll interval after a good pass, backoff after a bad one). Everything
 * is inside the one loop, so queued work never runs concurrently with a
 * pass, and neither ever runs twice at once.
 */
export class AccountSync {
  readonly accountId: string;

  private readonly db: Database;
  private readonly dataDir: string;
  private readonly mailKeyPath: string;
  private readonly clientFactory: ImapClientFactory;
  private readonly clock: SyncClock;
  private readonly logger: SyncLogger;
  private readonly pollIntervalMs: number;
  private readonly ingest: IngestMessageFn;
  private readonly onStopped: ((accountId: string) => void) | null;

  private readonly queue: QueuedTask[] = [];
  /** Aborts whatever wait the loop is currently in (idle, poll cap, backoff).
   * Replaced per wait; null while the loop is doing actual work. */
  private waitController: AbortController | null = null;
  private client: ImapClient | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private tornDown = false;
  /**
   * A pass is owed. Latched (rather than acted on directly) so a request
   * arriving while the loop is mid-pass cannot be lost in the gap between
   * that pass finishing and the next wait starting; consumed by the loop
   * when it actually starts the pass, so one request buys exactly one pass.
   *
   * True initially: start() runs a pass immediately.
   */
  private passDue = true;
  /**
   * Epoch ms the current poll/backoff wait is due to end, or null when no
   * wait is outstanding. A DEADLINE rather than a duration, so an
   * interruption resumes the remainder instead of restarting the clock --
   * see waitForWork for the three failures that fixes.
   */
  private waitUntil: number | null = null;
  /**
   * Set when the server rejected IDLE; after that the loop polls and never
   * asks again.
   *
   * Deliberately NOT cleared by the reconnect that the rejection itself
   * causes. That reconnect happens at the start of the very next pass, so
   * clearing there would have the loop ask again one poll interval later,
   * fail again, log again and reconnect again -- 288 times a day, which is
   * the entire behaviour this latch exists to remove. It is cleared instead
   * on recovery from a pass-level FAILURE, where the connection really was
   * broken and a fresh answer is worth having, and it is per-instance, so a
   * manager restart (settings change) clears it too.
   *
   * The cost of a false positive -- a one-off IDLE error on a server that
   * does support it -- is that the account polls every five minutes instead
   * of getting instant push, until its next failure or restart. That is the
   * spec's "degrade to poll-only silently", and a far better trade than a
   * reconnect storm.
   */
  private idleUnsupported = false;
  private attempt = 0;
  /** Poison skips recorded during the CURRENT pass; written to last_error
   * when the pass completes. */
  private passSkips = 0;
  private passLastSkip: string | null = null;
  /** Per-pass tallies for the pass-complete log line. */
  private passIngested = 0;
  private passFlagChanges = 0;
  /** Mirror of the account row's last_error, so queued work refused during a
   * backoff can explain itself without a database read. */
  private lastErrorText: string | null = null;

  private readonly counters = {
    passes: 0, failures: 0, ingested: 0, poisonSkips: 0, idleWakes: 0,
  };

  constructor(options: AccountSyncOptions) {
    this.accountId = options.accountId;
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.mailKeyPath = options.mailKeyPath;
    this.clientFactory = options.clientFactory;
    this.clock = options.clock ?? systemSyncClock;
    this.logger = options.logger ?? consoleSyncLogger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.ingest = options.ingest ?? ingestMessage;
    this.onStopped = options.onStopped ?? null;
  }

  get stats(): Readonly<AccountSyncStats> {
    return { ...this.counters, attempt: this.attempt, stopped: this.stopped };
  }

  /** Idempotent; a stopped sync cannot be restarted (the manager makes a new
   * one instead, so a restart always picks up fresh settings). */
  start(): void {
    if (this.loopPromise !== null || this.stopped) return;
    this.loopPromise = this.runLoop();
  }

  /** Run a pass as soon as the loop is free, cutting any wait short. */
  wake(): void {
    this.passDue = true;
    this.interrupt();
  }

  /** End whatever wait the loop is in, without claiming a pass is due. */
  private interrupt(): void {
    this.waitController?.abort();
  }

  /** Why queued work cannot run right now, or null when it can. */
  private whyUnavailable(): Error | null {
    if (this.stopped) return new SyncStoppedError(this.accountId);
    // attempt > 0 means the last pass failed and the loop is sitting in a
    // backoff. Queuing here would open a fresh TCP connection and LOGIN per
    // task, at whatever rate the UI produces them -- straight through the
    // rate limit the backoff exists to impose.
    if (this.attempt > 0) return new SyncUnavailableError(this.accountId, this.lastErrorText);
    return null;
  }

  /**
   * Queue a `\Seen` write-back onto the loop (routes/mail.ts's thread-read
   * handler, Task 7). Resolves once the flags are on the server.
   *
   * REJECTS if the operation failed or the sync stopped first
   * (SyncStoppedError), so the returned promise must always be handled --
   * this is a best-effort side channel, and a caller that leaves it floating
   * turns a mail server hiccup into an unhandled rejection.
   *
   * Rejects IMMEDIATELY, without touching the network, while the account is
   * in backoff: see whyUnavailable.
   */
  markSeen(folder: string, uids: readonly number[]): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    const list = [...uids];
    return this.enqueue("markSeen", async (client) => {
      for (const batch of chunked(list, UID_CHUNK)) {
        await client.addFlags(folder, batch, [SEEN_FLAG]);
      }
    });
  }

  /**
   * Queue an APPEND of a just-sent message to the account's Sent folder
   * (mail-send, Task 6). The folder is read from the account row at run
   * time, not captured at call time, so a sent_folder edit takes effect
   * without a restart.
   *
   * Rejects on failure, and must be handled for the same reason as markSeen
   * -- the send already succeeded by the time this runs, so its failure is a
   * warning to log, never something to fail a request over. Same immediate
   * rejection while the account is in backoff.
   */
  appendSent(raw: Buffer | string): Promise<void> {
    return this.enqueue("appendSent", async (client, account) => {
      // Already trimmed by loadAccount; empty means the stored value was
      // nothing but whitespace, and there is no mailbox to append to.
      if (account.sentFolder.length === 0) {
        throw new Error(`mail account ${account.id} has no sent folder configured`);
      }
      await client.append(account.sentFolder, raw, [SEEN_FLAG]);
    });
  }

  /** Abort the current wait, let the loop unwind, disconnect. Idempotent,
   * and safe to call before start(). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.waitController?.abort();
    const loop = this.loopPromise;
    if (loop === null) {
      await this.teardown();
      return;
    }
    await loop;
  }

  // --- The loop ------------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      // Carried across iterations because an iteration can be queue-only:
      // whether the LAST pass succeeded is what decides between an IDLE wait
      // and a backoff, and a markSeen in between must not lose that.
      let passSucceeded = true;
      while (!this.stopped) {
        await this.drainQueue();
        if (this.stopped) break;
        // A pass runs only when one is DUE -- start, an IDLE wake, the poll
        // timer, an elapsed backoff, or an explicit syncNow. Queued work
        // wakes the loop but never marks a pass due (see enqueue).
        if (this.passDue) {
          this.passDue = false;
          const outcome = await this.runPassGuarded();
          if (this.stopped) break;
          if (outcome === "teardown") {
            this.stopped = true;
            break;
          }
          passSucceeded = outcome === "ok";
        }
        await this.waitForWork(passSucceeded);
      }
    } catch (error) {
      // Unreachable by design -- drainQueue, runPassGuarded and
      // waitForWork all swallow their own failures. If it ever fires,
      // this account stops syncing (loudly) and the rest of the server, and
      // every other account, carries on.
      this.logger.error(
        { accountId: this.accountId, err: errorText(error) },
        "mail-sync: sync loop crashed",
      );
    } finally {
      await this.teardown();
    }
  }

  private async teardown(): Promise<void> {
    this.stopped = true;
    // Runs exactly once, whichever path gets here first: the loop's own
    // finally, or a stop() on a sync that was never started. onStopped is a
    // map deletion in the manager, and firing it twice would be able to
    // delete an account's REPLACEMENT sync.
    if (this.tornDown) return;
    this.tornDown = true;
    const pending = this.queue.splice(0, this.queue.length);
    for (const task of pending) task.reject(new SyncStoppedError(this.accountId));
    await this.dropClient();
    const notify = this.onStopped;
    if (notify !== null) {
      try {
        notify(this.accountId);
      } catch (error) {
        this.logger.error(
          { accountId: this.accountId, err: errorText(error) },
          "mail-sync: onStopped callback threw",
        );
      }
    }
  }

  // --- Queued work ---------------------------------------------------------

  private enqueue(
    label: string,
    run: (client: ImapClient, account: MailAccountRow) => Promise<void>,
  ): Promise<void> {
    const unavailable = this.whyUnavailable();
    if (unavailable !== null) return Promise.reject(unavailable);
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ label, run, resolve, reject });
      // interrupt, NOT wake: the loop should come back and run this task
      // now, but queued work must not drag a whole pass along behind it.
      // Task 7 calls markSeen once per thread the user opens, and a
      // status/fetchNewer/fetchFlags round over both folders per click would
      // be pure waste -- passes belong to IDLE, the poll timer and syncNow.
      this.interrupt();
    });
  }

  /**
   * Runs queued work between passes. A queued task's failure belongs to its
   * CALLER (the route awaiting a best-effort `\Seen` write-back, mail-send
   * awaiting an APPEND) -- it rejects that caller's promise and is logged,
   * but it deliberately does not flip the account to `error` or start a
   * backoff. A user pressing "mark read" while the mail server is down must
   * not be what marks their account broken; the next pass will discover the
   * same problem and handle it properly.
   */
  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const task = this.queue.shift();
      if (task === undefined) break;
      try {
        const account = await this.loadAccount();
        const client = await this.ensureConnected(account);
        await task.run(client, account);
        task.resolve();
      } catch (error) {
        this.logger.warn(
          { accountId: this.accountId, task: task.label, err: errorText(error) },
          "mail-sync: queued task failed",
        );
        task.reject(error);
        if (isTeardownError(error)) {
          this.stopped = true;
          return;
        }
        // The connection is suspect after any failure here; the next
        // task (or the pass that follows) reconnects.
        await this.dropClient();
      }
    }
  }

  // --- One pass ------------------------------------------------------------

  private async runPassGuarded(): Promise<PassOutcome> {
    this.passSkips = 0;
    this.passLastSkip = null;
    this.passIngested = 0;
    this.passFlagChanges = 0;
    // A pass just ran, so any poll/backoff deadline still standing is spent:
    // the next one is measured from the end of THIS pass, not from whenever
    // the previous wait happened to be set up.
    this.waitUntil = null;
    const startedAt = this.clock.now().getTime();
    try {
      await this.runPass();
      if (this.stopped) return "ok";
      // A successful pass clears status/last_error -- EXCEPT for a poison
      // note from this same pass, which has to survive its own pass or it
      // would be written and cleared in the same breath.
      const note = this.passNote();
      await this.writeAccountState({ status: "active", lastError: note, touchSynced: true });
      this.attempt = 0;
      this.lastErrorText = note;
      this.counters.passes += 1;
      // One line per pass, at info. This is the only routine signal that the
      // engine is alive at all, and without it a mailbox that quietly stops
      // receiving looks identical to one nobody is writing to.
      this.logger.info(
        {
          accountId: this.accountId,
          ingested: this.passIngested,
          flagChanges: this.passFlagChanges,
          skipped: this.passSkips,
          ms: this.clock.now().getTime() - startedAt,
        },
        "mail-sync: pass complete",
      );
      return "ok";
    } catch (error) {
      if (isTeardownError(error)) {
        this.logger.info(
          { accountId: this.accountId, reason: errorText(error) },
          "mail-sync: account is gone or archived, stopping its sync",
        );
        return "teardown";
      }
      this.logger.error(
        { accountId: this.accountId, attempt: this.attempt, err: errorText(error) },
        "mail-sync: pass failed",
      );
      await this.dropClient();
      // The connection was genuinely broken, so whatever it told us about
      // IDLE is not evidence about the server -- give it another chance on
      // the next one.
      this.idleUnsupported = false;
      const failureText = truncate(errorText(error), MAX_LAST_ERROR_CHARS);
      // Kept in memory too, so queued work refused during the backoff can
      // tell its caller WHY without a database read (see whyUnavailable).
      this.lastErrorText = failureText;
      try {
        await this.writeAccountState({
          status: "error",
          lastError: failureText,
          touchSynced: false,
        });
      } catch (writeError) {
        // The database is a plausible cause of the failure we are recording,
        // so failing to record it is expected, not exceptional. The backoff
        // below still happens.
        this.logger.error(
          { accountId: this.accountId, err: errorText(writeError) },
          "mail-sync: could not record the failure on the account",
        );
      }
      this.attempt += 1;
      // Counted LAST, after the account row reflects the failure: the
      // counters are the only handle a caller (or a test) has on "this pass
      // is fully dealt with", so bumping one before the write would expose a
      // window where the failure is visible but the row still says active.
      this.counters.failures += 1;
      return "failed";
    }
  }

  private passNote(): string | null {
    if (this.passSkips === 0 || this.passLastSkip === null) return null;
    // Latest note wins, with a count -- not a literal append to whatever was
    // there before. last_error is one column shown verbatim in settings, and
    // a mailbox holding a hundred hostile messages would otherwise grow it
    // into a hundred-line blob that nothing ever trims.
    const prefix = this.passSkips === 1
      ? "skipped 1 unreadable message"
      : `skipped ${this.passSkips} unreadable messages`;
    return truncate(`${prefix}; last: ${this.passLastSkip}`, MAX_LAST_ERROR_CHARS);
  }

  private async runPass(): Promise<void> {
    const account = await this.loadAccount();
    const client = await this.ensureConnected(account);
    for (const folder of foldersOf(account)) {
      if (this.stopped) return;
      await this.syncFolder(client, account, folder);
    }
  }

  /** Re-read every pass, so a sent_folder or backfill change takes effect
   * without waiting for the manager's restart, and so a deletion or archive
   * is noticed promptly. */
  private async loadAccount(): Promise<MailAccountRow> {
    const [row] = await this.db.select().from(mailAccounts)
      .where(eq(mailAccounts.id, this.accountId));
    if (row === undefined) throw new NotFoundError("mail account", this.accountId);
    if (row.archivedAt !== null) throw new ArchivedError("mail account", this.accountId);
    // The one choke point for sent_folder normalisation: every consumer in
    // this file reads the account through here, so a stored " Sent " cannot
    // have the pass walk `Sent` while an APPEND goes to `" Sent "` -- two
    // different mailboxes as far as an IMAP server is concerned. Normalising
    // at each use site instead is exactly how those two drift apart.
    return { ...row, sentFolder: row.sentFolder.trim() };
  }

  /** One connection per AccountSync, kept between passes because IDLE needs
   * it. Dropped (and rebuilt on the next pass) after any failure. */
  private async ensureConnected(account: MailAccountRow): Promise<ImapClient> {
    const existing = this.client;
    if (existing !== null) return existing;
    // Read per connection rather than per pass: credentials only matter when
    // a connection is being made, and getAccountCredentialsAsSystem throws
    // ArchivedError for an archived account, which isTeardownError treats as
    // "stop syncing this account" exactly like the loadAccount check above.
    const credentials = await getAccountCredentialsAsSystem(this.db, account.id, this.mailKeyPath);
    const client = this.clientFactory({
      accountId: account.id,
      host: account.imapHost,
      port: account.imapPort,
      security: account.imapSecurity as MailSecurity,
      username: account.username,
      password: credentials.imapPassword,
    });
    try {
      await client.connect();
    } catch (error) {
      // A factory that opened a socket before connect() rejected would leak
      // it once per backoff attempt otherwise.
      try {
        await client.disconnect();
      } catch { /* best effort: the connection never came up */ }
      throw error;
    }
    this.client = client;
    return client;
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client === null) return;
    try {
      await client.disconnect();
    } catch (error) {
      this.logger.warn(
        { accountId: this.accountId, err: errorText(error) },
        "mail-sync: disconnect failed",
      );
    }
  }

  // --- One folder ----------------------------------------------------------

  private async syncFolder(client: ImapClient, account: MailAccountRow, folder: string): Promise<void> {
    const status = await client.status(folder);
    let lastSeenUid = await this.loadCursor(account.id, folder, status.uidvalidity);
    // The backfill window applies exactly while the cursor sits at 0, which
    // covers both cases that need it: a folder never synced before, and one
    // whose UIDVALIDITY just reset it. Re-walking a folder is no reason to
    // reach further back than the account's configured window -- everything
    // older is either already stored (and would only be re-ingested to no
    // effect) or was never wanted. NULL backfill_days means "sync
    // everything" (see the column comment in schema.ts), not "sync nothing".
    const sinceDate = lastSeenUid === 0 && account.backfillDays !== null
      ? new Date(this.clock.now().getTime() - account.backfillDays * DAY_MS)
      : null;

    // SSE COALESCING (Task 5 decision): ingest publishes its own
    // [["mail-threads"], ["mail-thread", id], ["mail-unread"]] per new
    // message, so a full batch fires up to 150 key hints and a 5000-message
    // first backfill around 15,000. That is accepted as-is -- nothing here
    // batches, suppresses or delays it -- for three measured reasons.
    //
    // First, the cost is trivial where it lands: publish() is a synchronous
    // fan-out with no I/O of its own, measured at 2.9us per hint across 5
    // subscribers on the dev server (15,000 hints = 44ms of CPU in total),
    // and a hint frame is ~106 bytes on the wire.
    //
    // Second, and decisively: the web layer ALREADY coalesces. components/
    // sse.tsx buffers incoming keys in a Map (so duplicate keys collapse)
    // behind a 100ms debounce that RESTARTS on every frame -- so a backfill
    // streaming hints continuously produces ONE invalidation round when it
    // pauses, not one per message. Coalescing here as well would only make
    // hints coarser upstream of a mechanism that is strictly better at it,
    // because it dedupes across batches and knows the render cost.
    //
    // Third, the genuinely storm-shaped case is already silent at the
    // source: a UIDVALIDITY reset re-walks an entire folder, and ingest
    // publishes nothing for a re-sighting that changed no field (see the
    // end of ingestParsedMessage). What is left publishing per message is
    // genuinely new mail -- which is exactly the event IDLE exists to
    // surface promptly.
    for (;;) {
      if (this.stopped) return;
      const batch = await client.fetchNewer(folder, { sinceUid: lastSeenUid, limit: BATCH_SIZE, sinceDate });
      if (batch.length === 0) break;

      let highest = lastSeenUid;
      for (const descriptor of batch) {
        if (this.stopped) return;
        await this.ingestOne(client, account, folder, descriptor);
        if (descriptor.uid > highest) highest = descriptor.uid;
      }

      if (highest <= lastSeenUid) {
        // An adapter that keeps returning UIDs at or below the cursor would
        // spin this loop forever, ingesting the same messages. Bail instead;
        // the next pass re-reads the cursor from the database.
        this.logger.warn(
          { accountId: this.accountId, folder, lastSeenUid },
          "mail-sync: batch did not advance the cursor, ending the folder pass",
        );
        break;
      }

      // Advanced ONCE PER BATCH, after the whole batch is ingested: an
      // interrupted pass resumes from the last completed batch rather than
      // restarting the folder, and re-ingesting a partial batch is a no-op
      // thanks to the (account_id, message_id) duplicate guard. This is also
      // what moves the cursor past a poison-skipped UID -- the skip needs no
      // arithmetic of its own, because the batch's highest UID is already
      // beyond it.
      lastSeenUid = highest;
      await this.saveCursor(account.id, folder, status.uidvalidity, lastSeenUid);
      if (batch.length < BATCH_SIZE) break;
    }

    if (this.stopped) return;
    await this.reconcileFlags(client, account.id, folder);
  }

  /**
   * The folder cursor. A UIDVALIDITY change means every UID the server
   * previously handed out is meaningless, so the cursor resets to 0 and the
   * folder is re-walked; UNIQUE (account_id, message_id) makes that converge
   * without duplicates (spec).
   */
  private async loadCursor(accountId: string, folder: string, uidvalidity: number): Promise<number> {
    const [row] = await this.db.select().from(mailFolderState)
      .where(and(eq(mailFolderState.accountId, accountId), eq(mailFolderState.folder, folder)));
    if (row === undefined) {
      await this.db.insert(mailFolderState)
        .values({ accountId, folder, uidvalidity, lastSeenUid: 0 })
        .onConflictDoNothing({ target: [mailFolderState.accountId, mailFolderState.folder] });
      return 0;
    }
    if (row.uidvalidity !== uidvalidity) {
      this.logger.info(
        { accountId, folder, was: row.uidvalidity, now: uidvalidity },
        "mail-sync: UIDVALIDITY changed, re-walking the folder",
      );
      await this.db.transaction(async (tx) => {
        // Every UID the server previously issued is meaningless now --
        // INCLUDING the ones already stored on our own rows, which is the
        // part that bites. The re-walk only re-sights messages inside the
        // backfill window, so anything older keeps a UID from the dead
        // namespace; reconcileFlags below (and Task 7's \Seen write-back)
        // match on (account, folder, imap_uid), so on a renumbered mailbox a
        // recent message's flags would be applied to an old message's row
        // that happens to still hold that number. Clearing them first makes
        // every stale UID unmatchable -- imap_uid is nullable precisely
        // because a row need not correspond to anything on the server -- and
        // the rows the re-walk does re-sight get their fresh UID from
        // ingest's duplicate-guard UPDATE.
        //
        // The two statements share a transaction, and that ATOMICITY is what
        // gives the property -- not the order they appear in. Either both
        // land or neither does, so there is no state in which the cursor has
        // been reset while stale UIDs are still matchable.
        await tx.update(mailMessages)
          .set({ imapUid: null, updatedAt: this.clock.now() })
          .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.folder, folder)));
        await tx.update(mailFolderState)
          .set({ uidvalidity, lastSeenUid: 0, updatedAt: this.clock.now() })
          .where(eq(mailFolderState.id, row.id));
      });
      return 0;
    }
    return row.lastSeenUid;
  }

  private async saveCursor(
    accountId: string, folder: string, uidvalidity: number, lastSeenUid: number,
  ): Promise<void> {
    await this.db.insert(mailFolderState)
      .values({ accountId, folder, uidvalidity, lastSeenUid })
      .onConflictDoUpdate({
        target: [mailFolderState.accountId, mailFolderState.folder],
        set: { uidvalidity, lastSeenUid, updatedAt: this.clock.now() },
      });
  }

  // --- One message ---------------------------------------------------------

  /**
   * The poison-message contract. A fetch failure is a CONNECTION problem and
   * escapes as a pass-level error; an ingest failure is a MESSAGE problem and
   * is retried once, then skipped.
   *
   * The retry deliberately does not re-fetch: the failures a retry fixes are
   * database-side and transient (mail-ingest.ts's "raced another writer"
   * rollback is the designed example), and re-downloading up to 25MB to
   * discover that a header block is still too long would be pure waste.
   */
  private async ingestOne(
    client: ImapClient, account: MailAccountRow, folder: string, descriptor: ImapMessageDescriptor,
  ): Promise<void> {
    const raw = await client.fetchRaw(folder, descriptor.uid);
    if (raw === null) {
      // Expunged between the listing and this fetch. Not an error and not
      // poison -- there is nothing to ingest and nothing to retry, and the
      // cursor moves past it with the rest of the batch.
      this.logger.info(
        { accountId: this.accountId, folder, uid: descriptor.uid },
        "mail-sync: message vanished before it could be fetched",
      );
      return;
    }
    for (let attempt = 0; attempt <= POISON_RETRIES; attempt += 1) {
      try {
        await this.ingest(this.db, this.dataDir, {
          accountId: account.id, folder, uid: descriptor.uid, raw, flags: descriptor.flags,
        });
        this.counters.ingested += 1;
        this.passIngested += 1;
        return;
      } catch (error) {
        // The account disappearing mid-pass is a teardown signal, never a
        // poison message: skipping the UID would "fix" it by walking an
        // entire mailbox one failure at a time.
        if (isTeardownError(error)) throw error;
        // ingestMessage contracts to raise only MailIngestError. Anything
        // else is a bug or an injected test double, and belongs in the
        // pass-level bucket where it flips the account and backs off,
        // rather than being silently skipped per message.
        if (!(error instanceof MailIngestError)) throw error;
        if (attempt < POISON_RETRIES) {
          this.logger.warn(
            { accountId: this.accountId, folder, uid: descriptor.uid, reason: error.reason },
            "mail-sync: ingest failed, retrying once",
          );
          continue;
        }
        this.recordPoison(error, folder, descriptor.uid);
        return;
      }
    }
  }

  private recordPoison(error: MailIngestError, folder: string, uid: number): void {
    this.counters.poisonSkips += 1;
    this.passSkips += 1;
    this.passLastSkip = `${folder}/${uid}: ${error.reason}`;
    this.logger.warn(
      { accountId: this.accountId, folder, uid, reason: error.reason },
      "mail-sync: message failed ingest twice, skipping its UID",
    );
  }

  // --- Flag reconcile ------------------------------------------------------

  /**
   * Pull FLAGS for recent messages and mirror `\Seen` into the CRM, so
   * reading mail in another client clears it here too.
   *
   * Matched on (account, folder, imap_uid) because those three are written
   * together from one sighting: mail_messages.folder/imap_uid mean "where
   * this message was last seen" (see mail-ingest.ts's duplicate guard), so a
   * message currently attributed to Sent is simply not reconciled by the
   * INBOX pass. That is the correct pairing -- an INBOX UID must never be
   * matched against a row whose UID came from another folder.
   */
  private async reconcileFlags(client: ImapClient, accountId: string, folder: string): Promise<void> {
    const since = new Date(this.clock.now().getTime() - FLAG_RECONCILE_DAYS * DAY_MS);
    const flagged = await client.fetchFlags(folder, since);
    if (flagged.length === 0) return;

    const seenUids: number[] = [];
    const unseenUids: number[] = [];
    for (const entry of flagged) {
      (hasSeenFlag(entry.flags) ? seenUids : unseenUids).push(entry.uid);
    }

    const threadIds = new Set<string>();
    for (const [uids, seen] of [[seenUids, true], [unseenUids, false]] as const) {
      for (const batch of chunked(uids, UID_CHUNK)) {
        const rows = await this.db.update(mailMessages)
          .set({ seen, updatedAt: this.clock.now() })
          .where(and(
            eq(mailMessages.accountId, accountId),
            eq(mailMessages.folder, folder),
            inArray(mailMessages.imapUid, batch),
            // Only rows that actually change, so the RETURNING below is the
            // real change set and an unchanged mailbox publishes nothing.
            ne(mailMessages.seen, seen),
          ))
          .returning({ threadId: mailMessages.threadId });
        for (const row of rows) threadIds.add(row.threadId);
        this.passFlagChanges += rows.length;
      }
    }
    if (threadIds.size === 0) return;
    // One hint carrying every affected key, not one hint per thread: the
    // subscriber fan-out is per publish() call, so batching keys keeps a
    // mass "mark all read" in another client to a single SSE frame.
    publish({
      keys: [["mail-threads"], ["mail-unread"], ...[...threadIds].map((id) => ["mail-thread", id])],
    });
  }

  // --- Account status ------------------------------------------------------

  /**
   * Write status/last_error/last_synced_at, and publish `[["mail-accounts"]]`
   * only when status or last_error actually changed -- otherwise every
   * account would fire a hint every poll interval forever, for nothing. The
   * pre-image is read under FOR UPDATE (updateAccount's precedent) so a
   * concurrent settings edit cannot make the comparison read a stale row.
   */
  private async writeAccountState(
    next: { status: "active" | "error"; lastError: string | null; touchSynced: boolean },
  ): Promise<void> {
    const now = this.clock.now();
    const changed = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: mailAccounts.status, lastError: mailAccounts.lastError })
        .from(mailAccounts).where(eq(mailAccounts.id, this.accountId)).for("update");
      if (current === undefined) throw new NotFoundError("mail account", this.accountId);
      await tx.update(mailAccounts).set({
        status: next.status,
        lastError: next.lastError,
        ...(next.touchSynced ? { lastSyncedAt: now } : {}),
        updatedAt: now,
      }).where(eq(mailAccounts.id, this.accountId));
      return current.status !== next.status || current.lastError !== next.lastError;
    });
    if (changed) publish({ keys: [["mail-accounts"]] });
  }

  // --- Waiting -------------------------------------------------------------

  private backoffMs(): number {
    // 60s, 2min, 4min ... capped at 32min (reached at the sixth consecutive
    // failure). `attempt` counts failures so far and is already incremented
    // by the time this runs, so the exponent is one less -- the FIRST retry
    // has to be 60s, not 120s. Math.min against the cap rather than clamping
    // the exponent, so the shift can never overflow.
    return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, this.attempt - 1), MAX_BACKOFF_MS);
  }

  /**
   * Park until there is something to do. Which of the two waits is used
   * depends on the last pass: IDLE (capped at the poll interval) after a
   * good one, backoff after a bad one.
   *
   * Both are expressed as a DEADLINE (`waitUntil`), not as a fresh timer per
   * entry, and that is what makes three separate problems go away at once.
   * A queued task cuts the wait short, the loop drains it and comes straight
   * back here; with a fresh timer each time, a mailbox getting a mark-read
   * every four minutes would restart a five-minute poll wait forever and
   * NEVER poll -- fatal on a server without IDLE, where the poll is the only
   * thing that fetches mail. The same restart, applied to a backoff, hands
   * every queued task its own connect attempt at full rate, which is exactly
   * the reconnect storm the backoff exists to prevent. And a deadline is
   * simultaneity-proof: two tasks arriving together resume the one remaining
   * wait rather than racing to install two.
   *
   * The deadline is set once (`??=`), re-entered as `max(0, waitUntil -
   * now)`, and cleared when a pass actually runs -- so the NEXT deadline is
   * measured from the end of that pass.
   *
   * A wait that ELAPSES means the next pass is due. A wait that was aborted
   * does not: `wake()` marks its own pass due, and a queued task
   * deliberately marks none.
   */
  private async waitForWork(passSucceeded: boolean): Promise<void> {
    try {
      // Something arrived DURING the pass: don't wait first, or a queued
      // task (or a syncNow) would sit behind a whole poll interval.
      if (this.passDue || this.queue.length > 0) return;
      const controller = new AbortController();
      // Assigned before the stopped re-check, so a stop() landing anywhere
      // from here on aborts this controller rather than missing it.
      this.waitController = controller;
      if (this.stopped) return;
      const total = passSucceeded ? this.pollIntervalMs : this.backoffMs();
      this.waitUntil ??= this.clock.now().getTime() + total;
      const remaining = Math.max(0, this.waitUntil - this.clock.now().getTime());
      if (passSucceeded) {
        if (await this.waitForNewMail(controller, remaining)) this.passDue = true;
      } else {
        await this.clock.wait(remaining, controller.signal);
        if (!controller.signal.aborted) this.passDue = true;
      }
      // Only a deadline that was actually REACHED is spent. An aborted wait
      // keeps its deadline so the next entry resumes the remainder.
      if (this.passDue) this.waitUntil = null;
    } catch (error) {
      // clock.wait never rejects and waitForNewMail handles its own; this is
      // a backstop so a wait can never break the loop.
      this.logger.warn(
        { accountId: this.accountId, err: errorText(error) },
        "mail-sync: wait failed",
      );
    } finally {
      this.waitController = null;
    }
  }

  /**
   * IDLE on INBOX, capped at the remaining poll deadline. New mail and the
   * cap elapsing mean the same thing -- run another pass -- and both return
   * true. An external abort (stop, or a queued task cutting in) returns
   * false, so the caller knows no pass was earned.
   */
  private async waitForNewMail(controller: AbortController, remaining: number): Promise<boolean> {
    const client = this.client;
    const capped = this.clock.wait(remaining, controller.signal);
    // Latched: a server that does not support IDLE says so once, and is
    // never asked again on this connection. Without the latch, a no-IDLE
    // account produced one WARN plus one drop-and-reconnect (a fresh TCP
    // handshake and LOGIN) every poll interval -- 288 of each per day, per
    // account, none of which ever changes the answer.
    if (client === null || this.idleUnsupported) {
      await capped;
      return !controller.signal.aborted;
    }

    let idleError: unknown;
    // The rejection handler is attached BEFORE the race, not after: if the
    // cap wins and idle rejects later, an unhandled rejection would take the
    // process down under Node's default policy.
    const idling = client.idle(controller.signal).then(
      (outcome) => {
        if (outcome === "new-mail") this.counters.idleWakes += 1;
        return outcome;
      },
      (error: unknown) => {
        idleError = error;
        return "aborted" as const;
      },
    );

    await Promise.race([idling, capped]);
    if (idleError !== undefined) {
      // Servers without IDLE degrade to poll-only, silently (spec). Logged
      // ONCE, at info: this is a property of the server, not an incident.
      // The client is still dropped this once, because the same rejection is
      // also what a dead socket looks like. The latch clears ONLY on recovery
      // from a pass-level failure or a manager restart -- never on the
      // reconnect this drop causes, since clearing there would reinstate the
      // log-and-reconnect cycle the latch exists to remove. The cost of a
      // false positive (a transient rejection on a server that does support
      // IDLE) is therefore polling instead of push for the life of this
      // AccountSync. Task 6's adapter should make this a fact rather than a
      // heuristic by reporting "server lacks IDLE" from the capability list.
      this.idleUnsupported = true;
      this.logger.info(
        { accountId: this.accountId, err: errorText(idleError) },
        "mail-sync: IDLE unavailable, falling back to polling for this connection",
      );
      await this.dropClient();
      // Waiting out the cap is what makes the fallback silent rather than a
      // spin: returning here would run passes as fast as the server can
      // refuse IDLE.
      await capped;
    }
    // Read BEFORE the cleanup abort below, which would otherwise make every
    // wait look externally aborted.
    const elapsed = !controller.signal.aborted;
    // Release whichever of the two is still pending. `capped` is awaited so
    // no timer outlives this call (a stray timer is what makes a test suite
    // hang); `idling` deliberately is NOT -- shutdown must not be able to
    // block on a future adapter that ignores, or is slow to honour, the
    // abort signal. It carries both handlers, so a late settlement of any
    // kind is already absorbed. (Task 6's adapter should still honour abort
    // promptly -- it is what makes a shutdown fast rather than merely safe.)
    controller.abort();
    await capped;
    return elapsed;
  }
}

/** INBOX plus the account's Sent folder, deduplicated. INBOX is
 * case-insensitive per RFC 3501; every other folder name is not. The value
 * arrives already trimmed -- see loadAccount. */
function foldersOf(account: MailAccountRow): string[] {
  const sent = account.sentFolder;
  if (sent.length === 0 || sent.toUpperCase() === INBOX) return [INBOX];
  return [INBOX, sent];
}

// --- SyncManager -----------------------------------------------------------

export interface SyncManagerOptions {
  db: Database;
  dataDir: string;
  mailKeyPath: string;
  clientFactory: ImapClientFactory;
  clock?: SyncClock;
  logger?: SyncLogger;
  pollIntervalMs?: number;
  /** Test seam only -- see IngestMessageFn. */
  ingest?: IngestMessageFn;
}

/**
 * Owns one AccountSync per non-archived account, and is the thing routes and
 * mail-send reach through (`get(accountId)`) to queue `\Seen` write-backs and
 * Sent-folder APPENDs.
 *
 * It registers itself with mail-accounts.ts's account-changed hook at
 * `start()` and unregisters at `stop()` -- the same direction as stream.ts
 * registering with sse.ts's `subscribe()`, and chosen for the same reason:
 * the mutating service never imports the sync engine, so account CRUD stays
 * testable (and compilable) with no sync engine in the picture, and there is
 * no import cycle between the two modules.
 */
export class SyncManager {
  private readonly options: SyncManagerOptions;
  private readonly syncs = new Map<string, AccountSync>();
  /** Per-account promise chain: accountChanged is called fire-and-forget
   * from the CRUD path, and two overlapping calls for one account would
   * otherwise each tear down the old sync and create a new one, leaving TWO
   * AccountSyncs ingesting the same mailbox. */
  private readonly chain = new Map<string, Promise<void>>();
  private unregisterHook: (() => void) | null = null;
  private started = false;

  constructor(options: SyncManagerOptions) {
    this.options = options;
  }

  private get logger(): SyncLogger {
    return this.options.logger ?? consoleSyncLogger;
  }

  /** Load every non-archived account and start syncing it. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unregisterHook = setAccountChangedHook((accountId, change) => {
      this.onAccountChanged(accountId, change.connectionChanged);
    });
    const rows = await this.options.db.select({ id: mailAccounts.id })
      .from(mailAccounts).where(isNull(mailAccounts.archivedAt));
    for (const row of rows) this.ensureSync(row.id);
    this.logger.info({ accounts: rows.length }, "mail-sync: sync manager started");
  }

  /**
   * Reconcile one account's sync with its current row: create, restart or
   * tear down. Awaited by tests and syncNow; fired and forgotten by the
   * account-changed hook.
   *
   * `connectionChanged` says whether anything a CONNECTION is built from
   * moved (host/port/security/username/password). mail-accounts.ts already
   * computes exactly that for its own status-reset decision and passes it
   * through the hook. When nothing did, the live sync is kept and merely
   * woken: Task 9's settings form autosaves the signature editor, and
   * dropping an IMAP connection and re-LOGINing on every keystroke-debounce
   * would be absurd. Absent (the default) means "assume it did" -- create,
   * archive and unarchive all take the full path.
   */
  async accountChanged(accountId: string, connectionChanged = true): Promise<void> {
    const previous = this.chain.get(accountId) ?? Promise.resolve();
    const next = previous.then(() => this.applyAccountChange(accountId, connectionChanged));
    // The chain link must never reject: a failed reconcile must not reject
    // the NEXT one, nor sit around as an unhandled rejection. The caller
    // still sees the real outcome through `next`.
    const settled = next.then(() => undefined, () => undefined);
    this.chain.set(accountId, settled);
    try {
      await next;
    } finally {
      if (this.chain.get(accountId) === settled) this.chain.delete(accountId);
    }
  }

  private async applyAccountChange(accountId: string, connectionChanged: boolean): Promise<void> {
    if (!this.started) return;
    const [row] = await this.options.db
      .select({ id: mailAccounts.id, archivedAt: mailAccounts.archivedAt })
      .from(mailAccounts).where(eq(mailAccounts.id, accountId));
    const existing = this.syncs.get(accountId);
    const stillWanted = row !== undefined && row.archivedAt === null;

    // Everything a connection is built from is captured when the client is
    // created, so a change to any of it needs a new AccountSync -- a restart
    // is the only way to be sure the next pass uses the current row, and it
    // is cheap because the folder cursors live in the database. A change to
    // anything else (label, signature, sent_folder, backfill window) is
    // picked up by loadAccount on the very next pass, so the live sync just
    // gets woken.
    if (existing !== undefined && stillWanted && !connectionChanged) {
      existing.wake();
      return;
    }

    if (existing !== undefined) {
      this.syncs.delete(accountId);
      await existing.stop();
    }
    if (!stillWanted) return;
    if (!this.started) return;
    this.ensureSync(accountId);
  }

  private onAccountChanged(accountId: string, connectionChanged: boolean): void {
    // The hook is synchronous and called from inside a CRUD service right
    // after its write committed: it must not throw, must not block the
    // response, and must not leave a floating rejection behind.
    void this.accountChanged(accountId, connectionChanged).catch((error: unknown) => {
      this.logger.error(
        { accountId, err: errorText(error) },
        "mail-sync: reconciling an account after a change failed",
      );
    });
  }

  private ensureSync(accountId: string): void {
    if (this.syncs.has(accountId)) return;
    const sync = new AccountSync({
      ...this.options,
      accountId,
      // A sync that tore itself down (account deleted or archived mid-pass)
      // removes itself, so `get` never hands a caller a dead loop. Guarded
      // on identity: a restart may already have replaced this entry.
      onStopped: (id) => {
        if (this.syncs.get(id) === sync) this.syncs.delete(id);
      },
    });
    this.syncs.set(accountId, sync);
    sync.start();
  }

  /**
   * Request a pass for this account, creating the AccountSync first if there
   * is not one yet (the account-just-created path).
   *
   * RESOLVES WHEN THE PASS IS REQUESTED, NOT WHEN IT FINISHES. The loop is
   * serial and may be mid-pass, mid-backoff or mid-queue when this lands, so
   * "wait for the pass" would mean waiting on work that has nothing to do
   * with the caller. Task 7's route should treat this as fire-and-forget and
   * let the SSE hints report the result -- awaiting it as if it were "sync
   * finished" would be wrong.
   */
  async syncNow(accountId: string): Promise<void> {
    const existing = this.syncs.get(accountId);
    if (existing !== undefined) {
      existing.wake();
      return;
    }
    await this.accountChanged(accountId);
    this.syncs.get(accountId)?.wake();
  }

  /** The handle mail-send (APPEND) and routes/mail.ts (`\Seen` write-back)
   * use. Undefined for an archived, unknown or not-yet-started account --
   * both callers treat that as "skip the best-effort step". */
  get(accountId: string): AccountSync | undefined {
    return this.syncs.get(accountId);
  }

  /**
   * Stop every sync, BOUNDED. server.ts awaits this before `app.close()`, so
   * an unbounded wait here would hold the HTTP listener open for as long as
   * one wedged network operation took to notice -- and nothing except
   * `idle()` in the ImapClient contract is cancellable, so "as long as it
   * takes" is the adapter's socket timeout, not ours. Past the deadline the
   * remaining syncs are abandoned: each has already been told to stop and
   * will unwind on its own, and the process is on its way out regardless.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.unregisterHook?.();
    this.unregisterHook = null;
    // Drain in-flight reconciles first, or one could create a fresh
    // AccountSync moments after everything was stopped.
    const chains = [...this.chain.values()];
    this.chain.clear();
    await Promise.allSettled(chains);
    const syncs = [...this.syncs.values()];
    this.syncs.clear();
    const stopping = Promise.allSettled(syncs.map((sync) => sync.stop()));
    const clock = this.options.clock ?? systemSyncClock;
    const deadline = new AbortController();
    const timeout = clock.wait(STOP_TIMEOUT_MS, deadline.signal);
    const winner = await Promise.race([stopping.then(() => "stopped" as const), timeout.then(() => "timeout" as const)]);
    // Releases whichever lost. `stopping` never rejects (allSettled) and is
    // deliberately not awaited on the timeout path -- that is the whole
    // point of the bound.
    deadline.abort();
    await timeout;
    if (winner === "timeout") {
      this.logger.warn(
        { accounts: syncs.length, timeoutMs: STOP_TIMEOUT_MS },
        "mail-sync: gave up waiting for syncs to stop, abandoning them",
      );
    }
  }
}

export interface StartSyncManagerOptions extends Omit<SyncManagerOptions, "clientFactory"> {
  nodeEnv: string;
  /**
   * Supplied by server.ts once Task 6's imapflow adapter exists. Without it
   * the manager is not started at all: there is nothing it could connect
   * with, and starting it would only mark every account `error`.
   */
  clientFactory?: ImapClientFactory;
}

/**
 * The one place the sync engine is started in production. Returns null (and
 * starts nothing) under NODE_ENV=test: the unit suite drives AccountSync and
 * SyncManager directly with a fake client, and a background loop opening
 * real connections from inside a test run is exactly the thing this project
 * does not want.
 *
 * `process.env` is checked as well as the parsed config value: the config
 * value is the declared intent (and is what a test asserts against), while
 * the environment check is the backstop for any future caller that builds
 * these options by hand.
 */
export async function startSyncManager(options: StartSyncManagerOptions): Promise<SyncManager | null> {
  const logger = options.logger ?? consoleSyncLogger;
  if (options.nodeEnv === "test" || process.env.NODE_ENV === "test") return null;
  const { clientFactory } = options;
  if (clientFactory === undefined) {
    logger.info({}, "mail-sync: no IMAP adapter configured, mail sync is disabled");
    return null;
  }
  const manager = new SyncManager({ ...options, clientFactory });
  await manager.start();
  return manager;
}
