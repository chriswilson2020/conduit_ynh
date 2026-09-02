import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./intake.js";
import {
  RESTORE_CLIENT_MAX_BODY_SIZE, RESTORE_PROXY_READ_TIMEOUT_SECONDS,
} from "./restore.js";

/**
 * THE PROXY IS PART OF THE RESTORE, SO IT IS ASSERTED LIKE ONE.
 *
 * backup-nginx.test.ts guards 7.6's one raised timeout and says why a comment
 * would not have been enough. Restore adds three properties that fail in
 * different ways, and only one of them is a timeout:
 *
 *   THE BODY SIZE. The app's own location carries `client_max_body_size 50M`,
 *   written for a mail attachment. An upload larger than that is refused BY
 *   NGINX, which answers its own HTML 413 -- so the app never sees the request,
 *   the page's message about the limit never runs, and the operator gets an
 *   unstyled proxy error. This is the one failure mode where nothing in the
 *   application is even reachable, which is exactly why it needs a test in the
 *   application.
 *
 *   THE REQUEST BUFFERING. Off, and not for speed: the preview's multipart body
 *   carries the archive passphrase in its FIRST field, so a buffered body is
 *   that passphrase written to a file in nginx's client_body_temp_path. 7.6's
 *   rule is that the passphrase is never written to disk, and a rule the
 *   deployment breaks is not a rule.
 *
 *   THE WAIT, on BOTH routes. The preview decrypts and unpacks before it
 *   answers; the apply takes a whole safety backup before it destroys anything.
 *
 * A GUARD THAT READS SOURCE IS SCOPED TO THE CONSTRUCT IT GUARDS -- the
 * project's rule, and the reason this parses the location blocks out and asks
 * about each rather than grepping the file. The helpers are deliberately the
 * same two backup-nginx.test.ts uses; they are small, and two copies that can
 * be read side by side beat an import that makes one file's failure depend on
 * the other file's parser.
 */

// The same spelling backup-nginx.test.ts uses to reach conf/, four levels up
// from packages/api/src/services to the repo root.
const CONF = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "conf", "nginx.conf",
);

/**
 * The body of one `location` block, by its header line.
 *
 * Brace-counted rather than matched with a regex, for the reason its twin in
 * backup-nginx.test.ts gives: a lazy match would silently truncate a block that
 * grew an `if` inside it, and the guard would then assert about half a block.
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

/**
 * An nginx size, in bytes.
 *
 * PARSED RATHER THAN MATCHED, because `8g` and `8192m` are the same directive
 * and a guard that accepted only one spelling would be asserting about
 * typography instead of about capacity. Returns null for anything that is not
 * an nginx size at all, so a directive somebody wrote as `8gb` fails the test
 * rather than reading as 8 bytes.
 */
export function nginxSizeBytes(value: string): number | null {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  switch ((match[2] ?? "").toLowerCase()) {
    case "k": return amount * 1024;
    case "m": return amount * 1024 * 1024;
    case "g": return amount * 1024 * 1024 * 1024;
    default: return amount;
  }
}

const INSPECT = "location = __PATH__/api/restore/inspect {";
const APPLY = "location = __PATH__/api/restore/apply {";

const conf = await readFile(CONF, "utf8");

describe("nginxSizeBytes", () => {
  // THE PARSER IS AN INSTRUMENT TOO, and it is the one everything below rests
  // on: a parser that answered 0 for everything would make the capacity
  // assertion pass against any file at all.
  it("reads every suffix nginx accepts, and rejects what it does not", () => {
    expect(nginxSizeBytes("50")).toBe(50);
    expect(nginxSizeBytes("50k")).toBe(51_200);
    expect(nginxSizeBytes("50M")).toBe(52_428_800);
    expect(nginxSizeBytes("8g")).toBe(8_589_934_592);
    // Two spellings of one capacity, which is the whole reason this is parsed.
    expect(nginxSizeBytes("8g")).toBe(nginxSizeBytes("8192m"));
    // Not nginx sizes. `8gb` is the plausible mistake and it must not read as 8.
    expect(nginxSizeBytes("8gb")).toBeNull();
    expect(nginxSizeBytes("")).toBeNull();
    expect(nginxSizeBytes("large")).toBeNull();
  });
});

describe("conf/nginx.conf's restore preview location", () => {
  it("exists, and is an EXACT match on the preview route", () => {
    // `location =` is both the tightest scope nginx has and the highest
    // priority, so it wins over the app's own block without depending on order
    // and cannot widen to a sub-path nobody meant to include.
    expect(conf).toContain(INSPECT);
  });

  it("ACCEPTS A BODY AS LARGE AS THE APP ITSELF WILL, or every real restore 413s", () => {
    const block = directives(locationBody(conf, INSPECT));
    const declared = /client_max_body_size\s+(\S+);/.exec(block)?.[1];
    expect(declared, "the preview block declares no client_max_body_size").toBeDefined();
    const bytes = nginxSizeBytes(declared ?? "");
    expect(bytes, `client_max_body_size ${String(declared)} is not an nginx size`).not.toBeNull();
    // THE COMPARISON IS AGAINST THE APP'S OWN CEILING, not against a number
    // repeated here. services/intake.ts decides what this install accepts; if
    // that is raised and this is not, nginx refuses the upload before the app
    // can say anything about it, and the operator sees nginx's HTML rather than
    // Conduit's message.
    //
    // STRICTLY ABOVE, not equal, and a review is why. The two bounds measure
    // different things -- the app's is on the FILE PART, nginx's is on the
    // WHOLE BODY including the multipart preamble, the passphrase field and
    // every boundary -- so a file of exactly the app's ceiling is a body a few
    // hundred bytes over it. Set equal, the largest upload this install claims
    // to accept is the one nginx refuses.
    expect(bytes ?? 0).toBeGreaterThan(DEFAULT_MAX_UPLOAD_BYTES);
    // And the constant the service publishes is the value in the file, so a
    // reader of either finds the same number.
    expect(declared).toBe(RESTORE_CLIENT_MAX_BODY_SIZE);
  });

  it("DOES NOT BUFFER THE REQUEST, because the passphrase is in it", () => {
    // The preview's body is multipart with the passphrase FIRST. Buffered, that
    // is the archive's passphrase written to a file Conduit does not own,
    // cannot chmod and does not delete -- 7.6's rule broken by the deployment
    // rather than by the process.
    const block = directives(locationBody(conf, INSPECT));
    expect(block).toContain("proxy_request_buffering off;");
    // An unbuffered body that arrives chunked cannot be forwarded over the
    // HTTP/1.0 nginx speaks upstream by default.
    expect(block).toContain("proxy_http_version 1.1;");
  });

  it("waits for the unpack, which happens after the last byte arrives", () => {
    const block = directives(locationBody(conf, INSPECT));
    expect(block).toContain(`proxy_read_timeout ${String(RESTORE_PROXY_READ_TIMEOUT_SECONDS)};`);
  });

  it("proxies to the preview route rather than to the app root", () => {
    // An exact-match location replaces the WHOLE matched URI with the
    // proxy_pass URI, so this string is what makes a sub-path install reach
    // /api/restore/inspect rather than /.
    const block = directives(locationBody(conf, INSPECT));
    expect(block).toContain("proxy_pass http://127.0.0.1:__PORT__/api/restore/inspect;");
  });

  it("carries the SSOwat identity headers, or the route would 401 for everyone", () => {
    // proxy_set_header is not inherited into a location configured on its own,
    // and proxy_params_with_auth is what sets Ynh-User.
    const block = directives(locationBody(conf, INSPECT));
    expect(block).toContain("include proxy_params_with_auth;");
  });
});

describe("conf/nginx.conf's restore apply location", () => {
  it("exists, and is an EXACT match on the apply route", () => {
    expect(conf).toContain(APPLY);
  });

  it("waits for a safety backup and a load, which is the longest request this app has", () => {
    const block = directives(locationBody(conf, APPLY));
    expect(block).toContain(`proxy_read_timeout ${String(RESTORE_PROXY_READ_TIMEOUT_SECONDS)};`);
  });

  it("proxies to the apply route, and carries the identity headers", () => {
    const block = directives(locationBody(conf, APPLY));
    expect(block).toContain("proxy_pass http://127.0.0.1:__PORT__/api/restore/apply;");
    expect(block).toContain("include proxy_params_with_auth;");
  });

  it("does NOT accept a large body, because it does not take one", () => {
    // Three short fields. The route's own schema is the real bound; this is
    // here so the block cannot quietly acquire the preview's capacity by being
    // copied from it.
    //
    // THE TWO `?? ` DEFAULTS THIS USED TO CARRY MADE IT VACUOUS, and a review
    // caught it: an absent directive gave `undefined -> nginxSizeBytes("") ->
    // null -> 0`, and `0 < 8GiB` is green. It passed if the block lost the
    // directive entirely, and it passed if somebody wrote an unparseable `8gb`.
    // Both are exactly the failures the preview's version of this assertion
    // guards against by name, ten lines up.
    const block = directives(locationBody(conf, APPLY));
    const declared = /client_max_body_size\s+(\S+);/.exec(block)?.[1];
    expect(declared, "the apply block declares no client_max_body_size").toBeDefined();
    const bytes = nginxSizeBytes(declared ?? "");
    expect(bytes, `client_max_body_size ${String(declared)} is not an nginx size`).not.toBeNull();
    expect(bytes ?? 0).toBeLessThan(DEFAULT_MAX_UPLOAD_BYTES);
  });
});

describe("conf/nginx.conf's app location, which the restore blocks must not have changed", () => {
  it("still refuses a large body everywhere else", () => {
    // The half that matters as much as the raise. 8 GiB applied to every route
    // would let any authenticated caller fill the disk through any POST in the
    // application.
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).toContain("client_max_body_size 50M;");
    expect(block).not.toContain(RESTORE_CLIENT_MAX_BODY_SIZE);
  });

  it("still buffers its request bodies everywhere else", () => {
    // `proxy_request_buffering off` makes nginx forward a body as it arrives,
    // so a slow client holds an upstream connection for as long as it uploads.
    // That is the right trade for the one route where the alternative is a
    // passphrase on disk, and the wrong one for every other route in the app.
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).not.toContain("proxy_request_buffering");
  });

  it("still gives up after 300 seconds everywhere else", () => {
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).toContain("proxy_read_timeout 300;");
    expect(block).not.toContain(String(RESTORE_PROXY_READ_TIMEOUT_SECONDS));
  });
});
