import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import {
  contactSchema, dealSchema, errorResponseSchema, listResponseSchema, pipelineSchema, stageSchema,
  mailAccountSchema, mailAccountListSchema, mailAccountTestResultSchema, mailThreadSchema,
  mailThreadListItemSchema, mailThreadDetailSchema, mailMessageSchema, mailUnreadCountSchema,
  mailUnreadFolderCountsSchema, mailAccountFolderSchema, bulkThreadResultSchema,
  emailTemplateSchema, searchResultsSchema,
  type MailAccountCreateInput, type MailAccountSyncStats, type SendMailInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import {
  mailAccountFolders, mailAccounts, mailAttachments, mailMessages, mailThreads,
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
  archived?: boolean;
}

async function seedThread(seed: ThreadSeed): Promise<string> {
  const [row] = await handle.db.insert(mailThreads).values({
    subject: seed.subject ?? "Quarterly review",
    lastMessageAt: seed.lastMessageAt,
    messageCount: 1,
    companyId: seed.companyId ?? null, contactId: seed.contactId ?? null,
    dealId: seed.dealId ?? null, projectId: seed.projectId ?? null,
    archivedAt: seed.archived === true ? new Date() : null,
  }).returning();
  if (row === undefined) throw new Error("seedThread: no row");
  return row.id;
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
  it("lists an account's folders with route-computed locked flags and the discovery fields", async () => {
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
  it("lists non-archived threads newest-first with their derived row fields", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const older = await seedThread({ subject: "Older", lastMessageAt: new Date("2026-08-01T10:00:00Z") });
    const newer = await seedThread({ subject: "Newer", lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    const archived = await seedThread({ subject: "Gone", lastMessageAt: new Date("2026-08-03T10:00:00Z"), archived: true });
    await seedMessage(older, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: true, snippet: "Older body" });
    await seedMessage(newer, account.id, {
      sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, snippet: "Newer body", fromAddr: "bob@example.com", fromName: "Bob",
    });
    await seedMessage(archived, account.id, { sentAt: new Date("2026-08-03T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    expect(body.items.map((t) => t.subject)).toEqual(["Newer", "Older"]);
    expect(body.items[0]?.unread).toBe(true);
    expect(body.items[0]?.snippet).toBe("Newer body");
    expect(body.items[0]?.senders.map((s) => s.address)).toEqual(["bob@example.com"]);
    expect(body.items[0]?.accountIds).toEqual([account.id]);
    expect(body.items[1]?.unread).toBe(false);
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
  // would take the whole inbox down, and a defensive default is cheap.
  it("renders a thread with no messages instead of failing the page", async () => {
    const a = await app();
    const threadId = await seedThread({ subject: "Empty", lastMessageAt: new Date("2026-08-02T10:00:00Z") });

    const response = await a.inject({ method: "GET", url: "/api/mail/threads", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(mailThreadListItemSchema).parse(response.json());
    const row = body.items.find((t) => t.id === threadId);
    expect(row).toBeDefined();
    expect(row?.unread).toBe(false);
    expect(row?.snippet).toBe("");
    expect(row?.senders).toEqual([]);
    expect(row?.accountIds).toEqual([]);
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

  it("filters by account, unread, archived and the four record links, ANDed together", async () => {
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
    const archived = await seedThread({ subject: "Filed", lastMessageAt: new Date("2026-08-03T10:00:00Z"), archived: true });
    await seedMessage(archived, first.id, { sentAt: new Date("2026-08-03T10:00:00Z") });

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
    expect(await subjects("archived=true")).toEqual(["Filed"]);
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
    expect(mailThreadSchema.parse(response.json()).id).toBe(threadId);

    const after = await a.inject({ method: "GET", url: "/api/mail/unread-count", headers: authHeaders });
    expect(mailUnreadCountSchema.parse(after.json()).count).toBe(0);
    expect(sync.markSeenCalls).toEqual([{ folder: "INBOX", uids: [11, 12] }]);
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

  // The one thread mutation an archive does NOT block, deliberately -- see
  // markThreadRead's doc comment. An archived conversation is still openable,
  // and opening it is what marks it read.
  it("marks an ARCHIVED thread read rather than refusing it", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z"), archived: true });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false, imapUid: 41 });

    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(mailThreadSchema.parse(response.json()).archivedAt).not.toBeNull();
    const rows = await handle.db.select({ seen: mailMessages.seen }).from(mailMessages)
      .where(eq(mailMessages.threadId, threadId));
    expect(rows.every((row) => row.seen)).toBe(true);
    // Setting a link on the same archived thread IS refused -- the asymmetry
    // is intentional, not an oversight.
    const contact = await makeContact(a);
    const link = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "contact", id: contact.id },
    });
    expect(link.statusCode).toBe(409);
    await a.close();
  });

  it("404s an unknown thread", async () => {
    const a = await app();
    const response = await a.inject({ method: "POST", url: `/api/mail/threads/${UNKNOWN_ID}/read`, headers: authHeaders });
    expect(response.statusCode).toBe(404);
    await a.close();
  });
});

// --- Threads: links and archive ---------------------------------------------

describe("mail thread link and archive routes", () => {
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

  it("archives and unarchives a thread CRM-side, and refuses link changes while archived", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const contact = await makeContact(a);
    const threadId = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(threadId, account.id, { sentAt: new Date("2026-08-02T10:00:00Z") });

    const archived = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);
    expect(mailThreadSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const whileArchived = await a.inject({
      method: "POST", url: `/api/mail/threads/${threadId}/links`, headers: authHeaders,
      payload: { kind: "contact", id: contact.id },
    });
    expect(whileArchived.statusCode).toBe(409);

    const restored = await a.inject({ method: "POST", url: `/api/mail/threads/${threadId}/unarchive`, headers: authHeaders });
    expect(restored.statusCode).toBe(200);
    expect(mailThreadSchema.parse(restored.json()).archivedAt).toBeNull();

    const unknown = await a.inject({ method: "POST", url: `/api/mail/threads/${UNKNOWN_ID}/archive`, headers: authHeaders });
    expect(unknown.statusCode).toBe(404);
    await a.close();
  });

  it("counts unread threads, not unread messages, and ignores archived threads", async () => {
    const a = await app();
    const account = await makeAccount(a);
    const busy = await seedThread({ lastMessageAt: new Date("2026-08-02T10:00:00Z") });
    await seedMessage(busy, account.id, { sentAt: new Date("2026-08-01T10:00:00Z"), seen: false });
    await seedMessage(busy, account.id, { sentAt: new Date("2026-08-02T10:00:00Z"), seen: false });
    const filed = await seedThread({ lastMessageAt: new Date("2026-08-03T10:00:00Z"), archived: true });
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

    // ...and the unread FILTER agrees with both of them. It is the third
    // unread computation, and all three carve out Trash: without it this
    // response returned the trashed thread while the same body said
    // `unread: false` about it.
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

    // "Hide in CRM" is the pre-4.1 thread archive in bulk: a CRM column, no
    // IMAP work at all, and `folder` is ignored entirely.
    const hide = await bulk(a, { threadIds: [hidden], action: "hide" });
    expect(hide.statusCode).toBe(200);
    expect(bulkThreadResultSchema.parse(hide.json()).results).toEqual([{ threadId: hidden, ok: true }]);
    const [row] = await handle.db.select().from(mailThreads).where(eq(mailThreads.id, hidden));
    expect(row?.archivedAt).not.toBeNull();
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
    // Already in the target folder: nothing to do, and a no-op is a success.
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
    // Per-thread results, in REQUEST order, and the error strings are the
    // stable user-facing ones the bulk bar surfaces (Task 5).
    expect(bulkThreadResultSchema.parse(response.json()).results).toEqual([
      { threadId: moved, ok: true },
      { threadId: refused, ok: false, error: 'mail sync is not running for account "Stalled"' },
      { threadId: already, ok: true, skipped: true },
      { threadId: pending, ok: true, skipped: true },
      { threadId: UNKNOWN_ID, ok: false, error: `mail thread ${UNKNOWN_ID} not found` },
    ]);
    // The healthy account still did its work: one refusal does not stop the rest.
    expect(sync.moveCalls).toEqual([{ folder: "INBOX", uids: [71], targetFolder: "Archive" }]);
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
      { threadId: thread, ok: false, error: "NO [TRYCREATE] Mailbox does not exist" },
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
      { threadId: thread, ok: false, error: 'mail sync is not running for account "Work"' },
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
      threadId: thread, ok: false,
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
  it("returns one best-ranked hit per thread, rank ordered, excluding archived threads", async () => {
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
    const filed = await seedThread({ subject: "Filed", lastMessageAt: new Date("2026-08-04T10:00:00Z"), archived: true });
    await seedMessage(filed, account.id, {
      sentAt: new Date("2026-08-04T10:00:00Z"), subject: "Invoice", bodyText: "invoice", snippet: "archived hit",
    });

    const response = await a.inject({ method: "GET", url: "/api/search?q=invoice", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    // One row per thread, strongest first, archived thread absent.
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
