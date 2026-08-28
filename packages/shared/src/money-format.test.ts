import { describe, expect, it } from "vitest";
import { formatMoneyCents, MONEY_LOCALE } from "./money-format.js";

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

  // THE POINT OF THE MODULE. Under the old `undefined` locale this same call
  // returned a different string on a Dutch browser than on a British one, so a
  // quote form's running total and the PDF beside it disagreed about the same
  // money. Pinning both sides here is what makes that a test rather than a hope.
  it("does not depend on the environment's locale", () => {
    expect(formatMoneyCents(1_100_000, "EUR")).toBe(formatMoneyCents(1_100_000, "EUR", MONEY_LOCALE));
    expect(formatMoneyCents(1_100_000, "EUR", "nl-NL")).toContain("11.000,00");
    expect(formatMoneyCents(1_100_000, "EUR")).not.toContain("11.000,00");
  });

  // CONDUIT'S MONEY MODEL IS 100 MINOR UNITS PER MAJOR, EVERYWHERE, and has
  // been since deals.value_cents in Phase 2: the divide is by 100 and the
  // decimal places then come from the currency itself. For a currency with no
  // minor unit those two facts disagree, and this pins what actually happens
  // rather than pretending otherwise -- 1,100,000 stored reads as 11,000 yen,
  // not 1,100,000. That is a limitation of the stored model, identical to the
  // one the five call sites this replaced already had, and NOT something a
  // formatter can fix; a zero-decimal currency needs the columns to change.
  it("divides by 100 and leaves the decimal places to the currency", () => {
    const formatted = formatMoneyCents(1_100_000, "JPY");
    expect(formatted).toContain("11,000");
    expect(formatted).not.toContain(".");
  });

  it("rejects a non-integer", () => {
    expect(() => formatMoneyCents(12.5, "EUR")).toThrow(/safe integer/);
    expect(() => formatMoneyCents(Number.NaN, "EUR")).toThrow(/safe integer/);
  });

  // The measured boundary: 7,036,874,417,766,401 is the first value whose
  // formatting disagrees with the exact decimal, so the domain stops one below
  // it rather than at Number.MAX_SAFE_INTEGER, which money.ts would allow.
  it("formats the largest exactly-formattable amount and refuses the first one past it", () => {
    expect(formatMoneyCents(7_036_874_417_766_400, "EUR")).toContain("70,368,744,177,664.00");
    expect(() => formatMoneyCents(7_036_874_417_766_401, "EUR")).toThrow(/cannot be formatted exactly/);
    expect(() => formatMoneyCents(-7_036_874_417_766_401, "EUR")).toThrow(/cannot be formatted exactly/);
  });
});
