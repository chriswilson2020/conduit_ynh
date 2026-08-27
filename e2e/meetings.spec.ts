import { test, expect } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { typeIntoEditor } from "./helpers.js";

/**
 * One serial journey through Phase 5's meetings: log a meeting on a company
 * with a contact attendee, a colleague and a free-text guest; read it back;
 * spin a follow-up task out of it; find both on the record's Timeline; find
 * the meeting again on the ATTENDEE contact's own tab and timeline (the
 * attendance widening, end to end); prove a record's open meeting stays off
 * another record's tab; watch the follow-up affordance close when the
 * meeting's project is archived; and archive the meeting itself.
 *
 * THE BROWSER RUNS AT UTC+14, DELIBERATELY. "When" is a `datetime-local`
 * input, which speaks the reader's LOCAL wall clock while the API stores an
 * instant -- and dev, CI and the API's own tests all run at Etc/UTC, where a
 * correct conversion and a "treat the typed text as UTC" bug are
 * indistinguishable. Pacific/Kiritimati is the largest offset in the tz
 * database (the same zone api: services/mail-ingest.test.ts uses to pin the
 * throttle's UTC day boundary), so the two answers here are 14 hours apart:
 * the typed-time round trip below fails loudly under either mistake, and the
 * project meeting's DEFAULT "now" is checked against the wall clock for the
 * same reason. `locale` is pinned beside it because the values being read
 * back are rendered with `toLocaleString`, and an assertion on "9:30" is only
 * meaningful if the page is not free to render "09.30".
 *
 * Names are derived from a run id plus the retry index, the mail spec's
 * `${runId}x${testInfo.retry}` shape: nothing empties the database between
 * Playwright attempts, and while every record this journey asserts against is
 * created fresh by its own first test (so its id, not its name, is what the
 * assertions are scoped to), the contact picker and the global search are
 * matched by NAME -- and a previous attempt's identically-named row would
 * make those two steps ambiguous rather than wrong.
 *
 * Tests run in file order and share one page; state (the company, contact and
 * meeting ids) accumulates across them, and a failure stops the rest rather
 * than cascading.
 */
test.describe.serial("Meetings journey", () => {
  const runId = Date.now().toString(36);

  /** Assigned in beforeAll, from the retry index -- see the file comment. */
  let attemptId = "";
  let companyName = "";
  let otherCompanyName = "";
  let contactName = "";
  let guestName = "";
  let meetingTitle = "";
  let notesText = "";
  let followUpTitle = "";
  let projectName = "";
  let projectMeetingTitle = "";

  /**
   * The one meeting whose "When" this journey TYPES rather than accepts. A
   * fixed local instant, read back through the same browser's clock: at
   * UTC+14 the stored instant is 2026-08-19T19:30Z, so a page that rendered
   * what was stored without converting -- or an input that posted the typed
   * text as if it were UTC -- lands 14 hours away from this.
   */
  const WHEN_LOCAL = "2026-08-20T09:30";

  let context: BrowserContext;
  let page: Page;
  let companyId = "";
  let otherCompanyId = "";
  let contactId = "";
  let meetingId = "";
  let followUpTaskId = "";
  let projectId = "";
  let projectMeetingId = "";

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({ timezoneId: "Pacific/Kiritimati", locale: "en-US" });
    page = await context.newPage();

    attemptId = `${runId}x${testInfo.retry}`;
    companyName = `Meetco ${attemptId}`;
    otherCompanyName = `Elsewhere ${attemptId}`;
    contactName = `Cara ${attemptId}`;
    guestName = `Gwen Guest ${attemptId}`;
    meetingTitle = `Kickoff ${attemptId}`;
    notesText = `Agreed the pilot scope ${attemptId}`;
    followUpTitle = `Send the pilot quote ${attemptId}`;
    projectName = `Atlas ${attemptId}`;
    projectMeetingTitle = `Atlas standup ${attemptId}`;
  });

  test.afterAll(async () => {
    await context.close();
  });

  // -- helpers ---------------------------------------------------------

  /** Meeting rows are addressed by title rather than by an id the test would
   * have to know in advance -- crm.spec.ts's row shape, and every title
   * carries the attempt id. */
  function meetingRow(title: string): Locator {
    return page.locator('[data-testid^="meeting-row-"]').filter({ hasText: title });
  }

  function timelineEntry(text: string): Locator {
    return page.getByTestId("timeline-entry").filter({ hasText: text });
  }

  async function idOf(locator: Locator, prefix: string): Promise<string> {
    const testId = await locator.getAttribute("data-testid");
    return (testId as string).replace(prefix, "");
  }

  /** Radix Tabs do not `forceMount`, so nothing inside the Meetings tab
   * exists until its trigger is clicked. */
  async function openMeetingsTab(): Promise<void> {
    await page.getByTestId("meetings-tab").click();
    await expect(page.getByTestId("meetings")).toBeVisible();
  }

  /** The tab is master-detail: opening a meeting REPLACES the list, so the
   * row locators are gone while the view is up. */
  async function openMeeting(title: string): Promise<void> {
    await meetingRow(title).click();
    await expect(page.getByTestId("meeting-view")).toBeVisible();
  }

  /** Navigate the way a user does, through the global search -- a router
   * navigation, so the detail page (and the rail inside it) keeps its state.
   * That is the whole point where this is used: a full page load would reset
   * the rail's selection for free and prove nothing. */
  async function searchTo(term: string, url: string): Promise<void> {
    const input = page.getByTestId("search-input");
    await input.fill(term);
    await page.getByTestId("search-result").filter({ hasText: term }).click();
    await expect(page).toHaveURL(url);
  }

  // --------------------------------------------------------------------

  test("creates the company, a second company and the contact this journey runs on", async () => {
    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    companyId = page.url().split("/").pop() as string;

    // The contact is created FROM the company, as a user would -- she is a
    // person at this company who will attend its meeting.
    await page.getByRole("button", { name: "New contact" }).click();
    await page.getByPlaceholder("First name").fill(contactName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    contactId = page.url().split("/").pop() as string;

    // The second company exists for one step only (the record-scoped
    // selection guard, below), which needs a SECOND record on the same route
    // -- /companies/a to /companies/b is one mounted detail page with new
    // props, which is exactly the case the guard is written against.
    await page.goto("/companies");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Company name").fill(otherCompanyName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    otherCompanyId = page.url().split("/").pop() as string;
    expect(otherCompanyId).not.toBe(companyId);
  });

  test("logs a meeting on the company with a contact, a colleague and a guest", async () => {
    await page.goto(`/companies/${companyId}`);

    // Nothing in the tab is mounted before its trigger is clicked -- but the
    // claim needs the page to have RENDERED to mean anything: company-detail
    // returns a bare "Loading..." while its record is in flight, in which
    // frame every testid on the page is absent. The rail's default tab
    // carrying this company's own creation entry is the loaded sentinel that
    // makes the absence beside it a real absence rather than a race won.
    await expect(page.getByTestId("timeline-entry").filter({ hasText: "created" })).toBeVisible();
    await expect(page.getByTestId("meetings")).toHaveCount(0);
    await openMeetingsTab();
    await expect(page.getByTestId("meetings-empty")).toHaveText("No meetings yet");

    // A DRAFT DOES NOT SURVIVE A TAB SWITCH, and that is worth pinning
    // rather than discovering: the form is local state inside a Radix
    // TabsContent, which unmounts when another tab is selected. Done here
    // with an untouched form, before anything has been typed into one.
    await page.getByTestId("log-meeting").click();
    await expect(page.getByTestId("meeting-form")).toBeVisible();
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.getByTestId("meetings")).toHaveCount(0);
    await openMeetingsTab();
    await expect(page.getByTestId("meeting-form")).toHaveCount(0);
    await expect(page.getByTestId("meetings-empty")).toBeVisible();

    await page.getByTestId("log-meeting").click();
    const form = page.getByTestId("meeting-form");
    await expect(form).toBeVisible();
    await form.getByTestId("meeting-title").fill(meetingTitle);
    await form.getByTestId("meeting-when").fill(WHEN_LOCAL);
    await form.getByTestId("meeting-duration").fill("45");

    // The contact attendee, through the app's one entity picker -- the same
    // component (and the same `link-`prefixed testids) the mail link panel
    // uses, which is what makes its move out of that panel guarded from
    // outside. The option is addressed by the contact's own id, so a
    // previous attempt's namesake in the results cannot be picked by mistake.
    await form.getByTestId("meeting-add-contact").click();
    await form.getByTestId("link-search-contact").fill(contactName);
    await form.getByTestId(`link-option-${contactId}`).click();

    // The colleague, through the user picker (a Radix Select whose options
    // render in a portal, hence the page-level option locator). EXACT,
    // because the mail spec's second user is in this list too and
    // getByRole's substring matching would call the pair ambiguous.
    await form.getByTestId("meeting-add-user").click();
    await page.getByRole("option", { name: "e2euser", exact: true }).click();
    // The picker is a picker, not a field: its trigger goes back to the
    // invitation rather than reporting the person just added...
    await expect(form.getByTestId("meeting-add-user")).toContainText("Add a colleague...");
    // ...and the OPTION LIST IS GONE, which the trigger assertion above does
    // not say -- and cannot: OwnerSelect is rendered with value={null} and a
    // fixed unassignedLabel, so its trigger has read "Add a colleague..."
    // since the form first painted. That line states the picker's contract
    // (a picker, not a field); it waits for nothing. The options meanwhile
    // live in a Radix portal (ui/select.tsx's SelectContent, role="listbox")
    // that unmounts on its own schedule. Nothing configures an exit
    // animation and CI has burned no retries here, so this is stated rather
    // than fixed -- an explicit gate instead of a race this test happens to
    // win. Without it, the second open below could resolve its option
    // against the FIRST portal, and "clicked a node that was on its way out"
    // is the kind of flake that reads as a duplicate-guard failure.
    await expect(page.getByRole("listbox")).toHaveCount(0);
    // Re-opened, because the same colleague can be offered again, and the
    // DUPLICATE GUARD is what has to answer -- before the round trip that
    // would come back 409 duplicate_attendee.
    await form.getByTestId("meeting-add-user").click();
    await page.getByRole("option", { name: "e2euser", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("already on the attendee list");

    // The guest: free text, nobody the CRM knows.
    await form.getByTestId("meeting-guest").fill(guestName);
    await form.getByTestId("meeting-add-guest").click();

    await expect(form.getByTestId("meeting-attendee-chip")).toHaveCount(3);
    await expect(form).toContainText(contactName);
    await expect(form).toContainText(guestName);

    // Real key events rather than fill(): the notes are a TipTap document,
    // not an input, and its model is built from what the editor sees happen
    // to it (mail.spec.ts's composer takes the same route, through the same
    // helper -- see e2e/helpers.ts for what the bare click-and-type shape
    // was letting through).
    await typeIntoEditor(form.getByTestId("meeting-notes"), notesText);

    await form.getByTestId("meeting-submit").click();
    await expect(page.getByTestId("meeting-form")).toHaveCount(0);

    const row = meetingRow(meetingTitle);
    await expect(row).toBeVisible();
    meetingId = await idOf(row, "meeting-row-");
    // The guest's name is on the row immediately; the contact's arrives with
    // her own GET /api/contacts/:id, so it is asserted with the ordinary
    // auto-waiting rather than read in the same breath.
    await expect(row).toContainText(guestName);
    await expect(row).toContainText(contactName);
    await expect(row).toContainText("45m");
    await expect(row).toContainText("No follow-up tasks");
  });

  test("opens the meeting, with its notes, attendees and the time exactly as typed", async () => {
    await page.goto(`/companies/${companyId}`);
    await openMeetingsTab();
    await openMeeting(meetingTitle);

    const view = page.getByTestId("meeting-view");
    await expect(view).toContainText(meetingTitle);
    // THE datetime-local ROUND TRIP AT UTC+14 (see the file comment). Two
    // loose matches rather than one exact string: ICU renders the space
    // before AM/PM as U+202F in recent versions, and this assertion is about
    // the instant, not about that character.
    await expect(view).toContainText(/8\/20\/2026/);
    await expect(view).toContainText(/9:30:00/);
    await expect(view).toContainText("45m");
    await expect(view).toContainText("logged by e2euser");

    const attendees = page.getByTestId("meeting-attendees");
    await expect(attendees).toContainText(contactName);
    await expect(attendees).toContainText(guestName);
    await expect(attendees).toContainText("e2euser");

    // The notes come back through RichTextView -- the sanitized HTML the
    // server stored, re-parsed against the editor's own schema.
    await expect(page.getByTestId("meeting-notes-body")).toContainText(notesText);
  });

  test("adds a follow-up task from the meeting, with the meeting's links inherited", async () => {
    await page.goto(`/companies/${companyId}`);
    await openMeetingsTab();
    await openMeeting(meetingTitle);

    // WAIT FOR ENABLED, never merely for the page to settle: "Add task" is
    // briefly disabled on any PROJECT-linked meeting while that project's
    // archived state is being fetched, and this journey's next test relies
    // on the same control for the opposite reason.
    const addTask = page.getByTestId("meeting-add-task");
    await expect(addTask).toBeEnabled();
    await addTask.click();

    const taskForm = page.getByTestId("meeting-task-form");
    await taskForm.getByTestId("meeting-task-title").fill(followUpTitle);
    await taskForm.getByTestId("meeting-task-description").fill(`Agreed in ${meetingTitle}`);
    await taskForm.getByTestId("meeting-task-assignee").click();
    await page.getByRole("option", { name: "e2euser", exact: true }).click();
    await taskForm.getByTestId("meeting-task-submit").click();
    await expect(page.getByTestId("meeting-task-form")).toHaveCount(0);

    // `li`, not a prefix match on the testid alone: the form's own controls
    // are `meeting-task-title`/`-description`/`-assignee`/`-submit`, which
    // share that prefix by design.
    const taskRow = page.locator('li[data-testid^="meeting-task-"]').filter({ hasText: followUpTitle });
    await expect(taskRow).toBeVisible();
    followUpTaskId = await idOf(taskRow, "meeting-task-");
    await expect(page.getByTestId("meeting-view")).toContainText("1 follow-up task");

    // THE INHERITANCE IS A FACT ABOUT THE STORED TASK, so it is read back
    // from the API rather than inferred from the screen. companyId is the
    // meeting's own link, copied onto the task by the create; contactId
    // stays null because ATTENDANCE IS NOT A RECORD LINK ON THE MEETING --
    // Cara is at this meeting, the meeting is about the company.
    const response = await page.request.get(`/api/tasks/${followUpTaskId}`);
    expect(response.ok()).toBe(true);
    const task = await response.json() as {
      title: string; companyId: string | null; contactId: string | null;
      dealId: string | null; projectId: string | null;
    };
    expect(task.title).toBe(followUpTitle);
    expect(task.companyId).toBe(companyId);
    expect(task.contactId).toBeNull();
    expect(task.dealId).toBeNull();
    expect(task.projectId).toBeNull();

    // ...and it is an ORDINARY task, not a meeting-shaped imitation of one:
    // it was created through the same service every other task goes through,
    // so it groups in My Tasks like any other undated assignment.
    await page.goto("/my-tasks");
    await expect(page.getByTestId("my-tasks")).toBeVisible();
    await expect(page.getByTestId("group-undated")).toContainText(followUpTitle);
  });

  test("puts the meeting and its follow-up on the company's timeline, and the entry opens the meeting", async () => {
    await page.goto(`/companies/${companyId}`);
    // Timeline is the rail's default tab. NOTHING HERE PAGINATES: a new
    // entry lands on page one, which the accumulator freezes once a later
    // page has been loaded, and the timeline has no create affordance of its
    // own to reset on. This journey's entries are all on page one.
    await expect(page.getByTestId("timeline")).toBeVisible();
    const metEntry = timelineEntry(`logged the meeting "${meetingTitle}"`);
    await expect(metEntry).toBeVisible();
    await expect(timelineEntry("created a follow-up task from a meeting")).toBeVisible();

    // A MEETING LINK IS A BUTTON, NOT A NAVIGATION: v0.9.0 ships no meetings
    // route, so the rail honours it by switching its own tab. There is no
    // URL change to assert -- the assertion is that the meeting is on
    // screen, and that the address bar did not move.
    const urlBefore = page.url();
    await metEntry.getByTestId("timeline-meeting-link").click();
    await expect(page.getByTestId("meeting-view")).toBeVisible();
    await expect(page.getByTestId("meeting-view")).toContainText(meetingTitle);
    expect(page.url()).toBe(urlBefore);
  });

  test("carries the meeting to the attendee contact's own tab and timeline", async () => {
    // THE ATTENDANCE WIDENING, END TO END. This meeting's only record link is
    // the COMPANY; Cara reaches it purely by having been at it.
    await page.goto(`/contacts/${contactId}`);
    await openMeetingsTab();
    await expect(page.getByTestId(`meeting-row-${meetingId}`)).toBeVisible();

    await page.getByRole("tab", { name: "Timeline" }).click();
    const metEntry = timelineEntry(`logged the meeting "${meetingTitle}"`);
    await expect(metEntry).toBeVisible();
    // ...and the widening reaches the MEETING's own lifecycle rows only. The
    // follow-up task's creation entry names this meeting too, but a task is
    // not something an attendee was at: it belongs on the timelines of the
    // records the task itself links to. The `met` entry above is this
    // negative's loaded-list sentinel.
    await expect(timelineEntry("created a follow-up task from a meeting")).toHaveCount(0);

    // The same hop as on the company, from the rail where the meeting
    // arrived by attendance rather than by a link.
    await metEntry.getByTestId("timeline-meeting-link").click();
    await expect(page.getByTestId("meeting-view")).toContainText(meetingTitle);
  });

  test("keeps one record's open meeting off another record's tab", async () => {
    // BOTH RECORDS ARE VISITED FIRST, and that is the whole setup rather
    // than a warm-up. The rail's record-keyed selection is only reachable
    // when the destination renders with no loading gap: company-detail
    // returns a bare "Loading..." while its own record is in flight, which
    // unmounts the rail and takes the selection with it -- so a navigation
    // to a company this browser has never fetched clears the selection by
    // accident, and proves nothing about the guard. With both records in the
    // query cache the page renders straight from it, the mounted rail simply
    // receives new props, and the guard is the only thing standing between
    // company A's open meeting and company B's tab. (That is also the case
    // it was written against: moving between two records you have just been
    // looking at.)
    await page.goto(`/companies/${otherCompanyId}`);
    await expect(page.getByRole("heading", { name: otherCompanyName })).toBeVisible();
    await searchTo(companyName, `/companies/${companyId}`);
    await openMeetingsTab();
    await openMeeting(meetingTitle);

    // A router navigation between two companies, which now does NOT remount
    // the detail page or the rail inside it -- so the open meeting would
    // still be open here if the selection did not carry the record it
    // belongs to. The tab strip's own state surviving the navigation is what
    // says the rail was not remounted.
    await searchTo(otherCompanyName, `/companies/${otherCompanyId}`);
    await expect(page.getByTestId("meetings")).toBeVisible();
    // "Log a meeting" renders in the LIST and nowhere else, so it is the
    // unambiguous "this is not a meeting view" signal -- and it needs no
    // fetch to be true, unlike the empty state beside it.
    await expect(page.getByTestId("log-meeting")).toBeVisible();
    await expect(page.getByTestId("meeting-view")).toHaveCount(0);
    await expect(page.getByTestId("meetings-empty")).toHaveText("No meetings yet");

    // The TIMELINE is keyed on the record the same way and for the same
    // reason -- it does not remount either, so the previous company's
    // accumulated rows would otherwise still be on screen under this one's
    // name. This company's own creation entry is the loaded sentinel that
    // makes the absence beside it a real absence.
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(timelineEntry("created")).toBeVisible();
    await expect(timelineEntry(`logged the meeting "${meetingTitle}"`)).toHaveCount(0);

    // AND THE SELECTION COMES BACK on the way home, which is deliberate: the
    // record key MASKS a foreign record's selection rather than clearing it,
    // so returning to the record the meeting belongs to returns the reader
    // to what they were reading. Back to the Meetings tab first, so the
    // return trip is about the selection rather than about which tab is up.
    await openMeetingsTab();
    await searchTo(companyName, `/companies/${companyId}`);
    await expect(page.getByTestId("meeting-view")).toBeVisible();
    await expect(page.getByTestId("meeting-view")).toContainText(meetingTitle);
  });

  test("closes the follow-up affordance when the meeting's project is archived", async () => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    projectId = page.url().split("/").pop() as string;

    // Title only this time: "When" keeps its default, which is NOW in the
    // browser's own zone -- the other half of the datetime-local round trip,
    // and 14 hours from the truth if that default were built in UTC.
    await openMeetingsTab();
    await page.getByTestId("log-meeting").click();
    await page.getByTestId("meeting-title").fill(projectMeetingTitle);
    await page.getByTestId("meeting-submit").click();
    const row = meetingRow(projectMeetingTitle);
    await expect(row).toBeVisible();
    projectMeetingId = await idOf(row, "meeting-row-");

    const detail = await page.request.get(`/api/meetings/${projectMeetingId}`);
    expect(detail.ok()).toBe(true);
    const { meeting } = await detail.json() as { meeting: { occurredAt: string } };
    expect(Math.abs(Date.parse(meeting.occurredAt) - Date.now())).toBeLessThan(10 * 60_000);

    // While the project is live the affordance is open. ENABLED FIRST, then
    // the absence: the blocked line appears transiently on a perfectly
    // healthy project-linked meeting while that fetch is in flight, so
    // asserting its absence before the button has settled would be asserting
    // a race.
    await openMeeting(projectMeetingTitle);
    await expect(page.getByTestId("meeting-add-task")).toBeEnabled();
    await expect(page.getByTestId("meeting-add-task-blocked")).toHaveCount(0);

    await page.goto(`/projects/${projectId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByTestId("archived-badge")).toBeVisible();

    // A follow-up task would inherit the archived project and be refused by
    // a 409 that names the project while carrying the same code as an
    // archived MEETING -- so the tab says so before the click instead.
    // MATCHED BY TEXT, not by the element's presence: all four reasons share
    // one testid deliberately, and "checking..." is one of them.
    await openMeetingsTab();
    await openMeeting(projectMeetingTitle);
    await expect(page.getByTestId("meeting-add-task-blocked")).toContainText("project is archived");
    await expect(page.getByTestId("meeting-add-task")).toBeDisabled();
  });

  test("archives the meeting and finds it behind the Archived control", async () => {
    await page.goto(`/companies/${companyId}`);
    await openMeetingsTab();
    await openMeeting(meetingTitle);

    await page.getByTestId("meeting-archive").click();
    await expect(page.getByTestId("meeting-unarchive")).toBeVisible();
    const view = page.getByTestId("meeting-view");
    await expect(view).toContainText("This meeting is archived.");
    // An archived meeting does not sprout new work -- the same gate as the
    // archived project above, with the reason that names the meeting.
    await expect(page.getByTestId("meeting-add-task")).toBeDisabled();
    await expect(page.getByTestId("meeting-add-task-blocked"))
      .toContainText("Unarchive it to add follow-up tasks");

    // Gone from the live list -- an absence from a list whose empty label is
    // its own loaded sentinel, this company having had exactly one meeting.
    await page.getByTestId("meeting-back").click();
    await expect(page.getByTestId("meetings-empty")).toHaveText("No meetings yet");
    await page.getByTestId("show-archived-meetings").check();
    await expect(page.getByTestId(`meeting-row-${meetingId}`)).toBeVisible();

    // THE ARCHIVED BOX SURVIVES A DETAIL VISIT, which is the point of it
    // living above the list rather than inside it: a reader who opens an
    // archived meeting and comes back must not be returned to the live list,
    // which by definition does not hold what they were just reading.
    await page.getByTestId(`meeting-row-${meetingId}`).click();
    await expect(page.getByTestId("meeting-view")).toBeVisible();
    await page.getByTestId("meeting-unarchive").click();
    await expect(page.getByTestId("meeting-archive")).toBeVisible();
    await page.getByTestId("meeting-back").click();
    await expect(page.getByTestId("show-archived-meetings")).toBeChecked();
    await expect(page.getByTestId("meetings-empty")).toHaveText("No archived meetings");

    // ...and unticking finds the unarchived meeting where it belongs.
    await page.getByTestId("show-archived-meetings").uncheck();
    await expect(page.getByTestId(`meeting-row-${meetingId}`)).toBeVisible();
  });
});
