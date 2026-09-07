/**
 * **WHAT THE READABLE EXPORT CONTAINS, WRITTEN DOWN ONCE.**
 *
 * Phase 10 Task 1 added `time_entries.csv` and found that a new sheet has to be
 * told to four hand-written lists, with nothing deriving any of them from any
 * other, plus a fifth assertion that was green for the omission. Counted
 * properly while building this module, IT WAS TEN PLACES -- three in the
 * product and seven in the tests, every one of them the same ten member names
 * typed out again. Phase 9's export was missed by three tasks running with the
 * obligation written down in the spec, the plan AND the definition of done, so
 * a fifth reminder was not the fix. This module is the fix: one list, and every
 * place that has to know reads it.
 *
 * WHAT READS THIS, and what each of them compares it against -- the point is
 * that not one of them compares it against another copy of itself:
 *
 * | reader | what it is |
 * |---|---|
 * | `services/export.ts` | the sheet builders, keyed by member: a member with no builder does not compile |
 * | `services/import-export.ts` | the import preview's "not imported, because" note, per member |
 * | `settings-data-lib.ts` | the sentence describing the archive to the operator |
 * | `services/export.test.ts` | the archive's real members, its real order, and the database's real table list |
 * | `routes/export.test.ts` | what a real download actually unzips to |
 * | `routes/import.test.ts`, `services/import-export.test.ts` | the findings a real preview emits |
 * | `e2e/data.spec.ts` | the words really on the page, and the notes really in the preview |
 *
 * **THE ORDER IS THE ARCHIVE'S ORDER.** Sheets are written into the zip in this
 * order and the operator reads the nouns in this order. Reordering this list
 * reorders the members of a shipped format, which is a change to the artefact
 * and not a tidy-up.
 *
 * **THIS IS NOT A CLAIM THAT THE ABSENCES ARE RIGHT.** Tables with no member
 * here are declared -- with a reason each -- in `describe("export coverage")` in
 * `services/export.test.ts`, which fails by name for a table in neither place.
 * That guard is what stops a member being DELETED from this list as quietly as
 * one used to be forgotten: the table it carried would then be claimed by
 * nothing.
 */

/**
 * Whether the exact importer reads a member back into an install, and if not,
 * the specific thing the archive does not carry.
 *
 * A UNION RATHER THAN AN OPTIONAL FIELD, so the two cannot both be true and
 * neither can be absent: an unimported member without a reason is the failure
 * this module exists to prevent (an operator's preview saying nothing at all
 * about a sheet), and a reason on an imported one is prose that would never be
 * shown to anybody.
 */
export type ExportMemberImport =
  | { readonly imported: true }
  | { readonly imported: false; readonly notImported: string };

export type ExportMember = {
  /** The member's path inside the archive, e.g. `"companies.csv"`. */
  readonly member: string;
  /**
   * Every table in the schema this member carries. Usually one; `documents.csv`
   * carries four, because it is one row per document with its per-type detail
   * tables joined on (see `documentsSheet`).
   */
  readonly tables: readonly [string, ...string[]];
  /**
   * The words the operator reads on Settings -> Data, in the sentence that says
   * what is in the archive. Lower case, plural, and a phrase a person would use
   * about their own data rather than a table name.
   */
  readonly noun: string;
} & ExportMemberImport;

/**
 * `as const satisfies` rather than a plain annotation: the literal member names
 * survive into the type, which is what lets `services/export.ts` key its sheet
 * builders by member and fail TO COMPILE when a member has no builder. An
 * annotation would widen them to `string` and give that check away.
 */
export const EXPORT_MEMBERS = [
  {
    member: "companies.csv",
    tables: ["companies"],
    noun: "companies",
    imported: true,
  },
  {
    member: "contacts.csv",
    tables: ["contacts"],
    noun: "contacts",
    imported: true,
  },
  {
    member: "deals.csv",
    tables: ["deals"],
    noun: "deals",
    imported: false,
    notImported: "the export carries no pipelines or stages for a deal to sit in, and no position "
      + "for its place in the stage; all three are required and none is in the archive",
  },
  {
    member: "projects.csv",
    tables: ["projects"],
    noun: "projects",
    imported: false,
    notImported: "a project can point at a deal, and deals are not imported; importing one with "
      + "that link silently dropped would lose a relationship the export does record",
  },
  {
    member: "tasks.csv",
    tables: ["tasks"],
    noun: "tasks",
    imported: false,
    notImported: "the export carries no position for a task, which is required, and a task can "
      + "point at a deal or a project, neither of which is imported",
  },
  {
    member: "notes.csv",
    tables: ["notes"],
    noun: "notes",
    imported: false,
    notImported: "a note's author is a Conduit user and the export carries no users, only their "
      + "ids and names",
  },
  {
    member: "meetings.csv",
    tables: ["meetings"],
    noun: "meetings",
    imported: false,
    notImported: "a meeting's owner is a Conduit user the export does not carry, and its attendees "
      + "are exported as display names only -- the archive cannot say whether an attendee was "
      + "a contact, a user or a guest",
  },
  {
    member: "time_entries.csv",
    tables: ["time_entries"],
    noun: "time entries",
    imported: false,
    notImported: "an entry's owner is a Conduit user the export does not carry, and an entry must "
      + "name at least one record -- of which only companies and contacts are imported, so an "
      + "hour booked to a project, deal or task would arrive with nothing to say what it was "
      + "spent on",
  },
  {
    member: "timers.csv",
    tables: ["timers"],
    /**
     * "timer runs" RATHER THAN "timers", because the operator's sentence has to
     * distinguish these from the hours themselves, which are the member above:
     * a row here is one RUN of the clock, and several of them are already in
     * `time_entries.csv` as the entries they produced.
     */
    noun: "timer runs",
    imported: false,
    notImported: "a timer names the Conduit user whose clock it was and the time entry it "
      + "produced, and neither is imported -- a timer arriving without its entry would be a "
      + "record that work happened with no record of the work",
  },
  {
    member: "documents.csv",
    tables: ["documents", "document_quotes", "document_letters", "document_agreements"],
    noun: "documents",
    imported: false,
    notImported: "the export carries no line items, so an imported quote would show a frozen total "
      + "over an empty table",
  },
  {
    member: "files.csv",
    tables: ["files"],
    noun: "uploaded files",
    imported: false,
    notImported: "a stored file's uploader is a Conduit user the export does not carry; the files "
      + "themselves are in the archive and can be saved out of it by hand",
  },
] as const satisfies readonly ExportMember[];

/** The member names, as a union of literals -- see the `as const` above. */
export type ExportMemberName = (typeof EXPORT_MEMBERS)[number]["member"];

/**
 * The members the exact importer reads back.
 *
 * services/import-export.ts annotates its two member constants with this, so
 * flipping a member to `imported: false` up there fails to compile down there
 * rather than leaving an importer that reads a sheet it has just told the
 * operator it does not read. The other direction -- declaring a member imported
 * that the importer never opens -- is a runtime claim and is answered by a
 * runtime test: `applyImport`'s `opened` is compared against
 * {@link importedMembers}.
 */
export type ImportedMemberName =
  Extract<(typeof EXPORT_MEMBERS)[number], { imported: true }>["member"];

export const EXPORT_MEMBER_NAMES: readonly ExportMemberName[] =
  EXPORT_MEMBERS.map((entry) => entry.member);

/**
 * Which member carries each table. Lossy if two members ever claimed the same
 * table, which `export-members.test.ts` refuses.
 */
export const MEMBER_BY_TABLE: ReadonlyMap<string, ExportMemberName> = new Map(
  EXPORT_MEMBERS.flatMap((entry) => entry.tables.map((table) => [table, entry.member] as const)),
);

/**
 * Every sheet the exact importer does not read, and the specific reason -- one
 * finding each in an import preview.
 *
 * Derived rather than listed: a member added above with `imported: false` gets
 * its note without anybody remembering, and a member added with `imported: true`
 * is answered by the importer's own test that it reads exactly the members that
 * say so.
 */
export const NOT_IMPORTED_MEMBERS: readonly { member: ExportMemberName; reason: string }[] =
  // flatMap rather than filter().map(): a predicate does not narrow a union, so
  // `entry.notImported` would not be in scope after a `.filter(e => !e.imported)`.
  EXPORT_MEMBERS.flatMap(
    (entry) => (entry.imported ? [] : [{ member: entry.member, reason: entry.notImported }]),
  );

/** Every sheet the exact importer does read back. */
export function importedMembers(): readonly ExportMemberName[] {
  return EXPORT_MEMBERS.filter((entry) => entry.imported).map((entry) => entry.member);
}

/**
 * Every member's noun as one English list: "companies, contacts and documents".
 *
 * THE OPERATOR-FACING HALF, and the one that had no test at all before this
 * module. Settings -> Data's sentence used to be typed out, so it went on
 * naming eight entities while the archive held nine and nothing anywhere
 * noticed -- an operator would not have known their timesheet was in the file.
 */
export function exportMemberNouns(): string {
  const nouns = EXPORT_MEMBERS.map((entry) => entry.noun);
  const last = nouns.at(-1) ?? "";
  return nouns.length <= 1 ? last : `${nouns.slice(0, -1).join(", ")} and ${last}`;
}
