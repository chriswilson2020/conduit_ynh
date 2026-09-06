import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * STAMP A NEWLY GENERATED MIGRATION SO DRIZZLE WILL ACTUALLY APPLY IT.
 *
 * `npm run db:generate` runs this straight after `drizzle-kit generate`. It
 * exists because the value drizzle-kit writes is wrong in this repository and
 * cannot be made right at the keyboard.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, READ OUT OF THE MIGRATOR RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * drizzle-orm/pg-core/dialect.js:
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations
 *       order by created_at desc limit 1            <- ONE row, before the loop
 *     ...
 *     if (!lastDbMigration || Number(lastDbMigration.created_at) < folderMillis)
 *
 * Three things follow, and each one matters here:
 *
 *   - THE HASH IS NEVER CONSULTED. A migration is applied or skipped on its
 *     `when` alone, so the journal's timestamps are not decoration -- they ARE
 *     the ordering.
 *   - THE COMPARISON IS AGAINST A HIGH-WATER MARK taken once, before anything
 *     is applied, not against a running cursor. What a new entry must beat is
 *     the LARGEST `created_at` any install has recorded.
 *   - A DATABASE WITH NO ROWS APPLIES EVERYTHING. That is why nothing catches
 *     this: global-setup migrates a fresh template in one pass, CI is fresh
 *     every time, and a new install is fresh by definition. The only database
 *     that can be hurt is one that has already been migrated -- which is every
 *     install an operator cares about, and no database any test creates.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VALUES ARE NOT SIMPLY BROUGHT BACK DOWN
 * ---------------------------------------------------------------------------
 * Journal entries 0013-0020 carry round numbers set by hand -- 1788600000000,
 * 1788700000000, ... 1789300000000 -- all of which were in the future when they
 * were written, and 0020's still is (2026-09-13T11:46:40Z).
 *
 * THE OBVIOUS REPAIR IS THE DANGEROUS ONE. v1.7.2, which is what the live
 * install runs, ships the journal as far as 0015_reauth_status, `when`
 * 1788800000000 -- so that install's `drizzle.__drizzle_migrations` holds
 * 1788800000000 as its newest `created_at`. Rewriting 0016-0020 down to honest
 * past timestamps would put all five BELOW that row, and the next boot after an
 * upgrade would skip all five in silence: no error, no warning, five tables and
 * columns simply absent. It would convert a hazard CI catches into the exact
 * silent one this whole exercise is about, on the one install that exists. It
 * could only be done alongside a step that rewrote `created_at` in a live
 * database before `migrate()` ran, which is a new moving part in the boot path
 * of a production install, bought to make three numbers look nicer.
 *
 * So history is left exactly as it is, and only the NEXT entry is corrected.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD, AND WHY IT NEEDS NO CLEANUP LATER
 * ---------------------------------------------------------------------------
 * `max(now, largest existing + 1)`.
 *
 *   - `largest existing + 1` is what the migrator needs, stated as the property
 *     it actually tests rather than as a guess about the calendar.
 *   - `now` wins the moment the wall clock passes 0020, seven days from the
 *     time of writing. From then on the stamps are ordinary timestamps again
 *     with nothing to undo, so the anomaly stays confined to 0013-0020 rather
 *     than compounding by a millisecond per migration for ever.
 *   - Nothing already shipped moves, so no install skips anything.
 *
 * THE REMAINING HOLE IS `npx drizzle-kit generate` RUN DIRECTLY, which bypasses
 * this. db/schema.test.ts's strictly-increasing check is the net for that, and
 * it stays -- but it is now a net with a fix behind it rather than the only
 * thing standing between a hand-edit and a shipped migration that never runs.
 */

interface JournalEntry { idx: number; when: number; tag: string }
interface Journal { entries: JournalEntry[] }

/**
 * The `when` a newly generated entry must carry.
 *
 * `+ 1`, not `+ 0`: the migrator's comparison is `<`, strictly, so an entry
 * whose `when` EQUALS the newest applied row is skipped exactly like a lower
 * one. A millisecond is the whole difference between shipped and inert.
 */
export function stampFor(largestExisting: number | null, now: number): number {
  if (largestExisting === null) return now;
  return Math.max(now, largestExisting + 1);
}

/**
 * The journal text with the newest entry's `when` corrected, or null when it
 * already beats everything before it and nothing needs to change.
 *
 * Throws when the file is not formatted the way this would write it back --
 * see the test of the same name. Reformatting a file drizzle-kit owns, to bury
 * a one-number change in a whole-file diff, is the failure worth refusing.
 */
export function restampJournal(text: string, now: number): string | null {
  const journal = JSON.parse(text) as Journal;
  if (JSON.stringify(journal, null, 2) !== text) {
    throw new Error(
      "the migration journal's formatting is not what this would write back, so it was left "
      + "alone. drizzle-kit has changed how it writes meta/_journal.json; teach "
      + "db/journal-stamp.ts the new shape rather than letting it reformat the file.",
    );
  }
  const newest = journal.entries.at(-1);
  if (newest === undefined || journal.entries.length < 2) return null;

  // The MAXIMUM of everything before it, not the neighbour: drizzle reads one
  // row ordered by created_at desc, so an out-of-order pair earlier in the file
  // would make the neighbour the wrong number to beat.
  const largest = Math.max(...journal.entries.slice(0, -1).map((entry) => entry.when));
  if (newest.when > largest) return null;

  newest.when = stampFor(largest, now);
  return JSON.stringify(journal, null, 2);
}

/**
 * The journal file, resolved without importing db/client.ts.
 *
 * IT DUPLICATES migrationsFolder() DELIBERATELY, AND A TEST HOLDS THEM
 * TOGETHER. `npm run db:generate` runs this file as TypeScript through plain
 * `node`, and node's type stripping does not remap the `./client.js` specifier
 * this package's NodeNext setup requires onto `client.ts` -- measured, it exits
 * ERR_MODULE_NOT_FOUND for `src/db/client.js`. Building first would make a dev
 * command depend on `tsc -b` having been run. So the path is re-derived here by
 * the same expression, from the same directory, and
 * journal-stamp.test.ts asserts the two answers are the same string; drift is
 * caught rather than trusted.
 */
export function journalPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle", "meta", "_journal.json",
  );
}

/**
 * The CLI half, run by `npm run db:generate` after drizzle-kit.
 *
 * Guarded on argv rather than on `import.meta.main`, which node gained only in
 * 24.2 -- this has to work on whatever the deploy target is running.
 */
function main(): void {
  const before = readFileSync(journalPath(), "utf8");
  const after = restampJournal(before, Date.now());
  if (after === null) {
    console.log(`db:generate: ${journalPath()} already orders its newest entry correctly.`);
    return;
  }
  writeFileSync(journalPath(), after);
  const newest = (JSON.parse(after) as Journal).entries.at(-1);
  console.log(
    `db:generate: restamped ${newest?.tag ?? "?"} to when=${String(newest?.when)} `
    + `(${new Date(newest?.when ?? 0).toISOString()}), because the wall clock is behind the `
    + `hand-set values in entries 0013-0020 and drizzle would have skipped it. `
    + `See db/journal-stamp.ts.`,
  );
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
