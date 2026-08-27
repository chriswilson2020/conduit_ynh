import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq, isNotNull, sql } from "drizzle-orm";
import type { MailAddress, SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
// The UTC-boundary test opens its own handle at a non-UTC session time zone;
// see it for why the zone cannot ride the shared pool.
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { createDatabase } from "../db/client.js";
import { resolveUser } from "../users.js";
import { events, mailAccounts, mailAttachments, mailMessages, mailThreadHides, mailThreads } from "../db/schema.js";
import { createCompany } from "./companies.js";
import { archiveContact, createContact } from "./contacts.js";
import { MailIngestError, NotFoundError } from "./errors.js";
import { ingestMessage, type IngestMessageLinks } from "./mail-ingest.js";
import { listThreads, unreadThreadCount } from "./mail-threads.js";
import { listEvents } from "./timeline.js";
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
  bccOverride?: MailAddress[];
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
    ...(opts.bccOverride === undefined ? {} : { bccOverride: opts.bccOverride }),
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

  it("stores bccOverride instead of the header for a message this system sent", async () => {
    // mail-send composes without a Bcc header (that is what makes a blind
    // copy blind) and stores the exact bytes it sent, so the recipients
    // arrive alongside them instead. Normalised on the way in: address
    // lowercased, a missing name stored as null, exactly like a parsed one.
    const sent = await ingest({
      messageId: "<sent@example.com>", from: "chris@example.com", to: "alice@example.com",
    }, {
      folder: "Sent",
      bccOverride: [{ address: "Secret@Example.COM" }, { address: "boss@example.com", name: "The Boss" }],
    });
    expect(sent.message.bccAddrs).toEqual([
      { address: "secret@example.com", name: null },
      { address: "boss@example.com", name: "The Boss" },
    ]);
  });

  it("lets bccOverride REPLACE a Bcc header rather than adding to it", async () => {
    const sent = await ingest({
      messageId: "<sent@example.com>", from: "chris@example.com", bcc: "fromheader@example.com",
    }, { folder: "Sent", bccOverride: [{ address: "override@example.com" }] });
    expect(sent.message.bccAddrs).toEqual([{ address: "override@example.com", name: null }]);
  });

  it("caps bccOverride like every other stored recipient list", async () => {
    const many: MailAddress[] = Array.from(
      { length: 250 }, (_unused, index) => ({ address: `bcc${index}@example.com` }),
    );
    const sent = await ingest({
      messageId: "<sent@example.com>", from: "chris@example.com",
    }, { folder: "Sent", bccOverride: many });
    // MAX_PARTICIPANTS: a caller-supplied list is bounded on the same terms
    // as a parsed header -- as jsonb it is a permanent row nothing can render.
    expect(sent.message.bccAddrs).toHaveLength(200);
    expect(sent.message.bccAddrs[0]).toEqual({ address: "bcc0@example.com", name: null });
  });

  it("ignores bccOverride outside the account's own sent folder", async () => {
    // The gate, not the field, decides whether a Bcc may be stored: an
    // override on an INBOX sighting changes nothing.
    const spoofed = await ingest({
      messageId: "<spoof@example.com>", from: "chris@example.com",
    }, { folder: "INBOX", bccOverride: [{ address: "victim@example.com" }] });
    expect(spoofed.message.direction).toBe("outbound");
    expect(spoofed.message.bccAddrs).toEqual([]);
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

// Spec Amendment 2 (Phase 4.3): NEW MAIL DOES NOT UNHIDE. The thread bump
// deliberately touches no mail_thread_hides row (mail-ingest.ts's own
// comment), so a viewer's filing survives the conversation growing --
// resurfacing-on-new-mail is snooze behaviour, explicitly deferred. Pinned
// two-sided so an ingest change cannot break either half silently.
describe("ingestMessage: hidden threads (Amendment 2)", () => {
  it("keeps a hidden thread hidden for the hider when new mail lands, while every other viewer's surfaces gain it", async () => {
    await handle.db.update(mailAccounts).set({ visibility: "shared" })
      .where(eq(mailAccounts.id, accountId));
    const otherId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    const root = await ingest({ messageId: ROOT_ID, subject: "Rollout" });
    const threadId = root.message.threadId;
    await handle.db.insert(mailThreadHides).values({ threadId, userId: actorId });

    await ingest({ messageId: CHILD_ID, inReplyTo: ROOT_ID, subject: "Re: Rollout" }, { uid: 2 });

    // The hider's filing stands: default list and badge stay clean...
    expect((await listThreads(handle.db, actorId)).items).toEqual([]);
    expect(await unreadThreadCount(handle.db, actorId)).toBe(0);
    // ...while their Hidden view carries the GROWN conversation (the new
    // message joined the thread, it just resurfaced nothing).
    const hiddenView = await listThreads(handle.db, actorId, { hidden: true });
    expect(hiddenView.items.map((t) => [t.id, t.messageCount])).toEqual([[threadId, 2]]);
    // The other viewer of the shared mailbox sees the new mail normally:
    // listed, two messages, unread, counted in their badge.
    const others = await listThreads(handle.db, otherId);
    expect(others.items.map((t) => [t.id, t.messageCount, t.unread])).toEqual([[threadId, 2, true]]);
    expect(await unreadThreadCount(handle.db, otherId)).toBe(1);
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

// ---------------------------------------------------------------------------
// Timeline entries (Phase 5 Task 4). Ingest is the only writer of mail events,
// and what it writes is a POINTER: the thread's record FKs plus mail_thread_id,
// with an EMPTY payload. The privacy rule this half has to hold is that
// nothing about the message reaches the events table at all -- an event row is
// readable by every user of the CRM, a thread is not (services/timeline.ts
// applies 4.2 visibility and 4.3 hides to decide who sees the row and renders
// the subject live). The read half's matrix lives in timeline.test.ts.
// ---------------------------------------------------------------------------
describe("ingestMessage: timeline entries", () => {
  /** Only the rows ingest could have written. The fixtures below create a
   * company and a contact, each of which emits its own `created` row, and
   * those are not what any assertion here is about. */
  async function eventRows() {
    return handle.db.select().from(events).where(isNotNull(events.mailThreadId))
      .orderBy(asc(events.createdAt), asc(events.id));
  }

  /** A contact whose address the auto-linker will match, plus the company that
   * link drags onto the thread -- the ordinary way a thread acquires the
   * record links that put its entry on a timeline. */
  async function linkedContact(email = "alice@example.com") {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, {
      firstName: "Alice", emails: [email], companyId: company.id,
    });
    return { companyId: company.id, contactId: contact.id };
  }

  it("emits mail_received as a pointer: the thread's record FKs, the thread id, and a payload with no keys", async () => {
    const { companyId, contactId } = await linkedContact();
    // Every field a leak could ride carries a distinctive marker, and they
    // are deliberately of DIFFERENT KINDS: a subject, a body phrase, a
    // sender address, a sender DISPLAY NAME and a RECIPIENT address. A
    // fixture whose From has no display name and whose To is the account's
    // own address cannot tell a column holding either of those from a column
    // holding nothing (spec review, O2).
    const result = await ingest({
      messageId: ROOT_ID,
      from: "Alicorn Featherstone <alice@example.com>",
      to: "chris@example.com, grimsby.underhay@example.net",
      subject: "Confidential salary review",
      text: "the body nobody else may read",
    });

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.verb).toBe("mail_received");
    expect(row?.mailThreadId).toBe(result.message.threadId);
    expect(row?.companyId).toBe(companyId);
    expect(row?.contactId).toBe(contactId);
    expect(row?.dealId).toBeNull();
    expect(row?.projectId).toBeNull();
    expect(row?.meetingId).toBeNull();
    // The account's owner: the closest thing a machine-written row has to a
    // person, and no wider than the row itself, which reaches nobody who
    // cannot already see the thread.
    expect(row?.actorUserId).toBe(actorId);

    // THE ASSERTION THAT MATTERS. Keys, not values: a future field named
    // anything at all -- subject, snippet, preview, from -- trips this the day
    // it is added, which a value check on today's field names would not.
    expect(Object.keys(row?.payload as Record<string, unknown>)).toEqual([]);
    // And nothing leaked into a column either. The whole row, serialised,
    // must not contain a syllable of the message -- subject, body, sender
    // address, sender name, or the recipient nobody outside the thread has
    // any business learning about.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("Confidential");
    expect(serialised).not.toContain("nobody else may read");
    expect(serialised).not.toContain("alice@example.com");
    expect(serialised).not.toContain("Alicorn");
    expect(serialised).not.toContain("grimsby.underhay@example.net");
  });

  it("emits mail_sent for an outbound message", async () => {
    await linkedContact();
    await ingest({
      messageId: ROOT_ID, from: "chris@example.com", to: "alice@example.com",
    }, { folder: "Sent" });

    const rows = await eventRows();
    expect(rows.map((row) => row.verb)).toEqual(["mail_sent"]);
    expect(Object.keys(rows[0]?.payload as Record<string, unknown>)).toEqual([]);
  });

  // The throttle. One event per (thread, verb) per UTC calendar day: without
  // it a fifty-message thread would bury a record's whole timeline, and the
  // Mail tab is where every message is read anyway.
  it("emits nothing for a second message of the same thread and direction on the same day", async () => {
    await linkedContact();
    await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    await ingest({
      messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com",
    }, { uid: 2 });

    const rows = await eventRows();
    expect(rows.map((row) => row.verb)).toEqual(["mail_received"]);
  });

  it("emits the opposite direction on the same day", async () => {
    await linkedContact();
    const first = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    const second = await ingest({
      messageId: CHILD_ID, references: [ROOT_ID], from: "chris@example.com", to: "alice@example.com",
    }, { uid: 2, folder: "Sent" });
    // Same conversation, so this is genuinely one thread with two entries.
    expect(second.message.threadId).toBe(first.message.threadId);

    const rows = await eventRows();
    expect(rows.map((row) => row.verb).sort()).toEqual(["mail_received", "mail_sent"]);
  });

  it("emits again the next day", async () => {
    await linkedContact();
    const first = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    // Move yesterday's entry out of today's window rather than moving the
    // clock: the boundary is the database's own `now()`, so backdating the
    // stored row is what exercises it honestly.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await handle.db.update(events).set({ createdAt: yesterday })
      .where(eq(events.mailThreadId, first.message.threadId));

    await ingest({
      messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com",
    }, { uid: 2 });
    const rows = await eventRows();
    expect(rows.map((row) => row.verb)).toEqual(["mail_received", "mail_received"]);
  });

  // THE DAY BOUNDARY IS UTC'S, AND THAT IS ENFORCED HERE RATHER THAN MERELY
  // STATED. Spec review found this the one green mutation: rewriting
  // emitMailEvent's boundary to a session-local `date_trunc('day', now())`
  // left the whole suite passing, because the dev and CI session TimeZone is
  // Etc/UTC and the two expressions coincide there. A future edit could
  // therefore make the throttle depend on whatever zone the server happens to
  // be configured with, and nothing would notice.
  //
  // Pacific/Kiritimati is UTC+14, the largest offset in the tz database, and
  // at +14 the local day boundary NEVER coincides with the UTC one: local
  // midnight lands 14 hours before UTC midnight for the first ten hours of
  // the UTC day and 10 hours after it for the remaining fourteen. Which way
  // it lands depends on the time of day the suite runs, so BOTH probes below
  // are asserted -- one of them contradicts a session-local boundary
  // whichever side it falls.
  //
  // The two instants are computed here from Date's own UTC accessors, not by
  // repeating the service's SQL: a copy of the expression would be mutated
  // alongside it and prove nothing.
  it("takes its day boundary from UTC, not from the server's session time zone", async () => {
    // A dedicated handle whose sessions all run at +14. The zone rides the
    // connection URL rather than a `SET TIME ZONE` on the shared pool, where
    // which of the two pooled connections a later query lands on is not
    // something a test can pin.
    const zoned = createDatabase(
      `${TEST_DATABASE_URL}?options=-c%20TimeZone%3DPacific%2FKiritimati`, 1,
    );
    try {
      expect((await zoned.db.execute<{ TimeZone: string }>(sql`SHOW TimeZone`))[0]?.TimeZone)
        .toBe("Pacific/Kiritimati");

      const now = new Date();
      const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const justInsideToday = new Date(utcMidnight + 30 * 60 * 1000);
      const justBeforeToday = new Date(utcMidnight - 30 * 60 * 1000);

      const { companyId } = await linkedContact();
      const [thread] = await handle.db.insert(mailThreads).values({
        subject: "Boundary", lastMessageAt: new Date(), messageCount: 0, companyId,
      }).returning({ id: mailThreads.id });
      const threadId = thread?.id ?? "";

      // PROBE 1: today's entry already exists, half an hour after UTC
      // midnight. A UTC boundary sees it and suppresses; a +14 local boundary
      // in the afternoon half of the UTC day starts AFTER it and would emit a
      // second entry for the same thread, verb and day.
      await handle.db.insert(events).values({
        verb: "mail_received", actorUserId: actorId, companyId,
        mailThreadId: threadId, payload: {}, createdAt: justInsideToday,
      });
      await ingestMessage(zoned.db, dataDir, {
        accountId, folder: "INBOX", uid: 1, flags: [], threadId,
        raw: rawMail({ messageId: ROOT_ID, from: "alice@example.com" }),
      });
      expect(await eventRows()).toHaveLength(1);

      // PROBE 2: the only entry is half an hour BEFORE UTC midnight, so it
      // belongs to yesterday and today's message must produce its own. A +14
      // local boundary in the morning half of the UTC day starts 14 hours
      // earlier, swallows that row into "today", and would suppress.
      await handle.db.update(events).set({ createdAt: justBeforeToday })
        .where(eq(events.mailThreadId, threadId));
      await ingestMessage(zoned.db, dataDir, {
        accountId, folder: "INBOX", uid: 2, flags: [], threadId,
        raw: rawMail({ messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com" }),
      });
      expect(await eventRows()).toHaveLength(2);
    } finally {
      await zoned.close();
    }
  });

  it("throttles per thread, so another conversation the same day gets its own entry", async () => {
    await linkedContact();
    await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    await ingest({ messageId: PARENT_ID, from: "alice@example.com" }, { uid: 2 });

    const rows = await eventRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.mailThreadId)).size).toBe(2);
  });

  // No record links means no timeline for the entry to appear on -- every
  // listEvents filter is one of the four record FKs -- so writing the row
  // would only grow the fastest-growing table in the schema for nothing.
  it("emits nothing for a thread with no record links", async () => {
    await ingest({ messageId: ROOT_ID, from: "stranger@elsewhere.example" });
    expect(await eventRows()).toHaveLength(0);
  });

  // The link check runs AFTER auto-linking, so the message that first links a
  // thread is itself the one that puts it on the timeline.
  it("starts emitting from the message that first links the thread", async () => {
    const first = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
    expect(await eventRows()).toHaveLength(0);

    await linkedContact();
    const second = await ingest({
      messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com",
    }, { uid: 2 });
    expect(second.message.threadId).toBe(first.message.threadId);
    const rows = await eventRows();
    expect(rows.map((row) => row.verb)).toEqual(["mail_received"]);
  });

  // A refetch or a second-folder sighting is not new mail.
  it("adds no entry for a re-sighting of a message already stored", async () => {
    await linkedContact();
    const raw = rawMail({ messageId: ROOT_ID, from: "alice@example.com" });
    await ingest(raw, { folder: "INBOX", uid: 1 });
    await ingest(raw, { folder: "Archive", uid: 9 });
    expect(await eventRows()).toHaveLength(1);
  });

  it("publishes the events key only when an entry was actually written", async () => {
    await linkedContact();
    const { hints, stop } = captureHints();
    try {
      const first = await ingest({ messageId: ROOT_ID, from: "alice@example.com" });
      expect(hints).toEqual([{
        keys: [
          ["mail-threads"], ["mail-thread", first.message.threadId], ["mail-unread"], ["events"],
        ],
      }]);
      // Throttled away: nothing on any timeline moved, so the rails must not
      // be told to refetch.
      await ingest({
        messageId: CHILD_ID, references: [ROOT_ID], from: "alice@example.com",
      }, { uid: 2 });
      expect(hints).toHaveLength(2);
      expect(hints[1]?.keys.some((key) => key[0] === "events")).toBe(false);
    } finally {
      stop();
    }
  });

  // The bridge between this file and timeline.test.ts's matrix, which builds
  // its event rows by hand: a REAL ingested message, read back through the
  // real read path, so the hand-written twin cannot drift out of step.
  it("reaches the linked record's timeline with the thread's live subject, and only for a viewer who may see it", async () => {
    const otherId = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    const { companyId } = await linkedContact();
    const result = await ingest({
      messageId: ROOT_ID, from: "alice@example.com", subject: "Re: Quarterly report",
    });

    const owner = await listEvents(handle.db, actorId, { companyId });
    const entry = owner.items.find((e) => e.verb === "mail_received");
    expect(entry?.mailThreadId).toBe(result.message.threadId);
    // Normalised once from the first message (mail-content.ts), so the "Re: "
    // is gone -- and it is read from the thread at request time, not from the
    // event.
    expect(entry?.mailSubject).toBe("Quarterly report");

    // The account is private and hers is not the mailbox: the row is absent
    // for her, not stubbed. The company's own "created" entry proves the page
    // loaded.
    const other = await listEvents(handle.db, otherId, { companyId });
    expect(other.items.some((e) => e.mailThreadId !== null)).toBe(false);
    expect(other.items.some((e) => e.verb === "created")).toBe(true);
  });
});
