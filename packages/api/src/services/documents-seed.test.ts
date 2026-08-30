import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pageCount, pdfHasImage, pdfText, pdfVisibleText } from "../test/pdf.js";
import { seededQuoteTemplate } from "../test/seed-template.js";
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

/** The seeded body_html, read out of the migration that inserts it. Shared with
 * documents.test.ts, which checks the same tokens against buildContext's key set. */
const seededTemplate = seededQuoteTemplate;

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
    recipientContactName: "", recipientSalutation: "", recipientAddress: "",
    subtotal: "", tax: "", total: "", notes: "", terms: "",
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
    recipientContactName: "Jane Smith", recipientSalutation: "Dr",
    recipientAddress: "2 Low St\n1016 AB Amsterdam",
    notes: "Thank you for the enquiry.", terms: "Payment within 30 days.",
  },
  lines: WITHOUT_LOGO.lines,
};

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
    expect(html).toContain("<div>Dr Jane Smith</div>");
  });

  // THE OTHER THREE STATES OF THE RECIPIENT LINE, because the salutation sits in a
  // block NESTED inside the contact name's and only one of the four combinations is
  // exercised above. What each has to avoid is a stray space or an orphaned title:
  // "Jane Smith" with a leading space is a visible defect on a printed quote, and a
  // "Dr" standing alone over a company address is a worse one.
  it("prints the recipient line correctly whichever of the salutation and the name is missing", () => {
    const merged = (recipientSalutation: string, recipientContactName: string): string =>
      prepareDocumentHtml(seededTemplate(), {
        ...WITH_LOGO,
        document: { ...WITH_LOGO.document, recipientSalutation, recipientContactName },
      });

    expect(merged("Dr", "Jane Smith")).toContain("<div>Dr Jane Smith</div>");
    // No leading space where the salutation would have been: the space lives inside
    // the block, not in front of it.
    expect(merged("", "Jane Smith")).toContain("<div>Jane Smith</div>");
    // A salutation with no name to qualify prints nothing at all -- see 0011. "Dr"
    // appears nowhere else in this context, so its absence is the assertion.
    expect(merged("Dr", "")).not.toContain("Dr");
    expect(merged("", "")).not.toContain("<div></div>");
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

  /**
   * THE OTHER READER, PROVED THE SAME WAY: bytes built here, no renderer involved.
   *
   * `pdfVisibleText` translates glyph ids back through the font's `/ToUnicode`
   * table, and the file below carries the two forms such a table comes in --
   * `bfchar` pairs, which is what both WeasyPrints here emit, and a `bfrange`,
   * which is the compact form a producer may use for a contiguous run and which no
   * output measured in this project happens to contain. Supporting the second
   * unproven would be exactly the version-specific guess the Conventions warn
   * about; proving it costs three lines.
   *
   * The content stream is COMPRESSED and the table is not, which is also the split
   * a real quote has on the runner, and it is what makes the premise assertion
   * below a real one.
   */
  it("reads a printed line back through the font's ToUnicode table", () => {
    const table = [
      "begincmap",
      "2 beginbfchar", "<0024> <0048>", "<0044> <0069>", "endbfchar",
      "1 beginbfrange", "<0050> <0052> <0061>", "endbfrange",
      "endcmap",
    ].join("\n");
    const built = Buffer.concat([
      Buffer.from(`%PDF-1.7\n5 0 obj\n<< /Length ${String(table.length)} >>\nstream\n${table}\nendstream\nendobj\n`),
      Buffer.from("6 0 obj\n<< /Filter /FlateDecode >>\nstream\n"),
      deflateSync(Buffer.from("BT [<0024>17<0044>] TJ ET\nBT <005000510052> Tj ET\n")),
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);

    // The premise, and the whole reason this function exists: the words are not in
    // the file as words, so `pdfText` -- which finds everything else in this suite
    // -- answers "no" for text that is on the page. A negative assertion built on
    // it would pass whatever the page said.
    expect(pdfText(built)).not.toContain("Hi");
    expect(pdfText(built)).not.toContain("abc");

    // The TJ array's kerning number splits one line into two hex strings, and they
    // are one line: the ids either side of it belong to the same word.
    expect(pdfVisibleText(built)).toContain("Hi");
    // The bfrange half: <0050> <0051> <0052> against a base of <0061>.
    expect(pdfVisibleText(built)).toContain("abc");
    // And two operators are two lines. A needle spanning them would mean a caller
    // could assert text that appears nowhere on the page.
    expect(pdfVisibleText(built)).not.toContain("Hiabc");
  });

  /**
   * v1.1.0's column, ON THE PRINTED PAGE. The merge assertions above are about the
   * HTML that goes into the renderer; this is the only one about what comes out,
   * and it is what a customer reading the quote sees. Both directions, because an
   * install that records no salutation must print the name alone rather than a
   * stray space or an orphaned title.
   */
  itReal("prints the salutation in front of the contact's name", async () => {
    const withTitle = await renderPdf(prepareDocumentHtml(seededTemplate(), WITH_LOGO));
    expect(pdfVisibleText(withTitle)).toContain("Dr Jane Smith");

    const without = await renderPdf(prepareDocumentHtml(seededTemplate(), {
      ...WITH_LOGO,
      document: { ...WITH_LOGO.document, recipientSalutation: "" },
    }));
    const printed = pdfVisibleText(without);
    expect(printed).toContain("Jane Smith");
    expect(printed).not.toContain("Dr Jane Smith");
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
  it("merges a 130-line context well inside the work budget", () => {
    // The headroom assertion, against the REAL template rather than a stand-in: this
    // context measures 1,656 steps at 130 line items against a 1,000,000 cap (192 at
    // eight lines). 130 is NOT the product's ceiling -- DOCUMENT_MAX_LINES is 60, and
    // an earlier version of this comment called 130 "the largest quote that can
    // render at all", which stopped being true when the constants were re-measured.
    // It is kept because a step budget is worth stressing past the product's cap. An earlier version of this guard lived in
    // documents-template.ts's suite against an ad-hoc 787-step template, which was
    // half the true figure.
    const many: MergeContext = {
      ...WITH_LOGO,
      lines: Array.from({ length: 130 }, (_, i) => ({
        description: `Consultancy, phase ${String(i + 1)}`,
        qty: "2", unitPrice: "1,250.00", taxRate: "21%", lineTotal: "2,500.00",
      })),
    };

    expect(() => prepareDocumentHtml(seededTemplate(), many)).not.toThrow();
  });

  it("keeps the footer from splitting across a page break", () => {
    // The rule, asserted where a careless edit would drop it. What it prevents is the
    // shape this template shipped with: at six line items the last three footer lines
    // -- IBAN, VAT, registration -- were stranded alone on page two of every quote
    // raised from a configured install. Tightening the spacing is what moved the
    // break itself (see the page counts below); this keeps the block whole when a
    // long quote does break. WeasyPrint implementing the rule is NOT asserted here.
    expect(seededTemplate()).toContain("page-break-inside: avoid");
  });

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
    // ONE PAGE EACH, INCLUDING THE FILLED ONE, and only the empty case was asserted
    // before: the shipped template put every filled eight-line quote onto two pages
    // with nothing on the second but the bank and tax lines.
    expect(pageCount(without)).toBe(1);
    expect(pageCount(withLogo)).toBe(1);
    expect(pdfHasImage(without)).toBe(false);
    expect(pdfHasImage(withLogo)).toBe(true);
    // A logo is not an attachment, and control 3 must not think it is.
    expect(pdfEmbedsFiles(withLogo)).toBe(false);
  }, 60_000);
});
