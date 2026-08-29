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
 * Every merge path the seeded template names, SPLIT BY THE SCOPE IT IS RESOLVED IN.
 *
 * This is the list `buildContext` is checked against. `schema.test.ts` separately
 * asserts the template's raw token set equals a literal list written out beside it --
 * which pins what the template MAY contain, but connects neither side to the code
 * that supplies the values. An unknown path renders as "" and never throws, so
 * supplying `document.subTotal` for `{{document.subtotal}}` leaves every test green
 * and prints a blank where a total should be. Reading the paths out of the template
 * itself is what closes that.
 *
 * THE SPLIT MATTERS, and a flat list quietly loses it. Inside `{{#lines}}` a bare
 * `{{qty}}` resolves against the line; at the top level the same token resolves
 * against the root and renders empty. A test that pooled both would count `{{qty}}`
 * as supplied wherever it appeared, and a template that moved a line field out of its
 * block would keep passing while printing a blank.
 *
 * `{{#lines}}` and `{{^lines}}` themselves are root paths -- the block is a field of
 * the root context -- and their closers are not counted twice.
 */
export interface SeededTemplatePaths {
  /** Resolved against the root context: `org.*`, `document.*` and `lines` itself. */
  root: string[];
  /** Resolved against one line, inside `{{#lines}}`: `description`, `qty`, ... */
  line: string[];
}

export function seededTemplatePaths(): SeededTemplatePaths {
  const template = seededQuoteTemplate();
  const root = new Set<string>();
  const line = new Set<string>();
  let depth = 0;
  for (const match of template.matchAll(/\{\{([#^/]?)([A-Za-z][A-Za-z0-9_.]*)\}\}/g)) {
    const [, sigil, path] = match;
    if (path === undefined) continue;
    // The `lines` block's own tokens belong to the scope OUTSIDE it, which is why
    // the depth moves after an opener is classified and before a closer is.
    if (sigil === "/") {
      if (path === "lines") depth -= 1;
      continue;
    }
    (depth > 0 ? line : root).add(path);
    if ((sigil === "#" || sigil === "^") && path === "lines") depth += 1;
  }
  return { root: [...root].sort(), line: [...line].sort() };
}
