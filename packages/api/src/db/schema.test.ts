import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mailSecuritySchema, mailAccountStatusSchema, mailDirectionSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { createContact } from "../services/contacts.js";
import { createPipeline, createStage } from "../services/pipelines.js";
import { createDeal } from "../services/deals.js";
import { createProject } from "../services/projects.js";
import { createDatabase, migrationsFolder } from "./client.js";
import {
  users, companies, contacts, pipelines, stages, deals, projects,
  mailAccounts, mailFolderState, mailThreads, mailMessages, mailAttachments, emailTemplates,
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
  // NOT an upgrade-with-data test -- this runs against handle.db, which
  // global-setup.ts has already migrated all the way through 0004 before any
  // test file executes, so it never observes a genuinely pre-0004 database.
  // What it verifies: mail_threads' FKs resolve correctly against rows
  // created through the ordinary (unmodified) Phase 0-3 service layer, i.e.
  // post-migration linkage, not upgrade survival. The actual upgrade-with-
  // data scenario (apply 0004 on top of an already-populated pre-0004
  // database) is covered separately below, in a scratch database created
  // and dropped just for that test.
  it("links a mail_thread to company/contact/deal/project rows created through the Phase 0-3 services", async () => {
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

    // The company row itself is unaffected by anything mail-related.
    const [rereadCompany] = await handle.db.select().from(companies).where(eq(companies.id, company.id));
    expect(rereadCompany).toMatchObject({ id: company.id, name: "Acme" });
  });

  // The genuine "0002-style" upgrade test: a real database migrated only
  // through 0003 (built from a trimmed copy of the real 0000-0003 migration
  // files, mirroring a848ce1's "0000+0001 with real rows, then 0002 on top"
  // precedent), populated with pre-existing data while still in that old
  // state, THEN migrated forward with 0004 -- proving the migration itself
  // (not just the resulting schema) applies cleanly on top of a populated
  // database and leaves that data intact. Runs against its own scratch
  // database (created and dropped here), never touching the shared
  // conduit_test database other sessions rely on.
  it("applies migration 0004 on top of a real database already migrated only through 0003 and already carrying data", async () => {
    const dbName = `conduit_test_upgrade_${randomUUID().replace(/-/g, "")}`;
    const realFolder = migrationsFolder();
    const journal = JSON.parse(
      readFileSync(path.join(realFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // Derived, not hardcoded to idx <= 3: locates 0004 by tag and takes
    // everything strictly before it, so a future 0005 (added after 0004
    // ships and this migration stops being hand-editable) doesn't silently
    // change what "pre-0004" means here.
    const migration0004 = journal.entries.find((e) => e.tag.startsWith("0004_"));
    if (migration0004 === undefined) throw new Error("could not find a 0004 migration in the journal");
    const pre0004Entries = journal.entries.filter((e) => e.idx < migration0004.idx);
    const tmpFolder = mkdtempSync(path.join(tmpdir(), "conduit-pre0004-"));

    // CREATE DATABASE and every subsequent step live inside the try so the
    // finally below always runs cleanup, including on a failure between
    // creating the database and finishing the migration/insert sequence
    // (rather than leaking a scratch database that partially succeeded).
    let scratch: ReturnType<typeof createDatabase> | undefined;
    try {
      mkdirSync(path.join(tmpFolder, "meta"));
      for (const entry of pre0004Entries) {
        copyFileSync(path.join(realFolder, `${entry.tag}.sql`), path.join(tmpFolder, `${entry.tag}.sql`));
      }
      writeFileSync(
        path.join(tmpFolder, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: pre0004Entries }),
      );

      await handle.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${dbName}`);
      scratch = createDatabase(scratchUrl, 1);

      // Old state: only 0000-0003 applied.
      await migrate(scratch.db, { migrationsFolder: tmpFolder });

      // Real pre-existing data, inserted while the database is genuinely at
      // 0003 -- companies/contacts/pipelines/stages/deals/projects/users are
      // byte-identical between 0003 and 0004 (0004 touches none of them), so
      // the real schema.ts table objects describe this "old" shape exactly.
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [company] = await scratch.db.insert(companies).values({ name: "Acme" }).returning();
      const [contact] = await scratch.db.insert(contacts)
        .values({ firstName: "Bob", companyId: company!.id }).returning();
      const [pipeline] = await scratch.db.insert(pipelines)
        .values({ name: "Sales", scope: "global", position: "a0" }).returning();
      const [stage] = await scratch.db.insert(stages)
        .values({ pipelineId: pipeline!.id, name: "New", position: "a0" }).returning();
      const [deal] = await scratch.db.insert(deals).values({
        title: "Big Deal", pipelineId: pipeline!.id, stageId: stage!.id, position: "a0", currency: "EUR",
      }).returning();
      const [project] = await scratch.db.insert(projects).values({ name: "Rollout" }).returning();

      // Upgrade: apply the real, full migrations folder. 0004 is the only
      // pending migration (0000-0003 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: realFolder });

      // The pre-existing data survived the upgrade untouched.
      const [rereadCompany] = await scratch.db.select().from(companies).where(eq(companies.id, company!.id));
      expect(rereadCompany).toMatchObject({ id: company!.id, name: "Acme" });

      // And 0004's new tables/FKs work against that pre-existing (pre-
      // migration) data, not just data inserted after the upgrade.
      const [account] = await scratch.db.insert(mailAccounts).values({
        userId: user!.id, label: "Work", email: "chris@example.com",
        imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
        smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
        username: "chris", credentialsCiphertext: "v1:iv:tag:data",
      }).returning();
      const [thread] = await scratch.db.insert(mailThreads).values({
        subject: "Re: Big Deal", lastMessageAt: new Date(),
        companyId: company!.id, contactId: contact!.id, dealId: deal!.id, projectId: project!.id,
      }).returning();
      expect(account?.userId).toBe(user!.id);
      expect(thread).toMatchObject({
        companyId: company!.id, contactId: contact!.id, dealId: deal!.id, projectId: project!.id,
      });
    } finally {
      await scratch?.close();
      // WITH (FORCE) (PG 15+, confirmed on the dev server): disconnects any
      // straggling connection to the scratch database itself rather than
      // failing the drop -- belt-and-braces alongside the explicit close()
      // above, since a lingering connection would otherwise leak the
      // database this test just created.
      await handle.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
      rmSync(tmpFolder, { recursive: true, force: true });
    }
  }, 30000);

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

    // Distinct emails per row: mail_accounts_user_email_active_unique (this
    // migration's duplicate-mailbox partial unique index) would otherwise
    // reject every row after the first for this same user -- unrelated to
    // what this test is actually checking (the CHECK constraints), so it is
    // sidestepped rather than tested here.
    for (const imapSecurity of mailSecuritySchema.options) {
      await handle.db.insert(mailAccounts)
        .values(accountValues({ imapSecurity, label: imapSecurity, email: `${imapSecurity}@example.com` }));
    }
    await expect(
      handle.db.insert(mailAccounts).values(accountValues({ imapSecurity: "plaintext", email: "plaintext@example.com" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_imap_security_valid|check/i) },
    });

    for (const status of mailAccountStatusSchema.options) {
      await handle.db.insert(mailAccounts).values(accountValues({ status, label: status, email: `${status}@example.com` }));
    }
    await expect(
      handle.db.insert(mailAccounts).values(accountValues({ status: "syncing", email: "syncing@example.com" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_status_valid|check/i) },
    });

    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "final@example.com" })).returning();
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

  it("has every hand-written index: the four mail_threads FKs, mail_messages(thread_id/message_id), mail_attachments(message_id), mail_accounts' duplicate-mailbox unique index", async () => {
    const rows = await handle.db.execute<{ tablename: string; indexname: string; indexdef: string }>(
      sql`SELECT tablename, indexname, indexdef FROM pg_indexes
          WHERE tablename IN ('mail_threads','mail_messages','mail_attachments','mail_accounts')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "mail_threads_company_id_idx", "mail_threads_contact_id_idx",
      "mail_threads_deal_id_idx", "mail_threads_project_id_idx",
      "mail_threads_last_message_at_idx",
      "mail_messages_thread_id_idx", "mail_messages_message_id_idx",
      "mail_attachments_message_id_idx",
      "mail_accounts_user_email_active_unique",
    ]) {
      expect(names).toContain(expected);
    }

    // Composite and DESC on both columns -- matches GET /api/mail/threads'
    // keyset pagination direction exactly, so that query is a single index
    // scan rather than a sort.
    const lastMessageAtIndex = rows.find((r) => r.indexname === "mail_threads_last_message_at_idx");
    expect(lastMessageAtIndex?.indexdef).toMatch(/last_message_at DESC, id DESC/i);

    // Genuinely UNIQUE, genuinely partial, genuinely case-insensitive --
    // confirms the DDL, not just its presence in pg_indexes.
    const dupIndex = rows.find((r) => r.indexname === "mail_accounts_user_email_active_unique");
    expect(dupIndex?.indexdef).toMatch(/UNIQUE/i);
    expect(dupIndex?.indexdef).toMatch(/lower\(email\)/i);
    expect(dupIndex?.indexdef).toMatch(/WHERE.*archived_at IS NULL/i);
  });

  // DB-level proof the constraint actually behaves as intended -- the
  // service-level ConflictError mapping (mail-accounts.ts) is tested
  // separately in mail-accounts.test.ts; this is the raw constraint itself.
  it("mail_accounts' duplicate-mailbox unique index rejects a second active row for the same (user, email), but allows an archived duplicate or a different user", async () => {
    const [first] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    expect(first).toBeDefined();

    // Same user, same email (even different case), both active -> rejected.
    await expect(
      handle.db.insert(mailAccounts).values(accountValues({ email: "CHRIS@example.com", label: "Duplicate" })),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // Archiving the first frees the address up for a fresh active row.
    await handle.db.update(mailAccounts).set({ archivedAt: new Date() })
      .where(eq(mailAccounts.id, first!.id));
    const [second] = await handle.db.insert(mailAccounts)
      .values(accountValues({ label: "Re-added" })).returning();
    expect(second).toBeDefined();

    // A different user with the same email is unaffected -- per-user
    // accounts, shared visibility (spec), not a global uniqueness rule.
    const otherUserId = (await resolveUser(handle.db, { username: "alex", email: null, fullName: null })).id;
    const [thirdUser] = await handle.db.insert(mailAccounts)
      .values(accountValues({ userId: otherUserId, label: "Alex's copy" })).returning();
    expect(thirdUser).toBeDefined();
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
