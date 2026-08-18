import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import { saveBlob, openBlob } from "../services/blobs.js";
import { attachFile, listFiles, getFile } from "../services/files.js";

// company_id/contact_id are optional filters here, not the required XOR
// notes.ts enforces on its list: unlike a note, "list files" has a sensible
// unfiltered meaning (no filter applied), so an absent filter is a no-op, not a
// client error.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
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
    // companyId/contactId before the file field for this to see them.
    const rawCompanyId = fieldValue(part.fields.companyId);
    const rawContactId = fieldValue(part.fields.contactId);
    const companyId = rawCompanyId !== undefined && uuidSchema.safeParse(rawCompanyId).success ? rawCompanyId : undefined;
    const contactId = rawContactId !== undefined && uuidSchema.safeParse(rawContactId).success ? rawContactId : undefined;
    if ((rawCompanyId !== undefined) === (rawContactId !== undefined) || (companyId === undefined && contactId === undefined)) {
      part.file.resume();
      return reply.code(400).send({ error: "validation", message: "exactly one of companyId or contactId is required" });
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
        originalName: part.filename, mime: part.mimetype, sizeBytes, sha256, companyId, contactId,
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
    return listFiles(db, { companyId: query.company_id, contactId: query.contact_id });
  });

  app.get("/api/files/:id/download", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const file = await getFile(db, params.id);
    if (file === null) {
      return reply.code(404).send({ error: "not_found", message: `file ${params.id} not found` });
    }
    // Strip CR/LF (header-injection) and quotes (would terminate the quoted-string
    // early) from the stored name before it goes into a response header.
    const filename = file.originalName.replace(/[\r\n"]/g, "");
    reply.header("Content-Type", file.mime);
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.send(openBlob(dataDir, file.sha256));
  });
}
