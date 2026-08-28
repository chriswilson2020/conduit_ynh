// Money arithmetic for documents. Integer-only, on purpose: a quote's total is
// printed on a PDF, stored in three bigint columns and shown in a form, and all
// four have to agree exactly.
//
// UNITS. Quantities are THOUSANDTHS (qtyMilli: 1500 is 1.5). Prices are CENTS. Tax
// rates are BASIS POINTS (2100 is 21%). Nothing here accepts a fractional number, so
// nothing here can drift.
//
// Both api and web import this, through @conduit/shared's barrel -- the same route
// midpoint() takes out of fractional.ts, and the only route there is: the package
// exports "." alone. The form's running total and the stored total are therefore the
// same function, not two implementations that agree until they do not.
//
// THE INTERMEDIATE PRODUCTS ARE BigInt, and that is not decoration. A line's
// qty x price is formed before it is divided back down, and that product leaves the
// double-precision safe range long before either factor does. Measured, not feared:
// at qtyMilli 3603500 and unitPriceCents 9999999903,
// `Math.trunc((qtyMilli * unitPriceCents + 500) / 1000)` returns 36034999650460
// where the exact answer is 36034999650461. One cent, on a line no real quote
// carries -- but the reason this file exists rather than three inline
// multiplications is that its rounding is provable, and "provable except above
// 2^53" is not that.
//
// EVERY INPUT AND EVERY RESULT IS CHECKED to be a safe integer, and a violation
// THROWS. That guard is load-bearing rather than defensive: the totals land in
// `bigint` columns read through drizzle's `mode: "number"`, whose range stops at
// Number.MAX_SAFE_INTEGER while Postgres's stops at 2^63 -- so an unchecked total
// past the first would be written as whatever double happened to be nearest and
// stored without complaint. A caller holding user input (the quote form) must parse
// its text into these integer units and reject what does not parse BEFORE calling:
// a half-typed field is a validation error to show, never a total to render.

/** One line of a document, in the units above. `taxRateBp` absent means zero-rated. */
export interface LineInput {
  qtyMilli: number;
  unitPriceCents: number;
  taxRateBp?: number;
}

export interface DocumentTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Reject anything a money column cannot hold exactly, naming the field that broke. */
function exact(name: string, value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`money: ${name} must be a safe integer, got ${String(value)}`);
  }
  return BigInt(value);
}

// Postgres int4, which is the type of document_line_items.qty_milli and
// .tax_rate_bp. schema.test.ts asserts both columns are still `integer`, so
// widening one without widening the other fails there rather than here.
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

/**
 * The same check against a narrower column. THE ACCEPTED DOMAIN AND THE STORABLE
 * DOMAIN HAVE TO BE THE SAME, and for `qty_milli` they were not: a safe integer is
 * 4.2 million times wider than an int4, so a 3,000,000-unit line used to compute a
 * correct running total in the form, pass documentTotals, RENDER THE PDF, and only
 * then die on the INSERT with `integer out of range` -- inside the issuing
 * transaction, after the subprocess had already run, as an opaque 500 for a value
 * the form had just told the user was fine. Rejecting here is rejecting before
 * anything spawns.
 *
 * This is the inverse of the asymmetry on `unit_price_cents`, where the column is
 * int8 and the safe-integer check above is correctly the narrower of the two.
 *
 * NOT the CHECK-constraint bounds (qty_milli >= 0, tax_rate_bp BETWEEN 0 AND 10000).
 * Those are business rules and belong to the input schema, the same "Zod is the
 * primary gate, the CHECK is the backstop" split the schema comments describe --
 * and this file deliberately keeps a wider domain there, since divideRoundHalfUp's
 * negative branch exists so a future credit note rounds correctly.
 */
function exactInt4(name: string, value: number): bigint {
  const result = exact(name, value);
  if (value < INT4_MIN || value > INT4_MAX) {
    throw new Error(`money: ${name} must fit a 32-bit integer column, got ${String(value)}`);
  }
  return result;
}

/** The same check on the way out -- see the header: bigint columns outrun `number`. */
function toNumber(name: string, value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`money: ${name} left the safe integer range: ${value.toString()}`);
  }
  return result;
}

/**
 * Divide by `divisor` rounding half AWAY FROM ZERO. Both call sites pass an even
 * divisor, so `divisor / 2n` is exact and the tie lands one whole unit up.
 *
 * Quantities and prices are constrained non-negative by CHECK constraints on
 * document_line_items, so this is half-up in practice; the negative branch exists so
 * a future credit note cannot silently round the wrong way.
 */
function divideRoundHalfUp(value: bigint, divisor: bigint): bigint {
  const half = divisor / 2n;
  return value >= 0n ? (value + half) / divisor : -((-value + half) / divisor);
}

/** What one line costs before tax: quantity x unit price, rounded to the cent. */
export function lineTotalCents(line: LineInput): number {
  const product = exactInt4("qtyMilli", line.qtyMilli) * exact("unitPriceCents", line.unitPriceCents);
  return toNumber("lineTotalCents", divideRoundHalfUp(product, 1000n));
}

/** Tax on one line total at a basis-point rate, rounded to the cent. */
export function taxCents(lineTotal: number, rateBp: number): number {
  const product = exact("lineTotal", lineTotal) * exactInt4("rateBp", rateBp);
  return toNumber("taxCents", divideRoundHalfUp(product, 10_000n));
}

/**
 * Totals for a whole document. Tax is computed PER LINE and summed, never applied to
 * the summed subtotal -- the two differ by a cent on inputs as ordinary as two lines
 * of 0.05 at 50%, and that difference is the one an accountant notices.
 */
export function documentTotals(lines: readonly LineInput[]): DocumentTotals {
  let subtotal = 0n;
  let tax = 0n;
  for (const line of lines) {
    const total = lineTotalCents(line);
    subtotal += BigInt(total);
    tax += BigInt(taxCents(total, line.taxRateBp ?? 0));
  }
  return {
    subtotalCents: toNumber("subtotalCents", subtotal),
    taxCents: toNumber("taxCents", tax),
    totalCents: toNumber("totalCents", subtotal + tax),
  };
}
