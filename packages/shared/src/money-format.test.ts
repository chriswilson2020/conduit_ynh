import { describe, expect, it } from "vitest";
import { formatMoneyCents, formatQtyMilli, formatTaxRateBp, MONEY_LOCALE } from "./money-format.js";

// The currency SYMBOLS are deliberately not asserted: they are non-ASCII, this
// repo's sources are ASCII-only, and the symbol is not what was ever in doubt.
// What is asserted is the part `undefined` was getting wrong -- the grouping and
// decimal separators, which is exactly where en-GB and nl-NL disagree.
describe("formatMoneyCents", () => {
  it("formats whole and part cents in the shared locale", () => {
    expect(formatMoneyCents(1_100_000, "EUR")).toContain("11,000.00");
    expect(formatMoneyCents(0, "EUR")).toContain("0.00");
    expect(formatMoneyCents(5, "EUR")).toContain("0.05");
  });

  it("formats a negative amount", () => {
    const formatted = formatMoneyCents(-1250, "EUR");
    expect(formatted).toContain("12.50");
    expect(formatted.startsWith("-")).toBe(true);
  });

  // THE VALUE ITSELF, not merely "some locale". A silent change here moves every
  // money figure in the app, on both sides of a quote, and nothing else would
  // notice: the separator assertions below pass for en-US too.
  it("pins the shared locale to en-GB", () => {
    expect(MONEY_LOCALE).toBe("en-GB");
  });

  // THE POINT OF THE MODULE. Under the old `undefined` locale this same call
  // returned a different string on a Dutch browser than on a British one, so a
  // quote form's running total and the PDF beside it disagreed about the same
  // money. Pinning both sides here is what makes that a test rather than a hope.
  it("does not depend on the environment's locale", () => {
    expect(formatMoneyCents(1_100_000, "EUR")).toBe(formatMoneyCents(1_100_000, "EUR", MONEY_LOCALE));
    expect(formatMoneyCents(1_100_000, "EUR", "nl-NL")).toContain("11.000,00");
    expect(formatMoneyCents(1_100_000, "EUR")).not.toContain("11.000,00");
  });

  // CONDUIT'S MONEY MODEL IS 100 MINOR UNITS PER MAJOR, EVERYWHERE, and has been
  // since deals.value_cents in Phase 2: two decimal places always go in, and the
  // currency decides how many come out. For a currency with no minor unit those
  // disagree, and this pins what actually happens rather than pretending
  // otherwise -- 1,100,000 stored reads as 11,000 yen, not 1,100,000. A
  // limitation of the columns, identical to the one the five call sites this
  // replaced already had, and not something a formatter can fix.
  it("puts two decimal places in and lets the currency decide how many come out", () => {
    const formatted = formatMoneyCents(1_100_000, "JPY");
    expect(formatted).toContain("11,000");
    expect(formatted).not.toContain(".");
  });

  // EXACTNESS AT EVERY MAGNITUDE, which is what the BigInt decimal buys. The
  // first two are the values a `cents / 100` divide gets wrong: 7,036,874,417,766,401
  // is the smallest integer whose double quotient formats as ...664.02 for an
  // exact ...664.01 (measured; identical in en-GB, nl-NL, en-US and de-DE,
  // because the loss happens before Intl sees the number). An earlier version of
  // this module REFUSED both, which is the regression these replace.
  it("is exact past the point a double divide stops being", () => {
    expect(formatMoneyCents(7_036_874_417_766_401, "EUR")).toContain("70,368,744,177,664.01");
    expect(formatMoneyCents(-7_036_874_417_766_401, "EUR")).toContain("70,368,744,177,664.01");
    // The top of what deals.value_cents accepts (z.number().int().safe()), which
    // the old ceiling put ~1.97e15 cents below the line.
    expect(formatMoneyCents(9_007_199_254_740_991, "EUR")).toContain("90,071,992,547,409.91");
    expect(formatMoneyCents(7_036_874_417_766_400, "EUR")).toContain("70,368,744,177,664.00");
  });

  // NO INPUT MAKES THIS THROW. There is no error boundary in packages/web, so a
  // throw in a label unmounts the app; the previous version's ceiling turned two
  // summed deals -- board-lib.ts adds a stage's cents in a plain number -- into
  // exactly that. A value outside the safe-integer range falls back to the
  // approximation the five replaced call sites always produced.
  it("never throws, whatever it is handed", () => {
    for (const value of [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      12.5, 1e300, -1e300, 2 ** 53, 5e15 + 5e15,
    ]) {
      expect(() => formatMoneyCents(value, "EUR")).not.toThrow();
    }
    expect(formatMoneyCents(Number.NaN, "EUR")).toContain("NaN");
  });
});

// The other two columns of a quote's line table. They live here rather than inline
// in the API's buildContext for the reason formatMoneyCents does: the running total
// in the form and the printed page must agree, and a formatter written twice is two
// answers waiting to diverge.
describe("formatQtyMilli", () => {
  it("prints thousandths as a decimal, trimming what a quantity does not need", () => {
    expect(formatQtyMilli(1500)).toBe("1.5");
    expect(formatQtyMilli(2000)).toBe("2");
    expect(formatQtyMilli(0)).toBe("0");
    expect(formatQtyMilli(1)).toBe("0.001");
    expect(formatQtyMilli(1250)).toBe("1.25");
  });

  it("groups in the shared locale rather than the environment's", () => {
    expect(formatQtyMilli(1_234_500)).toBe("1,234.5");
    expect(formatQtyMilli(1_234_500, "nl-NL")).toBe("1.234,5");
  });

  it("is exact to the thousandth at the top of the int4 column", () => {
    // qty_milli is an integer column, so this is the largest quantity a line can
    // hold. 2147483647/1000 is not representable as a double, which is why the
    // decimal is built from the integer rather than divided out of it.
    expect(formatQtyMilli(2_147_483_647)).toBe("2,147,483.647");
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53]) {
      expect(() => formatQtyMilli(value)).not.toThrow();
    }
  });
});

describe("formatTaxRateBp", () => {
  it("prints basis points as a percentage", () => {
    expect(formatTaxRateBp(2100)).toBe("21%");
    expect(formatTaxRateBp(900)).toBe("9%");
    expect(formatTaxRateBp(0)).toBe("0%");
    expect(formatTaxRateBp(10_000)).toBe("100%");
  });

  it("keeps the resolution a basis point actually has", () => {
    // 1bp is 0.01%, so two fraction digits is the whole domain rather than a
    // rounding choice -- and the divide route does not land on it exactly: 2137/100
    // is 21.370000000000000995 and 1/100 is 0.010000000000000000208, which is why the
    // decimal is built out of the integer with BigInt instead.
    //
    // An earlier version of this comment said "750bp through a double divide is
    // 0.075000000000000005", and both halves were wrong: 750/10000 evaluates to
    // 0.074999999999999997224 (printing as "0.075"), the cited literal is a
    // DIFFERENT double (0.075000000000000011102), and this function divides by 100
    // rather than 10000 anyway -- 750/100 is exactly 7.5. Measured in node.
    expect(formatTaxRateBp(750)).toBe("7.5%");
    expect(formatTaxRateBp(1)).toBe("0.01%");
    expect(formatTaxRateBp(2137)).toBe("21.37%");
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2 ** 53]) {
      expect(() => formatTaxRateBp(value)).not.toThrow();
    }
  });
});
