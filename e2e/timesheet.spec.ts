import { test, expect, devices } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";

/**
 * **PHASE 10 TASK 4: WHERE DID THE WEEK GO.**
 *
 * The journey the phase's definition of done names -- "a timesheet that answers
 * where did the week go, on a phone" -- driven at a PHONE VIEWPORT throughout,
 * because that is where Chris is and because every decision on this page was made
 * for that width.
 *
 * **WHAT THIS FILE IS FOR, IN THE ORDER THE TASK STATES IT:**
 *
 *   1. An hour can be logged by hand and lands in the week. Task 1 shipped the
 *      service and the routes and NOTHING IN THE PRODUCT COULD CALL THEM; this is
 *      the first journey that does.
 *   2. **THE UNCOUNTED MEETINGS REACH THE SCREEN.** Task 2 put them in the same
 *      string as the figure so a page could not drop them, and left a bullet
 *      saying "nothing tests a page that does not exist yet". This is the test
 *      that bullet was standing in for: a meeting with no recorded length and one
 *      that has not happened are both seeded, and both the SENTENCE and the ROW
 *      that says why are asserted.
 *   3. The list adds up to the headline -- the rows are what the figure is made
 *      of, so the operator can check it rather than take it on trust.
 *   4. It is reachable on a phone, through the More sheet, and every control on it
 *      can be operated there.
 *
 * **EVERY FIGURE HERE IS READ THROUGH THE PAGE'S OWN RECORD FILTER, AND THAT IS A
 * FIX RATHER THAN A CONVENIENCE.** The first version asserted the week's absolute
 * total, and CI failed it three times with 2h, then 3h 30m, then 5h: this suite
 * shares one database, `e2e/tasks.spec.ts` books an hour of its own, and a serial
 * describe RE-RUNS FROM THE TOP on retry, so each attempt added its own entry to
 * the figure the next attempt asserted. An absolute total over a database other
 * journeys write to is a measurement of the whole suite. Narrowing to this
 * journey's own project makes every number here about this journey's own rows --
 * and exercises the filter at the same time.
 *
 * **THE CLOCK IS THE ORGANISATION'S AND THE FIXTURES MOVE WITH IT.** The report's
 * days are `org_profile.time_zone`'s, and "has this meeting happened yet" is
 * relative to the SERVER's now -- which the route deliberately offers no way to
 * override, because a report that could be told what time it is from a
 * querystring is a report that can be asked the wrong question. So every date here
 * is computed from the run's own clock: a hard-coded one would sit in the future
 * today and in the past next week, and this journey would silently change what it
 * proves. `routes.test.ts` records being caught by exactly that.
 */

const IPHONE_13 = devices["iPhone 13"];

/** The organisation's zone is the install default, UTC, and this suite never
 * changes it -- so the week is UTC's, computed the way `isoWeekRange` computes it
 * rather than imported from it, so a broken helper cannot make its own journey
 * agree with it. */
function mondayOf(now: Date): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const back = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - back * 86_400_000);
}

const iso = (at: Date): string => at.toISOString().slice(0, 10);

test.describe.serial("Timesheet, on a phone", () => {
  const runId = Date.now().toString(36);
  let attemptId = "";
  let projectName = "";
  let otherProjectName = "";
  let entryText = "";
  let adminText = "";
  let elsewhereText = "";
  let untimedMeeting = "";
  let futureMeeting = "";
  let countedMeeting = "";
  let elsewhereMeeting = "";

  let context: BrowserContext;
  let page: Page;
  let projectId = "";
  let otherProjectId = "";

  // The week under test is the one containing NOW; both instants below are inside
  // it. One minute after the week begins is in the past and one minute before it
  // ends is in the future, for every instant of the week except its own first and
  // last minute -- about two minutes in ten thousand, which CI's two retries would
  // have to lose three times running.
  const NOW = new Date();
  const MONDAY = mondayOf(NOW);
  const SUNDAY = new Date(MONDAY.getTime() + 6 * 86_400_000);
  const STARTED = new Date(MONDAY.getTime() + 60_000).toISOString();
  const ARRANGED = new Date(SUNDAY.getTime() + 86_340_000).toISOString();

  test.beforeAll(async ({ browser }, testInfo) => {
    // **UTC, TO MATCH THE ORGANISATION'S OWN CLOCK.** `org_profile.time_zone`
    // defaults to UTC and this suite never changes it, so pinning the browser
    // there makes "this meeting is in the past" a statement about the fixture
    // rather than about where the runner happens to be. The divergence that
    // matters -- a browser in another zone asking for a different week from the
    // organisation's -- is a DECISION rather than a rendering, and it is pinned
    // where the decision lives (web: pages/timesheet-lib.test.ts's weekAt cases,
    // which run Amsterdam against UTC across a midnight).
    context = await browser.newContext({ ...IPHONE_13, timezoneId: "UTC" });
    page = await context.newPage();
    attemptId = `${runId}x${testInfo.retry}`;
    projectName = `Timesheet ${attemptId}`;
    otherProjectName = `Elsewhere ${attemptId}`;
    entryText = `Wrote the report ${attemptId}`;
    adminText = `Admin ${attemptId}`;
    elsewhereText = `Someone else's hour ${attemptId}`;
    untimedMeeting = `Corridor ${attemptId}`;
    futureMeeting = `Arranged ${attemptId}`;
    countedMeeting = `Kickoff ${attemptId}`;
    elsewhereMeeting = `Elsewhere standup ${attemptId}`;
  });

  test.afterAll(async () => {
    await context.close();
  });

  function row(text: string): Locator {
    return page.locator('[data-testid^="timesheet-row-"]').filter({ hasText: text });
  }

  /** POST as the dev user, failing with the server's own words rather than a bare
   * status -- list-loading.spec.ts's helper, and its reason. */
  async function create(path: string, data: unknown): Promise<{ id: string }> {
    const response = await page.request.post(path, { data });
    const body = await response.text();
    expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`)
      .toBe(201);
    return JSON.parse(body) as { id: string };
  }

  /** Narrow the page to this journey's own project. Re-applied after any full
   * load, because the filter is view state rather than a URL (router.tsx argues
   * why) -- and every figure asserted below is read through it. */
  async function filterToProject(): Promise<void> {
    await page.getByTestId("filter-project").click();
    await page.getByTestId("link-search-project").fill(projectName);
    await page.getByTestId(`link-option-${projectId}`).click();
    await expect(page.getByTestId("timesheet-filter")).toContainText(projectName);
  }

  /** Log an hour through the form the page offers. */
  async function logTime(
    day: string, minutes: string, description: string, billable: "yes" | "no", project: string,
    projectOptionId: string,
  ): Promise<void> {
    await page.getByTestId("log-time").click();
    await expect(page.getByTestId("time-entry-dialog")).toBeVisible();
    await page.getByTestId("entry-date").fill(day);
    await page.getByTestId("entry-minutes").fill(minutes);
    await page.getByTestId("entry-description").fill(description);
    await page.getByTestId(`entry-billable-${billable}`).click();
    await page.getByTestId("entry-link-project").click();
    await page.getByTestId("link-search-project").fill(project);
    await page.getByTestId(`link-option-${projectOptionId}`).click();
    await page.getByTestId("entry-save").click();
    await expect(page.getByTestId("time-entry-dialog")).toHaveCount(0);
  }

  test("creates the two projects this journey runs on", async () => {
    // Posted rather than typed: creating a project is e2e/tasks.spec.ts's journey,
    // and here it is the fixture rather than the subject.
    await page.goto("/");
    projectId = (await create("/api/projects", { name: projectName })).id;
    otherProjectId = (await create("/api/projects", { name: otherProjectName })).id;
  });

  /**
   * **THE PAGE IS REACHED THE WAY A PHONE REACHES IT**, through the More sheet --
   * the timesheet is the ninth nav destination and the bar holds four plus More
   * (components/nav-lib.ts). Radix does not forceMount, so the row does not exist
   * until the sheet is open, and the row has to close the sheet behind it or the
   * page loads underneath a surface still covering the screen.
   */
  test("reaches the timesheet from the More sheet, which closes behind it", async () => {
    await page.goto("/");
    await expect(page.getByTestId("nav-timesheet")).toHaveCount(0);
    await page.getByTestId("bottom-nav-more").click();
    await expect(page.getByTestId("more-sheet")).toBeVisible();
    await page.getByTestId("nav-timesheet").click();
    await expect(page).toHaveURL("/timesheet");
    await expect(page.getByTestId("more-sheet")).toHaveCount(0);
    await expect(page.getByTestId("bottom-nav-more")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("timesheet")).toBeVisible();
    // Seven day sections, every one of them, including the days nothing happened
    // on: a week that skipped its quiet days would read as a week those days were
    // not in.
    await expect(page.locator('[data-testid^="timesheet-day-"]')).toHaveCount(7);
  });

  test("narrows to this journey's project, which has nothing in it yet", async () => {
    await filterToProject();
    await expect(page.getByTestId("counted-summary")).toContainText("0m counted");
    await expect(page.getByTestId("billable-summary"))
      .toHaveText("Nothing was logged by hand, so there is no billable split.");
    // An empty week is still seven days, and every one of them says so.
    await expect(page.locator('[data-testid^="timesheet-day-"]')).toHaveCount(7);
  });

  /**
   * **HAND ENTRY, WHICH IS WHAT TASK 1 BUILT AND NOTHING COULD REACH.**
   *
   * The billable answer is the interesting half: `time_entries.billable` has no
   * DEFAULT and the wire schema requires it, so nothing in this system decides an
   * hour's billability on the operator's behalf. The form asks, and this asserts
   * the refusal that makes that real -- a Save with the question unanswered says
   * so rather than guessing.
   */
  test("refuses to log an hour until it has been told whether it is billable", async () => {
    await page.getByTestId("log-time").click();
    await expect(page.getByTestId("time-entry-dialog")).toBeVisible();
    await page.getByTestId("entry-date").fill(iso(MONDAY));
    await page.getByTestId("entry-minutes").fill("90");
    await page.getByTestId("entry-description").fill(entryText);
    await page.getByTestId("entry-link-project").click();
    await page.getByTestId("link-search-project").fill(projectName);
    await page.getByTestId(`link-option-${projectId}`).click();
    await expect(page.getByTestId("entry-link-chip")).toContainText(projectName);

    await page.getByTestId("entry-save").click();
    await expect(page.getByTestId("entry-error")).toContainText(/billable/i);
    // Still open, and nothing was written.
    await expect(page.getByTestId("time-entry-dialog")).toBeVisible();
    await expect(page.getByTestId("counted-summary")).toContainText("0m counted");
  });

  test("logs the hour, and it lands on its own day", async () => {
    await page.getByTestId("entry-billable-yes").click();
    await page.getByTestId("entry-save").click();
    await expect(page.getByTestId("time-entry-dialog")).toHaveCount(0);

    const monday = page.getByTestId(`timesheet-day-${iso(MONDAY)}`);
    await expect(monday.getByText(entryText)).toBeVisible();
    await expect(monday.getByTestId("day-total")).toHaveText("1h 30m");
    await expect(row(entryText).getByTestId("row-billable")).toBeVisible();
    // The headline is the derived sentence and it moved with the entry.
    await expect(page.getByTestId("counted-summary")).toContainText("1h 30m counted");
    await expect(page.getByTestId("counted-summary")).toContainText("across 1 entry");
    await expect(page.getByTestId("billable-summary"))
      .toHaveText("1h 30m of the 1h 30m logged by hand is billable, across 1 entry.");
  });

  /**
   * **A SECOND ENTRY, NOT BILLABLE**, so the split is a split rather than a
   * restatement of the total. A page that printed the billable figure and called
   * it the week would pass every assertion above.
   */
  test("splits billable from the rest", async () => {
    await logTime(iso(MONDAY), "30", adminText, "no", projectName, projectId);
    await expect(page.getByTestId("counted-summary")).toContainText("2h counted");
    await expect(page.getByTestId("billable-summary"))
      .toHaveText("1h 30m of the 2h logged by hand is billable, across 1 entry.");
    await expect(page.getByTestId(`timesheet-day-${iso(MONDAY)}`).getByTestId("day-total"))
      .toHaveText("2h");
  });

  /**
   * **THE MEETINGS THE REPORT CANNOT COUNT -- THE ASSERTION THIS WHOLE FILE EXISTS
   * FOR.**
   *
   * Task 2 built three buckets and put the two uncounted ones into the same string
   * as the figure, on the reasoning that a page cannot drop a clause it never had
   * -- and said in as many words that nothing could test it until a page existed.
   * Here are all three: a meeting with a duration in the past (it counts), one with
   * no duration at all (it does not, and the sentence says so), and one arranged
   * for the end of the week (it does not, for a different reason).
   *
   * Both the SENTENCE and the ROWS are asserted. A page could render the sentence
   * and show no rows, or show the rows and print `countedMinutes` alone; neither is
   * enough on its own.
   *
   * The meetings are POSTED, not typed: logging one through the rail is Phase 5's
   * journey and is driven there, and typing one here would add that form's own
   * `datetime-local` conversion to a test about somebody else's arithmetic.
   */
  test("counts a meeting, and says out loud which meetings it could not count", async () => {
    for (const [title, durationMinutes, occurredAt] of [
      [countedMeeting, 45, STARTED],
      [untimedMeeting, null, STARTED],
      [futureMeeting, 60, ARRANGED],
    ] as const) {
      await create("/api/meetings", { title, occurredAt, durationMinutes, projectId });
    }

    await page.goto("/timesheet");
    await filterToProject();

    const summary = page.getByTestId("counted-summary");
    // 2h of entries plus the one counted meeting.
    await expect(summary).toContainText("2h 45m counted");
    await expect(summary).toContainText("45m across 1 meeting");
    // THE CLAUSE. Both halves, in the sentence the operator reads.
    await expect(summary).toContainText("Not counted:");
    await expect(summary).toContainText("1 meeting with no recorded length");
    await expect(summary).toContainText("1 meeting that has not happened yet");
    // Meetings are in neither half of the billable split, and it says so.
    await expect(page.getByTestId("billable-summary")).toHaveText(
      "1h 30m of the 2h logged by hand is billable, across 1 entry. Meetings carry no "
      + "billable flag, so the 45m from meetings is in neither figure.",
    );

    // AND THE ROWS, so "1 meeting with no recorded length" is something the
    // operator can look at rather than a number to take on trust.
    await expect(row(untimedMeeting).getByTestId("row-uncounted")).toHaveText("no recorded length");
    await expect(row(untimedMeeting).getByTestId("row-minutes")).toHaveText("—");
    await expect(row(futureMeeting).getByTestId("row-uncounted")).toHaveText("has not happened yet");
    await expect(row(countedMeeting).getByTestId("row-minutes")).toHaveText("45m");
    await expect(row(countedMeeting).getByTestId("row-uncounted")).toHaveCount(0);
  });

  /**
   * **THE LIST ADDS UP TO THE HEADLINE.** Read off the screen rather than computed
   * from the fixtures: every day's own figure, summed, must be the number in the
   * sentence. A list that showed a subset -- the shape a paged or entries-only list
   * would have -- fails here.
   */
  test("the day figures add up to the week's, on the screen", async () => {
    const totals = await page.getByTestId("day-total").allTextContents();
    const minutes = totals.reduce((sum, text) => {
      if (text === "—") return sum;
      const hours = /(\d+)h/.exec(text);
      const rest = /(\d+)m/.exec(text);
      return sum + Number(hours?.[1] ?? 0) * 60 + Number(rest?.[1] ?? 0);
    }, 0);
    expect(minutes).toBe(165);
    await expect(page.getByTestId("counted-summary")).toContainText("2h 45m counted");
  });

  /**
   * **A MEETING IS NOT EDITABLE FROM HERE AND AN ENTRY IS.** The week's figure has
   * one front door per kind of row: an entry's is this form, a meeting's is the
   * record's Meetings tab. Two editors for `duration_minutes` would give the
   * correction path -- archive the meeting, log the hour by hand -- two front doors
   * as well.
   */
  test("opens an entry for correction and leaves the meetings alone", async () => {
    await expect(row(untimedMeeting).getByTestId("edit-entry")).toHaveCount(0);
    await row(entryText).getByTestId("edit-entry").click();
    await expect(page.getByTestId("time-entry-dialog")).toBeVisible();
    // The form opens on what is stored -- including the record it is booked to,
    // which the row already carried, so no second request was needed.
    await expect(page.getByTestId("entry-minutes")).toHaveValue("90");
    await expect(page.getByTestId("entry-link-chip")).toContainText(projectName);
    await page.getByTestId("entry-minutes").fill("120");
    await page.getByTestId("entry-save").click();
    await expect(page.getByTestId("time-entry-dialog")).toHaveCount(0);
    await expect(page.getByTestId("counted-summary")).toContainText("3h 15m counted");
  });

  /**
   * **ARCHIVING IS THE ONLY WAY AN HOUR LEAVES A TOTAL**, and it is the fix for the
   * duplicated afternoon the two capture paths make easy. There is no delete
   * anywhere in this API to test instead.
   */
  test("archives an entry, and the week's figure loses it", async () => {
    await row(entryText).getByTestId("edit-entry").click();
    await page.getByTestId("archive-entry").click();
    await expect(page.getByTestId("time-entry-dialog")).toHaveCount(0);
    await expect(row(entryText)).toHaveCount(0);
    await expect(page.getByTestId("counted-summary")).toContainText("1h 15m counted");
  });

  /** Previous and Next move a whole week; This week comes back. The arrows are
   * 44px boxes because the glyph inside them is a few pixels wide. */
  test("steps to another week and back", async () => {
    const range = page.getByTestId("week-range");
    const thisWeek = await range.textContent();
    await expect(page.getByTestId("week-today")).toHaveCount(0);

    await page.getByTestId("week-previous").click();
    await expect(range).not.toHaveText(thisWeek ?? "");
    await expect(page.getByTestId("counted-summary")).toContainText("0m counted");
    await expect(page.locator('[data-testid^="timesheet-day-"]')).toHaveCount(7);

    for (const testId of ["week-previous", "week-next", "week-today"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box?.height, testId).toBeGreaterThanOrEqual(44);
    }

    await page.getByTestId("week-today").click();
    await expect(range).toHaveText(thisWeek ?? "");
    await expect(page.getByTestId("week-today")).toHaveCount(0);
    await expect(page.getByTestId("counted-summary")).toContainText("1h 15m counted");
  });

  /**
   * **THE FILTER NARROWS BOTH HALVES.** A filter that reached the entries and left
   * the meetings whole would answer "this project's week" with everybody's meetings
   * added in. The contrast is a SECOND project with an hour and a meeting of its
   * own: neither may appear while the filter is on, and both must appear when it is
   * cleared -- asserted by row rather than by a total, so nothing else in the
   * database can decide the answer.
   */
  test("narrows the week to one record, entries and meetings together", async () => {
    await create("/api/meetings", {
      title: elsewhereMeeting, occurredAt: STARTED, durationMinutes: 90, projectId: otherProjectId,
    });
    await page.goto("/timesheet");
    await logTime(iso(MONDAY), "20", elsewhereText, "yes", otherProjectName, otherProjectId);

    // Unfiltered: both projects' rows are on the page.
    await expect(row(elsewhereText)).toBeVisible();
    await expect(row(elsewhereMeeting)).toBeVisible();
    await expect(row(adminText)).toBeVisible();

    await filterToProject();
    await expect(row(adminText)).toBeVisible();
    await expect(row(countedMeeting)).toBeVisible();
    await expect(row(elsewhereText)).toHaveCount(0);
    await expect(row(elsewhereMeeting)).toHaveCount(0);
    await expect(page.getByTestId("counted-summary")).toContainText("1h 15m counted");

    await page.getByTestId("clear-filter").click();
    await expect(page.getByTestId("timesheet-filter")).toHaveCount(0);
    await expect(row(elsewhereText)).toBeVisible();
  });

  /** THE PAGE MUST NOT SCROLL SIDEWAYS. It is the one thing a list is supposed to
   * buy over a grid, and the reason the grid was refused. */
  test("does not scroll sideways at a phone width", async () => {
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
