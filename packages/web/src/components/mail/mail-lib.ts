import type {
  BulkThreadActionKind, BulkThreadResult, BulkThreadResultReason, MailAddress,
  MailUnreadFolderCount, SpecialUse,
} from "@conduit/shared";
import {
  BULK_ACTION_THREAD_CAPS, MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX,
  MOVE_ACTION_THREAD_CAP, BULK_MESSAGE_ACTION_CAP,
} from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../../api";
import { relativeTime, type PendingArrivals } from "../../lib";

/**
 * The mail feature's pure parts, kept out of the components so they can be
 * unit-tested without a DOM: recipient token parsing, the mapping from the
 * shared mail error prefixes to something a user can act on, the thread
 * selection, and the reply/forward and message-frame rules the conversation
 * view is built from.
 *
 * The inbox's page accumulation was here until v0.9.1, when a third and fourth
 * consumer outside mail moved it to src/lib.ts (CursorPages).
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

/** Which field a freshly opened composer puts the caret in. */
export type ComposerFocusTarget = "to" | "subject" | "body";

/**
 * WHERE THE CARET GOES WHEN THE COMPOSER OPENS: the FIRST EMPTY field, in the
 * order To, Subject, body.
 *
 * THE PLAN SAID "a new compose focuses To, a reply focuses the body", and the
 * discriminator here is the seed's emptiness instead. The four cases and the
 * answers are the coordinator's ruling and stand exactly as ruled:
 *
 *   opened from            to        subject      caret
 *   inbox, blank compose   empty     empty        To
 *   a record's Mail tab    seeded    empty        Subject
 *   a conversation, reply  seeded    "Re: ..."    body
 *   a conversation, fwd    empty     "Fwd: ..."   To
 *
 * WHAT THE PLAN'S RULE ACTUALLY GETS WRONG IS ROW 2, NOT ROW 4, and the first
 * version of this comment had it backwards. The ruling that reached this file
 * said "reply versus new" misplaces a FORWARD, because a forward carries a
 * quoted body and no recipient. That is false and the coordinator has withdrawn
 * it. This codebase's own reply-versus-new discriminator is the seed's
 * threadId -- composer.tsx titles the dialog `threadId === undefined ? "New
 * message" : "Reply"` -- and conversation.tsx's openForward sets NO threadId
 * ("a forward starts its own conversation with someone new"). So a forward IS
 * a new compose under the plan's rule, and the plan's rule puts the caret in
 * To, which is the right answer.
 *
 * The row it misses is a RECORD'S MAIL TAB: no threadId, so a new compose, so
 * To -- but To arrives already holding the contact's address. That makes the
 * plan's rule wrong on an INSTANCE OF ONE OF ITS OWN TWO NAMED CASES rather
 * than on an unmentioned third, which is a smaller claim and the true one.
 * Mutation-tested: replacing this body with `threadId === undefined ? "to" :
 * "body"` fails TWO of the six cases below -- the record's Mail tab and the
 * bare-prefix case -- and passes the forward, which is the point.
 *
 * IT WAS THREE UNTIL THE FIXTURES MOVED, AND THE FIXTURES MOVED IN THE SAME
 * COMMIT THAT WROTE "three". The reply case below gained an explicit
 * `threadId`, to record that this function never reads one -- and that is
 * exactly what makes the reply case survive a rule which reads nothing else.
 * The number is restated here rather than dropped because the reason it moved
 * is the useful half: a measurement taken against one set of fixtures does not
 * survive a change to those fixtures, however small the change looks.
 *
 * The subject is trimmed before it is judged so that a caller seeding "   "
 * counts as having seeded nothing. That is the whole reason, and an earlier
 * version of this comment also offered a second one that does not survive
 * arithmetic: `replySubject("")` returns "Re: " and `forwardSubject("")`
 * returns "Fwd: ", and both are "body"/"to" with the trim or without it,
 * because trimming them leaves "Re:" and "Fwd:" rather than "". Those seeds
 * are still worth their test -- a bare prefix IS the subject the user is being
 * offered and must count as filled -- but they are not what the trim is for.
 *
 * The BODY is deliberately not consulted. It is the last field in the order,
 * so it is what is left when To and Subject are both filled, and reading
 * `bodyHtml` would only let a forward's quoted original argue itself out of
 * the To it needs.
 */
export function composerInitialFocus(
  seed: { to?: readonly ComposerRecipient[]; subject?: string } | undefined,
): ComposerFocusTarget {
  if ((seed?.to ?? []).length === 0) return "to";
  if ((seed?.subject ?? "").trim() === "") return "subject";
  return "body";
}

/** Text-node escaping for a value being spliced into markup. Ampersand
 * first, or it would double-escape the entities the others produce. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** As much of a mail account as the signature rule below reads. */
export interface SignatureAccount {
  id: string;
  signatureHtml?: string | null;
}

declare const SIGNATURE_KEY_BRAND: unique symbol;

/**
 * One (editor epoch, account) pair, as a value only signatureAppend can mint.
 *
 * BRANDED SO THE CALLER CANNOT BUILD ONE, which is the whole reason this type
 * exists rather than a bare string. The defect v1.2.1 removed was a composer
 * that assembled its own key and stamped it before knowing whether there was
 * anything to sign; with the brand, an `${epoch}:${id}` template literal is
 * not assignable here and `tsc` refuses it.
 *
 * IT RAISES THE COST OF THAT MISTAKE RATHER THAN MAKING IT IMPOSSIBLE. A cast
 * defeats any brand in TypeScript, so this stops the accident and the
 * absent-minded refactor, not a determined author -- stated because the
 * honest limit of a guard is worth more than an overclaim, which is the same
 * position components/mail/composer-focus.test.ts takes about reading source.
 */
export type SignatureKey = string & { readonly [SIGNATURE_KEY_BRAND]: true };

/**
 * What one pass of the composer's signature effect should do: the HTML to
 * append AND the ledger to remember it by, or nothing at all. Never one
 * without the other, which is the whole point -- see signatureAppend.
 */
export interface SignatureAppend {
  /** Everything signed before this pass, plus the pair this pass signs. */
  signed: ReadonlySet<SignatureKey>;
  html: string;
}

/**
 * ONE PASS OF THE COMPOSER'S SIGNATURE EFFECT, AS A DECISION RATHER THAN AN
 * EFFECT BODY. Extracted for the reason composerInitialFocus above was: this
 * package has no testing-library, so a rule that stays inside a component has
 * no unit-level check at all.
 *
 * The selected account's signature is appended ONCE, at the end of the body,
 * for each (editor epoch, account) pair -- the initial auto-selection
 * included. `signedFor` is EVERY pair signed so far, not the last one:
 * switching A to B and back to A is one gesture in the From dropdown, and
 * against a scalar it appended A's signature a second time. Keying on the
 * editor EPOCH as well as the account is what keeps a rebuilt editor covered:
 * it announces itself again, so the fresh, empty document gets the signature
 * instead of silently losing it.
 *
 * THE LEDGER COMES BACK WITH THE HTML, AND THAT COUPLING IS THE FIX. The
 * effect used to stamp its key and look the signature up afterwards, so a pass
 * that ran while the selected account was still missing from the list claimed
 * the pair and appended nothing -- and the pass that ran once the accounts
 * arrived returned early on that same key. The signature was then lost for the
 * life of that composer. A caller has no key to stamp unless a pass handed one
 * back, so it cannot claim a pair it did not sign.
 *
 * MEASURED IN CHROMIUM AGAINST THE REAL COMPONENT, with GET /api/mail/accounts
 * held for 800ms: a seed carrying an accountId ended with an empty body, and
 * the same seed against an already-resolved accounts cache ended holding the
 * signature. So did a seed carrying no accountId at all against the cold one,
 * because a null selection makes this return null WITHOUT claiming anything.
 *
 * THE SEEDED HALF OF THAT IS NOT A STATE THE APP CAN REACH, and the record is
 * worth more than the fix. Only a reply or a forward seeds an accountId, and
 * conversation.tsx builds it by searching the same ["mail-accounts"] query the
 * composer reads with a predicate identical to this one's -- so a seeded
 * accountId implies a resolved cache, and a Reply clicked early enough to beat
 * the accounts arrives carrying no accountId at all. A review enumerated every
 * ComposerSeed construction in the repo and found no other producer: no route
 * parameter, no per-record default, no restored draft, and no browser storage
 * anywhere in packages/web/src. The ordering is corrected anyway because the
 * first caller to seed an account id from somewhere else reopens it with no
 * other line changing.
 *
 * THE UNSEEDED COLD REPLY IS REACHABLE, AND IT IS WHERE THE DEFERRED APPEND
 * ACTUALLY HAPPENS -- see composer.tsx's pending-body-focus comment, which
 * has said so correctly since v1.2.0.
 */
export function signatureAppend(args: {
  editorEpoch: number;
  selectedAccountId: string | null;
  accounts: readonly SignatureAccount[];
  signedFor: ReadonlySet<SignatureKey>;
}): SignatureAppend | null {
  const { editorEpoch, selectedAccountId, accounts, signedFor } = args;
  // Epoch 0 is "the editor has not announced itself yet", so there is nothing
  // to append TO -- see RichTextEditor's onCreate.
  if (editorEpoch === 0 || selectedAccountId === null) return null;
  const key = `${editorEpoch}:${selectedAccountId}` as SignatureKey;
  if (signedFor.has(key)) return null;
  const signature = accounts.find((account) => account.id === selectedAccountId)?.signatureHtml;
  if (signature === undefined || signature === null) return null;
  // htmlIsBlank, NOT `=== ""`, and the difference is reachable. The API's
  // nullableString is `min(1).nullable()`, so "" never arrives off the wire
  // and an equality check guards the one case that cannot happen -- while
  // "   " and "<p></p>" (TipTap's empty document, named as such in
  // pages/settings-mail.tsx) both pass min(1), survive sanitizeMailHtml, and
  // would put a bare separator paragraph at the end of the body. The settings
  // UI maps them to null on its way in; nothing makes another client do the
  // same, and e2e/composer-focus.spec.ts's own fixture PATCHes the field raw.
  if (htmlIsBlank(signature)) return null;
  return { signed: new Set(signedFor).add(key), html: signatureBlock(signature) };
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
 * ATTACHMENTS ARE NOT THIS FUNCTION'S JOB: this builds the quoted BODY
 * alone. The original's stored attachments ride the forward separately
 * (Phase 4.3) -- the conversation seeds them into the composer as
 * ComposerSeed.forwardAttachments and the API re-attaches the stored blobs
 * by id (sendMailInputSchema's forwardAttachmentIds), no re-upload and no
 * copy onto a record involved.
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
// Detail cap + Hidden view labels (Phase 4.3)
// ---------------------------------------------------------------------------

/**
 * The "Show earlier messages (N more)" control's label, or null when the
 * control has nothing to offer (the payload was not truncated). N is
 * totalMessages minus what the capped page rendered -- both facts of the
 * SAME response (the server computes totalMessages over the same visible
 * set the page was cut from), so the subtraction cannot go stale against a
 * refetch. The truncated flag stays the gate rather than deriving one from
 * the counts here: it is the server's own statement about this payload,
 * and re-deriving it client-side is exactly the drift the flag exists to
 * prevent.
 */
export function showEarlierLabel(
  detail: { truncated: boolean; totalMessages: number; messages: readonly unknown[] },
): string | null {
  if (!detail.truncated) return null;
  const more = detail.totalMessages - detail.messages.length;
  if (more <= 0) return null;
  return `Show earlier messages (${more} more)`;
}

/**
 * The thread row's "Hidden <when>" chip, or null for no chip. `hiddenAt` is
 * the VIEWER'S OWN filing moment (per-viewer by construction: null on every
 * default-list row, set on Hidden-view rows and a hidden thread's detail --
 * api: mail-threads.ts's toThread), so the chip appears exactly on the
 * Hidden view's rows without the row knowing which view it is rendering in.
 */
export function hiddenChipLabel(hiddenAt: string | null, now: Date = new Date()): string | null {
  if (hiddenAt === null) return null;
  return `Hidden ${relativeTime(hiddenAt, now)}`;
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
 *
 * THE TWO ARGUMENTS ARE SPLICED WITH DIFFERENT CONTRACTS, and the difference is
 * the whole security story of this function:
 *
 * - `csp` is an ATTRIBUTE VALUE. It must be a policy string -- in practice one
 *   built by messageFrameCsp above, whose grammar is directive names, scheme
 *   and origin tokens, and CSP's own single-quoted keywords, so it can never
 *   contain the double quote that would end the attribute. Because that is a
 *   property of the CALLER rather than of this function, the splice escapes
 *   double quotes anyway: safe by construction AND safe if a future policy
 *   builder ever emits something quoted. Never pass caller-controlled text
 *   here.
 * - `bodyHtml` is MARKUP, spliced verbatim on purpose -- escaping it would
 *   render a mail as its own source. It is only ever a body the API served,
 *   which means it has been through mail-content.ts's sanitizer at ingest; the
 *   sandbox and the CSP above are what contain whatever survived that. Never
 *   pass un-sanitized HTML here.
 */
export function messageFrameSrcdoc(bodyHtml: string, csp: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`,
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

// ---------------------------------------------------------------------------
// Thread selection (Phase 4.1 multi-select)
// ---------------------------------------------------------------------------

/**
 * Which rows of the thread list are ticked, and which filter set they were
 * ticked under.
 *
 * The `key` is the SAME filter identity CursorPages uses (lib.ts's identityKey), and
 * it is here for the same reason: "the selection clears when the filter or the
 * folder changes" is a property of this record rather than an effect somebody
 * has to remember to write. Every function below runs the incoming state
 * through selectionForKey first, so a selection made in the INBOX view can
 * never be acted on from the Archive view -- not even for the one render
 * between a filter changing and an effect firing, because there is no such
 * render.
 *
 * `anchor` is the row a shift-click ranges FROM: the last row ticked by an
 * ordinary click. It survives a shift-click (see extendThreadSelection) so that
 * widening and narrowing a range works the way every mail client's does.
 *
 * `capped` is how many rows the LAST gesture would have ticked, when that was
 * more than SELECT_ALL_CAP allows -- null whenever nothing was cut short. It is
 * on the record rather than derived at the render site because only the
 * operation knows what it was asked for: after the fact, a selection of exactly
 * 50 out of 80 visible rows is indistinguishable from 50 rows ticked one at a
 * time. Something has to say so out loud (see selectionLabel), or the gesture
 * silently does less than the user asked.
 */
export interface ThreadSelection {
  key: string;
  ids: ReadonlySet<string>;
  anchor: string | null;
  capped: number | null;
}

/**
 * The most rows ONE SELECTION may hold, whatever gesture built it.
 *
 * THE SERVER'S OWN NUMBER, imported rather than copied: MOVE_ACTION_THREAD_CAP
 * is the per-request cap the bulk route enforces for `trash`/`archive` (api:
 * routes/mail.ts), and it lives in @conduit/shared beside the schema it
 * tightens precisely so this line cannot drift from it -- a local 50 that
 * outlived a server-side change would build selections the route answers with a
 * 400. It is deliberately not the page size (the route's default page is 25, and
 * the list ACCUMULATES pages, so "everything visible" grows past any page size
 * as soon as "load more" is pressed). `hide` could take the outer 200, but one
 * number is easier to hold than a per-action select-all.
 *
 * IT BOUNDS EVERY GESTURE, not just select-all: a shift-range over 80 rows and a
 * select-all over 80 rows are the same request to the same endpoint, and a cap
 * that only one of them respected would leave the other's Archive button
 * disabled with no way back except unticking rows by hand.
 */
export const SELECT_ALL_CAP = MOVE_ACTION_THREAD_CAP;

export function emptySelection(key: string): ThreadSelection {
  return { key, ids: new Set(), anchor: null, capped: null };
}

/**
 * Add ids to a selection until the cap is reached, and report what the whole
 * request would have been.
 *
 * `wanted` counts every id the gesture asked for INCLUDING the ones already
 * ticked, because that is the number the user would count on screen: a range
 * over 60 rows of which 10 were already ticked is a 60-row gesture, not a
 * 50-row one. `capped` is that number when it exceeds what was taken, null
 * otherwise -- so selectionLabel can say "50 of 60" without the caller having
 * to remember what it asked for.
 */
function addUpToCap(
  base: ReadonlySet<string>, incoming: readonly string[],
): { ids: Set<string>; capped: number | null } {
  const ids = new Set(base);
  let wanted = base.size;
  for (const id of incoming) {
    if (!ids.has(id)) wanted += 1;
    if (ids.size >= SELECT_ALL_CAP) continue;
    ids.add(id);
  }
  return { ids, capped: wanted > ids.size ? wanted : null };
}

/**
 * The selection as it applies to `key` -- itself when it was made under that
 * key, an empty one otherwise. The whole clear-on-filter-change rule, in the
 * same shape cursorForKey gives the paging one.
 */
export function selectionForKey(state: ThreadSelection, key: string): ThreadSelection {
  return state.key === key ? state : emptySelection(key);
}

/**
 * Tick or untick one row, and make it the anchor for the next shift-click. The
 * anchor moves even on an UNTICK: it marks where the pointer last was, which is
 * what the next range should start from.
 *
 * A single tick past the cap is REFUSED rather than swapping some other row out:
 * the cap is a property of the request, not of this row, and silently dropping a
 * row the user ticked earlier would be worse than not adding this one. The
 * refusal is reported through `capped` (cap + 1 asked for), so the bar can
 * explain a checkbox that did not tick. Unticking always works.
 */
export function toggleThreadSelected(
  state: ThreadSelection, key: string, threadId: string,
): ThreadSelection {
  const base = selectionForKey(state, key);
  const ids = new Set(base.ids);
  if (ids.has(threadId)) {
    ids.delete(threadId);
    return { key, ids, anchor: threadId, capped: null };
  }
  if (ids.size >= SELECT_ALL_CAP) return { ...base, key, anchor: threadId, capped: ids.size + 1 };
  ids.add(threadId);
  return { key, ids, anchor: threadId, capped: null };
}

/**
 * Shift-click: tick every row between the anchor and `threadId` in the VISIBLE
 * row order (`order` is what the list is currently rendering, accumulated pages
 * included -- the only order a user could have meant).
 *
 * A range only ever ADDS. Untick is what a plain click is for, and a range that
 * toggled would flip rows the user can see are already ticked.
 *
 * With no anchor, or when either end is no longer in the list (a refetch can
 * drop a row out from under a selection), this degrades to a plain toggle
 * rather than guessing at a range that no longer exists.
 *
 * The range is CAPPED like every other gesture: rows are taken from the anchor
 * end outwards until the selection is full, and the rest are reported through
 * `capped` rather than quietly not appearing. Dragging a 200-row range must not
 * produce a selection no button will send.
 */
export function extendThreadSelection(
  state: ThreadSelection, key: string, threadId: string, order: readonly string[],
): ThreadSelection {
  const base = selectionForKey(state, key);
  const from = base.anchor === null ? -1 : order.indexOf(base.anchor);
  const to = order.indexOf(threadId);
  if (from < 0 || to < 0) return toggleThreadSelected(base, key, threadId);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  // From the ANCHOR outwards, so the rows that survive a truncated range are the
  // ones nearest where the user started rather than whichever end sorts first.
  const range = order.slice(lo, hi + 1);
  const { ids, capped } = addUpToCap(base.ids, from > to ? [...range].reverse() : range);
  // The anchor STAYS: a second shift-click re-ranges from the same origin,
  // which is how a user narrows a range they overshot.
  return { key, ids, anchor: base.anchor, capped };
}

/**
 * The header checkbox: tick every visible row (up to SELECT_ALL_CAP), or -- when
 * they are all ticked already -- clear the selection outright.
 *
 * Clearing empties EVERYTHING, including any row that has since scrolled out of
 * the list; the button reads "none selected" afterwards and that must be true.
 *
 * Ticking COMPOSES over whatever is already selected and the cap applies to the
 * total, not to the page: with 40 rows already ticked, "select all" over 80
 * visible rows adds 10 and says so. Slicing the order to the cap first (the
 * previous shape) could hand back 90.
 */
export function toggleAllOnPage(
  state: ThreadSelection, key: string, order: readonly string[],
): ThreadSelection {
  const base = selectionForKey(state, key);
  const page = order.slice(0, SELECT_ALL_CAP);
  if (page.length > 0 && page.every((id) => base.ids.has(id))) return emptySelection(key);
  const { ids, capped } = addUpToCap(base.ids, order);
  return { key, ids, anchor: base.anchor, capped };
}

/** Whether the header checkbox should read as ticked: every row it would tick
 * is ticked already. */
export function allOnPageSelected(
  state: ThreadSelection, key: string, order: readonly string[],
): boolean {
  const base = selectionForKey(state, key);
  const page = order.slice(0, SELECT_ALL_CAP);
  return page.length > 0 && page.every((id) => base.ids.has(id));
}

/**
 * The selected ids, in visible row order, and ONLY the ones still visible.
 *
 * The filter is not tidiness: a refetch can drop a thread out of the list (it
 * was moved, hidden, or simply fell off the page) while its id sits in the
 * selection, and sending an id for a row nobody can see any more would act on
 * mail the user is not looking at.
 */
export function selectedThreadIds(
  state: ThreadSelection, key: string, order: readonly string[],
): string[] {
  const base = selectionForKey(state, key);
  return order.filter((id) => base.ids.has(id));
}

/**
 * Why a bulk action cannot be sent as selected, or null when it can.
 *
 * Mirrors the server's caps rather than trusting them to hold: the route
 * answers an over-cap request with a 400, and a disabled button with a reason
 * beats a red error after the click.
 */
export function bulkActionBlocked(action: BulkThreadActionKind, count: number): string | null {
  // The API's own table, imported rather than mirrored: it used to be a copy
  // of the same Record in this file, which is one more place for the numbers
  // to drift and one more place a new action kind has to be remembered.
  const cap = BULK_ACTION_THREAD_CAPS[action];
  if (count <= cap) return null;
  return `Select ${cap} conversations or fewer for this action (${count} selected).`;
}

/**
 * Why the destination picker cannot be offered, or null when it can.
 *
 * TWO CAUSES, TWO SENTENCES, because they have two different remedies and a
 * greyed control with no explanation is the thing this bar has been at pains
 * not to be (see BulkBlockedNote).
 *
 * The account one is the interesting decision. A folder name is PER MAILBOX:
 * "Clients" on one account and "Clients" on another are different folders that
 * may not both exist, so a picker built while the list is showing every
 * account would be offering one account's folders as if they were everyone's.
 * The API handles the mixed case honestly either way -- it resolves the
 * destination per account and refuses only the accounts that lack it
 * (unknown_target) -- so this is a UI decision about what a list of folder
 * names can truthfully mean, not a server limitation.
 *
 * WHERE THE ONE ACCOUNT COMES FROM is the scope, and each has its own first
 * sentence because each has its own remedy. In the LIST it is the account
 * filter, so the answer is to pick one. In the CONVERSATION header there is no
 * filter to pick from -- the account is whichever of the viewer's own mailboxes
 * the thread's messages sit on, and a conversation that reaches two of them
 * cannot be filed as a unit, so the remedy is to file the messages instead. In
 * the message BAR the remedy is narrower still: untick until the selection is
 * one mailbox's. A Record over the scope rather than an if-chain, for the same
 * compile-nudge reason as every other table in this file.
 */
export type FileTargetScope = "list" | "conversation" | "messages";

const NO_SINGLE_ACCOUNT: Record<FileTargetScope, string> = {
  list: "Pick a single account above to file into one of its folders.",
  conversation: "This conversation reaches more than one of your mailboxes, whose folders are"
    + " different \u2014 select the messages you want and file those.",
  messages: "Select messages from a single mailbox to file them into one of its folders.",
};

export function fileTargetsBlocked(
  scope: FileTargetScope, accountScoped: boolean, folderCount: number,
): string | null {
  if (!accountScoped) return NO_SINGLE_ACCOUNT[scope];
  if (folderCount === 0) {
    return "This account has no folders to file into yet \u2014 they appear once a sync pass has"
      + " listed them.";
  }
  return null;
}

/**
 * The move-rights sentence, exactly as the spec's Move rights line words it.
 * One string for both of its surfaces -- the bulk bar's disabled-state note
 * (bulkOwnershipBlocked below) and the per-thread not_owner note
 * (REASON_NOTES) -- so the reason a button was grey and the reason a click
 * skipped can never phrase the same rule two ways. Deliberately not "your
 * account" and deliberately no pointer at Settings: the mailbox in question
 * can be ANOTHER user's, whose sharing is not the viewer's to change.
 */
export const NOT_OWNER_EXPLANATION =
  "only the mailbox owner can file, archive or trash \u2014 Hide in CRM is available to everyone";

/**
 * Which actions the owner-only move rule applies to -- a Record over the kind
 * enum rather than an `action === "hide"` test, so a new kind is a compile
 * error here until someone decides whether it touches a mailbox.
 *
 * `file` (Phase 4.4) is a server MOVE and takes the rule; `unhide` is the CRM
 * side and does not, symmetric with `hide` -- both are exactly the actions
 * every viewer keeps.
 */
const NEEDS_OWNERSHIP: Record<BulkThreadActionKind, boolean> = {
  trash: true, archive: true, file: true, hide: false, unhide: false,
};

/**
 * Why the two MOVE actions cannot be sent for this selection, or null when
 * they can: Phase 4.2's owner-only move rights, as a disabled-with-reason
 * state (the same blocked-note pattern as bulkActionBlocked, and text on the
 * bar for the same reason -- a `title` on a disabled button is invisible to a
 * touch screen and silent to a screen reader).
 *
 * `unowned` counts the SELECTED threads whose `ownedByViewer` is false --
 * threads carrying no message on any account the viewer owns. One such
 * thread blocks Archive/Trash for the whole selection: the per-thread
 * not_owner skip would answer honestly anyway, but a button that knowingly
 * sends some rows to a no-op is worse UX than saying so first. `hide` is
 * never blocked -- Hide in CRM is exactly the action every viewer keeps.
 *
 * The inverse does NOT hold, and the caller must not read it here: owned is
 * necessary, not sufficient. The flag is thread-global while moves are
 * folder-scoped, so an unblocked Archive can still come back not_owner for
 * the folder in view (as well as archived/awaiting) -- the per-reason notes
 * in summarizeBulkResult are the backstop for everything this pre-check
 * cannot know.
 */
export function bulkOwnershipBlocked(
  action: BulkThreadActionKind, unowned: number,
): string | null {
  if (!NEEDS_OWNERSHIP[action] || unowned <= 0) return null;
  const what = unowned === 1 ? "1 selected conversation is" : `${unowned} selected conversations are`;
  return `${what} in a mailbox you don't own: ${NOT_OWNER_EXPLANATION}.`;
}

// ---------------------------------------------------------------------------
// Per-message selection, in the conversation (Phase 4.4 Task 2)
// ---------------------------------------------------------------------------

/**
 * What the conversation holds while messages are ticked.
 *
 * NO ANCHOR AND NO RANGE, unlike ThreadSelection, and that is a decision about
 * this surface rather than an unfinished copy of that one. A shift-range exists
 * in the list because a folder view ACCUMULATES pages and can hold hundreds of
 * rows the user would otherwise tick one at a time. A conversation renders one
 * thread, capped at the newest 50 unless Show-earlier is pressed, all of it on
 * one screen -- there is no long haul for a range to shorten.
 *
 * THERE IS NO SELECT-ALL HERE EITHER, for a stronger reason: filing the whole
 * conversation is a DIFFERENT and better action that already exists one row
 * above (the header picker, Task 2's first half). It sends whole-thread mode,
 * which takes every message including any below the detail cap and carves out
 * Sent; a select-all would send capped, message-scoped ids instead. Offering
 * both would be offering a worse way to do the same thing, next to the better
 * one.
 */
export interface MessageSelection {
  ids: ReadonlySet<string>;
  /** What the last gesture asked for when the cap refused it (cap + 1), else
   * null -- the same reporting ThreadSelection.capped does. */
  capped: number | null;
}

export function emptyMessageSelection(): MessageSelection {
  return { ids: new Set(), capped: null };
}

/**
 * Tick or untick one message. A tick past the cap is REFUSED rather than
 * swapping some other message out, exactly as toggleThreadSelected refuses:
 * the cap is a property of the request, and silently dropping a message the
 * user ticked earlier is worse than not adding this one. Unticking always
 * works, and clears the refusal because the selection is now sendable.
 */
export function toggleMessageSelected(
  state: MessageSelection, messageId: string,
): MessageSelection {
  const ids = new Set(state.ids);
  if (ids.has(messageId)) {
    ids.delete(messageId);
    return { ids, capped: null };
  }
  if (ids.size >= BULK_MESSAGE_ACTION_CAP) return { ids, capped: ids.size + 1 };
  ids.add(messageId);
  return { ids, capped: null };
}

/**
 * The selected ids in rendered order, and ONLY the ones still rendered.
 *
 * The filter is selectedThreadIds' rule for selectedThreadIds' reason: a
 * refetch can drop a message out of the conversation -- it was filed
 * elsewhere, or its account's visibility flipped -- while its id sits in the
 * selection, and sending an id for a row nobody can see any more would act on
 * mail the user is not looking at.
 */
export function selectedMessageIds(
  state: MessageSelection, order: readonly string[],
): string[] {
  return order.filter((id) => state.ids.has(id));
}

/**
 * Why a per-message action cannot be sent as selected, or null when it can.
 *
 * The server's own number (BULK_MESSAGE_ACTION_CAP), imported rather than
 * copied, for the reason SELECT_ALL_CAP imports its own: a local 50 that
 * outlived a server-side change would build requests the route answers with a
 * 400. ONE cap rather than a Record, because unlike the thread endpoint every
 * kind this path offers waits on a mail server and takes the same bound.
 */
export function messageActionBlocked(count: number): string | null {
  if (count <= BULK_MESSAGE_ACTION_CAP) return null;
  return `Select ${BULK_MESSAGE_ACTION_CAP} messages or fewer for this action (${count} selected).`;
}

/**
 * The ONE mailbox of the viewer's own that these messages sit on, or "" when it
 * is not exactly one.
 *
 * Both halves of Task 2 need this and both need it for the same reason a
 * folder picker always does: a folder name is PER MAILBOX, so "Clients" on one
 * account and "Clients" on another are different folders that may not both
 * exist, and a list of names built from two accounts would be one mailbox's
 * names pretending to be both. The header picker asks it of the whole
 * conversation's messages; the message bar asks it of the ticked ones, which is
 * why unticking is a real remedy there and not in the header.
 *
 * OWN ACCOUNTS ONLY, because filing is a server MOVE and those are owner-only
 * (Phase 4.2): another user's shared mailbox is never a destination this viewer
 * can file into, so its messages must not count towards the answer either --
 * counting them would blank the picker for a conversation the viewer can file
 * perfectly well.
 *
 * KNOWN LIMIT, and it is the pre-existing one rather than a new one: the
 * conversation renders at most the newest 50 messages, so a thread whose only
 * message on a SECOND own account is older than that page will look
 * single-account here. The header picker then files whole-thread anyway, the
 * second account has no folder by that name, and the API answers
 * unknown_target for it -- an honest partial failure the result summary
 * reports. The list's picker has exactly this shape of gap (its account filter
 * does not bound which accounts a selected thread's messages are on), and
 * inventing a second, stricter answer here would make the two surfaces
 * disagree about the same question.
 */
export function singleOwnAccount(
  messages: readonly { accountId: string }[], ownAccountIds: ReadonlySet<string>,
): string {
  const owned = new Set<string>();
  for (const message of messages) {
    if (ownAccountIds.has(message.accountId)) owned.add(message.accountId);
  }
  return owned.size === 1 ? [...owned][0] ?? "" : "";
}

/**
 * What the bar says it is holding: "3 selected", or -- when the last gesture
 * asked for more rows than one request may carry -- "50 of 80 selected
 * (per-request limit)".
 *
 * The second form exists because the first one is a LIE about a truncated
 * gesture: a user who shift-clicked to the bottom of an 80-row list and read "50
 * selected" would reasonably conclude they had mis-clicked, and the difference
 * between "the app took 50" and "I somehow selected 50" is the difference
 * between a limit and a bug. It is rendered as ordinary text in the bar rather
 * than as a title on a disabled control -- a tooltip on something that cannot be
 * hovered on a touch screen, and is not read out by a screen reader, is not a
 * message.
 */
export function selectionLabel(count: number, capped: number | null): string {
  return capped === null
    ? `${count} selected`
    : `${count} of ${capped} selected (per-request limit)`;
}

/** How each action reads while it is still running -- present participle, from
 * a Record over the kind enum for the same compile-nudge reason as every other
 * table in this file. */
const PENDING_VERBS: Record<BulkThreadActionKind, string> = {
  trash: "Moving", archive: "Archiving", file: "Filing", hide: "Hiding", unhide: "Unhiding",
};

/**
 * What a selection is made OF, for the copy that has to name it.
 *
 * Phase 4.4 Task 2 introduced the second value, and the reason it is a
 * parameter rather than a second set of copy is that only the NOUN differs:
 * every sentence about a refusal, a cap, a pending wait or a sync switch is
 * true of both units, and two tables saying the same thing about
 * conversations and messages is two chances for them to drift apart.
 */
export type BulkUnit = "conversation" | "message";

function unitNoun(unit: BulkUnit, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

/** How each action reads while it is still running. Present tense and the
 * count, so a bar that is waiting on a mail server says what it is waiting
 * for rather than only greying out. `targetFolder` names the destination for
 * `file`, which is the one action whose sentence is incomplete without it --
 * "Filing 3 conversations..." leaves out the only part the user chose. */
export function bulkPendingLabel(
  action: BulkThreadActionKind, count: number, targetFolder?: string | null,
  unit: BulkUnit = "conversation",
): string {
  const noun = unitNoun(unit, count);
  const tail = action === "trash" ? " to Trash"
    : action === "file" && targetFolder != null ? ` into ${quoted(targetFolder)}` : "";
  return `${PENDING_VERBS[action]} ${count} ${noun}${tail}\u2026`;
}

/** A folder name in the copy, always quoted: mailbox names are arbitrary
 * strings ("Clients 2026", "re: urgent") and an unquoted one runs into the
 * sentence around it. */
function quoted(folder: string): string {
  return `\u201c${folder}\u201d`;
}

// ---------------------------------------------------------------------------
// Mail that has arrived behind the reader (Phase 4.4 Task 3)
// ---------------------------------------------------------------------------

// THE COUNT ITSELF LIVES IN lib.ts, and moved there in v1.7.1 when the record
// rails came to hold still too (their timeline and meetings lists have the
// same shape and had the same defect). Only the WORDING is mail's, which is
// the half that could never be shared: what is waiting is conversations here,
// activity on a timeline, meetings on a meetings tab.

/**
 * The control's label. It says the number because "new mail" alone cannot tell
 * a reader whether it is worth losing their place for, and it is phrased as an
 * instruction because the thing is a button: a bare "3 new conversations"
 * reads as a status line, and a status line that silently swallows clicks is
 * worse than no affordance at all.
 */
export function newMailLabel({ count, atLeast }: PendingArrivals): string {
  return `Show ${count}${atLeast ? "+" : ""} new ${unitNoun("conversation", count)}`;
}

// ---------------------------------------------------------------------------
// Folder sidebar shaping
// ---------------------------------------------------------------------------

/**
 * The fields the sidebar reads off one row of GET /api/mail/accounts/:id/folders
 * (MailAccountFolder). Structural rather than the schema type itself, so a test
 * can state a case in five fields -- the same reason ReplySource exists.
 *
 * `locked` is deliberately NOT among them: it is the route-computed "the picker
 * may not switch this off" flag (INBOX and the account's Sent folder), which the
 * Settings picker needs and the rail has no use for. A field this file does not
 * read has no business being in the shape it asks callers for.
 */
export interface SidebarFolderInput {
  folder: string;
  specialUse: SpecialUse | null;
  syncEnabled: boolean;
  selectable: boolean;
  lastDiscoveredAt: string;
}

export interface SidebarFolderRow {
  /** The IMAP name, BYTE-EXACT as the server listed it -- this string is what
   * goes into the thread-list filter, so it must never be display-cased. */
  folder: string;
  /** That folder's own unread count, straight from the API. */
  unread: number;
  specialUse: SpecialUse | null;
  /** Not re-sighted by the account's most recent discovery pass. */
  stale: boolean;
}

/**
 * Presentation order: INBOX, then Sent/Drafts/Archive, then everything
 * unclassified alphabetically, then Junk and Trash at the bottom -- the order
 * every mail client has trained people to expect. Ordering is a presentation
 * decision, which is why the API sorts by name and this does not.
 */
const SPECIAL_ORDER: Record<SpecialUse, number> = {
  sent: 1, drafts: 2, archive: 3, junk: 5, trash: 6,
};
const ORDINARY_RANK = 4;

/** RFC 3501's one case-insensitive mailbox name, and the only one. */
const INBOX_NAME = "INBOX";

/**
 * The moment of this account's most recent discovery pass, as the ISO string
 * the API serves -- compared lexically, which for a fixed-format UTC timestamp
 * is the same ordering as by time.
 *
 * Staleness with no threshold to guess at: a pass re-stamps
 * `last_discovered_at` on every folder it sighted, with ONE moment for the
 * whole pass (api: mail-folders.ts's discoverFolders binds `now` for every
 * row), so a row behind this is exactly a row the last pass did not see -- a
 * folder deleted or renamed on the server. With one row, or with a set that has
 * never been re-discovered, nothing is behind and nothing is stale.
 */
/**
 * The folder names a thread or a message may be FILED into (Phase 4.4).
 *
 * TWO EXCLUSIONS, AND THEY ARE THERE FOR DIFFERENT REASONS:
 *
 * - `\Noselect` -- a hierarchy node holding no messages. The API refuses it
 *   (`unknown_target`), so offering it would be offering a failure.
 * - STALE -- a folder the LAST DISCOVERY PASS DID NOT RE-SIGHT. This one was
 *   missing until Task 4 and it is the second of the two things the earlier
 *   tasks left: rows in mail_account_folders are never deleted, so a folder
 *   renamed or removed on the server keeps its row for ever, and the picker
 *   went on offering it. Filing into it fails at IMAP -- late, after an
 *   optimistic write, a round trip and a compensating revert, and reported in
 *   the mail server's words rather than the app's. The sidebar and the settings
 *   picker have greyed these on exactly this basis since 4.1; this is that rule
 *   reaching the third surface that needed it.
 *
 * WHAT IS DELIBERATELY KEPT: a folder whose SYNC IS OFF. That is not a mistake
 * to filter out, it is what the feature is for -- filing into such a folder
 * turns its sync on (api: mail-move.ts's enableTargetSync).
 *
 * Staleness is `lastDiscoveredAt < newestDiscovery(...)` -- the same comparison
 * buildFolderRows makes, against the same newest value -- because the newest
 * discovery among an account's folders IS the moment of its last successful
 * LIST. It needs no account row and no clock, and it says exactly "the last
 * pass looked and did not find this one".
 */
export function fileTargetNames(
  folders: readonly { folder: string; selectable: boolean; lastDiscoveredAt: string }[],
): string[] {
  const newest = newestDiscovery(folders);
  return folders
    .filter((row) => row.selectable && !(row.lastDiscoveredAt < newest))
    .map((row) => row.folder);
}

export function newestDiscovery(folders: readonly { lastDiscoveredAt: string }[]): string {
  return folders.reduce<string>(
    (max, row) => (row.lastDiscoveredAt > max ? row.lastDiscoveredAt : max), "",
  );
}

function folderRank(row: SidebarFolderRow): number {
  if (row.folder.toUpperCase() === INBOX_NAME) return 0;
  return row.specialUse === null ? ORDINARY_RANK : SPECIAL_ORDER[row.specialUse];
}

/**
 * The sidebar's rows for ONE account: its folders joined to the per-folder
 * unread counts BY NAME.
 *
 * THE JOIN DIRECTION IS THE CONTRACT (Task 4's handover). `counts` is a plain
 * group-by over unread mail with no accountId on it, so it can carry folders
 * this account has switched off, folders that have VANISHED from the server,
 * and (since Phase 4.2, within what the viewer may see -- the server scopes
 * the counts to the viewer's own and shared accounts) folders belonging to a
 * SHARED account of somebody else's entirely. Iterating the FOLDERS and
 * looking counts up is what makes an unmatched count row a non-event rather
 * than a phantom sidebar entry. The same shape means two
 * accounts' INBOXes share one count row; single-account installs (this
 * release's target) are unaffected, and a per-account badge would need an
 * account-scoped variant of the endpoint that v0.6.0 does not have.
 *
 * NO CLIENT-SIDE RE-DERIVATION of unread. Each count is already scoped to its
 * own folder server-side (the two-scope ruling), so a folder's badge and the
 * rows under it answer the same question -- including Trash, whose badge is the
 * honest count of unread mail in Trash while the nav badge excludes it.
 *
 * What is rendered: every SELECTABLE folder that is either synced, or is the
 * account's own Trash target, or still holds unread mail.
 * - `\Noselect` rows hold no messages by definition and are never rows here.
 * - A switched-off folder is out because switching it off is how a user curates
 *   this list.
 * - THE TRASH TARGET IS ALWAYS IN, and that test comes FIRST -- before the
 *   stale drop and before the sync-enabled one. This CRM's own Trash action
 *   files rows there, so it is the one folder the app itself puts mail into;
 *   dropping it because the server stopped listing it (a rename, or a Trash
 *   that autoexpunges itself out of existence) would hide mail this app moved,
 *   with no rail entry left to find it by. It is matched byte for byte, like
 *   every other folder comparison in this app, and it keeps the "gone" marker
 *   when it is stale -- listed, and honest about what it is.
 * - A folder still holding unread mail stays in whatever its flag says, so no
 *   unread conversation can become unreachable by a toggle.
 * A folder that is switched off, holds no unread mail and is not the Trash
 * target is therefore invisible here even if the CRM holds READ messages in it;
 * answering that exactly would need a per-folder message count the API does not
 * serve, and the picker is one click away.
 */
export function buildFolderRows(
  folders: readonly SidebarFolderInput[],
  counts: readonly MailUnreadFolderCount[],
  options: { trashFolder: string | null },
): SidebarFolderRow[] {
  const unreadByFolder = new Map(counts.map((count) => [count.folder, count.count]));
  const newest = newestDiscovery(folders);
  const rows: SidebarFolderRow[] = [];
  for (const folder of folders) {
    if (!folder.selectable) continue;
    const unread = unreadByFolder.get(folder.folder) ?? 0;
    const stale = folder.lastDiscoveredAt < newest;
    const isTrashTarget = options.trashFolder !== null && folder.folder === options.trashFolder;
    if (!isTrashTarget) {
      if (stale && unread === 0) continue;
      if (!folder.syncEnabled && unread === 0) continue;
    }
    rows.push({ folder: folder.folder, unread, specialUse: folder.specialUse, stale });
  }
  return rows.sort((a, b) => {
    const byRank = folderRank(a) - folderRank(b);
    return byRank === 0 ? a.folder.localeCompare(b.folder) : byRank;
  });
}

// ---------------------------------------------------------------------------
// Bulk action results
// ---------------------------------------------------------------------------

/**
 * One result row, MINUS its id: `threadId` and `messageId` are the only
 * difference between the two response shapes, and everything this summary
 * reads -- ok, skipped, error, reason -- is common to both. Written as an Omit
 * so a message result satisfies it structurally and the whole counting-and-copy
 * layer serves both paths without a second copy (Phase 4.4 Task 2).
 */
type BulkResultItem = Omit<BulkThreadResult["results"][number], "threadId">;

export interface BulkActionSummary {
  /** Threads the action actually applied to. */
  moved: number;
  /** Successful no-ops (the server's `skipped: true`). */
  skipped: number;
  failed: number;
  /** One line naming all three outcomes. */
  headline: string;
  /** One sentence per reason worth explaining, most actionable first. */
  notes: string[];
  /**
   * At least one note is fixed in the VIEWER'S OWN Settings -> Mail, so the
   * caller can link there. Since Phase 4.2 that is `no_target` alone:
   * `archived_account` can describe someone ELSE'S account (it outranks
   * not_owner in the skip precedence, so a shared or deal-linked thread's
   * skip can be about a mailbox the viewer cannot administer), and a link to
   * the viewer's own Settings would point at a page that cannot fix it.
   * no_target still qualifies -- the ownership drop runs before the refusal
   * check server-side (mail-move.ts), so a no_target is always about an
   * account the actor owns.
   */
  settingsLink: boolean;
}

/**
 * How each action reads in a past-tense summary, as a Record over the kind
 * enum -- the same reason REASON_NOTES below is one. The if-chain this
 * replaced ended `: "archived"`, so Phase 4.4's two new kinds would have
 * summarised a bulk unhide as "3 archived" with nothing failing to say so.
 *
 * `file` is a function rather than a string because its sentence names the
 * folder the user picked, which is the only part of it they chose.
 */
const PAST_VERBS: Record<BulkThreadActionKind, string | ((folder: string | null) => string)> = {
  trash: "moved to Trash",
  archive: "archived",
  hide: "hidden",
  unhide: "unhidden",
  file: (folder) => (folder === null ? "filed" : `filed into ${quoted(folder)}`),
};

function actionVerb(action: BulkThreadActionKind, targetFolder: string | null): string {
  const verb = PAST_VERBS[action];
  return typeof verb === "string" ? verb : verb(targetFolder);
}

/**
 * The folder an action targets, for the no_target note.
 *
 * ONLY EVER ASKED ABOUT trash/archive: no_target is the "this account's
 * Trash/Archive column is NULL" refusal, and the API cannot produce it for
 * `file` (which names its own destination -- an unusable one is
 * unknown_target) or for the CRM-side pair (which has no folder at all). The
 * fallback is therefore unreachable rather than a default, and says so.
 */
function actionTarget(action: BulkThreadActionKind): string {
  if (action === "trash") return "Trash";
  if (action === "archive") return "Archive";
  return "target";
}

/** At most this many distinct server refusal strings are shown, each trimmed to
 * MAX_REFUSAL_CHARS: the API already caps its free text, and one response can
 * carry fifty different sentences from a mail server having a bad day. */
const MAX_REFUSALS_SHOWN = 3;
const MAX_REFUSAL_CHARS = 120;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REFUSAL_CHARS ? trimmed : `${trimmed.slice(0, MAX_REFUSAL_CHARS)}\u2026`;
}

/** What a note builder may read besides its own count: the action (for the
 * target-folder name) and the distinct server refusal strings. */
interface BulkNoteContext {
  action: BulkThreadActionKind;
  refusals: readonly string[];
  /** `file`'s destination, for the notes that have to name it. */
  targetFolder: string | null;
  /** Which unit these results are about, for the two notes below whose
   * sentences name it (Phase 4.4 Task 2). */
  unit: BulkUnit;
}

/**
 * One entry PER SHARED REASON CODE, in display order (most actionable first),
 * each either a note builder or the deliberate `null` of "counted, never
 * explained".
 *
 * The Record over the shared enum is the point (the same pattern
 * mail-move.ts's SKIP_REASON_RANK uses): the previous shape was a
 * string-keyed count() map, on which a newly added reason fell through
 * SILENT with no compile nudge -- exactly how `not_owner` shipped from the
 * API with no copy here. Now a reason joining bulkThreadResultReasonSchema
 * is a type error on this table until someone decides its sentence, and
 * "quiet" has to be written down as a null rather than happening by
 * omission.
 *
 * What the entries say, and why:
 * - Every note keys off the reason CODE, never the free-text `error` -- the
 *   house rule for every error shape in this app (api.ts's ApiError doc
 *   comment). `error` is display text and appears in exactly one note,
 *   `server_refused`'s, where the mail server's own words are the only thing
 *   that could explain the refusal.
 * - no_sync names BOTH its causes: the code means "no running sync loop, not
 *   archived" (shared: bulkThreadFailureReasonSchema), which covers an
 *   account backing off from a failed connection AND one whose loop is
 *   stopped, paused, or in an error state a human has to clear.
 *   "Reconnecting" alone promised the second half a recovery that waiting
 *   will not bring.
 * - not_found says "could not be found", nothing more specific: since Phase
 *   4.2 it also legitimately describes a thread the viewer JUST SAW, whose
 *   account was flipped back to private mid-session -- the route answers
 *   byte-identically for nonexistent and invisible (the indistinguishable
 *   404), and this copy must not un-blur that line by claiming the thread
 *   was deleted.
 * - archived_account and not_owner may both describe someone ELSE'S mailbox
 *   (archived_account outranks not_owner in the skip precedence, so it wins
 *   on a shared account's archived rows), which is why neither says "your
 *   account" or points at Settings. not_owner's sentence is the spec's Move
 *   rights line, and it can follow an ENABLED Archive click: `ownedByViewer`
 *   is thread-global while moves are folder-scoped, so a thread owned
 *   elsewhere can still answer not_owner for the folder in view -- this note
 *   is that click's explanation, not just the disabled state's.
 * - already_in_target and out_of_scope are the deliberate quiet pair: both
 *   mean what was asked was already true of those threads, neither is
 *   fixable or worth a sentence, and both are still COUNTED so the headline
 *   stays honest ("Nothing archived, 2 skipped." must not read as "2
 *   archived.").
 */
const REASON_NOTES: Record<BulkThreadResultReason, ((count: number, context: BulkNoteContext) => string) | null> = {
  no_sync: (count) => `${count} could not be moved: that mail account is not syncing right now`
    + " \u2014 it may be reconnecting or paused.",
  no_target: (count, { action }) => `${count} could not be moved: no ${actionTarget(action)} folder is set`
    + " for that account yet.",
  // Names WHAT was refreshed, because the two surfaces refresh different
  // things: the thread list for a conversation, the open conversation for a
  // message (queries.ts invalidates each path's own keys). Telling someone
  // whose message vanished that "the list" was refreshed points them at a
  // pane they were not looking at.
  not_found: (count, { unit }) => `${count} could not be found \u2014 the`
    + `${unit === "message" ? " conversation" : " list"} has been refreshed.`,
  server_refused: (count, { refusals }) => {
    const shown = refusals.slice(0, MAX_REFUSALS_SHOWN).map(truncate).join("; ");
    return `${count} ${count === 1 ? "was" : "were"} refused by the mail server: ${shown}.`;
  },
  awaiting_reconciliation: (count) => `${count} will complete after the next sync pass.`,
  archived_account: (count) => `${count} ${count === 1 ? "belongs" : "belong"} to an archived mail account`
    + " \u2014 its mail can be moved again once its owner unarchives it.",
  not_owner: (count) => `${count} skipped: ${NOT_OWNER_EXPLANATION}.`,
  already_in_target: null,
  out_of_scope: null,
  // Phase 4.4. Deliberately NOT a Settings pointer, unlike no_target above:
  // the account simply has no folder by that name, and the remedies are to
  // pick a different one or to make it in the mail client -- neither of which
  // is in Conduit's Settings. It names the folder rather than the account
  // because a mixed selection can produce several, and the folder is the one
  // thing all of them have in common.
  unknown_target: (count, { targetFolder, unit }) => `${count} could not be filed: `
    + `${targetFolder === null ? "that folder" : quoted(targetFolder)}`
    + ` is not a folder on every selected ${unit}'s mail account.`,
};

/** What the summary needs from the REQUEST and the response envelope, as
 * opposed to from the per-thread results: the destination the user picked, and
 * the folder the server says it started syncing because of it. Both absent for
 * every action but `file`. */
export interface BulkSummaryOptions {
  targetFolder?: string | null;
  /** The response's own `syncEnabled` (shared: bulkThreadResultSchema). */
  syncEnabled?: string | null;
  /** What these results are about. Defaults to the thread surfaces, which are
   * every caller but the conversation's message bar. */
  unit?: BulkUnit;
}

/**
 * What to tell the user about one bulk response. Counting and copy both run
 * off REASON_NOTES above, which is where every per-reason decision lives.
 */
export function summarizeBulkResult(
  action: BulkThreadActionKind,
  results: readonly BulkResultItem[],
  options: BulkSummaryOptions = {},
): BulkActionSummary {
  const targetFolder = options.targetFolder ?? null;
  let moved = 0;
  let skipped = 0;
  let failed = 0;
  const byReason = new Map<BulkThreadResultReason, number>();
  const refusals: string[] = [];
  for (const result of results) {
    if (!result.ok) failed += 1;
    else if (result.skipped === true) skipped += 1;
    else moved += 1;
    if (result.reason === undefined) continue;
    byReason.set(result.reason, (byReason.get(result.reason) ?? 0) + 1);
    if (result.reason === "server_refused" && result.error !== undefined
      && !refusals.includes(result.error)) refusals.push(result.error);
  }

  const verb = actionVerb(action, targetFolder);
  const parts = [moved > 0 ? `${moved} ${verb}` : `Nothing ${verb}`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);

  const context: BulkNoteContext = {
    action, refusals, targetFolder, unit: options.unit ?? "conversation",
  };
  const notes: string[] = [];
  // THE SYNC NOTE COMES FIRST, before every per-reason note. It is the one
  // sentence here that describes a change to the app's ongoing behaviour
  // rather than to the threads just acted on: filing into a folder Conduit
  // was not syncing turns that sync ON (api: mail-move.ts), and the whole
  // reason the response carries the folder name is so this can be said
  // afterwards instead of being discovered from a bandwidth graph. Said, not
  // asked: a confirmation here would be the warning that ruling rejected.
  if (options.syncEnabled != null) {
    notes.push(`Conduit is now syncing ${quoted(options.syncEnabled)}.`);
  }
  // Insertion order of the table IS the display order.
  for (const [reason, note] of Object.entries(REASON_NOTES) as
    [BulkThreadResultReason, (typeof REASON_NOTES)[BulkThreadResultReason]][]) {
    const count = byReason.get(reason) ?? 0;
    if (count > 0 && note !== null) notes.push(note(count, context));
  }

  return {
    moved, skipped, failed,
    headline: `${parts.join(", ")}.`,
    notes,
    settingsLink: (byReason.get("no_target") ?? 0) > 0,
  };
}

/**
 * What a bulk call that never returned a body means.
 *
 * A 504 IS NOT A FAILURE (routes/mail.ts's bulk endpoint says so in as many
 * words): each queued MOVE runs on its account's serial sync loop, the deployed
 * nginx gives up on the RESPONSE after 300s, and the work carries on regardless
 * -- so the honest thing to show is that the outcome is unknown, and the honest
 * thing to do is refetch rather than retry (a blind retry would trash whatever
 * is now in the source folder). A network-level failure lands here too: the
 * request may well have been delivered, and nothing about the exception says
 * otherwise. Anything else -- a 400 over the cap, a 401 -- is a real refusal
 * and shows its own message.
 *
 * WHAT MUST NOT GET THIS COPY: a ResponseShapeError. That one is thrown AFTER a
 * 2xx, by this client's own schema parse (queries.ts's parseWith), so the
 * request plainly arrived and was answered -- "the request timed out" is a flat
 * untruth about it, and "the changes may still have applied" understates a bulk
 * action that certainly did apply. It is contract drift between this UI and the
 * API -- a bug on one side or the other -- and it says so in its own words.
 */
export const BULK_TIMEOUT_MESSAGE = "The request timed out \u2014 the changes may still have applied."
  + " The list has been refreshed.";

/** The statuses that mean "the ANSWER was lost", not "the action was refused":
 * the deployed nginx's own 504, and the 502/408 an intermediary can substitute
 * for it. */
const TIMEOUT_STATUSES = new Set([408, 502, 504]);

export function bulkErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return TIMEOUT_STATUSES.has(error.status) ? BULK_TIMEOUT_MESSAGE : error.message;
  }
  if (error instanceof ResponseShapeError) return error.message;
  return BULK_TIMEOUT_MESSAGE;
}

/**
 * Did a thread fetch answer "there is no such conversation for you"?
 *
 * The status test, in one place: the detail route's 404 is deliberately
 * indistinguishable across "never existed", "deleted" and -- since Phase 4.2
 * -- "its account went back to private while you had it open" (an open pane
 * lives on its cached bytes until its next refetch; the flip's SSE frame
 * carries no per-thread key, an accepted, documented window). The
 * conversation view branches here to show its calm "no longer available"
 * state instead of a raw error line, and branches on STATUS, not on message
 * text, per the house rule (api.ts's ApiError doc comment).
 */
export function isThreadGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** What the conversation pane says for a thread its fetch cannot see. One
 * sentence, no cause offered: the 404 is indistinguishable by design, and
 * copy that guessed at "deleted" or "unshared" would un-blur that line. */
export const THREAD_GONE_MESSAGE = "This conversation is no longer available.";

// ---------------------------------------------------------------------------
// Move targets (the Settings picker's Trash/Archive overrides)
// ---------------------------------------------------------------------------

/** The two columns the override fields write, as the account row carries them:
 * a stored folder name, or NULL for "nothing has been set or detected". */
export interface MoveTargetAccount {
  trashFolder: string | null;
  archiveFolder: string | null;
}

/** A PATCH body carrying only the fields that were actually edited. Absent is
 * not the same as null here: absent leaves the column alone, null clears it back
 * to "detect this for me". */
export interface MoveTargetPatch {
  trashFolder?: string | null;
  archiveFolder?: string | null;
}

/**
 * What to send when the Trash/Archive override fields are saved.
 *
 * `null` for a field means UNTOUCHED -- the user has not typed in it this
 * session -- and is the whole point of this function. The form used to seed both
 * fields from the account at mount and send both on every save, which quietly
 * destroyed data on a very ordinary sequence: open the picker on an account with
 * no Trash set, leave that field alone, type an Archive folder, save. Between
 * the mount and the save a discovery pass fills `trash_folder` from the server's
 * SPECIAL-USE attributes (api: mail-folders.ts's fillMoveTargets), the field is
 * still showing the empty string it was seeded with, and the save sends
 * `trashFolder: null` -- wiping a target the user never looked at, and with it
 * the account's ability to trash anything until the next pass.
 *
 * So: an untouched field is not in the patch at all. A touched one is trimmed;
 * blank means null ("detect for me"), which is a real edit and IS sent. A
 * touched field that ends up matching what the account already holds is dropped
 * too -- typing a character and deleting it again is not an edit, and the same
 * rule keeps the Save button honest about whether there is anything to save.
 */
export function moveTargetPatch(
  trash: string | null, archive: string | null, account: MoveTargetAccount,
): MoveTargetPatch {
  const patch: MoveTargetPatch = {};
  const edited = (draft: string | null, stored: string | null): string | null | undefined => {
    if (draft === null) return undefined;
    const next = draft.trim() === "" ? null : draft.trim();
    return next === stored ? undefined : next;
  };
  const nextTrash = edited(trash, account.trashFolder);
  if (nextTrash !== undefined) patch.trashFolder = nextTrash;
  const nextArchive = edited(archive, account.archiveFolder);
  if (nextArchive !== undefined) patch.archiveFolder = nextArchive;
  return patch;
}

/**
 * Is this message sitting in its own account's Trash folder -- the "in Trash"
 * chip in a conversation?
 *
 * Byte-exact, and per ACCOUNT: `Trash` on one account and `Trash` on another
 * are the same string but not the same mailbox, and only the owning account's
 * trash_folder decides. The map is built from the accounts the client can see
 * settings for, so a message on ANOTHER USER's account is never chipped: their
 * trash_folder is a setting this client is not served (mailAccountSummarySchema
 * carries id/label/email and nothing else). That is a missing chip, not a wrong
 * one.
 */
export function messageIsInTrash(
  message: { accountId: string; folder: string },
  trashByAccount: ReadonlyMap<string, string | null>,
): boolean {
  const trash = trashByAccount.get(message.accountId);
  return trash != null && trash === message.folder;
}
