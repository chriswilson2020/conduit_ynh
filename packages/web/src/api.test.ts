import { describe, it, expect, afterEach } from "vitest";
import { basePath, apiUrl } from "./api";

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
