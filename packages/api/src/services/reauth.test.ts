import { describe, expect, it } from "vitest";
import {
  ReauthTickets, ReauthThrottle, REAUTH_TICKET_TTL_MS, PORTAL_TIMEOUT_MS,
  createFixedPasswordVerifier, createPortalVerifier,
} from "./reauth.js";

describe("ReauthTickets", () => {
  it("issues a ticket that redeems once, for the account it was issued to", () => {
    const tickets = new ReauthTickets();
    const token = tickets.issue("chris");
    expect(tickets.redeem(token, "chris")).toBe(true);
    // SINGLE USE. The second attempt is the whole property: a ticket that
    // survived its use would be a bearer token for every download until it
    // expired.
    expect(tickets.redeem(token, "chris")).toBe(false);
  });

  it("refuses a ticket presented for another account, and spends it anyway", () => {
    const tickets = new ReauthTickets();
    const token = tickets.issue("chris");
    expect(tickets.redeem(token, "sam")).toBe(false);
    // A ticket that has been offered to the wrong account is burnt, not left
    // live for the right one -- see redeem's doc comment.
    expect(tickets.redeem(token, "chris")).toBe(false);
  });

  it("refuses an invented ticket", () => {
    const tickets = new ReauthTickets();
    tickets.issue("chris");
    expect(tickets.redeem("f".repeat(64), "chris")).toBe(false);
    expect(tickets.redeem("", "chris")).toBe(false);
  });

  it("refuses a ticket after its lifetime, and keeps it before", () => {
    const tickets = new ReauthTickets();
    const issuedAt = 1_000_000;
    const token = tickets.issue("chris", issuedAt);
    // One millisecond short of the deadline: still good.
    expect(tickets.redeem(token, "chris", issuedAt + REAUTH_TICKET_TTL_MS - 1)).toBe(true);

    const other = tickets.issue("chris", issuedAt);
    expect(tickets.redeem(other, "chris", issuedAt + REAUTH_TICKET_TTL_MS)).toBe(false);
  });

  it("does not grow without bound when tickets are minted in a loop", () => {
    const tickets = new ReauthTickets();
    const first = tickets.issue("chris");
    for (let i = 0; i < 200; i += 1) tickets.issue("chris");
    // The bound is 64; what matters is that it is BOUNDED, and that the oldest
    // went rather than the newest -- dropping the newest would let a flood lock
    // out the person actually waiting on one.
    expect(tickets.size()).toBeLessThanOrEqual(64);
    expect(tickets.redeem(first, "chris")).toBe(false);
  });

  it("forgets expired tickets rather than counting them for ever", () => {
    const tickets = new ReauthTickets();
    const at = 5_000;
    tickets.issue("chris", at);
    tickets.issue("chris", at);
    expect(tickets.size(at)).toBe(2);
    expect(tickets.size(at + REAUTH_TICKET_TTL_MS)).toBe(0);
  });
});

describe("ReauthThrottle", () => {
  it("allows attempts until the limit, then locks the account out", () => {
    const throttle = new ReauthThrottle(3, 60_000);
    const at = 1_000;
    expect(throttle.reserve("chris", at)).toBe(0);
    expect(throttle.reserve("chris", at)).toBe(0);
    expect(throttle.reserve("chris", at)).toBe(0);
    expect(throttle.reserve("chris", at)).toBe(60_000);
  });

  /**
   * THE PROPERTY THE FIRST VERSION DID NOT HAVE, and the reason `reserve`
   * exists at all. The route used to read the counter, await the password
   * check, and record the failure afterwards -- so every request that arrived
   * inside the await saw a counter that had not moved.
   *
   * This is that shape, reduced to its arithmetic: N callers all read before
   * any of them writes. With a check-then-write pair every one of them gets
   * through; with `reserve` exactly `maxAttempts` do.
   */
  it("counts an attempt AT THE CHECK, so simultaneous callers cannot all pass", () => {
    const throttle = new ReauthThrottle(5, 60_000);
    const at = 1_000;
    const allowed = Array.from({ length: 200 }, () => throttle.reserve("chris", at) === 0);
    expect(allowed.filter(Boolean)).toHaveLength(5);

    // And the old shape, for contrast: reading without counting lets all 200
    // through, which is exactly what was measured against the real server.
    const loose = new ReauthThrottle(5, 60_000);
    const readOnly = Array.from({ length: 200 }, () => loose.retryAfterMs("chris", at) === 0);
    expect(readOnly.filter(Boolean)).toHaveLength(200);
  });

  it("gives an attempt back when nothing was tested", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    const at = 1_000;
    expect(throttle.reserve("chris", at)).toBe(0);
    throttle.release("chris", at);
    // The released attempt is genuinely back: two more are still allowed.
    expect(throttle.reserve("chris", at)).toBe(0);
    expect(throttle.reserve("chris", at)).toBe(0);
    expect(throttle.reserve("chris", at)).toBe(60_000);
  });

  it("forgets an account entirely once its last attempt is released", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    throttle.reserve("chris", 1_000);
    throttle.release("chris", 1_000);
    expect(throttle.size()).toBe(0);
  });

  it("lets the account back in once the window has passed", () => {
    const throttle = new ReauthThrottle(1, 60_000);
    throttle.reserve("chris", 1_000);
    expect(throttle.retryAfterMs("chris", 1_000)).toBe(60_000);
    expect(throttle.retryAfterMs("chris", 61_001)).toBe(0);
  });

  it("counts from one again after a window has run out, rather than resuming", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    throttle.reserve("chris", 1_000);
    // Long after the first window: this is a fresh first attempt, so one more
    // is still allowed.
    throttle.reserve("chris", 500_000);
    expect(throttle.reserve("chris", 500_000)).toBe(0);
  });

  it("clears the count on a correct password", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    throttle.reserve("chris", 1_000);
    throttle.succeed("chris");
    throttle.reserve("chris", 1_000);
    expect(throttle.reserve("chris", 1_000)).toBe(0);
  });

  it("locks one account without touching another", () => {
    const throttle = new ReauthThrottle(1, 60_000);
    throttle.reserve("chris", 1_000);
    expect(throttle.retryAfterMs("chris", 1_000)).toBe(60_000);
    expect(throttle.retryAfterMs("sam", 1_000)).toBe(0);
  });

  /**
   * THE MAP IS BOUNDED, and it needs to be for a reason narrower than tidiness:
   * the key is a username taken from the Ynh-User header, and any LOCAL process
   * on the box can set that freely (the app binds loopback and nginx forwards
   * $http_ynh_user). ReauthTickets was capped from the start with a comment
   * about exactly this; a review found that this map was not.
   */
  it("does not grow without bound when the account name varies", () => {
    const throttle = new ReauthThrottle(5, 60_000);
    for (let i = 0; i < 20_000; i += 1) throttle.reserve(`account-${String(i)}`, 1_000);
    expect(throttle.size()).toBeLessThanOrEqual(4096);
  });

  it("forgets expired accounts before it evicts live ones", () => {
    const throttle = new ReauthThrottle(5, 60_000);
    for (let i = 0; i < 5_000; i += 1) throttle.reserve(`old-${String(i)}`, 1_000);
    // Long after every one of those windows: one new account should find room
    // by sweeping rather than by evicting, and should be remembered.
    throttle.reserve("chris", 10_000_000);
    expect(throttle.retryAfterMs("chris", 10_000_000)).toBe(0);
    expect(throttle.size()).toBeLessThan(4096);
  });
});

describe("createFixedPasswordVerifier", () => {
  it("accepts the exact password and nothing else", async () => {
    const verify = createFixedPasswordVerifier("hunter2");
    await expect(verify("chris", "hunter2")).resolves.toBe(true);
    await expect(verify("chris", "hunter")).resolves.toBe(false);
    await expect(verify("chris", "hunter22")).resolves.toBe(false);
    await expect(verify("chris", "Hunter2")).resolves.toBe(false);
    await expect(verify("chris", "")).resolves.toBe(false);
  });
});

describe("createPortalVerifier", () => {
  /**
   * A LOCAL HTTP SERVER STANDING IN FOR THE PORTAL API, so what is asserted is
   * the REQUEST this function makes -- the path, the body shape and the
   * credentials format -- rather than a mock's recollection of it. The real
   * portal's answers are reproduced from a measurement on the deploy target:
   * POST /login with {"credentials":"user:password"} returns 200 on a good bind
   * and 401 with "Invalid password" on a bad one.
   */
  async function withPortal(
    handler: (path: string, body: string) => { status: number; body?: string },
    run: (url: string, seen: { path: string; body: string }[]) => Promise<void>,
  ): Promise<void> {
    const http = await import("node:http");
    const seen: { path: string; body: string }[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ path: request.url ?? "", body });
        const answer = handler(request.url ?? "", body);
        response.writeHead(answer.status, { "Content-Type": "text/plain" });
        response.end(answer.body ?? "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      await run(`http://127.0.0.1:${String(address.port)}`, seen);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  }

  it("posts credentials to /login and reads a 200 as success", async () => {
    await withPortal(() => ({ status: 200, body: "Logged in" }), async (url, seen) => {
      const verify = createPortalVerifier(url);
      await expect(verify("chris", "hunter2")).resolves.toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.path).toBe("/login");
      // The exact wire format moulinette's login handler parses. It splits on
      // the FIRST colon, which is why a password containing one is safe.
      expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ credentials: "chris:hunter2" });
    });
  });

  it("sends a password containing a colon whole", async () => {
    await withPortal(() => ({ status: 200 }), async (url, seen) => {
      const verify = createPortalVerifier(url);
      await verify("chris", "a:b:c");
      expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ credentials: "chris:a:b:c" });
    });
  });

  it("reads a 401 as a wrong password", async () => {
    await withPortal(() => ({ status: 401, body: "Invalid password" }), async (url) => {
      await expect(createPortalVerifier(url)("chris", "wrong")).resolves.toBe(false);
    });
  });

  it("THROWS rather than answering false when the portal is broken", async () => {
    // The distinction the route depends on: false means "checked, and wrong",
    // and would tell the operator to retype a password that was right.
    await withPortal(() => ({ status: 502 }), async (url) => {
      await expect(createPortalVerifier(url)("chris", "hunter2")).rejects.toThrow(/502/);
    });
  });

  it("gives up on a portal that accepts the connection and then says nothing", async () => {
    // PORTAL_TIMEOUT_MS had no test at all. Driven with a short injected
    // timeout rather than the real ten seconds -- the bound is what is under
    // test, not its value, and the value is asserted separately below.
    const http = await import("node:http");
    const server = http.createServer(() => { /* accept, and never answer */ });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      const verify = createPortalVerifier(`http://127.0.0.1:${String(address.port)}`, 150);
      const started = Date.now();
      await expect(verify("chris", "hunter2")).rejects.toThrow();
      // Bounded, rather than hanging until the request's own deadline.
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });

  it("allows the portal ten seconds by default", () => {
    // Shorter than the 30s nginx gives its own portal location (measured on
    // the deploy target), because a person is watching a spinner over this.
    expect(PORTAL_TIMEOUT_MS).toBe(10_000);
    expect(PORTAL_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("throws when nothing is listening at all", async () => {
    // Port 1 on loopback: nothing binds it, and connect fails immediately.
    await expect(createPortalVerifier("http://127.0.0.1:1")("chris", "x")).rejects.toThrow();
  });
});
