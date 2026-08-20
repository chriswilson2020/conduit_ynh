CREATE TABLE "mail_account_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"special_use" text,
	"sync_enabled" boolean NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"last_discovered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_account_folders_account_folder_unique" UNIQUE("account_id","folder"),
	CONSTRAINT "mail_account_folders_special_use_valid" CHECK (special_use IN ('archive','drafts','junk','sent','trash'))
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "trash_folder" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "archive_folder" text;--> statement-breakpoint
ALTER TABLE "mail_account_folders" ADD CONSTRAINT "mail_account_folders_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written block, on 0004's terms and with 0004's consequences: the index
-- below exists in neither schema.ts nor the drizzle-kit snapshot, so
-- `drizzle-kit push` must never be introduced to this project (it would DROP
-- it, having no record of it), and declaring it later via drizzle's index()
-- builder requires deleting this statement first or a generate will try to
-- create a duplicate. See drizzle/0004_bitter_excalibur.sql's own block.
--
-- NAMED QUERY: GET /api/mail/threads' folder filter (Phase 4.1 Task 4) --
--   SELECT ... FROM mail_threads WHERE archived_at IS NULL
--     AND EXISTS (SELECT 1 FROM mail_messages
--                 WHERE thread_id = mail_threads.id AND folder = $1)
--   ORDER BY last_message_at DESC, id DESC LIMIT $2
--
-- The existing (account_id, folder, imap_uid) index cannot serve it: with no
-- account_id in the predicate its leading column is missing, and it carries no
-- thread_id for the correlation. MEASURED at 20,000 threads / 85,000 messages
-- (2 accounts, 5 folders), plans compared before and after:
--
--   * a folder holding only OLD threads -- the honest worst case, where the
--     keyset walk passes nearly every thread before it fills a page:
--     70.8ms / 123,003 shared buffer hits -> 6.6ms / 290. The planner flips
--     from probing mail_messages(thread_id) once per candidate thread to an
--     index-only scan of the folder's own thread ids;
--   * an ordinary large folder (INBOX, 12k threads): 357 buffer hits -> 26,
--     wall time unchanged at ~0.4ms (the probes become index-only);
--   * a small folder (2k threads): 2,954 -> 26 buffer hits, 1.6ms -> 1.3ms;
--   * an empty folder: 5.3ms -> 0.08ms.
--
-- Column order: folder leads because it is the only column the folder-only
-- filter binds, and thread_id follows so the correlation is answered from the
-- index alone. 1.6MB at 85k messages, against a 32MB table.
CREATE INDEX "mail_messages_folder_thread_idx" ON "mail_messages" USING btree ("folder","thread_id");