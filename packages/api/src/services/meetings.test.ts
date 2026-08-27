import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, meetingAttendees } from "../db/schema.js";
import {
  createMeeting, getMeeting, updateMeeting, archiveMeeting, unarchiveMeeting, listMeetings,
  createMeetingTask,
} from "./meetings.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";
import { createProject, archiveProject } from "./projects.js";
import { createTask, updateTask, archiveTask, listTasks } from "./tasks.js";
import { listEvents } from "./timeline.js";
import { subscribe } from "./sse.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

/** A moment in the past, so a test can order meetings relative to each other
 * without depending on when it runs. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("meetings service", () => {
  it("creates a meeting with its attendees and lands one `met` event on every linked record", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana", companyId: company.id });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }, "EUR",
    );

    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), durationMinutes: 45,
      companyId: company.id, dealId: deal.id,
      attendees: [{ contactId: contact.id }, { userId: actorId }, { guestName: "Their lawyer" }],
    });

    expect(meeting.title).toBe("Kickoff");
    expect(meeting.ownerUserId).toBe(actorId);
    expect(meeting.durationMinutes).toBe(45);
    expect(meeting.taskCount).toBe(0);
    expect(meeting.attendees).toHaveLength(3);
    expect(meeting.attendees.map((a) => a.meetingId)).toEqual([meeting.id, meeting.id, meeting.id]);
    expect(new Set(meeting.attendees.map((a) => a.contactId ?? a.userId ?? a.guestName)))
      .toEqual(new Set([contact.id, actorId, "Their lawyer"]));

    const met = await handle.db.select().from(events).where(eq(events.verb, "met"));
    expect(met).toHaveLength(1);
    expect(met[0]?.meetingId).toBe(meeting.id);
    expect(met[0]?.companyId).toBe(company.id);
    expect(met[0]?.dealId).toBe(deal.id);
    expect(met[0]?.contactId).toBeNull();
    // The timeline renders exclusively from the payload (web:
    // rail/timeline.tsx's summarize), and event rows are append-only history:
    // a row written without its render data renders blank forever.
    expect(met[0]?.payload).toEqual({ title: "Kickoff" });
  });

  // The zod refine is the gate for this rule (a 400 at the route, pinned in
  // routes.test.ts); a direct service caller bypassing zod must still not
  // reach the meetings_has_link CHECK, which would surface as a 500.
  it("refuses an unlinked meeting before the CHECK can fire", async () => {
    await expect(createMeeting(handle.db, actorId, { title: "Nowhere", occurredAt: daysAgo(1) }))
      .rejects.toThrow(/at least one of companyId/);
  });

  // The other CHECK's twin: exactly one identity per attendee.
  it("refuses an attendee naming zero or two identities before the CHECK can fire", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana" });
    for (const attendee of [{}, { contactId: contact.id, guestName: "Also them" }]) {
      await expect(createMeeting(handle.db, actorId, {
        title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id, attendees: [attendee],
      })).rejects.toThrow(/exactly one of contactId/);
    }
  });

  it("404s on an unknown record link or an unknown attendee identity instead of a foreign-key 500", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await expect(createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: UNKNOWN_ID,
    })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: UNKNOWN_ID }],
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("trims a padded guest name before storing it", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ guestName: "  Their lawyer  " }],
    });
    expect(meeting.attendees[0]?.guestName).toBe("Their lawyer");
    const [stored] = await handle.db.select().from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, meeting.id));
    expect(stored?.guestName).toBe("Their lawyer");
  });

  // meeting_attendees' partial uniques (drizzle/0008) are the detector; the
  // service maps 23505 onto a domain error so the route answers 409, not 500.
  it("rejects the same contact twice on one meeting as a ConflictError, on create and on update", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana" });
    await expect(createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: contact.id }, { contactId: contact.id }],
    })).rejects.toBeInstanceOf(ConflictError);
    // Nothing survived the rolled-back transaction.
    expect((await listMeetings(handle.db, {})).items).toHaveLength(0);

    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
    });
    await expect(updateMeeting(handle.db, actorId, meeting.id, {
      attendees: [{ contactId: contact.id }, { contactId: contact.id }],
    })).rejects.toBeInstanceOf(ConflictError);

    // Two guests sharing a name are NOT deduped: guest names are free text.
    const guests = await updateMeeting(handle.db, actorId, meeting.id, {
      attendees: [{ guestName: "Sam" }, { guestName: "Sam" }],
    });
    expect(guests.attendees).toHaveLength(2);
  });

  it("replaces the attendee set on update: add, remove, replace with empty, and leave alone when absent", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    const sam = await createContact(handle.db, actorId, { firstName: "Sam" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: dana.id }],
    });

    const added = await updateMeeting(handle.db, actorId, meeting.id, {
      attendees: [{ contactId: dana.id }, { contactId: sam.id }, { guestName: "Their lawyer" }],
    });
    expect(added.attendees).toHaveLength(3);

    const removed = await updateMeeting(handle.db, actorId, meeting.id, {
      attendees: [{ contactId: sam.id }],
    });
    expect(removed.attendees).toHaveLength(1);
    expect(removed.attendees[0]?.contactId).toBe(sam.id);

    const untouched = await updateMeeting(handle.db, actorId, meeting.id, { title: "Kickoff II" });
    expect(untouched.title).toBe("Kickoff II");
    expect(untouched.attendees).toHaveLength(1);

    const emptied = await updateMeeting(handle.db, actorId, meeting.id, { attendees: [] });
    expect(emptied.attendees).toEqual([]);
    expect(await handle.db.select().from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, meeting.id))).toHaveLength(0);
  });

  // THE CONTACT-ATTENDANCE WIDENING (the spec's "attendees are real links"):
  // the contact filter matches meetings.contact_id = C OR an attendee row for
  // C. The other three filters stay plain FK matches.
  it("lists a meeting under a contact who only ATTENDED it, and not under an unrelated contact", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const attendee = await createContact(handle.db, actorId, { firstName: "Dana" });
    const other = await createContact(handle.db, actorId, { firstName: "Unrelated" });
    const linked = await createContact(handle.db, actorId, { firstName: "Linked" });

    const viaAttendance = await createMeeting(handle.db, actorId, {
      title: "Company meeting", occurredAt: daysAgo(2), companyId: company.id,
      attendees: [{ contactId: attendee.id }],
    });
    const viaLink = await createMeeting(handle.db, actorId, {
      title: "Contact meeting", occurredAt: daysAgo(1), contactId: linked.id,
    });

    expect((await listMeetings(handle.db, { contactId: attendee.id })).items.map((m) => m.id))
      .toEqual([viaAttendance.id]);
    expect((await listMeetings(handle.db, { contactId: linked.id })).items.map((m) => m.id))
      .toEqual([viaLink.id]);
    expect((await listMeetings(handle.db, { contactId: other.id })).items).toEqual([]);
    // A guest with the same name as nobody in the CRM widens nothing.
    expect((await listMeetings(handle.db, { companyId: company.id })).items.map((m) => m.id))
      .toEqual([viaAttendance.id]);
  });

  it("orders by occurredAt (not createdAt) and pages with its own cursor type", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    // Created oldest-meeting-first, so a createdAt ordering would invert this.
    const oldest = await createMeeting(handle.db, actorId,
      { title: "Oldest", occurredAt: daysAgo(30), companyId: company.id });
    const newest = await createMeeting(handle.db, actorId,
      { title: "Newest", occurredAt: daysAgo(1), companyId: company.id });
    const middle = await createMeeting(handle.db, actorId,
      { title: "Middle", occurredAt: daysAgo(10), companyId: company.id });

    const all = await listMeetings(handle.db, {});
    expect(all.items.map((m) => m.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(all.nextCursor).toBeNull();

    const page1 = await listMeetings(handle.db, { limit: 2 });
    expect(page1.items.map((m) => m.id)).toEqual([newest.id, middle.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listMeetings(handle.db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((m) => m.id)).toEqual([oldest.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("logs a meeting in the future as readily as one in the past", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Arranged", occurredAt: future, companyId: company.id });
    expect(meeting.occurredAt).toBe(future);
    expect((await listMeetings(handle.db, {})).items[0]?.id).toBe(meeting.id);
  });

  it("sanitizes notes: a script does not survive, and markup that empties out becomes null", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      notes: "<p>Agreed the scope</p><script>alert(1)</script>",
    });
    expect(meeting.notes).toBe("<p>Agreed the scope</p>");
    expect(meeting.notes).not.toContain("script");

    // Nullable column, so this is null rather than mail-templates.ts's 409:
    // a meeting with no notes is completely ordinary.
    const emptied = await createMeeting(handle.db, actorId, {
      title: "No notes", occurredAt: daysAgo(1), companyId: company.id,
      notes: "<script>alert(1)</script>",
    });
    expect(emptied.notes).toBeNull();

    const patched = await updateMeeting(handle.db, actorId, meeting.id, { notes: "<style>p{}</style>" });
    expect(patched.notes).toBeNull();
  });

  it("merges a patch by defined keys and refuses to empty the last link", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }, "EUR",
    );
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), durationMinutes: 30,
      companyId: company.id, dealId: deal.id,
    });

    // Clearing one link while another survives is legitimate -- the merged
    // row still satisfies meetings_has_link.
    const cleared = await updateMeeting(handle.db, actorId, meeting.id, { companyId: null });
    expect(cleared.companyId).toBeNull();
    expect(cleared.dealId).toBe(deal.id);
    // An absent key leaves its field alone; an explicit null clears it.
    expect(cleared.durationMinutes).toBe(30);
    const nulled = await updateMeeting(handle.db, actorId, meeting.id, { durationMinutes: null });
    expect(nulled.durationMinutes).toBeNull();

    // Emptying the LAST link is a 4xx, not the CHECK's 500: the patch schema
    // carries no refine, so only the merged row can tell the two apart.
    await expect(updateMeeting(handle.db, actorId, meeting.id, { dealId: null }))
      .rejects.toBeInstanceOf(ConflictError);
    expect((await getMeeting(handle.db, meeting.id)).meeting.dealId).toBe(deal.id);
  });

  it("is a true no-op on an empty patch and refuses to update an archived meeting", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });

    const unchanged = await updateMeeting(handle.db, actorId, meeting.id, {});
    expect(unchanged).toEqual(meeting);

    await archiveMeeting(handle.db, actorId, meeting.id);
    await expect(updateMeeting(handle.db, actorId, meeting.id, { title: "X" }))
      .rejects.toBeInstanceOf(ArchivedError);
    await expect(updateMeeting(handle.db, actorId, UNKNOWN_ID, { title: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("archives out of the default list, keeps the meeting readable, and emits one event per transition", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ guestName: "Their lawyer" }],
    });

    const archived = await archiveMeeting(handle.db, actorId, meeting.id);
    expect(archived.archivedAt).not.toBeNull();
    // Every meeting-returning path hydrates: archive is one of them.
    expect(archived.attendees).toHaveLength(1);
    expect((await listMeetings(handle.db, {})).items).toHaveLength(0);
    expect((await listMeetings(handle.db, { archived: true })).items.map((m) => m.id)).toEqual([meeting.id]);
    expect((await getMeeting(handle.db, meeting.id)).meeting.archivedAt).not.toBeNull();

    // Idempotent: a second archive writes no second event.
    await archiveMeeting(handle.db, actorId, meeting.id);
    const archivedEvents = await handle.db.select().from(events)
      .where(and(eq(events.meetingId, meeting.id), eq(events.verb, "archived")));
    expect(archivedEvents).toHaveLength(1);
    expect(archivedEvents[0]?.companyId).toBe(company.id);
    // The title rides archive/unarchive too, unlike every other record type's
    // archive event: "a meeting was archived" lands on a record that may hold
    // dozens of them, so without it the reader cannot tell which.
    expect(archivedEvents[0]?.payload).toEqual({ title: "Kickoff" });

    const restored = await unarchiveMeeting(handle.db, actorId, meeting.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.attendees).toHaveLength(1);
    expect((await listMeetings(handle.db, {})).items).toHaveLength(1);
    const unarchivedEvents = await handle.db.select().from(events)
      .where(and(eq(events.meetingId, meeting.id), eq(events.verb, "unarchived")));
    expect(unarchivedEvents).toHaveLength(1);
    expect(unarchivedEvents[0]?.payload).toEqual({ title: "Kickoff" });
  });

  // The ruling, pinned: a meeting emits exactly three verbs (`met` on create,
  // then archived/unarchived), and an EDIT emits nothing. Without this test a
  // future change adding an `updated` event -- timeline noise for a
  // correction to an entry already in the story -- passes the whole suite.
  it("writes no event when a meeting is edited", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });

    await updateMeeting(handle.db, actorId, meeting.id, {
      title: "Kickoff II", durationMinutes: 60, notes: "<p>Rescheduled</p>",
      attendees: [{ guestName: "Their lawyer" }],
    });

    const all = await handle.db.select().from(events).where(eq(events.meetingId, meeting.id));
    expect(all.map((e) => e.verb)).toEqual(["met"]);
  });

  // The existence checks are deals.ts's rule, NOT notes.ts's: archiving a
  // record hides it from default listings, it does not stop a meeting that
  // HAPPENED with that company from being logged afterwards. Tightening
  // assertLinkedRecordsExist to notes.ts's archived-blocking shape would
  // otherwise pass every other test in this file.
  it("logs a meeting against an archived company", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, company.id);
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Post-archive debrief", occurredAt: daysAgo(1), companyId: company.id });
    expect(meeting.companyId).toBe(company.id);
    expect((await listMeetings(handle.db, { companyId: company.id })).items).toHaveLength(1);
  });

  // The user-side partial unique, the twin of the contact one above.
  it("rejects the same user twice on one meeting as a ConflictError", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await expect(createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ userId: actorId }, { userId: actorId }],
    })).rejects.toBeInstanceOf(ConflictError);

    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });
    await expect(updateMeeting(handle.db, actorId, meeting.id, {
      attendees: [{ userId: actorId }, { userId: actorId }],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  // The widening is one arm of a WHERE that also carries the archived arm and
  // the keyset, so it has to compose with both -- and it must not multiply
  // rows for a contact who is BOTH the link and an attendee.
  it("composes the contact widening with the archived arm, the cursor, and a both-linked-and-attendee row", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana" });

    const live = [];
    for (const days of [1, 2, 3]) {
      live.push(await createMeeting(handle.db, actorId, {
        title: `Attended ${days}`, occurredAt: daysAgo(days), companyId: company.id,
        attendees: [{ contactId: contact.id }],
      }));
    }
    const filed = await createMeeting(handle.db, actorId, {
      title: "Filed away", occurredAt: daysAgo(4), companyId: company.id,
      attendees: [{ contactId: contact.id }],
    });
    await archiveMeeting(handle.db, actorId, filed.id);

    // x archived: the arm applies to attendee-matched rows like any other.
    expect((await listMeetings(handle.db, { contactId: contact.id })).items.map((m) => m.id))
      .toEqual(live.map((m) => m.id));
    expect((await listMeetings(handle.db, { contactId: contact.id, archived: true })).items.map((m) => m.id))
      .toEqual([filed.id]);

    // x cursor: paging across attendee-matched rows keeps the occurredAt order
    // and loses none of them.
    const page1 = await listMeetings(handle.db, { contactId: contact.id, limit: 2 });
    expect(page1.items.map((m) => m.id)).toEqual([live[0]!.id, live[1]!.id]);
    const page2 = await listMeetings(handle.db, { contactId: contact.id, limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((m) => m.id)).toEqual([live[2]!.id]);
    expect(page2.nextCursor).toBeNull();

    // Both the link AND an attendee: the OR is one predicate over meetings,
    // not a join, so this is one row and not two.
    const both = await createMeeting(handle.db, actorId, {
      title: "Linked and attending", occurredAt: daysAgo(0), contactId: contact.id,
      attendees: [{ contactId: contact.id }],
    });
    const widened = await listMeetings(handle.db, { contactId: contact.id });
    expect(widened.items.filter((m) => m.id === both.id)).toHaveLength(1);
    expect(widened.items).toHaveLength(4);
  });

  it("answers the detail payload with the meeting and the tasks it produced", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: contact.id }],
    });

    const detail = await getMeeting(handle.db, meeting.id);
    expect(detail.meeting.id).toBe(meeting.id);
    expect(detail.meeting.attendees).toHaveLength(1);
    // Nothing creates follow-up tasks yet (Task 3 owns the write path), so
    // both halves of the count/list pair are honestly empty -- and they are
    // computed from the same criterion, so they cannot disagree.
    expect(detail.tasks).toEqual([]);
    expect(detail.meeting.taskCount).toBe(0);
    expect((await listMeetings(handle.db, {})).items[0]?.taskCount).toBe(0);

    await expect(getMeeting(handle.db, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  // Task 3 owns the write path (POST /api/meetings/:id/tasks stamps meeting_id
  // onto the task's own creation event); this pins the READ criterion both
  // halves share, by writing that stamp by hand. Without it the zeroes above
  // would be indistinguishable from a hardcoded 0.
  it("counts and lists the follow-up tasks whose creation event names this meeting", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });
    const other = await createMeeting(handle.db, actorId,
      { title: "Unrelated", occurredAt: daysAgo(2), companyId: company.id });

    const task = await createTask(handle.db, actorId, { title: "Follow up", companyId: company.id });
    await createTask(handle.db, actorId, { title: "Not from a meeting", companyId: company.id });
    await handle.db.update(events).set({ meetingId: meeting.id })
      .where(and(eq(events.taskId, task.id), eq(events.verb, "created")));

    const detail = await getMeeting(handle.db, meeting.id);
    expect(detail.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(detail.meeting.taskCount).toBe(1);

    // A LATER event on the same task, also naming this meeting, is not a
    // second follow-up task: only the creation verb counts.
    await updateTask(handle.db, actorId, task.id, { title: "Follow up, renamed" });
    await handle.db.update(events).set({ meetingId: meeting.id })
      .where(and(eq(events.taskId, task.id), eq(events.verb, "updated")));

    const counts = new Map((await listMeetings(handle.db, {})).items.map((m) => [m.id, m.taskCount]));
    expect(counts.get(meeting.id)).toBe(1);
    expect(counts.get(other.id)).toBe(0);
    expect((await getMeeting(handle.db, meeting.id)).tasks).toHaveLength(1);

    // COUNT(DISTINCT task_id), not COUNT(*): a SECOND creation row naming the
    // same task is still one follow-up task. Nothing writes such a row today
    // (createTask emits one `created` per task), which is exactly why the
    // DISTINCT needs pinning -- count(*) passes every other assertion here.
    await handle.db.insert(events).values({
      verb: "created", actorUserId: actorId, companyId: company.id,
      taskId: task.id, meetingId: meeting.id, payload: {},
    });
    expect((await getMeeting(handle.db, meeting.id)).meeting.taskCount).toBe(1);
    expect((await listMeetings(handle.db, { companyId: company.id })).items
      .find((m) => m.id === meeting.id)?.taskCount).toBe(1);
  });

  // The "one pass" claim is the file's headline hydration rule, and prose is
  // all that holds it: a `Promise.all(rows.map(getMeeting))` rewrite passes
  // every other test here unchanged. Counting db.select() calls pins it --
  // three per page (the page itself, its attendees, its task counts),
  // CONSTANT as the page grows. mail-move.test.ts's Proxy is the technique.
  it("issues the same number of queries for a page of ten meetings as for a page of one", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    for (let i = 0; i < 10; i++) {
      await createMeeting(handle.db, actorId, {
        title: `Meeting ${i}`, occurredAt: daysAgo(i + 1), companyId: company.id,
        attendees: [{ contactId: dana.id }, { guestName: "Their lawyer" }],
      });
    }

    let selects = 0;
    const counting = new Proxy(handle.db, {
      get(target, property, receiver: unknown) {
        if (property === "select") {
          return (...args: unknown[]) => {
            selects += 1;
            return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown)
              .apply(target, args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof handle.db;

    const one = await listMeetings(counting, { limit: 1 });
    const afterOne = selects;
    selects = 0;
    const ten = await listMeetings(counting, { limit: 10 });

    expect(one.items).toHaveLength(1);
    expect(ten.items).toHaveLength(10);
    expect(afterOne).toBe(3);
    expect(selects).toBe(3);
    // The rows really were hydrated, so the count above is not three queries
    // that quietly returned nothing.
    expect(ten.items.every((m) => m.attendees.length === 2)).toBe(true);
  });

  // createMeeting sorts the rows its INSERT ... RETURNING handed back so they
  // match loadAttendees' ORDER BY id. Without the sort the two paths agree
  // only by accident of insertion order, and an assertion over a Set (or over
  // lengths) would not notice.
  it("returns attendees in the same order create and get both use", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const people = [];
    for (const name of ["Dana", "Sam", "Ada", "Grace"]) {
      people.push(await createContact(handle.db, actorId, { firstName: name }));
    }
    const created = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: people.map((c) => ({ contactId: c.id })),
    });

    const fetched = await getMeeting(handle.db, created.id);
    expect(created.attendees).toEqual(fetched.meeting.attendees);
    expect((await listMeetings(handle.db, {})).items[0]?.attendees).toEqual(created.attendees);
  });

  it("hydrates every list row's attendees in one pass", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    await createMeeting(handle.db, actorId, {
      title: "One", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: dana.id }, { guestName: "Their lawyer" }],
    });
    await createMeeting(handle.db, actorId,
      { title: "Two", occurredAt: daysAgo(2), companyId: company.id, attendees: [{ userId: actorId }] });
    await createMeeting(handle.db, actorId,
      { title: "Three", occurredAt: daysAgo(3), companyId: company.id });

    const { items } = await listMeetings(handle.db, {});
    expect(items.map((m) => m.attendees.length)).toEqual([2, 1, 0]);
    expect(items[1]?.attendees[0]?.userId).toBe(actorId);
  });
});

/**
 * Follow-up tasks (Task 3). The write path behind POST /api/meetings/:id/tasks,
 * and the other half of the criterion the block above pinned by hand: these
 * tests drive the REAL writer, so a stamp that stopped matching
 * taskCreatedFromMeeting fails here instead of being papered over by a
 * hand-written row.
 */
describe("follow-up tasks from a meeting", () => {
  it("inherits all four of the meeting's record links onto the task", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana", companyId: company.id });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }, "EUR",
    );
    const project = await createProject(handle.db, actorId, { name: "Rollout", companyId: company.id });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1),
      companyId: company.id, contactId: contact.id, dealId: deal.id, projectId: project.id,
    });

    const task = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Send the deck" });

    expect(task.title).toBe("Send the deck");
    expect(task.companyId).toBe(company.id);
    expect(task.contactId).toBe(contact.id);
    expect(task.dealId).toBe(deal.id);
    expect(task.projectId).toBe(project.id);

    // The provenance sits on the task's OWN creation row, in the column
    // taskCreatedFromMeeting reads -- not in the payload, and not on a second
    // row appended after the fact.
    const created = await handle.db.select().from(events)
      .where(and(eq(events.taskId, task.id), eq(events.verb, "created")));
    expect(created).toHaveLength(1);
    expect(created[0]?.meetingId).toBe(meeting.id);
    expect(created[0]?.payload).toEqual({});
  });

  // The meeting's links are DEFAULTS, not a cage: a caller who names a link
  // gets that one, and a caller who explicitly nulls one gets no link at all
  // rather than the meeting's -- the same three-state reading updateMeeting's
  // merge uses.
  it("lets a caller-supplied link win over the meeting's, including an explicit null", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const other = await createCompany(handle.db, actorId, { name: "Other" });
    const contact = await createContact(handle.db, actorId, { firstName: "Dana" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id, contactId: contact.id,
    });

    const overridden = await createMeetingTask(handle.db, actorId, meeting.id,
      { title: "Chase the other side", companyId: other.id });
    expect(overridden.companyId).toBe(other.id);
    // The links nobody mentioned still inherit: overriding one is not a reset
    // of all four.
    expect(overridden.contactId).toBe(contact.id);

    const cleared = await createMeetingTask(handle.db, actorId, meeting.id,
      { title: "Internal only", contactId: null });
    expect(cleared.contactId).toBeNull();
    expect(cleared.companyId).toBe(company.id);
  });

  it("refuses a follow-up task on an archived meeting, and 404s an unknown one", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });
    await archiveMeeting(handle.db, actorId, meeting.id);

    // ArchivedError (409 `archived` at the route), not NotFoundError: the
    // meeting exists and is still readable, it has just been filed away -- and
    // filing it away means it does not sprout new work.
    await expect(createMeetingTask(handle.db, actorId, meeting.id, { title: "Too late" }))
      .rejects.toBeInstanceOf(ArchivedError);
    await expect(createMeetingTask(handle.db, actorId, UNKNOWN_ID, { title: "Nowhere" }))
      .rejects.toBeInstanceOf(NotFoundError);
    // Neither refusal wrote anything.
    expect(await listTasks(handle.db, {})).toEqual([]);
    expect((await getMeeting(handle.db, meeting.id)).meeting.taskCount).toBe(0);

    // Unarchiving lifts the refusal, with nothing else about the request
    // changing.
    await unarchiveMeeting(handle.db, actorId, meeting.id);
    const task = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Now fine" });
    expect(task.companyId).toBe(company.id);
  });

  // The whole point of routing through createTask is that a follow-up task is
  // an ORDINARY task. These three arms are behaviours only that function has:
  // a copied insert would append no position, would accept a lone date, and
  // would happily plant new work in an archived project.
  it("creates the task through createTask, so every existing task rule still applies", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const project = await createProject(handle.db, actorId, { name: "Rollout", companyId: company.id });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), projectId: project.id });

    const first = await createTask(handle.db, actorId, { title: "Already there", projectId: project.id });
    const followUp = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Send the deck" });
    // Appended after its new siblings, at the fractional position createTask
    // computes under the sibling-group lock.
    expect(followUp.projectId).toBe(project.id);
    expect(followUp.position > first.position).toBe(true);

    // tasks_dates_paired, re-asserted by createTask for a direct service caller.
    await expect(createMeetingTask(handle.db, actorId, meeting.id,
      { title: "Half dated", startDate: "2026-09-01" })).rejects.toThrow(/startDate and dueDate/);

    // An archived project has deliberately stopped accepting new work, and it
    // makes no difference that this task arrived through a meeting.
    await archiveProject(handle.db, actorId, project.id);
    await expect(createMeetingTask(handle.db, actorId, meeting.id, { title: "Too late" }))
      .rejects.toThrow(/project .* is archived/);
  });

  // THE ANTI-DOUBLE-RENDER PIN. Stamping the meeting onto createTask's own
  // event insert is what keeps this at one: an implementation that appended a
  // second `created` row afterwards would satisfy taskCount just as well while
  // putting two "created" entries for one task on that task's timeline.
  it("writes exactly one creation entry for the task it produced", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });

    const task = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Send the deck" });

    const own = await listEvents(handle.db, actorId, { taskId: task.id });
    expect(own.items.map((e) => e.verb)).toEqual(["created"]);
    expect(own.items[0]?.meetingId).toBe(meeting.id);
    const rows = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(rows).toHaveLength(1);
  });

  it("lists the tasks it produced on the detail payload, with the list row's count agreeing", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });
    const other = await createMeeting(handle.db, actorId,
      { title: "Unrelated", occurredAt: daysAgo(2), companyId: company.id });

    const one = await createMeetingTask(handle.db, actorId, meeting.id, { title: "One" });
    const two = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Two" });
    // Same company, same actor, no meeting: the count is about provenance, not
    // about which records a task happens to touch.
    await createTask(handle.db, actorId, { title: "Not from a meeting", companyId: company.id });

    const detail = await getMeeting(handle.db, meeting.id);
    expect(detail.tasks.map((t) => t.id)).toEqual([one.id, two.id]);
    expect(detail.meeting.taskCount).toBe(2);

    const counts = new Map((await listMeetings(handle.db, { companyId: company.id }))
      .items.map((m) => [m.id, m.taskCount]));
    expect(counts.get(meeting.id)).toBe(2);
    expect(counts.get(other.id)).toBe(0);

    // Archiving a follow-up task does not un-create it: the event still says
    // this meeting produced it, so the count and the list stay the same set.
    await archiveTask(handle.db, actorId, one.id);
    const after = await getMeeting(handle.db, meeting.id);
    expect(after.tasks.map((t) => t.id)).toEqual([one.id, two.id]);
    expect(after.meeting.taskCount).toBe(2);
  });

  // The ONE thing that refreshes the meeting a client is already looking at:
  // createTask publishes the TASK's keys, which reach no meeting query, so
  // without this publish the rail's taskCount and the detail payload's task
  // list both sit stale until something else happens to invalidate them. Task 5
  // builds against this exact key set (recorded as a contract in the plan's
  // Task 3 DONE block), and deleting the publish leaves every other test in
  // this file and in routes.test.ts green -- which is why the contract is
  // pinned here rather than left to prose. Subscribed inside the test rather
  // than in beforeEach (mail-folders.test.ts's harness) because this is the one
  // test in the file that reads hints.
  it("publishes the meeting's own invalidation keys, not just the task's", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId,
      { title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id });

    const hints: SseHint[] = [];
    const unsubscribe = subscribe((hint) => { hints.push(hint); });
    let task;
    try {
      task = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Send the deck" });
    } finally {
      unsubscribe();
    }

    expect(hints).toContainEqual({ keys: [["meetings"], ["meeting", meeting.id], ["events"]] });
    // Both publishes happen: the meeting hint is an addition to createTask's
    // own, not a replacement for it.
    expect(hints.some((hint) => hint.keys.some((key) => key[0] === "task" && key[1] === task.id)))
      .toBe(true);
  });

  // Composed with the read-time widening (services/timeline.ts): attendance
  // carries the MEETING to a contact's timeline, not everything the meeting
  // spawned. timeline.test.ts pins that rule with a hand-written row; this
  // proves the real writer produces exactly the row the arm must exclude, and
  // that the exclusion is not vacuous -- the same row does reach the company's
  // timeline, through the task's own inherited link.
  it("keeps a follow-up task's creation entry off an attendee-only contact's timeline", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: daysAgo(1), companyId: company.id,
      attendees: [{ contactId: dana.id }],
    });

    const task = await createMeetingTask(handle.db, actorId, meeting.id, { title: "Send the deck" });

    const attended = await listEvents(handle.db, actorId, { contactId: dana.id });
    expect(attended.items.some((e) => e.taskId === task.id)).toBe(false);
    // What she does see: the meeting itself, and her own creation row.
    expect(attended.items.map((e) => e.verb)).toEqual(["met", "created"]);
    expect(attended.items[1]?.contactId).toBe(dana.id);

    const onCompany = await listEvents(handle.db, actorId, { companyId: company.id });
    expect(onCompany.items.some((e) => e.taskId === task.id && e.meetingId === meeting.id)).toBe(true);
  });
});
