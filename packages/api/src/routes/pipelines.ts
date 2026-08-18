import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPipelineInputSchema, updatePipelineInputSchema,
  createStageInputSchema, updateStageInputSchema,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import {
  createPipeline, updatePipeline, archivePipeline, unarchivePipeline, listPipelines, getPipeline,
  createStage, updateStage, reorderStage,
} from "../services/pipelines.js";
import { funnel } from "../services/deals.js";

// archived is the same tri-state wire flag companies.ts's listQuerySchema
// documents: "true"/"false"/absent, not a free-form boolean coercion.
const listQuerySchema = z.object({
  scope: z.enum(["global", "company"]).optional(),
  company_id: z.uuid().optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

const stageIdParamSchema = z.object({ id: z.uuid(), stageId: z.uuid() });

const reorderStageInputSchema = z.object({
  beforeStageId: z.uuid().optional(),
  afterStageId: z.uuid().optional(),
});

export function registerPipelineRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/pipelines", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listPipelines(db, { scope: query.scope, companyId: query.company_id, archived: query.archived });
  });

  app.post("/api/pipelines", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createPipelineInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const pipeline = await createPipeline(db, user.id, input);
      return reply.code(201).send(pipeline);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Composite { pipeline, stages } response -- see pipelineWithStagesSchema's
  // doc comment in @conduit/shared for why getPipeline returns the bundle
  // rather than the bare pipeline row.
  app.get("/api/pipelines/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const result = await getPipeline(db, params.id);
    if (result === null) {
      return reply.code(404).send({ error: "not_found", message: `pipeline ${params.id} not found` });
    }
    return result;
  });

  app.patch("/api/pipelines/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updatePipelineInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updatePipeline(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/pipelines/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archivePipeline(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/pipelines/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchivePipeline(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/pipelines/:id/stages", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(createStageInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const stage = await createStage(db, user.id, params.id, input);
      return reply.code(201).send(stage);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.patch("/api/pipelines/:id/stages/:stageId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(stageIdParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateStageInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateStage(db, user.id, params.stageId, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/pipelines/:id/stages/:stageId/reorder", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(stageIdParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(reorderStageInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await reorderStage(db, user.id, params.stageId, input);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Lives here rather than deals.ts: it is addressed under /api/pipelines/:id/
  // like the rest of this file's routes, even though the funnel() query itself
  // is implemented in services/deals.ts (it groups over deals, not pipelines).
  app.get("/api/pipelines/:id/funnel", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const pipeline = await getPipeline(db, params.id);
    if (pipeline === null) {
      return reply.code(404).send({ error: "not_found", message: `pipeline ${params.id} not found` });
    }
    return funnel(db, params.id);
  });
}
