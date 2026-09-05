import { and, desc, eq, inArray } from "drizzle-orm";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { MailAccount, MailAddress, SendMailInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { files, mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
import { blobPath } from "./blobs.js";
import {
  ArchivedError, AttachmentTooLargeError, ConflictError, NotFoundError, SmtpSendError,
} from "./errors.js";
import { getAccountCredentialsAsSystem, getOwnAccount } from "./mail-accounts.js";
import { htmlToText, sanitizeMailHtml } from "./mail-content.js";
import { getAttachmentBlob, mustGetThread, visibleMessageTerm } from "./mail-threads.js";
import {
  MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX, consoleSyncLogger,
  type MailConnectionAuth, type SyncLogger,
} from "./mail-imap.js";
import {
  resolveConnectionAuth, unconfiguredTokenRefresher, type MailTokenRefresher,
} from "./mail-oauth.js";
import { appendsSentCopy } from "./mail-oauth-signin.js";
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

/**
 * How long the Sent-folder APPEND may hold the send's HTTP response open.
 *
 * appendSent is queued onto the account's sync loop, which is serial: an
 * APPEND enqueued while that loop is halfway through a first backfill does
 * not run until the backfill does, which can be minutes. Awaiting it
 * unbounded would leave the composer spinning long after the message had
 * actually been sent -- and a user who gives up and presses Send again sends
 * it twice. So the wait is bounded and a timeout falls into the same warn
 * path as any other APPEND failure: the queued task is NOT cancelled (there
 * is no cancellation in the ImapClient contract, and it will still run and
 * still land the copy in Sent), it is simply no longer waited on.
 *
 * A few seconds: long enough for an idle or briefly-busy loop to pick the
 * task up, short enough that a stuck one is never the user's problem.
 */
const APPEND_TIMEOUT_MS = 5_000;

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

/**
 * Built per send, from the account row and an ALREADY-RESOLVED credential.
 * mail-imapflow.ts's createSmtpTransportFactory builds the production one.
 *
 * MailConnectionAuth, not MailCredentials, since Phase 8 Task 2. Choosing
 * between the two stored passwords -- and, for an OAuth account, exchanging the
 * refresh token for an access token, which is a network round trip and a
 * database write -- happens in sendMail below, before the factory is called.
 * That keeps the adapter a mapping onto nodemailer rather than something that
 * needs mail.key, a token endpoint and a Database of its own.
 */
export type SendMailTransportFactory =
  (account: MailAccount, auth: MailConnectionAuth) => SendMailTransport;

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
  /** Where mail.key lives; the account's SMTP credential is decrypted with it
   * (mail-crypto.ts), after the owner check has passed. */
  mailKeyPath: string;
  /**
   * How an OAuth account's refresh token becomes an access token
   * (mail-oauth.ts). Optional because most sends never reach it: a password
   * account resolves without one, and an install with no app registration has
   * no OAuth account to send from. When it is absent and an OAuth account does
   * try to send, the default refuser says so in a sentence rather than
   * pretending a token was obtained.
   */
  tokenRefresher?: MailTokenRefresher;
  transportFactory: SendMailTransportFactory;
  syncManager: SendMailSyncManager | null;
  /** Defaults to the console logger, like the sync engine's own. */
  logger?: SyncLogger;
  /** Test seam only: how long to wait for the Sent-folder APPEND before
   * giving up on it (default APPEND_TIMEOUT_MS). A test proving the bound
   * exists should not have to spend the real one waiting. */
  appendTimeoutMs?: number;
}

/**
 * Resolve `promise`, or reject with a timeout after `ms`. The source promise
 * is left running -- there is nothing to cancel it with, and in the one case
 * this is used for it is a queued task that should still complete.
 *
 * No unhandled rejection escapes a lost race: Promise.race subscribes to
 * `promise`, so a late rejection is delivered to a handler that ignores it
 * rather than to the process. The timer is always cleared (and unref'd, so it
 * could never be the reason a shutdown waits).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- Reply chain -----------------------------------------------------------

interface ReplyChain {
  inReplyTo: string | null;
  references: string[];
}

const NEW_THREAD: ReplyChain = { inReplyTo: null, references: [] };

/**
 * In-Reply-To and References for a reply, built from the thread's most recent
 * VISIBLE message: In-Reply-To names that message, References is its own
 * chain plus itself (RFC 5322's rule, and what every mail client threads on).
 *
 * YOU MAY REPLY TO WHAT YOU MAY OPEN (coordinator amendment, Phase 4.2): the
 * thread resolves through mustGetThread's record-scope visibility gate, so an
 * invisible threadId gets the indistinguishable NotFoundError before any
 * header is built or anything is sent. The chain then reads the newest
 * message the viewer's record scope can read -- visibleMessageTerm, the same
 * scope as the detail the composer replies from -- so a reply never carries
 * an invisible message's Message-ID out in its headers, and on an unlinked
 * cross-account conversation the sent copy threads onto the viewer's own
 * half. On a deal/project-linked thread every message is visible, so the
 * chain is the thread's true newest, as before.
 *
 * "Most recent" is by sent_at, the header date -- the same ordering the
 * conversation view renders in. A thread whose last message has no usable id
 * (see DERIVED_ID_PREFIX) still gets a valid, if shorter, chain rather than a
 * fabricated one.
 */
async function loadReplyChain(db: Database, userId: string, threadId: string): Promise<ReplyChain> {
  await mustGetThread(db, userId, threadId);

  const [last] = await db
    .select({ messageId: mailMessages.messageId, referencesIds: mailMessages.referencesIds })
    .from(mailMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(and(eq(mailMessages.threadId, threadId), visibleMessageTerm(userId, "record")))
    // createdAt then id after sentAt: two messages can share a header date
    // (a sender's clock, or a message with no Date at all), and an ordering
    // that is not total would make the chain depend on the planner.
    .orderBy(desc(mailMessages.sentAt), desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(1);
  // An empty thread cannot exist through ingest (a thread is created with its
  // first message) -- though a visible one with zero VISIBLE messages can
  // only be the message-less defensive case, since a deal/project link makes
  // every message visible -- so this reads as "compose into the thread"
  // rather than throwing.
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
  /** A path, never an open stream -- see loadAttachments. */
  path: string;
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
 * PATHS, NOT OPEN STREAMS. nodemailer opens each file itself while building
 * the MIME and closes it again, so the descriptor's whole lifetime sits
 * inside that one operation. Handing back open read streams instead made
 * every failure BETWEEN this call and the build leak one descriptor per
 * attachment -- and the failure that sits in that gap is credential
 * decryption, which is persistent (a missing or rotated mail.key fails every
 * time), so a user retrying a broken account leaked steadily.
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
    path: blobPath(dataDir, row.sha256),
  }));
}

/**
 * Per-attachment ceiling for a forward's re-attached originals: the SAME
 * 50MB the compose upload path enforces (routes/index.ts's multipart
 * fileSize limit, whose 413 files.ts answers), applied here at send time
 * because a stored original never passes through that upload route. Per
 * attachment with no cap on the sum, which is exactly the compose
 * semantics: each uploaded file is capped individually and nothing bounds
 * a send's total.
 *
 * BELT AND BRACES today, not a live limit -- mail-ingest.ts's own
 * MAX_ATTACHMENT_BYTES (the THIRD 50MB literal; the three name one
 * ceiling, change them together) already skips any over-50MB part at
 * ingest, and its 25MB raw-message cap means no stored attachment can
 * exceed ~19.6MB through any current write path, so this check is
 * unreachable until one of those bounds moves (both cap tests state their
 * over-cap row by UPDATE for exactly that reason). Kept for the same
 * reason ingest keeps its half: the send path must stay bounded on its
 * own terms, not by trusting another module's ceiling to hold forever.
 */
export const MAX_FORWARD_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Forwarded originals (Phase 4.3, closing the v0.5.0 "forward no re-attach"
 * limitation): mail_attachments rows named by id, re-attached to the
 * outgoing message from the stored blobs. Ids are DEDUPLICATED first (a
 * doubled id must attach once, in its first position), per the schema's
 * stated contract.
 *
 * AUTHORIZATION AND STORAGE ARE getAttachmentBlob's -- reused, never
 * re-derived: the same record-scope per-message visibility join that
 * decides whether this viewer may DOWNLOAD these bytes decides whether they
 * may mail them onward, an invisible id 404s exactly like a nonexistent
 * one, and the blob digest comes off the same row the download route
 * streams from. The counterpart of loadAttachments' rule one shape over:
 * uploads are files rows the actor OWNS, forwarded originals are
 * mail_attachments rows the actor may READ. That reuse is a deliberate
 * trade against loadAttachments' single-query shape: one authz-carrying
 * query PER ID rather than one inArray for the lot, because
 * getAttachmentBlob's visibility join is the thing being reused and it
 * answers for one id. Bounded and cheap where it runs: the wire cap is 50
 * ids (the schema's max, mirroring ingest's MAX_ATTACHMENTS), each probe
 * is a four-table join on a primary key, and a real forward carries a
 * handful.
 *
 * THE SIZE CAP is checked against the stored size_bytes -- the byte count
 * ingest wrote in the same transaction as the blob, the number the download
 * route serves as Content-Length -- and an over-cap attachment refuses the
 * WHOLE send with AttachmentTooLargeError (see its class note for why
 * refusal beats silently dropping the file; see MAX_FORWARD_ATTACHMENT_BYTES
 * above for why no current write path can store such a row). The check runs
 * in step 1 of the send ordering: nothing has been submitted or stored yet,
 * so the refusal is a plain 4xx and the client still holds the draft.
 *
 * PATHS, NOT OPEN STREAMS, for exactly loadAttachments' reason: nodemailer
 * opens and closes each file inside the one build, so a failure between
 * here and the compose leaks no descriptor.
 */
async function loadForwardAttachments(
  db: Database, dataDir: string, actorId: string, ids: readonly string[],
): Promise<ComposedAttachment[]> {
  const out: ComposedAttachment[] = [];
  for (const id of [...new Set(ids)]) {
    const blob = await getAttachmentBlob(db, actorId, id, { inlineOnly: false });
    if (blob.sizeBytes > MAX_FORWARD_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError(blob.filename, blob.sizeBytes, MAX_FORWARD_ATTACHMENT_BYTES);
    }
    out.push({ filename: blob.filename, contentType: blob.mime, path: blobPath(dataDir, blob.blobPath) });
  }
  return out;
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
 * stays blind on the wire. The CRM's own record still names them: the list is
 * handed to ingest separately as `bccOverride` (see the ingest call below),
 * because "what the recipients see" and "what the sender's own Sent record
 * holds" are genuinely different lists, and every ordinary mail client keeps
 * the second one too.
 */
function buildEnvelope(from: string, input: SendMailInput): { from: string; to: string[] } {
  // Compared case-insensitively across the WHOLE address, but sent in the
  // form the user typed. RFC 5321 makes only the domain case-insensitive and
  // leaves the local part to the receiving server, so this can in principle
  // merge two addresses a pedantic server would treat as different -- a
  // compromise taken knowingly, because "Alice@x.com" on To and "alice@x.com"
  // on Cc is a duplicate in every mail system anyone actually runs, and
  // delivering the same message twice is the worse failure.
  const seen = new Set<string>();
  const to: string[] = [];
  for (const entry of [...input.to, ...input.cc, ...input.bcc]) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    to.push(entry.address);
  }
  return { from, to };
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
    // TWO SENTENCES, BECAUSE THE TWO REMEDIES ARE DIFFERENT. "Test its
    // connection" is right for a server that refused, and wrong for a grant the
    // provider has stopped honouring -- there is nothing to test, and the
    // button would answer "credentials unreadable". Sending an operator to the
    // wrong control is the v1.4.1 mistake the Phase 8 plan names: the error
    // message blamed the wrong thing and the operator concluded Conduit was
    // broken.
    throw new ConflictError(
      "mail account", account.id,
      account.status === "auth_required"
        ? "this mail account's sign-in has lapsed; sign in again in settings before sending"
        : "this mail account is in an error state; test its connection in settings before sending",
    );
  }

  const chain = input.threadId === undefined ? NEW_THREAD : await loadReplyChain(db, actorId, input.threadId);
  // Uploads first, then a forward's re-attached originals, on the WIRE --
  // the composer displays the two the other way round (forwarded chips
  // first); MIME part order is not display order and nothing reads meaning
  // into it. Both loaders run in step 1 (checks only, nothing sent or
  // stored yet), so either one's 404 or size refusal is a plain 4xx.
  const attachments = [
    ...await loadAttachments(db, dataDir, actorId, input.attachmentIds),
    ...await loadForwardAttachments(db, dataDir, actorId, input.forwardAttachmentIds),
  ];
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
  // attachment streams and generates the Message-ID. A blob PATH that does
  // not resolve -- possible only through storage corruption, since blobs
  // are content-addressed and nothing ever deletes them -- surfaces here as
  // build() rejecting, i.e. a bare 500 with nothing sent and nothing
  // stored. Accepted, and pre-existing for uploads: a 500 is the honest
  // answer for a store that has lost bytes it promised to hold.
  const raw = await composer.compile().build();

  try {
    // BOTH THE TOKEN RESOLUTION AND THE FACTORY CALL ARE INSIDE THE TRY, and
    // for the same reason the factory call always was: building a transport is
    // just "open an SMTP connection with these settings", so a failure there is
    // the same 502-shaped answer as a rejected login, not a 500.
    //
    // A DEAD OAUTH GRANT ARRIVES HERE AS A MailReauthRequiredError, and this is
    // the one place where "sign in again" reaches a person immediately: the
    // composer shows smtpFailureReason's text on the dialog they are looking
    // at. It does NOT write the account's state -- the sync loop is the single
    // writer of mail_accounts.status and it will reach the same conclusion on
    // its next pass, within the poll interval. Two writers to that column is
    // how a state gets silently overwritten by whichever ran last.
    const auth = await resolveConnectionAuth(
      {
        db,
        mailKeyPath: deps.mailKeyPath,
        refresh: deps.tokenRefresher ?? unconfiguredTokenRefresher,
        now: () => new Date(),
      },
      account, credentials, "smtp",
    );
    const transport = deps.transportFactory(account, auth);
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
  //
  // ACCEPTED RACE, milliseconds wide, at the seam between this APPEND and the
  // ingest below: the Sent folder now holds the message, so a sync pass that
  // happens to be walking Sent at this exact moment can ingest it first. This
  // call's ingestMessage then takes the DUPLICATE path, which by design only
  // records where the message was last seen -- so that send's `threadId` and
  // compose-dialog `links` are dropped. Inherent to APPEND-before-ingest
  // (reversing them would store a message before it exists on the server, and
  // the APPEND is what other clients' Sent folders need). It is accepted
  // rather than locked around because it is self-healing where it matters:
  // the outgoing References chain resolves a reply onto the same thread the
  // explicit threadId would have chosen, so only a compose-seeded link on a
  // brand-new thread can actually be lost, and only in that window.
  //
  // AND AT ONE PROVIDER IT DOES NOT HAPPEN AT ALL. Google files every SMTP
  // submission in Sent Mail itself and offers no way to stop it, so an APPEND
  // there is a second upload of bytes the mailbox already has -- see
  // mail-oauth-signin.ts's appendsSentCopy for the measurement, for why
  // Microsoft is answered the other way despite doing the same thing, and for
  // why a password account is untouched. NOTHING BELOW CHANGES: ingest still
  // stores this message against the account's sent_folder, and the sync's later
  // sighting of Google's own copy still dedupes onto that row through UNIQUE
  // (account_id, message_id), because the Message-ID is the one nodemailer put
  // in the bytes Google accepted.
  try {
    const append = appendsSentCopy(account.authMethod)
      ? deps.syncManager?.get(account.id)?.appendSent(raw)
      : undefined;
    if (append !== undefined) {
      await withTimeout(
        append,
        deps.appendTimeoutMs ?? APPEND_TIMEOUT_MS,
        "the Sent-folder APPEND did not complete in time (the account's sync is busy)",
      );
    }
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
    // The one thing the bytes cannot tell ingest: they carry no Bcc header
    // (that is what makes a blind copy blind), so the recipients are handed
    // over separately. Ingest still decides whether to keep them -- its gate
    // is unchanged, and an inbound message spoofing this address stores none.
    ...(input.bcc.length > 0 ? { bccOverride: input.bcc } : {}),
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
  // A LAPSED OAUTH GRANT FALLS THROUGH TO THE PASS-THROUGH ARM, deliberately
  // and by an invariant rather than by luck. MailReauthRequiredError's message
  // carries NEITHER classified prefix -- neither is true of it: "check the
  // username/password" points at a field an OAuth account does not have, and
  // "unreachable" invites a retry that cannot work -- so it reaches the
  // composer as the sentence errors.ts wrote, which is already addressed to the
  // person reading the dialog.
  //
  // AN `instanceof` BRANCH HERE WAS TRIED AND REMOVED: it returned exactly what
  // the pass-through returns, so deleting it changed no behaviour and no test
  // noticed (mutation M28). The invariant it was quietly relying on is pinned
  // where it belongs instead -- mail-oauth.test.ts asserts that the error's
  // message starts with neither prefix, so an edit that gave it one fails a
  // test rather than silently rewriting this sentence into the wrong advice.
  const text = errorText(error);
  if (text.startsWith(MAIL_AUTH_ERROR_PREFIX)) {
    return `the mail server rejected this account's credentials (${text})`;
  }
  if (text.startsWith(MAIL_CONNECTION_ERROR_PREFIX)) {
    return `the mail server could not be reached (${text})`;
  }
  return text;
}
