import { randomBytes, timingSafeEqual } from "node:crypto";
import { Client, DN, InvalidCredentialsError } from "ldapts";
import type { ReauthScope } from "@conduit/shared";

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
 * the composition root's decision -- buildApp's, in app.ts, which is where the
 * two-branch choice below is actually made -- not this module's and not a
 * route's. Production wires createLdapVerifier; a test wires a function.
 *
 * WHAT IT USED TO WIRE, AND WHY THAT IS WORTH A LINE HERE. Until v1.4.1 this
 * asked YunoHost's portal API over loopback, and the portal answered a SECOND
 * question nobody asked it -- whether the account was allowed on the domain in
 * the request's Host header, which over loopback is 127.0.0.1:6788 and is
 * allowed to nobody. Every correct password came back refused. See
 * createLdapVerifier for the whole of it; the shape of this module did not
 * change, and that the seam absorbed the swap is the evidence it was drawn in
 * the right place.
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
 * means the check could not be made (the directory is down, the connection was
 * refused, it answered something that is not an answer). The route treats those
 * differently on purpose: a 401 tells the operator to retype, and a 503 tells
 * them the thing that checks passwords is not answering, which is not a fact
 * about their typing.
 */
export type ReauthVerifier = (username: string, password: string) => Promise<boolean>;

/**
 * How long the whole check is given, connect to unbind.
 *
 * A BUDGET FOR THE OPERATION, NOT FOR ONE ROUND TRIP, and that is why it is
 * spent by a deadline around the whole thing rather than only by ldapts's own
 * per-message timeout. A connect, a bind and a whoami all have to finish before
 * there is anything to say, so three separate five-second limits would be a
 * fifteen-second wait wearing a five-second label. The per-message option is
 * set to the same number as a backstop, because it is what makes ldapts destroy
 * its own socket rather than leave one for the `finally` to find.
 *
 * FIVE RATHER THAN THE PORTAL'S TEN, and the ten is worth explaining before it
 * is discarded: it was sized against the 30s nginx allows its own portal
 * location, for a request that went through HTTP. That hop is gone. What is
 * left is a socket on the same machine -- measured on the deploy target on
 * 2 Sep, fourteen runs of ldapwhoami, each a whole connect, bind, whoami and
 * unbind with process startup on top, took 4.7-12.4ms. Five seconds is four
 * hundred times the slowest of those: a bound on a directory that has stopped
 * answering, not a limit anything healthy can reach.
 */
export const LDAP_TIMEOUT_MS = 5_000;

/**
 * RFC 4532's "Who am I?" extended operation.
 *
 * The same question YunoHost's own authenticator asks one line after its bind
 * (ldap_ynhuser.py: `who = con.whoami_s()[3:]`), and for the same reason.
 */
const WHOAMI_OID = "1.3.6.1.4.1.4203.1.11.3";

/**
 * The DN an account binds as.
 *
 * `uid={username},ou=users,dc=yunohost,dc=org` is YunoHost's own USERDN
 * constant, read at ldap_ynhuser.py:62 on the deploy target at 12.1.40.1 --
 * not inferred -- and `ou=users,dc=yunohost,dc=org` answered an anonymous base
 * search there on 2 Sep.
 *
 * BUILT WITH ldapts's DN RATHER THAN INTERPOLATED, and that is the whole
 * function. The username arrives in the Ynh-User header, which any local
 * process on this box can set to anything at all (see ReauthThrottle below,
 * which is bounded for the same reason), so it is attacker-shaped input going
 * into a structured string. `RDN.toString` escapes what a DN needs escaped --
 * `, + " \ < > ; =` and a leading `#`, and it quotes a value with a leading or
 * trailing space -- so a username of `admin,ou=x` becomes ONE RDN whose value
 * contains a comma, not two RDNs naming somewhere else in the tree.
 *
 * YUNOHOST ESCAPES THIS VALUE WITH `escape_filter_chars` (ldap_ynhuser.py:209),
 * WHICH IS THE WRONG ESCAPER. That one is for a search filter: it escapes
 * `* ( ) \ NUL` and leaves a comma completely alone. Do not copy it because it
 * is what upstream does.
 */
function userDn(username: string): DN {
  return new DN({ uid: username, ou: "users", dc: ["yunohost", "org"] });
}

/**
 * Check a password by binding to YunoHost's directory as that account.
 *
 * IT ASKS THE SMALLEST QUESTION THAT ANSWERS THE ONE WE HAVE. Conduit does not
 * store a password, cannot store one, and must not start; an LDAP simple bind
 * is "is this the password of this account" and returns nothing else. It is the
 * same operation the SSO portal runs internally, minus the session, minus the
 * domain ACL, minus the HTTP.
 *
 * IT REPLACED A CALL TO THE PORTAL API AND THAT IS WHY THIS RELEASE EXISTS.
 * `POST /login` on the portal (127.0.0.1:6788) bound successfully and THEN
 * asked `user_is_allowed_on_domain(username, request.get_header("host"))`
 * (ldap_ynhuser.py:251). Over loopback that header is `127.0.0.1:6788`, the
 * function walks up looking for a parent domain, runs out of dots and answers
 * False -- so every correct password came back 401, indistinguishable from a
 * wrong one because moulinette answers both with the same status. Conduit was
 * using a session-minting endpoint as a password oracle and paying for it with
 * an ACL that was never its question. The bind has no such second question, and
 * the ACL is redundant here anyway: SSOwat applied it before the request
 * reached this app.
 *
 * NOTHING UPSTREAM IS COUNTING THE FAILURES. YunoHost's fail2ban jails read
 * nginx's logs and this never reaches nginx -- and its own authenticator
 * carries "FIXME FIXME FIXME : this should be properly logged and caught by
 * Fail2ban" on precisely this path, so a failed login is uncounted through the
 * portal too. ReauthThrottle below is this app's own answer to that and it is
 * not optional.
 *
 * THE USERNAME IS NEVER THE CLIENT'S ON THE WAY IN: the route passes the
 * identity SSOwat established, never anything from the body. On a box where a
 * local process can set Ynh-User itself, that identity is only as good as the
 * perimeter -- which is why the DN is escaped rather than interpolated, and why
 * the throttle is keyed on it.
 */
export function createLdapVerifier(
  ldapUrl: string,
  timeoutMs: number = LDAP_TIMEOUT_MS,
): ReauthVerifier {
  return async (username, password) => {
    // AN EMPTY PASSWORD IS NOT A FAILED BIND, IT IS A DIFFERENT OPERATION, and
    // this line is the only thing standing between the two.
    //
    // A simple bind that names a DN and sends nothing is RFC 4513 s5.1.2's
    // unauthenticated authentication mechanism. What a directory does with it
    // is a matter of ITS configuration: OpenLDAP refuses unless `allow
    // bind_anon_dn` is set -- measured on the deploy target, slapd 2.5.13,
    // which answers 53 "unauthenticated bind (DN with no password) disallowed"
    // -- and succeeds AS ANONYMOUS the moment somebody sets it. Neither answer
    // is one this code can rely on, because that line lives in a file Conduit
    // does not own: on the first box an empty password would be a 503 with the
    // throttle attempt handed back, and on the second it would be a bind that
    // threw no exception at all.
    //
    // NOT LEFT TO reauthRequestSchema's .min(1). Depending on a caller having
    // validated its input is the exact arrangement that let the portal bug
    // exist, and this function is exported.
    if (password.length === 0) return false;

    const dn = userDn(username);
    // connectTimeout as well as timeout: unbind() below returns early on a
    // socket that never finished connecting, so without it a black-holed
    // address would leave one open behind the deadline.
    const client = new Client({ url: ldapUrl, timeout: timeoutMs, connectTimeout: timeoutMs });
    try {
      return await withinBudget(checkBind(client, dn, password), timeoutMs);
    } finally {
      // ON EVERY EXIT PATH, the throwing ones included -- and swallowing what
      // it throws is deliberate rather than lazy: the answer is already
      // decided by the time this runs, an unbind that failed has nothing to
      // add to it, and ldapts destroys the socket in its own finally either
      // way. Letting this throw would replace a "wrong password" with a 503.
      try {
        await client.unbind();
      } catch { /* see above */ }
    }
  };
}

/**
 * Bind, then confirm the directory agrees about who bound.
 *
 * THE SECOND QUESTION IS NOT CEREMONY. YunoHost asks it too, and it is the line
 * of defence behind the empty-password guard: a bind that succeeded as
 * ANYBODY ELSE -- as anonymous, or through a proxy that rewrote the identity --
 * has proved nothing about this account, and "no exception was thrown" is not
 * the same fact as "this password is that account's".
 */
async function checkBind(client: Client, dn: DN, password: string): Promise<boolean> {
  try {
    await client.bind(dn, password);
  } catch (error) {
    // 49, and ONLY 49, is "checked, and wrong" -- see ReauthVerifier. A
    // directory that is shutting down (51), read-only, or unwilling (53) has
    // told us nothing about this password, and answering false would send the
    // operator away to retype one that was right. That was this bug.
    //
    // An account that does not exist answers 49 as well, measured against the
    // deploy target on 2 Sep with uid=conduit-probe-no-such-user. That is what
    // keeps this from being a user enumerator, and it is the directory's
    // property rather than this code's.
    if (error instanceof InvalidCredentialsError) return false;
    throw error;
  }

  const { value } = await client.exop(WHOAMI_OID);
  // RFC 4532 answers an anonymous session with an ABSENT value, so undefined is
  // "nobody" rather than a parse failure.
  if (value === undefined || !value.startsWith("dn:")) return false;
  // Case-insensitively, because slapd answers with its own normalised spelling
  // of the DN and `uid` is caseIgnoreMatch in RFC 4519: UID=Chris and uid=chris
  // are the same entry, and refusing the correct password over an attribute
  // type's capitalisation would be this release's own bug repeated.
  //
  // toLowerCase, NOT toLocaleLowerCase, and this release knows why (Task 5b):
  // case folding is not the same operation in every language. It is safe here
  // for a reason narrower than that, and the reason is worth stating rather
  // than rediscovering -- a username that folds differently in the directory
  // than in JavaScript cannot reach this line at all, because YunoHost names
  // match ^[a-z0-9_.]+$ and anything else fails the bind above with 49 before
  // there is a whoami to compare.
  return value.slice("dn:".length).toLowerCase() === dn.toString().toLowerCase();
}

/**
 * `work`, or a throw once `ms` have passed.
 *
 * A LOSING PROMISE HERE IS NOT AN UNHANDLED REJECTION: Promise.race subscribes
 * to both, so the bind that the caller's `finally` is about to cut the socket
 * out from under has its rejection observed and dropped.
 */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => { reject(new Error(`the directory did not answer within ${String(ms)}ms`)); },
      ms,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A verifier that compares against one configured password.
 *
 * FOR DEVELOPMENT AND CI ONLY, and config.ts refuses to boot with it set under
 * NODE_ENV=production -- the same guard, in the same place, that CONDUIT_DEV_USER
 * has carried since Phase 0. It exists because neither a developer's machine
 * nor a GitHub runner has a YunoHost directory to bind against, and a gate that
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
 * How many tickets one ACCOUNT may have outstanding.
 *
 * THE BOUND THAT DOES THE WORK, and it is per-account since v1.4.1 for a
 * reason that showed up on the recovery path. The global ceiling below used to
 * be the only one, and it evicted the oldest ticket in the map whoever owned
 * it -- so a second account minting in a loop could take the operator's fresh
 * ticket out from under them while they read a destruction list, and what they
 * would see for it is a 401 asking them to type their password again, at the
 * worst possible moment, with nothing anywhere saying why.
 *
 * EIGHT IS GENEROUS ON PURPOSE. The page mints one and spends it on the very
 * next call, so the steady state is one; eight leaves room for a prompt
 * abandoned and reopened several times over five minutes without any operator
 * ever meeting this line. It is a ceiling for a loop, not a budget for a
 * session.
 */
const MAX_TICKETS_PER_ACCOUNT = 8;

/**
 * How many tickets may be outstanding in total.
 *
 * A MEMORY BOUND, NOT A POLICY -- the policy is the per-account cap above.
 * Tickets expire on their own and the sweep below removes them lazily, but
 * "lazily" is doing work only when something calls in. This is what stops the
 * map growing without limit in a process with 3.8GB and no swap.
 *
 * WHAT IT COSTS TO REACH IT IS PASSWORDS. Nothing mints without a successful
 * credential check, so filling this needs eight accounts whose passwords the
 * caller knows, not a loop -- which is why the cap above is the one that
 * actually meets a flood, and why this one can afford to evict carefully
 * rather than quickly.
 */
const MAX_OUTSTANDING_TICKETS = 64;

interface TicketRecord { username: string; scope: ReauthScope; expiresAt: number }

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
 * AND BOUND TO ONE OPERATION SINCE v1.4.1, WHICH IS THE MOST SERIOUS THING
 * THAT RELEASE FIXED. Until then `redeem` compared an account and nothing
 * else, so every gated route spent every other gate's tickets: one minted to
 * download a backup was a live authorisation to DESTROY THE DATABASE for five
 * minutes. Minting still needed the password, so the exposure was a ticket
 * stolen from a page rather than an escalation any caller could arrange -- and
 * the fix was a scope on `issue` and `redeem` and four call sites, which is
 * small enough that shipping without it would have been a choice rather than
 * an oversight. The scope names an OPERATION rather than a route, so the
 * restore's two halves are two scopes: a preview's proof does not open the
 * apply.
 *
 * IN MEMORY, PER PROCESS, and that is the whole deployment: one systemd unit,
 * one node process (conf/systemd.service). A restart invalidates every
 * outstanding ticket, which is the correct behaviour rather than a limitation.
 *
 * A PASSWORD CHANGE DOES NOT REVOKE AN OUTSTANDING TICKET, and v1.4.1 looked
 * at that and left it. The reasoning is worth carrying, because the obvious
 * summary of it was wrong.
 *
 * There is no event HERE to revoke on: Conduit has no password to change, the
 * credential lives in YunoHost's directory, and this app only ever asks it a
 * question. The only signal available is the directory's own `pwdChangedTime`,
 * which would put an LDAP query inside `redeem` -- an async, fallible round
 * trip on the critical path of every gated operation, whose failure mode is
 * refusing a RESTORE because the directory is unwell. That trade is the wrong
 * way round on the recovery path.
 *
 * WHAT IT WOULD BUY WAS THEN MEASURED RATHER THAN ASSUMED, and the comfortable
 * answer -- that the session cookie outlives a password change anyway, so the
 * ticket is not the weak link -- IS FALSE. YunoHost invalidates
 * a user's portal sessions the moment `userPassword` changes, on both paths:
 * `yunohost/user.py:608` for an admin's `user update`, and
 * `yunohost/portal.py:331` for the operator changing their own, each calling
 * `invalidate_all_sessions_for_user`, which unlinks the session files under
 * /var/cache/yunohost-portal/sessions. Read on the deploy target at yunohost
 * 12.1.40.1 with yunohost-portal 12.1.2.
 *
 * SO THE TICKET OUTLIVES THE PASSWORD BUT NOT THE PERIMETER. Every gated route
 * runs requireUser first, and that identity is the one SSOwat establishes from
 * a session that no longer exists -- so over the network a ticket minted with
 * the old password cannot even be presented. What is left is a local process
 * that sets Ynh-User for itself, which is the same worst case this module
 * already names twice, holding a five-minute proof it could not mint again.
 * That is the residue, it is small, and it is written down rather than closed
 * by making the recovery path depend on a directory being up.
 */
export class ReauthTickets {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(private readonly ttlMs: number = REAUTH_TICKET_TTL_MS) {}

  /**
   * A ticket for `username` to do `scope`, valid once.
   *
   * 32 bytes of CSPRNG output, hex. Not a JWT and not derived from anything:
   * there is nothing to encode, and a value with structure invites somebody to
   * read it. The scope is remembered HERE rather than carried in the token for
   * the same reason the username is -- a client that could read a scope out of
   * a ticket is a client somebody would eventually let choose one.
   *
   * THE SCOPE IS A REQUIRED ARGUMENT AND WILL NOT BE GIVEN A DEFAULT. Whatever
   * value a default took, one of the four gates would open for a caller who
   * never asked for it, which is the fungible ticket back under a friendlier
   * name.
   */
  issue(username: string, scope: ReauthScope, now: number = Date.now()): string {
    this.sweep(now);
    this.makeRoom(username);
    const token = randomBytes(32).toString("hex");
    this.tickets.set(token, { username, scope, expiresAt: now + this.ttlMs });
    return token;
  }

  /**
   * Spend a ticket. True only if it exists, has not expired, belongs to
   * `username`, and was minted for `scope`.
   *
   * THE DELETE HAPPENS ON EVERY PATH THAT FOUND A RECORD, including all three
   * refusals. A ticket presented for the wrong account or at the wrong gate is
   * a ticket that has been somewhere it should not have been, and leaving it
   * live so the right one could still take it would be the wrong instinct: it
   * would let a stolen ticket be tried at every gate for the price of one.
   */
  redeem(
    token: string, username: string, scope: ReauthScope, now: number = Date.now(),
  ): boolean {
    const record = this.tickets.get(token);
    if (record === undefined) return false;
    this.tickets.delete(token);
    if (record.expiresAt <= now) return false;
    return record.username === username && record.scope === scope;
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

  /**
   * Make space for one more ticket for `username`, taking it from the account
   * that can best afford it.
   *
   * TWO BOUNDS, AND THEY EVICT DIFFERENT THINGS ON PURPOSE.
   *
   * The per-account cap takes the minter's OWN oldest, which a Map gives for
   * free in insertion order. Taking the newest instead would let a flood lock
   * out the person actually waiting on one, which was the reason the original
   * bound dropped the oldest and is unchanged.
   *
   * The global ceiling takes from whoever is holding the MOST, and that is the
   * v1.4.1 fix rather than a flourish. Evicting by age alone -- which is what
   * this did -- means the ticket most likely to go is the one that has been
   * waiting longest for an operator to finish reading, and the account most
   * likely to survive is the one minting fastest. Holding the most is the only
   * thing here that distinguishes a flood from somebody using the page.
   *
   * WHAT IT DOES NOT PROMISE, said plainly because the tempting summary is
   * false: an account holding ONE ticket can still lose it once every other
   * holder also holds one -- 64 accounts, each of which has proved a password
   * inside the last five minutes. No eviction rule can do better than that
   * with a full map, and the answer at that point is a bigger ceiling rather
   * than a cleverer rule.
   */
  private makeRoom(username: string): void {
    while (this.countFor(username) >= MAX_TICKETS_PER_ACCOUNT) {
      if (!this.dropOldestOf(username)) return;
    }
    while (this.tickets.size >= MAX_OUTSTANDING_TICKETS) {
      const largest = this.largestHolder();
      if (largest === null || !this.dropOldestOf(largest)) return;
    }
  }

  private countFor(username: string): number {
    let held = 0;
    for (const record of this.tickets.values()) {
      if (record.username === username) held += 1;
    }
    return held;
  }

  /** The account holding the most; ties go to whoever has held one longest. */
  private largestHolder(): string | null {
    const held = new Map<string, number>();
    for (const record of this.tickets.values()) {
      held.set(record.username, (held.get(record.username) ?? 0) + 1);
    }
    let chosen: string | null = null;
    let most = 0;
    // Insertion order, so the first account at the maximum is the one whose
    // oldest ticket is oldest -- a deterministic tie-break rather than
    // whichever the iterator happened to reach.
    for (const [name, count] of held) {
      if (count > most) { most = count; chosen = name; }
    }
    return chosen;
  }

  private dropOldestOf(username: string): boolean {
    for (const [token, record] of this.tickets) {
      if (record.username === username) {
        this.tickets.delete(token);
        return true;
      }
    }
    return false;
  }
}

/** Wrong attempts allowed inside one window before an account is locked out. */
export const REAUTH_MAX_ATTEMPTS = 5;

/** How long the window is, and how long a lockout lasts once it trips. */
export const REAUTH_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * How many accounts may be tracked at once.
 *
 * A BOUND FOR THE SAME REASON ReauthTickets HAS ONE, and it took a review to
 * notice that this map did not: a record is keyed on a username, and the
 * username comes from the Ynh-User header, which ANY LOCAL PROCESS ON THE BOX
 * can set freely -- the app binds loopback and nginx forwards $http_ynh_user,
 * so with no proxy in front the header is whatever the caller says. A local
 * attacker varying it could grow this map without limit on a 3.8GB machine
 * with no swap.
 *
 * Records expire on their own, and every write sweeps the expired ones first,
 * so the steady state is bounded by how many distinct accounts fail inside one
 * window. This is the ceiling for the case where that is a great many.
 */
const MAX_TRACKED_ACCOUNTS = 4096;

interface AttemptRecord { failures: number; until: number }

/**
 * PER-ACCOUNT THROTTLING OF WRONG PASSWORDS, AND IT IS LOAD-BEARING RATHER
 * THAN BELT-AND-BRACES.
 *
 * The measurement that makes it so: YunoHost's fail2ban jails read nginx's
 * logs, and this app binds the directory on loopback, so nothing there counts a
 * failure. Nor is that an artefact of skipping the portal -- YunoHost's own
 * ldap_ynhuser authenticator carries a FIXME on the INVALID_CREDENTIALS path
 * itself saying failed logins are not caught by fail2ban, so there was no
 * upstream throttle to inherit through the portal's public path either.
 *
 * Without this, /api/reauth would be an unmetered oracle for guessing the
 * account password of a YunoHost server, reachable by anyone holding a session
 * -- and, because Ynh-User is settable by any local process, an oracle for
 * EVERY account on the box rather than only the caller's own.
 *
 * KEYED ON THE USERNAME, not the IP. The username is the thing being attacked
 * and the thing the app actually knows; req.ip behind nginx is one hop's
 * X-Forwarded-For and an attacker with a session can vary it.
 *
 * CHECK AND COUNT ARE ONE SYNCHRONOUS STEP -- see `reserve`, and read its
 * comment before changing anything here. That is the whole difference between
 * a bound and a suggestion.
 */
export class ReauthThrottle {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(
    private readonly maxAttempts: number = REAUTH_MAX_ATTEMPTS,
    private readonly lockoutMs: number = REAUTH_LOCKOUT_MS,
  ) {}

  /**
   * TAKE ONE ATTEMPT, COUNTING IT. Returns 0 when the caller may proceed, or
   * the milliseconds still to wait -- in which case nothing was counted.
   *
   * THIS EXISTS BECAUSE READ-THEN-AWAIT-THEN-WRITE IS NOT A BOUND, and the
   * first version of this route was exactly that: it asked `retryAfterMs`,
   * awaited the password check, and only then called `fail`. Every request
   * that arrived inside that await saw a counter that had not moved. Measured
   * against the real server with requests written in one synchronous pass: at a
   * 3ms check 6 got through, at 25ms 63 did, and at 100ms ALL TWO HUNDRED did
   * with not a single 429. The leak is a linear function of how long one check
   * takes -- and the check is an LDAP bind against a directory an attacker can
   * load from outside, so the window is not even fixed.
   *
   * Node runs one turn of the event loop at a time, so a method that reads and
   * writes without awaiting cannot be interleaved. That is the entire fix, and
   * it is why the count happens HERE rather than after the answer comes back.
   *
   * The cost is that a CORRECT password is counted too, for as long as the
   * check takes. `succeed` clears it, so the only visible effect is that five
   * simultaneous correct logins from one account would see the sixth wait --
   * which is the bound working.
   */
  reserve(username: string, now: number = Date.now()): number {
    const waiting = this.retryAfterMs(username, now);
    if (waiting > 0) return waiting;
    this.count(username, now);
    return 0;
  }

  /**
   * Give back an attempt that tested nothing.
   *
   * For the one path where the password was never checked at all: the
   * directory could not be reached, or refused to answer the question. A caller
   * who gets a 503 has learned nothing about their password and must not be
   * pushed towards a lockout by an outage -- routes/reauth.ts answers those
   * differently for the same reason.
   */
  release(username: string, now: number = Date.now()): void {
    const record = this.attempts.get(username);
    if (record === undefined) return;
    if (record.failures <= 1) {
      this.attempts.delete(username);
      return;
    }
    this.attempts.set(username, { failures: record.failures - 1, until: record.until });
  }

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

  /** Record a right password. */
  succeed(username: string): void {
    this.attempts.delete(username);
  }

  /** Accounts currently tracked. Exposed so a test can see the bound hold. */
  size(): number {
    return this.attempts.size;
  }

  /** One more attempt against `username`, sweeping and bounding as it goes. */
  private count(username: string, now: number): void {
    const record = this.attempts.get(username);
    // A record whose window has already run out starts again from one, rather
    // than resuming a count from an hour ago.
    const failures = record === undefined || record.until <= now ? 1 : record.failures + 1;
    if (record === undefined) this.makeRoom(now);
    this.attempts.set(username, { failures, until: now + this.lockoutMs });
  }

  /**
   * Keep the map under its ceiling before adding a new account to it.
   *
   * Expired records go first, which in ordinary use is the whole of it. If
   * that is not enough, the record that would have been forgotten SOONEST goes
   * -- not the oldest by insertion, because updating a key does not move it in
   * a Map, so insertion order says nothing about which lockout expires first.
   */
  private makeRoom(now: number): void {
    if (this.attempts.size < MAX_TRACKED_ACCOUNTS) return;
    for (const [key, record] of this.attempts) {
      if (record.until <= now) this.attempts.delete(key);
    }
    while (this.attempts.size >= MAX_TRACKED_ACCOUNTS) {
      let soonestKey: string | null = null;
      let soonest = Infinity;
      for (const [key, record] of this.attempts) {
        if (record.until < soonest) { soonest = record.until; soonestKey = key; }
      }
      if (soonestKey === null) return;
      this.attempts.delete(soonestKey);
    }
  }
}
