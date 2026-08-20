import type { MailSecurity } from "@conduit/shared";
import type { Database } from "../db/client.js";
import type { IngestMessageInput, IngestResult } from "./mail-ingest.js";

/**
 * The seams `AccountSync` (mail-sync.ts) talks to, and the CONTRACT any real
 * implementation of them has to honour. Separate from mail-sync.ts because
 * this is the file Task 6's imapflow adapter is written against: the state
 * machine's internals are not its business, and this contract is.
 *
 * Two implementations exist: `ImapflowClient` (Task 6, mail-imapflow.ts) and
 * an in-memory fake in mail-sync.test.ts. A seam for testing, not an
 * abstraction layer to grow (spec).
 *
 * Everything here is re-exported from mail-sync.ts, so no existing importer
 * has to know this file exists.
 *
 * ---------------------------------------------------------------------------
 * ADAPTER CONTRACT (read this before writing mail-imapflow.ts)
 * ---------------------------------------------------------------------------
 *
 * LIFECYCLE
 * - `connect()` is called on a FRESH INSTANCE every time. AccountSync drops
 *   its client after any failure and asks the factory for a new one, so an
 *   adapter never sees a second `connect()` on the same object -- which is
 *   what imapflow requires (its `connect()` throws if the client has already
 *   been connected). Corollary for the factory: it MUST return a new
 *   instance per call. Caching or singleton-ing one client per account turns
 *   every reconnect into that throw.
 * - `disconnect()` must be safe to call after a FAILED `connect()`, because
 *   that is exactly what AccountSync does to avoid leaking a half-open
 *   socket. On that path use imapflow's `close()` (tears the socket down
 *   unconditionally), not `logout()` (issues a LOGOUT command over a
 *   connection that may never have been established).
 *
 * CANCELLATION AND SHUTDOWN
 * - NOTHING except `idle()` is cancellable. There is no AbortSignal on
 *   connect/status/fetch/append/addFlags, by design -- adding one would put
 *   a cancellation path through every imapflow call for no benefit the loop
 *   can use. The consequence is load-bearing: the ONLY bound on how long a
 *   shutdown waits for a wedged network operation is the adapter's own
 *   timeouts, so it MUST set `connectionTimeout`, `greetingTimeout` and
 *   `socketTimeout` on the imapflow client (imapflow's option really is
 *   `connectionTimeout` -- spelling it any other way sets nothing and
 *   silently leaves the 90-second default in place). SyncManager.stop() races a
 *   timeout of its own as a second line of defence, but a socket that never
 *   errors is otherwise a connection leaked for the process's lifetime.
 * - `idle()` takes an AbortSignal and should honour it PROMPTLY. AccountSync
 *   does not await the idle promise during cleanup (a shutdown must not be
 *   able to block on an adapter that ignores the signal), so a slow adapter
 *   costs shutdown speed rather than correctness -- but "not incorrect" is
 *   not the same as "fine".
 * - After the signal fires, AccountSync may issue the NEXT command before
 *   `idle()`'s promise has settled. With imapflow this is safe because its
 *   command queue runs a preCheck that sends DONE and waits for IDLE to
 *   finish before letting the next command through. That is a CONTRACT this
 *   code depends on, not a coincidence to be preserved by luck: an adapter
 *   built on anything else must serialise the same way internally.
 *
 * RETURN-VALUE DISCIPLINE
 * - Several imapflow calls report failure by RETURNING something falsy
 *   rather than throwing: `mailboxOpen`/`status` can return false, `search`
 *   can return undefined, `fetchOne` returns false when nothing matched, and
 *   `download` can return an object with no content. The adapter MUST turn
 *   each of those into a thrown error (or, for `fetchRaw` specifically, an
 *   explicit `null` -- see below). Returning an empty array from a failed
 *   `search` would read to AccountSync as "the folder is exhausted" and
 *   silently end the walk.
 * - `status()` must convert imapflow's `uidValidity` from BigInt to Number.
 *   mail_folder_state.uidvalidity is a bigint column in `mode: "number"`, and
 *   a BigInt reaching the comparison would make every pass see a mismatch and
 *   re-walk the folder forever.
 *
 * ERROR CLASSIFICATION
 * - Every error an adapter throws should carry one of the two prefixes below
 *   on its `message` when it can be classified: `auth:` for a rejected login,
 *   `connection:` for a socket/DNS/TLS-level failure. Unclassifiable errors
 *   are left alone rather than guessed at.
 * - The prefixes are the CONTRACT, not an implementation detail of any one
 *   adapter: an adapter error's message is stored verbatim in
 *   mail_accounts.last_error and returned verbatim by the test-connection
 *   endpoint, and both the settings UI (telling a user to check their
 *   password vs. their host) and mail-send.ts's 502 body branch on them. They
 *   are DEFINED IN @conduit/shared, because that settings UI lives in
 *   packages/web and cannot import from packages/api, and re-exported here so
 *   nothing on this side has to know that.
 * - Neither the prefix nor the message may ever contain a password: the
 *   underlying libraries do not echo credentials into their own error text,
 *   and an adapter must not add any.
 */

export { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";

/** Deliberately just UIDVALIDITY. UIDNEXT would be the obvious companion,
 * but nothing reads it -- the cursor is driven by what fetchNewer actually
 * returns, not by a predicted upper bound -- and every field in this
 * interface is one the real adapter has to implement. */
export interface ImapFolderStatus {
  uidvalidity: number;
}

/** One message as the server lists it: enough to decide what to ingest and
 * how to advance the cursor, WITHOUT its body (see fetchNewer). */
export interface ImapMessageDescriptor {
  uid: number;
  flags: string[];
}

export interface FetchNewerOptions {
  /** Exclusive lower bound: only UIDs strictly greater than this. */
  sinceUid: number;
  /** Ascending from `sinceUid`; see fetchNewer's exactly-limit contract. */
  limit: number;
  /** INTERNALDATE lower bound (the adapter issues SEARCH SINCE), or null for
   * no lower bound. Set only while a folder's cursor is still at 0 -- see
   * AccountSync.syncFolder. */
  sinceDate: Date | null;
}

/**
 * How an IDLE ended.
 *
 * There is deliberately no "timeout" member. imapflow has no such outcome --
 * its `idle()` resolves when the connection leaves IDLE, and the poll
 * interval is AccountSync's cap, imposed by aborting the signal. A "timeout"
 * arm would short-circuit that cap: an adapter returning it immediately (a
 * plausible reading of "my IDLE window closed") would have the loop run a
 * pass, idle, return, run a pass, with nothing bounding the rate.
 */
export type IdleOutcome = "new-mail" | "aborted";

export interface ImapClient {
  /** Rejects on failure -> pass-level error -> backoff. Called once per
   * instance; see the lifecycle notes above. */
  connect(): Promise<void>;
  /** Must tolerate being called after a failed connect(). */
  disconnect(): Promise<void>;
  /** UIDVALIDITY for the folder; a change means the cursor is worthless. */
  status(folder: string): Promise<ImapFolderStatus>;
  /**
   * Descriptors for UIDs above `options.sinceUid`, ascending, bodies NOT
   * included (see fetchRaw).
   *
   * EXACTLY-LIMIT CONTRACT: return exactly `limit` descriptors whenever at
   * least `limit` UIDs above `sinceUid` exist -- a short batch means the
   * folder is exhausted. AccountSync ends its walk on the first short batch,
   * so an adapter that returns fewer than it could (because a server chunked
   * a response, say) silently truncates the sync at that point and the rest
   * of the folder is never ingested until some later UIDVALIDITY reset.
   *
   * COST MODEL: IMAP SEARCH has no LIMIT clause -- `SEARCH UID sinceUid:*`
   * (plus `SINCE` when `sinceDate` is set) returns the WHOLE matching UID
   * set, so a naive implementation re-runs a full-folder search per batch,
   * i.e. O(batches x folder size) on the first backfill. The intended
   * strategy is to cache that UID list keyed on the (folder, sinceUid-chain)
   * of one walk: the first call searches and keeps the remainder, and each
   * subsequent call whose `sinceUid` is the previous call's highest returned
   * UID slices the cache instead of searching again. Any call that does not
   * continue the chain (a new pass, another folder, a cursor reset) must
   * discard the cache and search afresh -- the cache is a within-walk
   * optimisation, never a source of truth about what is on the server.
   */
  fetchNewer(folder: string, options: FetchNewerOptions): Promise<ImapMessageDescriptor[]>;
  /** One message's RFC822 source, or null when it no longer exists (expunged
   * between the listing and this call -- an ordinary race, not an error).
   * This is the one place a falsy imapflow return maps to a value rather
   * than a throw, and only for "no such UID". */
  fetchRaw(folder: string, uid: number): Promise<Buffer | null>;
  /**
   * FLAGS-only fetch of everything with an INTERNALDATE at or after
   * `sinceDate`, for the `\Seen` reconcile. Deliberately unbounded in count:
   * the window is 30 days, the response is flags only (no bodies), and a cap
   * here would silently stop reconciling the oldest end of a busy mailbox --
   * a wrong answer where an expensive one is acceptable.
   */
  fetchFlags(folder: string, sinceDate: Date): Promise<ImapMessageDescriptor[]>;
  /**
   * APPEND a sent message. No INTERNALDATE parameter and no returned UID,
   * both deliberate: the server stamps its own arrival time, and the next
   * Sent-folder pass re-sights the message and fills in its UID through
   * ingest's duplicate guard. Nothing needs the UID before then.
   */
  append(folder: string, raw: Buffer | string, flags: string[]): Promise<void>;
  /**
   * ADD flags, never replace them. The imapflow call is
   * `messageFlagsAdd` -- NOT `messageFlagsSet`, which REPLACES the whole
   * flag set on the message and would silently wipe `\Answered`,
   * `\Flagged`, `\Draft` and any user keywords the account's other mail
   * clients rely on. The only caller writes back `\Seen`.
   */
  addFlags(folder: string, uids: number[], flags: string[]): Promise<void>;
  /**
   * Blocks until the server reports new mail, or `signal` aborts.
   *
   * No folder parameter: only INBOX is ever idled (spec -- IDLE is for
   * near-instant new-mail push, and Sent is polled), so an adapter can open
   * INBOX unconditionally here.
   *
   * AccountSync caps the wait at the poll interval by aborting the signal,
   * so an adapter needs no timer of its own. Rejecting is allowed and
   * handled: a server without IDLE degrades to poll-only, and AccountSync
   * latches that after the first rejection rather than retrying it every
   * interval.
   */
  idle(signal: AbortSignal): Promise<IdleOutcome>;
}

export interface ImapConnectionSettings {
  accountId: string;
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  password: string;
}

/** MUST return a fresh instance per call -- see the lifecycle notes above. */
export type ImapClientFactory = (settings: ImapConnectionSettings) => ImapClient;

/**
 * Every wait in the sync engine goes through here so tests never sleep.
 * `wait` NEVER rejects and always resolves early when `signal` aborts --
 * callers treat "the wait ended" and "we were told to stop" identically and
 * re-check their own state afterwards.
 */
export interface SyncClock {
  now(): Date;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: SyncClock = {
  now: () => new Date(),
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      // A pending timer keeps the Node process alive. A five-minute poll
      // wait must never be the reason a shutdown hangs -- SIGTERM already
      // calls SyncManager.stop(), and this makes the timer harmless even on
      // a path that does not.
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/** Structurally compatible with Fastify's pino logger. */
export interface SyncLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export const consoleSyncLogger: SyncLogger = {
  info: (details, message) => { console.info(message, details); },
  warn: (details, message) => { console.warn(message, details); },
  error: (details, message) => { console.error(message, details); },
};

/** Signature of mail-ingest.ts's ingestMessage; injectable purely as a test
 * seam (the poison contract's retry-then-succeed case cannot be produced by
 * any real message, since a message that fails once fails identically
 * forever). Production always uses the real function. */
export type IngestMessageFn =
  (db: Database, dataDir: string, input: IngestMessageInput) => Promise<IngestResult>;
