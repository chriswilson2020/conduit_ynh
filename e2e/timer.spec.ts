import { test, expect, devices } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * **PHASE 10 TASK 5: THE TIMER, AND THE THINGS THAT ARE ONLY TRUE IN A BROWSER.**
 *
 * Driven at a PHONE VIEWPORT throughout, for `timesheet.spec.ts`'s reason: that
 * is where Chris is, and the strip's placement was decided for that width.
 *
 * **WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT.** The service tests
 * hold the transaction, the constraints and the recovery rules; the unit tests
 * hold every branch of the sentence and of the proposal. What only a browser can
 * answer is whether the running state really survives the three things the spec
 * names -- and two of them are not testable anywhere else:
 *
 *   1. **IT SURVIVES A NAVIGATION**, because the strip is in the shell rather
 *      than on /timesheet. A timer visible only on the page an operator opens
 *      once a week is a timer that is always left running, which is the spec's
 *      second risk in one sentence.
 *   2. **IT SURVIVES A RELOAD** -- the closed tab, as far as a browser is
 *      concerned. Nothing about a running timer is held in a process, so this is
 *      the property stated as a gesture rather than as a query.
 *   3. **IT SURVIVES A SECOND DEVICE**, driven as a genuinely separate browser
 *      context with its own storage. That context also tries to start its own
 *      timer and is refused, which is the double count between two devices being
 *      made impossible rather than discouraged.
 *   4. The stop produces an ORDINARY entry, in the week, on the timer's own day.
 *
 * **THE RECOVERY INTERACTION IS REACHED FROM THE SHORT END, AND THAT IS SAID
 * RATHER THAN GLOSSED.** The spec's example is 62 hours, and no journey can
 * produce one: `started_at` is stamped by Postgres and no route accepts an
 * instant, deliberately -- a timer whose start could be dictated by a caller is
 * not a timer. What CAN be reached in a browser is the same rule at its other
 * edge: a timer stopped inside its first minute has also produced no storable
 * figure, so the stop form opens with NO PROPOSAL and the operator must type a
 * number or discard. `timerProposedMinutes` is one function with one rule, so
 * this is that interaction end to end; the 62-hour side of the same branch is
 * held by the shared, lib, service and route tests.
 *
 * **NO ABSOLUTE TOTALS ANYWHERE**, which is the lesson CI taught
 * `timesheet.spec.ts` three times: this suite shares one database,
 * `tasks.spec.ts` books an hour of its own, and a serial describe re-runs from
 * the top on retry. Every figure here is read through the page's own record
 * filter, narrowed to this journey's project.
 *
 * **AND THE ORGANISATION'S CLOCK IS FETCHED RATHER THAN ASSUMED**, for the same
 * file's reason: `documents.spec.ts` sets `org_profile.time_zone` globally and
 * sorts first. This journey never hard-codes a day -- it reads the day the SERVER
 * put the timer on, which is the only honest oracle for a value the server
 * derives.
 */

const IPHONE_13 = devices["iPhone 13"];

test.describe.serial("The timer, on a phone", () => {
  const runId = Date.now().toString(36);
  let attemptId = "";
  let projectName = "";
  let timerText = "";
  let secondText = "";

  let context: BrowserContext;
  let page: Page;
  let projectId = "";
  let landingDay = "";

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({ ...IPHONE_13 });
    page = await context.newPage();
    attemptId = `${runId}x${testInfo.retry}`;
    projectName = `Timer ${attemptId}`;
    timerText = `Ingest rewrite ${attemptId}`;
    secondText = `Discarded run ${attemptId}`;
  });

  test.afterAll(async () => {
    // ANY TIMER THIS JOURNEY LEFT RUNNING IS DISCARDED, and that is not tidiness:
    // at most one timer runs per person and every journey in this suite is the
    // same dev user, so a timer left behind by a failed run would make the NEXT
    // file's start a 409 -- and the failure would name a file that did nothing
    // wrong. Best effort; a failure here must not mask the real one.
    try {
      const state = await page.request.get("/api/timer");
      const running = ((await state.json()) as { timer: { id: string } | null }).timer;
      if (running !== null) await page.request.post(`/api/timer/${running.id}/discard`);
    } catch { /* the run is already over; nothing here is worth a second failure */ }
    await context.close();
  });

  async function create(path: string, data: unknown): Promise<{ id: string }> {
    const response = await page.request.post(path, { data });
    const body = await response.text();
    expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`)
      .toBe(201);
    return JSON.parse(body) as { id: string };
  }

  /**
   * Narrow the timesheet to this journey's own project -- every figure below is
   * read through it, so nothing here measures the rest of the suite.
   *
   * **IDEMPOTENT, AND THAT IS A FIX RATHER THAN A CONVENIENCE.** The filter is
   * view state and survives everything except a full page load, so a second call
   * inside one navigation finds the CHIP rather than the four buttons -- and
   * `filter-project` then does not exist at all. The first draft of the discard
   * journey called this after starting a timer on a page that was already
   * filtered, and spent a 30-second timeout waiting for a button the page was
   * right not to be rendering.
   */
  async function filterToProject(): Promise<void> {
    if (await page.getByTestId("timesheet-filter").count() > 0) {
      await expect(page.getByTestId("timesheet-filter")).toContainText(projectName);
      return;
    }
    await page.getByTestId("filter-project").click();
    await page.getByTestId("link-search-project").fill(projectName);
    await page.getByTestId(`link-option-${projectId}`).click();
    await expect(page.getByTestId("timesheet-filter")).toContainText(projectName);
  }

  async function startTimer(description: string): Promise<void> {
    await page.getByTestId("start-timer").click();
    await expect(page.getByTestId("timer-start-dialog")).toBeVisible();
    await page.getByTestId("timer-start-description").fill(description);
    await page.getByTestId("timer-start-link-project").click();
    await page.getByTestId("link-search-project").fill(projectName);
    await page.getByTestId(`link-option-${projectId}`).click();
    await page.getByTestId("timer-start-save").click();
    await expect(page.getByTestId("timer-start-dialog")).toHaveCount(0);
  }

  test("creates the project this journey runs on, and starts with no timer", async () => {
    await page.goto("/");
    projectId = (await create("/api/projects", { name: projectName })).id;
    // THE PREMISE FOR EVERYTHING BELOW: nothing is running, so the strip's
    // absence later means something. A timer left by an earlier file would make
    // every assertion in this journey about somebody else's clock.
    await expect(page.getByTestId("timer-strip")).toHaveCount(0);
  });

  /**
   * **THE REFUSAL THAT ARRIVES AT START RATHER THAN AT STOP.** A timer attached
   * to nothing could never become an entry, and meeting that at stop would mean
   * meeting it while holding hours with nowhere to put them -- the situation the
   * recovery interaction already exists to make survivable.
   */
  test("refuses to start a timer that is booked to nothing", async () => {
    await page.goto("/timesheet");
    await expect(page.getByTestId("timesheet")).toBeVisible();
    await page.getByTestId("start-timer").click();
    await expect(page.getByTestId("timer-start-dialog")).toBeVisible();
    await page.getByTestId("timer-start-description").fill(timerText);
    await page.getByTestId("timer-start-save").click();
    await expect(page.getByTestId("timer-start-error")).toContainText(/company|project/i);
    // Still open, and no clock started.
    await expect(page.getByTestId("timer-start-dialog")).toBeVisible();
    await page.getByTestId("timer-start-cancel").click();
    await expect(page.getByTestId("timer-strip")).toHaveCount(0);
  });

  test("starts a timer, and the strip says so without claiming the time is counted", async () => {
    await startTimer(timerText);
    const strip = page.getByTestId("timer-strip");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId("timer-label")).toHaveText(timerText);
    // THE SENTENCE, ON THE SCREEN. A strip showing only a stopwatch would pass a
    // visibility assertion; this is the clause that makes the figure honest, and
    // it is in the same viewport as the week's total that leaves it out.
    //
    // CASE-INSENSITIVE, because the clause is sentence-initial in one of
    // timerSummary's three branches and mid-sentence in the other two -- and this
    // journey reaches the branch where it is capitalised. A literal lower-case
    // match is what this assertion was and it went red on exactly that, after
    // ALREADY having caught the real defect (the branch carried no such clause at
    // all). Two failures, one instrument, and only the first was a bug.
    await expect(page.getByTestId("timer-summary")).toContainText(/nothing is counted/i);

    // THE WEEK DOES NOT MOVE WHILE IT RUNS, which is the property the sentence is
    // about. Read through this journey's own filter so it is this project's zero.
    await filterToProject();
    await expect(page.getByTestId("counted-summary")).toContainText("0m counted");
  });

  /**
   * **THE STRIP IS ON EVERY PAGE, WHICH IS THE PLACEMENT DECISION AS A JOURNEY.**
   * Four routes reached through the app's own navigation, none of them the
   * timesheet. This is the assertion that would go red if somebody moved the
   * strip onto the page it is about.
   */
  test("stays on the screen across four other routes", async () => {
    for (const route of ["/companies", "/my-tasks", "/projects", "/mail"]) {
      await page.goto(route);
      await expect(page.getByTestId("timer-strip"), route).toBeVisible();
      await expect(page.getByTestId("timer-label"), route).toHaveText(timerText);
    }
  });

  /**
   * **THE CLOSED TAB.** Conduit is one process with no swap and the running state
   * is a row, so a reload -- which throws away every byte the browser held -- has
   * nothing to lose. The day the hours will land on is read here rather than
   * computed: the server derives it from `started_at` in the organisation's
   * calendar, and a journey that computed its own would be asserting its own
   * arithmetic.
   */
  test("survives a reload with the same timer and the same start", async () => {
    const before = await page.request.get("/api/timer");
    const started = ((await before.json()) as { timer: { startedAt: string; workDate: string } }).timer;
    landingDay = started.workDate;
    expect(landingDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await page.reload();
    await expect(page.getByTestId("timer-strip")).toBeVisible();
    await expect(page.getByTestId("timer-label")).toHaveText(timerText);
    const after = await page.request.get("/api/timer");
    const still = ((await after.json()) as { timer: { startedAt: string } }).timer;
    expect(still.startedAt).toBe(started.startedAt);
  });

  /**
   * **THE SECOND DEVICE, AND THE DOUBLE COUNT IT WOULD OTHERWISE CAUSE.**
   *
   * A genuinely separate browser context -- its own storage, its own everything --
   * sees the same clock, because the state is a row rather than anything either
   * browser holds. And when it tries to start its own, it is refused: without
   * `timers_one_running_per_owner` both devices would stop into an entry and one
   * afternoon would be booked twice by an operator who did nothing wrong.
   */
  test("is the same timer on a second device, which cannot start its own", async ({ browser }) => {
    const second = await browser.newContext({ ...IPHONE_13 });
    try {
      const other = await second.newPage();
      await other.goto("/companies");
      await expect(other.getByTestId("timer-strip")).toBeVisible();
      await expect(other.getByTestId("timer-label")).toHaveText(timerText);

      await other.goto("/timesheet");
      await expect(other.getByTestId("timesheet")).toBeVisible();
      // The button says so rather than offering an action that cannot work.
      await expect(other.getByTestId("start-timer")).toBeDisabled();
      // And the API refuses it outright, which is what the button is reflecting.
      const refused = await other.request.post("/api/timer", { data: { projectId } });
      expect(refused.status()).toBe(409);
    } finally {
      await second.close();
    }
  });

  /**
   * **THE RECOVERY INTERACTION, REACHED FROM THE SHORT END OF THE SAME RULE.**
   *
   * This timer has been running for well under a minute, so `timerProposedMinutes`
   * withholds the proposal exactly as it does past a day -- the form opens with an
   * EMPTY minutes box and the operator has to say what they actually worked, or
   * discard. That is the 62-hour interaction; only the reason for the refusal
   * differs, and both come out of one function.
   *
   * The day the hours will land on is stated before anything is committed, which
   * is the recovery's real surprise: a timer left running since Friday books
   * FRIDAY, not today.
   */
  test("opens the stop form with no proposal, and says which day the hours will land on", async () => {
    await page.goto("/companies");
    await page.getByTestId("timer-stop").click();
    await expect(page.getByTestId("timer-stop-dialog")).toBeVisible();

    // NO DEFAULT, because there is no legal figure to default to. A form that
    // pre-filled anything here would be proposing work nobody did.
    await expect(page.getByTestId("timer-minutes")).toHaveValue("");
    // The day, named, and it is the one the SERVER derived.
    const landing = new Date(`${landingDay}T00:00:00Z`).toLocaleDateString("en-GB", {
      timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
    });
    await expect(page.getByTestId("timer-landing")).toContainText(landing);
    // And where the hours are going, which the description alone cannot say.
    await expect(page.getByTestId("timer-link-chip")).toContainText(projectName);
  });

  test("refuses the stop until it has been told a duration and whether it is billable", async () => {
    await page.getByTestId("timer-save").click();
    await expect(page.getByTestId("timer-error")).toContainText(/actually work/i);

    await page.getByTestId("timer-minutes").fill("45");
    await page.getByTestId("timer-save").click();
    await expect(page.getByTestId("timer-error")).toContainText(/billable/i);
    // Still open, and the clock is still running: nothing is written until Save
    // succeeds, so a rejected stop is a retry rather than a loss.
    await expect(page.getByTestId("timer-stop-dialog")).toBeVisible();
  });

  /**
   * **AND THE HOURS TYPED BY HAND ARE THE ONES THAT LAND.** The clock measured a
   * few seconds; the operator says 45 minutes; the entry says 45 minutes. A
   * service that cross-checked the figure against the elapsed time would refuse
   * exactly the correction this interaction exists to allow.
   */
  test("logs what the operator actually worked, on the timer's own day", async () => {
    await page.getByTestId("timer-billable-yes").click();
    await page.getByTestId("timer-save").click();
    await expect(page.getByTestId("timer-stop-dialog")).toHaveCount(0);
    // The strip empties, on the page the operator happened to be on.
    await expect(page.getByTestId("timer-strip")).toHaveCount(0);

    await page.goto("/timesheet");
    await expect(page.getByTestId("timesheet")).toBeVisible();
    await filterToProject();
    const day = page.getByTestId(`timesheet-day-${landingDay}`);
    await expect(day.getByText(timerText)).toBeVisible();
    await expect(day.getByTestId("day-total")).toHaveText("45m");
    // AN ORDINARY ENTRY, indistinguishable from a hand-typed one to everything
    // that reads the week -- which is exactly why the two capture paths cannot be
    // told apart by a report, and why the double count between them is
    // discouraged rather than impossible (services/timers.ts's header says so).
    await expect(page.getByTestId("counted-summary")).toContainText("45m counted");
    await expect(page.getByTestId("counted-summary")).toContainText("across 1 entry");
    await expect(page.getByTestId("billable-summary"))
      .toContainText("45m of the 45m logged by hand is billable");
  });

  /**
   * **DISCARD: THE OTHER WAY OUT OF THE WEEKEND, AND IT WRITES NOTHING.**
   *
   * Without it the only way to clear a strip an operator does not want is to
   * invent a number -- which is worse than nothing, because afterwards it is
   * indistinguishable from a real hour. The week must not move.
   */
  test("discards a timer without writing an hour, and frees the operator to start another", async () => {
    await startTimer(secondText);
    await expect(page.getByTestId("timer-label")).toHaveText(secondText);

    await page.getByTestId("timer-stop").click();
    await expect(page.getByTestId("timer-stop-dialog")).toBeVisible();
    await page.getByTestId("timer-discard").click();
    await expect(page.getByTestId("timer-stop-dialog")).toHaveCount(0);
    await expect(page.getByTestId("timer-strip")).toHaveCount(0);

    // The week is exactly where it was, and the discarded run left no row on it.
    await filterToProject();
    await expect(page.getByTestId("counted-summary")).toContainText("45m counted");
    await expect(page.getByText(secondText)).toHaveCount(0);
    // And Start works again, which is the partial index letting go.
    await expect(page.getByTestId("start-timer")).toBeEnabled();
  });

  /**
   * **KEEP RUNNING IS THE THIRD ANSWER, AND IT IS THE ONE "WHAT IF THEY IGNORE
   * IT" RESOLVES TO.** Closing the stop form leaves the clock exactly where it
   * was: a timer is never stopped for the operator, never guesses a duration and
   * never becomes an entry on its own.
   */
  test("keeps running when the stop form is closed, and the page does not scroll sideways", async () => {
    await startTimer(secondText);
    await page.getByTestId("timer-stop").click();
    await expect(page.getByTestId("timer-stop-dialog")).toBeVisible();
    await page.getByTestId("timer-cancel").click();
    await expect(page.getByTestId("timer-stop-dialog")).toHaveCount(0);
    await expect(page.getByTestId("timer-strip")).toBeVisible();

    /*
      THE ONE THING A LIST IS SUPPOSED TO BUY OVER A GRID, at the width the strip
      was designed for -- `timesheet.spec.ts`'s own measurement, re-taken with a
      row this page did not have. The strip is a flex-wrap row and its sentence
      takes a whole line below the breakpoint precisely so the two controls beside
      it can stay at the 44px floor without pushing anything off the edge.
    */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls sideways at 390px with the timer strip up").toBeLessThanOrEqual(0);

    // And the strip's own controls clear the floor.
    const stop = page.getByTestId("timer-stop");
    const box = await stop.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Left clean for whatever runs next -- see afterAll for why this matters more
    // than usual on a table with one row per person.
    await page.getByTestId("timer-stop").click();
    await page.getByTestId("timer-discard").click();
    await expect(page.getByTestId("timer-strip")).toHaveCount(0);
  });
});
