import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { meetingCreateInputSchema, meetingUpdateInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema } from "./helpers.js";
import {
  createMeeting, getMeeting, updateMeeting, archiveMeeting, unarchiveMeeting, listMeetings,
} from "../services/meetings.js";
import { decodeOccurredAtCursor } from "../services/pagination.js";

// The record filters are NOT mutually exclusive in shape (unlike notes.ts's,
// which refuses anything but exactly one): a caller sends one in practice --
// one rail, one record -- and an unfiltered call is a valid "every meeting"
// list, the same way files.ts and events.ts treat theirs.
//
// archived is a tri-state flag on the wire ("true"/"false"/absent), not a
// free-form boolean coercion: z.coerce.boolean() would treat the literal
// string "false" as truthy (any non-empty string coerces to true), silently
// inverting the filter -- see routes/companies.ts's listQuerySchema.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function registerMeetingRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/meetings", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    // Meetings page by (occurred_at, id), so a created_at cursor minted by any
    // other list must be rejected here rather than silently paging from a
    // timestamp that means something else (pagination.ts's contract).
    if (!validateCursor(query.cursor, reply, decodeOccurredAtCursor)) return;
    return listMeetings(db, {
      companyId: query.company_id, contactId: query.contact_id,
      dealId: query.deal_id, projectId: query.project_id,
      archived: query.archived, cursor: query.cursor, limit: query.limit,
    });
  });

  app.post("/api/meetings", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(meetingCreateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      // The owner is the actor: nothing in the payload names one.
      const meeting = await createMeeting(db, user.id, input);
      return reply.code(201).send(meeting);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/meetings/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await getMeeting(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.patch("/api/meetings/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(meetingUpdateInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateMeeting(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/meetings/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveMeeting(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/meetings/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveMeeting(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
