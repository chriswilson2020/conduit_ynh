ALTER TABLE "mail_accounts" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_visibility_valid" CHECK (visibility IN ('private','shared'));
