import { test, expect, devices } from "@playwright/test";
import type { Page, Locator } from "@playwright/test";

/**
 * THE ROW LINK'S HIT AREA, GUARDED WITHOUT DEPENDING ON HOW LONG A NAME IS.
 *
 * v1.2.0 made every list row a link to its record (packages/web/src/components/
 * row-link.ts): the anchor lives in the row's FIRST cell and a pseudo-element
 * stretches it over the whole row, so a click anywhere on the row still opens
 * the record and a Tab still reaches one thing per row.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINE IN crm.spec.ts. The plan said "119
 * e2e tests click these rows". Measured, exactly TWO do -- crm.spec.ts at 1280
 * and mobile.spec.ts at 390, both on companies. Nothing clicked a projects,
 * pipelines or task row at all. And Playwright clicks an element's CENTRE, so
 * those two probe one point in the middle of the row and nothing else.
 *
 * THAT MAKES THEM FIXTURE-DEPENDENT IN A WAY THAT IS EASY TO MISS, and the
 * numbers are worth writing down because two earlier attempts at them were
 * wrong. Shrink the overlay to the first cell -- one stray `relative` on a
 * `<td>` does it -- and whether crm.spec.ts notices depends entirely on how
 * long its company name is. Measured at 1280 with ONE row rendered, which is
 * the geometry crm.spec.ts:49-55 actually produces:
 *
 *   name                       first cell ends   row centre   centre lands on
 *   `Acme <runid>` (13 ch)     428               503          the CELL
 *   25 characters              534               503          the ANCHOR
 *   this file's fixture (56)   715               503          the ANCHOR
 *
 * (Row-relative; add the 249px sidebar for viewport x. The centre is 752 in
 * viewport terms, which is the number Playwright clicks.)
 *
 * SO crm.spec.ts DOES CATCH IT TODAY, with 75px to spare, and 25 characters
 * is enough to take that away. It is not a guard, it is a coincidence of
 * fixture length -- and the mutation is invisible to the eye as well, since
 * the overlay paints nothing.
 *
 * SO THE FIXTURE HERE IS THE WIDE CASE ON PURPOSE, and the test asserts that
 * it is -- the first cell is checked to extend PAST the row's centre before
 * the far edges are probed. Prove the instrument, then trust the reading, the
 * same care e2e/mobile.spec.ts takes with its overflow probe.
 *
 * THE SECOND HALF OF THE PAIR NEEDS ITS OWN PROBE, and did not have one. Drop
 * `ROW_LINK_ROW` from the row and the overlay does not shrink, it ESCAPES: with
 * no positioned ancestor it resolves against the initial containing block and
 * covers the viewport. Every test in this file stayed green against that, since
 * a link that covers too much still covers the row. The last test below is the
 * one that fails -- it asks what owns the page heading, the Filter field and
 * the sidebar, which must be anything except a row.
 */

/** A long first column, so the row's centre lands INSIDE the name cell. */
const WIDE_NAME_PREFIX = "Zonnebloem Handelsmaatschappij Nederland Beheer";

/**
 * Which element the browser would deliver a click to, at `fraction` across the
 * row and half way down it. Read off the DOM rather than inferred from a
 * navigation, so a partly-shrunken overlay is visible as a partial answer
 * instead of a pass.
 */
async function ownerAcross(row: Locator, fractions: number[]): Promise<string[]> {
  return await row.evaluate((el, points: number[]) => {
    const r = el.getBoundingClientRect();
    return points.map((f) => {
      const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
      return hit === null ? "none" : hit.tagName;
    });
  }, fractions);
}

/** Nine points across the row, plus both extreme edges, inset by a pixel. */
const ACROSS = [0.002, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.998];

test.describe.serial("Row links cover the whole row", () => {
  const runId = Date.now().toString(36);
  const companyName = `${WIDE_NAME_PREFIX} ${runId}`;

  let page: Page;
  let companyId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const created = await page.request.post("/api/companies", { data: { name: companyName } });
    expect(created.status()).toBe(201);
    companyId = ((await created.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("the name cell is wide enough that this test means something", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();

    // THE INSTRUMENT, PROVED. If the first cell ever stops reaching past the
    // centre, this fixture has stopped being the case crm.spec.ts cannot see,
    // and the assertions below would be testing nothing new.
    const past = await row.evaluate((el) => {
      const cell = el.querySelector("td");
      if (cell === null) throw new Error("the row has no cell to measure");
      const r = el.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      return { cellRight: Math.round(c.right - r.left), centre: Math.round(r.width / 2) };
    });
    expect(past.cellRight, `name cell ends at ${String(past.cellRight)}px, row centre is ${String(past.centre)}px`)
      .toBeGreaterThan(past.centre);
  });

  test("every point across the row belongs to the row's link, at 1280", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();
    expect(await ownerAcross(row, ACROSS)).toEqual(ACROSS.map(() => "A"));
  });

  /**
   * THE ESCAPE, not the shrink. Every other test in this file passes when the
   * overlay covers TOO MUCH, so this is the only one that notices
   * `ROW_LINK_ROW` going missing -- against that mutation the heading, the
   * Filter field and the sidebar all report a row's anchor as the element
   * under them, and every control on the page navigates to that record.
   */
  test("nothing outside the row belongs to the row's link", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    await expect(page.getByTestId(`row-${companyId}`)).toBeVisible();

    const owners = await page.evaluate(() => {
      const at = (el: Element | null): string => {
        if (el === null) return "(absent)";
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + r.height / 2);
        if (hit === null) return "none";
        return hit.closest('[data-testid^="row-"]') === null ? "outside a row" : "A ROW";
      };
      return {
        heading: at(document.querySelector("h1")),
        filter: at(document.querySelector('input[aria-label="Filter"]')),
        sidebar: at(document.querySelector("nav a")),
      };
    });
    expect(owners).toEqual({ heading: "outside a row", filter: "outside a row", sidebar: "outside a row" });
  });

  test("a click at the row's far right edge opens the record", async () => {
    await page.goto("/companies");
    await page.getByPlaceholder("Filter...").fill(runId);
    const row = page.getByTestId(`row-${companyId}`);
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    if (box === null) throw new Error("the row has no box to click");
    // The LAST cell, which no amount of first-column growth can reach and
    // which the suite's two existing row clicks never touch.
    await row.click({ position: { x: box.width - 4, y: box.height / 2 } });
    await expect(page).toHaveURL(`/companies/${companyId}`);
  });
});

/**
 * THE SAME ROW, UNDER A THUMB, plus the one list whose tap area had no journey
 * at all. My Tasks was reachable only through its title before this file: the
 * existing phone spec asserts the page renders and reads a group's text, and
 * nothing tapped a task row.
 */
// See mobile.spec.ts: everything the device describes except the browser choice,
// since the job installs chromium and only chromium.
const { defaultBrowserType: _webkitByDefault, ...IPHONE_13 } = devices["iPhone 13"];

test.describe.serial("Row links under a thumb", () => {
  const runId = Date.now().toString(36);
  const projectName = `Zonnestroom ${runId}`;
  const taskTitle = `Bestelling versturen ${runId}`;

  let page: Page;
  let taskId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ ...IPHONE_13 });
    const me = (await (await page.request.get("/api/me")).json()) as { user: { id: string } };
    const project = await page.request.post("/api/projects", { data: { name: projectName } });
    expect(project.status()).toBe(201);
    const projectId = ((await project.json()) as { id: string }).id;
    const task = await page.request.post("/api/tasks", {
      data: { title: taskTitle, projectId, assigneeUserId: me.user.id },
    });
    expect(task.status()).toBe(201);
    taskId = ((await task.json()) as { id: string }).id;
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("tapping a task row away from its title opens the drawer", async () => {
    await page.goto("/my-tasks");
    const row = page.getByTestId(`task-row-${taskId}`);
    await expect(row).toBeVisible();

    const box = await row.boundingBox();
    if (box === null) throw new Error("the task row has no box to tap");
    // The far right of the row, which at this width is the date and the type
    // badge -- outside the anchor's own text and reachable only through the
    // overlay. Tapping the title would prove nothing about the row.
    await row.click({ position: { x: box.width - 6, y: box.height - 6 } });

    await expect(page).toHaveURL(`/my-tasks?task=${taskId}`);
    await expect(page.getByTestId("task-drawer")).toBeVisible();
  });

  test("the done checkbox is still the one thing the overlay does not take", async () => {
    await page.goto("/my-tasks");
    const row = page.getByTestId(`task-row-${taskId}`);
    const box = row.getByRole("checkbox");
    await expect(box).not.toBeChecked();

    const status = page.waitForResponse((r) => /\/api\/tasks\/[0-9a-f-]+\/status$/.test(r.url()));
    await box.click();
    expect((await status).status()).toBe(200);

    // Ticking it must NOT have opened the drawer: the checkbox is lifted above
    // the link, not layered under it.
    await expect(page).toHaveURL("/my-tasks");
    // A done task moves into the collapsed Done group, which is where it went.
    await expect(page.getByTestId("group-done")).toContainText(taskTitle);
  });
});
