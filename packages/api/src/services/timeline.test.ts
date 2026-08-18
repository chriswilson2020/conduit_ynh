import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
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
});
