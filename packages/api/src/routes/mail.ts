import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  mailAccountCreateInputSchema, mailAccountUpdateInputSchema, mailAccountUpdatePasswordFieldsSchema,
  mailAccountTestInputSchema, mailOAuthSigninInputSchema,
  mailLinkKindSchema, threadLinksInputSchema, sendMailInputSchema,
  bulkThreadActionInputSchema, bulkMessageActionInputSchema, folderPatchInputSchema,
  folderCreateInputSchema, folderRenameInputSchema, folderDeleteInputSchema,
  BULK_ACTION_THREAD_CAPS, MAIL_OAUTH_CALLBACK_PATH,
  type MailAccountSyncStats,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import {
  requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema, contentDisposition,
} from "./helpers.js";
import { openBlob } from "../services/blobs.js";
import { decodeLastMessageAtCursor } from "../services/pagination.js";
import type { SendMailSyncManager } from "../services/mail-send.js";
import type { ImapFolderListing, SyncStopOptions, SyncStopResult } from "../services/mail-sync.js";
import { sendMail } from "../services/mail-send.js";
import { defaultTestConnectionDeps } from "../services/mail-imapflow.js";
import {
  createAccount, updateAccount, archiveAccount, unarchiveAccount, listAccounts, testConnection,
  getOwnAccount,
} from "../services/mail-accounts.js";
import {
  completeSignin, configuredProviders, startSignin, MailOAuthNotConfiguredError,
  type SigninDeps,
} from "../services/mail-oauth-signin.js";
import {
  listThreads, getThreadDetail, markThreadRead, setThreadLink, clearThreadLink,
  hideThread, unhideThread, unreadThreadCount, unreadCountsByFolder,
  getAttachmentBlob, toMessage,
} from "../services/mail-threads.js";
import {
  createFolder, deleteFolder, listAccountFolders, renameFolder, setFolderSyncEnabled,
} from "../services/mail-folders.js";
import { moveMessages, moveThreads } from "../services/mail-move.js";

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
    /**
     * The four folder commands (Phase 4.4 Task 4), widened onto this slice for
     * exactly the reason `moveMessages` was: one getter then also satisfies
     * mail-folders.ts's FolderSyncManager, so the three folder routes hand this
     * value straight to that service rather than the router carrying a third
     * manager beside the other two.
     *
     * Not best-effort either, and for a sharper version of the move service's
     * reason: a missing sync means Conduit cannot reach the mail server at all,
     * and the local half of a folder command is a change to records describing
     * a mailbox nobody changed (see folderSyncOf).
     */
    listFolders(): Promise<ImapFolderListing[]>;
    createMailbox(folder: string): Promise<void>;
    renameMailbox(folder: string, newFolder: string): Promise<void>;
    deleteMailboxIfEmpty(folder: string): Promise<number>;
    readonly stats: MailAccountSyncStats;
  } | undefined;
  /**
   * Stop every account's sync, and start them again. WIDENED FOR THE RESTORE
   * (Phase 7.7), which is the only caller: the sync is the second writer -- the
   * one that can change the database with nobody touching a browser -- and a
   * restore is only true if nothing else is writing.
   *
   * `stop` RETURNS AN ANSWER RATHER THAN A RESOLUTION (v1.4.1's Task 2), and
   * this slice is where a route sees it. It used to be `Promise<void>`, which
   * resolves identically whether every sync stopped or every sync was
   * abandoned past mail-sync.ts's deadline -- and routes/restore.ts, holding
   * exactly that promise, restored over whatever was still writing. The
   * decision now sits in that handler, next to the write gate's, because it is
   * the same decision about the same restore.
   *
   * Both are on mail-sync.ts's SyncManager already and both are idempotent
   * there; they are declared here so this slice is the one contract the route
   * layer needs, rather than a second getter beside it.
   */
  stop(options?: SyncStopOptions): Promise<SyncStopResult>;
  start(): Promise<void>;
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
// for the uncapped conversation -- the spec's own spelling, in the same
// tri-state wire form as the list flags above (and with the same uniform
// 400 on a malformed value). Absent/false is the capped view, the newest
// 50 visible messages (mail-threads.ts's THREAD_DETAIL_MESSAGE_CAP); the
// "Show earlier messages" control is what sends true.
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

/**
 * The OAuth callback's query string (RFC 6749 4.1.2 and 4.1.2.1).
 *
 * EVERY FIELD IS OPTIONAL AND NOTHING IS BOUNDED BY FORMAT, deliberately. This
 * is the one route on the app whose caller is a third party's redirect rather
 * than this app's own client, so a schema that REJECTED a shape would only
 * change which refusal the operator sees -- completeSignin refuses an
 * unredeemable state and a missing code just as firmly, and does it after the
 * state check rather than before it. The parse is here to narrow `unknown` into
 * strings, not to gate.
 *
 * `error_description` IS NOT IN IT, and its absence is the point: the provider
 * sends one, this server has no use for it that is worth the risk of carrying
 * it, and a field nobody reads is a field that ends up in a log the day
 * somebody adds a debug line. What is diagnosed from is `error`, the code.
 */
const oauthCallbackQuerySchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

/** Where the callback sends the browser afterwards. Built from config.basePath
 * and a literal path -- never from anything on the request -- so an install at
 * `/conduit` lands on its own settings page and nothing a provider echoes can
 * choose the destination. */
function settingsMailPath(basePath: string): string {
  return basePath === "/" ? "/settings/mail" : `${basePath}/settings/mail`;
}

/** The callback's public path on this install. Same construction as
 * settingsMailPath and for the same reason: an install mounted at /conduit
 * serves both under that prefix. MAIL_OAUTH_CALLBACK_PATH is the literal this
 * router registers below, shared so config.ts can check a redirect URI against
 * it without importing a route module. */
function oauthCallbackPath(basePath: string): string {
  return basePath === "/" ? MAIL_OAUTH_CALLBACK_PATH : `${basePath}${MAIL_OAUTH_CALLBACK_PATH}`;
}

export function registerMailRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  // syncManager is the GETTER, captured here and called inside each handler:
  // the manager itself does not exist until after the server is listening
  // (see CrmRouteDeps), so nothing may read it at registration time.
  const {
    db, dataDir, mailKeyPath, basePath, transportFactory, mailTokenRefresher, syncManager,
    mailOAuthClients, mailOAuthStates, mailOAuthExchange,
  } = deps;

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
   * Ask for a sync pass after a folder command, and do not wait for it.
   *
   * The PATCH handler's enable branch does this inline and this is the same
   * thing three call sites deep, so it is one function: syncNow resolves when
   * the pass is REQUESTED (the loop may be mid-backfill), the client learns
   * what came of it from the SSE hints the pass publishes, and a rejection is
   * logged and swallowed because the write this route came to make has already
   * landed. The `try` around the `void` is the same belt and braces the two
   * inline copies carry: syncNow is documented to reject rather than throw, and
   * a fake that throws must not take the request with it.
   */
  function requestPassAfterFolderCommand(
    request: FastifyRequest, accountId: string, folder: string,
  ): void {
    const onFailure = (error: unknown): void => {
      request.log.warn(
        { err: error, accountId, folder },
        "mail: could not request a sync pass after a folder command",
      );
    };
    try {
      void syncManager()?.syncNow(accountId).catch(onFailure);
    } catch (error) {
      onFailure(error);
    }
  }

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

  /**
   * Create, rename and delete a MAILBOX ON THE SERVER (Phase 4.4 Task 4).
   *
   * Owner-only like every other folder route above, through the same
   * mustGetOwnedAccount check inside the service -- and more obviously so:
   * these change another person's mail server, and only its owner may.
   *
   * ALL THREE ARE POST, and rename and delete deliberately do not name the
   * folder in the path. An IMAP mailbox name is arbitrary user text -- it can
   * carry the hierarchy separator, spaces and any non-ASCII the server's
   * namespace allows -- and a name in a URL is a name in every access log and
   * proxy trace between here and the browser. Same reasoning as the
   * test-connection route below being POST despite reading nothing. It is also
   * why DELETE-the-verb is not used: the name has to travel in a body, and a
   * body on DELETE is a thing HTTP declines to define.
   *
   * NO REQUEST CAP HERE, unlike the bulk routes. Each of these is ONE mailbox
   * command, so there is no size to bound -- but they do wait on the account's
   * serial sync loop exactly as a bulk move does, so a folder command issued
   * against an account mid-backfill waits for that backfill, and a proxy 504
   * means the ANSWER was lost rather than that the command failed.
   */
  app.post("/api/mail/accounts/:id/folders", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(folderCreateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const folder = await createFolder(db, user.id, params.id, input, {
        syncManager: syncManager(), logger: request.log,
      });
      void reply.code(201);
      return folder;
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * Rename, with the two-system write mail-folders.ts's renameFolder argues.
   *
   * A SYNC PASS IS ASKED FOR AFTERWARDS, and not waited on, exactly as the
   * PATCH above does when it enables a folder. The re-key has already made
   * Conduit's own records right; what a pass adds is the server's opinion of
   * the new name -- its SPECIAL-USE classification, which the rename
   * deliberately does not guess (see renameFolder) -- and it costs nothing to
   * ask for it now rather than in five minutes. A rejection is logged and
   * swallowed for that route's reason: a sync engine having a bad day must not
   * turn a completed rename into a 500.
   */
  app.post("/api/mail/accounts/:id/folders/rename", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(folderRenameInputSchema, request.body, reply);
    if (input === undefined) return;
    let result;
    try {
      result = await renameFolder(db, user.id, params.id, input, {
        syncManager: syncManager(), logger: request.log,
      });
    } catch (error) {
      mapDomainError(reply, error);
      return;
    }
    requestPassAfterFolderCommand(request, params.id, input.folder);
    return result;
  });

  /**
   * Delete, which deletes no mail: mail-folders.ts's deleteFolder refuses a
   * folder the server says still holds any, and keeps every message Conduit
   * had already stored from it.
   *
   * THE PASS MATTERS MORE HERE THAN ANYWHERE ELSE ON THIS ROUTER. The deleted
   * folder's row survives (rows in that table are never deleted), and what
   * makes the clients stop offering it is going STALE -- its
   * last_discovered_at standing still while every re-sighted folder's moves on.
   * Only a pass moves the others. Without this call the row would go on looking
   * live, and filable-into, until the poll interval came round.
   */
  app.post("/api/mail/accounts/:id/folders/delete", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(folderDeleteInputSchema, request.body, reply);
    if (input === undefined) return;
    let result;
    try {
      result = await deleteFolder(db, user.id, params.id, input, {
        syncManager: syncManager(), logger: request.log,
      });
    } catch (error) {
      mapDomainError(reply, error);
      return;
    }
    requestPassAfterFolderCommand(request, params.id, input.folder);
    return result;
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
      return await testConnection(db, user.id, input, mailKeyPath, {
        ...defaultTestConnectionDeps,
        // An OAuth account is tested with a real access token, which means a
        // real refresh against a real provider. Same refresher the send path
        // gets, from the same composition root, so "Test connection" cannot
        // report on a mechanism the sync loop does not use.
        refresh: mailTokenRefresher,
      });
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // --- Signing in at a provider (Phase 8 Task 3) ---------------------------

  /** Everything the sign-in service needs that this router already holds.
   * Built per request rather than captured, for the reason `syncManager` is a
   * getter: nothing here may read a value that did not exist at registration. */
  function signinDeps(): SigninDeps {
    return {
      db, mailKeyPath,
      clients: mailOAuthClients,
      states: mailOAuthStates,
      exchange: mailOAuthExchange,
      now: () => new Date(),
    };
  }

  /**
   * Which providers this install can sign in to.
   *
   * Its own route rather than a field on the accounts list, because it answers
   * a question about the DEPLOYMENT and not about any account -- and because
   * the add-account form needs it before there is an account to ask about. See
   * mailOAuthProvidersSchema (@conduit/shared) for why the client ids are not
   * in the response even though they are not secret.
   *
   * IT ANSWERS AN EMPTY LIST USEFULLY (Task 4), which is the case this install
   * is in today. `providers: []` alone says "no", and the page could only
   * render silence; the two fields beside it say what would have to be true
   * instead -- the exact path to register, and whichever half of the pair is
   * already configured -- so an operator holding the Azure or Google console
   * open can finish the job from this screen rather than from routes/mail.ts.
   */
  app.get("/api/mail/oauth/providers", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    return {
      providers: configuredProviders(mailOAuthClients),
      // basePath, not the bare literal: an install mounted at /conduit serves
      // its callback under that prefix, and a path that omitted it is exactly
      // the byte-for-byte mismatch this field exists to prevent.
      callbackPath: oauthCallbackPath(basePath),
      // THE PAIR IS ONE VALUE, so either registration answers it and neither
      // is preferred; config.ts builds both registrations from the same
      // MAIL_OAUTH_REDIRECT_URI and refuses a half one. Null means unset,
      // which is a different thing from "wrong" -- a wrong one does not reach
      // here, because parseConfig refuses to boot with it.
      redirectUri: (mailOAuthClients.microsoft ?? mailOAuthClients.google)?.redirectUri ?? null,
    };
  });

  /**
   * Start a sign-in: mint a state and answer with where to send the browser.
   *
   * POST, AND IT WRITES NOTHING TO THE DATABASE. The POST is not about
   * persistence -- it is that the body carries the mailbox address and the
   * label for an account that does not exist yet, and that the response is a
   * URL the client navigates to rather than a redirect this server performs.
   * A 302 here would be followed by the fetch, not by the window.
   *
   * THE STATE IS MINTED AGAINST user.id, and that is the binding the callback
   * checks (services/mail-oauth-signin.ts's header, item 3).
   */
  app.post("/api/mail/accounts/oauth/authorize", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(mailOAuthSigninInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      // A re-authorisation names an account, and the ACCOUNT supplies the
      // address -- never the request. Taking the client's word for it would let
      // one request's login_hint be pointed at somebody else's mailbox, and
      // mustGetOwned here is also what makes a foreign account id 404 rather
      // than mint a state for a row the caller cannot see.
      //
      // The two casts are sound by mailOAuthSigninInputSchema's superRefine,
      // which requires both fields whenever `accountId` is absent -- the same
      // XOR mailAccountTestInputSchema uses, and typed the same way, so
      // TypeScript cannot narrow across it. What makes that a fact rather than
      // a reading: index.test.ts pins the superRefine (it names the missing
      // FIELDS, not just that something is missing) and the route test pins the
      // 400 it produces, so a schema edit that dropped it fails on both sides
      // rather than writing `undefined` into a NOT NULL column as a 500.
      const target = input.accountId === undefined
        ? {
            kind: "create" as const,
            label: input.label as string,
            email: input.email as string,
            ...(input.backfillDays !== undefined ? { backfillDays: input.backfillDays } : {}),
          }
        : {
            kind: "reauthorize" as const,
            accountId: input.accountId,
            email: (await getOwnAccount(db, user.id, input.accountId)).email,
          };
      return await startSignin(signinDeps(), user.id, { ...target, provider: input.provider });
    } catch (error) {
      if (error instanceof MailOAuthNotConfiguredError) {
        // 409 rather than 500 or 503: nothing is broken and nothing will fix
        // itself, this install simply has no registration for that provider.
        // The message names the settings, which is the whole of the remedy.
        return reply.code(409).send({ error: "mail_oauth_not_configured", message: error.message });
      }
      mapDomainError(reply, error);
    }
  });

  /**
   * The redirect URI. The provider sends the operator's browser back here.
   *
   * A TOP-LEVEL NAVIGATION, WHICH DECIDES EVERYTHING ABOUT THIS HANDLER. It is
   * a window, not a fetch, so the answer has to be something a window can
   * render: a redirect to the settings page carrying a one-word outcome. A JSON
   * body -- including the JSON 500 an uncaught throw would produce -- would
   * leave the operator staring at a serialised error where a page should be.
   * completeSignin is documented never to throw for exactly this reason.
   *
   * IT CARRIES THE SSO IDENTITY LIKE ANY OTHER REQUEST, because it is one:
   * nginx injects Ynh-User on the way through (auth.ts), so requireUser here is
   * the session half of the state binding rather than a formality.
   *
   * WHICH LEAVES ONE UGLY CASE, named rather than papered over: an SSOwat
   * session that expires while the operator is at the consent screen gets the
   * ordinary 401 JSON body in a browser window. Rendering a page for it would
   * mean this route answering an unauthenticated request with HTML, which is a
   * bigger change to the app's one auth shape than the case is worth -- it
   * needs a session to lapse inside a ten-minute window, and pressing back and
   * signing in again costs nothing, because the state was never spent.
   *
   * WHAT GOES IN THE REDIRECT IS A CODE, NEVER PROVIDER TEXT. See
   * SigninOutcome. The provider's own words go to the journal, at warn, where
   * a person diagnosing this can read them and a URL bar cannot.
   *
   * 303, AND ANSWERING WITH A REDIRECT RATHER THAN A PAGE IS WORTH MORE THAN IT
   * LOOKS. The URL this route is reached at carries the authorisation code. A
   * handler that RENDERED here would leave that URL as the document's own
   * address: in the history, in the address bar, and in the `Referer` of every
   * subresource the page then fetched. A server redirect leaves no history
   * entry for the redirecting URL, so the document that ends up loaded is
   * /settings/mail and the code is gone from everything a browser keeps. What
   * that does NOT reach is nginx's access log, which has its own copy this
   * process cannot do anything about -- which is the exposure PKCE is here to
   * make survivable (services/mail-oauth-signin.ts's header).
   */
  // THE CONSTANT, NOT A SECOND COPY OF THE STRING. config.ts checks a
  // configured MAIL_OAUTH_REDIRECT_URI against it and the providers route tells
  // the operator to register it; a literal here would let this route move and
  // leave both of those quietly describing a path that no longer exists.
  app.get(MAIL_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = oauthCallbackQuerySchema.safeParse(request.query);
    // A callback whose query is not even the right SHAPE is treated as a
    // failed state check rather than a 400: it is not a request a client made,
    // it is something that arrived at a URL, and the operator's answer is the
    // same either way. parseOrReject's 400 JSON would be the wrong medium.
    const result = await completeSignin(
      signinDeps(), user.id, params.success ? params.data : {},
    );
    if (result.outcome !== "connected") {
      request.log.warn(
        { outcome: result.outcome, detail: result.logDetail },
        "mail oauth: sign-in did not complete",
      );
    }
    const query = result.outcome === "connected"
      ? "oauth=connected"
      : `oauth=failed&reason=${result.outcome}`;
    return reply.redirect(`${settingsMailPath(basePath)}?${query}`, 303);
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
    const query = parseOrReject(threadDetailQuerySchema, request.query, reply);
    if (query === undefined) return;
    try {
      // basePath, not a hardcoded prefix: stored body_html carries
      // `mailattachment:` placeholders and is resolved to real routes here,
      // at serve time, so a `yunohost app change_url` needs no migration.
      return await getThreadDetail(db, user.id, params.id, basePath, { all: query.all });
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
    // {thread, changed}, not the bare thread: `changed` is what lets the
    // client skip its invalidation cascade when this was a no-op -- see the
    // shared markThreadReadResponseSchema.
    return { thread: result.thread, changed: result.changed };
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
   * The bulk thread actions: Trash, Archive and File MOVE messages on the IMAP
   * server -- the first two to a folder the OWNING ACCOUNT names, File (Phase
   * 4.4) to one the REQUEST names in `targetFolder` -- while "Hide in CRM" and
   * its inverse write and delete the ACTOR'S own per-user hide rows
   * (mail_thread_hides, Phase 4.3 -- nobody else's views change;
   * services/mail-move.ts owns all five).
   *
   * FILING INTO A FOLDER CONDUIT IS NOT SYNCING TURNS THAT SYNC ON, without
   * warning and without refusing (the Phase 4.4 rule -- see mail-move.ts's
   * header for why a warning there would be an admission that the design is
   * wrong). It is the one side effect of this route that outlives the request,
   * so the response says which folder it was (`syncEnabled`) for the client to
   * show after the fact, and the service's summary log line records it for
   * whoever asks later.
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
   * conf/nginx.conf sets `proxy_read_timeout 300` for this route (7.6 gave the backup route a location of its own at 3600; every other route, this one included, keeps the 300), so five minutes is where
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
    // The shared schema's 200 is the outer bound and only the CRM-side pair
    // may reach it: hiding and unhiding are one hide-row insert or delete per
    // thread (the actor's own mail_thread_hides row), while trash/archive/file
    // each wait on a real mail server. Capping the MOVE actions lower is the
    // ruling's answer to that wait -- bound the SIZE of the request rather than
    // its duration, since a timeout would produce exactly the "claimed a move
    // the server refused" state the move service's compensation exists to
    // prevent. 50 is two of this list's default pages (the thread list asks for
    // 25 at a time, and accumulates), so the longest a single request can hold a
    // connection open is 50 threads' worth of queued MOVEs behind whatever that
    // account's serial loop is already doing -- and a user who has pressed "load
    // more" once can still select everything on screen and act on it in one
    // gesture. Enforced HERE rather than in the schema because it is a
    // property of the ACTION, not of the body shape; the NUMBERS live in
    // @conduit/shared beside that schema, because the web client mirrors them
    // (its select-all cap) and a client-side copy that drifted would build
    // requests this line answers with a 400.
    //
    // READ OFF A TABLE, not off an `action !== "hide"` test, which is what
    // this line used to be. That negation was right while `hide` was the only
    // action waiting on nothing, and would have silently handed Phase 4.4's
    // `unhide` -- a local row DELETE -- the mail server's cap, with no test to
    // notice. BULK_ACTION_THREAD_CAPS is a Record over the kind enum, so the
    // next kind cannot be added without someone deciding which side of the
    // wait it is on.
    const cap = BULK_ACTION_THREAD_CAPS[input.action];
    if (input.threadIds.length > cap) {
      return reply.code(400).send({
        error: "validation",
        message: `${input.action} accepts at most ${cap} threads per request`
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

  /**
   * POST /api/mail/messages/bulk -- the per-message selection (Phase 4.4).
   *
   * A SEPARATE ROUTE FROM /threads/bulk, not a widened one, and this is the
   * whole surface the ruling produces. Selection in this app has been per
   * THREAD since 4.3, whose folder-scoped rule exists precisely because a
   * thread id cannot say which of its spread-out messages a gesture meant.
   * A message id says it exactly. Overloading `threadIds` to sometimes mean
   * messages -- or teaching this body two units -- is how that scoping rule
   * became necessary in the first place.
   *
   * It is deliberately NARROWER than the thread endpoint on three axes, each
   * checked by the shared schema rather than here (see
   * bulkMessageActionInputSchema): the three MOVE kinds only, since a hide is
   * one mail_thread_hides row per THREAD and there is no per-message one; no
   * source `folder`, since the ids are already the exact scope, and a body
   * carrying one is REJECTED rather than quietly ignored; and results keyed on
   * `messageId`, because two messages of one conversation can genuinely land
   * differently and a thread-keyed answer would have to lie about one of them.
   *
   * NO CAP CHECK OF ITS OWN, unlike the thread endpoint above, and the absence
   * is the point rather than an omission. That one needs a route-level check
   * because its schema's 200 is an outer bound only the CRM-side pair may
   * reach, so the real limit depends on the ACTION. Here every kind waits on a
   * mail server, so there is one limit for all of them and it lives in the
   * schema's own `.max()` (BULK_MESSAGE_ACTION_CAP) -- a second copy here
   * would be two numbers to keep in step for no gain.
   *
   * Everything else is the thread endpoint's contract unchanged: always 200
   * when the request itself was valid, per-message verdicts inside the body in
   * request order, and A 504 FROM A PROXY DOES NOT MEAN THE ACTION FAILED --
   * the queued MOVEs run on their accounts' serial sync loops and carry on
   * after the client disconnects, so the answer is lost while the work lands.
   * Refetch rather than retry.
   */
  app.post("/api/mail/messages/bulk", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(bulkMessageActionInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await moveMessages(db, user.id, input, {
        // Resolved per request, never captured -- the manager does not exist
        // when routes are registered (see CrmRouteDeps.syncManager), and null
        // is an ordinary answer the service knows what to do with.
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
        mailKeyPath, transportFactory, tokenRefresher: mailTokenRefresher,
        syncManager: syncManager(),
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
}
