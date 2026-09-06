import { and, desc, eq, gte, isNull, isNotNull, lt, lte, or } from "drizzle-orm";
import { timeEntryAtLeastOneLink, TIME_ENTRY_NO_LINK_MESSAGE } from "@conduit/shared";
import type {
  TimeEntry, TimeEntryCreateInput, TimeEntryListFilters, TimeEntryUpdateInput,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects, tasks, timeEntries, type TimeEntryRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { decodeWorkDateCursor, encodeCursor } from "./pagination.js";
import { publish } from "./sse.js";

/**
 * Time entries (Phase 10 Task 1): the HAND-ENTRY half of the two capture paths.
 * A duration attributed to a day, an owner, a billable flag, and the five-way
 * link set.
 *
 * SHAPED LIKE meetings.ts, and knowingly: same at-least-one link invariant in
 * two places, same archive-not-delete lifecycle, same keyset list, same
 * "existence, not activeness" rule for the records an entry names. Where this
 * file differs from that one the difference is written down at the point it
 * happens rather than left for a reader to spot.
 *
 * THE INVARIANT THAT LIVES IN TWO PLACES is `time_entries_has_link`
 * (num_nonnulls(company_id, contact_id, deal_id, project_id, task_id) >= 1),
 * whose twin is timeEntryAtLeastOneLink in @conduit/shared. A CHECK reaching a
 * client is a 500 where a 4xx belongs, so both write paths below assert it
 * before they write -- create against the input, update against the MERGED row,
 * because only the merge can tell "clearing one link of two" from "clearing the
 * last one".
 *
 * NO EVENTS, WHICH IS A DECISION AND NOT AN OMISSION. Every other content
 * writer in this codebase stamps a timeline row -- notes.ts `noted`, files.ts
 * `uploaded`, meetings.ts `met` -- and this one deliberately does not, so
 * `events` gains no `time_entry_id` and no new verb. A record's timeline is the
 * story of what HAPPENED to it, and an hour booked against a project is a
 * measurement of work the timeline already tells the story of: a week of honest
 * time-keeping is thirty entries, which would bury a project's actual history
 * under its own accounting. The timesheet (Task 4) reads this table directly,
 * which is the surface those rows would have been read on anyway. If Task 4
 * finds it wants entries in a timeline after all, that is a migration adding one
 * nullable column and a verb, and nothing here has to be undone first.
 *
 * NO RATE, ANYWHERE. Billable is a flag; see the spec, and @conduit/shared's
 * comment on the column.
 */

/**
 * Invalidation keys every mutator publishes after its transaction commits.
 * No `events` key, unlike meetings.ts's -- this file writes no timeline rows
 * (see the header), so a client refetching a timeline on a time-entry write
 * would be refetching something that provably did not change.
 *
 * **`["task", id]` SINCE v1.9.0, AND IT IS NOT A TIDY-UP.** Task 3 gave `tasks`
 * an estimate, so `GET /api/tasks/:id/effort` now answers a BOOKED figure that
 * this file's writes are the only source of -- and nothing on a task surface
 * listened to `["time-entries"]`. Without this key the drawer's
 * booked-versus-estimated sentence stands still while the hours behind it change,
 * which is the one number in the comparison a stale cache can get wrong without
 * looking wrong. The key is the exact one `publishTaskHint` uses
 * (services/tasks.ts), so TanStack's prefix match reaches the deeper
 * `["task", id, "effort"]` cache the same way it already reaches the drawer's
 * dependency list.
 *
 * `taskIds` IS A LIST FOR `extraAssigneeIds`' REASON, one table over: an update
 * that re-links an entry from task A to task B changes the booked total of BOTH,
 * so the caller passes the pre-patch and post-patch ids and the Set collapses
 * them when they are the same. Nulls are dropped here rather than at each call
 * site -- an entry linked to a project and no task has no task key to publish.
 */
function publishTimeEntryHint(id: string, taskIds: (string | null)[] = []): void {
  const keys: string[][] = [["time-entries"], ["time-entry", id]];
  for (const taskId of new Set(taskIds.filter((t): t is string => t !== null))) {
    keys.push(["task", taskId]);
  }
  publish({ keys });
}

function toTimeEntry(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    // `date` columns come back from postgres.js as the bare string drizzle
    // stored, never a Date -- the same way tasks.startDate and
    // deals.expectedCloseDate already reach their wire shapes. No toISOString()
    // here, and there must not be one: constructing a Date from "2026-09-06"
    // parses it as UTC midnight and any later local formatting can move it a
    // day, which is precisely the class of bug this column is a `date` to avoid.
    workDate: row.workDate,
    minutes: row.minutes, description: row.description, billable: row.billable,
    ownerUserId: row.ownerUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    projectId: row.projectId, taskId: row.taskId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every record an entry names must EXIST. It does not have to be active.
 *
 * meetings.ts's rule, and meetings.ts's reason, which transfers exactly:
 * booking time you actually spent on a project that has since been completed,
 * or a deal since closed, is an ordinary thing to do -- archiving hides a record
 * from default listings, it does not sever links pointed at it, and a timesheet
 * that refused last week's hours because a project finished on Friday would be
 * refusing the truth. notes.ts's assertNoteTargetActive is the opposite rule for
 * the opposite reason (a note is new commentary, and new commentary on a filed
 * record is a mistake); an hour is a record of the past.
 *
 * Without these reads a bogus id surfaces as a foreign-key violation, i.e. a 500
 * where a 404 belongs. Read outside any transaction, on deals.ts's monotonic-
 * existence guarantee: nothing in this schema is ever hard-deleted, so an
 * existence check cannot go stale between here and the INSERT.
 *
 * NOT SHARED WITH meetings.ts's assertLinkedRecordsExist, which checks four of
 * these five. Extracting one helper would mean editing a shipped write path to
 * gain nothing but a line count, and leaving the two callers with a function
 * whose name no longer says which columns it covers. Two copies is the honest
 * number; a third caller is when it becomes a module.
 */
async function assertLinkedRecordsExist(
  db: Database,
  links: {
    companyId?: string | null; contactId?: string | null; dealId?: string | null;
    projectId?: string | null; taskId?: string | null;
  },
): Promise<void> {
  if (links.companyId != null) {
    const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, links.companyId));
    if (row === undefined) throw new NotFoundError("company", links.companyId);
  }
  if (links.contactId != null) {
    const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, links.contactId));
    if (row === undefined) throw new NotFoundError("contact", links.contactId);
  }
  if (links.dealId != null) {
    const [row] = await db.select({ id: deals.id }).from(deals).where(eq(deals.id, links.dealId));
    if (row === undefined) throw new NotFoundError("deal", links.dealId);
  }
  if (links.projectId != null) {
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, links.projectId));
    if (row === undefined) throw new NotFoundError("project", links.projectId);
  }
  if (links.taskId != null) {
    const [row] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, links.taskId));
    if (row === undefined) throw new NotFoundError("task", links.taskId);
  }
}

/**
 * "" is not a storable description: timeEntrySchema's `description` is
 * nullableString, so an empty box in a form must become NULL and not "".
 *
 * TRIMMED FIRST, which is what makes the rule bite: "   " is not "" and would
 * otherwise be stored as a whitespace description that renders as a blank cell
 * in the timesheet and in the export while being, to every reader, a described
 * entry. Plain text, so no sanitizer -- notes.body's treatment, not
 * meetings.notes' (that column is rich-text HTML and passes through
 * sanitizeMailHtml; this one is a line the operator typed).
 */
function normaliseDescription(description: string | null | undefined): string | null {
  if (description == null) return null;
  const trimmed = description.trim();
  return trimmed === "" ? null : trimmed;
}

async function mustGet(db: Database, id: string): Promise<TimeEntryRow> {
  const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
  if (row === undefined) throw new NotFoundError("time entry", id);
  return row;
}

// --- Writes ----------------------------------------------------------------

export async function createTimeEntry(
  db: Database, actorId: string, input: TimeEntryCreateInput,
): Promise<TimeEntry> {
  // timeEntryCreateInputSchema's superRefine already enforces this at the HTTP
  // boundary; re-asserted here for a direct service caller that builds the input
  // by hand and never meets zod (createMeeting's and createTask's precedent).
  // Without it the CHECK raises 23514 as a 500. Task 5's timer will be exactly
  // such a caller.
  if (!timeEntryAtLeastOneLink(input)) {
    throw new Error(`createTimeEntry: ${TIME_ENTRY_NO_LINK_MESSAGE}`);
  }
  await assertLinkedRecordsExist(db, input);

  const [row] = await db.insert(timeEntries).values({
    workDate: input.workDate,
    minutes: input.minutes,
    description: normaliseDescription(input.description),
    // NO `?? false`. The wire schema requires it and the column has no default,
    // which together mean nothing in this system ever decides an entry's
    // billability on the operator's behalf -- see the column's comment for why
    // that default would have been silent in the expensive direction.
    billable: input.billable,
    // The owner is the actor, never a caller-supplied field.
    ownerUserId: actorId,
    companyId: input.companyId ?? null, contactId: input.contactId ?? null,
    dealId: input.dealId ?? null, projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
  }).returning();
  if (row === undefined) throw new Error("insert returned no row");

  publishTimeEntryHint(row.id, [row.taskId]);
  return toTimeEntry(row);
}

export async function getTimeEntry(db: Database, id: string): Promise<TimeEntry> {
  return toTimeEntry(await mustGet(db, id));
}

/**
 * Correcting an entry: the duration, the day, the words, the flag, the links.
 *
 * `actorId` IS TAKEN AND NOT READ, updateMeeting's arrangement and its reason:
 * this file writes no events, so there is no row for an actor to appear on, and
 * the owner is stamped at creation and never moves (an hour was worked by
 * whoever worked it; editing the note on it does not transfer the work). The
 * parameter stays because every other mutator in this codebase takes the actor
 * in that position, and a route calling `updateTimeEntry(db, id, patch)` beside
 * `createTimeEntry(db, user.id, input)` would read as a bug.
 */
export async function updateTimeEntry(
  db: Database, actorId: string, id: string, patch: TimeEntryUpdateInput,
): Promise<TimeEntry> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("time entry", id);

  // THE MERGED ROW, NOT THE PATCH. timeEntryUpdateInputSchema carries no
  // at-least-one refine, deliberately (a patch sees one snapshot, never its
  // persisted counterpart), so clearing projectId on an entry that also carries
  // a dealId is legitimate while clearing the LAST link is not, and only this
  // comparison can tell them apart. Through the exported predicate, never a
  // second copy of it. Without this the CHECK fires and a 409 arrives as a 500.
  const merged = {
    companyId: patch.companyId !== undefined ? patch.companyId : existing.companyId,
    contactId: patch.contactId !== undefined ? patch.contactId : existing.contactId,
    dealId: patch.dealId !== undefined ? patch.dealId : existing.dealId,
    projectId: patch.projectId !== undefined ? patch.projectId : existing.projectId,
    taskId: patch.taskId !== undefined ? patch.taskId : existing.taskId,
  };
  if (!timeEntryAtLeastOneLink(merged)) {
    throw new ConflictError(
      "time entry", id,
      "a time entry must keep at least one company, contact, deal, project or task link; "
      + "set another link in the same patch, or archive the entry instead",
    );
  }
  await assertLinkedRecordsExist(db, patch);

  // An empty patch is a true no-op, down to leaving updated_at alone
  // (companies.ts's rule).
  if (Object.values(patch).every((value) => value === undefined)) return toTimeEntry(existing);

  const values: Partial<typeof timeEntries.$inferInsert> = { updatedAt: new Date() };
  if (patch.workDate !== undefined) values.workDate = patch.workDate;
  if (patch.minutes !== undefined) values.minutes = patch.minutes;
  if (patch.description !== undefined) values.description = normaliseDescription(patch.description);
  if (patch.billable !== undefined) values.billable = patch.billable;
  if (patch.companyId !== undefined) values.companyId = patch.companyId;
  if (patch.contactId !== undefined) values.contactId = patch.contactId;
  if (patch.dealId !== undefined) values.dealId = patch.dealId;
  if (patch.projectId !== undefined) values.projectId = patch.projectId;
  if (patch.taskId !== undefined) values.taskId = patch.taskId;

  // `archived_at IS NULL` in the WHERE is what makes the guard above atomic
  // rather than advisory (updateCompany's and updateMeeting's shape): a
  // concurrent archive between the mustGet and this UPDATE yields zero rows
  // here instead of silently mutating an archived entry.
  const [row] = await db.update(timeEntries).set(values)
    .where(and(eq(timeEntries.id, id), isNull(timeEntries.archivedAt))).returning();
  if (row === undefined) {
    const [recheck] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    throw recheck === undefined ? new NotFoundError("time entry", id) : new ArchivedError("time entry", id);
  }

  // BOTH TASKS, pre-patch and post-patch: re-linking an entry from one task to
  // another moves its minutes out of one booked total and into another, and a
  // drawer open on the task it LEFT is exactly as stale as one open on the task
  // it arrived at. Passed unconditionally; the Set collapses the ordinary case
  // where the link did not change.
  publishTimeEntryHint(id, [existing.taskId, row.taskId]);
  return toTimeEntry(row);
}

/**
 * ARCHIVE IS HOW AN HOUR COMES BACK OUT OF A TOTAL, and it is the only way.
 *
 * Conduit never expunges, so there is no delete; and an entry cannot be
 * corrected to nothing either, because `time_entries_minutes_range` refuses
 * zero. Without this the duplicated afternoon that the two capture paths make
 * easy (spec's Risk 2) would sit in the week's total for ever. listTimeEntries
 * defaults to the live entries, so an archived one leaves every report the
 * moment it is archived and can still be found -- and unarchived -- by anyone
 * who wants to know what happened to it.
 */
async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<TimeEntry> {
  await mustGet(db, id);
  // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
  // requires the row currently unarchived and vice versa. Zero rows back means
  // the state already matched, so re-select and return it as-is -- and do NOT
  // publish, since nothing changed (companies.ts's and meetings.ts's rule).
  const [updated] = await db.update(timeEntries)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(and(
      eq(timeEntries.id, id),
      archived ? isNull(timeEntries.archivedAt) : isNotNull(timeEntries.archivedAt),
    )).returning();
  if (updated === undefined) {
    const [recheck] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    if (recheck === undefined) throw new NotFoundError("time entry", id);
    return toTimeEntry(recheck);
  }
  // Archiving is how an hour leaves a booked total, so the task it left has to
  // hear about it -- the same key, for the same reason, as a create.
  publishTimeEntryHint(id, [updated.taskId]);
  return toTimeEntry(updated);
}
export const archiveTimeEntry = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveTimeEntry = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

// --- List ------------------------------------------------------------------

/** The shared filter contract IS the options type -- no third hand-written
 * shape to drift from the wire (timeEntryListFiltersSchema) and from the
 * route's querystring mapping. meetings.ts and mail-threads.ts do the same. */
export type ListTimeEntriesOptions = TimeEntryListFilters;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Keyset paginated by (work_date, id) DESCENDING -- not created_at, and not
 * occurred_at.
 *
 * A TIMESHEET IS ABOUT THE DAY THE WORK WAS DONE, so ordering by creation would
 * put "Friday's hours, typed on Friday" above "Monday's hours, remembered on
 * Friday afternoon" -- which is the ordering that makes an operator think they
 * did not log Monday. `from`/`to` are inclusive bounds on the same column, which
 * is what makes "this week" one query.
 *
 * THE CURSOR CARRIES A DATE, NOT AN INSTANT, and has its own type for it
 * (pagination.ts's WorkDateCursor). The comparison below is the ordinary keyset
 * `(work_date, id) < (cursor)` spelled as an OR of two terms rather than a row
 * constructor, matching every other list in this codebase.
 *
 * Served by time_entries_work_date_idx (drizzle/0021), which is (work_date DESC,
 * id DESC) precisely so this ordering and this seek come out of one structure.
 */
export async function listTimeEntries(
  db: Database, opts: ListTimeEntriesOptions = {},
): Promise<{ items: TimeEntry[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const where = [opts.archived ? isNotNull(timeEntries.archivedAt) : isNull(timeEntries.archivedAt)];
  if (opts.companyId) where.push(eq(timeEntries.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(timeEntries.contactId, opts.contactId));
  if (opts.dealId) where.push(eq(timeEntries.dealId, opts.dealId));
  if (opts.projectId) where.push(eq(timeEntries.projectId, opts.projectId));
  if (opts.taskId) where.push(eq(timeEntries.taskId, opts.taskId));
  // INCLUSIVE BOTH ENDS. A week is Monday to Sunday and the caller sends both;
  // an exclusive upper bound would silently drop Sunday, which is the kind of
  // off-by-one that makes a total wrong without making it look wrong.
  if (opts.from) where.push(gte(timeEntries.workDate, opts.from));
  if (opts.to) where.push(lte(timeEntries.workDate, opts.to));
  const cur = opts.cursor ? decodeWorkDateCursor(opts.cursor) : null;
  if (cur) {
    // Non-null assertion: `or` returns undefined only when given zero
    // conditions, and both branches here are unconditional. Same note as
    // companies.ts's and meetings.ts's -- do not make either branch optional
    // without rechecking.
    where.push(or(
      lt(timeEntries.workDate, cur.workDate),
      and(eq(timeEntries.workDate, cur.workDate), lt(timeEntries.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(timeEntries).where(and(...where))
    .orderBy(desc(timeEntries.workDate), desc(timeEntries.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toTimeEntry),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ workDate: last.workDate, id: last.id }) : null,
  };
}

// NO SUM FUNCTION HERE, AND IT IS services/timesheet.ts (Task 2).
//
// A first draft of this file exported `sumTimeEntryMinutes` -- one query
// returning the total and the billable total for the same filters. It was
// removed unshipped, because nothing in Task 1 read it and a function with no
// reader is the same cost as an index with none (0017/0019/0020's rule).
//
// THE WARNING IT LEFT HAS BEEN ANSWERED RATHER THAN INHERITED. The week's total
// MUST be summed in SQL, not added up over a page: `listTimeEntries` caps at
// MAX_LIMIT, so a JavaScript sum over `items` is correct until somebody logs 101
// entries in a week and then is silently SHORT -- this phase's own failure mode,
// arriving through the one number the phase exists to produce. And COALESCE it,
// because SUM over no rows is NULL while an empty week is 0 hours. Both are done
// in `timesheetTotals`, and a test there logs 101 entries and asks the list for
// five hundred to prove the cap is real.
//
// IT LIVES IN A THIRD MODULE BECAUSE IT READS TWO TABLES AND BELONGS TO NEITHER:
// the timesheet sums these minutes together with `meetings.duration_minutes`,
// which has held tracked time since Phase 5 and was never aggregated until
// v1.9.0. A function here would make this file import `meetings`.
