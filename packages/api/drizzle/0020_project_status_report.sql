-- THE PROJECT STATUS REPORT, AND THE CHECK THAT SAYS WHICH RECORD EACH TYPE GOES ON.
--
-- Phase 9 Task 4, the last one. Two things arrive: the sixth document type, and
-- `documents_entity_matches_type` -- a rule about ALL SIX types that Task 3 wrote
-- out in the plan and deliberately did not add, because two of the six were not
-- its to decide. Section 3 is that CHECK.
--
-- **THE TYPE ADDS NO DETAIL TABLE, WHICH IS THE SECOND TIME AND THE SECOND
-- REASON.** 0017's meeting summary added none because its whole content is the
-- `meetings` row it points at. This one adds none because its whole content is a
-- `projects` row, the `tasks` on it and their `task_dependencies` -- and, unlike a
-- letter's body, not one byte of that was typed into this document. There is
-- nothing to store that is not already stored somewhere it is maintained. What is
-- snapshot is the PDF, which is content-addressed and is the only thing that can
-- be. See services/documents.ts's `issueStatusReport` for the full argument,
-- including the one thing a detail table WOULD have bought (a summary line on a
-- list without re-reading the project) and why that is not worth a table.
--
-- **AND IT TAKES NO INPUT AT ALL, WHICH THE SPEC DID NOT EXPECT.** The spec's
-- table gives this type "possibly a date range" and the plan asked for the
-- question to be settled before a form was built. It was settled NO. The short
-- version: `tasks_dates_paired` permits an UNDATED task, a range would have to
-- decide what to do with one, and every available answer is wrong on a status
-- report -- dropping them hides exactly the tasks that most need attention, and
-- keeping them makes the range not a filter. The long version is at
-- `issueStatusReport`.
--
-- IT MOVES NO ROWS. Two CHECK swaps, one CHECK added, one index, one template row
-- -- 0017's, 0018's and 0019's shape, and not 0016's. The three constraint
-- statements validate `documents` and `document_templates` under ACCESS EXCLUSIVE,
-- which on tables holding tens of rows is three sequential scans; 0013's header
-- has the general argument about migrations running before the server listens.
--
-- THE ROLLBACK COST is 0019's exactly. Every object here is new or wider, so the
-- CODE can roll back to a five-type build and still read the database; what such a
-- build cannot do is show a status report, which becomes invisible rather than
-- corrupt. Reverting the SCHEMA is the irreversible half -- the narrow
-- `documents_type_valid` cannot be restored while a report row exists -- and the
-- answer to that is the restore 0016 already made the answer to any rollback of
-- this phase.
--
-- **GENERATED AND THEN REWRITTEN, WHICH IS NOW FIVE TIMES OUT OF FIVE, AND THE
-- JOURNAL TRAP FIRED FOR THE FIFTH TIME.** `drizzle-kit generate` stamped 0020's
-- `when` as **1788697198962** (measured, twice, on the dev server), which falls
-- between 0013's 1788600000000 and 0014's 1788700000000 -- so 0020 would have been
-- skipped, silently and without error, on every install that already has 0014.
-- drizzle applies a migration only when the newest applied row's created_at is
-- BELOW it (drizzle-orm/pg-core/dialect.js), so there is no failure to see.
-- Identical to 0016's, 0017's, 0018's and 0019's. Hand-set to 1789300000000;
-- schema.test.ts pins the whole journal as strictly increasing.
--
-- **FIVE FOR FIVE IS NOT A RUN OF BAD LUCK, AND THE DATES SAY EXACTLY WHY.**
-- `when` is `Date.now()`. Entries 0013 onwards carry hand-set round numbers that
-- were AHEAD of the wall clock when they were written, and each new one was spaced
-- by adding 1e11 ms (about 1.16 days) rather than by re-reading the clock, so the
-- gap has widened with every migration:
--
--   0013  1788600000000  2026-09-05T09:20Z
--   0014  1788700000000  2026-09-06T13:06Z
--   ...
--   0019  1789200000000  2026-09-12T08:00Z
--   0020  1789300000000  2026-09-13T11:46Z   <- this file, hand-set
--   generate said 1788697198962  2026-09-06T12:19Z
--
-- Today is 2026-09-06, so `Date.now()` currently lands between 0013 and 0014 --
-- 47 minutes below 0014, which is how close this one came to landing somewhere
-- else and looking like a different bug. **What matters is not which gap it lands
-- in but that it lands BELOW the newest entry**: drizzle reads the one newest
-- applied row and applies a migration only when that row's created_at is below it,
-- so any generated `when` under 1789300000000 is skipped. **That is every
-- migration generated before 2026-09-13T11:46Z**, a week from now.
--
-- **AND IT CANNOT BE FIXED BY CHOOSING A SMALLER NUMBER HERE.** A `when` must
-- exceed 0019's, and 0019's is already six days ahead of the clock. So the trap is
-- locked in for whoever writes 0021 as well, and the only things standing between
-- it and a silent skip are this header and schema.test.ts's journal test.
--
-- What generate got RIGHT this time is the three constraint statements, which are
-- its work and are kept (reordered so the two DROPs sit beside their own ADDs;
-- generate emits all the DROPs first, which is correct and unreadable). What it
-- cannot know about is the index and the template row -- and, as ever, the
-- ordering constraint that a CHECK must be dropped before its replacement is
-- added, which it happens to get right when the names collide.
--
-- ======================= 1. THE SIXTH TYPE, AND ITS TEMPLATE ================
--
-- Dropped and re-added by name rather than altered, because PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK, and named explicitly for 0015's reason: a
-- constraint name in a migration is a claim about what an earlier migration really
-- created, so a name that has drifted fails loudly here.
ALTER TABLE "documents" DROP CONSTRAINT "documents_type_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_valid" CHECK (type IN ('quote','meeting_summary','letter','nda','mutual_nda','project_status_report'));--> statement-breakpoint
ALTER TABLE "document_templates" DROP CONSTRAINT "document_templates_type_valid";--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_type_valid" CHECK (type IN ('quote','meeting_summary','letter','nda','mutual_nda','project_status_report'));--> statement-breakpoint
-- ============ 2. THREE CONSTRAINTS THAT DELIBERATELY DO NOT CHANGE ==========
--
-- Recorded here rather than left to be noticed, because "the migration for a new
-- type widens the type lists" has been true four times running and is only
-- two-thirds true this time. Each of these is an equality or a list, and each
-- already says the right thing about a report:
--
--   documents_number_matches_type          (number IS NOT NULL) = (type IN ('quote','nda','mutual_nda'))
--       A report has no number, so the row reads false = false. Adding the type
--       to the list would be the OPPOSITE of the decision -- it would REQUIRE a
--       number. See @conduit/shared's documentTypeNumbered for the three reasons,
--       the third of which is the letter's turned inside out.
--   documents_frozen_matches_type          frozen = (type IN ('quote','nda','mutual_nda'))
--       A report is not frozen, so the row reads false = false. Same shape, same
--       reason it needs no edit, and 0016's insistence on an EQUALITY rather than
--       an implication is what makes "not in the list" mean "must be false"
--       rather than "unconstrained".
--   document_number_sequences_type_valid   type IN ('quote','nda','mutual_nda')
--       Untouched, so a writer that called allocateNumber for a report fails on
--       THAT insert rather than minting `DOC-2026-0001` out of
--       formatDocumentNumber's fallback. 0017 called this "a third enforcement
--       that is an ABSENCE"; it is still one.
--
-- ================= 3. WHICH RECORD EACH TYPE ACTUALLY GOES ON ===============
--
-- **THIS IS THE GAP TASK 3 WROTE OUT IN THE PLAN AND LEFT FOR THIS TASK, AND THIS
-- IS THE TASK THAT HAS ALL SIX TYPES.** Task 3's note: "`documents_exactly_one_entity`
-- says exactly one of five. It does not say WHICH one for a given type. Nothing in
-- the database stops a letter carrying a `deal_id` or a quote carrying a
-- `meeting_id`; only the writers do." It declined to add the CHECK because it is a
-- rule about all the types and two of them were not its own -- the same discipline
-- 0016 failed when it generalised a recipient model from the one type that
-- existed. That reason has now expired: the sixth type is here and the fifth
-- foreign key finally has a reader.
--
-- **IT IS NOT SELF-SUFFICIENT AND IT IS NOT MEANT TO BE.** Read alone, the first
-- arm permits a quote that names a deal AND a company. What forbids that is
-- `documents_exactly_one_entity` -- `num_nonnulls(...) = 1` -- which is a CHECK on
-- the same table, added by 0016, and is Chris's decision of 6 Sep. The pair is
-- exact: one says how many, this one says which. Spelling the count into every arm
-- would state the same rule six times and make a future type's author edit two
-- constraints to change one thing.
--
-- **AND THE LETTER FAMILY'S ARM IS NOT THE PLAN'S.** Task 3 sketched it as
-- `num_nonnulls(company_id, contact_id) = 1`. That admits exactly the same rows
-- once the count CHECK is beside it, and it costs the property this schema keeps
-- paying to keep: a letter naming BOTH a company and a contact would violate two
-- constraints at once, so PostgreSQL would report whichever it reached first and
-- `documents_exactly_one_entity` could no longer be probed BY NAME for the case
-- it is most about -- the NDA-at-a-contact-of-a-company shape the spec's third
-- risk is entirely concerned with. `IS NOT NULL OR IS NOT NULL` says "the record
-- is one of these two" and leaves the counting where the counting lives, so every
-- arm here states which column and none of them states how many.
--
-- WHAT STILL OVERLAPS is an UNKNOWN type, and nothing can fix that: it satisfies
-- no arm here and also breaks `documents_type_valid`, so from 0020 those two can
-- only be told apart from the catalogue. db/schema.test.ts reads
-- `pg_get_constraintdef` instead, which is a better assertion than the INSERT it
-- replaces -- it compares the constraint to `documentTypeSchema` directly.
--
-- **EVERY EXISTING ROW SATISFIES IT, WHICH IS WHY IT CAN BE ADDED VALIDATED AND
-- WITHOUT A BACKFILL.** Every document on any install is a quote with a deal_id
-- (0016 proved that with a pre-migration fixture), a summary with a meeting_id, or
-- one of Task 3's three with a company_id or a contact_id -- because those are the
-- only shapes the writers produce. A row that violated this could only have been
-- written by a psql session, and `redraftLetter`'s "attached to neither a company
-- nor a contact" branch exists because Task 3 could reach exactly that state by
-- hand. This CHECK is what makes that branch unreachable from now on; the branch
-- stays, because a guard that can no longer fire is not the same as one that never
-- could.
--
-- **WHAT IT COSTS THE NEXT TYPE'S AUTHOR** is one more constraint to widen, and
-- the widening is a decision they have to make consciously -- which record does
-- this type belong to -- rather than a question the schema never asks. That is the
-- trade, and it is the right way round: the failure this prevents is silent (a
-- document filed against a record nothing displays it on) and the failure it
-- introduces is a refused INSERT with the constraint name in it.
ALTER TABLE "documents" ADD CONSTRAINT "documents_entity_matches_type" CHECK (
     (type = 'quote'                 AND deal_id    IS NOT NULL)
  OR (type = 'meeting_summary'       AND meeting_id IS NOT NULL)
  OR (type = 'project_status_report' AND project_id IS NOT NULL)
  OR (type IN ('letter','nda','mutual_nda')
      AND (company_id IS NOT NULL OR contact_id IS NOT NULL))
);--> statement-breakpoint
-- ==================== 4. THE INDEX 0017 AND 0019 PREDICTED ==================
--
-- 0016 added five record foreign keys to `documents` and built an index on none of
-- them, because nothing read documents by any of them. 0017 built
-- `documents_meeting_idx` for `listMeetingSummaries` and named the rest: "company
-- and contact with the NDA, project with the status report." 0019 built the first
-- two and said of this one: "documents_project_idx stays unbuilt and belongs to
-- Task 4, on the same reasoning -- an index maintained by every INSERT and used by
-- no SELECT is a cost with no reader."
--
-- **THIS IS THAT READER.** `listProjectDocuments` is `WHERE project_id = $1 AND
-- type = 'project_status_report'`, and the project's Documents section runs it on
-- every page load. That completes the set: all five record foreign keys now have
-- an index and each was built by the migration that added its first reader, which
-- is the discipline 0016 started rather than a coincidence.
--
-- NOT COMPOSITE AND NOT PARTIAL, which is the other four's argument repeated
-- unchanged: a project carries single-digit numbers of documents, so the sort is
-- free once the rows are found, and the type filter discriminates nothing while a
-- project can carry only one type. No figures are quoted because none were taken;
-- the column is empty on every deployment in existence.
CREATE INDEX "documents_project_idx" ON "documents" ("project_id");--> statement-breakpoint
-- ======================== 5. THE DEFAULT TEMPLATE ===========================
--
-- Seeded here for 0009's, 0017's and 0019's reason: the feature has to work before
-- anyone has opened Settings, and a type whose template row does not exist answers
-- 409 at issue. The same three things are load-bearing as in all of those: every
-- {{...}} must be a field the type's context builder supplies (an unknown one
-- renders as a silent blank on a printed page); no literal `{{` may appear in the
-- CSS, which is why the nested at-rule is written `{ @` with a space; and
-- class="pre" is white-space: pre-line for the newline-separated fields.
-- db/schema.test.ts checks the first two by reading this row back.
--
-- **THE ONE NEW IDEA IS `{{#tasks}}`, THE THIRD COLLECTION IN THE MERGE
-- LANGUAGE**, after the quote's `lines` and the summary's `attendees`. It is also
-- the first whose items carry a CONDITIONAL of their own: `{{#after}}` inside a
-- task row prints the dependency line only for a task that has predecessors.
-- Blocks resolve against the enclosing scope first (documents-template.ts's
-- `lookup`), so `after` finds the task's own key; `{{/after}}` does not close
-- `{{#tasks}}`, because closers match their own opener by depth.
--
-- **NOTHING HERE IS RAW.** A task title, a project name and an assignee's name are
-- plain text in plain inputs, so a project called `<b>Rye Lane</b>` prints as
-- itself. This type has no rich-text field at all -- the summary's notes and the
-- letter's body are the only two MergeHtml values in Conduit, and both exist
-- because an operator typed markup into a field whose whole purpose was markup.
--
-- **THE EMPTY CASES ARE WRITTEN OUT, ALL FIVE OF THEM**, which is 0009's logo
-- lesson, 0017's attendee lesson and 0019's greeting lesson for the fourth time: a
-- project with no tasks is completely ordinary -- it is what a project looks like
-- on the day it is created -- and so are a project with no dates, no owner and no
-- client. Without the inverted blocks each of those prints a label over nothing.
--
-- THE EMPTY TASK MESSAGE IS A ROW INSIDE THE TABLE AND NOT A `<div>` AFTER IT,
-- which is where 0017 put the summary's ("No attendees were recorded", under an
-- empty `<ul>`). An empty `<ul>` renders as nothing; an empty `<table>` renders as
-- a header row with a rule under it and a sentence stranded below, which reads as
-- a table that failed to load. `colspan` is in the document profile's allowlist
-- for `td`, so the row survives the sanitiser -- checked rather than assumed.
--
-- **THE TASK TABLE HAS SIX COLUMNS AND NOT SEVEN**, and the seventh was the task's
-- TYPE ('task', 'call', 'meeting', 'email', 'deadline'). Left out deliberately: A4
-- portrait at these margins is 178mm of usable width, the six columns here already
-- fill it, and a status question is answered by status, schedule and owner rather
-- than by whether a piece of work is a phone call. The dependency line under the
-- title is where the width went instead, because that is the Gantt state -- the
-- thing this type exists to print that a task list does not have.
--
-- **NO PERCENTAGE OF THE PROJECT IS PRINTED, AND THE COUNTS ARE NOT A HINT AT
-- ONE.** "12 of 20 tasks done" is a fact; "60% complete" is a claim, and it is
-- false whenever the twenty tasks are not the same size -- which is always. The
-- per-task `progressPct` an operator typed IS printed, because that one is
-- somebody's own estimate of their own task rather than arithmetic this document
-- invented.
INSERT INTO "document_templates" ("type", "body_html") VALUES ('project_status_report', '<style>
@page { size: A4; margin: 18mm 14mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 9.5pt; line-height: 1.35; color: #111; }
h1 { font-size: 17pt; margin: 5mm 0 1mm; }
h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.4pt; color: #666; margin: 7mm 0 2mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 3mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
table.meta td { padding: 0 6mm 1mm 0; vertical-align: top; }
table.counts { border-collapse: collapse; margin-top: 1mm; }
table.counts td { padding: 1mm 6mm 1mm 0; vertical-align: bottom; }
table.counts .n { font-size: 15pt; }
table.tasks { border-collapse: collapse; width: 100%; margin-top: 1mm; }
table.tasks th { text-align: left; font-size: 8pt; text-transform: uppercase; color: #666; border-bottom: 0.6pt solid #999; padding: 0 3mm 1mm 0; }
table.tasks td { padding: 1.2mm 3mm 1.2mm 0; border-bottom: 0.3pt solid #ddd; vertical-align: top; }
table.tasks td.num { text-align: right; padding-right: 4mm; white-space: nowrap; }
table.tasks td.when { white-space: nowrap; }
.after { font-size: 8pt; color: #666; }
</style>
<div>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt="" /></div>{{/org.logoDataUri}}
<div><strong>{{org.name}}</strong></div>
{{#org.addressLines}}<div class="pre">{{org.addressLines}}</div>{{/org.addressLines}}
{{#org.email}}<div>{{org.email}}</div>{{/org.email}}
{{#org.phone}}<div>{{org.phone}}</div>{{/org.phone}}
{{#org.website}}<div>{{org.website}}</div>{{/org.website}}
</div>
<h1>{{document.projectName}}</h1>
<div class="muted">Project status report</div>
<table class="meta">
<tr><td class="label">Status</td><td>{{document.projectStatus}}</td></tr>
{{#document.company}}<tr><td class="label">Client</td><td>{{document.company}}</td></tr>{{/document.company}}
{{#document.owner}}<tr><td class="label">Owner</td><td>{{document.owner}}</td></tr>{{/document.owner}}
{{#document.startDate}}<tr><td class="label">Starts</td><td>{{document.startDate}}</td></tr>{{/document.startDate}}
{{#document.dueDate}}<tr><td class="label">Due</td><td>{{document.dueDate}}</td></tr>{{/document.dueDate}}
<tr><td class="label">Reported</td><td>{{document.issueDate}}</td></tr>
</table>
<h2>Where the work is</h2>
<table class="counts">
<tr>
<td class="n">{{document.taskCount}}</td><td class="n">{{document.doneCount}}</td><td class="n">{{document.inProgressCount}}</td><td class="n">{{document.blockedCount}}</td><td class="n">{{document.todoCount}}</td><td class="n">{{document.overdueCount}}</td><td class="n">{{document.undatedCount}}</td>
</tr>
<tr>
<td class="label">Tasks</td><td class="label">Done</td><td class="label">In progress</td><td class="label">Blocked</td><td class="label">To do</td><td class="label">Overdue</td><td class="label">Undated</td>
</tr>
</table>
<h2>Tasks</h2>
<table class="tasks">
<tr><th>Task</th><th>Status</th><th>Start</th><th>Due</th><th>Progress</th><th>Assignee</th></tr>
{{#tasks}}<tr>
<td>{{title}}{{#after}}<div class="after">After {{after}}</div>{{/after}}</td>
<td>{{status}}</td>
<td class="when">{{startDate}}</td>
<td class="when">{{dueDate}}</td>
<td class="num">{{progress}}</td>
<td>{{assignee}}</td>
</tr>{{/tasks}}
{{^tasks}}<tr><td colspan="6" class="muted">This project has no tasks.</td></tr>{{/tasks}}
</table>');
