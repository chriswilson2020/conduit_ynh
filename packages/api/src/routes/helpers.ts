import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User } from "@conduit/shared";
import {
  NotFoundError, ArchivedError, ConflictError, MailKeyMissingError, MailCredentialDecryptError,
} from "../services/errors.js";
import { decodeCursor } from "../services/pagination.js";

/**
 * Shared :id route-param shape. Validating it here (rather than trusting whatever
 * string routing hands us) turns a malformed id into the uniform 400 validation
 * response instead of a raw "invalid input syntax for type uuid" driver error
 * bubbling out of Postgres as an unhandled 500.
 */
export const idParamSchema = z.object({ id: z.uuid() });

/**
 * Every CRM route requires an authenticated user. The onRequest hook in app.ts
 * already resolved request.user (or left it null) before any route handler runs;
 * this only checks the result and sends the same 401 shape /api/me uses. Returns
 * the resolved user (so callers get actorId for free) or null after already
 * having written the 401 response -- callers must `return` immediately on null.
 */
export function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  if (request.user === null) {
    void reply.code(401).send({
      error: "unauthenticated",
      message: "No Ynh-User header was present on this request",
    });
    return null;
  }
  return request.user;
}

/**
 * Maps the five domain error types every service can throw into their HTTP shape.
 * Anything else is re-thrown so it reaches app.ts's setErrorHandler, which is the
 * single place that decides what a 5xx body looks like (and never echoes the
 * underlying error text) -- this function must not swallow or reshape those.
 *
 * ArchivedError and ConflictError both map to HTTP 409, but with distinct
 * bodies -- `{ error: "archived" }` vs `{ error: "conflict" }` -- that the
 * client branches on by `code`, not just status. Archived means the row's
 * lifecycle flag blocks the mutation outright (no retry will help without an
 * unarchive first); conflict means the caller's view of some OTHER row's
 * current state (a stage/pipeline neighbour, a deal's status) went stale --
 * the client should refetch and can retry the same action once it has.
 */
export function mapDomainError(reply: FastifyReply, error: unknown): void {
  if (error instanceof NotFoundError) {
    void reply.code(404).send({ error: "not_found", message: error.message });
    return;
  }
  if (error instanceof ArchivedError) {
    void reply.code(409).send({ error: "archived", message: error.message });
    return;
  }
  if (error instanceof ConflictError) {
    void reply.code(409).send({ error: "conflict", message: error.message });
    return;
  }
  // Both raised by mail-crypto (services/errors.ts). Static message text in
  // both branches, deliberately NOT error.message: MailKeyMissingError's
  // message embeds the server's filesystem path (mail.key's location),
  // which must never reach an authenticated client -- app.ts's own 5xx
  // handler already holds this line for every other unhandled error, and
  // there is no reason a domain-mapped error should be laxer about it. The
  // real message (with the path) stays on the Error object for server-side
  // logs. Route-level exercise of these two branches lands with
  // routes/mail.ts in Task 7; this only wires the mapping so that task's
  // routes get it for free.
  //
  // MailKeyMissingError stays 503: mail.key is either present or absent
  // server-wide, not a property of any one account, so this is a genuine
  // "mail is temporarily unavailable, an admin needs to look at this"
  // condition -- retrying later (once an operator runs the install/upgrade
  // step that generates the key) is the correct client behaviour, which is
  // exactly what 503 signals.
  if (error instanceof MailKeyMissingError) {
    void reply.code(503).send({ error: "mail_key_missing", message: "mail key unavailable" });
    return;
  }
  // MailCredentialDecryptError maps to 409, NOT 503: 503 implies "retry
  // later and it'll work", but a row whose stored ciphertext no longer
  // decrypts under the current mail.key (rotated/restored key, or a
  // genuinely corrupted row) will never start decrypting again on its own --
  // recovery requires the caller to submit a fresh password (updateAccount's
  // password-present branch never reads the broken ciphertext at all, so it
  // always succeeds regardless). 409 with an actionable message steers the
  // client toward that fix instead of a bare retry.
  if (error instanceof MailCredentialDecryptError) {
    void reply.code(409).send({
      error: "mail_credentials_unreadable",
      message: "stored mail credentials could not be decrypted; submit a new password to re-establish them",
    });
    return;
  }
  throw error;
}

/**
 * Parse `data` against `schema`; on failure, send the uniform 400 validation
 * shape (first Zod issue's message) and return undefined. Callers must check for
 * undefined and return immediately -- the reply has already been sent.
 */
export function parseOrReject<T>(schema: z.ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message ?? "invalid input";
  void reply.code(400).send({ error: "validation", message });
  return undefined;
}

/**
 * Pre-validate a `cursor` query param per pagination.ts's documented contract: a
 * cursor that fails to decode must become a 400, not be silently treated as page
 * one (which is what the service layer does on its own -- it has no way to tell
 * "no cursor" from "garbage cursor" apart, so this check has to live here).
 * Returns true when there is nothing to reject (cursor absent or valid).
 */
export function validateCursor(cursor: string | undefined, reply: FastifyReply): boolean {
  if (cursor === undefined) return true;
  if (decodeCursor(cursor) !== null) return true;
  void reply.code(400).send({ error: "validation", message: "invalid cursor" });
  return false;
}
