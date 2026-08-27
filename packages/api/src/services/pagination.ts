/**
 * Keyset pagination cursors. Every list that paginates orders by one
 * timestamp column plus `id` as the tiebreaker, and the cursor carries that
 * pair.
 *
 * The timestamp is named after the COLUMN it orders by -- `createdAt` for
 * the created_at orderings, `lastMessageAt` for mail_threads' (last_message_at,
 * id) keyset -- rather than one generic key every ordering reuses. A cursor
 * minted by one list therefore fails to decode against another instead of
 * being silently accepted and paging from a timestamp that means something
 * else entirely.
 */
export interface Cursor { createdAt: string; id: string; }
/** mail_threads' (last_message_at, id) keyset -- see services/mail-threads.ts. */
export interface LastMessageAtCursor { lastMessageAt: string; id: string; }
/**
 * meetings' (occurred_at, id) keyset -- see services/meetings.ts.
 *
 * A third type rather than a reuse of `Cursor`, under the naming rule above,
 * because occurred_at and created_at genuinely mean different moments on the
 * same row: a meetings list is about when the meeting HAPPENED, and
 * occurred_at is free in both directions (a meeting logged today about last
 * month, one logged yesterday about next week). A created_at cursor decoding
 * here would page from a timestamp with no relation to this ordering and
 * silently skip or repeat rows; a distinct key makes that a 400 at the route
 * (helpers.ts's validateCursor) instead.
 */
export interface OccurredAtCursor { occurredAt: string; id: string; }

export function encodeCursor(c: Cursor | LastMessageAtCursor | OccurredAtCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Shared decode: JSON in, or null for anything that is not this exact
 * {<key>: string, id: string} shape. Buffer.from never throws on a malformed
 * base64url string (it just drops what it cannot decode), so JSON.parse is
 * what actually rejects garbage. */
function decodeKeyed<K extends string>(raw: string, key: K): ({ id: string } & Record<K, string>) | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof v[key] === "string" && typeof v.id === "string"
      ? (v as { id: string } & Record<K, string>) : null;
  } catch { return null; }
}

// Returning null on a garbage cursor is deliberate, not permissive: these functions
// do not decide what a bad cursor means. CONTRACT for callers (the route layer):
// "cursor supplied but decode failed" must become a 400, not be swallowed into
// silently serving page one as if no cursor were given -- see routes/helpers.ts's
// validateCursor, which each list route calls with the decoder its own ordering uses.
export function decodeCursor(raw: string): Cursor | null {
  return decodeKeyed(raw, "createdAt");
}
export function decodeLastMessageAtCursor(raw: string): LastMessageAtCursor | null {
  return decodeKeyed(raw, "lastMessageAt");
}
export function decodeOccurredAtCursor(raw: string): OccurredAtCursor | null {
  return decodeKeyed(raw, "occurredAt");
}

/** Escape %, _ and \ so user input cannot act as ILIKE wildcards. */
export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }
