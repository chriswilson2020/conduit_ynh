import { DEFAULT_TIME_ZONE } from "@conduit/shared";

/**
 * The Settings -> Organisation page's pure logic, kept out of the page so it can be
 * unit-tested without a DOM -- the same split settings-data-lib.ts and
 * settings-mail-lib.ts already make, and for the same reason: this package's vitest
 * environment is `node`, so what is not extracted is only ever exercised by
 * Playwright.
 *
 * There is exactly one decision on this page and v1.8.0 brought it: which timezones
 * the picker offers.
 */

/**
 * Every zone this browser knows, or an empty list if it will not say.
 *
 * **THE PLATFORM SHIPS THE LIST, THIS REPOSITORY DOES NOT.** A curated array of
 * IANA names in the source tree would be a copy of tzdata that ages, and it would
 * age separately from the ICU that has to format the date -- so an operator could
 * pick a zone the engine had never heard of, from a list that looked authoritative.
 * `Intl.supportedValuesOf` is the same data the formatter uses.
 *
 * GUARDED, because it is the one API here that a browser might not have:
 * `supportedValuesOf` is ES2022 (Chrome 99, Firefox 93, Safari 15.4), and vite's
 * default baseline in this project reaches back to Firefox 104 -- above it, but not
 * by so much that a `typeof` check is theatre. A browser without it still gets a
 * usable picker, because {@link timeZoneOptions} adds the default and whatever is
 * already stored regardless of what this returns.
 */
export function supportedTimeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supported !== "function") return [];
  try {
    return supported("timeZone");
  } catch {
    return [];
  }
}

/**
 * What the zone `<select>` offers, given what the platform lists and what is
 * already stored.
 *
 * **UTC HAS TO BE ADDED BY HAND, AND THAT IS THE WHOLE REASON THIS FUNCTION
 * EXISTS.** `Intl.supportedValuesOf("timeZone")` returns 418 `Area/Location` names
 * and does not contain `UTC`, `GMT` or anything under `Etc/` -- measured, not
 * assumed. So a select built straight from that list omits the value the column
 * ships with, and an install that had never touched this field would open Settings,
 * see some unrelated zone selected, and save it.
 *
 * **THE STORED VALUE IS ALWAYS PRESENT**, whatever it is, for the sharper version
 * of the same failure. A row can hold a zone this browser's list does not have --
 * an older browser against a name coined since, a newer one against `Asia/Calcutta`
 * where it now says `Asia/Kolkata`, a restore from another install, or a value that
 * has genuinely stopped being a zone. A `<select>` whose `value` matches no option
 * renders with NOTHING selected and submits the first option, so leaving it out
 * would turn "your zone is unusual" into "your zone was silently replaced by
 * Africa/Abidjan", on a page the operator opened to look at something else.
 *
 * UTC FIRST AND THE REST ALPHABETICAL. UTC is the default and the "I do not want a
 * local clock" answer, so it belongs at the top rather than buried between
 * `US/...` and nothing; everything else sorts, because 418 items are only findable
 * in an order. An unrecognised stored value sorts in with the rest -- the page says
 * it is unrecognised in words (see `timeZoneProblem`), which is clearer than a
 * position in a list.
 */
export function timeZoneOptions(stored: string, supported: readonly string[]): string[] {
  const rest = new Set(supported);
  rest.delete(DEFAULT_TIME_ZONE);
  // An empty stored value is the one thing not worth an option: it cannot be
  // selected meaningfully and `timeZoneProblem` already says what is wrong with it.
  if (stored !== "" && stored !== DEFAULT_TIME_ZONE) rest.add(stored);
  return [DEFAULT_TIME_ZONE, ...[...rest].sort((a, b) => a.localeCompare(b, "en"))];
}
