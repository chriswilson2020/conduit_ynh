import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema, contentDisposition } from "./helpers.js";
import { saveBlob, openBlob } from "../services/blobs.js";
import { attachFile, listFiles, getFile } from "../services/files.js";

/**
 * Mimes this route must never hand back as the DECLARED Content-Type, even
 * though every response here already carries `Content-Disposition:
 * attachment`. An attachment disposition is a hint that stops most browsers
 * from rendering the response as a navigation automatically, not a guarantee
 * -- a user opening a downloaded file (or a future change adding a preview)
 * would otherwise render attacker-controlled HTML/SVG/XML on the app's own
 * origin, with the SSO session attached. `X-Content-Type-Options: nosniff`
 * does not close that gap: it stops a browser GUESSING at a type, not one
 * that is DECLARED, so the dangerous handful is re-typed to
 * application/octet-stream instead.
 *
 * This is a DENYLIST, the deliberate opposite of mail.ts's
 * INLINE_RENDERABLE_MIME allowlist for its inline route. That route exists
 * for one narrow job (resolving a message body's `cid:` images), so
 * enumerating the few mimes it needs is natural. This route's whole purpose
 * is serving arbitrary uploaded attachments back down again -- PDFs, Office
 * docs, archives, plain images -- so an allowlist would have to keep pace
 * with every legitimate document type a user ever uploads. Denying only the
 * render-capable handful a browser would act on as a document is the shape
 * that fits a download-only route.
 *
 * Matched against the caller's ALREADY-NORMALIZED mime (see the route below):
 * this regex assumes lowercase with no surrounding whitespace, and does not
 * re-normalize its input itself.
 *
 * The `+xml` suffix is matched as a family rather than enumerated by name:
 * any RFC 7303 structured XML syntax (svg+xml, xhtml+xml, rss+xml, atom+xml,
 * and any future one) is exactly as renderable as the ones spelled out
 * individually, so closing the whole suffix in one rule means a mime this
 * list has never heard of still gets caught, rather than only the ones
 * someone thought to type in. text/xml and application/xml are the
 * non-suffixed XML root types RFC 7303 also defines, so they are listed
 * alongside text/html rather than folded into the suffix rule.
 * multipart/x-mixed-replace is included because it drives a browser's
 * server-push rendering (the "animated GIF via multipart" mechanism) --
 * also render-capable, not a static document type at all.
 */
function isDownloadDeniedMime(mime: string): boolean {
  return /\+xml$/.test(mime)
    || /^(text\/html|text\/xml|application\/xml|text\/xsl|multipart\/x-mixed-replace)$/.test(mime);
}

// company_id/contact_id/deal_id/project_id are optional filters here, not the
// required exactly-one notes.ts enforces on its list: unlike a note, "list
// files" has a sensible unfiltered meaning (no filter applied), so an absent
// filter is a no-op, not a client error. A caller in practice only ever
// sends one (the entity whose files it's rendering), but nothing here stops
// more than one from being ANDed together.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
});

const uuidSchema = z.uuid();

/** Multipart field values arrive as { value, ... } wrappers, not bare strings. */
function fieldValue(field: MultipartFile["fields"][string]): string | undefined {
  if (field === undefined || Array.isArray(field) || field.type !== "field") return undefined;
  return typeof field.value === "string" ? field.value : undefined;
}

export function registerFileRoutes(app: FastifyInstance, { db, dataDir }: CrmRouteDeps): void {
  app.post("/api/files", async (request: FastifyRequest, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;

    let part: MultipartFile | undefined;
    try {
      part = await request.file();
    } catch {
      return reply.code(400).send({ error: "validation", message: "a multipart file upload is required" });
    }
    if (part === undefined) {
      return reply.code(400).send({ error: "validation", message: 'a file field named "file" is required' });
    }
    if (part.fieldname !== "file") {
      part.file.resume();
      return reply.code(400).send({ error: "validation", message: 'the file field must be named "file"' });
    }

    // Fields declared before the file part in the multipart body are already
    // parsed by the time request.file() resolves (fastify-multipart is a
    // streaming parser); fields declared after it would not be. Callers MUST send
    // companyId/contactId/dealId/projectId before the file field for this to see them.
    const rawCompanyId = fieldValue(part.fields.companyId);
    const rawContactId = fieldValue(part.fields.contactId);
    const rawDealId = fieldValue(part.fields.dealId);
    const rawProjectId = fieldValue(part.fields.projectId);
    const companyId = rawCompanyId !== undefined && uuidSchema.safeParse(rawCompanyId).success ? rawCompanyId : undefined;
    const contactId = rawContactId !== undefined && uuidSchema.safeParse(rawContactId).success ? rawContactId : undefined;
    const dealId = rawDealId !== undefined && uuidSchema.safeParse(rawDealId).success ? rawDealId : undefined;
    const projectId = rawProjectId !== undefined && uuidSchema.safeParse(rawProjectId).success ? rawProjectId : undefined;
    // Exactly one of the four raw fields must be present AND resolve to a
    // valid uuid: rawCount !== 1 catches zero or more-than-one field sent;
    // resolvedCount !== 1 catches the one-field-sent-but-malformed-uuid case
    // rawCount alone would miss.
    const rawCount = [rawCompanyId, rawContactId, rawDealId, rawProjectId].filter((v) => v !== undefined).length;
    const resolvedCount = [companyId, contactId, dealId, projectId].filter((v) => v !== undefined).length;
    if (rawCount !== 1 || resolvedCount !== 1) {
      part.file.resume();
      return reply.code(400).send({
        error: "validation", message: "exactly one of companyId, contactId, dealId or projectId is required",
      });
    }

    const { sha256, sizeBytes } = await saveBlob(dataDir, part.file);
    // MUST be checked after saveBlob's stream has fully ended (which it has here,
    // since saveBlob awaits its pipeline to completion) -- see blobs.ts's doc
    // comment on saveBlob for why this check cannot live inside saveBlob itself.
    if (part.file.truncated) {
      return reply.code(413).send({
        error: "too_large",
        message: "the uploaded file exceeds the 50MB limit",
      });
    }

    try {
      const file = await attachFile(db, user.id, {
        originalName: part.filename, mime: part.mimetype, sizeBytes, sha256, companyId, contactId, dealId, projectId,
      });
      return reply.code(201).send(file);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/files", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listFiles(db, {
      companyId: query.company_id, contactId: query.contact_id, dealId: query.deal_id, projectId: query.project_id,
    });
  });

  app.get("/api/files/:id/download", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const file = await getFile(db, params.id);
    if (file === null) {
      return reply.code(404).send({ error: "not_found", message: `file ${params.id} not found` });
    }
    // Always: whatever Content-Type is declared below, a browser must never
    // be allowed to sniff its way to a different one.
    reply.header("X-Content-Type-Options", "nosniff");
    // The stored byte count, so the client gets a progress bar and a
    // definite end rather than a chunked stream of unknown length.
    reply.header("Content-Length", file.sizeBytes);
    // Normalized BEFORE the denylist check and served in that normalized
    // form: a stored mime of " text/html" (leading whitespace multer/busboy
    // will happily accept from a crafted Content-Type on upload) fails the
    // regex's anchored match verbatim, yet a browser trims optional
    // whitespace (OWS) from a header value before parsing it -- so the
    // unnormalized value would sail past this check and still be parsed as
    // text/html downstream. Lowercased for the same reason: the regex
    // literals are lowercase and MIME type/subtype tokens are case
    // insensitive (RFC 2045), so "TEXT/HTML" must match exactly as
    // "text/html" does.
    const mime = file.mime.trim().toLowerCase();
    reply.header("Content-Type", isDownloadDeniedMime(mime) ? "application/octet-stream" : mime);
    reply.header("Content-Disposition", contentDisposition("attachment", file.originalName));
    return reply.send(openBlob(dataDir, file.sha256));
  });
}
