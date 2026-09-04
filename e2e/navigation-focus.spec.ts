import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * WHERE THE CARET IS AFTER A NAVIGATION.
 *
 * The rule is src/use-navigation-focus.ts and its two decisions are unit
 * tested there. What is left is everything that is only true of a browser, and
 * it is most of the release: that TanStack's `onResolved` fires late enough to
 * see the destination, that a detail page's heading arrives after it and the
 * rule waits, that a heading focused programmatically after a MOUSE click
 * paints no ring while the same heading after a KEYBOARD one does.
 *
 * NONE OF THAT IS A SCREENSHOT. Every claim below is read off the DOM or off
 * `getComputedStyle`, because the visual half of this fix is exactly the half
 * that has no other way of being checked -- see the ring tests at the bottom,
 * which are the deliverable rather than the fix.
 */

/** The one heading a route is allowed to have. Strict: two would throw here. */
function heading(page: Page): Locator {
  return page.getByRole("heading", { level: 1 });
}

/**
 * What `document.activeElement` is, in terms a failure message can be read
 * from -- "BODY" rather than a Playwright locator that resolved to nothing.
 */
async function caret(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return "null";
    if (active === document.body) return "BODY";
    const testId = active.getAttribute("data-testid");
    return `${active.tagName}${testId === null ? "" : `[${testId}]`}:${(active.textContent ?? "").trim().slice(0, 30)}`;
  });
}

/**
 * The focus ring on whatever currently holds the caret, read from computed
 * style rather than looked at.
 *
 * `:focus-visible` is reported alongside the outline because they are two
 * different claims: the first is the browser's judgement about how the caret
 * got there, the second is what the user actually sees. A fix that satisfied
 * one and not the other would be a fix in name.
 */
async function ringOnFocused(page: Page): Promise<{
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: string;
  paints: boolean;
}> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active === null) throw new Error("nothing is focused");
    const style = getComputedStyle(active);
    const width = Number.parseFloat(style.outlineWidth);
    return {
      focusVisible: active.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      paints: style.outlineStyle !== "none" && Number.isFinite(width) && width > 0,
    };
  });
}

test.describe.serial("focus after navigation", () => {
  const runId = Date.now().toString(36);
  const companyName = `Focus ${runId}`;
  let page: Page;
  let companyId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("seeds a company to navigate into", async () => {
    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    companyId = page.url().split("/").pop() as string;
  });

  /**
   * A COLD LOAD IS NOT A NAVIGATION, and the router does not distinguish them
   * on its own: measured, a fresh load fires `onResolved` with `pathChanged:
   * true` and the caret already on `<body>`, which is every condition the rule
   * keys on. `fromLocation` is the only thing that separates them.
   *
   * What this protects is the reader who has just arrived: focus belongs at
   * the top of the document, where their next Tab reaches the header and the
   * sidebar. Moving it to the heading would put those BEHIND them.
   */
  test("leaves the caret alone on a cold load, which is not a navigation", async () => {
    await page.goto("/companies");
    await expect(heading(page)).toHaveText("Companies");
    // Give the rule every chance to fire late -- it waits for a heading, and
    // this one is already there.
    await page.waitForTimeout(300);
    expect(await caret(page)).toBe("BODY");
  });

  /**
   * THE DEFECT, AND THE FIX. The row's anchor unmounts with the list, so the
   * browser parks the caret on `<body>` -- measured at exactly that before this
   * release, and the reason the whole rule exists.
   *
   * THE DESTINATION HAS NO HEADING AT THE MOMENT THE ROUTE RESOLVES: every
   * detail page in this app renders "Loading..." inside its frame while the
   * record's query is in flight. Measured 18.5ms and 25.2ms from `onResolved`
   * to the heading appearing, against a database on the same machine. So this
   * test is also the one that proves the rule waits: a version that read the
   * DOM once and gave up would find nothing and leave the caret where it
   * found it.
   */
  test("lands on the destination heading when a row link takes the caret with it", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(`/companies/${companyId}`);
    // Auto-retrying rather than a one-shot read: the move waits for the record.
    await expect(heading(page)).toBeFocused();
    await expect(heading(page)).toHaveText(companyName);
  });

  /**
   * THE RESTRAINT, which is half of the design and the only reason this is not
   * a jump every user meets on every click. The sidebar lives outside the
   * router outlet, so its anchor SURVIVES the route change and never stops
   * holding the caret. Nothing was lost, so nothing moves.
   */
  test("leaves the caret on a sidebar link, whose anchor survives the route change", async () => {
    await page.goto(`/companies/${companyId}`);
    await expect(heading(page)).toHaveText(companyName);

    const link = page.getByRole("link", { name: "Pipelines" }).first();
    await link.click();
    await expect(heading(page)).toHaveText("Pipelines");
    await page.waitForTimeout(300);
    await expect(link).toBeFocused();
  });

  /**
   * THE FIVE CREATE DIALOGS THIS CLOSES WITHOUT TOUCHING THEM, and they are
   * the reason components/ui/dialog-focus.ts left a note rather than a fix.
   *
   * That file measured five `<Dialog>` roots that land on `<body>` on their
   * SUCCESS path -- entity-table's New (shared by companies, contacts and
   * projects), pipelines', both of company-detail's and project-detail's --
   * because each `navigate()`s in `onSuccess` from a trigger inside the router
   * outlet, so the whole page the trigger was on unmounts. It declined to fix
   * them there, in as many words: "fixing the five here would make them the
   * only navigations in the app that land somewhere, which is a worse kind of
   * inconsistent than landing nowhere. It is recorded in the backlog as one
   * item about routing."
   *
   * This release is that item, and the five are covered by the general rule
   * rather than by anything added to those dialogs. Asserted on one of them,
   * because the mechanism is the same for all five and this is the one with a
   * name the test can predict.
   */
  test("lands on the new record's heading when a create dialog navigates to it", async () => {
    const created = `Created ${runId}`;
    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(created);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toBeFocused();
    await expect(heading(page)).toHaveText(created);
  });

  /**
   * THE FOUR SETTINGS PANELS ANNOUNCE THEMSELVES -- v1.5.0, Chris's decision.
   * Before it, all four shared components/settings-layout.tsx's "Settings"
   * heading, so this journey announced the area it was already in four times
   * and the destination never.
   *
   * FOUR, NOT FIVE. The release brief and the spec both name five panels and
   * list `settings-import` among them; there is no such route. Import is a
   * SECTION inside settings-data (pages/settings-import.tsx exports
   * `ImportSection`, rendered by pages/settings-data.tsx), and giving it an
   * `<h1>` of its own would have put two on /settings/data -- the one thing
   * "first visible" cannot survive. The tab row is the list that is right.
   */
  test("announces each settings panel by name, one heading per route", async () => {
    await page.goto("/settings/mail");
    await expect(heading(page)).toHaveText("Mail accounts");

    for (const [tab, title] of [
      ["Templates", "Templates"],
      ["Organisation", "Organisation"],
      ["Export, import, backup and restore", "Export, import, backup and restore"],
      ["Mail accounts", "Mail accounts"],
    ] as const) {
      await page.getByRole("link", { name: tab }).click();
      // Strict mode does the second half of the work here: `heading()` resolves
      // `level: 1` across the whole page, so a route that grew a SECOND visible
      // <h1> would fail this line rather than quietly making "first visible" a
      // coin toss.
      await expect(heading(page)).toHaveText(title);
    }

    // The area name is still on the page, and is deliberately no longer a
    // heading -- see components/settings-layout.tsx. Scoped to <main> because
    // the sidebar's own "Settings" link is the other thing with that text.
    await expect(page.getByRole("main").getByText("Settings", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
  });

  /**
   * A TAB IS A ROUTER LINK INSIDE THE OUTLET, so it unmounts with the panel it
   * switched away from and the caret goes with it. That makes the settings
   * tabs the one place in the app where the defect and the fix are both
   * visible in a single click.
   */
  test("moves the caret to the panel a settings tab switched to", async () => {
    await page.goto("/settings/mail");
    await expect(heading(page)).toHaveText("Mail accounts");

    await page.getByRole("link", { name: "Organisation" }).click();
    await expect(heading(page)).toBeFocused();
    await expect(heading(page)).toHaveText("Organisation");
  });

  /**
   * ---------------------------------------------------------------------
   * THE RING, WHICH IS THE HALF THAT COULD MAKE THIS A VISIBLE REGRESSION.
   *
   * A mouse user clicking a row also drops focus to `<body>`, so the rule
   * fires for them too and the heading takes the caret. Harmless -- until it
   * paints a box round the next page's title on every row click in the
   * product.
   *
   * BOTH DIRECTIONS ARE ASSERTED, because suppressing the ring outright would
   * pass the first of these and fail the reason the ring exists: a keyboard
   * user has to be able to see where the caret went.
   */
  test("paints no ring on the heading when the navigation came from a mouse", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();

    await row.click();
    await expect(heading(page)).toBeFocused();

    const ring = await ringOnFocused(page);
    expect(ring, `focus-visible=${ring.focusVisible} outline=${ring.outlineStyle} ${ring.outlineWidth}`)
      .toMatchObject({ focusVisible: false, paints: false });
  });

  test("paints a ring on the heading when the navigation came from the keyboard", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();

    const anchor = row.locator("a").first();
    await anchor.focus();
    await page.keyboard.press("Enter");
    await expect(heading(page)).toBeFocused();

    const ring = await ringOnFocused(page);
    expect(ring, `focus-visible=${ring.focusVisible} outline=${ring.outlineStyle} ${ring.outlineWidth}`)
      .toMatchObject({ focusVisible: true, paints: true });
  });
});
