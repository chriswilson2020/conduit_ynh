import { inArray, sql } from "drizzle-orm";
import type {
  BulkThreadActionInput, BulkThreadFailureReason, BulkThreadResult, BulkThreadSkipReason,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { folderKey } from "./mail-folders.js";
import { consoleSyncLogger, type SyncLogger } from "./mail-imap.js";
import { UID_CHUNK, chunked } from "./mail-sync.js";
import { archiveThread } from "./mail-threads.js";
import { publish } from "./sse.js";

/**
 * The bulk thread actions (Phase 4.1): Trash and Archive MOVE the underlying
 * messages on the IMAP server, "Hide in CRM" sets the pre-4.1 CRM-side thread
 * archive. One entry point, `moveThreads`, because the three arrive on one
 * endpoint and the client wants one per-thread answer whichever it asked for.
 *
 * ---------------------------------------------------------------------------
 * WHAT A MOVE ACTUALLY IS HERE
 * ---------------------------------------------------------------------------
 * An optimistic database write, then a queued IMAP MOVE, then a compensating
 * revert if the server refused it (spec, "Move write-back"). The DB moves
 * first so the list reflects the click immediately; the compensation is what
 * keeps that honest -- THE CRM MUST NEVER CLAIM A MOVE THE SERVER REFUSED.
 *
 * Nothing is ever expunged. A trashed message's row survives with `folder` set
 * to the account's Trash and `imap_uid` NULL, visible under a Trash filter;
 * the mail server's own retention owns actual destruction. That is the
 * archive-not-delete rule this CRM applies everywhere.
 *
 * The UID goes NULL because the message's identity on the server has changed:
 * a UID names a message IN A MAILBOX, so the old number means nothing in the
 * target folder and the new one is not worth asking for (see mail-imap.ts's
 * `move` on discarding COPYUID). The target folder's next pass re-sights the
 * message and ingest's (account_id, message_id) upsert restores `imap_uid` --
 * the Phase 4 reconciliation machinery, unchanged. If the target is not
 * sync-enabled (Trash, by default), the row simply keeps its NULL UID and is
 * never updated again, which is exactly what a CRM-side record of a deleted
 * message should look like.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP: NONE, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Mail is shared-visibility in this CRM. Every thread route is auth-only
 * (routes/mail.ts), unlike the ACCOUNT routes, which are owner-scoped -- so
 * any user may archive or trash any thread, matching the shared-inbox model
 * the thread list already implements. `actorId` is therefore audit context for
 * the log line and nothing else: it is never a filter, and it is never
 * compared against an account's owner. The IMAP write still happens through
 * EACH MESSAGE'S OWN account's sync loop, under that account's credentials --
 * the actor's identity never reaches a mail server.
 *
 * Phase 4.2 Task 3 replaces this section: move rights become owner-only, and
 * `actorId` stops being audit-only the moment collectCandidates compares it
 * against each message's account.
 *
 * ---------------------------------------------------------------------------
 * NO INGEST ADVISORY LOCK
 * ---------------------------------------------------------------------------
 * mail-ingest.ts takes the global `mail:ingest` advisory lock because it
 * RESOLVES AND CREATES THREADS, and two concurrent ingests could otherwise
 * build two threads for one conversation. A move creates nothing and resolves
 * nothing: it rewrites `folder`/`imap_uid` on rows that already exist and
 * already belong to a thread. The re-sighting that follows goes through
 * ingestMessage in the ordinary way and takes the lock there. Its absence here
 * is a decision, not an oversight.
 *
 * ---------------------------------------------------------------------------
 * WHAT A MOVE DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 * `seen` is never written here, in either direction. Trashing an unread
 * message does not mark it read -- it is still unread, it is simply in the
 * Trash -- and the CRM has no business changing what a user has and has not
 * looked at as a side effect of filing. That leaves one question this service
 * deliberately does not answer: an unread message moved to Trash would go on
 * counting towards the unread badge forever, since nothing ever re-sights an
 * unsynced Trash. The coordinator's ruling puts the fix in the COUNTING, not
 * in the move: Task 4's two unread queries exclude each account's
 * trash_folder, so a trashed unread message stops counting while an ARCHIVED
 * one keeps counting (archive is a filed message, still to be read). Nothing
 * here changes if that ruling moves; the flag stays untouched either way.
 *
 * ---------------------------------------------------------------------------
 * RESIDUAL STATES (accepted, rare, operator-fixable)
 * ---------------------------------------------------------------------------
 * The optimistic write and the server MOVE cannot be one atomic act, so there
 * are states this service can leave behind. The first two have the same shape
 * -- rows saying `folder` = target with a NULL uid while the message is still
 * in the source folder -- and the same reason they do not self-heal: the source
 * folder's cursor is already PAST that UID, so no later pass re-sights it
 * there (fetchNewer only walks upwards), and the target folder never had it.
 * Short of a UIDVALIDITY reset re-walking the source folder, they persist. The
 * third is the opposite case and is listed anyway because it looks alarming:
 * it diverges from neither the server nor itself, and it does self-heal.
 *
 * - A HARD CRASH between the optimistic commit and the queued MOVE (the
 *   process is killed, the machine loses power). The commit landed, the MOVE
 *   never ran, and nothing on restart knows a move was intended. Accepted
 *   rather than solved: making it impossible would need an outbox table and a
 *   resume path, which is a lot of machinery for a state a user fixes by moving
 *   the message back in any mail client, or an operator by letting the folder
 *   re-walk. The window is not as narrow as "one queue hop" suggests, either:
 *   it is however long the account's serial loop takes to REACH the queued
 *   MOVE, which is milliseconds on an idle account but a whole first backfill
 *   when the loop is mid-pass -- the same wait moveThreads' returned promise
 *   inherits (see its "THE RETURNED PROMISE WAITS FOR THE SERVER" paragraph,
 *   and the request cap Task 4's route applies because of it).
 * - A COMPENSATING REVERT THAT ITSELF FAILS (the database went away between
 *   the MOVE's rejection and the revert). Same state, but this one is LOUD:
 *   revertMove logs an error carrying the account, both folder names and the
 *   affected message ids precisely so an operator can find the rows.
 * - A PARTIAL CHUNK, where an accepted chunk stays moved after a later one is
 *   refused. Not divergence -- the database agrees with the server -- and it
 *   converges properly on the next pass of the target folder IF that folder is
 *   synced (Archive is by default; Trash is not -- see queueMoves).
 */

// --- Seams -----------------------------------------------------------------

/** The slice of one AccountSync this service uses -- see mail-sync.ts's
 * moveMessages for the contract (serial, chunked, rejects on failure, fast
 * rejection during a backoff). */
export interface MoveSyncAccount {
  moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void>;
}

/**
 * The slice of mail-sync.ts's SyncManager this service uses. Structural rather
 * than the class, for the same reason mail-send.ts's SendMailSyncManager is: a
 * test can hand in a move that fails without standing up a sync engine.
 *
 * Null when no manager exists (NODE_ENV=test, or a deployment with sync
 * disabled). UNLIKE the Sent-folder APPEND, that is not a "skip the
 * best-effort step" case -- see accountStateOf.
 */
export interface MoveSyncManager {
  get(accountId: string): MoveSyncAccount | undefined;
}

export interface MoveThreadsDeps {
  syncManager: MoveSyncManager | null;
  /** Defaults to the console logger, like the sync engine's own. */
  logger?: SyncLogger;
}

// --- Small helpers ---------------------------------------------------------

/** Message ids per unrecoverable-divergence log line (see revertMove). */
const MAX_LOGGED_IDS = 500;

/**
 * How much of a caught error's text a log line may carry, mirroring
 * mail-sync.ts's MAX_LAST_ERROR_CHARS (and its `truncate`) for `last_error`.
 *
 * Two places it matters. revertMove's failure, where the error comes from the
 * DATABASE rather than a mail server: a drizzle error quotes the failing
 * statement AND every bind parameter, and this module's statements carry three
 * parameters per row for a chunk of up to UID_CHUNK rows -- ~1500 of them at
 * full size. Untruncated, one revert failure writes a megabyte of uuids into
 * the journal, burying the message ids that are the whole point of the line.
 *
 * And the per-thread `error` on the WIRE (Outcomes.fail), which a browser
 * renders in a toast: a mail server's refusal text is arbitrary, a bulk
 * response can carry 50 of them, and neither the response nor the toast is a
 * place to discover that. The machine-readable half of that answer is `reason`,
 * which is never truncated because it is an enum.
 */
const MAX_LOGGED_ERROR_CHARS = 500;

type ResultItem = BulkThreadResult["results"][number];

/**
 * The skip reasons that are recorded against a MESSAGE, as opposed to the one
 * that describes a thread nothing applied to.
 *
 * `out_of_scope` is deliberately not one of them: a row outside the view folder
 * (or carved out as Sent) is never examined far enough to have a reason of its
 * own -- see the scope-first ordering in collectCandidates -- so it can only be
 * the answer when a thread finishes with nothing recorded at all. Typed out
 * rather than commented, so noteSkip cannot be handed it by mistake and the
 * rank table below cannot silently acquire a meaningless entry for it.
 *
 * `not_owner` (Phase 4.2) is, BY CONTRAST, one of these -- unlike out_of_scope,
 * it IS recorded per message: a message on an account the actor does not own
 * is still examined far enough to be classified (Task 3 wires the actual
 * ownership filter into collectCandidates), it is simply not this actor's to
 * move. That is what earns it a slot in SKIP_REASON_RANK below rather than a
 * third out_of_scope-style exclusion from this type.
 */
type NotedSkipReason = Exclude<BulkThreadSkipReason, "out_of_scope">;

/**
 * Precedence when one thread hits several skip causes -- lower wins. Written
 * as a table rather than an if-chain so the order is one readable fact; see
 * Outcomes.noteSkip for why it runs this way round.
 *
 * `not_owner` (Phase 4.2, Task 3 wires the filter that produces it) sits
 * directly below archived_account: both are causes the CURRENT USER cannot
 * clear by simply asking again, unlike the two below them (awaiting_
 * reconciliation self-heals on the next sync pass; already_in_target means
 * the goal already holds). Between those two the deciding fact is
 * CONTINUITY, not specificity: archived_account is what a mixed thread
 * already reported before 4.2, so holding it at rank 0 means adding
 * not_owner changes no existing thread's reported reason -- an archived
 * account someone else owns keeps saying archived_account. The per-row
 * check order in collectCandidates agrees on purpose (the archived_account
 * drop runs before the ownership seam), so promoting not_owner to rank 0
 * would also mean moving that check, silently changing what mixed threads
 * report. This ordering only matters when one thread's messages hit more
 * than one cause at once, which is rare -- see shared's
 * bulkThreadSkipReasonSchema comment for the fuller reasoning.
 */
const SKIP_REASON_RANK: Record<NotedSkipReason, number> = {
  archived_account: 0,
  not_owner: 1,
  awaiting_reconciliation: 2,
  already_in_target: 3,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** As mail-sync.ts's own `truncate` -- same shape, same trailing ellipsis, so
 * a truncated line reads the same wherever it was written. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * Do two stored folder names mean the same mailbox? On mail-folders.ts's
 * folderKey, which is where that rule (INBOX case-folded, everything else byte
 * for byte) is written down once for the walk and this service alike.
 *
 * Getting it wrong is silent in both directions: a message whose folder does
 * not match the view it was selected in is one this service leaves behind, and
 * one that matches too eagerly is a message moved out of a mailbox the user was
 * not looking at.
 */
function sameFolder(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/**
 * One message this action will move, carrying everything the later steps need
 * so nothing has to look its account up again.
 *
 * `folder`/`imapUid` are the values BEFORE the optimistic update -- the
 * compensating revert restores exactly these. `targetFolder`/`sync` are the
 * account's, resolved once during collection and DENORMALISED onto the row: the
 * alternative, re-reading the account later, would open a window in which a
 * Settings edit changed the target between the optimistic UPDATE and the MOVE,
 * sending messages somewhere the database does not say they went.
 */
interface Candidate {
  id: string;
  threadId: string;
  accountId: string;
  folder: string;
  imapUid: number;
  targetFolder: string;
  sync: MoveSyncAccount;
}

/** One queued IMAP MOVE: a chunk of one account's messages out of one source
 * folder. */
interface MoveGroup {
  accountId: string;
  sync: MoveSyncAccount;
  folder: string;
  targetFolder: string;
  rows: Candidate[];
}

/**
 * The per-thread answers, with the precedence the bulk contract needs.
 *
 * FAILURE WINS, always, and the FIRST failure's message is the one reported. A
 * thread whose messages span two accounts (or two chunks) can have one part
 * move and another refused; calling that a success because something worked
 * would be the exact dishonesty the compensation exists to prevent. The
 * partial move that already landed is left alone -- see queueMoves.
 */
class Outcomes {
  private readonly byThread = new Map<string, ResultItem>();
  /**
   * Why each thread's eligible set came out empty, recorded as the rows are
   * filtered and read only if the thread ends up with nothing to move.
   *
   * Kept apart from `byThread` because the two are decided at different times:
   * a skip is only KNOWN to be a skip once every one of the thread's messages
   * has been looked at, so collection notes the causes as it goes and `skip`
   * resolves them at the end.
   */
  private readonly skipReasons = new Map<string, NotedSkipReason>();

  fail(threadId: string, error: string, reason: BulkThreadFailureReason): void {
    const existing = this.byThread.get(threadId);
    if (existing !== undefined && existing.ok === false) return;
    // Capped on the way OUT, not at the throw site: this string reaches a
    // browser and a toast, and the one source that can be unbounded is a mail
    // server's own refusal text (see MAX_LOGGED_ERROR_CHARS).
    this.byThread.set(threadId, {
      threadId, ok: false, error: truncate(error, MAX_LOGGED_ERROR_CHARS), reason,
    });
  }

  /**
   * Note why one of this thread's messages was dropped from the eligible set.
   * The strongest reason seen wins, in SKIP_REASON_RANK's order (archived_
   * account, then not_owner, then awaiting_reconciliation, then already_in_
   * target): the first two mean a message is somewhere the CRM could not move
   * it FROM (an account state or an ownership fact, neither fixable by this
   * actor asking again), the third is transient, and the last means the goal
   * already holds -- so reporting an unresolved-for-this-actor cause ahead of
   * a self-resolving or already-finished one is the honest ordering when a
   * thread has more than one. Task 3 wires the ownership filter that is the
   * one caller of noteSkip(..., "not_owner") -- this class already carries the
   * type and the rank slot the moment the shared enum grows the value.
   */
  noteSkip(threadId: string, reason: NotedSkipReason): void {
    const existing = this.skipReasons.get(threadId);
    if (existing !== undefined && SKIP_REASON_RANK[existing] <= SKIP_REASON_RANK[reason]) return;
    this.skipReasons.set(threadId, reason);
  }

  /** A successful no-op: nothing was eligible to move (spec's `skipped`). */
  skip(threadId: string): void {
    if (this.byThread.has(threadId)) return;
    this.byThread.set(threadId, {
      threadId, ok: true, skipped: true,
      // Nothing recorded means nothing was ever in scope: in folder-scoped
      // mode every message sits in some other folder, and in whole-thread mode
      // the conversation is nothing but Sent mail. That is `out_of_scope`, and
      // it is a different statement from already_in_target -- "this action
      // never applied to this thread" rather than "it was already done" -- so
      // it gets its own value rather than being folded into that one.
      reason: this.skipReasons.get(threadId) ?? "out_of_scope",
    });
  }

  succeed(threadId: string): void {
    if (this.byThread.has(threadId)) return;
    this.byThread.set(threadId, { threadId, ok: true });
  }

  has(threadId: string): boolean {
    return this.byThread.has(threadId);
  }

  /**
   * What the summary log reports, counted off the FINISHED answers rather than
   * off any one step's bookkeeping.
   *
   * That is the point: threads failed by an account-level refusal or by an
   * unknown id never reach the queue, so a counter derived from the queue's
   * failures said `failed: 0` for a bulk action in which every single thread
   * failed -- the exact case an operator goes looking for.
   */
  tally(): { failed: number; skipped: number } {
    let failed = 0;
    let skipped = 0;
    for (const item of this.byThread.values()) {
      if (!item.ok) failed += 1;
      else if (item.skipped === true) skipped += 1;
    }
    return { failed, skipped };
  }

  /**
   * One entry per REQUESTED id, in request order (the bulk contract, so the
   * client can zip failures back to rows). Duplicates in the request produce
   * duplicate entries rather than being collapsed -- the response is a
   * per-request answer, not a set.
   */
  list(threadIds: readonly string[]): ResultItem[] {
    return threadIds.map((threadId) => this.byThread.get(threadId)
      // Unreachable: every id is classified below. A defensive answer beats a
      // response that silently drops a row the client asked about -- and it
      // still has to satisfy the contract, hence a reason.
      ?? { threadId, ok: false, error: "no result was produced for this thread", reason: "not_found" });
  }
}

// --- Move targets ----------------------------------------------------------

/**
 * What an account's OWN folders mean for the eligibility filters -- needed for
 * every account, including the ones that cannot move anything, because whether
 * a message is IN SCOPE is decided before (and independently of) whether its
 * account can carry the move out.
 */
interface AccountScope {
  /** Trimmed, for the whole-thread mode's Sent carve-out. */
  sentFolder: string;
  /** null when nothing has ever classified one for this action. */
  targetFolder: string | null;
}

/**
 * What one account can contribute to this move.
 *
 * - `ready`: a resolved target and a running loop.
 * - `refused`: it cannot move anything, and any IN-SCOPE message of its own
 *   fails that message's thread with `error`.
 * - `unmovable`: an ARCHIVED account, whose rows are excluded outright.
 */
type AccountState =
  | { kind: "ready"; scope: AccountScope; targetFolder: string; sync: MoveSyncAccount }
  | { kind: "refused"; scope: AccountScope; error: string; reason: BulkThreadFailureReason }
  | { kind: "unmovable"; scope: AccountScope };

/**
 * One account's state for this action.
 *
 * TARGET RESOLUTION IS A COLUMN READ, not a search. mail-folders.ts already
 * did the work at discovery: it prefers a LISTING-classified folder over a
 * name-matched one, skips unselectable mailboxes, and fills
 * trash_folder/archive_folder only while they are NULL, so a user's override
 * always wins. NULL therefore means "nothing has ever classified one" -- the
 * spec's "detect for me" state, not "I want no target" -- and it is one of the
 * two refusals, with a sentence a user can act on.
 *
 * Trimmed on read, mirroring normalizeSentFolder: an IMAP mailbox name is
 * compared byte for byte downstream, so a stored " Archive " must not become a
 * second mailbox. (Task 4 adds the write-side trim when the Settings form
 * starts submitting these columns; until then this is the only guard.)
 *
 * A MISSING SYNC LOOP IS THE OTHER REFUSAL, not a skipped best-effort step --
 * the one place this service deliberately differs from mail-send's APPEND.
 * Moving the DB rows with no loop to carry the MOVE out would leave the CRM
 * showing messages in a folder they never reached, and nothing would ever
 * correct it: the source folder's cursor is already past them, and the target
 * folder's pass has nothing to re-sight.
 *
 * AN ARCHIVED ACCOUNT IS CHECKED FIRST, and is NOT a refusal. SyncManager
 * tears its loop down for as long as the account stays archived (unarchiving
 * rebuilds it -- mail-accounts.ts's unarchiveAccount notifies
 * applyAccountChange, which calls ensureSync again) -- while its message rows
 * survive, because archiving an account keeps its mail (archive-not-delete).
 * Reported as a failure, those rows would fail every thread carrying one for
 * a reason NOTHING IN THE MAIL VIEW connects to its cause or can fix: the
 * remedy lives in Settings, months away from the click. So they are
 * treated exactly like a NULL uid -- excluded from the eligible set, never
 * failed -- and a thread whose whole in-scope set is such rows reports the
 * ordinary `{ ok: true, skipped: true }` no-op.
 */
function accountStateOf(
  account: {
    id: string; label: string; archivedAt: Date | null; sentFolder: string;
    trashFolder: string | null; archiveFolder: string | null;
  },
  action: "trash" | "archive",
  syncManager: MoveSyncManager | null,
): AccountState {
  const raw = action === "trash" ? account.trashFolder : account.archiveFolder;
  const trimmed = (raw ?? "").trim();
  const targetFolder = trimmed.length === 0 ? null : trimmed;
  const scope: AccountScope = { sentFolder: account.sentFolder.trim(), targetFolder };
  if (account.archivedAt !== null) return { kind: "unmovable", scope };
  const role = action === "trash" ? "Trash" : "Archive";
  if (targetFolder === null) {
    return {
      kind: "refused",
      scope,
      error: `account "${account.label}" has no ${role} folder yet`
        + " -- set one in Settings, or wait for a sync pass to detect it",
      reason: "no_target",
    };
  }
  const sync = syncManager?.get(account.id);
  if (sync === undefined) {
    return {
      kind: "refused", scope,
      error: `mail sync is not running for account "${account.label}"`,
      reason: "no_sync",
    };
  }
  return { kind: "ready", scope, targetFolder, sync };
}

// --- The service -----------------------------------------------------------

/**
 * Apply one bulk action to `input.threadIds`, returning one result per
 * requested thread.
 *
 * `hide` is the CRM-side thread archive applied in bulk and touches no
 * mailbox. `trash`/`archive` MOVE messages, in the two modes
 * `bulkThreadActionInputSchema.folder` selects:
 *
 * - FOLDER-SCOPED (`folder` present -- the list multi-select): only each
 *   thread's messages currently in THAT folder, the view the selection was
 *   made in (the selection-granularity ruling).
 * - WHOLE-THREAD (`folder` absent -- the conversation view and record Mail
 *   tab buttons): every one of the thread's messages EXCEPT those already in
 *   the target folder and those in the account's Sent folder. Archiving a
 *   conversation must never empty Sent.
 *
 * Three kinds of message are dropped from the eligible set in either mode, and
 * a thread left with none is reported `{ ok: true, skipped: true }` -- a
 * successful no-op, never a failure:
 *
 * - AWAITING RECONCILIATION (`imap_uid` NULL -- a just-sent message the Sent
 *   pass has not re-sighted): there is no UID to name it to the server. Rare,
 *   and it self-heals the moment the user asks again after the next pass.
 * - ALREADY IN THE TARGET FOLDER: nothing to do.
 * - OWNED BY AN ARCHIVED ACCOUNT: unmovable while the account stays archived,
 *   and deliberately not a failure -- see accountStateOf.
 *
 * THE RETURNED PROMISE WAITS FOR THE SERVER. Each queued MOVE runs on its
 * account's serial sync loop, so a bulk action against an account halfway
 * through a first backfill waits for that backfill. That is deliberate and not
 * a bound worth adding here: the per-thread failure this function reports is
 * only trustworthy because it waited to see whether the server accepted, and a
 * timeout would produce exactly the "claimed a move the server refused" state
 * the compensation exists to prevent.
 *
 * What Task 4's route does about that, per the coordinator's ruling, is cap
 * the SIZE of the wait rather than its duration: trash/archive take at most 50
 * thread ids per request (hide keeps the contract's 200, since it touches no
 * mailbox), and the endpoint documents that a proxy 504 means the answer was
 * lost, NOT that the move failed -- the work continues on the loop, and the
 * client should refetch rather than retry blindly.
 */
export async function moveThreads(
  db: Database, actorId: string, input: BulkThreadActionInput, deps: MoveThreadsDeps,
): Promise<BulkThreadResult> {
  const logger = deps.logger ?? consoleSyncLogger;
  const requested = input.threadIds;
  // Deduplicated for the work, not for the answer: a repeated id must not
  // move its messages twice, but it still gets its own result entry.
  const unique = [...new Set(requested)];
  const outcomes = new Outcomes();
  let messages = 0;
  let refusedAccounts = 0;

  if (input.action === "hide") {
    await hideThreads(db, unique, outcomes);
  } else {
    // `action` is narrowed to the two MOVE kinds by the branch above, and is
    // passed on explicitly so nothing downstream has to re-establish it.
    const collected = await collectCandidates(
      db, { folder: input.folder, action: input.action }, unique, deps.syncManager, outcomes,
    );
    const { candidates } = collected;
    messages = candidates.length;
    refusedAccounts = collected.refusedAccounts;
    if (candidates.length > 0) {
      await applyOptimisticMove(db, candidates);
      const failures = await queueMoves(db, candidates, logger);
      // Every failure out of the queue is the same kind: the mail server said
      // no (or the queue refused while the account was in backoff), and the
      // rows have been put back.
      for (const [threadId, error] of failures) outcomes.fail(threadId, error, "server_refused");
      for (const row of candidates) outcomes.succeed(row.threadId);
    }
    // Whatever is still unclassified had nothing eligible to move -- every
    // message either awaited reconciliation, sat outside the view folder, was
    // already in the target, or belonged to an archived account. A successful
    // no-op, not a failure.
    for (const threadId of unique) if (!outcomes.has(threadId)) outcomes.skip(threadId);
  }

  // One line per bulk action, and the counts come off the ANSWERS (see
  // Outcomes.tally) so they describe what the caller was actually told.
  // `folder` is logged as received even for `hide`, which ignores it: what the
  // request said is the useful thing to have in the journal.
  logger.info(
    {
      actorId, action: input.action, folder: input.folder ?? null,
      threads: unique.length, messages, refusedAccounts, ...outcomes.tally(),
    },
    "mail-move: bulk action",
  );
  return { results: outcomes.list(requested) };
}

/**
 * "Hide in CRM": the pre-4.1 thread archive, one thread at a time.
 *
 * Delegated to mail-threads.ts rather than reimplemented in bulk, because that
 * function owns the idempotence (archiving an archived thread is a no-op that
 * still succeeds) and the SSE hint. `folder` is ignored entirely in both
 * modes: a CRM-side flag has no concept of an IMAP folder.
 *
 * Sequential, and one failure does not stop the rest: an unknown id fails ITS
 * thread and the others still hide, which is the partial-failure shape the
 * bulk contract promises. AN UNKNOWN ID IS THE ONLY per-thread failure this
 * path has, so it is the only one caught: anything else (the database went
 * away mid-batch) is not a fact about one thread, has no honest `reason` code
 * to carry, and is re-thrown to become the 500 it is.
 *
 * ONE SSE HINT FOR THE BATCH, not one per thread: archiveThread's own hint is
 * suppressed and this publishes a single frame carrying every hidden thread's
 * keys, so hiding 200 threads costs one invalidation round instead of 200.
 * The trade, stated because the single-thread path does not make it: that path
 * publishes only when a thread's archived_at actually CHANGED, and this cannot
 * tell -- archiveThread is idempotent and reports the thread either way -- so a
 * bulk hide of threads that were all already hidden publishes one hint where
 * the per-thread path would have published none. One redundant refetch round
 * per request the user explicitly made is a better trade than 200 frames.
 */
async function hideThreads(db: Database, threadIds: readonly string[], outcomes: Outcomes): Promise<void> {
  const hidden = new Set<string>();
  for (const threadId of threadIds) {
    try {
      await archiveThread(db, threadId, { publishHint: false });
      outcomes.succeed(threadId);
      hidden.add(threadId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      outcomes.fail(threadId, error.message, "not_found");
    }
  }
  if (hidden.size > 0) publishMoveHints(hidden);
}

/**
 * The messages this action will move, with the threads that cannot move
 * already recorded on `outcomes`: an unknown thread id, and any thread with an
 * IN-SCOPE message on an account that refused (see the ordering note in the
 * row loop -- a refusal follows the eligibility filters, it never precedes
 * them).
 *
 * Three reads, in this order: the requested threads (to tell "no such thread"
 * apart from "nothing to move"), their messages, and the accounts those
 * messages belong to.
 *
 * THE ACCOUNTS ARE READ HERE, at move time, and never passed in or cached: a
 * sync pass fills trash_folder/archive_folder the first time it can classify
 * them, so a row read even seconds earlier can be missing the very column this
 * action needs. Same hazard the sync engine's own pass has with its in-memory
 * account row after discovery -- see mail-sync.ts's runPass.
 */
async function collectCandidates(
  db: Database,
  request: { folder: string | undefined; action: "trash" | "archive" },
  threadIds: readonly string[],
  syncManager: MoveSyncManager | null,
  outcomes: Outcomes,
): Promise<{ candidates: Candidate[]; refusedAccounts: number }> {
  const { folder: viewFolder, action } = request;
  const known = new Set((await db.select({ id: mailThreads.id }).from(mailThreads)
    .where(inArray(mailThreads.id, [...threadIds]))).map((row) => row.id));
  for (const threadId of threadIds) {
    if (!known.has(threadId)) {
      outcomes.fail(threadId, new NotFoundError("mail thread", threadId).message, "not_found");
    }
  }
  if (known.size === 0) return { candidates: [], refusedAccounts: 0 };

  // Rows awaiting reconciliation (NULL imap_uid) are FETCHED and dropped in the
  // loop below, not filtered out in SQL. They used to be filtered here, on the
  // grounds that nothing observable changed -- but something does now: a thread
  // whose whole in-scope set was awaiting reconciliation has to report
  // `awaiting_reconciliation` rather than the fallback skip reason, and a row
  // the query never returned cannot say so. The extra rows are few (a NULL uid
  // lasts until the next pass of the Sent folder).
  const messages = await db.select({
    id: mailMessages.id, threadId: mailMessages.threadId, accountId: mailMessages.accountId,
    folder: mailMessages.folder, imapUid: mailMessages.imapUid,
  }).from(mailMessages).where(inArray(mailMessages.threadId, [...known]));
  if (messages.length === 0) return { candidates: [], refusedAccounts: 0 };

  const accountIds = [...new Set(messages.map((row) => row.accountId))];
  const accountRows = await db.select({
    id: mailAccounts.id, label: mailAccounts.label, archivedAt: mailAccounts.archivedAt,
    sentFolder: mailAccounts.sentFolder,
    trashFolder: mailAccounts.trashFolder, archiveFolder: mailAccounts.archiveFolder,
  }).from(mailAccounts).where(inArray(mailAccounts.id, accountIds));

  const states = new Map<string, AccountState>();
  for (const account of accountRows) states.set(account.id, accountStateOf(account, action, syncManager));
  /** Accounts whose refusal actually FIRED -- see the count returned below. */
  const refused = new Set<string>();

  const candidates: Candidate[] = [];
  for (const row of messages) {
    const state = states.get(row.accountId);
    if (state === undefined) continue;
    const { sentFolder, targetFolder } = state.scope;

    // WHAT IS IN SCOPE IS DECIDED FIRST, and everything below depends on that
    // order. A row this action was never going to touch must produce NOTHING:
    // not a refusal (an account that cannot move must not fail a thread whose
    // messages of its own were out of scope -- judging the account before its
    // rows made every such thread fail for a mailbox the user was not acting
    // on), and not a skip REASON either (a NULL-uid message sitting in some
    // other folder is not why a thread selected in THIS view had nothing to
    // move, and reporting it as such tells the user to wait for a pass that
    // will change nothing).
    if (viewFolder === undefined) {
      // Whole-thread: everything except Sent. Archiving a conversation must
      // never empty the Sent folder.
      if (sameFolder(row.folder, sentFolder)) continue;
    } else if (!sameFolder(row.folder, viewFolder)) {
      // Folder-scoped: only the view the selection was made in. Note there is
      // no Sent carve-out here -- a user looking AT the Sent folder and
      // trashing a message means it.
      continue;
    }

    // From here the row IS in scope, so every way of dropping it is something
    // this thread may end up reporting -- as a skip reason if the thread ends
    // with nothing to move, or as the refusal at the bottom.
    //
    // Already there. In whole-thread mode this is the spec's explicit
    // exclusion; in folder-scoped mode it can only fire when the user acts
    // from the target folder's OWN view (archiving from the Archive view),
    // where "nothing to do" is just as true -- and where moving a message into
    // the mailbox it is already in would churn its UID for nothing. A refused
    // account may have no target at all, in which case there is no folder for
    // a message to be "already in". It is tested BEFORE every other drop
    // below, because a message that is already where it was going needs no
    // uid, no live sync, and no ownership check to be finished with.
    if (targetFolder !== null && sameFolder(row.folder, targetFolder)) {
      outcomes.noteSkip(row.threadId, "already_in_target");
      continue;
    }
    // An archived account's rows cannot move while it stays archived, so they
    // are dropped here beside the NULL uids rather than failing anything --
    // see accountStateOf for why a failure whose only remedy is in Settings is
    // the wrong answer to give the mail view.
    if (state.kind === "unmovable") {
      outcomes.noteSkip(row.threadId, "archived_account");
      continue;
    }
    // Task 3 wires the ownership filter here, in SKIP_REASON_RANK's order
    // (directly below archived_account): an in-scope row on an account the
    // actor does not own drops out with noteSkip(row.threadId, "not_owner"),
    // BEFORE the awaiting-reconciliation check and the refusal check below --
    // same "in scope decided first, ownership/availability decided next,
    // refusal last" ordering this function already applies. Needs
    // `accountRows` above to select `userId` and this function to take an
    // `actorId` param.
    //
    // No UID, no way to name this message to the server. Self-heals: the next
    // pass of its folder re-sights it and the upsert restores the uid.
    if (row.imapUid === null) {
      outcomes.noteSkip(row.threadId, "awaiting_reconciliation");
      continue;
    }

    if (state.kind === "refused") {
      // In scope, and this account cannot move it: THIS is what fails the
      // thread. Every other account in the same request carries on (spec).
      outcomes.fail(row.threadId, state.error, state.reason);
      refused.add(row.accountId);
      continue;
    }
    candidates.push({
      id: row.id, threadId: row.threadId, accountId: row.accountId,
      folder: row.folder, imapUid: row.imapUid,
      targetFolder: state.targetFolder, sync: state.sync,
    });
  }
  // Sorted by UID GLOBALLY, across every account and folder in the request.
  // What that buys is a property of the grouping downstream rather than of
  // this array: groupForQueue preserves the order it reads rows in, so each
  // (account, folder) group comes out ascending, which makes the chunk
  // boundaries deterministic (a test can name the uids one queued call
  // carries) and each chunk a compact UID range for the server.
  candidates.sort((a, b) => a.imapUid - b.imapUid);
  // Counted as ACCOUNTS WHOSE REFUSAL FIRED, not accounts in the refused
  // state: after the ordering fix above, an account that refuses but had
  // nothing in scope affects no thread, and logging it as a refusal would send
  // an operator looking for a failure the caller was never told about.
  return { candidates, refusedAccounts: refused.size };
}

/**
 * The optimistic write: `folder` = target, `imap_uid` = NULL, `updated_at`
 * bumped, for every candidate, in ONE transaction (spec, step 2) -- so a
 * failure part-way leaves no half-moved request behind.
 *
 * Statements are grouped by target folder (one per account's target) and
 * chunked by UID_CHUNK, so a 200-thread bulk cannot become one UPDATE with
 * tens of thousands of bind parameters.
 *
 * The SSE hint fires AFTER the commit, never inside it: a hint published from
 * within a transaction that then rolled back would tell every client to
 * refetch a change that never happened. Same rule as the sync engine's
 * writeAccountState.
 */
async function applyOptimisticMove(db: Database, candidates: readonly Candidate[]): Promise<void> {
  const now = new Date();
  const byTarget = new Map<string, string[]>();
  const threadIds = new Set<string>();
  for (const row of candidates) {
    threadIds.add(row.threadId);
    const ids = byTarget.get(row.targetFolder);
    if (ids === undefined) byTarget.set(row.targetFolder, [row.id]);
    else ids.push(row.id);
  }
  await db.transaction(async (tx) => {
    for (const [targetFolder, ids] of byTarget) {
      for (const batch of chunked(ids, UID_CHUNK)) {
        await tx.update(mailMessages)
          .set({ folder: targetFolder, imapUid: null, updatedAt: now })
          .where(inArray(mailMessages.id, batch));
      }
    }
  });
  publishMoveHints(threadIds);
}

/**
 * Every key a moved (or hidden) thread invalidates: the thread list (folder
 * membership changed), each thread's own detail, and the unread count. One
 * publish carrying every key, not one per thread -- the subscriber fan-out is
 * per call.
 *
 * `mail-unread` is in there because the COUNT can change without any `seen`
 * flag changing: per the coordinator's ruling, Task 4's unread queries exclude
 * each account's trash_folder, so trashing an unread message drops it out of
 * the badge (while archiving one leaves it counted).
 */
function publishMoveHints(threadIds: ReadonlySet<string>): void {
  publish({
    keys: [["mail-threads"], ["mail-unread"], ...[...threadIds].map((id) => ["mail-thread", id])],
  });
}

/**
 * Queue the IMAP MOVEs and report which threads the server refused.
 *
 * Grouped per (account, SOURCE folder) -- the folder each message was in
 * before the optimistic update, which is the mailbox the server has to SELECT
 * -- and chunked by UID_CHUNK, the same size AccountSync itself chunks on.
 * That partition is what makes a failure attributable: one rejected call
 * covers exactly one chunk's rows, so exactly those rows are put back.
 *
 * PARTIAL SUCCESS IS LEFT STANDING, honestly. A chunk the server ACCEPTED
 * before a later one failed stays moved and its rows are NOT reverted -- there
 * is no un-MOVE, and the database agrees with the server. Only the failed
 * chunk's rows go back. One residual imprecision, stated rather than hidden:
 * AccountSync chunks internally at the same size, so a rejected call here moved
 * all or none of its UIDs -- but a future caller passing a larger group could
 * have part of it land while this reverts the lot.
 *
 * WHETHER THAT SELF-CORRECTS DEPENDS ON THE TARGET FOLDER, and only ARCHIVE
 * can be relied on. An archive target is sync-enabled by default, so its next
 * pass re-sights the messages and rewrites `folder`/`imap_uid` from what the
 * server actually holds -- the divergence lasts a poll interval. A TRASH
 * target is not synced by default (spec: junk/trash default off), so nothing
 * ever re-sights it: rows the CRM reverted while the server had in fact moved
 * them stay wrong until someone enables that folder in the picker or the
 * source folder is re-walked by a UIDVALIDITY reset. That is the accepted
 * shape of the Trash paragraph in this module's header, and the reason the
 * revert below is the honest default rather than "leave it, a pass will sort
 * it out".
 *
 * Sequential rather than concurrent, across accounts as well as within one:
 * each account's loop is serial anyway, so parallelism would buy only the
 * overlap between different accounts' queues, at the cost of interleaved
 * compensations in the one path where clarity is worth most.
 */
async function queueMoves(
  db: Database, candidates: readonly Candidate[], logger: SyncLogger,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  for (const group of groupForQueue(candidates)) {
    for (const chunk of chunked(group.rows, UID_CHUNK)) {
      try {
        await group.sync.moveMessages(group.folder, chunk.map((row) => row.imapUid), group.targetFolder);
      } catch (error) {
        const message = errorText(error);
        const threads = [...new Set(chunk.map((row) => row.threadId))];
        logger.warn(
          {
            accountId: group.accountId, folder: group.folder, targetFolder: group.targetFolder,
            messages: chunk.length,
            // The threads the CALLER is about to be told failed, so the log
            // line and the response can be lined up without re-deriving which
            // conversations a chunk of message ids belonged to. Bounded by the
            // route's own thread cap.
            threads,
            err: message,
          },
          "mail-move: the server refused a move, reverting those rows",
        );
        await revertMove(db, group, chunk, logger);
        for (const row of chunk) failures.set(row.threadId, message);
      }
    }
  }
  return failures;
}

/**
 * Put one chunk's rows back exactly as they were: each to its OWN folder and
 * its OWN uid.
 *
 * ONE STATEMENT, with the pairs carried in a VALUES join, rather than an
 * UPDATE per row inside a transaction. Each row restores a different pair, so
 * there is no single SET that covers them -- but a 500-row chunk is 500 round
 * trips that way, and this runs while a user is waiting on a bulk action that
 * has ALREADY failed. The failure path is the latency-sensitive one here: the
 * success path returns as soon as the server accepts, while this one is
 * strictly extra time added to an error. A single statement is also atomic on
 * its own, which is what the transaction was there for.
 *
 * A failure to compensate is logged and swallowed: the caller is already
 * reporting this chunk's threads as failed, and throwing would abandon the
 * remaining groups -- whose moves may be perfectly fine -- on top of it. What
 * it leaves behind is the one genuinely unrecoverable state this service can
 * produce (rows claiming a folder the message never reached, with the source
 * folder's cursor already past it, so no pass re-sights it), which is why the
 * log line carries the account, both folder names and the message ids: it is
 * an operator's only handle on the rows. See the header's RESIDUAL STATES.
 */
async function revertMove(
  db: Database, group: MoveGroup, chunk: readonly Candidate[], logger: SyncLogger,
): Promise<void> {
  const now = new Date();
  try {
    // Casts on every value: a VALUES list carries no type information of its
    // own, so an unadorned parameter arrives as text and fails against the
    // uuid/bigint columns it is compared and assigned to.
    const pairs = sql.join(
      chunk.map((row) => sql`(${row.id}::uuid, ${row.folder}::text, ${row.imapUid}::bigint)`),
      sql`, `,
    );
    // `now.toISOString()`, never the Date itself: a hand-written fragment
    // bypasses drizzle's column mappers, so the value reaches postgres.js
    // unconverted -- and it serialises no Date of its own, it throws on one.
    const timestamp = now.toISOString();
    await db.execute(sql`
      update ${mailMessages} set
        ${sql.identifier(mailMessages.folder.name)} = restored.folder,
        ${sql.identifier(mailMessages.imapUid.name)} = restored.imap_uid,
        ${sql.identifier(mailMessages.updatedAt.name)} = ${timestamp}::timestamptz
      from (values ${pairs}) as restored(id, folder, imap_uid)
      where ${mailMessages.id} = restored.id
    `);
  } catch (error) {
    logger.error(
      {
        accountId: group.accountId, folder: group.folder, targetFolder: group.targetFolder,
        messages: chunk.length,
        // The rows an operator has to go and fix by hand. Capped so one line
        // can never be unbounded; a chunk is at most UID_CHUNK, so today the
        // cap is never the thing that truncates -- it is there so raising
        // UID_CHUNK cannot quietly turn this into a megabyte of log.
        messageIds: chunk.slice(0, MAX_LOGGED_IDS).map((row) => row.id),
        // Capped: this error is a DRIVER error, and drizzle's wrapper quotes
        // the statement and every parameter of it -- see MAX_LOGGED_ERROR_CHARS.
        err: truncate(errorText(error), MAX_LOGGED_ERROR_CHARS),
      },
      "mail-move: could not revert an optimistic move -- these rows now claim a folder the server refused",
    );
    return;
  }
  // The rows changed again, so clients holding the optimistic view have to be
  // told -- otherwise the list would keep showing the move that did not happen
  // until something else invalidated it.
  publishMoveHints(new Set(chunk.map((row) => row.threadId)));
}

/**
 * One queued call per (account, SOURCE folder): the mailbox the server has to
 * SELECT is the one each message was in BEFORE the optimistic update, and a
 * whole-thread move can span several of them on one account.
 *
 * The target and the loop are read off the candidate rows, where collection
 * put them. Re-resolving the account here would open a window in which a
 * Settings edit changed the target between the optimistic UPDATE and the MOVE,
 * sending the messages somewhere the database does not say they went.
 *
 * Insertion order is preserved per group, so each group's uids come out in the
 * ascending order collectCandidates sorted them into.
 */
function groupForQueue(candidates: readonly Candidate[]): MoveGroup[] {
  const groups = new Map<string, MoveGroup>();
  for (const row of candidates) {
    // NUL as the composite-key separator, written as the escape `\0` rather
    // than a literal NUL byte so grep does not classify this file as binary --
    // same convention (and the same reason) as mail-threads.ts's write-back
    // grouping. A folder name is arbitrary user data that could contain any
    // printable separator but never a NUL.
    const key = `${row.accountId}\0${row.folder}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        accountId: row.accountId, sync: row.sync, folder: row.folder,
        targetFolder: row.targetFolder, rows: [row],
      });
    } else group.rows.push(row);
  }
  return [...groups.values()];
}
