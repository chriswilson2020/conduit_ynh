import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../db/client.js";
import type { SendMailTransportFactory } from "../services/mail-send.js";
import type { MailRouteSyncManager } from "./mail.js";
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
import { registerProjectRoutes } from "./projects.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerGanttRoutes } from "./gantt.js";
import { registerMailRoutes } from "./mail.js";

export { mapDomainError, requireUser } from "./helpers.js";

export interface CrmRouteDeps {
  db: Database;
  /** Directory holding uploaded file blobs (see services/blobs.ts). */
  dataDir: string;
  /** Test-only override for the multipart file-size cap, so a 413-path test can
   * upload a few KB instead of 50MB. Defaults to 50MB in production -- the
   * same ceiling mail-send.ts's MAX_FORWARD_ATTACHMENT_BYTES applies to a
   * forward's re-attached originals (which never pass through this plugin);
   * change the two together. */
  multipartFileSizeLimit?: number;
  /** Applied by deals.ts's POST /api/deals when the caller omits a currency --
   * threaded straight from config.defaultCurrency (see config.ts). */
  defaultCurrency: string;
  /**
   * Public path this app is mounted at, without a trailing slash ("/" for a
   * root deployment) -- config.basePath, threaded straight through.
   * routes/mail.ts resolves stored `mailattachment:` placeholders against it
   * on every body-serving response (see mail-content.ts's
   * resolveAttachmentUrls), which is what keeps stored HTML portable across a
   * `yunohost app change_url`.
   */
  basePath: string;
  /** Threaded straight from config.mailKeyPath (see config.ts) for
   * routes/mail.ts to pass into mail-accounts.ts's service calls. */
  mailKeyPath: string;
  /**
   * The live sync engine, fetched at REQUEST time rather than captured at
   * registration time -- routes are registered while the HTTP server is still
   * booting and the manager is only started after it is listening (see
   * server.ts), so a value here would always be the null it had then.
   *
   * Returning null is an ordinary, supported answer, not a failure: sync is
   * off under NODE_ENV=test and in any deployment without an adapter, and
   * all three consumers (mail-send's Sent-folder APPEND, the thread-read
   * route's `\Seen` write-back, the accounts list's sync stats) treat "no
   * manager" and "no sync for this account" the same best-effort way.
   */
  syncManager: () => MailRouteSyncManager | null;
  /**
   * Builds an SMTP transport for one send. Supplied by the composition root
   * (server.ts) from parsed config, so nothing under routes/ or services/
   * decides how a connection is configured -- see
   * mail-imapflow.ts's createSmtpTransportFactory.
   */
  transportFactory: SendMailTransportFactory;
}

/**
 * Wires the hardened CRM/PM services (plus the plain user listing) into HTTP:
 * companies, contacts, notes, files, events, search, pipelines/deals (Phase
 * 2), projects/tasks/gantt (Phase 3), and mail (Phase 4). Registered after
 * /api/health and /api/me and before the not-found/SPA branch,
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
  registerProjectRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerGanttRoutes(app, deps);
  registerMailRoutes(app, deps);
}
