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
  readonly recipientAddress: string;
  readonly notes: string;
  readonly terms: string;
  readonly lines: readonly DraftLine[];
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
    recipientAddress: draft.recipientAddress,
    notes: draft.notes,
    terms: draft.terms,
    lines,
  });
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, input: parsed.data };
}
