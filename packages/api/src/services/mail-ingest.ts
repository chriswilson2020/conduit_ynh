import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import type { Database } from "../db/client.js";
import {
  contacts, mailAccounts, mailAttachments, mailMessages, mailThreads,
  type MailMessageRow,
} from "../db/schema.js";
import { saveBlob } from "./blobs.js";
import { NotFoundError } from "./errors.js";
import {
  extractAddresses, htmlToText, makeSnippet, normalizeSubject, sanitizeMailHtml, syntheticMessageId,
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
 * A single constant group, deliberately: mail volume is low (a busy
 * mailbox is a few messages a second at worst, and each transaction here
 * is a handful of indexed statements), so global serialisation costs
 * nothing worth optimising, whereas a finer-grained key would have to be
 * derived from the very thread identity this section is still resolving --
 * exactly the thing that is not known yet. Reuses lockSiblingGroup's
 * pg_advisory_xact_lock + hashtextextended mechanism (pipelines.ts) rather
 * than inventing a second advisory-lock convention; the key namespace is
 * disjoint from the "stages:..." sibling groups it was written for.
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

export interface IngestMessageInput {
  accountId: string;
  /** IMAP folder this sighting came from (INBOX, the account's sent_folder, ...). */
  folder: string;
  /** IMAP UID within that folder; null for a message not (yet) on the server. */
  uid: number | null;
  raw: Buffer | string;
  /** IMAP flags as fetched, e.g. ["\\Seen", "\\Answered"]. */
  flags: string[];
}

export interface IngestResult {
  /** false when this message was already stored: a refetch or second-folder sighting. */
  created: boolean;
  message: IngestedMessage;
  threadId: string;
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

/** mailparser gives `references` as a string for a single id and an array for
 * several; normalise to a bare-id array, order preserved (oldest first). */
function normalizeReferences(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    const id = normalizeId(entry);
    if (id !== null) out.push(id);
  }
  return out;
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
async function prepareAttachments(dataDir: string, parsed: ParsedMail): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const attachment of parsed.attachments) {
    const content: Buffer = attachment.content;
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
 */
export async function ingestMessage(
  db: Database, dataDir: string, input: IngestMessageInput,
): Promise<IngestResult> {
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
  const parsed = await simpleParser(input.raw, { skipImageLinks: true });

  const addresses = extractAddresses(parsed);
  const messageId = normalizeId(parsed.messageId) ?? syntheticMessageId(parsed);
  const inReplyTo = normalizeId(parsed.inReplyTo);
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
    // Taken as the transaction's first statement -- ahead of the duplicate
    // guard, not merely around thread-resolution+insert -- so the guard's
    // SELECT and this transaction's INSERT are atomic with respect to
    // every other ingest too. That way a same-account double sighting
    // (which AccountSync's in-process serialisation should already
    // prevent) still takes the clean duplicate path instead of colliding
    // on the UNIQUE constraint. The cost is that a whole-folder refetch
    // serialises against other accounts' ingests, which at mail volumes is
    // nothing next to getting one conversation into one thread.
    await lockSiblingGroup(tx, INGEST_LOCK_KEY);

    const [account] = await tx.select({ id: mailAccounts.id, email: mailAccounts.email })
      .from(mailAccounts).where(eq(mailAccounts.id, input.accountId));
    if (account === undefined) throw new NotFoundError("mail account", input.accountId);

    // --- Duplicate guard -------------------------------------------------
    // A refetch (UIDVALIDITY reset) or a second-folder sighting must update
    // only where the message was last seen and whether it is read -- never
    // duplicate the row, re-thread it, re-store its attachments or re-run
    // auto-linking. Everything below this block is new-message-only work.
    const [existing] = await tx.select(messageColumns).from(mailMessages)
      .where(and(eq(mailMessages.accountId, input.accountId), eq(mailMessages.messageId, messageId)));
    if (existing !== undefined) {
      const changed = existing.folder !== input.folder
        || existing.imapUid !== input.uid
        || existing.seen !== seen;
      if (!changed) return { created: false, message: existing, threadId: existing.threadId, changed };
      const [updated] = await tx.update(mailMessages)
        .set({ folder: input.folder, imapUid: input.uid, seen, updatedAt: new Date() })
        .where(eq(mailMessages.id, existing.id)).returning(messageColumns);
      if (updated === undefined) throw new Error("mail message update returned no row");
      return { created: false, message: updated, threadId: updated.threadId, changed };
    }

    // --- Thread resolution ----------------------------------------------
    let threadId = await resolveThreadId(tx, messageId, references, inReplyTo);
    if (threadId === null) {
      const [thread] = await tx.insert(mailThreads).values({
        // Normalized once, from the first message of the thread (spec):
        // later "Re:" replies never rewrite it.
        subject: normalizeSubject(rawSubject),
        lastMessageAt: sentAt,
      }).returning({ id: mailThreads.id });
      if (thread === undefined) throw new Error("mail thread insert returned no row");
      threadId = thread.id;
    }

    // --- Attachments, then HTML ------------------------------------------
    const attachments = await prepareAttachments(dataDir, parsed);
    const cidMap: Record<string, string> = {};
    for (const attachment of attachments) {
      if (attachment.contentId !== null) cidMap[attachment.contentId] = attachment.id;
    }
    const bodyHtml = typeof parsed.html === "string" ? sanitizeMailHtml(parsed.html, { cidMap }) : null;
    // mailparser only produces `text` when the message actually carries a
    // text/plain part; for HTML-only mail it is undefined. Deriving the
    // text from the already-SANITIZED html (htmlToText's documented
    // precondition) keeps body_text -- and therefore the search tsvector
    // and the snippet -- useful for those messages instead of empty.
    const bodyText = parsed.text ?? (bodyHtml !== null ? htmlToText(bodyHtml) : "");

    // --- Message ---------------------------------------------------------
    const fromAddr = addresses.from[0]?.address ?? "";
    const direction = fromAddr.length > 0 && fromAddr === account.email.toLowerCase()
      ? "outbound"
      : "inbound";
    const newMessageId = randomUUID();
    const [inserted] = await tx.insert(mailMessages).values({
      id: newMessageId,
      accountId: input.accountId,
      threadId,
      messageId,
      inReplyTo,
      referencesIds: references,
      fromAddr,
      fromName: addresses.from[0]?.name ?? null,
      toAddrs: addresses.to,
      ccAddrs: addresses.cc,
      // Spec: bcc_addrs is populated for outbound only. An inbound
      // message's own Bcc header (when a sender leaves one in) names
      // recipients this mailbox was never meant to learn about.
      bccAddrs: direction === "outbound" ? addresses.bcc : [],
      subject: rawSubject,
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
      // cleanly. Unreachable between two ingests, by the lock.
      throw new Error(`mail ingest raced another writer for message ${messageId}`);
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
    const participants: string[] = [];
    for (const address of [...addresses.from, ...addresses.to, ...addresses.cc]) {
      if (!participants.includes(address.address)) participants.push(address.address);
    }
    await autoLinkThread(tx, threadId, participants);

    return { created: true, message: inserted, threadId, changed: true };
  });

  // After commit, per the house convention (a hint for a rolled-back write
  // would make every client refetch nothing). Skipped entirely when a
  // re-sighting changed nothing -- a UIDVALIDITY refetch walks the whole
  // folder, and firing three invalidation keys per unchanged message would
  // turn one reset into a client-side refetch storm.
  if (result.changed) {
    publish({ keys: [["mail-threads"], ["mail-thread", result.threadId], ["mail-unread"]] });
  }
  return { created: result.created, message: result.message, threadId: result.threadId };
}
