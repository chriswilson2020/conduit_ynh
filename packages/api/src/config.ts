import path from "node:path";
import { z } from "zod";
import { MAIL_OAUTH_CALLBACK_PATH } from "@conduit/shared";

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
  // WHAT A WHOLE REGISTRATION IS, and Task 3 finished the list. Task 2 needed
  // only a client id and secret, because a refresh is an RFC 6749 6
  // client-authenticated POST; Task 3 added the AUTHORISE half, and with it the
  // one value that cannot be derived from anything -- the redirect URI. The
  // scope list is still deliberately absent, and that is not the same decision:
  // a scope is a fact about which PROVIDER this is (see
  // services/mail-oauth-signin.ts's PROVIDERS), not about this install, and an
  // env var nothing but a typo can change is a setting whose truth nobody
  // checks.
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
  // WHERE THE PROVIDER SENDS THE OPERATOR BACK, and the one Phase 8 value that
  // this server cannot work out for itself.
  //
  // IT IS COMPARED BYTE FOR BYTE AT THE PROVIDER (RFC 6749 3.1.2.3, and both
  // Microsoft's and Google's consoles enforce it literally), so it has to be
  // the exact string registered there -- scheme, host, port and path, no
  // trailing slash it does not have. A mismatch fails at the consent screen
  // with the provider's own message and never reaches this code at all.
  //
  // NOT DERIVED FROM THE REQUEST, and that is a security decision rather than a
  // convenience one. `Host`/`X-Forwarded-Host` are client-supplied, and
  // building a redirect_uri out of them would let a request choose where the
  // authorisation code is delivered -- the classic redirect-URI-injection hole.
  // The provider's own exact-match check is the backstop, but a value this
  // server has decided on its own is what stops the question being asked.
  //
  // ONE URI FOR BOTH PROVIDERS, not one each, because there is one callback
  // route and it is the same route whichever provider answered -- `state`, not
  // the path, is what says which sign-in came back. Two registrations pointing
  // at one URI is ordinary and is what both consoles expect.
  //
  // z.url() rather than z.string(): a value that is not a URL cannot be a
  // redirect URI, and finding that out at boot is better than finding it out at
  // the consent screen.
  //
  // AND THAT SENTENCE IS WHY TASK 4 WENT FURTHER (see redirectUriProblem).
  // z.url() accepts `http://conduit.example/` and `https://conduit.example/x#y`
  // and a path that is not this server's callback -- three values that parse,
  // boot cleanly, and then fail at a provider or at a 404 with an authorisation
  // code in the URL bar. Every one of them is decidable here.
  MAIL_OAUTH_REDIRECT_URI: z.url().optional(),
});

/**
 * Why this value cannot work as a redirect URI, or null when it can.
 *
 * BOOT IS THE ONLY PLACE THIS IS CHEAP. Each of these fails somewhere else
 * otherwise: at Google's console, which refuses the registration; at the
 * consent screen, which shows the provider's own message about a URI this
 * server never sees; or at a 404 that has an authorisation code in its URL and
 * looks exactly like Conduit being broken. None of those name the setting.
 *
 * THREE CHECKS, EACH FROM A PUBLISHED RULE rather than from taste:
 *
 * 1. NO FRAGMENT. RFC 6749 3.1.2 says the redirection endpoint URI "MUST NOT
 *    include a fragment component", and Google's console says the same in as
 *    many words. A fragment never reaches a server anyway, so this one is not
 *    even provider-specific.
 * 2. HTTPS, EXCEPT ON THE LOOPBACK. Google: "Redirect URIs must use the HTTPS
 *    scheme, not plain HTTP. Localhost URIs ... are exempt from this rule."
 *    Microsoft's is the same shape. The loopback exemption is not a courtesy to
 *    developers here -- it is what lets the e2e suite register
 *    http://127.0.0.1:3100/... and exercise this path for real.
 * 3. IT HAS TO BE THIS SERVER'S CALLBACK. A registration that is byte-perfect
 *    at the provider and points at a path Conduit does not serve produces the
 *    worst-looking failure in the phase: the sign-in appears to work, the
 *    browser lands on a 404, and the authorisation code is sitting in the
 *    address bar. Checked as a SUFFIX rather than against basePath exactly,
 *    because the public path an operator is reverse-proxied at is BASE_PATH's
 *    business and a stricter check would refuse a deployment this file has no
 *    business having an opinion about.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: the host. This server does not know its
 * own public domain -- BASE_PATH is a path, and deriving an origin from a
 * request header is the redirect-URI-injection hole the entry above refuses to
 * open. A wrong host is caught at the provider, by the byte-for-byte compare,
 * with the operator looking at both values (the settings page now shows this
 * one back to them).
 */
export function redirectUriProblem(value: string, expectedPath: string): string | null {
  let url: URL;
  try {
    // UNREACHABLE THROUGH parseConfig, and kept rather than asserted away: the
    // schema's z.url() has already refused a non-URL, so no mutation can make
    // this branch run and no test can kill it. It stays because this function
    // is exported and takes a bare string -- a second caller that had not been
    // through zod would otherwise get a TypeError where a sentence belongs.
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.hash !== "") return "must not contain a #fragment (RFC 6749 3.1.2)";
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !loopback) {
    return "must use https (both providers refuse plain http except on localhost)";
  }
  if (!url.pathname.endsWith(expectedPath)) {
    return `must end with ${expectedPath}, which is where this server serves the callback`;
  }
  return null;
}

/**
 * One provider's app registration, or null when this install has none.
 *
 * BOTH ENDPOINTS ARE RESOLVED HERE rather than at the point of use, so that the
 * "which URLs does Microsoft's tenant give" question is answered once, in the
 * composition root's own input, and a test can point both at a local server
 * without knowing anything about Azure's URL shape. They travel together
 * because they move together: a tenant that changes changes both, and a pair
 * built in two places is a pair that can end up naming two directories.
 */
export interface MailOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** RFC 6749 4.1.3 (code exchange) and 6 (refresh) both POST here. */
  tokenEndpoint: string;
  /** Where the operator's browser is sent (RFC 6749 4.1.1). */
  authorizeEndpoint: string;
  /** MAIL_OAUTH_REDIRECT_URI, copied onto every registration -- see there for
   * why it is one value for both providers and why it is never derived from a
   * request. Carried per-provider rather than beside the pair so that a
   * registration is one object that is either complete or absent, which is what
   * oauthClient below enforces. */
  redirectUri: string;
}

export interface MailOAuthConfig {
  microsoft: MailOAuthClientConfig | null;
  google: MailOAuthClientConfig | null;
}

/** Google's token endpoint. One fixed URL, no tenant equivalent. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google's authorisation endpoint. The v2 OAuth 2.0 one, which is what
 * accepts `access_type` and `prompt` -- see mail-oauth-signin.ts, where both
 * are load-bearing for getting a refresh token back at all. */
export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Microsoft identity platform v2.0 token endpoint for one tenant. */
export function microsoftTokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

/** Microsoft identity platform v2.0 authorisation endpoint for one tenant.
 * Same tenant, same encoding, same reasoning as microsoftTokenEndpoint. */
export function microsoftAuthorizeEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
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
 *
 * THE REDIRECT URI JOINED THAT LIST IN TASK 3, and it is a real widening rather
 * than a tidy-up: an install that set an id, a secret and a tenant but no
 * MAIL_OAUTH_REDIRECT_URI now reads as having no registration where before it
 * read as having one. Nothing is stranded by that, and the reason is worth
 * stating rather than assuming -- the only thing a registration without a
 * redirect URI could ever have done is REFRESH a grant, and a grant can only
 * exist if a sign-in completed, which needs the redirect URI. So the state this
 * widening reclassifies is one no install can be in.
 */
function oauthClient(
  clientId: string | undefined, clientSecret: string | undefined,
  endpoints: { token: string; authorize: string } | null,
  redirectUri: string | undefined,
): MailOAuthClientConfig | null {
  if (clientId === undefined || clientSecret === undefined) return null;
  if (endpoints === null || redirectUri === undefined) return null;
  return {
    clientId, clientSecret,
    tokenEndpoint: endpoints.token, authorizeEndpoint: endpoints.authorize,
    redirectUri,
  };
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

  // Computed before the return because the redirect-URI check below quotes it
  // back at the operator; it was inline in the object literal until then.
  const basePath = value.BASE_PATH === "/"
    ? "/"
    : value.BASE_PATH.replace(/\/+$/, "") || "/";

  // REFUSED AT BOOT, LOUDLY, rather than carried as a registration that cannot
  // complete. The alternative considered and rejected was to treat an
  // unusable URI as an absent one -- which reads as "this install has no OAuth"
  // and hides the typo the operator is looking for. An install that has not set
  // it at all still boots with no registration, exactly as before; only a value
  // that IS set and cannot work stops the server, and the message names the
  // setting, the reason and the path to use.
  if (value.MAIL_OAUTH_REDIRECT_URI !== undefined) {
    const problem = redirectUriProblem(value.MAIL_OAUTH_REDIRECT_URI, MAIL_OAUTH_CALLBACK_PATH);
    if (problem !== null) {
      throw new Error(
        `MAIL_OAUTH_REDIRECT_URI ${problem}. It must be the exact string registered at the`
        + ` provider: https://<this install's domain>${basePath === "/" ? "" : basePath}`
        + `${MAIL_OAUTH_CALLBACK_PATH}`,
      );
    }
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    basePath,
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
          : {
              token: microsoftTokenEndpoint(value.MAIL_OAUTH_MICROSOFT_TENANT),
              authorize: microsoftAuthorizeEndpoint(value.MAIL_OAUTH_MICROSOFT_TENANT),
            },
        value.MAIL_OAUTH_REDIRECT_URI,
      ),
      google: oauthClient(
        value.MAIL_OAUTH_GOOGLE_CLIENT_ID,
        value.MAIL_OAUTH_GOOGLE_CLIENT_SECRET,
        { token: GOOGLE_TOKEN_ENDPOINT, authorize: GOOGLE_AUTHORIZE_ENDPOINT },
        value.MAIL_OAUTH_REDIRECT_URI,
      ),
    },
  };
}
