import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import type { AddressObject } from "mailparser";
import type { MailAddress } from "@conduit/shared";

// Structural/text tags plus the table family and img/a, per the spec's
// sanitizer profile. Deliberately NOT the sanitize-html defaults list --
// script/style/iframe/object/embed/form/input are excluded simply by never
// appearing here (sanitize-html's default disallowedTagsMode "discard"
// drops a disallowed tag but keeps its allowed text/children; script and
// style are additionally in the library's default nonTextTags list, so
// their inner text is discarded too, not just the tag).
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
];

const ATTACHMENT_INLINE_ROUTE = (attachmentId: string) => `/api/mail/attachments/${attachmentId}/inline`;

export interface SanitizeMailHtmlOptions {
  /** Content-ID (without angle brackets) -> mail_attachments.id. */
  cidMap?: Record<string, string>;
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
    if (typeof src === "string" && src.trim().toLowerCase().startsWith("cid:")) {
      const cid = src.trim().slice(4);
      const attachmentId = cidMap?.[cid];
      if (attachmentId !== undefined) {
        return { tagName, attribs: { ...attribs, src: ATTACHMENT_INLINE_ROUTE(attachmentId) } };
      }
      const { src: _unmappedCid, ...rest } = attribs;
      return { tagName, attribs: rest };
    }
    return { tagName, attribs };
  };
}

/**
 * Sanitize inbound/outbound mail HTML to one shared, restrictive profile
 * (spec's "Security" section: strip script/style/iframe/object/embed/
 * form/input and all `on*` handlers; keep structure, tables, links, images,
 * inline style). Remote http(s) images are left in the markup untouched --
 * this function runs at ingest time, and blocking remote image loads is a
 * render-time concern (the message-frame CSP + "Load remote images"
 * button), not something baked into the stored HTML.
 */
export function sanitizeMailHtml(html: string, options: SanitizeMailHtmlOptions = {}): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "rel", "target"],
      img: ["src", "alt"],
    },
    // Restricts img specifically to http/https/cid; everything else (a's
    // href, etc.) falls back to sanitize-html's own default allowedSchemes,
    // which already excludes javascript:/data:.
    allowedSchemesByTag: { img: ["http", "https", "cid"] },
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

const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd)\s*(?:\[\d+\])?\s*:\s*/i;

/**
 * Strip a leading chain of Re:/Fw:/Fwd: prefixes (case-insensitive, each
 * optionally followed by a bracketed count like "Re[2]:") and collapse
 * whitespace. Threads store this once, from the first message, per the
 * spec's mail_threads.subject column.
 */
export function normalizeSubject(subject: string): string {
  let result = subject;
  for (;;) {
    const stripped = result.replace(SUBJECT_PREFIX, "");
    if (stripped === result) break;
    result = stripped;
  }
  result = result.replace(/\s+/g, " ").trim();
  return result === "" ? "(no subject)" : result;
}

/** Collapse whitespace (including newlines) and take the first 160 characters. */
export function makeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export interface SyntheticMessageIdInput {
  from?: AddressObject | undefined;
  date?: Date | undefined;
  subject?: string | undefined;
  text?: string | undefined;
}

/**
 * A stable id for messages that arrive with no RFC 5322 Message-ID (some
 * senders omit it). Hashes from_addr + ISO sent_at + subject + the first 1k
 * chars of body_text, joined with a separator so e.g. a short from_addr
 * concatenated with a long sent_at cannot collide with a different
 * from_addr/sent_at split at the same total length. Pure function of the
 * parsed fields, so re-ingesting the same raw message (a UIDVALIDITY
 * refetch) reproduces the same id and UNIQUE (account_id, message_id)
 * converges instead of duplicating.
 */
export function syntheticMessageId(parsed: SyntheticMessageIdInput): string {
  const fromAddr = (parsed.from?.value[0]?.address ?? "").toLowerCase();
  const sentAt = (parsed.date ?? new Date(0)).toISOString();
  const subject = parsed.subject ?? "";
  const bodyText = (parsed.text ?? "").slice(0, 1000);
  const material = [fromAddr, sentAt, subject, bodyText].join("::");
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export interface ExtractedAddresses {
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
}

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

/**
 * Hand-rolled plain-text alternative for outgoing HTML mail (mail-send.ts's
 * text/plain part) -- not a new dependency, just tag stripping plus the
 * handful of entities compose-generated HTML (TipTap output) actually
 * contains. Not a general HTML-to-text converter for arbitrary inbound mail.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  // &amp; decodes last so an entity-encoded ampersand in the source (e.g.
  // "&amp;lt;") cannot get unescaped a second time into a real "<".
  const withEntities = withBreaks
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
  return withEntities
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
