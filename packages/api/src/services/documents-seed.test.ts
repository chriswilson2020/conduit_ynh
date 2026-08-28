import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../db/client.js";
import { renderPdf, weasyprintAvailable } from "./documents-render.js";

/**
 * DOES THE SEEDED QUOTE TEMPLATE ACTUALLY RENDER?
 *
 * schema.test.ts checks the seed's merge tokens and two `toContain` strings, which
 * catches a broken FIELD and nothing else: an edit to the stylesheet that WeasyPrint
 * cannot parse, or that silently changes the page geometry, passes it. The template
 * had been rendered by hand three times during Task 2 and never by the suite, which
 * is the same "a mechanism was tested, a property was not" shape Task 1's
 * retrospective warns about. This is that property.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS MERGE. Task 3 owns the resolver, and the
 * coordinator has already ruled its block syntax will change ({{#path}}/{{^path}}),
 * so a stand-in here would be a second implementation that goes stale by design.
 * Stripping every merge construct instead is correct under any of those languages
 * for the one context this file cares about -- an install where nothing has been
 * filled in -- and leaves exactly the stylesheet and the markup, which is what is
 * unguarded. A FILLED render belongs in Task 4, beside the real buildContext.
 *
 * Gated on the binary the way documents-render.test.ts's real half is, and CI
 * installs WeasyPrint, so the assertions below run there on every push.
 */

const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

/** The seeded body_html, read out of the migration that inserts it. */
function seededTemplate(): string {
  const sql = readFileSync(join(migrationsFolder(), "0009_calm_rhodey.sql"), "utf8");
  const match = /VALUES \('quote', '([\s\S]*)'\);\s*$/.exec(sql);
  if (match?.[1] === undefined) throw new Error("could not find the seeded quote template in 0009");
  return match[1].replaceAll("''", "'");
}

/** Every merge construct removed: blocks first, then scalars. */
function withoutMergeFields(template: string): string {
  return template
    .replace(/\{\{#[\w.]+\}\}[\s\S]*?\{\{\/[\w.]+\}\}/g, "")
    .replace(/\{\{[^}]*\}\}/g, "");
}

describe("the seeded quote template", () => {
  it("has no merge construct left after stripping, so the render below is the CSS and markup alone", () => {
    expect(withoutMergeFields(seededTemplate())).not.toContain("{{");
  });

  itReal("renders to a PDF on an install where nothing has been filled in", async () => {
    const pdf = await renderPdf(withoutMergeFields(seededTemplate()));

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // An empty quote is one page. More would mean the stylesheet had started
    // pushing content across a page break with nothing in it.
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).toHaveLength(1);
  });

  // @page { size: A4 } is the single most consequential line in the stylesheet and
  // the one a careless edit silently changes -- a quote that prints on US Letter is
  // wrong in a way nobody notices until it is on paper. A4 is 210x297mm, which is
  // 595.28 x 841.89 PostScript points.
  itReal("puts the page on A4, which is what the @page rule is for", async () => {
    const pdf = await renderPdf(withoutMergeFields(seededTemplate()));
    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString("latin1"));

    expect(mediaBox).not.toBeNull();
    expect(Number(mediaBox![1])).toBeCloseTo(595.28, 1);
    expect(Number(mediaBox![2])).toBeCloseTo(841.89, 1);
  });
});
