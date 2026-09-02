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
import { registerMeetingRoutes } from "./meetings.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerExportRoutes } from "./export.js";
import { registerBackupRoutes } from "./backup.js";
import { registerReauthRoutes } from "./reauth.js";
import { registerRestoreRoutes } from "./restore.js";
import { registerImportRoutes } from "./import.js";
import type { ReauthTickets, ReauthThrottle, ReauthVerifier } from "../services/reauth.js";
import type { IntakeSessionStore } from "../services/intake-plan.js";
import type { WriteGate } from "../services/write-gate.js";

export { mapDomainError, requireUser } from "./helpers.js";

export interface CrmRouteDeps {
  db: Database;
  /** Directory holding uploaded file blobs (see services/blobs.ts). */
  dataDir: string;
  /** Test-only override for the multipart file-size cap, so a 413-path test can
   * upload a few KB instead of 50MB. Defaults to 50MB in production -- one
   * ceiling spelled in THREE places: here, mail-send.ts's
   * MAX_FORWARD_ATTACHMENT_BYTES (a forward's re-attached originals, which
   * never pass through this plugin), and mail-ingest.ts's
   * MAX_ATTACHMENT_BYTES (inbound parts, the bound that actually limits
   * stored attachment size today). Change the three together. */
  multipartFileSizeLimit?: number;
  /** Applied by deals.ts's POST /api/deals when the caller omits a currency --
   * threaded straight from config.defaultCurrency (see config.ts). */
  defaultCurrency: string;
  /**
   * The running app's version, threaded straight from config.version
   * (APP_VERSION). Recorded in the manifest.json of BOTH 7.6 archives -- the
   * export's and the backup's -- so an archive found on a disk in two years
   * says which Conduit wrote it. See services/export.ts and services/backup.ts.
   */
  appVersion: string;
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
   * routes/mail.ts to pass into mail-accounts.ts's service calls, and for
   * routes/backup.ts, which archives the key file itself -- a backup without
   * it restores an install that cannot decrypt a single mail password. */
  mailKeyPath: string;
  /**
   * config.databaseUrl, threaded straight through for routes/backup.ts to hand
   * to pg_dump. THE ONLY CONSUMER, and the only one that should be: every
   * other route talks to the database through `db`, which is the pool built
   * from this string at the composition root. This is here because pg_dump is
   * a separate process that has to be told where to connect, and
   * services/backup.ts splits it into libpq environment variables rather than
   * passing it on a command line where the password would be world-readable.
   */
  databaseUrl: string;
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
  /**
   * How a password is checked, supplied by the composition root the same way
   * transportFactory is -- production binds against YunoHost's portal API,
   * a test hands in a function. See services/reauth.ts for why 7.6's two
   * downloads need this at all.
   */
  reauthVerifier: ReauthVerifier;
  /**
   * The outstanding single-use tickets a successful check mints. ONE INSTANCE
   * PER APP, which is what makes a ticket issued by POST /api/reauth
   * redeemable by the export and backup routes: three modules, one map.
   */
  reauthTickets: ReauthTickets;
  /**
   * The wrong-password counter. Also one instance per app, and also not
   * optional: nothing upstream throttles these (see ReauthThrottle), so
   * without it /api/reauth would be an unmetered guessing oracle for the
   * server's own account password.
   */
  reauthThrottle: ReauthThrottle;
  /**
   * Where an uploaded backup's plan waits while a person looks at it. ONE
   * INSTANCE PER APP, for the same reason the ticket store is: the id returned
   * by POST /api/restore/inspect has to resolve in POST /api/restore/apply, and
   * a store built inside a register call would be a new one each time. What it
   * holds is a DECRYPTED backup on disk, so app.ts also closes it on shutdown.
   */
  intakeSessions: IntakeSessionStore;
  /**
   * The "refuse new writes" half of the restore's step 5. One instance per app,
   * shared by the onRequest hook that refuses and the apply route that closes
   * it -- see services/write-gate.ts.
   */
  writeGate: WriteGate;
  /**
   * Test-only override for the restore upload's size cap, so a 413-path test
   * can upload a few KB rather than 8GiB. Defaults to
   * DEFAULT_MAX_UPLOAD_BYTES. Same precedent, and the same warning, as
   * multipartFileSizeLimit above: never set outside a test.
   */
  restoreMaxUploadBytes?: number;
  /**
   * Test-only override for the import uploads' size cap, so a 413-path test can
   * upload a few KB rather than 8GiB. Defaults to DEFAULT_MAX_UPLOAD_BYTES.
   * Same precedent, and the same warning, as multipartFileSizeLimit and
   * restoreMaxUploadBytes above: never set outside a test.
   */
  importMaxUploadBytes?: number;
  /**
   * Test-only override for how long a restore waits for in-flight writes to
   * finish before refusing to start. Defaults to
   * DEFAULT_DRAIN_TIMEOUT_MS. Exists so the timeout path can be proved without
   * holding a suite open for fifteen seconds; never set outside a test.
   */
  restoreDrainTimeoutMs?: number;
}

/**
 * Wires the hardened CRM/PM services (plus the plain user listing) into HTTP:
 * companies, contacts, notes, files, events, search, pipelines/deals (Phase
 * 2), projects/tasks/gantt (Phase 3), mail (Phase 4), meetings (Phase 5),
 * documents plus the issuer profile (Phase 7), the data export, the encrypted
 * backup, its pre-flight and the re-authentication that gates both downloads
 * (Phase 7.6), and the restore's upload/preview/apply family and the two
 * importers' (Phase 7.7).
 *
 * THIS LIST IS EXHAUSTIVE BY CONSTRUCTION -- it is the register calls below,
 * in words -- so a family added without a line here is a list that has started
 * lying. The re-auth family was exactly that until a review found it.
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
  registerProjectRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerGanttRoutes(app, deps);
  registerMailRoutes(app, deps);
  registerMeetingRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerExportRoutes(app, deps);
  registerBackupRoutes(app, deps);
  registerReauthRoutes(app, deps);
  registerRestoreRoutes(app, deps);
  registerImportRoutes(app, deps);
}
