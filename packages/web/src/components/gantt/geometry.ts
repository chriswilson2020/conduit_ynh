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
