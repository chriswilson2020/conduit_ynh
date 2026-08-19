import { memo } from "react";
import type { GanttTask, TaskDependency } from "@conduit/shared";
import { ARROW_STUB, ROW_HEIGHT, isoToDayIndex } from "./geometry";
import type { DragMode } from "./geometry";

export interface PendingConnector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GanttArrowsProps {
  dependencies: TaskDependency[];
  taskById: Map<string, GanttTask>;
  rowTop: Map<string, number>;
  pxPerDay: number;
  rangeStartMs: number;
  chartWidth: number;
  bodyHeight: number;
  draggingTaskId: string | null;
  dragMode: DragMode | null;
  dragOffsetPx: number;
  pendingConnector: PendingConnector | null;
}

// Elbow connector from a predecessor's end to a successor's start. The
// simple three-segment form (right, down/up, right) covers the common
// forward case; when the successor starts too close to (or before) the
// predecessor's end for that to read cleanly, route out-and-around instead
// so the line never runs backward through the bars it connects. Identical
// to gantt-lab's elbowPath.
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
  depId: string;
  predId: string;
  succId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isActive: boolean;
}

// Memoised on plain numbers (x1/y1/x2/y2), not on the predecessor/successor
// TASK OBJECTS the way gantt-lab's ArrowPath was. Deliberate deviation --
// see chart.tsx's doc comment for the full reasoning: primitives compare by
// value (Object.is(5, 5) is true regardless of how many times 5 was
// recomputed), so passing the four already-resolved coordinates is just as
// safe a memo key as an object reference, without depending on the caller
// preserving referential identity for every untouched task. The bailout
// behaviour for the ~148 arrows untouched by a given drag is identical.
const ArrowPath = memo(function ArrowPath({ predId, succId, x1, y1, x2, y2, isActive }: ArrowPathProps) {
  return (
    <path
      data-testid={`gantt-arrow-${predId}-${succId}`}
      d={elbowPath(x1, y1, x2, y2)}
      fill="none"
      stroke={isActive ? "#d97706" : "#94a3b8"}
      strokeWidth={isActive ? 2 : 1.25}
      markerEnd="url(#gantt-arrowhead)"
    />
  );
});

/**
 * SVG overlay: one <svg> covering the whole chart body, drawn once per
 * render (this component itself is NOT memoised -- it must re-run every
 * drag frame to recompute which two or so arrows touch the dragged task),
 * delegating the actual per-arrow path element to the memoised ArrowPath
 * above so the ~148 arrows NOT touched by the current drag skip real
 * re-render work. See chart.tsx's doc comment for how dragOffsetPx is
 * threaded down from the lifted drag state without touching task objects.
 */
export function GanttArrows({
  dependencies, taskById, rowTop, pxPerDay, rangeStartMs, chartWidth, bodyHeight,
  draggingTaskId, dragMode, dragOffsetPx, pendingConnector,
}: GanttArrowsProps) {
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={chartWidth}
      height={bodyHeight}
      data-testid="gantt-arrows"
    >
      <defs>
        <marker
          id="gantt-arrowhead"
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
        if (!pred || !succ || pred.dueDate === null || succ.startDate === null) return null;
        const predTop = rowTop.get(pred.id);
        const succTop = rowTop.get(succ.id);
        if (predTop === undefined || succTop === undefined) return null;

        let x1 = isoToDayIndex(pred.dueDate, rangeStartMs) * pxPerDay;
        // Move shifts both dates by the same delta, so the trailing (due)
        // edge moves too; resize-end drags the due edge directly. A
        // resize-start on the predecessor doesn't touch its due date, so
        // the arrow's origin stays put.
        if (pred.id === draggingTaskId && (dragMode === "move" || dragMode === "resize-end")) x1 += dragOffsetPx;
        let x2 = isoToDayIndex(succ.startDate, rangeStartMs) * pxPerDay;
        if (succ.id === draggingTaskId && (dragMode === "move" || dragMode === "resize-start")) x2 += dragOffsetPx;

        const y1 = predTop + ROW_HEIGHT / 2;
        const y2 = succTop + ROW_HEIGHT / 2;
        const isActive = pred.id === draggingTaskId || succ.id === draggingTaskId;

        return (
          <ArrowPath
            key={dep.id}
            depId={dep.id}
            predId={pred.id}
            succId={succ.id}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            isActive={isActive}
          />
        );
      })}
      {pendingConnector && (
        <line
          data-testid="gantt-pending-connector"
          x1={pendingConnector.x1}
          y1={pendingConnector.y1}
          x2={pendingConnector.x2}
          y2={pendingConnector.y2}
          stroke="#d97706"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      )}
    </svg>
  );
}
