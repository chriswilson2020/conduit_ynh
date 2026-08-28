CREATE TABLE "document_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"qty_milli" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"line_total_cents" bigint NOT NULL,
	CONSTRAINT "document_line_items_document_position_unique" UNIQUE("document_id","position"),
	CONSTRAINT "document_line_items_qty_nonneg" CHECK (qty_milli >= 0),
	CONSTRAINT "document_line_items_price_nonneg" CHECK (unit_price_cents >= 0),
	CONSTRAINT "document_line_items_tax_range" CHECK (tax_rate_bp BETWEEN 0 AND 10000),
	CONSTRAINT "document_line_items_amounts_representable" CHECK (unit_price_cents <= 9007199254740991 AND line_total_cents BETWEEN -9007199254740991 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "document_number_sequences" (
	"type" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_number_sequences_type_year_pk" PRIMARY KEY("type","year"),
	CONSTRAINT "document_number_sequences_type_valid" CHECK (type IN ('quote'))
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"body_html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_type_unique" UNIQUE("type"),
	CONSTRAINT "document_templates_type_valid" CHECK (type IN ('quote'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"deal_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"issue_date" date NOT NULL,
	"valid_until_date" date,
	"recipient_name" text NOT NULL,
	"recipient_contact_name" text DEFAULT '' NOT NULL,
	"recipient_address" text DEFAULT '' NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_number_unique" UNIQUE("number"),
	CONSTRAINT "documents_type_valid" CHECK (type IN ('quote')),
	CONSTRAINT "documents_currency_format" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "documents_totals_consistent" CHECK (total_cents = subtotal_cents + tax_cents),
	CONSTRAINT "documents_totals_representable" CHECK (subtotal_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND tax_cents BETWEEN -9007199254740991 AND 9007199254740991
        AND total_cents BETWEEN -9007199254740991 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "org_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"address_lines" text DEFAULT '' NOT NULL,
	"vat_number" text DEFAULT '' NOT NULL,
	"registration_number" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"bank_details" text DEFAULT '' NOT NULL,
	"logo_file_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_profile_singleton" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "document_line_items" ADD CONSTRAINT "document_line_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_logo_file_id_files_id_fk" FOREIGN KEY ("logo_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- THE ONE HAND-WRITTEN INDEX THIS MIGRATION NEEDS, kept here rather than in
-- schema.ts for the reason the mail block records (0004's header, and 0008's
-- four attendee indexes): drizzle's index() builder is used by no table in
-- this codebase, and a migration's non-generatable SQL lives together.
--
-- "the documents on this deal" is the only unindexed read this phase adds.
-- Every other one is already served: documents(number) and
-- document_templates(type) by their UNIQUE constraints,
-- document_line_items(document_id, position) likewise -- document_id leads,
-- so it answers the FK lookup and the ORDER BY together -- and
-- document_number_sequences by its composite primary key.
--
-- NOT (deal_id, created_at) and not partial: a deal carries single-digit
-- numbers of documents, so the sort is free once the rows are found, and a
-- composite would be a wider index bought for nothing measurable. No figures
-- are quoted here because none were taken; the table is empty on every
-- deployment in existence.
CREATE INDEX "documents_deal_idx" ON "documents" ("deal_id");--> statement-breakpoint
-- THE DEFAULT QUOTE TEMPLATE, seeded so the feature works before anyone has
-- opened Settings (spec: "seeded with a working default in the migration").
--
-- Written across many lines on purpose. Postgres string literals may contain
-- newlines, drizzle's migrator splits this file only on the
-- statement-breakpoint marker above, and the alternative -- one 1.5KB line --
-- is a template nobody can review or diff. The newlines are inside the
-- stored HTML, where they are whitespace.
--
-- THREE THINGS IN HERE ARE LOAD-BEARING AND EASY TO BREAK ON EDIT:
--
-- 1. Every {{...}} must be a field the merge resolver knows: org.*,
--    document.*, or -- only inside {{#lines}}...{{/lines}} -- description,
--    qty, unitPrice, taxRate, lineTotal. An unknown field renders as empty
--    rather than throwing, so a typo here is a silent blank on a page, not a
--    failure anyone would notice. schema.test.ts's "documents schema (0009)"
--    block reads this row back and checks every token against that list.
--
-- 2. No literal {{ may appear in the CSS -- it would be parsed as a merge
--    field and substituted away. The stylesheet DOES contain one nested
--    at-rule (@page { @bottom-center { ... } }), and what keeps it safe is the
--    whitespace between the braces, not the absence of nesting: `{ @` and
--    `} }` are not `{{`. That is what schema.test.ts enforces -- it counts
--    every `{{` in the body and requires each to be one of the known tokens --
--    so a future edit that closes two at-rules up against each other fails
--    there rather than printing a mangled page.
--
-- 3. class="pre" is white-space: pre-line, and it is on every multi-line
--    field. org.address_lines and companies.address are newline-separated
--    free text, and merge substitution HTML-escapes but does not turn a
--    newline into a <br> -- without this class a three-line address prints as
--    one run-on line.
--
-- THE TAX RATE IS A COLUMN IN THE LINE TABLE, not just an input to the
-- blended total. tax_rate_bp is per line, so a quote mixing 21% and 9% work
-- shows one summed tax figure that the recipient cannot take apart. Printing
-- each line's own rate is what makes the total reconstructible, and it costs a
-- column on a page that has room for it.
--
-- WHAT IS DELIBERATELY ABSENT: the logo. org_profile.logo_file_id exists and
-- the merge context carries org.logoDataUri, but the merge language has no
-- conditional, so <img src="{{org.logoDataUri}}"> on an install with no logo
-- uploaded would render an <img src=""> on every quote. A missing logo is a
-- plain letterhead; a broken image is an ugly PDF for everyone who never
-- uploads one. Adding the slot needs an empty-safe form first -- the cheapest
-- being a transparent 1x1 data: URI supplied by the context when no logo is
-- set -- and until then it is one line for a user to add in Settings, where
-- the merge fields are listed on the page.
--
-- The footer carries page numbers and no merge field, also deliberately: a
-- {{...}} inside a CSS string would be escaped as HTML, which is not CSS
-- escaping, and the two only coincide by luck.
INSERT INTO "document_templates" ("type", "body_html") VALUES ('quote', '<style>
@page { size: A4; margin: 18mm 16mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.45; color: #111; }
h1 { font-size: 20pt; margin: 6mm 0 3mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.right { text-align: right; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
.party { margin-top: 7mm; }
table.meta td { padding: 0 6mm 0 0; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 9mm; }
table.lines th { text-align: left; font-size: 8.5pt; text-transform: uppercase; color: #666; border-bottom: 0.4mm solid #111; padding: 0 0 1.5mm; }
table.lines th.right { text-align: right; }
table.lines td { padding: 2mm 0; border-bottom: 0.2mm solid #ddd; vertical-align: top; }
table.lines td.right { padding-left: 4mm; }
table.totals { margin-top: 5mm; margin-left: auto; }
table.totals td { padding: 1mm 0 1mm 10mm; }
table.totals tr.grand td { border-top: 0.4mm solid #111; font-size: 12pt; padding-top: 2mm; }
.foot { margin-top: 12mm; font-size: 9pt; }
.foot div { margin-top: 2mm; }
</style>
<div>
<div><strong>{{org.name}}</strong></div>
<div class="pre">{{org.addressLines}}</div>
<div>{{org.email}}</div>
<div>{{org.phone}}</div>
<div>{{org.website}}</div>
</div>
<h1>Quote {{document.number}}</h1>
<table class="meta">
<tr><td class="label">Issued</td><td>{{document.issueDate}}</td></tr>
<tr><td class="label">Valid until</td><td>{{document.validUntilDate}}</td></tr>
</table>
<div class="party">
<div class="label">To</div>
<div><strong>{{document.recipientName}}</strong></div>
<div>{{document.recipientContactName}}</div>
<div class="pre">{{document.recipientAddress}}</div>
</div>
<table class="lines">
<thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Tax</th><th class="right">Amount</th></tr></thead>
<tbody>{{#lines}}<tr><td class="pre">{{description}}</td><td class="right">{{qty}}</td><td class="right">{{unitPrice}}</td><td class="right">{{taxRate}}</td><td class="right">{{lineTotal}}</td></tr>{{/lines}}</tbody>
</table>
<table class="totals">
<tr><td class="label">Subtotal</td><td class="right">{{document.subtotal}}</td></tr>
<tr><td class="label">Tax</td><td class="right">{{document.tax}}</td></tr>
<tr class="grand"><td><strong>Total</strong></td><td class="right"><strong>{{document.total}}</strong></td></tr>
</table>
<div class="foot">
<div class="pre">{{document.notes}}</div>
<div class="pre muted">{{document.terms}}</div>
<div class="pre muted">{{org.bankDetails}}</div>
<div class="muted">VAT {{org.vatNumber}}</div>
<div class="muted">Company registration {{org.registrationNumber}}</div>
</div>');
