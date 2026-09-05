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
  // HOW THIS PERSON IS ADDRESSED (v1.1.0). Both nullable, both FREE TEXT, and
  // neither is ever inferred from the other or from the name -- a salutation of
  // "Dr" says nothing about pronouns, and a first name says nothing about either.
  //
  // NO ENUM AND NO VALUE-SET CHECK, deliberately. The picker in the UI offers Mr,
  // Mrs, Ms, Mx, Dr, Prof and he/him, she/her, they/them, but those six and those
  // three are a convenience: Dhr, Mevr, Drs, Ir, Ing, Rev, Sir, she/they and a
  // title in a language nobody here has thought of must all be typable. A
  // constraint on the value set would turn "type your own" into a 23514.
  //
  // The length bound is the only thing checked, and the Zod input schema
  // (createContactInputSchema) is the gate -- this is the backstop, the same
  // split as contacts.emails' format validation.
  salutation: text("salutation"),
  pronouns: text("pronouns"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  custom: jsonb("custom").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // 64 characters, which is CONTACT_FIELD_CAPS in @conduit/shared. Written as two
  // constraints rather than one so a refusal names the column that was too long.
  check("contacts_salutation_length", sql`char_length(salutation) <= 64`),
  check("contacts_pronouns_length", sql`char_length(pronouns) <= 64`),
]);
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
  // Phase 5's two pointer columns, both forward references (meetings is
  // declared at the foot of this file, mail_threads in the mail block below),
  // hence the explicit AnyPgColumn return types -- same reason as
  // pipelines.projectId above: TypeScript can't infer a forward-declared
  // column's type.
  //
  // meeting_id: the 'met'/'archived'/'unarchived' entries a meeting emits
  // carry it so the timeline row links back to the meeting it describes,
  // alongside the meeting's own record FKs in the columns above (the same
  // dual-stamp deals/tasks already use to land one event on several
  // timelines).
  //
  // A FOURTH row kind carries it, for a different reason: the 'created' event
  // of a task made from a meeting (Phase 5 Task 3, stamped by createTask's
  // origin parameter). There the meeting is PROVENANCE, not subject -- the row
  // is about the task, which reaches timelines through its own record links --
  // and that distinction is load-bearing at read time: timeline.ts's
  // attendance widening matches meeting_id AND task_id IS NULL, so a
  // provenance row never reaches an attendee-only contact's timeline, while a
  // client rendering that row still links back to the meeting through this
  // same column. services/meetings.ts's taskCreatedFromMeeting reads exactly
  // the meeting_id + task_id + 'created' triple.
  meetingId: uuid("meeting_id").references((): AnyPgColumn => meetings.id),
  // mail_thread_id is a POINTER AND NOTHING ELSE (Phase 5 spec, mail-privacy
  // decision). A mail event stores no subject, snippet or address anywhere --
  // not here, not in `payload` -- because a timeline entry is readable by
  // every user of the CRM while a thread is not: the subject is rendered at
  // READ time from mail_threads.subject through Phase 4.2's record-visible
  // predicate composed with Phase 4.3's not-hidden predicate, and a thread
  // the viewer may not see contributes no row at all (Task 4). Storing any
  // fragment of the message here would leak it past both predicates.
  mailThreadId: uuid("mail_thread_id").references((): AnyPgColumn => mailThreads.id),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check(
  // Phase 5 adds 'met' (a meeting was logged) plus 'mail_sent'/'mail_received'
  // (one per thread per direction per calendar day, Task 4's throttle).
  // Meeting archive/unarchive reuse the existing 'archived'/'unarchived'
  // verbs rather than adding meeting-specific ones, the way task reopening
  // reuses 'reopened'.
  "events_verb_valid",
  sql`verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened','shifted','completed','dependency_added','dependency_removed','met','mail_sent','mail_received')`,
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
  // Phase 8: HOW this account authenticates, and -- when that is OAuth -- with
  // WHOM. 'password' is an IMAP/SMTP login with the password sealed in
  // credentials_ciphertext (still the common case on a self-hosted install);
  // 'oauth_microsoft'/'oauth_google' mean the ciphertext holds a refresh token
  // instead (services/mail-crypto.ts's credential union).
  //
  // THIS COLUMN EXISTS SO SETTINGS NEVER HAS TO TOUCH mail.key. Rendering
  // "signed in with Microsoft" rather than a password field is a question
  // about every account in the list, and answering it by decrypting would
  // make the settings page depend on a key that can be missing (503) or
  // rotated -- for a fact that is not a secret in the first place. It is also
  // the only fact about an OAuth account that a route may return.
  //
  // ONE COLUMN, NOT A kind/provider PAIR. The provider is only meaningful when
  // the kind is OAuth, and a nullable second column would make "oauth with no
  // provider" and "password with a provider" both representable and both
  // meaningless -- states a CHECK would then have to forbid. Folding them
  // makes those states unspellable. The cost is that adding a third provider
  // is a CHECK migration rather than a row update, which is the right way
  // round: a provider Conduit has no code for should not be storable.
  //
  // DEFAULT 'password' IS THE MIGRATION, exactly as visibility's DEFAULT
  // 'private' was for 0006: the ALTER's default is what makes every
  // pre-existing account a password account on upgrade, with no separate
  // UPDATE statement (schema.test.ts's withPreMigrationDatabase("0014") drill
  // asserts a pre-0014 row comes back 'password', not merely that the column
  // exists). Every account that exists when this ships IS a password account
  // -- there has never been another way to make one -- so the default is not
  // an assumption, it is the only true value.
  //
  // NOT IN CONNECTION_FIELDS (services/mail-accounts.ts) and deliberately not
  // patchable: an account does not change how it authenticates through the
  // ordinary update path. Switching a password account to OAuth means signing
  // in, which is Task 3's authorise/callback pair writing both this column and
  // the ciphertext together.
  authMethod: text("auth_method").notNull().default("password"),
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
  check("mail_accounts_auth_method_valid", sql`auth_method IN ('password','oauth_microsoft','oauth_google')`),
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
// idempotent hide, and its index serves every hide probe. The
// (user_id, thread_id) index question was MEASURED and answered no by the
// read-path task: the candidate index left the Hidden view's worst-case
// plan untouched (the planner keeps the LIMIT-ordered thread scan and
// merely probes a different index), so nothing ships -- figures in 0007's
// own comment and beside listThreads in services/mail-threads.ts. Plain
// no-action FKs, matching every other FK in this file: neither referenced
// row is ever DELETED (threads have no delete path at all, and users are
// upsert-only), so there is nothing for a cascade to do.
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

// --- Meetings (Phase 5) --------------------------------------------------

// A logged meeting: what happened (or is arranged -- occurred_at is free in
// both directions, since noting a meeting you have just had and one you have
// just arranged are the same act, Phase 5 spec), who was there
// (meeting_attendees below), and which records it belongs to.
//
// The four record FKs follow the EVENTS multi-FK model, deliberately NOT
// notes'/files' exactly-one CHECK (`exactlyOne` above): a meeting about a
// deal legitimately carries that deal's company too, and it must appear on
// both records' Meetings tabs, the same way a deal event carries both dealId
// and companyId so it lands on both timelines. Any subset of the four may be
// set -- except the empty one, see the CHECK below.
export const meetings = pgTable("meetings", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  // The meeting's own moment, never a row-creation artifact -- no defaultNow()
  // here (same reasoning as mail_messages.sent_at and
  // mail_account_folders.last_discovered_at): the app supplies it, defaulting
  // to now only in the UI's form.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  // NULL is honest, not missing data: not every logged meeting has a known
  // length (spec's data model).
  durationMinutes: integer("duration_minutes"),
  // Rich-text HTML, sanitized on write by services/meetings.ts (Task 2)
  // through the system's ONE shared sanitizer profile -- sanitizeMailHtml in
  // services/mail-content.ts, which mail_accounts.signature_html and every
  // composed body reuse (see mail-accounts.ts and mail-send.ts).
  // notes.body is NOT that precedent despite the Phase 5 spec's wording: it
  // is plain text, stored raw and rendered as text (web: rail/notes.tsx's
  // whitespace-pre-wrap <p>), so it passes through no sanitizer at all.
  // This column is never a raw-HTML sink.
  notes: text("notes"),
  // NOT NULL, unlike companies/contacts/deals/projects' nullable
  // owner_user_id: a meeting is logged BY somebody (the actor, stamped
  // server-side), the way notes.author_user_id and files.uploader_user_id are.
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // REACHABILITY (Phase 5 spec's Decisions table). v0.9.0 ships no top-level
  // meetings list -- meetings are read through a record's Meetings rail tab
  // and that record's timeline, both of which are FK lookups -- so a meeting
  // linked to nothing would be unreachable from the moment it saved: no
  // screen could ever show it again, and nothing but a manual SQL query could
  // find it. The UI surfaces this as a required field; this CHECK is the
  // backstop for every other write path (same "Zod schemas are the primary
  // gate, the CHECK is the backstop" split as contacts.emails and
  // projects.color above), and its twin lives on
  // meetingCreateInputSchema (@conduit/shared) as a superRefine.
  //
  // Spelled with num_nonnulls to read as one family with notes'/files'
  // `exactlyOne` (num_nonnulls(...) = 1) above -- at-least-one and
  // exactly-one are then visibly the same rule at two different counts,
  // rather than one written as arithmetic and the other as a chain of ORs.
  check("meetings_has_link", sql`num_nonnulls(company_id, contact_id, deal_id, project_id) >= 1`),
]);
export type MeetingRow = typeof meetings.$inferSelect;

// One row per attendee of one meeting, in one of three mutually exclusive
// forms (spec's Attendees decision): a linked CRM contact, a Conduit user, or
// a free-text guest name for someone who is in neither ("and their lawyer").
// A contact row is a REAL link -- listMeetings' contactId filter matches a
// meeting whose contact_id is C OR which has an attendee row for C (Task 2),
// which is what makes the meeting appear on that contact's own record.
//
// No created_at, unlike almost every other table in this file: attendees are
// replaced as a SET on every update (spec: "attendees replaced as a set on
// update"), so a per-row timestamp would record the last time the list was
// edited, not when anyone attended anything -- the meeting's own occurred_at
// is the moment that matters, and mail_folder_state is the file's precedent
// for a table that carries no history worth keeping.
//
// The two partial UNIQUE indexes that stop the same contact or the same user
// being added twice to one meeting are hand-written in
// drizzle/0008_*.sql rather than declared here, matching this file's standing
// convention for every index (see the mail block's comment above) and
// 0004's mail_accounts_user_email_active_unique precedent specifically -- a
// semantic constraint expressed as a partial unique index, kept with the rest
// of its migration's non-generatable SQL.
export const meetingAttendees = pgTable("meeting_attendees", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id").notNull().references(() => meetings.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  userId: uuid("user_id").references(() => users.id),
  guestName: text("guest_name"),
}, (t) => [
  // notes_exactly_one_entity's pattern (`exactlyOne` above), over this
  // table's three identity columns: an attendee is exactly one of contact,
  // user or guest -- never two, never none. Its twin lives on
  // meetingAttendeeSchema (@conduit/shared) as a superRefine.
  check("meeting_attendees_exactly_one", sql`num_nonnulls(contact_id, user_id, guest_name) = 1`),
]);
export type MeetingAttendeeRow = typeof meetingAttendees.$inferSelect;

// --- Documents: quotes (Phase 7) -----------------------------------------
//
// Five tables, all new, nothing existing changes. Indexes follow this file's
// standing convention (see the mail block's note above): the ones that fall
// out of a UNIQUE constraint are declared here, and the one plain lookup
// index this migration needs -- documents(deal_id) -- is hand-written in
// drizzle/0009_*.sql alongside that migration's other non-generatable SQL
// (the seeded default template). drizzle's index() builder is still used by
// no table in this codebase.

// The ISSUER: your own company, as printed at the top of a quote. Conduit had
// nowhere to record this before -- every other party in the schema is a
// counterparty.
//
// A SINGLETON, spelled as a pinned primary key rather than a boolean column
// plus a unique index plus a CHECK. Both enforce one row; this one does it
// with two moving parts instead of four, and the difference is not only
// tidiness. With a defaultRandom() uuid the row's key is unpredictable, so
// every reader has to find the row before it can update it and the upsert has
// to target a *non-key* unique column -- the kind of thing that gets written
// correctly once and copied wrongly after. Pinned at 1, reading is
// `WHERE id = 1` and creating-or-updating is `ON CONFLICT (id) DO UPDATE`,
// both total and both obvious. The CHECK is what stops a second row: without
// it the DEFAULT is merely a suggestion and `INSERT ... (id) VALUES (2)`
// succeeds.
//
// The one deliberate divergence from this file's all-uuid habit, and it is
// the point: a uuid is for a row you will have many of.
export const orgProfile = pgTable("org_profile", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default(""),
  // Free text, newline-separated, exactly like companies.address -- there is
  // no structured address anywhere in this schema and inventing one here
  // would be a second answer. The seeded template renders it with
  // `white-space: pre-line` so the newlines survive into the PDF; merge
  // substitution HTML-escapes but does not translate them to <br>.
  addressLines: text("address_lines").notNull().default(""),
  vatNumber: text("vat_number").notNull().default(""),
  registrationNumber: text("registration_number").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  website: text("website").notNull().default(""),
  bankDetails: text("bank_details").notNull().default(""),
  // THE LOGO IS THE BYTES, NOT A FILE REFERENCE, and the first version of this
  // column was a uuid FK to files that could never be satisfied.
  // files_exactly_one_entity requires every file to belong to exactly one
  // company, contact, deal or project, and an issuer's logo belongs to none of
  // them -- so there was no legal row for that FK to point at, and the only way
  // to store a logo was to attach it to an unrelated record. Coordinator ruling
  // after Task 4's review: the logo lives here, as the data: URI that is
  // already the only form the renderer will accept.
  //
  // '' is the absence, matching every text field above rather than the FK's
  // nullability: the seeded template wraps the logo in {{#org.logoDataUri}},
  // so empty means no <img> is emitted at all.
  //
  // TWO CHECKS, because this column feeds a subprocess with a hard input cap.
  // The length bound is the base64 of a 300KB image plus the longest permitted
  // prefix -- 4 * ceil(307200/3) = 409600 characters plus 23 for
  // "data:image/jpeg;base64," -- so an oversized logo is refused here as well
  // as by orgProfileInputSchema, which is the usual "Zod is the gate, the
  // CHECK is the backstop" split. It was 43715 in v1.0.0, when the logo was
  // bounded at 32KB and shared one allowance with the document's own text;
  // 0010 raises it. What the column CANNOT check is the picture's dimensions,
  // which is the bound that actually protects the renderer -- see
  // MAX_LOGO_PIXELS. The shape bound keeps anything that is not
  // an inline image out of a src attribute; the renderer allowlists exactly
  // data: and nothing else, so a URL of any other scheme would fail every
  // render rather than fetch anything, but a column that can only hold what
  // the page can print is worth more than a comment saying so.
  logoDataUri: text("logo_data_uri").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("org_profile_singleton", sql`id = 1`),
  check("org_profile_logo_size", sql`char_length(${t.logoDataUri}) <= 409623`),
  // THE `\073` IS A SEMICOLON, AND IT HAS TO BE ONE. drizzle-kit's generator
  // splits a CHECK expression on `;` without regard for string literals, so
  // writing the character directly produced a migration truncated mid-regex --
  // `~ '^data:image/(png|jpeg|gif|webp)` with no closing quote and no closing
  // paren, which is a syntax error rather than a weakened constraint. Postgres
  // reads `\073` as the octal escape for ';', so the regex is the intended one
  // and nothing in the generated SQL can be mistaken for a statement end.
  check(
    "org_profile_logo_shape",
    sql`${t.logoDataUri} = '' OR ${t.logoDataUri} ~ '^data:image/(png|jpeg|gif|webp)\\073base64,[A-Za-z0-9+/]+={0,2}$'`,
  ),
]);
export type OrgProfileRow = typeof orgProfile.$inferSelect;

// An ISSUED document. There is no draft state and no update path: a row here
// means a PDF exists, and nothing ever rewrites either (Phase 7 spec's
// immutability decision). Hence no updated_at -- the column would only ever
// record a bug.
//
// The recipient is SNAPSHOT, not joined. A company that is renamed or moves
// office does not rewrite a quote somebody already has in their inbox, and
// companies/contacts carry no history that could reconstruct what was
// printed.
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Formatted per (type, year) as QUO-2026-0001, so the type prefix and the
  // year are already inside the string. UNIQUE GLOBALLY rather than per
  // (type, year), which sounds stricter than the numbering rule but forbids
  // nothing the numbering rule allows: two numbers can only collide if their
  // types share a prefix, and each type has its own. Global is also the
  // constraint that matches how a number is used -- someone quoting
  // "QUO-2026-0001" back at you never says which column it came from -- and
  // if a future type were ever given a colliding prefix, this rejects the
  // second document loudly at issue instead of minting a duplicate.
  number: text("number").notNull(),
  type: text("type").notNull(),
  dealId: uuid("deal_id").notNull().references(() => deals.id),
  // The rendered PDF, stored as an ordinary files row against the same deal,
  // so it appears on the Files tab and downloads through the existing
  // GET /api/files/:id with no second storage or download path.
  fileId: uuid("file_id").notNull().references(() => files.id),
  currency: char("currency", { length: 3 }).notNull(),
  issueDate: date("issue_date").notNull(),
  // Nullable: a quote with no expiry is a legitimate quote.
  validUntilDate: date("valid_until_date"),
  recipientName: text("recipient_name").notNull(),
  // The PERSON the quote is addressed to, snapshot beside the company's name.
  // Not in the spec's column list, which says "name and address as text" --
  // but the same spec has the form default its recipient from "the deal's
  // company AND contact", and a quote prints both ("Acme Ltd, FAO Jane
  // Smith"). With only the two columns the contact would have to be smuggled
  // into one of them, and the row would stop recording what was on the page,
  // which is the job the spec gives it. Defaulted to '' rather than nullable,
  // matching recipient_address: a quote to a company with no named contact is
  // ordinary, not missing data.
  recipientContactName: text("recipient_contact_name").notNull().default(""),
  // HOW THAT PERSON WAS ADDRESSED, SNAPSHOT AT ISSUE (v1.1.0), and this column
  // is the whole reason the release has a data model rather than a template
  // change. contacts.salutation is editable; a quote is not. Read live, a title
  // corrected next year would silently rewrite the greeting on a quote sent last
  // year -- the same failure recipient_name and recipient_address are copied to
  // avoid. Defaulted to '' like both of them: a quote with no salutation on it is
  // ordinary, and every row that existed before this column has one.
  //
  // PRONOUNS ARE DELIBERATELY NOT HERE. A quote's greeting takes the salutation
  // and has no use for them, and freezing a personal detail into an immutable
  // artifact that gets downloaded and emailed should need a reason. contacts.pronouns
  // is read live off the record wherever it is shown, which is the right lifetime
  // for it: a person who corrects their pronouns has corrected them everywhere at
  // once, and no stored copy disagrees.
  recipientSalutation: text("recipient_salutation").notNull().default(""),
  recipientAddress: text("recipient_address").notNull().default(""),
  // Integer cents, as deals.value_cents already is, computed by
  // @conduit/shared's documentTotals -- the same function the form's running
  // total uses. NOT recomputed on read: a later change to the arithmetic can
  // never restate an issued document.
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  notes: text("notes").notNull().default(""),
  terms: text("terms").notNull().default(""),
  issuedByUserId: uuid("issued_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("documents_number_unique").on(t.number),
  check("documents_type_valid", sql`type IN ('quote')`),
  // deals_currency_format's twin. A document's currency is copied from its
  // deal and printed on the page; the same three-letter rule has to hold or
  // the two records disagree about what the money is.
  check("documents_currency_format", sql`currency ~ '^[A-Z]{3}$'`),
  // The stored totals are the only totals anyone ever reads back, so the one
  // relation between them is worth asserting where no write path can skip it.
  // documentTotals() guarantees it by construction; this is the backstop for
  // every other write path, the same split as contacts.emails and
  // projects.color. A future discount or rounding column would alter this
  // CHECK in its own migration, exactly as each phase has widened
  // events_verb_valid.
  check("documents_totals_consistent", sql`total_cents = subtotal_cents + tax_cents`),
  // THE OTHER HALF OF A GUARD money.ts ONLY HAS ONE SIDE OF. documentTotals()
  // refuses to PRODUCE a total past Number.MAX_SAFE_INTEGER, because these are
  // bigint columns read through drizzle's `mode: "number"` and a larger value
  // would come back as the nearest double. Nothing stopped one arriving by
  // another path -- a psql session, an import, a future service that skipped the
  // shared arithmetic -- and being silently misread on the way out. Postgres
  // reaches 2^63; this pins the columns to the range the reader can represent.
  check(
    "documents_totals_representable",
    sql`subtotal_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND tax_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND total_cents BETWEEN -9007199254740991 AND 9007199254740991`,
  ),
]);
export type DocumentRow = typeof documents.$inferSelect;

// Frozen at issue, in the units packages/shared/src/money.ts defines: quantity
// in THOUSANDTHS, price in CENTS, tax in BASIS POINTS. The stored
// line_total_cents is what was printed.
//
// Per-line TAX is deliberately not stored. It is a pure function of two
// columns that are (taxCents(line_total_cents, tax_rate_bp)), and nothing
// prints it -- the page shows line totals and one document-level tax figure,
// and that figure IS stored -- so a column for it would be a second copy of a
// derivable number on a row whose whole point is that it never changes.
//
// POSITION IS AN INTEGER, not the fractional positionText that pipelines,
// stages, deals and tasks use. That is not an oversight, and it is the one
// place this table diverges from the house ordering pattern: fractional
// indexing exists so a drag-and-drop reorder writes ONE row instead of
// renumbering its siblings, and it buys that at the cost of a collation pin
// and unbounded key growth. Line items are inserted once, inside the
// transaction that issues the document, and never reordered afterwards --
// there is no drag to optimise, and 1..n is both denser and directly
// meaningful ("line 3"). The UNIQUE below is what makes the ordering total:
// without it two lines could share a position and the printed order would be
// whatever the planner felt like.
//
// NO ON DELETE CASCADE, matching every other foreign key in this file (there
// is not one onDelete clause in the schema). A document is never deleted, so
// a cascade would be configuration that can only fire by accident; the
// default NO ACTION means a stray DELETE fails loudly rather than quietly
// taking the priced lines of an issued quote with it.
export const documentLineItems = pgTable("document_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  qtyMilli: integer("qty_milli").notNull(),
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
  taxRateBp: integer("tax_rate_bp").notNull().default(0),
  lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
}, (t) => [
  // Also the index that serves "every line of this document, in order" --
  // document_id leads, so no separate foreign-key index is needed.
  unique("document_line_items_document_position_unique").on(t.documentId, t.position),
  check("document_line_items_qty_nonneg", sql`qty_milli >= 0`),
  check("document_line_items_price_nonneg", sql`unit_price_cents >= 0`),
  check("document_line_items_tax_range", sql`tax_rate_bp BETWEEN 0 AND 10000`),
  // documents_totals_representable's twin, on this table's two bigint columns,
  // for the same reason: `mode: "number"` stops at 2^53 and Postgres does not.
  check(
    "document_line_items_amounts_representable",
    sql`unit_price_cents <= 9007199254740991 AND line_total_cents BETWEEN -9007199254740991 AND 9007199254740991`,
  ),
]);
export type DocumentLineItemRow = typeof documentLineItems.$inferSelect;

// A TABLE, not a Postgres SEQUENCE, and the difference is the point: nextval()
// is explicitly non-transactional, so a render that failed after taking a
// number would leave a permanent hole in the quote sequence -- and a hole
// invites the question of what was in it. A row rolls back with its
// transaction.
//
// Allocated with one INSERT ... ON CONFLICT DO UPDATE ... RETURNING, whose
// row lock serialises two quotes of the same type in the same year. That is
// the behaviour you want: consecutive numbers are consecutive.
export const documentNumberSequences = pgTable("document_number_sequences", {
  type: text("type").notNull(),
  year: integer("year").notNull(),
  lastValue: integer("last_value").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.type, t.year] }),
  // The same enum documents.type carries. A typo'd type here would silently
  // start a private numbering series rather than failing.
  check("document_number_sequences_type_valid", sql`type IN ('quote')`),
]);
export type DocumentNumberSequenceRow = typeof documentNumberSequences.$inferSelect;

// One editable template per document type, seeded with a working default in
// drizzle/0009_*.sql so a quote renders before anyone has opened Settings.
// NOT sanitised with the mail profile: mail's exists to defang HTML written by
// strangers, and it strips exactly the page-layout CSS a printed document is
// made of. See services/documents-template.ts for the profile this one uses.
export const documentTemplates = pgTable("document_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  bodyHtml: text("body_html").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("document_templates_type_unique").on(t.type),
  check("document_templates_type_valid", sql`type IN ('quote')`),
]);
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
