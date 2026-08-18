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
import { registerStreamRoutes } from "./stream.js";
import { registerPipelineRoutes } from "./pipelines.js";
import { registerDealRoutes } from "./deals.js";

export { mapDomainError, requireUser } from "./helpers.js";

export interface CrmRouteDeps {
  db: Database;
  /** Directory holding uploaded file blobs (see services/blobs.ts). */
  dataDir: string;
  /** Test-only override for the multipart file-size cap, so a 413-path test can
   * upload a few KB instead of 50MB. Defaults to 50MB in production. */
  multipartFileSizeLimit?: number;
  /** Applied by deals.ts's POST /api/deals when the caller omits a currency --
   * threaded straight from config.defaultCurrency (see config.ts). */
  defaultCurrency: string;
}

/**
 * Wires the six hardened CRM services (plus the plain user listing) into HTTP.
 * Registered after /api/health and /api/me and before the not-found/SPA branch,
 * so it inherits the same onRequest auth hook without having to repeat it.
 *
 * Awaiting app.register() here is safe (and the orthodox way to do it) only
 * because app.ts installs setErrorHandler before calling this function -- see
 * the comment on that call in app.ts for why the ordering matters.
 */
export async function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: deps.multipartFileSizeLimit ?? 50 * 1024 * 1024,
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
  registerStreamRoutes(app, deps);
  registerPipelineRoutes(app, deps);
  registerDealRoutes(app, deps);
}
