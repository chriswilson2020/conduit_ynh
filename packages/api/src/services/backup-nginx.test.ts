import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_PROXY_READ_TIMEOUT_SECONDS } from "./backup.js";

/**
 * THE PROXY TIMEOUT IS PART OF THE FEATURE, SO IT IS ASSERTED LIKE ONE.
 *
 * The backup cannot stream: `7z` finishes the whole archive before the first
 * byte of the response exists, so the gap between the request and the response
 * IS the build, and nginx's proxy_read_timeout is exactly what measures that
 * gap. At the 300 seconds the app's own location carries, an install of about
 * 7.3GB would 504 after five minutes with nothing to show for it.
 *
 * Chris ruled on 31 Aug for BOTH halves: raise the timeout for that one route,
 * AND warn before a long backup starts. This file guards the first half. The
 * second is estimateBackup and pages/settings-data-lib.ts's preflightWarning.
 *
 * WHY A TEST AND NOT A COMMENT. Two things can go wrong here and neither shows
 * up anywhere else: the number in conf/nginx.conf can drift from the one the
 * pre-flight tells a browser it has (so the page would promise headroom the
 * deployment does not give), and the block can stop being scoped -- an hour
 * applied to every route would turn a wedged handler into an hour of held
 * connection instead of a 504 somebody notices.
 *
 * A GUARD THAT READS SOURCE IS SCOPED TO THE CONSTRUCT IT GUARDS, which is the
 * project's rule and the reason this parses out the two location blocks and
 * asks about each rather than grepping the file for a number.
 */

// The same spelling backup-format.test.ts uses to reach docs/, four levels up
// from packages/api/src/services to the repo root.
const CONF = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "conf", "nginx.conf",
);

/**
 * The body of one `location` block, by its header line.
 *
 * Brace-counted rather than matched with a regex: the file is small and these
 * blocks do not nest today, but a `location` that grew an `if` inside it would
 * silently truncate a lazy match and the guard would then be asserting about
 * half a block.
 */
function locationBody(conf: string, header: string): string {
  const start = conf.indexOf(header);
  if (start < 0) throw new Error(`no location block headed "${header}" in conf/nginx.conf`);
  let depth = 0;
  for (let i = conf.indexOf("{", start); i < conf.length; i += 1) {
    if (conf[i] === "{") depth += 1;
    if (conf[i] === "}") {
      depth -= 1;
      if (depth === 0) return conf.slice(start, i + 1);
    }
  }
  throw new Error(`location block "${header}" is not closed`);
}

/** Strip comments, so a number written in prose cannot satisfy a directive check. */
function directives(block: string): string {
  return block.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

const conf = await readFile(CONF, "utf8");

describe("conf/nginx.conf's backup location", () => {
  it("exists, and is an EXACT match on the backup route", () => {
    // `location =` is both the tightest scope nginx has and the highest
    // priority, so it cannot widen to a sub-path and does not depend on being
    // written before or after the app's own block.
    expect(conf).toContain("location = __PATH__/api/backup {");
  });

  it("gives that route the timeout the pre-flight tells the browser it has", () => {
    const block = directives(locationBody(conf, "location = __PATH__/api/backup {"));
    expect(block).toContain(`proxy_read_timeout ${String(BACKUP_PROXY_READ_TIMEOUT_SECONDS)};`);
  });

  it("does NOT raise the timeout for the rest of the app", () => {
    // The half that matters as much as the raise. Every other route in this app
    // answers in milliseconds.
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).toContain("proxy_read_timeout 300;");
    expect(block).not.toContain(String(BACKUP_PROXY_READ_TIMEOUT_SECONDS));
  });

  it("proxies to the backup route rather than to the app root", () => {
    // An exact-match location replaces the WHOLE matched URI with the
    // proxy_pass URI, so this string is what makes a sub-path install reach
    // /api/backup rather than /.
    const block = directives(locationBody(conf, "location = __PATH__/api/backup {"));
    expect(block).toContain("proxy_pass http://127.0.0.1:__PORT__/api/backup;");
  });

  it("carries the SSOwat identity headers, or the route would 401 for everyone", () => {
    // proxy_set_header is not inherited into a location configured on its own,
    // and proxy_params_with_auth is what sets Ynh-User. Measured on the deploy
    // target: with the include, a request through this block reaches the app
    // carrying the header; the app has no other source of identity.
    const block = directives(locationBody(conf, "location = __PATH__/api/backup {"));
    expect(block).toContain("include proxy_params_with_auth;");
  });

  it("uses the __PATH__/ spelling, so a root install does not become //", () => {
    // YunoHost's templating helper special-cases the literal "__PATH__/" to a
    // single "/" when the app is installed at the root. A block written
    // "__PATH__" + "/api/..." would not be special-cased and would render as
    // "/api/..." at a sub-path install -- the wrong URL entirely.
    expect(conf).toContain("location = __PATH__/api/backup");
    expect(conf).not.toMatch(/location = __PATH__api/);
  });
});
