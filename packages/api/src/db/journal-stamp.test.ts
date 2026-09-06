import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "./client.js";
import { journalPath, restampJournal, stampFor } from "./journal-stamp.js";

/**
 * THE FIX BEHIND THE SAFETY NET, AND WHY THE NET WAS NEVER GOING TO BE ENOUGH.
 *
 * db/schema.test.ts pins the journal's `when` values as strictly increasing,
 * because drizzle applies a migration only when its `when` exceeds the newest
 * `created_at` already in `drizzle.__drizzle_migrations`. That test has caught
 * this five times out of five in Phase 9 -- and every time the repair was a
 * human editing a machine-generated file by hand, which is the step that keeps
 * producing the defect.
 *
 * `drizzle-kit generate` stamps `when` from the wall clock. Entries 0013-0020
 * were given round numbers by hand, all of them ahead of that clock, and 0020
 * sits at 1789300000000 = 2026-09-13T11:46:40Z. So until the clock passes that
 * moment EVERY generated entry lands below its predecessor, and no amount of
 * care at the keyboard changes it.
 *
 * This module is what `npm run db:generate` runs afterwards so the value is
 * right by construction. The tests below are about that arithmetic; the schema
 * test stays as the net for anyone who runs `drizzle-kit generate` directly.
 */

const ENTRY = { version: "7", breakpoints: true };
const journalOf = (whens: readonly number[]): string => JSON.stringify({
  version: "7",
  dialect: "postgresql",
  entries: whens.map((when, idx) => ({
    idx, ...ENTRY, when, tag: `${String(idx).padStart(4, "0")}_thing`,
  })),
}, null, 2);

const whensOf = (text: string): number[] =>
  (JSON.parse(text) as { entries: { when: number }[] }).entries.map((entry) => entry.when);

describe("stampFor", () => {
  it("uses the wall clock when it is already ahead of everything shipped", () => {
    expect(stampFor(1000, 5000)).toBe(5000);
  });

  // THE SELF-LIMITING HALF, and the reason nothing has to be cleaned up later:
  // the moment the clock passes the last hand-set value the stamps go back to
  // being real timestamps on their own, so the anomaly stays confined to
  // 0013-0020 instead of compounding by one millisecond for ever.
  it("lifts to one millisecond past the predecessor while the clock is behind", () => {
    expect(stampFor(5000, 1000)).toBe(5001);
  });

  // A boundary rather than a tidy case: drizzle's test is `<`, strictly, so a
  // value EQUAL to the newest applied one is skipped exactly like a lower one.
  it("refuses to reuse the predecessor's own value", () => {
    expect(stampFor(5000, 5000)).toBe(5001);
  });

  it("takes the clock when there is no predecessor at all", () => {
    expect(stampFor(null, 1000)).toBe(1000);
  });
});

// THE ONE DUPLICATED PATH IN THIS MODULE, HELD TOGETHER RATHER THAN TRUSTED.
// journalPath() re-derives what migrationsFolder() already knows, because
// `npm run db:generate` runs the module as TypeScript through plain node and
// node will not remap the `./client.js` specifier NodeNext requires -- measured,
// it exits ERR_MODULE_NOT_FOUND. This is the line that stops the two answers
// drifting apart, and it fails if either module moves.
it("resolves the same journal db/client.ts migrates from", () => {
  expect(journalPath()).toBe(path.join(migrationsFolder(), "meta", "_journal.json"));
});

describe("restampJournal", () => {
  it("lifts a wall-clock stamp that landed below its predecessor", () => {
    const before = journalOf([100, 1789300000000, 1788711006175]);
    const after = restampJournal(before, 1788711006175);
    expect(after).not.toBeNull();
    expect(whensOf(after!)).toEqual([100, 1789300000000, 1789300000001]);
  });

  // NOT "rewrites it to now", which is the version that looks equivalent and is
  // not: it would move a value drizzle has already agreed to, and on an install
  // that has applied the entry the row in __drizzle_migrations would no longer
  // match the journal it came from.
  it("leaves an entry that is already ahead exactly as it found it", () => {
    const before = journalOf([100, 200, 300]);
    expect(restampJournal(before, 999999)).toBeNull();
  });

  /**
   * EQUAL IS NOT AHEAD, and this case exists because a mutation found the gap:
   * `if (newest.when >= largest) return null` survived every other test here.
   * drizzle's comparison is `created_at < folderMillis`, strictly, so an entry
   * stamped with EXACTLY the newest applied value is skipped just like a lower
   * one -- and two `drizzle-kit generate` runs in the same millisecond is all it
   * takes to produce that value.
   */
  it("lifts an entry that merely ties with what precedes it", () => {
    expect(whensOf(restampJournal(journalOf([100, 500, 500]), 1)!)).toEqual([100, 500, 501]);
  });

  // The MAXIMUM of what precedes it, not the neighbour. drizzle reads ONE row --
  // `order by created_at desc limit 1` -- so what a new entry has to beat is the
  // largest value any install can have recorded, and an out-of-order pair
  // earlier in the file would make the neighbour the wrong number to beat.
  it("beats the largest preceding value, not the nearest one", () => {
    const before = journalOf([100, 9000, 500, 200]);
    expect(whensOf(restampJournal(before, 1)!)).toEqual([100, 9000, 500, 9001]);
  });

  it("has nothing to order a single entry against", () => {
    expect(restampJournal(journalOf([1788711006175]), 1)).toBeNull();
  });

  // Only the one number moves. A stamper that also reformatted, reordered or
  // renumbered would be a stamper nobody could review the diff of.
  it("changes the newest `when` and nothing else whatsoever", () => {
    const before = journalOf([100, 1789300000000, 5]);
    const after = restampJournal(before, 5)!;
    expect(after).toBe(before.replace('"when": 5,', '"when": 1789300000001,'));
  });

  // The corrected file satisfies the very predicate db/schema.test.ts pins, so
  // the fix and the net cannot disagree about what "correct" means.
  it("produces a journal the strictly-increasing check accepts", () => {
    const whens = whensOf(restampJournal(journalOf([100, 1789300000000, 5]), 5)!);
    expect(whens.filter((when, i) => i > 0 && when <= whens[i - 1]!)).toEqual([]);
  });

  /**
   * AND IT REFUSES RATHER THAN REFORMATTING, which is the failure this would
   * otherwise have. The rewrite is `JSON.stringify(journal, null, 2)`, so if a
   * future drizzle-kit writes the file any other way -- tabs, a trailing
   * newline, a key order of its own -- running this would silently reformat
   * every line of a file drizzle-kit owns and bury the one real change.
   */
  it("refuses a journal whose formatting is not the one it would write back", () => {
    expect(() => restampJournal(JSON.stringify(JSON.parse(journalOf([1, 2]))), 3))
      .toThrow(/formatting/);
  });

  // ...and that guard is not vacuous, because the file drizzle-kit actually
  // wrote in this repository round-trips through it byte for byte. If this goes
  // red, drizzle-kit changed how it writes the journal and the check above is
  // what will have stopped the damage.
  it("accepts the real journal drizzle-kit wrote in this repository", () => {
    const real = readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8");
    expect(() => restampJournal(real, Date.now())).not.toThrow();
  });

  /**
   * WHAT `drizzle-kit generate` WOULD DO TO THIS REPOSITORY TODAY, against the
   * real journal rather than a fixture.
   *
   * BRANCHED ON THE CLOCK, AND NOT TO BE TIDIED INTO ONE ASSERTION: the trap is
   * live only while the clock is behind the last hand-set value (0020, at
   * 2026-09-13T11:46:40Z). Pinning "the trap is live" would make this case a
   * time bomb that goes red on that date for being FIXED. Both eras are asserted
   * so the case keeps its meaning across the changeover instead of being deleted
   * at it -- and the second branch is what proves the arrangement heals itself.
   */
  it("lifts what drizzle-kit would append today, and stops once the clock passes", () => {
    const real = JSON.parse(
      readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8"),
    ) as { entries: { when: number }[] };
    const newest = Math.max(...real.entries.map((entry) => entry.when));
    const now = Date.now();
    const appended = journalOf([...real.entries.map((entry) => entry.when), now]);

    if (newest >= now) {
      expect(whensOf(restampJournal(appended, now)!).at(-1)).toBe(newest + 1);
    } else {
      expect(restampJournal(appended, now)).toBeNull();
    }
  });
});
