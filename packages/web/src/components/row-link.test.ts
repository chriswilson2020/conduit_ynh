import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../test/source";
import { ROW_LINK, ROW_LINK_ROW } from "./row-link";

/**
 * THE TWO HALVES OF A ROW LINK, PINNED SEPARATELY, because each one fails
 * silently and differently when the other is dropped.
 *
 * `ROW_LINK` puts an absolutely positioned overlay on the anchor and
 * `ROW_LINK_ROW` is what the overlay is positioned AGAINST. Delete the row
 * half and the overlay does not disappear: with no positioned ancestor left it
 * resolves against the INITIAL CONTAINING BLOCK, so `inset-0` becomes the
 * whole viewport.
 *
 * MEASURED, in a real Chromium at 1280 with the row's `position` set to
 * `static` and nothing else changed: the page heading, the Filter field and
 * the sidebar all report the last row's anchor as the element under them.
 * Every control on the page would navigate to that record. And the page still
 * LOOKS right -- a full-page screenshot of the broken build differs from a
 * correct one by a handful of pixels on the antialiasing of one rounded
 * corner. No type is wrong either. That combination -- catastrophic, silent,
 * invisible -- is exactly the shape of defect a source guard is for.
 *
 * This repo has no testing-library, so a rule that lives in JSX has no other
 * unit-level check at all: these match a SPELLING, and the behaviour they
 * stand in for is the keyboard journey in e2e. Comments are stripped first,
 * because both subjects are explained in prose beside the code they are about.
 */

const read = (path: string) =>
  withoutComments(readFileSync(new URL(path, import.meta.url), "utf8"));

/**
 * The source between two markers, with an explicit END marker rather than a
 * guess at where an element stops -- the lesson gantt/phone.test.ts paid for,
 * and the same shape touch-floors.test.ts uses. Both ends are asserted to
 * exist, so a rename that silently emptied the slice fails loudly instead of
 * guarding nothing.
 */
function between(source: string, marker: string, endMarker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, at);
  expect(end, `end marker not found after ${marker}: ${endMarker}`).toBeGreaterThan(at);
  return source.slice(at, end);
}

describe("the row link's two halves", () => {
  /**
   * EVERY UTILITY ON THE ANCHOR TARGETS THE PSEUDO-ELEMENT, which is the
   * property that keeps this an interaction fix rather than a redesign. The
   * anchor stays an ordinary inline box around the record's name and the cell
   * renders exactly as it did; drop the `after:` scope from either utility and
   * the NAME leaves the flow instead of the overlay covering the row.
   *
   * The row half is asserted to be positioned at all, since that is the whole
   * of its job.
   */
  it("positions only the overlay, never the anchor, and gives it something to sit in", () => {
    expect(ROW_LINK.split(" ").filter((cls) => !cls.startsWith("after:"))).toEqual([]);
    expect(ROW_LINK).toContain("inset-0");
    expect(ROW_LINK_ROW).toBe("relative");
  });

  /**
   * THE ENTITY TABLE'S ROW -- companies, contacts and projects share it.
   *
   * The absence of `onClick` is half the point. An anchor AND a handler on the
   * same row are two navigation paths, and a Cmd-click would take both: a new
   * tab opens and the current one moves too. The row had a handler and no
   * anchor before this; it must not end up with both.
   */
  it("positions the entity row and leaves it no click handler of its own", () => {
    const row = between(read("./entity-table.tsx"), "data-testid={`row-${row.id}`}", "{columns.map");
    expect(row).toContain("ROW_LINK_ROW");
    expect(row).not.toContain("onClick");
  });

  /**
   * MY TASKS' ROW, which is the same rule plus the one complication: it holds
   * a real control INSIDE the link's hit area.
   *
   * The done checkbox has to be lifted back out of the overlay, and `relative`
   * alone will not do it -- the overlay is a positioned box LATER in tree
   * order, so it paints over an equally-stacked sibling. The z-index is the
   * load-bearing half and is asserted as such.
   */
  it("positions the task row and lifts its checkbox above the overlay", () => {
    const source = read("../pages/my-tasks.tsx");
    const row = between(source, "data-testid={`task-row-${task.id}`}", "<input");
    expect(row).toContain("ROW_LINK_ROW");
    expect(row).not.toContain("onClick");

    // Sliced from the ROW, not from the file: `<input` on its own would find
    // whichever input happens to come first in a file this test does not own.
    const fromRow = source.slice(source.indexOf("data-testid={`task-row-${task.id}`}"));
    const checkbox = between(fromRow, "<input", "aria-label");
    expect(checkbox).toContain("relative");
    expect(checkbox).toContain("z-10");
    // The row has no handler left for a click on the box to escape into.
    expect(checkbox).not.toContain("stopPropagation");
  });

  /**
   * EVERY LIST THAT OPENS A RECORD USES THE SHARED CONSTANT rather than
   * retyping the run, which is the rule components/ui/touch.ts states: a class
   * string copied twice is a class string that will be edited once. Pipelines
   * is deliberately absent -- its anchor is already the full width of the row,
   * so it needs no overlay and says so in its own comment.
   */
  it("is imported by all three list pages rather than respelled", () => {
    for (const page of ["companies", "contacts", "projects"]) {
      const source = read(`../pages/${page}.tsx`);
      expect(source, page).toContain("ROW_LINK");
      expect(source, page).not.toContain("after:inset-0");
    }
  });
});
