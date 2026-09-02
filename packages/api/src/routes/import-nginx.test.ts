import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../services/intake.js";
import {
  IMPORT_CLIENT_MAX_BODY_SIZE, IMPORT_PROXY_READ_TIMEOUT_SECONDS,
} from "./import.js";

/**
 * THE PROXY IS PART OF THE IMPORT, SO IT IS ASSERTED LIKE ONE.
 *
 * services/restore-nginx.test.ts guards the restore's three properties and says
 * why a comment would not have been enough. The importers add the same
 * body-size failure with a different artefact in it, and one property the
 * restore does not have: a directive that must NOT be copied.
 *
 *   THE BODY SIZE, on the three routes that receive a file. The app's own
 *   location carries `client_max_body_size 50M`, written for a mail attachment.
 *   An upload larger than that is refused BY NGINX, which answers its own HTML
 *   413 -- so the app never sees the request, the page's message about the limit
 *   never runs, and the operator gets an unstyled proxy error. Neither importer
 *   is reachable at all for anything but a toy file. This is the one failure
 *   mode where nothing in the application is even executable, which is exactly
 *   why it needs a test in the application.
 *
 *   THE BODY SIZE THE TWO APPLY ROUTES MUST NOT HAVE. Their real body is one
 *   uuid. Nine gigabytes there would be a disk-fill vector through a route that
 *   rejects anything over Fastify's 1MB JSON limit -- after nginx has buffered
 *   it. The restore's own suite makes the same assertion about its apply block
 *   and names the two `?? ` defaults that once made it vacuous; this one is
 *   written the way that review left it.
 *
 *   AND REQUEST BUFFERING LEFT ALONE, which is the assertion with no twin next
 *   door. `proxy_request_buffering off` is right for the restore preview
 *   because that body's first field is the archive passphrase. NEITHER IMPORTER
 *   TAKES A PASSPHRASE, so copying the directive here would buy nothing and
 *   would widen services/write-gate.ts's denial-of-recovery window: an
 *   unbuffered body puts a trickling client into the app's in-flight write set,
 *   and every restore refuses to start while that count is above zero.
 *
 * THE HELPERS ARE COPIED AND NOT IMPORTED, which is the preference
 * services/restore-nginx.test.ts states for itself -- "two copies that can be
 * read side by side beat an import that makes one file's failure depend on the
 * other file's parser" -- and here it is not only a preference. Vitest collects
 * every test file under the packages as a file of its own; importing one from
 * another executes its module body a second time, so `nginxSizeBytes` reached
 * for across that boundary would have registered fourteen restore assertions
 * inside this file and counted them twice. The copies carry their own tests
 * below, because a parser that answered 0 for everything would make every
 * capacity assertion here pass against any file at all.
 */

// Four levels up from packages/api/src/routes to the repo root, which is one
// fewer than services/ needs.
const CONF = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "conf", "nginx.conf",
);

/**
 * The body of one `location` block, by its header line.
 *
 * Brace-counted rather than matched with a regex, for the reason its twins in
 * backup-nginx.test.ts and restore-nginx.test.ts give: a lazy match would
 * silently truncate a block that grew an `if` inside it, and the guard would
 * then be asserting about half a block.
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

/** The routes that receive a file, and therefore need the capacity. */
const RECEIVING = [
  "location = __PATH__/api/import/export/inspect {",
  "location = __PATH__/api/import/csv/inspect {",
  "location = __PATH__/api/import/csv/plan {",
] as const;

/** The routes whose whole body is one uuid. */
const APPLYING = [
  "location = __PATH__/api/import/export/apply {",
  "location = __PATH__/api/import/csv/apply {",
] as const;

/**
 * An nginx size, in bytes.
 *
 * PARSED RATHER THAN MATCHED, because `8g` and `8192m` are the same directive
 * and a guard that accepted only one spelling would be asserting about
 * typography instead of about capacity. Returns null for anything that is not
 * an nginx size at all, so a directive somebody wrote as `8gb` fails the test
 * rather than reading as 8 bytes.
 */
function nginxSizeBytes(value: string): number | null {
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

/**
 * What a `client_max_body_size` actually PERMITS, in bytes.
 *
 * `0` IS NOT ZERO. nginx documents it as "disables checking of client request
 * body size" -- it is the widest possible setting, not the narrowest -- and a
 * review found that reading it as the number zero made the apply blocks'
 * assertion vacuous: `0 < 8 GiB` is green, so a block that had quietly become
 * UNLIMITED passed the test that exists to prove it is bounded. The parser
 * above is right about the syntax and this is right about the meaning, which is
 * why they are two functions: nginxSizeBytes is what the file says, and this is
 * what nginx does with it.
 *
 * IT IS THE SAME CLASS OF DEFECT THE `?? ` DEFAULTS PRODUCED, one layer along,
 * and services/restore-nginx.test.ts's own docstring is about the first one --
 * which is exactly why this one was worth looking for.
 */
function nginxBodyLimitBytes(value: string): number | null {
  const bytes = nginxSizeBytes(value);
  if (bytes === null) return null;
  return bytes === 0 ? Number.POSITIVE_INFINITY : bytes;
}

const conf = await readFile(CONF, "utf8");

describe("this file's own nginx size parser", () => {
  // THE PARSER IS AN INSTRUMENT TOO, and it is the one every capacity
  // assertion below rests on: a parser that answered 0 for everything would
  // make them pass against any file at all.
  it("reads every suffix nginx accepts, and rejects what it does not", () => {
    expect(nginxSizeBytes("50")).toBe(50);
    expect(nginxSizeBytes("50k")).toBe(51_200);
    expect(nginxSizeBytes("50M")).toBe(52_428_800);
    expect(nginxSizeBytes("9g")).toBe(9_663_676_416);
    // Two spellings of one capacity, which is the whole reason this is parsed.
    expect(nginxSizeBytes("9g")).toBe(nginxSizeBytes("9216m"));
    // Not nginx sizes. `9gb` is the plausible mistake and it must not read as 9.
    expect(nginxSizeBytes("9gb")).toBeNull();
    expect(nginxSizeBytes("")).toBeNull();
    expect(nginxSizeBytes("large")).toBeNull();
  });

  it("READS `0` AS UNLIMITED, which is what nginx does with it", () => {
    // The distinction the apply blocks' bound rests on. Without it a block that
    // had become unlimited would satisfy "smaller than the app's ceiling".
    expect(nginxSizeBytes("0")).toBe(0);
    expect(nginxBodyLimitBytes("0")).toBe(Number.POSITIVE_INFINITY);
    expect(nginxBodyLimitBytes("50M")).toBe(52_428_800);
    expect(nginxBodyLimitBytes("9gb")).toBeNull();
  });
});

describe("conf/nginx.conf's import upload locations", () => {
  for (const header of RECEIVING) {
    const route = header.replace("location = __PATH__", "").replace(" {", "");

    it(`${route} exists, and is an EXACT match`, () => {
      // `location =` is both the tightest scope nginx has and the highest
      // priority, so it wins over the app's own block without depending on
      // order and cannot widen to a sub-path nobody meant to include. A prefix
      // location covering the whole family would have been shorter and would
      // have given the apply routes this capacity by inheritance.
      expect(conf).toContain(header);
    });

    it(`${route} ACCEPTS A BODY AS LARGE AS THE APP ITSELF WILL`, () => {
      const block = directives(locationBody(conf, header));
      const declared = /client_max_body_size\s+(\S+);/.exec(block)?.[1];
      expect(declared, `${route} declares no client_max_body_size`).toBeDefined();
      const bytes = nginxBodyLimitBytes(declared ?? "");
      expect(bytes, `client_max_body_size ${String(declared)} is not an nginx size`)
        .not.toBeNull();
      // AGAINST THE APP'S OWN CEILING, not against a number repeated here.
      // services/intake.ts decides what this install accepts; if that is raised
      // and this is not, nginx refuses the upload before the app can say
      // anything about it.
      //
      // STRICTLY ABOVE, not equal, for the reason the restore's twin records:
      // the app's bound is on the FILE PART and this one is on the WHOLE BODY,
      // which also carries the multipart preamble, the mapping field and every
      // boundary. Set equal, the largest upload this install claims to accept
      // is the one nginx refuses.
      expect(bytes ?? 0).toBeGreaterThan(DEFAULT_MAX_UPLOAD_BYTES);
      expect(declared).toBe(IMPORT_CLIENT_MAX_BODY_SIZE);
    });

    it(`${route} waits for the whole of the work, which happens after the last byte`, () => {
      const block = directives(locationBody(conf, header));
      expect(block).toContain(`proxy_read_timeout ${String(IMPORT_PROXY_READ_TIMEOUT_SECONDS)};`);
    });

    it(`${route} proxies to itself and carries the identity headers`, () => {
      // An exact-match location replaces the WHOLE matched URI with the
      // proxy_pass URI, so this string is what makes a sub-path install reach
      // the route rather than `/`. And proxy_set_header is not inherited into a
      // location configured on its own: without proxy_params_with_auth this
      // route would see no Ynh-User at all and answer 401 to everybody.
      const block = directives(locationBody(conf, header));
      expect(block).toContain(`proxy_pass http://127.0.0.1:__PORT__${route};`);
      expect(block).toContain("include proxy_params_with_auth;");
    });

  }
});

describe("conf/nginx.conf's import apply locations", () => {
  for (const header of APPLYING) {
    const route = header.replace("location = __PATH__", "").replace(" {", "");

    it(`${route} exists and waits for a transaction of 200,000 rows`, () => {
      expect(conf).toContain(header);
      const block = directives(locationBody(conf, header));
      expect(block).toContain(`proxy_read_timeout ${String(IMPORT_PROXY_READ_TIMEOUT_SECONDS)};`);
      expect(block).toContain(`proxy_pass http://127.0.0.1:__PORT__${route};`);
      expect(block).toContain("include proxy_params_with_auth;");
    });

    it(`${route} GETS NO SPECIAL CAPACITY AT ALL: the app's own 50M, exactly`, () => {
      // "SMALLER THAN 8 GiB" WAS THREE HOLES WIDE, and a review measured all
      // three green: `0`, which nginx reads as UNLIMITED and this file used to
      // read as the number zero; `4g`, which is smaller than the app's ceiling
      // and forty times what this route can use; and simply a different number
      // nobody could explain later. The honest claim is not a bound, it is that
      // these routes are NOT TUNED -- their whole body is one uuid, and the
      // app's block already carries the right number.
      //
      // WRITTEN WITHOUT `?? ` DEFAULTS, which is the shape the restore's own
      // review had to remove from its twin: an absent directive gave
      // `undefined -> nginxSizeBytes("") -> null -> 0`, and `0 < 8 GiB` is
      // green, so the test passed when the block lost the directive entirely.
      const block = directives(locationBody(conf, header));
      const declared = /client_max_body_size\s+(\S+);/.exec(block)?.[1];
      expect(declared, `${route} declares no client_max_body_size`).toBeDefined();
      expect(declared, `${route} should carry the app's own 50M`).toBe("50M");
      const limit = nginxBodyLimitBytes(declared ?? "");
      expect(limit, `client_max_body_size ${String(declared)} is not an nginx size`)
        .not.toBeNull();
      // AND THE MEANING, not only the spelling: `0` would satisfy every
      // less-than in this file and permit everything.
      expect(limit ?? 0).toBeLessThan(DEFAULT_MAX_UPLOAD_BYTES);
      expect(limit).not.toBe(Number.POSITIVE_INFINITY);
    });
  }
});

describe("every import location, receiving or not", () => {
  // THE ASSERTION THAT USED TO LIVE INSIDE THE RECEIVING LOOP, and a review
  // found the gap: `proxy_request_buffering off` added to an APPLY block was
  // green, because nothing outside that loop looked. It is written as an
  // assertion rather than left implicit because "the directive is absent" and
  // "nobody thought about it" look identical in a config file.
  //
  // WHY IT MUST STAY ABSENT. It is off for the restore preview only because
  // that body's FIRST FIELD IS THE ARCHIVE PASSPHRASE, and a buffered body puts
  // a passphrase into disk blocks. No import body carries a secret, and turning
  // buffering off puts a trickling client into the app's in-flight write set
  // for as long as it trickles -- which is what services/write-gate.ts names as
  // a denial of recovery, because a restore refuses to start while that count
  // is above zero. Copying the directive would buy nothing and cost that.
  for (const header of [...RECEIVING, ...APPLYING]) {
    const route = header.replace("location = __PATH__", "").replace(" {", "");
    it(`${route} buffers its request body, because there is no passphrase in it`, () => {
      const block = directives(locationBody(conf, header));
      expect(block).not.toContain("proxy_request_buffering");
    });
  }
});

describe("conf/nginx.conf's app location, which the import blocks must not have changed", () => {
  it("still refuses a large body everywhere else", () => {
    // The half that matters as much as the raise. 8 GiB applied to every route
    // would let any authenticated caller fill the disk through any POST in the
    // application.
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).toContain("client_max_body_size 50M;");
    expect(block).not.toContain(IMPORT_CLIENT_MAX_BODY_SIZE);
  });

  it("still gives up after 300 seconds everywhere else", () => {
    const block = directives(locationBody(conf, "location __PATH__/ {"));
    expect(block).toContain("proxy_read_timeout 300;");
    expect(block).not.toContain(String(IMPORT_PROXY_READ_TIMEOUT_SECONDS));
  });
});
