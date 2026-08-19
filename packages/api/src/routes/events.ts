import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, parseOrReject, validateCursor } from "./helpers.js";
import { listEvents } from "../services/timeline.js";

// Same choice as files.ts: company_id/contact_id/deal_id/task_id/project_id
// are optional filters, not a required exactly-one -- an unfiltered timeline
// is a valid request. task_id/project_id (Phase 3 Task 6) let the task
// drawer's rail and a project's own timeline filter down the same way.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  task_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function registerEventRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/events", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    if (!validateCursor(query.cursor, reply)) return;
    return listEvents(db, {
      companyId: query.company_id, contactId: query.contact_id, dealId: query.deal_id,
      taskId: query.task_id, projectId: query.project_id,
      cursor: query.cursor, limit: query.limit,
    });
  });
}
