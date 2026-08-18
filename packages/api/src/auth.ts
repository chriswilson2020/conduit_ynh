import type { IncomingHttpHeaders } from "node:http";
import type { Identity } from "./users.js";

// Reject characters that have no legitimate place in an identity string. Written
// entirely as \u escapes (never literal characters) so this source file cannot
// silently carry a mangled or re-encoded invisible character:
//   \p{Cc}                     all control characters -- C0, C1 (including NEL
//                              U+0085), and DEL
//   \u200B                     zero-width space; trim() does not strip it, so it
//                              would yield a key visually identical to another but
//                              distinct in the database
//   \u202A-\u202E               bidi embeddings/overrides (LRE, RLE, PDF, LRO, RLO)
//   \u2066-\u2069               bidi isolates (LRI, RLI, FSI, PDI)
//                              both ranges can visually reorder a rendered name --
//                              fullName is displayed in the UI
//
// Deliberately NOT rejecting the rest of \p{Cf}: ZWNJ (U+200C) and ZWJ (U+200D) are
// required for correct rendering of Persian, Hindi and other scripts, and in emoji
// sequences. Rejecting them would refuse legitimate names.
//
// Node's HTTP parser already refuses bare CR/LF, so this is defence in depth: the
// identity here becomes a database key and is rendered in the UI, and it should not
// depend on a guarantee made a layer below.
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u200B\u202A-\u202E\u2066-\u2069]/u;

/** Reject anything that is not a single non-empty header value free of forbidden characters. */
function single(value: IncomingHttpHeaders[string]): string | null {
  if (typeof value !== "string") return null;
  if (FORBIDDEN_CHARACTERS.test(value)) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build an Identity from YunoHost's SSOwat headers, injected by nginx's
 * proxy_params_with_auth include. SSOwat overwrites these before proxying, so a
 * client cannot supply them itself -- provided the app is only reachable via nginx,
 * which is why the server binds to loopback.
 *
 * The dev-user fallback only applies when the ynh-user header key is entirely
 * absent (no SSOwat in front of the app at all). If the key is present but fails
 * validation -- empty, whitespace-only, array-valued, or containing a forbidden
 * character -- that is a malformed identity header, not a missing one, and is
 * rejected outright rather than silently downgrading to the configured dev user.
 */
export function identityFromHeaders(
  headers: IncomingHttpHeaders,
  devUser: string | null,
): Identity | null {
  const rawUsername = headers["ynh-user"];

  if (rawUsername === undefined) {
    if (devUser === null) return null;
    return { username: devUser, email: null, fullName: devUser };
  }

  const username = single(rawUsername);
  if (username === null) return null;

  return {
    username,
    email: single(headers["ynh-user-email"]),
    fullName: single(headers["ynh-user-fullname"]),
  };
}
