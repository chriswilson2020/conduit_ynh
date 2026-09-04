import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
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
  ldapUrl: "ldap://127.0.0.1:389",
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

/**
 * Is a REAL LDAP directory listening where config.ts expects one?
 *
 * Probed rather than assumed, on the precedent of this suite's 7z and
 * WeasyPrint gates. The dev server is a YunoHost box and answers; a CI runner
 * and a developer's laptop are not, and skip visibly.
 *
 * WHY IT IS WORTH A PROBE AT ALL: every other test of the verifier points it at
 * a fixture or at a closed port, so the one path that runs in production -- a
 * real bind against a real directory -- would otherwise be exercised by
 * nothing. That is exactly how the portal version of this shipped broken.
 *
 * A BARE TCP CONNECT, NOT A BIND, and deliberately not the verifier itself.
 * This answers "am I on a YunoHost box", and nothing else; whether the thing
 * listening behaves is the gated test's question. A probe that used the code
 * under test would turn a broken verifier into a silent skip, which is the
 * failure mode this whole task exists to stop repeating.
 */
const LDAP_URL = "ldap://127.0.0.1:389";
const HAVE_DIRECTORY = await new Promise<boolean>((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: 389 });
  const settle = (answer: boolean): void => { socket.destroy(); resolve(answer); };
  socket.setTimeout(2_000);
  socket.once("connect", () => { settle(true); });
  socket.once("timeout", () => { settle(false); });
  socket.once("error", () => { settle(false); });
});
const itDirectory = HAVE_DIRECTORY ? it : it.skip;

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
      method: "POST", url: "/api/reauth", payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("mints a ticket for the right password", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ticket: string; expiresInSeconds: number };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSeconds).toBe(300);
  });

  it("refuses the wrong password, with no ticket and nothing that identifies the account", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "not-it", scope: "export" },
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
    for (const payload of [{}, { password: "" }, { password: "", scope: "export" }]) {
      const response = await a.inject({
        method: "POST", url: "/api/reauth", headers: chris, payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: "validation" });
    }
  });

  it("mints nothing for a request that will not say what the ticket is for", async () => {
    // NO DEFAULT SCOPE, AND THIS IS WHERE THAT IS ENFORCED. A ticket with a
    // scope chosen on the caller's behalf would be the fungible ticket back
    // under another name -- whichever value the default took, one of the four
    // gates would open for a request that never asked for it. So a mint
    // without a scope is a 400 and not a ticket, and an invented scope is the
    // same 400: the enum is closed, and "restore" (which is two operations,
    // not one) is the exact mistake it is closed against.
    const a = await app();
    for (const payload of [
      { password: TEST_REAUTH_PASSWORD },
      { password: TEST_REAUTH_PASSWORD, scope: "" },
      { password: TEST_REAUTH_PASSWORD, scope: "restore" },
      { password: TEST_REAUTH_PASSWORD, scope: "everything" },
    ]) {
      const response = await a.inject({
        method: "POST", url: "/api/reauth", headers: chris, payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.body, JSON.stringify(payload)).not.toContain("ticket");
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
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: marker, scope: "export" },
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
        method: "POST", url: "/api/reauth", headers: chris, payload: { password: "wrong", scope: "export" },
      });
      expect(response.statusCode, `attempt ${String(i + 1)}`).toBe(401);
    }
    const locked = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "wrong", scope: "export" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: "reauth_throttled" });
    expect(locked.headers["retry-after"]).toBeDefined();

    // AND THE RIGHT PASSWORD IS REFUSED TOO. A throttle that let the correct
    // password through would be no throttle at all -- the attacker is guessing,
    // and the guess that works is the one it has to stop.
    const correct = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    expect(correct.statusCode).toBe(429);
  });

  /**
   * A BURST, WHICH IS THE ONLY SHAPE THAT FINDS THIS.
   *
   * The lockout test above loops five times and awaits each, which the broken
   * code passed: it read the counter, awaited the verifier, and recorded the
   * failure afterwards, so a SEQUENTIAL caller always saw the previous
   * failure. Every request that arrived inside the await did not. Measured
   * against the real server over pre-connected sockets, written in one
   * synchronous pass: at a 3ms check 6 got through, at 25ms 63 did, and at
   * 100ms all two hundred did with not a single 429.
   *
   * The verifier here is deliberately SLOW and COUNTS ITS CALLS, because the
   * status codes alone would not say what was reached: what must be bounded is
   * how many passwords are actually tested, not how many requests are answered.
   */
  it("bounds a BURST of simultaneous attempts, not only sequential ones", async () => {
    let reached = 0;
    const slow: ReauthVerifier = () => {
      reached += 1;
      return new Promise((resolve) => { setTimeout(() => { resolve(false); }, 50); });
    };
    const a = await app(slow);

    // Every request written before any of them is awaited -- the whole point.
    const burst = Array.from({ length: 200 }, () => a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "guess", scope: "export" },
    }));
    const answers = await Promise.all(burst);

    expect(reached, "passwords actually tested").toBe(5);
    expect(answers.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(answers.filter((r) => r.statusCode === 429)).toHaveLength(195);

    // The instrument, shown working: the same burst with no throttle at all
    // would have tested all two hundred. This asserts the verifier really was
    // slow enough for the window to exist -- a fast one would bound it by
    // accident and say nothing.
    expect(reached).toBeLessThan(200);
  });

  it("bounds a burst against a fast verifier too", async () => {
    // The deploy target's directory refuses a bad bind in 4.7-10.5ms end to
    // end, process startup included (measured 2 Sep with ldapwhoami), so the
    // window is small there -- but "small" is not "bounded", and it is still
    // attacker-influenceable at one remove: the SSO portal is publicly
    // reachable and binds THIS SAME slapd, so loading the portal widens the
    // gap for a simultaneous burst here.
    let reached = 0;
    const fast: ReauthVerifier = () => { reached += 1; return Promise.resolve(false); };
    const a = await app(fast);
    await Promise.all(Array.from({ length: 100 }, () => a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "guess", scope: "export" },
    })));
    expect(reached).toBe(5);
  });

  it("leaves no lockout behind after a burst against a broken directory", async () => {
    /*
     * WHAT AN OUTAGE COSTS, STATED PRECISELY, because the obvious assertion is
     * wrong and was written first.
     *
     * A reservation is taken BEFORE the check and given back only when the
     * check turns out to have tested nothing -- which cannot be known until it
     * returns. So during an outage a BURST does meet 429s: five checks are in
     * flight, and the sixth simultaneous caller is refused exactly as it would
     * be if those five were real attempts. That is the in-flight bound doing
     * its job, not a bug, and asserting "every one of these is a 503" asserted
     * the absence of the property.
     *
     * What must be true is the thing an operator would actually feel: when the
     * directory comes back, the account is not locked out by an outage it had
     * no part in. Every reservation was released, so the counter is clear.
     */
    let broken = true;
    const flaky: ReauthVerifier = (_user, password) =>
      broken
        ? new Promise((_resolve, reject) => { setTimeout(() => { reject(new Error("down")); }, 20); })
        : Promise.resolve(password === TEST_REAUTH_PASSWORD);
    const a = await app(flaky);
    const answers = await Promise.all(Array.from({ length: 50 }, () => a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    })));
    // Some got as far as the directory and some were refused while those were
    // in flight. Neither count is the property; that both codes appear is what
    // shows the burst really did contend, so the assertion after it is not
    // passing on an empty run.
    expect(answers.some((r) => r.statusCode === 503)).toBe(true);
    expect(answers.every((r) => r.statusCode === 503 || r.statusCode === 429)).toBe(true);
    expect(answers.some((r) => r.statusCode === 401)).toBe(false);

    broken = false;
    const recovered = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    expect(recovered.statusCode, "the outage left no lockout behind").toBe(200);
  });

  it("locks one account without locking another", async () => {
    const a = await app();
    for (let i = 0; i < 5; i += 1) {
      await a.inject({ method: "POST", url: "/api/reauth", headers: chris, payload: { password: "x", scope: "export" } });
    }
    const theirs = await a.inject({
      method: "POST", url: "/api/reauth", headers: sam, payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    expect(theirs.statusCode).toBe(200);
  });

  it("answers 503, not 401, when the password could not be checked at all", async () => {
    // The directory being down is not evidence about the password, and telling
    // the operator to retype would send them looking in the wrong place.
    const broken: ReauthVerifier = () => Promise.reject(new Error("the directory is down"));
    const response = await (await app(broken)).inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
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
        payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
      });
      expect(response.statusCode).toBe(503);
    }
    broken = false;
    const recovered = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
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
  it("does NOT agree by default: with no fixed password it really asks the directory", async () => {
    // Port 1 on loopback, where nothing listens, so this is deterministic on a
    // runner AND on the dev server -- which is itself a YunoHost box with a
    // real directory on 389 that would answer 49 and hide the difference.
    const a = await buildApp({
      config: { ...config, ldapUrl: "ldap://127.0.0.1:1" },
      db: handle.db, dataDir,
    });
    const response = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "anything", scope: "export" },
    });
    // The directory could not be reached, so the password could not be
    // CHECKED. What matters most is the half-assertion after it: whatever this
    // is, it is not a ticket.
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
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "not-it", scope: "export" },
    });
    expect(wrong.statusCode).toBe(401);
    const right = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: "from-the-environment", scope: "export" },
    });
    expect(right.statusCode).toBe(200);
  });

  it("carries a ticket minted through the default wiring all the way to a download", async () => {
    // WHAT THIS ONE ALONE SAYS, and it is not what its first version said. It
    // used to send NO ticket and assert a 401, which is true whatever the
    // verifier is -- so it killed nothing, and a review said so. The property
    // only this test has is that the chain works end to end with nothing
    // injected anywhere: config chooses the verifier, the verifier mints a
    // ticket, and the download route accepts that ticket.
    const a = await buildApp({
      config: { ...config, reauthPassword: "from-the-environment" },
      db: handle.db, dataDir,
    });
    const minted = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: "from-the-environment", scope: "export" },
    });
    expect(minted.statusCode).toBe(200);
    const { ticket } = minted.json() as { ticket: string };

    const download = await a.inject({
      method: "GET", url: "/api/export",
      headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(download.statusCode).not.toBe(401);
    expect(download.body).not.toContain("reauth_required");
  }, 120_000);

  /**
   * THE PATH THAT ACTUALLY RUNS IN PRODUCTION, against the real thing.
   *
   * Every other test here points the verifier at a fixture or at a closed port.
   * This one lets the default composition-root wiring reach the directory on
   * the box it is running on and asserts what a wrong password does: a clean
   * 401 reauth_failed, not a 503 and not a ticket. Skipped where there is no
   * directory.
   *
   * WHAT THE PORTAL VERSION OF THIS TEST FAILED TO SAY, because it is the
   * reason v1.4.1 exists: it asserted exactly this, it passed, and the gate
   * was refusing every CORRECT password at the same time. A refusal is a weak
   * instrument -- it can be right for the wrong reason. What makes it worth
   * keeping is the one thing it does pin down: that the real thing was reached
   * and answered, so a 503 and a 401 are distinguishable here. The success path
   * cannot be tested from a suite, because it needs a real account's real
   * password; services/reauth.test.ts covers it against a directory that
   * implements the same rules.
   *
   * The username is one that does not exist, and a directory answers 49 for
   * that exactly as it does for a wrong password -- measured on the deploy
   * target on 2 Sep -- so this tests nobody's credentials and enumerates
   * nothing.
   */
  itDirectory("refuses a wrong password against the REAL directory, through the default wiring", async () => {
    const a = await buildApp({
      config: { ...config, ldapUrl: LDAP_URL },
      db: handle.db, dataDir,
    });
    const response = await a.inject({
      method: "POST", url: "/api/reauth",
      headers: {
        "ynh-user": "conduit-probe-no-such-user",
        "ynh-user-email": "nobody@example.com",
        "ynh-user-fullname": "Probe",
      },
      payload: { password: "definitely-not-the-password", scope: "export" },
    });
    // 401, which means the directory was REACHED and answered. A 503 here
    // would mean the verifier could not talk to it, and the assertion below is
    // what tells those two apart -- they are the two states this whole seam
    // exists to keep separate.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "reauth_failed" });
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
  {
    what: "export", method: "GET" as const, url: "/api/export",
    payload: undefined, scope: "export" as const,
  },
  {
    what: "backup", method: "POST" as const, url: "/api/backup",
    payload: { passphrase: "correct-horse" }, scope: "backup" as const,
  },
];

describe.each(DOWNLOADS)("bypassing the gate on $what", ({ method, url, payload, scope }) => {
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
    const ticket = await reauthTicket(a, chris, scope);
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

  it("fails when a junk value is sent alongside a real ticket, in either order", async () => {
    // WHY IT FAILS, corrected: Node joins repeated occurrences of an ordinary
    // header into ONE comma-separated string (only set-cookie becomes an
    // array), so the gate looks up "junk, <ticket>" or "<ticket>, junk" whole.
    // It misses the map. Nothing is refused for being an array -- there is no
    // array here to refuse.
    for (const order of ["junk-first", "ticket-first"] as const) {
      const a = await app();
      const ticket = await reauthTicket(a, chris, scope);
      const value = order === "junk-first" ? `junk, ${ticket}` : `${ticket}, junk`;
      const response = await a.inject({
        method, url, payload, headers: { ...chris, "x-conduit-reauth": value },
      });
      expect(response.statusCode, order).toBe(401);
      expect(response.body, order).toContain("reauth_required");
    }
  });

  it("fails on a very long ticket value without reading it as anything", async () => {
    const response = await (await app()).inject({
      method, url, payload,
      headers: { ...chris, "x-conduit-reauth": "a".repeat(60_000) },
    });
    expect(response.statusCode).toBe(401);
  });

  it("fails on another account's ticket", async () => {
    const a = await app();
    const theirs = await reauthTicket(a, sam, scope);
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
    const token = expired.issue("chris", scope);
    expect(expired.redeem(token, "chris", scope)).toBe(false);

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

/**
 * A TICKET IS A PROOF FOR ONE OPERATION. THE MOST SERIOUS THING v1.4.1 FIXES.
 *
 * Until this release `redeem` bound a ticket to an ACCOUNT and not to an
 * operation, so the four gates below spent each other's tickets: one minted to
 * download a backup was a live authorisation to DESTROY THE DATABASE for five
 * minutes. Minting still needed the password, so the exposure was a ticket
 * stolen from a page rather than an escalation any caller could arrange -- but
 * "the proof was for something else" is not something a gate should have to be
 * told twice.
 *
 * THE CROSS PRODUCT, NOT A CASE OR TWO. Every gate is offered every other
 * gate's ticket, because the pairs are not symmetrical in what they cost and
 * an argument about which of them matter is an argument this table does not
 * have to have. Twelve refusals and four acceptances.
 *
 * THE FOUR ACCEPTANCES ARE WHAT MAKES THE TWELVE REFUSALS MEAN ANYTHING. A
 * gate that refused EVERY ticket -- a scope misspelt on one side, say -- would
 * pass all twelve and be entirely broken. So each route is also shown taking
 * its OWN scope and getting past the gate, asserted on the raw body rather
 * than the status: past the gate these requests fail for their own reasons (a
 * body that is not multipart, a plan id that does not exist), which is fine
 * and is not what is being measured.
 */
const GATED = [
  {
    scope: "export" as const, method: "GET" as const, url: "/api/export",
    payload: undefined,
  },
  {
    scope: "backup" as const, method: "POST" as const, url: "/api/backup",
    payload: { passphrase: "correct-horse" },
  },
  // The two restore routes are handed a JSON body rather than a multipart one
  // deliberately: the gate runs BEFORE either handler looks at what it was
  // sent (routes/restore.ts orders it that way on purpose -- a caller with no
  // ticket must not get to write gigabytes into $data_dir), so a body that
  // cannot possibly succeed is enough to exercise the gate and nothing else.
  // It also keeps this file free of the multipart fixture restore.test.ts owns.
  {
    scope: "restore-preview" as const, method: "POST" as const,
    url: "/api/restore/inspect", payload: {},
  },
  {
    scope: "restore-apply" as const, method: "POST" as const,
    url: "/api/restore/apply", payload: {},
  },
];

describe.each(GATED)("the gate on $url spends $scope tickets and no others", (route) => {
  for (const other of GATED.filter((g) => g.scope !== route.scope)) {
    it(`refuses one minted for ${other.scope}`, async () => {
      const a = await app();
      const ticket = await reauthTicket(a, chris, other.scope);
      const response = await a.inject({
        method: route.method, url: route.url, payload: route.payload,
        headers: { ...chris, "x-conduit-reauth": ticket },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });
  }

  it("accepts its own, which is what stops the refusals above passing for nothing", async () => {
    const a = await app();
    const ticket = await reauthTicket(a, chris, route.scope);
    const response = await a.inject({
      method: route.method, url: route.url, payload: route.payload,
      headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(refusedByGate(response)).toBe(false);
  }, 120_000);
});

describe("a ticket offered at the wrong gate", () => {
  it("is spent by the attempt, and will not work at its own gate afterwards", async () => {
    // THE RULE A TICKET OFFERED FOR THE WRONG ACCOUNT ALREADY HAS, and for the
    // same reason: one that has been somewhere it should not have been is one
    // somebody else may be holding. Leaving it live so the right gate could
    // still take it would be the wrong instinct, and it would let a stolen
    // ticket be tried at all four gates for the price of one.
    const a = await app();
    const ticket = await reauthTicket(a, chris, "export");

    const wrong = await a.inject({
      method: "POST", url: "/api/restore/apply", payload: {},
      headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await a.inject({
      method: "GET", url: "/api/export",
      headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(right.statusCode).toBe(401);
    expect(right.json()).toMatchObject({ error: "reauth_required" });
  });
});

describe("HEAD /api/export", () => {
  it("does not exist, so nothing can build the whole archive for no bytes", async () => {
    // Fastify mirrors every GET with a HEAD by default, running the same
    // handler and discarding the body -- so a HEAD with a valid ticket built
    // the entire archive, held the one concurrency slot, spent the ticket and
    // answered with nothing. A review measured it returning 200. The route
    // opts out; there is no caller for it.
    const a = await app();
    const ticket = await reauthTicket(a, chris, "export");
    const response = await a.inject({
      method: "HEAD", url: "/api/export", headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(response.statusCode).toBe(404);
    // And the ticket was not spent by it, because the handler never ran.
    const download = await a.inject({
      method: "GET", url: "/api/export", headers: { ...chris, "x-conduit-reauth": ticket },
    });
    expect(download.statusCode).toBe(200);
  }, 120_000);
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

  it("carries no data, only sizes -- and NOT the server's free disk", async () => {
    // A route that answers without re-authentication must not be a way to read
    // anything. Its whole body is numbers and two booleans.
    //
    // THE EXHAUSTIVE KEY LIST IS THE DISCLOSURE CONTROL. `availableBytes` was
    // in it until a review pointed out what it is: the free space on the
    // server's disk, handed to anyone holding a session and no password. The
    // service still measures it -- routes/backup.ts projects the response field
    // by field and leaves it out -- so a future field cannot reach the wire by
    // being spread, and this list is what fails if one does.
    const response = await (await app()).inject({
      method: "GET", url: "/api/backup/preflight", headers: chris,
    });
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "blobBytes", "databaseBytes", "enoughDisk", "estimatedSeconds",
      "requiredBytes", "shortfallBytes", "slow", "timeoutSeconds",
    ]);
    expect(response.body).not.toContain("availableBytes");
  });

  it("collapses simultaneous callers onto ONE walk of the blob store", async () => {
    /*
     * Each answer costs a pg_database_size and a stat of every blob in the
     * store. There is deliberately no concurrency slot here -- a warning that
     * answers "busy" is no warning -- so the bound is sharing rather than
     * refusing.
     *
     * HOW THE SHARING IS OBSERVED, because the obvious test does not observe
     * it. The first version fired forty requests and asserted they all came
     * back identical, which is equally true of forty independent walks of a
     * directory that is not changing: a mutation that removed the sharing
     * outright left it green. What distinguishes reuse from recomputation is
     * CHANGING THE ANSWER UNDERNEATH and seeing the old one come back.
     */
    const a = await app();
    const blobDir = path.join(dataDir, "files");
    await mkdir(blobDir, { recursive: true });

    const first = await a.inject({ method: "GET", url: "/api/backup/preflight", headers: chris });
    expect(first.statusCode).toBe(200);
    const before = (first.json() as { blobBytes: number }).blobBytes;

    // A blob the next walk WOULD see, if a next walk happened.
    await writeFile(path.join(blobDir, "a".repeat(64)), Buffer.alloc(4096, 1));

    const answers = await Promise.all(Array.from({ length: 40 }, () => a.inject({
      method: "GET", url: "/api/backup/preflight", headers: chris,
    })));
    expect(answers.every((r) => r.statusCode === 200)).toBe(true);
    for (const answer of answers) {
      expect((answer.json() as { blobBytes: number }).blobBytes).toBe(before);
    }

    // AND IT IS A SHORT WINDOW, NOT A PERMANENT ANSWER. An operator who frees
    // space and reloads must not be told the old story for ever -- so the
    // reuse has to expire, and this is where that is asserted rather than
    // assumed. The window is three seconds; four is past it.
    await new Promise<void>((resolve) => { setTimeout(resolve, 4_000); });
    const afterwards = await a.inject({
      method: "GET", url: "/api/backup/preflight", headers: chris,
    });
    expect((afterwards.json() as { blobBytes: number }).blobBytes).toBe(before + 4096);
  }, 30_000);
});
