-- THE TIMER: ONE NEW TABLE, THREE CHECKS, ONE UNIQUE CONSTRAINT, ONE PARTIAL
-- UNIQUE INDEX, AND NOT ONE EXISTING ROW TOUCHED.
--
-- Phase 10 Task 5, the phase's last task and the one its spec calls the real
-- risk. db/schema.ts carries the column-by-column argument; this header carries
-- the migration's own, and the two decisions a reader of the SQL alone would
-- otherwise have to reconstruct.
--
-- **IT MOVES NOTHING AND WIDENS NOTHING**, 0021's sentence and 0021's reason:
-- one CREATE TABLE, seven foreign keys and one index, every object new. There is
-- no ALTER against a populated table, so it takes no lock anything can be
-- waiting behind. In particular `time_entries` IS NOT ALTERED -- the timer's
-- link to what it produced points from this table to that one, so the ten
-- columns of `time_entries.csv` are unchanged and the export's
-- information_schema column guard has nothing new to cover there. The plan
-- warned that "timer columns added to time_entries must reach
-- time_entries.csv"; there are none, and the reason is that the relationship is
-- one-to-one in the direction that keeps the constraint on the NEW table
-- (`timers_time_entry_unique`), where it can be added on the day the table is
-- created rather than over live rows.
--
-- **A RUNNING TIMER IS NOT A TIME ENTRY IN PROGRESS, AND THE SCHEMA ALREADY
-- SAID SO.** `time_entries.minutes` is NOT NULL with `minutes > 0`, so there is
-- no way to spell a duration that is still accruing -- which is why this is a
-- second table rather than three nullable columns on the first. The property
-- that falls out is the one the spec wants: a running timer is reachable from
-- nothing that sums, so it cannot be counted, ever, by construction rather than
-- by a WHERE clause somebody has to remember.
--
-- **THE LINK CHECK IS `time_entries_has_link` AT A SECOND TABLE, DELIBERATELY
-- SPELLED THE SAME.** A timer that could not become an entry must not be
-- startable: refusing it here means the operator meets the refusal while the
-- record picker is on screen, rather than at stop, holding hours they cannot
-- attach to anything. And there is no `meeting_id` column here either, for Task
-- 1's reason exactly -- this table is a second front door to `time_entries`, and
-- a door that could name a meeting would put back the double count the missing
-- column makes unspellable (42703, not a constraint).
--
-- **`stopped_at` IS ONE COLUMN FOR TWO ENDINGS, AND `time_entry_id` IS WHAT
-- TELLS THEM APART.** Stopped-into-an-entry and discarded are both "the clock is
-- no longer running", so a second boolean or a status enum would let a row be
-- both or neither. Instead: running is `stopped_at IS NULL`; discarded is
-- stopped with no entry; logged is stopped with one. `timers_entry_needs_stop`
-- forbids the fourth combination, which is the one that would matter -- a row
-- with an entry and no stop would be counted by the timesheet THROUGH that entry
-- while still running on the strip.
--
-- **AND A DISCARDED TIMER IS KEPT.** Conduit never expunges, and this row is the
-- only record that the clock ever ran; `timers.csv` carries it into the export
-- in this same change, which is Task 1's obligation applied to Task 5's table.
--
-- **THE ROLLBACK COST IS THE PHASE'S LOWEST, AGAIN.** Every object is new, so a
-- build that has never heard of `timers` reads this database perfectly and
-- merely has no timer. What such a build also cannot do is finish a timer that
-- is running at the moment of the downgrade: the row stays, `stopped_at` stays
-- NULL, and the operator's hours are un-logged until a build that knows the
-- table comes back. That is a stronger reason than usual to roll code forward
-- rather than back, and it is written here because nothing in the code says it.
CREATE TABLE "timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"time_entry_id" uuid,
	"description" text,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timers_time_entry_unique" UNIQUE("time_entry_id"),
	CONSTRAINT "timers_has_link" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id, task_id) >= 1),
	CONSTRAINT "timers_stopped_after_start" CHECK (stopped_at IS NULL OR stopped_at >= started_at),
	CONSTRAINT "timers_entry_needs_stop" CHECK (time_entry_id IS NULL OR stopped_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ============ THE ONE INDEX, WHICH IS ALSO THE PHASE'S ONE HARD RULE =========
--
-- Hand-written here rather than declared in db/schema.ts, which is this
-- codebase's standing convention for every index it has (0004's block, 0021's);
-- drizzle's index() builder is still used by no table. This one has to be
-- hand-written anyway -- drizzle-kit cannot express a partial unique index.
--
-- **AT MOST ONE RUNNING TIMER PER PERSON, AND THIS IS NOT AN OPTIMISATION.** It
-- is the one double-count between the two capture paths that the schema CAN
-- close, and the spec asks for exactly that treatment: impossible, not
-- discouraged. Without it, two devices -- a laptop at a desk and a phone in a
-- pocket, which is precisely the arrangement "must survive a second device" is
-- about -- each start a timer, each stop it, and one afternoon is booked twice
-- by an operator who did nothing wrong and has no way to see what happened. The
-- second start is now a unique violation, which services/timers.ts turns into a
-- 409 that NAMES the timer already running so the client can offer to stop that
-- one instead.
--
-- **PARTIAL, ON `stopped_at IS NULL`, WHICH IS WHAT MAKES IT USABLE AT ALL.** A
-- plain UNIQUE(owner_user_id) would let each person start exactly one timer
-- ever. Only the RUNNING ones are constrained, and the finished ones -- of which
-- there will eventually be thousands -- are not in the index at all, so it stays
-- one row per person however long the table gets.
--
-- **AND IT IS ALSO THE LOOKUP.** `getRunningTimer` reads
-- `WHERE owner_user_id = $1 AND stopped_at IS NULL` on every page load of every
-- tab, which is this index's predicate and its key. So the constraint and the
-- read come out of one structure: no separate index was measured, because a
-- second one on the same two columns would be the same index built twice.
-- (Contrast 0021's five record foreign keys and Task 4's measurement of them --
-- those had a reader and were still not built, because the reader was
-- date-ranged first. This one is not a judgement call: the constraint is
-- required whatever the figures say.)
CREATE UNIQUE INDEX "timers_one_running_per_owner" ON "timers" ("owner_user_id") WHERE "stopped_at" IS NULL;