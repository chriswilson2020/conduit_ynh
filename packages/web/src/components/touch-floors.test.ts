import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../test/source";

/**
 * TWO 44px FLOORS THAT LIVE ON PAGE COMPONENTS RATHER THAN IN components/ui.
 *
 * ui/ui.test.ts holds the floor for the six primitives every page composes,
 * and its comment says plainly that it is "the one place the floor can be
 * asserted rather than chased around the pages". These two are not built from
 * those primitives -- an autocomplete row is a bare <button> and the rail's
 * download is a bare <a> -- so they carry their own, and neither had any unit
 * check at all. They were the last two entries on Phase 6's findings list and
 * they are fixed together here, so they are guarded together here.
 *
 * These match a SPELLING, not a behaviour: the rendering is Task 3's
 * phone-viewport e2e, and the numbers in the comments beside each subject were
 * measured in a real Chromium at 390x664. Comments are stripped first, because
 * both rules are explained in prose beside the class strings they are about.
 */

const read = (path: string) =>
  withoutComments(readFileSync(new URL(path, import.meta.url), "utf8"));

/**
 * Every class named between two markers, as a LIST OF CLASS NAMES.
 *
 * SCOPED TO ONE ELEMENT BY AN EXPLICIT END MARKER rather than to a file, which
 * is the lesson gantt/phone.test.ts paid for -- and rather than to "the next
 * `>`", which is the hazard that file records: an arrow function in a later
 * attribute contains one. Both ends are asserted to exist, so a rename that
 * silently emptied the slice fails loudly instead of guarding nothing.
 *
 * A LIST, not a substring search over the slice: `max-md:min-h-11` contains
 * `min-h-11`, and the whole value of the desktop half of each assertion below
 * is being able to tell those two apart.
 *
 * It collects EVERY double-quoted literal in the slice, because one of the two
 * subjects composes its classes through clsx() across several of them.
 */
function classesBetween(source: string, marker: string, endMarker: string): string[] {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, at);
  expect(end, `end marker not found after ${marker}: ${endMarker}`).toBeGreaterThan(at);
  return [...source.slice(at, end).matchAll(/"([^"]*)"/g)]
    .flatMap((match) => (match[1] ?? "").split(/\s+/))
    .filter(Boolean);
}

describe("the 44px floor on the two controls Phase 6 left under it", () => {
  /**
   * THE COMPOSER'S RECIPIENT SUGGESTIONS. Measured at 390x664: 36px in the
   * one-line shape, which is the number the finding named, and 52px for a
   * contact with a resolvable name (the address renders as a second line).
   * The floor lifts the first to 44 and leaves the second alone.
   *
   * BOTH HALVES. `max-md:min-h-11` on its own would leave a one-line label
   * pinned to the top of a 44px box; the flex column is what centres it, the
   * same pairing ui/select.tsx's SelectItem carries. And `max-md:` is the
   * point -- this dropdown is the desktop composer's too, and growing its rows
   * at a desk is the one thing the responsive work may not do.
   */
  it("floors a recipient suggestion below the breakpoint and nowhere else", () => {
    const classes = classesBetween(
      read("./mail/composer.tsx"), 'data-testid="composer-suggestion"', "onMouseDown",
    );
    expect(classes).toContain("max-md:min-h-11");
    expect(classes).toContain("max-md:flex");
    expect(classes).toContain("max-md:flex-col");
    expect(classes).toContain("max-md:justify-center");
    expect(classes).not.toContain("min-h-11");
  });

  /**
   * THE RECORD RAIL'S DOWNLOAD LINK, which has never had the floor and is the
   * only way to get a file back out of the rail. Measured at 64.5 x 17px.
   *
   * BOTH AXES, because the width is content: 64.5px is what one nine-character
   * filename happens to measure and a shorter name would be under the floor on
   * its own. The `inline-flex` is load-bearing rather than decorative -- an
   * inline box ignores a height floor entirely -- so it is asserted too.
   */
  it("floors the rail's download link on both axes, below the breakpoint only", () => {
    const classes = classesBetween(read("./rail/files.tsx"), "/download`)}", "{file.originalName}");
    expect(classes).toContain("inline-flex");
    expect(classes).toContain("max-md:min-h-11");
    expect(classes).toContain("max-md:min-w-11");
    expect(classes).not.toContain("min-h-11");
    expect(classes).not.toContain("min-w-11");
  });
});
