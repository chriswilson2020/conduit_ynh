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
});

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
  };
}
