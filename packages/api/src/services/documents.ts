import { Readable } from "node:stream";
import { asc, desc, eq, inArray } from "drizzle-orm";
import {
  documentTotals, formatMoneyCents, formatQtyMilli, formatTaxRateBp, issueQuoteInputSchema,
  lineTotalCents, type DocumentRecord, type IssueQuoteInput, type OrgProfile,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  deals, documentLineItems, documents, documentTemplates,
  type DocumentLineItemRow, type DocumentRow,
} from "../db/schema.js";
import { allocateNumber } from "./documents-number.js";
import { renderPdf } from "./documents-render.js";
import { prepareDocumentHtml, type MergeContext } from "./documents-template.js";
import { getOrgProfile, orgLogoDataUri } from "./org-profile.js";
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
  logoDataUri: string;
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
      logoDataUri: input.logoDataUri,
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
    const [deal] = await tx.select({ currency: deals.currency, archivedAt: deals.archivedAt })
      .from(deals).where(eq(deals.id, dealId));
    if (deal === undefined) throw new NotFoundError("deal", dealId);
    if (deal.archivedAt !== null) throw new ArchivedError("deal", dealId);

    const [template] = await tx.select({ bodyHtml: documentTemplates.bodyHtml })
      .from(documentTemplates).where(eq(documentTemplates.type, "quote"));
    if (template === undefined) throw new DocumentTemplateMissingError("quote");

    const org = await getOrgProfile(tx);
    const logoDataUri = await orgLogoDataUri(tx, deps.dataDir, org.logoFileId);

    const number = await allocateNumber(tx, "quote", year);
    const html = prepareDocumentHtml(template.bodyHtml, buildContext({
      org, logoDataUri, currency: deal.currency, number,
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
