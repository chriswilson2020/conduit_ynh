/**
 * THE ONE INTERACTIVE STEP IN THE WHOLE SPINE, AS A VALUE.
 *
 * Phase 7.7's spec gives three pipelines four common stages and one that
 * differs, and then says one more thing about this pipeline alone:
 *
 *   "Only the foreign CSV importer has an interactive step between inspect and
 *    plan -- the column mapping. The other two produce their plan without
 *    asking anything."
 *
 * That is why this module exists beside plan.ts rather than inside it. A
 * restore and an exact import go inspect -> plan in one call, because
 * everything they need is in the archive. A foreign CSV cannot: the mapping is
 * a HUMAN DECISION THAT CANNOT EXIST BEFORE THE HEADERS DO, so the pipeline is
 * inspect -> (a person) -> plan, and the thing handed to the person has to be a
 * value the page can render for exactly the reasons plan.ts gives for the plan.
 *
 * THE SAME THREE CONSEQUENCES FOLLOW, and they are worth restating because this
 * value is what the plan is built FROM:
 *
 *   - THE MAPPING STEP CANNOT LIE ABOUT THE FILE. The columns, the samples and
 *     the delimiter are what services/import-csv.ts read out of the uploaded
 *     bytes, not a second guess at them.
 *   - THE PLAN CANNOT SURPRISE. A mapping the page did not offer is refused by
 *     the same function the page disables its own control with -- see
 *     csvMappingProblem, which is one implementation for both sides on the
 *     precedent passphraseProblem and installNameMatches already set.
 *   - EVERY HARD CASE IS ASSERTABLE WITHOUT A DATABASE. A header row nobody
 *     recognises, a required field nobody mapped, two columns fighting over one
 *     field: each is a value, and a test asserts it with nothing uploaded and
 *     nothing written.
 *
 * A COLUMN IS IDENTIFIED BY ITS POSITION AND NEVER BY ITS NAME. Somebody else's
 * spreadsheet can have two columns both called "Email", a column called "", and
 * a column whose name differs from its neighbour only by a trailing space. A
 * name is therefore not an identity, and a mapping keyed by one would silently
 * apply to whichever of the two the lookup happened to find. The index is
 * unambiguous, it is what the operator is pointing at on screen, and it is
 * stable for the life of one upload.
 */

import type { PlanSourceView } from "./plan.js";

/** Which of Conduit's records a foreign file is being read as. */
export type CsvImportEntity = "company" | "contact";

/**
 * A field a column can be mapped onto.
 *
 * PREFIXED BY ENTITY, AND THAT IS LOAD-BEARING RATHER THAN TIDY: one import
 * writes one kind of record, and the prefix is what makes "which kind is this?"
 * a question the mapping answers on its own -- see csvMappingProblem's rule
 * about mapping both at once, and services/import-csv.ts's header for why a
 * single file may not create companies and contacts together.
 */
export type CsvImportField =
  | "company.name"
  | "company.domain"
  | "company.website"
  | "company.phone"
  | "company.address"
  | "company.industry"
  | "contact.first_name"
  | "contact.last_name"
  | "contact.email"
  | "contact.phone"
  | "contact.job_title"
  | "contact.salutation"
  | "contact.pronouns"
  | "contact.company_name";

/** One field, as the mapping control offers it. */
export interface CsvImportFieldDef {
  readonly field: CsvImportField;
  readonly entity: CsvImportEntity;
  /** What the operator sees in the picker. */
  readonly label: string;
  /** A row whose value for this field is empty is not imported. */
  readonly required: boolean;
  /**
   * Several columns may be mapped onto this one field.
   *
   * EXISTS BECAUSE OUTLOOK'S OWN EXPORT NEEDS IT: its contact sheet carries
   * "E-mail Address", "E-mail 2 Address" and "E-mail 3 Address", and Conduit's
   * contacts hold `emails` as a text[]. The values are collected in column
   * order, empties dropped, and duplicates removed case-insensitively.
   */
  readonly repeatable: boolean;
  /** One sentence, already written for a person to read. */
  readonly hint: string;
}

/**
 * EVERY FIELD A FOREIGN FILE CAN BE MAPPED ONTO, AND THE WHOLE OF IT.
 *
 * COMPANIES AND CONTACTS, WHICH IS THE SAME CLOSURE THE EXACT IMPORTER
 * SETTLED ON AND FOR A REASON THAT SURVIVES THE CHANGE OF SOURCE: a contact
 * points at a company, and a company points at nothing that is not either in
 * the file or nullable. Every other table in this schema needs a `users` row, a
 * pipeline, a stage or a fractional position, and NONE of those is a thing a
 * spreadsheet from another CRM can supply -- see services/import-csv.ts.
 *
 * `owner_user_id` IS ABSENT ON PURPOSE. It is a uuid of a Conduit user, and no
 * foreign file has one. Imported rows arrive unowned and the plan says so.
 */
export const CSV_IMPORT_FIELDS: readonly CsvImportFieldDef[] = [
  {
    field: "company.name", entity: "company", label: "Company name",
    required: true, repeatable: false,
    hint: "The only field a company must have. A row with an empty one is not imported.",
  },
  {
    field: "company.domain", entity: "company", label: "Domain",
    required: false, repeatable: false,
    hint: "acme.com. This is what duplicates are matched on, so a company with no domain "
      + "is always created.",
  },
  {
    field: "company.website", entity: "company", label: "Website",
    required: false, repeatable: false, hint: "The full address, https:// and all.",
  },
  {
    field: "company.phone", entity: "company", label: "Phone",
    required: false, repeatable: false, hint: "One number. Companies hold a single phone.",
  },
  {
    field: "company.address", entity: "company", label: "Address",
    required: false, repeatable: false,
    hint: "One column. A file that splits street, city and postcode has to be joined first.",
  },
  {
    field: "company.industry", entity: "company", label: "Industry",
    required: false, repeatable: false, hint: "Free text; Conduit does not have a list.",
  },
  {
    field: "contact.first_name", entity: "contact", label: "First name",
    required: true, repeatable: false,
    hint: "The only field a contact must have. A row with an empty one is not imported.",
  },
  {
    field: "contact.last_name", entity: "contact", label: "Last name",
    required: false, repeatable: false, hint: "Optional, as it is everywhere else in Conduit.",
  },
  {
    field: "contact.email", entity: "contact", label: "Email address",
    required: false, repeatable: true,
    hint: "Map as many columns as the file has. This is what duplicates are matched on, so a "
      + "contact with no address is always created.",
  },
  {
    field: "contact.phone", entity: "contact", label: "Phone number",
    required: false, repeatable: true, hint: "Map as many columns as the file has.",
  },
  {
    field: "contact.job_title", entity: "contact", label: "Job title",
    required: false, repeatable: false, hint: "Free text.",
  },
  {
    field: "contact.salutation", entity: "contact", label: "Salutation",
    required: false, repeatable: false,
    hint: "Dr, Mevr, Prof. At most 64 characters; a longer value is left empty and reported.",
  },
  {
    field: "contact.pronouns", entity: "contact", label: "Pronouns",
    required: false, repeatable: false,
    hint: "she/her, they/them. At most 64 characters; a longer value is left empty and reported.",
  },
  {
    field: "contact.company_name", entity: "contact", label: "Company (by name)",
    required: false, repeatable: false,
    hint: "Links the contact to a company ALREADY in Conduit whose name matches exactly, "
      + "ignoring case. No company is created; import your companies first.",
  },
];

/** The definition of one field. Throws for nothing, because the type is closed. */
export function csvImportField(field: CsvImportField): CsvImportFieldDef {
  const found = CSV_IMPORT_FIELDS.find((candidate) => candidate.field === field);
  // Unreachable while CsvImportField and CSV_IMPORT_FIELDS agree, which
  // import-mapping.test.ts asserts directly rather than leaving to the eye.
  if (found === undefined) throw new Error(`no such import field: ${field}`);
  return found;
}

/** One column of the uploaded file, as the mapping step describes it. */
export interface CsvColumnView {
  /** Zero-based position in the header record. THE IDENTITY. See the header. */
  readonly index: number;
  /** The header text as the file spells it, BOM and surrounding space removed. */
  readonly header: string;
  /**
   * A few values from the sampled records, for an operator deciding what this
   * column IS.
   *
   * THE HEADER ALONE IS NOT ENOUGH AND THAT IS THE WHOLE REASON THESE ARE HERE.
   * "Field 7", "Notes", "Value" and an empty header are all real; the values
   * under them are what a person actually reads to decide. Empty cells are left
   * out, so a mostly-empty column shows what it does hold rather than a column
   * of nothing.
   */
  readonly samples: readonly string[];
  /** How many of the sampled records had a non-empty value here. */
  readonly filled: number;
  /** What Conduit guessed from the header, or null when it could not. */
  readonly suggestion: CsvImportField | null;
}

/** What the reader decided about the file's shape. */
export interface CsvDialectView {
  /** The delimiter in use: "," ";" "\t" "|". */
  readonly delimiter: string;
  /** The same thing as a word, for a sentence: "semicolon". */
  readonly delimiterName: string;
  /** Whether the delimiter was sniffed or supplied by the operator. */
  readonly sniffed: boolean;
}

/**
 * WHAT THE OPERATOR IS SHOWN BEFORE THEY MAP ANYTHING.
 *
 * IT IS NOT A PLAN AND MUST NOT BE MISTAKEN FOR ONE. Nothing here says what
 * will be created: the counts, the duplicates and the skipped rows cannot be
 * known until the mapping exists, because the mapping is what says which cell
 * is a name. This value answers one question -- "what is in this file?" -- and
 * the plan answers the other.
 *
 * A REFUSAL IS STILL A MAPPING VIEW, on plan.ts's own precedent: an empty file,
 * an archive uploaded to the wrong control and a header this reader cannot find
 * all arrive as this shape with `columns: []` and `refusal` set, so the page
 * renders them through one path.
 */
export interface CsvMappingView {
  /**
   * What was uploaded, exactly as PlanView reports it.
   *
   * THERE IS NO ID HERE, AND ITS ABSENCE IS A DECISION LEFT TO THE ROUTES TASK
   * RATHER THAN GUESSED AT. PlanView carries a `planId` because a PLAN is what
   * IntakeSessionStore holds; a mapping step happens BEFORE a plan exists, so
   * what would have to be held is the staged upload on its own -- and whether
   * that is an IntakeSession whose plan is not built yet, or a second kind of
   * hold, is a question about the store rather than about this value. The
   * source is what identifies the upload TO A PERSON ("contacts.csv, 1.2 MB"),
   * which is what this value is for.
   */
  readonly source: PlanSourceView;
  readonly dialect: CsvDialectView;
  readonly columns: readonly CsvColumnView[];
  /** Every field a column may be mapped onto. The picker's options. */
  readonly targets: readonly CsvImportFieldDef[];
  /**
   * How many records were read to build the samples.
   *
   * NOT THE FILE'S TOTAL, and the distinction is deliberate: counting the rows
   * of a 200,000-row file means reading all of it, and this step exists to be
   * fast enough that an operator does not wait to see their own column names.
   * The plan reads the whole file and its counts are the real ones.
   */
  readonly sampled: number;
  /** Anything worth saying about the file that does not stop the mapping. */
  readonly findings: readonly CsvMappingFinding[];
  readonly refusal: CsvMappingRefusal | null;
}

/** The same shape plan.ts's finding has, so a page can render both with one component. */
export interface CsvMappingFinding {
  readonly severity: "note" | "warning";
  readonly code: string;
  readonly message: string;
}

/** Why this file cannot be mapped at all. */
export interface CsvMappingRefusal {
  readonly code: string;
  readonly message: string;
}

/** One column of the file, pointed at one field. */
export interface CsvMappingEntry {
  readonly column: number;
  readonly field: CsvImportField;
}

/**
 * WHAT THE OPERATOR DECIDED.
 *
 * THIS IS THE ONE THING IN THE WHOLE SPINE THAT TRAVELS FROM THE CLIENT TO THE
 * SERVER AND IS ACTED ON, and it is worth saying plainly because plan.ts spends
 * several paragraphs establishing that the plan does NOT. The difference is
 * that a plan is a DESCRIPTION OF WORK -- re-validating one would be a second
 * implementation of inspect -- while this is a DECISION ONLY A PERSON CAN MAKE.
 * It is validated on arrival by csvMappingProblem, exactly as any other input
 * is, and what it produces is a plan the server builds and holds.
 */
export interface CsvMapping {
  readonly entries: readonly CsvMappingEntry[];
  /**
   * The delimiter to read with, overruling the sniff.
   *
   * PRESENT BECAUSE A SNIFFER NOBODY CAN CORRECT DECIDES THE WHOLE IMPORT ON
   * ITS OWN. Absent means "use what was sniffed".
   */
  readonly delimiter?: string;
}

/**
 * WHY THIS MAPPING CANNOT BE USED, OR NULL.
 *
 * ONE FUNCTION, BOTH SIDES, on the precedent passphraseProblem and
 * installNameMatches set: the page disables its Continue control on this and
 * services/import-csv.ts refuses a mapping that arrives anyway. Two comparisons
 * that agree today are two that can stop agreeing, and the half that drifted
 * would be the one that let an operator start an import the server then threw
 * out after they had spent five minutes on it.
 *
 * `columnCount` is the number of columns the FILE has -- the mapping step's own
 * `columns.length`. A mapping that points past the end of the header is a
 * mapping built against a different upload.
 */
export function csvMappingProblem(
  mapping: CsvMapping, columnCount: number,
): string | null {
  const { entries } = mapping;
  if (entries.length === 0) {
    return "map at least one column before importing.";
  }
  const seenColumns = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.column) || entry.column < 0 || entry.column >= columnCount) {
      return `column ${String(entry.column)} is not one of this file's `
        + `${String(columnCount)} columns.`;
    }
    if (seenColumns.has(entry.column)) {
      return `column ${String(entry.column)} is mapped more than once; a column can fill `
        + "only one field.";
    }
    seenColumns.add(entry.column);
  }

  const perField = new Map<CsvImportField, number>();
  for (const entry of entries) {
    perField.set(entry.field, (perField.get(entry.field) ?? 0) + 1);
  }
  for (const [field, used] of perField) {
    const def = csvImportField(field);
    if (used > 1 && !def.repeatable) {
      return `${used.toString()} columns are mapped to ${JSON.stringify(def.label)}, which `
        + "holds one value.";
    }
  }

  // ONE IMPORT WRITES ONE KIND OF RECORD. The alternative -- a single file
  // creating a company and a contact per row -- would have to invent a company
  // from a NAME, and two spellings of one company in one column become two
  // companies with nothing in the preview able to say so. The two-pass
  // workflow is named in the message because a refusal that does not say what
  // to do instead is a dead end.
  const entities = new Set(entries.map((entry) => csvImportField(entry.field).entity));
  if (entities.size > 1) {
    return "this file is mapped to both companies and contacts. One import creates one kind "
      + "of record: import the companies first, then the contacts, and link them with the "
      + "Company (by name) field.";
  }

  const entity = [...entities][0];
  if (entity === undefined) return "map at least one column before importing.";
  const mapped = new Set(entries.map((entry) => entry.field));
  const missing = CSV_IMPORT_FIELDS.find(
    (def) => def.entity === entity && def.required && !mapped.has(def.field),
  );
  if (missing !== undefined) {
    return `no column is mapped to ${JSON.stringify(missing.label)}, which every `
      + `${entity} must have.`;
  }
  return null;
}

/**
 * Which kind of record this mapping creates.
 *
 * Returns null for a mapping csvMappingProblem would refuse, so a caller that
 * checked first can rely on it and one that did not gets nothing rather than a
 * guess.
 */
export function csvMappingEntity(mapping: CsvMapping): CsvImportEntity | null {
  const entities = new Set(
    mapping.entries.map((entry) => csvImportField(entry.field).entity),
  );
  return entities.size === 1 ? [...entities][0] ?? null : null;
}
