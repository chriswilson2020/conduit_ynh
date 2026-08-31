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

  // 7.6 Task 3's re-authentication gate. CONDUIT_REAUTH_PASSWORD replaces a
  // real credential check with a constant, which is the gate turned off while
  // still appearing to be there -- the worst of the three possible states.
  it("accepts CONDUIT_REAUTH_PASSWORD outside production", () => {
    const config = parseConfig({
      ...valid, NODE_ENV: "development", CONDUIT_REAUTH_PASSWORD: "fixture",
    });
    expect(config.reauthPassword).toBe("fixture");
  });

  it("refuses to boot with CONDUIT_REAUTH_PASSWORD set in production", () => {
    expect(() => parseConfig({ ...valid, CONDUIT_REAUTH_PASSWORD: "fixture" })).toThrow(
      /CONDUIT_REAUTH_PASSWORD/,
    );
  });

  it("leaves reauthPassword null when unset, so the real portal check is used", () => {
    expect(parseConfig(valid).reauthPassword).toBeNull();
  });

  it("defaults the portal API to where YunoHost 12 puts it", () => {
    // Measured on the deploy target: /etc/nginx/conf.d/yunohost_api.conf.inc
    // proxies /yunohost/portalapi/ to 127.0.0.1:6788.
    expect(parseConfig(valid).portalApiUrl).toBe("http://127.0.0.1:6788");
  });

  it("carries through an explicit CONDUIT_PORTAL_API_URL and refuses a non-URL", () => {
    expect(parseConfig({ ...valid, CONDUIT_PORTAL_API_URL: "http://127.0.0.1:9999" }).portalApiUrl)
      .toBe("http://127.0.0.1:9999");
    expect(() => parseConfig({ ...valid, CONDUIT_PORTAL_API_URL: "not a url" }))
      .toThrow(/CONDUIT_PORTAL_API_URL/);
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

  it("defaults MAIL_KEY_PATH to DATA_DIR/mail.key when unset", () => {
    expect(parseConfig({ ...valid, DATA_DIR: "/var/lib/conduit/data" }).mailKeyPath).toBe(
      "/var/lib/conduit/data/mail.key",
    );
  });

  it("carries through an explicit MAIL_KEY_PATH", () => {
    expect(parseConfig({ ...valid, MAIL_KEY_PATH: "/etc/conduit/mail.key" }).mailKeyPath).toBe(
      "/etc/conduit/mail.key",
    );
  });

  it("verifies mail TLS certificates unless MAIL_TLS_REJECT_UNAUTHORIZED is exactly 0", () => {
    expect(parseConfig(valid).mailTlsRejectUnauthorized).toBe(true);
    expect(parseConfig({ ...valid, MAIL_TLS_REJECT_UNAUTHORIZED: "0" }).mailTlsRejectUnauthorized).toBe(false);
    // Fails safe: anything that is not the exact opt-out string keeps
    // verification on rather than being read as a loose boolean.
    for (const value of ["1", "false", "no", "", "00"]) {
      expect(parseConfig({ ...valid, MAIL_TLS_REJECT_UNAUTHORIZED: value }).mailTlsRejectUnauthorized).toBe(true);
    }
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
