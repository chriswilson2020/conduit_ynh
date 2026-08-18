import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createDealInputSchema, updateDealInputSchema, moveDealInputSchema, dealStatusSchema,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import {
  createDeal, updateDeal, archiveDeal, unarchiveDeal, listDeals, getDeal,
  moveDeal, winDeal, loseDeal, reopenDeal,
} from "../services/deals.js";

// pipeline_id is REQUIRED, unlike the optional company_id/contact_id filters
// files.ts/events.ts accept: listDeals has no unfiltered "everything" meaning
// (see services/deals.ts's listDeals doc comment -- a kanban board always
// renders exactly one pipeline's columns), so a request naming none is a
// client error, the same way notes.ts's listQuerySchema treats its XOR.
const listQuerySchema = z.object({
  pipeline_id: z.uuid(),
  stage_id: z.uuid().optional(),
  status: dealStatusSchema.optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

const loseDealInputSchema = z.object({ reason: z.string().min(1) });

export function registerDealRoutes(app: FastifyInstance, { db, defaultCurrency }: CrmRouteDeps): void {
  app.get("/api/deals", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listDeals(db, {
      pipelineId: query.pipeline_id, stageId: query.stage_id,
      status: query.status, archived: query.archived,
    });
  });

  app.post("/api/deals", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createDealInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const deal = await createDeal(db, user.id, input, defaultCurrency);
      return reply.code(201).send(deal);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/deals/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const deal = await getDeal(db, params.id);
    if (deal === null) {
      return reply.code(404).send({ error: "not_found", message: `deal ${params.id} not found` });
    }
    return deal;
  });

  app.patch("/api/deals/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateDealInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateDeal(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveDeal(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveDeal(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/move", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(moveDealInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await moveDeal(db, user.id, params.id, input);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/win", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await winDeal(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/lose", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(loseDealInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await loseDeal(db, user.id, params.id, input.reason);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/deals/:id/reopen", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await reopenDeal(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
