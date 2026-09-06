-- THE LETTER, THE NDA PAIR, AND THE GUARD THAT READS `frozen`.
--
-- Phase 9 Task 3. Three types arrive at once because they share a shape the
-- first two did not have: a document attached to a COMPANY or a CONTACT, with a
-- form. And one thing arrives that is not a type at all and is the reason this
-- migration is the interesting one in the phase --
-- `conduit_document_frozen_guard`, section 5.
--
-- **UNTIL NOW "AN ISSUED DOCUMENT NEVER CHANGES" HAS BEEN UNCONDITIONAL.** Phase
-- 7 built no update path; Task 1 added `documents.frozen` and recorded that
-- nothing read it; Task 2 added the first type that answers `false` and still
-- wrote no update path, because "an edit-in-place path here would be the one
-- place in the codebase that mutated an issued document with no guard anywhere".
-- The letter is the type that needs one -- Chris, 6 Sep: "a letter wants
-- redrafting before it goes" -- so this migration is where the rule becomes
-- conditional, and section 5 is where a mistake would let a QUOTE be edited.
--
-- IT MOVES NO ROWS. Like 0017 and 0018 and unlike 0016, every statement here is
-- a catalogue change, a CREATE, or an INSERT of a template row. The three
-- widened CHECKs validate `documents`, `document_templates` and
-- `document_number_sequences` under ACCESS EXCLUSIVE, which on tables holding
-- tens of rows is three sequential scans; 0013's header has the general argument
-- about migrations running before the server listens and it applies unchanged.
--
-- THE ROLLBACK COST. Every object here is new, so rolling the CODE back to
-- v1.8.0-with-two-types leaves a database it can read: it never selects
-- `document_letters` or `document_agreements`, and the widened CHECKs admit
-- strictly more than the narrow ones did. What such a build cannot do is show a
-- letter or an agreement -- those documents become invisible rather than corrupt.
-- Reverting the SCHEMA is the irreversible half, exactly as it was for 0017: the
-- narrow `documents_type_valid` cannot be restored while a letter row exists.
-- That is a restore, and it is the same restore 0016 already made the answer to
-- any rollback of this phase.
--
-- GENERATED AND THEN REWRITTEN, WHICH IS NOW FOUR TIMES OUT OF FOUR. What
-- `drizzle-kit generate` produced was correct SQL this time -- both CREATE
-- TABLEs, the four foreign keys and the five CHECK swaps are its work and are
-- kept -- but it knows nothing about the trigger, the two indexes or the three
-- template rows, and **it stamped the journal `when` as 1788691029541, which
-- falls between 0013's 1788600000000 and 0014's 1788700000000.** drizzle applies
-- a migration only when the newest applied row's created_at is BELOW it, so 0019
-- would have been skipped, silently and without error, on every install that
-- already has 0014. Identical to 0016's, 0017's and 0018's. Hand-set to
-- 1789200000000; schema.test.ts pins the whole journal as strictly increasing.
--
-- ============================ 1. THE THREE TYPES ============================
--
-- Dropped and re-added by name rather than altered, because PostgreSQL has no
-- ALTER CONSTRAINT for a CHECK, and named explicitly for 0015's reason: a
-- constraint name in a migration is a claim about what an earlier migration
-- really created, so a name that has drifted fails loudly here.
ALTER TABLE "documents" DROP CONSTRAINT "documents_type_valid";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_valid" CHECK (type IN ('quote','meeting_summary','letter','nda','mutual_nda'));--> statement-breakpoint
ALTER TABLE "document_templates" DROP CONSTRAINT "document_templates_type_valid";--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_type_valid" CHECK (type IN ('quote','meeting_summary','letter','nda','mutual_nda'));--> statement-breakpoint
-- ========================= 2. WHICH OF THEM ARE NUMBERED ====================
--
-- **TWO OF THE THREE ARE, AND THE THIRD DELIBERATELY IS NOT.** @conduit/shared's
-- documentTypeNumbered carries the argument in full; the short version is that an
-- agreement is exactly the document a number was invented for -- somebody else's
-- legal team holds the reference, the per-year sequence is an audit somebody
-- asks for, and the pathology that rules a number out for the summary cannot
-- arise because an agreement is frozen -- while a letter's reference is the
-- operator's own `Our ref:`, and a number that named different content after a
-- redraft would deny the one property a document number has.
--
-- THE UNIQUE CONSTRAINT STILL NEEDS NO CHANGE, and this is the second migration
-- to say so. `documents_number_unique` is global; QUO, NDA and MNDA share no
-- prefix, so two formatted numbers cannot collide, and every unnumbered letter is
-- unique from every other one for free because PostgreSQL treats NULLs in a
-- UNIQUE constraint as distinct.
ALTER TABLE "documents" DROP CONSTRAINT "documents_number_matches_type";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_number_matches_type" CHECK ((number IS NOT NULL) = (type IN ('quote','nda','mutual_nda')));--> statement-breakpoint
-- THE THIRD ENFORCEMENT WIDENS BY TWO AND NOT BY THREE, which is what keeps it a
-- different list from documents_type_valid rather than the same list written
-- twice. 0017 made this "the list of types that are NUMBERED"; a writer that
-- called allocateNumber for a LETTER still fails on this INSERT rather than
-- starting a private `DOC-2026-` series out of formatDocumentNumber's fallback.
ALTER TABLE "document_number_sequences" DROP CONSTRAINT "document_number_sequences_type_valid";--> statement-breakpoint
ALTER TABLE "document_number_sequences" ADD CONSTRAINT "document_number_sequences_type_valid" CHECK (type IN ('quote','nda','mutual_nda'));--> statement-breakpoint
-- ========================= 3. WHICH OF THEM FREEZE ==========================
--
-- **THE FIRST TIME THIS LIST HAS EVER WIDENED.** 0016 wrote it as an equality and
-- 0017's comment explained why that was not pedantry: an implication
-- (`type IN ('quote') -> frozen`) would have admitted a frozen meeting summary in
-- silence. The equality now earns its keep in both directions at once -- it
-- refuses an unfrozen NDA AND a frozen letter, and with five types and three
-- values on the TRUE side neither mistake is hypothetical.
ALTER TABLE "documents" DROP CONSTRAINT "documents_frozen_matches_type";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_frozen_matches_type" CHECK (frozen = (type IN ('quote','nda','mutual_nda')));--> statement-breakpoint
-- ======================== 4. THE TWO DETAIL TABLES ==========================
--
-- db/schema.ts carries the argument for both, including the one this task was
-- asked to settle and answered NO to: whether it is time for a common
-- `document_parties`. (In short: it would be a second migration over Chris's live
-- quote rows in one release for a refactor rather than a feature; the four
-- columns do not agree, because an agreement has no salutation; and "recipient"
-- is the quote's noun while an agreement has parties.)
--
-- THE COMPOSITE (document_id, type) FOREIGN KEY IS ON BOTH, from the start rather
-- than a migration later. 0016 deferred `document_quotes`' because a second type
-- did not exist and the constraint could not have been tested as more than
-- structure; here there are four other types the moment these tables appear, so
-- the key catches something on the day it is written. What it catches: without
-- it, `INSERT INTO document_agreements` naming a LETTER succeeds, and the row is
-- not inert, because every read of an agreement joins on document_id -- the
-- letter would come back as an NDA with a term and a jurisdiction from code that
-- never asked what it was.
--
-- `document_agreements.type` IS THE FIRST OF THESE COLUMNS THAT IS NOT A
-- CONSTANT. `document_quotes.type` and `document_letters.type` are pinned to one
-- value with a DEFAULT, so no writer mentions them; this one is pinned to a SET
-- of two and the writer supplies it, because the writer is the only thing that
-- knows whether this agreement is mutual. It still cannot disagree with the
-- document it describes -- that is what the composite key is for.
CREATE TABLE "document_letters" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'letter' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_contact_name" text DEFAULT '' NOT NULL,
	"recipient_salutation" text DEFAULT '' NOT NULL,
	"recipient_address" text DEFAULT '' NOT NULL,
	"body_html" text NOT NULL,
	CONSTRAINT "document_letters_type_is_letter" CHECK (type = 'letter')
);
--> statement-breakpoint
CREATE TABLE "document_agreements" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"effective_date" date NOT NULL,
	"term_months" integer NOT NULL,
	"jurisdiction" text NOT NULL,
	"party_name" text NOT NULL,
	"party_contact_name" text DEFAULT '' NOT NULL,
	"party_address" text DEFAULT '' NOT NULL,
	CONSTRAINT "document_agreements_type_valid" CHECK (type IN ('nda','mutual_nda')),
	CONSTRAINT "document_agreements_term_range" CHECK (term_months BETWEEN 1 AND 1200),
	CONSTRAINT "document_agreements_stated" CHECK (party_name <> '' AND jurisdiction <> '')
);
--> statement-breakpoint
ALTER TABLE "document_letters" ADD CONSTRAINT "document_letters_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_letters" ADD CONSTRAINT "document_letters_document_id_type_fk" FOREIGN KEY ("document_id","type") REFERENCES "public"."documents"("id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agreements" ADD CONSTRAINT "document_agreements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agreements" ADD CONSTRAINT "document_agreements_document_id_type_fk" FOREIGN KEY ("document_id","type") REFERENCES "public"."documents"("id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ==================== 5. THE GUARD THAT READS `frozen` ======================
--
-- **THIS IS THE SHARP EDGE OF THE WHOLE PHASE, AND IT IS SIX LINES OF PLPGSQL.**
--
-- The spec's fourth risk: "Per-type freezing is a new axis in a guard that
-- currently has none. The rule that an issued document never changes is currently
-- unconditional; making it conditional is where a mistake would let a quote be
-- edited." A quote is the one document in this product that carries a price
-- somebody was sent.
--
-- WHY A TRIGGER, WHEN EVERY OTHER RULE IN THIS SCHEMA IS A CHECK. A CHECK sees
-- only the row being written. This rule is about the row that is ALREADY THERE:
-- `frozen` does not say "this value must be legal", it says "this row may not
-- change", and OLD is a thing only a trigger has. There is no spelling of it as a
-- CHECK, and the closest available -- putting `AND frozen = false` in every
-- UPDATE -- is a guard that can be written wrong once per call site, which is
-- what db/schema.ts's `frozen` comment warned against when the column was added.
--
-- WHAT IT IS **NOT** FOR. In normal operation it never fires. `redraftLetter`
-- refuses first, and it refuses in the only way that has no window between the
-- test and the write: `UPDATE ... WHERE id = $1 AND frozen = false` is ONE
-- statement, and zero rows affected IS the refusal. This trigger is what makes
-- the rule true for everything that is not that function -- a psql session, an
-- import, a restore-then-fix, and above all a call site nobody has written yet.
-- Task 4 adds a type to this table; whatever it writes, a quote stays immutable
-- without Task 4 having to remember anything.
--
-- IT COSTS NOTHING ON THE PATHS ANYBODY USES. `documents`' trigger carries
-- `WHEN (OLD.frozen)`, so for the unfrozen types the body never runs; and no
-- table it guards has ever been the target of an UPDATE or a DELETE in this
-- codebase (verified across packages/ and e2e/ before it was written: there is
-- not one). TRUNCATE does not fire row-level triggers, so the test suite's
-- truncateAll is untouched, and `restore` loads a dump through psql after
-- dropping the schema, so the trigger travels with the dump exactly as 0013's
-- `conduit_lower_emails` does and never stands in the way of a load.
--
-- WHY THE DETAIL TABLES TOO, AND NOT ONLY `documents`. A quote's PRICE is in
-- `document_quotes` and its lines are in `document_line_items`. A guard that
-- covered only the parent would leave "the total on an issued quote" editable,
-- which is the exact failure this exists to prevent -- the parent row would be
-- untouched and the page would be a lie. Their triggers cannot use a WHEN clause
-- (a WHEN expression may not contain a subquery), so they look the parent up;
-- that is one primary-key lookup on tables nothing updates.
--
-- ERRCODE 23514 AND THE CONSTRAINT NAME IN THE MESSAGE, so this refusal reads
-- exactly like every other integrity rule in this schema -- which is what it is,
-- expressed as a trigger only because a CHECK cannot see OLD. db/schema.test.ts
-- matches it the same way it matches documents_frozen_matches_type.
--
-- DELIBERATELY NOT `CREATE OR REPLACE`, which is 0013's measured lesson: a
-- migration applied over objects that already exist means the bookkeeping and the
-- schema disagree, and that has to be an error rather than a shrug.
CREATE FUNCTION conduit_document_frozen_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'documents_frozen_is_immutable: % on document % is refused, because it is a frozen %',
		TG_OP, OLD.id, OLD.type
		USING ERRCODE = '23514', CONSTRAINT = 'documents_frozen_is_immutable';
END $$;
--> statement-breakpoint
CREATE FUNCTION conduit_document_detail_frozen_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
DECLARE
	owner_frozen boolean;
	owner_type text;
BEGIN
	SELECT d.frozen, d.type INTO owner_frozen, owner_type
		FROM documents d WHERE d.id = OLD.document_id;
	IF owner_frozen THEN
		RAISE EXCEPTION 'documents_frozen_is_immutable: % on the % of document % is refused, because that document is a frozen %',
			TG_OP, TG_TABLE_NAME, OLD.document_id, owner_type
			USING ERRCODE = '23514', CONSTRAINT = 'documents_frozen_is_immutable';
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_frozen_immutable
	BEFORE UPDATE OR DELETE ON "documents"
	FOR EACH ROW WHEN (OLD.frozen)
	EXECUTE FUNCTION conduit_document_frozen_guard();
--> statement-breakpoint
CREATE TRIGGER document_quotes_frozen_immutable
	BEFORE UPDATE OR DELETE ON "document_quotes"
	FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard();
--> statement-breakpoint
CREATE TRIGGER document_line_items_frozen_immutable
	BEFORE UPDATE OR DELETE ON "document_line_items"
	FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard();
--> statement-breakpoint
CREATE TRIGGER document_letters_frozen_immutable
	BEFORE UPDATE OR DELETE ON "document_letters"
	FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard();
--> statement-breakpoint
CREATE TRIGGER document_agreements_frozen_immutable
	BEFORE UPDATE OR DELETE ON "document_agreements"
	FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard();
--> statement-breakpoint
-- ==================== 6. THE TWO INDEXES 0017 PREDICTED =====================
--
-- 0016 added five record foreign keys to `documents` and built an index on none
-- of them, on the grounds that nothing read documents by any of them. 0017 built
-- `documents_meeting_idx` because `listMeetingSummaries` was the read that
-- changed that, and named the other two: "company and contact with the NDA,
-- project with the status report."
--
-- This is the NDA, and the letter arrived with it, so both reads exist now:
-- `listRecordDocuments` is `WHERE company_id = $1` or `WHERE contact_id = $1`.
-- `documents_project_idx` stays unbuilt and belongs to Task 4, on the same
-- reasoning -- an index maintained by every INSERT and used by no SELECT is a
-- cost with no reader.
--
-- NOT COMPOSITE AND NOT PARTIAL, which is documents_deal_idx's and
-- documents_meeting_idx's argument repeated unchanged: a company carries
-- single-digit numbers of documents, so the sort is free once the rows are found.
-- No figures are quoted because none were taken; both columns are empty on every
-- deployment in existence.
CREATE INDEX "documents_company_idx" ON "documents" ("company_id");--> statement-breakpoint
CREATE INDEX "documents_contact_idx" ON "documents" ("contact_id");--> statement-breakpoint
-- ======================= 7. THE THREE DEFAULT TEMPLATES =====================
--
-- Seeded here for 0009's and 0017's reason: the feature has to work before anyone
-- has opened Settings, and a type whose template row does not exist answers 409
-- at issue. The same three things are load-bearing as in both of those: every
-- {{...}} must be a field the type's context builder supplies (an unknown one
-- renders as a silent blank on a printed page); no literal `{{` may appear in the
-- CSS, which is why the nested at-rule is written `{ @` with a space; and
-- class="pre" is white-space: pre-line for the newline-separated fields.
-- db/schema.test.ts checks the first two by reading these rows back.
--
-- THE LETTER'S ONE NEW IDEA is {{document.body}}, the second raw-HTML merge value
-- in Conduit after the summary's notes. It is TipTap markup the operator typed,
-- so it arrives as a MergeHtml and is emitted unescaped, then sanitised with the
-- rest of the page. A template CANNOT ask for that -- the context decides, in
-- code -- so {{document.subject}} beside it is still escaped text.
--
-- THE GREETING IS WRITTEN IN BOTH BLOCK FORMS, and that is 0009's logo lesson
-- and 0017's attendee lesson for the third time: a letter to a company with no
-- named contact is completely ordinary, and "Dear ," is what you get if the
-- conditional is left out. The fallback wording is deliberately the dullest
-- available, because it is the one an operator will most often want to change
-- and it should be obvious that it is theirs to change.
--
-- THE TWO AGREEMENTS ARE A STARTING POINT AND THE PRODUCT SAYS SO IN SETTINGS,
-- not on the page. A note printed INSIDE an NDA telling the reader it has not
-- been reviewed would be worse than useless -- it goes to the counterparty. The
-- warning belongs where the person who can act on it is standing, which is the
-- template editor, and pages/settings-templates.tsx carries it.
--
-- WHAT SEPARATES THE TWO AGREEMENT TEMPLATES IS ENTIRELY WORDING, which is the
-- whole reason they share one detail table: clause 3 of the NDA obliges the
-- Recipient, and clause 3 of the mutual one obliges each party in respect of the
-- other. Everything structural -- parties, purpose, exclusions, term, governing
-- law, signature blocks -- is the same document.
INSERT INTO "document_templates" ("type", "body_html") VALUES ('letter', '<style>
@page { size: A4; margin: 20mm 18mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.5; color: #111; }
h1 { font-size: 13pt; margin: 8mm 0 4mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 4mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.head { display: flex; justify-content: space-between; gap: 10mm; }
.to { margin-top: 10mm; }
.date { margin-top: 6mm; }
.body p { margin: 0 0 3mm; }
.sign { margin-top: 12mm; }
</style>
<div class="head">
<div>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt="" /></div>{{/org.logoDataUri}}
<div><strong>{{org.name}}</strong></div>
{{#org.addressLines}}<div class="pre">{{org.addressLines}}</div>{{/org.addressLines}}
</div>
<div class="muted">
{{#org.email}}<div>{{org.email}}</div>{{/org.email}}
{{#org.phone}}<div>{{org.phone}}</div>{{/org.phone}}
{{#org.website}}<div>{{org.website}}</div>{{/org.website}}
</div>
</div>
<div class="to">
<div>{{document.recipientName}}</div>
{{#document.recipientContactName}}<div>{{document.recipientContactName}}</div>{{/document.recipientContactName}}
{{#document.recipientAddress}}<div class="pre">{{document.recipientAddress}}</div>{{/document.recipientAddress}}
</div>
<div class="date">{{document.issueDate}}</div>
{{#document.subject}}<h1>{{document.subject}}</h1>{{/document.subject}}
{{#document.recipientSalutation}}<p>Dear {{document.recipientSalutation}},</p>{{/document.recipientSalutation}}
{{^document.recipientSalutation}}<p>Dear Sir or Madam,</p>{{/document.recipientSalutation}}
<div class="body">{{document.body}}</div>
<div class="sign">
<p>Yours sincerely,</p>
<p>{{org.name}}</p>
</div>');--> statement-breakpoint
INSERT INTO "document_templates" ("type", "body_html") VALUES ('nda', '<style>
@page { size: A4; margin: 18mm 16mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10pt; line-height: 1.45; color: #111; }
h1 { font-size: 15pt; margin: 6mm 0 1mm; }
h2 { font-size: 10pt; margin: 5mm 0 1mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 3mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
table.meta { margin: 4mm 0 6mm; }
table.meta td { padding: 0 6mm 1mm 0; vertical-align: top; }
table.sign { width: 100%; margin-top: 14mm; }
table.sign td { width: 50%; padding-right: 8mm; vertical-align: top; }
.rule { border-top: 1px solid #111; margin-top: 14mm; padding-top: 1mm; font-size: 8.5pt; color: #666; }
</style>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt="" /></div>{{/org.logoDataUri}}
<h1>Non-disclosure agreement</h1>
<div class="muted">{{document.number}}</div>
<table class="meta">
<tr><td class="label">Effective date</td><td>{{document.effectiveDate}}</td></tr>
<tr><td class="label">Term</td><td>{{document.term}}</td></tr>
<tr><td class="label">Governing law</td><td>{{document.jurisdiction}}</td></tr>
<tr><td class="label">Issued</td><td>{{document.issueDate}}</td></tr>
</table>
<h2>1. Parties</h2>
<p>This agreement is made between <strong>{{org.name}}</strong>{{#org.addressLines}}, of <span class="pre">{{org.addressLines}}</span>{{/org.addressLines}} (the Discloser), and <strong>{{document.partyName}}</strong>{{#document.partyAddress}}, of <span class="pre">{{document.partyAddress}}</span>{{/document.partyAddress}} (the Recipient).</p>
{{#document.partyContactName}}<p>The Recipient acts through {{document.partyContactName}}.</p>{{/document.partyContactName}}
<h2>2. Confidential information</h2>
<p>Confidential information means any information the Discloser makes available to the Recipient in connection with their dealings, in any form, whether or not it is marked as confidential.</p>
<h2>3. Obligations of the Recipient</h2>
<p>The Recipient will keep the confidential information secret, will use it only for the purpose for which it was disclosed, and will not pass it to anyone else except to those of its people who need it for that purpose and who are under obligations no less protective than these.</p>
<h2>4. Exclusions</h2>
<p>These obligations do not apply to information that is already public through no fault of the Recipient, that the Recipient already held without an obligation of confidence, that the Recipient develops independently, or that the Recipient is required by law or by a court to disclose.</p>
<h2>5. Term</h2>
<p>This agreement takes effect on {{document.effectiveDate}} and the obligations in it last for {{document.term}} from that date.</p>
<h2>6. Governing law</h2>
<p>This agreement is governed by the law of {{document.jurisdiction}}, and the courts of {{document.jurisdiction}} have exclusive jurisdiction over any dispute arising out of it.</p>
<table class="sign">
<tr>
<td><div class="rule">{{org.name}}</div></td>
<td><div class="rule">{{document.partyName}}</div></td>
</tr>
</table>');--> statement-breakpoint
INSERT INTO "document_templates" ("type", "body_html") VALUES ('mutual_nda', '<style>
@page { size: A4; margin: 18mm 16mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10pt; line-height: 1.45; color: #111; }
h1 { font-size: 15pt; margin: 6mm 0 1mm; }
h2 { font-size: 10pt; margin: 5mm 0 1mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 3mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
table.meta { margin: 4mm 0 6mm; }
table.meta td { padding: 0 6mm 1mm 0; vertical-align: top; }
table.sign { width: 100%; margin-top: 14mm; }
table.sign td { width: 50%; padding-right: 8mm; vertical-align: top; }
.rule { border-top: 1px solid #111; margin-top: 14mm; padding-top: 1mm; font-size: 8.5pt; color: #666; }
</style>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt="" /></div>{{/org.logoDataUri}}
<h1>Mutual non-disclosure agreement</h1>
<div class="muted">{{document.number}}</div>
<table class="meta">
<tr><td class="label">Effective date</td><td>{{document.effectiveDate}}</td></tr>
<tr><td class="label">Term</td><td>{{document.term}}</td></tr>
<tr><td class="label">Governing law</td><td>{{document.jurisdiction}}</td></tr>
<tr><td class="label">Issued</td><td>{{document.issueDate}}</td></tr>
</table>
<h2>1. Parties</h2>
<p>This agreement is made between <strong>{{org.name}}</strong>{{#org.addressLines}}, of <span class="pre">{{org.addressLines}}</span>{{/org.addressLines}}, and <strong>{{document.partyName}}</strong>{{#document.partyAddress}}, of <span class="pre">{{document.partyAddress}}</span>{{/document.partyAddress}}. Each of them is referred to below as a party, and each may be both a discloser and a recipient of confidential information.</p>
{{#document.partyContactName}}<p>{{document.partyName}} acts through {{document.partyContactName}}.</p>{{/document.partyContactName}}
<h2>2. Confidential information</h2>
<p>Confidential information means any information one party makes available to the other in connection with their dealings, in any form, whether or not it is marked as confidential.</p>
<h2>3. Obligations of each party</h2>
<p>Each party will keep the other party''s confidential information secret, will use it only for the purpose for which it was disclosed, and will not pass it to anyone else except to those of its people who need it for that purpose and who are under obligations no less protective than these. These obligations bind each party in respect of the other, on the same terms.</p>
<h2>4. Exclusions</h2>
<p>These obligations do not apply to information that is already public through no fault of the receiving party, that the receiving party already held without an obligation of confidence, that it develops independently, or that it is required by law or by a court to disclose.</p>
<h2>5. Term</h2>
<p>This agreement takes effect on {{document.effectiveDate}} and the obligations in it last for {{document.term}} from that date.</p>
<h2>6. Governing law</h2>
<p>This agreement is governed by the law of {{document.jurisdiction}}, and the courts of {{document.jurisdiction}} have exclusive jurisdiction over any dispute arising out of it.</p>
<table class="sign">
<tr>
<td><div class="rule">{{org.name}}</div></td>
<td><div class="rule">{{document.partyName}}</div></td>
</tr>
</table>');
