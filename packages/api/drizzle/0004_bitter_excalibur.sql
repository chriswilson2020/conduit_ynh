CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_html" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"email" text NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_security" text NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_security" text NOT NULL,
	"username" text NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"sent_folder" text DEFAULT 'Sent' NOT NULL,
	"signature_html" text,
	"backfill_days" integer DEFAULT 90,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_accounts_imap_security_valid" CHECK (imap_security IN ('tls','starttls')),
	CONSTRAINT "mail_accounts_smtp_security_valid" CHECK (smtp_security IN ('tls','starttls')),
	CONSTRAINT "mail_accounts_status_valid" CHECK (status IN ('active','error'))
);
--> statement-breakpoint
CREATE TABLE "mail_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"blob_path" text NOT NULL,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_folder_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"last_seen_uid" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_folder_state_account_folder_unique" UNIQUE("account_id","folder")
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"from_addr" text NOT NULL,
	"from_name" text,
	"to_addrs" jsonb NOT NULL,
	"cc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"snippet" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"folder" text NOT NULL,
	"imap_uid" bigint,
	"seen" boolean DEFAULT false NOT NULL,
	"direction" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(from_addr,'') || ' ' || coalesce(from_name,''))) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_account_message_unique" UNIQUE("account_id","message_id"),
	CONSTRAINT "mail_messages_direction_valid" CHECK (direction IN ('inbound','outbound'))
);
--> statement-breakpoint
CREATE TABLE "mail_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_folder_state" ADD CONSTRAINT "mail_folder_state_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written block: none of the indexes below exist in schema.ts or the
-- drizzle-kit snapshot (drizzle's index() builder is unused throughout this
-- migration -- see schema.ts's searchVector customType comment for why the
-- GIN index specifically can't be declared that way). They exist in the
-- database only. Consequences: `drizzle-kit push` must never be introduced
-- to this project (it diffs against the live DB and would DROP every index
-- here, having no schema.ts record of them); and declaring any one of them
-- later via index() requires first removing its hand-written CREATE INDEX
-- here, or drizzle-kit will try to create a duplicate.
--
-- Full-text search (websearch_to_tsquery against mail_messages.search) is a
-- later task; this GIN index is laid down now so that task never needs its
-- own migration.
CREATE INDEX "mail_messages_search_idx" ON "mail_messages" USING gin ("search");--> statement-breakpoint
-- Thread's message list is always "WHERE thread_id = ... ORDER BY sent_at";
-- this is the index that query needs.
CREATE INDEX "mail_messages_thread_id_idx" ON "mail_messages" USING btree ("thread_id");--> statement-breakpoint
-- Threading (mail-threading.ts, a later task) looks up an existing message
-- by message_id alone when walking a new message's references/in_reply_to
-- chain -- the hottest write-path query in the sync engine. Without this,
-- that's a sequential scan on every ingested message.
CREATE INDEX "mail_messages_message_id_idx" ON "mail_messages" USING btree ("message_id");--> statement-breakpoint
-- Every thread-open loads its messages' attachments.
CREATE INDEX "mail_attachments_message_id_idx" ON "mail_attachments" USING btree ("message_id");--> statement-breakpoint
-- GET /api/mail/threads' default ordering: keyset pagination on
-- (last_message_at, id) DESC (per the Phase 4 spec's routes section) --
-- composite and matching the pagination direction, so the keyset query is a
-- single index scan rather than a sort.
CREATE INDEX "mail_threads_last_message_at_idx" ON "mail_threads" USING btree ("last_message_at" DESC, "id" DESC);--> statement-breakpoint
-- The four thread FKs: each is a filter GET /api/mail/threads supports
-- (company_id/contact_id/deal_id/project_id) and each record page's Mail
-- tab ("threads linked to this company/contact/deal/project") queries by
-- exactly one of these.
CREATE INDEX "mail_threads_company_id_idx" ON "mail_threads" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mail_threads_contact_id_idx" ON "mail_threads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "mail_threads_deal_id_idx" ON "mail_threads" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "mail_threads_project_id_idx" ON "mail_threads" USING btree ("project_id");