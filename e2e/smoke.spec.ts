import { test, expect } from "@playwright/test";

test("renders the authenticated user and app version", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("greeting")).toContainText("e2euser");
  await expect(page.getByTestId("version")).toHaveText("0.1.0-e2e");
  await expect(page.getByTestId("database")).toHaveText("connected");
  await expect(page.getByTestId("base-path")).toHaveText("/");
});

test("serves the SPA for a deep link rather than a 404", async ({ page }) => {
  // Deliberately two segments under a prefix ("reports") that matches none of
  // the router's own routes (companies/contacts/pipelines/deals), so this
  // stays a true "matches nothing" deep link even as later phases add more
  // dynamic routes -- Phase 2 added "/deals/$dealId", which is why this used
  // to read "/deals/some-id" and no longer can.
  const response = await page.goto("/reports/q1");

  expect(response?.status()).toBe(200);
  // Pre-router, the dashboard rendered on every path, so this asserted
  // `greeting` was visible. Now the router correctly matches "/reports/q1"
  // to nothing and renders the not-found page instead -- the intent (the
  // server served the SPA shell rather than a 404, and the client actually
  // booted rather than showing a blank page, which is what the Phase 0
  // base-href fix addressed) is preserved by asserting the shell and the
  // not-found view both rendered.
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect(page.getByTestId("not-found")).toBeVisible();
});
