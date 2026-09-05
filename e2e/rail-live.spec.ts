import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * THE RECORD RAIL IS LIVE, AND IT DOES NOT MOVE UNDER THE READER (v1.7.1).
 *
 * The sibling of e2e/inbox-live.spec.ts, for the two lists that carried the
 * defect the inbox carried before v1.6.0: a record's Timeline tab and its
 * Meetings tab. Both are time-ordered, both accumulate pages, and both used to
 * take a refetch of a page that was already on screen -- so a row arriving
 * from anywhere (a colleague's write, or mail landing on a linked thread)
 * pushed every row below it down one, between two of the reader's clicks.
 *
 * WHY IT IS STUBBED, and stubbed here rather than in the journeys. The
 * arrivals these tests are about come from OTHER PEOPLE and from the mail
 * sync, and neither can be arranged from inside one browser session at all.
 * e2e/meetings.spec.ts and e2e/crm.spec.ts remain the end-to-end proof that
 * these tabs read the real API; what this file adds is the ability to state a
 * claim exactly, in a second, and to watch it go RED against a build that has
 * the bug -- which is the only thing that makes an assertion worth writing.
 *
 * The app under test is the real one, unmodified. The company is real, created
 * through the real API; the session, the users list and everything else the
 * page needs are the real routes. Only `/api/events`, `/api/meetings` and
 * `/api/stream` are served from lists these tests own -- and `/api/stream`
 * hands out the same hint frames services/sse.ts publishes (["events"], from
 * mail-ingest.ts and from every record write; ["meetings"], from
 * services/meetings.ts).
 *
 * NO POLLING ANYWHERE, and the tests below say so out loud: these lists are
 * refreshed only by a hint arriving, so a build that polled would pass the "it
 * appeared" halves and fail the wait that comes before them.
 */

/** A page of either list, matching the stub's own paging below. Both real
 * routes default to a page rather than the whole list; the exact number is
 * this file's to choose because the client sends no `limit` for either. */
const PAGE_SIZE = 25;

/** How long the browser waits before reconnecting the stubbed stream, which is
 * also the longest a hint can take to be delivered. `route.fulfill` cannot hold
 * a response open, so the stub answers the EventSource with one frame and lets
 * it reconnect: short enough not to pace the tests, long enough that the
 * reconnects are not a load generator. */
const SSE_RETRY_MS = 300;

/** The window a "nothing happened yet" claim is given. Generous against
 * SSE_RETRY_MS: a build that refreshed a list without a hint would have had
 * several chances by then. */
const QUIET_MS = 1_500;

/** Not in /api/users, deliberately. These tests are about which rows are on
 * screen and in what order, and an actor the users list cannot name renders as
 * a fixed em dash -- stable text, rather than a name that depends on which
 * user the dev server happens to be running as. */
const ACTOR_ID = "aaaaaaaa-0000-4000-8000-0000000000ff";

/** Deterministic, valid-v4-shaped ids, so a row can be predicted from the
 * fixture rather than read back out of the DOM. */
function rowId(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/**
 * A row of either list.
 *
 * `at` is an ABSOLUTE instant fixed when the fixture is built, not an age
 * resolved at request time, and that is load-bearing: both lists render the
 * timestamp into the row, and a fixture that recomputed it per fetch would
 * make every row's text differ between two reads of the same unchanged list --
 * which is precisely the thing the "nothing moved" assertions compare.
 */
interface Seed {
  id: string;
  at: string;
  /** The note preview a timeline row renders (a timeline entry carries no
   * per-row testid, so its text is its identity), or a meeting's title. */
  label: string;
  /** Meetings only: what taskCountLabel renders, and the one field these tests
   * change on a row that is already on screen. */
  taskCount: number;
}

/**
 * When every fixture row was WRITTEN, which is deliberately not when it
 * HAPPENED.
 *
 * A meeting is ordered by `occurred_at`, which a user types and can backdate;
 * `created_at` is when it was logged. Giving every row the same ancient
 * created_at is what makes the two distinguishable from outside: a build whose
 * arrivals count read the wrong column would find nothing newer than the floor
 * and would never offer anything at all. With both fields set from the same
 * clock -- the obvious fixture -- that mistake is invisible.
 */
const WRITTEN_AT = "2020-01-01T00:00:00.000Z";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedRows(count: number, label: (index: string) => string): Seed[] {
  return Array.from({ length: count }, (_, index) => {
    const padded = String(index).padStart(2, "0");
    return { id: rowId(index), at: minutesAgo((index + 1) * 10), label: label(padded), taskCount: 0 };
  });
}

/** A row that has just happened -- newer than everything any fixture seeds. */
function arrival(label: string): Seed {
  return { id: rowId(90), at: new Date().toISOString(), label, taskCount: 0 };
}

/** What the timeline entry a reader's own edit produces says, in this file. */
const OWN_WRITE_LABEL = "Written by the reader";

/** The wire shape of one timeline row (@conduit/shared's eventSchema), which
 * the client parses with zod -- so a missing field is a hard error in the app,
 * not a soft one in this file. */
function wireEvent(seed: Seed, companyId: string) {
  return {
    id: seed.id,
    verb: "note_added",
    actorUserId: ACTOR_ID,
    companyId, contactId: null, dealId: null, taskId: null, projectId: null,
    meetingId: null, mailThreadId: null, mailSubject: null,
    payload: { preview: seed.label },
    createdAt: seed.at,
  };
}

/** ...and of one meeting row (meetingSchema). */
function wireMeeting(seed: Seed, companyId: string) {
  return {
    id: seed.id,
    title: seed.label,
    occurredAt: seed.at,
    durationMinutes: null,
    notes: null,
    ownerUserId: ACTOR_ID,
    companyId, contactId: null, dealId: null, projectId: null,
    attendees: [],
    taskCount: seed.taskCount,
    archivedAt: null,
    // NOT seed.at -- see WRITTEN_AT.
    createdAt: WRITTEN_AT, updatedAt: WRITTEN_AT,
  };
}

/**
 * Sort key for the stub's keyset paging: the same descending
 * `(timestamp, id)` order both real routes use (api: services/timeline.ts and
 * services/meetings.ts), so a cursor issued before an arrival really does name
 * a position in an ordering that has since moved -- which is the whole
 * behaviour these tests are about.
 */
function sortKey(seed: Seed): string {
  return `${seed.at}|${seed.id}`;
}

/** One page out of a seed list, by that keyset. */
function keysetPage(
  seeds: readonly Seed[], cursor: string | null, limit: number,
): { items: Seed[]; nextCursor: string | null } {
  const sorted = [...seeds].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const rest = cursor === null ? sorted : sorted.filter((seed) => sortKey(seed) < cursor);
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rest.length > limit && last !== undefined ? sortKey(last) : null,
  };
}

interface RailStub {
  events: Seed[];
  meetings: Seed[];
  /** The hint keys every stream connection carries. Empty is a heartbeat,
   * which is what "nothing has been published" looks like on the wire. */
  live: string[];
}

/**
 * Serve the two rail lists from data this test owns, plus the stream that
 * tells the page they changed.
 *
 * Everything NOT matched here goes to the real API: the session, the company
 * itself, the users list, and the rest of the app.
 */
async function stubRail(browserPage: Page, companyId: string, stub: RailStub): Promise<void> {
  await browserPage.route((url) => url.pathname === "/api/events", async (route: Route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
    const { items, nextCursor } = keysetPage(stub.events, url.searchParams.get("cursor"), limit);
    await route.fulfill({ json: { items: items.map((seed) => wireEvent(seed, companyId)), nextCursor } });
  });

  await browserPage.route((url) => url.pathname === "/api/meetings", async (route: Route) => {
    // POST is the reader's OWN write, and the stub's list is updated BEFORE
    // the response goes out -- exactly as the real service commits before it
    // answers, which is the ordering the tab's re-snapshot has to respect.
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { title: string };
      const seed: Seed = { id: rowId(99), at: new Date().toISOString(), label: body.title, taskCount: 0 };
      stub.meetings = [seed, ...stub.meetings];
      await route.fulfill({ json: wireMeeting(seed, companyId) });
      return;
    }
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
    // The archived list is always empty here: these tests are about the live
    // one, and answering the toggle honestly keeps the two lists apart.
    const source = url.searchParams.get("archived") === "true" ? [] : stub.meetings;
    const { items, nextCursor } = keysetPage(source, url.searchParams.get("cursor"), limit);
    await route.fulfill({ json: { items: items.map((seed) => wireMeeting(seed, companyId)), nextCursor } });
  });

  /**
   * The reader's OWN write, made through the real API and noticed here.
   *
   * The PATCH is performed for real (`route.fetch`) and its real answer is
   * returned, so the app's own mutation runs exactly as it does in the field;
   * all this adds is the timeline entry the real service would have written,
   * which /api/events is stubbed and therefore would not otherwise have.
   */
  await browserPage.route(
    (url) => /^\/api\/companies\/[0-9a-f-]{36}$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      if (response.ok()) stub.events = [arrival(OWN_WRITE_LABEL), ...stub.events];
      await route.fulfill({ response });
    },
  );

  // One frame per connection, then EOF; the browser reconnects after `retry`.
  await browserPage.route((url) => url.pathname === "/api/stream", async (route: Route) => {
    const frame = stub.live.length === 0
      ? ":hb\n\n"
      : `data: ${JSON.stringify({ keys: stub.live.map((key) => [key]) })}\n\n`;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `retry: ${String(SSE_RETRY_MS)}\n\n${frame}`,
    });
  });
}

/**
 * Every visible timeline row's text, in paint order. The only assertion shape
 * that says "nothing moved" rather than "the row I thought about did not
 * move": an insertion, a removal and a re-order all change it.
 */
async function entryTexts(browserPage: Page): Promise<string[]> {
  return browserPage.locator('[data-testid="timeline-entry"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
}

/** The same claim on the Meetings tab, where every row carries its own id. */
async function meetingRowIds(browserPage: Page): Promise<string[]> {
  return browserPage.locator('[data-testid^="meeting-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
}

/** A company of this test's own, so nothing here can be disturbed by -- or
 * disturb -- another spec running beside it. */
async function makeCompany(browserPage: Page, label: string): Promise<string> {
  const created = await browserPage.request.post("/api/companies", { data: { name: label } });
  expect(created.ok()).toBe(true);
  return ((await created.json()) as { id: string }).id;
}

/** A name nothing else in the suite can collide with, per attempt: nothing
 * empties the database between Playwright retries. */
function uniqueName(what: string, retry: number): string {
  return `Rail live ${what} ${Date.now().toString(36)}x${String(retry)}`;
}

test("holds an arriving timeline entry behind a count, and moves nothing to do it", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("timeline", info.retry));
  const stub: RailStub = { events: seedRows(6, (n) => `Note ${n}`), meetings: [], live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await expect(page.locator('[data-testid="timeline-entry"]')).toHaveCount(6);

  const before = await entryTexts(page);
  const show = page.getByTestId("timeline-new-show");
  await expect(show).toHaveCount(0);

  stub.events = [arrival("Arriving now"), ...stub.events];

  // NOTHING HAPPENS UNTIL A HINT ARRIVES. The list is stale by a whole entry
  // and stays exactly as it is, because the transport is SSE and there is no
  // timer anywhere behind this surface.
  await page.waitForTimeout(QUIET_MS);
  expect(await entryTexts(page)).toEqual(before);
  await expect(show).toHaveCount(0);

  stub.live = ["events"];

  // COUNTED, NOT SHOWN, and every row the reader was looking at is where it
  // was. Before this fix the arriving entry was taken straight into page one
  // and all six rows moved down by one.
  await expect(show).toHaveText("Show 1 new entry");
  await expect(page.getByTestId("timeline").getByText("Arriving now")).toHaveCount(0);
  expect(await entryTexts(page)).toEqual(before);

  // Asking is what takes the server's order, and it takes all of it.
  await show.click();
  await expect(show).toHaveCount(0);
  const after = await entryTexts(page);
  expect(after).toHaveLength(7);
  expect(after[0]).toContain("Arriving now");
  expect(after.slice(1)).toEqual(before);
});

/**
 * BEHAVIOUR 3, AND THE HALF THAT COSTS SOMETHING IF IT IS MISSING. The hold
 * protects a reader from other people's writes; it must not hold back their
 * own. The record page's inline field edits are the commonest write in this
 * app and they land on the rail beside them -- an activity feed that answered
 * "Show 1 new entry" to the thing the reader had just typed would be hiding
 * their own work behind a button.
 *
 * The edit here is REAL (the PATCH goes to the API and its answer comes back);
 * only the entry it produces is served from this file's list, because
 * /api/events is stubbed. e2e/crm.spec.ts walks the same journey against the
 * real timeline route.
 */
test("shows the reader's own edit at once, with nothing to click", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("own edit", info.retry));
  const stub: RailStub = { events: seedRows(3, (n) => `Note ${n}`), meetings: [], live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await expect(page.locator('[data-testid="timeline-entry"]')).toHaveCount(3);

  const industry = page.getByTestId("field-industry");
  await industry.click();
  await industry.locator("input").fill("biotech");
  await industry.locator("input").press("Enter");
  await expect(industry).toContainText("biotech");

  // NO HINT IS SENT (stub.live is still empty) and no timer exists, so the
  // only thing that can put this entry on screen is the write itself being
  // recognised as the reader's own.
  await expect(page.getByTestId("timeline").getByText(OWN_WRITE_LABEL)).toBeVisible();
  await expect(page.getByTestId("timeline-new-show")).toHaveCount(0);
  expect(await entryTexts(page)).toHaveLength(4);
});

test("keeps the timeline live past page one, where nothing was watching before", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("paging", info.retry));
  // One full page, and five entries behind it.
  const stub: RailStub = { events: seedRows(30, (n) => `Note ${n}`), meetings: [], live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await expect(page.locator('[data-testid="timeline-entry"]')).toHaveCount(PAGE_SIZE);

  await page.getByTestId("timeline-load-more").click();
  await expect(page.locator('[data-testid="timeline-entry"]')).toHaveCount(30);
  const before = await entryTexts(page);

  stub.events = [arrival("Arriving now"), ...stub.events];
  stub.live = ["events"];

  // THE OBSERVER THAT DID NOT USED TO EXIST. After "Load more" the paging
  // query is watching page TWO, so page one -- where every new entry lands --
  // had nothing observing it, and this count could not have been computed at
  // all.
  await expect(page.getByTestId("timeline-new-show")).toHaveText("Show 1 new entry");
  expect(await entryTexts(page)).toEqual(before);

  // The re-snapshot goes back to page one, so the accumulated pages are gone
  // and "Load more" is offered again: the cursors they were fetched with name
  // positions in an ordering that has moved.
  await page.getByTestId("timeline-new-show").click();
  await expect(page.locator('[data-testid="timeline-entry"]')).toHaveCount(PAGE_SIZE);
  expect((await entryTexts(page))[0]).toContain("Arriving now");
  await expect(page.getByTestId("timeline-load-more")).toBeVisible();
});

test("shows the first activity on a record rather than offering to", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("empty", info.retry));
  const stub: RailStub = { events: [], meetings: [], live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByTestId("timeline-empty")).toBeVisible();

  stub.events = [arrival("Arriving now")];
  stub.live = ["events"];

  // An empty list has no reader's place to protect. Holding here would put "No
  // activity yet" on screen beside an offer to show the activity that has just
  // arrived, which is a screen that contradicts itself.
  await expect(page.getByTestId("timeline").getByText("Arriving now")).toBeVisible();
  await expect(page.getByTestId("timeline-new-show")).toHaveCount(0);
});

test("holds an arriving meeting, and refreshes a listed one where it stands", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("meetings", info.retry));
  const stub: RailStub = { events: [], meetings: seedRows(4, (n) => `Meeting ${n}`), live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await page.getByTestId("meetings-tab").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(4);

  const before = await meetingRowIds(page);
  const listed = page.getByTestId(`meeting-row-${rowId(2)}`);
  await expect(listed).toContainText("No follow-up tasks");

  // The pair the whole design turns on: a meeting the reader has never seen,
  // and a change to one they are looking at. Only the first is something to
  // offer, and both arrive on the same hint.
  stub.meetings = [
    arrival("Arriving now"),
    ...stub.meetings.map((seed) => (seed.id === rowId(2) ? { ...seed, taskCount: 1 } : seed)),
  ];

  await page.waitForTimeout(QUIET_MS);
  expect(await meetingRowIds(page)).toEqual(before);
  await expect(listed).toContainText("No follow-up tasks");

  stub.live = ["meetings"];

  // REFRESHED IN PLACE: the task count is current at the position the row
  // already occupies. This is the half that makes holding survivable -- a list
  // that adopted nothing from a refetch would still say "No follow-up tasks"
  // under a meeting that has one.
  await expect(listed).toContainText("1 follow-up task");
  // ...and the meeting the reader has never seen is counted, not shown.
  await expect(page.getByTestId("meetings-new-show")).toHaveText("Show 1 new meeting");
  await expect(page.getByTestId(`meeting-row-${rowId(90)}`)).toHaveCount(0);
  expect(await meetingRowIds(page)).toEqual(before);

  await page.getByTestId("meetings-new-show").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(5);
  expect((await meetingRowIds(page))[0]).toBe(`meeting-row-${rowId(90)}`);
  await expect(page.getByTestId("meetings-new-show")).toHaveCount(0);
});

test("keeps the Meetings tab live past page one too", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("meeting paging", info.retry));
  const stub: RailStub = { events: [], meetings: seedRows(30, (n) => `Meeting ${n}`), live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await page.getByTestId("meetings-tab").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(PAGE_SIZE);

  await page.getByTestId("meetings-load-more").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(30);
  const before = await meetingRowIds(page);

  // The row that CHANGES is beyond page one, asserted rather than assumed:
  // only the page-one observer can carry its fresh copy, because a meeting
  // that has just gained a follow-up task is not necessarily recent -- and
  // after "Load more" the paging query is watching page two.
  const deep = `meeting-row-${rowId(27)}`;
  expect(before.indexOf(deep)).toBeGreaterThanOrEqual(PAGE_SIZE);

  stub.meetings = [
    arrival("Arriving now"),
    ...stub.meetings.map((seed) => (seed.id === rowId(0) ? { ...seed, taskCount: 2 } : seed)),
  ];
  stub.live = ["meetings"];

  await expect(page.getByTestId(`meeting-row-${rowId(0)}`)).toContainText("2 follow-up tasks");
  await expect(page.getByTestId("meetings-new-show")).toHaveText("Show 1 new meeting");
  expect(await meetingRowIds(page)).toEqual(before);

  await page.getByTestId("meetings-new-show").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(PAGE_SIZE);
  expect((await meetingRowIds(page))[0]).toBe(`meeting-row-${rowId(90)}`);
  await expect(page.getByTestId("meetings-load-more")).toBeVisible();
});

/**
 * THE READER'S OWN WRITE IS NOT HELD BACK, AND THE ORDER OF THE RE-SNAPSHOT IS
 * WHAT MAKES THAT TRUE. "Log a meeting" invalidates ["meetings"] as it
 * settles, so a fetch is already in flight and the cache still holds the page
 * from BEFORE the write. A reset that emptied the accumulator first would
 * adopt that stale page, and the fresh one landing a moment later would find
 * page one held again and take nothing from it -- so the meeting just logged
 * would never appear, on any hint, ever. That failure is invisible to every
 * other test in this file, and it is the one the switch to takeCursorPage
 * would have introduced.
 */
test("shows a meeting the reader logs themselves, at once", async ({ page }, info) => {
  const companyId = await makeCompany(page, uniqueName("own write", info.retry));
  const stub: RailStub = { events: [], meetings: seedRows(3, (n) => `Meeting ${n}`), live: [] };
  await stubRail(page, companyId, stub);
  await page.goto(`/companies/${companyId}`);
  await page.getByTestId("meetings-tab").click();
  await expect(page.locator('[data-testid^="meeting-row-"]')).toHaveCount(3);

  await page.getByTestId("log-meeting").click();
  await page.getByTestId("meeting-title").fill("Logged by the reader");
  await page.getByTestId("meeting-submit").click();

  await expect(page.getByTestId(`meeting-row-${rowId(99)}`)).toBeVisible();
  expect((await meetingRowIds(page))[0]).toBe(`meeting-row-${rowId(99)}`);
  // Their own write is not an arrival to be offered: it is already here.
  await expect(page.getByTestId("meetings-new-show")).toHaveCount(0);
});
