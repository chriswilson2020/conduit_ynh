import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mailSecuritySchema, mailAccountStatusSchema, mailDirectionSchema, specialUseSchema, mailVisibilitySchema,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { createContact } from "../services/contacts.js";
import { createPipeline, createStage } from "../services/pipelines.js";
import { createDeal } from "../services/deals.js";
import { createProject } from "../services/projects.js";
import { createDatabase, migrationsFolder, type DatabaseHandle } from "./client.js";
import {
  users, companies, contacts, pipelines, stages, deals, projects,
  mailAccounts, mailAccountFolders, mailFolderState, mailThreads, mailMessages, mailAttachments,
  emailTemplates,
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

/**
 * Scaffolding shared by every "upgrade a populated pre-N database" drill --
 * extracted from the two near-identical copies that used to live inline in
 * the 0004 and 0005 tests below, so a future 0006 upgrade test inherits it
 * for free instead of copying the ceremony a third time.
 *
 * Builds a trimmed migrations folder holding only the journal entries
 * strictly before the one whose tag starts with `tag` (e.g. "0004"),
 * derived from the REAL journal rather than hardcoded -- so this keeps
 * working unmodified once a later migration ships and `tag` stops being the
 * newest entry. Creates a throwaway scratch database, migrates it to that
 * pre-N state, and hands the resulting handle to `fn`.
 *
 * `fn` owns everything that happens next: seeding old-shape data, applying
 * the real (full) migrations folder -- the actual "upgrade" moment -- and
 * asserting survival. That split is deliberate: which tables get seeded in
 * the old shape, and what the post-upgrade assertions check, is the one
 * thing that genuinely differs between drills, while the database
 * lifecycle around it (create, migrate-to-old-state, close, drop, clean up
 * the tmp folder -- always, even on failure) does not.
 */
async function withPreMigrationDatabase(
  tag: string,
  fn: (scratch: DatabaseHandle) => Promise<void>,
): Promise<void> {
  const realFolder = migrationsFolder();
  const journal = JSON.parse(
    readFileSync(path.join(realFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const boundary = journal.entries.find((e) => e.tag.startsWith(`${tag}_`));
  if (boundary === undefined) throw new Error(`could not find a ${tag} migration in the journal`);
  const preEntries = journal.entries.filter((e) => e.idx < boundary.idx);
  const tmpFolder = mkdtempSync(path.join(tmpdir(), `conduit-pre${tag}-`));
  const dbName = `conduit_test_upgrade_${randomUUID().replace(/-/g, "")}`;

  // CREATE DATABASE and every subsequent step live inside the try so the
  // finally below always runs cleanup, including on a failure between
  // creating the database and finishing the caller's migration/insert
  // sequence (rather than leaking a scratch database that partially
  // succeeded).
  let scratch: DatabaseHandle | undefined;
  try {
    mkdirSync(path.join(tmpFolder, "meta"));
    for (const entry of preEntries) {
      copyFileSync(path.join(realFolder, `${entry.tag}.sql`), path.join(tmpFolder, `${entry.tag}.sql`));
    }
    writeFileSync(
      path.join(tmpFolder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: preEntries }),
    );

    await handle.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${dbName}`);
    scratch = createDatabase(scratchUrl, 1);

    // Old state: everything strictly before `tag` applied.
    await migrate(scratch.db, { migrationsFolder: tmpFolder });

    await fn(scratch);
  } finally {
    await scratch?.close();
    // WITH (FORCE) (PG 15+, confirmed on the dev server): disconnects any
    // straggling connection to the scratch database itself rather than
    // failing the drop -- belt-and-braces alongside the explicit close()
    // above, since a lingering connection would otherwise leak the database
    // this test just created.
    await handle.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    rmSync(tmpFolder, { recursive: true, force: true });
  }
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
    await withPreMigrationDatabase("0004", async (scratch) => {
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

      // Upgrade: apply the real, full migrations folder. With 0005 now in
      // the journal too, this applies both 0004 and 0005 in one go (0000-
      // 0003 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

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
    });
  }, 30000);

  it("applies every column default when a row supplies only the required fields", async () => {
    const [account] = await handle.db.insert(mailAccounts).values(accountValues()).returning();
    expect(account).toMatchObject({
      sentFolder: "Sent", backfillDays: 90, visibility: "private", status: "active",
      signatureHtml: null, lastError: null,
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

  it("has every hand-written index: the four mail_threads FKs, mail_messages(thread_id/message_id/account+folder+uid/unseen-thread/folder+thread), mail_attachments(message_id), mail_accounts' duplicate-mailbox unique index", async () => {
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
      "mail_messages_account_folder_uid_idx",
      "mail_messages_unseen_thread_idx",
      "mail_messages_folder_thread_idx",
      "mail_attachments_message_id_idx",
      "mail_accounts_user_email_active_unique",
    ]) {
      expect(names).toContain(expected);
    }

    // Genuinely PARTIAL, not just present: an unfiltered thread_id index
    // already exists, and a non-partial duplicate of it would be dead weight
    // rather than the unread badge's index.
    const unseenIndex = rows.find((r) => r.indexname === "mail_messages_unseen_thread_idx");
    expect(unseenIndex?.indexdef).toMatch(/WHERE.*seen = false/i);
    // ...and it carries the two payload columns 0005 added (INCLUDE, not key
    // columns -- neither is ever a search term here). Without them Task 4's
    // Trash carve-out reads `folder` and `account_id` from the HEAP, which
    // costs the badge the index-only scan this index exists to give it: 298
    // buffers became 2,257 in the measurement recorded in the migration. The
    // assertion is on INCLUDE specifically, because an index that merely
    // exists would pass a name check while quietly costing that scan.
    expect(unseenIndex?.indexdef).toMatch(/INCLUDE \(folder, account_id\)/i);
    // Exactly one index of that name: 0005 replaces 0004's rather than adding
    // a second, so a stale duplicate would show up here.
    expect(names.filter((n) => n === "mail_messages_unseen_thread_idx")).toHaveLength(1);

    // Column ORDER is the point of this one, not just its existence: the
    // leading (account_id, folder) prefix is what serves the UIDVALIDITY
    // re-walk's UID clear, which carries no imap_uid term at all.
    const uidIndex = rows.find((r) => r.indexname === "mail_messages_account_folder_uid_idx");
    expect(uidIndex?.indexdef).toMatch(/\(account_id, folder, imap_uid\)/i);

    // Column order again, and the reason this index exists at all (0005): the
    // thread list's folder filter binds FOLDER ALONE, so the index above
    // cannot serve it -- its leading account_id is missing from the predicate
    // and it carries no thread_id for the EXISTS correlation. Reversing these
    // two columns would leave the same gap.
    const folderThreadIndex = rows.find((r) => r.indexname === "mail_messages_folder_thread_idx");
    expect(folderThreadIndex?.indexdef).toMatch(/\(folder, thread_id\)/i);

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

describe("mail folder schema (0005)", () => {
  /** Minimal valid mail_account_folders row, overridable per test. */
  function folderValues(accountId: string, overrides: Partial<typeof mailAccountFolders.$inferInsert> = {}) {
    return {
      accountId, folder: "INBOX", syncEnabled: true, lastDiscoveredAt: new Date(),
      ...overrides,
    } satisfies typeof mailAccountFolders.$inferInsert;
  }

  // The genuine upgrade test, same shape as the 0004 one above: a real
  // database migrated only through 0004 (0000-0004 applied, no
  // mail_account_folders table and no mail_accounts.trash_folder/
  // archive_folder columns yet), populated with real mail data while still
  // in that old state, THEN migrated forward with 0005 -- proving the
  // migration itself applies cleanly on top of a populated database, the
  // pre-existing data survives untouched, the two new mail_accounts columns
  // come back NULL (never guessed/backfilled) on a row that predates them,
  // and the new table works against that same pre-existing account. Runs
  // against its own scratch database, never the shared conduit_test one.
  it("applies migration 0005 on top of a real database already migrated only through 0004 and already carrying mail data", async () => {
    await withPreMigrationDatabase("0005", async (scratch) => {
      // Real pre-existing mail data, inserted while the database is
      // genuinely at 0004. mail_threads/mail_messages are byte-identical
      // between 0004 and 0005, so the real schema.ts table objects describe
      // their "old" shape exactly -- but mail_accounts is NOT (0005 adds
      // trash_folder/archive_folder to it), so the live mailAccounts table
      // object (which already carries those two columns) can't be used for
      // THIS insert: drizzle would list them in the generated INSERT even
      // though the pre-0005 table has no such columns yet, and Postgres
      // would reject the statement outright. Raw SQL naming only the
      // pre-0005 columns sidesteps that -- the one place in this test that
      // must describe the OLD shape by hand rather than through schema.ts.
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [account] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_accounts
          (user_id, label, email, imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security, username, credentials_ciphertext)
        VALUES
          (${user!.id}, 'Work', 'chris@example.com', 'localhost', 993, 'tls',
           'localhost', 587, 'starttls', 'chris', 'v1:iv:tag:data')
        RETURNING id
      `);
      const [thread] = await scratch.db.insert(mailThreads).values({
        subject: "Re: Sieve rules", lastMessageAt: new Date(),
      }).returning();
      const [message] = await scratch.db.insert(mailMessages).values({
        accountId: account!.id, threadId: thread!.id, messageId: "<pre0005@example.com>",
        fromAddr: "bob@example.com", toAddrs: [], sentAt: new Date(), folder: "INBOX", direction: "inbound",
      }).returning();

      // Upgrade: apply the real, full migrations folder. 0005 is the only
      // pending migration (0000-0004 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // The pre-existing mail data survived the upgrade untouched.
      const [rereadAccount] = await scratch.db.select().from(mailAccounts).where(eq(mailAccounts.id, account!.id));
      expect(rereadAccount).toMatchObject({ id: account!.id, email: "chris@example.com" });
      const [rereadMessage] = await scratch.db.select().from(mailMessages).where(eq(mailMessages.id, message!.id));
      expect(rereadMessage?.messageId).toBe("<pre0005@example.com>");

      // 0005's two new mail_accounts columns come back NULL on a row that
      // existed before the upgrade -- nothing is ever guessed/backfilled.
      expect(rereadAccount).toMatchObject({ trashFolder: null, archiveFolder: null });

      // And 0005's new table works against that pre-existing (pre-migration)
      // account, not just accounts inserted after the upgrade.
      const [folderRow] = await scratch.db.insert(mailAccountFolders)
        .values(folderValues(account!.id, { folder: "Archive", specialUse: "archive" }))
        .returning();
      expect(folderRow).toMatchObject({ accountId: account!.id, folder: "Archive", specialUse: "archive" });

      // 0005's hand-written index arrived with it, ON A DATABASE THIS TEST
      // MIGRATED FROM THE FILES. That is the assertion the shared test
      // database cannot make: its copy of the index was applied by hand (the
      // migration was edited in place before release), so it would be there
      // even if the .sql file had lost the statement.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'mail_messages'`,
      );
      expect(indexes.map((row) => row.indexname)).toContain("mail_messages_folder_thread_idx");
      // And 0005's REPLACEMENT of 0004's unseen index landed as a replacement:
      // one index of that name, carrying the INCLUDE columns. A drop-and-
      // recreate is the one shape of migration that can leave two objects (or
      // none) if the statements are ever reordered.
      const unseen = indexes.filter((row) => row.indexname === "mail_messages_unseen_thread_idx");
      expect(unseen).toHaveLength(1);
      expect(unseen[0]?.indexdef).toMatch(/INCLUDE \(folder, account_id\)/i);
    });
  }, 30000);

  it("applies column defaults (selectable true, specialUse null) and leaves a fresh account's trash/archive folders NULL", async () => {
    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "defaults@example.com" })).returning();
    expect(account).toMatchObject({ trashFolder: null, archiveFolder: null });

    const [folder] = await handle.db.insert(mailAccountFolders)
      .values(folderValues(account!.id)).returning();
    expect(folder).toMatchObject({ selectable: true, specialUse: null });
  });

  it("enforces UNIQUE (account_id, folder) on mail_account_folders", async () => {
    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "unique@example.com" })).returning();
    await handle.db.insert(mailAccountFolders).values(folderValues(account!.id));
    await expect(
      handle.db.insert(mailAccountFolders).values(folderValues(account!.id, { syncEnabled: false })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_account_folders_account_folder_unique|unique/i) },
    });
  });

  // Mirrors the 0004 block's own duplicate-mailbox-unique test above (the
  // bare `cause: { code }` style, not a message regex -- an FK violation's
  // message is verbose and less stable to match against than its code).
  it("enforces the account_id foreign key on mail_account_folders", async () => {
    await expect(
      handle.db.insert(mailAccountFolders).values(folderValues(randomUUID())),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  // The exact shape Task 2's discovery upsert is built on: INSERT ...
  // ON CONFLICT (account_id, folder) DO UPDATE, refreshing last_discovered_at
  // (and, in the real upsert, special_use) while leaving sync_enabled
  // untouched -- the no-clobber rule from this table's own syncEnabled
  // comment (schema.ts), exercised here in isolation rather than waiting for
  // Task 2's service to exist.
  it("upserts on (account_id, folder) via ON CONFLICT DO UPDATE, preserving a user's syncEnabled toggle across re-discovery", async () => {
    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "upsert@example.com" })).returning();
    const firstSeen = new Date("2026-08-01T00:00:00.000Z");
    const [inserted] = await handle.db.insert(mailAccountFolders)
      .values(folderValues(account!.id, { folder: "Projects", syncEnabled: true, lastDiscoveredAt: firstSeen }))
      .returning();
    expect(inserted).toMatchObject({ syncEnabled: true });

    // The user toggles it off in Settings, out of band from any discovery pass.
    await handle.db.update(mailAccountFolders).set({ syncEnabled: false })
      .where(eq(mailAccountFolders.id, inserted!.id));

    // A later LIST pass re-sights the same folder and upserts it. The
    // conflicting insert's own syncEnabled: true must NOT win -- the DO
    // UPDATE set below deliberately omits syncEnabled, same as Task 2's real
    // upsert will, so the row's current (user-toggled-off) value survives.
    const secondSeen = new Date("2026-08-15T00:00:00.000Z");
    const [reupserted] = await handle.db.insert(mailAccountFolders)
      .values(folderValues(account!.id, {
        folder: "Projects", syncEnabled: true, lastDiscoveredAt: secondSeen, specialUse: null,
      }))
      .onConflictDoUpdate({
        target: [mailAccountFolders.accountId, mailAccountFolders.folder],
        set: { lastDiscoveredAt: secondSeen, specialUse: null },
      })
      .returning();
    expect(reupserted).toMatchObject({ id: inserted!.id, syncEnabled: false, lastDiscoveredAt: secondSeen });
  });

  // Mirrors the 0004 describe block's "keeps ... in sync with their DB
  // CHECKs" test above, for this migration's one enum CHECK.
  it("keeps specialUseSchema in sync with mail_account_folders' special_use CHECK", async () => {
    expect(specialUseSchema.options).toEqual(["archive", "drafts", "junk", "sent", "trash"]);

    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "check@example.com" })).returning();

    for (const specialUse of specialUseSchema.options) {
      await handle.db.insert(mailAccountFolders)
        .values(folderValues(account!.id, { folder: specialUse, specialUse }));
    }
    await expect(
      handle.db.insert(mailAccountFolders)
        .values(folderValues(account!.id, { folder: "bogus", specialUse: "bogus" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_account_folders_special_use_valid|check/i) },
    });

    // NULL is not "bogus" -- an ordinary, unclassified folder must insert
    // cleanly (three-valued CHECK logic: NULL never fails an IN (...) list).
    const [ordinary] = await handle.db.insert(mailAccountFolders)
      .values(folderValues(account!.id, { folder: "Projects", specialUse: null })).returning();
    expect(ordinary?.specialUse).toBeNull();
  });
});

describe("mail visibility schema (0006)", () => {
  // THE point of 0006: the column's own DEFAULT is the "everything becomes
  // private" migration, not a separate UPDATE statement -- see
  // mail_accounts.visibility's comment in schema.ts and the spec's Data
  // model section ("No backfill statement needed"). This proves that on a
  // database that was genuinely pre-0006, migrated only through 0005 and
  // already carrying a real account row inserted BEFORE visibility existed
  // as a column at all (raw SQL naming only the pre-0006 columns, same
  // technique as the 0005 drill above for trash_folder/archive_folder).
  // Mirrors the 0004/0005 upgrade drills: scratch database, never the shared
  // conduit_test one.
  it("applies migration 0006 on top of a real database already migrated only through 0005 -- a pre-existing account comes back visibility = 'private'", async () => {
    await withPreMigrationDatabase("0006", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [account] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_accounts
          (user_id, label, email, imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security, username, credentials_ciphertext)
        VALUES
          (${user!.id}, 'Work', 'chris@example.com', 'localhost', 993, 'tls',
           'localhost', 587, 'starttls', 'chris', 'v1:iv:tag:data')
        RETURNING id
      `);

      // Pin the drill's own premise before upgrading. The raw insert above
      // would ALSO succeed on a fully-migrated table (it simply names no
      // visibility, so the DEFAULT would fire at insert time), and 'private'
      // below would then pass without the ALTER proving anything. Same hole
      // the 0005 drill closes with its "ON A DATABASE THIS TEST MIGRATED
      // FROM THE FILES" index assertions.
      const [preState] = await scratch.db.execute<{ present: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mail_accounts' AND column_name = 'visibility'
        ) AS present
      `);
      expect(preState?.present).toBe(false);

      // Upgrade: apply the real, full migrations folder. 0006 is the only
      // pending migration (0000-0005 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // The pre-existing row survived, and the new column's DEFAULT alone
      // made it private -- nothing here ever ran an UPDATE.
      const [reread] = await scratch.db.select().from(mailAccounts).where(eq(mailAccounts.id, account!.id));
      expect(reread).toMatchObject({ id: account!.id, email: "chris@example.com", visibility: "private" });
    });
  }, 30000);

  it("defaults a fresh account's visibility to private", async () => {
    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "fresh@example.com" })).returning();
    expect(account?.visibility).toBe("private");
  });

  // Mirrors the 0004 block's "keeps mailSecuritySchema/... in sync" pattern
  // for this migration's one enum CHECK.
  it("keeps mailVisibilitySchema in sync with mail_accounts' visibility CHECK", async () => {
    expect(mailVisibilitySchema.options).toEqual(["private", "shared"]);

    for (const visibility of mailVisibilitySchema.options) {
      await handle.db.insert(mailAccounts)
        .values(accountValues({ visibility, label: visibility, email: `${visibility}@example.com` }));
    }
    await expect(
      handle.db.insert(mailAccounts)
        .values(accountValues({ visibility: "public", email: "bogus-visibility@example.com" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_visibility_valid|check/i) },
    });
  });
});
