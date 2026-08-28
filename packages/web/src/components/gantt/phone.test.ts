import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../test/source";
import {
  DAY_ZOOM_PX_PER_DAY, SCROLL_LEAD_IN_PX, SIDEBAR_WIDTH, SIDEBAR_WIDTH_CSS,
  WEEK_ZOOM_PX_PER_DAY, initialScrollLeft,
} from "./geometry";

/**
 * The Gantt's phone behaviour (Phase 6, Task 5): read-only with pan and
 * zoom, a tap on a row opening the task drawer.
 *
 * Two kinds of test live here. initialScrollLeft is ordinary pure logic. The
 * rest are SOURCE guards, because this repo has no testing-library and a rule
 * that lives in a JSX class string has no other unit-level check at all --
 * the browser half is Task 6's e2e. Each one matches a SPELLING, not a
 * behaviour: a class moved onto a wrapper element, or a handler given the
 * same effect by other means, would satisfy the rule and fail the guard, and
 * the reverse is likelier still. They exist to make a silent deletion loud.
 *
 * Everything that asserts an ABSENCE runs over comment-stripped source, per
 * test/source.ts: this file's subjects are named in prose all over their own
 * comments.
 */

/**
 * Both subjects, COMMENT-STRIPPED ONCE HERE rather than per assertion.
 *
 * Two reasons, and the second is not obvious. The absence assertions need it
 * for the usual reason: this phase's comment discipline means every class
 * these guards look for is also described in prose beside it, and Tailwind's
 * scanner does not know a comment from code either. The element-scoping
 * helper below needs it too -- it finds the nearest element START before its
 * marker, and a comment mentioning any angle-bracketed tag would otherwise
 * BE that element as far as a regex is concerned.
 */
const chartSource = withoutComments(readFileSync(new URL("./chart.tsx", import.meta.url), "utf8"));
const barSource = withoutComments(readFileSync(new URL("./bar.tsx", import.meta.url), "utf8"));

/**
 * The opening tag of the element whose attributes contain `marker`.
 *
 * Scoped to the ELEMENT, not the file, which is the lesson Task 2's quality
 * review paid for: four of its eleven guards passed the mutation they
 * advertised because they were file-scoped, and bar.tsx holds four separate
 * pointer zones whose class strings must differ from each other.
 */
function openingTagAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  // The nearest element START before the marker, whatever kind it is -- the
  // four subjects here are three kinds of element (div, span, button) and
  // one of them changed kind once already.
  const opens = [...source.slice(0, at).matchAll(/<[a-zA-Z]/g)];
  const start = opens[opens.length - 1]?.index;
  const end = source.indexOf(">", at);
  expect(start, `no element around: ${marker}`).toBeDefined();
  expect(end).toBeGreaterThan(start ?? 0);
  return source.slice(start, end);
}

describe("initialScrollLeft", () => {
  it("opens on today when the work is already under way", () => {
    // Bars starting on days 10 and 40, today on day 20: today is inside the
    // span, so today is what the phone opens on.
    expect(initialScrollLeft([10, 40], 20, 10)).toBe(20 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("opens on the FIRST bar when every task is still in the future", () => {
    // Today on day 2, work starting on day 30: opening on today would be
    // opening on empty grid, which is the bug this function exists for.
    expect(initialScrollLeft([30, 45], 2, 10)).toBe(30 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("opens on the LAST bar when every task is in the past", () => {
    // The mirror case: today is months past the end, and the useful view is
    // the tail of the work rather than the empty grid after it.
    expect(initialScrollLeft([10, 25], 400, 10)).toBe(25 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("never returns a negative offset", () => {
    // Day 0 minus the lead-in is negative; a scroll container would clamp it,
    // but the value handed to one should be sane on its own.
    expect(initialScrollLeft([0], 0, DAY_ZOOM_PX_PER_DAY)).toBe(0);
  });

  it("has nothing to scroll to when there are no bars", () => {
    expect(initialScrollLeft([], 14, DAY_ZOOM_PX_PER_DAY)).toBe(0);
  });

  it("scales with the zoom, since a day is a different number of pixels in each", () => {
    const day = initialScrollLeft([14, 40], 20, DAY_ZOOM_PX_PER_DAY);
    const week = initialScrollLeft([14, 40], 20, WEEK_ZOOM_PX_PER_DAY);
    expect(day).toBe(20 * DAY_ZOOM_PX_PER_DAY - SCROLL_LEAD_IN_PX);
    expect(week).toBe(20 * WEEK_ZOOM_PX_PER_DAY - SCROLL_LEAD_IN_PX);
    expect(week).toBeLessThan(day);
  });

  it("does not care what order the bars arrive in", () => {
    expect(initialScrollLeft([40, 10, 25], 20, 10)).toBe(initialScrollLeft([10, 25, 40], 20, 10));
  });
});

describe("the sidebar's width", () => {
  it("keeps the desktop number as the custom property's fallback", () => {
    // The phone override is a breakpoint variant in chart.tsx; anything that
    // does not set the property must still get exactly what shipped.
    expect(SIDEBAR_WIDTH_CSS).toContain(`${SIDEBAR_WIDTH}px`);
    expect(SIDEBAR_WIDTH_CSS.startsWith("var(--")).toBe(true);
  });

  it("is what chart.tsx writes at BOTH places it needs a width", () => {
    // The sidebar's own box and the flex row's total. A raw SIDEBAR_WIDTH at
    // either one silently pins that half to 240 while the other narrows --
    // which renders as a sidebar overlapping the timeline, not as an error.
    expect(chartSource).toContain("width: SIDEBAR_WIDTH_CSS");
    expect(chartSource).toContain("calc(${SIDEBAR_WIDTH_CSS} + ${chartWidth}px)");
    expect(chartSource).not.toContain("SIDEBAR_WIDTH +");
    expect(chartSource).not.toContain("width: SIDEBAR_WIDTH,");
  });
});

describe("the bar's pointer paths below the breakpoint", () => {
  it("neutralises the move overlay rather than removing it", () => {
    // It carries the bar's title text. Hiding it would make the phone chart
    // read-only by making it blank, which is not the same thing.
    const tag = openingTagAround(barSource, 'onPointerDown={(e) => onPointerDown(e, task, "move")}');
    expect(tag).toContain("max-md:pointer-events-none");
    expect(tag).not.toContain("max-md:hidden");
  });

  it("removes both resize strips", () => {
    for (const mode of ["resize-start", "resize-end"]) {
      const tag = openingTagAround(barSource, `onPointerDown={(e) => onPointerDown(e, task, "${mode}")}`);
      expect(tag, mode).toContain("max-md:hidden");
    }
  });

  it("removes the dependency handle", () => {
    const tag = openingTagAround(barSource, 'onPointerDown={(e) => onPointerDown(e, task, "dependency")}');
    expect(tag).toContain("max-md:hidden");
  });
});

describe("the tap targets that replace them", () => {
  it("puts one over the whole chart row and one over the task's name", () => {
    for (const testId of ["gantt-tap-", "gantt-label-tap-"]) {
      const tag = openingTagAround(chartSource, `data-testid={\`${testId}`);
      // Absent at a desk, present below the breakpoint. Both halves matter:
      // the first is the hard requirement, the second is the feature.
      expect(tag, testId).toContain("hidden");
      expect(tag, testId).toContain("max-md:block");
      expect(tag, testId).toContain("aria-hidden");
    }
  });

  it("opens the same task drawer the keyboard already opened", () => {
    // The no-capability-gap claim rests on this being the EXISTING path, not
    // a second one: onOpenTask is what Enter on a bar has always called.
    expect(chartSource.match(/onClick=\{\(\) => onOpenTask\(row\.task\.id\)\}/g) ?? []).toHaveLength(2);
  });
});

describe("Remove slack on a phone", () => {
  it("keeps the per-project button and hides only the per-group one", () => {
    // Spec Amendment 5. The compactor exists nowhere but this chart, so
    // hiding both would have made it desktop-only -- the phase's first real
    // capability exception, which the Definition of done forbids. The
    // per-group button is hidden because it does not FIT a narrowed sidebar,
    // and the same sweep is reachable from that project's own Gantt page.
    const group = openingTagAround(chartSource, "data-testid={`compact-button-${projectId}`}");
    expect(group).toContain("max-md:hidden");
    const perProject = openingTagAround(chartSource, 'data-testid="compact-button"');
    expect(perProject).not.toContain("max-md:hidden");
  });
});

describe("the two imperative breakpoint reads", () => {
  it("are the only ones, and both build their query from the shared helper", () => {
    // Spec Amendments 1 and 4 permit exactly these: the key handler and the
    // opening scroll. A third would be a decision someone has to argue for.
    expect(chartSource.match(/window\.matchMedia\(/g) ?? []).toHaveLength(2);
    expect(chartSource.match(/window\.matchMedia\(mobileMediaQuery\(\)\)\.matches/g) ?? []).toHaveLength(2);
  });

  it("does not reach for the hook, or for anything wearing it as a disguise", () => {
    // The spec rules out a differently-named hook over the hook's own parts
    // -- that would pass the three-site cap by spelling while evading the
    // rule it enforces. Nothing under this directory may subscribe at all.
    for (const source of [chartSource, barSource]) {
      expect(source).not.toContain("useIsMobile");
      expect(source).not.toContain("subscribeToMediaQuery");
      expect(source).not.toContain("readIsMobile");
      expect(source).not.toContain("useSyncExternalStore");
    }
  });

  it("reads the width AFTER Enter has been handled and BEFORE any date changes", () => {
    // Order is the whole behaviour here. Moved to the top of the handler,
    // this read would stop Enter opening the drawer on a phone -- which is
    // the one path the phase's no-capability-gap claim rests on. Moved below
    // accumulateNudge, it would stop nothing at all.
    const handler = chartSource.slice(chartSource.indexOf("const handleBarKeyDown"));
    const enter = handler.indexOf("onOpenTask(task.id)");
    const read = handler.indexOf("window.matchMedia(mobileMediaQuery()).matches");
    const commits = handler.indexOf("accumulateNudge(");
    expect(enter).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(enter);
    expect(commits).toBeGreaterThan(read);
  });
});

describe("the grid box", () => {
  it("confines its own stacking context below the breakpoint", () => {
    // Measured at 375px: this grid's sticky sidebar and header are not
    // portalled and carry z-indices, so they outranked the bottom navigation
    // -- whose z-index is deliberately absent -- and a hit test over its Mail
    // tab returned a Gantt row. The navigation was untappable on this page.
    const tag = openingTagAround(chartSource, "ref={gridRef}");
    expect(tag).toContain("max-md:isolate");
  });

  it("declares the phone's sidebar width on itself", () => {
    const tag = openingTagAround(chartSource, "ref={gridRef}");
    expect(tag).toContain("--gantt-sidebar-width");
  });
});
