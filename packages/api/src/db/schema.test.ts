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
import { listThreads } from "../services/mail-threads.js";
import { createDatabase, migrationsFolder, type DatabaseHandle } from "./client.js";
import {
  users, companies, contacts, pipelines, stages, deals, projects, events,
  mailAccounts, mailAccountFolders, mailFolderState, mailThreads, mailMessages, mailAttachments,
  mailThreadHides, emailTemplates, meetings, meetingAttendees,
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

describe("mail thread hides schema (0007)", () => {
  // THE point of 0007's backfill: the migration itself writes one hide row
  // per (archived thread x existing user), carrying archived_at as
  // hidden_at, so the upgrade changes nobody's view (Phase 4.3 spec,
  // Migration row). Proven on a database genuinely at 0006 with the threads
  // seeded BEFORE the hides table exists, mirroring the 0004/0005/0006
  // drills: scratch database, never the shared conduit_test one.
  //
  // The thread inserts are raw SQL naming archived_at explicitly (the
  // 0005/0006 old-shape technique): 0007's second half DROPPED that column
  // from schema.ts, so a drizzle insert can no longer name it -- raw SQL is
  // what lets this drill still seed the genuine pre-0007 shape.
  it("applies migration 0007 on top of a real database migrated only through 0006 -- the backfill hides a pre-existing archived thread for every pre-existing user, archived_at is gone, and the hide rows drive the default list", async () => {
    await withPreMigrationDatabase("0007", async (scratch) => {
      const [chris] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [alex] = await scratch.db.insert(users).values({ username: "alex" }).returning();
      // Bound as an ISO STRING, not a Date: db.execute's raw path hands
      // parameters straight to postgres.js, which serializes strings but not
      // Date instances (the drizzle query builder's Date mapping does not
      // apply here).
      const archivedAtIso = "2026-08-10T09:30:00.000Z";
      const [archived] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_threads (subject, last_message_at, message_count, archived_at)
        VALUES ('Filed away', now(), 1, ${archivedAtIso})
        RETURNING id
      `);
      const [live] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_threads (subject, last_message_at, message_count)
        VALUES ('Still here', now(), 1)
        RETURNING id
      `);

      // A SHARED mailbox with one message per thread, so both users can SEE
      // both threads post-upgrade (the 4.2 visibility predicate hides a
      // message-less thread from every inbox) -- what turns the final
      // assertions into a real proof that it is the HIDE rows, not
      // visibility, deciding each list. mail_accounts/mail_messages are
      // byte-identical between 0006 and 0007, so drizzle inserts describe
      // this old shape exactly.
      const [account] = await scratch.db.insert(mailAccounts).values({
        userId: chris!.id, label: "Team", email: "team@example.com",
        imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
        smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
        username: "chris", credentialsCiphertext: "v1:iv:tag:data",
        visibility: "shared",
      }).returning();
      for (const thread of [archived!, live!]) {
        await scratch.db.insert(mailMessages).values({
          accountId: account!.id, threadId: thread.id,
          messageId: `<${thread.id}@example.com>`,
          fromAddr: "alice@example.com", toAddrs: [{ address: "chris@example.com" }],
          sentAt: new Date("2026-08-09T10:00:00.000Z"), folder: "INBOX", direction: "inbound",
        });
      }

      // Pin the drill's own premise before upgrading (the 0006 drill's
      // pattern): no mail_thread_hides table exists yet, so the rows
      // asserted after migrate() can only have come from the migration's own
      // backfill, not from anything this test wrote.
      const [preState] = await scratch.db.execute<{ present: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'mail_thread_hides'
        ) AS present
      `);
      expect(preState?.present).toBe(false);

      // Upgrade: apply the real, full migrations folder. 0007 is the only
      // pending migration (0000-0006 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // The archived thread came back hidden for BOTH pre-existing users,
      // each row carrying the thread's own archived_at as hidden_at -- the
      // original filing moment, not the upgrade moment.
      const hides = await scratch.db.select().from(mailThreadHides);
      expect(
        hides.map((row) => ({ threadId: row.threadId, userId: row.userId })).sort(
          (a, b) => a.userId.localeCompare(b.userId),
        ),
      ).toEqual(
        [
          { threadId: archived!.id, userId: chris!.id },
          { threadId: archived!.id, userId: alex!.id },
        ].sort((a, b) => a.userId.localeCompare(b.userId)),
      );
      for (const row of hides) expect(row.hiddenAt.toISOString()).toBe(archivedAtIso);

      // The live thread is hidden for nobody -- its id appears in no hide
      // row at all (already implied by the exact-set assertion above, stated
      // here as the decision it is).
      expect(hides.some((row) => row.threadId === live!.id)).toBe(false);

      // The sequencing note's second half, landed: the thread-global column
      // is GONE. Everything asserted below can only be coming from the
      // backfilled hide rows.
      const [postColumn] = await scratch.db.execute<{ present: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mail_threads' AND column_name = 'archived_at'
        ) AS present
      `);
      expect(postColumn?.present).toBe(false);

      // The upgrade promise, read the way a user reads it -- through the
      // REAL list service on the upgraded database: each user's default
      // inbox shows exactly the never-archived thread (the backfilled hide
      // rows drive the exclusion now that no column can), and each user's
      // Hidden view carries the pre-upgrade archive moment as their own
      // hiddenAt. Nobody's view changed; everyone can now unhide alone.
      //
      // ACCEPTED COUPLING: calling listThreads makes this drill break on a
      // listThreads signature or visibility-rule change, not only on
      // migration bugs. Deliberate -- the promise under test is "the
      // upgraded database reads correctly through the app's own eyes", and
      // that realism is worth the occasional unrelated-looking failure
      // (fix: update this call site alongside the service change).
      for (const user of [chris!, alex!]) {
        const inbox = await listThreads(scratch.db, user.id);
        expect(inbox.items.map((t) => t.id)).toEqual([live!.id]);
        expect(inbox.items[0]?.hiddenAt).toBeNull();
        const hiddenView = await listThreads(scratch.db, user.id, { hidden: true });
        expect(hiddenView.items.map((t) => t.id)).toEqual([archived!.id]);
        expect(hiddenView.items[0]?.hiddenAt).toBe(archivedAtIso);
      }
    });
  }, 30000);

  /** One thread on the shared test database, for the constraint tests below. */
  async function seedThread(): Promise<string> {
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Hello", lastMessageAt: new Date(),
    }).returning();
    return thread!.id;
  }

  it("enforces PRIMARY KEY (thread_id, user_id): re-hiding collides, while a second user or a second thread does not", async () => {
    const threadId = await seedThread();
    const otherThreadId = await seedThread();
    const otherUserId = (await resolveUser(handle.db, { username: "alex", email: null, fullName: null })).id;

    await handle.db.insert(mailThreadHides).values({ threadId, userId });
    // Same (thread, user) pair again: the composite PK is what makes a
    // repeated hide a conflict target rather than a silent duplicate.
    await expect(
      handle.db.insert(mailThreadHides).values({ threadId, userId }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // The pair is the identity, not either column alone: the same thread
    // hidden by ANOTHER user, and the same user hiding another thread, are
    // both new facts.
    const [otherUsers] = await handle.db.insert(mailThreadHides)
      .values({ threadId, userId: otherUserId }).returning();
    expect(otherUsers).toMatchObject({ threadId, userId: otherUserId });
    const [otherThread] = await handle.db.insert(mailThreadHides)
      .values({ threadId: otherThreadId, userId }).returning();
    expect(otherThread).toMatchObject({ threadId: otherThreadId, userId });
  });

  it("enforces both foreign keys", async () => {
    const threadId = await seedThread();
    await expect(
      handle.db.insert(mailThreadHides).values({ threadId: randomUUID(), userId }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      handle.db.insert(mailThreadHides).values({ threadId, userId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("defaults hidden_at to now() when a hide names only the pair", async () => {
    const threadId = await seedThread();
    const before = Date.now();
    const [row] = await handle.db.insert(mailThreadHides).values({ threadId, userId }).returning();
    const after = Date.now();
    expect(row?.hiddenAt).toBeInstanceOf(Date);
    // A DB-clock default, so bounded rather than exact -- and the bounds are
    // generous because the DB and test clocks are separate.
    expect(row!.hiddenAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(row!.hiddenAt.getTime()).toBeLessThanOrEqual(after + 5000);
  });
});

describe("meetings schema (0008)", () => {
  const occurredAt = new Date("2026-08-20T09:00:00.000Z");

  /** One company-linked meeting on the shared test database. */
  async function seedMeeting(overrides: Partial<typeof meetings.$inferInsert> = {}): Promise<string> {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [meeting] = await handle.db.insert(meetings).values({
      title: "Kickoff", occurredAt, ownerUserId: userId, companyId: company.id, ...overrides,
    }).returning();
    return meeting!.id;
  }

  // The 0004-0007 drill, one migration on: a real database migrated only
  // through 0007 (neither meetings table, neither new events column, the
  // pre-0008 verb CHECK), populated while genuinely in that state, THEN
  // migrated forward. Runs against its own scratch database, never the
  // shared conduit_test one.
  //
  // The event is seeded through RAW SQL naming only pre-0008 columns, the
  // 0005/0006/0007 technique: 0008 adds meeting_id/mail_thread_id to events,
  // so drizzle -- which lists every column of the live table object in its
  // generated INSERT -- would name two columns the pre-0008 table does not
  // have and Postgres would reject the statement outright. companies/users
  // are byte-identical between 0007 and 0008, so they insert through
  // schema.ts as usual.
  it("applies migration 0008 on top of a real database migrated only through 0007 -- both new tables arrive, a pre-existing event survives with NULL meeting_id/mail_thread_id, and the widened verb CHECK accepts 'met'", async () => {
    await withPreMigrationDatabase("0008", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [company] = await scratch.db.insert(companies).values({ name: "Acme" }).returning();
      const [event] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO events (verb, actor_user_id, company_id, payload)
        VALUES ('created', ${user!.id}, ${company!.id}, '{}'::jsonb)
        RETURNING id
      `);

      // Pin the drill's own premise before upgrading (the 0006/0007
      // pattern), on all three of this migration's fronts. Without these,
      // every post-migrate assertion below would also pass against a
      // database that had been fully migrated all along: the raw INSERT
      // names no meeting_id, so NULL would prove nothing; and 'met' would
      // insert cleanly under a CHECK that already listed it.
      const [preTables] = await scratch.db.execute<{ meetings: boolean; attendees: boolean }>(sql`
        SELECT
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'meetings') AS meetings,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_attendees') AS attendees
      `);
      expect(preTables).toMatchObject({ meetings: false, attendees: false });

      const [preColumns] = await scratch.db.execute<{ present: number }>(sql`
        SELECT count(*)::int AS present FROM information_schema.columns
        WHERE table_name = 'events' AND column_name IN ('meeting_id', 'mail_thread_id')
      `);
      expect(preColumns?.present).toBe(0);

      await expect(scratch.db.execute(sql`
        INSERT INTO events (verb, actor_user_id, company_id, payload)
        VALUES ('met', ${user!.id}, ${company!.id}, '{}'::jsonb)
      `)).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/events_verb_valid|check/i) },
      });

      // Upgrade: apply the real, full migrations folder. 0008 is the only
      // pending migration (0000-0007 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const [postTables] = await scratch.db.execute<{ meetings: boolean; attendees: boolean }>(sql`
        SELECT
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'meetings') AS meetings,
          EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_attendees') AS attendees
      `);
      expect(postTables).toMatchObject({ meetings: true, attendees: true });

      // The pre-existing event survived the upgrade untouched, and its two
      // new columns came back NULL -- 0008 backfills nothing (see the
      // migration's own closing comment: historical mail deliberately does
      // not become timeline entries).
      const [rereadEvent] = await scratch.db.select().from(events).where(eq(events.id, event!.id));
      expect(rereadEvent).toMatchObject({
        id: event!.id, verb: "created", companyId: company!.id, meetingId: null, mailThreadId: null,
      });

      // The new tables work against that pre-existing (pre-migration)
      // company and user, not just rows created after the upgrade.
      const [meeting] = await scratch.db.insert(meetings).values({
        title: "Kickoff", occurredAt, ownerUserId: user!.id, companyId: company!.id,
      }).returning();
      const [attendee] = await scratch.db.insert(meetingAttendees).values({
        meetingId: meeting!.id, guestName: "Their lawyer",
      }).returning();
      expect(meeting).toMatchObject({ companyId: company!.id, ownerUserId: user!.id, archivedAt: null });
      expect(attendee).toMatchObject({ contactId: null, userId: null, guestName: "Their lawyer" });

      // The widened CHECK: 'met' now inserts (carrying the meeting pointer),
      // while a verb outside the enum is still rejected -- the widening did
      // not turn the constraint into a rubber stamp.
      const [metEvent] = await scratch.db.insert(events).values({
        verb: "met", actorUserId: user!.id, companyId: company!.id, meetingId: meeting!.id, payload: {},
      }).returning();
      expect(metEvent).toMatchObject({ verb: "met", meetingId: meeting!.id, mailThreadId: null });
      await expect(scratch.db.insert(events).values({
        verb: "convened", actorUserId: user!.id, companyId: company!.id, payload: {},
      })).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/events_verb_valid|check/i) },
      });

      // 0008's two hand-written partial unique indexes arrived with it, ON A
      // DATABASE THIS TEST MIGRATED FROM THE FILES -- the 0005 drill's
      // assertion, for the same reason: they exist in no snapshot, so only a
      // from-the-files migration proves the .sql file still carries them.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'meeting_attendees'`,
      );
      for (const [name, column] of [
        ["meeting_attendees_meeting_contact_unique", "contact_id"],
        ["meeting_attendees_meeting_user_unique", "user_id"],
      ]) {
        const index = indexes.find((row) => row.indexname === name);
        expect(index?.indexdef).toMatch(/UNIQUE/i);
        expect(index?.indexdef).toMatch(new RegExp(`WHERE.*${column} IS NOT NULL`, "i"));
      }
    });
  }, 30000);

  // The reachability CHECK (spec's Decisions table), and the deliberate
  // difference from notes/files: meetings follow the EVENTS multi-FK model,
  // so SEVERAL links at once are valid -- only the empty set is not.
  it("enforces meetings_has_link: no link at all is rejected, one link is enough, and several at once are valid", async () => {
    await expect(handle.db.insert(meetings).values({
      title: "Unreachable", occurredAt, ownerUserId: userId,
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/meetings_has_link|check/i) },
    });

    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [oneLink] = await handle.db.insert(meetings).values({
      title: "Intro call", occurredAt, ownerUserId: userId, companyId: company.id,
    }).returning();
    expect(oneLink).toMatchObject({ companyId: company.id, contactId: null });

    // A deal meeting carrying its company too -- the case notes'
    // exactly-one CHECK would reject and this one must not.
    const contact = await createContact(handle.db, userId, { firstName: "Bob", companyId: company.id });
    const pipeline = await createPipeline(handle.db, userId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, userId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, userId, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const project = await createProject(handle.db, userId, { name: "Rollout" });
    const [everyLink] = await handle.db.insert(meetings).values({
      title: "Quarterly review", occurredAt, ownerUserId: userId,
      companyId: company.id, contactId: contact.id, dealId: deal.id, projectId: project.id,
    }).returning();
    expect(everyLink).toMatchObject({
      companyId: company.id, contactId: contact.id, dealId: deal.id, projectId: project.id,
    });
  });

  // notes_exactly_one_entity's pattern over the attendee's three identity
  // columns, and the twin of meetingAttendeeSchema's superRefine in
  // @conduit/shared.
  it("enforces meeting_attendees_exactly_one: each of the three attendee kinds inserts, zero and two are rejected", async () => {
    const meetingId = await seedMeeting();
    const contact = await createContact(handle.db, userId, { firstName: "Bob" });

    const [asContact] = await handle.db.insert(meetingAttendees)
      .values({ meetingId, contactId: contact.id }).returning();
    const [asUser] = await handle.db.insert(meetingAttendees)
      .values({ meetingId, userId }).returning();
    const [asGuest] = await handle.db.insert(meetingAttendees)
      .values({ meetingId, guestName: "Their lawyer" }).returning();
    expect(asContact).toMatchObject({ contactId: contact.id, userId: null, guestName: null });
    expect(asUser).toMatchObject({ contactId: null, userId, guestName: null });
    expect(asGuest).toMatchObject({ contactId: null, userId: null, guestName: "Their lawyer" });

    await expect(handle.db.insert(meetingAttendees).values({ meetingId })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/meeting_attendees_exactly_one|check/i) },
    });
    await expect(handle.db.insert(meetingAttendees).values({
      meetingId, contactId: contact.id, guestName: "Bob again",
    })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/meeting_attendees_exactly_one|check/i) },
    });
  });

  // The two hand-written partial unique indexes, and the third one that
  // deliberately does not exist: a repeated guest NAME is a valid attendee
  // list, since guest_name is free text and two people can share a name.
  it("dedupes a contact and a user per meeting, never a guest name, and never across meetings", async () => {
    const meetingId = await seedMeeting();
    const otherMeetingId = await seedMeeting({ title: "Follow-up" });
    const contact = await createContact(handle.db, userId, { firstName: "Bob" });

    await handle.db.insert(meetingAttendees).values({ meetingId, contactId: contact.id });
    await expect(
      handle.db.insert(meetingAttendees).values({ meetingId, contactId: contact.id }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    await handle.db.insert(meetingAttendees).values({ meetingId, userId });
    await expect(
      handle.db.insert(meetingAttendees).values({ meetingId, userId }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // Two guests of the same name on ONE meeting: accepted, deliberately.
    await handle.db.insert(meetingAttendees).values({ meetingId, guestName: "Chris" });
    const [secondChris] = await handle.db.insert(meetingAttendees)
      .values({ meetingId, guestName: "Chris" }).returning();
    expect(secondChris).toMatchObject({ guestName: "Chris" });

    // The indexes are per MEETING, not global: the same contact and the same
    // user attend the next meeting too.
    const [again] = await handle.db.insert(meetingAttendees)
      .values({ meetingId: otherMeetingId, contactId: contact.id }).returning();
    expect(again).toMatchObject({ meetingId: otherMeetingId, contactId: contact.id });
    await handle.db.insert(meetingAttendees).values({ meetingId: otherMeetingId, userId });
  });

  // Every FK on both new tables, the bare `cause: { code }` style the 0005
  // block uses (an FK violation's message is verbose and less stable to
  // match against than its code).
  it("enforces every foreign key on meetings and meeting_attendees", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    await expect(handle.db.insert(meetings).values({
      title: "Ghost owner", occurredAt, ownerUserId: randomUUID(), companyId: company.id,
    })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(handle.db.insert(meetings).values({
      title: "Ghost company", occurredAt, ownerUserId: userId, companyId: randomUUID(),
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    const meetingId = await seedMeeting();
    await expect(handle.db.insert(meetingAttendees).values({
      meetingId: randomUUID(), guestName: "Nobody's guest",
    })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(handle.db.insert(meetingAttendees).values({
      meetingId, contactId: randomUUID(),
    })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(handle.db.insert(meetingAttendees).values({
      meetingId, userId: randomUUID(),
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  // events' two new pointer columns: NULL on an ordinary event (no default,
  // nothing backfilled), real FKs when set. mail_thread_id is a pointer and
  // never content -- what a mail event may carry in `payload` is Task 4's
  // rule, enforced there; what the COLUMN can hold is this.
  it("adds events.meeting_id/mail_thread_id as nullable, FK-checked pointers", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [plain] = await handle.db.insert(events)
      .values({ verb: "created", actorUserId: userId, companyId: company.id, payload: {} }).returning();
    expect(plain).toMatchObject({ meetingId: null, mailThreadId: null });

    const meetingId = await seedMeeting();
    const [thread] = await handle.db.insert(mailThreads)
      .values({ subject: "Re: Kickoff", lastMessageAt: new Date() }).returning();
    const [pointed] = await handle.db.insert(events).values({
      verb: "mail_received", actorUserId: userId, companyId: company.id,
      mailThreadId: thread!.id, payload: {},
    }).returning();
    expect(pointed).toMatchObject({ verb: "mail_received", mailThreadId: thread!.id, meetingId: null });

    await expect(handle.db.insert(events).values({
      verb: "met", actorUserId: userId, companyId: company.id, meetingId: randomUUID(), payload: {},
    })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(handle.db.insert(events).values({
      verb: "mail_sent", actorUserId: userId, companyId: company.id,
      mailThreadId: randomUUID(), payload: {},
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    // Both pointers on one row are legal at the schema level; nothing in
    // Phase 5 writes such a row (a meeting entry and a mail entry are
    // different events), so this pins the column shape, not a use case.
    const [both] = await handle.db.insert(events).values({
      verb: "met", actorUserId: userId, companyId: company.id,
      meetingId, mailThreadId: thread!.id, payload: {},
    }).returning();
    expect(both).toMatchObject({ meetingId, mailThreadId: thread!.id });
  });
});
