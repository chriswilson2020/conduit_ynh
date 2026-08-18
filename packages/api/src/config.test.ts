import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  NODE_ENV: "production",
  PORT: "8099",
  DATABASE_URL: "postgres://conduit:pw@localhost/conduit",
  BASE_PATH: "/conduit",
  APP_VERSION: "0.1.0",
};

describe("parseConfig", () => {
  it("parses a valid production environment", () => {
    const config = parseConfig(valid);
    expect(config.port).toBe(8099);
    expect(config.basePath).toBe("/conduit");
    expect(config.devUser).toBeNull();
  });

  it("defaults BASE_PATH to / when unset", () => {
    const { BASE_PATH, ...withoutBasePath } = valid;
    expect(parseConfig(withoutBasePath).basePath).toBe("/");
  });

  it("strips a trailing slash from BASE_PATH so joins do not double up", () => {
    expect(parseConfig({ ...valid, BASE_PATH: "/conduit/" }).basePath).toBe("/conduit");
  });

  it("keeps a bare root base path as /", () => {
    expect(parseConfig({ ...valid, BASE_PATH: "/" }).basePath).toBe("/");
  });

  it("normalises an all-slashes BASE_PATH to /", () => {
    expect(parseConfig({ ...valid, BASE_PATH: "//" }).basePath).toBe("/");
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...withoutDb } = valid;
    expect(() => parseConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => parseConfig({ ...valid, PORT: "http" })).toThrow(/PORT/);
  });

  it("accepts CONDUIT_DEV_USER outside production", () => {
    const config = parseConfig({ ...valid, NODE_ENV: "development", CONDUIT_DEV_USER: "chris" });
    expect(config.devUser).toBe("chris");
  });

  it("refuses to boot with CONDUIT_DEV_USER set in production", () => {
    expect(() => parseConfig({ ...valid, CONDUIT_DEV_USER: "chris" })).toThrow(
      /CONDUIT_DEV_USER/,
    );
  });

  it("defaults DATA_DIR to ./data when unset", () => {
    expect(parseConfig(valid).dataDir).toBe("./data");
  });

  it("carries through an explicit DATA_DIR", () => {
    expect(parseConfig({ ...valid, DATA_DIR: "/var/lib/conduit/data" }).dataDir).toBe(
      "/var/lib/conduit/data",
    );
  });

  it("defaults DEFAULT_CURRENCY to EUR when unset", () => {
    expect(parseConfig(valid).defaultCurrency).toBe("EUR");
  });

  it("carries through an explicit DEFAULT_CURRENCY", () => {
    expect(parseConfig({ ...valid, DEFAULT_CURRENCY: "USD" }).defaultCurrency).toBe("USD");
  });

  it("rejects a lowercase DEFAULT_CURRENCY", () => {
    expect(() => parseConfig({ ...valid, DEFAULT_CURRENCY: "usd" })).toThrow(/DEFAULT_CURRENCY/);
  });

  it("rejects a DEFAULT_CURRENCY that is not 3 letters", () => {
    expect(() => parseConfig({ ...valid, DEFAULT_CURRENCY: "EURO" })).toThrow(/DEFAULT_CURRENCY/);
  });
});
