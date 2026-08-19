import { memo } from "react";
import { clsx } from "clsx";
import { todayLocalIso } from "../../lib";
import {
  HEADER_HEIGHT, MONTH_ABBR, dayIndexToDate, isoToDayIndex,
} from "./geometry";
import type { Zoom } from "./geometry";

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

function buildHeaderCells(zoom: Zoom, pxPerDay: number, rangeStartMs: number, totalDays: number): HeaderCell[] {
  if (zoom === "day") {
    const cells: HeaderCell[] = [];
    for (let d = 0; d < totalDays; d++) {
      const date = dayIndexToDate(d, rangeStartMs);
      const isMonthStart = date.getUTCDate() === 1;
      const label = isMonthStart
        ? `${MONTH_ABBR[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`
        : String(date.getUTCDate());
      cells.push({ key: `d${d}`, left: d * pxPerDay, width: pxPerDay, label, isMonthStart });
    }
    return cells;
  }
  const cells: HeaderCell[] = [];
  const weeks = Math.ceil(totalDays / 7);
  for (let w = 0; w < weeks; w++) {
    const startDayIdx = w * 7;
    const date = dayIndexToDate(startDayIdx, rangeStartMs);
    const label = `${MONTH_ABBR[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`;
    cells.push({
      key: `w${w}`, left: startDayIdx * pxPerDay, width: 7 * pxPerDay, label,
      isMonthStart: date.getUTCDate() <= 7,
    });
  }
  return cells;
}

function buildWeekendCells(zoom: Zoom, pxPerDay: number, rangeStartMs: number, totalDays: number): WeekendCell[] {
  if (zoom !== "day") return [];
  const cells: WeekendCell[] = [];
  for (let d = 0; d < totalDays; d++) {
    const dow = dayIndexToDate(d, rangeStartMs).getUTCDay();
    if (dow === 0 || dow === 6) cells.push({ key: `we${d}`, left: d * pxPerDay, width: pxPerDay });
  }
  return cells;
}

export interface GanttTimescaleProps {
  zoom: Zoom;
  pxPerDay: number;
  rangeStartMs: number;
  totalDays: number;
  chartWidth: number;
}

// Header cells depend only on zoom/pxPerDay/rangeStartMs/totalDays -- none
// of which change during a drag (see chart.tsx: the visible range is
// derived from the server-authoritative task list, not the transient drag
// offset) -- so this bails out of every drag-frame re-render exactly like
// gantt-lab's HeaderRow did.
export const GanttTimescale = memo(function GanttTimescale({
  zoom, pxPerDay, rangeStartMs, totalDays, chartWidth,
}: GanttTimescaleProps) {
  const cells = buildHeaderCells(zoom, pxPerDay, rangeStartMs, totalDays);
  return (
    <div className="sticky top-0 z-10 border-b border-slate-200 bg-white" style={{ height: HEADER_HEIGHT, width: chartWidth }}>
      <div className="relative h-full" style={{ width: chartWidth }}>
        {cells.map((cell) => (
          <div
            key={cell.key}
            className={clsx(
              "absolute top-0 flex h-full items-center justify-center whitespace-nowrap text-[10px] text-slate-500",
              cell.isMonthStart && "font-semibold text-slate-800",
            )}
            style={{ left: cell.left, width: cell.width, borderLeft: cell.isMonthStart ? "1px solid #cbd5e1" : undefined }}
          >
            {cell.label}
          </div>
        ))}
      </div>
    </div>
  );
});

export interface GanttWeekendLayerProps {
  zoom: Zoom;
  pxPerDay: number;
  rangeStartMs: number;
  totalDays: number;
  bodyHeight: number;
}

export const GanttWeekendLayer = memo(function GanttWeekendLayer({
  zoom, pxPerDay, rangeStartMs, totalDays, bodyHeight,
}: GanttWeekendLayerProps) {
  const cells = buildWeekendCells(zoom, pxPerDay, rangeStartMs, totalDays);
  return (
    <>
      {cells.map((cell) => (
        <div key={cell.key} className="absolute top-0 bg-slate-100" style={{ left: cell.left, width: cell.width, height: bodyHeight }} />
      ))}
    </>
  );
});

export interface GanttTodayLineProps {
  rangeStartMs: number;
  totalDays: number;
  pxPerDay: number;
  bodyHeight: number;
}

export const GanttTodayLine = memo(function GanttTodayLine({ rangeStartMs, totalDays, pxPerDay, bodyHeight }: GanttTodayLineProps) {
  // Same isoToDayIndex path every other date in this chart goes through
  // (see geometry.ts) -- Date.now() would give a fractional day (whatever
  // time of day it is right now) and round unpredictably near a local
  // midnight boundary; today's own calendar-day string doesn't.
  const idx = isoToDayIndex(todayLocalIso(), rangeStartMs);
  if (idx < 0 || idx >= totalDays) return null;
  return <div data-testid="gantt-today-line" className="absolute top-0 z-20 w-px bg-red-500" style={{ left: idx * pxPerDay, height: bodyHeight }} />;
});
