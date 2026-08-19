import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { openTestDatabase } from "./test/db.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import * as schema from "./db/schema.js";

const handle = openTestDatabase();
let webRoot: string;

const baseConfig: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
  devUser: "devuser",
  dataDir: "./data",
  defaultCurrency: "EUR",
};

// A Database pointed at an address nothing listens on, with a short connect
// timeout, so every query -- db.execute() and drizzle's query-builder chains
// alike -- fails the same way a real "the database is down" outage would. Used
// to prove the SPA fallback does not depend on the database being reachable.
function brokenDatabase(): Database {
  const sql = postgres("postgres://user:pass@127.0.0.1:1/nonexistent", {
    max: 1,
    connect_timeout: 1,
  });
  return drizzle(sql, { schema });
}

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), "conduit-web-"));
  await writeFile(
    path.join(webRoot, "index.html"),
    '<!doctype html><html><head><base href="__BASE_HREF__" /><script>window.__CONDUIT_BASE__="__BASE_PATH__";</script></head><body><div id="root"></div></body></html>',
  );
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "assets", "app.js"), "console.log('bundle');");
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
  await handle.close();
});

describe("SPA serving", () => {
  it("serves index.html at the root with the base path substituted", async () => {
    const app = await buildApp({
      config: { ...baseConfig, basePath: "/conduit" },
      db: handle.db,
      webRoot,
    });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('window.__CONDUIT_BASE__="/conduit"');
    expect(response.body).not.toContain("__BASE_PATH__");
    await app.close();
  });

  it("substitutes / when mounted at the domain root", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.body).toContain('window.__CONDUIT_BASE__="/"');
    await app.close();
  });

  it("sets a base href with a trailing slash so deep-link assets resolve", async () => {
    // Vite emits relative asset URLs. Without a <base href>, a browser at
    // /deals/123 resolves ./assets/app.js to /deals/assets/app.js and 404s, so
    // the page loads but the script never does and nothing renders.
    const app = await buildApp({
      config: { ...baseConfig, basePath: "/conduit" },
      db: handle.db,
      webRoot,
    });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.body).toContain('<base href="/conduit/"');
    expect(response.body).not.toContain("__BASE_HREF__");
    await app.close();
  });

  it("sets base href to / when mounted at the domain root", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.body).toContain('<base href="/"');
    await app.close();
  });

  it("serves index.html for an unknown client route so deep links work", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("serves static assets untouched", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("console.log");
    await app.close();
  });

  // Fix 2 (hotfix v0.4.3): a release used to need a hard refresh to be seen,
  // because the SPA shell had no cache-control of its own and browsers are
  // free to cache a bare 200 response with no header at all.
  it("sends Cache-Control: no-cache for the SPA shell at the root", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    await app.close();
  });

  it("sends Cache-Control: no-cache for the SPA shell on a deep link", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    await app.close();
  });

  // Vite content-hashes every filename under assets/, so those files are
  // safe to cache forever -- a new release ships new hashed filenames, it
  // never overwrites an old one in place.
  it("sends a long-lived immutable Cache-Control for a hash-named file under /assets/", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    await app.close();
  });

  // index.html itself must never get the assets/ treatment, even via the
  // static plugin's own route for it (wildcard:false enumerates every file
  // under webRoot at boot, including index.html -- index:false only turns
  // off the automatic "/" -> index.html mapping, it does not remove that
  // per-file route). A stale-forever index.html would mean releases can
  // never be seen at all, the opposite of this fix's whole point.
  it("never sends the immutable Cache-Control for index.html, even fetched directly via the static route", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/index.html" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).not.toContain("immutable");
    await app.close();
  });

  it("still returns JSON 404 for unknown API routes", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/api/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });

  it("returns JSON 404 for unknown routes when no webRoot is configured", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("SPA serving when the database is unreachable", () => {
  // Regression: the onRequest hook used to resolve identity for every route that
  // did not match a registered pattern, including SPA deep links. With a ynh-user
  // header present, that resolution performs an upsert -- and when the database is
  // down, the upsert throws inside the hook, before this file's not-found handler
  // (which needs no database) ever runs. A user hitting a deep link during an
  // outage should get the static SPA shell -- which itself reports the outage --
  // not a bare JSON 500.
  it("serves the SPA shell for a deep link with a ynh-user header present", async () => {
    const app = await buildApp({
      config: baseConfig,
      db: brokenDatabase(),
      webRoot,
    });
    const response = await app.inject({
      method: "GET",
      url: "/deals/123",
      headers: { "ynh-user": "chris", "ynh-user-email": "chris@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("__CONDUIT_BASE__");
    await app.close();
  });

  // Same regression, but via the CONDUIT_DEV_USER fallback (no header at all) --
  // identityFromHeaders still returns a non-null identity in that case, so the
  // hook must skip resolution for the unmatched route the same way it does with a
  // real header.
  it("serves the SPA shell for a deep link with the dev-user fallback active", async () => {
    const app = await buildApp({
      config: baseConfig,
      db: brokenDatabase(),
      webRoot,
    });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  // The unmatched-API path must not regress either: /api/nope still has no route,
  // so it must keep returning the JSON 404 rather than the SPA shell or a 500,
  // regardless of database health.
  it("still returns JSON 404, not a 500, for an unknown API route", async () => {
    const app = await buildApp({
      config: baseConfig,
      db: brokenDatabase(),
      webRoot,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/nope",
      headers: { "ynh-user": "chris", "ynh-user-email": "chris@example.com" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });
});
