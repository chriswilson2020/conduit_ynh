// Turning integer cents into something a person reads. Separate from money.ts on
// purpose: that file is arithmetic and stays format-free, because the moment a
// formatter lives beside a total somebody computes with the formatted string.
//
// WHY THIS EXISTS AT ALL, and it is not precision. Five places in web each wrote
// `new Intl.NumberFormat(undefined, ...)`. The float divide in them is fine -- a
// review measured zero drift over 400,000 samples and at 1e15 cents -- but
// `undefined` means THE VIEWER'S BROWSER LOCALE, so a quote form's running total
// reads "EUR 11.000,00" on a Dutch browser while the PDF the server rendered
// beside it reads "EUR 11,000.00". Two numbers disagreeing on one screen, about
// the document the user is checking.
//
// So the locale is a value this package owns rather than a property of whoever is
// looking. MONEY_LOCALE is the single knob; the parameter defaults to it rather
// than being required at each call, because the failure being prevented is two
// call sites disagreeing, and a default cannot be typed differently in six places.

/**
 * The one locale every money figure in Conduit is formatted in, server and client
 * alike. Change it here and the PDF and the form move together; change it at a
 * call site and you have reintroduced the bug this module exists for.
 */
export const MONEY_LOCALE = "en-GB";

// MEASURED, not derived. `cents / 100` is exact for every integer up to
// 7,036,874,417,766,400 -- the first value whose formatting disagrees with the
// exact decimal is 7,036,874,417,766,401 (70368744177664.01, formatted as
// ...664.02), and it is 2^46 units, where a double's spacing first exceeds half a
// cent. Identical in en-GB, nl-NL, en-US and de-DE, because the loss happens in
// the divide before Intl ever sees the number.
//
// money.ts's own ceiling is Number.MAX_SAFE_INTEGER, which is higher, so a sliver
// exists where a total is storable but not exactly formattable. Refusing it keeps
// this function correct across the whole of its accepted domain, which is the
// same rule the arithmetic follows.
const MAX_EXACT_CENTS = 7_036_874_417_766_400;

/**
 * Format integer cents as a currency string.
 *
 * `currency` is an ISO 4217 code -- `documents.currency` and `deals.currency` both
 * carry a `^[A-Z]{3}$` CHECK, so anything reaching here from the database is
 * valid, and Intl throws a RangeError on anything that is not.
 *
 * The divide is by 100 and the decimal places then come from the currency, which
 * are two facts that only agree for the currencies with a hundredth. Conduit's
 * stored model has been 100 minor units per major since `deals.value_cents` in
 * Phase 2, so a zero-decimal currency like JPY is already outside what the
 * columns represent -- 1,100,000 stored reads back as 11,000 yen. That is
 * unchanged from the five call sites this replaced, and it is a column problem
 * rather than a formatting one; the test pins the behaviour so it stays visible.
 */
export function formatMoneyCents(cents: number, currency: string, locale: string = MONEY_LOCALE): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`money-format: cents must be a safe integer, got ${String(cents)}`);
  }
  if (cents > MAX_EXACT_CENTS || cents < -MAX_EXACT_CENTS) {
    throw new Error(`money-format: ${String(cents)} cannot be formatted exactly`);
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
