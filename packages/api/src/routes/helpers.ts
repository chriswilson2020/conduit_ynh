import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User } from "@conduit/shared";
import { NotFoundError, ArchivedError } from "../services/errors.js";
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
 * Maps the two domain error types every service can throw into their HTTP shape.
 * Anything else is re-thrown so it reaches app.ts's setErrorHandler, which is the
 * single place that decides what a 5xx body looks like (and never echoes the
 * underlying error text) -- this function must not swallow or reshape those.
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
