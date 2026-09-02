import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { unstorableText } from "@conduit/shared";
import type { PlanFindingView, PlanRefusalView } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, users } from "../db/schema.js";
import { csvRecords, unescapeCellValue, CsvParseError } from "./csv.js";
import { EXPORT_CELL_TRANSFORM, EXPORT_FORMAT_VERSION } from "./export.js";
import {
  applyPlan, newPlan, planSource,
  type ApplyContext, type ApplyOutcome, type EffectHandlers, type Plan, type PlannedEffect,
} from "./intake-plan.js";
import type { IntakeFile, StagedMemberRef, StagedPayload } from "./intake.js";

// THE EXACT IMPORTER: CONDUIT READING BACK ITS OWN EXPORT.
//
// services/intake.ts landed the `.zip` and unpacked it; services/intake-plan.ts
// owns the plan and the frame apply runs in. This module is the last column of
// the spine's middle row -- inspect, plan, insert -- and it is the FIRST of the
// three pipelines whose last step CREATES rather than destroys.
//
// IT IS NOT A RESTORE, AND THE ASYMMETRY IS DELIBERATE RATHER THAN INCIDENTAL.
// The export carries no credentials, no mail.key, no mail bodies and NO
// DATABASE DUMP (services/export.ts says all four in its own words). So this
// cannot put an install back; it ADDS ROWS to the install it is pointed at, and
// services/restore.ts stays the only thing in this product that replaces one.
// The refusal below that answers a `.7z` reaching this path is the same line
// drawn from the other side as restore's RESTORE_REFUSALS.notABackup.
//
// ========== WHAT THE EXPORT CANNOT CARRY, WHICH DECIDES THE SCOPE ==========
//
// THIS VERSION IMPORTS COMPANIES AND CONTACTS. It is two sheets of nine, and
// the reason is not appetite: the other seven describe rows that CANNOT BE
// INSERTED from what the export holds, and the shortfall is in the export
// format rather than in this module. Read against db/schema.ts, sheet by sheet:
//
//   deals.csv ..... `position` is NOT NULL with no default and is not a
//                   column of the sheet. `pipeline_id` and `stage_id` are NOT
//                   NULL foreign keys and THERE IS NO pipelines.csv OR
//                   stages.csv AT ALL -- the export has eight entity sheets
//                   plus files.csv, and neither table is among them.
//   tasks.csv ..... `position`, same as deals. Its links to a deal and a
//                   project point at rows this version does not create.
//   projects.csv .. `deal_id` points at deals. A project imported with that
//                   link silently dropped would lose a relationship the export
//                   does record, which is worse than not importing it.
//   notes.csv ..... `author_user_id` is NOT NULL against `users`, and THE
//                   EXPORT CARRIES NO USERS -- only the id and a username
//                   beside it. Its `notes_exactly_one_entity` CHECK also means
//                   a note whose one parent is a deal has nowhere to go.
//   meetings.csv .. `owner_user_id` is NOT NULL against `users`, same gap. And
//                   the attendees are exported as DISPLAY NAMES in one cell,
//                   so the export cannot say whether an attendee was a
//                   contact, a Conduit user or a free-text guest -- which is
//                   exactly the three-way distinction
//                   `meeting_attendees_exactly_one` requires.
//   documents.csv . there is no document_line_items sheet, so an imported
//                   quote would carry frozen totals over no lines at all. A
//                   quote that prints an empty table under a total is worse
//                   than an absent quote.
//   files.csv ..... `uploader_user_id` is NOT NULL against `users`, same gap.
//                   (The blobs themselves ARE in the archive, under files/.)
//
// COMPANIES AND CONTACTS ARE THE CLOSURE THAT IS LEFT, and they are a closure
// rather than a pair chosen for convenience: a contact points at a company,
// which is in the export; a company points at nothing that is not either in
// the export or nullable. Nothing else in either row reaches outside the two
// sheets except `owner_user_id`, which is nullable -- see the owner rule below.
//
// WIDENING THIS IS A CHANGE TO THE EXPORT, NOT TO THIS FILE, and it is
// therefore Chris's to make rather than an implementer's: a formatVersion 2
// carrying users, pipelines, stages, the fractional positions, meeting
// attendees as data and document line items would let every sheet come back.
// Every finding this module emits about a sheet it did not import names the
// specific missing thing, so the format change has a specification already.
//
// ======================= THE THREE DECISIONS =============================
//
// 1. IDENTITY: THE EXPORT'S OWN IDS ARE KEPT, AND A ROW WHOSE ID IS ALREADY
//    HERE IS SKIPPED RATHER THAN OVERWRITTEN.
//
//    Minting new ids was the alternative and it is worse in three ways that
//    compound. Every cross-reference in the archive is a uuid -- contacts name
//    their company by id, documents name their file by id, files.csv names the
//    archive member -- so minting would need a translation table over the whole
//    export, held for the length of the import, and every sheet a later version
//    adds would have to remember to consult it. Re-importing the same archive
//    would then duplicate everything, every time, with no way for an operator
//    to undo it but by hand. And a preserved id makes "is this row already
//    here?" an exact question the PRIMARY KEY answers, rather than a fuzzy match
//    on a name that would have to be invented and would be wrong for the two
//    companies genuinely called "Acme".
//
//    THE COST IS STATED RATHER THAN HIDDEN: two installs that were never the
//    same install can, in principle, mint the same uuid, and this import would
//    then treat one company as the other and skip it. That is a v4 uuid
//    collision, which is not a risk anybody manages, and the alternative
//    (mint-and-translate) trades it for a certainty of duplicates on every
//    re-import.
//
//    SKIPPING RATHER THAN OVERWRITING follows from the plan the operator saw:
//    every effect here is `destroys: false`, and an import that rewrote a
//    company an operator had edited since the export would be destroying data
//    the preview promised to leave alone. The skipped rows are counted and
//    reported as a finding BEFORE apply, so "27 of these 104 companies are
//    already here" is something the operator reads rather than discovers.
//
// 2. DUPLICATES BETWEEN PREVIEW AND APPLY: THE WHOLE IMPORT ROLLS BACK.
//
//    A plan is a snapshot, not a lease -- services/intake-plan.ts's header says
//    so and names this as the case the importers have to decide. The window is
//    bounded by the plan TTL and is not closed by it: nothing stops another
//    session inserting (or deleting) a row with one of these ids while the
//    operator reads the preview.
//
//    The choice made here is the conservative one. Each insert is
//    ON CONFLICT (id) DO NOTHING and counts what actually landed; if that
//    differs from the count the preview published -- in EITHER direction, a row
//    that became a duplicate or one that stopped being one -- the step throws
//    and the transaction rolls back. NOTHING is imported, and the message says
//    to take a fresh preview.
//
//    IT IS REVERSIBLE, WHICH IS WHY IT IS THE CONSERVATIVE SIDE. The cost of
//    refusing is one re-upload of a file the operator still has. The cost of
//    the alternative -- importing "as many as still fit" -- is a preview that
//    said 104 and an install that got 103, with no record of which one is
//    missing and nothing but a row-by-row comparison to find it. The frame is
//    built to make exactly that impossible (a handler must account for its
//    effect's count), so accepting a short import would mean spending a number
//    the step did not do, which is the one thing the accounting exists to
//    forbid.
//
// 3. PARTIAL FAILURE: ONE TRANSACTION, AND IT HOLDS AT 200,000 ROWS.
//
//    applyImport opens ONE drizzle transaction and hands it to every effect as
//    the carrier, so companies and contacts commit together or not at all --
//    which matters here more than it looks, because contacts point at
//    companies: a commit between the two would leave a window in which a
//    contact's company does not exist.
//
//    WHAT IT COSTS, MEASURED RATHER THAN ASSERTED. On the deploy target
//    (PostgreSQL 15.19, Debian 12, 3.8GB and no swap), a real export of 200,000
//    companies -- 45.6MB of companies.csv inside a 5.6MB zip:
//
//      stage (7z x) ............   0.2s
//      inspect .................   3.5s, resident set 555MB
//      apply, ONE transaction ..  21.5s, PEAK resident set 555MB
//      the same apply failing on
//      its last row, and rolling
//      199,999 rows back .......  19.1s, one row left in the table
//
//    THE PEAK DID NOT MOVE DURING APPLY, and that is the number the batching
//    exists to produce: the rows are streamed out of the member and inserted
//    INSERT_BATCH_ROWS at a time, so the process holds one batch rather than
//    one import. What grows is inside Postgres -- uncommitted tuples in the
//    heap and one index entry per row -- and the rollback of them is O(1): the
//    transaction is marked aborted, the tuples become dead, and the next vacuum
//    reclaims the disk.
//
//    THE ONE COST WORTH NAMING is that the apply holds ONE POOLED CONNECTION
//    for its whole duration -- 21 seconds at this size. The pool is 10, so nine
//    remain for everything else; an import does not close the write gate and
//    does not stop the mail sync, both of which are restore's and neither of
//    which an additive insert has any business taking.
//
// ================== WHAT THIS DELIBERATELY DOES NOT DO ====================
//
// NO `events` ROWS. Every interactive write path in this codebase stamps a
// timeline event; this one does not, and it is a decision rather than an
// omission. An import is a bulk load of history that happened somewhere else,
// so "created" stamped at import time would be a lie on every row -- and
// 200,000 lies would bury the timeline the events exist to serve.
// `events_verb_valid` also has no verb for it, and inventing one is a
// migration, which this task does not take.
//
// NO WRITE GATE AND NO SAFETY BACKUP. Both belong to restore, for the reason
// the 7.7 spec gives: an import that goes wrong adds rows an operator can
// archive, and a restore that goes wrong has already destroyed them.
//
// ONE LOSS THE FORMAT MAKES UNAVOIDABLE, RECORDED RATHER THAN GUESSED AT.
// services/export.ts writes a nullable text column through `text()`, which maps
// BOTH null and the empty string to an empty cell. Reading back, an empty cell
// becomes NULL. A company whose `domain` was genuinely "" comes back with a
// NULL domain. The export cannot tell the two apart, so neither can this, and
// choosing NULL is the choice that matches what the rest of the application
// writes -- the create/update services never store an empty string in these
// columns.

/**
 * Every reason this importer refuses, as codes a test can assert without
 * matching prose.
 *
 * A REFUSAL IS A PLAN WITH NO EFFECTS -- see newPlan. Every one of these is
 * reached with nothing inserted, which is the whole argument for inspect
 * producing a value rather than doing work.
 */
export const IMPORT_REFUSALS = {
  /** No manifest.json in the archive. */
  manifestMissing: "manifest-missing",
  /** manifest.json is not JSON, or not a manifest. */
  manifestUnreadable: "manifest-unreadable",
  /**
   * A backup, not an export. THE MIRROR OF restore's `not-a-backup`.
   *
   * A backup carries mail bodies, mail.key and every encrypted mail password.
   * None of them means anything to an insert path, and a `.7z` that reached
   * here would have had its passphrase typed into an importer that has no use
   * for one.
   */
  notAnExport: "not-an-export",
  /** A layout version this build does not know how to read. */
  formatUnknown: "format-unknown",
  /**
   * The manifest declares a cell transform this build cannot reverse.
   *
   * REFUSED RATHER THAN IGNORED, and this is the single most important refusal
   * in the file. Applying version 1's inverse to a cell version 2 escaped
   * differently would corrupt the operator's data QUIETLY -- a note reading
   * `'@here` restored as `@here`, or worse -- and the damage would be
   * indistinguishable from the data itself afterwards. The transform is
   * declared so it can be undone deterministically; a declaration this build
   * does not recognise is a declaration it must not guess at.
   */
  transformUnknown: "transform-unknown",
  /** A member manifest.json lists is not in the archive. */
  memberMissing: "member-missing",
  /** A member's bytes do not match the digest manifest.json recorded. */
  memberCorrupt: "member-corrupt",
  /** A sheet this importer reads is not in the archive at all. */
  sheetMissing: "sheet-missing",
  /** A sheet is missing a column this importer reads. */
  columnMissing: "column-missing",
  /** A sheet's records could not be parsed; see services/csv.ts. */
  sheetUnreadable: "sheet-unreadable",
  /**
   * Two records in one sheet claim the same id.
   *
   * DAMAGE, NOT A DUPLICATE. The column is a PRIMARY KEY in the database the
   * export was taken from, so no export Conduit wrote can contain one. It is
   * refused rather than deduplicated because a file whose ids repeat is a file
   * whose contents this importer cannot vouch for.
   */
  duplicateId: "duplicate-id",
  /**
   * A contact names a company that is in neither the export nor this install.
   *
   * ALSO DAMAGE. The export is a whole-database snapshot taken in one
   * repeatable-read transaction (services/export.ts's withExportSnapshot), so
   * every company_id in contacts.csv appears in companies.csv. A dangling one
   * means the archive was edited or damaged after it was written -- which the
   * digest sweep above will normally have caught first.
   */
  danglingCompany: "dangling-company",
  /** Everything in the archive is already here, or there is nothing to import. */
  nothingToImport: "nothing-to-import",
} as const;

/** Findings an import plan can carry. Notes and warnings; never refusals. */
export const IMPORT_FINDINGS = {
  /** The declared cell transform, and that it will be reversed. */
  cellTransform: "cell-transform",
  /** A member the manifest does not list. EXTRA, NOT DAMAGE. */
  extraMember: "extra-member",
  /** A sheet in the archive that this version does not import, and why. */
  sheetNotImported: "sheet-not-imported",
  /** The headline: this reads two of the nine sheets. */
  partialImport: "partial-import",
  /** Rows whose id is already in this install and will be left alone. */
  alreadyPresent: "already-present",
  /** A record this importer could not turn into a row, and why. */
  rowUnreadable: "row-unreadable",
  /** Rows that will arrive with no owner, because the user is not here. */
  ownerUnknown: "owner-unknown",
} as const;

/**
 * The transform this build knows how to reverse, and the ONLY one.
 *
 * Compared against manifest.json's declaration by name AND version. It is the
 * same constant services/export.ts writes, imported rather than restated, so
 * the two cannot drift into agreeing about different things.
 */
const REVERSIBLE_TRANSFORMS: readonly { name: string; version: number }[] = [
  { name: EXPORT_CELL_TRANSFORM.name, version: EXPORT_CELL_TRANSFORM.version },
];

const MANIFEST_MEMBER = "manifest.json";
const COMPANIES_MEMBER = "companies.csv";
const CONTACTS_MEMBER = "contacts.csv";

/**
 * How many rows go into one INSERT.
 *
 * 500, AND IT IS BOUNDED BY POSTGRES' PARAMETER LIMIT RATHER THAN BY TASTE. A
 * companies row binds twelve parameters, so 500 rows is 6,000 of the 65,535 a
 * single statement may carry -- room for the widest sheet a later version adds
 * without this number having to move. It is also what keeps the resident cost
 * of an import one batch rather than one file.
 */
export const INSERT_BATCH_ROWS = 500;

/**
 * The most findings of one code this plan will carry.
 *
 * THE FINDINGS ARRAY IS THE ONE PART OF A PLAN THAT GROWS WITH THE DATA, and
 * that is exactly what PlanEffectView's `count` exists to avoid for effects. A
 * sheet of 200,000 unreadable records would otherwise build a 200,000-entry
 * array, hold it for the plan's whole TTL, and render it into a page. So each
 * repeating code emits at most this many worked examples and then one summary
 * line carrying the total.
 *
 * The page keys this list `${code}-${index}` precisely because these repeat --
 * see pages/settings-data.tsx.
 */
export const MAX_FINDINGS_PER_CODE = 10;

/** How many ids one existence probe asks about. Same bound as a write batch. */
const PROBE_BATCH_IDS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** contacts_salutation_length and contacts_pronouns_length, in this file's words. */
const CONTACT_FIELD_MAX = 64;

// --- the effects -----------------------------------------------------------

/**
 * What both insert steps need to carry, and nothing more.
 *
 * `knownOwners` IS ON THE EFFECT RATHER THAN RE-MEASURED AT APPLY, and it is
 * the one piece of world-state this plan freezes. The export names an owner by
 * a uuid in a `users` table it does not carry, so an owner is kept only when a
 * user with that id is already here; every other row arrives unowned. Measuring
 * that again at apply would let a person who logged in while the operator read
 * the preview change what the import does, silently and after the fact. The
 * list is bounded by the number of DISTINCT owners named in the sheet, which is
 * bounded by the number of users on the install -- tens, on the deployment
 * shape this app is for.
 *
 * `reverseCellTransform` IS ALSO FROZEN HERE, for the stronger version of the
 * same reason: what a cell MEANS depends on it, and it must be the manifest's
 * answer read once at inspect, not a second reading of the manifest at apply.
 */
interface InsertEffectBase extends PlannedEffect {
  /** Owner ids named in the sheet that exist in `users` right now. */
  readonly knownOwners: readonly string[];
  /** Whether manifest.json declared the leading-apostrophe escape. */
  readonly reverseCellTransform: boolean;
}

export interface InsertCompaniesEffect extends InsertEffectBase {
  readonly op: "insert-companies";
}

export interface InsertContactsEffect extends InsertEffectBase {
  readonly op: "insert-contacts";
}

export type ImportEffect = InsertCompaniesEffect | InsertContactsEffect;

export type ImportPlan = Plan<ImportEffect>;

/**
 * WHAT ONE EFFECT HANDS THE NEXT: the transaction, and nothing else.
 *
 * Contacts are inserted after companies IN THE SAME TRANSACTION, so a contact's
 * company exists by the time its foreign key is checked. The carrier is what
 * makes that one atomic act while the operator still sees two effects -- the
 * same arrangement restore uses for its destroy and its load, arrived at from
 * the opposite direction.
 */
export interface ImportCarrier {
  readonly tx: Database;
}

/**
 * The insert did not land the number of rows the preview published.
 *
 * SEPARATE FROM PlanExceededError, AND THE DIFFERENCE IS WHOSE FAULT IT IS.
 * The frame's error means a STEP did something its plan did not describe, which
 * is a bug in this file. This one means the DATABASE changed under a plan that
 * was true when it was taken, which is nobody's bug and is fixed by pressing
 * preview again. A caller has to be able to tell them apart, so they are two
 * classes rather than two messages.
 */
export class ImportDatabaseChangedError extends Error {
  constructor(
    readonly subject: string,
    readonly planned: number,
    readonly inserted: number,
  ) {
    super(
      `the preview said ${String(planned)} ${subject} would be created and `
      + `${String(inserted)} were, because this install changed while the preview was open. `
      + "Nothing has been imported. Upload the export again for a fresh preview.",
    );
    this.name = "ImportDatabaseChangedError";
  }
}

// --- reading a sheet -------------------------------------------------------

/**
 * A parsed record, addressed by column NAME rather than by position.
 *
 * BY NAME BECAUSE THE FORMAT PROMISES IT. services/export.ts's
 * EXPORT_FORMAT_VERSION is bumped when a column is REMOVED or a member renamed
 * and NOT when one is added, "which every reader tolerates" -- so a reader that
 * indexed by position would break on the first added column while the version
 * number said it should not have.
 */
type Cells = (column: string) => string;

/** One record that could not become a row, and the reason a person reads. */
interface BadRecord {
  readonly record: number;
  readonly reason: string;
}

/** A required column is not in the sheet's header. */
class MissingColumnError extends Error {
  constructor(readonly column: string) {
    super(`the sheet has no ${JSON.stringify(column)} column`);
    this.name = "MissingColumnError";
  }
}

interface SheetScan {
  /** Data records, excluding the header. */
  readonly records: number;
  /**
   * Every valid record's id, in file order, and its owner id beside it -- "" for
   * a record that names none.
   *
   * TWO PARALLEL ARRAYS RATHER THAN ONE ARRAY OF PAIRS, because the plan has to
   * answer two questions that need them zipped: which of these rows are already
   * here (ids alone), and how many of the rows that WILL be inserted name an
   * owner this install does not have (both). The owner strings are interned
   * against a small map as they are read, so a sheet of 200,000 rows owned by
   * four people holds four owner strings and not 200,000.
   */
  readonly ids: string[];
  readonly owners: string[];
  /** Distinct company ids named by the sheet's valid rows. Contacts only. */
  readonly companyLinks: Set<string>;
  readonly bad: BadRecord[];
  readonly badCount: number;
}

/**
 * The columns each sheet is read through. A sheet missing one of these is
 * refused: the format's own rule is that a REMOVED column bumps the version, so
 * an absent column means this archive is not the version it claims to be.
 */
const COMPANY_COLUMNS = [
  "id", "name", "domain", "website", "phone", "address", "industry",
  "owner_user_id", "custom", "archived_at", "created_at", "updated_at",
] as const;

const CONTACT_COLUMNS = [
  "id", "first_name", "last_name", "salutation", "pronouns", "job_title",
  "company_id", "emails", "phones",
  "owner_user_id", "custom", "archived_at", "created_at", "updated_at",
] as const;

/** A row built from one record, or the reason it could not be. */
type Built<T> = { row: T } | { reason: string };

/**
 * THE CHARACTERS POSTGRES WILL NOT STORE, CHECKED ON EVERY CELL OF A RECORD
 * BEFORE ANY OF IT IS READ.
 *
 * ITS ABSENCE WAS A DEFECT AND THIS IS WHAT IT COST, said plainly because the
 * shape is the one this whole design exists to prevent. `unstorableText` is
 * @conduit/shared's rule for a value a text column cannot hold, and
 * services/import-csv.ts calls checking it MANDATORY -- its header lists "the
 * NUL that no CHECK describes because Postgres refuses it at the type" among
 * the constraints buildRow must catch, and its suite proves it with a control
 * that shows Postgres refusing one. This module checked the uuids, the two
 * 64-character caps, the timestamps and the JSON-ness of `custom`, AND NOT
 * THIS. So a record carrying a NUL was counted by the preview as a row that
 * would be created, and the INSERT then failed with `22021 null character not
 * permitted` -- or, for one inside `custom`, `22P05 unsupported Unicode escape
 * sequence` -- part way through a transaction. The whole import rolled back, so
 * nothing was half-written; what was wrong is that THE PREVIEW LIED, which is
 * the one failure the plan-as-a-value design exists to make impossible.
 *
 * IT IS REACHABLE BY ANY AUTHENTICATED CALLER. The manifest is inside the
 * archive, so its digests can be made consistent with a doctored sheet;
 * services/csv.ts passes a NUL through in both bare and quoted cells and
 * `unescapeCellValue` keeps it.
 *
 * EVERY CELL, AND THE RAW CELL RATHER THAN THE PARSED VALUE. A NUL inside a
 * JSON string survives `JSON.parse` and only fails at the jsonb cast, and one
 * inside an `emails` cell survives the split -- so checking the columns before
 * they are interpreted is the only sweep that covers all of them with one line.
 *
 * AND THE RECORD IS REFUSED RATHER THAN REPAIRED, which is where this differs
 * from its sibling on purpose. services/import-csv.ts DROPS an unstorable
 * optional value and keeps the row, because losing a person over a typo in a
 * spreadsheet is not forgiving. This importer's whole contract is EXACTNESS --
 * it restores ids, timestamps and `custom` as the export recorded them -- so an
 * "exact" import that silently dropped a value would not be one. The record is
 * named in the preview as one that will not be imported, and the operator finds
 * out before they commit rather than afterwards.
 */
function unstorableColumn(cells: Cells, columns: readonly string[]): string | null {
  for (const column of columns) {
    if (unstorableText(cells(column))) return column;
  }
  return null;
}

interface CompanyInsert {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  industry: string | null;
  ownerUserId: string | null;
  custom: Record<string, unknown>;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ContactInsert {
  id: string;
  firstName: string;
  lastName: string | null;
  salutation: string | null;
  pronouns: string | null;
  jobTitle: string | null;
  companyId: string | null;
  emails: string[];
  phones: string[];
  ownerUserId: string | null;
  custom: Record<string, unknown>;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An empty cell is NULL. See the module header's note on `text()`. */
function nullable(value: string): string | null {
  return value === "" ? null : value;
}

/** A timestamp column, or null. An unparseable one is a reason, never a guess. */
function readTimestamp(value: string): Date | null | "bad" {
  if (value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "bad" : parsed;
}

/**
 * A text[] cell, split on the newline services/export.ts's `list()` joins with.
 *
 * EXACT BECAUSE THE SEPARATOR CANNOT OCCUR IN A VALUE: an email address and a
 * phone number cannot contain a newline, which is precisely why `list()` chose
 * one over the `; ` a reader might expect. An empty cell is an empty array, not
 * an array holding one empty string.
 */
function readList(value: string): string[] {
  return value === "" ? [] : value.split("\n");
}

/** A jsonb cell. Anything but a JSON object is a reason, never a coercion. */
function readCustom(value: string): Record<string, unknown> | "bad" {
  if (value === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "bad";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "bad";
  return parsed as Record<string, unknown>;
}

/**
 * ONE COMPANY ROW, OR WHY THERE IS NOT ONE.
 *
 * THE SAME FUNCTION RUNS AT INSPECT AND AT APPLY, and that is the only reason
 * the two can agree. inspect counts the rows this returns and apply inserts
 * them; two implementations of "is this record usable" would be two answers,
 * and the difference would surface as an accounting failure in the middle of a
 * transaction rather than as a finding in a preview.
 */
function buildCompany(cells: Cells, knownOwners: ReadonlySet<string>): Built<CompanyInsert> {
  const unstorable = unstorableColumn(cells, COMPANY_COLUMNS);
  if (unstorable !== null) {
    return { reason: `its ${unstorable} holds a character the database cannot store` };
  }
  const id = cells("id");
  if (!UUID.test(id)) return { reason: "its id is not a uuid" };
  const name = cells("name");
  if (name === "") return { reason: "it has no name" };
  const custom = readCustom(cells("custom"));
  if (custom === "bad") return { reason: "its custom field is not a JSON object" };
  const createdAt = readTimestamp(cells("created_at"));
  if (createdAt === "bad" || createdAt === null) return { reason: "its created_at is not a timestamp" };
  const updatedAt = readTimestamp(cells("updated_at"));
  if (updatedAt === "bad" || updatedAt === null) return { reason: "its updated_at is not a timestamp" };
  const archivedAt = readTimestamp(cells("archived_at"));
  if (archivedAt === "bad") return { reason: "its archived_at is not a timestamp" };
  const owner = cells("owner_user_id");
  if (owner !== "" && !UUID.test(owner)) return { reason: "its owner_user_id is not a uuid" };
  return {
    row: {
      id,
      name,
      domain: nullable(cells("domain")),
      website: nullable(cells("website")),
      phone: nullable(cells("phone")),
      address: nullable(cells("address")),
      industry: nullable(cells("industry")),
      // THE OWNER IS DROPPED RATHER THAN INVENTED. `users` is not in the
      // export, so an owner this install has never seen cannot be created here
      // -- a users row is an identity SSOwat maps a login to, and minting one
      // from a name in a file somebody uploaded is not a decision an importer
      // gets to make. The count of rows this affects is a plan finding, so it
      // is read before the import rather than discovered after it.
      ownerUserId: knownOwners.has(owner) ? owner : null,
      custom,
      archivedAt,
      createdAt,
      updatedAt,
    },
  };
}

/** ONE CONTACT ROW, OR WHY THERE IS NOT ONE. See buildCompany. */
function buildContact(cells: Cells, knownOwners: ReadonlySet<string>): Built<ContactInsert> {
  const unstorable = unstorableColumn(cells, CONTACT_COLUMNS);
  if (unstorable !== null) {
    return { reason: `its ${unstorable} holds a character the database cannot store` };
  }
  const id = cells("id");
  if (!UUID.test(id)) return { reason: "its id is not a uuid" };
  const firstName = cells("first_name");
  if (firstName === "") return { reason: "it has no first name" };
  const custom = readCustom(cells("custom"));
  if (custom === "bad") return { reason: "its custom field is not a JSON object" };
  const createdAt = readTimestamp(cells("created_at"));
  if (createdAt === "bad" || createdAt === null) return { reason: "its created_at is not a timestamp" };
  const updatedAt = readTimestamp(cells("updated_at"));
  if (updatedAt === "bad" || updatedAt === null) return { reason: "its updated_at is not a timestamp" };
  const archivedAt = readTimestamp(cells("archived_at"));
  if (archivedAt === "bad") return { reason: "its archived_at is not a timestamp" };
  const owner = cells("owner_user_id");
  if (owner !== "" && !UUID.test(owner)) return { reason: "its owner_user_id is not a uuid" };
  const company = cells("company_id");
  if (company !== "" && !UUID.test(company)) return { reason: "its company_id is not a uuid" };
  // THE COLUMN CHECKS, CHECKED HERE. contacts_salutation_length and
  // contacts_pronouns_length are 64 characters each. A longer value reaching
  // the INSERT would be a 23514 in the middle of a transaction that has already
  // written thousands of rows -- so it is a record this importer declines,
  // named in the preview, rather than a constraint violation nobody previewed.
  // THE OTHER CONSTRAINT OF THAT KIND IS unstorableColumn ABOVE, and this
  // comment used to read as though these two caps were the whole of it. They
  // are the ones a CHECK describes; the NUL is the one Postgres refuses at the
  // type, which is why it needs a sweep rather than a per-column length test.
  const salutation = cells("salutation");
  if (salutation.length > CONTACT_FIELD_MAX) return { reason: "its salutation is longer than 64 characters" };
  const pronouns = cells("pronouns");
  if (pronouns.length > CONTACT_FIELD_MAX) return { reason: "its pronouns are longer than 64 characters" };
  return {
    row: {
      id,
      firstName,
      lastName: nullable(cells("last_name")),
      salutation: nullable(salutation),
      pronouns: nullable(pronouns),
      jobTitle: nullable(cells("job_title")),
      companyId: company === "" ? null : company,
      emails: readList(cells("emails")),
      phones: readList(cells("phones")),
      ownerUserId: knownOwners.has(owner) ? owner : null,
      custom,
      archivedAt,
      createdAt,
      updatedAt,
    },
  };
}

/**
 * A reader over one sheet's records, with the header resolved to a lookup.
 *
 * `missing` NAMES THE FIRST REQUIRED COLUMN THE HEADER DOES NOT HAVE, so a
 * refusal can say which one rather than "the header is wrong".
 */
async function* sheetRecords(
  source: AsyncIterable<Buffer>,
  required: readonly string[],
  unescape: boolean,
): AsyncGenerator<{ record: number; cells: Cells }> {
  let index = new Map<string, number>();
  let recordNumber = 1;
  let header: string[] | null = null;
  for await (const record of csvRecords(source)) {
    if (header === null) {
      header = record;
      // THE HEADER IS UN-ESCAPED TOO. csvCell escapes every cell of every
      // record, and csvDocument passes the header row through csvRow like any
      // other -- so a column whose name began with an apostrophe would arrive
      // doubled. No column does today; doing it anyway is what keeps the
      // reader the writer's inverse rather than its inverse-in-the-cases-we-
      // thought-of.
      index = new Map(header.map((name, at) => [unescape ? unescapeCellValue(name) : name, at]));
      const missing = required.find((column) => !index.has(column));
      if (missing !== undefined) throw new MissingColumnError(missing);
      recordNumber += 1;
      continue;
    }
    if (record.length !== header.length) {
      throw new CsvParseError(
        recordNumber,
        `it has ${String(record.length)} fields where the header has ${String(header.length)}`,
      );
    }
    const cells: Cells = (column) => {
      const at = index.get(column);
      const raw = at === undefined ? "" : record[at] ?? "";
      return unescape ? unescapeCellValue(raw) : raw;
    };
    yield { record: recordNumber, cells };
    recordNumber += 1;
  }
  if (header === null) throw new CsvParseError(1, "the sheet has no header record");
}

// --- inspect ---------------------------------------------------------------

export interface InspectImportOptions {
  /** The upload, as services/intake.ts landed it. */
  file: IntakeFile;
  /** The staged archive. inspect may read all of it; apply may not. */
  payload: StagedPayload;
  /** The live database the rows would be added to. */
  db: Database;
  /** Injected so a plan's timestamps are a value rather than a moving target. */
  now?: Date;
}

/** A refusal plan: no effects, nothing inserted. */
function refuse(
  options: InspectImportOptions, refusal: PlanRefusalView, findings: PlanFindingView[] = [],
): ImportPlan {
  return newPlan<ImportEffect>({
    kind: "import-export",
    source: planSource(options.file, options.payload),
    refusal,
    findings,
    now: options.now,
  });
}

/** Every sheet this version does not import, and the specific reason. */
const NOT_IMPORTED: readonly { member: string; reason: string }[] = [
  {
    member: "deals.csv",
    reason: "the export carries no pipelines or stages for a deal to sit in, and no position "
      + "for its place in the stage; all three are required and none is in the archive",
  },
  {
    member: "projects.csv",
    reason: "a project can point at a deal, and deals are not imported; importing one with "
      + "that link silently dropped would lose a relationship the export does record",
  },
  {
    member: "tasks.csv",
    reason: "the export carries no position for a task, which is required, and a task can "
      + "point at a deal or a project, neither of which is imported",
  },
  {
    member: "notes.csv",
    reason: "a note's author is a Conduit user and the export carries no users, only their "
      + "ids and names",
  },
  {
    member: "meetings.csv",
    reason: "a meeting's owner is a Conduit user the export does not carry, and its attendees "
      + "are exported as display names only -- the archive cannot say whether an attendee was "
      + "a contact, a user or a guest",
  },
  {
    member: "documents.csv",
    reason: "the export carries no line items, so an imported quote would show a frozen total "
      + "over an empty table",
  },
  {
    member: "files.csv",
    reason: "a stored file's uploader is a Conduit user the export does not carry; the files "
      + "themselves are in the archive and can be saved out of it by hand",
  },
];

/**
 * VALIDATE BEFORE MUTATE, AND PRODUCE A VALUE EITHER WAY.
 *
 * Every refusal below is reached with nothing written. The archive is already
 * unpacked -- the spine did that -- and everything from here to applyImport is
 * reading: an archive from a newer Conduit, one carrying a transform this build
 * cannot reverse, and one whose bytes do not match its own manifest are all
 * VALUES a test can assert with no row inserted.
 *
 * THE ORDER IS CHEAPEST FIRST AND, MORE IMPORTANTLY, "THIS CANNOT WORK AT ALL"
 * BEFORE "THIS MEMBER'S BYTES ARE WRONG". The digest sweep is the only step
 * that reads the whole archive, so an operator who uploaded a backup by mistake
 * is told so from the manifest alone rather than after 300MB of blobs have been
 * hashed.
 */
export async function inspectImport(options: InspectImportOptions): Promise<ImportPlan> {
  const { file, payload, db, now = new Date() } = options;
  const findings: PlanFindingView[] = [];

  const manifestMember = payload.byName(MANIFEST_MEMBER);
  if (manifestMember === undefined) {
    return refuse(options, {
      code: IMPORT_REFUSALS.manifestMissing,
      message: "this archive has no manifest.json, so it is not a Conduit export.",
    });
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await payload.readText(manifestMember.ref));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return refuse(options, {
      code: IMPORT_REFUSALS.manifestUnreadable,
      message: "this archive's manifest.json could not be read, so the archive cannot be trusted "
        + "to be a Conduit export.",
    });
  }

  // THE ASYMMETRY, GUARDED FROM THIS SIDE. services/restore.ts refuses anything
  // whose manifest does not positively say "backup"; this refuses anything that
  // does. A backup reaching an insert path would be an operator who typed a
  // passphrase into the wrong control at the moment they needed the right one.
  if (manifest.kind === "backup") {
    return refuse(options, {
      code: IMPORT_REFUSALS.notAnExport,
      message: "this is a Conduit backup, not an export. A backup replaces this install's data "
        + "and is applied through Restore; an import only adds rows.",
    });
  }

  const formatVersion = manifest.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)
    || formatVersion < 1 || formatVersion > EXPORT_FORMAT_VERSION) {
    return refuse(options, {
      code: IMPORT_REFUSALS.formatUnknown,
      message: `this export is layout version ${JSON.stringify(formatVersion)} and this install `
        + `understands version ${String(EXPORT_FORMAT_VERSION)}. A newer Conduit wrote it.`,
    });
  }

  // WHAT THE ARCHIVE SAYS IT DID TO ITS OWN CELLS, AND WHETHER THIS BUILD CAN
  // UNDO IT. An unrecognised entry refuses; a recognised one turns the inverse
  // ON. There is no third branch in which a transform is assumed: an archive
  // that declares none is read verbatim, because un-escaping bytes nothing
  // escaped would eat a leading apostrophe somebody typed.
  const declared = manifest.cellTransforms;
  if (declared !== undefined && !Array.isArray(declared)) {
    return refuse(options, {
      code: IMPORT_REFUSALS.manifestUnreadable,
      message: "this archive's manifest.json declares its cell transforms in a shape this "
        + "install cannot read.",
    });
  }
  let reverseCellTransform = false;
  for (const entry of (declared ?? []) as unknown[]) {
    const transform = entry as { name?: unknown; version?: unknown };
    const known = REVERSIBLE_TRANSFORMS.find(
      (candidate) => candidate.name === transform.name && candidate.version === transform.version,
    );
    if (known === undefined) {
      return refuse(options, {
        code: IMPORT_REFUSALS.transformUnknown,
        message: `this export declares a cell transform this install cannot reverse `
          + `(${JSON.stringify(transform.name)} version ${JSON.stringify(transform.version)}). `
          + "Reading it with the wrong inverse would corrupt the values it rewrote.",
      });
    }
    reverseCellTransform = true;
    findings.push({
      severity: "note",
      code: IMPORT_FINDINGS.cellTransform,
      message: `the export declares the ${known.name} transform, version `
        + `${String(known.version)}; it is reversed as every cell is read.`,
    });
  }

  // THE DIGEST SWEEP: EVERY MEMBER THE MANIFEST LISTS, NOT ONLY THE TWO THIS
  // VERSION READS. Hashing a blob nobody is about to import looks like waste
  // and is not: the manifest exists so a damaged download is DETECTABLE, and an
  // operator whose archive is broken should learn it while they can still
  // fetch another -- including when the damage is in a sheet the NEXT version
  // will import. It is also one fewer difference between this path and
  // restore's, which sweeps for the same reason.
  const listed = manifest.members;
  if (!Array.isArray(listed)) {
    return refuse(options, {
      code: IMPORT_REFUSALS.manifestUnreadable,
      message: "this archive's manifest.json does not list its members.",
    });
  }
  const listedPaths = new Set<string>();
  for (const entry of listed as unknown[]) {
    const member = entry as { path?: unknown; sha256?: unknown };
    if (typeof member.path !== "string" || typeof member.sha256 !== "string") {
      return refuse(options, {
        code: IMPORT_REFUSALS.manifestUnreadable,
        message: "this archive's manifest.json lists a member without a path or a digest.",
      });
    }
    listedPaths.add(member.path);
    const staged = payload.byName(member.path);
    if (staged === undefined) {
      return refuse(options, {
        code: IMPORT_REFUSALS.memberMissing,
        message: `this export's manifest lists ${JSON.stringify(member.path)} and the archive `
          + "does not contain it, so the archive is incomplete.",
      });
    }
    const digest = await digestOfMember(payload, staged.ref);
    if (digest !== member.sha256) {
      return refuse(options, {
        code: IMPORT_REFUSALS.memberCorrupt,
        message: `${JSON.stringify(member.path)} does not match the digest this export recorded `
          + "for it, so the archive has been damaged since it was written.",
      });
    }
  }

  // AN UNLISTED MEMBER IS EXTRA, NOT DAMAGE. The same rule the 7.7 spec names
  // for restore, and it holds here for a reason of its own as well: the
  // manifest deliberately does not list ITSELF (it cannot carry its own
  // digest), so a rule that treated "in the archive, not in the manifest" as
  // corruption would refuse every export ever written on the first member it
  // looked at.
  let extras = 0;
  for (const member of payload.members) {
    if (member.name === MANIFEST_MEMBER || listedPaths.has(member.name)) continue;
    extras += 1;
    if (extras <= MAX_FINDINGS_PER_CODE) {
      findings.push({
        severity: "note",
        code: IMPORT_FINDINGS.extraMember,
        message: `the archive carries ${JSON.stringify(member.name)}, which its manifest does `
          + "not list. It is ignored, not treated as damage.",
      });
    }
  }
  if (extras > MAX_FINDINGS_PER_CODE) {
    findings.push({
      severity: "note",
      code: IMPORT_FINDINGS.extraMember,
      message: `${String(extras)} members in all are not listed in the manifest. All are ignored.`,
    });
  }

  const companiesMember = payload.byName(COMPANIES_MEMBER);
  const contactsMember = payload.byName(CONTACTS_MEMBER);
  if (companiesMember === undefined || contactsMember === undefined) {
    const absent = companiesMember === undefined ? COMPANIES_MEMBER : CONTACTS_MEMBER;
    return refuse(options, {
      code: IMPORT_REFUSALS.sheetMissing,
      message: `this archive has no ${absent}, so it is not a Conduit export this install can read.`,
    });
  }

  let companyScan: SheetScan;
  let contactScan: SheetScan;
  try {
    companyScan = await scanSheet(
      payload, companiesMember.ref, COMPANY_COLUMNS, reverseCellTransform, buildCompany, null,
    );
    contactScan = await scanSheet(
      payload, contactsMember.ref, CONTACT_COLUMNS, reverseCellTransform, buildContact, "company_id",
    );
  } catch (error) {
    if (error instanceof MissingColumnError) {
      return refuse(options, {
        code: IMPORT_REFUSALS.columnMissing,
        message: `this export is missing a column this install reads: ${error.message}.`,
      });
    }
    if (error instanceof CsvParseError) {
      return refuse(options, {
        code: IMPORT_REFUSALS.sheetUnreadable,
        message: `${error.message}. The archive is damaged, or was written by something other `
          + "than Conduit.",
      });
    }
    throw error;
  }

  const companyIds = new Set(companyScan.ids);
  if (companyIds.size !== companyScan.ids.length) {
    return refuse(options, {
      code: IMPORT_REFUSALS.duplicateId,
      message: "companies.csv names the same id twice, which no export Conduit wrote can do. "
        + "The archive is damaged.",
    });
  }
  const contactIds = new Set(contactScan.ids);
  if (contactIds.size !== contactScan.ids.length) {
    return refuse(options, {
      code: IMPORT_REFUSALS.duplicateId,
      message: "contacts.csv names the same id twice, which no export Conduit wrote can do. "
        + "The archive is damaged.",
    });
  }

  // Every company a contact could legitimately point at: the ones arriving in
  // this archive, plus the ones already here. Anything else is damage -- see
  // IMPORT_REFUSALS.danglingCompany.
  const presentCompanies = await existingIds(db, companies, [...contactScan.companyLinks]);
  const dangling = [...contactScan.companyLinks].find(
    (id) => !companyIds.has(id) && !presentCompanies.has(id),
  );
  if (dangling !== undefined) {
    return refuse(options, {
      code: IMPORT_REFUSALS.danglingCompany,
      message: "contacts.csv names a company that is in neither this export nor this install -- "
        + "either it is absent from companies.csv, or its record there could not be read. An "
        + "export is a whole snapshot taken in one transaction, so this archive is damaged.",
    }, findings);
  }

  const knownOwners = await existingIds(
    db, users, [...new Set([...distinctOwners(companyScan), ...distinctOwners(contactScan)])],
  );
  const companiesHere = await existingIds(db, companies, companyScan.ids);
  const contactsHere = await existingIds(db, contacts, contactScan.ids);

  const companyInserts = companyScan.ids.length - companiesHere.size;
  const contactInserts = contactScan.ids.length - contactsHere.size;

  pushSkipFindings(findings, "companies", companiesHere.size);
  pushSkipFindings(findings, "contacts", contactsHere.size);
  pushBadFindings(findings, COMPANIES_MEMBER, companyScan);
  pushBadFindings(findings, CONTACTS_MEMBER, contactScan);
  pushOwnerFindings(findings, "companies", countUnowned(companyScan, knownOwners, companiesHere));
  pushOwnerFindings(findings, "contacts", countUnowned(contactScan, knownOwners, contactsHere));

  findings.push({
    severity: "warning",
    code: IMPORT_FINDINGS.partialImport,
    message: "this install imports companies and contacts from an export. The other sheets "
      + "describe rows the export does not carry everything for; each one says what is missing "
      + "below, and nothing in them is changed either way.",
  });
  for (const sheet of NOT_IMPORTED) {
    if (payload.byName(sheet.member) === undefined) continue;
    findings.push({
      severity: "note",
      code: IMPORT_FINDINGS.sheetNotImported,
      message: `${sheet.member} is not imported: ${sheet.reason}.`,
    });
  }

  if (companyInserts === 0 && contactInserts === 0) {
    return refuse(options, {
      code: IMPORT_REFUSALS.nothingToImport,
      message: "every company and contact in this export is already in this install, or the "
        + "export has none. There is nothing to add.",
    }, findings);
  }

  const owners = [...knownOwners];
  const effects: ImportEffect[] = [];
  if (companyInserts > 0) {
    effects.push({
      op: "insert-companies",
      subject: "companies",
      count: companyInserts,
      unit: "row",
      destroys: false,
      detail: `${String(companyInserts)} companies are created, keeping the ids, names and `
        + "dates the export recorded. Nothing already here is changed.",
      sources: [companiesMember.ref],
      knownOwners: owners,
      reverseCellTransform,
    });
  }
  if (contactInserts > 0) {
    effects.push({
      op: "insert-contacts",
      subject: "contacts",
      count: contactInserts,
      unit: "row",
      destroys: false,
      detail: `${String(contactInserts)} contacts are created, linked to their companies by the `
        + "ids the export recorded. Nothing already here is changed.",
      sources: [contactsMember.ref],
      knownOwners: owners,
      reverseCellTransform,
    });
  }

  return newPlan<ImportEffect>({
    kind: "import-export",
    source: planSource(file, payload),
    effects,
    findings,
    now,
  });
}

/** SHA-256 of one staged member, streamed. Nothing is held whole. */
async function digestOfMember(payload: StagedPayload, ref: StagedMemberRef): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of await payload.open(ref)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

/**
 * Read one sheet end to end and answer what the plan needs to know about it.
 *
 * THE IDS ARE HELD AND NOTHING ELSE IS. A sheet's rows are not kept -- apply
 * reads the member again -- so the resident cost is one uuid per record, about
 * 10MB for a sheet of 200,000. The ids are what "already here?" and "does this
 * archive repeat itself?" are both answered from, and neither can be answered
 * without the whole set.
 */
async function scanSheet(
  payload: StagedPayload,
  ref: StagedMemberRef,
  required: readonly string[],
  unescape: boolean,
  build: (cells: Cells, owners: ReadonlySet<string>) => Built<{ id: string }>,
  linkColumn: string | null,
): Promise<SheetScan> {
  // EMPTY ON PURPOSE. The scan asks whether a record is USABLE, and that
  // question does not depend on whether its owner exists -- an unknown owner
  // makes a row unowned, never unreadable. The owner ids are gathered here and
  // resolved once, against the database, after both sheets have been read.
  const noOwnersYet = new Set<string>();
  const ids: string[] = [];
  const owners: string[] = [];
  const interned = new Map<string, string>();
  const companyLinks = new Set<string>();
  const bad: BadRecord[] = [];
  let records = 0;
  let badCount = 0;
  const stream = await payload.open(ref);
  for await (const { record, cells } of sheetRecords(stream, required, unescape)) {
    records += 1;
    const built = build(cells, noOwnersYet);
    if ("reason" in built) {
      badCount += 1;
      if (bad.length < MAX_FINDINGS_PER_CODE) bad.push({ record, reason: built.reason });
      continue;
    }
    ids.push(built.row.id);
    const owner = cells("owner_user_id");
    const seen = interned.get(owner);
    if (seen === undefined) interned.set(owner, owner);
    owners.push(seen ?? owner);
    if (linkColumn !== null) {
      const link = cells(linkColumn);
      if (link !== "") companyLinks.add(link);
    }
  }
  return { records, ids, owners, companyLinks, bad, badCount };
}

/**
 * Which of these ids the table already holds, asked in batches.
 *
 * BATCHED BECAUSE THE LIST IS THE ARCHIVE'S, not this code's: an install with
 * 200,000 contacts would otherwise build one `id = ANY($1)` with 200,000
 * elements. An empty list asks nothing at all rather than sending a query whose
 * answer is known.
 */
async function existingIds(
  db: Database,
  table: typeof companies | typeof contacts | typeof users,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let at = 0; at < ids.length; at += PROBE_BATCH_IDS) {
    const batch = ids.slice(at, at + PROBE_BATCH_IDS);
    if (batch.length === 0) continue;
    const rows = await db.select({ id: table.id }).from(table).where(inArray(table.id, batch));
    for (const row of rows) found.add(row.id);
  }
  return found;
}

/**
 * How many rows that WILL be inserted name an owner this install does not have.
 *
 * ROWS, NOT OWNERS, and the rows already here are excluded: those are not
 * imported at all, so counting them would put a number in the preview that no
 * part of the import acts on.
 */
function countUnowned(
  scan: SheetScan, knownOwners: ReadonlySet<string>, alreadyHere: ReadonlySet<string>,
): number {
  let unowned = 0;
  for (let at = 0; at < scan.ids.length; at += 1) {
    const owner = scan.owners[at] ?? "";
    if (owner === "" || knownOwners.has(owner)) continue;
    if (alreadyHere.has(scan.ids[at] ?? "")) continue;
    unowned += 1;
  }
  return unowned;
}

/** Every distinct owner id a scan's valid rows named. */
function distinctOwners(scan: SheetScan): string[] {
  return [...new Set(scan.owners.filter((owner) => owner !== ""))];
}

function pushSkipFindings(findings: PlanFindingView[], subject: string, skipped: number): void {
  if (skipped === 0) return;
  findings.push({
    severity: "note",
    code: IMPORT_FINDINGS.alreadyPresent,
    message: `${String(skipped)} ${subject} in this export are already in this install and are `
      + "left exactly as they are; the import does not overwrite them.",
  });
}

function pushBadFindings(findings: PlanFindingView[], member: string, scan: SheetScan): void {
  for (const record of scan.bad) {
    findings.push({
      severity: "warning",
      code: IMPORT_FINDINGS.rowUnreadable,
      message: `${member} record ${String(record.record)} is not imported because ${record.reason}.`,
    });
  }
  if (scan.badCount > scan.bad.length) {
    findings.push({
      severity: "warning",
      code: IMPORT_FINDINGS.rowUnreadable,
      message: `${String(scan.badCount)} records of ${member} are not imported for reasons like `
        + "those above; the first few are listed.",
    });
  }
}

function pushOwnerFindings(findings: PlanFindingView[], subject: string, unresolved: number): void {
  if (unresolved === 0) return;
  findings.push({
    severity: "warning",
    code: IMPORT_FINDINGS.ownerUnknown,
    message: `${String(unresolved)} of the people who owned these ${subject} do not exist on this `
      + "install, and the export does not carry them. Those rows arrive with no owner and can be "
      + "assigned by hand.",
  });
}

// --- apply -----------------------------------------------------------------

export interface ApplyImportOptions {
  plan: ImportPlan;
  /** The staging the plan was built from. apply reads only what its effects name. */
  payload: StagedPayload;
  db: Database;
}

/**
 * ADD THE ROWS, IN ONE TRANSACTION, AND NOTHING THE PLAN DID NOT DESCRIBE.
 *
 * THE TRANSACTION IS OPENED HERE AND NOT BY THE FRAME, which is
 * services/intake-plan.ts's own decision: "apply runs in one transaction" is
 * the spine's rule, but the unit differs -- restore's is a psql child process,
 * this one's is a drizzle transaction over this process's pool. Every effect
 * receives the same carrier, and any throw -- a handler's, the frame's
 * accounting, or a foreign key -- leaves through this call and rolls the whole
 * import back.
 *
 * COMPANIES BEFORE CONTACTS, and the order is the plan's rather than this
 * function's: applyPlan runs the effects in plan order, and inspectImport built
 * them in that order because a contact's company_id is checked at INSERT time.
 */
export async function applyImport(options: ApplyImportOptions): Promise<ApplyOutcome> {
  const { plan, payload, db } = options;
  return await db.transaction(async (tx) => {
    const handlers: EffectHandlers<ImportEffect, ImportCarrier> = {
      "insert-companies": async (effect, ctx) => {
        await insertSheet(effect, ctx, {
          member: COMPANIES_MEMBER,
          columns: COMPANY_COLUMNS,
          build: buildCompany,
          write: async (carrier, batch) =>
            (await carrier.tx.insert(companies).values(batch)
              .onConflictDoNothing({ target: companies.id })
              .returning({ id: companies.id })).length,
        });
      },
      "insert-contacts": async (effect, ctx) => {
        await insertSheet(effect, ctx, {
          member: CONTACTS_MEMBER,
          columns: CONTACT_COLUMNS,
          build: buildContact,
          write: async (carrier, batch) =>
            (await carrier.tx.insert(contacts).values(batch)
              .onConflictDoNothing({ target: contacts.id })
              .returning({ id: contacts.id })).length,
        });
      },
    };
    return await applyPlan<ImportEffect, ImportCarrier>({
      plan, reader: payload, handlers, carrier: { tx },
    });
  });
}

/**
 * The body both insert steps share: read the member this effect names, build
 * the rows the same way inspect did, write them in batches, and account.
 *
 * TWO LAYERS GUARD THE COUNT, AND THE OUTER ONE IS HERE BECAUSE THE FRAME'S
 * NAMES THE WRONG CULPRIT. services/intake-plan.ts already refuses a handler
 * that spends more than its effect's count, and refuses one that returns having
 * spent less -- so an insert that lands the wrong number of rows cannot pass
 * either way. But PlanExceededError means "a step did something its plan did
 * not describe", which is a BUG IN THIS FILE, and the ordinary cause of a
 * mismatch here is not: it is a row that became a duplicate, or stopped being
 * one, while the operator read the preview. So the comparison is made first and
 * answered with ImportDatabaseChangedError, which says that and says to take a
 * fresh preview.
 *
 * THE ACCOUNTING IS SPENT ONCE, AT THE END, RATHER THAN PER BATCH, and that is
 * the one place this diverges from the frame's "fail at the moment it exceeds
 * it" advice. It can, because everything here is inside ONE transaction: a
 * batch that overshot has written nothing durable, so there is nothing to be
 * gained by stopping at it and something to be lost -- spending per batch would
 * let the frame's error fire first on the over-count path, and the operator
 * would be told their importer is broken when their database merely moved.
 * Deleting the comparison below does NOT make either direction pass; it makes
 * both arrive as PlanExceededError. There is a test for each direction, and a
 * test that shows which layer fired.
 */
async function insertSheet<T>(
  effect: ImportEffect,
  ctx: ApplyContext<ImportCarrier>,
  sheet: {
    member: string;
    columns: readonly string[];
    build: (cells: Cells, owners: ReadonlySet<string>) => Built<T>;
    write: (carrier: ImportCarrier, batch: T[]) => Promise<number>;
  },
): Promise<void> {
  const source = effect.sources?.[0];
  if (source === undefined) {
    throw new Error(`the ${effect.op} step has no ${sheet.member} to read`);
  }
  const owners = new Set(effect.knownOwners);
  const stream = await ctx.open(source);
  let inserted = 0;
  let batch: T[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const wrote = await sheet.write(ctx.carrier, batch);
    batch = [];
    inserted += wrote;
  };
  for await (const { cells } of sheetRecords(stream, sheet.columns, effect.reverseCellTransform)) {
    const built = sheet.build(cells, owners);
    // THE SAME RECORDS INSPECT SKIPPED, SKIPPED AGAIN, because it is the same
    // function deciding. A record inspect could not read is not counted in the
    // effect, so writing it here would be work the operator never previewed.
    if ("reason" in built) continue;
    batch.push(built.row);
    if (batch.length >= INSERT_BATCH_ROWS) await flush();
  }
  await flush();
  if (inserted !== effect.count) {
    throw new ImportDatabaseChangedError(effect.subject, effect.count, inserted);
  }
  ctx.spend(inserted);
}
