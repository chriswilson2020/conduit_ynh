import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { eventVerbSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, mailAccounts, mailMessages, mailThreadHides, mailThreads } from "../db/schema.js";
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

    const result = await listEvents(handle.db, actorId, { companyId: c.id });
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

    const page1 = await listEvents(handle.db, actorId, { companyId: c.id, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listEvents(handle.db, actorId, { companyId: c.id, limit: 2, cursor: page1.nextCursor! });
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

    const result = await listEvents(handle.db, actorId, { contactId: p.id });
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

    const attended = await listEvents(handle.db, actorId, { contactId: dana.id });
    expect(attended.items.map((e) => e.verb)).toEqual(["met", "created"]);
    expect(attended.items[0]?.meetingId).toBe(meeting.id);
    expect(attended.items[0]?.payload).toEqual({ title: "Kickoff" });
    // The meeting names the company, not Dana -- only attendance put it here.
    expect(attended.items[0]?.contactId).toBeNull();

    // A contact who neither attended nor is linked sees only their own row.
    const outsider = await listEvents(handle.db, actorId, { contactId: unrelated.id });
    expect(outsider.items.map((e) => e.verb)).toEqual(["created"]);

    // One row per meeting, not one per attendee.
    const onCompany = await listEvents(handle.db, actorId, { companyId: company.id });
    expect(onCompany.items.filter((e) => e.verb === "met")).toHaveLength(1);

    // The archive entry reaches the same widened timeline, for the same reason.
    await archiveMeeting(handle.db, actorId, meeting.id);
    const afterArchive = await listEvents(handle.db, actorId, { contactId: dana.id });
    expect(afterArchive.items.map((e) => e.verb)).toEqual(["archived", "met", "created"]);
  });

  // The widening carries the MEETING to an attendee's record, not everything
  // the meeting spawned. Task 3 will stamp meeting_id onto a follow-up task's
  // own `created` event (services/meetings.ts's taskCreatedFromMeeting reads
  // exactly that row), and on such a row meeting_id is provenance, not
  // subject: the task reaches timelines through its own links, and an attendee
  // seeing task activity she is not on is noise. Written by hand here because
  // Task 3 does not exist yet -- the same technique meetings.test.ts uses to
  // pin the task count.
  it("does not carry a meeting's follow-up task events onto an attendee's timeline", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date().toISOString(), companyId: company.id,
      attendees: [{ contactId: dana.id }],
    });
    const task = await createTask(handle.db, actorId, { title: "Follow up", companyId: company.id });
    await handle.db.update(events).set({ meetingId: meeting.id })
      .where(and(eq(events.taskId, task.id), eq(events.verb, "created")));

    const attended = await listEvents(handle.db, actorId, { contactId: dana.id });
    expect(attended.items.map((e) => e.verb)).toEqual(["met", "created"]);
    // The one `created` row here is Dana's own, not the task's.
    expect(attended.items[1]?.contactId).toBe(dana.id);
    expect(attended.items.some((e) => e.taskId === task.id)).toBe(false);
  });

  it("does not double-count a contact who is both the meeting's link and an attendee", async () => {
    const dana = await createContact(handle.db, actorId, { firstName: "Dana" });
    await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date().toISOString(), contactId: dana.id,
      attendees: [{ contactId: dana.id }],
    });

    const result = await listEvents(handle.db, actorId, { contactId: dana.id });
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

    const result = await listEvents(handle.db, actorId, { dealId: deal.id });
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

    const result = await listEvents(handle.db, actorId, { projectId: project.id });
    expect(result.items).toHaveLength(2); // "created" + "note_added"
    expect(result.items.every((e) => e.projectId === project.id)).toBe(true);
    expect(result.items.every((e) => e.companyId === c.id)).toBe(true);
  });

  it("filtering by taskId returns only that task's own events -- the task drawer's rail", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    const taskA = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const taskB = await createTask(handle.db, actorId, { title: "B", projectId: project.id });

    const result = await listEvents(handle.db, actorId, { taskId: taskA.id });
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

// ---------------------------------------------------------------------------
// Mail in the timeline (Phase 5 Task 4) -- the privacy-critical surface.
//
// A mail event is a POINTER: the thread's record FKs, mail_thread_id, and an
// empty payload (services/mail-ingest.ts). Everything a reader sees is decided
// HERE, per viewer, by Phase 4.2's record-visible predicate composed with
// Phase 4.3's not-hidden predicate. Two rules are what these tests exist to
// hold, and both undo two whole releases if they break:
//   1. an invisible thread contributes NO ROW -- not a redacted stub, because
//      "activity you cannot see" leaks the existence and the timing of
//      someone's private mail;
//   2. a visible thread's subject is read LIVE from mail_threads under those
//      same predicates, never from anything stored on the event.
// ---------------------------------------------------------------------------
describe("timeline mail privacy", () => {
  let otherId: string;
  let companyId: string;
  let dealId: string;
  let projectId: string;

  beforeEach(async () => {
    otherId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    companyId = (await createCompany(handle.db, actorId, { name: "Acme" })).id;
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    dealId = (await createDeal(
      handle.db, actorId,
      { title: "Renewal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR",
    )).id;
    projectId = (await createProject(handle.db, actorId, { name: "Launch", companyId })).id;
  });

  /** An account owned by `actorId` unless told otherwise -- the fixture shape
   * search.test.ts uses, inserted directly because nothing here decrypts
   * credentials. */
  async function makeAccount(
    opts: { owner?: string; visibility?: "private" | "shared" } = {},
  ): Promise<string> {
    const [row] = await handle.db.insert(mailAccounts).values({
      userId: opts.owner ?? actorId, label: "Work", email: `chris+${randomUUID()}@example.com`,
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
      username: "chris", credentialsCiphertext: "v1:unused-in-timeline-tests",
      visibility: opts.visibility ?? "private",
    }).returning({ id: mailAccounts.id });
    if (row === undefined) throw new Error("makeAccount: no row");
    return row.id;
  }

  interface ThreadLinks {
    companyId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
    projectId?: string | null;
  }

  async function makeThread(subject: string, links: ThreadLinks = {}): Promise<string> {
    const [row] = await handle.db.insert(mailThreads).values({
      subject, lastMessageAt: new Date("2026-08-02T10:00:00Z"), messageCount: 1,
      companyId: links.companyId ?? null, contactId: links.contactId ?? null,
      dealId: links.dealId ?? null, projectId: links.projectId ?? null,
    }).returning({ id: mailThreads.id });
    if (row === undefined) throw new Error("makeThread: no row");
    return row.id;
  }

  /** A thread with no message on any account is visible to nobody through the
   * owned-or-shared arm (there is no account to own), so every cell that is
   * meant to be visible needs one of these. */
  async function makeMessage(threadId: string, accountId: string): Promise<void> {
    await handle.db.insert(mailMessages).values({
      accountId, threadId, messageId: `<${randomUUID()}@example.com>`,
      referencesIds: [], fromAddr: "alice@example.com", fromName: "Alice",
      toAddrs: [{ address: "chris@example.com" }],
      subject: "stored on the message, never on the event",
      bodyText: "body", snippet: "snippet",
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "INBOX", seen: true, direction: "inbound",
    });
  }

  async function hideFor(threadId: string, userId: string): Promise<void> {
    await handle.db.insert(mailThreadHides).values({ threadId, userId });
  }

  /**
   * One mail event row in exactly the shape services/mail-ingest.ts's
   * emitMailEvent writes: the thread's record FKs, mail_thread_id, an EMPTY
   * payload. Hand-written so a 16-cell matrix does not need a temp dir and a
   * raw MIME message per cell -- the same technique this file already uses for
   * a follow-up task's event. The REAL emission (its columns, and the
   * payload-key assertion that keeps content out of it) is pinned in
   * mail-ingest.test.ts, which also feeds an ingested message straight into
   * listEvents so this hand-written twin cannot drift out of step unnoticed.
   */
  async function mailEvent(
    threadId: string, links: ThreadLinks, verb: "mail_received" | "mail_sent" = "mail_received",
  ): Promise<void> {
    await handle.db.insert(events).values({
      verb, actorUserId: actorId,
      companyId: links.companyId ?? null, contactId: links.contactId ?? null,
      dealId: links.dealId ?? null, projectId: links.projectId ?? null,
      mailThreadId: threadId, payload: {},
    });
  }

  interface Cell {
    viewer: "owner" | "other";
    /** The account the thread's message sits on. */
    shared: boolean;
    /** A DELIBERATE deal link, the only kind that widens record visibility.
     * Every thread here is company-linked regardless (otherwise its event
     * would be on no timeline at all) -- and a company link, like the contact
     * link auto-linking writes, never widens anything. */
    dealLinked: boolean;
    hidden: boolean;
    visible: boolean;
  }

  // Spelled out cell by cell rather than computed, so this table states the
  // RULE and would disagree with an implementation that changed it -- a
  // computed expectation would just re-derive whatever the code does.
  const MATRIX: Cell[] = [
    { viewer: "owner", shared: false, dealLinked: false, hidden: false, visible: true },
    { viewer: "owner", shared: false, dealLinked: false, hidden: true, visible: false },
    { viewer: "owner", shared: false, dealLinked: true, hidden: false, visible: true },
    { viewer: "owner", shared: false, dealLinked: true, hidden: true, visible: false },
    { viewer: "owner", shared: true, dealLinked: false, hidden: false, visible: true },
    { viewer: "owner", shared: true, dealLinked: false, hidden: true, visible: false },
    { viewer: "owner", shared: true, dealLinked: true, hidden: false, visible: true },
    { viewer: "owner", shared: true, dealLinked: true, hidden: true, visible: false },
    // The cell the whole feature turns on: another user's PRIVATE, merely
    // auto-linked mail. Invisible, and therefore absent.
    { viewer: "other", shared: false, dealLinked: false, hidden: false, visible: false },
    { viewer: "other", shared: false, dealLinked: false, hidden: true, visible: false },
    // A deal link is a deliberate, click-made act meaning "this conversation
    // is part of the record's history" -- so it DOES widen, exactly as it does
    // on the record's Mail tab.
    { viewer: "other", shared: false, dealLinked: true, hidden: false, visible: true },
    { viewer: "other", shared: false, dealLinked: true, hidden: true, visible: false },
    { viewer: "other", shared: true, dealLinked: false, hidden: false, visible: true },
    { viewer: "other", shared: true, dealLinked: false, hidden: true, visible: false },
    { viewer: "other", shared: true, dealLinked: true, hidden: false, visible: true },
    { viewer: "other", shared: true, dealLinked: true, hidden: true, visible: false },
  ];

  function label(cell: Cell): string {
    return [
      cell.viewer,
      cell.shared ? "shared" : "private",
      cell.dealLinked ? "deal-linked" : "unlinked",
      cell.hidden ? "hidden" : "not-hidden",
    ].join("/");
  }

  it("the mail privacy matrix: (owner|other) x (private|shared) x (unlinked|deal-linked) x (hidden|not hidden)", async () => {
    const seen: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const cell of MATRIX) {
      const name = label(cell);
      // The subject IS the label, so a wrong cell names itself in the diff.
      const accountId = await makeAccount({ visibility: cell.shared ? "shared" : "private" });
      const links: ThreadLinks = { companyId, dealId: cell.dealLinked ? dealId : null };
      const threadId = await makeThread(name, links);
      await makeMessage(threadId, accountId);
      const viewerId = cell.viewer === "owner" ? actorId : otherId;
      if (cell.hidden) await hideFor(threadId, viewerId);
      await mailEvent(threadId, links);

      // limit 100, not the default 50: this loop accumulates a row per cell
      // on ONE company's timeline, and a visible row that simply fell off the
      // end of the page would read as EXCLUDED -- which is a PASS for every
      // negative cell, and a silent one.
      const page = await listEvents(handle.db, viewerId, { companyId, limit: 100 });
      const row = page.items.find((e) => e.mailThreadId === threadId);
      // Three distinguishable outcomes, so "excluded" can never be confused
      // with "present but unlabelled".
      seen[name] = row === undefined
        ? "EXCLUDED"
        : (row.mailSubject === null ? "PRESENT-WITHOUT-SUBJECT" : row.mailSubject);
      expected[name] = cell.visible ? name : "EXCLUDED";
    }
    // label() must be INJECTIVE over Cell, and nothing in the type system
    // makes it so: add a fifth dimension, forget to extend label(), and cells
    // collide in `seen` and `expected` alike. They would still agree -- one
    // iteration writes both -- so half the matrix would vanish, green.
    expect(Object.keys(seen)).toHaveLength(MATRIX.length);
    expect(seen).toEqual(expected);
  });

  // The exclusion is TOTAL, which is the whole point: not a stub, not a
  // placeholder, not a row with its fields blanked. Asserted against a LOADED
  // timeline (the 4.3 sentinel lesson) -- the other user's page must still
  // carry the entries she CAN see, or an empty response would pass this test
  // for the wrong reason.
  it("excludes another user's private mail entirely, leaving the rest of the timeline intact", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread("Salary review", { companyId });
    await makeMessage(threadId, accountId);
    await mailEvent(threadId, { companyId });
    await createNote(handle.db, actorId, { body: "a sentinel everyone can see", companyId });

    const owner = await listEvents(handle.db, actorId, { companyId });
    expect(owner.items.filter((e) => e.verb === "mail_received")).toHaveLength(1);
    expect(owner.items.find((e) => e.mailThreadId === threadId)?.mailSubject).toBe("Salary review");

    const other = await listEvents(handle.db, otherId, { companyId });
    expect(other.items.some((e) => e.mailThreadId !== null)).toBe(false);
    expect(other.items.some((e) => e.verb === "mail_received")).toBe(false);
    expect(other.items.some((e) => e.mailSubject !== null)).toBe(false);
    // The sentinel proves the page loaded rather than came back empty.
    expect(other.items.some((e) => e.verb === "note_added")).toBe(true);
    // Same timeline, one row shorter for her -- and it is exactly that row.
    expect(other.items).toHaveLength(owner.items.length - 1);
  });

  // Phase 4.3: a hide is a FILING act by one person, never a property of the
  // thread. It composes with visibility rather than replacing it.
  it("drops an entry for the viewer who hid the thread and for nobody else", async () => {
    const accountId = await makeAccount({ visibility: "shared" });
    const threadId = await makeThread("Renewal terms", { companyId });
    await makeMessage(threadId, accountId);
    await mailEvent(threadId, { companyId });
    await hideFor(threadId, actorId);

    const hider = await listEvents(handle.db, actorId, { companyId });
    expect(hider.items.some((e) => e.mailThreadId === threadId)).toBe(false);
    const other = await listEvents(handle.db, otherId, { companyId });
    expect(other.items.find((e) => e.mailThreadId === threadId)?.mailSubject).toBe("Renewal terms");
  });

  // Derived at READ time: nothing about the mail is stored on the event, so a
  // subject can only ever be what the thread says now. The stored row is
  // inspected here too -- if a future change ever put a subject in the
  // payload, this test would find it in the timeline's own output.
  it("renders the subject live from the thread, storing nothing on the event", async () => {
    const accountId = await makeAccount();
    const threadId = await makeThread("Original subject", { companyId });
    await makeMessage(threadId, accountId);
    await mailEvent(threadId, { companyId });

    const [stored] = await handle.db.select({ payload: events.payload })
      .from(events).where(eq(events.mailThreadId, threadId));
    expect(Object.keys(stored?.payload as Record<string, unknown>)).toEqual([]);

    await handle.db.update(mailThreads)
      .set({ subject: "Renamed in the thread" }).where(eq(mailThreads.id, threadId));
    const after = await listEvents(handle.db, actorId, { companyId });
    expect(after.items.find((e) => e.mailThreadId === threadId)?.mailSubject)
      .toBe("Renamed in the thread");
  });

  // The deal arm and the project arm are one rule (mail-threads.ts's
  // recordLinked), and a contact link is emphatically NOT part of it: ingest's
  // auto-linker writes contact/company links by itself, and if those widened
  // visibility, every private mailbox would leak the moment a known address
  // appeared in it.
  it("widens for a project link and not for a contact link", async () => {
    const accountId = await makeAccount();
    const contact = await createContact(handle.db, actorId, { firstName: "Ada", companyId });
    const viaProject = await makeThread("Project thread", { companyId, projectId });
    await makeMessage(viaProject, accountId);
    await mailEvent(viaProject, { companyId, projectId });
    const viaContact = await makeThread("Contact thread", { companyId, contactId: contact.id });
    await makeMessage(viaContact, accountId);
    await mailEvent(viaContact, { companyId, contactId: contact.id });

    const other = await listEvents(handle.db, otherId, { companyId });
    expect(other.items.find((e) => e.mailThreadId === viaProject)?.mailSubject).toBe("Project thread");
    expect(other.items.some((e) => e.mailThreadId === viaContact)).toBe(false);
  });

  // THE 4.3 PAGINATION LESSON. Filtering after the limit returns short pages
  // and a cursor minted from a row the viewer never saw, so the next page
  // starts past rows they were entitled to. Filtering inside the statement --
  // which is what putting the predicates on the JOIN buys -- cannot do that.
  it("excludes invisible rows before the limit, so pages stay full and the cursor skips nothing", async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount({ owner: otherId });
    const visible: string[] = [];
    // Interleaved, so any page boundary lands between rows of both kinds.
    for (let i = 0; i < 6; i += 1) {
      const openThread = await makeThread(`visible ${i}`, { companyId });
      await makeMessage(openThread, mine);
      await mailEvent(openThread, { companyId });
      visible.push(openThread);
      const closedThread = await makeThread(`private ${i}`, { companyId });
      await makeMessage(closedThread, theirs);
      await mailEvent(closedThread, { companyId });
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listEvents>> = await listEvents(
        handle.db, actorId, { companyId, limit: 3, ...(cursor === null ? {} : { cursor }) },
      );
      pages += 1;
      // A full page every time there is more to come: never short.
      if (page.nextCursor !== null) expect(page.items).toHaveLength(3);
      for (const item of page.items) collected.push(item.id);
      expect(page.items.some((e) => e.mailThreadId !== null
        && !visible.includes(e.mailThreadId))).toBe(false);
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    // Every row the viewer is entitled to, exactly once: nothing skipped by a
    // cursor, nothing repeated across a boundary.
    expect(new Set(collected).size).toBe(collected.length);
    const whole = await listEvents(handle.db, actorId, { companyId, limit: 100 });
    expect(collected.sort()).toEqual(whole.items.map((e) => e.id).sort());
    expect(whole.items.filter((e) => e.mailThreadId !== null)).toHaveLength(6);
  });

  // The regression guard for the whole existing timeline: the join is a LEFT
  // JOIN on a primary key, so it can neither drop a non-mail row nor multiply
  // one, and mailSubject is null on every row that is not mail.
  it("leaves non-mail events exactly as they were, mail row present or not", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Ada", companyId });
    await createNote(handle.db, actorId, { body: "a note", companyId });
    await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date().toISOString(), companyId,
      attendees: [{ contactId: contact.id }],
    });
    const before = await listEvents(handle.db, otherId, { companyId });

    const theirs = await makeAccount({ owner: actorId });
    const threadId = await makeThread("Invisible to her", { companyId });
    await makeMessage(threadId, theirs);
    await mailEvent(threadId, { companyId });

    const after = await listEvents(handle.db, otherId, { companyId });
    expect(after.items.map((e) => e.id)).toEqual(before.items.map((e) => e.id));
    expect(after.items.every((e) => e.mailSubject === null)).toBe(true);
    expect(after.items.map((e) => e.verb)).toEqual(["met", "note_added", "created", "created", "created"]);
  });
});
