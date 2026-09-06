import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, char, date, boolean, check, unique, primaryKey, foreignKey, customType } from "drizzle-orm/pg-core";
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

// A FIFTH PARENT SINCE 0017, AND ONLY ON `files` -- `notes` keeps the four.
//
// The reason is not that a meeting can have files; it is that a meeting can have
// a DOCUMENT. `documents.file_id` is NOT NULL and every rendered PDF is an
// ordinary `files` row (Phase 7's design, and what makes GET
// /api/files/:id/download the only download path there is), so a meeting summary
// -- whose `documents` row sets meeting_id and nothing else -- needed somewhere
// to put its page. The three alternatives were all worse: filing it under one of
// the meeting's OWN links (a meeting may carry a company AND a deal AND a
// project, so "which one" is an arbitrary rule, and the file would then be
// attached to a record its own document says it is not about); making
// `documents.file_id` nullable and giving documents a second, private blob path
// (two download routes, two storage stories); or a `meeting_files` table (a
// second files table, so every reader of files becomes two readers).
//
// notes stays at four, and `exactlyOne` above is still notes' rule, spelled once.
// The Phase 5 argument for excluding meetings -- "a note about a meeting goes on
// the meeting's own record" -- is untouched by any of this: it is about what a
// PERSON writes, and a rendered document is not written by a person.
const filesExactlyOne = sql`num_nonnulls(company_id, contact_id, deal_id, project_id, meeting_id) = 1`;

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalName: text("original_name").notNull(), mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(),
  uploaderUserId: uuid("uploader_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  // Forward reference (meetings is declared at the foot of this file), hence the
  // explicit AnyPgColumn return type -- same reason as events.meetingId above.
  //
  // NOT REACHABLE FROM THE UPLOAD ROUTE, deliberately: POST /api/files still
  // parses the four, so the only writer that can set this column is
  // services/documents.ts issuing a meeting summary. The CHECK admits it because
  // the CHECK is about what a row may BE; which callers may write one is the
  // route's question and it answers it more narrowly.
  meetingId: uuid("meeting_id").references((): AnyPgColumn => meetings.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [check("files_exactly_one_entity", filesExactlyOne)]);
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
  // What the sync loop last had to say, and its ONLY writer is that loop
  // (mail-sync.ts's writeAccountState) plus updateAccount's clear-a-stale-error
  // branch. See @conduit/shared's mailAccountStatusSchema for what the three
  // values mean.
  //
  // 'auth_required' IS PHASE 8 TASK 2's, and it is the account state the spec's
  // Risk 3 asks for: an OAuth grant the provider has stopped honouring. It is
  // separate from 'error' because it is the one failure retrying cannot clear
  // -- the engine will get the identical refusal every 32 minutes until a human
  // signs in again -- so the Settings row has to say "sign in again" rather
  // than showing an error that reads like a server having a bad day.
  //
  // NOT RESET BY AN ORDINARY EDIT, unlike 'error': updateAccount's
  // shouldResetStatus is gated on `status === 'error'`, so relabelling an
  // account cannot clear a re-authorisation it still needs. Whether the grant
  // came back is the sync loop's question and it answers it on the next pass.
  status: text("status").notNull().default("active"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("mail_accounts_imap_security_valid", sql`imap_security IN ('tls','starttls')`),
  check("mail_accounts_smtp_security_valid", sql`smtp_security IN ('tls','starttls')`),
  check("mail_accounts_status_valid", sql`status IN ('active','error','auth_required')`),
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
  //
  // **SINCE v1.9.0 THIS COLUMN IS SUMMED**, by services/timesheet.ts, which is
  // Phase 10's decision that the timesheet reads meetings and time entries
  // together -- a logged meeting with a duration is a recorded hour, and it had
  // held one since Phase 5 with nothing ever adding it up. Two consequences
  // that are decisions rather than side effects:
  //
  //   THE NULL IS STILL NOT A ZERO, AND IS REPORTED AS ITSELF. The timesheet
  //   answers a count of meetings with no recorded length beside its total,
  //   because a report that silently treats "unknown" as "none" is the spec's
  //   own named failure. That count is in the operator's sentence
  //   (`timesheetSummary`), not merely in the payload.
  //
  //   **THERE IS STILL NO CHECK ON THE VALUE, AND THE REASON HAS CHANGED.** The
  //   old reason was "nothing sums it", which this release made false;
  //   time_entries.minutes cites that contrast and has been corrected too. The
  //   reason now is that a meeting has no definitional bound to CHECK against.
  //   `time_entries.minutes <= 1440` follows from `work_date` being one day; a
  //   meeting's `occurred_at` is a START, and an offsite logged as one meeting
  //   can legitimately run longer than a day. A 1440 here would refuse a true
  //   row to catch a mistyped one, and it would not catch the mistype that
  //   actually happens (60 typed as 600 passes any bound this column could
  //   carry). WHAT IS GENUINELY EXPOSED is that the zod shape has no upper bound
  //   either -- `z.number().int().positive()` accepts 999999999, which is now a
  //   number that can dominate a week's total. Adding a max to `meetingSchema`
  //   would make the CLIENT refuse to parse any meeting already carrying such a
  //   value, turning a silly figure into a broken page, so it is written down
  //   here and in the plan rather than changed in passing.
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
  // THE ORGANISATION'S CLOCK -- the whole of v1.8.0's answer to "Conduit stores no
  // timezone anywhere", which is what Phase 9 Task 2 reported when the meeting
  // summary had to print `13:30 UTC` for a meeting the operator held at 15:30.
  //
  // ONE COLUMN, ON THE ISSUER, AND NOT ON `users`. A document is printed by the
  // organisation and sent outward: two people in one Conduit issuing summaries of
  // the same meeting must produce the same page, which a per-user zone could not
  // promise. (A per-user zone is a separate and defensible thing for the SCREEN;
  // the rail already has it, from the browser, for free.)
  //
  // '' IS NOT THE ABSENCE HERE, which is where this column differs from every text
  // field above it. Those are optional on a printed page and the seeded template
  // wraps each in a conditional; there is no such thing as formatting an instant
  // in no zone, so the default is a real value.
  //
  // 'UTC' RATHER THAN THE SERVER'S ZONE, and 0018 backfills the same. It is the
  // only value that leaves an existing install's documents printing exactly what
  // they printed before -- `formatDocumentInstant` with this zone emits the v1.7.x
  // string byte for byte. See DEFAULT_TIME_ZONE in @conduit/shared, which this
  // literal duplicates because schema.ts imports nothing from that package (it is
  // read by drizzle-kit outside the workspace's resolution); schema.test.ts asserts
  // the two are the same string, which is the codebase's usual answer to a
  // duplicated constant.
  //
  // THE CHECK IS A SHAPE AND CANNOT BE MORE. PostgreSQL has no tzdata opinion a
  // `text` column can consult, so "is this a real zone" is answered by
  // `timeZoneProblem` in the service, with this as the backstop -- the standing
  // Zod-is-the-gate split. What it CAN do is refuse the two shapes that are wrong
  // by inspection: nothing at all, and a fixed offset (`+02:00`), which `Intl`
  // accepts and which cannot observe daylight saving. Anchored to a leading letter
  // rather than listing the sign characters, so an offset in any spelling is out.
  timeZone: text("time_zone").notNull().default("UTC"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("org_profile_singleton", sql`id = 1`),
  check(
    "org_profile_time_zone_shape",
    sql`${t.timeZone} ~ '^[A-Za-z][A-Za-z0-9_+/-]*$' AND char_length(${t.timeZone}) <= 64`,
  ),
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

// A DOCUMENT -- the part that is common to every type, and nothing else.
//
// UNTIL PHASE 9 THIS WAS A QUOTE TABLE WEARING A GENERIC NAME, and the columns
// that are no longer here are the evidence: currency, subtotal_cents, tax_cents,
// total_cents and recipient_name were all NOT NULL, plus valid_until_date and a
// NOT NULL deal_id. A meeting summary has no currency; a letter has no total.
// Five shapes could not keep those promises, so the quote's own columns moved to
// document_quotes below (migration 0016) and this table kept the identity, the
// type, the rendered file, the issue date, the issuer, what the document is
// attached to, and whether it is frozen. That list is the whole design.
//
// REJECTED, BECAUSE THE CHEAP OPTION IS GENUINELY TEMPTING: make the money
// columns nullable and add each new type's columns beside them. One table, no
// join, a far smaller migration -- and it deletes every guarantee at once.
// `currency NOT NULL` becomes "currency, sometimes", and nothing then prevents a
// meeting summary carrying a tax total: the wrong shape stops being unspellable
// and becomes merely unusual. Also rejected: a JSON payload per type, which
// moves validation out of the database into whichever reader remembers, and
// which a documents list showing totals would have to unpack per row.
//
// THE RECIPIENT WENT WITH THE MONEY, and that is the one column group where the
// split is a judgement rather than a deduction. An NDA and a letter are also
// addressed to somebody, so "recipient" looks common at three types out of five
// -- but the four columns as they exist are shaped by the QUOTE: a salutation
// column exists because a quote prints a greeting, and recipient_contact_name
// because a quote prints "Acme Ltd, FAO Jane Smith". Generalising a party model
// from the one type that has been built is exactly how this table became a quote
// table in the first place. Tasks 3 and 4 have the two further types that would
// have to agree with it; if they do, a common `document_parties` is a migration
// they can make with three examples in front of them instead of one.
//
// STILL NO updated_at. Phase 7's "a row here means a PDF exists, and nothing
// ever rewrites either" holds for the quote exactly as it did; `frozen` below is
// where that stopped being a property of documents in general.
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
  //
  // NULLABLE SINCE 0017, WHICH IS THE MIGRATION THIS COMMENT USED TO PREDICT.
  // The meeting summary is the type that wants no number, and
  // @conduit/shared's documentTypeNumbered() carries the three reasons it was
  // given (an external handle nobody holds; a lock that would serialise
  // issuing to buy a string nobody reads; and a type that can be produced
  // again, which a number cannot survive).
  //
  // THE UNIQUE CONSTRAINT SURVIVES THE NULLS UNCHANGED, and that is why this
  // needed no second index. PostgreSQL treats NULLs as distinct in a UNIQUE
  // constraint by default (NULLS NOT DISTINCT is opt-in, PG15+), so every
  // unnumbered document is unique from every other one for free, and the
  // numbered types keep exactly the guarantee they had. A partial unique index
  // `WHERE number IS NOT NULL` would say the same thing in more SQL.
  //
  // WHAT REPLACES `NOT NULL` IS documents_number_matches_type BELOW, which is
  // strictly stronger: NOT NULL forbade an unnumbered quote, and the CHECK
  // forbids that AND a numbered meeting summary, which NOT NULL never could.
  number: text("number"),
  type: text("type").notNull(),
  // EXACTLY ONE OF FIVE, and the CHECK below is `notes`'/`files`' `exactlyOne`
  // with meeting_id added -- the same rule, already enforced in two places,
  // copied rather than invented. It is not literally that constant because that
  // one names four columns: notes and files deliberately exclude meetings (a
  // note about a meeting goes on the meeting's own record), while a document
  // ABOUT a meeting is the whole point of the meeting summary.
  //
  // A DOCUMENT BELONGS TO EXACTLY ONE THING, which is Chris's decision of 6 Sep
  // and is the strict reading rather than `meetings_has_link`'s at-least-one. An
  // NDA naming a contact at a company attaches to the COMPANY and names the
  // contact in its content; that was the trade, and reopening it is his call
  // rather than a CHECK to widen quietly.
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  // NO LONGER NOT NULL, which is the smaller half of what Phase 9 did to this
  // table and the only half the backlog had noticed. Every row that existed
  // before 0016 is a quote and still carries it.
  dealId: uuid("deal_id").references(() => deals.id),
  // THE LAST OF THE FIVE TO GET A READER, WHICH IS WHY IT IS ALSO THE LAST TO GET
  // AN INDEX (0020's `documents_project_idx`). 0016 added all five columns and
  // indexed none of them, on the grounds that nothing selected documents by any
  // of them; each index has since been built by the migration that added the
  // first SELECT that needed it -- meeting in 0017, company and contact in 0019,
  // this one in 0020 for `listProjectDocuments`.
  projectId: uuid("project_id").references(() => projects.id),
  meetingId: uuid("meeting_id").references(() => meetings.id),
  // The rendered PDF, stored as an ordinary files row against the same record,
  // so it appears on the Files tab and downloads through the existing
  // GET /api/files/:id/download with no second storage or download path.
  //
  // CONTENT-ADDRESSED, WHICH IS WHY 0016 DOES NOT TOUCH IT. blobPath() is
  // derived from files.sha256 alone, so a migration that leaves this column and
  // that row alone leaves the PDF reachable and unchanged -- an existing quote
  // opens afterwards without anything having re-rendered it.
  fileId: uuid("file_id").notNull().references(() => files.id),
  issueDate: date("issue_date").notNull(),
  // WHETHER THIS DOCUMENT MAY STILL CHANGE, AND IT IS PER TYPE (Chris, 6 Sep).
  // A quote and an NDA freeze on issue: both are handed to somebody else, and an
  // agreement you can silently edit after sending is a different kind of
  // document from one you cannot. A meeting summary, a status report and a
  // letter do not: a stale status report is worse than an edited one, and a
  // letter wants redrafting before it goes.
  //
  // A COLUMN RATHER THAN A LOOKUP AT EVERY CALL SITE. Phase 7 made "an issued
  // document never changes" unconditional -- there is no update path at all --
  // and Task 3 is where that guard becomes conditional, which the spec names as
  // the place a mistake would let a quote be edited. A guard that re-derives
  // policy from the type at each call site is a guard that can be written wrong
  // once per call site; one that reads a fact off the row cannot.
  //
  // **AND IT IS READ NOW, IN THREE PLACES, WHICH IS WHAT TASK 3 BUILT.** Task 1
  // shipped this column with the note "nothing READS the column yet". The three
  // readers, weakest first:
  //
  //   1. `redraftLetter`'s UPDATE carries `AND frozen = false` in its WHERE, so
  //      the test and the write are ONE statement and there is no window between
  //      them. Zero rows updated is the refusal.
  //   2. That function is the ONLY thing in this codebase that UPDATEs a row in
  //      `documents` or in any detail table, so there is one call site to get
  //      right rather than one per type.
  //   3. **`conduit_document_frozen_guard`, A TRIGGER, WHICH IS THE ONE THAT
  //      MAKES THE RULE A PROPERTY OF THE DATABASE.** Added by 0019 on
  //      `documents` and on all three detail tables, BEFORE UPDATE OR DELETE, it
  //      refuses any change to a row whose document is frozen -- including from
  //      a psql session, an import, and a call site nobody has written yet.
  //
  // WHY A TRIGGER AND NOT A CHECK: a CHECK sees only the row being written, and
  // this rule is about the row that is ALREADY THERE. `frozen` is not "this
  // value must be legal", it is "this row may not change", and OLD is a thing
  // only a trigger has. It is declared in the migration and NOT in this file --
  // drizzle-kit has no vocabulary for a trigger, exactly as it has none for
  // 0013's `conduit_lower_emails` -- so 0013's consequence stands here too:
  // `drizzle-kit push` must never be introduced, because it would drop objects
  // it has no schema.ts record of.
  //
  // NO DEFAULT, AND THAT IS DELIBERATE. 0016 adds the column WITH `DEFAULT true`
  // -- a metadata-only ADD COLUMN that fills every pre-existing row with the
  // only value that was ever true of it, the same arrangement 0014's
  // auth_method used -- and then drops the default in the same migration. Unlike
  // auth_method there WILL be a type whose answer is false, so a writer that
  // forgets to say must fail loudly rather than inherit "frozen". It also keeps
  // documents_frozen_matches_type from being satisfiable by accident.
  frozen: boolean("frozen").notNull(),
  issuedByUserId: uuid("issued_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("documents_number_unique").on(t.number),
  // THE TARGET OF document_quotes' COMPOSITE FOREIGN KEY, and its only purpose.
  // `id` is already the primary key, so this constraint forbids nothing a row
  // could otherwise do -- PostgreSQL simply requires a UNIQUE over the exact
  // column list a foreign key references, and (id, type) is that list. See
  // document_quotes below for what the key buys and why 0017 is where it
  // arrives rather than 0016.
  unique("documents_id_type_unique").on(t.id, t.type),
  check(
    "documents_type_valid",
    sql`type IN ('quote','meeting_summary','letter','nda','mutual_nda','project_status_report')`,
  ),
  // WHETHER THIS TYPE IS NUMBERED, IN THE DATABASE, so `documents.number` and
  // @conduit/shared's documentTypeNumbered() cannot drift apart -- the same
  // arrangement documents_frozen_matches_type has with documentTypeFreezes(),
  // and schema.test.ts asserts these two spellings agree for every type too.
  //
  // AN EQUALITY, NOT AN IMPLICATION, for documents_frozen_matches_type's
  // reason exactly: a quote with no number is the failure that matters (it is
  // what `NOT NULL` used to forbid, and dropping that must not lose it), and a
  // meeting summary that acquired one is a stored fact disagreeing with the
  // declared rule -- which is not hypothetical, since `formatDocumentNumber`
  // has a `?? "DOC"` fallback that would happily mint `DOC-2026-0001` for any
  // type that reached it.
  //
  // WIDENED IN 0019 FOR THE TWO AGREEMENTS, which are numbered for the reasons
  // documentTypeNumbered gives -- a handle somebody else's legal team holds, an
  // auditable per-year sequence, and no way for the number to come loose from
  // its content because an agreement is frozen. The letter is deliberately not
  // in the list.
  //
  // **0020 DID NOT TOUCH IT, AND THAT IS THE EQUALITY EARNING ITS KEEP AGAIN.**
  // The status report is unnumbered, so it belongs on the FALSE side and there
  // is nothing to widen -- the row reads `false = false`. An implication would
  // have left a numbered report legal in silence, which
  // `formatDocumentNumber`'s `?? "DOC"` fallback would have minted as
  // `DOC-2026-0001` the first time anybody called `allocateNumber` for one.
  check(
    "documents_number_matches_type",
    sql`(number IS NOT NULL) = (type IN ('quote','nda','mutual_nda'))`,
  ),
  // Spelled exactly like notes'/files' `exactlyOne` above, one column wider.
  check(
    "documents_exactly_one_entity",
    sql`num_nonnulls(company_id, contact_id, deal_id, project_id, meeting_id) = 1`,
  ),
  // **WHICH ONE OF THE FIVE, PER TYPE -- THE OTHER HALF OF THE RULE ABOVE, AND IT
  // TOOK UNTIL 0020 TO BE WRITABLE.** `documents_exactly_one_entity` says how
  // MANY records a document names. It has never said WHICH, so until this
  // constraint existed nothing in the database stopped a letter carrying a
  // `deal_id` or a quote carrying a `meeting_id` -- only the writers did. Task 3
  // found that (its `redraftLetter` still carries the branch it needed for a
  // letter attached to neither a company nor a contact, a row it produced by
  // hand) and deliberately left the CHECK unwritten, because it is a rule about
  // ALL the types and two of them did not exist yet. Writing it then would have
  // been 0016's mistake again: generalising from the types that happened to have
  // been built.
  //
  // THE TWO CHECKS ARE A PAIR AND NEITHER IS SUFFICIENT ALONE. Read by itself,
  // the first arm here permits a quote naming a deal AND a company; the count
  // above is what forbids that. Spelling `num_nonnulls(...) = 1` into all four
  // arms would state one rule five times and make the next type's author edit
  // two constraints to change one thing.
  //
  // **EVERY ARM SAYS ONLY WHICH COLUMN, NEVER HOW MANY, AND THE LETTER FAMILY'S
  // IS WHERE THAT MATTERS.** The plan sketched it as
  // `num_nonnulls(company_id, contact_id) = 1`, which admits exactly the same
  // rows once the count CHECK is standing beside it -- and costs the one thing
  // this schema keeps paying to protect. A letter naming BOTH a company and a
  // contact would then violate two constraints at once, so PostgreSQL would name
  // whichever it reached first and `documents_exactly_one_entity` -- Chris's
  // decision of 6 Sep, the one this pair exists to enforce -- could no longer be
  // probed by name for the case it is most about. `IS NOT NULL OR IS NOT NULL`
  // says "the record is one of these two" and leaves the counting where the
  // counting lives.
  //
  // WHAT STILL OVERLAPS, unavoidably, is an UNKNOWN type: it satisfies no arm
  // here and also breaks `documents_type_valid`, so those two can only be told
  // apart from the catalogue. db/schema.test.ts does that instead.
  //
  // EVERY ROW THAT EXISTS SATISFIES IT, so 0020 adds it validated with no
  // backfill -- which is what made it, in Task 3's words, "a free migration
  // whenever it is taken".
  check(
    "documents_entity_matches_type",
    sql`(type = 'quote' AND deal_id IS NOT NULL)
      OR (type = 'meeting_summary' AND meeting_id IS NOT NULL)
      OR (type = 'project_status_report' AND project_id IS NOT NULL)
      OR (type IN ('letter','nda','mutual_nda')
          AND (company_id IS NOT NULL OR contact_id IS NOT NULL))`,
  ),
  // THE PER-TYPE FREEZING RULE, IN THE DATABASE, so the column and
  // @conduit/shared's documentTypeFreezes() cannot drift apart -- the same
  // arrangement mailAuthMethodSchema has with mail_accounts_auth_method_valid,
  // and schema.test.ts asserts the two spellings agree for every type.
  //
  // AN EQUALITY, NOT AN IMPLICATION, so neither direction can be wrong: a quote
  // that is not frozen is the failure that matters, and a letter that is frozen
  // for no reason is a stored fact disagreeing with the declared rule.
  //
  // **THE LIST DID NOT WIDEN WHEN THE SECOND TYPE ARRIVED**, and this sentence
  // replaces one that assumed it would ("each later type widens the list here").
  // `meeting_summary` is not frozen, so it belongs on the FALSE side and the
  // clause is unchanged -- which is exactly why the equality had to be written
  // both ways round in 0016. An implication (`type IN ('quote') -> frozen`)
  // would have admitted a frozen meeting summary in silence, and with one type
  // in existence nothing could have told the two spellings apart.
  //
  // **IT WIDENED IN 0019, WHICH IS WHERE THE PREVIOUS SENTENCE SAID IT WOULD.**
  // The letter joins the summary on the FALSE side; the NDA and the mutual NDA
  // are the second and third TRUE members this column has ever had.
  //
  // **AND IT DID NOT WIDEN IN 0020.** The status report joins the summary and
  // the letter on the FALSE side -- a stale report is worse than an edited one
  // -- so at six types the TRUE side is still the three commercial documents
  // somebody else holds a copy of. That is now the shape of the rule rather than
  // an accident of which types exist: freezing is for a document whose bytes
  // somebody outside this database is relying on.
  check("documents_frozen_matches_type", sql`frozen = (type IN ('quote','nda','mutual_nda'))`),
]);
export type DocumentRow = typeof documents.$inferSelect;

// THE QUOTE'S OWN COLUMNS -- which is to say, `documents`' columns until 0016
// moved them here. Nothing about a quote changed; what changed is that a
// meeting summary is no longer obliged to have a currency.
//
// KEYED BY document_id, WHICH IS ALSO THE PRIMARY KEY. One detail row per
// document, said by the database rather than by convention: a second row for
// the same document is not something any reader would know what to do with, and
// a surrogate id would have made it representable for nothing. The key is also
// the only index this table needs -- every read of it is "the quote detail for
// these documents".
//
// THE COMPOSITE (document_id, type) FOREIGN KEY, WHICH 0016 DEFERRED AND 0017
// ADDS. It is the standard trick for making "a meeting summary with a tax total"
// unspellable rather than merely unusual, and Task 1's note said Task 2 was both
// the first moment it would catch anything and the first moment it could be
// tested as more than structure. Both turned out true, so it is here.
//
// WHAT IT ACTUALLY CATCHES, because "unspellable" is easy to say and this buys
// one specific thing: without it, `INSERT INTO document_quotes (document_id, ...)`
// naming a meeting summary's id succeeds, and that row is not inert -- every read
// of a quote in this codebase is an INNER JOIN on document_id (listDocuments,
// export.ts's documentsSheet), so the summary would start being RETURNED as a
// quote, with a currency and three money columns, by code that never asked
// whether it was one. The join is what makes the missing constraint reachable.
//
// THE REDUNDANT COLUMN COSTS NOTHING TO KEEP IN STEP, which was the objection.
// `type` here is NOT NULL DEFAULT 'quote' with a CHECK pinning it to 'quote', so
// it is a constant: no writer mentions it, no writer can change it, and there is
// no path by which it can disagree with the row it describes. What it buys is
// that PostgreSQL then has a column to match against documents(id, type). The
// cost is one text column per quote row and one more unique index on
// `documents`; the deployment target holds tens of quotes.
//
// WHY NOT IN 0016: that migration moved live rows out of `documents`, and adding
// a column to the table it was creating -- for a constraint that could not be
// exercised, because a second type did not exist -- would have put untestable
// structure into the one migration in this project that could destroy data. This
// one adds a column to a table with a handful of rows in it and a test that fails
// without it.
//
// NO ON DELETE CASCADE, matching every other foreign key in this file. A
// document is never deleted, so a cascade would be configuration that can only
// fire by accident.
export const documentQuotes = pgTable("document_quotes", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  // A CONSTANT. See the composite key above: this exists so a foreign key has a
  // column to match documents.type against, and the CHECK below is what makes it
  // a fact rather than a field. It is deliberately not in `DocumentQuoteRow`'s
  // useful surface -- nothing reads it, and a reader that wanted a document's
  // type would read `documents.type`, which is where it lives.
  type: text("type").notNull().default("quote"),
  currency: char("currency", { length: 3 }).notNull(),
  // Nullable: a quote with no expiry is a legitimate quote.
  validUntilDate: date("valid_until_date"),
  // The recipient is SNAPSHOT, not joined. A company that is renamed or moves
  // office does not rewrite a quote somebody already has in their inbox, and
  // companies/contacts carry no history that could reconstruct what was printed.
  recipientName: text("recipient_name").notNull(),
  // The PERSON the quote is addressed to, snapshot beside the company's name.
  // Not in the Phase 7 spec's column list, which says "name and address as text"
  // -- but the same spec has the form default its recipient from "the deal's
  // company AND contact", and a quote prints both ("Acme Ltd, FAO Jane Smith").
  // With only the two columns the contact would have to be smuggled into one of
  // them, and the row would stop recording what was on the page. Defaulted to ''
  // rather than nullable, matching recipient_address: a quote to a company with
  // no named contact is ordinary, not missing data.
  recipientContactName: text("recipient_contact_name").notNull().default(""),
  // HOW THAT PERSON WAS ADDRESSED, SNAPSHOT AT ISSUE (v1.1.0), and this column
  // is the whole reason that release had a data model rather than a template
  // change. contacts.salutation is editable; a quote is not. Read live, a title
  // corrected next year would silently rewrite the greeting on a quote sent last
  // year -- the same failure recipient_name and recipient_address are copied to
  // avoid. Defaulted to '' like both of them: a quote with no salutation on it is
  // ordinary, and every row that existed before this column has one.
  //
  // PRONOUNS ARE DELIBERATELY NOT HERE. A quote's greeting takes the salutation
  // and has no use for them, and freezing a personal detail into an immutable
  // artifact that gets downloaded and emailed should need a reason.
  // contacts.pronouns is read live off the record wherever it is shown, which is
  // the right lifetime for it: a person who corrects their pronouns has
  // corrected them everywhere at once, and no stored copy disagrees.
  recipientSalutation: text("recipient_salutation").notNull().default(""),
  recipientAddress: text("recipient_address").notNull().default(""),
  // Integer cents, as deals.value_cents already is, computed by @conduit/shared's
  // documentTotals -- the same function the form's running total uses. NOT
  // recomputed on read: a later change to the arithmetic can never restate an
  // issued document.
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  notes: text("notes").notNull().default(""),
  terms: text("terms").notNull().default(""),
}, (t) => [
  // "THE DOCUMENT THIS DETAIL ROW DESCRIBES IS A QUOTE", said by the database.
  // Named explicitly rather than left to drizzle's generated name, because 0015's
  // lesson is that a constraint name in a migration is a claim about what an
  // earlier migration really created, and this one is written by hand in 0017.
  foreignKey({
    name: "document_quotes_document_id_type_fk",
    columns: [t.documentId, t.type],
    foreignColumns: [documents.id, documents.type],
  }),
  // What makes the column above a constant rather than a field somebody has to
  // remember to write. Without it the composite key would still hold -- it would
  // just start meaning "this row describes a document of whatever type this
  // column says", which is not the statement wanted.
  check("document_quotes_type_is_quote", sql`type = 'quote'`),
  // deals_currency_format's twin. A quote's currency is copied from its deal and
  // printed on the page; the same three-letter rule has to hold or the two
  // records disagree about what the money is.
  check("document_quotes_currency_format", sql`currency ~ '^[A-Z]{3}$'`),
  // The stored totals are the only totals anyone ever reads back, so the one
  // relation between them is worth asserting where no write path can skip it.
  // documentTotals() guarantees it by construction; this is the backstop for
  // every other write path, the same split as contacts.emails and
  // projects.color. A future discount or rounding column would alter this CHECK
  // in its own migration, exactly as each phase has widened events_verb_valid.
  check("document_quotes_totals_consistent", sql`total_cents = subtotal_cents + tax_cents`),
  // THE OTHER HALF OF A GUARD money.ts ONLY HAS ONE SIDE OF. documentTotals()
  // refuses to PRODUCE a total past Number.MAX_SAFE_INTEGER, because these are
  // bigint columns read through drizzle's `mode: "number"` and a larger value
  // would come back as the nearest double. Nothing stopped one arriving by
  // another path -- a psql session, an import, a future service that skipped the
  // shared arithmetic -- and being silently misread on the way out. Postgres
  // reaches 2^63; this pins the columns to the range the reader can represent.
  check(
    "document_quotes_totals_representable",
    sql`subtotal_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND tax_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND total_cents BETWEEN -9007199254740991 AND 9007199254740991`,
  ),
]);
export type DocumentQuoteRow = typeof documentQuotes.$inferSelect;

// THE LETTER'S OWN COLUMNS -- Phase 9 Task 3, migration 0019.
//
// **THE ONE TABLE IN THIS SCHEMA WHOSE ROWS ARE MEANT TO CHANGE.** Everything
// else about a document is written once: Phase 7's "a row here means a PDF
// exists, and nothing ever rewrites either" was unconditional until this table,
// and `documents.frozen` is what made it conditional. A letter is redrafted --
// Chris, 6 Sep: "a letter wants redrafting before it goes" -- so `body_html`,
// the subject and the addressee are all editable, and services/documents.ts's
// redraftLetter is the only writer that may touch them. The guard that stops it
// touching an NDA is `conduit_document_frozen_guard`, which lives in 0019 and
// nowhere in this file -- drizzle-kit has no vocabulary for a trigger. It is
// documented at `documents.frozen` above.
//
// ============================ WHY NOT `document_parties` ====================
//
// Task 1 moved the quote's four recipient columns here from `documents` and
// wrote: "Tasks 3 and 4 have the two further types that would have to agree with
// it; if they do, a common `document_parties` is a migration they can make with
// three examples in front of them instead of one." **This task has the three
// examples -- the quote, the letter and the two agreements -- and did not make
// that migration.** Three reasons, in the order they weigh:
//
//  1. **IT WOULD BE A SECOND MIGRATION OVER CHRIS'S LIVE QUOTE ROWS IN ONE
//     RELEASE, FOR A REFACTOR RATHER THAN A FEATURE.** 0016 is the one migration
//     in this project that has ever moved real data, and the spec calls it the
//     phase's highest-consequence item; proving it safe took a fixture written by
//     the pre-migration code and the whole of Task 1's mutation budget. Doing
//     that again to spare some duplication -- in the same release, with three
//     new types and a new guard also landing -- spends the risk in the wrong
//     place. Nothing about the split gets harder later: a fourth type is the
//     moment to move all four column groups together, in a migration that does
//     nothing else.
//  2. **THE FOUR COLUMNS DO NOT ACTUALLY AGREE.** `recipient_salutation` exists
//     because a quote PRINTS A GREETING, and so does a letter. An agreement does
//     not: an NDA has no "Dear Ms Smith" in it, it has parties. So a common
//     table either carries a column that is structurally empty for two of its
//     four types -- 0016's rejected "one table, several shapes, no guarantees",
//     in miniature and in the table built to avoid it -- or it holds three
//     columns while the salutation stays behind on two of them, which is a
//     shared table that shares most of a group.
//  3. **"RECIPIENT" IS THE QUOTE'S NOUN.** A quote has a recipient; an agreement
//     has PARTIES, and a MUTUAL NDA has two of them symmetrically. A table
//     called `document_parties` holding one recipient row per document is the
//     quote's model wearing a general name, which is precisely how `documents`
//     became a quote table. A real parties table is one row PER PARTY -- and
//     nothing here motivates one, because even a mutual NDA stores exactly one:
//     the other party is the issuer, which is `org_profile` and is already on
//     the letterhead. Building the general shape for a second row that no type
//     has is how the first mistake gets made again.
//
// So the party columns are spelled out per detail table, deliberately, and the
// two spellings are deliberately NOT identical: a letter has a salutation and a
// subject, an agreement has neither and has a term and a jurisdiction instead.
// @conduit/shared's DOCUMENT_PARTY_CAPS shares the LENGTHS, which is the only
// part of the duplication that can silently drift into a bug.
export const documentLetters = pgTable("document_letters", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  // document_quotes.type's twin, and the composite foreign key below is why it
  // exists. A constant: NOT NULL DEFAULT 'letter' with a CHECK pinning it, so no
  // writer mentions it and none can change it.
  type: text("type").notNull().default("letter"),
  // The `Re:` line. Optional, because a letter without one is ordinary and a
  // subject invented by the software would be worse than none.
  subject: text("subject").notNull().default(""),
  // THE ADDRESSEE, SNAPSHOT AT ISSUE for document_quotes' reason, with one
  // difference worth stating: a quote is frozen so its snapshot can never be
  // refreshed, while a letter's IS refreshed -- by a redraft, from the form, by
  // a person who is looking at it. That is the correct lifetime for a letter:
  // you are about to send this, so it should say where you are sending it now.
  // What it must NOT be is a live join, or a company that moved office would
  // silently change the address on a letter already posted.
  recipientName: text("recipient_name").notNull(),
  recipientContactName: text("recipient_contact_name").notNull().default(""),
  recipientSalutation: text("recipient_salutation").notNull().default(""),
  recipientAddress: text("recipient_address").notNull().default(""),
  // TIPTAP HTML, exactly as `meetings.notes` is, and it reaches the page as a
  // MergeHtml rather than as escaped text -- the second value in Conduit ever to
  // do so. Sanitised on write with the DOCUMENT profile (services/documents.ts),
  // and again as part of the merged page.
  bodyHtml: text("body_html").notNull(),
}, (t) => [
  foreignKey({
    name: "document_letters_document_id_type_fk",
    columns: [t.documentId, t.type],
    foreignColumns: [documents.id, documents.type],
  }),
  check("document_letters_type_is_letter", sql`type = 'letter'`),
]);
export type DocumentLetterRow = typeof documentLetters.$inferSelect;

// THE NDA AND THE MUTUAL NDA -- one table, two types.
//
// **ONE TABLE BECAUSE THEY DIFFER IN WHAT THEY OBLIGE, NOT IN WHAT THEY NEED.**
// Both are with one party, effective from one date, for one term, under one
// jurisdiction. The whole difference between a one-way and a mutual NDA is which
// side may disclose, and that is wording -- so it lives in the TEMPLATE, which is
// editable in Settings, and not in a column. Two tables would have been two
// identical column lists and two readers.
//
// WHICH MAKES THE COMPOSITE FOREIGN KEY DIFFERENT FROM THE OTHER TWO, and it is
// the first one that is not a constant. `document_quotes.type` is pinned to
// 'quote' and `document_letters.type` to 'letter'; this one is pinned to a SET,
// so the CHECK reads `type IN ('nda','mutual_nda')` and the key then says "the
// document this row describes is one of these two". It still cannot disagree with
// the row it describes -- that is what the key enforces -- but unlike the other
// two it is a field a writer has to supply, because the writer is the only thing
// that knows which of the two this is.
//
// **AND THAT IS WHAT THE KEY BUYS HERE**, in the shape 0017's comment set out:
// without it, `INSERT INTO document_agreements` naming a LETTER's id succeeds,
// and the row is not inert -- the record's document list reads agreements by
// joining on document_id, so the letter would come back as an NDA with a term and
// a jurisdiction, from code that never asked what it was.
export const documentAgreements = pgTable("document_agreements", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  type: text("type").notNull(),
  // WHEN THE OBLIGATIONS START, WHICH IS NOT WHEN THE PDF WAS MADE. Routinely
  // backdated (the conversation started before the paperwork) and sometimes
  // forward-dated (a project that begins next month), so there is deliberately no
  // CHECK relating it to documents.issue_date: the ordering that looks obvious
  // would refuse the common case.
  effectiveDate: date("effective_date").notNull(),
  // How long confidentiality lasts, in whole months. An integer rather than free
  // text because "which agreements expire this year" is a question about a date
  // computed from this and effective_date, and `'3 yrs (auto-renewing)'` answers
  // it for nobody. The page prints "36 months" -- see formatAgreementTerm for why
  // it is not converted to years.
  termMonths: integer("term_months").notNull(),
  // The governing law, as the page states it. Free text because there is no list:
  // "the Netherlands", "England and Wales", "the State of Delaware" and "the
  // courts of Amsterdam" are all things an NDA says, and an enum here would be a
  // guess about somebody else's legal practice.
  jurisdiction: text("jurisdiction").notNull(),
  // THE COUNTERPARTY, SNAPSHOT AND PERMANENTLY SO -- an agreement is frozen, so
  // unlike the letter's addressee this can never be corrected. That is the point:
  // the row records the legal entity the signed page names, and a company renamed
  // next year has not changed what was agreed this year.
  partyName: text("party_name").notNull(),
  // **CHRIS'S "EXACTLY ONE" DECISION, AS A COLUMN.** The spec: an NDA naming a
  // contact at a company "attaches to the company and names the contact in its
  // content". This is that content. Empty when the agreement is with an
  // individual, because then the party IS the person and there is no second name.
  partyContactName: text("party_contact_name").notNull().default(""),
  partyAddress: text("party_address").notNull().default(""),
}, (t) => [
  foreignKey({
    name: "document_agreements_document_id_type_fk",
    columns: [t.documentId, t.type],
    foreignColumns: [documents.id, documents.type],
  }),
  check("document_agreements_type_valid", sql`type IN ('nda','mutual_nda')`),
  // A TERM IS A POSITIVE NUMBER OF MONTHS AND THE UPPER BOUND IS NOT COSMETIC.
  // @conduit/shared's AGREEMENT_MAX_TERM_MONTHS is the gate and this is the
  // backstop, the standing split. `integer` alone would let 2147483647 into a
  // column whose value gets printed on a legal document as a word.
  check("document_agreements_term_range", sql`term_months BETWEEN 1 AND 1200`),
  // The two fields an agreement cannot be missing. Unlike the party's address and
  // the named contact -- both legitimately absent -- an agreement with no party
  // and no governing law is not an agreement, and '' is how a writer that dropped
  // a field would spell it.
  check("document_agreements_stated", sql`party_name <> '' AND jurisdiction <> ''`),
]);
export type DocumentAgreementRow = typeof documentAgreements.$inferSelect;

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
  // **NOT the same enum documents.type carries, since 0017 -- THIS IS THE LIST OF
  // TYPES THAT ARE NUMBERED, and it is narrower on purpose.** It reads as the same
  // list because for the whole of v1.x it was: with one document type, "a valid
  // type" and "a numbered type" were the same set and nothing could tell them
  // apart. `meeting_summary` is the first type that is one and not the other
  // (@conduit/shared's documentTypeNumbered has the reasons), so this stays at
  // 'quote' and thereby becomes a third enforcement of the numbering rule: a
  // writer that called allocateNumber for a summary fails on this INSERT rather
  // than quietly starting a `DOC-2026-` series -- which is exactly what
  // formatDocumentNumber's `?? "DOC"` fallback would otherwise have produced.
  // schema.test.ts pins it against documentTypeNumbered so it cannot be "fixed"
  // by widening it to match documents_type_valid.
  //
  // The original sentence's point survives unchanged: a typo'd type here would
  // silently start a private numbering series rather than failing.
  //
  // **0019 WIDENS IT BY TWO AND NOT BY THREE**, which is the whole of what makes
  // it a narrower list than documents_type_valid rather than the same list
  // written twice. Task 3 added three types; `nda` and `mutual_nda` are numbered
  // and `letter` is not, so a writer that called allocateNumber for a letter
  // still fails on this INSERT instead of minting `DOC-2026-0001`.
  check("document_number_sequences_type_valid", sql`type IN ('quote','nda','mutual_nda')`),
]);
export type DocumentNumberSequenceRow = typeof documentNumberSequences.$inferSelect;

// One editable template per document type, seeded with a working default in the
// migration that adds the type -- drizzle/0009_*.sql for the quote, 0017 for the
// meeting summary, 0019 for the letter and the two agreements -- so a document
// renders before anyone has opened Settings.
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
  // documents_type_valid's list exactly, and this one really is the same set:
  // every type Conduit can produce has an editable template, which is what makes
  // `documentTypeSchema` the right parser for the :type route param.
  check(
    "document_templates_type_valid",
    sql`type IN ('quote','meeting_summary','letter','nda','mutual_nda','project_status_report')`,
  ),
]);
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;

// --- Time tracking (Phase 10) ---------------------------------------------
//
// ONE ROW IS ONE QUANTITY OF WORK ATTRIBUTED TO ONE DAY. A duration, that day,
// the person who did it, whether it is chargeable, and the records it belongs
// to. Nothing here is an instant: see work_date below.
//
// **THE LINK SET IS A FIFTH SET, NOT A COPY OF A FOURTH OR A FIFTH ALREADY
// HERE**, and this is the one place the plan's instruction has to be read
// carefully. The plan says Phase 9 "established the pattern for a five-way link
// set with a per-type CHECK -- documents_entity_matches_type in 0020 -- read it
// before inventing one". It was read, and only half of it transfers:
//
//   THE COUNT PATTERN TRANSFERS. `num_nonnulls(...)` over the record columns is
//   how every one of these rules is spelled in this file (notes = 1, files = 1,
//   documents = 1, meetings >= 1), and this is the same rule at a fifth column
//   and the meetings count. Spelled the same way for the same reason: at-least-
//   one and exactly-one are then visibly one rule at two counts.
//
//   THE PER-TYPE PATTERN DOES NOT, AND CANNOT. `documents_entity_matches_type`
//   answers "which record does a document of THIS TYPE belong to", and it needs
//   `documents.type` to ask the question. A time entry has no type and no
//   discriminator of any kind: an hour is an hour, and which record it belongs
//   to is the operator's answer, not a consequence of what kind of thing it is.
//   A CHECK of that shape here would have to invent a type column to hang
//   itself on, which is 0016's mistake -- generalising from the one example that
//   had been built -- in the other direction.
//
//   AND THE FIVE ARE NOT THE SAME FIVE. documents' are company, contact, deal,
//   project, MEETING. These are company, contact, deal, project, TASK. So even
//   the column list could not have been copied.
//
// **A MEETING IS DELIBERATELY NOT A SIXTH LINK, AND THE ABSENCE IS THE
// ENFORCEMENT.** The spec's third decision is that a manual entry cannot be
// attached to a meeting, so the same hour cannot be counted twice -- and it asks
// for that to be impossible rather than discouraged. There is no meeting_id
// column here, so an INSERT naming one does not violate a CHECK, it fails to
// parse against the table at all (42703, "column meeting_id does not exist").
//
// **TASK 2 CONFIRMED IT AND ADDED NOTHING**, which is the outcome this note was
// written for. The plan's instruction to Task 2 was "a CHECK, not a convention";
// a CHECK needs a column to name, and adding one so that an error message could
// name it would have traded impossible for illegal. What Task 2 built instead is
// services/timesheet.ts, whose header enumerates the INDIRECT routes to a double
// count that the absent column does not close -- a join that fans a meeting out
// over its attendees or its links, a meeting counted in two buckets, and an
// archived row still contributing -- and closes each of them with a test.
export const timeEntries = pgTable("time_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  // THE DAY, NOT AN INSTANT. `date`, like tasks.start_date and
  // deals.expected_close_date, and deliberately not the timestamptz every
  // "when did this happen" column in this file otherwise uses (meetings.
  // occurred_at, mail_messages.sent_at). A timesheet asks which DAY an hour
  // belongs to; a timestamptz cannot answer that without also answering "in
  // whose time zone", and for a row typed by hand there is no true answer --
  // the operator recorded a day, not a moment. Storing an instant would make
  // org_profile.time_zone (0018) load-bearing on every read, so the same stored
  // row would move between weeks when somebody changed a setting.
  //
  // Task 5's timer will need real instants (a start that survives a restart is
  // an instant or it is nothing). Those belong to the TIMER's own state, and
  // what it produces when it stops is a row here: a day and a number of
  // minutes.
  workDate: date("work_date").notNull(),
  // Minutes, matching meetings.duration_minutes, so the two things the
  // timesheet sums are counted in one unit and no conversion sits between them.
  // NOT NULL, unlike that column: a meeting whose length nobody recorded is
  // honest (spec), while an ENTRY with no duration is not an entry at all.
  minutes: integer("minutes").notNull(),
  description: text("description"),
  // NO DEFAULT, which is documents.frozen's arrangement and documents.frozen's
  // reason. Both values are ordinary, so any default is a guess, and a guess
  // made by the schema is made silently on the row nobody re-reads. An INSERT
  // that says nothing about it is refused; @conduit/shared's
  // timeEntryCreateInputSchema requires it on the wire for the same reason.
  //
  // AND NO RATE COLUMN ANYWHERE NEAR IT. Invoicing is out of Conduit, so this
  // flag feeds reporting and the export; a rate without a rate card is a number
  // somebody re-types for ever (spec).
  billable: boolean("billable").notNull(),
  // NOT NULL, matching meetings.owner_user_id rather than the nullable
  // owner_user_id on companies/contacts/deals/projects: an hour was worked BY
  // somebody, and the actor is stamped server-side, never sent by the caller.
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
  projectId: uuid("project_id").references(() => projects.id),
  taskId: uuid("task_id").references(() => tasks.id),
  // ARCHIVE, NOT DELETE, this file's rule everywhere -- and here it is the only
  // way to take an hour back out of a total. An entry cannot be corrected to
  // nothing, because `time_entries_minutes_range` forbids zero, so without this
  // column a duplicated afternoon would stay in the week's total for ever.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [
  // AT LEAST ONE OF FIVE. Its twin lives on @conduit/shared's
  // timeEntryAtLeastOneLink, which the create schema refines with and
  // updateTimeEntry re-asserts against the merged row, so a 4xx never arrives
  // as a 500 -- the same two-place arrangement meetings_has_link has.
  //
  // NOT `= 1`, which is notes'/files'/documents' rule: an hour can legitimately
  // belong to a project AND the deal it came from, and forcing a choice would
  // make one of those two reports wrong on purpose.
  //
  // NOT ABSENT, which is tasks'/mail_threads' rule: a row linked to nothing
  // appears in no report and can be found only by SQL, so the week's total
  // comes out short with nothing anywhere saying so. That is the whole reason
  // this constraint is `>= 1` and not merely a convention in the form.
  check(
    "time_entries_has_link",
    sql`num_nonnulls(company_id, contact_id, deal_id, project_id, task_id) >= 1`,
  ),
  // BELT AND BRACES, unlike meetings.duration_minutes, which carries no bound in
  // the database at all.
  //
  // **THE CONTRAST IS NO LONGER "NOTHING SUMS A MEETING'S DURATION".** That was
  // the reason when this was written and v1.9.0's timesheet made it false: both
  // columns are now summed, by services/timesheet.ts, into one number. What
  // still differs is that THIS column has a definitional bound and that one has
  // not. An entry is a quantity of work attributed to a calendar date and no
  // date holds more than 24 hours, so 1440 follows from what the row IS. A
  // meeting's `occurred_at` is a start instant, and an offsite logged as one
  // meeting can honestly run longer than a day -- so the same number there would
  // refuse a true row, and would still not catch the mistype that happens (60
  // typed as 600 passes any bound). See that column for the exposure this leaves.
  //
  // The upper bound is one DAY because work_date is one day, and it is
  // MAX_TIME_ENTRY_MINUTES in @conduit/shared spelled a second time;
  // db/schema.test.ts probes 1, 1440, 1441, 0 and -1 so the two cannot drift.
  check("time_entries_minutes_range", sql`minutes > 0 AND minutes <= 1440`),
]);
export type TimeEntryRow = typeof timeEntries.$inferSelect;
