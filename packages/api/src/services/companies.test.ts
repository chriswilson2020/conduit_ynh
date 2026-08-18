import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import {
  createCompany, updateCompany, archiveCompany, unarchiveCompany,
  listCompanies, getCompany,
} from "./companies.js";
import { NotFoundError, ArchivedError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("companies service", () => {
  it("creates a company and records a created event", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    expect(company.name).toBe("Acme");
    const evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.verb).toBe("created");
  });

  it("updates fields, bumps updatedAt, and records the changed field names", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const updated = await updateCompany(handle.db, actorId, c.id, { phone: "+31 6 1234", industry: "biotech" });
    expect(updated.phone).toBe("+31 6 1234");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(c.updatedAt).getTime());
    const evs = await handle.db.select().from(events).where(eq(events.companyId, c.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["phone", "industry"] });
  });

  it("archive hides from the default list but getCompany still returns it", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    expect((await listCompanies(handle.db, {})).items).toHaveLength(0);
    expect((await listCompanies(handle.db, { archived: true })).items).toHaveLength(1);
    expect((await getCompany(handle.db, c.id))?.archivedAt).not.toBeNull();
  });

  it("refuses to update an archived company", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await expect(updateCompany(handle.db, actorId, c.id, { name: "X" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("unarchive restores listability", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await unarchiveCompany(handle.db, actorId, c.id);
    expect((await listCompanies(handle.db, {})).items).toHaveLength(1);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateCompany(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters by q and paginates with a stable cursor", async () => {
    for (let i = 0; i < 3; i++) await createCompany(handle.db, actorId, { name: `Acme ${i}` });
    await createCompany(handle.db, actorId, { name: "Globex" });
    expect((await listCompanies(handle.db, { q: "acme" })).items).toHaveLength(3);
    const page1 = await listCompanies(handle.db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listCompanies(handle.db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((x) => x.id));
    expect(ids.size).toBe(4);
  });
});
