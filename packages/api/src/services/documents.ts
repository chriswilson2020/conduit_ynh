import { Readable } from "node:stream";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  documentTemplateInputSchema, documentTotals, formatMoneyCents, formatQtyMilli,
  documentContentBytes, formatTaxRateBp, issueQuoteInputSchema, lineTotalCents,
  MAX_TEMPLATE_BYTES, RENDER_INPUT_CAP_BYTES,
  type DocumentRecord, type DocumentTemplate, type DocumentTemplateInput,
  type IssueQuoteInput, type OrgProfile,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  deals, documentLineItems, documents, documentTemplates,
  type DocumentLineItemRow, type DocumentRow,
} from "../db/schema.js";
import { allocateNumber } from "./documents-number.js";
import { renderPdf } from "./documents-render.js";
import {
  documentTemplateErrors, documentTemplateWarnings, prepareDocumentHtml,
  sanitizeDocumentHtml, type MergeContext,
} from "./documents-template.js";
import { getOrgProfile } from "./org-profile.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { ArchivedError, NotFoundError } from "./errors.js";
import { publish } from "./sse.js";

/**
 * Raised when the submitted quote is not one -- a negative quantity, a 150% tax rate,
 * a line description longer than a page, totals that no column can represent.
 *
 * THIS EXISTS BECAUSE THE SERVICE IS A GATE AND NOT ONLY THE ROUTE. `money.ts`
 * deliberately keeps a wider domain than `document_line_items`' three CHECK
 * constraints -- `divideRoundHalfUp` has a negative branch so a future credit note
 * rounds correctly -- so a negative quantity computes a total, RENDERS A PDF, and
 * then dies on the INSERT as a 23514: an opaque 500 raised after a subprocess has
 * already run, for a value the form said was fine. All three constraints were
 * reproduced end to end in exactly that shape. The route parses the same schema and
 * answers 400 before ever calling in here; this is what makes the bound true for a
 * direct service caller too, and it runs before anything spawns.
 */
export class DocumentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentInputError";
  }
}

/**
 * Raised when the merged document is larger than a render will accept.
 *
 * **THIS IS THE AUTHORITATIVE SIZE CHECK, AND THE INPUT GATE IS NOT.**
 * `documentContentBytes` predicts a merged size from the submission, and a prediction
 * can be wrong in at least four ways that were all demonstrated: a `"` costs one byte
 * in text and six in an attribute, the issuer's reserve was unenforced, a character
 * cap on the template did not bound its bytes, and a template may print a field more
 * than once. Measuring the merged output is exact, costs one `Buffer.byteLength`, and
 * happens where the failure can still be attributed to a field -- one layer above
 * renderPdf's identical cap, which stays as the module's own guard for every other
 * caller.
 *
 * It fires after the number is allocated (the number is printed on the page, so the
 * merge needs it) and before anything spawns, so it rolls back exactly like a failed
 * render: no number spent, no file, no document.
 */
export class DocumentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentTooLargeError";
  }
}

/** Raised when the quote template row is missing. Migration 0009 seeds it, so this
 * means somebody deleted it -- recoverable by pasting a body back into Settings, and
 * emphatically not a 500 with no explanation. */
export class DocumentTemplateMissingError extends Error {
  constructor(type: string) {
    super(`no ${type} template exists; add one in Settings`);
    this.name = "DocumentTemplateMissingError";
  }
}

export interface IssueQuoteDeps {
  /** Where blobs live (config.dataDir) -- the rendered PDF is stored like any other
   * file, so it downloads through the existing GET /api/files/:id/download. */
  dataDir: string;
}

function toDocumentRecord(row: DocumentRow, lines: DocumentLineItemRow[]): DocumentRecord {
  return {
    id: row.id,
    number: row.number,
    // The column is `text` with a CHECK rather than an enum, so the cast is where
    // the CHECK's promise is cashed into the shared union.
    type: row.type as DocumentRecord["type"],
    dealId: row.dealId,
    fileId: row.fileId,
    currency: row.currency,
    issueDate: row.issueDate,
    validUntilDate: row.validUntilDate,
    recipientName: row.recipientName,
    recipientContactName: row.recipientContactName,
    recipientAddress: row.recipientAddress,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    notes: row.notes,
    terms: row.terms,
    issuedByUserId: row.issuedByUserId,
    createdAt: row.createdAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      position: line.position,
      description: line.description,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      taxRateBp: line.taxRateBp,
      lineTotalCents: line.lineTotalCents,
    })),
  };
}

/** Everything the template is allowed to print, before any of it is a string. */
export interface QuoteContextInput {
  org: OrgProfile;
  currency: string;
  number: string;
  issueDate: string;
  validUntilDate: string | null;
  recipientName: string;
  recipientContactName: string;
  recipientAddress: string;
  notes: string;
  terms: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lines: {
    description: string;
    qtyMilli: number;
    unitPriceCents: number;
    taxRateBp: number;
    lineTotalCents: number;
  }[];
}

/**
 * The merge context for one quote: every value the template can name, already a
 * string.
 *
 * THE KEY SET IS A CONTRACT AND IT IS TESTED AS ONE. An unknown merge field resolves
 * to "" and never throws (that is Task 3's rule, and the right one -- a typo in a
 * template must be a blank on a page rather than a failed render an hour before a
 * quote is due). The cost of that rule is that supplying `document.subTotal` for the
 * template's `{{document.subtotal}}` is INVISIBLE: every test stays green and the
 * printed quote has a blank where a total should be. `documents.test.ts` therefore
 * asserts this function's actual key set against the tokens read out of the seeded
 * template itself, which is the only assertion that connects the two.
 *
 * Formatting happens here rather than in the template because the template language
 * has no expressions, and it uses @conduit/shared's formatters rather than local ones
 * so the quote form's running total and this page cannot disagree about a locale.
 */
export function buildContext(input: QuoteContextInput): MergeContext {
  const money = (cents: number): string => formatMoneyCents(cents, input.currency);
  return {
    org: {
      name: input.org.name,
      addressLines: input.org.addressLines,
      email: input.org.email,
      phone: input.org.phone,
      website: input.org.website,
      bankDetails: input.org.bankDetails,
      vatNumber: input.org.vatNumber,
      registrationNumber: input.org.registrationNumber,
      logoDataUri: input.org.logoDataUri,
    },
    document: {
      number: input.number,
      issueDate: input.issueDate,
      validUntilDate: input.validUntilDate ?? "",
      recipientName: input.recipientName,
      recipientContactName: input.recipientContactName,
      recipientAddress: input.recipientAddress,
      subtotal: money(input.subtotalCents),
      tax: money(input.taxCents),
      total: money(input.totalCents),
      notes: input.notes,
      terms: input.terms,
    },
    lines: input.lines.map((line) => ({
      description: line.description,
      qty: formatQtyMilli(line.qtyMilli),
      unitPrice: money(line.unitPriceCents),
      taxRate: formatTaxRateBp(line.taxRateBp),
      lineTotal: money(line.lineTotalCents),
    })),
  };
}

/**
 * Issue a quote. ONE TRANSACTION: read the template and the issuer, allocate the
 * number, merge, render, write the blob, insert the file, insert the document and its
 * lines.
 *
 * THE ORDER IS THE DESIGN, AND THE TRANSACTION IS WHAT MAKES IT SAFE.
 *
 * The number has to exist before the render because it is PRINTED on the page, and a
 * render that then fails must not spend it -- a quote numbering sequence with holes
 * invites the question of what was in the hole. `nextval()` cannot help: it is
 * explicitly non-transactional and a rollback does not give the number back. A table
 * row does, which is why `document_number_sequences` is a table.
 *
 * The template and the issuer are read BEFORE the allocation rather than after,
 * because the allocation's ON CONFLICT takes a row lock held to commit and there is
 * no reason to read two more rows inside it. What the lock does cover is the merge,
 * the render and the inserts -- about a second, of which ~600-700ms is the render of
 * a one-page quote (Task 1, on the server's WeasyPrint 57.2) and 20s is the timeout
 * that bounds the worst case.
 *
 * THE BLOB WRITE IS THE ONE PART THAT CANNOT ROLL BACK, and that is deliberate rather
 * than overlooked. Blobs are content-addressed by sha256, so an orphan is unreferenced
 * bytes on disk rather than a visible document; the alternative -- commit, then write,
 * then hope -- can leave a `documents` row whose PDF does not exist, which is a broken
 * record rather than a wasted one. Writing before the commit also means the file that
 * the `files` row names is already there when anybody can see the row.
 *
 * Everything that can fail with the caller's fault attached fails BEFORE the spawn:
 * the input gate, the deal's existence and archived state, the template's existence.
 */
export async function issueQuote(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  dealId: string,
  input: IssueQuoteInput,
): Promise<DocumentRecord> {
  const parsed = issueQuoteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentInputError(parsed.error.issues[0]?.message ?? "invalid quote");
  }
  const quote = parsed.data;
  // Cannot throw: the schema above ran the same arithmetic and rejected anything it
  // refuses. Computed out here so the row lock is not held across it.
  const totals = documentTotals(quote.lines);
  const lines = quote.lines.map((line) => ({ ...line, lineTotalCents: lineTotalCents(line) }));
  const year = Number(quote.issueDate.slice(0, 4));

  const record = await db.transaction(async (tx) => {
    // THE LOCK HOLD IS BOUNDED; THE LOCK **WAIT** WAS NOT, and they are different
    // sentences. Two quotes of the same type and year serialise on one row, and each
    // holds it for up to the render queue timeout plus the render timeout -- so N
    // callers queue at roughly N x 30s with nothing to stop them: there is no
    // `lock_timeout`, no `statement_timeout` and no Fastify `requestTimeout` in this
    // deployment, and the pool tops out at ten. The 503 on a busy renderer covers the
    // render queue, not this queue.
    //
    // 45s is one full worst-case hold plus slack, so an ordinary second quote still
    // waits its turn and a pile-up fails with 55P03 rather than occupying a
    // connection indefinitely. SET LOCAL, so it lasts exactly this transaction.
    await tx.execute(sql`SET LOCAL lock_timeout = '45s'`);
    const [deal] = await tx.select({ currency: deals.currency, archivedAt: deals.archivedAt })
      .from(deals).where(eq(deals.id, dealId));
    if (deal === undefined) throw new NotFoundError("deal", dealId);
    if (deal.archivedAt !== null) throw new ArchivedError("deal", dealId);

    const [template] = await tx.select({ bodyHtml: documentTemplates.bodyHtml })
      .from(documentTemplates).where(eq(documentTemplates.type, "quote"));
    if (template === undefined) throw new DocumentTemplateMissingError("quote");

    // The logo arrives with the row: it is a data: URI column, not a file this
    // transaction has to open (see org-profile.ts).
    const org = await getOrgProfile(tx);

    const number = await allocateNumber(tx, "quote", year);
    const html = prepareDocumentHtml(template.bodyHtml, buildContext({
      org, currency: deal.currency, number,
      issueDate: quote.issueDate,
      validUntilDate: quote.validUntilDate ?? null,
      recipientName: quote.recipientName,
      recipientContactName: quote.recipientContactName ?? "",
      recipientAddress: quote.recipientAddress ?? "",
      notes: quote.notes ?? "",
      terms: quote.terms ?? "",
      ...totals,
      lines,
    }));
    const mergedBytes = Buffer.byteLength(html, "utf8");
    if (mergedBytes > RENDER_INPUT_CAP_BYTES) {
      throw new DocumentTooLargeError(
        `this quote merges to ${String(mergedBytes)} bytes, over the `
        + `${String(RENDER_INPUT_CAP_BYTES)} a document may render. Its template is `
        + `${String(Buffer.byteLength(template.bodyHtml, "utf8"))} bytes, its logo `
        + `${String(org.logoDataUri.length)}, and its own content `
        + `${String(documentContentBytes(quote))}; shorten whichever of those you can`,
      );
    }
    const pdf = await renderPdf(html);

    const { sha256, sizeBytes } = await saveBlob(deps.dataDir, Readable.from([pdf]));
    // Reused rather than reimplemented: this is the one place a `files` row is
    // created, and it also stamps the `file_attached` timeline entry and re-checks
    // the deal. Called with `tx`, so its own transaction is a savepoint inside this
    // one and the row disappears with a rollback like everything else here.
    const file = await attachFile(tx, actorId, {
      originalName: `${number}.pdf`, mime: "application/pdf", sizeBytes, sha256, dealId,
    });

    const [row] = await tx.insert(documents).values({
      number, type: "quote", dealId, fileId: file.id, currency: deal.currency,
      issueDate: quote.issueDate,
      validUntilDate: quote.validUntilDate ?? null,
      recipientName: quote.recipientName,
      recipientContactName: quote.recipientContactName ?? "",
      recipientAddress: quote.recipientAddress ?? "",
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      notes: quote.notes ?? "",
      terms: quote.terms ?? "",
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    const lineRows = await tx.insert(documentLineItems).values(lines.map((line, index) => ({
      documentId: row.id, position: index + 1,
      description: line.description, qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents, taxRateBp: line.taxRateBp,
      lineTotalCents: line.lineTotalCents,
    }))).returning();

    // Sorted rather than trusted: `returning()` promises no particular order, and
    // this DTO is compared field for field against the one listDocuments builds (in
    // position order) by the immutability test.
    return toDocumentRecord(row, [...lineRows].sort((a, b) => a.position - b.position));
  });

  publish({ keys: [["documents", dealId], ["files"], ["events"]] });
  return record;
}

/**
 * The editable template for a document type, with what the merge language will do to
 * it silently.
 *
 * SEEDED BY MIGRATION 0009, so the row is there before anyone opens Settings -- but
 * it can be deleted, and a service that answered a 404 would make an editor with
 * nothing to edit and no way to create one. An absent row reads as the empty body a
 * PUT can then replace, which is the same shape getOrgProfile uses and for the same
 * reason.
 */
export async function getDocumentTemplate(db: Database, type: string): Promise<DocumentTemplate> {
  const [row] = await db.select().from(documentTemplates)
    .where(eq(documentTemplates.type, type));
  if (row === undefined) {
    return {
      type: type as DocumentTemplate["type"], bodyHtml: "", warnings: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    type: row.type as DocumentTemplate["type"],
    bodyHtml: row.bodyHtml,
    warnings: documentTemplateWarnings(row.bodyHtml),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Replace a type's template.
 *
 * SANITISED ON SAVE, and that is belt rather than braces: `prepareDocumentHtml`
 * sanitises AFTER merging, which is the order that matters and the only one that can
 * see a merged value. Sanitising here as well means what Settings shows back is what
 * will be used, so a stripped `<script>` is visible at the moment somebody pastes it
 * rather than silently absent from a PDF weeks later. The profile is idempotent, so
 * the second pass at issue time changes nothing.
 *
 * A body that sanitises away to nothing is refused rather than stored, mirroring
 * mail-templates.ts: the row exists so a quote renders, and a template that renders
 * as a blank page with a number on it is not one.
 */
export async function saveDocumentTemplate(
  db: Database, type: string, input: DocumentTemplateInput,
): Promise<DocumentTemplate> {
  const parsed = documentTemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentInputError(parsed.error.issues[0]?.message ?? "invalid template");
  }
  const bodyHtml = sanitizeDocumentHtml(parsed.data.bodyHtml);
  if (bodyHtml.trim() === "") {
    throw new DocumentInputError(
      "the template is empty once sanitised; it contained no markup the document profile keeps",
    );
  }
  // SANITISE, THEN MEASURE. The other order was wrong twice: the sanitiser can GROW a
  // body (16,384 characters of raw `\"` inside a single-quoted attribute store as
  // 97,546 -- 5.95x), so a length checked before it does not bound what is stored, and
  // a body that came back from GET could then be refused by PUT as too long. What is
  // measured here is what the column holds and what a render will carry.
  const templateBytes = Buffer.byteLength(bodyHtml, "utf8");
  if (templateBytes > MAX_TEMPLATE_BYTES) {
    throw new DocumentInputError(
      `the template is ${String(templateBytes)} bytes once sanitised, over the `
      + `${String(MAX_TEMPLATE_BYTES)} a template may use`,
    );
  }
  // Refused rather than warned about: a block nested inside itself multiplies its
  // body by the collection's length per level, and storing one produces a template
  // every later quote fails on. See documents-template.ts's parse().
  const errors = documentTemplateErrors(bodyHtml);
  if (errors.length > 0) throw new DocumentInputError(errors[0]!);
  const updatedAt = new Date();
  const [row] = await db.insert(documentTemplates).values({ type, bodyHtml, updatedAt })
    .onConflictDoUpdate({ target: documentTemplates.type, set: { bodyHtml, updatedAt } })
    .returning();
  if (row === undefined) throw new Error("template upsert returned no row");
  publish({ keys: [["document-templates"]] });
  return {
    type: row.type as DocumentTemplate["type"],
    bodyHtml: row.bodyHtml,
    warnings: documentTemplateWarnings(row.bodyHtml),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every document raised against a deal, newest first, each with its frozen lines.
 *
 * NOT RECOMPUTED FROM THE LINES: the stored totals are what was printed, and a later
 * change to the arithmetic must never restate an issued document. The rows are read
 * back exactly as they were written.
 */
export async function listDocuments(db: Database, dealId: string): Promise<DocumentRecord[]> {
  const rows = await db.select().from(documents)
    .where(eq(documents.dealId, dealId))
    .orderBy(desc(documents.createdAt), desc(documents.id));
  if (rows.length === 0) return [];
  const lineRows = await db.select().from(documentLineItems)
    .where(inArray(documentLineItems.documentId, rows.map((row) => row.id)))
    .orderBy(asc(documentLineItems.position));
  return rows.map((row) => toDocumentRecord(
    row, lineRows.filter((line) => line.documentId === row.id),
  ));
}
