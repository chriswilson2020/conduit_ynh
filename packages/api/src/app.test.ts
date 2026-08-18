import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { healthResponseSchema, meResponseSchema } from "@conduit/shared";
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
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
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
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
    await app.close();
  });
});

describe("unknown API routes", () => {
  it("returns a JSON 404 rather than HTML", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });
});
