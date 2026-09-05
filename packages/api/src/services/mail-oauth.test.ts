import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX, type MailAccountCreateInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts } from "../db/schema.js";
import { MailAuthMethodMismatchError, MailReauthRequiredError } from "./errors.js";
import { createAccount } from "./mail-accounts.js";
import { decryptCredentialsAt, encryptCredentialsAt, type MailCredentials } from "./mail-crypto.js";
import {
  TOKEN_EXPIRY_SKEW_MS, createHttpTokenRefresher, oauthClientsFrom, resolveConnectionAuth,
  unconfiguredTokenRefresher, type MailConnectionAuthDeps, type MailOAuthClient,
  type MailTokenGrant, type MailTokenRefresher,
} from "./mail-oauth.js";

/**
 * Phase 8 Task 2. Two halves, and they are tested against different things
 * because they fail in different ways.
 *
 * `resolveConnectionAuth` is tested against a REAL DATABASE and a fake token
 * endpoint: what it decides (use the cache, or refresh) and what it writes back
 * are the interesting parts, and the write-back is the one with a
 * compare-and-set in it that no in-memory double would exercise honestly.
 *
 * `createHttpTokenRefresher` is tested against a fake `fetch`, because the real
 * one talks to Microsoft and Google. What is pinned there is CLASSIFICATION --
 * which provider answers become "sign in again" and which do not -- since
 * getting that wrong in either direction is the whole failure this task exists
 * to prevent: too eager and an outage sends an operator through a browser
 * consent flow for nothing; too shy and a dead grant reads as a server having a
 * bad day, for ever.
 */

const handle = openTestDatabase();
let actorId: string;
let dir: string;
let keyPath: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-oauth-"));
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
afterAll(async () => { await handle.close(); });

const baseInput: MailAccountCreateInput = {
  label: "Work", email: "chris@example.com",
  imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
  smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "imap-half", smtpPassword: "smtp-half",
};

/**
 * An OAuth account, made the only way one can be made today: a password
 * account, then a direct write of the column and the blob TOGETHER.
 *
 * That pairing is the point of doing it here rather than through a service.
 * Nothing in v1.7.0 Task 2 can create an OAuth account -- there is no route, no
 * form and no writer -- so this fixture stands in for Task 3's callback, and it
 * writes both facts in one statement precisely because writing one without the
 * other is the state MailAuthMethodMismatchError exists to catch.
 */
async function makeOAuthAccount(credentials: {
  refreshToken: string; accessToken?: string; accessTokenExpiresAt?: string;
}, authMethod = "oauth_microsoft"): Promise<string> {
  const account = await createAccount(handle.db, actorId, baseInput, keyPath);
  await handle.db.update(mailAccounts).set({
    authMethod,
    credentialsCiphertext: encryptCredentialsAt(keyPath, { kind: "oauth", ...credentials }),
  }).where(eq(mailAccounts.id, account.id));
  return account.id;
}

async function storedCredentials(id: string): Promise<MailCredentials> {
  const [row] = await handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  return decryptCredentialsAt(keyPath, row!.credentialsCiphertext);
}

const NOW = new Date("2026-09-05T12:00:00.000Z");

function deps(
  refresh: MailTokenRefresher, now: Date = NOW,
): MailConnectionAuthDeps {
  return { db: handle.db, mailKeyPath: keyPath, refresh, now: () => now };
}

/** A refresher that must not be called; every password case uses it. */
const neverRefresh: MailTokenRefresher = () => {
  throw new Error("the token endpoint was contacted when it should not have been");
};

function grants(...responses: MailTokenGrant[]): {
  refresh: MailTokenRefresher; calls: { provider: string; refreshToken: string }[];
} {
  const calls: { provider: string; refreshToken: string }[] = [];
  let index = 0;
  return {
    calls,
    refresh: (provider, refreshToken) => {
      calls.push({ provider, refreshToken });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response!);
    },
  };
}

// --- Password accounts: the path that must not change -----------------------

describe("resolveConnectionAuth: password accounts", () => {
  /**
   * WHICH HALF REACHES WHICH PROTOCOL. Task 1 found that nothing asserted this
   * anywhere -- a mutation replacing the IMAP password with `""` passed the
   * whole sync suite -- and moving the choice into this module would have moved
   * the hole with it. Both halves, both directions, in one file.
   */
  it("hands IMAP the imap half and SMTP the smtp half", async () => {
    const account = await createAccount(handle.db, actorId, baseInput, keyPath);
    const credentials = await storedCredentials(account.id);

    await expect(resolveConnectionAuth(deps(neverRefresh), account, credentials, "imap"))
      .resolves.toEqual({ kind: "password", password: "imap-half" });
    await expect(resolveConnectionAuth(deps(neverRefresh), account, credentials, "smtp"))
      .resolves.toEqual({ kind: "password", password: "smtp-half" });
  });

  it("never contacts a token endpoint", async () => {
    const account = await createAccount(handle.db, actorId, baseInput, keyPath);
    const credentials = await storedCredentials(account.id);
    // neverRefresh throws synchronously, so a resolved promise IS the proof.
    await expect(resolveConnectionAuth(deps(neverRefresh), account, credentials, "imap"))
      .resolves.toMatchObject({ kind: "password" });
  });

  /**
   * The column and the blob are written together (Task 3's callback) and this
   * is what happens if some future writer sets one and not the other. Both
   * directions, because a guard that only catches one of them is a guard that
   * gives false confidence about the other.
   */
  it("refuses an account whose auth_method and stored credential disagree", async () => {
    const account = await createAccount(handle.db, actorId, baseInput, keyPath);
    const passwordCredentials = await storedCredentials(account.id);

    await expect(resolveConnectionAuth(
      deps(neverRefresh), { id: account.id, authMethod: "oauth_microsoft" }, passwordCredentials, "imap",
    )).rejects.toThrow(MailAuthMethodMismatchError);

    await expect(resolveConnectionAuth(
      deps(neverRefresh), { id: account.id, authMethod: "password" },
      { kind: "oauth", refreshToken: "r" }, "imap",
    )).rejects.toThrow(MailAuthMethodMismatchError);
  });
});

// --- OAuth accounts: the cache decision -------------------------------------

describe("resolveConnectionAuth: the cached access token", () => {
  it("uses a stored token that is comfortably in date, without a refresh", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "cached-token",
      accessTokenExpiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    });
    const credentials = await storedCredentials(id);

    await expect(resolveConnectionAuth(
      deps(neverRefresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "cached-token" });
  });

  it("refreshes when there is no cached token at all -- the state right after signing in", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const credentials = await storedCredentials(id);
    const { refresh, calls } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "fresh" });
    expect(calls).toEqual([{ provider: "microsoft", refreshToken: "refresh-1" }]);
  });

  it("refreshes an expired token", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "stale",
      accessTokenExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
    });
    const credentials = await storedCredentials(id);
    const { refresh } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "fresh" });
  });

  /**
   * THE SKEW, PINNED FROM BOTH SIDES. A token expiring in 30 seconds is valid
   * by the clock and useless in practice -- the connect, the TLS handshake and
   * the greeting all happen before it is presented -- and using it produces an
   * authentication failure, which the settings UI renders as "check the
   * username/password" for an account that has no password. One case either
   * side of the boundary, so a mutation that deletes the skew (or inverts the
   * comparison) fails rather than merely looking different.
   */
  it("treats a token inside the expiry skew as already gone", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "nearly-gone",
      accessTokenExpiresAt: new Date(NOW.getTime() + TOKEN_EXPIRY_SKEW_MS - 1_000).toISOString(),
    });
    const credentials = await storedCredentials(id);
    const { refresh, calls } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "fresh" });
    expect(calls).toHaveLength(1);
  });

  /**
   * AN ABSOLUTE NUMBER, BECAUSE THE TWO CASES AROUND IT ARE SELF-REFERENTIAL.
   * They build their fixtures out of TOKEN_EXPIRY_SKEW_MS, so a mutation that
   * sets the constant to ZERO moves the boundary AND both fixtures together and
   * they keep passing -- which is exactly what happened when this file was
   * mutation-tested. The behavioural half is a token expiring in half a minute:
   * valid by the clock, useless in practice, and a refresh is the only right
   * answer. The value is pinned beside it so a silent narrowing is a red test
   * rather than an intermittent authentication failure months later.
   */
  it("refreshes a token with only 30 seconds left, which cannot survive a connect", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "thirty-seconds-left",
      accessTokenExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    });
    const credentials = await storedCredentials(id);
    const { refresh, calls } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "fresh" });
    expect(calls).toHaveLength(1);
    expect(TOKEN_EXPIRY_SKEW_MS).toBe(60_000);
  });

  it("keeps a token that is just outside the skew", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "still-good",
      accessTokenExpiresAt: new Date(NOW.getTime() + TOKEN_EXPIRY_SKEW_MS + 1_000).toISOString(),
    });
    const credentials = await storedCredentials(id);

    await expect(resolveConnectionAuth(
      deps(neverRefresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "still-good" });
  });

  it("asks Google's endpoint for a Google account", async () => {
    const id = await makeOAuthAccount({ refreshToken: "g-refresh" }, "oauth_google");
    const credentials = await storedCredentials(id);
    const { refresh, calls } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await resolveConnectionAuth(deps(refresh), { id, authMethod: "oauth_google" }, credentials, "imap");
    expect(calls).toEqual([{ provider: "google", refreshToken: "g-refresh" }]);
  });

  /** One token authenticates both protocols; there is no second exchange for
   * the SMTP side and no second half to pick. */
  it("gives SMTP the same access token IMAP gets", async () => {
    const id = await makeOAuthAccount({
      refreshToken: "refresh-1",
      accessToken: "one-token",
      accessTokenExpiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    });
    const credentials = await storedCredentials(id);

    await expect(resolveConnectionAuth(
      deps(neverRefresh), { id, authMethod: "oauth_microsoft" }, credentials, "smtp",
    )).resolves.toEqual({ kind: "oauth", accessToken: "one-token" });
  });
});

// --- What a refresh writes back ---------------------------------------------

describe("resolveConnectionAuth: persisting a refreshed token", () => {
  it("stores the new token with an expiry anchored to this server's clock", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const credentials = await storedCredentials(id);
    const { refresh } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await resolveConnectionAuth(deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap");

    expect(await storedCredentials(id)).toEqual({
      kind: "oauth",
      refreshToken: "refresh-1",
      accessToken: "fresh",
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
    });
  });

  /**
   * ROTATION, AND WHY DROPPING IT WOULD LOOK LIKE AN EXPIRED GRANT. Microsoft
   * returns a fresh refresh token on every refresh and may retire the old one.
   * An install that kept the old one would work while the provider's grace
   * period lasted and then start answering `invalid_grant` -- indistinguishable,
   * from the operator's side, from the revocation this whole feature exists to
   * report, and fixed by a sign-in that then breaks again.
   */
  it("stores a rotated refresh token, and uses it on the next refresh", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const { refresh, calls } = grants(
      { accessToken: "fresh-1", expiresInSeconds: 3600, refreshToken: "refresh-2" },
      { accessToken: "fresh-2", expiresInSeconds: 3600 },
    );

    await resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, await storedCredentials(id), "imap",
    );
    expect(await storedCredentials(id)).toMatchObject({ refreshToken: "refresh-2" });

    // Second pass, an hour later, so the cached token is out of date.
    const later = new Date(NOW.getTime() + 3600 * 1000);
    await resolveConnectionAuth(
      deps(refresh, later), { id, authMethod: "oauth_microsoft" }, await storedCredentials(id), "imap",
    );
    expect(calls.map((call) => call.refreshToken)).toEqual(["refresh-1", "refresh-2"]);
  });

  it("keeps the existing refresh token when the provider rotates nothing", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const { refresh } = grants({ accessToken: "fresh", expiresInSeconds: 3600 });

    await resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, await storedCredentials(id), "imap",
    );
    expect(await storedCredentials(id)).toMatchObject({ refreshToken: "refresh-1" });
  });

  /**
   * THE COMPARE-AND-SET, AND THE RACE IT EXISTS FOR. The sync loop and a send
   * can both refresh at once, both starting from refresh token R. If the
   * provider rotated for the other one first, this call's stored view of R is
   * already retired, and writing it back would put a dead refresh token in the
   * row -- an account stranded until somebody signs in again, caused by
   * Conduit's own bookkeeping rather than by anything the provider did.
   *
   * Driven by making the row change UNDERNEATH an in-flight refresh, which is
   * exactly the shape of the race: the refresher itself does the interfering
   * write, in the gap between the caller's read and the write-back.
   */
  it("does not overwrite a refresh token another writer rotated while this one was in flight", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const credentials = await storedCredentials(id);

    const refresh: MailTokenRefresher = async () => {
      // The other writer wins the race, storing its own rotated token.
      await handle.db.update(mailAccounts).set({
        credentialsCiphertext: encryptCredentialsAt(keyPath, {
          kind: "oauth", refreshToken: "refresh-from-the-other-writer",
          accessToken: "theirs", accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
        }),
      }).where(eq(mailAccounts.id, id));
      return { accessToken: "mine", expiresInSeconds: 3600 };
    };

    // This call still gets a usable token -- its own exchange succeeded.
    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "mine" });
    // ...and the row keeps the newer writer's refresh token, not the stale one.
    expect(await storedCredentials(id)).toMatchObject({
      refreshToken: "refresh-from-the-other-writer",
      accessToken: "theirs",
    });
  });

  /** A deleted account must not turn a cache update into a failed pass: the
   * token this call is holding is valid regardless of whether the row survives
   * to record it. */
  it("still returns a token when the account row vanished mid-refresh", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const credentials = await storedCredentials(id);
    const refresh: MailTokenRefresher = async () => {
      await handle.db.delete(mailAccounts).where(eq(mailAccounts.id, id));
      return { accessToken: "fresh", expiresInSeconds: 3600 };
    };

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).resolves.toEqual({ kind: "oauth", accessToken: "fresh" });
  });

  /**
   * A DEAD GRANT LEAVES THE STORED REFRESH TOKEN ALONE. When the operator
   * re-authorises, Task 3 overwrites it; until then, destroying it here would
   * remove the only evidence of which grant lapsed and would make the failure
   * unrecoverable from a database backup taken after the fact.
   */
  it("writes nothing when the refresh is refused", async () => {
    const id = await makeOAuthAccount({ refreshToken: "refresh-1" });
    const credentials = await storedCredentials(id);
    const refresh: MailTokenRefresher = () => {
      throw new MailReauthRequiredError("microsoft", "invalid_grant");
    };

    await expect(resolveConnectionAuth(
      deps(refresh), { id, authMethod: "oauth_microsoft" }, credentials, "imap",
    )).rejects.toThrow(MailReauthRequiredError);
    expect(await storedCredentials(id)).toEqual({ kind: "oauth", refreshToken: "refresh-1" });
  });
});

// --- The default refresher ---------------------------------------------------

describe("unconfiguredTokenRefresher", () => {
  /** A seam whose default answer is "fine" is the shape of vacuous assertion
   * this project keeps finding; this one refuses and says which provider. */
  it("refuses, naming the provider, rather than returning nothing", () => {
    expect(() => unconfiguredTokenRefresher("google", "r")).toThrow(/google/);
  });
});

// --- The real token endpoint -------------------------------------------------

// A whole registration, including the two fields Task 3 added and this file
// never reads: the refresher uses three of the five, and typing the fixture as
// the real MailOAuthClient is what keeps that "never reads" honest rather than
// a claim -- a refresh that started sending redirect_uri would still compile
// against a narrower literal.
const CLIENTS = {
  microsoft: {
    clientId: "client-id", clientSecret: "client-secret",
    tokenEndpoint: "https://login.microsoftonline.example/tenant/oauth2/v2.0/token",
    authorizeEndpoint: "https://login.microsoftonline.example/tenant/oauth2/v2.0/authorize",
    redirectUri: "https://conduit.example/api/mail/oauth/callback",
  } satisfies MailOAuthClient,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/** Records the request and answers with `response`. */
function fakeFetch(response: Response | (() => never)): {
  fetch: typeof globalThis.fetch; requests: { url: string; body: string }[];
} {
  const requests: { url: string; body: string }[] = [];
  return {
    requests,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") });
      if (typeof response === "function") response();
      return response;
    }) as unknown as typeof globalThis.fetch,
  };
}

describe("createHttpTokenRefresher", () => {
  it("posts an RFC 6749 refresh_token grant with the client credentials", async () => {
    const { fetch, requests } = fakeFetch(jsonResponse(200, {
      access_token: "fresh", expires_in: 3599, token_type: "Bearer",
    }));
    const refresh = createHttpTokenRefresher(CLIENTS, { fetch });

    await expect(refresh("microsoft", "refresh-1")).resolves.toEqual({
      accessToken: "fresh", expiresInSeconds: 3599,
    });
    expect(requests[0]?.url).toBe(CLIENTS.microsoft.tokenEndpoint);
    const sent = new URLSearchParams(requests[0]?.body ?? "");
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("carries a rotated refresh token through", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, {
      access_token: "fresh", expires_in: 3599, refresh_token: "refresh-2",
    }));
    await expect(createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1"))
      .resolves.toMatchObject({ refreshToken: "refresh-2" });
  });

  /**
   * THE ONE CLASSIFICATION THE WHOLE TASK RESTS ON. `invalid_grant` is the code
   * both providers answer for a revoked, expired or superseded refresh token,
   * and it is the only one that means a PERSON has to act.
   */
  it("turns invalid_grant into a re-authorisation, naming the provider", async () => {
    const { fetch } = fakeFetch(jsonResponse(400, {
      error: "invalid_grant",
      error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
    }));
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(MailReauthRequiredError);
    expect((error as MailReauthRequiredError).message)
      .toContain("microsoft would not renew this account's sign-in");
    expect((error as MailReauthRequiredError).message).toContain("Sign in again");
    expect((error as MailReauthRequiredError).reason).toContain("AADSTS700082");
  });

  /**
   * THE OTHER DIRECTION, AND IT IS THE HALF THAT IS EASY TO GET WRONG. A wrong
   * client secret, a scope that was never granted and a malformed request are
   * all 400s from the same endpoint, and telling the operator to sign in again
   * for any of them sends them away from the thing that is broken -- the second
   * sign-in fails identically. Each is checked by name rather than "some other
   * 400", so widening GRANT_DEAD_CODES cannot pass silently.
   */
  it.each(["invalid_client", "unauthorized_client", "invalid_scope", "invalid_request"])(
    "does NOT ask for a re-authorisation over %s, which signing in cannot fix",
    async (code) => {
      const { fetch } = fakeFetch(jsonResponse(400, { error: code, error_description: "nope" }));
      const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
        .then(() => null, (err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MailReauthRequiredError);
      expect((error as Error).message).toContain(code);
    },
  );

  /** A provider outage that latched an account into "sign in again" would send
   * an operator through a consent flow to fix something that fixed itself. */
  it("treats a 5xx as a transient connection failure, whatever the body says", async () => {
    const { fetch } = fakeFetch(jsonResponse(503, { error: "invalid_grant" }));
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err);

    expect(error).not.toBeInstanceOf(MailReauthRequiredError);
    expect((error as Error).message).toMatch(/^connection:/);
  });

  it("treats an unreachable endpoint as a connection failure", async () => {
    const { fetch } = fakeFetch(() => { throw new Error("getaddrinfo ENOTFOUND"); });
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err);

    expect(error).not.toBeInstanceOf(MailReauthRequiredError);
    expect((error as Error).message).toMatch(/^connection:/);
  });

  /** A 200 from something that is not the token endpoint -- a captive portal, a
   * proxy, a typo'd tenant -- must not become an empty access token handed to a
   * mail server, which would arrive as an authentication failure pointing at a
   * password that does not exist. */
  it("refuses a 200 with no usable access token", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { hello: "world" }));
    await expect(createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1"))
      .rejects.toThrow(/without a usable access token/);
  });

  it("refuses a 200 whose token has no lifetime, rather than caching it for ever", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { access_token: "fresh" }));
    await expect(createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1"))
      .rejects.toThrow(/without a usable access token/);
  });

  it("survives an error body that is not JSON at all", async () => {
    const { fetch } = fakeFetch(new Response("<html>gateway timeout</html>", { status: 502 }));
    await expect(createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1"))
      .rejects.toThrow(/^connection:/);
  });

  it("says which install-side setting is missing when a provider has no registration", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { access_token: "x", expires_in: 60 }));
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("google", "refresh-1")
      .then(() => null, (err: unknown) => err);

    expect(error).not.toBeInstanceOf(MailReauthRequiredError);
    expect((error as Error).message).toContain("MAIL_OAUTH_GOOGLE_CLIENT_ID");
    expect((error as Error).message).toContain("MAIL_OAUTH_GOOGLE_CLIENT_SECRET");
  });

  /**
   * MICROSOFT'S THIRD SETTING, NAMED. config.ts treats a Microsoft registration
   * with no tenant as no registration at all -- deliberately, because /common is
   * the MULTI-tenant endpoint and falling back to it would authenticate against
   * the wrong directory. So an operator who has set the id and the secret and
   * lands here needs to be told which of the three is still missing; a sentence
   * naming only the two they already set would send them to check something
   * that is fine, which is the shape of misdirection this whole task is about.
   */
  it("names the tenant too for Microsoft, since that is what makes a registration incomplete", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { access_token: "x", expires_in: 60 }));
    const error = await createHttpTokenRefresher({}, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err);

    expect((error as Error).message).toContain("_TENANT");
  });

  /**
   * NO SECRET REACHES AN ERROR MESSAGE, checked against a HOSTILE endpoint that
   * echoes both back in its error_description. Real providers do not, but
   * "they do not" is an assumption about somebody else's code, and the cost of
   * it being wrong is a refresh token in mail_accounts.last_error -- a column
   * this app renders verbatim in Settings.
   */
  it("never lets a token or a client secret into the error it throws", async () => {
    const { fetch } = fakeFetch(jsonResponse(400, {
      error: "invalid_grant",
      error_description: "rejected refresh_token=refresh-1 for client-secret",
    }));
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err) as Error;

    expect(error.message).not.toContain("refresh-1");
    expect(error.message).not.toContain("client-secret");
  });

  /** last_error is 500 characters and is rendered as a sentence; a provider
   * that answers with an essay must not become the whole row. */
  it("truncates a provider's error_description", async () => {
    const { fetch } = fakeFetch(jsonResponse(400, {
      error: "invalid_grant", error_description: "x".repeat(5000),
    }));
    const error = await createHttpTokenRefresher(CLIENTS, { fetch })("microsoft", "refresh-1")
      .then(() => null, (err: unknown) => err) as MailReauthRequiredError;

    expect(error.reason.length).toBeLessThanOrEqual(MailReauthRequiredError.MAX_REASON_LENGTH);
  });
});

describe("MailReauthRequiredError's message", () => {
  /**
   * NEITHER CLASSIFIED PREFIX, AND IT IS AN INVARIANT OTHER CODE DEPENDS ON.
   * mail-send.ts's smtpFailureReason routes anything carrying `auth:` into
   * "the mail server rejected this account's credentials" and anything carrying
   * `connection:` into "could not be reached"; a lapsed grant is neither, and it
   * reaches the composer intact ONLY because this message starts with plain
   * prose. The settings UI's friendlyMailError does the same substitution on
   * last_error.
   *
   * So an edit that made this message start with `auth:` -- a plausible one,
   * since a refused grant IS an authentication problem -- would silently
   * replace "sign in again" with "check the username/password", pointing an
   * operator at a field the account has never had. Pinned here rather than
   * guarded with an `instanceof` branch at each consumer: a branch is one place
   * to forget, and mutating one away changed nothing that any test saw.
   */
  it("starts with neither classified prefix, so nothing rewrites it", () => {
    const message = new MailReauthRequiredError("microsoft", "invalid_grant").message;
    expect(message.startsWith(MAIL_AUTH_ERROR_PREFIX)).toBe(false);
    expect(message.startsWith(MAIL_CONNECTION_ERROR_PREFIX)).toBe(false);
    expect(message).toContain("Sign in again");
  });
});

describe("oauthClientsFrom", () => {
  it("drops a provider this install has not registered, rather than carrying a null", () => {
    expect(oauthClientsFrom({ microsoft: CLIENTS.microsoft, google: null }))
      .toEqual({ microsoft: CLIENTS.microsoft });
    expect(oauthClientsFrom({ microsoft: null, google: null })).toEqual({});
  });
});
