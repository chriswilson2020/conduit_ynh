import { describe, expect, it } from "vitest";
import {
  ReauthTickets, ReauthThrottle, REAUTH_TICKET_TTL_MS,
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
    expect(throttle.retryAfterMs("chris", at)).toBe(0);
    throttle.fail("chris", at);
    throttle.fail("chris", at);
    expect(throttle.retryAfterMs("chris", at)).toBe(0);
    throttle.fail("chris", at);
    expect(throttle.retryAfterMs("chris", at)).toBe(60_000);
  });

  it("lets the account back in once the window has passed", () => {
    const throttle = new ReauthThrottle(1, 60_000);
    throttle.fail("chris", 1_000);
    expect(throttle.retryAfterMs("chris", 1_000)).toBe(60_000);
    expect(throttle.retryAfterMs("chris", 61_001)).toBe(0);
  });

  it("counts from one again after a window has run out, rather than resuming", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    throttle.fail("chris", 1_000);
    // Long after the first window: this is a fresh first failure, so one more
    // is still allowed.
    throttle.fail("chris", 500_000);
    expect(throttle.retryAfterMs("chris", 500_000)).toBe(0);
  });

  it("clears the count on a correct password", () => {
    const throttle = new ReauthThrottle(2, 60_000);
    throttle.fail("chris", 1_000);
    throttle.succeed("chris");
    throttle.fail("chris", 1_000);
    expect(throttle.retryAfterMs("chris", 1_000)).toBe(0);
  });

  it("locks one account without touching another", () => {
    const throttle = new ReauthThrottle(1, 60_000);
    throttle.fail("chris", 1_000);
    expect(throttle.retryAfterMs("chris", 1_000)).toBe(60_000);
    expect(throttle.retryAfterMs("sam", 1_000)).toBe(0);
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

  it("throws when nothing is listening at all", async () => {
    // Port 1 on loopback: nothing binds it, and connect fails immediately.
    await expect(createPortalVerifier("http://127.0.0.1:1")("chris", "x")).rejects.toThrow();
  });
});
