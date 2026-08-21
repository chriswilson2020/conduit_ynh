import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  mailAccountCreateInputSchema, mailAccountUpdateInputSchema, mailAccountUpdatePasswordFieldsSchema,
  mailAccountTestInputSchema, mailLinkKindSchema, threadLinksInputSchema, sendMailInputSchema,
  createEmailTemplateInputSchema, updateEmailTemplateInputSchema,
  bulkThreadActionInputSchema, folderPatchInputSchema, MOVE_ACTION_THREAD_CAP,
  type MailAccountSyncStats,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import {
  requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema, contentDisposition,
} from "./helpers.js";
import { openBlob } from "../services/blobs.js";
import { decodeLastMessageAtCursor } from "../services/pagination.js";
import type { SendMailSyncManager } from "../services/mail-send.js";
import { sendMail } from "../services/mail-send.js";
import { defaultTestConnectionDeps } from "../services/mail-imapflow.js";
import {
  createAccount, updateAccount, archiveAccount, unarchiveAccount, listAccounts, testConnection,
} from "../services/mail-accounts.js";
import {
  listThreads, getThreadDetail, markThreadRead, setThreadLink, clearThreadLink,
  hideThread, unhideThread, unreadThreadCount, unreadCountsByFolder,
  getAttachmentBlob, toMessage,
} from "../services/mail-threads.js";
import { listAccountFolders, setFolderSyncEnabled } from "../services/mail-folders.js";
import { moveThreads } from "../services/mail-move.js";
import {
  listTemplates, createTemplate, updateTemplate, archiveTemplate, unarchiveTemplate,
} from "../services/mail-templates.js";

/**
 * The slice of mail-sync.ts's SyncManager the ROUTES use, declared here for
 * the same reason mail-send.ts declares its own (`SendMailSyncManager`): a
 * structural contract lets a test hand in a fake without standing up a sync
 * engine, and keeps the route layer independent of the engine's module.
 *
 * It extends the send-path slice rather than duplicating it, so one value
 * satisfies both consumers and CrmRouteDeps can carry a single getter.
 */
export interface MailRouteSyncManager extends SendMailSyncManager {
  get(accountId: string): {
    appendSent(raw: Buffer | string): Promise<void>;
    /** Best-effort `\Seen` write-back; rejects immediately while the account
     * is in backoff (mail-sync.ts's SyncUnavailableError). */
    markSeen(folder: string, uids: readonly number[]): Promise<void>;
    /**
     * Queued IMAP MOVE (Phase 4.1). Widened onto this slice so one getter also
     * satisfies mail-move.ts's MoveSyncManager -- the bulk route hands this
     * value straight to that service rather than carrying a second manager.
     *
     * UNLIKE the two above, this one is not best-effort: the move service
     * treats a MISSING sync as a per-account refusal, because moving the
     * database rows with nothing to carry the MOVE out would leave the CRM
     * claiming a move that never happened (see accountStateOf).
     */
    moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void>;
    readonly stats: MailAccountSyncStats;
  } | undefined;
  /**
   * Ask for a pass now. RESOLVES WHEN THE PASS IS REQUESTED, not when it
   * finishes (mail-sync.ts's syncNow), so callers treat it as
   * fire-and-forget and let the SSE hints report what came of it.
   */
  syncNow(accountId: string): Promise<void>;
}

// unread/unlinked/hidden are the same tri-state wire flag companies.ts's
// listQuerySchema documents ("true"/"false"/absent, never z.coerce.boolean(),
// which would read the literal string "false" as true). snake_case here,
// camelCase in the shared threadListFiltersSchema the service consumes --
// the same division of labour as tasks.ts's listQuerySchema.
const threadListQuerySchema = z.object({
  account_id: z.uuid().optional(),
  unread: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  unlinked: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  // Phase 4.3: `hidden=true` is the Hidden view (the spec's spelling) --
  // the threads THIS VIEWER has hidden; absent/false is the default list,
  // which excludes them. See the shared threadListFiltersSchema.hidden for
  // the semantics. The flag renamed the pre-4.3 `archived` spelling; client
  // and server ship as one unit, so the old spelling has no external caller
  // to keep an alias for.
  hidden: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  // The folder view (Phase 4.1): threads with at least one message in this
  // folder. Trimmed and non-blank, mirroring the shared folderNameSchema every
  // other folder-carrying field parses through -- an IMAP mailbox name is
  // compared byte for byte downstream, so " Archive " and "Archive" must not
  // become two different views. A blank folder is invalid input, not "no
  // filter": the sidebar always sends a real name or omits the parameter.
  folder: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// GET /api/mail/threads/:id's only parameter (Phase 4.3): `all=true` asks
// for the uncapped conversation once the detail cap lands -- the spec's own
// spelling, in the same tri-state wire form as the list flags above.
//
// Task 1 placeholder: parsed -- so the wire contract, including its 400 on
// a malformed value, is fixed from the start -- and then deliberately
// unused. No cap exists yet, so every response already IS the uncapped
// view and `all` changes nothing. Task 3 threads it into getThreadDetail
// alongside the cap itself.
const threadDetailQuerySchema = z.object({
  all: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

// GET /api/mail/unread-count's only parameter. `byFolder=1` and nothing else:
// a flag with one spelling cannot be got subtly wrong the way the tri-state
// "true"/"false" strings above can, and anything else 400s rather than being
// read as "no, plain count please" -- a client asking for a shape this route
// does not have should hear about it.
const unreadCountQuerySchema = z.object({
  byFolder: z.literal("1").optional(),
});

const templateListQuerySchema = z.object({
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

// A PATCH may carry settings, password fields, or both. The two shared
// schemas are merged rather than a third one written: password/smtpPassword
// have their own update-side rules (blank means "keep the stored one", so
// unlike create they are NOT .min(1)) that mailAccountUpdateInputSchema
// deliberately does not carry.
const accountPatchSchema = mailAccountUpdateInputSchema.extend(mailAccountUpdatePasswordFieldsSchema.shape);

const linkKindParamSchema = z.object({ id: z.uuid(), kind: mailLinkKindSchema });

/**
 * Mimes this server is willing to hand a browser for INLINE rendering.
 *
 * The inline route exists for one job -- resolving a message body's rewritten
 * `cid:` images -- and anything outside that job is served as a download
 * instead. Without this, a hostile inbound message could attach text/html and
 * then link to its own attachment (an ordinary https link to this app, which
 * the sanitizer allows), and a click would render attacker-authored HTML on
 * the app's own origin, with the user's SSO session attached.
 * `X-Content-Type-Options: nosniff` alone does not close that: it stops a
 * browser GUESSING text/html, not a response that DECLARES it.
 *
 * image/svg+xml is deliberately absent for the same reason -- an SVG is a
 * scriptable document, not a picture, when a browser renders it as a
 * top-level navigation.
 */
const INLINE_RENDERABLE_MIME = /^image\/(png|jpeg|jpg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/i;

export function registerMailRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  // syncManager is the GETTER, captured here and called inside each handler:
  // the manager itself does not exist until after the server is listening
  // (see CrmRouteDeps), so nothing may read it at registration time.
  const { db, dataDir, mailKeyPath, basePath, transportFactory, syncManager } = deps;

  // --- Accounts ------------------------------------------------------------

  /**
   * FRESHNESS CONTRACT for `syncStats` (coordinator ruling): the numbers in
   * this response are live AS OF THIS FETCH and nothing keeps them current
   * afterwards. They are in-process counters on the sync loop, not rows, so
   * no write publishes an SSE hint when they move -- `[["mail-accounts"]]`
   * fires on account MUTATIONS and status flips, which is a different and
   * much rarer event.
   *
   * Settings (Task 9) owns freshness for its own view and polls with a
   * refetchInterval. Every other consumer must treat this list as an
   * SSE-invalidated cache of the ACCOUNT ROWS and must not build anything
   * that depends on stats being current -- if a live counter is ever needed
   * somewhere else, it needs its own endpoint or its own hint, not a shorter
   * assumption about this one.
   */
  app.get("/api/mail/accounts", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const accounts = await listAccounts(db, user.id);
    const manager = syncManager();
    return {
      // Own accounts only: another user's sync health is as much a private
      // setting as their host and port (see mailAccountListSchema).
      own: accounts.own.map((account) => ({
        ...account,
        // null, not omitted, whenever there is no live sync for the account:
        // archived, not yet started, or a deployment running without a sync
        // engine at all (NODE_ENV=test included). The settings page needs to
        // tell "no engine" apart from "engine, zero passes".
        syncStats: manager?.get(account.id)?.stats ?? null,
      })),
      others: accounts.others,
    };
  });

  app.post("/api/mail/accounts", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(mailAccountCreateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const account = await createAccount(db, user.id, input, mailKeyPath);
      return reply.code(201).send(account);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.patch("/api/mail/accounts/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(accountPatchSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateAccount(db, user.id, params.id, patch, mailKeyPath);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/mail/accounts/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveAccount(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Archive-not-delete, and therefore unarchive: re-adding an archived
  // mailbox as a NEW row would re-ingest and duplicate every thread it
  // touches (see mail-accounts.ts's unarchiveAccount).
  app.post("/api/mail/accounts/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveAccount(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Folders -------------------------------------------------------------

  /**
   * The account's discovered folders, for the Settings picker and the inbox
   * sidebar (Phase 4.1).
   *
   * Owner-only, exactly like the account routes above and unlike every THREAD
   * route -- these rows are part of an account's SETTINGS (what it syncs, what
   * its server's mailbox topology looks like), and settings belong to their
   * owner. Since Phase 4.2 the visibility model agrees with this scoping from
   * the other side too: a PRIVATE account's folder names no longer surface to
   * other users anywhere (message rows, folder filters and the per-folder
   * counts are all predicate-scoped), while a shared account's folder names
   * ride its visible messages -- but its SETTINGS surface here stays
   * owner-only either way. A foreign id 404s the same way a nonexistent one
   * does (mail-folders.ts's mustGetOwnedAccount), so the two cannot be told
   * apart.
   *
   * `locked` on each row is computed by the service from the account's CURRENT
   * sent_folder and is not a column -- see isLocked for why storing it would
   * go stale the moment someone repoints sent_folder.
   */
  app.get("/api/mail/accounts/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await listAccountFolders(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * Toggle one folder's sync_enabled.
   *
   * The two refusals both arrive as ConflictError and leave as 409s: a LOCKED
   * folder (INBOX and the account's Sent folder, always walked regardless of
   * the flag) and an UNSELECTABLE one (`\Noselect`, which holds no messages to
   * sync). An unknown folder name is a 404. See setFolderSyncEnabled for why
   * each is refused in both directions rather than accepted as a no-op.
   *
   * ENABLING ASKS FOR A PASS, and does not wait for one: syncNow resolves when
   * the pass is REQUESTED, the loop may be mid-backfill, and the client learns
   * the outcome from the SSE hints the pass publishes. A rejection is logged
   * and swallowed for the same reason the `\Seen` write-back's is -- the
   * database write is this route's contract, and a sync engine having a bad
   * day must not turn a saved preference into a 500.
   *
   * Switching a folder OFF asks for nothing: there is no work to do, and the
   * next ordinary pass simply stops walking it.
   */
  app.patch("/api/mail/accounts/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(folderPatchInputSchema, request.body, reply);
    if (input === undefined) return;
    let result;
    try {
      result = await setFolderSyncEnabled(db, user.id, params.id, input);
    } catch (error) {
      mapDomainError(reply, error);
      return;
    }
    if (result.enabled) {
      const manager = syncManager();
      const onFailure = (error: unknown): void => {
        request.log.warn(
          { err: error, accountId: params.id, folder: input.folder },
          "mail: could not request a sync pass after enabling a folder",
        );
      };
      try {
        void manager?.syncNow(params.id).catch(onFailure);
      } catch (error) {
        // Belt and braces, as on the read route: syncNow is documented to
        // reject rather than throw, and a fake that throws must not take the
        // request with it.
        onFailure(error);
      }
    }
    return result.folder;
  });

  // POST, not GET, despite reading nothing: the body carries credentials for
  // an account that may not exist yet, and credentials do not belong in a
  // query string (or in an access log).
  app.post("/api/mail/accounts/test", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(mailAccountTestInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await testConnection(db, user.id, input, mailKeyPath, defaultTestConnectionDeps);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Threads -------------------------------------------------------------

  // Every thread route passes the authenticated user's id into the service:
  // Phase 4.2's visibility predicate scopes what each viewer's queries return
  // (services/mail-threads.ts's predicate header), so the actor is a real
  // parameter of every mail read now, not just audit context.
  app.get("/api/mail/threads", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const query = parseOrReject(threadListQuerySchema, request.query, reply);
    if (query === undefined) return;
    // The mail list pages by (last_message_at, id), so a created_at cursor
    // minted by any other list must be rejected here rather than silently
    // paging from a timestamp that means something else.
    if (!validateCursor(query.cursor, reply, decodeLastMessageAtCursor)) return;
    return listThreads(db, user.id, {
      accountId: query.account_id, unread: query.unread, unlinked: query.unlinked,
      companyId: query.company_id, contactId: query.contact_id,
      dealId: query.deal_id, projectId: query.project_id,
      hidden: query.hidden, folder: query.folder,
      cursor: query.cursor, limit: query.limit,
    });
  });

  app.get("/api/mail/threads/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    // Accepted and (for now) ignored -- see threadDetailQuerySchema's own
    // placeholder note.
    const query = parseOrReject(threadDetailQuerySchema, request.query, reply);
    if (query === undefined) return;
    try {
      // basePath, not a hardcoded prefix: stored body_html carries
      // `mailattachment:` placeholders and is resolved to real routes here,
      // at serve time, so a `yunohost app change_url` needs no migration.
      return await getThreadDetail(db, user.id, params.id, basePath);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * Mark read. The DATABASE write is the contract; the `\Seen` write-back to
   * the mail server is best effort and deliberately not awaited:
   *
   * - an account in backoff rejects queued work immediately
   *   (SyncUnavailableError), and a thread spanning two accounts must not
   *   fail because one of them is having a bad day;
   * - the sync engine may not exist at all (no adapter configured, or tests);
   * - the next flag-reconcile pass re-reads the server's flags anyway, so a
   *   lost write-back self-heals rather than drifting.
   *
   * Every rejection is caught and logged, never propagated: this route's
   * answer is about the CRM's own state.
   */
  app.post("/api/mail/threads/:id/read", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    let result;
    try {
      result = await markThreadRead(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
      return;
    }
    const manager = syncManager();
    for (const group of result.writeBacks) {
      const sync = manager?.get(group.accountId);
      if (sync === undefined) continue;
      const onFailure = (error: unknown): void => {
        request.log.warn(
          { err: error, accountId: group.accountId, folder: group.folder, uids: group.uids.length },
          "mail: Seen write-back failed",
        );
      };
      try {
        void sync.markSeen(group.folder, group.uids).catch(onFailure);
      } catch (error) {
        // Belt and braces: markSeen is documented to REJECT rather than throw
        // while unavailable, but a fake (or a future change) that throws must
        // not take the request with it.
        onFailure(error);
      }
    }
    return result.thread;
  });

  app.post("/api/mail/threads/:id/links", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(threadLinksInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await setThreadLink(db, user.id, params.id, input.kind, input.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.delete("/api/mail/threads/:id/links/:kind", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(linkKindParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await clearThreadLink(db, user.id, params.id, params.kind);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Hide in CRM, for THIS USER alone (Phase 4.3): writes the actor's own
  // mail_thread_hides row -- nothing moves or is expunged on the IMAP
  // server, and no other user's view changes. The /archive path spelling is
  // the pre-4.3 wire address, kept because a path is an address, not a
  // label (the UI has said "Hide in CRM" since 4.1; the service is
  // hideThread).
  app.post("/api/mail/threads/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await hideThread(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/mail/threads/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unhideThread(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * The nav badge's count, or -- with `?byFolder=1` -- the sidebar's per-folder
   * counts in ONE grouped query (Phase 4.1).
   *
   * The two answers differ in more than shape, and mail-threads.ts documents
   * why at each query: the plain count EXCLUDES messages in their account's
   * Trash (nothing ever re-sights an unsynced Trash to clear the flag, so they
   * would inflate the badge forever), while the per-folder counts do not --
   * each count belongs to its own folder row, and a Trash row reading 0 above a
   * list of visibly unread mail is a lie.
   */
  app.get("/api/mail/unread-count", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const query = parseOrReject(unreadCountQuerySchema, request.query, reply);
    if (query === undefined) return;
    if (query.byFolder === "1") return { folders: await unreadCountsByFolder(db, user.id) };
    return { count: await unreadThreadCount(db, user.id) };
  });

  /**
   * The bulk thread actions: Trash and Archive MOVE messages on the IMAP
   * server, "Hide in CRM" sets the pre-4.1 CRM-side thread archive
   * (services/mail-move.ts owns all three).
   *
   * AUTH-ONLY at the route, BY DESIGN -- the real gates live in the service,
   * in a fixed order. Thread ids of other users' private threads ARE
   * nameable here: sse.ts fans every hint to every subscriber, and
   * publishThreadHint / ingest's hints carry ["mail-thread", <id>] frames,
   * so every logged-in client continuously receives ids it may not open.
   * That id-broadcast is acceptable-by-design because naming an id earns
   * nothing: mail-move decides record-scope VISIBILITY first, batched into
   * its requested-threads read, so an invisible id fails with the SAME
   * not_found as a nonexistent one, byte-indistinguishable, before any of
   * the thread's accounts or folders is examined (the by-id routes answer
   * through mustGetThread's indistinguishable 404, and the hide action
   * resolves through that same gate per thread). The not_owner OWNERSHIP
   * filter then applies among visible threads only: Archive/Trash act on
   * messages of accounts the ACTOR owns (spec, Move rights), and anyone
   * else's messages skip rather than move. The IMAP write happens through
   * each message's own account's sync loop under that account's credentials;
   * the user id handed to the service is the subject of both gates as well
   * as the audit context for its log line.
   *
   * ALWAYS 200 WHEN THE REQUEST ITSELF WAS VALID. Per-thread failures ride
   * INSIDE the body (`{threadId, ok, skipped?, error?}` per requested id, in
   * request order) rather than becoming a status code, because a bulk action
   * routinely half-succeeds -- one account in backoff, another fine -- and a
   * 4xx/5xx would throw away the answer for every thread that worked.
   *
   * A 504 FROM A PROXY DOES NOT MEAN THE ACTION FAILED. Each queued MOVE runs
   * on its account's serial sync loop, so this request waits for the mail
   * server, and an account halfway through a first backfill can make that wait
   * minutes (see moveThreads' own note). The deployed ceiling is concrete:
   * conf/nginx.conf sets `proxy_read_timeout 300`, so five minutes is where
   * this app's own reverse proxy gives up on the response -- while the loop
   * carries on regardless, because nothing about a client disconnecting
   * cancels queued work. If the answer is lost that way the work still lands,
   * the SSE hints still fire, and the client should REFETCH rather than retry
   * blindly -- a blind retry would trash or archive a second time, which for
   * `trash` means moving whatever is now in the source folder. The cap below
   * is the bound on how much work one request can queue behind that ceiling.
   */
  app.post("/api/mail/threads/bulk", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(bulkThreadActionInputSchema, request.body, reply);
    if (input === undefined) return;
    // The shared schema's 200 is the outer bound and only `hide` may reach it:
    // hiding is a CRM-side column write per thread, while trash/archive each
    // wait on a real mail server. Capping the two MOVE actions lower is the
    // ruling's answer to that wait -- bound the SIZE of the request rather than
    // its duration, since a timeout would produce exactly the "claimed a move
    // the server refused" state the move service's compensation exists to
    // prevent. 50 is two of this list's default pages (the thread list asks for
    // 25 at a time, and accumulates), so the longest a single request can hold a
    // connection open is 50 threads' worth of queued MOVEs behind whatever that
    // account's serial loop is already doing -- and a user who has pressed "load
    // more" once can still select everything on screen and act on it in one
    // gesture. Enforced HERE rather than in the schema because it is a
    // property of the ACTION, not of the body shape; the NUMBER lives in
    // @conduit/shared beside that schema, because the web client mirrors it (its
    // select-all cap) and a client-side copy that drifted would build requests
    // this line answers with a 400.
    if (input.action !== "hide" && input.threadIds.length > MOVE_ACTION_THREAD_CAP) {
      return reply.code(400).send({
        error: "validation",
        message: `${input.action} accepts at most ${MOVE_ACTION_THREAD_CAP} threads per request`
          + ` (received ${input.threadIds.length})`,
      });
    }
    try {
      return await moveThreads(db, user.id, input, {
        // Resolved per request, never captured: the manager does not exist
        // when routes are registered (see CrmRouteDeps.syncManager). null is
        // an ordinary answer here and the service knows what to do with it --
        // every account refuses, and each refusal is reported per thread.
        syncManager: syncManager(),
        logger: request.log,
      });
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Send ----------------------------------------------------------------

  // 201: a successful send has created a message row (and possibly a thread).
  // Owner-only, archived-account and account-in-error checks all live in
  // mail-send.ts; an SMTP refusal arrives here as SmtpSendError and leaves as
  // the 502 `smtp_failed` body mapDomainError already knows how to write.
  app.post("/api/mail/send", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(sendMailInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const message = await sendMail(db, dataDir, user.id, input, {
        mailKeyPath, transportFactory, syncManager: syncManager(),
      });
      // Placeholders resolved on the way out, like every other body-serving
      // path -- the stored form never leaves the API.
      return reply.code(201).send(toMessage(message, basePath));
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Attachments ---------------------------------------------------------

  async function serveAttachment(
    reply: FastifyReply, userId: string, id: string, mode: "download" | "inline",
  ): Promise<unknown> {
    // userId feeds the visibility check inside getAttachmentBlob: attachment
    // bytes are as scoped as the thread detail that lists them.
    const attachment = await getAttachmentBlob(db, userId, id, { inlineOnly: mode === "inline" });
    // Always, on both routes: whatever Content-Type is declared below, a
    // browser must never be allowed to sniff its way to a different one.
    reply.header("X-Content-Type-Options", "nosniff");
    // The stored byte count, so the client gets a progress bar and a
    // definite end rather than a chunked stream of unknown length. Taken
    // from the row ingest wrote, which is the length of the blob it wrote
    // in the same transaction.
    reply.header("Content-Length", attachment.sizeBytes);
    if (mode === "inline" && INLINE_RENDERABLE_MIME.test(attachment.mime)) {
      reply.header("Content-Type", attachment.mime);
      reply.header("Content-Disposition", contentDisposition("inline", attachment.filename));
    } else {
      // The download route, and the inline route's non-image fallback: the
      // bytes are still served, but as a save rather than something the
      // browser renders in place. octet-stream on the fallback because the
      // stored mime is exactly what made it unsafe to declare.
      reply.header("Content-Type", mode === "inline" ? "application/octet-stream" : attachment.mime);
      reply.header("Content-Disposition", contentDisposition("attachment", attachment.filename));
    }
    return reply.send(openBlob(dataDir, attachment.blobPath));
  }

  app.get("/api/mail/attachments/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await serveAttachment(reply, user.id, params.id, "download");
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // What a message body's rewritten cid: images point at (see
  // mail-content.ts's resolveAttachmentUrls). An ordinary authenticated
  // same-origin route: the conversation iframe's sandbox grants
  // allow-same-origin (and the two popup flags, but never allow-scripts --
  // see the web package's MESSAGE_FRAME_SANDBOX), so subresource loads carry
  // the session cookie and reach this route through the SSOwat proxy the way
  // any other request does.
  app.get("/api/mail/attachments/:id/inline", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await serveAttachment(reply, user.id, params.id, "inline");
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Templates -----------------------------------------------------------

  // Shared, not owner-scoped: email_templates has no owner column (see
  // services/mail-templates.ts). Auth is still required -- every route here
  // sits behind the same onRequest hook -- it is just not per-row.
  app.get("/api/mail/templates", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(templateListQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listTemplates(db, { archived: query.archived });
  });

  app.post("/api/mail/templates", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const input = parseOrReject(createEmailTemplateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const template = await createTemplate(db, input);
      return reply.code(201).send(template);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.patch("/api/mail/templates/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateEmailTemplateInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateTemplate(db, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/mail/templates/:id/archive", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveTemplate(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/mail/templates/:id/unarchive", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveTemplate(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
