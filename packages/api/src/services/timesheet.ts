import { and, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { usableTimeZone, zonedDayRange } from "@conduit/shared";
import type { TimesheetTotals } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { meetings, timeEntries } from "../db/schema.js";
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
