import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Event } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { events, mailThreads, meetingAttendees, type EventRow } from "../db/schema.js";
import { notHiddenByViewer, visibleThreads } from "./mail-threads.js";
import { decodeCursor, encodeCursor } from "./pagination.js";

function toEvent(row: EventRow, mailSubject: string | null): Event {
  return {
    id: row.id, verb: row.verb as Event["verb"], actorUserId: row.actorUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    taskId: row.taskId, projectId: row.projectId,
    // Phase 5's two pointers, passed straight through.
    meetingId: row.meetingId, mailThreadId: row.mailThreadId,
    // Not a stored field: the joined thread's live subject, which only a row
    // that satisfied both mail predicates can carry (see listEvents). The
    // parameter comes from the SAME select that filtered the row, never from
    // a second lookup -- a lookup outside that join would be a second place
    // the visibility rule has to be right.
    mailSubject,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListEventsOptions {
  companyId?: string; contactId?: string; dealId?: string; taskId?: string; projectId?: string;
  cursor?: string; limit?: number;
}

/**
 * A record's timeline, newest first, for ONE VIEWER.
 *
 * `viewerId` is a positional parameter rather than a field on
 * ListEventsOptions, and that is a deliberate defence rather than a style
 * choice: an optional field could be forgotten at a call site and the
 * function would still compile, silently answering with someone else's mail
 * on the timeline. Positional and required means the compiler names every
 * caller. Every caller has one -- routes/events.ts holds `requireUser`'s
 * User, which covers the record rails, the project timeline and the task
 * drawer alike (they are all the same GET /api/events with a different
 * filter).
 *
 * MAIL ROWS ARE POINTERS AND ARE FILTERED HERE (Phase 5 spec's mail-privacy
 * decision). An event carrying mail_thread_id stores nothing about the mail
 * but the thread's id (mail-ingest.ts writes an empty payload); this query
 * joins mail_threads under Phase 4.2's record-visible predicate composed with
 * Phase 4.3's not-hidden predicate, and:
 *
 *   - a thread the viewer may not see, or has hidden, contributes NO ROW AT
 *     ALL. Not a redacted stub: an "activity you cannot see" entry would leak
 *     both the existence and the timing of someone else's private mail, which
 *     is precisely what v0.7.0 made private and v0.8.0 let each viewer file
 *     away.
 *   - a visible thread renders mail_threads.subject live, through the join
 *     the predicate gates.
 *
 * RECORD scope, not inbox (mail-threads.ts's two-scope table): a timeline is
 * a CRM surface exactly as a record's Mail tab is, so a thread someone
 * deliberately linked to a deal or project belongs on that record's story
 * even though it is not in this viewer's mailbox -- while their unlinked, or
 * merely auto-contact-linked, mail stays off it. THREAD granularity is the
 * right one here for the same reason listThreads uses it: what this row
 * renders is a thread-level fact (the subject the thread took from its first
 * message), never a message's content.
 *
 * THE PREDICATES RIDE THE JOIN'S ON CLAUSE, not a separate WHERE term, and
 * the shape is load-bearing twice over. Correctness: the subject can only be
 * read from a row the predicate admitted, so the exclusion rule and the
 * rendering rule cannot come apart -- there is no arrangement of this query
 * in which a filtered-out thread still hands over its subject. Pagination:
 * both live in the statement, so exclusion happens BEFORE the LIMIT and a
 * page is never short and its cursor never skips (the 4.3 lesson -- a filter
 * applied to a fetched page returns short pages and mints a cursor past rows
 * the viewer never saw).
 *
 * THE ON CLAUSE IS ALSO THE ONLY FORM THAT KEEPS THE SCAN PARALLEL, which is
 * the same trap Task 2's `IN` rewrite climbed out of one arm above, and it was
 * MEASURED rather than assumed -- `events` is the fastest-growing table in
 * this schema and it ships no index a record filter can use. Dataset: 300,000
 * events of which 30,000 carry mail_thread_id, over 2,000 threads / 6,000
 * messages / 2 PRIVATE accounts owned by two users (the narrowest
 * configuration, where the visibility term restricts hardest -- 0006's
 * methodology), 250 hides for the viewer, one thread in four carrying the
 * deliberate project link that widens. Warm, top-level Execution Time, median
 * of four runs:
 *   - THIS SHAPE, unfiltered newest page (the worst case -- every candidate
 *     row is a candidate): 56ms, Gather Merge with 2 workers over a Parallel
 *     Seq Scan, 8,087 buffers. The pre-Task-4 baseline for the same page with
 *     no mail join at all is 46ms / 4,167.
 *   - THIS SHAPE as a record rail actually issues it (company filter): 35ms,
 *     same parallel plan, 4,474 buffers -- indistinguishable from that
 *     filter's own pre-Task-4 baseline of 35ms / 4,167. The rail pays
 *     nothing measurable; only the unfiltered shape shows the join.
 *   - The alternative that keeps the join clean and puts an uncorrelated
 *     `mail_thread_id IN (SELECT id FROM mail_threads WHERE ...)` in the
 *     WHERE: 153ms and SERIAL. The subquery's own correlated EXISTS terms
 *     make the hashed SubPlan parallel-restricted, so the whole scan
 *     degrades -- and it writes the rule twice (the WHERE excludes, the join
 *     renders) with nothing tying the two together.
 *   - A correlated `EXISTS (SELECT 1 FROM mail_threads WHERE id =
 *     events.mail_thread_id AND ...)` in the WHERE: 779ms and SERIAL, 14x
 *     this shape.
 * Do not fold the ON-clause terms into the WHERE in either form.
 */
export async function listEvents(
  db: Database, viewerId: string, opts: ListEventsOptions,
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
  // THIS OR IS NOT A PLAIN EQUALITY AND MUST NOT BECOME ONE: collapsing it
  // to `events.contact_id = C` silently empties an attendee-only contact's
  // timeline. Two tests hold it (timeline.test.ts's widening case and its
  // follow-up-task companion). The mail predicate below composes as one more
  // term over this same WHERE, alongside this arm rather than through it --
  // that is the shape any further filter should take too.
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
  // The mail arm. A row with no mail_thread_id is every note, file, stage
  // change, task transition and meeting entry in the table -- untouched by
  // this, and by the join above it, which can only ever match on a non-null
  // pointer. A row WITH one survives only if the join found its thread, and
  // the join only matches a thread both predicates admit.
  //
  // Written against the JOINED row (`mail_threads.id IS NOT NULL`) rather
  // than by repeating the predicates here: one statement of the rule, in the
  // ON clause, testable by mutation. See the header.
  where.push(or(isNull(events.mailThreadId), isNotNull(mailThreads.id))!);
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
  const rows = await db.select({ event: events, mailSubject: mailThreads.subject })
    .from(events)
    // At most one thread per event (the join is on mail_threads' primary
    // key), so this can neither multiply page rows nor disturb the keyset --
    // the same property listThreads' hide join relies on.
    .leftJoin(mailThreads, and(
      eq(mailThreads.id, events.mailThreadId),
      // Both helpers correlate against mail_threads BY NAME and require it
      // un-aliased in the composing query (their headers state the
      // precondition; nothing enforces it at compile time). It is un-aliased
      // here -- this join is the only mail_threads in the statement.
      visibleThreads(viewerId, "record"),
      notHiddenByViewer(viewerId),
    ))
    .where(and(...where))
    .orderBy(desc(events.createdAt), desc(events.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toEvent(row.event, row.mailSubject)),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.event.createdAt.toISOString(), id: last.event.id }) : null,
  };
}
