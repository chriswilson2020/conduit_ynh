import sanitizeHtml from "sanitize-html";

/* ========================================================================== *
 *  THE SANITISER PROFILE
 * ========================================================================== */

/**
 * Tags a document may use. Wider than the mail profile and narrower than HTML.
 *
 * The rule for adding one: it must carry no URL of its own and nothing executable.
 * `img` and `a` are the two exceptions and are handled attribute by attribute below;
 * `style` is here because page layout is the whole reason this profile exists, and
 * its CONTENTS are sanitised separately (sanitize-html emits the text of an allowed
 * `style` element verbatim -- measured, not assumed -- so `url(file:///etc/passwd)`
 * inside one survives everything the library does).
 *
 * Absent on purpose, and each is unit-tested as absent: script, iframe, object,
 * embed, form, input, video, audio, source, track, base, meta, link, svg. The last
 * three are the quiet ones -- `<base href>` would give every relative URL in the
 * document somewhere to resolve to, `<meta http-equiv=refresh>` carries a URL in an
 * attribute nothing else looks at, and `<link rel=attachment>` is the exact element
 * that read a mode-600 key off the server during Task 1's spec review.
 */
const ALLOWED_TAGS = [
  "html", "head", "body", "style",
  "div", "span", "p", "br", "hr", "section", "article", "header", "footer", "main",
  "address", "blockquote", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "code", "abbr",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  "img", "a",
];

/**
 * Attributes, per tag. `style` and `class` are what the seeded template's layout is
 * built out of; `id` is here so a template can carry an anchor for a fragment link.
 *
 * `rel` is deliberately NOT allowed on `a`, and `link` is not a tag at all: that pair
 * is the attachment vector. transformTags below strips `rel=attachment` regardless,
 * so a future edit that allows `rel` for some other reason cannot reopen it silently.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": ["style", "class", "id", "title", "lang", "dir"],
  img: ["src", "alt", "width", "height"],
  a: ["href"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  col: ["span"],
  colgroup: ["span"],
};

/**
 * Attributes that carry a URL, checked wherever they appear.
 *
 * Wider than ALLOWED_ATTRIBUTES on purpose. The allowlist already means most of these
 * cannot arrive, so this is the guard that holds if a later phase adds `poster` or
 * `background` for a legitimate reason: the URL rule applies to the attribute by
 * name, not to the one place somebody remembered to check.
 *
 * `srcset` is the one where this guard is NOT what decides. sanitize-html parses the
 * candidate list itself and scheme-checks each URL in it, after this transform has
 * seen the raw attribute value; both refuse a remote candidate, and the library's
 * parser is the one that handles a multi-candidate list correctly.
 */
const URL_ATTRIBUTES = new Set([
  "src", "href", "srcset", "imagesrcset", "background", "poster", "data", "action",
  "formaction", "cite", "longdesc", "usemap", "codebase", "classid", "archive",
  "profile", "manifest", "itemid", "ping", "dynsrc", "lowsrc", "xlink:href",
]);

/**
 * The attributes a `data:` URI may appear in: the ones a renderer FETCHES.
 *
 * Enumerated, so that the default for anything else is the restrictive position. It
 * was the other way round -- `href` was the only "link" and everything else fell
 * through to "fetch" -- which meant that adding, say, `xlink:href` to an element's
 * allowlist would have granted `data:` on a link without anybody choosing that. The
 * permissive branch is the one that should have to be named.
 */
const FETCH_ATTRIBUTES = new Set(["src", "srcset", "imagesrcset", "poster", "background"]);

/**
 * `rel="noopener attachment"` counts. The value is a space-separated token list.
 *
 * TWO CONTROLS COVER THIS AND NEITHER IS OBSERVABLE ALONE, which is recorded here
 * rather than left for the next person to rediscover: `rel` is not in
 * ALLOWED_ATTRIBUTES, so removing the check below fails no test, and allowing `rel`
 * on `a` while keeping the check fails no test either. Removing BOTH reopens the
 * vector and fails one. That is what redundancy looks like from a test suite, and the
 * check earns its place because the edit that allows `rel` for `noopener` is an
 * ordinary-looking edit.
 */
const REL_ATTACHMENT = /(^|\s)attachment(\s|$)/i;

/**
 * The allowlist, and it is an ALLOWLIST because the spec's own wording is not enough.
 *
 * The spec says the profile strips "any remote URL in any attribute". `file:` is not
 * remote, and `file:` is the one that has actually been used against this codebase --
 * a reviewer recovered `$DATA_DIR/mail.key` byte for byte through it. A denylist of
 * remote schemes would have let it straight through, so the rule is inverted: exactly
 * `data:` is permitted and everything else is refused, including the schemes nobody
 * has thought of yet.
 *
 * Two things are permitted besides `data:` and both are the absence of a URL rather
 * than a URL: a pure fragment (`#terms`), which names a place inside this very
 * document and can reach nothing, and nothing at all.
 *
 * `position` narrows it further, and the narrowing is deliberate rather than a side
 * effect of "exactly `data:` everywhere". A "fetch" position is one the renderer
 * resolves -- an `img src`, a CSS `url()`, an `@import` -- and there a `data:` URI is
 * the whole point, since that is how the org's logo arrives. A "link" position is an
 * `href`, which is never fetched at all: WeasyPrint writes it into the PDF as a link
 * annotation. `data:` buys nothing there and `<a href="data:text/html,...">` would
 * ride out of here into a `/URI` annotation, so a link may be a fragment and nothing
 * else.
 *
 * `mailto:` AND `tel:` ARE REFUSED, AND THAT IS A CAPABILITY LOSS RATHER THAN A
 * DANGER. No href of any scheme reaches the renderer's fetcher -- both are inert
 * `/URI` annotations -- so the reason is allowlist minimality, not exploitability: a
 * quote that links the issuer's email address is a plausible thing to want, and it is
 * DEFERRED, not rejected. Restoring it is two entries in the check below, scoped to
 * this "link" position so it cannot widen a fetch.
 *
 * Whitespace is trimmed only at the ENDS. A value like "data\n:text/html,x" is
 * refused rather than repaired, because deciding what a consumer would make of an
 * interior control character is exactly the guess this function must not make.
 */
type UrlPosition = "fetch" | "link";

/**
 * A whole attribute value that is exactly one merge token: `src="{{org.logoDataUri}}"`
 * and nothing else around it.
 *
 * **A `{{...}}` IN A URL POSITION IS NOT A URL YET, AND JUDGING IT AS ONE DELETED THE
 * LOGO FROM THE SHIPPED TEMPLATE.** Sanitising a template refused the token (it is
 * not `data:` and not a fragment), which dropped the `src`, which made
 * `exclusiveFilter` drop the whole `<img>` -- so GET the seeded template and PUT it
 * back unmodified and it came out 38 characters shorter with no logo in it, silently,
 * with no warning. That is precisely what Task 5's editor does the first time
 * somebody opens the template and saves it, and every quote after that prints no
 * logo.
 *
 * The layering was wrong rather than the rule. Template-time sanitisation sees
 * UNMERGED text; the value that eventually lands here is checked by the sanitise pass
 * that runs AFTER the merge (`prepareDocumentHtml`), where it really is a URL. So a
 * placeholder is permitted here and refused there if what it became is not allowed --
 * which is the pass that has always done the deciding.
 *
 * DELIBERATELY THE WHOLE VALUE, not a token anywhere inside one. `file:///{{x}}`
 * stays refused at template time even though the merged pass would catch it too:
 * there is no template in this repo that needs it, and the narrower rule is the one
 * that cannot be widened by accident.
 */
const WHOLE_MERGE_TOKEN = /^\s*\{\{[A-Za-z][A-Za-z0-9_.]*\}\}\s*$/;

function isPermittedUrl(value: string, position: UrlPosition = "fetch"): boolean {
  const trimmed = value.replace(/^[\x00-\x20]+/, "").replace(/[\x00-\x20]+$/, "");
  if (trimmed === "") return false;
  if (WHOLE_MERGE_TOKEN.test(trimmed)) return true;
  if (trimmed.startsWith("#")) return true;
  if (position === "link") return false;
  return /^data:/i.test(trimmed);
}

/* ------------------------------------------------------------------ the CSS -- */

/**
 * CSS IS NOT SANITISED BY sanitize-html AT ALL, and that is the gap this half fills.
 *
 * `allowedStyles` filters a `style` ATTRIBUTE by property name, and an empty object
 * disables it entirely rather than allowing nothing (measured against 2.17.7:
 * `filterCss` returns the tree untouched when no rule matches). The contents of a
 * `<style>` ELEMENT are emitted verbatim in every configuration. So both CSS
 * positions arrive here unexamined, and both can fetch: `url()`, `@import` -- with a
 * bare string as well as a `url()` -- and a `@font-face` `src`.
 *
 * This is a scanner rather than a regex because CSS hides things from a regex. Every
 * one of these was run against the real renderer on the server (WeasyPrint 57.2) and
 * every one of them fetched, which is how we know the escapes are decoded before the
 * fetch rather than being inert text:
 *
 *   `\75 rl("file:///etc/passwd")`      -- an escaped `url` ident is still a url token
 *   `@\69 mport url("file:///...")`     -- an escaped at-keyword is still `@import`
 *   `url(fi\6ce:///etc/passwd)`         -- escapes inside the URL itself
 *
 * A comment is replaced by a SPACE rather than deleted, and that is load-bearing
 * twice over. `url/**\/(x)` is not a url token to a CSS parser -- the paren has to
 * follow the ident immediately -- so deleting the comment would CREATE one. And a
 * deletion joins whatever sits on either side of it, which is how a `<` and a
 * `/style>` could end up adjacent and close the element early when the output is
 * parsed again. Every removal below therefore leaves a space behind.
 */

const HEX = /[0-9a-fA-F]/;
const WHITESPACE = /[\s]/;
/** An ident we are willing to re-emit in its decoded form: no delimiters in it. */
const SAFE_IDENT = /^[-_a-zA-Z0-9\u0080-\uffff]+$/;

function isIdentChar(c: string): boolean {
  return /[-_a-zA-Z0-9]/.test(c) || c.charCodeAt(0) >= 0x80;
}

function isIdentStart(c: string): boolean {
  return /[-_a-zA-Z]/.test(c) || c.charCodeAt(0) >= 0x80;
}

interface Read { value: string; next: number }

/** One CSS escape sequence, starting at the backslash. */
function readEscape(css: string, at: number): Read {
  const c = css[at + 1];
  if (c === undefined) return { value: "\ufffd", next: at + 1 };
  if (!HEX.test(c)) return { value: c === "\n" ? "" : c, next: at + 2 };

  let hex = "";
  let i = at + 1;
  while (i < css.length && hex.length < 6 && HEX.test(css[i]!)) {
    hex += css[i]!;
    i += 1;
  }
  // Exactly one whitespace after the digits belongs to the escape, and CRLF is one.
  if (i < css.length && WHITESPACE.test(css[i]!)) {
    i += css[i] === "\r" && css[i + 1] === "\n" ? 2 : 1;
  }
  const code = Number.parseInt(hex, 16);
  const bad = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
  return { value: bad ? "\ufffd" : String.fromCodePoint(code), next: i };
}

/** An identifier, with escapes decoded, starting at an ident character or backslash. */
function readIdent(css: string, at: number): Read {
  let value = "";
  let i = at;
  while (i < css.length) {
    const c = css[i]!;
    if (c === "\\") {
      const escape = readEscape(css, i);
      value += escape.value;
      i = escape.next;
      continue;
    }
    if (!isIdentChar(c)) break;
    value += c;
    i += 1;
  }
  return { value, next: i };
}

/** A quoted string, with escapes decoded. `next` lands past the closing quote. */
function readString(css: string, at: number): Read {
  const quote = css[at]!;
  let value = "";
  let i = at + 1;
  while (i < css.length) {
    const c = css[i]!;
    if (c === quote) { i += 1; break; }
    // A bad-string ends here, the way a CSS tokenizer ends one -- AND ALL THREE OF
    // THESE COUNT, which the first version of this function got wrong. CSS Syntax 3
    // preprocesses CR, FF and CRLF each into a single LF before tokenizing, so a bare
    // CR terminates a string exactly as a newline does. Breaking on "\n" alone meant
    // a string opened before a CR swallowed everything after it as string content,
    // and a `url(file:///etc/passwd)` sitting in there was copied out untouched --
    // proved by feeding this function's own output to a recording fetcher on the
    // server, which then asked for the file. The renderer's data:-only fetcher was
    // what stopped it, which is precisely the dependency this module exists to remove.
    if (c === "\n" || c === "\r" || c === "\f") break;
    if (c === "\\") {
      const after = css[i + 1];
      if (after === "\n") { i += 2; continue; }
      if (after === "\r") { i += css[i + 2] === "\n" ? 3 : 2; continue; }
      const escape = readEscape(css, i);
      value += escape.value;
      i = escape.next;
      continue;
    }
    value += c;
    i += 1;
  }
  return { value, next: i };
}

/** A url token's argument, quoted or not, starting at the `(`. */
function readUrlArgument(css: string, at: number): Read {
  let i = at + 1;
  while (i < css.length && WHITESPACE.test(css[i]!)) i += 1;

  let value = "";
  if (css[i] === '"' || css[i] === "'") {
    const string = readString(css, i);
    value = string.value;
    i = string.next;
    while (i < css.length && css[i] !== ")") i += 1;
  } else {
    while (i < css.length && css[i] !== ")") {
      if (css[i] === "\\") {
        const escape = readEscape(css, i);
        value += escape.value;
        i = escape.next;
        continue;
      }
      value += css[i]!;
      i += 1;
    }
    value = value.trim();
  }
  if (i < css.length) i += 1;
  return { value, next: i };
}

/**
 * A URL as a CSS string, escaped for the one context it is being written into.
 *
 * `<` and `>` are escaped as well as the quote and the backslash: a `data:` URI may
 * legitimately contain them (`data:image/svg+xml,<svg/>`), and a raw `</style>`
 * inside a stylesheet would end the element when the document is parsed again.
 */
function cssString(value: string): string {
  return value.replace(/[\\"<>\x00-\x1f\x7f]/g, (c) =>
    c === "\\" || c === '"' ? `\\${c}` : `\\${c.codePointAt(0)!.toString(16)} `);
}

/** Past whitespace and comments, which is what a CSS tokenizer skips between tokens. */
function skipTrivia(css: string, at: number): number {
  let i = at;
  for (;;) {
    while (i < css.length && WHITESPACE.test(css[i]!)) i += 1;
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    return i;
  }
}

/**
 * Remove every URL that is not a `data:` URI from a stylesheet or a declaration list.
 *
 * What it covers is `url()` tokens and `@import` (both forms). It is deliberately
 * LOOSER than the CSS grammar in one direction: `url ("x")` and `url/*c*\/("x")` are
 * not url tokens to a parser -- the paren has to follow the ident immediately -- but
 * they are treated as url tokens here, so what comes out has no `file://` sitting in
 * it for a later reader to be cleverer about than we were.
 *
 * What it does not cover is a bare string used as a URL by some construct other than
 * `@import`. `image-set("x" 1x)` is the only one in the language; it is not a fetch on
 * the server's WeasyPrint 57.2 (measured: the render succeeds and the file is never
 * opened), and if a later version does fetch it, the renderer's own `data:`-only
 * fetcher refuses it and the render fails loudly. A string anywhere else -- a
 * `content:` value, say -- is not fetched by anything, so it is left alone: the
 * property claimed here is that no url() and no @import in the output names anything
 * but a `data:` URI, not that the word "http" never appears.
 *
 * THE PROPERTY IS ONLY AS TRUE AS THE TOKENIZER AGREES WITH tinycss2, and the first
 * version of this scanner did not: it ended a string at "\n" alone, where CSS ends
 * one at CR and FF as well, so a string opened before a bare CR swallowed the rest of
 * the stylesheet as content and a live `url()` inside it was copied out. A reviewer
 * measured that survivor being FETCHED. It is only the renderer's `data:`-only
 * fetcher that stopped the shipped path -- and depending on that flag is the thing
 * this module exists not to do. Any future divergence from the tokenizer is the same
 * bug, so changes here belong next to a case in the test file's HIDDEN table.
 */
function sanitizeCss(css: string): string {
  let out = "";
  let i = 0;
  // True between `@import` and the `;` that ends it: there a bare string IS a URL.
  let importPrelude = false;

  while (i < css.length) {
    const c = css[i]!;

    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      out += " ";
      continue;
    }

    if (c === '"' || c === "'") {
      const string = readString(css, i);
      if (importPrelude) {
        importPrelude = false;
        out += isPermittedUrl(string.value) ? `"${cssString(string.value)}"` : " ";
      } else {
        out += css.slice(i, string.next);
      }
      i = string.next;
      continue;
    }

    if (c === "@") {
      const ident = readIdent(css, i + 1);
      if (ident.value === "") { out += c; i += 1; continue; }
      if (!SAFE_IDENT.test(ident.value)) { out += " "; i = ident.next; continue; }
      out += `@${ident.value}`;
      importPrelude = ident.value.toLowerCase() === "import";
      i = ident.next;
      continue;
    }

    if (c === "\\" || isIdentStart(c)) {
      const ident = readIdent(css, i);
      if (ident.value === "") { out += c; i += 1; continue; }
      if (ident.value.toLowerCase() === "url") {
        const paren = skipTrivia(css, ident.next);
        if (css[paren] === "(") {
          const url = readUrlArgument(css, paren);
          importPrelude = false;
          out += isPermittedUrl(url.value) ? `url("${cssString(url.value)}")` : " ";
          i = url.next;
          continue;
        }
      }
      out += SAFE_IDENT.test(ident.value) ? ident.value : " ";
      i = ident.next;
      continue;
    }

    if (c === ";" || c === "{" || c === "}") importPrelude = false;
    out += c;
    i += 1;
  }
  return out;
}

/** `<style>` elements in sanitize-html's OUTPUT, where their content is verbatim. */
const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;

/**
 * The document sanitiser profile -- deliberately NOT sanitizeMailHtml's.
 *
 * Mail's profile defangs HTML written by strangers and strips exactly the CSS that
 * page layout depends on. A document template is written by an authenticated user of
 * this CRM and rendered offline into a PDF, so the trade is different: layout CSS is
 * allowed, and everything executable or remote is not.
 *
 * "Authenticated" is not "trusted". Any user who can edit a template can put one line
 * in it and have the renderer read a file as the API's own user -- that is not a
 * theory, it is what happened during Task 1's spec review. So this profile is a
 * privilege boundary, not a tidying pass.
 *
 * ORDER: this runs on the MERGED document, after mergeTemplate. See
 * prepareDocumentHtml, which is the call site that gets the order right.
 */
export function sanitizeDocumentHtml(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    // sanitize-html's own scheme machinery, kept as the inner of two layers. It only
    // reaches the attributes in its `allowedSchemesAppliedToAttributes` list and it
    // permits a scheme-less (relative) URL by design, which is why transformTags
    // below does the checking that actually decides.
    allowedSchemes: ["data"],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    // allowedStyles is deliberately UNSET. Setting it to {} does not filter anything
    // (measured against 2.17.7); setting it to a property allowlist would be the mail
    // profile's answer, and a document needs properties this module has no business
    // enumerating. The URLs are what matter, and sanitizeCss takes those out.
    //
    // nonTextTags is deliberately unset too: the library's default list carries its
    // own mutation-XSS mitigations for `xmp` and `textarea`, and overriding it to
    // "keep the CSS" is unnecessary -- `style` is emitted verbatim because it is
    // ALLOWED, not because of that list.
    transformTags: {
      "*": (tagName: string, attribs: Record<string, string>) => {
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          const lower = name.toLowerCase();
          if (lower === "rel" && REL_ATTACHMENT.test(value)) continue;
          // Keyed on the attribute rather than on the tag, because `href` is only
          // ever on an `a` in this profile and a tag test would be a second thing to
          // keep in step. Anything not named as a fetch is a link, which is the
          // narrower of the two.
          const position: UrlPosition = FETCH_ATTRIBUTES.has(lower) ? "fetch" : "link";
          if (URL_ATTRIBUTES.has(lower) && !isPermittedUrl(value, position)) continue;
          if (lower === "style") {
            const css = sanitizeCss(value);
            if (css.trim() !== "") kept[name] = css;
            continue;
          }
          kept[name] = value;
        }
        return { tagName, attribs: kept };
      },
    },
    // An <img> whose src did not survive is not an image, it is an alt string and a
    // gap on the page. This is also the backstop for a template that hard-codes
    // <img src="{{org.logoDataUri}}"> on an install with no logo.
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
    // `style` is on sanitize-html's "inherently vulnerable" list and warns on every
    // call unless this is set. The warning is about injecting CSS into a page that
    // has a session; this output is fed to WeasyPrint, and its CSS is filtered below.
    allowVulnerableTags: true,
  });

  return cleaned.replace(STYLE_ELEMENT, (_match, open: string, css: string, close: string) => {
    const safe = sanitizeCss(css);
    // Fail closed. Nothing above can produce this -- every removal leaves a space --
    // but a stylesheet that closes its own element is worth losing rather than
    // shipping, because everything after it would be parsed as live markup.
    //
    // The terminator is part of the needle for the same reason it is part of
    // endsRawText: `</styles>` is ordinary text to a parser, and matching it here
    // deleted an entire legitimate stylesheet without a word.
    if (/<\/style[\s/>]/i.test(safe)) return "";
    return `${open}${safe}${close}`;
  });
}

/* ========================================================================== *
 *  MERGE FIELDS
 * ========================================================================== */

/** One priced line, as strings: the formatting happened in the caller. */
export interface MergeLine {
  description: string;
  qty: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
}

export interface MergeContext {
  org: Record<string, string>;
  document: Record<string, string>;
  lines: MergeLine[];
}

/** A template that cannot produce a document at all, as opposed to one with a typo. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * THREE BOUNDS, AND THE FIRST TWO ARE THE ONES THAT MATTER. Together they are
 * everything in this module that throws, and `TemplateError` is what all three throw
 * -- Task 4's route is written against that being true.
 *
 * Blocks nest, so expansion is not linear in the template. A 240-character template
 * with twelve `{{#lines}}` inside each other, against an ordinary twenty-line quote,
 * is 4.1e15 iterations; `render` is synchronous, so it takes the whole event loop
 * down, not one request. Templates are user-editable, which makes that a route.
 *
 * MERGE_MAX_STEPS is the bound that actually holds, because it counts WORK -- a node
 * visited or a block expanded -- rather than characters produced. The output cap
 * alone did not: it is only reached by a node that EMITS, and a nest whose innermost
 * body emits nothing never touches it.
 *
 * Measured on the server, all with twenty line items and a body that emits nothing:
 * depths 6, 9, 12 and 20 stop in 50-79ms, and a body holding one unknown field stops
 * in 288-329ms.
 *
 * THAT 5x SWING AT THE SAME STEP COUNT WAS A HOLE, AND THIS COMMENT ONCE READ IT AS
 * NOISE. A step must cost a bounded amount or counting steps bounds nothing: with the
 * path split on every visit, three blocks over 130 line items took 31 seconds at
 * 5,000 path segments and 139 at 20,000, each ending in a tidy TemplateError. The
 * paths are split once at parse time now and the same matrix is 99ms, 94ms and 79ms
 * -- flat in path length, which is the property.
 *
 * The seeded template with every field filled in merges in 1,656 steps at 130 line
 * items and 192 at eight, so a million is nearly three orders of magnitude of
 * headroom. **130 WAS "the largest quote that can render at all" AND IS NOT ANY
 * MORE**: DOCUMENT_MAX_LINES is 60, because 130 x 500 was measured against the real
 * template and does not fit the renderer's input cap. The step figures are left as
 * measured; the headroom only grew.
 *
 * MERGE_MAX_DEPTH bounds the RECURSION, which is a different failure: `render`
 * descends once per nesting level, and a few thousand levels is a RangeError out of
 * the JavaScript stack, which no `TemplateError` contract would survive. 32 is far
 * past anything a page needs.
 *
 * MERGE_MAX_OUTPUT_CHARS stays as the memory bound, at four times renderPdf's 128KB
 * input cap: anything between the two was never going to render anyway. Blanks never
 * throw -- that rule is what the unknown-field behaviour is for -- but a template
 * that cannot terminate is not a blank.
 */
export const MERGE_MAX_STEPS = 1_000_000;
export const MERGE_MAX_DEPTH = 32;
export const MERGE_MAX_OUTPUT_CHARS = 512 * 1024;

/**
 * `segments` is the dotted path already split, and that is a BOUND rather than a
 * micro-optimisation. `spend()` charges one step whatever a step costs, so anything
 * linear inside a step is an unbounded multiplier on the budget: splitting the path
 * on every visit made three nested blocks over 130 line items take 139 SECONDS of
 * frozen event loop for a 40KB template -- and then reported a clean TemplateError,
 * which is worse than the original runaway because it looks handled. Split once, at
 * parse time, where the cost is linear in the template and paid exactly once.
 */
type Node =
  | { kind: "text"; text: string }
  | { kind: "field"; segments: string[] }
  | { kind: "section"; path: string; segments: string[]; inverted: boolean; body: Node[] };

/** `{{ #org.vatNumber }}` -- an optional sigil and a dotted path, nothing else. */
const TAG = /^\s*([#^/]?)\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*$/;

/**
 * Parse a template into nodes.
 *
 * A HAND-WRITTEN SCANNER, NOT A REGEX, and the reason is that this is the half of
 * the module a person edits in a textarea at five to five. The plan sketched
 * `{{#lines}}([\s\S]*?){{/lines}}` with a `.replace` callback; generalising that to
 * `{{#path}}` needs a backreference, and it then has no answer for a block inside a
 * block (the lazy quantifier stops at the first closer, leaving the inner tags on the
 * page as literal text), for an unclosed block, or for a closer that matches nothing.
 * It would DO something in each case, and what it did would be an artefact of the
 * quantifier rather than a decision. A scanner makes each of them a decision:
 *
 *   nesting            closers match their own opener by depth, so blocks nest and
 *                      an inner block resolves paths against the enclosing scope
 *                      first (Mustache's rule) and the root after that.
 *   an unclosed block  the block is IGNORED and its body renders as ordinary
 *                      content. The alternative -- treating the rest of the template
 *                      as the body -- deletes everything below a typo whenever the
 *                      value happens to be empty, which is the worst failure
 *                      available here.
 *   a stray closer     dropped.
 *   a mismatched one   dropped, which leaves its block unclosed, which is the case
 *                      above.
 *   anything that is
 *   not a tag at all   left exactly as it was found -- `{{ }}`, `{{1a}}`, `{{{a}}}`
 *                      and `{{__proto__}}` all print, so the author can see them.
 *                      `{{ oops }}` is NOT one of these: surrounding whitespace is
 *                      tolerated, so it is a tag for an unknown path and renders
 *                      blank, which is Mustache's behaviour and the right one.
 *
 * It is also linear: a lazy quantifier plus a backreference over a 128KB template is
 * a rescan from every `{{` in the file.
 */
/**
 * `</style` is only an end tag when what follows it is `>`, `/` or whitespace.
 *
 * HTML's raw-text rule, and getting it wrong was a defect in BOTH directions rather
 * than the harmless one an earlier comment here claimed. `</styles>` is ordinary text
 * to the parser and was end-of-region to this scanner, so a merge field after it was
 * substituted into live CSS; and the same needle in sanitizeDocumentHtml's fail-closed
 * check deleted an entire legitimate stylesheet in silence.
 */
function endsRawText(template: string, at: number): boolean {
  const after = template[at + "</style".length];
  return after === ">" || after === "/" || (after !== undefined && /\s/.test(after));
}

function cssRegions(template: string): { from: number; to: number; terminated: boolean }[] {
  const regions: { from: number; to: number; terminated: boolean }[] = [];
  const lower = template.toLowerCase();
  const open = /<style\b[^>]*>/gi;
  for (;;) {
    const match = open.exec(template);
    if (match === null) break;
    const from = match.index + match[0].length;

    let close = lower.indexOf("</style", from);
    while (close !== -1 && !endsRawText(template, close)) {
      close = lower.indexOf("</style", close + 1);
    }
    const to = close === -1 ? template.length : close;
    regions.push({ from, to, terminated: close !== -1 });
    open.lastIndex = to;
  }
  return regions;
}

interface Parsed { nodes: Node[]; warnings: string[]; errors: string[] }

function parse(template: string): Parsed {
  const warnings: string[] = [];
  const errors: string[] = [];
  // WHAT IS INSIDE A <style> BLOCK IS NOT MERGED AT ALL, and that is a refusal rather
  // than an omission. HTML escaping is escaping for one context and CSS is another
  // one, so every direction is wrong there: a value with a quote in it becomes
  // `&quot;`, which CSS does not decode; a value ENDING IN A BACKSLASH escapes the
  // closing quote of the string it landed in and swallows the rest of the stylesheet,
  // faithfully to CSS; and a value can put a `url()` somewhere only the sanitiser
  // would catch. Leaving the tokens alone means none of that is reachable, and the
  // author sees their `{{...}}` sitting in the stylesheet rather than a silent
  // half-broken rule. The seeded template has no field in its CSS and a test says so.
  //
  // The region scan is htmlparser2's raw-text rule, `</style` plus a terminator (see
  // endsRawText). It still errs where a literal `<style>` sits inside an attribute
  // value, which treats a field as CSS when it is not and leaves the token
  // unrendered. THAT direction is the harmless one; an earlier version of this
  // comment claimed it was the only one available, and it was not -- ending the
  // region at `</styles>` put a field back into live CSS. documentTemplateWarnings
  // exists so neither direction is silent.
  const css = cssRegions(template);
  const inCss = (at: number): boolean => css.some((r) => at >= r.from && at < r.to);
  for (const region of css) {
    if (!region.terminated) {
      warnings.push("a <style> element is never closed; every merge field after it is left unresolved");
    }
  }

  const root: Node[] = [];
  const open: { path: string; segments: string[]; inverted: boolean; body: Node[] }[] = [];
  const current = (): Node[] => open.length === 0 ? root : open[open.length - 1]!.body;

  let i = 0;
  let textFrom = 0;
  const flush = (to: number): void => {
    if (to > textFrom) current().push({ kind: "text", text: template.slice(textFrom, to) });
  };

  while (i < template.length) {
    const start = template.indexOf("{{", i);
    if (start === -1) break;
    const end = template.indexOf("}}", start + 2);
    if (end === -1) break;

    const tag = TAG.exec(template.slice(start + 2, end));
    if (tag === null || inCss(start)) {
      if (tag !== null) {
        warnings.push(`${template.slice(start, end + 2)} is inside a <style> block, where merge fields are not resolved`);
      }
      i = start + 2;
      continue;
    }
    const [, sigil, path] = tag as unknown as [string, string, string];

    flush(start);
    textFrom = end + 2;
    i = end + 2;

    if (sigil === "") {
      current().push({ kind: "field", segments: path.split(".") });
    } else if (sigil === "/") {
      if (open.length > 0 && open[open.length - 1]!.path === path) {
        const frame = open.pop()!;
        current().push({
          kind: "section", path: frame.path, segments: frame.segments,
          inverted: frame.inverted, body: frame.body,
        });
      } else {
        warnings.push(`{{/${path}}} closes nothing and is ignored`);
      }
    } else {
      // A BLOCK NESTED INSIDE ITSELF IS A SIZE MULTIPLIER AND NOTHING ELSE, and it is
      // refused rather than bounded.
      //
      // `{{#lines}}` inside `{{#lines}}` re-resolves `lines` from the ROOT (a line is
      // not a field of a line), so the body runs lines.length ** depth times. That was
      // documented as "defined, tested, and bounded by MERGE_MAX_STEPS" -- true about
      // termination and beside the point about cost. A 114-character template with one
      // level of nesting, against an ordinary 47-line quote using 11% of the input
      // gate's budget, merges to 130,346 bytes: UNDER the renderer's cap, so nothing
      // refused it, and 2,209 table rows that cost 9.65s and 353MB of peak RSS --
      // comfortably inside the 20s timeout. That is the "fast enough to survive the
      // timeout" shape the input cap exists to catch, arriving by a route the input
      // cap cannot see -- and re-measuring the cap showed 353MB is not even
      // exceptional: a plain 128KB table of minimal rows costs 345MB. (That figure
      // read 332MB until v1.0.1 re-ran the same measurement. The cap it was taken at
      // is gone too: the markup cap is 87,357 bytes now and costs 250MB, and the
      // worst document the renderer will accept -- a full markup budget of rows with
      // a logo at the pixel bound beside it -- is what the concurrency limit is
      // built on. See documents-render.ts.)
      //
      // There is one collection on a quote. Nesting it has no legitimate use, so the
      // mechanism goes rather than its symptom -- and with it goes the only way for
      // merged size to stop tracking input size, which is what lets a measurement of
      // the merged output be a sound bound on cost.
      if (open.some((frame) => frame.path === path)) {
        errors.push(
          `{{#${path}}} is nested inside another {{#${path}}}, which repeats its body once per `
          + "item for every level and is not allowed",
        );
      }
      open.push({ path, segments: path.split("."), inverted: sigil === "^", body: [] });
    }
  }
  flush(template.length);

  // Unwind whatever was never closed, innermost first: the block is forgotten and
  // its body joins its parent.
  //
  // A LOOP, NOT A SPREAD, and the spread was a `RangeError` waiting in the one case
  // this module promises is safe. `push(...frame.body)` passes every node as an
  // argument, and V8 stops at about 124,000 of them: `"{{#lines}}" + "{{a}}x"
  // repeated 62,153 times` -- a 364KB template with a missing closer -- threw
  // "Maximum call stack size exceeded" out of the parser, before any of the three
  // bounds could see it. S3 fixed exactly this failure class in `render` and left it
  // here.
  while (open.length > 0) {
    const frame = open.pop()!;
    warnings.push(`{{#${frame.path}}} is never closed; its contents render as ordinary text`);
    const parent = current();
    for (const node of frame.body) parent.push(node);
  }
  return { nodes: root, warnings, errors };
}

function isBag(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(bag: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bag, key);
}

/**
 * Resolve a dotted path against the scope stack, innermost first.
 *
 * Own properties only. `{{constructor}}` has to be a blank on a page, not
 * "function Object() { [native code] }", and `{{org.__proto__.x}}` has to be nothing
 * at all -- a template is user input that reaches this with no schema in between.
 *
 * `{{__proto__}}` never gets here: TAG requires a path to start with a letter, so it
 * is not a tag and prints as literal text. An earlier version of this comment claimed
 * it was blank, which was wrong about which mechanism handled it.
 */
function lookup(scopes: unknown[], segments: string[]): unknown {
  const head = segments[0]!;

  let value: unknown;
  let found = false;
  for (let s = scopes.length - 1; s >= 0; s -= 1) {
    const scope = scopes[s];
    if (isBag(scope) && hasOwn(scope, head)) {
      value = scope[head];
      found = true;
      break;
    }
  }
  if (!found) return undefined;

  for (let k = 1; k < segments.length; k += 1) {
    const key = segments[k]!;
    if (!isBag(value) || !hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Empty, which is what both block forms turn on.
 *
 * A string of nothing but whitespace counts as empty because that is what an emptied
 * textarea actually stores: `org.address_lines` and `document.notes` are free text,
 * and "\n \n" must not print a heading over nothing.
 */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return value.length === 0;
  if (isBag(value)) return Object.keys(value).length === 0;
  return false;
}

/** HTML-escape a substituted value. Includes `'`, since a template may use it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Sink { parts: string[]; length: number; steps: number }

/**
 * Spend one step of the work budget.
 *
 * COUNTING OUTPUT CHARACTERS DOES NOT BOUND THIS, AND A REVIEWER MEASURED THAT.
 * MERGE_MAX_OUTPUT_CHARS is only reached by a node that EMITS, so a nest of blocks
 * whose innermost body emits nothing -- an empty body, or one holding only an unknown
 * field, which appends "" -- ran `lines.length ** depth` times with `length` stuck at
 * zero. Twelve nested blocks over twenty line items is 4.1e15 iterations from a
 * 240-character template, and `render` is synchronous, so that is the whole Node
 * event loop rather than one request.
 *
 * So the budget is on WORK, not on output: one step per node visited and one per
 * block expansion, which is the only counter that both cases increment.
 */
function spend(sink: Sink): void {
  sink.steps += 1;
  if (sink.steps > MERGE_MAX_STEPS) {
    throw new TemplateError(
      `merging did more than ${String(MERGE_MAX_STEPS)} steps; ` +
        "a block is probably nested inside itself",
    );
  }
}

function emit(sink: Sink, text: string): void {
  sink.length += text.length;
  if (sink.length > MERGE_MAX_OUTPUT_CHARS) {
    throw new TemplateError(
      `merged document exceeded ${String(MERGE_MAX_OUTPUT_CHARS)} characters; ` +
        "a block is probably nested inside itself",
    );
  }
  sink.parts.push(text);
}

function render(nodes: Node[], scopes: unknown[], sink: Sink, depth: number): void {
  // `render` recurses once per nesting level, so without this a template nested a few
  // thousand deep is a RangeError out of the JavaScript stack rather than a
  // TemplateError -- measured, and a 156KB template gets there. Task 4's route is
  // written against "TemplateError is the only throw", so this is what makes that
  // sentence true. Nothing legitimate nests past a handful: the seeded template's
  // deepest point is one block inside a table.
  if (depth > MERGE_MAX_DEPTH) {
    throw new TemplateError(`blocks are nested more than ${String(MERGE_MAX_DEPTH)} deep`);
  }

  for (const node of nodes) {
    spend(sink);
    if (node.kind === "text") {
      emit(sink, node.text);
      continue;
    }
    if (node.kind === "field") {
      const value = lookup(scopes, node.segments);
      emit(sink, typeof value === "string" ? escapeHtml(value) : "");
      continue;
    }

    const value = lookup(scopes, node.segments);
    if (node.inverted) {
      if (isEmpty(value)) {
        spend(sink);
        render(node.body, scopes, sink, depth + 1);
      }
      continue;
    }
    if (isEmpty(value)) continue;
    if (Array.isArray(value)) {
      // One step per item BEFORE descending. WHAT TERMINATES THE MERGE IS THE NODE
      // COUNT, not this: an expansion that visits no nodes only happens at the
      // innermost level, so leaving this out costs a factor of the array length
      // rather than a bound. Mutation-checked and it fails NO test, exactly like the
      // rel=attachment strip -- what it buys is the constant: without it a quote at
      // the 130-line ceiling this was written against could do 1.3e8 iterations
      // inside the same one-million-step budget, which is seconds of blocked event
      // loop rather than a third of a second. DOCUMENT_MAX_LINES is 60 now, so the
      // real figure is smaller and the argument is unchanged; the 1.3e8 is left as
      // the number that was actually computed rather than replaced by a guess.
      for (const item of value) {
        spend(sink);
        render(node.body, [...scopes, item], sink, depth + 1);
      }
    } else if (isBag(value)) {
      spend(sink);
      render(node.body, [...scopes, value], sink, depth + 1);
    } else {
      spend(sink);
      render(node.body, scopes, sink, depth + 1);
    }
  }
}

/**
 * Merge fields into a template. Three forms:
 *
 *   `{{a.b}}`                  a value, HTML-escaped.
 *   `{{#a.b}}...{{/a.b}}`      the body, when the value is not empty -- once for a
 *                              value, once per item for a list (`lines`).
 *   `{{^a.b}}...{{/a.b}}`      the body, when the value IS empty.
 *
 * The block form is general rather than `lines`-only by coordinator ruling, and the
 * reason is the logo: with no conditional, `<img src="{{org.logoDataUri}}">` renders
 * `<img src="">` on every install that never uploaded one. Every optional field has
 * the same shape -- the valid-until date, the VAT number, the registration number,
 * the bank details -- and each of them currently prints its label over a blank. A
 * conditional fixes the class; a placeholder image would have fixed one instance.
 *
 * AN UNKNOWN PATH RENDERS AS EMPTY AND NEVER THROWS. A template is edited by hand and
 * a typo must be a blank on a page, not a failed render an hour before a quote is
 * due. The single exception is MERGE_MAX_OUTPUT_CHARS -- see its comment.
 */
export function mergeTemplate(template: string, context: MergeContext): string {
  const parsed = parse(template);
  // Refused before any expansion happens, so the cost of the refusal is the parse.
  if (parsed.errors.length > 0) throw new TemplateError(parsed.errors[0]!);
  const sink: Sink = { parts: [], length: 0, steps: 0 };
  render(parsed.nodes, [context], sink, 0);
  return sink.parts.join("");
}

/**
 * Everything this module does SILENTLY to a template, said out loud, for the editor
 * that Task 5 puts in Settings.
 *
 * Each of these is a template that renders without complaint and is not what its
 * author meant. `{{org.brandColour}}` in a stylesheet -- a reasonable thing to want
 * -- prints its own braces into the CSS; a `<style>` somebody never closed (including
 * one inside an HTML comment) swallows every merge field after it; an unclosed block
 * quietly stops being a block. None of them can throw, because a template being
 * edited is half-written by definition, and none of them should be invisible either.
 *
 * A narrow allowance for CSS fields is NOT implemented and is worth a decision rather
 * than a patch: substituting a value into CSS safely means CSS escaping and a value
 * shape to check it against (a colour, a length), which is a validated-field feature
 * rather than a merge feature. Until somebody wants it, this says why nothing
 * happened.
 */
export function documentTemplateWarnings(template: string): string[] {
  const parsed = parse(template);
  return [...parsed.errors, ...parsed.warnings];
}

/**
 * Why this template cannot be merged at all, or an empty list.
 *
 * Distinct from the warnings above, which are things the merge does silently and
 * which must never stop a save: a template being edited is half-written by
 * definition. These are the constructs `mergeTemplate` refuses outright, so a save
 * that stored one would produce a template every later quote fails on.
 */
export function documentTemplateErrors(template: string): string[] {
  return parse(template).errors;
}

/**
 * Merge, then sanitise. THE ORDER IS THE POINT OF THIS FUNCTION EXISTING.
 *
 * Substituted values are HTML-escaped, which is escaping for ONE context. A value
 * that lands inside a `style` ATTRIBUTE is in a different one, where `<` and `&` are
 * not what matters and `url(` is -- so escaping cannot help there, and only a
 * sanitiser looking at the FINISHED document can. Sanitising the template first and
 * merging into it afterwards would hand the renderer a `file://` URL that nothing had
 * ever looked at. That attribute is the ONE CSS context a value can still reach:
 * mergeTemplate does not substitute inside a `<style>` block at all (see parse).
 *
 * The other direction is covered too: because values are escaped on the way in, a
 * company name of `<table>` cannot restructure the page, and one containing
 * `<style>` cannot restyle it -- the sanitiser would have ALLOWED both, since both
 * are exactly what a template is permitted to contain.
 *
 * Sanitising a template again when it is saved is harmless (the profile is
 * idempotent, and there is a test for that), but it is not this control.
 */
export function prepareDocumentHtml(template: string, context: MergeContext): string {
  return sanitizeDocumentHtml(mergeTemplate(template, context));
}
