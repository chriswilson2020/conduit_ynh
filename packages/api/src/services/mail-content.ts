import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import type { AddressObject } from "mailparser";
import type { MailAddress } from "@conduit/shared";

// This is sanitize-html's own default allowedTags list plus img and a
// handful of legacy presentational tags real HTML-email templates still use
// (center, font, big, strike, tt). script/style/iframe/object/embed/form/
// input are excluded simply because they were never in that default list --
// spelled out explicitly here, rather than derived from
// sanitizeHtml.defaults.allowedTags at runtime, so a future library upgrade
// can't silently change this sanitizer profile out from under us.
// sanitize-html's default disallowedTagsMode "discard" drops a disallowed
// tag but keeps its allowed text/children; script and style are
// additionally in the library's default nonTextTags list, so their inner
// text is discarded too, not just the tag.
const ALLOWED_TAGS = [
  "address", "article", "aside", "footer", "header",
  "h1", "h2", "h3", "h4", "h5", "h6", "hgroup",
  "main", "nav", "section",
  "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
  "hr", "li", "menu", "ol", "p", "pre", "ul",
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn",
  "em", "i", "kbd", "mark", "q",
  "rb", "rp", "rt", "rtc", "ruby",
  "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
  "caption", "col", "colgroup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "img",
  "center", "font", "big", "strike", "tt",
];

const TABLE_FAMILY_TAGS = ["table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th"];

// Presentational HTML-email attributes: inert from a security standpoint
// (no URL, no script sink) but load-bearing for layout -- colspan/rowspan
// especially, since dropping them does not just look worse, it changes the
// table's actual structure. Applied uniformly across the whole table
// family rather than tag-by-tag (e.g. cellpadding technically only makes
// sense on <table>) for simplicity: an attribute that is meaningless on a
// given tag is just inert dead weight there, not a risk.
const TABLE_ATTRIBUTES = [
  "colspan", "rowspan", "align", "valign", "width", "height",
  "bgcolor", "cellpadding", "cellspacing", "border",
];

// Signatures and templates render directly in the main document (no
// iframe/CSP isolation the way inbound conversation bodies get -- see the
// spec's frontend section), and templates are shared across every user, so
// unfiltered inline CSS on that path is url()-based tracking/exfiltration
// beacons and position:fixed overlays hijacking another user's composer,
// not just a cosmetic risk. One shared value regex, reused for every
// allowed property below: it must exclude "(" -- and therefore any
// url(...)/expression(...)/rgb(...)/etc. call -- since anything wrapped in
// parens is exactly the shape a CSS-based attack needs. Collateral damage:
// rgb()/rgba()/hsl() colour values are rejected too, which is an acceptable
// trade -- hex and named colours cover the realistic signature/template
// case, and failing closed here is the point.
const SAFE_STYLE_VALUE: RegExp[] = [/^[a-zA-Z0-9#%.,!\s-]+$/];

const ALLOWED_STYLE_PROPERTIES = [
  "color", "background-color",
  "font-family", "font-size", "font-weight", "font-style",
  "text-align", "text-decoration",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-collapse", "border-spacing", "border-radius",
  "width", "height", "line-height", "vertical-align",
];

// position (and anything else not listed above -- e.g. the "background"
// shorthand, as opposed to "background-color") is simply absent from this
// map: sanitize-html drops any declaration for a property it has no entry
// for, so position:fixed and background:url(...) are both rejected by
// omission, not by a value check that has to get every case right.
const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": Object.fromEntries(ALLOWED_STYLE_PROPERTIES.map((prop) => [prop, SAFE_STYLE_VALUE])),
};

// cid: references are rewritten to this placeholder scheme at ingest time,
// never to an absolute route -- baking `/api/mail/attachments/<id>/inline`
// (or worse, a full origin) into stored body_html would break the moment
// this instance's basePath changes (`yunohost app change_url`).
// resolveAttachmentUrls (below) swaps the placeholder for the real route at
// SERVE time instead, so stored HTML never needs touching again.
const ATTACHMENT_PLACEHOLDER_SCHEME = "mailattachment";

function attachmentPlaceholder(attachmentId: string): string {
  return `${ATTACHMENT_PLACEHOLDER_SCHEME}:${attachmentId}`;
}

const ATTACHMENT_PLACEHOLDER_RE = /mailattachment:([A-Za-z0-9._~-]+)/g;

/**
 * Swap stored `mailattachment:` placeholders (see sanitizeMailHtml's cid
 * rewrite) for the authenticated download route, at serve time. `apiBase`
 * follows config.basePath's own convention: "/" for a root deployment
 * (contributes no prefix), or a non-root path like "/conduit" (no trailing
 * slash) -- callers can pass config.basePath straight through.
 *
 * A dumb string transform on purpose (no HTML parsing) -- so it must only
 * ever run on HTML that already passed through sanitizeMailHtml; the
 * placeholder is otherwise just inert text sanitize-html would strip like
 * any other unrecognised scheme.
 *
 * Ordering invariant: sanitizeMailHtml runs exactly once, at ingest, and
 * its output (placeholders still in place) is what gets stored in
 * body_html. resolveAttachmentUrls runs on every read and its output is
 * NEVER written back to the database -- that is what makes the stored HTML
 * portable across a basePath change instead of needing a migration.
 */
export function resolveAttachmentUrls(html: string, apiBase: string): string {
  const prefix = apiBase === "/" ? "" : apiBase;
  return html.replace(
    ATTACHMENT_PLACEHOLDER_RE,
    (_match, id: string) => `${prefix}/api/mail/attachments/${encodeURIComponent(id)}/inline`,
  );
}

export interface SanitizeMailHtmlOptions {
  /** Content-ID (without angle brackets) -> mail_attachments.id. */
  cidMap?: Record<string, string>;
}

/**
 * Parse an <img> src that looks like a cid: reference into the bare
 * Content-ID it names, or undefined if `src` is not a cid: reference at
 * all. Tolerates the two common variations senders/tools produce: the
 * Content-ID header's own <angle brackets> left on by mistake, and
 * percent-encoding (e.g. a literal "@" written as %40).
 */
function extractCid(src: string): string | undefined {
  const trimmed = src.trim();
  if (!/^cid:/i.test(trimmed)) return undefined;
  let cid = trimmed.slice(4).trim();
  if (cid.length >= 2 && cid.startsWith("<") && cid.endsWith(">")) {
    cid = cid.slice(1, -1);
  }
  try {
    cid = decodeURIComponent(cid);
  } catch {
    // Not actually percent-encoded (e.g. a lone "%"); use it as-is.
  }
  return cid;
}

/**
 * Rewrite (or drop) an <img>'s cid: src before sanitize-html's own
 * allowlist/scheme filtering sees it. Returning without a `src` key marks the
 * tag for removal by the exclusiveFilter below -- it runs after this and
 * after the standard attribute filtering, seeing the final attribs either
 * way, so the two stages agree on what "no usable src" means.
 */
function transformImg(cidMap: Record<string, string> | undefined) {
  return (tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
    const src = attribs.src;
    if (typeof src === "string") {
      const cid = extractCid(src);
      if (cid !== undefined) {
        const attachmentId = cidMap?.[cid];
        if (attachmentId !== undefined) {
          return { tagName, attribs: { ...attribs, src: attachmentPlaceholder(attachmentId) } };
        }
        const { src: _unmappedCid, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
    }
    return { tagName, attribs };
  };
}

/**
 * Sanitize inbound/outbound mail HTML to one shared, restrictive profile
 * (spec's "Security" section: strip script/style/iframe/object/embed/
 * form/input and all `on*` handlers; keep structure, tables, links, images,
 * a bounded inline-style property allowlist). Remote http(s) images are
 * left in the markup untouched -- this function runs at ingest time, and
 * blocking remote image loads is a render-time concern (the message-frame
 * CSP + "Load remote images" button), not something baked into the stored
 * HTML. One profile serves both inbound conversation bodies (iframe/CSP
 * isolated at render time) and signatures/templates (rendered directly in
 * the main document, no isolation) -- see ALLOWED_STYLES above for why the
 * style allowlist is deliberately conservative rather than trusting the
 * render context to catch what this misses.
 */
export function sanitizeMailHtml(html: string, options: SanitizeMailHtmlOptions = {}): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "rel", "target"],
      img: ["src", "alt", "width", "height", "title"],
      font: ["color", "face", "size"],
      ...Object.fromEntries(TABLE_FAMILY_TAGS.map((tag) => [tag, TABLE_ATTRIBUTES])),
    },
    allowedStyles: ALLOWED_STYLES,
    // Restricts img specifically to http/https/the attachment placeholder
    // scheme; everything else (a's href, etc.) falls back to
    // sanitize-html's own default allowedSchemes, which already excludes
    // javascript:/data:. This only constrains src values that HAVE a
    // scheme prefix at all -- a relative ("/x.png") or protocol-relative
    // ("//host/x.png") src has no scheme to check, so it bypasses this
    // list entirely, by design of sanitize-html's naughtyHref. That is
    // intentional here (both are ordinary in real mail), not a gap; see
    // the img-src edge-case tests below.
    allowedSchemesByTag: { img: ["http", "https", ATTACHMENT_PLACEHOLDER_SCHEME] },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }, true),
      img: transformImg(options.cidMap),
    },
    // Runs after attribute filtering, so frame.attribs.src reflects the
    // final, already-filtered value: absent for an unmapped/unresolvable
    // cid (transformImg above) or a scheme sanitize-html itself rejected
    // (e.g. data:/javascript:, which allowedSchemesByTag.img does not list).
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

// De-nested to avoid catastrophic backtracking: the previous shape was
// `\s* (?:\[\d+\])? \s* :` -- when the bracket group fails to match (the
// common case, no "[n]" present), the two `\s*` runs end up effectively
// adjacent, straddling the same span of whitespace with nothing mandatory
// between them. That is the classic `a*a*b`-against-a-string-with-no-b
// shape that makes backtracking quadratic when the overall match ultimately
// fails: a parsed "Re" + 60k trailing spaces (no colon) measured 3.5s of
// event-loop stall against the old pattern. This version has at most one
// `\s*` contending for any given span, so there is nothing left to
// backtrack between; the trade is that "Re [2]:" (space before the
// bracket) is no longer recognised -- untested, unrequested, and a far
// smaller cost than a ReDoS.
const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd)(?:\[\d+\])?\s*:\s*/i;

// Hard length bound, independent of the regex fix above: normalizeSubject
// is fed attacker-controlled data (an inbound Subject: header), so it must
// not rely solely on the regex shape to stay fast against arbitrary input.
// 1000 chars is far beyond any real Re:/Fwd: chain or any subject line
// worth preserving in a thread title.
const MAX_SUBJECT_LENGTH = 1000;

/**
 * Strip a leading chain of Re:/Fw:/Fwd: prefixes (case-insensitive, each
 * optionally followed by a bracketed count like "Re[2]:", with no space
 * between the word and the bracket) and collapse whitespace. Threads store
 * this once, from the first message, per the spec's mail_threads.subject
 * column. An empty result (after stripping and collapsing) is returned as
 * "" -- matching the subject column's own '' default -- not a placeholder
 * string: "(no subject)" is a presentation concern for the web layer to
 * render, not something to bake into stored/hashed data.
 */
export function normalizeSubject(subject: string): string {
  let result = subject.slice(0, MAX_SUBJECT_LENGTH);
  for (;;) {
    const stripped = result.replace(SUBJECT_PREFIX, "");
    if (stripped === result) break;
    result = stripped;
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Collapse whitespace (including newlines) and take the first 160 Unicode
 * code points -- Array.from splits a string into code points, not UTF-16
 * code units, so a character outside the BMP (most emoji) landing right at
 * the boundary is kept or dropped whole, never split into a lone (invalid)
 * surrogate. snippet is persisted (mail_messages.snippet), so a broken
 * surrogate here would be a permanently corrupted row, not just a one-off
 * render glitch.
 */
export function makeSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, 160).join("");
}

export interface SyntheticMessageIdInput {
  from?: AddressObject | undefined;
  date?: Date | undefined;
  subject?: string | undefined;
  text?: string | undefined;
}

// Length-prefixed rather than separator-joined: a fixed separator (even an
// unusual one like "::") can still collide if it happens to appear inside a
// field's own content -- e.g. subject "A::B" + body "C" and subject "A" +
// body "B::C" both concatenate to "A::B::C" under a plain "::" join.
// Prefixing each field with its own length (before an unambiguous ":"
// delimiter) closes that regardless of what the field contains: the
// boundary is determined by counting characters, never by scanning for a
// marker the input could itself forge.
function lengthPrefixed(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * A stable id for messages that arrive with no RFC 5322 Message-ID (some
 * senders omit it). Hashes from_addr + ISO sent_at + subject + the first 1k
 * chars of body_text, each length-prefixed (see lengthPrefixed) so the
 * fields can never be re-split a different way and collide. Pure function
 * of the parsed fields, so re-ingesting the same raw message (a
 * UIDVALIDITY refetch) reproduces the same id and UNIQUE (account_id,
 * message_id) converges instead of duplicating.
 */
export function syntheticMessageId(parsed: SyntheticMessageIdInput): string {
  const fromAddr = (parsed.from?.value[0]?.address ?? "").toLowerCase();
  const sentAt = (parsed.date ?? new Date(0)).toISOString();
  const subject = parsed.subject ?? "";
  const bodyText = (parsed.text ?? "").slice(0, 1000);
  const material = [fromAddr, sentAt, subject, bodyText].map(lengthPrefixed).join("");
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export interface ExtractedAddresses {
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
}

// Recurses into entry.group for RFC 5322 group syntax (a mailing-list-style
// "Team: bob@x, carol@y;" Cc, or the empty "undisclosed-recipients:;"
// convention). The recursion depth was probed empirically rather than
// assumed: mailparser never produces a group whose own members themselves
// carry a further .group -- feeding it deliberately-nested input like
// "Outer: Inner: bob@x;;" does not create one (the malformed inner group is
// absorbed, not preserved as a nested structure), so this bottoms out at
// depth 2 in practice. Written recursively anyway rather than hard-coded to
// two levels, since that costs nothing and does not depend on the probe
// result staying true across a mailparser upgrade.
function flattenAddressObject(input: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (input === undefined) return [];
  const objects = Array.isArray(input) ? input : [input];
  const out: MailAddress[] = [];
  const visit = (entries: AddressObject["value"]): void => {
    for (const entry of entries) {
      if (entry.group !== undefined && entry.group.length > 0) {
        visit(entry.group);
      } else if (entry.address !== undefined && entry.address.length > 0) {
        out.push({ address: entry.address.toLowerCase(), name: entry.name.length > 0 ? entry.name : null });
      }
    }
  };
  for (const obj of objects) visit(obj.value);
  return out;
}

export interface ExtractAddressesInput {
  from?: AddressObject | undefined;
  to?: AddressObject | AddressObject[] | undefined;
  cc?: AddressObject | AddressObject[] | undefined;
  bcc?: AddressObject | AddressObject[] | undefined;
}

/** mailparser's AddressObject(s) -> {address (lowercased), name} arrays for from/to/cc/bcc. */
export function extractAddresses(parsed: ExtractAddressesInput): ExtractedAddresses {
  return {
    from: flattenAddressObject(parsed.from),
    to: flattenAddressObject(parsed.to),
    cc: flattenAddressObject(parsed.cc),
    bcc: flattenAddressObject(parsed.bcc),
  };
}

/** Pull `href="..."` (or '...') out of an <a> tag's raw attribute text, order-independent. */
function extractHref(openTagAttrs: string): string | undefined {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openTagAttrs);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

const A_TAG_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

// Built via String.fromCharCode (not literal characters) so this source
// file stays pure ASCII. SOH/STX (0x01/0x02) stand in for the "<" and ">"
// that will wrap the href once it is safe to re-introduce them -- inserting
// literal angle brackets here would make the href indistinguishable from a
// real tag to the generic `<[^>]*>` strip below, which would eat it right
// back out. Restored to real "<"/">" only after that strip has already run.
const LINK_MARK_OPEN = String.fromCharCode(1);
const LINK_MARK_CLOSE = String.fromCharCode(2);

/**
 * Hand-rolled plain-text alternative for outgoing HTML mail (mail-send.ts's
 * text/plain part) -- not a new dependency, just tag stripping plus the
 * handful of entities compose-generated HTML (TipTap output) actually
 * contains. Ordering invariant: this does no script/style/tag-safety
 * filtering of its own (no on* stripping, no scheme checks), so callers
 * must only ever pass it HTML that already went through sanitizeMailHtml
 * (or is otherwise trusted compose-editor output) -- never raw untrusted
 * HTML straight off the wire.
 */
export function htmlToText(html: string): string {
  // Links lose their visible markup like everything else below, so the
  // destination has to be captured and re-inserted as text before that
  // happens, or a plain-text reader has no way to reach it.
  const withLinks = html.replace(A_TAG_RE, (_match: string, attrs: string, inner: string) => {
    const href = extractHref(attrs);
    return href !== undefined ? `${inner} ${LINK_MARK_OPEN}${href}${LINK_MARK_CLOSE}` : inner;
  });
  const withBreaks = withLinks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    // Cells within the same row are separated by a space, not a line
    // break -- only the row (tr, above) starts a new line.
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<[^>]*>/g, "");
  // Numeric entities decode before &amp;, and &amp; decodes last of all --
  // otherwise a double-encoded source (e.g. "&amp;#39;" or "&amp;lt;")
  // would get unescaped a second time into a character never meant to
  // appear literally.
  const withEntities = withBreaks
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m: string, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, "&");
  return withEntities
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split(LINK_MARK_OPEN).join("<")
    .split(LINK_MARK_CLOSE).join(">");
}
