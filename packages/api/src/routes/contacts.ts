import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createContactInputSchema, updateContactInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema } from "./helpers.js";
import {
  createContact, updateContact, archiveContact, unarchiveContact, listContacts, getContact,
} from "../services/contacts.js";

// See companies.ts's listQuerySchema for why `archived` is an explicit
// "true"/"false" enum rather than z.coerce.boolean().
const listQuerySchema = z.object({
  q: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  company_id: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function registerContactRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/contacts", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    if (!validateCursor(query.cursor, reply)) return;
    return listContacts(db, {
      q: query.q, archived: query.archived, companyId: query.company_id,
      cursor: query.cursor, limit: query.limit,
    });
  });

  app.post("/api/contacts", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createContactInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const contact = await createContact(db, user.id, input);
      return reply.code(201).send(contact);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/contacts/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const contact = await getContact(db, params.id);
    if (contact === null) {
      return reply.code(404).send({ error: "not_found", message: `contact ${params.id} not found` });
    }
    return contact;
  });

  app.patch("/api/contacts/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateContactInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateContact(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/contacts/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveContact(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/contacts/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveContact(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
