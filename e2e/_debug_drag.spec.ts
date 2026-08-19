import { test, expect } from "@playwright/test";

for (let attempt = 0; attempt < 5; attempt++) {
  test(`debug fresh-page repro attempt ${attempt}`, async ({ page }) => {
    await page.goto("/pipelines");
    await page.getByRole("button", { name: "New pipeline" }).click();
    await page.getByPlaceholder("Pipeline name").fill(`Debug${attempt}-${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/pipelines\/[0-9a-f-]{36}$/);

    async function addStage(name: string) {
      await page.getByRole("button", { name: "+ Stage", exact: true }).click();
      await page.getByPlaceholder("Stage name").fill(name);
      await page.getByRole("button", { name: "Add" }).click();
      await expect(page.getByRole("button", { name: "+ Stage", exact: true })).toBeVisible();
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
      await expect(card).toBeVisible();
    }
    await createDeal("Alpha");
    await createDeal("Beta");

    const alphaCard = lead.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" });
    await alphaCard.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");

    const status = await page.getByRole("status").last().textContent();
    const inLead = await lead.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
    const inQualified = await qualified.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
    const inWon = await won.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" }).count();
    console.log(`FRESH attempt ${attempt}: status="${status}" inLead=${inLead} inQualified=${inQualified} inWon=${inWon}`);
  });
}
