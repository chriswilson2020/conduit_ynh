CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"company_id" uuid,
	"deal_id" uuid,
	"owner_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" date,
	"due_date" date,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_status_valid" CHECK (status IN ('active','completed')),
	CONSTRAINT "projects_color_format" CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$')
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"type" text DEFAULT 'FS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pred_succ_unique" UNIQUE("predecessor_id","successor_id"),
	CONSTRAINT "task_dependencies_type_valid" CHECK (type IN ('FS')),
	CONSTRAINT "task_dependencies_no_self_ref" CHECK (predecessor_id <> successor_id)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'task' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"assignee_user_id" uuid,
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"progress_pct" integer,
	"parent_task_id" uuid,
	"position" text COLLATE "C" NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_type_valid" CHECK (type IN ('task','call','meeting','email','deadline')),
	CONSTRAINT "tasks_status_valid" CHECK (status IN ('todo','in_progress','blocked','done')),
	CONSTRAINT "tasks_dates_paired" CHECK ((start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND due_date IS NOT NULL AND start_date <= due_date)),
	CONSTRAINT "tasks_completed_at_paired" CHECK ((completed_at IS NOT NULL) = (status = 'done')),
	CONSTRAINT "tasks_progress_range" CHECK (progress_pct IS NULL OR (progress_pct >= 0 AND progress_pct <= 100))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_verb_valid";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_exactly_one_entity";--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_exactly_one_entity";--> statement-breakpoint
ALTER TABLE "pipelines" DROP CONSTRAINT "pipelines_scope_company_paired";--> statement-breakpoint
ALTER TABLE "pipelines" DROP CONSTRAINT "pipelines_scope_valid";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_id_tasks_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_id_tasks_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_verb_valid" CHECK (verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened','shifted','completed','dependency_added','dependency_removed'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id) = 1);--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id) = 1);--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_scope_paired" CHECK ((
    (scope = 'global' AND company_id IS NULL AND project_id IS NULL) OR
    (scope = 'company' AND company_id IS NOT NULL AND project_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL AND company_id IS NULL)
  ));--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_scope_valid" CHECK (scope IN ('global','company','project'));