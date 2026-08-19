import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clsx } from "clsx";
import { Button } from "../components/ui/button";

/**
 * G0 -- the Gantt prototype gate (docs/superpowers/plans/2026-08-19-conduit-
 * phase-3-projects-gantt.md, Task 1). THROWAWAY: synthetic data only, no API
 * calls, registered in router.tsx but linked from no nav -- Task 9 deletes
 * this file (and its route) once the real Gantt ships, win or lose the gate.
 *
 * Purpose: answer one question honestly -- can a raw-pointer-event,
 * dnd-kit-free CSS/SVG timeline stay smooth at 200 rows / 150 dependency
 * arrows, or does Phase 3's Gantt need a commercial component instead? See
 * this page's in-app perf readout (drag a bar, read "Last drag: ...") for
 * the frame-timing numbers behind that call, and the coordinator's report
 * for the criterion-by-criterion verdict.
 *
 * Performance approach (carries forward into Task 9 regardless of verdict):
 * a single `tasks` array is the source of truth, mutated immutably one
 * element at a time so every OTHER task keeps its exact object reference
 * across a drag frame. Bar and ArrowPath are wrapped in React.memo keyed on
 * those references (plus the shared, never-recreated `rowTop` Map), so a
 * pointermove during a drag triggers real re-render work for exactly one
 * Bar and the handful of ArrowPaths whose predecessor or successor is the
 * dragged task -- not all 200 bars / 150 arrows. Sidebar, HeaderRow and
 * WeekendLayer take no per-drag props at all and are memoized to bail out
 * entirely. This is not a trick to force a pass: any React-state-driven
 * timeline of this size needs this level of memoization to be viable, buy
 * or build, and Task 9 should treat it as the baseline, not an optional
 * enhancement.
 *
 * Keyboard-accessibility plan for the real build (criterion 4 -- written
 * plan only, nothing below is implemented in this throwaway page): each bar
 * becomes a natively focusable element (tabIndex=0, roving so Tab reaches
 * "wherever focus last was" rather than always row 0) with an aria-label
 * combining the task name and its current start/due dates so a screen
 * reader announces state on focus; ArrowLeft/ArrowRight nudge the whole bar
 * by one day (both dates shift, mirroring a body-drag move), and a
 * modifier held on ArrowLeft/ArrowRight resizes the trailing edge by one day
 * per press (mirroring the right-edge-resize handle) with a second modifier
 * combo covering the leading edge -- exact key combo TBD in Task 9 to dodge
 * OS/browser shortcut collisions, but "arrow nudge on a focused bar" is the
 * core mechanic either way. Every key press commits immediately through the
 * same shiftTask call the pointer path uses (no drag-preview state to
 * throttle), so cascade/events/SSE stay one code path instead of forking
 * pointer vs. keyboard business logic, and the rAF-throttle machinery this
 * page uses for continuous pointer drags is simply irrelevant to the
 * keyboard path -- there is no lag risk there to design around. Enter/Space
 * opens the task drawer for exact date entry (the precise alternative to
 * per-day nudging); Escape returns focus to the grid.
 */

type DragMode = "move" | "resize-start" | "resize-end";

interface TaskDatum {
  id: string;
  groupId: string;
  name: string;
  startDay: number;
  dueDay: number;
}

interface GroupTaskRef {
  id: string;
  name: string;
}

interface GroupDatum {
  id: string;
  name: string;
  tasks: GroupTaskRef[];
}

interface DependencyDatum {
  id: string;
  predecessorId: string;
  successorId: string;
}

interface GanttData {
  tasks: TaskDatum[];
  groups: GroupDatum[];
  dependencies: DependencyDatum[];
}

interface DragState {
  taskId: string;
  mode: DragMode;
  pointerId: number;
  startClientX: number;
  originStart: number;
  originDue: number;
  pxPerDay: number;
  pendingDays: number;
  rafId: number | null;
  frameTimestamps: number[];
}

interface DragStats {
  frames: number;
  avgMs: number;
  maxMs: number;
  dropped: number;
  droppedPct: number;
}

interface HeaderCell {
  key: string;
  left: number;
  width: number;
  label: string;
  isMonthStart: boolean;
}

interface WeekendCell {
  key: string;
  left: number;
  width: number;
}

const ROW_HEIGHT = 28;
const GROUP_HEADER_HEIGHT = 26;
const HEADER_HEIGHT = 36;
const SIDEBAR_WIDTH = 220;
const GRID_MAX_HEIGHT = 640;

const GROUP_COUNT = 8;
const TASKS_PER_GROUP = 25;
const TASK_COUNT = GROUP_COUNT * TASKS_PER_GROUP;
const DEPENDENCY_COUNT = 150;

// A day grid over roughly six months, per the plan's "6-month day grid".
const TOTAL_DAYS = 183;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_ZOOM_PX_PER_DAY = 30;
// Week zoom shows ~26 columns across the same range (183 / 7 ~= 26), each a
// fixed 90px wide -- narrow enough to scroll the whole range without huge
// horizontal distance, wide enough to hold a "Mon D" label.
const WEEK_COL_WIDTH = 90;
const WEEK_ZOOM_PX_PER_DAY = WEEK_COL_WIDTH / 7;

const ARROW_STUB = 10;
// Frame deltas above ~1.5x a 60Hz frame budget (16.7ms) count as a dropped
// frame for the on-page readout -- a looser bar than "any frame over 16.7ms"
// so a single GC blip doesn't dominate the count, closer to "did the user
// likely perceive a stutter."
const DROPPED_FRAME_THRESHOLD_MS = 16.7 * 1.5;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const GROUP_NAMES = [
  "Discovery", "Design", "Backend", "Frontend",
  "Integrations", "Data & Reporting", "QA & Hardening", "Rollout",
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

// Anchored two weeks before "today" (computed once, at module load) so the
// synthetic six-month window shows a mix of past, current and future bars on
// first paint instead of making Chris scroll to find anything relevant.
const RANGE_START_MS = utcMidnight(new Date()) - 14 * DAY_MS;

function dayIndexToDate(dayIndex: number): Date {
  return new Date(RANGE_START_MS + dayIndex * DAY_MS);
}

function todayDayIndex(): number {
  return Math.round((utcMidnight(new Date()) - RANGE_START_MS) / DAY_MS);
}

// Deterministic PRNG (mulberry32) so the synthetic layout is stable across
// reloads -- Chris trying the same page twice sees the same 200 tasks, not a
// freshly shuffled board each time.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateGanttData(seed: number): GanttData {
  const rand = mulberry32(seed);
  const tasks: TaskDatum[] = [];
  const groups: GroupDatum[] = [];
  let taskSeq = 0;

  for (let g = 0; g < GROUP_COUNT; g++) {
    const groupId = `g${g}`;
    const groupName = GROUP_NAMES[g] ?? `Group ${g + 1}`;
    const groupTasks: GroupTaskRef[] = [];
    // Stagger each group's starting point across the first half of the
    // window so groups overlap the way real concurrent workstreams do,
    // rather than laying out as 8 back-to-back blocks.
    let cursor = Math.floor((g / GROUP_COUNT) * TOTAL_DAYS * 0.5);
    for (let i = 0; i < TASKS_PER_GROUP; i++) {
      const duration = 2 + Math.floor(rand() * 10);
      const gap = Math.floor(rand() * 4);
      const startDay = clamp(cursor + gap, 0, TOTAL_DAYS - duration - 1);
      const dueDay = startDay + duration;
      const id = `t${taskSeq}`;
      const name = `${groupName} ${i + 1}`;
      tasks.push({ id, groupId, name, startDay, dueDay });
      groupTasks.push({ id, name });
      taskSeq += 1;
      cursor = startDay + Math.max(1, Math.floor(duration * 0.6));
    }
    groups.push({ id: groupId, name: groupName, tasks: groupTasks });
  }

  // 150 synthetic FS pairs, biased toward tasks that start near each other
  // in time so most arrows are short -- with a handful of longer ones for a
  // realistic mix, since a real project graph is not all-adjacent either.
  const sortedByStart = [...tasks].sort((a, b) => a.startDay - b.startDay);
  const dependencies: DependencyDatum[] = [];
  const seenPairs = new Set<string>();
  let attempts = 0;
  while (dependencies.length < DEPENDENCY_COUNT && attempts < DEPENDENCY_COUNT * 30) {
    attempts += 1;
    const i = Math.floor(rand() * (sortedByStart.length - 1));
    const span = 1 + Math.floor(rand() * 9);
    const j = Math.min(sortedByStart.length - 1, i + span);
    if (i === j) continue;
    const pred = sortedByStart[i];
    const succ = sortedByStart[j];
    if (!pred || !succ) continue;
    const key = `${pred.id}->${succ.id}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    dependencies.push({ id: `dep${dependencies.length}`, predecessorId: pred.id, successorId: succ.id });
  }

  return { tasks, groups, dependencies };
}

// Row y-offsets depend only on group/task ORDER, which never changes after
// generation (only dates change, via drag) -- computed once and reused for
// the lifetime of the page, shared by the sidebar's normal document flow and
// the chart pane's absolutely positioned bars/arrows so the two stay pixel-
// aligned without either one measuring the other.
function buildRowTop(groups: GroupDatum[]): { rowTop: Map<string, number>; bodyHeight: number } {
  const rowTop = new Map<string, number>();
  let y = 0;
  for (const group of groups) {
    y += GROUP_HEADER_HEIGHT;
    for (const task of group.tasks) {
      rowTop.set(task.id, y);
      y += ROW_HEIGHT;
    }
  }
  return { rowTop, bodyHeight: y };
}

function summarizeFrameTimestamps(timestamps: number[]): DragStats | null {
  if (timestamps.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (prev === undefined || cur === undefined) continue;
    deltas.push(cur - prev);
  }
  if (deltas.length === 0) return null;
  const dropped = deltas.filter((d) => d > DROPPED_FRAME_THRESHOLD_MS).length;
  const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  const max = Math.max(...deltas);
  return { frames: timestamps.length, avgMs: avg, maxMs: max, dropped, droppedPct: (dropped / deltas.length) * 100 };
}

// Elbow connector from a predecessor's end to a successor's start. The
// simple three-segment form (right, down/up, right) covers the common
// forward case; when the successor starts too close to (or before) the
// predecessor's end for that to read cleanly, route out-and-around instead
// so the line never runs backward through the bars it connects.
function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 - x1 >= ARROW_STUB * 2) {
    const midX = x1 + ARROW_STUB;
    return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2 - 4} ${y2}`;
  }
  const outX = x1 + ARROW_STUB;
  const inX = x2 - ARROW_STUB;
  const midY = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} L ${outX} ${y1} L ${outX} ${midY} L ${inX} ${midY} L ${inX} ${y2} L ${x2 - 4} ${y2}`;
}

interface ArrowPathProps {
  pred: TaskDatum;
  succ: TaskDatum;
  pxPerDay: number;
  rowTop: Map<string, number>;
  isActive: boolean;
}

const ArrowPath = memo(function ArrowPath({ pred, succ, pxPerDay, rowTop, isActive }: ArrowPathProps) {
  const predTop = rowTop.get(pred.id);
  const succTop = rowTop.get(succ.id);
  if (predTop === undefined || succTop === undefined) return null;
  const x1 = pred.dueDay * pxPerDay;
  const y1 = predTop + ROW_HEIGHT / 2;
  const x2 = succ.startDay * pxPerDay;
  const y2 = succTop + ROW_HEIGHT / 2;
  return (
    <path
      d={elbowPath(x1, y1, x2, y2)}
      fill="none"
      stroke={isActive ? "#d97706" : "#94a3b8"}
      strokeWidth={isActive ? 2 : 1.25}
      markerEnd="url(#gantt-lab-arrowhead)"
    />
  );
});

interface BarProps {
  task: TaskDatum;
  pxPerDay: number;
  top: number;
  isDragging: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, task: TaskDatum, mode: DragMode) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

const Bar = memo(function Bar({ task, pxPerDay, top, isDragging, onPointerDown, onPointerMove, onPointerUp }: BarProps) {
  const left = task.startDay * pxPerDay;
  const width = Math.max(pxPerDay * 0.6, (task.dueDay - task.startDay) * pxPerDay);
  return (
    <div
      data-testid={`gantt-lab-bar-${task.id}`}
      className={clsx(
        "absolute rounded-sm text-[10px] leading-none text-white shadow-sm",
        isDragging ? "z-30 bg-amber-500" : "z-0 bg-slate-600",
      )}
      style={{ left, width, top, height: ROW_HEIGHT - 8 }}
      title={`${task.name}: day ${task.startDay} to day ${task.dueDay}`}
    >
      <div
        className="absolute inset-0 flex cursor-grab items-center overflow-hidden px-1.5 active:cursor-grabbing"
        onPointerDown={(e) => onPointerDown(e, task, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="truncate">{task.name}</span>
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
    </div>
  );
});

// No per-drag props at all -- groups are generated once and never change, so
// this bails out of every re-render the drag loop causes on the page above.
const Sidebar = memo(function Sidebar({ groups }: { groups: GroupDatum[] }) {
  return (
    <div className="sticky left-0 z-20 border-r border-slate-200 bg-white" style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }}>
      <div
        className="sticky top-0 z-30 flex items-center border-b border-slate-200 bg-white px-2 text-xs font-semibold text-slate-500"
        style={{ height: HEADER_HEIGHT }}
      >
        {`Tasks (${TASK_COUNT})`}
      </div>
      {groups.map((group) => (
        <div key={group.id}>
          <div
            className="flex items-center border-b border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-600"
            style={{ height: GROUP_HEADER_HEIGHT }}
          >
            {group.name}
          </div>
          {group.tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center truncate border-b border-slate-100 px-2 text-xs text-slate-700"
              style={{ height: ROW_HEIGHT }}
              title={task.name}
            >
              {task.name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

const HeaderRow = memo(function HeaderRow({ cells, chartWidth }: { cells: HeaderCell[]; chartWidth: number }) {
  return (
    <div
      className="sticky top-0 z-10 border-b border-slate-200 bg-white"
      style={{ height: HEADER_HEIGHT, width: chartWidth }}
    >
      <div className="relative h-full" style={{ width: chartWidth }}>
        {cells.map((cell) => (
          <div
            key={cell.key}
            className={clsx(
              "absolute top-0 flex h-full items-center justify-center whitespace-nowrap text-[10px] text-slate-500",
              cell.isMonthStart && "font-semibold text-slate-800",
            )}
            style={{
              left: cell.left,
              width: cell.width,
              borderLeft: cell.isMonthStart ? "1px solid #cbd5e1" : undefined,
            }}
          >
            {cell.label}
          </div>
        ))}
      </div>
    </div>
  );
});

const WeekendLayer = memo(function WeekendLayer({ cells, bodyHeight }: { cells: WeekendCell[]; bodyHeight: number }) {
  return (
    <>
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="absolute top-0 bg-slate-100"
          style={{ left: cell.left, width: cell.width, height: bodyHeight }}
        />
      ))}
    </>
  );
});

const TodayLine = memo(function TodayLine({ left, bodyHeight }: { left: number | null; bodyHeight: number }) {
  if (left === null) return null;
  return <div className="absolute top-0 z-20 w-px bg-red-500" style={{ left, height: bodyHeight }} />;
});

export function GanttLabPage() {
  const [data] = useState<GanttData>(() => generateGanttData(42));
  const [tasks, setTasks] = useState<TaskDatum[]>(data.tasks);
  const [zoom, setZoom] = useState<"day" | "week">("day");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [lastDragStats, setLastDragStats] = useState<DragStats | null>(null);

  const groups = data.groups;
  const dependencies = data.dependencies;

  const { rowTop, bodyHeight } = useMemo(() => buildRowTop(groups), [groups]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);

  const pxPerDay = zoom === "day" ? DAY_ZOOM_PX_PER_DAY : WEEK_ZOOM_PX_PER_DAY;
  const chartWidth = TOTAL_DAYS * pxPerDay;

  const headerCells = useMemo<HeaderCell[]>(() => {
    if (zoom === "day") {
      const cells: HeaderCell[] = [];
      for (let d = 0; d < TOTAL_DAYS; d++) {
        const date = dayIndexToDate(d);
        const isMonthStart = date.getUTCDate() === 1;
        const label = isMonthStart
          ? `${MONTH_ABBR[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`
          : String(date.getUTCDate());
        cells.push({ key: `d${d}`, left: d * pxPerDay, width: pxPerDay, label, isMonthStart });
      }
      return cells;
    }
    const cells: HeaderCell[] = [];
    const weeks = Math.ceil(TOTAL_DAYS / 7);
    for (let w = 0; w < weeks; w++) {
      const startDayIdx = w * 7;
      const date = dayIndexToDate(startDayIdx);
      const label = `${MONTH_ABBR[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`;
      cells.push({
        key: `w${w}`,
        left: startDayIdx * pxPerDay,
        width: 7 * pxPerDay,
        label,
        isMonthStart: date.getUTCDate() <= 7,
      });
    }
    return cells;
  }, [zoom, pxPerDay]);

  const weekendCells = useMemo<WeekendCell[]>(() => {
    if (zoom !== "day") return [];
    const cells: WeekendCell[] = [];
    for (let d = 0; d < TOTAL_DAYS; d++) {
      const dow = dayIndexToDate(d).getUTCDay();
      if (dow === 0 || dow === 6) cells.push({ key: `we${d}`, left: d * pxPerDay, width: pxPerDay });
    }
    return cells;
  }, [zoom, pxPerDay]);

  const todayLeft = useMemo(() => {
    const idx = todayDayIndex();
    if (idx < 0 || idx >= TOTAL_DAYS) return null;
    return idx * pxPerDay;
  }, [pxPerDay]);

  const dragRef = useRef<DragState | null>(null);

  // Every OTHER task keeps its exact object reference (see the memoization
  // comment at the top of this file) -- only the dragged task's element is
  // ever replaced.
  const applyDrag = useCallback(
    (taskId: string, mode: DragMode, originStart: number, originDue: number, deltaDays: number) => {
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== taskId) return t;
          const duration = originDue - originStart;
          if (mode === "move") {
            const startDay = clamp(originStart + deltaDays, 0, TOTAL_DAYS - duration - 1);
            return { ...t, startDay, dueDay: startDay + duration };
          }
          if (mode === "resize-start") {
            const startDay = clamp(originStart + deltaDays, 0, originDue - 1);
            return { ...t, startDay, dueDay: originDue };
          }
          const dueDay = clamp(originDue + deltaDays, originStart + 1, TOTAL_DAYS - 1);
          return { ...t, startDay: originStart, dueDay };
        }),
      );
    },
    [],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, task: TaskDatum, mode: DragMode) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        taskId: task.id,
        mode,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        originStart: task.startDay,
        originDue: task.dueDay,
        pxPerDay,
        pendingDays: 0,
        rafId: null,
        frameTimestamps: [],
      };
      setDraggingTaskId(task.id);
      setLastDragStats(null);
    },
    [pxPerDay],
  );

  // rAF-throttled: pointermove can fire far faster than the display refreshes
  // (especially with a high-polling-rate mouse), so only the LATEST pending
  // delta before each animation frame actually triggers a state update.
  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const deltaDays = Math.round((e.clientX - drag.startClientX) / drag.pxPerDay);
      if (deltaDays === drag.pendingDays) return;
      drag.pendingDays = deltaDays;
      if (drag.rafId !== null) return;
      drag.rafId = requestAnimationFrame((frameTime) => {
        const active = dragRef.current;
        if (!active) return;
        active.rafId = null;
        active.frameTimestamps.push(frameTime);
        applyDrag(active.taskId, active.mode, active.originStart, active.originDue, active.pendingDays);
      });
    },
    [applyDrag],
  );

  const finishDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.rafId !== null) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = null;
      }
      // Apply the final pending delta immediately rather than waiting on a
      // possibly-cancelled rAF, so the drop position always matches where
      // the pointer actually released.
      applyDrag(drag.taskId, drag.mode, drag.originStart, drag.originDue, drag.pendingDays);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const stats = summarizeFrameTimestamps(drag.frameTimestamps);
      dragRef.current = null;
      setDraggingTaskId(null);
      if (stats) {
        setLastDragStats(stats);
        // The perf verdict for this spike is read off these numbers, both
        // here and in devtools -- see the module doc comment above.
        console.info("[gantt-lab] drag frame stats", stats);
      }
    },
    [applyDrag],
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Gantt lab (throwaway spike)</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          G0 prototype gate: 200 synthetic tasks across 8 groups, 150 synthetic finish-to-start
          dependencies, raw pointer-event drag/resize (no dnd-kit). Not linked from navigation, not
          wired to the API. Drag a bar body to move it, its left/right 6px edges to resize.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div data-testid="gantt-lab-zoom" className="flex gap-2">
          <Button variant={zoom === "day" ? "default" : "outline"} onClick={() => setZoom("day")}>
            Day zoom
          </Button>
          <Button variant={zoom === "week" ? "default" : "outline"} onClick={() => setZoom("week")}>
            Week zoom
          </Button>
        </div>
        <div
          data-testid="gantt-lab-perf"
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600"
        >
          {lastDragStats ? (
            <>
              {"Last drag: "}
              {lastDragStats.frames}
              {" frames, avg "}
              {lastDragStats.avgMs.toFixed(1)}
              {"ms, max "}
              {lastDragStats.maxMs.toFixed(1)}
              {"ms, dropped "}
              {lastDragStats.dropped}
              {" ("}
              {lastDragStats.droppedPct.toFixed(0)}
              {"%)"}
            </>
          ) : (
            "Drag a bar to measure frame timing"
          )}
        </div>
      </div>

      <div className="relative overflow-auto rounded-md border border-slate-200" style={{ maxHeight: GRID_MAX_HEIGHT }}>
        <div className="flex" style={{ width: SIDEBAR_WIDTH + chartWidth }}>
          <Sidebar groups={groups} />
          <div className="relative" style={{ width: chartWidth, flexShrink: 0 }}>
            <HeaderRow cells={headerCells} chartWidth={chartWidth} />
            <div className="relative" style={{ width: chartWidth, height: bodyHeight }}>
              <WeekendLayer cells={weekendCells} bodyHeight={bodyHeight} />
              <TodayLine left={todayLeft} bodyHeight={bodyHeight} />
              {tasks.map((task) => (
                <Bar
                  key={task.id}
                  task={task}
                  pxPerDay={pxPerDay}
                  top={(rowTop.get(task.id) ?? 0) + 4}
                  isDragging={task.id === draggingTaskId}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishDrag}
                />
              ))}
              <svg
                className="pointer-events-none absolute left-0 top-0"
                width={chartWidth}
                height={bodyHeight}
                data-testid="gantt-lab-arrows"
              >
                <defs>
                  <marker
                    id="gantt-lab-arrowhead"
                    viewBox="0 0 8 8"
                    refX="6"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8" />
                  </marker>
                </defs>
                {dependencies.map((dep) => {
                  const pred = taskById.get(dep.predecessorId);
                  const succ = taskById.get(dep.successorId);
                  if (!pred || !succ) return null;
                  return (
                    <ArrowPath
                      key={dep.id}
                      pred={pred}
                      succ={succ}
                      pxPerDay={pxPerDay}
                      rowTop={rowTop}
                      isActive={pred.id === draggingTaskId || succ.id === draggingTaskId}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
