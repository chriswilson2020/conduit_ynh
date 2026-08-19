import type { GanttTask } from "@conduit/shared";
import { todayLocalIso } from "../../lib";

/**
 * Pure layout/date math shared by chart.tsx, bar.tsx, arrows.tsx and
 * timescale.tsx (Task 9 -- productionised Gantt, see docs/superpowers/
 * plans/2026-08-19-conduit-phase-3-projects-gantt.md). Split out from
 * chart.tsx (rather than chart.tsx exporting these alongside its own
 * default component export) purely to dodge a circular import: chart.tsx
 * imports the Bar/Arrows/Timescale COMPONENTS, and those components need
 * these same constants/helpers, so anything chart.tsx exported directly
 * would form an import cycle between chart.tsx and its own children. No
 * behavioural significance -- just where the shared math lives.
 */

export const ROW_HEIGHT = 32;
export const GROUP_HEADER_HEIGHT = 28;
export const HEADER_HEIGHT = 36;
export const SIDEBAR_WIDTH = 240;
export const GRID_MAX_HEIGHT = 640;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAY_ZOOM_PX_PER_DAY = 30;
// Week zoom: a fixed-width column per week (not "7 day-columns squeezed
// together") mirrors gantt-lab's own choice -- narrow enough to scroll a
// multi-month range without huge horizontal distance, wide enough to hold a
// "Mon D" label.
export const WEEK_COL_WIDTH = 90;
export const WEEK_ZOOM_PX_PER_DAY = WEEK_COL_WIDTH / 7;
// Padding either side of the data's own min/max dates, and the floor on
// total chart width -- see computeRange below.
export const RANGE_PAD_DAYS = 14;
export const MIN_RANGE_DAYS = 30;
export const ARROW_STUB = 10;
// Mirrors project-detail.tsx's DEFAULT_COLOR -- the same neutral swatch a
// project with no colour set renders elsewhere, reused here for the "No
// project" group header and standalone tasks' bars so an uncoloured task
// reads the same way on the Gantt as it does everywhere else in the app.
export const DEFAULT_PROJECT_COLOR = "#64748b";

export type Zoom = "day" | "week";
export type DragMode = "move" | "resize-start" | "resize-end" | "dependency";

export const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Date-only ISO strings ("YYYY-MM-DD") parse via Date.parse as UTC midnight
// per spec, which is exactly what day-index arithmetic wants: every date in
// this file is a calendar day, not an instant, so all conversions stay in
// UTC-midnight space throughout (never a local-timezone Date) to avoid a
// day-boundary bug for any user not on UTC.
//
// This is a DIFFERENT epoch convention from the server's (services/
// scheduling.ts parses the same "YYYY-MM-DD" strings at UTC NOON, deliberately,
// as defence in depth against a future caller feeding its epoch-day value to
// something timezone-sensitive). The two conventions are safe to coexist
// because every quantity that crosses the client/server boundary is always a
// formatted "YYYY-MM-DD" STRING (isoToDayIndex/dayIndexToIso's inputs and
// outputs) or a DIFFERENCE of same-convention instants (a day count) -- never
// a raw epoch-ms value. A fixed 12-hour offset applied identically to both
// ends of a subtraction cancels out, so "day 5 minus day 2 = 3 days" comes
// out the same whether both were parsed at midnight or both at noon. What
// would NOT be safe: taking a raw epoch-ms number computed by one side (this
// file's rangeStartMs, or the server's epochDay * MS_PER_DAY) and handing it
// to a function on the other side expecting its own convention -- always
// re-derive from the "YYYY-MM-DD" string instead of passing a bare epoch
// value across that boundary.
export function isoToDayIndex(iso: string, rangeStartMs: number): number {
  return Math.round((Date.parse(iso) - rangeStartMs) / DAY_MS);
}

export function dayIndexToIso(dayIndex: number, rangeStartMs: number): string {
  const d = new Date(rangeStartMs + dayIndex * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function dayIndexToDate(dayIndex: number, rangeStartMs: number): Date {
  return new Date(rangeStartMs + dayIndex * DAY_MS);
}

/**
 * The visible day window: padded RANGE_PAD_DAYS before the earliest start
 * date and after the latest due date among the given tasks, always widened
 * to also cover "today" (so the today line is never scrolled off an edge on
 * first paint) and never narrower than MIN_RANGE_DAYS (so a project with one
 * or two short tasks still gets a chart wide enough to read, not a sliver).
 * Unlike gantt-lab's fixed synthetic TOTAL_DAYS window, this is derived from
 * the real data -- deliberately NOT re-derived from an in-flight drag (see
 * chart.tsx's own doc comment): dragging a bar to the edge of the current
 * window doesn't live-resize the grid mid-drag, it just scrolls into
 * not-yet-visible space until the next commit widens the range.
 */
export function computeRange(tasks: GanttTask[]): { rangeStartMs: number; totalDays: number } {
  const todayMs = Date.parse(todayLocalIso());
  let minMs = todayMs;
  let maxMs = todayMs;
  for (const task of tasks) {
    if (task.startDate !== null) {
      const ms = Date.parse(task.startDate);
      if (ms < minMs) minMs = ms;
    }
    if (task.dueDate !== null) {
      const ms = Date.parse(task.dueDate);
      if (ms > maxMs) maxMs = ms;
    }
  }
  const rangeStartMs = minMs - RANGE_PAD_DAYS * DAY_MS;
  const rangeEndMs = maxMs + RANGE_PAD_DAYS * DAY_MS;
  const totalDays = Math.max(MIN_RANGE_DAYS, Math.round((rangeEndMs - rangeStartMs) / DAY_MS));
  return { rangeStartMs, totalDays };
}

// "dependency" mode never reaches either function below -- chart.tsx
// branches it off before any offset math (a dependency drag never changes
// dates, it draws a pending connector instead) -- but DragMode includes it
// so every switch in this file is exhaustive rather than silently wrong if
// a future mode is added. Both fall through to "move" semantics for it,
// which is never exercised.
export function clampOffsetDays(
  mode: DragMode, originStartDay: number, originDueDay: number, deltaDays: number,
): number {
  // resize-start: the start edge can move right at most up to the due date
  // (duration -> 0), no leftward bound -- pulling the start earlier is
  // always legal (mirrors "dragging earlier never pulls successors left",
  // scheduling.ts's own push-only rule -- an earlier start is slack, not a
  // violation).
  if (mode === "resize-start") return Math.min(deltaDays, originDueDay - originStartDay);
  // resize-end: the due edge can move left at most down to the start date
  // (duration -> 0), no rightward bound.
  if (mode === "resize-end") return Math.max(deltaDays, originStartDay - originDueDay);
  return deltaDays;
}

export function applyOffsetDays(
  mode: DragMode, originStartDay: number, originDueDay: number, deltaDays: number,
): { startDay: number; dueDay: number } {
  if (mode === "resize-start") return { startDay: originStartDay + deltaDays, dueDay: originDueDay };
  if (mode === "resize-end") return { startDay: originStartDay, dueDay: originDueDay + deltaDays };
  return { startDay: originStartDay + deltaDays, dueDay: originDueDay + deltaDays };
}

// --- keyboard nudge accumulation (P3.9 quality review, fix 1) -------------
//
// G0's keyboard path committed a shiftTask mutation on EVERY keypress. Five
// fast ArrowRight presses fired five concurrent, uncoordinated optimistic
// mutations (TanStack Query does not serialise mutations sharing a query
// key), each snapshotting the gantt cache for its own rollback independently
// -- so a slow/reordered response could clobber a sibling's optimistic
// patch, and the final committed date was whichever response happened to
// land last, non-deterministically landing the task anywhere from +1 to +5
// days. The fix: each keypress now only RENDERS (updates a local pixel
// offset via chart.tsx's dragVisual, same mechanism a pointer drag already
// uses) -- only the position that survives ~200ms of no further keypresses
// actually COMMITS, as a single shiftTask call carrying the final absolute
// date pair. In short: "each keypress commits" becomes "each keypress
// renders, the settled position commits."
//
// accumulateNudge is the pure piece of that: given the current accumulator
// (or null, if nothing is accumulating) and one keypress's worth of
// intent, it returns the new accumulator to render PLUS, if the keypress
// targets a different task or a different resize/move mode than whatever
// was accumulating, the STALE accumulator that must be flushed (committed
// immediately, not left to its own debounce timer) before the new one takes
// over -- switching what you're nudging is a clear signal the previous
// gesture is done. All the actual side effects (scheduling/cancelling the
// debounce timer, calling shiftTask, updating dragVisual) stay in chart.tsx;
// this function only computes state transitions, which is what makes it
// unit-testable without a DOM or a query client.
export interface NudgeState {
  taskId: string;
  mode: DragMode;
  originStartDay: number;
  originDueDay: number;
  /** Pixels-per-day and the range's epoch anchor at the moment this
   * accumulation STARTED -- captured once, not re-read at commit time,
   * so a zoom change or (in principle) a range recompute mid-accumulation
   * can't retroactively change what a already-rendered offset commits to. */
  pxPerDay: number;
  rangeStartMs: number;
  /** Cumulative delta from originStartDay/originDueDay, already clamped
   * against them (clampOffsetDays's bounds are fixed by the origin, which
   * never changes for the life of one accumulator, so re-clamping the
   * running total on every keypress is equivalent to clamping once at the
   * end). */
  offsetDays: number;
}

export interface NudgeKeyAction {
  taskId: string;
  mode: DragMode;
  originStartDay: number;
  originDueDay: number;
  pxPerDay: number;
  rangeStartMs: number;
  deltaDays: number;
}

export interface NudgeAccumulateResult {
  /** The accumulator that was displaced by this keypress, if any -- the
   * caller must commit it immediately (not wait for its debounce timer,
   * which the caller should also cancel). Null when this keypress extended
   * the SAME accumulation that was already running. */
  toFlush: NudgeState | null;
  next: NudgeState;
}

export function accumulateNudge(state: NudgeState | null, action: NudgeKeyAction): NudgeAccumulateResult {
  const continuing = state !== null && state.taskId === action.taskId && state.mode === action.mode;
  if (continuing) {
    // Reuse the STATE's origin/pxPerDay/rangeStartMs, not the action's --
    // they should be identical (no commit has landed mid-accumulation to
    // change the task's real dates), but anchoring to the accumulator's own
    // fixed baseline rather than trusting each new call is what makes this
    // safe even if a caller ever passed a stale action.
    const offsetDays = clampOffsetDays(state.mode, state.originStartDay, state.originDueDay, state.offsetDays + action.deltaDays);
    return { toFlush: null, next: { ...state, offsetDays } };
  }
  const offsetDays = clampOffsetDays(action.mode, action.originStartDay, action.originDueDay, action.deltaDays);
  return {
    toFlush: state,
    next: {
      taskId: action.taskId, mode: action.mode,
      originStartDay: action.originStartDay, originDueDay: action.originDueDay,
      pxPerDay: action.pxPerDay, rangeStartMs: action.rangeStartMs,
      offsetDays,
    },
  };
}
