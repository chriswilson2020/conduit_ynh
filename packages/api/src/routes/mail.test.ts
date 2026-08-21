import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  contactSchema, dealSchema, errorResponseSchema, listResponseSchema, pipelineSchema, stageSchema,
  mailAccountSchema, mailAccountListSchema, mailAccountTestResultSchema, mailThreadSchema,
  mailThreadListItemSchema, mailThreadDetailSchema, markThreadReadResponseSchema,
  mailMessageSchema, mailUnreadCountSchema,
  mailUnreadFolderCountsSchema, mailAccountFolderSchema, bulkThreadResultSchema,
  emailTemplateSchema, searchResultsSchema,
  type MailAccountCreateInput, type MailAccountSyncStats, type SendMailInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { resolveUser } from "../users.js";
import {
  mailAccountFolders, mailAccounts, mailAttachments, mailMessages, mailThreadHides, mailThreads,
} from "../db/schema.js";
import { saveBlob } from "../services/blobs.js";
import type { SendMailMessage, SendMailTransport } from "../services/mail-send.js";
import type { MailRouteSyncManager } from "./mail.js";

const handle = openTestDatabase();

let dir: string;
let dataDir: string;
let keyPath: string;
let transport: FakeTransport;
let syncs: Map<string, FakeAccountSync>;
/** Account ids the routes asked for a pass (the folder picker's enable path).
 * syncNow is fire-and-forget by contract, so recording the ASK is the whole
 * assertion -- nothing here waits for a pass that a real engine may not run
 * for minutes. */
let syncNowCalls: string[];
/** Swapped for `() => null` by the tests that need the no-sync-engine shape. */
let manager: MailRouteSyncManager;

beforeEach(async () => {
  await truncateAll(handle);
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-routes-"));
  dataDir = path.join(dir, "data");
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
  transport = new FakeTransport();
  syncs = new Map();
  syncNowCalls = [];
  manager = {
    get: (id) => syncs.get(id),
    syncNow: (id) => { syncNowCalls.push(id); return Promise.resolve(); },
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};
// A second identity, for the foreign-account 404s. Resolved by the same
// onRequest hook as the first, so no explicit user seeding is needed.
const otherHeaders = {
  "ynh-user": "dana",
  "ynh-user-email": "dana@example.com",
  "ynh-user-fullname": "Dana Rae",
};

const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

// --- Fakes -----------------------------------------------------------------

class FakeTransport implements SendMailTransport {
  readonly sent: SendMailMessage[] = [];
  failure: Error | null = null;

  factory = (): SendMailTransport => this;

  sendMail(message: SendMailMessage): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.sent.push(message);
    return Promise.resolve({ accepted: message.envelope.to });
  }
}

/** Stands in for one account's AccountSync. Records what the routes asked of
 * it, and can reject the way a real one in backoff does. */
class FakeAccountSync {
  readonly appended: Buffer[] = [];
  readonly markSeenCalls: { folder: string; uids: number[] }[] = [];
  readonly moveCalls: { folder: string; uids: number[]; targetFolder: string }[] = [];
  markSeenFailure: Error | null = null;
  /** Set to make the queued MOVE reject, the way a server refusal reaches the
   * move service (which then compensates and fails those threads). */
  moveFailure: Error | null = null;
  stats: MailAccountSyncStats = {
    passes: 3, failures: 1, ingested: 12, poisonSkips: 0, idleWakes: 2, attempt: 0, stopped: false,
  };

  appendSent(raw: Buffer | string): Promise<void> {
    this.appended.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"));
    return Promise.resolve();
  }

  markSeen(folder: string, uids: readonly number[]): Promise<void> {
    this.markSeenCalls.push({ folder, uids: [...uids] });
    return this.markSeenFailure === null ? Promise.resolve() : Promise.reject(this.markSeenFailure);
  }

  moveMessages(folder: string, uids: readonly number[], targetFolder: string): Promise<void> {
    this.moveCalls.push({ folder, uids: [...uids], targetFolder });
    return this.moveFailure === null ? Promise.resolve() : Promise.reject(this.moveFailure);
  }
}

// --- App -------------------------------------------------------------------

function config(basePath = "/"): Config {
  return {
    nodeEnv: "test", port: 0, databaseUrl: "unused-in-tests", basePath,
    version: "0.1.0-test", devUser: null, dataDir, defaultCurrency: "EUR",
    mailKeyPath: keyPath, mailTlsRejectUnauthorized: true,
  };
}

interface AppOptions {
  basePath?: string;
  /** Defaults to the fake manager; pass `() => null` for the no-engine case. */
  syncManager?: () => MailRouteSyncManager | null;
}

async function app(options: AppOptions = {}) {
  return buildApp({
    config: config(options.basePath),
    db: handle.db,
    dataDir,
    mail: {
      syncManager: options.syncManager ?? (() => manager),
      transportFactory: transport.factory,
    },
  });
}

type App = Awaited<ReturnType<typeof app>>;

// --- Fixtures ---------------------------------------------------------------

const baseAccountInput: MailAccountCreateInput = {
  label: "Work", email: "chris@example.com",
  imapHost: "mail.example.com", imapPort: 993, imapSecurity: "tls",
  smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "imap-secret",
};

async function makeAccount(
  a: App, overrides: Partial<MailAccountCreateInput> = {}, headers = authHeaders,
) {
  const response = await a.inject({
    method: "POST", url: "/api/mail/accounts", headers, payload: { ...baseAccountInput, ...overrides },
  });
  expect(response.statusCode).toBe(201);
  return mailAccountSchema.parse(response.json());
}

interface ThreadSeed {
  subject?: string;
  lastMessageAt: Date;
  companyId?: string; contactId?: string; dealId?: string; projectId?: string;
}

async function seedThread(seed: ThreadSeed): Promise<string> {
  const [row] = await handle.db.insert(mailThreads).values({
    subject: seed.subject ?? "Quarterly review",
    lastMessageAt: seed.lastMessageAt,
    messageCount: 1,
    companyId: seed.companyId ?? null, contactId: seed.contactId ?? null,
    dealId: seed.dealId ?? null, projectId: seed.projectId ?? null,
  }).returning();
  if (row === undefined) throw new Error("seedThread: no row");
  return row.id;
}

/** The user row behind a set of request headers. resolveUser is the SAME
 * upsert the auth hook runs on every request, so calling it here neither
 * duplicates a user nor depends on whether that identity has sent a request
 * yet -- which matters because hide rows carry a user FK and most fixtures
 * seed before the first inject(). */
async function userIdFor(headers: typeof authHeaders): Promise<string> {
  return (await resolveUser(handle.db, {
    username: headers["ynh-user"], email: headers["ynh-user-email"], fullName: headers["ynh-user-fullname"],
  })).id;
}

/** One per-user hide row -- the Phase 4.3 successor to this file's old
 * `archived: true` thread seed: hiding is per-actor now, so a fixture must
 * SAY whose views it is filing the thread out of. */
async function hideFor(
  threadId: string, headers: typeof authHeaders = authHeaders, hiddenAt?: Date,
): Promise<void> {
  await handle.db.insert(mailThreadHides).values({
    threadId, userId: await userIdFor(headers),
    ...(hiddenAt === undefined ? {} : { hiddenAt }),
  });
}

/** The viewer's hide row for a thread, or undefined -- what the per-user
 * assertions below read instead of the retired thread-global column. */
async function hideRow(threadId: string, headers: typeof authHeaders = authHeaders) {
  const userId = await userIdFor(headers);
  const [row] = await handle.db.select().from(mailThreadHides).where(
    and(eq(mailThreadHides.threadId, threadId), eq(mailThreadHides.userId, userId)),
  );
  return row;
}

interface MessageSeed {
  fromAddr?: string;
  fromName?: string | null;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  snippet?: string;
  sentAt: Date;
  folder?: string;
  imapUid?: number | null;
  seen?: boolean;
}

async function seedMessage(threadId: string, accountId: string, seed: MessageSeed): Promise<string> {
  const [row] = await handle.db.insert(mailMessages).values({
    accountId, threadId,
    messageId: `<${randomUUID()}@example.com>`,
    inReplyTo: null, referencesIds: [],
    fromAddr: seed.fromAddr ?? "alice@example.com",
    fromName: seed.fromName ?? "Alice",
    toAddrs: [{ address: "chris@example.com", name: "Chris" }], ccAddrs: [], bccAddrs: [],
    subject: seed.subject ?? "Quarterly review",
    bodyText: seed.bodyText ?? "Body text",
    bodyHtml: seed.bodyHtml === undefined ? "<p>Body text</p>" : seed.bodyHtml,
    snippet: seed.snippet ?? "Body text",
    sentAt: seed.sentAt,
    folder: seed.folder ?? "INBOX",
    imapUid: seed.imapUid === undefined ? 10 : seed.imapUid,
    seen: seed.seen ?? true,
    direction: "inbound",
  }).returning();
  if (row === undefined) throw new Error("seedMessage: no row");
  return row.id;
}

/**
 * `count` messages in one INSERT, a minute apart from `start`, returned in
 * reading order (sent_at ascending) -- the detail-cap tests need fifty-plus
 * rows, and fifty round trips per fixture would double this file's runtime
 * for nothing. Same row shape seedMessage writes, minus the per-message
 * options none of those tests vary.
 */
async function seedMessageRun(
  threadId: string, accountId: string, count: number, start: Date,
  overrides: Partial<Pick<MessageSeed, "seen" | "imapUid">> = {},
): Promise<string[]> {
  const rows = await handle.db.insert(mailMessages).values(
    Array.from({ length: count }, (_, index) => ({
      accountId, threadId,
      messageId: `<${randomUUID()}@example.com>`,
      inReplyTo: null, referencesIds: [],
      fromAddr: "alice@example.com", fromName: "Alice",
      toAddrs: [{ address: "chris@example.com", name: "Chris" }], ccAddrs: [], bccAddrs: [],
      subject: "Quarterly review", bodyText: `Body ${index}`,
      bodyHtml: `<p>Body ${index}</p>`, snippet: `Body ${index}`,
      sentAt: new Date(start.getTime() + index * 60_000),
      folder: "INBOX",
      imapUid: overrides.imapUid === undefined ? 10 + index : overrides.imapUid,
      seen: overrides.seen ?? true,
      direction: "inbound" as const,
    })),
  ).returning({ id: mailMessages.id, sentAt: mailMessages.sentAt });
  return rows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()).map((row) => row.id);
}

/** Write real bytes into the blob store and register them as an attachment of
 * `messageId`, so the download/inline routes have something to stream. */
async function seedAttachment(
  messageId: string, opts: { filename?: string; mime?: string; isInline?: boolean; body?: string } = {},
): Promise<{ id: string; body: string }> {
  const body = opts.body ?? "attachment-bytes";
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from(Buffer.from(body, "utf8")));
  const [row] = await handle.db.insert(mailAttachments).values({
    messageId,
    filename: opts.filename ?? "invoice.pdf",
    mime: opts.mime ?? "application/pdf",
    sizeBytes, blobPath: sha256,
    contentId: opts.isInline === true ? "logo@example.com" : null,
    isInline: opts.isInline ?? false,
  }).returning();
  if (row === undefined) throw new Error("seedAttachment: no row");
  return { id: row.id, body };
}

/** One discovered folder row, as a sync pass's LIST would have written it
 * (services/mail-folders.ts's discoverFolders). Seeded directly here: these
 * routes are about what the picker does with the rows, not about discovery. */
async function seedFolder(
  accountId: string,
  folder: string,
  opts: {
    specialUse?: "archive" | "drafts" | "junk" | "sent" | "trash";
    syncEnabled?: boolean;
    selectable?: boolean;
    lastDiscoveredAt?: Date;
  } = {},
): Promise<string> {
  const [row] = await handle.db.insert(mailAccountFolders).values({
    accountId, folder,
    specialUse: opts.specialUse ?? null,
    syncEnabled: opts.syncEnabled ?? true,
    selectable: opts.selectable ?? true,
    lastDiscoveredAt: opts.lastDiscoveredAt ?? new Date("2026-08-20T09:00:00Z"),
  }).returning();
  if (row === undefined) throw new Error("seedFolder: no row");
  return row.id;
}

/** Point an account at the move targets a discovery pass would have resolved
 * for it. Written straight to the row, since the routes under test are the
 * bulk ones, not the Settings PATCH that also writes these. */
async function setMoveTargets(
  accountId: string, targets: { trashFolder?: string | null; archiveFolder?: string | null },
): Promise<void> {
  await handle.db.update(mailAccounts).set(targets).where(eq(mailAccounts.id, accountId));
}

/** Accounts are born private; tests that need the shared arm flip the row
 * directly (the Settings PATCH that also does this has its own tests).
 * Shared by the visibility and per-user-hide suites. */
async function setVisibility(accountId: string, visibility: "private" | "shared"): Promise<void> {
  await handle.db.update(mailAccounts).set({ visibility }).where(eq(mailAccounts.id, accountId));
}

/** One viewer's thread list as ids -- the shape most matrix assertions read. */
async function listIds(a: App, query: string, headers: Record<string, string>): Promise<string[]> {
  const response = await a.inject({
    method: "GET", url: `/api/mail/threads${query === "" ? "" : `?${query}`}`, headers,
  });
  expect(response.statusCode).toBe(200);
  return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items.map((t) => t.id);
}

async function makeContact(a: App, overrides: Record<string, unknown> = {}) {
  const response = await a.inject({
    method: "POST", url: "/api/contacts", headers: authHeaders,
    payload: { firstName: "Alice", lastName: "Anderson", emails: ["alice@example.com"], ...overrides },
  });
  return contactSchema.parse(response.json());
}

async function makeDeal(a: App, extra: Record<string, unknown> = {}) {
  const pipelineResponse = await a.inject({
    method: "POST", url: "/api/pipelines", headers: authHeaders, payload: { name: `Sales ${randomUUID()}`, scope: "global" },
  });
  const pipeline = pipelineSchema.parse(pipelineResponse.json());
  const stageResponse = await a.inject({
    method: "POST", url: `/api/pipelines/${pipeline.id}/stages`, headers: authHeaders, payload: { name: "Lead" },
  });
  const stage = stageSchema.parse(stageResponse.json());
  const dealResponse = await a.inject({
    method: "POST", url: "/api/deals", headers: authHeaders,
    payload: { title: "Renewal", pipelineId: pipeline.id, stageId: stage.id, ...extra },
  });
  return dealSchema.parse(dealResponse.json());
}

/** Every account-returning response must be free of anything credential
 * shaped -- the whole point of mailAccountSchema (see its own note in
 * packages/shared). Asserted on the raw JSON, not the parsed value, because
 * zod strips unknown keys and would hide exactly the leak this is looking for. */
function expectNoCredentials(payload: unknown): void {
  const json = JSON.stringify(payload);
  expect(json).not.toMatch(/password|credential|ciphertext|secret/i);
}

// --- Accounts ---------------------------------------------------------------

describe("mail account routes", () => {
  it("creates an account, returns 201 with a contract-shaped body, and leaks no credential", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts", headers: authHeaders, payload: baseAccountInput,
    });
    expect(response.statusCode).toBe(201);
    const body = mailAccountSchema.parse(response.json());
    expect(body.label).toBe("Work");
    expect(body.status).toBe("active");
    expectNoCredentials(response.json());
    await a.close();
  });

  it("rejects an invalid create body with the uniform 400", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts", headers: authHeaders,
      payload: { ...baseAccountInput, email: "not-an-address" },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });

  it("409s on a second active account for the same mailbox", async () => {
    const a = await app();
    await makeAccount(a);
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts", headers: authHeaders, payload: baseAccountInput,
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  it("lists own accounts in full with live sync stats, others as summaries, and no credentials", async () => {
    const a = await app();
    const own = await makeAccount(a);
    await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const sync = new FakeAccountSync();
    syncs.set(own.id, sync);

    const response = await a.inject({ method: "GET", url: "/api/mail/accounts", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = mailAccountListSchema.parse(response.json());
    expect(body.own.map((account) => account.id)).toEqual([own.id]);
    expect(body.own[0]?.syncStats).toEqual(sync.stats);
    expect(body.others.map((account) => account.email)).toEqual(["dana@example.com"]);
    // Others carry id/label/email and nothing else -- no host, port or status.
    expect(Object.keys(response.json().others[0] as object).sort()).toEqual(["email", "id", "label"]);
    expectNoCredentials(response.json());
    await a.close();
  });

  it("reports syncStats null for an account with no live sync engine", async () => {
    const a = await app({ syncManager: () => null });
    await makeAccount(a);
    const response = await a.inject({ method: "GET", url: "/api/mail/accounts", headers: authHeaders });
    const body = mailAccountListSchema.parse(response.json());
    expect(body.own[0]?.syncStats).toBeNull();
    await a.close();
  });

  it("patches an own account and 404s on another user's", async () => {
    const a = await app();
    const own = await makeAccount(a);
    const theirs = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);

    const patched = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${own.id}`, headers: authHeaders,
      // A blank password means "keep the stored one" on the update path.
      payload: { label: "Work mail", password: "" },
    });
    expect(patched.statusCode).toBe(200);
    expect(mailAccountSchema.parse(patched.json()).label).toBe("Work mail");
    expectNoCredentials(patched.json());

    const foreign = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${theirs.id}`, headers: authHeaders, payload: { label: "Mine now" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(errorResponseSchema.parse(foreign.json()).error).toBe("not_found");
    await a.close();
  });

  it("archives and unarchives an own account, and 404s both on another user's", async () => {
    const a = await app();
    const own = await makeAccount(a);
    const theirs = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);

    const archived = await a.inject({ method: "POST", url: `/api/mail/accounts/${own.id}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);
    expect(mailAccountSchema.parse(archived.json()).archivedAt).not.toBeNull();
    expectNoCredentials(archived.json());

    const restored = await a.inject({ method: "POST", url: `/api/mail/accounts/${own.id}/unarchive`, headers: authHeaders });
    expect(restored.statusCode).toBe(200);
    expect(mailAccountSchema.parse(restored.json()).archivedAt).toBeNull();

    for (const action of ["archive", "unarchive"]) {
      const foreign = await a.inject({
        method: "POST", url: `/api/mail/accounts/${theirs.id}/${action}`, headers: authHeaders,
      });
      expect(foreign.statusCode).toBe(404);
    }
    await a.close();
  });

  it("rejects a test-connection body that names neither an account nor a full connection", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts/test", headers: authHeaders, payload: { imapHost: "mail.example.com" },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });

  it("404s a test-connection against another user's account", async () => {
    const a = await app();
    const theirs = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts/test", headers: authHeaders, payload: { accountId: theirs.id },
    });
    expect(response.statusCode).toBe(404);
    await a.close();
  });

  it("runs a real test-connection through the adapter deps and reports both protocols failing", async () => {
    const a = await app();
    // Port 1 refuses instantly on every platform, so this exercises the wiring
    // to mail-imapflow's defaultTestConnectionDeps without a network wait.
    const response = await a.inject({
      method: "POST", url: "/api/mail/accounts/test", headers: authHeaders,
      payload: {
        imapHost: "127.0.0.1", imapPort: 1, imapSecurity: "tls",
        smtpHost: "127.0.0.1", smtpPort: 1, smtpSecurity: "starttls",
        username: "chris", password: "hunter2",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = mailAccountTestResultSchema.parse(response.json());
    expect(body.imap.ok).toBe(false);
    expect(body.smtp.ok).toBe(false);
    expectNoCredentials(response.json());
    await a.close();
  });
});

// --- Threads: list ----------------------------------------------------------

// --- Folders ----------------------------------------------------------------

describe("mail folder routes", () => {
  it("lists an account's folders with service-computed locked flags and the discovery fields", async () => {
    const a = await app();
    const account = await makeAccount(a, { sentFolder: "Sent Items" });
    await seedFolder(account.id, "INBOX");
    await seedFolder(account.id, "Sent Items", { specialUse: "sent" });
    await seedFolder(account.id, "Trash", { specialUse: "trash", syncEnabled: false });
    await seedFolder(account.id, "Shared", { selectable: false });

    const response = await a.inject({
      method: "GET", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const folders = mailAccountFolderSchema.array().parse(response.json());
    // Name-ordered, every row present -- including the unselectable one, which
    // the picker greys out rather than hides.
    expect(folders.map((f) => f.folder)).toEqual(["INBOX", "Sent Items", "Shared", "Trash"]);
    // locked: INBOX and the account's CURRENT sent folder, computed here and
    // never a column (repointing sent_folder moves the lock with it).
    expect(folders.filter((f) => f.locked).map((f) => f.folder)).toEqual(["INBOX", "Sent Items"]);
    expect(folders.find((f) => f.folder === "Trash")).toMatchObject({
      specialUse: "trash", syncEnabled: false, selectable: true,
    });
    await a.close();
  });

  it("404s another user's account and an unknown id on both folder routes", async () => {
    const a = await app();
    const theirs = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    await seedFolder(theirs.id, "Projects");

    // Whose mailbox holds which folders is a setting, not shared CRM content:
    // a foreign account 404s exactly like a nonexistent one.
    for (const id of [theirs.id, UNKNOWN_ID]) {
      const listed = await a.inject({
        method: "GET", url: `/api/mail/accounts/${id}/folders`, headers: authHeaders,
      });
      expect(listed.statusCode).toBe(404);
      const patched = await a.inject({
        method: "PATCH", url: `/api/mail/accounts/${id}/folders`, headers: authHeaders,
        payload: { folder: "Projects", syncEnabled: false },
      });
      expect(patched.statusCode).toBe(404);
    }
    // The stranger's row is untouched.
    const [row] = await handle.db.select().from(mailAccountFolders)
      .where(eq(mailAccountFolders.accountId, theirs.id));
    expect(row?.syncEnabled).toBe(true);
    await a.close();
  });

  it("switches a folder off without asking for a sync pass", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await seedFolder(account.id, "Projects");

    const response = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders,
      payload: { folder: "Projects", syncEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(mailAccountFolderSchema.parse(response.json())).toMatchObject({
      folder: "Projects", syncEnabled: false, locked: false,
    });
    // Nothing to fetch, so nothing is asked for.
    expect(syncNowCalls).toEqual([]);
    await a.close();
  });

  it("asks for a sync pass when a folder is switched on, and not on a same-value patch", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await seedFolder(account.id, "Junk", { specialUse: "junk", syncEnabled: false });

    const enabled = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders,
      // The folder name is trimmed by the shared schema before it ever reaches
      // the service, so a padded submission still finds the row.
      payload: { folder: " Junk ", syncEnabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(mailAccountFolderSchema.parse(enabled.json()).syncEnabled).toBe(true);
    expect(syncNowCalls).toEqual([account.id]);

    // Idempotent re-submission: no write, and no second pass requested.
    const again = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders,
      payload: { folder: "Junk", syncEnabled: true },
    });
    expect(again.statusCode).toBe(200);
    expect(syncNowCalls).toEqual([account.id]);
    await a.close();
  });

  it("409s a locked folder, 409s an unselectable one, and 404s an unknown name", async () => {
    const a = await app();
    const account = await makeAccount(a, { sentFolder: "Sent" });
    await seedFolder(account.id, "INBOX");
    await seedFolder(account.id, "Sent", { specialUse: "sent" });
    await seedFolder(account.id, "Shared", { selectable: false });

    async function patch(payload: Record<string, unknown>) {
      return a.inject({
        method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders, payload,
      });
    }

    // INBOX and the sent folder are always walked, so the switch is not real
    // in EITHER direction -- and the message says so without naming one, since
    // it fires for a stray enable as readily as for a disable.
    const inbox = await patch({ folder: "INBOX", syncEnabled: false });
    expect(inbox.statusCode).toBe(409);
    expect(errorResponseSchema.parse(inbox.json())).toMatchObject({
      error: "conflict",
      message: 'folder "INBOX" is always synced (INBOX and the account\'s Sent folder)'
        + " and cannot be toggled",
    });
    const sent = await patch({ folder: "Sent", syncEnabled: true });
    expect(sent.statusCode).toBe(409);
    expect(errorResponseSchema.parse(sent.json())).toMatchObject({
      error: "conflict",
      message: 'folder "Sent" is always synced (INBOX and the account\'s Sent folder)'
        + " and cannot be toggled",
    });

    // A \Noselect node holds no messages: enabling it would promise a sync
    // that can never happen.
    const shared = await patch({ folder: "Shared", syncEnabled: true });
    expect(shared.statusCode).toBe(409);
    expect(errorResponseSchema.parse(shared.json()).message)
      .toBe('folder "Shared" holds no messages on the server (\\Noselect) and cannot be synced');

    const unknown = await patch({ folder: "Nope", syncEnabled: true });
    expect(unknown.statusCode).toBe(404);
    expect(errorResponseSchema.parse(unknown.json()).error).toBe("not_found");

    // Blank and missing bodies are the uniform 400, not a 404.
    expect((await patch({ folder: "   ", syncEnabled: true })).statusCode).toBe(400);
    expect((await patch({ folder: "Shared" })).statusCode).toBe(400);
    expect(syncNowCalls).toEqual([]);
    await a.close();
  });

  it("saves the folder toggle even when the sync engine is absent or throwing", async () => {
    const a = await app({ syncManager: () => null });
    const account = await makeAccount(a);
    await seedFolder(account.id, "Junk", { specialUse: "junk", syncEnabled: false });

    // The DATABASE write is this route's contract; asking for a pass is best
    // effort, exactly like the read route's `\Seen` write-back.
    const response = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`, headers: authHeaders,
      payload: { folder: "Junk", syncEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    const [row] = await handle.db.select().from(mailAccountFolders)
      .where(eq(mailAccountFolders.accountId, account.id));
    expect(row?.syncEnabled).toBe(true);
    await a.close();

    const throwing = await app({
      syncManager: () => ({
        get: (id) => syncs.get(id),
        syncNow: () => { throw new Error("engine exploded"); },
      }),
    });
    const second = await makeAccount(throwing, { label: "Side", email: "side@example.com" });
    await seedFolder(second.id, "Junk", { specialUse: "junk", syncEnabled: false });
    const survived = await throwing.inject({
      method: "PATCH", url: `/api/mail/accounts/${second.id}/folders`, headers: authHeaders,
      payload: { folder: "Junk", syncEnabled: true },
    });
    expect(survived.statusCode).toBe(200);
    await throwing.close();
  });

  it("requires authentication on both folder routes", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await seedFolder(account.id, "Projects");
    const listed = await a.inject({ method: "GET", url: `/api/mail/accounts/${account.id}/folders` });
    expect(listed.statusCode).toBe(401);
    const patched = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}/folders`,
      payload: { folder: "Projects", syncEnabled: false },
    });
    expect(patched.statusCode).toBe(401);
    // The unauthenticated PATCH wrote nothing.
    const [row] = await handle.db.select().from(mailAccountFolders)
      .where(eq(mailAccountFolders.accountId, account.id));
    expect(row?.syncEnabled).toBe(true);
    await a.close();
  });

  it("accepts the trash and archive overrides on the account PATCH, trimmed", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const response = await a.inject({
      method: "PATCH", url: `/api/mail/accounts/${account.id}`, headers: authHeaders,
      payload: { trashFolder: " Deleted Items ", archiveFolder: " Archive " },
    });
    expect(response.statusCode).toBe(200);
    // An IMAP mailbox name is compared byte for byte by the move service, so
    // the padded submission must not become a second mailbox.
    expect(mailAccountSchema.parse(response.json())).toMatchObject({
      trashFolder: "Deleted Items", archiveFolder: "Archive",
    });
    await a.close();
  });
});

describe("mail thread list route", () => {
  it("lists non-hidden threads newest-first with their derived row fields", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const older = await seedThread({ subject: "Older", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    const newer = await seedThread({ subject: "Newer", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const hidden = await seedThread({ subject: "Gone", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await hideFor(hidden);
    await seedMessage(older, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: true, snippet: "Older body" });
    await seedMessage(newer, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, snippet: "Newer body", fromAddr: "bob@example.com", fromName: "Bob",
    });
    await seedMessage(hidden, account.id, { sentAt: new Date("2026-08-03T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    expect(body.items.map((t) => t.subject)).toEqual(["Newer", "Older"]);
    expect(body.items[0]?.unread).toBe(true);
    expect(body.items[0]?.snippet).toBe("Newer body");
    expect(body.items[0]?.senders.map((s) => s.address)).toEqual(["bob@example.com"]);
    expect(body.items[0]?.accountIds).toEqual([account.id]);
    expect(body.items[1]?.unread).toBe(false);
    // Default-view rows carry hiddenAt null BY CONSTRUCTION -- a thread the
    // viewer hid cannot be on this page at all.
    expect(body.items.map((t) => t.hiddenAt)).toEqual([null, null]);
    expect(body.nextCursor).toBeNull();
    await a.close();
  });

  it("caps senders at five per row, newest sender first", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ subject: "Mailing list", lastMessageAt: new Date("2026-08-08T10:00:00Z") });
    // Eight distinct senders, oldest first, so the newest five are 3..7.
    for (let i = 0; i < 8; i += 1) {
      await seedMessage(threadId, account.id, {
        sentAt: new Date(Date.UTC(2026, 7, 1 + i, 10)), fromAddr: `sender${i}@example.com`, fromName: `Sender ${i}`,
      });
    }
    // A repeat of one sender, newest of all: it must collapse into that
    // sender's single entry rather than appearing twice.
    await seedMessage(threadId, account.id, {
      sentAt: new Date("2026-08-09T10:00:00Z"), fromAddr: "SENDER3@example.com", fromName: "Sender 3",
      snippet: "latest of all",
    });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    const senders = body.items[0]?.senders ?? [];
    expect(senders).toHaveLength(5);
    // Case-insensitive dedup: one entry for sender3, and it leads because its
    // newest message is the newest in the thread.
    expect(senders[0]?.address.toLowerCase()).toBe("sender3@example.com");
    const addresses = senders.map((s) => s.address.toLowerCase());
    expect(new Set(addresses).size).toBe(5);
    expect(body.items[0]?.snippet).toBe("latest of all");
    await a.close();
  });

  it("lists every account a thread is visible in, in a stable order", async () => {
    const a = await app();
    const first = await makeAccount(a);
    const second = await makeAccount(a, { label: "Side", email: "side@example.com" });
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, first.id, { sentAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(threadId, second.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    expect(body.items[0]?.accountIds).toEqual([first.id, second.id].sort());
    await a.close();
  });

  // Ingest creates a thread and its first message in one transaction, so this
  // is not a state the app can reach -- but a list row that throws on it
  // would take the whole inbox down, and a defensive default is cheap. Since
  // Phase 4.2 a message-less thread is only VISIBLE at all through a
  // deal/project link (no message means no account to own or share, so it is
  // inbox-visible to nobody), so the defensive row is exercised through the
  // record view that can still reach it -- and the inbox's exclusion of it is
  // asserted alongside.
  it("renders a thread with no messages instead of failing the page", async () => {
    const a = await app();
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Empty", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });

    const response = await a.inject({
      method: "GET", url: `/api/mail/threads?deal_id=${deal.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    const row = body.items.find((t) => t.id === threadId);
    expect(row).toBeDefined();
    expect(row?.unread).toBe(false);
    expect(row?.snippet).toBe("");
    expect(row?.senders).toEqual([]);
    expect(row?.accountIds).toEqual([]);
    // No accounts means no owned account: the fallback must be the honest
    // false, not a default toward move rights nobody can have.
    expect(row?.ownedByViewer).toBe(false);

    const inbox = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    const inboxBody = listResponseSchema(mailThreadListItemSchema).parse(inbox.json());
    expect(inboxBody.items.map((t) => t.id)).not.toContain(threadId);
    await a.close();
  });

  it("treats unread=false and unlinked=false on the wire as no filter, not as the inverse", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const contact = await makeContact(a);
    const linkedRead = await seedThread({
      subject: "Linked and read", lastMessageAt: new Date("2026-08-02T10:00:00Z"), contactId: contact.id,
    });
    await seedMessage(linkedRead, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: true });
    const looseUnread = await seedThread({ subject: "Loose and unread", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(looseUnread, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false });

    for (const query of ["unread=false", "unlinked=false", "unread=false&unlinked=false"]) {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
      expect(body.items.map((t) => t.subject)).toEqual(["Linked and read", "Loose and unread"]);
    }
    await a.close();
  });

  it("pages through the keyset by (last_message_at, id) without repeats or gaps", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const sentAt = new Date(Date.UTC(2026, 7, 1 + i, 10));
      const threadId = await seedThread({ subject: `Thread ${i}`, lastMessageAt: sentAt });
      await seedMessage(threadId, account.id, { sentAt });
      ids.push(threadId);
    }
    const expected = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string = `/api/mail/threads?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await a.inject({ method: "GET", url, headers: authHeaders });
      const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
      seen.push(...body.items.map((t) => t.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
    await a.close();
  });

  it("400s on a garbage cursor and on a cursor minted for a different ordering", async () => {
    const a = await app();
    const garbage = await a.inject({
      method: "GET", url: "/api/mail/threads?cursor=not-valid-base64url-json", headers: authHeaders,
    });
    expect(garbage.statusCode).toBe(400);
    expect(errorResponseSchema.parse(garbage.json()).message).toBe("invalid cursor");

    // A created_at cursor is structurally valid base64url JSON, but names a
    // column this list does not order by -- it must not be accepted.
    const createdAtCursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-01T10:00:00.000Z", id: UNKNOWN_ID }), "utf8",
    ).toString("base64url");
    const wrongOrdering = await a.inject({
      method: "GET", url: `/api/mail/threads?cursor=${encodeURIComponent(createdAtCursor)}`, headers: authHeaders,
    });
    expect(wrongOrdering.statusCode).toBe(400);
    await a.close();
  });

  it("filters by account, unread, hidden and the four record links, ANDed together", async () => {
    const a = await app();
    const first = await makeAccount(a);
    const second = await makeAccount(a, { label: "Side", email: "side@example.com" });
    const contact = await makeContact(a);

    const linked = await seedThread({
      subject: "Linked", lastMessageAt: new Date("2026-08-02T10:00:00Z"), contactId: contact.id,
    });
    await seedMessage(linked, first.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const loose = await seedThread({ subject: "Loose", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(loose, second.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: true });
    const filed = await seedThread({ subject: "Filed", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await hideFor(filed);
    await seedMessage(filed, first.id, { sentAt: new Date("2026-08-03T10:00:00Z") });

    async function subjects(query: string): Promise<string[]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      expect(response.statusCode).toBe(200);
      return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items.map((t) => t.subject);
    }

    expect(await subjects(`account_id=${first.id}`)).toEqual(["Linked"]);
    expect(await subjects(`account_id=${second.id}`)).toEqual(["Loose"]);
    expect(await subjects("unread=true")).toEqual(["Linked"]);
    expect(await subjects("unlinked=true")).toEqual(["Loose"]);
    expect(await subjects(`contact_id=${contact.id}`)).toEqual(["Linked"]);
    expect(await subjects("hidden=true")).toEqual(["Filed"]);
    // The accepted consequence of the Phase 4.3 rename: the retired
    // `archived` spelling is not an error but an UNKNOWN key, which zod
    // strips -- a stale caller sending it gets the DEFAULT (not-hidden)
    // list, never the Hidden view. Documented here as behaviour, pinned as
    // shape in shared/index.test.ts's threadListFiltersSchema block.
    expect(await subjects("archived=true")).toEqual(["Linked", "Loose"]);
    // ANDed, not ORed: an unread thread on the OTHER account matches neither.
    expect(await subjects(`unread=true&account_id=${second.id}`)).toEqual([]);
    await a.close();
  });

  it("filters by folder, and follows a message that moved between folders", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const inbox = await seedThread({ subject: "Inbox thread", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const inboxMessage = await seedMessage(inbox, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "INBOX",
    });
    const filed = await seedThread({ subject: "Filed thread", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(filed, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), folder: "Projects" });

    async function subjects(query: string): Promise<string[]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      expect(response.statusCode).toBe(200);
      return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items.map((t) => t.subject);
    }

    expect(await subjects("folder=INBOX")).toEqual(["Inbox thread"]);
    expect(await subjects("folder=Projects")).toEqual(["Filed thread"]);
    // Membership is derived from the MESSAGES, so an archive move (folder
    // rewritten, uid dropped -- services/mail-move.ts) changes which view the
    // thread appears in, with no thread-level column involved.
    await handle.db.update(mailMessages).set({ folder: "Archive", imapUid: null })
      .where(eq(mailMessages.id, inboxMessage));
    expect(await subjects("folder=INBOX")).toEqual([]);
    expect(await subjects("folder=Archive")).toEqual(["Inbox thread"]);
    // Byte-for-byte, the same rule UNIQUE (account_id, folder) follows.
    expect(await subjects("folder=archive")).toEqual([]);
    // Padding is trimmed rather than becoming a second folder name.
    expect(await subjects("folder=%20Archive%20")).toEqual(["Inbox thread"]);
    // A blank filter is invalid input, not "no filter".
    const blank = await a.inject({ method: "GET", url: "/api/mail/threads?folder=%20", headers: authHeaders });
    expect(blank.statusCode).toBe(400);
    await a.close();
  });

  it("combines account_id and folder into ONE EXISTS, excluding a thread whose halves are on different accounts", async () => {
    const a = await app();
    const first = await makeAccount(a);
    const second = await makeAccount(a, { label: "Side", email: "side@example.com" });

    // The trap two separate EXISTS clauses fall into: this thread has an
    // INBOX message on account A and a Projects message on account B, so each
    // clause passes independently while NO message is in Projects on A.
    const split = await seedThread({ subject: "Split", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(split, first.id, { sentAt: new Date("2026-08-02T09:00:00Z"), folder: "INBOX" });
    await seedMessage(split, second.id, { sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Projects" });
    // ...and a thread that really is in Projects on account A.
    const genuine = await seedThread({ subject: "Genuine", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(genuine, first.id, { sentAt: new Date("2026-08-01T10:00:00Z"), folder: "Projects" });

    async function subjects(query: string): Promise<string[]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      expect(response.statusCode).toBe(200);
      return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items.map((t) => t.subject);
    }

    expect(await subjects(`account_id=${first.id}&folder=Projects`)).toEqual(["Genuine"]);
    expect(await subjects(`account_id=${second.id}&folder=Projects`)).toEqual(["Split"]);
    // Each filter alone still matches the split thread -- which is exactly why
    // they cannot be two independent subqueries.
    expect(await subjects("folder=Projects")).toEqual(["Split", "Genuine"]);
    expect(await subjects(`account_id=${first.id}`)).toEqual(["Split", "Genuine"]);
    await a.close();
  });
});

// --- Threads: detail --------------------------------------------------------

describe("mail thread detail route", () => {
  it("returns the thread with messages oldest-first and their attachments", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const second = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), subject: "Re: hello" });
    const first = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), subject: "hello" });
    const attachment = await seedAttachment(second, { filename: "invoice.pdf" });

    const response = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = mailThreadDetailSchema.parse(response.json());
    expect(body.messages.map((m) => m.id)).toEqual([first, second]);
    expect(body.messages[1]?.attachments.map((f) => f.id)).toEqual([attachment.id]);
    expect(body.messages[0]?.attachments).toEqual([]);
    // The tsvector column must never ride along on a message.
    expect(response.json()).not.toHaveProperty("messages.0.search");
    expect(JSON.stringify(response.json())).not.toContain("blobPath");
    await a.close();
  });

  // The detail cap (Phase 4.3): the newest 50 VISIBLE messages, with
  // totalMessages/truncated describing the payload and `?all=true` lifting
  // the cap. The boundary pair (exactly 50, then 51) pins that the cap
  // fires strictly ABOVE 50 and that what a truncated page drops is the
  // OLDEST end of the reading order.
  it("returns exactly 50 untruncated, and at 51 drops the oldest into a truncated newest-50 page", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const first50 = await seedMessageRun(threadId, account.id, 50, new Date("2026-08-01T10:00:00Z"));

    const atCap = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(atCap.statusCode).toBe(200);
    const atCapBody = mailThreadDetailSchema.parse(atCap.json());
    expect(atCapBody.messages.map((m) => m.id)).toEqual(first50);
    expect(atCapBody.totalMessages).toBe(50);
    expect(atCapBody.truncated).toBe(false);

    // The 51st is the OLDEST, so which message a truncated page loses is
    // observable: this one, and only this one.
    const oldest = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-01T09:00:00Z") });

    const over = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const overBody = mailThreadDetailSchema.parse(over.json());
    expect(overBody.messages.map((m) => m.id)).toEqual(first50);
    expect(overBody.totalMessages).toBe(51);
    expect(overBody.truncated).toBe(true);

    // ?all=true is the uncapped view of the same thread: everything in
    // reading order, and truncated false because THIS payload was not.
    const uncapped = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}?all=true`, headers: authHeaders });
    const uncappedBody = mailThreadDetailSchema.parse(uncapped.json());
    expect(uncappedBody.messages.map((m) => m.id)).toEqual([oldest, ...first50]);
    expect(uncappedBody.totalMessages).toBe(51);
    expect(uncappedBody.truncated).toBe(false);

    const malformed = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}?all=banana`, headers: authHeaders });
    expect(malformed.statusCode).toBe(400);
    await a.close();
  });

  // The cap composes with per-message visibility, applied AFTER it: the
  // bound is on what renders for THIS viewer, so an invisible message
  // neither counts toward totalMessages nor occupies one of the 50 slots --
  // and each viewer of a cross-account thread gets their own arithmetic.
  // The invisible messages sit at the NEWEST end on purpose: a regression
  // that capped BEFORE filtering would hand dana's rows the newest-50
  // window's top slots and push chris's own off the bottom, so it fails
  // the page-id assertion below, not just the totalMessages count.
  it("caps the VISIBLE set per viewer: invisible messages neither count nor fill slots", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaPrivate = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const chrisIds = await seedMessageRun(threadId, chrisPrivate.id, 52, new Date("2026-08-01T10:00:00Z"));
    const danaIds = await seedMessageRun(threadId, danaPrivate.id, 3, new Date("2026-08-02T10:00:00Z"));

    const forChris = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const chrisBody = mailThreadDetailSchema.parse(forChris.json());
    // 52 visible to chris (dana's are not): totalMessages counts exactly
    // those, and the page is the newest 50 OF them.
    expect(chrisBody.totalMessages).toBe(52);
    expect(chrisBody.truncated).toBe(true);
    expect(chrisBody.messages.map((m) => m.id)).toEqual(chrisIds.slice(2));

    // Dana's own view of the same thread: her 3 messages, under the cap,
    // untruncated -- the arithmetic is per viewer, not per thread.
    const forDana = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    const danaBody = mailThreadDetailSchema.parse(forDana.json());
    expect(danaBody.totalMessages).toBe(3);
    expect(danaBody.truncated).toBe(false);
    expect(danaBody.messages.map((m) => m.id)).toEqual(danaIds);
    await a.close();
  });

  // ownedByViewer is an aggregate over the FULL visible set (its schema
  // comment's claim), which the cap must not narrow: a viewer whose only
  // owned message is older than the newest 50 still owns a message here,
  // and the conversation view's Archive/Trash buttons hang off this flag.
  it("keeps ownedByViewer true when the viewer's only owned message is truncated away", async () => {
    const a = await app();
    const chrisOwn = await makeAccount(a);
    const danaShared = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    await setVisibility(danaShared.id, "shared");
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const own = await seedMessage(threadId, chrisOwn.id, { sentAt: new Date("2026-08-01T09:00:00Z") });
    await seedMessageRun(threadId, danaShared.id, 52, new Date("2026-08-01T10:00:00Z"));

    const detail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const body = mailThreadDetailSchema.parse(detail.json());
    expect(body.truncated).toBe(true);
    expect(body.messages.some((m) => m.id === own)).toBe(false);
    expect(body.ownedByViewer).toBe(true);
    await a.close();
  });

  // The truncated payload omits the older messages' attachment METADATA
  // (no chips for messages it does not render), but the bytes stay
  // record-visible and fetchable by id -- truncation is a payload bound,
  // not a visibility change, and getAttachmentBlob runs its own
  // per-message check either way.
  it("keeps a non-returned message's attachment fetchable by id", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessageRun(threadId, account.id, 50, new Date("2026-08-01T10:00:00Z"));
    const oldest = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-01T09:00:00Z") });
    const attachment = await seedAttachment(oldest, { filename: "old-quote.pdf", body: "the original quote" });

    const detail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const body = mailThreadDetailSchema.parse(detail.json());
    expect(body.truncated).toBe(true);
    expect(body.messages.some((m) => m.id === oldest)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(attachment.id);

    const download = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(attachment.body);
    await a.close();
  });

  it("resolves stored attachment placeholders against the deployment's basePath", async () => {
    const rootApp = await app({ basePath: "/" });
    const account = await makeAccount(rootApp);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const messageId = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), bodyHtml: null });
    const inline = await seedAttachment(messageId, { filename: "logo.png", mime: "image/png", isInline: true });
    await handle.db.update(mailMessages)
      .set({ bodyHtml: `<p><img src="mailattachment:${inline.id}"></p>` })
      .where(eq(mailMessages.id, messageId));

    const atRoot = await rootApp.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const rootBody = mailThreadDetailSchema.parse(atRoot.json());
    expect(rootBody.messages[0]?.bodyHtml).toContain(`/api/mail/attachments/${inline.id}/inline`);
    expect(rootBody.messages[0]?.bodyHtml).not.toContain("mailattachment:");
    await rootApp.close();

    const subApp = await app({ basePath: "/conduit" });
    const atSubPath = await subApp.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const subBody = mailThreadDetailSchema.parse(atSubPath.json());
    expect(subBody.messages[0]?.bodyHtml).toContain(`/conduit/api/mail/attachments/${inline.id}/inline`);
    await subApp.close();
  });

  it("suggests the linked contact's open deals, newest first, and none once a deal is linked", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const contact = await makeContact(a);
    const open = await makeDeal(a, { title: "Open renewal", contactId: contact.id });
    const won = await makeDeal(a, { title: "Won already", contactId: contact.id });
    await a.inject({ method: "POST", url: `/api/deals/${won.id}/win`, headers: authHeaders });

    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z"), contactId: contact.id });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const withSuggestions = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const body = mailThreadDetailSchema.parse(withSuggestions.json());
    expect(body.dealSuggestions.map((d) => d.id)).toEqual([open.id]);

    await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "deal", id: open.id },
    });
    const linked = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(mailThreadDetailSchema.parse(linked.json()).dealSuggestions).toEqual([]);
    await a.close();
  });

  it("404s an unknown thread id", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: `/api/mail/threads/${UNKNOWN_ID}`, headers: authHeaders });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });
});

// --- Threads: read ----------------------------------------------------------

describe("mail thread read route", () => {
  it("marks every message seen, drops the unread count, and queues one write-back per account/folder", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false, imapUid: 11 });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 12 });
    // Sent-folder message with no UID yet: nothing to name on the server.
    await seedMessage(threadId, account.id, {
      sentAt: new Date("2026-08-02T11:00:00Z"), seen: false, imapUid: null, folder: "Sent",
    });
    const sync = new FakeAccountSync();
    syncs.set(account.id, sync);

    const before = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(before.json()).count).toBe(1);

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = markThreadReadResponseSchema.parse(response.json());
    expect(body.thread.id).toBe(threadId);
    expect(body.changed).toBe(true);

    const after = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(after.json()).count).toBe(0);
    expect(sync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [11, 12] }]);

    // The idempotent second read: nothing left to flip, and the response
    // SAYS so -- `changed: false` is what stops the client refetching four
    // key families for a write that wrote nothing (the server-side half,
    // no SSE hint on a no-op, is pinned at the service).
    const again = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(again.statusCode).toBe(200);
    expect(markThreadReadResponseSchema.parse(again.json()).changed).toBe(false);
    await a.close();
  });

  it("still succeeds when one account's sync is in backoff and the other is not", async () => {
    const a = await app();
    const healthy = await makeAccount(a);
    const broken = await makeAccount(a, { label: "Broken", email: "broken@example.com" });
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, healthy.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false, imapUid: 21 });
    await seedMessage(threadId, broken.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 22 });

    const healthySync = new FakeAccountSync();
    const brokenSync = new FakeAccountSync();
    brokenSync.markSeenFailure = new Error("mail sync for account is in backoff after a failed pass");
    syncs.set(healthy.id, healthySync);
    syncs.set(broken.id, brokenSync);

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(healthySync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [21] }]);
    expect(brokenSync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [22] }]);
    // The database write is the contract, and it happened for both accounts.
    const rows = await handle.db.select({ seen: mailMessages.seen }).from(mailMessages)
      .where(eq(mailMessages.threadId, threadId));
    expect(rows.every((row) => row.seen)).toBe(true);
    await a.close();
  });

  it("succeeds with no sync engine at all", async () => {
    const a = await app({ syncManager: () => null });
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 31 });

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    await a.close();
  });

  // Hiding never blocks anything (since Amendment 1 retired the link guard,
  // NO thread mutation tests hide state) -- and mark-read is where that
  // matters most: a hidden conversation is still openable, opening it is
  // what marks it read, and the response still reports the VIEWER'S own
  // hide state on the echoed thread.
  it("marks a HIDDEN thread read rather than refusing it", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await hideFor(threadId);
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 41 });

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(markThreadReadResponseSchema.parse(response.json()).thread.hiddenAt).not.toBeNull();
    const rows = await handle.db.select({ seen: mailMessages.seen }).from(mailMessages)
      .where(eq(mailMessages.threadId, threadId));
    expect(rows.every((row) => row.seen)).toBe(true);
    await a.close();
  });

  // The detail-cap pin on THIS route, in its DISCRIMINATING shape: the
  // thread's only unseen message is OLDER than the rendered page (the
  // stuck-badge case -- flag reconcile un-seeing an old row, or an initial
  // sync ingesting old unread -- which is why the conversation view fires
  // mark-read unconditionally per open rather than testing the page for
  // unseen rows). Mark-read must mark the readable THREAD: a cap that
  // leaked into this write would leave that row unread forever, the badge
  // counting a thread whose visible page shows nothing unseen.
  it("marks the whole readable thread under truncation -- an unseen message below the page still clears", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessageRun(threadId, account.id, 50, new Date("2026-08-01T10:00:00Z"));
    const unseenBelow = await seedMessage(threadId, account.id, {
      sentAt: new Date("2026-08-01T09:00:00Z"), seen: false, imapUid: 9,
    });

    // The trap stated: the page is truncated, carries not one unseen row --
    // yet the badge counts the thread.
    const detail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    const body = mailThreadDetailSchema.parse(detail.json());
    expect(body.truncated).toBe(true);
    expect(body.messages.some((m) => !m.seen)).toBe(false);
    const before = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(before.json()).count).toBe(1);

    const read = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(read.statusCode).toBe(200);
    // changed is TRUE although the rendered page held no unseen row -- the
    // very case that shows why the client cannot derive this flag from the
    // page and has to be told.
    expect(markThreadReadResponseSchema.parse(read.json()).changed).toBe(true);
    const [row] = await handle.db.select({ seen: mailMessages.seen }).from(mailMessages)
      .where(eq(mailMessages.id, unseenBelow));
    expect(row?.seen).toBe(true);
    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(0);
    await a.close();
  });

  it("404s an unknown thread", async () => {
    const a = await app();
    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${UNKNOWN_ID}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(404);
    await a.close();
  });
});

// --- Threads: links and hide -------------------------------------------------

describe("mail thread link and hide routes", () => {
  it("sets and clears each of the four links", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const contact = await makeContact(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const linked = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "contact", id: contact.id },
    });
    expect(linked.statusCode).toBe(200);
    expect(mailThreadSchema.parse(linked.json()).contactId).toBe(contact.id);

    const cleared = await a.inject({
      method: "DELETE", url: `/api/mail/threads/${threadId}/links/contact`, headers: authHeaders,
    });
    expect(cleared.statusCode).toBe(200);
    expect(mailThreadSchema.parse(cleared.json()).contactId).toBeNull();
    // Idempotent: clearing an already-empty link is not an error.
    const again = await a.inject({
      method: "DELETE", url: `/api/mail/threads/${threadId}/links/contact`, headers: authHeaders,
    });
    expect(again.statusCode).toBe(200);
    await a.close();
  });

  it("404s an unknown link target, 400s an unknown link kind, and 409s an archived target", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const missing = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "contact", id: UNKNOWN_ID },
    });
    expect(missing.statusCode).toBe(404);

    const badKind = await a.inject({
      method: "DELETE", url: `/api/mail/threads/${threadId}/links/task`, headers: authHeaders,
    });
    expect(badKind.statusCode).toBe(400);

    const contact = await makeContact(a);
    await a.inject({ method: "POST", url: `/api/contacts/${contact.id}/archive`, headers: authHeaders });
    const archivedTarget = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "contact", id: contact.id },
    });
    expect(archivedTarget.statusCode).toBe(409);
    expect(errorResponseSchema.parse(archivedTarget.json()).error).toBe("archived");
    await a.close();
  });

  // The Amendment 1 rewrite of the pre-4.3 "refuses link changes while
  // archived" 409 pin: that guard RETIRED with the thread-global state it
  // guarded. A hide is one person's filing act and gates no shared CRM
  // mutation -- in either direction.
  it("hides and unhides a thread CRM-side for the actor alone, and link changes work regardless of anyone's hide state", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const contact = await makeContact(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const hidden = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    expect(hidden.statusCode).toBe(200);
    expect(mailThreadSchema.parse(hidden.json()).hiddenAt).not.toBeNull();
    // Per-actor: the hider's row exists, nobody else's does.
    expect(await hideRow(threadId, authHeaders)).toBeDefined();
    expect(await hideRow(threadId, otherHeaders)).toBeUndefined();

    // The hider links their OWN hidden thread fine -- linking from the
    // Hidden view or the conversation is a deliberate act -- and the echoed
    // thread still reports THEIR hide state.
    const ownLink = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "deal", id: deal.id },
    });
    expect(ownLink.statusCode).toBe(200);
    expect(mailThreadSchema.parse(ownLink.json()).dealId).toBe(deal.id);
    expect(mailThreadSchema.parse(ownLink.json()).hiddenAt).not.toBeNull();

    // Per 4.2's sharing line the deal link SHARES the private thread --
    // ANOTHER user can now see it and change links on it, with the hider's
    // hide gating nothing (and the other viewer's own hiddenAt is null:
    // hide state never leaks across users).
    const othersLink = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: otherHeaders,
      payload: { kind: "contact", id: contact.id },
    });
    expect(othersLink.statusCode).toBe(200);
    expect(mailThreadSchema.parse(othersLink.json()).contactId).toBe(contact.id);
    expect(mailThreadSchema.parse(othersLink.json()).hiddenAt).toBeNull();

    // The sharing/hiding composition, pinned on its own (spec Amendment 1):
    // the SAME deal link that shares the thread onto the other user's deal
    // tab leaves it hidden in the hider's own views -- excluded from the
    // hider's deal tab (a default surface), listed in their Hidden view.
    async function dealTab(headers: typeof authHeaders): Promise<string[]> {
      const response = await a.inject({
        method: "GET", url: `/api/mail/threads?deal_id=${deal.id}`, headers,
      });
      return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items.map((t) => t.id);
    }
    expect(await dealTab(otherHeaders)).toEqual([threadId]);
    expect(await dealTab(authHeaders)).toEqual([]);
    const hiddenView = await a.inject({ method: "GET", url: "/api/mail/threads?hidden=true", headers: authHeaders });
    expect(listResponseSchema(mailThreadListItemSchema).parse(hiddenView.json()).items.map((t) => t.id))
      .toEqual([threadId]);

    const restored = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/unarchive`, headers: authHeaders });
    expect(restored.statusCode).toBe(200);
    expect(mailThreadSchema.parse(restored.json()).hiddenAt).toBeNull();
    expect(await dealTab(authHeaders)).toEqual([threadId]);

    const unknown = await a.inject({ method: "POST", url: `/api/mail/threads/${UNKNOWN_ID}/archive`, headers: authHeaders });
    expect(unknown.statusCode).toBe(404);
    await a.close();
  });

  // Idempotent both ways, never an error (spec, Hide/unhide semantics). The
  // hide no-op answers from a RE-READ of the standing hide row, so a
  // repeated request reports the ORIGINAL filing moment -- never a fresh
  // timestamp, and never a report of the pre-hide state.
  it("answers a repeated hide with the original hidden_at and a repeated unhide with null", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const first = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    const firstAt = mailThreadSchema.parse(first.json()).hiddenAt;
    expect(firstAt).not.toBeNull();
    const second = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    expect(second.statusCode).toBe(200);
    // The truthful no-op: the SAME filing moment, not a re-stamp.
    expect(mailThreadSchema.parse(second.json()).hiddenAt).toBe(firstAt);

    const restored = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/unarchive`, headers: authHeaders });
    expect(mailThreadSchema.parse(restored.json()).hiddenAt).toBeNull();
    const again = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/unarchive`, headers: authHeaders });
    expect(again.statusCode).toBe(200);
    expect(mailThreadSchema.parse(again.json()).hiddenAt).toBeNull();
    expect(await hideRow(threadId)).toBeUndefined();
    await a.close();
  });

  it("counts unread threads, not unread messages, and ignores threads the viewer hid", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const busy = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(busy, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false });
    await seedMessage(busy, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const filed = await seedThread({ lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await hideFor(filed);
    await seedMessage(filed, account.id, { sentAt: new Date("2026-08-03T10:00:00Z"), seen: false });

    const response = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(mailUnreadCountSchema.parse(response.json()).count).toBe(1);
    await a.close();
  });

  it("drops a trashed unread thread from the badge and the list's unread flag, but keeps an archived one", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await setMoveTargets(account.id, { trashFolder: " Trash ", archiveFolder: "Archive" });

    const trashed = await seedThread({ subject: "Trashed", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(trashed, account.id, {
      sentAt: new Date("2026-08-03T10:00:00Z"), folder: "Trash", seen: false, imapUid: null,
    });
    const archived = await seedThread({ subject: "Archived", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(archived, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Archive", seen: false,
    });

    // Trashing never touches `seen` (services/mail-move.ts), and nothing ever
    // re-sights an unsynced Trash to clear it -- so the COUNTING is what
    // carves it out, here and in the list's unread flag alike. The stored
    // " Trash " is compared trimmed, the way the move service reads it.
    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(1);

    const list = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    const items = listResponseSchema(mailThreadListItemSchema).parse(list.json()).items;
    // Filing a message is not reading it: the Archive row keeps its dot.
    expect(items.map((t) => [t.subject, t.unread])).toEqual([["Trashed", false], ["Archived", true]]);

    // ...and the UNSCOPED unread filter agrees with both of them. All three
    // unscoped computations carve Trash out: without it this response returned
    // the trashed thread while the same body said `unread: false` about it.
    const filtered = await a.inject({
      method: "GET", url: "/api/mail/threads?unread=true", headers: authHeaders,
    });
    const filteredItems = listResponseSchema(mailThreadListItemSchema).parse(filtered.json()).items;
    expect(filteredItems.map((t) => t.subject)).toEqual(["Archived"]);
    // A thread whose trashed message is unread but which ALSO has an unread
    // message elsewhere still matches: the carve-out is per message, not per
    // thread.
    await seedMessage(items[0]!.id, account.id, {
      sentAt: new Date("2026-08-03T11:00:00Z"), folder: "INBOX", seen: false, imapUid: 12,
    });
    const withInbox = await a.inject({
      method: "GET", url: "/api/mail/threads?unread=true", headers: authHeaders,
    });
    expect(listResponseSchema(mailThreadListItemSchema).parse(withInbox.json())
      .items.map((t) => t.subject)).toEqual(["Trashed", "Archived"]);
    await a.close();
  });

  it("scopes unread to the folder view: the Trash view's dots match the Trash badge", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await setMoveTargets(account.id, { trashFolder: "Trash" });

    // One thread with unread mail IN the Trash and nothing unread elsewhere,
    // one with unread mail in Projects, one read everywhere.
    const trashed = await seedThread({ subject: "Trashed", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(trashed, account.id, {
      sentAt: new Date("2026-08-03T10:00:00Z"), folder: "Trash", seen: false, imapUid: null,
    });
    const filed = await seedThread({ subject: "Filed", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(filed, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Projects", seen: false,
    });
    // ...and this one is unseen in INBOX but READ in Projects, which is what
    // separates "unseen in this folder" from "unseen somewhere".
    const split = await seedThread({ subject: "Split", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(split, account.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), folder: "INBOX", seen: false,
    });
    await seedMessage(split, account.id, {
      sentAt: new Date("2026-08-01T09:00:00Z"), folder: "Projects", seen: true, imapUid: 21,
    });

    async function rows(query: string): Promise<[string, boolean][]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      expect(response.statusCode).toBe(200);
      return listResponseSchema(mailThreadListItemSchema).parse(response.json())
        .items.map((t) => [t.subject, t.unread]);
    }

    // A FOLDER VIEW asks "what is unseen IN THIS FOLDER?", so the Trash view
    // shows its own unread mail instead of claiming everything in it is read
    // under a sidebar badge that says the opposite.
    expect(await rows("folder=Trash")).toEqual([["Trashed", true]]);
    const badges = await a.inject({
      method: "GET", url: "/api/mail/unread-count?byFolder=1", headers: authHeaders,
    });
    expect(mailUnreadFolderCountsSchema.parse(badges.json()).folders).toEqual([
      { folder: "INBOX", count: 1 }, { folder: "Projects", count: 1 }, { folder: "Trash", count: 1 },
    ]);
    // The Projects view: "Filed" is unseen there, "Split" is not (its unseen
    // message is in INBOX), even though "Split" is unread in the global sense.
    expect(await rows("folder=Projects")).toEqual([["Filed", true], ["Split", false]]);
    // ...and the folder-scoped unread FILTER selects exactly the folder's own
    // badge population, which is the property the sidebar depends on.
    expect(await rows("folder=Projects&unread=true")).toEqual([["Filed", true]]);
    expect(await rows("folder=Trash&unread=true")).toEqual([["Trashed", true]]);
    expect(await rows("folder=INBOX&unread=true")).toEqual([["Split", true]]);
    // Unscoped, the global rule still applies: Trash is carved out, the rest
    // counts wherever it sits.
    expect(await rows("unread=true")).toEqual([["Filed", true], ["Split", true]]);
    await a.close();
  });

  it("scopes the folder view's unread flag to the account when the view names one", async () => {
    const a = await app();
    const first = await makeAccount(a);
    const second = await makeAccount(a, { label: "Side", email: "side@example.com" });
    // One thread, an INBOX message on each account: read on the first, unseen
    // on the second. Looking at the FIRST account's INBOX, nothing is unseen.
    const thread = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(thread, first.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: true });
    await seedMessage(thread, second.id, { sentAt: new Date("2026-08-02T09:00:00Z"), seen: false });

    async function rows(query: string): Promise<[string, boolean][]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/threads?${query}`, headers: authHeaders });
      return listResponseSchema(mailThreadListItemSchema).parse(response.json())
        .items.map((t) => [t.subject, t.unread]);
    }

    expect(await rows(`folder=INBOX&account_id=${first.id}`)).toEqual([["Shared", false]]);
    expect(await rows(`folder=INBOX&account_id=${second.id}`)).toEqual([["Shared", true]]);
    expect(await rows(`folder=INBOX&account_id=${first.id}&unread=true`)).toEqual([]);
    expect(await rows(`folder=INBOX&account_id=${second.id}&unread=true`)).toEqual([["Shared", true]]);
    // An account filter with NO folder is not a folder view: the flag stays
    // the global one, exactly as it was before folders existed.
    expect(await rows(`account_id=${first.id}`)).toEqual([["Shared", true]]);
    await a.close();
  });

  it("counts only the trash of the account the message belongs to", async () => {
    const a = await app();
    const first = await makeAccount(a);
    const second = await makeAccount(a, { label: "Side", email: "side@example.com" });
    await setMoveTargets(first.id, { trashFolder: "Bin" });
    await setMoveTargets(second.id, { trashFolder: "Trash" });

    // One account's Trash is another's ordinary folder: this message sits in
    // "Bin" on the account whose trash is "Trash", so it still counts.
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(thread, second.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Bin", seen: false,
    });
    const response = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(response.json()).count).toBe(1);

    // An account with no classified trash folder excludes nothing at all.
    await setMoveTargets(second.id, { trashFolder: null });
    const unresolved = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(unresolved.json()).count).toBe(1);
    expect(first.id).not.toBe(second.id);
    await a.close();
  });

  it("trims the trash folder without eating letters from it", async () => {
    const a = await app();
    const dutch = await makeAccount(a);
    const neighbour = await makeAccount(a, { label: "Side", email: "side@example.com" });
    // A trash folder starting with the letter the trim set must NOT contain.
    // Stored padded, so this pins the trimming AND the not-trimming at once.
    await setMoveTargets(dutch.id, { trashFolder: "  vuilnisbak  " });
    await setMoveTargets(neighbour.id, { trashFolder: "vuilnisbak" });

    // Direction 1: mail IN that folder is carved out of the badge. With a
    // stray "v" in the trim set the stored name became "uilnisbak", matched
    // nothing, and this thread counted as unread forever -- unclearable,
    // since nothing re-sights an unsynced Trash.
    const trashed = await seedThread({ subject: "Trashed", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(trashed, dutch.id, {
      sentAt: new Date("2026-08-03T10:00:00Z"), folder: "vuilnisbak", seen: false, imapUid: null,
    });
    // Direction 2: the NEIGHBOURING name is not the trash folder and must
    // keep counting. Same stray "v" made "uilnisbak" trim-equal to the
    // account's trash and silently excluded real unread mail.
    const kept = await seedThread({ subject: "Kept", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(kept, neighbour.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "uilnisbak", seen: false,
    });

    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(1);
    const list = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    expect(listResponseSchema(mailThreadListItemSchema).parse(list.json())
      .items.map((t) => [t.subject, t.unread])).toEqual([["Trashed", false], ["Kept", true]]);
    await a.close();
  });

  it("reports per-folder counts with ?byFolder=1, Trash row included", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await setMoveTargets(account.id, { trashFolder: "Trash" });

    const inbox = await seedThread({ lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(inbox, account.id, { sentAt: new Date("2026-08-03T10:00:00Z"), seen: false });
    // Two unread messages in one thread count once: a conversation is one
    // thing to deal with, the same way the badge counts it.
    await seedMessage(inbox, account.id, { sentAt: new Date("2026-08-03T11:00:00Z"), seen: false, imapUid: 11 });
    const trashed = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(trashed, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Trash", seen: false, imapUid: null,
    });
    const read = await seedThread({ lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(read, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), folder: "Projects", seen: true });

    const response = await a.inject({
      method: "GET", url: "/api/mail/unread-count?byFolder=1", headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    // The per-folder variant deliberately does NOT apply the badge's trash
    // exclusion: each count belongs to its own row, and a Trash row reading 0
    // above visibly unread mail would be a lie. A folder with nothing unread
    // simply has no row.
    expect(mailUnreadFolderCountsSchema.parse(response.json())).toEqual({
      folders: [{ folder: "INBOX", count: 1 }, { folder: "Trash", count: 1 }],
    });

    // ...and the plain badge, for the same data, leaves the trashed one out.
    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(1);

    // One spelling of the flag, and anything else is the uniform 400 rather
    // than a silent fall-back to the plain count.
    const wrong = await a.inject({
      method: "GET", url: "/api/mail/unread-count?byFolder=true", headers: authHeaders,
    });
    expect(wrong.statusCode).toBe(400);
    await a.close();
  });
});

// --- Bulk actions -----------------------------------------------------------

describe("mail bulk thread action route", () => {
  /** An account with a live fake sync and both move targets resolved -- the
   * ordinary state after a discovery pass. */
  async function readyAccount(a: App, overrides: Partial<MailAccountCreateInput> = {}) {
    const account = await makeAccount(a, overrides);
    await setMoveTargets(account.id, { trashFolder: "Trash", archiveFolder: "Archive" });
    const sync = new FakeAccountSync();
    syncs.set(account.id, sync);
    return { account, sync };
  }

  async function bulk(a: App, payload: Record<string, unknown>) {
    return a.inject({ method: "POST", url: "/api/mail/threads/bulk", headers: authHeaders, payload });
  }

  async function messageRow(id: string) {
    const [row] = await handle.db.select().from(mailMessages).where(eq(mailMessages.id, id));
    return row;
  }

  it("archives the selected threads' messages in the view folder, queueing one MOVE per source folder", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    const first = await seedThread({ subject: "One", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const inboxOne = await seedMessage(first, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 41 });
    // Same thread, different folder: folder-scoped selection acts only on the
    // view the user was looking at.
    const elsewhere = await seedMessage(first, account.id, {
      sentAt: new Date("2026-08-02T09:00:00Z"), folder: "Projects", imapUid: 42,
    });
    const second = await seedThread({ subject: "Two", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    const inboxTwo = await seedMessage(second, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), imapUid: 43 });

    const response = await bulk(a, { threadIds: [first, second], folder: "INBOX", action: "archive" });
    expect(response.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(response.json())).toEqual({
      results: [{ threadId: first, ok: true }, { threadId: second, ok: true }],
    });

    // Optimistic DB write: folder rewritten, uid dropped (the old number names
    // a message in the OLD mailbox), and the queued MOVE carries both uids in
    // one call for the one (account, source folder) group.
    expect(await messageRow(inboxOne)).toMatchObject({ folder: "Archive", imapUid: null });
    expect(await messageRow(inboxTwo)).toMatchObject({ folder: "Archive", imapUid: null });
    expect(await messageRow(elsewhere)).toMatchObject({ folder: "Projects", imapUid: 42 });
    expect(sync.moveCalls).toEqual([{ folder: "INBOX", uids: [41, 43], targetFolder: "Archive" }]);
    await a.close();
  });

  it("trashes to the account's trash folder, and hides CRM-side without touching a mailbox", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    const trashed = await seedThread({ subject: "Bin me", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const trashedMessage = await seedMessage(trashed, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 51,
    });
    const hidden = await seedThread({ subject: "Hide me", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    const hiddenMessage = await seedMessage(hidden, account.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), imapUid: 52,
    });

    expect((await bulk(a, { threadIds: [trashed], folder: "INBOX", action: "trash" })).statusCode).toBe(200);
    expect(await messageRow(trashedMessage)).toMatchObject({ folder: "Trash", imapUid: null });
    // Nothing is expunged: the row survives in Trash, and the server's own
    // retention owns actual destruction.
    expect(sync.moveCalls).toEqual([{ folder: "INBOX", uids: [51], targetFolder: "Trash" }]);

    // "Hide in CRM" is the per-actor filing act in bulk (Phase 4.3): a hide
    // row for the REQUESTING user alone, no IMAP work at all, and `folder`
    // is ignored entirely.
    const hide = await bulk(a, { threadIds: [hidden], action: "hide" });
    expect(hide.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(hide.json()).results).toEqual([{ threadId: hidden, ok: true }]);
    expect(await hideRow(hidden, authHeaders)).toBeDefined();
    expect(await hideRow(hidden, otherHeaders)).toBeUndefined();
    expect(await messageRow(hiddenMessage)).toMatchObject({ folder: "INBOX", imapUid: 52 });
    expect(sync.moveCalls).toHaveLength(1);
    await a.close();
  });

  it("moves every folder's messages when no folder is given (the single-thread buttons' mode)", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const inbox = await seedMessage(thread, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 61 });
    const projects = await seedMessage(thread, account.id, {
      sentAt: new Date("2026-08-02T09:00:00Z"), folder: "Projects", imapUid: 62,
    });
    // Archiving a conversation must never empty Sent.
    const sent = await seedMessage(thread, account.id, {
      sentAt: new Date("2026-08-02T08:00:00Z"), folder: "Sent", imapUid: 63,
    });

    const response = await bulk(a, { threadIds: [thread], action: "archive" });
    expect(response.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([{ threadId: thread, ok: true }]);
    expect(await messageRow(inbox)).toMatchObject({ folder: "Archive" });
    expect(await messageRow(projects)).toMatchObject({ folder: "Archive" });
    expect(await messageRow(sent)).toMatchObject({ folder: "Sent", imapUid: 63 });
    // One queued call per SOURCE folder -- the mailbox the server has to SELECT.
    expect(sync.moveCalls).toEqual([
      { folder: "INBOX", uids: [61], targetFolder: "Archive" },
      { folder: "Projects", uids: [62], targetFolder: "Archive" },
    ]);
    await a.close();
  });

  it("caps trash and archive at 50 threads while hide keeps the shared schema's 200", async () => {
    const a = await app();
    const ids = Array.from({ length: 51 }, () => randomUUID());

    for (const action of ["trash", "archive"] as const) {
      const response = await bulk(a, { threadIds: ids, folder: "INBOX", action });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json())).toEqual({
        error: "validation",
        message: `${action} accepts at most 50 threads per request (received 51)`,
      });
    }

    // hide waits on nothing but the database, so it keeps the outer bound.
    // (Every id here is unknown, which is a per-thread failure, not a 400.)
    const hide = await bulk(a, { threadIds: ids, action: "hide" });
    expect(hide.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(hide.json()).results).toHaveLength(51);

    // Both caps bracketed on the passing side too, so neither is off by one:
    // exactly 50 moves, and exactly 200 hides.
    const atMoveCap = await bulk(a, {
      threadIds: Array.from({ length: 50 }, () => randomUUID()), folder: "INBOX", action: "archive",
    });
    expect(atMoveCap.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(atMoveCap.json()).results).toHaveLength(50);
    const atSharedCap = await bulk(a, {
      threadIds: Array.from({ length: 200 }, () => randomUUID()), action: "hide",
    });
    expect(atSharedCap.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(atSharedCap.json()).results).toHaveLength(200);

    // The shared cap still holds above it, for every action.
    const tooMany = await bulk(a, {
      threadIds: Array.from({ length: 201 }, () => randomUUID()), action: "hide",
    });
    expect(tooMany.statusCode).toBe(400);
    await a.close();
  });

  it("returns one 200 body carrying successes, skips and per-thread failures side by side", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    // A second account with no sync loop: it refuses, and only for threads
    // whose messages it was actually going to move.
    const stalled = await makeAccount(a, { label: "Stalled", email: "stalled@example.com" });
    await setMoveTargets(stalled.id, { trashFolder: "Trash", archiveFolder: "Archive" });

    const moved = await seedThread({ subject: "Moves", lastMessageAt: new Date("2026-08-04T10:00:00Z") });
    await seedMessage(moved, account.id, { sentAt: new Date("2026-08-04T10:00:00Z"), imapUid: 71 });
    const refused = await seedThread({ subject: "Refused", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(refused, stalled.id, { sentAt: new Date("2026-08-03T10:00:00Z"), imapUid: 72 });
    // Its only message is already in the target folder, so the INBOX view has
    // nothing of this thread to act on: a no-op, and a success.
    const already = await seedThread({ subject: "Already", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(already, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Archive", imapUid: 73,
    });
    // Awaiting reconciliation: no uid to name it to the server, so it is
    // skipped rather than failed, and it self-heals after the next pass.
    const pending = await seedThread({ subject: "Pending", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(pending, account.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), imapUid: null,
    });

    const response = await bulk(a, {
      threadIds: [moved, refused, already, pending, UNKNOWN_ID], folder: "INBOX", action: "archive",
    });
    expect(response.statusCode).toBe(200);
    // Per-thread results, in REQUEST order. Each carries BOTH halves: the
    // stable `reason` code Task 5 branches on, and the free-text `error` it
    // displays. The whole mixed body parses through the shared schema, whose
    // superRefine is what ties the two to `ok`/`skipped`.
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([
      { threadId: moved, ok: true },
      {
        threadId: refused, ok: false, reason: "no_sync",
        error: 'mail sync is not running for account "Stalled"',
      },
      // Its only message is in Archive, so the INBOX view held nothing of it:
      // the action never applied here, which is not the same statement as
      // "already done" -- and the very same thread says already_in_target
      // when asked from the Archive view below.
      { threadId: already, ok: true, skipped: true, reason: "out_of_scope" },
      { threadId: pending, ok: true, skipped: true, reason: "awaiting_reconciliation" },
      {
        threadId: UNKNOWN_ID, ok: false, reason: "not_found",
        error: `mail thread ${UNKNOWN_ID} not found`,
      },
    ]);
    // The healthy account still did its work: one refusal does not stop the rest.
    expect(sync.moveCalls).toEqual([{ folder: "INBOX", uids: [71], targetFolder: "Archive" }]);

    // The SAME thread, asked from the Archive view, reports the other reason:
    // its message is in scope this time and is already where it was going. Two
    // views, two honest answers -- which is the whole point of the two values
    // being separate.
    const fromTarget = await bulk(a, { threadIds: [already], folder: "Archive", action: "archive" });
    expect(bulkThreadResultSchema.parse(fromTarget.json()).results).toEqual([
      { threadId: already, ok: true, skipped: true, reason: "already_in_target" },
    ]);
    expect(sync.moveCalls).toHaveLength(1);
    await a.close();
  });

  it("gates each thread on visibility then ownership: own moves, shared skips, private and unknown answer alike", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    // dana's two accounts: one shared (chris may see its threads, never file
    // them), one private (chris must not learn it exists). Both have resolved
    // targets, and NEITHER gets a sync loop, ON PURPOSE -- unowned, that dead
    // loop would have been a no_sync failure naming dana's account, so the
    // answers below prove the Phase 4.2 gates decide before any refusal can.
    const shared = await makeAccount(a, { label: "Dana shared", email: "dana-shared@example.com" }, otherHeaders);
    await handle.db.update(mailAccounts).set({ visibility: "shared" }).where(eq(mailAccounts.id, shared.id));
    await setMoveTargets(shared.id, { trashFolder: "Trash", archiveFolder: "Archive" });
    const priv = await makeAccount(a, { label: "Dana private", email: "dana-private@example.com" }, otherHeaders);
    await setMoveTargets(priv.id, { trashFolder: "Trash", archiveFolder: "Archive" });

    const mine = await seedThread({ subject: "Mine", lastMessageAt: new Date("2026-08-04T10:00:00Z") });
    await seedMessage(mine, account.id, { sentAt: new Date("2026-08-04T10:00:00Z"), imapUid: 111 });
    const unowned = await seedThread({ subject: "Theirs, shared", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    const unownedMessage = await seedMessage(unowned, shared.id, {
      sentAt: new Date("2026-08-03T10:00:00Z"), imapUid: 112,
    });
    const invisible = await seedThread({ subject: "Theirs, private", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const invisibleMessage = await seedMessage(invisible, priv.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 113,
    });

    const response = await bulk(a, {
      threadIds: [mine, unowned, invisible, UNKNOWN_ID], folder: "INBOX", action: "archive",
    });
    expect(response.statusCode).toBe(200);
    const { results } = bulkThreadResultSchema.parse(response.json());
    expect(results).toEqual([
      { threadId: mine, ok: true },
      // Visible but not chris's mailbox: an honest skip -- not a 404, and not
      // a refusal naming dana's account state either.
      { threadId: unowned, ok: true, skipped: true, reason: "not_owner" },
      // Invisible: exactly the answer an id that names nothing gets.
      { threadId: invisible, ok: false, reason: "not_found", error: `mail thread ${invisible} not found` },
      { threadId: UNKNOWN_ID, ok: false, reason: "not_found", error: `mail thread ${UNKNOWN_ID} not found` },
    ]);
    // Indistinguishable beyond the id itself: substituting it maps one
    // serialized answer onto the other, byte for byte.
    expect(JSON.stringify(results[2]).replaceAll(invisible, UNKNOWN_ID)).toBe(JSON.stringify(results[3]));
    // Only chris's own message moved; both of dana's mailboxes are untouched.
    expect(sync.moveCalls).toEqual([{ folder: "INBOX", uids: [111], targetFolder: "Archive" }]);
    expect(await messageRow(unownedMessage)).toMatchObject({ folder: "INBOX", imapUid: 112 });
    expect(await messageRow(invisibleMessage)).toMatchObject({ folder: "INBOX", imapUid: 113 });
    await a.close();
  });

  it("fails the thread with the server's own message when the queued MOVE is refused, and puts the row back", async () => {
    const a = await app();
    const { account, sync } = await readyAccount(a);
    sync.moveFailure = new Error("NO [TRYCREATE] Mailbox does not exist");
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const message = await seedMessage(thread, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 81,
    });

    const response = await bulk(a, { threadIds: [thread], folder: "INBOX", action: "archive" });
    expect(response.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([
      {
        threadId: thread, ok: false, reason: "server_refused",
        error: "NO [TRYCREATE] Mailbox does not exist",
      },
    ]);
    // The CRM must never claim a move the server refused: the compensating
    // revert restores the row's own folder and uid.
    expect(await messageRow(message)).toMatchObject({ folder: "INBOX", imapUid: 81 });
    await a.close();
  });

  it("refuses every account's threads when the deployment has no sync engine at all", async () => {
    const a = await app({ syncManager: () => null });
    const account = await makeAccount(a);
    await setMoveTargets(account.id, { trashFolder: "Trash", archiveFolder: "Archive" });
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const message = await seedMessage(thread, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 91 });

    // Unlike the Sent-folder APPEND, a missing loop is a refusal rather than a
    // skipped best-effort step: moving the rows with nothing to carry the MOVE
    // out would leave the CRM showing a folder the message never reached.
    const response = await bulk(a, { threadIds: [thread], folder: "INBOX", action: "trash" });
    expect(response.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([
      {
        threadId: thread, ok: false, reason: "no_sync",
        error: 'mail sync is not running for account "Work"',
      },
    ]);
    expect(await messageRow(message)).toMatchObject({ folder: "INBOX", imapUid: 91 });

    // hide needs no mail server, so it still works on the same deployment.
    const hide = await bulk(a, { threadIds: [thread], action: "hide" });
    expect(bulkThreadResultSchema.parse(hide.json()).results).toEqual([{ threadId: thread, ok: true }]);
    await a.close();
  });

  it("reports an unresolved move target as that account's own failure", async () => {
    const a = await app();
    const { account } = await readyAccount(a);
    // NULL means "nothing has classified one yet", which is the spec's
    // "detect for me" state -- not a folder to guess at.
    await setMoveTargets(account.id, { trashFolder: null });
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(thread, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), imapUid: 101 });

    const response = await bulk(a, { threadIds: [thread], folder: "INBOX", action: "trash" });
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([{
      threadId: thread, ok: false, reason: "no_target",
      error: 'account "Work" has no Trash folder yet'
        + " -- set one in Settings, or wait for a sync pass to detect it",
    }]);
    // ...and Archive, whose target IS resolved, still works for the same thread.
    const archived = await bulk(a, { threadIds: [thread], folder: "INBOX", action: "archive" });
    expect(bulkThreadResultSchema.parse(archived.json()).results).toEqual([{ threadId: thread, ok: true }]);
    await a.close();
  });

  it("400s an empty selection, an unknown action and a blank folder", async () => {
    const a = await app();
    const thread = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    for (const payload of [
      { threadIds: [], folder: "INBOX", action: "archive" },
      { threadIds: [thread], action: "delete" },
      { threadIds: [thread], folder: "  ", action: "archive" },
      { threadIds: ["not-a-uuid"], action: "hide" },
      { folder: "INBOX", action: "archive" },
    ]) {
      const response = await bulk(a, payload);
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    }
    await a.close();
  });

  it("requires authentication", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/mail/threads/bulk",
      payload: { threadIds: [UNKNOWN_ID], action: "hide" },
    });
    expect(response.statusCode).toBe(401);
    await a.close();
  });
});

// --- Send -------------------------------------------------------------------

describe("mail send route", () => {
  function sendPayload(accountId: string, overrides: Partial<SendMailInput> = {}) {
    return {
      accountId,
      to: [{ address: "alice@example.com", name: "Alice" }],
      subject: "Hello Alice",
      bodyHtml: "<p>Hi Alice</p>",
      ...overrides,
    };
  }

  it("sends, stores the message and returns 201 with a contract-shaped body", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const sync = new FakeAccountSync();
    syncs.set(account.id, sync);

    const response = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders, payload: sendPayload(account.id),
    });
    expect(response.statusCode).toBe(201);
    const body = mailMessageSchema.parse(response.json());
    expect(body.direction).toBe("outbound");
    expect(body.subject).toBe("Hello Alice");
    expect(transport.sent).toHaveLength(1);
    expect(sync.appended).toHaveLength(1);
    await a.close();
  });

  it("maps an SMTP refusal to 502 smtp_failed with a reason and stores nothing", async () => {
    const a = await app();
    const account = await makeAccount(a);
    transport.failure = new Error("auth: Invalid login");

    const response = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders, payload: sendPayload(account.id),
    });
    expect(response.statusCode).toBe(502);
    const body = response.json() as { error: string; reason?: string };
    expect(body.error).toBe("smtp_failed");
    expect(body.reason).toContain("auth:");
    const stored = await handle.db.select().from(mailMessages);
    expect(stored).toHaveLength(0);
    await a.close();
  });

  it("400s a send with no recipients and 404s a send from another user's account", async () => {
    const a = await app();
    const theirs = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const mine = await makeAccount(a);

    const noRecipients = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders, payload: sendPayload(mine.id, { to: [] }),
    });
    expect(noRecipients.statusCode).toBe(400);

    const foreign = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders, payload: sendPayload(theirs.id),
    });
    expect(foreign.statusCode).toBe(404);
    await a.close();
  });

  it("409s a send from an account whose last sync failed", async () => {
    const a = await app();
    const account = await makeAccount(a);
    await handle.db.update(mailAccounts).set({ status: "error", lastError: "auth: Invalid login" })
      .where(eq(mailAccounts.id, account.id));

    const response = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders, payload: sendPayload(account.id),
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  // The forward re-attach wire contract (Phase 4.3): `forwardAttachmentIds`
  // names mail_attachments rows, and an over-cap original maps to the same
  // 413 `too_large` the upload route answers -- the send refused whole, the
  // draft still in the client's hands. The full mechanics (raw bytes,
  // ingest linkage, visibility 404) live with the service in
  // mail-send.test.ts; this pins the route's two answers.
  it("re-attaches a forwarded original on the wire and 413s one over the compose cap", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const messageId = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const attachment = await seedAttachment(messageId, { filename: "quote.pdf", body: "the quoted price is 42" });

    const sent = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders,
      payload: sendPayload(account.id, { forwardAttachmentIds: [attachment.id] }),
    });
    expect(sent.statusCode).toBe(201);
    expect(transport.sent[0]?.raw.toString("utf8")).toContain("quote.pdf");

    // The stored size_bytes is what the cap reads (the same column the
    // download route serves as Content-Length), so an over-cap original is
    // stated on the row rather than materialized as 51MB of test blob.
    await handle.db.update(mailAttachments).set({ sizeBytes: 51 * 1024 * 1024 })
      .where(eq(mailAttachments.id, attachment.id));
    const refused = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders,
      payload: sendPayload(account.id, { forwardAttachmentIds: [attachment.id] }),
    });
    expect(refused.statusCode).toBe(413);
    const body = errorResponseSchema.parse(refused.json());
    expect(body.error).toBe("too_large");
    expect(body.message).toContain("quote.pdf");
    expect(transport.sent).toHaveLength(1);
    await a.close();
  });

  // The max(50) sits on the RAW list, BEFORE the server's dedupe (shared
  // schema's own contract): 51 entries 400 even though deduping would
  // bring them to 50 -- pinned with a duplicate present so a reordering of
  // the two steps (dedupe-then-max would accept this) fails here.
  it("400s 51 forward ids even when a duplicate would dedupe them under the cap", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const response = await a.inject({
      method: "POST", url: "/api/mail/send", headers: authHeaders,
      payload: sendPayload(account.id, { forwardAttachmentIds: [...ids, ids[0] as string] }),
    });
    expect(response.statusCode).toBe(400);
    expect(transport.sent).toHaveLength(0);
    await a.close();
  });
});

// --- Attachments ------------------------------------------------------------

describe("mail attachment routes", () => {
  // A fresh account per call: a test seeding two attachments on one app would
  // otherwise hit the duplicate-mailbox 409 on the second.
  async function seedOne(a: App, opts: Parameters<typeof seedAttachment>[1] = {}) {
    const account = await makeAccount(a, { email: `chris+${randomUUID()}@example.com` });
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const messageId = await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    return seedAttachment(messageId, opts);
  }

  it("downloads with the stored mime, an attachment disposition and nosniff", async () => {
    const a = await app();
    const attachment = await seedOne(a, { filename: "invoice.pdf", mime: "application/pdf" });

    const response = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"])
      .toBe(`attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(attachment.body, "utf8")));
    expect(response.body).toBe(attachment.body);
    await a.close();
  });

  // mailparser decodes RFC 2047 encoded-words, so a filename arrives as full
  // Unicode -- and Node refuses to put any code point above U+00FF in a
  // header value at all (ERR_INVALID_CHAR, a 500 rather than a download).
  // U+8ACB U+6C42 U+66F8 is "invoice" in Chinese; UTF-8 encodes it as
  // E8 AB 8B E6 B1 82 E6 9B B8. The percent-encoding below is written out
  // literally rather than recomputed, so this asserts the real bytes.
  it("downloads a non-Latin filename with both an ASCII fallback and the RFC 5987 form", async () => {
    const a = await app();
    const filename = `${String.fromCharCode(0x8acb, 0x6c42, 0x66f8)}.pdf`;
    const attachment = await seedOne(a, { filename, mime: "application/pdf" });

    const response = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const disposition = response.headers["content-disposition"];
    expect(disposition).toBe(`attachment; filename="___.pdf"; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf`);
    // The header value itself must be transmittable: pure ASCII, no raw
    // Unicode anywhere in it.
    expect(disposition).toMatch(/^[\x20-\x7E]*$/);
    expect(response.body).toBe(attachment.body);
    await a.close();
  });

  it("serves a non-Latin inline image filename the same way", async () => {
    const a = await app();
    const filename = `${String.fromCharCode(0x8acb, 0x6c42, 0x66f8)}.png`;
    const attachment = await seedOne(a, { filename, mime: "image/png", isInline: true });

    const response = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}/inline`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"])
      .toBe(`inline; filename="___.png"; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8.png`);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(attachment.body, "utf8")));
    await a.close();
  });

  it("strips CR/LF and quotes from the ASCII fallback, and never emits an empty filename", async () => {
    const a = await app();
    const nasty = await seedOne(a, { filename: 'in"voice\r\nX-Injected: yes.pdf' });
    const nastyResponse = await a.inject({
      method: "GET", url: `/api/mail/attachments/${nasty.id}`, headers: authHeaders,
    });
    expect(nastyResponse.statusCode).toBe(200);
    expect(nastyResponse.headers["content-disposition"]).not.toContain("\r");
    expect(nastyResponse.headers["content-disposition"]).not.toContain("\n");
    expect(nastyResponse.headers["x-injected"]).toBeUndefined();
    expect(nastyResponse.headers["content-disposition"])
      .toBe(`attachment; filename="invoice__X-Injected: yes.pdf"; filename*=UTF-8''in%22voice%0D%0AX-Injected%3A%20yes.pdf`);

    // A name with nothing left after stripping becomes "download" rather than
    // an empty quoted-string.
    const blank = await seedOne(a, { filename: '  ""  ' });
    const blankResponse = await a.inject({
      method: "GET", url: `/api/mail/attachments/${blank.id}`, headers: authHeaders,
    });
    expect(blankResponse.headers["content-disposition"]).toContain('filename="download"');
    await a.close();
  });

  it("serves an inline image inline, with nosniff", async () => {
    const a = await app();
    const attachment = await seedOne(a, { filename: "logo.png", mime: "image/png", isInline: true });

    const response = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}/inline`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"])
      .toBe(`inline; filename="logo.png"; filename*=UTF-8''logo.png`);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    await a.close();
  });

  it("404s the inline route for an attachment that is not inline", async () => {
    const a = await app();
    const attachment = await seedOne(a, { filename: "invoice.pdf", mime: "application/pdf", isInline: false });

    const inline = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}/inline`, headers: authHeaders,
    });
    expect(inline.statusCode).toBe(404);
    // The same attachment downloads perfectly well.
    const download = await a.inject({ method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: authHeaders });
    expect(download.statusCode).toBe(200);
    await a.close();
  });

  it("refuses to render a non-image inline attachment in place, serving it as a download instead", async () => {
    const a = await app();
    const attachment = await seedOne(a, { filename: "payload.html", mime: "text/html", isInline: true });

    const response = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}/inline`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"])
      .toBe(`attachment; filename="payload.html"; filename*=UTF-8''payload.html`);
    await a.close();
  });

  it("404s an unknown attachment id on both routes", async () => {
    const a = await app();
    for (const url of [`/api/mail/attachments/${UNKNOWN_ID}`, `/api/mail/attachments/${UNKNOWN_ID}/inline`]) {
      const response = await a.inject({ method: "GET", url, headers: authHeaders });
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    }
    await a.close();
  });
});

// --- Templates --------------------------------------------------------------

describe("mail template routes", () => {
  it("runs the template CRUD happy path and sanitizes the body on write", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders,
      payload: { name: "Intro", subject: "Hello", bodyHtml: "<p>Hi</p><script>alert(1)</script>" },
    });
    expect(created.statusCode).toBe(201);
    const template = emailTemplateSchema.parse(created.json());
    expect(template.bodyHtml).not.toContain("script");

    const listed = await a.inject({ method: "GET", url: "/api/mail/templates", headers: authHeaders });
    expect(listed.statusCode).toBe(200);
    expect(emailTemplateSchema.array().parse(listed.json()).map((t) => t.id)).toEqual([template.id]);

    const patched = await a.inject({
      method: "PATCH", url: `/api/mail/templates/${template.id}`, headers: authHeaders,
      payload: { name: "Intro v2" },
    });
    expect(patched.statusCode).toBe(200);
    expect(emailTemplateSchema.parse(patched.json()).name).toBe("Intro v2");

    const archived = await a.inject({
      method: "POST", url: `/api/mail/templates/${template.id}/archive`, headers: authHeaders,
    });
    expect(archived.statusCode).toBe(200);
    const afterArchive = await a.inject({ method: "GET", url: "/api/mail/templates", headers: authHeaders });
    expect(emailTemplateSchema.array().parse(afterArchive.json())).toHaveLength(0);

    const restored = await a.inject({
      method: "POST", url: `/api/mail/templates/${template.id}/unarchive`, headers: authHeaders,
    });
    expect(restored.statusCode).toBe(200);
    expect(emailTemplateSchema.parse(restored.json()).archivedAt).toBeNull();
    await a.close();
  });

  it("lists archived templates only when archived=true is on the wire", async () => {
    const a = await app();
    const live = emailTemplateSchema.parse((await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders,
      payload: { name: "Live", bodyHtml: "<p>Live</p>" },
    })).json());
    const filed = emailTemplateSchema.parse((await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders,
      payload: { name: "Filed", bodyHtml: "<p>Filed</p>" },
    })).json());
    await a.inject({ method: "POST", url: `/api/mail/templates/${filed.id}/archive`, headers: authHeaders });

    async function ids(query: string): Promise<string[]> {
      const response = await a.inject({ method: "GET", url: `/api/mail/templates${query}`, headers: authHeaders });
      expect(response.statusCode).toBe(200);
      return emailTemplateSchema.array().parse(response.json()).map((t) => t.id);
    }
    expect(await ids("")).toEqual([live.id]);
    expect(await ids("?archived=false")).toEqual([live.id]);
    expect(await ids("?archived=true")).toEqual([filed.id]);
    await a.close();
  });

  it("is shared: one user sees and can edit another user's template", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders,
      payload: { name: "House style", bodyHtml: "<p>Hi</p>" },
    });
    const template = emailTemplateSchema.parse(created.json());

    const theirView = await a.inject({ method: "GET", url: "/api/mail/templates", headers: otherHeaders });
    expect(emailTemplateSchema.array().parse(theirView.json()).map((t) => t.id)).toEqual([template.id]);

    const theirEdit = await a.inject({
      method: "PATCH", url: `/api/mail/templates/${template.id}`, headers: otherHeaders, payload: { name: "Ours" },
    });
    expect(theirEdit.statusCode).toBe(200);
    await a.close();
  });

  it("400s an invalid body, 404s an unknown id, and 409s a body that sanitizes to nothing", async () => {
    const a = await app();
    const invalid = await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders, payload: { name: "", bodyHtml: "<p>Hi</p>" },
    });
    expect(invalid.statusCode).toBe(400);

    const unknown = await a.inject({
      method: "PATCH", url: `/api/mail/templates/${UNKNOWN_ID}`, headers: authHeaders, payload: { name: "x" },
    });
    expect(unknown.statusCode).toBe(404);

    const emptied = await a.inject({
      method: "POST", url: "/api/mail/templates", headers: authHeaders,
      payload: { name: "Hostile", bodyHtml: "<script>alert(1)</script>" },
    });
    expect(emptied.statusCode).toBe(409);
    expect(errorResponseSchema.parse(emptied.json()).error).toBe("conflict");
    await a.close();
  });
});

// --- Search -----------------------------------------------------------------

describe("search route: mail group", () => {
  it("returns one best-ranked hit per thread, rank ordered, excluding threads the viewer hid", async () => {
    const a = await app();
    const account = await makeAccount(a);

    const strong = await seedThread({ subject: "Invoice", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(strong, account.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), subject: "Invoice invoice invoice",
      bodyText: "invoice invoice invoice invoice", snippet: "best hit",
    });
    await seedMessage(strong, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), subject: "Re: Invoice",
      bodyText: "thanks", snippet: "weaker hit",
    });
    const weak = await seedThread({ subject: "Passing mention", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(weak, account.id, {
      sentAt: new Date("2026-08-03T10:00:00Z"), subject: "Lunch",
      bodyText: "we can talk about the invoice at lunch some time", snippet: "weak hit",
    });
    const filed = await seedThread({ subject: "Filed", lastMessageAt: new Date("2026-08-04T10:00:00Z") });
    await hideFor(filed);
    await seedMessage(filed, account.id, {
      sentAt: new Date("2026-08-04T10:00:00Z"), subject: "Invoice", bodyText: "invoice", snippet: "hidden hit",
    });

    const response = await a.inject({ method: "GET", url: "/api/search?q=invoice", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    // One row per thread, strongest first, the viewer's hidden thread absent.
    expect(body.mail.map((hit) => hit.threadId)).toEqual([strong, weak]);
    expect(body.mail[0]?.snippet).toBe("best hit");
    await a.close();
  });

  it("returns an empty mail group for a whitespace-only query without touching the database", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: "/api/search?q=%20", headers: authHeaders });
    expect(searchResultsSchema.parse(response.json()).mail).toEqual([]);
    await a.close();
  });
});

// --- Visibility (Phase 4.2) -------------------------------------------------
//
// The predicate matrix -- (owner | other viewer) x (private | shared account)
// x (unlinked | contact-linked | deal-linked thread) -- exercised against
// every read surface: list (inbox and record scopes), detail, all three
// unread computations, search, and the attachment bytes. chris owns every
// seeded mailbox; dana is the other authenticated user.
describe("mail thread visibility", () => {
  async function makeProject(a: App): Promise<{ id: string }> {
    const response = await a.inject({
      method: "POST", url: "/api/projects", headers: authHeaders, payload: { name: `Rollout ${randomUUID()}` },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  async function makeCompany(a: App): Promise<{ id: string }> {
    const response = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: `Acme ${randomUUID()}` },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  it("shows another user only shared-account threads in the inbox -- no link widens the mailbox view", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    const contact = await makeContact(a);
    const deal = await makeDeal(a);

    const unlinked = await seedThread({ subject: "Unlinked", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(unlinked, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z") });
    const contactLinked = await seedThread({
      subject: "Contact", lastMessageAt: new Date("2026-08-02T10:00:00Z"), contactId: contact.id,
    });
    await seedMessage(contactLinked, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const dealLinked = await seedThread({
      subject: "Deal", lastMessageAt: new Date("2026-08-03T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(dealLinked, priv.id, { sentAt: new Date("2026-08-03T10:00:00Z") });
    const onShared = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-04T10:00:00Z") });
    await seedMessage(onShared, shared.id, { sentAt: new Date("2026-08-04T10:00:00Z") });

    // The owner's inbox is untouched by the predicate: every thread is theirs.
    expect(await listIds(a, "", authHeaders)).toEqual([onShared, dealLinked, contactLinked, unlinked]);
    // The other user's inbox is a mailbox view: only the shared mailbox's
    // thread. Neither the auto-shaped contact link nor the deliberate deal
    // link puts a private conversation in someone else's INBOX.
    expect(await listIds(a, "", otherHeaders)).toEqual([onShared]);
    await a.close();
  });

  it("keeps the deal-link distinction: visible on the deal tab and in search, still absent from the inbox", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Renewal terms", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(threadId, priv.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), subject: "Renewal terms",
      bodyText: "quibbleworth pricing attached", snippet: "quibbleworth pricing",
    });

    expect(await listIds(a, "", otherHeaders)).toEqual([]);
    expect(await listIds(a, `deal_id=${deal.id}`, otherHeaders)).toEqual([threadId]);
    const found = await a.inject({ method: "GET", url: "/api/search?q=quibbleworth", headers: otherHeaders });
    expect(searchResultsSchema.parse(found.json()).mail.map((hit) => hit.threadId)).toEqual([threadId]);
    await a.close();
  });

  it("folds visibility into the folder EXISTS: a split thread does not surface in a folder it has no visible message in", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaOwn = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);

    // The trap shape: dana's own INBOX message plus a Projects message on
    // chris's private account. Independent folder and visibility EXISTS
    // would each pass and put the thread in dana's Projects view with
    // nothing visible there.
    const split = await seedThread({ subject: "Split", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(split, danaOwn.id, { sentAt: new Date("2026-08-01T10:00:00Z"), folder: "INBOX" });
    await seedMessage(split, chrisPrivate.id, { sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Projects" });

    expect(await listIds(a, "folder=Projects", otherHeaders)).toEqual([]);
    expect(await listIds(a, "folder=INBOX", otherHeaders)).toEqual([split]);
    // The owner's Projects view has it -- the fold is per viewer, not global.
    expect(await listIds(a, "folder=Projects", authHeaders)).toEqual([split]);
    await a.close();
  });

  it("returns nothing for an account filter naming a mailbox the viewer may not see into", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const threadId = await seedThread({ subject: "Mine", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    expect(await listIds(a, `account_id=${priv.id}`, otherHeaders)).toEqual([]);
    expect(await listIds(a, `account_id=${priv.id}`, authHeaders)).toEqual([threadId]);
    // Flipping the mailbox to shared is exactly what opens the same filter up.
    await setVisibility(priv.id, "shared");
    expect(await listIds(a, `account_id=${priv.id}`, otherHeaders)).toEqual([threadId]);
    await a.close();
  });

  it("keeps an archived shared mailbox visible to every user -- archiving stops the sync, never the sharing", async () => {
    const a = await app();
    const shared = await makeAccount(a);
    await setVisibility(shared.id, "shared");
    const threadId = await seedThread({ subject: "Archived shared", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, shared.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });

    const archived = await a.inject({
      method: "POST", url: `/api/mail/accounts/${shared.id}/archive`, headers: authHeaders,
    });
    expect(archived.statusCode).toBe(200);

    // DELIBERATE, pinned as intent (Phase 4.2 Task 4 review): ownedOrShared
    // carries no archivedAt term on purpose. Archiving is archive-not-delete
    // (the threads stay listed for their owner -- the 4.1 rule), and
    // visibility is a fact about the account ROW, not about whether its sync
    // loop runs -- so an archived shared mailbox keeps its threads in every
    // user's inbox, unread badge and search until someone unarchives it and
    // flips it back to private (the account PATCH refuses archived rows, so
    // unarchive -> flip is the only road back; the Settings toggle does not
    // render on an archived card). A future change of that intent must flip
    // this test consciously, not discover it as a surprise.
    expect(await listIds(a, "", otherHeaders)).toEqual([threadId]);
    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: otherHeaders });
    expect(badge.statusCode).toBe(200);
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(1);
    await a.close();
  });

  it("excludes another user's private unread mail from the unscoped and folder-scoped unread filters", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    const privUnread = await seedThread({ subject: "Private unread", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(privUnread, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const sharedUnread = await seedThread({ subject: "Shared unread", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(sharedUnread, shared.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false });

    expect(await listIds(a, "unread=true", authHeaders)).toEqual([privUnread, sharedUnread]);
    expect(await listIds(a, "unread=true", otherHeaders)).toEqual([sharedUnread]);
    expect(await listIds(a, "folder=INBOX&unread=true", otherHeaders)).toEqual([sharedUnread]);
    expect(await listIds(a, "folder=INBOX&unread=true", authHeaders)).toEqual([privUnread, sharedUnread]);
    await a.close();
  });

  it("never shares through a contact or company link: the record tabs stay owner-and-shared only", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const contact = await makeContact(a);
    const company = await makeCompany(a);
    const onContact = await seedThread({
      subject: "Contact tab", lastMessageAt: new Date("2026-08-02T10:00:00Z"), contactId: contact.id,
    });
    await seedMessage(onContact, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const onCompany = await seedThread({
      subject: "Company tab", lastMessageAt: new Date("2026-08-01T10:00:00Z"), companyId: company.id,
    });
    await seedMessage(onCompany, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z") });

    expect(await listIds(a, `contact_id=${contact.id}`, authHeaders)).toEqual([onContact]);
    expect(await listIds(a, `contact_id=${contact.id}`, otherHeaders)).toEqual([]);
    expect(await listIds(a, `company_id=${company.id}`, authHeaders)).toEqual([onCompany]);
    expect(await listIds(a, `company_id=${company.id}`, otherHeaders)).toEqual([]);
    await a.close();
  });

  it("shows a deal- or project-linked private thread on its record tab for every user, content included", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const project = await makeProject(a);
    const onDeal = await seedThread({
      subject: "Deal tab", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(onDeal, priv.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), snippet: "deal snippet", fromAddr: "bob@example.com", fromName: "Bob",
    });
    const onProject = await seedThread({
      subject: "Project tab", lastMessageAt: new Date("2026-08-01T10:00:00Z"), projectId: project.id,
    });
    await seedMessage(onProject, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z") });

    const response = await a.inject({
      method: "GET", url: `/api/mail/threads?deal_id=${deal.id}`, headers: otherHeaders,
    });
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    expect(body.items.map((t) => t.id)).toEqual([onDeal]);
    // Record scope means the linked conversation's content really is shared:
    // the row renders the private message's snippet, sender and account chip
    // for the other viewer -- who still owns none of it.
    expect(body.items[0]?.snippet).toBe("deal snippet");
    expect(body.items[0]?.senders.map((s) => s.address)).toEqual(["bob@example.com"]);
    expect(body.items[0]?.accountIds).toEqual([priv.id]);
    expect(body.items[0]?.ownedByViewer).toBe(false);

    expect(await listIds(a, `project_id=${project.id}`, otherHeaders)).toEqual([onProject]);
    await a.close();
  });

  it("keeps a contact tab honest when the thread is ALSO deal-linked: record-visible, so the other user sees it there", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const contact = await makeContact(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Both links", lastMessageAt: new Date("2026-08-02T10:00:00Z"),
      contactId: contact.id, dealId: deal.id,
    });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    // The contact tab filters to contact-linked threads and asks
    // record-visible of them -- which the deal link satisfies. The sharing
    // line is the deliberate deal link, not which tab renders the result.
    expect(await listIds(a, `contact_id=${contact.id}`, otherHeaders)).toEqual([threadId]);
    await a.close();
  });

  it("reports ownedByViewer per viewer on the same shared thread", async () => {
    const a = await app();
    const shared = await makeAccount(a);
    await setVisibility(shared.id, "shared");
    const threadId = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, shared.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    async function ownedFlag(headers: Record<string, string>): Promise<boolean | undefined> {
      const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers });
      return listResponseSchema(mailThreadListItemSchema).parse(response.json()).items[0]?.ownedByViewer;
    }
    expect(await ownedFlag(authHeaders)).toBe(true);
    expect(await ownedFlag(otherHeaders)).toBe(false);

    const chrisDetail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(mailThreadDetailSchema.parse(chrisDetail.json()).ownedByViewer).toBe(true);
    const danaDetail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    expect(mailThreadDetailSchema.parse(danaDetail.json()).ownedByViewer).toBe(false);
    await a.close();
  });

  it("renders a cross-account thread's row from the viewer's visible messages only", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaOwn = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    // One conversation, two mailboxes: dana's copy is older and read; chris's
    // copy is newer, unseen, and from a sender dana's mailbox never saw.
    const threadId = await seedThread({ subject: "Cross", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, danaOwn.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), seen: true, snippet: "dana copy",
      fromAddr: "alice@example.com", fromName: "Alice",
    });
    await seedMessage(threadId, chrisPrivate.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, snippet: "chris only",
      fromAddr: "secret@example.com", fromName: "Secret Sender",
    });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: otherHeaders });
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    const row = body.items.find((t) => t.id === threadId);
    // The thread is visible (dana's own mailbox carries it), but the row must
    // be built from dana's view of it: no snippet, sender, account chip or
    // unread dot from the message that lives only in chris's private mailbox.
    expect(row?.snippet).toBe("dana copy");
    expect(row?.senders.map((s) => s.address)).toEqual(["alice@example.com"]);
    expect(row?.accountIds).toEqual([danaOwn.id]);
    expect(row?.unread).toBe(false);
    expect(row?.ownedByViewer).toBe(true);

    // Symmetric for chris: dana's mailbox is just as private in the other
    // direction, so chris's row is built from chris's copy alone.
    const chrisView = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    const chrisRow = listResponseSchema(mailThreadListItemSchema).parse(chrisView.json())
      .items.find((t) => t.id === threadId);
    expect(chrisRow?.snippet).toBe("chris only");
    expect(chrisRow?.senders.map((s) => s.address)).toEqual(["secret@example.com"]);
    expect(chrisRow?.accountIds).toEqual([chrisPrivate.id]);
    expect(chrisRow?.unread).toBe(true);
    await a.close();
  });

  it("404s an invisible thread's detail indistinguishably from a nonexistent one", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const contact = await makeContact(a);
    const unlinked = await seedThread({ subject: "Private", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(unlinked, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const contactLinked = await seedThread({
      subject: "Auto-linked", lastMessageAt: new Date("2026-08-01T10:00:00Z"), contactId: contact.id,
    });
    await seedMessage(contactLinked, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z") });

    const missing = await a.inject({ method: "GET", url: `/api/mail/threads/${UNKNOWN_ID}`, headers: otherHeaders });
    expect(missing.statusCode).toBe(404);
    for (const threadId of [unlinked, contactLinked]) {
      const hidden = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
      expect(hidden.statusCode).toBe(404);
      // Identical bodies modulo the id: nothing in the response separates
      // "hidden from you" from "not there".
      expect(JSON.stringify(hidden.json()).replaceAll(threadId, UNKNOWN_ID)).toBe(JSON.stringify(missing.json()));
      // The owner still opens both.
      const own = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
      expect(own.statusCode).toBe(200);
    }
    await a.close();
  });

  it("opens a deal-linked private thread's detail for another user, messages included", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Linked", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    const messageId = await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    expect(response.statusCode).toBe(200);
    const body = mailThreadDetailSchema.parse(response.json());
    expect(body.messages.map((m) => m.id)).toEqual([messageId]);
    expect(body.ownedByViewer).toBe(false);
    await a.close();
  });

  it("filters invisible messages (and their attachments) out of a visible thread's detail, per viewer", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaOwn = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const threadId = await seedThread({ subject: "Cross", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const danaMessage = await seedMessage(threadId, danaOwn.id, { sentAt: new Date("2026-08-01T10:00:00Z") });
    const chrisMessage = await seedMessage(threadId, chrisPrivate.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const chrisAttachment = await seedAttachment(chrisMessage, { filename: "secret.pdf" });

    const danaView = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    const danaBody = mailThreadDetailSchema.parse(danaView.json());
    expect(danaBody.messages.map((m) => m.id)).toEqual([danaMessage]);
    expect(JSON.stringify(danaView.json())).not.toContain(chrisAttachment.id);

    // Symmetric: chris's view of the same thread hides dana's private copy.
    const chrisView = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(mailThreadDetailSchema.parse(chrisView.json()).messages.map((m) => m.id)).toEqual([chrisMessage]);
    await a.close();
  });

  it("scopes the badge to the viewer's mailboxes: private and merely deal-linked unread mail never counts for others", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    const deal = await makeDeal(a);

    const privUnread = await seedThread({ subject: "Private", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(privUnread, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false });
    const dealUnread = await seedThread({
      subject: "Deal", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(dealUnread, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const sharedUnread = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(sharedUnread, shared.id, { sentAt: new Date("2026-08-03T10:00:00Z"), seen: false });

    async function badge(headers: Record<string, string>): Promise<number> {
      const response = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers });
      return mailUnreadCountSchema.parse(response.json()).count;
    }
    // All three are the owner's own mailboxes.
    expect(await badge(authHeaders)).toBe(3);
    // The badge is the inbox's number, and the inbox is a mailbox view: the
    // deal-linked thread is record-visible to dana but not WAITING for dana.
    expect(await badge(otherHeaders)).toBe(1);
    await a.close();
  });

  it("scopes the per-folder counts to the viewer, leaving private folder names unlisted", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    const privThread = await seedThread({ subject: "Private", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(privThread, priv.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), seen: false, folder: "Clients",
    });
    const bothThread = await seedThread({ subject: "Both", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(bothThread, priv.id, { sentAt: new Date("2026-08-02T09:00:00Z"), seen: false, folder: "INBOX" });
    const sharedThread = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(sharedThread, shared.id, { sentAt: new Date("2026-08-03T10:00:00Z"), seen: false, folder: "INBOX" });

    async function folders(headers: Record<string, string>): Promise<Record<string, number>> {
      const response = await a.inject({ method: "GET", url: "/api/mail/unread-count?byFolder=1", headers });
      const body = mailUnreadFolderCountsSchema.parse(response.json());
      return Object.fromEntries(body.folders.map((row) => [row.folder, row.count]));
    }
    expect(await folders(authHeaders)).toEqual({ Clients: 1, INBOX: 2 });
    // dana's sidebar: the private mailbox contributes nothing -- not even the
    // NAME of its Clients folder -- and INBOX counts only the shared thread.
    expect(await folders(otherHeaders)).toEqual({ INBOX: 1 });
    await a.close();
  });

  it("serves attachment bytes only for a visible thread, on both attachment routes", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({ subject: "Files", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const messageId = await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const attachment = await seedAttachment(messageId, { filename: "contract.pdf" });
    const inline = await seedAttachment(messageId, { filename: "logo.png", mime: "image/png", isInline: true });

    for (const url of [`/api/mail/attachments/${attachment.id}`, `/api/mail/attachments/${inline.id}/inline`]) {
      const hidden = await a.inject({ method: "GET", url, headers: otherHeaders });
      expect(hidden.statusCode).toBe(404);
      const own = await a.inject({ method: "GET", url, headers: authHeaders });
      expect(own.statusCode).toBe(200);
    }

    // The deliberate deal link shares the conversation -- bytes included.
    await handle.db.update(mailThreads).set({ dealId: deal.id }).where(eq(mailThreads.id, threadId));
    const nowVisible = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: otherHeaders,
    });
    expect(nowVisible.statusCode).toBe(200);
    expect(nowVisible.body).toBe(attachment.body);
    await a.close();
  });

  it("hides an invisible message's attachment even when its thread is visible to the viewer", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaOwn = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const threadId = await seedThread({ subject: "Cross", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, danaOwn.id, { sentAt: new Date("2026-08-01T10:00:00Z") });
    const chrisMessage = await seedMessage(threadId, chrisPrivate.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const attachment = await seedAttachment(chrisMessage, { filename: "secret.pdf" });

    // Message granularity: dana sees the THREAD (their own mailbox carries
    // it), but this attachment hangs off the message that lives only in
    // chris's private mailbox.
    const hidden = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: otherHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    const own = await a.inject({
      method: "GET", url: `/api/mail/attachments/${attachment.id}`, headers: authHeaders,
    });
    expect(own.statusCode).toBe(200);
    await a.close();
  });

  it("404s every by-id thread mutation on an invisible thread, writing nothing", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const contact = await makeContact(a);
    const threadId = await seedThread({ subject: "Private", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });

    const attempts = [
      { method: "POST" as const, url: `/api/mail/threads/${threadId}/read` },
      { method: "POST" as const, url: `/api/mail/threads/${threadId}/links`, payload: { kind: "contact", id: contact.id } },
      { method: "DELETE" as const, url: `/api/mail/threads/${threadId}/links/contact` },
      { method: "POST" as const, url: `/api/mail/threads/${threadId}/archive` },
      { method: "POST" as const, url: `/api/mail/threads/${threadId}/unarchive` },
    ];
    for (const attempt of attempts) {
      const response = await a.inject({ ...attempt, headers: otherHeaders });
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    }
    // Nothing changed: still unseen, unlinked, and hidden for NOBODY -- the
    // route 404'd before any hide row could be written, so hiding an
    // invisible thread id discloses nothing even by side effect.
    const [thread] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, threadId));
    expect(thread?.contactId).toBeNull();
    expect(await handle.db.select().from(mailThreadHides).where(eq(mailThreadHides.threadId, threadId))).toEqual([]);
    const [message] = await handle.db.select().from(mailMessages).where(eq(mailMessages.threadId, threadId));
    expect(message?.seen).toBe(false);
    await a.close();
  });

  it("lets any viewer of a shared thread mark it read -- reading is not a filing act", async () => {
    const a = await app();
    const shared = await makeAccount(a);
    await setVisibility(shared.id, "shared");
    const threadId = await seedThread({ subject: "Shared", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, shared.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 21 });

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: otherHeaders });
    expect(response.statusCode).toBe(200);
    const [message] = await handle.db.select().from(mailMessages).where(eq(mailMessages.threadId, threadId));
    expect(message?.seen).toBe(true);
    await a.close();
  });

  // Mark-read scopes to what the viewer can read (coordinator amendment):
  // on an UNLINKED cross-account thread, the viewer's half marks read and
  // the other user's private copies keep their seen state -- and because the
  // write-back groups are built from the rows the UPDATE returned, no \Seen
  // ever flows toward an account whose messages the viewer cannot see.
  it("marks only the viewer's own half of an unlinked cross-account thread read", async () => {
    const a = await app();
    const chrisPrivate = await makeAccount(a);
    const danaOwn = await makeAccount(a, { label: "Dana", email: "dana@example.com" }, otherHeaders);
    const threadId = await seedThread({ subject: "Cross", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const danaMessage = await seedMessage(threadId, danaOwn.id, {
      sentAt: new Date("2026-08-01T10:00:00Z"), seen: false, imapUid: 31,
    });
    const chrisMessage = await seedMessage(threadId, chrisPrivate.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 32,
    });
    const danaSync = new FakeAccountSync();
    const chrisSync = new FakeAccountSync();
    syncs.set(danaOwn.id, danaSync);
    syncs.set(chrisPrivate.id, chrisSync);

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: otherHeaders });
    expect(response.statusCode).toBe(200);
    const rows = await handle.db.select().from(mailMessages).where(eq(mailMessages.threadId, threadId));
    expect(rows.find((row) => row.id === danaMessage)?.seen).toBe(true);
    // chris's private copy is untouched -- dana never read it.
    expect(rows.find((row) => row.id === chrisMessage)?.seen).toBe(false);
    expect(danaSync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [31] }]);
    expect(chrisSync.markSeenCalls).toEqual([]);
    await a.close();
  });

  it("marks the whole of a deal-linked thread read for any viewer -- the link makes every message readable", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Deal", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    const messageId = await seedMessage(threadId, priv.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 41,
    });
    const sync = new FakeAccountSync();
    syncs.set(priv.id, sync);

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: otherHeaders });
    expect(response.statusCode).toBe(200);
    const [message] = await handle.db.select().from(mailMessages).where(eq(mailMessages.id, messageId));
    expect(message?.seen).toBe(true);
    expect(sync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [41] }]);
    await a.close();
  });

  it("applies record scope to the unread FILTER on a deal tab, not just the flag", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const unread = await seedThread({
      subject: "Deal unread", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(unread, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const read = await seedThread({
      subject: "Deal read", lastMessageAt: new Date("2026-08-01T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(read, priv.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: true });

    // The tab CAN read the private unseen message (record scope), so
    // filtering the tab to unread keeps that thread -- for the other user
    // exactly as for the owner -- and drops the fully-read one.
    expect(await listIds(a, `deal_id=${deal.id}&unread=true`, otherHeaders)).toEqual([unread]);
    expect(await listIds(a, `deal_id=${deal.id}&unread=true`, authHeaders)).toEqual([unread]);
    expect(await listIds(a, `deal_id=${deal.id}`, otherHeaders)).toEqual([unread, read]);
    await a.close();
  });

  it("lights the deal tab's unread dot from the linked private message -- the record view CAN see it", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Deal", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });

    // Same thread, two scopes, two honest answers: dana's INBOX (a mailbox
    // view) has no unread here -- no row at all -- while the deal tab (the
    // CRM view) shows the row unread, because in THAT view the private
    // message is readable and unseen.
    const response = await a.inject({
      method: "GET", url: `/api/mail/threads?deal_id=${deal.id}`, headers: otherHeaders,
    });
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    expect(body.items[0]?.id).toBe(threadId);
    expect(body.items[0]?.unread).toBe(true);
    // ...and the badge still reads 0 for dana: record-visible is not "in my
    // mailbox" (the badge test above pins the same line from the other side).
    const badge = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: otherHeaders });
    expect(mailUnreadCountSchema.parse(badge.json()).count).toBe(0);
    await a.close();
  });

  it("keeps deal-linked private unread mail out of the other user's per-folder counts", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const deal = await makeDeal(a);
    const threadId = await seedThread({
      subject: "Deal", lastMessageAt: new Date("2026-08-02T10:00:00Z"), dealId: deal.id,
    });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });

    // The sidebar is the mailbox view, like the badge: a deal link makes the
    // conversation record-visible, not part of dana's mailbox topology.
    const response = await a.inject({ method: "GET", url: "/api/mail/unread-count?byFolder=1", headers: otherHeaders });
    expect(mailUnreadFolderCountsSchema.parse(response.json()).folders).toEqual([]);
    const own = await a.inject({ method: "GET", url: "/api/mail/unread-count?byFolder=1", headers: authHeaders });
    expect(mailUnreadFolderCountsSchema.parse(own.json()).folders).toEqual([{ folder: "INBOX", count: 1 }]);
    await a.close();
  });

  it("applies the predicate BEFORE the page limit: invisible threads neither fill pages nor break the keyset", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    // Visible and invisible threads interleaved by last_message_at, so a
    // filter applied AFTER the limit would return short, gappy pages while
    // every per-page assertion elsewhere stayed green.
    async function seedOn(accountId: string, subject: string, day: number): Promise<string> {
      const threadId = await seedThread({ subject, lastMessageAt: new Date(Date.UTC(2026, 7, day, 10)) });
      await seedMessage(threadId, accountId, { sentAt: new Date(Date.UTC(2026, 7, day, 10)) });
      return threadId;
    }
    const v1 = await seedOn(shared.id, "Visible 1", 5);
    await seedOn(priv.id, "Invisible 1", 4);
    const v2 = await seedOn(shared.id, "Visible 2", 3);
    await seedOn(priv.id, "Invisible 2", 2);
    const v3 = await seedOn(shared.id, "Visible 3", 1);

    const first = await a.inject({ method: "GET", url: "/api/mail/threads?limit=2", headers: otherHeaders });
    const page1 = listResponseSchema(mailThreadListItemSchema).parse(first.json());
    expect(page1.items.map((t) => t.id)).toEqual([v1, v2]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await a.inject({
      method: "GET",
      url: `/api/mail/threads?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      headers: otherHeaders,
    });
    const page2 = listResponseSchema(mailThreadListItemSchema).parse(second.json());
    expect(page2.items.map((t) => t.id)).toEqual([v3]);
    expect(page2.nextCursor).toBeNull();
    await a.close();
  });

  it("applies the same predicate to the Hidden view: hidden=true shows only what the viewer may see, of what THEY hid", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    // BOTH users hid both threads, so the two Hidden views differ only by
    // VISIBILITY: hiding an invisible thread through the fixture must not
    // make it appear anywhere (hidden-but-invisible stays invisible -- the
    // hide arm composes with the 4.2 predicate, never overrides it).
    const hiddenPrivate = await seedThread({
      subject: "Hidden private", lastMessageAt: new Date("2026-08-02T10:00:00Z"),
    });
    await seedMessage(hiddenPrivate, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });
    const hiddenShared = await seedThread({
      subject: "Hidden shared", lastMessageAt: new Date("2026-08-01T10:00:00Z"),
    });
    await seedMessage(hiddenShared, shared.id, { sentAt: new Date("2026-08-01T10:00:00Z") });
    for (const headers of [authHeaders, otherHeaders]) {
      await hideFor(hiddenPrivate, headers);
      await hideFor(hiddenShared, headers);
    }

    expect(await listIds(a, "hidden=true", authHeaders)).toEqual([hiddenPrivate, hiddenShared]);
    expect(await listIds(a, "hidden=true", otherHeaders)).toEqual([hiddenShared]);
    await a.close();
  });

  it("opens a project-linked private thread for another user -- the record scope's other deliberate arm", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const project = await makeProject(a);
    const threadId = await seedThread({
      subject: "Project bound", lastMessageAt: new Date("2026-08-02T10:00:00Z"), projectId: project.id,
    });
    await seedMessage(threadId, priv.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    expect(response.statusCode).toBe(200);
    expect(mailThreadDetailSchema.parse(response.json()).thread.id).toBe(threadId);
    await a.close();
  });

  it("excludes another user's private mail from search unless deliberately linked or shared", async () => {
    const a = await app();
    const priv = await makeAccount(a);
    const shared = await makeAccount(a, { label: "Team", email: "team@example.com" });
    await setVisibility(shared.id, "shared");
    const contact = await makeContact(a);
    const deal = await makeDeal(a);

    async function seedSearchable(subject: string, accountId: string, links: Partial<ThreadSeed> = {}): Promise<string> {
      const threadId = await seedThread({ subject, lastMessageAt: new Date("2026-08-02T10:00:00Z"), ...links });
      await seedMessage(threadId, accountId, {
        sentAt: new Date("2026-08-02T10:00:00Z"), subject, bodyText: `${subject} glimmerfen notes`, snippet: subject,
      });
      return threadId;
    }
    const unlinked = await seedSearchable("Unlinked", priv.id);
    const contactLinked = await seedSearchable("Contact", priv.id, { contactId: contact.id });
    const dealLinked = await seedSearchable("Deal", priv.id, { dealId: deal.id });
    const onShared = await seedSearchable("Shared", shared.id);

    async function mailHits(headers: Record<string, string>): Promise<string[]> {
      const response = await a.inject({ method: "GET", url: "/api/search?q=glimmerfen", headers });
      return searchResultsSchema.parse(response.json()).mail.map((hit) => hit.threadId).sort();
    }
    expect(await mailHits(authHeaders)).toEqual([unlinked, contactLinked, dealLinked, onShared].sort());
    // Search is a CRM surface (record scope): the deliberate deal link and
    // the shared mailbox are findable, the private and auto-linked mail is not.
    expect(await mailHits(otherHeaders)).toEqual([dealLinked, onShared].sort());
    await a.close();
  });
});

// --- Per-user hide (Phase 4.3) ----------------------------------------------
//
// The hide matrix -- (hider | other user) x (default list | Hidden view |
// detail | both standalone unread computations + the inherited list flag |
// record tabs | search) -- composed with the 4.2 visibility predicate. The
// spine of every test here: a hide changes exactly ONE person's default
// views and nobody else's anything, and it never changes what anyone MAY
// see -- only what the hider's default surfaces bother showing.
describe("per-user hide", () => {
  async function badge(a: App, headers: typeof authHeaders): Promise<number> {
    const response = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers });
    return mailUnreadCountSchema.parse(response.json()).count;
  }

  /** One shared-mailbox thread both users can see -- the base fixture the
   * matrix varies around. */
  async function sharedThread(a: App, opts: { seen?: boolean; subject?: string; day?: number } = {}) {
    const account = await makeAccount(a, { label: `Team ${randomUUID()}`, email: `team+${randomUUID()}@example.com` });
    await setVisibility(account.id, "shared");
    const when = new Date(Date.UTC(2026, 7, opts.day ?? 2, 10));
    const threadId = await seedThread({ subject: opts.subject ?? "Shared talk", lastMessageAt: when });
    await seedMessage(threadId, account.id, { sentAt: when, seen: opts.seen ?? true });
    return { account, threadId };
  }

  it("removes a hidden thread from the hider's default list only, and lists it in the hider's Hidden view with THEIR hiddenAt", async () => {
    const a = await app();
    const { threadId } = await sharedThread(a);
    const hiddenAt = new Date("2026-08-05T09:00:00.000Z");
    await hideFor(threadId, authHeaders, hiddenAt);

    expect(await listIds(a, "", authHeaders)).toEqual([]);
    expect(await listIds(a, "", otherHeaders)).toEqual([threadId]);
    expect(await listIds(a, "hidden=true", otherHeaders)).toEqual([]);

    const hiddenView = await a.inject({ method: "GET", url: "/api/mail/threads?hidden=true", headers: authHeaders });
    const rows = listResponseSchema(mailThreadListItemSchema).parse(hiddenView.json()).items;
    expect(rows.map((t) => t.id)).toEqual([threadId]);
    // hiddenAt on a Hidden-view row is the viewer's own filing moment,
    // straight off their hide row -- not anyone else's, not the request time.
    expect(rows[0]?.hiddenAt).toBe(hiddenAt.toISOString());
    // The other viewer's default row reports THEIR hide state: null.
    const others = await a.inject({ method: "GET", url: "/api/mail/threads", headers: otherHeaders });
    expect(listResponseSchema(mailThreadListItemSchema).parse(others.json()).items[0]?.hiddenAt).toBeNull();
    await a.close();
  });

  it("unhide restores the thread to the hider's default list and empties their Hidden view", async () => {
    const a = await app();
    const { threadId } = await sharedThread(a);
    await hideFor(threadId, authHeaders);

    const restored = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/unarchive`, headers: authHeaders });
    expect(restored.statusCode).toBe(200);
    expect(await listIds(a, "", authHeaders)).toEqual([threadId]);
    expect(await listIds(a, "hidden=true", authHeaders)).toEqual([]);
    // The other user's view never moved through any of it.
    expect(await listIds(a, "", otherHeaders)).toEqual([threadId]);
    await a.close();
  });

  it("keeps a hidden thread's detail fully open, reporting each viewer's own hiddenAt", async () => {
    const a = await app();
    const { threadId } = await sharedThread(a);
    await hideFor(threadId, authHeaders);

    // Hiding is filing, not a lock: the hider can still open the
    // conversation (it is where Unhide lives), messages included.
    const own = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: authHeaders });
    expect(own.statusCode).toBe(200);
    const ownDetail = mailThreadDetailSchema.parse(own.json());
    expect(ownDetail.thread.hiddenAt).not.toBeNull();
    expect(ownDetail.messages).toHaveLength(1);

    const others = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
    expect(others.statusCode).toBe(200);
    expect(mailThreadDetailSchema.parse(others.json()).thread.hiddenAt).toBeNull();
    await a.close();
  });

  it("drops a hidden unread thread from the hider's badge and per-folder counts, keeping the other viewer's", async () => {
    const a = await app();
    const { threadId } = await sharedThread(a, { seen: false });
    await hideFor(threadId, authHeaders);

    expect(await badge(a, authHeaders)).toBe(0);
    expect(await badge(a, otherHeaders)).toBe(1);

    async function inboxFolderCount(headers: typeof authHeaders): Promise<number | undefined> {
      const response = await a.inject({ method: "GET", url: "/api/mail/unread-count?byFolder=1", headers });
      const { folders } = mailUnreadFolderCountsSchema.parse(response.json());
      return folders.find((f) => f.folder === "INBOX")?.count;
    }
    // No INBOX row at all for the hider -- their one unread thread there is
    // filed away -- while the other viewer's sidebar still counts it.
    expect(await inboxFolderCount(authHeaders)).toBeUndefined();
    expect(await inboxFolderCount(otherHeaders)).toBe(1);
    await a.close();
  });

  it("inherits the exclusion in the unread list filter and flag -- no third computation to drift", async () => {
    const a = await app();
    const { threadId: hidden } = await sharedThread(a, { seen: false, subject: "Hidden unread", day: 3 });
    const { threadId: visible } = await sharedThread(a, { seen: false, subject: "Visible unread", day: 2 });
    await hideFor(hidden, authHeaders);

    // ?unread=true rides listThreads' WHERE, so the hidden unread thread is
    // out for the hider and in for everyone else -- same term, not a copy.
    expect(await listIds(a, "unread=true", authHeaders)).toEqual([visible]);
    expect(await listIds(a, "unread=true", otherHeaders)).toEqual([hidden, visible]);
    await a.close();
  });

  it("keeps hidden threads off the hider's record tabs while the Hidden view composes with the record filter", async () => {
    const a = await app();
    const contact = await makeContact(a);
    const account = await makeAccount(a, { label: "Tabbed", email: `tab+${randomUUID()}@example.com` });
    await setVisibility(account.id, "shared");
    const when = new Date("2026-08-02T10:00:00Z");
    const threadId = await seedThread({ subject: "Contact talk", lastMessageAt: when, contactId: contact.id });
    await seedMessage(threadId, account.id, { sentAt: when });
    await hideFor(threadId, authHeaders);

    // Record tabs are default surfaces: the hider's contact tab loses the
    // thread, the other viewer's keeps it (shared mailbox, so they may see
    // it there).
    expect(await listIds(a, `contact_id=${contact.id}`, authHeaders)).toEqual([]);
    expect(await listIds(a, `contact_id=${contact.id}`, otherHeaders)).toEqual([threadId]);
    // ...and the record filter composes with the Hidden view unchanged: the
    // same machinery, one inverted arm.
    expect(await listIds(a, `contact_id=${contact.id}&hidden=true`, authHeaders)).toEqual([threadId]);
    await a.close();
  });

  it("composes the Hidden view with the folder, account and unread filters", async () => {
    const a = await app();
    const first = await makeAccount(a, { label: "First", email: `first+${randomUUID()}@example.com` });
    const second = await makeAccount(a, { label: "Second", email: `second+${randomUUID()}@example.com` });

    const inboxUnread = await seedThread({ subject: "Hidden inbox unread", lastMessageAt: new Date("2026-08-03T10:00:00Z") });
    await seedMessage(inboxUnread, first.id, { sentAt: new Date("2026-08-03T10:00:00Z"), folder: "INBOX", seen: false });
    const projectsRead = await seedThread({ subject: "Hidden projects read", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(projectsRead, second.id, { sentAt: new Date("2026-08-02T10:00:00Z"), folder: "Projects", seen: true });
    const notHidden = await seedThread({ subject: "Still inbox", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    await seedMessage(notHidden, first.id, { sentAt: new Date("2026-08-01T10:00:00Z"), folder: "INBOX", seen: false });
    await hideFor(inboxUnread, authHeaders);
    await hideFor(projectsRead, authHeaders);

    expect(await listIds(a, "hidden=true", authHeaders)).toEqual([inboxUnread, projectsRead]);
    expect(await listIds(a, "hidden=true&folder=INBOX", authHeaders)).toEqual([inboxUnread]);
    expect(await listIds(a, "hidden=true&folder=Projects", authHeaders)).toEqual([projectsRead]);
    expect(await listIds(a, `hidden=true&account_id=${second.id}`, authHeaders)).toEqual([projectsRead]);
    expect(await listIds(a, "hidden=true&unread=true", authHeaders)).toEqual([inboxUnread]);
    // The default views agree from the other side of the same arm.
    expect(await listIds(a, "folder=INBOX", authHeaders)).toEqual([notHidden]);
    expect(await listIds(a, "unread=true", authHeaders)).toEqual([notHidden]);
    await a.close();
  });

  // The INVISIBLE-thread half of "other users are entirely unaffected":
  // dana could not see the thread to begin with, so what this pins is that
  // the hide gives her no HINT of its existence either -- every leg of her
  // world is empty before and stays byte-identically empty after. The
  // discriminating (visible-thread) half is the next test.
  it("never leaks existence: hiding a visible thread changes nothing for a user who cannot see it", async () => {
    const a = await app();
    // A PRIVATE thread of chris's: dana may not see it, hidden or not.
    const priv = await makeAccount(a);
    const threadId = await seedThread({
      subject: "Private glimmerfen", lastMessageAt: new Date("2026-08-02T10:00:00Z"),
    });
    await seedMessage(threadId, priv.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false,
      subject: "Private glimmerfen", bodyText: "glimmerfen plans", snippet: "private",
    });

    async function danasWorld() {
      const search = await a.inject({ method: "GET", url: "/api/search?q=glimmerfen", headers: otherHeaders });
      return {
        inbox: await listIds(a, "", otherHeaders),
        hiddenView: await listIds(a, "hidden=true", otherHeaders),
        badge: await badge(a, otherHeaders),
        mailHits: searchResultsSchema.parse(search.json()).mail.map((hit) => hit.threadId),
        detailStatus: (await a.inject({
          method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders,
        })).statusCode,
      };
    }

    const before = await danasWorld();
    // The hider files their own view; dana's whole HTTP world must read the
    // same bytes afterwards. Scoped to HTTP deliberately: the one thing a
    // hide DOES broadcast is its SSE invalidation frame, which sse.ts fans
    // (thread id included) to every subscriber -- the known id-broadcast
    // the bulk route's header documents. What this pins is that the frame
    // buys an observer nothing: every surface they can actually ask answers
    // identically.
    const hide = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    expect(hide.statusCode).toBe(200);
    expect(await danasWorld()).toEqual(before);
    expect(before.detailStatus).toBe(404);
    expect(before.inbox).toEqual([]);
    await a.close();
  });

  // The VISIBLE-thread half, and the discriminating one: dana genuinely
  // sees this thread on every surface, so a leak of chris's hide would have
  // real bytes to change. The spec's "Other users are entirely unaffected
  // by your hides" pinned as ONE world-comparison -- full row payloads, not
  // just ids, so a leaked hiddenAt, a flipped unread dot or a bumped
  // updated_at (the hide never touches the shared thread row) would all
  // fail it -- rather than as piecemeal per-surface assertions.
  it("leaves another VIEWER's whole world byte-identical when the hider files a thread they both see", async () => {
    const a = await app();
    const shared = await makeAccount(a, { label: "Both", email: `both+${randomUUID()}@example.com` });
    await setVisibility(shared.id, "shared");
    const threadId = await seedThread({
      subject: "Shared quellwater", lastMessageAt: new Date("2026-08-02T10:00:00Z"),
    });
    await seedMessage(threadId, shared.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false,
      subject: "Shared quellwater", bodyText: "quellwater plans", snippet: "shared",
    });

    async function danasWorld() {
      const inbox = await a.inject({ method: "GET", url: "/api/mail/threads", headers: otherHeaders });
      const hiddenView = await a.inject({ method: "GET", url: "/api/mail/threads?hidden=true", headers: otherHeaders });
      const search = await a.inject({ method: "GET", url: "/api/search?q=quellwater", headers: otherHeaders });
      const detail = await a.inject({ method: "GET", url: `/api/mail/threads/${threadId}`, headers: otherHeaders });
      expect(detail.statusCode).toBe(200);
      return {
        inbox: listResponseSchema(mailThreadListItemSchema).parse(inbox.json()),
        hiddenView: listResponseSchema(mailThreadListItemSchema).parse(hiddenView.json()),
        badge: await badge(a, otherHeaders),
        mailHits: searchResultsSchema.parse(search.json()).mail,
        detail: mailThreadDetailSchema.parse(detail.json()),
      };
    }

    const before = await danasWorld();
    // The premise that gives the comparison teeth: her world actually
    // carries the thread everywhere before the hide.
    expect(before.inbox.items.map((t) => t.id)).toEqual([threadId]);
    expect(before.badge).toBe(1);
    expect(before.mailHits.map((hit) => hit.threadId)).toEqual([threadId]);

    const hide = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    expect(hide.statusCode).toBe(200);
    expect(await danasWorld()).toEqual(before);
    await a.close();
  });
});
