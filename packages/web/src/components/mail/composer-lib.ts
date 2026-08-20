import { MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX } from "@conduit/shared";
import { ApiError } from "../../api";

/**
 * The composer's (and the mail settings page's) pure parts, kept out of the
 * components so they can be unit-tested without a DOM: recipient token
 * parsing, template placeholder substitution, and the mapping from the
 * shared mail error prefixes to something a user can act on.
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

/**
 * Substitutes `{{contact.name}}`, `{{company.name}}` and `{{user.name}}` from
 * the given context. A placeholder with nothing to fill it is LEFT LITERAL
 * (spec: "unresolved placeholders are left visible for the user to fill"),
 * never replaced with an empty string -- an email that silently reads "Hi ,"
 * is worse than one that visibly still needs a name.
 */
export function substitutePlaceholders(input: string, context: TemplateContext): string {
  return input.replace(PLACEHOLDER, (match, field: string) => {
    const value = field === "contact" ? context.contactName
      : field === "company" ? context.companyName
        : context.userName;
    return value != null && value.trim() !== "" ? value : match;
  });
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
