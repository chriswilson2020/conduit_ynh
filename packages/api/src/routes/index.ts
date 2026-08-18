import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../db/client.js";
import { registerCompanyRoutes } from "./companies.js";
import { registerContactRoutes } from "./contacts.js";
import { registerNoteRoutes } from "./notes.js";
import { registerFileRoutes } from "./files.js";
import { registerEventRoutes } from "./events.js";
import { registerUserRoutes } from "./users.js";
import { registerSearchRoutes } from "./search.js";

export { mapDomainError, requireUser } from "./helpers.js";

export interface CrmRouteDeps {
  db: Database;
  /** Directory holding uploaded file blobs (see services/blobs.ts). */
  dataDir: string;
}

/**
 * Wires the six hardened CRM services (plus the plain user listing) into HTTP.
 * Registered after /api/health and /api/me and before the not-found/SPA branch,
 * so it inherits the same onRequest auth hook without having to repeat it.
 *
 * The multipart plugin is registered WITHOUT awaiting app.register()'s own
 * promise, deliberately. Awaiting it here would make avvio (Fastify's boot
 * sequencer) load that plugin eagerly, out of the normal queued order, ahead of
 * anything the caller (app.ts) still queues afterward -- e.g. its setErrorHandler
 * call, registered later, would end up appended after avvio already began (or
 * finished) a boot pass and stop being treated as the top-level handler,
 * silently falling back to Fastify's default error responses for routes that
 * never explicitly reply themselves (like the onRequest auth hook's own
 * failures). This function still returns a Promise (per its signature) for a
 * consistent call site in app.ts, but nothing inside it needs to be awaited:
 * Fastify guarantees every queued registration -- awaited or not -- finishes
 * before any route handler runs.
 */
export async function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): Promise<void> {
  void app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
    },
  });

  registerCompanyRoutes(app, deps);
  registerContactRoutes(app, deps);
  registerNoteRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerSearchRoutes(app, deps);
}
