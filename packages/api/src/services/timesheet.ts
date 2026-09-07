import { and, eq, gte, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { calendarDaysBetween, usableTimeZone, zonedDayFormatter, zonedDayRange } from "@conduit/shared";
import type {
  TaskEffort, TimesheetDay, TimesheetFilters, TimesheetLink, TimesheetRow, TimesheetTotals,
  TimesheetWeek,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, meetingAttendees, meetings, projects, tasks, timeEntries,
} from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { getOrgProfile } from "./org-profile.js";

/**
 * **THE TIMESHEET'S READING LAYER (Phase 10 Task 2): MEETINGS COUNT, AND THE
 * SAME HOUR CANNOT BE COUNTED TWICE.**
 *
 * `meetings.duration_minutes` has held tracked time since Phase 5 and nothing
 * has ever aggregated it. Chris's third decision is that the timesheet reads
 * meetings and time entries TOGETHER and that a manual entry cannot be attached
 * to a meeting, so one hour has exactly one source. This is the half that reads;
 * Task 4 builds the page over it and computes none of this itself.
 *
 * ---
 *
 * **WHY THIS IS A THIRD MODULE AND NOT A FUNCTION IN time-entries.ts.** It reads
 * two tables and belongs to neither. Putting it in time-entries.ts would make
 * that file import `meetings`, and putting it in meetings.ts would make a Phase 5
 * file grow a Phase 10 report; either way the module's name would stop describing
 * what it holds. The absence of the sum from time-entries.ts is a note Task 1
 * left at the foot of that file, and this module is the answer to it -- that note
 * is now a pointer here rather than a warning about an unwritten function.
 *
 * ---
 *
 * **THE DOUBLE COUNT, AND WHERE IT COULD ACTUALLY COME FROM.**
 *
 * The direct route is not merely forbidden, it is unspellable: `time_entries` has
 * no `meeting_id` column, so an INSERT naming one fails to resolve against the
 * table (42703) rather than violating a constraint -- a refusal no `ALTER TABLE
 * ... DROP CONSTRAINT` can get around. Task 1 built it that way deliberately and
 * `db/schema.test.ts` pins it, together with the same INSERT WITHOUT that column
 * succeeding, so the failure is provably the column and not the row. **Adding the
 * column so that a CHECK could name it would trade impossible for illegal**,
 * which is the opposite of what the spec asks for; this task confirms that and
 * adds nothing.
 *
 * What is left is every INDIRECT route, and they are all in the shape of the
 * queries below:
 *
 *   **A JOIN THAT FANS A MEETING OUT.** This is the live hazard and it is one
 *   edit away. `listMeetings` widens its contact filter to "meetings.contact_id
 *   is C, OR an attendee row for C exists", and spells it as an EXISTS. As a JOIN
 *   to `meeting_attendees` -- which reads identically and is the obvious way --
 *   a meeting with three attendees becomes three rows and its duration is summed
 *   three times. The aggregate below therefore has NO JOIN AT ALL, and it must
 *   not grow one: Task 4 adds the record filters this report does not yet have,
 *   and if the contact filter needs attendance it belongs in an EXISTS in the
 *   WHERE, never in a FROM. A test holds this ("counts a meeting once however
 *   many attendees it had").
 *
 *   **A MEETING IN TWO BUCKETS.** Counted, unmeasured and not-yet-happened come
 *   out of ONE aggregate over one population, as three `FILTER` clauses built
 *   from one predicate, so they partition by construction rather than by three
 *   queries agreeing. `meetingsInRange` is the same query's `COUNT(*)`, and
 *   `timesheetTotalsSchema` refuses a payload where the three do not add up to
 *   it.
 *
 *   **AN ARCHIVED ROW STILL CONTRIBUTING**, on either side. This is not tidiness:
 *   archiving is the only way an hour leaves a total (an entry cannot be
 *   corrected to nothing, `time_entries_minutes_range` forbids zero), so the
 *   correction for a meeting whose recorded length was wrong is to file it and
 *   log the hour by hand. If an archived meeting still counted, that correction
 *   would BE the double count, arriving by the one door left open.
 *
 * ---
 *
 * **SUMMED IN SQL, AND COALESCED.** `listTimeEntries` caps at 100 rows, so a
 * JavaScript sum over a page is correct until somebody logs 101 entries in a week
 * and is then silently SHORT -- this phase's own failure mode arriving through the
 * one number the phase exists to produce. And `SUM` over no rows is NULL, while
 * an empty week is 0 hours and not an absent answer.
 *
 * **`::int`, WHICH IS NOT COSMETIC.** `SUM` and `COUNT` over an `integer` column
 * return `bigint`, which postgres.js hands back as a STRING -- and `sql<number>`
 * is a claim TypeScript takes on trust. Uncast, `entryMinutes + meetingMinutes`
 * is `"120" + "45"` = `"12045"`: wrong by three orders of magnitude and typed as
 * correct. `loadTaskCounts` in meetings.ts is the precedent for the cast; the
 * test asserts the runtime type rather than the annotation. int4 overflows above
 * 2,147,483,647 minutes, which is four thousand years of continuous work, and
 * does so as an error rather than as a wrong number.
 *
 * ---
 *
 * **NO INDEX WAS ADDED FOR THIS, AND THAT IS A MEASUREMENT'S ANSWER RATHER THAN
 * AN OMISSION.** `meetings` carries no index on `occurred_at` at all -- 0008
 * built none, and `listMeetings` has been sorting the whole table on every rail
 * tab since Phase 5. Measured on the dev server against a database built by the
 * real migrations, meetings spread evenly over seven years, a fifth with no
 * duration and a tenth archived; EXPLAIN (ANALYZE, BUFFERS) on this week's
 * aggregate, without and then with a partial index on `(occurred_at) WHERE
 * archived_at IS NULL`:
 *
 *     5,000 rows,  13 in the week:  0.462ms /    81 buffers  ->  0.043ms /  3, index 120kB / 648kB heap
 *   200,000 rows, 493 in the week:  19.2ms  / 3,226 buffers  ->  0.187ms / 15, index 3.9MB / 25MB heap
 *
 * Five thousand meetings is a decade of heavy use of a single-operator CRM, and
 * the difference there is four tenths of a millisecond on a report opened a few
 * times a day. The 200k row is the "does it ever matter" bound, and it does -- a
 * parallel sequential scan burning both of this box's cores for 19ms -- which is
 * why the number is written down rather than left to be rediscovered. **The index
 * is one line; build it when a reader needs it, which this one measurably does
 * not** (0017/0019/0020's rule). Task 4 builds the five record indexes on
 * `time_entries` with its own measurement and is where this one would join them
 * if its filters change the shape of this query.
 *
 * ---
 *
 * **TASK 4 MEASURED THEM AND BUILT NONE OF THEM, AND ONE OF THE FIGURES SAYS THE
 * PLAN'S INSTRUCTION WAS WRONG RATHER THAN MERELY PREMATURE.**
 *
 * The plan assigns "the five record indexes" to this task on the reasoning that
 * it is the first task with readers for `time_entries`' record foreign keys.
 * There now are such readers -- `entryFilters` below -- so the measurement was
 * taken: dev server, database built by the real migrations, entries and meetings
 * spread over seven years across 199 projects with an eighth of them on the
 * project being filtered for, a seventh archived, a fifth of meetings with no
 * duration. Warm, `EXPLAIN (ANALYZE, BUFFERS)` on the four shapes the page
 * issues, without and then with partial indexes on every record column and on
 * `meetings(occurred_at)`:
 *
 *     5,000 entries / 5,000 meetings (11 entries and 12 meetings in the week)
 *       totals, entries, unfiltered      0.034ms /  15 buffers  ->  0.031ms /  15
 *       totals, entries, one project     0.053ms /  18          ->  0.051ms /  10
 *       totals, meetings, unfiltered     0.441ms /  81          ->  0.028ms /  14
 *       rows,   entries + 5 joins        0.182ms /  21          ->  0.202ms /  21
 *       rows,   meetings + 4 joins       0.532ms /  87          ->  0.166ms /  20
 *
 *     200,000 / 200,000 (468 entries and 496 meetings in the week, 58 and 61 on the project)
 *       totals, entries, unfiltered      0.52ms  / 552          ->  0.38ms  / 552
 *       totals, entries, one project     0.41ms  / 555          ->  0.72ms  /  87
 *       totals, meetings, unfiltered    21.6ms   / 3,226        ->  0.39ms  / 499
 *       rows,   entries + 5 joins        1.56ms  / 558          ->  1.36ms  / 558
 *       rows,   meetings + 4 joins      16.8ms   / 3,390        ->  0.99ms  / 505
 *
 * **THE RECORD INDEXES DO NOT HELP THIS READER AND AT 200k THEY HURT IT.** The
 * project-filtered aggregate goes from 0.41ms to 0.72ms with the index -- and the
 * row list from 0.39ms to 0.84ms -- while using a sixth of the buffers. Repeated
 * three times, consistently: 0.38/0.45/0.47 against 0.84/0.87/1.04. The reason is
 * structural rather than a planner accident, which is why it is written down as a
 * conclusion. **The timesheet is DATE-RANGED FIRST**, and
 * `time_entries_work_date_idx` (0021) already exists and already reduces the
 * table to one week; the record predicate is then a filter over a few hundred
 * rows, which is cheaper than a second index scan plus a BitmapAnd plus a heap
 * fetch. An index only earns its place when the record is the SELECTIVE half, and
 * on this surface the date always is. `taskEffort` is the reader whose record
 * predicate is the only one it has -- see its own figures below -- and it is a
 * different shape for exactly that reason.
 *
 * **`meetings(occurred_at)` IS THE ONE THAT WOULD MATTER, AND IT IS STILL NOT
 * BUILT.** It is the only candidate that helps, and it helps a lot at 200k: two
 * whole-table scans per page open, each burning both of this box's cores. But at
 * 5,000 meetings -- a decade of heavy single-operator use -- the page's two
 * meeting queries cost 0.97ms together and would cost 0.19ms, on a request that
 * has already spent a network round trip. That is Task 2's decision against the
 * same evidence at the same scale, and this task is not entitled to a different
 * answer just because it has one more caller. **It now has THREE readers waiting
 * for it** (`listMeetings` since Phase 5, `timesheetTotals`, `timesheetDays`), so
 * it is the first index anybody should build the day this table gets big; it is
 * one line and the figures above are what it buys.
 *
 * **THE INSTRUMENT LIED FIRST, AND SAID SO.** Its first draft spread rows over
 * 199 projects with `g % 199`, which gives the filtered project one row in 199 --
 * about 25 of 5,000, spread over seven years, so NONE in the measured week. The
 * "filtered" queries were measuring a project with nothing on it and came back
 * instantly. It was caught only because the probe PRINTS the row count it is
 * about to measure, which is Task 3's lesson applied rather than repeated.
 */

/** The closed range of calendar days a timesheet is asked about. Inclusive both
 * ends, exactly as `listTimeEntries`' `from`/`to` are, because a week is Monday
 * to Sunday and the caller sends both. */
export interface TimesheetRange {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
}

/**
 * **THE RECORD FILTERS, WRITTEN ONCE AND APPLIED TO BOTH HALVES (Task 4).**
 *
 * The entries half and the meetings half must narrow to the SAME record or the
 * total belongs to nothing: a project filter that reached the entries and left
 * the meetings whole would answer "4h on Rollout" with every meeting of the week
 * added in. So both `timesheetTotals` and `timesheetDays` build their WHERE from
 * these two functions and neither writes a filter of its own.
 *
 * `taskId` IS ABSENT AND THAT IS ARGUED WHERE THE CONTRACT IS -- see
 * `timesheetFiltersSchema` in @conduit/shared. In one line: `meetings` has no
 * `task_id`, and Task 3's `GET /api/tasks/:id/effort` already answers the
 * question better.
 */
function entryFilters(filters: TimesheetFilters): SQL[] {
  const where: SQL[] = [];
  if (filters.companyId) where.push(eq(timeEntries.companyId, filters.companyId));
  if (filters.contactId) where.push(eq(timeEntries.contactId, filters.contactId));
  if (filters.dealId) where.push(eq(timeEntries.dealId, filters.dealId));
  if (filters.projectId) where.push(eq(timeEntries.projectId, filters.projectId));
  return where;
}

/**
 * **THE CONTACT ARM IS AN `EXISTS`, AND A JOIN HERE WOULD BE A DOUBLE COUNT.**
 *
 * This is the hazard Task 2 wrote down for this task in as many words.
 * `listMeetings` widens its contact filter to attendance -- "this meeting names
 * contact C, OR an attendee row for C exists" -- and the obvious way to spell
 * that is `.leftJoin(meetingAttendees)`, which reads identically and turns a
 * meeting with three attendees into three rows whose duration is then summed
 * three times. Nothing about the resulting number looks wrong. A subquery has no
 * such effect: it filters rows, it does not multiply them. A test holds it
 * ("counts a meeting once however many attendees it had") on both the aggregate
 * and the day list.
 *
 * WIDENED TO ATTENDANCE DELIBERATELY, matching `listMeetings` rather than
 * matching `entryFilters` above. "This contact's week" has to mean the same
 * thing on the timesheet as it does on the contact's own Meetings tab, and an
 * hour spent in a meeting somebody attended is an hour spent with them whether
 * or not they are the row's `contact_id`. Time ENTRIES have no attendee table,
 * so their arm cannot widen and does not pretend to.
 */
function meetingFilters(filters: TimesheetFilters): SQL[] {
  const where: SQL[] = [];
  if (filters.companyId) where.push(eq(meetings.companyId, filters.companyId));
  if (filters.contactId) {
    // Non-null assertion: `or` returns undefined only when given zero
    // conditions, and both branches here are unconditional -- listMeetings' note,
    // and the same warning applies: do not make either branch optional without
    // rechecking.
    where.push(or(
      eq(meetings.contactId, filters.contactId),
      sql`EXISTS (SELECT 1 FROM ${meetingAttendees} WHERE ${meetingAttendees.meetingId} = ${meetings.id} AND ${meetingAttendees.contactId} = ${filters.contactId})`,
    )!);
  }
  if (filters.dealId) where.push(eq(meetings.dealId, filters.dealId));
  if (filters.projectId) where.push(eq(meetings.projectId, filters.projectId));
  return where;
}

/**
 * The two predicates every meeting in this module is classified by, built once
 * and shared by the aggregate and the row list.
 *
 * **ONE DEFINITION, BECAUSE THE ROW LIST AND THE HEADLINE MUST NOT DRIFT.** The
 * page prints `timesheetSummary`'s "Not counted: 2 meetings with no recorded
 * length" above a list in which the operator can see which two -- and a second
 * spelling of "counted" in JavaScript, comparing `occurredAt` to `now` with its
 * own choice of `<` or `<=`, is exactly how a list starts disagreeing with the
 * sentence over it. `timesheetDays` therefore SELECTs these same expressions as
 * booleans instead of re-deciding in JS.
 */
function meetingBuckets(now: Date): { started: SQL; counted: SQL } {
  // The meeting has STARTED. Not "has finished", which would need the duration
  // to answer and so could not be asked of the meetings that have not got one.
  // Bound as an ISO string with an explicit cast rather than as a Date, so the
  // parameter's type is decided here and not inferred from context.
  const started = sql`${meetings.occurredAt} <= ${now.toISOString()}::timestamptz`;
  // ONE PREDICATE, USED BY BOTH THE SUM AND ITS COUNT, so "the minutes" and "the
  // meetings they came from" are provably the same population. `duration_minutes
  // IS NOT NULL` is redundant inside SUM, which ignores nulls, and is not
  // redundant inside COUNT -- and writing it once is what stops the two drifting
  // into counting different sets.
  const counted = sql`${started} AND ${meetings.durationMinutes} IS NOT NULL`;
  return { started, counted };
}

export async function timesheetTotals(
  db: Database, range: TimesheetRange, filters: TimesheetFilters = {}, now: Date = new Date(),
): Promise<TimesheetTotals> {
  // THE ORGANISATION'S CLOCK, resolved once and reported, because it is the
  // thing that decides which calendar day a meeting's instant fell on. Through
  // `usableTimeZone` here rather than only inside zonedDayRange, so the payload
  // can name the zone the answer was actually computed in -- a report that
  // quietly fell back to UTC and did not say so is what that helper's rule
  // exists to prevent. The stored string is left alone; Settings is the one page
  // that must show it as it is.
  const timeZone = usableTimeZone((await getOrgProfile(db)).timeZone);
  // Also the validator: a range that runs backwards or is not made of calendar
  // days throws here rather than being answered with an empty week, which would
  // be indistinguishable from an honest one.
  const { startInclusive, endExclusive } = zonedDayRange(range.from, range.to, timeZone);

  const { started, counted } = meetingBuckets(now);

  const [[entryRow], [meetingRow]] = await Promise.all([
    db.select({
      minutes: sql<number>`COALESCE(SUM(${timeEntries.minutes}), 0)::int`,
      count: sql<number>`COUNT(*)::int`,
      // THE BILLABLE SPLIT, OUT OF THE SAME AGGREGATE AS THE THING IT SPLITS.
      // Two queries would be two populations that agree until a filter is added
      // to one of them; a FILTER clause cannot be. `timesheetTotalsSchema`
      // refuses a payload where either of these exceeds its whole, which is what
      // makes "a subset" a guarantee rather than a hope.
      billableMinutes: sql<number>`COALESCE(SUM(${timeEntries.minutes}) FILTER (WHERE ${timeEntries.billable}), 0)::int`,
      billableCount: sql<number>`COUNT(*) FILTER (WHERE ${timeEntries.billable})::int`,
    }).from(timeEntries).where(and(
      isNull(timeEntries.archivedAt),
      gte(timeEntries.workDate, range.from),
      lte(timeEntries.workDate, range.to),
      ...entryFilters(filters),
    )),
    // NO JOIN. See the header: a join to meeting_attendees or to the linked
    // records fans one meeting into several rows and sums its duration once per
    // row, and nothing about the resulting number looks wrong.
    db.select({
      minutes: sql<number>`COALESCE(SUM(${meetings.durationMinutes}) FILTER (WHERE ${counted}), 0)::int`,
      counted: sql<number>`COUNT(*) FILTER (WHERE ${counted})::int`,
      // NOT-YET-HAPPENED TAKES PRECEDENCE OVER UNMEASURED, which is why this
      // filter carries `${started}` rather than only the null test: a meeting
      // arranged for Friday with no duration typed in is reported as one that
      // has not happened, because its length is not yet a fact about anything.
      // The three filters partition the population; the wire schema's refine is
      // what proves it did not stop being true.
      unmeasured: sql<number>`COUNT(*) FILTER (WHERE ${started} AND ${meetings.durationMinutes} IS NULL)::int`,
      notYetOccurred: sql<number>`COUNT(*) FILTER (WHERE NOT (${started}))::int`,
      inRange: sql<number>`COUNT(*)::int`,
    }).from(meetings).where(and(
      isNull(meetings.archivedAt),
      // HALF-OPEN ON THE INSTANT, WHICH IS INCLUSIVE ON THE DAY. The upper bound
      // is where the day after `to` begins, never that day's own last
      // millisecond: a day is 23 or 25 hours twice a year, so arithmetic on
      // hours drops an hour of meetings out of one week and lends it to the
      // next. See zonedDayRange, which is why an inclusive end cannot be spelled
      // at all.
      gte(meetings.occurredAt, startInclusive),
      lt(meetings.occurredAt, endExclusive),
      // STILL NO JOIN, filters included: the contact arm is an EXISTS in the
      // WHERE, never a FROM. See meetingFilters.
      ...meetingFilters(filters),
    )),
  ]);
  if (entryRow === undefined || meetingRow === undefined) {
    // An aggregate with no GROUP BY always returns exactly one row; this is the
    // type narrowing, not a case that can happen.
    throw new Error("timesheetTotals: an aggregate returned no row");
  }

  return {
    from: range.from, to: range.to, timeZone,
    entryMinutes: entryRow.minutes, entryCount: entryRow.count,
    billableEntryMinutes: entryRow.billableMinutes, billableEntryCount: entryRow.billableCount,
    meetingMinutes: meetingRow.minutes,
    meetingsCounted: meetingRow.counted,
    meetingsUnmeasured: meetingRow.unmeasured,
    meetingsNotYetOccurred: meetingRow.notYetOccurred,
    meetingsInRange: meetingRow.inRange,
    // COUNTED, NOT TOTAL, and the name is doing work: the meetings this report
    // could not count are a separate pair of numbers, and a page that printed
    // this figure and called it the week's total would be the failure the spec
    // describes. `timesheetSummary` in @conduit/shared is the sentence that
    // cannot leave them out.
    countedMinutes: entryRow.minutes + meetingRow.minutes,
  };
}

/** A contact's two name columns as one label, `time_entries.csv`'s spelling.
 * A contact with no surname is legal (contacts.lastName is nullable), so the
 * empty part is dropped rather than joined to a trailing space. */
function contactName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter((part) => part !== null && part !== "").join(" ");
}

/** The links a row carries, in one fixed order so two rows on the same record
 * read the same way. Nulls drop out; at-least-one means most rows have one. */
function linksOf(
  found: { kind: TimesheetLink["kind"]; id: string | null; label: string | null }[],
): TimesheetLink[] {
  return found
    .filter((link): link is { kind: TimesheetLink["kind"]; id: string; label: string | null } =>
      link.id !== null)
    // A LEFT JOIN that found nothing would be a link to a record that has been
    // hard-deleted, which cannot happen in this schema (nothing is ever
    // expunged) -- so the fallback is the id rather than "", which would render
    // as a blank chip nobody could act on.
    .map((link) => ({ kind: link.kind, id: link.id, label: link.label ?? link.id }));
}

/**
 * **THE WEEK, ROW BY ROW: WHAT THE HEADLINE IS MADE OF (Phase 10 Task 4).**
 *
 * `timesheetTotals` answers "7h 30m counted, and 3 meetings were not". This
 * answers WHICH -- the entries and the meetings of the range, on the
 * organisation's calendar days, each saying whether it counted and why not.
 *
 * **BOTH TABLES, BECAUSE A LIST OF ONLY THE ENTRIES WOULD NOT ADD UP TO THE
 * SENTENCE ABOVE IT.** The summary names meetings' minutes in the same breath as
 * the entries', so a page listing entries alone gives the reader no way to check
 * a third of the figure -- and gives them nothing at all to look at when the
 * sentence says two meetings had no recorded length. An unverifiable total is
 * this phase's failure mode wearing a different costume.
 *
 * **THE JOINS ARE SAFE HERE AND THE AGGREGATE'S ARE NOT, WHICH IS WORTH SAYING
 * RATHER THAN LEAVING AS A PUZZLE.** Every join below is on a PRIMARY KEY, so it
 * matches at most one row and cannot fan a record out; `meeting_attendees` --
 * the one table that would -- is not joined here either, and the contact filter
 * reaches attendance through `meetingFilters`' EXISTS exactly as the aggregate
 * does. The day figures are summed over these rows, so a fanned-out join would
 * double a day's minutes just as surely as it would double the total's.
 *
 * **NOT PAGED, AND THE BOUND IS ON THE RANGE INSTEAD.** A cursor here would put
 * a truncated list under an untruncated total and leave the operator to discover
 * the difference; `routes/timesheet.ts` refuses a span longer than
 * MAX_TIMESHEET_DAY_SPAN, which bounds the answer at the gate. The aggregate
 * keeps no such bound because its answer is the same size for a decade as for a
 * day.
 *
 * **THE CALENDAR DAY OF A MEETING IS DECIDED IN JS AND NOT IN SQL**, which is
 * `zonedDayRange`'s decision one function along: `(occurred_at AT TIME ZONE $tz)
 * ::date` reads Postgres's tzdata rather than the ICU the stored zone was
 * validated against, and could raise 22023 mid-report for a zone the Settings
 * form accepted. One formatter is built for the whole request
 * (`zonedDayFormatter`) rather than one per row, which is the measured cost.
 */
export async function timesheetDays(
  db: Database, range: TimesheetRange, filters: TimesheetFilters = {}, now: Date = new Date(),
): Promise<TimesheetWeek> {
  const timeZone = usableTimeZone((await getOrgProfile(db)).timeZone);
  // Also the validator, timesheetTotals' arrangement: a backwards range or a day
  // that is not one throws here rather than being answered with an empty week.
  const { startInclusive, endExclusive } = zonedDayRange(range.from, range.to, timeZone);
  const { started, counted } = meetingBuckets(now);

  const [entryRows, meetingRows] = await Promise.all([
    db.select({
      id: timeEntries.id, workDate: timeEntries.workDate, minutes: timeEntries.minutes,
      description: timeEntries.description, billable: timeEntries.billable,
      companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name, taskTitle: tasks.title,
      companyId: timeEntries.companyId, contactId: timeEntries.contactId,
      dealId: timeEntries.dealId, projectId: timeEntries.projectId, taskId: timeEntries.taskId,
    }).from(timeEntries)
      // ALL FIVE, ALL LEFT, `time_entries.csv`'s arrangement and its reason: at
      // least one means four of the five are null on an ordinary row, so an
      // INNER JOIN anywhere would drop most of the week.
      .leftJoin(companies, eq(timeEntries.companyId, companies.id))
      .leftJoin(contacts, eq(timeEntries.contactId, contacts.id))
      .leftJoin(deals, eq(timeEntries.dealId, deals.id))
      .leftJoin(projects, eq(timeEntries.projectId, projects.id))
      .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
      .where(and(
        isNull(timeEntries.archivedAt),
        gte(timeEntries.workDate, range.from),
        lte(timeEntries.workDate, range.to),
        ...entryFilters(filters),
      ))
      // Ascending, unlike listTimeEntries' newest-first keyset: this is a week
      // read top to bottom, and the day headings are already the ordering.
      .orderBy(timeEntries.workDate, timeEntries.id),
    db.select({
      id: meetings.id, occurredAt: meetings.occurredAt, title: meetings.title,
      durationMinutes: meetings.durationMinutes,
      // THE BUCKETS COME OUT OF THE SAME EXPRESSIONS THE AGGREGATE USES, as
      // booleans, rather than being decided again in JavaScript against `now`.
      // See meetingBuckets: a second spelling of "has it started" is how the
      // list and the sentence above it start disagreeing at midnight.
      started: sql<boolean>`${started}`,
      counted: sql<boolean>`${counted}`,
      companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name,
      companyId: meetings.companyId, contactId: meetings.contactId,
      dealId: meetings.dealId, projectId: meetings.projectId,
    }).from(meetings)
      .leftJoin(companies, eq(meetings.companyId, companies.id))
      .leftJoin(contacts, eq(meetings.contactId, contacts.id))
      .leftJoin(deals, eq(meetings.dealId, deals.id))
      .leftJoin(projects, eq(meetings.projectId, projects.id))
      .where(and(
        isNull(meetings.archivedAt),
        // HALF-OPEN ON THE INSTANT, INCLUSIVE ON THE DAY -- the aggregate's
        // bounds, from the same zonedDayRange call, so a meeting on the stroke
        // of midnight is in exactly one of the two weeks on both readings.
        gte(meetings.occurredAt, startInclusive),
        lt(meetings.occurredAt, endExclusive),
        ...meetingFilters(filters),
      ))
      .orderBy(meetings.occurredAt, meetings.id),
  ]);

  const dayOf = zonedDayFormatter(timeZone);
  const rows: TimesheetRow[] = [
    ...entryRows.map((r): TimesheetRow => ({
      kind: "entry",
      id: r.id,
      // `work_date` is a bare `date` and arrives as the string Postgres stored.
      // No Date is constructed from it, ever: `new Date("2026-09-06")` is UTC
      // midnight and any later local formatting can move it a day, which is
      // precisely what this column is a `date` to avoid (toTimeEntry's note).
      day: r.workDate,
      minutes: r.minutes,
      label: r.description,
      billable: r.billable,
      // AN ENTRY ALWAYS COUNTS, including one dated in the future -- see the
      // module header's note on the asymmetry with meetings, which is
      // deliberate and is inherited from Task 2's aggregate rather than decided
      // here. Spelled as a literal so this file cannot drift from that: if the
      // aggregate ever starts excluding an entry, this must too, and a test
      // compares the two.
      counted: true,
      uncountedReason: null,
      links: linksOf([
        { kind: "company", id: r.companyId, label: r.companyName },
        { kind: "contact", id: r.contactId, label: contactName(r.contactFirstName, r.contactLastName) },
        { kind: "deal", id: r.dealId, label: r.dealTitle },
        { kind: "project", id: r.projectId, label: r.projectName },
        { kind: "task", id: r.taskId, label: r.taskTitle },
      ]),
    })),
    ...meetingRows.map((r): TimesheetRow => ({
      kind: "meeting",
      id: r.id,
      day: dayOf(r.occurredAt),
      minutes: r.durationMinutes,
      label: r.title,
      // NOT `false`, WHICH WOULD BE A CLAIM NOBODY MADE. `meetings` has no
      // billable column; see timesheetBillableSummary.
      billable: null,
      counted: r.counted,
      // NOT-YET-HAPPENED TAKES PRECEDENCE OVER UNMEASURED, the aggregate's rule:
      // a meeting arranged for Friday with no duration typed in has not happened
      // rather than gone untimed, because its length is not yet a fact about
      // anything.
      uncountedReason: r.counted ? null : (r.started ? "no-recorded-length" : "not-yet-happened"),
      links: linksOf([
        { kind: "company", id: r.companyId, label: r.companyName },
        { kind: "contact", id: r.contactId, label: contactName(r.contactFirstName, r.contactLastName) },
        { kind: "deal", id: r.dealId, label: r.dealTitle },
        { kind: "project", id: r.projectId, label: r.projectName },
      ]),
    })),
  ];

  const byDay = new Map<string, TimesheetRow[]>();
  for (const row of rows) {
    const day = byDay.get(row.day);
    if (day === undefined) byDay.set(row.day, [row]);
    else day.push(row);
  }
  const days: TimesheetDay[] = calendarDaysBetween(range.from, range.to).map((day) => {
    const dayRows = byDay.get(day) ?? [];
    return {
      day,
      countedMinutes: dayRows.reduce((total, row) => total + (row.counted ? row.minutes ?? 0 : 0), 0),
      rows: dayRows,
    };
  });
  // A ROW ON A DAY OUTSIDE THE RANGE IS A BUG, NOT A ROW TO DROP. The only way
  // one can arise is the zone conversion disagreeing with the instant bounds
  // both of them came from, which would mean a meeting counted by the aggregate
  // and invisible in the list. Dropping it silently is the failure; saying so is
  // not. `timesheetWeekSchema` refuses such a payload at the wire as well.
  const placed = days.reduce((total, day) => total + day.rows.length, 0);
  if (placed !== rows.length) {
    throw new Error(
      `timesheetDays: ${String(rows.length - placed)} row(s) fell outside ${range.from}..${range.to} `
      + `in ${timeZone}`,
    );
  }

  return { from: range.from, to: range.to, timeZone, days };
}

/**
 * **BOOKED VERSUS ESTIMATED, FOR ONE TASK (Phase 10 Task 3).**
 *
 * The spec's second reading of `schema.ts` was that `tasks` carries no quantity
 * of work -- "dates and a percentage, never a quantity" -- and that this
 * comparison, which is usually the point of booking time against a task, could
 * not exist until a column did. `tasks.estimate_minutes` (0022) is that column
 * and this is the whole of the reading over it. `GET /api/tasks/:id/effort`
 * serves it; the task drawer renders `taskEffortSummary` and computes nothing.
 *
 * **IT LIVES HERE AND NOT IN services/tasks.ts FOR THIS MODULE'S FOUNDING
 * REASON**, one table further along: it reads `tasks` AND `time_entries` and
 * belongs to neither. tasks.ts would have to import `timeEntries` to hold it,
 * and time-entries.ts would have to grow a reader keyed on somebody else's row.
 * This module exists precisely because "what has been booked" is a question
 * about two tables, and the whole of Phase 10's summing lives in it.
 *
 * **NOT ON `toTask`, AND THAT IS THE RIPPLE THAT WAS MEASURED AND REFUSED.** The
 * obvious place for a booked figure is the `Task` payload itself, and it would
 * be wrong: `taskSchema` is rendered by the board, the Gantt, My Tasks, search
 * and a meeting's follow-up list, so a field on it makes EVERY producer of a
 * task run an aggregate -- a board of forty cards becomes forty scans of
 * `time_entries` to draw something nobody put on a card. So this is a second
 * endpoint under the same `:id`, exactly as the drawer's dependency list is
 * (`GET /api/tasks/:id/dependencies`), and the board and the Gantt pay nothing.
 *
 * **NO MEETING MINUTE CAN REACH THIS NUMBER, and that is the schema's doing
 * rather than a filter here.** `meetings` carries four record links and
 * `task_id` is not among them, so a meeting cannot be booked to a task at all.
 * The one join that does exist between the two halves is `events.meeting_id` on
 * the event a follow-up task's creation writes, and Task 2 settled what it
 * means: an hour booked against a follow-up task is different work, not a second
 * copy of the meeting's hour.
 *
 * **ONE AGGREGATE, SO THE MINUTES AND THE COUNT ARE THE SAME POPULATION** --
 * `timesheetTotals`' rule above, and `taskEffortSchema`'s refine is what proves
 * it did not stop being true. `::int` for that function's reason: `SUM`/`COUNT`
 * over an `integer` are `bigint`, which postgres.js hands back as a STRING, and
 * `sql<number>` is a claim TypeScript takes on trust.
 *
 * **THE INDEX THIS READER WANTS DOES NOT EXIST, AND THE PLAN NAMES THE WRONG
 * TASK AS ITS FIRST READER.** `time_entries`' five record foreign keys are
 * deliberately unindexed -- 0021 builds only `(work_date DESC, id DESC)` -- and
 * the Phase 10 plan assigns all five to Task 4 as "the first task with readers
 * for them". THAT IS NO LONGER TRUE: this is a reader for `task_id`, it arrives
 * a task early, and it runs on every task drawer open rather than a few times a
 * day. Measured on the dev server against a database built by the real
 * migrations, entries spread over 200 tasks and a tenth of them archived;
 * EXPLAIN (ANALYZE, BUFFERS) on the aggregate below, warm, without and then with
 * a partial index on `(task_id) WHERE archived_at IS NULL`:
 *
 *     5,000 entries,  22 live on the task:   0.42ms /    73 buffers  ->  0.04ms /  24, index  56kB / 584kB heap
 *   200,000 entries, 907 live on the task:  18.80ms / 2,881 buffers  ->  0.78ms / 910, index 1.2MB /  23MB heap
 *
 * Five thousand entries is a decade of a single operator logging two entries a
 * working day, and the difference there is four tenths of a millisecond on a
 * request that already costs a network round trip. **Not built** --
 * 0017/0019/0020's rule, and Task 2's decision on `meetings(occurred_at)`
 * against the same shape of evidence at the same scale. Note that even at 200k
 * the index saves only two thirds of the buffers: one entry per heap page,
 * because a task's hours are scattered across years of insert order, so the
 * bitmap heap scan still visits 907 pages. The figures are written down so Task
 * 4, which builds the other four record indexes for its filters, can add this
 * one beside them without re-measuring.
 *
 * THE MEASUREMENT'S FIRST DRAFT WAS A BAD INSTRUMENT AND SAID SO: it spread
 * entries over tasks with `g % 200` and archived them with `g % 10`, and 10
 * divides 200, so every entry on the target task had the same `g mod 10` and ALL
 * of them were archived. It reported nought rows on the task, which is the only
 * reason it was caught rather than recorded as a fast query.
 */
export async function taskEffort(db: Database, taskId: string): Promise<TaskEffort> {
  // THE TASK IS READ FIRST AND ON ITS OWN, so a missing id is a 404 rather than
  // an honest-looking "no estimate, nothing booked" -- which is what a bare
  // aggregate over time_entries answers for a task that does not exist, and is
  // this phase's failure mode in miniature: a number that is wrong without
  // looking wrong.
  const [task] = await db.select({ estimateMinutes: tasks.estimateMinutes })
    .from(tasks).where(eq(tasks.id, taskId));
  if (task === undefined) throw new NotFoundError("task", taskId);

  const [booked] = await db.select({
    minutes: sql<number>`COALESCE(SUM(${timeEntries.minutes}), 0)::int`,
    count: sql<number>`COUNT(*)::int`,
  }).from(timeEntries).where(and(
    eq(timeEntries.taskId, taskId),
    // ARCHIVING IS THE ONLY WAY AN HOUR LEAVES A TOTAL in this phase -- an entry
    // cannot be corrected to nothing, `time_entries_minutes_range` forbids zero
    // -- so an archived entry still counted here would make the correction for a
    // mis-booked afternoon work everywhere except on this reading.
    isNull(timeEntries.archivedAt),
  ));
  if (booked === undefined) {
    // An aggregate with no GROUP BY always returns exactly one row; this is the
    // type narrowing, not a case that can happen.
    throw new Error("taskEffort: an aggregate returned no row");
  }

  return {
    taskId,
    // AN ARCHIVED TASK STILL ANSWERS, deliberately, and it is the opposite case
    // from an archived ENTRY: the drawer opens on an archived task (read-only,
    // with an unarchive button), and a comparison that went blank there would
    // hide the hours somebody opened the task to account for. An archived entry
    // is an hour withdrawn; an archived task is a task somebody is still asking
    // about.
    estimateMinutes: task.estimateMinutes,
    bookedMinutes: booked.minutes,
    entryCount: booked.count,
  };
}
