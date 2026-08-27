import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User } from "@conduit/shared";
import {
  NotFoundError, ArchivedError, ConflictError, DuplicateAttendeeError,
  MailKeyMissingError, MailCredentialDecryptError,
  AttachmentTooLargeError, SmtpSendError,
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
 * Maps the domain error types services can throw into their HTTP shape.
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
  // Before the ConflictError arm below, which it extends: a duplicate attendee
  // is a 409 like any other conflict, but with its own code, because the
  // client's remedy is a specific row of the attendee list rather than a
  // refetch (see the class's own comment). Ordering matters -- the generic arm
  // would otherwise swallow it.
  if (error instanceof DuplicateAttendeeError) {
    void reply.code(409).send({ error: "duplicate_attendee", message: error.message });
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
  // 413 `too_large`, the SAME status and code files.ts's upload route
  // answers for an over-cap compose upload -- one refusal shape for "that
  // attachment is too big" however the attachment reached the send. The
  // message is echoed: it names the file and the limit (both already visible
  // to the viewer -- see the error class's own note), which is exactly what
  // a composer dialog needs to say.
  if (error instanceof AttachmentTooLargeError) {
    void reply.code(413).send({ error: "too_large", message: error.message });
    return;
  }
  // 502, not 500: the request was well-formed and this server did its part --
  // the upstream SMTP server is the one that refused. `reason` is echoed
  // (unlike the two branches above) because it is the whole point: it is the
  // adapter's own normalized text, carrying `auth:` or `connection:` so the
  // composer can tell the user to check their password rather than their
  // host, and mail-imapflow.ts guarantees no credential is in it. Nothing was
  // stored, so the client still holds the draft and can retry it as-is. Like
  // the two mail-crypto branches above, the route that exercises this lands
  // in Task 7; the mapping is wired here so it gets it for free.
  if (error instanceof SmtpSendError) {
    // `reason` rides alongside `message` because that is what it was built
    // for: it is the adapter's normalized text, prefix and all, so the
    // composer can branch on `auth:` vs `connection:` without parsing an
    // English sentence out of `message`.
    void reply.code(502).send({ error: "smtp_failed", message: error.message, reason: error.reason });
    return;
  }
  throw error;
}

/**
 * Build a `Content-Disposition` header value for a stored filename, safely for
 * ANY filename -- including one no HTTP header can carry literally.
 *
 * Node rejects a header value containing a code point above U+00FF outright
 * (ERR_INVALID_CHAR, a 500 rather than a download), and mail filenames reach
 * us fully decoded: mailparser resolves RFC 2047 encoded-words, so a message
 * from anywhere outside Latin-1 routinely produces one. Uploaded filenames
 * have the same shape.
 *
 * So the value carries BOTH forms RFC 6266 defines:
 *
 * - `filename="..."` -- a pure-ASCII fallback for anything that does not
 *   understand the extended form. Non-ASCII code points become "_"; CR/LF
 *   (header injection) and quote/backslash (which would end the
 *   quoted-string early) are dropped; an empty result becomes "download",
 *   since a nameless disposition is worse than a generic one.
 * - `filename*=UTF-8''...` -- RFC 5987/8187 extended notation, percent-encoded
 *   UTF-8, which every current browser prefers over the fallback. encodeURIComponent
 *   leaves `'`, `(`, `)` and `*` unescaped and none of them is an RFC 8187
 *   attr-char, so they are escaped here afterwards.
 *
 * Shared shape with routes/files.ts's own download header, which still builds
 * its own (and has the same latent bug); this lives here so that route can
 * adopt it without a second implementation appearing.
 */
export function contentDisposition(type: "attachment" | "inline", filename: string): string {
  // One pass covers control characters (CR/LF included) and everything above
  // U+007F: the complement of printable ASCII.
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "").trim();
  const fallback = ascii === "" ? "download" : ascii;
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
 *
 * `decode` names the ordering the cursor must belong to, defaulting to the
 * created_at keyset every Phase 1-3 list uses. A route paginating by some
 * other column (mail threads, by last_message_at) passes that column's
 * decoder, so a cursor minted for a different ordering is rejected here
 * rather than paging from a timestamp that means something else.
 */
export function validateCursor(
  cursor: string | undefined,
  reply: FastifyReply,
  decode: (raw: string) => object | null = decodeCursor,
): boolean {
  if (cursor === undefined) return true;
  if (decode(cursor) !== null) return true;
  void reply.code(400).send({ error: "validation", message: "invalid cursor" });
  return false;
}
