import { sql } from "drizzle-orm";
import type { DocumentRecord } from "@conduit/shared";
import type { Database } from "../db/client.js";

/**
 * A PRE-PHASE-9 INSTALL'S QUOTES, WRITTEN BY THE PRE-MIGRATION CODE.
 *
 * WHY THIS FILE EXISTS AT ALL. Phase 9 Task 1 splits `documents` -- a quote
 * table wearing a generic name -- into a common table plus `document_quotes`,
 * and migration 0016 MOVES EVERY QUOTE ROW ON A LIVE INSTALL to do it. Eleven
 * columns leave `documents` and land in another table. If the move loses a
 * value, reorders a line or reshapes a row, the quote somebody has already sent
 * a customer is wrong or gone, and only a backup gets it back.
 *
 * A ROUND TRIP THROUGH THE NEW CODE CANNOT PROVE THAT. Issuing a quote with the
 * new writer and reading it back with the new reader proves only that the new
 * code agrees with itself -- it would pass unchanged if the writer and the
 * reader had BOTH moved to a shape no stored row has. The rows below are
 * therefore not generated at test time. They were produced once, by `issueQuote`
 * as it stood BEFORE any Phase 9 edit, against a database migrated only as far
 * as 0015, and dumped column by column with `SELECT row_to_json(t)`.
 *
 * PROVENANCE, so this is checkable rather than merely asserted:
 *
 *   commit ..................... 5dac36670148d2b4b97ae541493dd67dac7e024f
 *                                ("docs(plan): Phase 9 in four tasks, data model
 *                                first and the broadest source last" -- the last
 *                                commit before the split)
 *   services/documents.ts ...... d508d0eb54224d93fc8a240b9d001e4db5f86f7c
 *   db/schema.ts ............... 21f52959aa83d593681909041e0196ac583b5177
 *   shared/src/index.ts ........ 9391ae4f8bde2f2867b64595621d8b8ad791be0d
 *
 *   `git cat-file -p <blob>` is the exact source that wrote these rows. To
 *   regenerate: check those blobs out into a scratch tree, seed a user, company,
 *   pipeline, stage and deal through the ordinary services, insert the 0009
 *   template body (test/seed-template.ts), call `issueQuote` twice with the two
 *   inputs described below, and dump every table. Do NOT regenerate them with the
 *   current writer: a fixture written by the code under test is the failed
 *   version of this proof, not the passed one. This is v1.7.0's credential-union
 *   lesson (test/legacy-mail-credentials.ts) applied to rows instead of blobs.
 *
 * RENDERED BY A REAL WEASYPRINT -- the dev server's 57.2 -- and not by the
 * suite's stub `python3`, so LEGACY_QUOTE_PDFS records two real quotes rather
 * than sixteen random bytes: 14,565 and 13,191 bytes, ONE PAGE each, each
 * carrying its own number in its text (measured with test/pdf.ts's pageCount and
 * pdfText at capture time).
 *
 * THE PDF BYTES ARE DELIBERATELY NOT COMMITTED, and that is an argument rather
 * than a shortcut. Blobs are content-addressed: `blobPath(dataDir, sha256)` is
 * the whole of how a stored PDF is found, and migration 0016 names neither
 * `files` nor the blob store. A `files` row whose sha256 and size_bytes come
 * through the migration unchanged therefore names the same bytes BY
 * CONSTRUCTION, which is exactly the claim "the existing quote still opens, and
 * nothing re-rendered it". 28KB of committed PDF could not falsify anything the
 * sha256 does not, so the drill asserts the sha256 and records the page count
 * here instead.
 *
 * TWO CASES, AND NEITHER IS THE OTHER'S NEIGHBOUR:
 *
 *  - QUO-2026-0001 fills every optional column -- a valid-until date, a contact
 *    name, a salutation, a two-line address, notes, terms -- and carries THREE
 *    lines at THREE different tax rates, including a zero-priced one. A
 *    migration that dropped a column, or that moved the lines' order, shows up
 *    here and nowhere else.
 *  - QUO-2026-0002 is the least a quote can be: no valid-until date, and `''`
 *    in all five columns that default to it. A NULL/'' confusion in the move
 *    would pass against the first case and fail against this one.
 *
 * ITS TEXT IS THE HOSTILE HALF, on the credential fixture's argument. The
 * recipient carries `&` and `<` (escaped on the way into the page, stored bare)
 * and two Latin-1 letters; the line description adds a colon, a double quote, a
 * backslash, a NO-BREAK SPACE and an astral-plane emoji -- JSON escaping, the
 * utf8 decode and a surrogate pair, all in one column that the migration copies
 * verbatim between tables.
 *
 * WRITTEN AS \u ESCAPES for the same reason the credential fixture is: the
 * NO-BREAK SPACE at U+00A0 renders identically to a space, so a diff whose two
 * sides differ only there is unreadable. That character is in this fixture
 * because it was typed by accident into the generator's input -- exactly the
 * accident the credential fixture's comment warns about -- and it stays,
 * escaped, because it is one of the characters worth having in here.
 */

/** One row, keyed by its column name exactly as the pre-0016 catalogue spelled it. */
export interface LegacyRow { readonly [column: string]: unknown }

/**
 * Every row a pre-0016 database held, in the order the foreign keys require.
 *
 * The parents are here rather than rebuilt through the services because a quote
 * names its deal, its file and its issuer BY ID: recreating them would mean
 * rewriting those three columns, and a fixture whose ids are patched at replay
 * time is no longer the row the old code wrote.
 */
export const LEGACY_QUOTE_TABLES: readonly (readonly [string, readonly LegacyRow[]])[] = [
  ["users", [
    {
      id: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
      username: "chris",
      email: null,
      full_name: null,
      created_at: "2026-09-06T02:57:03.946762+00:00",
      last_seen_at: "2026-09-06T02:57:03.946762+00:00",
    },
  ]],
  ["companies", [
    {
      id: "8d3f4113-c8c2-43d7-867a-b2b9800d9a2d",
      name: "Acme Manufacturing BV",
      domain: null,
      website: null,
      phone: null,
      address: null,
      industry: null,
      owner_user_id: null,
      custom: {},
      archived_at: null,
      created_at: "2026-09-06T02:57:03.949249+00:00",
      updated_at: "2026-09-06T02:57:03.949249+00:00",
    },
  ]],
  ["pipelines", [
    {
      id: "d230a539-ca14-4cc8-b1f0-f045cbfcbff9",
      name: "Sales",
      scope: "global",
      company_id: null,
      position: "a0",
      archived_at: null,
      created_at: "2026-09-06T02:57:03.954393+00:00",
      updated_at: "2026-09-06T02:57:03.954393+00:00",
      project_id: null,
    },
  ]],
  ["stages", [
    {
      id: "942cd845-439c-4ae5-8621-f16bee9841ec",
      pipeline_id: "d230a539-ca14-4cc8-b1f0-f045cbfcbff9",
      name: "New",
      position: "a0",
      probability: null,
      rot_days: null,
      created_at: "2026-09-06T02:57:03.960218+00:00",
      updated_at: "2026-09-06T02:57:03.960218+00:00",
    },
  ]],
  ["deals", [
    {
      id: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
      title: "Big Deal",
      pipeline_id: "d230a539-ca14-4cc8-b1f0-f045cbfcbff9",
      stage_id: "942cd845-439c-4ae5-8621-f16bee9841ec",
      position: "a0",
      value_cents: null,
      currency: "EUR",
      expected_close_date: null,
      status: "open",
      lost_reason: null,
      closed_at: null,
      owner_user_id: null,
      company_id: "8d3f4113-c8c2-43d7-867a-b2b9800d9a2d",
      contact_id: null,
      archived_at: null,
      created_at: "2026-09-06T02:57:03.965404+00:00",
      updated_at: "2026-09-06T02:57:03.965404+00:00",
    },
  ]],
  ["files", [
    {
      id: "e3b3bb32-ba43-43d2-9391-f8cd17d7ba61",
      original_name: "QUO-2026-0001.pdf",
      mime: "application/pdf",
      size_bytes: 14565,
      sha256: "b97e76142ddd740cb403bf2a15665c72957e5c3984601dd3c9c50f64d00758ce",
      uploader_user_id: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
      company_id: null,
      contact_id: null,
      created_at: "2026-09-06T02:57:03.975828+00:00",
      deal_id: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
      project_id: null,
    },
    {
      id: "a86e82cb-f8c7-46da-92d3-2317be239231",
      original_name: "QUO-2026-0002.pdf",
      mime: "application/pdf",
      size_bytes: 13191,
      sha256: "394ce7aaa4b163a5e940f9dad4e69a04ced18cfe4ce87f3586b53f4fbfa60961",
      uploader_user_id: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
      company_id: null,
      contact_id: null,
      created_at: "2026-09-06T02:57:04.727606+00:00",
      deal_id: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
      project_id: null,
    },
  ]],
  ["documents", [
    {
      id: "2ef55ae8-b20c-4e00-bcb5-741c5e724ccd",
      number: "QUO-2026-0001",
      type: "quote",
      deal_id: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
      file_id: "e3b3bb32-ba43-43d2-9391-f8cd17d7ba61",
      currency: "EUR",
      issue_date: "2026-08-28",
      valid_until_date: "2026-09-27",
      recipient_name: "Acme Manufacturing BV",
      recipient_contact_name: "Jane Smith",
      recipient_address: "2 Low Street\n1015 CJ Amsterdam",
      subtotal_cents: 28000,
      tax_cents: 3720,
      total_cents: 31720,
      notes: "Thank you for your interest.",
      terms: "Payment within 30 days.",
      issued_by_user_id: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
      created_at: "2026-09-06T02:57:03.975828+00:00",
      recipient_salutation: "Dr",
    },
    {
      id: "462ba862-059a-4733-b748-44e18a315a87",
      number: "QUO-2026-0002",
      type: "quote",
      deal_id: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
      file_id: "a86e82cb-f8c7-46da-92d3-2317be239231",
      currency: "EUR",
      issue_date: "2026-08-29",
      valid_until_date: null,
      recipient_name: "M\u00fcller & S\u00f6hne <GmbH>",
      recipient_contact_name: "",
      recipient_address: "",
      subtotal_cents: 1,
      tax_cents: 0,
      total_cents: 1,
      notes: "",
      terms: "",
      issued_by_user_id: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
      created_at: "2026-09-06T02:57:04.727606+00:00",
      recipient_salutation: "",
    },
  ]],
  ["document_line_items", [
    {
      id: "5a09dd84-beaf-488c-9c65-28c8ddbbf572",
      document_id: "2ef55ae8-b20c-4e00-bcb5-741c5e724ccd",
      position: 1,
      description: "Widget",
      qty_milli: 2000,
      unit_price_cents: 5000,
      tax_rate_bp: 2100,
      line_total_cents: 10000,
    },
    {
      id: "a378d088-baf2-4265-b324-fb3fa05893ca",
      document_id: "2ef55ae8-b20c-4e00-bcb5-741c5e724ccd",
      position: 2,
      description: "Installation",
      qty_milli: 1500,
      unit_price_cents: 12000,
      tax_rate_bp: 900,
      line_total_cents: 18000,
    },
    {
      id: "604a3f16-e388-4068-ae83-129e63eff841",
      document_id: "2ef55ae8-b20c-4e00-bcb5-741c5e724ccd",
      position: 3,
      description: "Goodwill discount",
      qty_milli: 1000,
      unit_price_cents: 0,
      tax_rate_bp: 0,
      line_total_cents: 0,
    },
    {
      id: "0919d18f-b42d-4cf1-aeac-8830b9a95405",
      document_id: "462ba862-059a-4733-b748-44e18a315a87",
      position: 1,
      description: "R\u00e4tsel: \"a\\b\"\u00a0\u{1f510}",
      qty_milli: 1000,
      unit_price_cents: 1,
      tax_rate_bp: 0,
      line_total_cents: 1,
    },
  ]],
  ["document_number_sequences", [
    {
      type: "quote",
      year: 2026,
      last_value: 2,
    },
  ]],
];

/** The deal both quotes hang off -- what `listDocuments` is called with. */
export const LEGACY_QUOTE_DEAL_ID = "6c2710e2-cb56-4047-bafe-4ed7092c8af2";

/** The pre-0016 `documents` columns, read off the fixture rather than retyped. */
export const LEGACY_DOCUMENT_COLUMNS: readonly string[] =
  Object.keys(LEGACY_QUOTE_TABLES.find(([table]) => table === "documents")![1][0]!).sort();

/**
 * WHAT THE OLD READER RETURNED FOR THAT DEAL, verbatim, newest first.
 *
 * This is the assertion the whole file exists to make possible: the NEW
 * `listDocuments`, over the NEW two-table schema, must return exactly this for
 * data the OLD writer wrote. Typed as `DocumentRecord` on purpose -- if a later
 * phase changes the wire shape, this stops compiling, and restating what an
 * existing install's quotes look like becomes a decision somebody makes rather
 * than a diff nobody reads.
 */
export const LEGACY_QUOTE_LIST: readonly DocumentRecord[] = [
  {
    id: "462ba862-059a-4733-b748-44e18a315a87",
    number: "QUO-2026-0002",
    type: "quote",
    dealId: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
    fileId: "a86e82cb-f8c7-46da-92d3-2317be239231",
    currency: "EUR",
    issueDate: "2026-08-29",
    validUntilDate: null,
    recipientName: "M\u00fcller & S\u00f6hne <GmbH>",
    recipientContactName: "",
    recipientSalutation: "",
    recipientAddress: "",
    subtotalCents: 1,
    taxCents: 0,
    totalCents: 1,
    notes: "",
    terms: "",
    issuedByUserId: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
    createdAt: "2026-09-06T02:57:04.727Z",
    lines: [
      {
        id: "0919d18f-b42d-4cf1-aeac-8830b9a95405",
        position: 1,
        description: "R\u00e4tsel: \"a\\b\"\u00a0\u{1f510}",
        qtyMilli: 1000,
        unitPriceCents: 1,
        taxRateBp: 0,
        lineTotalCents: 1,
      },
    ],
  },
  {
    id: "2ef55ae8-b20c-4e00-bcb5-741c5e724ccd",
    number: "QUO-2026-0001",
    type: "quote",
    dealId: "6c2710e2-cb56-4047-bafe-4ed7092c8af2",
    fileId: "e3b3bb32-ba43-43d2-9391-f8cd17d7ba61",
    currency: "EUR",
    issueDate: "2026-08-28",
    validUntilDate: "2026-09-27",
    recipientName: "Acme Manufacturing BV",
    recipientContactName: "Jane Smith",
    recipientSalutation: "Dr",
    recipientAddress: "2 Low Street\n1015 CJ Amsterdam",
    subtotalCents: 28000,
    taxCents: 3720,
    totalCents: 31720,
    notes: "Thank you for your interest.",
    terms: "Payment within 30 days.",
    issuedByUserId: "fdfaf2f8-fdfa-4221-a1e5-bedb6a958766",
    createdAt: "2026-09-06T02:57:03.975Z",
    lines: [
      {
        id: "5a09dd84-beaf-488c-9c65-28c8ddbbf572",
        position: 1,
        description: "Widget",
        qtyMilli: 2000,
        unitPriceCents: 5000,
        taxRateBp: 2100,
        lineTotalCents: 10000,
      },
      {
        id: "a378d088-baf2-4265-b324-fb3fa05893ca",
        position: 2,
        description: "Installation",
        qtyMilli: 1500,
        unitPriceCents: 12000,
        taxRateBp: 900,
        lineTotalCents: 18000,
      },
      {
        id: "604a3f16-e388-4068-ae83-129e63eff841",
        position: 3,
        description: "Goodwill discount",
        qtyMilli: 1000,
        unitPriceCents: 0,
        taxRateBp: 0,
        lineTotalCents: 0,
      },
    ],
  },
];

export interface LegacyQuotePdf {
  /** The `files` row the document points at. */
  readonly fileId: string;
  readonly originalName: string;
  /** What the blob store is keyed by, and therefore what must not move. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Measured at capture time with test/pdf.ts's pageCount, on WeasyPrint 57.2. */
  readonly pages: number;
}

export const LEGACY_QUOTE_PDFS: readonly LegacyQuotePdf[] = [
  {
    fileId: "e3b3bb32-ba43-43d2-9391-f8cd17d7ba61",
    originalName: "QUO-2026-0001.pdf",
    sha256: "b97e76142ddd740cb403bf2a15665c72957e5c3984601dd3c9c50f64d00758ce",
    sizeBytes: 14_565,
    pages: 1,
  },
  {
    fileId: "a86e82cb-f8c7-46da-92d3-2317be239231",
    originalName: "QUO-2026-0002.pdf",
    sha256: "394ce7aaa4b163a5e940f9dad4e69a04ced18cfe4ce87f3586b53f4fbfa60961",
    sizeBytes: 13_191,
    pages: 1,
  },
];

/**
 * Put every row back into a database that is still at 0015.
 *
 * `json_populate_record(NULL::<table>, ...)` RATHER THAN A HAND-WRITTEN COLUMN
 * LIST, and the difference matters more here than it did for the 0014 drill. The
 * house lesson (schema.test.ts's 0004 drill, which broke when
 * `contacts.salutation` arrived) is that a drizzle INSERT names TODAY'S columns
 * and so can only ever describe today's shape. A hand-written list answers that
 * by pinning the column names in the TEST. This answers it by pinning them in
 * the FIXTURE: every key above was read out of the pre-0016 catalogue by
 * `row_to_json`, so the INSERT names exactly the columns that existed then --
 * nothing here is derived from the current schema, so a column a later migration
 * adds cannot creep in, and one this migration REMOVES cannot quietly stop being
 * written. Postgres does the text-to-uuid/date/jsonb coercion, which is also the
 * coercion the real column types demand.
 *
 * One statement per row rather than one per table: the rows are nine, the
 * clarity of a failure naming its own table is worth more than the round trips,
 * and `json_populate_record` takes a single object rather than a set.
 */
export async function replayLegacyQuoteRows(db: Database): Promise<void> {
  for (const [table, rows] of LEGACY_QUOTE_TABLES) {
    for (const row of rows) {
      await db.execute(sql`
        INSERT INTO ${sql.identifier(table)}
        SELECT * FROM json_populate_record(
          NULL::${sql.identifier(table)}, ${JSON.stringify(row)}::json
        )
      `);
    }
  }
}
