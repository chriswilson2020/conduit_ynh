import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  taskEffortSchema, taskEffortSummary, timesheetBillableSummary, timesheetSummary,
  timesheetTotalsSchema, timesheetWeekSchema,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { taskEffort, timesheetDays, timesheetTotals } from "./timesheet.js";
import { createTask, archiveTask } from "./tasks.js";
import { NotFoundError } from "./errors.js";
import { createTimeEntry, archiveTimeEntry, listTimeEntries } from "./time-entries.js";
import { createMeeting, archiveMeeting, updateMeeting, createMeetingTask } from "./meetings.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createProject } from "./projects.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";

/**
 * **PHASE 10 TASK 2: MEETINGS COUNT, AND THE SAME HOUR CANNOT BE COUNTED
 * TWICE.**
 *
 * `meetings.duration_minutes` has held tracked time since Phase 5 and nothing
 * has ever aggregated it. This is the reading layer that does -- the one Task 4's
 * page renders and does not itself compute.
 *
 * THE THREE THINGS THESE TESTS ARE FOR, in the order the task states them:
 *
 *   1. A meeting with a duration contributes its minutes to the week, summed IN
 *      SQL over the whole range rather than over a page of it.
 *   2. A meeting with NO duration contributes nothing, and that is visible as a
 *      number in the answer rather than as a silent zero.
 *   3. No path adds one hour twice. The direct route is already impossible --
 *      there is no `meeting_id` column on `time_entries` (db/schema.test.ts pins
 *      it) -- so what is tested here is every INDIRECT route: a join that fans a
 *      meeting out over its attendees or its links, a meeting counted in two
 *      buckets, and an archived row still contributing.
 */

const handle = openTestDatabase();
let actorId: string;
let projectId: string;

/** Fixed, because the meeting half of this report is relative to `now` and a
 * test whose answer depends on the wall clock is a test that changes its mind at
 * midnight. Every date below is chosen around this instant. */
const NOW = new Date("2026-09-09T12:00:00.000Z");

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  projectId = (await createProject(handle.db, actorId, { name: "Rollout" })).id;
});
afterAll(async () => { await handle.close(); });

/** The organisation's clock, which is what decides the calendar day a meeting's
 * instant fell on. A truncated database has no org_profile row at all, which
 * `getOrgProfile` answers as UTC -- so the default here is UTC and every test
 * that cares says so. */
async function setOrgTimeZone(zone: string): Promise<void> {
  await handle.db.execute(sql`
    INSERT INTO org_profile (id, time_zone) VALUES (1, ${zone})
    ON CONFLICT (id) DO UPDATE SET time_zone = EXCLUDED.time_zone
  `);
}

async function entry(workDate: string, minutes: number): Promise<string> {
  return (await createTimeEntry(handle.db, actorId, {
    workDate, minutes, billable: true, projectId,
  })).id;
}

async function meeting(
  occurredAt: string, durationMinutes: number | null, extra: Record<string, unknown> = {},
): Promise<string> {
  return (await createMeeting(handle.db, actorId, {
    title: "Kickoff", occurredAt, durationMinutes, projectId, ...extra,
  })).id;
}

/** Monday to Sunday around NOW. NOW is Wednesday the 9th. */
const WEEK = { from: "2026-09-07", to: "2026-09-13" } as const;

describe("timesheetTotals: what it counts", () => {
  it("answers an empty range with nought, not with nothing", async () => {
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.countedMinutes).toBe(0);
    expect(totals.entryMinutes).toBe(0);
    expect(totals.meetingMinutes).toBe(0);
    expect(totals.meetingsInRange).toBe(0);
    // COALESCE, and it is not decoration: SUM over no rows is NULL, and a week
    // with no hours in it is 0 hours rather than an absent answer.
    expect(totals.countedMinutes).not.toBeNull();
  });

  it("adds a meeting's minutes to the entries' own", async () => {
    await entry("2026-09-08", 120);
    await meeting("2026-09-08T09:00:00.000Z", 45);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.entryMinutes).toBe(120);
    expect(totals.meetingMinutes).toBe(45);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.countedMinutes).toBe(165);
  });

  /**
   * **NUMBERS, NOT THE STRINGS POSTGRES WOULD OTHERWISE HAND BACK.** `SUM` and
   * `COUNT` over an `integer` column return `bigint`, which postgres.js delivers
   * as a STRING -- and `sql<number>` is a claim TypeScript believes without
   * checking. Left uncast, `entryMinutes + meetingMinutes` is `"120" + "45"` =
   * `"12045"`, a total that is wrong by three orders of magnitude and typed as
   * correct. The `::int` casts in the service are what make this true, so this
   * asserts the runtime type rather than trusting the annotation.
   */
  it("returns numbers rather than the bigint strings the driver would give", async () => {
    await entry("2026-09-08", 120);
    await meeting("2026-09-08T09:00:00.000Z", 45);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    for (const [name, value] of Object.entries(totals)) {
      if (name === "from" || name === "to" || name === "timeZone") continue;
      expect(typeof value, name).toBe("number");
    }
    expect(totals.entryMinutes + totals.meetingMinutes).toBe(165);
  });

  /**
   * **THE TRAP TASK 1 WROTE DOWN, AND THE REASON THIS FUNCTION EXISTS AT ALL.**
   *
   * `listTimeEntries` caps at 100 rows, so a JavaScript sum over `items` is
   * correct until somebody logs 101 entries in a week and is then SILENTLY SHORT
   * -- this phase's own failure mode arriving through the one number the phase
   * exists to produce. 101 entries of 7 minutes is 707; a sum over the first page
   * is 700, which looks entirely plausible.
   *
   * The list call is here to prove the cap is real rather than assumed, so this
   * test cannot pass by the cap having quietly gone away.
   */
  it("sums every entry in the range, not the first hundred of them", async () => {
    for (let i = 0; i < 101; i++) await entry("2026-09-08", 7);
    // Asked for five hundred and capped at MAX_LIMIT, so this is not a default
    // that a caller could raise: there is no page size at which the list returns
    // the week.
    const page = await listTimeEntries(handle.db, { from: WEEK.from, to: WEEK.to, limit: 500 });
    expect(page.items.length).toBe(100);
    expect(page.nextCursor).not.toBeNull();

    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.entryCount).toBe(101);
    expect(totals.entryMinutes).toBe(707);
  });

  /** Inclusive both ends, matching listTimeEntries' `from`/`to` exactly: a week
   * is Monday to Sunday and the caller sends both days. An exclusive upper bound
   * would drop Sunday without making the total look wrong. */
  it("includes work on the first and last day of the range and nothing outside it", async () => {
    await entry("2026-09-06", 10);
    await entry("2026-09-07", 20);
    await entry("2026-09-13", 40);
    await entry("2026-09-14", 80);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.entryMinutes).toBe(60);
    expect(totals.entryCount).toBe(2);
  });
});

/**
 * **A MEETING WITH NO RECORDED LENGTH CONTRIBUTES NOTHING, AND SAYS SO.**
 *
 * The spec, in as many words: "a report that silently treats unknown length as
 * zero is the same failure in a smaller costume". `meetings.duration_minutes` is
 * nullable because not every logged meeting has a known length (Phase 5), so the
 * null is honest data and not missing data -- and turning it into a zero would
 * turn an unknown into a claim.
 */
describe("timesheetTotals: the meetings it cannot count", () => {
  it("reports a meeting with no duration as unmeasured instead of as zero", async () => {
    await meeting("2026-09-08T09:00:00.000Z", 60);
    await meeting("2026-09-08T14:00:00.000Z", null);
    await meeting("2026-09-09T09:00:00.000Z", null);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsUnmeasured).toBe(2);
    // The number reaches the operator's own sentence, which is the only place it
    // can be seen: see timesheetSummary in @conduit/shared.
    expect(timesheetSummary(totals)).toContain("2 meetings with no recorded length");
  });

  /**
   * **A MEETING NOBODY HAS HAD YET IS NOT A RECORDED HOUR, AND THIS IS NOT IN
   * THE SPEC.**
   *
   * `meetings.occurred_at` is free in both directions by an explicit Phase 5
   * decision -- "noting a meeting you have just had and one you have just
   * arranged are the same act" -- and NO COLUMN SAYS WHICH IT IS. So the current
   * week contains Friday's arranged meetings on Wednesday morning, and counting
   * them answers "where did the week go" with work nobody has done. The spec's
   * own premise is that a logged meeting with a duration IS a recorded hour; an
   * arranged one is a plan.
   *
   * Reported rather than dropped, for the same reason an unmeasured one is: an
   * hour excluded in silence is the failure this task exists to prevent, whether
   * it is excluded for being unknown or for being in the future.
   */
  it("reports a meeting later in the week rather than counting it", async () => {
    await meeting("2026-09-08T09:00:00.000Z", 60);  // Tuesday, before NOW
    await meeting("2026-09-11T09:00:00.000Z", 90);  // Friday, after NOW
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsNotYetOccurred).toBe(1);
    expect(timesheetSummary(totals)).toContain("1 meeting that has not happened yet");
  });

  /** The boundary is the instant itself: a meeting that has started counts, and
   * `now` is not in the future. */
  it("counts a meeting that has begun and not one that begins a millisecond later", async () => {
    await meeting(NOW.toISOString(), 30);
    await meeting(new Date(NOW.getTime() + 1).toISOString(), 30);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsNotYetOccurred).toBe(1);
    expect(totals.meetingMinutes).toBe(30);
  });

  /**
   * EVERY MEETING IN THE RANGE IS IN EXACTLY ONE BUCKET, and the three add up to
   * the number the range contains. A meeting in two buckets is a double count
   * inside a single query; a meeting in none is an hour that vanished with
   * nothing saying so. Both are invisible unless something adds them up.
   *
   * A future meeting with NO duration is the case that decides the precedence:
   * it is reported as not-yet-happened and NOT also as unmeasured, because its
   * duration is not yet a fact about anything.
   */
  it("puts every meeting in the range into exactly one bucket", async () => {
    await meeting("2026-09-08T09:00:00.000Z", 60);
    await meeting("2026-09-08T11:00:00.000Z", null);
    await meeting("2026-09-11T09:00:00.000Z", 90);
    await meeting("2026-09-11T11:00:00.000Z", null);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingsInRange).toBe(4);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsUnmeasured).toBe(1);
    expect(totals.meetingsNotYetOccurred).toBe(2);
    expect(totals.meetingsCounted + totals.meetingsUnmeasured + totals.meetingsNotYetOccurred)
      .toBe(totals.meetingsInRange);
  });
});

/**
 * **THE SAME HOUR CANNOT BE COUNTED TWICE, AND THE DIRECT ROUTE IS NOT WHERE THE
 * RISK IS.**
 *
 * A time entry cannot name a meeting because there is no column to name one with
 * (db/schema.test.ts holds that, in its strongest form: the INSERT fails to
 * resolve against the table, 42703, which no constraint can be dropped to get
 * around). What these tests cover is every way a sum could count an hour twice
 * WITHOUT such a column: a query that fans a meeting out over its own rows, and
 * a row that has been taken out of the week still contributing to it.
 */
describe("timesheetTotals: no hour is counted twice", () => {
  /**
   * **THE FAN-OUT, WHICH IS THE REAL HAZARD AND IS ONE JOIN AWAY.**
   *
   * `listMeetings` matches a contact filter against `meetings.contact_id` OR an
   * attendee row for that contact, and it spells that as an EXISTS. Written as a
   * JOIN to `meeting_attendees` instead -- which is the obvious way and reads
   * identically -- a meeting with three attendees becomes three rows and its
   * duration is summed three times. Nothing about the resulting number looks
   * wrong. This is the test that would go red, and it is here now rather than
   * when Task 4 adds the record filters this report does not yet have.
   */
  it("counts a meeting once however many attendees it had", async () => {
    const one = await createContact(handle.db, actorId, { firstName: "Ada", lastName: "L" });
    const two = await createContact(handle.db, actorId, { firstName: "Bea", lastName: "M" });
    await meeting("2026-09-08T09:00:00.000Z", 60, {
      attendees: [
        { kind: "contact", contactId: one.id },
        { kind: "contact", contactId: two.id },
        { kind: "user", userId: actorId },
        { kind: "guest", guestName: "their lawyer" },
      ],
    });
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsInRange).toBe(1);
  });

  /** The other fan-out: a meeting legitimately carries a company AND the deal it
   * came from AND the project, because meetings_has_link is at-least-one and not
   * exactly-one. Summed over its links rather than over itself it would count
   * three times. */
  it("counts a meeting once however many records it is linked to", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Ada", lastName: "L" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Rollout", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }, "EUR",
    );
    await meeting("2026-09-08T09:00:00.000Z", 60, {
      companyId: company.id, contactId: contact.id, dealId: deal.id,
    });
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsInRange).toBe(1);
  });

  /**
   * **ARCHIVING IS HOW AN HOUR COMES BACK OUT OF A TOTAL, ON BOTH SIDES OF THE
   * SUM, AND ON THE MEETING SIDE THAT IS PART OF THE ANTI-DOUBLE-COUNT RULE
   * RATHER THAN MERE TIDINESS.** The correction an operator makes to a meeting
   * whose length was wrong is to archive it and log the hour by hand; if an
   * archived meeting still contributed, that correction would be exactly the
   * double count this task exists to make impossible, arriving by the one door
   * left open.
   */
  it("drops an archived meeting and an archived entry out of every bucket", async () => {
    const kept = await meeting("2026-09-08T09:00:00.000Z", 60);
    const filed = await meeting("2026-09-08T14:00:00.000Z", 90);
    const keptEntry = await entry("2026-09-08", 30);
    const filedEntry = await entry("2026-09-08", 45);
    await archiveMeeting(handle.db, actorId, filed);
    await archiveTimeEntry(handle.db, actorId, filedEntry);

    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsCounted).toBe(1);
    // Not merely uncounted: an archived meeting is not IN the range at all, so it
    // is not reported as an uncountable one either. It has been filed away, which
    // is a different fact from "nobody recorded how long it ran".
    expect(totals.meetingsInRange).toBe(1);
    expect(totals.meetingsUnmeasured).toBe(0);
    expect(totals.entryMinutes).toBe(30);
    expect(totals.entryCount).toBe(1);
    expect(kept).not.toBe(filed);
    expect(keptEntry).not.toBe(filedEntry);
  });

  /**
   * THE TWO WAYS AN HOUR LEAVES THE TOTAL ARE NOT THE SAME ACT, and the
   * difference is what the operator sees. Clearing a meeting's duration moves it
   * into `meetingsUnmeasured`, where the sentence names it; archiving it removes
   * it from the report entirely. The first is "I do not know how long that was",
   * the second is "that should not be in my week".
   */
  it("moves a meeting whose duration is cleared into the visible bucket, not out of sight", async () => {
    const id = await meeting("2026-09-08T09:00:00.000Z", 60);
    expect((await timesheetTotals(handle.db, WEEK, {}, NOW)).meetingMinutes).toBe(60);

    await updateMeeting(handle.db, actorId, id, { durationMinutes: null });
    const cleared = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(cleared.meetingMinutes).toBe(0);
    expect(cleared.meetingsUnmeasured).toBe(1);
    expect(cleared.meetingsInRange).toBe(1);

    await archiveMeeting(handle.db, actorId, id);
    const filed = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(filed.meetingsInRange).toBe(0);
    expect(filed.meetingsUnmeasured).toBe(0);
  });

  /**
   * A FOLLOW-UP TASK IS DIFFERENT WORK FROM THE MEETING THAT PRODUCED IT, so an
   * hour booked against it is a second hour and not the same one twice. This is
   * the one indirect link that genuinely exists between the two halves of the sum
   * -- `events.meeting_id` on the task's `created` row -- and it is not a route to
   * a double count. Written down as a reading rather than left for somebody to
   * "fix" later by excluding such tasks.
   */
  it("counts an hour booked against a task the meeting produced as its own hour", async () => {
    const meetingId = await meeting("2026-09-08T09:00:00.000Z", 60);
    const task = await createMeetingTask(handle.db, actorId, meetingId, {
      title: "Send the summary", projectId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-09", minutes: 25, billable: true, taskId: task.id,
    });
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.entryMinutes).toBe(25);
    expect(totals.countedMinutes).toBe(85);
  });
});

/**
 * **WHICH CALENDAR DAY A MEETING FELL ON, WHICH IS A QUESTION THE SPEC AND THE
 * PLAN NEVER ASK.**
 *
 * `work_date` is a day and `occurred_at` is an instant, so summing the two into
 * one week means choosing a clock. It is the organisation's -- `org_profile
 * .time_zone`, the field 0018 added for exactly this class of question -- and the
 * consequence is that the same stored meeting lands in different weeks for
 * different installs, which is correct: the operator recorded a wall clock.
 */
describe("timesheetTotals: the day a meeting belongs to", () => {
  const SUNDAY_LATE = "2026-09-06T22:30:00.000Z";

  it("puts a late Sunday evening meeting in the week the operator's clock says", async () => {
    await meeting(SUNDAY_LATE, 60);

    // In UTC that instant is 22:30 on Sunday the SIXTH -- the week before.
    await setOrgTimeZone("UTC");
    const utc = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(utc.timeZone).toBe("UTC");
    expect(utc.meetingsInRange).toBe(0);

    // In Amsterdam it is 00:30 on Monday the SEVENTH, so it belongs to this week.
    await setOrgTimeZone("Europe/Amsterdam");
    const ams = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(ams.timeZone).toBe("Europe/Amsterdam");
    expect(ams.meetingsInRange).toBe(1);
    expect(ams.meetingMinutes).toBe(60);
  });

  /** The other end of the same boundary: nothing may fall through the gap between
   * one week and the next, and nothing may be in both. The two weeks either side
   * are queried with the same clock and the meeting appears in exactly one. */
  it("puts a boundary meeting in one week and one week only", async () => {
    await setOrgTimeZone("Europe/Amsterdam");
    await meeting(SUNDAY_LATE, 60);
    const previous = await timesheetTotals(
      handle.db, { from: "2026-08-31", to: "2026-09-06" }, {}, NOW,
    );
    const current = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(previous.meetingsInRange + current.meetingsInRange).toBe(1);
    expect(current.meetingsInRange).toBe(1);
  });

  /**
   * **THE BOUNDARY INSTANT ITSELF, WHICH IS WHERE A DOUBLE COUNT ACTUALLY FITS
   * -- AND THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.** Turning
   * the meetings query's `occurred_at < endExclusive` into `<=` was green across
   * every other case in this file: a meeting at 00:30 local is comfortably
   * inside one week and no assertion could tell the two spellings apart. A
   * meeting at EXACTLY midnight belongs to the later week and to that week only,
   * and under `<=` it is counted in both -- the same hour twice, arriving through
   * the one door the missing `meeting_id` column does not close.
   *
   * The two instants are written out rather than computed, and they are the ones
   * `zonedDayRange`'s own tests assert literally: this test must fail if the
   * boundary MOVES, not merely if the query and the helper agree about a boundary
   * that has drifted.
   */
  it("counts a meeting on the stroke of midnight in the later week only", async () => {
    await setOrgTimeZone("Europe/Amsterdam");
    // Monday the 7th begins at 22:00Z on the 6th; Monday the 14th at 22:00Z on
    // the 13th. One meeting at each instant.
    await meeting("2026-09-06T22:00:00.000Z", 30);
    await meeting("2026-09-13T22:00:00.000Z", 45);

    const previous = await timesheetTotals(handle.db, { from: "2026-08-31", to: "2026-09-06" }, {}, NOW);
    const current = await timesheetTotals(handle.db, WEEK, {}, NOW);
    const next = await timesheetTotals(
      handle.db, { from: "2026-09-14", to: "2026-09-20" }, {}, new Date("2026-09-21T12:00:00.000Z"),
    );

    // The first instant of the week is IN it; the first instant of the next week
    // is not.
    expect(current.meetingsInRange).toBe(1);
    expect(current.meetingMinutes).toBe(30);
    expect(previous.meetingsInRange).toBe(0);
    expect(next.meetingsInRange).toBe(1);
    expect(next.meetingMinutes).toBe(45);
    // And neither meeting is in two weeks at once.
    expect(previous.meetingsInRange + current.meetingsInRange + next.meetingsInRange).toBe(2);
  });

  /**
   * A DAY IS NOT ALWAYS 24 HOURS. Europe/Amsterdam's 25 October 2026 has 25 of
   * them, so a range whose upper bound was computed by adding milliseconds would
   * miss the last hour of it -- an hour of meetings dropped, twice a year, in one
   * direction, silently. The meeting here is at 23:30 local on that long day.
   */
  it("reaches the end of a day that has an extra hour in it", async () => {
    await setOrgTimeZone("Europe/Amsterdam");
    // 2026-10-25T22:30Z is 23:30 local, after the clocks went back.
    await meeting("2026-10-25T22:30:00.000Z", 45);
    const totals = await timesheetTotals(
      handle.db, { from: "2026-10-19", to: "2026-10-25" }, {}, new Date("2026-10-26T09:00:00.000Z"),
    );
    expect(totals.meetingsInRange).toBe(1);
    expect(totals.meetingMinutes).toBe(45);
  });

  /**
   * `usableTimeZone`'s fallback, and the payload NAMES the zone it used --
   * `formatDocumentInstant`'s rule. A report that quietly fell back to UTC and
   * did not say so is the failure that rule exists for. The stored string is left
   * alone; Settings is the one page that shows it as it is, so the one page that
   * can fix it does not show UTC over the evidence.
   */
  it("falls back to UTC when the stored zone no longer resolves, and says that it did", async () => {
    await setOrgTimeZone("Factory");
    await meeting(SUNDAY_LATE, 60);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.timeZone).toBe("UTC");
    expect(totals.meetingsInRange).toBe(0);
  });

  /** A truncated database has no org_profile row at all, which is the state of an
   * install that has never opened Settings. It must answer, not throw. */
  it("uses UTC when nobody has ever opened Settings", async () => {
    await meeting("2026-09-08T09:00:00.000Z", 60);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.timeZone).toBe("UTC");
    expect(totals.meetingMinutes).toBe(60);
  });
});

describe("timesheetTotals: the shape it answers with", () => {
  it("answers something the wire schema accepts, invariants and all", async () => {
    await entry("2026-09-08", 120);
    await meeting("2026-09-08T09:00:00.000Z", 45);
    await meeting("2026-09-08T14:00:00.000Z", null);
    await meeting("2026-09-11T09:00:00.000Z", 30);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    // The refines are the guarantee: a total that is not its own halves, or
    // meeting buckets that do not account for the range, fail here.
    expect(timesheetTotalsSchema.parse(totals)).toEqual(totals);
    expect(totals.from).toBe(WEEK.from);
    expect(totals.to).toBe(WEEK.to);
  });

  /** The range is validated where the boundary is computed (`zonedDayRange`), so
   * an inverted range is refused rather than answered with an empty week that
   * looks exactly like an honest one. */
  it("refuses a range that runs backwards", async () => {
    await expect(timesheetTotals(handle.db, { from: "2026-09-13", to: "2026-09-07" }, {}, NOW))
      .rejects.toThrow(/runs backwards/);
  });

  it("refuses a range that is not made of calendar days", async () => {
    await expect(timesheetTotals(handle.db, { from: "2026-09", to: "2026-09-13" }, {}, NOW))
      .rejects.toThrow(/calendar day/);
  });
});

/* ========================================================================== *
 *  PHASE 10 TASK 4: THE BILLABLE SPLIT, THE RECORD FILTERS, AND THE ROWS
 * ========================================================================== */

/**
 * **THE FLAG THE OPERATOR IS MADE TO ANSWER ON EVERY ENTRY, READ BACK AT LAST.**
 *
 * `time_entries.billable` has had no default since Task 1 -- so nothing decides
 * it on the operator's behalf -- and until this task nothing in the product could
 * read it: the spec says billable time here "feeds reporting and export, not
 * billing", and with no report it was a write-only column.
 */
describe("timesheetTotals: the billable split", () => {
  it("splits the hand-entered half, and counts the same entries it sums", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 120, billable: true, projectId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-09", minutes: 30, billable: true, projectId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-09", minutes: 45, billable: false, projectId,
    });
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.entryMinutes).toBe(195);
    expect(totals.entryCount).toBe(3);
    expect(totals.billableEntryMinutes).toBe(150);
    expect(totals.billableEntryCount).toBe(2);
    // The refines hold the split against the thing it splits.
    expect(timesheetTotalsSchema.parse(totals)).toEqual(totals);
  });

  /**
   * **A MEETING'S MINUTES ARE IN NEITHER HALF, AND THAT IS THE SENTENCE'S JOB TO
   * SAY.** `meetings` has no billable column, so counting them as non-billable
   * would be a claim nobody made -- the same failure as counting an unmeasured
   * meeting as zero. Here the arithmetic proves it: countedMinutes is 210, the
   * billable figure is 120, and 210 - 120 is not the non-billable time.
   */
  it("leaves meetings out of both halves of the split", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 120, billable: true, projectId,
    });
    await meeting("2026-09-08T09:00:00.000Z", 90);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.countedMinutes).toBe(210);
    expect(totals.billableEntryMinutes).toBe(120);
    expect(totals.entryMinutes).toBe(120);
    expect(timesheetBillableSummary(totals)).toContain("Meetings carry no billable flag");
    expect(timesheetBillableSummary(totals)).toContain("1h 30m from meetings");
  });

  it("answers a week with nothing billable in it with nought, not with nothing", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: false, projectId,
    });
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.billableEntryMinutes).toBe(0);
    expect(totals.billableEntryCount).toBe(0);
    expect(typeof totals.billableEntryMinutes).toBe("number");
    expect(typeof totals.billableEntryCount).toBe("number");
  });

  /** ARCHIVING IS HOW AN HOUR LEAVES A TOTAL, and it has to leave the split too
   * -- otherwise the correction for a mis-booked billable afternoon works
   * everywhere except on the one figure somebody would invoice from. */
  it("drops an archived entry out of the billable half as well as the whole", async () => {
    const id = await entry("2026-09-08", 120);
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 30, billable: false, projectId,
    });
    await archiveTimeEntry(handle.db, actorId, id);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.entryMinutes).toBe(30);
    expect(totals.billableEntryMinutes).toBe(0);
    expect(totals.billableEntryCount).toBe(0);
  });
});

/**
 * **NARROWING THE WEEK TO ONE RECORD, ON BOTH HALVES AT ONCE.**
 *
 * The filter that reached only the entries would answer "this project's week"
 * with the project's hours plus everybody's meetings -- a total belonging to no
 * record at all, and wrong in the direction that makes a project look busier
 * than it is.
 */
describe("timesheetTotals: the record filters", () => {
  let otherProjectId: string;
  let companyId: string;
  let contactId: string;

  beforeEach(async () => {
    otherProjectId = (await createProject(handle.db, actorId, { name: "Something else" })).id;
    companyId = (await createCompany(handle.db, actorId, { name: "Acme" })).id;
    contactId = (await createContact(handle.db, actorId, { firstName: "Ada", lastName: "Byron" })).id;
  });

  it("narrows the entries AND the meetings to the same record", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 120, billable: true, projectId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true, projectId: otherProjectId,
    });
    await meeting("2026-09-08T09:00:00.000Z", 30);
    await createMeeting(handle.db, actorId, {
      title: "Elsewhere", occurredAt: "2026-09-08T11:00:00.000Z", durationMinutes: 90,
      projectId: otherProjectId,
    });

    const all = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(all.countedMinutes).toBe(300);

    const mine = await timesheetTotals(handle.db, WEEK, { projectId }, NOW);
    expect(mine.entryMinutes).toBe(120);
    // THE HALF A FILTER ON ONE SIDE ONLY WOULD GET WRONG: 120 in the meetings
    // half rather than 30 is exactly what "narrowed the entries, left the
    // meetings" produces.
    expect(mine.meetingMinutes).toBe(30);
    expect(mine.meetingsInRange).toBe(1);
    expect(mine.countedMinutes).toBe(150);
    expect(timesheetTotalsSchema.parse(mine)).toEqual(mine);
  });

  it("filters by company and by deal as well", async () => {
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Renewal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR",
    );
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 45, billable: true, companyId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 25, billable: true, dealId: deal.id,
    });
    await createMeeting(handle.db, actorId, {
      title: "Acme", occurredAt: "2026-09-08T09:00:00.000Z", durationMinutes: 15, companyId,
    });

    const byCompany = await timesheetTotals(handle.db, WEEK, { companyId }, NOW);
    expect(byCompany.countedMinutes).toBe(60);
    const byDeal = await timesheetTotals(handle.db, WEEK, { dealId: deal.id }, NOW);
    expect(byDeal.entryMinutes).toBe(25);
    expect(byDeal.meetingMinutes).toBe(0);
    expect(byDeal.countedMinutes).toBe(25);
  });

  /**
   * **THE CONTACT FILTER WIDENS TO ATTENDANCE ON THE MEETINGS SIDE, AND THAT IS
   * `listMeetings`' RULE RATHER THAN A NEW ONE.** "This contact's week" has to
   * mean the same thing here as it does on their own Meetings tab: an hour in a
   * meeting they attended is an hour spent with them, whether or not they are the
   * row's `contact_id`. Time entries have no attendee table and their arm does
   * not pretend to widen.
   */
  it("reaches a meeting the contact merely attended", async () => {
    await createMeeting(handle.db, actorId, {
      title: "Attended", occurredAt: "2026-09-08T09:00:00.000Z", durationMinutes: 40,
      projectId, attendees: [{ contactId }],
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 20, billable: true, contactId,
    });
    const totals = await timesheetTotals(handle.db, WEEK, { contactId }, NOW);
    expect(totals.meetingMinutes).toBe(40);
    expect(totals.entryMinutes).toBe(20);
  });

  /**
   * **AND IT COUNTS THAT MEETING ONCE, HOWEVER MANY ATTENDEES IT HAD.** This is
   * the hazard Task 2 wrote down for Task 4 by name: as a `leftJoin` to
   * `meeting_attendees` the widening reads identically and turns one meeting into
   * three rows whose duration is summed three times. Nothing about the resulting
   * number looks wrong -- which is why the filter is an EXISTS and why this test
   * exists at all.
   */
  it("counts a filtered meeting once however many attendees it had", async () => {
    const second = (await createContact(handle.db, actorId, { firstName: "Grace" })).id;
    const third = (await createContact(handle.db, actorId, { firstName: "Alan" })).id;
    await createMeeting(handle.db, actorId, {
      title: "Three of them", occurredAt: "2026-09-08T09:00:00.000Z", durationMinutes: 60,
      projectId,
      attendees: [{ contactId }, { contactId: second }, { contactId: third }],
    });
    const totals = await timesheetTotals(handle.db, WEEK, { contactId }, NOW);
    expect(totals.meetingMinutes).toBe(60);
    expect(totals.meetingsCounted).toBe(1);
    expect(totals.meetingsInRange).toBe(1);
  });

  it("answers a record with nothing on it with a whole empty week", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 120, billable: true, projectId,
    });
    const totals = await timesheetTotals(handle.db, WEEK, { projectId: otherProjectId }, NOW);
    expect(totals.countedMinutes).toBe(0);
    expect(totals.meetingsInRange).toBe(0);
    expect(timesheetTotalsSchema.parse(totals)).toEqual(totals);
  });
});

/**
 * **THE ROWS THE HEADLINE IS MADE OF.**
 *
 * `timesheetSummary` says "and 2h 30m across 3 meetings. Not counted: 2 meetings
 * with no recorded length" -- and an operator who cannot see WHICH two has been
 * handed an assertion rather than an answer. These tests are for the three
 * things that makes true:
 *
 *   1. Every row of the week is here, entries and meetings alike, on the
 *      organisation's calendar days, with every day of the range present.
 *   2. The list AGREES WITH THE AGGREGATE -- same population, same buckets, same
 *      minutes -- which is the property the whole surface rests on and the one a
 *      second implementation of "has this meeting started" would break.
 *   3. Nothing fans out. The joins that resolve record names are on primary keys
 *      and `meeting_attendees` is not among them.
 */
describe("timesheetDays: the week, row by row", () => {
  /** The counted minutes the list holds, added up over every day -- what the
   * headline must equal. Written here once so no test re-spells it. */
  function listedMinutes(week: Awaited<ReturnType<typeof timesheetDays>>): number {
    return week.days.reduce((total, day) => total + day.countedMinutes, 0);
  }

  it("gives every day of the range a section, including the empty ones", async () => {
    await entry("2026-09-08", 60);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    expect(week.days.map((day) => day.day)).toEqual([
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13",
    ]);
    // A week that omitted its quiet days would read as a week those days were
    // not in -- "where did the week go" is a question a blank Wednesday answers.
    expect(week.days.filter((day) => day.rows.length === 0)).toHaveLength(6);
    expect(timesheetWeekSchema.parse(week)).toEqual(week);
  });

  it("puts an entry and a meeting on their own days, with their own labels", async () => {
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-07", minutes: 90, billable: true, description: "Wrote the thing", projectId,
    });
    // Tuesday, i.e. BEFORE NOW: a meeting on Thursday would be in the future and
    // would come back not-yet-happened, which is a different test's subject.
    await meeting("2026-09-08T09:00:00.000Z", 45);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const monday = week.days.find((day) => day.day === "2026-09-07");
    const tuesday = week.days.find((day) => day.day === "2026-09-08");
    expect(monday?.rows).toMatchObject([{
      kind: "entry", minutes: 90, label: "Wrote the thing", billable: true,
      counted: true, uncountedReason: null,
    }]);
    expect(monday?.countedMinutes).toBe(90);
    expect(tuesday?.rows).toMatchObject([{
      kind: "meeting", minutes: 45, label: "Kickoff", billable: null,
      counted: true, uncountedReason: null,
    }]);
    expect(tuesday?.countedMinutes).toBe(45);
  });

  /**
   * **THE CROSS-CHECK, AND IT IS THE MOST LOAD-BEARING TEST IN THIS FILE.** The
   * aggregate decides "counted" in SQL and the list carries the same expressions
   * back as booleans; if the two ever stop agreeing, the page prints a figure
   * over a list that does not add up to it and nothing else in this suite would
   * notice. The seed deliberately contains one of everything: a counted meeting,
   * an unmeasured one, one that has not happened yet, an archived one, an
   * archived entry, and entries on both sides of the week's edges.
   */
  it("adds up to the aggregate, bucket for bucket", async () => {
    await entry("2026-09-07", 30);
    await entry("2026-09-13", 45);
    await entry("2026-09-09", 120);
    const archivedEntry = await entry("2026-09-09", 999);
    await archiveTimeEntry(handle.db, actorId, archivedEntry);
    // Outside the range on both sides.
    await entry("2026-09-06", 60);
    await entry("2026-09-14", 60);
    await meeting("2026-09-08T09:00:00.000Z", 60);
    await meeting("2026-09-08T15:00:00.000Z", null);
    await meeting("2026-09-11T09:00:00.000Z", 30);
    const archivedMeeting = await meeting("2026-09-09T09:00:00.000Z", 240);
    await archiveMeeting(handle.db, actorId, archivedMeeting);

    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const rows = week.days.flatMap((day) => day.rows);

    expect(listedMinutes(week)).toBe(totals.countedMinutes);
    expect(rows.filter((row) => row.kind === "entry")).toHaveLength(totals.entryCount);
    expect(rows.filter((row) => row.kind === "meeting")).toHaveLength(totals.meetingsInRange);
    expect(rows.filter((row) => row.kind === "meeting" && row.counted))
      .toHaveLength(totals.meetingsCounted);
    expect(rows.filter((row) => row.uncountedReason === "no-recorded-length"))
      .toHaveLength(totals.meetingsUnmeasured);
    expect(rows.filter((row) => row.uncountedReason === "not-yet-happened"))
      .toHaveLength(totals.meetingsNotYetOccurred);
    const entryMinutes = rows
      .filter((row) => row.kind === "entry")
      .reduce((total, row) => total + (row.minutes ?? 0), 0);
    expect(entryMinutes).toBe(totals.entryMinutes);
    // The seed is not vacuous: a week with nothing in it would satisfy every
    // assertion above.
    expect(totals.countedMinutes).toBeGreaterThan(0);
    expect(totals.meetingsInRange).toBe(3);
    expect(timesheetWeekSchema.parse(week)).toEqual(week);
  });

  /**
   * THE TWO MEETINGS THE SENTENCE NAMES, AS ROWS SOMEBODY CAN LOOK AT. An
   * unmeasured meeting carries `minutes: null` rather than 0 -- there is no such
   * thing as a zero-length meeting, and a 0 there would be the "unknown treated
   * as a claim" failure the spec names, arriving on the surface instead of in the
   * query.
   */
  it("says which meetings were not counted, and why, one row at a time", async () => {
    await meeting("2026-09-08T09:00:00.000Z", null);
    // NOW is Wednesday the 9th at 12:00Z; this is Friday.
    await meeting("2026-09-11T09:00:00.000Z", 60);
    // ...and a future meeting with no duration is NOT-YET rather than unmeasured:
    // its length is not yet a fact about anything.
    await meeting("2026-09-12T09:00:00.000Z", null);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const rows = week.days.flatMap((day) => day.rows);
    expect(rows.map((row) => [row.day, row.minutes, row.counted, row.uncountedReason])).toEqual([
      ["2026-09-08", null, false, "no-recorded-length"],
      ["2026-09-11", 60, false, "not-yet-happened"],
      ["2026-09-12", null, false, "not-yet-happened"],
    ]);
    expect(listedMinutes(week)).toBe(0);
  });

  /** A meeting that has started counts, and one starting exactly NOW has
   * started -- the aggregate's `<=`, read back through the same expression
   * rather than re-decided here. */
  it("treats a meeting starting exactly now as one that has happened", async () => {
    await meeting(NOW.toISOString(), 15);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const rows = week.days.flatMap((day) => day.rows);
    expect(rows).toMatchObject([{ counted: true, uncountedReason: null, minutes: 15 }]);
    expect(listedMinutes(week)).toBe(15);
  });

  it("leaves archived entries and archived meetings out of the list entirely", async () => {
    const e = await entry("2026-09-08", 60);
    const m = await meeting("2026-09-08T09:00:00.000Z", 60);
    await archiveTimeEntry(handle.db, actorId, e);
    await archiveMeeting(handle.db, actorId, m);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    expect(week.days.flatMap((day) => day.rows)).toEqual([]);
    expect(listedMinutes(week)).toBe(0);
  });

  /**
   * **THE ORGANISATION'S CLOCK DECIDES WHICH DAY -- AND WHICH WEEK -- A MEETING
   * FELL ON.** 2026-09-06T23:30Z is Sunday in UTC and Monday in Amsterdam. Under
   * UTC this meeting is not in the week at all; under Amsterdam it is Monday's
   * first row. A list that put it on the UTC day while the aggregate counted the
   * Amsterdam one would be a row on a day the week does not contain, which
   * `timesheetDays` throws over rather than dropping.
   */
  it("puts a meeting on the day the organisation's calendar has it", async () => {
    await setOrgTimeZone("Europe/Amsterdam");
    await meeting("2026-09-06T23:30:00.000Z", 60);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    expect(week.timeZone).toBe("Europe/Amsterdam");
    expect(week.days[0]?.day).toBe("2026-09-07");
    expect(week.days[0]?.rows).toHaveLength(1);
    expect(week.days[0]?.countedMinutes).toBe(60);
    expect(timesheetWeekSchema.parse(week)).toEqual(week);

    // The same instant, read in UTC, is not in this week at all.
    await setOrgTimeZone("UTC");
    const utc = await timesheetDays(handle.db, WEEK, {}, NOW);
    expect(utc.days.flatMap((day) => day.rows)).toEqual([]);
  });

  /**
   * **THE STROKE OF MIDNIGHT, ON THE LIST -- AND THIS TEST EXISTS BECAUSE THE
   * MUTATION SURVIVED WITHOUT IT.** Turning the day list's
   * `occurred_at < endExclusive` into `<=` was green across every other case in
   * this file, for the reason Task 2 recorded when the identical mutation
   * survived on the AGGREGATE: a meeting at 00:30 local is comfortably inside one
   * week and no assertion can tell the two spellings apart. A meeting at exactly
   * the first instant of the NEXT week belongs to that week and to that week only,
   * and under `<=` it is listed in both -- so the same hour appears twice on the
   * one surface built to let an operator check the figure.
   *
   * The instants are written out rather than computed, and they are the ones
   * `zonedDayRange`'s own tests assert literally: this must fail if the boundary
   * MOVES, not merely if the query and the helper agree about a boundary that has
   * drifted.
   */
  it("lists a meeting on the stroke of midnight in the later week only", async () => {
    await setOrgTimeZone("Europe/Amsterdam");
    // Monday the 7th begins at 22:00Z on the 6th; Monday the 14th at 22:00Z on
    // the 13th. One meeting at each instant.
    await meeting("2026-09-06T22:00:00.000Z", 30);
    await meeting("2026-09-13T22:00:00.000Z", 45);

    const current = await timesheetDays(handle.db, WEEK, {}, NOW);
    const next = await timesheetDays(
      handle.db, { from: "2026-09-14", to: "2026-09-20" }, {},
      new Date("2026-09-21T12:00:00.000Z"),
    );

    // The first instant of the week is IN it; the first instant of the NEXT week
    // is not.
    expect(current.days.flatMap((day) => day.rows).map((row) => [row.day, row.minutes]))
      .toEqual([["2026-09-07", 30]]);
    expect(next.days.flatMap((day) => day.rows).map((row) => [row.day, row.minutes]))
      .toEqual([["2026-09-14", 45]]);
    // ...and neither meeting is in two weeks at once.
    expect(listedMinutes(current) + listedMinutes(next)).toBe(75);
  });

  /**
   * THE RECORD NAMES COME WITH THE ROWS, INCLUDING AN ARCHIVED RECORD'S. An
   * entry may legitimately name a project that has since been completed
   * (services/time-entries.ts's "existence, not activeness" rule), and a page
   * resolving names from its own lists would render that row with nothing on it.
   */
  it("carries a readable name for every record a row names", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Ada", lastName: "Byron" });
    const task = await createTask(handle.db, actorId, { title: "Ship it", projectId });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true,
      companyId: company.id, contactId: contact.id, projectId, taskId: task.id,
    });
    await archiveTask(handle.db, actorId, task.id);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const [row] = week.days.flatMap((day) => day.rows);
    expect(row?.links).toEqual([
      { kind: "company", id: company.id, label: "Acme" },
      { kind: "contact", id: contact.id, label: "Ada Byron" },
      { kind: "project", id: projectId, label: "Rollout" },
      // Archived, and still named: the drawer opens on it and the hour is real.
      { kind: "task", id: task.id, label: "Ship it" },
    ]);
  });

  /** A MEETING WITH THREE ATTENDEES IS ONE ROW. The joins that resolve names are
   * on primary keys and cannot fan out; `meeting_attendees` is not joined at all,
   * here or in the aggregate. A row appearing three times would treble the day's
   * figure as surely as it would the week's. */
  it("lists a meeting once however many attendees it had", async () => {
    const one = (await createContact(handle.db, actorId, { firstName: "Ada" })).id;
    const two = (await createContact(handle.db, actorId, { firstName: "Grace" })).id;
    const three = (await createContact(handle.db, actorId, { firstName: "Alan" })).id;
    await createMeeting(handle.db, actorId, {
      title: "Three of them", occurredAt: "2026-09-08T09:00:00.000Z", durationMinutes: 60,
      projectId, attendees: [{ contactId: one }, { contactId: two }, { contactId: three }],
    });
    const week = await timesheetDays(handle.db, WEEK, { contactId: one }, NOW);
    expect(week.days.flatMap((day) => day.rows)).toHaveLength(1);
    expect(listedMinutes(week)).toBe(60);
  });

  it("narrows to a record on both halves, exactly as the aggregate does", async () => {
    const other = (await createProject(handle.db, actorId, { name: "Something else" })).id;
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 120, billable: true, projectId,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true, projectId: other,
    });
    await meeting("2026-09-08T09:00:00.000Z", 30);
    await createMeeting(handle.db, actorId, {
      title: "Elsewhere", occurredAt: "2026-09-08T11:00:00.000Z", durationMinutes: 90,
      projectId: other,
    });
    const week = await timesheetDays(handle.db, WEEK, { projectId }, NOW);
    const totals = await timesheetTotals(handle.db, WEEK, { projectId }, NOW);
    expect(week.days.flatMap((day) => day.rows)).toHaveLength(2);
    expect(listedMinutes(week)).toBe(totals.countedMinutes);
    expect(listedMinutes(week)).toBe(150);
  });

  /**
   * **101 ENTRIES IN ONE WEEK, WHICH IS THE PLAN'S OWN EXAMPLE.** `listTimeEntries`
   * caps at 100, so a page built over that list would show a hundred rows and a
   * total short by one entry. This list has no cap -- the ROUTE bounds the span
   * instead -- so the rows and the aggregate still agree past the page size that
   * would have broken them.
   */
  it("lists every entry of the week, past the page size the entries list stops at", async () => {
    for (let n = 0; n < 101; n += 1) await entry("2026-09-08", 1);
    const page = await listTimeEntries(handle.db, { from: WEEK.from, to: WEEK.to, limit: 500 });
    expect(page.items).toHaveLength(100);
    const week = await timesheetDays(handle.db, WEEK, {}, NOW);
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(week.days.flatMap((day) => day.rows)).toHaveLength(101);
    expect(listedMinutes(week)).toBe(101);
    expect(listedMinutes(week)).toBe(totals.countedMinutes);
  });

  it("refuses a backwards range and a day that is not one, exactly as the aggregate does", async () => {
    await expect(timesheetDays(handle.db, { from: "2026-09-13", to: "2026-09-07" }, {}, NOW))
      .rejects.toThrow(/runs backwards/);
    await expect(timesheetDays(handle.db, { from: "2026-02-30", to: "2026-09-13" }, {}, NOW))
      .rejects.toThrow(/calendar day/);
  });
});

/**
 * **PHASE 10 TASK 3: BOOKED VERSUS ESTIMATED, FOR ONE TASK.**
 *
 * The spec's second reading of `schema.ts` was that `tasks` carries no quantity
 * of work -- "dates and a percentage, never a quantity" -- and that this
 * comparison could not exist until a column did. `tasks.estimate_minutes` (0022)
 * is that column; `taskEffort` is the whole of the reading over it.
 *
 * WHAT THESE ARE FOR, in the order the task states them:
 *
 *   1. The estimate and the booked total come back together, in the unit they
 *      are compared in, out of ONE aggregate rather than two agreeing queries.
 *   2. An hour that has left a total has left this one: an archived entry is not
 *      booked, and archiving is the only way an hour leaves anything in this
 *      phase.
 *   3. An estimate on a task nobody has started counts in full, and an estimate
 *      never reaches the week's total at all.
 */
describe("taskEffort: booked versus estimated", () => {
  async function task(extra: Record<string, unknown> = {}): Promise<string> {
    return (await createTask(handle.db, actorId, { title: "Draft the plan", ...extra })).id;
  }
  async function bookedTo(taskId: string, minutes: number, workDate = "2026-09-08"): Promise<string> {
    return (await createTimeEntry(handle.db, actorId, {
      workDate, minutes, billable: true, taskId,
    })).id;
  }

  it("answers the estimate and the hours booked against it, in the same unit", async () => {
    const id = await task({ estimateMinutes: 240 });
    await bookedTo(id, 60);
    await bookedTo(id, 30, "2026-09-09");

    const effort = await taskEffort(handle.db, id);
    expect(effort).toEqual({
      taskId: id, estimateMinutes: 240, bookedMinutes: 90, entryCount: 2,
    });
    // The refine is the guarantee that the sum and the count came out of one
    // population; the sentence is what a surface renders.
    expect(taskEffortSchema.parse(effort)).toEqual(effort);
    expect(taskEffortSummary(effort))
      .toBe("1h 30m booked across 2 entries, against an estimate of 4h: 2h 30m left.");
  });

  /**
   * **NUMBERS, NOT THE STRINGS POSTGRES WOULD OTHERWISE HAND BACK** --
   * `timesheetTotals`' `::int` argument, at a second aggregate. Uncast,
   * `bookedMinutes` is the string "90", and `taskEffortSchema` would be the only
   * thing between it and a page that concatenated it into a comparison.
   */
  it("answers numbers, so a comparison is arithmetic and not string concatenation", async () => {
    const id = await task({ estimateMinutes: 240 });
    await bookedTo(id, 90);
    const effort = await taskEffort(handle.db, id);
    expect(typeof effort.bookedMinutes).toBe("number");
    expect(typeof effort.entryCount).toBe("number");
    expect(effort.bookedMinutes + 1).toBe(91);
  });

  it("answers nought for a task with no entries, not an absent figure", async () => {
    const effort = await taskEffort(handle.db, await task());
    expect(effort.bookedMinutes).toBe(0);
    expect(effort.entryCount).toBe(0);
    expect(effort.estimateMinutes).toBeNull();
  });

  /**
   * **AN ARCHIVED ENTRY IS AN HOUR WITHDRAWN.** It cannot be corrected to nothing
   * -- `time_entries_minutes_range` forbids zero -- so archiving is the only way
   * a mis-booked afternoon leaves a total. If it still counted here, the
   * correction would work on the timesheet and silently fail on this reading.
   */
  it("drops an archived entry out of the booked total, and out of its count", async () => {
    const id = await task({ estimateMinutes: 240 });
    await bookedTo(id, 60);
    await archiveTimeEntry(handle.db, actorId, await bookedTo(id, 120));

    const effort = await taskEffort(handle.db, id);
    expect(effort.bookedMinutes).toBe(60);
    expect(effort.entryCount).toBe(1);
  });

  /**
   * **AN ENTRY BOOKED SOMEWHERE ELSE IS NOT BOOKED HERE**, which is the filter
   * this whole reading is, and the failure it would have is silent: a missing
   * `task_id` predicate answers every task with the same number and every one of
   * them looks plausible.
   */
  it("counts only the entries booked to this task", async () => {
    const mine = await task({ estimateMinutes: 240 });
    const theirs = await task();
    await bookedTo(mine, 60);
    await bookedTo(theirs, 300);
    // And an entry attached to the project but to no task at all: legal (the
    // link rule is at-least-one of five), and not this task's.
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 480, billable: true, projectId,
    });

    expect((await taskEffort(handle.db, mine)).bookedMinutes).toBe(60);
    expect((await taskEffort(handle.db, theirs)).bookedMinutes).toBe(300);
  });

  /**
   * **NO MEETING MINUTE REACHES A TASK'S BOOKED TOTAL**, and the schema is what
   * guarantees it: `meetings` has no `task_id`. This is the reading that proves
   * the guarantee holds through the one link that DOES exist between the two
   * halves -- a meeting's follow-up task. Task 2 settled that an hour booked
   * against a follow-up task is different work rather than a second copy of the
   * meeting's hour; here that is a number rather than a paragraph.
   */
  it("counts a follow-up task's own hours and none of the meeting's", async () => {
    const meetingId = await meeting("2026-09-08T09:00:00.000Z", 90);
    const followUp = await createMeetingTask(
      handle.db, actorId, meetingId, { title: "Send the summary" },
    );
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 30, billable: true, taskId: followUp.id,
    });

    const effort = await taskEffort(handle.db, followUp.id);
    expect(effort.bookedMinutes).toBe(30);
    expect(effort.entryCount).toBe(1);
    // The meeting's own 90 minutes are in the WEEK, and in neither of the two
    // numbers above -- which is the whole shape of "counted once".
    const totals = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(totals.meetingMinutes).toBe(90);
    expect(totals.entryMinutes).toBe(30);
    expect(totals.countedMinutes).toBe(120);
  });

  /**
   * **AN ESTIMATE ON A TASK NOBODY HAS STARTED COUNTS IN FULL, AND THIS IS THE
   * TEST THAT SAYS SO.** The task below is `todo`, undated, unprogressed and has
   * no entries -- and it still reports its four hours. Task 2 excluded meetings
   * that have not happened because the timesheet sums time that HAPPENED; an
   * estimate never claims anything happened, so there is no bucket for it and no
   * question of whether the work has begun. Dropping it would make the estimated
   * side SHRINK as work went undone.
   */
  it("reports the estimate of a task nobody has started, in full", async () => {
    const id = await task({ estimateMinutes: 240 });
    const effort = await taskEffort(handle.db, id);
    expect(effort.estimateMinutes).toBe(240);
    expect(effort.bookedMinutes).toBe(0);
    expect(taskEffortSummary(effort))
      .toBe("No time booked yet, against an estimate of 4h: 4h left.");
  });

  /**
   * **AND AN ESTIMATE NEVER REACHES THE WEEK'S TOTAL.** `countedMinutes` is time
   * that happened; an estimate is time that is expected to. Nothing in
   * `timesheetTotals` reads `tasks` at all, and this is the test that would go
   * red the day somebody "improved" it by adding estimates in -- which would
   * answer "where did the week go" with work nobody has done.
   */
  it("changes no week's total, however large the estimate", async () => {
    const before = await timesheetTotals(handle.db, WEEK, {}, NOW);
    const id = await task({ estimateMinutes: 525600 });
    const after = await timesheetTotals(handle.db, WEEK, {}, NOW);
    expect(after).toEqual(before);
    expect(after.countedMinutes).toBe(0);

    // And once an hour IS booked to it, the week counts the HOUR and not the
    // estimate: 60, never 525660.
    await bookedTo(id, 60);
    expect((await timesheetTotals(handle.db, WEEK, {}, NOW)).countedMinutes).toBe(60);
  });

  /**
   * AN ARCHIVED TASK STILL ANSWERS, unlike an archived entry, and the asymmetry
   * is deliberate: the drawer opens on an archived task, and the hours booked to
   * it are exactly what somebody looking at one wants accounted for.
   */
  it("answers for an archived task, because that is what its drawer is asking", async () => {
    const id = await task({ estimateMinutes: 240 });
    await bookedTo(id, 60);
    await archiveTask(handle.db, actorId, id);

    const effort = await taskEffort(handle.db, id);
    expect(effort.bookedMinutes).toBe(60);
    expect(effort.estimateMinutes).toBe(240);
  });

  /** A task that does not exist is a 404 rather than an honest-looking zero --
   * which is what a bare aggregate over `time_entries` would answer. */
  it("refuses a task id that does not exist, rather than answering nothing booked", async () => {
    await expect(taskEffort(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .rejects.toThrow(NotFoundError);
  });

  /**
   * **SUMMED IN SQL, NOT OVER A PAGE.** `listTimeEntries` caps at 100 rows, so a
   * JavaScript sum over a page is right until somebody books 101 entries to one
   * task and is then silently SHORT -- this phase's own failure mode, arriving
   * through the comparison the phase exists to make possible.
   */
  it("sums every entry on the task, past any page size the list would answer with", async () => {
    const id = await task({ estimateMinutes: 525600 });
    for (let i = 0; i < 101; i += 1) await bookedTo(id, 1);

    const listed = await listTimeEntries(handle.db, { taskId: id, limit: 500 });
    expect(listed.items.length).toBeLessThanOrEqual(100);

    const effort = await taskEffort(handle.db, id);
    expect(effort.entryCount).toBe(101);
    expect(effort.bookedMinutes).toBe(101);
  });
});
