import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Event } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { events, meetingAttendees, type EventRow } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "./pagination.js";

function toEvent(row: EventRow): Event {
  return {
    id: row.id, verb: row.verb as Event["verb"], actorUserId: row.actorUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    taskId: row.taskId, projectId: row.projectId,
    // Phase 5's two pointers, passed straight through. No row carries a
    // mailThreadId until Task 4's ingest emission exists, and that task owns
    // the read-time rule that comes with it: a row whose thread the viewer
    // may not see (4.2 visibility composed with 4.3 hides) is dropped from
    // the result entirely, before the limit -- never surfaced with its
    // pointer, never stubbed. Nothing may start emitting mail events without
    // that filter landing in the same change.
    meetingId: row.meetingId, mailThreadId: row.mailThreadId,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListEventsOptions {
  companyId?: string; contactId?: string; dealId?: string; taskId?: string; projectId?: string;
  cursor?: string; limit?: number;
}

export async function listEvents(
  db: Database, opts: ListEventsOptions,
): Promise<{ items: Event[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const where = [];
  if (opts.companyId) where.push(eq(events.companyId, opts.companyId));
  // CONTACT ATTENDANCE WIDENS THE CONTACT TIMELINE, exactly as it widens the
  // contact's Meetings tab (services/meetings.ts's listMeetings): an event
  // matches when events.contact_id is C **OR** the meeting the event points at
  // has C as an attendee. Without this arm a meeting logged on company A with
  // C attending appears on C's Meetings tab and on no timeline at all, while
  // the spec promises both surfaces.
  //
  // WIDENED AT READ TIME, NEVER BY FANNING OUT EVENT ROWS. One `met` row per
  // meeting stays the truth: writing an extra row per attendee would put N
  // copies of the same entry on that meeting's company/deal timelines (each
  // fanned-out row carrying the meeting's company_id too), and "attendance is
  // a real link" would then exist as two rules -- a write-time one here and
  // the read-time one in listMeetings -- that could drift apart. This is the
  // same rule, expressed the same way, in both places.
  //
  // WHICH ROWS THE ARM REACHES: the meeting's OWN lifecycle rows, and only
  // those -- `task_id IS NULL` is what says so. events.meeting_id is NULL on
  // every note/file/stage-change row, so those never matched anyway; the
  // exception is the follow-up task Task 3 creates from a meeting, whose
  // `created` event carries BOTH task_id and meeting_id (services/meetings.ts's
  // taskCreatedFromMeeting reads exactly that pair). On such a row meeting_id
  // is PROVENANCE, not subject: the row is about the task, which reaches
  // timelines through its own links, and an attendee seeing task activity she
  // is not on is noise rather than the meeting she attended. So the widening
  // carries the meeting to her record; it does not carry everything the
  // meeting spawned.
  //
  // `IN`, NOT A CORRELATED `EXISTS`, and that is a MEASURED choice rather
  // than a stylistic one: a correlated subquery referencing the outer row is
  // not parallel-safe, so it downgrades this scan to serial on the one table
  // in this schema with no record-FK indexes. Measured at 300,005 events /
  // 50,000 meetings / 150,000 attendees (warm, top-level Execution Time):
  // EXISTS 162.7ms serial vs IN 44.8ms with two parallel workers, identical
  // rows out of both. `IN` inside an `OR` has no NULL trap here -- a NULL
  // meeting_id yields NULL, which is not true, which is what the EXISTS did
  // too. Do not fold it back.
  //
  // (listMeetings' own attendance arm correlates on meetings.id and cannot be
  // written this way; it needs nothing -- 312 buffers / 2.9ms at 20k
  // meetings.)
  //
  // TASK 4 MUST PRESERVE THIS ARM when it rewrites this function for the mail
  // pointer: the mail filtering is an additional predicate over the same
  // WHERE, and replacing this OR with a plain equality would silently empty
  // an attendee-only contact's timeline again.
  if (opts.contactId) {
    // Non-null assertion: `or` only returns undefined when given zero
    // conditions; both branches here are unconditional. Same note as the
    // cursor's below.
    where.push(or(
      eq(events.contactId, opts.contactId),
      and(
        sql`${events.meetingId} IN (SELECT ${meetingAttendees.meetingId} FROM ${meetingAttendees} WHERE ${meetingAttendees.contactId} = ${opts.contactId})`,
        isNull(events.taskId),
      ),
    )!);
  }
  if (opts.dealId) where.push(eq(events.dealId, opts.dealId));
  if (opts.taskId) where.push(eq(events.taskId, opts.taskId));
  if (opts.projectId) where.push(eq(events.projectId, opts.projectId));
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    // Non-null assertion: `or` only returns undefined when given zero conditions.
    // Both branches here are always present, so this is safe as written, but it
    // stops being safe if a future edit makes either branch conditional. Do not
    // extend this call with an optional/conditional argument without rechecking.
    where.push(or(
      lt(events.createdAt, new Date(cur.createdAt)),
      and(eq(events.createdAt, new Date(cur.createdAt)), lt(events.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(events).where(and(...where))
    .orderBy(desc(events.createdAt), desc(events.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toEvent),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
