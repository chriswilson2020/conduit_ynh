import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { User } from "@conduit/shared";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { identityFromHeaders } from "./auth.js";
import { createUserResolver } from "./users.js";
import { registerSpa } from "./spa.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Database;
  /** Directory holding the built SPA. When omitted, only the API is served. */
  webRoot?: string;
}

export async function buildApp({ config, db, webRoot }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : { level: "info" },
    // 1, not true: the app binds to loopback and is reachable through exactly one
    // hop, YunoHost's nginx. trustProxy: 1 trusts only that single nearest hop's
    // X-Forwarded-* headers. trustProxy: true would trust an unbounded chain,
    // including any entry a client prepends itself if nginx ever appends to
    // X-Forwarded-For (e.g. via $proxy_add_x_forwarded_for) rather than overwriting
    // it -- letting a client forge the address anything downstream treats as req.ip.
    trustProxy: 1,
  });

  app.decorateRequest("user", null);

  // One resolver per app instance, so its cache lives as long as the process.
  // Without it every request would write a row — see createUserResolver.
  const users = createUserResolver(db);

  // Routes that must work without identity resolution. /api/health has to stay
  // answerable when the database is down, and resolving a user writes to it on a
  // cache miss (see createUserResolver) — that write would throw here, inside the
  // hook, before the route's own try/catch around its read-only probe ever runs.
  const UNAUTHENTICATED_ROUTES = new Set(["/api/health"]);

  app.addHook("onRequest", async (request) => {
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
    request.user = identity === null ? null : await users.resolve(identity);
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

  // Catches anything thrown rather than explicitly replied to — e.g. a database
  // failure during /api/me's own onRequest resolve, or any future route that
  // doesn't wrap its own errors. Without this, Fastify's default handler sends the
  // thrown error's own message to the client, which for a driver error can be
  // connection details. 4xx errors (validation, etc.) keep their message, since
  // those are meant to be shown; 5xx never echoes the underlying error text.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled error");
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send(
      statusCode < 500
        ? { error: "request_error", message: error.message }
        : { error: "internal_error" },
    );
  });

  return app;
}
