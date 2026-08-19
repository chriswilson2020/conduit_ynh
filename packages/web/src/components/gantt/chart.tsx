import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { clsx } from "clsx";
import { Link } from "@tanstack/react-router";
import type { GanttTask, TaskDependency } from "@conduit/shared";
import { useAddDependency, useGantt, useShiftTask } from "../../queries";
import type { GanttTarget } from "../../queries";
import { Button } from "../ui/button";
import { GanttBar } from "./bar";
import { GanttArrows } from "./arrows";
import type { PendingConnector } from "./arrows";
import { GanttTimescale, GanttTodayLine, GanttWeekendLayer } from "./timescale";
import type { Zoom } from "./geometry";
import {
  DAY_ZOOM_PX_PER_DAY, DEFAULT_PROJECT_COLOR, GRID_MAX_HEIGHT, GROUP_HEADER_HEIGHT,
  HEADER_HEIGHT, ROW_HEIGHT, SIDEBAR_WIDTH, WEEK_ZOOM_PX_PER_DAY,
  applyOffsetDays, clampOffsetDays, computeRange, dayIndexToIso, isoToDayIndex,
} from "./geometry";
import type { DragMode } from "./geometry";

/**
 * The production Gantt (Task 9 -- docs/superpowers/plans/2026-08-19-conduit-
 * phase-3-projects-gantt.md), productionising the G0 prototype
 * (pages/gantt-lab.tsx, deleted by this same task) that Chris validated
 * hands-on. This doc comment carries forward gantt-lab's own architecture
 * doc comment, updated for what changed connecting it to real, live,
 * multi-user data.
 *
 * STRUCTURE vs DATES -- the key change from G0: gantt-lab had ONE `tasks`
 * array that was simultaneously the row order/grouping AND the live dates,
 * so mutating it during a drag couldn't help but change both. Here, row
 * STRUCTURE (which rows exist, their order, project/parent grouping) comes
 * from `rows`/`rowTop`/`taskById`, all derived via useMemo from
 * `data.tasks` -- the server-authoritative list, which changes ONLY on a
 * real query update (a commit, a refetch, an SSE-triggered invalidation),
 * NEVER on a drag frame. DATES during an in-flight drag live in a separate,
 * tiny `dragVisual` state (`{ taskId, mode, offsetPx }`), applied as a pixel
 * offset on top of the structurally-stable position. This means a drag
 * frame updates exactly ONE piece of state (a small object, not a 200-
 * element array), and every Bar/ArrowPath untouched by the drag never sees
 * a changed prop at all -- not even a new array reference to compare away.
 *
 * MOVE vs RESIZE -- move renders its live offset as a CSS `transform:
 * translateX` (bar.tsx), per the G0 report's "extra safety margin" note:
 * compositor-only, no layout reflow, on top of a `left` that stays anchored
 * at the pre-drag position for the whole gesture. Resize still adjusts
 * `left`/`width` directly (transform can't fake a width change), exactly
 * like gantt-lab.
 *
 * ARROWS -- gantt-lab memoised ArrowPath on the pred/succ TASK OBJECTS,
 * relying on every untouched task keeping its exact reference. Here,
 * GanttArrows resolves pred/succ and computes the four endpoint
 * COORDINATES itself (a cheap O(1) per arrow, run every render regardless),
 * and ArrowPath is memoised on those numbers instead. Primitives compare by
 * VALUE (Object.is(5, 5) is true no matter how many times 5 was
 * recomputed), so this is an equally safe memo key without depending on
 * `taskById` preserving object identity for arrows not involved in a drag
 * -- and it's what lets the dragged task's OWN structural object stay
 * untouched during a move/resize (see above) while its two or so arrows
 * still track the live pixel offset via dragVisual, not a task date.
 *
 * KEYBOARD -- ArrowLeft/Right = move both dates by a day; Shift+ArrowLeft/
 * Right = resize the due date by a day. Every commit (pointer OR keyboard)
 * goes through the same useShiftTask mutation, so cascade/flash/events/SSE
 * are one code path, never forked pointer vs. keyboard -- see
 * handleBarKeyDown below for the modifier choice (Shift only; Alt/Ctrl/Cmd
 * are OS/browser territory).
 */

const EMPTY_TASKS: GanttTask[] = [];
const EMPTY_DEPS: TaskDependency[] = [];

interface HeaderRowMeta {
  kind: "header";
  key: string;
  projectId: string | null;
  projectName: string;
  projectColor: string;
}

interface TaskRowMeta {
  kind: "task";
  key: string;
  task: GanttTask;
  isParentSummary: boolean;
  isChild: boolean;
}

type ChartRow = HeaderRowMeta | TaskRowMeta;

function isTaskRow(row: ChartRow): row is TaskRowMeta {
  return row.kind === "task";
}

/**
 * ganttPayload (services/scheduling.ts) already orders its rows (project,
 * then parent-group root-first, then position) -- this just reads that
 * order and inserts a group-header row wherever the project changes
 * (global view only; a per-project chart has no headers to insert). Same
 * tasks-array pass builds the childrenOf set that flags a root task as a
 * "parent summary" bar (see bar.tsx's isParentSummary) whenever it has at
 * least one child actually present in this payload.
 */
function buildRows(tasks: GanttTask[], isGlobal: boolean): ChartRow[] {
  const childrenOf = new Set<string>();
  for (const task of tasks) if (task.parentTaskId !== null) childrenOf.add(task.parentTaskId);

  const rows: ChartRow[] = [];
  let currentProjectId: string | null = null;
  let seenAny = false;
  for (const task of tasks) {
    if (isGlobal && (!seenAny || task.projectId !== currentProjectId)) {
      currentProjectId = task.projectId;
      seenAny = true;
      rows.push({
        kind: "header",
        key: `hdr-${task.projectId ?? "none"}`,
        projectId: task.projectId,
        projectName: task.projectId === null ? "No project" : (task.projectName ?? "Untitled project"),
        projectColor: task.projectColor ?? DEFAULT_PROJECT_COLOR,
      });
    }
    rows.push({
      kind: "task", key: task.id, task,
      isParentSummary: childrenOf.has(task.id),
      isChild: task.parentTaskId !== null,
    });
  }
  return rows;
}

function buildRowTop(rows: ChartRow[]): { rowTop: Map<string, number>; bodyHeight: number } {
  const rowTop = new Map<string, number>();
  let y = 0;
  for (const row of rows) {
    if (row.kind === "header") {
      y += GROUP_HEADER_HEIGHT;
      continue;
    }
    rowTop.set(row.task.id, y);
    y += ROW_HEIGHT;
  }
  return { rowTop, bodyHeight: y };
}

// No per-drag props at all (just `rows`, which only changes when the
// server-authoritative task LIST changes) -- bails out of every drag-frame
// re-render, mirroring gantt-lab's Sidebar. Defined at module scope, not
// inside GanttChart, so its identity (and therefore its memoisation) is
// stable across GanttChart's own re-renders.
const Sidebar = memo(function Sidebar({ rows, taskCount }: { rows: ChartRow[]; taskCount: number }) {
  return (
    <div className="sticky left-0 z-20 border-r border-slate-200 bg-white" style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }}>
      <div
        className="sticky top-0 z-30 flex items-center border-b border-slate-200 bg-white px-2 text-xs font-semibold text-slate-500"
        style={{ height: HEADER_HEIGHT }}
      >
        {`Tasks (${taskCount})`}
      </div>
      {rows.map((row) => (row.kind === "header" ? (
        <div
          key={row.key}
          data-testid={`gantt-group-${row.projectId ?? "none"}`}
          className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-600"
          style={{ height: GROUP_HEADER_HEIGHT }}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.projectColor }} />
          <span className="truncate">{row.projectName}</span>
        </div>
      ) : (
        <div
          key={row.key}
          className={clsx(
            "flex items-center truncate border-b border-slate-100 text-xs text-slate-700",
            row.isChild ? "pl-6 pr-2" : "px-2",
            row.task.status === "done" && "text-slate-400 line-through",
          )}
          style={{ height: ROW_HEIGHT }}
          title={row.task.title}
        >
          {row.task.title}
        </div>
      )))}
    </div>
  );
});

interface DragState {
  taskId: string;
  mode: DragMode;
  pointerId: number;
  startClientX: number;
  originStartDay: number;
  originDueDay: number;
  pxPerDay: number;
  rangeStartMs: number;
  pendingOffsetDays: number;
  rafId: number | null;
  // "dependency" mode only.
  sourceX: number;
  sourceY: number;
  pendingClientX: number;
  pendingClientY: number;
}

interface DragVisual {
  taskId: string;
  mode: DragMode;
  offsetPx: number;
}

export interface GanttChartProps {
  target: GanttTarget;
  /** Opens the task drawer -- the page owns the `?task=` navigation (mirrors
   * task-board.tsx's openTask), this component just needs somewhere to send
   * Enter. */
  onOpenTask: (taskId: string) => void;
}

export function GanttChart({ target, onOpenTask }: GanttChartProps) {
  const isGlobal = "global" in target;
  const { data, isLoading, isError, error } = useGantt(target);
  const shiftTask = useShiftTask();
  const addDependency = useAddDependency();

  const [zoom, setZoom] = useState<Zoom>("day");
  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null);
  const [pendingConnector, setPendingConnector] = useState<PendingConnector | null>(null);
  const [hoveredTargetId, setHoveredTargetIdState] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ids: Set<string>; count: number } | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const hoveredTargetRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  // The date pair a pending shift is COMMITTING to -- see the layout effect
  // below for why dragVisual is cleared by watching this land in taskById
  // rather than by the mutation's onSuccess directly.
  const pendingCommitRef = useRef<{ taskId: string; startDate: string; dueDate: string } | null>(null);

  const tasks = data?.tasks ?? EMPTY_TASKS;
  const dependencies = data?.dependencies ?? EMPTY_DEPS;

  const rows = useMemo(() => buildRows(tasks, isGlobal), [tasks, isGlobal]);
  const taskRows = useMemo(() => rows.filter(isTaskRow), [rows]);
  const { rowTop, bodyHeight } = useMemo(() => buildRowTop(rows), [rows]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  const { rangeStartMs, totalDays } = useMemo(() => computeRange(tasks), [tasks]);
  const pxPerDay = zoom === "day" ? DAY_ZOOM_PX_PER_DAY : WEEK_ZOOM_PX_PER_DAY;
  const chartWidth = totalDays * pxPerDay;
  const firstTaskId = taskRows[0]?.task.id ?? null;
  const effectiveFocusedId = focusedTaskId ?? firstTaskId;

  // Clears the frozen post-drag/keyboard-commit overlay the instant the
  // real data catches up (whether via useShiftTask's own optimistic patch,
  // its eventual server confirmation, or an SSE-pushed refetch) -- a
  // useLAYOUT effect specifically so the swap from "old dates + frozen
  // offset" to "new dates, no offset" happens before the browser paints,
  // not after. Without that, there's a one-frame window where taskById
  // already has the new dates AND dragVisual still holds the old offset,
  // which would double-apply the shift visually for a frame.
  useLayoutEffect(() => {
    const pending = pendingCommitRef.current;
    if (!pending) return;
    const t = taskById.get(pending.taskId);
    if (t && t.startDate === pending.startDate && t.dueDate === pending.dueDate) {
      pendingCommitRef.current = null;
      setDragVisual(null);
    }
  }, [taskById]);

  const triggerFlash = useCallback((ids: string[]) => {
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
    setFlash({ ids: new Set(ids), count: ids.length });
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlash(null);
      flashTimeoutRef.current = null;
    }, 1000);
  }, []);

  useEffect(() => () => {
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, task: GanttTask, mode: DragMode) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      if (mode === "dependency") {
        const top = rowTop.get(task.id);
        if (top === undefined || task.dueDate === null) return;
        const sourceX = isoToDayIndex(task.dueDate, rangeStartMs) * pxPerDay;
        const sourceY = top + ROW_HEIGHT / 2;
        dragRef.current = {
          taskId: task.id, mode, pointerId: e.pointerId, startClientX: e.clientX,
          originStartDay: 0, originDueDay: 0, pxPerDay, rangeStartMs, pendingOffsetDays: 0, rafId: null,
          sourceX, sourceY, pendingClientX: e.clientX, pendingClientY: e.clientY,
        };
        setPendingConnector({ x1: sourceX, y1: sourceY, x2: sourceX, y2: sourceY });
        return;
      }
      if (task.startDate === null || task.dueDate === null) return;
      dragRef.current = {
        taskId: task.id, mode, pointerId: e.pointerId, startClientX: e.clientX,
        originStartDay: isoToDayIndex(task.startDate, rangeStartMs),
        originDueDay: isoToDayIndex(task.dueDate, rangeStartMs),
        pxPerDay, rangeStartMs, pendingOffsetDays: 0, rafId: null,
        sourceX: 0, sourceY: 0, pendingClientX: e.clientX, pendingClientY: e.clientY,
      };
    },
    [pxPerDay, rangeStartMs, rowTop],
  );

  // rAF-throttled exactly like gantt-lab: pointermove can fire far faster
  // than the display refreshes, so only the LATEST pending value before
  // each frame actually triggers a state update.
  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === "dependency") {
      drag.pendingClientX = e.clientX;
      drag.pendingClientY = e.clientY;
    } else {
      const deltaDays = Math.round((e.clientX - drag.startClientX) / drag.pxPerDay);
      drag.pendingOffsetDays = clampOffsetDays(drag.mode, drag.originStartDay, drag.originDueDay, deltaDays);
    }
    if (drag.rafId !== null) return;
    drag.rafId = requestAnimationFrame(() => {
      const active = dragRef.current;
      if (!active) return;
      active.rafId = null;
      if (active.mode === "dependency") {
        const rect = bodyRef.current?.getBoundingClientRect();
        if (rect) {
          setPendingConnector({
            x1: active.sourceX, y1: active.sourceY,
            x2: active.pendingClientX - rect.left, y2: active.pendingClientY - rect.top,
          });
        }
        const el = document.elementFromPoint(active.pendingClientX, active.pendingClientY);
        const targetEl = el instanceof Element ? el.closest("[data-task-id]") : null;
        const targetId = targetEl?.getAttribute("data-task-id") ?? null;
        const nextHover = targetId && targetId !== active.taskId ? targetId : null;
        hoveredTargetRef.current = nextHover;
        setHoveredTargetIdState(nextHover);
      } else {
        setDragVisual({ taskId: active.taskId, mode: active.mode, offsetPx: active.pendingOffsetDays * active.pxPerDay });
      }
    });
  }, []);

  const finishDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.rafId !== null) {
      cancelAnimationFrame(drag.rafId);
      drag.rafId = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;

    if (drag.mode === "dependency") {
      setPendingConnector(null);
      const targetId = hoveredTargetRef.current;
      hoveredTargetRef.current = null;
      setHoveredTargetIdState(null);
      if (targetId !== null) {
        addDependency.mutate(
          { predecessorId: drag.taskId, successorId: targetId },
          { onError: (err) => setBannerError(err instanceof Error ? err.message : String(err)) },
        );
      }
      return;
    }

    const { startDay, dueDay } = applyOffsetDays(drag.mode, drag.originStartDay, drag.originDueDay, drag.pendingOffsetDays);
    const startDate = dayIndexToIso(startDay, drag.rangeStartMs);
    const dueDate = dayIndexToIso(dueDay, drag.rangeStartMs);
    if (startDate === (taskById.get(drag.taskId)?.startDate ?? null) && dueDate === (taskById.get(drag.taskId)?.dueDate ?? null)) {
      // No actual change (a click, or a drag that snapped back to origin) --
      // skip the round trip entirely.
      setDragVisual(null);
      return;
    }
    // Freeze the visual at the final position -- see the layout effect
    // above for why this clears itself once the real data catches up,
    // rather than being cleared here.
    pendingCommitRef.current = { taskId: drag.taskId, startDate, dueDate };
    setDragVisual({ taskId: drag.taskId, mode: drag.mode, offsetPx: drag.pendingOffsetDays * drag.pxPerDay });
    shiftTask.mutate({ id: drag.taskId, startDate, dueDate }, {
      onSuccess: (result) => {
        const cascaded = result.moved.filter((m) => m.id !== drag.taskId).map((m) => m.id);
        if (cascaded.length > 0) triggerFlash(cascaded);
      },
      onError: (err) => {
        pendingCommitRef.current = null;
        setDragVisual(null);
        setBannerError(err instanceof Error ? err.message : String(err));
      },
    });
  }, [addDependency, shiftTask, taskById, triggerFlash]);

  // Every keyboard commit goes through this SAME useShiftTask mutation the
  // pointer path uses (see this file's doc comment) -- no drag-preview
  // state to throttle, since a keypress is a single one-day commit, not a
  // continuous gesture.
  const handleBarKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>, task: GanttTask) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpenTask(task.id);
      return;
    }
    if (task.startDate === null || task.dueDate === null) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // Alt opens OS/browser menus and Ctrl/Cmd are bound to browser history
    // navigation on a plain ArrowLeft/Right -- any modifier other than
    // Shift is left alone so this never fights the OS or the browser
    // chrome. Shift is free on a bare arrow key in both, which is why it
    // marks "resize" instead of "move" here.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -1 : 1;
    const mode: DragMode = e.shiftKey ? "resize-end" : "move";
    const originStartDay = isoToDayIndex(task.startDate, rangeStartMs);
    const originDueDay = isoToDayIndex(task.dueDate, rangeStartMs);
    const clamped = clampOffsetDays(mode, originStartDay, originDueDay, delta);
    if (clamped === 0) return; // already at minimum duration (resize only)
    const { startDay, dueDay } = applyOffsetDays(mode, originStartDay, originDueDay, clamped);
    const startDate = dayIndexToIso(startDay, rangeStartMs);
    const dueDate = dayIndexToIso(dueDay, rangeStartMs);
    shiftTask.mutate({ id: task.id, startDate, dueDate }, {
      onSuccess: (result) => {
        const cascaded = result.moved.filter((m) => m.id !== task.id).map((m) => m.id);
        if (cascaded.length > 0) triggerFlash(cascaded);
      },
      onError: (err) => setBannerError(err instanceof Error ? err.message : String(err)),
    });
  }, [onOpenTask, rangeStartMs, shiftTask, triggerFlash]);

  const handleBarFocus = useCallback((taskId: string) => setFocusedTaskId(taskId), []);

  if (isLoading) return <p>Loading...</p>;
  if (isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {error instanceof Error ? error.message : "Could not load the Gantt chart."}
      </p>
    );
  }

  if (tasks.length === 0) {
    return (
      <div data-testid="gantt-empty" className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <p className="text-sm text-slate-500">No dated tasks yet. Set a start and due date on a task to see it here.</p>
        {"projectId" in target ? (
          <Link
            to="/projects/$projectId/board"
            params={{ projectId: target.projectId }}
            className="mt-3 inline-block text-sm font-medium text-slate-900 underline hover:text-slate-700"
          >
            Go to the board
          </Link>
        ) : (
          <Link to="/projects" className="mt-3 inline-block text-sm font-medium text-slate-900 underline hover:text-slate-700">
            Go to Projects
          </Link>
        )}
      </div>
    );
  }

  return (
    <div data-testid="gantt" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-testid="gantt-zoom" className="flex gap-2">
          <Button variant={zoom === "day" ? "default" : "outline"} onClick={() => setZoom("day")}>Day</Button>
          <Button variant={zoom === "week" ? "default" : "outline"} onClick={() => setZoom("week")}>Week</Button>
        </div>
        <div data-testid="cascade-note" aria-live="polite" className="text-xs font-medium text-amber-700">
          {flash ? `${flash.count} task${flash.count === 1 ? "" : "s"} shifted` : ""}
        </div>
      </div>

      {bannerError && (
        <div role="alert" className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{bannerError}</span>
          <button type="button" onClick={() => setBannerError(null)} className="ml-4 shrink-0 text-red-500 hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      <div className="relative overflow-auto rounded-md border border-slate-200" style={{ maxHeight: GRID_MAX_HEIGHT }}>
        <div className="flex" style={{ width: SIDEBAR_WIDTH + chartWidth }}>
          <Sidebar rows={rows} taskCount={taskRows.length} />
          <div className="relative" style={{ width: chartWidth, flexShrink: 0 }}>
            <GanttTimescale zoom={zoom} pxPerDay={pxPerDay} rangeStartMs={rangeStartMs} totalDays={totalDays} chartWidth={chartWidth} />
            <div ref={bodyRef} className="relative" style={{ width: chartWidth, height: bodyHeight }}>
              <GanttWeekendLayer zoom={zoom} pxPerDay={pxPerDay} rangeStartMs={rangeStartMs} totalDays={totalDays} bodyHeight={bodyHeight} />
              <GanttTodayLine rangeStartMs={rangeStartMs} totalDays={totalDays} pxPerDay={pxPerDay} bodyHeight={bodyHeight} />
              {taskRows.map((row) => {
                const task = taskById.get(row.task.id) ?? row.task;
                const top = rowTop.get(row.task.id) ?? 0;
                const isDragging = dragVisual?.taskId === row.task.id;
                return (
                  <GanttBar
                    key={row.task.id}
                    task={task}
                    pxPerDay={pxPerDay}
                    rangeStartMs={rangeStartMs}
                    top={top}
                    isParentSummary={row.isParentSummary}
                    tabIndex={row.task.id === effectiveFocusedId ? 0 : -1}
                    isDragging={isDragging}
                    dragMode={isDragging ? dragVisual.mode : null}
                    dragOffsetPx={isDragging ? dragVisual.offsetPx : 0}
                    isFlashing={flash?.ids.has(row.task.id) ?? false}
                    isDependencyTarget={hoveredTargetId === row.task.id}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishDrag}
                    onKeyDown={handleBarKeyDown}
                    onFocus={handleBarFocus}
                  />
                );
              })}
              <GanttArrows
                dependencies={dependencies}
                taskById={taskById}
                rowTop={rowTop}
                pxPerDay={pxPerDay}
                rangeStartMs={rangeStartMs}
                chartWidth={chartWidth}
                bodyHeight={bodyHeight}
                draggingTaskId={dragVisual?.taskId ?? null}
                dragMode={dragVisual?.mode ?? null}
                dragOffsetPx={dragVisual?.offsetPx ?? 0}
                pendingConnector={pendingConnector}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
