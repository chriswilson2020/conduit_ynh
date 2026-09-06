import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  AGREEMENT_MAX_TERM_MONTHS, documentTypeFreezes, documentTypeNumbered,
  LETTER_FIELD_CAPS, RENDER_MARKUP_CAP_BYTES,
  type IssueAgreementInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import {
  seededAgreementTemplate, seededLetterTemplate, templateMergePaths,
} from "../test/seed-template.js";
import { pageCount, pdfVisibleText } from "../test/pdf.js";
import { resolveUser } from "../users.js";
import {
  contacts as contactsTable,
  documentAgreements, documentLetters, documentNumberSequences, documentQuotes, documents,
  documentTemplates, events, files,
} from "../db/schema.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";
import { createMeeting } from "./meetings.js";
import { archiveCompany } from "./companies.js";
import { blobPath } from "./blobs.js";
import { saveOrgProfile } from "./org-profile.js";
import { weasyprintAvailable } from "./documents-render.js";
import {
  buildAgreementContext, buildLetterContext, DocumentFrozenError, DocumentInputError,
  DocumentTemplateMissingError, DocumentTooLargeError,
  issueAgreement, issueLetter, issueMeetingSummary, issueQuote, listRecordDocuments, redraftLetter,
  type RecordTarget,
} from "./documents.js";
import { ArchivedError, NotFoundError } from "./errors.js";

/**
 * PHASE 9 TASK 3: THE LETTER, THE NDA PAIR, AND THE GUARD THAT READS `frozen`.
 *
 * Three types arrive together because they share a shape the first two did not
 * have -- a document on a COMPANY or a CONTACT, with a form -- but the reason
 * this file exists is the fourth thing that arrived with them.
 *
 * **UNTIL NOW "AN ISSUED DOCUMENT NEVER CHANGES" HAS BEEN UNCONDITIONAL.** Phase
 * 7 built no update path at all. Task 1 added `documents.frozen` and recorded
 * that nothing read it. Task 2 added the first type that answers `false` and
 * still declined to write an update path, because it would have been "the one
 * place in the codebase that mutated an issued document with no guard anywhere".
 * `redraftLetter` is that path, and the spec names the risk exactly: "making it
 * conditional is where a mistake would let a quote be edited". A quote is the
 * one document in this product that carries a price somebody was sent.
 *
 * So the tests that matter most here are the ones that try to edit a quote --
 * through the redraft route, and through the database directly, with the
 * service's own guard removed from the picture entirely.
 *
 * THE STUB RENDERER IS documents.test.ts's, for its reason: the failure paths are
 * exactly the ones a binary-gated suite would skip on a developer machine. The
 * gated cases at the end are the ones that need a real PDF.
 */
const handle = openTestDatabase();
const stubDir = mkdtempSync(join(tmpdir(), "conduit-letter-"));
const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

let dataDir: string;
let actorId: string;
let companyId: string;
let contactId: string;

const BODY_HTML = "<p>Thank you for your time on Tuesday.</p><ul><li>We will send the plan</li></ul>";

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = mkdtempSync(join(stubDir, "data-"));
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  const company = await createCompany(handle.db, actorId, { name: "Acme Manufacturing BV" });
  companyId = company.id;
  const contact = await createContact(handle.db, actorId, {
    firstName: "Jane", lastName: "Smith", companyId,
  });
  contactId = contact.id;
  // truncateAll() empties every table in the public schema, so migration 0019's
  // seeded rows are gone before any test body runs -- exactly as 0009's and
  // 0017's are for the quote and summary suites. A test that did not notice
  // would be merging against nothing.
  await seedTemplates();
});

afterAll(async () => {
  await handle.close();
  rmSync(stubDir, { recursive: true, force: true });
});

async function seedTemplates(
  letterBody = seededLetterTemplate(),
): Promise<void> {
  await handle.db.delete(documentTemplates);
  await handle.db.insert(documentTemplates).values([
    { type: "letter", bodyHtml: letterBody },
    { type: "nda", bodyHtml: seededAgreementTemplate("nda") },
    { type: "mutual_nda", bodyHtml: seededAgreementTemplate("mutual_nda") },
  ]);
}

/** A renderer that echoes the HTML it was given back inside the "PDF". */
const ECHOING_RENDER = "printf '%s' '%PDF-1.7 '\ncat";
/** A renderer that succeeds with fixed bytes and nothing else. */
const OK_RENDER = "printf '%s' '%PDF-1.7 ok'";

const LETTER_INPUT = {
  type: "letter" as const,
  issueDate: "2026-09-06",
  subject: "Renewal of your maintenance contract",
  recipientName: "Acme Manufacturing BV",
  recipientContactName: "Jane Smith",
  recipientSalutation: "Ms Smith",
  recipientAddress: "1 Industrieweg\n1000 AA Amsterdam",
  bodyHtml: BODY_HTML,
};

const AGREEMENT_INPUT: IssueAgreementInput = {
  type: "nda",
  issueDate: "2026-09-06",
  effectiveDate: "2026-09-01",
  termMonths: 36,
  jurisdiction: "the Netherlands",
  partyName: "Acme Manufacturing BV",
  partyContactName: "Jane Smith",
  partyAddress: "1 Industrieweg\n1000 AA Amsterdam",
};

async function withStub<T>(body: string, fn: () => Promise<T>): Promise<T> {
  return await withPythonStub(writePythonStub(stubDir, body), fn);
}

async function writeLetter(
  target: RecordTarget = { companyId },
  input: Partial<typeof LETTER_INPUT> = {},
  render = OK_RENDER,
) {
  return await withStub(render, async () =>
    await issueLetter(handle.db, { dataDir }, actorId, target, { ...LETTER_INPUT, ...input }));
}

async function raiseAgreement(
  target: RecordTarget = { companyId },
  input: Partial<typeof AGREEMENT_INPUT> = {},
  render = OK_RENDER,
) {
  return await withStub(render, async () =>
    await issueAgreement(handle.db, { dataDir }, actorId, target, { ...AGREEMENT_INPUT, ...input }));
}

/** The merged HTML the renderer was handed, recovered from the echoing stub. */
async function mergedFor(fileId: string): Promise<string> {
  const [file] = await handle.db.select().from(files).where(eq(files.id, fileId));
  return (await readFile(blobPath(dataDir, file!.sha256), "utf8")).replace(/^%PDF-1\.7 /, "");
}

const BLANK_PROFILE = {
  name: "", addressLines: "", vatNumber: "", registrationNumber: "",
  email: "", phone: "", website: "", bankDetails: "", logoDataUri: "",
  timeZone: "UTC",
};

/** A frozen quote on a deal, for the guard tests. Uses the REAL issueQuote, so
 * what is being protected is a quote the product itself produced. */
async function issueRealQuote() {
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
  const deal = await createDeal(
    handle.db, actorId,
    { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR",
  );
  await handle.db.insert(documentTemplates)
    .values({ type: "quote", bodyHtml: "<p>{{document.number}} {{document.total}}</p>" });
  const quote = await withStub(OK_RENDER, async () => await issueQuote(
    handle.db, { dataDir }, actorId, deal.id,
    {
      issueDate: "2026-09-01", recipientName: "Acme",
      lines: [{ description: "Widget", qtyMilli: 1000, unitPriceCents: 10_000, taxRateBp: 2100 }],
    },
  ));
  return { quote, dealId: deal.id };
}

/* ========================================================================== *
 *  THE LETTER
 * ========================================================================== */

describe("issueLetter writes one document, one detail row and one file", () => {
  it("attaches the letter to its company, with no number and no freeze", async () => {
    const letter = await writeLetter();
    expect(letter).toMatchObject({
      type: "letter", companyId, contactId: null, frozen: false,
      subject: "Renewal of your maintenance contract",
      recipientName: "Acme Manufacturing BV", recipientContactName: "Jane Smith",
      recipientSalutation: "Ms Smith", issueDate: "2026-09-06",
      issuedByUserId: actorId,
    });
    // The DTO has no `number` FIELD at all, which is the design and not an unset
    // value -- documentTypeNumbered's three reasons.
    expect("number" in letter).toBe(false);

    const [row] = await handle.db.select().from(documents);
    expect(row).toMatchObject({
      number: null, type: "letter", companyId,
      contactId: null, dealId: null, projectId: null, meetingId: null,
      frozen: false,
    });
  });

  it("attaches a letter to a contact instead, and to nothing else", async () => {
    const letter = await writeLetter({ contactId });
    expect(letter).toMatchObject({ companyId: null, contactId });
    const [row] = await handle.db.select().from(documents);
    expect(row).toMatchObject({ companyId: null, contactId, dealId: null });
  });

  it("spends no document number, so no sequence row is created at all", async () => {
    await writeLetter();
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
    // Belt and braces on the rule rather than only its effect: the shared
    // function is what a writer asks, and the CHECK is what stops one that did
    // not ask.
    expect(documentTypeNumbered("letter")).toBe(false);
  });

  it("stores every field it was given, each one distinct", async () => {
    // EVERY OPTIONAL GETS A DISTINCT VALUE, which is Task 1's survivor lesson
    // repeated: identical placeholders would still pass if the writer put the
    // subject in the salutation column, and an eleven-column move is exactly the
    // change that invites that mistake. Five columns here, same discipline.
    const letter = await writeLetter({ companyId }, {
      subject: "SUBJECT", recipientName: "NAME", recipientContactName: "CONTACT",
      recipientSalutation: "SALUTATION", recipientAddress: "ADDRESS",
      bodyHtml: "<p>BODY</p>",
    });
    const [row] = await handle.db.select().from(documentLetters);
    expect(row).toMatchObject({
      documentId: letter.id, type: "letter",
      subject: "SUBJECT", recipientName: "NAME", recipientContactName: "CONTACT",
      recipientSalutation: "SALUTATION", recipientAddress: "ADDRESS", bodyHtml: "<p>BODY</p>",
    });
  });

  it("stores an omitted optional as the empty string rather than a placeholder", async () => {
    const letter = await writeLetter({ companyId }, {
      subject: undefined, recipientContactName: undefined,
      recipientSalutation: undefined, recipientAddress: undefined,
    });
    expect(letter).toMatchObject({
      subject: "", recipientContactName: "", recipientSalutation: "", recipientAddress: "",
    });
    const [row] = await handle.db.select().from(documentLetters);
    expect(row).toMatchObject({
      subject: "", recipientContactName: "", recipientSalutation: "", recipientAddress: "",
    });
  });

  it("stores the PDF as a files row on the same record, and stamps the timeline", async () => {
    const letter = await writeLetter();
    const [file] = await handle.db.select().from(files);
    expect(file).toMatchObject({
      id: letter.fileId, mime: "application/pdf", companyId,
      contactId: null, dealId: null, meetingId: null,
    });
    const [event] = await handle.db.select().from(events)
      .where(eq(events.verb, "file_attached"));
    expect(event).toMatchObject({ companyId, actorUserId: actorId });
  });

  it("names the download after the subject and the day it was issued", async () => {
    const letter = await writeLetter();
    const [file] = await handle.db.select().from(files).where(eq(files.id, letter.fileId));
    expect(file?.originalName)
      .toBe("Letter - Renewal of your maintenance contract - 2026-09-06.pdf");
  });

  it("falls back to the recipient when there is no subject, and truncates an absurd one", async () => {
    const noSubject = await writeLetter({ companyId }, { subject: "" });
    const [first] = await handle.db.select().from(files).where(eq(files.id, noSubject.fileId));
    expect(first?.originalName).toBe("Letter - Acme Manufacturing BV - 2026-09-06.pdf");

    // THE LONGEST SUBJECT THE SCHEMA ADMITS, not an arbitrary one: `LETTER_FIELD_CAPS.subject`
    // is 200, so a 500-character subject is a 400 from the input gate and never
    // reaches the filename at all -- which is what a first draft of this test
    // asserted, and it went red. The truncation is reachable between 81 and 200,
    // and it exists so `files.original_name` stays well inside the export's
    // 180-BYTE member limit even when every character costs three bytes.
    const long = await writeLetter(
      { companyId }, { subject: "S".repeat(LETTER_FIELD_CAPS.subject) },
    );
    const [second] = await handle.db.select().from(files).where(eq(files.id, long.fileId));
    expect(second?.originalName).toBe(`Letter - ${"S".repeat(80)} - 2026-09-06.pdf`);
    expect(Buffer.byteLength(second?.originalName ?? "", "utf8")).toBeLessThan(180);
  });

  it("writes no document_quotes row, and none can be added afterwards", async () => {
    const letter = await writeLetter();
    expect(await handle.db.select().from(documentQuotes)).toEqual([]);
    await expect(handle.db.execute(sql`
      INSERT INTO document_quotes (document_id, currency, recipient_name,
                                   subtotal_cents, tax_cents, total_cents)
      VALUES (${letter.id}, 'EUR', 'Acme', 100, 21, 121)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});

describe("issueLetter refuses before anything spawns", () => {
  it("answers NotFoundError for a company that does not exist", async () => {
    await expect(writeLetter({ companyId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(await handle.db.select().from(files)).toEqual([]);
  });

  it("answers NotFoundError for a contact that does not exist", async () => {
    await expect(writeLetter({ contactId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * **REFUSED BEFORE ANYTHING SPAWNS, AND THE RENDERER IS THE ASSERTION.**
   *
   * A FIRST DRAFT OF THIS TEST WAS GREEN WITH THE CHECK REMOVED, and mutation
   * testing is what found it: `attachFile` refuses an archived record too, with
   * the SAME ArchivedError -- but it runs AFTER the merge, the cap checks, the
   * render and the blob write. So a test that only asserted the error type and an
   * empty `documents` table could not tell "refused in 2ms" from "refused after a
   * 700ms subprocess and an orphan blob on disk", which is the entire reason
   * `assertRecordIssuable` exists beside `assertFileTargetActive` rather than
   * being left to it.
   *
   * A RENDERER THAT FAILS IF IT IS CALLED AT ALL is what closes that: the refusal
   * has to arrive without the stub ever running, or the error would be a
   * RenderError instead. Same instrument as the frozen refusal further down.
   */
  it("answers ArchivedError for an archived company, without spawning a render", async () => {
    await archiveCompany(handle.db, actorId, companyId);
    await expect(writeLetter({ companyId }, {}, "exit 9"))
      .rejects.toBeInstanceOf(ArchivedError);
    expect(await handle.db.select().from(documents)).toEqual([]);
    expect(await handle.db.select().from(files)).toEqual([]);
  });

  it("answers ArchivedError for an archived contact too, and for an agreement", async () => {
    // THE CONTACT BRANCH IS ITS OWN QUERY and would be its own omission; and the
    // agreement path calls the same helper AFTER taking a number, so its refusal
    // has to arrive before that too -- asserted by the sequence table staying
    // empty, which is the only visible trace a spent number would leave.
    await handle.db.update(contactsTable)
      .set({ archivedAt: new Date() }).where(eq(contactsTable.id, contactId));
    await expect(writeLetter({ contactId }, {}, "exit 9"))
      .rejects.toBeInstanceOf(ArchivedError);

    await archiveCompany(handle.db, actorId, companyId);
    await expect(raiseAgreement({ companyId }, {}, "exit 9"))
      .rejects.toBeInstanceOf(ArchivedError);
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
  });

  it("answers DocumentTemplateMissingError when the seeded template was deleted", async () => {
    await handle.db.delete(documentTemplates).where(eq(documentTemplates.type, "letter"));
    await expect(writeLetter()).rejects.toBeInstanceOf(DocumentTemplateMissingError);
  });

  it("refuses a body that is not empty but sanitises away to nothing", async () => {
    // TWO FAILURES, TWO SENTENCES. `bodyHtml.min(1)` refuses an empty
    // submission; this refuses one that had content the document profile does not
    // keep. Left ungated it renders a letterhead with a greeting, a sign-off and
    // nothing in between -- a document somebody posts.
    await expect(writeLetter({ companyId }, { bodyHtml: "<script>alert(1)</script>" }))
      .rejects.toThrow(/empty once sanitised/);
    await expect(writeLetter({ companyId }, { bodyHtml: "" }))
      .rejects.toBeInstanceOf(DocumentInputError);
    expect(await handle.db.select().from(documents)).toEqual([]);
  });
});

describe("the letter's content is the body, and the body is markup", () => {
  beforeEach(async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
  });

  it("emits the typed body as markup rather than as escaped text", async () => {
    const letter = await writeLetter({ companyId }, {}, ECHOING_RENDER);
    const html = await mergedFor(letter.fileId);
    expect(html).toContain("<li>We will send the plan</li>");
    expect(html).not.toContain("&lt;li&gt;");
  });

  it("escapes the subject and the addressee, which are plain text in plain inputs", async () => {
    const letter = await writeLetter(
      { companyId }, { subject: "<b>Urgent</b>", recipientName: "<i>Acme</i>" }, ECHOING_RENDER,
    );
    const html = await mergedFor(letter.fileId);
    expect(html).toContain("&lt;b&gt;Urgent&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;Acme&lt;/i&gt;");
    expect(html).not.toContain("<b>Urgent</b>");
  });

  it("sanitises the body with the document profile before emitting it", async () => {
    const letter = await writeLetter(
      { companyId },
      { bodyHtml: "<p>Real text</p><script>alert(1)</script><p onclick=\"x()\">Second</p>" },
      ECHOING_RENDER,
    );
    const html = await mergedFor(letter.fileId);
    expect(html).toContain("Real text");
    expect(html).toContain("Second");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onclick");
    // AND WHAT WAS STORED IS WHAT WAS PRINTED. The sanitised value goes into the
    // column, so a redraft opens the editor on the markup the page actually
    // carried rather than on what was typed -- and the second render of an
    // unchanged letter produces the same bytes.
    const [row] = await handle.db.select().from(documentLetters);
    expect(row?.bodyHtml).not.toContain("alert(1)");
    expect(row?.bodyHtml).toContain("Real text");
  });

  it("prints the greeting when there is a salutation and the fallback when there is not", async () => {
    const withSalutation = await writeLetter({ companyId }, {}, ECHOING_RENDER);
    expect(await mergedFor(withSalutation.fileId)).toContain("<p>Dear Ms Smith,</p>");

    const without = await writeLetter({ companyId }, { recipientSalutation: "" }, ECHOING_RENDER);
    const html = await mergedFor(without.fileId);
    // BOTH BLOCK FORMS, and the assertion closes round the whole paragraph: a
    // template that lost its inverted block prints "Dear ," and `toContain("Dear")`
    // would be satisfied by it.
    expect(html).toContain("<p>Dear Sir or Madam,</p>");
    expect(html).not.toContain("<p>Dear ,</p>");
  });

  it("omits the subject heading and the address block when there are none", async () => {
    const letter = await writeLetter(
      { companyId }, { subject: "", recipientAddress: "", recipientContactName: "" }, ECHOING_RENDER,
    );
    const html = await mergedFor(letter.fileId);
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain('<div class="pre"></div>');
  });

  it("leaves no merge token unresolved on a fully populated letter", async () => {
    await saveOrgProfile(handle.db, {
      ...BLANK_PROFILE, name: "Conduit BV", addressLines: "2 Kade\n1000 AA Amsterdam",
      email: "hello@conduit.test", phone: "+31 20 000 0000", website: "conduit.test",
    });
    const letter = await writeLetter({ companyId }, {}, ECHOING_RENDER);
    expect(await mergedFor(letter.fileId)).not.toMatch(/\{\{/);
  });
});

describe("buildLetterContext supplies what the seeded template names", () => {
  it("supplies every merge path the seeded letter template actually names", () => {
    const paths = templateMergePaths(seededLetterTemplate(), ["lines"]);
    const context = buildLetterContext({
      org: {
        name: "Conduit BV", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
        timeZone: "UTC", updatedAt: "2026-09-06T00:00:00.000Z",
      },
      issueDate: "2026-09-06", subject: "Renewal",
      recipientName: "Acme", recipientContactName: "Jane Smith",
      recipientSalutation: "Ms Smith", recipientAddress: "1 Industrieweg",
      bodyHtml: "<p>Hello</p>",
    });
    const supplied = new Set([
      ...Object.keys(context.org).map((key) => `org.${key}`),
      ...Object.keys(context.document).map((key) => `document.${key}`),
      "lines",
    ]);
    // AN EQUALITY IN ONE DIRECTION AND A CHECK IN THE OTHER: every path the
    // template names must be supplied (or it prints a blank), and the context may
    // carry more (the letterhead's nine `org` fields are shared with every type
    // and this template prints six of them).
    for (const path of paths.root) expect(supplied).toContain(path);
    expect(paths.root).toContain("document.body");
  });

  it("has no number key at all, so a template that named one would print a blank", () => {
    const context = buildLetterContext({
      org: {
        name: "", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "", timeZone: "UTC",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      issueDate: "2026-09-06", subject: "", recipientName: "Acme",
      recipientContactName: "", recipientSalutation: "", recipientAddress: "",
      bodyHtml: "<p>x</p>",
    });
    expect("number" in context.document).toBe(false);
  });
});

/* ========================================================================== *
 *  THE REDRAFT, AND THE GUARD
 * ========================================================================== */

describe("redraftLetter rewrites the letter it was given", () => {
  it("replaces the body, the subject and the addressee, and re-renders", async () => {
    const letter = await writeLetter();
    const after = await withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, letter.id,
      {
        issueDate: "2026-09-07", subject: "Second thoughts",
        recipientName: "Acme Manufacturing BV", recipientContactName: "John Smith",
        recipientSalutation: "Mr Smith", recipientAddress: "2 Industrieweg",
        bodyHtml: "<p>Redrafted.</p>",
      },
    ));
    expect(after).toMatchObject({
      id: letter.id, issueDate: "2026-09-07", subject: "Second thoughts",
      recipientContactName: "John Smith", recipientSalutation: "Mr Smith",
      recipientAddress: "2 Industrieweg", bodyHtml: "<p>Redrafted.</p>",
      frozen: false, companyId,
    });
    const [row] = await handle.db.select().from(documentLetters);
    expect(row).toMatchObject({ subject: "Second thoughts", bodyHtml: "<p>Redrafted.</p>" });
    // ONE DOCUMENT, NOT TWO. A redraft is an edit; the summary's "produce another"
    // shape is the one this deliberately is not.
    expect(await handle.db.select().from(documents)).toHaveLength(1);
  });

  it("points the document at a NEW file and leaves the superseded one on the record", async () => {
    const letter = await writeLetter();
    const after = await withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, letter.id,
      { ...LETTER_INPUT, subject: "Second thoughts", bodyHtml: "<p>Different.</p>" },
    ));
    expect(after.fileId).not.toBe(letter.fileId);

    // BOTH FILES ARE STILL THERE, and that is the decision rather than a leak:
    // rewriting a `files` row in place would be the first thing in Conduit to
    // mutate one, on the table the download route, the Files tab, the export and
    // the backup all read -- and it would go around attachFile, which is the only
    // record anywhere of WHEN a redraft happened.
    const rows = await handle.db.select().from(files);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.companyId === companyId)).toBe(true);
    const [current] = await handle.db.select().from(documents);
    expect(current?.fileId).toBe(after.fileId);
  });

  it("answers NotFoundError for a document that does not exist", async () => {
    await expect(withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, "00000000-0000-4000-8000-000000000000",
      { ...LETTER_INPUT },
    ))).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * **THIS TEST USED TO MOVE A LETTER ONTO A DEAL BY HAND AND WATCH
   * `redraftLetter` REFUSE IT. MIGRATION 0020 MADE THE MOVE IMPOSSIBLE, SO WHAT
   * IT ASSERTS NOW IS THAT THE DATABASE REFUSES THE UPDATE.**
   *
   * What it said before: "`documents_exactly_one_entity` says exactly one of
   * five; it does not say WHICH one for a given type. So a psql session can put a
   * letter on a deal... THE FIX IS A CHECK AND IT IS NOT IN 0019, deliberately --
   * it is a rule about all five types and two of them are Task 4's."
   *
   * Task 4 wrote that CHECK. `documents_entity_matches_type` refuses this UPDATE
   * from a psql session exactly as it refuses it from a service, which is the
   * whole reason it is a constraint and not a branch.
   *
   * **SO `redraftLetter`'S "attached to neither" BRANCH IS NOW UNREACHABLE, AND
   * THAT IS SAID HERE RATHER THAN LEFT AS A SILENT SURVIVOR.** It was a surviving
   * mutant before this test existed (`existing.contactId as string` was green
   * across two suites) and it is one again -- deleting the branch is green,
   * because no writer and no console can build the row any more. It stays: a
   * guard at a dereference costs a line, the thing that makes it unreachable is
   * a constraint that a later migration could widen, and "unreachable today
   * because something else holds" is exactly the kind of claim this codebase has
   * twice found to be wrong. The assertion moved to the layer that now does the
   * refusing.
   */
  it("refuses a letter being moved onto a deal, which is what made redraftLetter's neither-branch reachable", async () => {
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR",
    );
    const letter = await writeLetter();
    // Straight past every writer, exactly as an import or a console would -- and
    // that is now precisely what fails.
    await expect(handle.db.execute(sql`
      UPDATE documents SET company_id = NULL, deal_id = ${deal.id} WHERE id = ${letter.id}
    `)).rejects.toMatchObject({
      cause: {
        code: "23514", message: expect.stringContaining("documents_entity_matches_type"),
      },
    });

    // The row is untouched, so the letter is still redraftable -- the difference
    // between a refusal and an error raised after the damage.
    const redrafted = await withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, letter.id, { ...LETTER_INPUT },
    ));
    expect(redrafted).toMatchObject({ id: letter.id, companyId, contactId: null });
  });

  it("refuses a meeting summary as NOT A LETTER rather than as frozen", async () => {
    // A DIFFERENT REFUSAL FROM THE FROZEN ONE, and it is not redundant with it. A
    // summary is not frozen either, and it has no `document_letters` row to
    // rewrite -- so without this branch, redrafting one would fail on a missing
    // detail row with a 500 instead of saying what is wrong. "Which types have a
    // redraft path" is not "which types are frozen", and conflating them hands
    // the next unfrozen type a broken path for free.
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: "2026-09-01T13:30:00.000Z", companyId, attendees: [],
    });
    await handle.db.insert(documentTemplates)
      .values({ type: "meeting_summary", bodyHtml: "<p>{{document.title}}</p>" });
    const summary = await withStub(OK_RENDER, async () =>
      await issueMeetingSummary(handle.db, { dataDir }, actorId, meeting.id));
    expect(summary.frozen).toBe(false);

    await expect(withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, summary.id, { ...LETTER_INPUT },
    ))).rejects.toThrow(/is a meeting_summary, not a letter/);
  });
});

/**
 * **THE GUARD. THIS IS THE SHARP EDGE OF THE TASK.**
 *
 * The spec's fourth risk: per-type freezing is a new axis in a guard that
 * previously had none, and "making it conditional is where a mistake would let a
 * quote be edited". Every test below is a way somebody could try.
 */
describe("a frozen document cannot be changed", () => {
  it("refuses to redraft a quote, and the quote is byte for byte what it was", async () => {
    const { quote } = await issueRealQuote();
    const before = await handle.db.select().from(documentQuotes);

    await expect(withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, quote.id, { ...LETTER_INPUT },
    ))).rejects.toBeInstanceOf(DocumentFrozenError);

    // THE MESSAGE NAMES THE TYPE. "This document is frozen" invites the question
    // "why is THIS one"; "an issued quote cannot be changed" answers it, and the
    // answer is a product rule rather than a database state.
    await expect(withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, quote.id, { ...LETTER_INPUT },
    ))).rejects.toThrow("an issued quote cannot be changed");

    const [after] = await handle.db.select().from(documents).where(eq(documents.id, quote.id));
    expect(after).toMatchObject({
      number: quote.number, issueDate: quote.issueDate, fileId: quote.fileId, frozen: true,
    });
    expect(await handle.db.select().from(documentQuotes)).toEqual(before);
  });

  it("refuses to redraft either agreement", async () => {
    for (const type of ["nda", "mutual_nda"] as const) {
      const agreement = await raiseAgreement({ companyId }, { type });
      expect(agreement.frozen).toBe(true);
      await expect(withStub(OK_RENDER, async () => await redraftLetter(
        handle.db, { dataDir }, actorId, agreement.id, { ...LETTER_INPUT },
      ))).rejects.toThrow(
        type === "nda" ? "an issued nda cannot be changed" : "an issued mutual nda cannot be changed",
      );
    }
  });

  it("spends nothing when it refuses: no render, no blob, no file", async () => {
    const { quote } = await issueRealQuote();
    const filesBefore = await handle.db.select().from(files);
    // A RENDERER THAT FAILS IF IT IS CALLED AT ALL. The refusal has to arrive
    // before anything spawns -- issueQuote's rule -- and a test that only counted
    // `files` rows would be satisfied by a refusal that ran WeasyPrint and then
    // rolled back, which is a subprocess and ~700ms spent on a request that was
    // always going to fail.
    await expect(withStub("exit 9", async () => await redraftLetter(
      handle.db, { dataDir }, actorId, quote.id, { ...LETTER_INPUT },
    ))).rejects.toBeInstanceOf(DocumentFrozenError);
    expect(await handle.db.select().from(files)).toEqual(filesBefore);
  });

  /**
   * **THE SERVICE IS NOT THE ONLY THING SAYING NO, AND THIS IS THE TEST THAT
   * PROVES IT.** `redraftLetter` refuses first; `conduit_document_frozen_guard`
   * (migration 0019) refuses everything that is not `redraftLetter` -- a psql
   * session, an import, a restore-then-fix, and a call site nobody has written
   * yet. Task 4 adds a type to this table; whatever it writes, a quote stays
   * immutable without Task 4 having to remember anything.
   *
   * WRITTEN THROUGH DRIZZLE'S OWN UPDATE BUILDER, deliberately, because that is
   * the shape a future service function would take. db/schema.test.ts covers the
   * raw-SQL spellings and every table.
   */
  it("cannot be edited around the service either, straight through the ORM", async () => {
    const { quote } = await issueRealQuote();
    const refused = {
      code: "23514", message: expect.stringContaining("documents_frozen_is_immutable"),
    };
    await expect(handle.db.update(documents)
      .set({ issueDate: "2026-01-01" }).where(eq(documents.id, quote.id)))
      .rejects.toMatchObject({ cause: refused });
    await expect(handle.db.update(documentQuotes)
      .set({ totalCents: 1 }).where(eq(documentQuotes.documentId, quote.id)))
      .rejects.toMatchObject({ cause: refused });
    await expect(handle.db.delete(documents).where(eq(documents.id, quote.id)))
      .rejects.toMatchObject({ cause: refused });

    const [after] = await handle.db.select().from(documents).where(eq(documents.id, quote.id));
    expect(after).toMatchObject({ issueDate: quote.issueDate, frozen: true });
    const [money] = await handle.db.select().from(documentQuotes);
    expect(money?.totalCents).toBe(quote.totalCents);
  });

  it("will not let a frozen document be unfrozen so it can then be edited", async () => {
    // THE OBVIOUS WAY ROUND A GUARD KEYED ON A COLUMN is to change the column.
    // `WHEN (OLD.frozen)` is what stops it -- the trigger looks at the row as it
    // WAS -- and `documents_frozen_matches_type` would refuse the result anyway,
    // which is why both are asserted: either one alone would pass this test and
    // the pair is what makes the answer independent of which fires first.
    const { quote } = await issueRealQuote();
    await expect(handle.db.update(documents)
      .set({ frozen: false }).where(eq(documents.id, quote.id)))
      .rejects.toMatchObject({ cause: { code: "23514" } });
    const [after] = await handle.db.select().from(documents).where(eq(documents.id, quote.id));
    expect(after?.frozen).toBe(true);
  });
});

/* ========================================================================== *
 *  THE AGREEMENTS
 * ========================================================================== */

describe("issueAgreement raises a numbered, frozen document", () => {
  it("numbers an NDA, freezes it, and stores the three terms", async () => {
    const agreement = await raiseAgreement();
    expect(agreement).toMatchObject({
      type: "nda", number: "NDA-2026-0001", frozen: true, companyId, contactId: null,
      effectiveDate: "2026-09-01", termMonths: 36, jurisdiction: "the Netherlands",
      partyName: "Acme Manufacturing BV", partyContactName: "Jane Smith",
    });
    expect(documentTypeFreezes("nda")).toBe(true);
    const [row] = await handle.db.select().from(documentAgreements);
    expect(row).toMatchObject({
      documentId: agreement.id, type: "nda", effectiveDate: "2026-09-01",
      termMonths: 36, jurisdiction: "the Netherlands",
      partyName: "Acme Manufacturing BV", partyContactName: "Jane Smith",
      partyAddress: "1 Industrieweg\n1000 AA Amsterdam",
    });
  });

  it("gives the mutual NDA its own prefix and its own sequence", async () => {
    const first = await raiseAgreement();
    const mutual = await raiseAgreement({ companyId }, { type: "mutual_nda" });
    const second = await raiseAgreement();
    expect(first.number).toBe("NDA-2026-0001");
    // **ITS OWN SEQUENCE, NOT THE NDA'S.** `document_number_sequences` is keyed by
    // (type, year), so the two series are independent -- which is what makes the
    // mutual NDA's first document number 0001 and not 0002.
    expect(mutual.number).toBe("MNDA-2026-0001");
    expect(second.number).toBe("NDA-2026-0002");

    const rows = await handle.db.select().from(documentNumberSequences);
    expect(rows.map((row) => [row.type, row.year, row.lastValue]).sort())
      .toEqual([["mutual_nda", 2026, 1], ["nda", 2026, 2]]);
  });

  it("gives each year its own sequence, as the quote's numbering already did", async () => {
    const first = await raiseAgreement({ companyId }, { issueDate: "2026-09-06" });
    const next = await raiseAgreement({ companyId }, { issueDate: "2027-01-04" });
    expect(first.number).toBe("NDA-2026-0001");
    expect(next.number).toBe("NDA-2027-0001");
  });

  it("names the download after the number, as a quote's PDF is", async () => {
    const agreement = await raiseAgreement();
    const [file] = await handle.db.select().from(files).where(eq(files.id, agreement.fileId));
    expect(file).toMatchObject({ originalName: "NDA-2026-0001.pdf", companyId });
  });

  it("prints the term as months, with the singular spelled", async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
    const many = await raiseAgreement({ companyId }, {}, ECHOING_RENDER);
    // CLOSED ROUND THE CELL, which is Task 2's duration lesson: `toContain("36
    // months")` is satisfied by "36 monthss" and `toContain("1 month")` by
    // "1 months".
    expect(await mergedFor(many.fileId)).toContain("<td>36 months</td>");
    const one = await raiseAgreement({ companyId }, { termMonths: 1 }, ECHOING_RENDER);
    expect(await mergedFor(one.fileId)).toContain("<td>1 month</td>");
  });

  it("prints the counterparty, the named individual and the governing law", async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
    const agreement = await raiseAgreement({ companyId }, {}, ECHOING_RENDER);
    const html = await mergedFor(agreement.fileId);
    expect(html).toContain("<strong>Acme Manufacturing BV</strong>");
    expect(html).toContain("The Recipient acts through Jane Smith.");
    expect(html).toContain("the law of the Netherlands");
    expect(html).not.toMatch(/\{\{/);
  });

  it("omits the acting-through sentence when the party is an individual", async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
    const agreement = await raiseAgreement(
      { contactId }, { partyName: "Jane Smith", partyContactName: "" }, ECHOING_RENDER,
    );
    const html = await mergedFor(agreement.fileId);
    expect(html).not.toContain("acts through");
    expect(html).toContain("<strong>Jane Smith</strong>");
  });

  it("says each party binds the other in the mutual version, and only there", async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
    const oneWay = await raiseAgreement({ companyId }, {}, ECHOING_RENDER);
    const mutual = await raiseAgreement({ companyId }, { type: "mutual_nda" }, ECHOING_RENDER);
    expect(await mergedFor(oneWay.fileId)).toContain("Obligations of the Recipient");
    expect(await mergedFor(mutual.fileId)).toContain("Obligations of each party");
    expect(await mergedFor(mutual.fileId)).toContain("Mutual non-disclosure agreement");
  });

  it("refuses a term, a party and a jurisdiction the schema does not allow", async () => {
    for (const bad of [
      { termMonths: 0 }, { termMonths: AGREEMENT_MAX_TERM_MONTHS + 1 },
      { jurisdiction: "" }, { partyName: "" },
    ]) {
      await expect(raiseAgreement({ companyId }, bad)).rejects.toBeInstanceOf(DocumentInputError);
    }
    // AND NOTHING WAS SPENT: no number, no file, no document.
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
    expect(await handle.db.select().from(files)).toEqual([]);
  });

  it("answers ArchivedError for an archived company, before allocating a number", async () => {
    await archiveCompany(handle.db, actorId, companyId);
    await expect(raiseAgreement()).rejects.toBeInstanceOf(ArchivedError);
    // THE NUMBER MUST NOT HAVE BEEN SPENT, and this is the assertion that says
    // so. A gap in an agreement sequence invites the question of what was in it,
    // and for a contract that is a worse question than it is for a quote.
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
  });
});

describe("buildAgreementContext supplies what the seeded templates name", () => {
  it("supplies every merge path both agreement templates name", () => {
    const context = buildAgreementContext({
      org: {
        name: "Conduit BV", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "", timeZone: "UTC",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      number: "NDA-2026-0001", issueDate: "2026-09-06", effectiveDate: "2026-09-01",
      termMonths: 36, jurisdiction: "the Netherlands",
      partyName: "Acme", partyContactName: "", partyAddress: "",
    });
    const supplied = new Set([
      ...Object.keys(context.org).map((key) => `org.${key}`),
      ...Object.keys(context.document).map((key) => `document.${key}`),
      "lines",
    ]);
    for (const type of ["nda", "mutual_nda"] as const) {
      for (const path of templateMergePaths(seededAgreementTemplate(type), ["lines"]).root) {
        expect(supplied).toContain(path);
      }
    }
  });

  it("exposes the formatted term and not the raw month count", () => {
    // A TEMPLATE THAT COULD PRINT A BARE `36` BESIDE ITS OWN WORD FOR MONTHS
    // would read "36 months months", so the raw number is deliberately not a key.
    const context = buildAgreementContext({
      org: {
        name: "", addressLines: "", email: "", phone: "", website: "",
        bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "", timeZone: "UTC",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      number: "NDA-2026-0001", issueDate: "2026-09-06", effectiveDate: "2026-09-01",
      termMonths: 36, jurisdiction: "the Netherlands",
      partyName: "Acme", partyContactName: "", partyAddress: "",
    });
    expect(context.document.term).toBe("36 months");
    expect("termMonths" in context.document).toBe(false);
  });
});

/* ========================================================================== *
 *  THE MIXED LIST
 * ========================================================================== */

describe("listRecordDocuments", () => {
  it("returns a record's letters and agreements together, newest first", async () => {
    const letter = await writeLetter();
    const nda = await raiseAgreement();
    const mutual = await raiseAgreement({ companyId }, { type: "mutual_nda" });

    const list = await listRecordDocuments(handle.db, { companyId });
    expect(list.map((row) => row.id)).toEqual([mutual.id, nda.id, letter.id]);
    // THE UNION IS DISCRIMINATED AND EACH MEMBER CARRIES ITS OWN CONTENT: this is
    // the reader Task 1 predicted and Task 2 said would need three types.
    expect(list.map((row) => row.type)).toEqual(["mutual_nda", "nda", "letter"]);
    const found = list.find((row) => row.type === "letter");
    expect(found).toMatchObject({ bodyHtml: expect.stringContaining("Thank you") });
    const agreement = list.find((row) => row.type === "nda");
    expect(agreement).toMatchObject({ number: "NDA-2026-0001", termMonths: 36 });
  });

  it("returns nothing for a record with no documents, and nobody else's", async () => {
    await writeLetter();
    expect(await listRecordDocuments(handle.db, { contactId })).toEqual([]);
    const other = await createCompany(handle.db, actorId, { name: "Other BV" });
    expect(await listRecordDocuments(handle.db, { companyId: other.id })).toEqual([]);
  });

  it("keeps a contact's documents separate from their company's", async () => {
    const onCompany = await writeLetter({ companyId });
    const onContact = await writeLetter({ contactId });
    expect((await listRecordDocuments(handle.db, { companyId })).map((r) => r.id))
      .toEqual([onCompany.id]);
    expect((await listRecordDocuments(handle.db, { contactId })).map((r) => r.id))
      .toEqual([onContact.id]);
  });

  /**
   * **THE ROLLUP TASK 3 RECOMMENDED AND TASK 4 BUILT, AND THE TEST ABOVE IS WHY
   * IT IS OPT-IN.** That one asserts a deliberate emptiness -- "it is the
   * decision working rather than a bug" -- and it is still asserted, unchanged,
   * a few lines up. This one asserts the other view of the same rows.
   *
   * **NOTHING ABOUT THE DATA MODEL MOVED.** Each document still names exactly one
   * record: the rolled-up letter comes back with `contactId` set and `companyId`
   * null, which is the row as written, and that is what a caller reads to tell
   * the two apart. Task 3's warning about widening the CHECK -- "it would make
   * every reader ask 'which of the two is this document really about'" -- is why
   * the DTO is not touched either.
   */
  it("rolls a contact's documents up into their company's list, but only when asked", async () => {
    const onCompany = await writeLetter({ companyId });
    const onContact = await writeLetter({ contactId });
    // A contact at a DIFFERENT company must not come along -- the subquery is
    // `contacts.company_id = $1`, not "every contact".
    const elsewhere = await createCompany(handle.db, actorId, { name: "Other BV" });
    const stranger = await createContact(handle.db, actorId, {
      firstName: "Sam", lastName: "Stranger", companyId: elsewhere.id,
    });
    const onStranger = await writeLetter({ contactId: stranger.id });

    const rolled = await listRecordDocuments(
      handle.db, { companyId }, { includeContacts: true },
    );
    // Newest first, over the WHOLE set -- which is what makes the subquery worth
    // having instead of two reads merged in TypeScript.
    expect(rolled.map((r) => r.id)).toEqual([onContact.id, onCompany.id]);
    expect(rolled.map((r) => r.id)).not.toContain(onStranger.id);
    // The rolled-up row still says which record it is really on.
    expect(rolled[0]).toMatchObject({ contactId, companyId: null });
    expect(rolled[1]).toMatchObject({ companyId, contactId: null });

    // Explicitly OFF is the same answer as not asking, which is what makes the
    // default a default rather than an accident of the parameter's shape.
    expect((await listRecordDocuments(handle.db, { companyId }, { includeContacts: false }))
      .map((r) => r.id)).toEqual([onCompany.id]);

    // AND IT IS IGNORED FOR A CONTACT rather than refused: a contact has no
    // contacts, so there is nothing to roll up and both answers are the same.
    expect((await listRecordDocuments(handle.db, { contactId }, { includeContacts: true }))
      .map((r) => r.id)).toEqual([onContact.id]);
  });

  it("reflects a redraft rather than adding a second row", async () => {
    const letter = await writeLetter();
    await withStub(OK_RENDER, async () => await redraftLetter(
      handle.db, { dataDir }, actorId, letter.id,
      { ...LETTER_INPUT, subject: "Redrafted", bodyHtml: "<p>New body.</p>" },
    ));
    const list = await listRecordDocuments(handle.db, { companyId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: letter.id, subject: "Redrafted" });
  });
});

describe("the size gate names the type it refused", () => {
  const HUGE = "x".repeat(RENDER_MARKUP_CAP_BYTES + 1);

  it("refuses an oversized letter with a message about a letter and its body", async () => {
    // Through the TEMPLATE rather than the body, because the body's own cap is
    // narrower than the render cap by construction -- which is the point of
    // LETTER_FIELD_CAPS.bodyHtml and is asserted here by being unable to breach
    // the render cap from the form at all.
    expect(LETTER_FIELD_CAPS.bodyHtml * 3).toBeLessThan(RENDER_MARKUP_CAP_BYTES);
    await seedTemplates(`<p>${HUGE}</p>{{document.body}}`);
    await expect(writeLetter()).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(writeLetter()).rejects.toThrow(/this letter merges to \d+ bytes of markup/);
    await expect(writeLetter()).rejects.toThrow(/and its body \d+/);
  });

  it("refuses an oversized agreement as an agreement, naming its party and jurisdiction", async () => {
    await handle.db.delete(documentTemplates).where(eq(documentTemplates.type, "nda"));
    await handle.db.insert(documentTemplates)
      .values({ type: "nda", bodyHtml: `<p>${HUGE}</p>{{document.partyName}}` });
    await expect(raiseAgreement()).rejects.toThrow(/this agreement merges to \d+ bytes of markup/);
    await expect(raiseAgreement()).rejects.toThrow(/party and jurisdiction \d+/);
    // NOTHING WAS SPENT. The size check fires after the number is allocated (the
    // number is printed, so the merge needs it) and before anything spawns -- so
    // it rolls back exactly like a failed render.
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
    expect(await handle.db.select().from(documents)).toEqual([]);
  });
});

describe("the real renderer", () => {
  itReal("renders a one-page letter whose body keeps its list", async () => {
    await saveOrgProfile(handle.db, {
      ...BLANK_PROFILE, name: "Conduit BV", addressLines: "2 Kade\n1000 AA Amsterdam",
    });
    const letter = await issueLetter(
      handle.db, { dataDir }, actorId, { companyId }, LETTER_INPUT,
    );
    const [file] = await handle.db.select().from(files).where(eq(files.id, letter.fileId));
    const pdf = await readFile(blobPath(dataDir, file!.sha256));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
    const text = pdfVisibleText(pdf);
    expect(text).toContain("Dear Ms Smith");
    expect(text).toContain("We will send the plan");
    expect(text).toContain("Renewal of your maintenance contract");
  }, 60_000);

  itReal("renders a one-page NDA carrying its number and its term", async () => {
    await saveOrgProfile(handle.db, { ...BLANK_PROFILE, name: "Conduit BV" });
    const agreement = await issueAgreement(
      handle.db, { dataDir }, actorId, { companyId }, AGREEMENT_INPUT,
    );
    const [file] = await handle.db.select().from(files).where(eq(files.id, agreement.fileId));
    const pdf = await readFile(blobPath(dataDir, file!.sha256));
    expect(pageCount(pdf)).toBe(1);
    const text = pdfVisibleText(pdf);
    expect(text).toContain("NDA-2026-0001");
    expect(text).toContain("36 months");
    expect(text).toContain("the Netherlands");
  }, 60_000);
});
