import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createNoteInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject } from "./helpers.js";
import { createNote, listNotes } from "../services/notes.js";

// Unlike files.ts/events.ts (an unfiltered call there is a valid "everything"
// list), notes has no such list: a note only exists attached to a company,
// contact, or (since Task 7) a deal, so a request naming zero or more than one
// of the three is a client error, not an empty-filter no-op.
const listQuerySchema = z
  .object({ company_id: z.uuid().optional(), contact_id: z.uuid().optional(), deal_id: z.uuid().optional() })
  .refine((v) => [v.company_id, v.contact_id, v.deal_id].filter((x) => x !== undefined).length === 1, {
    message: "exactly one of company_id, contact_id or deal_id is required",
  });

export function registerNoteRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/notes", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(listQuerySchema, request.query, reply);
    if (query === undefined) return;
    return listNotes(db, { companyId: query.company_id, contactId: query.contact_id, dealId: query.deal_id });
  });

  app.post("/api/notes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const input = parseOrReject(createNoteInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      const note = await createNote(db, user.id, input);
      return reply.code(201).send(note);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
