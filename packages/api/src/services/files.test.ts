import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, files } from "../db/schema.js";
import { attachFile, listFiles, getFile } from "./files.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { NotFoundError, ArchivedError } from "./errors.js";

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

  // drizzle-postgres wraps the underlying pg error in a DrizzleQueryError whose own
  // .message is just "Failed query: ...";  the constraint-violation text (and thus the
  // constraint name) lives on .cause, so assertions match against that instead of the
  // top-level message.
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
});
