import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { clsx } from "clsx";
import { Link } from "@tanstack/react-router";
import type { GanttTask, ShiftResult, TaskDependency } from "@conduit/shared";
import { todayLocalIso } from "../../lib";
import { useAddDependency, useCompactSchedule, useGantt, useShiftTask } from "../../queries";
import type { GanttTarget } from "../../queries";
import { Button } from "../ui/button";
import { mobileMediaQuery } from "../../use-is-mobile";
import { GanttBar } from "./bar";
import { GanttArrows } from "./arrows";
import type { PendingConnector } from "./arrows";
import { GanttTimescale, GanttTodayLine, GanttWeekendLayer } from "./timescale";
import type { Zoom } from "./geometry";
import {
  DAY_ZOOM_PX_PER_DAY, DEFAULT_PROJECT_COLOR, GRID_MAX_HEIGHT, GROUP_HEADER_HEIGHT,
  HEADER_HEIGHT, ROW_HEIGHT, SIDEBAR_WIDTH_CSS, WEEK_ZOOM_PX_PER_DAY,
  accumulateNudge, applyOffsetDays, clampOffsetDays, computeRange, dayIndexToIso,
  initialScrollLeft, isoToDayIndex,
} from "./geometry";
import type { DragMode, NudgeState } from "./geometry";

// Debounce window between the last keypress of a keyboard nudge and its
// commit -- see geometry.ts's accumulateNudge doc comment (P3.9 review, fix
// 1) for the full "each keypress renders, the settled position commits"
// rationale. 200ms is comfortably longer than any real keyboard repeat gap
// between intentional presses, short enough that a genuine pause reads as
// "done" promptly.
const NUDGE_DEBOUNCE_MS = 200;

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
 * Right = resize the DUE date by a day; Shift+ArrowUp/Down = resize the
 * START date by a day (vertical arrows have no other meaning on a bar --
 * see handleBarKeyDown for the modifier choice, Shift only; Alt/Ctrl/Cmd are
 * OS/browser territory). Every commit (pointer OR keyboard) goes through the
 * same useShiftTask mutation, so cascade/flash/events/SSE are one code
 * path, never forked pointer vs. keyboard.
 *
 * SERIALISING SHIFT COMMITS (P3.9 review, fix 1) -- two mechanisms, doing
 * two different jobs:
 *   1. Keyboard keypresses ACCUMULATE locally (geometry.ts's
 *      accumulateNudge) and render immediately via dragVisual, same as a
 *      pointer drag frame; only the position that survives a short debounce
 *      after the last keypress actually commits, as ONE shiftTask call. A
 *      pointer drag starting on the very task a nudge is mid-accumulation on
 *      flushes that pending nudge first (see handlePointerDown) so the two
 *      gestures can never both be heading for the same task's dates at once.
 *   2. inFlightTaskIdsRef guards the commit itself: once a task's shiftTask
 *      mutation is actually in flight, a new drag or nudge STARTING on that
 *      same task is ignored outright (the bar shows a subtle "committing"
 *      pulse -- isCommitting below) until the mutation settles. Different
 *      tasks are never blocked by each other -- only a task's own prior
 *      commit can gate its next one.
 * Together these mean at most one shiftTask call per task is ever in flight,
 * and its optimistic snapshot/rollback can't be clobbered by a sibling call
 * for the same task racing it.
 *
 * BELOW THE BREAKPOINT (Phase 6) -- the same chart, read-only, with pan and
 * zoom, and a tap on a row opens the task drawer, where dates AND
 * dependencies are both editable. So nothing the chart can do at a desk
 * becomes unreachable from a phone; it is reached by a different gesture.
 * Four separate mechanisms carry that, and which one applies is decided by
 * what CSS can and cannot do:
 *
 *   - The pointer paths are CLASSES, in bar.tsx: the move overlay stops
 *     taking pointers (it still paints the title), and the two resize strips
 *     and the dependency handle are not rendered at all. So a touch drag
 *     cannot even begin, which is the point -- a bar that follows a finger
 *     and then snaps back is worse than one that never moved.
 *   - The KEY handler cannot be a class -- no CSS property stops a key event
 *     -- so handleBarKeyDown reads the breakpoint imperatively, once, at the
 *     moment a key arrives. Spec Amendment 1.
 *   - The OPENING SCROLL cannot be a class either, for the same kind of
 *     reason, and is read the same way at mount. Spec Amendment 4.
 *   - Everything else is layout, and therefore classes: the sidebar's width
 *     (via a custom property, since an inline JavaScript number cannot be
 *     re-scaled by a variant), the grid's stacking context, and the tap
 *     layers themselves.
 *
 * Those two imperative reads are the whole of the JavaScript this chart
 * spends on the breakpoint. Neither subscribes, re-renders or builds a second
 * component tree, which is what the phase's three-site cap on useIsMobile()
 * exists to prevent; both build their query from mobileMediaQuery(), so there
 * is still exactly one definition of where the breakpoint is.
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

/**
 * The global chart's per-group "Remove slack" (Fix 2, hotfix v0.4.2) -- one
 * of these per project group header row, each owning its OWN
 * useCompactSchedule(projectId) mutation instance (a hook can't be called
 * conditionally/in a loop inside GanttChart itself for a group count that
 * varies with the data, so this is a real component, not an inline helper).
 * The confirm text, mutate call, and success/empty/error handling exactly
 * mirror the per-project page's own handleCompact in GanttChart below --
 * only the noun ("this group's project") differs -- but the FLASH (amber
 * ring on moved bars) and the cascade-note text are the chart's single
 * shared mechanism, reached via the onCompacted/onEmpty/onError callbacks
 * passed down from GanttChart, so a group compact reads identically to the
 * per-project button's own sweep from the user's point of view.
 */
const GanttGroupCompactButton = memo(function GanttGroupCompactButton({
  projectId, onCompacted, onEmpty, onError,
}: {
  projectId: string;
  onCompacted: (result: ShiftResult) => void;
  onEmpty: () => void;
  onError: (err: unknown) => void;
}) {
  const compactSchedule = useCompactSchedule(projectId);
  const handleClick = useCallback(() => {
    if (!window.confirm("Pull every task to its earliest position? Done and in-progress tasks stay put.")) return;
    compactSchedule.mutate(undefined, {
      onSuccess: (result) => {
        if (result.moved.length > 0) onCompacted(result);
        else onEmpty();
      },
      onError,
    });
  }, [compactSchedule, onCompacted, onEmpty, onError]);

  return (
    <button
      type="button"
      data-testid={`compact-button-${projectId}`}
      onClick={handleClick}
      disabled={compactSchedule.isPending}
      className="ml-auto shrink-0 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 max-md:hidden"
    >
      Remove slack
    </button>
  );
});

// No per-drag props at all (just `rows`, which only changes when the
// server-authoritative task LIST changes) -- bails out of every drag-frame
// re-render, mirroring gantt-lab's Sidebar. Defined at module scope, not
// inside GanttChart, so its identity (and therefore its memoisation) is
// stable across GanttChart's own re-renders. The onGroupCompact* callbacks
// are themselves stable (useCallback in GanttChart), so passing them down
// doesn't defeat this memoisation.
const Sidebar = memo(function Sidebar({
  rows, taskCount, onOpenTask, onGroupCompacted, onGroupCompactEmpty, onGroupCompactError,
}: {
  rows: ChartRow[];
  taskCount: number;
  /** Phone only -- what a tap on a task's NAME opens. Its identity changes
   * only when the PAGE re-renders (a navigation), never on a drag frame, so
   * it does not cost this component its memoisation. */
  onOpenTask: (taskId: string) => void;
  onGroupCompacted: (result: ShiftResult) => void;
  onGroupCompactEmpty: () => void;
  onGroupCompactError: (err: unknown) => void;
}) {
  return (
    <div className="sticky left-0 z-20 border-r border-slate-200 bg-white" style={{ width: SIDEBAR_WIDTH_CSS, flexShrink: 0 }}>
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
          {/* Only real projects get a compact button -- the standalone group
              (projectId null, "No project") has no project row to sweep:
              compactSchedule (services/scheduling.ts) takes a single
              project id and dependency edges never cross projects
              (addDependency enforces same-project-or-both-standalone), so
              there is no well-defined "compact" over a pool of unrelated
              standalone tasks, same reasoning as the per-project page's own
              isGlobal gate below. */}
          {row.projectId !== null && (
            <GanttGroupCompactButton
              projectId={row.projectId}
              onCompacted={onGroupCompacted}
              onEmpty={onGroupCompactEmpty}
              onError={onGroupCompactError}
            />
          )}
        </div>
      ) : (
        <div
          key={row.key}
          className={clsx(
            "flex items-center truncate border-b border-slate-100 text-xs text-slate-700 max-md:relative",
            row.isChild ? "pl-6 pr-2" : "px-2",
            row.task.status === "done" && "text-slate-400 line-through",
          )}
          style={{ height: ROW_HEIGHT }}
          title={row.task.title}
        >
          {row.task.title}
          {/* The task's NAME as a tap target, phone only. This is the half of
             the pair that needs no panning at all: the sidebar is sticky, so
             a task's name is on screen whatever the timeline is scrolled to,
             and this covers the row it labels. Absent at a desk, where it
             would put a click on a row that has never had one -- the
             positioning it needs is scoped to the phone for the same reason.
             Hidden from assistive technology because the bar it duplicates is
             already a focusable button with a label and an Enter binding;
             this exists for a thumb, and nothing is reachable only here. */}
          <span
            data-testid={`gantt-label-tap-${row.task.id}`}
            aria-hidden="true"
            className="absolute inset-0 hidden max-md:block"
            onClick={() => onOpenTask(row.task.id)}
          />
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
  // The element that called setPointerCapture, kept around so an Escape
  // press (a document-level listener with no PointerEvent of its own -- see
  // the escape-to-cancel effect below) can still releasePointerCapture on
  // the right element.
  captureEl: HTMLDivElement;
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
  // Called unconditionally (hooks can't be conditional) with "" on the
  // global chart, where THIS SPECIFIC button never renders and this mutation
  // is therefore never actually fired -- see its own render-gate below for
  // why one "Remove slack" button has no single meaning across multiple
  // projects. The global chart's own per-group compact buttons (Fix 2,
  // hotfix v0.4.2) are separate GanttGroupCompactButton instances, each with
  // its own useCompactSchedule(realProjectId) -- see Sidebar, below.
  const compactSchedule = useCompactSchedule(isGlobal ? "" : target.projectId);

  const [zoom, setZoom] = useState<Zoom>("day");
  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null);
  const [pendingConnector, setPendingConnector] = useState<PendingConnector | null>(null);
  const [hoveredTargetId, setHoveredTargetIdState] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  // `kind` distinguishes an interactive-drag cascade ("N tasks shifted") from
  // a "Remove slack" sweep ("N tasks compacted") -- same flash/note mechanism
  // (the amber ring on each bar, the one-line note, the 1s auto-clear timer),
  // just a different noun in the note text. "empty" is compact-only: a sweep
  // that moved nothing still gets a brief acknowledgement ("Nothing to
  // compact") rather than the button silently doing nothing from the user's
  // point of view. See triggerFlash/handleCompact below.
  const [flash, setFlash] = useState<{ ids: Set<string>; count: number; kind: "shifted" | "compacted" | "empty" } | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // Purely a rendering signal (see isCommitting below) -- inFlightTaskIdsRef
  // is the actual guard consulted synchronously by handlePointerDown/
  // handleBarKeyDown, kept in a ref rather than this state so those
  // callbacks don't need it in their dependency arrays. The two are always
  // updated together by beginCommit/endCommit.
  const [committingIds, setCommittingIds] = useState<Set<string>>(() => new Set());

  // The scrolling grid box, so the phone's opening scroll can be set on it
  // (see the layout effect below). Nothing else reads it.
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Which pixels-per-day value that opening scroll was last applied for.
  // Not a boolean, because a zoom change makes a scroll offset in the old
  // scale meaningless (day 14 is 420px at day zoom and 180px at week zoom),
  // so the target is re-applied whenever the zoom CHANGES. It holds one
  // value, not a set, so day -> week -> day re-applies on the way back --
  // deliberate (each switch is a fresh request to see the schedule at that
  // scale, and after one you are looking at a different set of columns
  // anyway) and worth stating, because an earlier version of this comment
  // claimed "once per zoom value, never twice for the same one", which is
  // not what one slot can promise. What it does guarantee is the property
  // that matters: no refetch, SSE update or re-render at an UNCHANGED zoom
  // can yank the view out from under a thumb mid-pan.
  const appliedScrollZoomRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoveredTargetRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  // The date pair a pending shift is COMMITTING to -- see the layout effect
  // below for why dragVisual is cleared by watching this land in taskById
  // rather than by the mutation's onSuccess directly.
  const pendingCommitRef = useRef<{ taskId: string; startDate: string; dueDate: string } | null>(null);
  // Tasks with a shiftTask mutation currently in flight -- see this file's
  // doc comment ("SERIALISING SHIFT COMMITS"). Checked synchronously at the
  // START of a new drag/nudge, so a second gesture on the same task never
  // even begins while the first is still settling.
  const inFlightTaskIdsRef = useRef<Set<string>>(new Set());
  // The in-progress keyboard nudge accumulator (geometry.ts's
  // accumulateNudge), and the timer that will commit it after
  // NUDGE_DEBOUNCE_MS of no further keypresses. Null/null when no nudge is
  // accumulating.
  const nudgeRef = useRef<NudgeState | null>(null);
  const nudgeTimerRef = useRef<number | null>(null);
  // Set only while a pointer drag holds capture; lets Escape cancel it from
  // a document-level listener (see the effect below) without one being
  // permanently mounted.
  const escapeHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

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
  // Falls back to the first row not just when nothing has been focused yet,
  // but also when the previously-focused task VANISHES from this payload
  // (filtered out, reassigned, deleted, or simply not present after a
  // refetch) -- otherwise every bar's tabIndex stays -1 forever (each
  // render's ternary below only compares against a stale id nothing
  // matches), stranding keyboard/Tab navigation with no reachable bar at
  // all until a fresh click sets focusedTaskId again.
  const effectiveFocusedId = focusedTaskId !== null && taskById.has(focusedTaskId) ? focusedTaskId : firstTaskId;

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

  // THE PHONE'S OPENING SCROLL (spec Amendment 4). Measured before this
  // existed: computeRange starts the window a fortnight before the earliest
  // task, and a phone has a fraction of the desktop's visible timeline, so
  // the chart opened on padding with no bar in it at all -- read-only
  // shipping as blank. geometry.ts's initialScrollLeft picks the day; this
  // applies it.
  //
  // The width is read IMPERATIVELY, once, at the moment it is needed, which
  // the spec's Amendment 4 permits for the same reason Amendment 1 permits
  // it in the key handler below: it opens no subscription, triggers no
  // re-render and creates no second component tree, and the query still
  // comes from the one place the breakpoint is defined. Desktop is left
  // exactly where it was -- scrolling at every width would be a desktop
  // change, which this phase may not make.
  //
  // A LAYOUT effect, so the offset is in place before the browser paints
  // rather than as a visible jump after it.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null || taskRows.length === 0) return;
    if (appliedScrollZoomRef.current === pxPerDay) return;
    if (!window.matchMedia(mobileMediaQuery()).matches) return;
    appliedScrollZoomRef.current = pxPerDay;
    const bars: { startDay: number; dueDay: number }[] = [];
    for (const row of taskRows) {
      if (row.task.startDate === null || row.task.dueDate === null) continue;
      bars.push({
        startDay: isoToDayIndex(row.task.startDate, rangeStartMs),
        dueDay: isoToDayIndex(row.task.dueDate, rangeStartMs),
      });
    }
    grid.scrollLeft = initialScrollLeft(bars, isoToDayIndex(todayLocalIso(), rangeStartMs), pxPerDay);
  }, [taskRows, pxPerDay, rangeStartMs]);

  const triggerFlash = useCallback((ids: string[], kind: "shifted" | "compacted" | "empty" = "shifted") => {
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
    setFlash({ ids: new Set(ids), count: ids.length, kind });
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlash(null);
      flashTimeoutRef.current = null;
    }, 1000);
  }, []);

  // "Remove slack" -- see queries.ts's useCompactSchedule doc comment for why
  // this has no optimistic patch of its own; the button just waits for the
  // real response and flashes off its `moved` list, exactly like a drag's
  // onSuccess does above/below, just with the "compacted" noun and no single
  // dragged task to exclude from the flash set.
  const handleCompact = useCallback(() => {
    if (!window.confirm("Pull every task to its earliest position? Done and in-progress tasks stay put.")) return;
    compactSchedule.mutate(undefined, {
      onSuccess: (result) => {
        if (result.moved.length > 0) triggerFlash(result.moved.map((m) => m.id), "compacted");
        else triggerFlash([], "empty");
      },
      onError: (err) => setBannerError(err instanceof Error ? err.message : String(err)),
    });
  }, [compactSchedule, triggerFlash]);

  // Fix 2 (hotfix v0.4.2) -- global view reachability: each project group
  // header's own GanttGroupCompactButton owns its own useCompactSchedule
  // mutation (see that component's doc comment for why), but funnels its
  // outcome through these SAME shared handlers the per-project button above
  // uses, so a group sweep flashes the same amber ring / shows the same
  // cascade-note text as any other compact, regardless of which button fired
  // it.
  const handleGroupCompacted = useCallback((result: ShiftResult) => {
    triggerFlash(result.moved.map((m) => m.id), "compacted");
  }, [triggerFlash]);
  const handleGroupCompactEmpty = useCallback(() => triggerFlash([], "empty"), [triggerFlash]);
  const handleGroupCompactError = useCallback((err: unknown) => {
    setBannerError(err instanceof Error ? err.message : String(err));
  }, []);

  useEffect(() => () => {
    if (flashTimeoutRef.current !== null) window.clearTimeout(flashTimeoutRef.current);
    // Deliberately just cancels the timer, not a final flush/commit of
    // whatever was accumulating -- unmounting mid-debounce (navigating away
    // within ~200ms of the last keypress) is rare enough, and losing at most
    // one already-superseded-by-navigation nudge is an acceptable trade
    // against the complexity of a safe post-unmount mutate. Mirrors the
    // flashTimeoutRef cleanup right above.
    if (nudgeTimerRef.current !== null) window.clearTimeout(nudgeTimerRef.current);
    if (escapeHandlerRef.current) document.removeEventListener("keydown", escapeHandlerRef.current);
  }, []);

  // Marks a task's shiftTask commit as in flight (inFlightTaskIdsRef, the
  // guard) and mirrors that into committingIds (state, the render signal
  // isCommitting reads) -- see this file's doc comment. Always paired with
  // endCommit, including on every mutate outcome (onSettled, not just
  // onError), so a task can never get stuck permanently "committing".
  const beginCommit = useCallback((taskId: string) => {
    inFlightTaskIdsRef.current.add(taskId);
    setCommittingIds(new Set(inFlightTaskIdsRef.current));
  }, []);
  const endCommit = useCallback((taskId: string) => {
    inFlightTaskIdsRef.current.delete(taskId);
    setCommittingIds(new Set(inFlightTaskIdsRef.current));
  }, []);

  // Fires the ONE shiftTask call a settled keyboard-nudge accumulator
  // commits to -- shared by the debounce timer (the common case) and by
  // handlePointerDown flushing a same-task nudge early (see below). Mirrors
  // finishDrag's pointer-path commit almost exactly; kept separate rather
  // than unified because the two build their date pair from different
  // inputs (a frozen NudgeState vs. the live DragState ref) and unifying
  // them would need a bigger shared shape for no real gain here.
  const commitNudge = useCallback((pending: NudgeState) => {
    const { startDay, dueDay } = applyOffsetDays(pending.mode, pending.originStartDay, pending.originDueDay, pending.offsetDays);
    const startDate = dayIndexToIso(startDay, pending.rangeStartMs);
    const dueDate = dayIndexToIso(dueDay, pending.rangeStartMs);
    const current = taskById.get(pending.taskId);
    if (startDate === (current?.startDate ?? null) && dueDate === (current?.dueDate ?? null)) {
      // Net-zero accumulation (e.g. Right then Left before the debounce
      // fired, or every keypress clamped at the minimum-duration edge) --
      // nothing to commit. Still clear the visual: it may be frozen on this
      // task's last (non-zero) intermediate offset.
      setDragVisual((current2) => (current2?.taskId === pending.taskId ? null : current2));
      return;
    }
    beginCommit(pending.taskId);
    pendingCommitRef.current = { taskId: pending.taskId, startDate, dueDate };
    setDragVisual({ taskId: pending.taskId, mode: pending.mode, offsetPx: pending.offsetDays * pending.pxPerDay });
    shiftTask.mutate({ id: pending.taskId, startDate, dueDate }, {
      onSuccess: (result) => {
        const cascaded = result.moved.filter((m) => m.id !== pending.taskId).map((m) => m.id);
        if (cascaded.length > 0) triggerFlash(cascaded);
      },
      onError: (err) => {
        // Snap-back path (P3.9 review, fix 1's "accumulation pending"
        // case): useShiftTask's own onError already rolled the QUERY CACHE
        // back to its pre-mutate snapshot, so taskById reverts to the
        // pre-accumulation dates on the next render regardless. What THIS
        // component still owns is the local preview on top of that cache --
        // pendingCommitRef (so the layout effect above doesn't wait forever
        // for dates that are never coming) and dragVisual (the frozen
        // offset) both get cleared here so the bar visibly snaps back to
        // where the cache says it really is. nudgeRef.current is already
        // null by this point -- it was cleared synchronously (see the
        // debounce timeout / takePendingNudge, above) the moment this
        // specific accumulator was handed to commitNudge, well before this
        // async onError could ever fire, so there is no separate "clear the
        // accumulator" step needed here: it never survived past the
        // synchronous handoff into this call.
        pendingCommitRef.current = null;
        setDragVisual(null);
        setBannerError(err instanceof Error ? err.message : String(err));
      },
      onSettled: () => endCommit(pending.taskId),
    });
  }, [taskById, shiftTask, triggerFlash, beginCommit, endCommit]);

  // Cancels the keyboard-nudge debounce timer and, if a nudge is currently
  // accumulating, hands it back so the caller can commit it immediately.
  // Used when a NEW gesture is about to start (a pointer drag, or a nudge on
  // a different task/mode already gets this from accumulateNudge's toFlush)
  // so it never races a still-pending nudge for the dates it's about to
  // touch.
  const takePendingNudge = useCallback((): NudgeState | null => {
    if (nudgeTimerRef.current !== null) {
      window.clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    const pending = nudgeRef.current;
    nudgeRef.current = null;
    return pending;
  }, []);

  // Escape-to-cancel (P3.9 review, fix 3) -- a document-level listener,
  // attached only for the duration of an actual pointer drag (from
  // handlePointerDown) and detached the moment that drag ends one way or
  // another (finishDrag/revertDrag), rather than a listener permanently
  // mounted for the component's whole lifetime doing a no-op check on every
  // keydown anywhere on the page. Declared before revertDrag/attachEscapeListener
  // purely so their dependency arrays below can reference it in initialisation
  // order (it has no dependency on either of them).
  const detachEscapeListener = useCallback(() => {
    if (!escapeHandlerRef.current) return;
    document.removeEventListener("keydown", escapeHandlerRef.current);
    escapeHandlerRef.current = null;
  }, []);

  // Reverts the currently-tracked drag in place: releases pointer capture,
  // discards the local preview, fires NO mutation. This is the cancel path
  // (P3.9 review, fix 3) -- pointercancel and Escape both route here, NEVER
  // to finishDrag, because both mean "this gesture didn't happen" (the OS
  // took the pointer away, or the user explicitly backed out), which is a
  // different outcome from a release/drop that should commit wherever the
  // bar currently sits.
  const revertDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.rafId !== null) {
      cancelAnimationFrame(drag.rafId);
      drag.rafId = null;
    }
    try {
      if (drag.captureEl.hasPointerCapture(drag.pointerId)) drag.captureEl.releasePointerCapture(drag.pointerId);
    } catch {
      // Capture may already be gone (e.g. the element that held it was
      // removed from the DOM by the same re-render this drag caused) --
      // there's nothing left to release in that case, which is fine.
    }
    dragRef.current = null;
    detachEscapeListener();
    if (drag.mode === "dependency") {
      setPendingConnector(null);
      hoveredTargetRef.current = null;
      setHoveredTargetIdState(null);
      return;
    }
    setDragVisual(null);
  }, [detachEscapeListener]);

  const attachEscapeListener = useCallback(() => {
    if (escapeHandlerRef.current) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      revertDrag();
    };
    document.addEventListener("keydown", handler);
    escapeHandlerRef.current = handler;
  }, [revertDrag]);

  // Pointer-cancel handler wired to every drag zone in bar.tsx, separate
  // from finishDrag (pointerup) -- see revertDrag's comment for why cancel
  // must never commit.
  const cancelDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    revertDrag();
  }, [revertDrag]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, task: GanttTask, mode: DragMode) => {
      // A commit already in flight for this task blocks a NEW gesture from
      // starting at all (see this file's doc comment) -- cross-task drags
      // are unaffected.
      if (mode !== "dependency" && inFlightTaskIdsRef.current.has(task.id)) return;
      // A keyboard nudge accumulating on THIS SAME task, not yet committed,
      // would otherwise sit behind a live 200ms timer while a pointer drag
      // also starts changing the same task's dates -- flush it now so the
      // two gestures can never both land a shiftTask for this task at once.
      // (A nudge on a DIFFERENT task is left alone; its own timer is fine.)
      const pendingNudge = nudgeRef.current;
      if (pendingNudge && pendingNudge.taskId === task.id) {
        const flushed = takePendingNudge();
        if (flushed) commitNudge(flushed);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      if (mode === "dependency") {
        const top = rowTop.get(task.id);
        if (top === undefined || task.dueDate === null) return;
        const sourceX = isoToDayIndex(task.dueDate, rangeStartMs) * pxPerDay;
        const sourceY = top + ROW_HEIGHT / 2;
        dragRef.current = {
          taskId: task.id, mode, pointerId: e.pointerId, startClientX: e.clientX,
          originStartDay: 0, originDueDay: 0, pxPerDay, rangeStartMs, pendingOffsetDays: 0, rafId: null,
          captureEl: e.currentTarget,
          sourceX, sourceY, pendingClientX: e.clientX, pendingClientY: e.clientY,
        };
        // Only attach Escape (and only set dragRef, above) once this drag is
        // actually going to be tracked -- an early return past this point
        // (an invalid target) would otherwise leave a document-level
        // listener attached with no drag for it to ever detach on.
        attachEscapeListener();
        setPendingConnector({ x1: sourceX, y1: sourceY, x2: sourceX, y2: sourceY });
        return;
      }
      if (task.startDate === null || task.dueDate === null) return;
      dragRef.current = {
        taskId: task.id, mode, pointerId: e.pointerId, startClientX: e.clientX,
        originStartDay: isoToDayIndex(task.startDate, rangeStartMs),
        originDueDay: isoToDayIndex(task.dueDate, rangeStartMs),
        pxPerDay, rangeStartMs, pendingOffsetDays: 0, rafId: null,
        captureEl: e.currentTarget,
        sourceX: 0, sourceY: 0, pendingClientX: e.clientX, pendingClientY: e.clientY,
      };
      attachEscapeListener();
    },
    [pxPerDay, rangeStartMs, rowTop, commitNudge, takePendingNudge, attachEscapeListener],
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
    detachEscapeListener();

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
    beginCommit(drag.taskId);
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
      onSettled: () => endCommit(drag.taskId),
    });
  }, [addDependency, shiftTask, taskById, triggerFlash, beginCommit, endCommit, detachEscapeListener]);

  // Every keyboard commit goes through the SAME useShiftTask mutation the
  // pointer path uses (see this file's doc comment), but -- unlike a single
  // one-day-per-keypress commit -- now shares the pointer path's
  // render-now/commit-later split too: each keypress only updates dragVisual
  // (accumulateNudge in geometry.ts), and a debounce timer decides when the
  // settled position actually becomes one shiftTask call. See this file's
  // "SERIALISING SHIFT COMMITS" doc comment for the full rationale.
  const handleBarKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>, task: GanttTask) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpenTask(task.id);
      return;
    }
    if (task.startDate === null || task.dueDate === null) return;
    const isHorizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const isVertical = e.key === "ArrowUp" || e.key === "ArrowDown";
    if (!isHorizontal && !isVertical) return;
    // Alt opens OS/browser menus and Ctrl/Cmd are bound to browser history
    // navigation on a plain arrow key -- any modifier other than Shift is
    // left alone so this never fights the OS or the browser chrome.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // A vertical arrow means nothing on a bar without Shift (there's no
    // vertical drag) -- P3.9 review, fix 4, added Shift+Up/Down as the
    // START-edge counterpart to Shift+Left/Right's DUE-edge resize, since
    // vertical arrows were otherwise unused here. A bare vertical arrow is
    // left alone (no preventDefault) rather than swallowed, in case a future
    // feature wants row-to-row vertical navigation.
    if (isVertical && !e.shiftKey) return;
    // BELOW THE BREAKPOINT THE CHART IS READ-ONLY, and this is the one place
    // CSS cannot enforce that: no CSS property stops a key event, and every
    // branch past this line commits a real schedule change (Arrow moves,
    // Shift+Arrow resizes). Because the breakpoint is width-based this also
    // covers a narrowed desktop window and a tablet with a keyboard.
    //
    // An imperative one-shot read, permitted by the spec's Amendment 1 and
    // deliberately NOT the hook: reading here opens no subscription, causes
    // no re-render and builds no second component tree, which is what the
    // three-site cap exists to prevent. The query comes from the same
    // function the hook builds its own from, so CSS and this cannot disagree
    // about where the breakpoint is.
    //
    // Returned WITHOUT preventDefault, unlike every other refusal above, so
    // the arrow key keeps its default action -- which inside a scrolling
    // grid is exactly the pan the phone chart is supposed to have. Enter is
    // handled well above this and still opens the drawer, which is where a
    // phone reschedules.
    if (window.matchMedia(mobileMediaQuery()).matches) return;
    // A commit already in flight for this task ignores further nudges until
    // it resolves -- see this file's doc comment.
    if (inFlightTaskIdsRef.current.has(task.id)) return;
    e.preventDefault();

    let mode: DragMode;
    let delta: number;
    if (isHorizontal) {
      delta = e.key === "ArrowLeft" ? -1 : 1;
      mode = e.shiftKey ? "resize-end" : "move";
    } else {
      delta = e.key === "ArrowUp" ? -1 : 1;
      mode = "resize-start";
    }

    const originStartDay = isoToDayIndex(task.startDate, rangeStartMs);
    const originDueDay = isoToDayIndex(task.dueDate, rangeStartMs);
    const { toFlush, next } = accumulateNudge(nudgeRef.current, {
      taskId: task.id, mode, originStartDay, originDueDay, pxPerDay, rangeStartMs, deltaDays: delta,
    });
    // toFlush is only ever set when this keypress targets a different
    // task/mode than whatever was accumulating -- commit that one now
    // instead of waiting for a timer that's about to be cancelled below.
    if (toFlush) commitNudge(toFlush);
    nudgeRef.current = next;
    setDragVisual({ taskId: next.taskId, mode: next.mode, offsetPx: next.offsetDays * next.pxPerDay });

    if (nudgeTimerRef.current !== null) window.clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = window.setTimeout(() => {
      nudgeTimerRef.current = null;
      const pending = nudgeRef.current;
      nudgeRef.current = null;
      if (pending) commitNudge(pending);
    }, NUDGE_DEBOUNCE_MS);
  }, [onOpenTask, rangeStartMs, pxPerDay, commitNudge]);

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
        <div className="flex flex-wrap items-center gap-2">
          <div data-testid="gantt-zoom" className="flex gap-2">
            <Button variant={zoom === "day" ? "default" : "outline"} onClick={() => setZoom("day")}>Day</Button>
            <Button variant={zoom === "week" ? "default" : "outline"} onClick={() => setZoom("week")}>Week</Button>
          </div>
          {/* Per-project page only, here -- compactSchedule (services/
              scheduling.ts) sweeps ONE project's whole dependency graph at a
              time, so there is no single button that means anything on the
              global chart's multiple unrelated projects. Fix 2 (hotfix
              v0.4.2) makes the global view reachable a different way: each
              project group header in Sidebar gets its OWN "Remove slack"
              button (GanttGroupCompactButton, below), scoped to that one
              group's projectId -- not this button rendering globally. */}
          {!isGlobal && (
            <Button
              data-testid="compact-button"
              variant="outline"
              onClick={handleCompact}
              disabled={compactSchedule.isPending}
            >
              Remove slack
            </Button>
          )}
        </div>
        <div data-testid="cascade-note" aria-live="polite" className="text-xs font-medium text-amber-700">
          {flash
            ? (flash.kind === "empty" ? "Nothing to compact" : `${flash.count} task${flash.count === 1 ? "" : "s"} ${flash.kind}`)
            : ""}
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

      {/* Four phone-only changes ride on this element, all of them layout,
         all of them scoped to below the breakpoint:

         1. A STACKING CONTEXT. Measured at 375px before it was here: this
            grid's own sticky sidebar and header carry z-indices and are not
            portalled, so they outranked the bottom navigation bar -- which
            has no z-index by design, so that portalled overlays land above
            it by DOM order. The bar was not merely painted over: a hit test
            over its Mail tab returned a Gantt row, i.e. the navigation was
            untappable on this page. Confining those z-indices to this box
            puts the bar back on top without giving it a z-index of its own.
         2. THE PAGE'S SIDE PADDING, GIVEN BACK. main carries 24px each side,
            which is 48px of a 375px screen spent on margin around a chart
            that has too little width already.
         3. SQUARE, BORDERLESS SIDES, because a rounded border pushed to the
            screen edge reads as a rendering fault rather than a card.
         4. THE SIDEBAR'S WIDTH, as a custom property this box declares and
            geometry.ts's SIDEBAR_WIDTH_CSS reads. That is the whole trick
            that makes this chart fit a phone: 240px of a 325px-wide grid
            left 85px of timeline -- 2.8 day columns -- and it could not be
            re-scaled by a breakpoint variant, because it was an inline
            JavaScript number. As a custom property the stylesheet can take
            it over, and the desktop value stays the fallback in geometry.ts.
            Measured after: 247px of timeline, 8.2 day columns -- 247 rather
            than 245 because point 3 takes the side borders off too. */}
      <div
        ref={gridRef}
        className="relative overflow-auto rounded-md border border-slate-200 max-md:isolate max-md:-mx-6 max-md:rounded-none max-md:border-x-0 max-md:[--gantt-sidebar-width:8rem]"
        style={{ maxHeight: GRID_MAX_HEIGHT }}
      >
        <div className="flex" style={{ width: `calc(${SIDEBAR_WIDTH_CSS} + ${chartWidth}px)` }}>
          <Sidebar
            rows={rows}
            taskCount={taskRows.length}
            onOpenTask={onOpenTask}
            onGroupCompacted={handleGroupCompacted}
            onGroupCompactEmpty={handleGroupCompactEmpty}
            onGroupCompactError={handleGroupCompactError}
          />
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
                    isCommitting={committingIds.has(row.task.id)}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishDrag}
                    onPointerCancel={cancelDrag}
                    onKeyDown={handleBarKeyDown}
                    onFocus={handleBarFocus}
                  />
                );
              })}
              {/* THE PHONE'S TAP TARGET, and it is the ROW, not the bar (spec
                 Amendment 6). A bar is 22px tall and, for a same-day task at
                 week zoom, 6.4px wide; the row it sits in is the full width
                 of the chart. Growing the bar's own box with negative insets
                 would reach the 44px floor and buy nothing, because at a
                 32px row pitch it only decides which of two overlapping
                 layers wins a 6px band -- it does not improve anyone's aim,
                 and it puts the WRONG task's drawer one tap away. A
                 full-width row target removes the horizontal precision
                 problem outright, which is the thing that actually defeats a
                 6.4px bar, and leaves the vertical at the 32px row pitch --
                 a deliberate, recorded exception to the phase's 44px floor.

                 Rendered after the bars so it takes the tap rather than the
                 bar's own move overlay, which keeps its title text and only
                 gives up its pointers below the breakpoint. Absent at a
                 desk, where a click on a bar has never opened anything and
                 a drag is the whole interaction. Hidden from assistive
                 technology for the same reason as its sidebar twin: the bar
                 is already a focusable button, and Enter on it opens the
                 same drawer. */}
              {taskRows.map((row) => (
                <div
                  key={`tap-${row.task.id}`}
                  data-testid={`gantt-tap-${row.task.id}`}
                  aria-hidden="true"
                  className="absolute left-0 hidden max-md:block"
                  style={{ top: rowTop.get(row.task.id) ?? 0, height: ROW_HEIGHT, width: chartWidth }}
                  onClick={() => onOpenTask(row.task.id)}
                />
              ))}
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
