import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, files } from "../db/schema.js";
import { attachFile, listFiles, getFile } from "./files.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createDeal, archiveDeal, winDeal } from "./deals.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createProject, archiveProject } from "./projects.js";
import { createMeeting, archiveMeeting } from "./meetings.js";
import { NotFoundError, ArchivedError } from "./errors.js";

/** Mirrors notes.test.ts's makeDeal helper. */
async function makeDeal(db: Database, actorId: string, companyId?: string) {
  const pipeline = await createPipeline(db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(db, actorId, pipeline.id, { name: "Lead" });
  return createDeal(db, actorId, { title: "Big Co deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR");
}

const handle = openTestDatabase();
let actorId: string;

const sha = "a".repeat(64);

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("files service", () => {
  it("attaches a file to a company and records exactly one file_attached event", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const file = await attachFile(handle.db, actorId, {
      originalName: "report.pdf", mime: "application/pdf", sizeBytes: 1234, sha256: sha, companyId: c.id,
    });
    expect(file.companyId).toBe(c.id);
    expect(file.contactId).toBeNull();
    expect(file.originalName).toBe("report.pdf");
    expect(file.uploaderUserId).toBe(actorId);

    const evs = await handle.db.select().from(events).where(eq(events.companyId, c.id));
    const added = evs.filter((e) => e.verb === "file_attached");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({ fileId: file.id, originalName: "report.pdf" });
    expect(added[0]?.companyId).toBe(c.id);
    expect(added[0]?.contactId).toBeNull();
  });

  it("attaches a file to a contact and records exactly one file_attached event", async () => {
    const p = await createContact(handle.db, actorId, { firstName: "Ada" });
    const file = await attachFile(handle.db, actorId, {
      originalName: "cv.docx", mime: "application/vnd.openxmlformats", sizeBytes: 42, sha256: sha, contactId: p.id,
    });
    expect(file.contactId).toBe(p.id);
    expect(file.companyId).toBeNull();

    const evs = await handle.db.select().from(events).where(eq(events.contactId, p.id));
    const added = evs.filter((e) => e.verb === "file_attached");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({ fileId: file.id, originalName: "cv.docx" });
    expect(added[0]?.contactId).toBe(p.id);
    expect(added[0]?.companyId).toBeNull();
  });

  it("refuses attaching to an archived company", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, companyId: c.id,
    })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("refuses attaching to a missing contact", async () => {
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha,
      contactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("attaches a file to a deal and stamps the event with the deal's companyId", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const deal = await makeDeal(handle.db, actorId, c.id);
    const file = await attachFile(handle.db, actorId, {
      originalName: "contract.pdf", mime: "application/pdf", sizeBytes: 99, sha256: sha, dealId: deal.id,
    });
    expect(file.dealId).toBe(deal.id);
    expect(file.companyId).toBeNull();

    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const added = evs.filter((e) => e.verb === "file_attached");
    expect(added).toHaveLength(1);
    expect(added[0]?.companyId).toBe(c.id);
    expect(added[0]?.dealId).toBe(deal.id);
  });

  it("a won or lost deal is still a valid file target", async () => {
    const deal = await makeDeal(handle.db, actorId);
    await winDeal(handle.db, actorId, deal.id);
    const file = await attachFile(handle.db, actorId, {
      originalName: "signed.pdf", mime: "application/pdf", sizeBytes: 1, sha256: sha, dealId: deal.id,
    });
    expect(file.dealId).toBe(deal.id);
  });

  it("refuses attaching to an archived deal", async () => {
    const deal = await makeDeal(handle.db, actorId);
    await archiveDeal(handle.db, actorId, deal.id);
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, dealId: deal.id,
    })).rejects.toBeInstanceOf(ArchivedError);
  });

  // drizzle-postgres wraps the underlying pg error in a DrizzleQueryError whose own
  // .message is just "Failed query: ...";  the constraint-violation text (and thus the
  // constraint name) lives on .cause, so assertions match against that instead of the
  // top-level message.
  it("attaches a file to a project and stamps the event with the project's companyId", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const project = await createProject(handle.db, actorId, { name: "Launch", companyId: c.id });
    const file = await attachFile(handle.db, actorId, {
      originalName: "spec.pdf", mime: "application/pdf", sizeBytes: 10, sha256: sha, projectId: project.id,
    });
    expect(file.projectId).toBe(project.id);
    expect(file.companyId).toBeNull();

    const evs = await handle.db.select().from(events).where(eq(events.projectId, project.id));
    const added = evs.filter((e) => e.verb === "file_attached");
    expect(added).toHaveLength(1);
    expect(added[0]?.companyId).toBe(c.id);
    expect(added[0]?.projectId).toBe(project.id);
  });

  it("refuses attaching to an archived project", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    await archiveProject(handle.db, actorId, project.id);
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, projectId: project.id,
    })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("listFiles filters by projectId", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    const file = await attachFile(handle.db, actorId, {
      originalName: "on-launch.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, projectId: project.id,
    });

    const result = await listFiles(handle.db, { projectId: project.id });
    expect(result.map((f) => f.id)).toEqual([file.id]);
  });

  it("the DB CHECK rejects a hand-inserted file with both FKs set", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const p = await createContact(handle.db, actorId, { firstName: "Ada" });
    await expect(handle.db.insert(files).values({
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha,
      uploaderUserId: actorId, companyId: c.id, contactId: p.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/files_exactly_one_entity|check/i) },
    });
  });

  it("the DB CHECK rejects a hand-inserted file with neither FK set", async () => {
    await expect(handle.db.insert(files).values({
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, uploaderUserId: actorId,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/files_exactly_one_entity|check/i) },
    });
  });

  it("listFiles filters by entity and orders newest first", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const other = await createCompany(handle.db, actorId, { name: "Globex" });
    const first = await attachFile(handle.db, actorId, {
      originalName: "first.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, companyId: c.id,
    });
    const second = await attachFile(handle.db, actorId, {
      originalName: "second.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, companyId: c.id,
    });
    await attachFile(handle.db, actorId, {
      originalName: "unrelated.txt", mime: "text/plain", sizeBytes: 1, sha256: sha, companyId: other.id,
    });

    const result = await listFiles(handle.db, { companyId: c.id });
    expect(result.map((f) => f.id)).toEqual([second.id, first.id]);
  });

  it("getFile returns null for an unknown id", async () => {
    expect(await getFile(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeNull();
  });

  /**
   * THE FIFTH PARENT, PHASE 9. It exists so a RENDERED DOCUMENT can live on the
   * record it is a document of: `documents.file_id` is NOT NULL and a meeting
   * summary attaches to its meeting, so without this the document and its own page
   * would disagree about what they belong to.
   *
   * Tested HERE and not only through issueMeetingSummary, because the service
   * checks the meeting itself before calling in -- so every branch below is
   * unreachable from that direction and a mutation to any of them would survive a
   * suite that only exercised the happy path one layer up.
   */
  it("attaches a file to a meeting and stamps the event with all of the meeting's links", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Jane" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: "2026-09-01T09:00:00.000Z",
      companyId: c.id, contactId: contact.id, attendees: [],
    });
    const file = await attachFile(handle.db, actorId, {
      originalName: "summary.pdf", mime: "application/pdf", sizeBytes: 10, sha256: sha,
      meetingId: meeting.id,
    });
    expect(file.meetingId).toBe(meeting.id);
    expect(file.companyId).toBeNull();
    expect(file.dealId).toBeNull();

    // ALL FOUR OF THE MEETING'S LINKS, not just a company: a meeting may carry
    // several, and one linked only to a contact has no company at all -- an event
    // stamped with the company alone would land on no timeline whatsoever.
    const added = (await handle.db.select().from(events))
      .filter((e) => e.verb === "file_attached");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ companyId: c.id, contactId: contact.id });
    // ...AND NOT WITH meeting_id. timeline.ts's attendance widening reaches rows
    // whose meeting_id is set and whose task_id is NULL, and its comment restricts
    // that to the meeting's OWN lifecycle rows; a rendered summary is something
    // the meeting spawned, not the meeting.
    expect(added[0]?.meetingId).toBeNull();
  });

  it("refuses attaching to an archived meeting", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: "2026-09-01T09:00:00.000Z", companyId: c.id, attendees: [],
    });
    await archiveMeeting(handle.db, actorId, meeting.id);
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.pdf", mime: "application/pdf", sizeBytes: 1, sha256: sha,
      meetingId: meeting.id,
    })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("refuses attaching to a missing meeting", async () => {
    await expect(attachFile(handle.db, actorId, {
      originalName: "x.pdf", mime: "application/pdf", sizeBytes: 1, sha256: sha,
      meetingId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the DB CHECK rejects a hand-inserted file on both a meeting and a company", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: "2026-09-01T09:00:00.000Z", companyId: c.id, attendees: [],
    });
    await expect(handle.db.insert(files).values({
      originalName: "x.txt", mime: "text/plain", sizeBytes: 1, sha256: sha,
      uploaderUserId: actorId, companyId: c.id, meetingId: meeting.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/files_exactly_one_entity/i) },
    });
  });
});
