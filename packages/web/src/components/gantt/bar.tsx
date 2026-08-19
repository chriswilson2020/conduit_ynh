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
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, task: GanttTask, mode: DragMode) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
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
  isDragging, dragMode, dragOffsetPx, isFlashing, isDependencyTarget,
  onPointerDown, onPointerMove, onPointerUp, onKeyDown, onFocus,
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
      role="button"
      tabIndex={tabIndex}
      aria-label={`${task.title}: ${dateRangeLabel}`}
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
        "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-900",
      )}
      style={{ left, width, top: barTop, height: barHeight, transform, backgroundColor }}
    >
      <div
        className="absolute inset-0 flex cursor-grab items-center overflow-hidden px-1.5 active:cursor-grabbing"
        onPointerDown={(e) => onPointerDown(e, task, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {!isParentSummary && <span className="truncate">{task.title}</span>}
      </div>
      <div
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
        onPointerDown={(e) => onPointerDown(e, task, "resize-start")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
        onPointerDown={(e) => onPointerDown(e, task, "resize-end")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {/* Dependency-create handle: sits just OUTSIDE the bar's own box
         (right: -6px) so it never overlaps the resize-end zone above,
         which is INSET inside the bar. Dragging it to another bar creates
         a predecessor(this task) -> successor(drop target) dependency --
         see chart.tsx's handlePointerMove/finishDrag for the "dependency"
         drag mode. */}
      <div
        data-testid={`gantt-bar-${task.id}-dep-handle`}
        className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-crosshair rounded-full border border-white bg-slate-500 opacity-0 hover:opacity-100 focus-visible:opacity-100"
        style={{ right: -6 }}
        onPointerDown={(e) => onPointerDown(e, task, "dependency")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
});
