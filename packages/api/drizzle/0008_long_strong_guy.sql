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
-- Hand-written block, same terms as 0004's: none of the indexes below exist
-- in schema.ts or the drizzle-kit snapshot (drizzle's index() builder is
-- unused throughout this schema -- see the mail comment block in
-- src/db/schema.ts). They exist in the database only, so `drizzle-kit push`
-- must never be introduced (it would DROP all three, having no schema.ts
-- record of them), and declaring any one later via index() means deleting its
-- CREATE INDEX here first or drizzle-kit will try to create a duplicate.
--
-- The rule the two unique indexes enforce: the same contact, or the same
-- user, can be on one meeting only once -- attendees are replaced as a set on
-- update, and a double-add is a UI slip, not a fact about the meeting.
-- Partial rather than plain because of what each index is ABOUT: every
-- user/guest row carries contact_id NULL and every contact/guest row carries
-- user_id NULL (the meeting_attendees_exactly_one CHECK guarantees it), and
-- those NULLs are not what either index is for. Postgres treats NULLs as
-- distinct in a unique index, so a plain UNIQUE would enforce the same rule
-- -- the WHERE states the intent instead of relying on that, and keeps each
-- index to the rows it actually indexes. 0004's
-- mail_accounts_user_email_active_unique is the precedent for a semantic
-- constraint shipped this way.
--
-- COLUMN ORDER is (identity, meeting_id), not the reverse: uniqueness of a
-- PAIR is order-independent, so both orders enforce the identical rule at
-- identical cost, and leading with the identity column additionally makes
-- each index probe-usable by that column alone -- which listMeetings'
-- contact-attendance arm needs (`meetings.contact_id = C OR EXISTS an
-- attendee row for C`; measured through this index as a hashed SubPlan with
-- an Index Only Scan, 305 buffers / 1.08ms at 50k meetings / 150k attendees,
-- warm). The index NAMES state the pair, which is order-independent, so they
-- are unchanged by that choice. Hydration ("this page of meetings' attendees")
-- does not depend on either order; it has its own index below.
--
-- GUESTS ARE DELIBERATELY NOT DEDUPED (spec's data model). guest_name is
-- free text and two people at one meeting can genuinely share a name; a
-- third unique index over it would reject a truthful attendee list and force
-- whoever logged the meeting to invent distinguishing text.
CREATE UNIQUE INDEX "meeting_attendees_meeting_contact_unique" ON "meeting_attendees" USING btree ("contact_id","meeting_id") WHERE "contact_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendees_meeting_user_unique" ON "meeting_attendees" USING btree ("user_id","meeting_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
-- Hydration: every meeting-returning path (create, get, update, archive,
-- unarchive, and each listMeetings page) loads its attendees by meeting_id,
-- and NEITHER partial unique above covers a guest row -- guests are in no
-- index at all without this one. MEASURED (quality review; 50k meetings /
-- 150k attendees, warm): the attendee load was a parallel sequential scan at
-- 1,392 buffers / ~18ms, and 6 buffers with this index; a 50-row page's
-- lookup becomes a bitmap index scan over the same 1,392. 0004's
-- mail_attachments_message_id_idx and mail_messages_thread_id_idx are the
-- precedent -- the child-rows-of-a-page index every hydration query needs.
CREATE INDEX "meeting_attendees_meeting_id_idx" ON "meeting_attendees" USING btree ("meeting_id");
-- NO INDEX ON THE MEETINGS SIDE, and that is a MEASURED deferral rather than
-- an oversight. At 50k meetings the record-filtered keyset page IS the cost
-- centre (782 buffers / 4.3ms, and 43 buffers / 0.10ms with a candidate
-- (company_id, occurred_at DESC, id DESC) index) -- the OR in the
-- contact-attendance arm prevents any index driving the outer side, so the
-- scan is what remains. This deployment holds hundreds of meetings, where
-- that same scan is sub-millisecond, and an index that is not needed is
-- write cost plus a second thing to keep true. RE-MEASURE TRIGGER: on the
-- order of 10k meetings, re-EXPLAIN listMeetings' four record filters and
-- add the four record-FK/keyset indexes if the figures above have arrived.
-- mail_threads is the structural twin to copy then (four record FKs, keyset
-- pagination, per-record tabs -- it ships all four record-FK indexes plus its
-- keyset index in 0004), NOT notes/files/events, which are unpaginated
-- whole-record loads.
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