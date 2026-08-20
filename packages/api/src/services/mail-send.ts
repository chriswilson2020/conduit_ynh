import { Readable } from "node:stream";
import { and, desc, eq, inArray } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { MailAccount, MailAddress, SendMailInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { files, mailMessages, mailThreads } from "../db/schema.js";
import { openBlob } from "./blobs.js";
import { ArchivedError, ConflictError, NotFoundError, SmtpSendError } from "./errors.js";
import { getAccountCredentialsAsSystem, getOwnAccount } from "./mail-accounts.js";
import { htmlToText, sanitizeMailHtml } from "./mail-content.js";
import type { MailCredentials } from "./mail-crypto.js";
import {
  MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX, consoleSyncLogger, type SyncLogger,
} from "./mail-imap.js";
import { ingestMessage, type IngestedMessage } from "./mail-ingest.js";

/**
 * The send path (Phase 4 spec, "Send path"). Compose or reply, submit over
 * SMTP, mirror the result into the account's Sent folder, and store it.
 *
 * Two properties hold the whole thing together.
 *
 * ONE COMPOSITION. The MIME is built exactly once and the SAME BYTES are
 * submitted to SMTP, APPENDed to the Sent folder and handed to ingest. That
 * is what makes the stored message a faithful record of what was actually
 * sent, and -- because nodemailer generates the Message-ID during that single
 * composition -- what makes the later Sent-folder SIGHTING of this message
 * dedupe onto this row through UNIQUE (account_id, message_id) instead of
 * arriving as a second copy. Re-composing for any of the three would produce
 * a different Message-ID and silently break that.
 *
 * INGEST STAYS THE ONLY WRITER. This service does not insert into
 * mail_messages/mail_threads/mail_attachments; it calls ingestMessage with
 * the bytes it just sent (folder = the account's sent_folder, uid = null,
 * flags = \Seen). Threading, the thread bump, attachment storage,
 * auto-linking, the global advisory lock and the SSE hint all then happen in
 * one place, the same way they do for inbound mail (mail-ingest.ts's own doc
 * comment states the other half of this contract).
 *
 * ORDERING, and what survives a failure at each step:
 *   1. owner/state checks, reply chain, attachments, credentials -- nothing
 *      has happened yet, so any failure is a plain 4xx and no message exists.
 *   2. SMTP submission. On failure NOTHING is stored (spec): the client still
 *      holds the draft, and a stored-but-unsent message would be worse than
 *      no message at all.
 *   3. IMAP APPEND to Sent. Best effort: the send already happened, so a
 *      failure here is logged and stepped over -- the message simply will not
 *      appear in the user's other mail clients' Sent folder until the CRM
 *      sends the next one.
 *   4. ingest. This is the step that must land.
 */

const SEEN_FLAG = "\\Seen";

/** Mirrors mail-ingest.ts's own References cap: the nearest ancestors are the
 * ones threading consults, and this chain is about to be re-ingested through
 * that same cap anyway. */
const MAX_REFERENCES = 50;

/**
 * mail-ingest.ts stores a "sha256:..." id for a message that had no
 * Message-ID of its own (synthetic) or one too long to index (hashed). Either
 * way the id names nothing that exists on the wire, so it must never go out
 * in an In-Reply-To or References header: the recipient's client would thread
 * against an id no message anywhere has. Our own threading does not depend on
 * it either -- a reply passes `threadId` to ingest, which short-circuits
 * header-based resolution entirely.
 */
const DERIVED_ID_PREFIX = "sha256:";

function isSendableMessageId(id: string): boolean {
  return id.length > 0 && !id.startsWith(DERIVED_ID_PREFIX);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Seams -----------------------------------------------------------------

/**
 * What this service needs of a transport: submit these exact bytes to these
 * exact recipients. `envelope` is not optional and not decoration -- a `raw`
 * message is passed through to the server unparsed, so nodemailer derives no
 * addresses from it and would submit a message with no recipients at all.
 */
export interface SendMailMessage {
  raw: Buffer;
  envelope: { from: string; to: string[] };
}

export interface SendMailTransport {
  sendMail(message: SendMailMessage): Promise<unknown>;
}

/** Built per send, from the account row and its decrypted credentials.
 * mail-imapflow.ts's createSmtpTransport is the production implementation. */
export type SendMailTransportFactory =
  (account: MailAccount, credentials: MailCredentials) => SendMailTransport;

/**
 * The slice of mail-sync.ts's SyncManager this service uses. Structural
 * rather than the class itself, so a test can hand in an APPEND that fails
 * without standing up a sync engine -- and so this module does not depend on
 * the sync engine at all.
 *
 * Null when no manager exists (NODE_ENV=test, or a deployment whose sync is
 * disabled): sending still works, the message simply is not APPENDed.
 */
export interface SendMailSyncManager {
  get(accountId: string): { appendSent(raw: Buffer | string): Promise<void> } | undefined;
}

export interface SendMailDeps {
  /** Where mail.key lives; the account's SMTP password is decrypted with it
   * (mail-crypto.ts), after the owner check has passed. */
  mailKeyPath: string;
  transportFactory: SendMailTransportFactory;
  syncManager: SendMailSyncManager | null;
  /** Defaults to the console logger, like the sync engine's own. */
  logger?: SyncLogger;
}

// --- Reply chain -----------------------------------------------------------

interface ReplyChain {
  inReplyTo: string | null;
  references: string[];
}

const NEW_THREAD: ReplyChain = { inReplyTo: null, references: [] };

/**
 * In-Reply-To and References for a reply, built from the thread's most recent
 * message: In-Reply-To names that message, References is its own chain plus
 * itself (RFC 5322's rule, and what every mail client threads on).
 *
 * "Most recent" is by sent_at, the header date -- the same ordering the
 * conversation view renders in. A thread whose last message has no usable id
 * (see DERIVED_ID_PREFIX) still gets a valid, if shorter, chain rather than a
 * fabricated one.
 */
async function loadReplyChain(db: Database, threadId: string): Promise<ReplyChain> {
  const [thread] = await db.select({ id: mailThreads.id })
    .from(mailThreads).where(eq(mailThreads.id, threadId));
  if (thread === undefined) throw new NotFoundError("mail thread", threadId);

  const [last] = await db
    .select({ messageId: mailMessages.messageId, referencesIds: mailMessages.referencesIds })
    .from(mailMessages).where(eq(mailMessages.threadId, threadId))
    // createdAt then id after sentAt: two messages can share a header date
    // (a sender's clock, or a message with no Date at all), and an ordering
    // that is not total would make the chain depend on the planner.
    .orderBy(desc(mailMessages.sentAt), desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(1);
  // An empty thread cannot exist through ingest (a thread is created with its
  // first message), but nothing constrains it in the schema, so this reads as
  // "compose into the thread" rather than throwing.
  if (last === undefined) return NEW_THREAD;

  const chain: string[] = [];
  const seen = new Set<string>();
  for (const id of [...last.referencesIds, last.messageId]) {
    if (!isSendableMessageId(id) || seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }
  return {
    inReplyTo: isSendableMessageId(last.messageId) ? last.messageId : null,
    references: chain.slice(-MAX_REFERENCES),
  };
}

// --- Attachments -----------------------------------------------------------

interface ComposedAttachment {
  filename: string;
  contentType: string;
  content: Readable;
}

/**
 * Compose attachments are `files` rows (uploaded through the existing
 * multipart flow before the send, per the spec), streamed out of blob storage
 * into the MIME.
 *
 * OWNERSHIP IS CHECKED HERE, not just on the account: without it, a user
 * could attach any file in the CRM by id -- including one on a record they
 * cannot see -- and mail it to an outside address. Same convention as a
 * foreign mail account (mail-accounts.ts's mustGetOwned): an id belonging to
 * someone else 404s exactly like one that does not exist, so this cannot be
 * used to probe for the existence of other people's uploads.
 *
 * Validation completes before a single stream is opened, so a rejected id
 * does not leave file descriptors open behind it.
 */
async function loadAttachments(
  db: Database, dataDir: string, actorId: string, ids: readonly string[],
): Promise<ComposedAttachment[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: files.id, originalName: files.originalName, mime: files.mime, sha256: files.sha256,
    })
    .from(files)
    .where(and(inArray(files.id, [...ids]), eq(files.uploaderUserId, actorId)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolved = ids.map((id) => {
    const row = byId.get(id);
    if (row === undefined) throw new NotFoundError("file", id);
    return row;
  });
  return resolved.map((row) => ({
    filename: row.originalName,
    contentType: row.mime,
    content: openBlob(dataDir, row.sha256),
  }));
}

// --- Composition -----------------------------------------------------------

function toComposeAddresses(addresses: readonly MailAddress[]): { name?: string; address: string }[] {
  return addresses.map((entry) => (
    entry.name != null && entry.name.length > 0
      ? { name: entry.name, address: entry.address }
      : { address: entry.address }
  ));
}

/**
 * The SMTP envelope. Built from all three recipient lists (Bcc included --
 * the envelope is how a Bcc recipient receives the message at all; the header
 * is what must not name them, and nodemailer's own Bcc handling already keeps
 * it out of the composed bytes).
 *
 * Deduplicated: an address on both To and Cc would otherwise become two RCPT
 * TO commands and two deliveries of the same message.
 *
 * The composed bytes themselves carry NO Bcc header -- nodemailer's MimeNode
 * omits it from the built message unless asked otherwise -- so a blind copy
 * stays blind. One consequence of composing once and storing what was sent:
 * the CRM's own record of the message does not name its Bcc recipients
 * either. (mail_messages.bcc_addrs still earns its place: mail clients that
 * save their own Sent copy do keep the header, and ingest reads it there.)
 */
function buildEnvelope(from: string, input: SendMailInput): { from: string; to: string[] } {
  const recipients = new Set<string>();
  for (const entry of [...input.to, ...input.cc, ...input.bcc]) recipients.add(entry.address);
  return { from, to: [...recipients] };
}

// --- The send --------------------------------------------------------------

/**
 * Compose (or reply), send, mirror to Sent, store. Returns the stored
 * message row -- ingest has already published the SSE hint by then.
 *
 * `dataDir` is a parameter rather than something read from config, matching
 * blobs.ts/files.ts/mail-ingest.ts: attachments are read from it and ingest
 * writes the outgoing message's attachments back into it.
 */
export async function sendMail(
  db: Database, dataDir: string, actorId: string, input: SendMailInput, deps: SendMailDeps,
): Promise<IngestedMessage> {
  const logger = deps.logger ?? consoleSyncLogger;

  // Owner-only send (spec, Security): a foreign or unknown account is the
  // same 404, so nothing leaks about other users' accounts.
  const account = await getOwnAccount(db, actorId, input.accountId);
  // Archived accounts are hidden from compose entirely, and an account whose
  // last sync failed its login is one whose SMTP submission is about to fail
  // the same way -- 409 with the stored error is a better answer than a
  // connection timeout dressed up as a 502.
  if (account.archivedAt !== null) throw new ArchivedError("mail account", account.id);
  if (account.status !== "active") {
    throw new ConflictError(
      "mail account", account.id,
      "this mail account is in an error state; test its connection in settings before sending",
    );
  }

  const chain = input.threadId === undefined ? NEW_THREAD : await loadReplyChain(db, input.threadId);
  const attachments = await loadAttachments(db, dataDir, actorId, input.attachmentIds);
  // Only now, once every check that can reject has passed (mail-accounts.ts's
  // getAccountCredentialsAsSystem does NO owner check of its own -- that is
  // this function's job, and it is done above).
  const credentials = await getAccountCredentialsAsSystem(db, account.id, deps.mailKeyPath);

  // The same sanitizer profile every other HTML in the system goes through
  // (no cidMap: a compose body has no attachment cid: references to rewrite
  // -- inline images are a composer feature this phase does not have). The
  // SENT bytes carry the sanitized markup, not just the stored copy: what
  // the recipient gets and what the CRM shows must be the same document.
  const bodyHtml = sanitizeMailHtml(input.bodyHtml);
  const composer = new MailComposer({
    // Bare address, no display name: the account's label ("Work") is a
    // CRM-side name for the mailbox, not the sender's name, and putting it in
    // the From header would show it to every recipient.
    from: account.email,
    to: toComposeAddresses(input.to),
    cc: toComposeAddresses(input.cc),
    bcc: toComposeAddresses(input.bcc),
    subject: input.subject,
    html: bodyHtml,
    // Plain-text alternative, derived from the SANITIZED html (htmlToText's
    // documented precondition). Mail without a text/plain part reads as
    // spam-shaped to several filters, quite apart from the readers who
    // prefer it.
    text: htmlToText(bodyHtml),
    ...(chain.inReplyTo !== null ? { inReplyTo: chain.inReplyTo } : {}),
    ...(chain.references.length > 0 ? { references: chain.references } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  // ONE composition; see this module's doc comment. build() resolves the
  // attachment streams and generates the Message-ID.
  const raw = await composer.compile().build();

  try {
    // The factory call is inside the try as well: building a transport is
    // just "open an SMTP connection with these settings", so a failure there
    // is the same 502-shaped answer as a rejected login, not a 500.
    const transport = deps.transportFactory(account, credentials);
    await transport.sendMail({ raw, envelope: buildEnvelope(account.email, input) });
  } catch (error) {
    // Nothing is stored on this path -- deliberately, and asserted by a test:
    // a row for a message that never left would show in the thread as sent.
    throw new SmtpSendError(smtpFailureReason(error), { cause: error });
  }

  // Best effort, per the spec: the send has already happened. appendSent
  // rejects immediately (without touching the network) while the account is
  // in backoff -- SyncUnavailableError -- which is the designed behaviour and
  // lands here like any other failure.
  try {
    await deps.syncManager?.get(account.id)?.appendSent(raw);
  } catch (error) {
    logger.warn(
      { accountId: account.id, err: errorText(error) },
      "mail-send: the message was sent but could not be appended to the Sent folder",
    );
  }

  // The whole row, not "ingest primitives" -- see this module's doc comment.
  // `folder` is the account's sent_folder EXACTLY as stored, never a trimmed
  // or normalised copy: ingest compares the value it is given against the
  // same column (that is how it decides an outbound message is really in the
  // account's own Sent folder), so the two must be the same string.
  const result = await ingestMessage(db, dataDir, {
    accountId: account.id,
    folder: account.sentFolder,
    uid: null,
    raw,
    flags: [SEEN_FLAG],
    // Threading a reply onto the CRM's own thread beats whatever the
    // outgoing References chain would resolve to.
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    // Compose-dialog seeds. Ingest applies them only to a thread this call
    // CREATES, so they are harmless (and ignored) on a reply.
    ...(input.links !== undefined ? { links: input.links } : {}),
  });
  return result.message;
}

/**
 * Turn the transport's failure into something a composer dialog can act on.
 * The adapter has already classified it (mail-imap.ts's ERROR
 * CLASSIFICATION); this only says what the two classes MEAN here, and passes
 * anything else through untouched rather than guessing.
 */
function smtpFailureReason(error: unknown): string {
  const text = errorText(error);
  if (text.startsWith(MAIL_AUTH_ERROR_PREFIX)) {
    return `the mail server rejected this account's credentials (${text})`;
  }
  if (text.startsWith(MAIL_CONNECTION_ERROR_PREFIX)) {
    return `the mail server could not be reached (${text})`;
  }
  return text;
}
