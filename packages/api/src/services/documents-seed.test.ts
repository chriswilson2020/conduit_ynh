import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
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

/**
 * The PDF's bytes plus every Flate stream in it, inflated.
 *
 * A RAW BYTE SEARCH IS NOT ENOUGH AND CI IS WHERE THAT SHOWS. WeasyPrint 61.1
 * (Ubuntu 24.04, which is what the runner has) compresses object streams by
 * default while 57.2 (the Debian 12 server) does not, so the page tree is plain
 * text locally and invisible on CI -- the first version of this file passed here
 * and failed there, which is the same trap Task 1's retrospective records for
 * `/EmbeddedFiles`. The loop mirrors `pdfEmbedsFiles`, including resuming past
 * the whole `endstream` keyword rather than one byte into it, and that loop is
 * already proved against 61.1 by Task 1's mutation run.
 */
function pdfText(pdf: Buffer): string {
  const parts = [pdf.toString("latin1")];
  let from = 0;
  for (;;) {
    const start = pdf.indexOf("stream", from);
    if (start === -1) break;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body += 1;
    if (pdf[body] === 0x0a) body += 1;
    try {
      parts.push(inflateSync(pdf.subarray(body, end)).toString("latin1"));
    } catch {
      // Not a Flate stream, or not a stream at all. Keep looking.
    }
    from = end + "endstream".length;
  }
  return parts.join("\n");
}

/** Pages, from the page tree's own count rather than by counting page objects. */
function pageCount(pdf: Buffer): number {
  const counts = (pdfText(pdf).match(/\/Count\s+(\d+)/g) ?? []).map((m) => Number(/\d+/.exec(m)![0]));
  // An intermediate node carries its own subtree's count, so the root's is the
  // largest -- true whatever shape the producer gives the tree.
  return counts.length === 0 ? 0 : Math.max(...counts);
}

describe("the seeded quote template", () => {
  it("has no merge construct left after stripping, so the render below is the CSS and markup alone", () => {
    expect(withoutMergeFields(seededTemplate())).not.toContain("{{");
  });

  // THE READER, PROVED AGAINST THE THING THAT BROKE IT, and provable without a
  // renderer of any version: a page tree that exists ONLY inside a compressed
  // object stream, which is what 61.1 produces and what a raw byte search missed.
  // Without this the parser is only ever exercised against the uncompressed
  // output of the one WeasyPrint on the development server, and the version that
  // matters is the other one.
  it("reads the page tree out of a compressed object stream", () => {
    const objects = "<< /Type /Pages /Count 1 >>\n<< /Type /Page /MediaBox [ 0 0 595.275591 841.889764 ] >>";
    const compressed = Buffer.concat([
      Buffer.from("%PDF-1.7\n4 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\n"),
      deflateSync(Buffer.from(objects)),
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);

    // The premise: none of it is findable in the raw bytes.
    expect(compressed.toString("latin1")).not.toContain("/MediaBox");
    expect(pageCount(compressed)).toBe(1);
    expect(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdfText(compressed))?.[1])
      .toBe("595.275591");
  });

  itReal("renders to a PDF on an install where nothing has been filled in", async () => {
    const pdf = await renderPdf(withoutMergeFields(seededTemplate()));

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // An empty quote is one page. More would mean the stylesheet had started
    // pushing content across a page break with nothing in it.
    expect(pageCount(pdf)).toBe(1);
  });

  // @page { size: A4 } is the single most consequential line in the stylesheet and
  // the one a careless edit silently changes -- a quote that prints on US Letter is
  // wrong in a way nobody notices until it is on paper. A4 is 210x297mm, which is
  // 595.28 x 841.89 PostScript points; Letter is 612 x 792.
  itReal("puts the page on A4, which is what the @page rule is for", async () => {
    const pdf = await renderPdf(withoutMergeFields(seededTemplate()));
    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdfText(pdf));

    expect(mediaBox, "no /MediaBox found, even after inflating object streams").not.toBeNull();
    expect(Number(mediaBox![1])).toBeCloseTo(595.28, 1);
    expect(Number(mediaBox![2])).toBeCloseTo(841.89, 1);
  });
});
