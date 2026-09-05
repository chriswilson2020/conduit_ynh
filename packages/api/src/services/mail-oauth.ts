import { eq } from "drizzle-orm";
import { mailOAuthProviderOf, type MailAuthMethod, type MailOAuthProvider } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts } from "../db/schema.js";
import { MailAuthMethodMismatchError, MailReauthRequiredError } from "./errors.js";
import {
  decryptCredentials, encryptCredentialsChecked, loadMailKey,
  type MailCredentials, type MailOAuthCredentials,
} from "./mail-crypto.js";
import { MAIL_CONNECTION_ERROR_PREFIX, type MailConnectionAuth } from "./mail-imap.js";

/**
 * Phase 8 Task 2: turning what is STORED into what a connection can use.
 *
 * -------------------------------------------------------------------------
 * WHO REFRESHES WHAT, AND WHY IT IS CONDUIT FOR BOTH PROTOCOLS
 * -------------------------------------------------------------------------
 *
 * Both libraries speak XOAUTH2 and the phase's plan says nodemailer "will do
 * its own" refresh. It will -- CONDITIONALLY, and the condition is the whole
 * decision. Read against the installed nodemailer 9.0.5: `XOAuth2.getToken`
 * (lib/xoauth2/index.js) renews only when the auth block carries a
 * `refreshToken` (or a `provisionCallback`, or a service-account
 * `serviceClient`); given an access token and none of those it logs "Reusing
 * existing access token (no refresh capability)" and sends what it was given.
 * So "built in" is a property of how the block is CONFIGURED, and Conduit gets
 * to choose. It chooses to configure it OUT, and hands nodemailer
 * `{ type: "OAuth2", user, accessToken }` and nothing else. Four reasons, in
 * the order they mattered:
 *
 * 1. A REFRESH FAILURE HAS TO BECOME AN ACCOUNT STATE. That is the phase's
 *    Risk 3 and the item the plan calls the one that matters most. Conduit can
 *    only turn `invalid_grant` into mail_accounts.status='auth_required' if
 *    Conduit is the thing that saw it. A refresh inside nodemailer surfaces as
 *    an EAUTH on ONE send, to ONE composing user, at a moment nobody is looking
 *    at Settings -- and the sync loop, which is the thing actually watching the
 *    account, would never learn of it at all.
 * 2. TWO REFRESHERS ARE TWO ANSWERS THAT CAN DISAGREE, and the one inside a
 *    library is the one nobody would think to check -- the same argument
 *    mail-crypto.ts makes for keeping the provider in auth_method and not also
 *    in the blob. The IMAP side has to be Conduit's regardless (imapflow takes
 *    a token and never fetches one), so letting SMTP be nodemailer's would mean
 *    two implementations of one rule.
 * 3. NODEMAILER'S CACHE WOULD BUY NOTHING HERE. mail-imapflow.ts builds a
 *    NON-POOLED transport per send and closes it after the message, so its
 *    XOAuth2 instance lives for one submission: every send would be a fresh
 *    token request. Conduit's cache lives in the credential blob, is shared
 *    with the IMAP side, and survives a restart.
 * 4. IT WOULD PUT THE REFRESH TOKEN IN A SECOND PLACE. Configuring nodemailer's
 *    own refresh means handing it clientId, clientSecret and the refresh token
 *    itself. The spec's rule is that the refresh token never leaves the server;
 *    keeping it inside this module and mail-crypto.ts keeps the set of code
 *    that has ever held one small enough to name.
 *
 * What Conduit gives up by choosing this: nodemailer will not recover from an
 * access token that expires between this module's check and the AUTH command.
 * Measured against what that costs -- `_actionAUTHComplete` retries once with
 * renew=true, gets the same token back, and terminates as EAUTH -- so the send
 * fails with an auth error the composer already knows how to show, and the next
 * one refreshes. TOKEN_EXPIRY_SKEW_MS exists to make that window not happen.
 *
 * -------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * -------------------------------------------------------------------------
 *
 * It does not obtain a grant. The authorisation-code exchange, the two routes
 * and the redirect URI are Task 3's; this module only ever presents a refresh
 * token that already exists. It also never writes mail_accounts.status: a
 * refresh failure leaves here as a typed error and the SYNC LOOP is the single
 * writer of the account's state (mail-sync.ts's writeAccountState), because two
 * writers to that column is how a state gets silently overwritten by the next
 * pass.
 */

// --- The provider seam -----------------------------------------------------

/** One provider's app registration, as the composition root resolved it from
 * config (config.ts's MailOAuthClientConfig). */
export interface MailOAuthClient {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
}

/** Registrations this install has. A provider absent from the record is one no
 * account can authenticate with; the refresher says so by name. */
export type MailOAuthClients = Partial<Record<MailOAuthProvider, MailOAuthClient>>;

/**
 * config.mailOAuth's `X | null` pairs as the record above.
 *
 * STRUCTURAL, so this module still imports nothing from config.ts -- the same
 * arrangement mail-imapflow.ts has with `rejectUnauthorized`, where the
 * composition root does the reading and the service takes a plain value. It
 * exists so the two places that build a refresher (server.ts, and app.ts's
 * fallback for the many tests that build an app and never send mail) cannot
 * spell the mapping differently.
 */
export function oauthClientsFrom(
  configured: { microsoft: MailOAuthClient | null; google: MailOAuthClient | null },
): MailOAuthClients {
  return {
    ...(configured.microsoft === null ? {} : { microsoft: configured.microsoft }),
    ...(configured.google === null ? {} : { google: configured.google }),
  };
}

/** What a token endpoint answered, normalised. */
export interface MailTokenGrant {
  accessToken: string;
  /** Seconds from now, as the provider reported them (`expires_in`). */
  expiresInSeconds: number;
  /**
   * A REPLACEMENT refresh token, when the provider rotated one. Present is the
   * interesting case, not absent: Microsoft returns a fresh refresh token on
   * every refresh, and Google does under rotation. Dropping it is not benign --
   * a provider that rotates may invalidate the old one, so an install that
   * ignored this field would work until the grace period lapsed and then look
   * exactly like an expired grant.
   */
  refreshToken?: string;
}

/**
 * Exchange a refresh token for an access token.
 *
 * A SEAM, because the real one is an HTTPS request to a third party that no
 * test can honestly make. Its contract is what the tests pin: resolve with a
 * grant, throw MailReauthRequiredError when the provider says the GRANT is
 * dead, and throw an ordinary (ideally `connection:`-prefixed) Error for
 * everything else -- a network failure, a 5xx, a registration that is wrong.
 * Only the first of those is allowed to reach an operator as "sign in again".
 */
export type MailTokenRefresher =
  (provider: MailOAuthProvider, refreshToken: string) => Promise<MailTokenGrant>;

/**
 * The refresher a caller gets when none was supplied.
 *
 * A REFUSAL, NOT A NO-OP, and it is what the sync engine and the send path
 * default to. Both take the refresher as an OPTIONAL dependency because the
 * overwhelming majority of their work never needs one -- a password account
 * resolves without touching this file, and the deployment target has only
 * password accounts. Defaulting to a function that says plainly why it cannot
 * help means the one path that does need it fails with an operator-readable
 * sentence in mail_accounts.last_error, rather than with a TypeError from
 * calling undefined or, worse, with a blank access token at the provider.
 */
export const unconfiguredTokenRefresher: MailTokenRefresher = (provider) => {
  throw new Error(
    `this server has no OAuth token refresher wired up, so it cannot renew the ${provider}`
    + " sign-in for this account",
  );
};

/**
 * How long before a stored access token's stated expiry it stops being used.
 *
 * SIXTY SECONDS, AND THE WINDOW IT COVERS IS SMALLER THAN IT LOOKS. A token is
 * only needed at the AUTHENTICATE/AUTH command; once a session is authenticated
 * it stays authenticated, so an IMAP connection held open for a five-minute
 * poll (or a multi-hour IDLE) does not care that its token expired minutes ago.
 * What this has to cover is TCP connect plus TLS plus greeting plus the auth
 * round trip -- CONNECT_TIMEOUT_MS-scale, not session-scale. A minute is
 * comfortably over that and comfortably under a provider's hour, so the cost is
 * one extra refresh per hour per account at worst.
 *
 * ZERO WAS THE ALTERNATIVE AND IS THE TRAP: a token that is valid when checked
 * and expired when the server reads it produces an authentication failure,
 * which the settings UI renders as "check the username/password" -- pointing an
 * operator at a password that does not exist for an account that has none.
 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

// --- Resolving one connection's credential ---------------------------------

export interface MailConnectionAuthDeps {
  db: Database;
  mailKeyPath: string;
  refresh: MailTokenRefresher;
  /** The sync engine's clock, so a test can move time rather than wait. */
  now: () => Date;
}

/**
 * What a connection to `account` should authenticate with, refreshing the
 * access token first if it is missing or about to expire.
 *
 * `protocol` PICKS THE PASSWORD HALF AND NOTHING ELSE. A password account
 * stores two (the account form's "SMTP differs" toggle), and getting them the
 * wrong way round is a failure that shows up at the server rather than here --
 * mail-imapflow.test.ts and mail-sync.test.ts both pin which half arrives,
 * after a mutation found that nothing did. An OAuth account has ONE access
 * token that authenticates both protocols: the scopes a mail grant carries
 * cover IMAP and SMTP together, so there is nothing to pick.
 *
 * TAKES THE ALREADY-DECRYPTED CREDENTIALS rather than reading the row itself,
 * so that mail-accounts.ts's getAccountCredentialsAsSystem stays the one decrypt
 * path and keeps raising the NotFoundError/ArchivedError that mail-sync's
 * isTeardownError depends on to tear an account down. The only row this module
 * reads for itself is the compare-and-set in persistRefreshedToken, and that
 * one is on the rare refresh path.
 */
export async function resolveConnectionAuth(
  deps: MailConnectionAuthDeps,
  account: { id: string; authMethod: string },
  credentials: MailCredentials,
  protocol: "imap" | "smtp",
): Promise<MailConnectionAuth> {
  const provider = mailOAuthProviderOf(account.authMethod as MailAuthMethod);

  if (credentials.kind === "password") {
    // The column and the blob have to agree; see MailAuthMethodMismatchError.
    if (provider !== null) {
      throw new MailAuthMethodMismatchError(account.id, account.authMethod, credentials.kind);
    }
    return {
      kind: "password",
      password: protocol === "imap" ? credentials.imapPassword : credentials.smtpPassword,
    };
  }

  if (provider === null) {
    throw new MailAuthMethodMismatchError(account.id, account.authMethod, credentials.kind);
  }
  return { kind: "oauth", accessToken: await ensureAccessToken(deps, account.id, provider, credentials) };
}

/**
 * The cached access token if it is still good, otherwise a freshly refreshed
 * one (persisted on the way past).
 *
 * THE CACHE IS THE CREDENTIAL BLOB, not a map in this process, and that is
 * deliberate: two things connect on an account's behalf (the sync loop and a
 * send), a restart must not cost a token request per account, and Task 1
 * already shaped the union to hold `accessToken` + `accessTokenExpiresAt`
 * together for exactly this. An in-memory cache would be a third place the
 * answer lives.
 */
async function ensureAccessToken(
  deps: MailConnectionAuthDeps,
  accountId: string,
  provider: MailOAuthProvider,
  credentials: MailOAuthCredentials,
): Promise<string> {
  // The cast is sound by isUsable's first line, which returns false unless both
  // the token and its expiry are present; TypeScript cannot narrow across the
  // call, and inlining the check to avoid the cast would put the skew
  // comparison in two places.
  if (isUsable(credentials, deps.now())) return credentials.accessToken as string;

  const grant = await deps.refresh(provider, credentials.refreshToken);
  await persistRefreshedToken(deps, accountId, credentials, grant);
  return grant.accessToken;
}

/**
 * Whether the stored access token can still be used.
 *
 * An unparseable expiry reads as NOT usable rather than as an error: the schema
 * already holds the field to z.iso.datetime(), so this cannot happen through
 * any writer, and if it somehow did, refreshing is a correct and cheap answer
 * where throwing would strand the account over a cache entry.
 */
function isUsable(credentials: MailOAuthCredentials, now: Date): boolean {
  if (credentials.accessToken === undefined || credentials.accessTokenExpiresAt === undefined) return false;
  const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - now.getTime() > TOKEN_EXPIRY_SKEW_MS;
}

/**
 * Write the refreshed token (and a rotated refresh token) back into
 * credentials_ciphertext.
 *
 * COMPARE-AND-SET ON THE REFRESH TOKEN, under FOR UPDATE, and the case it
 * exists for is narrow but unrecoverable. The sync loop and a send can refresh
 * the same account at the same moment; both start from refresh token R. If the
 * provider ROTATES -- Microsoft always does -- one gets R1 and the other R2,
 * and whichever writes last wins. That is fine when the loser's token is merely
 * redundant and fatal when the provider invalidated R1 on issuing R2: the row
 * would then hold a refresh token the provider has already retired, and the
 * account is stranded until somebody signs in again. So the write only lands if
 * the row still holds the exact refresh token this refresh was made against;
 * otherwise another writer got there first with a newer one and theirs is kept.
 *
 * THE LOCK IS HELD ACROSS NO NETWORK CALL. The provider round trip has already
 * happened by the time this runs -- all that is inside the transaction is one
 * select, one AES decrypt of a few hundred bytes, one AES encrypt and one
 * update.
 *
 * FAILING TO PERSIST IS NOT FAILING TO CONNECT. The caller's access token is
 * valid whether or not this write lands, so a row that vanished (the account
 * was deleted mid-refresh) is a silent no-op here rather than an error that
 * would fail a pass over a cache update.
 */
async function persistRefreshedToken(
  deps: MailConnectionAuthDeps,
  accountId: string,
  previous: MailOAuthCredentials,
  grant: MailTokenGrant,
): Promise<void> {
  const now = deps.now();
  const next = {
    kind: "oauth" as const,
    refreshToken: grant.refreshToken ?? previous.refreshToken,
    accessToken: grant.accessToken,
    // The provider's own `expires_in`, anchored to this server's clock. Stored
    // as the instant rather than the duration because a duration is only
    // meaningful next to the moment it was issued, and that moment is not
    // otherwise recorded anywhere.
    accessTokenExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000).toISOString(),
  };
  // CHECKED, not the plain encoder: this payload is assembled from an HTTP
  // response, which is exactly the case mail-crypto.ts's encryptCredentials
  // comment says it will happily seal and never read back.
  const key = loadMailKey(deps.mailKeyPath);
  const ciphertext = encryptCredentialsChecked(key, next);

  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ciphertext: mailAccounts.credentialsCiphertext })
      .from(mailAccounts).where(eq(mailAccounts.id, accountId)).for("update");
    if (row === undefined) return;
    let current: MailCredentials;
    try {
      current = decryptCredentials(key, row.ciphertext);
    } catch {
      // The row no longer decrypts under the key this process holds (a restore
      // between the read and now). Overwriting it with a blob sealed under a
      // key it may not be read with again would make a bad situation
      // irreversible; leave it exactly as found.
      return;
    }
    if (current.kind !== "oauth" || current.refreshToken !== previous.refreshToken) return;
    await tx.update(mailAccounts)
      .set({ credentialsCiphertext: ciphertext, updatedAt: now })
      .where(eq(mailAccounts.id, accountId));
  });
}

// --- The real token endpoint -----------------------------------------------

/**
 * RFC 6749 5.2 error codes that mean THE GRANT IS DEAD, as opposed to the
 * request or the registration being wrong.
 *
 * ONE MEMBER, AND THE SHORTNESS IS THE POINT. `invalid_grant` is what both
 * providers answer for a revoked, expired or superseded refresh token: Google's
 * 7-day consumer revocation, a Microsoft tenant admin withdrawing consent, and
 * a password change that invalidates the grant all arrive as this one code.
 * Everything else in that section is deliberately NOT here.
 * `invalid_client`/`unauthorized_client`/`invalid_scope` mean the APP
 * REGISTRATION is wrong -- a rotated client secret, a scope that was never
 * granted -- and telling an operator to sign in again for those would be a
 * WRONG INSTRUCTION: the second sign-in fails identically, and they have been
 * sent away from the thing that is actually broken. Those stay ordinary account
 * errors, whose text names the code so it can be looked up.
 */
const GRANT_DEAD_CODES: ReadonlySet<string> = new Set(["invalid_grant"]);

/** Bound on the token request. Well under the sync engine's own connect
 * timeouts: a provider that is not answering must not be able to hold a pass
 * open for longer than the mail server could. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** How much of a provider's error_description is carried into an error
 * message. Enough for Microsoft's AADSTS codes, short enough that a
 * mail_accounts.last_error stays a sentence. */
const MAX_DESCRIPTION_CHARS = 160;

export interface HttpTokenRefresherOptions {
  /** Test seam: the fetch implementation. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * The real refresher: an RFC 6749 section 6 refresh_token grant, client
 * credentials in the body.
 *
 * CLIENT SECRET IN THE BODY, NOT IN A BASIC AUTHORIZATION HEADER. RFC 6749
 * 2.3.1 permits both and prefers the header; Microsoft's v2.0 endpoint and
 * Google's both document the body form and both accept it, and one code path
 * that works at both providers is worth more here than a preference. It travels
 * over TLS either way.
 *
 * NOTHING IS LOGGED FROM HERE, at all. The request body holds a refresh token
 * and a client secret and the response holds an access token; there is no level
 * at which any of it is worth a log line, and the errors this throws are built
 * from the provider's error CODE and description only.
 */
export function createHttpTokenRefresher(
  clients: MailOAuthClients, options: HttpTokenRefresherOptions = {},
): MailTokenRefresher {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;

  return async (provider, refreshToken) => {
    const client = clients[provider];
    if (client === undefined) {
      // NOT a reauth error: signing in again cannot fix an install that has no
      // app registration for this provider, and it is not a connection failure
      // either. An operator-fixable deployment gap, in the shape
      // MailKeyMissingError has -- named plainly, in mail_accounts.last_error,
      // where the operator will read it.
      throw new Error(
        `mail OAuth is not configured for ${provider} on this install:`
        + ` set MAIL_OAUTH_${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET`,
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });

    let response: Response;
    try {
      response = await doFetch(client.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // DNS, TLS, a refused connection, the timeout above. Classified
      // `connection:` so it lands in the settings UI as "server unreachable"
      // and, more importantly, so it is NOT mistaken for a dead grant: the
      // whole difference between the two is whether backing off will help.
      throw new Error(
        `${MAIL_CONNECTION_ERROR_PREFIX} could not reach ${provider}'s token endpoint`
        + ` (${errorText(error)})`,
        { cause: error },
      );
    }

    const payload = await readJson(response);
    // The two secrets this request carried, handed to the error builder so it
    // can scrub them out of whatever the endpoint says back. See redact.
    if (!response.ok) {
      throw tokenErrorFor(provider, response.status, payload, [refreshToken, client.clientSecret]);
    }

    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 0;
    if (accessToken === "" || expiresIn <= 0) {
      // A 200 whose body is not a token response. Not a dead grant and not a
      // network failure -- something is answering at that URL that is not the
      // provider's token endpoint (a captive portal, a proxy, a typo'd tenant),
      // and saying so is more use than "authentication failed".
      throw new Error(
        `${provider}'s token endpoint answered ${response.status} without a usable access token`,
      );
    }
    return {
      accessToken,
      expiresInSeconds: expiresIn,
      ...(typeof payload.refresh_token === "string" && payload.refresh_token !== ""
        ? { refreshToken: payload.refresh_token }
        : {}),
    };
  };
}

/** The error body, or an empty object when the endpoint did not answer JSON
 * (an HTML error page from a proxy is the ordinary case). */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * The right error for a non-2xx from the token endpoint.
 *
 * A 5xx IS TRANSIENT WHATEVER IT SAYS. Providers have outages, and an outage
 * that latched an account into "sign in again" would send the operator through
 * a browser consent flow to fix something that fixed itself. Only a 4xx is
 * evidence about the grant, and only then when the code says so.
 */
function tokenErrorFor(
  provider: MailOAuthProvider, status: number, payload: Record<string, unknown>,
  secrets: readonly string[],
): Error {
  const code = typeof payload.error === "string" ? payload.error : "";
  const rawDescription = redact(
    typeof payload.error_description === "string" ? payload.error_description : "", secrets,
  );
  const description = rawDescription.length > MAX_DESCRIPTION_CHARS
    ? `${rawDescription.slice(0, MAX_DESCRIPTION_CHARS)}...`
    : rawDescription;
  const detail = [code === "" ? `HTTP ${status}` : code, description]
    .filter((part) => part !== "").join(": ");

  if (status >= 500) {
    return new Error(
      `${MAIL_CONNECTION_ERROR_PREFIX} ${provider}'s token endpoint failed (${detail})`,
    );
  }
  if (GRANT_DEAD_CODES.has(code)) return new MailReauthRequiredError(provider, detail);
  // A 4xx that is not about the grant: the registration, the scopes, or a
  // request this code built wrong. Unclassified on purpose -- neither `auth:`
  // (which tells the UI to point at a password field this account does not
  // have) nor `connection:` (which says retry, and retrying a wrong client
  // secret is pointless) is true of it.
  return new Error(`${provider} refused to renew this account's sign-in (${detail})`);
}

/**
 * Remove this request's own secrets from text the PROVIDER wrote.
 *
 * FOUND BY A TEST, NOT REASONED ABOUT. The description that reaches an error
 * here travels into mail_accounts.last_error, which routes/mail.ts returns and
 * the settings page renders verbatim -- so an endpoint that echoed the refresh
 * token back would put it on a screen and in a database column, breaking the
 * one rule the spec states about it in as many words. Microsoft and Google do
 * not echo it; "they do not" is an assumption about somebody else's code, and
 * the cost of being wrong is not recoverable once the row is written.
 *
 * Substring replacement, and secrets shorter than 8 characters are skipped: a
 * short one would be a misconfiguration rather than a credential, and scrubbing
 * it would blank out ordinary words in a sentence that has to stay readable.
 * The empty string is excluded by the same bound -- replacing it would splice a
 * marker between every character.
 */
function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
