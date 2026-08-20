import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  mailAccountCreateInputSchema, mailAccountUpdateInputSchema, mailAccountUpdatePasswordFieldsSchema,
  mailAccountTestInputSchema, mailLinkKindSchema, threadLinksInputSchema, sendMailInputSchema,
  createEmailTemplateInputSchema, updateEmailTemplateInputSchema,
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
  archiveThread, unarchiveThread, unreadThreadCount, getAttachmentBlob, toMessage,
} from "../services/mail-threads.js";
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
    readonly stats: MailAccountSyncStats;
  } | undefined;
}

// unread/unlinked/archived are the same tri-state wire flag companies.ts's
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
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
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

  app.get("/api/mail/threads", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(threadListQuerySchema, request.query, reply);
    if (query === undefined) return;
    // The mail list pages by (last_message_at, id), so a created_at cursor
    // minted by any other list must be rejected here rather than silently
    // paging from a timestamp that means something else.
    if (!validateCursor(query.cursor, reply, decodeLastMessageAtCursor)) return;
    return listThreads(db, {
      accountId: query.account_id, unread: query.unread, unlinked: query.unlinked,
      companyId: query.company_id, contactId: query.contact_id,
      dealId: query.deal_id, projectId: query.project_id,
      archived: query.archived, cursor: query.cursor, limit: query.limit,
    });
  });

  app.get("/api/mail/threads/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      // basePath, not a hardcoded prefix: stored body_html carries
      // `mailattachment:` placeholders and is resolved to real routes here,
      // at serve time, so a `yunohost app change_url` needs no migration.
      return await getThreadDetail(db, params.id, basePath);
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
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    let result;
    try {
      result = await markThreadRead(db, params.id);
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
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(threadLinksInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await setThreadLink(db, params.id, input.kind, input.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.delete("/api/mail/threads/:id/links/:kind", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(linkKindParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await clearThreadLink(db, params.id, params.kind);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // CRM-side only: nothing is moved or expunged on the IMAP server.
  app.post("/api/mail/threads/:id/archive", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveThread(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/mail/threads/:id/unarchive", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveThread(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/mail/unread-count", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    return { count: await unreadThreadCount(db) };
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
    reply: FastifyReply, id: string, mode: "download" | "inline",
  ): Promise<unknown> {
    const attachment = await getAttachmentBlob(db, id, { inlineOnly: mode === "inline" });
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
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await serveAttachment(reply, params.id, "download");
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // What a message body's rewritten cid: images point at (see
  // mail-content.ts's resolveAttachmentUrls). An ordinary authenticated
  // same-origin route: the conversation iframe renders with
  // sandbox="allow-same-origin" and no allow-scripts, so subresource loads
  // carry the session cookie and reach this route through the SSOwat proxy
  // the way any other request does.
  app.get("/api/mail/attachments/:id/inline", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await serveAttachment(reply, params.id, "inline");
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
