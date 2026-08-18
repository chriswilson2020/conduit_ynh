import { describe, it, expect, afterEach, vi } from "vitest";
import { basePath, apiUrl, fetchHealth, getJson, patchJson, ApiError } from "./api";

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
