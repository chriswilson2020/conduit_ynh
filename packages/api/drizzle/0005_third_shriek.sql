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
-- (2 accounts, 7 folders), one run, before and after. Figures are the
-- top-level `Limit` node's own time and buffers -- NOT the `Planning:` block's
-- buffers line, which sits directly above `Planning Time` and is easy to
-- misread as the query's:
--
--   * a folder holding only OLD threads -- the honest worst case, where the
--     ordered walk passes nearly every thread before it fills a page:
--     60 such threads, 61.5ms / 122,737 buffers -> 3.8ms / 252;
--   * an ordinary large folder (INBOX, ~10.7k threads): 0.31ms / 357 ->
--     0.24ms / 254;
--   * a mid-sized folder spread over the whole range (~1.8k threads):
--     1.48ms / 2,954 -> 1.08ms / 1,509;
--   * an empty folder: 3.13ms / 824 -> 0.05ms / 3.
--
-- THE BIG WIN IS A PLAN FLIP, AND THE FLIP IS NOT UNIVERSAL. Where the planner
-- can see that a folder holds few threads it abandons the per-thread probe for
-- a hash semi join fed by an index-only scan (the 60-thread case above, 16x).
-- Where it cannot -- 2,000 OLD threads, enough that the ordered walk still
-- looks cheap enough to it -- it keeps the nested loop and the index only makes
-- each probe index-only: 52.5ms / 110,443 -> 36.3ms / 53,211, about 1.5x in
-- time and 2x in buffers. Worth having either way (no case measured slower),
-- but do not read the headline number as what every folder gets.
--
-- Column order: folder leads because it is the only column the folder-only
-- filter binds, and thread_id follows so the correlation is answered from the
-- index alone. 1.6MB at 85k messages, against a 35MB table.
CREATE INDEX "mail_messages_folder_thread_idx" ON "mail_messages" USING btree ("folder","thread_id");--> statement-breakpoint
-- Same block, same rules: 0004's unseen partial index is REPLACED here rather
-- than edited there (0004 shipped in v0.5.0 and is immutable). The name is
-- deliberately unchanged, so this migration leaves exactly one index of that
-- name and 0004's own comment still describes the right object.
--
-- NAMED QUERIES: the unread badge and the sidebar's per-folder counts
-- (services/mail-threads.ts's unreadThreadCount / unreadCountsByFolder) --
--   SELECT count(DISTINCT m.thread_id) FROM mail_messages m
--     JOIN mail_threads t ON t.id = m.thread_id
--     JOIN mail_accounts a ON a.id = m.account_id      -- badge only
--    WHERE t.archived_at IS NULL AND m.seen = false
--      AND <m.folder is not a's trash folder>          -- badge only
--
-- WHY: Task 4's Trash carve-out made the badge read `folder` and `account_id`,
-- which 0004's index does not carry. That cost it the index-only scan it was
-- built for -- the plan fell back to a bitmap heap scan and went and fetched
-- ~2,000 heap blocks to read two columns. MEASURED at 85,000 messages with
-- 8,000 unread (top-level Aggregate node):
--
--   * badge, pre-4.1 (no carve-out), 0004 index: 9.98ms / 298 buffers,
--     Index Only Scan, Heap Fetches: 0;
--   * badge, WITH the carve-out, 0004 index: 25.4ms / 2,257 buffers, Bitmap
--     Heap Scan, 1,962 heap blocks -- the regression this replaces;
--   * badge, WITH the carve-out, this index: 19.3ms / 311 buffers, Index Only
--     Scan, Heap Fetches: 0 again.
--
-- The per-folder counts get it too (12.4ms / 310, Heap Fetches: 0): `folder`
-- is the GROUP BY key, and it now comes from the index rather than the heap.
-- INCLUDE rather than more key columns because neither column is ever a search
-- term here -- they are payload, and keeping them out of the key leaves the
-- index ordered by thread_id alone. Cost: 264kB -> 504kB at 8k unread rows.
DROP INDEX "mail_messages_unseen_thread_idx";--> statement-breakpoint
CREATE INDEX "mail_messages_unseen_thread_idx" ON "mail_messages" USING btree ("thread_id") INCLUDE ("folder","account_id") WHERE seen = false;