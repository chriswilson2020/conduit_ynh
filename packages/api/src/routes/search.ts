import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, parseOrReject } from "./helpers.js";
import { search } from "../services/search.js";

const querySchema = z.object({ q: z.string().optional() });

export function registerSearchRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/search", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(querySchema, request.query, reply);
    if (query === undefined) return;
    // Whitespace-only q is treated the same as absent: return empty groups without
    // touching the database, rather than running three ILIKE '%%' scans that would
    // match everything up to LIMIT_PER_TYPE.
    const q = query.q?.trim() ?? "";
    if (q === "") return { companies: [], contacts: [], notes: [] };
    return search(db, q);
  });
}
