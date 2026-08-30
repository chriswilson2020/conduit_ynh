import {
  DOCUMENT_CONTENT_BUDGET_BYTES, documentContentBytes, documentTotals, issueQuoteInputSchema,
} from "@conduit/shared";
import type { DocumentTotals, IssueQuoteInput } from "@conduit/shared";

/**
 * THE INPUT BOUNDARY OF THE QUOTE FORM: text a keyboard produces, turned into
 * the integer units money.ts works in, or refused.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than a `Number()` call in the component.
 * `documentTotals` THROWS on a non-integer or an unsafe one -- Task 2 made it
 * strict deliberately, so a bad value cannot reach a `bigint` column silently
 * -- and there is NO ERROR BOUNDARY anywhere in packages/web/src. A throw
 * raised while rendering the running total therefore unmounts the whole form
 * and takes the half-filled quote with it. Every value is parsed and bounded
 * HERE, before anything reaches that function.
 *
 * This app has no testing-library and no jsdom, so a component is provable
 * only through e2e. The logic a unit test can hold -- the parse, the budget
 * arithmetic, and what a half-typed field contributes -- lives in this module
 * for exactly that reason, which is the same split board-lib.ts, inbox-lib.ts
 * and nav-lib.ts already make.
 */

/**
 * A parsed field, with EMPTY SEPARATE FROM INVALID.
 *
 * They differ in what the user is told, not in what the total does: both
 * contribute a zero line, but "a quantity is required" and "a quantity may
 * have at most 3 decimal places" are different sentences, and collapsing them
 * would tell somebody who typed `1e5` that they had typed nothing.
 */
export type ParsedUnits =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "ok"; readonly units: number };

/** A field's unit conversion: how many decimal places it carries, and its ceiling. */
export interface UnitSpec {
  /** Named in the message a user reads, so it reads as a sentence about their field. */
  readonly label: string;
  /** Decimal places the smallest unit represents: 3 for thousandths, 2 for cents. */
  readonly decimals: number;
  /** The largest storable value IN THE SMALLEST UNIT. */
  readonly max: number;
  /** How `max` reads back to a person, in the units they typed. */
  readonly maxLabel: string;
}

/**
 * THE THREE CEILINGS ARE THE COLUMNS', NOT ROUND NUMBERS. `qty_milli` and
 * `tax_rate_bp` are int4 and `unit_price_cents` is a bigint read through
 * drizzle's number mode, which is what caps it at MAX_SAFE_INTEGER --
 * documentLineInputSchema states the same three, and this file exists to keep
 * a value that would fail it out of the arithmetic in the first place.
 */
export const QTY_SPEC: UnitSpec = {
  label: "quantity", decimals: 3, max: 2_147_483_647, maxLabel: "2,147,483.647",
};
export const UNIT_PRICE_SPEC: UnitSpec = {
  label: "unit price", decimals: 2, max: Number.MAX_SAFE_INTEGER, maxLabel: "90,071,992,547,409.91",
};
export const TAX_RATE_SPEC: UnitSpec = {
  label: "tax rate", decimals: 2, max: 10_000, maxLabel: "100",
};

/**
 * Digits, optionally split by ONE separator, and nothing else.
 *
 * Deliberately not `Number()` (which lib.ts's parseDecimal uses, correctly,
 * for a deal's value where a float IS the destination). Two reasons it cannot
 * be used here. `Number` accepts `1e5`, `0x10`, `Infinity` and leading `+`,
 * none of which anyone means to type into a quantity box.
 *
 * And the conversion afterwards would be a float multiply, which does not
 * land on an integer. MEASURED, at both scales this form converts at:
 * `1.001 * 1000` is 1000.9999999999999, `8.87 * 100` is 886.9999999999999 and
 * `17.17 * 100` is 1717.0000000000002. `documentTotals` demands a SAFE INTEGER
 * and throws on every one of those, which is the crash this module exists to
 * prevent -- and a `Math.round` over the top would only hide it, since the
 * defect it is hiding is a cent, which is the classic defect in this feature.
 * Digits are shifted as a STRING and read with BigInt, so the conversion is
 * exact for every input it accepts.
 *
 * (An earlier version of this paragraph cited `1.115 * 1000` as 1114.99...;
 * it is exactly 1115, and the test that asserted otherwise is what caught it.
 * The numbers above are measured.)
 *
 * A comma is accepted as the separator beside a dot, the same tolerance
 * parseDecimal documents for a keyboard outside en-US.
 */
const DECIMAL = /^(\d*)(?:[.,](\d*))?$/;

export function parseUnits(text: string, spec: UnitSpec): ParsedUnits {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };

  const match = DECIMAL.exec(trimmed);
  if (match === null) {
    return { kind: "invalid", message: `a ${spec.label} must be a plain number` };
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  // A lone separator: the regex is happy with both halves empty, and there is
  // no number there. `1.` and `.5` ARE numbers and are accepted below.
  if (whole === "" && fraction === "") {
    return { kind: "invalid", message: `a ${spec.label} must be a plain number` };
  }
  if (fraction.length > spec.decimals) {
    return {
      kind: "invalid",
      message: `a ${spec.label} may have at most ${String(spec.decimals)} decimal places`,
    };
  }

  // Shift into the smallest unit by padding the fraction, not by multiplying.
  const digits = whole + fraction.padEnd(spec.decimals, "0");
  const units = BigInt(digits === "" ? "0" : digits);
  if (units > BigInt(spec.max)) {
    return { kind: "invalid", message: `a ${spec.label} may be at most ${spec.maxLabel}` };
  }
  // Safe by construction: `units` is at or below a ceiling that is itself at
  // or below MAX_SAFE_INTEGER, so this conversion cannot lose a digit.
  return { kind: "ok", units: Number(units) };
}

/**
 * What a field contributes to the RUNNING TOTAL: its value, or zero.
 *
 * Zero rather than a refusal, because the total is shown while somebody types
 * and a partial figure is the useful answer. What must never happen is the
 * throw -- and it cannot, since every branch here returns a bounded integer.
 * Submission is gated separately, by buildIssueQuoteInput.
 */
export function unitsOrZero(parsed: ParsedUnits): number {
  return parsed.kind === "ok" ? parsed.units : 0;
}

/** One line of the form, as text, exactly as it is typed. */
export interface DraftLine {
  /** Local only. Keys the row so React does not re-key on reorder or removal. */
  readonly id: string;
  readonly description: string;
  readonly qty: string;
  readonly unitPrice: string;
  readonly taxRate: string;
}

/** The whole form, as text. */
export interface DraftQuote {
  readonly issueDate: string;
  readonly validUntilDate: string;
  readonly recipientName: string;
  readonly recipientContactName: string;
  /**
   * v1.1.0's snapshot field. It defaults from the contact's salutation and is
   * editable before issuing like every other recipient field -- and once issued
   * it is frozen on the documents row, so editing the contact's title next year
   * cannot rewrite a quote sent last year. PRONOUNS ARE DELIBERATELY NOT HERE:
   * a quote's greeting takes the salutation and has no use for them, and
   * freezing a personal detail into an artifact that is downloaded and emailed
   * should need a reason.
   */
  readonly recipientSalutation: string;
  readonly recipientAddress: string;
  readonly notes: string;
  readonly terms: string;
  readonly lines: readonly DraftLine[];
}

/**
 * The four recipient fields a deal can fill in for you, as they arrive.
 *
 * A DEAL'S COMPANY AND CONTACT ARE SEPARATE QUERIES, and they resolve after the
 * page does. See reseedRecipients for what that costs and why it is not
 * cosmetic here.
 */
export interface RecipientDefaults {
  readonly recipientName: string;
  readonly recipientContactName: string;
  readonly recipientSalutation: string;
  readonly recipientAddress: string;
}

export const RECIPIENT_DEFAULT_FIELDS = [
  "recipientName", "recipientContactName", "recipientSalutation", "recipientAddress",
] as const;

/**
 * WHAT TO ADOPT WHEN A DEFAULT ARRIVES LATE, WITHOUT CLOBBERING AN EDIT.
 *
 * THE BUG THIS EXISTS FOR IS THE WORST KIND THIS FEATURE CAN HAVE, because the
 * artifact is IMMUTABLE. The form seeds its draft from props at mount, and a
 * deal's company and contact are their own queries: opening "New quote" before
 * they resolve gave a recipient with a blank salutation and a blank contact
 * name, while the page's own Contact row rendered the name a second later.
 * Issue in that window and the quote is frozen wrong for ever -- it cannot be
 * corrected, only re-raised under a new number. `recipientContactName` had this
 * before v1.1.0; the salutation makes it one field wider.
 *
 * `touched` IS AN EXPLICIT SET, AND THE STRING COMPARISON IT REPLACED WAS WRONG
 * IN EXACTLY THE WINDOW THIS FUNCTION EXISTS FOR. The first version compared
 * the draft against the LAST SEEDED default and called them equal-means-
 * untouched. During the loading window that default is `""` -- and so is a
 * field the user has just CLEARED, which is the one thing the rule was supposed
 * to tell apart. Measured with the contact GET held open four seconds: typing
 * into both recipient fields and then clearing them had both overwritten when
 * the query landed. A set recorded on every edit cannot make that mistake,
 * because it remembers the ACT rather than trying to infer it from the value.
 *
 * A GATE ON THE "New quote" BUTTON WAS THE OTHER OPTION AND IS STILL WORSE.
 * "Disabled until the data is here" reads the same as "disabled" when a query
 * FAILS, and a deal whose company 404s would lose the ability to raise a quote
 * at all with nothing on screen to say why. What the form does instead is hold
 * the SUBMIT while the defaults are in flight, with a line saying so -- see
 * document-form.tsx, and note that "in flight" and "not arrived" are different
 * predicates on purpose.
 *
 * Returns only the fields to change, so an unchanged draft keeps its identity
 * and the form does not re-render for nothing.
 */
export function reseedRecipients(
  current: RecipientDefaults,
  incoming: RecipientDefaults,
  touched: ReadonlySet<keyof RecipientDefaults>,
): Partial<RecipientDefaults> {
  // Mutable inside, readonly to the caller: RecipientDefaults' fields carry
  // `readonly`, which Partial<> preserves.
  const over: { -readonly [K in keyof RecipientDefaults]?: RecipientDefaults[K] } = {};
  for (const field of RECIPIENT_DEFAULT_FIELDS) {
    if (touched.has(field)) continue;
    if (current[field] === incoming[field]) continue;
    over[field] = incoming[field];
  }
  return over;
}

export interface ParsedLine {
  readonly qty: ParsedUnits;
  readonly unitPrice: ParsedUnits;
  readonly taxRate: ParsedUnits;
}

export function parseDraftLine(line: DraftLine): ParsedLine {
  return {
    qty: parseUnits(line.qty, QTY_SPEC),
    unitPrice: parseUnits(line.unitPrice, UNIT_PRICE_SPEC),
    taxRate: parseUnits(line.taxRate, TAX_RATE_SPEC),
  };
}

/**
 * The running total, or null if these lines cannot have one.
 *
 * THE try/catch IS NOT DEFENSIVE PADDING AND THE NULL BRANCH IS REACHABLE.
 * Every value handed over is already a bounded integer, so no single line can
 * break the arithmetic -- but the ceilings are per FIELD, and a line at the
 * top of two of them overflows the representable range on its own
 * (2,147,483.647 units at MAX_SAFE_INTEGER cents), which is the fourth failure
 * path issueQuoteInputSchema's superRefine exists to answer as a 400. Here it
 * is a total that reads as unavailable instead of a form that unmounts.
 */
export function runningTotals(lines: readonly DraftLine[]): DocumentTotals | null {
  const parsed = lines.map((line) => {
    const units = parseDraftLine(line);
    return {
      qtyMilli: unitsOrZero(units.qty),
      unitPriceCents: unitsOrZero(units.unitPrice),
      taxRateBp: unitsOrZero(units.taxRate),
    };
  });
  try {
    return documentTotals(parsed);
  } catch {
    return null;
  }
}

/** How much of the render budget this draft has spent. */
export interface BudgetState {
  /** Escaped UTF-8 bytes this quote's own content is predicted to cost. */
  readonly used: number;
  readonly budget: number;
  /** Negative once the draft is over: the form says by how much. */
  readonly remaining: number;
  readonly over: boolean;
}

/**
 * The budget, computed with the SAME function the server's gate uses, so the
 * figure in the form and the reason for a 400 cannot disagree.
 *
 * It is a prediction, and the authoritative check is the merged size measured
 * in issueQuote -- see DOCUMENT_CONTENT_BUDGET_BYTES for the four ways the
 * prediction can be wrong. Showing it is still worth it: the failure it
 * prevents is a quote typed in full and refused on submit, and the failure it
 * cannot prevent arrives as a 413 whose message names the template, the logo
 * and the content separately.
 */
export function contentBudget(draft: DraftQuote): BudgetState {
  const used = documentContentBytes({
    recipientName: draft.recipientName,
    recipientContactName: draft.recipientContactName,
    // EVERY FIELD THE SERVER'S GATE COUNTS, and this one is easy to omit
    // because documentContentBytes takes it OPTIONALLY: leaving it out is not
    // a type error, it is a form that under-reports against a budget the
    // server measures with the same function. BY UP TO 320 BYTES, not 64: the
    // cap is 64 CHARACTERS and `escapedBytes` charges an `&` five bytes, so a
    // salutation of 64 ampersands is 320 -- a byte budget and a character cap
    // are different quantities, and this file is the wrong place to confuse
    // them. The guard is
    // derived rather than written out -- contentBudget's test walks the keys
    // of DOCUMENT_FIELD_CAPS, which is exactly the set of capped text fields a
    // quote carries, and charges each one in turn.
    recipientSalutation: draft.recipientSalutation,
    recipientAddress: draft.recipientAddress,
    notes: draft.notes,
    terms: draft.terms,
    lines: draft.lines.map((line) => ({ description: line.description })),
  });
  return {
    used,
    budget: DOCUMENT_CONTENT_BUDGET_BYTES,
    remaining: DOCUMENT_CONTENT_BUDGET_BYTES - used,
    over: used > DOCUMENT_CONTENT_BUDGET_BYTES,
  };
}

/**
 * WHAT EACH SCHEMA PATH IS CALLED ON THE PAGE SOMEBODY IS LOOKING AT.
 *
 * The keys are the wire field names; the values are what the form labels them.
 * A key missing from here falls back to the RAW WIRE NAME, so the failure mode
 * is a user reading "Line 1 qtyMilli: ..." rather than anything breaking.
 *
 * TWO TESTS KEEP IT COMPLETE, AND IT TOOK BOTH.
 *
 * The first drives the real schema with one deliberately bad draft per field
 * and asserts the sentence begins with the label. It caught the seven entries
 * an earlier round deleted -- but it is a HAND-WRITTEN CASE LIST, so it could
 * not catch a field being ADDED: v1.1.0 put `recipientSalutation` into
 * issueQuoteInputSchema and that test stayed green while the form was ready to
 * print the wire name at somebody.
 *
 * So the second is derived: it walks `issueQuoteInputSchema.shape` and
 * `documentLineInputSchema.shape` and requires an entry here for every key.
 * `lines` is the one exclusion, and it is a real one rather than a hole --
 * describeLinesIssue answers for the whole set, and that test names it.
 *
 * Exported for those tests, which is the only reason it is not file-local.
 */
export const FIELD_LABELS: Record<string, string> = {
  issueDate: "Issue date",
  validUntilDate: "Valid-until date",
  recipientName: "Recipient",
  recipientContactName: "Contact name",
  recipientSalutation: "Salutation",
  recipientAddress: "Address",
  notes: "Notes",
  terms: "Terms",
  description: "description",
  qtyMilli: "quantity",
  unitPriceCents: "unit price",
  taxRateBp: "tax rate",
};

/** The subset of a Zod issue this needs, so no zod type has to be imported. */
export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
  /** "string", "number" or "array" on a size failure -- what the bound counts. */
  readonly origin?: string;
  readonly maximum?: unknown;
  readonly minimum?: unknown;
}

/** How a size bound reads, which depends on WHAT IS BEING COUNTED. */
function amount(origin: string | undefined, bound: unknown): string {
  const n = String(bound);
  if (origin === "string") return `${n} characters`;
  if (origin === "array") return `${n} items`;
  return n;
}

/**
 * The whole-quote failures, whose path is `lines` with no index.
 *
 * THREE OF THE FIVE SHAPES THAT REACH THIS ARM ARE ZOD'S OWN ENGLISH, which an
 * earlier version of this file did not know: it passed everything here straight
 * through on the grounds that the message "says so on its own", and that is true
 * only of the two CUSTOM refinements (the budget and the unrepresentable total).
 * The array bounds and the type failure read "Too small: expected array to have
 * >=1 items", which is a sentence about a JSON payload, not about a quote.
 */
function describeLinesIssue(issue: SchemaIssue): string {
  if (issue.code === "too_small") return "A quote needs at least one line item.";
  if (issue.code === "too_big") {
    return `A quote may have at most ${String(issue.maximum)} line items.`;
  }
  if (issue.code === "invalid_type") return "The line items are missing.";
  // The two custom refinements, which already say what they mean.
  return issue.message;
}

/**
 * One schema issue as a sentence that names the box it is about.
 *
 * THE PATH IS THE WHOLE POINT, and throwing it away is what this function was
 * written to stop. `issue.message` alone is Zod's own English about a JSON
 * value: an empty Recipient -- which is the DEFAULT STATE of any deal with no
 * linked company -- produced "Too small: expected string to have >=1
 * characters", and that was the entire feedback beside two valid lines and a
 * total on screen. The per-field parse above deliberately reports first so
 * somebody gets a sentence about the box they are looking at; this is the same
 * courtesy for every field that parse does not cover.
 *
 * MEASURED, NOT ASSUMED, because two reviews disagreed about it. Every failure
 * path of issueQuoteInputSchema was enumerated against zod 4.4.3 -- 27 of them,
 * covering every field, both dates, all four line fields, the array bounds, both
 * custom refinements and six wrong-type cases. **The literal string "Invalid
 * input" is emitted for NONE of them.** What Zod actually produces is "Too
 * small: expected string to have >=1 characters", "Too big: expected array to
 * have <=60 items", "Invalid ISO date", and "Invalid input: expected string,
 * received undefined" -- descriptive, and none of them naming a field. An
 * earlier version of this comment, and four lines of the plan, said every
 * refusal read "Invalid input"; that was wrong about the string and right about
 * the consequence, and the code now says which.
 *
 * Size failures get a purpose-written sentence because Zod's are unreadable to
 * anyone who did not write the schema. Everything else keeps the schema's
 * message, which for the custom refinements is already a good one -- it just
 * never said which field it meant.
 */
export function describeIssue(issue: SchemaIssue): string {
  const [head, index, leaf] = issue.path;
  let display = "";
  if (head === "lines") {
    // `lines` with NO index is a claim about the whole SET; with an index but no
    // leaf it is a claim about one whole LINE (a line that is not an object at
    // all), and the line number is worth keeping rather than discarding.
    if (typeof index !== "number") return describeLinesIssue(issue);
    const field = leaf === undefined ? "" : FIELD_LABELS[String(leaf)] ?? String(leaf);
    display = field === "" ? `Line ${String(index + 1)}` : `Line ${String(index + 1)} ${field}`;
  } else if (head !== undefined) {
    display = FIELD_LABELS[String(head)] ?? String(head);
  }

  if (display === "") return issue.message;
  if (issue.code === "too_small" && issue.minimum === 1 && issue.origin === "string") {
    return `${display} is required.`;
  }
  // THE UNIT COMES FROM `origin`, NOT FROM AN ASSUMPTION THAT EVERYTHING IS
  // TEXT. Written as "characters" for every bound, a negative quantity read
  // "Line 1 quantity is shorter than the 0 characters required" -- nonsense
  // about a number. Unreachable today only because parseUnits refuses a minus
  // sign before the schema ever sees it, which is exactly the kind of accident
  // that stops being true when a bound moves.
  if (issue.code === "too_small") {
    return `${display} is below the minimum of ${amount(issue.origin, issue.minimum)}.`;
  }
  if (issue.code === "too_big") {
    return `${display} is over the maximum of ${amount(issue.origin, issue.maximum)}.`;
  }
  return `${display}: ${issue.message}`;
}

export type BuildResult =
  | { readonly ok: true; readonly input: IssueQuoteInput }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The draft as the API's own input, or the list of reasons it is not ready.
 *
 * TWO GATES IN SEQUENCE, AND THE ORDER IS FOR THE READER'S SAKE. The per-field
 * parse runs first and, if anything failed it, returns without calling Zod:
 * "line 2: a quantity must be a plain number" is a sentence about the box
 * somebody is looking at, and running the schema over a zero substituted for
 * that box would bury it under a second complaint about a total.
 *
 * When the parse is clean, issueQuoteInputSchema -- the SAME schema the route
 * and the service parse -- decides. Re-implementing its bounds here would be a
 * second answer to the question of what a valid quote is, and the two would
 * drift; this way the only way the form and the server disagree is if the form
 * is running against a different build of the package.
 *
 * Its issues go through describeIssue rather than being read for their message,
 * because the message alone is "Invalid input" for every size and type failure
 * and the PATH is what says which box. See that function.
 */
export function buildIssueQuoteInput(draft: DraftQuote): BuildResult {
  const problems: string[] = [];
  const lines = draft.lines.map((line, index) => {
    const where = `Line ${String(index + 1)}`;
    if (line.description.trim() === "") problems.push(`${where}: a description is required.`);
    const units = parseDraftLine(line);
    for (const [parsed, spec] of [
      [units.qty, QTY_SPEC], [units.unitPrice, UNIT_PRICE_SPEC], [units.taxRate, TAX_RATE_SPEC],
    ] as const) {
      if (parsed.kind === "empty") problems.push(`${where}: a ${spec.label} is required.`);
      else if (parsed.kind === "invalid") problems.push(`${where}: ${parsed.message}`);
    }
    return {
      description: line.description.trim(),
      qtyMilli: unitsOrZero(units.qty),
      unitPriceCents: unitsOrZero(units.unitPrice),
      taxRateBp: unitsOrZero(units.taxRate),
    };
  });
  if (problems.length > 0) return { ok: false, problems };

  const parsed = issueQuoteInputSchema.safeParse({
    issueDate: draft.issueDate,
    validUntilDate: draft.validUntilDate === "" ? null : draft.validUntilDate,
    recipientName: draft.recipientName.trim(),
    recipientContactName: draft.recipientContactName.trim(),
    // TRIMMED HERE AND NOT ON THE CONTACT, and the two are different fields
    // doing different jobs. The contact's salutation must survive exactly as
    // typed -- that is what "Other..." is for. This is the printed line of a
    // letter, sitting between two other trimmed name fields, and the template
    // sets it beside the recipient's name: a trailing space typed into this box
    // becomes a visible double space on a PDF nobody can reissue.
    recipientSalutation: draft.recipientSalutation.trim(),
    recipientAddress: draft.recipientAddress,
    notes: draft.notes,
    terms: draft.terms,
    lines,
  });
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => describeIssue(issue)) };
  }
  return { ok: true, input: parsed.data };
}
