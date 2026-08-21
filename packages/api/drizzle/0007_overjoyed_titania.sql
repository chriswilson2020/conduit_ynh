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
WHERE "t"."archived_at" IS NOT NULL;