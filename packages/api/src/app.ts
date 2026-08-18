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
    // The app binds to loopback and is only reachable through YunoHost's nginx,
    // which is the boundary that makes the identity headers trustworthy.
    trustProxy: true,
  });

  app.decorateRequest("user", null);

  // One resolver per app instance, so its cache lives as long as the process.
  // Without it every request would write a row — see createUserResolver.
  const users = createUserResolver(db);

  app.addHook("onRequest", async (request) => {
    const identity = identityFromHeaders(request.headers, config.devUser);
    request.user = identity === null ? null : await users.resolve(identity);
  });

  app.get("/api/health", async () => {
    await db.execute(sql`SELECT 1`);
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
