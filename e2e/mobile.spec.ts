import { readFileSync } from "node:fs";
import { test, expect, devices } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ImapFlow } from "imapflow";
import { typeIntoEditor } from "./helpers.js";

/**
 * Phase 6's phone journeys, at a phone viewport.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT -- because the difference matters to
 * anyone reading a green run. It carries the six journeys the spec's Testing
 * section names: navigate by the bottom bar AND the More sheet; look up a
 * company and read its rail; move a deal between stages with the Move action;
 * open a Gantt bar's task drawer and change its dates; log a meeting and add a
 * follow-up task; read a mail thread through the drill-in stack and reply.
 *
 * That list is a SUBSET of the spec's Definition of done, not the whole of it.
 * The definition is "every capability the app offers is reachable on a phone,
 * and no surface is a dead end"; the six journeys are the surfaces where the
 * INTERACTION MODEL CHANGED -- the three `useIsMobile()` sites, the two
 * gestures that were replaced (drag -> Move, drag -> drawer), and the record
 * rail the sweep had to fix. THE SUBSET RULE IS THAT: a capability whose phone
 * form is the desktop form re-laid out by CSS is covered by the desktop suite
 * plus the unit guards over those utilities, and is not re-driven here.
 *
 * So these have NO phone coverage and a green run says nothing about them:
 * creating or editing a contact, inline field editing, My Tasks, composing a
 * NEW mail (as opposed to replying), bulk selection and its actions, Show
 * earlier / Load more, linking a record to a thread, renaming a stage, and the
 * funnel. Every one of them was measured by Tasks 2-5 in a browser at a phone
 * width; none of them is asserted by a journey. Read a failure here as a real
 * one and a pass as covering exactly the list above.
 *
 * THE HARD REQUIREMENT IS THAT THE OTHER 72 TESTS DO NOT MOVE. This file adds
 * a viewport; it adds no project, changes no config value and EDITS no other
 * spec file. Everything a phone journey needs was given a phone-only testid by
 * the task that built the surface, so nothing here needed a source change
 * either.
 *
 * It is not, however, hermetic, and the difference is worth stating rather
 * than glossing: the inbox group archives every live mail account the dev user
 * owns before adding its own, which is server state e2e/mail.spec.ts also
 * owns. That is safe here because the two files never overlap in time -- see
 * the guard at the top of that group, which refuses to run rather than trust a
 * convention.
 *
 * WHY test.use AND NOT A `projects` ARRAY. playwright.config.ts has no
 * `projects` today, so every existing test is homed on the implicit default
 * project; adding an array to give this file a device would re-home all 72,
 * which is exactly the re-baselining the phase forbids. A file-level
 * `test.use` still applies at CONTEXT CREATION, which is the part that
 * matters: the CDP resize path used by a mid-test `setViewportSize` updates a
 * MediaQueryList's `matches` WITHOUT dispatching `change`, so useIsMobile()
 * -- a `useSyncExternalStore` over that event -- would never see it, and every
 * journey below would run the desktop tree at a phone's width.
 *
 * WHY THE DEVICE DESCRIPTOR IS SPREAD MINUS ONE KEY. `devices["iPhone 13"]`
 * carries `defaultBrowserType: "webkit"`, and `browserName` is defined as a
 * fixture that simply forwards `defaultBrowserType` (playwright/lib/index.js).
 * Spreading it whole would therefore move this FILE onto WebKit -- a browser
 * the e2e job deliberately does not install (its Playwright step is
 * `install chromium`, and only chromium), so the run would fail on a missing
 * executable rather than on anything about the app. Dropping that one key
 * leaves every emulation property that matters -- a 390x664 viewport on a
 * 390x844 screen, isMobile, hasTouch, the device pixel ratio and the iOS user
 * agent -- and keeps the file on the one browser CI has. It also leaves the
 * worker options identical to every other file's, so no worker restart is
 * bought for nothing.
 *
 * 390px is below the 48rem (768px) breakpoint with room to spare, so every
 * `max-md:` rule and all three useIsMobile() sites are in their phone state
 * for the whole file.
 *
 * FIXTURE NAMING follows the suite: `${runId}x${retry}`, stamped in each
 * group's FIRST test (a serial group re-runs from the top on a retry, so that
 * is the one place guaranteed to run again with the new retry index). Nothing
 * empties the database between attempts, and several assertions below are
 * whole-list statements -- "this stage holds no card with that id" -- which a
 * previous attempt's identically-named row would break for good.
 *
 * ASSERTING ABSENCE, the one rule worth stating once: `toHaveCount(0)` is used
 * ONLY where an element is genuinely not rendered -- the desktop kanban's
 * `board`/`column-<id>`/`DndLiveRegion` below the breakpoint, the overflow
 * nav destinations while the More sheet is shut, the `conversation` testid at
 * a level with no `?thread=`. Everything the phase merely HIDES with CSS --
 * the inbox's three panes -- is `toBeHidden()`, because it is in the DOM at
 * every level by design.
 */

/**
 * The touch floor the phase set for itself. Asserted where a control is the
 * ONLY way out of a full-screen surface, or the only way to reach a
 * capability, rather than everywhere (ui/ui.test.ts owns the primitives).
 */
const TOUCH_FLOOR_PX = 44;

// See the file comment: everything except the browser choice.
const { defaultBrowserType: _webkitByDefault, ...IPHONE_13 } = devices["iPhone 13"];
test.use(IPHONE_13);

/**
 * A row/card/option id, read back off the testid the app rendered it with.
 *
 * Two small pieces of care the other specs' versions do without. The attribute
 * is CHECKED rather than cast: a locator that resolved to an element with no
 * `data-testid` would otherwise throw inside `String.replace` with a message
 * about null, several steps from the locator that was actually wrong. And the
 * prefix is stripped from the FRONT only -- `replace` takes the first match
 * anywhere, so a prefix that recurred inside an id would cut the wrong piece
 * out and hand back something that looks like an id and is not.
 */
async function idOf(locator: Locator, prefix: string): Promise<string> {
  const testId = await locator.getAttribute("data-testid");
  if (testId === null) throw new Error(`expected a data-testid starting "${prefix}", found none`);
  if (!testId.startsWith(prefix)) throw new Error(`data-testid "${testId}" does not start "${prefix}"`);
  return testId.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// 1. The shell: the bottom bar, the More sheet, the search sheet -- and the
//    company lookup that is what a phone is mostly for.
// ---------------------------------------------------------------------------

test.describe.serial("Phone navigation and the record rail", () => {
  const runId = Date.now().toString(36);
  let attemptId = "";
  let companyName = "";
  let companyId = "";

  test("creates a company from a list that has become cards", async ({ page }, testInfo) => {
    attemptId = `${runId}x${testInfo.retry}`;
    companyName = `Phoneco ${attemptId}`;

    await page.goto("/companies");

    // The two halves of the shell are MUTUALLY EXCLUSIVE IN THE DOM (a JS
    // branch in shell.tsx, not a hidden element), so the sidebar is genuinely
    // absent rather than merely invisible -- which is what keeps `search-input`
    // and `unread-badge` single elements for the desktop specs.
    await expect(page.getByTestId("bottom-nav")).toBeVisible();
    // Scoped to the shell's own direct child: every detail page renders its
    // record rail in an <aside> too, so a bare tag selector would be asserting
    // something else on half the routes.
    await expect(page.locator('[data-testid="shell"] > aside')).toHaveCount(0);

    await page.getByRole("button", { name: "New" }).click();
    // A full-screen dialog on a phone has no outside to click and no Escape
    // key, so DialogContent renders its own way out. It is `display: none`
    // above the breakpoint, which is why no desktop journey has ever seen it.
    await expect(page.getByTestId("dialog-close")).toBeVisible();
    await page.getByPlaceholder("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    companyId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: companyName })).toBeVisible();

    // Back on the list: one DOM restyled, not a second card list rendered
    // beside a hidden table -- so the row keeps the single `row-<id>` testid
    // crm.spec.ts addresses at a desk. The column heads are gone (they mean
    // nothing at this width) and each cell carries its own label instead.
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(attemptId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();
    await expect(page.locator("thead")).toBeHidden();
    await expect(row.getByText("Name", { exact: true })).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(`/companies/${companyId}`);
  });

  test("reaches all four primary destinations from the bar", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByTestId("bottom-nav");

    for (const [id, url] of [
      ["mail", "/mail"],
      ["companies", "/companies"],
      ["contacts", "/contacts"],
      ["my-tasks", "/my-tasks"],
    ] as const) {
      const tab = bar.getByTestId(`nav-${id}`);
      await tab.click();
      await expect(page).toHaveURL(url);
      // "You are here" reaches a screen reader, not only a sighted one: the
      // bar computes its own active state, so the marker comes from the same
      // rule as the colour.
      await expect(tab).toHaveAttribute("aria-current", "page");
    }
  });

  test("reaches the other four from the More sheet, which closes behind them", async ({ page }) => {
    await page.goto("/");

    // Radix does not forceMount, so the overflow destinations do not exist
    // until the sheet is open. A journey that reached for one first would fail
    // on a missing element rather than on anything about the navigation.
    await expect(page.getByTestId("nav-projects")).toHaveCount(0);

    for (const [id, url] of [
      ["pipelines", "/pipelines"],
      ["projects", "/projects"],
      ["gantt", "/gantt"],
      ["settings", "/settings/mail"],
    ] as const) {
      await page.getByTestId("bottom-nav-more").click();
      await expect(page.getByTestId("more-sheet")).toBeVisible();
      await page.getByTestId(`nav-${id}`).click();
      await expect(page).toHaveURL(url);
      // Radix cannot see a navigation inside its own content, so the row
      // closes the sheet itself. Without that the destination would load
      // BEHIND a sheet still covering the screen.
      await expect(page.getByTestId("more-sheet")).toHaveCount(0);
      // More lights up for anything inside its sheet -- including Settings on
      // its second tab, where TanStack's own match disagrees.
      await expect(page.getByTestId("bottom-nav-more")).toHaveAttribute("aria-current", "true");
    }
  });

  test("finds the company through the header's search sheet, which takes itself down", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("open-search").click();
    await expect(page.getByTestId("search-sheet")).toBeVisible();
    // The sheet opens on the box it exists for, not on its own Close -- which
    // is where Radix would put focus, the header preceding the content.
    const input = page.getByTestId("search-input");
    await expect(input).toBeFocused();

    await input.fill(companyName);
    await page.getByTestId("search-result").filter({ hasText: companyName }).click();

    await expect(page).toHaveURL(`/companies/${companyId}`);
    await expect(page.getByTestId("search-sheet")).toHaveCount(0);
  });

  test("reads the record rail, reaching its last tab by keyboard", async ({ page }) => {
    await page.goto(`/companies/${companyId}`);

    const rail = page.getByTestId("rail");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("timeline-entry").filter({ hasText: "created" })).toBeVisible();

    // WHY THIS TAB IS WORTH A TEST AT ALL. The five labels are five
    // unbreakable words, so a trigger cannot shrink below its text and the
    // strip can run past its box: measured at 390px in Chrome on macOS, its
    // content is 349px inside a 342px box and Meetings is the 7px that hangs
    // over. Below 360px that spill used to scroll the whole PAGE and take
    // Meetings off screen entirely, which is what made it a phase concern.
    //
    // WHETHER IT SPILLS AT ALL IS A FONT-METRIC ACCIDENT, and this file learned
    // that from a red CI run rather than by reasoning: on the Ubuntu runner the
    // same five labels measure narrower and the strip FITS at 390px with
    // nothing to scroll, so asserting the overflow -- or a scrollLeft that
    // could only follow from it -- pins the runner's font stack and not
    // anything about Conduit. The mechanism is not an accident and is what is
    // asserted instead: below the breakpoint the strip is its own horizontal
    // scroll container, so wherever a spill does appear it scrolls the strip
    // and never the page.
    const strip = rail.getByRole("tablist");
    await expect(strip).toHaveCSS("overflow-x", "auto");

    // ARROW-KEY TO THE LAST TAB. Task 2 could not settle from a browser
    // pane whether keyboard navigation reaches it -- that pane reported
    // `document.hasFocus()` false throughout, and Blink defers focus EVENTS
    // for an unfocused page, so Radix's automatic activation never ran there
    // and neither did any scroll it might have caused. Under Playwright the
    // page really has focus, so this is where the question gets an answer.
    //
    // The claim asserted is the phase's own: the last tab is REACHABLE, it
    // activates, and it is on the screen when it gets there.
    //
    // ONE PRESS AT A TIME, waiting for each. Radix moves the tab stop inside a
    // setTimeout, so a second arrow dispatched before the first has landed is
    // delivered to a tab that has not moved yet, and two presses become one.
    await rail.getByRole("tab", { name: "Timeline", exact: true }).click();
    for (const name of ["Notes", "Files", "Mail", "Meetings"] as const) {
      await page.keyboard.press("ArrowRight");
      await expect(rail.getByRole("tab", { name, exact: true })).toBeFocused();
    }
    await expect(page.getByTestId("meetings-tab")).toBeFocused();
    await expect(page.getByTestId("meetings")).toBeVisible();
    // The bare form, which is ratio > 0 -- "on screen at all", not "fully".
    // The strict form would be wrong to ask for: on a font stack where the
    // strip does spill, this tab is the few pixels that hang over, and being
    // partly clipped is the state the scroll container exists to rescue rather
    // than a failure.
    await expect(page.getByTestId("meetings-tab")).toBeInViewport();
  });
});

// ---------------------------------------------------------------------------
// 2. The kanban: one stage at a time, with a Move action in place of a drag.
// ---------------------------------------------------------------------------

test.describe.serial("Phone kanban stage view", () => {
  const runId = Date.now().toString(36);
  let attemptId = "";
  let pipelineName = "";
  let dealTitle = "";
  let pipelineId = "";
  let leadStageId = "";
  let wonStageId = "";

  /** pipeline.spec.ts's addStage, at a phone viewport: the tile is a
   * full-width row here rather than a column at the end of a board, but the
   * affordance and its collapse-on-success signal are the same. */
  async function addStage(page: Page, name: string): Promise<void> {
    await page.getByRole("button", { name: "+ Stage", exact: true }).click();
    await page.getByPlaceholder("Stage name").fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("button", { name: "+ Stage", exact: true })).toBeVisible();
  }

  async function stageIdOf(page: Page, name: string): Promise<string> {
    const option = page
      .getByTestId("stage-picker")
      .locator('[data-testid^="stage-pick-"]')
      .filter({ hasText: name });
    return idOf(option, "stage-pick-");
  }

  test("builds a pipeline, which becomes a stage view once it has stages", async ({ page }, testInfo) => {
    attemptId = `${runId}x${testInfo.retry}`;
    pipelineName = `Phone sales ${attemptId}`;
    dealTitle = `Phone deal ${attemptId}`;

    await page.goto("/pipelines");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Pipeline name").fill(pipelineName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
    pipelineId = page.url().split("/").pop() as string;

    // A STAGE-LESS PIPELINE FALLS TO THE DESKTOP BRANCH EVEN HERE, and that is
    // recorded behaviour rather than a defect: with no stage to show, the
    // stage view has no subject, so the board renders its honest empty state
    // (a row holding only "+ Stage"). Pinned so the absence asserted after the
    // stages exist is known to be a real change of shape.
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(page.getByTestId("stage-view")).toHaveCount(0);

    await addStage(page, "Lead");
    await addStage(page, "Won");

    // Sequenced behind the stage-view sentinel: these three are genuinely
    // ABSENT below the breakpoint (the page unmounts the desktop board rather
    // than hiding it, because pipeline.spec.ts counts `column-` prefixes and a
    // display:none copy would still be counted), so toHaveCount(0) is right --
    // but only once the page has actually reached the phone branch.
    await expect(page.getByTestId("stage-view")).toBeVisible();
    await expect(page.getByTestId("board")).toHaveCount(0);
    await expect(page.locator('[data-testid^="column-"]')).toHaveCount(0);
    await expect(page.locator('[id^="DndLiveRegion"]')).toHaveCount(0);

    leadStageId = await stageIdOf(page, "Lead");
    wonStageId = await stageIdOf(page, "Won");
    expect(leadStageId).not.toBe(wonStageId);
  });

  test("creates a deal in the stage on screen and moves it with the Move action", async ({ page }) => {
    await page.goto(`/pipelines/${pipelineId}`);
    await expect(page.getByTestId("stage-view")).toBeVisible();

    // The picker opens on the pipeline's first stage, and says so to a screen
    // reader by the same rule that colours it.
    await expect(page.getByTestId(`stage-pick-${leadStageId}`)).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "New deal", exact: true }).click();
    await page.getByPlaceholder("Deal title").fill(dealTitle);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const card = page.locator('[data-testid^="card-"]').filter({ hasText: dealTitle });
    await expect(card).toBeVisible();
    const dealId = await idOf(card, "card-");

    await page.getByTestId(`move-${dealId}`).click();
    const sheet = page.getByTestId("move-sheet");
    await expect(sheet).toBeVisible();
    // The stage the card is already in is never offered -- an option that
    // could only be a no-op.
    await expect(page.getByTestId(`move-to-${leadStageId}`)).toHaveCount(0);
    await page.getByTestId(`move-to-${wonStageId}`).click();

    await expect(page.getByTestId("stage-move-result")).toContainText(`Moved ${dealTitle} to Won.`);
    await expect(page.getByTestId(`card-${dealId}`)).toHaveCount(0);
    // The card that carried the trigger has gone with the move, so focus goes
    // to the page heading. Radix restores nothing for a dialog opened from
    // state (a phase-level finding), so this is the page's own doing and e2e
    // is the only thing that re-checks it.
    await expect(page.getByRole("heading", { name: pipelineName, level: 1 })).toBeFocused();

    await page.getByTestId(`stage-pick-${wonStageId}`).click();
    await expect(page.getByTestId(`card-${dealId}`)).toBeVisible();
  });

  test("opens the move sheet on a target and returns focus to the card on Close", async ({ page }) => {
    await page.goto(`/pipelines/${pipelineId}`);
    await page.getByTestId(`stage-pick-${wonStageId}`).click();

    const card = page.locator('[data-testid^="card-"]').filter({ hasText: dealTitle });
    await expect(card).toBeVisible();
    const dealId = await idOf(card, "card-");

    const trigger = page.getByTestId(`move-${dealId}`);
    await trigger.click();
    await expect(page.getByTestId("move-sheet")).toBeVisible();
    // On the first stage, not on its own Close -- so a thumb can act at once.
    await expect(page.getByTestId(`move-to-${leadStageId}`)).toBeFocused();

    await page.getByTestId("move-sheet-close").click();
    await expect(page.getByTestId("move-sheet")).toHaveCount(0);
    // The other exit: no move, the trigger still on screen, so focus goes back
    // to where it came from rather than to <body>.
    await expect(trigger).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// 3. The Gantt: read-only on a phone, with the task drawer as the way in.
// ---------------------------------------------------------------------------

test.describe.serial("Phone Gantt", () => {
  const runId = Date.now().toString(36);

  /**
   * More rows than the grid's own 640px cap allows at a 32px pitch, so the
   * chart gains a SECOND scroll axis inside the page's. Task 5 left that
   * geometry unmeasured -- its own fixtures were three and twenty rows -- and
   * the question it leaves open is whether a task below the fold is still
   * reachable at all. The last row's drawer, opened below, is the answer.
   */
  const ROW_COUNT = 22;

  let attemptId = "";
  let projectName = "";
  let projectId = "";
  /**
   * Task ids in the order the chart rows them, which for this fixture is
   * CREATION ORDER.
   *
   * Not "by start date, then title", which an earlier version of this comment
   * said and which is wrong in a way that matters: `ganttPayload`
   * (api: services/scheduling.ts) orders by project, then by
   * `COALESCE(parent.position, own.position)`, then by whether the row is a
   * parent, then by position -- so it is POSITION order, and these tasks are
   * created one after another with no parents, which makes position and
   * creation order the same thing here. Every index into this array below is
   * correct because of that, not because of the dates, and a fixture whose
   * tasks were created out of date order would still row in creation order.
   */
  const taskIds: string[] = [];
  let firstTitle = "";
  /** The successor in the dependency journey; the first task is its predecessor. */
  let secondTitle = "";
  let lastTitle = "";
  let firstStart = "";
  let firstDue = "";
  let rescheduledStart = "";
  let rescheduledDue = "";

  /**
   * The chart's own scroll box, and why it is reached this way.
   *
   * Task 5 gave that box no `data-testid`, and addressing it by its Tailwind
   * classes would break the day one utility is reordered -- so it is found
   * from a testid the app does render, by walking up to the nearest scrolling
   * ancestor. `<main>` is also `overflow-auto`, so "nearest" is what keeps
   * this off it; the two assertions every caller makes -- that the box
   * overflows on BOTH axes -- are also the check that we did not land on
   * `<main>`, which at this width overflows on neither.
   */
  async function chartScrollBox(page: Page, taskId: string): Promise<{
    scrollLeft: number; scrollWidth: number; clientWidth: number;
    scrollHeight: number; clientHeight: number;
  }> {
    return page.getByTestId(`gantt-tap-${taskId}`).evaluate((node) => {
      let el: HTMLElement | null = node.parentElement;
      while (el !== null) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") break;
        el = el.parentElement;
      }
      if (el === null) throw new Error("no scrolling ancestor above the chart's tap layer");
      return {
        scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      };
    });
  }

  /** An ISO day `offset` days from today, in UTC -- which is the runner's own
   * zone, so it is also the day the chart calls today. */
  function isoDay(offset: number): string {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  }

  test("seeds a project whose chart is longer than the grid", async ({ page }, testInfo) => {
    attemptId = `${runId}x${testInfo.retry}`;
    projectName = `Phone project ${attemptId}`;

    await page.goto("/projects");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    projectId = page.url().split("/").pop() as string;

    // THE TASKS ARE SEEDED OVER THE API, not through the board, and that is a
    // deliberate departure from tasks.spec.ts. Twenty-two trips through the
    // create dialog and the drawer's date pair would be minutes of runtime for
    // a fixture, not for a journey; the journey itself -- opening a bar's
    // drawer and rescheduling from it -- is driven entirely through the UI
    // below. Every bar spans today, so the opening scroll's clamp lands on the
    // "work under way" case, which is the one a phone glance is actually for.
    taskIds.length = 0;
    for (let index = 0; index < ROW_COUNT; index += 1) {
      const title = `${String(index).padStart(2, "0")} task ${attemptId}`;
      const startDate = isoDay(-1 - (index % 3));
      const dueDate = isoDay(2 + (index % 4));
      const response = await page.request.post("/api/tasks", {
        data: { title, projectId, startDate, dueDate },
      });
      expect(response.status()).toBe(201);
      const task = await response.json() as { id: string };
      taskIds.push(task.id);
      if (index === 0) {
        firstTitle = title;
        firstStart = startDate;
        firstDue = dueDate;
      }
      if (index === 1) secondTitle = title;
      if (index === ROW_COUNT - 1) lastTitle = title;
    }
    expect(taskIds).toHaveLength(ROW_COUNT);
    rescheduledStart = isoDay(3);
    rescheduledDue = isoDay(6);
  });

  test("opens on today's work, with both tap layers and a bar that is not stolen", async ({ page }) => {
    await page.goto(`/projects/${projectId}/gantt`);
    await expect(page.getByTestId("gantt")).toBeVisible();

    // AMENDMENT 4, and toBeInViewport is the only assertion that says it.
    // The chart's window starts a fortnight before the earliest task, so at
    // scrollLeft 0 a phone's ~250px of timeline holds no bar at all; the mount
    // read scrolls it to today instead. toBeVisible() would pass either way --
    // Playwright's visibility does not require viewport intersection, and
    // tasks.spec.ts already asserts it at a desk.
    const firstId = taskIds[0] as string;
    await expect(page.getByTestId(`gantt-bar-${firstId}`)).toBeInViewport();

    // Both phone-only tap layers, which are display:none at a desk. They are
    // aria-hidden, so getByTestId is the only way to reach them.
    await expect(page.getByTestId(`gantt-label-tap-${firstId}`)).toBeVisible();
    await expect(page.getByTestId(`gantt-tap-${firstId}`)).toBeVisible();

    // THE TAP-THEFT REGRESSION. The chart's sticky sidebar and timescale carry
    // z-20/z-30 and are not portalled, so before the grid was given its own
    // stacking context a hit test over the bar's Mail tab returned a Gantt
    // sidebar row -- tapping Mail opened a task drawer. Nothing else in the
    // suite re-checks it.
    const whatIsUnderTheMailTab = await page.evaluate(() => {
      const tab = document.querySelector('[data-testid="nav-mail"]');
      if (tab === null) return "no bottom bar";
      const rect = tab.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit === null) return "nothing";
      return hit.closest('[data-testid="bottom-nav"]') === null ? "not the bar" : "the bar";
    });
    expect(whatIsUnderTheMailTab).toBe("the bar");
  });

  test("zooms and pans, which is the whole of what the chart offers here", async ({ page }) => {
    // "Read-only PAN AND ZOOM" is the brainstorm's decision for this surface,
    // and read-only is only half of it. At 390px the sidebar leaves roughly
    // 250px of timeline -- about eight day-columns -- so panning is not a
    // convenience here, it is how the chart is read at all, and the zoom
    // control is how a month is seen without doing it.
    await page.goto(`/projects/${projectId}/gantt`);
    const firstId = taskIds[0] as string;
    const bar = page.getByTestId(`gantt-bar-${firstId}`);
    await expect(bar).toBeInViewport();

    const dayBox = await bar.boundingBox();
    expect(dayBox).not.toBeNull();
    const dayWidth = dayBox?.width ?? 0;

    // THE ZOOM IS ASSERTED BY ITS EFFECT ON THE CHART, not by a class on the
    // button it was pressed with: week columns are 12.857px against day's 30,
    // so the same task's bar has to get narrower. A pressed-looking button
    // over an unchanged chart is exactly the failure this shape catches.
    const zoom = page.getByTestId("gantt-zoom");
    await expect(zoom.getByRole("button", { name: "Week", exact: true })).toBeVisible();
    await zoom.getByRole("button", { name: "Week", exact: true }).click();
    await expect
      .poll(async () => (await bar.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(dayWidth);
    // The opening scroll re-applies on a zoom CHANGE (an offset in day-zoom
    // pixels means nothing after a switch to week), so the bar is back on
    // screen at the new scale rather than left wherever the old pixels pointed.
    await expect(bar).toBeInViewport();

    await zoom.getByRole("button", { name: "Day", exact: true }).click();
    await expect
      .poll(async () => (await bar.boundingBox())?.width ?? 0)
      .toBe(dayWidth);

    // THE PAN, driven over the chart rather than by writing to a scroll
    // property. A wheel is the closest primitive Playwright has to the finger
    // drag a phone uses on a native scroller; what both deliver to the grid is
    // the same scroll.
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await page.mouse.wheel(400, 0);
    await expect(bar).not.toBeInViewport();
    const panned = await chartScrollBox(page, firstId);
    expect(panned.scrollWidth).toBeGreaterThan(panned.clientWidth);
    expect(panned.scrollLeft).toBeGreaterThan(0);

    // NOW PROVOKE THE THING THE OPENING SCROLL IS GUARDED AGAINST, because the
    // pan alone does not reach it. Task 5 states a guarantee -- at an UNCHANGED
    // zoom, nothing re-applies the opening offset and yanks the view out from
    // under a thumb -- and `appliedScrollZoomRef` is the whole of what delivers
    // it. A wheel triggers no React render at all, so a version of this test
    // that only panned left that ref unreached: deleting it kept the group
    // green, which is how this paragraph came to be rewritten.
    //
    // The layout effect's deps are `[taskRows, pxPerDay, rangeStartMs]`, so
    // what actually re-runs it at unchanged zoom is a REFETCH handing back a
    // new `taskRows` array. `useInvalidateTask` invalidates `["gantt"]`, so any
    // task mutation is one -- and PROGRESS is the mutation to use here, because
    // it moves no date and therefore cannot move `rangeStartMs` and make the
    // re-run legitimate. This is the SSE-update-mid-pan case in miniature.
    const midId = taskIds[5] as string;
    await page.getByTestId(`gantt-label-tap-${midId}`).click();
    const drawer = page.getByTestId("task-drawer");
    await expect(drawer).toBeVisible();
    const progress = page.getByTestId("field-progressPct").locator("input");
    await progress.fill("40");
    await progress.blur();
    // Wait for the refetch to have LANDED rather than for a moment to pass:
    // the drawer's own input reads back from the refetched task, so a value
    // that survives a re-read is the invalidation having gone round.
    await expect(progress).toHaveValue("40");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();

    // The view is exactly where the thumb left it.
    const afterRefetch = await chartScrollBox(page, firstId);
    expect(afterRefetch.scrollLeft).toBe(panned.scrollLeft);
    await expect(bar).not.toBeInViewport();

    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await page.mouse.wheel(-400, 0);
    await expect(bar).toBeInViewport();
  });

  test("refuses keyboard rescheduling but still opens the drawer on Enter", async ({ page }) => {
    await page.goto(`/projects/${projectId}/gantt`);
    const firstId = taskIds[0] as string;
    const bar = page.getByTestId(`gantt-bar-${firstId}`);
    const restingTitle = `${firstTitle}: ${firstStart} to ${firstDue}`;
    await expect(bar).toHaveAttribute("title", restingTitle);

    // The pointer paths are neutralised by CSS, but no CSS property stops a
    // key event -- so the handler reads the breakpoint itself (Amendment 1).
    // Arrows and Shift+arrows are the two gestures that commit real schedule
    // changes at a desk.
    //
    // THE FOCUS IS ASSERTED, not merely requested. `page.keyboard.press` goes
    // to whatever the DOCUMENT has focused, so a `focus()` that silently did
    // not land would send all six presses to `<body>` -- and the negative half
    // of this test, "no date changed", would then pass for the wrong reason
    // and pass forever. (The Enter at the end keeps it from being wholly
    // vacuous, but only because Enter is asserted positively.)
    await bar.focus();
    await expect(bar).toBeFocused();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowLeft", "Shift+ArrowUp"]) {
      await page.keyboard.press(key);
    }

    // A FLAT WAIT, deliberately, because this is a NON-event: a nudge that was
    // accepted would render instantly as a transform and commit ~200ms after
    // the last press (chart.tsx's NUDGE_DEBOUNCE_MS). An auto-retrying
    // assertion would pass on the first poll and never see the commit that
    // landed after it. One second is five debounce windows.
    await page.waitForTimeout(1_000);
    // The title is the assertion that carries this: it is the committed state,
    // read back from the task. The transform is a smaller, separate claim --
    // that no live drag PREVIEW was rendered either, so the refusal happened at
    // the key handler rather than at the commit, and a phone never saw the bar
    // move at all. Weak on its own (an unmoved bar has no transform anyway),
    // worth keeping only beside the title.
    await expect(bar).toHaveCSS("transform", "none");
    await expect(bar).toHaveAttribute("title", restingTitle);

    // Enter is the phone's whole way in, so the refusal has to sit AFTER the
    // Enter branch in that handler -- a mutation that moved it above would
    // leave a phone with no route to the drawer at all.
    await bar.press("Enter");
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();
    await expect(page.getByTestId("field-dates").getByLabel("Start date")).toHaveValue(firstStart);
  });

  test("reschedules from the drawer a tap opens, and the bar follows", async ({ page }) => {
    await page.goto(`/projects/${projectId}/gantt`);
    const firstId = taskIds[0] as string;

    // DRIVEN FROM THE LABEL LAYER, not the row layer. The row layer is as wide
    // as the whole chart (well over a thousand pixels) against a ~250px
    // timeline, and a click lands at the centre of its VISIBLE INTERSECTION --
    // which can fall inside the sticky sidebar and be reported as intercepted.
    // The label layer is 127x31, lives in that sidebar, and is on screen at
    // every scroll position.
    await page.getByTestId(`gantt-label-tap-${firstId}`).click();
    const drawer = page.getByTestId("task-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();

    // The drawer is full-screen here, so its close is the ONLY exit -- and the
    // whole no-capability-gap claim rests on this surface. Measured rather
    // than assumed: it was 34.7px wide before Task 2's round put the floor on
    // both axes.
    const close = drawer.getByRole("button", { name: "Close" });
    const closeBox = await close.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

    // The capability the read-only chart gives up, reached the other way.
    const dates = page.getByTestId("field-dates");
    await dates.getByLabel("Start date").fill(rescheduledStart);
    await dates.getByLabel("Due date").fill(rescheduledDue);
    const save = dates.getByRole("button", { name: "Save" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dates.getByLabel("Start date")).toHaveValue(rescheduledStart);
    await expect(dates.getByLabel("Due date")).toHaveValue(rescheduledDue);

    // Close before touching the chart again: the drawer is a Radix Dialog, so
    // everything behind it is inert while it is open.
    await close.click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId(`gantt-bar-${firstId}`))
      .toHaveAttribute("title", `${firstTitle}: ${rescheduledStart} to ${rescheduledDue}`);
  });

  test("adds a dependency from the drawer, the other half of the read-only trade", async ({ page }) => {
    // THE PHASE'S CENTRAL CLAIM IS HALF-PROVED WITHOUT THIS TEST. `bar.tsx`
    // does not render the dependency handle below the breakpoint, and the spec
    // absorbs that removal with one sentence: rescheduling and dependencies are
    // "both also in the task drawer", so a read-only chart plus tap-to-drawer
    // removes no capability at all. The reschedule half is the test above. This
    // is the other half, and until it existed the no-capability-exception claim
    // rested on a path nothing exercised.
    //
    // IT IS ALSO THIS FILE'S ONLY RADIX SELECT. Every other phone control the
    // journeys drive is a plain button, and `select.tsx` documents a real trap
    // in exactly this shape: `position="item-aligned"` computes the popup's
    // place from the SELECTED item, and this picker is pinned at no selection,
    // which is the case that left `user-picker.tsx` unplaced and moved that one
    // caller to "popper". The same primitive, inside a 390x664 full-screen
    // sheet, is where that trap would surface again -- so the popup's placement
    // is asserted, not assumed.
    const successorId = taskIds[1] as string;
    await page.goto(`/projects/${projectId}/gantt`);
    await page.getByTestId(`gantt-label-tap-${successorId}`).click();
    const drawer = page.getByTestId("task-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();

    // Scoped to the section: the drawer also carries Type, Status and Assignee
    // selects, so an unscoped combobox query is ambiguous (tasks.spec.ts scopes
    // it the same way at a desk).
    const depSection = page.locator('[data-testid="task-drawer"] section', { hasText: "Dependencies" });
    await expect(page.getByTestId("dependency-list")).toContainText("No dependencies");
    await depSection.getByRole("combobox").click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    // THE ASSERTION THE TRAP WOULD FAIL. An unplaced popup is still "visible"
    // to Playwright -- it has a box and it is not display:none -- so only
    // viewport intersection can tell a positioned list from one Radix left
    // wherever the document happened to put it.
    //
    // `ratio: 1`, NOT the bare form. `toBeInViewport()` defaults to ratio > 0,
    // which is ANY intersection: a popup hanging almost entirely off the
    // bottom of a phone would satisfy it on one row of pixels, and the claim
    // being made here -- and in the release notes -- is that the whole list is
    // on screen. Measured at this viewport: 286x220 at (24, 434), bottom edge
    // 654 against 664, so the strict form is true today with room to spare.
    await expect(listbox).toBeInViewport({ ratio: 1 });

    const option = page.getByRole("option", { name: firstTitle, exact: true });
    // The bare form here, deliberately: an option lives inside the list's own
    // scrolling viewport, so "fully on screen" is not a property any single
    // item can be promised. What matters is that it is reachable, and its
    // height -- which is the phase's own floor -- is asserted below.
    await expect(option).toBeInViewport();
    // A menu item is one of the four things the phase names for the 44px
    // floor, and this list is the only place a phone journey meets one.
    const optionBox = await option.boundingBox();
    expect(optionBox).not.toBeNull();
    expect(optionBox?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    await option.click();

    // The picker commits to its trigger, and Add is what sends it -- two
    // controls, so a journey that only opened the list would prove nothing
    // about the mutation.
    await expect(listbox).toHaveCount(0);
    await expect(depSection.getByRole("combobox")).toContainText(firstTitle);
    await depSection.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId("dependency-list")).toContainText(firstTitle);
    await expect(page.getByTestId("dependency-list")).not.toContainText("No dependencies");

    // Closed before the chart is touched again -- the drawer is a Radix Dialog
    // and everything behind it is inert while it is open -- and then the chart
    // itself is the confirmation that the edge really landed, rather than the
    // drawer reporting on its own request.
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId(`gantt-arrow-${taskIds[0] as string}-${successorId}`)).toBeVisible();
  });

  test("reaches the last of twenty-two rows, and Remove slack with it", async ({ page }) => {
    await page.goto(`/projects/${projectId}/gantt`);
    await expect(page.getByTestId("gantt")).toBeVisible();

    // THE NESTED SCROLL IS ASSERTED ON THE GRID ITSELF, not inferred from the
    // page. Twenty-two rows at a 32px pitch is 704px against the grid's 640px
    // cap, so the chart gains a second vertical scroll axis inside the page's
    // -- the geometry Task 5 left unmeasured. An earlier version of this test
    // asserted only that the last row was out of the VIEWPORT, which follows
    // from the page being taller than 664 whether or not the grid clips
    // anything: raising GRID_MAX_HEIGHT to 4000 removed the nested scroller
    // outright and the test stayed green. These two lines are what close that.
    const lastId = taskIds[ROW_COUNT - 1] as string;
    const grid = await chartScrollBox(page, lastId);
    expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
    expect(grid.scrollWidth).toBeGreaterThan(grid.clientWidth);

    // And it is still off screen on arrival, which is the reachability half.
    const lastTap = page.getByTestId(`gantt-label-tap-${lastId}`);
    await expect(lastTap).not.toBeInViewport();

    // Scrolled by hand FIRST, and not for convenience. Playwright reveals an
    // element by the smallest scroll that works, which can leave it flush with
    // the bottom of the viewport -- underneath the fixed bottom bar, whose hit
    // test would then intercept the click. <main> reserves 6rem below its
    // content for exactly this bar, so taking the page to its own end puts
    // that reservation between the chart and the bar; the grid's remaining
    // internal scroll is then Playwright's to do, safely.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await lastTap.click();
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(page.getByRole("heading", { name: lastTitle })).toBeVisible();
    await page.getByTestId("task-drawer").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("task-drawer")).toBeHidden();

    // AMENDMENT 5: Remove slack stays reachable on a phone, because it is a
    // click plus a window.confirm and both are phone-native. Hiding it would
    // have been this phase's first real capability exception. The per-project
    // button is the one that stays -- and it only exists on this page, not on
    // the global chart.
    const compact = page.getByTestId("compact-button");
    await expect(compact).toBeVisible();
    const compactBox = await compact.boundingBox();
    expect(compactBox).not.toBeNull();
    expect(compactBox?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

    // The confirm is not optional to handle: Playwright auto-dismisses an
    // unhandled dialog, which would make this a silent no-op that still
    // rendered nothing and passed a weaker assertion.
    page.once("dialog", (dialog) => void dialog.accept());
    await compact.click();

    // WHICH OUTCOME IT REPORTS IS NOT WORTH PINNING, and the first version of
    // this test pinned it wrongly. "These tasks have no dependencies, so there
    // is nothing to pull" was false, and CI said so: compactSchedule pulls
    // every movable task to the project's floor -- with no project start date,
    // the earliest start among its own dated tasks -- whether or not it has a
    // predecessor. So the task the previous test pushed into next week came
    // back, and the note read "1 task compacted".
    //
    // What this journey claims is Amendment 5's claim, that the sweep is
    // REACHABLE from a phone. The note carries one of two sentences and both
    // of them mean the confirm was accepted and the request ran; an unhandled
    // dialog, which Playwright auto-dismisses, would leave it empty.
    //
    // A NARROW WINDOW, and worth knowing rather than discovering: chart.tsx
    // clears this note 1000ms after it appears, and the assertion polls from
    // the moment of the click. It has caught it every run so far -- CI's log
    // showed five consecutive polls inside the window -- but a runner that
    // stalled for a second between the mutation resolving and the next poll
    // would fail here with "expected /compact/, received ''", which reads like
    // the sweep not running rather than like the note having already gone.
    // Anyone who sees that should suspect the window before the feature.
    await expect(page.getByTestId("cascade-note")).toContainText(/compact/);
  });
});

// ---------------------------------------------------------------------------
// 4. Meetings: log one on a record and spin a follow-up task out of it.
// ---------------------------------------------------------------------------

test.describe.serial("Phone meetings", () => {
  const runId = Date.now().toString(36);
  let attemptId = "";
  let companyName = "";
  let meetingTitle = "";
  let guestName = "";
  let notesText = "";
  let followUpTitle = "";
  let companyId = "";

  test("logs a meeting from the company's rail", async ({ page }, testInfo) => {
    attemptId = `${runId}x${testInfo.retry}`;
    companyName = `Phone meetco ${attemptId}`;
    meetingTitle = `Phone kickoff ${attemptId}`;
    guestName = `Gus Guest ${attemptId}`;
    notesText = `Agreed the phone pilot ${attemptId}`;
    followUpTitle = `Send the phone quote ${attemptId}`;

    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    companyId = page.url().split("/").pop() as string;

    // Nothing inside a Radix tab is mounted before its trigger is clicked, and
    // the default tab's own entry is the sentinel that makes the empty state
    // below a real emptiness rather than a race won.
    await expect(page.getByTestId("timeline-entry").filter({ hasText: "created" })).toBeVisible();
    await page.getByTestId("meetings-tab").click();
    await expect(page.getByTestId("meetings")).toBeVisible();
    await expect(page.getByTestId("meetings-empty")).toHaveText("No meetings yet");

    await page.getByTestId("log-meeting").click();
    const form = page.getByTestId("meeting-form");
    await expect(form).toBeVisible();
    await form.getByTestId("meeting-title").fill(meetingTitle);
    await form.getByTestId("meeting-duration").fill("30");

    // The guest is free text and needs no picker, which keeps this journey
    // about the phone form rather than about the entity picker meetings.spec.ts
    // already drives at a desk.
    await form.getByTestId("meeting-guest").fill(guestName);
    await form.getByTestId("meeting-add-guest").click();
    await expect(form.getByTestId("meeting-attendee-chip")).toHaveCount(1);

    // Real key events through the shared helper: the notes are a TipTap
    // document, and the editor takes focus from the click the helper makes.
    await typeIntoEditor(form.getByTestId("meeting-notes"), notesText);

    await form.getByTestId("meeting-submit").click();
    await expect(page.getByTestId("meeting-form")).toHaveCount(0);

    const row = page.locator('[data-testid^="meeting-row-"]').filter({ hasText: meetingTitle });
    await expect(row).toBeVisible();
    await expect(row).toContainText(guestName);
    await expect(row).toContainText("30m");
    await expect(row).toContainText("No follow-up tasks");
  });

  test("adds a follow-up task to it", async ({ page }) => {
    await page.goto(`/companies/${companyId}`);
    await page.getByTestId("meetings-tab").click();
    await expect(page.getByTestId("meetings")).toBeVisible();

    await page.locator('[data-testid^="meeting-row-"]').filter({ hasText: meetingTitle }).click();
    const view = page.getByTestId("meeting-view");
    await expect(view).toBeVisible();
    await expect(page.getByTestId("meeting-notes-body")).toContainText(notesText);

    // Wait for ENABLED, not merely for the page to settle: the control is
    // briefly disabled on a project-linked meeting while that project's
    // archived state is in flight.
    const addTask = page.getByTestId("meeting-add-task");
    await expect(addTask).toBeEnabled();
    await addTask.click();

    const taskForm = page.getByTestId("meeting-task-form");
    await taskForm.getByTestId("meeting-task-title").fill(followUpTitle);
    await taskForm.getByTestId("meeting-task-submit").click();
    await expect(page.getByTestId("meeting-task-form")).toHaveCount(0);

    // `li`, not a bare prefix match: the form's own controls share the prefix.
    await expect(
      page.locator('li[data-testid^="meeting-task-"]').filter({ hasText: followUpTitle }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. The inbox: three panes become three screens, and a reply from the last.
// ---------------------------------------------------------------------------

/**
 * THIS GROUP NEEDS THE CI MAIL FIXTURE -- the Dovecot and Mailpit containers
 * .github/workflows/test.yml's e2e job starts. The coordinates below are
 * deliberately DUPLICATED from e2e/mail.spec.ts rather than lifted into
 * e2e/helpers.ts: this phase's hard requirement is that the existing 72 tests
 * pass unchanged, and moving a constant out of that file changes it. They are
 * one journey's fixture on either side, which is the line helpers.ts draws.
 */
const IMAP_HOST = process.env.E2E_MAIL_IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.E2E_MAIL_IMAP_PORT ?? 993);
const SMTP_HOST = process.env.E2E_MAIL_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.E2E_MAIL_SMTP_PORT ?? 1025);
const MAIL_USERNAME = process.env.E2E_MAIL_USERNAME ?? "conduit@test.local";
const MAIL_PASSWORD = process.env.E2E_MAIL_PASSWORD ?? "testpass";

/**
 * The six env names above, exactly as e2e/mail.spec.ts spells them.
 *
 * WHY A GUARD AND NOT A SHARED CONSTANT. The two files read the same six
 * variables and mail.spec.ts must not be edited this phase, so they are
 * duplicated -- and duplication here drifts SILENTLY, which is the part that
 * earns a guard. Every read has a `?? default`, and the defaults are the same
 * values CI sets: rename `E2E_MAIL_IMAP_PORT` in one file and this one falls
 * back to 993, which is what CI would have given it anyway, so nothing fails
 * until somebody points the suite at a mailbox that is not on the default
 * ports. The guard reads the other spec's source and fails the moment the two
 * lists stop agreeing.
 */
const SHARED_MAIL_ENV = [
  "E2E_MAIL_IMAP_HOST", "E2E_MAIL_IMAP_PORT", "E2E_MAIL_SMTP_HOST",
  "E2E_MAIL_SMTP_PORT", "E2E_MAIL_USERNAME", "E2E_MAIL_PASSWORD",
] as const;

test.describe.serial("Phone inbox drill-in stack", () => {
  /**
   * The first sync pass has to ingest whatever else is in the mailbox as well
   * as this journey's own two messages -- e2e/mail.spec.ts runs before this
   * file and leaves roughly sixty messages in INBOX, and a fresh account
   * backfills all of them. Ours carry the newest INTERNALDATEs, so they are
   * ingested last; the budget is for the whole pass, not for two messages.
   */
  const SYNC_TIMEOUT_MS = 120_000;
  const ATTEMPT_TIMEOUT_MS = 5_000;
  test.setTimeout(240_000);

  const runId = Date.now().toString(36);
  let attemptId = "";
  let senderAddress = "";
  let subject = "";
  let textMarker = "";
  let htmlMarker = "";
  let replyBody = "";
  let accountLabel = "";
  let threadId = "";

  function rfc822(headers: string[], body: string): Buffer {
    return Buffer.from([...headers, "", body, ""].join("\r\n"), "utf8");
  }

  /** A real References chain, so mail-ingest threads the two into one
   * conversation rather than into two that merely share a subject. The second
   * is html and the first plain, which is what the conversation renders as an
   * iframe and a <pre> respectively. */
  function fixtures(): { raw: Buffer; date: Date }[] {
    const now = Date.now();
    const firstAt = new Date(now - 4 * 60_000);
    const secondAt = new Date(now - 2 * 60_000);
    const rootId = `<phone-1-${attemptId}@example.com>`;
    return [
      {
        date: firstAt,
        raw: rfc822([
          `From: Pat Phone <${senderAddress}>`,
          `To: Conduit <${MAIL_USERNAME}>`,
          `Subject: ${subject}`,
          `Message-ID: ${rootId}`,
          `Date: ${firstAt.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
        ], `First from Pat. Marker ${textMarker}.`),
      },
      {
        date: secondAt,
        raw: rfc822([
          `From: Pat Phone <${senderAddress}>`,
          `To: Conduit <${MAIL_USERNAME}>`,
          // "Re:" is stripped by normalizeSubject, so the THREAD is titled
          // `subject` -- which is what the row assertions match on.
          `Subject: Re: ${subject}`,
          `Message-ID: <phone-2-${attemptId}@example.com>`,
          `In-Reply-To: ${rootId}`,
          `References: ${rootId}`,
          `Date: ${secondAt.toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8",
        ], `<html><body><p>Second from Pat. Marker ${htmlMarker}.</p></body></html>`),
      },
    ];
  }

  /** Retry a check across reloads until it passes or the deadline runs out.
   * The inbox is live over SSE, so most of these pass first time; the reload
   * is the belt to that braces, since what is being waited for is a background
   * sync pass on the server. */
  async function pollWithReload(page: Page, check: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      try {
        await check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await page.reload();
      }
    }
  }

  function threadRow(page: Page): Locator {
    return page.locator('[data-testid^="thread-row-"]').filter({ hasText: subject });
  }

  function heading(page: Page): Locator {
    return page.getByRole("heading", { level: 1 });
  }

  /** Which of the three panes is on screen. All three are in the DOM at every
   * level -- the stack changes `display`, it does not unmount -- with the one
   * exception the conversation testid makes for itself: <Conversation> renders
   * only when `?thread=` is set, so at the other two levels it is genuinely
   * not there. */
  async function expectLevel(page: Page, level: "folders" | "threads" | "conversation"): Promise<void> {
    await expect(page.getByTestId("folder-sidebar")).toBeVisible({ visible: level === "folders" });
    await expect(page.getByTestId("thread-list")).toBeVisible({ visible: level === "threads" });
    if (level === "conversation") await expect(page.getByTestId("conversation")).toBeVisible();
    else await expect(page.getByTestId("conversation")).toHaveCount(0);
  }

  test("reads the same mail fixture e2e/mail.spec.ts does", async () => {
    // See SHARED_MAIL_ENV: the constants are duplicated because mail.spec.ts
    // may not be edited, and the duplication is invisible when it breaks. This
    // compares the names, not the values -- the values are the CI job's to
    // set, and both files agree on their defaults by construction if they
    // agree on the names.
    const other = readFileSync(new URL("./mail.spec.ts", import.meta.url), "utf8");
    for (const name of SHARED_MAIL_ENV) {
      expect(other, `${name} is no longer read by e2e/mail.spec.ts`).toContain(`process.env.${name}`);
    }
  });

  test("seeds the mailbox and adds the account, from the phone", async ({ page }, testInfo) => {
    attemptId = `${runId}x${testInfo.retry}`;
    senderAddress = `pat-${attemptId}@example.com`;
    subject = `Phone renewal ${attemptId}`;
    textMarker = `phonetext${attemptId}`;
    htmlMarker = `phonehtml${attemptId}`;
    replyBody = `Thanks Pat ${attemptId}`;
    accountLabel = `Phone Dovecot ${attemptId}`;

    // A live account left behind by e2e/mail.spec.ts (or by a previous attempt
    // of this one) would sync THIS SAME mailbox alongside the account added
    // below, ingesting every message twice into the same thread and doubling
    // the conversation this journey counts. Archiving stops its sync and
    // leaves its threads alone.
    //
    // THIS IS ONLY SAFE WHILE NOTHING ELSE IS RUNNING, and it is guarded rather
    // than merely commented. The loop archives every live account the dev user
    // has, not only this file's own -- and it HAS to, because the account it
    // most needs to stop is exactly e2e/mail.spec.ts's, pointed at this same
    // mailbox. A label or address filter would therefore not contain the
    // hazard, it would defeat the block. What contains it is refusing to run
    // concurrently at all: CI pins `workers: 1` for an unrelated reason (see
    // playwright.config.ts's dnd-kit note) and the suite is CI-only for this
    // project, so the two files never overlap today. The check below turns the
    // day somebody raises that number from a silent race -- mail.spec.ts's
    // account archived mid-journey, failing somewhere else entirely -- into a
    // refusal that says what to do.
    const listed = await page.request.get("/api/mail/accounts");
    expect(listed.ok()).toBe(true);
    const { own } = await listed.json() as {
      own: { id: string; archivedAt: string | null; visibility: "private" | "shared" }[];
    };
    const liveAccounts = own.filter((account) => account.archivedAt === null);
    if (liveAccounts.length > 0 && testInfo.config.workers !== 1) {
      throw new Error(
        `This group archives every live mail account (${liveAccounts.length} found) because a `
        + "second account on the same mailbox double-ingests every message. That races "
        + "e2e/mail.spec.ts at more than one worker. Re-run with --workers=1.",
      );
    }
    for (const account of liveAccounts) {
      // Archiving does not clear visibility and the account PATCH refuses
      // archived rows, so a shared account has to be made private first or it
      // can never be made private again.
      if (account.visibility === "shared") {
        const flipped = await page.request.patch(`/api/mail/accounts/${account.id}`, {
          data: { visibility: "private" },
        });
        expect(flipped.ok()).toBe(true);
      }
      const archived = await page.request.post(`/api/mail/accounts/${account.id}/archive`);
      expect(archived.ok()).toBe(true);
    }

    // Seeded BEFORE the account exists, so the account's very first pass is
    // what ingests them. No flags on the APPEND: they have to arrive unseen.
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: MAIL_USERNAME, pass: MAIL_PASSWORD },
      tls: { rejectUnauthorized: false },
      logger: false,
    });
    await client.connect();
    try {
      for (const fixture of fixtures()) {
        await client.append("INBOX", fixture.raw, [], fixture.date);
      }
    } finally {
      await client.logout();
    }

    // THE ACCOUNT FORM IS DRIVEN AT THIS VIEWPORT ON PURPOSE. It is the app's
    // longest form -- five field grids, including a three-column host/port/
    // security row -- and the mechanical sweep collapsed all of them to one
    // column. Nothing else in this suite renders it below the breakpoint.
    await page.goto("/settings/mail");
    await expect(page.getByTestId("mail-settings")).toBeVisible();
    await page.getByRole("button", { name: "Add account" }).click();
    const form = page.getByTestId("account-form");
    await expect(form).toBeVisible();

    const field = (name: string) => form.getByTestId(`field-${name}`).locator("input");
    await field("label").fill(accountLabel);
    await field("email").fill(MAIL_USERNAME);
    // The preset sets the two SECURITY halves correctly for these containers
    // (Dovecot serves IMAPS, Mailpit demands the STARTTLS upgrade); only the
    // hosts, ports and credentials are typed over it.
    await page.getByRole("button", { name: "Local Dovecot" }).click();
    await field("imap-host").fill(IMAP_HOST);
    await field("imap-port").fill(String(IMAP_PORT));
    await field("smtp-host").fill(SMTP_HOST);
    await field("smtp-port").fill(String(SMTP_PORT));
    await field("username").fill(MAIL_USERNAME);
    await field("password").fill(MAIL_PASSWORD);

    await form.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("account-form")).toBeHidden();
    await expect(
      page.locator('[data-testid^="mail-account-"]').filter({ hasText: accountLabel }),
    ).toBeVisible();
  });

  test("lands on the thread list, with the other two panes off screen", async ({ page }) => {
    await page.goto("/mail");

    // A SET, not a count: the list also holds whatever earlier specs ingested.
    await pollWithReload(page, async () => {
      await expect(threadRow(page)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
      // The html message's snippet, which only exists once the SECOND message
      // of the pair has landed -- so the conversation below is complete.
      await expect(threadRow(page)).toContainText(htmlMarker, { timeout: ATTEMPT_TIMEOUT_MS });
    });
    threadId = await idOf(threadRow(page), "thread-row-");

    // The HUB, not the root of a strict line: the Mail tab lands here, and the
    // one leading control points forward to the folders rather than back.
    await expect(heading(page)).toHaveText("Inbox");
    await expect(page.getByTestId("inbox-folders")).toBeVisible();
    await expect(page.getByTestId("inbox-back")).toHaveCount(0);
    await expectLevel(page, "threads");
    // Compose belongs to no pane and is on every level.
    await expect(page.getByTestId("compose-button")).toBeVisible();
  });

  test("drills out to the folders and back, moving focus to each destination", async ({ page }) => {
    await page.goto("/mail");
    await expect(threadRow(page)).toBeVisible();

    // THE CASE THAT DEFEATED THE FIRST FIX, and the reason to drive it from
    // the control itself. With a rail, Back and Folders are the SAME Button
    // relabelled, so React reconciles it in place -- focusing "the leading
    // control" after the transition would have been focusing the element that
    // already had focus, which does nothing and announces nothing. The heading
    // is the target precisely because it genuinely moves.
    const folders = page.getByTestId("inbox-folders");
    await folders.focus();
    await expect(folders).toBeFocused();
    await folders.click();

    await expect(heading(page)).toHaveText("Folders");
    // Auto-retrying, never a one-shot read of document.activeElement: the move
    // is a passive effect, so a synchronous read right after the click sees
    // the pre-effect value.
    await expect(heading(page)).toBeFocused();
    await expect(page.getByTestId("inbox-back")).toBeVisible();
    await expectLevel(page, "folders");

    await page.getByTestId("inbox-back").click();
    await expect(heading(page)).toHaveText("Inbox");
    await expect(heading(page)).toBeFocused();
    await expectLevel(page, "threads");
  });

  test("picks a folder, which is what the folder screen is for", async ({ page }) => {
    // THE LINE THIS TEST EXISTS FOR is `setFoldersOpen(false)` inside
    // `chooseFolder` (pages/inbox.tsx). Nothing else reaches it:
    // `inbox-lib.test.ts` takes `foldersOpen` as an INPUT, so it can say what
    // the view looks like with the flag set and cannot say who clears it, and
    // the drill-out test above leaves the folder screen by Back rather than by
    // choosing anything. Delete that one line and a phone user taps a folder
    // and stays on the folder rail while the list changes underneath, out of
    // sight -- with the whole suite green. The spec names the folder picker as
    // one of the things that must not become desktop-only, so this is the tap
    // that says it did not.
    await page.goto("/mail");
    await expect(threadRow(page)).toBeVisible();

    await page.getByTestId("inbox-folders").click();
    await expectLevel(page, "folders");
    // "All mail" is the resting view -- no folder filter at all -- and the rail
    // says so with the same marker it will move to the folder chosen below.
    await expect(page.getByTestId("folder-view-all")).toHaveAttribute("aria-current", "true");

    const inboxFolder = page.getByTestId("folder-INBOX");
    await expect(inboxFolder).toBeVisible();
    await inboxFolder.click();

    // THE NAVIGATION HALF: choosing is also leaving. The level is back at the
    // thread list, its leading control points forward again, and the folder
    // rail is off screen.
    await expect(heading(page)).toHaveText("Inbox");
    await expect(page.getByTestId("inbox-folders")).toBeVisible();
    await expectLevel(page, "threads");

    // THE FOLDER HALF: the list on screen is the chosen folder's. The thread
    // this journey seeded lives in INBOX, so it survives the filter -- and the
    // rail, reopened, has moved its current marker off "All mail" and onto the
    // row that was tapped, from the same `folder` state the query is built
    // from.
    await expect(threadRow(page)).toHaveCount(1);
    await page.getByTestId("inbox-folders").click();
    await expectLevel(page, "folders");
    await expect(page.getByTestId("folder-INBOX")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("folder-view-all")).not.toHaveAttribute("aria-current", "true");

    // Back to the unfiltered view the same way, so the level and the marker are
    // shown to move in both directions rather than once.
    await page.getByTestId("folder-view-all").click();
    await expectLevel(page, "threads");
    await expect(threadRow(page)).toHaveCount(1);
  });

  test("opens the conversation, replies from it, and comes back to the same list", async ({ page }) => {
    await page.goto("/mail");
    const row = threadRow(page);
    await expect(row).toBeVisible();

    // A MARK ON THE LIVE PANE, and what it is for. The stack HIDES panes, it
    // does not unmount them -- which is what keeps the thread list's
    // accumulated "Load more" pages, its query observer and the bulk bar's row
    // set alive while a conversation is open. The literal check for that is
    // "open a thread from page two, come back, count the rows", and it needs
    // 51 threads to reach page two (the list's default limit is 50), which is
    // a minute of IMAP seeding for one assertion. Marking the node instead
    // proves the same mechanism directly: an unmount and remount would replace
    // this element, and the attribute would be gone. What it does NOT prove is
    // the accumulator's own state, which is the honest limit of the substitute.
    const threadList = page.getByTestId("thread-list");
    await threadList.evaluate((node) => node.setAttribute("data-phone-pane-mark", "kept"));
    const rowsBefore = await page.locator('[data-testid^="thread-row-"]').count();

    await row.click();
    await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));
    await expect(heading(page)).toHaveText("Conversation");
    await expect(heading(page)).toBeFocused();
    await expectLevel(page, "conversation");

    const conversation = page.getByTestId("conversation");
    await expect(conversation).toContainText(subject);
    await expect(conversation.locator('[data-testid^="message-"]')).toHaveCount(2);

    // The reply, from the last screen of the stack. The composer is a
    // full-screen sheet here and opens focused on its own Close (a deferred
    // phase-level finding), so typing straight away would type into nothing --
    // typeIntoEditor clicks the editor and proves it took focus first.
    await page.getByTestId("reply-button").click();
    const composer = page.getByTestId("composer");
    await expect(composer).toBeVisible();
    await expect(composer).toContainText(senderAddress);
    await expect(page.getByTestId("composer-subject")).toHaveValue(`Re: ${subject}`);
    await typeIntoEditor(page.getByTestId("composer-body"), replyBody);
    await page.getByTestId("composer-send").click();
    await expect(composer).toBeHidden({ timeout: 60_000 });

    // It arrives in the conversation through the send's own response, so this
    // needs no sync pass -- only the invalidation to have been applied.
    await pollWithReload(page, async () => {
      await expect(conversation.locator('[data-testid^="message-"]'))
        .toHaveCount(3, { timeout: ATTEMPT_TIMEOUT_MS });
    });

    // Back to the hub -- and the list is the SAME list, not a fresh one.
    await page.getByTestId("inbox-back").click();
    await expect(heading(page)).toHaveText("Inbox");
    await expectLevel(page, "threads");
    await expect(threadList).toHaveAttribute("data-phone-pane-mark", "kept");
    await expect(page.locator('[data-testid^="thread-row-"]')).toHaveCount(rowsBefore);
  });

  test("deep-links straight to the conversation level", async ({ page }) => {
    // The selection lives in the URL, so opening a thread IS the navigation to
    // its screen: a link from the global search or a record's Mail tab lands
    // on the right screen with no effect to fix it up afterwards.
    await page.goto(`/mail?thread=${threadId}`);
    await expect(heading(page)).toHaveText("Conversation");
    await expectLevel(page, "conversation");
    await expect(page.getByTestId("conversation")).toContainText(subject);
  });
});
