import type { FastifyInstance } from "fastify";
import type { CrmRouteDeps } from "./index.js";
import { requireUser } from "./helpers.js";
import { ganttPayload } from "../services/scheduling.js";

/**
 * The global form of scheduling.ts's ganttPayload: every dated, unarchived
 * task across every project plus the standalone pool, grouped by project (see
 * ganttPayload's own ORDER BY comment). The per-project form lives at
 * GET /api/projects/:id/gantt instead (routes/projects.ts) since it needs the
 * project's own existence check first -- this route has no such id to check.
 */
export function registerGanttRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/gantt", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    return ganttPayload(db, { global: true });
  });
}
