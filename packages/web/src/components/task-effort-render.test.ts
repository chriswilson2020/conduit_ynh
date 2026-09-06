import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_TASK_ESTIMATE_MINUTES, taskEffortSummary } from "@conduit/shared";
import { withoutComments, withoutImports } from "../test/source";

/**
 * **THE ONE PLACE BOOKED-VERSUS-ESTIMATED IS SHOWN TO A PERSON, AND THE GUARD
 * THAT IT IS STILL A DERIVED SENTENCE.**
 *
 * Phase 10 Task 3 gave `tasks` an estimate. The comparison it makes possible is
 * only useful as a WHOLE: "5h booked" on a task estimated at two hours is a
 * number that is wrong without looking wrong, and a card that renders the booked
 * figure and quietly drops the estimate is the failure the spec names, arriving
 * on the surface instead of in the query. So `taskEffortSummary`
 * (@conduit/shared) composes the booked total, the estimate and the gap into ONE
 * string, and this drawer renders that string and computes nothing.
 *
 * **THIS FILE EXISTS BECAUSE THAT RULE LIVES IN JSX AND HAS NO OTHER CHECK.**
 * There is no testing-library in this repo, so a source guard is the only
 * unit-level thing that can see a page typing out what it should have derived.
 * `settings-data-lib.test.ts` is the precedent and it earned it: Task 1 measured
 * that reverting the Settings sentence to its stale version survived the ENTIRE
 * suite, and this is the same hazard on a smaller card.
 *
 * Comments are stripped first, because the rules below get NAMED in prose right
 * beside the code they are about -- a guard that goes red because someone
 * explained the reasoning would be worse than no guard. Imports are stripped too,
 * so "uses `taskEffortSummary`" means USES rather than merely has in scope; this
 * repo has no linter and no `noUnusedLocals`, so an import with the call deleted
 * compiles, ships, and satisfies any check that searches the whole file.
 */
const DRAWER = withoutImports(
  withoutComments(readFileSync(new URL("./task-drawer.tsx", import.meta.url), "utf8")),
);

describe("the task drawer's booked-versus-estimated line", () => {
  it("renders the shared sentence rather than composing one of its own", () => {
    expect(DRAWER).toContain("taskEffortSummary(effort)");
  });

  /**
   * **THE MUTATION THIS FILE IS FOR**: somebody laying the two figures out side
   * by side in the card, which reads better right up to the moment the estimate
   * is dropped from the layout and the booked total goes on being printed alone.
   * Every fragment below is a piece of prose only `taskEffortSummary` is allowed
   * to produce; if the drawer starts spelling any of them, it has started
   * composing the comparison.
   */
  it("does not spell any part of the comparison itself", () => {
    for (const fragment of ["booked", "estimate of", "left.", "over.", "exactly on"]) {
      expect(
        DRAWER,
        `"${fragment}" is typed into the task drawer. The booked-versus-estimated `
        + "sentence is derived by taskEffortSummary (@conduit/shared) precisely so that a "
        + "card cannot print half of a comparison.",
      ).not.toContain(fragment);
    }
  });

  /**
   * AND IT DOES NOT DO THE ARITHMETIC EITHER. A page that subtracts one figure
   * from the other has reimplemented the gap, and it will disagree with the
   * sentence the day the wording of "over" and "left" changes.
   */
  it("does not compute the gap between the two figures", () => {
    expect(DRAWER).not.toMatch(/bookedMinutes\s*[-+]/);
    expect(DRAWER).not.toMatch(/[-+]\s*effort\.estimateMinutes/);
  });

  /**
   * THE CLAMP USES THE SHARED BOUND, not a number typed into the page. A literal
   * here would go on accepting 525600 on the day the constant moved, and the
   * operator would meet the difference as a 400 from a CHECK.
   */
  it("clamps the estimate input against the shared bound, not a typed-out number", () => {
    expect(DRAWER).toContain("MAX_TASK_ESTIMATE_MINUTES");
    expect(DRAWER).not.toContain("525600");
  });

  /**
   * THE PREMISE, so none of the absence assertions above can pass over an empty
   * or unrecognisable file: the fragments really are what the shared function
   * produces, and the file really is the drawer.
   */
  it("is guarding the real drawer against the real sentence", () => {
    expect(DRAWER).toContain("data-testid=\"task-effort\"");
    expect(DRAWER.length).toBeGreaterThan(5000);
    const sentence = taskEffortSummary({
      taskId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      estimateMinutes: 240, bookedMinutes: 90, entryCount: 2,
    });
    for (const fragment of ["booked", "estimate of", "left."]) {
      expect(sentence, fragment).toContain(fragment);
    }
    expect(MAX_TASK_ESTIMATE_MINUTES).toBe(525600);
  });
});
