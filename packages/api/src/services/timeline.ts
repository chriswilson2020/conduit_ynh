import { and, desc, eq, lt, or, sql } from "drizzle-orm";
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
  // events.meeting_id is NULL on every non-meeting row, so the EXISTS is
  // never true for them and no other verb's behaviour changes.
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
      sql`EXISTS (SELECT 1 FROM ${meetingAttendees} WHERE ${meetingAttendees.meetingId} = ${events.meetingId} AND ${meetingAttendees.contactId} = ${opts.contactId})`,
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
