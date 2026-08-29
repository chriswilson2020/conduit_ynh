import { describe, expect, it } from "vitest";
import { lineTotalCents, taxCents, documentTotals } from "./money.js";

describe("lineTotalCents", () => {
  it("multiplies a whole quantity by a unit price", () => {
    expect(lineTotalCents({ qtyMilli: 3000, unitPriceCents: 1250 })).toBe(3750);
  });

  it("handles a fractional quantity", () => {
    expect(lineTotalCents({ qtyMilli: 1500, unitPriceCents: 1000 })).toBe(1500);
  });

  // The half-cent boundary is the entire reason this function exists rather than
  // being written inline at three call sites with three different roundings.
  it("rounds a half cent UP, not to even", () => {
    // 0.5 x 1 cent = 0.5 cents exactly.
    expect(lineTotalCents({ qtyMilli: 500, unitPriceCents: 1 })).toBe(1);
  });

  it("rounds below the half cent DOWN", () => {
    expect(lineTotalCents({ qtyMilli: 499, unitPriceCents: 1 })).toBe(0);
  });

  // The negative branch of divideRoundHalfUp, which no shipped path reaches today
  // (both columns carry non-negative CHECKs) but a credit note would. Half AWAY FROM
  // ZERO, so this is -1 rather than the 0 a truncating divide would give.
  it("rounds a negative half cent away from zero", () => {
    expect(lineTotalCents({ qtyMilli: -500, unitPriceCents: 1 })).toBe(-1);
  });

  // THE BigInt TEST, and it is the one that fails against a double-precision
  // implementation. qtyMilli * unitPriceCents here is 3.6e16, past 2^53, so the
  // product is already rounded before the divide ever happens:
  // Math.trunc((3603500 * 9999999903 + 500) / 1000) is 36034999650460.
  it("is exact when the intermediate product passes 2^53", () => {
    expect(lineTotalCents({ qtyMilli: 3_603_500, unitPriceCents: 9_999_999_903 }))
      .toBe(36_034_999_650_461);
  });

  it("rejects a fractional quantity rather than storing a fraction of a cent", () => {
    expect(() => lineTotalCents({ qtyMilli: 1.5, unitPriceCents: 1000 })).toThrow(/qtyMilli/);
  });

  // A form field that has not parsed must not reach a bigint column as NaN.
  it("rejects NaN", () => {
    expect(() => lineTotalCents({ qtyMilli: Number.NaN, unitPriceCents: 1000 })).toThrow(/qtyMilli/);
  });

  // Postgres's bigint reaches 2^63; drizzle's mode:"number" reaches 2^53. A line
  // total between the two would be stored as the nearest double and accepted
  // silently, so it is refused here instead.
  it("refuses a line total past the safe integer range", () => {
    // Both factors are individually legal -- 1,000 units at a price that is a
    // safe integer -- and it is their PRODUCT, divided back down, that is not.
    expect(() => lineTotalCents({ qtyMilli: 1_000_000, unitPriceCents: 9_007_199_254_740_991 }))
      .toThrow(/safe integer range/);
  });

  // qty_milli is an int4 column. A safe integer is 4.2 MILLION times wider, and
  // that gap is not a rounding curiosity: it is a line that renders a PDF and
  // then dies on the INSERT.
  it("accepts a quantity at the top of the int4 column", () => {
    // 2,147,483.647 units at one cent each.
    expect(lineTotalCents({ qtyMilli: 2_147_483_647, unitPriceCents: 1 })).toBe(2_147_484);
  });

  it("refuses a quantity one step past the int4 column", () => {
    expect(() => lineTotalCents({ qtyMilli: 2_147_483_648, unitPriceCents: 1 }))
      .toThrow(/qtyMilli must fit a 32-bit integer column/);
  });

  // BOTH ENDS OF int4, because the lower one is the end a credit note rides and
  // the end SV-1's fix never exercised: deleting `value < INT4_MIN ||` from
  // exactInt4 left every other test in this file green. int4 is asymmetric
  // (-2^31 .. 2^31-1), so the two bounds are different numbers and neither
  // implies the other.
  it("accepts a quantity at the bottom of the int4 column", () => {
    expect(lineTotalCents({ qtyMilli: -2_147_483_648, unitPriceCents: 1 })).toBe(-2_147_484);
  });

  it("refuses a quantity one step below the int4 column", () => {
    expect(() => lineTotalCents({ qtyMilli: -2_147_483_649, unitPriceCents: 1 }))
      .toThrow(/qtyMilli must fit a 32-bit integer column/);
  });

  // The reproduction, in the units a user would type: 3,000,000 of something.
  // Before this bound it computed a correct running total, passed
  // documentTotals, rendered the PDF, and failed on INSERT with
  // `integer out of range` -- after the subprocess had run.
  it("refuses a three-million-unit line before anything can spawn a renderer", () => {
    expect(() => lineTotalCents({ qtyMilli: 3_000_000_000, unitPriceCents: 5000 }))
      .toThrow(/qtyMilli must fit a 32-bit integer column/);
  });
});

describe("taxCents", () => {
  it("applies a basis-point rate to a line total", () => {
    expect(taxCents(10_000, 2100)).toBe(2100);
  });

  it("rounds half up", () => {
    // 1 cent at 50% = 0.5 cents.
    expect(taxCents(1, 5000)).toBe(1);
  });

  it("returns zero for a zero rate", () => {
    expect(taxCents(9999, 0)).toBe(0);
  });

  it("rejects a fractional rate", () => {
    expect(() => taxCents(10_000, 21.5)).toThrow(/rateBp/);
  });

  // tax_rate_bp is int4 too, and has the same shape of failure as qty_milli --
  // the CHECK narrows it further to 0..10000, which is the input schema's job.
  it("refuses a rate past the int4 column", () => {
    expect(() => taxCents(10_000, 2_147_483_648)).toThrow(/rateBp must fit a 32-bit integer column/);
  });

  it("refuses a rate below the int4 column, and accepts its floor", () => {
    expect(taxCents(0, -2_147_483_648)).toBe(0);
    expect(() => taxCents(10_000, -2_147_483_649)).toThrow(/rateBp must fit a 32-bit integer column/);
  });
});

describe("documentTotals", () => {
  it("sums line totals and per-line tax", () => {
    const totals = documentTotals([
      { qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100 },
      { qtyMilli: 1000, unitPriceCents: 1000, taxRateBp: 0 },
    ]);
    expect(totals).toEqual({ subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100 });
  });

  // Tax per line then summed, NOT tax on the summed subtotal. These differ by a cent
  // on exactly this input, and the difference is what an accountant notices.
  it("taxes each line rather than the subtotal", () => {
    const lines = [
      { qtyMilli: 1000, unitPriceCents: 5, taxRateBp: 5000 },
      { qtyMilli: 1000, unitPriceCents: 5, taxRateBp: 5000 },
    ];
    // Per line: round(2.5) = 3 each, so 6. On the subtotal: round(5) = 5.
    expect(documentTotals(lines).taxCents).toBe(6);
  });

  it("treats an omitted tax rate as zero-rated", () => {
    expect(documentTotals([{ qtyMilli: 1000, unitPriceCents: 5000 }]))
      .toEqual({ subtotalCents: 5000, taxCents: 0, totalCents: 5000 });
  });

  it("returns zeroes for no lines", () => {
    expect(documentTotals([])).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });

  // The document total is the sum of subtotal and tax and nothing else -- the same
  // identity documents_totals_consistent asserts as a CHECK on the stored row.
  it("returns a total that is exactly subtotal plus tax", () => {
    const totals = documentTotals([
      { qtyMilli: 1234, unitPriceCents: 5678, taxRateBp: 2100 },
      { qtyMilli: 7000, unitPriceCents: 999, taxRateBp: 900 },
      { qtyMilli: 1, unitPriceCents: 1, taxRateBp: 10_000 },
    ]);
    expect(totals.totalCents).toBe(totals.subtotalCents + totals.taxCents);
  });

  // Sums accumulate in BigInt too, so a document whose lines are individually fine
  // but whose total is not is refused rather than truncated on the way into bigint.
  it("refuses a document whose summed total leaves the safe integer range", () => {
    const line = { qtyMilli: 1000, unitPriceCents: 9_007_199_254_740_000 };
    expect(() => documentTotals([line, line])).toThrow(/safe integer range/);
  });
});
