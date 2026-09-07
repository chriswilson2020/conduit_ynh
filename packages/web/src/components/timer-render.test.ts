import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_TIME_ENTRY_MINUTES, timerSummary } from "@conduit/shared";
import { withoutComments, withoutImports } from "../test/source";

/**
 * **THE STRIP RENDERS THE SENTENCE AND COMPOSES NOTHING (Phase 10 Task 5).**
 *
 * `timesheet-render.test.ts`'s shape, at the surface where the same mistake is
 * likelier: a strip is small and a stopwatch is the obvious thing to put on one.
 * `timerSummary` (@conduit/shared) carries three things in one string -- how long
 * it has run, whether that figure can be logged, and that nothing is counted
 * until it stops -- and a strip that printed only the first would be showing a
 * number with no statement of what it is, and past a day a number the database
 * will refuse.
 *
 * **THE MUTATION THIS FILE IS FOR** is a designer's improvement: `2h 06m` in a
 * nice monospace pill with the awkward clause dropped, which reads better and is
 * exactly the failure the spec names -- "the recovery interaction is most of the
 * feature", and it lives in that clause.
 *
 * **WHAT THIS CANNOT SEE**, said plainly rather than left to be discovered: it
 * matches SPELLINGS. A component that composed the sentence out of variables, or
 * through a helper in another file, would slip past. It guards the likely
 * mistake, not a determined one; the e2e journey is what asserts the words reach
 * a screen.
 *
 * Comments are stripped first, because every rule below gets named in prose
 * beside the code it is about; imports are stripped too, so "uses `timerSummary`"
 * means USES rather than merely has in scope -- this repo has no linter and no
 * `noUnusedLocals`, so an import whose call was deleted still compiles.
 */
const STRIP = withoutImports(
  withoutComments(readFileSync(new URL("./timer-strip.tsx", import.meta.url), "utf8")),
);
const LIB = withoutImports(
  withoutComments(readFileSync(new URL("./timer-lib.ts", import.meta.url), "utf8")),
);
const SHELL = withoutImports(
  withoutComments(readFileSync(new URL("./shell.tsx", import.meta.url), "utf8")),
);

describe("the running timer's strip", () => {
  it("renders the shared sentence rather than composing one of its own", () => {
    expect(STRIP).toContain("timerSummary(timer, now)");
  });

  /**
   * **NEVER THE RAW STOPWATCH.** `formatMinutes` on the elapsed figure IS the
   * mutation: it produces "2h 6m", which is most of what the sentence says and
   * none of what makes it honest. `timerElapsedMinutes` and
   * `timerProposedMinutes` are equally out of bounds here -- the first is the
   * figure and the second is the decision about it, and both belong to
   * `timerSummary` on this surface. (The stop FORM legitimately calls the second,
   * through `timerStopDraft` in the lib, which is why that assertion is on the
   * strip alone.)
   */
  it("never derives a duration of its own", () => {
    for (const spelling of ["formatMinutes", "timerElapsedMinutes", "timerProposedMinutes"]) {
      expect(
        STRIP,
        `"${spelling}" is used in the timer strip. The elapsed figure, whether it can be `
        + "logged, and the fact that nothing is counted until the timer stops are one string "
        + "from timerSummary (@conduit/shared) precisely so a strip cannot show the stopwatch "
        + "without them.",
      ).not.toContain(spelling);
    }
  });

  /**
   * AND IT DOES NOT SPELL ANY CLAUSE OF THE SENTENCE. Each fragment below is
   * prose only `timerSummary` is allowed to produce; a strip that starts typing
   * one has started composing the claim.
   */
  it("does not type out any clause of the sentence", () => {
    for (const fragment of [
      "Running for", "nothing is counted", "less than a minute", "at least one minute",
      "longer than the", "actually worked",
    ]) {
      expect(STRIP, `"${fragment}" is typed into the timer strip`).not.toContain(fragment);
    }
  });

  /**
   * THE BOUND IS THE SHARED CONSTANT, never a number typed into a form.
   * `task-effort-render.test.ts`'s rule and `timesheet-render.test.ts`'s: a
   * literal goes on accepting the old value the day the constant moves, and the
   * operator meets the difference as a 400 out of a CHECK.
   */
  it("clamps the stop form against the shared bound rather than a typed-out number", () => {
    expect(LIB).toContain("MAX_TIME_ENTRY_MINUTES");
    expect(LIB).not.toContain("1440");
    expect(STRIP).not.toContain("1440");
  });

  /**
   * **THE STRIP IS IN THE SHELL, WHICH IS THE PLACEMENT DECISION AS A TEST.**
   * The spec's second risk is "you left this running for 62 hours", and a timer
   * visible only on /timesheet is a timer that is always left running. Moving it
   * onto the page would be a one-line change with no other symptom, so it is
   * asserted here.
   *
   * OUTSIDE `<main>` as well: a strip inside the scroll region scrolls away with
   * the content, on the one surface whose whole job is to be seen while the
   * operator is looking at something else.
   */
  it("is rendered once by the shell, above the content rather than inside it", () => {
    expect(SHELL).toContain("<TimerStrip />");
    expect(SHELL.match(/<TimerStrip\b/g) ?? []).toHaveLength(1);
    const strip = SHELL.indexOf("<TimerStrip />");
    const main = SHELL.indexOf("<main");
    expect(main).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(main);
  });

  /**
   * **THE RECOVERY'S OWN TWO CONTROLS.** Discard has to be beside Save, because
   * the other honest answer to a timer that ran all weekend is that it represents
   * no work -- and without it the only way to clear the strip is to invent a
   * number, which afterwards is indistinguishable from a real hour. "Keep
   * running" is the third: closing the dialog must leave the clock exactly where
   * it was, which is what makes "what if they ignore it" answerable.
   */
  it("offers discard and keep-running beside the save", () => {
    expect(STRIP).toContain("data-testid=\"timer-discard\"");
    expect(STRIP).toContain("data-testid=\"timer-cancel\"");
    expect(STRIP).toContain("data-testid=\"timer-save\"");
    // The day the hours will land on is stated before anything is committed --
    // the recovery's actual surprise, and derived rather than typed.
    expect(STRIP).toContain("timerLandingSentence(timer.workDate)");
    expect(STRIP).not.toContain("the day the timer started");
  });

  /**
   * BILLABLE IS ASKED, NEVER PRE-TICKED, `TimeEntryDialog`'s rule inherited: the
   * column has no DEFAULT and both values are ordinary, so a default here would
   * put the guess back one layer out where the database's refusal cannot reach
   * it. `checked={draft.billable === value}` over a `boolean | null` is the
   * spelling that leaves both radios clear until somebody answers.
   */
  it("asks whether the time is billable rather than assuming", () => {
    expect(STRIP).toContain("checked={draft.billable === value}");
    expect(LIB).toContain("billable: null");
    expect(STRIP).not.toMatch(/billable:\s*(true|false)/);
  });

  /**
   * THE PREMISE, so none of the absence assertions above can pass over an empty
   * or unrecognisable file: the fragments really are what `timerSummary`
   * produces, and the file really is the strip.
   */
  it("is guarding the real strip against the real sentence", () => {
    expect(STRIP).toContain("data-testid=\"timer-strip\"");
    expect(STRIP).toContain("data-testid=\"timer-summary\"");
    expect(STRIP.length).toBeGreaterThan(3000);
    const timer = {
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      startedAt: "2026-09-04T07:00:00.000Z",
      description: "Ingest rewrite",
      companyId: null, contactId: null, dealId: null,
      projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", taskId: null,
      workDate: "2026-09-04",
      links: [{ kind: "project" as const, id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", label: "Rollout" }],
      createdAt: "2026-09-04T07:00:00.000Z", updatedAt: "2026-09-04T07:00:00.000Z",
    };
    const at = (minutes: number) => new Date(new Date(timer.startedAt).getTime() + minutes * 60_000);
    for (const fragment of ["Running for", "nothing is counted"]) {
      expect(timerSummary(timer, at(126)), fragment).toContain(fragment);
    }
    expect(timerSummary(timer, at(0))).toContain("less than a minute");
    expect(timerSummary(timer, at(MAX_TIME_ENTRY_MINUTES + 1))).toContain("actually worked");
  });
});
