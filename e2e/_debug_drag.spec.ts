import { test } from "@playwright/test";

test("debug fresh-page repro with browser console forwarding", async ({ page }) => {
  page.on("console", (msg) => {
    if (msg.text().startsWith("[dbg")) console.log("BROWSER:", msg.text());
  });

  await page.goto("/pipelines");
  await page.getByRole("button", { name: "New pipeline" }).click();
  await page.getByPlaceholder("Pipeline name").fill(`Debug-${Date.now()}`);
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

  const lead = page.locator('[data-testid^="column-"]').filter({ hasText: "Lead" });
  const qualified = page.locator('[data-testid^="column-"]').filter({ hasText: "Qualified" });
  const won = page.locator('[data-testid^="column-"]').filter({ hasText: "Won-stage" });

  async function createDeal(title: string) {
    await lead.getByRole("button", { name: "New deal" }).click();
    await page.getByPlaceholder("Deal title").fill(title);
    await page.getByRole("button", { name: "Create" }).click();
    const card = lead.locator('[data-testid^="card-"]').filter({ hasText: title });
    await card.waitFor({ state: "visible" });
  }
  await createDeal("Alpha");
  await createDeal("Beta");

  const alphaCard = lead.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" });
  console.log("--- SEQUENCE START ---");
  await alphaCard.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  console.log("--- SEQUENCE END ---");

  const status = await page.getByRole("status").last().textContent();
  const inLead = await lead.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
  const inQualified = await qualified.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
  const inWon = await won.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
  console.log(`RESULT: status="${status}" inLead=${inLead} inQualified=${inQualified} inWon=${inWon}`);
});
