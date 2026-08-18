import type { IncomingHttpHeaders } from "node:http";
import type { Identity } from "./users.js";

/** Reject anything that is not a single non-empty header value. */
function single(value: IncomingHttpHeaders[string]): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build an Identity from YunoHost's SSOwat headers, injected by nginx's
 * proxy_params_with_auth include. SSOwat overwrites these before proxying, so a
 * client cannot supply them itself — provided the app is only reachable via nginx,
 * which is why the server binds to loopback.
 */
export function identityFromHeaders(
  headers: IncomingHttpHeaders,
  devUser: string | null,
): Identity | null {
  const username = single(headers["ynh-user"]);

  if (username === null) {
    if (devUser === null) return null;
    return { username: devUser, email: null, fullName: devUser };
  }

  return {
    username,
    email: single(headers["ynh-user-email"]),
    fullName: single(headers["ynh-user-fullname"]),
  };
}
