import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RE-AUTHENTICATION FOR THE TWO 7.6 DOWNLOADS. Chris approved it on 31 Aug.
 *
 * WHAT IT IS FOR, because "ask for the password again" is a shape that gets
 * added for ceremony and this one is not. 7.6 makes exfiltration EASIER:
 * before it, stealing this CRM meant scraping the UI page by page; after it,
 * anyone holding a session downloads the whole thing in one click -- and the
 * BACKUP additionally carries mail.key and every stored mail password. That is
 * a real trade and the right one, but it must not ship neutral.
 *
 * AND THE SESSION COOKIE IS THE ENTIRE PERIMETER. Measured on the deploy
 * target rather than assumed: YunoHost 12.1.40.1 with SSOwat 12.1.1, and a
 * search of the actionsmap, the python modules and the portal for
 * totp/mfa/two_factor/2fa returns nothing. There is no second factor to fall
 * back on, so a one-click full-data download needs a gate of its own.
 *
 * AN ACTUAL CREDENTIAL CHECK, NOT A CONFIRM DIALOG. "Are you sure?" proves
 * that someone clicked; it proves nothing about who. What this verifies is the
 * password of the signed-in YunoHost account, against YunoHost itself.
 *
 * THE VERIFIER IS INJECTED, and that is the same seam mail-send's
 * transportFactory uses, for the same reason: how a credential is checked is
 * the composition root's decision (server.ts), not this module's and not a
 * route's. Production wires createPortalVerifier; a test wires a function.
 */

/**
 * Answers one question and returns nothing else: is this the password of this
 * account, right now.
 *
 * DELIBERATELY NOT A "why not" CHANNEL. A verifier that could say "no such
 * user" separately from "wrong password" would make this endpoint a user
 * enumerator, and nothing above it wants the distinction -- the route sends one
 * refusal for every false.
 *
 * A THROWN ERROR IS NOT `false`. False means "checked, and wrong"; a throw
 * means the check could not be made (the portal API is down, the network
 * refused). The route answers those differently on purpose: a 401 tells the
 * operator to retype, and a 503 tells them the thing that checks passwords is
 * not answering, which is not a fact about their typing.
 */
export type ReauthVerifier = (username: string, password: string) => Promise<boolean>;

/**
 * How long the portal API is given to answer.
 *
 * It binds an LDAP bind, which is local and fast; nginx's own portal location
 * allows 30s (measured in /etc/nginx/conf.d/yunohost_api.conf.inc on the
 * deploy target) and this is deliberately shorter, because a person is
 * watching a spinner over it and a re-auth that hangs for half a minute is one
 * they will click again.
 */
const PORTAL_TIMEOUT_MS = 10_000;

/**
 * Check a password against YunoHost's own portal API.
 *
 * THIS IS THE SAME DOOR THE SSO PORTAL USES, which is the whole argument for
 * it: Conduit does not store a password, cannot store one, and must not start.
 * `POST /login` on the portal API (127.0.0.1:6788, proxied publicly at
 * /yunohost/portalapi/ -- see YunoHost's own nginx include) takes
 * `{"credentials": "user:password"}`, performs an LDAP simple bind as that
 * user, and answers 200 or 401. Measured on the deploy target: a bad pair
 * returns 401 with the body "Invalid password".
 *
 * IT IS CALLED OVER LOOPBACK, NOT THROUGH NGINX, and that has one consequence
 * worth stating rather than discovering. YunoHost's fail2ban `yunohost-portal`
 * jail reads nginx's access and error logs; a request that never reaches nginx
 * writes nothing there and so is never counted. That is NOT a hole this
 * function opens -- YunoHost's own authenticator carries the comment "FIXME
 * FIXME FIXME : this should be properly logged and caught by Fail2ban" on
 * exactly this path, so a failed portal login is uncounted through nginx too --
 * but it does mean nothing upstream is throttling guesses. ReauthThrottle
 * below is this app's own answer to that, and it is not optional.
 *
 * THE USERNAME IS NEVER THE CLIENT'S. The route passes the identity SSOwat
 * already established for the request, so this cannot be used to test a
 * password against some other account.
 */
export function createPortalVerifier(portalApiUrl: string): ReauthVerifier {
  return async (username, password) => {
    const response = await fetch(new URL("/login", portalApiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // The colon split is the portal's own format, and the password is what
      // may contain one: moulinette splits on the FIRST colon (its login
      // handler does `credentials.split(":", 1)`), so a password containing
      // colons survives and a username containing one is not a thing YunoHost
      // allows.
      body: JSON.stringify({ credentials: `${username}:${password}` }),
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
    if (response.status === 401) return false;
    if (!response.ok) {
      // NOT `false`. A 500 from the portal, or a 502 because it is not
      // running, is not evidence about this password -- see ReauthVerifier.
      throw new Error(`the portal API answered ${String(response.status)}`);
    }
    return true;
  };
}

/**
 * A verifier that compares against one configured password.
 *
 * FOR DEVELOPMENT AND CI ONLY, and config.ts refuses to boot with it set under
 * NODE_ENV=production -- the same guard, in the same place, that CONDUIT_DEV_USER
 * has carried since Phase 0. It exists because neither a developer's machine
 * nor a GitHub runner has a YunoHost portal to bind against, and a gate that
 * cannot be exercised anywhere but the deploy target is a gate nobody proves.
 *
 * The comparison is timing-safe. That is close to pointless for a fixture, and
 * it is written this way so that nobody reading it later learns the wrong shape
 * from the file that is easiest to copy.
 */
export function createFixedPasswordVerifier(expected: string): ReauthVerifier {
  const expectedBytes = Buffer.from(expected, "utf8");
  return (_username, password) => {
    const given = Buffer.from(password, "utf8");
    const ok = given.length === expectedBytes.length && timingSafeEqual(given, expectedBytes);
    return Promise.resolve(ok);
  };
}

/**
 * How long a redeemed-once ticket stays valid.
 *
 * Five minutes: long enough that typing a passphrase, reading the warnings and
 * clicking Download is comfortable, short enough that a ticket left in a tab
 * on an unlocked machine is not a standing key to the whole database. It is
 * measured from issue, never extended.
 */
export const REAUTH_TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * How many tickets may be outstanding before the oldest are dropped.
 *
 * A BOUND, NOT A POLICY. Tickets expire on their own and the sweep below
 * removes them lazily, but "lazily" is doing work only when something calls in
 * -- and an authenticated caller can ask for tickets in a loop. This is what
 * stops that being an unbounded map in a process with 3.8GB and no swap.
 */
const MAX_OUTSTANDING_TICKETS = 64;

interface TicketRecord { username: string; expiresAt: number }

/**
 * ONE-USE TICKETS, AND WHY THE DOWNLOADS DO NOT JUST CARRY THE PASSWORD.
 *
 * The export is a GET. Task 2 chose POST for the backup precisely so a
 * passphrase would not reach nginx's access log or the browser's history in a
 * query string, and the same argument applies with more force to an account
 * password -- so the password is posted ONCE, to /api/reauth, and what travels
 * with the download is this: an opaque, single-use, short-lived string bound to
 * the account that proved itself.
 *
 * SINGLE-USE IS THE POINT, not a detail. A ticket that survived its use would
 * be a bearer token for every download until it expired; one that is consumed
 * at the gate means "one proof, one archive", which is the literal reading of
 * the requirement -- re-authentication before EITHER download.
 *
 * BOUND TO A USERNAME, so a ticket issued to one account cannot be presented by
 * another. There is one user on this install today and that is not a reason to
 * skip it.
 *
 * IN MEMORY, PER PROCESS, and that is the whole deployment: one systemd unit,
 * one node process (conf/systemd.service). A restart invalidates every
 * outstanding ticket, which is the correct behaviour rather than a limitation.
 */
export class ReauthTickets {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(private readonly ttlMs: number = REAUTH_TICKET_TTL_MS) {}

  /**
   * A ticket for `username`, valid once.
   *
   * 32 bytes of CSPRNG output, hex. Not a JWT and not derived from anything:
   * there is nothing to encode, and a value with structure invites somebody to
   * read it.
   */
  issue(username: string, now: number = Date.now()): string {
    this.sweep(now);
    // The bound is enforced by dropping the OLDEST, which a Map gives for free
    // in insertion order. Dropping the newest would let a flood lock out the
    // person who is actually waiting on one.
    while (this.tickets.size >= MAX_OUTSTANDING_TICKETS) {
      const oldest = this.tickets.keys().next();
      if (oldest.done === true) break;
      this.tickets.delete(oldest.value);
    }
    const token = randomBytes(32).toString("hex");
    this.tickets.set(token, { username, expiresAt: now + this.ttlMs });
    return token;
  }

  /**
   * Spend a ticket. True only if it exists, has not expired, and belongs to
   * `username`.
   *
   * THE DELETE HAPPENS ON EVERY PATH THAT FOUND A RECORD, including the two
   * refusals. A ticket presented for the wrong account is a ticket that has
   * been somewhere it should not have been, and leaving it live so the right
   * account could still use it would be the wrong instinct.
   */
  redeem(token: string, username: string, now: number = Date.now()): boolean {
    const record = this.tickets.get(token);
    if (record === undefined) return false;
    this.tickets.delete(token);
    if (record.expiresAt <= now) return false;
    return record.username === username;
  }

  /** Outstanding, unexpired tickets. Exposed so a test can see the sweep work. */
  size(now: number = Date.now()): number {
    this.sweep(now);
    return this.tickets.size;
  }

  private sweep(now: number): void {
    for (const [token, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(token);
    }
  }
}

/** Wrong attempts allowed inside one window before an account is locked out. */
export const REAUTH_MAX_ATTEMPTS = 5;

/** How long the window is, and how long a lockout lasts once it trips. */
export const REAUTH_LOCKOUT_MS = 15 * 60 * 1000;

interface AttemptRecord { failures: number; until: number }

/**
 * PER-ACCOUNT THROTTLING OF WRONG PASSWORDS, AND IT IS LOAD-BEARING RATHER
 * THAN BELT-AND-BRACES.
 *
 * The measurement that makes it so: YunoHost's fail2ban jails read nginx's
 * logs, and this app talks to the portal API over loopback, so nothing there
 * counts a failure. Worse, YunoHost's own ldap_ynhuser authenticator carries a
 * FIXME saying failed logins are not caught by fail2ban at all -- so there is
 * no upstream throttle to inherit even through the portal's public path.
 *
 * Without this, /api/reauth would be an unmetered oracle for guessing the
 * account password of a YunoHost server, reachable by anyone holding a session
 * -- which is exactly the attacker the gate exists to stop, handed a better
 * tool than the one they came with.
 *
 * KEYED ON THE USERNAME, not the IP. The username is the thing being attacked
 * and the thing the app actually knows; req.ip behind nginx is one hop's
 * X-Forwarded-For and an attacker with a session can vary it.
 *
 * A SUCCESS CLEARS THE COUNTER. The window is for wrong answers.
 */
export class ReauthThrottle {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(
    private readonly maxAttempts: number = REAUTH_MAX_ATTEMPTS,
    private readonly lockoutMs: number = REAUTH_LOCKOUT_MS,
  ) {}

  /** Milliseconds still to wait, or 0 when an attempt is allowed now. */
  retryAfterMs(username: string, now: number = Date.now()): number {
    const record = this.attempts.get(username);
    if (record === undefined) return 0;
    if (record.until <= now) {
      this.attempts.delete(username);
      return 0;
    }
    return record.failures >= this.maxAttempts ? record.until - now : 0;
  }

  /** Record a wrong password. */
  fail(username: string, now: number = Date.now()): void {
    const record = this.attempts.get(username);
    // A record whose window has already run out starts again from one, rather
    // than resuming a count from an hour ago.
    const failures = record === undefined || record.until <= now ? 1 : record.failures + 1;
    this.attempts.set(username, { failures, until: now + this.lockoutMs });
  }

  /** Record a right password. */
  succeed(username: string): void {
    this.attempts.delete(username);
  }
}
