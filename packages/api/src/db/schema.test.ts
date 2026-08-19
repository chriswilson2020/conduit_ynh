import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mailSecuritySchema, mailAccountStatusSchema, mailDirectionSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { createContact } from "../services/contacts.js";
import { createPipeline, createStage } from "../services/pipelines.js";
import { createDeal } from "../services/deals.js";
import { createProject } from "../services/projects.js";
import {
  companies, mailAccounts, mailFolderState, mailThreads, mailMessages, mailAttachments, emailTemplates,
} from "./schema.js";

const handle = openTestDatabase();
let userId: string;

beforeEach(async () => {
  await truncateAll(handle);
  userId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

/** Minimal valid mail_accounts row, overridable per test. */
function accountValues(overrides: Partial<typeof mailAccounts.$inferInsert> = {}) {
  return {
    userId, label: "Work", email: "chris@example.com",
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
    username: "chris", credentialsCiphertext: "v1:iv:tag:data",
    ...overrides,
  } satisfies typeof mailAccounts.$inferInsert;
}

describe("mail schema (0004)", () => {
  // "0002-style" migration test: companies/contacts/deals/projects are
  // created through the same pre-existing (Phase 0-3) service layer this
  // migration leaves untouched, then mail_threads links to all four --
  // proving 0004 is genuinely additive: the old tables need no changes at
  // all for the new FKs to resolve against real rows created the old way.
  it("links a mail_thread to pre-existing company/contact/deal/project rows created through the Phase 0-3 services", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const contact = await createContact(handle.db, userId, { firstName: "Bob", companyId: company.id });
    const pipeline = await createPipeline(handle.db, userId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, userId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, userId, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const project = await createProject(handle.db, userId, { name: "Rollout" });

    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Re: Big Deal", lastMessageAt: new Date(),
      companyId: company.id, contactId: contact.id, dealId: deal.id, projectId: project.id,
    }).returning();
    const [message] = await handle.db.insert(mailMessages).values({
      accountId: account!.id, threadId: thread!.id,
      messageId: "<m1@example.com>",
      fromAddr: "bob@example.com", toAddrs: [{ address: "chris@example.com" }],
      sentAt: new Date(), folder: "INBOX", direction: "inbound",
    }).returning();
    const [attachment] = await handle.db.insert(mailAttachments).values({
      messageId: message!.id, filename: "a.pdf", mime: "application/pdf",
      sizeBytes: 10, blobPath: "ab/cd",
    }).returning();

    expect(thread?.companyId).toBe(company.id);
    expect(thread?.contactId).toBe(contact.id);
    expect(thread?.dealId).toBe(deal.id);
    expect(thread?.projectId).toBe(project.id);
    expect(message?.threadId).toBe(thread!.id);
    expect(attachment?.messageId).toBe(message!.id);

    // The pre-existing company row itself is untouched -- still readable
    // exactly as the old (pre-0004) schema would have returned it.
    const [rereadCompany] = await handle.db.select().from(companies).where(eq(companies.id, company.id));
    expect(rereadCompany).toMatchObject({ id: company.id, name: "Acme" });
  });

  it("applies every column default when a row supplies only the required fields", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    expect(account).toMatchObject({
      sentFolder: "Sent", backfillDays: 90, status: "active", signatureHtml: null, lastError: null,
    });

    const [folder] = await handle.db.insert(mailFolderState).values({
      accountId: account!.id, folder: "INBOX", uidvalidity: 1,
    }).returning();
    expect(folder?.lastSeenUid).toBe(0);

    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    expect(thread?.messageCount).toBe(0);
    expect(thread).toMatchObject({ companyId: null, contactId: null, dealId: null, projectId: null });

    const [message] = await handle.db.insert(mailMessages).values({
      accountId: account!.id, threadId: thread!.id, messageId: "<m2@example.com>",
      fromAddr: "bob@example.com", toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "outbound",
    }).returning();
    expect(message).toMatchObject({
      referencesIds: [], ccAddrs: [], bccAddrs: [], subject: "", bodyText: "", snippet: "", seen: false,
    });

    const [attachment] = await handle.db.insert(mailAttachments).values({
      messageId: message!.id, filename: "a.pdf", mime: "application/pdf", sizeBytes: 1, blobPath: "x",
    }).returning();
    expect(attachment?.isInline).toBe(false);

    const [template] = await handle.db.insert(emailTemplates).values({
      name: "Follow-up", bodyHtml: "<p>Hi</p>",
    }).returning();
    expect(template?.subject).toBe("");
  });

  it("enforces UNIQUE (account_id, folder) on mail_folder_state", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    await handle.db.insert(mailFolderState).values({ accountId: account!.id, folder: "INBOX", uidvalidity: 1 });
    await expect(
      handle.db.insert(mailFolderState).values({ accountId: account!.id, folder: "INBOX", uidvalidity: 2 }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_folder_state_account_folder_unique|unique/i) },
    });
  });

  it("enforces UNIQUE (account_id, message_id) on mail_messages -- the same message re-seen collapses to one row", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    const shared = {
      accountId: account!.id, threadId: thread!.id, messageId: "<dup@example.com>",
      fromAddr: "bob@example.com", toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "inbound" as const,
    };
    await handle.db.insert(mailMessages).values(shared);
    await expect(handle.db.insert(mailMessages).values(shared)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_messages_account_message_unique|unique/i) },
    });
  });

  // Mirrors timeline.test.ts's "keeps eventVerbSchema and the events.verb DB
  // CHECK in sync" pattern for all three of this migration's enum CHECKs at
  // once: every value in each zod enum must both parse and survive a real
  // insert, and a value outside the enum must be rejected by the CHECK.
  it("keeps mailSecuritySchema/mailAccountStatusSchema/mailDirectionSchema in sync with their DB CHECKs", async () => {
    expect(mailSecuritySchema.options).toEqual(["tls", "starttls"]);
    expect(mailAccountStatusSchema.options).toEqual(["active", "error"]);
    expect(mailDirectionSchema.options).toEqual(["inbound", "outbound"]);

    for (const imapSecurity of mailSecuritySchema.options) {
      await handle.db.insert(mailAccounts).values(accountValues({ imapSecurity, label: imapSecurity }));
    }
    await expect(
      handle.db.insert(mailAccounts).values(accountValues({ imapSecurity: "plaintext" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_imap_security_valid|check/i) },
    });

    for (const status of mailAccountStatusSchema.options) {
      await handle.db.insert(mailAccounts).values(accountValues({ status, label: status }));
    }
    await expect(
      handle.db.insert(mailAccounts).values(accountValues({ status: "syncing" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_status_valid|check/i) },
    });

    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    for (const direction of mailDirectionSchema.options) {
      await handle.db.insert(mailMessages).values({
        accountId: account!.id, threadId: thread!.id, messageId: `<${direction}@example.com>`,
        fromAddr: "bob@example.com", toAddrs: [], sentAt: new Date(), folder: "INBOX", direction,
      });
    }
    await expect(
      handle.db.insert(mailMessages).values({
        accountId: account!.id, threadId: thread!.id, messageId: "<sideways@example.com>",
        fromAddr: "bob@example.com", toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "sideways",
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_messages_direction_valid|check/i) },
    });
  });

  // The whole point of the hand-written GENERATED ALWAYS AS column and its
  // GIN index: proves the generated expression is valid SQL (the migration
  // would already have failed to apply if not) AND that it actually indexes
  // subject/body_text/from_addr/from_name the way the spec describes.
  it("computes the search tsvector generated column from subject/body_text/from_addr/from_name, queryable via to_tsquery", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    const [hit] = await handle.db.insert(mailMessages).values({
      accountId: account!.id, threadId: thread!.id, messageId: "<needle@example.com>",
      subject: "Quixotic proposal", bodyText: "no relevant words here",
      fromAddr: "sender@example.com", fromName: "Wexfordbay",
      toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "inbound",
    }).returning();
    await handle.db.insert(mailMessages).values({
      accountId: account!.id, threadId: thread!.id, messageId: "<miss@example.com>",
      subject: "Ordinary subject", bodyText: "ordinary body", fromAddr: "someone@example.com",
      toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "inbound",
    });

    const bySubject = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM mail_messages WHERE search @@ to_tsquery('english', 'quixotic')`,
    );
    expect(bySubject.map((r) => r.id)).toEqual([hit!.id]);

    const byFromName = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM mail_messages WHERE search @@ to_tsquery('english', 'wexfordbay')`,
    );
    expect(byFromName.map((r) => r.id)).toEqual([hit!.id]);

    const noMatch = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM mail_messages WHERE search @@ to_tsquery('english', 'nonexistentword')`,
    );
    expect(noMatch).toHaveLength(0);

    // Confirmed indexed, not just computed: the GIN index this migration
    // hand-writes must actually exist on the column.
    const indexes = await handle.db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'mail_messages' AND indexdef ILIKE '%gin%search%'`,
    );
    expect(indexes.length).toBeGreaterThan(0);
  });

  it("has the four hand-written mail_threads indexes plus mail_messages(thread_id) and mail_threads(last_message_at)", async () => {
    const rows = await handle.db.execute<{ tablename: string; indexname: string }>(
      sql`SELECT tablename, indexname FROM pg_indexes WHERE tablename IN ('mail_threads','mail_messages')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "mail_threads_company_id_idx", "mail_threads_contact_id_idx",
      "mail_threads_deal_id_idx", "mail_threads_project_id_idx",
      "mail_threads_last_message_at_idx", "mail_messages_thread_id_idx",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("stores to_addrs/cc_addrs/bcc_addrs as structured jsonb, not stringified JSON", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    const to = [{ address: "chris@example.com", name: "Chris" }];
    const [message] = await handle.db.insert(mailMessages).values({
      accountId: account!.id, threadId: thread!.id, messageId: "<json@example.com>",
      fromAddr: "bob@example.com", toAddrs: to, sentAt: new Date(), folder: "INBOX", direction: "inbound",
    }).returning();

    const [reread] = await handle.db.select().from(mailMessages).where(eq(mailMessages.id, message!.id));
    expect(reread?.toAddrs).toEqual(to);
  });
});
