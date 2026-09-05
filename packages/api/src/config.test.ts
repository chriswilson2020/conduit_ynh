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

  it("leaves reauthPassword null when unset, so the real directory check is used", () => {
    expect(parseConfig(valid).reauthPassword).toBeNull();
  });

  it("defaults the directory to where YunoHost 12 puts it", () => {
    // Measured on the deploy target: slapd listens on 127.0.0.1:389 and on
    // nothing else. The scheme matters as much as the port -- ldap:// is what
    // ldapts reads to decide it is not opening a TLS connection.
    expect(parseConfig(valid).ldapUrl).toBe("ldap://127.0.0.1:389");
  });

  it("carries through an explicit CONDUIT_LDAP_URL and refuses a non-URL", () => {
    expect(parseConfig({ ...valid, CONDUIT_LDAP_URL: "ldap://127.0.0.1:9999" }).ldapUrl)
      .toBe("ldap://127.0.0.1:9999");
    expect(() => parseConfig({ ...valid, CONDUIT_LDAP_URL: "not a url" }))
      .toThrow(/CONDUIT_LDAP_URL/);
  });

  it("has no CONDUIT_PORTAL_API_URL left to honour", () => {
    // v1.4.1 retired it with the portal call it configured. An install that
    // still sets it in an env file is setting a variable nothing reads, which
    // is the harmless half of the swap -- but a config that silently kept
    // ACCEPTING it would be the sort of half-removal that reads as support.
    expect(parseConfig({ ...valid, CONDUIT_PORTAL_API_URL: "http://127.0.0.1:6788" }))
      .not.toHaveProperty("portalApiUrl");
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
  // --- Phase 8's OAuth app registrations -------------------------------------

  /** The one Phase 8 value this server cannot work out for itself, and the one
   * a provider compares byte for byte (RFC 6749 3.1.2.3). */
  const REDIRECT_URI = "https://conduit.example/api/mail/oauth/callback";

  it("has no OAuth registration by default -- a password-only install", () => {
    expect(parseConfig(valid).mailOAuth).toEqual({ microsoft: null, google: null });
  });

  it("builds Microsoft's tenant-scoped v2.0 endpoints, both of them", () => {
    const config = parseConfig({
      ...valid,
      MAIL_OAUTH_MICROSOFT_CLIENT_ID: "app-id",
      MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: "app-secret",
      MAIL_OAUTH_MICROSOFT_TENANT: "contoso.onmicrosoft.com",
      MAIL_OAUTH_REDIRECT_URI: REDIRECT_URI,
    });
    expect(config.mailOAuth.microsoft).toEqual({
      clientId: "app-id",
      clientSecret: "app-secret",
      // The pair travels together because it moves together: a tenant that
      // changes changes both, and a pair built in two places is a pair that can
      // end up naming two directories.
      tokenEndpoint:
        "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
      authorizeEndpoint:
        "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
      redirectUri: REDIRECT_URI,
    });
  });

  it("escapes a tenant rather than splicing it into the URL", () => {
    const config = parseConfig({
      ...valid,
      MAIL_OAUTH_MICROSOFT_CLIENT_ID: "app-id",
      MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: "app-secret",
      MAIL_OAUTH_MICROSOFT_TENANT: "a/b?c",
      MAIL_OAUTH_REDIRECT_URI: REDIRECT_URI,
    });
    expect(config.mailOAuth.microsoft?.tokenEndpoint)
      .toBe("https://login.microsoftonline.com/a%2Fb%3Fc/oauth2/v2.0/token");
    // Both endpoints, because escaping one and splicing the other would be a
    // tenant that reaches the right token URL and the wrong consent screen.
    expect(config.mailOAuth.microsoft?.authorizeEndpoint)
      .toBe("https://login.microsoftonline.com/a%2Fb%3Fc/oauth2/v2.0/authorize");
  });

  it("uses Google's single token endpoint, which has no tenant", () => {
    const config = parseConfig({
      ...valid,
      MAIL_OAUTH_GOOGLE_CLIENT_ID: "g-id",
      MAIL_OAUTH_GOOGLE_CLIENT_SECRET: "g-secret",
      MAIL_OAUTH_REDIRECT_URI: REDIRECT_URI,
    });
    expect(config.mailOAuth.google?.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
    // The v2 authorisation endpoint, which is the one that accepts
    // access_type and prompt -- both load-bearing for getting a refresh token
    // back at all (api: services/mail-oauth-signin.ts).
    expect(config.mailOAuth.google?.authorizeEndpoint)
      .toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  /**
   * A HALF-SET REGISTRATION IS NO REGISTRATION, in every direction. Carrying a
   * client id with no secret would push "is this usable?" down to the token
   * exchange, where the answer comes back as a provider's 401 with an
   * operator-hostile message instead of "this install has not configured it".
   * The Microsoft tenant is part of that: /common is the MULTI-tenant endpoint,
   * so falling back to it would authenticate against the wrong directory rather
   * than refusing.
   */
  it("treats a half-configured registration as none at all", () => {
    const complete = {
      MAIL_OAUTH_MICROSOFT_CLIENT_ID: "app-id",
      MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: "app-secret",
      MAIL_OAUTH_MICROSOFT_TENANT: "t",
      MAIL_OAUTH_REDIRECT_URI: REDIRECT_URI,
    };
    // Every single-field omission, derived from the complete set rather than
    // listed: a FIFTH field added to a registration is then covered by this
    // without anyone remembering to extend a literal.
    for (const missing of Object.keys(complete)) {
      const partial = { ...valid, ...complete } as Record<string, string | undefined>;
      delete partial[missing];
      expect(parseConfig(partial).mailOAuth.microsoft, missing).toBeNull();
    }
    expect(parseConfig({ ...valid, ...complete }).mailOAuth.microsoft).not.toBeNull();
    expect(parseConfig({ ...valid, MAIL_OAUTH_GOOGLE_CLIENT_ID: "g-id" }).mailOAuth.google).toBeNull();
  });

  /**
   * THE REDIRECT URI IS SHARED, not per provider: there is one callback route,
   * and `state` -- not the path -- is what says which sign-in came back. Two
   * registrations pointing at one URI is what both consoles expect.
   */
  it("gives both registrations the same redirect URI", () => {
    const config = parseConfig({
      ...valid,
      MAIL_OAUTH_MICROSOFT_CLIENT_ID: "app-id",
      MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: "app-secret",
      MAIL_OAUTH_MICROSOFT_TENANT: "t",
      MAIL_OAUTH_GOOGLE_CLIENT_ID: "g-id",
      MAIL_OAUTH_GOOGLE_CLIENT_SECRET: "g-secret",
      MAIL_OAUTH_REDIRECT_URI: REDIRECT_URI,
    });
    expect(config.mailOAuth.microsoft?.redirectUri).toBe(REDIRECT_URI);
    expect(config.mailOAuth.google?.redirectUri).toBe(REDIRECT_URI);
  });

  /** A value that is not a URL cannot be a redirect URI, and finding that out
   * at boot is better than finding it out at a consent screen. */
  it("refuses a redirect URI that is not a URL", () => {
    expect(() => parseConfig({ ...valid, MAIL_OAUTH_REDIRECT_URI: "conduit.example/callback" }))
      .toThrow(/MAIL_OAUTH_REDIRECT_URI/);
  });

  /**
   * NOT REFUSED IN PRODUCTION, unlike CONDUIT_DEV_USER and
   * CONDUIT_REAUTH_PASSWORD. Those two DISABLE a security control when set;
   * this is an ordinary credential, and production is exactly where it belongs.
   */
  it("accepts an OAuth registration under NODE_ENV=production", () => {
    expect(() => parseConfig({
      ...valid,
      MAIL_OAUTH_GOOGLE_CLIENT_ID: "g-id",
      MAIL_OAUTH_GOOGLE_CLIENT_SECRET: "g-secret",
    })).not.toThrow();
  });
});
