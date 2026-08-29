import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  documentContentBytes, DOCUMENT_CONTENT_BUDGET_BYTES, DOCUMENT_MAX_DESCRIPTION_CHARS,
  DOCUMENT_MAX_LINES, MAX_LOGO_DATA_URI_CHARS, type IssueQuoteInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import { seededQuoteTemplate, seededTemplatePaths } from "../test/seed-template.js";
import { pageCount, pdfHasImage } from "../test/pdf.js";
import { resolveUser } from "../users.js";
import {
  companies, deals, documentLineItems, documentNumberSequences, documents,
  documentTemplates, files,
} from "../db/schema.js";
import { createCompany } from "./companies.js";
import { createDeal } from "./deals.js";
import { createPipeline, createStage } from "./pipelines.js";
import { blobPath, saveBlob } from "./blobs.js";
import { getOrgProfile, saveOrgProfile } from "./org-profile.js";
import { prepareDocumentHtml } from "./documents-template.js";
import { weasyprintAvailable } from "./documents-render.js";
import {
  buildContext, DocumentInputError, DocumentTemplateMissingError, issueQuote, listDocuments,
  type QuoteContextInput,
} from "./documents.js";
import { ArchivedError, NotFoundError } from "./errors.js";

/**
 * ISSUING A QUOTE: ONE TRANSACTION, AND THE IMMUTABILITY PROOF.
 *
 * MOST OF THIS FILE RUNS WITHOUT WEASYPRINT, and that is a deliberate inversion of
 * the obvious arrangement. The failure paths -- a render that exits non-zero, an
 * input the gate must refuse before anything spawns -- are exactly the ones a
 * binary-gated suite would never execute on a developer machine, which is backwards
 * for code whose job is failing well. A stub `python3` on PATH (test/python-stub.ts)
 * gives every one of them a real subprocess to fail in.
 *
 * THE STUB EMITS DIFFERENT BYTES EVERY TIME, AND THAT IS WHAT MAKES THE CENTRAL
 * CLAIM TESTABLE. With a constant-output renderer, "the stored PDF is byte-identical
 * after the world moves on" would pass even if the code re-rendered on every read --
 * the assertion would be about the stub, not about the storage. Eight random bytes
 * per invocation turn it into a claim: identical bytes can only mean nothing
 * re-rendered. (The real renderer is not reproducible either -- Task 1 measured three
 * runs of identical input at 6899, 6899 and 6898 bytes -- so this mirrors reality
 * rather than working around it.)
 *
 * The gated tests at the end are the ones that need the real thing: a real PDF, from
 * the real seeded template, through the real buildContext.
 */

const handle = openTestDatabase();
const stubDir = mkdtempSync(join(tmpdir(), "conduit-documents-"));
const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

/**
 * A renderer that succeeds with a DIFFERENT eight bytes on every invocation, and
 * records that it ran.
 *
 * THE COUNT IS THE STRONGER HALF OF THE IMMUTABILITY CLAIM. Comparing the stored
 * bytes proves they did not change; it does not prove nothing re-rendered, because a
 * re-render whose output was discarded reads back the same content-addressed file.
 * Counting the spawns closes that, and the varying bytes stay as the second,
 * independent assertion.
 */
function varyingPdf(): string {
  return [
    `printf 'x' >> '${renderLog}'`,
    "printf '%s' '%PDF-1.7 conduit-stub-'",
    "od -An -N8 -tx1 /dev/urandom | tr -d ' \\n'",
    "printf '%s' ' end'",
  ].join("\n");
}

/** How many times the stub renderer has been spawned in this test. */
function renderCount(): number {
  return existsSync(renderLog) ? readFileSync(renderLog, "utf8").length : 0;
}

/** A renderer that fails the way a broken template makes the real one fail. */
const FAILING_RENDER = "echo 'Fatal: could not parse' >&2\nexit 5";

/**
 * A 1x1 PNG as the data: URI the profile now stores.
 *
 * IT USED TO BE A `files` ROW ATTACHED TO A COMPANY, because org_profile carried a
 * uuid FK to files and `files_exactly_one_entity` requires every file to belong to
 * exactly one company, contact, deal or project -- an issuer's logo belongs to none
 * of them, so no legal row existed and both suites had to point one at an unrelated
 * record. The column holds the bytes now.
 */
const LOGO_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
  + "2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dataDir: string;
let actorId: string;
let companyId: string;
let dealId: string;
/** Touched by the marker stub below; its ABSENCE is what proves nothing spawned. */
let spawnMarker: string;
/** One character per render the stub performed -- see varyingPdf. */
let renderLog: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = mkdtempSync(join(stubDir, "data-"));
  spawnMarker = join(dataDir, "the-renderer-ran");
  renderLog = join(dataDir, "render-log");
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  const company = await createCompany(handle.db, actorId, { name: "Acme Manufacturing BV" });
  companyId = company.id;
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
  const deal = await createDeal(
    handle.db, actorId,
    { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id, companyId },
    "EUR",
  );
  dealId = deal.id;
  // THE SEEDED TEMPLATE HAS TO BE PUT BACK BY HAND. truncateAll() empties every
  // table in the public schema, so migration 0009's row is gone before any test body
  // runs -- and a test that did not notice would be merging against nothing, or
  // UPDATEing zero rows and calling that immutability.
  await seedQuoteTemplate();
});

afterAll(async () => {
  await handle.close();
  rmSync(stubDir, { recursive: true, force: true });
});

async function seedQuoteTemplate(bodyHtml = seededQuoteTemplate()): Promise<void> {
  await handle.db.delete(documentTemplates).where(eq(documentTemplates.type, "quote"));
  await handle.db.insert(documentTemplates).values({ type: "quote", bodyHtml });
}

function quoteInput(overrides: Partial<IssueQuoteInput> = {}): IssueQuoteInput {
  return {
    issueDate: "2026-08-28",
    validUntilDate: "2026-09-27",
    recipientName: "Acme Manufacturing BV",
    recipientContactName: "Jane Smith",
    recipientAddress: "2 Low Street\n1015 CJ Amsterdam",
    notes: "Thank you for your interest.",
    terms: "Payment within 30 days.",
    lines: [
      { description: "Widget", qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100 },
    ],
    ...overrides,
  };
}

/** Issue a quote against a stub renderer, so no binary is needed. */
async function issueWithStub(
  body = varyingPdf(), input: IssueQuoteInput = quoteInput(),
): Promise<Awaited<ReturnType<typeof issueQuote>>> {
  const dir = writePythonStub(stubDir, body);
  return await withPythonStub(dir, async () =>
    await issueQuote(handle.db, { dataDir }, actorId, dealId, input));
}

/** The same, but returning whatever was thrown. */
async function issueExpectingFailure(body: string, input = quoteInput()): Promise<unknown> {
  const dir = writePythonStub(stubDir, body);
  return await withPythonStub(dir, async () =>
    await issueQuote(handle.db, { dataDir }, actorId, dealId, input).catch((e: unknown) => e));
}

/** A stub that records having run, so an input rejected BEFORE the spawn is visible. */
function markerStub(): string {
  return writePythonStub(stubDir, `touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`);
}

/** How many blobs the store holds. The directory does not exist until the first
 * save, which is not an error -- it is zero. */
function blobCount(): number {
  const dir = join(dataDir, "files");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

async function readStoredPdf(fileId: string): Promise<Buffer> {
  const [file] = await handle.db.select().from(files).where(eq(files.id, fileId));
  if (file === undefined) throw new Error(`no files row ${fileId}`);
  return await readFile(blobPath(dataDir, file.sha256));
}

// ------------------------------------------------------ the transaction's shape

describe("issueQuote", () => {
  it("stores a numbered PDF against the deal, with its lines and totals frozen", async () => {
    const doc = await issueWithStub();

    expect(doc.number).toBe("QUO-2026-0001");
    expect(doc.type).toBe("quote");
    expect(doc.currency).toBe("EUR");
    // 2 x 50.00 = 100.00, plus 21% = 121.00.
    expect(doc.subtotalCents).toBe(10_000);
    expect(doc.taxCents).toBe(2100);
    expect(doc.totalCents).toBe(12_100);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ position: 1, description: "Widget", lineTotalCents: 10_000 });
    expect(doc.recipientContactName).toBe("Jane Smith");

    // The PDF is an ordinary files row on the same deal, so it appears on the Files
    // tab and downloads through GET /api/files/:id/download with no second path.
    const rows = await handle.db.select().from(files).where(eq(files.dealId, dealId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mime: "application/pdf", originalName: "QUO-2026-0001.pdf" });
    expect(rows[0]!.id).toBe(doc.fileId);

    const pdf = await readStoredPdf(doc.fileId);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(rows[0]!.sizeBytes).toBe(pdf.length);
  });

  it("takes the currency from the deal rather than the submission", async () => {
    await handle.db.update(deals).set({ currency: "GBP" }).where(eq(deals.id, dealId));
    const doc = await issueWithStub();
    expect(doc.currency).toBe("GBP");
  });

  it("gives the second quote of the year the next number", async () => {
    const first = await issueWithStub();
    const second = await issueWithStub();
    expect(first.number).toBe("QUO-2026-0001");
    expect(second.number).toBe("QUO-2026-0002");
  });

  it("numbers per year, so a quote dated in January starts again at one", async () => {
    await issueWithStub();
    const next = await issueWithStub(varyingPdf(), quoteInput({
      issueDate: "2027-01-04", validUntilDate: "2027-02-03",
    }));
    expect(next.number).toBe("QUO-2027-0001");
  });

  it("numbers the line items 1..n in submitted order", async () => {
    const doc = await issueWithStub(varyingPdf(), quoteInput({
      lines: [
        { description: "First", qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0 },
        { description: "Second", qtyMilli: 1000, unitPriceCents: 200, taxRateBp: 0 },
        { description: "Third", qtyMilli: 1000, unitPriceCents: 300, taxRateBp: 0 },
      ],
    }));
    expect(doc.lines.map((line) => [line.position, line.description]))
      .toEqual([[1, "First"], [2, "Second"], [3, "Third"]]);
    expect(doc.subtotalCents).toBe(600);
  });

  it("refuses to quote a deal that does not exist", async () => {
    const dir = markerStub();
    const error = await withPythonStub(dir, async () => await issueQuote(
      handle.db, { dataDir }, actorId, "00000000-0000-4000-8000-000000000000", quoteInput(),
    ).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(existsSync(spawnMarker)).toBe(false);
  });

  it("refuses to quote an archived deal", async () => {
    await handle.db.update(deals).set({ archivedAt: new Date() }).where(eq(deals.id, dealId));
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`);

    expect(error).toBeInstanceOf(ArchivedError);
    expect(existsSync(spawnMarker)).toBe(false);
  });

  it("says so when the quote template has been deleted, rather than failing obscurely", async () => {
    await handle.db.delete(documentTemplates);
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`);

    expect(error).toBeInstanceOf(DocumentTemplateMissingError);
    expect((error as Error).message).toContain("Settings");
    expect(existsSync(spawnMarker)).toBe(false);
  });
});

// ------------------------------------- what the number lock does and does not do

describe("two quotes at once", () => {
  /**
   * A stub that records how many copies of itself were running when it started, so
   * concurrency is measured from the CHILDREN rather than from a counter inside the
   * code under test.
   */
  function countingStub(runDir: string, observed: string): string {
    return [
      `mkdir -p '${runDir}'`,
      `: > '${runDir}'/$$`,
      `ls '${runDir}' | wc -l >> '${observed}'`,
      "sleep 0.5",
      `rm -f '${runDir}'/$$`,
      "printf '%s' '%PDF-1.7 ok'",
    ].join("\n");
  }

  function maxObserved(observed: string): number {
    return Math.max(...readFileSync(observed, "utf8").trim().split("\n").map(Number));
  }

  async function issueTwoConcurrently(years: [string, string]): Promise<number> {
    const runDir = join(dataDir, "conc-run");
    const observed = join(dataDir, "conc-observed");
    writeFileSync(observed, "");
    const dir = writePythonStub(stubDir, countingStub(runDir, observed));
    await withPythonStub(dir, async () => {
      await Promise.all(years.map(async (issueDate) => await issueQuote(
        handle.db, { dataDir }, actorId, dealId, quoteInput({ issueDate, validUntilDate: null }),
      )));
    });
    return maxObserved(observed);
  }

  // THE ROW LOCK SERIALISES ONE (type, year) AND NOTHING ELSE, and an earlier comment
  // in documents-number.ts claimed it serialised issuing outright. It does not: the
  // year comes from the CALLER's issue date, so quotes dated in different years take
  // different rows, different locks, and render side by side -- which is how the
  // issuing path reaches renderPdf's three-slot queue while holding a row lock, an
  // open transaction and a pooled connection.
  //
  // Two at a time rather than six because openTestDatabase's pool is max: 2, so two
  // is every transaction this harness can have open at once. Two is enough: the
  // claim under test is "more than one", and its control is directly below.
  it("renders two different years at the same time", async () => {
    expect(await issueTwoConcurrently(["2026-08-28", "2027-08-28"])).toBe(2);
    expect((await listDocuments(handle.db, dealId)).map((doc) => doc.number).sort())
      .toEqual(["QUO-2026-0001", "QUO-2027-0001"]);
  }, 20_000);

  it("but serialises two quotes of the same year, which is what makes the numbers consecutive", async () => {
    // The control that makes the test above mean something. Same year, same row, so
    // the second transaction blocks on the lock BEFORE it renders -- one child at a
    // time, and consecutive numbers.
    expect(await issueTwoConcurrently(["2026-08-28", "2026-09-30"])).toBe(1);
    expect((await listDocuments(handle.db, dealId)).map((doc) => doc.number).sort())
      .toEqual(["QUO-2026-0001", "QUO-2026-0002"]);
  }, 20_000);
});

// -------------------------------------------------------------- the rollback

describe("issueQuote rollback", () => {
  it("spends no number, writes no file and leaves no document when the render fails", async () => {
    const error = await issueExpectingFailure(FAILING_RENDER);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("renderer exited 5");

    // The whole point of a table-backed counter over a SEQUENCE: nextval() would
    // have kept the 1 and the next quote would be QUO-2026-0002, leaving a hole in
    // the numbering that nobody can explain.
    expect(await handle.db.select().from(documentNumberSequences)).toHaveLength(0);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
    expect(await handle.db.select().from(documentLineItems)).toHaveLength(0);
    expect(await handle.db.select().from(files)).toHaveLength(0);

    const recovered = await issueWithStub();
    expect(recovered.number).toBe("QUO-2026-0001");
  });

  it("rolls back a merge that cannot terminate, before anything spawns", async () => {
    // mergeTemplate throws TemplateError from three bounds (work, depth, output).
    // The number is allocated before the merge because it is printed on the page, so
    // this is a rollback too -- and the render never happens, which the marker
    // proves. A route turns this into an error about the TEMPLATE, not a 500.
    await seedQuoteTemplate(`${"{{#lines}}".repeat(40)}x${"{{/lines}}".repeat(40)}`);
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`);

    expect((error as Error).name).toBe("TemplateError");
    expect(existsSync(spawnMarker)).toBe(false);
    expect(await handle.db.select().from(documentNumberSequences)).toHaveLength(0);

    await seedQuoteTemplate();
    expect((await issueWithStub()).number).toBe("QUO-2026-0001");
  });

  it("leaves an orphan blob on a rollback, which is the one part that cannot roll back", async () => {
    // DELIBERATE AND HARMLESS, pinned here so nobody "fixes" it into the ordering
    // that can leave a documents row whose PDF does not exist. Blobs are
    // content-addressed by sha256, so an orphan is unreferenced bytes on disk rather
    // than a visible document -- no files row and no documents row point at it.
    //
    // The failure has to arrive AFTER the render, which a colliding number produces
    // exactly: documents_number_unique rejects the insert with the PDF already
    // written and the file row already inserted in the same transaction.
    const [placeholder] = await handle.db.insert(files).values({
      originalName: "QUO-2026-0001.pdf", mime: "application/pdf", sizeBytes: 1,
      sha256: "a".repeat(64), uploaderUserId: actorId, dealId,
    }).returning();
    await handle.db.insert(documents).values({
      number: "QUO-2026-0001", type: "quote", dealId, fileId: placeholder!.id,
      currency: "EUR", issueDate: "2026-08-28", recipientName: "Someone Else",
      subtotalCents: 100, taxCents: 0, totalCents: 100, issuedByUserId: actorId,
    });

    const before = blobCount();
    const error = await issueExpectingFailure(varyingPdf());
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("23505");

    // The bytes are on disk...
    expect(blobCount()).toBe(before + 1);
    // ...and nothing in the database refers to them: no second document, and the
    // only files row is the placeholder that was there before.
    expect(await handle.db.select().from(documents)).toHaveLength(1);
    expect(await handle.db.select().from(files)).toHaveLength(1);
    expect(await handle.db.select().from(documentNumberSequences)).toHaveLength(0);
  });
});

// ------------------------------------------------- the gate (plan Step 5a)

describe("issueQuote input gate", () => {
  /**
   * THREE CHECK CONSTRAINTS, GATED BEFORE ANYTHING SPAWNS.
   *
   * money.ts keeps a WIDER domain than all three on purpose -- divideRoundHalfUp has
   * a negative branch so a future credit note rounds correctly -- so each of these
   * computes a total, renders a PDF and then dies on the INSERT as a 23514: an
   * opaque 500 raised after a subprocess has already run, for a value the form had
   * just called fine. All three were reproduced in exactly that shape.
   *
   * The marker's absence is the assertion that matters. Without it this would only
   * prove the request was refused, not that it was refused in time.
   */
  const cases: [string, IssueQuoteInput][] = [
    ["a negative quantity (document_line_items_qty_nonneg)", quoteInput({
      lines: [{ description: "Refund", qtyMilli: -1000, unitPriceCents: 5000, taxRateBp: 2100 }],
    })],
    ["a negative unit price (document_line_items_price_nonneg)", quoteInput({
      lines: [{ description: "Credit", qtyMilli: 1000, unitPriceCents: -5000, taxRateBp: 2100 }],
    })],
    ["a tax rate above 100% (document_line_items_tax_range)", quoteInput({
      lines: [{ description: "Widget", qtyMilli: 1000, unitPriceCents: 5000, taxRateBp: 15_000 }],
    })],
  ];

  for (const [label, input] of cases) {
    it(`refuses ${label} before the renderer is spawned`, async () => {
      const dir = markerStub();
      const error = await withPythonStub(dir, async () =>
        await issueQuote(handle.db, { dataDir }, actorId, dealId, input).catch((e: unknown) => e));

      expect(error).toBeInstanceOf(DocumentInputError);
      expect(existsSync(spawnMarker)).toBe(false);
      expect(await handle.db.select().from(documentNumberSequences)).toHaveLength(0);
      expect(await handle.db.select().from(documents)).toHaveLength(0);
    });
  }

  it("refuses a year Postgres has no room for, which used to fail AFTER the render", async () => {
    // THE FOURTH POST-RENDER 500. `z.iso.date()` accepts 0000-01-01 and Postgres has
    // no year zero, so this computed, allocated a number, RENDERED, wrote the blob
    // and died on the INSERT with 22008 -- a bare Error no domain mapping catches.
    // The same shape as the three CHECK constraints, with a third error code.
    for (const dates of [
      { issueDate: "0000-01-01" },
      { issueDate: "2026-08-28", validUntilDate: "0000-12-31" },
    ]) {
      const error = await issueExpectingFailure(
        `touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`, quoteInput(dates),
      );
      expect(error).toBeInstanceOf(DocumentInputError);
      expect(existsSync(spawnMarker)).toBe(false);
    }
    expect(await handle.db.select().from(documentNumberSequences)).toHaveLength(0);
  });

  it("refuses a quantity past the int4 column, which money.ts already bounds", async () => {
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`,
      quoteInput({
        lines: [{ description: "Sand", qtyMilli: 3_000_000_000, unitPriceCents: 1, taxRateBp: 0 }],
      }));
    expect(error).toBeInstanceOf(DocumentInputError);
    expect(existsSync(spawnMarker)).toBe(false);
  });

  it("refuses totals that no column could represent -- the failure that is not a CHECK", async () => {
    // THE FAILURE THAT IS NOT A CHECK. Every field below is individually in range:
    // 2,147,483.647 units at MAX_SAFE_INTEGER cents passes all three CHECKs and both
    // representability constraints, and it is the ARITHMETIC over them that cannot be
    // represented. documentTotals throws a plain Error saying so; ungated that is a
    // 500 for a submission a form could have refused.
    const line = {
      description: "Everything", qtyMilli: 2_147_483_647,
      unitPriceCents: Number.MAX_SAFE_INTEGER, taxRateBp: 0,
    };
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`,
      quoteInput({ lines: Array.from({ length: DOCUMENT_MAX_LINES }, () => ({ ...line })) }));

    expect(error).toBeInstanceOf(DocumentInputError);
    expect((error as Error).message).toContain("more than a document can represent");
    expect(existsSync(spawnMarker)).toBe(false);
  });

  it("refuses a quote with no lines, and one with more than the render budget allows", async () => {
    const line = { description: "Widget", qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0 };
    const empty = await issueExpectingFailure("printf '%s' '%PDF-1.7 ok'", quoteInput({ lines: [] }));
    expect(empty).toBeInstanceOf(DocumentInputError);

    const tooMany = await issueExpectingFailure("printf '%s' '%PDF-1.7 ok'", quoteInput({
      lines: Array.from({ length: DOCUMENT_MAX_LINES + 1 }, () => ({ ...line })),
    }));
    expect(tooMany).toBeInstanceOf(DocumentInputError);

    // ...and the maximum is accepted, so the bound is a bound rather than a refusal.
    const ok = await issueWithStub(varyingPdf(), quoteInput({
      lines: Array.from({ length: DOCUMENT_MAX_LINES }, () => ({ ...line })),
    }));
    expect(ok.lines).toHaveLength(DOCUMENT_MAX_LINES);
  });

  it("refuses a line description longer than the budget assumed", async () => {
    const error = await issueExpectingFailure("printf '%s' '%PDF-1.7 ok'", quoteInput({
      lines: [{
        description: "x".repeat(DOCUMENT_MAX_DESCRIPTION_CHARS + 1),
        qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0,
      }],
    }));
    expect(error).toBeInstanceOf(DocumentInputError);
  });

  it("refuses a quote that is inside every field cap and still too big to render", async () => {
    // THE FAILURE THE PER-FIELD CAPS CANNOT EXPRESS. Every field here is legal: 60
    // lines, 250 characters each, notes and terms at their maxima. What is not legal
    // is the total, because these characters cost three bytes each -- and without the
    // budget check this would compute, allocate a number, merge, and come back as a
    // 413 from the renderer naming a byte count nobody filling in a form can act on.
    const cjk = "\u6771".repeat(DOCUMENT_MAX_DESCRIPTION_CHARS);
    const error = await issueExpectingFailure(`touch '${spawnMarker}'\nprintf '%s' '%PDF-1.7 ok'`,
      quoteInput({
        recipientName: "\u6771".repeat(200), recipientContactName: "\u6771".repeat(200),
        recipientAddress: "\u6771".repeat(2000),
        notes: "\u6771".repeat(5000), terms: "\u6771".repeat(5000),
        lines: Array.from({ length: DOCUMENT_MAX_LINES }, () => ({
          description: cjk, qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0,
        })),
      }));

    expect(error).toBeInstanceOf(DocumentInputError);
    expect((error as Error).message).toContain("a document may use");
    expect(existsSync(spawnMarker)).toBe(false);
  });

  it("costs an escaped character what the renderer will actually charge for it", async () => {
    // Measured against the shipped template: `&` becomes `&amp;` and costs five
    // bytes, `<` and `>` cost four, and `"` costs one because the sanitiser
    // re-serialises it bare in text position. A budget counting string length would
    // under-count an ampersand-heavy quote by five to one.
    const plain = documentContentBytes({ lines: [{ description: "xxxx" }] });
    expect(documentContentBytes({ lines: [{ description: "&&&&" }] }) - plain).toBe(16);
    expect(documentContentBytes({ lines: [{ description: "<<<<" }] }) - plain).toBe(12);
    expect(documentContentBytes({ lines: [{ description: '""""' }] }) - plain).toBe(0);
    // ...and a three-byte character costs three.
    expect(documentContentBytes({ lines: [{ description: "\u6771\u6771\u6771\u6771" }] }) - plain).toBe(8);
  });

  it("accepts the largest total that still formats exactly, and stores it", async () => {
    // 7,036,874,417,766,401 is the first cents value whose formatting used to
    // disagree with the exact decimal, and an earlier round of money-format.ts
    // REFUSED anything above it -- which would have made this an unprintable quote
    // that had already passed both CHECKs. The ceiling is gone (the decimal is built
    // with BigInt now), so the deliberate answer here is that the route does nothing
    // special: it stores it and prints it exactly.
    const doc = await issueWithStub(varyingPdf(), quoteInput({
      lines: [{
        description: "One very large widget", qtyMilli: 1000,
        unitPriceCents: 7_036_874_417_766_401, taxRateBp: 0,
      }],
    }));
    expect(doc.totalCents).toBe(7_036_874_417_766_401);
    const [stored] = await listDocuments(handle.db, dealId);
    expect(stored?.totalCents).toBe(7_036_874_417_766_401);
  });
});

// ------------------------------------------- the merge contract (plan Step 5b)

/** A filled context, so every optional block in the seeded template is exercised. */
function sampleContextInput(overrides: Partial<QuoteContextInput> = {}): QuoteContextInput {
  return {
    org: {
      name: "Listerdale Life Sciences", addressLines: "1 High St\n1015 CJ Amsterdam",
      vatNumber: "NL001234567B01", registrationNumber: "12345678",
      email: "hello@listerdale.test", phone: "+31 20 123 4567",
      website: "listerdale.test", bankDetails: "NL00 BANK 0123 4567 89",
      logoDataUri: "", updatedAt: new Date(0).toISOString(),
    },
    currency: "EUR",
    number: "QUO-2026-0001",
    issueDate: "2026-08-28",
    validUntilDate: "2026-09-27",
    recipientName: "Acme Manufacturing BV",
    recipientContactName: "Jane Smith",
    recipientAddress: "2 Low Street\n1015 CJ Amsterdam",
    notes: "Thank you for your interest.",
    terms: "Payment within 30 days.",
    subtotalCents: 1_100_000,
    taxCents: 231_000,
    totalCents: 1_331_000,
    lines: [{
      description: "Consultancy", qtyMilli: 1500, unitPriceCents: 5000,
      taxRateBp: 2100, lineTotalCents: 7500,
    }],
    ...overrides,
  };
}

describe("buildContext", () => {
  /**
   * THE MERGE CONTRACT, MADE A CONTRACT.
   *
   * schema.test.ts already asserts the seeded template's tokens EQUAL a literal list
   * written out beside them -- which pins what the template may contain and connects
   * neither side to the code that supplies the values. An unknown path resolves to ""
   * and never throws (Task 3's rule, and the right one), so supplying
   * `document.subTotal` for `{{document.subtotal}}` leaves every test in this repo
   * green while the printed quote has a blank where a total should be. That is the
   * most expensive kind of defect this phase can produce: invisible until a customer
   * reads it.
   *
   * CONTAINMENT, NOT EQUALITY, and in this direction: the template's paths must all
   * be supplied. An extra context key is harmless (nothing prints it); a missing one
   * is a blank on a page.
   */
  it("supplies every merge path the seeded template actually names, in the scope it names it", () => {
    // SCOPE BY SCOPE, not one pooled set. Inside {{#lines}} a bare {{qty}} resolves
    // against the line; at the top level the same token resolves against the root and
    // renders empty. A flat comparison would count {{qty}} as supplied wherever it
    // appeared, so a template that moved a line field out of its block would keep
    // passing while printing a blank.
    const paths = seededTemplatePaths();
    // Guard against a vacuous pass: if the reader stopped finding tokens, the
    // containment checks below would succeed against empty lists.
    expect(paths.root.length).toBeGreaterThan(20);
    expect(paths.line.length).toBeGreaterThan(3);
    expect(paths.root).toContain("document.subtotal");
    expect(paths.root).toContain("org.logoDataUri");
    expect(paths.root).toContain("lines");
    expect(paths.line).toContain("qty");
    // ...and the split is real: a line's fields are NOT root paths.
    expect(paths.root).not.toContain("qty");

    const context = buildContext(sampleContextInput());
    const rootKeys = new Set<string>([
      ...Object.keys(context.org).map((key) => `org.${key}`),
      ...Object.keys(context.document).map((key) => `document.${key}`),
      "lines",
    ]);
    const lineKeys = new Set(Object.keys(context.lines[0] ?? {}));

    expect(paths.root.filter((path) => !rootKeys.has(path))).toEqual([]);
    expect(paths.line.filter((path) => !lineKeys.has(path))).toEqual([]);
  });

  it("formats money, quantities and rates with the shared formatters", () => {
    const context = buildContext(sampleContextInput());
    // Not the currency glyph: this file is ASCII, and the digits are the part a
    // wrong locale would break ("11.000,00" on a Dutch browser).
    expect(context.document.subtotal).toContain("11,000.00");
    expect(context.document.tax).toContain("2,310.00");
    expect(context.document.total).toContain("13,310.00");
    expect(context.lines[0]?.qty).toBe("1.5");
    expect(context.lines[0]?.taxRate).toBe("21%");
    expect(context.lines[0]?.lineTotal).toContain("75.00");
  });

  it("renders an absent optional as empty, which is what the template's blocks read", () => {
    const context = buildContext(sampleContextInput({ validUntilDate: null }));
    expect(context.document.validUntilDate).toBe("");
    expect(context.org.logoDataUri).toBe("");
  });

  it("fills the real seeded template with real values", () => {
    // The other half of the contract: the key set can be complete and the page still
    // print nothing if the template and the context disagree about a name. This
    // merges the shipped template through the shipped resolver and looks for the
    // values themselves.
    const html = prepareDocumentHtml(seededQuoteTemplate(), buildContext(sampleContextInput()));
    expect(html).toContain("QUO-2026-0001");
    expect(html).toContain("11,000.00");
    expect(html).toContain("13,310.00");
    expect(html).toContain("Jane Smith");
    expect(html).toContain("Consultancy");
    expect(html).toContain("21%");
    expect(html).toContain("NL001234567B01");
    // No merge tokens survive a complete context.
    expect(html).not.toContain("{{");
  });

  it("delivers the largest quote the gate permits, in the worst text a user can write", () => {
    // SV-1's regression, and the reason the constants above are what they are. The
    // old pair (130 lines x 500 characters) was documented as sized against the
    // renderer's 128KB input cap and was not: 130 x 500 ASCII with every optional
    // field maxed and a maxed logo merges to 145,679 bytes, and the same quote in
    // accented text to 210,679. A UI built against those constants would have offered
    // a quote the server refuses -- at roughly half the advertised count for a Dutch
    // or French one, which is the case this test is written in.
    const maxedLogo = `data:image/png;base64,${"A".repeat(MAX_LOGO_DATA_URI_CHARS - 22)}`;
    const accented = "\u00e9".repeat(DOCUMENT_MAX_DESCRIPTION_CHARS);
    const worst = sampleContextInput({
      org: {
        name: "N".repeat(200), addressLines: "A".repeat(2000), vatNumber: "V".repeat(100),
        registrationNumber: "R".repeat(100), email: "E".repeat(200), phone: "P".repeat(100),
        website: "W".repeat(200), bankDetails: "B".repeat(500),
        logoDataUri: maxedLogo, updatedAt: new Date(0).toISOString(),
      },
      recipientName: "\u00e9".repeat(200),
      recipientContactName: "\u00e9".repeat(200),
      recipientAddress: "\u00e9".repeat(2000),
      notes: "\u00e9".repeat(5000),
      terms: "\u00e9".repeat(5000),
      lines: Array.from({ length: DOCUMENT_MAX_LINES }, () => ({
        description: accented, qtyMilli: 1500, unitPriceCents: 5000,
        taxRateBp: 2100, lineTotalCents: 7500,
      })),
    });

    const merged = prepareDocumentHtml(seededQuoteTemplate(), buildContext(worst));
    expect(Buffer.byteLength(merged, "utf8")).toBeLessThanOrEqual(128 * 1024);
    // ...and the gate agrees, so the two cannot part company: the same quote passes
    // the budget the form will show.
    expect(documentContentBytes({
      recipientName: worst.recipientName, recipientContactName: worst.recipientContactName,
      recipientAddress: worst.recipientAddress, notes: worst.notes, terms: worst.terms,
      lines: worst.lines,
    })).toBeLessThanOrEqual(DOCUMENT_CONTENT_BUDGET_BYTES);
  });

  it("prints no logo element when there is no logo", () => {
    const html = prepareDocumentHtml(seededQuoteTemplate(), buildContext(sampleContextInput()));
    expect(html).not.toContain("<img");
    const sample = sampleContextInput();
    const withLogo = prepareDocumentHtml(seededQuoteTemplate(), buildContext({
      ...sample, org: { ...sample.org, logoDataUri: LOGO_DATA_URI },
    }));
    expect(withLogo).toContain("<img");
  });
});

// ---------------------------------------------------------- THE CENTRAL CLAIM

describe("an issued quote never changes", () => {
  /**
   * THE PHASE'S DEFINITION OF DONE. Everything else here is a convenience; this is
   * the promise: a quote you have sent does not change because somebody edited the
   * deal afterwards.
   *
   * IT COMPARES STORED BYTES AND NEVER RE-RENDERS, which is not a stylistic choice.
   * The renderer is not byte-reproducible -- three runs of identical input measured
   * 6899, 6899 and 6898 bytes -- so a re-render-and-diff test would fail for reasons
   * that have nothing to do with immutability, and would pass for reasons that have
   * nothing to do with it either.
   *
   * THE TEMPLATE UPDATE IS ASSERTED TO HAVE HIT A ROW. truncateAll() destroys the
   * seeded template, so an UPDATE written the obvious way updates zero rows, the
   * "changed" template is the same template, and this test proves nothing while
   * looking like the most important test in the repo.
   */
  it("survives the company being renamed, the deal being repriced and the template rewritten", async () => {
    const before = await issueWithStub();
    const pdfBefore = await readStoredPdf(before.fileId);
    const rendersSoFar = renderCount();
    expect(rendersSoFar).toBe(1);

    const renamed = await handle.db.update(companies).set({ name: "Renamed Ltd" })
      .where(eq(companies.id, companyId)).returning();
    const repriced = await handle.db.update(deals).set({ valueCents: 999_999 })
      .where(eq(deals.id, dealId)).returning();
    const rewritten = await handle.db.update(documentTemplates)
      .set({ bodyHtml: "<p>totally different</p>" })
      .where(eq(documentTemplates.type, "quote")).returning();
    // Each edit must have landed, or this test is three no-ops.
    expect(renamed).toHaveLength(1);
    expect(repriced).toHaveLength(1);
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]!.bodyHtml).toBe("<p>totally different</p>");

    const [after] = await listDocuments(handle.db, dealId);
    expect(after).toEqual(before);
    expect(await readStoredPdf(after!.fileId)).toEqual(pdfBefore);

    // THE CLAIM IN ITS STRONG FORM. Identical bytes alone would also hold for code
    // that re-rendered and threw the result away -- both reads open the same
    // content-addressed path. Counting the spawns is what says nothing re-rendered;
    // the varying bytes below are the independent second assertion.
    expect(renderCount()).toBe(rendersSoFar);
  });

  it("and the byte comparison above is not a tautology: the renderer varies", async () => {
    // The control for the test above. If the stub emitted constant bytes, "identical
    // PDF" would hold even for code that re-rendered on every read. Two quotes of
    // the SAME input through the SAME renderer must differ, or that assertion is
    // measuring the stub.
    const first = await issueWithStub();
    const second = await issueWithStub();
    expect(await readStoredPdf(first.fileId)).not.toEqual(await readStoredPdf(second.fileId));
  });

  it("keeps the recipient the company was called at the time", async () => {
    const before = await issueWithStub();
    await handle.db.update(companies).set({ name: "Renamed Ltd" }).where(eq(companies.id, companyId));
    const [after] = await listDocuments(handle.db, dealId);
    expect(after?.recipientName).toBe("Acme Manufacturing BV");
    expect(after?.number).toBe(before.number);
  });

  it("is still there, unchanged, after the deal is archived", async () => {
    // The commonest thing that happens to a deal a quote was raised on. A document
    // outlives its deal's lifecycle: issuing is refused on an archived deal, reading
    // is not, and the row is untouched either way.
    const before = await issueWithStub();
    const pdfBefore = await readStoredPdf(before.fileId);
    const renders = renderCount();

    const archived = await handle.db.update(deals).set({ archivedAt: new Date() })
      .where(eq(deals.id, dealId)).returning();
    expect(archived).toHaveLength(1);

    const [after] = await listDocuments(handle.db, dealId);
    expect(after).toEqual(before);
    expect(await readStoredPdf(after!.fileId)).toEqual(pdfBefore);
    expect(renderCount()).toBe(renders);
  });

  it("does not change when the ISSUER is edited, which the row could not record anyway", async () => {
    // Worth being explicit about, because the two halves differ. The PDF carries the
    // issuer's name, address, VAT number and logo, and it does not change. The
    // `documents` ROW never held them: there is no issuer snapshot on it at all, so a
    // listing can only ever say who a quote went TO, never who it came FROM. That is
    // consistent with "the PDF is the artifact, the row is the record" -- and it is a
    // real limit, because renaming the company you trade as makes every historical
    // quote's issuer unrecoverable without opening its PDF.
    await saveOrgProfile(handle.db, {
      name: "Listerdale Life Sciences", addressLines: "1 High St", vatNumber: "NL001234567B01",
      registrationNumber: "12345678", email: "hello@listerdale.test", phone: "+31 20 123 4567",
      website: "listerdale.test", bankDetails: "NL00 BANK 0123 4567 89", logoDataUri: "",
    });
    const before = await issueWithStub();
    const pdfBefore = await readStoredPdf(before.fileId);
    const renders = renderCount();

    await saveOrgProfile(handle.db, {
      name: "Someone Else BV", addressLines: "9 Other Road", vatNumber: "NL999999999B99",
      registrationNumber: "99999999", email: "no@example.test", phone: "",
      website: "", bankDetails: "", logoDataUri: LOGO_DATA_URI,
    });
    expect((await getOrgProfile(handle.db)).name).toBe("Someone Else BV");

    const [after] = await listDocuments(handle.db, dealId);
    expect(after).toEqual(before);
    expect(await readStoredPdf(after!.fileId)).toEqual(pdfBefore);
    expect(renderCount()).toBe(renders);
  });

  it("leaves the first quote alone when a second is raised on the same deal", async () => {
    // A corrected quote is a NEW quote with a new number (the spec's decision), so
    // this is the path a user actually takes when something was wrong -- and the
    // first one has to survive it intact, since it is the one already in somebody's
    // inbox.
    const first = await issueWithStub();
    const firstPdf = await readStoredPdf(first.fileId);

    const second = await issueWithStub(varyingPdf(), quoteInput({
      recipientName: "Acme Manufacturing BV",
      lines: [{ description: "Widget, corrected", qtyMilli: 3000, unitPriceCents: 5000, taxRateBp: 2100 }],
    }));
    expect(second.number).toBe("QUO-2026-0002");

    const listed = await listDocuments(handle.db, dealId);
    expect(listed).toHaveLength(2);
    expect(listed.find((doc) => doc.number === first.number)).toEqual(first);
    expect(await readStoredPdf(first.fileId)).toEqual(firstPdf);
    // Two documents, two files, two distinct blobs.
    expect(second.fileId).not.toBe(first.fileId);
  });
});

// ------------------------------------------------------------- listDocuments

describe("listDocuments", () => {
  it("returns nothing for a deal with no documents", async () => {
    expect(await listDocuments(handle.db, dealId)).toEqual([]);
  });

  it("returns each document newest first, with its lines in position order", async () => {
    const first = await issueWithStub(varyingPdf(), quoteInput({
      lines: [
        { description: "A", qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0 },
        { description: "B", qtyMilli: 1000, unitPriceCents: 200, taxRateBp: 0 },
      ],
    }));
    const second = await issueWithStub();

    const listed = await listDocuments(handle.db, dealId);
    expect(listed.map((doc) => doc.number)).toEqual([second.number, first.number]);
    expect(listed[1]?.lines.map((line) => line.description)).toEqual(["A", "B"]);
  });

  it("does not return another deal's documents", async () => {
    await issueWithStub();
    const pipeline = await createPipeline(handle.db, actorId, { name: "Other", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "New" });
    const other = await createDeal(
      handle.db, actorId, { title: "Other deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    expect(await listDocuments(handle.db, other.id)).toEqual([]);
  });
});

// ------------------------------------------------- the real renderer, gated

describe("issueQuote against the real WeasyPrint", () => {
  itReal("renders the seeded template into a one-page PDF with the issuer's logo on it", async () => {
    // The filled render Task 2 left for this task: the real template, the real
    // buildContext and the real binary in one place. A one-page PDF at eight line
    // items is what the seed was tuned for after a review round found every filled
    // quote of six lines or more stranding its footer on a second page.
    await saveOrgProfile(handle.db, {
      name: "Listerdale Life Sciences", addressLines: "1 High St\n1015 CJ Amsterdam",
      vatNumber: "NL001234567B01", registrationNumber: "12345678",
      email: "hello@listerdale.test", phone: "+31 20 123 4567",
      website: "listerdale.test", bankDetails: "NL00 BANK 0123 4567 89",
      logoDataUri: LOGO_DATA_URI,
    });

    const doc = await issueQuote(handle.db, { dataDir }, actorId, dealId, quoteInput({
      lines: Array.from({ length: 8 }, (_, i) => ({
        description: `Consultancy, phase ${String(i + 1)}`,
        qtyMilli: 2000, unitPriceCents: 125_000, taxRateBp: 2100,
      })),
    }));

    expect(doc.number).toBe("QUO-2026-0001");
    expect(doc.totalCents).toBe(2_420_000);
    const pdf = await readStoredPdf(doc.fileId);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
    // The logo arrived as a data: URI and became an image XObject, which is the
    // observable end of the org profile -> buildContext -> template -> renderer path.
    expect(pdfHasImage(pdf)).toBe(true);
    // Bytes vary between runs and versions (16,117 on the server's 57.2, 12,521 on
    // CI's 61.1 for the same page), so the assertion is a band, not a number.
    expect(pdf.length).toBeGreaterThan(5000);
  }, 30_000);

  itReal("renders a quote from an install that has filled in nothing", async () => {
    // The state every new install is in. The seeded template wraps each optional
    // field in a conditional precisely so this does not print an empty <img> and a
    // row of labels over blanks.
    expect(await getOrgProfile(handle.db)).toMatchObject({ name: "", logoDataUri: "" });
    const doc = await issueQuote(handle.db, { dataDir }, actorId, dealId, quoteInput({
      validUntilDate: null, recipientContactName: "", recipientAddress: "", notes: "", terms: "",
    }));

    const pdf = await readStoredPdf(doc.fileId);
    expect(pageCount(pdf)).toBe(1);
    expect(pdfHasImage(pdf)).toBe(false);
  }, 30_000);
});

