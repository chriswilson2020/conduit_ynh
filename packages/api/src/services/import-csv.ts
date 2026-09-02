import type { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import {
  contactEmailSchema, csvImportField, csvMappingEntity, csvMappingProblem,
  unstorableText, CONTACT_FIELD_CAPS, CSV_IMPORT_FIELDS,
} from "@conduit/shared";
import type {
  CsvColumnView, CsvImportEntity, CsvImportField, CsvMapping, CsvMappingFinding,
  CsvMappingRefusal, CsvMappingView, PlanFindingView, PlanRefusalView,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts } from "../db/schema.js";
import {
  delimiterName, foreignCsvRecords, sniffCsvDelimiter, CsvParseError,
  type ForeignCsvRepair,
} from "./csv.js";
import {
  applyPlan, newPlan, planSource,
  type ApplyContext, type ApplyOutcome, type EffectHandlers, type Plan, type PlannedEffect,
} from "./intake-plan.js";
import type { IntakeFile, StagedMemberRef, StagedPayload } from "./intake.js";

// THE FORGIVING IMPORTER: A SPREADSHEET FROM SOMEWHERE ELSE.
//
// services/intake.ts landed the upload and stageVerbatim made a one-member
// payload of it; services/intake-plan.ts owns the plan and the frame apply runs
// in. This is the last of the three pipelines, and it is the only one with an
// INTERACTIVE STEP between inspect and plan -- the 7.7 spec says so in its own
// words, and the reason is that THE MAPPING IS A HUMAN DECISION THAT CANNOT
// EXIST BEFORE THE HEADERS DO. A restore and an exact import read a manifest
// that says what everything is; a foreign file has a header row somebody typed.
//
// So this module has three entry points where the other two have two:
//
//   inspectCsv .......... what is in this file? (columns, samples, a guess)
//                         -- a person reads it and decides the mapping
//   planCsvImport ....... what will this mapping create? (the plan)
//   applyCsvImport ...... create it
//
// ================ THE THREE DECISIONS THE TASK ASKED FOR =================
//
// 1. A BAD ROW IS REPORTED AND SKIPPED. THE IMPORT IS STILL ALL OR NOTHING.
//
//    Chris's word is "forgiving" and the spec says a partial failure must not
//    leave half a spreadsheet loaded. Those look like they pull in opposite
//    directions and they do not, because they are about DIFFERENT MOMENTS:
//
//      - A BAD ROW IS DECIDED BEFORE THE TRANSACTION IS OPEN. Every reason a
//        row cannot be imported -- an empty required cell, a value Postgres
//        cannot store, a record with more values than the header has columns --
//        is found by reading the file at PLAN time, counted, named in the
//        preview, and EXCLUDED FROM THE EFFECT'S COUNT. Nothing is written, so
//        nothing can be half written. The operator reads "3,988 contacts will
//        be created; 12 rows are not imported, and here is why" and decides.
//      - A PARTIAL FAILURE IS WHAT HAPPENS AFTER THEY SAY YES, and there the
//        answer is the spec's: one transaction, rolled back as a unit.
//
//    So the forgiveness lives entirely in front of the transaction and the
//    atomicity lives entirely inside it. That is not a compromise between two
//    requirements; it is the observation that they were never about the same
//    moment.
//
//    WHAT THE RESOLUTION COSTS, AND IT IS THE PART THAT HAD TO BE BUILT RATHER
//    THAN ASSERTED: it only holds if PLAN CATCHES EVERYTHING THE DATABASE WOULD
//    REFUSE. A row the preview called good that then fails its INSERT takes the
//    whole import with it, and the forgiveness would be a lie. Two things hold
//    it. buildRow is the SAME FUNCTION at plan and at apply, over the same
//    bytes, so its answers cannot differ. And every constraint on these two
//    tables is checked inside it by name -- NOT NULL on `name` and
//    `first_name`, contacts_salutation_length and contacts_pronouns_length, the
//    email format db/schema.ts says the input schemas own, and the NUL that no
//    CHECK describes because Postgres refuses it at the type. `unstorableText`
//    and `contactEmailSchema` are imported from @conduit/shared rather than
//    restated, so this file USES those rules instead of owning a second copy of
//    them.
//
//    A VALUE THAT CANNOT BE STORED IS DROPPED; A REQUIRED VALUE THAT CANNOT BE
//    STORED SKIPS THE ROW. One sentence, no special cases. A contact whose
//    second email address is `not an email` is imported without it and the
//    preview names the record and the value -- losing a person over a typo in
//    an optional cell is not forgiving by any reading of the word. A contact
//    with no first name has nothing to be, so the row goes.
//
//    A RAGGED RECORD IS SPLIT IN TWO, AND THE ASYMMETRY IS THE POINT. A record
//    with FEWER values than the header has columns is padded: the values it
//    does have still line up with their columns, and the missing ones are
//    trailing, so importing it is right and refusing it would throw away a row
//    over a trailing empty cell some exporter did not write. A record with MORE
//    values is SKIPPED, because the ordinary cause is a delimiter inside an
//    unquoted value -- which shifts every column after it, and importing that
//    row puts a postcode in a phone number with nothing on screen to say so.
//
// 2. DUPLICATES ARE MATCHED ON EMAIL FOR CONTACTS AND DOMAIN FOR COMPANIES,
//    CASE-INSENSITIVELY, AND A MATCH IS SKIPPED.
//
//    WHY NOT NAME. Because a name is not a key and never was. Two people are
//    called John Smith; one person is "John Smith", "J. Smith" and "Smith,
//    John" across three exports; there are two companies genuinely called Acme
//    -- which is the exact case services/import-export.ts names when it argues
//    for keeping the export's ids. A foreign CSV has no id, so the question is
//    which of the columns it DOES have is owned by exactly one record. An email
//    address is: a mailbox has one owner, it is what an operator searches for,
//    and every CRM in the world exports it. A domain is the same argument for a
//    company.
//
//    THREE THINGS FOLLOW AND ALL THREE ARE IN THE PREVIEW.
//
//      - A ROW WITH NO KEY IS NEVER A DUPLICATE AND IS ALWAYS CREATED. A
//        contact with no email address cannot be matched against anything, so
//        it is imported, and the count of such rows is a finding -- because it
//        is precisely the number that turns into complaints about duplicates
//        after the second import.
//      - A ROW WHOSE KEY REPEATS AN EARLIER ROW OF THE SAME FILE is a different
//        thing from one already in the install, and it gets its own finding:
//        the operator acts on the two differently (fix the spreadsheet, or
//        accept that Conduit already has them). The FIRST row with a given key
//        decides; later ones are duplicates of it.
//      - A MATCH IS SKIPPED, NOT MERGED AND NOT OVERWRITTEN. Every effect here
//        says `destroys: false`, and rewriting a contact somebody has edited
//        since would destroy data the preview promised to leave alone. Merging
//        is worse than overwriting: it invents a policy per field -- does the
//        file's phone number win? -- that nobody previewed and no sentence in a
//        preview could honestly describe.
//
//    ARCHIVED ROWS COUNT AS PRESENT. Conduit never expunges, so a contact whose
//    address is in this file and who was archived last year IS already here.
//    Creating a second one beside them is the outcome that cannot be undone
//    without work; un-archiving is one click.
//
//    NORMALISATION IS `trim` AND `toLowerCase` AND NOTHING ELSE, and the reason
//    is that the same rule has to run in TWO LANGUAGES. The candidate keys come
//    from JavaScript and the stored ones are found with `lower(...)` in SQL; a
//    cleverer rule (strip `https://`, strip a leading `www.`, fold a Gmail
//    plus-address) would have to be written twice and would drift, and the half
//    that drifted would silently merge two records or silently fail to. THE
//    COST IS NAMED RATHER THAN HIDDEN: `www.acme.com` in the file and
//    `acme.com` in Conduit are two companies. An operator can see that from the
//    preview's counts and normalise their own column, which is a thing they can
//    do and this code cannot do for them safely.
//
//    AND `toLowerCase` IS NOT `lower()`, WHICH THE PARAGRAPH ABOVE IMPLIED AND
//    A REVIEW MEASURED. The argument for a simple rule survives; the claim that
//    THIS rule is the same rule in both languages does not. On the deploy
//    target (PostgreSQL 15.19, en_GB.UTF-8):
//
//      SELECT lower(U&'\0130')  ->  'i'         ONE character
//      '\u0130'.toLowerCase()   ->  'i\u0307'    TWO -- i, then a combining
//                                                dot above
//
//    (U+0130 is the Turkish dotted capital I. Written as escapes because this
//    file is ASCII, which is the project's rule and is also what stopped the
//    two spellings above from looking identical in a terminal.)
//
//    So a key containing that character is normalised differently on the two
//    sides, and the failure is a MISSED duplicate -- the outcome this whole
//    section exists to prevent. It is also LOCALE-DEPENDENT on the SQL side and
//    nothing here pins the database's locale.
//
//    IT IS OUT OF REACH FOR CONTACTS AND LIVE FOR COMPANIES. A contact's key is
//    an email address and contactEmailSchema rejects non-ASCII outright, so no
//    such key can be built. A company's key is `domain`, which is free text
//    with no format check at all -- so this is reachable today with a Turkish
//    or Azerbaijani domain, and it is recorded rather than fixed because the
//    fix is a decision about collation that belongs with the person who owns
//    the schema: either fold the key in ONE language (probe with a normalised
//    literal rather than `lower(...)`) or state a collation the install must
//    have. Both are wider than an importer.
//
//    AND THE GAP THAT CANNOT BE CLOSED HERE: the probe reads COMMITTED rows, so
//    another session inserting the same address between the probe and the
//    INSERT produces a duplicate. Closing it would need a unique index on
//    `lower(email)`, which is a migration AND would be wrong -- a shared mailbox
//    is legitimately two contacts' address, and an install that already has one
//    could not be migrated onto it. It is stated rather than defended.
//
// 3. THE COUNT MOVING BETWEEN PREVIEW AND APPLY ROLLS THE WHOLE IMPORT BACK,
//    WHICH IS WHAT THE EXACT IMPORTER DECIDED, AND I DID NOT DIFFER.
//
//    This is the decision the task expected me to reconsider, and the argument
//    for differing is real: an operator who has spent five minutes mapping
//    columns loses the mapping as well as the upload, where an exact import
//    loses only a re-upload of a file they still have.
//
//    IT STILL DOES NOT WIN. Importing "as many as still fit" means a handler
//    spending less than its effect's count, which services/intake-plan.ts
//    exists to forbid -- and the forbidding is not bureaucracy: the alternative
//    is a preview that said 3,988 and an install that got 3,987, with no id
//    anywhere in a foreign file to reconcile the difference against. The exact
//    importer at least has the export's uuids; here there is nothing but the
//    spreadsheet and a person's memory. So the whole import rolls back and
//    ImportCsvChangedError says to take a fresh preview.
//
//    THE COST IS PAID ON THE PAGE RATHER THAN DENIED: a routes task should keep
//    the operator's mapping in front of them across a refused apply, because
//    nothing about the mapping became untrue -- only the counts did. That is
//    recorded here because this is where the decision was made, and the error's
//    own message says it.
//
// ================= WHAT 200,000 ROWS COST, MEASURED ======================
//
// On the deploy target (Debian 12, PostgreSQL 15.19, two cores, 3.8GB and no
// swap), a 14.1MB foreign CSV of 200,000 contacts written by Python's csv
// module -- five columns, three of them mapped to fields that are not arrays:
//
//   ingest + stage ......  0.05s   (nothing is unpacked; stageVerbatim)
//   mapping step ........  0.07s   5 columns, 50 records sampled
//   plan ................  2.58s   peak resident set 261MB
//   apply ............... 43.91s   PEAK resident set 280MB, 200,000 rows
//
// THE PEAK BARELY MOVED BETWEEN PLAN AND APPLY, and that 19MB is the number the
// batching exists to produce: what apply holds over the plan is one batch of
// rows and one statement's parameters, not one import. What is resident at all
// is the set of keys the FILE has used -- one lowercased address per row --
// which is the price of answering "is this a repeat of an earlier row?".
//
// THE MAPPING STEP IS INSTANT ON A 14MB FILE AND THAT IS THE POINT OF THE
// PREFIX: it reads one megabyte and stops, so the one stage a person waits in
// front of does not grow with the file. Its peak was not sampled, because the
// step never yields to the event loop long enough for the sampler to tick.
//
// APPLY IS TWICE THE EXACT IMPORTER'S 21.5s FOR THE SAME ROW COUNT, and the
// difference is named rather than hidden: at 200,000 rows this runs FOUR
// HUNDRED duplicate probes inside the transaction, one per batch, where the
// exact importer needs none at all because a PRIMARY KEY answers its question
// for free. It also writes two `text[]` columns per row. That is the price of
// matching on something other than a key, and it is what the operator is
// buying. The company-name resolution is NOT part of it: those queries are the
// plan's, and apply reads the frozen answers.
//
// ==================== ONE IMPORT WRITES ONE KIND OF ROW ===================
//
// COMPANIES OR CONTACTS, NEVER BOTH IN ONE PASS, and csvMappingProblem refuses
// a mapping that names fields of both. The tempting alternative is the shape an
// Outlook export actually has -- one row per person with the company's NAME in
// a column -- and creating the company from that name is what this refuses to
// do. A name is not a key (decision 2), so "Acme", "Acme Ltd" and "ACME" in one
// column become three companies, and no number in the preview could say that
// they should have been one. `contact.company_name` therefore LINKS to a
// company already here whose name matches exactly, ignoring case, and links to
// nothing when the name matches none or matches more than one. Both counts are
// findings, and the refusal message names the two-pass workflow.
//
// COMPANIES AND CONTACTS ARE ALSO THE ONLY CLOSURE AVAILABLE, which is the same
// finding services/import-export.ts reported from the other direction: every
// other table in this schema needs a `users` row, a pipeline, a stage, a
// fractional position or a set of line items, and a spreadsheet from another
// CRM has none of them.
//
// ======================= WHAT THIS DELIBERATELY DOES NOT DO ===============
//
// NO `events` ROWS, for services/import-export.ts's reason exactly: an import
// is a bulk load of history that happened somewhere else, `events_verb_valid`
// has no verb for one, and adding one is a migration. IF AN IMPORT SHOULD
// APPEAR ON A RECORD'S TIMELINE, THAT IS A MIGRATION AND IT IS CHRIS'S TO ASK
// FOR -- this task stops here rather than writing one.
//
// NO OWNER COLUMN, AND SINCE 7.7'S ROUTES TASK, AN OWNER. `owner_user_id` is a
// Conduit user's uuid and no foreign file has one, so it cannot be a column --
// which is what the paragraph here used to say, ending "letting the operator
// pick an owner for the whole import is a good affordance and it is a MAPPING
// CONTROL rather than a column, so it belongs to the routes task; nothing here
// forecloses it". The routes task took that up: @conduit/shared's
// CsvMapping.owner carries one id for the whole import, routes/import.ts proves
// it names a user before this module reads a byte, ResolvedCsvMapping FREEZES
// it onto the effect, and writeBatch is the only place it is applied. An import
// that does not use it still creates unowned rows, which is the default because
// it is the answer that cannot be wrong.
//
// NO WRITE GATE AND NO SAFETY BACKUP. Both belong to restore, on the spec's own
// rule: an import that goes wrong adds rows an operator can archive.
//
// NO CELL TRANSFORM IS REVERSED. services/csv.ts's escapeCellValue is Conduit's
// own convention, declared in its own manifest.json for its own importer to
// undo. A LEADING APOSTROPHE IN SOMEBODY ELSE'S FILE IS THEIR DATA, and
// stripping it because Conduit would have put one there is corruption with no
// way back. A Conduit export read through THIS importer therefore arrives with
// its apostrophes intact, which is correct for this pipeline and is one of the
// reasons the exact one exists.
//
// ONE MORE THING A CONDUIT EXPORT LOSES ON THIS PATH, recorded because it is
// surprising and is not this module's to fix: services/export.ts writes a
// nullable text column through `text()`, which maps BOTH null and the empty
// string to an empty cell. An empty cell here becomes NULL, so a company whose
// `domain` was genuinely "" comes back with a NULL domain. The export cannot
// tell the two apart, so neither can this.

/**
 * Every reason this importer refuses, as codes a test can assert without
 * matching prose.
 *
 * A REFUSAL IS A PLAN WITH NO EFFECTS -- see newPlan -- or, at the mapping
 * step, a CsvMappingView with no columns. Every one is reached with nothing
 * written.
 */
export const CSV_IMPORT_REFUSALS = {
  /** The upload is an archive, not a CSV. The mirror of the exact importer's. */
  notACsv: "not-a-csv",
  /** There is no header record: the file is empty, or it is entirely blank lines. */
  noHeader: "no-header",
  /** The header record names no columns at all. */
  noColumns: "no-columns",
  /** A record was longer than the reader will hold. See services/csv.ts. */
  recordTooLong: "record-too-long",
  /** csvMappingProblem said no. The message is its sentence, unaltered. */
  mappingInvalid: "mapping-invalid",
  /** Every row is bad, a duplicate, or the file has no rows. */
  nothingToImport: "nothing-to-import",
} as const;

/** Findings an import plan or a mapping step can carry. Never refusals. */
export const CSV_IMPORT_FINDINGS = {
  /** Which delimiter is in use, and whether it was guessed. */
  dialect: "csv-dialect",
  /** The header row is a sheet of Conduit's own export. */
  looksLikeExport: "looks-like-export",
  /** A column this reader could not guess a field for. Mapping step only. */
  headerUnrecognised: "header-unrecognised",
  /** A column the mapping does not use. Plan only. */
  columnUnmapped: "column-unmapped",
  /** Something the forgiving reader had to repair. */
  repaired: "csv-repaired",
  /** A record with fewer values than the header has columns. Padded, not skipped. */
  rowShort: "row-short",
  /** A record that will not be imported, and why. */
  rowSkipped: "row-skipped",
  /** A value that could not be stored and was left out of an imported row. */
  valueDropped: "value-dropped",
  /** A row whose key is already in this install. */
  duplicateHere: "duplicate-here",
  /** A row whose key repeats an earlier row of the same file. */
  duplicateInFile: "duplicate-in-file",
  /** Rows with no key, which cannot be matched against anything. */
  noKey: "no-duplicate-key",
  /** Contacts whose company name matched nothing, or matched more than one. */
  companyUnlinked: "company-unlinked",
  /**
   * Who the imported rows belong to: the owner chosen at the mapping step, or
   * nobody. ONE CODE FOR BOTH ANSWERS, so the preview always says which.
   */
  ownerUnknown: "owner-unknown",
} as const;

/**
 * The most findings of one code a plan or a mapping view will carry.
 *
 * THE SAME BOUND AND THE SAME REASON AS services/import-export.ts's, and here
 * it is load-bearing rather than defensive: THIS is the importer whose findings
 * repeat. One per bad row, one per unmapped column, one per duplicate, one per
 * dropped value, one per repair -- a 200,000-row spreadsheet of junk would
 * otherwise build a half-million-entry array, hold it for the plan's whole TTL
 * and render it into a page. Each repeating code emits at most this many worked
 * examples and then one summary line carrying the total.
 *
 * The page keys its findings list `${code}-${index}` because of exactly this --
 * see pages/settings-data.tsx, whose comment names `import-csv` as the kind
 * whose findings would break a list keyed on the code alone.
 */
export const MAX_FINDINGS_PER_CODE = 10;

/**
 * How many records the mapping step reads to build its samples.
 *
 * 50, AND IT IS A LATENCY BOUND RATHER THAN A STATISTICAL ONE. This step exists
 * so an operator sees their own column names quickly; counting the rows of a
 * 200,000-row file first would make the one fast stage the slow one. Fifty
 * records is enough for a person to recognise a column and enough for the
 * delimiter sniff to have a majority to count. The PLAN reads the whole file
 * and its numbers are the real ones -- CsvMappingView.sampled says so in the
 * value itself.
 */
export const MAPPING_SAMPLE_RECORDS = 50;

/** How many distinct values of one column the mapping step shows. */
export const MAPPING_SAMPLE_VALUES = 3;

/**
 * The bytes the mapping step reads before it stops.
 *
 * 1 MiB, WHICH IS A PREFIX AND NOT A FILE. Enough for a header and fifty
 * records of anything a person would recognise, and small enough that the
 * mapping step is instant on a 45MB sheet. It is also what makes the sniff
 * affordable: sniffCsvDelimiter parses this prefix once per candidate, four
 * times over at most, which is four megabytes of work rather than four passes
 * of the file.
 */
export const SAMPLE_PREFIX_BYTES = 1024 * 1024;

/**
 * The longest record the mapping step will read.
 *
 * 64 KiB, AND IT IS A STATEMENT ABOUT WHAT A HEADER ROW IS. Four thousand
 * columns of sixteen characters is not a spreadsheet anybody has; a first
 * record longer than this is an unterminated quote that has swallowed the file,
 * and there is no header in it to map.
 *
 * IT COULD NOT BE THE PREFIX ITSELF, and that is worth writing down because
 * that was the first version of this: the reader is handed AT MOST
 * SAMPLE_PREFIX_BYTES characters, so a bound equal to the prefix can never be
 * exceeded and the refusal it guards could never fire -- a defence that had
 * never been shown to fail, which this project has a rule about.
 *
 * A DATA record longer than this simply ends the sample early; the header is
 * already in hand by then, the operator can still map it, and the PLAN reads
 * the whole file with services/csv.ts's own bound.
 */
export const MAPPING_MAX_RECORD_CHARS = 64 * 1024;

/**
 * How many rows go into one INSERT, and one existence probe.
 *
 * 500, ON services/import-export.ts's arithmetic REDONE FOR THE COLUMNS THIS
 * IMPORTER ACTUALLY SUPPLIES. A foreign file cannot fill an id, a `custom`, an
 * `archived_at` or either timestamp, so drizzle writes `default` for those and
 * binds nothing: a contacts row here binds EIGHT parameters and a companies row
 * SIX, which puts 500 rows at 4,000 of the 65,535 a single statement may carry
 * -- room for every field a later version could add to this mapping.
 * IT IS ALSO THE UNIT OF THE DUPLICATE PROBE, and that is what keeps the
 * resident cost of an import one batch rather than one file: the keys already
 * in the install are asked for a batch at a time and then discarded, so the
 * only thing that grows with the file is the set of keys the FILE has used,
 * which cannot be avoided while "is this a repeat of an earlier row?" is a
 * question worth answering.
 */
export const IMPORT_BATCH_ROWS = 500;

/** contacts_salutation_length and contacts_pronouns_length, from their one source. */
const SALUTATION_MAX = CONTACT_FIELD_CAPS.salutation;
const PRONOUNS_MAX = CONTACT_FIELD_CAPS.pronouns;

/** `PK\x03\x04` and `7z\xBC\xAF\x27\x1C`: a zip and a 7z, by their first bytes. */
const ARCHIVE_MAGIC: readonly { bytes: readonly number[]; what: string }[] = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], what: "a ZIP archive" },
  { bytes: [0x50, 0x4b, 0x05, 0x06], what: "an empty ZIP archive" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], what: "a 7z archive" },
];

/**
 * The header rows Conduit's own export writes, so a note can say so.
 *
 * MATCHED IN FULL AND EXACTLY, never by a subset: "a file with an `id` column"
 * is half the spreadsheets in the world. These two lists are the ones
 * services/export.ts writes for its companies and contacts sheets, and a file
 * whose header is one of them, in order, IS that sheet -- at which point saying
 * "the exact importer reads this losslessly" is worth a sentence, because the
 * ids, the owners and the apostrophe transform are exactly what this pipeline
 * drops. import-csv.test.ts holds these two lists against the header rows of a
 * REAL export archive, so a column added to that sheet does not leave a claim
 * here that is quietly no longer true.
 */
export const EXPORT_SHEET_HEADERS: readonly (readonly string[])[] = [
  [
    "id", "name", "domain", "website", "phone", "address", "industry",
    "owner_user_id", "owner_username", "custom", "archived_at", "created_at", "updated_at",
  ],
  [
    "id", "first_name", "last_name", "salutation", "pronouns", "job_title",
    "company_id", "company_name", "emails", "phones",
    "owner_user_id", "owner_username", "custom", "archived_at", "created_at", "updated_at",
  ],
];

// --- guessing what a column is ---------------------------------------------

/**
 * Header spellings this recognises, by the field they mean.
 *
 * A GUESS AND NOTHING MORE. Every one of these is offered as
 * CsvColumnView.suggestion, the operator can overrule any of it, and nothing
 * downstream reads it -- planCsvImport takes the MAPPING and never the
 * suggestion, so a wrong guess costs one click and can never cost a column.
 * That is the whole reason this is allowed to be a table of strings rather than
 * something cleverer.
 *
 * COMPARED AFTER FOLDING: lowercased, with every run of characters that is not
 * a letter or a digit reduced to one space, then trimmed. So "E-mail Address",
 * "email_address" and "Email  address" are one spelling, and the table holds
 * the folded form. The spellings are what Outlook, Pipedrive, HubSpot and
 * Conduit's own export actually write.
 */
const HEADER_GUESSES: readonly (readonly [CsvImportField, readonly string[]])[] = [
  ["company.name", [
    "company", "company name", "organisation", "organization", "org name", "account",
    "account name", "business name", "name",
  ]],
  ["company.domain", ["domain", "website domain", "company domain", "email domain"]],
  ["company.website", ["website", "web site", "url", "web address", "homepage", "web"]],
  ["company.phone", ["company phone", "business phone", "main phone", "office phone", "phone"]],
  ["company.address", [
    "address", "company address", "business street", "street", "postal address",
  ]],
  ["company.industry", ["industry", "sector", "vertical", "category"]],
  ["contact.first_name", ["first name", "firstname", "given name", "forename", "voornaam"]],
  ["contact.last_name", ["last name", "lastname", "surname", "family name", "achternaam"]],
  ["contact.email", [
    "email", "e mail", "email address", "e mail address", "email 2 address",
    "e mail 2 address", "email 3 address", "e mail 3 address", "work email",
    "primary email", "mail",
  ]],
  ["contact.phone", [
    "phone", "phone number", "telephone", "mobile", "mobile phone", "cell phone",
    "home phone", "business phone", "business phone 2", "telefoon",
  ]],
  ["contact.job_title", ["job title", "title", "position", "role", "function"]],
  ["contact.salutation", ["salutation", "honorific", "prefix", "title prefix", "aanhef"]],
  ["contact.pronouns", ["pronouns", "preferred pronouns"]],
  ["contact.company_name", [
    "company", "company name", "organisation", "organization", "account", "account name",
  ]],
];

/**
 * The comparable form of a header: lowercase, punctuation reduced to spaces.
 *
 * Exported so import-csv.test.ts can assert the folding directly rather than
 * inferring it from a guess two layers away.
 */
export function foldHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * What Conduit would guess this column is, for one entity, or null.
 *
 * SCOPED TO AN ENTITY BECAUSE "Company" MEANS TWO DIFFERENT THINGS. In a sheet
 * of companies it is `company.name`; in a sheet of contacts it is the company
 * to link to. Nothing in the header can tell those apart, so the mapping step
 * guesses for the entity the file LOOKS like (see guessEntity) and the operator
 * changes it when the guess was wrong.
 */
export function guessField(header: string, entity: CsvImportEntity): CsvImportField | null {
  const folded = foldHeader(header);
  if (folded === "") return null;
  for (const [field, spellings] of HEADER_GUESSES) {
    if (csvImportField(field).entity !== entity) continue;
    if (spellings.includes(folded)) return field;
  }
  return null;
}

/**
 * Which entity this header row looks like a sheet of.
 *
 * A COUNT OF WHAT MATCHED EACH WAY, WITH CONTACTS BREAKING A TIE, and the
 * tie-break is not arbitrary: "first name" and "last name" only ever mean a
 * contact, so a file that matched both entities equally is one whose only
 * unambiguous evidence is on the contact side. A file matching nothing at all
 * is offered as contacts, which is what people import.
 *
 * IT DECIDES NOTHING. It picks which set of suggestions to show, and the
 * operator's mapping is what actually chooses the entity -- see
 * csvMappingEntity.
 */
export function guessEntity(headers: readonly string[]): CsvImportEntity {
  let companyScore = 0;
  let contactScore = 0;
  for (const header of headers) {
    if (guessField(header, "company") !== null) companyScore += 1;
    if (guessField(header, "contact") !== null) contactScore += 1;
  }
  return companyScore > contactScore ? "company" : "contact";
}

// --- inspect: the mapping step ---------------------------------------------

export interface InspectCsvOptions {
  /** The upload, as services/intake.ts landed it. */
  file: IntakeFile;
  /** The staged payload. stageVerbatim's, so exactly one member. */
  payload: StagedPayload;
  /** Overrules the sniff. Absent means "guess". */
  delimiter?: string;
}

/**
 * WHAT IS IN THIS FILE? -- the value the operator maps against.
 *
 * IT READS A BOUNDED PREFIX AND ABANDONS THE STREAM, which makes this module's
 * ORDINARY path a descriptor-abandoning one rather than only its refusal path.
 * The stream is destroyed in a `finally` -- a second net over Node's own
 * async-iterator cleanup rather than the thing that holds; see streamRows for
 * what the mutation round found about that. What proves the descriptor closes
 * is the bound in import-csv.test.ts, which counts them across the path that
 * finishes, the prefix this step abandons, a refusal mid-parse and an apply
 * that fails.
 *
 * IT ANSWERS NOTHING ABOUT WHAT WILL BE CREATED, deliberately -- no counts, no
 * duplicates, no skipped rows. None of them can be known before the mapping
 * exists, because the mapping is what says which cell is a name.
 */
export async function inspectCsv(options: InspectCsvOptions): Promise<CsvMappingView> {
  const { file, payload, delimiter: chosen } = options;
  const member = payload.members[0];
  const findings: CsvMappingFinding[] = [];
  const source = planSource(file, payload);
  const sniffed = chosen === undefined;

  const refuse = (refusal: CsvMappingRefusal): CsvMappingView => ({
    source,
    dialect: {
      delimiter: chosen ?? ",",
      delimiterName: delimiterName(chosen ?? ","),
      sniffed,
    },
    columns: [],
    targets: CSV_IMPORT_FIELDS,
    sampled: 0,
    findings,
    refusal,
  });

  if (member === undefined) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.noHeader,
      message: "there is nothing in this upload to read.",
    });
  }

  const prefix = await readPrefix(payload, member.ref, SAMPLE_PREFIX_BYTES);
  const archive = ARCHIVE_MAGIC.find(
    (magic) => magic.bytes.every((byte, at) => prefix[at] === byte),
  );
  if (archive !== undefined) {
    // THE ASYMMETRY GUARDED FROM THE THIRD SIDE. services/restore.ts refuses
    // anything that is not a backup; services/import-export.ts refuses anything
    // that is one; this refuses anything that is an archive at all, because the
    // Settings page has three controls that take a file and the spec's rule is
    // that nobody must reach for one when they meant another.
    return refuse({
      code: CSV_IMPORT_REFUSALS.notACsv,
      message: `this file is ${archive.what}, not a CSV. Conduit's own export is read back by `
        + "Import from a Conduit export, and a backup is applied through Restore.",
    });
  }

  const text = prefix.toString("utf8");
  const delimiter = chosen ?? sniffCsvDelimiter(text);
  const repairs: ForeignCsvRepair[] = [];
  let header: string[] | null = null;
  const samples: string[][] = [];
  let sampled = 0;
  try {
    // THE BOUND HERE IS THE MAPPING STEP'S OWN, NOT THE READER'S DEFAULT --
    // see MAPPING_MAX_RECORD_CHARS for why it is neither the default nor the
    // prefix size.
    for await (const record of foreignCsvRecords(sourceOf(text), {
      delimiter,
      maxRecordChars: MAPPING_MAX_RECORD_CHARS,
      onRepair: (repair) => {
        if (repairs.length < MAX_FINDINGS_PER_CODE) repairs.push(repair);
      },
    })) {
      if (header === null) { header = record.fields; continue; }
      samples.push(record.fields);
      sampled += 1;
      if (sampled >= MAPPING_SAMPLE_RECORDS) break;
    }
  } catch (error) {
    if (!(error instanceof CsvParseError)) throw error;
    // A HEADER ALREADY IN HAND IS WORTH MORE THAN A REFUSAL. If the damage is
    // in a data record, the columns are still known and the operator can still
    // map them -- the PLAN reads the whole file with the real bound and is
    // where an unreadable file is actually refused. Only a header this step
    // could not find at all makes the step impossible.
    if (header === null) {
      return refuse({ code: CSV_IMPORT_REFUSALS.recordTooLong, message: `${error.message}.` });
    }
  }

  if (header === null) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.noHeader,
      message: "this file has no header row. The first row has to name the columns.",
    });
  }
  const headers = header.map((name) => name.trim());
  if (headers.every((name) => name === "")) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.noColumns,
      message: "this file's first row names no columns, so there is nothing to map. The first "
        + "row has to be the column names.",
    });
  }

  findings.push({
    severity: "note",
    code: CSV_IMPORT_FINDINGS.dialect,
    message: sniffed
      ? `the columns look like they are separated by a ${delimiterName(delimiter)}. If that is `
        + "wrong, nothing below will make sense and the separator can be changed."
      : `the columns are read as separated by a ${delimiterName(delimiter)}, as chosen.`,
  });

  if (EXPORT_SHEET_HEADERS.some((sheet) => sameHeaders(sheet, headers))) {
    findings.push({
      severity: "warning",
      code: CSV_IMPORT_FINDINGS.looksLikeExport,
      message: "this is a sheet out of Conduit's own export. It can be imported here, but the "
        + "ids, the owners and Conduit's own cell escaping are lost -- Import from a Conduit "
        + "export reads the whole archive back instead.",
    });
  }

  const entity = guessEntity(headers);
  const columns: CsvColumnView[] = headers.map((name, index) => {
    const values: string[] = [];
    let filled = 0;
    for (const record of samples) {
      const value = (record[index] ?? "").trim();
      if (value === "") continue;
      filled += 1;
      if (values.length < MAPPING_SAMPLE_VALUES && !values.includes(value)) values.push(value);
    }
    return { index, header: name, samples: values, filled, suggestion: guessField(name, entity) };
  });

  // A HEADER ROW IT DOES NOT RECOGNISE, WHICH IS THE FIRST THING THE SPEC ASKS
  // THIS IMPORTER TO HANDLE. Handling it is not guessing harder: it is saying
  // WHICH columns were not recognised, showing what is in them, and leaving the
  // decision where it belongs. A file whose every header is unrecognised is
  // still perfectly importable -- the operator maps all of it by hand.
  const unrecognised = columns.filter((column) => column.suggestion === null);
  for (const column of unrecognised.slice(0, MAX_FINDINGS_PER_CODE)) {
    findings.push({
      severity: "note",
      code: CSV_IMPORT_FINDINGS.headerUnrecognised,
      message: `column ${String(column.index + 1)}, ${JSON.stringify(column.header)}, is not a `
        + "name Conduit recognises. Choose what it holds, or leave it out.",
    });
  }
  if (unrecognised.length > MAX_FINDINGS_PER_CODE) {
    findings.push({
      severity: "note",
      code: CSV_IMPORT_FINDINGS.headerUnrecognised,
      message: `${String(unrecognised.length)} columns in all were not recognised. Every one of `
        + "them can be mapped by hand.",
    });
  }
  for (const repair of repairs) {
    findings.push({
      severity: "warning",
      code: CSV_IMPORT_FINDINGS.repaired,
      message: `row ${String(repair.record)} of the part read for this preview is not written `
        + `the way a CSV normally is: ${repair.reason}. It was read anyway.`,
    });
  }

  return {
    source,
    dialect: { delimiter, delimiterName: delimiterName(delimiter), sniffed },
    columns,
    targets: CSV_IMPORT_FIELDS,
    sampled,
    findings,
    refusal: null,
  };
}

// --- the plan --------------------------------------------------------------

/**
 * A mapping, resolved against the file and frozen onto the effect.
 *
 * COLUMN INDEXES RATHER THAN NAMES, for the reason @conduit/shared's
 * import-mapping.ts gives: a foreign file can have two columns called "Email".
 * The arrays are in column order, which is what makes a contact's three email
 * columns arrive in the order the operator sees them on screen.
 */
export interface ResolvedCsvMapping {
  readonly entity: CsvImportEntity;
  readonly delimiter: string;
  /** field -> the column indexes mapped to it, ascending. */
  readonly columns: readonly (readonly [CsvImportField, readonly number[]])[];
  /**
   * The Conduit user every row created by this effect is owned by, or null.
   *
   * FROZEN ONTO THE EFFECT AT PLAN TIME, on `companyByName`'s argument exactly:
   * the operator read a preview that said who these rows would belong to, and
   * re-reading the request at apply would let that change after they agreed to
   * it. It is one uuid rather than a per-row value because it is a decision
   * about the import and not a column -- see @conduit/shared's CsvMapping.owner.
   *
   * NOT VALIDATED HERE. routes/import.ts proves the id names a user before it
   * calls this, which is earlier and cheaper than a refusal plan. What happens
   * if a caller drives this module directly with an id that names nobody is an
   * INSERT that violates the foreign key, inside the one transaction, which
   * rolls the whole import back -- an honest failure rather than a wrong row,
   * and it is written down rather than left to be discovered.
   */
  readonly owner: string | null;
}

interface CsvEffectBase extends PlannedEffect {
  readonly mapping: ResolvedCsvMapping;
}

export interface InsertCsvCompaniesEffect extends CsvEffectBase {
  readonly op: "insert-csv-companies";
}

export interface InsertCsvContactsEffect extends CsvEffectBase {
  readonly op: "insert-csv-contacts";
  /**
   * Lowercased company name -> the id of the ONE company with that name.
   *
   * FROZEN AT PLAN TIME RATHER THAN RESOLVED AGAIN AT APPLY, on the argument
   * services/import-export.ts's `knownOwners` makes: re-measuring would let a
   * company created while the operator read the preview change what the import
   * does, silently and after the fact. It is bounded by the number of DISTINCT
   * NAMES THE FILE NAMES THAT MATCHED EXACTLY ONE COMPANY, which is bounded by
   * the number of companies on the install -- not by the size of the file.
   */
  readonly companyByName: readonly (readonly [string, string])[];
}

export type CsvImportEffect = InsertCsvCompaniesEffect | InsertCsvContactsEffect;
export type CsvImportPlan = Plan<CsvImportEffect>;

/** What one effect hands the next: the transaction, and nothing else. */
export interface CsvImportCarrier {
  readonly tx: Database;
}

/**
 * The import landed a different number of rows from the one the preview
 * published.
 *
 * SEPARATE FROM PlanExceededError FOR services/import-export.ts's REASON: the
 * frame's error means a STEP did something its plan did not describe, which is
 * a bug in this file, and the ordinary cause here is not -- it is a row that
 * became a duplicate, or stopped being one, while the operator read the
 * preview. The message says so, says what to do, and says the one thing that is
 * specific to this pipeline: the mapping did not become wrong.
 */
export class ImportCsvChangedError extends Error {
  constructor(
    readonly subject: string,
    readonly planned: number,
    readonly inserted: number,
  ) {
    super(
      `the preview said ${String(planned)} ${subject} would be created and `
      + `${String(inserted)} were, because this install changed while the preview was open. `
      + "Nothing has been imported, and the column mapping is unaffected. Take a fresh preview "
      + "of the same file.",
    );
    this.name = "ImportCsvChangedError";
  }
}

export interface PlanCsvImportOptions {
  file: IntakeFile;
  payload: StagedPayload;
  /** The live database the rows would be added to. */
  db: Database;
  /** What the operator decided at the mapping step. */
  mapping: CsvMapping;
  /**
   * The user every imported row is owned by, ALREADY PROVED TO EXIST, or null.
   *
   * TWO FIELDS RATHER THAN AN ID, and the label is what makes the finding worth
   * reading: "every row is assigned to sam" is a sentence an operator checks,
   * and "every row is assigned to 0f3c..." is one they scroll past. The caller
   * has the username in hand because it had to look the row up to validate the
   * id at all, so this costs nothing and is not a second query.
   */
  owner?: { readonly id: string; readonly label: string } | null;
  now?: Date;
}

/**
 * WHAT WILL THIS MAPPING CREATE? -- validate before mutate, and produce a value
 * either way.
 *
 * IT READS THE WHOLE FILE, ONCE, and everything the preview says comes out of
 * that pass: the rows that will be created, the rows that will not and why,
 * which of them are already here, which repeat each other, and every value that
 * had to be dropped. Nothing is written; there is no transaction to leave half
 * open, and every refusal below is reached with the database untouched.
 *
 * WHAT IT HOLDS IS ONE SET OF KEYS AND NOTHING ELSE. The rows themselves are
 * not kept -- apply reads the file again -- so the resident cost is one
 * lowercased email or domain per row that has one, which is the price of being
 * able to answer "is this a repeat of an earlier row?" at all.
 */
export async function planCsvImport(options: PlanCsvImportOptions): Promise<CsvImportPlan> {
  const { file, payload, db, mapping, owner = null, now = new Date() } = options;
  const findings: PlanFindingView[] = [];
  const member = payload.members[0];

  const refuse = (refusal: PlanRefusalView): CsvImportPlan => newPlan<CsvImportEffect>({
    kind: "import-csv",
    source: planSource(file, payload),
    refusal,
    findings,
    now,
  });

  if (member === undefined) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.noHeader,
      message: "there is nothing in this upload to read.",
    });
  }

  const prefix = (await readPrefix(payload, member.ref, SAMPLE_PREFIX_BYTES)).toString("utf8");
  const delimiter = mapping.delimiter ?? sniffCsvDelimiter(prefix);
  const header = await firstRecord(prefix, delimiter);
  if (header === null) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.noHeader,
      message: "this file has no header row. The first row has to name the columns.",
    });
  }

  // THE COUNT IS THIS FILE'S OWN HEADER AND IS NOT A PARAMETER. An earlier
  // version took one, on the theory that a route holding the mapping step's
  // count could catch a mapping built against a different upload -- and it
  // could not: both steps read the header of the SAME staged payload, so the
  // only honest count is the one read here, and a caller passing its own would
  // only be able to make this check weaker.
  const problem = csvMappingProblem(mapping, header.length);
  if (problem !== null) {
    // csvMappingProblem's SENTENCE, UNALTERED. The page disabled its own
    // control on this same function; a mapping that arrived anyway is refused
    // with the words the operator would already have seen, rather than with a
    // second phrasing of the same rule.
    return refuse({ code: CSV_IMPORT_REFUSALS.mappingInvalid, message: problem });
  }
  const entity = csvMappingEntity(mapping);
  // Unreachable: csvMappingProblem refuses a mapping with no single entity and
  // has just returned null. Thrown rather than defaulted, because a default
  // here would import the wrong kind of row.
  if (entity === null) throw new Error("a mapping with no single entity passed csvMappingProblem");

  const resolved = resolveMapping(mapping, entity, delimiter, owner?.id ?? null);
  findings.push({
    severity: "note",
    code: CSV_IMPORT_FINDINGS.dialect,
    message: `the columns are read as separated by a ${delimiterName(delimiter)}.`,
  });

  const mappedColumns = new Set(resolved.columns.flatMap(([, at]) => [...at]));
  const unmapped = header
    .map((name, index) => ({ name: name.trim(), index }))
    .filter(({ index }) => !mappedColumns.has(index));
  pushCapped(
    findings, "note", CSV_IMPORT_FINDINGS.columnUnmapped,
    unmapped.slice(0, MAX_FINDINGS_PER_CODE), unmapped.length,
    (column) => `column ${String(column.index + 1)}, ${JSON.stringify(column.name)}, is not `
      + "mapped to anything and is not imported.",
    (total) => `${String(total)} columns in all are not mapped and are not imported.`,
  );

  let scan: SheetScan;
  try {
    scan = await scanSheet(payload, member.ref, resolved, db);
  } catch (error) {
    if (!(error instanceof CsvParseError)) throw error;
    return refuse({ code: CSV_IMPORT_REFUSALS.recordTooLong, message: `${error.message}.` });
  }

  pushCapped(
    findings, "warning", CSV_IMPORT_FINDINGS.repaired, scan.repairs, scan.repairCount,
    (repair) => `row ${String(repair.record)} is not written the way a CSV normally is: `
      + `${repair.reason}. It was read anyway.`,
    (total) => `${String(total)} rows in all needed repairs like those above to be read.`,
  );
  pushCapped(
    findings, "warning", CSV_IMPORT_FINDINGS.rowShort, scan.short, scan.shortCount,
    (note) => `row ${String(note.record)} ${note.reason}. Its remaining columns are imported `
      + "and the missing ones are left empty.",
    (total) => `${String(total)} rows in all have fewer values than the header has columns; the `
      + "missing ones are left empty.",
  );
  pushCapped(
    findings, "warning", CSV_IMPORT_FINDINGS.rowSkipped, scan.skipped, scan.skippedCount,
    (note) => `row ${String(note.record)} is not imported because ${note.reason}.`,
    (total) => `${String(total)} rows in all are not imported, for reasons like those above.`,
  );
  pushCapped(
    findings, "warning", CSV_IMPORT_FINDINGS.valueDropped, scan.dropped, scan.droppedCount,
    (note) => `row ${String(note.record)} is imported without one value: ${note.reason}.`,
    (total) => `${String(total)} values in all are left empty on rows that are otherwise `
      + "imported.",
  );
  pushCapped(
    findings, "note", CSV_IMPORT_FINDINGS.duplicateHere, scan.here, scan.hereCount,
    (note) => `row ${String(note.record)} is already in this install (${note.reason}) and is `
      + "left exactly as it is; the import does not change it.",
    (total) => `${String(total)} rows in all are already in this install and are left exactly `
      + "as they are.",
  );
  pushCapped(
    findings, "warning", CSV_IMPORT_FINDINGS.duplicateInFile, scan.repeats, scan.repeatCount,
    (note) => `row ${String(note.record)} repeats an earlier row of this file `
      + `(${note.reason}) and is imported only once.`,
    (total) => `${String(total)} rows in all repeat an earlier row of this file and are `
      + "imported only once.",
  );
  if (scan.noKey > 0) {
    const what = entity === "contact" ? "email address" : "domain";
    findings.push({
      severity: "warning",
      code: CSV_IMPORT_FINDINGS.noKey,
      message: `${String(scan.noKey)} of the rows being created have no ${what}, which is what `
        + "duplicates are matched on. They are created whatever is already here, and importing "
        + "this file twice would create them twice.",
    });
  }
  if (scan.willInsert > 0) {
    // THE FINDING SAYS WHAT WILL BE TRUE OF THE ROWS, WHICHEVER WAY IT WENT.
    // Emitting it only for the unowned case was the first version and it was
    // wrong in the direction that matters: an operator who picked the wrong
    // name in the picker would have had NOTHING in the preview to check it
    // against, and "no owner" is exactly the state they were trying to avoid.
    // One code, two sentences, and the preview always answers the question.
    findings.push(owner === null
      ? {
        severity: "note",
        code: CSV_IMPORT_FINDINGS.ownerUnknown,
        message: "imported rows arrive with no owner. A spreadsheet has no Conduit user in "
          + "it, so nothing in the file can say who these belong to -- choose an owner at "
          + "the mapping step if they should all belong to somebody.",
      }
      : {
        severity: "note",
        code: CSV_IMPORT_FINDINGS.ownerUnknown,
        message: `every row created by this import is owned by ${owner.label}. That is the `
          + "one owner chosen at the mapping step, not anything read out of the file: a "
          + "spreadsheet has no Conduit user in it.",
      });
  }

  if (scan.willInsert === 0) {
    return refuse({
      code: CSV_IMPORT_REFUSALS.nothingToImport,
      message: `there is nothing in this file to add. Of its ${String(scan.records)} rows, `
        + "every one is either already here, a repeat of another row, or one this mapping "
        + "cannot read -- the notes below say which. Nothing has been changed.",
    });
  }

  const effects: CsvImportEffect[] = [];
  if (entity === "company") {
    effects.push({
      op: "insert-csv-companies",
      subject: "companies",
      count: scan.willInsert,
      unit: "row",
      destroys: false,
      detail: `${String(scan.willInsert)} companies are created from this file. Nothing already `
        + "here is changed.",
      sources: [member.ref],
      mapping: resolved,
    });
  } else {
    const unlinked = scan.companyMisses + scan.companyAmbiguous;
    if (unlinked > 0) {
      findings.push({
        severity: "warning",
        code: CSV_IMPORT_FINDINGS.companyUnlinked,
        message: `${String(unlinked)} of the contacts being created name a company this install `
          + `cannot match: ${String(scan.companyMisses)} name no company that is here, and `
          + `${String(scan.companyAmbiguous)} name one that more than one company answers to. `
          + "Those contacts arrive with no company. A contact import never creates a company; "
          + "import the companies first and this file again.",
      });
    }
    effects.push({
      op: "insert-csv-contacts",
      subject: "contacts",
      count: scan.willInsert,
      unit: "row",
      destroys: false,
      detail: scan.companyHits > 0
        ? `${String(scan.willInsert)} contacts are created from this file, `
          + `${String(scan.companyHits)} of them linked to a company already here by name. `
          + "Nothing already here is changed."
        : `${String(scan.willInsert)} contacts are created from this file. Nothing already here `
          + "is changed.",
      sources: [member.ref],
      mapping: resolved,
      companyByName: Object.freeze([...scan.companyByName].map(
        ([name, id]) => Object.freeze([name, id]) as readonly [string, string],
      )),
    });
  }

  return newPlan<CsvImportEffect>({
    kind: "import-csv",
    source: planSource(file, payload),
    effects,
    findings,
    now,
  });
}

// --- apply -----------------------------------------------------------------

export interface ApplyCsvImportOptions {
  plan: CsvImportPlan;
  payload: StagedPayload;
  db: Database;
}

/**
 * CREATE THE ROWS, IN ONE TRANSACTION, AND NOTHING THE PLAN DID NOT DESCRIBE.
 *
 * THE TRANSACTION IS OPENED HERE AND NOT BY THE FRAME, which is
 * services/intake-plan.ts's own decision: "apply runs in one transaction" is
 * the spine's rule, but the unit differs between the three pipelines. Any throw
 * -- a handler's, the frame's accounting, a constraint -- leaves through this
 * call and rolls the whole import back, which is the half of decision 1 that
 * lives after the operator says yes.
 *
 * THE DUPLICATE PROBE RUNS INSIDE THE TRANSACTION AND IS NOT FROZEN ON THE
 * PLAN, and that is a difference from `companyByName` rather than an
 * inconsistency with it. Freezing the keys already present would mean inserting
 * a row that BECAME a duplicate while the operator read the preview -- creating
 * exactly the duplicate this importer exists to avoid, with the count matching
 * so that nothing complained. Re-probing means the COUNT moves instead, and a
 * count that moves is what ImportCsvChangedError is for.
 */
export async function applyCsvImport(options: ApplyCsvImportOptions): Promise<ApplyOutcome> {
  const { plan, payload, db } = options;
  return await db.transaction(async (tx) => {
    const handlers: EffectHandlers<CsvImportEffect, CsvImportCarrier> = {
      "insert-csv-companies": async (effect, ctx) => { await insertRows(effect, ctx); },
      "insert-csv-contacts": async (effect, ctx) => { await insertRows(effect, ctx); },
    };
    return await applyPlan<CsvImportEffect, CsvImportCarrier>({
      plan, reader: payload, handlers, carrier: { tx },
    });
  });
}

/**
 * The body both insert steps share: read the file this effect names, decide
 * every row exactly as the plan did, write what is left, and account.
 *
 * TWO LAYERS GUARD THE COUNT, AND THE OUTER ONE IS HERE BECAUSE THE FRAME'S
 * NAMES THE WRONG CULPRIT -- services/import-export.ts's argument, unchanged:
 * PlanExceededError means "a step did something its plan did not describe",
 * which is a bug in this file, and the ordinary cause of a mismatch is a
 * database that moved. So the comparison is made first and answered with
 * ImportCsvChangedError. Deleting it does not make either direction pass; it
 * makes both arrive as the wrong error, and there is a test for each direction
 * and one that shows which layer fired.
 *
 * THE ACCOUNTING IS SPENT ONCE, AT THE END, for the same reason: everything
 * here is inside one transaction, so a batch that overshot has written nothing
 * durable, and spending per batch would let the frame's error fire first on the
 * over-count path -- telling the operator their importer is broken when their
 * database merely moved.
 */
async function insertRows(
  effect: CsvImportEffect, ctx: ApplyContext<CsvImportCarrier>,
): Promise<void> {
  const source = effect.sources?.[0];
  if (source === undefined) {
    throw new Error(`the ${effect.op} step has no file to read`);
  }
  const stream = await ctx.open(source);
  const batch: BuiltRow[] = [];
  let inserted = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    inserted += await writeBatch(
      ctx.carrier.tx, effect.op, batch.splice(0, batch.length), effect.mapping.owner,
    );
  };

  await streamRows({
    stream,
    mapping: effect.mapping,
    db: ctx.carrier.tx,
    // THE LINKS ARE THE PLAN'S AND ARE NOT LOOKED UP AGAIN. `resolveLinks:
    // false` is what makes this a use of a frozen decision rather than a second
    // measurement -- see InsertCsvContactsEffect.companyByName.
    companyByName: effect.op === "insert-csv-contacts"
      ? new Map(effect.companyByName)
      : new Map<string, string>(),
    resolveLinks: false,
    onRow: async (row) => {
      batch.push(row);
      if (batch.length >= IMPORT_BATCH_ROWS) await flush();
    },
  });
  await flush();

  if (inserted !== effect.count) {
    throw new ImportCsvChangedError(effect.subject, effect.count, inserted);
  }
  ctx.spend(inserted);
}

/** One batch of rows, written. Returns how many landed. */
async function writeBatch(
  tx: Database, op: CsvImportEffect["op"], rows: readonly BuiltRow[], owner: string | null,
): Promise<number> {
  // THE OWNER IS APPLIED HERE AND NOT IN buildRow, and that is the whole reason
  // adding it cost one argument rather than a second pass over decision 1.
  // buildRow's subject is "what does this ROW say", and the owner is the same
  // for every row in the import -- it came from the mapping step and not from
  // any cell. Threading it through buildRow would have made a per-row function
  // depend on a value no row can carry, and would have put the plan's frozen
  // answer inside the function that has to give the SAME answer at plan time
  // and at apply time over the same bytes.
  if (op === "insert-csv-companies") {
    const values = rows
      .map((row) => (row.company === null ? null : { ...row.company, ownerUserId: owner }))
      .filter((row) => row !== null);
    if (values.length === 0) return 0;
    return (await tx.insert(companies).values(values).returning({ id: companies.id })).length;
  }
  const values = rows
    .map((row) => (row.contact === null
      ? null
      : { ...row.contact, companyId: row.companyId, ownerUserId: owner }))
    .filter((row) => row !== null);
  if (values.length === 0) return 0;
  return (await tx.insert(contacts).values(values).returning({ id: contacts.id })).length;
}

// --- reading a row ---------------------------------------------------------

/** A companies row, exactly as it will be inserted. */
interface CompanyValues {
  name: string;
  domain: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  industry: string | null;
}

/** A contacts row, exactly as it will be inserted but for the company link. */
interface ContactValues {
  firstName: string;
  lastName: string | null;
  jobTitle: string | null;
  salutation: string | null;
  pronouns: string | null;
  emails: string[];
  phones: string[];
}

/** A row this importer will create. Exactly one of the two payloads is set. */
interface BuiltRow {
  readonly record: number;
  readonly company: CompanyValues | null;
  readonly contact: ContactValues | null;
  /** The duplicate keys this row claims, lowercased. Empty when it has none. */
  readonly keys: readonly string[];
  /** The lowercased company name this row asked to be linked to, or "". */
  readonly companyName: string;
  /** Filled in once the batch has been settled against the database. */
  companyId: string | null;
  /** How the company link turned out. "none" when the row asked for none. */
  link: "none" | "hit" | "miss" | "ambiguous";
}

/** A record that could not be imported whole, and the reason a person reads. */
interface RowNote {
  readonly record: number;
  readonly reason: string;
}

/** Everything reading the file once answers. */
interface SheetScan {
  readonly records: number;
  readonly willInsert: number;
  readonly noKey: number;
  readonly short: RowNote[];
  readonly shortCount: number;
  readonly skipped: RowNote[];
  readonly skippedCount: number;
  readonly dropped: RowNote[];
  readonly droppedCount: number;
  readonly here: RowNote[];
  readonly hereCount: number;
  readonly repeats: RowNote[];
  readonly repeatCount: number;
  readonly repairs: ForeignCsvRepair[];
  readonly repairCount: number;
  readonly companyByName: Map<string, string>;
  readonly companyHits: number;
  readonly companyMisses: number;
  readonly companyAmbiguous: number;
}

/**
 * READ THE WHOLE FILE AND DECIDE EVERY ROW.
 *
 * THIS IS WHY DECISION 1 HOLDS. Its per-row half -- streamRows and buildRow --
 * runs again unchanged at apply, over the same bytes with the same mapping. Two
 * implementations of "is this row importable" would be two answers, and the
 * difference would surface as a constraint violation in the middle of a
 * transaction rather than as a finding in a preview.
 */
async function scanSheet(
  payload: StagedPayload,
  ref: StagedMemberRef,
  mapping: ResolvedCsvMapping,
  db: Database,
): Promise<SheetScan> {
  const short: RowNote[] = [];
  const skipped: RowNote[] = [];
  const dropped: RowNote[] = [];
  const here: RowNote[] = [];
  const repeats: RowNote[] = [];
  const repairs: ForeignCsvRepair[] = [];
  const companyByName = new Map<string, string>();
  let records = 0;
  let willInsert = 0;
  let noKey = 0;
  let shortCount = 0;
  let skippedCount = 0;
  let droppedCount = 0;
  let hereCount = 0;
  let repeatCount = 0;
  let repairCount = 0;
  let companyHits = 0;
  let companyMisses = 0;
  let companyAmbiguous = 0;

  /** Hold at most MAX_FINDINGS_PER_CODE examples; count all of them. */
  const keep = <T>(into: T[], value: T): void => {
    if (into.length < MAX_FINDINGS_PER_CODE) into.push(value);
  };

  const stream = await payload.open(ref);
  await streamRows({
    stream,
    mapping,
    db,
    companyByName,
    resolveLinks: true,
    onRepair: (repair) => { repairCount += 1; keep(repairs, repair); },
    onRecord: () => { records += 1; },
    onShort: (note) => { shortCount += 1; keep(short, note); },
    onSkip: (note) => { skippedCount += 1; keep(skipped, note); },
    onDrop: (note) => { droppedCount += 1; keep(dropped, note); },
    onHere: (note) => { hereCount += 1; keep(here, note); },
    onRepeat: (note) => { repeatCount += 1; keep(repeats, note); },
    // NOTHING IS KEPT. The plan holds counts and capped examples; the rows
    // themselves are read again at apply, which is what makes a 200,000-row
    // file's plan the same size as a six-row one's.
    onRow: (row) => {
      willInsert += 1;
      if (row.keys.length === 0) noKey += 1;
      if (row.link === "hit") companyHits += 1;
      else if (row.link === "miss") companyMisses += 1;
      else if (row.link === "ambiguous") companyAmbiguous += 1;
    },
  });

  return {
    records, willInsert, noKey,
    short, shortCount, skipped, skippedCount, dropped, droppedCount,
    here, hereCount, repeats, repeatCount, repairs, repairCount,
    companyByName, companyHits, companyMisses, companyAmbiguous,
  };
}

interface StreamRowsInput {
  stream: Readable;
  mapping: ResolvedCsvMapping;
  db: Database;
  /**
   * Lowercased company name -> id. FILLED at plan time (`resolveLinks: true`)
   * and READ at apply time (`false`), which is what makes the link a frozen
   * decision rather than a second measurement.
   */
  companyByName: Map<string, string>;
  resolveLinks: boolean;
  onRepair?: (repair: ForeignCsvRepair) => void;
  onRecord?: () => void;
  onShort?: (note: RowNote) => void;
  onSkip?: (note: RowNote) => void;
  onDrop?: (note: RowNote) => void;
  onHere?: (note: RowNote) => void;
  onRepeat?: (note: RowNote) => void;
  onRow: (row: BuiltRow) => Promise<void> | void;
}

/**
 * THE ONE PASS BOTH PLAN AND APPLY MAKE OVER THE FILE.
 *
 * Every decision about a row is taken here, once, from the bytes: what it
 * holds, whether it can be stored, whether its key repeats an earlier row of
 * this file, and whether its key is already in the install. The plan counts the
 * answers; apply writes them. Neither has a rule of its own.
 *
 * THE STREAM IS DESTROYED IN A `finally`, AND THAT IS A SECOND NET RATHER THAN
 * THE THING THAT HOLDS -- said plainly because the mutation round measured it.
 * Deleting this `finally` KILLS NOTHING: `for await` calls `.return()` on the
 * generator when the loop is left early or throws, the generator's own
 * `for await` passes that on, and Node destroys the stream. What actually
 * proves the descriptor closes is the bound in import-csv.test.ts, which an
 * extra unread `payload.open()` turns red. The line is kept anyway: this module
 * abandons a stream on its ORDINARY path -- the mapping step reads a prefix --
 * the file is inside a credential store, and a runtime behaviour nobody here
 * chose is not something to depend on when the alternative costs one call.
 *
 * BATCHING IS WHY THE PROBE DOES NOT GROW WITH THE FILE. Rows are collected
 * IMPORT_BATCH_ROWS at a time; the batch's keys are asked about in one query
 * and then discarded. What is held for the whole pass is the set of keys the
 * FILE has used, which cannot be avoided while in-file duplicates are a
 * question worth answering, and which is one short string per row.
 *
 * AT APPLY, ROWS WRITTEN BY AN EARLIER BATCH ARE VISIBLE TO THE PROBE AND CAN
 * NEVER BE FOUND BY IT: a key an earlier batch used is in `seen`, which is
 * checked BEFORE the probe. So plan and apply ask the same question of the same
 * committed state and get the same answer, which is what lets the two counts be
 * compared at all.
 */
async function streamRows(input: StreamRowsInput): Promise<void> {
  const { stream, mapping, db, companyByName, resolveLinks } = input;
  const byField = new Map<CsvImportField, readonly number[]>(
    mapping.columns.map(([field, at]) => [field, at]),
  );
  const seen = new Set<string>();
  const pending: BuiltRow[] = [];
  /** Names already asked about, so an absent one is not asked about again. */
  const asked = new Set<string>();
  /**
   * Names more than one company answers to.
   *
   * HELD APART FROM `companyByName`, WHOSE ENTRIES ARE WHAT THE EFFECT FREEZES.
   * An ambiguous name has no id to freeze and must not be confused with one
   * that simply is not on this install: the operator fixes those two
   * differently, so the preview counts them separately.
   */
  const ambiguousNames = new Set<string>();
  let header: string[] | null = null;

  /**
   * Decide a batch against the database, then hand the survivors on.
   *
   * ONE QUERY PER BATCH FOR THE KEYS, AND ONE FOR THE COMPANY NAMES. A row
   * reaches here only once its in-file check has passed, so a key an earlier
   * row of this file already claimed is never asked about.
   */
  const settle = async (): Promise<void> => {
    if (pending.length === 0) return;
    const present = await existingKeys(db, mapping.entity, [
      ...new Set(pending.flatMap((row) => row.keys)),
    ]);
    if (resolveLinks) {
      const names = [...new Set(
        pending.map((row) => row.companyName).filter((name) => name !== "" && !asked.has(name)),
      )];
      const ambiguous = await resolveCompanies(db, names, companyByName);
      for (const name of names) asked.add(name);
      for (const name of ambiguous) ambiguousNames.add(name);
    }
    for (const row of pending) {
      const hit = row.keys.find((key) => present.has(key));
      if (hit !== undefined) {
        input.onHere?.({ record: row.record, reason: describeKey(mapping.entity, hit) });
        continue;
      }
      if (row.companyName !== "") {
        row.companyId = companyByName.get(row.companyName) ?? null;
        row.link = row.companyId !== null
          ? "hit"
          : ambiguousNames.has(row.companyName) ? "ambiguous" : "miss";
      }
      await input.onRow(row);
    }
    pending.length = 0;
  };

  try {
    for await (const record of foreignCsvRecords(stream, {
      delimiter: mapping.delimiter,
      onRepair: (repair) => { input.onRepair?.(repair); },
    })) {
      if (header === null) { header = record.fields; continue; }
      input.onRecord?.();
      const built = buildRow(record.record, record.fields, header.length, mapping, byField, {
        onDrop: input.onDrop, onShort: input.onShort,
      });
      if ("reason" in built) {
        input.onSkip?.({ record: record.record, reason: built.reason });
        continue;
      }
      const repeat = built.row.keys.find((key) => seen.has(key));
      if (repeat !== undefined) {
        input.onRepeat?.({ record: record.record, reason: describeKey(mapping.entity, repeat) });
        continue;
      }
      for (const key of built.row.keys) seen.add(key);
      pending.push(built.row);
      if (pending.length >= IMPORT_BATCH_ROWS) await settle();
    }
    await settle();
  } finally {
    // A no-op on a stream that ran to its end, and a SECOND NET on one that did
    // not -- see this function's header for what the mutation round found.
    stream.destroy();
  }
}

/** A row, or the reason there is not one. */
type Built = { row: BuiltRow } | { reason: string };

/**
 * ONE ROW, OR WHY THERE IS NOT ONE.
 *
 * THE SAME FUNCTION RUNS AT PLAN AND AT APPLY, which is the only reason the two
 * can agree -- see this module's decision 1. Every rule it applies is one the
 * database would otherwise apply in the middle of a transaction:
 *
 *   - `name` and `first_name` are NOT NULL and the create schemas require them
 *     non-empty; an empty one SKIPS THE ROW, because a row with no name is not
 *     a record of anything.
 *   - unstorableText is Postgres' own refusal (`22021 invalid byte sequence`),
 *     which has no CHECK to name it; a required value carrying one skips the
 *     row, an optional one is dropped.
 *   - contactEmailSchema is the rule db/schema.ts says the input schemas own;
 *     an address that fails it is DROPPED and the person is kept.
 *   - contacts_salutation_length and contacts_pronouns_length are 64 each; a
 *     longer value is dropped rather than truncated, because a truncation is a
 *     value the operator never wrote.
 */
function buildRow(
  record: number,
  fields: readonly string[],
  headerLength: number,
  mapping: ResolvedCsvMapping,
  byField: ReadonlyMap<CsvImportField, readonly number[]>,
  notes: { onDrop?: (note: RowNote) => void; onShort?: (note: RowNote) => void },
): Built {
  // A RECORD WITH MORE VALUES THAN COLUMNS IS SKIPPED AND A SHORTER ONE IS
  // PADDED. See this module's decision 1: the ordinary cause of an extra value
  // is a delimiter inside an unquoted value, which shifts every column after
  // it; the ordinary cause of a missing one is an exporter that did not write a
  // trailing empty, which shifts nothing.
  if (fields.length > headerLength) {
    return {
      reason: `it has ${String(fields.length)} values where the header has `
        + `${String(headerLength)} columns, so its values cannot be lined up with them`,
    };
  }
  if (fields.length < headerLength) {
    notes.onShort?.({
      record,
      reason: `has ${String(fields.length)} values where the header has `
        + `${String(headerLength)} columns`,
    });
  }

  const at = (field: CsvImportField): string[] =>
    (byField.get(field) ?? []).map((index) => (fields[index] ?? "").trim());
  const one = (field: CsvImportField): string => at(field)[0] ?? "";
  const drop = (reason: string): void => { notes.onDrop?.({ record, reason }); };

  /** An optional single value: empty, unstorable or over-long becomes null. */
  const optional = (field: CsvImportField, max?: number): string | null => {
    const value = one(field);
    if (value === "") return null;
    const label = csvImportField(field).label;
    if (unstorableText(value)) {
      drop(`its ${label} holds a character that cannot be stored`);
      return null;
    }
    if (max !== undefined && value.length > max) {
      drop(`its ${label} is longer than ${String(max)} characters`);
      return null;
    }
    return value;
  };

  /** A required single value: empty or unstorable skips the row. */
  const required = (field: CsvImportField): string | { reason: string } => {
    const value = one(field);
    const label = csvImportField(field).label.toLowerCase();
    if (value === "") return { reason: `it has no ${label}` };
    if (unstorableText(value)) {
      return { reason: `its ${label} holds a character that cannot be stored` };
    }
    return value;
  };

  if (mapping.entity === "company") {
    const name = required("company.name");
    if (typeof name !== "string") return name;
    const domain = optional("company.domain");
    return {
      row: {
        record,
        company: {
          name,
          domain,
          website: optional("company.website"),
          phone: optional("company.phone"),
          address: optional("company.address"),
          industry: optional("company.industry"),
        },
        contact: null,
        keys: domain === null ? [] : [domain.toLowerCase()],
        companyName: "",
        companyId: null,
        link: "none",
      },
    };
  }

  const firstName = required("contact.first_name");
  if (typeof firstName !== "string") return firstName;

  const emails: string[] = [];
  for (const value of at("contact.email")) {
    if (value === "") continue;
    if (unstorableText(value)) {
      drop(`the email address ${JSON.stringify(value)} holds a character that cannot be stored`);
      continue;
    }
    if (!contactEmailSchema.safeParse(value).success) {
      drop(`${JSON.stringify(value)} is not an email address, so it is left out`);
      continue;
    }
    // THE SECOND SPELLING OF ONE ADDRESS IS NOT A SECOND ADDRESS. Folded for
    // the comparison and stored as typed, which is the same split the duplicate
    // key makes.
    if (emails.some((held) => held.toLowerCase() === value.toLowerCase())) continue;
    emails.push(value);
  }
  const phones: string[] = [];
  for (const value of at("contact.phone")) {
    if (value === "") continue;
    if (unstorableText(value)) {
      drop(`the phone number ${JSON.stringify(value)} holds a character that cannot be stored`);
      continue;
    }
    if (!phones.includes(value)) phones.push(value);
  }

  const companyName = one("contact.company_name");
  return {
    row: {
      record,
      company: null,
      contact: {
        firstName,
        lastName: optional("contact.last_name"),
        jobTitle: optional("contact.job_title"),
        salutation: optional("contact.salutation", SALUTATION_MAX),
        pronouns: optional("contact.pronouns", PRONOUNS_MAX),
        emails,
        phones,
      },
      keys: emails.map((email) => email.toLowerCase()),
      // A company name that cannot be stored cannot match one that is stored,
      // so it asks for no link rather than for a link to nothing.
      companyName: unstorableText(companyName) ? "" : companyName.toLowerCase(),
      companyId: null,
      link: "none",
    },
  };
}

// --- asking the database ---------------------------------------------------

/**
 * Which of these keys this install already holds.
 *
 * `lower(...)` IN SQL AND `toLowerCase()` IN JAVASCRIPT ARE THE WHOLE
 * NORMALISATION, on purpose -- see decision 2. Anything more would be one rule
 * written twice in two languages.
 *
 * AN EMPTY LIST ASKS NOTHING AT ALL rather than sending a query whose answer is
 * already known, which matters here because a whole batch of rows with no key
 * is an ordinary shape: a contact sheet with no email column.
 */
async function existingKeys(
  db: Database, entity: CsvImportEntity, keys: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  const rows = entity === "company"
    ? await db.execute<{ key: string }>(sql`
        SELECT DISTINCT lower(${companies.domain}) AS key
        FROM ${companies}
        WHERE lower(${companies.domain}) IN (${list})
      `)
    : await db.execute<{ key: string }>(sql`
        SELECT DISTINCT lower(e) AS key
        FROM ${contacts}, unnest(${contacts.emails}) AS e
        WHERE lower(e) IN (${list})
      `);
  for (const row of rows) found.add(row.key);
  return found;
}

/**
 * The one company each of these lowercased names belongs to.
 *
 * Fills `into` for every name exactly one company answers to, and RETURNS the
 * names more than one answers to -- two different sentences for the operator,
 * and only one of them is fixed by importing the companies first.
 */
async function resolveCompanies(
  db: Database, names: readonly string[], into: Map<string, string>,
): Promise<string[]> {
  if (names.length === 0) return [];
  const list = sql.join(names.map((name) => sql`${name}`), sql`, `);
  const rows = await db.execute<{ key: string; id: string; n: string }>(sql`
    SELECT lower(${companies.name}) AS key,
           min(${companies.id}::text) AS id,
           count(*)::text AS n
    FROM ${companies}
    WHERE lower(${companies.name}) IN (${list})
    GROUP BY lower(${companies.name})
  `);
  const ambiguous: string[] = [];
  for (const row of rows) {
    if (row.n === "1") into.set(row.key, row.id);
    else ambiguous.push(row.key);
  }
  return ambiguous;
}

/** "Already here" has to say WHAT matched, or it is not a reason. */
function describeKey(entity: CsvImportEntity, key: string): string {
  return entity === "company" ? `the domain ${key}` : `the email address ${key}`;
}

// --- the small parts -------------------------------------------------------

/** Turn a mapping into the form buildRow reads, with the columns in file order. */
function resolveMapping(
  mapping: CsvMapping, entity: CsvImportEntity, delimiter: string, owner: string | null,
): ResolvedCsvMapping {
  const byField = new Map<CsvImportField, number[]>();
  for (const entry of [...mapping.entries].sort((a, b) => a.column - b.column)) {
    const held = byField.get(entry.field);
    if (held === undefined) byField.set(entry.field, [entry.column]);
    else held.push(entry.column);
  }
  return Object.freeze({
    entity,
    delimiter,
    columns: Object.freeze([...byField].map(
      ([field, at]) => Object.freeze([field, Object.freeze([...at])]) as
        readonly [CsvImportField, readonly number[]],
    )),
    owner,
  });
}

/** The first `bytes` of a member. The stream is abandoned and destroyed. */
async function readPrefix(
  payload: StagedPayload, ref: StagedMemberRef, bytes: number,
): Promise<Buffer> {
  const stream = await payload.open(ref);
  const chunks: Buffer[] = [];
  let held = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      held += (chunk as Buffer).length;
      if (held >= bytes) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

/** The first record of a prefix already in memory, or null when there is none. */
async function firstRecord(prefix: string, delimiter: string): Promise<string[] | null> {
  for await (const record of foreignCsvRecords(sourceOf(prefix), { delimiter })) {
    return record.fields;
  }
  return null;
}

/** A string as the async iterable the reader takes. */
function sourceOf(text: string): AsyncIterable<string> {
  return (async function* () { yield text; })();
}

/** Two header rows, compared exactly. */
function sameHeaders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, at) => name === b[at]);
}

/**
 * Push at most MAX_FINDINGS_PER_CODE worked examples, then one summary line.
 *
 * ONE FUNCTION FOR EVERY REPEATING CODE, because there are six of them in this
 * module and six copies of one cap is six places for one of them to be
 * forgotten -- which is what turns a plan into the memory problem the import
 * exists to avoid.
 */
function pushCapped<T>(
  findings: PlanFindingView[],
  severity: "note" | "warning",
  code: string,
  examples: readonly T[],
  total: number,
  one: (example: T) => string,
  summary: (total: number) => string,
): void {
  for (const example of examples) findings.push({ severity, code, message: one(example) });
  if (total > examples.length) {
    findings.push({ severity, code, message: summary(total) });
  }
}
