import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createProjectInputSchema, updateProjectInputSchema, projectStatusSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import {
  createProject, updateProject, archiveProject, unarchiveProject, listProjects, getProject,
} from "../services/projects.js";
import { ganttPayload } from "../services/scheduling.js";

// archived is the same tri-state wire flag companies.ts's listQuerySchema
// documents: "true"/"false"/absent, not a free-form boolean coercion.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  status: projectStatusSchema.optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

export function registerProjectRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/projects", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listProjects(db, { companyId: query.company_id, status: query.status, archived: query.archived });
  });

  app.post("/api/projects", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createProjectInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const project = await createProject(db, user.id, input);
      return reply.code(201).send(project);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/projects/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const project = await getProject(db, params.id);
    if (project === null) {
      return reply.code(404).send({ error: "not_found", message: `project ${params.id} not found` });
    }
    return project;
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateProjectInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateProject(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/projects/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveProject(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/projects/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveProject(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Project-form ganttPayload (scheduling.ts's Task 5 work). Existence is
  // checked explicitly first: ganttPayload itself has no way to distinguish
  // "project exists but has no dated tasks yet" from "project doesn't exist"
  // -- both run the same WHERE projectId = ... query and come back with zero
  // rows, so this 404s the same way GET /api/projects/:id already does.
  app.get("/api/projects/:id/gantt", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const project = await getProject(db, params.id);
    if (project === null) {
      return reply.code(404).send({ error: "not_found", message: `project ${params.id} not found` });
    }
    return ganttPayload(db, { projectId: params.id });
  });
}
