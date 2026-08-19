import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import type { SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts, mailAttachments, mailMessages, mailThreads } from "../db/schema.js";
import { createCompany } from "./companies.js";
import { archiveContact, createContact } from "./contacts.js";
import { NotFoundError } from "./errors.js";
import { ingestMessage } from "./mail-ingest.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let actorId: string;
let accountId: string;
let dataDir: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-ingest-"));
  accountId = await makeAccount("chris@example.com", "Work");
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

// Inserted directly rather than via mail-accounts.ts: ingest never decrypts
// credentials (it only reads the account's own email, for direction
// detection), so a placeholder ciphertext keeps these tests independent of
// mail.key handling entirely.
async function makeAccount(email: string, label: string): Promise<string> {
  const [row] = await handle.db.insert(mailAccounts).values({
    userId: actorId, label, email,
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
    username: "chris", credentialsCiphertext: "v1:placeholder:placeholder:placeholder",
  }).returning({ id: mailAccounts.id });
  if (row === undefined) throw new Error("account insert returned no row");
  return row.id;
}

interface FixtureAttachment {
  mime: string;
  /** Base64 of the part's bytes -- fixtures stay ASCII whatever the payload is. */
  base64: string;
  filename?: string;
  contentId?: string;
  disposition?: "inline" | "attachment";
}

interface FixtureMail {
  messageId?: string;
  inReplyTo?: string;
  references?: string[] | string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Raw Date header value; omit for a message with no Date at all. */
  date?: string;
  text?: string;
  html?: string;
  attachments?: FixtureAttachment[];
}

const CRLF = "\r\n";

/** Build a raw RFC822 message. ASCII only -- no encoded-word or 8bit paths here. */
function rawMail(mail: FixtureMail = {}): string {
  const headers: string[] = [];
  if (mail.messageId !== undefined) headers.push(`Message-ID: ${mail.messageId}`);
  if (mail.inReplyTo !== undefined) headers.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references !== undefined) {
    const refs = Array.isArray(mail.references) ? mail.references.join(" ") : mail.references;
    headers.push(`References: ${refs}`);
  }
  headers.push(`From: ${mail.from ?? "Alice Example <alice@example.com>"}`);
  headers.push(`To: ${mail.to ?? "chris@example.com"}`);
  if (mail.cc !== undefined) headers.push(`Cc: ${mail.cc}`);
  if (mail.bcc !== undefined) headers.push(`Bcc: ${mail.bcc}`);
  headers.push(`Subject: ${mail.subject ?? "Quarterly report"}`);
  if (mail.date !== undefined) headers.push(`Date: ${mail.date}`);
  headers.push("MIME-Version: 1.0");

  const attachments = mail.attachments ?? [];
  if (attachments.length === 0) {
    if (mail.html !== undefined) {
      headers.push("Content-Type: text/html; charset=utf-8");
      return [...headers, "", mail.html, ""].join(CRLF);
    }
    headers.push("Content-Type: text/plain; charset=utf-8");
    return [...headers, "", mail.text ?? "Body text.", ""].join(CRLF);
  }

  const boundary = "CONDUITBOUND";
  headers.push(`Content-Type: multipart/related; boundary="${boundary}"`);
  const parts: string[] = [];
  if (mail.html !== undefined) {
    parts.push(["Content-Type: text/html; charset=utf-8", "", mail.html].join(CRLF));
  } else {
    parts.push(["Content-Type: text/plain; charset=utf-8", "", mail.text ?? "Body text."].join(CRLF));
  }
  for (const att of attachments) {
    const partHeaders = [`Content-Type: ${att.mime}`, "Content-Transfer-Encoding: base64"];
    if (att.contentId !== undefined) partHeaders.push(`Content-ID: ${att.contentId}`);
    const disposition = att.disposition ?? "attachment";
    const filename = att.filename === undefined ? "" : `; filename="${att.filename}"`;
    partHeaders.push(`Content-Disposition: ${disposition}${filename}`);
    parts.push([...partHeaders, "", att.base64].join(CRLF));
  }
  const body = parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) + `${CRLF}--${boundary}--`;
  return [...headers, "", body, ""].join(CRLF);
}

interface IngestOptions { folder?: string; uid?: number | null; flags?: string[]; account?: string }

function ingest(mail: FixtureMail | string, opts: IngestOptions = {}) {
  return ingestMessage(handle.db, dataDir, {
    accountId: opts.account ?? accountId,
    folder: opts.folder ?? "INBOX",
    uid: opts.uid === undefined ? 1 : opts.uid,
    raw: typeof mail === "string" ? mail : rawMail(mail),
    flags: opts.flags ?? [],
  });
}

async function threads() {
  return handle.db.select({
    id: mailThreads.id, subject: mailThreads.subject, lastMessageAt: mailThreads.lastMessageAt,
    messageCount: mailThreads.messageCount, contactId: mailThreads.contactId, companyId: mailThreads.companyId,
  }).from(mailThreads).orderBy(asc(mailThreads.createdAt));
}

async function threadById(id: string) {
  const [row] = await handle.db.select({
    id: mailThreads.id, subject: mailThreads.subject, lastMessageAt: mailThreads.lastMessageAt,
    messageCount: mailThreads.messageCount, contactId: mailThreads.contactId, companyId: mailThreads.companyId,
  }).from(mailThreads).where(eq(mailThreads.id, id));
  if (row === undefined) throw new Error(`no thread ${id}`);
  return row;
}

// Never selects mail_messages.search: the generated tsvector duplicates
// subject/body and has no business crossing the wire (service and tests
// alike use explicit column lists).
async function messageRows() {
  return handle.db.select({
    id: mailMessages.id, messageId: mailMessages.messageId, threadId: mailMessages.threadId,
    folder: mailMessages.folder, imapUid: mailMessages.imapUid, seen: mailMessages.seen,
    direction: mailMessages.direction, subject: mailMessages.subject,
  }).from(mailMessages).orderBy(asc(mailMessages.createdAt));
}

function captureHints(): { hints: SseHint[]; stop: () => void } {
  const hints: SseHint[] = [];
  const stop = subscribe((hint) => { hints.push(hint); });
  return { hints, stop };
}

const ROOT_ID = "<root@example.com>";
const PARENT_ID = "<parent@example.com>";
const CHILD_ID = "<child@example.com>";

describe("ingestMessage: parsing and message fields", () => {
  it("stores headers, addresses, snippet and a bracket-stripped message id", async () => {
    const result = await ingest({
      messageId: ROOT_ID, from: "Alice Example <Alice@Example.com>",
      to: "chris@example.com, Bob <BOB@example.com>", cc: "carol@example.com",
      subject: "Quarterly report", date: "Tue, 18 Aug 2026 10:00:00 +0000",
      text: "Line one.\nLine two.",
    }, { uid: 42, flags: ["\\Seen"] });

    expect(result.created).toBe(true);
    expect(result.message.messageId).toBe("root@example.com");
    expect(result.message.fromAddr).toBe("alice@example.com");
    expect(result.message.fromName).toBe("Alice Example");
    expect(result.message.toAddrs).toEqual([
      { address: "chris@example.com", name: null },
      { address: "bob@example.com", name: "Bob" },
    ]);
    expect(result.message.ccAddrs).toEqual([{ address: "carol@example.com", name: null }]);
    expect(result.message.bccAddrs).toEqual([]);
    expect(result.message.subject).toBe("Quarterly report");
    expect(result.message.bodyText).toContain("Line one.");
    expect(result.message.snippet).toBe("Line one. Line two.");
    expect(result.message.sentAt.toISOString()).toBe("2026-08-18T10:00:00.000Z");
    expect(result.message.folder).toBe("INBOX");
    expect(result.message.imapUid).toBe(42);
    expect(result.message.seen).toBe(true);
  });

  it("falls back to ingest time when the message carries no Date header", async () => {
    const before = Date.now();
    const result = await ingest({ messageId: ROOT_ID });
    expect(result.message.sentAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.message.sentAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("sanitizes html, derives body_text from it when there is no text part", async () => {
    const result = await ingest({
      messageId: ROOT_ID,
      html: "<p>Hello <b>there</b></p><script>alert(1)</script><p onclick=\"x()\">bye</p>",
    });
    // Body HTML is stored exactly as sanitized, trailing newline from the
    // wire included -- ingest normalises structure, not whitespace.
    expect(result.message.bodyHtml).toBe("<p>Hello <b>there</b></p><p>bye</p>\n");
    expect(result.message.bodyText).toBe("Hello there\n\nbye");
    expect(result.message.snippet).toBe("Hello there bye");
  });

  it("stores body_html as null for a text-only message", async () => {
    const result = await ingest({ messageId: ROOT_ID, text: "just text" });
    expect(result.message.bodyHtml).toBeNull();
  });

  it("stores an empty subject as the empty string, not a placeholder", async () => {
    const raw = rawMail({ messageId: ROOT_ID, subject: "" });
    const result = await ingest(raw);
    expect(result.message.subject).toBe("");
    expect((await threadById(result.message.threadId)).subject).toBe("");
  });

  it("rejects an unknown account", async () => {
    await expect(ingest({ messageId: ROOT_ID }, { account: "00000000-0000-0000-0000-000000000000" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ingestMessage: direction and seen", () => {
  it("marks a message from the account's own address outbound, case-insensitively", async () => {
    const result = await ingest({
      messageId: "<sent@example.com>", from: "Chris <CHRIS@Example.COM>", to: "alice@example.com",
    }, { folder: "Sent", flags: ["\\Seen"] });
    expect(result.message.direction).toBe("outbound");
  });

  it("marks a message from anyone else inbound", async () => {
    const result = await ingest({ messageId: ROOT_ID });
    expect(result.message.direction).toBe("inbound");
  });

  it("records Bcc for outbound messages only", async () => {
    const outbound = await ingest({
      messageId: "<sent@example.com>", from: "chris@example.com", bcc: "secret@example.com",
    }, { folder: "Sent" });
    expect(outbound.message.bccAddrs).toEqual([{ address: "secret@example.com", name: null }]);

    const inbound = await ingest({ messageId: ROOT_ID, bcc: "secret@example.com" });
    expect(inbound.message.bccAddrs).toEqual([]);
  });

  it("derives seen from the IMAP flags", async () => {
    const unseen = await ingest({ messageId: ROOT_ID }, { flags: ["\\Answered"] });
    expect(unseen.message.seen).toBe(false);
    const seen = await ingest({ messageId: PARENT_ID }, { flags: ["\\answered", "\\SEEN"] });
    expect(seen.message.seen).toBe(true);
  });
});

describe("ingestMessage: threading", () => {
  it("threads an in-order chain into one thread and bumps count and last_message_at", async () => {
    await ingest({ messageId: ROOT_ID, subject: "Quarterly report", date: "Tue, 18 Aug 2026 10:00:00 +0000" });
    await ingest({
      messageId: PARENT_ID, subject: "Re: Quarterly report", inReplyTo: ROOT_ID, references: [ROOT_ID],
      date: "Tue, 18 Aug 2026 11:00:00 +0000",
    }, { uid: 2 });
    await ingest({
      messageId: CHILD_ID, subject: "Re: Quarterly report", inReplyTo: PARENT_ID,
      references: [ROOT_ID, PARENT_ID], date: "Tue, 18 Aug 2026 12:00:00 +0000",
    }, { uid: 3 });

    const all = await threads();
    expect(all).toHaveLength(1);
    expect(all[0]?.messageCount).toBe(3);
    expect(all[0]?.subject).toBe("Quarterly report");
    expect(all[0]?.lastMessageAt.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  it("keeps last_message_at at the newest sent_at when an older message arrives later", async () => {
    const first = await ingest({ messageId: PARENT_ID, date: "Tue, 18 Aug 2026 12:00:00 +0000" });
    await ingest({
      messageId: CHILD_ID, references: [PARENT_ID], date: "Tue, 18 Aug 2026 09:00:00 +0000",
    }, { uid: 2 });
    const thread = await threadById(first.message.threadId);
    expect(thread.messageCount).toBe(2);
    expect(thread.lastMessageAt.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  it("prefers the rightmost resolvable reference over earlier ones", async () => {
    // Two separate conversations whose ids both appear in one References
    // header: the rightmost (nearest ancestor) must win.
    const older = await ingest({ messageId: ROOT_ID, subject: "Older" });
    const nearer = await ingest({ messageId: PARENT_ID, subject: "Nearer" }, { uid: 2 });
    const reply = await ingest({
      messageId: CHILD_ID, subject: "Re: Nearer", references: [ROOT_ID, PARENT_ID],
    }, { uid: 3 });
    expect(reply.message.threadId).toBe(nearer.message.threadId);
    expect(reply.message.threadId).not.toBe(older.message.threadId);
  });

  it("falls back to in_reply_to when no reference resolves", async () => {
    const parent = await ingest({ messageId: PARENT_ID });
    const reply = await ingest({
      messageId: CHILD_ID, references: ["<unknown@example.com>"], inReplyTo: PARENT_ID,
    }, { uid: 2 });
    expect(reply.message.threadId).toBe(parent.message.threadId);
  });

  it("starts a new thread when nothing resolves, even for an identical subject", async () => {
    await ingest({ messageId: ROOT_ID, subject: "Invoice", from: "alice@example.com" });
    await ingest({ messageId: PARENT_ID, subject: "Invoice", from: "mallory@elsewhere.example" }, { uid: 2 });
    expect(await threads()).toHaveLength(2);
  });

  it("normalises the thread subject but stores the raw subject on the message", async () => {
    const result = await ingest({ messageId: ROOT_ID, subject: "Re: Fwd:  Quarterly   report" });
    expect(result.message.subject).toBe("Re: Fwd:  Quarterly   report");
    expect((await threadById(result.message.threadId)).subject).toBe("Quarterly report");
  });

  it("converges out-of-order backfill: the parent keeps its own thread, later siblings join the child's", async () => {
    // Documented behaviour (plan, Task 4): a child ingested before its
    // parent starts a thread; the parent's own references resolve to
    // nothing, so it starts a second one; a later message referencing both
    // joins the CHILD's thread, because the walk is right-to-left.
    const child = await ingest({ messageId: CHILD_ID, references: [ROOT_ID, PARENT_ID] });
    const parent = await ingest({ messageId: PARENT_ID, references: [ROOT_ID] }, { uid: 2 });
    expect(parent.message.threadId).not.toBe(child.message.threadId);

    const sibling = await ingest({
      messageId: "<sibling@example.com>", references: [ROOT_ID, PARENT_ID, CHILD_ID],
    }, { uid: 3 });
    expect(sibling.message.threadId).toBe(child.message.threadId);
    expect((await threadById(child.message.threadId)).messageCount).toBe(2);
    expect((await threadById(parent.message.threadId)).messageCount).toBe(1);
  });

  it("accepts a single-value References header", async () => {
    const root = await ingest({ messageId: ROOT_ID });
    const reply = await ingest({ messageId: CHILD_ID, references: ROOT_ID }, { uid: 2 });
    expect(reply.message.threadId).toBe(root.message.threadId);
  });

  it("joins the thread of the same message ingested under another account (thread-starter included)", async () => {
    const otherAccountId = await makeAccount("alex@example.com", "Alex");
    const raw = rawMail({ messageId: ROOT_ID, to: "chris@example.com, alex@example.com" });
    const first = await ingest(raw);
    const second = await ingest(raw, { account: otherAccountId, uid: 7 });
    expect(second.created).toBe(true);
    expect(second.message.threadId).toBe(first.message.threadId);
    expect(await threads()).toHaveLength(1);
    expect((await threadById(first.message.threadId)).messageCount).toBe(2);
  });

  it("keeps two accounts ingesting the same message CONCURRENTLY on one thread", async () => {
    // The race the ingest advisory lock exists for: two AccountSyncs
    // (different accounts, same mailbox or both sides of one conversation)
    // reaching thread resolution at the same moment. Unserialised, neither
    // sees the other's uncommitted row, both conclude "no thread exists"
    // and one conversation becomes two threads -- an outcome no serial
    // order can produce. The pool holds two connections, so both
    // transactions really are open at once here.
    const otherAccountId = await makeAccount("alex@example.com", "Alex");
    const raw = rawMail({ messageId: ROOT_ID, to: "chris@example.com, alex@example.com" });
    const [first, second] = await Promise.all([
      ingest(raw),
      ingest(raw, { account: otherAccountId, uid: 7 }),
    ]);
    expect(first.message.threadId).toBe(second.message.threadId);
    expect(await threads()).toHaveLength(1);
    expect((await threadById(first.message.threadId)).messageCount).toBe(2);
  });

  it("threads across accounts through the references graph", async () => {
    const otherAccountId = await makeAccount("alex@example.com", "Alex");
    const root = await ingest({ messageId: ROOT_ID });
    const reply = await ingest(
      { messageId: CHILD_ID, references: [ROOT_ID] },
      { account: otherAccountId, uid: 2 },
    );
    expect(reply.message.threadId).toBe(root.message.threadId);
  });
});

describe("ingestMessage: synthetic ids and duplicates", () => {
  it("gives a message with no Message-ID a stable synthetic id across re-ingest", async () => {
    const raw = rawMail({ subject: "No id here", date: "Tue, 18 Aug 2026 10:00:00 +0000", text: "hello" });
    const first = await ingest(raw);
    expect(first.message.messageId.startsWith("sha256:")).toBe(true);
    const second = await ingest(raw, { uid: 99 });
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(await messageRows()).toHaveLength(1);
  });

  it("re-ingesting a message updates folder, uid and seen without re-threading or re-linking", async () => {
    await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const first = await ingest({ messageId: ROOT_ID }, { folder: "INBOX", uid: 5, flags: [] });
    const threadBefore = await threadById(first.message.threadId);

    const again = await ingest({ messageId: ROOT_ID }, { folder: "Archive", uid: 8, flags: ["\\Seen"] });
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    expect(again.message.folder).toBe("Archive");
    expect(again.message.imapUid).toBe(8);
    expect(again.message.seen).toBe(true);

    const threadAfter = await threadById(first.message.threadId);
    expect(threadAfter.messageCount).toBe(threadBefore.messageCount);
    expect(threadAfter.contactId).toBe(threadBefore.contactId);
    expect(await threads()).toHaveLength(1);
  });

  it("does not re-run auto-linking on the duplicate path", async () => {
    const first = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    // Contact created only AFTER the first sighting: a refetch must not
    // retroactively link the thread (auto-link runs on new messages only).
    await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    await ingest({ messageId: ROOT_ID }, { folder: "Archive", uid: 8 });
    expect((await threadById(first.message.threadId)).contactId).toBeNull();
  });

  it("keeps one row when the same message is seen in two folders", async () => {
    const raw = rawMail({ messageId: ROOT_ID });
    await ingest(raw, { folder: "INBOX", uid: 3 });
    await ingest(raw, { folder: "Archive", uid: 11 });
    const rows = await messageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.folder).toBe("Archive");
  });

  it("stores the same message once per account, threaded together", async () => {
    const otherAccountId = await makeAccount("alex@example.com", "Alex");
    const raw = rawMail({ messageId: ROOT_ID });
    await ingest(raw);
    await ingest(raw, { account: otherAccountId, uid: 2 });
    await ingest(raw, { account: otherAccountId, uid: 2 });
    expect(await messageRows()).toHaveLength(2);
    expect(await threads()).toHaveLength(1);
  });
});

describe("ingestMessage: attachments", () => {
  // "hello png" / "report" as base64 -- ASCII fixtures, real bytes on disk.
  const PNG_B64 = "aGVsbG8gcG5n";
  const PDF_B64 = "cmVwb3J0";

  it("stores an inline attachment and rewrites its cid reference to the placeholder scheme", async () => {
    const result = await ingest({
      messageId: ROOT_ID,
      html: "<p>Logo: <img src=\"cid:logo@example.com\"></p>",
      attachments: [{
        mime: "image/png", base64: PNG_B64, filename: "logo.png",
        contentId: "<logo@example.com>", disposition: "inline",
      }],
    });

    const rows = await handle.db.select().from(mailAttachments);
    expect(rows).toHaveLength(1);
    const attachment = rows[0];
    if (attachment === undefined) throw new Error("no attachment row");
    expect(attachment.messageId).toBe(result.message.id);
    expect(attachment.filename).toBe("logo.png");
    expect(attachment.mime).toBe("image/png");
    expect(attachment.sizeBytes).toBe(9);
    expect(attachment.contentId).toBe("logo@example.com");
    expect(attachment.isInline).toBe(true);
    expect(result.message.bodyHtml).toContain(`src="mailattachment:${attachment.id}"`);
    expect(result.message.bodyHtml).not.toContain("cid:");

    // blob_path is the blobs-service key (a bare sha256), never an absolute
    // path -- the file itself lives under dataDir/files/<sha256>.
    expect(attachment.blobPath).toMatch(/^[0-9a-f]{64}$/);
    const stored = await readFile(path.join(dataDir, "files", attachment.blobPath));
    expect(stored.toString("utf8")).toBe("hello png");
  });

  it("stores a non-inline attachment and drops an unmapped cid image", async () => {
    const result = await ingest({
      messageId: ROOT_ID,
      html: "<p>See <img src=\"cid:missing@example.com\"> attached</p>",
      attachments: [{ mime: "application/pdf", base64: PDF_B64, filename: "report.pdf" }],
    });
    const rows = await handle.db.select().from(mailAttachments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isInline).toBe(false);
    expect(rows[0]?.contentId).toBeNull();
    expect(result.message.bodyHtml).toBe("<p>See  attached</p>");
  });

  it("names an attachment that arrives without a filename", async () => {
    await ingest({
      messageId: ROOT_ID,
      attachments: [{ mime: "application/octet-stream", base64: PDF_B64 }],
    });
    const rows = await handle.db.select().from(mailAttachments);
    expect(rows[0]?.filename).toBe("attachment");
  });

  it("writes no attachment rows on the duplicate path", async () => {
    const raw = rawMail({
      messageId: ROOT_ID,
      html: "<p><img src=\"cid:logo@example.com\"></p>",
      attachments: [{
        mime: "image/png", base64: PNG_B64, filename: "logo.png",
        contentId: "<logo@example.com>", disposition: "inline",
      }],
    });
    await ingest(raw);
    await ingest(raw, { folder: "Archive", uid: 4 });
    expect(await handle.db.select().from(mailAttachments)).toHaveLength(1);
  });
});

describe("ingestMessage: auto-linking", () => {
  it("links the thread to a contact matching the From address", async () => {
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["Alice@Example.com"] });
    const result = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    expect((await threadById(result.message.threadId)).contactId).toBe(alice.id);
  });

  it("links via a To address when From does not match", async () => {
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest({
      messageId: ROOT_ID, from: "nobody@elsewhere.example", to: "chris@example.com, bob@example.com",
    });
    expect((await threadById(result.message.threadId)).contactId).toBe(bob.id);
  });

  it("links via a Cc address when neither From nor To matches", async () => {
    const carol = await createContact(handle.db, actorId, { firstName: "Carol", emails: ["carol@example.com"] });
    const result = await ingest({
      messageId: ROOT_ID, from: "nobody@elsewhere.example", to: "chris@example.com", cc: "carol@example.com",
    });
    expect((await threadById(result.message.threadId)).contactId).toBe(carol.id);
  });

  it("prefers the From match over a To match", async () => {
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest({ messageId: ROOT_ID, from: "alice@example.com", to: "bob@example.com" });
    expect((await threadById(result.message.threadId)).contactId).toBe(alice.id);
  });

  it("leaves the thread unlinked when no participant matches a contact", async () => {
    await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest({ messageId: ROOT_ID, from: "stranger@elsewhere.example", to: "chris@example.com" });
    const thread = await threadById(result.message.threadId);
    expect(thread.contactId).toBeNull();
    expect(thread.companyId).toBeNull();
  });

  it("skips archived contacts", async () => {
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    await archiveContact(handle.db, actorId, alice.id);
    const result = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    expect((await threadById(result.message.threadId)).contactId).toBeNull();
  });

  it("fills company_id from the matched contact's company", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    const alice = await createContact(handle.db, actorId, {
      firstName: "Alice", emails: ["alice@example.com"], companyId: acme.id,
    });
    const result = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    const thread = await threadById(result.message.threadId);
    expect(thread.contactId).toBe(alice.id);
    expect(thread.companyId).toBe(acme.id);
  });

  it("leaves company_id null when the matched contact has no company", async () => {
    await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const result = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    expect((await threadById(result.message.threadId)).companyId).toBeNull();
  });

  it("never overwrites a company_id that is already set", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    const globex = await createCompany(handle.db, actorId, { name: "Globex" });
    await createContact(handle.db, actorId, {
      firstName: "Alice", emails: ["alice@example.com"], companyId: acme.id,
    });
    const first = await ingest({ messageId: ROOT_ID, from: "stranger@elsewhere.example" });
    await handle.db.update(mailThreads).set({ companyId: globex.id })
      .where(eq(mailThreads.id, first.message.threadId));

    await ingest({ messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com" }, { uid: 2 });
    const thread = await threadById(first.message.threadId);
    expect(thread.companyId).toBe(globex.id);
  });

  it("never overwrites an existing contact link", async () => {
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const first = await ingest({ messageId: ROOT_ID, from: "stranger@elsewhere.example" });
    await handle.db.update(mailThreads).set({ contactId: bob.id })
      .where(eq(mailThreads.id, first.message.threadId));

    await ingest({ messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com" }, { uid: 2 });
    const thread = await threadById(first.message.threadId);
    expect(thread.contactId).toBe(bob.id);
    expect(alice.id).not.toBe(bob.id);
  });

  it("links a still-unlinked thread when a later message brings a matching participant", async () => {
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const first = await ingest({ messageId: ROOT_ID, from: "stranger@elsewhere.example" });
    expect((await threadById(first.message.threadId)).contactId).toBeNull();
    await ingest({ messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com" }, { uid: 2 });
    expect((await threadById(first.message.threadId)).contactId).toBe(alice.id);
  });
});

describe("ingestMessage: SSE", () => {
  it("publishes thread, thread-detail and unread hints after a new message commits", async () => {
    const { hints, stop } = captureHints();
    try {
      const result = await ingest({ messageId: ROOT_ID });
      expect(hints).toEqual([{
        keys: [["mail-threads"], ["mail-thread", result.message.threadId], ["mail-unread"]],
      }]);
    } finally {
      stop();
    }
  });

  it("publishes on a duplicate only when the sighting actually changed something", async () => {
    const raw = rawMail({ messageId: ROOT_ID });
    await ingest(raw, { folder: "INBOX", uid: 3, flags: [] });
    const { hints, stop } = captureHints();
    try {
      await ingest(raw, { folder: "INBOX", uid: 3, flags: [] });
      expect(hints).toHaveLength(0);
      await ingest(raw, { folder: "INBOX", uid: 3, flags: ["\\Seen"] });
      expect(hints).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
