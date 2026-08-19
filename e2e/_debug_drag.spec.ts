import { test } from "@playwright/test";

test("debug keyboard drag - exact no-delay repro", async ({ page }) => {
  await page.goto("/pipelines");
  await page.getByRole("button", { name: "New pipeline" }).click();
  await page.getByPlaceholder("Pipeline name").fill("Debug " + Date.now());
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/pipelines\/[0-9a-f-]{36}$/);

  async function addStage(name: string) {
    await page.getByRole("button", { name: "+ Stage", exact: true }).click();
    await page.getByPlaceholder("Stage name").fill(name);
    await page.getByRole("button", { name: "Add" }).click();
  }
  await addStage("Lead");
  await addStage("Qualified");
  await addStage("Won-stage");
  await page.waitForTimeout(300);

  const lead = page.locator('[data-testid^="column-"]').filter({ hasText: "Lead" });
  const qualified = page.locator('[data-testid^="column-"]').filter({ hasText: "Qualified" });
  const won = page.locator('[data-testid^="column-"]').filter({ hasText: "Won-stage" });
  const leadId = ((await lead.getAttribute("data-testid")) as string).replace("column-", "");
  const qualifiedId = ((await qualified.getAttribute("data-testid")) as string).replace("column-", "");
  const wonId = ((await won.getAttribute("data-testid")) as string).replace("column-", "");
  console.log(`LEAD=${leadId} QUALIFIED=${qualifiedId} WON=${wonId}`);

  async function createDeal(title: string) {
    await lead.getByRole("button", { name: "New deal" }).click();
    await page.getByPlaceholder("Deal title").fill(title);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(200);
  }
  await createDeal("Alpha");
  await createDeal("Beta");

  // Exactly the real journey's sequence: no waits between presses at all.
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = lead.locator('[data-testid^="card-"]').filter({ hasText: `Alpha-${attempt}` }).first();
    await createDeal(`Alpha-${attempt}`);
    await card.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await page.waitForTimeout(50);
    const status = await page.getByRole("status").last().textContent();
    const inLead = await lead.locator('[data-testid^="card-"]').filter({ hasText: `Alpha-${attempt}` }).count();
    const inQualified = await qualified.locator('[data-testid^="card-"]').filter({ hasText: `Alpha-${attempt}` }).count();
    const inWon = await won.locator('[data-testid^="card-"]').filter({ hasText: `Alpha-${attempt}` }).count();
    console.log(`attempt ${attempt}: status="${status}" inLead=${inLead} inQualified=${inQualified} inWon=${inWon}`);
  }
});
