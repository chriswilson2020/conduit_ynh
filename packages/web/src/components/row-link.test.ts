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
 * LOOKS right -- across ten full-page screenshots of the broken build (five
 * lists at 1280 and 390), seven are byte-identical to a correct one and the
 * other three differ in 24 pixels TOTAL, every one of them a single level out
 * of 255 on the antialiasing of a table's rounded corner. No type is wrong
 * either. That combination -- catastrophic, silent, invisible -- is exactly
 * the shape of defect a source guard is for.
 *
 * THE OTHER REASON THESE ARE HERE. Only two e2e tests click one of these rows,
 * both on companies (crm.spec.ts at 1280, mobile.spec.ts at 390), so most of
 * this pattern has no journey under it at all. e2e/row-links.spec.ts adds the
 * runtime half for the phone tap and the row's far edges; these are the half
 * that catches a deletion in a file no journey visits.
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
   * THE DRAG SUPPRESSION IS PART OF THE SAME OBJECT and is asserted here for
   * that reason. An anchor is natively draggable, so without it a row can be
   * dragged into another application as a URL -- a behaviour these rows never
   * had as `<tr>`s with a click handler. Measured: it takes the dragstart
   * count from 1 to 0. It does NOT recover the row's text selection, which the
   * module comment records in full. Bundling the two into one spread is what
   * makes them impossible to apply by halves.
   *
   * The row half is asserted to be positioned at all, since that is the whole
   * of its job.
   */
  it("positions only the overlay, never the anchor, and refuses the native drag", () => {
    expect(ROW_LINK.className.split(" ").filter((cls) => !cls.startsWith("after:"))).toEqual([]);
    expect(ROW_LINK.className).toContain("inset-0");
    expect(ROW_LINK.draggable).toBe(false);
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
   * MY TASKS' ROW, in THREE slices, and the third is the one this file was
   * missing. An earlier version stopped at the checkbox, which left the
   * `<Link>` past it unguarded: deleting the spread that stretches the overlay
   * left every test in this file green, and no journey touched a task row
   * either. The tap area on the list most likely to be used under a thumb was
   * protected by nothing at all.
   */
  it("positions the task row and stretches its link over it", () => {
    const source = read("../pages/my-tasks.tsx");

    const row = between(source, "data-testid={`task-row-${task.id}`}", "<input");
    expect(row).toContain("ROW_LINK_ROW");
    expect(row).not.toContain("onClick");

    // The anchor that the row's `relative` exists to serve. Sliced from the
    // row so `<Link` finds this one and not some later link in the file.
    const fromRow = source.slice(source.indexOf("data-testid={`task-row-${task.id}`}"));
    const link = between(fromRow, "<Link", "</Link>");
    expect(link).toContain("{...ROW_LINK}");
  });

  /**
   * THE ONE CONTROL THAT HAS TO STAY ABOVE THE OVERLAY.
   *
   * `relative` alone will not do it -- the overlay is a positioned box LATER in
   * tree order, so it paints over an equally-stacked sibling. The z-index is
   * the load-bearing half and is asserted as such. Measured with
   * elementFromPoint at the box's centre: as shipped it answers the INPUT, and
   * with the z-index alone taken off it answers the anchor.
   */
  it("lifts the task row's checkbox above the overlay", () => {
    const source = read("../pages/my-tasks.tsx");
    const fromRow = source.slice(source.indexOf("data-testid={`task-row-${task.id}`}"));
    const checkbox = between(fromRow, "<input", "aria-label");
    expect(checkbox).toContain("relative");
    expect(checkbox).toContain("z-10");
    // The row has no handler left for a click on the box to escape into.
    expect(checkbox).not.toContain("stopPropagation");
  });

  /**
   * EVERY LIST THAT OPENS A RECORD USES THE SHARED OBJECT rather than retyping
   * the run, which is the rule components/ui/touch.ts states: a class string
   * copied twice is a class string that will be edited once. The SPREAD is
   * asserted, not the name -- an import that is no longer applied to anything
   * is exactly the failure this is for.
   */
  it("is spread by all three list pages rather than respelled", () => {
    for (const page of ["companies", "contacts", "projects"]) {
      const source = read(`../pages/${page}.tsx`);
      expect(source, page).toContain("{...ROW_LINK}");
      expect(source, page).not.toContain("after:inset-0");
    }
  });

  /**
   * PIPELINES TAKES NO OVERLAY AND STILL TAKES THE DRAG SUPPRESSION.
   *
   * Its anchor is already the full width of the row, so it needs no ROW_LINK
   * -- but it replaced a `<button>`, and a button is not draggable while an
   * anchor is. Without this the row would have gained a link-drag it never
   * had, which is the one thing about this change that IS avoidable.
   */
  it("refuses the native drag on the pipelines row too", () => {
    // Ended on the link's CHILD, not on "the next `>`" -- that shortcut is the
    // hazard gantt/phone.test.ts records, since a later attribute can contain
    // one inside an arrow function.
    const link = between(read("../pages/pipelines.tsx"), "data-testid={`pipeline-row-", "{pipeline.name}");
    expect(link).toContain("draggable={false}");
  });
});
