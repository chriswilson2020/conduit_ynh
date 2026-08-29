import { describe, expect, it } from "vitest";
import { pdfText } from "../test/pdf.js";
import { renderPdf, weasyprintAvailable } from "./documents-render.js";
import {
  documentTemplateErrors,
  documentTemplateWarnings,
  MERGE_MAX_DEPTH,
  MERGE_MAX_OUTPUT_CHARS,
  MERGE_MAX_STEPS,
  TemplateError,
  mergeTemplate,
  prepareDocumentHtml,
  sanitizeDocumentHtml,
  type MergeContext,
} from "./documents-template.js";

/**
 * THE BRACES TO documents-render.ts's BELT, and the two halves are tested very
 * differently on purpose.
 *
 * The merge half is a parser, so it is tested for what it does with input nobody
 * intended: an unclosed block, a closer that matches nothing, blocks inside blocks.
 * "A regex would do SOMETHING there" is not a specification.
 *
 * The sanitiser half is a security control, so it is tested per scheme and per
 * attribute rather than one-and-generalised -- which is exactly how a working
 * `file://` exfiltration survived the renderer's first test suite (Task 1's
 * retrospective). Every case below names the URL it refuses.
 */

const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

/** A 1x1 PNG. Stands in for the org profile's logo wherever one is needed. */
const LOGO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4" +
  "2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ------------------------------------------------------------ what must survive

describe("sanitizeDocumentHtml keeps what page layout needs", () => {
  it("keeps a <style> block, including the @page rule and its nested at-rule", () => {
    // The seeded template's own footer rule. A profile that ate this would take the
    // page numbers off every quote, which is the reason the mail profile cannot be
    // reused here.
    const css = "@page { size: A4; margin: 18mm; @bottom-center { content: \"Page \" counter(page); } }";
    const html = sanitizeDocumentHtml(`<style>${css}</style><p>hi</p>`);

    expect(html).toContain("@page");
    expect(html).toContain("@bottom-center");
    expect(html).toContain("counter(page)");
  });

  it("keeps a style attribute", () => {
    // postcss restringifies the declaration, so the assertion is on the property and
    // the value rather than on the spacing between them.
    const html = sanitizeDocumentHtml('<p style="color: #111">hi</p>');

    expect(html).toContain("color");
    expect(html).toContain("#111");
  });

  it("keeps tables and the attributes that carry their structure", () => {
    const html = sanitizeDocumentHtml(
      '<table class="lines"><thead><tr><th colspan="2">a</th></tr></thead>' +
        "<tbody><tr><td>b</td></tr></tbody></table>",
    );

    expect(html).toContain('<table class="lines">');
    expect(html).toContain('colspan="2"');
    expect(html).toContain("<td>b</td>");
  });

  it("keeps a data: image, which is the one scheme a document may use", () => {
    expect(sanitizeDocumentHtml(`<img src="${LOGO_PNG}" alt="">`)).toContain(LOGO_PNG);
  });

  it("keeps a data: URL in CSS too, in a url() and in an @import", () => {
    const html = sanitizeDocumentHtml(
      "<style>body { background: url(data:image/png;base64,iVBOR); }" +
        '@import "data:text/css,p{color:red}";</style>',
    );

    expect(html).toContain("data:image/png;base64,iVBOR");
    expect(html).toContain("data:text/css,p{color:red}");
  });

  it("keeps a fragment link, which names a place in this document and fetches nothing", () => {
    expect(sanitizeDocumentHtml('<a href="#terms">Terms</a>')).toContain('href="#terms"');
  });

  it("leaves the whole seeded-shaped document alone the second time round", () => {
    // Idempotence, because Task 5 may sanitise a template when it is saved and Task 4
    // sanitises the merged document again before rendering. A profile that mangled
    // its own output a second time would corrupt every quote raised from a saved
    // template rather than failing anywhere visible.
    const once = sanitizeDocumentHtml(
      `<style>@page { size: A4; } .pre { white-space: pre-line; }</style>` +
        `<div class="pre" style="color: #111">Acme &amp; Co</div>` +
        `<img src="${LOGO_PNG}" alt=""><table><tr><td colspan="2">x</td></tr></table>`,
    );

    expect(sanitizeDocumentHtml(once)).toBe(once);
  });
});

// ------------------------------------------------------- script, in every form

describe("sanitizeDocumentHtml strips everything executable", () => {
  it("strips script elements and their contents", () => {
    const html = sanitizeDocumentHtml("<p>a</p><script>alert(1)</script>");

    expect(html).not.toContain("alert");
    expect(html).not.toContain("<script");
    expect(html).toContain("<p>a</p>");
  });

  it("strips event handlers", () => {
    const html = sanitizeDocumentHtml('<p onclick="alert(1)" onerror="alert(2)">a</p>');

    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert");
  });

  it("strips javascript: URLs", () => {
    const html = sanitizeDocumentHtml('<a href="javascript:alert(1)">a</a>');

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert");
  });

  it("strips iframes, objects, embeds and forms", () => {
    const html = sanitizeDocumentHtml(
      '<iframe src="data:text/html,x"></iframe><object data="x"></object>' +
        '<embed src="x"><form action="x"><input name="y"></form>',
    );

    for (const tag of ["<iframe", "<object", "<embed", "<form", "<input"]) {
      expect(html).not.toContain(tag);
    }
  });
});

// ------------------------------------------------------------- the URL matrix

/**
 * Every one of these must be refused in every attribute and in every CSS position.
 *
 * `file:` leads the list because it is the one the spec's own wording misses: it says
 * "any remote URL", and `file:` is not remote. It is also the only one that has
 * actually been used against this codebase -- a spec reviewer recovered a 32-byte
 * mode-600 key byte for byte through `<link rel="attachment" href="file:///...">`.
 * The rule implemented here is therefore an allowlist of exactly `data:`, not a
 * denylist of the schemes somebody thought of.
 */
const REFUSED_URLS: { name: string; url: string; needle: string; inCss?: false }[] = [
  { name: "file:, the one the spec's wording misses", url: "file:///etc/passwd", needle: "etc/passwd" },
  { name: "http:", url: "http://evil.test/x.png", needle: "evil.test" },
  { name: "https:", url: "https://evil.test/x.png", needle: "evil.test" },
  { name: "ftp:", url: "ftp://evil.test/x", needle: "evil.test" },
  { name: "jar:, the exotic one", url: "jar:file:///etc/passwd!/x", needle: "etc/passwd" },
  { name: "a protocol-relative //host", url: "//evil.test/x.png", needle: "evil.test" },
  { name: "a root-relative path", url: "/etc/passwd", needle: "etc/passwd" },
  { name: "a plain relative path", url: "logo.png", needle: "logo.png" },
  { name: "javascript:", url: "javascript:alert(1)", needle: "javascript" },
  { name: "vbscript:", url: "vbscript:msgbox(1)", needle: "vbscript" },
  { name: "mailto:", url: "mailto:x@evil.test", needle: "evil.test" },
  { name: "tel:", url: "tel:+31201234567", needle: "31201234567" },
  { name: "blob:", url: "blob:https://evil.test/1", needle: "evil.test" },
  { name: "filesystem:", url: "filesystem:http://evil.test/temporary/x", needle: "evil.test" },
  { name: "a UNC path", url: "\\\\evil.test\\share\\x", needle: "evil.test" },
  { name: "file: with a leading space", url: " file:///etc/passwd", needle: "etc/passwd" },
  { name: "FILE: in capitals", url: "FILE:///etc/passwd", needle: "etc/passwd" },
  { name: "file: with a tab inside the scheme", url: "fi\tle:///etc/passwd", needle: "etc/passwd" },
  // CSS ends a string at an unescaped newline, so this one is not a URL in a
  // stylesheet at all -- it is a bad-string parse error, and what is left of it after
  // the sanitiser is inert text rather than something anything could fetch. Tested in
  // the attribute positions, where htmlparser2 does keep the newline in the value.
  { name: "data: with a newline before the colon", url: "data\n:text/html,x", needle: "text/html", inCss: false },
];

describe("a merge token in a URL position is a placeholder, not a URL", () => {
  /**
   * THE LAYERING BUG THAT DELETED THE LOGO FROM THE SHIPPED TEMPLATE.
   *
   * Template-time sanitisation sees UNMERGED text. `src="{{org.logoDataUri}}"` is not
   * a `data:` URI and not a fragment, so the URL rule refused it, which dropped the
   * `src`, which made `exclusiveFilter` drop the whole `<img>` -- silently, with no
   * warning. Saving the seeded template unmodified therefore removed its letterhead,
   * which is the first thing Task 5's editor will do.
   *
   * The value that eventually lands in that attribute is checked by the sanitise pass
   * that runs AFTER the merge, where it really is a URL. That pass has always been
   * the one that decides; this one only has to stop judging a placeholder.
   */
  it("keeps an img whose src is a whole merge token", () => {
    const html = sanitizeDocumentHtml('<img src="{{org.logoDataUri}}" alt="" />');
    expect(html).toContain("<img");
    expect(html).toContain("{{org.logoDataUri}}");
  });

  it("still refuses a token that is only part of the value", () => {
    // Narrower than it has to be: the merged pass would catch this too. No template
    // in this repo needs it, and the rule that cannot be widened by accident is the
    // one worth having.
    for (const value of ["file:///{{x}}", "{{x}}/logo.png", "http://{{host}}/x.png"]) {
      expect(sanitizeDocumentHtml(`<img src="${value}" alt="">`)).not.toContain("<img");
    }
  });

  it("does not let a placeholder become a live URL after the merge", () => {
    // The property that makes the allowance safe. The token survives template-time
    // sanitisation; what it resolves to does not survive the merged pass.
    const merged = prepareDocumentHtml('<img src="{{org.logoDataUri}}" alt="" />', {
      org: { logoDataUri: "file:///etc/passwd" }, document: {}, lines: [],
    });
    expect(merged).not.toContain("file:");
    expect(merged).not.toContain("<img");

    const good = prepareDocumentHtml('<img src="{{org.logoDataUri}}" alt="" />', {
      org: { logoDataUri: "data:image/png;base64,AAAA" }, document: {}, lines: [],
    });
    expect(good).toContain("data:image/png;base64,AAAA");
  });

  it("leaves an href placeholder a placeholder, and refuses what it becomes", () => {
    expect(sanitizeDocumentHtml('<a href="{{document.link}}">x</a>')).toContain("{{document.link}}");
    const merged = prepareDocumentHtml('<a href="{{document.link}}">x</a>', {
      org: {}, document: { link: "https://example.test" }, lines: [],
    });
    expect(merged).not.toContain("example.test");
  });
});

describe("sanitizeDocumentHtml refuses every scheme but data:, in every attribute", () => {
  for (const { name, url, needle, inCss } of REFUSED_URLS) {
    it(`refuses ${name} as an img src`, () => {
      const html = sanitizeDocumentHtml(`<img src="${url}" alt="logo">`);
      expect(html).not.toContain(needle);
    });

    it(`refuses ${name} as an anchor href`, () => {
      // The renderer is NOT a control here: it does not fetch an href at all, it
      // writes it into the PDF as a link annotation. See the gated tests at the
      // bottom of this file, which prove that on the real renderer.
      const html = sanitizeDocumentHtml(`<a href="${url}">x</a>`);
      expect(html).not.toContain(needle);
    });

    // Registered rather than skipped, because CI's baseline is zero skipped tests
    // and a skip is how a case stops being tested without anybody noticing.
    if (inCss === false) continue;

    it(`refuses ${name} in a CSS url() inside a <style> block`, () => {
      const html = sanitizeDocumentHtml(`<style>body { background: url("${url}"); }</style>`);
      expect(html).not.toContain(needle);
    });

    it(`refuses ${name} in a CSS url() inside a style attribute`, () => {
      const html = sanitizeDocumentHtml(`<p style="background: url('${url}')">x</p>`);
      expect(html).not.toContain(needle);
    });

    it(`refuses ${name} in an @import`, () => {
      const html = sanitizeDocumentHtml(`<style>@import url("${url}");</style>`);
      expect(html).not.toContain(needle);
    });

    it(`refuses ${name} in a bare-string @import`, () => {
      const html = sanitizeDocumentHtml(`<style>@import "${url}";</style>`);
      expect(html).not.toContain(needle);
    });

    it(`refuses ${name} in a @font-face src`, () => {
      const html = sanitizeDocumentHtml(
        `<style>@font-face { font-family: P; src: url("${url}"); }</style>`,
      );
      expect(html).not.toContain(needle);
    });
  }

  it("refuses a remote src on every other element that could carry one", () => {
    // None of these tags are allowed, so the tag goes with the URL. Asserted per tag
    // rather than trusting the allowlist, because a later phase adding one of them
    // for a legitimate reason must fail here rather than quietly reopen a fetch.
    for (const html of [
      '<video src="http://evil.test/x.mp4"></video>',
      '<audio src="http://evil.test/x.mp3"></audio>',
      '<source src="http://evil.test/x.mp4">',
      '<track src="http://evil.test/x.vtt">',
      '<input type="image" src="http://evil.test/x.png">',
      '<body background="http://evil.test/x.png">y</body>',
      '<table background="http://evil.test/x.png"><tr><td>y</td></tr></table>',
      '<img srcset="http://evil.test/x.png 1x" src="http://evil.test/y.png">',
      '<svg><image href="http://evil.test/x.png"></image></svg>',
      '<base href="http://evil.test/">',
      '<meta http-equiv="refresh" content="0;url=http://evil.test/">',
    ]) {
      expect(sanitizeDocumentHtml(html)).not.toContain("evil.test");
    }
  });

  it("drops an image whose source did not survive, rather than leaving an empty one", () => {
    // <img alt="logo"> with no src is what sanitize-html leaves behind on its own,
    // and WeasyPrint draws nothing for it -- but the alt text lands on the page. This
    // is also the belt to the merge language's braces for the logo: a template that
    // hard-codes <img src="{{org.logoDataUri}}"> on an install with no logo merges to
    // <img src=""> and must not print anything at all.
    expect(sanitizeDocumentHtml('<img src="http://evil.test/x.png" alt="logo">')).toBe("");
    expect(sanitizeDocumentHtml('<img src="" alt="logo">')).toBe("");
    expect(sanitizeDocumentHtml('<img alt="logo">')).toBe("");
  });

  it("refuses data: on an href, which is a link rather than a fetch", () => {
    // Narrowed deliberately rather than left as a side effect of "exactly data:
    // everywhere". An href is never fetched -- it becomes a /URI annotation in the
    // PDF -- so data: buys a template nothing there and would ride out into the
    // finished document. A fetch position still takes it, because that is how the
    // logo arrives.
    expect(sanitizeDocumentHtml('<a href="data:text/html,<script>x</script>">y</a>'))
      .not.toContain("data:");
    expect(sanitizeDocumentHtml('<a href="#terms">Terms</a>')).toContain('href="#terms"');
    expect(sanitizeDocumentHtml(`<img src="${LOGO_PNG}" alt="">`)).toContain("data:image/png");
  });

  it("refuses rel=attachment on a <link> and on an <a>", () => {
    // THE VECTOR THAT LEAKED THE KEY. The renderer refuses it too (control 2), and
    // has to, because on WeasyPrint 61.1 an attachment never reaches the document's
    // URL fetcher at all. Refusing it here as well is what keeps a template from
    // producing a render that fails for everyone instead of a document.
    const link = sanitizeDocumentHtml('<link rel="attachment" href="file:///etc/passwd">');
    expect(link).toBe("");

    const anchor = sanitizeDocumentHtml(
      `<a rel="noopener attachment" href="${LOGO_PNG}">x</a>`,
    );
    expect(anchor).not.toContain("attachment");

    // Even with a data: href, which is the one scheme that is otherwise allowed:
    // the attachment is the vector, not the scheme.
    const dataAttachment = sanitizeDocumentHtml('<a rel="attachment" href="data:text/plain,x">y</a>');
    expect(dataAttachment).not.toContain("attachment");
  });
});

// --------------------------------------------------- CSS that hides its intent

describe("sanitizeDocumentHtml sees through CSS that hides a URL", () => {
  // Each of these is a real tinycss2 parse, measured against the renderer on the
  // server: WeasyPrint blocked the escaped url() and the escaped @import, which is
  // how we know the escapes are decoded before the fetch rather than being inert.
  const HIDDEN: { name: string; css: string }[] = [
    { name: "an escaped url token", css: 'body { background: \\75 rl("file:///etc/passwd"); }' },
    { name: "an escaped at-keyword", css: '@\\69 mport url("file:///etc/passwd");' },
    { name: "an escape inside the URL itself", css: "body { background: url(fi\\6ce:///etc/passwd); }" },
    { name: "an escape inside a quoted URL", css: 'body { background: url("\\66 ile:///etc/passwd"); }' },
    { name: "capitals", css: 'body { background: URL("FILE:///etc/passwd"); }' },
    { name: "whitespace inside the url token", css: 'body { background: url(\n  "file:///etc/passwd"\n); }' },
    { name: "an unquoted url token", css: "body { background: url(file:///etc/passwd); }" },
    { name: "a comment in the middle of the value", css: "body { background: url(/*x*/file:///etc/passwd); }" },
    { name: "an @import with a media query after it", css: '@import "file:///etc/passwd" screen;' },
    { name: "an @import in capitals", css: '@IMPORT URL("file:///etc/passwd");' },
    { name: "a url inside a nested at-rule", css: "@media print { body { background: url(file:///etc/passwd); } }" },
    { name: "a url inside @page", css: "@page { background: url(file:///etc/passwd); }" },
    { name: "two urls in one declaration", css: "body { background: url(data:x), url(file:///etc/passwd); }" },
    // THE STRING SHAPES, WHICH THE FIRST VERSION OF THIS TABLE HAD NONE OF. CSS
    // preprocesses CR, FF and CRLF each into a single LF, so each of these ends a
    // bad-string exactly where a newline would -- and a reader that only knew about
    // "\n" copied everything after the CR out as string content, url() and all. That
    // survivor was measured being FETCHED by the renderer on the server.
    { name: "a url after a bad-string ended by a bare CR", css: "p{content:'x\r} p{background:url(file:///etc/passwd)} p{a:'}" },
    { name: "a url after a bad-string ended by a form feed", css: "p{content:'x\f} p{background:url(file:///etc/passwd)} p{a:'}" },
    { name: "a url after a bad-string ended by CRLF", css: "p{content:'x\r\n} p{background:url(file:///etc/passwd)} p{a:'}" },
    { name: "a url after a bad-string in double quotes", css: 'p{content:"x\r} p{background:url(file:///etc/passwd)} p{a:"}' },
    { name: "a url after an unterminated string at end of line", css: "p{content:'x\n} p{background:url(file:///etc/passwd)} p{a:'}" },
  ];

  for (const { name, css } of HIDDEN) {
    it(`refuses ${name}`, () => {
      expect(sanitizeDocumentHtml(`<style>${css}</style>`)).not.toContain("etc/passwd");
    });
  }

  it("does not let a comment glue an ident onto a paren to make a url token", () => {
    // `url/**/(x)` is NOT a url token to a CSS parser -- the paren must follow the
    // ident immediately -- so deleting the comment outright would MAKE it one. Two
    // things stop that: a removed comment leaves a space behind, and the scanner
    // treats `url` followed by trivia and a paren as a url token anyway, which is
    // looser than the grammar in the safe direction.
    const html = sanitizeDocumentHtml('<style>body { background: url/**/("file:///etc/passwd"); }</style>');

    expect(html).not.toContain("etc/passwd");
    expect(html).not.toContain("url(");
  });

  it("cannot be made to emit a </style> that closes the block early", () => {
    // A removal joins the text on either side of it. If that could put a `<` next to
    // a `/style>`, the sanitised CSS would close its own element when the output is
    // parsed again, and everything after it would become live markup. Every removal
    // therefore leaves a space behind, and this is the case that proves it.
    const html = sanitizeDocumentHtml(
      "<style>a { b: <url(http://evil.test/x)/style><b>y</b> }</style>",
    );
    const content = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? "";

    expect(content.toLowerCase()).not.toContain("</style");
    expect(content).toContain("< /style");
    expect(html).not.toContain("evil.test");
  });

  it("escapes a < inside a data: URL rather than emitting it into the CSS", () => {
    // A data: URI may legitimately contain angle brackets (SVG), and a raw one in a
    // stylesheet is one `/style>` away from ending the element. `\3c ` is how CSS
    // spells `<`, so the URL still works and the character never appears.
    //
    // The payload stops short of a literal `</style>` on purpose: htmlparser2 ends
    // the element at the first `</style` in the SOURCE, so one cannot reach this
    // function inside a style block at all. What can reach it is a `<`.
    const html = sanitizeDocumentHtml(
      '<style>body { background: url("data:image/svg+xml,<svg/>"); }</style>',
    );

    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("\\3c svg/\\3e ");
    expect(html).not.toContain("<svg");
  });

  it("keeps the CSS around a URL it removed", () => {
    const html = sanitizeDocumentHtml(
      "<style>body { color: #111; background: url(http://evil.test/x); font-size: 10pt; }</style>",
    );

    expect(html).toContain("color: #111");
    expect(html).toContain("font-size: 10pt");
    expect(html).not.toContain("evil.test");
  });
});

// -------------------------------------------------------------- merge fields

const CONTEXT: MergeContext = {
  org: {
    name: "Listerdale", addressLines: "1 High St\n1234 AB Amsterdam", email: "", phone: "",
    website: "", bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
  },
  document: {
    number: "QUO-2026-0001", issueDate: "2026-08-28", validUntilDate: "", recipientName: "Acme",
    recipientContactName: "", recipientAddress: "2 Low St", subtotal: "100.00", tax: "21.00",
    total: "121.00", notes: "", terms: "",
  },
  lines: [
    { description: "Widget", qty: "2", unitPrice: "50.00", taxRate: "21%", lineTotal: "100.00" },
  ],
};

/** CONTEXT with `patch` merged into its `document` bag. */
function withDocument(patch: Record<string, string>): MergeContext {
  return { ...CONTEXT, document: { ...CONTEXT.document, ...patch } };
}

describe("mergeTemplate substitutes scalars", () => {
  it("substitutes a scalar field", () => {
    expect(mergeTemplate("Quote {{document.number}}", CONTEXT)).toBe("Quote QUO-2026-0001");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(mergeTemplate("{{  document.number  }}", CONTEXT)).toBe("QUO-2026-0001");
  });

  it("renders an unknown field as empty rather than throwing", () => {
    expect(mergeTemplate("[{{document.nope}}][{{nope.nope}}][{{nope}}]", CONTEXT)).toBe("[][][]");
  });

  it("renders an inherited property as empty, not as JavaScript's answer", () => {
    // {{constructor}} must be a blank on a page, not "function Object() {...}".
    const out = mergeTemplate(
      "[{{constructor}}][{{document.constructor}}][{{toString}}][{{document.hasOwnProperty}}]",
      CONTEXT,
    );

    expect(out).toBe("[][][][]");
  });

  it("does not let an inherited property make a block render either", () => {
    // The discriminating case for the own-property check, and the field test above is
    // NOT it: a field only ever emits a string, so `{{constructor}}` is blank however
    // the lookup behaves. A BLOCK asks whether the value is empty, and a function is
    // not, so a lookup that walked the prototype chain would render this body.
    expect(mergeTemplate("{{#constructor}}x{{/constructor}}", CONTEXT)).toBe("");
    expect(mergeTemplate("{{#document.constructor}}x{{/document.constructor}}", CONTEXT)).toBe("");
    expect(mergeTemplate("{{^constructor}}nothing there{{/constructor}}", CONTEXT))
      .toBe("nothing there");
  });

  it("renders a non-scalar as empty", () => {
    expect(mergeTemplate("[{{lines}}][{{org}}]", CONTEXT)).toBe("[][]");
  });

  it("escapes HTML in substituted values", () => {
    const out = mergeTemplate("{{document.recipientName}}", withDocument({
      recipientName: "<script>alert(1)</script>",
    }));

    expect(out).not.toContain("<script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the single quote too, because a template may use single-quoted attributes", () => {
    // <img alt='{{...}}'> is legal HTML that the plan's escaper would have broken out
    // of: it escaped " and not '.
    const out = mergeTemplate("<img alt='{{document.recipientName}}' src='x'>", withDocument({
      recipientName: "' onerror='alert(1)",
    }));

    expect(out).not.toContain("onerror='");
    expect(out).toContain("&#39;");
  });

  it("leaves a newline alone, because the template's white-space: pre-line prints it", () => {
    expect(mergeTemplate("{{org.addressLines}}", CONTEXT)).toBe("1 High St\n1234 AB Amsterdam");
  });

  it("leaves something that is not a merge tag exactly as it found it", () => {
    // Visible feedback, on the page, where the person editing the template will see
    // it. Silently deleting `{{ oops }}` would leave them hunting for a blank.
    for (const literal of ["{{ }}", "{{1abc}}", "{{a b}}", "{{#}}", "{{/}}", "{{", "}}", "{{{a}}}"]) {
      expect(mergeTemplate(literal, CONTEXT)).toBe(literal);
    }
  });
});

describe("mergeTemplate repeats a lines block", () => {
  it("repeats it once per line", () => {
    expect(mergeTemplate("{{#lines}}<i>{{description}}</i>{{/lines}}", CONTEXT))
      .toBe("<i>Widget</i>");
  });

  it("repeats it for every line", () => {
    const two: MergeContext = {
      ...CONTEXT,
      lines: [CONTEXT.lines[0]!, { ...CONTEXT.lines[0]!, description: "Sprocket" }],
    };

    expect(mergeTemplate("{{#lines}}[{{description}}]{{/lines}}", two)).toBe("[Widget][Sprocket]");
  });

  it("renders nothing for no lines, and its inverse renders instead", () => {
    const none: MergeContext = { ...CONTEXT, lines: [] };

    expect(mergeTemplate("a{{#lines}}x{{/lines}}b", none)).toBe("ab");
    expect(mergeTemplate("a{{^lines}}none yet{{/lines}}b", none)).toBe("anone yetb");
  });

  it("still sees the outer context from inside a line", () => {
    // The plan's version looked ONLY at the line's own fields inside the block, so
    // {{document.number}} on a line row rendered blank. A quote whose line rows carry
    // the currency or the document number is an ordinary thing to want.
    expect(mergeTemplate("{{#lines}}{{description}} on {{document.number}}{{/lines}}", CONTEXT))
      .toBe("Widget on QUO-2026-0001");
  });

  it("escapes line values as well", () => {
    const evil: MergeContext = {
      ...CONTEXT,
      lines: [{ ...CONTEXT.lines[0]!, description: "<b>x</b>" }],
    };

    expect(mergeTemplate("{{#lines}}{{description}}{{/lines}}", evil)).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("mergeTemplate renders a conditional block", () => {
  it("renders the body when the value is not empty", () => {
    expect(mergeTemplate("{{#document.number}}Quote {{document.number}}{{/document.number}}", CONTEXT))
      .toBe("Quote QUO-2026-0001");
  });

  it("renders nothing when the value is empty, taking its label with it", () => {
    // THE WHOLE POINT OF THE RULING. Without this, an install that never filled in a
    // VAT number prints the word "VAT" over a blank on every quote.
    expect(mergeTemplate("{{#org.vatNumber}}VAT {{org.vatNumber}}{{/org.vatNumber}}", CONTEXT))
      .toBe("");
  });

  it("renders nothing when the path is unknown", () => {
    expect(mergeTemplate("a{{#org.nope}}x{{/org.nope}}b{{#nope.nope}}y{{/nope.nope}}c", CONTEXT))
      .toBe("abc");
  });

  it("treats a value of nothing but whitespace as empty", () => {
    // address_lines and notes are newline-separated free text out of a textarea, so
    // "\n \n" is what an emptied field actually looks like in the database.
    const blank = withDocument({ notes: "\n \t\n" });

    expect(mergeTemplate("{{#document.notes}}Notes: {{document.notes}}{{/document.notes}}", blank))
      .toBe("");
  });

  it("renders the inverse block when the value is empty, and only then", () => {
    expect(mergeTemplate("{{^document.validUntilDate}}no expiry{{/document.validUntilDate}}", CONTEXT))
      .toBe("no expiry");
    expect(mergeTemplate(
      "{{^document.validUntilDate}}no expiry{{/document.validUntilDate}}",
      withDocument({ validUntilDate: "2026-09-27" }),
    )).toBe("");
  });

  it("renders the inverse of an unknown path, which is the empty case", () => {
    expect(mergeTemplate("{{^nope.nope}}nothing there{{/nope.nope}}", CONTEXT))
      .toBe("nothing there");
  });

  it("renders a bag as a scope when it is used as a block", () => {
    expect(mergeTemplate("{{#org}}{{name}}{{/org}}", CONTEXT)).toBe("Listerdale");
  });

  it("keeps a block body that contains braces of its own", () => {
    expect(mergeTemplate("{{#document.number}}a{b}c{{/document.number}}", CONTEXT)).toBe("a{b}c");
  });
});

/**
 * NESTING IS OUT OF SCOPE FOR THE FIRST CUT, WHICH IS NOT THE SAME AS UNDEFINED.
 *
 * A regex parser does SOMETHING here -- `{{#a}}([\s\S]*?){{/a}}` stops at the first
 * closer it sees, so a nested block leaves its own tags behind as literal text on the
 * page. The hand-written scanner below matches closers by depth instead, so nesting
 * simply works; these tests are what says so, and what would fail if somebody
 * replaced the scanner with the regex the plan sketched.
 */
describe("mergeTemplate and blocks inside blocks", () => {
  it("matches a closer to its own opener by depth, not to the first one it meets", () => {
    const out = mergeTemplate(
      "{{#document.number}}[{{#org.name}}{{org.name}}{{/org.name}}]{{/document.number}}",
      CONTEXT,
    );

    expect(out).toBe("[Listerdale]");
  });

  it("drops a nested block whose own value is empty, and keeps the rest of the outer body", () => {
    const out = mergeTemplate(
      "{{#document.number}}A{{#org.vatNumber}}VAT{{/org.vatNumber}}B{{/document.number}}",
      CONTEXT,
    );

    expect(out).toBe("AB");
  });

  it("drops the whole nest when the outer block is empty", () => {
    const out = mergeTemplate(
      "{{#org.vatNumber}}A{{#document.number}}B{{/document.number}}C{{/org.vatNumber}}",
      CONTEXT,
    );

    expect(out).toBe("");
  });

  it("REFUSES a block nested inside a block of the same path", () => {
    // **THIS USED TO BE DEFINED BEHAVIOUR AND IS NOW AN ERROR**, by coordinator
    // ruling after a review. It was tested here as "n^2, and that is the DEFINED
    // answer rather than an accidental one" -- true, and beside the point: it is also
    // a size multiplier with no legitimate use.
    //
    // `{{#lines}}` inside `{{#lines}}` re-resolves `lines` from the root, so the body
    // runs once per line PER LEVEL. A 114-character template and an ordinary 47-line
    // quote -- 11% of the input gate's budget -- merged to 130,346 bytes, UNDER the
    // renderer's input cap so nothing refused it, and cost 9.65s and 353MB to lay out
    // as 2,209 table rows. Bounding the symptom was never going to work, because the
    // symptom is measured in bytes and the cost is not.
    //
    // Removing it is what makes merged size track input size again, which is what
    // lets issueQuote's measurement of the merged output be a sound bound on cost.
    for (const template of [
      "{{#document.number}}A{{#document.number}}B{{/document.number}}C{{/document.number}}",
      "{{#lines}}({{#lines}}{{description}}{{/lines}}){{/lines}}",
      // Not adjacent: any depth of the same path counts.
      "{{#lines}}{{#org.name}}{{#lines}}x{{/lines}}{{/org.name}}{{/lines}}",
      // The inverted form multiplies nothing, but it is the same shape and the rule
      // is about the shape rather than about this context's data.
      "{{#lines}}{{^lines}}x{{/lines}}{{/lines}}",
    ]) {
      expect(() => mergeTemplate(template, CONTEXT)).toThrow(TemplateError);
      expect(documentTemplateErrors(template)).toHaveLength(1);
      expect(documentTemplateErrors(template)[0]).toContain("nested inside another");
    }
  });

  it("still allows different blocks nested in each other, which is how the template works", () => {
    // The rule is same-path only. The seeded template nests optional fields inside
    // the letterhead and fields inside {{#lines}} constantly.
    expect(mergeTemplate("{{#lines}}{{#org.name}}{{description}}{{/org.name}}{{/lines}}", CONTEXT))
      .toBe("Widget");
    expect(documentTemplateErrors("{{#a}}{{#b}}{{#c}}x{{/c}}{{/b}}{{/a}}")).toEqual([]);
  });

  /**
   * THE BOUND IS ON WORK, NOT ON OUTPUT, AND A REVIEWER IS WHY.
   *
   * The output cap alone did not terminate: it is only reached by a node that EMITS,
   * so a nest whose innermost body emits nothing ran `lines.length ** depth` times
   * with the character count stuck at zero. Measured before the fix, with twenty line
   * items: depth 7 took 30 seconds and did not throw, depth 12 was 4.1e15 iterations
   * from a 240-character template. `mergeTemplate` is synchronous, so that is the
   * whole event loop, and templates are user-editable.
   *
   * The first version of this test put `{{description}}` in the body, which emits,
   * which is why it always hit the cap and proved nothing about the case that
   * mattered. Every shape below has a body that produces NOTHING.
   *
   * Each is given a tight timeout, which catches a bound that got LOOSE. It does not
   * catch one that is gone: `mergeTemplate` is synchronous, so vitest's timer cannot
   * fire until it returns, and removing the budget hangs the run instead of failing
   * it -- measured, killed at 120s. That is the argument for the bound living in the
   * module rather than in a test's patience.
   */
  const TWENTY_LINES = Array.from({ length: 20 }, (_, i) => ({
    description: `Line ${String(i)}`, qty: "1", unitPrice: "1.00", taxRate: "21%", lineTotal: "1.00",
  }));

  const NON_EMITTING: { name: string; body: string; depth: number }[] = [
    // DEPTH 5 IS HERE TO MAKE A MISSING BUDGET FAIL RATHER THAN HANG. Every other
    // row is astronomically over budget, so with the budget removed they run for
    // hours and take the CI job's 20-minute timeout with them, unattributed. Depth 5
    // over twenty lines is 3.2e6 expansions: over the budget, so it throws here, and
    // 72ms without it, so the mutation fails `toThrow` by name.
    { name: "an empty body", body: "", depth: 5 },
    { name: "an empty body", body: "", depth: 6 },
    { name: "an empty body", body: "", depth: 12 },
    { name: "a body holding only an unknown field", body: "{{nope.nope}}", depth: 9 },
    { name: "a body holding only an empty field", body: "{{org.vatNumber}}", depth: 9 },
    { name: "a body holding only a block that never renders", body: "{{#org.vatNumber}}x{{/org.vatNumber}}", depth: 8 },
  ];

  for (const { name, body, depth } of NON_EMITTING) {
    it(`stops a nest of ${String(depth)} blocks with ${name}, which emits nothing to count`, () => {
      const nested = "{{#lines}}".repeat(depth) + body + "{{/lines}}".repeat(depth);

      expect(() => mergeTemplate(nested, { ...CONTEXT, lines: TWENTY_LINES }))
        .toThrow(TemplateError);
    }, 2000);
  }

  /**
   * A STEP MUST COST A BOUNDED AMOUNT, OR COUNTING STEPS BOUNDS NOTHING.
   *
   * `lookup` split the dotted path on every visit, so the work in one step was linear
   * in the path's length and a 1,000,000-step budget bought an unbounded amount of
   * it. Three blocks over 130 line items, measured before the fix: a 5,000-segment
   * path took 31 seconds and a 20,000-segment one -- a 39KB template -- took 139,
   * each ending in a clean TemplateError, which is worse than the original runaway
   * because it looks handled. `body_html` has no length CHECK, so a 1MB template
   * extrapolated to about 55 minutes.
   *
   * The path is split once at parse time now, and the same three cases measure 99ms,
   * 94ms and 79ms -- flat in path length.
   *
   * The elapsed assertion is what names a regression, and it is deliberately not left
   * to the vitest timeout: `mergeTemplate` is synchronous, so the timer cannot fire
   * until the work finishes, and re-introducing the split makes these three cases
   * take 139, 31 and 0.1 seconds before anything is reported at all. The failure is
   * therefore SLOW rather than immediate -- one more reason the bound belongs in the
   * module and not in a test's patience.
   */
  for (const segments of [1, 5_000, 20_000]) {
    it(`spends a bounded amount per step on a ${String(segments)}-segment path`, () => {
      const path = ["org", ...Array.from({ length: segments - 1 }, () => "x")].join(".");
      const nested = "{{#lines}}".repeat(3) + `{{${path}}}` + "{{/lines}}".repeat(3);
      // 130 lines, three deep: 2.2e6 expansions, so the budget stops it either way.
      // What the timeout is watching is how long those million steps TAKE.
      const lines = Array.from({ length: 130 }, () => TWENTY_LINES[0]!);

      const started = Date.now();
      expect(() => mergeTemplate(nested, { ...CONTEXT, lines })).toThrow(TemplateError);
      expect(Date.now() - started, "a step must cost a bounded amount").toBeLessThan(2000);
    }, 300_000);
  }

  it("stops a nest whose body DOES emit, which is what the output cap is for", () => {
    const nested = "{{#lines}}".repeat(7) + "{{description}}" + "{{/lines}}".repeat(7);

    expect(() => mergeTemplate(nested, { ...CONTEXT, lines: TWENTY_LINES }))
      .toThrow(TemplateError);
  }, 2000);

  it("parses an unclosed block with 124,306 nodes in it without a RangeError", () => {
    // The spread in the parser's unwind passed every node as a call argument, and V8
    // stops at about 124,000 of them. The shape is the plainest typo this module
    // claims to handle -- a block somebody forgot to close -- in a 364KB template,
    // and it threw out of the parser before any of the three bounds could see it.
    const template = "{{#lines}}" + "{{a}}x".repeat(62_153);
    const error = ((): unknown => {
      try { mergeTemplate(template, CONTEXT); return null; } catch (e: unknown) { return e; }
    })();

    expect(error).toBeNull();
    expect(mergeTemplate(template, CONTEXT)).toBe("x".repeat(62_153));
  }, 10_000);

  it("throws a TemplateError rather than a RangeError when a template nests thousands deep", () => {
    // `render` descends once per level, so without a depth bound this is the
    // JavaScript stack failing, which is not something Task 4's route can be written
    // against. 20,000 levels is a 400KB template and was measured hitting it.
    const deep = "{{#lines}}".repeat(20_000) + "x" + "{{/lines}}".repeat(20_000);
    const error = ((): unknown => {
      try { mergeTemplate(deep, CONTEXT); return null; } catch (e: unknown) { return e; }
    })();

    expect(error).toBeInstanceOf(TemplateError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as TemplateError).message).toContain("nested");
  }, 5000);

  it("does not bite a document shaped like a real one, which is the other half of a bound", () => {
    // 130 line items is the ceiling Task 2's budget arithmetic gives at a 500-char
    // description, so this is the largest quote that can render at all. A bound that
    // stopped it would be a bug of the opposite kind. The SEEDED template at that
    // size is asserted in documents-seed.test.ts, against the real thing: 1,656 steps
    // with every field filled in, against a 1,000,000 cap.
    const lines = Array.from({ length: 130 }, (_, i) => ({
      description: `Consultancy, phase ${String(i)}`,
      qty: "2", unitPrice: "1,250.00", taxRate: "21%", lineTotal: "2,500.00",
    }));
    const template = "<table>{{#lines}}<tr><td>{{description}}</td><td>{{lineTotal}}</td></tr>{{/lines}}</table>" +
      "{{#org.vatNumber}}VAT {{org.vatNumber}}{{/org.vatNumber}}{{^org.vatNumber}}-{{/org.vatNumber}}";

    expect(() => mergeTemplate(template, { ...CONTEXT, lines })).not.toThrow();
  });

  it("has bounds far above any real document, and one on the stack", () => {
    // None of these is a document-size limit -- renderPdf's 128KB input cap is that.
    // They are runaway-expansion limits. The headroom is asserted against the REAL
    // seeded template in documents-seed.test.ts, which is the only place that has it;
    // an earlier version of this test used an ad-hoc 787-step stand-in and guarded
    // half the true figure.
    expect(MERGE_MAX_OUTPUT_CHARS).toBeGreaterThan(128 * 1024);
    expect(MERGE_MAX_STEPS).toBeGreaterThan(100_000);
    expect(MERGE_MAX_DEPTH).toBeGreaterThan(8);
  });
});

/**
 * A TEMPLATE IS EDITED BY HAND IN A TEXTAREA, so every one of these is a thing a
 * person will actually type. None of them may throw, and none of them may make the
 * rest of the document disappear -- which is the trap in the obvious implementation,
 * where an unclosed block swallows everything after it.
 */
describe("mergeTemplate and a template somebody typed wrong", () => {
  it("ignores an unclosed block and renders its body as ordinary content", () => {
    // The safe direction. Treating the rest of the file as the block's body would
    // delete the whole quote below the typo whenever the value happened to be empty.
    expect(mergeTemplate("A{{#org.vatNumber}}B{{org.name}}", CONTEXT)).toBe("ABListerdale");
    expect(mergeTemplate("A{{^org.vatNumber}}B", CONTEXT)).toBe("AB");
  });

  it("ignores a closer that never had an opener", () => {
    expect(mergeTemplate("A{{/lines}}B", CONTEXT)).toBe("AB");
  });

  it("ignores a closer whose name does not match the block it is inside", () => {
    // {{/other}} closes nothing, so the {{#document.number}} it sits in is left
    // unclosed and is ignored in turn -- the body still renders.
    expect(mergeTemplate("A{{#document.number}}B{{/other}}C", CONTEXT)).toBe("ABC");
  });

  it("renders an empty template and a template with no fields", () => {
    expect(mergeTemplate("", CONTEXT)).toBe("");
    expect(mergeTemplate("<p>No merge fields here.</p>", CONTEXT)).toBe("<p>No merge fields here.</p>");
  });

  it("never throws on a malformed template, only on one that cannot be bounded", () => {
    // A typo has to be a blank on a page, not a failed render an hour before a quote
    // is due. `{{#lines}}{{#lines}}{{/lines}}` USED TO BE ON THIS LIST and is not any
    // more: a block nested inside itself is refused outright, which is a different
    // class from a typo -- it is the one shape whose cost is not bounded by its size.
    for (const template of [
      "{{#lines}}", "{{/lines}}", "{{^}}", "{{#a.b.c.d.e}}x{{/a.b.c.d.e}}",
      "{{/lines}}{{#lines}}x{{/lines}}",
    ]) {
      expect(() => mergeTemplate(template, CONTEXT)).not.toThrow();
    }
  });
});

// --------------------------------------------------------------- what is silent

/**
 * EVERYTHING THIS MODULE DOES QUIETLY, SAID OUT LOUD.
 *
 * Each of these renders without complaint and is not what the author meant, and
 * `{{org.brandColour}}` in a stylesheet is the one somebody will actually write. The
 * warnings are for Task 5's editor: they cannot throw, because a template being
 * edited is half-written by definition.
 */
describe("documentTemplateWarnings", () => {
  it("says nothing about a template that is fine", () => {
    expect(documentTemplateWarnings(
      "<style>@page { size: A4; }</style><h1>{{document.number}}</h1>" +
        "{{#lines}}{{description}}{{/lines}}{{^lines}}none{{/lines}}",
    )).toEqual([]);
  });

  it("names a merge field left unresolved inside a <style> block", () => {
    const warnings = documentTemplateWarnings("<style>body { color: {{org.brandColour}} }</style>");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("{{org.brandColour}}");
    expect(warnings[0]).toContain("<style>");
  });

  it("names an unclosed <style>, which swallows every field after it", () => {
    // Including one inside an HTML comment, which is where this is least obvious.
    const warnings = documentTemplateWarnings("<!-- <style> --><p>{{org.name}}</p>");

    expect(warnings.some((w) => w.includes("never closed"))).toBe(true);
  });

  it("names an unclosed block and a closer that closes nothing", () => {
    expect(documentTemplateWarnings("{{#org.vatNumber}}VAT")[0]).toContain("{{#org.vatNumber}}");
    expect(documentTemplateWarnings("{{/lines}}")[0]).toContain("{{/lines}}");
  });

  it("says nothing about a typo, because a blank is the defined answer there", () => {
    expect(documentTemplateWarnings("{{document.nope}} {{ oops }}")).toEqual([]);
  });
});

// ------------------------------------------------------------------ the order

describe("prepareDocumentHtml merges first and sanitises last", () => {
  it("stops a merged value from smuggling markup", () => {
    const html = prepareDocumentHtml("<p>{{document.recipientName}}</p>", withDocument({
      recipientName: '<img src="http://evil.test/beacon.png">',
    }));

    // It prints as text, which is the right answer for a company called that: the
    // escape is what stops it becoming an element, and nothing here fetches anything.
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("&lt;img");
  });

  it("stops a merged value from restyling the whole document", () => {
    // The case escaping is needed for even though the sanitiser runs afterwards: a
    // <style> block is exactly what a template is ALLOWED to contain, so sanitising
    // a merged value would have waved this through.
    const html = prepareDocumentHtml("<p>{{document.recipientName}}</p>", withDocument({
      recipientName: "<style>@page { size: Letter }</style>",
    }));

    expect(html).not.toContain("<style>");
    expect(html).toContain("&lt;style&gt;");
  });

  /**
   * THE ORDER IS LOAD-BEARING AND THIS IS THE CASE THAT DECIDES IT.
   *
   * HTML escaping is escaping for ONE context. A value substituted inside a `style`
   * attribute or a `<style>` block is in a different one, where `<`, `>` and `&` are
   * not what matters and `url(` is -- so the escaper cannot help, and only a
   * sanitiser looking at the FINISHED document can. Sanitising the template first and
   * merging afterwards would hand the renderer a `file://` URL that nothing had
   * looked at.
   */
  it("catches a URL a value smuggled into a CSS context, which escaping cannot", () => {
    // THE ORDER MUTATION DETECTOR, and its claim is narrower than it looks. What is
    // proved: `&quot;` IS handed back to the CSS parser as a real quote, so the
    // escape does not contain the value -- it travels through the attribute and
    // closes the url() from the inside -- and the wrong order leaves
    // `url(file:///etc/passwd)` sitting in the finished document where nothing has
    // looked at it.
    //
    // What is NOT proved, and was claimed here before a reviewer measured it: that
    // the survivor gets FETCHED. It does not on 57.2 -- the injected declaration is
    // not live -- and in the shipped order the attribute disappears because postcss
    // fails to parse the braces, not because sanitizeCss removed the URL (it removes
    // it too, first). No payload has yet been found where the wrong order produces an
    // actual fetch: surviving template-time sanitisation means hiding behind `data:`,
    // and getting out of a `data:` url() needs a quote break that leaves the CSS
    // invalid. The test earns its place as an order detector, not as an exploit.
    const template = '<div style="background: url(data:image/png;base64,{{document.notes}})">x</div>';
    const evil = withDocument({ notes: 'x")} body{background:url(file:///etc/passwd)} p{a:("' });

    expect(prepareDocumentHtml(template, evil)).not.toContain("etc/passwd");

    // The other order, spelled out: merging into an already-sanitised template leaves
    // the URL sitting in the document with nothing left to look at it. This assertion
    // is the mutation test for the order -- swapping the two calls in
    // prepareDocumentHtml makes the case above look exactly like this one.
    expect(mergeTemplate(sanitizeDocumentHtml(template), evil)).toContain("etc/passwd");
  });

  it("keeps a style attribute whose value arrived by merge, URL removed and the rest intact", () => {
    // What actually happens in the shipped order, because an earlier note claimed the
    // attribute was destroyed and that was only true of an UNMERGED template. Task 5
    // documents this surface, so it has to be right: the attribute survives with the
    // merged value in it, and the CSS scanner -- not the destruction of the attribute
    // -- is what takes the URL out.
    const html = prepareDocumentHtml(
      '<div style="color: {{document.notes}}">x</div>',
      withDocument({ notes: "red" }),
    );

    expect(html).toContain("color:red");
  });

  it("drops a style attribute that STILL holds a merge field, which only the wrong order produces", () => {
    // parseStyleAttributes defaults to true, so postcss parses the value even though
    // allowedStyles is unset (allowedStyles only decides whether the parsed tree is
    // filtered -- it is the filter that is off here, not the parse). `{{` is not CSS,
    // the parse fails, the attribute goes. Fail-closed, and unreachable through
    // prepareDocumentHtml, where the value has already been substituted.
    expect(sanitizeDocumentHtml('<div style="color: {{document.notes}}">x</div>'))
      .toBe("<div>x</div>");
  });

  it("does not substitute inside a <style> block at all", () => {
    // The refusal, and three reasons in one test. HTML escaping is not CSS escaping,
    // so a quote becomes `&quot;` which CSS does not decode; a value ending in a
    // BACKSLASH escapes the closing quote of the string it landed in and swallows the
    // rest of the stylesheet, faithfully to CSS; and a url() in a value would be
    // caught only by the sanitiser. None of it is reachable if the field is never
    // substituted there.
    const template = "<style>body::after { content: '{{document.notes}}'; }</style><p>{{document.notes}}</p>";
    const html = prepareDocumentHtml(template, withDocument({ notes: "back\\" }));

    expect(html).toContain("'{{document.notes}}'");
    expect(html).toContain("<p>back\\</p>");
    // The stylesheet still ends where it should: nothing was swallowed.
    expect(html).toContain("}</style>");
  });

  it("leaves the field alone whatever the style tag looks like", () => {
    for (const open of ["<style>", "<STYLE>", '<style type="text/css">', "<style\n>"]) {
      const html = mergeTemplate(`${open}a{b:{{org.name}}}</style>{{org.name}}`, CONTEXT);
      expect(html).toContain("{{org.name}}");
      expect(html).toContain("Listerdale");
    }
  });

  it("ends a style region only where HTML ends one, which is not at </styles>", () => {
    // `</styles>` is TEXT to a parser, so everything after it is still CSS. Ending
    // the region there put the field back into a live stylesheet -- the direction an
    // earlier comment called impossible.
    for (const fake of ["</styles>", "</stylex", "</style-a>"]) {
      const merged = mergeTemplate(`<style>a{b:c}${fake} body{color:{{org.name}}}</style>`, CONTEXT);
      expect(merged).toContain("{{org.name}}");
      expect(merged).not.toContain("Listerdale");
    }

    // ...and the real end tag still ends it, in each of its three spellings.
    for (const real of ["</style>", "</style ", "</style/"]) {
      const merged = mergeTemplate(`<style>a{b:c}${real} {{org.name}}`, CONTEXT);
      expect(merged).toContain("Listerdale");
    }
  });

  it("does not delete a whole stylesheet over a </styles> sitting in its text", () => {
    // The other half of the same mistake: the fail-closed check in
    // sanitizeDocumentHtml used the same loose needle, so one such token anywhere in
    // a stylesheet silently took the entire <style> element with it.
    const html = sanitizeDocumentHtml('<style>a{content:"</styles>"} p{color:#111}</style>');

    expect(html).toContain("color:#111");
    expect(html).toContain("<style>");
  });

  it("leaves an ordinary quote looking like itself", () => {
    const html = prepareDocumentHtml(
      '<style>@page { size: A4; }</style><h1>Quote {{document.number}}</h1>' +
        '<table>{{#lines}}<tr><td class="pre">{{description}}</td>' +
        '<td class="right">{{lineTotal}}</td></tr>{{/lines}}</table>',
      CONTEXT,
    );

    expect(html).toContain("@page");
    expect(html).toContain("<h1>Quote QUO-2026-0001</h1>");
    expect(html).toContain('<td class="pre">Widget</td>');
    expect(html).toContain('<td class="right">100.00</td>');
  });
});

// ----------------------------------------- what the renderer does NOT catch

/**
 * THE CASE FOR THIS MODULE EXISTING, PROVED ON THE RENDERER RATHER THAN ARGUED.
 *
 * documents-render.ts blocks every scheme it is asked to FETCH. An `href` is not
 * fetched: WeasyPrint writes it into the PDF as a link annotation, so the three
 * controls there never see it and the finished quote ships a live `file://` or
 * `http://` link to whoever opens it. The sanitiser is the only control for that,
 * which is the half of the job the renderer cannot do.
 *
 * Measured on the server (WeasyPrint 57.2): the anchor case exits 0 with
 * `/URI (file:///...)` in the PDF, and the CSS case exits 2.
 *
 * BOTH ASSERTIONS GO THROUGH `pdfText`, and the first version of this file did not --
 * CI failed on it. 61.1 compresses object streams, so the `/URI` was invisible to a
 * raw byte search on the runner and plain text on the server. The negative assertion
 * is the one that mattered: it would have passed VACUOUSLY on 61.1 forever.
 */
describe("the renderer and the sanitiser cover different halves", () => {
  itReal("does not stop a file:// anchor href, and the sanitiser does", async () => {
    const evil = '<html><body><a href="file:///etc/hostname">x</a></body></html>';
    const pdf = await renderPdf(evil);

    // No RenderError: the renderer had no opinion about it at all.
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdfText(pdf)).toContain("file:///etc/hostname");

    const cleaned = await renderPdf(sanitizeDocumentHtml(evil));
    expect(pdfText(cleaned)).not.toContain("file:///etc/hostname");
  }, 30_000);

  itReal("does stop a file:// in CSS, so there the sanitiser is the second control", async () => {
    const evil = '<html><head><style>body { background: url("file:///etc/hostname"); }</style></head><body>x</body></html>';

    await expect(renderPdf(evil)).rejects.toThrow("document referenced a blocked resource");

    // And the sanitised version renders, which is the point of stripping it here:
    // a template with one bad URL in it would otherwise fail every quote it raised.
    const pdf = await renderPdf(sanitizeDocumentHtml(evil));
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 30_000);
});
