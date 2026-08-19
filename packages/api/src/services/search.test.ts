import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { searchResultsSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact, archiveContact } from "./contacts.js";
import { createNote } from "./notes.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal, archiveDeal, winDeal } from "./deals.js";
import { createTask, archiveTask, setTaskStatus } from "./tasks.js";
import { createProject } from "./projects.js";
import { search } from "./search.js";

const handle = openTestDatabase();
let actorId: string;
const DEFAULT_CURRENCY = "EUR";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

async function makeDeal(title: string) {
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
  return createDeal(handle.db, actorId, { title, pipelineId: pipeline.id, stageId: stage.id }, DEFAULT_CURRENCY);
}

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
    expect(result.deals).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it("finds a deal by a title fragment", async () => {
    const deal = await makeDeal("Zylexo renewal");

    const result = await search(handle.db, "Zylexo");
    expect(result.deals.map((d) => d.id)).toContain(deal.id);
    expect(result.deals.find((d) => d.id === deal.id)?.title).toBe("Zylexo renewal");
  });

  it("excludes an archived deal from the deals group", async () => {
    const deal = await makeDeal("Vortixel contract");
    await archiveDeal(handle.db, actorId, deal.id);

    const result = await search(handle.db, "Vortixel");
    expect(result.deals.map((d) => d.id)).not.toContain(deal.id);
  });

  // Closing a deal must not make it unfindable -- a won deal is exactly the
  // kind of record someone looks up by name later (checking terms, pulling up
  // the contract). Only archiving hides a deal from search, the same rule
  // every other group in this file follows.
  it("still finds a WON deal by title -- closing is not archiving", async () => {
    const deal = await makeDeal("Wexfordbay expansion");
    await winDeal(handle.db, actorId, deal.id);

    const result = await search(handle.db, "Wexfordbay");
    expect(result.deals.map((d) => d.id)).toContain(deal.id);
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

  it("slices the snippet on code points, never orphaning half of a surrogate pair", async () => {
    // A homogeneous run of emoji (all 2 UTF-16 units wide) can never trigger a
    // mid-pair cut at the +/-60 boundary on its own -- the offset arithmetic stays
    // even no matter how the run is sized or prefixed. Mixing in a single 1-unit
    // ASCII character partway through the run breaks that parity, so the naive
    // UTF-16-code-unit slice this replaces really did land inside a surrogate
    // pair for this exact shape (verified against the pre-fix implementation).
    const lonePairPattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const company = await createCompany(handle.db, actorId, { name: "Emoji Co" });
    const pad = `${"\u{1F600}".repeat(5)}a${"\u{1F600}".repeat(25)}`;
    const body = `${pad}findme${pad}`;
    const note = await createNote(handle.db, actorId, { body, companyId: company.id });

    const result = await search(handle.db, "findme");
    const found = result.notes.find((n) => n.id === note.id);
    expect(found).toBeDefined();
    expect(lonePairPattern.test(found?.snippet ?? "")).toBe(false);
  });

  it("finds a task by a title fragment", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    const task = await createTask(handle.db, actorId, { title: "Zylexo onboarding call", projectId: project.id });

    const result = await search(handle.db, "Zylexo");
    expect(result.tasks.map((t) => t.id)).toContain(task.id);
    const found = result.tasks.find((t) => t.id === task.id);
    expect(found?.title).toBe("Zylexo onboarding call");
    expect(found?.projectId).toBe(project.id);
  });

  // Unlike a deal's status, a done task's title must stay findable too --
  // finding a piece of finished work by name is exactly as useful as finding
  // a won deal above, and for the same reason.
  it("still finds a DONE task by title -- completion is not archiving", async () => {
    const task = await createTask(handle.db, actorId, { title: "Wexfordbay migration" });
    await setTaskStatus(handle.db, actorId, task.id, "done");

    const result = await search(handle.db, "Wexfordbay");
    expect(result.tasks.map((t) => t.id)).toContain(task.id);
  });

  it("excludes an archived task from the tasks group", async () => {
    const task = await createTask(handle.db, actorId, { title: "Vortixel cleanup" });
    await archiveTask(handle.db, actorId, task.id);

    const result = await search(handle.db, "Vortixel");
    expect(result.tasks.map((t) => t.id)).not.toContain(task.id);
  });

  it("excludes a note whose parent contact is archived", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Marlowe", lastName: "Finch" });
    const note = await createNote(handle.db, actorId, { body: "marlowe finch follow-up notes", contactId: contact.id });
    await archiveContact(handle.db, actorId, contact.id);

    const result = await search(handle.db, "marlowe finch");
    expect(result.notes.map((n) => n.id)).not.toContain(note.id);
  });
});
