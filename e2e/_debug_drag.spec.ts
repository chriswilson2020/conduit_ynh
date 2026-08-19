import { test } from "@playwright/test";

test("debug keyboard drag - repeated ArrowRight and ArrowDown", async ({ page }) => {
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

  const alphaCard = lead.locator('[data-testid^="card-"]').filter({ hasText: "Alpha" });
  const alphaTestId = (await alphaCard.getAttribute("data-testid")) as string;
  console.log(`ALPHA=${alphaTestId}`);

  await alphaCard.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  console.log("after Space (lift):", await page.getByRole("status").last().textContent());

  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    console.log(`after ArrowRight #${i + 1}:`, await page.getByRole("status").last().textContent());
  }
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    console.log(`after ArrowLeft #${i + 1}:`, await page.getByRole("status").last().textContent());
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  // Now test same-column ArrowDown with 3 cards.
  await createDeal("Gamma");
  await createDeal("Delta");
  const betaCard = lead.locator('[data-testid^="card-"]').filter({ hasText: "Beta" });
  await betaCard.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  console.log("same-col after Space (lift):", await page.getByRole("status").last().textContent());
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    console.log(`same-col after ArrowDown #${i + 1}:`, await page.getByRole("status").last().textContent());
  }
  await page.keyboard.press("Escape");
});
