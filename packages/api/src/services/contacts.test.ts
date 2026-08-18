import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import {
  createContact, updateContact, archiveContact, unarchiveContact,
  listContacts, getContact,
} from "./contacts.js";
import { createCompany, archiveCompany } from "./companies.js";
import { NotFoundError, ArchivedError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("contacts service", () => {
  it("creates a contact and records a created event", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Ada" });
    expect(contact.firstName).toBe("Ada");
    const evs = await handle.db.select().from(events).where(eq(events.contactId, contact.id));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.verb).toBe("created");
  });

  it("updates fields, bumps updatedAt, and records the changed field names", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    const updated = await updateContact(handle.db, actorId, c.id, { lastName: "Lovelace", jobTitle: "Analyst" });
    expect(updated.lastName).toBe("Lovelace");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(c.updatedAt).getTime());
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["lastName", "jobTitle"] });
  });

  it("archive hides from the default list but getContact still returns it", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    await archiveContact(handle.db, actorId, c.id);
    expect((await listContacts(handle.db, {})).items).toHaveLength(0);
    expect((await listContacts(handle.db, { archived: true })).items).toHaveLength(1);
    expect((await getContact(handle.db, c.id))?.archivedAt).not.toBeNull();
  });

  it("refuses to update an archived contact", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    await archiveContact(handle.db, actorId, c.id);
    await expect(updateContact(handle.db, actorId, c.id, { firstName: "X" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("unarchive restores listability", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    await archiveContact(handle.db, actorId, c.id);
    await unarchiveContact(handle.db, actorId, c.id);
    expect((await listContacts(handle.db, {})).items).toHaveLength(1);
  });

  it("a same-value patch is a no-op: no updated event, updatedAt unchanged", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    const result = await updateContact(handle.db, actorId, c.id, { firstName: "Ada" });
    expect(result.updatedAt).toBe(c.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("an empty patch is a no-op and returns the contact", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    const result = await updateContact(handle.db, actorId, c.id, {});
    expect(result).toEqual(c);
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("excludes unchanged fields from the changed list when a patch mixes both", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada", jobTitle: "Analyst" });
    await updateContact(handle.db, actorId, c.id, { firstName: "Ada", jobTitle: "Engineer" });
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["jobTitle"] });
  });

  it("archiving an already-archived contact is idempotent: no duplicate event", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    await archiveContact(handle.db, actorId, c.id);
    await archiveContact(handle.db, actorId, c.id);
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    expect(evs.filter((e) => e.verb === "archived")).toHaveLength(1);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateContact(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { firstName: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters by q on name and paginates with a stable cursor", async () => {
    for (let i = 0; i < 3; i++) await createContact(handle.db, actorId, { firstName: `Ada${i}` });
    await createContact(handle.db, actorId, { firstName: "Grace" });
    expect((await listContacts(handle.db, { q: "ada" })).items).toHaveLength(3);
    const page1 = await listContacts(handle.db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listContacts(handle.db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((x) => x.id));
    expect(ids.size).toBe(4);
  });

  it("listContacts filters by companyId and excludes another company's contacts", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    const globex = await createCompany(handle.db, actorId, { name: "Globex" });
    const c1 = await createContact(handle.db, actorId, { firstName: "Ada", companyId: acme.id });
    const c2 = await createContact(handle.db, actorId, { firstName: "Grace", companyId: globex.id });
    const acmeResult = await listContacts(handle.db, { companyId: acme.id });
    expect(acmeResult.items).toHaveLength(1);
    expect(acmeResult.items[0]?.id).toBe(c1.id);
    const globexResult = await listContacts(handle.db, { companyId: globex.id });
    expect(globexResult.items).toHaveLength(1);
    expect(globexResult.items[0]?.id).toBe(c2.id);
  });

  it("q matches an email fragment", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });
    await createContact(handle.db, actorId, { firstName: "Grace", emails: ["grace@other.com"] });
    const result = await listContacts(handle.db, { q: "ada@example" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(c.id);
  });

  it("createContact with a nonexistent companyId throws NotFoundError", async () => {
    await expect(createContact(handle.db, actorId, {
      firstName: "Ada", companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updateContact with a nonexistent companyId throws NotFoundError", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada" });
    await expect(updateContact(handle.db, actorId, c.id, {
      companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an archived company is still a valid link target for a new contact", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, acme.id);
    const c = await createContact(handle.db, actorId, { firstName: "Ada", companyId: acme.id });
    expect(c.companyId).toBe(acme.id);
  });

  it("a same-order emails patch is a no-op: no updated event", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada", emails: ["a@x.com", "b@x.com"] });
    const result = await updateContact(handle.db, actorId, c.id, { emails: ["a@x.com", "b@x.com"] });
    expect(result.updatedAt).toBe(c.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("a reordered emails patch is a real change and records changed: [\"emails\"]", async () => {
    const c = await createContact(handle.db, actorId, { firstName: "Ada", emails: ["a@x.com", "b@x.com"] });
    await updateContact(handle.db, actorId, c.id, { emails: ["b@x.com", "a@x.com"] });
    const evs = await handle.db.select().from(events).where(eq(events.contactId, c.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["emails"] });
  });
});
