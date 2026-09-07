-- TIME ENTRIES: ONE TABLE, TWO CHECKS, ONE INDEX, AND NOT ONE EXISTING ROW
-- TOUCHED.
--
-- Phase 10 Task 1. `time_entries` is a quantity of work attributed to a calendar
-- day, the person who did it, whether it is chargeable, and the records it
-- belongs to. db/schema.ts carries the column-by-column argument; this header
-- carries the migration's own.
--
-- **IT MOVES NOTHING AND WIDENS NOTHING.** One CREATE TABLE, six foreign keys
-- and one index, all on an object that did not exist a statement earlier. There
-- is no ALTER against a populated table anywhere in it, so unlike 0016 (which
-- moved live quotes) or 0020 (three constraint statements under ACCESS
-- EXCLUSIVE) it takes no lock anything else could be waiting behind and has no
-- backfill to get wrong. On an install with data it is the cheapest kind of
-- migration there is.
--
-- **THE LINK CHECK IS THE WHOLE POINT OF THE TABLE'S SHAPE, AND IT IS `>= 1`.**
-- Three rules over the same record columns already exist in this schema --
-- `= 1` on notes/files/documents, `>= 1` on meetings, and none at all on
-- tasks/mail_threads -- and the spec argues for the middle one at five columns:
--
--   `= 1` WOULD BE WRONG. An hour can belong to a project AND the deal it came
--   from. Making the operator pick one makes one of those two reports wrong on
--   purpose, every time.
--
--   NO RULE WOULD BE WORSE. An entry linked to nothing is in no report and can
--   be found only by SQL, so the week's total is short and nothing says so. The
--   spec's words: quietly wrong in the direction nobody checks.
--
-- **AND IT IS NOT `documents_entity_matches_type`, WHICH IS WHAT THE PLAN
-- POINTED AT.** That CHECK was read first, as instructed. What transfers is the
-- num_nonnulls COUNT spelling, which is how all four of these rules are written.
-- What does not transfer is the per-type half: 0020's constraint answers "which
-- record does a document of THIS TYPE belong to" and needs `documents.type` to
-- ask it. A time entry has no type and needs none -- an hour is an hour -- so a
-- CHECK of that shape here would have to invent a discriminator to hang itself
-- on. The five columns are not even the same five: documents' fifth is
-- `meeting_id` and this table's is `task_id`.
--
-- **THERE IS NO `meeting_id` COLUMN, AND THAT IS DELIBERATE.** The spec's third
-- decision is that a manual entry cannot name a meeting, so a logged meeting's
-- duration and a typed entry can never be the same hour counted twice, and it
-- asks for that to be IMPOSSIBLE rather than discouraged. Omitting the column is
-- the strongest available form of it: an INSERT naming `meeting_id` does not
-- violate a constraint, it fails to resolve against the table (42703). Task 2
-- owns that decision and may want a CHECK it can name in an error message
-- instead; this is written down so that task starts from what is already
-- standing rather than from an empty column it then has to forbid.
--
-- **THE MINUTES BOUND IS BELT AND BRACES, WHICH `meetings.duration_minutes`
-- DELIBERATELY IS NOT**, and the difference between the two columns is what each
-- is for: nothing sums a meeting's duration, and these minutes ARE the week's
-- total. `> 0` is what makes an entry an entry; `<= 1440` is one day, because
-- `work_date` is one day and no day holds more. The upper bound is
-- MAX_TIME_ENTRY_MINUTES in @conduit/shared spelled a second time, and
-- db/schema.test.ts probes 1 / 1440 / 1441 / 0 / -1 so the two cannot drift.
--
-- **`billable` HAS NO DEFAULT**, which is documents.frozen's arrangement and
-- documents.frozen's reason: both values are ordinary, so any default is a guess
-- made silently on the row where it is hardest to notice, and the guess that
-- reads worst -- non-billable -- under-reports chargeable time in a product with
-- no invoicing step downstream to contradict it.
--
-- **THE ROLLBACK COST IS THE LOWEST OF THE PHASE.** Every object here is new, so
-- code can roll back to a build that has never heard of the table and still read
-- the database; what such a build cannot do is show a timesheet. Reverting the
-- SCHEMA means dropping a table with the operator's hours in it, which is the
-- irreversible half and has the same answer 0016 made the answer to any rollback
-- of a Phase: the restore.
--
-- **GENERATED AND THEN RENAMED, AND THE JOURNAL TRAP WAS DISARMED RATHER THAN
-- SURVIVED -- THE SIXTH TIME IT WOULD HAVE FIRED.** `drizzle-kit generate`
-- stamped this entry's `when` as 1788718705895 (2026-09-06T18:18Z, the wall
-- clock), which falls between 0014's 1788700000000 and 0015's 1788800000000 --
-- so on every install that already has 0015, drizzle would have skipped this
-- migration in silence and the table would simply not exist, with no error to
-- see (drizzle-orm/pg-core/dialect.js compares against the newest applied row's
-- created_at and never looks at the hash). Identical to 0016-0020's, which is
-- five for five before this one.
--
-- WHAT IS DIFFERENT THIS TIME is that nobody had to notice. `npm run db:generate`
-- runs db/journal-stamp.ts straight after drizzle-kit, and it restamped the entry
-- to 1789300000001 -- `max(now, largest existing + 1)` -- and said so on stdout.
-- The fix Phase 9's last task built worked on the first migration written after
-- it. db/schema.test.ts's strictly-increasing check still stands as the net for
-- `npx drizzle-kit generate` run directly.
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"description" text,
	"billable" boolean NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"task_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_has_link" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id, task_id) >= 1),
	CONSTRAINT "time_entries_minutes_range" CHECK (minutes > 0 AND minutes <= 1440)
);
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ======================= THE ONE INDEX, AND THE FIVE NOT BUILT ==============
--
-- Hand-written here rather than declared in db/schema.ts, which is this
-- codebase's standing convention for every index it has (see the mail block's
-- note in that file); drizzle's index() builder is still used by no table.
--
-- (work_date DESC, id DESC) IS THE LIST'S OWN ORDERING AND ITS OWN CURSOR.
-- listTimeEntries pages by exactly this keyset -- `ORDER BY work_date DESC, id
-- DESC` with a `(work_date, id) <` comparison for the cursor -- so a composite
-- in that order serves the sort and the seek from one structure. A plain
-- (work_date) index would serve the sort and leave the tiebreak to a sort node,
-- and there IS a tiebreak: an ordinary day carries several entries, so ties are
-- the common case here rather than the rare one.
--
-- IT IS THE ONE READ THAT CANNOT BE NARROWED. Every other read of this table
-- carries a record filter and selects a handful of rows; the timesheet's page
-- is "every entry, newest first", which is the whole table however large it
-- gets.
--
-- **NO FIGURES ARE QUOTED BECAUSE NONE WERE TAKEN** -- 0020's sentence, and true
-- here for the same reason: the table is empty on every deployment in existence,
-- so any number would be about a fixture. What is asserted is the shape of the
-- query, not a speedup.
--
-- THE FIVE RECORD FOREIGN KEYS ARE DELIBERATELY UNINDEXED, which is the
-- discipline 0016 started and 0017/0019/0020 each continued by building exactly
-- the index their own new reader needed: an index maintained by every INSERT and
-- used by no SELECT is a cost with no reader. GET /api/time-entries does accept
-- all five filters, but nothing in this release CALLS it with one -- the rail
-- tabs and the per-record totals are Task 4's -- and a filtered scan of a table
-- with no rows is free. Task 4 builds them, with a measurement, when it has the
-- readers.
CREATE INDEX "time_entries_work_date_idx" ON "time_entries" ("work_date" DESC, "id" DESC);