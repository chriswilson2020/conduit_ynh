import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import type { MailAddress } from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  contacts, events, mailAccounts, mailAttachments, mailMessages, mailThreads,
  type MailMessageRow,
} from "../db/schema.js";
import { saveBlob } from "./blobs.js";
import { MailIngestError, NotFoundError } from "./errors.js";
import {
  capUtf8, extractAddresses, htmlToText, makeSnippet, normalizeSubject, sanitizeMailHtml,
  syntheticMessageId,
} from "./mail-content.js";
import { lockSiblingGroup } from "./pipelines.js";
import { publish } from "./sse.js";

/**
 * Ingest is the only writer of mail_messages/mail_threads/mail_attachments
 * during sync, and the only place threading and auto-linking happen. Its
 * contract (Phase 4 spec, "Threading & auto-linking" + "Sync engine"):
 * one transaction per message, idempotent under refetch, and never
 * overwriting a link a human set by hand.
 */

/**
 * Serialises thread resolution + message insert across the WHOLE database,
 * not per account. Threads are global (spec: a conversation two users are
 * both on is one thread), so two AccountSyncs -- different accounts,
 * possibly different users, ingesting two messages of the same
 * conversation at the same moment -- would otherwise both resolve "no
 * ancestor exists yet" and create two threads for one conversation, with
 * no unique constraint able to notice (there is nothing unique about a
 * thread to constrain). Folder cursors need no lock (each AccountSync
 * serialises its own account in-process); this is the one place mail needs
 * one.
 *
 * A single constant group, deliberately: a finer-grained key would have to
 * be derived from the very thread identity this section is still resolving
 * -- exactly the thing that is not known yet. Reuses lockSiblingGroup's
 * pg_advisory_xact_lock + hashtextextended mechanism (pipelines.ts) rather
 * than inventing a second advisory-lock convention; the key namespace is
 * disjoint from the "stages:..." sibling groups it was written for.
 *
 * What the lock actually spans, so the cost is not misread as trivial: two
 * or three indexed SELECTs (duplicate guard, ancestor lookup, contact
 * match), one blob write per attachment (filesystem I/O, unbounded in
 * count until MAX_ATTACHMENTS), a full sanitize-html parse of the body,
 * and the inserts/updates. Attachment I/O and sanitizing are the slow
 * parts, and at mail volumes -- a busy mailbox is a few messages a second
 * -- serialising them globally is still the right trade for getting one
 * conversation into one thread. If that ever stops being true, the fix is
 * to hoist parsing, blob writes and sanitizing ABOVE the transaction and
 * lock only from thread resolution onward; the property to preserve when
 * doing so is that the duplicate guard still runs before any blob is
 * written, so a refetch does not rewrite every attachment in the mailbox.
 *
 * Exported because ingest is not the only writer that resolves or creates
 * threads: mail-send (Task 6) inserts outbound messages and can start a
 * thread, and it must take THIS lock in its own transaction, or the split
 * this one prevents simply reappears between a send and the Sent-folder
 * sighting of the same message.
 */
export const INGEST_LOCK_KEY = "mail:ingest";

/**
 * Explicit column list for every mail_messages read and RETURNING in this
 * file. mail_messages.search is a generated tsvector duplicating
 * subject/body_text/from_addr/from_name -- selecting `*` would drag it
 * across the wire on every ingest for nothing.
 */
const messageColumns = {
  id: mailMessages.id,
  accountId: mailMessages.accountId,
  threadId: mailMessages.threadId,
  messageId: mailMessages.messageId,
  inReplyTo: mailMessages.inReplyTo,
  referencesIds: mailMessages.referencesIds,
  fromAddr: mailMessages.fromAddr,
  fromName: mailMessages.fromName,
  toAddrs: mailMessages.toAddrs,
  ccAddrs: mailMessages.ccAddrs,
  bccAddrs: mailMessages.bccAddrs,
  subject: mailMessages.subject,
  bodyText: mailMessages.bodyText,
  bodyHtml: mailMessages.bodyHtml,
  snippet: mailMessages.snippet,
  sentAt: mailMessages.sentAt,
  folder: mailMessages.folder,
  imapUid: mailMessages.imapUid,
  seen: mailMessages.seen,
  direction: mailMessages.direction,
  createdAt: mailMessages.createdAt,
  updatedAt: mailMessages.updatedAt,
};

/** A mail_messages row minus the generated `search` column (see messageColumns). */
export type IngestedMessage = Omit<MailMessageRow, "search">;

/** The four thread link columns, as mail-send's compose dialog supplies them. */
export interface IngestMessageLinks {
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  projectId?: string | null;
}

export interface IngestMessageInput {
  accountId: string;
  /** IMAP folder this sighting came from (INBOX, the account's sent_folder, ...). */
  folder: string;
  /** IMAP UID within that folder; null for a message not (yet) on the server. */
  uid: number | null;
  raw: Buffer | string;
  /** IMAP flags as fetched, e.g. ["\\Seen", "\\Answered"]. */
  flags: string[];
  /**
   * Thread this message onto an existing thread instead of resolving one
   * from its headers -- mail-send (Task 6) replying into a known thread,
   * where the CRM's own thread identity beats whatever the outgoing
   * References chain would resolve to. Validated to exist; short-circuits
   * thread resolution entirely.
   */
  threadId?: string;
  /**
   * Record links to stamp on a thread this call CREATES (mail-send's
   * compose dialog opened from a contact/company/deal/project page).
   * Ignored when the message joins an existing thread -- that thread's
   * links are already whatever auto-linking or a human made them, and a
   * compose seed must not rewrite them. A contactId here also suppresses
   * auto-linking, by the same "already linked, leave it alone" rule that
   * protects manual links.
   */
  links?: IngestMessageLinks;
  /**
   * The Bcc list to store INSTEAD of whatever the raw bytes carry, for a
   * message this system just sent (mail-send).
   *
   * It exists because those two are not the same list and cannot be. A
   * composed message's Bcc header is deliberately absent from the bytes that
   * go out -- that is what makes a blind copy blind -- and mail-send stores
   * the exact bytes it submitted, so without this the CRM's own record of a
   * message it sent could never name its Bcc recipients, while a copy saved
   * by any ordinary mail client (which keeps the header in its Sent folder)
   * could.
   *
   * A REPLACEMENT, not an addition, and applied INSIDE the existing
   * outbound-and-in-the-account's-own-sent-folder gate below -- so it changes
   * what a trusted local send stores and nothing else. Inbound mail spoofing
   * the account's own address into the INBOX still stores no Bcc at all,
   * because that gate, not this field, is what decides whether a Bcc may be
   * kept.
   */
  bccOverride?: MailAddress[];
}

export interface IngestResult {
  /** false when this message was already stored: a refetch or second-folder sighting. */
  created: boolean;
  message: IngestedMessage;
  threadId: string;
}

// --- Caps on attacker-controlled fields ------------------------------------
//
// Everything ingest stores comes off the wire, so every stored field needs a
// bound; without them a single crafted message is a stored-data bomb. Two
// hard limits sit behind these numbers. mail_messages.search is a generated
// tsvector over subject + body_text + from_addr + from_name, and Postgres
// refuses a tsvector over 1MB -- the INSERT itself fails, so an uncapped
// body wedges the message permanently (measured: ~850KB of subject+body is
// already enough). And message_id is indexed by a btree, whose per-row limit
// is about 2704 bytes -- a 3000-byte Message-ID makes the INSERT fail on the
// index, not the column. The caps below sum to roughly 262KB of tsvector
// input, comfortably clear of both.
//
// Truncation is deterministic (a pure function of the bytes), so a refetch
// of the same message produces the same stored values and the duplicate
// guard still converges.
const MAX_BODY_TEXT_BYTES = 256 * 1024;
const MAX_SUBJECT_BYTES = 4 * 1024;
// RFC 5322's line-length limit: no legitimate display name or address is
// longer, and both feed the tsvector.
const MAX_HEADER_FIELD_BYTES = 998;
// Past this a Message-ID is hashed rather than truncated -- see
// normalizeMessageId. Same 998-byte reasoning; the btree limit is the hard
// constraint underneath it.
const MAX_MESSAGE_ID_BYTES = 998;
// Bound on both the stored to/cc address arrays and the participant list
// auto-linking scans. Under MAX_HEADER_BYTES a To: header still reaches
// ~2900 addresses (at ~22 bytes each): as a jsonb column that is a
// permanent tens-of-KB row per message that no view can render, and as a
// participant list it is 2900 bind parameters plus a scan running inside
// the global ingest lock. No real message addresses 200 people directly.
// Deliberately independent of the header cap -- if that ever moves, this
// stays bounded on its own terms.
const MAX_PARTICIPANTS = 200;
// Attachments are streamed to blob storage and never rewritten, so an
// unbounded message is unbounded disk. 50 attachments is far past any real
// message. The 50MB per-attachment bound (matching routes/index.ts's
// deliberate-upload limit and mail-send.ts's MAX_FORWARD_ATTACHMENT_BYTES --
// one ceiling, three spellings, change together) is belt and braces rather
// than a live limit: a message is already capped at MAX_RAW_BYTES, and
// base64 costs 4/3, so no
// single attachment reaching this code can exceed ~19.6MB today. It is
// kept because the attachment path should stay bounded on its own terms --
// raising the raw cap, or a future non-IMAP caller, must not silently make
// attachment size unbounded. Both are skip-and-continue, not reject: the
// MESSAGE still ingests (its text is what the CRM is really after), minus
// the offending parts.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 50;
// Whole-message bound: what it really limits is MEMORY and DISK -- the
// buffer handed to simpleParser, the decoded parts it materialises, and the
// blob bytes written from them. It is not a parse-time guard; a message
// far under it can still be pathological (see MAX_HEADER_BYTES).
const MAX_RAW_BYTES = 25 * 1024 * 1024;
// Header-block bound, and THIS is the parse-time guard. mailparser's
// address parsing is superlinear in the number of addresses on a header,
// and the header block is a rounding error against MAX_RAW_BYTES, so the
// whole-message cap does not constrain it at all: measured, 60k addresses
// (a 709KB header, 2.7% of the raw cap) took 6.1s, and ~150k addresses
// (still under 5% of the raw cap) stalled simpleParser for over 8 minutes
// -- blocking the entire event loop, not just the sync loop, since that
// parse never yields. 64KB is still an order of magnitude above any real
// header block (a heavily forwarded thread with full References and DKIM
// signatures is single-digit KB), and it is what keeps the worst case
// SUB-SECOND: at 256KB, the cap this started at, a header packed with
// minimal addresses measured 7.2s of blocked event loop -- under the cap
// and therefore accepted, which is exactly the outcome the guard exists to
// prevent. The bound has to sit where the superlinear curve is still flat,
// not merely where real mail stops.
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Byte length of the message's header block -- everything before the first
 * blank line -- or null when it is longer than `limit`.
 *
 * Only the first `limit + 4` bytes are searched, so a hostile message costs
 * one bounded scan rather than a walk over 25MB: if no blank line appears in
 * that window, the header block is over the limit by definition. A message
 * with no blank line at all is all headers, and passes only if the whole
 * thing fits in the limit. Both CRLF CRLF and bare LF LF count as the
 * terminator -- IMAP delivers CRLF, but fixtures, tests and some tools use
 * LF, and treating an LF-terminated message as "one giant header" would
 * reject perfectly good mail.
 */
function headerBlockBytes(raw: Buffer, limit: number): number | null {
  const window = raw.subarray(0, Math.min(raw.length, limit + 4));
  let end = -1;
  for (const terminator of ["\r\n\r\n", "\n\n"]) {
    const at = window.indexOf(terminator, 0, "utf8");
    if (at >= 0 && (end === -1 || at < end)) end = at;
  }
  if (end >= 0) return end;
  return raw.length <= limit ? raw.length : null;
}

/** RFC 5322 ids arrive wrapped in angle brackets; everything here stores and
 * compares them bare, so the references walk can match message_id directly. */
function stripBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const bare = stripBrackets(value);
  return bare.length > 0 ? bare : null;
}

/**
 * A Message-ID as stored and compared. One past MAX_MESSAGE_ID_BYTES is
 * replaced by a hash of the WHOLE id rather than truncated: truncation maps
 * every long id sharing a prefix onto one stored value, silently merging
 * distinct messages into one row and one thread -- exactly the failure
 * threading exists to avoid. A hash keeps them apart, and being a pure
 * function of the full id it still reproduces the same value on every
 * refetch. The "sha256:" shape matches syntheticMessageId's on purpose:
 * both mean "this id is derived, not the literal header".
 *
 * Applied to in_reply_to and every References entry too, not just the
 * message's own id -- an ancestor stored under its hashed id is only
 * findable if the walk hashes the same way.
 */
function normalizeMessageId(value: string | undefined): string | null {
  const id = normalizeId(value);
  if (id === null) return null;
  if (Buffer.byteLength(id, "utf8") <= MAX_MESSAGE_ID_BYTES) return id;
  return `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

// Hard cap on how much of a References header is kept, in the same spirit
// as normalizeSubject's 1000-char cap: this is attacker-controlled input.
// Uncapped, every id becomes a bind parameter in resolveThreadId's ancestor
// lookup and a member of its dedupe scan (which is quadratic in the list
// length), so one crafted message could stall the event loop and its folder
// cursor with it -- and under Task 5's sync loop a message that always
// stalls or throws flips the whole account to status=error.
//
// Measured against mailparser 3.9.15: the parser drops a References header
// entirely at exactly 1 MiB, and below that the id COUNT is bounded only by
// those bytes -- 100,000 short ids were delivered in one header -- so the
// parser is no protection here. MAX_HEADER_BYTES now bounds the header
// block first, which brings the reachable worst case down to roughly 6500
// short ids (64KB at ~10 bytes each): well under the driver's 65535
// bind-parameter ceiling, but still thousands of parameters and a
// quadratic dedupe scan per message. The two caps are deliberately
// independent -- this one keeps the lookup at 50 ids whatever the header
// cap becomes.
//
// The LAST 50 are kept because the walk is right-to-left: the nearest
// ancestors, the only ones threading actually consults, live at the end. A
// real chain reaching 50 deep already threads through its nearest ancestor
// long before the far end matters.
const MAX_REFERENCES = 50;

/** mailparser gives `references` as a string for a single id and an array for
 * several; normalise to a bare-id array (oversized ids hashed, see
 * normalizeMessageId), order preserved (oldest first), capped to the newest
 * MAX_REFERENCES entries. */
function normalizeReferences(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    const id = normalizeMessageId(entry);
    if (id !== null) out.push(id);
  }
  return out.slice(-MAX_REFERENCES);
}

/** One caller-supplied address in the shape this file stores: address folded
 * to lowercase (so it matches the parsed lists and the contact lookups that
 * compare against them), name absent-as-null rather than absent-as-missing.
 * Mirrors mail-content.ts's flattenAddressObject, which does the same to
 * addresses coming off the wire. */
function normalizeAddress(address: MailAddress): { address: string; name: string | null } {
  const name = address.name ?? null;
  return {
    address: address.address.toLowerCase(),
    name: name !== null && name.length > 0 ? name : null,
  };
}

/** IMAP system flags are case-insensitive (RFC 3501), so compare folded. */
function hasSeenFlag(flags: string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === "\\seen");
}

interface PreparedAttachment {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  contentId: string | null;
  isInline: boolean;
}

/**
 * Write attachment payloads to blob storage and mint the ids the cid
 * rewrite needs. Called before the message insert on purpose: sanitizing
 * body_html rewrites `cid:` references to `mailattachment:<attachment id>`
 * placeholders, so those ids have to be decided BEFORE the HTML is
 * sanitized -- and the attachment ROWS cannot be inserted before the
 * message row they reference exists. Minting the ids here (rather than
 * letting the database default them) is what lets the three steps happen
 * in the only order that satisfies both constraints.
 *
 * Blob files are written inside the transaction's scope but are not part
 * of it: if the transaction later rolls back, the bytes on disk are
 * orphaned. That is accepted (an unreferenced content-addressed file under
 * $data_dir/files, invisible to the app and re-created identically on the
 * next ingest attempt) rather than adding a two-phase cleanup -- it
 * matches this codebase's archive-not-delete posture, and the alternative
 * risks deleting a blob another row legitimately shares.
 */
async function prepareAttachments(
  dataDir: string, parsed: ParsedMail, context: { accountId: string; folder: string; uid: number | null },
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const attachment of parsed.attachments) {
    const content: Buffer = attachment.content;
    // Both guards SKIP the part and keep ingesting the message: the body
    // text is what the CRM is really after, and dropping a whole
    // conversation because one part is absurd is the worse failure. Logged
    // (not silent) so an operator can see why a chip is missing.
    if (prepared.length >= MAX_ATTACHMENTS) {
      console.warn(
        "mail-ingest: attachment limit reached, skipping the rest",
        { ...context, limit: MAX_ATTACHMENTS, filename: attachmentFilename(attachment) },
      );
      break;
    }
    if (content.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        "mail-ingest: attachment exceeds the size limit, skipping it",
        { ...context, limit: MAX_ATTACHMENT_BYTES, bytes: content.length, filename: attachmentFilename(attachment) },
      );
      continue;
    }
    // Readable.from does NOT iterate a Buffer byte by byte (documented
    // special case), so this streams the payload as a single chunk.
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from(content));
    prepared.push({
      id: randomUUID(),
      filename: attachmentFilename(attachment),
      mime: attachment.contentType.length > 0 ? attachment.contentType : "application/octet-stream",
      sizeBytes,
      // The blobs-service key (files/<sha256> under $data_dir), never an
      // absolute path: stored rows must survive a data_dir move or a
      // YunoHost change_url, exactly like the files table's sha256 column.
      blobPath: sha256,
      contentId: attachment.cid !== undefined && attachment.cid.length > 0 ? attachment.cid : null,
      // `related` is mailparser's own "this part belongs to a
      // multipart/related body" signal -- true for inline images whose
      // sender omitted Content-Disposition (common), which the
      // disposition check alone would miss.
      isInline: attachment.contentDisposition === "inline" || attachment.related === true,
    });
  }
  return prepared;
}

function attachmentFilename(attachment: Attachment): string {
  const name = attachment.filename;
  return name !== undefined && name.trim().length > 0 ? name : "attachment";
}

/**
 * Resolve the thread this message belongs to, or null to start a new one.
 * Runs under INGEST_LOCK_KEY, so no concurrent ingest can insert a message
 * between these reads and this transaction's own insert.
 */
async function resolveThreadId(
  tx: Database, messageId: string, references: string[], inReplyTo: string | null,
): Promise<string | null> {
  // Step 0 (before the references walk): has this exact message already
  // been ingested under ANOTHER account? Two accounts on the same mailbox,
  // or both sides of one conversation living in this CRM, must converge on
  // one global thread -- including for a thread-STARTER, which has no
  // references to walk at all and would otherwise get one thread per
  // account. (The same account is impossible here: the duplicate guard in
  // ingestMessage already returned for that case.) The assumption is RFC
  // 5322 Message-ID uniqueness -- two genuinely unrelated messages sharing
  // one id would merge into a single thread, but that same assumption is
  // what the entire references-graph model rests on already.
  const [twin] = await tx.select({ threadId: mailMessages.threadId })
    .from(mailMessages).where(eq(mailMessages.messageId, messageId))
    .orderBy(asc(mailMessages.createdAt), asc(mailMessages.id)).limit(1);
  if (twin !== undefined) return twin.threadId;

  // References walked right-to-left (nearest ancestor first), then
  // in_reply_to. No subject fallback, ever (spec): "Invoice" from two
  // unrelated senders must never merge.
  const candidates: string[] = [];
  for (let i = references.length - 1; i >= 0; i -= 1) {
    const id = references[i];
    if (id !== undefined && !candidates.includes(id)) candidates.push(id);
  }
  if (inReplyTo !== null && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);
  if (candidates.length === 0) return null;

  // One batched lookup for the whole chain (mail_messages_message_id_idx),
  // then the right-to-left preference is applied in JS -- a per-id query
  // loop would issue up to one round trip per ancestor for no gain.
  const rows = await tx.select({ messageId: mailMessages.messageId, threadId: mailMessages.threadId })
    .from(mailMessages).where(inArray(mailMessages.messageId, candidates))
    .orderBy(asc(mailMessages.createdAt), asc(mailMessages.id));
  if (rows.length === 0) return null;
  const byMessageId = new Map<string, string>();
  // Oldest row wins for a given id (the ORDER BY above): only reachable if
  // the same Message-ID somehow sits in two threads already, which step 0
  // exists to prevent going forward.
  for (const row of rows) {
    if (!byMessageId.has(row.messageId)) byMessageId.set(row.messageId, row.threadId);
  }
  for (const candidate of candidates) {
    const threadId = byMessageId.get(candidate);
    if (threadId !== undefined) return threadId;
  }
  return null;
}

/**
 * Auto-link a thread to a contact (and that contact's company) from the
 * message's participants. Spec: runs when a thread is created and again
 * whenever a thread with a NULL contact_id gains a message; the first
 * participant match in from -> to -> cc order wins; manual links are never
 * overwritten; no domain matching.
 */
async function autoLinkThread(tx: Database, threadId: string, participants: string[]): Promise<void> {
  if (participants.length === 0) return;
  const [thread] = await tx.select({ contactId: mailThreads.contactId })
    .from(mailThreads).where(eq(mailThreads.id, threadId));
  // contact_id set (by an earlier auto-link or by hand) => leave it alone.
  if (thread === undefined || thread.contactId !== null) return;

  // Exact-address match, case-folded on both sides: participants arrive
  // lowercased from extractAddresses, while contacts.emails keeps whatever
  // casing the CRM user typed. Matching by lower() is the same
  // case-insensitive treatment contacts.ts's own email search applies, and
  // is still an exact ADDRESS match -- no domain or prefix matching (spec:
  // "gmail.com would link half the world").
  const candidates = await tx.select({
    id: contacts.id, companyId: contacts.companyId, emails: contacts.emails,
  }).from(contacts)
    .where(and(
      isNull(contacts.archivedAt),
      // sql.join rather than interpolating the array directly: drizzle
      // expands a JS array inside a sql`` fragment into a parenthesised
      // parameter LIST, not an array parameter, so `= ANY(${participants})`
      // binds a record and Postgres refuses to cast it. An explicit IN
      // list says what is actually happening.
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE lower(e) IN (${
        sql.join(participants.map((address) => sql`${address}`), sql`, `)
      }))`,
    ))
    // Deterministic tie-break when two contacts share an address: the
    // older row wins, rather than whatever order the planner returns.
    .orderBy(asc(contacts.createdAt), asc(contacts.id));
  if (candidates.length === 0) return;

  const folded = candidates.map((contact) => ({
    id: contact.id,
    companyId: contact.companyId,
    emails: new Set(contact.emails.map((email) => email.toLowerCase())),
  }));
  for (const participant of participants) {
    const hit = folded.find((contact) => contact.emails.has(participant));
    if (hit === undefined) continue;
    await tx.update(mailThreads)
      .set({
        contactId: hit.id,
        // company_id is touched only when the matched contact HAS a
        // company (otherwise the key is absent from the SET clause
        // entirely), and even then only via COALESCE rather than a value
        // read earlier in this function: filling it only when NULL has to
        // happen in SQL, or a manual company link set concurrently (routes
        // take no ingest lock) could be clobbered by a stale read.
        ...(hit.companyId === null
          ? {}
          : { companyId: sql`COALESCE(${mailThreads.companyId}, ${hit.companyId}::uuid)` }),
        updatedAt: new Date(),
      })
      // Same defence for contact_id: the update applies only if the thread
      // is STILL unlinked, so a manual link that landed between the read
      // above and here survives.
      .where(and(eq(mailThreads.id, threadId), isNull(mailThreads.contactId)));
    return;
  }
}

/**
 * The thread's timeline entry for this message: `mail_received` inbound,
 * `mail_sent` outbound (Phase 5 spec, "Mail in the timeline").
 *
 * A POINTER AND NOTHING ELSE. The row carries the thread's four record FKs
 * -- which timeline it belongs on -- plus mail_thread_id, and an EMPTY
 * payload. No subject, no snippet, no address, no participant name goes in,
 * here or anywhere else on the row: an event is readable by every user of
 * the CRM, while a thread is readable only by whoever Phase 4.2's visibility
 * rules and Phase 4.3's hides admit. Anything stored here would be a copy of
 * private mail sitting outside both. The subject a client shows is derived at
 * READ time, under those same predicates, by services/timeline.ts.
 * mail-ingest.test.ts asserts the stored payload's KEY SET, so adding a field
 * to this insert fails a test rather than shipping a leak.
 *
 * ONE EVENT PER (THREAD, VERB) PER CALENDAR DAY, IN UTC -- said explicitly
 * because the boundary is the server's `now() AT TIME ZONE 'UTC'`, not the
 * viewer's local midnight, so a late-evening exchange in a western timezone
 * can straddle two entries and an early-morning one in an eastern timezone
 * can share a day with the previous evening. That is the accepted cost of a
 * boundary that does not depend on who is looking. Without the throttle a
 * fifty-message thread would bury a record's whole timeline; the Mail tab
 * remains the place to read every message.
 *
 * The throttle is an existence check followed by an insert, with no unique
 * constraint behind it, and it is safe because every caller reaches here
 * holding INGEST_LOCK_KEY (taken at the top of the transaction, and the same
 * lock mail-send's own ingest takes): no second writer can insert between the
 * check and the insert. A constraint could not express the rule anyway --
 * "same UTC day" is not a column.
 *
 * COST OF THAT CHECK, AND THE INDEX THIS DELIBERATELY DOES NOT SHIP.
 * `events` carries no index on mail_thread_id, so the check is a scan of the
 * whole table, once per ingested message, INSIDE the global ingest lock.
 * MEASURED (300,000 events of which 30,000 carry mail_thread_id, warm,
 * top-level Execution Time): 35ms / 4,077 buffers as a parallel sequential
 * scan; 0.14ms / 17 buffers with a candidate
 * `CREATE INDEX events_mail_thread_id_idx ON events (mail_thread_id) WHERE
 * mail_thread_id IS NOT NULL` (288 kB against a 32 MB table, and it leaves
 * every read plan in services/timeline.ts unchanged -- 55ms and 38ms against
 * 56ms and 35ms without it, all within run-to-run noise). This deployment
 * holds thousands of events, where the same scan is sub-millisecond, and the
 * index is not this task's to add. RE-MEASURE TRIGGER, IN EVENTS ROWS because
 * that is what this scan is over: on the order of 100k events -- roughly 12ms
 * per message by linear extrapolation, which is the point at which one
 * mailbox's sync starts holding the global lock long enough to be felt by
 * another account's. That is ten times sooner than the ~1M-row trigger
 * drizzle/0008 records for the read side, because this cost is per MESSAGE
 * and serialised, not per page request.
 *
 * A THREAD WITH NO RECORD LINKS EMITS NOTHING. There is no timeline for the
 * entry to appear on: every listEvents filter is one of the four record FKs,
 * so a row with all four null is unreachable, and writing it would only add
 * rows to the fastest-growing table in the schema. The check runs AFTER
 * auto-linking, so a thread that has just acquired its contact/company link
 * from this very message does emit.
 *
 * The actor is the OWNER OF THE ACCOUNT the message arrived on, which is the
 * closest thing a machine-generated row has to a person. It is not a leak in
 * its own right: the row reaches nobody who cannot already see the thread.
 *
 * KNOWN LIMITATION, shared with every other event row (the Task 2 DONE
 * block's D6): record links are a SNAPSHOT at emission. Linking a thread to a
 * deal later does not move mail entries already written onto that deal's
 * timeline -- only entries from that point on. Append-only history; a fix
 * would mean rewriting it.
 *
 * AND ONE THE THROTTLE ADDS TO IT (spec review, O3): the two rules interact.
 * If a thread gains a deal link AFTER that day's entry was emitted, the rest
 * of the day's messages are throttled away, so the newly-linked record's
 * timeline shows nothing of that conversation until the next UTC day. That
 * follows from the throttle exactly as specified -- the alternative is
 * re-emitting on every link change, which would double entries on the
 * timelines that already had them -- and it is a delay of at most a day on a
 * record that has just been linked, not a permanent gap.
 */
async function emitMailEvent(
  tx: Database, threadId: string, direction: "inbound" | "outbound", actorUserId: string,
): Promise<boolean> {
  const verb = direction === "outbound" ? "mail_sent" : "mail_received";
  // Re-read rather than reuse anything held from earlier in the transaction:
  // autoLinkThread may have just written contact_id/company_id, and on an
  // existing thread the links are whatever a human or an earlier ingest made
  // them.
  const [thread] = await tx.select({
    companyId: mailThreads.companyId, contactId: mailThreads.contactId,
    dealId: mailThreads.dealId, projectId: mailThreads.projectId,
  }).from(mailThreads).where(eq(mailThreads.id, threadId));
  if (thread === undefined) return false;
  if (thread.companyId === null && thread.contactId === null
    && thread.dealId === null && thread.projectId === null) return false;

  // The day boundary is computed in SQL, from the same `now()` the inserted
  // row's created_at default takes (both are the transaction's start time),
  // so the window this checks and the timestamp it writes cannot disagree
  // across a midnight or an app/database clock skew. Written as a range over
  // the bare column rather than as a cast of it -- `(created_at AT TIME ZONE
  // 'UTC')::date = ...` says the same thing but puts the comparison out of
  // reach of any index on this column, and `events` is the table most likely
  // to gain one.
  const [already] = await tx.select({ id: events.id }).from(events).where(and(
    eq(events.mailThreadId, threadId),
    eq(events.verb, verb),
    gte(events.createdAt, sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`),
  )).limit(1);
  if (already !== undefined) return false;

  await tx.insert(events).values({
    verb, actorUserId,
    companyId: thread.companyId, contactId: thread.contactId,
    dealId: thread.dealId, projectId: thread.projectId,
    mailThreadId: threadId,
    // Empty, and stated rather than left to the column default so the rule is
    // visible at the one place it could ever be broken. See this function's
    // header: nothing about the mail may be stored on this row.
    payload: {},
  });
  return true;
}

/**
 * Ingest one raw message into the CRM: parse, thread, store attachments,
 * insert, bump the thread, auto-link -- in one transaction, idempotent per
 * (account, message id).
 *
 * `dataDir` is threaded through as a parameter (never read from config
 * here), matching blobs.ts/files.ts: the service stays a pure function of
 * its inputs and tests point it at a temp dir. The account's own email
 * address -- needed for direction detection -- is read from the database
 * INSIDE the transaction rather than accepted as a parameter: it makes the
 * account's existence part of the same atomic unit as the write, and keeps
 * callers (Task 5's AccountSync, which holds a possibly-stale account row
 * in memory for the lifetime of its loop) from feeding in an address the
 * user has since changed.
 *
 * This is the ONLY writer of mail_messages/mail_threads/mail_attachments,
 * by design -- mail-send (Task 6) does not grow its own insert path, it
 * calls this function after SMTP and the IMAP APPEND have succeeded, with
 * folder = the account's sent_folder, the raw MIME it just sent, flags
 * ["\\Seen"], `threadId` when replying and `links` when the compose dialog
 * seeded a record. Everything that makes the row correct (direction,
 * threading, dedupe against the Sent-folder sighting that arrives later,
 * auto-linking, the SSE hint) then happens in exactly one place. None of
 * the internals are exported to support that: a second writer reproducing
 * half of this is how the invariants rot.
 *
 * Every failure escapes as MailIngestError, carrying account/folder/uid and
 * the original on `cause` (see errors.ts) -- Task 5's poison-message
 * contract is written against that type.
 */
export async function ingestMessage(
  db: Database, dataDir: string, input: IngestMessageInput,
): Promise<IngestResult> {
  try {
    return await ingestParsedMessage(db, dataDir, input);
  } catch (error) {
    // One typed error out of this function, carrying the coordinates Task
    // 5's poison-message contract needs (account, folder, uid). The
    // original is preserved on `cause` -- nothing here decides that a
    // failure is fatal, it only makes it actionable.
    if (error instanceof MailIngestError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailIngestError(
      { accountId: input.accountId, folder: input.folder, uid: input.uid },
      reason,
      { cause: error },
    );
  }
}

async function ingestParsedMessage(
  db: Database, dataDir: string, input: IngestMessageInput,
): Promise<IngestResult> {
  const context = { accountId: input.accountId, folder: input.folder, uid: input.uid };
  // Two guards, before simpleParser, bounding two different costs. Task 5
  // treats either MailIngestError as a poison message: retry once, then
  // skip the UID rather than let one message wedge the mailbox.
  //
  // First, the whole message -- memory and disk (the parse buffer, the
  // decoded parts, the blob writes).
  const rawBytes = typeof input.raw === "string" ? Buffer.byteLength(input.raw, "utf8") : input.raw.length;
  if (rawBytes > MAX_RAW_BYTES) {
    throw new MailIngestError(context, `raw message of ${rawBytes} bytes exceeds the ${MAX_RAW_BYTES}-byte limit`);
  }

  // Second, the header block -- parse TIME, which the cap above does not
  // constrain: mailparser's address parsing is superlinear in address
  // count, and a 709KB header (2.7% of the raw cap) already measured 6.1s
  // while ~150k addresses stalled the event loop for over 8 minutes. This
  // is the bound that keeps a 1MB message from being a denial of service.
  const rawBuffer = typeof input.raw === "string" ? Buffer.from(input.raw, "utf8") : input.raw;
  const headerBytes = headerBlockBytes(rawBuffer, MAX_HEADER_BYTES);
  if (headerBytes === null) {
    throw new MailIngestError(context, `header block exceeds the ${MAX_HEADER_BYTES}-byte limit`);
  }

  // Parsed BEFORE the transaction opens: parsing touches no database state
  // and can be slow for a large multipart message, and every millisecond
  // inside the transaction is a millisecond the global ingest lock is held
  // against every other account's sync.
  //
  // skipImageLinks is essential, not an optimisation: simpleParser's
  // default rewrites every `cid:` img src into a base64 data: URI, which
  // would (a) defeat the cid -> attachment placeholder rewrite entirely
  // and (b) get dropped by the sanitizer's img scheme allowlist, silently
  // losing every inline image.
  const parsed = await simpleParser(rawBuffer, { skipImageLinks: true });

  const addresses = extractAddresses(parsed);
  const messageId = normalizeMessageId(parsed.messageId) ?? syntheticMessageId(parsed);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const references = normalizeReferences(parsed.references);
  const seen = hasSeenFlag(input.flags);
  const rawSubject = parsed.subject ?? "";
  // No Date header: stamp the sighting time rather than the epoch, so a
  // dateless message sorts as "just arrived" instead of sinking to 1970.
  // (syntheticMessageId keeps its own epoch fallback -- that one must be
  // stable across refetches, and this one deliberately is not stored twice
  // anyway: a refetch takes the duplicate path and never rewrites sent_at.)
  const sentAt = parsed.date ?? new Date();

  const result = await db.transaction(async (tx) => {
    // Read BEFORE the lock: an unknown account is the one failure that
    // needs no serialisation at all, and making it wait behind every other
    // account's ingest just to be told the row is gone is pure contention.
    const [account] = await tx.select({
      id: mailAccounts.id, email: mailAccounts.email, sentFolder: mailAccounts.sentFolder,
      // The actor on this message's timeline entry (emitMailEvent).
      userId: mailAccounts.userId,
    }).from(mailAccounts).where(eq(mailAccounts.id, input.accountId));
    if (account === undefined) throw new NotFoundError("mail account", input.accountId);

    // Taken ahead of the duplicate guard, not merely around
    // thread-resolution+insert -- so the guard's SELECT and this
    // transaction's INSERT are atomic with respect to every other ingest
    // too. That way a same-account double sighting (which AccountSync's
    // in-process serialisation should already prevent) still takes the
    // clean duplicate path instead of colliding on the UNIQUE constraint.
    // The cost is that a whole-folder refetch serialises against other
    // accounts' ingests, which at mail volumes is nothing next to getting
    // one conversation into one thread.
    await lockSiblingGroup(tx, INGEST_LOCK_KEY);

    // --- Duplicate guard -------------------------------------------------
    // A refetch (UIDVALIDITY reset) or a second-folder sighting must update
    // only where the message was last seen and whether it is read -- never
    // duplicate the row, re-thread it, re-store its attachments or re-run
    // auto-linking. Everything below this block is new-message-only work.
    // folder/imap_uid therefore mean "where this message was last seen",
    // not "every folder it is in": a message copied across folders makes
    // them churn as each folder's pass sees it. That is by design, and
    // bounded -- each folder is walked once per pass by Task 5's cursors,
    // so the churn is per-pass, not a loop.
    const [existing] = await tx.select(messageColumns).from(mailMessages)
      .where(and(eq(mailMessages.accountId, input.accountId), eq(mailMessages.messageId, messageId)));
    if (existing !== undefined) {
      const changed = existing.folder !== input.folder
        || existing.imapUid !== input.uid
        || existing.seen !== seen;
      if (!changed) return { created: false, message: existing, threadId: existing.threadId, changed, timelineEntry: false };
      const [updated] = await tx.update(mailMessages)
        .set({ folder: input.folder, imapUid: input.uid, seen, updatedAt: new Date() })
        .where(eq(mailMessages.id, existing.id)).returning(messageColumns);
      if (updated === undefined) throw new Error("mail message update returned no row");
      return { created: false, message: updated, threadId: updated.threadId, changed, timelineEntry: false };
    }

    // --- Thread resolution ----------------------------------------------
    // An explicit threadId (mail-send replying) wins over the header walk:
    // the CRM already knows which conversation this belongs to. Validated
    // rather than trusted -- a stale thread id would otherwise violate the
    // FK at insert time with a far less useful error.
    let threadId: string | null;
    if (input.threadId !== undefined) {
      const [thread] = await tx.select({ id: mailThreads.id })
        .from(mailThreads).where(eq(mailThreads.id, input.threadId));
      if (thread === undefined) throw new NotFoundError("mail thread", input.threadId);
      threadId = thread.id;
    } else {
      threadId = await resolveThreadId(tx, messageId, references, inReplyTo);
    }
    if (threadId === null) {
      const [thread] = await tx.insert(mailThreads).values({
        // Normalized once, from the first message of the thread (spec):
        // later "Re:" replies never rewrite it.
        subject: normalizeSubject(rawSubject),
        lastMessageAt: sentAt,
        // Compose-dialog seeds, applied only here -- on a thread this call
        // creates. Joining an existing thread never rewrites its links.
        companyId: input.links?.companyId ?? null,
        contactId: input.links?.contactId ?? null,
        dealId: input.links?.dealId ?? null,
        projectId: input.links?.projectId ?? null,
      }).returning({ id: mailThreads.id });
      if (thread === undefined) throw new Error("mail thread insert returned no row");
      threadId = thread.id;
    }

    // --- Attachments, then HTML ------------------------------------------
    const attachments = await prepareAttachments(dataDir, parsed, context);
    const cidMap: Record<string, string> = {};
    for (const attachment of attachments) {
      if (attachment.contentId !== null) cidMap[attachment.contentId] = attachment.id;
    }
    const bodyHtml = typeof parsed.html === "string" ? sanitizeMailHtml(parsed.html, { cidMap }) : null;
    // mailparser derives `text` from the html itself (script content
    // stripped) when the html IS the message body -- a single-part
    // text/html message, or the html half of a multipart/alternative. It
    // does NOT when the body is an html part inside a multipart/related or
    // multipart/mixed, i.e. every html mail carrying an inline image or an
    // attachment (probed against mailparser 3.9.15), and there `text` is
    // undefined. This fallback covers that very common shape, deriving the
    // text from the already-SANITIZED html (htmlToText's documented
    // precondition -- it does no safety filtering of its own) so body_text,
    // and therefore the search tsvector and the snippet, stay useful
    // instead of empty.
    //
    // Blank counts as absent, not just undefined: the standard newsletter
    // shape is a multipart/alternative whose text/plain half is empty or a
    // stub of whitespace, and treating that as real text would leave the
    // message unsearchable with an empty snippet.
    const parsedText = parsed.text;
    const hasParsedText = parsedText !== undefined && parsedText.trim().length > 0;
    const derivedText = hasParsedText
      ? parsedText
      : (bodyHtml !== null ? htmlToText(bodyHtml) : (parsedText ?? ""));
    const bodyText = capUtf8(derivedText, MAX_BODY_TEXT_BYTES);

    // --- Message ---------------------------------------------------------
    const fromAddr = capUtf8(addresses.from[0]?.address ?? "", MAX_HEADER_FIELD_BYTES);
    const direction = fromAddr.length > 0 && fromAddr === account.email.toLowerCase()
      ? "outbound"
      : "inbound";
    const fromName = addresses.from[0]?.name ?? null;
    const newMessageId = randomUUID();
    const [inserted] = await tx.insert(mailMessages).values({
      id: newMessageId,
      accountId: input.accountId,
      threadId,
      messageId,
      inReplyTo,
      referencesIds: references,
      fromAddr,
      fromName: fromName === null ? null : capUtf8(fromName, MAX_HEADER_FIELD_BYTES),
      // Recipient lists are capped like every other stored header field: a
      // 1MiB To: header parses into ~100k addresses, which as jsonb is a
      // permanent multi-megabyte row nothing in the UI can render anyway.
      toAddrs: addresses.to.slice(0, MAX_PARTICIPANTS),
      ccAddrs: addresses.cc.slice(0, MAX_PARTICIPANTS),
      // Spec: bcc_addrs is populated for outbound only -- and this narrows
      // that further to outbound mail found in the account's OWN sent
      // folder. `direction` is a pure From-header comparison (spec), so
      // anyone can spoof your address into your INBOX; without the folder
      // check that forgery would smuggle its Bcc list into storage and out
      // through the thread view as if the CRM's user had sent it.
      // bccOverride replaces the parsed list here, inside the gate, never
      // around it -- see its doc comment on IngestMessageInput. Normalised
      // into the same stored shape extractAddresses produces (lowercased
      // address, name null rather than absent), so a row written by a send
      // and one written from a Sent-folder header are indistinguishable
      // afterwards. Capped like every other stored recipient list.
      bccAddrs: direction === "outbound" && input.folder === account.sentFolder
        ? (input.bccOverride === undefined
            ? addresses.bcc
            : input.bccOverride.map(normalizeAddress)).slice(0, MAX_PARTICIPANTS)
        : [],
      subject: capUtf8(rawSubject, MAX_SUBJECT_BYTES),
      bodyText,
      bodyHtml,
      snippet: makeSnippet(bodyText),
      sentAt,
      folder: input.folder,
      imapUid: input.uid,
      seen,
      direction,
    })
      // Belt and braces behind the duplicate guard above: under
      // INGEST_LOCK_KEY no other ingest can insert this (account, message
      // id) between the guard and here, but mail-send (Task 6) inserts
      // outbound rows on its own path, so the constraint is not
      // ingest-only. Recording the latest sighting is the same thing the
      // guard would have done.
      .onConflictDoUpdate({
        target: [mailMessages.accountId, mailMessages.messageId],
        set: { folder: input.folder, imapUid: input.uid, seen, updatedAt: new Date() },
      })
      .returning(messageColumns);
    if (inserted === undefined) throw new Error("mail message insert returned no row");
    if (inserted.id !== newMessageId) {
      // The conflict branch fired: another writer created this row while
      // this transaction was mid-flight. Roll back rather than attach this
      // ingest's attachments/thread bump/links to a row it did not create
      // (which would double-count the thread and duplicate attachments).
      // The next sync pass re-ingests and takes the duplicate path
      // cleanly. Unreachable between two ingests, by the lock. The id is
      // truncated because this message ends up in last_error via
      // MailIngestError, and a Message-ID can be up to MAX_MESSAGE_ID_BYTES.
      throw new Error(`mail ingest raced another writer for message ${messageId.slice(0, 80)}`);
    }

    if (attachments.length > 0) {
      await tx.insert(mailAttachments).values(attachments.map((attachment) => ({
        id: attachment.id,
        messageId: inserted.id,
        filename: attachment.filename,
        mime: attachment.mime,
        sizeBytes: attachment.sizeBytes,
        blobPath: attachment.blobPath,
        contentId: attachment.contentId,
        isInline: attachment.isInline,
      })));
    }

    // --- Thread bump ------------------------------------------------------
    // GREATEST, not a plain assignment: backfill ingests oldest-first but a
    // cross-folder or out-of-order sighting can still deliver an older
    // message after a newer one, and last_message_at drives the inbox sort.
    //
    // DELIBERATELY NO mail_thread_hides write here (Phase 4.3 spec,
    // Amendment 2): new mail does NOT unhide. A viewer who filed this
    // conversation away keeps it filed -- out of their default list and
    // badge, growing quietly in their Hidden view -- while every other
    // viewer's surfaces gain the message normally. Resurfacing-on-new-mail
    // is snooze behaviour, explicitly deferred; whoever adds it must touch
    // the hide rows HERE and flip the Amendment 2 pin consciously
    // (mail-ingest.test.ts's hidden-threads block).
    await tx.update(mailThreads).set({
      messageCount: sql`${mailThreads.messageCount} + 1`,
      // ISO string, not the Date: drizzle only applies a column's own
      // driver mapping to values passed as plain set-clause fields, so a
      // Date embedded in a raw sql`` fragment reaches postgres.js
      // unconverted and it rejects it ("must be of type string or ...
      // Received an instance of Date"). The cast keeps the parameter
      // unambiguously timestamptz.
      lastMessageAt: sql`GREATEST(${mailThreads.lastMessageAt}, ${sentAt.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    }).where(eq(mailThreads.id, threadId));

    // --- Auto-link --------------------------------------------------------
    // Set-based dedupe, not includes(): the array scan is quadratic in the
    // recipient count, and at 40k addresses that measured 973ms of pure
    // event-loop stall -- inside the GLOBAL ingest lock, so every other
    // account's sync waits on it. (MAX_HEADER_BYTES keeps a To: header
    // under ~2900 addresses now, but a quadratic scan is not something to
    // leave standing behind another cap.) Capped as well, because even a
    // deduped list becomes one bind parameter per address in the contact
    // lookup. Order is preserved (from, then to, then cc), which is what
    // decides the winning match.
    const participants: string[] = [];
    const seenParticipants = new Set<string>();
    for (const address of [...addresses.from, ...addresses.to, ...addresses.cc]) {
      if (participants.length >= MAX_PARTICIPANTS) break;
      if (seenParticipants.has(address.address)) continue;
      seenParticipants.add(address.address);
      participants.push(address.address);
    }
    await autoLinkThread(tx, threadId, participants);

    // --- Timeline entry ---------------------------------------------------
    // AFTER auto-linking, because the links decide both whether this emits at
    // all and which timelines it lands on (see emitMailEvent's header). New
    // messages only: this is below the duplicate guard's early returns, so a
    // refetch or a second-folder sighting -- which is not new mail -- adds
    // nothing to any timeline.
    const timelineEntry = await emitMailEvent(tx, threadId, direction, account.userId);

    return { created: true, message: inserted, threadId, changed: true, timelineEntry };
  });

  // After commit, per the house convention (a hint for a rolled-back write
  // would make every client refetch nothing). Skipped entirely when a
  // re-sighting changed nothing -- a UIDVALIDITY refetch walks the whole
  // folder, and firing three invalidation keys per unchanged message would
  // turn one reset into a client-side refetch storm.
  if (result.changed) {
    publish({ keys: [
      ["mail-threads"], ["mail-thread", result.threadId], ["mail-unread"],
      // Only when a timeline entry was actually written (throttled away, or
      // an unlinked thread, and nothing on any timeline moved): the record
      // rails would otherwise refetch on every message of a busy thread for a
      // response that cannot have changed.
      ...(result.timelineEntry ? [["events"]] : []),
    ] });
  }
  return { created: result.created, message: result.message, threadId: result.threadId };
}
