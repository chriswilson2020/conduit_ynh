import type { MailAddress, MailThreadListItem } from "@conduit/shared";
import { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";
import { ApiError } from "../../api";

/**
 * The mail feature's pure parts, kept out of the components so they can be
 * unit-tested without a DOM: recipient token parsing, template placeholder
 * substitution, the mapping from the shared mail error prefixes to something
 * a user can act on, the inbox's page accumulation, and the reply/forward and
 * message-frame rules the conversation view is built from.
 *
 * Named `mail-lib`, not `composer-lib` (its Task 9 name): the composer, the
 * settings page, the inbox and the conversation all import from here, so it
 * is the feature's lib rather than one component's.
 *
 * Nothing here touches the network, React, or TipTap.
 */

/**
 * A compose recipient. Structurally the same {address, name} shape
 * mailAddressSchema/composeAddressSchema describe in @conduit/shared -- named
 * separately here because these are tokens a user is still typing, which may
 * not yet be valid addresses at all.
 */
export interface ComposerRecipient {
  address: string;
  name?: string | null;
}

// Both strings are the ones the brief pins for the two classified failures;
// escaped rather than literal because this repo's sources are ASCII-only.
export const MAIL_AUTH_MESSAGE = "Authentication failed \u2014 check the username/password";
export const MAIL_CONNECTION_MESSAGE = "Server unreachable \u2014 check host/port/security";

/**
 * Turns a raw mail error string into display text.
 *
 * The two prefixes are a documented, stable contract on the error MESSAGE
 * (see MAIL_AUTH_ERROR_PREFIX's doc comment in @conduit/shared): the adapter
 * puts one at the front of anything it can classify, and the text travels
 * verbatim into `mail_accounts.last_error`, the test-connection result and
 * the send path's 502. Anything unclassified carries NO prefix -- that is an
 * ordinary case, not an error, so it is shown as-is rather than replaced by a
 * guess.
 */
export function friendlyMailError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(MAIL_AUTH_ERROR_PREFIX)) return MAIL_AUTH_MESSAGE;
  if (trimmed.startsWith(MAIL_CONNECTION_ERROR_PREFIX)) return MAIL_CONNECTION_MESSAGE;
  return trimmed;
}

// The classified prefix, wherever it sits in a longer sentence: at the start,
// or after the ": " of a wrapping message. Anchored on a boundary so an
// "oauth:" or "reconnection:" substring cannot masquerade as one.
const EMBEDDED_PREFIX = new RegExp(
  `(?:^|[\\s:])(${MAIL_AUTH_ERROR_PREFIX}|${MAIL_CONNECTION_ERROR_PREFIX})`,
);

/**
 * Display text for a failed send. The API's 502 body carries both a `message`
 * ("sending the message failed: <reason>") and a `reason` (the adapter's
 * normalized text, prefix and all), but errorResponseSchema -- the shape
 * api.ts parses every error through -- keeps only `error` and `message`, so
 * the classification has to be recovered from the message text. That is
 * exactly what the shared prefixes are for: they are documented as living on
 * the message, not as a separate machine field.
 */
export function sendFailureMessage(message: string): string {
  const match = EMBEDDED_PREFIX.exec(message);
  if (match === null) return message.trim();
  return match[1] === MAIL_AUTH_ERROR_PREFIX ? MAIL_AUTH_MESSAGE : MAIL_CONNECTION_MESSAGE;
}

/**
 * A deliberately loose address check, for the composer's own token input:
 * something@somewhere.tld with no whitespace or address-list punctuation in
 * it. The authority on what is actually sendable is the server's
 * composeAddressSchema (z.email()); this exists only so the composer can
 * refuse an obviously-mistyped token at the point of typing rather than
 * letting a 400 come back from the send.
 */
export function isEmailLike(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}

/**
 * Parses one recipient fragment: either a bare address, or the
 * `Display Name <address>` form (quoted or not). Returns null when there is
 * no address-looking part at all, so the caller can report it rather than
 * silently dropping what the user typed.
 */
export function parseAddressToken(fragment: string): ComposerRecipient | null {
  const trimmed = fragment.trim();
  if (trimmed === "") return null;
  const angled = /^(.*)<([^<>]+)>$/.exec(trimmed);
  if (angled !== null) {
    const address = (angled[2] ?? "").trim();
    if (!isEmailLike(address)) return null;
    const name = (angled[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
    return name === "" ? { address } : { address, name };
  }
  return isEmailLike(trimmed) ? { address: trimmed } : null;
}

export interface ParsedRecipientInput {
  /** Fragments that parsed into a usable address. */
  tokens: ComposerRecipient[];
  /** Fragments that were terminated by a separator but are not addresses. */
  invalid: string[];
  /**
   * The still-being-typed tail: whatever followed the last separator. Empty
   * when the raw input ended on a separator, which is what makes "type a
   * comma and the token commits" work without special-casing it at the call
   * site.
   */
  remainder: string;
}

/**
 * Splits raw token-input text on commas, semicolons and newlines -- NOT on
 * spaces, which are ordinary inside a display name -- and parses every
 * fragment the user has finished (i.e. every one but the tail).
 */
export function parseRecipientInput(raw: string): ParsedRecipientInput {
  const parts = raw.split(/[,;\n]/);
  const remainder = parts.pop() ?? "";
  const tokens: ComposerRecipient[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (part.trim() === "") continue;
    const parsed = parseAddressToken(part);
    if (parsed === null) invalid.push(part.trim());
    else tokens.push(parsed);
  }
  return { tokens, invalid, remainder };
}

export interface ResolvedRecipients {
  /** Committed chips plus whatever was still being typed, de-duplicated. */
  recipients: ComposerRecipient[];
  /** Fragments of the pending draft that are not addresses. */
  invalid: string[];
}

/**
 * The submission-time view of one recipient line: the chips the user has
 * already committed PLUS whatever is still sitting in the input.
 *
 * This exists because of a real bug it fixes. A recipient field commits its
 * draft on blur, and a click on Send fires mousedown -> blur -> click: if the
 * commit is deferred at all (it used to run behind a timer, so a click on a
 * suggestion would not be swallowed by the dropdown closing), the submit
 * handler reads the committed array BEFORE the draft lands, and a message
 * addressed to one chipped and one typed recipient goes out to the first one
 * only, silently. The submit path therefore never trusts the committed array
 * on its own -- it resolves it against the live draft here, and a draft that
 * is not an address surfaces as a validation error rather than disappearing.
 *
 * The draft is parsed by appending the separator the user did not type, so
 * this and "type a comma" cannot diverge in what they accept.
 */
export function resolveRecipients(
  committed: readonly ComposerRecipient[], draft: string,
): ResolvedRecipients {
  if (draft.trim() === "") return { recipients: dedupeRecipients(committed), invalid: [] };
  const parsed = parseRecipientInput(`${draft},`);
  return {
    recipients: dedupeRecipients([...committed, ...parsed.tokens]),
    invalid: parsed.invalid,
  };
}

/** Case-insensitive address de-duplication, preserving first-seen order and
 * the name that came with the first sighting. */
export function dedupeRecipients(recipients: readonly ComposerRecipient[]): ComposerRecipient[] {
  const seen = new Set<string>();
  const out: ComposerRecipient[] = [];
  for (const recipient of recipients) {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(recipient);
  }
  return out;
}

/**
 * What a `{{...}}` placeholder in a template can resolve to. Supplied by
 * whoever opens the composer (the record page knows its own contact/company)
 * plus the current user, rather than fetched here -- see the composer's seed.
 */
export interface TemplateContext {
  contactName?: string | null;
  companyName?: string | null;
  userName?: string | null;
}

const PLACEHOLDER = /\{\{\s*(contact|company|user)\.name\s*\}\}/g;

/** Text-node escaping for a value being spliced into markup. Ampersand
 * first, or it would double-escape the entities the others produce. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function substitute(input: string, context: TemplateContext, escape: (value: string) => string): string {
  return input.replace(PLACEHOLDER, (match, field: string) => {
    const value = field === "contact" ? context.contactName
      : field === "company" ? context.companyName
        : context.userName;
    return value != null && value.trim() !== "" ? escape(value) : match;
  });
}

/**
 * Substitutes `{{contact.name}}`, `{{company.name}}` and `{{user.name}}` from
 * the given context into PLAIN TEXT (the subject line). A placeholder with
 * nothing to fill it is LEFT LITERAL (spec: "unresolved placeholders are left
 * visible for the user to fill"), never replaced with an empty string -- an
 * email that silently reads "Hi ," is worse than one that visibly still needs
 * a name.
 */
export function substitutePlaceholders(input: string, context: TemplateContext): string {
  return substitute(input, context, (value) => value);
}

/**
 * The same substitution into an HTML template BODY, with every substituted
 * value escaped as a text node.
 *
 * The values come from CRM records -- a contact called `Ben <ben@corp>` or a
 * company called `Smith & Sons` is ordinary data, not an attack -- but
 * splicing either into markup unescaped is still wrong: `<` opens a tag, so
 * the name gets swallowed by the server's sanitizer on the way in and the
 * user sees their template silently truncated. Escaping keeps the name
 * visible and, incidentally, means a hostile record name cannot inject markup
 * into a message body either.
 */
export function substitutePlaceholdersHtml(input: string, context: TemplateContext): string {
  return substitute(input, context, escapeHtmlText);
}

/**
 * The subject a template application should leave behind. A template's
 * subject only takes effect when composing FRESH and the field is still
 * empty: on a reply the subject belongs to the thread, and a subject the user
 * already typed is theirs, not the template's.
 */
export function templateSubject(
  currentSubject: string,
  templateSubjectValue: string,
  options: { isReply: boolean; context: TemplateContext },
): string {
  if (options.isReply) return currentSubject;
  if (currentSubject.trim() !== "") return currentSubject;
  return substitutePlaceholders(templateSubjectValue, options.context);
}

/**
 * Whether an editor's HTML holds nothing a reader would see. An empty TipTap
 * document serializes as "<p></p>", which is a perfectly non-empty STRING --
 * so `bodyHtml !== ""` is not a usable "did the user write anything" test,
 * and sendMailInputSchema's own `.min(1)` would happily accept it.
 *
 * Tags are stripped rather than parsed: this decides whether to enable a Send
 * button, and the body it inspects came out of this app's own editor, not off
 * the wire.
 */
export function htmlIsBlank(html: string): boolean {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim() === "";
}

/**
 * The signature, wrapped so it lands as its own block rather than running on
 * from the last line of the body. An empty paragraph is the separator because
 * that is what the editor's own schema produces for a blank line; a `<div>`
 * or `<hr>` wrapper would be rewritten (or dropped) by TipTap's document
 * schema on the way in.
 */
export function signatureBlock(signatureHtml: string): string {
  return `<p></p>${signatureHtml}`;
}

/** The four record links a composed thread can carry (sendMailInputSchema's
 * own `links` shape). */
export interface ComposerLinks {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

export type AttachmentTarget = ComposerLinks;

/**
 * Which record an attachment upload is filed against. POST /api/files
 * requires EXACTLY ONE of companyId/contactId/dealId/projectId, so a compose
 * with no record link at all has nowhere to put an upload -- null here is
 * what disables the attach control instead of letting the upload 400.
 *
 * Most specific link first (deal, project, contact, company): an attachment
 * on a deal thread belongs on the deal, not on the company behind it.
 */
export function attachmentTarget(links: ComposerLinks | undefined): AttachmentTarget | null {
  if (links === undefined) return null;
  if (links.dealId !== undefined) return { dealId: links.dealId };
  if (links.projectId !== undefined) return { projectId: links.projectId };
  if (links.contactId !== undefined) return { contactId: links.contactId };
  if (links.companyId !== undefined) return { companyId: links.companyId };
  return null;
}

/**
 * Display text for anything the composer can fail with. Branches on
 * ApiError.code, never on message text (see src/api.ts): the one code worth
 * special handling is the send path's 502 `smtp_failed`, whose message
 * carries the adapter's classified reason -- see sendFailureMessage.
 */
export function composeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code === "smtp_failed" ? sendFailureMessage(error.message) : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

/**
 * What the thread list and conversation header show for a subject-less
 * thread. A PRESENTATION value, and deliberately only that: the API stores ''
 * for a message that arrived without a Subject header, and normalizeSubject
 * returns '' rather than this string precisely so nothing hashed, threaded or
 * stored ever contains it (api: mail-content.ts's normalizeSubject, and the
 * plan's Task 2 ruling). Living here means the day this app is localized,
 * there is one string to translate rather than one per render site.
 */
export const NO_SUBJECT_LABEL = "(no subject)";

export function subjectLabel(subject: string): string {
  return subject.trim() === "" ? NO_SUBJECT_LABEL : subject;
}

/** "Alice Rivers" when the header carried a display name, the bare address
 * otherwise -- what a thread row's sender summary and a message's From line
 * both show. */
export function addressLabel(address: MailAddress): string {
  return address.name != null && address.name.trim() !== "" ? address.name : address.address;
}

// ---------------------------------------------------------------------------
// Thread-list page accumulation
// ---------------------------------------------------------------------------

/**
 * The inbox pages by keyset cursor and the cursor is part of the query key
 * (queries.ts's useMailThreads), so every page is its OWN cache entry -- this
 * is deliberately not an infinite query, matching the house pattern. The
 * accumulation across pages is therefore the component's job, and this is it:
 * a small immutable record of which pages have been loaded for which filter
 * set.
 *
 * Keyed on the filter set (see threadFilterKey) so that changing a filter
 * cannot leave the previous filter's pages on screen -- the merge below
 * silently starts over whenever the key differs, which is what makes "reset
 * on filter change" a property of the data structure rather than an effect
 * somebody has to remember to write.
 */
export interface ThreadPages {
  /** Filter identity these pages belong to. */
  key: string;
  /** Cursors in load order; the first page's cursor is FIRST_PAGE. */
  order: string[];
  byCursor: Record<string, readonly MailThreadListItem[]>;
}

/** The first page is fetched with no cursor at all; "" stands in for it as a
 * map key, and can never collide with a real cursor (the route holds those to
 * `.min(1)`). */
export const FIRST_PAGE = "";

export function emptyThreadPages(key: string): ThreadPages {
  return { key, order: [], byCursor: {} };
}

/**
 * A stable string identity for one filter set. Sorted by key and built only
 * from defined values, so two filter objects that mean the same thing produce
 * the same string regardless of how they were assembled.
 */
export function threadFilterKey(filters: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(filters)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

/**
 * Fold one fetched page into the accumulator.
 *
 * A different `key` discards everything: the pages on screen describe a filter
 * set nobody is looking at any more.
 *
 * A page whose items are the SAME ARRAY as the one already stored returns the
 * accumulator UNCHANGED, by reference. That matters: this runs from a render
 * effect, and returning a fresh object for an unchanged page would set state
 * on every render forever. React Query hands out a new array whenever a query
 * actually refetches, so a real refetch still replaces its page -- reference
 * equality is exactly the "nothing new arrived" test, not an approximation of
 * one.
 */
export function mergeThreadPage(
  state: ThreadPages,
  key: string,
  cursor: string | undefined,
  items: readonly MailThreadListItem[],
): ThreadPages {
  const base = state.key === key ? state : emptyThreadPages(key);
  const at = cursor ?? FIRST_PAGE;
  if (base.byCursor[at] === items) return base;
  return {
    key,
    order: base.order.includes(at) ? base.order : [...base.order, at],
    byCursor: { ...base.byCursor, [at]: items },
  };
}

/**
 * The accumulated rows, in page order, de-duplicated by thread id with the
 * FIRST sighting winning. The dedupe is not paranoia: a thread that gets a new
 * message while a later page is on screen is re-ordered to the top of page one
 * by the server's (last_message_at, id) keyset, and would otherwise be
 * rendered twice -- once from the refreshed first page and once from the stale
 * later one. First-wins keeps the fresher copy.
 */
export function flattenThreadPages(state: ThreadPages): MailThreadListItem[] {
  const seen = new Set<string>();
  const out: MailThreadListItem[] = [];
  for (const cursor of state.order) {
    for (const item of state.byCursor[cursor] ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reply / reply-all / forward
// ---------------------------------------------------------------------------

/** The slice of a stored message the reply rules read. Structural rather than
 * MailMessage itself so the tests can state a case in four fields. */
export interface ReplySource {
  fromAddr: string;
  fromName?: string | null;
  toAddrs: readonly MailAddress[];
  ccAddrs: readonly MailAddress[];
  direction: "inbound" | "outbound";
}

/**
 * Which message a Reply answers: the most recent INBOUND one, falling back to
 * the most recent message of any direction.
 *
 * The fallback is the case where the whole thread is our own outbound mail (a
 * conversation the CRM started and nobody has replied to yet). Replying there
 * means writing to the people the last message went TO -- see replyRecipients'
 * outbound branch -- not to ourselves, which is what "reply to the last
 * message's From" would produce.
 */
export function replySource<T extends { direction: "inbound" | "outbound" }>(
  messages: readonly T[],
): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.direction === "inbound") return message;
  }
  return messages[messages.length - 1];
}

export interface ReplyRecipients {
  to: ComposerRecipient[];
  cc: ComposerRecipient[];
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Who a reply is addressed to.
 *
 * Reply: the sender alone (or, on our own outbound message, its original To).
 * Reply-all: that, plus everyone else who was on the message -- its To and Cc,
 * minus the addresses of THIS INSTALLATION'S OWN mail accounts and minus
 * anyone already in `to`.
 *
 * THE OWN-ADDRESS EXCLUSION APPLIES TO THE REPLY-ALL EXTRAS, NOT TO THE
 * PRIMARY RECIPIENT. It exists to stop a reply-all cc'ing a mailbox this CRM
 * itself syncs: that would mail the user a copy of their own reply and, worse,
 * feed it back in as an inbound message on the same thread. It must never
 * decide WHO THE REPLY IS TO. A colleague whose mailbox is also synced here is
 * a perfectly ordinary correspondent, and filtering them out of `to` left
 * internal mail with no recipient at all and a disabled Send button. The one
 * place it still applies to `to` is our OWN outbound message's original To --
 * replying to a conversation we started must not address ourselves -- and even
 * there, an empty result falls back to the sender rather than handing back
 * nothing.
 *
 * The comparison is case-insensitive and trimmed because the local part's case
 * is preserved by every mail server on earth and matched by none of them, and
 * because header addresses arrive with whatever whitespace the sender's client
 * left on them.
 */
export function replyRecipients(
  message: ReplySource,
  options: { all: boolean; ownAddresses: readonly string[] },
): ReplyRecipients {
  const own = new Set(options.ownAddresses.map(normalizeAddress));
  const sender: ComposerRecipient = { address: message.fromAddr, name: message.fromName ?? null };
  const primary: ComposerRecipient[] = message.direction === "inbound"
    ? [sender]
    : message.toAddrs
      .map((address) => ({ address: address.address, name: address.name ?? null }))
      .filter((entry) => !own.has(normalizeAddress(entry.address)));
  // Safety net: a reply with nobody in To is a dead end for the user (the
  // composer's Send is disabled on an empty To), so the sender stands in --
  // even when the sender is us, which is the honest answer for a note we sent
  // to ourselves and something the user can edit.
  const to = dedupeRecipients(primary.length > 0 ? primary : [sender]);
  if (!options.all) return { to, cc: [] };

  const taken = new Set(to.map((entry) => normalizeAddress(entry.address)));
  const others = [...message.toAddrs, ...message.ccAddrs]
    .map((address) => ({ address: address.address, name: address.name ?? null }))
    .filter((entry) => {
      const key = normalizeAddress(entry.address);
      return !own.has(key) && !taken.has(key);
    });
  return { to, cc: dedupeRecipients(others) };
}

const REPLY_PREFIX = /^\s*re\s*:/i;
const FORWARD_PREFIX = /^\s*fwd?\s*:/i;

/** "Re: ..." for the composer's subject field, added at most once. The API
 * threads on its own normalized subject (and on the References chain), so this
 * is display convention for the RECIPIENT's mail client, not something
 * threading here depends on. */
export function replySubject(subject: string): string {
  const label = subject.trim();
  if (label === "") return "Re: ";
  return REPLY_PREFIX.test(label) ? label : `Re: ${label}`;
}

/** "Fwd: ...", same rule. */
export function forwardSubject(subject: string): string {
  const label = subject.trim();
  if (label === "") return "Fwd: ";
  return FORWARD_PREFIX.test(label) ? label : `Fwd: ${label}`;
}

export interface ForwardSource extends ReplySource {
  subject: string;
  sentAt: string;
  bodyHtml: string | null;
  bodyText: string;
}

function addressListText(addresses: readonly MailAddress[]): string {
  return addresses
    .map((address) => (address.name != null && address.name !== ""
      ? `${address.name} <${address.address}>` : address.address))
    .join(", ");
}

/**
 * The quoted original a Forward opens with: a From/Date/Subject/To header
 * block, then the message body inside a blockquote.
 *
 * `bodyHtml` is already sanitized -- it is what the API served for this
 * message, and the only HTML that ever reaches a client (api:
 * mail-content.ts's sanitizeMailHtml runs at ingest). It is spliced in as
 * markup; the header VALUES around it are escaped, because a display name is
 * ordinary text that may contain angle brackets. A text-only message is
 * escaped whole and its newlines become <br>, since the composer's editor is
 * an HTML document and would otherwise collapse them.
 *
 * ATTACHMENTS ARE NOT CARRIED OVER in v1, deliberately: POST /api/files links
 * a file to exactly one record, so re-attaching would mean COPYING each blob
 * onto the forward's own record rather than referencing the original rows.
 * That is a real feature (with a real storage cost), not a detail of this
 * function -- deferred rather than half-done. The forwarded body still shows
 * the reader that attachments existed, via the original's own markup.
 */
export function forwardBody(
  message: ForwardSource,
  formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string {
  const from = message.fromName != null && message.fromName !== ""
    ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr;
  const header = [
    `From: ${escapeHtmlText(from)}`,
    `Date: ${escapeHtmlText(formatDate(message.sentAt))}`,
    `Subject: ${escapeHtmlText(subjectLabel(message.subject))}`,
    `To: ${escapeHtmlText(addressListText(message.toAddrs))}`,
    ...(message.ccAddrs.length > 0 ? [`Cc: ${escapeHtmlText(addressListText(message.ccAddrs))}`] : []),
  ].join("<br>");
  const body = message.bodyHtml != null && message.bodyHtml !== ""
    ? message.bodyHtml
    : `<p>${escapeHtmlText(message.bodyText).replace(/\r?\n/g, "<br>")}</p>`;
  return `<p></p><p>---------- Forwarded message ----------<br>${header}</p><blockquote>${body}</blockquote>`;
}

// ---------------------------------------------------------------------------
// Message frame (the conversation's sandboxed body iframe)
// ---------------------------------------------------------------------------

/**
 * The `sandbox` attribute for a message body's iframe. A constant, not a
 * literal in the component, so the flags have one place to be read, reviewed
 * and tested.
 *
 * `allow-same-origin` (coordinator ruling, 20 Aug): an EMPTY sandbox gives the
 * frame an opaque origin, so SameSite cookies are not attached to its
 * subresource loads and the SSOwat proxy in front of this app bounces the
 * cookieless inline-image requests to its login page -- inline `cid:` images
 * would simply never render. Signed attachment URLs would avoid that but need
 * SSOwat `skipped_uris` packaging changes.
 *
 * `allow-popups` + `allow-popups-to-escape-sandbox` (coordinator ruling,
 * 20 Aug, amending the above): a link in a message opens in a new tab, the way
 * it does in every mail client. Without the pair the sanitizer's own
 * `target="_blank"` is inert and links do nothing at all, which reads as a
 * broken app rather than as a security posture. The `-to-escape-sandbox` half
 * is what makes the opened tab an ORDINARY tab instead of one that inherits
 * these flags -- inheriting them would hand a hostile message a same-origin,
 * unsandboxed-by-CSP document to work with.
 *
 * The opened tab cannot reach back through `window.opener`, because the
 * ingest-time sanitizer stamps `rel="noopener noreferrer"` on every anchor
 * (api: mail-content.ts's transformTags) -- with the popup flags on, that
 * transform is load-bearing rather than belt-and-braces.
 *
 * WHAT IS DELIBERATELY ABSENT, and must never be added:
 * `allow-scripts` (the whole basis for granting the frame this app's origin),
 * `allow-forms` (a message could POST to the app as the user),
 * `allow-top-navigation` (a message could navigate the CRM out from under
 * them), `allow-modals` (a message could hold the tab with a dialog).
 */
export const MESSAGE_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * The Content-Security-Policy injected into a message body's iframe.
 *
 * Default state: nothing loads except images from this app's own origin (the
 * inline attachments a message body's cid: references were rewritten to, which
 * the API serves from /api/mail/attachments/:id/inline) and data: URIs, plus
 * inline styles, which real mail is made of. `default-src 'none'` covers
 * everything else -- scripts, frames, fonts, media, form submissions.
 *
 * `remoteImages` widens img-src by `https:` and `http:`, and NOTHING else:
 * that is the whole of what the per-thread "Load remote images" button buys,
 * and it stays off until a human asks, because a remote image in a mail is a
 * read receipt for the sender.
 *
 * This function must never emit anything resembling `allow-scripts`. Scripts
 * are blocked twice over -- by MESSAGE_FRAME_SANDBOX above, which grants no
 * `allow-scripts`, and by this policy's `default-src 'none'` -- and that
 * doubling is what makes it acceptable to give the frame the app's own origin
 * so cookie-authenticated inline images load through the SSOwat proxy.
 *
 * Note also what this policy does NOT emit: a `sandbox` directive. A CSP
 * `sandbox` re-imposes sandboxing from inside the document and would drop the
 * popup flags the attribute grants, breaking message links again.
 */
export function messageFrameCsp(origin: string, options: { remoteImages: boolean }): string {
  const img = ["data:", "'self'", ...(origin === "" ? [] : [origin])];
  if (options.remoteImages) img.push("https:", "http:");
  return `default-src 'none'; img-src ${img.join(" ")}; style-src 'unsafe-inline'`;
}

/**
 * The complete document handed to the iframe's `srcdoc`.
 *
 * The CSP rides in a <meta> tag because a srcdoc document has no response of
 * its own to carry a header on. `referrer` is pinned to no-referrer for the
 * same reason remote images are opt-in: a loaded image should not also tell
 * the sender which page it was loaded from.
 *
 * The styles are the minimum that keeps real-world mail from breaking the
 * layout -- images bounded to the frame's width, long unbroken strings wrapped
 * -- and are inline because the frame may load nothing from anywhere.
 */
export function messageFrameSrcdoc(bodyHtml: string, csp: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    "<style>",
    "html,body{margin:0;padding:0}",
    "body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color:#0f172a;padding:12px;overflow-wrap:anywhere}",
    "img{max-width:100%;height:auto}",
    "blockquote{margin:0 0 0 12px;padding-left:12px;border-left:2px solid #cbd5e1;color:#475569}",
    "table{max-width:100%}",
    "</style></head><body>",
    bodyHtml,
    "</body></html>",
  ].join("");
}
