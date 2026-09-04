import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { User } from "@conduit/shared";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { identityFromHeaders } from "./auth.js";
import { createUserResolver } from "./users.js";
import { registerSpa } from "./spa.js";
import { registerCrmRoutes } from "./routes/index.js";
import { createSmtpTransportFactory } from "./services/mail-imapflow.js";
import type { SendMailTransportFactory } from "./services/mail-send.js";
import type { MailRouteSyncManager } from "./routes/mail.js";
import {
  ReauthTickets, ReauthThrottle,
  createLdapVerifier, createFixedPasswordVerifier,
} from "./services/reauth.js";
import type { ReauthVerifier } from "./services/reauth.js";
import { IntakeSessionStore } from "./services/intake-plan.js";
import { WriteGate, isWriteMethod } from "./services/write-gate.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Database;
  /** Directory holding uploaded file blobs (see services/blobs.ts). Defaults to
   * "./data" for tests that never touch the files routes and so do not care. */
  dataDir?: string;
  /** Directory holding the built SPA. When omitted, only the API is served. */
  webRoot?: string;
  /** Test-only override for the multipart upload size cap. See registerCrmRoutes's
   * CrmRouteDeps for why this exists; never set outside a test. */
  multipartFileSizeLimit?: number;
  /**
   * The mail seams routes/mail.ts needs but this function cannot build for
   * itself: the sync manager does not exist until after the server is
   * listening (hence a getter, not a value), and how an SMTP connection is
   * configured is the composition root's decision, not this file's.
   *
   * Optional so that the many tests which build an app but never send mail
   * need not construct either. The fallbacks are the honest no-mail pair: no
   * sync engine, and a transport factory built from THIS app's config -- the
   * same expression server.ts uses, never a different source of truth.
   */
  mail?: {
    syncManager: () => MailRouteSyncManager | null;
    transportFactory: SendMailTransportFactory;
  };
  /**
   * Test-only sink for the request log, so a test can read what was written
   * rather than assume it. It exists for ONE assertion -- that POST /api/backup
   * never writes the passphrase anywhere -- and that assertion cannot be made
   * against the suite's usual apps, because logging is off entirely under
   * NODE_ENV=test. "The logger is disabled" is not a proof that a secret is
   * absent from it.
   *
   * Ignored when logging is off, which is every other test. Never set outside
   * a test, same as multipartFileSizeLimit above.
   */
  loggerStream?: { write: (line: string) => void };
  /**
   * How 7.6's re-authentication gate checks a password.
   *
   * Optional, and the fallback is built from config the same way
   * transportFactory's is -- CONDUIT_REAUTH_PASSWORD when it is set (dev and
   * CI only; config.ts refuses it in production), otherwise a real bind
   * against YunoHost's portal API. A test that wants to drive the gate passes
   * a function; a test that never touches a download passes nothing and gets
   * a verifier it never calls.
   *
   * IT IS NEVER A `() => true` DEFAULT. A seam whose default answer is "yes"
   * would make every test that forgot to set it pass a gate that is not
   * there, which is the shape of the vacuous assertion this project keeps
   * finding.
   */
  reauthVerifier?: ReauthVerifier;
  /**
   * Test-only overrides for the three 7.7 bounds that would otherwise make a
   * test upload 8GiB (twice over: the restore's preview and the two importers'
   * uploads are separate caps) or wait fifteen seconds. See CrmRouteDeps for
   * all three; never set outside a test.
   */
  restoreMaxUploadBytes?: number;
  importMaxUploadBytes?: number;
  restoreDrainTimeoutMs?: number;
}

export async function buildApp(
  {
    config, db, dataDir = "./data", webRoot, multipartFileSizeLimit, mail, loggerStream,
    reauthVerifier, restoreMaxUploadBytes, importMaxUploadBytes, restoreDrainTimeoutMs,
  }: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv === "test"
      ? false
      : { level: "info", ...(loggerStream === undefined ? {} : { stream: loggerStream }) },
    // 1, not true: the app binds to loopback and is reachable through exactly one
    // hop, YunoHost's nginx. trustProxy: 1 trusts only that single nearest hop's
    // X-Forwarded-* headers. trustProxy: true would trust an unbounded chain,
    // including any entry a client prepends itself if nginx ever appends to
    // X-Forwarded-For (e.g. via $proxy_add_x_forwarded_for) rather than overwriting
    // it -- letting a client forge the address anything downstream treats as req.ip.
    trustProxy: 1,
  });

  // Installed FIRST, before any app.register()/addHook()/route call below --
  // deliberately, not just conventionally. Fastify's boot sequencer (avvio) runs
  // an awaited `app.register(plugin)` eagerly, immediately, rather than queuing it
  // behind everything else the way a bare (unawaited) register call or a plain
  // route/hook registration is queued. Several things below this point do await a
  // register call (registerCrmRoutes's multipart plugin, registerSpa's static
  // plugin) -- if setErrorHandler were installed after those, on a request that
  // fails BEFORE reaching a route handler (e.g. this file's onRequest auth hook
  // throwing when the database is down), Fastify would fall back to its own
  // default error handler instead of this one, because the eager register call
  // had already moved the boot process past the point where a later
  // setErrorHandler takes effect for requests that were already in flight -- and
  // Fastify's default handler sends the thrown error's own .message verbatim,
  // which for a driver error can be the failing SQL and its bound parameters.
  // Installing it before any register call closes that hole for every
  // registration below, present and future, in one place. (Caught in review by
  // the combination of a database failure in the onRequest hook and webRoot set,
  // which is what makes registerSpa's awaited register() reach this path -- see
  // the regression test in app.test.ts.)
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled error");
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send(
      statusCode < 500
        ? { error: "request_error", message: error.message }
        : { error: "internal_error" },
    );
  });

  app.decorateRequest("user", null);

  // 7.7's "refuse new writes", and the two hooks that make it one mechanism
  // rather than a per-route habit. See services/write-gate.ts for why the
  // METHOD is what decides and not a list of routes.
  //
  // REGISTERED BEFORE THE AUTH HOOK BELOW, AND THAT ORDER IS LOAD-BEARING.
  // Resolving an identity WRITES to the database on a cache miss (see
  // createUserResolver); during a restore that write would block behind the
  // DROP SCHEMA's ACCESS EXCLUSIVE lock, so a gate placed after it would hang
  // exactly the requests it exists to refuse in a millisecond. The cost is that
  // an unauthenticated caller is also told a restore is running, which behind
  // SSOwat is nobody, and which is cheaper than the alternative.
  const writeGate = new WriteGate();
  app.addHook("onRequest", async (request, reply) => {
    if (!isWriteMethod(request.method)) return;
    if (writeGate.admit(request.id)) return;
    // 503 with Retry-After, which is what it is: the install is temporarily
    // unable to accept a change and will be able to again shortly.
    void reply.header("Retry-After", "30");
    return reply.code(503).send({
      error: "restore_in_progress",
      message: writeGate.reason
        ?? "this install is not accepting changes at the moment; try again shortly",
    });
  });
  // BOTH, because neither covers the other: `onResponse` runs when a response
  // has been sent, and `onRequestAbort` is the only hook a client that hangs up
  // on a real socket reaches. `finish` is idempotent, so a request that reaches
  // both -- or that was refused above and never admitted -- costs nothing.
  //
  // WHICH OF THEM THE SUITE ACTUALLY EXERCISES, MEASURED RATHER THAN ASSUMED,
  // because a leak here would refuse every later restore with "requests were
  // still writing" and that was the first suspect in a red CI run. Against
  // Fastify 5 with an in-process injection whose payload stream is destroyed
  // mid-body: onRequest, the raw `close`, onResponse and onError all fire, and
  // `onRequestAbort` does NOT. So the count comes back on that path through
  // onResponse, and the second hook is here for the socket the suite cannot
  // produce rather than for anything a test covers.
  //
  // routes/restore.test.ts's "does not go on counting an upload the client
  // abandoned" is what holds the property, and it is an instrument rather than
  // a hope: removing the line below makes it fail.
  app.addHook("onResponse", async (request) => { writeGate.finish(request.id); });
  app.addHook("onRequestAbort", async (request) => { writeGate.finish(request.id); });

  // Built here rather than inside registerCrmRoutes for the reason the ticket
  // store is: it has to be the same map across two requests. Closed on shutdown
  // by the onClose hook below.
  const intakeSessions = new IntakeSessionStore();

  // One resolver per app instance, so its cache lives as long as the process.
  // Without it every request would write a row — see createUserResolver.
  const users = createUserResolver(db);

  // Routes that must work without identity resolution. /api/health has to stay
  // answerable when the database is down, and resolving a user writes to it on a
  // cache miss (see createUserResolver) — that write would throw here, inside the
  // hook, before the route's own try/catch around its read-only probe ever runs.
  const UNAUTHENTICATED_ROUTES = new Set(["/api/health"]);

  app.addHook("onRequest", async (request, reply) => {
    // routeOptions.url is the matched route's registered pattern (e.g. "/api/health"),
    // populated because onRequest runs after routing -- not request.url, which is the
    // raw path. It is undefined when no route matched. Those requests are served by
    // the not-found handler -- either the SPA shell or a JSON 404 -- and neither reads
    // request.user. Resolving identity here would write to the database on a cache
    // miss (see createUserResolver), so a deep link would 500 during a database
    // outage instead of serving the static shell that exists to report the outage.
    const matched = request.routeOptions.url;
    if (matched === undefined || UNAUTHENTICATED_ROUTES.has(matched)) return;
    const identity = identityFromHeaders(request.headers, config.devUser);
    if (identity === null) {
      request.user = null;
      return;
    }
    // WHILE A RESTORE IS RUNNING, RESOLVING AN IDENTITY MAY NOT WRITE, and this
    // is the hole the gate above cannot see: `resolve` is an UPSERT, so a plain
    // GET from a username this process has not met INSERTS a users row. The
    // method says the request is safe and it is not.
    //
    // IT IS NOT A RACE THAT A SMALL WINDOW MAKES UNLIKELY -- that was the first
    // version of this reasoning and it was measured false. PostgreSQL QUEUES a
    // write blocked by the restore's `DROP SCHEMA` lock and releases it at
    // COMMIT, so the insert is DELIVERED INTO the restored data rather than
    // having to arrive in some narrow gap. Measured on two scratch installs
    // with ordinary reads from fresh identities every 3ms: 79 rows landed, and
    // the row count check that follows the load then told the operator their
    // successful restore had gone wrong, at the loudest volume this product
    // has, with mail.key left unreplaced.
    //
    // SO A CACHE MISS IS REFUSED RATHER THAN RESOLVED. A username this process
    // has never seen is, during a restore, an identity the restored database
    // will not have either -- refusing it is the honest answer and not a
    // workaround. `cached` never writes and deliberately ignores the TTL, so
    // the operator watching a restore that runs longer than a minute is not
    // evicted from their own page. See UserResolver.cached.
    if (writeGate.refusing) {
      const known = users.cached(identity);
      if (known === null) {
        void reply.header("Retry-After", "30");
        return reply.code(503).send({
          error: "restore_in_progress",
          message: writeGate.reason
            ?? "this install is not accepting new sessions at the moment; try again shortly",
        });
      }
      request.user = known;
      return;
    }
    request.user = await users.resolve(identity);
  });

  app.get("/api/health", async (request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      // A health endpoint has to stay readable when the thing it reports on is
      // broken. 503 so uptime monitoring treats it as down, but with the app's own
      // response shape rather than the driver's error text, which could leak
      // connection details. The underlying error still has to reach the journal,
      // so it's logged here even though it no longer reaches the client.
      request.log.error({ err: error }, "health check: database unreachable");
      return reply.code(503).send({
        status: "degraded",
        version: config.version,
        database: "disconnected",
      });
    }
    return { status: "ok", version: config.version, database: "connected" };
  });

  app.get("/api/me", async (request, reply) => {
    if (request.user === null) {
      return reply.code(401).send({
        error: "unauthenticated",
        message: "No Ynh-User header was present on this request",
      });
    }
    return { user: request.user };
  });

  await registerCrmRoutes(app, {
    db, dataDir, multipartFileSizeLimit,
    defaultCurrency: config.defaultCurrency, appVersion: config.version,
    basePath: config.basePath, mailKeyPath: config.mailKeyPath,
    databaseUrl: config.databaseUrl,
    syncManager: mail?.syncManager ?? (() => null),
    transportFactory: mail?.transportFactory
      ?? createSmtpTransportFactory({ rejectUnauthorized: config.mailTlsRejectUnauthorized }),
    reauthVerifier: reauthVerifier ?? (
      config.reauthPassword === null
        ? createLdapVerifier(config.ldapUrl)
        : createFixedPasswordVerifier(config.reauthPassword)
    ),
    // ONE INSTANCE EACH, PER APP, and that is what makes the gate work at all:
    // the ticket POST /api/reauth mints has to be the ticket the export and
    // backup routes look up, and the throttle has to remember across requests.
    // Building them inside registerCrmRoutes would be one per registration,
    // which is the same thing here and would stop being so the moment anything
    // registered the routes twice.
    reauthTickets: new ReauthTickets(),
    reauthThrottle: new ReauthThrottle(),
    // ONE PER APP, for the reason the two above are: the plan id that
    // POST /api/restore/inspect returns has to resolve in
    // POST /api/restore/apply, and a store built inside a register call would
    // be a different map on every registration.
    intakeSessions,
    writeGate,
    restoreMaxUploadBytes,
    importMaxUploadBytes,
    restoreDrainTimeoutMs,
  });

  // WHAT A SHUTDOWN MUST NOT LEAVE BEHIND. A held session is a DECRYPTED backup
  // in $data_dir -- mail.key in the clear -- and the store's own `close`
  // disposes of the in-flight ones as well as the waiting ones, which is what
  // makes a shutdown during a restore leave nothing readable on the disk. It
  // also stops the sweep timer, so a test that builds twenty apps does not
  // leave twenty intervals behind.
  app.addHook("onClose", async () => { await intakeSessions.close(); });

  if (webRoot === undefined) {
    app.setNotFoundHandler(async (request, reply) => {
      return reply.code(404).send({
        error: "not_found",
        message: `No route for ${request.method} ${request.url}`,
      });
    });
  } else {
    await registerSpa(app, { webRoot, basePath: config.basePath });
  }

  return app;
}
