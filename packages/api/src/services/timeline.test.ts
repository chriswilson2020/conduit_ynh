import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eventVerbSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import { listEvents } from "./timeline.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createNote } from "./notes.js";
import { createDeal } from "./deals.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createProject } from "./projects.js";
import { createTask } from "./tasks.js";
import { createMeeting, archiveMeeting } from "./meetings.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("timeline service", () => {
  it("returns a company's events newest first", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await createNote(handle.db, actorId, { body: "first note", companyId: c.id });
    const second = await createNote(handle.db, actorId, { body: "second note", companyId: c.id });

    const result = await listEvents(handle.db, { companyId: c.id });
    expect(result.items).toHaveLength(3);
    expect(result.items[0]?.verb).toBe("note_added");
    expect(result.items[0]?.payload).toEqual({ noteId: second.id, preview: "second note" });
    expect(result.items[2]?.verb).toBe("created");
  });

  it("paginates a company's events with a stable cursor", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await createNote(handle.db, actorId, { body: "one", companyId: c.id });
    await createNote(handle.db, actorId, { body: "two", companyId: c.id });
    await createNote(handle.db, actorId, { body: "three", companyId: c.id });
    // 1 "created" + 3 "note_added" = 4 events total.

    const page1 = await listEvents(handle.db, { companyId: c.id, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listEvents(handle.db, { companyId: c.id, limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const ids = new Set([...page1.items, ...page2.items].map((e) => e.id));
    expect(ids.size).toBe(4);
  });

  it("filtering by contactId excludes a company's events", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await createNote(handle.db, actorId, { body: "company note", companyId: c.id });
    const p = await createContact(handle.db, actorId, { firstName: "Ada" });
    await createNote(handle.db, actorId, { body: "contact note", contactId: p.id });

    const result = await listEvents(handle.db, { contactId: p.id });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((e) => e.contactId === p.id)).toBe(true);
    expect(result.items.some((e) => e.companyId !== null)).toBe(false);
  });

  // The read-time twin of listMeetings' contact widening (services/
  // meetings.ts): a meeting logged on a company with C attending belongs on
  // C's timeline as well as on C's Meetings tab, and one `met` ROW serves
  // both -- no fan-out, so the company's own timeline still shows exactly one
  // entry however many people attended.
  it("widens a contact's timeline to meetings they only attended, without duplicating the company's entry", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    const unrelated = await createContact(handle.db, actorId, { firstName: "Unrelated" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date().toISOString(), companyId: company.id,
      attendees: [{ contactId: dana.id }, { guestName: "Their lawyer" }],
    });

    const attended = await listEvents(handle.db, { contactId: dana.id });
    expect(attended.items.map((e) => e.verb)).toEqual(["met", "created"]);
    expect(attended.items[0]?.meetingId).toBe(meeting.id);
    expect(attended.items[0]?.payload).toEqual({ title: "Kickoff" });
    // The meeting names the company, not Dana -- only attendance put it here.
    expect(attended.items[0]?.contactId).toBeNull();

    // A contact who neither attended nor is linked sees only their own row.
    const outsider = await listEvents(handle.db, { contactId: unrelated.id });
    expect(outsider.items.map((e) => e.verb)).toEqual(["created"]);

    // One row per meeting, not one per attendee.
    const onCompany = await listEvents(handle.db, { companyId: company.id });
    expect(onCompany.items.filter((e) => e.verb === "met")).toHaveLength(1);

    // The archive entry reaches the same widened timeline, for the same reason.
    await archiveMeeting(handle.db, actorId, meeting.id);
    const afterArchive = await listEvents(handle.db, { contactId: dana.id });
    expect(afterArchive.items.map((e) => e.verb)).toEqual(["archived", "met", "created"]);
  });

  it("does not double-count a contact who is both the meeting's link and an attendee", async () => {
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date().toISOString(), contactId: dana.id,
      attendees: [{ contactId: dana.id }],
    });

    const result = await listEvents(handle.db, { contactId: dana.id });
    expect(result.items.filter((e) => e.verb === "met")).toHaveLength(1);
  });

  it("filtering by dealId returns a deal's own events, including the company-scoped created event", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId, { title: "Big Co deal", pipelineId: pipeline.id, stageId: stage.id, companyId: c.id }, "EUR",
    );
    await createNote(handle.db, actorId, { body: "on the deal", dealId: deal.id });

    const result = await listEvents(handle.db, { dealId: deal.id });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((e) => e.dealId === deal.id)).toBe(true);
    // "created" (from createDeal) also carries the deal's companyId; the
    // note_added event above does too, via createNote's dealCompanyId
    // fallback -- both surface on the company's timeline as well.
    expect(result.items.every((e) => e.companyId === c.id)).toBe(true);
  });

  it("filtering by projectId returns a project's own events, including a note dual-stamped with its companyId", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const project = await createProject(handle.db, actorId, { name: "Launch", companyId: c.id });
    await createNote(handle.db, actorId, { body: "kickoff", projectId: project.id });

    const result = await listEvents(handle.db, { projectId: project.id });
    expect(result.items).toHaveLength(2); // "created" + "note_added"
    expect(result.items.every((e) => e.projectId === project.id)).toBe(true);
    expect(result.items.every((e) => e.companyId === c.id)).toBe(true);
  });

  it("filtering by taskId returns only that task's own events -- the task drawer's rail", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    const taskA = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const taskB = await createTask(handle.db, actorId, { title: "B", projectId: project.id });

    const result = await listEvents(handle.db, { taskId: taskA.id });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.taskId).toBe(taskA.id);
    expect(result.items.some((e) => e.taskId === taskB.id)).toBe(false);
  });

  // schema.ts's events.verb CHECK and shared's eventVerbSchema live in different
  // packages with nothing tying them together; either can drift without the other
  // noticing. This pins both to one hardcoded list: every verb here must (a) parse
  // through eventVerbSchema, (b) account for the schema's entire option list (so an
  // addition to one side that's missed on the other fails this test), and (c)
  // survive a real insert into events, exercising the DB CHECK itself -- while an
  // invented verb is rejected by that same CHECK.
  it("keeps eventVerbSchema and the events.verb DB CHECK in sync", async () => {
    const verbs = [
      "created", "updated", "archived", "unarchived", "note_added", "file_attached",
      "stage_changed", "won", "lost", "reopened",
      "shifted", "completed", "dependency_added", "dependency_removed",
      "met", "mail_sent", "mail_received",
    ];
    expect(verbs).toHaveLength(eventVerbSchema.options.length);
    for (const verb of verbs) expect(eventVerbSchema.parse(verb)).toBe(verb);

    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    for (const verb of verbs) {
      await handle.db.insert(events).values({ verb, actorUserId: actorId, companyId: c.id, payload: {} });
    }

    await expect(handle.db.insert(events).values({
      verb: "exploded", actorUserId: actorId, companyId: c.id, payload: {},
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/events_verb_valid|check/i) },
    });
  });
});
