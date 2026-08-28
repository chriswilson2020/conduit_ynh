import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../db/client.js";
import { pdfEmbedsFiles, renderPdf, weasyprintAvailable } from "./documents-render.js";
import { prepareDocumentHtml, type MergeContext } from "./documents-template.js";

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
 * IT NOW MERGES, WHICH IT DELIBERATELY DID NOT BEFORE. Task 2 left this stripping
 * merge constructs with a regex rather than resolving them, because Task 3 owned the
 * resolver and the coordinator had already ruled its block syntax would change -- a
 * stand-in would have gone stale by design. Task 3 has landed, so the real resolver
 * and the real sanitiser run here, in the same order Task 4 will call them
 * (prepareDocumentHtml: merge, then sanitise).
 *
 * THE TWO STATES ARE THE POINT. The seeded template wraps the logo and every
 * optional field in {{#...}} blocks, and the case that matters is the install that
 * filled in none of them: no empty <img>, no "VAT" standing over a blank. That is
 * asserted on the merged HTML and again on the PDF, where an image XObject either
 * exists or does not.
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

/** A 1x1 PNG, scaled by the template's own .logo rule. Stands in for a real logo. */
const LOGO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4" +
  "2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Every key Task 2's DONE block promises the context will carry, all empty. */
const EMPTY_CONTEXT: MergeContext = {
  org: {
    name: "", addressLines: "", email: "", phone: "", website: "", bankDetails: "",
    vatNumber: "", registrationNumber: "", logoDataUri: "",
  },
  document: {
    number: "", issueDate: "", validUntilDate: "", recipientName: "",
    recipientContactName: "", recipientAddress: "", subtotal: "", tax: "", total: "",
    notes: "", terms: "",
  },
  lines: [],
};

/** A real quote with nothing optional filled in: no logo, no VAT, no valid-until. */
const WITHOUT_LOGO: MergeContext = {
  org: { ...EMPTY_CONTEXT.org, name: "Listerdale Life Sciences", addressLines: "1 High St\n1015 CJ Amsterdam" },
  document: {
    ...EMPTY_CONTEXT.document,
    number: "QUO-2026-0001", issueDate: "2026-08-28", recipientName: "Acme Manufacturing BV",
    subtotal: "20,000.00", tax: "4,200.00", total: "24,200.00",
  },
  lines: Array.from({ length: 8 }, (_, i) => ({
    description: `Consultancy, phase ${String(i + 1)}`,
    qty: "2", unitPrice: "1,250.00", taxRate: "21%", lineTotal: "2,500.00",
  })),
};

/** The same quote from an install that filled everything in. */
const WITH_LOGO: MergeContext = {
  org: {
    ...WITHOUT_LOGO.org, logoDataUri: LOGO_PNG, email: "hello@listerdale.test",
    phone: "+31 20 123 4567", website: "listerdale.test",
    bankDetails: "NL00 BANK 0123 4567 89", vatNumber: "NL001234567B01",
    registrationNumber: "12345678",
  },
  document: {
    ...WITHOUT_LOGO.document, validUntilDate: "2026-09-27",
    recipientContactName: "Jane Smith", recipientAddress: "2 Low St\n1016 AB Amsterdam",
    notes: "Thank you for the enquiry.", terms: "Payment within 30 days.",
  },
  lines: WITHOUT_LOGO.lines,
};

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

/** An image XObject, which is what a `data:` logo becomes and nothing else here does. */
function hasImage(pdf: Buffer): boolean {
  return /\/Subtype\s*\/Image/.test(pdfText(pdf));
}

describe("the seeded quote template", () => {
  it("resolves every merge construct in it, whichever fields are filled in", () => {
    // Not "the regex found no {{" -- the real resolver ran and left nothing behind,
    // which is a different claim and the one that matters: a token the resolver does
    // not recognise stays on the page as literal text.
    for (const context of [EMPTY_CONTEXT, WITHOUT_LOGO, WITH_LOGO]) {
      expect(prepareDocumentHtml(seededTemplate(), context)).not.toContain("{{");
    }
  });

  it("has no merge field inside its CSS, where HTML escaping is the wrong escaping", () => {
    // A `{{...}}` in a stylesheet is substituted with &quot; and &amp; where CSS
    // wants neither, and the sanitiser destroys a style ATTRIBUTE that still holds
    // one. Neither is a security hole -- prepareDocumentHtml sanitises after merging,
    // so a URL smuggled through a value is still caught -- but both are silently
    // broken CSS, so the seed keeps its merge fields out of both positions.
    const template = seededTemplate();
    const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(template)?.[1] ?? "";

    expect(styleBlock).not.toContain("{{");
    expect(template).not.toMatch(/style="[^"]*\{\{/);
  });

  it("keeps the page-layout CSS through the sanitiser", () => {
    // The document profile exists to allow exactly this, and the seed is what uses
    // it: an @page rule with a nested at-rule inside it, and pre-line whitespace.
    const html = prepareDocumentHtml(seededTemplate(), WITH_LOGO);

    expect(html).toContain("@page");
    expect(html).toContain("@bottom-center");
    expect(html).toContain("white-space: pre-line");
  });

  it("prints no empty image and no orphaned label when nothing optional is filled in", () => {
    const html = prepareDocumentHtml(seededTemplate(), WITHOUT_LOGO);

    expect(html).not.toContain("<img");
    expect(html).not.toContain("Valid until");
    expect(html).not.toContain("VAT");
    expect(html).not.toContain("Company registration");
    // ...while the quote itself is still a quote.
    expect(html).toContain("Quote QUO-2026-0001");
    expect(html).toContain("Acme Manufacturing BV");
    expect(html).toContain("24,200.00");
  });

  it("prints all of it when the install has filled everything in", () => {
    const html = prepareDocumentHtml(seededTemplate(), WITH_LOGO);

    expect(html).toContain(`<img src="${LOGO_PNG}"`);
    expect(html).toContain("Valid until");
    expect(html).toContain("VAT NL001234567B01");
    expect(html).toContain("Company registration 12345678");
    expect(html).toContain("Jane Smith");
  });

  it("says so rather than printing an empty table when a quote has no lines", () => {
    const html = prepareDocumentHtml(seededTemplate(), EMPTY_CONTEXT);

    expect(html).toContain("No line items.");
    expect(html).not.toContain("<tr><td class=\"pre\">");
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
    const html = prepareDocumentHtml(seededTemplate(), EMPTY_CONTEXT);
    const pdf = await renderPdf(html);

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
    const pdf = await renderPdf(prepareDocumentHtml(seededTemplate(), EMPTY_CONTEXT));
    const mediaBox = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdfText(pdf));

    expect(mediaBox, "no /MediaBox found, even after inflating object streams").not.toBeNull();
    expect(Number(mediaBox![1])).toBeCloseTo(595.28, 1);
    expect(Number(mediaBox![2])).toBeCloseTo(841.89, 1);
  });

  /**
   * BOTH STATES, ON THE REAL RENDERER, and the assertion is about the PDF rather
   * than about the HTML that went in: an image XObject is either in the file or it
   * is not, whatever the markup looked like. Without a logo there must be none --
   * that is "no broken image on a quote" stated where it is true.
   */
  itReal("renders with a logo and without, and only one of them carries an image", async () => {
    const withoutHtml = prepareDocumentHtml(seededTemplate(), WITHOUT_LOGO);
    const withHtml = prepareDocumentHtml(seededTemplate(), WITH_LOGO);
    const without = await renderPdf(withoutHtml);
    const withLogo = await renderPdf(withHtml);

    // Printed because the input cap in documents-render.ts is calibrated against a
    // real merged quote: these two lines are that measurement, on whichever
    // WeasyPrint is running. The sizes move between versions, so nothing asserts one.
    console.log(`[seed] no logo:   ${String(withoutHtml.length)} chars of HTML -> ${String(without.length)} bytes, ${String(pageCount(without))} page(s)`);
    console.log(`[seed] with logo: ${String(withHtml.length)} chars of HTML -> ${String(withLogo.length)} bytes, ${String(pageCount(withLogo))} page(s)`);

    expect(without.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(withLogo.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(hasImage(without)).toBe(false);
    expect(hasImage(withLogo)).toBe(true);
    // A logo is not an attachment, and control 3 must not think it is.
    expect(pdfEmbedsFiles(withLogo)).toBe(false);
  }, 60_000);
});
