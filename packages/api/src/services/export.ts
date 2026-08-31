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
  companies, contacts, deals, documents, files, meetingAttendees, meetings,
  notes, pipelines, projects, stages, tasks, users,
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
// quote PDFs and nothing else. (An issued quote's PDF is an ordinary `files`
// row against its deal -- see documents.file_id -- so "the stored files and
// issued quote PDFs" of the spec is one query, not two.)

/**
 * The layout version of the archive itself, bumped when a member is renamed,
 * a column is removed, or the CSV dialect changes -- not when a column is
 * added, which every reader tolerates.
 *
 * Recorded in manifest.json so 7.7's exact importer has something to branch on
 * that is not "guess from the column headers".
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
   * packages/api/drizzle/meta/_journal.json, e.g. "0012_misty_phantom_reporter".
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

/** A nullable text column. NULL and the empty string both become empty. */
function text(value: string | null): string {
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
 * `archivePathByFileId` maps every exported file's id to its member path, not
 * only the quote PDFs -- documents.csv is just the only sheet that needs the
 * reverse lookup, to get a reader from a quote number to the page that was sent.
 */
async function documentsSheet(db: Database, archivePathByFileId: ReadonlyMap<string, string>): Promise<Sheet> {
  const rows = await db
    .select({ doc: documents, dealTitle: deals.title, issuedByUsername: users.username })
    .from(documents)
    .leftJoin(deals, eq(documents.dealId, deals.id))
    .leftJoin(users, eq(documents.issuedByUserId, users.id))
    .orderBy(documents.number);
  return {
    name: "documents.csv",
    header: [
      "id", "number", "type", "deal_id", "deal_title", "currency",
      "issue_date", "valid_until_date",
      "recipient_name", "recipient_contact_name", "recipient_salutation", "recipient_address",
      "subtotal", "tax", "total", "notes", "terms",
      "issued_by_user_id", "issued_by_username", "file_id", "file_archive_path", "created_at",
    ],
    rows: rows.map((r) => [
      r.doc.id, r.doc.number, r.doc.type, r.doc.dealId, text(r.dealTitle), r.doc.currency,
      r.doc.issueDate, text(r.doc.validUntilDate),
      r.doc.recipientName, r.doc.recipientContactName, r.doc.recipientSalutation, r.doc.recipientAddress,
      money(r.doc.subtotalCents), money(r.doc.taxCents), money(r.doc.totalCents),
      r.doc.notes, r.doc.terms,
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
      dealTitle: deals.title, projectName: projects.name,
    })
    .from(files)
    .leftJoin(users, eq(files.uploaderUserId, users.id))
    .leftJoin(companies, eq(files.companyId, companies.id))
    .leftJoin(contacts, eq(files.contactId, contacts.id))
    .leftJoin(deals, eq(files.dealId, deals.id))
    .leftJoin(projects, eq(files.projectId, projects.id))
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
      "deal_id", "deal_title", "project_id", "project_name", "created_at",
    ],
    rows: exportFiles.map((f) => [
      f.id, f.originalName, f.archivePath, f.mime, String(f.sizeBytes), f.sha256,
      f.uploaderUserId, text(f.uploaderUsername),
      text(f.companyId), text(f.companyName), text(f.contactId), f.contactName,
      text(f.dealId), text(f.dealTitle), text(f.projectId), text(f.projectName),
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
 * fresh snapshot -- so with nine sheets and a file listing read one after
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
 * sum of nine, which on a large install is the difference that matters: 200,000
 * notes rows of 400 characters hold 409MB for 103MB of CSV, a ~4x steady-state
 * multiplier, and nine of those summed is the whole box.
 *
 * export.test.ts asserts a ceiling on each half separately, and each was proved
 * to fail against the shape it forbids. The blob bound sat over the wrong
 * moment in its first version and passed against a buffering implementation;
 * the row bound did not exist at all, which is how the sum-of-nine shape got as
 * far as review.
 *
 * WHAT IS NOT BOUNDED is the time to the FIRST byte. The pre-flight -- the read
 * transaction, one stat per stored file, nine CSV builds and nine SHA-256
 * passes, plus the journal read -- all happens before the response begins, and
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
  // a tidiness preference. The first version built all nine Sheet objects, then
  // all nine CSV buffers, then handed all nine to yazl -- three live copies of
  // every row at once. Measured on 200,000 notes rows of 400 characters: one
  // sheet's mapped rows and its finished 103.0 MB CSV together held 409.2 MB
  // after a forced GC, a ~4x steady-state multiplier over the CSV text. Summed
  // across nine sheets that is the ceiling on a 3.8 GB no-swap box, reached by
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
