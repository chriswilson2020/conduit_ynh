import { readFileSync, readdirSync } from "node:fs";
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
const timescaleSource = withoutComments(readFileSync(new URL("./timescale.tsx", import.meta.url), "utf8"));

/**
 * Every non-test source in this directory, comment-stripped, as [name,
 * source] pairs -- so the guards that enforce a PHASE-WIDE rule count over
 * the phase's whole surface here rather than over the one file that happens
 * to break it today.
 */
const ganttSources: [string, string][] = readdirSync(new URL("./", import.meta.url))
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .sort()
  .map((name) => [name, withoutComments(readFileSync(new URL(name, import.meta.url), "utf8"))]);

/**
 * The opening tag of the element whose attributes contain `marker`.
 *
 * Scoped to the ELEMENT, not the file, which is the lesson Task 2's quality
 * review paid for: four of its eleven guards passed the mutation they
 * advertised because they were file-scoped, and bar.tsx holds four separate
 * pointer zones whose class strings must differ from each other.
 *
 * IT INHERITS THAT ROUND'S OTHER LESSON AS A LIVE HAZARD: the slice ends at
 * the first `>` after the marker, and an arrow function in a later attribute
 * contains one -- both tap layers carry `onClick={() => ...}`. Today every
 * subject spells `className` before any such attribute, so the slice always
 * reaches it. Reorder them and `classesOf` below returns an EMPTY list, at
 * which point positive assertions fail with a confusing message and negative
 * ones pass while guarding nothing. If you move a `className`, run the
 * mutations in this file's DONE block rather than trusting the green.
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

/**
 * That element's className as a LIST OF CLASS NAMES.
 *
 * Every class assertion below goes through this rather than through a
 * substring match on the tag, and the difference is not pedantry -- it is the
 * hole the spec review found and the worst near-miss of this task. The tag
 * slice contains `aria-hidden="true"`, so a substring test for the utility
 * `hidden` PASSED ON THAT ATTRIBUTE: deleting the base class from both tap
 * layers -- which puts a full-width, click-handling rectangle over every row
 * of the DESKTOP chart, killing drag-to-reschedule, resize and dependency
 * dragging outright -- left all three assertions green. Nothing else in the
 * repo would have caught it either: the suite has no pointer-drag coverage of
 * the Gantt at all, at any viewport.
 *
 * A class LIST cannot be satisfied by an attribute that merely contains the
 * word, and it cannot be satisfied by a longer class that contains the
 * shorter one either -- `max-md:hidden` is not `hidden`, which a substring
 * match also could not tell apart.
 *
 * Returns an empty list for an element with no className at all, which is a
 * real case here: one of the two subjects of the Remove-slack guard is a
 * `Button` that carries none.
 */
function classesOf(source: string, marker: string): string[] {
  const className = /className="([^"]*)"/.exec(openingTagAround(source, marker));
  return (className?.[1] ?? "").split(/\s+/).filter(Boolean);
}

describe("initialScrollLeft", () => {
  /** A bar, as this function sees one: both of its ends. */
  const bar = (startDay: number, dueDay: number) => ({ startDay, dueDay });

  it("opens on today when the work is already under way", () => {
    // Bars spanning days 10-15 and 40-45, today on day 20: today is inside
    // the span, so today is what the phone opens on.
    expect(initialScrollLeft([bar(10, 15), bar(40, 45)], 20, 10)).toBe(20 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("opens on the EARLIEST START when every task is still in the future", () => {
    // Today on day 2, work starting on day 30: opening on today would be
    // opening on empty grid, which is the bug this function exists for.
    expect(initialScrollLeft([bar(30, 33), bar(45, 50)], 2, 10)).toBe(30 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("opens on the LATEST DUE when every task has finished", () => {
    // The mirror case: today is months past the end, and the useful view is
    // the tail of the work rather than the empty grid after it.
    expect(initialScrollLeft([bar(10, 12), bar(20, 25)], 400, 10)).toBe(25 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("stays on TODAY while a task is still running, though every task has STARTED", () => {
    // THE CASE AN EARLIER VERSION GOT WRONG, and the one an ordinary
    // mid-project chart is in: every task begun, one still running. Bounding
    // the clamp by the latest START made "today is past the end" true while
    // the work was still going on, and the chart opened on the last start --
    // measured 58 days and roughly 1740px behind today, with the today line
    // off screen, which is the very failure the clamp exists to prevent.
    const bars = [bar(0, 5), bar(3, 12), bar(8, 40)];
    expect(initialScrollLeft(bars, 30, 30)).toBe(30 * 30 - SCROLL_LEAD_IN_PX);
  });

  it("takes its upper bound from the longest bar, not the last one to start", () => {
    // A long task that started early can outlast one that started later.
    const bars = [bar(0, 90), bar(10, 12)];
    expect(initialScrollLeft(bars, 60, 10)).toBe(60 * 10 - SCROLL_LEAD_IN_PX);
  });

  it("never returns a negative offset", () => {
    // Day 0 minus the lead-in is negative; a scroll container would clamp it,
    // but the value handed to one should be sane on its own.
    expect(initialScrollLeft([bar(0, 0)], 0, DAY_ZOOM_PX_PER_DAY)).toBe(0);
  });

  it("has nothing to scroll to when there are no bars", () => {
    expect(initialScrollLeft([], 14, DAY_ZOOM_PX_PER_DAY)).toBe(0);
  });

  it("scales with the zoom, since a day is a different number of pixels in each", () => {
    const bars = [bar(14, 18), bar(40, 44)];
    const day = initialScrollLeft(bars, 20, DAY_ZOOM_PX_PER_DAY);
    const week = initialScrollLeft(bars, 20, WEEK_ZOOM_PX_PER_DAY);
    expect(day).toBe(20 * DAY_ZOOM_PX_PER_DAY - SCROLL_LEAD_IN_PX);
    expect(week).toBe(20 * WEEK_ZOOM_PX_PER_DAY - SCROLL_LEAD_IN_PX);
    expect(week).toBeLessThan(day);
  });

  it("does not care what order the bars arrive in", () => {
    const forwards = [bar(10, 25), bar(25, 40), bar(40, 41)];
    const backwards = [bar(40, 41), bar(10, 25), bar(25, 40)];
    expect(initialScrollLeft(backwards, 20, 10)).toBe(initialScrollLeft(forwards, 20, 10));
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
    const classes = classesOf(barSource, 'onPointerDown={(e) => onPointerDown(e, task, "move")}');
    expect(classes).toContain("max-md:pointer-events-none");
    expect(classes).not.toContain("max-md:hidden");
    expect(classes).not.toContain("hidden");
  });

  it("removes both resize strips", () => {
    for (const mode of ["resize-start", "resize-end"]) {
      const classes = classesOf(barSource, `onPointerDown={(e) => onPointerDown(e, task, "${mode}")}`);
      expect(classes, mode).toContain("max-md:hidden");
      // Not the unscoped class: that would take the strip off the desk too.
      expect(classes, mode).not.toContain("hidden");
    }
  });

  it("removes the dependency handle", () => {
    const classes = classesOf(barSource, 'onPointerDown={(e) => onPointerDown(e, task, "dependency")}');
    expect(classes).toContain("max-md:hidden");
    expect(classes).not.toContain("hidden");
  });
});

describe("the tap targets that replace them", () => {
  it("puts one over the whole chart row and one over the task's name", () => {
    for (const testId of ["gantt-tap-", "gantt-label-tap-"]) {
      const marker = `data-testid={\`${testId}`;
      const classes = classesOf(chartSource, marker);
      // ABSENT AT A DESK is the load-bearing half, and it is the hard
      // requirement rather than the feature: without it this is a
      // click-handling rectangle over every row of the desktop chart,
      // covering the bars' own drag zones. See classesOf above for why this
      // is a list membership test and not a substring one.
      expect(classes, testId).toContain("hidden");
      expect(classes, testId).toContain("max-md:block");
      expect(openingTagAround(chartSource, marker), testId).toContain('aria-hidden="true"');
    }
  });

  it("is rendered AFTER the bars, or a tap on a bar would do nothing", () => {
    // The layers are transparent, so which one takes a tap is decided purely
    // by paint order, and the bar root would win if it came later: on a phone
    // the visually obvious target -- the bar itself -- would then be the one
    // part of the row that opens nothing. It costs the desk something too,
    // since the dependency drag's hit test walks up from whatever is under
    // the pointer to find a `data-task-id`, and these layers carry none.
    const bars = chartSource.indexOf("<GanttBar");
    const taps = chartSource.indexOf("data-testid={`gantt-tap-");
    expect(bars).toBeGreaterThan(-1);
    expect(taps).toBeGreaterThan(bars);
  });

  it("gives the sidebar row a containing block, or every label tap covers the whole sidebar", () => {
    // The label span is positioned against its nearest POSITIONED ancestor.
    // Without one on the row, that is the sticky sidebar box, so all N spans
    // stretch over the entire sidebar, stacked -- and the last one, painting
    // above the rest, takes every tap. Tapping any task's name would open the
    // LAST task's drawer: precisely the wrong-drawer-one-tap-away outcome
    // Amendment 6 accepted this design for avoiding. Scoped to the phone,
    // because at a desk this row has never been positioned.
    const row = openingTagAround(chartSource, "title={row.task.title}");
    const tokens = [...row.matchAll(/"([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/));
    expect(tokens).toContain("max-md:relative");
  });

  it("opens the same task drawer the keyboard already opened", () => {
    // The no-capability-gap claim rests on this being the EXISTING path, not
    // a second one: onOpenTask is what Enter on a bar has always called.
    expect(chartSource.match(/onClick=\{\(\) => onOpenTask\(row\.task\.id\)\}/g) ?? []).toHaveLength(2);
  });
});

describe("the today line", () => {
  it("stops taking taps below the breakpoint, where the row is the target", () => {
    // It is painted above the tap layers and hit-tests like the ordinary div
    // it is, so its single column of pixels would open nothing -- and the
    // opening scroll parks it a lead-in's width from the sidebar edge, i.e.
    // exactly where a thumb goes first. Scoped, because at a desk this line
    // lies over the bars' own drag zones.
    const classes = classesOf(timescaleSource, 'data-testid="gantt-today-line"');
    expect(classes).toContain("max-md:pointer-events-none");
    expect(classes).not.toContain("pointer-events-none");
  });
});

describe("Remove slack on a phone", () => {
  it("keeps the per-project button and hides only the per-group one", () => {
    // Spec Amendment 5. The compactor exists nowhere but this chart, so
    // hiding both would have made it desktop-only -- the phase's first real
    // capability exception, which the Definition of done forbids. The
    // per-group button is hidden because it does not FIT a narrowed sidebar,
    // and the same sweep is reachable from that project's own Gantt page.
    expect(classesOf(chartSource, "data-testid={`compact-button-${projectId}`}")).toContain("max-md:hidden");
    expect(classesOf(chartSource, 'data-testid="compact-button"')).not.toContain("max-md:hidden");
  });
});

describe("the two imperative breakpoint reads", () => {
  it("are the only ones IN THE WHOLE DIRECTORY, and both build their query from the shared helper", () => {
    // Spec Amendments 1 and 4 permit exactly these: the key handler and the
    // opening scroll. A third would be a decision someone has to argue for.
    //
    // COUNTED OVER EVERY FILE HERE, not over chart.tsx, because the rule is
    // the phase's and not this file's: an earlier version of this guard
    // counted chart.tsx alone, and a render-time read added to
    // timescale.tsx's today line passed the entire suite. A read at RENDER
    // time is worse than a third read, not better -- it never re-runs when
    // the viewport crosses the breakpoint, so it renders a stale answer for
    // as long as the component stays mounted, which is the exact bug
    // subscribing exists to prevent.
    const byFile = new Map<string, number>();
    for (const [name, source] of ganttSources) {
      const hits = (source.match(/window\.matchMedia\(/g) ?? []).length;
      if (hits > 0) byFile.set(name, hits);
    }
    expect(Object.fromEntries(byFile)).toEqual({ "chart.tsx": 2 });
    expect(chartSource.match(/window\.matchMedia\(mobileMediaQuery\(\)\)\.matches/g) ?? []).toHaveLength(2);
  });

  it("does not reach for the hook, or for anything wearing it as a disguise", () => {
    // The spec rules out a differently-named hook over the hook's own parts
    // -- that would pass the three-site cap by spelling while evading the
    // rule it enforces. Nothing under this directory may subscribe at all.
    for (const [name, source] of ganttSources) {
      expect(source, name).not.toContain("useIsMobile");
      expect(source, name).not.toContain("subscribeToMediaQuery");
      expect(source, name).not.toContain("readIsMobile");
      expect(source, name).not.toContain("useSyncExternalStore");
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

describe("the opening scroll", () => {
  /** The effect's own body: from the `use*Effect(` that encloses the grid
   * read to the end of its dependency array. */
  function scrollEffect(): { hook: string; body: string } {
    const at = chartSource.indexOf("const grid = gridRef.current;");
    expect(at, "the opening scroll effect moved").toBeGreaterThan(-1);
    const before = chartSource.slice(0, at);
    const layout = before.lastIndexOf("useLayoutEffect(");
    const plain = before.lastIndexOf("useEffect(");
    const start = Math.max(layout, plain);
    return {
      hook: layout > plain ? "useLayoutEffect" : "useEffect",
      body: chartSource.slice(start, chartSource.indexOf("}, [taskRows", start)),
    };
  }

  it("scrolls the PHONE, and reads the breakpoint the right way round", () => {
    // One character decides which half of the app this touches. Without the
    // negation the desktop chart scrolls itself on mount and the phone stays
    // at 0 -- a hard-requirement violation that changes nothing a type
    // checker or a read-COUNT guard can see, since there are still exactly
    // two reads and they still go through the shared query.
    expect(scrollEffect().body).toContain("if (!window.matchMedia(mobileMediaQuery()).matches) return;");
  });

  it("runs before the browser paints", () => {
    // A passive effect would land the offset AFTER the first paint, i.e. as
    // the visible jump from an empty chart to a scrolled one that using a
    // layout effect is the whole point of avoiding.
    expect(scrollEffect().hook).toBe("useLayoutEffect");
  });

  it("cannot spend its one slot per zoom before it knows there is a bar", () => {
    // Claiming the slot first and then finding an empty list leaves a chart
    // that will never scroll again at that zoom. Order, not presence, is the
    // property -- so this asserts the order.
    const body = scrollEffect().body;
    const built = body.indexOf("bars.push(");
    const bailed = body.indexOf("if (bars.length === 0) return;");
    const claimed = body.indexOf("appliedScrollZoomRef.current = pxPerDay;");
    expect(built).toBeGreaterThan(-1);
    expect(bailed).toBeGreaterThan(built);
    expect(claimed).toBeGreaterThan(bailed);
  });
});

describe("the grid box", () => {
  it("confines its own stacking context below the breakpoint", () => {
    // Measured at 375px: this grid's sticky sidebar and header are not
    // portalled and carry z-indices, so they outranked the bottom navigation
    // -- whose z-index is deliberately absent -- and a hit test over its Mail
    // tab returned a Gantt row. The navigation was untappable on this page.
    expect(classesOf(chartSource, "ref={gridRef}")).toContain("max-md:isolate");
  });

  it("declares the phone's sidebar width on itself", () => {
    const declares = classesOf(chartSource, "ref={gridRef}")
      .some((c) => c.startsWith("max-md:[--gantt-sidebar-width:"));
    expect(declares).toBe(true);
  });
});
