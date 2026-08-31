import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  documentTemplateInputSchema, documentTypeSchema, issueQuoteInputSchema, orgProfileInputSchema,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import { RenderBusyError, RenderError } from "../services/documents-render.js";
import { TemplateError } from "../services/documents-template.js";
import {
  DocumentInputError, DocumentTemplateMissingError, DocumentTooLargeError,
  getDocumentTemplate, issueQuote, listDocuments, saveDocumentTemplate,
} from "../services/documents.js";
import { getOrgProfile, OrgProfileInputError, saveOrgProfile } from "../services/org-profile.js";

/**
 * Raising a quote, listing what has been raised, and the issuer profile that gets
 * printed at the top of one.
 *
 * THERE IS NO DOWNLOAD ROUTE HERE, deliberately. The rendered PDF is an ordinary
 * `files` row against the same deal, so it downloads through the existing
 * `GET /api/files/:id/download` and appears on the Files tab with no second storage
 * or download path to keep in step. (The plan's shorthand calls that route
 * `GET /api/files/:id`; the shipped path has the `/download` suffix.)
 *
 * THE PARAM IS `:id`, NOT `:dealId`, and that is a router constraint rather than a
 * preference: `/api/deals/:id/win`, `/archive` and six others already exist, and
 * find-my-way refuses two different parameter names in the same path position. The
 * URL is identical either way.
 *
 * AND THERE IS NO UPDATE OR DELETE, which is the phase's central claim rather than
 * an omission: a quote already issued never changes, and a corrected quote is a new
 * quote with a new number.
 */

/**
 * The failures this surface owns, none of which should reach the 5xx handler.
 *
 * Deliberately uncounted. It was "four" when Task 4 wrote it and there are seven arms
 * now -- the two 503s and the input-cap 413 arrived in later rounds -- and a count in
 * a comment beside a list that grows is a number waiting to go stale. The table test
 * over the arms is what keeps them all covered.
 *
 * Falls through to mapDomainError for the ordinary ones (an unknown deal is a 404,
 * an archived deal a 409), which is also what re-throws anything genuinely
 * unexpected so app.ts decides what a 5xx body looks like.
 */
/** A driver error carrying `code` on its `cause`, which is how postgres.js reports a
 * SQLSTATE through drizzle. */
function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null
    && (error as { cause?: { code?: unknown } }).cause?.code === code;
}

export function mapDocumentError(reply: FastifyReply, error: unknown): void {
  // The input gates, quote and profile alike. The route already parsed the same
  // schema, so these are the services refusing a caller that reached them another
  // way -- but the shape a client sees has to be the same either way.
  if (error instanceof DocumentInputError || error instanceof OrgProfileInputError) {
    void reply.code(400).send({ error: "validation", message: error.message });
    return;
  }
  // 409 rather than 500: the seeded template was deleted, which an operator fixes in
  // Settings. Nothing was spent -- this is raised before the number is allocated.
  if (error instanceof DocumentTemplateMissingError) {
    void reply.code(409).send({ error: "template_missing", message: error.message });
    return;
  }
  // The template cannot produce a document at all: it exceeded one of mergeTemplate's
  // three bounds (a million steps of work, 32 levels of nesting, 512K of output).
  // 422 because the submission was well-formed and the TEMPLATE is what refused it,
  // and the message says which bound so the person editing it can act. It happens
  // before the render, so no number is spent either way.
  if (error instanceof TemplateError) {
    void reply.code(422).send({ error: "template_error", message: error.message });
    return;
  }
  // Before the RenderError arm it extends: nothing about the document was wrong, the
  // renderer was saturated, and 503 is the status that tells a client to retry. The
  // generic arm would otherwise call a busy server's answer an unprocessable one.
  if (error instanceof RenderBusyError) {
    void reply.code(503).send({ error: "renderer_busy", message: error.message });
    return;
  }
  // The authoritative size check, which runs one layer above renderPdf's identical
  // cap and can therefore say what was too big. Same status and code as the renderer's
  // own refusal: one shape for "that document is too large", whichever layer noticed.
  if (error instanceof DocumentTooLargeError) {
    void reply.code(413).send({ error: "too_large", message: error.message });
    return;
  }
  // 55P03 -- lock_not_available. Two quotes of the same type and year serialise on one
  // sequence row, and the issuing transaction sets a lock_timeout so a pile-up fails
  // rather than occupying a pooled connection indefinitely. Retrying is exactly right,
  // which is what 503 says; nothing was spent, because the timeout fires before the
  // number is allocated.
  if (isPostgresError(error, "55P03")) {
    void reply.code(503).send({
      error: "busy",
      message: "another quote is being issued; try again in a moment",
    });
    return;
  }
  if (error instanceof RenderError) {
    // 413 with the same code files.ts answers for an over-cap upload: one refusal
    // shape for "that is too big", however the size arrived.
    if (error.message === "document is too large to render") {
      void reply.code(413).send({ error: "too_large", message: error.message });
      return;
    }
    // Everything else the renderer can say -- a timeout, a non-zero exit, a blocked
    // resource. `message` is a fixed short phrase chosen by this codebase; `detail`
    // is the child's stderr and can name server paths, so it stays in the log and
    // never on the wire.
    void reply.code(422).send({ error: "render_failed", message: error.message });
    return;
  }
  mapDomainError(reply, error);
}

/** The document type in a path. Validated rather than trusted, so an unknown one is
 * the uniform 400 instead of a CHECK violation from the upsert. */
const typeParamSchema = z.object({ type: documentTypeSchema });

export function registerDocumentRoutes(app: FastifyInstance, { db, dataDir }: CrmRouteDeps): void {
  app.get("/api/deals/:id/documents", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    // Unbounded, like the deal's Files and Notes: a deal's documents stay countable.
    return await listDocuments(db, params.id);
  });

  app.post("/api/deals/:id/documents", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(issueQuoteInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      // 201 with the document. The PDF is not in the body: it is a stored file, and
      // the client fetches it by fileId through the download route above.
      const document = await issueQuote(db, { dataDir }, user.id, params.id, input);
      return await reply.code(201).send(document);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });

  // THE TEMPLATE EDITOR'S API. `document_templates` was read in one place and written
  // nowhere outside tests, so the Settings panel the spec requires had no server to
  // call and `documentTemplateWarnings` -- exported for exactly that editor -- had
  // nothing calling it. At the time these were written, only MAIL templates had
  // routes; v1.2.2 removed those, so these are now the only template routes there
  // are.
  //
  // Keyed by TYPE rather than by id: there is one row per type by unique constraint,
  // the type is what the URL means to a reader, and it saves the client a lookup to
  // find an id it can already derive.
  app.get("/api/document-templates/:type", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(typeParamSchema, request.params, reply);
    if (params === undefined) return;
    return await getDocumentTemplate(db, params.type);
  });

  app.put("/api/document-templates/:type", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(typeParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(documentTemplateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await saveDocumentTemplate(db, params.type, input);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });

  app.get("/api/org-profile", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    // Always 200: an install that has never opened Settings has an empty profile,
    // not a missing one (see getOrgProfile).
    return await getOrgProfile(db);
  });

  app.put("/api/org-profile", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const input = parseOrReject(orgProfileInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      // PUT rather than PATCH: it is one form with nine fields and no concurrent
      // editors, so sending the whole form is both the simplest contract and the one
      // in which clearing a field is expressible.
      return await saveOrgProfile(db, input);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });
}
