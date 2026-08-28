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
 */
const URL_ATTRIBUTES = new Set([
  "src", "href", "srcset", "imagesrcset", "background", "poster", "data", "action",
  "formaction", "cite", "longdesc", "usemap", "codebase", "classid", "archive",
  "profile", "manifest", "itemid", "ping", "dynsrc", "lowsrc", "xlink:href",
]);

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
 * Whitespace is trimmed only at the ENDS. A value like "data\n:text/html,x" is
 * refused rather than repaired, because deciding what a consumer would make of an
 * interior control character is exactly the guess this function must not make.
 */
function isPermittedUrl(value: string): boolean {
  const trimmed = value.replace(/^[\x00-\x20]+/, "").replace(/[\x00-\x20]+$/, "");
  if (trimmed === "") return false;
  if (trimmed.startsWith("#")) return true;
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
    // An unescaped newline ends a bad string, the way a CSS tokenizer ends one.
    if (c === "\n") break;
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
          if (URL_ATTRIBUTES.has(lower) && !isPermittedUrl(value)) continue;
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
    if (/<\/style/i.test(safe)) return "";
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
 * The merged output cap, and the one thing in this module that throws.
 *
 * Blocks nest, so expansion is not linear in the template: seven `{{#lines}}` blocks
 * inside each other over eight line items is two million rows, built in the API
 * process long before renderPdf's 128KB input cap could refuse any of it. The cap is
 * checked as the output is appended, so a runaway template stops at half a megabyte
 * instead of at whatever the heap allows.
 *
 * It is four times renderPdf's input cap on purpose: anything between the two is a
 * document that was never going to render, and hitting this is a template that is
 * broken rather than a field that is blank. Blanks never throw -- that rule is what
 * the unknown-field behaviour is for -- but a template that cannot terminate is not
 * a blank.
 */
export const MERGE_MAX_OUTPUT_CHARS = 512 * 1024;

type Node =
  | { kind: "text"; text: string }
  | { kind: "field"; path: string }
  | { kind: "section"; path: string; inverted: boolean; body: Node[] };

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
 *   not a tag at all   left exactly as it was found, so `{{ oops }}` shows up on the
 *                      page where the author can see it.
 *
 * It is also linear: a lazy quantifier plus a backreference over a 128KB template is
 * a rescan from every `{{` in the file.
 */
function parse(template: string): Node[] {
  const root: Node[] = [];
  const open: { path: string; inverted: boolean; body: Node[] }[] = [];
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
    if (tag === null) { i = start + 2; continue; }
    const [, sigil, path] = tag as unknown as [string, string, string];

    flush(start);
    textFrom = end + 2;
    i = end + 2;

    if (sigil === "") {
      current().push({ kind: "field", path });
    } else if (sigil === "/") {
      if (open.length > 0 && open[open.length - 1]!.path === path) {
        const frame = open.pop()!;
        current().push({ kind: "section", path: frame.path, inverted: frame.inverted, body: frame.body });
      }
    } else {
      open.push({ path, inverted: sigil === "^", body: [] });
    }
  }
  flush(template.length);

  // Unwind whatever was never closed, innermost first: the block is forgotten and
  // its body joins its parent.
  while (open.length > 0) {
    const frame = open.pop()!;
    current().push(...frame.body);
  }
  return root;
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
 * "function Object() { [native code] }", and `{{__proto__.x}}` has to be nothing at
 * all -- a template is user input that reaches this with no schema in between.
 */
function lookup(scopes: unknown[], path: string): unknown {
  const [head, ...rest] = path.split(".") as [string, ...string[]];

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

  for (const key of rest) {
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

interface Sink { parts: string[]; length: number }

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

function render(nodes: Node[], scopes: unknown[], sink: Sink): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      emit(sink, node.text);
      continue;
    }
    if (node.kind === "field") {
      const value = lookup(scopes, node.path);
      emit(sink, typeof value === "string" ? escapeHtml(value) : "");
      continue;
    }

    const value = lookup(scopes, node.path);
    if (node.inverted) {
      if (isEmpty(value)) render(node.body, scopes, sink);
      continue;
    }
    if (isEmpty(value)) continue;
    if (Array.isArray(value)) {
      for (const item of value) render(node.body, [...scopes, item], sink);
    } else if (isBag(value)) {
      render(node.body, [...scopes, value], sink);
    } else {
      render(node.body, scopes, sink);
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
  const sink: Sink = { parts: [], length: 0 };
  render(parse(template), [context], sink);
  return sink.parts.join("");
}

/**
 * Merge, then sanitise. THE ORDER IS THE POINT OF THIS FUNCTION EXISTING.
 *
 * Substituted values are HTML-escaped, which is escaping for ONE context. A value
 * that lands inside a `style` attribute or a `<style>` block is in a different one,
 * where `<` and `&` are not what matters and `url(` is -- so escaping cannot help
 * there, and only a sanitiser looking at the FINISHED document can. Sanitising the
 * template first and merging into it afterwards would hand the renderer a `file://`
 * URL that nothing had ever looked at.
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
