CREATE TABLE "mail_thread_hides" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_thread_hides_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mail_thread_hides" ADD CONSTRAINT "mail_thread_hides_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_thread_hides" ADD CONSTRAINT "mail_thread_hides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written backfill (an INSERT is not schema, so drizzle-kit cannot
-- generate it; db:generate stays drift-free with it here). This IS the
-- phase's "upgrade changes nobody's view" decision (Phase 4.3 spec,
-- Migration row): every thread hidden under the retiring thread-global flag
-- (archived_at NOT NULL) becomes PERSONALLY hidden for every user existing
-- at upgrade time, carrying the thread's archived_at as each row's
-- hidden_at -- so post-upgrade every inbox, badge, record tab and search
-- result reads exactly as it did before, and each person can then unhide
-- individually from their own Hidden view. Threads never archived get no
-- rows, and users created after the upgrade inherit no hides.
INSERT INTO "mail_thread_hides" ("thread_id", "user_id", "hidden_at")
SELECT "t"."id", "u"."id", "t"."archived_at"
FROM "mail_threads" "t"
CROSS JOIN "users" "u"
WHERE "t"."archived_at" IS NOT NULL;--> statement-breakpoint
-- The migration's second half (the plan's two-step sequencing note),
-- appended by the read-path task while 0007 was still unshipped: with the
-- backfill above written, the thread-global flag retires ENTIRELY. Nothing
-- reads or writes it past this migration -- every mail read path filters by
-- the viewer's own hide rows instead -- and a half-retired column would be
-- two sources of truth (spec, Data model). The DROP runs after the backfill
-- in the same migration, so no state is lost between the two statements.
--
-- NO (user_id, thread_id) INDEX rides this migration, and that is a
-- MEASURED decision (0006's precedent). On the 0005/0006 methodology
-- (20,000 threads / 80,000 messages, two users' private accounts, viewer
-- owning one; 1,250 hides per user, the viewer's all in the OLD half --
-- the skew that hurts most; warm runs, top-level node time and buffers):
-- the default arm's NOT EXISTS is an exact composite-PK index-only probe
-- (list page 0.70ms / 773 buffers, Heap Fetches: 0), and the Hidden view's
-- worst case (11.8ms / 21,317 buffers -- the ordered thread scan walks
-- 10,408 rows probing per thread before filling a page) is UNCHANGED by
-- the candidate index: the planner keeps the same LIMIT-ordered probe plan
-- and simply probes the new index instead (12.7ms / 21,317). A forced
-- hides-driven plan (materialized CTE) was measured too: 9.7ms / 4,046
-- buffers -- 5x fewer buffers but only ~2ms faster, because the time is
-- the per-thread visibility EXISTS either way. Nothing the index can buy,
-- so it is not added; full figures beside listThreads in
-- services/mail-threads.ts.
--
-- RE-MEASURE TRIGGER: the badge/per-folder unread plans hash-anti-join the
-- WHOLE hides table (21 buffers at the bench's 2,500 rows -- trivial, but
-- linear in table size). If mail_thread_hides ever reaches the order of
-- 25,000+ rows (thousands of hides per user), re-EXPLAIN those two queries
-- and the Hidden view before assuming these figures still hold.
ALTER TABLE "mail_threads" DROP COLUMN "archived_at";