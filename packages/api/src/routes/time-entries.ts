import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { timeEntryCreateInputSchema, timeEntryUpdateInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, validateCursor, idParamSchema } from "./helpers.js";
import {
  createTimeEntry, getTimeEntry, updateTimeEntry, archiveTimeEntry, unarchiveTimeEntry,
  listTimeEntries,
} from "../services/time-entries.js";
import { decodeWorkDateCursor } from "../services/pagination.js";

// The five record filters are NOT mutually exclusive in shape (unlike notes.ts's,
// which refuses anything but exactly one): a caller sends one in practice -- one
// rail, one record -- and an unfiltered call is a valid "every entry" list,
// which is what the timesheet asks for.
//
// `from`/`to` are ISO dates, matched by z.iso.date() rather than coerced: a
// coercion would accept "2026-09" and a Date-shaped string and page from
// something the column is not. They are inclusive both ends -- see
// listTimeEntries.
//
// archived is a tri-state flag on the wire ("true"/"false"/absent), not a
// free-form boolean coercion: z.coerce.boolean() treats the literal string
// "false" as truthy (any non-empty string coerces to true) and would silently
// invert the filter -- see routes/companies.ts's listQuerySchema.
const listQuerySchema = z.object({
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  task_id: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  archived: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function registerTimeEntryRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/time-entries", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    // Time entries page by (work_date, id), so a created_at or occurred_at
    // cursor minted by any other list must be rejected here rather than paging
    // from a value that is not even the same kind of thing (pagination.ts's
    // contract, and its WorkDateCursor comment).
    if (!validateCursor(query.cursor, reply, decodeWorkDateCursor)) return;
    return listTimeEntries(db, {
      companyId: query.company_id, contactId: query.contact_id,
      dealId: query.deal_id, projectId: query.project_id, taskId: query.task_id,
      from: query.from, to: query.to,
      archived: query.archived, cursor: query.cursor, limit: query.limit,
    });
  });

  app.post("/api/time-entries", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    // A body with no link at all is a 400 here, from
    // timeEntryCreateInputSchema's superRefine, and never a 500 from the
    // time_entries_has_link CHECK. `billable` is required by the same schema:
    // an omitted flag is a 400 naming the field rather than a row carrying an
    // answer nobody gave.
    const input = parseOrReject(timeEntryCreateInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      // The owner is the actor: nothing in the payload names one.
      const entry = await createTimeEntry(db, user.id, input);
      return reply.code(201).send(entry);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.get("/api/time-entries/:id", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await getTimeEntry(db, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // 409 `conflict` for a patch that would leave the entry linked to nothing --
  // the one refusal here a client has to act on rather than retry, and the
  // message says what to do about it (set another link, or archive).
  app.patch("/api/time-entries/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const patch = parseOrReject(timeEntryUpdateInputSchema, request.body, reply);
    if (patch === undefined) return;
    try {
      return await updateTimeEntry(db, user.id, params.id, patch);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // ARCHIVE IS THE ONLY WAY AN HOUR LEAVES A TOTAL -- there is no DELETE here,
  // and there is none anywhere in this API. See setArchived in
  // services/time-entries.ts for why an entry cannot simply be corrected to
  // zero instead.
  app.post("/api/time-entries/:id/archive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await archiveTimeEntry(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  app.post("/api/time-entries/:id/unarchive", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await unarchiveTimeEntry(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
