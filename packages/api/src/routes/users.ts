import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import type { CrmRouteDeps } from "./index.js";
import { requireUser } from "./helpers.js";
import { users } from "../db/schema.js";

/**
 * A plain listing, not a hardened service: there is no create/update/archive
 * behaviour here, just the rows needed to populate an owner picker in the UI.
 */
export function registerUserRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/users", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const rows = await db
      .select({ id: users.id, username: users.username, fullName: users.fullName })
      .from(users)
      .orderBy(asc(users.username));
    return { users: rows };
  });
}
