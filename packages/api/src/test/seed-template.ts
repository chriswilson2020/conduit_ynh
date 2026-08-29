import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsFolder } from "../db/client.js";

/**
 * The migrations that write the quote template's body, in the order they run.
 *
 * NOT A SINGLE FILE ANY MORE, and that is what this list exists to say: 0009 INSERTs
 * the body, and every later migration that amends it does so with a guarded
 * `replace(...)` rather than an overwrite, because the operator may have edited the
 * template in Settings and a migration must not throw that away. So "the template a
 * fresh install has" is 0009's literal with each later rewrite applied in turn --
 * which is exactly what this function computes, and what a fresh install's database
 * ends up holding.
 *
 * A migration that amends the body in some OTHER shape would be missed here silently,
 * which is why schema.test.ts's migration drill asserts this function's output equals
 * the body read back out of a really-migrated database. That assertion is what keeps
 * the file-derived template and the real one from drifting apart.
 */
const TEMPLATE_MIGRATIONS = ["0009_calm_rhodey.sql", "0011_sharp_skullbuster.sql"];

/**
 * `replace("body_html", '<from>', '<to>')` as 0011 writes it.
 *
 * A `'` inside either literal is handled (`''` is Postgres's doubling and is undoubled
 * below); what the non-greedy match cannot survive is a literal containing the exact
 * text `', '` in a position that looks like the argument separator, which no template
 * fragment plausibly does.
 *
 * THE LOOKBEHIND IS NOT DECORATION: without it `regexp_replace("body_html", ...)`
 * matches too, and its first argument is a pattern rather than a literal, so the
 * reader would apply a rewrite the database does not perform. Requiring a
 * non-identifier character before `replace` excludes it -- and REPLACE_CALL below
 * deliberately does NOT, so the exclusion is counted rather than silent.
 */
const REWRITE = /(?<![A-Za-z0-9_])replace\(\s*"body_html",\s*'([\s\S]*?)',\s*'([\s\S]*?)'\s*\)/g;

/**
 * Every call that rewrites a string in SQL, `regexp_replace` and friends INCLUDED --
 * counted against REWRITE's matches so a shape this reader does not understand is
 * loud rather than silently half-applied.
 *
 * THE THREE CASES IT HAS TO CATCH, all of which an earlier version let through:
 * `regexp_replace(...)` alone (1 here, 0 there); a plain `replace` beside a
 * `regexp_replace` (2 and 1); and `replace(replace("body_html", ...), ...)`, where
 * REWRITE finds the inner call only (2 and 1). Sharing REWRITE's lookbehind made the
 * first two count zero and agree, which is exactly the half-application the check
 * exists to prevent.
 */
const REPLACE_CALL = /[A-Za-z0-9_]*replace\s*\(/g;

/**
 * SQL line comments, stripped before anything is counted.
 *
 * WITHOUT THIS THE CHECK IS A FOOT-GUN RATHER THAN A GUARD: these migrations carry
 * long prose comments by house style, and 0011's own says it uses "a guarded
 * `replace(...)`". Counting that as a call makes REPLACE_CALL disagree with REWRITE
 * and throws, breaking every suite that reads the seeded template -- for a sentence.
 * A `--` inside a string literal would be mis-stripped, which no migration here has
 * and which would announce itself immediately as a template that stopped matching.
 */
const SQL_LINE_COMMENT = /--[^\n]*/g;

/**
 * The seeded quote template as a fresh install has it, read out of the migrations
 * that write it.
 *
 * IT HAS TO BE READ FROM THE FILES RATHER THAN THE DATABASE. `truncateAll()` empties
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
  let body: string | null = null;
  for (const file of TEMPLATE_MIGRATIONS) {
    const sql = readFileSync(join(migrationsFolder(), file), "utf8");
    if (body === null) {
      const match = /VALUES \('quote', '([\s\S]*)'\);\s*$/.exec(sql);
      if (match?.[1] === undefined) {
        throw new Error(`could not find the seeded quote template in ${file}`);
      }
      body = match[1].replaceAll("''", "'");
      continue;
    }
    const before: string = body;
    // Prose is not SQL: the comments come out before anything is counted, or this
    // file's own house style throws the guard below.
    const statements = sql.replace(SQL_LINE_COMMENT, "");
    const rewrites = [...statements.matchAll(REWRITE)];
    // Every rewriting call in the file has to be one this reader understood. A nested
    // pair, or a regexp_replace, would otherwise be applied in part and leave the
    // derived template quietly disagreeing with the database.
    const replaceCalls = (statements.match(REPLACE_CALL) ?? []).length;
    if (replaceCalls !== rewrites.length) {
      throw new Error(
        `${file} makes ${String(replaceCalls)} string-rewriting call(s) and this reader `
        + `understands ${String(rewrites.length)} of them. It amends the quote template `
        + "in a shape seed-template.ts cannot follow -- nested replace(), regexp_replace(), "
        + "or something else again -- so teach REWRITE that shape rather than leaving the "
        + "file-derived template disagreeing with what a migrated database actually holds",
      );
    }
    for (const [, from, to] of rewrites) {
      if (from === undefined || to === undefined) continue;
      body = body.replaceAll(from.replaceAll("''", "'"), to.replaceAll("''", "'"));
    }
    // A migration listed here that changed nothing means its rewrite stopped matching
    // -- the body moved on and the amendment is now a no-op the database will not
    // apply either. Loud here rather than a blank on a printed quote.
    if (body === before) throw new Error(`${file} rewrites nothing in the quote template`);
  }
  if (body === null) throw new Error("no migration seeds the quote template");
  return body;
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
