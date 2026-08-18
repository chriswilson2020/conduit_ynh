import type { IncomingHttpHeaders } from "node:http";
import type { Identity } from "./users.js";

// Reject C0 (\x00-\x1f) and DEL (\x7f) control characters anywhere in the value,
// not just at the ends. Node's HTTP parser already refuses bare CR/LF, so this is
// defence in depth: the identity here becomes a database key and is rendered in the
// UI, and it should not depend on a guarantee made a layer below.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** Reject anything that is not a single non-empty header value free of control characters. */
function single(value: IncomingHttpHeaders[string]): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build an Identity from YunoHost's SSOwat headers, injected by nginx's
 * proxy_params_with_auth include. SSOwat overwrites these before proxying, so a
 * client cannot supply them itself — provided the app is only reachable via nginx,
 * which is why the server binds to loopback.
 *
 * The dev-user fallback only applies when the ynh-user header key is entirely
 * absent (no SSOwat in front of the app at all). If the key is present but fails
 * validation — empty, whitespace-only, array-valued, or containing a control
 * character — that is a malformed identity header, not a missing one, and is
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
