import { describe, expect, it } from "vitest";
import { MAX_TIME_ENTRY_MINUTES } from "@conduit/shared";
import type { RunningTimer } from "@conduit/shared";
import { ApiError } from "../api";
import {
  buildTimerStopInput, timerErrorMessage, timerLabel, timerLandingSentence, timerStopDraft,
  TIMER_TICK_MS,
} from "./timer-lib";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const STARTED = "2026-09-04T07:00:00.000Z";

function timer(overrides: Partial<RunningTimer> = {}): RunningTimer {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    startedAt: STARTED,
    description: "Ingest rewrite",
    companyId: null, contactId: null, dealId: null, projectId: PROJECT, taskId: null,
    workDate: "2026-09-04",
    links: [{ kind: "project", id: PROJECT, label: "Rollout" }],
    createdAt: STARTED, updatedAt: STARTED,
    ...overrides,
  };
}

const after = (minutes: number) => new Date(new Date(STARTED).getTime() + minutes * 60_000);

describe("timerLabel", () => {
  it("prefers the operator's own words", () => {
    expect(timerLabel(timer())).toBe("Ingest rewrite");
  });

  it("falls back to the record the hours are booked to", () => {
    expect(timerLabel(timer({ description: null }))).toBe("Rollout");
    expect(timerLabel(timer({ description: "" }))).toBe("Rollout");
  });

  it("has an em dash for a timer with neither, which the product cannot produce", () => {
    expect(timerLabel(timer({ description: null, links: [] }))).toBe("—");
  });
});

describe("timerLandingSentence", () => {
  /**
   * **THE SURPRISE THE RECOVERY INTERACTION HAS TO REMOVE.** A timer left
   * running since Friday books FRIDAY, because the day comes off `started_at` --
   * so an operator stopping it on Monday would otherwise find their hours in last
   * week, inside a total they had already read and agreed with.
   */
  it("names the day and says which day it is", () => {
    const sentence = timerLandingSentence("2026-09-04");
    expect(sentence).toContain("Friday 4 September");
    expect(sentence).toContain("the day the timer started");
  });

  /**
   * VIA UTC, and this case is the reason. `new Date("2026-09-01")` is UTC
   * midnight; formatted in a zone behind it, that is the 31st of August. The day
   * is a bare `date` and must render as itself in every zone the browser can be
   * in -- the class of bug `work_date` is a `date` to avoid.
   */
  it("renders the stored day, not a day either side of it", () => {
    expect(timerLandingSentence("2026-01-01")).toContain("Thursday 1 January");
    expect(timerLandingSentence("2026-12-31")).toContain("Thursday 31 December");
  });

  /**
   * **AND IT MUST NOT DEPEND ON THE BROWSER'S OWN ZONE, WHICH IS AN ASSERTION
   * THE CASES ABOVE CANNOT MAKE.** Dropping `timeZone: "UTC"` from the formatter
   * SURVIVED mutation testing, because `new Date("2026-09-04")` is UTC MIDNIGHT
   * and every machine this suite runs on sits at or ahead of UTC — so the day
   * only slips in a zone BEHIND it, and neither the dev server nor CI is one.
   *
   * Measured: at Pacific/Niue (UTC−11) the unpinned formatter renders
   * "Thursday 3 September" for the stored day `2026-09-04`. That is the class of
   * bug `work_date` is a `date` to avoid, arriving on the one screen where the
   * operator is being told which day their hours are about to land on — so it is
   * driven from both ends of the range rather than from the runner's zone.
   */
  it("renders the same day in a zone fourteen hours ahead and one eleven behind", () => {
    const original = process.env.TZ;
    try {
      const rendered = new Set<string>();
      for (const zone of ["Pacific/Kiritimati", "UTC", "Pacific/Niue"]) {
        process.env.TZ = zone;
        rendered.add(timerLandingSentence("2026-09-04"));
      }
      expect([...rendered]).toEqual([expect.stringContaining("Friday 4 September")]);
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("timerStopDraft", () => {
  /**
   * **THE DEFAULT, WHICH IS THE QUESTION THE SPEC ASKS BY NAME.** The clock's
   * figure when an entry could hold it, and NOTHING when it could not.
   */
  it("proposes the elapsed figure for an ordinary stop", () => {
    expect(timerStopDraft(timer(), after(95)).minutes).toBe("95");
    expect(timerStopDraft(timer(), after(MAX_TIME_ENTRY_MINUTES)).minutes)
      .toBe(String(MAX_TIME_ENTRY_MINUTES));
  });

  /**
   * **THE 62-HOUR WEEKEND OPENS WITH AN EMPTY BOX**, and that is the honest
   * shape rather than an obstacle: there is no legal figure to default to. A form
   * pre-filled with 1440 would be proposing a full day nobody worked, and a
   * proposal is what gets accepted without reading.
   */
  it("proposes nothing at all once the clock's answer could not be an entry", () => {
    expect(timerStopDraft(timer(), after(62 * 60)).minutes).toBe("");
    expect(timerStopDraft(timer(), after(MAX_TIME_ENTRY_MINUTES + 1)).minutes).toBe("");
    // The same rule at the other end: a mis-tap that ran for nine seconds has
    // produced nothing either, and nought is not a storable number of minutes.
    expect(timerStopDraft(timer(), after(0)).minutes).toBe("");
  });

  // NEVER PRE-TICKED. `time_entries.billable` has no DEFAULT and the wire schema
  // requires it, both deliberately -- a timer knows how long it ran and has never
  // known whether the work was chargeable.
  it("has no answer for billable", () => {
    expect(timerStopDraft(timer(), after(95)).billable).toBeNull();
  });

  it("carries the timer's own words forward, and copes with a timer that had none", () => {
    expect(timerStopDraft(timer(), after(95)).description).toBe("Ingest rewrite");
    expect(timerStopDraft(timer({ description: null }), after(95)).description).toBe("");
  });
});

describe("buildTimerStopInput", () => {
  const draft = { minutes: "95", billable: true, description: "Ingest rewrite" };

  it("sends the minutes, the flag and the words", () => {
    const built = buildTimerStopInput(draft);
    expect(built).toEqual({
      ok: true, input: { minutes: 95, billable: true, description: "Ingest rewrite" },
    });
  });

  it("refuses a stop that states no duration", () => {
    for (const minutes of ["", "   ", "0", "-5", "1.5", "abc"]) {
      const built = buildTimerStopInput({ ...draft, minutes });
      expect(built.ok, minutes).toBe(false);
      if (!built.ok) expect(built.error).toMatch(/actually work/);
    }
  });

  /**
   * **THE WEEKEND TYPED IN BY HAND.** The empty box is a prompt, not a lock, so
   * an operator can still type 3720 -- and the refusal has to say what to do
   * instead rather than merely that the number is too big. Both ways out are in
   * the message, which is `timerSummary`'s rule at the second surface.
   */
  it("refuses a figure longer than one entry can hold, and names both ways out", () => {
    const built = buildTimerStopInput({ ...draft, minutes: String(62 * 60) });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error).toContain(String(MAX_TIME_ENTRY_MINUTES));
      expect(built.error).toMatch(/actually worked/);
      expect(built.error).toMatch(/discard/);
    }
    // The exact edge: a day is legal and a day plus a minute is not.
    expect(buildTimerStopInput({ ...draft, minutes: String(MAX_TIME_ENTRY_MINUTES) }).ok).toBe(true);
    expect(buildTimerStopInput({ ...draft, minutes: String(MAX_TIME_ENTRY_MINUTES + 1) }).ok)
      .toBe(false);
  });

  it("refuses a stop that has not answered billable", () => {
    const built = buildTimerStopInput({ ...draft, billable: null });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toMatch(/billable/);
  });

  it("sends a blank description as null rather than as an empty string", () => {
    const built = buildTimerStopInput({ ...draft, description: "   " });
    expect(built.ok && built.input.description).toBeNull();
  });
});

describe("timerErrorMessage", () => {
  /**
   * **THE TWO 409s ARE DIFFERENT ACTIONS AND MUST READ DIFFERENTLY.** A start
   * refused because a timer is already running is answered by stopping that one;
   * a stop refused because the timer has already finished is answered by looking
   * at whether it logged anything. The server tells them apart only in prose, so
   * the page has to know which call it made.
   */
  it("says something different about a conflict on a start and on a stop", () => {
    const conflict = new ApiError("a timer is already running (abc)", 409, "conflict");
    expect(timerErrorMessage(conflict, "start")).toMatch(/already running/);
    expect(timerErrorMessage(conflict, "start")).toMatch(/Stop or discard/);
    expect(timerErrorMessage(conflict, "stop")).toMatch(/already been stopped/);
    expect(timerErrorMessage(conflict, "stop")).toMatch(/logged any time/);
    expect(timerErrorMessage(conflict, "stop")).not.toMatch(/already running/);
  });

  it("explains a 404 as something to reload rather than to retry", () => {
    const missing = new ApiError("timer abc not found", 404, "not_found");
    expect(timerErrorMessage(missing, "stop")).toMatch(/Reload/);
  });

  it("passes anything else through in the words it arrived in", () => {
    expect(timerErrorMessage(new ApiError("boom", 500, "internal"), "start")).toBe("boom");
    expect(timerErrorMessage(new Error("network down"), "start")).toBe("network down");
    expect(timerErrorMessage("odd", "start")).toBe("odd");
  });
});

describe("TIMER_TICK_MS", () => {
  // A SECOND, and the strip only shows minutes -- which is the point rather than
  // a mismatch: the moment the proposal appears (crossing one minute) and the
  // moment it is withdrawn (crossing a day) would otherwise be up to a tick late
  // on a component whose whole job is being a stopwatch.
  it("re-reads the clock every second", () => {
    expect(TIMER_TICK_MS).toBe(1_000);
  });
});
