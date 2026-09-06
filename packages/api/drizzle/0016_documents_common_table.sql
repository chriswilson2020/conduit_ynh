-- THIS ONE MOVES LIVE DATA, AND IT IS THE ONLY MIGRATION IN THIS PROJECT THAT
-- DOES. 0013 built indexes, 0014 added a defaulted column, 0015 swapped a CHECK;
-- none of them read a row. This lifts eleven columns out of `documents` and
-- writes them into a new table, on an install whose `documents` rows are quotes
-- somebody has already sent to customers.
--
-- WHY: `documents` was a quote table wearing a generic name. Alongside
-- `deal_id NOT NULL` it carried currency, subtotal_cents, tax_cents, total_cents
-- and recipient_name, all NOT NULL, plus valid_until_date. A meeting summary has
-- no currency and a letter has no total, so the four new Phase 9 types could not
-- have kept a single one of those promises. db/schema.ts's header on `documents`
-- has the design and the two rejected alternatives.
--
-- ============================ THE ORDER IS THE SAFETY ========================
--
-- The INSERT ... SELECT that fills document_quotes runs BEFORE the DROP COLUMNs
-- that make it impossible, and drizzle's migrator runs every pending migration
-- inside ONE transaction (drizzle-orm/pg-core/dialect.js: `session.transaction`
-- around the whole loop), so there is no window in which the columns are gone
-- and the new table is empty. Either the whole move lands or the database is
-- exactly as it was. That is also why the statements below are not defensive
-- about each other: a failure anywhere is a rollback everywhere.
--
-- REJECTED: a row-count assertion between the INSERT and the DROPs (a DO block
-- raising if the two tables disagree). `INSERT INTO t2 SELECT ... FROM t1` in a
-- transaction cannot insert fewer rows than the SELECT produced -- anything that
-- could go wrong raises and rolls back -- so the assertion could only ever fire
-- in a world where the transaction had already failed. schema.test.ts's
-- withPreMigrationDatabase("0016") drill is where the move is actually checked,
-- against rows written by the pre-migration code and read back through the new
-- schema (test/legacy-quote-rows.ts).
--
-- ========================= WHAT AN EXISTING QUOTE BECOMES ====================
--
-- Its `documents` row keeps id, number, type, file_id, issue_date,
-- issued_by_user_id and created_at unchanged, keeps deal_id (which is why
-- documents_exactly_one_entity passes on every pre-existing row: one of five set
-- and four NULL), and gains frozen = true. Everything else moves verbatim into a
-- document_quotes row keyed by the same id. Its LINES are not touched at all --
-- document_line_items already pointed at documents(id) and still does.
--
-- ITS PDF IS NOT TOUCHED, WHICH IS THE HALF THAT COULD NOT BE RISKED. Blobs are
-- content-addressed: blobPath() is derived from files.sha256 and nothing else.
-- This migration names neither `files` nor the blob store, so an existing quote
-- still opens afterwards, byte for byte, without anything having re-rendered it.
--
-- ================================= COST =====================================
--
-- Three full-table passes over `documents` -- the INSERT ... SELECT, and the two
-- ADD CONSTRAINT ... CHECKs, each of which validates every existing row under
-- ACCESS EXCLUSIVE -- plus eleven DROP COLUMNs,
-- which are catalogue-only in PostgreSQL -- the space is reclaimed by a later
-- VACUUM, not by this statement. `documents` on the deployment target holds tens
-- of rows; on any plausible install it holds hundreds. ADD COLUMN frozen with a
-- non-volatile DEFAULT is metadata-only (PostgreSQL 11+), so the row count does
-- not enter into it. 0013's header has the general argument about migrations
-- running before the server listens; it applies here unchanged.
--
-- NO INDEX ON THE FOUR NEW FOREIGN KEYS, which is a decision and not an
-- oversight. `documents_deal_idx` (0009) exists because "the documents on this
-- deal" is a read the code performs; nothing reads documents by company,
-- contact, project or meeting yet, because no type attaches to one. 0009's own
-- header refuses a wider index for exactly this reason -- no figures were taken,
-- because there was nothing to measure -- and four indexes created here would be
-- four indexes maintained by every INSERT and used by no SELECT until Task 2. A
-- CREATE INDEX is a cheap migration; this one is not, and they do not have to
-- travel together.
--
-- THE ROLLBACK COST, stated so it is not discovered. There is no going back from
-- this one with the data intact: rolling v1.8.0 back to v1.7.x leaves a
-- `documents` table the older release's schema cannot read at all -- it selects
-- currency and three cents columns that are no longer there -- and the values
-- are in a table that release has never heard of. The remedy is a restore, which
-- is why the backup route exists. That is a materially worse rollback story than
-- 0015's (which merely lost a badge) and it is the honest price of the split.
CREATE TABLE "document_quotes" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"valid_until_date" date,
	"recipient_name" text NOT NULL,
	"recipient_contact_name" text DEFAULT '' NOT NULL,
	"recipient_salutation" text DEFAULT '' NOT NULL,
	"recipient_address" text DEFAULT '' NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	CONSTRAINT "document_quotes_currency_format" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "document_quotes_totals_consistent" CHECK (total_cents = subtotal_cents + tax_cents),
	CONSTRAINT "document_quotes_totals_representable" CHECK (subtotal_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND tax_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND total_cents BETWEEN -9007199254740991 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "document_quotes" ADD CONSTRAINT "document_quotes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- THE MOVE. Every column named on both sides, in the same order, so the pairing
-- is readable rather than positional-by-luck -- and so a column added to either
-- table later cannot silently join in. `WHERE type = 'quote'` is deliberately
-- absent: documents_type_valid has admitted exactly one value for the whole life
-- of the table, so every row here IS a quote, and a predicate that is true of
-- every row would only invite the belief that this migration knows how to skip
-- something.
INSERT INTO "document_quotes" (
	"document_id", "currency", "valid_until_date",
	"recipient_name", "recipient_contact_name", "recipient_salutation", "recipient_address",
	"subtotal_cents", "tax_cents", "total_cents", "notes", "terms"
)
SELECT
	"id", "currency", "valid_until_date",
	"recipient_name", "recipient_contact_name", "recipient_salutation", "recipient_address",
	"subtotal_cents", "tax_cents", "total_cents", "notes", "terms"
FROM "documents";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A quote is still of a deal; a summary will be of a meeting. Dropping the NOT
-- NULL is what makes the other four columns reachable at all, and it takes
-- nothing away from the rows that exist -- documents_exactly_one_entity below
-- replaces it with a rule that is strictly stronger than the pair of them would
-- have been, since it forbids both "no owner" (which `deal_id NOT NULL` also
-- forbade) and "two owners" (which the four new columns would otherwise have
-- made representable, and which nothing forbade before because nothing could).
ALTER TABLE "documents" ALTER COLUMN "deal_id" DROP NOT NULL;--> statement-breakpoint
-- WITH A DEFAULT, WHICH IS THEN DROPPED, and both halves are load-bearing.
--
-- The DEFAULT is what fills every pre-existing row in the same statement, with
-- the only value that was ever true of it: every document that exists at the
-- moment this runs is a quote, because there has never been another kind, and a
-- quote freezes on issue. Same arrangement as 0014's auth_method and 0006's
-- visibility, and metadata-only for the same reason (a non-volatile DEFAULT on
-- ADD COLUMN rewrites no rows since PostgreSQL 11). Without it, `boolean NOT
-- NULL` with no default is a migration that fails outright on any table with a
-- row in it -- which is exactly what drizzle-kit generated, and exactly what an
-- empty test database would never have shown.
--
-- The DROP DEFAULT is the half 0014 did not need. auth_method's default stays
-- because 'password' is right for anything that omits it; frozen's cannot,
-- because the meeting summary, the letter and the status report are all `false`
-- and they are the next three types to arrive. Leaving `true` standing would
-- make "the writer forgot" indistinguishable from "the writer meant frozen", and
-- would let a mutation that deletes the service's frozen value pass unnoticed.
ALTER TABLE "documents" ADD COLUMN "frozen" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "frozen" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id, meeting_id) = 1);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_frozen_matches_type" CHECK (frozen = (type IN ('quote')));--> statement-breakpoint
-- Dropped by name BEFORE the columns they read, rather than left to fall with
-- them. DROP COLUMN would take each of these with it silently (they reference no
-- other column), and 0015's lesson is that a constraint name in a migration is a
-- claim about what earlier migrations really created: naming them here means a
-- name that has drifted fails loudly, in this migration, instead of a constraint
-- surviving into a table it was never meant to outlive.
ALTER TABLE "documents" DROP CONSTRAINT "documents_currency_format";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_totals_consistent";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_totals_representable";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "valid_until_date";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "recipient_name";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "recipient_contact_name";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "recipient_salutation";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "recipient_address";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "subtotal_cents";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "tax_cents";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "total_cents";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "notes";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "terms";
