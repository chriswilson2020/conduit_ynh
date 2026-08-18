import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, char, date, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  // Fractional index (see packages/shared/src/fractional.ts) ordering sibling
  // pipelines against each other, same scheme as stages.position and
  // deals.position below.
  position: text("position").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("pipelines_scope_valid", sql`scope IN ('global','company')`),
  // "project" is a Phase 3 scope value (needs the projects table) -- deliberately
  // not in the valid-scope CHECK above yet. See the Phase 2 design spec's
  // overnight-call note.
  check("pipelines_scope_company_paired", sql`(scope = 'company') = (company_id IS NOT NULL)`),
]);
export type PipelineRow = typeof pipelines.$inferSelect;

export const stages = pgTable("stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id),
  name: text("name").notNull(),
  position: text("position").notNull(),
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
  position: text("position").notNull(),
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

// notes/files: exactly one of the three possible parents. deal_id joins
// company_id/contact_id here rather than replacing them, since a note/file can
// be attached to a deal instead of a company or contact.
const exactlyOne = sql`num_nonnulls(company_id, contact_id, deal_id) = 1`;

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  body: text("body").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  dealId: uuid("deal_id").references(() => deals.id),
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
  // these can legitimately be set.
  dealId: uuid("deal_id").references(() => deals.id),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("events_verb_valid", sql`verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened')`)]);
export type EventRow = typeof events.$inferSelect;
