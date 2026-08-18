export interface Cursor { createdAt: string; id: string; }
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
// Returning null on a garbage cursor is deliberate, not permissive: this function
// does not decide what a bad cursor means. CONTRACT for callers (the route layer,
// not yet implemented): "cursor supplied but decode failed" must become a 400, not
// be swallowed into silently serving page one as if no cursor were given.
export function decodeCursor(raw: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof v.createdAt === "string" && typeof v.id === "string" ? v : null;
  } catch { return null; }
}
/** Escape %, _ and \ so user input cannot act as ILIKE wildcards. */
export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }
