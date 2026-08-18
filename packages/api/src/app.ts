import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { User } from "@conduit/shared";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { identityFromHeaders } from "./auth.js";
import { createUserResolver } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Database;
}

export async function buildApp({ config, db }: BuildAppOptions): Promise<FastifyInstance> {
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

  app.addHook("onRequest", async (request) => {
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

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: "not_found",
      message: `No route for ${request.method} ${request.url}`,
    });
  });

  return app;
}
