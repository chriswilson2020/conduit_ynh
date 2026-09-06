import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mailSecuritySchema, mailAccountStatusSchema, mailDirectionSchema, specialUseSchema, mailVisibilitySchema,
  mailAuthMethodSchema, mailOAuthProviderOf, documentTypeSchema, documentTypeFreezes,
  documentTypeNumbered,
  CONTACT_FIELD_CAPS, DEFAULT_TIME_ZONE, MAX_LOGO_DATA_URI_CHARS, MAX_TEMPLATE_BYTES,
  MAX_TIME_ENTRY_MINUTES,
  type DocumentType,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import {
  SCRATCH_DATABASE_PREFIXES, TEST_DATABASE_URL, withDatabaseName,
} from "../test/databases.js";
import {
  seededAgreementTemplate, seededLetterTemplate, seededMeetingSummaryTemplate, seededQuoteTemplate,
  seededStatusReportTemplate,
} from "../test/seed-template.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { createContact } from "../services/contacts.js";
import { createPipeline, createStage } from "../services/pipelines.js";
import { createDeal } from "../services/deals.js";
import { createProject } from "../services/projects.js";
import { listThreads } from "../services/mail-threads.js";
import { decryptCredentials } from "../services/mail-crypto.js";
import { LEGACY_MAIL_KEY_BASE64, LEGACY_PASSWORD_BLOBS } from "../test/legacy-mail-credentials.js";
import {
  LEGACY_DOCUMENT_COLUMNS, LEGACY_QUOTE_DEAL_ID, LEGACY_QUOTE_LIST, LEGACY_QUOTE_PDFS,
  replayLegacyQuoteRows,
} from "../test/legacy-quote-rows.js";
import { listDocuments } from "../services/documents.js";
import { createDatabase, migrationsFolder, type DatabaseHandle } from "./client.js";
import {
  users, companies, contacts, pipelines, stages, deals, projects, events, files,
  mailAccounts, mailAccountFolders, mailFolderState, mailThreads, mailMessages, mailAttachments,
  mailThreadHides, meetings, meetingAttendees,
  orgProfile, documents, documentAgreements, documentLetters, documentQuotes, documentLineItems,
  documentNumberSequences, documentTemplates, tasks, timeEntries,
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
  const dbName = `${SCRATCH_DATABASE_PREFIXES.schemaUpgrade}${randomUUID().replace(/-/g, "")}`;

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
    const scratchUrl = withDatabaseName(TEST_DATABASE_URL, dbName);
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
      // RAW SQL, AND EVERY DRILL THAT SEEDS A TABLE A LATER MIGRATION TOUCHES NEEDS
      // IT. drizzle names every column of the CURRENT schema in an INSERT (the
      // unspecified ones as DEFAULT) and again in RETURNING, so an ORM insert can
      // only ever describe today's shape: this line worked until 0011 added
      // contacts.salutation, then failed here with `column "salutation" of relation
      // "contacts" does not exist` -- in the 0004 test, a long way from the change
      // that caused it. Naming the columns by hand is what makes "old shape" mean it.
      //
      // THE REST OF THIS FILE HAS NOT BEEN CONVERTED, and that is a decision rather
      // than an oversight: nothing is broken today, and the conversion is a large
      // mechanical diff through eight drills. What the next person adding a column
      // needs to know is WHICH pre-migrate seeds would break, so here they are --
      // every ORM write below that happens BEFORE its drill's `migrate(...)` call:
      //
      //   0004  users, companies, pipelines, stages, deals, projects
      //   0005  users, mail_threads, mail_messages
      //   0006  users
      //   0007  users, mail_accounts, mail_messages
      //   0008  users, companies
      //   0009  users, and companies/pipelines/stages/deals through their services
      //   0010  org_profile
      //   0011  users, files, and pipelines/stages/deals through their services
      //
      // A v1.2.0 column on any of those tables fails in the drill that seeds it, not
      // in the migration that added it. The fix is always this one: name the columns.
      const [contact] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO contacts (first_name, company_id) VALUES ('Bob', ${company!.id})
        RETURNING id
      `);
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
    // 'auth_required' is Phase 8 Task 2's third state: the failure a retry can
    // never clear. Listed here so widening the zod enum without widening 0015's
    // CHECK (or the reverse) is a red test rather than a runtime 23514 the
    // first time an OAuth grant lapses on a real install.
    expect(mailAccountStatusSchema.options).toEqual(["active", "error", "auth_required"]);
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
      // visibility, deciding each list.
      //
      // RAW SQL, naming only the columns mail_accounts had at 0006. This used
      // to be a drizzle insert, on the stated grounds that the table was
      // "byte-identical between 0006 and 0007" -- true when it was written and
      // false the moment 0014 added auth_method, because a drizzle insert names
      // every column schema.ts knows about and this database is nine migrations
      // short of that one. It failed exactly that way, which is the reason this
      // is now the same old-shape technique the 0005/0006/0014 drills use: a
      // drill seeding the OLD shape cannot describe it with the NEW schema
      // object, however alike the two look on the day it is written.
      const [account] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_accounts
          (user_id, label, email, imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security, username, credentials_ciphertext, visibility)
        VALUES
          (${chris!.id}, 'Team', 'team@example.com', 'localhost', 993, 'tls',
           'localhost', 587, 'starttls', 'chris', 'v1:iv:tag:data', 'shared')
        RETURNING id
      `);
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

      // 0008's four hand-written indexes arrived with it, ON A DATABASE THIS
      // TEST MIGRATED FROM THE FILES -- the 0005 drill's assertion, for the
      // same reason: they exist in no snapshot, so only a from-the-files
      // migration proves the .sql file still carries them.
      //
      // The COLUMN LIST is asserted, not just UNIQUE plus the predicate: a
      // quality-review mutation reduced the contact index to ("contact_id")
      // alone -- which silently turns "a contact can be on this meeting once"
      // into "a contact can be on ONE MEETING EVER" -- and the weaker
      // assertion passed. Order is pinned too, since leading with the
      // identity column is what makes each index probe-usable by it (see the
      // migration's own COLUMN ORDER note).
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'meeting_attendees'`,
      );
      for (const [name, column] of [
        ["meeting_attendees_meeting_contact_unique", "contact_id"],
        ["meeting_attendees_meeting_user_unique", "user_id"],
      ]) {
        const index = indexes.find((row) => row.indexname === name);
        expect(index?.indexdef).toMatch(/UNIQUE/i);
        expect(index?.indexdef).toMatch(new RegExp(`\\(${column}, ?meeting_id\\)`, "i"));
        expect(index?.indexdef).toMatch(new RegExp(`WHERE.*${column} IS NOT NULL`, "i"));
      }

      // The hydration index (quality-review ruling): plain, whole-table, on
      // meeting_id alone -- the only index a GUEST row appears in, since both
      // partial uniques exclude guests by construction. Asserted NOT UNIQUE
      // and NOT partial: either would break attendee hydration for exactly
      // the rows it exists to serve.
      const hydration = indexes.find((row) => row.indexname === "meeting_attendees_meeting_id_idx");
      expect(hydration?.indexdef).toMatch(/\(meeting_id\)/i);
      expect(hydration?.indexdef).not.toMatch(/UNIQUE/i);
      expect(hydration?.indexdef).not.toMatch(/WHERE/i);

      // The fourth hand-written index (quality-review ruling), on the OTHER
      // table this migration touches: the follow-up-task link both
      // listMeetings' per-page count and the detail payload's task list read
      // out of `events`, which carries no other index at all. PARTIAL is the
      // half worth asserting -- every non-meeting row has meeting_id NULL, so
      // a non-partial version would index the whole of the fastest-growing
      // table to serve rows that are a sixth of it (measured 50,005 of
      // 300,005 in the migration's own note).
      const eventsIndexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'events'`,
      );
      const meetingIdIndex = eventsIndexes.find((row) => row.indexname === "events_meeting_id_idx");
      expect(meetingIdIndex?.indexdef).toMatch(/\(meeting_id\)/i);
      expect(meetingIdIndex?.indexdef).toMatch(/WHERE.*meeting_id IS NOT NULL/i);
      expect(meetingIdIndex?.indexdef).not.toMatch(/UNIQUE/i);

      // The fifth, and the twin of the one above on the other pointer column:
      // the mail-timeline throttle's existence check (services/
      // mail-ingest.ts) runs once per ingested message inside the global
      // ingest lock, and `events` carries nothing else it could use. The
      // COLUMN LIST is asserted alongside the predicate for the reason the
      // quality round found on the attendee indexes: UNIQUE-and-predicate
      // alone passed against an index over the wrong columns entirely.
      const mailThreadIdIndex = eventsIndexes.find((row) => row.indexname === "events_mail_thread_id_idx");
      expect(mailThreadIdIndex?.indexdef).toMatch(/\(mail_thread_id\)/i);
      expect(mailThreadIdIndex?.indexdef).toMatch(/WHERE.*mail_thread_id IS NOT NULL/i);
      expect(mailThreadIdIndex?.indexdef).not.toMatch(/UNIQUE/i);
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

/**
 * A deal and a files row -- the two NOT NULL foreign keys a document needs.
 *
 * AT MODULE SCOPE SINCE PHASE 9, not inside the 0009 block where these four were
 * written. The 0017 block needs a real quote to check the composite key and the
 * numbering CHECK against, and a second copy of the fixture is a second thing to
 * keep in step with a schema both blocks are asserting about.
 */
/**
 * One of each of the five records a document can be attached to, plus the file
 * every document needs.
 *
 * **ALL FIVE SINCE 0020, WHERE IT USED TO BE THE DEAL ALONE**, and the widening
 * is `documents_entity_matches_type` making itself felt: before that constraint
 * every type could be hung off the deal this returns, so a test that looped over
 * `documentTypeSchema` never had to know which record each type belongs on. Now
 * it does, and `ownerForType` below is where that knowledge lives -- once,
 * derived from the type, so a sixth type is one entry rather than an edit to
 * every looping test.
 */
interface DocumentParents {
  dealId: string; fileId: string;
  companyId: string; contactId: string; projectId: string; meetingId: string;
}

async function seedDocumentParents(): Promise<DocumentParents> {
  const pipeline = await createPipeline(handle.db, userId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, userId, pipeline.id, { name: "New" });
  const deal = await createDeal(
    handle.db, userId, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
  );
  const [file] = await handle.db.insert(files).values({
    originalName: "QUO-2026-0001.pdf", mime: "application/pdf", sizeBytes: 16_003,
    sha256: "a".repeat(64), uploaderUserId: userId, dealId: deal.id,
  }).returning();
  const company = await createCompany(handle.db, userId, { name: "Owner Ltd" });
  const contact = await createContact(handle.db, userId, { firstName: "Owner" });
  const project = await createProject(handle.db, userId, { name: "Owner Project" });
  const [meeting] = await handle.db.insert(meetings).values({
    title: "Kickoff", occurredAt: new Date(), ownerUserId: userId, companyId: company.id,
  }).returning();
  return {
    dealId: deal.id, fileId: file!.id,
    companyId: company.id, contactId: contact.id,
    projectId: project.id, meetingId: meeting!.id,
  };
}

/**
 * The record a document of this type must be attached to -- as an INSERT's
 * columns, with the four it must NOT set spelled `null`.
 *
 * **SPELLED HERE RATHER THAN ASKED OF THE CODE UNDER TEST**, which is
 * `documentValues`' rule: a fixture that derived the answer from the constraint
 * (or from the service) could never disagree with it. `letter`, `nda` and
 * `mutual_nda` may take either a company or a contact and this picks the
 * company; the contact half is exercised by the letter suite further down.
 *
 * A `Record` OVER THE UNION rather than a switch with a default, so a seventh
 * type is a compile error in this file rather than a test that quietly hangs it
 * off a deal and then fails on a constraint nobody expected.
 */
type DocumentOwner = Pick<typeof documents.$inferInsert,
  "companyId" | "contactId" | "dealId" | "projectId" | "meetingId">;

function ownerForType(type: DocumentType, parents: DocumentParents): DocumentOwner {
  const none: DocumentOwner = {
    companyId: null, contactId: null, dealId: null, projectId: null, meetingId: null,
  };
  const owners: Record<DocumentType, DocumentOwner> = {
    quote: { dealId: parents.dealId },
    meeting_summary: { meetingId: parents.meetingId },
    letter: { companyId: parents.companyId },
    nda: { companyId: parents.companyId },
    mutual_nda: { companyId: parents.companyId },
    project_status_report: { projectId: parents.projectId },
  };
  return { ...none, ...owners[type] };
}

function documentValues(
  parents: { dealId: string; fileId: string },
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  return {
    number: "QUO-2026-0001", type: "quote", dealId: parents.dealId, fileId: parents.fileId,
    issueDate: "2026-08-28",
    // Spelled `true`, NOT documentTypeFreezes("quote"). This is a fixture, and
    // one that asked the code under test what to expect could never disagree
    // with it -- which is the whole job of the sync test further down.
    frozen: true,
    issuedByUserId: userId, ...overrides,
  } satisfies typeof documents.$inferInsert;
}

/** The quote half of the same document, which 0016 moved into its own table. */
function quoteValues(
  documentId: string,
  overrides: Partial<typeof documentQuotes.$inferInsert> = {},
) {
  return {
    documentId, currency: "EUR", recipientName: "Acme",
    subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100,
    ...overrides,
  } satisfies typeof documentQuotes.$inferInsert;
}

/** Both rows, in the order issueQuote writes them -- the pair IS the quote. */
async function insertQuote(
  parents: { dealId: string; fileId: string },
  document: Partial<typeof documents.$inferInsert> = {},
  quote: Partial<typeof documentQuotes.$inferInsert> = {},
): Promise<typeof documents.$inferSelect> {
  const [row] = await handle.db.insert(documents)
    .values(documentValues(parents, document)).returning();
  await handle.db.insert(documentQuotes).values(quoteValues(row!.id, quote));
  return row!;
}

describe("documents schema (0009)", () => {
  // EVERY merge field the seeded default template is allowed to contain, and
  // the list Task 3's resolver and Task 4's context are written against. The
  // assertion below is an EQUALITY, not a subset, in both directions: a
  // template referencing a field nobody supplies renders a silent blank on a
  // printed quote (unknown fields resolve to "" and never throw), and a field
  // listed here that the template stopped using is a context key built for
  // nothing. Either way the migration and this list have to move together.
  //
  // THE OPTIONAL ONES ARE LISTED SEPARATELY BECAUSE THE TEMPLATE OWES THEM A
  // CONDITIONAL. Each of these is empty on a real install -- nobody fills in a
  // registration number to raise one quote -- and each of them sits behind
  // markup that would otherwise print: a label over a blank, or an <img src="">.
  // Task 3's ruling generalised the block form for exactly this, so the seed
  // wraps every one of them and this list is what says so. A field that moves
  // between the two groups changes the rendered page for every install that
  // left it empty.
  const SEEDED_OPTIONAL = [
    "org.logoDataUri", "org.addressLines", "org.email", "org.phone", "org.website",
    "org.bankDetails", "org.vatNumber", "org.registrationNumber",
    "document.validUntilDate", "document.recipientContactName",
    // v1.1.0, and it arrives by an UPDATE in 0011 rather than in 0009's INSERT: the
    // seed had shipped, so the template is amended in place. It is optional like
    // every other one -- a contact with no salutation prints their name alone -- and
    // it is nested INSIDE document.recipientContactName's block, which is legal (a
    // closer matches its own opener by depth) and is why the token counts below still
    // come out at three apiece.
    "document.recipientSalutation",
    "document.recipientAddress",
    "document.notes", "document.terms",
  ];
  const SEEDED_FIELDS = [
    // The repeated block, and its inverse for a quote with no priced lines.
    "{{#lines}}", "{{^lines}}", "{{/lines}}",
    "{{description}}", "{{qty}}", "{{unitPrice}}", "{{taxRate}}", "{{lineTotal}}",
    // Always printed: the issuer's name, the number, the date and the totals.
    "{{org.name}}",
    "{{document.number}}", "{{document.issueDate}}", "{{document.recipientName}}",
    "{{document.subtotal}}", "{{document.tax}}", "{{document.total}}",
    // Each optional field appears three times: the block, the value, the closer.
    ...SEEDED_OPTIONAL.flatMap((path) => [`{{#${path}}}`, `{{${path}}}`, `{{/${path}}}`]),
  ].sort();

  // The 0004-0008 drill, one migration on. Also the ONLY place the seeded
  // template can be observed at all: truncateAll() empties every table in the
  // public schema before each test, so on the shared conduit_test database
  // the seeded row is gone by the time any test body runs. Task 4's service
  // tests inherit that -- they must seed their own quote template rather than
  // expecting the migration's, and this comment exists because "the default
  // template is missing" is otherwise a puzzling failure to meet.
  it("applies migration 0009 on top of a real database migrated only through 0008 -- five new tables arrive, the default quote template is seeded, documents(deal_id) is indexed, and a pre-existing deal can be quoted", async () => {
    await withPreMigrationDatabase("0009", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const company = await createCompany(scratch.db, user!.id, { name: "Acme" });
      const pipeline = await createPipeline(scratch.db, user!.id, { name: "Sales", scope: "global" });
      const stage = await createStage(scratch.db, user!.id, pipeline.id, { name: "New" });
      const deal = await createDeal(
        scratch.db, user!.id,
        { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id },
        "EUR",
      );

      // Pin the drill's premise before upgrading (the 0006-0008 pattern):
      // without this, every post-migrate assertion below would also pass
      // against a database that had been fully migrated all along.
      const [preTables] = await scratch.db.execute<{ present: number }>(sql`
        SELECT count(*)::int AS present FROM information_schema.tables
        WHERE table_name IN ('org_profile', 'documents', 'document_line_items',
                             'document_number_sequences', 'document_templates')
      `);
      expect(preTables?.present).toBe(0);

      // Upgrade: apply the real, full migrations folder. 0009 is the only
      // pending migration (0000-0008 are already recorded as applied).
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const [postTables] = await scratch.db.execute<{ present: number }>(sql`
        SELECT count(*)::int AS present FROM information_schema.tables
        WHERE table_name IN ('org_profile', 'documents', 'document_line_items',
                             'document_number_sequences', 'document_templates')
      `);
      expect(postTables?.present).toBe(5);

      // THE SEED. A broken one is invisible until somebody raises a quote and
      // gets an ugly PDF weeks later, so it is checked here rather than
      // trusted: exactly one row, of the right type, whose merge fields are
      // exactly the set above and whose page-layout CSS survived the SQL
      // literal intact.
      // TWO ROWS SINCE 0017 AND FIVE SINCE 0019, and this drill migrates to
      // HEAD: 0009 seeds the quote's template, 0017 the meeting summary's, 0019
      // the letter's and the two agreements'. The assertion is still about
      // 0009's -- what changed is that it has to name the row it means rather
      // than take the only one there is.
      //
      // **DRIVEN OFF THE ENUM RATHER THAN LISTED**, which it was not until Task
      // 3 and should have been from 0017. A hardcoded pair is a line every later
      // task has to remember to edit, in a drill about a migration that predates
      // its type -- and what it is really asserting is the invariant
      // `document_templates_type_valid`'s comment states: EVERY type Conduit can
      // produce has a template row seeded before anyone opens Settings. Written
      // this way, a type added with no seed fails here rather than at issue time
      // with a 409 on somebody's install.
      const templates = await scratch.db.select().from(documentTemplates)
        .orderBy(asc(documentTemplates.type));
      expect(templates.map((row) => row.type)).toEqual([...documentTypeSchema.options].sort());
      const quoteTemplate = templates.find((row) => row.type === "quote");
      const body = quoteTemplate!.bodyHtml;
      expect([...new Set(body.match(/\{\{[^}]*\}\}/g) ?? [])].sort()).toEqual(SEEDED_FIELDS);
      // Every {{ in the file is one of those tokens -- a CSS rule that
      // accidentally put two braces together would be eaten as a merge field.
      expect(body.match(/\{\{/g) ?? []).toHaveLength(body.match(/\{\{[^}]*\}\}/g)!.length);
      // The two properties the document sanitiser profile exists to allow,
      // and the one that keeps a newline-separated address from printing as a
      // single run-on line.
      expect(body).toContain("@page");
      expect(body).toContain("white-space: pre-line");
      // Rendered on the server (WeasyPrint 57.2) through the shipped renderPdf,
      // most recently after v1.1.0 put a salutation on the recipient's line: with a
      // logo and everything filled in, 4,104 chars of merged HTML and a ONE-page
      // 16,124-byte PDF; with no logo and nothing optional filled in, 3,473 chars
      // and a 14,379-byte one-page PDF carrying no image XObject at all. The filled
      // figures were 4,101 and 16,117 before "Dr " joined the contact's name; the
      // empty one has no contact name, so its character count did not move. Byte
      // counts move by one or two between runs -- the renderer is not reproducible
      // (Task 1) -- and page counts do not.
      // documents-seed.test.ts is where those two renders happen on every push, and
      // it prints the figures.

      // The hand-written index, ON A DATABASE THIS TEST MIGRATED FROM THE
      // FILES -- 0005's and 0008's reason: it exists in no drizzle snapshot,
      // so only a from-the-files migration proves the .sql file still carries
      // it. Asserted NOT unique and NOT partial: a deal has many documents
      // and every one of them must be found.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'documents'`,
      );
      const dealIndex = indexes.find((row) => row.indexname === "documents_deal_idx");
      expect(dealIndex?.indexdef).toMatch(/\(deal_id\)/i);
      expect(dealIndex?.indexdef).not.toMatch(/UNIQUE/i);
      expect(dealIndex?.indexdef).not.toMatch(/WHERE/i);

      // The new tables work against the PRE-EXISTING deal, not just rows
      // created after the upgrade -- which is the whole point of quoting from
      // a deal somebody has been working since before v1.0.0.
      const [file] = await scratch.db.insert(files).values({
        originalName: "QUO-2026-0001.pdf", mime: "application/pdf", sizeBytes: 16_003,
        sha256: "b".repeat(64), uploaderUserId: user!.id, dealId: deal.id,
      }).returning();
      // TWO ROWS SINCE 0016, and this drill migrates all the way to HEAD rather
      // than stopping at 0009 -- so the quote it writes here is a quote in the
      // shape the CURRENT schema keeps, not the one 0009 created. What it still
      // proves is 0009's claim: a deal that existed before v1.0.0 can be quoted.
      const [document] = await scratch.db.insert(documents).values({
        number: "QUO-2026-0001", type: "quote", dealId: deal.id, fileId: file!.id,
        issueDate: "2026-08-28", frozen: true, issuedByUserId: user!.id,
      }).returning();
      const [quote] = await scratch.db.insert(documentQuotes).values({
        documentId: document!.id, currency: "EUR",
        recipientName: "Acme", recipientContactName: "Jane Smith", recipientAddress: "2 Low St",
        subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100,
      }).returning();
      expect(document).toMatchObject({ dealId: deal.id, fileId: file!.id, frozen: true });
      expect(quote).toMatchObject({ documentId: document!.id, validUntilDate: null });

      const [line] = await scratch.db.insert(documentLineItems).values({
        documentId: document!.id, position: 1, description: "Widget",
        qtyMilli: 2000, unitPriceCents: 5000, lineTotalCents: 10_000,
      }).returning();
      expect(line).toMatchObject({ position: 1, taxRateBp: 0 });

      const [profile] = await scratch.db.insert(orgProfile).values({ name: "Listerdale" }).returning();
      expect(profile).toMatchObject({ id: 1, vatNumber: "", logoDataUri: "" });
    });
  }, 30000);

  it("applies migration 0010 on top of a real database migrated only through 0009 -- a pre-existing 32KB logo survives and a 300KB one becomes storable", async () => {
    await withPreMigrationDatabase("0010", async (scratch) => {
      // A v1.0.0 install with a v1.0.0 logo on it: the row this upgrade must not
      // disturb. 43,715 characters is the old column bound to the character.
      const oldPrefix = "data:image/png;base64,";
      const oldLogo = oldPrefix + "A".repeat(43_715 - oldPrefix.length);
      // RAW SQL, NOT `insert(orgProfile)`, and this line went red when 0018 added a
      // column: a drizzle insert spells out EVERY column schema.ts knows about --
      // `time_zone` included, as `default` -- against a database migrated only to
      // 0009, which does not have it. Exactly the hazard the 0011 and 0017 drills
      // already record; it reaches this one now because org_profile finally gained
      // a column after 0010. The UPDATEs below need no such treatment, since an
      // update names only what it sets.
      await scratch.db.execute(
        sql`INSERT INTO org_profile (id, name, logo_data_uri) VALUES (1, 'Listerdale', ${oldLogo})`,
      );

      // Pin the premise: before the migration a 300KB logo cannot be stored at all,
      // so every assertion after it is about the ALTER rather than about a database
      // that was fully migrated all along.
      const newLogo = oldPrefix + "A".repeat(MAX_LOGO_DATA_URI_CHARS - oldPrefix.length);
      await expect(scratch.db.update(orgProfile).set({ logoDataUri: newLogo }))
        .rejects.toMatchObject({ cause: { constraint_name: "org_profile_logo_size" } });

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // The pre-existing row is untouched -- this is a widening, so no row that
      // satisfied the old constraint can fail the new one.
      const [kept] = await scratch.db.select().from(orgProfile);
      expect(kept?.logoDataUri).toBe(oldLogo);

      await scratch.db.update(orgProfile).set({ logoDataUri: newLogo });
      const [raised] = await scratch.db.select().from(orgProfile);
      expect(raised?.logoDataUri).toHaveLength(MAX_LOGO_DATA_URI_CHARS);

      // ...and one character more is still refused, so the bound moved rather
      // than being dropped.
      await expect(scratch.db.update(orgProfile).set({ logoDataUri: `${newLogo}A` }))
        .rejects.toMatchObject({ cause: { constraint_name: "org_profile_logo_size" } });
    });
  }, 30000);

  // The singleton, which is the claim the whole org_profile design rests on:
  // "one row" has to be enforced by the database, not by everybody
  // remembering to upsert. Both halves are tested because either alone is
  // insufficient -- the primary key stops a second row at id 1, the CHECK
  // stops one at any other id, and dropping either leaves a hole.
  it("enforces one org_profile row: the default id collides, and any other id is refused", async () => {
    const [first] = await handle.db.insert(orgProfile).values({ name: "Listerdale" }).returning();
    expect(first?.id).toBe(1);

    await expect(handle.db.insert(orgProfile).values({ name: "Second" }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(handle.db.insert(orgProfile).values({ id: 2, name: "Second" }))
      .rejects.toMatchObject({ cause: { code: "23514" } });

    // And the shape that makes the pinned key worth having: create-or-update
    // in one statement, with no prior read to find the row.
    await handle.db.insert(orgProfile).values({ id: 1, name: "Renamed" })
      .onConflictDoUpdate({ target: orgProfile.id, set: { name: "Renamed" } });
    const rows = await handle.db.select().from(orgProfile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, name: "Renamed" });
  });

  it("enforces a globally unique document number", async () => {
    const parents = await seedDocumentParents();
    await handle.db.insert(documents).values(documentValues(parents));
    await expect(handle.db.insert(documents).values(documentValues(parents)))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    // A different number on the same deal is ordinary: raising a corrected
    // quote is raising another quote (spec's immutability decision).
    const [second] = await handle.db.insert(documents)
      .values(documentValues(parents, { number: "QUO-2026-0002" })).returning();
    expect(second).toMatchObject({ number: "QUO-2026-0002", dealId: parents.dealId });
  });

  it("enforces documents_type_valid, and the currency and totals CHECKs that moved to document_quotes", async () => {
    const parents = await seedDocumentParents();
    // A type outside the enum still fails on `documents`, where the type lives
    // -- and it is asserted BY NAME, because a bare 23514 cannot tell this
    // constraint from documents_frozen_matches_type. `frozen: false` is what
    // makes the rejection attributable rather than merely likely: with the
    // fixture's `frozen: true` an 'invoice' row breaks BOTH constraints (true
    // does not equal `'invoice' IN ('quote')`) and Postgres reports whichever it
    // reaches first, which was measured to be the frozen one. With `frozen:
    // false` the frozen CHECK is satisfied -- false = false -- so only
    // documents_type_valid can have refused this row.
    //
    // `number: null` IS THE SAME MOVE FOR THE SAME REASON, one constraint later.
    // 0017's documents_number_matches_type is `(number IS NOT NULL) = (type IN
    // ('quote'))`, so the fixture's number breaks it too for an 'invoice' -- and
    // this test went red the moment that CHECK shipped, naming the wrong
    // constraint.
    //
    // **AND 0020 BROKE IT A THIRD TIME, IN A WAY THAT CANNOT BE DODGED THE SAME
    // WAY.** `documents_entity_matches_type` names all six types, so ANY row
    // whose type is not one of them satisfies no arm and violates it -- there is
    // no combination of the other columns that leaves `documents_type_valid` the
    // only broken constraint, because the two now overlap exactly on the
    // "unknown type" case. So this row breaks both and PostgreSQL names whichever
    // it reaches first. **Generally: from 0020, `documents_type_valid` cannot be
    // probed BY NAME through an INSERT at all** -- the same shape of shadowing
    // Task 3 recorded for the frozen trigger over `document_quotes_type_is_quote`,
    // and it is handled the same way: assert the refusal here, and pin the
    // constraint itself from the catalogue below, where nothing can shadow it.
    await expect(handle.db.insert(documents)
      .values(documentValues(parents, { type: "invoice", frozen: false, number: null })))
      .rejects.toMatchObject({
        cause: {
          code: "23514",
          message: expect.stringMatching(
            /documents_type_valid|documents_entity_matches_type/,
          ),
        },
      });
    // THE CATALOGUE, WHICH IS THE ASSERTION THAT SURVIVED THE SHADOW -- and it is
    // a better one than the INSERT ever was. It reads what the constraint really
    // says and compares it to the enum, so a type added to `documentTypeSchema`
    // without a migration fails HERE, by name, rather than somewhere downstream
    // as a refused row.
    const [typeCheck] = await handle.db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'documents'::regclass AND conname = 'documents_type_valid'
    `);
    expect(typeCheck?.def).toBeDefined();
    expect([...(typeCheck?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort())
      .toEqual([...documentTypeSchema.options].sort());

    const document = await insertQuote(parents);
    // ...and the money CHECKs fail on document_quotes, which is where the money
    // is. Same rules, same rejection, one table further down.
    await expect(handle.db.insert(documentQuotes)
      .values(quoteValues(document.id, { currency: "eur" })))
      .rejects.toMatchObject({
        cause: {
          code: "23514", message: expect.stringContaining("document_quotes_currency_format"),
        },
      });
    // The totals identity: a total that is not subtotal + tax is the defect
    // this backstop exists for, and it is one an off-by-one-cent arithmetic
    // bug would produce.
    await expect(handle.db.insert(documentQuotes)
      .values(quoteValues(document.id, { totalCents: 13_101 })))
      .rejects.toMatchObject({
        cause: {
          code: "23514", message: expect.stringContaining("document_quotes_totals_consistent"),
        },
      });
  });

  // THE RULE THE WHOLE FK WIDENING RESTS ON, and it is `notes`'/`files`'
  // rule with a fifth column rather than a new one. Both directions are
  // driven, because either alone leaves half the constraint unexercised: zero
  // owners is the state `deal_id NOT NULL` used to forbid, and two owners is
  // the state nothing forbade before 0016 because nothing could.
  it("accepts a document attached to exactly one of the five, and refuses none or two", async () => {
    const parents = await seedDocumentParents();

    // **EACH RECORD NOW CARRIES THE TYPE THAT BELONGS TO IT**, which is 0020
    // showing through: before `documents_entity_matches_type` every one of these
    // five was a QUOTE, hung off whichever column the loop was testing, and the
    // database had no opinion. Now it does, so the accepted half of this test is
    // also the demonstration that all six types can be stored at all.
    for (const [index, type] of documentTypeSchema.options.entries()) {
      const owner = ownerForType(type, parents);
      const [row] = await handle.db.insert(documents).values(documentValues(parents, {
        number: documentTypeNumbered(type) ? `QUO-2026-30${index}` : null,
        type, frozen: documentTypeFreezes(type), ...owner,
      })).returning();
      expect(row).toMatchObject(owner);
    }

    // NONE -- AND THIS ONE CAN NO LONGER BE ATTRIBUTED BY NAME. A row with no
    // record satisfies no arm of `documents_entity_matches_type` either, so
    // both constraints refuse it and PostgreSQL names whichever it reaches
    // first. The sharp probe of `documents_exactly_one_entity` is the TWO-owner
    // case below, which the entity CHECK deliberately passes.
    await expect(handle.db.insert(documents)
      .values(documentValues(parents, { number: "QUO-2026-3900", dealId: null })))
      .rejects.toMatchObject({
        cause: {
          code: "23514",
          message: expect.stringMatching(
            /documents_exactly_one_entity|documents_entity_matches_type/,
          ),
        },
      });
    // Two, in every pairing a fifth column makes possible -- a CHECK that
    // named only four columns passes the first of these and fails the rest.
    //
    // **STILL ATTRIBUTABLE BY NAME AFTER 0020, AND NOT BY LUCK.** The fixture is
    // a quote WITH its deal, so `type = 'quote' AND deal_id IS NOT NULL` holds
    // and `documents_entity_matches_type` is satisfied by every one of these
    // rows -- the second owner is invisible to it, because "which record" and
    // "how many records" are different questions and each constraint asks one.
    // That is what makes this the probe that survived.
    const pairs: Partial<typeof documents.$inferInsert>[] = [
      { companyId: parents.companyId }, { contactId: parents.contactId },
      { projectId: parents.projectId }, { meetingId: parents.meetingId },
    ];
    for (const [index, second] of pairs.entries()) {
      await expect(handle.db.insert(documents)
        .values(documentValues(parents, { number: `QUO-2026-39${index}`, ...second })))
        .rejects.toMatchObject({
          cause: {
            code: "23514", message: expect.stringContaining("documents_exactly_one_entity"),
          },
        });
    }
  });

  /**
   * **WHICH RECORD EACH TYPE GOES ON -- THE GAP TASK 3 WROTE OUT IN THE PLAN AND
   * LEFT FOR THIS TASK, NOW CLOSED BY 0020.**
   *
   * Task 3: "`documents_exactly_one_entity` says exactly one of five. It does not
   * say WHICH one for a given type. Nothing in the database stops a letter
   * carrying a `deal_id` or a quote carrying a `meeting_id`; only the writers do."
   *
   * DRIVEN OFF THE ENUM AND OVER EVERY WRONG RECORD, not over a sample. For each
   * of the six types this tries all five owners: the one that belongs to it must
   * be accepted, and each of the other four must be refused BY NAME. A CHECK that
   * forgot one type's arm passes its right owner and passes its wrong ones too,
   * which is a hole a spot check would walk straight past.
   *
   * The letter family is the one with two right answers, so it is asserted as
   * two: a letter on a company and a letter on a contact are both ordinary, and
   * the same letter on a deal, a project or a meeting is not.
   */
  it("pins which record each document type may be attached to, for every type and every record", async () => {
    const parents = await seedDocumentParents();
    const allOwners = {
      companyId: parents.companyId, contactId: parents.contactId, dealId: parents.dealId,
      projectId: parents.projectId, meetingId: parents.meetingId,
    } as const;
    const RIGHT: Record<DocumentType, (keyof typeof allOwners)[]> = {
      quote: ["dealId"],
      meeting_summary: ["meetingId"],
      letter: ["companyId", "contactId"],
      nda: ["companyId", "contactId"],
      mutual_nda: ["companyId", "contactId"],
      project_status_report: ["projectId"],
    };
    const none = {
      companyId: null, contactId: null, dealId: null, projectId: null, meetingId: null,
    };

    let serial = 0;
    for (const type of documentTypeSchema.options) {
      for (const column of Object.keys(allOwners) as (keyof typeof allOwners)[]) {
        serial += 1;
        const values = documentValues(parents, {
          number: documentTypeNumbered(type) ? `QUO-2026-6${String(serial).padStart(3, "0")}` : null,
          type, frozen: documentTypeFreezes(type),
          ...none, [column]: allOwners[column],
        });
        if (RIGHT[type].includes(column)) {
          const [row] = await handle.db.insert(documents).values(values).returning();
          expect(row).toMatchObject({ type, [column]: allOwners[column] });
          continue;
        }
        await expect(handle.db.insert(documents).values(values)).rejects.toMatchObject({
          cause: {
            code: "23514",
            message: expect.stringContaining("documents_entity_matches_type"),
          },
        });
      }
    }
  });

  // THE PER-TYPE FREEZING RULE, IN ITS TWO SPELLINGS. @conduit/shared's
  // documentTypeFreezes() tells a writer what to store and the CHECK stops a
  // writer that got it wrong, so a member added to one and not the other is a
  // document that either cannot be stored or is stored under the wrong rule.
  // Mirrors the mailAuthMethodSchema/mail_accounts_auth_method_valid pair.
  //
  // DRIVEN OFF THE ENUM rather than over a hardcoded list, so a type added in
  // Task 2 arrives here without anybody remembering to add it.
  it("keeps documentTypeFreezes in step with documents_frozen_matches_type, for every type", async () => {
    const parents = await seedDocumentParents();
    for (const [index, type] of documentTypeSchema.options.entries()) {
      const declared = documentTypeFreezes(type);
      // THE NUMBER IS PER TYPE TOO SINCE 0017, and this line is what the enum
      // driving the loop bought: `meeting_summary` arrived and a fixture that
      // always set a number stopped satisfying documents_number_matches_type,
      // here, rather than in some later task. Asked of documentTypeNumbered
      // rather than spelled, because THIS test is about `frozen` -- pinning the
      // numbering rule is the next test's job and doing it twice would make a
      // failure here ambiguous about which rule broke.
      const number = documentTypeNumbered(type) ? `QUO-2026-40${index}` : null;
      // THE RECORD IS PER TYPE TOO SINCE 0020, and this line is the second thing
      // the enum driving the loop bought. Before `documents_entity_matches_type`
      // every type hung off the fixture's deal; now a summary on a deal is a
      // refused row, and it would have been refused HERE -- naming the wrong
      // constraint -- exactly as the numbering rule did to this test in 0017.
      const owner = ownerForType(type, parents);
      const [row] = await handle.db.insert(documents)
        .values(documentValues(parents, { number, type, frozen: declared, ...owner }))
        .returning();
      expect(row).toMatchObject({ type, frozen: declared });

      await expect(handle.db.insert(documents).values(documentValues(parents, {
        number: documentTypeNumbered(type) ? `QUO-2026-49${index}` : null,
        type,
        frozen: !declared,
        ...owner,
      }))).rejects.toMatchObject({
        cause: {
          code: "23514", message: expect.stringContaining("documents_frozen_matches_type"),
        },
      });
    }
  });

  // The column has no DEFAULT, and that is what makes the value above a
  // decision rather than something a forgetful writer inherits. 0016 adds it
  // WITH `DEFAULT true` -- that is how every pre-existing quote gets filled --
  // and drops the default in the same migration, because the next three types
  // to arrive are all `false`.
  it("gives frozen no default, so a writer that says nothing is refused", async () => {
    const [column] = await handle.db.execute<{ column_default: string | null }>(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'documents' AND column_name = 'frozen'
    `);
    expect(column?.column_default).toBeNull();
  });

  it("enforces one line per position per document, and the three line-item CHECKs", async () => {
    const parents = await seedDocumentParents();
    const [document] = await handle.db.insert(documents).values(documentValues(parents)).returning();
    const line = {
      documentId: document!.id, position: 1, description: "Widget",
      qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100, lineTotalCents: 10_000,
    };
    await handle.db.insert(documentLineItems).values(line);

    await expect(handle.db.insert(documentLineItems).values(line))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    // The next position on the same document is fine, and so is position 1 on
    // a different one -- the constraint is per document, not global.
    await handle.db.insert(documentLineItems).values({ ...line, position: 2 });
    const [other] = await handle.db.insert(documents)
      .values(documentValues(parents, { number: "QUO-2026-0002" })).returning();
    await handle.db.insert(documentLineItems).values({ ...line, documentId: other!.id });

    for (const bad of [
      { qtyMilli: -1 }, { unitPriceCents: -1 }, { taxRateBp: -1 }, { taxRateBp: 10_001 },
    ]) {
      await expect(handle.db.insert(documentLineItems).values({ ...line, position: 9, ...bad }))
        .rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });

  // The numbering table's whole reason for being a table (spec: nextval() is
  // non-transactional and a failed render would burn the number). This pins
  // the allocation statement Task 4 issues, against the composite key.
  it("allocates consecutive numbers per (type, year) through ON CONFLICT DO UPDATE, and rolls back with its transaction", async () => {
    const allocate = async (db: typeof handle.db, year: number): Promise<number> => {
      const [row] = await db.insert(documentNumberSequences)
        .values({ type: "quote", year, lastValue: 1 })
        .onConflictDoUpdate({
          target: [documentNumberSequences.type, documentNumberSequences.year],
          set: { lastValue: sql`${documentNumberSequences.lastValue} + 1` },
        })
        .returning({ lastValue: documentNumberSequences.lastValue });
      return row!.lastValue;
    };

    expect(await allocate(handle.db, 2026)).toBe(1);
    expect(await allocate(handle.db, 2026)).toBe(2);
    // A different year is a different counter: the numbering resets each
    // January rather than running on.
    expect(await allocate(handle.db, 2027)).toBe(1);

    // THE PROPERTY A SEQUENCE COULD NOT GIVE: an allocation inside a
    // transaction that fails leaves no number spent, so the next quote takes
    // the one the failed render was holding.
    await expect(handle.db.transaction(async (tx) => {
      expect(await allocate(tx as typeof handle.db, 2026)).toBe(3);
      throw new Error("render failed");
    })).rejects.toThrow("render failed");
    expect(await allocate(handle.db, 2026)).toBe(3);

    await expect(handle.db.insert(documentNumberSequences).values({ type: "invoice", year: 2026 }))
      .rejects.toMatchObject({ cause: { code: "23514" } });
  });

  // THIS TEST DEPENDS ON THE SEEDED TEMPLATE BEING GONE, which is the exact
  // opposite of the dependency the drill above warns about: truncateAll() empties
  // document_templates like every other public table, so the first insert here
  // finds an empty table. If truncateAll is ever taught to preserve seed rows --
  // a plausible optimisation, since re-seeding by hand is the only reason Task 4
  // has to know about any of this -- this insert starts colliding with the
  // migration's own row and fails with 23505 in a file that has nothing to do
  // with seeding. The explicit emptiness assertion below is there to say so at
  // the point of failure rather than leaving a puzzling unique violation.
  it("allows one template per type and rejects an unknown type", async () => {
    expect(await handle.db.select().from(documentTemplates)).toHaveLength(0);
    await handle.db.insert(documentTemplates).values({ type: "quote", bodyHtml: "<p>a</p>" });
    await expect(handle.db.insert(documentTemplates).values({ type: "quote", bodyHtml: "<p>b</p>" }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(handle.db.insert(documentTemplates).values({ type: "proposal", bodyHtml: "<p>c</p>" }))
      .rejects.toMatchObject({ cause: { code: "23514" } });
  });

  // THE TRIPWIRE FOR money.ts's int4 BOUND. exactInt4() refuses a qtyMilli or a
  // rateBp outside the int4 range, and the only reason that number is right is
  // that these two columns are `integer`. Widening either without widening the
  // arithmetic (or the reverse) recreates the defect the pair was added for: a
  // quantity the form accepts, documentTotals computes, the renderer spends a
  // subprocess on, and the INSERT then rejects with `integer out of range`.
  // unit_price_cents is asserted alongside as the CONTRAST -- it is bigint, so
  // there the safe-integer check is correctly the narrower of the two domains.
  it("keeps qty_milli and tax_rate_bp int4, which is what money.ts's bound is derived from", async () => {
    const columns = await handle.db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'document_line_items'
        AND column_name IN ('qty_milli', 'tax_rate_bp', 'unit_price_cents')
    `);
    const byName = new Map(columns.map((row) => [row.column_name, row.data_type]));
    expect(byName.get("qty_milli")).toBe("integer");
    expect(byName.get("tax_rate_bp")).toBe("integer");
    expect(byName.get("unit_price_cents")).toBe("bigint");

    // And the boundary itself, through the column rather than through the
    // function: int4's ceiling stores, one past it does not.
    const parents = await seedDocumentParents();
    const [document] = await handle.db.insert(documents).values(documentValues(parents)).returning();
    const line = {
      documentId: document!.id, description: "Widget", unitPriceCents: 1, lineTotalCents: 1,
    };
    const [stored] = await handle.db.insert(documentLineItems)
      .values({ ...line, position: 1, qtyMilli: 2_147_483_647 }).returning();
    expect(stored?.qtyMilli).toBe(2_147_483_647);
    await expect(handle.db.insert(documentLineItems)
      .values({ ...line, position: 2, qtyMilli: 2_147_483_648 }))
      .rejects.toMatchObject({ cause: { code: "22003" } });
  });

  // The other half of money.ts's one-sided guard: documentTotals refuses to
  // PRODUCE a total past 2^53, and these refuse to STORE one arriving by any
  // other path, where drizzle's mode:"number" would read it back as the nearest
  // double without complaint.
  //
  // BOTH SIDES OF EVERY BOUND, and one out-of-range column per case. An earlier
  // version drove each table with a single over-range column and asserted only
  // the 23514, and three mutations survived it green: deleting the
  // line_total_cents clause, deleting the tax_cents clause, and narrowing every
  // bound from ...991 to ...990. The narrowing is the one that would have hurt --
  // documentTotals legitimately emits exactly 9007199254740991, so an off-by-one
  // would have rejected a quote that had already been rendered.
  const SAFE = 9_007_199_254_740_991;
  const PAST = 9_007_199_254_740_992;

  it("accepts stored amounts at the exact edges of the safe integer range", async () => {
    const parents = await seedDocumentParents();
    // The ceiling row is exactly what
    // documentTotals([{ qtyMilli: 1000, unitPriceCents: SAFE }]) emits, which is
    // why this edge has to be ACCEPTED rather than merely nearly rejected.
    const rows: Partial<typeof documentQuotes.$inferInsert>[] = [
      { subtotalCents: SAFE, taxCents: 0, totalCents: SAFE },
      { subtotalCents: 0, taxCents: SAFE, totalCents: SAFE },
      { subtotalCents: -SAFE, taxCents: 0, totalCents: -SAFE },
      { subtotalCents: 0, taxCents: -SAFE, totalCents: -SAFE },
    ];
    for (const [index, overrides] of rows.entries()) {
      const [owner] = await handle.db.insert(documents)
        .values(documentValues(parents, { number: `QUO-2026-100${index}` })).returning();
      const [row] = await handle.db.insert(documentQuotes)
        .values(quoteValues(owner!.id, overrides)).returning();
      expect(row).toMatchObject(overrides);
    }

    const [document] = await handle.db.insert(documents)
      .values(documentValues(parents, { number: "QUO-2026-2000" })).returning();
    const [line] = await handle.db.insert(documentLineItems).values({
      documentId: document!.id, position: 1, description: "Widget",
      qtyMilli: 1000, unitPriceCents: SAFE, lineTotalCents: SAFE,
    }).returning();
    expect(line).toMatchObject({ unitPriceCents: SAFE, lineTotalCents: SAFE });
    // line_total_cents carries no sign CHECK, so its floor is reachable and has
    // to be pinned too or a narrowing of it survives.
    const [floorLine] = await handle.db.insert(documentLineItems).values({
      documentId: document!.id, position: 2, description: "Credit",
      qtyMilli: 0, unitPriceCents: 0, lineTotalCents: -SAFE,
    }).returning();
    expect(floorLine).toMatchObject({ lineTotalCents: -SAFE });
  });

  it("refuses stored amounts past the safe integer range, one clause at a time", async () => {
    const parents = await seedDocumentParents();
    // Each row puts exactly ONE column out of range while keeping the other two
    // in range AND satisfying documents_totals_consistent, so the rejection can
    // only have come from the clause under test -- asserted BY NAME, since a
    // bare 23514 cannot tell the two constraints apart and the consistency one
    // would fire on a naively-built row.
    const rows: Partial<typeof documentQuotes.$inferInsert>[] = [
      { subtotalCents: 2 * SAFE, taxCents: -SAFE, totalCents: SAFE },
      { subtotalCents: -SAFE, taxCents: 2 * SAFE, totalCents: SAFE },
      { subtotalCents: SAFE, taxCents: SAFE, totalCents: 2 * SAFE },
    ];
    for (const [index, overrides] of rows.entries()) {
      const [owner] = await handle.db.insert(documents)
        .values(documentValues(parents, { number: `QUO-2026-200${index}` })).returning();
      await expect(handle.db.insert(documentQuotes).values(quoteValues(owner!.id, overrides)))
        .rejects.toMatchObject({
          cause: {
            code: "23514",
            message: expect.stringContaining("document_quotes_totals_representable"),
          },
        });
    }

    const [document] = await handle.db.insert(documents).values(documentValues(parents)).returning();
    const lines: Partial<typeof documentLineItems.$inferInsert>[] = [
      { unitPriceCents: PAST },
      { lineTotalCents: PAST },
      { lineTotalCents: -PAST },
    ];
    for (const overrides of lines) {
      await expect(handle.db.insert(documentLineItems).values({
        documentId: document!.id, position: 1, description: "Widget",
        qtyMilli: 1000, unitPriceCents: 1, lineTotalCents: 1, ...overrides,
      })).rejects.toMatchObject({
        cause: {
          code: "23514",
          message: expect.stringContaining("document_line_items_amounts_representable"),
        },
      });
    }
  });

  it("enforces every foreign key on documents, document_quotes and document_line_items", async () => {
    const parents = await seedDocumentParents();
    // The four record FKs 0016 added are driven with `dealId: null` beside them,
    // so each row has exactly one owner and reaches the foreign key: with
    // deal_id still set, documents_exactly_one_entity fires first and every one
    // of these would report 23514 without the FK being consulted at all.
    //
    // **AND SINCE 0020 EACH ROW ALSO HAS TO CARRY THE TYPE THAT BELONGS TO ITS
    // COLUMN**, for exactly the same reason one constraint further along: a
    // QUOTE naming a company is refused by `documents_entity_matches_type`
    // before PostgreSQL ever looks the company up, so all four of these would
    // have gone back to reporting 23514. The type is what makes each row legal
    // enough to reach the foreign key, and the bogus uuid is the only thing left
    // wrong with it.
    const bad: Partial<typeof documents.$inferInsert>[] = [
      { dealId: randomUUID() },
      { dealId: null, companyId: randomUUID(), type: "letter", number: null, frozen: false },
      { dealId: null, contactId: randomUUID(), type: "letter", number: null, frozen: false },
      {
        dealId: null, projectId: randomUUID(),
        type: "project_status_report", number: null, frozen: false,
      },
      {
        dealId: null, meetingId: randomUUID(),
        type: "meeting_summary", number: null, frozen: false,
      },
      { fileId: randomUUID() },
      { issuedByUserId: randomUUID() },
    ];
    for (const overrides of bad) {
      await expect(handle.db.insert(documents).values(documentValues(parents, overrides)))
        .rejects.toMatchObject({ cause: { code: "23503" } });
    }
    await expect(handle.db.insert(documentQuotes).values(quoteValues(randomUUID())))
      .rejects.toMatchObject({ cause: { code: "23503" } });
    // One detail row per document, said by the primary key rather than by
    // convention -- a second quote body for the same document is not something
    // any reader would know what to do with.
    const document = await insertQuote(parents);
    await expect(handle.db.insert(documentQuotes).values(quoteValues(document.id)))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(handle.db.insert(documentLineItems).values({
      documentId: randomUUID(), position: 1, description: "Widget",
      qtyMilli: 1000, unitPriceCents: 1, lineTotalCents: 1,
    })).rejects.toMatchObject({ cause: { code: "23503" } });
    // org_profile carries no foreign key at all any more. It had one --
    // logo_file_id -> files.id -- and it was unsatisfiable: every files row must
    // belong to exactly one company, contact, deal or project
    // (files_exactly_one_entity), and an issuer's logo belongs to none of them,
    // so nothing legal could ever have been stored in it. The logo is the bytes
    // now; the two CHECKs below are what bound them.
  });

  // THE LOGO'S TWO BOUNDS, AND THEY ARE DIFFERENT NUMBERS. MAX_LOGO_BYTES bounds
  // the image; the column holds base64 at 4/3 of that plus a prefix. Reusing the
  // first as the second would silently shrink the permitted logo by a quarter,
  // and every rejected upload would look like the user's mistake.
  it("bounds the logo column by the base64 length of a MAX_LOGO_BYTES image, not by MAX_LOGO_BYTES", async () => {
    const [check] = await handle.db.execute<{ src: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS src FROM pg_constraint
      WHERE conname = 'org_profile_logo_size'
    `);
    // The constant and the constraint cannot drift: one is asserted to be in the
    // other. 409623 = 4 * ceil(307200/3) + len('data:image/jpeg;base64,'), and it
    // was 43715 until v1.0.1 raised the logo from 32KB to 300KB -- so migration
    // 0010 exists to widen this constraint, and this line is what would have
    // failed if it did not.
    expect(MAX_LOGO_DATA_URI_CHARS).toBe(409_623);
    expect(check?.src).toContain(String(MAX_LOGO_DATA_URI_CHARS));

    const prefix = "data:image/png;base64,";
    const atLimit = prefix + "A".repeat(MAX_LOGO_DATA_URI_CHARS - prefix.length);
    await expect(handle.db.insert(orgProfile).values({ logoDataUri: `${atLimit}A` }))
      .rejects.toMatchObject({ cause: { constraint_name: "org_profile_logo_size" } });

    await handle.db.delete(orgProfile);
    const [stored] = await handle.db.insert(orgProfile).values({ logoDataUri: atLimit }).returning();
    expect(stored?.logoDataUri.length).toBe(MAX_LOGO_DATA_URI_CHARS);
  });

  // The shape CHECK, whose regex has to smuggle its own semicolon past
  // drizzle-kit's statement splitter (see schema.ts). If the escape were wrong
  // the constraint would accept everything, silently.
  it("refuses anything in the logo column that is not an inline base64 image", async () => {
    for (const bad of [
      "file:///etc/passwd",
      "https://example.test/logo.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGgxPmhpPC9oMT4=",
      "data:image/png;base64,not base64 at all",
      "data:image/png,AAAA",
    ]) {
      await expect(handle.db.insert(orgProfile).values({ logoDataUri: bad }))
        .rejects.toMatchObject({ cause: { constraint_name: "org_profile_logo_shape" } });
    }
    // ...and the four types that are allowed, plus the empty absence.
    for (const good of [
      "", "data:image/png;base64,AAAA", "data:image/jpeg;base64,AAA=",
      "data:image/gif;base64,AA==", "data:image/webp;base64,AAAA",
    ]) {
      await handle.db.delete(orgProfile);
      const [row] = await handle.db.insert(orgProfile).values({ logoDataUri: good }).returning();
      expect(row?.logoDataUri).toBe(good);
    }
  });
});

describe("salutation and pronouns (0011)", () => {
  /** The line 0009 seeded, and the line 0011 rewrites it to. Written out here rather
   * than read from the migration on purpose: this is the assertion, and a test that
   * derived its expectation from the file under test would pass whatever that file
   * said. seededQuoteTemplate() is the derived one, and the drills below check the two
   * against each other. */
  const OLD_LINE =
    "{{#document.recipientContactName}}<div>{{document.recipientContactName}}</div>"
    + "{{/document.recipientContactName}}";
  const NEW_LINE =
    "{{#document.recipientContactName}}<div>{{#document.recipientSalutation}}"
    + "{{document.recipientSalutation}} {{/document.recipientSalutation}}"
    + "{{document.recipientContactName}}</div>{{/document.recipientContactName}}";

  /** A contact, and a document with all its NOT NULL parents, INSERTed as a pre-0011
   * database can hold them: raw SQL for every table whose shape has moved since,
   * so nothing here names a column that does not exist yet.
   *
   * `files` JOINED THAT LIST IN PHASE 9, and the failure is worth recording because
   * it is the standing hazard of every drill in this file: schema.ts describes
   * TODAY's shape, so `insert(files)` names `meeting_id`, which a pre-0011 database
   * has never heard of. It was a drizzle insert until 0017 added the column and this
   * test went red with `column "meeting_id" of relation "files" does not exist` --
   * in a drill about salutations. */
  async function seedPreUpgradeRows(scratch: DatabaseHandle): Promise<void> {
    const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
    const pipeline = await createPipeline(scratch.db, user!.id, { name: "Sales", scope: "global" });
    const stage = await createStage(scratch.db, user!.id, pipeline.id, { name: "New" });
    const deal = await createDeal(
      scratch.db, user!.id, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const [file] = await scratch.db.execute<{ id: string }>(sql`
      INSERT INTO files (original_name, mime, size_bytes, sha256, uploader_user_id, deal_id)
      VALUES ('QUO-2026-0001.pdf', 'application/pdf', 16003, ${"c".repeat(64)},
              ${user!.id}, ${deal.id})
      RETURNING id
    `);
    await scratch.db.execute(sql`
      INSERT INTO contacts (first_name, last_name) VALUES ('Jane', 'Smith')
    `);
    await scratch.db.execute(sql`
      INSERT INTO documents (number, type, deal_id, file_id, currency, issue_date,
                             recipient_name, recipient_contact_name,
                             subtotal_cents, tax_cents, total_cents, issued_by_user_id)
      VALUES ('QUO-2026-0001', 'quote', ${deal.id}, ${file!.id}, 'EUR', '2026-08-28',
              'Acme', 'Jane Smith', 11000, 2100, 13100, ${user!.id})
    `);
  }

  async function quoteTemplateRow(
    scratch: DatabaseHandle,
  ): Promise<{ bodyHtml: string; updatedAt: Date }> {
    const [row] = await scratch.db
      .select({ bodyHtml: documentTemplates.bodyHtml, updatedAt: documentTemplates.updatedAt })
      .from(documentTemplates).where(eq(documentTemplates.type, "quote"));
    if (row === undefined) throw new Error("no quote template in the scratch database");
    return row;
  }

  it("applies migration 0011 on top of a real database migrated only through 0010 -- an existing contact gains two empty columns, an existing document gains an empty salutation, and the seeded template starts printing it", async () => {
    await withPreMigrationDatabase("0011", async (scratch) => {
      await seedPreUpgradeRows(scratch);

      // Pin the premise: without this every assertion below would also pass against
      // a database that had been fully migrated all along (the 0006-0010 pattern).
      const [pre] = await scratch.db.execute<{ present: number }>(sql`
        SELECT count(*)::int AS present FROM information_schema.columns
        WHERE (table_name, column_name) IN
          (('contacts', 'salutation'), ('contacts', 'pronouns'),
           ('documents', 'recipient_salutation'))
      `);
      expect(pre?.present).toBe(0);
      expect((await quoteTemplateRow(scratch)).bodyHtml).toContain(OLD_LINE);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // NOTHING IS INFERRED, INCLUDING AT UPGRADE. A contact who existed before this
      // release has no salutation and no pronouns -- not a guess from the name -- and
      // a quote issued before it prints no salutation rather than acquiring one.
      const [contact] = await scratch.db
        .select({ salutation: contacts.salutation, pronouns: contacts.pronouns })
        .from(contacts);
      expect(contact).toEqual({ salutation: null, pronouns: null });
      // READ OUT OF document_quotes, NOT documents, and that is 0016 showing
      // through a drill about 0011: this migrates all the way to HEAD, so by the
      // time the assertion runs the column 0011 added has been moved to the
      // quote's own table -- carrying the '' that 0011 backfilled, which is the
      // thing being asserted and is exactly what 0016 must not have disturbed.
      const [document] = await scratch.db
        .select({ recipientSalutation: documentQuotes.recipientSalutation }).from(documentQuotes);
      expect(document?.recipientSalutation).toBe("");

      // THE SEED, AMENDED IN PLACE. An install that never touched the template gets
      // the new line...
      const body = (await quoteTemplateRow(scratch)).bodyHtml;
      expect(body).not.toContain(OLD_LINE);
      expect(body).toContain(NEW_LINE);
      // ...and this is the assertion that stops the file-derived template and the
      // real one from drifting apart. Every merge test in this repo reads the
      // template out of the migrations (truncateAll() destroys the row, so the
      // database is not available to them); if that reader ever stopped applying an
      // amendment, those suites would go on testing a template no install has. This
      // is the one place both are in hand at once.
      expect(body).toBe(seededQuoteTemplate());
    });
  }, 30000);

  it("amends a CUSTOMISED template in place, keeping every customisation", async () => {
    // THE OPERATOR'S AFTERNOON. Settings -> Templates lets the template be edited,
    // and a migration that assigned a fresh body would silently destroy a letterhead
    // with no undo anywhere in the product. 0011 rewrites one line and touches
    // nothing else, which is what this proves.
    await withPreMigrationDatabase("0011", async (scratch) => {
      const custom = "<div>Registered in Amsterdam. Quotes valid 30 days.</div>";
      await scratch.db.execute(sql`
        UPDATE document_templates SET body_html = body_html || ${custom} WHERE type = 'quote'
      `);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const body = (await quoteTemplateRow(scratch)).bodyHtml;
      expect(body).toBe(seededQuoteTemplate() + custom);
    });
  }, 30000);

  it("leaves a template it cannot amend without making it unsaveable, and says so in the file", async () => {
    // O-1. The rewrite grows the body by 99 bytes, and saveDocumentTemplate refuses
    // anything over MAX_TEMPLATE_BYTES -- so amending a template that is already
    // within 99 bytes of the cap would leave the operator unable to save their own
    // letterhead, including a PUT of the body a GET had just returned. The migration
    // measures the amended body first and skips such a row.
    //
    // The constant and the migration's literal are pinned to each other here, since
    // SQL cannot import it.
    const migration = readFileSync(
      path.join(migrationsFolder(), "0011_sharp_skullbuster.sql"), "utf8",
    );
    expect(migration).toContain(`octet_length(amendment.amended) <= ${String(MAX_TEMPLATE_BYTES)}`);

    await withPreMigrationDatabase("0011", async (scratch) => {
      // Padded to exactly the cap, with the recipient line still intact: the
      // amendment matches, and applying it would produce 16,483 bytes.
      const [seeded] = await scratch.db
        .select({ bodyHtml: documentTemplates.bodyHtml })
        .from(documentTemplates).where(eq(documentTemplates.type, "quote"));
      const padding = "p".repeat(MAX_TEMPLATE_BYTES - Buffer.byteLength(seeded!.bodyHtml, "utf8"));
      await scratch.db.execute(sql`
        UPDATE document_templates SET body_html = body_html || ${padding} WHERE type = 'quote'
      `);
      const before = await quoteTemplateRow(scratch);
      expect(Buffer.byteLength(before.bodyHtml, "utf8")).toBe(MAX_TEMPLATE_BYTES);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      expect(await quoteTemplateRow(scratch)).toEqual(before);

      // ...and one byte of headroom less than the growth is the boundary: at
      // MAX_TEMPLATE_BYTES - 99 the amendment lands exactly on the cap and IS
      // applied, so the guard is a bound rather than a blanket refusal.
    });

    // ...and the boundary, on its own database because a migration only runs once.
    // At exactly 99 bytes of headroom the amendment lands ON the cap and IS applied,
    // so the guard is a bound rather than a blanket refusal to touch a large body.
    await withPreMigrationDatabase("0011", async (scratch) => {
      const [seeded] = await scratch.db
        .select({ bodyHtml: documentTemplates.bodyHtml })
        .from(documentTemplates).where(eq(documentTemplates.type, "quote"));
      const room = MAX_TEMPLATE_BYTES - 99 - Buffer.byteLength(seeded!.bodyHtml, "utf8");
      const padding = "p".repeat(room);
      await scratch.db.execute(sql`
        UPDATE document_templates SET body_html = body_html || ${padding} WHERE type = 'quote'
      `);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const amended = await quoteTemplateRow(scratch);
      expect(amended.bodyHtml).toBe(seededQuoteTemplate() + padding);
      expect(Buffer.byteLength(amended.bodyHtml, "utf8")).toBe(MAX_TEMPLATE_BYTES);
    });
  }, 60000);

  it("leaves a template whose recipient line was itself edited completely alone, updated_at included", async () => {
    // The other side of the guard. An install that rewrote the recipient block has
    // said what it wants there; the migration matches nothing, changes nothing, and
    // does not even restamp updated_at -- so Settings does not report an edit that
    // never happened. That install adds {{document.recipientSalutation}} by hand, and
    // the field list on the Settings page is where it is documented.
    await withPreMigrationDatabase("0011", async (scratch) => {
      await scratch.db.execute(sql`
        UPDATE document_templates
        SET body_html = replace(body_html, ${OLD_LINE}, '<p>FAO {{document.recipientContactName}}</p>')
        WHERE type = 'quote'
      `);
      const before = await quoteTemplateRow(scratch);
      expect(before.bodyHtml).not.toContain(OLD_LINE);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      expect(await quoteTemplateRow(scratch)).toEqual(before);
    });
  }, 30000);

  // THE BOUND, AND WHAT IT DELIBERATELY DOES NOT BOUND. 64 characters each, enforced
  // by the CHECKs as the backstop to CONTACT_FIELD_CAPS in @conduit/shared -- and no
  // constraint whatsoever on the VALUE. The picker's Mr/Mrs/Ms/Mx/Dr/Prof and
  // he-him/she-her/they-them are a UI convenience; an enum or a value-set CHECK here
  // would turn "type your own" into a 23514 for every title in every other language.
  it("bounds both new contact columns at 64 characters and constrains their values not at all", async () => {
    // The constants and the constraints cannot drift, EACH AGAINST ITS OWN. An
    // earlier version of this checked both constraints against the salutation
    // constant with `toContain`, which passed for a CHECK of 640 or 164 and would
    // have missed the two caps diverging -- they are the same number today, and
    // nothing says they must stay that way. Zod refuses a long value first; these
    // are the backstop.
    //
    // THE BACKSTOP IS UNREACHABLE THROUGH THE API, and that is fine. Zod counts
    // UTF-16 code units and char_length counts code points, and they diverge only in
    // the direction where Zod is stricter: an astral character costs 2 to Zod and 1
    // to Postgres, so a salutation of emoji is effectively capped at 32 by the gate
    // and can never reach a 23514. The CHECK is for the direct-write paths (a seed,
    // an import) that never see the schema.
    const checks = await handle.db.execute<{ conname: string; src: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS src FROM pg_constraint
      WHERE conname IN ('contacts_salutation_length', 'contacts_pronouns_length')
    `);
    const byName = new Map(checks.map((row) => [row.conname, row.src]));
    for (const [column, cap] of [
      ["salutation", CONTACT_FIELD_CAPS.salutation],
      ["pronouns", CONTACT_FIELD_CAPS.pronouns],
    ] as const) {
      const src = byName.get(`contacts_${column}_length`);
      expect(src, `no contacts_${column}_length constraint`).toBeDefined();
      // The whole expression, so neither the column nor the number can be the other
      // one's and neither can be a prefix of a larger figure.
      expect(src).toMatch(new RegExp(`char_length\\(${column}\\)\\s*<=\\s*${String(cap)}\\)`));
    }

    const atLimit = "x".repeat(CONTACT_FIELD_CAPS.salutation);
    const past = "x".repeat(CONTACT_FIELD_CAPS.salutation + 1);
    const [longest] = await handle.db.insert(contacts)
      .values({ firstName: "Jane", salutation: atLimit, pronouns: atLimit }).returning();
    expect(longest).toMatchObject({ salutation: atLimit, pronouns: atLimit });
    // One column over at a time, so the refusal can only have come from the
    // constraint under test -- asserted BY NAME, since a bare 23514 cannot tell the
    // two apart and a shared bound would pass either way round.
    await expect(handle.db.insert(contacts).values({ firstName: "Jane", salutation: past }))
      .rejects.toMatchObject({ cause: { constraint_name: "contacts_salutation_length" } });
    await expect(handle.db.insert(contacts).values({ firstName: "Jane", pronouns: past }))
      .rejects.toMatchObject({ cause: { constraint_name: "contacts_pronouns_length" } });

    // Nothing here is a permitted-value list, so all of these store unchanged --
    // including the accented one, which is a title this repo's ASCII source can only
    // write as an escape and a Dutch or Spanish install types straight in.
    for (const salutation of ["Mr", "Dhr", "Mevr", "Drs", "Ir", "Ing", "Rev", "Sir", "Se\u00f1or"]) {
      const [row] = await handle.db.insert(contacts).values({ firstName: "Jane", salutation }).returning();
      expect(row?.salutation).toBe(salutation);
    }
    for (const pronouns of ["he/him", "she/her", "they/them", "she/they", "hij/hem"]) {
      const [row] = await handle.db.insert(contacts).values({ firstName: "Jane", pronouns }).returning();
      expect(row?.pronouns).toBe(pronouns);
    }

    // Both nullable, and absent by default: a contact created without them has
    // neither, which is the state every pre-v1.1.0 row is in.
    const [bare] = await handle.db.insert(contacts).values({ firstName: "Jane" }).returning();
    expect(bare).toMatchObject({ salutation: null, pronouns: null });
  });
});

// ============================================================================

describe("the duplicate probe's indexes (0013)", () => {
  /** Which of 0013's indexes this database has, by name, sorted. */
  async function indexNames(scratch: DatabaseHandle): Promise<string[]> {
    const rows = await scratch.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('companies_domain_lower_idx', 'contacts_emails_lower_idx')
      ORDER BY indexname
    `);
    return rows.map((row) => row.indexname);
  }

  /** The plan for one query, as one string. */
  async function planFor(scratch: DatabaseHandle, query: Parameters<typeof scratch.db.execute>[0]):
  Promise<string> {
    const rows = await scratch.db.execute<Record<string, string>>(query);
    return rows.map((row) => Object.values(row).join(" ")).join("\n");
  }

  /**
   * THE MIGRATION MEETS A DATABASE THAT ALREADY HAS ROWS IN IT, which is the
   * only state it will ever run in on an install that matters, and the one a
   * fresh `migrate()` in global-setup never exercises.
   *
   * AND IT ASSERTS WHAT THE INDEXES ARE FOR, rather than that they exist. The
   * expression in the migration and the expression in services/import-csv.ts's
   * probe have to be THE SAME EXPRESSION or the index is dead weight -- and a
   * dead index is invisible from a passing import, visible only from a slow
   * one. `enable_seqscan = off` is what makes that assertable on two rows: it
   * does not make the planner lie, it removes the cheaper-than-anything option
   * a tiny table always has, leaving the question "IS there an index scan for
   * this shape at all".
   */
  it("applies migration 0013 to a populated pre-0013 database, and the probe's own questions can use what it built", async () => {
    await withPreMigrationDatabase("0013", async (scratch) => {
      // The old shape, with rows in it -- and mixed case on both keys, because
      // the case fold is the whole reason these indexes are functional ones.
      await scratch.db.execute(sql`
        INSERT INTO companies (name, domain) VALUES ('Acme', 'ACME.example')
      `);
      await scratch.db.execute(sql`
        INSERT INTO contacts (first_name, emails) VALUES ('Ada', ARRAY['Ada@Example.com'])
      `);

      // PIN THE PREMISE. Without this every assertion below would also pass
      // against a database that had been fully migrated all along.
      expect(await indexNames(scratch)).toEqual([]);
      const before = await scratch.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'conduit_lower_emails'
      `);
      expect(before[0]?.n).toBe(0);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      expect(await indexNames(scratch))
        .toEqual(["companies_domain_lower_idx", "contacts_emails_lower_idx"]);
      // The rows an operator already had are still there, unchanged. An index
      // build touches no data, and this is the cheapest possible statement of
      // that for somebody reading a migration that runs against live rows.
      const kept = await scratch.db.execute<{ name: string; domain: string }>(sql`
        SELECT name, domain FROM companies
      `);
      expect(kept).toEqual([{ name: "Acme", domain: "ACME.example" }]);

      // AND THE TWO QUESTIONS THE PROBE ASKS, SHAPED AS IT SHAPES THEM. If
      // either expression drifts from the migration's, the index stops being
      // reachable and this goes red -- which is the only warning there would be.
      //
      // THE `Index Cond` IS THE ASSERTION AND THE INDEX'S NAME IS NOT, which a
      // mutation had to teach this case. With `enable_seqscan = off` the
      // planner will walk ANY index end to end rather than scan the heap, so a
      // btree on `domain` -- an index that answers nothing this query asks --
      // still put `companies_domain_lower_idx` in the plan and the first
      // version of this test went green over it. The condition is what says the
      // index was USED for the question rather than as a cheaper table.
      await scratch.db.execute(sql`SET enable_seqscan = off`);
      const domainPlan = await planFor(scratch, sql`
        EXPLAIN SELECT DISTINCT lower(domain) AS key FROM companies
        WHERE lower(domain) IN ('acme.example')
      `);
      expect(domainPlan).toContain("companies_domain_lower_idx");
      expect(domainPlan).toContain("Index Cond: (lower(domain) = 'acme.example'::text)");
      const emailPlan = await planFor(scratch, sql`
        EXPLAIN SELECT 1 FROM contacts
        WHERE conduit_lower_emails(emails) && ARRAY['ada@example.com']
      `);
      expect(emailPlan).toContain("contacts_emails_lower_idx");
      expect(emailPlan).toContain("Index Cond: (conduit_lower_emails(emails) &&");
      await scratch.db.execute(sql`SET enable_seqscan = on`);

      // The fold itself, since an index is only as good as the function under
      // it: the stored spelling and the probe's candidate meet in the middle.
      const folded = await scratch.db.execute<{ hit: number }>(sql`
        SELECT count(*)::int AS hit FROM contacts
        WHERE conduit_lower_emails(emails) && ARRAY['ada@example.com']
      `);
      expect(folded[0]?.hit).toBe(1);
    });
  }, 30000);
});

describe("mail re-authentication state (0015)", () => {
  /**
   * 0015 REPLACES A CONSTRAINT RATHER THAN ADDING A COLUMN, and that is a
   * different kind of risk from 0014's. `DROP CONSTRAINT` without IF EXISTS
   * fails hard against a table whose constraint is not named exactly
   * `mail_accounts_status_valid` -- and a failed migration is a server that
   * does not boot, on an install that was working a minute earlier. The only
   * honest way to know the name matches what earlier migrations really created
   * is to run the whole chain against a real pre-0015 database, which is what
   * this does.
   *
   * IT ALSO PINS THAT NOTHING MOVES. The new predicate is a strict superset of
   * the old one, so a row that was 'error' before must still be 'error'
   * afterwards -- the migration widens what is legal, it does not reclassify
   * anything.
   */
  it("applies migration 0015 to a real pre-0015 database, keeping existing statuses and admitting the new one", async () => {
    await withPreMigrationDatabase("0015", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const [account] = await scratch.db.insert(mailAccounts).values({
        userId: user!.id, label: "Work", email: "chris@example.com",
        imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
        smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
        username: "chris", credentialsCiphertext: "v1:x:y:z", status: "error",
        lastError: "connection: ECONNREFUSED",
      }).returning();

      // The drill's own premise: before the upgrade the new value really is
      // refused, so the assertion after it is about the migration rather than
      // about a CHECK that never constrained anything.
      await expect(scratch.db.update(mailAccounts)
        .set({ status: "auth_required" }).where(eq(mailAccounts.id, account!.id)))
        .rejects.toMatchObject({
          cause: { message: expect.stringMatching(/mail_accounts_status_valid|check/i) },
        });

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const [reread] = await scratch.db.select().from(mailAccounts)
        .where(eq(mailAccounts.id, account!.id));
      expect(reread).toMatchObject({ status: "error", lastError: "connection: ECONNREFUSED" });

      await scratch.db.update(mailAccounts)
        .set({ status: "auth_required" }).where(eq(mailAccounts.id, account!.id));
      const [after] = await scratch.db.select().from(mailAccounts)
        .where(eq(mailAccounts.id, account!.id));
      expect(after?.status).toBe("auth_required");
    });
  }, 30000);
});

describe("mail auth method (0014)", () => {
  /**
   * THE WHOLE OF PHASE 8'S MIGRATION IS A DEFAULT, and this is the drill that
   * makes that claim mean something. Mirrors 0006's visibility drill exactly,
   * because it is the same mechanism: a row is inserted while the column does
   * not yet exist, and what fills it is the ALTER's DEFAULT rather than any
   * UPDATE anybody wrote.
   *
   * AND IT CARRIES A REAL CREDENTIAL BLOB THROUGH THE UPGRADE. The account
   * seeded below stores a ciphertext written by the PRE-UNION encoder
   * (test/legacy-mail-credentials.ts), and after the migration it is decrypted
   * by the post-union decrypter. That is the end-to-end statement of the thing
   * this task exists to protect: an account that existed on v1.6.0 still hands
   * back its password on v1.7.0 -- the migration did not touch the ciphertext,
   * and the union still reads it.
   */
  it("applies migration 0014 to a real pre-0014 database -- a pre-existing account comes back auth_method 'password' and its old credential blob still decrypts", async () => {
    await withPreMigrationDatabase("0014", async (scratch) => {
      const legacy = LEGACY_PASSWORD_BLOBS[0]!;
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      // Raw SQL naming only the pre-0014 columns (the 0005/0006 old-shape
      // technique): a drizzle insert would now name auth_method, and a row
      // that supplied the value itself could not show the DEFAULT doing
      // anything.
      const [account] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO mail_accounts
          (user_id, label, email, imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security, username, credentials_ciphertext)
        VALUES
          (${user!.id}, 'Work', 'chris@example.com', 'localhost', 993, 'tls',
           'localhost', 587, 'starttls', 'chris', ${legacy.ciphertext})
        RETURNING id
      `);

      // Pin the drill's own premise, exactly as the 0006 drill does: the raw
      // insert above would ALSO succeed against a fully-migrated table (it
      // simply names no auth_method, so the DEFAULT would fire at INSERT
      // time), and 'password' below would then pass without the ALTER proving
      // anything at all.
      const [preState] = await scratch.db.execute<{ present: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'mail_accounts' AND column_name = 'auth_method'
        ) AS present
      `);
      expect(preState?.present).toBe(false);

      // Upgrade: the real, full migrations folder. 0014 is the only pending one.
      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      const [reread] = await scratch.db.select().from(mailAccounts)
        .where(eq(mailAccounts.id, account!.id));
      expect(reread).toMatchObject({
        id: account!.id, email: "chris@example.com", authMethod: "password",
      });
      // Byte-for-byte: the migration is additive and must not have rewritten
      // the one column whose contents nothing but mail.key can reconstruct.
      expect(reread?.credentialsCiphertext).toBe(legacy.ciphertext);
      // And it still decrypts, through the union, to what the old encoder sealed.
      expect(decryptCredentials(Buffer.from(LEGACY_MAIL_KEY_BASE64, "base64"), reread!.credentialsCiphertext))
        .toMatchObject({
          kind: "password",
          imapPassword: legacy.imapPassword,
          smtpPassword: legacy.smtpPassword,
        });
    });
  }, 30000);

  it("defaults a fresh account's auth_method to password", async () => {
    const [account] = await handle.db.insert(mailAccounts)
      .values(accountValues({ email: "fresh-auth@example.com" })).returning();
    expect(account?.authMethod).toBe("password");
  });

  // Mirrors the 0006 block's visibility equivalent: the shared enum and the
  // column's CHECK are two spellings of one list, and a member added to either
  // alone is a value that either cannot be stored or cannot be described.
  it("keeps mailAuthMethodSchema in sync with mail_accounts' auth_method CHECK", async () => {
    expect(mailAuthMethodSchema.options).toEqual(["password", "oauth_microsoft", "oauth_google"]);

    for (const authMethod of mailAuthMethodSchema.options) {
      await handle.db.insert(mailAccounts)
        .values(accountValues({ authMethod, label: authMethod, email: `${authMethod}@example.com` }));
    }
    await expect(
      handle.db.insert(mailAccounts)
        .values(accountValues({ authMethod: "oauth_yahoo", email: "bogus-auth@example.com" })),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/mail_accounts_auth_method_valid|check/i) },
    });
  });

  // The provider is derived from this one column rather than stored beside it,
  // so the derivation is part of the schema's contract, not a UI detail.
  it("derives the provider from the auth method, and null for a password account", () => {
    expect(mailOAuthProviderOf("password")).toBeNull();
    expect(mailOAuthProviderOf("oauth_microsoft")).toBe("microsoft");
    expect(mailOAuthProviderOf("oauth_google")).toBe("google");
  });
});

describe("documents stops being a quote table (0016)", () => {
  /**
   * THE ONE MIGRATION IN THIS PROJECT THAT MOVES ROWS, AND THE ONLY DRILL THAT
   * READS A FIXTURE THE CODE UNDER TEST DID NOT WRITE.
   *
   * 0013 built indexes, 0014 added a defaulted column, 0015 swapped a CHECK.
   * This one lifts eleven columns out of `documents` into `document_quotes` on
   * an install whose rows are quotes already sent to customers, so the question
   * is not "does the schema end up right" -- a fresh migrate() answers that on
   * every run -- but "does an EXISTING quote come out the other side".
   *
   * WHICH IS WHY THE ROWS COME FROM test/legacy-quote-rows.ts. They were written
   * by `issueQuote` as it stood before any Phase 9 edit, against a pre-0016
   * database, and dumped column by column; that file carries the commit and blob
   * hashes. Issuing a quote here with the new writer and reading it back with
   * the new reader would prove only that the new code agrees with itself, which
   * is v1.7.0's credential-union lesson and the whole reason the fixture exists.
   */
  it("moves two real pre-migration quotes into document_quotes, and the new reader returns exactly what the old one returned", async () => {
    await withPreMigrationDatabase("0016", async (scratch) => {
      await replayLegacyQuoteRows(scratch.db);

      // PIN THE PREMISE, AND CHECK THE FIXTURE'S OWN CLAIM IN THE SAME BREATH.
      // The fixture says these are the columns a pre-0016 `documents` had; this
      // is a real pre-0016 catalogue saying so too. Without it every assertion
      // below would also pass against a database that had been fully migrated
      // all along -- and the fixture could have been quietly reshaped to suit
      // whatever the new code wanted to read.
      const preColumns = await scratch.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'
      `);
      expect(preColumns.map((row) => row.column_name).sort()).toEqual(LEGACY_DOCUMENT_COLUMNS);
      const [preTable] = await scratch.db.execute<{ present: number }>(sql`
        SELECT count(*)::int AS present FROM information_schema.tables
        WHERE table_name = 'document_quotes'
      `);
      expect(preTable?.present).toBe(0);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // THE ASSERTION THE WHOLE FIXTURE EXISTS FOR: the new listDocuments, over
      // the new two-table schema, hands back byte for byte what the old
      // listDocuments handed back over the old one-table schema, for rows the
      // old writer wrote. Every moved column, both line orders, the '' that is
      // not a null and the null that is not a '', and a recipient carrying an
      // ampersand, a '<' and two Latin-1 letters.
      expect(await listDocuments(scratch.db, LEGACY_QUOTE_DEAL_ID)).toEqual(LEGACY_QUOTE_LIST);

      // The `documents` half: the deal it was always attached to, kept; the four
      // columns 0016 added, empty -- which is what makes num_nonnulls = 1 true
      // of a pre-existing row -- and `frozen` filled by the ALTER's DEFAULT
      // rather than by any UPDATE, since these rows were inserted while the
      // column did not exist. That is the same hole the 0014 drill closes: it
      // distinguishes "the default fired at UPGRADE" from "the default fired at
      // INSERT".
      const documentRows = await scratch.db.select().from(documents)
        .orderBy(asc(documents.number));
      expect(documentRows).toHaveLength(2);
      for (const row of documentRows) {
        expect(row).toMatchObject({
          type: "quote", dealId: LEGACY_QUOTE_DEAL_ID, frozen: true,
          companyId: null, contactId: null, projectId: null, meetingId: null,
        });
      }
      // ...and nothing of the quote is left behind on it. Spelled as the whole
      // column set rather than as eleven absences, so a column that failed to
      // drop is as visible as one that failed to arrive.
      const postColumns = await scratch.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'
      `);
      expect(postColumns.map((row) => row.column_name).sort()).toEqual([
        "company_id", "contact_id", "created_at", "deal_id", "file_id", "frozen",
        "id", "issue_date", "issued_by_user_id", "meeting_id", "number", "project_id", "type",
      ]);

      // THE PDFs. Content-addressed, so an unchanged sha256 IS the statement
      // that the stored bytes are the same bytes and that nothing re-rendered
      // them -- test/legacy-quote-rows.ts has the argument for why the bytes
      // themselves are not committed. Asserted against the `files` rows AND
      // against documents.file_id, because a migration could in principle leave
      // the files table alone and repoint the document at a different row.
      const fileRows = await scratch.db.select().from(files).orderBy(asc(files.originalName));
      expect(fileRows.map((row) => ({
        fileId: row.id, originalName: row.originalName,
        sha256: row.sha256, sizeBytes: row.sizeBytes,
      }))).toEqual(LEGACY_QUOTE_PDFS.map(({ pages: _pages, ...rest }) => rest));
      expect(documentRows.map((row) => row.fileId).sort())
        .toEqual(LEGACY_QUOTE_PDFS.map((pdf) => pdf.fileId).sort());

      // The lines were never touched -- document_line_items points at
      // documents(id), which did not move -- and the number sequence still says
      // the next quote of 2026 is the third, so an operator's numbering does not
      // restart under them.
      expect(await scratch.db.select().from(documentLineItems)).toHaveLength(4);
      expect(await scratch.db.select().from(documentNumberSequences))
        .toEqual([{ type: "quote", year: 2026, lastValue: 2 }]);
    });
  }, 30000);

  /**
   * THE CHECK THAT WOULD HAVE SHIPPED A MIGRATION THAT NEVER RUNS.
   *
   * drizzle applies a migration only when `lastDbMigration.created_at <
   * migration.folderMillis` (drizzle-orm/pg-core/dialect.js), reading the ONE
   * newest applied row -- so the journal's `when` values are not decoration,
   * they ARE the ordering, and an entry whose `when` is lower than the newest
   * applied one is silently skipped on every database that already has its
   * predecessor. Not an error, not a warning: the table simply is not there.
   *
   * `drizzle-kit generate` stamps `when` from the wall clock, while entries 0013
   * onwards were given round numbers by hand -- 1788600000000, 1788700000000,
   * 1788800000000 -- all of which are in the FUTURE relative to that clock. 0016
   * generated as 1788663974827, between 0013's and 0014's, and would have been
   * skipped on every install in existence. It was caught by reading the
   * migrator, and nothing in this suite would have caught it: global-setup
   * migrates a fresh database in one pass, where the same skip leaves the same
   * absent table and every resulting failure blames the schema.
   */
  it("keeps the migration journal's `when` values strictly increasing, which is what makes drizzle apply them", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThan(0);

    // NEIGHBOUR BY NEIGHBOUR rather than by sorting, and reported by NAME: a
    // sorted comparison says only that something is wrong, and this has to say
    // which migration, because the answer is to edit that one entry.
    const outOfOrder = journal.entries
      .filter((entry, i) => i > 0 && entry.when <= journal.entries[i - 1]!.when)
      .map((entry) => `${entry.tag} (when ${String(entry.when)})`);
    expect(outOfOrder).toEqual([]);
    // ...and the array order really is the idx order, or the neighbour test
    // above would be comparing each entry against the wrong predecessor.
    expect(journal.entries.map((entry) => entry.idx))
      .toEqual(journal.entries.map((_entry, i) => i));
  });
});

describe("the meeting summary (0017)", () => {
  /**
   * A meeting, plus the file a document needs, in the shape 0017 makes
   * possible: the file hangs off the MEETING, which is the fifth parent
   * `files_exactly_one_entity` gained.
   */
  async function seedSummaryParents(): Promise<{ meetingId: string; fileId: string }> {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [meeting] = await handle.db.insert(meetings).values({
      title: "Kickoff", occurredAt: new Date("2026-09-01T09:00:00Z"),
      ownerUserId: userId, companyId: company.id,
    }).returning();
    const [file] = await handle.db.insert(files).values({
      originalName: "Meeting summary - Kickoff - 2026-09-06.pdf", mime: "application/pdf",
      sizeBytes: 14_565, sha256: "c".repeat(64), uploaderUserId: userId, meetingId: meeting!.id,
    }).returning();
    return { meetingId: meeting!.id, fileId: file!.id };
  }

  function summaryValues(
    parents: { meetingId: string; fileId: string },
    overrides: Partial<typeof documents.$inferInsert> = {},
  ) {
    return {
      // Spelled `null` and `false` rather than asked of documentTypeNumbered /
      // documentTypeFreezes, for documentValues' reason: a fixture that asked the
      // code under test what to expect could never disagree with it.
      number: null, frozen: false,
      type: "meeting_summary", meetingId: parents.meetingId, fileId: parents.fileId,
      issueDate: "2026-09-06", issuedByUserId: userId, ...overrides,
    } satisfies typeof documents.$inferInsert;
  }

  /**
   * EVERY merge token the seeded meeting summary template contains, as an
   * EQUALITY in both directions -- 0009's SEEDED_FIELDS, one type on. A token
   * the resolver does not supply renders as a silent blank on a printed page,
   * and a context key the template stopped naming is built for nothing.
   *
   * THE OPTIONAL ONES OWE A CONDITIONAL, exactly as the quote's do: an install
   * that never uploaded a logo must not print `<img src="">`, and a meeting with
   * no duration recorded must not print the word Duration over a blank.
   *
   * `attendees` AND `document.notes` ARE THE TWO THIS TYPE ADDS, and both are
   * wrapped in BOTH block forms -- `{{#...}}` for the content and `{{^...}}` for
   * a sentence saying there was none -- because a meeting with no attendees
   * recorded and a meeting with no notes are both completely ordinary, and a
   * heading standing over nothing is what you get otherwise.
   */
  const SUMMARY_OPTIONAL = [
    "org.logoDataUri", "org.addressLines", "org.email", "org.phone", "org.website",
    "document.duration",
  ];
  const SUMMARY_FIELDS = [
    "{{org.name}}",
    "{{document.title}}", "{{document.meetingWhen}}", "{{document.issueDate}}",
    // The repeated collection, its inverse, and the one field an attendee has.
    "{{#attendees}}", "{{^attendees}}", "{{/attendees}}", "{{name}}",
    // The raw-HTML field, in both block forms.
    "{{#document.notes}}", "{{^document.notes}}", "{{document.notes}}", "{{/document.notes}}",
    ...SUMMARY_OPTIONAL.flatMap((path) => [`{{#${path}}}`, `{{${path}}}`, `{{/${path}}}`]),
  ].sort();

  /**
   * THE UPGRADE DRILL, AND WHAT IT IS AND IS NOT.
   *
   * 0016 moved live rows and its drill therefore replays a fixture written by
   * the PRE-migration code. This one moves none: every statement is a catalogue
   * change, a metadata-only ADD COLUMN, or one INSERT. So the questions are
   * narrower and there are exactly four of them -- does an existing quote still
   * satisfy the two new CHECKs, does the redundant `type` column get filled on
   * EXISTING document_quotes rows, does an existing `files` row survive a
   * widened exactly-one, and does the second template arrive.
   *
   * THE SECOND IS THE ONE THAT NEEDS A DRILL RATHER THAN A UNIT TEST, and it is
   * 0014's distinction: a DEFAULT that fires at INSERT proves nothing about a
   * row that already existed. The rows below are inserted while the column does
   * not exist, so `'quote'` can only have arrived from the ALTER.
   */
  it("applies migration 0017 to a real pre-0017 database -- an existing quote keeps its number and gains a 'quote' detail type, an existing file survives the widened exactly-one, and the summary template is seeded", async () => {
    await withPreMigrationDatabase("0017", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const company = await createCompany(scratch.db, user!.id, { name: "Acme" });
      const pipeline = await createPipeline(scratch.db, user!.id, { name: "Sales", scope: "global" });
      const stage = await createStage(scratch.db, user!.id, pipeline.id, { name: "New" });
      const deal = await createDeal(
        scratch.db, user!.id, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
      );
      // RAW SQL, NOT `insert(files)`, and the reason is the standing hazard of
      // every drill in this file: schema.ts describes TODAY's shape, so a drizzle
      // insert names `files.meeting_id` -- the column this very migration adds --
      // against a database that does not have it yet. The same edit had to be
      // made to the 0011 drill, which went red on exactly that.
      const [file] = await scratch.db.execute<{ id: string }>(sql`
        INSERT INTO files (original_name, mime, size_bytes, sha256, uploader_user_id, deal_id)
        VALUES ('QUO-2026-0001.pdf', 'application/pdf', 16003, ${"d".repeat(64)},
                ${user!.id}, ${deal.id})
        RETURNING id
      `);
      const [document] = await scratch.db.insert(documents).values({
        number: "QUO-2026-0001", type: "quote", dealId: deal.id, fileId: file!.id,
        issueDate: "2026-08-28", frozen: true, issuedByUserId: user!.id,
      }).returning();
      // Raw SQL for the same reason as the file above -- `insert(documentQuotes)`
      // names the `type` column this migration is about to add. `documents` needs
      // no such treatment: 0017 changes its column SHAPE (number stops being NOT
      // NULL) and adds none, so today's insert names only columns a pre-0017
      // database already has.
      await scratch.db.execute(sql`
        INSERT INTO document_quotes (document_id, currency, recipient_name,
                                     subtotal_cents, tax_cents, total_cents)
        VALUES (${document!.id}, 'EUR', 'Acme', 11000, 2100, 13100)
      `);

      // PIN THE PREMISE. Without these, every assertion below would also pass
      // against a database that had been fully migrated all along -- and the
      // columns this migration adds are exactly the ones whose absence has to be
      // true beforehand for the drill to mean anything.
      const before = await scratch.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE (table_name = 'document_quotes' AND column_name = 'type')
           OR (table_name = 'files' AND column_name = 'meeting_id')
      `);
      expect(before).toEqual([]);
      const [beforeNotNull] = await scratch.db.execute<{ is_nullable: string }>(sql`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name = 'number'
      `);
      expect(beforeNotNull?.is_nullable).toBe("NO");

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // 1 and 2. The quote is untouched and now carries the redundant type that
      // makes the composite key possible -- filled by the ALTER's DEFAULT, on a
      // row inserted before the column existed.
      const [quoteAfter] = await scratch.db.select().from(documentQuotes);
      expect(quoteAfter).toMatchObject({ documentId: document!.id, type: "quote", currency: "EUR" });
      const [documentAfter] = await scratch.db.select().from(documents);
      expect(documentAfter).toMatchObject({ number: "QUO-2026-0001", type: "quote", frozen: true });

      // 3. The pre-existing file satisfies the widened CHECK with its new column
      // empty, which is what makes num_nonnulls(...) = 1 still true of it.
      const [fileAfter] = await scratch.db.select().from(files);
      expect(fileAfter).toMatchObject({ dealId: deal.id, meetingId: null });

      // 4. The second template, byte for byte what test/seed-template.ts derives
      // from the migration file -- which is what keeps every suite that seeds its
      // own copy honest about what a fresh install really holds.
      const [template] = await scratch.db.select().from(documentTemplates)
        .where(eq(documentTemplates.type, "meeting_summary"));
      expect(template?.bodyHtml).toBe(seededMeetingSummaryTemplate());
      expect([...new Set((template?.bodyHtml ?? "").match(/\{\{[^}]*\}\}/g) ?? [])].sort())
        .toEqual(SUMMARY_FIELDS);
      // The quote's template is still there and still its own: widening the type
      // CHECK must not have disturbed the row 0009 seeded and 0011 amended.
      const [quoteTemplate] = await scratch.db.select().from(documentTemplates)
        .where(eq(documentTemplates.type, "quote"));
      expect(quoteTemplate?.bodyHtml).toBe(seededQuoteTemplate());

      // The index 0016 deferred, built by the migration whose read needs it.
      // Asserted NOT unique and NOT partial: a meeting has many summaries and
      // every one of them must be found.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'documents'`,
      );
      const meetingIndex = indexes.find((row) => row.indexname === "documents_meeting_idx");
      expect(meetingIndex?.indexdef).toMatch(/\(meeting_id\)/i);
      expect(meetingIndex?.indexdef).not.toMatch(/UNIQUE/i);
      expect(meetingIndex?.indexdef).not.toMatch(/WHERE/i);
      // ...and of the other three FKs 0016 added, exactly the two whose READS
      // arrived in Task 3 are indexed.
      //
      // **THIS ASSERTION USED TO BE `toEqual([])` AND TASK 3 BROKE IT, WHICH IS
      // THE DRILL WORKING.** The drill migrates to HEAD, so it sees every later
      // migration's indexes; 0016's rule was never "these three stay unindexed"
      // but "an index arrives with the read that needs it", and 0017's own
      // comment named the schedule -- "company and contact with the NDA, project
      // with the status report". The letter and the agreements are those reads,
      // so `documents_company_idx` and `documents_contact_idx` are here and
      // `documents_project_idx` is not. Rewritten as the rule rather than as a
      // count, so Task 4 changes one line and the sentence stays true.
      //
      // **AND TASK 4 CHANGED THAT ONE LINE, WHICH COMPLETES THE SET.** 0020's
      // `listProjectDocuments` is the read 0017 was predicting, so the third
      // index is here now and all five of 0016's record foreign keys are indexed
      // -- each by the migration that added its first SELECT, which is the
      // discipline rather than a coincidence.
      expect(indexes.map((row) => row.indexname)
        .filter((name) => /company|contact|project/.test(name)).sort())
        .toEqual(["documents_company_idx", "documents_contact_idx", "documents_project_idx"]);

      // A PRE-EXISTING MEETING CAN BE SUMMARISED, which is the point of the
      // whole upgrade rather than a property of a fresh install.
      const [meeting] = await scratch.db.insert(meetings).values({
        title: "Kickoff", occurredAt: new Date("2026-09-01T09:00:00Z"),
        ownerUserId: user!.id, companyId: company.id,
      }).returning();
      const [summaryFile] = await scratch.db.insert(files).values({
        originalName: "Meeting summary - Kickoff - 2026-09-06.pdf", mime: "application/pdf",
        sizeBytes: 9000, sha256: "e".repeat(64), uploaderUserId: user!.id, meetingId: meeting!.id,
      }).returning();
      const [summary] = await scratch.db.insert(documents).values({
        number: null, type: "meeting_summary", meetingId: meeting!.id, fileId: summaryFile!.id,
        issueDate: "2026-09-06", frozen: false, issuedByUserId: user!.id,
      }).returning();
      expect(summary).toMatchObject({ number: null, frozen: false, dealId: null, companyId: null });

      // AND THE COMPOSITE KEY EARNS ITS KEEP HERE AND NOWHERE EARLIER: a quote
      // detail row naming that summary is now unspellable. This is the assertion
      // 0016 could not have written, because there was no non-quote document to
      // point one at.
      await expect(scratch.db.insert(documentQuotes).values({
        documentId: summary!.id, currency: "EUR", recipientName: "Acme",
        subtotalCents: 1, taxCents: 0, totalCents: 1,
      })).rejects.toMatchObject({
        cause: {
          code: "23503",
          message: expect.stringContaining("document_quotes_document_id_type_fk"),
        },
      });
    });
  }, 30000);

  /**
   * THE RULE `NOT NULL` COULD NOT STATE. Dropping documents.number's NOT NULL is
   * what lets an unnumbered type exist at all, and on its own that would also
   * permit an unnumbered QUOTE -- so the CHECK has to say both halves. The second
   * half is the one nothing forbade before, because before there was no type that
   * should not have a number.
   */
  it("enforces documents_number_matches_type in both directions", async () => {
    const quoteParents = await seedDocumentParents();
    const summaryParents = await seedSummaryParents();

    // The two shapes that are right.
    const [quote] = await handle.db.insert(documents)
      .values(documentValues(quoteParents, { number: "QUO-2026-0001" })).returning();
    expect(quote?.number).toBe("QUO-2026-0001");
    const [summary] = await handle.db.insert(documents)
      .values(summaryValues(summaryParents)).returning();
    expect(summary?.number).toBeNull();

    // A quote with no number -- what NOT NULL used to refuse, and must still be.
    await expect(handle.db.insert(documents).values(
      documentValues(quoteParents, { number: null }),
    )).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("documents_number_matches_type") },
    });

    // A numbered meeting summary -- what NOT NULL never could have refused, and
    // exactly what formatDocumentNumber's `?? "DOC"` fallback would have minted.
    await expect(handle.db.insert(documents).values(
      summaryValues(summaryParents, { number: "DOC-2026-0001" }),
    )).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("documents_number_matches_type") },
    });
  });

  /**
   * The documentTypeFreezes/documents_frozen_matches_type pair, one rule over.
   * DRIVEN OFF THE ENUM for the same reason: a type added in Task 3 or 4 without
   * a numbering decision arrives here rather than being noticed on a printed
   * page.
   */
  it("keeps documentTypeNumbered in step with documents_number_matches_type, for every type", async () => {
    const parents = await seedDocumentParents();
    for (const [index, type] of documentTypeSchema.options.entries()) {
      const numbered = documentTypeNumbered(type);
      // **EACH TYPE IS INSERTED AGAINST THE PARENT ITS OWN WRITER WOULD USE, AND
      // SINCE 0020 THAT IS THE DATABASE'S OPINION RATHER THAN THIS TEST'S.** The
      // sentence this replaces said the same thing -- "so this cannot pass by
      // accident of documents_exactly_one_entity" -- and enforced it by hand,
      // with a `type === "quote" ? ... : ...` that put all four of Task 3's types
      // on a MEETING. That was invisible while nothing checked, and
      // `documents_entity_matches_type` is what turned it into a refused row.
      const base = documentValues(parents, ownerForType(type, parents));
      const [row] = await handle.db.insert(documents).values({
        ...base, type, frozen: documentTypeFreezes(type),
        number: numbered ? `NUM-2026-70${index}` : null,
      }).returning();
      expect(row?.number === null).toBe(!numbered);

      await expect(handle.db.insert(documents).values({
        ...base, type, frozen: documentTypeFreezes(type),
        number: numbered ? null : `NUM-2026-79${index}`,
      })).rejects.toMatchObject({
        cause: { code: "23514", message: expect.stringContaining("documents_number_matches_type") },
      });
    }
  });

  /**
   * **THE THIRD ENFORCEMENT, AND IT IS AN ABSENCE.**
   * `document_number_sequences_type_valid` used to be "the same enum
   * documents.type carries" and is not any more: it is the list of types that
   * are NUMBERED, which is narrower. A writer that called allocateNumber for a
   * summary fails here rather than starting a private `DOC-2026-` series.
   *
   * Pinned against documentTypeNumbered so nobody "fixes" the CHECK back into
   * agreement with documents_type_valid, which would look like tidying up.
   */
  it("admits exactly the numbered types into document_number_sequences", async () => {
    for (const type of documentTypeSchema.options) {
      const insert = handle.db.insert(documentNumberSequences)
        .values({ type, year: 2026, lastValue: 1 });
      if (documentTypeNumbered(type)) {
        await expect(insert).resolves.toBeDefined();
      } else {
        await expect(insert).rejects.toMatchObject({
          cause: {
            code: "23514",
            message: expect.stringContaining("document_number_sequences_type_valid"),
          },
        });
      }
    }
  });

  /**
   * The other half of the composite key: it must still ACCEPT the row it was
   * always meant to. A constraint that refuses everything passes the refusal
   * test in the drill above and breaks every quote.
   */
  it("still admits a quote's own detail row through the composite key, and pins its type", async () => {
    const parents = await seedDocumentParents();
    const [document] = await handle.db.insert(documents).values(documentValues(parents)).returning();
    const [quote] = await handle.db.insert(documentQuotes)
      .values(quoteValues(document!.id)).returning();
    // Written by nobody and filled by the DEFAULT, which is what makes the column
    // a constant rather than a field a writer has to remember.
    expect(quote?.type).toBe("quote");

    // ...and it cannot be anything else, so the key can only ever mean "this
    // detail row describes a document whose type is quote".
    //
    // **PROBED ON THE INSERT SINCE 0019, AND THE REASON IS A REAL INTERACTION
    // WORTH RECORDING.** This used to be an UPDATE, and the UPDATE now fails for
    // a DIFFERENT reason: `conduit_document_frozen_guard` fires BEFORE the row
    // is checked, so on a quote -- which is frozen -- the trigger refuses first
    // and `document_quotes_type_is_quote` is never consulted. Both are 23514, so
    // the old assertion went red on the constraint NAME rather than on the
    // refusal, which is exactly the distinction that had to be noticed.
    //
    // The CHECK is not dead, and this is where that is proved: nothing guards an
    // INSERT (the trigger is BEFORE UPDATE OR DELETE), so the insert path is
    // both the one a writer can reach and the one that exercises the CHECK.
    // The UPDATE is asserted below as well, because "a quote's detail row cannot
    // be retyped" is the claim, and which of the two guards refuses it is an
    // implementation detail the claim should survive.
    const [other] = await handle.db.insert(documents)
      .values(documentValues(parents, { number: "QUO-2026-7001" })).returning();
    await expect(handle.db.execute(sql`
      INSERT INTO document_quotes (document_id, type, currency, recipient_name,
                                   subtotal_cents, tax_cents, total_cents)
      VALUES (${other!.id}, 'meeting_summary', 'EUR', 'Acme', 100, 21, 121)
    `)).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("document_quotes_type_is_quote") },
    });

    await expect(handle.db.execute(sql`
      UPDATE document_quotes SET type = 'meeting_summary' WHERE document_id = ${document!.id}
    `)).rejects.toMatchObject({
      cause: {
        code: "23514", message: expect.stringContaining("documents_frozen_is_immutable"),
      },
    });
  });

  /**
   * `files` gained a fifth parent, and the CHECK has to have moved with it: the
   * whole point is that a rendered summary can live on its meeting, and the
   * whole risk of a re-added CHECK is that it counts the wrong columns.
   */
  it("accepts a file attached to exactly one of the five, and refuses none or two", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [meeting] = await handle.db.insert(meetings).values({
      title: "Kickoff", occurredAt: new Date("2026-09-01T09:00:00Z"),
      ownerUserId: userId, companyId: company.id,
    }).returning();
    const base = {
      originalName: "s.pdf", mime: "application/pdf", sizeBytes: 10,
      sha256: "f".repeat(64), uploaderUserId: userId,
    };

    const [onMeeting] = await handle.db.insert(files)
      .values({ ...base, meetingId: meeting!.id }).returning();
    expect(onMeeting).toMatchObject({ meetingId: meeting!.id, companyId: null, dealId: null });

    for (const overrides of [{}, { companyId: company.id, meetingId: meeting!.id }]) {
      await expect(handle.db.insert(files).values({ ...base, ...overrides }))
        .rejects.toMatchObject({
          cause: { code: "23514", message: expect.stringContaining("files_exactly_one_entity") },
        });
    }

    // The foreign key, which is the other half of "attached to a meeting":
    // without it the column would accept any uuid at all.
    await expect(handle.db.insert(files).values({ ...base, meetingId: randomUUID() }))
      .rejects.toMatchObject({ cause: { code: "23503" } });
  });

  /**
   * The five record columns of `documents` are the summary's own half of
   * exactly-one, and a summary is the first type that exercises a column other
   * than deal_id. Separate from the 0009 block's exactly-one test, which proves
   * the CHECK counts five; this proves the WRITER's shape is one of them.
   */
  it("attaches a meeting summary to its meeting and to nothing else", async () => {
    const parents = await seedSummaryParents();
    const [summary] = await handle.db.insert(documents).values(summaryValues(parents)).returning();
    expect(summary).toMatchObject({
      type: "meeting_summary", meetingId: parents.meetingId,
      companyId: null, contactId: null, dealId: null, projectId: null,
    });

    const dealParents = await seedDocumentParents();
    await expect(handle.db.insert(documents).values(
      summaryValues(parents, { dealId: dealParents.dealId }),
    )).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("documents_exactly_one_entity") },
    });
  });
});

describe("the organisation's timezone (0018)", () => {
  /**
   * **THE UPGRADE DRILL, AND ITS ONE QUESTION IS THE BACKFILL.**
   *
   * 0018 adds a column and a CHECK and moves no rows, so unlike 0016 it needs no
   * pre-migration fixture. What it does need proving is 0014's distinction, which
   * is the one that has caught something before: a DEFAULT that fires on INSERT
   * says nothing whatever about a row that already exists. `org_profile` has
   * exactly one row on Chris's install, that row was written before this column
   * was declared, and 'UTC' can only have reached it from the ALTER.
   *
   * THE PREMISE IS PINNED FIRST. Without the catalogue check below, every
   * assertion here would pass just as happily against a database that had been
   * fully migrated all along, which is the failure mode a drill exists for.
   */
  it("applies migration 0018 to a real pre-0018 database -- the row that already existed gains UTC", async () => {
    await withPreMigrationDatabase("0018", async (scratch) => {
      // RAW SQL, NOT `insert(orgProfile)`, and it is this file's standing hazard:
      // schema.ts describes TODAY's shape, so a drizzle insert would name
      // `time_zone` against a database that does not have it yet. The 0011 and
      // 0017 drills both went red on exactly that.
      await scratch.db.execute(sql`
        INSERT INTO org_profile (id, name, address_lines, vat_number)
        VALUES (1, 'Listerdale Life Sciences', '1 High St', 'NL001234567B01')
      `);

      const before = await scratch.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'org_profile' AND column_name = 'time_zone'
      `);
      expect(before).toEqual([]);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // THE BACKFILL, ON A ROW THAT PREDATES THE COLUMN. This is the whole drill.
      const [row] = await scratch.db.select().from(orgProfile);
      expect(row?.timeZone).toBe(DEFAULT_TIME_ZONE);
      // ...and the rest of the profile is untouched, which is the other half of
      // "an existing install survives".
      expect(row?.name).toBe("Listerdale Life Sciences");
      expect(row?.vatNumber).toBe("NL001234567B01");

      // The CHECK really arrived, and it validated rather than being declared NOT
      // VALID over the existing row.
      await expect(scratch.db.execute(
        sql`UPDATE org_profile SET time_zone = '+02:00' WHERE id = 1`,
      )).rejects.toMatchObject({ cause: { constraint_name: "org_profile_time_zone_shape" } });
    });
  }, 30000);

  /**
   * **THE COLUMN'S DEFAULT AND THE CODE'S CONSTANT ARE THE SAME STRING, AND
   * NOTHING BUT THIS SAYS SO.** schema.ts cannot import from `@conduit/shared`
   * (drizzle-kit reads it outside the workspace's resolution), so `'UTC'` is
   * written out there and `DEFAULT_TIME_ZONE` here. A drift between them is
   * invisible in every other test: `emptyProfile` would hand back one value and a
   * freshly defaulted row the other, and the difference surfaces as a document
   * whose time moved by hours after somebody first saved the Settings form.
   *
   * READ OUT OF THE CATALOGUE rather than by inserting a row and looking, so it is
   * the DECLARED default being compared and not the outcome of some path that
   * might have supplied a value of its own.
   */
  it("declares the same default the code believes in", async () => {
    const [column] = await handle.db.execute<{ column_default: string | null }>(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'org_profile' AND column_name = 'time_zone'
    `);
    expect(column?.column_default).toBe(`'${DEFAULT_TIME_ZONE}'::text`);
  });

  /**
   * WHAT A SHAPE CHECK CAN AND CANNOT DO, asserted rather than described. It
   * cannot know whether a name is a real zone -- that is `timeZoneProblem`'s job,
   * over tzdata a `text` column has no access to -- so this pins the two things it
   * CAN refuse, and that it refuses no real name.
   */
  it("refuses the shapes that are wrong by inspection and admits every real name", async () => {
    for (const bad of ["", " ", "+02:00", "-05:00", "Europe/Amsterdam ", "x".repeat(65)]) {
      await expect(handle.db.execute(
        sql`INSERT INTO org_profile (id, name, time_zone) VALUES (1, 'X', ${bad})`,
      ), JSON.stringify(bad)).rejects.toMatchObject({
        cause: { constraint_name: "org_profile_time_zone_shape" },
      });
    }
    // EVERY zone the platform lists, plus the default, against the CHECK's own
    // predicate -- so a regex tightened by one character cannot make a value the
    // picker offers unstorable. One round trip rather than 419.
    const all = [DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")];
    expect(all.length).toBeGreaterThan(100);
    // ONE TEXT PARAMETER SPLIT IN THE DATABASE, not a JS array bound directly:
    // drizzle turns an array parameter into a record tuple, and `unnest` then
    // fails with "cannot cast type record to text[]". No zone name contains a
    // comma, and the count below would fall short if one ever did.
    const [ok] = await handle.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM unnest(string_to_array(${all.join(",")}, ',')) AS z
      WHERE z ~ '^[A-Za-z][A-Za-z0-9_+/-]*$' AND char_length(z) <= 64
    `);
    expect(ok?.n).toBe(all.length);
  });
});

/* ========================================================================== *
 *  THE LETTER AND THE AGREEMENTS (0019)
 * ========================================================================== */

describe("the letter and the agreements (0019)", () => {
  /** A company, and the file a document attached to it needs. */
  async function seedCompanyParents(): Promise<{ companyId: string; fileId: string }> {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [file] = await handle.db.insert(files).values({
      originalName: "Letter - Acme - 2026-09-06.pdf", mime: "application/pdf",
      sizeBytes: 9001, sha256: "b".repeat(64), uploaderUserId: userId, companyId: company.id,
    }).returning();
    return { companyId: company.id, fileId: file!.id };
  }

  function letterValues(
    parents: { companyId: string; fileId: string },
    overrides: Partial<typeof documents.$inferInsert> = {},
  ) {
    return {
      // Spelled `null` and `false`, not asked of documentTypeNumbered /
      // documentTypeFreezes -- documentValues' reason: a fixture that asked the
      // code under test what to expect could never disagree with it.
      number: null, frozen: false,
      type: "letter", companyId: parents.companyId, fileId: parents.fileId,
      issueDate: "2026-09-06", issuedByUserId: userId, ...overrides,
    } satisfies typeof documents.$inferInsert;
  }

  function agreementValues(
    parents: { companyId: string; fileId: string },
    overrides: Partial<typeof documents.$inferInsert> = {},
  ) {
    return {
      number: "NDA-2026-0001", frozen: true,
      type: "nda", companyId: parents.companyId, fileId: parents.fileId,
      issueDate: "2026-09-06", issuedByUserId: userId, ...overrides,
    } satisfies typeof documents.$inferInsert;
  }

  /**
   * EVERY merge token the seeded letter template contains, as an EQUALITY in
   * both directions -- 0009's SEEDED_FIELDS and 0017's SUMMARY_FIELDS, one task
   * on. A token the resolver does not supply renders as a silent blank on a
   * printed page; a context key the template stopped naming is built for nothing.
   *
   * THE GREETING IS THE ONE THAT OWES BOTH BLOCK FORMS. A letter to a company
   * with no named contact is ordinary, and "Dear ," is what you get if the
   * conditional is left out -- 0009's logo lesson for the third time.
   */
  const LETTER_OPTIONAL = [
    "org.logoDataUri", "org.addressLines", "org.email", "org.phone", "org.website",
    "document.subject", "document.recipientContactName", "document.recipientAddress",
  ];
  const LETTER_FIELDS = [
    "{{org.name}}", "{{document.issueDate}}", "{{document.recipientName}}",
    // The raw-HTML field. NAMED `body` AND NOT `bodyHtml`: the merge path is what
    // an operator types into a template, and the column name is not their problem.
    "{{document.body}}",
    // The salutation, in BOTH forms, plus its own value.
    "{{#document.recipientSalutation}}", "{{^document.recipientSalutation}}",
    "{{document.recipientSalutation}}", "{{/document.recipientSalutation}}",
    ...LETTER_OPTIONAL.flatMap((path) => [`{{#${path}}}`, `{{${path}}}`, `{{/${path}}}`]),
  ].sort();

  const AGREEMENT_FIELD_TOKENS_OPTIONAL = [
    "org.logoDataUri", "org.addressLines",
    "document.partyContactName", "document.partyAddress",
  ];
  const AGREEMENT_FIELD_TOKENS = [
    "{{org.name}}", "{{document.number}}", "{{document.issueDate}}",
    "{{document.effectiveDate}}", "{{document.term}}", "{{document.jurisdiction}}",
    "{{document.partyName}}",
    ...AGREEMENT_FIELD_TOKENS_OPTIONAL.flatMap((p) => [`{{#${p}}}`, `{{${p}}}`, `{{/${p}}}`]),
  ].sort();

  /**
   * **THE UPGRADE DRILL.** 0019 moves no rows -- every statement is a catalogue
   * change, a CREATE or an INSERT -- so the questions are the ones a catalogue
   * change raises: does the quote that was already there still satisfy three
   * widened CHECKs, do the three templates arrive, do the two indexes get built,
   * and does the guard exist and refuse the row it is for.
   *
   * THE LAST ONE IS WHY THIS DRILL MATTERS MORE THAN 0017'S. The trigger is the
   * only object in this migration whose absence would be SILENT: every CHECK
   * widening is visible the moment somebody inserts a letter, and a missing
   * template is a 409 at issue. A trigger that was never created looks exactly
   * like one that never fires -- which is also what a correctly behaving guard
   * looks like, every day, on every install.
   */
  it("applies migration 0019 to a real pre-0019 database -- the existing quote is untouched, three templates arrive, both indexes are built, and the frozen guard refuses to change it", async () => {
    await withPreMigrationDatabase("0019", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const company = await createCompany(scratch.db, user!.id, { name: "Acme" });
      const pipeline = await createPipeline(scratch.db, user!.id, { name: "Sales", scope: "global" });
      const stage = await createStage(scratch.db, user!.id, pipeline.id, { name: "New" });
      const deal = await createDeal(
        scratch.db, user!.id, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
      );
      const [file] = await scratch.db.insert(files).values({
        originalName: "QUO-2026-0001.pdf", mime: "application/pdf", sizeBytes: 16_003,
        sha256: "d".repeat(64), uploaderUserId: user!.id, dealId: deal.id,
      }).returning();
      const [document] = await scratch.db.insert(documents).values({
        number: "QUO-2026-0001", type: "quote", dealId: deal.id, fileId: file!.id,
        issueDate: "2026-08-28", frozen: true, issuedByUserId: user!.id,
      }).returning();
      await scratch.db.insert(documentQuotes).values({
        documentId: document!.id, currency: "EUR", recipientName: "Acme",
        subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100,
      });

      // PIN THE PREMISE, or every assertion below would also pass against a
      // database that had been fully migrated all along.
      const beforeTables = await scratch.db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('document_letters', 'document_agreements')
      `);
      expect(beforeTables).toEqual([]);
      const beforeTriggers = await scratch.db.execute<{ tgname: string }>(sql`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      `);
      expect(beforeTriggers).toEqual([]);
      // **AND THE PRE-0019 QUOTE REALLY IS UPDATABLE**, which is exactly what
      // stops being true a few lines down. Without this the guard's assertions
      // would be satisfied by a database in which nothing was ever updatable --
      // and the whole claim of this task is that ONE migration changed that.
      await scratch.db.execute(sql`
        UPDATE documents SET issue_date = '2026-08-29' WHERE id = ${document!.id}
      `);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // 1. The quote is untouched, and still satisfies all three widened CHECKs.
      const [after] = await scratch.db.select().from(documents);
      expect(after).toMatchObject({
        number: "QUO-2026-0001", type: "quote", frozen: true, issueDate: "2026-08-29",
        fileId: file!.id,
      });
      const [quoteAfter] = await scratch.db.select().from(documentQuotes);
      expect(quoteAfter).toMatchObject({ type: "quote", currency: "EUR", totalCents: 13_100 });

      // 2. **THE GUARD.** The same UPDATE that succeeded above is now refused, and
      // so is the DELETE, and so is a change to the money.
      const refused = {
        code: "23514", message: expect.stringContaining("documents_frozen_is_immutable"),
      };
      await expect(scratch.db.execute(sql`
        UPDATE documents SET issue_date = '2026-08-30' WHERE id = ${document!.id}
      `)).rejects.toMatchObject({ cause: refused });
      await expect(scratch.db.execute(sql`
        UPDATE document_quotes SET total_cents = 1 WHERE document_id = ${document!.id}
      `)).rejects.toMatchObject({ cause: refused });
      await expect(scratch.db.execute(sql`DELETE FROM documents WHERE id = ${document!.id}`))
        .rejects.toMatchObject({ cause: refused });
      // ...and the row really is still what it was, which is the difference
      // between a refusal and an error raised after the damage.
      const [stillThere] = await scratch.db.select().from(documents);
      expect(stillThere).toMatchObject({ number: "QUO-2026-0001", issueDate: "2026-08-29" });

      // 3. Three more templates, byte for byte what test/seed-template.ts derives
      // from the migration file -- which is what keeps every suite that seeds its
      // own copy honest about what a fresh install really holds.
      const templates = await scratch.db.select().from(documentTemplates)
        .orderBy(asc(documentTemplates.type));
      expect(templates.map((row) => row.type)).toEqual([...documentTypeSchema.options].sort());
      const bodyOf = (type: string) => templates.find((row) => row.type === type)?.bodyHtml ?? "";
      expect(bodyOf("letter")).toBe(seededLetterTemplate());
      expect(bodyOf("nda")).toBe(seededAgreementTemplate("nda"));
      expect(bodyOf("mutual_nda")).toBe(seededAgreementTemplate("mutual_nda"));
      // The earlier types' rows are untouched: widening the type CHECK must not
      // have disturbed what 0009, 0011 and 0017 seeded.
      expect(bodyOf("quote")).toBe(seededQuoteTemplate());
      expect(bodyOf("meeting_summary")).toBe(seededMeetingSummaryTemplate());
      // The two agreements are the same document in different words, so their
      // token sets are identical and their BODIES are not.
      expect(bodyOf("nda")).not.toBe(bodyOf("mutual_nda"));

      for (const [type, expected] of [
        ["letter", LETTER_FIELDS],
        ["nda", AGREEMENT_FIELD_TOKENS],
        ["mutual_nda", AGREEMENT_FIELD_TOKENS],
      ] as const) {
        const body = bodyOf(type);
        expect([...new Set(body.match(/\{\{[^}]*\}\}/g) ?? [])].sort()).toEqual(expected);
        // Every `{{` in the body is one of those tokens -- a CSS rule that
        // accidentally put two braces together would be eaten as a merge field.
        expect(body.match(/\{\{/g) ?? [])
          .toHaveLength((body.match(/\{\{[^}]*\}\}/g) ?? []).length);
        // The two properties the document sanitiser profile exists to allow, and
        // the one that keeps a newline-separated address printing as lines.
        expect(body).toContain("@page");
        expect(body).toContain("white-space: pre-line");
      }

      // 4. The two indexes 0017 said would arrive "with the NDA" -- and, because
      // this drill migrates to HEAD, the third one 0020 added with the status
      // report's read. The line that used to assert `documents_project_idx` was
      // absent is gone rather than inverted: this is a 0019 drill and the fifth
      // index is not 0019's business. What IS 0019's business is that its own two
      // arrived and are shaped as it declared them.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'documents'`,
      );
      const named = (name: string) => indexes.find((row) => row.indexname === name);
      expect(named("documents_company_idx")?.indexdef).toMatch(/\(company_id\)/i);
      expect(named("documents_contact_idx")?.indexdef).toMatch(/\(contact_id\)/i);
      for (const name of ["documents_company_idx", "documents_contact_idx"]) {
        expect(named(name)?.indexdef).not.toMatch(/UNIQUE/i);
        expect(named(name)?.indexdef).not.toMatch(/WHERE/i);
      }

      // 5. A PRE-EXISTING COMPANY CAN BE WRITTEN TO, which is the point of the
      // upgrade rather than a property of a fresh install -- and the letter it
      // gets is EDITABLE while the quote above is not. One migration, two
      // opposite answers, off one column.
      const [letterFile] = await scratch.db.insert(files).values({
        originalName: "Letter - Acme - 2026-09-06.pdf", mime: "application/pdf",
        sizeBytes: 5000, sha256: "e".repeat(64), uploaderUserId: user!.id, companyId: company.id,
      }).returning();
      const [letter] = await scratch.db.insert(documents).values({
        number: null, type: "letter", companyId: company.id, fileId: letterFile!.id,
        issueDate: "2026-09-06", frozen: false, issuedByUserId: user!.id,
      }).returning();
      await scratch.db.insert(documentLetters)
        .values({ documentId: letter!.id, recipientName: "Acme", bodyHtml: "<p>Hello</p>" });
      await scratch.db.execute(sql`
        UPDATE document_letters SET body_html = '<p>Redrafted</p>' WHERE document_id = ${letter!.id}
      `);
      const [redrafted] = await scratch.db.select().from(documentLetters);
      expect(redrafted?.bodyHtml).toBe("<p>Redrafted</p>");
    });
  });

  /**
   * **THE GUARD, ACROSS EVERY TABLE IT COVERS AND IN BOTH VERBS.**
   *
   * The spec's fourth risk in one test: "making it conditional is where a
   * mistake would let a quote be edited". A quote's three rows are frozen, a
   * letter's two are not, and the difference is one column.
   *
   * `document_line_items` IS IN THE LIST AND IT IS THE ONE THAT MATTERS MOST.
   * The parent row is where `frozen` lives, but the PRICE somebody was sent is in
   * `document_quotes` and the lines are here -- a guard that covered only the
   * parent would leave both editable, and the `documents` row would sit there
   * untouched while the page it points at became a lie.
   */
  it("refuses every UPDATE and DELETE against a frozen document, on all four tables", async () => {
    const parents = await seedDocumentParents();
    const quote = await insertQuote(parents);
    const [line] = await handle.db.insert(documentLineItems).values({
      documentId: quote.id, position: 1, description: "Widget",
      qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100, lineTotalCents: 10_000,
    }).returning();

    const refused = {
      code: "23514", message: expect.stringContaining("documents_frozen_is_immutable"),
    };
    for (const statement of [
      sql`UPDATE documents SET issue_date = '2026-01-01' WHERE id = ${quote.id}`,
      sql`UPDATE documents SET frozen = false WHERE id = ${quote.id}`,
      sql`DELETE FROM documents WHERE id = ${quote.id}`,
      sql`UPDATE document_quotes SET total_cents = 1 WHERE document_id = ${quote.id}`,
      sql`UPDATE document_quotes SET recipient_name = 'Someone else' WHERE document_id = ${quote.id}`,
      sql`DELETE FROM document_quotes WHERE document_id = ${quote.id}`,
      sql`UPDATE document_line_items SET line_total_cents = 1 WHERE id = ${line!.id}`,
      sql`DELETE FROM document_line_items WHERE id = ${line!.id}`,
    ]) {
      await expect(handle.db.execute(statement)).rejects.toMatchObject({ cause: refused });
    }

    // NOT ONE OF THEM LANDED. Eight refusals prove eight errors were raised; this
    // proves the rows are what they were, which is the claim being made.
    const [documentAfter] = await handle.db.select().from(documents)
      .where(eq(documents.id, quote.id));
    expect(documentAfter).toMatchObject({ issueDate: "2026-08-28", frozen: true });
    const [quoteAfter] = await handle.db.select().from(documentQuotes);
    expect(quoteAfter).toMatchObject({ totalCents: 13_100, recipientName: "Acme" });
    const [lineAfter] = await handle.db.select().from(documentLineItems);
    expect(lineAfter).toMatchObject({ lineTotalCents: 10_000 });
  });

  it("lets an unfrozen document and its detail row be changed, and deleted", async () => {
    const parents = await seedCompanyParents();
    const [letter] = await handle.db.insert(documents).values(letterValues(parents)).returning();
    await handle.db.insert(documentLetters)
      .values({ documentId: letter!.id, recipientName: "Acme", bodyHtml: "<p>Draft</p>" });

    await handle.db.update(documentLetters)
      .set({ bodyHtml: "<p>Redrafted</p>", subject: "Renewal" })
      .where(eq(documentLetters.documentId, letter!.id));
    await handle.db.update(documents)
      .set({ issueDate: "2026-09-07" }).where(eq(documents.id, letter!.id));

    const [afterLetter] = await handle.db.select().from(documentLetters);
    expect(afterLetter).toMatchObject({ bodyHtml: "<p>Redrafted</p>", subject: "Renewal" });
    const [afterDocument] = await handle.db.select().from(documents);
    expect(afterDocument).toMatchObject({ issueDate: "2026-09-07" });

    // DELETE TOO, asserted rather than left out because the trigger covers BEFORE
    // UPDATE OR DELETE and a guard that refused every delete would pass every
    // assertion above. Nothing in the product deletes a document; what is pinned
    // here is that the guard is about `frozen` and not about the verb.
    await handle.db.delete(documentLetters).where(eq(documentLetters.documentId, letter!.id));
    await handle.db.delete(documents).where(eq(documents.id, letter!.id));
    expect(await handle.db.select().from(documents)).toHaveLength(0);
  });

  /**
   * FREEZING IS PER DOCUMENT AND NOT PER TABLE, which is the distinction a guard
   * keyed on the table name would lose. A `document_agreements` row is frozen
   * because its DOCUMENT is; if a future type shared that table and answered
   * `false`, its rows would be editable and these would not.
   */
  it("refuses an agreement's terms off the same trigger that admits a letter's body", async () => {
    const parents = await seedCompanyParents();
    const [nda] = await handle.db.insert(documents).values(agreementValues(parents)).returning();
    await handle.db.insert(documentAgreements).values({
      documentId: nda!.id, type: "nda", effectiveDate: "2026-09-01", termMonths: 36,
      jurisdiction: "the Netherlands", partyName: "Acme",
    });

    await expect(handle.db.execute(sql`
      UPDATE document_agreements SET term_months = 1 WHERE document_id = ${nda!.id}
    `)).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("documents_frozen_is_immutable") },
    });
    const [unchanged] = await handle.db.select().from(documentAgreements);
    expect(unchanged).toMatchObject({ termMonths: 36, jurisdiction: "the Netherlands" });
  });

  /**
   * The per-type answers as LITERALS. The enum-driven sync tests in the 0009
   * block already assert `documentTypeFreezes` and `documentTypeNumbered` against
   * their CHECKs for every member -- what those cannot say is that the answers
   * are the ones Chris decided, because they ask the functions.
   */
  it("freezes and numbers exactly the types the spec says, spelled rather than derived", () => {
    expect(documentTypeSchema.options.filter(documentTypeFreezes))
      .toEqual(["quote", "nda", "mutual_nda"]);
    expect(documentTypeSchema.options.filter(documentTypeNumbered))
      .toEqual(["quote", "nda", "mutual_nda"]);
    expect(documentTypeSchema.options.filter((t) => !documentTypeFreezes(t)))
      .toEqual(["meeting_summary", "letter", "project_status_report"]);
    expect(documentTypeSchema.options.filter((t) => !documentTypeNumbered(t)))
      .toEqual(["meeting_summary", "letter", "project_status_report"]);
    // **THE TWO SETS COINCIDE AT SIX TYPES, AND THE COUNTEREXAMPLE THIS COMMENT
    // USED TO OFFER WAS NOT ONE.** It read: "a later type (a status report is
    // neither; a delivery note would be numbered and reprintable) is going to
    // break [the coincidence]". The status report has arrived and it IS neither
    // -- which is both functions answering false, i.e. agreement. A prediction
    // that a type would break the pairing was written down, the type was built,
    // and it did not.
    //
    // The two literals stay independent, and now for a reason that has to stand
    // on its own rather than on a promised counterexample: the two rules answer
    // different questions (may these bytes change; does somebody outside hold a
    // handle to them), and six-for-six is exactly the point at which
    // `expect(frozen).toEqual(numbered)` starts to look like a discovered
    // invariant instead of an arithmetic coincidence. The remaining
    // counterexamples are all hypothetical -- a credit note frozen and numbered,
    // a delivery note numbered and freely reprinted -- and this comment now says
    // so instead of naming one that was about to disprove it.
  });

  it("refuses a numbered letter and an unnumbered agreement", async () => {
    const parents = await seedCompanyParents();
    const violates = {
      code: "23514", message: expect.stringContaining("documents_number_matches_type"),
    };
    await expect(handle.db.insert(documents)
      .values(letterValues(parents, { number: "LET-2026-0001" })))
      .rejects.toMatchObject({ cause: violates });
    await expect(handle.db.insert(documents).values(agreementValues(parents, { number: null })))
      .rejects.toMatchObject({ cause: violates });
  });

  /**
   * THE THIRD ENFORCEMENT, WHICH IS THE ONE THAT IS AN ABSENCE.
   * `document_number_sequences_type_valid` is deliberately NARROWER than
   * `documents_type_valid`: it names the NUMBERED types, so a writer that called
   * allocateNumber for a letter fails on that INSERT rather than minting
   * `DOC-2026-0001` out of formatDocumentNumber's fallback.
   */
  it("admits a sequence row for every numbered type and refuses one for every other", async () => {
    for (const type of documentTypeSchema.options) {
      const insert = handle.db.insert(documentNumberSequences).values({ type, year: 2026 });
      if (documentTypeNumbered(type)) {
        await expect(insert).resolves.toBeDefined();
      } else {
        await expect(insert).rejects.toMatchObject({
          cause: {
            code: "23514",
            message: expect.stringContaining("document_number_sequences_type_valid"),
          },
        });
      }
    }
  });

  /**
   * The composite key on both new tables -- 0017's trick applied to two types
   * that did not exist when it was invented. What it catches is reachable:
   * `listRecordDocuments` LEFT JOINs both detail tables on `document_id` alone,
   * so without the key a `document_agreements` row naming a LETTER would come
   * back as an NDA, with a term and a jurisdiction, from code that never asked.
   */
  it("refuses a detail row that names a document of the wrong type, on both new tables", async () => {
    const parents = await seedCompanyParents();
    const [letter] = await handle.db.insert(documents).values(letterValues(parents)).returning();
    const [nda] = await handle.db.insert(documents).values(agreementValues(parents)).returning();

    await expect(handle.db.insert(documentAgreements).values({
      documentId: letter!.id, type: "nda", effectiveDate: "2026-09-01", termMonths: 12,
      jurisdiction: "the Netherlands", partyName: "Acme",
    })).rejects.toMatchObject({
      cause: {
        code: "23503",
        message: expect.stringContaining("document_agreements_document_id_type_fk"),
      },
    });

    // A letter row pointing at the NDA. Its `type` is a CONSTANT filled by the
    // DEFAULT, so a writer cannot even spell the disagreement -- which is exactly
    // what makes this the same failure arriving through the key.
    await expect(handle.db.insert(documentLetters)
      .values({ documentId: nda!.id, recipientName: "Acme", bodyHtml: "<p>x</p>" }))
      .rejects.toMatchObject({
        cause: {
          code: "23503",
          message: expect.stringContaining("document_letters_document_id_type_fk"),
        },
      });

    // And the pairs that DO agree are accepted, or a key that refused everything
    // would pass both assertions above and break every letter.
    const [letterRow] = await handle.db.insert(documentLetters)
      .values({ documentId: letter!.id, recipientName: "Acme", bodyHtml: "<p>x</p>" }).returning();
    expect(letterRow?.type).toBe("letter");
    const [ndaRow] = await handle.db.insert(documentAgreements).values({
      documentId: nda!.id, type: "nda", effectiveDate: "2026-09-01", termMonths: 12,
      jurisdiction: "the Netherlands", partyName: "Acme",
    }).returning();
    expect(ndaRow?.type).toBe("nda");
  });

  it("pins document_letters.type to 'letter' and document_agreements.type to the two agreements", async () => {
    const parents = await seedCompanyParents();
    const [letter] = await handle.db.insert(documents).values(letterValues(parents)).returning();
    await expect(handle.db.execute(sql`
      INSERT INTO document_letters (document_id, type, recipient_name, body_html)
      VALUES (${letter!.id}, 'quote', 'Acme', '<p>x</p>')
    `)).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("document_letters_type_is_letter") },
    });

    // The agreements' CHECK is the first of the three that pins a SET rather than
    // a constant, because the writer is the only thing that knows which of the two
    // an agreement is.
    const [mutual] = await handle.db.insert(documents)
      .values(agreementValues(parents, { type: "mutual_nda", number: "MNDA-2026-0001" }))
      .returning();
    const [mutualRow] = await handle.db.insert(documentAgreements).values({
      documentId: mutual!.id, type: "mutual_nda", effectiveDate: "2026-09-01", termMonths: 24,
      jurisdiction: "England and Wales", partyName: "Acme",
    }).returning();
    expect(mutualRow?.type).toBe("mutual_nda");

    const [third] = await handle.db.insert(documents)
      .values(agreementValues(parents, { number: "NDA-2026-0009" })).returning();
    await expect(handle.db.execute(sql`
      INSERT INTO document_agreements (document_id, type, effective_date, term_months,
                                       jurisdiction, party_name)
      VALUES (${third!.id}, 'letter', '2026-09-01', 12, 'the Netherlands', 'Acme')
    `)).rejects.toMatchObject({
      cause: { code: "23514", message: expect.stringContaining("document_agreements_type_valid") },
    });
  });

  it("bounds the term and refuses an agreement with no party or no governing law", async () => {
    const parents = await seedCompanyParents();
    const [nda] = await handle.db.insert(documents).values(agreementValues(parents)).returning();
    const base = {
      documentId: nda!.id, type: "nda", effectiveDate: "2026-09-01",
      termMonths: 36, jurisdiction: "the Netherlands", partyName: "Acme",
    };
    for (const [bad, constraint] of [
      [{ termMonths: 0 }, "document_agreements_term_range"],
      [{ termMonths: 1201 }, "document_agreements_term_range"],
      [{ partyName: "" }, "document_agreements_stated"],
      [{ jurisdiction: "" }, "document_agreements_stated"],
    ] as const) {
      await expect(handle.db.insert(documentAgreements).values({ ...base, ...bad }))
        .rejects.toMatchObject({
          cause: { code: "23514", message: expect.stringContaining(constraint) },
        });
    }
    // THE EXACT EDGES ARE ACCEPTED, which is what stops the bound being narrowed
    // by one and nobody noticing: 1 and 1200 are both real terms.
    for (const months of [1, 1200]) {
      const [row] = await handle.db.insert(documents)
        .values(agreementValues(parents, { number: `NDA-2026-1${String(months)}` })).returning();
      await handle.db.insert(documentAgreements)
        .values({ ...base, documentId: row!.id, termMonths: months });
    }
    expect(await handle.db.select().from(documentAgreements)).toHaveLength(2);
  });

  /**
   * A letter attaches to exactly one of the five, and it is the first type to use
   * `company_id` or `contact_id` -- the columns 0016 added and nothing read.
   */
  it("attaches a letter to a company or a contact and to nothing else", async () => {
    const parents = await seedCompanyParents();
    const contact = await createContact(handle.db, userId, { firstName: "Jane", lastName: "Smith" });
    const [file] = await handle.db.insert(files).values({
      originalName: "l.pdf", mime: "application/pdf", sizeBytes: 10, sha256: "c".repeat(64),
      uploaderUserId: userId, contactId: contact.id,
    }).returning();

    const [onCompany] = await handle.db.insert(documents).values(letterValues(parents)).returning();
    expect(onCompany).toMatchObject({
      companyId: parents.companyId, contactId: null, dealId: null, projectId: null, meetingId: null,
    });
    const [onContact] = await handle.db.insert(documents).values(letterValues(parents, {
      companyId: null, contactId: contact.id, fileId: file!.id,
    })).returning();
    expect(onContact).toMatchObject({ companyId: null, contactId: contact.id });

    // **BOTH AT ONCE IS THE SHAPE CHRIS'S DECISION FORBIDS**, and an NDA naming a
    // contact at a company is precisely the document somebody would reach for it
    // with. It attaches to the company and names the contact in its CONTENT --
    // `document_agreements.party_contact_name` -- which is a column and not a
    // second owner.
    await expect(handle.db.insert(documents)
      .values(letterValues(parents, { contactId: contact.id })))
      .rejects.toMatchObject({
        cause: { code: "23514", message: expect.stringContaining("documents_exactly_one_entity") },
      });
  });
});

/* ========================================================================== *
 *  THE PROJECT STATUS REPORT, AND WHICH RECORD EACH TYPE GOES ON (0020)
 * ========================================================================== */

describe("the project status report (0020)", () => {
  /**
   * EVERY merge token the seeded report template contains, as an EQUALITY in both
   * directions -- 0009's SEEDED_FIELDS, 0017's SUMMARY_FIELDS and 0019's
   * LETTER_FIELDS, one task on. A token the resolver does not supply renders as a
   * silent blank on a printed page; a context key the template stopped naming is
   * built for nothing.
   *
   * THE FIVE EMPTY CASES ARE WHAT THE OPTIONAL LIST IS. A project with no client,
   * no owner and no dates is completely ordinary -- it is what a project looks
   * like on the day it is created -- and each of those sits behind markup that
   * would otherwise print a label over a blank.
   */
  const REPORT_OPTIONAL = [
    "org.logoDataUri", "org.addressLines", "org.email", "org.phone", "org.website",
    "document.company", "document.owner", "document.startDate", "document.dueDate",
  ];
  const REPORT_COUNTS = [
    "document.taskCount", "document.doneCount", "document.inProgressCount",
    "document.blockedCount", "document.todoCount", "document.overdueCount",
    "document.undatedCount",
  ];
  const REPORT_FIELDS = [
    "{{org.name}}", "{{document.projectName}}", "{{document.projectStatus}}",
    "{{document.issueDate}}",
    ...REPORT_COUNTS.map((path) => `{{${path}}}`),
    // THE COLLECTION, IN BOTH BLOCK FORMS. A project with no tasks is ordinary,
    // and without the inverted form the page carries a table header over nothing.
    "{{#tasks}}", "{{/tasks}}", "{{^tasks}}",
    // ...and the fields inside it, INCLUDING the first conditional any collection
    // item in this language has carried.
    "{{title}}", "{{status}}", "{{startDate}}", "{{dueDate}}", "{{progress}}",
    "{{assignee}}", "{{#after}}", "{{after}}", "{{/after}}",
    ...REPORT_OPTIONAL.flatMap((path) => [`{{#${path}}}`, `{{${path}}}`, `{{/${path}}}`]),
  ].sort();

  /**
   * **THE UPGRADE DRILL, AND ITS MOST VALUABLE ASSERTION IS THE ONE MADE BEFORE
   * THE MIGRATION RUNS.** 0020 moves no rows; what it changes is what the
   * database will ACCEPT, and the only way to show that is to write the bad row
   * first, watch it succeed, migrate, and watch the same write be refused.
   *
   * The bad row is Task 3's own example: a letter carrying a `deal_id`. Its note
   * -- "nothing in the database stops a letter carrying a `deal_id` or a quote
   * carrying a `meeting_id`; only the writers do" -- is a statement about the
   * pre-0020 database, and this drill is where it is true and then stops being.
   */
  it("applies migration 0020 to a real pre-0020 database -- a letter on a deal was legal before and is refused after, the report template arrives, and the project index is built", async () => {
    await withPreMigrationDatabase("0020", async (scratch) => {
      const [user] = await scratch.db.insert(users).values({ username: "chris" }).returning();
      const company = await createCompany(scratch.db, user!.id, { name: "Acme" });
      const pipeline = await createPipeline(scratch.db, user!.id, { name: "Sales", scope: "global" });
      const stage = await createStage(scratch.db, user!.id, pipeline.id, { name: "New" });
      const deal = await createDeal(
        scratch.db, user!.id, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
      );
      const project = await createProject(scratch.db, user!.id, { name: "Rollout" });
      const [quoteFile] = await scratch.db.insert(files).values({
        originalName: "QUO-2026-0001.pdf", mime: "application/pdf", sizeBytes: 16_003,
        sha256: "d".repeat(64), uploaderUserId: user!.id, dealId: deal.id,
      }).returning();
      const [quote] = await scratch.db.insert(documents).values({
        number: "QUO-2026-0001", type: "quote", dealId: deal.id, fileId: quoteFile!.id,
        issueDate: "2026-08-28", frozen: true, issuedByUserId: user!.id,
      }).returning();
      await scratch.db.insert(documentQuotes).values({
        documentId: quote!.id, currency: "EUR", recipientName: "Acme",
        subtotalCents: 11_000, taxCents: 2100, totalCents: 13_100,
      });

      // PIN THE PREMISE. Without these three the assertions after the migration
      // would also pass against a database that had been fully migrated all
      // along -- and the first one is the gap itself, demonstrated rather than
      // described.
      const [letterFile] = await scratch.db.insert(files).values({
        originalName: "Letter - Acme.pdf", mime: "application/pdf", sizeBytes: 5000,
        sha256: "e".repeat(64), uploaderUserId: user!.id, companyId: company.id,
      }).returning();
      const [misfiled] = await scratch.db.insert(documents).values({
        number: null, type: "letter", dealId: deal.id, fileId: letterFile!.id,
        issueDate: "2026-09-06", frozen: false, issuedByUserId: user!.id,
      }).returning();
      expect(misfiled).toMatchObject({ type: "letter", dealId: deal.id, companyId: null });

      const beforeTypes = await scratch.db.execute<{ def: string }>(sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'documents'::regclass AND conname = 'documents_entity_matches_type'
      `);
      expect(beforeTypes).toEqual([]);
      const beforeIndexes = await scratch.db.execute<{ indexname: string }>(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'documents' AND indexname = 'documents_project_idx'
      `);
      expect(beforeIndexes).toEqual([]);

      // THE MISFILED LETTER HAS TO GO BEFORE THE MIGRATION CAN VALIDATE, which is
      // itself the finding: `documents_entity_matches_type` is added VALIDATED,
      // so it would refuse to apply to a database holding a row like this one.
      // Every real install satisfies it (0016 proved the shape of the only rows
      // that exist), and that is exactly why this migration is free -- but it is
      // free because of a fact about the data, not because the constraint is
      // lenient, and deleting this row is what says so.
      await scratch.db.execute(sql`DELETE FROM documents WHERE id = ${misfiled!.id}`);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // 1. The quote is untouched and still satisfies the new CHECK.
      const [after] = await scratch.db.select().from(documents);
      expect(after).toMatchObject({
        number: "QUO-2026-0001", type: "quote", frozen: true, dealId: deal.id,
      });

      // 2. **THE ROW THAT WAS LEGAL A MOMENT AGO IS NOT ANY MORE.** Same INSERT,
      // same columns, opposite answer -- which is the whole of what 0020 does to
      // an existing install.
      await expect(scratch.db.insert(documents).values({
        number: null, type: "letter", dealId: deal.id, fileId: letterFile!.id,
        issueDate: "2026-09-06", frozen: false, issuedByUserId: user!.id,
      })).rejects.toMatchObject({
        cause: {
          code: "23514", message: expect.stringContaining("documents_entity_matches_type"),
        },
      });

      // 3. ...and a report on the project is what IS now accepted, on a project
      // that existed before the migration. That is the point of an upgrade rather
      // than a property of a fresh install.
      const [reportFile] = await scratch.db.insert(files).values({
        originalName: "Status report - Rollout - 2026-09-06.pdf", mime: "application/pdf",
        sizeBytes: 7000, sha256: "f".repeat(64), uploaderUserId: user!.id, projectId: project.id,
      }).returning();
      const [report] = await scratch.db.insert(documents).values({
        number: null, type: "project_status_report", projectId: project.id,
        fileId: reportFile!.id, issueDate: "2026-09-06", frozen: false,
        issuedByUserId: user!.id,
      }).returning();
      expect(report).toMatchObject({
        type: "project_status_report", projectId: project.id, number: null, frozen: false,
        companyId: null, contactId: null, dealId: null, meetingId: null,
      });
      // ...and it is EDITABLE, which the quote above is not. One column, two
      // opposite answers, and `conduit_document_frozen_guard` reads it.
      await scratch.db.execute(sql`
        UPDATE documents SET issue_date = '2026-09-07' WHERE id = ${report!.id}
      `);
      await expect(scratch.db.execute(sql`
        UPDATE documents SET issue_date = '2026-09-07' WHERE id = ${quote!.id}
      `)).rejects.toMatchObject({
        cause: {
          code: "23514", message: expect.stringContaining("documents_frozen_is_immutable"),
        },
      });

      // 4. The sixth template, byte for byte what test/seed-template.ts derives
      // from the migration file, and the five earlier rows untouched.
      const templates = await scratch.db.select().from(documentTemplates)
        .orderBy(asc(documentTemplates.type));
      expect(templates.map((row) => row.type)).toEqual([...documentTypeSchema.options].sort());
      const bodyOf = (type: string) => templates.find((row) => row.type === type)?.bodyHtml ?? "";
      expect(bodyOf("project_status_report")).toBe(seededStatusReportTemplate());
      expect(bodyOf("quote")).toBe(seededQuoteTemplate());
      expect(bodyOf("meeting_summary")).toBe(seededMeetingSummaryTemplate());
      expect(bodyOf("letter")).toBe(seededLetterTemplate());
      expect(bodyOf("nda")).toBe(seededAgreementTemplate("nda"));
      expect(bodyOf("mutual_nda")).toBe(seededAgreementTemplate("mutual_nda"));

      const body = bodyOf("project_status_report");
      expect([...new Set(body.match(/\{\{[^}]*\}\}/g) ?? [])].sort()).toEqual(REPORT_FIELDS);
      // Every `{{` in the body is one of those tokens -- a CSS rule that
      // accidentally put two braces together would be eaten as a merge field.
      expect(body.match(/\{\{/g) ?? [])
        .toHaveLength((body.match(/\{\{[^}]*\}\}/g) ?? []).length);
      expect(body).toContain("@page");
      expect(body).toContain("white-space: pre-line");

      // 5. The fifth and last of 0016's record foreign keys gets its index, which
      // completes the set 0017 predicted.
      const indexes = await scratch.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'documents'`,
      );
      const projectIndex = indexes.find((row) => row.indexname === "documents_project_idx");
      expect(projectIndex?.indexdef).toMatch(/\(project_id\)/i);
      expect(projectIndex?.indexdef).not.toMatch(/UNIQUE/i);
      expect(projectIndex?.indexdef).not.toMatch(/WHERE/i);
      expect(indexes.map((row) => row.indexname)
        .filter((name) => /deal|meeting|company|contact|project/.test(name)).sort())
        .toEqual([
          "documents_company_idx", "documents_contact_idx", "documents_deal_idx",
          "documents_meeting_idx", "documents_project_idx",
        ]);
    });
  }, 30000);

  /**
   * THE THREE CONSTRAINTS 0020 DELIBERATELY DID NOT TOUCH, pinned so that a later
   * task cannot "tidy" the report into one of them. Each is an equality or a
   * narrower list that already says the right thing about an unnumbered,
   * unfrozen type -- see the migration's section 2.
   */
  it("leaves the numbering, freezing and sequence rules exactly as 0019 left them", async () => {
    const defs = await handle.db.execute<{ conname: string; def: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN (
        'documents_number_matches_type',
        'documents_frozen_matches_type',
        'document_number_sequences_type_valid'
      )
    `);
    for (const row of defs) {
      expect(row.def).not.toContain("project_status_report");
      // ...and each of them still names the three that ARE numbered and frozen,
      // so "does not mention the report" is not satisfied by an empty list.
      for (const type of ["quote", "nda", "mutual_nda"]) expect(row.def).toContain(type);
    }
    expect(defs).toHaveLength(3);
  });
});

describe("time entries (0021)", () => {
  /** A row that satisfies every constraint except the link one, overridable per
   * test. No record link by default, so a test that means to insert a VALID row
   * has to say which record it belongs to -- which is the rule under test. */
  function entryValues(
    overrides: Partial<typeof timeEntries.$inferInsert> = {},
  ): typeof timeEntries.$inferInsert {
    return {
      workDate: "2026-09-01", minutes: 60, billable: false, ownerUserId: userId, ...overrides,
    };
  }

  async function seedProject(): Promise<string> {
    return (await createProject(handle.db, userId, { name: "Rollout" })).id;
  }

  /**
   * **THE UPGRADE DRILL, AND ITS QUESTION IS THE CHEAPEST ONE IN THE FILE.**
   *
   * 0021 creates one table and touches nothing that exists, so unlike 0016 there
   * is no fixture of pre-migration rows to replay and unlike 0018 there is no
   * backfill whose DEFAULT could lie about rows that predate it. What is left to
   * prove is exactly two things, and both of them have failed before in this
   * project: that the migration ARRIVES AT ALL on a database that is already
   * migrated (the journal trap, five for five in Phase 9), and that a populated
   * install still has its rows afterwards.
   *
   * THE PREMISE IS PINNED FIRST. Without the catalogue check below, every
   * assertion here would pass just as happily against a database that had been
   * fully migrated all along -- which is the exact failure mode a drill exists
   * for, and the exact shape a skipped migration would have produced.
   */
  it("applies migration 0021 to a real pre-0021 database -- the table, both CHECKs and the index arrive, and existing rows are untouched", async () => {
    await withPreMigrationDatabase("0021", async (scratch) => {
      // RAW SQL, NOT `insert(companies)`: schema.ts describes TODAY's shape, and
      // this file's standing hazard is a drizzle insert naming a column the
      // pre-migration database does not have. (Harmless for `companies` today,
      // written this way because the 0011 and 0017 drills both went red on it.)
      await scratch.db.execute(sql`
        INSERT INTO users (id, username) VALUES (${userId}::uuid, 'chris')
      `);
      await scratch.db.execute(sql`
        INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'Acme')
      `);

      const before = await scratch.db.execute<{ tablename: string }>(sql`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'time_entries'
      `);
      expect(before).toEqual([]);

      await migrate(scratch.db, { migrationsFolder: migrationsFolder() });

      // THE TABLE IS HERE, WHICH IS THE HALF THE JOURNAL TRAP WOULD HAVE TAKEN:
      // a skipped 0021 raises no error anywhere, it just leaves this empty.
      const after = await scratch.db.execute<{ tablename: string }>(sql`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'time_entries'
      `);
      expect(after).toHaveLength(1);

      // Both CHECKs arrived VALIDATED rather than merely declared -- proved by
      // exercising them, which is the only way to tell.
      const [company] = await scratch.db.execute<{ id: string }>(sql`SELECT id FROM companies`);
      await expect(scratch.db.execute(sql`
        INSERT INTO time_entries (work_date, minutes, billable, owner_user_id)
        VALUES ('2026-09-01', 60, false, ${userId}::uuid)
      `)).rejects.toMatchObject({ cause: { constraint_name: "time_entries_has_link" } });
      await expect(scratch.db.execute(sql`
        INSERT INTO time_entries (work_date, minutes, billable, owner_user_id, company_id)
        VALUES ('2026-09-01', 0, false, ${userId}::uuid, ${company?.id ?? ""}::uuid)
      `)).rejects.toMatchObject({ cause: { constraint_name: "time_entries_minutes_range" } });

      // The hand-written index is in the migration and not in schema.ts, so
      // nothing else in this suite would notice its absence.
      const indexes = await scratch.db.execute<{ indexname: string }>(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'time_entries' AND indexname = 'time_entries_work_date_idx'
      `);
      expect(indexes).toHaveLength(1);

      // ...and the install that was already here still is.
      const companies = await scratch.db.execute<{ name: string }>(sql`SELECT name FROM companies`);
      expect(companies.map((row) => row.name)).toEqual(["Acme"]);
    });
  }, 30000);

  /**
   * **THE CONSTRAINT THIS TASK EXISTS FOR.** Three arms, and each one is a
   * decision the spec argues rather than a default:
   *
   *   NONE IS REFUSED -- not tasks'/mail_threads' "any subset including the
   *   empty one". An entry linked to nothing is in no report and findable only
   *   by SQL, so the week's total is short and nothing says so.
   *
   *   ONE IS ENOUGH -- the ordinary row.
   *
   *   ALL FIVE AT ONCE IS VALID -- not notes'/files'/documents' exactly-one. An
   *   hour on a project AND the deal it came from is the case the spec names,
   *   and a schema that refused it would make one of those two reports wrong on
   *   purpose.
   */
  it("enforces time_entries_has_link: none is rejected, one is enough, and all five at once are valid", async () => {
    await expect(handle.db.insert(timeEntries).values(entryValues()))
      .rejects.toMatchObject({ cause: { constraint_name: "time_entries_has_link" } });

    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [oneLink] = await handle.db.insert(timeEntries)
      .values(entryValues({ companyId: company.id })).returning();
    expect(oneLink).toMatchObject({ companyId: company.id, contactId: null, taskId: null });

    const contact = await createContact(handle.db, userId, { firstName: "Bob", companyId: company.id });
    const pipeline = await createPipeline(handle.db, userId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, userId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, userId, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const project = await createProject(handle.db, userId, { name: "Rollout" });
    const [task] = await handle.db.insert(tasks)
      .values({ title: "Migrate the data", position: "a0", projectId: project.id }).returning();
    const [everyLink] = await handle.db.insert(timeEntries).values(entryValues({
      companyId: company.id, contactId: contact.id, dealId: deal.id,
      projectId: project.id, taskId: task?.id,
    })).returning();
    expect(everyLink).toMatchObject({
      companyId: company.id, contactId: contact.id, dealId: deal.id,
      projectId: project.id, taskId: task?.id,
    });
  });

  /**
   * **EACH OF THE FIVE IS ENOUGH ON ITS OWN**, one at a time.
   *
   * The test above proves "one is enough" for `company_id` only, and a CHECK
   * that had lost a column from its num_nonnulls list would still pass it. This
   * is the loop that names which column went missing -- the same reason the
   * documents drills iterate their types instead of spot-checking one.
   */
  it("accepts an entry attached to each one of the five records on its own", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const contact = await createContact(handle.db, userId, { firstName: "Bob" });
    const pipeline = await createPipeline(handle.db, userId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, userId, pipeline.id, { name: "New" });
    const deal = await createDeal(
      handle.db, userId, { title: "Big Deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const project = await createProject(handle.db, userId, { name: "Rollout" });
    const [task] = await handle.db.insert(tasks)
      .values({ title: "Migrate the data", position: "a0", projectId: project.id }).returning();

    const only = [
      ["companyId", company.id], ["contactId", contact.id], ["dealId", deal.id],
      ["projectId", project.id], ["taskId", task?.id ?? ""],
    ] as const;
    for (const [column, id] of only) {
      const [row] = await handle.db.insert(timeEntries)
        .values(entryValues({ [column]: id })).returning();
      expect(row, `an entry attached only to ${column} was refused`).toMatchObject({ [column]: id });
    }
  });

  /**
   * **THE DOUBLE-COUNTING RULE, ALREADY STANDING, IN ITS STRONGEST FORM.**
   *
   * The spec's third decision is that a manual entry cannot be attached to a
   * meeting, so a logged meeting's duration and a typed entry can never be the
   * same hour twice -- and it asks for that to be IMPOSSIBLE rather than
   * discouraged. There is no `meeting_id` column, so this INSERT does not
   * violate a CHECK: it fails to resolve against the table at all (42703,
   * `undefined_column`), which is a refusal no constraint can be dropped to get
   * around.
   *
   * **TASK 2 CONFIRMED IT AND ADDED NOTHING.** The plan told that task to make
   * the refusal "a CHECK, not a convention"; a CHECK needs a column to name, so
   * following it literally would have made the impossible merely illegal. What
   * Task 2 built instead is services/timesheet.ts, which sums the two tables
   * together and closes the INDIRECT routes this absence does not close -- a
   * join that fans a meeting out over its attendees or its links, a meeting in
   * two buckets, an archived row still contributing. This test stays as the
   * guard on the direct one.
   */
  it("cannot express a time entry that names a meeting, because there is no column to name one with", async () => {
    const company = await createCompany(handle.db, userId, { name: "Acme" });
    const [meeting] = await handle.db.insert(meetings).values({
      title: "Kickoff", occurredAt: new Date("2026-09-01T09:00:00Z"),
      durationMinutes: 60, ownerUserId: userId, companyId: company.id,
    }).returning();
    expect(meeting).toBeDefined();

    await expect(handle.db.execute(sql`
      INSERT INTO time_entries (work_date, minutes, billable, owner_user_id, company_id, meeting_id)
      VALUES ('2026-09-01', 60, false, ${userId}::uuid, ${company.id}::uuid, ${meeting?.id ?? ""}::uuid)
    `)).rejects.toMatchObject({ cause: { code: "42703" } });

    // The premise: the identical INSERT without that column succeeds, so the
    // failure above is the column and not the row.
    await expect(handle.db.execute(sql`
      INSERT INTO time_entries (work_date, minutes, billable, owner_user_id, company_id)
      VALUES ('2026-09-01', 60, false, ${userId}::uuid, ${company.id}::uuid)
    `)).resolves.toBeDefined();
  });

  /**
   * **THE EXACT EDGES**, documents' totals CHECK's pattern, and the reason is
   * that this column IS the week's total: a bound narrowed or widened by one is
   * invisible to every test that inserts a plausible number.
   *
   * The upper edge is MAX_TIME_ENTRY_MINUTES, imported rather than restated, so
   * the constant in @conduit/shared and the literal in the migration cannot
   * drift into meaning different things -- the same arrangement
   * documentTypeFreezes has with documents_frozen_matches_type.
   */
  it("enforces time_entries_minutes_range at the exact edges, and that edge is MAX_TIME_ENTRY_MINUTES", async () => {
    const projectId = await seedProject();
    expect(MAX_TIME_ENTRY_MINUTES).toBe(1440);

    for (const minutes of [1, MAX_TIME_ENTRY_MINUTES]) {
      const [row] = await handle.db.insert(timeEntries)
        .values(entryValues({ minutes, projectId })).returning();
      expect(row?.minutes, `${String(minutes)} minutes was refused`).toBe(minutes);
    }
    for (const minutes of [0, -1, MAX_TIME_ENTRY_MINUTES + 1]) {
      await expect(
        handle.db.insert(timeEntries).values(entryValues({ minutes, projectId })),
        `${String(minutes)} minutes was accepted`,
      ).rejects.toMatchObject({ cause: { constraint_name: "time_entries_minutes_range" } });
    }
  });

  /**
   * **`billable` HAS NO DEFAULT**, which is documents.frozen's arrangement and
   * documents.frozen's test. Both values are ordinary, so a default would be a
   * guess made silently on the row where it is hardest to notice -- and the
   * guess that reads worst (non-billable) under-reports chargeable time in a
   * product with no invoicing step to contradict it.
   *
   * READ OUT OF THE CATALOGUE as well as exercised: an INSERT proves the column
   * is NOT NULL, and only `column_default` proves there is nothing standing
   * behind it.
   */
  it("gives billable no default, so a writer that says nothing is refused", async () => {
    const projectId = await seedProject();
    const [column] = await handle.db.execute<{ column_default: string | null }>(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'time_entries' AND column_name = 'billable'
    `);
    expect(column?.column_default).toBeNull();

    await expect(handle.db.execute(sql`
      INSERT INTO time_entries (work_date, minutes, owner_user_id, project_id)
      VALUES ('2026-09-01', 60, ${userId}::uuid, ${projectId}::uuid)
    `)).rejects.toMatchObject({ cause: { code: "23502" } });
  });

  /**
   * WORK_DATE IS A `date` AND NOT A TIMESTAMP, read out of the catalogue.
   *
   * Nothing else can see this: a `timestamptz` column would accept every value
   * these tests insert and return something that formats identically in most of
   * them. What it would change is the meaning -- an hour would acquire an
   * instant, and which WEEK it fell in would depend on a time zone the operator
   * never supplied.
   */
  it("stores the work date as a date, so an hour belongs to a day and not to an instant", async () => {
    const [column] = await handle.db.execute<{ data_type: string }>(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'time_entries' AND column_name = 'work_date'
    `);
    expect(column?.data_type).toBe("date");

    const projectId = await seedProject();
    const [row] = await handle.db.insert(timeEntries)
      .values(entryValues({ workDate: "2026-01-01", projectId })).returning();
    // Comes back as the bare string it went in as -- never a Date, which is what
    // services/time-entries.ts's toTimeEntry relies on.
    expect(row?.workDate).toBe("2026-01-01");
  });

  /**
   * ALL SIX FOREIGN KEYS, ONE AT A TIME. Six columns declared as references is
   * six chances for one of them to be a bare uuid nobody notices, and a bare
   * uuid accepts an id that does not exist -- which is a link the timesheet
   * renders as a blank name for ever.
   *
   * Each row is otherwise valid (a real project keeps time_entries_has_link
   * satisfied), so a 23503 can only have come from the column under test.
   */
  it("enforces every foreign key on time_entries", async () => {
    const absent = randomUUID();
    const projectId = await seedProject();
    const columns = ["ownerUserId", "companyId", "contactId", "dealId", "projectId", "taskId"] as const;
    for (const column of columns) {
      await expect(
        handle.db.insert(timeEntries).values(entryValues({ projectId, [column]: absent })),
        `${column} accepted an id that does not exist`,
      ).rejects.toMatchObject({ cause: { code: "23503" } });
    }
  });
});
