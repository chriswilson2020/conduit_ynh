import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, meetingAttendees } from "../db/schema.js";
import {
  createMeeting, getMeeting, updateMeeting, archiveMeeting, unarchiveMeeting, listMeetings,
} from "./meetings.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";
import { createTask, updateTask } from "./tasks.js";
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
    expect(met[0]?.payload).toEqual({});
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

    const restored = await unarchiveMeeting(handle.db, actorId, meeting.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.attendees).toHaveLength(1);
    expect((await listMeetings(handle.db, {})).items).toHaveLength(1);
    const unarchivedEvents = await handle.db.select().from(events)
      .where(and(eq(events.meetingId, meeting.id), eq(events.verb, "unarchived")));
    expect(unarchivedEvents).toHaveLength(1);
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
