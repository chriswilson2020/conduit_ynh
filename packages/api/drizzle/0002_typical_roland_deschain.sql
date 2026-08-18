CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"value_cents" bigint,
	"currency" char(3) NOT NULL,
	"expected_close_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"lost_reason" text,
	"closed_at" timestamp with time zone,
	"owner_user_id" uuid,
	"company_id" uuid,
	"contact_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_status_valid" CHECK (status IN ('open','won','lost')),
	CONSTRAINT "deals_lost_reason_paired" CHECK (lost_reason IS NULL OR status = 'lost'),
	CONSTRAINT "deals_closed_at_paired" CHECK ((closed_at IS NOT NULL) = (status <> 'open')),
	CONSTRAINT "deals_currency_format" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"company_id" uuid,
	"position" text COLLATE "C" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipelines_scope_valid" CHECK (scope IN ('global','company')),
	CONSTRAINT "pipelines_scope_company_paired" CHECK ((scope = 'company') = (company_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"probability" integer,
	"rot_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stages_probability_range" CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_verb_valid";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_exactly_one_entity";--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_exactly_one_entity";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_verb_valid" CHECK (verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id) = 1);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id) = 1);