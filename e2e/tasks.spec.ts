import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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
    page = await browser.newPage();
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

    await designCard.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");

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
    await page.goto(`/projects/${projectId}/board`);
    const inProgress = boardColumn("in_progress");
    const done = boardColumn("done");
    const buildCard = inProgress.getByTestId(`card-${buildId}`);

    await buildCard.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");

    await expect(done.getByTestId(`card-${buildId}`)).toBeVisible();
    await expect(inProgress.getByTestId(`card-${buildId}`)).not.toBeVisible();
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
