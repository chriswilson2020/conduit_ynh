import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import type { SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts, mailAttachments, mailMessages, mailThreads } from "../db/schema.js";
import { createCompany } from "./companies.js";
import { archiveContact, createContact } from "./contacts.js";
import { MailIngestError, NotFoundError } from "./errors.js";
import { ingestMessage, type IngestMessageLinks } from "./mail-ingest.js";
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
  /** Subtype for the attachment-carrying multipart: related (inline images,
   * the default) or mixed (a plain file attachment). */
  multipart?: "related" | "mixed";
  /** Content-Transfer-Encoding for the text body; the payload is emitted
   * verbatim, so a quoted-printable fixture stays pure ASCII on the wire. */
  textEncoding?: "quoted-printable";
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

  const boundary = "CONDUITBOUND";
  const textPart = (): string => [
    "Content-Type: text/plain; charset=utf-8",
    ...(mail.textEncoding === undefined ? [] : [`Content-Transfer-Encoding: ${mail.textEncoding}`]),
    "", mail.text ?? "Body text.",
  ].join(CRLF);
  const joinParts = (parts: string[]): string =>
    parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) + `${CRLF}--${boundary}--`;

  const attachments = mail.attachments ?? [];
  if (attachments.length === 0) {
    // Both halves and nothing attached: multipart/alternative, the shape
    // almost every newsletter and mail client actually sends.
    if (mail.html !== undefined && mail.text !== undefined) {
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      const body = joinParts([textPart(), ["Content-Type: text/html; charset=utf-8", "", mail.html].join(CRLF)]);
      return [...headers, "", body, ""].join(CRLF);
    }
    if (mail.html !== undefined) {
      headers.push("Content-Type: text/html; charset=utf-8");
      return [...headers, "", mail.html, ""].join(CRLF);
    }
    headers.push("Content-Type: text/plain; charset=utf-8");
    if (mail.textEncoding !== undefined) headers.push(`Content-Transfer-Encoding: ${mail.textEncoding}`);
    return [...headers, "", mail.text ?? "Body text.", ""].join(CRLF);
  }

  headers.push(`Content-Type: multipart/${mail.multipart ?? "related"}; boundary="${boundary}"`);
  const parts: string[] = [];
  if (mail.html !== undefined) {
    parts.push(["Content-Type: text/html; charset=utf-8", "", mail.html].join(CRLF));
  } else {
    parts.push(textPart());
  }
  for (const att of attachments) {
    const partHeaders = [`Content-Type: ${att.mime}`, "Content-Transfer-Encoding: base64"];
    if (att.contentId !== undefined) partHeaders.push(`Content-ID: ${att.contentId}`);
    const disposition = att.disposition ?? "attachment";
    const filename = att.filename === undefined ? "" : `; filename="${att.filename}"`;
    partHeaders.push(`Content-Disposition: ${disposition}${filename}`);
    parts.push([...partHeaders, "", att.base64].join(CRLF));
  }
  return [...headers, "", joinParts(parts), ""].join(CRLF);
}

interface IngestOptions {
  folder?: string;
  uid?: number | null;
  flags?: string[];
  account?: string;
  threadId?: string;
  links?: IngestMessageLinks;
}

function ingest(mail: FixtureMail | string, opts: IngestOptions = {}) {
  return ingestMessage(handle.db, dataDir, {
    accountId: opts.account ?? accountId,
    folder: opts.folder ?? "INBOX",
    uid: opts.uid === undefined ? 1 : opts.uid,
    raw: typeof mail === "string" ? mail : rawMail(mail),
    flags: opts.flags ?? [],
    ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
    ...(opts.links === undefined ? {} : { links: opts.links }),
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

  it("sanitizes html and keeps mailparser's own text for a single-part html message", async () => {
    // A single-part text/html body is one of the shapes mailparser derives
    // `text` from itself (script content stripped), so body_text here is
    // ITS output, not ingest's htmlToText fallback -- the fallback case has
    // its own test below.
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

  it("derives body_text from the sanitized html when mailparser produces none", async () => {
    // multipart/related (html body + an inline image) is the shape where
    // mailparser leaves `text` undefined -- every html mail with an inline
    // image or an attachment -- so this is ingest's own htmlToText
    // fallback. The attachment placeholder must not leak into body_text
    // (it would end up in the search tsvector and the snippet).
    const result = await ingest({
      messageId: ROOT_ID,
      html: "<p>Hello <b>there</b></p><p><img src=\"cid:logo@example.com\"></p>",
      attachments: [{
        mime: "image/png", base64: "aGVsbG8gcG5n", filename: "logo.png",
        contentId: "<logo@example.com>", disposition: "inline",
      }],
    });
    expect(result.message.bodyHtml).toContain("mailattachment:");
    expect(result.message.bodyText).toBe("Hello there");
    expect(result.message.snippet).toBe("Hello there");
  });

  it("derives body_text from the html when a multipart/alternative's text half is blank", async () => {
    // The standard newsletter shape: a text/plain half that is empty or a
    // stub of whitespace. Treating that as real text leaves the message
    // unsearchable with an empty snippet, so blank counts as absent.
    const result = await ingest({
      messageId: ROOT_ID,
      text: "   ",
      html: "<p>Spring <b>sale</b> starts Monday</p>",
    });
    expect(result.message.bodyText).toBe("Spring sale starts Monday");
    expect(result.message.snippet).toBe("Spring sale starts Monday");
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

  it("rejects an unknown account, wrapped with the sync loop's context", async () => {
    // Every failure leaves ingest as a MailIngestError carrying
    // account/folder/uid (Task 5's poison-message contract is written
    // against that type); the original stays reachable on `cause`.
    const missing = "00000000-0000-0000-0000-000000000000";
    const error = await ingest({ messageId: ROOT_ID }, { account: missing, folder: "Archive", uid: 9 })
      .then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MailIngestError);
    const ingestError = error as MailIngestError;
    expect(ingestError.accountId).toBe(missing);
    expect(ingestError.folder).toBe("Archive");
    expect(ingestError.uid).toBe(9);
    expect(ingestError.cause).toBeInstanceOf(NotFoundError);
  });

  it("rejects a raw message past the whole-message size guard", async () => {
    // This cap bounds memory and disk (parse buffer, decoded parts, blob
    // writes) -- NOT parse time, which the header cap below handles.
    const oversized = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const error = await ingestMessage(handle.db, dataDir, {
      accountId, folder: "INBOX", uid: 1, raw: oversized, flags: [],
    }).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MailIngestError);
    expect((error as MailIngestError).reason).toContain("raw message");
    expect(await messageRows()).toHaveLength(0);
  });

  it("rejects an oversized header block", async () => {
    const raw = [
      "Message-ID: <big@example.com>",
      "From: alice@example.com",
      // Just past the 64KB cap -- the boundary is what this exercises, not
      // an absurd outlier that any cap would catch.
      `X-Filler: ${"y".repeat(70 * 1024)}`,
      "Subject: padded",
      "",
      "body",
      "",
    ].join("\r\n");
    const error = await ingest(raw).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MailIngestError);
    expect((error as MailIngestError).reason).toContain("header block");
    expect(await messageRows()).toHaveLength(0);
  });

  it("rejects a message whose To: header carries tens of thousands of addresses, without parsing it", async () => {
    // The measured cost driver: mailparser's address parsing is
    // superlinear, and 60k addresses took 6.1s of blocked event loop. The
    // addresses are deliberately short, reproducing that measurement's
    // ~709KB header -- under 3% of the whole-message cap (so that cap
    // never sees it) and under mailparser's own 1 MiB header drop (so the
    // parser would really parse it, slowly, rather than discard it). The
    // elapsed assertion is the point of the test: it only holds if the
    // guard rejects BEFORE simpleParser. 3s leaves ample room over the
    // sub-millisecond real path while staying far below 6.1s.
    const crowd = Array.from({ length: 60000 }, (_, i) => `f${i}@exa`).join(", ");
    // ~709KB: 11x the 64KB header cap, short of mailparser's 1 MiB drop.
    expect(crowd.length).toBeGreaterThan(64 * 1024);
    expect(crowd.length).toBeLessThan(1024 * 1024);
    const raw = ["Message-ID: <crowd@example.com>", "From: alice@example.com", `To: ${crowd}`, "", "hi", ""]
      .join("\r\n");
    const startedAt = Date.now();
    const error = await ingest(raw).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MailIngestError);
    expect((error as MailIngestError).reason).toContain("header block");
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("leaves a message with an ordinary large header block alone", async () => {
    // ~20KB of To: header: unusual but legitimate (a big distribution
    // list), and comfortably inside the 64KB bound.
    const recipients = Array.from({ length: 900 }, (_, i) => `person${i}@example.com`).join(", ");
    expect(recipients.length).toBeGreaterThan(20 * 1024);
    const result = await ingest({ messageId: ROOT_ID, to: recipients });
    expect(result.created).toBe(true);
    expect(result.message.toAddrs).toHaveLength(200);
  });

  it("decodes a quoted-printable body and an encoded-word subject", async () => {
    // Both are pure ASCII on the wire and decode to non-ASCII text, which
    // is exactly why they are worth a fixture: the stored values must be
    // the DECODED text, not the transfer encoding.
    const eAcute = String.fromCharCode(0xE9);
    const euro = String.fromCharCode(0x20AC);
    const result = await ingest({
      messageId: ROOT_ID,
      subject: "=?utf-8?Q?Caf=C3=A9_meeting?=",
      textEncoding: "quoted-printable",
      text: "Caf=C3=A9 costs =E2=82=AC10",
    });
    expect(result.message.subject).toBe(`Caf${eAcute} meeting`);
    expect(result.message.bodyText.trim()).toBe(`Caf${eAcute} costs ${euro}10`);
  });
});

describe("ingestMessage: caps on attacker-controlled fields", () => {
  it("caps an oversized subject and body, and stays deterministic across a refetch", async () => {
    // Uncapped, subject + body_text feed a generated tsvector that Postgres
    // refuses past 1MB -- the INSERT fails and the message can never land.
    const raw = rawMail({
      messageId: ROOT_ID,
      subject: "S".repeat(20000),
      text: "B".repeat(400 * 1024),
    });
    const first = await ingest(raw);
    expect(Buffer.byteLength(first.message.subject, "utf8")).toBe(4 * 1024);
    expect(Buffer.byteLength(first.message.bodyText, "utf8")).toBe(256 * 1024);

    const second = await ingest(raw, { uid: 2, folder: "Archive" });
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(await messageRows()).toHaveLength(1);
  });

  it("caps an oversized From display name", async () => {
    const result = await ingest({
      messageId: ROOT_ID, from: `"${"N".repeat(2000)}" <alice@example.com>`,
    });
    expect(result.message.fromName).not.toBeNull();
    expect(Buffer.byteLength(result.message.fromName ?? "", "utf8")).toBe(998);
    expect(result.message.fromAddr).toBe("alice@example.com");
  });

  it("hashes an oversized Message-ID instead of truncating it", async () => {
    // Truncation would map every long id sharing a prefix onto one stored
    // value, merging distinct messages into one row; and the btree index on
    // message_id rejects a 3000-byte key outright.
    const longId = `<${"x".repeat(3000)}@example.com>`;
    const raw = rawMail({ messageId: longId, subject: "Long id" });
    const first = await ingest(raw);
    expect(first.message.messageId).toMatch(/^sha256:[0-9a-f]{64}$/);

    const second = await ingest(raw, { uid: 2 });
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(await messageRows()).toHaveLength(1);

    // A DIFFERENT long id sharing the same first 998 bytes must stay a
    // separate message -- the property truncation would destroy.
    const sibling = await ingest(rawMail({ messageId: `<${"x".repeat(3000)}y@example.com>`, subject: "Long id" }),
      { uid: 3 });
    expect(sibling.created).toBe(true);
    expect(sibling.message.messageId).not.toBe(first.message.messageId);
  });

  it("threads a child onto a parent whose Message-ID was hashed for being oversized", async () => {
    // The two caps have to agree: the parent is stored under a hashed id,
    // so the child's References entry must be hashed the same way or the
    // ancestor is unfindable and the conversation splits.
    const longId = `<${"z".repeat(3000)}@example.com>`;
    const parent = await ingest({ messageId: longId, subject: "Long id parent" });
    const child = await ingest({ messageId: CHILD_ID, subject: "Re: Long id parent", references: [longId] },
      { uid: 2 });
    expect(child.message.threadId).toBe(parent.message.threadId);
    expect(child.message.referencesIds).toEqual([parent.message.messageId]);
    expect(await threads()).toHaveLength(1);
  });

  it("caps a monstrous recipient list, in storage and in the auto-link scan", async () => {
    // A huge To: header is both a storage bomb (jsonb) and a query bomb
    // (one bind parameter per address, plus a scan inside the global ingest
    // lock). The contact sits at the very end, past the cap, so this also
    // pins down that the cap -- not luck -- decides what auto-linking sees.
    // 1500 addresses is ~36KB of To: header: an order of magnitude past
    // MAX_PARTICIPANTS while still inside MAX_HEADER_BYTES, so the guard
    // this test is not about lets the message through to be capped here.
    const crowd = Array.from({ length: 1500 }, (_, i) => `filler${i}@example.com`);
    crowd.push("alice@example.com");
    await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const result = await ingest({
      messageId: ROOT_ID, from: "stranger@elsewhere.example", to: crowd.join(", "),
    });
    expect(result.message.toAddrs).toHaveLength(200);
    expect((await threadById(result.message.threadId)).contactId).toBeNull();
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

  it("records Bcc for outbound messages in the account's own sent folder only", async () => {
    const outbound = await ingest({
      messageId: "<sent@example.com>", from: "chris@example.com", bcc: "secret@example.com",
    }, { folder: "Sent" });
    expect(outbound.message.bccAddrs).toEqual([{ address: "secret@example.com", name: null }]);

    const inbound = await ingest({ messageId: ROOT_ID, bcc: "secret@example.com" });
    expect(inbound.message.bccAddrs).toEqual([]);
  });

  it("ignores a Bcc header on a message that merely SPOOFS the account's own address", async () => {
    // direction is a pure From comparison (spec), so anyone can forge it
    // into the INBOX. Without the sent-folder check that forgery would put
    // an attacker-chosen Bcc list into storage, rendered in the thread view
    // as if this user had sent it.
    const spoofed = await ingest({
      messageId: "<spoof@example.com>", from: "chris@example.com", bcc: "victim@example.com",
    }, { folder: "INBOX" });
    expect(spoofed.message.direction).toBe("outbound");
    expect(spoofed.message.bccAddrs).toEqual([]);
  });

  it("accepts a null imap_uid and lets a later sighting fill it in", async () => {
    // mail-send's own row lands with uid null (the APPENDed copy has no UID
    // until the Sent folder is next walked), and that later sighting is an
    // ordinary duplicate-path update.
    const raw = rawMail({ messageId: "<sent@example.com>", from: "chris@example.com" });
    const sent = await ingest(raw, { folder: "Sent", uid: null, flags: ["\\Seen"] });
    expect(sent.message.imapUid).toBeNull();
    const reconciled = await ingest(raw, { folder: "Sent", uid: 77, flags: ["\\Seen"] });
    expect(reconciled.created).toBe(false);
    expect(reconciled.message.id).toBe(sent.message.id);
    expect(reconciled.message.imapUid).toBe(77);
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

  it("caps a monstrous References header and still threads on the nearest ancestor", async () => {
    // Uncapped, every id becomes a bind parameter in the ancestor lookup
    // and a member of a quadratic dedupe scan. The ids are deliberately
    // SHORT, so the count is bounded by the HEADER cap (~6500 at ~10 bytes
    // each in 64KB): 5000 of them is a ~49KB header that really does reach
    // the parser rather than being rejected by the header guard first, and
    // the References cap takes it down to 50 -- all the right-to-left walk
    // ever consults.
    const parent = await ingest({ messageId: PARENT_ID });
    const bloated = Array.from({ length: 5000 }, (_, i) => `<a${i}@x>`);
    bloated.push(PARENT_ID);
    const reply = await ingest({ messageId: CHILD_ID, references: bloated }, { uid: 2 });
    expect(reply.message.threadId).toBe(parent.message.threadId);
    expect(reply.message.referencesIds).toHaveLength(50);
    expect(reply.message.referencesIds[49]).toBe("parent@example.com");
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

// mail-send (Task 6) does not get its own insert path -- it calls
// ingestMessage after SMTP + APPEND, with the sent folder, the raw MIME it
// sent, and these two hints. Everything below is that contract.
describe("ingestMessage: mail-send hints", () => {
  it("threads onto an explicit threadId instead of resolving from headers", async () => {
    const existing = await ingest({ messageId: ROOT_ID, subject: "Quarterly report" });
    // No References at all: header resolution would start a new thread.
    const reply = await ingest(
      { messageId: "<outbound@example.com>", from: "chris@example.com", subject: "Re: Quarterly report" },
      { threadId: existing.message.threadId, folder: "Sent", uid: null, flags: ["\\Seen"] },
    );
    expect(reply.message.threadId).toBe(existing.message.threadId);
    expect(await threads()).toHaveLength(1);
    expect((await threadById(existing.message.threadId)).messageCount).toBe(2);
  });

  it("rejects an unknown threadId rather than violating the foreign key", async () => {
    const error = await ingest({ messageId: ROOT_ID },
      { threadId: "00000000-0000-0000-0000-000000000000" })
      .then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(MailIngestError);
    expect((error as MailIngestError).cause).toBeInstanceOf(NotFoundError);
  });

  it("applies compose links to a thread it creates", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest(
      { messageId: "<outbound@example.com>", from: "chris@example.com", to: "bob@example.com" },
      { folder: "Sent", uid: null, flags: ["\\Seen"], links: { companyId: acme.id, contactId: bob.id } },
    );
    const thread = await threadById(result.message.threadId);
    expect(thread.companyId).toBe(acme.id);
    expect(thread.contactId).toBe(bob.id);
  });

  it("ignores compose links when the message joins an existing thread", async () => {
    const acme = await createCompany(handle.db, actorId, { name: "Acme" });
    const globex = await createCompany(handle.db, actorId, { name: "Globex" });
    const alice = await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const existing = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    await handle.db.update(mailThreads).set({ companyId: acme.id })
      .where(eq(mailThreads.id, existing.message.threadId));

    await ingest(
      { messageId: "<outbound@example.com>", from: "chris@example.com", references: [ROOT_ID] },
      { folder: "Sent", uid: null, flags: ["\\Seen"], links: { companyId: globex.id, contactId: bob.id } },
    );
    const thread = await threadById(existing.message.threadId);
    expect(thread.contactId).toBe(alice.id);
    expect(thread.companyId).toBe(acme.id);
  });

  it("suppresses auto-linking when the compose links already name a contact", async () => {
    await createContact(handle.db, actorId, { firstName: "Alice", emails: ["alice@example.com"] });
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest(
      { messageId: "<outbound@example.com>", from: "alice@example.com", to: "bob@example.com" },
      { links: { contactId: bob.id } },
    );
    expect((await threadById(result.message.threadId)).contactId).toBe(bob.id);
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

  it("gives a message with a MALFORMED Date header a stable synthetic id too", async () => {
    // mailparser synthesises `date = new Date()` for a present-but-
    // unparseable Date header, so a synthetic id hashed from the parsed
    // Date object changed on every parse: one message became a fresh row
    // and a fresh thread on every refetch. syntheticMessageId hashes the
    // raw header text instead.
    const raw = rawMail({ date: "not a date", subject: "Broken date", text: "hello" });
    const first = await ingest(raw);
    const second = await ingest(raw, { uid: 12, folder: "Archive" });
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(await messageRows()).toHaveLength(1);
    expect(await threads()).toHaveLength(1);
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

  it("stores a plain file attachment from a multipart/mixed message", async () => {
    const result = await ingest({
      messageId: ROOT_ID,
      multipart: "mixed",
      text: "Report attached.",
      attachments: [{ mime: "application/pdf", base64: PDF_B64, filename: "report.pdf" }],
    });
    const rows = await handle.db.select().from(mailAttachments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe("report.pdf");
    expect(rows[0]?.mime).toBe("application/pdf");
    expect(rows[0]?.isInline).toBe(false);
    expect(result.message.bodyText.trim()).toBe("Report attached.");
  });

  it("shares one blob between two messages carrying identical bytes, with a row each", async () => {
    const attachment = { mime: "application/pdf", base64: PDF_B64, filename: "report.pdf" } as const;
    await ingest({ messageId: ROOT_ID, multipart: "mixed", attachments: [attachment] });
    await ingest({ messageId: PARENT_ID, multipart: "mixed", attachments: [attachment] }, { uid: 2 });
    const rows = await handle.db.select().from(mailAttachments);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.blobPath).toBe(rows[1]?.blobPath);
    // Content-addressed storage: same bytes, one file (blobs.ts).
    expect(await readdir(path.join(dataDir, "files"))).toHaveLength(1);
  });

  it("skips attachments past the per-message limit and still ingests the message", async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      mime: "application/pdf", base64: PDF_B64, filename: `report${i}.pdf`,
    }));
    const result = await ingest({ messageId: ROOT_ID, multipart: "mixed", text: "many files", attachments: many });
    expect(result.created).toBe(true);
    expect(await handle.db.select().from(mailAttachments)).toHaveLength(50);
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

  it("leaves only an orphan blob behind when the transaction fails after the blob write", async () => {
    // The documented tradeoff: blob files are written inside the
    // transaction's scope but are not transactional. A failure after the
    // write leaves an unreferenced content-addressed file -- invisible to
    // the app, re-created identically on the next attempt -- rather than
    // paying for two-phase cleanup that could delete a shared blob.
    await handle.db.execute(sql.raw(
      "CREATE FUNCTION conduit_test_boom() RETURNS trigger AS $$ BEGIN "
      + "RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql",
    ));
    await handle.db.execute(sql.raw(
      "CREATE TRIGGER conduit_test_boom BEFORE INSERT ON mail_messages "
      + "FOR EACH ROW EXECUTE FUNCTION conduit_test_boom()",
    ));
    try {
      await expect(ingest({
        messageId: ROOT_ID, multipart: "mixed", attachments: [{ mime: "application/pdf", base64: PDF_B64 }],
      })).rejects.toBeInstanceOf(MailIngestError);
    } finally {
      await handle.db.execute(sql.raw("DROP TRIGGER conduit_test_boom ON mail_messages"));
      await handle.db.execute(sql.raw("DROP FUNCTION conduit_test_boom()"));
    }
    expect(await messageRows()).toHaveLength(0);
    expect(await threads()).toHaveLength(0);
    expect(await handle.db.select().from(mailAttachments)).toHaveLength(0);
    expect(await readdir(path.join(dataDir, "files"))).toHaveLength(1);
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

  it("prefers a To match over a Cc match", async () => {
    // Participant order is from -> to -> cc, and it is the ORDER that
    // decides, not which contact the database happens to return first:
    // Carol is created before Bob here, so a query-order-driven
    // implementation would pick the Cc contact.
    const carol = await createContact(handle.db, actorId, { firstName: "Carol", emails: ["carol@example.com"] });
    const bob = await createContact(handle.db, actorId, { firstName: "Bob", emails: ["bob@example.com"] });
    const result = await ingest({
      messageId: ROOT_ID, from: "nobody@elsewhere.example",
      to: "chris@example.com, bob@example.com", cc: "carol@example.com",
    });
    const thread = await threadById(result.message.threadId);
    expect(thread.contactId).toBe(bob.id);
    expect(thread.contactId).not.toBe(carol.id);
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
