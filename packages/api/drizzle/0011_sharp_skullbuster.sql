ALTER TABLE "contacts" ADD COLUMN "salutation" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "pronouns" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "recipient_salutation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_salutation_length" CHECK (char_length(salutation) <= 64);--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_pronouns_length" CHECK (char_length(pronouns) <= 64);--> statement-breakpoint
-- THE SEEDED QUOTE TEMPLATE LEARNS TO PRINT THE SALUTATION.
--
-- The column above is only worth having if a quote says "Dr Jane Smith" where it
-- used to say "Jane Smith", so the default template is amended here. 0009 seeded
-- it; that migration has shipped and is never edited, so the change arrives as an
-- UPDATE, the way any other post-release change to seeded data would.
--
-- HAND-WRITTEN, AND IT DOES NOT SURVIVE A REGENERATE. Everything above this line is
-- drizzle-kit's output; re-running `db:generate` for this migration rewrites the
-- file and drops this block, exactly as it would drop 0009's index and its seed. Put
-- it back, and re-read the whole file, before running the tests.
--
-- IT IS A `replace`, NOT AN OVERWRITE, AND THE GUARD IS THE POINT. Settings ->
-- Templates lets the operator edit this body, and a migration that assigned a fresh
-- one would silently destroy a letterhead somebody had spent an afternoon on, with no
-- undo anywhere in the product. Rewriting exactly the recipient line means a
-- customised template keeps every customisation and still gains the salutation -- and
-- an install whose recipient line was itself edited matches nothing, so the WHERE
-- leaves that row, and its updated_at, completely untouched. The new field is
-- documented on the Settings page for exactly that case.
--
-- THE SALUTATION HANGS OFF THE CONTACT NAME rather than standing on its own line,
-- which is a judgement worth recording: it qualifies a person's name, and "Dr" alone
-- above a company address is not a line of an address block. An install that clears
-- the contact name on the quote form but keeps a salutation therefore prints neither,
-- while the row still stores both -- deliberate, and the reason the form defaults the
-- two together.
--
-- AND IT MUST NOT MAKE A TEMPLATE UNSAVEABLE, which is the 16384 below. The rewrite
-- GROWS the body by 99 bytes per occurrence, and saveDocumentTemplate refuses a body
-- over MAX_TEMPLATE_BYTES (16 * 1024) -- so a template sitting within 99 bytes of
-- that cap would come out the other side of this migration unsaveable, including a
-- PUT of the byte-identical body a GET had just returned, which is the round-trip
-- invariant shared/src/index.ts writes down. The symptom would be "I can no longer
-- save my own letterhead" with nothing pointing at an upgrade weeks earlier. Such a
-- template is left alone instead, exactly like a customised recipient line.
--
-- octet_length is Buffer.byteLength's counterpart, which is what that check measures,
-- and what the column holds is already the sanitised form saveDocumentTemplate
-- measured -- so the two are comparing the same bytes.
--
-- The subquery form is what lets the amended body be measured before it is stored;
-- `amended <> body_html` also replaces a `position(...) > 0` guard, and is exact when
-- the recipient line appears more than once.
--
-- No `;` and no `'` inside either literal, so nothing here can be mistaken for a
-- statement end or needs doubling. Both strings are read back out of this file by
-- test/seed-template.ts, which is how documents.test.ts and documents-seed.test.ts
-- see the template a fresh install actually has.
UPDATE "document_templates" AS t
SET "body_html" = amendment.amended,
    "updated_at" = now()
FROM (
  SELECT
    "id",
    replace(
      "body_html",
      '{{#document.recipientContactName}}<div>{{document.recipientContactName}}</div>{{/document.recipientContactName}}',
      '{{#document.recipientContactName}}<div>{{#document.recipientSalutation}}{{document.recipientSalutation}} {{/document.recipientSalutation}}{{document.recipientContactName}}</div>{{/document.recipientContactName}}'
    ) AS amended
  FROM "document_templates"
  WHERE "type" = 'quote'
) AS amendment
WHERE t."id" = amendment."id"
  AND amendment.amended <> t."body_html"
  AND octet_length(amendment.amended) <= 16384;