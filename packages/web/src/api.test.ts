import { describe, it, expect, afterEach, vi } from "vitest";
import {
  basePath, apiUrl, deleteRequest, downloadArchive, fetchHealth, filenameFromDisposition,
  getJson, patchJson, ApiError,
} from "./api";

// vitest.config.ts runs this suite under environment: "node", so there is no
// global `window`. api.ts only reads `window.__CONDUIT_BASE__` inside function
// bodies (not at module load), so stubbing `globalThis.window` per test is
// enough to exercise it without pulling in jsdom as a dependency.
function setBase(value: string | undefined) {
  (globalThis as { window?: { __CONDUIT_BASE__?: string } }).window =
    value === undefined ? {} : { __CONDUIT_BASE__: value };
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("basePath", () => {
  it("falls back to / when window.__CONDUIT_BASE__ is undefined", () => {
    setBase(undefined);
    expect(basePath()).toBe("/");
  });

  it("falls back to / for the un-substituted __BASE_PATH__ placeholder", () => {
    setBase("__BASE_PATH__");
    expect(basePath()).toBe("/");
  });

  it("falls back to / for an empty string", () => {
    setBase("");
    expect(basePath()).toBe("/");
  });

  it("returns the injected base path when set to a subpath", () => {
    setBase("/conduit");
    expect(basePath()).toBe("/conduit");
  });
});

describe("apiUrl", () => {
  it("prefixes with /api at root", () => {
    setBase(undefined);
    expect(apiUrl("/me")).toBe("/api/me");
  });

  it("prefixes with the base path plus /api at a subpath install", () => {
    setBase("/conduit");
    expect(apiUrl("/me")).toBe("/conduit/api/me");
  });
});

// GET /api/health returns 200 with { status: "ok", database: "connected" } when
// healthy, or 503 with { status: "degraded", database: "disconnected" } when the
// database is down. Both are complete, parseable answers to "what is the health
// status" -- fetchHealth must resolve with the body in both cases, not just 200,
// or the App component loses the informative "disconnected" detail in favour of
// a generic "unavailable" whenever the health check itself is what is failing.
describe("fetchHealth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    }) as unknown as typeof fetch;
  }

  it("resolves with the body when the API reports healthy (200)", async () => {
    setBase(undefined);
    const body = { status: "ok", version: "0.1.0", database: "connected" };
    stubFetch({ ok: true, status: 200, body });

    await expect(fetchHealth()).resolves.toEqual(body);
  });

  it("resolves with the degraded body when the API reports degraded (503), rather than throwing", async () => {
    setBase(undefined);
    const body = { status: "degraded", version: "0.1.0", database: "disconnected" };
    stubFetch({ ok: false, status: 503, body });

    await expect(fetchHealth()).resolves.toEqual(body);
  });

  it("rejects on a genuinely unexpected status", async () => {
    setBase(undefined);
    stubFetch({ ok: false, status: 500, body: {} });

    await expect(fetchHealth()).rejects.toThrow("GET /health failed with 500");
  });
});

// This pins the contract company-detail.tsx / contact-detail.tsx rely on:
// a non-2xx response must reject with an ApiError carrying the real HTTP
// status and the server's machine-readable `error` field as `code`, not just
// a display string. Before ApiError existed, those pages compared the thrown
// Error's *message* against the literal string "archived" -- which never
// matched, because the API always sends a message like "company <id> is
// archived" (see packages/api/src/routes/helpers.ts), never the bare code.
// Branching on `code`/`status` instead of parsing `message` is what makes
// this actually work, and is safe even if the message text changes later.
describe("ApiError", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: { ok: boolean; status: number; body?: unknown; unparseable?: boolean }) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () =>
        response.unparseable === true
          ? Promise.reject(new Error("Unexpected end of JSON input"))
          : Promise.resolve(response.body),
    }) as unknown as typeof fetch;
  }

  it("rejects a 409 archived response with status/code/message all set from the body", async () => {
    setBase(undefined);
    stubFetch({
      ok: false,
      status: 409,
      body: { error: "archived", message: "company a1 is archived" },
    });

    const rejection = patchJson("/companies/a1", { domain: "x.example" });
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await rejection.catch((err: unknown) => {
      const apiError = err as ApiError;
      expect(apiError.status).toBe(409);
      expect(apiError.code).toBe("archived");
      expect(apiError.message).toBe("company a1 is archived");
    });
  });

  it("rejects a 404 response with status 404 and code not_found", async () => {
    setBase(undefined);
    stubFetch({
      ok: false,
      status: 404,
      body: { error: "not_found", message: "company a1 not found" },
    });

    const rejection = getJson("/companies/a1");
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await rejection.catch((err: unknown) => {
      const apiError = err as ApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.code).toBe("not_found");
      expect(apiError.message).toBe("company a1 not found");
    });
  });

  it("falls back to code 'unknown' and a generic message for an unparseable error body", async () => {
    setBase(undefined);
    stubFetch({ ok: false, status: 500, unparseable: true });

    const rejection = patchJson("/companies/a1", { domain: "x.example" });
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await rejection.catch((err: unknown) => {
      const apiError = err as ApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.code).toBe("unknown");
      expect(apiError.message).toBe("PATCH /companies/a1 failed with 500");
    });
  });
});

// deleteRequest backs useRemoveDependency (queries.ts): the route it targets
// (DELETE /api/tasks/:id/dependencies/:predecessorId) returns a bare 204 with
// no body, so unlike sendJson's callers this has nothing to parse on success.
describe("deleteRequest", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves with no value on a 2xx response", async () => {
    setBase(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve(undefined) }) as unknown as typeof fetch;

    await expect(deleteRequest("/tasks/t1/dependencies/t0")).resolves.toBeUndefined();
  });

  it("rejects with an ApiError built from the response body on a non-2xx response", async () => {
    setBase(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, json: () => Promise.resolve({ error: "not_found", message: "task t1 not found" }),
    }) as unknown as typeof fetch;

    const rejection = deleteRequest("/tasks/t1/dependencies/t0");
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await rejection.catch((err: unknown) => {
      const apiError = err as ApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.code).toBe("not_found");
    });
  });
});

/**
 * 7.6's downloads. Both archives are fetched rather than linked to -- the
 * backup because a passphrase must not travel in a query string, the export
 * because the re-authentication ticket must not either -- so the filename and
 * the failure handling are this module's business rather than the browser's.
 */
describe("filenameFromDisposition", () => {
  it("reads the plain filename the server sends", () => {
    expect(filenameFromDisposition(
      'attachment; filename="conduit-export-2026-08-31.zip"', "fallback.zip",
    )).toBe("conduit-export-2026-08-31.zip");
  });

  it("prefers the RFC 5987 form, which is the accurate half", () => {
    // routes/helpers.ts's contentDisposition emits BOTH, and the plain one is
    // the lossy fallback: it replaces every non-ASCII character with "_".
    expect(filenameFromDisposition(
      "attachment; filename=\"M_ller.zip\"; filename*=UTF-8''M%C3%BCller.zip", "fallback.zip",
    )).toBe("M\u00FCller.zip");
  });

  it("falls back rather than saving a file called nothing", () => {
    expect(filenameFromDisposition(null, "fallback.zip")).toBe("fallback.zip");
    expect(filenameFromDisposition("attachment", "fallback.zip")).toBe("fallback.zip");
    expect(filenameFromDisposition('attachment; filename=""', "fallback.zip")).toBe("fallback.zip");
  });

  it("falls through a malformed percent-escape instead of throwing", () => {
    // A rejected decodeURIComponent must not fail a download that has already
    // arrived; the plain form is right there.
    expect(filenameFromDisposition(
      "attachment; filename=\"ok.7z\"; filename*=UTF-8''%E0%A4%A", "fallback.7z",
    )).toBe("ok.7z");
  });
});

describe("downloadArchive", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("sends the ticket in a header and never in the URL", async () => {
    setBase(undefined);
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => 'attachment; filename="conduit-export-2026-08-31.zip"' },
        blob: () => Promise.resolve(new Blob(["PK"])),
      });
    }) as unknown as typeof fetch;

    const archive = await downloadArchive({
      path: "/export", method: "GET", ticket: "abc123", fallbackFilename: "x.zip",
    });
    expect(archive.filename).toBe("conduit-export-2026-08-31.zip");
    // THE POINT: nginx writes a query string to its access log verbatim, and
    // the browser keeps it in history. A single-use ticket is still a
    // credential for one copy of the whole database.
    expect(calls[0]?.url).toBe("/api/export");
    expect(calls[0]?.url).not.toContain("abc123");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Conduit-Reauth"]).toBe("abc123");
    // A GET carries no body and so declares no content type.
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("sends the passphrase in a POST body, with the ticket beside it", async () => {
    setBase(undefined);
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        blob: () => Promise.resolve(new Blob(["7z"])),
      });
    }) as unknown as typeof fetch;

    await downloadArchive({
      path: "/backup", method: "POST", ticket: "tkt",
      body: { passphrase: "correct horse" }, fallbackFilename: "x.7z",
    });
    expect(calls[0]?.url).toBe("/api/backup");
    expect(calls[0]?.url).not.toContain("correct");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ passphrase: "correct horse" }));
  });

  it("throws the app's ApiError rather than saving a JSON body as an archive", async () => {
    setBase(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: "reauth_required", message: "confirm your password" }),
      headers: { get: () => null },
      blob: () => Promise.resolve(new Blob(["should not be reached"])),
    }) as unknown as typeof fetch;

    const rejection = downloadArchive({
      path: "/export", method: "GET", ticket: "spent", fallbackFilename: "x.zip",
    });
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await rejection.catch((error: unknown) => {
      expect((error as ApiError).code).toBe("reauth_required");
      expect((error as ApiError).status).toBe(401);
    });
  });
});
