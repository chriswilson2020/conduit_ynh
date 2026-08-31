import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, parseOrReject } from "./helpers.js";
import { REAUTH_TICKET_TTL_MS } from "../services/reauth.js";

/**
 * THE HEADER THE TWO DOWNLOADS CARRY THEIR PROOF IN.
 *
 * A HEADER RATHER THAN A QUERY PARAMETER, and that is Task 2's argument
 * inherited rather than re-decided: nginx writes a query string to its access
 * log verbatim and the browser keeps it in history, which is why the backup is
 * a POST at all. A single-use ticket is a weaker secret than a passphrase, but
 * it is still a credential for one download of the entire database, and there
 * is no reason to put it somewhere that logs it.
 *
 * A HEADER RATHER THAN A COOKIE, because a cookie would ride on every request
 * this app makes for as long as it lived, to routes that have nothing to do
 * with it, and would have to be scoped and expired by a second mechanism.
 *
 * The cost is that BOTH downloads must be issued with fetch() rather than by
 * pointing the browser at a link -- the export included, which was a plain GET
 * before this task. The backup already had to be (Task 2's POST), so the page
 * ends up with one download mechanism instead of two.
 */
export const REAUTH_HEADER = "x-conduit-reauth";

const reauthRequestSchema = z.object({
  password: z.string()
    .min(1, "a password is required")
    // A bound on what is JSON-parsed and handed to an LDAP bind, not a claim
    // about passwords. YunoHost's own portal does not accept anything near it.
    .max(1024, "that is not a password"),
});

/**
 * ONE REFUSAL FOR EVERY WRONG ANSWER.
 *
 * The message does not say whether the account exists, whether the password
 * was close, or how many attempts remain -- the last of those is the one that
 * feels helpful and is not: telling a guesser they have three tries left tells
 * them the throttle's shape. The operator at the keyboard knows their own
 * password and needs only to be told this one was not it.
 */
const REFUSED = {
  error: "reauth_failed",
  message: "that password was not accepted; the download was not started",
} as const;

/**
 * POST /api/reauth -- prove it is the operator at the keyboard.
 *
 * WHAT IT IS AND WHY IT IS NOT A CONFIRM DIALOG: see services/reauth.ts. In
 * short, 7.6 turns a session into a one-click copy of the whole CRM plus
 * mail.key, YunoHost has no second factor, and Chris asked for a real
 * credential check rather than an "are you sure".
 *
 * IT RETURNS A TICKET AND NEVER A COOKIE, and it never echoes the password
 * anywhere, including into a log line: the body is parsed into a local, handed
 * to the verifier and dropped. The only thing written about a failure is the
 * username and the fact of it.
 */
export function registerReauthRoutes(
  app: FastifyInstance,
  { reauthVerifier, reauthTickets, reauthThrottle }: CrmRouteDeps,
): void {
  app.post("/api/reauth", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;

    const body = parseOrReject(reauthRequestSchema, request.body, reply);
    if (body === undefined) return;

    // COUNTED HERE, BEFORE THE AWAIT, AND THAT ORDERING IS THE BOUND.
    //
    // The first version of this handler read the counter, awaited the password
    // check and only then recorded a failure -- so every request arriving
    // inside that await saw a counter that had not moved. Measured against the
    // real server with the requests written in one synchronous pass: at a 3ms
    // check 6 got through, at 25ms 63 did, and at 100ms all two hundred did
    // with not one 429. `reserve` reads and writes without awaiting, which on
    // a single-threaded event loop cannot be interleaved.
    //
    // A locked-out account is refused before the verifier for the reasons it
    // always was: it must not keep an LDAP bind busy, and must not learn
    // anything from how long the refusal took.
    const retryAfterMs = reauthThrottle.reserve(user.username);
    if (retryAfterMs > 0) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      // "attempts" rather than "wrong passwords": since the count is taken at
      // the check rather than after it, a refusal can also mean five checks are
      // in flight -- which is the bound working and is not a statement about
      // anybody's typing.
      void reply.header("Retry-After", String(seconds));
      return reply.code(429).send({
        error: "reauth_throttled",
        message: `too many attempts; try again in ${String(Math.ceil(seconds / 60))} minutes`,
        retryAfterSeconds: seconds,
      });
    }

    let ok: boolean;
    try {
      // THE USERNAME IS THE SESSION'S, NEVER THE BODY'S. There is no field for
      // it in the schema above and there must not be one: a caller who could
      // name the account would have an oracle for every account on the server.
      ok = await reauthVerifier(user.username, body.password);
    } catch (error) {
      // A THROW IS NOT A WRONG PASSWORD -- see ReauthVerifier's doc comment.
      // The portal being down is an operator's problem with a fix, and telling
      // the person at the keyboard to retype would be a lie. The attempt taken
      // above is given back, because nothing was tested: an outage must not
      // push somebody towards a lockout.
      reauthThrottle.release(user.username);
      request.log.error({ err: error }, "re-authentication could not be checked");
      return reply.code(503).send({
        error: "reauth_unavailable",
        message: "the password could not be checked right now, so the download was not started",
      });
    }

    if (!ok) {
      // Already counted by `reserve`. Logged because a burst of these is the
      // only warning an operator gets that somebody is working on the
      // password. The password itself never reaches a log line.
      request.log.warn({ username: user.username }, "re-authentication refused");
      return reply.code(401).send(REFUSED);
    }

    reauthThrottle.succeed(user.username);
    return {
      ticket: reauthTickets.issue(user.username),
      expiresInSeconds: Math.floor(REAUTH_TICKET_TTL_MS / 1000),
    };
  });
}

/**
 * THE GATE ON A DOWNLOAD. Returns true when the caller may proceed; otherwise
 * it has already written the 401 and the caller must return immediately -- the
 * same contract requireUser has, and deliberately the same shape so the two
 * read as one pair of lines at the top of a handler.
 *
 * WHAT MAKES THIS A GATE RATHER THAN A PROMPT: it is here, on the server, and
 * it consumes a ticket that only a verified password can mint. A page that
 * simply ASKED before calling the endpoint would stop nobody -- the endpoint
 * is one fetch away, and an attacker holding the session is not going to use
 * the page. Proving that is the point of the bypass tests: a request with no
 * ticket, an invented one, an expired one, a spent one, or one belonging to
 * another account all get 401 and no bytes.
 */
export function requireReauth(
  request: FastifyRequest,
  reply: FastifyReply,
  user: User,
  deps: Pick<CrmRouteDeps, "reauthTickets">,
): boolean {
  const header = request.headers[REAUTH_HEADER];
  // WHAT A REPEATED HEADER ACTUALLY DOES HERE, corrected after a review found
  // this comment claiming the wrong reason. Node joins repeated occurrences of
  // an ordinary header into ONE comma-separated STRING -- only set-cookie ever
  // becomes an array -- so `X-Conduit-Reauth: junk` alongside a real ticket
  // arrives as "junk, <ticket>" and is looked up whole. It misses the map and
  // is refused, in every ordering. Nothing is being rejected for being an
  // array; the lookup is what refuses it, and that is the only claim this code
  // can make.
  //
  // The narrowing stays because IncomingHttpHeaders is typed for every header
  // including set-cookie, so the array arm must be handled to compile. An
  // absent header becomes "", which redeem refuses like any other miss -- so
  // there is no separate empty-string check to get wrong.
  const ticket = typeof header === "string" ? header : "";
  if (!deps.reauthTickets.redeem(ticket, user.username)) {
    void reply.code(401).send({
      error: "reauth_required",
      message: "confirm your password before downloading; this download carries the whole database",
    });
    return false;
  }
  return true;
}
