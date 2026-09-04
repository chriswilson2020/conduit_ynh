import { describe, expect, it } from "vitest";
import {
  SCRATCH_DATABASE_PREFIXES, SCRATCH_DATABASE_STEM,
  databaseNameOf, scratchPrefixOverlaps, withDatabaseName,
} from "./databases.js";

// NO DATABASE HERE ON PURPOSE. Everything in this file is about NAMES, and the
// names have to be right before anything connects to them -- a suite that
// discovers a prefix collision by having one worker drop another worker's
// database has discovered it in the most expensive possible place.

describe("scratch database names", () => {
  /**
   * THE GUARD THAT WOULD HAVE CAUGHT THE COLLISION THIS FILE WAS WRITTEN FOR.
   *
   * Before the prefixes were collected in databases.ts, three suites shared a
   * namespace and one of them swept it:
   *
   *   services/restore.test.ts  conduit_restore_          + DROP DATABASE sweep
   *   routes/restore.test.ts    conduit_restore_routes_
   *   services/backup.test.ts   conduit_restore_<hex16>
   *
   * `conduit_restore_routes_...` and `conduit_restore_<hex>` both start with
   * `conduit_restore_`, so the sweep's `LIKE 'conduit_restore_%'` matched them.
   * With files running one at a time that never fired -- a sweep at the start of
   * one file only ever met databases from a run that had already ended. With
   * files running concurrently it is one suite dropping another's live database
   * mid-test, and the symptom lands in the victim.
   *
   * MUTATION-CHECKED: setting `restoreService` back to "conduit_restore_" and
   * `restoreRoutes` to "conduit_restore_routes_" fails this with
   *   expected [ [ 'conduit_restore_', 'conduit_restore_routes_' ] ] to deeply equal []
   * which names the two prefixes at fault rather than merely going red.
   */
  it("has no prefix a sweep would take another suite's database with", () => {
    expect(scratchPrefixOverlaps()).toEqual([]);
  });

  // The sweep in scripts/drop-test-databases.sh clears leaked scratch databases
  // with one `starts_with(datname, 'conduit_scratch_')`. That only covers all
  // four suites while all four sit under the stem, and a fifth suite added later
  // is exactly the thing that would quietly not be covered.
  it("keeps every scratch prefix under the one stem the leak sweep clears", () => {
    for (const [suite, prefix] of Object.entries(SCRATCH_DATABASE_PREFIXES)) {
      expect(prefix, `${suite} must be sweepable by scripts/drop-test-databases.sh`)
        .toMatch(new RegExp(`^${SCRATCH_DATABASE_STEM}`));
    }
  });
});

describe("withDatabaseName", () => {
  // The socket form the dev server uses and the TCP form CI uses, which take
  // different paths through URL parsing (empty host vs. host:port + credentials).
  it("swaps the name in both connection-string shapes", () => {
    expect(withDatabaseName("postgres:///conduit_test", "conduit_test_w2"))
      .toBe("postgres:///conduit_test_w2");
    expect(withDatabaseName("postgres://conduit:conduit@localhost:5432/conduit_test", "conduit_test_w2"))
      .toBe("postgres://conduit:conduit@localhost:5432/conduit_test_w2");
  });

  /**
   * THE BUG THIS HELPER REPLACED, AS A TEST.
   *
   * Three call sites did this with `url.replace(/\/[^/]*$/, "/" + name)`. That
   * regex matches from the last slash to the END OF THE STRING -- query string
   * included -- so a URL carrying options lost them, silently, and the scratch
   * database connected with different settings from the one it was compared
   * against. mail-ingest.test.ts's time-zone case composes exactly such a URL.
   *
   * MUTATION-CHECKED: putting the regex form back fails this with
   *   expected 'postgres:///conduit_test_w2' to be
   *            'postgres:///conduit_test_w2?options=-c%20timezone%3DUTC'
   */
  it("keeps a query string, which the regex it replaced discarded", () => {
    const zoned = "postgres:///conduit_test?options=-c%20timezone%3DUTC";
    expect(withDatabaseName(zoned, "conduit_test_w2"))
      .toBe("postgres:///conduit_test_w2?options=-c%20timezone%3DUTC");
  });

  it("round-trips through databaseNameOf", () => {
    expect(databaseNameOf(withDatabaseName("postgres:///conduit_test", "x_y_z"))).toBe("x_y_z");
  });
});
