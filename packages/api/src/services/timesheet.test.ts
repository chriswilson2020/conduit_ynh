import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  taskEffortSchema, taskEffortSummary, timesheetSummary, timesheetTotalsSchema,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { taskEffort, timesheetTotals } from "./timesheet.js";
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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

    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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

    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    expect((await timesheetTotals(handle.db, WEEK, NOW)).meetingMinutes).toBe(60);

    await updateMeeting(handle.db, actorId, id, { durationMinutes: null });
    const cleared = await timesheetTotals(handle.db, WEEK, NOW);
    expect(cleared.meetingMinutes).toBe(0);
    expect(cleared.meetingsUnmeasured).toBe(1);
    expect(cleared.meetingsInRange).toBe(1);

    await archiveMeeting(handle.db, actorId, id);
    const filed = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const utc = await timesheetTotals(handle.db, WEEK, NOW);
    expect(utc.timeZone).toBe("UTC");
    expect(utc.meetingsInRange).toBe(0);

    // In Amsterdam it is 00:30 on Monday the SEVENTH, so it belongs to this week.
    await setOrgTimeZone("Europe/Amsterdam");
    const ams = await timesheetTotals(handle.db, WEEK, NOW);
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
      handle.db, { from: "2026-08-31", to: "2026-09-06" }, NOW,
    );
    const current = await timesheetTotals(handle.db, WEEK, NOW);
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

    const previous = await timesheetTotals(handle.db, { from: "2026-08-31", to: "2026-09-06" }, NOW);
    const current = await timesheetTotals(handle.db, WEEK, NOW);
    const next = await timesheetTotals(
      handle.db, { from: "2026-09-14", to: "2026-09-20" }, new Date("2026-09-21T12:00:00.000Z"),
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
      handle.db, { from: "2026-10-19", to: "2026-10-25" }, new Date("2026-10-26T09:00:00.000Z"),
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
    expect(totals.timeZone).toBe("UTC");
    expect(totals.meetingsInRange).toBe(0);
  });

  /** A truncated database has no org_profile row at all, which is the state of an
   * install that has never opened Settings. It must answer, not throw. */
  it("uses UTC when nobody has ever opened Settings", async () => {
    await meeting("2026-09-08T09:00:00.000Z", 60);
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    await expect(timesheetTotals(handle.db, { from: "2026-09-13", to: "2026-09-07" }, NOW))
      .rejects.toThrow(/runs backwards/);
  });

  it("refuses a range that is not made of calendar days", async () => {
    await expect(timesheetTotals(handle.db, { from: "2026-09", to: "2026-09-13" }, NOW))
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
    const totals = await timesheetTotals(handle.db, WEEK, NOW);
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
    const before = await timesheetTotals(handle.db, WEEK, NOW);
    const id = await task({ estimateMinutes: 525600 });
    const after = await timesheetTotals(handle.db, WEEK, NOW);
    expect(after).toEqual(before);
    expect(after.countedMinutes).toBe(0);

    // And once an hour IS booked to it, the week counts the HOUR and not the
    // estimate: 60, never 525660.
    await bookedTo(id, 60);
    expect((await timesheetTotals(handle.db, WEEK, NOW)).countedMinutes).toBe(60);
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
