import { memo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { clsx } from "clsx";
import type { GanttTask } from "@conduit/shared";
import { todayLocalIso } from "../../lib";
import {
  DEFAULT_PROJECT_COLOR, ROW_HEIGHT, isoToDayIndex,
} from "./geometry";
import type { DragMode } from "./geometry";

export interface GanttBarProps {
  task: GanttTask;
  pxPerDay: number;
  rangeStartMs: number;
  top: number;
  isParentSummary: boolean;
  /** Roving tabIndex (see chart.tsx's doc comment): exactly one bar in the
   * whole chart is 0 at a time, everything else -1, so Tab from outside the
   * grid lands on "wherever focus last was" rather than always task 0. */
  tabIndex: 0 | -1;
  isDragging: boolean;
  dragMode: DragMode | null;
  /** Pixel offset for the CURRENTLY dragging bar only -- 0 (a stable
   * primitive, not a new object) for every other bar, so this prop never
   * causes a re-render for bars uninvolved in the drag. See chart.tsx's
   * dragVisual state for why this is a plain number rather than updated
   * task dates. */
  dragOffsetPx: number;
  isFlashing: boolean;
  isDependencyTarget: boolean;
  /** This task's shiftTask commit is in flight (chart.tsx's
   * inFlightTaskIdsRef/committingIds -- P3.9 review, fix 1). A new
   * drag/nudge on this task is being ignored until it resolves, so the bar
   * gets a subtle pulse to say "already busy" rather than looking
   * unresponsive with no explanation. */
  isCommitting: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, task: GanttTask, mode: DragMode) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** Distinct from onPointerUp -- a pointercancel (the OS/browser reclaiming
   * the pointer: a system gesture, palm rejection, the tab losing focus)
   * means this gesture never completed and must REVERT, not commit wherever
   * the bar happened to be when it fired. See chart.tsx's revertDrag (P3.9
   * review, fix 3). */
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>, task: GanttTask) => void;
  onFocus: (taskId: string) => void;
}

/**
 * Memoised per-task bar -- the load-bearing piece of gantt-lab's performance
 * model (see chart.tsx's doc comment for the full architecture). Every prop
 * here is either a stable reference (task, the five handler callbacks) or a
 * primitive that only actually CHANGES for the one bar currently being
 * dragged/resized/flashed -- so React.memo's default shallow comparison
 * bails out for every other bar on every drag frame, keyboard commit, or
 * flash tick.
 */
export const GanttBar = memo(function GanttBar({
  task, pxPerDay, rangeStartMs, top, isParentSummary, tabIndex,
  isDragging, dragMode, dragOffsetPx, isFlashing, isDependencyTarget, isCommitting,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown, onFocus,
}: GanttBarProps) {
  if (task.startDate === null || task.dueDate === null) return null;

  const startDay = isoToDayIndex(task.startDate, rangeStartMs);
  const dueDay = isoToDayIndex(task.dueDate, rangeStartMs);
  const baseLeft = startDay * pxPerDay;
  // A same-day task (startDay === dueDay, legal per taskDatesPaired) still
  // needs a visible sliver rather than a zero-width div.
  const baseWidth = Math.max(pxPerDay * 0.5, (dueDay - startDay) * pxPerDay);

  let left = baseLeft;
  let width = baseWidth;
  let transform: string | undefined;
  if (isDragging && dragMode === "move") {
    // Move: left stays anchored at the pre-drag position, the live offset
    // is a pure CSS transform -- compositor-only, no layout reflow -- per
    // the G0 report's "extra safety margin" note (this file's top-of-module
    // doc comment / chart.tsx's has the full rationale).
    transform = `translateX(${dragOffsetPx}px)`;
  } else if (isDragging && dragMode === "resize-start") {
    left = baseLeft + dragOffsetPx;
    width = Math.max(pxPerDay * 0.5, baseWidth - dragOffsetPx);
  } else if (isDragging && dragMode === "resize-end") {
    width = Math.max(pxPerDay * 0.5, baseWidth + dragOffsetPx);
  }

  const overdue = task.dueDate < todayLocalIso() && task.status !== "done";
  const done = task.status === "done";
  const barHeight = isParentSummary ? 8 : ROW_HEIGHT - 10;
  const barTop = top + (isParentSummary ? 4 : 5);
  // Bars are coloured by PROJECT (per the plan: "bars per task, project
  // colour") -- a hex value from the payload, so it's an inline style, not
  // a Tailwind class. Flashing overrides it to amber for the cascade
  // highlight; done/overdue/drag/dependency-target states layer on top via
  // opacity/ring classes instead of fighting over the background colour, so
  // a done task in a red project still reads as "that project, but done"
  // rather than losing its colour identity.
  const backgroundColor = isFlashing ? "#f59e0b" : (task.projectColor ?? DEFAULT_PROJECT_COLOR);

  const dateRangeLabel = task.startDate === task.dueDate
    ? task.startDate
    : `${task.startDate} to ${task.dueDate}`;

  return (
    <div
      data-testid={`gantt-bar-${task.id}`}
      data-task-id={task.id}
      data-flash={isFlashing || undefined}
      data-committing={isCommitting || undefined}
      role="button"
      tabIndex={tabIndex}
      aria-label={`${task.title}: ${dateRangeLabel}. Arrow keys move; Shift+Left/Right resizes the due date; Shift+Up/Down resizes the start date; Escape cancels a drag.`}
      title={`${task.title}: ${dateRangeLabel}`}
      onKeyDown={(e) => onKeyDown(e, task)}
      onFocus={() => onFocus(task.id)}
      className={clsx(
        "absolute rounded-sm text-[10px] leading-none text-white shadow-sm outline-none",
        "transition-colors duration-700",
        done && "opacity-50",
        overdue && !done && "ring-2 ring-red-500",
        isDragging && "z-30 shadow-md",
        isDependencyTarget && "ring-2 ring-amber-500 ring-offset-1",
        // Subtle "already busy" cue while this task's own shift is in
        // flight and a new drag/nudge on it is being ignored (see
        // chart.tsx's inFlightTaskIdsRef) -- a soft pulse rather than
        // anything louder, since this is routine (every commit passes
        // through it briefly), not an error state.
        isCommitting && "animate-pulse opacity-80",
        "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-900",
      )}
      style={{ left, width, top: barTop, height: barHeight, transform, backgroundColor }}
    >
      {/* Below the breakpoint the chart is read-only (the phase spec's Gantt
         section), so this overlay stops taking pointers -- but it is NOT
         display:none like the three zones below it, because it is also what
         paints the bar's title. Neutralising the pointers rather than the
         element is the difference between a read-only bar and a blank one.
         A tap still opens the task: chart.tsx renders a phone-only layer
         over the whole row for that. */}
      <div
        className="absolute inset-0 flex cursor-grab items-center overflow-hidden px-1.5 active:cursor-grabbing max-md:pointer-events-none"
        onPointerDown={(e) => onPointerDown(e, task, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {!isParentSummary && <span className="truncate">{task.title}</span>}
      </div>
      {/* The two resize strips and the dependency handle go away entirely
         below the breakpoint: they paint nothing a reader needs, they are 6
         and 8 CSS pixels wide against a 44px touch floor, and each one
         starts a gesture that commits a schedule change. (An earlier version
         of this comment read the utility names as pixel counts and said 1.5
         and 2, which is out by the spacing scale's factor of four and
         contradicted the arithmetic further down this same file.) */}
      <div
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize max-md:hidden"
        onPointerDown={(e) => onPointerDown(e, task, "resize-start")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      <div
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize max-md:hidden"
        onPointerDown={(e) => onPointerDown(e, task, "resize-end")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {/* Dependency-create handle: sits just OUTSIDE the bar's own box so it
         never overlaps the resize-end zone above, which is INSET inside the
         bar. resize-end spans [width-6, width] (the "w-1.5 right-0" div
         above); this handle is 8px wide ("w-2") positioned at "right: -10px",
         i.e. its right edge sits 10px past the bar's right edge and its
         left edge 2px past it -- spanning [width+2, width+10], fully clear
         of resize-end's zone with a 2px gap between them (an earlier
         version used right:-6px/w-2.5, spanning [width-4, width+6], which
         overlapped resize-end's zone by 4px and let it steal edge grabs
         meant for this handle). Dragging it to another bar creates a
         predecessor(this task) -> successor(drop target) dependency -- see
         chart.tsx's handlePointerMove/finishDrag for the "dependency" drag
         mode. */}
      <div
        data-testid={`gantt-bar-${task.id}-dep-handle`}
        className="absolute top-1/2 h-2 w-2 -translate-y-1/2 cursor-crosshair rounded-full border border-white bg-slate-500 opacity-0 hover:opacity-100 focus-visible:opacity-100 max-md:hidden"
        style={{ right: -10 }}
        onPointerDown={(e) => onPointerDown(e, task, "dependency")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
    </div>
  );
});
