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
  // Pre-router, the dashboard rendered on every path, so this asserted
  // `greeting` was visible. Now the router correctly matches "/deals/some-id"
  // to nothing and renders the not-found page instead -- the intent (the
  // server served the SPA shell rather than a 404, and the client actually
  // booted rather than showing a blank page, which is what the Phase 0
  // base-href fix addressed) is preserved by asserting the shell and the
  // not-found view both rendered.
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect(page.getByTestId("not-found")).toBeVisible();
});
