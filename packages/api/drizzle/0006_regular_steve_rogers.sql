ALTER TABLE "mail_accounts" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
-- No index rides this migration, and that is a MEASURED decision, not the
-- spec's expectation taken on faith. The visibility predicate folds an
-- accounts join into every folder-scoped EXISTS (services/mail-threads.ts),
-- whose subquery now reads account_id -- a column 0005's
-- mail_messages_folder_thread_idx does not carry. Re-EXPLAINed on 0005's
-- methodology (20,000 threads / 82,000 messages, two users' private
-- accounts): the join BINDS account_id, so the planner reaches for 0004's
-- (account_id, folder, imap_uid) index instead and 0005's worst case
-- IMPROVES (60-old-threads folder: 0.72ms/191 buffers -> 0.54ms/187 folded);
-- the probe-heavy views pay ~2x buffers (INBOX 0.36ms/157 -> 0.83ms/411,
-- ~1.8k-thread folder 1.26ms/1,673 -> 3.2ms/3,484). A candidate
-- (folder, thread_id) INCLUDE (account_id) replacement bought no decisive
-- win (spread folder 265 buffers but 6.1ms via a plan flip; INBOX
-- 0.56ms/361), so it was not added. The unseen partial index keeps
-- Heap Fetches: 0 under its new accounts join (badge 10.5ms/322, per-folder
-- 11.5ms/325) -- its INCLUDE payload already carries account_id. Full
-- figures beside each query in services/mail-threads.ts.
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_visibility_valid" CHECK (visibility IN ('private','shared'));
