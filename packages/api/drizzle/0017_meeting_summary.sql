-- THE SECOND DOCUMENT TYPE, AND THE TWO THINGS 0016 LEFT FOR IT.
--
-- Phase 9 Task 2. `meeting_summary` is the type with no form: its whole content
-- is a `meetings` row -- title, date, attendees, notes -- so nothing about it is
-- submitted, which is why the plan put it immediately after the data model.
-- Everything below is either the type itself or one of the two decisions 0016
-- deferred to whichever task became the second type.
--
-- IT MOVES NO ROWS. 0016 was the one migration in this project that did, and it
-- is a useful contrast: every statement here is a catalogue change or a
-- metadata-only ADD COLUMN, plus one INSERT of a template row. Three of them
-- validate existing rows (the two CHECKs and the composite foreign key), which on
-- a `documents`/`files` table holding tens to hundreds of rows is three sequential
-- scans under ACCESS EXCLUSIVE. 0013's header has the general argument about
-- migrations running before the server listens; it applies here unchanged.
--
-- THE ROLLBACK COST, stated because 0016's was not free and this one nearly is.
-- Every column this migration adds is one the previous release never selects, so
-- rolling the CODE back to v1.7.x leaves a database it can read: quotes still
-- have numbers, `document_quotes` still has its eleven columns, and the extra
-- `type` and `meeting_id` columns are simply never named. What such a build
-- cannot do is anything with a `meeting_summary` row -- those documents become
-- invisible rather than corrupt, and reappear if the code comes forward again.
-- The one genuinely irreversible act would be reverting the SCHEMA, since
-- documents_number_matches_type cannot be satisfied by putting `NOT NULL` back
-- while an unnumbered row exists; that is a restore, and it is the same restore
-- 0016 already made the answer to any rollback of this phase.
--
-- ============================== 1. THE TYPE =================================
--
-- Dropped and re-added by name rather than altered, because PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK. Named explicitly, which is 0015's lesson: a
-- constraint name in a migration is a claim about what an earlier migration
-- really created, so a name that has drifted fails loudly here rather than
-- leaving a constraint alive under a table it was meant to leave.
ALTER TABLE "documents" DROP CONSTRAINT "documents_type_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_valid" CHECK (type IN ('quote','meeting_summary'));--> statement-breakpoint
ALTER TABLE "document_templates" DROP CONSTRAINT "document_templates_type_valid";--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_type_valid" CHECK (type IN ('quote','meeting_summary'));--> statement-breakpoint
-- documents_frozen_matches_type IS DELIBERATELY NOT TOUCHED, and its absence from
-- this migration is a statement rather than an omission. It reads
-- `frozen = (type IN ('quote'))`, and a meeting summary is NOT frozen (Chris's
-- decision, 6 Sep), so it belongs on the FALSE side of an equality that already
-- says so. This is also the first evidence that 0016 was right to write it as an
-- equality: an implication would have admitted a frozen meeting summary in
-- silence, and with one type in existence no test could have told the two apart.
--
-- document_number_sequences_type_valid IS NOT TOUCHED EITHER, for a stronger
-- reason -- see section 2.
--
-- ============================ 2. NO NUMBER ==================================
--
-- **`documents.number` STOPS BEING NOT NULL, WHICH IS THE MIGRATION 0016's
-- COMMENT PREDICTED SOMEBODY WOULD HAVE TO WRITE.** A meeting summary takes no
-- number; @conduit/shared's documentTypeNumbered() carries the three reasons (an
-- external handle nobody holds, a row lock that would serialise issuing to buy a
-- string nobody reads, and a type that can be produced again, which a number
-- cannot survive).
--
-- THE UNIQUE CONSTRAINT NEEDS NO CHANGE AND THAT IS NOT LUCK. PostgreSQL treats
-- NULLs as distinct in a UNIQUE constraint unless it is declared NULLS NOT
-- DISTINCT (PG15+, opt-in), so documents_number_unique goes on meaning exactly
-- what it meant for every numbered row and imposes nothing on the unnumbered
-- ones. A partial unique index `WHERE number IS NOT NULL` would be the same
-- guarantee in more SQL and one more object to keep.
--
-- WHAT REPLACES `NOT NULL` IS STRICTLY STRONGER THAN IT WAS. `NOT NULL` forbade
-- an unnumbered quote. documents_number_matches_type forbids that AND a numbered
-- meeting summary -- which is a shape `NOT NULL` could never have refused, and
-- which formatDocumentNumber's `?? "DOC"` fallback would otherwise mint as
-- `DOC-2026-0001` for any type that reached it.
ALTER TABLE "documents" ALTER COLUMN "number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_number_matches_type" CHECK ((number IS NOT NULL) = (type IN ('quote')));--> statement-breakpoint
-- THE THIRD ENFORCEMENT IS AN ABSENCE. `document_number_sequences_type_valid`
-- still reads `type IN ('quote')` and is not widened here, so a writer that
-- called allocateNumber() for a meeting summary fails on that INSERT rather than
-- starting a private `DOC-2026-` series. That CHECK used to be "the same enum
-- documents.type carries"; from this migration on it is the narrower list of
-- types that are NUMBERED, and db/schema.test.ts pins it against
-- documentTypeNumbered so nobody "fixes" it back into agreement with
-- documents_type_valid.
--
-- ====================== 3. THE COMPOSITE FOREIGN KEY ========================
--
-- **THE OTHER THING 0016 LEFT FOR THE SECOND TYPE.** Its comment: "Task 2 is both
-- the first moment it would catch anything and the first moment it could be
-- tested as more than structure; it is a cheap ALTER then." Both turned out true.
--
-- WHAT IT CATCHES, specifically. Without it, `INSERT INTO document_quotes
-- (document_id, ...)` naming a meeting summary's id succeeds -- and the row is
-- not inert, because every read of a quote in this codebase is an INNER (now
-- LEFT) JOIN on document_id. listDocuments and export.ts's documentsSheet would
-- start returning that summary as a quote, with a currency and three money
-- columns, from code that never asked whether it was one. The join is what makes
-- the missing constraint reachable rather than theoretical.
--
-- THE REDUNDANT COLUMN COSTS NOTHING TO KEEP IN STEP, which was 0016's objection
-- to paying for it. `document_quotes.type` is NOT NULL DEFAULT 'quote' with a
-- CHECK pinning it to 'quote', so it is a constant: no writer mentions it, no
-- writer can change it, and there is no path by which it can disagree with the
-- row it describes. The DEFAULT is also what fills every existing row in the same
-- metadata-only statement -- every row in document_quotes is a quote, because
-- 0016's INSERT ... SELECT put them there out of a table whose only type was
-- 'quote'.
--
-- THE UNIQUE ON documents(id, type) FORBIDS NOTHING. `id` is already the primary
-- key; PostgreSQL simply requires a UNIQUE over the exact column list a foreign
-- key references, and (id, type) is that list. Its index is the price of the
-- constraint.
--
-- NO ON DELETE CASCADE, matching every other foreign key in this schema: a
-- document is never deleted, so a cascade would be configuration that can only
-- fire by accident.
ALTER TABLE "documents" ADD CONSTRAINT "documents_id_type_unique" UNIQUE("id","type");--> statement-breakpoint
ALTER TABLE "document_quotes" ADD COLUMN "type" text DEFAULT 'quote' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_quotes" ADD CONSTRAINT "document_quotes_type_is_quote" CHECK (type = 'quote');--> statement-breakpoint
ALTER TABLE "document_quotes" ADD CONSTRAINT "document_quotes_document_id_type_fk" FOREIGN KEY ("document_id","type") REFERENCES "public"."documents"("id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ==================== 4. A MEETING BECOMES A FILE'S PARENT ==================
--
-- **NOT BECAUSE A MEETING CAN HAVE FILES, BUT BECAUSE IT CAN HAVE A DOCUMENT.**
-- `documents.file_id` is NOT NULL and every rendered PDF is an ordinary `files`
-- row (Phase 7's design, and what makes GET /api/files/:id/download the only
-- download path there is), so a meeting summary -- whose `documents` row sets
-- meeting_id and nothing else -- needed somewhere to put its page.
--
-- REJECTED, ALL THREE: filing it under one of the MEETING's own links (a meeting
-- may carry a company and a deal and a project, so "which one" is an arbitrary
-- rule, and the file would end up attached to a record its own document says it
-- is not about); making documents.file_id nullable and giving documents a private
-- blob path (two download routes, two storage stories); a `meeting_files` table
-- (every reader of files becomes two readers).
--
-- `notes` KEEPS THE FOUR. Phase 5's argument for excluding meetings there -- "a
-- note about a meeting goes on the meeting's own record" -- is about what a PERSON
-- writes, and a rendered document is not written by a person.
--
-- THE UPLOAD ROUTE IS NOT WIDENED. POST /api/files still parses the four, so the
-- only writer that can set this column is services/documents.ts issuing a
-- summary. The CHECK is about what a row may BE; which callers may write one is
-- the route's question and it answers it more narrowly.
--
-- The CHECK is dropped and re-added around the new column, and the ADD COLUMN
-- comes first so the re-added constraint can name it. Every existing row has
-- exactly one of the original four set and a NULL meeting_id, so the wider
-- num_nonnulls is true of all of them.
ALTER TABLE "files" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_exactly_one_entity";--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_exactly_one_entity" CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id, meeting_id) = 1);--> statement-breakpoint
-- ========================= 5. THE INDEX 0016 DEFERRED =======================
--
-- 0016 added four record foreign keys to `documents` and deliberately no index on
-- any of them: "nothing reads documents by company, contact, project or meeting
-- yet, because no type attaches to one... four indexes created here would be four
-- indexes maintained by every INSERT and used by no SELECT until Task 2. A CREATE
-- INDEX is a cheap migration; this one is not, and they do not have to travel
-- together."
--
-- `listMeetingSummaries` is the SELECT that changed that, so its migration builds
-- the one index it uses. The other three stay unbuilt on the same reasoning, and
-- will arrive with the reads that need them: company and contact with the NDA,
-- project with the status report.
--
-- NOT (meeting_id, created_at) and not partial, which is 0009's own argument for
-- documents_deal_idx repeated: a meeting carries single-digit numbers of
-- summaries, so the sort is free once the rows are found. No figures are quoted
-- because none were taken; the column is empty on every deployment in existence.
CREATE INDEX "documents_meeting_idx" ON "documents" ("meeting_id");--> statement-breakpoint
-- ==================== 6. THE DEFAULT MEETING SUMMARY TEMPLATE ===============
--
-- Seeded here for 0009's reason: the feature has to work before anyone has opened
-- Settings, and a type whose template row does not exist answers 409 at issue.
-- Written across many lines on purpose -- Postgres string literals may contain
-- newlines, drizzle's migrator splits this file only on the statement-breakpoint
-- marker, and the alternative is a template nobody can review or diff.
--
-- THE SAME THREE THINGS ARE LOAD-BEARING HERE AS IN 0009'S QUOTE TEMPLATE: every
-- {{...}} must be a field the merge resolver knows (an unknown one renders as a
-- silent blank); no literal `{{` may appear in the CSS, which is why the nested
-- at-rule is written `{ @` with a space; and class="pre" is white-space: pre-line
-- for the newline-separated fields. schema.test.ts checks the first two by
-- reading this row back.
--
-- WHAT THIS TEMPLATE NAMES THAT THE QUOTE'S DOES NOT:
--
--   {{document.notes}}   THE ONE RAW-HTML FIELD IN THE SYSTEM. meetings.notes is
--                        TipTap rich text, so it arrives as markup and is emitted
--                        without escaping (services/documents-template.ts's
--                        MergeHtml) and then sanitised with the rest of the page.
--                        A template CANNOT ask for that -- the context decides,
--                        in code -- so writing {{document.title}} beside it still
--                        gets escaped text.
--   {{#attendees}}       A second repeated collection beside {{#lines}}, proving
--                        the block machinery was never quote-specific. `name` is
--                        the only field an attendee has: the three kinds (a
--                        contact, a Conduit user, a free-text guest) are resolved
--                        to one display name in the service, because a page that
--                        printed which KIND each attendee was would be leaking an
--                        internal distinction to the people who were in the room.
--
-- WHAT IT DELIBERATELY DOES NOT NAME: {{document.number}}, because this type has
-- none. It would render as a blank, which is the correct outcome and also the
-- reason the omission has to be deliberate rather than noticed.
--
-- BOTH EMPTY CASES ARE WRITTEN OUT, using the inverted block. A meeting with no
-- attendees recorded and a meeting with no notes are both completely ordinary,
-- and 0009's logo lesson generalises: a heading standing over a blank is what you
-- get if you leave the conditional out.
INSERT INTO "document_templates" ("type", "body_html") VALUES ('meeting_summary', '<style>
@page { size: A4; margin: 18mm 16mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.4; color: #111; }
h1 { font-size: 18pt; margin: 5mm 0 3mm; }
h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.4pt; color: #666; margin: 7mm 0 2mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 3mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
table.meta { margin-top: 4mm; }
table.meta td { padding: 0 6mm 1mm 0; vertical-align: top; }
ul.attendees { margin: 0; padding-left: 5mm; }
ul.attendees li { margin-bottom: 0.8mm; }
.notes { margin-top: 1mm; }
</style>
<div>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt="" /></div>{{/org.logoDataUri}}
<div><strong>{{org.name}}</strong></div>
{{#org.addressLines}}<div class="pre">{{org.addressLines}}</div>{{/org.addressLines}}
{{#org.email}}<div>{{org.email}}</div>{{/org.email}}
{{#org.phone}}<div>{{org.phone}}</div>{{/org.phone}}
{{#org.website}}<div>{{org.website}}</div>{{/org.website}}
</div>
<h1>{{document.title}}</h1>
<table class="meta">
<tr><td class="label">Meeting</td><td>{{document.meetingWhen}}</td></tr>
{{#document.duration}}<tr><td class="label">Duration</td><td>{{document.duration}}</td></tr>{{/document.duration}}
<tr><td class="label">Summary issued</td><td>{{document.issueDate}}</td></tr>
</table>
<h2>Attendees</h2>
<ul class="attendees">{{#attendees}}<li>{{name}}</li>{{/attendees}}</ul>
{{^attendees}}<div class="muted">No attendees were recorded.</div>{{/attendees}}
<h2>Notes</h2>
{{#document.notes}}<div class="notes">{{document.notes}}</div>{{/document.notes}}
{{^document.notes}}<div class="muted">No notes were recorded.</div>{{/document.notes}}');
