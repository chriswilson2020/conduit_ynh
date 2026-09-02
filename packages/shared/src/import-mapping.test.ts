import { describe, expect, it } from "vitest";
import {
  csvImportField, csvMappingEntity, csvMappingProblem, CSV_IMPORT_FIELDS,
} from "./import-mapping.js";
import type { CsvImportField, CsvMapping } from "./import-mapping.js";

// THE MAPPING RULE, ASSERTED WHERE IT IS WRITTEN.
//
// csvMappingProblem is the one function the page disables its control with and
// services/import-csv.ts refuses an arriving mapping with -- the same
// arrangement passphraseProblem and installNameMatches already have. Testing it
// here rather than only through the importer is the point: every case below is
// a VALUE, with no upload, no database and nothing written.

const map = (...entries: [number, CsvImportField][]): CsvMapping => ({
  entries: entries.map(([column, field]) => ({ column, field })),
});

describe("the field catalogue", () => {
  it("has a definition for every field the type admits, and no orphans", () => {
    // THE TYPE AND THE TABLE ARE TWO DESCRIPTIONS OF ONE SET, and csvImportField
    // throws for a field the table does not hold -- which would be a crash in
    // the middle of building a preview. The union is closed, so the compiler
    // catches a field added to the table and not to the type; this catches the
    // other direction, which it cannot.
    const fields: CsvImportField[] = [
      "company.name", "company.domain", "company.website", "company.phone",
      "company.address", "company.industry",
      "contact.first_name", "contact.last_name", "contact.email", "contact.phone",
      "contact.job_title", "contact.salutation", "contact.pronouns", "contact.company_name",
    ];
    expect(CSV_IMPORT_FIELDS.map((def) => def.field).sort()).toEqual([...fields].sort());
    for (const field of fields) expect(csvImportField(field).field).toBe(field);
  });

  it("requires exactly one field of each entity, and it is the name", () => {
    const required = CSV_IMPORT_FIELDS.filter((def) => def.required).map((def) => def.field);
    expect(required.sort()).toEqual(["company.name", "contact.first_name"]);
  });

  it("makes only the two array-backed contact fields repeatable", () => {
    // OUTLOOK IS THE REASON. Its sheet has three email columns; contacts.emails
    // is a text[]. Nothing else in either table holds a list, so nothing else
    // may be mapped from more than one column.
    const repeatable = CSV_IMPORT_FIELDS.filter((def) => def.repeatable).map((def) => def.field);
    expect(repeatable.sort()).toEqual(["contact.email", "contact.phone"]);
  });
});

describe("csvMappingProblem", () => {
  it("accepts the smallest usable mapping of each entity", () => {
    expect(csvMappingProblem(map([0, "company.name"]), 3)).toBeNull();
    expect(csvMappingProblem(map([2, "contact.first_name"]), 3)).toBeNull();
  });

  it("refuses a mapping that maps nothing", () => {
    expect(csvMappingProblem({ entries: [] }, 3)).toMatch(/map at least one column/);
  });

  it("refuses a column this file does not have", () => {
    // THE CASE THIS EXISTS FOR IS A MAPPING BUILT AGAINST A DIFFERENT UPLOAD --
    // an operator with two tabs open, or a page that kept the last file's
    // mapping. Caught before a byte is read.
    expect(csvMappingProblem(map([3, "company.name"]), 3)).toMatch(/column 3 is not one of/);
    expect(csvMappingProblem(map([-1, "company.name"]), 3)).toMatch(/column -1 is not one of/);
    expect(csvMappingProblem(map([1.5, "company.name"]), 3)).toMatch(/is not one of/);
  });

  it("refuses one column mapped to two fields", () => {
    expect(csvMappingProblem(map([0, "company.name"], [0, "company.domain"]), 3))
      .toMatch(/column 0 is mapped more than once/);
  });

  it("refuses two columns fighting over a field that holds one value", () => {
    expect(csvMappingProblem(map([0, "company.name"], [1, "company.name"]), 3))
      .toMatch(/2 columns are mapped to "Company name", which holds one value/);
  });

  it("allows several columns on a repeatable field", () => {
    expect(csvMappingProblem(
      map([0, "contact.first_name"], [1, "contact.email"], [2, "contact.email"]), 3,
    )).toBeNull();
  });

  it("refuses a file mapped to both companies and contacts, and says what to do", () => {
    const problem = csvMappingProblem(map([0, "company.name"], [1, "contact.first_name"]), 3);
    expect(problem).toMatch(/One import creates one kind of record/);
    // A REFUSAL THAT DOES NOT SAY WHAT TO DO INSTEAD IS A DEAD END, and the
    // two-pass workflow is the whole answer to the Outlook-shaped file.
    expect(problem).toMatch(/import the companies first/);
  });

  it("refuses a mapping with no column on the one required field", () => {
    expect(csvMappingProblem(map([0, "company.domain"]), 3))
      .toMatch(/no column is mapped to "Company name", which every company must have/);
    expect(csvMappingProblem(map([0, "contact.email"]), 3))
      .toMatch(/no column is mapped to "First name", which every contact must have/);
  });

  it("checks the column bounds before anything else, so a bad index is named first", () => {
    // ORDER MATTERS FOR THE MESSAGE AND NOTHING ELSE, but the message is what
    // the operator acts on: "column 9 is not one of this file's 3 columns" tells
    // them their mapping is stale, where "no column is mapped to Company name"
    // would send them looking at the wrong thing.
    expect(csvMappingProblem(map([9, "company.domain"]), 3)).toMatch(/column 9 is not one of/);
  });
});

describe("csvMappingEntity", () => {
  it("answers which kind of record a valid mapping creates", () => {
    expect(csvMappingEntity(map([0, "company.name"]))).toBe("company");
    expect(csvMappingEntity(map([0, "contact.first_name"], [1, "contact.email"])))
      .toBe("contact");
  });

  it("answers nothing for a mapping csvMappingProblem would refuse", () => {
    // NOTHING RATHER THAN A GUESS. planCsvImport throws on a null here, because
    // a default would import the wrong kind of row.
    expect(csvMappingEntity(map([0, "company.name"], [1, "contact.first_name"]))).toBeNull();
    expect(csvMappingEntity({ entries: [] })).toBeNull();
  });
});
