import { and, eq, isNull, sql } from "drizzle-orm";
import {
  timeEntryAtLeastOneLink, usableTimeZone, zonedDayFormatter, TIME_ENTRY_NO_LINK_MESSAGE,
} from "@conduit/shared";
import type {
  RunningTimer, TimeEntry, TimerStartInput, TimerState, TimerStopInput, TimesheetLink,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects, tasks, timers, type TimerRow,
} from "../db/schema.js";
import { NotFoundError, ConflictError } from "./errors.js";
import {
  assertLinkedRecordsExist, insertTimeEntry, normaliseDescription, publishTimeEntryHint,
} from "./time-entries.js";
import { contactName, linksOf } from "./timesheet.js";
import { getOrgProfile } from "./org-profile.js";
import { publish } from "./sse.js";

/**
 * **THE TIMER (Phase 10 Task 5): THE SECOND CAPTURE PATH, AND THE PHASE'S
 * STATED RISK.**
 *
 * The spec is explicit that the risk is not the timing: "running state that must
 * survive a restart, a closed tab, and a second device"; "the weekend problem
 * ... the recovery interaction is most of the feature"; and "two paths that can
 * produce the same hour". This module is where all three are answered, so each
 * is written out here rather than left in three comments a reader has to
 * assemble.
 *
 * ---
 *
 * **1. THE RUNNING STATE IS A ROW, AND THERE IS NO OTHER COPY OF IT.**
 *
 * Conduit is one process with no swap, so a timer held in memory dies with a
 * deploy. `timers.started_at` is the whole of the state, stamped by the DATABASE
 * (`DEFAULT now()`), and every figure anybody reads is `now - started_at`
 * computed at the moment of reading. `getRunningTimer` is one indexed lookup,
 * and a restart, a reloaded tab and a second device are the same question to it.
 *
 * **THE WIRE CARRIES NO DURATION AT ALL**, which is the decision that keeps this
 * honest. An elapsed figure in a JSON body is stale by the time it is parsed,
 * and a payload carrying one would mean two definitions of "how long has this
 * run" -- one ticking in the browser and one frozen in the response. There is
 * one definition, `timerElapsedMinutes` in @conduit/shared, and this side calls
 * it with the server's clock while the strip calls it with the device's.
 *
 * ---
 *
 * **2. THE RECOVERY INTERACTION, AND WHY THE SERVICE IS THE SMALL HALF OF IT.**
 *
 * "You left this running for 62 hours." `time_entries_minutes_range` is
 * `<= 1440` because `work_date` is one day, so that timer HAS no automatic
 * answer -- and the design takes that as the constraint rather than routing
 * around it. What this module does about it is exactly two things:
 *
 *   **`stopTimer` TAKES THE MINUTES AND DOES NOT ARGUE.** It never computes the
 *   elapsed time and never compares the figure it is given against it. A
 *   cross-check would refuse precisely the correction the recovery exists to
 *   allow -- "it ran for 62 hours, I worked three of them" is the true answer and
 *   a service that insisted on the clock's would make it unsayable.
 *
 *   **AND A TIMER IS NEVER STOPPED FOR THE OPERATOR.** There is no sweeper, no
 *   deadline and no automatic entry. A timer left running goes on running,
 *   which sounds like doing nothing and is the only option that writes no
 *   number nobody gave -- the same refusal `time_entries.billable` has no
 *   DEFAULT for. What changes as it runs is what the browser is willing to
 *   OFFER (@conduit/shared's `timerProposedMinutes` and `timerSummary`), which
 *   is where the rest of the interaction lives, because it is an interaction.
 *
 * ---
 *
 * **3. DOUBLE COUNTING: WHAT IS IMPOSSIBLE HERE, AND WHAT IS NOT.**
 *
 * Task 2 enumerated every route to a double count between meetings and entries
 * and closed each one. The same accounting, for the timer, and it does NOT come
 * out as clean -- which is said here rather than glossed:
 *
 * | route | what closes it |
 * |---|---|
 * | two timers running at once, each stopping into an entry | **impossible**: `timers_one_running_per_owner`, a partial unique index. A second start is 23505, mapped to a 409 below |
 * | one timer stopped twice | **impossible**: the claim is `UPDATE ... WHERE stopped_at IS NULL` in the SAME transaction as the INSERT, so the second stop matches no row and writes nothing |
 * | two timers pointing at one entry | **impossible**: `timers_time_entry_unique` |
 * | a running timer counted as an hour | **impossible**: it is not a `time_entries` row and cannot be one (`minutes` is NOT NULL and `> 0`), and `timesheetTotals` reads `time_entries` and `meetings` |
 * | a timer entry naming a meeting | **impossible**: no `meeting_id` on either table (42703, Task 1) |
 * | **a timer entry and a HAND entry for the same afternoon** | **NOTHING CLOSES IT** |
 *
 * **THE LAST ROW IS THE HONEST ANSWER AND IT IS NOT A GAP THAT CAN BE PATCHED.**
 * The spec asks for "the same treatment: impossible, not discouraged", and the
 * treatment does not transfer, for a reason that is Task 1's central decision
 * rather than an oversight here: **a `time_entries` row records a DAY and a
 * QUANTITY, not an interval.** "The same afternoon" is not a thing the schema can
 * see -- two 120-minute rows against one project on one Tuesday are, to every
 * column that exists, two genuine sessions. Making the overlap visible would mean
 * giving every entry a start and an end instant, which the hand path cannot
 * truthfully supply ("the operator recorded a day, not a moment", `work_date`'s
 * own comment) and which would make `org_profile.time_zone` load-bearing on every
 * read of every hour ever typed.
 *
 * **WHAT WAS DONE INSTEAD.** The timer path cannot duplicate ITSELF, by the five
 * impossibilities above -- and that is where the new exposure actually was, since
 * "a second device" is the thing this feature adds. Against the hand path, the
 * entry a timer produces is not anonymous: `timers.time_entry_id` records which
 * hours came off a clock and between which two instants, the export carries it
 * (`timers.csv`), and the correction for a duplicate is the one the phase already
 * relies on -- archive it, which is the only way an hour leaves a total anywhere.
 * **Discouraged, not impossible, and the reason is structural.**
 *
 * ---
 *
 * **WHY THIS IS A FOURTH MODULE.** It reads `timers` and writes `time_entries`,
 * so it belongs to neither -- services/timesheet.ts's founding reason, one table
 * further along. It calls `insertTimeEntry` rather than re-implementing the
 * entry's rules, so the at-least-one re-assertion, the record existence checks
 * and the description normalisation have one home and the two capture paths
 * cannot come to disagree about what an hour may be.
 */

/**
 * The timer's own invalidation key, published on every start, stop and discard.
 *
 * A KEY OF ITS OWN, for `["timesheet"]`'s reason exactly (see
 * publishTimeEntryHint): the running timer is neither a time entry nor a
 * meeting, so nesting it under either table's key would leave the strip stale
 * after the writes that actually change it. It is what makes the second device
 * live rather than merely correct-on-refresh -- a timer started on a phone
 * empties and refills the strip on the laptop through the same SSE hint every
 * other key here uses.
 */
function publishTimerHint(): void {
  publish({ keys: [["timer"]] });
}

/**
 * A stored timer as the wire sees it, plus the day its hours will land on.
 *
 * **`workDate` IS COMPUTED HERE AND NOWHERE ELSE.** Task 2's rule -- the
 * organisation's calendar decides which day an instant fell on -- applied to the
 * one instant this table holds. Deriving it in the browser instead would let a
 * phone in another zone put one running timer on two different days, and on the
 * last hour of a week that is two different WEEKS.
 *
 * **AND IT IS THE START DAY, NEVER THE STOP DAY.** A timer running 23:00 to
 * 01:00 has to land somewhere and both readings are defensible, so the argument
 * is not accuracy: the start day is the only one knowable WHILE THE TIMER RUNS,
 * which is what lets the strip say where the hours are going before they are
 * committed. It also cannot produce a future-dated entry, since `started_at` is
 * the server's `now()` -- the timer path simply never reaches the asymmetry Task
 * 4 recorded between a future entry (counts) and a future meeting (does not).
 */
function toRunningTimer(row: TimerRow, timeZone: string, links: TimesheetLink[]): RunningTimer {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    description: row.description,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    projectId: row.projectId, taskId: row.taskId,
    workDate: zonedDayFormatter(timeZone)(row.startedAt),
    links,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The five records this timer names, resolved to labels.
 *
 * **A SECOND QUERY RATHER THAN FIVE JOINS ON THE READ ABOVE, and it costs one
 * round trip on a row that is at most one.** The join version would put five
 * LEFT JOINs on the query that every page of the app issues, to decorate a row
 * that is usually absent -- so the joins would be paid on every "is anything
 * running" and used on the few where something is. Split, the common answer is
 * one indexed lookup that touches one table.
 *
 * LEFT JOINED rather than looked up through the list endpoints, for
 * `timesheetLinkSchema`'s reason: a timer may name an ARCHIVED record (a project
 * that finished on Friday is an ordinary thing to book time to), and no list
 * returns one.
 */
async function linksFor(db: Database, row: TimerRow): Promise<TimesheetLink[]> {
  const [found] = await db
    .select({
      companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name, taskTitle: tasks.title,
    })
    .from(timers)
    .leftJoin(companies, eq(timers.companyId, companies.id))
    .leftJoin(contacts, eq(timers.contactId, contacts.id))
    .leftJoin(deals, eq(timers.dealId, deals.id))
    .leftJoin(projects, eq(timers.projectId, projects.id))
    .leftJoin(tasks, eq(timers.taskId, tasks.id))
    .where(eq(timers.id, row.id));
  return linksOf([
    { kind: "company", id: row.companyId, label: found?.companyName ?? null },
    {
      kind: "contact",
      id: row.contactId,
      label: contactName(found?.contactFirstName ?? null, found?.contactLastName ?? null),
    },
    { kind: "deal", id: row.dealId, label: found?.dealTitle ?? null },
    { kind: "project", id: row.projectId, label: found?.projectName ?? null },
    { kind: "task", id: row.taskId, label: found?.taskTitle ?? null },
  ]);
}

async function stateOf(db: Database, row: TimerRow | undefined): Promise<TimerState> {
  const timeZone = usableTimeZone((await getOrgProfile(db)).timeZone);
  if (row === undefined) return { timer: null, timeZone };
  return { timer: toRunningTimer(row, timeZone, await linksFor(db, row)), timeZone };
}

/**
 * The one timer running for this operator, or none.
 *
 * Served by `timers_one_running_per_owner` (drizzle/0023), whose predicate and
 * key are this WHERE clause -- so the constraint that makes at most one exist
 * and the read that finds it come out of one structure. No second index was
 * measured, because a second one on the same two columns would be the same index
 * built twice.
 *
 * FILTERED BY OWNER, which is not tidiness on a single-operator product: the
 * strip is on every page, and somebody else's clock appearing on it would be a
 * running timer this operator cannot account for and cannot stop.
 */
export async function getRunningTimer(db: Database, ownerUserId: string): Promise<TimerState> {
  const [row] = await db.select().from(timers)
    .where(and(eq(timers.ownerUserId, ownerUserId), isNull(timers.stoppedAt)));
  return stateOf(db, row);
}

/**
 * Start the clock against at least one record.
 *
 * **THE AT-LEAST-ONE RULE IS ENFORCED AT THE START, WHICH IS THE DESIGN AND NOT
 * AN EARLY EXIT.** A timer with no link could not become an entry
 * (`time_entries_has_link`), so the question has to be asked somewhere; asked
 * here it costs one tap while the record picker is on the screen, and asked at
 * stop it would land on somebody recovering from a forgotten weekend, holding
 * hours with nothing to attach them to. `timers_has_link` is the same rule in
 * the database -- the two-place arrangement every link rule in this schema has.
 *
 * Re-asserted here rather than trusted to `timerStartInputSchema`'s refine for
 * `createTimeEntry`'s reason: a direct service caller never meets zod, and
 * without this the CHECK raises 23514 as a 500.
 */
export async function startTimer(
  db: Database, actorId: string, input: TimerStartInput,
): Promise<TimerState> {
  if (!timeEntryAtLeastOneLink(input)) {
    throw new Error(`startTimer: ${TIME_ENTRY_NO_LINK_MESSAGE}`);
  }
  await assertLinkedRecordsExist(db, input);

  let row: TimerRow | undefined;
  try {
    // `started_at` IS NOT SET HERE. The column's DEFAULT is the database's
    // `now()`, so the instant comes from one clock however many processes,
    // tabs and devices can reach this endpoint. A caller-supplied instant
    // would make the elapsed figure depend on whose clock was fast, and --
    // measured in the schema drill -- would also trip
    // `timers_stopped_after_start` on a timer stopped inside its first few
    // milliseconds, because the other instant comes from Postgres.
    [row] = await db.insert(timers).values({
      ownerUserId: actorId,
      description: normaliseDescription(input.description),
      companyId: input.companyId ?? null, contactId: input.contactId ?? null,
      dealId: input.dealId ?? null, projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
    }).returning();
  } catch (error) {
    // **THE SECOND DEVICE, ARRIVING AS 23505.** `timers_one_running_per_owner`
    // is what makes two concurrent timers -- and therefore one afternoon booked
    // twice by one person -- impossible; this is the same refusal in words a
    // client can act on. The running timer's ID IS IN THE MESSAGE deliberately,
    // so a second tab can offer to stop THAT one rather than only reporting
    // that it may not start another.
    if (isUniqueViolation(error, "timers_one_running_per_owner")) {
      const running = await getRunningTimer(db, actorId);
      throw new ConflictError(
        "timer", running.timer?.id ?? actorId,
        `a timer is already running (${running.timer?.id ?? "unknown"}); stop or discard it `
        + "before starting another",
      );
    }
    throw error;
  }
  if (row === undefined) throw new Error("insert returned no row");

  publishTimerHint();
  return stateOf(db, row);
}

/**
 * Stop the clock and book the hours.
 *
 * **ONE TRANSACTION, AND THE CLAIM COMES FIRST.** The `UPDATE ... WHERE
 * stopped_at IS NULL` is what makes a second stop write nothing: a double tap,
 * a retried request or two tabs find no row to claim and get a 409 rather than a
 * second entry. Doing it in the same transaction as the INSERT is what makes the
 * other direction safe too -- if the entry cannot be written (a minutes value the
 * CHECK refuses, a record that vanished), the claim rolls back with it and the
 * timer is still running, rather than the operator's afternoon being both
 * un-logged and un-recoverable.
 *
 * **STOPPED WITH SQL `now()`, NOT `new Date()`.** `started_at` came from the
 * database's clock, so `stopped_at` has to as well: measured in db/schema.test.ts,
 * a JS instant taken when the statement is BUILT is earlier than a `now()`
 * evaluated when it RUNS, so a timer stopped inside its first few milliseconds
 * would violate `timers_stopped_after_start`. The deeper reason is the same one
 * the DEFAULT exists for -- an interval measured against two clocks is not an
 * interval.
 *
 * **THE MINUTES ARE THE OPERATOR'S AND ARE NOT CHECKED AGAINST THE CLOCK**, which
 * is the recovery interaction's whole premise. See the module header.
 *
 * **`workDate` IS THE SERVER'S, NOT THE CALLER'S.** `timerStopInputSchema` has no
 * day field: the timer's own evidence is its start instant, and letting the stop
 * name a day would make this the hand-entry path wearing a timer's clothes -- an
 * hour that could land anywhere, with the clock as decoration. An entry booked to
 * the wrong day is corrected on the timesheet, which already edits entries.
 */
export async function stopTimer(
  db: Database, actorId: string, id: string, input: TimerStopInput,
): Promise<TimeEntry> {
  const existing = await mustGetOwn(db, actorId, id);
  const timeZone = usableTimeZone((await getOrgProfile(db)).timeZone);

  const entry = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(timers)
      .set({ stoppedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(timers.id, id), isNull(timers.stoppedAt)))
      .returning();
    if (claimed === undefined) throw alreadyStopped(id);

    const created = await insertTimeEntry(tx, actorId, {
      // The START day, in the organisation's calendar -- read off the claimed
      // row rather than the one fetched above, so the day belongs to the same
      // read that decided this stop may happen.
      workDate: zonedDayFormatter(timeZone)(claimed.startedAt),
      minutes: input.minutes,
      billable: input.billable,
      // The timer's own words unless the operator wrote better ones at the
      // moment the work finished, which is the natural time to know what it
      // was. `undefined` means "say nothing", so an omitted field keeps the
      // timer's description rather than clearing it.
      description: input.description === undefined ? claimed.description : input.description,
      companyId: claimed.companyId, contactId: claimed.contactId, dealId: claimed.dealId,
      projectId: claimed.projectId, taskId: claimed.taskId,
    });
    // The claim, which is what `timers_time_entry_unique` then holds for ever:
    // one timer, one entry, and no way to point a second timer at it.
    await tx.update(timers).set({ timeEntryId: created.id }).where(eq(timers.id, id));
    return created;
  });

  // AFTER THE COMMIT, both of them. A hint published inside the transaction
  // would send clients to refetch over a different connection, which may not
  // see the row yet -- services/sse.ts's contract, and the reason
  // `insertTimeEntry` was split out of `createTimeEntry` for this caller.
  publishTimerHint();
  publishTimeEntryHint(entry.id, [entry.taskId]);
  return entry;
}

/**
 * Stop the clock and write nothing.
 *
 * **THE OTHER WAY OUT OF THE WEEKEND, and the one that has to exist**: a timer
 * left running over three days often represents no work at all, and the
 * alternative to discarding it is an operator inventing a number to make the
 * strip go away -- which is worse than nothing, because it is indistinguishable
 * from a real hour afterwards.
 *
 * **THE ROW IS KEPT.** Conduit never expunges, and this row is the only record
 * that the clock ever ran; `timers.csv` carries it into the export for that
 * reason. A discarded timer is one that stopped and claimed no entry, which is
 * why "did it produce anything" is a column rather than a status word.
 */
export async function discardTimer(
  db: Database, actorId: string, id: string,
): Promise<TimerState> {
  await mustGetOwn(db, actorId, id);
  const [stopped] = await db.update(timers)
    .set({ stoppedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(timers.id, id), isNull(timers.stoppedAt)))
    .returning();
  if (stopped === undefined) throw alreadyStopped(id);

  publishTimerHint();
  return stateOf(db, undefined);
}

/**
 * The timer, if it is this operator's.
 *
 * A 404 rather than a 403 for somebody else's, which is the shape every other
 * read in this API has: the caller learns nothing about what exists outside
 * their own rows. Existence and ownership are one question here because a timer
 * has exactly one reader.
 */
async function mustGetOwn(db: Database, actorId: string, id: string): Promise<TimerRow> {
  const [row] = await db.select().from(timers)
    .where(and(eq(timers.id, id), eq(timers.ownerUserId, actorId)));
  if (row === undefined) throw new NotFoundError("timer", id);
  return row;
}

/**
 * A 409 for a timer that has already finished.
 *
 * Raised from inside the transaction as well as outside it, so the guarded
 * UPDATE's zero rows and a plainly stale request produce the same answer -- a
 * client that lost the race and one that never had a chance are both told the
 * same true thing.
 */
function alreadyStopped(id: string): ConflictError {
  return new ConflictError(
    "timer", id,
    "this timer has already been stopped; refresh to see whether it logged any time",
  );
}

/**
 * Whether a driver error is a unique violation on a named constraint.
 *
 * NAMED RATHER THAN "ANY 23505", which is meetings.ts's rule for the same class
 * of remap: this table has two unique constraints and mapping both to the same
 * 409 would tell an operator their timer is already running when what actually
 * happened was that two timers raced for one entry.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause: unknown = (error as { cause?: unknown }).cause;
  const detail = (cause ?? error) as { code?: unknown; constraint_name?: unknown };
  return detail.code === "23505" && detail.constraint_name === constraint;
}
