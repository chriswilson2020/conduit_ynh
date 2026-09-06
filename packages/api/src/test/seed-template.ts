import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsFolder } from "../db/client.js";

/**
 * The migrations that write each type's template body, in the order they run.
 *
 * KEYED BY TYPE SINCE PHASE 9, because there are two seeded templates now: the
 * quote's, written by 0009 and amended by 0011, and the meeting summary's, written
 * by 0017. The summary's list has one entry today; when something amends it, that
 * migration joins the list and the same replay below applies.
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
const TEMPLATE_MIGRATIONS: Record<string, string[]> = {
  quote: ["0009_calm_rhodey.sql", "0011_sharp_skullbuster.sql"],
  meeting_summary: ["0017_meeting_summary.sql"],
  // THREE TYPES OUT OF ONE MIGRATION, which is what broke the reader below. 0009
  // and 0017 each seed exactly one template and each does it in the file's LAST
  // statement, so the anchor could be the end of the file; 0019 seeds three, and
  // two of them are not last. See the pattern in seededTemplate.
  letter: ["0019_letter_and_agreements.sql"],
  nda: ["0019_letter_and_agreements.sql"],
  mutual_nda: ["0019_letter_and_agreements.sql"],
  project_status_report: ["0020_project_status_report.sql"],
};

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
export function seededTemplate(type: string): string {
  const files = TEMPLATE_MIGRATIONS[type];
  if (files === undefined) throw new Error(`no migration is recorded as seeding a ${type} template`);
  let body: string | null = null;
  for (const file of files) {
    const sql = readFileSync(join(migrationsFolder(), file), "utf8");
    if (body === null) {
      // Anchored on the INSERT's own literal, and on the end of its STATEMENT
      // rather than the end of the file -- so the long prose header every one of
      // these migrations carries, apostrophes and all, cannot be mistaken for a
      // template body.
      //
      // **THE ANCHOR USED TO BE `\\);\\s*$` AND THAT WAS AN ACCIDENT OF THERE
      // BEING ONE SEED PER FILE.** 0009 and 0017 each end with their INSERT, so
      // "the end of the file" and "the end of this statement" were the same
      // place. 0019 seeds three templates, and the letter's and the NDA's are
      // followed by two more statements -- so the old greedy pattern would have
      // matched from the letter's opening quote all the way to the mutual NDA's
      // closing one and handed back three templates concatenated, silently. Now
      // it is non-greedy and stops at a `');` that is followed by drizzle's own
      // statement separator or by the end of the file.
      //
      // WHAT THAT COSTS: a template body containing the literal text `');`
      // followed by a newline would terminate the match early. None does, and one
      // that did would announce itself as a template that stopped matching the
      // migrated database -- which is the assertion in schema.test.ts's drill.
      const match = new RegExp(
        `VALUES \\('${type}', '([\\s\\S]*?)'\\);(?=--> statement-breakpoint|\\s*$)`,
      ).exec(sql);
      if (match?.[1] === undefined) {
        throw new Error(`could not find the seeded ${type} template in ${file}`);
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
        + `understands ${String(rewrites.length)} of them. It amends the ${type} template `
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
    if (body === before) throw new Error(`${file} rewrites nothing in the ${type} template`);
  }
  if (body === null) throw new Error(`no migration seeds the ${type} template`);
  return body;
}

/** The quote template a fresh install has. */
export function seededQuoteTemplate(): string {
  return seededTemplate("quote");
}

/** The meeting summary template a fresh install has (Phase 9, migration 0017). */
export function seededMeetingSummaryTemplate(): string {
  return seededTemplate("meeting_summary");
}

/** The letter template a fresh install has (Phase 9 Task 3, migration 0019). */
export function seededLetterTemplate(): string {
  return seededTemplate("letter");
}

/** The NDA and mutual NDA templates a fresh install has (migration 0019). */
export function seededAgreementTemplate(type: "nda" | "mutual_nda"): string {
  return seededTemplate(type);
}

/** The status report template a fresh install has (Phase 9 Task 4, 0020). */
export function seededStatusReportTemplate(): string {
  return seededTemplate("project_status_report");
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
export interface TemplateMergePaths {
  /** Resolved against the root context: `org.*`, `document.*`, and the collections. */
  root: string[];
  /**
   * Resolved against one item of a collection, keyed by that collection: `qty`
   * inside `{{#lines}}`, `name` inside `{{#attendees}}`.
   */
  inside: Map<string, string[]>;
}

/**
 * PARAMETERISED BY COLLECTION SINCE PHASE 9, because the merge language never had
 * only one. The meeting summary template repeats `{{#attendees}}`, which is the
 * cheapest available demonstration that `lines` was a key on the root context and
 * not a feature -- and a reader hard-coded to `lines` would classify `{{name}}`
 * inside an attendee block as a ROOT path and then demand `buildContext` supply
 * `name` at the top level.
 *
 * A STACK, NOT A COUNTER, so a closer only leaves the block it opened. With one
 * collection a depth counter said the same thing; with two, `{{/lines}}` inside an
 * attendee block would otherwise pop the attendee scope.
 */
export function templateMergePaths(
  template: string, collections: readonly string[],
): TemplateMergePaths {
  const root = new Set<string>();
  const inside = new Map<string, Set<string>>(collections.map((name) => [name, new Set<string>()]));
  const open: string[] = [];
  for (const match of template.matchAll(/\{\{([#^/]?)([A-Za-z][A-Za-z0-9_.]*)\}\}/g)) {
    const [, sigil, path] = match;
    if (path === undefined) continue;
    // A collection block's own tokens belong to the scope OUTSIDE it, which is why
    // the stack moves after an opener is classified and before a closer is.
    if (sigil === "/") {
      if (open.at(-1) === path) open.pop();
      continue;
    }
    const current = open.at(-1);
    (current === undefined ? root : inside.get(current) ?? root).add(path);
    if ((sigil === "#" || sigil === "^") && collections.includes(path)) open.push(path);
  }
  return {
    root: [...root].sort(),
    inside: new Map([...inside].map(([name, paths]) => [name, [...paths].sort()])),
  };
}

export interface SeededTemplatePaths {
  /** Resolved against the root context: `org.*`, `document.*` and `lines` itself. */
  root: string[];
  /** Resolved against one line, inside `{{#lines}}`: `description`, `qty`, ... */
  line: string[];
}

export function seededTemplatePaths(): SeededTemplatePaths {
  const paths = templateMergePaths(seededQuoteTemplate(), ["lines"]);
  return { root: paths.root, line: paths.inside.get("lines") ?? [] };
}

export interface SummaryTemplatePaths {
  root: string[];
  /** Resolved against one attendee, inside `{{#attendees}}`. */
  attendee: string[];
}

export function seededSummaryTemplatePaths(): SummaryTemplatePaths {
  const paths = templateMergePaths(seededMeetingSummaryTemplate(), ["lines", "attendees"]);
  return { root: paths.root, attendee: paths.inside.get("attendees") ?? [] };
}

export interface StatusReportTemplatePaths {
  root: string[];
  /** Resolved against one task, inside `{{#tasks}}`. */
  task: string[];
}

/**
 * **THE FIRST CALLER WHOSE COLLECTION ITEMS CARRY A BLOCK OF THEIR OWN**, and it
 * is what `templateMergePaths`' stack (rather than a depth counter) was written
 * for. `{{#after}}` opens inside `{{#tasks}}` and `after` is not a collection, so
 * it is classified as a task-scope path and never pushed; its closer therefore
 * does not pop `tasks`, and the fields after it stay task-scoped. A counter would
 * have closed the task scope at `{{/after}}` and reported `status`, `startDate`
 * and the rest as ROOT paths -- which would then have demanded
 * `buildStatusReportContext` supply them at the top level, where they would print
 * as blanks.
 */
export function seededStatusReportTemplatePaths(): StatusReportTemplatePaths {
  const paths = templateMergePaths(seededStatusReportTemplate(), ["lines", "tasks"]);
  return { root: paths.root, task: paths.inside.get("tasks") ?? [] };
}
