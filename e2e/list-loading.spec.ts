import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { delayFirst, type Hold } from "./helpers.js";

/**
 * WHAT FIVE LISTS SAY BEFORE THEIR ROWS HAVE ARRIVED.
 *
 * "No notes yet" on a record that has plenty is a claim about the RECORD, and
 * it is wrong for as long as the fetch takes -- the rows then appear underneath
 * the sentence that denied them. Each of the five surfaces below destructured
 * `const { data: rows = [] } = use...()` and rendered its empty label on
 * `rows.length === 0` with no loading branch, so an unanswered list and an
 * empty one were spelled the same way.
 *
 * v1.2.1's sweep found them BY READING, and this file is what makes them
 * behavioural: it is the only thing in the suite that can tell the two states
 * apart, because no unit test in this repo renders a component (there is no
 * testing-library here -- see components/rail/mail-lib.ts's header for why the
 * pure parts are extracted instead, and note that a JSX condition has no pure
 * part to extract).
 *
 * BOTH DIRECTIONS IN EVERY JOURNEY, and that is the point rather than
 * thoroughness for its own sake. A list that never says "empty" would pass the
 * first half of each test below and be a worse app than the one that lies:
 * "there is nothing here" is the right answer once the answer is known. So each
 * journey holds one record's list open and reads it, then walks to a second
 * record that really is empty and waits for the label to arrive.
 *
 * THE READ DURING THE HOLD IS ONE SHOT, and it has to be. Every `expect` here
 * auto-retries for five seconds (playwright.config.ts declares no `expect`
 * block, so the default stands), and a NEGATED auto-retrying matcher is
 * satisfied the moment the thing it denies goes away -- which for a lying label
 * is the moment the list answers. `textContent()` is a single query with no
 * retry, taken while the response is parked, and `hold.holding()` is asserted
 * AFTER it so a window that had already closed cannot be mistaken for a passing
 * assertion. Six of v1.2.1's seven vacuous assertions were this exact shape,
 * from the other side.
 *
 * NO MAIL SERVER AND NO MAIL ACCOUNT, so this file runs in the local hybrid
 * loop. Every test seeds its own fixture on its own page: the config is
 * `fullyParallel`, and every claim here has to be shown failing on its own --
 * once against the unfixed app, and once per mutation -- which a serial group
 * that skips after its first failure cannot do.
 */

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
}

/** A tag no other test in this run shares, so a stale row cannot satisfy an assertion. */
function runTag(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** How long a held list is held. Long enough that a render cannot beat it. */
const HELD_MS = 1_500;

/**
 * THE LIST GET, NOT THE SINGLE-RECORD ONE. `GET /api/pipelines/:id` is the
 * board's own query and carries no query string, so requiring the `?` here
 * keeps a pattern that is about a list from parking a record fetch. Playwright
 * escapes `?` in a glob rather than treating it as a wildcard (measured against
 * the installed playwright-core's globToRegexPattern), so this is the literal
 * character. The same shape is why the two rail patterns below carry one too.
 */
const PIPELINES_LIST = "**/api/pipelines?*";

/**
 * The one-shot read, with the window asserted after it.
 *
 * The order is deliberate: reading first and checking the hold second means a
 * true `holding()` proves the hold was ALSO open at the earlier moment the text
 * was taken. Checking first and reading second would prove nothing about the
 * read.
 */
async function readWhileHeld(list: Locator, hold: Hold): Promise<string> {
  const during = (await list.textContent()) ?? "";
  expect(
    hold.holding(),
    "the list had already answered when it was read: this journey raced nothing",
  ).toBe(true);
  return during;
}

/**
 * The pair of claims every one of these lists has to satisfy while its rows are
 * on the wire: it must not deny them, and it must say that it is fetching.
 *
 * The second half is not decoration. Without it the whole file passes against a
 * "fix" that deletes the empty label outright, which would be a regression
 * dressed as a repair -- and it is what pins that these five now do it the way
 * their siblings already did (rail/timeline.tsx, rail/meetings.tsx,
 * mail/thread-list.tsx, deal-detail.tsx, pipelines.tsx, settings-mail.tsx)
 * rather than some sixth way.
 */
function expectFetchingNotEmpty(during: string, emptyLabel: string): void {
  expect(
    during,
    `the list said "${emptyLabel}" while its rows were still on the wire`,
  ).not.toContain(emptyLabel);
  expect(during, "nothing said the list was still fetching").toContain("Loading...");
}

test.describe("A record's Pipelines section", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("does not deny a company's pipelines while it is still fetching them", async ({ page }) => {
    const tag = runTag("cp");
    const company = await create(page, "/api/companies", { name: `Listco ${tag}` });
    const empty = await create(page, "/api/companies", { name: `Listco empty ${tag}` });
    const pipelineName = `Listco pipeline ${tag}`;
    await create(page, "/api/pipelines", { name: pipelineName, scope: "company", companyId: company.id });

    const hold = await delayFirst(page, PIPELINES_LIST, HELD_MS);
    try {
      await page.goto(`/companies/${company.id}`);
      const list = page.getByTestId("company-pipelines");
      await expect(list).toBeVisible();
      expectFetchingNotEmpty(await readWhileHeld(list, hold), "No pipelines");

      // The release, and the row the label was denying.
      await expect(list).toContainText(pipelineName);
      await expect(list).not.toContainText("Loading...");

      // ...and the label is still the right answer for a company that has none.
      await page.goto(`/companies/${empty.id}`);
      await expect(page.getByTestId("company-pipelines")).toContainText("No pipelines");
    } finally {
      await hold.unroute();
    }
  });

  test("does not deny a project's pipelines while it is still fetching them", async ({ page }) => {
    const tag = runTag("pp");
    const project = await create(page, "/api/projects", { name: `Listproj ${tag}` });
    const empty = await create(page, "/api/projects", { name: `Listproj empty ${tag}` });
    const pipelineName = `Listproj pipeline ${tag}`;
    await create(page, "/api/pipelines", { name: pipelineName, scope: "project", projectId: project.id });

    const hold = await delayFirst(page, PIPELINES_LIST, HELD_MS);
    try {
      await page.goto(`/projects/${project.id}`);
      const list = page.getByTestId("project-pipelines");
      await expect(list).toBeVisible();
      expectFetchingNotEmpty(await readWhileHeld(list, hold), "No pipelines");

      await expect(list).toContainText(pipelineName);
      await expect(list).not.toContainText("Loading...");

      await page.goto(`/projects/${empty.id}`);
      await expect(page.getByTestId("project-pipelines")).toContainText("No pipelines");
    } finally {
      await hold.unroute();
    }
  });
});

/**
 * The rail's own two, whose tabs mount their content only when selected
 * (ui/tabs.tsx wraps Radix Tabs and passes no forceMount), so the fetch these
 * hold open starts at the CLICK rather than at the navigation.
 */
test.describe("The record rail", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("does not deny a record's notes while it is still fetching them", async ({ page }) => {
    const tag = runTag("nt");
    const company = await create(page, "/api/companies", { name: `Noteco ${tag}` });
    const empty = await create(page, "/api/companies", { name: `Noteco empty ${tag}` });
    const body = `Rail note ${tag}`;
    await create(page, "/api/notes", { body, companyId: company.id });

    const hold = await delayFirst(page, "**/api/notes?*", HELD_MS);
    try {
      await page.goto(`/companies/${company.id}`);
      await page.getByRole("tab", { name: "Notes" }).click();
      const notes = page.getByTestId("notes");
      await expect(notes).toBeVisible();
      expectFetchingNotEmpty(await readWhileHeld(notes, hold), "No notes yet");

      await expect(notes).toContainText(body);
      await expect(notes).not.toContainText("Loading...");

      await page.goto(`/companies/${empty.id}`);
      await page.getByRole("tab", { name: "Notes" }).click();
      await expect(page.getByTestId("notes")).toContainText("No notes yet");
    } finally {
      await hold.unroute();
    }
  });

  test("does not deny a record's files while it is still fetching them", async ({ page }) => {
    const tag = runTag("fl");
    const company = await create(page, "/api/companies", { name: `Fileco ${tag}` });
    const empty = await create(page, "/api/companies", { name: `Fileco empty ${tag}` });
    const fileName = `rail-${tag}.txt`;
    // The id field must precede the file part: the route streams the body and
    // only sees fields that arrive ahead of it (packages/api/src/routes/files.ts).
    const uploaded = await page.request.post("/api/files", {
      multipart: {
        companyId: company.id,
        file: { name: fileName, mimeType: "text/plain", buffer: Buffer.from(`held ${tag}`) },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);

    const hold = await delayFirst(page, "**/api/files?*", HELD_MS);
    try {
      await page.goto(`/companies/${company.id}`);
      await page.getByRole("tab", { name: "Files" }).click();
      const files = page.getByTestId("files");
      await expect(files).toBeVisible();
      expectFetchingNotEmpty(await readWhileHeld(files, hold), "No files yet");

      await expect(files).toContainText(fileName);
      await expect(files).not.toContainText("Loading...");

      await page.goto(`/companies/${empty.id}`);
      await page.getByRole("tab", { name: "Files" }).click();
      await expect(page.getByTestId("files")).toContainText("No files yet");
    } finally {
      await hold.unroute();
    }
  });
});

/**
 * The task drawer's Dependencies section, reached by the `?task=<id>` deep link
 * the board, My Tasks and both Gantts all use.
 *
 * Its fetch starts LATE by construction: task-drawer.tsx returns a loading
 * branch of its own until `useTask` answers, so DependenciesSection -- and the
 * query held open here -- does not mount until the task is on screen. The
 * filing said this file "does not destructure `isLoading` at all", which is
 * false: it always did, from `useTask`, and branched on it. What was missing
 * was at the CALL SITE below it.
 */
test.describe("The task drawer's Dependencies section", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("does not deny a task's dependencies while it is still fetching them", async ({ page }) => {
    const tag = runTag("dp");
    const project = await create(page, "/api/projects", { name: `Depproj ${tag}` });
    const predecessorTitle = `Dep first ${tag}`;
    const predecessor = await create(page, "/api/tasks", { title: predecessorTitle, projectId: project.id });
    const successor = await create(page, "/api/tasks", { title: `Dep second ${tag}`, projectId: project.id });
    await create(page, `/api/tasks/${successor.id}/dependencies`, { predecessorId: predecessor.id });

    const hold = await delayFirst(page, "**/api/tasks/*/dependencies", HELD_MS);
    try {
      await page.goto(`/projects/${project.id}/board?task=${successor.id}`);
      const list = page.getByTestId("dependency-list");
      await expect(list).toBeVisible();
      expectFetchingNotEmpty(await readWhileHeld(list, hold), "No dependencies");

      await expect(list).toContainText(predecessorTitle);
      await expect(list).not.toContainText("Loading...");

      // The predecessor is the record with none of its own, so the second half
      // needs no third task.
      await page.goto(`/projects/${project.id}/board?task=${predecessor.id}`);
      await expect(page.getByTestId("dependency-list")).toContainText("No dependencies");
    } finally {
      await hold.unroute();
    }
  });
});
