import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Keyboard-drags a sortable card: Space lifts, each arrow moves one slot or
// column, Space drops. dnd-kit's KeyboardSensor attaches the document-level
// keydown listener that handles everything AFTER the lift via a bare
// setTimeout queued while handling the lift itself (see playwright.config.ts
// on this), and under CI's variable-load CPU that timer can lose not just a
// same-tick follow-up press but one issued a flat 50ms later -- run
// 32275345192 (and the run before it) showed an ArrowRight swallowed despite
// that wait, and pipeline.spec.ts's waitless drags on cold retry workers
// losing BOTH the arrow and the ending Space, leaving the drag stuck mid-air
// past the assertion timeout. Flat waits guess; dnd-kit's own aria-live
// region does not: every press it actually processes commits a new
// announcement ("Picked up ...", "... was moved over ...", "... was dropped
// over ..."). So each step here waits for its announcement, and an arrow
// whose announcement never arrives is pressed again -- a swallowed keydown
// left no state behind, and a processed-but-not-yet-committed one converges
// anyway because the coordinate getter resolves the TARGET's absolute
// coordinates, not a delta: a duplicate press re-resolves to the same target
// while the first's render is still pending. Used by the journey describe
// below (and mirrored in pipeline.spec.ts, whose board reuses the same
// kanban-core machinery); the off-screen-columns regression at the bottom
// deliberately bypasses it for the arrow/drop -- see its comment for why an
// announcement-gated drop would mask the very bug it pins.
async function keyboardDragCard(page: Page, card: Locator, arrowKeys: string[]) {
  const announcement = page.locator('[id^="DndLiveRegion"]');
  await card.focus();
  await page.keyboard.press("Space");
  // The lift settles in two announcements ("Picked up ...", then "... was
  // moved over ..." once `over` resolves to the ghost's own column). Waiting
  // for the second means every lift-time render has committed before the
  // first arrow, so a text CHANGE below can only be that arrow's own
  // announcement, never a late lift one.
  await expect(announcement).toContainText("was moved over");
  for (const key of arrowKeys) {
    let announced = false;
    for (let attempt = 0; attempt < 3 && !announced; attempt += 1) {
      const before = (await announcement.textContent()) ?? "";
      await page.keyboard.press(key);
      try {
        await expect(announcement).not.toHaveText(before, { timeout: 1500 });
        announced = true;
      } catch {
        // Swallowed by the listener-attach race above -- press again.
      }
    }
    if (!announced) throw new Error(`dnd-kit never announced a move for ${key}`);
  }
  await page.keyboard.press("Space");
  // An announced arrow proves the document listener is attached, so this
  // Space cannot be swallowed -- but wait for the drop to commit before
  // returning ("dropped over" when it lands on a droppable, bare "dropped"
  // otherwise) rather than racing the caller's assertions against it.
  await expect(announcement).toContainText("was dropped");
}

// One serial journey through Phase 3's project/task/board/drawer/Gantt
// flows (Task 10): create a project, build a small task board, keyboard-drag
// a card, wire up dates and a dependency via the drawer, open the Gantt and
// keyboard-nudge a bar to prove the dependency cascade, confirm the shift
// shows up on the project's timeline rail, drag a card to done, check My
// Tasks and the global Gantt, and finish with a global-search round trip.
//
// Same runId convention as crm.spec.ts/pipeline.spec.ts: every name is
// suffixed with a run id so this is safe against a DB carrying leftovers
// from an earlier local run, and every assertion scopes to something
// containing it. Tests run in file order and share a single page (state --
// projectId, task ids -- accumulates across them); a failure stops the rest
// rather than cascading into confusing downstream failures.
test.describe.serial("Tasks/Gantt journey", () => {
  const runId = Date.now().toString(36);
  const projectName = `Apollo ${runId}`;
  const designTitle = `Design ${runId}`;
  const buildTitle = `Build ${runId}`;
  const shipTitle = `Ship ${runId}`;

  let page: Page;
  let projectId: string;
  let designId: string;
  let buildId: string;
  let shipId: string;

  test.beforeAll(async ({ browser }) => {
    // Wider than Playwright's 1280x720 default: the task board's four
    // w-72 (288px) columns plus gaps need ~1200px on their own, and the
    // shell's fixed 224px sidebar plus main's px-6 padding eats another
    // ~272px -- under the default viewport, "Blocked"/"Done" sit off-screen
    // needing a horizontal scroll to reach. Off-screen targets used to make
    // a keyboard cross-column drag drop back onto its starting column (CI
    // runs 32271110864/32272013870); kanban-core's coordinate getter now
    // scrolls the target into view (see kanbanKeyboardCoordinateGetter's
    // doc comment), with the off-screen-columns regression at the bottom of
    // this file pinning that. The journey still runs wide so its many drag
    // steps exercise the plain on-screen path, independent of scrolling.
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
  });

  // -- helpers --------------------------------------------------------

  function boardColumn(status: string): Locator {
    return page.getByTestId(`column-${status}`);
  }

  // Opens a column's "New task" dialog, fills the title, and waits for the
  // resulting card to appear before reading its id off the card's own
  // data-testid -- mirrors pipeline.spec.ts's createDealInColumn.
  async function createTaskInColumn(status: string, title: string): Promise<string> {
    const column = boardColumn(status);
    await column.getByRole("button", { name: "New task" }).click();
    await page.getByPlaceholder("Task title").fill(title);
    await page.getByRole("button", { name: "Create" }).click();
    const card = column.locator('[data-testid^="card-"]').filter({ hasText: title });
    await expect(card).toBeVisible();
    const testid = await card.getAttribute("data-testid");
    return (testid as string).replace("card-", "");
  }

  // Opens the drawer via a card click (task-board.tsx's openTask, a ?task=
  // replace-navigation) and waits for the drawer body to actually resolve
  // this task (its title heading matches) before returning.
  async function openDrawerFromCard(taskId: string, title: string) {
    await page.getByTestId(`card-${taskId}`).click();
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }

  async function closeDrawer() {
    await page.getByTestId("task-drawer").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("task-drawer")).not.toBeVisible();
  }

  // Fills the drawer's paired start/due inputs and clicks Save -- the Save
  // button only enables once both dates are set (taskDatesPaired) and the
  // drafts differ from the loaded task, so this waits on that instead of a
  // bare click succeeding regardless.
  async function setDrawerDates(startDate: string, dueDate: string) {
    const datesField = page.getByTestId("field-dates");
    await datesField.getByLabel("Start date").fill(startDate);
    await datesField.getByLabel("Due date").fill(dueDate);
    const saveButton = datesField.getByRole("button", { name: "Save" });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    // Dates commit via updateTask -- wait for the drafts to read back from
    // the refetched task (the inputs stay controlled by task.startDate/
    // dueDate once the mutation settles) rather than assuming the click
    // alone means the save landed.
    await expect(datesField.getByLabel("Start date")).toHaveValue(startDate);
    await expect(datesField.getByLabel("Due date")).toHaveValue(dueDate);
  }

  // --------------------------------------------------------------------

  test("creates a project and lands on its detail page", async () => {
    await page.goto("/projects");
    // entity-table.tsx's create trigger is always labelled bare "New" (the
    // dialog it opens is titled "New project" -- projects.tsx's
    // NewProjectDialog -- but the trigger button itself is not).
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    projectId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

    await expect(page.getByTestId("project-pipelines")).toBeVisible();
    await expect(page.getByTestId("rail")).toBeVisible();
  });

  test("creates three tasks on the board", async () => {
    await page.goto(`/projects/${projectId}/board`);

    designId = await createTaskInColumn("todo", designTitle);
    buildId = await createTaskInColumn("todo", buildTitle);
    shipId = await createTaskInColumn("todo", shipTitle);

    const todo = boardColumn("todo");
    await expect(todo.locator('[data-testid^="card-"]')).toHaveCount(3);
  });

  test("keyboard-drags Design from To do to In progress", async () => {
    await page.goto(`/projects/${projectId}/board`);
    const todo = boardColumn("todo");
    const inProgress = boardColumn("in_progress");
    const designCard = todo.getByTestId(`card-${designId}`);

    await keyboardDragCard(page, designCard, ["ArrowRight"]);

    await expect(inProgress.getByTestId(`card-${designId}`)).toBeVisible();
    await expect(todo.getByTestId(`card-${designId}`)).not.toBeVisible();
  });

  test("sets dates on Design and Build, and links Design as Build's dependency", async () => {
    await page.goto(`/projects/${projectId}/board`);

    await openDrawerFromCard(designId, designTitle);
    await setDrawerDates("2026-09-01", "2026-09-05");
    await closeDrawer();

    await openDrawerFromCard(buildId, buildTitle);
    await setDrawerDates("2026-09-08", "2026-09-12");

    // Add-dependency select: candidates are same-project tasks other than
    // this one and its existing predecessors, so Design is present. Scoped
    // to the Dependencies section specifically -- the drawer also has Type/
    // Status/Assignee selects, so an unscoped combobox role query would be
    // ambiguous.
    const depSection = page.locator('[data-testid="task-drawer"] section', { hasText: "Dependencies" });
    const depSelect = depSection.getByRole("combobox");
    await depSelect.click();
    await page.getByRole("option", { name: designTitle }).click();
    await depSection.getByRole("button", { name: "Add" }).click();

    const depList = page.getByTestId("dependency-list");
    await expect(depList).toContainText(designTitle);

    await closeDrawer();
  });

  test("Gantt shows both bars and the dependency arrow", async () => {
    await page.goto(`/projects/${projectId}/gantt`);
    await expect(page.getByTestId("gantt")).toBeVisible();

    await expect(page.getByTestId(`gantt-bar-${designId}`)).toBeVisible();
    await expect(page.getByTestId(`gantt-bar-${buildId}`)).toBeVisible();
    await expect(page.getByTestId(`gantt-arrow-${designId}-${buildId}`)).toBeVisible();
  });

  test("nudging Design's bar past Build cascades a shift onto Build", async () => {
    await page.goto(`/projects/${projectId}/gantt`);
    const designBar = page.getByTestId(`gantt-bar-${designId}`);
    const buildBar = page.getByTestId(`gantt-bar-${buildId}`);

    const buildTitleBefore = await buildBar.getAttribute("title");

    // Design runs 2026-09-01 to 2026-09-05, Build starts 2026-09-08 -- a
    // 10-day rightward nudge pushes Design's due date to 2026-09-15, well
    // past Build's start, which the successor-respecting shift must push
    // forward too. Nudges accumulate locally and commit ~200ms after the
    // last keypress (see gantt/chart.tsx's NUDGE_DEBOUNCE_MS) -- pressing
    // ArrowRight 10 times with no pause between presses mirrors a single
    // settled gesture, not 10 separate commits.
    await designBar.focus();
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowRight");

    // Cascade-note is aria-live and cleared ~1s after it appears (chart.tsx's
    // triggerFlash), so assert it promptly rather than after any other wait.
    await expect(page.getByTestId("cascade-note")).toContainText(/task.*shifted/);

    // The bar's title carries "<title>: <start> to <due>" (bar.tsx) -- wait
    // for it to actually change from its pre-nudge value, which is the
    // commit landing (the shiftTask mutation resolving and taskById
    // refetching), not just the local drag-preview render.
    await expect(async () => {
      const titleNow = await buildBar.getAttribute("title");
      expect(titleNow).not.toBe(buildTitleBefore);
    }).toPass();

    const buildTitleAfter = await buildBar.getAttribute("title");
    expect(buildTitleAfter).toContain("2026-09");
    // Build's due date must land AFTER Design's new due date (2026-09-15) --
    // confirms this was a genuine successor cascade, not a no-op.
    expect(buildTitleAfter).not.toBe(`${buildTitle}: 2026-09-08 to 2026-09-12`);
  });

  test("Remove slack pulls Build back to touch Design's due date once slack is reintroduced", async () => {
    // The cascade above already lands Build with ZERO slack (shiftTask's own
    // successor push sets a violated successor's start to exactly its
    // predecessor's new due date, never further) -- compacting right after
    // it would be a no-op. Reintroduce real slack first via a plain drawer
    // edit (updateTask, no cascade involved) so there's something for the
    // compactor to actually pull.
    await page.goto(`/projects/${projectId}/board`);
    await openDrawerFromCard(buildId, buildTitle);
    await setDrawerDates("2026-09-20", "2026-09-24");
    await closeDrawer();

    await page.goto(`/projects/${projectId}/gantt`);
    const buildBar = page.getByTestId(`gantt-bar-${buildId}`);
    await expect(buildBar).toHaveAttribute("title", `${buildTitle}: 2026-09-20 to 2026-09-24`);

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("compact-button").click();

    // Only Build moves -- Design has no predecessor and never moves.
    await expect(page.getByTestId("cascade-note")).toContainText(/1 task compacted/);

    // Design sits at 2026-09-11..09-15 (the +10-day nudge from the previous
    // test). Build's 4-day duration is preserved, pulled back to touch
    // Design's due date exactly -- the same tight position the earlier
    // cascade itself landed it in, before this test's manual edit
    // reintroduced slack.
    await expect(buildBar).toHaveAttribute("title", `${buildTitle}: 2026-09-15 to 2026-09-19`);
  });

  test("the project rail's Timeline shows a shifted entry", async () => {
    await page.goto(`/projects/${projectId}`);
    const rail = page.getByTestId("rail");
    await expect(rail).toBeVisible();

    // Timeline is the rail's default tab (rail.tsx) -- no tab click needed.
    const shiftedEntry = page
      .getByTestId("timeline-entry")
      .filter({ hasText: "shifted" })
      .filter({ hasText: "cascaded" });
    await expect(shiftedEntry.first()).toBeVisible();
  });

  test("drags Build to Done on the board", async () => {
    // Only Design was dragged earlier (todo -> in_progress); Build has sat
    // in To do since its creation, so this needs three column hops: todo(0)
    // -> in_progress(1) -> blocked(2) -> done(3). Three SEPARATE lift/arrow/
    // drop gestures (proven: one lift with three stacked arrows does not
    // reliably advance three columns), each preceded by its own page.goto
    // for a settled starting DOM, matching every other passing keyboard
    // drag in this file/pipeline.spec.ts.
    const todo = boardColumn("todo");
    const inProgress = boardColumn("in_progress");
    const blocked = boardColumn("blocked");
    const done = boardColumn("done");

    await page.goto(`/projects/${projectId}/board`);
    await keyboardDragCard(page, todo.getByTestId(`card-${buildId}`), ["ArrowRight"]);
    await expect(inProgress.getByTestId(`card-${buildId}`)).toBeVisible();

    await page.goto(`/projects/${projectId}/board`);
    await keyboardDragCard(page, inProgress.getByTestId(`card-${buildId}`), ["ArrowRight"]);
    await expect(blocked.getByTestId(`card-${buildId}`)).toBeVisible();

    await page.goto(`/projects/${projectId}/board`);
    await keyboardDragCard(page, blocked.getByTestId(`card-${buildId}`), ["ArrowRight"]);
    await expect(done.getByTestId(`card-${buildId}`)).toBeVisible();
    await expect(todo.getByTestId(`card-${buildId}`)).not.toBeVisible();
  });

  test("assigns Ship to the dev user and finds it in My Tasks", async () => {
    // NewTaskDialog creates tasks unassigned (task-board.tsx) -- assign Ship
    // to the current (dev) user via its drawer so it has an owner for My
    // Tasks to group.
    await page.goto(`/projects/${projectId}/board`);
    await openDrawerFromCard(shipId, shipTitle);

    const ownerSelect = page.getByTestId("field-assigneeUserId").getByRole("combobox");
    await ownerSelect.click();
    // playwright.config.ts's webServer sets CONDUIT_DEV_USER=e2euser, and
    // auth.ts's devUser fallback identity gives that user both username AND
    // fullName "e2euser" -- OwnerSelect renders `fullName ?? username`, so
    // "e2euser" is this environment's one real (non-"Unassigned") option.
    await page.getByRole("option", { name: "e2euser" }).click();
    await expect(page.getByTestId("field-assigneeUserId")).toContainText("e2euser");
    await closeDrawer();

    await page.goto("/my-tasks");
    await expect(page.getByTestId("my-tasks")).toBeVisible();
    // Ship has no due date, so it lands in Undated (task-board's
    // NewTaskDialog never sets one, and Ship's own drawer was never given
    // one either).
    await expect(page.getByTestId("group-undated")).toContainText(shipTitle);
  });

  test("global Gantt shows the Apollo project group and its bars", async () => {
    await page.goto("/gantt");
    await expect(page.getByTestId("gantt")).toBeVisible();

    await expect(page.getByTestId(`gantt-group-${projectId}`)).toContainText(projectName);
    await expect(page.getByTestId(`gantt-bar-${designId}`)).toBeVisible();
    await expect(page.getByTestId(`gantt-bar-${buildId}`)).toBeVisible();
  });

  test("finds Ship via global search and opens its drawer", async () => {
    await page.goto(`/projects/${projectId}/board`);
    const searchInput = page.getByTestId("search-input");
    await searchInput.fill(`ship ${runId}`);

    const taskResult = page.getByTestId("search-result").filter({ hasText: shipTitle });
    await expect(taskResult).toBeVisible();
    await searchInput.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/board\\?task=${shipId}`));
    await expect(page.getByTestId("task-drawer")).toBeVisible();
    await expect(page.getByRole("heading", { name: shipTitle })).toBeVisible();
  });
});

// Regression for the off-screen-column keyboard drag (see kanban-core.tsx's
// kanbanKeyboardCoordinateGetter): at a viewport narrow enough that the Done
// column sits outside the board's visible area, a keyboard cross-column drag
// must still land -- the journey above deliberately runs WIDE (1600x900, see
// its beforeAll) so its many drag steps never depend on scrolling, which is
// exactly why it can't catch this. 1000px leaves ~728px for the board after
// the 224px sidebar and px-6 padding, so of the four 288px+16px-gap columns
// only To do and In progress fit -- Blocked is clipped and Done is fully
// off-screen, the layout CI runs 32271110864/32272013870 first failed under.
test.describe.serial("Task board keyboard drag with off-screen columns", () => {
  const runId = `${Date.now().toString(36)}n`;
  const projectName = `Narrow ${runId}`;
  const taskTitle = `Move ${runId}`;

  let page: Page;
  let projectId: string;
  let taskId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("creates a project with one task in Blocked", async () => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    projectId = page.url().split("/").pop() as string;

    // Created directly in Blocked so the regression below needs exactly one
    // hop: Blocked(2) -> Done(3), the drag whose TARGET is off-screen.
    await page.goto(`/projects/${projectId}/board`);
    const blocked = boardColumn("blocked");
    await blocked.getByRole("button", { name: "New task" }).click();
    await page.getByPlaceholder("Task title").fill(taskTitle);
    await page.getByRole("button", { name: "Create" }).click();
    const card = blocked.locator('[data-testid^="card-"]').filter({ hasText: taskTitle });
    await expect(card).toBeVisible();
    taskId = ((await card.getAttribute("data-testid")) as string).replace("card-", "");
  });

  test("keyboard-drags the card into the off-screen Done column", async () => {
    const blocked = boardColumn("blocked");
    const done = boardColumn("done");

    // Deliberately NOT keyboardDragCard for the arrow and drop: that helper
    // waits for the arrow's "was moved over" announcement before dropping,
    // and the UNFIXED sensor's smooth-scroll fallback also updates `over`
    // (and announces) a few hundred ms into such a wait -- an
    // announcement-gated drop would pass against the very bug this test
    // pins (Codex review on PR #1). The bug's victim is precisely the fast
    // drop, so the drop is pressed immediately after the arrow; the fixed
    // coordinate getter commits the move inside the ArrowRight keydown
    // itself, which is what makes that immediate drop land. Only the lift
    // keeps its announcement sync (the listener-attach race is orthogonal
    // to the scroll race), and the swallowed-keypress flake the helper's
    // re-press normally absorbs is handled here by retrying the WHOLE
    // gesture from a fresh page load instead: a swallowed key leaves an
    // attempt a visible no-op a later attempt redoes, while the actual bug
    // fails every attempt.
    await expect(async () => {
      await page.goto(`/projects/${projectId}/board`);
      // The regression's premise: Done must actually start off-screen, or
      // this degenerates into the same on-screen drag the wide journey
      // already covers. Guards the viewport/column arithmetic above against
      // layout drift silently widening what fits.
      await expect(done).not.toBeInViewport();

      const card = blocked.getByTestId(`card-${taskId}`);
      await card.focus();
      await page.keyboard.press("Space");
      await expect(page.locator('[id^="DndLiveRegion"]')).toContainText("was moved over");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");

      await expect(done.getByTestId(`card-${taskId}`)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30_000 });
    await expect(blocked.getByTestId(`card-${taskId}`)).not.toBeVisible();
  });

  function boardColumn(status: string): Locator {
    return page.getByTestId(`column-${status}`);
  }
});
