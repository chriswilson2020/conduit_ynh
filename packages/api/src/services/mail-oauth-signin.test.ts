import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { MailAccountCreateInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts } from "../db/schema.js";
import {
  createAccount, replaceOAuthCredentials, setAccountChangedHook, updateAccount,
} from "./mail-accounts.js";
import { ArchivedError } from "./errors.js";
import { decryptCredentialsAt, encryptCredentialsAt } from "./mail-crypto.js";
import type { MailOAuthClient, MailTokenGrant } from "./mail-oauth.js";
import {
  MailOAuthNotConfiguredError, MailOAuthStates, MissingRefreshTokenError, SIGNIN_STATE_TTL_MS,
  buildAuthorizeUrl, completeSignin, configuredProviders, connectionFor, createHttpCodeExchanger,
  providerDisplayName, startSignin,
  type MailOAuthCodeExchanger, type SigninDeps, type SigninTarget,
} from "./mail-oauth-signin.js";

/**
 * Phase 8 Task 3.
 *
 * THE MAJORITY OF THIS FILE IS ABOUT `state`, AND THAT IS PROPORTIONATE. Every
 * other failure here costs an operator a second attempt; a callback that
 * accepts the wrong state attaches somebody else's mailbox to this install's
 * account and nothing on screen says so. So the forged, the expired, the
 * replayed and the foreign-user callback each get their own case, and each one
 * asserts that NOTHING HAPPENED -- no exchange, no row -- rather than merely
 * that the answer was a refusal.
 *
 * The provider round trip itself is a fake, for the reason Task 2's is: the
 * real one is an HTTPS request to Microsoft, and a test that mocked it deeply
 * enough to be interesting would be testing the mock.
 */

const handle = openTestDatabase();
let actorId: string;
let otherActorId: string;
let dir: string;
let keyPath: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  otherActorId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-oauth-signin-"));
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
afterAll(async () => { await handle.close(); });

const MICROSOFT: MailOAuthClient = {
  clientId: "client-id", clientSecret: "client-secret",
  tokenEndpoint: "https://login.microsoftonline.example/tenant/oauth2/v2.0/token",
  authorizeEndpoint: "https://login.microsoftonline.example/tenant/oauth2/v2.0/authorize",
  redirectUri: "https://conduit.example/api/mail/oauth/callback",
};
const GOOGLE: MailOAuthClient = {
  clientId: "g-id", clientSecret: "g-secret",
  tokenEndpoint: "https://oauth2.googleapis.example/token",
  authorizeEndpoint: "https://accounts.google.example/o/oauth2/v2/auth",
  redirectUri: "https://conduit.example/api/mail/oauth/callback",
};

const NOW = new Date("2026-09-05T12:00:00.000Z");

const REFRESH_TOKEN = "refresh-token-that-must-never-escape";
const ACCESS_TOKEN = "access-token-that-must-never-escape";

/** An exchanger that records what it was asked and answers `grant`. */
function exchanger(grant?: Partial<MailTokenGrant>): {
  exchange: MailOAuthCodeExchanger; calls: { code: string; codeVerifier: string }[];
} {
  const calls: { code: string; codeVerifier: string }[] = [];
  return {
    calls,
    exchange: (_provider, code, codeVerifier) => {
      calls.push({ code, codeVerifier });
      return Promise.resolve({
        accessToken: ACCESS_TOKEN, expiresInSeconds: 3600, refreshToken: REFRESH_TOKEN, ...grant,
      });
    },
  };
}

/** An exchanger that must not be called. Used by every case whose whole point
 * is that the provider was never contacted. */
const neverExchange: MailOAuthCodeExchanger = () => {
  throw new Error("the token endpoint was contacted when it should not have been");
};

function deps(
  exchange: MailOAuthCodeExchanger,
  overrides: Partial<SigninDeps> = {},
): SigninDeps {
  return {
    db: handle.db, mailKeyPath: keyPath,
    clients: { microsoft: MICROSOFT, google: GOOGLE },
    states: new MailOAuthStates(),
    exchange,
    now: () => NOW,
    ...overrides,
  };
}

const CREATE_TARGET: SigninTarget & { provider: "microsoft" } = {
  kind: "create", provider: "microsoft", label: "Work", email: "chris@contoso.example",
};

/** The `state` out of an authorise URL, which is the only way a caller ever
 * learns one -- the store hands it to the URL builder and nothing else. */
function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state") ?? "";
}

const baseInput: MailAccountCreateInput = {
  label: "Old", email: "chris@example.com",
  imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
  smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "imap-half", smtpPassword: "smtp-half",
};

/** An account already signed in with a provider, made the way Task 3's own
 * callback makes one. Uses the real writer rather than a hand-built row, so
 * these cases cannot pass against a shape the service would not produce. */
async function makeOAuthAccount(email = "chris@contoso.example"): Promise<string> {
  const d = deps(exchanger().exchange);
  const { authorizeUrl } = await startSignin(d, actorId, { ...CREATE_TARGET, email });
  const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
  expect(result.outcome).toBe("connected");
  return result.accountId as string;
}

async function rowOf(id: string) {
  const [row] = await handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  return row!;
}

async function accountCount(): Promise<number> {
  return (await handle.db.select().from(mailAccounts)).length;
}

// --- The state store --------------------------------------------------------

describe("MailOAuthStates", () => {
  const record = (userId: string) => ({
    userId, provider: "microsoft" as const, target: CREATE_TARGET, codeVerifier: "v",
  });

  it("mints an unguessable value: 64 hex characters, never twice the same", () => {
    const states = new MailOAuthStates();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const state = states.issue(record(actorId));
      expect(state).toMatch(/^[0-9a-f]{64}$/);
      seen.add(state);
    }
    // 50 mints from 32 bytes of CSPRNG collide with probability far below
    // anything worth a flake; a collision here means the value is derived from
    // something, which is the failure this case is looking for.
    expect(seen.size).toBe(50);
  });

  it("redeems once and only once", () => {
    const states = new MailOAuthStates();
    const state = states.issue(record(actorId));
    expect(states.redeem(state, actorId)?.userId).toBe(actorId);
    expect(states.redeem(state, actorId)).toBeNull();
  });

  it("refuses a state belonging to another user, AND spends it doing so", () => {
    const states = new MailOAuthStates();
    const state = states.issue(record(actorId));
    expect(states.redeem(state, otherActorId)).toBeNull();
    // THE SECOND HALF IS THE POINT. A state presented by the wrong identity has
    // been somewhere it should not have been; leaving it live so the right one
    // could still spend it would let a stolen value be tried at every identity
    // for the price of one. Same rule, same reason, as ReauthTickets.redeem.
    expect(states.redeem(state, actorId)).toBeNull();
  });

  it("refuses a state that never existed", () => {
    expect(new MailOAuthStates().redeem("a".repeat(64), actorId)).toBeNull();
  });

  it("expires exactly at the TTL, not after it", () => {
    const states = new MailOAuthStates();
    const issuedAt = 1_000_000;
    const state = states.issue(record(actorId), issuedAt);
    // One millisecond before the boundary it still works; AT the boundary it
    // does not. `<=` against `<` is a one-character mutation and this is what
    // catches it.
    const almost = new MailOAuthStates();
    const other = almost.issue(record(actorId), issuedAt);
    expect(almost.redeem(other, actorId, issuedAt + SIGNIN_STATE_TTL_MS - 1)).not.toBeNull();
    expect(states.redeem(state, actorId, issuedAt + SIGNIN_STATE_TTL_MS)).toBeNull();
  });

  it("sweeps expired states rather than holding them for ever", () => {
    const states = new MailOAuthStates();
    for (let i = 0; i < 3; i += 1) states.issue(record(actorId), 1_000);
    expect(states.size(1_000)).toBe(3);
    expect(states.size(1_000 + SIGNIN_STATE_TTL_MS)).toBe(0);
  });

  it("caps one user at eight outstanding, dropping their OWN oldest", () => {
    const states = new MailOAuthStates();
    const mine: string[] = [];
    for (let i = 0; i < 9; i += 1) mine.push(states.issue(record(actorId)));
    expect(states.size()).toBe(8);
    // The oldest went, the newest stayed: a flood must not lock out the person
    // already waiting at a consent screen.
    expect(states.redeem(mine[0]!, actorId)).toBeNull();
    expect(states.redeem(mine[8]!, actorId)).not.toBeNull();
  });

  it("does not let one user's flood evict another user's state", () => {
    const states = new MailOAuthStates();
    const theirs = states.issue(record(otherActorId));
    for (let i = 0; i < 8; i += 1) states.issue(record(actorId));
    expect(states.redeem(theirs, otherActorId)).not.toBeNull();
  });
});

// --- The authorise URL ------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  const params = { state: "the-state", codeChallenge: "the-challenge", loginHint: "chris@contoso.example" };

  it("asks Microsoft for the two mail scopes and offline_access, and nothing else", () => {
    const url = new URL(buildAuthorizeUrl("microsoft", MICROSOFT, params));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toEqual([
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
    ]);
    // THE ABSENCE IS THE ASSERTION. Task 2's note at the refresh call site: the
    // refresh sends no `scope`, which is right, and Microsoft then picks the
    // audience from what the GRANT covers. An `openid`/`email`/`profile` or a
    // Graph scope here makes the grant multi-resource and can hand the refresh
    // a token IMAP refuses -- a nameless auth failure on every renewal, months
    // after anybody edited this list.
    for (const forbidden of ["openid", "email", "profile", "https://graph.microsoft.com/.default"]) {
      expect(scopes).not.toContain(forbidden);
    }
  });

  it("asks Google for full mailbox access, offline, with consent forced", () => {
    const url = new URL(buildAuthorizeUrl("google", GOOGLE, params));
    expect(url.searchParams.get("scope")).toBe("https://mail.google.com/");
    // Both are mandatory rather than stylistic: access_type is how Google is
    // asked for a refresh token at all, and prompt=consent is what makes it
    // issue one AGAIN on a re-authorisation. Without the second, "Sign in
    // again" completes and stores nothing usable.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("carries the state, the S256 challenge, the registered redirect URI and the login hint", () => {
    const url = new URL(buildAuthorizeUrl("microsoft", MICROSOFT, params));
    expect(url.origin + url.pathname).toBe(MICROSOFT.authorizeEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(MICROSOFT.redirectUri);
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_hint")).toBe("chris@contoso.example");
  });

  it("never carries the client secret", () => {
    // The URL goes to a browser and then into a history entry and an access
    // log. Only the id belongs in it.
    expect(buildAuthorizeUrl("microsoft", MICROSOFT, params)).not.toContain(MICROSOFT.clientSecret);
    expect(buildAuthorizeUrl("google", GOOGLE, params)).not.toContain(GOOGLE.clientSecret);
  });
});

describe("startSignin", () => {
  it("mints a fresh state and a fresh PKCE challenge every time", async () => {
    const d = deps(neverExchange);
    const first = await startSignin(d, actorId, CREATE_TARGET);
    const second = await startSignin(d, actorId, CREATE_TARGET);
    const a = new URL(first.authorizeUrl).searchParams;
    const b = new URL(second.authorizeUrl).searchParams;
    expect(a.get("state")).not.toBe(b.get("state"));
    // A reused challenge would mean a reused verifier, which would mean a code
    // stolen from one attempt could be spent against another.
    expect(a.get("code_challenge")).not.toBe(b.get("code_challenge"));
  });

  it("sends the CHALLENGE, and the challenge is the verifier's SHA-256", async () => {
    // The verifier never leaves the process, so it is only observable through
    // the exchange -- which is where this proves the pair really is a pair
    // rather than two unrelated random values.
    const { exchange, calls } = exchanger();
    const d = deps(exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });

    const verifier = calls[0]!.codeVerifier;
    expect(new URL(authorizeUrl).searchParams.get("code_challenge"))
      .toBe(createHash("sha256").update(verifier).digest("base64url"));
    // RFC 7636 4.1's range is 43-128 characters; 32 bytes base64url'd is 43.
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it("refuses a provider this install has no registration for", async () => {
    const d = deps(neverExchange, { clients: { google: GOOGLE } });
    await expect(startSignin(d, actorId, CREATE_TARGET)).rejects.toThrow(MailOAuthNotConfiguredError);
    // The sentence has to name what an operator must set, or it is a dead end.
    await expect(startSignin(d, actorId, CREATE_TARGET))
      .rejects.toThrow(/MAIL_OAUTH_MICROSOFT_CLIENT_ID.*MAIL_OAUTH_REDIRECT_URI/s);
  });
});

// --- The callback: refusing what it should ----------------------------------

describe("completeSignin: the state check", () => {
  it("refuses a forged state, contacts no provider and writes no row", async () => {
    const d = deps(neverExchange);
    await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: "f".repeat(64), code: "code-1" });
    expect(result.outcome).toBe("state");
    // neverExchange throws synchronously, so an outcome of "state" rather than
    // "provider" is itself proof the exchange was never reached -- and the row
    // count is proof nothing was written on the way to deciding that.
    expect(await accountCount()).toBe(0);
  });

  it("refuses a callback with no state at all", async () => {
    const result = await completeSignin(deps(neverExchange), actorId, { code: "code-1" });
    expect(result.outcome).toBe("state");
  });

  it("refuses a state minted for a DIFFERENT user", async () => {
    // The attack this is the whole defence against: an attacker completes an
    // authorisation against their own mailbox and induces the operator's
    // browser to load the callback. Without the binding, Conduit attaches the
    // attacker's mailbox to the operator's account.
    const d = deps(neverExchange);
    const { authorizeUrl } = await startSignin(d, otherActorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
    expect(result.outcome).toBe("state");
    expect(await accountCount()).toBe(0);
  });

  it("refuses a REPLAYED state, even the operator's own", async () => {
    const { exchange } = exchanger();
    const d = deps(exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const state = stateOf(authorizeUrl);
    expect((await completeSignin(d, actorId, { state, code: "code-1" })).outcome).toBe("connected");

    const replay = await completeSignin(d, actorId, { state, code: "code-1" });
    expect(replay.outcome).toBe("state");
    // One sign-in, one account: a replay that created a second row would be a
    // duplicate mailbox on every retry of a request in a history entry.
    expect(await accountCount()).toBe(1);
  });

  it("refuses an expired state", async () => {
    const states = new MailOAuthStates();
    let clock = NOW;
    const d = deps(neverExchange, { states, now: () => clock });
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    clock = new Date(NOW.getTime() + SIGNIN_STATE_TTL_MS);
    expect((await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" })).outcome)
      .toBe("state");
  });

  it("spends the state even when the PROVIDER refused, so it cannot be reused", async () => {
    const { exchange } = exchanger();
    const d = deps(exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const state = stateOf(authorizeUrl);
    expect((await completeSignin(d, actorId, { state, error: "access_denied" })).outcome).toBe("denied");
    // A state left live because the consent screen said no is a state an
    // attacker can then spend with a code of their own.
    expect((await completeSignin(d, actorId, { state, code: "code-1" })).outcome).toBe("state");
  });
});

describe("completeSignin: what the provider said", () => {
  async function start(d: SigninDeps): Promise<string> {
    return stateOf((await startSignin(d, actorId, CREATE_TARGET)).authorizeUrl);
  }

  it("tells a declined consent apart from a broken registration", async () => {
    const d = deps(neverExchange);
    expect((await completeSignin(d, actorId, { state: await start(d), error: "access_denied" })).outcome)
      .toBe("denied");
    expect((await completeSignin(d, actorId, { state: await start(d), error: "unauthorized_client" })).outcome)
      .toBe("provider");
  });

  it("refuses a callback carrying neither a code nor an error, WITHOUT calling the exchanger", async () => {
    // THE SECOND HALF IS WHAT THE ASSERTION IS FOR, and a mutation found that
    // out: deleting the missing-code check left this green, because
    // `neverExchange` throws and a throw from the exchanger produces the same
    // "provider" outcome. The suite could not tell "refused here" from "the
    // provider refused", which is the difference between never making a
    // request and making one with `code=undefined` in the body.
    const { exchange, calls } = exchanger();
    const d = deps(exchange);
    expect((await completeSignin(d, actorId, { state: await start(d) })).outcome).toBe("provider");
    expect(calls).toEqual([]);
  });

  it("bounds the error code it logs, because that string came from the request", async () => {
    // Reaching this needs a state that redeemed, so the caller is already the
    // operator -- the bound is here because an unbounded caller-supplied string
    // going into the journal is a shape worth refusing on principle.
    const d = deps(neverExchange);
    const result = await completeSignin(d, actorId, { state: await start(d), error: "x".repeat(5000) });
    expect(result.outcome).toBe("provider");
    expect((result.logDetail ?? "").length).toBeLessThan(200);
  });

  it("answers its own outcome when the provider issued no refresh token", async () => {
    // The Google-without-prompt=consent failure, and it needs its own answer:
    // "the provider refused" would be false and would send the operator to
    // check a registration that is fine.
    const failing: MailOAuthCodeExchanger = () => Promise.reject(new MissingRefreshTokenError("google"));
    const d = deps(failing);
    const result = await completeSignin(d, actorId, { state: await start(d), code: "code-1" });
    expect(result.outcome).toBe("no_refresh_token");
    expect(await accountCount()).toBe(0);
  });

  it("never throws, whatever the exchanger does", async () => {
    const d = deps(() => Promise.reject(new Error("connection: DNS failed")));
    const result = await completeSignin(d, actorId, { state: await start(d), code: "code-1" });
    // A throw here is a JSON 500 in a browser window where a settings page
    // should be -- see the callback route.
    expect(result.outcome).toBe("provider");
  });
});

// --- The callback: what it writes -------------------------------------------

describe("completeSignin: creating an account", () => {
  it("stores the refresh token, the access token and its expiry, sealed", async () => {
    const d = deps(exchanger({ expiresInSeconds: 3600 }).exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });

    expect(result.outcome).toBe("connected");
    const row = await rowOf(result.accountId!);
    expect(decryptCredentialsAt(keyPath, row.credentialsCiphertext)).toEqual({
      kind: "oauth",
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      // Stored so the FIRST connection after a sign-in does not spend a token
      // request on something it was just handed.
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    });
  });

  it("writes auth_method and the blob together, and gives the provider's own endpoints", async () => {
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
    const row = await rowOf(result.accountId!);

    // The two halves of one fact, in one statement: the state
    // MailAuthMethodMismatchError exists to catch is the one where they differ.
    expect(row.authMethod).toBe("oauth_microsoft");
    expect(decryptCredentialsAt(keyPath, row.credentialsCiphertext).kind).toBe("oauth");
    // The spec's "the endpoints are the provider's and known" -- nobody typed
    // any of these.
    expect(row).toMatchObject({
      imapHost: "outlook.office365.com", imapPort: 993, imapSecurity: "tls",
      smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls",
      username: "chris@contoso.example", sentFolder: "Sent Items",
      userId: actorId, label: "Work", email: "chris@contoso.example", status: "active",
    });
  });

  it("uses Google's endpoints for a Google sign-in", async () => {
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(
      d, actorId, { ...CREATE_TARGET, provider: "google" },
    );
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
    expect(await rowOf(result.accountId!)).toMatchObject({
      authMethod: "oauth_google", imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com",
      sentFolder: "[Gmail]/Sent Mail",
    });
  });

  it("refuses a mailbox this user already has, rather than syncing it twice", async () => {
    await createAccount(handle.db, actorId, { ...baseInput, email: "chris@contoso.example" }, keyPath);
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
    expect(result.outcome).toBe("duplicate");
    expect(await accountCount()).toBe(1);
  });
});

describe("completeSignin: re-authorising an existing account", () => {
  it("replaces the grant, clears the lapsed state, and creates no second row", async () => {
    const id = await makeOAuthAccount();
    await handle.db.update(mailAccounts)
      .set({ status: "auth_required", lastError: "microsoft would not renew this account's sign-in" })
      .where(eq(mailAccounts.id, id));

    const d = deps(exchanger({ refreshToken: "second-refresh-token" }).exchange);
    const { authorizeUrl } = await startSignin(d, actorId, {
      kind: "reauthorize", provider: "microsoft", accountId: id, email: "chris@contoso.example",
    });
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-2" });

    expect(result.outcome).toBe("connected");
    expect(result.accountId).toBe(id);
    expect(await accountCount()).toBe(1);
    const row = await rowOf(id);
    const credentials = decryptCredentialsAt(keyPath, row.credentialsCiphertext);
    expect(credentials).toMatchObject({ kind: "oauth", refreshToken: "second-refresh-token" });
    // The row said "sign in again" and the operator has just done it: leaving
    // the state would leave the badge telling them to repeat themselves.
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
  });

  it("refuses to re-authorise an account with a DIFFERENT provider", async () => {
    const id = await makeOAuthAccount();
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(d, actorId, {
      kind: "reauthorize", provider: "google", accountId: id, email: "chris@contoso.example",
    });
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-2" });
    expect(result.outcome).toBe("account");
    // Not a different mailbox wearing this row's label: the stored grant, the
    // hosts and every message filed under it stay Microsoft's.
    expect(await rowOf(id)).toMatchObject({ authMethod: "oauth_microsoft" });
  });

  it("refuses to convert a PASSWORD account, and leaves its password intact", async () => {
    const account = await createAccount(handle.db, actorId, baseInput, keyPath);
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(d, actorId, {
      kind: "reauthorize", provider: "microsoft", accountId: account.id, email: baseInput.email,
    });
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-2" });

    expect(result.outcome).toBe("account");
    const row = await rowOf(account.id);
    expect(row.authMethod).toBe("password");
    // The half that would be unrecoverable: a conversion that overwrote the
    // blob would destroy a password no backup of this row can return.
    expect(decryptCredentialsAt(keyPath, row.credentialsCiphertext))
      .toMatchObject({ kind: "password", imapPassword: "imap-half" });
  });

  it("refuses to re-authorise an archived account", async () => {
    const id = await makeOAuthAccount();
    await handle.db.update(mailAccounts).set({ archivedAt: NOW }).where(eq(mailAccounts.id, id));
    const d = deps(exchanger({ refreshToken: "second" }).exchange);
    const { authorizeUrl } = await startSignin(d, actorId, {
      kind: "reauthorize", provider: "microsoft", accountId: id, email: "chris@contoso.example",
    });
    expect((await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "c" })).outcome)
      .toBe("account");
    expect(decryptCredentialsAt(keyPath, (await rowOf(id)).credentialsCiphertext))
      .toMatchObject({ refreshToken: REFRESH_TOKEN });
  });

  it("names ARCHIVED before it names the auth method, so the first obstacle is the one reported", async () => {
    // AT THE SERVICE, AND ON A PASSWORD ACCOUNT, because both of those are what
    // make the assertion see anything. Two mutations were needed to find this:
    // deleting replaceOAuthCredentials' archived check survives the OAuth case
    // above, since the UPDATE's own isNull(archivedAt) then throws the same
    // ArchivedError by a different route -- correct, and indistinguishable. The
    // one place the two routes differ is an archived account that is ALSO not
    // this provider's: with the explicit check it is refused for being
    // archived, and without it the auth-method check fires first and refuses it
    // for signing in with a password.
    //
    // WHAT THAT IS WORTH, stated so the case is not over-sold: completeSignin
    // flattens both into the outcome `account`, so the operator's banner is
    // identical either way. What differs is the sentence in the journal, and
    // the order in which an account's obstacles are reported -- being archived
    // is the first one, and telling somebody about the second while the first
    // stands sends them to the wrong remedy.
    const account = await createAccount(handle.db, actorId, baseInput, keyPath);
    await handle.db.update(mailAccounts).set({ archivedAt: NOW }).where(eq(mailAccounts.id, account.id));
    await expect(replaceOAuthCredentials(
      handle.db, actorId, account.id, "oauth_microsoft", encryptCredentialsAt(keyPath, {
        kind: "oauth", refreshToken: "second",
      }), NOW,
    )).rejects.toBeInstanceOf(ArchivedError);
  });

  it("RESTARTS the account's sync rather than merely waking it", async () => {
    // An account that reached 'auth_required' is sitting in a capped 32-minute
    // backoff. A wake leaves it there, so the operator who has just signed in
    // again watches a row that says nothing for half an hour -- which is the
    // "mail quietly stopped" failure this whole phase exists to prevent, one
    // step further on. Nothing saw this until a mutation flipped the flag.
    const calls: { accountId: string; connectionChanged: boolean }[] = [];
    const unregister = setAccountChangedHook((accountId, change) => {
      calls.push({ accountId, connectionChanged: change.connectionChanged });
    });
    try {
      const id = await makeOAuthAccount();
      calls.length = 0; // the create's own notification is not what this is about
      const d = deps(exchanger({ refreshToken: "second" }).exchange);
      const { authorizeUrl } = await startSignin(d, actorId, {
        kind: "reauthorize", provider: "microsoft", accountId: id, email: "chris@contoso.example",
      });
      await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "c" });
      expect(calls).toEqual([{ accountId: id, connectionChanged: true }]);
    } finally {
      unregister();
    }
  });

  it("refuses to write to another user's account", async () => {
    // The state binding already stops the ordinary version of this; the owner
    // check is what stops a caller who IS the state's owner naming somebody
    // else's row.
    const id = await makeOAuthAccount();
    const d = deps(exchanger({ refreshToken: "second" }).exchange);
    const { authorizeUrl } = await startSignin(d, otherActorId, {
      kind: "reauthorize", provider: "microsoft", accountId: id, email: "chris@contoso.example",
    });
    expect((await completeSignin(d, otherActorId, { state: stateOf(authorizeUrl), code: "c" })).outcome)
      .toBe("account");
    expect(decryptCredentialsAt(keyPath, (await rowOf(id)).credentialsCiphertext))
      .toMatchObject({ refreshToken: REFRESH_TOKEN });
  });
});

// --- Nothing leaks ----------------------------------------------------------

describe("completeSignin: no token reaches anything a caller can see", () => {
  /** Everything a SigninResult carries, flattened, so a new field cannot be
   * added without this looking at it. */
  function surface(result: { outcome: string; accountId?: string; logDetail?: string }): string {
    return JSON.stringify(result);
  }

  it("puts no token in a successful result", async () => {
    const d = deps(exchanger().exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "code-1" });
    expect(surface(result)).not.toContain(REFRESH_TOKEN);
    expect(surface(result)).not.toContain(ACCESS_TOKEN);
  });

  it("puts no code or verifier in a failure, against a hostile endpoint and the REAL exchanger", async () => {
    // THE COMPOSED PATH, not a fake in its place, because the thing being
    // proved is a property of the composition: completeSignin copies the
    // exchanger's message into logDetail verbatim, so the scrubbing has to have
    // happened before it gets there. A stub error would prove only that a
    // string with no secret in it has no secret in it.
    //
    // The endpoint echoes back what it was sent, which is what
    // mail-oauth.ts's redact exists for -- "Microsoft does not do that" is an
    // assumption about somebody else's code, and logDetail lands in a journal
    // that outlives every part of this request.
    const hostile = ((_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      return Promise.resolve(new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: `code=${body.get("code") ?? ""} verifier=${body.get("code_verifier") ?? ""}`,
      }), { status: 400, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof globalThis.fetch;

    const clients = { microsoft: MICROSOFT };
    const d = deps(createHttpCodeExchanger(clients, { fetch: hostile }));
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge");
    const result = await completeSignin(d, actorId, {
      state: stateOf(authorizeUrl), code: "the-authorisation-code",
    });

    expect(result.outcome).toBe("provider");
    expect(surface(result)).not.toContain("the-authorisation-code");
    expect(surface(result)).not.toContain(MICROSOFT.clientSecret);
    // The verifier is not in the result to compare against directly -- it never
    // leaves the state store -- so the CHALLENGE stands in for it: if the
    // verifier had ridden the description through, hashing what came back would
    // reproduce this. A cheaper proxy would be no proxy at all.
    expect(challenge).not.toBeNull();
    expect(
      /verifier=([A-Za-z0-9\-_]{43})/.exec(result.logDetail ?? "")?.[1],
    ).toBeUndefined();
  });

  it("puts no authorisation code in a result", async () => {
    // The code is short-lived and PKCE-bound, and it is still a credential:
    // logDetail is a journal line, and a journal outlives every part of this.
    const d = deps(neverExchange);
    const result = await completeSignin(d, actorId, { state: "f".repeat(64), code: "the-secret-code" });
    expect(surface(result)).not.toContain("the-secret-code");
  });
});

// --- The real exchanger -----------------------------------------------------

describe("createHttpCodeExchanger", () => {
  function fakeFetch(response: Response): {
    fetch: typeof globalThis.fetch; requests: { url: string; body: string }[];
  } {
    const requests: { url: string; body: string }[] = [];
    return {
      requests,
      fetch: ((url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: String(init.body) });
        return Promise.resolve(response.clone());
      }) as unknown as typeof globalThis.fetch,
    };
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  }

  const clients = { microsoft: MICROSOFT };

  it("posts an authorization_code grant carrying the verifier and the registered redirect URI", async () => {
    const { fetch, requests } = fakeFetch(jsonResponse(200, {
      access_token: "a", expires_in: 3600, refresh_token: "r",
    }));
    await createHttpCodeExchanger(clients, { fetch })("microsoft", "the-code", "the-verifier");

    expect(requests[0]?.url).toBe(MICROSOFT.tokenEndpoint);
    const body = new URLSearchParams(requests[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    // Without this the provider issues a code for a challenge nothing can
    // redeem -- PKCE turned off by omission, which is the failure that looks
    // like it is working.
    expect(body.get("code_verifier")).toBe("the-verifier");
    // Compared byte for byte at the provider (RFC 6749 3.1.2.3); it has to be
    // the registered one, not one built from the request.
    expect(body.get("redirect_uri")).toBe(MICROSOFT.redirectUri);
    expect(body.get("client_secret")).toBe(MICROSOFT.clientSecret);
  });

  it("REFUSES a grant with no refresh token", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { access_token: "a", expires_in: 3600 }));
    await expect(createHttpCodeExchanger(clients, { fetch })("microsoft", "c", "v"))
      .rejects.toThrow(MissingRefreshTokenError);
  });

  it("scrubs this request's own secrets out of whatever the endpoint says back", async () => {
    // The same hostile endpoint Task 2 pinned the refresh against, one grant
    // type over: an error_description echoing what it was sent travels into
    // mail_accounts.last_error and onto a screen.
    const { fetch } = fakeFetch(jsonResponse(400, {
      error: "invalid_grant",
      error_description: "code=the-code verifier=the-verifier secret=client-secret",
    }));
    const error = await createHttpCodeExchanger(clients, { fetch })("microsoft", "the-code", "the-verifier")
      .then(() => null, (err: unknown) => err) as Error;

    expect(error.message).not.toContain("the-code");
    expect(error.message).not.toContain("the-verifier");
    expect(error.message).not.toContain("client-secret");
  });

  it("names the settings when the install has no registration for the provider", async () => {
    await expect(createHttpCodeExchanger({}, { fetch: fakeFetch(jsonResponse(200, {})).fetch })(
      "google", "c", "v",
    )).rejects.toThrow(/MAIL_OAUTH_GOOGLE_CLIENT_ID/);
  });
});

// --- Small, exported, and used by the UI ------------------------------------

describe("configuredProviders", () => {
  it("lists only the providers with a registration", () => {
    expect(configuredProviders({ microsoft: MICROSOFT, google: GOOGLE })).toEqual(["microsoft", "google"]);
    expect(configuredProviders({ google: GOOGLE })).toEqual(["google"]);
    expect(configuredProviders({})).toEqual([]);
  });
});

describe("providerDisplayName and connectionFor", () => {
  it("names each provider the way the consent screen does", () => {
    expect(providerDisplayName("microsoft")).toBe("Microsoft");
    expect(providerDisplayName("google")).toBe("Google");
  });

  it("makes the mailbox address the username, at both providers", () => {
    // XOAUTH2's SASL payload is `user=<address>` beside the token, so there is
    // no separate login name to ask for -- which is one more field the OAuth
    // form does not have.
    expect(connectionFor("microsoft", "a@b.example").username).toBe("a@b.example");
    expect(connectionFor("google", "a@b.example").username).toBe("a@b.example");
  });
});

// --- The account service's own OAuth guards ---------------------------------

describe("updateAccount against an OAuth account", () => {
  it("refuses a submitted password rather than overwriting the refresh token", async () => {
    // THE BUG THIS TASK FOUND. Before the guard, this PATCH sealed a password
    // blob over the grant while auth_method stayed 'oauth_microsoft' -- the
    // exact disagreement MailAuthMethodMismatchError calls unreachable, with
    // the refresh token destroyed on the way.
    const id = await makeOAuthAccount();
    await expect(updateAccount(handle.db, actorId, id, { password: "hunter2" }, keyPath))
      .rejects.toThrow(/authenticates with 'oauth'/);
    expect(decryptCredentialsAt(keyPath, (await rowOf(id)).credentialsCiphertext))
      .toMatchObject({ kind: "oauth", refreshToken: REFRESH_TOKEN });
  });

  it("refuses an smtpPassword on its own too", async () => {
    const id = await makeOAuthAccount();
    await expect(updateAccount(handle.db, actorId, id, { smtpPassword: "hunter2" }, keyPath))
      .rejects.toThrow(/authenticates with 'oauth'/);
  });

  it("refuses WITHOUT reading mail.key, so a missing key is not blamed", async () => {
    // The guard is on the column. If it decrypted first, an install whose key
    // is absent or restored from the wrong backup would answer "credentials
    // unreadable" to a request whose real problem is that this mailbox has no
    // password to set.
    const id = await makeOAuthAccount();
    await rm(keyPath);
    await expect(updateAccount(handle.db, actorId, id, { password: "hunter2" }, keyPath))
      .rejects.toThrow(/authenticates with 'oauth'/);
  });

  it("still lets an ordinary setting through", async () => {
    const id = await makeOAuthAccount();
    const updated = await updateAccount(handle.db, actorId, id, { label: "Renamed" }, keyPath);
    expect(updated.label).toBe("Renamed");
    expect(updated.authMethod).toBe("oauth_microsoft");
  });
});

describe("createOAuthAccount's blob is one encryptCredentialsChecked would accept", () => {
  it("seals a payload that decrypts back to the union's OAuth member", async () => {
    // encryptCredentials serialises without validating, and a malformed blob
    // sealed on purpose reads as "credentials unreadable" for ever with no
    // backup that helps. The proof that the CHECKED encoder is the one in use
    // is that a payload it would refuse never reaches the row -- so this
    // asserts the round trip the plain encoder could have broken silently.
    const d = deps(exchanger({ expiresInSeconds: 60 }).exchange);
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "c" });
    const credentials = decryptCredentialsAt(keyPath, (await rowOf(result.accountId!)).credentialsCiphertext);
    expect(credentials.kind).toBe("oauth");
    // The union refuses an access token without an expiry beside it; a blob
    // carrying one and not the other would have sealed happily and never read
    // back.
    expect(credentials).toHaveProperty("accessTokenExpiresAt");
  });

  it("refuses to seal a grant with an empty refresh token", async () => {
    // createHttpCodeExchanger guarantees a refresh token; an exchanger that
    // broke that contract must not be able to write a blob whose refreshToken
    // is "" -- the union's `.min(1)` is what catches it, at the moment of the
    // mistake rather than at every read afterwards.
    const d = deps(() => Promise.resolve({
      accessToken: "a", expiresInSeconds: 3600, refreshToken: "",
    }));
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "c" });
    expect(result.outcome).toBe("failed");
    expect(await accountCount()).toBe(0);
  });

  it("keeps no token in the refusal it produces", async () => {
    const d = deps(() => Promise.resolve({
      accessToken: ACCESS_TOKEN, expiresInSeconds: 3600, refreshToken: "",
    }));
    const { authorizeUrl } = await startSignin(d, actorId, CREATE_TARGET);
    const result = await completeSignin(d, actorId, { state: stateOf(authorizeUrl), code: "c" });
    // encryptCredentialsChecked reports zod's PATHS and no values, which is
    // what makes this true; a refusal quoting the payload would put the access
    // token in the journal.
    expect(result.logDetail ?? "").not.toContain(ACCESS_TOKEN);
  });
});
