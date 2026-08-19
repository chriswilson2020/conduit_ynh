import { describe, it, expect } from "vitest";
import type { GanttTask } from "@conduit/shared";
import {
  accumulateNudge, applyOffsetDays, clampOffsetDays, computeRange,
  dayIndexToIso, isoToDayIndex, MIN_RANGE_DAYS, RANGE_PAD_DAYS,
} from "./geometry";
import type { NudgeState } from "./geometry";

// A day-index/rangeStartMs pair used across several cases below -- an
// arbitrary UTC-midnight anchor, not "today", so these tests don't depend on
// the day they happen to run.
const RANGE_START_MS = Date.parse("2026-01-01T00:00:00Z");

function task(overrides: Partial<GanttTask>): GanttTask {
  return {
    id: "t1", title: "task", projectId: null, projectName: null, projectColor: null,
    parentTaskId: null, status: "todo", startDate: null, dueDate: null,
    ...overrides,
  } as unknown as GanttTask;
}

describe("isoToDayIndex / dayIndexToIso", () => {
  it("round-trips a plain date", () => {
    const iso = "2026-03-15";
    const idx = isoToDayIndex(iso, RANGE_START_MS);
    expect(dayIndexToIso(idx, RANGE_START_MS)).toBe(iso);
  });

  it("round-trips across a month boundary", () => {
    const iso = "2026-01-31";
    const idx = isoToDayIndex(iso, RANGE_START_MS);
    expect(dayIndexToIso(idx + 1, RANGE_START_MS)).toBe("2026-02-01");
  });

  it("round-trips across a year boundary", () => {
    const iso = "2026-12-31";
    const idx = isoToDayIndex(iso, RANGE_START_MS);
    expect(dayIndexToIso(idx + 1, RANGE_START_MS)).toBe("2027-01-01");
  });

  it("round-trips across a leap-year February boundary (2028 is a leap year)", () => {
    const iso = "2028-02-28";
    const idx = isoToDayIndex(iso, RANGE_START_MS);
    expect(dayIndexToIso(idx + 1, RANGE_START_MS)).toBe("2028-02-29");
    expect(dayIndexToIso(idx + 2, RANGE_START_MS)).toBe("2028-03-01");
  });

  it("does not add a leap day in a non-leap year (2026)", () => {
    const iso = "2026-02-28";
    const idx = isoToDayIndex(iso, RANGE_START_MS);
    expect(dayIndexToIso(idx + 1, RANGE_START_MS)).toBe("2026-03-01");
  });

  it("gives the range anchor itself index 0", () => {
    expect(isoToDayIndex("2026-01-01", RANGE_START_MS)).toBe(0);
  });
});

describe("clampOffsetDays / applyOffsetDays", () => {
  it("move: never clamps, applies the same delta to both dates", () => {
    expect(clampOffsetDays("move", 10, 15, -7)).toBe(-7);
    expect(applyOffsetDays("move", 10, 15, -7)).toEqual({ startDay: 3, dueDay: 8 });
  });

  it("resize-start: clamps at the due date so duration never goes below zero", () => {
    // origin duration is 5 days (10 -> 15); asking to push the start day 9
    // days later would overshoot past the due date.
    expect(clampOffsetDays("resize-start", 10, 15, 9)).toBe(5);
    expect(applyOffsetDays("resize-start", 10, 15, 5)).toEqual({ startDay: 15, dueDay: 15 });
  });

  it("resize-start: an earlier start (negative delta) is never clamped", () => {
    expect(clampOffsetDays("resize-start", 10, 15, -100)).toBe(-100);
  });

  it("resize-end: clamps at the start date so duration never goes below zero", () => {
    expect(clampOffsetDays("resize-end", 10, 15, -9)).toBe(-5);
    expect(applyOffsetDays("resize-end", 10, 15, -5)).toEqual({ startDay: 10, dueDay: 10 });
  });

  it("resize-end: a later due date (positive delta) is never clamped", () => {
    expect(clampOffsetDays("resize-end", 10, 15, 100)).toBe(100);
  });

  it("resize-start/resize-end on a same-day, zero-duration task clamp any move to zero", () => {
    expect(clampOffsetDays("resize-start", 20, 20, 3)).toBe(0);
    expect(clampOffsetDays("resize-end", 20, 20, -3)).toBe(0);
  });
});

describe("computeRange", () => {
  it("pads the earliest start and latest due date by RANGE_PAD_DAYS", () => {
    // computeRange's min/max both start life pinned at "today" (see the next
    // test) and only move if a task date is more extreme -- so the start
    // date here has to be well before today and the due date well after it,
    // deliberately straddling whatever day this suite happens to run, or
    // the "always include today" widening would win instead of the task's
    // own dates and this assertion would be testing the wrong thing.
    const tasks = [task({ startDate: "2010-06-01", dueDate: "2090-06-10" })];
    const { rangeStartMs, totalDays } = computeRange(tasks);
    expect(dayIndexToIso(0, rangeStartMs)).toBe("2010-05-18"); // 2010-06-01 minus 14 days
    // Range covers from padded-start to padded-end inclusive-ish (a day count).
    const rangeEndMs = rangeStartMs + totalDays * 24 * 60 * 60 * 1000;
    expect(new Date(rangeEndMs).toISOString().slice(0, 10)).toBe("2090-06-24"); // 2090-06-10 plus 14 days
  });

  it("never returns fewer than MIN_RANGE_DAYS even for a single short task", () => {
    const tasks = [task({ startDate: "2026-06-01", dueDate: "2026-06-01" })];
    const { totalDays } = computeRange(tasks);
    expect(totalDays).toBeGreaterThanOrEqual(MIN_RANGE_DAYS);
  });

  it("widens the range to include today even when all tasks are far in the future", () => {
    const farFuture = "2099-01-01";
    const tasks = [task({ startDate: farFuture, dueDate: farFuture })];
    const { rangeStartMs, totalDays } = computeRange(tasks);
    const todayMs = Date.now();
    expect(rangeStartMs).toBeLessThanOrEqual(todayMs);
    expect(rangeStartMs + totalDays * 24 * 60 * 60 * 1000).toBeGreaterThanOrEqual(todayMs);
  });

  it("ignores tasks with no dates", () => {
    const tasks = [task({ startDate: null, dueDate: null })];
    const { totalDays } = computeRange(tasks);
    expect(totalDays).toBeGreaterThanOrEqual(MIN_RANGE_DAYS);
  });
});
// RANGE_PAD_DAYS is exercised (not just imported) via the padding assertions above.
void RANGE_PAD_DAYS;

describe("accumulateNudge", () => {
  const base = { taskId: "t1", mode: "move" as const, originStartDay: 10, originDueDay: 15, pxPerDay: 30, rangeStartMs: RANGE_START_MS };

  it("starts a fresh accumulator from null state with no flush", () => {
    const { toFlush, next } = accumulateNudge(null, { ...base, deltaDays: 1 });
    expect(toFlush).toBeNull();
    expect(next).toEqual({ taskId: "t1", mode: "move", originStartDay: 10, originDueDay: 15, pxPerDay: 30, rangeStartMs: RANGE_START_MS, offsetDays: 1 });
  });

  it("accumulates consecutive keypresses on the same task/mode", () => {
    const first = accumulateNudge(null, { ...base, deltaDays: 1 }).next;
    const second = accumulateNudge(first, { ...base, deltaDays: 1 });
    expect(second.toFlush).toBeNull();
    expect(second.next.offsetDays).toBe(2);
    const third = accumulateNudge(second.next, { ...base, deltaDays: 1 });
    expect(third.next.offsetDays).toBe(3);
  });

  it("clamps the running total against the fixed origin (resize-end at minimum duration)", () => {
    const resizeEndBase = { ...base, mode: "resize-end" as const };
    // origin duration is 5 days (10 -> 15); three ArrowLeft presses (-1 each)
    // only get to shrink it to zero, not negative.
    const first = accumulateNudge(null, { ...resizeEndBase, deltaDays: -1 }).next;
    const second = accumulateNudge(first, { ...resizeEndBase, deltaDays: -10 });
    expect(second.next.offsetDays).toBe(-5);
  });

  it("switching task mid-accumulation flushes the previous accumulator and starts a new one", () => {
    const forTaskA = accumulateNudge(null, { ...base, deltaDays: 1 }).next;
    const result = accumulateNudge(forTaskA, { ...base, taskId: "t2", deltaDays: 1 });
    expect(result.toFlush).toEqual(forTaskA);
    expect(result.next.taskId).toBe("t2");
    expect(result.next.offsetDays).toBe(1);
  });

  it("switching mode on the same task mid-accumulation flushes the previous accumulator", () => {
    const asMove = accumulateNudge(null, { ...base, deltaDays: 2 }).next;
    const result = accumulateNudge(asMove, { ...base, mode: "resize-end", originStartDay: 10, originDueDay: 15, deltaDays: 1 });
    expect(result.toFlush).toEqual(asMove);
    expect(result.next.mode).toBe("resize-end");
    expect(result.next.offsetDays).toBe(1);
  });

  it("a keypress after a reset (state back to null) starts cleanly, independent of prior history", () => {
    const first = accumulateNudge(null, { ...base, deltaDays: 3 }).next;
    // Simulate the accumulator having been reset (e.g. after a commit) --
    // the next keypress must not see any trace of `first`.
    const resetState: NudgeState | null = null;
    const { toFlush, next } = accumulateNudge(resetState, { ...base, deltaDays: -1 });
    expect(toFlush).toBeNull();
    expect(next.offsetDays).toBe(-1);
    expect(first.offsetDays).toBe(3); // unaffected, confirming no shared mutation
  });
});
