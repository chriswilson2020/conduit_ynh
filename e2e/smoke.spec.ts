import { test, expect } from "@playwright/test";

test("renders the authenticated user and app version", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("greeting")).toContainText("e2euser");
  await expect(page.getByTestId("version")).toHaveText("0.1.0-e2e");
  await expect(page.getByTestId("database")).toHaveText("connected");
  await expect(page.getByTestId("base-path")).toHaveText("/");
});

test("serves the SPA for a deep link rather than a 404", async ({ page }) => {
  const response = await page.goto("/deals/some-id");

  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("greeting")).toBeVisible();
});
