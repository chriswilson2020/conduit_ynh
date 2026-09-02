import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  ReauthTickets, ReauthThrottle, REAUTH_TICKET_TTL_MS, LDAP_TIMEOUT_MS,
  createFixedPasswordVerifier, createLdapVerifier,
} from "./reauth.js";
import { startFakeDirectory } from "../test/ldap-directory.js";
import type { FakeDirectory, FakeDirectoryOptions } from "../test/ldap-directory.js";

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

describe("createLdapVerifier", () => {
  /**
   * THE ACCOUNT THIS SUITE BINDS AS, spelled out rather than built with the
   * helper under test.
   *
   * `USERDN = "uid={username},ou=users,dc=yunohost,dc=org"` is YunoHost's own
   * constant, read from
   * /usr/lib/python3/dist-packages/yunohost/authenticators/ldap_ynhuser.py:62
   * on the deploy target at 12.1.40.1 on 2 Sep, and `ou=users,dc=yunohost,dc=org`
   * answered an anonymous base search there. Writing it out again here is the
   * point: a test that asked the verifier's own helper for the expected DN
   * could only ever agree with itself.
   */
  const CHRIS_DN = "uid=chris,ou=users,dc=yunohost,dc=org";

  /** Poll until `check` holds, so a socket closing on its own turn is waited
   *  for rather than assumed to have already happened. */
  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function withDirectory(
    options: FakeDirectoryOptions,
    run: (directory: FakeDirectory) => Promise<void>,
  ): Promise<void> {
    const directory = await startFakeDirectory(options);
    try {
      await run(directory);
    } finally {
      await directory.close();
    }
  }

  it("binds the account's own DN with the password it was handed, and says yes", async () => {
    await withDirectory({ accounts: { [CHRIS_DN]: "hunter2" } }, async (directory) => {
      await expect(createLdapVerifier(directory.url)("chris", "hunter2")).resolves.toBe(true);
      // On the wire, not in a mock: the DN template and the password both
      // arrived exactly as YunoHost's own authenticator would have sent them.
      expect(directory.binds).toEqual([{ dn: CHRIS_DN, password: "hunter2" }]);
    });
  });

  it("carries a password through byte for byte", async () => {
    // There is no wire format to get wrong here any more -- the portal's
    // "user:password" colon split is gone with the portal -- so this is a
    // bound on the ONE thing that could still mangle a real password: the
    // journey out of JSON, through the verifier and into a BER octet string.
    const password = "a:b\\c,d£€ İ";
    await withDirectory({ accounts: { [CHRIS_DN]: password } }, async (directory) => {
      await expect(createLdapVerifier(directory.url)("chris", password)).resolves.toBe(true);
      expect(directory.binds[0]?.password).toBe(password);
    });
  });

  it("answers false, not a throw, when the directory refuses the credentials", async () => {
    await withDirectory({ accounts: { [CHRIS_DN]: "hunter2" } }, async (directory) => {
      const verify = createLdapVerifier(directory.url);
      // Result code 49 is the whole of "checked, and wrong" -- the route turns
      // it into a 401 that tells the operator to retype.
      await expect(verify("chris", "hunter")).resolves.toBe(false);
      await expect(verify("chris", "Hunter2")).resolves.toBe(false);
    });
  });

  it("answers false for an account the directory has never heard of", async () => {
    // A bind as a name that does not exist answers 49, the same code a wrong
    // password does -- measured against the deploy target's slapd on 2 Sep with
    // uid=conduit-probe-no-such-user. That is what keeps this endpoint from
    // being a user enumerator, and it is the directory's property rather than
    // this code's, so it is worth an assertion.
    await withDirectory({ accounts: { [CHRIS_DN]: "hunter2" } }, async (directory) => {
      await expect(createLdapVerifier(directory.url)("nobody", "hunter2")).resolves.toBe(false);
    });
  });

  it("REFUSES AN EMPTY PASSWORD WITHOUT BINDING, against a directory that would have said yes", async () => {
    // THE SHARPEST EDGE IN THIS FILE. A simple bind carrying a DN and a
    // zero-length password is RFC 4513's unauthenticated authentication
    // mechanism: the directory below answers SUCCESS to it, as OpenLDAP does
    // the moment `allow bind_anon_dn` is set. A verifier that bound and read
    // "no exception thrown" as proof of identity would authenticate anybody who
    // sent an empty password.
    //
    // The second assertion is the one that makes this test worth having: the
    // bind never happened at all. Nothing was asked, so nothing could answer.
    await withDirectory(
      { accounts: { [CHRIS_DN]: "hunter2" }, unauthenticatedBind: "success-as-anonymous" },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "")).resolves.toBe(false);
        expect(directory.binds).toEqual([]);
      },
    );
  });

  it("refuses an empty password the same way when the directory would have refused it too", async () => {
    // The other half of the same edge, and the reason the guard cannot be left
    // to the directory: what slapd does here is `allow bind_anon_dn` in a
    // config file Conduit does not own. Measured on the deploy target, that box
    // answers 53 ("unauthenticated bind (DN with no password) disallowed"), and
    // 53 is not 49 -- so without the guard the SAME empty password would be a
    // THROW here and a successful bind above. The verifier's answer must not
    // depend on which box it is running against.
    await withDirectory(
      { accounts: { [CHRIS_DN]: "hunter2" }, unauthenticatedBind: "unwilling" },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "")).resolves.toBe(false);
        expect(directory.binds).toEqual([]);
      },
    );
  });

  it("escapes the username INTO THE DN, so a crafted one cannot add RDNs of its own", async () => {
    // THE USERNAME IS THE Ynh-User HEADER, which any local process on the box
    // can set (services/reauth.ts says so twice), so it is attacker-shaped
    // input interpolated into a DN. This directory has an account at the DN a
    // NAIVE CONCATENATION would have produced, and knows its password -- so a
    // verifier that built the DN with string interpolation would bind
    // successfully and answer TRUE here.
    //
    // YunoHost's own code escapes this value with `escape_filter_chars`, which
    // is the escaper for a SEARCH FILTER and does nothing to a comma. Copying
    // it would have made this test pass for the wrong reason.
    const smuggled = "admin,ou=x";
    await withDirectory(
      { accounts: { "uid=admin,ou=x,ou=users,dc=yunohost,dc=org": "smuggled" } },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)(smuggled, "smuggled")).resolves.toBe(false);
        // One RDN, with the comma and the equals sign inside its value.
        expect(directory.binds[0]?.dn)
          .toBe("uid=admin\\,ou\\=x,ou=users,dc=yunohost,dc=org");
      },
    );
  });

  it("asks whoami and disbelieves a bind that succeeded as somebody else", async () => {
    // YunoHost's authenticator does exactly this, one line after its own bind,
    // and it is the second line of defence behind the empty-password guard: a
    // session whose authorization identity is not the DN that was asked for has
    // proved nothing about this account.
    await withDirectory(
      { accounts: { [CHRIS_DN]: "hunter2" }, whoamiAs: "dn:uid=sam,ou=users,dc=yunohost,dc=org" },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "hunter2")).resolves.toBe(false);
      },
    );
  });

  it("disbelieves a session that turns out to be anonymous", async () => {
    // RFC 4532 answers an anonymous session with an ABSENT value rather than
    // with a name, which is what `whoamiAs: ""` sends here. This is the case
    // the empty-password guard already stops -- and it is asserted separately
    // because it is the shape a bind that silently fell back to anonymous
    // takes, and one guard failing should not take the other down with it.
    await withDirectory(
      { accounts: { [CHRIS_DN]: "hunter2" }, whoamiAs: "" },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "hunter2")).resolves.toBe(false);
      },
    );
  });

  it("accepts the directory's own spelling of the DN it bound", async () => {
    // slapd answers whoami with its normalised form of the DN, which can differ
    // from the string that was sent in the case of the attribute types. `uid`
    // is caseIgnoreMatch in RFC 4519, so "UID=Chris,OU=users,..." names the
    // same entry and must not read as somebody else -- a case-sensitive
    // comparison here would refuse every correct password on a directory that
    // normalises, which is the bug this whole task exists to fix, repeated.
    await withDirectory(
      { accounts: { [CHRIS_DN]: "hunter2" }, whoamiAs: "dn:UID=chris,OU=users,DC=yunohost,DC=org" },
      async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "hunter2")).resolves.toBe(true);
      },
    );
  });

  it("THROWS on a refusal that is not about the password: 49 is false, 53 and 51 are not", async () => {
    // THE DISTINCTION THIS RELEASE EXISTS OVER, in its general form. The portal
    // bug was a "no" that meant "not allowed on that domain" being read as
    // "wrong password", and the operator was sent away to retype something that
    // was right. Only 49 says anything about a password. A directory that is
    // unwilling (53) or busy (51) has said nothing, and the route must answer
    // 503 -- which it can only do if this throws.
    for (const code of [53, 51]) {
      await withDirectory({ answerBindWith: code }, async (directory) => {
        await expect(createLdapVerifier(directory.url)("chris", "hunter2"))
          .rejects.toThrow();
      });
    }
    // The same fixture, the same path, answering 49: false rather than a throw.
    // Without this the assertions above would also pass on a verifier that
    // threw on everything.
    await withDirectory({ answerBindWith: 49 }, async (directory) => {
      await expect(createLdapVerifier(directory.url)("chris", "hunter2")).resolves.toBe(false);
    });
  });

  it("THROWS rather than answering false when nothing is listening", async () => {
    // The distinction the route depends on: false would tell the operator to
    // retype a password that was right. Port 1 on loopback, where nothing
    // binds, so connect fails immediately -- deterministic on a runner and on
    // the dev server, which is itself a YunoHost box with a real directory on
    // 389 that would answer 49 and hide the difference.
    await expect(createLdapVerifier("ldap://127.0.0.1:1")("chris", "hunter2")).rejects.toThrow();
  });

  it("gives up on a directory that accepts the connection and then says nothing", async () => {
    await withDirectory({ silent: true }, async (directory) => {
      // Driven with a short injected budget rather than the real five seconds:
      // the bound is what is under test, and its value is asserted separately
      // below.
      const started = Date.now();
      await expect(createLdapVerifier(directory.url, 150)("chris", "hunter2")).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it("allows the directory five seconds by default", () => {
    expect(LDAP_TIMEOUT_MS).toBe(5_000);
    // Shorter than the ten the portal API was given, because the HTTP hop that
    // number was sized against is gone: what is left is a bind on a socket on
    // the same machine.
    expect(LDAP_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it("leaves no connection open, on the path that says yes, the one that says no, or the one that throws", async () => {
    await withDirectory({ accounts: { [CHRIS_DN]: "hunter2" } }, async (directory) => {
      const verify = createLdapVerifier(directory.url);
      await verify("chris", "hunter2");
      await until(() => directory.openConnections() === 0, "the successful bind to be unbound");
      await verify("chris", "wrong");
      await until(() => directory.openConnections() === 0, "the refused bind to be unbound");
    });
    // The throwing path is the one a `finally`-less implementation leaks on,
    // because the socket is already open when the throw happens -- a connection
    // that was never made cannot be left behind.
    await withDirectory({ silent: true }, async (directory) => {
      await expect(createLdapVerifier(directory.url, 150)("chris", "hunter2")).rejects.toThrow();
      await until(() => directory.openConnections() === 0, "the timed-out connection to be closed");
    });
  });
});

/**
 * THE TWO THINGS ABOUT THE REAL DIRECTORY THAT THIS CODE IS BUILT ON.
 *
 * Both were measured by hand on the deploy target on 2 Sep and both would
 * otherwise sit in a comment, where nothing would notice them going stale --
 * and a stale assumption about what a directory does with an empty password is
 * how an authentication bypass gets written. Skipped where there is no
 * directory, which is every runner and every laptop.
 *
 * NEITHER USES ANYBODY'S CREDENTIALS. The account named does not exist, and a
 * directory answers 49 for that exactly as it does for a wrong password, so
 * these prove nothing about who has an account and enumerate nothing.
 */
const HAVE_DIRECTORY = await new Promise<boolean>((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: 389 });
  const settle = (answer: boolean): void => { socket.destroy(); resolve(answer); };
  socket.setTimeout(2_000);
  socket.once("connect", () => { settle(true); });
  socket.once("timeout", () => { settle(false); });
  socket.once("error", () => { settle(false); });
});
const describeDirectory = HAVE_DIRECTORY ? describe : describe.skip;

describeDirectory("createLdapVerifier against the REAL directory", () => {
  const NOBODY = "conduit-probe-no-such-user";

  it("answers false, not a throw, for a password the directory rejects", async () => {
    // 49 comes back for an account that does not exist. That it is `false`
    // rather than a throw ALSO proves slapd parsed the DN this code builds:
    // a suffix it could not read would be 34, invalidDNSyntax, which this
    // verifier throws on.
    await expect(createLdapVerifier("ldap://127.0.0.1:389")(NOBODY, "definitely-not-it"))
      .resolves.toBe(false);
  });

  it("refuses an empty password without asking the directory what it thinks", async () => {
    // THE ASSUMPTION THIS PINS. Task 0's brief said an empty simple bind
    // "returns SUCCESS"; measured against this box it returns 53,
    // "unauthenticated bind (DN with no password) disallowed", because
    // OpenLDAP wants `allow bind_anon_dn` before it will do that. Both answers
    // are configuration, neither is Conduit's, and the guard is what makes the
    // ANSWER HERE the same on either box -- false, and counted as an attempt,
    // rather than a 503 with the attempt handed back.
    await expect(createLdapVerifier("ldap://127.0.0.1:389")(NOBODY, ""))
      .resolves.toBe(false);
  });
});
