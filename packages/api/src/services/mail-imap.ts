import type { MailSecurity, SpecialUse } from "@conduit/shared";
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
 *   connect/status/fetch/append/addFlags/move, by design -- adding one would put
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
 *   silently end the walk. `list()` is held to the same rule for the same
 *   reason: an empty listing is indistinguishable from "this account has no
 *   folders", which discovery would write down as a mailbox where nothing
 *   was found (see `list` below). `messageMove` is the sharpest case of all
 *   -- it reports a REFUSED move (a missing destination mailbox, say) as
 *   `false` rather than by throwing -- see `move` below.
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

/**
 * One mailbox as the server LISTs it (Phase 4.1 folder discovery). Four
 * fields, each one something services/mail-folders.ts actually reads -- the
 * same rule the rest of this file follows.
 */
export interface ImapFolderListing {
  /**
   * The mailbox path, modified-UTF-7 (RFC 3501 section 5.1.3) ALREADY
   * DECODED, and therefore storable verbatim in mail_account_folders.folder
   * and usable verbatim as the argument to every other call on this
   * interface.
   *
   * Verified in imapflow 1.7.1: its LIST handler builds each entry's `path`
   * as `normalizePath(connection, decodePath(connection, <the wire value>))`
   * (lib/commands/list.js, the untagged LIST handler), and its own typings
   * call the result a "Mailbox path (unicode string)". `normalizePath`
   * (lib/tools.js) does two further things worth knowing, both of which this
   * code benefits from rather than works around: it spells INBOX as exactly
   * "INBOX" whatever case the server used (RFC 3501 says the name is not case
   * sensitive), so discovery's row matches the constant the walk uses; and it
   * ensures the connection's namespace prefix, so the name really is one the
   * server will accept in a SELECT.
   */
  folder: string;
  /**
   * The folder's classified role, or undefined when the adapter's source
   * offered none. Only the five roles in @conduit/shared's SpecialUse are
   * carried; see the adapter's mapping notes for the listing values that
   * deliberately map to nothing.
   *
   * NOT a promise that the SERVER said so. imapflow fills its `specialUse`
   * from the RFC 6154 SPECIAL-USE (or legacy XLIST) flag when the server
   * offers one and from its OWN table of localized folder names when it does
   * not, distinguishing the two only on a separate `specialUseSource`
   * property (lib/special-use.js + lib/commands/list.js in 1.7.1). This
   * field is therefore "the adapter's best classification", and
   * mail-folders.ts treats it as the higher-precedence input to its own
   * classification rather than as ground truth.
   *
   * At most one folder per role arrives classified. imapflow collects every
   * candidate for a role and sets `specialUse` on the single winner
   * (lib/commands/list.js resolves the conflict by source priority, then
   * alphabetically). A mailbox with both "Trash" and "Deleted Items" hands
   * one of them over unclassified -- which is one of the cases
   * mail-folders.ts's name heuristics exist to catch.
   */
  specialUse?: SpecialUse;
  /**
   * false for a `\Noselect` mailbox: a pure hierarchy node that holds no
   * messages and cannot be SELECTed. Discovery still records it (the picker
   * shows it, and it can still be classified), but the sync walk must never
   * open it -- a SELECT would simply fail.
   */
  selectable: boolean;
  /**
   * true for a mailbox the server presents as a VIEW over messages that also
   * live somewhere else: RFC 6154's `\All` ("all messages") and `\Flagged`
   * ("a virtual mailbox"), plus Gmail's non-standard `\Important`.
   *
   * ADDED IN PHASE 8 TASK 4, FOR A GMAIL PROBLEM THAT IS NOT AN AUTHENTICATION
   * PROBLEM. Discovery enables every folder but Junk and Trash on first sight,
   * and Gmail lists `[Gmail]/All Mail`, `[Gmail]/Starred` and
   * `[Gmail]/Important` as ordinary mailboxes -- so the sync walk would open
   * all three, meet every INBOX message again under a different folder name,
   * and take ingest's duplicate path, which updates `mail_messages.folder` to
   * wherever the message was last seen. The row would then flip folders on
   * every pass, for the whole mailbox, undoing Phase 4.4's filing as it went.
   * Nothing about that is caused by OAuth; it is simply what a Gmail account
   * would have done the first time one existed.
   *
   * OPTIONAL, so it is an addition to this contract rather than a change to it:
   * every existing construction of a listing stays valid and reads as `false`.
   * A server that offers no such attribute -- Dovecot, which is this install's
   * ordinary case -- is unaffected in every direction.
   *
   * IT IS NOT A SECOND `selectable`. These mailboxes CAN be selected and are
   * perfectly ordinary to open; the claim is only that walking one duplicates
   * work the walk has already done. So it decides a DEFAULT (mail-folders.ts's
   * defaultSyncEnabled) and nothing else -- an operator who wants All Mail
   * synced turns it on in Settings like any other folder, and the no-clobber
   * rule then keeps it on.
   */
  virtual?: boolean;
  /**
   * The server's hierarchy delimiter for this mailbox, or null when it
   * reports none (a flat namespace: RFC 3501 permits NIL here).
   *
   * Carried rather than assumed because it genuinely varies between servers
   * -- "." and "/" are both ordinary, imapflow's own typings say as much,
   * and it arrives PER ENTRY rather than once per connection. mail-folders.ts
   * needs it because its name heuristics run on the LAST PATH SEGMENT
   * ("Lists/Junk mail" is a user's own folder, not the mailbox's Junk), and
   * splitting on a guessed separator would either miss the segment or invent
   * one.
   */
  delimiter: string | null;
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
  /**
   * Every mailbox on the account (Phase 4.1). Called once at the START of
   * each pass, before any folder is walked, so a folder that appeared since
   * the last pass is discovered and synced by the same one.
   *
   * NO FILTERING. `\Noselect` mailboxes come back with `selectable: false`
   * rather than being dropped, and nothing is excluded for being
   * unsubscribed: mail_account_folders is the picker's list as well as the
   * walk's, and a folder the user cannot see is a folder they cannot enable.
   * Deciding what to sync is mail-folders.ts's and foldersOf's job, not the
   * adapter's.
   *
   * Rejecting is a PASS-LEVEL failure -- it happens before the walk, so the
   * pass has no partial work to keep, and AccountSync records it on the
   * account and backs off exactly as it would for a failed connect. It is
   * deliberately NOT the poison-message path (which exists to keep one
   * unreadable message from stalling a folder forever); a LIST that fails is
   * a broken connection or a refused command, and retrying it later is the
   * whole of the correct response.
   *
   * A falsy return must be a throw, per RETURN-VALUE DISCIPLINE above. In
   * imapflow 1.7.1 that is a DEFENSIVE guard rather than an observed shape --
   * its `list()` dereferences the command result (`new Map(folders.map(...))`,
   * lib/imap-flow.js) before returning it, so a falsy value would already
   * have become a TypeError there -- but the guard costs nothing and turns
   * such a shape into a sentence in mail_accounts.last_error instead of
   * "undefined is not iterable". Same reasoning as `append`'s guard.
   */
  list(): Promise<ImapFolderListing[]>;
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
   * MOVE `uids` out of `folder` and into `targetFolder` (Phase 4.1's bulk
   * Trash/Archive). Both are mailbox names exactly as `list()` reported them,
   * already decoded, like every other folder argument here.
   *
   * An empty `uids` is a no-op, as with addFlags: a caller chunking a group
   * that turned out to be empty must not have to special-case it.
   *
   * A FALSY RETURN IS A FAILURE, and nowhere in this file is that rule doing
   * more work. imapflow's `messageMove` resolves with a CopyResponseObject on
   * success, but its MOVE handler CATCHES every command error -- a NO or BAD,
   * which is exactly what a server answers for a destination mailbox that does
   * not exist -- logs it to imapflow's own logger (this adapter disables that
   * one) and RETURNS FALSE (lib/commands/move.js in 1.7.1). It also returns
   * `undefined` when its preconditions fail (no mailbox selected, an empty
   * range, an empty destination), and `messageMove` itself returns false when
   * the range resolves to nothing (lib/imap-flow.js). So a REFUSED MOVE DOES
   * NOT THROW: an adapter that passed the falsy value on would report a move
   * the server rejected as done, and mail-move.ts would leave the CRM claiming
   * a message sits in a folder it never reached -- the one thing the move
   * service's compensating revert exists to prevent. Turn every falsy shape
   * into a thrown error naming both folders.
   *
   * COPYUID IS DELIBERATELY DISCARDED. A UIDPLUS server reports the
   * destination UIDs (`uidMap`) and its UIDVALIDITY; none of it is used. The
   * move service NULLs `imap_uid` and lets the target folder's next pass
   * re-sight the message, which restores the UID through ingest's (account_id,
   * message_id) upsert -- the Phase 4 reconciliation machinery, unchanged.
   * Recording COPYUID instead would mean storing the destination's UIDVALIDITY
   * beside it for the number to mean anything, would be absent entirely on a
   * server without UIDPLUS, and would still have to agree with whatever the
   * re-sighting later wrote. One path that always works beats two that have to
   * agree.
   *
   * ONE CAVEAT THIS CONTRACT CANNOT FIX, worth knowing rather than
   * discovering: on a server that does NOT advertise RFC 6851 MOVE, imapflow
   * emulates it as COPY + \Deleted + EXPUNGE (lib/commands/move.js), and that
   * emulation is dangerous in two independent ways.
   *
   * - It issues the delete WITHOUT checking whether the COPY succeeded, so a
   *   refused copy can still destroy the source messages.
   * - The delete's EXPUNGE is scoped to the given UIDs only when the server
   *   ALSO has UIDPLUS (`UID EXPUNGE`). Without it, imapflow falls back to a
   *   PLAIN `EXPUNGE` (lib/commands/expunge.js), which by RFC 3501 removes
   *   EVERY message flagged \Deleted in that mailbox -- including messages
   *   some other client flagged and has not yet expunged, which this CRM
   *   never touched and knows nothing about.
   *
   * So the CRM's "we never expunge" promise rests on the server advertising
   * MOVE, and the blast radius of it not doing so rests on UIDPLUS. Dovecot,
   * the deployment target and CI's server, advertises both; Task 6's
   * integration suite is where that stops being a claim. Any future adapter
   * for a server without MOVE must implement the copy-then-delete itself
   * rather than inherit this one.
   */
  move(folder: string, uids: number[], targetFolder: string): Promise<void>;
  /**
   * CREATE `folder`. Phase 4.4's folder management -- the first commands in
   * this interface that change the server's MAILBOX TOPOLOGY rather than
   * where a message sits inside it.
   *
   * A NAME THAT ALREADY EXISTS MUST BE A THROW, and this is `move`'s
   * falsy-return trap in a second place. imapflow's `mailboxCreate` does not
   * reject when the server answers ALREADYEXISTS: it resolves with
   * `{ path, created: false }` (observed against Dovecot 2.3.19 -- creating an
   * existing "Taken" returned exactly that). An adapter passing that through
   * as success would let Conduit stamp a fresh folder row -- its own
   * sync_enabled, its own first-sight defaults -- over a mailbox that was
   * already there and may already hold mail. Turn `created: false` into a
   * thrown error naming the folder.
   *
   * A DEEP NAME AUTO-CREATES ITS PARENTS, and they arrive UNUSABLE. Creating
   * "A/B/C" when neither "A" nor "A/B" exists succeeds and leaves both of them
   * listed as `\NonExistent \HasChildren \Noselect` (observed, same server).
   * Nothing here has to do anything about that -- discovery records them as
   * unselectable rows, which is what they are, and every write path already
   * refuses an unselectable folder -- but a caller expecting "one create, one
   * new mailbox" is wrong about servers.
   */
  createMailbox(folder: string): Promise<void>;
  /**
   * RENAME `folder` to `newFolder`.
   *
   * THIS IS A SUBTREE RENAME AND THE CALLER MUST TREAT IT AS ONE. RFC 3501
   * 6.3.5 requires inferior hierarchical names to be renamed with their
   * parent, and Dovecot 2.3.19 does exactly that: renaming "Parent" to
   * "Renamed" moved "Parent/Child" to "Renamed/Child" in the same command
   * (observed). A caller that re-keys only the exact name leaves every
   * descendant's stored mail pointing at a mailbox that no longer exists.
   *
   * UIDVALIDITY SURVIVES IT, on that server: a folder renamed with a message
   * in it came back with the same UIDVALIDITY and its UIDs intact (observed).
   * That is what lets mail-folders.ts re-key the sync cursor rather than
   * discard it -- and where a server does NOT preserve it, the existing
   * UIDVALIDITY-mismatch path re-walks the folder, so the caller is right
   * either way rather than only on Dovecot.
   *
   * Two refusals seen from Dovecot, both as thrown errors and both worth
   * knowing because the service refuses them EARLIER with better sentences:
   * "Target mailbox already exists", and "Renaming INBOX isn't supported".
   */
  renameMailbox(folder: string, newFolder: string): Promise<void>;
  /**
   * DELETE `folder`. **THIS DESTROYS THE MESSAGES IN IT, ON THE SERVER,
   * IRREVERSIBLY**, and no server refusal stands between a caller and that:
   * Dovecot 2.3.19 deleted a mailbox holding a message without complaint and
   * the message was gone (observed). Callers must decide for themselves
   * whether the mailbox is empty; `messageCount` below is how, and
   * AccountSync.deleteMailboxIfEmpty is the only caller because it puts the
   * two in one visit to the loop.
   *
   * A PARENT WITH CHILDREN IS NOT DELETED, AND THE RESULT IS A TRAP. RFC 3501
   * 6.3.4 lets a server keep the name as a placeholder, and Dovecot does:
   * after deleting "P2" while "P2/Kid" existed, P2's own message was destroyed
   * and P2 STAYED IN LIST -- carrying `\HasChildren` and, on that version,
   * NEITHER `\Noselect` NOR `\NonExistent`. So the listing says an ordinary
   * selectable folder while STATUS answers false and APPEND answers "Mailbox
   * doesn't exist" (all observed together). Discovery would go on re-sighting
   * it as live and the walk would open it and fail the pass, every pass. That
   * is why mail-folders.ts refuses to delete a folder with children rather
   * than finding out what each server does with it.
   */
  deleteMailbox(folder: string): Promise<void>;
  /**
   * How many messages `folder` holds ON THE SERVER (IMAP STATUS MESSAGES).
   *
   * Separate from `status()` rather than a second field on it, deliberately.
   * `status()` runs on every folder of every pass and its own comment defends
   * carrying UIDVALIDITY alone; this runs on the rare, deliberate delete. The
   * two ask the same command for different reasons and neither should pay for
   * the other's.
   *
   * NOT answerable from mail_messages: Conduit holds only what it has SYNCED,
   * and a folder whose sync is off can hold thousands of messages it has never
   * seen. Counting rows would let exactly the unsynced folders -- the ones a
   * user is most likely to tidy up -- be deleted full.
   *
   * A falsy return is a throw, per RETURN-VALUE DISCIPLINE: imapflow's
   * `status` answers `false` for a mailbox that does not exist (observed), and
   * reading that as zero would make "the folder is already gone" and "the
   * folder is empty" the same answer to the question that guards a delete.
   */
  messageCount(folder: string): Promise<number>;
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

/**
 * What actually authenticates ONE connection, already resolved: a password, or
 * a short-lived OAuth access token. Produced by mail-oauth.ts's
 * resolveConnectionAuth and consumed by both protocols -- it is
 * ImapConnectionSettings' `auth` field and mail-send.ts's
 * SendMailTransportFactory's second argument, so IMAP and SMTP cannot end up
 * disagreeing about what "the credential" is.
 *
 * NOT MailCredentials, AND THE DIFFERENCE IS THE POINT. What is STORED is a
 * password pair or a refresh token (mail-crypto.ts's union); what a connection
 * needs is one secret for one protocol, right now. Between the two sits a
 * choice (which password half?) and possibly a network round trip (exchange the
 * refresh token for an access token). Handing the stored shape to the adapter
 * would put that round trip inside the one module that is supposed to be a thin
 * mapping onto imapflow and nodemailer, and would give it a reason to reach for
 * the database. This type is the resolved value, so the adapter stays a
 * mapping.
 *
 * A DISCRIMINATED UNION, NOT TWO OPTIONAL FIELDS. `password?: string;
 * accessToken?: string` was the smaller diff and makes "neither" and "both"
 * both representable and both meaningless -- the same argument
 * mail_accounts.auth_method's comment (db/schema.ts) makes for being one column
 * rather than a kind/provider pair. "Neither" is the dangerous one: it would
 * hand imapflow a blank password, and a blank password does not fail loudly, it
 * fails at the SERVER and arrives as an account whose mail quietly stopped.
 */
export type MailConnectionAuth =
  | { kind: "password"; password: string }
  | { kind: "oauth"; accessToken: string };

/**
 * THIS INTERFACE CHANGED IN PHASE 8, AND THE REST OF THE CONTRACT DID NOT.
 * `password: string` became `auth: MailConnectionAuth`. Everything the phase's
 * spec calls IMAP-typed-on-purpose -- ImapFolderStatus.uidvalidity,
 * ImapMessageDescriptor.uid, and every method on ImapClient that Phase 4.4's
 * filing, per-message selection, live list and folder management are built on
 * -- is untouched by it. This is the factory's INPUT, not the sync engine's
 * view of a mailbox: it is where the secret comes from, which is the one thing
 * the spec says this phase changes ("nothing in the mail engine changes ... what
 * changes is where the secret comes from and what shape it is"). An adapter
 * against a different server still implements the same commands.
 */
export interface ImapConnectionSettings {
  accountId: string;
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  auth: MailConnectionAuth;
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
