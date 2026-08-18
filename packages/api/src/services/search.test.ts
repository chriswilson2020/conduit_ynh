import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { searchResultsSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact, archiveContact } from "./contacts.js";
import { createNote } from "./notes.js";
import { search } from "./search.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("search service", () => {
  it("returns grouped, schema-valid results across companies, contacts, and notes", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Zylexo Corp" });
    const contact = await createContact(handle.db, actorId, { firstName: "Zylexo", lastName: "Person" });
    const note = await createNote(handle.db, actorId, { body: "a note about Zylexo plans", companyId: company.id });

    const result = await search(handle.db, "Zylexo");
    expect(() => searchResultsSchema.parse(result)).not.toThrow();
    expect(result.companies.map((c) => c.id)).toContain(company.id);
    expect(result.contacts.map((c) => c.id)).toContain(contact.id);
    expect(result.notes.map((n) => n.id)).toContain(note.id);
  });

  it("excludes an archived company from the companies group", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Vortixel Inc" });
    await archiveCompany(handle.db, actorId, company.id);

    const result = await search(handle.db, "Vortixel");
    expect(result.companies).toHaveLength(0);
  });

  it("finds a contact by an email fragment", async () => {
    const contact = await createContact(handle.db, actorId, {
      firstName: "Nora", lastName: "Quill", emails: ["nora.quill@wexfordbay.example"],
    });

    const result = await search(handle.db, "wexfordbay");
    expect(result.contacts.map((c) => c.id)).toContain(contact.id);
  });

  it("builds a snippet with ellipses on both sides when the match is mid-string, and none leading when the match is at position 0", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Snippet Co" });
    const padding = "z".repeat(100);
    const midBody = `${padding} findme ${padding}`;
    const midNote = await createNote(handle.db, actorId, { body: midBody, companyId: company.id });

    const startBody = `findme ${"y".repeat(210)}`;
    const startNote = await createNote(handle.db, actorId, { body: startBody, companyId: company.id });

    const result = await search(handle.db, "findme");
    const midSnippet = result.notes.find((n) => n.id === midNote.id)?.snippet;
    const startSnippet = result.notes.find((n) => n.id === startNote.id)?.snippet;

    expect(midSnippet).toBeDefined();
    expect(midSnippet).toMatch(/^\.\.\./);
    expect(midSnippet).toMatch(/\.\.\.$/);
    expect(midSnippet).toContain("findme");

    expect(startSnippet).toBeDefined();
    expect(startSnippet?.startsWith("...")).toBe(false);
    expect(startSnippet).toContain("findme");
  });

  it("treats % in the query as a literal character, not an ILIKE wildcard", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Percent Co" });
    const match = await createNote(handle.db, actorId, { body: "50% off deal", companyId: company.id });
    const decoy = await createNote(handle.db, actorId, { body: "500 units", companyId: company.id });

    const result = await search(handle.db, "50%");
    const ids = result.notes.map((n) => n.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(decoy.id);
  });

  it("excludes a note whose parent company is archived", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Archivax Ltd" });
    const note = await createNote(handle.db, actorId, { body: "archivax secret plans", companyId: company.id });
    await archiveCompany(handle.db, actorId, company.id);

    const result = await search(handle.db, "archivax");
    expect(result.notes.map((n) => n.id)).not.toContain(note.id);
  });

  it("excludes a note whose parent contact is archived", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Marlowe", lastName: "Finch" });
    const note = await createNote(handle.db, actorId, { body: "marlowe finch follow-up notes", contactId: contact.id });
    await archiveContact(handle.db, actorId, contact.id);

    const result = await search(handle.db, "marlowe finch");
    expect(result.notes.map((n) => n.id)).not.toContain(note.id);
  });
});
