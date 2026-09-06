import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import yazl from "yazl";
import { decimalFromCents } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { readMigrationJournal } from "./migration-journal.js";
import {
  companies, contacts, deals, documentAgreements, documentLetters, documentQuotes, documents,
  files, meetingAttendees, meetings,
  notes, pipelines, projects, stages, tasks, timeEntries, users,
} from "../db/schema.js";
import { csvDocument } from "./csv.js";

// THE READABLE HALF (7.6 Task 1). A plain ZIP the operator opens in Excel: one
// CSV per entity, the stored files under files/, and a manifest.json.
//
// IT IS NOT RESTORABLE, AND THAT IS THE POINT. The backup (Task 2) is the exact
// artefact; this one is the legible one, and Task 3's Settings page says so in
// words next to both buttons. Two similar-looking downloads is exactly how
// someone ends up with three years of tidy CSVs and no way to put Conduit back.
//
// SINCE 7.7 THAT CLAIM HAS A LITERAL COUNTERPART, and it is worth saying here
// because "not restorable" used to be an abstraction and is not any more. The
// same Settings page now RESTORES, and what it restores is a `.7z` carrying
// database.sql, mail.key and the blob store -- none of which is in this file.
// An archive written here that reached the restore is refused before anything
// is touched, by services/restore.ts's RESTORE_REFUSALS.notABackup.
//
// HOW THAT REFUSAL ACTUALLY FIRES, written down because it is not what it
// looks like. The check is `manifest.kind !== "backup"`, and ExportManifest
// below HAS NO `kind` FIELD -- so what refuses an export is the field being
// ABSENT, not a declaration of what it is. That is the stricter of the two
// behaviours (anything whose manifest does not positively say "backup" is
// refused) and it needs no change; it is recorded here because a reader of
// either module could reasonably infer that this file writes `kind: "export"`,
// and it does not. Adding one would be a change to a versioned format that
// 7.7's exact importer reads, so it is a decision rather than a tidy-up.
// (It said "7.8's" until that importer was built, in 7.7, alongside restore.)
//
// SINCE 7.7 THIS ARCHIVE HAS A READER: services/import-export.ts. Two things
// there are worth knowing here, because both are properties of what this file
// WRITES rather than of what that file reads:
//
//   THE MANIFEST'S ABSENT `kind` IS WHAT THE IMPORTER REFUSES A BACKUP ON, from
//   the other side -- `manifest.kind === "backup"` sends the operator to
//   Restore. The two refusals are a matched pair and neither is a default.
//
//   THE EXPORT IS NOT A COMPLETE DESCRIPTION OF THE DATA, and the importer is
//   what made that concrete. It reads TWO of the ten sheets. The other eight
//   name rows whose NOT NULL columns or foreign keys are not in this archive at
//   all -- there is no pipelines.csv, no stages.csv, no users, no fractional
//   `position`, no document_line_items, and meeting attendees are flattened to
//   display names. That is a gap in this format rather than in the reader; the
//   list is in services/import-export.ts's header and in the backlog, and
//   closing it is a formatVersion 2. (Nine until Phase 10; time_entries.csv is
//   the tenth, and it is in the importer's NOT_IMPORTED list for the same
//   reason notes.csv is -- an entry's owner is a Conduit user the archive does
//   not carry.)
//
// The page draws the same line in words, because the failure being designed
// against is somebody reaching for the wrong artefact at the moment they most
// need the right one.
//
// WHAT IS DELIBERATELY ABSENT, and none of it is an oversight:
//
//   - NO CREDENTIALS. mail_accounts is never queried, so no encrypted password
//     and no host/username pair leaves in this file.
//   - NO mail.key. It sits in $data_dir beside the blob store and this module
//     never reads $data_dir directly -- see the files/ note below.
//   - NO MAIL BODIES, and no mail attachments. Bodies are enormous, they
//     already exist on the mail server, and nobody wants them in a
//     spreadsheet. A restore that lost them would be wrong, which is why they
//     are in the backup instead.
//
// Those three absences are what make this archive safe to hand to anyone, which
// is in turn why it needs no passphrase. They are guarded by tests, not by this
// comment: an export taken from an install that HAS a mail.key, HAS mail
// accounts and HAS mail attachments on disk is asserted to contain none of them.
//
// THE files/ MEMBERS COME FROM THE `files` TABLE, NEVER FROM $data_dir/files.
// That distinction is the whole of the mail-attachment guarantee and it is one
// character of code apart from getting it wrong. The blob store is shared:
// mail_attachments.blob_path addresses blobs in the same content-addressed
// directory that files.sha256 does. Reading the DIRECTORY would sweep up every
// attachment of every message; reading the TABLE gets uploaded files and issued
// document PDFs and nothing else. (An issued document's PDF is an ordinary
// `files` row against the record the document belongs to -- its deal for a
// quote, its meeting for a summary since Phase 9 -- see documents.file_id, so
// "the stored files and issued quote PDFs" of the spec is one query, not two.)

/**
 * The layout version of the archive itself, bumped when a member is renamed,
 * a column is removed, or the CSV dialect changes -- not when a column is
 * added, which every reader tolerates.
 *
 * Recorded in manifest.json so 7.7's exact importer has something to branch on
 * that is not "guess from the column headers".
 *
 * **PHASE 10 ADDED A MEMBER AND DID NOT BUMP THIS, WHICH THE RULE ABOVE DID NOT
 * QUITE COVER.** `time_entries.csv` is a new sheet, and a new sheet is additive
 * in exactly the way a new column is: every existing reader finds every member
 * it knew about, unchanged, and ignores the one it does not. Bumping would have
 * cost something real -- services/import-export.ts refuses any archive whose
 * formatVersion exceeds the running build's, so a version 2 export could not be
 * read back by a v1.8.0 install for no benefit at all, since nothing branches on
 * the difference. The version moves when an old reader would be WRONG about what
 * it is holding, not when it merely knows less than a new one.
 */
export const EXPORT_FORMAT_VERSION = 1;

/** One archive member, as manifest.json records it. */
export interface ExportManifestMember {
  /** The member's path inside the archive, exactly as a reader will see it. */
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * One transformation applied to CELL VALUES on the way out, named and versioned
 * so 7.7's exact importer can undo it deterministically rather than inferring
 * it from the data.
 *
 * DECLARED RATHER THAN SILENT, on the coordinator's ruling. An export that
 * quietly rewrites the operator's notes is not acceptable; one that says
 * exactly what it rewrote, and how to reverse it, is.
 */
export interface ExportCellTransform {
  name: string;
  version: number;
  /** What was done, and the rule that undoes it. */
  description: string;
}

/**
 * The apostrophe escape csv.ts applies to every cell, as manifest.json records
 * it. `unescapeCellValue` in services/csv.ts is the executable form of the
 * sentence below, and csv.test.ts asserts the round trip over a table.
 */
export const EXPORT_CELL_TRANSFORM: ExportCellTransform = {
  name: "leading-apostrophe-escape",
  version: 1,
  description:
    "A cell value is prefixed with one apostrophe when it already begins with an "
    + "apostrophe, or when -- after any leading whitespace and an optional run of "
    + "+ or - -- it begins with = or @. To recover the stored value, remove exactly "
    + "one leading apostrophe if the cell has one. Applied to every cell of every CSV.",
};

export interface ExportManifest {
  formatVersion: number;
  appVersion: string;
  /**
   * The migration journal position: the tag of the last migration in
   * packages/api/drizzle/meta/_journal.json, e.g. "0013_wide_wolverine".
   * That names the shape the columns below were read out of.
   */
  schemaVersion: string;
  /** When the export was taken, ISO 8601 UTC. */
  generatedAt: string;
  /**
   * Every value-level transformation the CSVs carry. Read this before treating
   * a cell as the stored value.
   */
  cellTransforms: ExportCellTransform[];
  /**
   * Every member EXCEPT manifest.json, which cannot carry its own digest.
   *
   * The digest is what makes a truncated download detectable: the archive's
   * central directory is at its end, so a cut-short zip does not open at all,
   * but a zip that opens and whose members do not hash to these values has been
   * damaged some other way -- on the disk it was written to, or in the blob
   * store it was read from.
   */
  members: ExportManifestMember[];
}

/**
 * Windows will not create a file whose stem is one of these, whatever the
 * extension -- extracting `CON.pdf` fails there with a message about the name
 * being reserved. The audience for this archive is a person with a spreadsheet,
 * which is to say very often a person on Windows, so the rename happens here
 * where it can be recorded in files.csv rather than at extraction time where it
 * cannot.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Whether Win32 would resolve this name to a device rather than a file.
 *
 * THE SEGMENT IS TAKEN UP TO THE FIRST DOT, not the last, and that distinction
 * is the whole of the fix. Win32 stops at the first one, so `CON.tar.gz`,
 * `COM1.tar.gz` and `nul.a.b` are every bit as reserved as `CON.pdf` -- while
 * splitExtension, which exists to keep a collision suffix in front of the
 * extension, correctly splits at the LAST dot and so answered `tar.gz`,
 * `tar.gz` and `a.b` for those three. Trailing spaces go too, because Win32
 * discards them before resolving: `"CON .pdf"` is the device.
 */
function isWindowsReserved(name: string): boolean {
  const firstSegment = (name.split(".")[0] ?? "").replace(/ +$/, "");
  return WINDOWS_RESERVED.test(firstSegment);
}

/**
 * The longest member name this produces, before the collision suffix. Chosen to
 * leave room under the 255-byte limit every common filesystem has, counted in
 * BYTES rather than characters because a name of accented characters costs two
 * bytes each and this export exists to carry exactly those.
 */
const MAX_NAME_BYTES = 180;

/**
 * A stored file's original name, made safe to extract on any of the three
 * platforms the spec names, WITHOUT flattening the accents.
 *
 * Keeping non-ASCII is the requirement, not a nicety: an archive that turned
 * `Angebot-Mueller.pdf` -- with the umlaut -- into `Angebot-M_ller.pdf` would
 * be failing the same test the BOM exists to pass, one directory over. yazl
 * writes every member name as UTF-8 and sets the general-purpose bit that says
 * so, so the accents survive the archive; this function only removes what a
 * FILESYSTEM will not accept.
 */
export function archiveFileName(originalName: string): string {
  // Take the last path segment under either separator. An uploaded name is
  // supposed to be a bare filename, but it arrives from a browser's multipart
  // body and a name of "../../etc/passwd" must become "passwd" rather than an
  // archive member that escapes its directory when extracted.
  const base = originalName.split(/[/\\]/).pop() ?? "";
  // Two passes over what a FILESYSTEM refuses, spelled as escapes so this file
  // stays ASCII: control characters, which would be invisible in a name even
  // where one is accepted, and the five printable bytes Windows forbids. The
  // path separators are already gone.
  const cleaned = base
    .replaceAll(/[\u0000-\u001F\u007F]/g, "_")
    .replaceAll(/[<>:"|?*]/g, "_")
    // Windows silently drops trailing dots and spaces, so a name ending in one
    // extracts to a DIFFERENT name than the archive and files.csv record.
    .replace(/[. ]+$/, "");
  // "." and ".." are not names, and neither is the empty string.
  const named = cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
  const truncated = truncateToBytes(named, MAX_NAME_BYTES);
  return isWindowsReserved(truncated) ? `_${truncated}` : truncated;
}

/** The name split at its LAST dot, with a leading dot never treated as one. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * Cut a string to a byte budget without splitting a character in half.
 *
 * TWO WAYS TO GET THIS WRONG, and both produce the same replacement character
 * in a filename this archive exists to carry intact.
 *
 * Cutting the BUFFER (Buffer.subarray to `budget` bytes) leaves a partial UTF-8
 * sequence at the cut whenever the character width does not divide into the
 * budget -- 176 bytes against three-byte characters, say.
 *
 * Cutting the STRING one unit at a time (`slice(0, -1)`) is right for everything
 * inside the BMP and wrong above it: JavaScript indexes strings by UTF-16 code
 * unit, so one slice off the end of a name of emoji removes half a surrogate
 * pair, and a lone surrogate encodes as U+FFFD too.
 *
 * So the walk is over CODE POINTS -- what `for...of` on a string yields -- and
 * it adds them up forward rather than trimming backward, which is also one pass
 * instead of one per character removed.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const { stem, extension } = splitExtension(value);
  const budget = Math.max(1, maxBytes - Buffer.byteLength(extension, "utf8"));
  let bytes = 0;
  let cut = "";
  for (const point of stem) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    cut += point;
  }
  return cut + extension;
}

/**
 * Hands out a member path that no earlier member already holds, disambiguating
 * as `report (2).pdf` rather than by mangling the whole name.
 *
 * COLLISIONS ARE COMPARED CASE-INSENSITIVELY even though the archive itself is
 * case-sensitive, because the filesystem the archive is EXTRACTED onto usually
 * is not. Two files legitimately named `Report.pdf` and `report.pdf` are
 * distinct rows here and distinct members in the zip, and on Windows or a
 * default macOS volume the second silently overwrites the first on extraction.
 * Deduping on the lowercased name is what stops one of the operator's documents
 * disappearing during the one operation that was supposed to preserve it.
 *
 * AND UNICODE-NORMALISED, WHICH IS THE SAME BUG ONE CLASS OVER AND WAS MISSED
 * THE FIRST TIME. `toLowerCase()` does not normalise, so an accented name in
 * NFC and the same name in NFD compare as different keys, get the same member
 * path, and the second overwrites the first on extraction -- measured with real
 * `unzip`: two members, one file on disk, and files.csv still naming both paths
 * with one of them now pointing at the wrong bytes. A mixed corpus is ordinary
 * rather than exotic: macOS uploads have historically carried NFD filenames
 * while Windows and Linux carry NFC. On an archive whose stated purpose is
 * carrying accented filenames, this is the failure the case rule exists to
 * prevent, reached through the other door.
 *
 * The KEY is normalised; the member NAME is not. Normalising the name would
 * rewrite bytes the operator chose, and `files.csv` keeps `original_name`
 * either way -- what has to be true is only that two distinct rows never claim
 * one path.
 */
function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function createNamer(): (originalName: string) => string {
  const taken = new Set<string>();
  return (originalName: string): string => {
    const safe = archiveFileName(originalName);
    if (!taken.has(collisionKey(safe))) {
      taken.add(collisionKey(safe));
      return safe;
    }
    const { stem, extension } = splitExtension(safe);
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${extension}`;
      if (!taken.has(collisionKey(candidate))) {
        taken.add(collisionKey(candidate));
        return candidate;
      }
    }
  };
}

// --- Cell formatting -----------------------------------------------------
//
// Every column of every CSV is built through one of these, so there is one
// answer per column TYPE rather than one per call site. csv.ts owns the dialect
// (what gets quoted); these own the representation (what the value looks like
// before it is quoted). Deliberately uncounted, following money-format.ts: a
// count in a comment above a list is a number that drifts the first time the
// list grows.

/**
 * A nullable text column. NULL and the empty string both become empty.
 *
 * `undefined` too, since Phase 9: documents.csv LEFT JOINs `document_quotes`, so
 * its quote cells arrive through an optional chain and are `string | undefined`
 * rather than `string | null`. Widening the parameter keeps every such cell going
 * through the one formatter instead of sprouting `?? null` at the call sites,
 * which is the arrangement this block exists to hold.
 */
function text(value: string | null | undefined): string {
  return value ?? "";
}

/**
 * A `timestamp with time zone`, as ISO 8601 in UTC.
 *
 * Deliberately NOT a spreadsheet-native date: a spreadsheet parses a bare
 * `2026-08-31` into a date cell and would parse a localised datetime into one
 * too, at which point the value shown depends on the reader's locale and its
 * offset is gone. The ISO string stays text in every spreadsheet, reads the
 * same everywhere, and keeps the offset -- and the columns that ARE bare dates
 * in Postgres (issue_date, due_date) still arrive as bare dates and still parse
 * as dates, so the two kinds of column stay visibly different in the file.
 */
function timestamp(value: Date | null): string {
  return value === null ? "" : value.toISOString();
}

/**
 * Integer cents as a plain decimal string: 1250 becomes "12.50", -1250 becomes
 * "-12.50".
 *
 * NEVER A FLOAT, and never `cents / 100`. The decimal is built out of the
 * integer with BigInt by @conduit/shared's decimalFromCents -- the same
 * arithmetic the quote form and the rendered PDF use -- so an amount that
 * outruns double precision comes out with every digit intact instead of the
 * nearest representable neighbour.
 *
 * No grouping separator and no currency symbol, unlike formatMoneyCents, and
 * both omissions are on purpose: a spreadsheet parses `12.50` as a number and
 * `EUR 1,234.56` as text. The currency is its own column beside the amount.
 */
function money(cents: number | null): string {
  return cents === null ? "" : decimalFromCents(cents);
}

/**
 * A text[] column, one entry per line inside a single quoted cell.
 *
 * Newline rather than a `; ` separator because a separator has to be a
 * character the values cannot contain, and while an email address cannot
 * contain a newline it certainly can contain a semicolon. RFC 4180 quotes the
 * cell, every spreadsheet shows the entries on separate lines within it, and
 * nothing has to be escaped.
 */
function list(values: readonly string[]): string {
  return values.join("\n");
}

/** A jsonb column, compact, so the cell is one line of readable JSON. */
function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/** A person's display name, for the denormalised `*_name` columns. */
function contactName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter((part) => part !== null && part !== "").join(" ");
}

// --- The entity tables ---------------------------------------------------
//
// THE IDS ARE KEPT AND A READABLE NAME IS ADDED BESIDE EACH ONE. A column of
// `stage_id` uuids tells a person with a spreadsheet nothing at all, and this
// archive's entire justification is that a person with a spreadsheet can read
// it. The uuid stays so the CSVs can still be joined to each other; the name is
// what makes the join unnecessary for reading.
//
// ARCHIVED ROWS ARE INCLUDED, with archived_at populated. Conduit never
// expunges, so an export that quietly dropped them would be a smaller and
// wronger picture of the data than the database holds. None of the selects
// below filters on archived_at, and a test asserts that for every table that
// has the column.

interface Sheet {
  /** The member name, e.g. "companies.csv". */
  name: string;
  header: readonly string[];
  rows: readonly (readonly string[])[];
}

async function companiesSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({ c: companies, ownerUsername: users.username })
    .from(companies)
    .leftJoin(users, eq(companies.ownerUserId, users.id))
    .orderBy(companies.createdAt, companies.id);
  return {
    name: "companies.csv",
    header: [
      "id", "name", "domain", "website", "phone", "address", "industry",
      "owner_user_id", "owner_username", "custom", "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map(({ c, ownerUsername }) => [
      c.id, c.name, text(c.domain), text(c.website), text(c.phone), text(c.address), text(c.industry),
      text(c.ownerUserId), text(ownerUsername), json(c.custom),
      timestamp(c.archivedAt), timestamp(c.createdAt), timestamp(c.updatedAt),
    ]),
  };
}

async function contactsSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({ ct: contacts, companyName: companies.name, ownerUsername: users.username })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .leftJoin(users, eq(contacts.ownerUserId, users.id))
    .orderBy(contacts.createdAt, contacts.id);
  return {
    name: "contacts.csv",
    header: [
      "id", "first_name", "last_name", "salutation", "pronouns", "job_title",
      "company_id", "company_name", "emails", "phones",
      "owner_user_id", "owner_username", "custom", "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map(({ ct, companyName, ownerUsername }) => [
      ct.id, ct.firstName, text(ct.lastName), text(ct.salutation), text(ct.pronouns), text(ct.jobTitle),
      text(ct.companyId), text(companyName), list(ct.emails), list(ct.phones),
      text(ct.ownerUserId), text(ownerUsername), json(ct.custom),
      timestamp(ct.archivedAt), timestamp(ct.createdAt), timestamp(ct.updatedAt),
    ]),
  };
}

async function dealsSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({
      d: deals, pipelineName: pipelines.name, stageName: stages.name,
      companyName: companies.name, contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      ownerUsername: users.username,
    })
    .from(deals)
    .leftJoin(pipelines, eq(deals.pipelineId, pipelines.id))
    .leftJoin(stages, eq(deals.stageId, stages.id))
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(users, eq(deals.ownerUserId, users.id))
    .orderBy(deals.createdAt, deals.id);
  return {
    name: "deals.csv",
    header: [
      "id", "title", "pipeline_id", "pipeline_name", "stage_id", "stage_name",
      "value", "currency", "expected_close_date", "status", "lost_reason", "closed_at",
      "owner_user_id", "owner_username", "company_id", "company_name", "contact_id", "contact_name",
      "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map((r) => [
      r.d.id, r.d.title, r.d.pipelineId, text(r.pipelineName), r.d.stageId, text(r.stageName),
      money(r.d.valueCents), r.d.currency, text(r.d.expectedCloseDate), r.d.status,
      text(r.d.lostReason), timestamp(r.d.closedAt),
      text(r.d.ownerUserId), text(r.ownerUsername), text(r.d.companyId), text(r.companyName),
      text(r.d.contactId), contactName(r.contactFirstName, r.contactLastName),
      timestamp(r.d.archivedAt), timestamp(r.d.createdAt), timestamp(r.d.updatedAt),
    ]),
  };
}

async function projectsSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({ p: projects, companyName: companies.name, dealTitle: deals.title, ownerUsername: users.username })
    .from(projects)
    .leftJoin(companies, eq(projects.companyId, companies.id))
    .leftJoin(deals, eq(projects.dealId, deals.id))
    .leftJoin(users, eq(projects.ownerUserId, users.id))
    .orderBy(projects.createdAt, projects.id);
  return {
    name: "projects.csv",
    header: [
      "id", "name", "company_id", "company_name", "deal_id", "deal_title",
      "owner_user_id", "owner_username", "status", "start_date", "due_date", "color",
      "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map((r) => [
      r.p.id, r.p.name, text(r.p.companyId), text(r.companyName), text(r.p.dealId), text(r.dealTitle),
      text(r.p.ownerUserId), text(r.ownerUsername), r.p.status,
      text(r.p.startDate), text(r.p.dueDate), text(r.p.color),
      timestamp(r.p.archivedAt), timestamp(r.p.createdAt), timestamp(r.p.updatedAt),
    ]),
  };
}

async function tasksSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({
      t: tasks, assigneeUsername: users.username, companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeUserId, users.id))
    .leftJoin(companies, eq(tasks.companyId, companies.id))
    .leftJoin(contacts, eq(tasks.contactId, contacts.id))
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .orderBy(tasks.createdAt, tasks.id);
  return {
    name: "tasks.csv",
    header: [
      "id", "title", "description", "type", "status",
      "assignee_user_id", "assignee_username", "start_date", "due_date", "completed_at", "progress_pct",
      "parent_task_id", "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "project_id", "project_name",
      "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map((r) => [
      r.t.id, r.t.title, text(r.t.description), r.t.type, r.t.status,
      text(r.t.assigneeUserId), text(r.assigneeUsername),
      text(r.t.startDate), text(r.t.dueDate), timestamp(r.t.completedAt),
      r.t.progressPct === null ? "" : String(r.t.progressPct),
      text(r.t.parentTaskId), text(r.t.companyId), text(r.companyName),
      text(r.t.contactId), contactName(r.contactFirstName, r.contactLastName),
      text(r.t.dealId), text(r.dealTitle), text(r.t.projectId), text(r.projectName),
      timestamp(r.t.archivedAt), timestamp(r.t.createdAt), timestamp(r.t.updatedAt),
    ]),
  };
}

async function notesSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({
      n: notes, authorUsername: users.username, companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name,
    })
    .from(notes)
    .leftJoin(users, eq(notes.authorUserId, users.id))
    .leftJoin(companies, eq(notes.companyId, companies.id))
    .leftJoin(contacts, eq(notes.contactId, contacts.id))
    .leftJoin(deals, eq(notes.dealId, deals.id))
    .leftJoin(projects, eq(notes.projectId, projects.id))
    .orderBy(notes.createdAt, notes.id);
  return {
    name: "notes.csv",
    header: [
      "id", "body", "author_user_id", "author_username",
      "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "project_id", "project_name", "created_at",
    ],
    rows: rows.map((r) => [
      r.n.id, r.n.body, r.n.authorUserId, text(r.authorUsername),
      text(r.n.companyId), text(r.companyName),
      text(r.n.contactId), contactName(r.contactFirstName, r.contactLastName),
      text(r.n.dealId), text(r.dealTitle), text(r.n.projectId), text(r.projectName),
      timestamp(r.n.createdAt),
    ]),
  };
}

async function meetingsSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({
      m: meetings, ownerUsername: users.username, companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name,
    })
    .from(meetings)
    .leftJoin(users, eq(meetings.ownerUserId, users.id))
    .leftJoin(companies, eq(meetings.companyId, companies.id))
    .leftJoin(contacts, eq(meetings.contactId, contacts.id))
    .leftJoin(deals, eq(meetings.dealId, deals.id))
    .leftJoin(projects, eq(meetings.projectId, projects.id))
    .orderBy(meetings.occurredAt, meetings.id);

  // Attendees are folded into the meeting's own row rather than shipped as a
  // tenth CSV: an attendee has no identity of its own (no created_at, replaced
  // as a set on every edit -- see the table's comment in db/schema.ts), and a
  // file of join rows is the one shape a person with a spreadsheet cannot read.
  // One query for all of them, not one per meeting.
  const attendeeRows = await db
    .select({
      meetingId: meetingAttendees.meetingId, guestName: meetingAttendees.guestName,
      username: users.username, firstName: contacts.firstName, lastName: contacts.lastName,
    })
    .from(meetingAttendees)
    .leftJoin(users, eq(meetingAttendees.userId, users.id))
    .leftJoin(contacts, eq(meetingAttendees.contactId, contacts.id))
    .orderBy(meetingAttendees.meetingId, meetingAttendees.id);
  const attendeesByMeeting = new Map<string, string[]>();
  for (const a of attendeeRows) {
    const name = a.guestName ?? a.username ?? contactName(a.firstName, a.lastName);
    const existing = attendeesByMeeting.get(a.meetingId);
    if (existing === undefined) attendeesByMeeting.set(a.meetingId, [name]);
    else existing.push(name);
  }

  return {
    name: "meetings.csv",
    header: [
      "id", "title", "occurred_at", "duration_minutes", "notes_html", "attendees",
      "owner_user_id", "owner_username", "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "project_id", "project_name",
      "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map((r) => [
      r.m.id, r.m.title, timestamp(r.m.occurredAt),
      r.m.durationMinutes === null ? "" : String(r.m.durationMinutes),
      // The column is named notes_html, not notes, because that is what it
      // holds: sanitized rich text, exported verbatim. Flattening it to plain
      // text here would be the only lossy column in the file.
      text(r.m.notes), list(attendeesByMeeting.get(r.m.id) ?? []),
      r.m.ownerUserId, text(r.ownerUsername), text(r.m.companyId), text(r.companyName),
      text(r.m.contactId), contactName(r.contactFirstName, r.contactLastName),
      text(r.m.dealId), text(r.dealTitle), text(r.m.projectId), text(r.projectName),
      timestamp(r.m.archivedAt), timestamp(r.m.createdAt), timestamp(r.m.updatedAt),
    ]),
  };
}

/**
 * THE TIMESHEET, IN THE SAME CHANGE THAT CREATES THE TABLE.
 *
 * This function is Phase 10 Task 1's stated obligation and it is why the
 * obligation was written at the top of the plan rather than left to the
 * definition of done. The backup is a `pg_dump`, so `time_entries` is in it the
 * day it exists; this half walks no schema and has one hand-written function per
 * entity, so a table added without one of these is simply absent from the only
 * artefact an operator can read. **Phase 9's export was missed by three tasks
 * running** -- an INNER JOIN that silently dropped every meeting summary, a
 * letter exported with no body, and a status report naming no project -- and
 * "a timesheet trapped in the app" is the failure the whole export exists
 * against.
 *
 * EVERY COLUMN OF THE TABLE IS HERE, and export.test.ts asserts that against
 * `information_schema` rather than against this list, so Task 5's timer columns
 * cannot ship unexported the way Phase 9's did.
 *
 * THERE IS NO `hours` COLUMN, and that is a decision. Minutes are already
 * human-readable and a spreadsheet's own `=SUM(minutes)/60` is one keystroke; a
 * second stored representation of one number is how a CSV starts disagreeing
 * with itself the first time somebody edits one cell and not the other. The
 * money columns are the counter-example that proves the rule -- cents are stored
 * and are NOT readable, so they are converted, once, by the same arithmetic the
 * quote form uses.
 *
 * `billable` IS SPELLED "true"/"false", which is exactly how documents.csv
 * spells `frozen`, so the archive has one spelling for a boolean rather than a
 * second dialect in its tenth file.
 */
async function timeEntriesSheet(db: Database): Promise<Sheet> {
  const rows = await db
    .select({
      te: timeEntries, ownerUsername: users.username, companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name, taskTitle: tasks.title,
    })
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.ownerUserId, users.id))
    // ALL FIVE RECORD JOINS, PRESENT FROM THE FIRST VERSION. Phase 9's third
    // miss was a status report exported with `project_id` in a column that did
    // not exist, so nothing in the archive said which project the report was
    // about; an entry booked to a task, with no `task_title` here, would be the
    // identical failure on a table whose entire purpose is saying what the time
    // went on. LEFT, every one, because at-least-one means four of the five are
    // null on an ordinary row -- an INNER JOIN anywhere here would drop most of
    // the sheet, which is Phase 9's FIRST miss on the same file.
    .leftJoin(companies, eq(timeEntries.companyId, companies.id))
    .leftJoin(contacts, eq(timeEntries.contactId, contacts.id))
    .leftJoin(deals, eq(timeEntries.dealId, deals.id))
    .leftJoin(projects, eq(timeEntries.projectId, projects.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    // BY THE DAY THE WORK WAS DONE, not by created_at: this file is a timesheet,
    // and a reader scrolling it wants the days in order rather than the order
    // somebody happened to type them in. `id` is the tiebreaker that makes it
    // deterministic, exactly as everywhere else here.
    .orderBy(timeEntries.workDate, timeEntries.id);
  return {
    name: "time_entries.csv",
    header: [
      "id", "work_date", "minutes", "billable", "description",
      "owner_user_id", "owner_username",
      "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "project_id", "project_name", "task_id", "task_title",
      "archived_at", "created_at", "updated_at",
    ],
    rows: rows.map((r) => [
      // work_date is a bare `date`, so it arrives as the string Postgres stored
      // and goes out unchanged -- like issue_date and due_date elsewhere in this
      // file, and deliberately NOT through timestamp(), which would need a Date
      // and would turn a day into an instant in some time zone.
      r.te.id, r.te.workDate, String(r.te.minutes), r.te.billable ? "true" : "false",
      text(r.te.description),
      r.te.ownerUserId, text(r.ownerUsername),
      text(r.te.companyId), text(r.companyName),
      text(r.te.contactId), contactName(r.contactFirstName, r.contactLastName),
      text(r.te.dealId), text(r.dealTitle),
      text(r.te.projectId), text(r.projectName),
      text(r.te.taskId), text(r.taskTitle),
      timestamp(r.te.archivedAt), timestamp(r.te.createdAt), timestamp(r.te.updatedAt),
    ]),
  };
}

/**
 * `archivePathByFileId` maps every exported file's id to its member path, not
 * only the quote PDFs -- documents.csv is just the only sheet that needs the
 * reverse lookup, to get a reader from a quote number to the page that was sent.
 *
 * **A STATUS REPORT AND A MEETING SUMMARY EXPORT WITH EVERY CONTENT COLUMN
 * BLANK, AND THAT IS COMPLETE RATHER THAN LOSSY.** Both types have no detail
 * table, because neither holds a byte that was typed into the document: a
 * summary's content is the `meetings` row (meetings.csv), and a report's is a
 * `projects` row plus its `tasks` (projects.csv, tasks.csv). What is NOT
 * derivable from those is what the page SAID on the day it was produced -- a
 * report is a snapshot of state that has since moved -- and that is in the
 * archive too, as the PDF at `file_archive_path`. The one type whose content
 * would genuinely have been lost is the letter, whose body exists nowhere else,
 * and Task 3 added the six columns that carry it.
 */
async function documentsSheet(db: Database, archivePathByFileId: ReadonlyMap<string, string>): Promise<Sheet> {
  const rows = await db
    .select({
      doc: documents, quote: documentQuotes, letter: documentLetters,
      agreement: documentAgreements,
      companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, meetingTitle: meetings.title,
      documentProjectName: projects.name,
      issuedByUsername: users.username,
    })
    .from(documents)
    // **LEFT SINCE PHASE 9, AND THIS IS THE DECISION THE OLD COMMENT ASKED FOR.**
    // It was an INNER JOIN, with a note saying "the header below is a quote's
    // header; when a second type has rows, this file needs a decision about what
    // its sheet looks like rather than a join that quietly emits blanks in the
    // money columns". The second type has rows. An INNER JOIN now DROPS every
    // meeting summary from the export -- silently, from the one artefact whose
    // whole justification is that an operator can read all of their data out of
    // it -- and that is a worse outcome than a blank cell.
    //
    // WHAT MAKES THE BLANKS HONEST RATHER THAN QUIET is the `type` column, which
    // was always here: a row saying `meeting_summary` with no currency and no
    // totals is describing a document that has none, and the reader can see which
    // it is. The objection the old comment raised -- a quote whose money silently
    // went missing -- is not reachable through this join: `document_quotes.document_id`
    // is the primary key AND the foreign key, written in the same transaction as
    // its `documents` row, so a quote without a detail row does not occur.
    //
    // ONE ROW PER DOCUMENT, and the alternative was two sheets (a common
    // documents.csv plus a document_quotes.csv, mirroring the tables). Rejected:
    // it moves eleven columns an operator already knows out of the file they are
    // in, to spare some blanks in a file that has `type` in the third column.
    .leftJoin(documentQuotes, eq(documentQuotes.documentId, documents.id))
    // **THE SAME LESSON, ONE TASK ON, AND IT WOULD HAVE BEEN THE SAME BUG.** Task
    // 2 found this sheet's INNER JOIN silently dropping every meeting summary and
    // made it a LEFT one; these two tables arrive with Task 3 and are LEFT for the
    // same reason, but the failure they avoid is a different and quieter one. A
    // missing join here would not have dropped a row -- a letter's `documents`
    // row would still come out -- it would have exported the letter with its
    // subject, its addressee and its BODY absent, which is the one thing about a
    // letter that exists nowhere else in the archive. The row would look fine.
    .leftJoin(documentLetters, eq(documentLetters.documentId, documents.id))
    .leftJoin(documentAgreements, eq(documentAgreements.documentId, documents.id))
    // THE COMPANY AND THE CONTACT, WHICH THIS SHEET HAS NEVER HAD, and their
    // absence stopped being harmless with Task 3. Until now every document was of
    // a deal or of a meeting, so `deal_id` and `meeting_id` covered the file; a
    // letter is of a company or a contact, so without these a letter's row names
    // no record at all -- an operator reading the archive could not tell who it
    // was addressed to from the sheet that is supposed to say.
    .leftJoin(companies, eq(documents.companyId, companies.id))
    .leftJoin(contacts, eq(documents.contactId, contacts.id))
    .leftJoin(deals, eq(documents.dealId, deals.id))
    .leftJoin(meetings, eq(documents.meetingId, meetings.id))
    // **THE PROJECT, WHICH IS THE FIFTH AND LAST OF THE RECORD JOINS, AND THE
    // THIRD TASK RUNNING TO FIND THIS SHEET A TYPE BEHIND THE DATA MODEL.** Task
    // 2 found an INNER JOIN silently dropping every meeting summary; Task 3
    // found no `company_id`/`contact_id` at all, so a letter would have exported
    // naming no record; a status report would have been the same failure a third
    // time, and quieter than either -- its `documents` row would have come out
    // looking perfect, with `project_id` in a column that did not exist and
    // therefore nothing anywhere in the archive saying WHICH PROJECT the report
    // was about. Neither the spec nor the plan mentions the export, for the third
    // task running.
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .leftJoin(users, eq(documents.issuedByUserId, users.id))
    // `number` still leads, because for a numbered type it is the order a reader
    // expects. It is NULL for every summary and PostgreSQL sorts those last, so
    // created_at and id are what make the unnumbered tail deterministic rather
    // than whatever the plan produced.
    .orderBy(documents.number, documents.createdAt, documents.id);
  return {
    name: "documents.csv",
    header: [
      "id", "number", "type",
      "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "meeting_id", "meeting_title",
      "project_id", "project_name", "currency",
      "issue_date", "valid_until_date",
      "recipient_name", "recipient_contact_name", "recipient_salutation", "recipient_address",
      "subtotal", "tax", "total", "notes", "terms",
      // THE LETTER'S THREE. `letter_recipient_*` are deliberately NOT folded into
      // the quote's `recipient_*` columns above, even though a spreadsheet would
      // read them the same way and `type` says which is which. Two tables, two
      // meanings: a coalesce here would be the common `document_parties` this
      // task argued against, built in the one place nothing enforces it, and the
      // day the letter's model diverges the CSV would silently stop being true.
      "letter_subject", "letter_recipient_name", "letter_recipient_contact_name",
      "letter_recipient_salutation", "letter_recipient_address", "letter_body_html",
      // THE AGREEMENT'S SIX. `body_html` above and these are what make the
      // archive able to reconstruct a document rather than merely list it.
      "agreement_effective_date", "agreement_term_months", "agreement_jurisdiction",
      "agreement_party_name", "agreement_party_contact_name", "agreement_party_address",
      "frozen", "issued_by_user_id", "issued_by_username", "file_id", "file_archive_path", "created_at",
    ],
    rows: rows.map((r) => [
      r.doc.id, text(r.doc.number), r.doc.type,
      text(r.doc.companyId), text(r.companyName),
      text(r.doc.contactId), contactName(r.contactFirstName, r.contactLastName),
      text(r.doc.dealId), text(r.dealTitle), text(r.doc.meetingId), text(r.meetingTitle),
      text(r.doc.projectId), text(r.documentProjectName),
      text(r.quote?.currency),
      r.doc.issueDate, text(r.quote?.validUntilDate),
      text(r.quote?.recipientName), text(r.quote?.recipientContactName),
      text(r.quote?.recipientSalutation), text(r.quote?.recipientAddress),
      // The three money cells are BLANK rather than 0.00 for a type that has no
      // money -- which is what `money(null)` already does, and the reason is
      // arithmetic rather than tidiness: a spreadsheet parses `0.00` as a number
      // and would sum it into a column total, producing a figure about documents
      // that have no figures.
      money(r.quote?.subtotalCents ?? null),
      money(r.quote?.taxCents ?? null),
      money(r.quote?.totalCents ?? null),
      text(r.quote?.notes), text(r.quote?.terms),
      text(r.letter?.subject), text(r.letter?.recipientName),
      text(r.letter?.recipientContactName), text(r.letter?.recipientSalutation),
      text(r.letter?.recipientAddress),
      // Named `_html` for meetings.csv's `notes_html` reason: it holds sanitised
      // rich text, exported verbatim, and flattening it to plain text here would
      // make it the one lossy column in the file.
      text(r.letter?.bodyHtml),
      text(r.agreement?.effectiveDate),
      // BLANK RATHER THAN 0 for a document with no term, which is the three money
      // cells' argument repeated: a spreadsheet parses 0 as a number and would
      // average it into a column about documents that have no term.
      r.agreement === null ? "" : String(r.agreement.termMonths),
      text(r.agreement?.jurisdiction), text(r.agreement?.partyName),
      text(r.agreement?.partyContactName), text(r.agreement?.partyAddress),
      // Phase 9 made this per type, so it stopped being derivable from `type` by
      // anyone reading the archive without the source in front of them.
      r.doc.frozen ? "true" : "false",
      r.doc.issuedByUserId, text(r.issuedByUsername), r.doc.fileId,
      // The issued PDF's member path, so a reader can get from a quote number
      // to the page that was sent without opening every file in files/.
      archivePathByFileId.get(r.doc.fileId) ?? "",
      timestamp(r.doc.createdAt),
    ]),
  };
}

/**
 * One `files` row, resolved to the archive member it becomes.
 *
 * `archivePath` is empty when the blob is not on disk: the row is still
 * exported, because the metadata is true and losing it would hide the gap, but
 * there is no member to point at. See collectFiles for why the check happens
 * before a single byte of the response is written.
 */
interface ExportFile {
  id: string;
  archivePath: string;
  absolutePath: string;
  /** The `files.size_bytes` column, as files.csv reports it. */
  sizeBytes: number;
  /** The blob's size on disk, which is what the archive member will contain. */
  blobBytes: number;
  sha256: string;
  originalName: string;
  mime: string;
  uploaderUserId: string;
  uploaderUsername: string | null;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  // Phase 9's fifth parent. Without these two columns a meeting summary's PDF is
  // the one member of files/ whose four record cells are all blank -- which is
  // exactly the "a folder of documents with nothing saying which company each
  // belongs to" that filesSheet exists to prevent.
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: Date;
}

/**
 * Every stored file, with its member name assigned and its blob confirmed
 * present.
 *
 * THE stat() IS NOT A TIDINESS CHECK. Once the response has begun there is no
 * way to report an error: the status line and headers are gone, and a stream
 * that fails halfway produces a truncated archive that looks like a network
 * problem. So every blob is confirmed readable BEFORE the first byte, and a row
 * whose blob has vanished is exported with an empty archive_path instead of
 * taking the whole download down with it.
 *
 * A blob that disappears between this check and its read is still possible and
 * still unreportable -- content-addressed blobs are never rewritten, so the
 * window needs someone deleting from the store during an export -- and the
 * manifest is what surfaces it afterwards.
 */
async function collectFiles(db: Database, dataDir: string): Promise<ExportFile[]> {
  const rows = await db
    .select({
      f: files, uploaderUsername: users.username, companyName: companies.name,
      contactFirstName: contacts.firstName, contactLastName: contacts.lastName,
      dealTitle: deals.title, projectName: projects.name, meetingTitle: meetings.title,
    })
    .from(files)
    .leftJoin(users, eq(files.uploaderUserId, users.id))
    .leftJoin(companies, eq(files.companyId, companies.id))
    .leftJoin(contacts, eq(files.contactId, contacts.id))
    .leftJoin(deals, eq(files.dealId, deals.id))
    .leftJoin(projects, eq(files.projectId, projects.id))
    .leftJoin(meetings, eq(files.meetingId, meetings.id))
    .orderBy(files.createdAt, files.id);

  const nameFor = createNamer();
  const collected: ExportFile[] = [];
  for (const r of rows) {
    // blobPath validates the digest before joining it to a path, so a row whose
    // sha256 is not a digest can never address anything outside the store.
    const absolutePath = path.join(dataDir, "files", r.f.sha256);
    let present = /^[0-9a-f]{64}$/.test(r.f.sha256);
    // THE SIZE ON DISK, NOT THE SIZE IN THE ROW. The two agree on every blob
    // saveBlob wrote, since both come from the same bytes -- but the member's
    // declared size is now checked against the stream by yazl, so it has to be
    // what will actually be written rather than what the row remembers. A row
    // that disagrees with its blob still exports; files.csv keeps reporting the
    // column, and the manifest reports the archive, so the disagreement is
    // visible instead of fatal.
    let blobBytes = r.f.sizeBytes;
    if (present) {
      try {
        const info = await stat(absolutePath);
        present = info.isFile();
        blobBytes = info.size;
      } catch {
        present = false;
      }
    }
    collected.push({
      id: r.f.id,
      archivePath: present ? `files/${nameFor(r.f.originalName)}` : "",
      absolutePath,
      sizeBytes: r.f.sizeBytes,
      blobBytes,
      sha256: r.f.sha256,
      originalName: r.f.originalName,
      mime: r.f.mime,
      uploaderUserId: r.f.uploaderUserId,
      uploaderUsername: r.uploaderUsername,
      companyId: r.f.companyId,
      companyName: r.companyName,
      contactId: r.f.contactId,
      contactName: contactName(r.contactFirstName, r.contactLastName),
      dealId: r.f.dealId,
      dealTitle: r.dealTitle,
      projectId: r.f.projectId,
      projectName: r.projectName,
      meetingId: r.f.meetingId,
      meetingTitle: r.meetingTitle,
      createdAt: r.f.createdAt,
    });
  }
  return collected;
}

/**
 * The index that makes the files/ directory mean anything.
 *
 * A NINTH CSV, WHERE THE SPEC NAMES EIGHT, and it is the one correction this
 * task makes to the entity list. The spec asks for the stored files "under a
 * files/ directory" and for eight CSVs that do not include them -- so as
 * written, an operator opening the archive finds a folder of documents with
 * nothing anywhere saying which company each belongs to, who uploaded it, when,
 * or which of them is the PDF of quote QUO-2026-0007. Every other part of this
 * archive is careful to be readable; without this sheet the half of it that is
 * measured in hundreds of megabytes is not.
 */
function filesSheet(exportFiles: readonly ExportFile[]): Sheet {
  return {
    name: "files.csv",
    header: [
      "id", "original_name", "archive_path", "mime", "size_bytes", "sha256",
      "uploader_user_id", "uploader_username",
      "company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "project_id", "project_name",
      "meeting_id", "meeting_title", "created_at",
    ],
    rows: exportFiles.map((f) => [
      f.id, f.originalName, f.archivePath, f.mime, String(f.sizeBytes), f.sha256,
      f.uploaderUserId, text(f.uploaderUsername),
      text(f.companyId), text(f.companyName), text(f.contactId), f.contactName,
      text(f.dealId), text(f.dealTitle), text(f.projectId), text(f.projectName),
      text(f.meetingId), text(f.meetingTitle),
      timestamp(f.createdAt),
    ]),
  };
}

/**
 * The migration journal position, read from the same folder runMigrations
 * applies from -- so it names the migration set this build ships, which is what
 * the columns above were compiled against.
 *
 * The parse itself moved to services/migration-journal.ts when the backup
 * became its second consumer; only the tag is recorded here, because a CSV
 * reader has nothing to do with the ordinal.
 */
async function schemaVersion(): Promise<string> {
  return (await readMigrationJournal()).tag;
}

/**
 * Run every read of an export inside ONE snapshot, and make the export unable to
 * write.
 *
 * REPEATABLE READ, because an export is supposed to be a picture of the database
 * at a moment. Postgres defaults to READ COMMITTED, where each statement takes a
 * fresh snapshot -- so with ten sheets and a file listing read one after
 * another, a deal created between the companies query and the deals query lands
 * in deals.csv naming a company_id that appears nowhere in companies.csv. That
 * is a torn picture, and it misrepresents the data in the same way dropping the
 * archived rows would.
 *
 * READ ONLY, because this phase is read-only by construction and this is the one
 * place that claim can be made to the database rather than about it. Nothing
 * here writes; with this set, nothing here CAN.
 *
 * Exported so both properties can be tested directly -- a read-only transaction
 * refusing an INSERT, and two reads either side of another session's commit
 * returning the same rows. buildExport has the only other call site.
 */
export async function withExportSnapshot<T>(db: Database, read: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export interface BuildExportOptions {
  db: Database;
  /** Where the blob store lives; see the module comment on why only the TABLE is read. */
  dataDir: string;
  appVersion: string;
  /** Injected by tests so the manifest's timestamp is a value, not a moving target. */
  now?: Date;
}

export interface ExportArchive {
  /**
   * The zip, as a stream. Nothing downstream of here holds the archive whole.
   *
   * The structural NodeJS.ReadableStream rather than the concrete Readable,
   * because that is what yazl's outputStream is declared as -- and because
   * neither consumer needs more: fastify's reply.send and stream.pipeline both
   * take the interface.
   */
  stream: NodeJS.ReadableStream;
  /** Suggested download name, e.g. "conduit-export-2026-08-31.zip". */
  filename: string;
  /** What went in, before a byte was written. Also the archive's manifest.json. */
  manifest: ExportManifest;
}

/**
 * Build the export and return it as a stream.
 *
 * THE ARCHIVE IS NEVER HELD WHOLE, and it has two halves that reach memory by
 * different routes. Both are bounded and both are measured; the first version
 * of this comment bounded only one of them and said so as if it were the whole.
 *
 * THE BLOB HALF streams. Every stored file is opened only when the consumer has
 * read far enough to need it, and closed as soon as it is written. Measured on
 * the deploy target (3.8GB, NO SWAP): building and streaming a 400MB archive
 * grows the resident set by 9-13MB across three runs; the same run with the
 * lazy read stream replaced by `addBuffer(readFile(...))` grows it by 338MB.
 *
 * THE ROW HALF cannot stream, because manifest.json records a SHA-256 per
 * member and a digest is only known once the whole member exists. So each CSV
 * is materialised -- but ONE AT A TIME, and its rows are released before the
 * next query runs. That makes the peak the largest single sheet rather than the
 * sum of them all, which on a large install is the difference that matters:
 * 200,000 notes rows of 400 characters hold 409MB for 103MB of CSV, a ~4x
 * steady-state multiplier, and ten of those summed is the whole box.
 *
 * WRITTEN WITHOUT A COUNT IN IT SINCE PHASE 10, deliberately: the sentence said
 * "nine" in four places and a tenth sheet made every one of them a small lie
 * that nothing could catch. The property is "the peak is the largest sheet, not
 * the sum", and it is true at any number.
 *
 * export.test.ts asserts a ceiling on each half separately, and each was proved
 * to fail against the shape it forbids. The blob bound sat over the wrong
 * moment in its first version and passed against a buffering implementation;
 * the row bound did not exist at all, which is how the sum-of-every-sheet shape
 * got as far as review.
 *
 * WHAT IS NOT BOUNDED is the time to the FIRST byte. The pre-flight -- the read
 * transaction, one stat per stored file, one CSV build and one SHA-256 pass per
 * sheet, plus the journal read -- all happens before the response begins, and
 * it grows with row and file count. The 15-20ms first-byte figure measured for
 * the format decision is yazl's, not this route's. The comparison it informed
 * stays fair because a 7z build pays the same pre-flight and then the whole
 * archive on top; but "structurally unreachable" overstates it, and the largest
 * gap between two bytes on the wire is this pre-flight rather than anything in
 * the pump.
 *
 * COMPRESSION IS PER MEMBER, and the split is measured rather than assumed. The
 * CSVs and the manifest are deflated; the stored files are not.
 *
 * Deflating the blobs too was tried and is worse on both counts, measured on the
 * 300MB corpus of incompressible bytes used for the format decision, three runs
 * each: it took 8886-9094 ms against 1229-1320 ms, and it made the archive
 * LARGER -- 300,132,080 bytes against 300,040,080, because deflate adds framing
 * to data it cannot shrink. Real blobs are PDFs and images, which are already
 * compressed, so that is the case that matters rather than an artificial one.
 *
 * The CSVs keep deflate because they are text. On a small export the saving is
 * modest (34-47% per sheet, measured on a real archive) and it grows with the
 * row count, since uuids, repeated timestamps and repeated names are exactly
 * what deflate is good at.
 *
 * The cost of that split is that the finished length cannot be known in
 * advance, so the response carries no Content-Length. The spec puts truncation
 * detection in the manifest's per-member digests rather than in the transfer,
 * and a zip whose central directory never arrived does not open at all.
 */
export async function buildExport(options: BuildExportOptions): Promise<ExportArchive> {
  const { db, dataDir, appVersion, now = new Date() } = options;

  const members: ExportManifestMember[] = [];
  const zip = new yazl.ZipFile();

  // A FAILURE TO READ A MEMBER MUST NOT TAKE THE SERVER DOWN, and without this
  // line it does. yazl reports such a failure on the ZipFile's OWN emitter
  // rather than on outputStream, and an `error` event with no listener is an
  // uncaught exception -- which on this single-process app means systemd
  // restarts it and every other request in flight dies too. Measured on yazl
  // 3.3.1: a member whose source file has vanished exits the process with
  // ENOENT instead of failing the download.
  //
  // Forwarding it to the stream makes it what it should be -- this one response
  // ends early, the archive does not open, and the server keeps serving.
  // collectFiles' pre-flight stat is what makes the case rare; this is what
  // makes it survivable, and the two are not substitutes for each other.
  //
  // ONE PATH IT CANNOT REACH, recorded rather than fixed: yazl's addBuffer
  // ignores the error from zlib's deflateRaw and then dereferences the
  // undefined result, so a deflate failure throws synchronously out of
  // addBuffer instead of arriving here. deflateRaw on a valid Buffer has no
  // failure mode short of allocation failure, so this is unreachable in
  // practice; it is noted so the next reader does not assume the emitter covers
  // every case.
  zip.on("error", (error: Error) => { (zip.outputStream as Readable).destroy(error); });

  // THE FILE DESCRIPTORS, AND THE FAILURE THAT COST THE MOST TO FIND.
  //
  // Measured before this existed: five aborted downloads left five open
  // descriptors on the blob, for ever -- neither a forced GC nor closing the
  // fastify instance reclaimed them. When the client disconnects, fastify
  // destroys outputStream; `pipe`'s unpipe then detaches yazl's blob read
  // stream WITHOUT destroying it, and yazl 3.3.1 exposes no `abort` or
  // `destroy` on ZipFile, so nothing outside can reach it. Descriptor
  // exhaustion fails every file operation in the app, not only exports -- the
  // same class as the uncaught-error crash above, through the far more common
  // door of a user cancelling a large download.
  //
  // addReadStreamLazy rather than addFile is what makes the streams reachable:
  // this module opens them, so this module can close them. `aborted` closes the
  // second half of the race -- yazl may pump on to the next entry after a
  // failure, and without the flag that would open a fresh descriptor after the
  // client had already gone.
  const openReads = new Set<Readable>();
  let aborted = false;
  const releaseOpenReads = (): void => {
    aborted = true;
    for (const readStream of openReads) readStream.destroy();
    openReads.clear();
  };
  // `close` fires on a clean finish as well as on a destroy. On a clean finish
  // every read stream has already removed itself, so this is a no-op there.
  zip.outputStream.on("close", releaseOpenReads);

  // ONE SNAPSHOT FOR EVERY READ -- see withExportSnapshot. The blob bytes are
  // deliberately outside it: they are content-addressed and never rewritten, and
  // holding a transaction open for the whole download would pin a snapshot for
  // as long as the operator's connection lasts.
  //
  // ONE SHEET IS MATERIALISED AT A TIME, and that is a memory bound rather than
  // a tidiness preference. The first version built every Sheet object, then
  // every CSV buffer, then handed them all to yazl -- three live copies of
  // every row at once. Measured on 200,000 notes rows of 400 characters: one
  // sheet's mapped rows and its finished 103.0 MB CSV together held 409.2 MB
  // after a forced GC, a ~4x steady-state multiplier over the CSV text. Summed
  // summed across every sheet that is the ceiling on a 3.8 GB no-swap box, reached by
  // the half the blob-streaming bound never touched. Building and handing off
  // one sheet at a time makes the peak the LARGEST sheet rather than the sum,
  // and lets each sheet's rows go before the next query runs -- yazl deflates a
  // buffer as it is added, so what it retains afterwards is the compressed copy.
  const exportFiles = await withExportSnapshot(db, async (tx) => {
    const collected = await collectFiles(tx, dataDir);
    const archivePathByFileId = new Map<string, string>();
    for (const f of collected) {
      if (f.archivePath !== "") archivePathByFileId.set(f.id, f.archivePath);
    }

    // Thunks, not sheets: nothing is queried until its turn, and nothing
    // survives past it.
    const build: (() => Promise<Sheet>)[] = [
      () => companiesSheet(tx),
      () => contactsSheet(tx),
      () => dealsSheet(tx),
      () => projectsSheet(tx),
      () => tasksSheet(tx),
      () => notesSheet(tx),
      () => meetingsSheet(tx),
      () => timeEntriesSheet(tx),
      () => documentsSheet(tx, archivePathByFileId),
      () => Promise.resolve(filesSheet(collected)),
    ];
    for (const buildSheet of build) {
      const sheet = await buildSheet();
      const bytes = csvDocument(sheet.header, sheet.rows);
      members.push({
        path: sheet.name,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      zip.addBuffer(bytes, sheet.name);
    }
    return collected;
  });

  for (const f of exportFiles) {
    if (f.archivePath === "") continue;
    members.push({
      path: f.archivePath,
      bytes: f.blobBytes,
      // files.sha256 is the blob store's own content address, computed by
      // saveBlob from the bytes as they were written. Reusing it keeps the
      // export to ONE pass over the blobs instead of two -- and it means a
      // member whose bytes no longer hash to this value reveals damage in the
      // store, not only damage in transit.
      sha256: f.sha256,
    });
  }

  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion,
    schemaVersion: await schemaVersion(),
    generatedAt: now.toISOString(),
    cellTransforms: [EXPORT_CELL_TRANSFORM],
    members,
  };
  // AFTER the CSVs rather than before them, because its own contents depend on
  // their digests and those are only known once each has been built. A zip's
  // members carry no meaningful order to a reader, so the cost is nil.
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), "manifest.json");

  for (const f of exportFiles) {
    if (f.archivePath === "") continue;
    zip.addReadStreamLazy(f.archivePath, { size: f.blobBytes, compress: false }, (callback) => {
      if (aborted) {
        callback(new Error(`export abandoned before ${f.archivePath} was read`), Readable.from([]));
        return;
      }
      const readStream = createReadStream(f.absolutePath);
      // THE OBLIGATION MOVED WITH THE STREAM. yazl attaches its own error
      // handler to a stream it opened itself (addFile) and NOT to one it was
      // handed (addReadStream/addReadStreamLazy) -- reasonably, since it does
      // not own it. So switching to the lazy form to get the descriptors back
      // took this on, and without this line an unreadable blob raised an
      // uncaught EACCES: the same crash the ZipFile handler above exists to
      // prevent, reintroduced by the fix for a different bug. Routing it
      // through the ZipFile's emitter keeps one path for both.
      readStream.on("error", (error: Error) => { zip.emit("error", error); });
      openReads.add(readStream);
      readStream.on("close", () => openReads.delete(readStream));
      callback(null, readStream);
    });
  }
  zip.end();

  const day = now.toISOString().slice(0, 10);
  return { stream: zip.outputStream, filename: `conduit-export-${day}.zip`, manifest };
}
