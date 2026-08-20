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
ALTER TABLE "mail_account_folders" ADD CONSTRAINT "mail_account_folders_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;