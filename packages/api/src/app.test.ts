import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { healthResponseSchema, meResponseSchema, errorResponseSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "./test/db.js";
import { users } from "./db/schema.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
  devUser: null,
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

beforeEach(async () => {
  await truncateAll(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("GET /api/health", () => {
  it("reports ok and a connected database without authentication", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0-test");
    expect(body.database).toBe("connected");
    await app.close();
  });

  // Fix 1: a driver failure must not fall through to Fastify's default error
  // handler, which would return a differently-shaped 500 carrying the raw driver
  // message. Stub db.execute to reject the way a lost connection would, and check
  // both the response shape and that the underlying error text never reaches the
  // client -- that leak is exactly what this endpoint must not repeat.
  it("reports degraded with a disconnected database when the probe query fails", async () => {
    const secretDriverMessage = "connection refused: fake db down for a probe test";
    const failingDb = {
      execute: async () => {
        throw new Error(secretDriverMessage);
      },
    } as unknown as Database;

    const app = await buildApp({ config, db: failingDb });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("disconnected");
    expect(response.body).not.toContain(secretDriverMessage);
    expect(response.body).not.toContain("connection refused");
    await app.close();
  });

  // Regression: the onRequest hook used to resolve identity for every route,
  // including /api/health. With auth headers present, that resolution performs an
  // upsert on a cache miss (see createUserResolver) -- and when the database is
  // down, that write throws *inside the hook*, before this route's own try/catch
  // ever runs, producing Fastify's default 500 with the raw driver message. The
  // previous "degraded" test above sent no auth headers, so identityFromHeaders
  // returned null and resolve() was never reached -- it could not have caught this.
  // This test sends auth headers and makes both the health probe and the insert
  // path fail, matching the request SSOwat actually sends for a logged-in user.
  it("reports degraded rather than 500 when authenticated and the database is down", async () => {
    const secretDriverMessage = "connection refused: fake db down for a probe test";
    const failingDb = {
      execute: async () => {
        throw new Error(secretDriverMessage);
      },
      insert: () => {
        throw new Error(secretDriverMessage);
      },
    } as unknown as Database;

    const app = await buildApp({ config, db: failingDb });
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(503);
    const body = healthResponseSchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("disconnected");
    expect(response.body).not.toContain(secretDriverMessage);
    expect(response.body).not.toContain("connection refused");
    await app.close();
  });
});

describe("GET /api/me", () => {
  it("returns the authenticated user", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = meResponseSchema.parse(response.json());
    expect(body.user.username).toBe("chris");
    expect(body.user.fullName).toBe("Chris Wilson");
    await app.close();
  });

  it("returns 401 when no identity header is present", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(401);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("unauthenticated");
    await app.close();
  });

  // The onRequest hook resolves identity for /api/me (unlike /api/health), so a
  // database failure there surfaces as a thrown error inside the hook rather than
  // through the route's own logic. That error must reach setErrorHandler and come
  // back as the app's own error shape -- never the driver's raw message, which for
  // a real connection failure could include connection details.
  it("returns a 5xx without leaking driver text when resolving the user fails", async () => {
    const secretDriverMessage = "connection refused: fake db down for a probe test";
    const failingDb = {
      insert: () => {
        throw new Error(secretDriverMessage);
      },
    } as unknown as Database;

    const app = await buildApp({ config, db: failingDb });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: authHeaders,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("internal_error");
    expect(response.body).not.toContain(secretDriverMessage);
    expect(response.body).not.toContain("connection refused");
    await app.close();
  });

  it("persists the user so a second request does not duplicate the row", async () => {
    const app = await buildApp({ config, db: handle.db });
    const first = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });
    const second = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });

    expect(first.json().user.id).toBe(second.json().user.id);
    await app.close();
  });

  it("authenticates via the configured dev user when there is no header", async () => {
    const app = await buildApp({
      config: { ...config, devUser: "devuser" },
      db: handle.db,
    });
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("devuser");
    await app.close();
  });

  // Probe 1: the resolver caches per-username for a minute (see users.ts), so two
  // requests with the same identity through the real HTTP layer should only write
  // the row once. Read lastSeenAt from the raw row around the second request and
  // confirm it did not move -- proving the app-level onRequest hook actually reuses
  // one resolver instance across requests rather than, say, constructing a fresh
  // (uncached) resolver per request.
  it("does not advance lastSeenAt on a second request within the cache TTL", async () => {
    const app = await buildApp({ config, db: handle.db });
    await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });

    const [before] = await handle.db.select().from(users).where(eq(users.username, "chris"));
    expect(before).toBeDefined();

    await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });

    const [after] = await handle.db.select().from(users).where(eq(users.username, "chris"));
    expect(after).toBeDefined();
    expect(after?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());

    await app.close();
  });

  // Probe 2: identityFromHeaders rejects a ynh-user value containing a forbidden
  // control character (auth.test.ts already proves this at the unit level). This
  // confirms the rejection actually reaches the HTTP layer end to end: the onRequest
  // hook must treat the malformed header the same as a missing one, not throw or
  // silently strip the bad character and authenticate anyway.
  it("returns 401 when ynh-user contains a control character", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { "ynh-user": "chris\u0007attacker" },
    });

    expect(response.statusCode).toBe(401);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("unauthenticated");
    await app.close();
  });
});

describe("unknown API routes", () => {
  it("returns a JSON 404 rather than HTML", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("not_found");
    await app.close();
  });
});

describe("error handler installation order", () => {
  let webRoot: string;

  beforeAll(async () => {
    // registerSpa (called when webRoot is set) does its own `await
    // app.register(fastifyStatic, ...)` -- the same shape of call that made this
    // ordering hazard reachable in the first place. index.html's content does not
    // matter for this test; the SPA branch just needs to exist and be reachable.
    webRoot = await mkdtemp(path.join(os.tmpdir(), "conduit-app-webroot-"));
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><html><body></body></html>");
  });

  afterAll(async () => {
    await rm(webRoot, { recursive: true, force: true });
  });

  // Regression for a real information-disclosure bug: with webRoot set (so
  // registerSpa's awaited app.register() runs) and a database failure during the
  // auth onRequest hook, the response used to be Fastify's own default error
  // handler -- carrying the raw driver error, which for a real Postgres failure
  // includes the parameterised SQL and its bound values -- rather than this app's
  // sanitized { error: "internal_error" } body. Fixed by installing
  // app.setErrorHandler before any app.register() call in buildApp (see the
  // comment there). This test fails without that fix: moving setErrorHandler back
  // below the register calls reproduces the leak and turns this red again.
  it("returns the sanitized 5xx body, not raw driver text, when webRoot is set and identity resolution fails", async () => {
    const secretDriverMessage = "connection refused: fake db down for a probe test";
    const failingDb = {
      insert: () => {
        throw new Error(secretDriverMessage);
      },
    } as unknown as Database;

    const app = await buildApp({ config, db: failingDb, webRoot });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: authHeaders,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("internal_error");
    expect(response.body).not.toContain(secretDriverMessage);
    expect(response.body).not.toContain("connection refused");
    await app.close();
  });
});
