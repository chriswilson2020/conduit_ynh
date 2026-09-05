import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BASE_PATH: z.string().startsWith("/").default("/"),
  APP_VERSION: z.string().default("0.0.0-dev"),
  CONDUIT_DEV_USER: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  DEFAULT_CURRENCY: z.string()
    .regex(/^[A-Z]{3}$/, "DEFAULT_CURRENCY must be 3 uppercase letters")
    .default("EUR"),
  // No zod .default() here: the default depends on DATA_DIR, which is itself
  // configurable, so it is computed below after parsing rather than baked into
  // the schema (same reason basePath's trailing-slash normalisation happens
  // post-parse instead of in the schema).
  MAIL_KEY_PATH: z.string().min(1).optional(),
  // "0" turns off certificate verification for BOTH the IMAP and the SMTP
  // connection; anything else (including the default) leaves it on. Exists
  // for CI only, where Dovecot and Mailpit serve self-signed certificates
  // that no trust store can validate -- there is no UI for it and no
  // per-account variant, so the blast radius of a mistake is one deployment's
  // env file rather than one account's settings. Kept as a string rather than
  // a boolean coercion so that a typo ("true", "yes") fails SAFE: only the
  // exact string "0" disables verification.
  MAIL_TLS_REJECT_UNAUTHORIZED: z.string().default("1"),
  // Where YunoHost's LDAP directory listens. The re-authentication gate binds
  // it to check the operator's password (services/reauth.ts), and the default
  // is where every YunoHost 12 box puts it -- measured on the deploy target,
  // where slapd listens on 127.0.0.1:389 and nowhere else. Configurable rather
  // than hard-coded because a test needs to point it somewhere else, not
  // because a deployment is expected to.
  //
  // IT REPLACED CONDUIT_PORTAL_API_URL in v1.4.1 and NEITHER IS IN conf/.env,
  // so no packaging change came with the swap: an install that never set the
  // old one has nothing to unset, and one that did is simply ignoring a
  // variable now.
  CONDUIT_LDAP_URL: z.url().default("ldap://127.0.0.1:389"),
  // A FIXED PASSWORD FOR THE RE-AUTHENTICATION GATE, FOR DEVELOPMENT AND CI
  // ONLY, refused below when NODE_ENV=production exactly as CONDUIT_DEV_USER
  // is. Neither a developer's machine nor a GitHub runner has a YunoHost
  // portal to bind against, and a gate that can only be exercised on the
  // deploy target is a gate nobody ever proves -- including the half that
  // matters most, that bypassing it fails.
  CONDUIT_REAUTH_PASSWORD: z.string().min(1).optional(),
  // --- Phase 8: the OAuth app registrations ---------------------------------
  //
  // THE MINIMUM A TOKEN REFRESH NEEDS, AND NOTHING MORE. Task 2 exchanges a
  // stored refresh token for an access token, which is an RFC 6749 4c
  // client-authenticated POST -- so a client id and secret are the whole of
  // what has to be configurable here. The redirect URI and the scope list
  // belong to the AUTHORISE half (Task 3) and are deliberately absent: adding
  // env vars nothing reads is how a deployment ends up carrying settings whose
  // truth nobody checks.
  //
  // ABSENT IS THE NORMAL STATE, hence optional with no defaults. This install's
  // accounts are password accounts against a self-hosted Dovecot, and the spec
  // is explicit that they stay the common case. An install with no registration
  // configured simply has no way to make an OAuth account; the refresher says
  // so in a sentence rather than failing at a provider with an empty client id.
  //
  // THE SECRET IS A SECRET AND HAS NO PRODUCTION GUARD, unlike CONDUIT_DEV_USER
  // and CONDUIT_REAUTH_PASSWORD above -- those two DISABLE a security control
  // when set, which is why production refuses them. This one is an ordinary
  // credential that production is exactly where you want it; it lives in the
  // install's .env beside DATABASE_URL, is never logged, and never reaches a
  // response.
  MAIL_OAUTH_MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  // Single-tenant, per the spec's "a single-tenant app registration in the
  // operator's own Azure AD". "common" is the multi-tenant endpoint and is a
  // deliberate non-default: an operator who sets an id and secret but no tenant
  // has not finished, and a silent fallback to /common would authenticate
  // against the wrong directory rather than refusing.
  MAIL_OAUTH_MICROSOFT_TENANT: z.string().min(1).optional(),
  MAIL_OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  MAIL_OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

/**
 * One provider's app registration, or null when this install has none.
 * `tokenEndpoint` is resolved here rather than at the point of use so that the
 * "which URL does Microsoft's tenant give" question is answered once, in the
 * composition root's own input, and a test can point it at a local server
 * without knowing anything about Azure's URL shape.
 */
export interface MailOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
}

export interface MailOAuthConfig {
  microsoft: MailOAuthClientConfig | null;
  google: MailOAuthClientConfig | null;
}

/** Google's token endpoint. One fixed URL, no tenant equivalent. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Microsoft identity platform v2.0 token endpoint for one tenant. */
export function microsoftTokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export interface Config {
  nodeEnv: z.infer<typeof envSchema>["NODE_ENV"];
  port: number;
  databaseUrl: string;
  /** Public path the app is mounted at, without a trailing slash. "/" stays "/". */
  basePath: string;
  version: string;
  /** Username to assume when no SSOwat header is present. Never set in production. */
  devUser: string | null;
  dataDir: string;
  /** Applied by the deals service when a caller creates a deal without a currency. */
  defaultCurrency: string;
  /** 32-byte AES-256-GCM key file for mail credential encryption; see mail-crypto.ts. */
  mailKeyPath: string;
  /** Whether the IMAP/SMTP adapters verify server certificates. False only in
   * CI (MAIL_TLS_REJECT_UNAUTHORIZED=0), never in a real deployment. */
  mailTlsRejectUnauthorized: boolean;
  /** YunoHost's LDAP directory, which the re-authentication gate binds against. */
  ldapUrl: string;
  /** A fixed re-authentication password. Never set in production; see the
   * schema entry and the guard in parseConfig. */
  reauthPassword: string | null;
  /** Phase 8's OAuth app registrations, per provider. Both null on an install
   * that only has password accounts, which is the ordinary case. */
  mailOAuth: MailOAuthConfig;
}

/**
 * One provider's registration, or null when it is not fully configured.
 *
 * ALL-OR-NOTHING, never a half. A client id without a secret (or, for
 * Microsoft, without a tenant) cannot complete a single request, and carrying
 * it as a partly-populated object would push the "is this usable?" question
 * down to the token exchange, where the answer arrives as a provider's 401 with
 * an operator-hostile message. A half-set registration reads here as no
 * registration, and the refresher's own sentence says which install-side thing
 * is missing.
 */
function oauthClient(
  clientId: string | undefined, clientSecret: string | undefined, tokenEndpoint: string | null,
): MailOAuthClientConfig | null {
  if (clientId === undefined || clientSecret === undefined || tokenEndpoint === null) return null;
  return { clientId, clientSecret, tokenEndpoint };
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const value = parsed.data;

  // This guard only fires when NODE_ENV is exactly "production". NODE_ENV defaults to
  // "development" when unset, so a deployment that forgets to set NODE_ENV=production
  // would boot with CONDUIT_DEV_USER set and silently bypass authentication. This file
  // does not enforce that NODE_ENV is set explicitly in production — the systemd unit
  // and the .env template are responsible for that (and `npm run dev` relies on the
  // "development" default, so requiring it here would break local development).
  if (value.NODE_ENV === "production" && value.CONDUIT_DEV_USER !== undefined) {
    throw new Error(
      "CONDUIT_DEV_USER must not be set when NODE_ENV=production: it bypasses SSO authentication",
    );
  }

  // The same guard, one line down, for the same class of variable and with the
  // same caveat: it only fires when NODE_ENV is exactly "production", so the
  // systemd unit and the .env template remain responsible for setting it. A
  // deployment that shipped this one set would answer the re-authentication
  // gate with a constant instead of the operator's real password -- which is
  // the gate turned off while still appearing to be there, the worst of the
  // three possible states.
  if (value.NODE_ENV === "production" && value.CONDUIT_REAUTH_PASSWORD !== undefined) {
    throw new Error(
      "CONDUIT_REAUTH_PASSWORD must not be set when NODE_ENV=production: "
      + "it replaces the re-authentication check with a fixed value",
    );
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    basePath: value.BASE_PATH === "/" ? "/" : value.BASE_PATH.replace(/\/+$/, "") || "/",
    version: value.APP_VERSION,
    devUser: value.CONDUIT_DEV_USER ?? null,
    dataDir: value.DATA_DIR,
    defaultCurrency: value.DEFAULT_CURRENCY,
    mailKeyPath: value.MAIL_KEY_PATH ?? path.join(value.DATA_DIR, "mail.key"),
    mailTlsRejectUnauthorized: value.MAIL_TLS_REJECT_UNAUTHORIZED !== "0",
    ldapUrl: value.CONDUIT_LDAP_URL,
    reauthPassword: value.CONDUIT_REAUTH_PASSWORD ?? null,
    mailOAuth: {
      microsoft: oauthClient(
        value.MAIL_OAUTH_MICROSOFT_CLIENT_ID,
        value.MAIL_OAUTH_MICROSOFT_CLIENT_SECRET,
        value.MAIL_OAUTH_MICROSOFT_TENANT === undefined
          ? null
          : microsoftTokenEndpoint(value.MAIL_OAUTH_MICROSOFT_TENANT),
      ),
      google: oauthClient(
        value.MAIL_OAUTH_GOOGLE_CLIENT_ID,
        value.MAIL_OAUTH_GOOGLE_CLIENT_SECRET,
        GOOGLE_TOKEN_ENDPOINT,
      ),
    },
  };
}
