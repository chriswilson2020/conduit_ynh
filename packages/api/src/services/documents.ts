import { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  documentTemplateInputSchema, documentTotals, documentTypeFreezes, formatDocumentInstant,
  formatMoneyCents, formatQtyMilli,
  documentContentBytes, formatTaxRateBp, issueQuoteInputSchema, lineTotalCents,
  MAX_TEMPLATE_BYTES, renderInputCost, RENDER_IMAGE_CAP_BYTES, RENDER_IMAGE_PIXEL_CAP,
  RENDER_MARKUP_CAP_BYTES,
  type DocumentRecord, type DocumentTemplate, type DocumentTemplateInput,
  type IssueQuoteInput, type MeetingSummaryRecord, type OrgProfile,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  contacts, deals, documentLineItems, documentQuotes, documents, documentTemplates,
  meetingAttendees, meetings, users,
  type DocumentLineItemRow, type DocumentQuoteRow, type DocumentRow,
} from "../db/schema.js";
import { allocateNumber } from "./documents-number.js";
import { renderPdf } from "./documents-render.js";
import {
  documentTemplateErrors, documentTemplateWarnings, MergeHtml, prepareDocumentHtml,
  sanitizeDocumentHtml, type MergeContext,
} from "./documents-template.js";
import { getOrgProfile } from "./org-profile.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { todayDateOnly } from "./scheduling.js";
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
  /** Exactly one, matching the `documents` row this file is about to belong to. */
  target: { dealId?: string; meetingId?: string };
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
      meetingWhen: formatDocumentInstant(input.occurredAt),
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

    // SERVER-AUTHORITATIVE, AND UTC, which is scheduling.ts's `todayDateOnly` and
    // its documented +/-2h caveat. There is no input to take an issue date from --
    // that is what "the type with no form" means -- and a client-supplied one would
    // be a field on a form that does not exist.
    const issueDate = todayDateOnly();
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
