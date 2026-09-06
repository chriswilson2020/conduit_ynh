import { Readable } from "node:stream";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agreementContentBytes, documentTemplateInputSchema, documentTotals, documentTypeFreezes,
  formatDocumentInstant, formatMoneyCents, formatQtyMilli,
  documentContentBytes, formatTaxRateBp, issueAgreementInputSchema, issueLetterInputSchema,
  issueQuoteInputSchema, lineTotalCents,
  MAX_TEMPLATE_BYTES, PROJECT_STATUS_LABEL, redraftLetterInputSchema, renderInputCost,
  RENDER_IMAGE_CAP_BYTES,
  RENDER_IMAGE_PIXEL_CAP, RENDER_MARKUP_CAP_BYTES, TASK_STATUS_LABEL, todayInZone,
  type AgreementRecord, type DocumentRecord, type DocumentTemplate, type DocumentTemplateInput,
  type IssueAgreementInput, type IssueLetterInput, type IssueQuoteInput, type LetterRecord,
  type MeetingSummaryRecord, type OrgProfile, type ProjectStatus, type RecordDocument,
  type RedraftLetterInput, type StatusReportRecord, type TaskStatus,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, documentAgreements, documentLetters, documentLineItems,
  documentQuotes, documents, documentTemplates,
  meetingAttendees, meetings, projects, taskDependencies, tasks, users,
  type DocumentAgreementRow, type DocumentLetterRow, type DocumentLineItemRow,
  type DocumentQuoteRow, type DocumentRow,
} from "../db/schema.js";
import { allocateNumber } from "./documents-number.js";
import { renderPdf } from "./documents-render.js";
import {
  documentTemplateErrors, documentTemplateWarnings, MergeHtml, prepareDocumentHtml,
  sanitizeDocumentHtml, type MergeContext, type MergeTask,
} from "./documents-template.js";
import { parentTasks, taskOutlineOrder } from "./scheduling.js";
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
 * than once. Measuring the merged output is exact, costs one pass over the bytes, and
 * happens where the failure can still be attributed to a field -- one layer above
 * renderPdf's identical caps, which stay as the module's own guard for every other
 * caller.
 *
 * THERE ARE THREE OF THEM SINCE v1.0.1: markup bytes, inline image bytes, and the
 * pixels those images decode to. The third is not derivable from the first two --
 * 12,227 bytes of PNG can be 100 megapixels -- so a size check that counted only
 * bytes would pass a document that costs 535MB to render.
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

/**
 * Raised when somebody asks to change a document that is frozen.
 *
 * **THE ERROR THAT MAKES `documents.frozen` MEAN SOMETHING.** Task 1 added the
 * column and recorded that nothing read it; Task 2 added the first type that
 * answers `false` and still wrote no update path. This is Task 3's, and the
 * spec's fourth risk is what it is for: "the rule that an issued document never
 * changes is currently unconditional; making it conditional is where a mistake
 * would let a quote be edited."
 *
 * IT NAMES THE TYPE, NOT JUST THE ID. "This document is frozen" invites the
 * question "why is THIS one frozen"; "an issued quote cannot be changed" answers
 * it, and the answer is a product rule rather than a database state.
 */
export class DocumentFrozenError extends Error {
  constructor(readonly documentId: string, readonly type: string) {
    super(`an issued ${type.replace(/_/g, " ")} cannot be changed`);
    this.name = "DocumentFrozenError";
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

/**
 * Two rows and their lines, as one DTO -- the shape this API has always returned.
 *
 * THE WIRE SHAPE DID NOT MOVE WHEN THE STORAGE DID, and that is the point of
 * doing the split in its own task. `documents` and `document_quotes` are where a
 * quote lives; `DocumentRecord` is what a quote IS, and nothing about a quote
 * changed in Phase 9. So the client, the CSV header and the e2e specs are
 * untouched, and "an existing quote still opens" is literally true at the HTTP
 * layer rather than approximately true. It becomes a discriminated union when
 * the second type arrives and there is something to discriminate.
 *
 * THE DEAL COMES FROM THE CALLER, NOT FROM `row`, and that is not a convenience.
 * `documents.deal_id` is nullable since 0016 -- a meeting summary will carry
 * meeting_id instead -- while `DocumentRecord.dealId` is not, because a quote is
 * always of a deal and the client renders it. Writing `row.dealId!` or
 * `row.dealId ?? ""` would put a branch here that no caller can reach and no
 * test could exercise: one call site queried BY the deal id and the other is
 * issuing against it, so both have it in hand and passing it makes the narrowing
 * a fact instead of an assertion.
 */
function toDocumentRecord(
  row: DocumentRow, quote: DocumentQuoteRow, lines: DocumentLineItemRow[], dealId: string,
): DocumentRecord {
  // `documents.number` is nullable since 0017 and `DocumentRecord.number` is not,
  // and this is where the two are reconciled. It cannot fire: this function is
  // reached only for a row that HAS a `document_quotes` row (both call sites --
  // issueQuote, which just wrote the pair, and listDocuments' INNER JOIN), and
  // `documents_number_matches_type` says a quote has a number. Throwing rather
  // than `?? ""` because a quote whose number vanished is a broken record and an
  // empty string on a document list is a broken record nobody notices.
  if (row.number === null) {
    throw new Error(`document ${row.id} is a quote with no number, which two CHECKs forbid`);
  }
  return {
    id: row.id,
    number: row.number,
    // The column is `text` with a CHECK rather than an enum, so the cast is where
    // the CHECK's promise is cashed into the shared union.
    type: row.type as DocumentRecord["type"],
    dealId,
    fileId: row.fileId,
    currency: quote.currency,
    issueDate: row.issueDate,
    validUntilDate: quote.validUntilDate,
    recipientName: quote.recipientName,
    recipientContactName: quote.recipientContactName,
    recipientSalutation: quote.recipientSalutation,
    recipientAddress: quote.recipientAddress,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    notes: quote.notes,
    terms: quote.terms,
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
  /** Snapshot at issue, never read live from the contact -- see the column. */
  recipientSalutation: string;
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
/**
 * The letterhead, which is the same nine fields on every type's page.
 *
 * Extracted when the second type arrived rather than copied: the `org` bag is a
 * KEY SET, and the key set is the contract this file's suite checks against the
 * tokens read out of each seeded template. Two copies would be two contracts, and
 * the failure of the second to gain a field somebody added to the first is a
 * blank on a printed page and nothing else.
 */
function orgContext(org: OrgProfile): Record<string, string> {
  return {
    name: org.name,
    addressLines: org.addressLines,
    email: org.email,
    phone: org.phone,
    website: org.website,
    bankDetails: org.bankDetails,
    vatNumber: org.vatNumber,
    registrationNumber: org.registrationNumber,
    logoDataUri: org.logoDataUri,
  };
}

export function buildContext(input: QuoteContextInput): MergeContext {
  const money = (cents: number): string => formatMoneyCents(cents, input.currency);
  return {
    org: orgContext(input.org),
    document: {
      number: input.number,
      issueDate: input.issueDate,
      validUntilDate: input.validUntilDate ?? "",
      recipientName: input.recipientName,
      recipientContactName: input.recipientContactName,
      // NO PRONOUNS KEY, and its absence is the design rather than an oversight: a
      // quote's greeting takes the salutation, and there is no `documents` column to
      // build one from. Mail templates read pronouns live from the contact instead.
      recipientSalutation: input.recipientSalutation,
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
 * A type's editable template body, or the 409 that says somebody deleted it.
 *
 * Read inside the caller's transaction, and read BEFORE anything is allocated or
 * spawned: an install whose template row is gone must fail with a message an
 * operator can act on, having spent nothing.
 */
async function loadTemplateBody(tx: Database, type: string): Promise<string> {
  const [template] = await tx.select({ bodyHtml: documentTemplates.bodyHtml })
    .from(documentTemplates).where(eq(documentTemplates.type, type));
  if (template === undefined) throw new DocumentTemplateMissingError(type);
  return template.bodyHtml;
}

/** What `renderAndStore` needs that differs between one document type and the next. */
interface RenderAndStoreInput {
  /** How the size refusals name this document: "quote", "meeting summary". */
  noun: string;
  templateHtml: string;
  context: MergeContext;
  /** Where the bytes came from, appended to every size refusal. */
  provenance: string;
  /** `files.original_name`, which is what a download is called. */
  originalName: string;
  /**
   * Exactly one, matching the `documents` row this file is about to belong to.
   *
   * ALL FIVE SINCE TASK 4, which added the `projectId` this comment used to
   * name as missing. Spelled as five optional keys rather than as a union
   * because `attachFile` takes exactly this shape and does its own "which one is
   * set" walk over it; a union here would be narrowed once and widened straight
   * back. The thing that makes "exactly one" true is `documents_exactly_one_entity`
   * and `files_exactly_one_entity`, in the database, on both rows -- and since
   * 0020, `documents_entity_matches_type` says which one belongs to which type.
   */
  target: {
    companyId?: string; contactId?: string; dealId?: string;
    meetingId?: string; projectId?: string;
  };
}

/**
 * Merge, check the three render caps, render, store the blob, and make the `files`
 * row -- the part of issuing a document that is the same whatever the type is.
 *
 * EXTRACTED WHEN THE SECOND TYPE ARRIVED, and the three cap checks are the reason
 * rather than the line count. They are the authoritative size gate (see
 * DocumentTooLargeError), they are the only place a size failure can still be
 * attributed to a field, and a second type that reimplemented them would sooner or
 * later implement two of the three -- which is exactly the failure v1.0.1 added the
 * third for: 12,227 bytes of PNG can be 100 megapixels, so a copy that counted only
 * bytes would pass a document costing 535MB to render.
 *
 * THE NOUN IS A PARAMETER AND THE MESSAGES ARE NOT OTHERWISE TOUCHED. A quote's
 * three refusals read exactly as they did in v1.7.2, which is what keeps the route
 * suite's assertions about them meaningful.
 */
async function renderAndStore(
  tx: Database, deps: IssueQuoteDeps, actorId: string, input: RenderAndStoreInput,
) {
  const html = prepareDocumentHtml(input.templateHtml, input.context);
  // THE SAME THREE CAPS renderPdf ENFORCES, one layer up, where the failure can
  // still be attributed to a field. Split the way they are because the answer to
  // "what is too big" is different for each: shorten the text, use a smaller logo
  // FILE, or use a logo with fewer PIXELS -- and the last of those is invisible in
  // a byte count, which is why v1.0.0 could not have said it.
  const cost = renderInputCost(html);
  if (cost.markupBytes > RENDER_MARKUP_CAP_BYTES) {
    throw new DocumentTooLargeError(
      `this ${input.noun} merges to ${String(cost.markupBytes)} bytes of markup, over the `
      + `${String(RENDER_MARKUP_CAP_BYTES)} a document may render. ${input.provenance}; `
      + "shorten whichever of those you can",
    );
  }
  if (cost.imageBytes > RENDER_IMAGE_CAP_BYTES) {
    throw new DocumentTooLargeError(
      `this ${input.noun} carries ${String(cost.imageBytes)} bytes of inline image, over the `
      + `${String(RENDER_IMAGE_CAP_BYTES)} a document may render. ${input.provenance}; `
      + "use a smaller logo, or fewer images in the template",
    );
  }
  if (cost.imagePixels > RENDER_IMAGE_PIXEL_CAP) {
    throw new DocumentTooLargeError(
      `this ${input.noun}'s ${String(cost.images)} inline image(s) decode to `
      + `${String(cost.imagePixels)} pixels, over the `
      + `${String(RENDER_IMAGE_PIXEL_CAP)} a document may render. A file's size does `
      + "not say how large the picture inside it is; use one with fewer pixels"
      + (cost.unreadableImages === 0 ? ""
        : `. ${String(cost.unreadableImages)} of them are not a PNG, JPEG, GIF or `
          + "WEBP at all, and something the renderer cannot be asked to identify is "
          + "charged the most its bytes could decode to"),
    );
  }
  const pdf = await renderPdf(html);

  const { sha256, sizeBytes } = await saveBlob(deps.dataDir, Readable.from([pdf]));
  // Reused rather than reimplemented: this is the one place a `files` row is
  // created, and it also stamps the `file_attached` timeline entry and re-checks
  // the record the file is going on. Called with `tx`, so its own transaction is a
  // savepoint inside this one and the row disappears with a rollback like
  // everything else here.
  return await attachFile(tx, actorId, {
    originalName: input.originalName, mime: "application/pdf", sizeBytes, sha256,
    ...input.target,
  });
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

    const templateHtml = await loadTemplateBody(tx, "quote");

    // The logo arrives with the row: it is a data: URI column, not a file this
    // transaction has to open (see org-profile.ts).
    const org = await getOrgProfile(tx);

    const number = await allocateNumber(tx, "quote", year);
    const file = await renderAndStore(tx, deps, actorId, {
      noun: "quote",
      templateHtml,
      context: buildContext({
        org, currency: deal.currency, number,
        issueDate: quote.issueDate,
        validUntilDate: quote.validUntilDate ?? null,
        recipientName: quote.recipientName,
        recipientContactName: quote.recipientContactName ?? "",
        recipientSalutation: quote.recipientSalutation ?? "",
        recipientAddress: quote.recipientAddress ?? "",
        notes: quote.notes ?? "",
        terms: quote.terms ?? "",
        ...totals,
        lines,
      }),
      provenance: "Its template is "
        + `${String(Buffer.byteLength(templateHtml, "utf8"))} bytes, its logo `
        + `${String(org.logoDataUri.length)}, and its own content `
        + `${String(documentContentBytes(quote))}`,
      originalName: `${number}.pdf`,
      target: { dealId },
    });

    // TWO INSERTS SINCE 0016, in the same transaction as everything else here.
    // The common row first, because document_quotes.document_id references it.
    const [row] = await tx.insert(documents).values({
      number, type: "quote", dealId, fileId: file.id,
      issueDate: quote.issueDate,
      // WRITTEN, NOT DEFAULTED. The column has no DEFAULT (0016 drops the one it
      // used to backfill existing rows), so this value is the only thing that
      // can fill it, and documents_frozen_matches_type refuses the row if it
      // disagrees with the type. That is what keeps the rule in @conduit/shared
      // and the rule in the database from drifting: getting this wrong is a
      // failed INSERT, not a quote somebody can edit.
      frozen: documentTypeFreezes("quote"),
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    const [quoteRow] = await tx.insert(documentQuotes).values({
      documentId: row.id, currency: deal.currency,
      validUntilDate: quote.validUntilDate ?? null,
      recipientName: quote.recipientName,
      recipientContactName: quote.recipientContactName ?? "",
      // THE SNAPSHOT. Written from the submission, which the form defaulted from the
      // contact -- never joined at read time, or a title corrected next year would
      // rewrite the greeting on a quote sent last year.
      recipientSalutation: quote.recipientSalutation ?? "",
      recipientAddress: quote.recipientAddress ?? "",
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      notes: quote.notes ?? "",
      terms: quote.terms ?? "",
    }).returning();
    if (quoteRow === undefined) throw new Error("document_quotes insert returned no row");

    const lineRows = await tx.insert(documentLineItems).values(lines.map((line, index) => ({
      documentId: row.id, position: index + 1,
      description: line.description, qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents, taxRateBp: line.taxRateBp,
      lineTotalCents: line.lineTotalCents,
    }))).returning();

    // Sorted rather than trusted: `returning()` promises no particular order, and
    // this DTO is compared field for field against the one listDocuments builds (in
    // position order) by the immutability test.
    return toDocumentRecord(
      row, quoteRow, [...lineRows].sort((a, b) => a.position - b.position), dealId,
    );
  });

  publish({ keys: [["documents", dealId], ["files"], ["events"]] });
  return record;
}

/* ========================================================================== *
 *  THE MEETING SUMMARY -- THE TYPE WITH NO FORM
 * ========================================================================== */

/** Everything the meeting summary template is allowed to print. */
export interface MeetingSummaryContextInput {
  org: OrgProfile;
  /** The day the summary was produced, which is not the day of the meeting. */
  issueDate: string;
  title: string;
  /** The meeting's own moment, as an ISO instant. */
  occurredAt: string;
  durationMinutes: number | null;
  /**
   * The meeting's notes, ALREADY SANITISED WITH THE DOCUMENT PROFILE. It arrives
   * here as markup and leaves as markup -- see `buildMeetingSummaryContext`.
   */
  notesHtml: string;
  /** One display name per attendee, in the order the summary prints them. */
  attendees: string[];
}

/**
 * How long a meeting took, as a page says it.
 *
 * PLAIN MINUTES, and "90 minutes" rather than "1 hour 30 minutes" is a decision
 * and not laziness: an hours-and-minutes rendering needs a pluralisation rule, a
 * separator convention and a choice about "1 hour 0 minutes", all of which are
 * invented formatting for a field the operator typed as a number of minutes in
 * the first place. The label beside it says Duration.
 */
function formatDurationMinutes(minutes: number): string {
  return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The merge context for one meeting summary.
 *
 * **`notes` IS THE ONLY `MergeHtml` IN THIS FILE, AND IT IS WHY THAT TYPE EXISTS.**
 * `meetings.notes` is TipTap rich text -- markup, written by the operator, stored
 * as HTML -- so escaping it like every other merge value would print `<p>Agreed
 * to</p>` as those characters on a page. The Phase 9 spec says the notes "go
 * through the existing sanitiser rather than a new path", and this is that: the
 * caller passes the fragment through `sanitizeDocumentHtml` before it gets here,
 * and `prepareDocumentHtml` sanitises the whole merged page afterwards. Two
 * passes, because they answer different questions -- the first because the
 * fragment was stored under the MAIL profile, which allows and forbids a
 * different set; the second because a fragment can leave a tag open and only a
 * pass over the finished document can close it.
 *
 * THE TITLE IS NOT RAW and neither is anything else here. A meeting title is
 * plain text in a text input; escaped, a title of `<b>Q3</b>` prints as itself
 * rather than restructuring the page.
 *
 * NO `number` KEY, so a template that names `{{document.number}}` prints a blank
 * -- which is the correct outcome for a type that has none, and is what the
 * merge language's unknown-path rule gives for free.
 */
export function buildMeetingSummaryContext(input: MeetingSummaryContextInput): MergeContext {
  return {
    org: orgContext(input.org),
    document: {
      title: input.title,
      // THE ORGANISATION'S CLOCK, off the profile that is already in this context
      // for the letterhead. Not a separate argument to this builder: the zone is a
      // property of the issuer exactly as the address and the VAT number are, and
      // a second parameter would be a second place for Tasks 3 and 4 to disagree
      // about where it comes from.
      meetingWhen: formatDocumentInstant(input.occurredAt, input.org.timeZone),
      duration: input.durationMinutes === null ? "" : formatDurationMinutes(input.durationMinutes),
      issueDate: input.issueDate,
      notes: new MergeHtml(input.notesHtml),
    },
    // A summary has no priced lines, and `{{#lines}}` in a summary template
    // therefore renders nothing. Empty rather than absent because MergeContext
    // requires it, and requiring it is what keeps every existing quote context
    // honest.
    lines: [],
    attendees: input.attendees.map((name) => ({ name })),
  };
}

/**
 * Every attendee of one meeting, as a name a page can print, in a stable order.
 *
 * THE THREE FORMS, AND THE PRECEDENCE IS export.ts's: a guest name is the name
 * (nothing else is stored), then a Conduit user, then a linked contact. It cannot
 * be ambiguous -- `meeting_attendees_exactly_one` admits exactly one of the three
 * per row -- so the precedence only decides which read wins for a row that could
 * not exist.
 *
 * `full_name` BEFORE `username`, WHICH IS WHERE THIS DIFFERS FROM THE EXPORT. A
 * CSV column wants the identifier an operator can join on; a printed summary
 * wants "Chris Wilson" rather than "chris". `full_name` is nullable (it comes
 * from the auth header) and the username is the fallback.
 *
 * ORDERED BY id, and by nothing else, for services/meetings.ts's own reason:
 * `meeting_attendees` deliberately carries no created_at and no ordinal, and the
 * set is rewritten wholesale on every update, so id is the only order a read can
 * reproduce. Without it the printed order would be stable only by accident of the
 * plan -- and this page gets sent to people who were in the room.
 */
async function loadAttendeeNames(tx: Database, meetingId: string): Promise<string[]> {
  const rows = await tx.select({
    guestName: meetingAttendees.guestName,
    fullName: users.fullName,
    username: users.username,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
  })
    .from(meetingAttendees)
    .leftJoin(users, eq(meetingAttendees.userId, users.id))
    .leftJoin(contacts, eq(meetingAttendees.contactId, contacts.id))
    .where(eq(meetingAttendees.meetingId, meetingId))
    .orderBy(asc(meetingAttendees.id));
  return rows.map((row) => row.guestName
    ?? row.fullName
    ?? row.username
    ?? [row.firstName, row.lastName].filter((part) => part !== null && part !== "").join(" "));
}

/** `documents` row -> the wire shape, for the type whose content is not in the row. */
function toMeetingSummaryRecord(row: DocumentRow, meetingId: string): MeetingSummaryRecord {
  return {
    id: row.id,
    type: "meeting_summary",
    // THE MEETING COMES FROM THE CALLER, NOT FROM `row`, for the reason
    // toDocumentRecord takes its dealId that way: `documents.meeting_id` is
    // nullable (a quote's is null) while this DTO's is not, so reading it off the
    // row would put a `!` or a `?? ""` here that no caller can reach and no test
    // could exercise. Both call sites have the id in hand.
    meetingId,
    fileId: row.fileId,
    issueDate: row.issueDate,
    frozen: row.frozen,
    issuedByUserId: row.issuedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Produce the summary of a meeting. ONE TRANSACTION, and NO INPUT AT ALL.
 *
 * **THIS IS THE TYPE THAT PROVES THE DATA MODEL WITHOUT A FORM CONFUSING THE
 * PICTURE**, which is why the plan put it second. Everything printed is on the
 * `meetings` row and its attendees; the only thing the caller supplies is which
 * meeting, and the only thing this function decides is what day it is.
 *
 * WHAT IT DOES **NOT** DO, EACH FOR A REASON:
 *
 * - **NO NUMBER.** @conduit/shared's `documentTypeNumbered` has the three
 *   arguments. The consequence here is the one worth naming: there is no
 *   `allocateNumber` call, so there is no row lock, so there is no `SET LOCAL
 *   lock_timeout` either -- two summaries render side by side, bounded by
 *   renderPdf's own concurrency cap and nothing else. `documents_number_matches_type`
 *   refuses this row if a future edit puts a number on it.
 * - **NO FREEZE.** `frozen` is `documentTypeFreezes("meeting_summary")`, which is
 *   `false`, written rather than defaulted for the reason the quote's is (0016
 *   dropped the DEFAULT precisely so a writer that forgets cannot inherit one).
 * - **NO UPDATE PATH.** Producing a summary again appends a SECOND document with
 *   its own PDF; it does not rewrite the first. That is deliberate scope, not an
 *   oversight: Task 1's note says nothing reads `frozen` yet and Task 3 is where
 *   the guard that reads it arrives, so an edit-in-place path here would be the
 *   one place in the codebase that mutated an issued document with no guard
 *   anywhere. Appending is also what makes "no number" free -- a numbered type
 *   would have to choose between spending a second number and reusing the first.
 *
 * THE ORDER IS issueQuote's, minus the allocation: read the meeting, read the
 * template, read the issuer profile, merge, check the caps, render, write the
 * blob, insert the file, insert the document. Everything attributable to the
 * caller fails before anything spawns. The blob write is the one part that cannot
 * roll back, for issueQuote's reason exactly.
 */
export async function issueMeetingSummary(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  meetingId: string,
): Promise<MeetingSummaryRecord> {
  const record = await db.transaction(async (tx) => {
    const [meeting] = await tx.select({
      title: meetings.title, occurredAt: meetings.occurredAt,
      durationMinutes: meetings.durationMinutes, notes: meetings.notes,
      archivedAt: meetings.archivedAt,
    }).from(meetings).where(eq(meetings.id, meetingId));
    if (meeting === undefined) throw new NotFoundError("meeting", meetingId);
    // issueQuote's refusal of an archived deal, on the record this document is of.
    // attachFile re-checks it a moment later from inside the same transaction; this
    // one is what makes the refusal arrive before a subprocess has run.
    if (meeting.archivedAt !== null) throw new ArchivedError("meeting", meetingId);

    const templateHtml = await loadTemplateBody(tx, "meeting_summary");
    const org = await getOrgProfile(tx);
    const attendees = await loadAttendeeNames(tx, meetingId);

    // SERVER-AUTHORITATIVE, AND IN THE ORGANISATION'S ZONE. There is no input to
    // take an issue date from -- that is what "the type with no form" means -- and a
    // client-supplied one would be a field on a form that does not exist.
    //
    // NOT `scheduling.ts`'s `todayDateOnly` ANY MORE, and this line is the second
    // half of v1.8.0's timezone field. That function reads the server clock in UTC
    // and documents a +/-2h caveat which is exactly right for the Gantt clamp it was
    // written for and wrong here: a summary issued at 00:30 in Amsterdam was dated
    // the day before, in type, on a page sent to the people who were in the room --
    // and it also named the PDF, so the file on disk carried the wrong day too. The
    // caveat was harmless where it was written and is not harmless on a document, so
    // documents got their own answer rather than scheduling's being changed under
    // its own callers.
    const issueDate = todayInZone(org.timeZone);
    // SANITISED WITH THE DOCUMENT PROFILE BEFORE IT IS RAW. The stored value went
    // through the MAIL profile on write (services/meetings.ts's sanitizeNotes), and
    // the two profiles differ in both directions -- mail strips the page-layout CSS
    // a document is made of, and a document allows `<style>`, which mail does not.
    // So what is about to be emitted unescaped is measured against the profile of
    // the document it is going into, not the one it was stored under.
    const notesHtml = meeting.notes === null ? "" : sanitizeDocumentHtml(meeting.notes);

    const file = await renderAndStore(tx, deps, actorId, {
      noun: "meeting summary",
      templateHtml,
      context: buildMeetingSummaryContext({
        org, issueDate,
        title: meeting.title,
        occurredAt: meeting.occurredAt.toISOString(),
        durationMinutes: meeting.durationMinutes,
        notesHtml,
        attendees,
      }),
      // NAMES THE NOTES FIRST, because they are the only part of this document an
      // operator can shorten. A quote's provenance offers three levers and so does
      // this one, but the middle term is different: there is no submission to trim,
      // there is a meeting whose notes are as long as they are.
      provenance: "Its template is "
        + `${String(Buffer.byteLength(templateHtml, "utf8"))} bytes, its logo `
        + `${String(org.logoDataUri.length)}, and the meeting's notes `
        + `${String(Buffer.byteLength(notesHtml, "utf8"))}`,
      originalName: summaryFileName(meeting.title, issueDate),
      target: { meetingId },
    });

    const [row] = await tx.insert(documents).values({
      // SPELLED OUT RATHER THAN OMITTED. `number` is nullable now, so leaving it
      // off would insert the same NULL -- but this is the one type in the codebase
      // that has no number, and the line is where a reader finds out.
      number: null,
      type: "meeting_summary", meetingId, fileId: file.id,
      issueDate,
      frozen: documentTypeFreezes("meeting_summary"),
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    // NO SECOND INSERT, and its absence is the data model working. A quote needs
    // `document_quotes` because a quote has a currency and three totals; a meeting
    // summary's whole content is the `meetings` row it points at, so there is
    // nothing left to store. The composite (document_id, type) foreign key added in
    // 0017 is what makes the other direction impossible: no `document_quotes` row
    // can name this document.
    return toMeetingSummaryRecord(row, meetingId);
  });

  publish({ keys: [["meeting-documents", meetingId], ["files"], ["events"]] });
  return record;
}

/**
 * The longest a meeting's title may be inside a downloaded filename.
 *
 * `meetings.title` has no upper bound in the schema or in `meetingCreateInputSchema`,
 * and `files.original_name` has none either, so without this a paragraph pasted
 * into the title field becomes a filename no filesystem will accept. 80 characters
 * leaves the rest of the name well inside the export's own 180-BYTE member limit
 * even when every character costs three bytes.
 */
const SUMMARY_TITLE_CHARS = 80;

/**
 * What a downloaded meeting summary is called.
 *
 * THE TITLE IS IN IT, AND IT IS NOT SANITISED HERE. `files.original_name` already
 * holds whatever a browser sent for an uploaded file, and the two places that turn
 * a stored name into a real filename both defend themselves: the export's
 * `archiveFileName` strips path separators, control characters and the bytes
 * Windows refuses, and the download route sets its own Content-Disposition. A
 * second, different sanitiser here would be a third opinion about what a filename
 * is.
 *
 * THE DATE IS IN IT BECAUSE THIS TYPE CAN BE PRODUCED AGAIN. Two summaries of one
 * meeting are ordinary (nothing freezes, nothing stops you), and two downloads
 * called `Meeting summary - Kickoff.pdf` land in the same folder as
 * `... (1).pdf`, which says nothing about which is which.
 */
function summaryFileName(title: string, issueDate: string): string {
  const trimmed = title.trim().slice(0, SUMMARY_TITLE_CHARS);
  return `Meeting summary - ${trimmed === "" ? "untitled" : trimmed} - ${issueDate}.pdf`;
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
 * A body that sanitises away to nothing is refused rather than stored: the row exists
 * so a quote renders, and a template that renders as a blank page with a number on it
 * is not one.
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
 *
 * AN INNER JOIN, WHICH IS THE ONLY ONE THAT TYPECHECKS AND ALSO THE RIGHT ONE.
 * `document_quotes.document_id` is both the primary key and the foreign key and
 * the pair is written in one transaction, so a document on a deal without its
 * detail row does not occur. A LEFT JOIN would make `row.quote` nullable and
 * every field below `string | null`, against a DTO whose currency and totals are
 * not -- so the lenient version cannot be written without also inventing what a
 * quote with no money looks like, which is the question this split exists to
 * stop anybody answering. What the join says is "the documents on this deal THAT
 * ARE QUOTES", and that is what this function returns.
 *
 * The Phase 9 spec attaches none of the four new types to a deal -- a summary is
 * of a meeting, a report of a project, an NDA of a company -- so this is not
 * expected to start filtering anything. If a later type does attach to a deal,
 * this becomes a union of per-type reads rather than a widened one.
 */
export async function listDocuments(db: Database, dealId: string): Promise<DocumentRecord[]> {
  const rows = await db.select({ document: documents, quote: documentQuotes })
    .from(documents)
    .innerJoin(documentQuotes, eq(documentQuotes.documentId, documents.id))
    .where(eq(documents.dealId, dealId))
    .orderBy(desc(documents.createdAt), desc(documents.id));
  if (rows.length === 0) return [];
  const lineRows = await db.select().from(documentLineItems)
    .where(inArray(documentLineItems.documentId, rows.map((row) => row.document.id)))
    .orderBy(asc(documentLineItems.position));
  return rows.map((row) => toDocumentRecord(
    row.document, row.quote,
    lineRows.filter((line) => line.documentId === row.document.id),
    dealId,
  ));
}

/**
 * Every summary produced for a meeting, newest first.
 *
 * NO JOIN, AND THAT IS THE SHAPE OF THIS TYPE RATHER THAN AN OPTIMISATION.
 * `listDocuments` joins `document_quotes` because a quote's content is in a second
 * table; a summary's content is in the `meetings` row the client already has open,
 * so there is nothing to fetch and nothing to snapshot. What comes back is the
 * identity, the PDF and when it was made.
 *
 * FILTERED BY TYPE AS WELL AS BY MEETING, though nothing else attaches to a
 * meeting today. It is what makes `toMeetingSummaryRecord`'s literal `type` true
 * rather than assumed, and the moment a second meeting-attached type exists this
 * function keeps meaning what its name says instead of quietly widening.
 *
 * SERVED BY documents_meeting_idx (0017). 0016 deliberately created no index on
 * the four FKs it added, on the grounds that nothing read documents by any of them
 * -- this function is the read that changed that, so its migration built the index.
 */
export async function listMeetingSummaries(
  db: Database, meetingId: string,
): Promise<MeetingSummaryRecord[]> {
  const rows = await db.select().from(documents)
    .where(and(eq(documents.meetingId, meetingId), eq(documents.type, "meeting_summary")))
    .orderBy(desc(documents.createdAt), desc(documents.id));
  return rows.map((row) => toMeetingSummaryRecord(row, meetingId));
}

/* ========================================================================== *
 *  THE LETTER AND THE NDA PAIR -- THE TYPES A COMPANY OR A CONTACT CARRIES
 * ========================================================================== */

/**
 * Which record a document is being raised against: a company or a contact,
 * exactly one.
 *
 * A UNION AND NOT TWO OPTIONAL KEYS, which is the opposite of `RenderAndStore`'s
 * `target` a few hundred lines up and is deliberate. That one exists to be handed
 * to `attachFile`, which walks optional keys; this one is what every function
 * below branches on, and a union makes "neither was supplied" unspellable instead
 * of a runtime check nobody would write. Chris's decision of 6 Sep -- a document
 * belongs to EXACTLY ONE thing -- is enforced three times over: here at compile
 * time, by `documents_exactly_one_entity` on the row, and by
 * `files_exactly_one_entity` on the PDF.
 */
export type RecordTarget = { companyId: string } | { contactId: string };

/** The record a target names, for a message and for a query. */
function targetNoun(target: RecordTarget): "company" | "contact" {
  return "companyId" in target ? "company" : "contact";
}

function targetId(target: RecordTarget): string {
  return "companyId" in target ? target.companyId : target.contactId;
}

/**
 * The record exists and is not archived, refused BEFORE anything spawns.
 *
 * `attachFile` re-checks this a moment later from inside the same transaction --
 * that is what `assertFileTargetActive` is -- so this call is not what makes the
 * rule true. It is what makes the refusal arrive before a subprocess has run and
 * a blob has been written, which is issueQuote's own reason for reading the deal
 * before it reads anything else.
 */
async function assertRecordIssuable(tx: Database, target: RecordTarget): Promise<void> {
  const id = targetId(target);
  if ("companyId" in target) {
    const [row] = await tx.select({ archivedAt: companies.archivedAt })
      .from(companies).where(eq(companies.id, id));
    if (row === undefined) throw new NotFoundError("company", id);
    if (row.archivedAt !== null) throw new ArchivedError("company", id);
    return;
  }
  const [row] = await tx.select({ archivedAt: contacts.archivedAt })
    .from(contacts).where(eq(contacts.id, id));
  if (row === undefined) throw new NotFoundError("contact", id);
  if (row.archivedAt !== null) throw new ArchivedError("contact", id);
}

/**
 * How long an agreement lasts, as the page says it.
 *
 * PLAIN MONTHS, AND `formatDurationMinutes` A FEW HUNDRED LINES UP MADE THE SAME
 * DECISION FOR THE SAME REASON. "36 months" rather than "three (3) years" is a
 * choice and not laziness: converting needs a rule for 18 months, a convention
 * for "1 year 0 months" and a pluralisation, all of them formatting invented for
 * a field the operator typed as a number of months. The label beside it says
 * Term.
 *
 * THE SINGULAR IS NOT DECORATION. `documentTypeSchema`'s suite learned this the
 * hard way on the summary's duration: `toContain("1 month")` is satisfied by
 * "1 months", so the assertion has to close round the whole cell.
 */
function formatAgreementTerm(months: number): string {
  return `${String(months)} ${months === 1 ? "month" : "months"}`;
}

/** Everything the letter template is allowed to print. */
export interface LetterContextInput {
  org: OrgProfile;
  issueDate: string;
  subject: string;
  recipientName: string;
  recipientContactName: string;
  recipientSalutation: string;
  recipientAddress: string;
  /** The letter's body, ALREADY SANITISED WITH THE DOCUMENT PROFILE. */
  bodyHtml: string;
}

/**
 * The merge context for one letter.
 *
 * **`body` IS THE SECOND `MergeHtml` IN CONDUIT, AND THE FIRST THAT SOMEBODY
 * TYPED INTO A DOCUMENT FORM.** The summary's notes are rich text borrowed from a
 * `meetings` row; this is rich text whose only reason for existing is this
 * document. Everything MergeHtml's own comment says applies unchanged -- the
 * context decides what is raw and the template cannot ask, because templates are
 * edited in Settings by any authenticated user and a triple-brace escape hatch
 * would turn any CRM text field into markup injected into a subprocess.
 *
 * **IT IS NAMED `body` AND NOT `bodyHtml`.** Merge paths are what an operator
 * types into a template, and `{{document.bodyHtml}}` puts an implementation
 * detail on a page they are editing; the field list in Settings is where it says
 * that this one arrives as formatted HTML. Nothing else in any context carries a
 * type suffix either.
 *
 * THE SUBJECT AND THE ADDRESSEE ARE NOT RAW. They are plain text in plain inputs,
 * so a recipient called `<b>Acme</b>` prints as itself rather than restructuring
 * the page -- the summary's title, exactly.
 *
 * NO `number` KEY, so a template naming one prints a blank, which is right for a
 * type that has none (`documentTypeNumbered`).
 */
export function buildLetterContext(input: LetterContextInput): MergeContext {
  return {
    org: orgContext(input.org),
    document: {
      issueDate: input.issueDate,
      subject: input.subject,
      recipientName: input.recipientName,
      recipientContactName: input.recipientContactName,
      recipientSalutation: input.recipientSalutation,
      recipientAddress: input.recipientAddress,
      body: new MergeHtml(input.bodyHtml),
    },
    // A letter has no priced lines, so `{{#lines}}` renders nothing. Empty rather
    // than absent for buildMeetingSummaryContext's reason: MergeContext requires
    // it, and requiring it is what keeps every quote context honest.
    lines: [],
  };
}

/** Everything the NDA and mutual NDA templates are allowed to print. */
export interface AgreementContextInput {
  org: OrgProfile;
  number: string;
  issueDate: string;
  effectiveDate: string;
  termMonths: number;
  jurisdiction: string;
  partyName: string;
  partyContactName: string;
  partyAddress: string;
}

/**
 * The merge context for an NDA or a mutual NDA.
 *
 * ONE BUILDER FOR BOTH TYPES, because the two documents need the same values and
 * differ only in what their templates say about them. Two builders would be two
 * copies of one key set, and the key set is the contract this file's suite checks
 * against the tokens read out of each seeded template -- so the second copy's
 * failure to gain a field somebody added to the first is a blank on a signed
 * page.
 *
 * **NOTHING HERE IS RAW.** An agreement has no rich-text field at all: its whole
 * variable content is a party, three terms and two dates, every one of them plain
 * text in a plain input. The document's prose is the TEMPLATE, which is the
 * correct place for it -- editable in Settings, reviewable by whoever is
 * responsible for the wording, and not smuggled through a form.
 *
 * `term` IS FORMATTED HERE AND `termMonths` IS NOT EXPOSED, so a template cannot
 * print a bare `36` beside its own word for months and get "36 months months".
 */
export function buildAgreementContext(input: AgreementContextInput): MergeContext {
  return {
    org: orgContext(input.org),
    document: {
      number: input.number,
      issueDate: input.issueDate,
      effectiveDate: input.effectiveDate,
      term: formatAgreementTerm(input.termMonths),
      jurisdiction: input.jurisdiction,
      partyName: input.partyName,
      partyContactName: input.partyContactName,
      partyAddress: input.partyAddress,
    },
    lines: [],
  };
}

/** `documents` + `document_letters` -> the wire shape. */
function toLetterRecord(row: DocumentRow, letter: DocumentLetterRow): LetterRecord {
  return {
    id: row.id,
    type: "letter",
    // READ OFF THE ROW, WHERE toMeetingSummaryRecord TAKES ITS ID FROM THE
    // CALLER, and the difference is real rather than an inconsistency. A summary
    // is always of a meeting, so `documents.meeting_id`'s nullability is a fact
    // about the table; a letter is genuinely of a company OR a contact, decided
    // per row, and a reader that wants to say who it is addressed to has to be
    // told which. Both columns are on the wire and exactly one is non-null,
    // which `documents_exactly_one_entity` guarantees.
    companyId: row.companyId,
    contactId: row.contactId,
    fileId: row.fileId,
    issueDate: row.issueDate,
    frozen: row.frozen,
    subject: letter.subject,
    recipientName: letter.recipientName,
    recipientContactName: letter.recipientContactName,
    recipientSalutation: letter.recipientSalutation,
    recipientAddress: letter.recipientAddress,
    bodyHtml: letter.bodyHtml,
    issuedByUserId: row.issuedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `documents` + `document_agreements` -> the wire shape. */
function toAgreementRecord(row: DocumentRow, agreement: DocumentAgreementRow): AgreementRecord {
  // Cannot fire: this function is reached only for a row that HAS a
  // `document_agreements` row, and `documents_number_matches_type` says an
  // agreement has a number. Thrown rather than `?? ""` for toDocumentRecord's
  // reason -- an agreement whose number vanished is a broken record, and an empty
  // string on a document list is a broken record nobody notices.
  if (row.number === null) {
    throw new Error(`document ${row.id} is an agreement with no number, which two CHECKs forbid`);
  }
  return {
    id: row.id,
    type: agreement.type as AgreementRecord["type"],
    number: row.number,
    companyId: row.companyId,
    contactId: row.contactId,
    fileId: row.fileId,
    issueDate: row.issueDate,
    frozen: row.frozen,
    effectiveDate: agreement.effectiveDate,
    termMonths: agreement.termMonths,
    jurisdiction: agreement.jurisdiction,
    partyName: agreement.partyName,
    partyContactName: agreement.partyContactName,
    partyAddress: agreement.partyAddress,
    issuedByUserId: row.issuedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The PDF's filename, for a type whose documents are told apart by what they say
 * rather than by a number.
 *
 * `summaryFileName`'s twin and it shares its two arguments: the text is not
 * sanitised here (three places already have an opinion about what a filename is,
 * and a fourth would be a fourth opinion), and the DATE is in it because this
 * type can be produced again -- two letters to the same company landing in a
 * downloads folder as `Letter - Acme.pdf` and `Letter - Acme (1).pdf` say nothing
 * about which is which.
 *
 * THE SUBJECT IS PREFERRED TO THE RECIPIENT AND THE RECIPIENT IS THE FALLBACK.
 * A subject is what distinguishes two letters to the same company, which is the
 * collision this function exists to break; the recipient distinguishes nothing
 * when both letters are to them. The subject is optional, so the fallback is not
 * decoration.
 */
const LETTER_TITLE_CHARS = 80;
function letterFileName(subject: string, recipientName: string, issueDate: string): string {
  const chosen = subject.trim() === "" ? recipientName.trim() : subject.trim();
  const trimmed = chosen.slice(0, LETTER_TITLE_CHARS);
  return `Letter - ${trimmed === "" ? "untitled" : trimmed} - ${issueDate}.pdf`;
}

/**
 * A letter's own content, sanitised and checked for having survived it.
 *
 * **TWO FAILURES, TWO SENTENCES, AND THIS IS THE SECOND.** `bodyHtml.min(1)` in
 * @conduit/shared refuses an empty submission; this refuses a submission that was
 * not empty and becomes empty once the document profile has had it -- a paste of
 * `<script>...</script>`, a lone comment, markup made entirely of tags the
 * profile drops. Left ungated that renders a letterhead with a greeting and a
 * sign-off and nothing between them, which is a document somebody posts.
 *
 * SANITISED WITH THE DOCUMENT PROFILE AND NOT THE MAIL ONE, exactly as the
 * summary's notes are, and for the reason the summary records: the two profiles
 * differ in both directions -- mail strips the page-layout CSS a document is made
 * of, and a document allows `<style>`, which mail does not. What is about to be
 * emitted unescaped is measured against the profile of the document it is going
 * into.
 */
function sanitizeLetterBody(bodyHtml: string): string {
  const clean = sanitizeDocumentHtml(bodyHtml);
  if (clean.trim() === "") {
    throw new DocumentInputError(
      "the letter is empty once sanitised; it contained no markup a document keeps",
    );
  }
  return clean;
}

/** The merged size gate's third term, which differs per type. */
function letterProvenance(templateHtml: string, org: OrgProfile, bodyHtml: string): string {
  return `Its template is ${String(Buffer.byteLength(templateHtml, "utf8"))} bytes, its logo `
    + `${String(org.logoDataUri.length)}, and its body `
    + `${String(Buffer.byteLength(bodyHtml, "utf8"))}`;
}

/**
 * Write a letter. ONE TRANSACTION, and it is `issueMeetingSummary`'s order rather
 * than `issueQuote`'s: read the record, read the template, read the issuer
 * profile, merge, check the caps, render, write the blob, insert the file, insert
 * the two rows.
 *
 * **NO NUMBER AND THEREFORE NO ROW LOCK AND THEREFORE NO `SET LOCAL
 * lock_timeout`** -- the summary's arrangement exactly, and @conduit/shared's
 * `documentTypeNumbered` has the three reasons a letter has none. Two letters
 * render side by side, bounded by renderPdf's own concurrency cap and nothing
 * else.
 *
 * **NOT FROZEN**, which is what makes `redraftLetter` below possible and is the
 * whole reason this task exists. `frozen` is written rather than defaulted, for
 * the reason 0016 dropped the DEFAULT: a writer that forgets must fail loudly
 * rather than inherit "frozen".
 */
export async function issueLetter(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  target: RecordTarget,
  input: IssueLetterInput,
): Promise<LetterRecord> {
  const parsed = issueLetterInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentInputError(parsed.error.issues[0]?.message ?? "invalid letter");
  }
  const letter = parsed.data;

  const record = await db.transaction(async (tx) => {
    await assertRecordIssuable(tx, target);
    const templateHtml = await loadTemplateBody(tx, "letter");
    const org = await getOrgProfile(tx);
    const bodyHtml = sanitizeLetterBody(letter.bodyHtml);
    const values = {
      subject: letter.subject ?? "",
      recipientName: letter.recipientName,
      recipientContactName: letter.recipientContactName ?? "",
      recipientSalutation: letter.recipientSalutation ?? "",
      recipientAddress: letter.recipientAddress ?? "",
      bodyHtml,
    };

    const file = await renderAndStore(tx, deps, actorId, {
      noun: "letter",
      templateHtml,
      context: buildLetterContext({ org, issueDate: letter.issueDate, ...values }),
      provenance: letterProvenance(templateHtml, org, bodyHtml),
      originalName: letterFileName(values.subject, values.recipientName, letter.issueDate),
      target,
    });

    const [row] = await tx.insert(documents).values({
      // SPELLED OUT RATHER THAN OMITTED, as the summary's is. `number` is
      // nullable, so leaving it off would insert the same NULL -- but this is
      // where a reader finds out that a letter has none.
      number: null,
      type: "letter",
      ...target,
      fileId: file.id,
      issueDate: letter.issueDate,
      frozen: documentTypeFreezes("letter"),
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    const [letterRow] = await tx.insert(documentLetters)
      .values({ documentId: row.id, ...values }).returning();
    if (letterRow === undefined) throw new Error("document_letters insert returned no row");

    return toLetterRecord(row, letterRow);
  });

  publish({ keys: [["record-documents", targetId(target)], ["files"], ["events"]] });
  return record;
}

/**
 * **REDRAFT A LETTER -- THE ONLY WRITE IN CONDUIT THAT MODIFIES AN ISSUED
 * DOCUMENT, AND THEREFORE THE ONE THE GUARD IS ABOUT.**
 *
 * Chris, 6 Sep: a letter "wants redrafting before it goes". Until this function
 * there was no update path at all -- Phase 7 built none, and Task 2 deliberately
 * declined to build one for the summary precisely because "an edit-in-place path
 * here would be the one place in the codebase that mutated an issued document
 * with no guard anywhere".
 *
 * ============================== THE GUARD ==================================
 *
 * **THE REFUSAL IS SAID TWICE IN THIS FUNCTION, AND MUTATION TESTING SETTLED
 * WHICH HALF IS LOAD-BEARING.** The SELECT below refuses a frozen document before
 * anything spawns; the UPDATE then carries `AND frozen = false`, so the test and
 * the write are ONE statement with no window between them. Measured: removing the
 * SELECT's check is caught by three tests, and removing the UPDATE's clause ALONE
 * is green -- because nothing can change `frozen` under a live row, so the two
 * can never disagree. The clause stays because what makes it unobservable is two
 * other guards holding, and a guard that leans on another guard should still
 * state its own condition.
 *
 * **AND NEITHER OF THEM IS THE THING THAT MAKES THE RULE TRUE.** 0019 puts
 * `conduit_document_frozen_guard` on `documents` and on all three detail tables,
 * BEFORE UPDATE OR DELETE. Delete the `frozen` clause below and this function
 * still cannot edit a quote: the trigger refuses it, from the database, for every
 * writer including a psql session. That is the layering the spec's fourth risk
 * asks for -- the rule that a quote cannot be edited must not depend on this
 * function being written correctly, because the next type's author will write a
 * different function.
 *
 * **WHY IT READS `frozen` AND NOT `documentTypeFreezes(row.type)`.** They agree --
 * `documents_frozen_matches_type` is an equality and db/schema.test.ts pins the
 * two spellings for every member of the enum. The column is used anyway because
 * db/schema.ts's own comment on it says why: "a guard that re-derives policy from
 * the type at each call site is a guard that can be written wrong once per call
 * site; one that reads a fact off the row cannot." Re-deriving would also make
 * the guard unspellable in SQL, which is where it has to be for the two
 * statements to be one.
 *
 * ============================ WHAT A REDRAFT IS ============================
 *
 * THE WHOLE FORM, NOT A PATCH. `redraftLetterInputSchema` is the issue schema
 * minus its `type`, so the two paths cannot come to different answers about what
 * a valid letter is, and clearing a field is expressible. Same reasoning as PUT
 * /api/org-profile.
 *
 * **A NEW `files` ROW EACH TIME, AND THE OLD PDF STAYS.** The alternative --
 * rewriting the existing row's sha256, size and name in place -- was rejected on
 * two grounds. It would be the first thing in Conduit ever to mutate a `files`
 * row, on the table the download route, the rail's Files tab, the export and the
 * backup all read; and it would go around `attachFile`, which is the one place a
 * `files` row is created, which re-checks that the record is still active, and
 * which stamps the `file_attached` entry that is the only record anywhere of WHEN
 * a redraft happened. The cost is a superseded PDF on the record's Files tab, and
 * that is honest rather than untidy: those bytes existed, and may have been sent.
 *
 * NO `updated_at` COLUMN, and its absence is a decision. The `documents` row
 * still says only what it always said; when a letter was last redrafted is the
 * `created_at` of the `files` row it now points at, which is a fact the system
 * already keeps rather than a second copy of one.
 */
export async function redraftLetter(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  documentId: string,
  input: RedraftLetterInput,
): Promise<LetterRecord> {
  const parsed = redraftLetterInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentInputError(parsed.error.issues[0]?.message ?? "invalid letter");
  }
  const letter = parsed.data;

  const { record, target } = await db.transaction(async (tx) => {
    // READ FIRST, TO REFUSE EARLY AND TO SAY WHY -- and this read IS what stops a
    // frozen document today, which is not what a first draft of this comment
    // claimed. It said the UPDATE below was "the guard" and this was merely an
    // early refusal; **mutation testing said otherwise.** Removing this line is
    // caught by three tests (a frozen document must be refused before anything
    // spawns, with a renderer that fails if it runs at all), while removing the
    // UPDATE's `AND frozen = false` on its own is GREEN -- because `frozen` cannot
    // change under a live row, so the two statements can never disagree.
    //
    // THE `AND frozen = false` STAYS ANYWAY, and its being unobservable is the
    // point rather than an argument against it: what makes it unobservable is
    // that `documents_frozen_matches_type` and the trigger between them make
    // `frozen` immutable, and a guard that depends on another guard holding is
    // exactly the kind that should also state its own condition. Removing BOTH is
    // red, and what kills it is the DATABASE -- see the header.
    const [existing] = await tx.select({
      type: documents.type, frozen: documents.frozen,
      companyId: documents.companyId, contactId: documents.contactId,
    }).from(documents).where(eq(documents.id, documentId));
    if (existing === undefined) throw new NotFoundError("document", documentId);
    if (existing.frozen) throw new DocumentFrozenError(documentId, existing.type);
    // A DIFFERENT REFUSAL FROM THE FROZEN ONE, and it is not redundant with it.
    // A meeting summary is not frozen either, and it has no `document_letters`
    // row to rewrite -- so without this, redrafting one would fail on a missing
    // detail row with a 500 instead of saying that this is not a letter. The
    // rule "which types have a redraft path" is not the rule "which types are
    // frozen", and conflating them is how the next unfrozen type gets a broken
    // one for free.
    if (existing.type !== "letter") {
      throw new DocumentInputError(`document ${documentId} is a ${existing.type}, not a letter`);
    }
    // SPELLED OUT RATHER THAN `existing.contactId!`, AND THE `!` IT REPLACES WAS
    // COVERING A REAL GAP. `documents_exactly_one_entity` says exactly one of
    // FIVE; it does not say WHICH one for a given type, so nothing in the
    // database stops a letter carrying a `deal_id` -- only the writers do. That
    // has been true since Task 2 (a summary could carry a deal) and this task
    // made it true for three more types. The CHECK that would close it is at
    // "which entity, per type" in the plan, and it is deliberately not in 0019
    // because it is a rule about all five types and two of them are Task 4's.
    // Until it exists, this branch is reachable by a psql session, and it says so
    // loudly rather than dereferencing a null.
    const target: RecordTarget | null = existing.companyId !== null
      ? { companyId: existing.companyId }
      : existing.contactId !== null ? { contactId: existing.contactId } : null;
    if (target === null) {
      throw new Error(
        `letter ${documentId} is attached to neither a company nor a contact, `
        + "which no writer can produce",
      );
    }

    await assertRecordIssuable(tx, target);
    const templateHtml = await loadTemplateBody(tx, "letter");
    const org = await getOrgProfile(tx);
    const bodyHtml = sanitizeLetterBody(letter.bodyHtml);
    const values = {
      subject: letter.subject ?? "",
      recipientName: letter.recipientName,
      recipientContactName: letter.recipientContactName ?? "",
      recipientSalutation: letter.recipientSalutation ?? "",
      recipientAddress: letter.recipientAddress ?? "",
      bodyHtml,
    };

    const file = await renderAndStore(tx, deps, actorId, {
      noun: "letter",
      templateHtml,
      context: buildLetterContext({ org, issueDate: letter.issueDate, ...values }),
      provenance: letterProvenance(templateHtml, org, bodyHtml),
      originalName: letterFileName(values.subject, values.recipientName, letter.issueDate),
      target,
    });

    // ============================ THE GUARD ================================
    // `frozen = false` is part of the statement that writes, not a check that
    // ran before it. See this function's header.
    const [row] = await tx.update(documents)
      .set({ fileId: file.id, issueDate: letter.issueDate })
      .where(and(eq(documents.id, documentId), eq(documents.frozen, false)))
      .returning();
    if (row === undefined) throw new DocumentFrozenError(documentId, existing.type);

    const [letterRow] = await tx.update(documentLetters)
      .set(values).where(eq(documentLetters.documentId, documentId)).returning();
    if (letterRow === undefined) throw new Error("document_letters update returned no row");

    return { record: toLetterRecord(row, letterRow), target };
  });

  publish({ keys: [["record-documents", targetId(target)], ["files"], ["events"]] });
  return record;
}

/**
 * Raise an NDA or a mutual NDA. `issueQuote`'s shape, because this is the second
 * numbered type and numbering is what gives that function its order.
 *
 * **THE NUMBER IS ALLOCATED BEFORE THE RENDER AND THE TRANSACTION IS WHAT MAKES
 * THAT SAFE**, for issueQuote's reason exactly: the number is PRINTED on the page,
 * and a render that then fails must not spend it -- an agreement sequence with
 * holes invites the question of what was in the hole, and for a contract that is
 * a worse question than it is for a quote. `nextval()` cannot help; a table row
 * rolls back.
 *
 * **AND THE `SET LOCAL lock_timeout` COMES WITH IT.** `allocateNumber`'s ON
 * CONFLICT takes a row lock on (type, year) held to commit, so two NDAs of the
 * same year serialise from there to the end of the transaction with a render
 * inside. Without the timeout a pile-up occupies pooled connections
 * indefinitely; 45s is one full worst-case hold plus slack, which is issueQuote's
 * figure and its argument, unchanged. `nda` and `mutual_nda` are separate rows in
 * `document_number_sequences`, so the two types do not queue behind each other.
 *
 * **FROZEN ON ISSUE**, which is Chris's decision and the sharpest one in the
 * spec. From the moment this transaction commits, `conduit_document_frozen_guard`
 * refuses every UPDATE and DELETE against this row and its detail row, from every
 * writer.
 */
export async function issueAgreement(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  target: RecordTarget,
  input: IssueAgreementInput,
): Promise<AgreementRecord> {
  const parsed = issueAgreementInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentInputError(parsed.error.issues[0]?.message ?? "invalid agreement");
  }
  const agreement = parsed.data;
  const year = Number(agreement.issueDate.slice(0, 4));

  const record = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '45s'`);
    await assertRecordIssuable(tx, target);
    const templateHtml = await loadTemplateBody(tx, agreement.type);
    const org = await getOrgProfile(tx);
    const values = {
      type: agreement.type,
      effectiveDate: agreement.effectiveDate,
      termMonths: agreement.termMonths,
      jurisdiction: agreement.jurisdiction,
      partyName: agreement.partyName,
      partyContactName: agreement.partyContactName ?? "",
      partyAddress: agreement.partyAddress ?? "",
    };

    const number = await allocateNumber(tx, agreement.type, year);
    const file = await renderAndStore(tx, deps, actorId, {
      // "nda" and "mutual NDA" read badly in a sentence; the size refusals say
      // "agreement", which is what both of them are and what the message is
      // about. The quote's three refusals are untouched, which is what keeps the
      // route suite's assertions about their wording meaningful.
      noun: "agreement",
      templateHtml,
      context: buildAgreementContext({ org, number, issueDate: agreement.issueDate, ...values }),
      // NAMES THE JURISDICTION AND THE PARTY, because those are the only parts of
      // this document an operator can shorten: there is no body to trim (the
      // prose is the template) and no notes.
      provenance: `Its template is ${String(Buffer.byteLength(templateHtml, "utf8"))} bytes, `
        + `its logo ${String(org.logoDataUri.length)}, and its party and jurisdiction `
        + `${String(agreementContentBytes(agreement))}`,
      originalName: `${number}.pdf`,
      target,
    });

    const [row] = await tx.insert(documents).values({
      number, type: agreement.type, ...target, fileId: file.id,
      issueDate: agreement.issueDate,
      frozen: documentTypeFreezes(agreement.type),
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    const [agreementRow] = await tx.insert(documentAgreements)
      .values({ documentId: row.id, ...values }).returning();
    if (agreementRow === undefined) throw new Error("document_agreements insert returned no row");

    return toAgreementRecord(row, agreementRow);
  });

  publish({ keys: [["record-documents", targetId(target)], ["files"], ["events"]] });
  return record;
}

/**
 * How wide a company's Documents list is.
 *
 * **THIS IS THE ROLLUP TASK 3 RECOMMENDED AND DID NOT BUILD, AND IT IS OFF BY
 * DEFAULT ON PURPOSE.** Task 3's finding: "A letter to Jane at Acme is raised on
 * JANE, so it does not appear on ACME's Documents list -- and vice versa.
 * routes.test.ts asserts that emptiness deliberately, because it is the decision
 * working rather than a bug... For CORRESPONDENCE it is real friction. **THE
 * RECOMMENDATION IS A READ, NOT A COLUMN.**"
 *
 * So it is a read, and it is the read Task 3 wrote out: `WHERE company_id = $1 OR
 * contact_id IN (SELECT id FROM contacts WHERE company_id = $1)`.
 *
 * **CHRIS'S "EXACTLY ONE" DECISION IS UNTOUCHED, AND THAT IS THE POINT OF DOING
 * IT THIS WAY.** Nothing here widens `documents_exactly_one_entity`, nothing adds
 * a second owner column, and every row still belongs to exactly one record. What
 * changes is what one PAGE chooses to show, which is not a question about the
 * data model. Task 3 was explicit that widening the CHECK "would make every
 * reader ask 'which of the two is this document really about', which is the
 * question `num_nonnulls(...) = 1` exists to answer".
 *
 * **DEFAULT `false`, SO THE ASSERTED EMPTINESS STAYS ASSERTED.** routes.test.ts's
 * "keeps a contact's documents separate from their company's" is a deliberate
 * test of a deliberate decision; a rollup that turned itself on would have
 * required deleting it, which is how a decision gets reversed by a task that was
 * only asked to consider reversing it. The operator turns it on, per view, and
 * both behaviours are then observable.
 *
 * **IT IS MEANINGLESS FOR A CONTACT AND IS IGNORED THERE**, rather than being
 * refused: a contact has no contacts, so there is nothing to roll up, and a route
 * that 400'd on a query parameter a client sent uniformly would be a worse
 * contract than one that answers the same list either way.
 */
export interface ListRecordDocumentsOptions {
  /** A company's list also shows documents raised on its own contacts. */
  includeContacts?: boolean;
}

/**
 * Every document attached to one company or one contact, newest first.
 *
 * **THE READER THAT MIXES TYPES, WHICH IS WHAT THE DISCRIMINATED UNION IN
 * @conduit/shared WAS WAITING FOR.** Task 1 expected the union with the second
 * type; Task 2 explained why it had not arrived (nothing yet RECEIVED both
 * shapes) and named the reader that would need it. This is that reader.
 *
 * **TWO LEFT JOINS AND ONE PASS, NOT TWO QUERIES.** A union of `listLetters` and
 * `listAgreements` would be two round trips whose results have to be merged and
 * re-sorted in TypeScript -- and the merge has to reproduce the ORDER BY, in a
 * second place, by hand. One query orders once, in the database, over the column
 * the order is about.
 *
 * LEFT AND NOT INNER, WHICH IS THE OPPOSITE OF `listDocuments`' CHOICE AND FOR
 * THE SAME REASON. That one INNER JOINs `document_quotes` because it means "the
 * documents on this deal THAT ARE QUOTES". This one means "every document on this
 * record", so a join that dropped a row would drop a document -- which is exactly
 * the failure Task 2 found in the export's `documentsSheet`, from an INNER JOIN
 * written when one type existed.
 *
 * A ROW WITH NEITHER DETAIL IS AN ERROR AND NOT A SKIP. It cannot occur -- both
 * detail rows are written in the same transaction as their parent, both are keyed
 * by the primary key, and `documents_type_valid` admits nothing else that can
 * attach to a company or a contact -- so a `continue` here would be an unreachable
 * branch that quietly hides the one thing it could ever mean, which is a document
 * whose content is missing.
 */
export async function listRecordDocuments(
  db: Database, target: RecordTarget, options: ListRecordDocumentsOptions = {},
): Promise<RecordDocument[]> {
  // A SUBQUERY AND NOT A SECOND ROUND TRIP, for the reason the two LEFT JOINs
  // above are one query: the ORDER BY has to run over the whole set, and merging
  // two reads in TypeScript means reproducing it by hand in a second place.
  // `contacts.company_id` is the link, and it is the same link the company page
  // already uses to list its people.
  const owner = "companyId" in target
    ? (options.includeContacts === true
      ? or(
        eq(documents.companyId, target.companyId),
        inArray(
          documents.contactId,
          db.select({ id: contacts.id }).from(contacts)
            .where(eq(contacts.companyId, target.companyId)),
        ),
      )
      : eq(documents.companyId, target.companyId))
    : eq(documents.contactId, target.contactId);

  const rows = await db.select({
    document: documents, letter: documentLetters, agreement: documentAgreements,
  })
    .from(documents)
    .leftJoin(documentLetters, eq(documentLetters.documentId, documents.id))
    .leftJoin(documentAgreements, eq(documentAgreements.documentId, documents.id))
    .where(owner)
    .orderBy(desc(documents.createdAt), desc(documents.id));
  return rows.map((row) => {
    if (row.letter !== null) return toLetterRecord(row.document, row.letter);
    if (row.agreement !== null) return toAgreementRecord(row.document, row.agreement);
    throw new Error(
      `document ${row.document.id} is a ${row.document.type} on a ${targetNoun(target)} `
      + "with no detail row, which no writer can produce",
    );
  });
}

/* ========================================================================== *
 *  THE PROJECT STATUS REPORT -- THE BROADEST SOURCE, AND THE SECOND TYPE WITH
 *  NO FORM
 * ========================================================================== */

/**
 * One task, as the report reads it out of the database and before any of it is
 * a string.
 *
 * `after` IS THE ONLY FIELD NOT ON THE `tasks` ROW: the titles of this task's
 * predecessors, in the order `listDependencies` returns them. It is what makes
 * this the Gantt STATE rather than a task list.
 */
export interface StatusReportTask {
  title: string;
  status: TaskStatus;
  startDate: string | null;
  dueDate: string | null;
  progressPct: number | null;
  /** The assignee's display name, or "" for an unassigned task. */
  assignee: string;
  after: string[];
}

/** Everything the project status report template is allowed to print. */
export interface StatusReportContextInput {
  org: OrgProfile;
  /**
   * The day the report was produced, in the organisation's zone -- and also the
   * day the overdue rule is measured against. ONE VALUE FOR BOTH, deliberately:
   * a report that said "Reported 6 September" and counted overdue against the
   * server's UTC day would disagree with itself for two hours a night.
   */
  issueDate: string;
  projectName: string;
  status: ProjectStatus;
  startDate: string | null;
  dueDate: string | null;
  /** The project owner's display name, or "" if it has none. */
  owner: string;
  /** The linked company's name, or "" if the project is not on one. */
  company: string;
  tasks: StatusReportTask[];
}

/** How far along a task its own assignee says it is. */
function formatProgressPct(pct: number | null): string {
  return pct === null ? "" : `${String(pct)}%`;
}

/**
 * Whether a task is late, as this document counts it.
 *
 * **DUE TODAY IS NOT OVERDUE**, which is the one judgement in the rule. A task
 * due on the day the report is produced still has the day to run, and a report
 * that called it late would be wrong about every task somebody planned to finish
 * that afternoon. Strictly before, therefore.
 *
 * A DONE TASK IS NEVER OVERDUE, whenever it was actually finished.
 * `tasks_completed_at_paired` ties `completed_at` to the done status, so
 * "finished late" is answerable -- and it is deliberately not asked here. This
 * count is "what needs attention", and a task that is finished does not, however
 * it went.
 *
 * AN UNDATED TASK IS NEVER OVERDUE EITHER, which is not leniency but the only
 * available answer: nothing can be late for a deadline that was never set. That
 * is why the report prints an Undated count beside the Overdue one -- the two
 * together are the whole picture, and either alone is a flattering half of it.
 */
function isOverdue(task: StatusReportTask, on: string): boolean {
  return task.status !== "done" && task.dueDate !== null && task.dueDate < on;
}

/**
 * The merge context for one project status report.
 *
 * **THE COUNTS ARE DERIVED FROM THE SAME ARRAY THE TABLE PRINTS, AND THAT IS THE
 * WHOLE REASON THEY ARE COMPUTED HERE RATHER THAN IN A QUERY.** A `SELECT
 * count(*) ... GROUP BY status` beside a separate `SELECT ... ORDER BY` would be
 * two reads of one thing, and the failure mode is specific and awful on a printed
 * page: a headline saying three tasks are overdue above a table showing four.
 * Nobody checks a headline against a table they were handed in the same document.
 * One array, counted once, is the only arrangement in which the two cannot
 * disagree.
 *
 * **NOTHING HERE IS RAW.** A task title, a project name and an assignee are plain
 * text in plain inputs, so a project called `<b>Rye Lane</b>` prints as itself
 * rather than restructuring the page. This type has no rich-text field at all --
 * the summary's notes and the letter's body are the only two `MergeHtml` values
 * in Conduit, and each exists because an operator typed markup into a field whose
 * whole purpose was markup.
 *
 * **NO PERCENTAGE OF THE PROJECT IS OFFERED, AND ITS ABSENCE IS A DECISION.**
 * `doneCount / taskCount` is trivial to compute and would be a lie: it weights a
 * three-day task the same as a three-month one, so "60% complete" is a claim
 * about effort made out of a count of rows. The per-task `progress` IS printed,
 * because that one is somebody's own estimate of their own task rather than
 * arithmetic this document invented. A template can have a project percentage the
 * day something in Conduit stores effort.
 *
 * NO `number` KEY, so a template naming one prints a blank -- right for a type
 * that has none (`documentTypeNumbered`), and free from the merge language's
 * unknown-path rule.
 */
export function buildStatusReportContext(input: StatusReportContextInput): MergeContext {
  const count = (predicate: (task: StatusReportTask) => boolean): string =>
    String(input.tasks.filter(predicate).length);
  return {
    org: orgContext(input.org),
    document: {
      issueDate: input.issueDate,
      projectName: input.projectName,
      projectStatus: PROJECT_STATUS_LABEL[input.status],
      // EMPTY STRING RATHER THAN LEFT OUT for a project with no dates. The
      // template's `{{#document.startDate}}` turns on emptiness and an absent key
      // resolves to `undefined`, which `isEmpty` also calls empty -- so the two
      // behave identically and only one of them says so. `?? ""` is the saying.
      startDate: input.startDate ?? "",
      dueDate: input.dueDate ?? "",
      owner: input.owner,
      company: input.company,
      taskCount: String(input.tasks.length),
      doneCount: count((task) => task.status === "done"),
      inProgressCount: count((task) => task.status === "in_progress"),
      blockedCount: count((task) => task.status === "blocked"),
      todoCount: count((task) => task.status === "todo"),
      overdueCount: count((task) => isOverdue(task, input.issueDate)),
      // COUNTED ON THE DUE DATE ALONE, and `tasks_dates_paired` is what makes
      // that the same question as "has no dates at all": the CHECK admits both
      // null or both set, never one. The due date is the half chosen because it
      // is the half the overdue rule turns on, so "undated" here means exactly
      // "not a task the Overdue count could ever have included".
      undatedCount: count((task) => task.dueDate === null),
    },
    // A report has no priced lines, so `{{#lines}}` renders nothing. Empty rather
    // than absent for buildMeetingSummaryContext's reason: MergeContext requires
    // it, and requiring it is what keeps every quote context honest.
    lines: [],
    tasks: input.tasks.map((task): MergeTask => ({
      title: task.title,
      status: TASK_STATUS_LABEL[task.status],
      startDate: task.startDate ?? "",
      dueDate: task.dueDate ?? "",
      progress: formatProgressPct(task.progressPct),
      assignee: task.assignee,
      // JOINED HERE RATHER THAN IN THE TEMPLATE, because the merge language has
      // no separator construct: a block over a list of names has no way to write
      // the last-item case, so `{{#after}}{{.}}, {{/after}}` would print a
      // trailing comma on every row that has one. The template gets one string
      // and asks only whether it is empty.
      after: task.after.join(", "),
    })),
  };
}

/**
 * Every unarchived task on a project, in the order the Gantt draws them, with
 * each one's predecessors named.
 *
 * **UNARCHIVED ONLY, AND UNLIKE `ganttPayload` THE UNDATED ONES ARE KEPT.** That
 * function excludes a task with no dates because a chart has nowhere to draw a
 * bar with no ends. A report is a table: it has a row for a task with no dates,
 * and that row is one somebody needs to see -- work nobody has scheduled is
 * exactly what a status report exists to surface, and it is the whole reason
 * there is no date range on this type. Archived tasks ARE excluded, because
 * archiving is how work leaves the plan and a report listing work nobody is doing
 * is a report about a different project.
 *
 * **THE ORDER IS THE GANTT'S, REUSED AND NOT COPIED** (`taskOutlineOrder`, and
 * the self-join it requires). Rejected: `listTasks`' `(parent_task_id, position)`,
 * which is right for a list a client regroups and wrong for a printed table
 * nobody can re-sort. Postgres sorts NULLs last on an ascending sort, so under
 * that ordering every ROOT task prints after every subtask and each parent is
 * separated from its own children by the whole rest of the project.
 *
 * **A PREDECESSOR IS NAMED EVEN WHEN IT IS NOT IN THE REPORT, WHICH IS THE
 * OPPOSITE OF `ganttPayload`'S RULE AND IS DELIBERATE.** That function drops an
 * edge whose other end is not in the payload, because a chart cannot draw an
 * arrow with one end missing. A table CAN print the name.
 *
 * THE CASE IS NOT HYPOTHETICAL, AND IT IS NOT THE ONE THAT LOOKS OBVIOUS.
 * `addDependency` refuses to link two tasks in different projects, so an edge
 * cannot be CREATED across a boundary -- but `updateTask` will move a task
 * between projects afterwards, and archiving one is ordinary. So the reachable
 * shape is a task waiting on something that has been ARCHIVED, or moved away:
 * the successor is still blocked, and a report that omitted the name would show
 * it as merely late with nothing said about what it is waiting for.
 *
 * Ordered by `created_at`, which is `listDependencies`' own order, so what is
 * printed and what the API returns are in the same order.
 *
 * TWO QUERIES AND NOT ONE, because a join to `task_dependencies` multiplies the
 * task rows by their edge count and the de-duplication would then happen in
 * TypeScript over a result whose ORDER BY had to survive it. The second query is
 * skipped entirely for a project with no tasks.
 */
async function loadReportTasks(tx: Database, projectId: string): Promise<StatusReportTask[]> {
  const rows = await tx.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    startDate: tasks.startDate,
    dueDate: tasks.dueDate,
    progressPct: tasks.progressPct,
    // `full_name` BEFORE `username`, which is `loadAttendeeNames`' precedence and
    // its reason: a CSV column wants the identifier an operator can join on, a
    // printed page wants "Chris Wilson" rather than "chris". `full_name` comes
    // from the auth header and is nullable, so the username is the fallback.
    fullName: users.fullName,
    username: users.username,
  }).from(tasks)
    .leftJoin(users, eq(tasks.assigneeUserId, users.id))
    // REQUIRED BY taskOutlineOrder: without this join Postgres refuses the query
    // outright ("missing FROM-clause entry") rather than ordering wrongly.
    .leftJoin(parentTasks, eq(tasks.parentTaskId, parentTasks.id))
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)))
    .orderBy(...taskOutlineOrder());

  const ids = rows.map((row) => row.id);
  const predecessors = alias(tasks, "predecessor_tasks");
  const edges = ids.length === 0 ? [] : await tx.select({
    successorId: taskDependencies.successorId,
    title: predecessors.title,
  }).from(taskDependencies)
    .innerJoin(predecessors, eq(taskDependencies.predecessorId, predecessors.id))
    .where(inArray(taskDependencies.successorId, ids))
    .orderBy(asc(taskDependencies.createdAt));

  return rows.map((row) => ({
    title: row.title,
    // The column is `text` with a CHECK rather than an enum, so the cast is where
    // `tasks_status_valid`'s promise is cashed into the shared union -- exactly
    // as `toDocumentRecord` casts `documents.type`.
    status: row.status as TaskStatus,
    startDate: row.startDate,
    dueDate: row.dueDate,
    progressPct: row.progressPct,
    assignee: row.fullName ?? row.username ?? "",
    after: edges.filter((edge) => edge.successorId === row.id).map((edge) => edge.title),
  }));
}

/** `documents` row -> the wire shape, for the second type whose content is not in it. */
function toStatusReportRecord(row: DocumentRow, projectId: string): StatusReportRecord {
  return {
    id: row.id,
    type: "project_status_report",
    // THE PROJECT COMES FROM THE CALLER, NOT FROM `row`, for the reason
    // toMeetingSummaryRecord takes its meetingId that way: `documents.project_id`
    // is nullable (a quote's is null) while this DTO's is not, so reading it off
    // the row would put a `!` or a `?? ""` here that no caller can reach and no
    // test could exercise. Both call sites have the id in hand.
    projectId,
    fileId: row.fileId,
    issueDate: row.issueDate,
    frozen: row.frozen,
    issuedByUserId: row.issuedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The longest a project's name may be inside a downloaded filename.
 *
 * `projects.name` has no upper bound in the schema or in
 * `createProjectInputSchema`, and `files.original_name` has none either -- the
 * meeting title's situation exactly, so it takes `SUMMARY_TITLE_CHARS`' figure
 * and its reason: 80 characters leaves the rest of the name well inside the
 * export's 180-BYTE member limit even when every character costs three bytes.
 */
const REPORT_TITLE_CHARS = 80;

/**
 * What a downloaded status report is called.
 *
 * `summaryFileName`'s and `letterFileName`'s third sibling, and it shares both of
 * their decisions. The name is not sanitised here (three places already have an
 * opinion about what a filename is, and a fourth would be a fourth opinion), and
 * the DATE is in it because this type can be produced again -- which for this
 * type is not an edge case but the whole point. A monthly report on one project
 * is twelve downloads a year, and twelve files called `Status report - Rye
 * Lane.pdf` land in a folder as `... (1).pdf` through `... (11).pdf`, numbered by
 * the order somebody downloaded them rather than the order they were written.
 */
function reportFileName(projectName: string, issueDate: string): string {
  const trimmed = projectName.trim().slice(0, REPORT_TITLE_CHARS);
  return `Status report - ${trimmed === "" ? "untitled" : trimmed} - ${issueDate}.pdf`;
}

/**
 * Produce the status report of a project. ONE TRANSACTION, AND NO INPUT AT ALL.
 *
 * ======================= THE DATE RANGE, AND WHY THERE IS NONE ==============
 *
 * **THE SPEC GIVES THIS TYPE "possibly a date range" AS ITS EXTRA INPUT AND THE
 * PLAN ASKED FOR THE QUESTION TO BE SETTLED BEFORE A FORM WAS BUILT FOR IT. IT IS
 * SETTLED NO.** A range could only be one of two things and both fail:
 *
 * 1. **A FILTER over which tasks appear.** `tasks_dates_paired` admits a task
 *    with NO dates -- both null, which is what every task looks like before
 *    anybody schedules it -- so a range has to decide what to do with one, and
 *    both answers are wrong. Drop them and the report silently omits exactly the
 *    tasks that most need attention, which is the same class of failure as the
 *    export's INNER JOIN dropping every meeting summary. Keep them and the range
 *    is not a filter. There is precedent for the first answer and it is precedent
 *    AGAINST: `ganttPayload` does drop undated tasks, because a chart has nowhere
 *    to draw a bar with no ends. A table has a row.
 *
 *    And even over dated tasks a range only subtracts. A window narrower than the
 *    project hides work; a window wider than it contains exactly the same tasks.
 *    The one genuinely interesting window -- "what changed since the last report"
 *    -- is not answerable from a range at all: it needs the previous report and a
 *    diff, `tasks` keeps no history, and reconstructing one from `events` is a
 *    different feature with a different name.
 *
 * 2. **A LABEL saying what period the report covers.** The project already has a
 *    start date and a due date and both are printed at the top of the page. A
 *    second, per-document range that can disagree with them is a second answer to
 *    "what period is this project", inside the document whose job is to be the
 *    answer.
 *
 * **SO THIS TYPE TAKES NO INPUT AT ALL, AND IT IS THE SECOND WITH NO FORM.** That
 * is the plan's fear inverted: it expected the broadest source to be larger than
 * it looks, and on the INPUT side this is the smallest type in the phase. All of
 * its breadth is on the READ -- a project, every task on it, their dependencies,
 * seven counts and an overdue rule -- and none of that is submitted by anybody.
 *
 * ============= THE ISSUE DATE IS THE SERVER'S, NOT THE OPERATOR'S ===========
 *
 * `issueMeetingSummary`'s arrangement and NOT `issueQuote`'s, and the reason is
 * sharper here than it was for the summary. A quote's issue date is
 * client-supplied because it is the operator's own choice about a document whose
 * content they also chose. A status report's content is read LIVE at the moment
 * it is produced, so a report an operator dated last Friday would print Friday's
 * date over today's tasks. That is not a preference, it is the document telling a
 * lie about itself -- and the same value is what the overdue count is measured
 * against, so a back-dated report would be arithmetically wrong as well.
 *
 * `todayInZone(org.timeZone)`, so the calendar day is the organisation's and not
 * the server's UTC one. v1.8.0's timezone field, third call site.
 *
 * =================== WHAT IT DOES **NOT** DO, EACH FOR A REASON =============
 *
 * - **NO NUMBER**, so no `allocateNumber`, so no row lock, so no `SET LOCAL
 *   lock_timeout` -- the summary's and the letter's arrangement.
 *   @conduit/shared's `documentTypeNumbered` has the three reasons, the third of
 *   which is the letter's turned inside out. The second one bites harder here
 *   than for either of them: "run this month's reports" is a sentence about every
 *   active project at once, and a number would make them queue.
 * - **NO FREEZE.** `frozen` is `documentTypeFreezes("project_status_report")`,
 *   which is `false`, written rather than defaulted for the reason 0016 dropped
 *   the DEFAULT.
 * - **NO DETAIL TABLE**, which is the second type to need none and the second
 *   distinct reason. A meeting summary needs none because its content is the
 *   `meetings` row it points at. This one needs none because its content is a
 *   `projects` row, the `tasks` on it and their `task_dependencies` -- and unlike
 *   a letter's body, not one byte of it was typed into this document. There is
 *   nothing here that is not already stored somewhere it is maintained.
 *
 *   THE ONE THING A DETAIL TABLE WOULD HAVE BOUGHT is a snapshot of the counts,
 *   so a Documents list could say "12 of 20 done" without re-reading the project.
 *   Rejected: that is a cache of a page which is already stored, in a table that
 *   would then have to be kept truthful against a PDF nothing can regenerate, to
 *   spare one query on a list of single-digit length.
 * - **NO UPDATE PATH.** Producing a report again appends a SECOND document with
 *   its own PDF; it does not rewrite the first. `redraftLetter` refuses anything
 *   that is not a letter and says so, which is a refusal this type inherits
 *   rather than one it needed.
 *
 * THE ORDER IS `issueMeetingSummary`'s: read the project, read the template, read
 * the issuer profile, read the tasks, merge, check the caps, render, write the
 * blob, insert the file, insert the document. Everything attributable to the
 * caller fails before anything spawns. The blob write is the one part that cannot
 * roll back, for `issueQuote`'s reason exactly.
 */
export async function issueStatusReport(
  db: Database,
  deps: IssueQuoteDeps,
  actorId: string,
  projectId: string,
): Promise<StatusReportRecord> {
  const record = await db.transaction(async (tx) => {
    const [project] = await tx.select({
      name: projects.name,
      status: projects.status,
      startDate: projects.startDate,
      dueDate: projects.dueDate,
      archivedAt: projects.archivedAt,
      companyName: companies.name,
      ownerFullName: users.fullName,
      ownerUsername: users.username,
    }).from(projects)
      .leftJoin(companies, eq(projects.companyId, companies.id))
      .leftJoin(users, eq(projects.ownerUserId, users.id))
      .where(eq(projects.id, projectId));
    if (project === undefined) throw new NotFoundError("project", projectId);
    // issueQuote's refusal of an archived deal, on the record this document is
    // of. attachFile re-checks it a moment later from inside the same
    // transaction; this one is what makes the refusal arrive before a subprocess
    // has run.
    if (project.archivedAt !== null) throw new ArchivedError("project", projectId);

    const templateHtml = await loadTemplateBody(tx, "project_status_report");
    const org = await getOrgProfile(tx);
    const issueDate = todayInZone(org.timeZone);
    const reportTasks = await loadReportTasks(tx, projectId);

    const file = await renderAndStore(tx, deps, actorId, {
      noun: "status report",
      templateHtml,
      context: buildStatusReportContext({
        org, issueDate,
        projectName: project.name,
        status: project.status as ProjectStatus,
        startDate: project.startDate,
        dueDate: project.dueDate,
        owner: project.ownerFullName ?? project.ownerUsername ?? "",
        company: project.companyName ?? "",
        tasks: reportTasks,
      }),
      // NAMES THE TASK COUNT, because that is the only term of this document's
      // size an operator has any purchase on. A quote's provenance offers three
      // levers and the summary's offers the notes; here there is no submission to
      // trim and no notes -- there is a project with as many tasks as it has, and
      // a report that will not render is a project somebody has to split up.
      provenance: "Its template is "
        + `${String(Buffer.byteLength(templateHtml, "utf8"))} bytes, its logo `
        + `${String(org.logoDataUri.length)}, and it lists `
        + `${String(reportTasks.length)} task(s)`,
      originalName: reportFileName(project.name, issueDate),
      target: { projectId },
    });

    const [row] = await tx.insert(documents).values({
      // SPELLED OUT RATHER THAN OMITTED, as the summary's and the letter's are.
      // `number` is nullable, so leaving it off would insert the same NULL -- but
      // this is where a reader finds out that a status report has none.
      number: null,
      type: "project_status_report", projectId, fileId: file.id,
      issueDate,
      frozen: documentTypeFreezes("project_status_report"),
      issuedByUserId: actorId,
    }).returning();
    if (row === undefined) throw new Error("document insert returned no row");

    // NO SECOND INSERT, and its absence is the data model working -- see the
    // header. What 0020 adds instead is `documents_entity_matches_type`, which
    // makes this insert's `projectId` obligatory rather than conventional: a
    // report written against a company would now be a refused INSERT rather than
    // a document nothing displays.
    return toStatusReportRecord(row, projectId);
  });

  publish({ keys: [["project-documents", projectId], ["files"], ["events"]] });
  return record;
}

/**
 * Every status report produced for a project, newest first.
 *
 * `listMeetingSummaries`' twin, down to the reasoning. NO JOIN, because a
 * report's content is the project the client already has open. FILTERED BY TYPE
 * as well as by project, though nothing else attaches to a project today: it is
 * what makes `toStatusReportRecord`'s literal `type` true rather than assumed,
 * and the moment a second project-attached type exists this function keeps
 * meaning what its name says instead of quietly widening.
 *
 * SERVED BY documents_project_idx (0020). This is the read that made that index
 * worth building -- 0017 named it ("project with the status report") and 0019
 * declined to build it early, on the grounds that an index maintained by every
 * INSERT and used by no SELECT is a cost with no reader.
 */
export async function listProjectDocuments(
  db: Database, projectId: string,
): Promise<StatusReportRecord[]> {
  const rows = await db.select().from(documents)
    .where(and(
      eq(documents.projectId, projectId),
      eq(documents.type, "project_status_report"),
    ))
    .orderBy(desc(documents.createdAt), desc(documents.id));
  return rows.map((row) => toStatusReportRecord(row, projectId));
}
