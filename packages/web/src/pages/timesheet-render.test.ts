import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { timesheetBillableSummary, timesheetSummary } from "@conduit/shared";
import { withoutComments, withoutImports } from "../test/source";

/**
 * **THE GUARD THE PLAN WROTE FOR THIS TASK, TURNED INTO A TEST.**
 *
 * Task 2's instruction to Task 4 is a bullet, and it says why it is only a
 * bullet: *"RENDER `timesheetSummary`, NOT `countedMinutes`. The uncounted
 * meetings ... are in the same string as the figure precisely so that a page
 * cannot print the figure without them. Nothing tests a page that does not exist
 * yet: this bullet is the guard."*
 *
 * The page exists now, so the bullet stops being the guard and this file starts.
 * It is `settings-data-lib.test.ts`'s shape and it earned its place there: Task 1
 * MEASURED that reverting the export's derived sentence to a typed-out one
 * survived the entire suite, and an operator would have gone on being told their
 * timesheet was not in a file that contained it. The identical mutation here is
 * a page that prints `countedMinutes` and calls it the week's total, with the
 * uncounted meetings left off -- which is the failure the spec names by name.
 *
 * **WHAT THIS CANNOT SEE**, said plainly rather than left to be discovered: it
 * matches SPELLINGS. A page that composed the sentence out of variables, or
 * through a helper in another file, would slip past it. It guards against the
 * likely mistake -- somebody laying the numbers out in a nicer grid and dropping
 * the awkward clause -- not against a determined one. The e2e journey is what
 * asserts the rendered words reach a screen.
 *
 * Comments are stripped first, because every rule below gets NAMED in prose right
 * beside the code it is about, and a guard that went red because somebody
 * explained the reasoning would be worse than no guard. Imports are stripped too,
 * so "uses `timesheetSummary`" means USES rather than merely has in scope: this
 * repo has no linter and no `noUnusedLocals`, so an import whose call was deleted
 * still compiles and would still satisfy a whole-file search.
 */
const PAGE = withoutImports(
  withoutComments(readFileSync(new URL("./timesheet.tsx", import.meta.url), "utf8")),
);
const LIB = withoutImports(
  withoutComments(readFileSync(new URL("./timesheet-lib.ts", import.meta.url), "utf8")),
);

describe("the timesheet's headline", () => {
  it("renders the shared sentences rather than composing any of its own", () => {
    expect(PAGE).toContain("timesheetSummary(totals.data)");
    expect(PAGE).toContain("timesheetBillableSummary(totals.data)");
  });

  /**
   * **THE MUTATION THIS FILE IS FOR.** `countedMinutes` printed on its own, with
   * the uncounted meetings left in the payload for a layout that no longer has
   * room for them. The field is NAMED `countedMinutes` rather than `totalMinutes`
   * so that such a page reads as a lie in its own source -- and this is what
   * makes that more than a hope.
   */
  it("never reaches for a raw figure out of the totals", () => {
    // Nine names with no legitimate reading anywhere on this page: every one of
    // them is a clause of a sentence that must arrive whole.
    for (const field of [
      "entryMinutes", "meetingMinutes", "billableEntryMinutes",
      "meetingsUnmeasured", "meetingsNotYetOccurred", "meetingsCounted", "entryCount",
      "billableEntryCount", "meetingsInRange",
    ]) {
      expect(
        PAGE,
        `"${field}" is read in the timesheet page. Every figure in the headline is derived by `
        + "timesheetSummary / timesheetBillableSummary (@conduit/shared), precisely so that a page "
        + "cannot print a total without the meetings it could not count.",
      ).not.toContain(field);
    }
    // `countedMinutes` IS read, and legitimately: it is the field name on a DAY,
    // where the figure is the service's own sum over rows it could not truncate.
    // What must never happen is the WEEK's being read -- so the assertion is on
    // the access rather than on the word, and the destructuring form is named
    // separately because a bare property scan would not see it.
    expect(PAGE).toContain("day.countedMinutes");
    expect(PAGE).not.toContain("totals.data.countedMinutes");
    expect(PAGE).not.toMatch(/\{[^{}]*\bcountedMinutes\b[^{}]*\}\s*=\s*totals/);
  });

  /**
   * AND IT DOES NOT SPELL ANY PART OF EITHER SENTENCE. Each fragment below is
   * prose only the shared functions are allowed to produce; if the page starts
   * typing one, it has started composing the comparison.
   */
  it("does not type out any clause of either sentence", () => {
    for (const fragment of [
      "counted from", "across", "Not counted", "no recorded length", "has not happened yet",
      "logged by hand", "billable flag", "in neither figure",
    ]) {
      expect(PAGE, `"${fragment}" is typed into the timesheet page`).not.toContain(fragment);
    }
  });

  /**
   * **AND NEITHER THE PAGE NOR ITS LIB ADDS UP MINUTES.** This is the plan's
   * other rule and the one with a number attached: `listTimeEntries` caps at 100
   * rows, so a JavaScript sum over what a page was handed is right until somebody
   * logs 101 entries in a week and is then silently SHORT. Every figure -- the
   * week's and each DAY's -- is summed in SQL and arrives on the payload.
   */
  it("sums nothing, in the page or in its lib", () => {
    for (const [name, source] of [["page", PAGE], ["lib", LIB]] as const) {
      expect(source, `${name}: a reduce over rows is the page adding up minutes`)
        .not.toMatch(/\.reduce\(/);
      expect(source, `${name}: minutes are not added on the client`)
        .not.toMatch(/minutes\s*\+(?!\+)/);
    }
  });

  /**
   * THE BOUND IS THE SHARED CONSTANT, not a number typed into a form. A literal
   * would go on accepting the old value the day the constant moved, and the
   * operator would meet the difference as a 400 from a CHECK
   * (`task-effort-render.test.ts`'s rule at a bigger form).
   */
  it("clamps an entry against the shared bound rather than a typed-out number", () => {
    expect(LIB).toContain("MAX_TIME_ENTRY_MINUTES");
    expect(LIB).not.toContain("1440");
    expect(PAGE).not.toContain("1440");
  });

  /**
   * THE PREMISE, so none of the absence assertions above can pass over an empty
   * or unrecognisable file: the fragments really are what the shared functions
   * produce, and the file really is the timesheet.
   */
  it("is guarding the real page against the real sentences", () => {
    expect(PAGE).toContain("data-testid=\"timesheet\"");
    expect(PAGE).toContain("data-testid=\"counted-summary\"");
    expect(PAGE.length).toBeGreaterThan(5000);
    const totals = {
      from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
      entryMinutes: 300, entryCount: 4, billableEntryMinutes: 180, billableEntryCount: 2,
      meetingMinutes: 150, meetingsCounted: 3, meetingsUnmeasured: 2, meetingsNotYetOccurred: 1,
      meetingsInRange: 6, countedMinutes: 450,
    };
    for (const fragment of ["counted from", "Not counted", "no recorded length", "has not happened yet"]) {
      expect(timesheetSummary(totals), fragment).toContain(fragment);
    }
    for (const fragment of ["logged by hand", "billable flag", "in neither figure"]) {
      expect(timesheetBillableSummary(totals), fragment).toContain(fragment);
    }
  });
});
