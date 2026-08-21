import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { searchResultsSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
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

    const result = await search(handle.db, actorId, "Zylexo");
    expect(() => searchResultsSchema.parse(result)).not.toThrow();
    expect(result.companies.map((c) => c.id)).toContain(company.id);
    expect(result.contacts.map((c) => c.id)).toContain(contact.id);
    expect(result.notes.map((n) => n.id)).toContain(note.id);
    expect(result.deals).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it("finds a deal by a title fragment", async () => {
    const deal = await makeDeal("Zylexo renewal");

    const result = await search(handle.db, actorId, "Zylexo");
    expect(result.deals.map((d) => d.id)).toContain(deal.id);
    expect(result.deals.find((d) => d.id === deal.id)?.title).toBe("Zylexo renewal");
  });

  it("excludes an archived deal from the deals group", async () => {
    const deal = await makeDeal("Vortixel contract");
    await archiveDeal(handle.db, actorId, deal.id);

    const result = await search(handle.db, actorId, "Vortixel");
    expect(result.deals.map((d) => d.id)).not.toContain(deal.id);
  });

  // Closing a deal must not make it unfindable -- a won deal is exactly the
  // kind of record someone looks up by name later (checking terms, pulling up
  // the contract). Only archiving hides a deal from search, the same rule
  // every other group in this file follows.
  it("still finds a WON deal by title -- closing is not archiving", async () => {
    const deal = await makeDeal("Wexfordbay expansion");
    await winDeal(handle.db, actorId, deal.id);

    const result = await search(handle.db, actorId, "Wexfordbay");
    expect(result.deals.map((d) => d.id)).toContain(deal.id);
  });

  it("excludes an archived company from the companies group", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Vortixel Inc" });
    await archiveCompany(handle.db, actorId, company.id);

    const result = await search(handle.db, actorId, "Vortixel");
    expect(result.companies).toHaveLength(0);
  });

  it("finds a contact by an email fragment", async () => {
    const contact = await createContact(handle.db, actorId, {
      firstName: "Nora", lastName: "Quill", emails: ["nora.quill@wexfordbay.example"],
    });

    const result = await search(handle.db, actorId, "wexfordbay");
    expect(result.contacts.map((c) => c.id)).toContain(contact.id);
  });

  it("builds a snippet with ellipses on both sides when the match is mid-string, and none leading when the match is at position 0", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Snippet Co" });
    const padding = "z".repeat(100);
    const midBody = `${padding} findme ${padding}`;
    const midNote = await createNote(handle.db, actorId, { body: midBody, companyId: company.id });

    const startBody = `findme ${"y".repeat(210)}`;
    const startNote = await createNote(handle.db, actorId, { body: startBody, companyId: company.id });

    const result = await search(handle.db, actorId, "findme");
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

    const result = await search(handle.db, actorId, "50%");
    const ids = result.notes.map((n) => n.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(decoy.id);
  });

  it("excludes a note whose parent company is archived", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Archivax Ltd" });
    const note = await createNote(handle.db, actorId, { body: "archivax secret plans", companyId: company.id });
    await archiveCompany(handle.db, actorId, company.id);

    const result = await search(handle.db, actorId, "archivax");
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

    const result = await search(handle.db, actorId, "findme");
    const found = result.notes.find((n) => n.id === note.id);
    expect(found).toBeDefined();
    expect(lonePairPattern.test(found?.snippet ?? "")).toBe(false);
  });

  it("finds a task by a title fragment", async () => {
    const project = await createProject(handle.db, actorId, { name: "Launch" });
    const task = await createTask(handle.db, actorId, { title: "Zylexo onboarding call", projectId: project.id });

    const result = await search(handle.db, actorId, "Zylexo");
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

    const result = await search(handle.db, actorId, "Wexfordbay");
    expect(result.tasks.map((t) => t.id)).toContain(task.id);
  });

  it("excludes an archived task from the tasks group", async () => {
    const task = await createTask(handle.db, actorId, { title: "Vortixel cleanup" });
    await archiveTask(handle.db, actorId, task.id);

    const result = await search(handle.db, actorId, "Vortixel");
    expect(result.tasks.map((t) => t.id)).not.toContain(task.id);
  });

  it("excludes a note whose parent contact is archived", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Marlowe", lastName: "Finch" });
    const note = await createNote(handle.db, actorId, { body: "marlowe finch follow-up notes", contactId: contact.id });
    await archiveContact(handle.db, actorId, contact.id);

    const result = await search(handle.db, actorId, "marlowe finch");
    expect(result.notes.map((n) => n.id)).not.toContain(note.id);
  });
});

// The one full-text group, so it is exercised on the properties the others
// cannot have: thread grouping, rank ordering, and a query string a human
// typed rather than one a parser would accept.
describe("search service: mail group", () => {
  // Rows are inserted directly rather than through ingest: this group is a
  // query, and driving mailparser to reach it would only make the fixture
  // harder to read. credentials_ciphertext is never decrypted on this path.
  async function makeMailAccount(
    opts: { owner?: string; visibility?: "private" | "shared" } = {},
  ): Promise<string> {
    const [row] = await handle.db.insert(mailAccounts).values({
      userId: opts.owner ?? actorId, label: "Work", email: `chris+${randomUUID()}@example.com`,
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
      username: "chris", credentialsCiphertext: "v1:unused-in-search-tests",
      visibility: opts.visibility ?? "private",
    }).returning();
    if (row === undefined) throw new Error("makeMailAccount: no row");
    return row.id;
  }

  async function makeMailThread(
    subject: string,
    opts: { archived?: boolean; contactId?: string; dealId?: string; projectId?: string } = {},
  ): Promise<string> {
    const [row] = await handle.db.insert(mailThreads).values({
      subject, lastMessageAt: new Date("2026-08-02T10:00:00Z"), messageCount: 1,
      archivedAt: opts.archived === true ? new Date() : null,
      contactId: opts.contactId ?? null, dealId: opts.dealId ?? null, projectId: opts.projectId ?? null,
    }).returning();
    if (row === undefined) throw new Error("makeMailThread: no row");
    return row.id;
  }

  async function makeMailMessage(
    threadId: string, accountId: string, message: { subject: string; bodyText: string; snippet: string },
  ): Promise<void> {
    await handle.db.insert(mailMessages).values({
      accountId, threadId, messageId: `<${randomUUID()}@example.com>`,
      referencesIds: [], fromAddr: "alice@example.com", fromName: "Alice",
      toAddrs: [{ address: "chris@example.com" }],
      subject: message.subject, bodyText: message.bodyText, snippet: message.snippet,
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "INBOX", seen: true, direction: "inbound",
    });
  }

  it("returns one hit per thread even when several of its messages match", async () => {
    const accountId = await makeMailAccount();
    const threadId = await makeMailThread("Quokkaline rollout");
    for (const n of [1, 2, 3]) {
      await makeMailMessage(threadId, accountId, {
        subject: `Quokkaline ${n}`, bodyText: "quokkaline planning", snippet: `snippet ${n}`,
      });
    }

    const result = await search(handle.db, actorId, "quokkaline");
    expect(() => searchResultsSchema.parse(result)).not.toThrow();
    expect(result.mail.filter((hit) => hit.threadId === threadId)).toHaveLength(1);
  });

  it("caps the mail group at five threads", async () => {
    const accountId = await makeMailAccount();
    for (let i = 0; i < 7; i += 1) {
      const threadId = await makeMailThread(`Bramblewick ${i}`);
      await makeMailMessage(threadId, accountId, {
        subject: `Bramblewick ${i}`, bodyText: "bramblewick update", snippet: `snippet ${i}`,
      });
    }
    const result = await search(handle.db, actorId, "bramblewick");
    expect(result.mail).toHaveLength(5);
  });

  it("excludes archived threads", async () => {
    const accountId = await makeMailAccount();
    const live = await makeMailThread("Fenwold live");
    await makeMailMessage(live, accountId, { subject: "Fenwold", bodyText: "fenwold notes", snippet: "live" });
    const filed = await makeMailThread("Fenwold filed", { archived: true });
    await makeMailMessage(filed, accountId, { subject: "Fenwold", bodyText: "fenwold notes", snippet: "filed" });

    const result = await search(handle.db, actorId, "fenwold");
    expect(result.mail.map((hit) => hit.threadId)).toEqual([live]);
  });

  // websearch_to_tsquery, not to_tsquery: a human types punctuation and
  // stray operators, and to_tsquery would raise a syntax error on both.
  it("survives punctuation and bare boolean operators in the query", async () => {
    const accountId = await makeMailAccount();
    const threadId = await makeMailThread("Grimsdale");
    await makeMailMessage(threadId, accountId, {
      subject: "Grimsdale", bodyText: "the grimsdale contract", snippet: "hit",
    });

    for (const q of ["grimsdale!!", "grimsdale & | contract", '"grimsdale contract"', "grimsdale -unrelated"]) {
      const result = await search(handle.db, actorId, q);
      expect(() => searchResultsSchema.parse(result)).not.toThrow();
    }
    expect((await search(handle.db, actorId, "grimsdale!!")).mail.map((hit) => hit.threadId)).toEqual([threadId]);
  });

  // Phase 4.2: the mail group is record-scoped per viewer (searchMail's
  // visibility note). Every other group stays shared CRM data.
  describe("visibility", () => {
    let otherId: string;
    beforeEach(async () => {
      otherId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    });

    async function seedSearchable(subject: string, accountId: string, threadId: string): Promise<void> {
      await makeMailMessage(threadId, accountId, {
        subject, bodyText: `${subject} thornapple notes`, snippet: subject,
      });
    }

    it("applies the record-visible matrix: shared and deal/project-linked mail is findable, private and auto-linked mail is not", async () => {
      const priv = await makeMailAccount();
      const shared = await makeMailAccount({ visibility: "shared" });
      const contact = await createContact(handle.db, actorId, { firstName: "Ada", lastName: "Marsh" });
      const deal = await makeDeal("Thornapple renewal");
      const project = await createProject(handle.db, actorId, { name: "Thornapple rollout" });

      const unlinked = await makeMailThread("Unlinked");
      await seedSearchable("Unlinked", priv, unlinked);
      const contactLinked = await makeMailThread("Contact", { contactId: contact.id });
      await seedSearchable("Contact", priv, contactLinked);
      const dealLinked = await makeMailThread("Deal", { dealId: deal.id });
      await seedSearchable("Deal", priv, dealLinked);
      const projectLinked = await makeMailThread("Project", { projectId: project.id });
      await seedSearchable("Project", priv, projectLinked);
      const onShared = await makeMailThread("Shared");
      await seedSearchable("Shared", shared, onShared);

      const ownHits = (await search(handle.db, actorId, "thornapple")).mail.map((hit) => hit.threadId).sort();
      expect(ownHits).toEqual([unlinked, contactLinked, dealLinked, projectLinked, onShared].sort());
      const otherHits = (await search(handle.db, otherId, "thornapple")).mail.map((hit) => hit.threadId).sort();
      expect(otherHits).toEqual([dealLinked, projectLinked, onShared].sort());
    });

    it("never matches on an invisible message, even when its thread is visible to the viewer", async () => {
      const chrisPrivate = await makeMailAccount();
      const danaOwn = await makeMailAccount({ owner: otherId });
      // One conversation in two mailboxes: dana's copy never mentions the
      // term; chris's copy -- the only match -- is private to chris.
      const threadId = await makeMailThread("Cross");
      await makeMailMessage(threadId, danaOwn, {
        subject: "Re: plans", bodyText: "nothing relevant here", snippet: "dana copy",
      });
      await makeMailMessage(threadId, chrisPrivate, {
        subject: "bristlecomb", bodyText: "bristlecomb figures", snippet: "chris only",
      });

      expect((await search(handle.db, actorId, "bristlecomb")).mail.map((hit) => hit.threadId)).toEqual([threadId]);
      // The thread being visible to dana does not make chris's message
      // searchable: the term is applied per message, inside the ranking.
      expect((await search(handle.db, otherId, "bristlecomb")).mail).toEqual([]);
    });

    it("represents a visible thread by its best VISIBLE match, not by an invisible stronger one", async () => {
      const chrisPrivate = await makeMailAccount();
      const danaOwn = await makeMailAccount({ owner: otherId });
      const threadId = await makeMailThread("Cross");
      await makeMailMessage(threadId, danaOwn, {
        subject: "Re: plans", bodyText: "one mention of saltmarsh", snippet: "dana hit",
      });
      // Stronger match, invisible to dana: must neither rank for dana nor
      // leak its snippet into dana's result row.
      await makeMailMessage(threadId, chrisPrivate, {
        subject: "saltmarsh saltmarsh", bodyText: "saltmarsh saltmarsh saltmarsh", snippet: "chris hit",
      });

      const own = (await search(handle.db, actorId, "saltmarsh")).mail;
      expect(own.map((hit) => hit.threadId)).toEqual([threadId]);
      expect(own[0]?.snippet).toBe("chris hit");
      const other = (await search(handle.db, otherId, "saltmarsh")).mail;
      expect(other.map((hit) => hit.threadId)).toEqual([threadId]);
      expect(other[0]?.snippet).toBe("dana hit");
    });
  });
});
