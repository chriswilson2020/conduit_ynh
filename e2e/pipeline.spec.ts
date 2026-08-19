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
    // TEMPORARY DEBUG INSTRUMENTATION -- see keyboard-drag race investigation.
    page.on("console", (msg) => {
      if (msg.text().startsWith("[dbg")) console.log("BROWSER:", msg.text());
    });
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

    // dnd-kit keyboard drag: focus the sortable element itself (the card),
    // then Space lifts, ArrowRight moves it into the next column, Space drops.
    await alphaCard.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");

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
    await betaCard.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");

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
    await page.goto(`/pipelines/${pipelineId}`);
    await expect(page.getByTestId(`card-${betaId}`)).not.toBeVisible();
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
});
