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
	"logo_data_uri" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_profile_singleton" CHECK (id = 1),
	CONSTRAINT "org_profile_logo_size" CHECK (char_length("org_profile"."logo_data_uri") <= 43715),
	CONSTRAINT "org_profile_logo_shape" CHECK ("org_profile"."logo_data_uri" = '' OR "org_profile"."logo_data_uri" ~ '^data:image/(png|jpeg|gif|webp)\073base64,[A-Za-z0-9+/]+={0,2}$')
);
--> statement-breakpoint
ALTER TABLE "document_line_items" ADD CONSTRAINT "document_line_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
--    THE BLOCK FORMS ARE {{#path}}...{{/path}} (render the body when the value
--    is not empty) AND {{^path}}...{{/path}} (render it when it IS empty), with
--    lines being the one repeated case. Every optional field below is wrapped in
--    one, and that is not decoration: without it an install that never filled in
--    a VAT number prints the word "VAT" over a blank on every quote it raises,
--    and one that never uploaded a logo prints a broken <img src="">. A closer
--    matches its own opener by depth, so blocks may be nested; an unclosed
--    block is IGNORED and its body renders as ordinary content, which is why a
--    missing {{/...}} costs a label rather than the rest of the page.
--
-- 2. No literal {{ may appear in the CSS -- it would be parsed as a merge
--    field and substituted away. The stylesheet DOES contain one nested
--    at-rule (@page { @bottom-center { ... } }), and what keeps it safe is the
--    space between its OPENING braces: `{ @` is not `{{`. schema.test.ts
--    enforces exactly that -- it counts every `{{` in the body and requires
--    each to be one of the known tokens -- so an edit that opened two at-rules
--    up against each other would fail there.
--
--    IT DOES NOT GUARD THE CLOSING BRACES, and an earlier draft of this
--    comment claimed it did. Writing `color: #888;}}` keeps the test green,
--    because `}}` produces no `{{` to count -- and it is harmless anyway, since
--    an unmatched `}}` is inert to a Mustache-shaped parser. The assertion is
--    load-bearing for the case that is NOT harmless, which is an opening pair.
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
-- THE LOGO IS HERE, AND IT IS WHY THE BLOCK FORM EXISTS. An earlier draft of
-- this template left the slot out entirely, because <img src="{{org.logoDataUri}}">
-- on an install that never uploaded one renders <img src=""> -- a broken image
-- on every quote by default. The coordinator's ruling generalised the block
-- form rather than supplying a transparent 1x1 placeholder, on the grounds that
-- every optional field has the same shape and a placeholder fixes one of them.
-- So the logo, the valid-until row, the contact name, the notes, the terms, the
-- bank details, the VAT number and the registration number are each wrapped,
-- and an install with none of them filled in renders a plain letterhead with no
-- empty images and no labels standing over blanks.
--
-- The sanitiser is the belt to that braces: an <img> whose src does not survive
-- is dropped entirely rather than left as an alt string, so a template that
-- hard-codes the slot without a block still cannot print a broken image.
--
-- The footer carries page numbers and no merge field, also deliberately: a
-- {{...}} inside a CSS string would be escaped as HTML, which is not CSS
-- escaping, and the two only coincide by luck.
INSERT INTO "document_templates" ("type", "body_html") VALUES ('quote', '<style>
@page { size: A4; margin: 18mm 16mm 24mm; }
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: sans-serif; font-size: 8pt; color: #888; } }
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.4; color: #111; }
h1 { font-size: 18pt; margin: 5mm 0 3mm; }
.pre { white-space: pre-line; }
.muted { color: #666; }
.logo { margin-bottom: 3mm; }
.logo img { max-height: 14mm; max-width: 60mm; }
.right { text-align: right; }
.label { font-size: 8.5pt; text-transform: uppercase; color: #666; }
.party { margin-top: 6mm; }
table.meta td { padding: 0 6mm 0 0; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 7mm; }
table.lines th { text-align: left; font-size: 8.5pt; text-transform: uppercase; color: #666; border-bottom: 0.4mm solid #111; padding: 0 0 1.5mm; }
table.lines th.right { text-align: right; }
table.lines td { padding: 1.6mm 0; border-bottom: 0.2mm solid #ddd; vertical-align: top; }
table.lines td.right { padding-left: 4mm; }
table.totals { margin-top: 4mm; margin-left: auto; }
table.totals td { padding: 1mm 0 1mm 10mm; }
table.totals tr.grand td { border-top: 0.4mm solid #111; font-size: 12pt; padding-top: 2mm; }
.foot { margin-top: 7mm; font-size: 9pt; page-break-inside: avoid; }
.foot div { margin-top: 1.5mm; }
</style>
<div>
{{#org.logoDataUri}}<div class="logo"><img src="{{org.logoDataUri}}" alt=""></div>{{/org.logoDataUri}}
<div><strong>{{org.name}}</strong></div>
{{#org.addressLines}}<div class="pre">{{org.addressLines}}</div>{{/org.addressLines}}
{{#org.email}}<div>{{org.email}}</div>{{/org.email}}
{{#org.phone}}<div>{{org.phone}}</div>{{/org.phone}}
{{#org.website}}<div>{{org.website}}</div>{{/org.website}}
</div>
<h1>Quote {{document.number}}</h1>
<table class="meta">
<tr><td class="label">Issued</td><td>{{document.issueDate}}</td></tr>
{{#document.validUntilDate}}<tr><td class="label">Valid until</td><td>{{document.validUntilDate}}</td></tr>{{/document.validUntilDate}}
</table>
<div class="party">
<div class="label">To</div>
<div><strong>{{document.recipientName}}</strong></div>
{{#document.recipientContactName}}<div>{{document.recipientContactName}}</div>{{/document.recipientContactName}}
{{#document.recipientAddress}}<div class="pre">{{document.recipientAddress}}</div>{{/document.recipientAddress}}
</div>
<table class="lines">
<thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Tax</th><th class="right">Amount</th></tr></thead>
<tbody>{{#lines}}<tr><td class="pre">{{description}}</td><td class="right">{{qty}}</td><td class="right">{{unitPrice}}</td><td class="right">{{taxRate}}</td><td class="right">{{lineTotal}}</td></tr>{{/lines}}{{^lines}}<tr><td class="muted" colspan="5">No line items.</td></tr>{{/lines}}</tbody>
</table>
<table class="totals">
<tr><td class="label">Subtotal</td><td class="right">{{document.subtotal}}</td></tr>
<tr><td class="label">Tax</td><td class="right">{{document.tax}}</td></tr>
<tr class="grand"><td><strong>Total</strong></td><td class="right"><strong>{{document.total}}</strong></td></tr>
</table>
<div class="foot">
{{#document.notes}}<div class="pre">{{document.notes}}</div>{{/document.notes}}
{{#document.terms}}<div class="pre muted">{{document.terms}}</div>{{/document.terms}}
{{#org.bankDetails}}<div class="pre muted">{{org.bankDetails}}</div>{{/org.bankDetails}}
{{#org.vatNumber}}<div class="muted">VAT {{org.vatNumber}}</div>{{/org.vatNumber}}
{{#org.registrationNumber}}<div class="muted">Company registration {{org.registrationNumber}}</div>{{/org.registrationNumber}}
</div>');
