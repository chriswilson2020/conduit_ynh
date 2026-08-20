import { eq, inArray } from "drizzle-orm";
import type { BulkThreadActionInput, BulkThreadResult } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
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
 * best-effort step" case -- see resolveAccount.
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

type ResultItem = BulkThreadResult["results"][number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Do two stored folder names mean the same mailbox?
 *
 * INBOX is the one name IMAP defines as case-insensitive (RFC 3501); every
 * other name is compared byte for byte, because "Archive" and "archive" really
 * are two mailboxes on a real server. Same rule as mail-sync.ts's foldersOf,
 * and it has to be: a message whose folder does not match the view it was
 * selected in is one this service silently leaves behind.
 */
function sameFolder(a: string, b: string): boolean {
  if (a === b) return true;
  return a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX";
}

/** One message this action may move. `folder`/`imapUid` are the values BEFORE
 * the optimistic update -- the compensating revert restores exactly these. */
interface Candidate {
  id: string;
  threadId: string;
  accountId: string;
  folder: string;
  imapUid: number;
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

  fail(threadId: string, error: string): void {
    const existing = this.byThread.get(threadId);
    if (existing !== undefined && existing.ok === false) return;
    this.byThread.set(threadId, { threadId, ok: false, error });
  }

  /** A successful no-op: nothing was eligible to move (spec's `skipped`). */
  skip(threadId: string): void {
    if (this.byThread.has(threadId)) return;
    this.byThread.set(threadId, { threadId, ok: true, skipped: true });
  }

  succeed(threadId: string): void {
    if (this.byThread.has(threadId)) return;
    this.byThread.set(threadId, { threadId, ok: true });
  }

  has(threadId: string): boolean {
    return this.byThread.has(threadId);
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
      // response that silently drops a row the client asked about.
      ?? { threadId, ok: false, error: "no result was produced for this thread" });
  }
}

// --- Move targets ----------------------------------------------------------

/** Everything one account contributes to a move: where its messages are going,
 * which of its folders is Sent (the whole-thread carve-out), and the sync loop
 * that will do the actual MOVE. */
interface AccountContext {
  targetFolder: string;
  sync: MoveSyncAccount;
}

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
  | { kind: "ready"; scope: AccountScope; context: AccountContext }
  | { kind: "refused"; scope: AccountScope; error: string }
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
 * tears its loop down and will never build another (mail-sync.ts's
 * applyAccountChange), so "no loop" is permanent rather than a state a user
 * can fix -- while its message rows survive, because archiving an account
 * keeps its mail (archive-not-delete). Reported as a failure, those rows would
 * make every thread carrying one PERMANENTLY un-archivable from any view: the
 * bulk action would fail forever, for a reason nothing can act on. So they are
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
    };
  }
  const sync = syncManager?.get(account.id);
  if (sync === undefined) {
    return { kind: "refused", scope, error: `mail sync is not running for account "${account.label}"` };
  }
  return { kind: "ready", scope, context: { targetFolder, sync } };
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
 * - OWNED BY AN ARCHIVED ACCOUNT: permanently unmovable, and deliberately not
 *   a failure -- see accountStateOf.
 *
 * THE RETURNED PROMISE WAITS FOR THE SERVER. Each queued MOVE runs on its
 * account's serial sync loop, so a bulk action against an account halfway
 * through a first backfill waits for that backfill. That is deliberate and not
 * a bound worth adding here: the per-thread failure this function reports is
 * only trustworthy because it waited to see whether the server accepted, and a
 * timeout would produce exactly the "claimed a move the server refused" state
 * the compensation exists to prevent. A route that wants a bound must decide
 * what to tell the user in its place.
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

  if (input.action === "hide") {
    await hideThreads(db, unique, outcomes);
    logger.info(
      { actorId, action: input.action, threads: unique.length },
      "mail-move: bulk action",
    );
    return { results: outcomes.list(requested) };
  }

  // `action` is narrowed to the two MOVE kinds by the early return above, and
  // is passed on explicitly so nothing downstream has to re-establish it.
  const { candidates, contexts } = await collectCandidates(
    db, { folder: input.folder, action: input.action }, unique, deps.syncManager, outcomes,
  );
  let failed = 0;
  if (candidates.length > 0) {
    await applyOptimisticMove(db, candidates, contexts);
    const failures = await queueMoves(db, candidates, contexts, logger);
    for (const [threadId, error] of failures) outcomes.fail(threadId, error);
    for (const row of candidates) outcomes.succeed(row.threadId);
    failed = failures.size;
  }
  // Whatever is still unclassified had nothing eligible to move -- every
  // message either awaited reconciliation, sat outside the view folder, or
  // was already in the target. A successful no-op, not a failure.
  for (const threadId of unique) if (!outcomes.has(threadId)) outcomes.skip(threadId);

  logger.info(
    {
      actorId, action: input.action, folder: input.folder ?? null,
      threads: unique.length, messages: candidates.length, failed,
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
 * bulk contract promises.
 */
async function hideThreads(db: Database, threadIds: readonly string[], outcomes: Outcomes): Promise<void> {
  for (const threadId of threadIds) {
    try {
      await archiveThread(db, threadId);
      outcomes.succeed(threadId);
    } catch (error) {
      outcomes.fail(threadId, errorText(error));
    }
  }
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
): Promise<{ candidates: Candidate[]; contexts: Map<string, AccountContext> }> {
  const { folder: viewFolder, action } = request;
  const contexts = new Map<string, AccountContext>();
  const known = new Set((await db.select({ id: mailThreads.id }).from(mailThreads)
    .where(inArray(mailThreads.id, [...threadIds]))).map((row) => row.id));
  for (const threadId of threadIds) {
    if (!known.has(threadId)) outcomes.fail(threadId, new NotFoundError("mail thread", threadId).message);
  }
  if (known.size === 0) return { candidates: [], contexts };

  const messages = await db.select({
    id: mailMessages.id, threadId: mailMessages.threadId, accountId: mailMessages.accountId,
    folder: mailMessages.folder, imapUid: mailMessages.imapUid,
  }).from(mailMessages).where(inArray(mailMessages.threadId, [...known]));
  if (messages.length === 0) return { candidates: [], contexts };

  const accountIds = [...new Set(messages.map((row) => row.accountId))];
  const accountRows = await db.select({
    id: mailAccounts.id, label: mailAccounts.label, archivedAt: mailAccounts.archivedAt,
    sentFolder: mailAccounts.sentFolder,
    trashFolder: mailAccounts.trashFolder, archiveFolder: mailAccounts.archiveFolder,
  }).from(mailAccounts).where(inArray(mailAccounts.id, accountIds));

  const states = new Map<string, AccountState>();
  for (const account of accountRows) {
    const state = accountStateOf(account, action, syncManager);
    states.set(account.id, state);
    if (state.kind === "ready") contexts.set(account.id, state.context);
  }

  const candidates: Candidate[] = [];
  for (const row of messages) {
    const state = states.get(row.accountId);
    if (state === undefined) continue;
    // An archived account's rows are permanently unmovable, so they are
    // dropped here beside the NULL uids rather than failing anything -- see
    // accountStateOf for why reporting them would make a thread carrying one
    // un-archivable forever.
    if (state.kind === "unmovable") continue;
    // No UID, no way to name the message to the server. Rare and
    // self-healing: the next pass over its folder fills the UID in.
    if (row.imapUid === null) continue;

    // EVERY ELIGIBILITY FILTER RUNS BEFORE THE REFUSAL BELOW, and the order is
    // the correctness property, not tidiness. A refusal is a statement about
    // messages this action would actually have moved: an account that cannot
    // move must not fail a thread whose messages of its own were never in
    // scope in the first place (outside the view folder, awaiting
    // reconciliation, or carved out of the whole-thread set). Judging the
    // account before its rows made every such thread fail for a mailbox the
    // user was not acting on.
    //
    // Already there. In whole-thread mode this is the spec's explicit
    // exclusion; in folder-scoped mode it can only fire when the user acts
    // from the target folder's OWN view (archiving from the Archive view),
    // where "nothing to do" is just as true -- and where moving a message into
    // the mailbox it is already in would churn its UID for nothing. A refused
    // account may have no target at all, in which case there is no folder for
    // a message to be "already in".
    const { sentFolder, targetFolder } = state.scope;
    if (targetFolder !== null && sameFolder(row.folder, targetFolder)) continue;
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

    if (state.kind === "refused") {
      // In scope, and this account cannot move it: THIS is what fails the
      // thread. Every other account in the same request carries on (spec).
      outcomes.fail(row.threadId, state.error);
      continue;
    }
    candidates.push({
      id: row.id, threadId: row.threadId, accountId: row.accountId,
      folder: row.folder, imapUid: row.imapUid,
    });
  }
  // Ascending UID within a folder, so the partition into chunks is
  // deterministic (a test can state which uids one queued call carries) and
  // each chunk is a compact UID range for the server.
  candidates.sort((a, b) => a.imapUid - b.imapUid);
  return { candidates, contexts };
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
async function applyOptimisticMove(
  db: Database, candidates: readonly Candidate[], contexts: ReadonlyMap<string, AccountContext>,
): Promise<void> {
  const now = new Date();
  const byTarget = new Map<string, string[]>();
  const threadIds = new Set<string>();
  for (const row of candidates) {
    const context = contexts.get(row.accountId);
    // Unreachable: a candidate exists only for an account that resolved.
    if (context === undefined) continue;
    threadIds.add(row.threadId);
    const ids = byTarget.get(context.targetFolder);
    if (ids === undefined) byTarget.set(context.targetFolder, [row.id]);
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

/** Every key a moved message invalidates: the thread list (folder membership
 * changed), each thread's own detail, and the unread count (a message moved
 * into an unsynced Trash leaves the counted set). One publish carrying every
 * key, not one per thread -- the subscriber fan-out is per call. */
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
 * AccountSync chunks internally at the same size, so a rejected call here
 * moved all or none of its UIDs -- but a future caller passing a larger group
 * could have part of it land while this reverts the lot. Either way the target
 * folder's next pass re-sights whatever the server actually holds and rewrites
 * `folder`/`imap_uid` from that, so the divergence lasts at most one poll
 * interval.
 *
 * Sequential rather than concurrent, across accounts as well as within one:
 * each account's loop is serial anyway, so parallelism would buy only the
 * overlap between different accounts' queues, at the cost of interleaved
 * compensations in the one path where clarity is worth most.
 */
async function queueMoves(
  db: Database, candidates: readonly Candidate[],
  contexts: ReadonlyMap<string, AccountContext>, logger: SyncLogger,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  for (const group of groupForQueue(candidates, contexts)) {
    for (const chunk of chunked(group.rows, UID_CHUNK)) {
      try {
        await group.sync.moveMessages(group.folder, chunk.map((row) => row.imapUid), group.targetFolder);
      } catch (error) {
        const message = errorText(error);
        logger.warn(
          {
            accountId: group.accountId, folder: group.folder, targetFolder: group.targetFolder,
            messages: chunk.length, err: message,
          },
          "mail-move: the server refused a move, reverting those rows",
        );
        await revertMove(db, chunk, logger);
        for (const row of chunk) failures.set(row.threadId, message);
      }
    }
  }
  return failures;
}

/**
 * Put one chunk's rows back exactly as they were: their own folder, their own
 * UID. One statement per row, because each row restores a DIFFERENT pair -- and
 * this is the failure path, bounded by one chunk, so the statement count is
 * the honest cost of getting the values right rather than a hot loop.
 *
 * A failure to compensate is logged and swallowed: the caller is already
 * reporting this chunk's threads as failed, and throwing here would abandon
 * the remaining groups (whose moves may be perfectly fine) on top of it. The
 * rows are left optimistic, and the next pass over the source folder re-sights
 * the messages -- they never left it -- and restores their UIDs.
 */
async function revertMove(db: Database, chunk: readonly Candidate[], logger: SyncLogger): Promise<void> {
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      for (const row of chunk) {
        await tx.update(mailMessages)
          .set({ folder: row.folder, imapUid: row.imapUid, updatedAt: now })
          .where(eq(mailMessages.id, row.id));
      }
    });
  } catch (error) {
    logger.error(
      { messages: chunk.length, err: errorText(error) },
      "mail-move: could not revert an optimistic move",
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
 * The contexts come from the collection step rather than being re-resolved
 * here. Re-reading the accounts would open a window in which a Settings edit
 * changed the target between the optimistic UPDATE and the MOVE, sending the
 * messages somewhere the database does not say they went.
 */
function groupForQueue(
  candidates: readonly Candidate[], contexts: ReadonlyMap<string, AccountContext>,
): MoveGroup[] {
  const groups = new Map<string, MoveGroup>();
  for (const row of candidates) {
    const context = contexts.get(row.accountId);
    if (context === undefined) continue;
    // NUL as the composite-key separator, written as the escape `\0` rather
    // than a literal NUL byte so grep does not classify this file as binary --
    // same convention (and the same reason) as mail-threads.ts's write-back
    // grouping. A folder name is arbitrary user data that could contain any
    // printable separator but never a NUL.
    const key = `${row.accountId}\0${row.folder}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        accountId: row.accountId, sync: context.sync, folder: row.folder,
        targetFolder: context.targetFolder, rows: [row],
      });
    } else group.rows.push(row);
  }
  return [...groups.values()];
}
