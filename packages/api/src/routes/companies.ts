import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createCompanyInputSchema, updateCompanyInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema } from "./helpers.js";
import {
  createCompany, updateCompany, archiveCompany, unarchiveCompany, listCompanies, getCompany,
} from "../services/companies.js";

// archived is a tri-state flag on the wire ("true"/"false"/absent), not a free-form
// boolean coercion: z.coerce.boolean() would treat the literal string "false" as
// truthy (any non-empty string coerces to true), silently inverting the filter.
const listQuerySchema = z.object({
  q: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function registerCompanyRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/companies", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    if (!validateCursor(query.cursor, reply)) return;
    return listCompanies(db, query);
  });

  app.post("/api/companies", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createCompanyInputSchema, request.body, reply);
    if (input === undefined) return;
    const company = await createCompany(db, user.id, input);
    return reply.code(201).send(company);
  });

  app.get("/api/companies/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const company = await getCompany(db, params.id);
    if (company === null) {
      return reply.code(404).send({ error: "not_found", message: `company ${params.id} not found` });
    }
    return company;
  });

  app.patch("/api/companies/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateCompanyInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateCompany(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/companies/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveCompany(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/companies/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveCompany(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
