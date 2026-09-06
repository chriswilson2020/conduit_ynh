import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  documentTemplateInputSchema, documentTypeSchema, issueQuoteInputSchema, orgProfileInputSchema,
  recordDocumentInputSchema, redraftLetterInputSchema,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import { RenderBusyError, RenderError } from "../services/documents-render.js";
import { TemplateError } from "../services/documents-template.js";
import {
  DocumentFrozenError, DocumentInputError, DocumentTemplateMissingError, DocumentTooLargeError,
  getDocumentTemplate, issueAgreement, issueLetter, issueMeetingSummary, issueQuote,
  issueStatusReport, listDocuments, listMeetingSummaries, listProjectDocuments,
  listRecordDocuments, redraftLetter, saveDocumentTemplate,
  type RecordTarget,
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

/**
 * The driver's own message for a failed query, which is NOT `error.message`.
 *
 * drizzle wraps a query failure in a `DrizzleQueryError` whose message is
 * "Failed query: UPDATE ..." with the SQL in it; what PostgreSQL actually said is
 * on the `cause`, beside the `code` above. A first draft of the frozen-trigger
 * arm below read `error.message` and would have matched the SQL text rather than
 * the refusal -- true for any statement mentioning the constraint by name, false
 * for the one that violates it.
 */
function postgresMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { cause?: { message?: unknown } }).cause?.message;
  return typeof message === "string" ? message : "";
}

export function mapDocumentError(reply: FastifyReply, error: unknown): void {
  // The input gates, quote and profile alike. The route already parsed the same
  // schema, so these are the services refusing a caller that reached them another
  // way -- but the shape a client sees has to be the same either way.
  if (error instanceof DocumentInputError || error instanceof OrgProfileInputError) {
    void reply.code(400).send({ error: "validation", message: error.message });
    return;
  }
  /*
   * **409, AND THE ARM EXISTS SO THIS IS NEVER A 500.** A frozen document is a
   * conflict with the state of the resource, which is what 409 means, and it is
   * exactly what `PUT /api/documents/:id` answers when somebody points a redraft
   * at a quote or an NDA.
   *
   * ITS OWN CODE, NOT `validation`. Nothing was wrong with the submission -- the
   * same body would have been accepted against a letter -- so a 400 would send
   * the person editing it looking at their fields. `frozen` says what changed:
   * the document, not the input.
   *
   * IT IS ALSO WHAT MAPS `conduit_document_frozen_guard`'s REFUSAL, though
   * nothing reachable should ever produce one: the service's UPDATE carries
   * `AND frozen = false` and answers this error itself. If the trigger ever
   * fires through a route it is a bug, and a 500 is what a bug deserves -- but
   * an operator watching a spinner deserves the sentence rather than the
   * stack, so the message is the same either way. See the 23514 arm below.
   */
  if (error instanceof DocumentFrozenError) {
    void reply.code(409).send({ error: "frozen", message: error.message });
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
  /*
   * **THE TRIGGER'S OWN REFUSAL, WHICH NOTHING REACHABLE SHOULD PRODUCE.**
   * `conduit_document_frozen_guard` (migration 0019) raises 23514 with its name
   * in the message. Every route that could reach it goes through a service that
   * has already refused with DocumentFrozenError above, so arriving here means a
   * write path nobody has written yet -- Task 4's, say -- got past the service.
   *
   * MATCHED ON THE NAME AND NOT ON 23514 ALONE, which is the whole reason this
   * arm is three lines rather than one. Every CHECK in the schema raises 23514:
   * a negative quantity, a malformed currency, an over-long timezone. Mapping
   * the code would turn all of them into "an issued quote cannot be changed".
   *
   * WHY MAP IT AT ALL RATHER THAN LET IT 500. The 500 would be honest about
   * there being a bug, and useless to the operator holding the mouse. This gives
   * them the same sentence the service would have given them, and the server log
   * still has the trigger's message with the constraint name in it, which is
   * what says a guard fired that should not have had to.
   */
  if (isPostgresError(error, "23514")
    && postgresMessage(error).includes("documents_frozen_is_immutable")) {
    void reply.code(409).send({
      error: "frozen",
      message: "an issued document cannot be changed",
    });
    return;
  }
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

  // THE MEETING SUMMARY'S PAIR, registered here rather than in routes/meetings.ts
  // because this file owns the document surfaces -- mapDocumentError's seven arms
  // are what a caller of either POST needs, and duplicating that mapping next to
  // the meeting CRUD is how the two would drift. `:id` matches routes/meetings.ts's
  // own parameter name, which find-my-way requires in the same path position.
  app.get("/api/meetings/:id/documents", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    // Unbounded, like the deal's documents: a meeting's summaries stay countable.
    return await listMeetingSummaries(db, params.id);
  });

  // NO BODY, AND THAT IS THE WHOLE POINT OF THIS TYPE. Everything printed is on
  // the meeting; the URL says which one. There is nothing to parse, so there is no
  // `parseOrReject` for a body and no input schema in @conduit/shared -- an empty
  // input schema would be a form with no fields, which is what "the type with no
  // form" means. Fastify accepts a POST with no body.
  app.post("/api/meetings/:id/documents", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      const document = await issueMeetingSummary(db, { dataDir }, user.id, params.id);
      return await reply.code(201).send(document);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });

  /*
   * THE PROJECT'S STATUS REPORTS -- Phase 9 Task 4, and the second pair in this
   * file with NO REQUEST BODY.
   *
   * The meeting summary's pair a few lines up says "NO BODY, AND THAT IS THE
   * WHOLE POINT OF THIS TYPE". That sentence was about a type the spec had
   * already described as having no extra input; this one is about a type the spec
   * gave "possibly a date range" and which turned out to need nothing -- see
   * `issueStatusReport` for the argument, which is the plan's own question
   * answered rather than dodged. There is nothing to parse, so there is no
   * `parseOrReject` for a body and no input schema in @conduit/shared. Fastify
   * accepts a POST with no body.
   *
   * `:id` AGAIN, for the reason every other pair here has it: find-my-way refuses
   * two different parameter names in the same path position, and
   * `/api/projects/:id`, `/archive` and `/unarchive` already exist in
   * routes/projects.ts.
   */
  app.get("/api/projects/:id/documents", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    // Unbounded, like the deal's documents and the meeting's summaries: a
    // project's reports stay countable -- one a month is twelve a year.
    return await listProjectDocuments(db, params.id);
  });

  app.post("/api/projects/:id/documents", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      const document = await issueStatusReport(db, { dataDir }, user.id, params.id);
      return await reply.code(201).send(document);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });

  /*
   * THE COMPANY'S AND THE CONTACT'S DOCUMENTS -- Phase 9 Task 3.
   *
   * TWO RECORDS, ONE PAIR OF HANDLERS EACH, AND ONE BODY SCHEMA. The type is in
   * the BODY and not in the path (`recordDocumentInputSchema` discriminates on
   * it), because what a caller is doing is "add a document to this company" and
   * which kind is a choice inside that. The alternative --
   * `/companies/:id/letters`, `/companies/:id/ndas`, and the same again for
   * contacts -- grows a route pair per type per record for ever, and makes the
   * record's own document list a union of N reads instead of one.
   *
   * `:id` AGAIN, for the reason the deal's routes have it: find-my-way refuses
   * two different parameter names in the same path position, and
   * `/api/companies/:id`, `/archive` and `/unarchive` already exist.
   *
   * THE PDF STILL DOWNLOADS THROUGH GET /api/files/:id/download and there is
   * still no download route here. That is Phase 7's design and Task 2 kept it;
   * a letter's page is an ordinary `files` row on the same record.
   */
  const recordDocumentRoutes = (
    path: "companies" | "contacts",
    toTarget: (id: string) => RecordTarget,
  ): void => {
    app.get(`/api/${path}/:id/documents`, async (request, reply) => {
      if (requireUser(request, reply) === null) return;
      const params = parseOrReject(idParamSchema, request.params, reply);
      if (params === undefined) return;
      /*
       * **`?includeContacts=true` -- THE ROLLUP TASK 3 RECOMMENDED, AS A QUERY
       * PARAMETER RATHER THAN A SECOND ROUTE OR A CHANGED DEFAULT.**
       *
       * Task 3 found that a letter to Jane at Acme does not appear on Acme's
       * Documents list, called it "real friction" for correspondence, and
       * recommended "a read, not a column... behind a flag the section can
       * offer". This is that flag. Nothing about the data model moved: Chris's
       * "a document belongs to exactly one thing" is untouched, and what changed
       * is what one page chooses to SHOW.
       *
       * OFF UNLESS ASKED, so the behaviour Task 3 asserted deliberately
       * ("keeps a contact's documents separate from their company's") is still
       * the behaviour of an unqualified GET -- and both are now testable side by
       * side, which is what makes the choice reversible rather than replaced.
       *
       * PARSED AS THE LITERAL STRING "true", not with a boolean coercion.
       * `z.coerce.boolean()` answers TRUE for the string "false", which is the
       * one value a client is most likely to send when it means the opposite.
       * The parameter is absent or it is "true"; anything else is off, and no
       * request is ever refused over it.
       */
      const query = request.query as { includeContacts?: unknown };
      const includeContacts = query.includeContacts === "true";
      // Unbounded, like the deal's documents and the meeting's summaries: a
      // company's documents stay countable, and there is no cursor to page with.
      return await listRecordDocuments(db, toTarget(params.id), { includeContacts });
    });

    app.post(`/api/${path}/:id/documents`, async (request, reply) => {
      const user = requireUser(request, reply);
      if (user === null) return;
      const params = parseOrReject(idParamSchema, request.params, reply);
      if (params === undefined) return;
      const input = parseOrReject(recordDocumentInputSchema, request.body, reply);
      if (input === undefined) return;
      try {
        const target = toTarget(params.id);
        // THE ONE BRANCH ON THE DISCRIMINATOR, and it is here rather than inside
        // a single service function because the two produce different DTOs and
        // take different paths through the database -- an agreement allocates a
        // number under a row lock and a letter does not. A service that took the
        // union would open with this same `if` and then have two bodies.
        const document = input.type === "letter"
          ? await issueLetter(db, { dataDir }, user.id, target, input)
          : await issueAgreement(db, { dataDir }, user.id, target, input);
        return await reply.code(201).send(document);
      } catch (error) {
        mapDocumentError(reply, error);
      }
    });
  };
  recordDocumentRoutes("companies", (id) => ({ companyId: id }));
  recordDocumentRoutes("contacts", (id) => ({ contactId: id }));

  /*
   * **REDRAFT A LETTER. THE ONLY ROUTE IN CONDUIT THAT MODIFIES AN ISSUED
   * DOCUMENT**, and the reason the sentence at the top of this file -- "there is
   * no update or delete, which is the phase's central claim" -- is now true of
   * the QUOTE rather than of documents in general.
   *
   * A PUT AND NOT A PATCH, matching PUT /api/org-profile and for its reason: it
   * is one form with seven fields and no concurrent editors, so sending the whole
   * thing is both the simplest contract and the only one in which clearing a
   * field is expressible. `redraftLetterInputSchema` is the issue schema minus
   * its `type`, so the two cannot validate different things.
   *
   * ON /api/documents/:id RATHER THAN UNDER THE RECORD, because a redraft does
   * not need to know which record the letter is on -- the document does, and
   * putting it in the path would let a caller name a company the letter is not
   * attached to and get either a 404 or, worse, a silent write to the wrong
   * record's timeline. The service reads the target off the row.
   *
   * THERE IS STILL NO DELETE, ANYWHERE. A letter that should not have been
   * written is a letter that was written; nothing in this product deletes a
   * record, and `conduit_document_frozen_guard` refuses a DELETE of a frozen one
   * outright.
   */
  app.put("/api/documents/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(redraftLetterInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await redraftLetter(db, { dataDir }, user.id, params.id, input);
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
      // PUT rather than PATCH: it is one form with ten fields (nine until v1.8.0
      // added the timezone) and no concurrent editors, so sending the whole form is
      // both the simplest contract and the one in which clearing a field is
      // expressible.
      return await saveOrgProfile(db, input);
    } catch (error) {
      mapDocumentError(reply, error);
    }
  });
}
