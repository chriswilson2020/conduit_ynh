import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  BulkThreadActionInput, BulkThreadFailureReason, BulkThreadResult, BulkThreadSkipReason,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccountFolders, mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { folderKey, isLocked, setFolderSyncEnabled } from "./mail-folders.js";
import { consoleSyncLogger, type SyncLogger } from "./mail-imap.js";
import { UID_CHUNK, chunked } from "./mail-sync.js";
import {
  hideThread, unhideThread, visibleMessageSelfContained, visibleThreads,
} from "./mail-threads.js";
import { publish } from "./sse.js";

/**
 * The bulk thread actions. Three MOVE the underlying messages on the IMAP
 * server -- Trash and Archive (Phase 4.1) to a folder the OWNING ACCOUNT
 * names, File (Phase 4.4) to one the REQUEST names -- and "Hide in CRM" and
 * its inverse write and delete the ACTOR'S OWN mail_thread_hides rows
 * (per-user since Phase 4.3 -- they file the threads out of the actor's views
 * and nobody else's). One entry point, `moveThreads`, because all five arrive
 * on one endpoint and the client wants one per-thread answer whichever it
 * asked for.
 *
 * ---------------------------------------------------------------------------
 * FILING INTO AN UNSYNCED FOLDER TURNS ITS SYNC ON (Phase 4.4)
 * ---------------------------------------------------------------------------
 * It does not warn and it does not refuse. The rejected design was to allow
 * the move and warn the operator that the thread would then vanish from
 * Conduit's view; that is not informed consent, it is a choice between two bad
 * outcomes -- lose the thread, or do not file it where it belongs -- offered
 * as if it were one. A warning there is an admission that the design is wrong.
 *
 * FILING A THREAD INTO A FOLDER IS THE STATEMENT THAT THE FOLDER MATTERS, and
 * acting on that statement is the job; asking the operator to restate it in a
 * dialog is not. The machinery already existed -- setFolderSyncEnabled, the
 * same call PATCH /api/mail/accounts/:id/folders makes -- so this is a call
 * (enableTargetSync), not a mechanism.
 *
 * What it owes in return is a word afterwards, quietly: enabling a sync is a
 * real consequence and nobody should discover it from a bandwidth graph. The
 * response carries `syncEnabled` for that sentence, and the summary log line
 * carries it for the operator who asks later. A notification, not a gate.
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
 * VISIBILITY FIRST, OWNERSHIP SECOND (Phase 4.2)
 * ---------------------------------------------------------------------------
 * Thread ids ARE nameable by every user -- sse.ts fans ["mail-thread", <id>]
 * hints to every subscriber, so ids of threads on other users' private
 * accounts reach every logged-in client. Two ordered checks make that
 * broadcast safe, and the ORDER is what keeps existence from leaking:
 *
 * - VISIBILITY is decided first, batched into collectCandidates' requested-
 *   threads read (mail-threads' record-scope visibleThreads term, the same
 *   rule as the thread detail route). A thread the actor cannot see is
 *   absent from that read exactly as a nonexistent id is, so both take the
 *   same not_found construction path -- byte-indistinguishable answers --
 *   and none of an invisible thread's messages, accounts or folders is ever
 *   examined, so no account label, folder fact or skip reason can reach the
 *   response. The hide path resolves per thread through hideThread
 *   (mail-threads' mustGetThread) and reports invisible identically.
 *   Visibility is MESSAGE-granular past the thread gate too (spec Amendment
 *   4): the messages read carries the self-contained record-scope term, so a
 *   visible thread's foreign PRIVATE copies -- the unlinked cross-account
 *   case -- never enter scope either: never examined, never noted. Without
 *   that, a folder-scoped move on a folder holding only such copies would
 *   answer not_owner where the viewer's own world truthfully says
 *   out_of_scope, disclosing that invisible messages exist there.
 * - OWNERSHIP is decided second, among visible messages only: collectCandidates
 *   compares each in-scope message's account owner against `actorId`, and an
 *   unowned row drops out as the noted skip `not_owner` (spec, Move rights:
 *   only the mailbox owner performs IMAP moves -- a colleague must never
 *   reorganise your actual mailbox; other viewers get Hide-in-CRM).
 *   `not_owner` therefore means precisely "a message you can SEE but do not
 *   own" -- a shared account's, or any message of a deal/project-linked
 *   thread. The two are different answers on purpose: a visible thread is
 *   honestly told WHY nothing moved, an invisible one is denied existing at
 *   all.
 *
 * THE GATE IS A POINT-IN-TIME READ at collection, and the ownership drop is
 * what makes that safe: every row that reaches candidates.push sits on an
 * account the actor OWNS, and owned implies visible in every scope -- so no
 * visibility flip between collection and the queued MOVE can hide a
 * candidate from its own actor. That subset property is LOAD-BEARING:
 * whoever relaxes move rights (say, "colleagues may file the shared
 * mailbox") must re-open the staleness question, because candidates would
 * stop being messages on the actor's own accounts, and a flip landing
 * between collectCandidates and queueMoves would move mail the actor may no
 * longer see.
 *
 * The IMAP write happens through EACH MESSAGE'S OWN account's sync loop,
 * under that account's credentials -- the actor's identity never reaches a
 * mail server; `actorId` is the visibility/ownership subject above and the
 * audit context for the summary log line.
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
 * is still examined far enough to be classified (collectCandidates' ownership
 * drop), it is simply not this actor's to move. That is what earns it a slot
 * in SKIP_REASON_RANK below rather than a third out_of_scope-style exclusion
 * from this type.
 */
type NotedSkipReason = Exclude<BulkThreadSkipReason, "out_of_scope">;

/**
 * Precedence when one thread hits several skip causes -- lower wins. Written
 * as a table rather than an if-chain so the order is one readable fact; see
 * Outcomes.noteSkip for why it runs this way round.
 *
 * `not_owner` (Phase 4.2) sits directly below archived_account: both are
 * causes the CURRENT USER cannot clear by simply asking again, unlike the
 * two below them (awaiting_reconciliation self-heals on the next sync pass;
 * already_in_target means the goal already holds). Between those two the
 * deciding fact is CONTINUITY, not specificity: archived_account is what a
 * mixed thread already reported before 4.2, so holding it at rank 0 means
 * adding not_owner changes no existing thread's reported reason -- an
 * archived account someone else owns keeps saying archived_account. The
 * per-row check order in collectCandidates agrees FOR THAT PAIR (the
 * archived_account drop runs before the ownership drop), so promoting
 * not_owner to rank 0 would also mean moving that check, silently changing
 * what mixed threads report. This ordering only matters when one thread's
 * messages hit more than one cause at once, which is rare -- see shared's
 * bulkThreadSkipReasonSchema comment for the fuller reasoning.
 *
 * The row loop's own check order and this rank coincide for the three
 * NOTED-in-place reasons (archived_account, then not_owner, then
 * awaiting_reconciliation) and diverge in exactly one place: already_in_
 * target is HOISTED to the front of the loop, because "the goal already
 * holds" is a finished answer needing no uid, no live sync and no ownership
 * check to be true -- and (post-Amendment-4) one only ever given about a row
 * the viewer can SEE, whose folder facts the UI shows anyway. The two orders
 * answer different questions: the rank arbitrates the THREAD-level answer
 * among reasons rows actually noted, while the loop gives each row exactly
 * ONE answer, at the first check that settles it. A visible unowned row with
 * a NULL uid is that single-answer rule at work, not a second divergence: it
 * notes not_owner -- where the rank would have landed it anyway (1 beats 2)
 * -- because the mail is not the actor's to move regardless of uid state.
 * Both the hoist and the NULL-uid case are pinned by tests.
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
   * thread has more than one. collectCandidates' ownership drop is the one
   * caller of noteSkip(..., "not_owner").
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

/** The three kinds that MOVE mail. hide/unhide are the CRM-side pair and never
 * reach any of the machinery below. */
type MoveAction = "trash" | "archive" | "file";

/**
 * The `file` action's destination AS ONE ACCOUNT HAS IT (Phase 4.4).
 *
 * A bulk selection can span accounts, and a folder name is per-mailbox: "put
 * these in Clients" is a different mailbox on each account and may not exist
 * on all of them. So the destination is resolved PER ACCOUNT, and an account
 * that cannot receive it refuses only its own messages -- every other account
 * in the same request files normally, which is the partial-success shape the
 * bulk contract already promises.
 *
 * `enableSync` is the filing rule's whole mechanism: filing into a folder IS
 * the statement that the folder matters, so a destination whose sync is off is
 * switched ON rather than warned about (see moveThreads). It is false for a
 * folder already syncing and for a LOCKED one -- INBOX and the account's Sent
 * folder are always walked, and setFolderSyncEnabled refuses to toggle them in
 * either direction, so asking it to would turn filing into the Inbox into a
 * 409 for no reason at all.
 */
type FileTarget =
  | { kind: "usable"; folder: string; enableSync: boolean }
  | { kind: "unusable"; error: string };

/**
 * Where `file` may put mail on each of these accounts.
 *
 * MATCHED BYTE FOR BYTE against the stored folder name, exactly as
 * setFolderSyncEnabled matches its own PATCH target and as UNIQUE
 * (account_id, folder) matches it in the database. The picker renders straight
 * from listAccountFolders, so the name a real client sends back is the one
 * this table holds; a hand-written request spelling it differently gets the
 * unknown_target refusal rather than a fuzzy match, which is the safer answer
 * for a mutation that decides which mailbox a user's mail lands in. That
 * exactness is also what lets the enable step below pass `targetFolder`
 * straight through: it IS the stored name, so the two lookups cannot disagree.
 *
 * A \Noselect destination is refused HERE rather than left to the server. It
 * is a hierarchy node holding no messages, so the IMAP MOVE would fail and the
 * compensation would put the rows back -- an honest outcome, but one reached
 * after an optimistic write, a round trip and a revert, reported as
 * `server_refused` with whatever words that server chose. Refusing it before
 * the write costs one already-fetched column and gives the operator the reason
 * in the app's own words. It also keeps the enable step's precondition true:
 * setFolderSyncEnabled refuses an unselectable folder, so a filing that got
 * that far would 409 mid-request.
 */
async function fileTargetsOf(
  db: Database,
  accounts: readonly { id: string; label: string; sentFolder: string }[],
  targetFolder: string | undefined,
): Promise<Map<string, FileTarget>> {
  const targets = new Map<string, FileTarget>();
  // Unreachable: the shared schema requires a destination for `file` and the
  // route parses through it. Answered rather than asserted, and answered as a
  // refusal so a body that somehow arrived without one cannot file mail
  // somewhere nobody named.
  if (targetFolder === undefined) {
    for (const account of accounts) {
      targets.set(account.id, { kind: "unusable", error: "no destination folder was given" });
    }
    return targets;
  }
  const rows = accounts.length === 0 ? [] : await db.select({
    accountId: mailAccountFolders.accountId,
    folder: mailAccountFolders.folder,
    syncEnabled: mailAccountFolders.syncEnabled,
    selectable: mailAccountFolders.selectable,
  }).from(mailAccountFolders).where(and(
    inArray(mailAccountFolders.accountId, accounts.map((account) => account.id)),
    eq(mailAccountFolders.folder, targetFolder),
  ));
  const byAccount = new Map(rows.map((row) => [row.accountId, row]));
  for (const account of accounts) {
    const row = byAccount.get(account.id);
    if (row === undefined) {
      targets.set(account.id, {
        kind: "unusable",
        error: `account "${account.label}" has no folder named "${targetFolder}"`
          + " -- pick one of its own folders, or wait for a sync pass to discover it",
      });
      continue;
    }
    if (!row.selectable) {
      targets.set(account.id, {
        kind: "unusable",
        error: `folder "${targetFolder}" on account "${account.label}" holds no messages`
          + " on the server (\\Noselect) and cannot be filed into",
      });
      continue;
    }
    targets.set(account.id, {
      kind: "usable",
      folder: row.folder,
      enableSync: !row.syncEnabled && !isLocked(row.folder, account.sentFolder),
    });
  }
  return targets;
}

/**
 * One account's state for this action.
 *
 * TARGET RESOLUTION IS A COLUMN READ for trash/archive, not a search (`file`
 * is the exception -- it names its own, resolved per account by fileTargetsOf
 * above). mail-folders.ts already did the work at discovery for the other two:
 * it prefers a LISTING-classified folder over a
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
  action: MoveAction,
  syncManager: MoveSyncManager | null,
  fileTarget: FileTarget | undefined,
): AccountState {
  // `file` names its own destination and the other two read theirs off a
  // column, so the two arrive here already resolved into the same shape: a
  // folder name or nothing, with the sentence explaining nothing.
  const raw = action === "trash" ? account.trashFolder
    : action === "archive" ? account.archiveFolder
      : fileTarget?.kind === "usable" ? fileTarget.folder : null;
  const trimmed = (raw ?? "").trim();
  const targetFolder = trimmed.length === 0 ? null : trimmed;
  const scope: AccountScope = { sentFolder: account.sentFolder.trim(), targetFolder };
  if (account.archivedAt !== null) return { kind: "unmovable", scope };
  if (action === "file") {
    // The two file-specific refusals, both carrying the reason a Settings
    // link cannot fix (shared: unknown_target). fileTargetsOf produced the
    // sentence; this only decides where it lands. `undefined` is unreachable
    // -- collectCandidates resolves a target for every account it reads --
    // and answers defensively rather than asserting, as Outcomes.list does.
    if (fileTarget === undefined || fileTarget.kind === "unusable") {
      return {
        kind: "refused", scope,
        error: fileTarget?.error ?? `account "${account.label}" has no such folder`,
        reason: "unknown_target",
      };
    }
  } else if (targetFolder === null) {
    const role = action === "trash" ? "Trash" : "Archive";
    return {
      kind: "refused",
      scope,
      error: `account "${account.label}" has no ${role} folder yet`
        + " -- set one in Settings, or wait for a sync pass to detect it",
      reason: "no_target",
    };
  }
  // Unreachable past both branches above: `file` has a usable target and the
  // other two have a non-null column. Narrowing for the `ready` state below,
  // which carries a non-null folder.
  if (targetFolder === null) {
    return {
      kind: "refused", scope,
      error: `account "${account.label}" has no target folder for this action`,
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
 * `hide`/`unhide` are the per-actor Hide-in-CRM pair (mail_thread_hides rows
 * for the ACTOR alone, Phase 4.3) applied in bulk and touch no mailbox -- and
 * nobody else's view. `trash`/`archive`/`file` MOVE messages, in the two modes
 * `bulkThreadActionInputSchema.folder` selects -- and note that `folder` is
 * the SOURCE in both modes, never the destination: `file` names its own in
 * `targetFolder`, which is why it is a second field rather than a second
 * meaning on the first (shared: bulkThreadActionInputSchema):
 *
 * - FOLDER-SCOPED (`folder` present -- the list multi-select): only each
 *   thread's messages currently in THAT folder, the view the selection was
 *   made in (the selection-granularity ruling).
 * - WHOLE-THREAD (`folder` absent -- the conversation view and record Mail
 *   tab buttons): every one of the thread's messages EXCEPT those already in
 *   the target folder and those in the account's Sent folder. Archiving a
 *   conversation must never empty Sent.
 *
 * A thread the actor cannot SEE (record scope, the header's visibility gate)
 * fails as not_found before any of this -- indistinguishable from an id that
 * names nothing -- and a visible thread's individually invisible messages
 * are out of scope entirely, never examined and never reported on (spec
 * Amendment 4). Among the visible messages, four kinds are dropped from the
 * eligible set in either mode, and a thread left with none is reported
 * `{ ok: true, skipped: true }` -- a successful no-op, never a failure:
 *
 * - AWAITING RECONCILIATION (`imap_uid` NULL -- a just-sent message the Sent
 *   pass has not re-sighted): there is no UID to name it to the server. Rare,
 *   and it self-heals the moment the user asks again after the next pass.
 * - ALREADY IN THE TARGET FOLDER: nothing to do.
 * - OWNED BY AN ARCHIVED ACCOUNT: unmovable while the account stays archived,
 *   and deliberately not a failure -- see accountStateOf.
 * - ON AN ACCOUNT THE ACTOR DOES NOT OWN: not this actor's to move (spec,
 *   Move rights) -- see the header and collectCandidates' ownership drop.
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
 * the SIZE of the wait rather than its duration: the three MOVE kinds take at
 * most 50 thread ids per request (hide and unhide keep the contract's 200,
 * since they touch no mailbox), and the endpoint documents that a proxy 504
 * means the answer was lost, NOT that the move failed -- the work continues on
 * the loop, and the client should refetch rather than retry blindly.
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
  /** The destination folder this request switched syncing on for, or null --
   * see the filing rule below, and shared's bulkThreadResultSchema.syncEnabled
   * for what the client does with it. */
  let syncEnabled: string | null = null;

  if (input.action === "hide" || input.action === "unhide") {
    await setHiddenThreads(db, actorId, unique, input.action === "hide", outcomes);
  } else {
    // `action` is narrowed to the three MOVE kinds by the branch above, and is
    // passed on explicitly so nothing downstream has to re-establish it.
    const collected = await collectCandidates(
      db, actorId,
      { folder: input.folder, targetFolder: input.targetFolder, action: input.action },
      unique, deps.syncManager, outcomes,
    );
    const { candidates } = collected;
    messages = candidates.length;
    refusedAccounts = collected.refusedAccounts;
    if (candidates.length > 0) {
      // THE SYNC SWITCH COMES BEFORE THE MOVE, and the order is the whole
      // answer to a two-system write.
      //
      // Filing into a folder whose sync is off turns that sync ON (the Phase
      // 4.4 rule: filing into a folder IS the statement that the folder
      // matters). That makes this two writes -- a local sync_enabled flip and
      // a mail-server MOVE -- and the interesting question is which failure
      // the ordering leaves possible. Done AFTER a successful move, a failed
      // flip would leave mail filed into a folder Conduit does not watch:
      // precisely the vanishing thread the rule exists to prevent, arrived at
      // by accident instead of by warning. Done FIRST, the only reachable
      // failure is the harmless one -- sync switched on for a folder the move
      // then failed to put anything in, which costs one folder's backfill and
      // is undone with one click in the picker.
      //
      // It is also the failure that ends the request: a throw here happens
      // before applyOptimisticMove, so nothing has moved, nothing has been
      // claimed, and the 500 describes a request that did nothing rather than
      // one that did half of something. Its own refusals (a locked or
      // unselectable folder, an unknown name) are all excluded upstream by
      // fileTargetsOf, so what is left to throw is a database that has gone
      // away -- which is not a fact about one thread and has no honest
      // per-thread `reason` to carry, the same judgement setHiddenThreads
      // makes about a non-NotFoundError.
      if (input.action === "file" && collected.enableSyncFor.length > 0) {
        syncEnabled = await enableTargetSync(
          db, actorId, collected.enableSyncFor, input.targetFolder,
        );
      }
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
  // request said is the useful thing to have in the journal. `syncEnabled` is
  // there because it is the one thing this endpoint does that OUTLIVES the
  // request -- an operator asking "why is Conduit suddenly walking Clients"
  // should find the answer in the journal, not infer it from traffic.
  logger.info(
    {
      actorId, action: input.action, folder: input.folder ?? null,
      targetFolder: input.targetFolder ?? null, syncEnabled,
      threads: unique.length, messages, refusedAccounts, ...outcomes.tally(),
    },
    "mail-move: bulk action",
  );
  // Absent rather than null when nothing was switched on: the field is a
  // notification the client renders when it is there, and an always-present
  // null is a shape every reader has to test before ignoring.
  return syncEnabled === null
    ? { results: outcomes.list(requested) }
    : { results: outcomes.list(requested), syncEnabled };
}

/**
 * Turn the `file` destination's sync ON for each account that is about to
 * receive mail there, and report the folder if any switch actually flipped.
 *
 * DELEGATED TO setFolderSyncEnabled, the same call PATCH
 * /api/mail/accounts/:id/folders makes, rather than an UPDATE of its own: the
 * ownership check, the locked/unselectable refusals, the same-value no-op and
 * the folders SSE hint are all rules about this switch, and a second writer
 * that knew only some of them would be a second, quieter answer to the same
 * question. The Phase 4.4 rule is a CALL, not a mechanism.
 *
 * The name it passes is the request's own `targetFolder`, which fileTargetsOf
 * matched byte for byte against the stored row -- so it is that row's name and
 * the lookup cannot miss.
 *
 * `enabled` comes back false from a same-value PATCH, so the reported name is
 * true of at least one real flip. Every account here is one fileTargetsOf
 * found sync-OFF and unlocked, so in practice each flips; the OR is what keeps
 * the sentence honest if one of them was switched on by another tab in the
 * meantime.
 *
 * NO SYNC PASS IS REQUESTED, and that is the one place this deliberately
 * differs from the PATCH route, which calls syncNow. There a switched-on
 * folder has nothing else to make it move, so waiting a poll interval (five
 * minutes, mail-sync's DEFAULT_POLL_INTERVAL_MS) means a click with no visible
 * effect. Here the filing itself is the effect: the rows are already in the
 * database with the destination folder on them, visible in the list
 * immediately, and the next pass restores their UIDs exactly as it does after
 * a trash or an archive. Adding syncNow would mean widening MoveSyncManager
 * for a five-minute head start on a backfill nobody is watching.
 */
async function enableTargetSync(
  db: Database, actorId: string, accountIds: readonly string[], targetFolder: string | undefined,
): Promise<string | null> {
  // Unreachable (the schema requires a destination for `file`), and the
  // defensive answer is "switched nothing on", which is true.
  if (targetFolder === undefined) return null;
  let flipped = false;
  for (const accountId of accountIds) {
    const result = await setFolderSyncEnabled(db, actorId, accountId, {
      folder: targetFolder, syncEnabled: true,
    });
    flipped ||= result.enabled;
  }
  return flipped ? targetFolder : null;
}

/**
 * "Hide in CRM" and its inverse: one hide row per thread FOR THE ACTOR (Phase
 * 4.3 -- the bulk action files the conversations out of the actor's own views
 * and nobody else's), one thread at a time.
 *
 * ONE FUNCTION FOR BOTH DIRECTIONS (Phase 4.4 added `unhide`), because every
 * sentence below is true of both: the same visibility gate, the same
 * per-thread NotFoundError, the same batched hint, the same idempotence. The
 * only asymmetry is in mail-threads' setHidden -- hide is an INSERT ... ON
 * CONFLICT DO NOTHING and unhide a DELETE ... RETURNING -- and that is
 * precisely the difference this level should not be restating.
 *
 * Delegated to mail-threads.ts rather than reimplemented in bulk, because that
 * function owns the idempotence (hiding an already-hidden thread, or unhiding
 * one that was never hidden, is a no-op that still succeeds) and the SSE hint.
 * `folder` is ignored entirely in both modes: a CRM-side filing act has no
 * concept of an IMAP folder.
 *
 * Sequential, and one failure does not stop the rest: an unknown id fails ITS
 * thread and the others still hide, which is the partial-failure shape the
 * bulk contract promises. THE NotFoundError IS THE ONLY per-thread failure
 * this path has, so it is the only one caught -- since Phase 4.2 it covers
 * both an unknown id and a thread the actor cannot see, which mail-threads'
 * mustGetThread deliberately reports identically. Anything else (the
 * database went away mid-batch) is not a fact about one thread, has no
 * honest `reason` code to carry, and is re-thrown to become the 500 it is.
 *
 * ONE SSE HINT FOR THE BATCH, not one per thread: the per-thread hint is
 * suppressed and this publishes a single frame carrying every touched thread's
 * keys, so hiding 200 threads costs one invalidation round instead of 200.
 * The trade, stated because the single-thread path does not make it: that path
 * publishes only when the actor's hide row was actually WRITTEN or REMOVED,
 * and this cannot tell -- setHidden is idempotent and reports the thread
 * either way -- so a bulk unhide of threads that were none of them hidden
 * publishes one hint where the per-thread path would have published none. One
 * redundant refetch round per request the user explicitly made is a better
 * trade than 200 frames.
 */
async function setHiddenThreads(
  db: Database, actorId: string, threadIds: readonly string[], hidden: boolean, outcomes: Outcomes,
): Promise<void> {
  const touched = new Set<string>();
  for (const threadId of threadIds) {
    try {
      await (hidden
        ? hideThread(db, actorId, threadId, { publishHint: false })
        : unhideThread(db, actorId, threadId, { publishHint: false }));
      outcomes.succeed(threadId);
      touched.add(threadId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      outcomes.fail(threadId, error.message, "not_found");
    }
  }
  if (touched.size > 0) publishMoveHints(touched);
}

/** What collectCandidates hands back: the work, the refusal count for the log
 * line, and (Phase 4.4) the accounts whose `file` destination this request is
 * about to start syncing. */
interface CollectedCandidates {
  candidates: Candidate[];
  refusedAccounts: number;
  enableSyncFor: string[];
}

/** A fresh empty answer per call, never one shared constant: the arrays are
 * the caller's to hold, and a module-level literal handed out twice is one
 * accidental push away from a bug nothing local would explain. */
function emptyCollection(): CollectedCandidates {
  return { candidates: [], refusedAccounts: 0, enableSyncFor: [] };
}

/**
 * The messages this action will move, with the threads that cannot move
 * already recorded on `outcomes`: an unknown OR invisible thread id (one
 * answer, deliberately -- see the gate below), and any thread with an
 * IN-SCOPE message on an account that refused (see the ordering note in the
 * row loop -- a refusal follows the eligibility filters, it never precedes
 * them).
 *
 * Three reads, in this order: the requested threads (to tell "no such thread"
 * apart from "nothing to move", with the visibility gate folded in), their
 * VISIBLE messages (the actor's record scope, message-granular -- an
 * invisible row never enters scope), and the accounts those messages belong
 * to.
 *
 * THE ACCOUNTS ARE READ HERE, at move time, and never passed in or cached: a
 * sync pass fills trash_folder/archive_folder the first time it can classify
 * them, so a row read even seconds earlier can be missing the very column this
 * action needs. Same hazard the sync engine's own pass has with its in-memory
 * account row after discovery -- see mail-sync.ts's runPass.
 */
async function collectCandidates(
  db: Database,
  actorId: string,
  request: { folder: string | undefined; targetFolder: string | undefined; action: MoveAction },
  threadIds: readonly string[],
  syncManager: MoveSyncManager | null,
  outcomes: Outcomes,
): Promise<CollectedCandidates> {
  const { folder: viewFolder, action } = request;
  // THE VISIBILITY GATE, folded into the requested-threads read -- one
  // statement for the whole request, never a per-thread resolution loop. A
  // thread the actor cannot see is absent from `known` exactly as a
  // nonexistent id is, so both fall into the same not_found construction
  // below, byte-indistinguishable -- and an invisible thread's messages are
  // never fetched (the next read selects by `known`), so nothing later can
  // leak an account label, a folder fact or a skip reason for it. Record
  // scope, the same rule as the detail route's mustGetThread: a deal/project-
  // linked thread on someone else's private account may be SEEN, and is then
  // honestly refused per message as not_owner in the row loop, while an
  // unlinked one must not have its existence confirmed by any
  // distinguishable answer.
  const known = new Set((await db.select({ id: mailThreads.id }).from(mailThreads)
    .where(and(inArray(mailThreads.id, [...threadIds]), visibleThreads(actorId, "record"))))
    .map((row) => row.id));
  for (const threadId of threadIds) {
    if (!known.has(threadId)) {
      outcomes.fail(threadId, new NotFoundError("mail thread", threadId).message, "not_found");
    }
  }
  if (known.size === 0) return emptyCollection();

  // Rows awaiting reconciliation (NULL imap_uid) are FETCHED and dropped in the
  // loop below, not filtered out in SQL. They used to be filtered here, on the
  // grounds that nothing observable changed -- but something does now: a thread
  // whose whole in-scope set was awaiting reconciliation has to report
  // `awaiting_reconciliation` rather than the fallback skip reason, and a row
  // the query never returned cannot say so. The extra rows are few (a NULL uid
  // lasts until the next pass of the Sent folder).
  //
  // VISIBILITY, by contrast, IS filtered here, in SQL (spec Amendment 4): a
  // message the actor cannot see must never enter scope, because everything
  // the loop below does to a row is observable -- a noted reason, a refusal
  // -- and each would disclose something about a mailbox the actor may not
  // know exists (a foreign private copy's not_owner would reveal messages in
  // a folder where the actor's own world truthfully has nothing, and would
  // outrank the actor's own awaiting_reconciliation). Self-contained form
  // because this select joins neither mail_accounts nor mail_threads. Cost:
  // bounded by the route's 50-thread cap on MOVE requests, and both EXISTS
  // arms are primary-key probes per row -- a different class from the
  // unbounded list scans the 0005/0006 EXPLAIN records measure.
  const messages = await db.select({
    id: mailMessages.id, threadId: mailMessages.threadId, accountId: mailMessages.accountId,
    folder: mailMessages.folder, imapUid: mailMessages.imapUid,
  }).from(mailMessages).where(
    and(inArray(mailMessages.threadId, [...known]), visibleMessageSelfContained(actorId, "record")),
  );
  if (messages.length === 0) return emptyCollection();

  const accountIds = [...new Set(messages.map((row) => row.accountId))];
  const accountRows = await db.select({
    id: mailAccounts.id, userId: mailAccounts.userId,
    label: mailAccounts.label, archivedAt: mailAccounts.archivedAt,
    sentFolder: mailAccounts.sentFolder,
    trashFolder: mailAccounts.trashFolder, archiveFolder: mailAccounts.archiveFolder,
  }).from(mailAccounts).where(inArray(mailAccounts.id, accountIds));

  // ONE READ FOR EVERY ACCOUNT IN THE REQUEST, beside the accounts read
  // rather than per row -- and only for `file`, which is the only action whose
  // destination is not a column of the row already fetched.
  const fileTargets = action === "file"
    ? await fileTargetsOf(db, accountRows, request.targetFolder)
    : new Map<string, FileTarget>();

  const states = new Map<string, AccountState>();
  // Kept beside `states` rather than inside AccountState: whose mailbox this
  // is has nothing to do with what the account can carry out, and the
  // ownership drop below needs it for every state kind alike.
  const ownerOf = new Map<string, string>();
  /** Accounts whose `file` destination is a folder Conduit is not syncing --
   * narrowed to the ones that actually contribute a candidate before anything
   * is switched on (see the return below). */
  const syncOff = new Set<string>();
  for (const account of accountRows) {
    states.set(account.id, accountStateOf(account, action, syncManager, fileTargets.get(account.id)));
    ownerOf.set(account.id, account.userId);
    const target = fileTargets.get(account.id);
    if (target?.kind === "usable" && target.enableSync) syncOff.add(account.id);
  }
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
    // OWNERSHIP, in SKIP_REASON_RANK's order (directly below the
    // archived_account drop, whose precedence for a both-at-once account
    // depends on running first): an in-scope row on an account the actor
    // does not own is not this actor's to move (spec, Move rights), whatever
    // else may be true of it -- checked BEFORE the awaiting-reconciliation
    // and refusal checks below, so an unowned account's missing target or
    // dead loop can never fail the thread with a refusal naming a mailbox
    // the actor has no rights over.
    if (ownerOf.get(row.accountId) !== actorId) {
      outcomes.noteSkip(row.threadId, "not_owner");
      continue;
    }
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
  //
  // `enableSyncFor` is narrowed the same way and for the same reason: an
  // account whose destination folder is not synced but which contributed NO
  // candidate had nothing filed into it, and turning its sync on would be a
  // consequence with no cause -- bandwidth spent because a thread the user
  // ticked happened to carry a message on a mailbox the action then skipped.
  // The rule is "filing into a folder turns its sync on", and an account that
  // filed nothing did not file into it.
  const contributing = new Set(candidates.map((row) => row.accountId));
  return {
    candidates,
    refusedAccounts: refused.size,
    enableSyncFor: [...syncOff].filter((accountId) => contributing.has(accountId)),
  };
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
 *
 * `events` joined them in Phase 5 Task 4, for the same reason it joined
 * mail-threads.ts's publishThreadHint: the bulk "Hide in CRM" path routes
 * through here (hideThreads passes publishHint: false precisely so this one
 * publish covers the lot), and hiding a thread removes its entries from that
 * viewer's record timelines, which the 4.3 predicate filters at read time.
 * A bulk hide of 200 threads is the LARGEST timeline change this file can
 * make, so it is the last one that should be left publishing nothing.
 */
function publishMoveHints(threadIds: ReadonlySet<string>): void {
  publish({
    keys: [
      ["mail-threads"], ["mail-unread"],
      ...[...threadIds].map((id) => ["mail-thread", id]),
      ["events"],
    ],
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
