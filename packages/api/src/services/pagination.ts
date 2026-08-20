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

export function encodeCursor(c: Cursor | LastMessageAtCursor): string {
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

/** Escape %, _ and \ so user input cannot act as ILIKE wildcards. */
export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }
