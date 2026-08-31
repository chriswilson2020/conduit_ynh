import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
import { testReauthVerifier, TEST_REAUTH_PASSWORD, reauthTicket } from "../test/reauth.js";
import { ReauthTickets } from "../services/reauth.js";
import type { Config } from "../config.js";
import type { ReauthVerifier } from "../services/reauth.js";

/**
 * THE GATE, AND -- THE HALF THAT MATTERS -- THAT BYPASSING IT FAILS.
 *
 * "The prompt appears" is not the property. The prompt is a page; the endpoints
 * are one fetch away from anybody holding the session, and somebody who has
 * walked up to an unlocked screen will not be using the page. So every case
 * below is about a request that tries to get an archive WITHOUT a valid,
 * unspent, unexpired, correctly-owned ticket, and gets nothing.
 *
 * These tests do not need 7z or unzip: none of them expects a 200 from a
 * download, which is precisely what makes them cheap enough to be exhaustive.
 */

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "1.3.0-test",
  devUser: null,
  dataDir: "./data",
  defaultCurrency: "EUR",
  mailKeyPath: "unused-in-tests",
  mailTlsRejectUnauthorized: true,
  portalApiUrl: "http://127.0.0.1:6788",
  reauthPassword: null,
};

const chris = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};
const sam = {
  "ynh-user": "sam",
  "ynh-user-email": "sam@example.com",
  "ynh-user-fullname": "Sam",
};

let dataDir: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-reauth-"));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await handle.close();
});

function app(verifier: ReauthVerifier = testReauthVerifier()) {
  return buildApp({ config, db: handle.db, dataDir, reauthVerifier: verifier });
}

describe("POST /api/reauth", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/reauth", payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("mints a ticket for the right password", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ticket: string; expiresInSeconds: number };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSeconds).toBe(300);
  });

  it("refuses the wrong password, with no ticket and nothing that identifies the account", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "not-it" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_failed" });
    expect(response.body).not.toContain("ticket");
    // No hint about whether the account exists or how close the guess was.
    expect(response.body).not.toContain("chris");
  });

  it("refuses an empty or absent password as validation, without checking anything", async () => {
    // The verifier throws if it is ever reached, so reaching it would be a 503
    // rather than the 400 asserted here -- which is what makes this an
    // assertion about ORDER rather than about the schema alone.
    const never: ReauthVerifier = () => { throw new Error("the verifier must not be reached"); };
    const a = await app(never);
    for (const payload of [{}, { password: "" }]) {
      const response = await a.inject({
        method: "POST", url: "/api/reauth", headers: chris, payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: "validation" });
    }
  });

  it("never puts the password in the log, and shows the log really was watching", async () => {
    const lines: string[] = [];
    const marker = "PASSWORD-THAT-MUST-NOT-BE-LOGGED";
    const a = await buildApp({
      config: { ...config, nodeEnv: "development" },
      db: handle.db, dataDir,
      loggerStream: { write: (line: string) => { lines.push(line); } },
      reauthVerifier: testReauthVerifier(),
    });
    // A wrong password, which is the path that logs the MOST -- a refusal is
    // logged deliberately, so that a burst of them is visible to an operator.
    const response = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: marker },
    });
    expect(response.statusCode).toBe(401);
    // The instrument, shown working: an empty transcript is not what makes the
    // assertion below pass.
    expect(lines.join("")).toContain("/api/reauth");
    expect(lines.join("")).toContain("re-authentication refused");
    expect(lines.join("")).not.toContain(marker);
    expect(response.body).not.toContain(marker);
  });

  it("locks an account out after repeated wrong passwords, and says how long", async () => {
    const a = await app();
    for (let i = 0; i < 5; i += 1) {
      const response = await a.inject({
        method: "POST", url: "/api/reauth", headers: chris, payload: { password: "wrong" },
      });
      expect(response.statusCode, `attempt ${String(i + 1)}`).toBe(401);
    }
    const locked = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "wrong" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: "reauth_throttled" });
    expect(locked.headers["retry-after"]).toBeDefined();

    // AND THE RIGHT PASSWORD IS REFUSED TOO. A throttle that let the correct
    // password through would be no throttle at all -- the attacker is guessing,
    // and the guess that works is the one it has to stop.
    const correct = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(correct.statusCode).toBe(429);
  });

  it("locks one account without locking another", async () => {
    const a = await app();
    for (let i = 0; i < 5; i += 1) {
      await a.inject({ method: "POST", url: "/api/reauth", headers: chris, payload: { password: "x" } });
    }
    const theirs = await a.inject({
      method: "POST", url: "/api/reauth", headers: sam, payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(theirs.statusCode).toBe(200);
  });

  it("answers 503, not 401, when the password could not be checked at all", async () => {
    // The portal being down is not evidence about the password, and telling the
    // operator to retype would send them looking in the wrong place.
    const broken: ReauthVerifier = () => Promise.reject(new Error("portal is down"));
    const response = await (await app(broken)).inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "reauth_unavailable" });
  });

  it("does not count an unavailable check against the throttle", async () => {
    let broken = true;
    const flaky: ReauthVerifier = (_user, password) =>
      broken ? Promise.reject(new Error("down")) : Promise.resolve(password === TEST_REAUTH_PASSWORD);
    const a = await app(flaky);
    for (let i = 0; i < 8; i += 1) {
      const response = await a.inject({
        method: "POST", url: "/api/reauth", headers: chris,
        payload: { password: TEST_REAUTH_PASSWORD },
      });
      expect(response.statusCode).toBe(503);
    }
    broken = false;
    const recovered = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(recovered.statusCode).toBe(200);
  });
});

/**
 * EVERY WAY A DOWNLOAD CAN BE ASKED FOR WITHOUT A VALID TICKET.
 *
 * Run against BOTH routes from one table, because a gate on one of them is not
 * a gate: the export is the easier request to make and the backup is the more
 * damaging one to succeed at, and each has to refuse for itself.
 */
/**
 * WHAT buildApp WIRES WHEN NOBODY HANDS IT A VERIFIER, which is every
 * deployment and every other test file in this suite.
 *
 * THIS EXISTS BECAUSE A MUTATION SURVIVED. Every test above injects its own
 * verifier, so changing app.ts's fallback to `() => Promise.resolve(true)` --
 * the gate switched off while still appearing to be there -- left the whole
 * suite green. The fallback is a two-branch decision made in the composition
 * root and it was the one part of this feature nothing looked at.
 */
describe("buildApp's default re-authentication verifier", () => {
  it("does NOT agree by default: with no fixed password it really asks the portal", async () => {
    // Port 1 on loopback, where nothing listens, so this is deterministic on
    // a runner AND on the dev server -- which is itself a YunoHost box with a
    // real portal API on 6788 that would answer 401 and hide the difference.
    const a = await buildApp({
      config: { ...config, portalApiUrl: "http://127.0.0.1:1" },
      db: handle.db, dataDir,
    });
    const response = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "anything" },
    });
    // The portal could not be reached, so the password could not be CHECKED.
    // What matters most is the half-assertion after it: whatever this is, it
    // is not a ticket.
    expect(response.statusCode).toBe(503);
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain("ticket");
  });

  it("uses the fixed password when config supplies one, and only that password", async () => {
    const a = await buildApp({
      config: { ...config, reauthPassword: "from-the-environment" },
      db: handle.db, dataDir,
    });
    const wrong = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "not-it" },
    });
    expect(wrong.statusCode).toBe(401);
    const right = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: "from-the-environment" },
    });
    expect(right.statusCode).toBe(200);
  });

  it("gates a download with the default wiring too, not only with an injected verifier", async () => {
    const a = await buildApp({
      config: { ...config, portalApiUrl: "http://127.0.0.1:1" },
      db: handle.db, dataDir,
    });
    const response = await a.inject({ method: "GET", url: "/api/export", headers: chris });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_required" });
  });
});

/**
 * Whether THE GATE refused this response, as opposed to anything else.
 *
 * On the raw body rather than the parsed one: a request that gets through
 * answers with an archive, and asking a zip for its JSON throws rather than
 * returning something that fails to match.
 */
function refusedByGate(response: { statusCode: number; body: string }): boolean {
  return response.statusCode === 401 && response.body.includes("reauth_required");
}

const DOWNLOADS = [
  { what: "export", method: "GET" as const, url: "/api/export", payload: undefined },
  {
    what: "backup", method: "POST" as const, url: "/api/backup",
    payload: { passphrase: "correct-horse" },
  },
];

describe.each(DOWNLOADS)("bypassing the gate on $what", ({ method, url, payload }) => {
  it("fails with no ticket at all", async () => {
    const response = await (await app()).inject({ method, url, headers: chris, payload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_required" });
  });

  it("fails with an invented ticket", async () => {
    const response = await (await app()).inject({
      method, url, payload,
      headers: { ...chris, "x-conduit-reauth": "f".repeat(64) },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_required" });
  });

  it("fails with an empty ticket header", async () => {
    const response = await (await app()).inject({
      method, url, payload, headers: { ...chris, "x-conduit-reauth": "" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("fails on a ticket that has already been spent", async () => {
    const a = await app();
    const ticket = await reauthTicket(a, chris);
    const first = await a.inject({
      method, url, payload, headers: { ...chris, "x-conduit-reauth": ticket },
    });
    // The first request got PAST the gate. It may still fail for its own
    // reasons (no 7z on this machine, say), and what matters here is only that
    // it was not refused BY THE GATE -- otherwise the second assertion below
    // would pass for the wrong reason. Read off the raw body rather than
    // .json(), because a request that gets through answers with an ARCHIVE and
    // parsing a zip as JSON throws.
    expect(refusedByGate(first)).toBe(false);

    const second = await a.inject({
      method, url, payload, headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(second.statusCode).toBe(401);
    expect(refusedByGate(second)).toBe(true);
  }, 120_000);

  it("fails on another account's ticket", async () => {
    const a = await app();
    const theirs = await reauthTicket(a, sam);
    const response = await a.inject({
      method, url, payload, headers: { ...chris, "x-conduit-reauth": theirs },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_required" });
  });

  it("fails on an expired ticket", async () => {
    // A ticket store with a lifetime of nothing at all, so an expiry can be
    // reached without waiting five minutes. It is the SAME class the app uses,
    // constructed with a different TTL rather than replaced by a stub.
    const expired = new ReauthTickets(0);
    const token = expired.issue("chris");
    expect(expired.redeem(token, "chris")).toBe(false);

    const a = await app();
    const response = await a.inject({
      method, url, payload, headers: { ...chris, "x-conduit-reauth": token },
    });
    expect(response.statusCode).toBe(401);
  });

  it("fails without a ticket even when the request is otherwise perfect", async () => {
    // The identity is real and resolvable, the body is valid, and the only
    // thing missing is the proof. Nothing about the response says what would
    // have been sent.
    const response = await (await app()).inject({ method, url, headers: chris, payload });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBeUndefined();
  });
});

describe("the gate and the unauthenticated check are two different refusals", () => {
  it("answers unauthenticated before it answers reauth_required", async () => {
    // No identity at all: the answer must be about the session, not about a
    // ticket a caller with no session could never have.
    const response = await (await app()).inject({
      method: "GET", url: "/api/export", headers: { "x-conduit-reauth": "f".repeat(64) },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
  });
});

describe("GET /api/backup/preflight", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await (await app()).inject({ method: "GET", url: "/api/backup/preflight" });
    expect(response.statusCode).toBe(401);
  });

  it("answers WITHOUT a ticket, deliberately", async () => {
    // The warning has to come BEFORE the commitment it informs. Requiring a
    // password to be told how long something will take would put it after.
    const response = await (await app()).inject({
      method: "GET", url: "/api/backup/preflight", headers: chris,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ timeoutSeconds: 3600 });
    expect(typeof body.databaseBytes).toBe("number");
    expect(typeof body.estimatedSeconds).toBe("number");
    expect(typeof body.enoughDisk).toBe("boolean");
  });

  it("carries no data, only sizes", async () => {
    // A route that answers without re-authentication must not be a way to read
    // anything. Its whole body is numbers and two booleans.
    const response = await (await app()).inject({
      method: "GET", url: "/api/backup/preflight", headers: chris,
    });
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "availableBytes", "blobBytes", "databaseBytes", "enoughDisk",
      "estimatedSeconds", "requiredBytes", "slow", "timeoutSeconds",
    ]);
  });
});
