import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * Is a REAL YunoHost portal API listening where config.ts expects one?
 *
 * Probed rather than assumed, on the precedent of this suite's 7z and
 * WeasyPrint gates. The dev server is a YunoHost box and answers; a CI runner
 * and a developer's laptop are not and skip visibly.
 *
 * WHY IT IS WORTH A PROBE AT ALL: every other test of the portal verifier
 * points it at a stub or at a closed port, so the one path that runs in
 * production -- a real bind against a real portal -- had never been exercised
 * by anything. A review established it works; this is what keeps that true.
 */
const PORTAL_URL = "http://127.0.0.1:6788";
const HAVE_PORTAL = await fetch(new URL("/login", PORTAL_URL), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ credentials: "conduit-probe-no-such-user:x" }),
  signal: AbortSignal.timeout(2_000),
}).then((response) => response.status === 401, () => false);
const itPortal = HAVE_PORTAL ? it : it.skip;

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
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "guess" },
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
    // The deploy target's portal answers a bad bind in 1.5-1.7ms, so the
    // window is small there -- but "small" is not "bounded", and the window is
    // attacker-influenceable: the portal API is publicly reachable, so loading
    // it widens the gap for a simultaneous burst here.
    let reached = 0;
    const fast: ReauthVerifier = () => { reached += 1; return Promise.resolve(false); };
    const a = await app(fast);
    await Promise.all(Array.from({ length: 100 }, () => a.inject({
      method: "POST", url: "/api/reauth", headers: chris, payload: { password: "guess" },
    })));
    expect(reached).toBe(5);
  });

  it("leaves no lockout behind after a burst against a broken portal", async () => {
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
     * portal comes back, the account is not locked out by an outage it had no
     * part in. Every reservation was released, so the counter is clear.
     */
    let broken = true;
    const flaky: ReauthVerifier = (_user, password) =>
      broken
        ? new Promise((_resolve, reject) => { setTimeout(() => { reject(new Error("down")); }, 20); })
        : Promise.resolve(password === TEST_REAUTH_PASSWORD);
    const a = await app(flaky);
    const answers = await Promise.all(Array.from({ length: 50 }, () => a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    })));
    // Some got as far as the portal and some were refused while those were in
    // flight. Neither count is the property; that both codes appear is what
    // shows the burst really did contend, so the assertion after it is not
    // passing on an empty run.
    expect(answers.some((r) => r.statusCode === 503)).toBe(true);
    expect(answers.every((r) => r.statusCode === 503 || r.statusCode === 429)).toBe(true);
    expect(answers.some((r) => r.statusCode === 401)).toBe(false);

    broken = false;
    const recovered = await a.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD },
    });
    expect(recovered.statusCode, "the outage left no lockout behind").toBe(200);
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
      payload: { password: "from-the-environment" },
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
   * Every other test here points the verifier at a stub or at a closed port.
   * This one lets the default composition-root wiring reach the portal API on
   * the box it is running on and asserts what a wrong password does: a clean
   * 401 reauth_failed, not a 503 and not a ticket. Skipped where there is no
   * portal.
   *
   * The username is one that does not exist, and the portal answers the same
   * "Invalid password" either way -- so this tests nobody's credentials and
   * enumerates nothing.
   */
  itPortal("refuses a wrong password against the REAL portal, through the default wiring", async () => {
    const a = await buildApp({
      config: { ...config, portalApiUrl: PORTAL_URL },
      db: handle.db, dataDir,
    });
    const response = await a.inject({
      method: "POST", url: "/api/reauth",
      headers: {
        "ynh-user": "conduit-probe-no-such-user",
        "ynh-user-email": "nobody@example.com",
        "ynh-user-fullname": "Probe",
      },
      payload: { password: "definitely-not-the-password" },
    });
    // 401, which means the portal was REACHED and answered. A 503 here would
    // mean the verifier could not talk to it, and the assertion below is what
    // tells those two apart -- they are the two states this whole seam exists
    // to keep separate.
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

  it("fails when a junk value is sent alongside a real ticket, in either order", async () => {
    // WHY IT FAILS, corrected: Node joins repeated occurrences of an ordinary
    // header into ONE comma-separated string (only set-cookie becomes an
    // array), so the gate looks up "junk, <ticket>" or "<ticket>, junk" whole.
    // It misses the map. Nothing is refused for being an array -- there is no
    // array here to refuse.
    for (const order of ["junk-first", "ticket-first"] as const) {
      const a = await app();
      const ticket = await reauthTicket(a, chris);
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

describe("HEAD /api/export", () => {
  it("does not exist, so nothing can build the whole archive for no bytes", async () => {
    // Fastify mirrors every GET with a HEAD by default, running the same
    // handler and discarding the body -- so a HEAD with a valid ticket built
    // the entire archive, held the one concurrency slot, spent the ticket and
    // answered with nothing. A review measured it returning 200. The route
    // opts out; there is no caller for it.
    const a = await app();
    const ticket = await reauthTicket(a, chris);
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
