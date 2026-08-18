import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eventVerbSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import { listEvents } from "./timeline.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createNote } from "./notes.js";

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
