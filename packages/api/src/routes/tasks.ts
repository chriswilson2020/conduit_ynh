import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createTaskInputSchema, updateTaskInputSchema, taskStatusSchema,
  moveTaskOnBoardInputSchema, shiftTaskInputSchema, createTaskDependencyInputSchema,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import {
  createTask, updateTask, archiveTask, unarchiveTask, listTasks, getTask,
  setTaskStatus, moveTaskOnBoard, addDependency, removeDependency, listDependencies,
} from "../services/tasks.js";
import { shiftTask } from "../services/scheduling.js";

// archived/dated/standalone are the same tri-state wire flag companies.ts's
// listQuerySchema documents: "true"/"false"/absent, not a free-form boolean
// coercion. All filters are optional and ANDed together, mirroring
// files.ts/events.ts's "unfiltered is a valid everything-list" convention --
// a task board, My Tasks, and the Gantt each ask for a different combination
// of these.
const listQuerySchema = z.object({
  project_id: z.uuid().optional(),
  standalone: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  assignee_id: z.uuid().optional(),
  status: taskStatusSchema.optional(),
  dated: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

const setStatusInputSchema = z.object({ status: taskStatusSchema });

// The successor is named by the route (:id); the predecessor is named twice
// here -- once in the POST body (createTaskDependencyInputSchema), once as
// a DELETE path param -- so this local schema only covers the DELETE shape.
const dependencyParamSchema = z.object({ id: z.uuid(), predecessorId: z.uuid() });

export function registerTaskRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/tasks", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listTasks(db, {
      projectId: query.project_id, standalone: query.standalone, assigneeId: query.assignee_id,
      status: query.status, dated: query.dated, archived: query.archived,
    });
  });

  app.post("/api/tasks", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createTaskInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const task = await createTask(db, user.id, input);
      return reply.code(201).send(task);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const task = await getTask(db, params.id);
    if (task === null) {
      return reply.code(404).send({ error: "not_found", message: `task ${params.id} not found` });
    }
    return task;
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(updateTaskInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateTask(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/tasks/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveTask(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/tasks/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveTask(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/tasks/:id/status", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(setStatusInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await setTaskStatus(db, user.id, params.id, input.status);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/tasks/:id/board-move", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(moveTaskOnBoardInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await moveTaskOnBoard(db, user.id, params.id, input);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/tasks/:id/shift", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(shiftTaskInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return await shiftTask(db, user.id, params.id, input);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // :id names the successor (the task whose scheduling depends on the named
  // predecessor) -- see services/tasks.ts's addDependency doc comment.
  app.post("/api/tasks/:id/dependencies", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(createTaskDependencyInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const dep = await addDependency(db, user.id, input.predecessorId, params.id);
      return reply.code(201).send(dep);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Idempotent, same as archive/unarchive -- removing an edge that doesn't
  // exist is a silent no-op (see services/tasks.ts's removeDependency), so
  // this always returns 204 rather than distinguishing "removed" from
  // "already gone."
  app.delete("/api/tasks/:id/dependencies/:predecessorId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(dependencyParamSchema, request.params, reply);
    if (params === undefined) return;
    await removeDependency(db, user.id, params.predecessorId, params.id);
    return reply.code(204).send();
  });

  // This task's predecessors (edges where :id is the successor) -- the task
  // drawer's dependency list (Task 8). Unlike the Gantt payload's
  // dependencies (services/scheduling.ts's ganttPayload), which only carries
  // edges between two DATED tasks, this returns every predecessor
  // regardless of either task's dates.
  app.get("/api/tasks/:id/dependencies", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await listDependencies(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
