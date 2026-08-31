import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// One serial journey through the Phase 2 pipeline/board flows: create a
// pipeline and its stages, create deals, keyboard-drag them across columns
// and within a column (the latter pins the P2.6 arrayMove downward-drop
// fix), win a deal, check the funnel view, search for a deal, and confirm a
// second browser context sees a live board update over SSE without
// reloading.
//
// Same runId convention as crm.spec.ts: every name is suffixed with a run id
// so this is safe to run against a DB that carries leftovers from an earlier
// local run, and every assertion below scopes to something containing it.
// Tests run in file order and share a single page (state -- pipelineId,
// stage ids, deal ids -- accumulates across them); a failure stops the rest
// rather than cascading into confusing downstream failures.
test.describe.serial("Pipeline journey", () => {
  const runId = Date.now().toString(36);
  const pipelineName = `Sales ${runId}`;
  const alphaTitle = `Alpha ${runId}`;
  const betaTitle = `Beta ${runId}`;
  const gammaTitle = `Gamma ${runId}`;
  const deltaTitle = `Delta ${runId}`;
  const echoTitle = `Echo ${runId}`;

  let page: Page;
  let pipelineId: string;
  let leadStageId: string;
  let qualifiedStageId: string;
  let alphaId: string;
  let betaId: string;
  let gammaId: string;
  let deltaId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  // -- helpers --------------------------------------------------------

  // Adds a stage via the board's "+ Stage" affordance and waits for the
  // form to collapse back to the tile -- AddStageTile only resets `adding`
  // in the mutation's onSuccess, so that collapse is a reliable signal the
  // stage actually landed before the next "+ Stage" click.
  async function addStage(name: string) {
    await page.getByRole("button", { name: "+ Stage", exact: true }).click();
    await page.getByPlaceholder("Stage name").fill(name);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("button", { name: "+ Stage", exact: true })).toBeVisible();
  }

  function columnByName(name: string): Locator {
    return page.locator('[data-testid^="column-"]').filter({ hasText: name });
  }

  async function stageIdOf(name: string): Promise<string> {
    const testid = await columnByName(name).getAttribute("data-testid");
    return (testid as string).replace("column-", "");
  }

  // Keyboard-drags a sortable card: Space lifts, each arrow moves one slot
  // or column, Space drops -- mirrors tasks.spec.ts's keyboardDragCard (same
  // kanban-core machinery under both boards); see that helper's doc comment
  // for why every step waits on dnd-kit's own aria-live announcements
  // instead of flat waits: the bare-setTimeout listener attach documented in
  // playwright.config.ts swallowed this file's waitless Arrow AND ending
  // Space outright on cold CI retry workers (run 32275345192 and the run
  // before it), leaving the drag stuck mid-air past the assertion timeout.
  async function keyboardDragCard(card: Locator, arrowKeys: string[]) {
    const announcement = page.locator('[id^="DndLiveRegion"]');
    await card.focus();
    await page.keyboard.press("Space");
    // Both lift-time announcements ("Picked up ...", then "... was moved
    // over ..." for the ghost's own column) must have committed before the
    // change-detection below can trust a text change to be an arrow's own.
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
          // Swallowed by the listener-attach race -- press again. Safe even
          // if the first press was processed but not yet committed: the
          // coordinate getter resolves absolute target coordinates, so the
          // duplicate re-resolves to the same target.
        }
      }
      if (!announced) throw new Error(`dnd-kit never announced a move for ${key}`);
    }
    await page.keyboard.press("Space");
    await expect(announcement).toContainText("was dropped");
  }

  // Opens the column's "New deal" dialog (it portals to the document body,
  // not the column, so the form fields are filled at the page level), fills
  // it in, and waits for the resulting card to appear in the column before
  // returning its id -- read off the card's own data-testid rather than
  // guessed, since creation order among siblings is the thing later steps
  // need to verify, not assume.
  async function createDealInColumn(column: Locator, title: string, value: string): Promise<string> {
    await column.getByRole("button", { name: "New deal" }).click();
    await page.getByPlaceholder("Deal title").fill(title);
    if (value !== "") await page.getByPlaceholder("Value (optional)").fill(value);
    await page.getByRole("button", { name: "Create" }).click();
    const card = column.locator('[data-testid^="card-"]').filter({ hasText: title });
    await expect(card).toBeVisible();
    const testid = await card.getAttribute("data-testid");
    return (testid as string).replace("card-", "");
  }

  // --------------------------------------------------------------------

  test("creates a pipeline and three stages", async () => {
    await page.goto("/pipelines");
    await page.getByRole("button", { name: "New pipeline" }).click();
    await page.getByPlaceholder("Pipeline name").fill(pipelineName);
    await page.getByRole("button", { name: "Create" }).click();

    // Creation navigates straight to the new pipeline's board.
    await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
    pipelineId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: pipelineName })).toBeVisible();

    await addStage("Lead");
    await addStage("Qualified");
    // A third stage the deals never actually reach -- winning a deal is a
    // status transition, not a move onto a "Won" stage (see board.tsx's
    // comment: a closed deal's stage is frozen). It exists only so the board
    // has three columns, as the journey calls for.
    await addStage("Won-stage");

    await expect(page.locator('[data-testid^="column-"]')).toHaveCount(3);
    leadStageId = await stageIdOf("Lead");
    qualifiedStageId = await stageIdOf("Qualified");
  });

  test("creates two deals in Lead", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    const lead = page.getByTestId(`column-${leadStageId}`);

    alphaId = await createDealInColumn(lead, alphaTitle, "1000");
    betaId = await createDealInColumn(lead, betaTitle, "2500");

    await expect(lead.getByTestId(`card-${alphaId}`)).toBeVisible();
    await expect(lead.getByTestId(`card-${betaId}`)).toBeVisible();
  });

  test("keyboard-drags Alpha from Lead to Qualified", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    const lead = page.getByTestId(`column-${leadStageId}`);
    const qualified = page.getByTestId(`column-${qualifiedStageId}`);
    const alphaCard = lead.getByTestId(`card-${alphaId}`);

    await keyboardDragCard(alphaCard, ["ArrowRight"]);

    await expect(qualified.getByTestId(`card-${alphaId}`)).toBeVisible();
    await expect(lead.getByTestId(`card-${alphaId}`)).not.toBeVisible();

    await page.goto(`/deals/${alphaId}`);
    await expect(
      page.getByTestId("timeline-entry").filter({ hasText: "moved from Lead to Qualified" }),
    ).toBeVisible();
  });

  test("keyboard-drags Beta down past Gamma within Lead (downward-drop regression)", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    const lead = page.getByTestId(`column-${leadStageId}`);

    // Alpha already left for Qualified, so Lead is [Beta] going in; creation
    // appends at the tail, so it becomes [Beta, Gamma, Delta].
    gammaId = await createDealInColumn(lead, gammaTitle, "500");
    deltaId = await createDealInColumn(lead, deltaTitle, "750");
    await expect(lead.locator('[data-testid^="card-"]')).toHaveCount(3);

    const betaCard = lead.getByTestId(`card-${betaId}`);
    await keyboardDragCard(betaCard, ["ArrowDown"]);

    // This pins the P2.6 arrayMove fix: dnd-kit's own drop preview places a
    // downward-dragged card AFTER the card it's dropped on, so Beta should
    // land right after Gamma, not before it -- [Gamma, Beta, Delta]. Read
    // off the cards' actual DOM order within the column, the same order the
    // user saw during the drag.
    const ids = await lead.locator('[data-testid^="card-"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
    expect(ids).toEqual([`card-${gammaId}`, `card-${betaId}`, `card-${deltaId}`]);
  });

  test("wins Beta and it drops off the board", async () => {
    await page.goto(`/deals/${betaId}`);
    await page.getByTestId("win-button").click();

    await expect(page.getByTestId("deal-status")).toContainText("Won");
    await expect(page.getByTestId("timeline-entry").filter({ hasText: "won" })).toBeVisible();

    // Won/lost deals never render on the board -- open-only filter.
    //
    // GAMMA IS THE LOADED-BOARD SENTINEL, AND WITHOUT ONE THIS SAID NOTHING.
    // Every card on this page is rendered from the deals query, so for the
    // first moments after a navigation the board holds no cards at all -- and
    // a negated auto-retrying matcher is satisfied by an element that does not
    // exist yet, on its very first poll. Measured with board.tsx's open-only
    // filter replaced by `filter(() => true)`, so a won deal DOES render here:
    // this test stayed green, while a probe that waited for the card first saw
    // it arrive. Gamma is still open in Lead and is the cheapest thing on the
    // page that proves the query has answered.
    await page.goto(`/pipelines/${pipelineId}`);
    await expect(page.getByTestId(`card-${gammaId}`)).toBeVisible();
    await expect(page.getByTestId(`card-${betaId}`)).toHaveCount(0);
  });

  test("funnel view shows counts and formatted values", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    await page.getByTestId("view-toggle").getByRole("button", { name: "Funnel" }).click();
    await expect(page.getByTestId("funnel")).toBeVisible();

    const qualifiedRow = page.getByTestId(`funnel-row-${qualifiedStageId}`);
    const leadRow = page.getByTestId(`funnel-row-${leadStageId}`);

    // Qualified holds just Alpha; Lead holds the deals still open there
    // (Gamma, Delta) now that Beta has been won and dropped out of the count.
    await expect(qualifiedRow.locator(":scope > span").nth(1)).toHaveText("1");
    await expect(leadRow.locator(":scope > span").nth(1)).toHaveText("2");

    // Values render currency-formatted, not bare numbers.
    await expect(qualifiedRow.locator(":scope > span").nth(2)).toHaveText(/\D/);
    await expect(leadRow.locator(":scope > span").nth(2)).toHaveText(/\D/);
  });

  test("finds Alpha via global search and navigates to it", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    const searchInput = page.getByTestId("search-input");
    // Lowercase fragment against a title that was created capitalized --
    // exercises the search's case-insensitive match, same spirit as
    // crm.spec's note/company search assertions.
    await searchInput.fill(`alpha ${runId}`);

    const dealResult = page.getByTestId("search-result").filter({ hasText: alphaTitle });
    await expect(dealResult).toBeVisible();
    await searchInput.press("Enter");

    await expect(page).toHaveURL(`/deals/${alphaId}`);
  });

  test("a second browser context sees a new deal appear over SSE without reloading", async ({ browser }) => {
    await page.goto(`/pipelines/${pipelineId}`);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`/pipelines/${pipelineId}`);
    await expect(page2.getByTestId(`column-${leadStageId}`)).toBeVisible();

    const lead = page.getByTestId(`column-${leadStageId}`);
    const echoId = await createDealInColumn(lead, echoTitle, "");

    // Generous timeout: this is waiting on the SSE hint to arrive, the
    // client's 100ms coalescing window, and a refetch -- not a page reload.
    const lead2 = page2.getByTestId(`column-${leadStageId}`);
    await expect(lead2.getByTestId(`card-${echoId}`)).toBeVisible({ timeout: 10_000 });

    await context2.close();
  });

  test("archives the pipeline, hides it from the default list, and restores it via the board's Unarchive banner", async () => {
    await page.goto(`/pipelines/${pipelineId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    // ARMED BEFORE THE CLICK THAT CAUSES IT, because the absence below has to
    // be asked of a list that has ANSWERED and this index has no sentinel of
    // its own: pipelines.tsx renders `data = []` while the query is in flight,
    // and its "No pipelines yet." never appears in a full run because other
    // specs' pipelines are on this page too. Measured with listPipelines's
    // archived filter removed server-side, so the archived row DOES come back
    // in the default list: without this wait the assertion below stayed green
    // across two runs, because a negated auto-retrying matcher is satisfied by
    // an element that has not been rendered yet.
    const listed = page.waitForResponse(
      (response) => /\/api\/pipelines\?archived=false$/.test(response.url()) && response.ok(),
    );
    await page.getByTestId("archive-pipeline-button").click();

    await expect(page).toHaveURL(/\/pipelines$/);

    // Gone from the default (non-archived) list.
    await listed;
    await expect(page.getByTestId(`pipeline-row-${pipelineId}`)).toHaveCount(0);

    // Present once the Archived toggle is turned on.
    await page.getByRole("checkbox", { name: "Archived" }).check();
    await expect(page.getByTestId(`pipeline-row-${pipelineId}`)).toBeVisible();

    // Board still loads, read-only, with an Unarchive affordance in the banner.
    await page.goto(`/pipelines/${pipelineId}`);
    await expect(page.getByRole("alert")).toContainText("archived");
    await expect(page.getByTestId("archive-pipeline-button")).not.toBeVisible();
    await page.getByTestId("unarchive-pipeline-button").click();

    // Unarchiving stays on the board (unlike archiving, which navigates
    // away) and restores the normal "Archive pipeline" affordance.
    await expect(page.getByTestId("archive-pipeline-button")).toBeVisible();
    await expect(page.getByRole("alert")).not.toBeVisible();

    // Back in the default (non-archived) list on the pipelines index.
    await page.goto("/pipelines");
    await expect(page.getByTestId(`pipeline-row-${pipelineId}`)).toBeVisible();
  });
});
