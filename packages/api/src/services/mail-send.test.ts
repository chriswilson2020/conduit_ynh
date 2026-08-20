import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { asc, eq } from "drizzle-orm";
import type { MailAccount, MailAccountCreateInput, SendMailInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { files, mailAccounts, mailAttachments, mailMessages, mailThreads } from "../db/schema.js";
import { saveBlob } from "./blobs.js";
import { createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { ArchivedError, ConflictError, NotFoundError, SmtpSendError } from "./errors.js";
import { archiveAccount, createAccount } from "./mail-accounts.js";
import type { MailCredentials } from "./mail-crypto.js";
import { ingestMessage } from "./mail-ingest.js";
import { SyncUnavailableError } from "./mail-sync.js";
import {
  sendMail,
  type SendMailDeps, type SendMailMessage, type SendMailSyncManager, type SendMailTransport,
} from "./mail-send.js";

const handle = openTestDatabase();
let actorId: string;
let otherUserId: string;
let dir: string;
let keyPath: string;
let dataDir: string;
let accountId: string;
let transport: FakeTransport;
let syncs: Map<string, FakeAccountSync>;
let warnings: { details: Record<string, unknown>; message: string }[];

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  otherUserId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-send-"));
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
  dataDir = path.join(dir, "data");
  transport = new FakeTransport();
  syncs = new Map();
  warnings = [];
  accountId = await makeAccount();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => { await handle.close(); });

// --- Fixtures ---------------------------------------------------------------

const baseAccount: MailAccountCreateInput = {
  label: "Work", email: "chris@example.com",
  imapHost: "mail.example.com", imapPort: 993, imapSecurity: "tls",
  smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "imap-secret", smtpPassword: "smtp-secret",
};

async function makeAccount(overrides: Partial<MailAccountCreateInput> = {}): Promise<string> {
  const account = await createAccount(handle.db, actorId, { ...baseAccount, ...overrides }, keyPath);
  return account.id;
}

/** Records what it was asked to send; `failure` makes the submission fail the
 * way a real transport does, after the message was fully composed. */
class FakeTransport implements SendMailTransport {
  readonly sent: SendMailMessage[] = [];
  readonly seenCredentials: MailCredentials[] = [];
  readonly seenAccounts: MailAccount[] = [];
  failure: Error | null = null;

  factory = (account: MailAccount, credentials: MailCredentials): SendMailTransport => {
    this.seenAccounts.push(account);
    this.seenCredentials.push(credentials);
    return this;
  };

  sendMail(message: SendMailMessage): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.sent.push(message);
    return Promise.resolve({ accepted: message.envelope.to });
  }

  /** The raw bytes of the only message sent, as a string. */
  rawText(): string {
    const [message] = this.sent;
    if (message === undefined) throw new Error("nothing was sent");
    return message.raw.toString("utf8");
  }
}

class FakeAccountSync {
  readonly appended: Buffer[] = [];
  failure: Error | null = null;

  appendSent(raw: Buffer | string): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.appended.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"));
    return Promise.resolve();
  }
}

const syncManager: SendMailSyncManager = { get: (id) => syncs.get(id) };

function deps(overrides: Partial<SendMailDeps> = {}): SendMailDeps {
  return {
    mailKeyPath: keyPath,
    transportFactory: transport.factory,
    syncManager,
    logger: {
      info: () => { /* quiet */ },
      warn: (details, message) => { warnings.push({ details, message }); },
      error: () => { /* quiet */ },
    },
    ...overrides,
  };
}

function input(overrides: Partial<SendMailInput> = {}): SendMailInput {
  return {
    accountId,
    to: [{ address: "alice@example.com", name: "Alice" }],
    cc: [], bcc: [],
    subject: "Hello Alice",
    bodyHtml: "<p>Hi Alice</p>",
    attachmentIds: [],
    ...overrides,
  };
}

/**
 * Undo quoted-printable so an assertion about the composed body is not
 * defeated by a soft line break landing in the middle of the string it looks
 * for. nodemailer picks quoted-printable for mostly-ASCII text parts.
 */
function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The Message-ID header of a raw message, without its angle brackets --
 * i.e. in the same shape mail_messages.message_id stores. */
function messageIdOf(raw: string): string {
  const match = /^Message-ID:\s*<([^>]+)>/im.exec(raw);
  if (match === null) throw new Error("the composed message carries no Message-ID");
  return match[1] as string;
}

function headerOf(raw: string, name: string): string | null {
  // Unfolds a header that nodemailer wrapped across lines (References gets
  // long fast).
  const unfolded = raw.split("\r\n\r\n")[0]?.replace(/\r\n[ \t]+/g, " ") ?? "";
  const match = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(unfolded);
  return match === null ? null : (match[1] as string).trim();
}

/**
 * How many descriptors this process holds, or null where that cannot be
 * asked. Linux only -- which is every machine this suite runs on (the dev
 * server and CI), and returning null rather than guessing is what keeps the
 * assertion honest anywhere else.
 */
function openFileDescriptors(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

async function storedMessages() {
  return await handle.db.select().from(mailMessages).orderBy(asc(mailMessages.createdAt));
}

/** A files row plus its blob, as the compose dialog's upload would leave it. */
async function makeUpload(
  uploaderId: string, options: { name?: string; mime?: string; body?: string } = {},
): Promise<string> {
  const company = await createCompany(handle.db, uploaderId, { name: `Acme ${Math.random()}` });
  const body = options.body ?? "attachment body";
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([Buffer.from(body, "utf8")]));
  const [row] = await handle.db.insert(files).values({
    originalName: options.name ?? "notes.txt", mime: options.mime ?? "text/plain",
    sizeBytes, sha256, uploaderUserId: uploaderId, companyId: company.id,
  }).returning({ id: files.id });
  if (row === undefined) throw new Error("file insert returned no row");
  return row.id;
}

// --- Tests ------------------------------------------------------------------

describe("sendMail", () => {
  it("sends the composed message and stores it through ingest", async () => {
    const sync = new FakeAccountSync();
    syncs.set(accountId, sync);

    const message = await sendMail(handle.db, dataDir, actorId, input(), deps());

    // Submitted with an explicit envelope: a raw message is passed to the
    // server unparsed, so without one it would have no recipients at all.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.envelope).toEqual({ from: "chris@example.com", to: ["alice@example.com"] });
    // The SMTP password, not the IMAP one (the account was created with both).
    expect(transport.seenCredentials[0]?.smtpPassword).toBe("smtp-secret");
    expect(transport.seenAccounts[0]?.id).toBe(accountId);

    // Stored by ingest, with everything ingest is responsible for.
    expect(message.direction).toBe("outbound");
    expect(message.seen).toBe(true);
    expect(message.folder).toBe("Sent");
    expect(message.imapUid).toBeNull();
    expect(message.fromAddr).toBe("chris@example.com");
    expect(message.toAddrs).toEqual([{ address: "alice@example.com", name: "Alice" }]);
    expect(message.subject).toBe("Hello Alice");

    const threads = await handle.db.select().from(mailThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageCount).toBe(1);
    expect(threads[0]?.subject).toBe("Hello Alice");
  });

  it("stores the very bytes it sent, Message-ID included", async () => {
    const sync = new FakeAccountSync();
    syncs.set(accountId, sync);

    const message = await sendMail(handle.db, dataDir, actorId, input(), deps());

    // One composition feeds all three consumers. If any of them re-composed,
    // nodemailer would generate a second Message-ID and the later Sent-folder
    // sighting of this message would arrive as a duplicate row instead of
    // deduping onto this one.
    const raw = transport.rawText();
    expect(message.messageId).toBe(messageIdOf(raw));
    expect(sync.appended).toHaveLength(1);
    expect(sync.appended[0]?.equals(transport.sent[0]?.raw as Buffer)).toBe(true);
  });

  it("stores nothing when the SMTP submission fails", async () => {
    transport.failure = new Error("connection: connect ECONNREFUSED 127.0.0.1:587");
    const sync = new FakeAccountSync();
    syncs.set(accountId, sync);

    await expect(sendMail(handle.db, dataDir, actorId, input(), deps())).rejects.toBeInstanceOf(SmtpSendError);

    expect(await storedMessages()).toHaveLength(0);
    expect(await handle.db.select().from(mailThreads)).toHaveLength(0);
    // Nothing was mirrored to Sent either -- the message does not exist.
    expect(sync.appended).toHaveLength(0);
  });

  it("explains an SMTP failure by its class", async () => {
    transport.failure = new Error("auth: Invalid login: 535 5.7.8 authentication failed");
    await expect(sendMail(handle.db, dataDir, actorId, input(), deps()))
      .rejects.toThrow(/rejected this account's credentials/);

    transport.failure = new Error("connection: connect ECONNREFUSED");
    await expect(sendMail(handle.db, dataDir, actorId, input(), deps()))
      .rejects.toThrow(/could not be reached/);

    // Anything the adapter could not classify is passed through as-is rather
    // than being given a class it does not have.
    transport.failure = new Error("Message failed: 550 5.7.1 relay denied");
    await expect(sendMail(handle.db, dataDir, actorId, input(), deps()))
      .rejects.toThrow(/550 5.7.1 relay denied/);
  });

  it("stores the message and warns when the Sent-folder APPEND fails", async () => {
    const sync = new FakeAccountSync();
    sync.failure = new Error("connection: Socket is already closed");
    syncs.set(accountId, sync);

    const message = await sendMail(handle.db, dataDir, actorId, input(), deps());

    // The send succeeded, so the DB record must land: the message simply will
    // not appear in the user's other mail clients' Sent folder.
    expect(message.id).toBeDefined();
    expect(await storedMessages()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/could not be appended/);
  });

  it("treats a sync in backoff (SyncUnavailableError) the same way", async () => {
    const sync = new FakeAccountSync();
    // appendSent rejects immediately, without touching the network, while the
    // account is backing off after a failed pass -- the designed behaviour.
    sync.failure = new SyncUnavailableError(accountId, "connection: ETIMEOUT");
    syncs.set(accountId, sync);

    await sendMail(handle.db, dataDir, actorId, input(), deps());

    expect(await storedMessages()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("sends and stores with no sync engine at all", async () => {
    // NODE_ENV=test, or a deployment whose sync is disabled: there is nothing
    // to APPEND through, and that is not a failure.
    await sendMail(handle.db, dataDir, actorId, input(), deps({ syncManager: null }));
    expect(await storedMessages()).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("delivers a Bcc through the envelope without disclosing it in the message", async () => {
    const message = await sendMail(
      handle.db, dataDir, actorId,
      input({ cc: [{ address: "carol@example.com" }], bcc: [{ address: "boss@example.com" }] }),
      deps(),
    );

    // Every recipient is on the envelope -- that is what actually delivers a
    // blind copy -- but the composed bytes carry no Bcc header, so the To and
    // Cc recipients never learn about it.
    expect(transport.sent[0]?.envelope.to)
      .toEqual(["alice@example.com", "carol@example.com", "boss@example.com"]);
    expect(headerOf(transport.rawText(), "Bcc")).toBeNull();
    expect(headerOf(transport.rawText(), "Cc")).toBe("carol@example.com");

    // The CRM's own record still names them -- the list travels to ingest
    // beside the bytes (bccOverride), because "what the recipients see" and
    // "what the sender's Sent record holds" are different lists, and every
    // ordinary mail client keeps the second one too.
    expect(message.ccAddrs).toEqual([{ address: "carol@example.com", name: null }]);
    expect(message.bccAddrs).toEqual([{ address: "boss@example.com", name: null }]);
  });

  it("keeps the stored Bcc when the Sent folder later re-sights the same message", async () => {
    const message = await sendMail(
      handle.db, dataDir, actorId,
      input({ bcc: [{ address: "boss@example.com" }] }), deps(),
    );

    // What the next Sent-folder pass does: the same bytes, now with a real
    // UID -- and those bytes carry no Bcc header at all. It must take the
    // duplicate path (record where the message was last seen) and leave the
    // rest of the row alone, or the send's own record would be erased by the
    // sync that was only supposed to fill in its UID.
    const resighted = await ingestMessage(handle.db, dataDir, {
      accountId, folder: "Sent", uid: 42,
      raw: transport.sent[0]?.raw as Buffer, flags: ["\\Seen"],
    });
    expect(resighted.created).toBe(false);
    expect(resighted.message.id).toBe(message.id);
    expect(resighted.message.imapUid).toBe(42);
    expect(resighted.message.bccAddrs).toEqual([{ address: "boss@example.com", name: null }]);
    expect(await storedMessages()).toHaveLength(1);
  });

  it("does not send the same address twice when it is on two lists", async () => {
    await sendMail(
      handle.db, dataDir, actorId,
      input({ cc: [{ address: "alice@example.com" }] }), deps(),
    );
    // Two RCPT TO commands for one address would deliver the message twice.
    expect(transport.sent[0]?.envelope.to).toEqual(["alice@example.com"]);
  });

  it("builds the In-Reply-To and References chain of a reply", async () => {
    const first = await sendMail(handle.db, dataDir, actorId, input(), deps());
    transport.sent.length = 0;

    const reply = await sendMail(
      handle.db, dataDir, actorId,
      input({ threadId: first.threadId, subject: "Re: Hello Alice", bodyHtml: "<p>Following up</p>" }),
      deps(),
    );

    const raw = transport.rawText();
    expect(headerOf(raw, "In-Reply-To")).toBe(`<${first.messageId}>`);
    expect(headerOf(raw, "References")).toBe(`<${first.messageId}>`);
    // Threaded onto the CRM's own thread, not onto whatever the headers would
    // have resolved to.
    expect(reply.threadId).toBe(first.threadId);
    const [thread] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, first.threadId));
    expect(thread?.messageCount).toBe(2);
  });

  it("accumulates References across a chain of replies", async () => {
    const first = await sendMail(handle.db, dataDir, actorId, input(), deps());
    const second = await sendMail(
      handle.db, dataDir, actorId, input({ threadId: first.threadId }), deps(),
    );
    transport.sent.length = 0;
    await sendMail(handle.db, dataDir, actorId, input({ threadId: first.threadId }), deps());

    const raw = transport.rawText();
    // The most recent message's own chain, plus itself.
    expect(headerOf(raw, "References")).toBe(`<${first.messageId}> <${second.messageId}>`);
    expect(headerOf(raw, "In-Reply-To")).toBe(`<${second.messageId}>`);
    expect(await storedMessages()).toHaveLength(3);
  });

  it("rejects a reply into a thread that does not exist", async () => {
    await expect(sendMail(
      handle.db, dataDir, actorId,
      input({ threadId: "00000000-0000-0000-0000-000000000000" }), deps(),
    )).rejects.toBeInstanceOf(NotFoundError);
    expect(transport.sent).toHaveLength(0);
  });

  it("applies the compose dialog's links to a new thread", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, {
      firstName: "Alice", lastName: "Example", companyId: company.id,
      emails: ["alice@example.com"], phones: [],
    });

    const message = await sendMail(
      handle.db, dataDir, actorId,
      input({ links: { companyId: company.id, contactId: contact.id } }), deps(),
    );

    const [thread] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, message.threadId));
    expect(thread?.companyId).toBe(company.id);
    expect(thread?.contactId).toBe(contact.id);
  });

  it("404s on another user's account without saying it exists", async () => {
    const foreign = await createAccount(handle.db, otherUserId, {
      ...baseAccount, email: "dana@example.com", label: "Dana",
    }, keyPath);

    await expect(sendMail(handle.db, dataDir, actorId, input({ accountId: foreign.id }), deps()))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses an archived account", async () => {
    await archiveAccount(handle.db, actorId, accountId);
    await expect(sendMail(handle.db, dataDir, actorId, input(), deps()))
      .rejects.toBeInstanceOf(ArchivedError);
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses an account whose last sync failed", async () => {
    // Written directly: only the sync engine ever flips an account to
    // `error`, and standing one up here would test the sync engine.
    await handle.db.update(mailAccounts).set({ status: "error", lastError: "auth: Invalid credentials" })
      .where(eq(mailAccounts.id, accountId));

    // A 409 with the stored error beats a 502 arriving a connect-timeout
    // later with nothing useful in it.
    await expect(sendMail(handle.db, dataDir, actorId, input(), deps()))
      .rejects.toBeInstanceOf(ConflictError);
    expect(transport.sent).toHaveLength(0);
  });

  it("sanitizes the body it sends as well as the body it stores", async () => {
    const hostile = '<p>Hi<script>alert(1)</script><a href="https://x.example/" onclick="steal()">link</a></p>';
    const message = await sendMail(handle.db, dataDir, actorId, input({ bodyHtml: hostile }), deps());

    expect(message.bodyHtml).not.toContain("script");
    expect(message.bodyHtml).not.toContain("onclick");
    expect(message.bodyHtml).toContain("https://x.example/");

    // What the recipient gets is the same document the CRM shows.
    const body = decodeQuotedPrintable(transport.rawText());
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain("onclick");
    expect(body).toContain("https://x.example/");
  });

  it("sends a plain-text alternative derived from the sanitized html", async () => {
    const message = await sendMail(
      handle.db, dataDir, actorId,
      input({ bodyHtml: '<p>Hi Alice</p><p>See <a href="https://x.example/">the page</a></p>' }),
      deps(),
    );

    const raw = transport.rawText();
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain");
    const decoded = decodeQuotedPrintable(raw);
    expect(decoded).toContain("Hi Alice");
    expect(decoded).toContain("the page <https://x.example/>");
    // Ingest keeps the text part as the message's searchable body.
    expect(message.bodyText).toContain("Hi Alice");
  });

  it("streams an attachment out of blob storage and stores it back through ingest", async () => {
    const fileId = await makeUpload(actorId, { name: "quote.txt", body: "the quoted price is 42" });

    const message = await sendMail(
      handle.db, dataDir, actorId, input({ attachmentIds: [fileId] }), deps(),
    );

    const raw = transport.rawText();
    expect(raw).toContain("quote.txt");
    expect(raw).toContain(Buffer.from("the quoted price is 42", "utf8").toString("base64"));

    const stored = await handle.db.select().from(mailAttachments)
      .where(eq(mailAttachments.messageId, message.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.filename).toBe("quote.txt");
    expect(stored[0]?.sizeBytes).toBe("the quoted price is 42".length);
  });

  it("holds no file descriptors of its own while a send with attachments fails", async () => {
    const fileId = await makeUpload(actorId, { name: "quote.txt" });
    // The failure that lives in the gap between loading attachments and
    // composing: credentials that cannot be decrypted. It is PERSISTENT (a
    // missing or rotated mail.key fails identically every time), so anything
    // leaked here accumulates for as long as the user keeps retrying.
    const broken = deps({ mailKeyPath: path.join(dir, "absent.key") });

    const before = openFileDescriptors();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(sendMail(
        handle.db, dataDir, actorId, input({ attachmentIds: [fileId] }), broken,
      )).rejects.toThrow();
    }
    const after = openFileDescriptors();
    if (before === null || after === null) return; // see openFileDescriptors
    // Attachments are handed to nodemailer as PATHS: nothing here opens a
    // file at all, so twenty failed sends move this number by nothing. (The
    // slack is for unrelated descriptors -- a pooled database connection --
    // that the surrounding work may legitimately open.)
    expect(after - before).toBeLessThan(5);
  });

  it("404s on an attachment belonging to someone else, before sending anything", async () => {
    const foreignFile = await makeUpload(otherUserId);

    await expect(sendMail(
      handle.db, dataDir, actorId, input({ attachmentIds: [foreignFile] }), deps(),
    )).rejects.toBeInstanceOf(NotFoundError);
    // Nothing was sent and nothing was stored: an ownership check that fires
    // after the submission would already have mailed the file out.
    expect(transport.sent).toHaveLength(0);
    expect(await storedMessages()).toHaveLength(0);
  });
});
