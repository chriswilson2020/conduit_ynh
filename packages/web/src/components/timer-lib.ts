import { MAX_TIME_ENTRY_MINUTES, timerElapsedMinutes, timerProposedMinutes } from "@conduit/shared";
import type { RunningTimer, TimerStopInput } from "@conduit/shared";
import { ApiError } from "../api";
import type { BuildResult } from "../pages/timesheet-lib";

/**
 * The timer strip's pure half (Phase 10 Task 5).
 *
 * `timesheet-lib.ts`'s split and its reason: this package's vitest environment
 * is `node` and the repo has no testing-library, so anything left in the .tsx is
 * only ever exercised by Playwright. What a half-filled stop form may be
 * submitted as, what a refusal means in words, and where the hours are about to
 * land are all decisions, and all of them are here.
 *
 * **WHAT IS DELIBERATELY NOT HERE: THE SENTENCE ABOUT THE CLOCK.**
 * `timerSummary` (@conduit/shared) composes it, and the strip renders it. It has
 * to be one string for `timesheetSummary`'s reason -- the elapsed figure and
 * "nothing is counted until you stop it" travel together, so a strip cannot show
 * a stopwatch without saying what it is and is not. `timer-render.test.ts` reads
 * the component off disk and fails if it starts spelling any part of it.
 */

/**
 * How often the strip re-reads the clock.
 *
 * ONE SECOND, and the display is only accurate to the minute -- which is the
 * point rather than a mismatch. The three things that change on this strip are
 * the elapsed figure (once a minute), the moment the proposal appears (crossing
 * one minute) and the moment it is withdrawn (crossing a day); a coarser tick
 * would put the first two of those up to that interval late, and this component
 * is a stopwatch, where lateness is the one thing a reader notices. It re-renders
 * one small subtree of the shell and nothing else.
 */
export const TIMER_TICK_MS = 1_000;

/**
 * What the strip calls the timer.
 *
 * The operator's own words if they wrote any; otherwise the first record it is
 * booked to, which is the only other true thing to say about it. `rowLabel`'s
 * rule on the timesheet, and its em-dash last resort -- a running timer with no
 * description and no resolvable label is not reachable through the product (the
 * links are required and are resolved server-side) and is handled anyway, because
 * a helper that is wrong on an input its caller happens not to send is a trap for
 * the caller that eventually does.
 */
export function timerLabel(timer: RunningTimer): string {
  if (timer.description !== null && timer.description !== "") return timer.description;
  return timer.links[0]?.label ?? "—";
}

/**
 * Where the hours are about to go, in words, on the screen where they are
 * committed.
 *
 * **THIS IS THE HALF OF THE RECOVERY INTERACTION THE SENTENCE ABOUT THE CLOCK
 * DOES NOT CARRY, AND IT IS THE SURPRISE.** A timer left running since Friday
 * books FRIDAY, not today -- the day comes off `started_at`, which is the only
 * instant the timer has (@conduit/shared's `runningTimerSchema`). An operator
 * stopping it on Monday morning who was not told that would find their hours in
 * last week, in a total they had already read.
 *
 * "the day the timer started" is in the string rather than left implicit,
 * because the date on its own reads as a mistake in exactly the case where it is
 * most important that it does not.
 */
export function timerLandingSentence(workDate: string): string {
  // Formatted the way the timesheet's own day headings are, and via UTC
  // deliberately: `new Date("2026-09-04")` is UTC midnight, and formatting it in
  // any other zone can move it a day -- the class of bug `work_date` is a `date`
  // to avoid (`dayHeading`, pages/timesheet-lib.ts).
  const day = new Date(`${workDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
  });
  return `These hours will be logged to ${day}, the day the timer started.`;
}

/**
 * The stop form's own state, as strings, because that is what inputs hold.
 *
 * `billable` IS `null` UNTIL SOMEBODY ANSWERS IT, `TimeEntryDraft`'s arrangement
 * and its reason, inherited without change: the column has no DEFAULT and the
 * wire schema requires it, so a pre-ticked checkbox here would put the guess back
 * one layer further out, where the database's refusal cannot reach it. A timer
 * knows how long it ran; it has never known whether the work was chargeable.
 */
export interface TimerStopDraft {
  minutes: string;
  billable: boolean | null;
  description: string;
}

/**
 * **THE DEFAULT, WHICH IS THE QUESTION THE SPEC ASKS BY NAME.**
 *
 * The clock's figure when it is one an entry could hold, and NOTHING when it is
 * not -- `timerProposedMinutes` withholds it under a minute and over a day, and
 * this is that decision reaching the form. So:
 *
 *   AN ORDINARY STOP is one tap: the box is filled with what the clock measured
 *   and Save is the whole interaction.
 *
 *   **THE 62-HOUR WEEKEND OPENS WITH AN EMPTY BOX.** There is no default,
 *   because there is no legal figure to default to -- and that is the honest
 *   shape rather than an obstacle. A form that pre-filled 1440 would be proposing
 *   a full day nobody worked, which is worse than asking, because a proposal is
 *   what gets accepted without reading.
 *
 *   A MIS-TAP THAT RAN FOR NINE SECONDS opens empty for the same reason, from
 *   the same rule: nought is not a storable number of minutes either.
 *
 * The description starts as the timer's own, so an operator who wrote what they
 * were starting does not type it again -- and can correct it, because the moment
 * the work finishes is the moment they actually know what it was.
 */
export function timerStopDraft(timer: RunningTimer, now: Date = new Date()): TimerStopDraft {
  const proposed = timerProposedMinutes(timerElapsedMinutes(new Date(timer.startedAt), now));
  return {
    minutes: proposed === null ? "" : String(proposed),
    billable: null,
    description: timer.description ?? "",
  };
}

/**
 * What the stop form may be sent as -- and every refusal here is one the server
 * would have made anyway, in words the operator can act on.
 *
 * `buildTimeEntryInput`'s shape one form over, minus the day and the links: the
 * day is the server's (it comes off `started_at`) and the links are the timer's.
 * The bounds are the SHARED ones, never numbers typed into a page, so a literal
 * cannot go on accepting the old value the day the constant moves.
 */
export function buildTimerStopInput(draft: TimerStopDraft): BuildResult<TimerStopInput> {
  const minutes = Number(draft.minutes.trim());
  if (draft.minutes.trim() === "" || !Number.isInteger(minutes) || minutes <= 0) {
    return { ok: false, error: "How many minutes did you actually work? A whole number above nought." };
  }
  if (minutes > MAX_TIME_ENTRY_MINUTES) {
    return {
      ok: false,
      // Named in hours as well, because 1440 read on its own looks like a typo
      // rather than a bound -- and this is the message the forgotten weekend
      // meets if the operator types the elapsed figure in by hand.
      error: `One entry cannot be longer than a day (${String(MAX_TIME_ENTRY_MINUTES)} minutes). `
        + "Log what you actually worked, or discard the timer.",
    };
  }
  if (draft.billable === null) {
    return { ok: false, error: "Say whether this time is billable." };
  }
  return {
    ok: true,
    input: {
      minutes,
      billable: draft.billable,
      // Blank -> null, never "": the service trims and nulls a whitespace-only
      // one anyway, and doing it here means the request the page sends is the
      // one the row will hold (`buildTimeEntryInput`'s rule).
      description: draft.description.trim() === "" ? null : draft.description.trim(),
    },
  };
}

/**
 * What went wrong, in words about a clock rather than about a table.
 *
 * **THE TWO 409s ARE THE INTERESTING ONES AND THEY ARE DIFFERENT ACTIONS**, which
 * is why this cannot be one sentence about conflicts: a start refused because a
 * timer is already running is answered by stopping that one, and a stop refused
 * because the timer has already finished is answered by looking at whether it
 * logged anything. The server distinguishes them only in prose, so the page has
 * to know which call it made -- hence the `action` parameter rather than a
 * single message keyed on the code.
 */
export function timerErrorMessage(error: unknown, action: "start" | "stop" | "discard"): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "conflict":
        return action === "start"
          ? "A timer is already running. Stop or discard it before starting another — "
            + "reload if you cannot see it."
          : "This timer has already been stopped, probably somewhere else. "
            + "Reload to see whether it logged any time.";
      case "not_found":
        return "This timer, or the record it names, could not be found. Reload to see the "
          + "current state.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
