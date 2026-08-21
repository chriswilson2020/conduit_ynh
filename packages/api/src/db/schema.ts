import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, char, date, boolean, check, unique, primaryKey, customType } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Position strings from @conduit/shared's midpoint() must sort byte-wise, the
 * same order as JS string comparison (and the ordering fractional.ts's
 * integer-part encoding itself depends on: 'Z' < 'a' etc.). The database's
 * default en_US.UTF-8 collation interleaves letter case ('Z' sorts after
 * 'z', not before it) and would silently disagree with both the client and
 * the fractional-index encoding, so the collation is pinned at the column --
 * where no query author can forget it -- rather than trusted to every
 * `ORDER BY position` call site. drizzle-orm's built-in text() has no
 * collate option, hence this customType.
 */
const positionText = customType<{ data: string }>({
  dataType() { return 'text COLLATE "C"'; },
});

/**
 * mail_messages.search: drizzle-orm has no built-in tsvector column type, so
 * -- like positionText's collation pin above -- this customType supplies
 * just the bare type name. Generation comes from `.generatedAlwaysAs()`
 * below instead of being folded into the type string, which is what keeps
 * `search` out of the inferred insert type (a generated column can never be
 * written by the app). The GIN index still has to be hand-written in
 * drizzle/0004_*.sql -- drizzle-kit has no notion of an index over a
 * generated column.
 */
const searchVector = customType<{ data: string }>({
  dataType() { return "tsvector"; },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email"),
  fullName: text("full_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domain: text("domain"), website: text("website"), phone: text("phone"),
  address: text("address"), industry: text("industry"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  custom: jsonb("custom").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CompanyRow = typeof companies.$inferSelect;

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(), lastName: text("last_name"),
  companyId: uuid("company_id").references(() => companies.id),
  // Email format is validated by the Zod input schemas (createContactInputSchema),
  // not by this column. Any future direct-write path (import, seed) must go through
  // those schemas to keep this guarantee.
  emails: text("emails").array().notNull().default([]),
  phones: text("phones").array().notNull().default([]),
  jobTitle: text("job_title"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  custom: jsonb("custom").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ContactRow = typeof contacts.$inferSelect;

// --- Pipelines, stages, deals (Phase 2) ---------------------------------

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope").notNull(),
  companyId: uuid("company_id").references(() => companies.id),
  // Phase 3's third scope value. Forward reference (projects is defined further
  // down, after deals -- projects.dealId -> deals, deals.pipelineId -> pipelines,
  // pipelines.projectId -> projects is a genuine three-way cycle among these
  // tables), hence the explicit AnyPgColumn return type: TypeScript can't infer
  // a circular reference's column type on its own.
  projectId: uuid("project_id").references((): AnyPgColumn => projects.id),
  // Fractional index (see packages/shared/src/fractional.ts) ordering sibling
  // pipelines against each other, same scheme as stages.position and
  // deals.position below.
  position: positionText("position").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("pipelines_scope_valid", sql`scope IN ('global','company','project')`),
  // Widened from Phase 2's two-way (scope = 'company') = (company_id IS NOT
  // NULL) pairing to a three-way exclusivity now that 'project' is a real
  // scope: exactly one of company_id/project_id is set for its matching
  // scope, and neither is set for 'global'.
  check("pipelines_scope_paired", sql`(
    (scope = 'global' AND company_id IS NULL AND project_id IS NULL) OR
    (scope = 'company' AND company_id IS NOT NULL AND project_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL AND company_id IS NULL)
  )`),
]);
export type PipelineRow = typeof pipelines.$inferSelect;

export const stages = pgTable("stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id),
  name: text("name").notNull(),
  position: positionText("position").notNull(),
  probability: integer("probability"),
  rotDays: integer("rot_days"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("stages_probability_range", sql`probability IS NULL OR (probability >= 0 AND probability <= 100)`),
]);
export type StageRow = typeof stages.$inferSelect;

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id),
  stageId: uuid("stage_id").notNull().references(() => stages.id),
  // Fractional index ordering the deal among its stage siblings.
  position: positionText("position").notNull(),
  valueCents: bigint("value_cents", { mode: "number" }),
  // No SQL-level DEFAULT: the app-level default (config.defaultCurrency, see
  // config.ts's DEFAULT_CURRENCY) is applied by the deals service when a
  // caller omits currency, so the migration itself never bakes in whatever
  // env var happened to be set when it was generated.
  currency: char("currency", { length: 3 }).notNull(),
  expectedCloseDate: date("expected_close_date"),
  status: text("status").notNull().default("open"),
  lostReason: text("lost_reason"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("deals_status_valid", sql`status IN ('open','won','lost')`),
  // One-directional, not iff: a lost_reason is only ever ALLOWED on a lost deal,
  // but a lost deal is not REQUIRED to carry one (loseDeal's reason argument is
  // free text, not mandatory at the data-model level).
  check("deals_lost_reason_paired", sql`lost_reason IS NULL OR status = 'lost'`),
  // iff: closed_at is set exactly when the deal has left the open state.
  check("deals_closed_at_paired", sql`(closed_at IS NOT NULL) = (status <> 'open')`),
  check("deals_currency_format", sql`currency ~ '^[A-Z]{3}$'`),
]);
export type DealRow = typeof deals.$inferSelect;

// --- Projects, tasks, task dependencies (Phase 3) -----------------------

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  companyId: uuid("company_id").references(() => companies.id),
  // The deal a project originated from, if any -- optional and one-directional
  // (a deal does not point back at "its" project; a company/deal can spawn
  // more than one project over time).
  dealId: uuid("deal_id").references(() => deals.id),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  status: text("status").notNull().default("active"),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  // Hex colour used for Gantt bars/badges; validated at the column so a bad
  // value can never enter via a direct-write path (see the contacts.emails
  // comment above for the same "Zod schemas are the primary gate, the CHECK
  // is the backstop" reasoning).
  color: text("color"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("projects_status_valid", sql`status IN ('active','completed')`),
  check("projects_color_format", sql`color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'`),
]);
export type ProjectRow = typeof projects.$inferSelect;

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull().default("task"),
  status: text("status").notNull().default("todo"),
  assigneeUserId: uuid("assignee_user_id").references(() => users.id),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  progressPct: integer("progress_pct"),
  // One level of subtask grouping only -- the service rejects a parent that
  // itself already has a parent. Self-reference needs the explicit
  // AnyPgColumn return type (TypeScript can't infer a self-referential
  // column type), same trick as pipelines.projectId above.
  parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id),
  // Fractional index; sibling group = same parent within the same project, or
  // the standalone (no project) pool. See stages/deals.position above for the
  // same scheme.
  position: positionText("position").notNull(),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("tasks_type_valid", sql`type IN ('task','call','meeting','email','deadline')`),
  check("tasks_status_valid", sql`status IN ('todo','in_progress','blocked','done')`),
  // Both null (undated), or both set with start <= due -- a task can't have
  // only one of the pair (the Gantt needs a span, not a single anchor).
  check(
    "tasks_dates_paired",
    sql`(start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND due_date IS NOT NULL AND start_date <= due_date)`,
  ),
  check("tasks_completed_at_paired", sql`(completed_at IS NOT NULL) = (status = 'done')`),
  check("tasks_progress_range", sql`progress_pct IS NULL OR (progress_pct >= 0 AND progress_pct <= 100)`),
]);
export type TaskRow = typeof tasks.$inferSelect;

export const taskDependencies = pgTable("task_dependencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  predecessorId: uuid("predecessor_id").notNull().references(() => tasks.id),
  successorId: uuid("successor_id").notNull().references(() => tasks.id),
  // Column exists so SS/FF/SF become a CHECK widening later, not a migration --
  // only 'FS' (finish-to-start) is supported in Phase 3.
  type: text("type").notNull().default("FS"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("task_dependencies_type_valid", sql`type IN ('FS')`),
  check("task_dependencies_no_self_ref", sql`predecessor_id <> successor_id`),
  unique("task_dependencies_pred_succ_unique").on(t.predecessorId, t.successorId),
]);
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;

// notes/files: exactly one of the four possible parents. project_id joins
// company_id/contact_id/deal_id here rather than replacing them, since a
// note/file can be attached to a project instead. Tasks are deliberately NOT
// a fifth option here -- tasks are first-class work items in Phase 3, not
// attachment targets; commentary on work goes on the project or the linked
// CRM record.
const exactlyOne = sql`num_nonnulls(company_id, contact_id, deal_id, project_id) = 1`;

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  body: text("body").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("notes_exactly_one_entity", exactlyOne)]);
export type NoteRow = typeof notes.$inferSelect;

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalName: text("original_name").notNull(), mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(),
  uploaderUserId: uuid("uploader_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("files_exactly_one_entity", exactlyOne)]);
export type FileRow = typeof files.$inferSelect;

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  verb: text("verb").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  // No exactly-one CHECK on events (unlike notes/files): a deal event carries
  // both dealId AND companyId when the deal has a company, so both timelines
  // show it (Phase 2 plan, deals service task) -- zero, one, two, or three of
  // these can legitimately be set. Phase 3 extends the same reasoning to
  // taskId/projectId (a task event on a project-linked task carries both).
  dealId: uuid("deal_id").references(() => deals.id),
  taskId: uuid("task_id").references(() => tasks.id),
  projectId: uuid("project_id").references(() => projects.id),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check(
  "events_verb_valid",
  sql`verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened','shifted','completed','dependency_added','dependency_removed')`,
)]);
export type EventRow = typeof events.$inferSelect;

// --- Mail (Phase 4) ------------------------------------------------------
//
// Purely additive: no existing table changes. Indexes (the search GIN index,
// mail_messages(thread_id), mail_messages(message_id),
// mail_messages(account_id, folder, imap_uid), mail_messages(thread_id)
// WHERE seen = false -- the unread badge's partial index, quality-review
// ruling, Task 7 -- mail_attachments(message_id),
// mail_threads(last_message_at), the four
// mail_threads FK columns, and mail_accounts' partial unique index on
// (user_id, lower(email)) WHERE archived_at IS NULL -- duplicate-mailbox
// prevention, quality-review ruling) are deliberately NOT declared here via
// drizzle's index() builder -- no table in this codebase has used it so
// far, and keeping this migration's indexing as one hand-written block in
// drizzle/0004_*.sql (alongside the hand-written search column) keeps all of
// this migration's non-generatable SQL in one place instead of splitting it
// between schema.ts and the .sql file.

export const mailAccounts = pgTable("mail_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  // The account's own address, used for direction detection (from_addr ===
  // email, case-insensitively) and as the From header on send.
  email: text("email").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  imapSecurity: text("imap_security").notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecurity: text("smtp_security").notNull(),
  username: text("username").notNull(),
  // AES-256-GCM, format v1:<iv>:<tag>:<data>; see the Phase 4 spec's Key
  // handling section. Never selected into any API response.
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  sentFolder: text("sent_folder").notNull().default("Sent"),
  // Resolved automatically from a discovered folder's special_use
  // classification when NULL (services/mail-folders.ts, Phase 4.1 Task 2);
  // user-overridable in Settings. NULL is a real, meaningful state -- an
  // account whose Trash/Archive folder hasn't been classified yet (no LIST
  // pass has run, or the server offers neither SPECIAL-USE nor a matching
  // name heuristic) -- not "sync everything", so a bulk move against such an
  // account fails that account's threads with an explanatory error rather
  // than guessing a folder name (Phase 4.1 spec, data model).
  trashFolder: text("trash_folder"),
  archiveFolder: text("archive_folder"),
  signatureHtml: text("signature_html"),
  // NULL = sync everything, not "sync nothing" -- see mail-sync.ts (later
  // task)'s backfill, which treats NULL as "no lower bound."
  backfillDays: integer("backfill_days").default(90),
  // Phase 4.2: private by default, per account (spec's Decisions table).
  // Governs the inbox/record visibility predicate mail-threads.ts builds
  // once and applies to every mail read path: 'private' means only the
  // owner sees this mailbox's threads in their inbox (a thread can still
  // surface to other users on a record it is deliberately linked to --
  // that is the visibility predicate's record scope, not this column);
  // 'shared' restores the pre-4.2 behaviour of every synced thread being
  // visible to every CRM user. DEFAULT 'private' IS the migration: this
  // column's ALTER default is what makes every pre-existing account
  // private on upgrade, with no separate UPDATE/backfill statement needed
  // (schema.test.ts's withPreMigrationDatabase("0006") drill asserts a
  // pre-0006 row comes back private, not just that the column exists).
  visibility: text("visibility").notNull().default("private"),
  status: text("status").notNull().default("active"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mail_accounts_imap_security_valid", sql`imap_security IN ('tls','starttls')`),
  check("mail_accounts_smtp_security_valid", sql`smtp_security IN ('tls','starttls')`),
  check("mail_accounts_status_valid", sql`status IN ('active','error')`),
  check("mail_accounts_visibility_valid", sql`visibility IN ('private','shared')`),
]);
export type MailAccountRow = typeof mailAccounts.$inferSelect;

// One row per IMAP mailbox folder ever seen on an account (Phase 4.1's
// folder discovery -- services/mail-folders.ts, a later task). Rows are
// never deleted: a folder that vanishes from a later LIST keeps its row (and
// its messages keep their history) but drops out of the sync walk and the
// UI once last_discovered_at goes stale (Phase 4.1 spec, data model) --
// there is deliberately no archivedAt/deletedAt column here, unlike almost
// every other table in this file, because "stale" is read off
// last_discovered_at itself rather than a separate flag.
export const mailAccountFolders = pgTable("mail_account_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => mailAccounts.id),
  // The exact IMAP mailbox name, UTF-7 already decoded by imapflow's list()
  // (spec) -- not a display label. INBOX and the account's sent_folder are
  // the two well-known values every account carries even before the first
  // LIST discovers anything else (they are always walked regardless of this
  // table, per foldersOf's locked-on rule -- a later task).
  folder: text("folder").notNull(),
  // From the server's SPECIAL-USE attribute (RFC 6154) where offered, else a
  // case-insensitive name-heuristic fallback, else NULL when neither
  // classifies it (services/mail-folders.ts, Task 2). NULL is the normal
  // case for an ordinary user-created folder, not an error state -- hence no
  // "none" enum member, just NULL.
  specialUse: text("special_use"),
  // No SQL DEFAULT, unlike selectable below: the value this column takes on
  // first sight DEPENDS on the row's own classification (false for
  // junk/trash, true otherwise -- spec) rather than being one fixed value,
  // so it can only be an app-level default computed by the discovery service
  // (Task 2) at insert time. Same reasoning as deals.currency-style fields
  // elsewhere in this file (see deals.currency's comment above) -- config
  // the app decides, not a constant baked into the DDL.
  //
  // Provenance: this default is set ONLY on first sight -- Task 2's
  // discovery upsert must never overwrite an existing row's sync_enabled on
  // a later LIST pass (a user's toggle must survive re-discovery). One
  // consequence, accepted: the no-clobber rule also freezes the FIRST-sight
  // default forever. If a folder is later reclassified (e.g. a server
  // starts advertising SPECIAL-USE it didn't before, flipping an ordinary
  // folder to junk/trash), the already-stored sync_enabled does NOT
  // re-default to match the new classification -- only special_use updates.
  // Task 2 documents this precisely at the upsert site, where the no-clobber
  // logic actually lives.
  syncEnabled: boolean("sync_enabled").notNull(),
  // \Noselect folders (a pure hierarchy separator, no messages of its own)
  // are still listed -- for the picker and for classification -- but never
  // walked by sync regardless of sync_enabled (spec).
  selectable: boolean("selectable").notNull().default(true),
  // Bumped on every LIST pass that still sees this folder; a folder that
  // stops appearing keeps its last value here forever, which is exactly what
  // marks it stale (see this table's own comment above). No SQL DEFAULT --
  // always the real moment of discovery, supplied by the discovery service,
  // never a row-creation artifact (same reasoning as mail_messages.sent_at
  // and mail_folder_state.uidvalidity elsewhere in this file).
  lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mail_account_folders_special_use_valid", sql`special_use IN ('archive','drafts','junk','sent','trash')`),
  unique("mail_account_folders_account_folder_unique").on(t.accountId, t.folder),
]);
export type MailAccountFolderRow = typeof mailAccountFolders.$inferSelect;

// The incremental-sync cursor per (account, folder). No created_at -- unlike
// every other mail table, this one is pure mutable cursor state with no
// history worth keeping (see the Phase 4 spec's data model bullet for it,
// which lists only updated_at).
export const mailFolderState = pgTable("mail_folder_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => mailAccounts.id),
  folder: text("folder").notNull(),
  uidvalidity: bigint("uidvalidity", { mode: "number" }).notNull(),
  lastSeenUid: bigint("last_seen_uid", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("mail_folder_state_account_folder_unique").on(t.accountId, t.folder),
]);
export type MailFolderStateRow = typeof mailFolderState.$inferSelect;

// Threads are global, not per-account (spec: a conversation two users are
// both on is one thread) -- hence no accountId column here at all; accountId
// lives on mail_messages instead. The four link columns mirror
// notes/files/tasks' company/contact/deal/project columns, but deliberately
// WITHOUT their exactly-one CHECK: a thread can be linked to any subset (or
// none) of the four, set independently by auto-linking and manual links.
export const mailThreads = pgTable("mail_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  subject: text("subject").notNull(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
  messageCount: integer("message_count").notNull().default(0),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  // No archived/hidden column: since Phase 4.3 "hidden" is a per-viewer fact
  // (mail_thread_hides below), never a property of the shared thread row.
  // The pre-4.3 thread-global archived_at was dropped by 0007's second half.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type MailThreadRow = typeof mailThreads.$inferSelect;

// Phase 4.3: one row = "this USER has hidden this THREAD from their own CRM
// mail views" -- the per-user successor to the retired thread-global
// mail_threads.archived_at. Migration 0007 backfilled one hide row per
// (archived thread x existing user), carrying archived_at as hidden_at, so
// the upgrade changed nobody's view (spec, Migration decision), then dropped
// the column. This table is now the ONLY source of hide state: every default
// mail read path excludes the viewer's hidden threads through
// mail-threads.ts's hiddenByViewer predicate, and the Hidden view inverts
// that same arm.
//
// Composite PK (thread_id, user_id) rather than a surrogate id: the pair IS
// the identity ("has U hidden T"), it is the natural conflict target for an
// idempotent hide, and its index serves thread->hides lookups. Whether the
// per-user list predicate also wants a (user_id, thread_id) index is an
// EXPLAIN question for the read-path task (0007 stays unshipped and
// editable through the phase) -- nothing is added speculatively, per the
// house measure-first rule. Plain no-action FKs, matching every other FK in
// this file (threads are archive-not-delete; no delete path exists to
// cascade from).
export const mailThreadHides = pgTable("mail_thread_hides", {
  threadId: uuid("thread_id").notNull().references(() => mailThreads.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.threadId, t.userId] }),
]);
export type MailThreadHideRow = typeof mailThreadHides.$inferSelect;

/**
 * jsonb shape of mail_messages.to_addrs/cc_addrs/bcc_addrs -- mirrors
 * @conduit/shared's mailAddressSchema by hand (different packages, nothing
 * ties the two together automatically). Type-only: `.$type<>()` doesn't
 * validate anything at runtime, it just stops the column's rows showing up
 * as `unknown` at every call site that reads them.
 */
type MailAddressJson = { address: string; name?: string | null };

export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => mailAccounts.id),
  threadId: uuid("thread_id").notNull().references(() => mailThreads.id),
  // RFC 5322 Message-ID, or a synthetic "sha256:<hash>" when the source
  // message lacks one (spec). Paired with accountId in the UNIQUE below so
  // the same message seen twice (two folders, or a UIDVALIDITY refetch)
  // collapses to one row.
  messageId: text("message_id").notNull(),
  inReplyTo: text("in_reply_to"),
  // Column name is the SQL keyword "references" (drizzle quotes every
  // identifier it emits, same as every other column here, so this needs no
  // special handling in the generated DDL). The TS property is renamed to
  // referencesIds purely so call sites never have to write the awkward
  // `messages.references` -- a plain readability choice, not a technical
  // requirement.
  referencesIds: text("references").array().notNull().default([]),
  fromAddr: text("from_addr").notNull(),
  fromName: text("from_name"),
  toAddrs: jsonb("to_addrs").notNull().$type<MailAddressJson[]>(),
  ccAddrs: jsonb("cc_addrs").notNull().default([]).$type<MailAddressJson[]>(),
  // Populated for outbound only (spec) -- inbound ingest never learns Bcc.
  bccAddrs: jsonb("bcc_addrs").notNull().default([]).$type<MailAddressJson[]>(),
  subject: text("subject").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  bodyHtml: text("body_html"),
  snippet: text("snippet").notNull().default(""),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  folder: text("folder").notNull(),
  // NULL until an APPENDed send is next reconciled against the Sent folder
  // (spec, Send path step 5).
  imapUid: bigint("imap_uid", { mode: "number" }),
  seen: boolean("seen").notNull().default(false),
  direction: text("direction").notNull(),
  // GENERATED ALWAYS AS (...) STORED -- see searchVector's customType
  // comment above. Never written by the app (drizzle's insert type
  // correctly excludes it, since .generatedAlwaysAs() marks it generated);
  // Postgres computes it on every insert/update of the four source columns.
  search: searchVector("search").notNull().generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(from_addr,'') || ' ' || coalesce(from_name,''))`,
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mail_messages_direction_valid", sql`direction IN ('inbound','outbound')`),
  unique("mail_messages_account_message_unique").on(t.accountId, t.messageId),
]);
export type MailMessageRow = typeof mailMessages.$inferSelect;

export const mailAttachments = pgTable("mail_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => mailMessages.id),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  // Stored via the existing blobs service under $data_dir (spec).
  blobPath: text("blob_path").notNull(),
  contentId: text("content_id"),
  isInline: boolean("is_inline").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type MailAttachmentRow = typeof mailAttachments.$inferSelect;

// Shared across users (spec) -- no ownerUserId/authorUserId, unlike most
// other tables in this file.
export const emailTemplates = pgTable("email_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull().default(""),
  bodyHtml: text("body_html").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type EmailTemplateRow = typeof emailTemplates.$inferSelect;
