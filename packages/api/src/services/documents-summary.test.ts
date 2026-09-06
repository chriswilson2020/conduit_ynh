import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  documentTypeFreezes, documentTypeNumbered, RENDER_MARKUP_CAP_BYTES,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import { seededMeetingSummaryTemplate, seededSummaryTemplatePaths } from "../test/seed-template.js";
import { pageCount, pdfVisibleText } from "../test/pdf.js";
import { resolveUser } from "../users.js";
import {
  documentNumberSequences, documentQuotes, documents, documentTemplates, events, files,
  meetingAttendees, meetings, users,
} from "../db/schema.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createMeeting } from "./meetings.js";
import { blobPath } from "./blobs.js";
import { saveOrgProfile } from "./org-profile.js";
import { prepareDocumentHtml } from "./documents-template.js";
import { weasyprintAvailable } from "./documents-render.js";
import {
  buildMeetingSummaryContext, DocumentTemplateMissingError, DocumentTooLargeError,
  issueMeetingSummary, listMeetingSummaries,
} from "./documents.js";
import { ArchivedError, NotFoundError } from "./errors.js";

/**
 * THE MEETING SUMMARY: THE TYPE WITH NO FORM.
 *
 * Everything printed is on the `meetings` row, so the only input is which meeting
 * and the only decision the service makes is what day it is. What this file is
 * mostly about, therefore, is the three things that are NOT true of a quote:
 *
 *   - **NO NUMBER.** Not merely absent from the row -- nothing anywhere allocates
 *     one, and `document_number_sequences` stays empty, which is the assertion
 *     that would catch a writer calling allocateNumber "for consistency".
 *   - **NOT FROZEN**, so producing a second one is ordinary and appends.
 *   - **THE NOTES ARE MARKUP.** They are the one merge value in this system that
 *     is emitted unescaped, and the two sanitiser passes around that are the
 *     control this file has to exercise rather than assume.
 *
 * THE STUB RENDERER IS documents.test.ts's, and its header has the argument for
 * why most of a document suite runs without WeasyPrint: the failure paths are
 * exactly the ones a binary-gated suite would skip on a developer machine. The
 * gated cases at the end are the ones that need a real PDF.
 */
const handle = openTestDatabase();
const stubDir = mkdtempSync(join(tmpdir(), "conduit-summary-"));
const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

let dataDir: string;
let actorId: string;
let companyId: string;
let meetingId: string;

const NOTES_HTML = "<p>Agreed to ship on the 3rd.</p><ul><li>Jane to draft the plan</li></ul>";

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = mkdtempSync(join(stubDir, "data-"));
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  const company = await createCompany(handle.db, actorId, { name: "Acme Manufacturing BV" });
  companyId = company.id;
  const meeting = await createMeeting(handle.db, actorId, {
    title: "Kickoff with Acme",
    occurredAt: "2026-09-01T13:30:00.000Z",
    durationMinutes: 45,
    notes: NOTES_HTML,
    companyId,
    attendees: [],
  });
  meetingId = meeting.id;
  // truncateAll() empties every table in the public schema, so migration 0017's
  // seeded row is gone before any test body runs -- exactly as 0009's is for the
  // quote suite. A test that did not notice would be merging against nothing.
  await seedSummaryTemplate();
});

afterAll(async () => {
  await handle.close();
  rmSync(stubDir, { recursive: true, force: true });
});

async function seedSummaryTemplate(bodyHtml = seededMeetingSummaryTemplate()): Promise<void> {
  await handle.db.delete(documentTemplates).where(eq(documentTemplates.type, "meeting_summary"));
  await handle.db.insert(documentTemplates).values({ type: "meeting_summary", bodyHtml });
}

/**
 * A renderer that echoes the HTML it was given back inside the "PDF", so a test
 * can assert what was MERGED without needing WeasyPrint.
 *
 * renderPdf writes the document to the child's stdin, so `cat` is the whole
 * trick. The `%PDF-` prefix is there because saveBlob and the callers do not
 * care what the bytes are, but a reader of a failure message does.
 */
const ECHOING_RENDER = "printf '%s' '%PDF-1.7 '\ncat";

/** A renderer that succeeds with fixed bytes and nothing else. */
const OK_RENDER = "printf '%s' '%PDF-1.7 ok'";

async function issueWithStub(body = OK_RENDER, id = ""): Promise<Awaited<ReturnType<typeof issueMeetingSummary>>> {
  const dir = writePythonStub(stubDir, body);
  return await withPythonStub(dir, async () =>
    await issueMeetingSummary(handle.db, { dataDir }, actorId, id === "" ? meetingId : id));
}

/** The merged HTML the renderer was handed, recovered from the echoing stub. */
async function mergedHtml(): Promise<string> {
  const summary = await issueWithStub(ECHOING_RENDER);
  const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
  return (await readFile(blobPath(dataDir, file!.sha256), "utf8")).replace(/^%PDF-1\.7 /, "");
}

/** How many blobs the store holds. Zero before the first save, which is not an error. */
function blobCount(): number {
  const dir = join(dataDir, "files");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("issueMeetingSummary writes one document and one file", () => {
  it("attaches the document to the meeting, with no number and no freeze", async () => {
    const summary = await issueWithStub();

    expect(summary).toMatchObject({
      type: "meeting_summary", meetingId, frozen: false, issuedByUserId: actorId,
    });
    // The DTO has no `number` FIELD AT ALL, which is the shape decision rather
    // than a null: a summary does not have a number that happens to be unset.
    expect("number" in summary).toBe(false);

    const [row] = await handle.db.select().from(documents);
    expect(row).toMatchObject({
      type: "meeting_summary", number: null, frozen: false, meetingId,
      companyId: null, contactId: null, dealId: null, projectId: null,
    });
    // Spelled against the shared rules as well as against the literals above,
    // because the row is what the CHECKs police and these two functions are what
    // the writer consulted.
    expect(row?.frozen).toBe(documentTypeFreezes("meeting_summary"));
    expect(documentTypeNumbered("meeting_summary")).toBe(false);
  });

  /**
   * **NOTHING ALLOCATES A NUMBER, AND THIS IS THE ASSERTION THAT SAYS SO.**
   * The row having a NULL number is one thing; a writer that called
   * allocateNumber and then discarded the result would still burn a sequence
   * value on every summary, and `documents_number_matches_type` would not
   * notice. An empty sequence table is the only statement that covers it.
   */
  it("spends no document number, so the quote sequence does not move", async () => {
    await issueWithStub();
    await issueWithStub();
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
  });

  /**
   * THE FIFTH PARENT `files` GAINED IN 0017, and the reason it had to.
   * `documents.file_id` is NOT NULL, every rendered PDF is an ordinary `files`
   * row, and a summary belongs to a meeting -- so without this column the
   * document and its own page would disagree about what they are attached to.
   */
  it("stores the PDF as a files row on the meeting itself", async () => {
    const summary = await issueWithStub();
    const [file] = await handle.db.select().from(files);
    expect(file).toMatchObject({
      id: summary.fileId, mime: "application/pdf", meetingId,
      companyId: null, contactId: null, dealId: null, projectId: null,
      uploaderUserId: actorId,
    });
    // The blob is on disk before the transaction committed, so the file the row
    // names exists the moment anybody can see the row.
    expect(blobCount()).toBe(1);
    expect(readFileSync(blobPath(dataDir, file!.sha256), "utf8")).toBe("%PDF-1.7 ok");
  });

  /**
   * The download name, which is what an operator sees in their Downloads folder.
   * THE DATE IS IN IT BECAUSE THIS TYPE CAN BE PRODUCED AGAIN -- two files called
   * `Meeting summary - Kickoff.pdf` say nothing about which is which.
   */
  it("names the download after the meeting and the day it was issued", async () => {
    const summary = await issueWithStub();
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    expect(file?.originalName).toBe(
      `Meeting summary - Kickoff with Acme - ${summary.issueDate}.pdf`,
    );
  });

  it("truncates an absurd title out of the filename rather than storing it whole", async () => {
    // meetings.title has no upper bound in the schema or in meetingCreateInputSchema,
    // so without a cap a pasted paragraph becomes a filename no filesystem accepts.
    const long = await createMeeting(handle.db, actorId, {
      title: "T".repeat(400), occurredAt: "2026-09-01T13:30:00.000Z", companyId, attendees: [],
    });
    const summary = await issueWithStub(OK_RENDER, long.id);
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    expect(file?.originalName).toBe(`Meeting summary - ${"T".repeat(80)} - ${summary.issueDate}.pdf`);
  });

  /**
   * NO SECOND INSERT, and its absence is the data model working. There is no
   * detail table for this type because there is nothing left to store -- and the
   * composite key added in 0017 is what makes the other direction unspellable.
   */
  it("writes no document_quotes row, and none can be added afterwards", async () => {
    const summary = await issueWithStub();
    expect(await handle.db.select().from(documentQuotes)).toEqual([]);

    await expect(handle.db.insert(documentQuotes).values({
      documentId: summary.id, currency: "EUR", recipientName: "Acme",
      subtotalCents: 1, taxCents: 0, totalCents: 1,
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  /**
   * NOT FROZEN MEANS PRODUCING ANOTHER IS ORDINARY -- and Task 2 appends rather
   * than edits, deliberately: nothing reads `frozen` yet (Task 1's note), so an
   * edit-in-place path here would be the one place in the codebase that mutated
   * an issued document with no guard anywhere.
   */
  it("appends a second summary rather than replacing the first", async () => {
    const first = await issueWithStub();
    const second = await issueWithStub();

    expect(second.id).not.toBe(first.id);
    expect(await handle.db.select().from(documents)).toHaveLength(2);
    expect(await handle.db.select().from(files)).toHaveLength(2);
    // The first one's PDF is untouched: its `files` row still names the same
    // content-addressed blob, which is the whole of "nothing re-rendered it".
    const [firstFile] = await handle.db.select().from(files).where(eq(files.id, first.fileId));
    expect(firstFile?.id).toBe(first.fileId);
  });

  /**
   * The `file_attached` entry lands on the timelines the MEETING is on -- which
   * needs the meeting's own four links, because a meeting-attached file has none
   * of its own and an event with no links at all appears nowhere.
   *
   * AND IT CARRIES NO meeting_id, which is the deliberate half. timeline.ts's
   * attendance widening reaches rows whose meeting_id is set and whose task_id is
   * NULL, and its comment restricts that to "the meeting's OWN lifecycle rows";
   * a rendered summary is something the meeting spawned.
   */
  it("stamps the file_attached event on the meeting's records and not on the meeting", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Jane", lastName: "Smith" });
    const linked = await createMeeting(handle.db, actorId, {
      title: "Review", occurredAt: "2026-09-02T09:00:00.000Z",
      companyId, contactId: contact.id, attendees: [],
    });
    await issueWithStub(OK_RENDER, linked.id);

    const [event] = await handle.db.select().from(events)
      .where(and(eq(events.verb, "file_attached")));
    expect(event).toMatchObject({
      companyId, contactId: contact.id, dealId: null, projectId: null, meetingId: null,
    });
  });
});

describe("issueMeetingSummary refuses before anything spawns", () => {
  it("answers NotFoundError for a meeting that does not exist", async () => {
    await expect(issueWithStub(OK_RENDER, "00000000-0000-4000-8000-000000000000"))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(blobCount()).toBe(0);
    expect(await handle.db.select().from(documents)).toEqual([]);
  });

  /**
   * issueQuote's refusal of an archived deal, on the record this document is of.
   * A meeting that HAPPENED can be logged against an archived company -- that is
   * about the past -- but producing a NEW document against a record somebody has
   * archived is the present.
   */
  it("answers ArchivedError for an archived meeting", async () => {
    await handle.db.update(meetings).set({ archivedAt: new Date() })
      .where(eq(meetings.id, meetingId));
    await expect(issueWithStub()).rejects.toBeInstanceOf(ArchivedError);
    expect(blobCount()).toBe(0);
  });

  it("answers DocumentTemplateMissingError when the seeded template was deleted", async () => {
    await handle.db.delete(documentTemplates);
    const thrown = await issueWithStub().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(DocumentTemplateMissingError);
    expect((thrown as Error).message).toContain("meeting_summary");
    expect(blobCount()).toBe(0);
  });
});

describe("the summary's content is the meeting, and the notes are markup", () => {
  /**
   * **THE ONE RAW-HTML VALUE IN THE SYSTEM.** `meetings.notes` is TipTap rich
   * text, so escaping it would print `<p>` as characters on the page. This is the
   * assertion that the markup survived the merge -- and the one below is the
   * assertion that survival is bounded.
   */
  it("emits the meeting's notes as markup rather than as escaped text", async () => {
    const html = await mergedHtml();
    expect(html).toContain("<li>Jane to draft the plan</li>");
    expect(html).not.toContain("&lt;li&gt;");
  });

  /**
   * SANITISED WITH THE DOCUMENT PROFILE ON THE WAY IN, which matters because the
   * stored value went through the MAIL profile on write and the two differ in
   * both directions. Written straight into the column here, bypassing
   * services/meetings.ts, precisely so the document profile is the only thing
   * that can have removed it.
   */
  it("sanitises the stored notes with the document profile before emitting them", async () => {
    await handle.db.update(meetings).set({
      notes: '<p>ok</p><script>alert(1)</script><img src="file:///etc/passwd" alt="x">',
    }).where(eq(meetings.id, meetingId));

    const html = await mergedHtml();
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toContain("script");
    expect(html).not.toContain("etc/passwd");
  });

  it("escapes the title, which is plain text in a text input", async () => {
    await handle.db.update(meetings).set({ title: "Q3 <b>review</b> & plan" })
      .where(eq(meetings.id, meetingId));
    const html = await mergedHtml();
    expect(html).toContain("Q3 &lt;b&gt;review&lt;/b&gt; &amp; plan");
  });

  /**
   * THE THREE KINDS OF ATTENDEE, RESOLVED TO ONE DISPLAY NAME. A page that
   * printed which KIND each attendee was would be leaking an internal
   * distinction to the people who were in the room.
   *
   * `full_name` BEFORE `username`, which is where this differs from the CSV
   * export: a printed summary wants "Chris Wilson" rather than "chris".
   */
  it("prints a contact, a user and a guest by name", async () => {
    const contact = await createContact(handle.db, actorId, { firstName: "Jane", lastName: "Smith" });
    await handle.db.update(users).set({ fullName: "Chris Wilson" }).where(eq(users.id, actorId));
    const withPeople = await createMeeting(handle.db, actorId, {
      title: "Review", occurredAt: "2026-09-02T09:00:00.000Z", companyId,
      attendees: [
        { contactId: contact.id },
        { userId: actorId },
        { guestName: "Their lawyer" },
      ],
    });

    const dir = writePythonStub(stubDir, ECHOING_RENDER);
    const summary = await withPythonStub(dir, async () =>
      await issueMeetingSummary(handle.db, { dataDir }, actorId, withPeople.id));
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    const html = await readFile(blobPath(dataDir, file!.sha256), "utf8");

    expect(html).toContain("<li>Jane Smith</li>");
    expect(html).toContain("<li>Chris Wilson</li>");
    expect(html).toContain("<li>Their lawyer</li>");
    // ...and the username is NOT what was printed, or the fullName preference is
    // untested and this passes for the wrong reason.
    expect(html).not.toContain("<li>chris</li>");
  });

  it("falls back to the username when a user has no full name", async () => {
    const withUser = await createMeeting(handle.db, actorId, {
      title: "Review", occurredAt: "2026-09-02T09:00:00.000Z", companyId,
      attendees: [{ userId: actorId }],
    });
    const dir = writePythonStub(stubDir, ECHOING_RENDER);
    const summary = await withPythonStub(dir, async () =>
      await issueMeetingSummary(handle.db, { dataDir }, actorId, withUser.id));
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    expect(await readFile(blobPath(dataDir, file!.sha256), "utf8")).toContain("<li>chris</li>");
  });

  /**
   * ORDERED BY id, and by nothing else, for services/meetings.ts's reason:
   * meeting_attendees carries no created_at and no ordinal, and the set is
   * rewritten wholesale on every update, so id is the only order a read can
   * reproduce. This page gets sent to the people who were in the room.
   */
  it("prints attendees in a stable order a second read reproduces", async () => {
    const withPeople = await createMeeting(handle.db, actorId, {
      title: "Review", occurredAt: "2026-09-02T09:00:00.000Z", companyId,
      attendees: [{ guestName: "Zoe" }, { guestName: "Adam" }, { guestName: "Mia" }],
    });
    const rows = await handle.db.select().from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, withPeople.id));
    const byId = [...rows].sort((a, b) => a.id.localeCompare(b.id)).map((row) => row.guestName);

    const dir = writePythonStub(stubDir, ECHOING_RENDER);
    const summary = await withPythonStub(dir, async () =>
      await issueMeetingSummary(handle.db, { dataDir }, actorId, withPeople.id));
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    const html = await readFile(blobPath(dataDir, file!.sha256), "utf8");
    const printed = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(printed).toEqual(byId);
  });

  /**
   * BOTH EMPTY CASES, because a meeting with nobody recorded and a meeting with
   * no notes are both completely ordinary. 0009's logo lesson generalises: a
   * heading standing over a blank is what you get without the inverted block.
   */
  it("says so when there are no attendees and no notes", async () => {
    const bare = await createMeeting(handle.db, actorId, {
      title: "Quick call", occurredAt: "2026-09-02T09:00:00.000Z", companyId, attendees: [],
    });
    const dir = writePythonStub(stubDir, ECHOING_RENDER);
    const summary = await withPythonStub(dir, async () =>
      await issueMeetingSummary(handle.db, { dataDir }, actorId, bare.id));
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    const html = await readFile(blobPath(dataDir, file!.sha256), "utf8");

    expect(html).toContain("No attendees were recorded.");
    expect(html).toContain("No notes were recorded.");
    expect(html).not.toContain("{{");
  });

  it("omits the duration row when the meeting has none, and prints it when it has", async () => {
    expect(await mergedHtml()).toContain("45 minutes");

    await handle.db.update(meetings).set({ durationMinutes: null })
      .where(eq(meetings.id, meetingId));
    expect(await mergedHtml()).not.toContain("Duration");

    await handle.db.update(meetings).set({ durationMinutes: 1 })
      .where(eq(meetings.id, meetingId));
    expect(await mergedHtml()).toContain("1 minute");
  });

  /**
   * THE ZONE IS PRINTED BECAUSE CONDUIT DOES NOT KNOW THE RIGHT ONE -- see
   * formatDocumentInstant. A reader can convert an instant that names its zone
   * and cannot even detect one that does not, and this is a page that gets sent.
   */
  it("prints the meeting's moment in a zone it names", async () => {
    const html = await mergedHtml();
    expect(html).toContain("1 September 2026 at 13:30 UTC");
  });

  it("leaves no merge token unresolved on a fully populated meeting", async () => {
    await saveOrgProfile(handle.db, {
      name: "Listerdale", addressLines: "1 High St\n1234 AB Amsterdam",
      email: "hello@listerdale.nl", phone: "+31 20 000 0000", website: "listerdale.nl",
      bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
    });
    const html = await mergedHtml();
    expect(html).not.toContain("{{");
    expect(html).toContain("Listerdale");
    expect(html).toContain("hello@listerdale.nl");
  });
});

describe("buildMeetingSummaryContext supplies what the seeded template names", () => {
  /**
   * documents.test.ts's key-set contract, for the second type. An unknown path
   * renders as "" and never throws, so a context that supplied `document.Title`
   * for `{{document.title}}` would leave every test green and print a blank where
   * a heading should be. CONTAINMENT in this direction: every path the template
   * names must be supplied; an extra context key is harmless.
   */
  it("supplies every merge path the seeded summary template actually names", () => {
    const paths = seededSummaryTemplatePaths();
    // Guard against a vacuous pass: if the reader stopped finding tokens, the
    // containment checks below would succeed against empty lists.
    expect(paths.root.length).toBeGreaterThan(10);
    expect(paths.root).toContain("document.notes");
    expect(paths.root).toContain("attendees");
    expect(paths.attendee).toEqual(["name"]);
    // ...and the split is real: an attendee's field is NOT a root path.
    expect(paths.root).not.toContain("name");

    const context = buildMeetingSummaryContext({
      org: {
        name: "Listerdale", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      issueDate: "2026-09-06",
      title: "Kickoff", occurredAt: "2026-09-01T13:30:00.000Z", durationMinutes: 45,
      notesHtml: "<p>hi</p>", attendees: ["Jane Smith"],
    });
    const rootKeys = new Set<string>([
      ...Object.keys(context.org).map((key) => `org.${key}`),
      ...Object.keys(context.document).map((key) => `document.${key}`),
      "attendees",
    ]);
    const attendeeKeys = new Set(Object.keys(context.attendees?.[0] ?? {}));

    expect(paths.root.filter((path) => !rootKeys.has(path))).toEqual([]);
    expect(paths.attendee.filter((path) => !attendeeKeys.has(path))).toEqual([]);
  });

  it("has no number key at all, so a template that named one would print a blank", () => {
    const context = buildMeetingSummaryContext({
      org: {
        name: "", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      issueDate: "2026-09-06", title: "Kickoff", occurredAt: "2026-09-01T13:30:00.000Z",
      durationMinutes: null, notesHtml: "", attendees: [],
    });
    expect("number" in context.document).toBe(false);
    expect(context.lines).toEqual([]);
    expect(prepareDocumentHtml("[{{document.number}}]", context)).toBe("[]");
  });
});

describe("listMeetingSummaries", () => {
  it("returns a meeting's summaries newest first, and nobody else's", async () => {
    const other = await createMeeting(handle.db, actorId, {
      title: "Other", occurredAt: "2026-09-03T09:00:00.000Z", companyId, attendees: [],
    });
    const first = await issueWithStub();
    const second = await issueWithStub();
    await issueWithStub(OK_RENDER, other.id);

    const listed = await listMeetingSummaries(handle.db, meetingId);
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(listed[0]).toEqual(second);
    expect(await listMeetingSummaries(handle.db, other.id)).toHaveLength(1);
  });

  it("returns nothing for a meeting nobody has summarised", async () => {
    expect(await listMeetingSummaries(handle.db, meetingId)).toEqual([]);
  });

  /**
   * FILTERED BY TYPE AS WELL AS BY MEETING, though only a summary attaches to a
   * meeting through any service today. The other row is written directly, which
   * is exactly the psql-session case the filter is for -- and is also what a
   * future meeting-attached type will look like from this function's side.
   *
   * NOTE WHAT THE SCHEMA STILL DEMANDS OF IT: a quote is numbered and frozen, so
   * the row below carries both. `documents_exactly_one_entity` is indifferent to
   * the type, which is precisely why this state is reachable at all and why the
   * predicate here is not decoration.
   */
  it("ignores a document on the meeting that is not a summary", async () => {
    const summary = await issueWithStub();
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    await handle.db.insert(documents).values({
      number: "QUO-2026-9999", type: "quote", meetingId, fileId: file!.id,
      issueDate: "2026-09-06", frozen: true, issuedByUserId: actorId,
    });
    expect(await handle.db.select().from(documents)).toHaveLength(2);

    const listed = await listMeetingSummaries(handle.db, meetingId);
    expect(listed.map((row) => row.id)).toEqual([summary.id]);
  });
});

describe("the size gate names the meeting summary, not a quote", () => {
  /**
   * THE THREE RENDER CAPS ARE SHARED BETWEEN THE TYPES AND THE MESSAGE IS NOT.
   * `renderAndStore` takes the noun and the provenance from its caller, and a
   * refusal that said "this quote merges to..." while summarising a meeting would
   * send an operator looking for a quote form that does not exist.
   *
   * THE PROVENANCE NAMES THE NOTES, which is the one part of THIS document an
   * operator can actually shorten -- there is no submission to trim.
   */
  it("refuses an oversized summary with a message about a summary and its notes", async () => {
    // Over RENDER_MARKUP_CAP_BYTES on the template alone, which is the cheapest
    // way to reach the first of the three caps without a 128KB meeting note.
    await seedSummaryTemplate(`<div>${"x".repeat(RENDER_MARKUP_CAP_BYTES + 1000)}</div>`);
    const thrown = await issueWithStub().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DocumentTooLargeError);
    const message = (thrown as Error).message;
    expect(message).toContain("this meeting summary merges to");
    expect(message).toContain("the meeting's notes");
    expect(message).not.toContain("quote");
    // Nothing spawned and nothing was stored: the gate runs before the render.
    expect(blobCount()).toBe(0);
    expect(await handle.db.select().from(documents)).toEqual([]);
  });
});

describe("the real renderer", () => {
  itReal("renders the seeded summary template into a one-page PDF", async () => {
    await saveOrgProfile(handle.db, {
      name: "Listerdale", addressLines: "1 High St\n1234 AB Amsterdam",
      email: "hello@listerdale.nl", phone: "", website: "", bankDetails: "",
      vatNumber: "", registrationNumber: "", logoDataUri: "",
    });
    const withPeople = await createMeeting(handle.db, actorId, {
      title: "Kickoff with Acme", occurredAt: "2026-09-01T13:30:00.000Z",
      durationMinutes: 45, notes: NOTES_HTML, companyId,
      attendees: [{ guestName: "Their lawyer" }],
    });

    const summary = await issueMeetingSummary(handle.db, { dataDir }, actorId, withPeople.id);
    const [file] = await handle.db.select().from(files).where(eq(files.id, summary.fileId));
    const pdf = await readFile(blobPath(dataDir, file!.sha256));

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
    // pdfVisibleText, NOT pdfText: WeasyPrint embeds a font subset and writes text
    // as glyph ids, so a word on the page is not in the file as that word -- see
    // test/pdf.ts, where the negative assertion below is the exact shape that
    // passes vacuously against the raw reader.
    const text = pdfVisibleText(pdf);
    expect(text).toContain("Kickoff with Acme");
    expect(text).toContain("Their lawyer");
    expect(text).toContain("45 minutes");
    // The rich text survived as rich text: the list item is on the page, and the
    // markup that would mean it had been escaped is not.
    expect(text).toContain("Jane to draft the plan");
    expect(text).not.toContain("<li>");
    // The running footer, which is the page count as the DOCUMENT states it --
    // an independent witness to pageCount above, and the assertion that found
    // that helper counting a bookmark tree instead of a page tree.
    expect(text).toContain("Page 1 of 1");
  }, 30_000);
});
