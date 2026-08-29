// Turning integer cents into something a person reads. Separate from money.ts on
// purpose: that file is arithmetic and stays format-free, because the moment a
// formatter lives beside a total somebody computes with the formatted string.
//
// WHY THIS EXISTS AT ALL, and it is not precision. Five places in web each wrote
// `new Intl.NumberFormat(undefined, ...)`. `undefined` means THE VIEWER'S BROWSER
// LOCALE, so a quote form's running total read "EUR 11.000,00" on a Dutch browser
// while the PDF the server rendered beside it read "EUR 11,000.00". Two numbers
// disagreeing on one screen, about the document the user is checking.
//
// So the locale is a value this package owns rather than a property of whoever is
// looking. MONEY_LOCALE is the single knob; the parameter defaults to it rather
// than being required at each call, because the failure being prevented is two
// call sites disagreeing, and a default cannot be typed differently in six places.
//
// THIS FUNCTION NEVER THROWS, and that is a hard rule rather than a preference.
// It is display code with no error boundary anywhere in packages/web to catch it
// -- no ErrorBoundary, no componentDidCatch, no router errorComponent -- so a
// throw here unmounts the application rather than degrading a label. An earlier
// version of this file refused amounts above a measured exactness ceiling, which
// turned an approximate figure into a blank screen: `deals.value_cents` accepts
// any safe integer, and board-lib.ts sums a stage's deals into a plain number
// before formatting, so two API-legal deals could add up to a crash.
//
// EXACTNESS COMES FROM THE STRING, NOT FROM A CEILING. The decimal is built out
// of the integer with BigInt -- no divide by 100 in double precision anywhere --
// and handed to Intl as a STRING, which Intl.NumberFormat V3 formats exactly at
// any magnitude. Verified on Node 24.19.0, which is what CI and the server both
// run: "1234567890123456789.99" comes back with every digit intact.
//
// On an engine older than Intl V3 (Firefox before 116 is the one inside this
// app's build target, since vite's default baseline reaches back to Firefox 104)
// `format` coerces its argument with ToNumber, so the string becomes the same
// double the old code passed and the result is the same approximation it always
// produced. Degrading to the previous behaviour is the worst case; throwing is
// not among the cases.

/**
 * The one locale every money figure in Conduit is formatted in, server and client
 * alike. Change it here and the PDF and the form move together; change it at a
 * call site and you have reintroduced the bug this module exists for.
 */
export const MONEY_LOCALE = "en-GB";

/**
 * The exact decimal for an integer number of cents, e.g. -1250 -> "-12.50".
 * BigInt throughout, so no magnitude loses a digit on the way through.
 *
 * The return type is the template-literal `${number}` rather than `string`, and the
 * assertion is what earns it. TypeScript types Intl's string overload as
 * `StringNumericLiteral`, which is exactly `${number} | "Infinity" | ...` -- a type
 * only a string LITERAL can satisfy, so a computed string is rejected however
 * well-formed it is (lib.es2023.intl.d.ts:48). Asserting here, where the shape is
 * established -- optional minus, digits, a point, two digits -- keeps the assertion
 * next to the thing that makes it true and leaves the call site honestly typed.
 */
function exactDecimal(cents: number): `${number}` {
  const value = BigInt(cents);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const units = absolute / 100n;
  const rest = absolute % 100n;
  const decimal = `${negative ? "-" : ""}${units.toString()}.${rest.toString().padStart(2, "0")}`;
  return decimal as `${number}`;
}

/**
 * Format integer cents as a currency string.
 *
 * `currency` is an ISO 4217 code -- `documents.currency` and `deals.currency` both
 * carry a `^[A-Z]{3}$` CHECK, so anything reaching here from the database is
 * valid. Intl does throw a RangeError on a code that is not, which is the one
 * failure this function cannot swallow and also one no stored row can cause.
 *
 * ALWAYS TWO DECIMAL PLACES GO IN; the currency decides how many come out. That
 * is Conduit's stored model -- 100 minor units per major, since `deals.value_cents`
 * in Phase 2 -- and it means a zero-decimal currency like JPY reads 1,100,000 back
 * as 11,000 yen. Unchanged from the five call sites this replaced, and a column
 * problem rather than a formatting one, but the string makes the assumption
 * explicit where the old `/ 100` left it incidental.
 */
export function formatMoneyCents(cents: number, currency: string, locale: string = MONEY_LOCALE): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  // A non-integer or non-finite value is a caller bug rather than a large amount,
  // and it reaches Intl the way it always did: NaN prints as NaN. Refusing it
  // here would put the crash back into display code for the one input class that
  // is already a symptom of something else being wrong.
  if (!Number.isSafeInteger(cents)) return format.format(cents / 100);
  return format.format(exactDecimal(cents));
}

/**
 * The exact decimal for an integer number of THOUSANDTHS, e.g. 1500 -> "1.5".
 *
 * Trailing zeros are trimmed because a quantity is not money: "2" reads as a count
 * where "2.000" reads as a measurement, and the money columns beside it on the page
 * are already carrying two fixed decimal places.
 */
function exactMilliDecimal(milli: number): `${number}` {
  const value = BigInt(milli);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const units = absolute / 1000n;
  const fraction = (absolute % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  const decimal = `${negative ? "-" : ""}${units.toString()}${fraction === "" ? "" : `.${fraction}`}`;
  return decimal as `${number}`;
}

/**
 * Format a quantity in thousandths, e.g. 1500 -> "1.5", 2000 -> "2".
 *
 * HERE RATHER THAN INLINE IN buildContext for the same reason formatMoneyCents
 * exists: the quote form's quantity column and the rendered PDF's have to read the
 * same, and two call sites each dividing by 1000 are two call sites that can
 * disagree about grouping and about the locale.
 *
 * Exact by the same route as the money above -- the decimal is built out of the
 * integer with BigInt and handed to Intl as a STRING, so no thousandth is lost to a
 * divide. `qty_milli` is an int4, so the largest quantity a line can hold is
 * 2,147,483.647.
 *
 * NEVER THROWS, like everything else in this file; see the header.
 */
export function formatQtyMilli(qtyMilli: number, locale: string = MONEY_LOCALE): string {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  if (!Number.isSafeInteger(qtyMilli)) return format.format(qtyMilli / 1000);
  return format.format(exactMilliDecimal(qtyMilli));
}

/**
 * Format a tax rate in basis points, e.g. 2100 -> "21%", 750 -> "7.5%".
 *
 * Intl's percent style multiplies by 100, so what is handed to it is the RATE (0.21),
 * built exactly from the integer for the same reason as above: bp/10000 in double
 * precision is not exact for most rates, and a quote printing "20.999999%" is a
 * defect the customer sees before we do.
 *
 * Two fraction digits, which is exactly the resolution a basis point has (1bp is
 * 0.01%). `tax_rate_bp` is CHECKed to 0..10000, so the printable range is 0%..100%.
 */
export function formatTaxRateBp(taxRateBp: number, locale: string = MONEY_LOCALE): string {
  const format = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  if (!Number.isSafeInteger(taxRateBp)) return format.format(taxRateBp / 10_000);
  const value = BigInt(taxRateBp);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const units = absolute / 10_000n;
  const fraction = (absolute % 10_000n).toString().padStart(4, "0");
  return format.format(`${negative ? "-" : ""}${units.toString()}.${fraction}` as `${number}`);
}
