import { and, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { usableTimeZone, zonedDayRange } from "@conduit/shared";
import type { TaskEffort, TimesheetTotals } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { meetings, tasks, timeEntries } from "../db/schema.js";
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

export async function timesheetTotals(
  db: Database, range: TimesheetRange, now: Date = new Date(),
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

  const [[entryRow], [meetingRow]] = await Promise.all([
    db.select({
      minutes: sql<number>`COALESCE(SUM(${timeEntries.minutes}), 0)::int`,
      count: sql<number>`COUNT(*)::int`,
    }).from(timeEntries).where(and(
      isNull(timeEntries.archivedAt),
      gte(timeEntries.workDate, range.from),
      lte(timeEntries.workDate, range.to),
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
