import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, notes } from "../db/schema.js";
import { createNote, listNotes } from "./notes.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createDeal, archiveDeal, winDeal } from "./deals.js";
import { createPipeline, createStage } from "./pipelines.js";
import { NotFoundError, ArchivedError } from "./errors.js";

/** Creates a global pipeline, one stage, and one deal in it (optionally
 * company-scoped) -- mirrors the routes.test.ts makeDeal helper but calls the
 * services directly, since these are service-level tests. */
async function makeDeal(db: Database, actorId: string, companyId?: string) {
  const pipeline = await createPipeline(db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(db, actorId, pipeline.id, { name: "Lead" });
  return createDeal(db, actorId, { title: "Big Co deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR");
}

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("notes service", () => {
  it("adds a note to a company and records exactly one note_added event with a 120-char preview", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const body = "x".repeat(200);
    const note = await createNote(handle.db, actorId, { body, companyId: c.id });
    expect(note.companyId).toBe(c.id);
    expect(note.contactId).toBeNull();
    expect(note.body).toBe(body);

    const evs = await handle.db.select().from(events).where(eq(events.companyId, c.id));
    const added = evs.filter((e) => e.verb === "note_added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({ noteId: note.id, preview: "x".repeat(120) });
    expect(added[0]?.companyId).toBe(c.id);
    expect(added[0]?.contactId).toBeNull();
  });

  it("adds a note to a contact and records exactly one note_added event", async () => {
    const p = await createContact(handle.db, actorId, { firstName: "Ada" });
    const body = "y".repeat(150);
    const note = await createNote(handle.db, actorId, { body, contactId: p.id });
    expect(note.contactId).toBe(p.id);
    expect(note.companyId).toBeNull();

    const evs = await handle.db.select().from(events).where(eq(events.contactId, p.id));
    const added = evs.filter((e) => e.verb === "note_added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({ noteId: note.id, preview: "y".repeat(120) });
    expect(added[0]?.contactId).toBe(p.id);
    expect(added[0]?.companyId).toBeNull();
  });

  it("refuses a note on an archived company", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await expect(createNote(handle.db, actorId, { body: "hi", companyId: c.id }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("refuses a note on a missing contact", async () => {
    await expect(createNote(handle.db, actorId, {
      body: "hi", contactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("adds a note to a deal and stamps the event with the deal's companyId", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const deal = await makeDeal(handle.db, actorId, c.id);
    const note = await createNote(handle.db, actorId, { body: "checking in", dealId: deal.id });
    expect(note.dealId).toBe(deal.id);
    expect(note.companyId).toBeNull();
    expect(note.contactId).toBeNull();

    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const added = evs.filter((e) => e.verb === "note_added");
    expect(added).toHaveLength(1);
    // The note row itself carries only dealId (per the exactly-one CHECK), but
    // the event is also stamped with the deal's own companyId so it surfaces
    // on the company's timeline too -- see createNote's doc comment.
    expect(added[0]?.companyId).toBe(c.id);
    expect(added[0]?.dealId).toBe(deal.id);
  });

  it("a won or lost deal is still a valid note target", async () => {
    const deal = await makeDeal(handle.db, actorId);
    await winDeal(handle.db, actorId, deal.id);
    const note = await createNote(handle.db, actorId, { body: "signed!", dealId: deal.id });
    expect(note.dealId).toBe(deal.id);
  });

  it("refuses a note on an archived deal", async () => {
    const deal = await makeDeal(handle.db, actorId);
    await archiveDeal(handle.db, actorId, deal.id);
    await expect(createNote(handle.db, actorId, { body: "hi", dealId: deal.id }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("refuses a note on a missing deal", async () => {
    await expect(createNote(handle.db, actorId, {
      body: "hi", dealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  // drizzle-postgres wraps the underlying pg error in a DrizzleQueryError whose
  // own .message is just "Failed query: ...";  the constraint-violation text
  // (and thus the constraint name) lives on .cause, so assertions match against
  // that instead of the top-level message.
  it("the DB CHECK rejects a hand-inserted note with both FKs set", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const p = await createContact(handle.db, actorId, { firstName: "Ada" });
    await expect(handle.db.insert(notes).values({
      body: "x", authorUserId: actorId, companyId: c.id, contactId: p.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/notes_exactly_one_entity|check/i) },
    });
  });

  it("the DB CHECK rejects a hand-inserted note with neither FK set", async () => {
    await expect(handle.db.insert(notes).values({
      body: "x", authorUserId: actorId,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/notes_exactly_one_entity|check/i) },
    });
  });

  it("listNotes filters by entity and orders newest first", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const other = await createCompany(handle.db, actorId, { name: "Globex" });
    const first = await createNote(handle.db, actorId, { body: "first", companyId: c.id });
    const second = await createNote(handle.db, actorId, { body: "second", companyId: c.id });
    await createNote(handle.db, actorId, { body: "unrelated", companyId: other.id });

    const result = await listNotes(handle.db, { companyId: c.id });
    expect(result.map((n) => n.id)).toEqual([second.id, first.id]);
  });
});
