import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsFolder } from "../db/client.js";

/**
 * The seeded quote template, read out of the migration that inserts it.
 *
 * IT HAS TO BE READ FROM THE FILE RATHER THAN THE DATABASE. `truncateAll()` empties
 * every table in the public schema before each test, so on the shared `conduit_test`
 * database the seeded row is gone by the time any test body runs -- a test that
 * expected to find it would silently be testing nothing, and one that UPDATEd it
 * would update zero rows and prove nothing. Every suite that wants the real template
 * therefore seeds its own row from this.
 *
 * Two files needed the same seven lines (the render check that this template still
 * produces a page, and the merge-context check that every field it names is
 * supplied), which is where `test/pdf.ts` came from too: the third copy is the one
 * that goes stale.
 */
export function seededQuoteTemplate(): string {
  const sql = readFileSync(join(migrationsFolder(), "0009_calm_rhodey.sql"), "utf8");
  const match = /VALUES \('quote', '([\s\S]*)'\);\s*$/.exec(sql);
  if (match?.[1] === undefined) throw new Error("could not find the seeded quote template in 0009");
  return match[1].replaceAll("''", "'");
}

/**
 * Every merge token the seeded template names, as paths: `{{#org.email}}`,
 * `{{org.email}}` and `{{/org.email}}` all reduce to `org.email`.
 *
 * This is the list `buildContext` is checked against. `schema.test.ts` separately
 * asserts the template's raw token set equals a literal list written out beside it --
 * which pins what the template MAY contain, but connects neither side to the code
 * that supplies the values. An unknown path renders as "" and never throws, so
 * supplying `document.subTotal` for `{{document.subtotal}}` leaves every test green
 * and prints a blank where a total should be. Reading the paths out of the template
 * itself is what closes that.
 */
export function seededTemplatePaths(): string[] {
  const template = seededQuoteTemplate();
  const paths = new Set<string>();
  for (const [, path] of template.matchAll(/\{\{[#^/]?([A-Za-z][A-Za-z0-9_.]*)\}\}/g)) {
    if (path !== undefined) paths.add(path);
  }
  return [...paths].sort();
}
