CREATE TABLE "meeting_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"contact_id" uuid,
	"user_id" uuid,
	"guest_name" text,
	CONSTRAINT "meeting_attendees_exactly_one" CHECK (num_nonnulls(contact_id, user_id, guest_name) = 1)
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer,
	"notes" text,
	"owner_user_id" uuid NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_has_link" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id) >= 1)
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_verb_valid";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "mail_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_mail_thread_id_mail_threads_id_fk" FOREIGN KEY ("mail_thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_verb_valid" CHECK (verb IN ('created','updated','archived','unarchived','note_added','file_attached','stage_changed','won','lost','reopened','shifted','completed','dependency_added','dependency_removed','met','mail_sent','mail_received'));--> statement-breakpoint
-- Hand-written block, same terms as 0004's: neither index below exists in
-- schema.ts or the drizzle-kit snapshot (drizzle's index() builder is unused
-- throughout this schema -- see the mail comment block in src/db/schema.ts).
-- They exist in the database only, so `drizzle-kit push` must never be
-- introduced (it would DROP both, having no schema.ts record of them), and
-- declaring either later via index() means deleting its CREATE INDEX here
-- first or drizzle-kit will try to create a duplicate.
--
-- The rule: the same contact, or the same user, can be on one meeting only
-- once -- attendees are replaced as a set on update, and a double-add is a
-- UI slip, not a fact about the meeting. Partial rather than plain because
-- of what each index is ABOUT: every user/guest row carries contact_id NULL
-- and every contact/guest row carries user_id NULL (the
-- meeting_attendees_exactly_one CHECK guarantees it), and those NULLs are
-- not what either index is for. Postgres treats NULLs as distinct in a
-- unique index, so a plain UNIQUE would enforce the same rule -- the WHERE
-- states the intent instead of relying on that, and keeps each index to the
-- rows it actually indexes. 0004's mail_accounts_user_email_active_unique is
-- the precedent for a semantic constraint shipped this way.
--
-- GUESTS ARE DELIBERATELY NOT DEDUPED (spec's data model). guest_name is
-- free text and two people at one meeting can genuinely share a name; a
-- third index over it would reject a truthful attendee list and force
-- whoever logged the meeting to invent distinguishing text.
CREATE UNIQUE INDEX "meeting_attendees_meeting_contact_unique" ON "meeting_attendees" USING btree ("meeting_id","contact_id") WHERE "contact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendees_meeting_user_unique" ON "meeting_attendees" USING btree ("meeting_id","user_id") WHERE "user_id" IS NOT NULL;
-- NO BACKFILL RIDES THIS MIGRATION, and that is a decision, not an omission
-- (Phase 5 spec, Data model): the two new events columns stay NULL on every
-- pre-existing row and no historical mail is turned into timeline entries.
-- Synthesising a mail_sent/mail_received event for every stored message
-- would be large and slow, and it would bury real activity under an import
-- spike on every record's timeline. The timeline therefore starts telling
-- the mail story from upgrade forward; the release notes say so, so absent
-- history is not read as a bug. (Contrast 0007, whose backfill existed
-- precisely so the upgrade would change nobody's view -- here, writing
-- nothing is what leaves every existing timeline as it was.)