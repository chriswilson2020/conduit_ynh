import { and, asc, desc, eq, inArray, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import { meetingAtLeastOneLink } from "@conduit/shared";
import type {
  Meeting, MeetingAttendee, MeetingAttendeeInput, MeetingCreateInput, MeetingDetail,
  MeetingListFilters, MeetingUpdateInput, Task,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects, users, events, meetings, meetingAttendees, tasks,
  type MeetingRow, type MeetingAttendeeRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { sanitizeMailHtml } from "./mail-content.js";
import { decodeOccurredAtCursor, encodeCursor } from "./pagination.js";
import { toTask } from "./tasks.js";
import { publish } from "./sse.js";

/**
 * Meetings (Phase 5): a logged meeting, its attendees, and the records it
 * belongs to. Shaped like companies.ts (cursor pagination, the archived arm,
 * archive-not-delete) rather than notes.ts/files.ts, which are unpaginated
 * whole-record loads with no archive state.
 *
 * TWO INVARIANTS LIVE IN TWO PLACES EACH, and this file is the API half of
 * both. meetings_has_link (at least one record FK) and
 * meeting_attendees_exactly_one (a contact, a user, or a guest name) are DB
 * CHECKs whose twins are zod refines in @conduit/shared. A CHECK reaching a
 * client is a 500 where a 4xx belongs, so every write path below either
 * re-asserts the rule before it writes or maps the constraint failure onto a
 * domain error.
 *
 * `occurredAt` is free in both directions: logging a meeting just had and
 * noting one just arranged are the same act (spec), so nothing here compares
 * it to now or to createdAt.
 */

/** Invalidation keys every meeting mutator publishes after its transaction
 * commits. `events` rides along because every one of them writes a timeline
 * entry too. Meetings are not searchable in v0.9.0, so no `search` key --
 * unlike companies.ts's hint. */
function publishMeetingHint(id: string): void {
  publish({ keys: [["meetings"], ["meeting", id], ["events"]] });
}

function toAttendee(row: MeetingAttendeeRow): MeetingAttendee {
  return {
    id: row.id, meetingId: row.meetingId,
    contactId: row.contactId, userId: row.userId, guestName: row.guestName,
  };
}

function toMeeting(row: MeetingRow, attendees: MeetingAttendee[], taskCount: number): Meeting {
  return {
    id: row.id, title: row.title, occurredAt: row.occurredAt.toISOString(),
    durationMinutes: row.durationMinutes, notes: row.notes, ownerUserId: row.ownerUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId, projectId: row.projectId,
    attendees, taskCount,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// --- Hydration -------------------------------------------------------------

/**
 * meetingSchema.attendees is REQUIRED, so every meeting-returning path here
 * hydrates -- create, get, update, archive, unarchive and every list row --
 * or the client's parse throws. One `inArray` for a whole page, regrouped in
 * JS (mail-threads.ts's loadAggregates shape), never one query per row:
 * meeting_attendees(meeting_id) is the index that serves it (drizzle/0008).
 *
 * Ordered by id, and by nothing else, because id is the only stable order a
 * READ can reproduce: meeting_attendees deliberately carries no created_at
 * and no ordinal column (Task 1), and the set is rewritten wholesale on every
 * update. Without an ORDER BY the rail's attendee summary would be stable
 * only by accident of the plan.
 */
async function loadAttendees(db: Database, meetingIds: string[]): Promise<Map<string, MeetingAttendee[]>> {
  const byMeeting = new Map<string, MeetingAttendee[]>();
  if (meetingIds.length === 0) return byMeeting;
  const rows = await db.select().from(meetingAttendees)
    .where(inArray(meetingAttendees.meetingId, meetingIds))
    .orderBy(asc(meetingAttendees.id));
  for (const row of rows) {
    const list = byMeeting.get(row.meetingId);
    if (list === undefined) byMeeting.set(row.meetingId, [toAttendee(row)]);
    else list.push(toAttendee(row));
  }
  return byMeeting;
}

/**
 * "This event row records a task being created from a meeting" -- the ONE
 * criterion tying a task back to the meeting it came from, shared by the
 * count below and the detail payload's task list so the two can never
 * disagree about what they are counting and listing.
 *
 * The link lives in `events` and nowhere else: no column on `tasks` (that
 * would be a second source of truth for a fact the event already records --
 * see Task 3, which owns the write). `verb = 'created'` is what makes it a
 * CREATION rather than any later event that happens to carry both ids.
 */
const taskCreatedFromMeeting = and(eq(events.verb, "created"), isNotNull(events.taskId))!;

/**
 * Follow-up task counts for a page of meetings, one grouped select.
 *
 * COUNT(DISTINCT task_id), not COUNT(*): one task must count once however
 * many creation rows ever name it. Archived tasks still count -- the event
 * says the meeting produced the task, and archiving one does not un-create
 * it, so this number and the detail payload's task list stay the same set.
 *
 * MEASURE THIS when Task 3 starts writing the rows it reads: events.meeting_id
 * carries no index (Task 1's DONE block), on the table Task 4 is about to add
 * mail rows to.
 */
async function loadTaskCounts(db: Database, meetingIds: string[]): Promise<Map<string, number>> {
  const byMeeting = new Map<string, number>();
  if (meetingIds.length === 0) return byMeeting;
  const rows = await db.select({
    meetingId: events.meetingId,
    count: sql<number>`count(DISTINCT ${events.taskId})::int`,
  }).from(events)
    .where(and(inArray(events.meetingId, meetingIds), taskCreatedFromMeeting))
    .groupBy(events.meetingId);
  for (const row of rows) {
    if (row.meetingId !== null) byMeeting.set(row.meetingId, row.count);
  }
  return byMeeting;
}

/** The follow-up tasks one meeting produced, under taskCreatedFromMeeting's
 * criterion. Oldest first, which is the order they were added in. */
async function loadMeetingTasks(db: Database, meetingId: string): Promise<Task[]> {
  const rows = await db.select().from(tasks)
    .where(sql`EXISTS (SELECT 1 FROM ${events} WHERE ${events.taskId} = ${tasks.id} AND ${events.meetingId} = ${meetingId} AND ${taskCreatedFromMeeting})`)
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  return rows.map(toTask);
}

/** One meeting, hydrated: its attendees and its follow-up task count. */
async function hydrate(db: Database, row: MeetingRow): Promise<Meeting> {
  const [attendees, counts] = await Promise.all([
    loadAttendees(db, [row.id]),
    loadTaskCounts(db, [row.id]),
  ]);
  return toMeeting(row, attendees.get(row.id) ?? [], counts.get(row.id) ?? 0);
}

// --- Input normalisation ---------------------------------------------------

/**
 * `notes` is rich-text HTML from the log form, run through the system's ONE
 * shared sanitizer profile -- mail-content.ts's sanitizeMailHtml, which
 * email_templates.body_html already reuses. notes.body is NOT the precedent
 * despite the spec's wording: it is plain text and passes through no
 * sanitizer at all. No cidMap: a meeting note has no attachments, so an
 * `<img src="cid:...">` pasted into one is dropped exactly as an unmapped cid
 * is at ingest.
 *
 * Markup that sanitizes away to nothing becomes NULL, deliberately NOT the
 * 409 mail-templates.ts's sanitizeBody raises for the same condition: that
 * column is non-nullable `.min(1)` ("a template that renders as nothing is
 * not a template"), while meetings.notes is nullable and a meeting with no
 * notes is completely ordinary. "" is not a storable value either way --
 * meetingSchema's notes is nullableString -- so empty must become null, not
 * "".
 */
function sanitizeNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const sanitized = sanitizeMailHtml(notes);
  return sanitized.trim() === "" ? null : sanitized;
}

/** The three identity columns of one attendee row, as this file writes them. */
interface AttendeeValues { contactId: string | null; userId: string | null; guestName: string | null; }

/**
 * The wire attendee shape (three optional fields) as insertable values (three
 * nullable ones), with guest names trimmed.
 *
 * The trim matters because meeting_attendees_exactly_one counts non-nulls and
 * "   " is not null: an untrimmed blank would satisfy both the CHECK and
 * `.min(1)` and store a nameless attendee. @conduit/shared's guestName trims
 * before its own `.min(1)`, so a blank one is a 400 at the route; this is the
 * backstop for a direct service caller, which sees the exactly-one
 * re-assertion below instead (createTask's precedent for a rule zod already
 * enforces at the HTTP boundary).
 */
function toAttendeeValues(input: MeetingAttendeeInput[]): AttendeeValues[] {
  return input.map((attendee) => {
    const guestName = attendee.guestName?.trim();
    const values: AttendeeValues = {
      contactId: attendee.contactId ?? null,
      userId: attendee.userId ?? null,
      guestName: guestName === undefined || guestName === "" ? null : guestName,
    };
    if ([values.contactId, values.userId, values.guestName].filter((x) => x !== null).length !== 1) {
      throw new Error("meeting attendee: exactly one of contactId, userId or guestName identifies an attendee");
    }
    return values;
  });
}

/**
 * Existence-only, deals.ts's rule rather than notes.ts's assertNoteTargetActive:
 * a meeting goes on referencing the records it was about for its whole
 * lifecycle, and logging a meeting that HAPPENED with a company since archived
 * is an ordinary thing to do -- archiving hides a record from default
 * listings, it does not sever links pointed at it. Without these reads a bogus
 * id would surface as a foreign-key violation, i.e. a 500 where a 404 belongs.
 *
 * Read outside the transaction, the same monotonic-existence guarantee
 * deals.ts documents: nothing in this schema is ever hard-deleted, so an
 * existence check cannot go stale.
 */
async function assertLinkedRecordsExist(
  db: Database,
  links: { companyId?: string | null; contactId?: string | null; dealId?: string | null; projectId?: string | null },
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
}

/** Same reason as assertLinkedRecordsExist: an attendee naming a contact or
 * user that does not exist is a 404, not a foreign-key 500. One query per
 * side for the whole set, never one per attendee. */
async function assertAttendeeIdentitiesExist(db: Database, attendees: AttendeeValues[]): Promise<void> {
  const contactIds = [...new Set(attendees.map((a) => a.contactId).filter((id): id is string => id !== null))];
  if (contactIds.length > 0) {
    const found = await db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, contactIds));
    const missing = contactIds.find((id) => !found.some((row) => row.id === id));
    if (missing !== undefined) throw new NotFoundError("contact", missing);
  }
  const userIds = [...new Set(attendees.map((a) => a.userId).filter((id): id is string => id !== null))];
  if (userIds.length > 0) {
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
    const missing = userIds.find((id) => !found.some((row) => row.id === id));
    if (missing !== undefined) throw new NotFoundError("user", missing);
  }
}

// drizzle-orm wraps every driver error in a DrizzleQueryError; the original
// postgres.js PostgresError (carrying the actual Postgres error code) sits on
// its `.cause`, not on the wrapper itself. Mirrors the identical helper in
// mail-accounts.ts and tasks.ts (not shared across files -- neither of those
// is shared with the other).
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === "23505";
}

const DUPLICATE_ATTENDEE_MESSAGE =
  "the same contact or user is listed twice among this meeting's attendees";

/**
 * meeting_attendees' two partial unique indexes (drizzle/0008) reject a
 * contact or user added twice to one meeting. Guests are deliberately not
 * deduped (free text: two people can share a first name), so only these two
 * can fire. 409 rather than a 400 for mail-accounts.ts's reason: the
 * submission was well-formed, it is the stored set it conflicts with.
 *
 * The DB is the detector rather than a pre-pass over the input, because it is
 * also the only thing that can catch two concurrent writers adding the same
 * contact. `meetingId` only feeds ConflictError's default message, which this
 * call overrides -- createMeeting has no id to name, its insert having rolled
 * back with the transaction.
 */
function rethrowAttendeeConflict(err: unknown, meetingId: string): never {
  if (isUniqueViolation(err)) throw new ConflictError("meeting", meetingId, DUPLICATE_ATTENDEE_MESSAGE);
  throw err;
}

/**
 * Everything an events row copies off a meeting: its four record FKs, the
 * meeting pointer, and the payload the timeline renders from.
 *
 * LINKS. No dual-stamp, unlike notes.ts/deals.ts (which infer a deal's company
 * because a note names exactly ONE target): a meeting names every record it
 * belongs to -- the log form requires at least one and offers all four -- so
 * there is nothing to infer. It also keeps the two surfaces consistent: a
 * deal-only meeting is on the deal's Meetings tab and the deal's timeline and
 * on neither of the company's, because listMeetings' company filter is a
 * plain FK match on the same four columns.
 *
 * PAYLOAD. The title, on all three verbs a meeting emits, because the web
 * timeline renders EXCLUSIVELY from the payload and every other content verb
 * stamps what it needs there -- notes.ts's {noteId, preview}, files.ts's
 * {fileId, originalName}, deals.ts's {fromName, toName} ("so this never needs
 * a second round trip to resolve a name"). Event rows are append-only
 * history: a row written without its render data renders blank forever, and
 * no later fix can repair the rows already stored.
 *
 * `archived`/`unarchived` carry it too, not just `met`, even though those
 * verbs stamp an empty payload for every other record type. The reason is
 * that only here is the subject ambiguous: a company's archive entry sits on
 * that company's own timeline, while "a meeting was archived" lands on a
 * record that may have dozens of meetings, and the reader cannot tell which
 * one without exactly the round trip the idiom forbids. Nothing beyond the
 * title goes in -- the notes stay in the meeting, where the record's
 * Meetings tab reads them.
 */
function meetingEventValues(row: MeetingRow) {
  return {
    companyId: row.companyId, contactId: row.contactId,
    dealId: row.dealId, projectId: row.projectId, meetingId: row.id,
    payload: { title: row.title },
  };
}

async function mustGet(db: Database, id: string): Promise<MeetingRow> {
  const [row] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (row === undefined) throw new NotFoundError("meeting", id);
  return row;
}

// --- Writes ----------------------------------------------------------------

export async function createMeeting(db: Database, actorId: string, input: MeetingCreateInput): Promise<Meeting> {
  // meetingCreateInputSchema's superRefine already enforces this at the HTTP
  // boundary; re-asserted here for a direct service caller that builds the
  // input by hand and bypasses zod (createTask's precedent for taskDatesPaired).
  // Without it the meetings_has_link CHECK raises 23514 as a 500.
  if (!meetingAtLeastOneLink(input)) {
    throw new Error("createMeeting: at least one of companyId, contactId, dealId or projectId is required");
  }
  const attendeeValues = toAttendeeValues(input.attendees ?? []);
  await assertLinkedRecordsExist(db, input);
  await assertAttendeeIdentitiesExist(db, attendeeValues);
  const notes = sanitizeNotes(input.notes);

  let meeting: Meeting;
  try {
    meeting = await db.transaction(async (tx) => {
      const [row] = await tx.insert(meetings).values({
        title: input.title,
        occurredAt: new Date(input.occurredAt),
        durationMinutes: input.durationMinutes ?? null,
        notes,
        // The owner is the actor, never a caller-supplied field (the rule
        // notes' authorUserId and files' uploaderUserId already follow).
        ownerUserId: actorId,
        companyId: input.companyId ?? null, contactId: input.contactId ?? null,
        dealId: input.dealId ?? null, projectId: input.projectId ?? null,
      }).returning();
      if (row === undefined) throw new Error("insert returned no row");

      const attendeeRows: MeetingAttendeeRow[] = attendeeValues.length === 0 ? [] : await tx
        .insert(meetingAttendees)
        .values(attendeeValues.map((values) => ({ ...values, meetingId: row.id })))
        .returning();

      await tx.insert(events).values({
        verb: "met", actorUserId: actorId, ...meetingEventValues(row),
      });
      // Sorted by id to match loadAttendees' ordering, so one meeting reads
      // identically whether it came back from this insert or from a later
      // fetch. Byte comparison rather than localeCompare, because that is what
      // Postgres's uuid ORDER BY is: canonical uuid text is the lowercase hex
      // of those same bytes, with the hyphens at fixed positions.
      //
      // taskCount is 0 by construction, not by query: nothing can have created
      // a follow-up task from a meeting that did not exist until now.
      const attendees = attendeeRows.map(toAttendee)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return toMeeting(row, attendees, 0);
    });
  } catch (err) {
    rethrowAttendeeConflict(err, "(new)");
  }
  publishMeetingHint(meeting.id);
  return meeting;
}

/**
 * A meeting plus the follow-up tasks it produced -- the detail payload, the
 * same split mail keeps between mailThreadSchema and mailThreadDetailSchema.
 * `taskCount` on the meeting is the loaded list's length rather than a second
 * query: one criterion, one snapshot, so the number and the list cannot
 * contradict each other.
 */
export async function getMeeting(db: Database, id: string): Promise<MeetingDetail> {
  const row = await mustGet(db, id);
  const [attendees, meetingTasks] = await Promise.all([
    loadAttendees(db, [row.id]),
    loadMeetingTasks(db, row.id),
  ]);
  return {
    meeting: toMeeting(row, attendees.get(row.id) ?? [], meetingTasks.length),
    tasks: meetingTasks,
  };
}

/**
 * NO `updated` EVENT, unlike companies/contacts/deals/projects/tasks -- which
 * is why `actorId` is taken and not read. The spec names exactly three
 * emissions for a meeting: `met` on create, and the existing
 * `archived`/`unarchived` verbs. A record's timeline tells the story of what
 * HAPPENED with that record, and correcting the notes or the duration on a
 * meeting already in that story is not a second meeting -- while an editable
 * record like a deal has no such "the thing itself happened" entry, so its
 * edits ARE its timeline. The parameter stays because every other mutator in
 * this codebase takes the actor in that position, and a route calling
 * `updateMeeting(db, id, patch)` next to `createMeeting(db, user.id, input)`
 * would read as a bug; Task 3 is the next caller that may want it.
 */
export async function updateMeeting(
  db: Database, actorId: string, id: string, patch: MeetingUpdateInput,
): Promise<Meeting> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("meeting", id);

  // THE MERGED ROW, not the patch: meetingUpdateInputSchema deliberately
  // carries no at-least-one-link refine (a patch sees one snapshot, never its
  // persisted counterpart), so clearing companyId on a meeting that also
  // carries a dealId is legitimate while clearing the LAST link is not, and
  // only this comparison can tell them apart. Through the exported predicate,
  // never a second copy of it. Without this the meetings_has_link CHECK fires
  // and a 4xx arrives as a 500.
  const merged = {
    companyId: patch.companyId !== undefined ? patch.companyId : existing.companyId,
    contactId: patch.contactId !== undefined ? patch.contactId : existing.contactId,
    dealId: patch.dealId !== undefined ? patch.dealId : existing.dealId,
    projectId: patch.projectId !== undefined ? patch.projectId : existing.projectId,
  };
  if (!meetingAtLeastOneLink(merged)) {
    throw new ConflictError(
      "meeting", id,
      "a meeting must keep at least one company, contact, deal or project link; "
      + "set another link in the same patch, or archive the meeting instead",
    );
  }
  await assertLinkedRecordsExist(db, patch);

  const attendeeValues = patch.attendees === undefined ? null : toAttendeeValues(patch.attendees);
  if (attendeeValues !== null) await assertAttendeeIdentitiesExist(db, attendeeValues);

  // An empty patch is a true no-op (companies.ts's rule), down to leaving
  // updatedAt alone. A SAME-VALUE patch is deliberately not chased the way
  // companies.ts chases it: there is no `updated` event here for a spurious
  // entry to lie in (see this function's header), so the only cost is an
  // updatedAt bump, and an attendee SET replacement has no cheap same-value
  // comparison to make the check honest for the field that most needs it.
  if (Object.values(patch).every((value) => value === undefined)) return hydrate(db, existing);

  const values: Partial<typeof meetings.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.occurredAt !== undefined) values.occurredAt = new Date(patch.occurredAt);
  if (patch.durationMinutes !== undefined) values.durationMinutes = patch.durationMinutes;
  if (patch.notes !== undefined) values.notes = sanitizeNotes(patch.notes);
  if (patch.companyId !== undefined) values.companyId = patch.companyId;
  if (patch.contactId !== undefined) values.contactId = patch.contactId;
  if (patch.dealId !== undefined) values.dealId = patch.dealId;
  if (patch.projectId !== undefined) values.projectId = patch.projectId;

  let updated: MeetingRow;
  try {
    updated = await db.transaction(async (tx) => {
      // archived_at IS NULL in the WHERE makes the guard atomic, exactly as
      // companies.ts's updateCompany does: a concurrent archive between the
      // mustGet above and this UPDATE yields zero rows here instead of
      // silently mutating an archived meeting.
      const [row] = await tx.update(meetings).set(values)
        .where(and(eq(meetings.id, id), isNull(meetings.archivedAt))).returning();
      if (row === undefined) {
        const [recheck] = await tx.select().from(meetings).where(eq(meetings.id, id));
        throw recheck === undefined ? new NotFoundError("meeting", id) : new ArchivedError("meeting", id);
      }

      // Attendees replace as a SET when present, and are untouched when
      // absent (spec: "attendees replaced as a set on update"; the input
      // shape carries no attendee id, so a client cannot address one row).
      // Delete-all-then-insert rather than delete-not-in + insert-missing:
      // both are one statement per side, this one is obviously correct
      // without a diff to reason about, and re-inserting an identity just
      // deleted cannot trip the partial uniques because both statements run
      // in this transaction and the second sees the first. The cost is that
      // unchanged attendees get new row ids, which nothing references -- no
      // FK points at meeting_attendees.id and no client sends it back.
      if (attendeeValues !== null) {
        await tx.delete(meetingAttendees).where(eq(meetingAttendees.meetingId, id));
        if (attendeeValues.length > 0) {
          await tx.insert(meetingAttendees)
            .values(attendeeValues.map((attendee) => ({ ...attendee, meetingId: id })));
        }
      }
      // No event: see this function's header for why a meeting edit writes no
      // timeline entry.
      return row;
    });
  } catch (err) {
    rethrowAttendeeConflict(err, id);
  }
  publishMeetingHint(id);
  return hydrate(db, updated);
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Meeting> {
  await mustGet(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (the state
  // already matched what was requested, so nothing changed) -- that branch
  // must not publish, same as companies.ts's setArchived.
  const { row, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe:
    // archiving requires the row currently unarchived and vice versa. Zero
    // rows back means the state already matched, so re-select and return the
    // current row rather than emitting a duplicate event.
    const [updated] = await tx.update(meetings)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(meetings.id, id),
        archived ? isNull(meetings.archivedAt) : isNotNull(meetings.archivedAt),
      )).returning();
    if (updated === undefined) {
      const [recheck] = await tx.select().from(meetings).where(eq(meetings.id, id));
      if (recheck === undefined) throw new NotFoundError("meeting", id);
      return { row: recheck, wrote: false };
    }
    // The existing archived/unarchived verbs, carrying the meeting's own
    // record FKs, meetingId and title (meetingEventValues) so the entry lands
    // on the same timelines its `met` entry did, links back to the same
    // meeting, and says WHICH meeting was filed away.
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId,
      ...meetingEventValues(updated),
    });
    return { row: updated, wrote: true };
  });
  if (wrote) publishMeetingHint(id);
  return hydrate(db, row);
}
export const archiveMeeting = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveMeeting = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

// --- List ------------------------------------------------------------------

/** The shared filter contract IS the options type -- no third hand-written
 * shape to drift from the wire (meetingListFiltersSchema) and from the
 * route's querystring mapping. mail-threads.ts's ListThreadsOptions does the
 * same. */
export type ListMeetingsOptions = MeetingListFilters;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The rail tab's list. Keyset paginated by (occurred_at, id) DESCENDING --
 * NOT created_at like the Phase 1-3 lists -- because a meetings list is about
 * when the meeting HAPPENED: ordering by creation would put "logged today
 * about last month" above "logged yesterday about tomorrow". That ordering
 * has its own cursor type for the reason pagination.ts's header gives.
 *
 * CONTACT ATTENDANCE WIDENS THE CONTACT FILTER, and that one arm is what
 * makes the spec's "attendees are real links" true: a contact's Meetings tab
 * lists meetings whose contact_id is C **OR** which have an attendee row for
 * C. The other three filters are plain FK matches. The EXISTS is one term
 * OR-ed onto the same clause rather than a second independent predicate, and
 * it probes meeting_attendees' (contact_id, meeting_id) partial unique index
 * (drizzle/0008, whose identity-leading column order exists for this).
 */
export async function listMeetings(
  db: Database, opts: ListMeetingsOptions = {},
): Promise<{ items: Meeting[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const where = [opts.archived ? isNotNull(meetings.archivedAt) : isNull(meetings.archivedAt)];
  if (opts.companyId) where.push(eq(meetings.companyId, opts.companyId));
  if (opts.contactId) {
    // Non-null assertion: `or` only returns undefined when given zero
    // conditions, and both branches here are unconditional. Same note as
    // companies.ts's -- do not make either branch optional without
    // rechecking.
    where.push(or(
      eq(meetings.contactId, opts.contactId),
      sql`EXISTS (SELECT 1 FROM ${meetingAttendees} WHERE ${meetingAttendees.meetingId} = ${meetings.id} AND ${meetingAttendees.contactId} = ${opts.contactId})`,
    )!);
  }
  if (opts.dealId) where.push(eq(meetings.dealId, opts.dealId));
  if (opts.projectId) where.push(eq(meetings.projectId, opts.projectId));
  const cur = opts.cursor ? decodeOccurredAtCursor(opts.cursor) : null;
  if (cur) {
    where.push(or(
      lt(meetings.occurredAt, new Date(cur.occurredAt)),
      and(eq(meetings.occurredAt, new Date(cur.occurredAt)), lt(meetings.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(meetings).where(and(...where))
    .orderBy(desc(meetings.occurredAt), desc(meetings.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  // Two queries for the whole page, never one per row: the hydration shape
  // loadAttendees documents.
  const ids = page.map((row) => row.id);
  const [attendees, taskCounts] = await Promise.all([loadAttendees(db, ids), loadTaskCounts(db, ids)]);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toMeeting(row, attendees.get(row.id) ?? [], taskCounts.get(row.id) ?? 0)),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id }) : null,
  };
}
