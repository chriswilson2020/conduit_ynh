import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { plannedTotal } from "@conduit/shared";
import type { CsvImportField, CsvMapping, CsvMappingView } from "@conduit/shared";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { companies, contacts, events } from "../db/schema.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { HAVE_7Z, writeZip } from "../test/archives.js";
import { HAVE_PYTHON, OUTLOOK_CONTACT_HEADER, writeForeignCsv } from "../test/foreign-csv.js";
import { reauthedHeaders, testReauthVerifier } from "../test/reauth.js";
import { resolveUser } from "../users.js";
import { archiveCompany, createCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import {
  receiveIntake, stageArchive, stageVerbatim, type IntakeFile, type StagedPayload,
} from "./intake.js";
import { DEFAULT_MAX_RECORD_CHARS } from "./csv.js";
import { applyPlan, planView, PlanApplyError, PlanExceededError } from "./intake-plan.js";
import {
  applyCsvImport, foldHeader, guessEntity, guessField, inspectCsv, planCsvImport,
  CSV_IMPORT_FINDINGS, CSV_IMPORT_REFUSALS, EXPORT_SHEET_HEADERS, ImportCsvChangedError,
  MAPPING_MAX_RECORD_CHARS, MAPPING_SAMPLE_RECORDS, MAX_FINDINGS_PER_CODE, SAMPLE_PREFIX_BYTES,
  type CsvImportCarrier, type CsvImportEffect, type CsvImportPlan,
} from "./import-csv.js";

// THE FORGIVING IMPORTER, EXERCISED AGAINST A CSV WRITTEN BY SOFTWARE THAT IS
// NOT THIS REPO.
//
// 7.7's definition of done asks for "a real foreign CSV -- not a fixture that
// resembles one". A file assembled by joining strings in this file would share
// every assumption services/csv.ts makes and would prove nothing, so the
// fixtures below come out of PYTHON'S OWN `csv` MODULE (see test/foreign-csv.ts)
// -- an independent implementation of the same format -- and one of them comes
// out of GET /api/export, which is Conduit's own bytes read as a foreign file.
// A handful of cases DO build a string by hand, and every one of them is a
// deliberately malformed file that no writer would produce: that is the point
// of those, and each says so.
//
// A DEVELOPER WITHOUT python3 SEES A SKIP, on backup.test.ts's precedent, and
// the it.runIf(CI) case at the foot of this file makes an unexpected absence
// loud.

const itPy = HAVE_PYTHON ? it : it.skip;
const it7z = HAVE_7Z ? it : it.skip;

const handle = openTestDatabase();
const db = handle.db;

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "1.4.0-test",
  devUser: null,
  dataDir: "./data",
  defaultCurrency: "EUR",
  mailKeyPath: "unused-in-tests",
  mailTlsRejectUnauthorized: true,
  portalApiUrl: "http://127.0.0.1:6788",
  reauthPassword: null,
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

let dataDir: string;
let scratch: string;
let actorId: string;
/** Everything an intake staged, disposed after each case whatever happened. */
let staged: StagedPayload[] = [];

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(db, {
    username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-csv-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-csv-out-"));
  staged = [];
});
afterEach(async () => {
  // THE UPLOAD IS A CREDENTIAL STORE EVEN HERE. A foreign CSV is somebody
  // else's customer list, which is exactly what services/intake.ts's discipline
  // is for, and a test that leaked one would stop proving the discipline holds.
  for (const payload of staged) await payload.dispose();
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

// --- fixtures --------------------------------------------------------------

/** Land a CSV through the spine's ingest and stage, exactly as a route would. */
async function stage(
  bytes: Buffer, filename = "contacts.csv",
): Promise<{ file: IntakeFile; payload: StagedPayload }> {
  const file = await receiveIntake({ dataDir, source: Readable.from([bytes]), filename });
  const payload = stageVerbatim({ file });
  staged.push(payload);
  return { file, payload };
}

/** Write a foreign CSV with Python and land it. */
async function foreign(
  rows: readonly (readonly string[])[],
  options: { delimiter?: string; encoding?: "utf-8" | "utf-8-sig"; lineterminator?: string } = {},
): Promise<Buffer> {
  return await writeForeignCsv({
    path: path.join(scratch, `fixture-${String(fixtureCount++)}.csv`), rows, ...options,
  });
}
let fixtureCount = 0;

/** The mapping step, for a file already written. */
async function mappingFor(bytes: Buffer, delimiter?: string): Promise<CsvMappingView> {
  const { file, payload } = await stage(bytes);
  return await inspectCsv({ file, payload, delimiter });
}

/** A mapping as the operator would supply it. */
function map(...entries: [number, CsvImportField][]): CsvMapping {
  return { entries: entries.map(([column, field]) => ({ column, field })) };
}

/** Stage a file and plan the import of it. */
async function planFor(
  bytes: Buffer, mapping: CsvMapping,
): Promise<{ plan: CsvImportPlan; payload: StagedPayload }> {
  const { file, payload } = await stage(bytes);
  return { plan: await planCsvImport({ file, payload, db, mapping }), payload };
}

/** Plan and apply, the whole way through. */
async function importCsv(
  bytes: Buffer, mapping: CsvMapping,
): Promise<{ plan: CsvImportPlan; payload: StagedPayload }> {
  const held = await planFor(bytes, mapping);
  await applyCsvImport({ plan: held.plan, payload: held.payload, db });
  return held;
}

/** Every finding of one code, in plan order. */
function findings(plan: { findings: readonly { code: string; message: string }[] }, code: string):
string[] {
  return plan.findings.filter((finding) => finding.code === code).map((f) => f.message);
}

/** The bytes GET /api/export answers with, through the real re-auth gate. */
async function exportArchive(): Promise<Buffer> {
  const app = await buildApp({ config, db, dataDir, reauthVerifier: testReauthVerifier() });
  const headers = await reauthedHeaders(app, authHeaders);
  const response = await app.inject({ method: "GET", url: "/api/export", headers });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}

/**
 * The Outlook-shaped contacts fixture: four people, the shapes that matter.
 *
 * A DELIBERATE MIX RATHER THAN FOUR CLEAN ROWS. Ada has three addresses across
 * the three email columns Outlook writes; Bob has none at all, which is the
 * no-key case; Cleo's second address is a typo; Dee's company is one this
 * install has.
 */
function outlookRows(): string[][] {
  const row = (values: Partial<Record<string, string>>): string[] =>
    OUTLOOK_CONTACT_HEADER.map((column) => values[column] ?? "");
  return [
    [...OUTLOOK_CONTACT_HEADER],
    row({
      "First Name": "Ada", "Last Name": "Lovelace", "Company": "Analytical Engines",
      "Job Title": "Mathematician", "Business Phone": "+31 6 12345678",
      "E-mail Address": "ada@analytical.example",
      "E-mail 2 Address": "a.lovelace@analytical.example",
      "E-mail 3 Address": "ADA@analytical.example",
      "Notes": "met at the conference",
    }),
    row({ "First Name": "Bob", "Last Name": "Nokey", "Job Title": "Cooper" }),
    row({
      "First Name": "Cleo", "Last Name": "Patra", "Company": "Nile Trading",
      "E-mail Address": "cleo@nile.example", "E-mail 2 Address": "not an address",
    }),
    row({
      "First Name": "Dee", "Last Name": "Delft", "Company": "Analytical Engines",
      "E-mail Address": "dee@analytical.example", "Mobile Phone": "0611111111",
    }),
  ];
}

/** The mapping an operator would arrive at for the Outlook fixture. */
function outlookMapping(): CsvMapping {
  const column = (name: string): number => OUTLOOK_CONTACT_HEADER.indexOf(name);
  return map(
    [column("First Name"), "contact.first_name"],
    [column("Last Name"), "contact.last_name"],
    [column("Company"), "contact.company_name"],
    [column("Job Title"), "contact.job_title"],
    [column("Business Phone"), "contact.phone"],
    [column("Mobile Phone"), "contact.phone"],
    [column("E-mail Address"), "contact.email"],
    [column("E-mail 2 Address"), "contact.email"],
    [column("E-mail 3 Address"), "contact.email"],
  );
}

// --- the guesser -----------------------------------------------------------

describe("guessing what a column is", () => {
  it("folds a header to one comparable spelling", () => {
    expect(foldHeader("E-mail Address")).toBe("e mail address");
    expect(foldHeader("email_address")).toBe("email address");
    expect(foldHeader("  Email   Address  ")).toBe("email address");
    expect(foldHeader("!!!")).toBe("");
  });

  it("guesses the fields Outlook's own header names", () => {
    expect(guessField("First Name", "contact")).toBe("contact.first_name");
    expect(guessField("E-mail 2 Address", "contact")).toBe("contact.email");
    expect(guessField("Mobile Phone", "contact")).toBe("contact.phone");
    expect(guessField("Job Title", "contact")).toBe("contact.job_title");
  });

  it("reads 'Company' as two different things depending on the sheet", () => {
    // NOTHING IN THE HEADER CAN TELL THESE APART, which is why the guess is
    // scoped to an entity and why the operator gets to overrule it.
    expect(guessField("Company", "company")).toBe("company.name");
    expect(guessField("Company", "contact")).toBe("contact.company_name");
  });

  it("guesses nothing for a header it does not know, rather than guessing wrong", () => {
    expect(guessField("Business Postal Code", "contact")).toBeNull();
    expect(guessField("Notes", "contact")).toBeNull();
    expect(guessField("", "contact")).toBeNull();
  });

  it("offers a companies sheet's suggestions for a companies header", () => {
    expect(guessEntity(["Company Name", "Domain", "Industry"])).toBe("company");
  });

  it("offers a contacts sheet's suggestions when the evidence ties or is absent", () => {
    // "Company" scores for both, so it ties; "First Name" is what only ever
    // means a contact.
    expect(guessEntity(["Company", "First Name"])).toBe("contact");
    expect(guessEntity(["Widget", "Sprocket"])).toBe("contact");
  });
});

// --- the mapping step ------------------------------------------------------

describe("the mapping step", () => {
  itPy("describes a real Outlook contacts export, column by column", async () => {
    const view = await mappingFor(await foreign(outlookRows()));
    expect(view.refusal).toBeNull();
    expect(view.columns).toHaveLength(OUTLOOK_CONTACT_HEADER.length);
    expect(view.sampled).toBe(4);
    expect(view.dialect.delimiter).toBe(",");
    expect(view.dialect.sniffed).toBe(true);

    const byHeader = new Map(view.columns.map((column) => [column.header, column]));
    expect(byHeader.get("First Name")?.suggestion).toBe("contact.first_name");
    expect(byHeader.get("E-mail 3 Address")?.suggestion).toBe("contact.email");
    // THE SAMPLES ARE WHAT A PERSON ACTUALLY READS. A header alone does not say
    // what "Notes" holds; the values under it do.
    expect(byHeader.get("Notes")?.samples).toEqual(["met at the conference"]);
    expect(byHeader.get("Notes")?.filled).toBe(1);
    expect(byHeader.get("First Name")?.filled).toBe(4);
  });

  itPy("surfaces every header it does not recognise, and does not guess at it", async () => {
    const view = await mappingFor(await foreign(outlookRows()));
    const unrecognised = view.columns
      .filter((column) => column.suggestion === null)
      .map((column) => column.header);
    // The columns Conduit genuinely has nowhere to put -- which is the "a
    // header row it does not recognise" case the spec asks this to handle.
    expect(unrecognised).toContain("Business Postal Code");
    expect(unrecognised).toContain("Notes");
    expect(unrecognised).toContain("Middle Name");
    const said = findings(view, CSV_IMPORT_FINDINGS.headerUnrecognised);
    expect(said.some((message) => message.includes('"Notes"'))).toBe(true);
    // ONE FINDING PER COLUMN, WHICH IS WHY THE PAGE KEYS ITS LIST BY INDEX.
    expect(said.length).toBeGreaterThan(1);
  });

  itPy("offers every field as a target, so the operator can map by hand", async () => {
    const view = await mappingFor(await foreign(outlookRows()));
    expect(view.targets.map((target) => target.field)).toContain("contact.pronouns");
    expect(view.targets.find((t) => t.field === "contact.email")?.repeatable).toBe(true);
    expect(view.targets.find((t) => t.field === "contact.first_name")?.required).toBe(true);
  });

  itPy("sniffs a European Excel file: semicolons, and a BOM that is not a header", async () => {
    const bytes = await foreign(
      [["Bedrijf", "Domein", "Plaats"], ["Acme B.V.", "acme.example", "Amsterdam"]],
      { delimiter: ";", encoding: "utf-8-sig" },
    );
    // THE FIXTURE'S OWN PREMISE, CHECKED: test/archives.ts learned that a
    // fixture nobody verified can quietly not be the thing under test.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain(";");

    const view = await mappingFor(bytes);
    expect(view.dialect.delimiter).toBe(";");
    expect(view.dialect.delimiterName).toBe("semicolon");
    // THE BOM DID NOT BECOME PART OF THE FIRST HEADER NAME, which is the whole
    // reason it is consumed at the very start of the document and nowhere else.
    expect(view.columns[0]?.header).toBe("Bedrijf");
    expect(view.columns[0]?.samples).toEqual(["Acme B.V."]);
    // A DUTCH HEADER ROW IS A HEADER ROW IT DOES NOT RECOGNISE, and that is the
    // ordinary case rather than the exotic one. Every column is still offered
    // and every one can be mapped by hand.
    expect(view.columns.map((column) => column.suggestion)).toEqual([null, null, null]);
    expect(findings(view, CSV_IMPORT_FINDINGS.headerUnrecognised)).toHaveLength(3);
  });

  itPy("lets the operator overrule the sniff, because a sniffer nobody can correct decides everything", async () => {
    const bytes = await foreign(
      [["Bedrijf", "Plaats"], ["Acme B.V.", "Amsterdam"]], { delimiter: ";" },
    );
    expect((await mappingFor(bytes)).dialect.delimiter).toBe(";");
    // Read as a comma file the whole record is one value, which is what the
    // operator sees on screen and what tells them the guess was wrong.
    const corrected = await mappingFor(bytes, ",");
    expect(corrected.dialect.delimiter).toBe(",");
    expect(corrected.dialect.sniffed).toBe(false);
    expect(corrected.columns).toHaveLength(1);
    expect(corrected.columns[0]?.header).toBe("Bedrijf;Plaats");
    expect(findings(corrected, CSV_IMPORT_FINDINGS.dialect)[0]).toMatch(/as chosen/);
  });

  it("refuses an empty upload, with nothing read", async () => {
    const view = await mappingFor(Buffer.alloc(0));
    expect(view.refusal?.code).toBe(CSV_IMPORT_REFUSALS.noHeader);
    expect(view.columns).toEqual([]);
  });

  it("refuses a file whose first row names no columns", async () => {
    // Hand-built: no writer produces this, which is the point of the case.
    const view = await mappingFor(Buffer.from(",,\r\na,b,c\r\n", "utf8"));
    expect(view.refusal?.code).toBe(CSV_IMPORT_REFUSALS.noColumns);
  });

  it7z("refuses a ZIP, and points at the importer that reads one", async () => {
    const zipPath = path.join(scratch, "export.zip");
    await writeZip({ zipPath, members: [{ name: "companies.csv", content: "id\r\n" }] });
    const view = await mappingFor(await readFile(zipPath));
    expect(view.refusal?.code).toBe(CSV_IMPORT_REFUSALS.notACsv);
    expect(view.refusal?.message).toMatch(/Import from a Conduit export/);
  });

  it("refuses a 7z, and points at Restore", async () => {
    // The magic bytes alone, which is all this check reads -- a whole encrypted
    // archive would prove the same thing more slowly.
    const bytes = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(64, 0x41),
    ]);
    const view = await mappingFor(bytes);
    expect(view.refusal?.code).toBe(CSV_IMPORT_REFUSALS.notACsv);
    expect(view.refusal?.message).toMatch(/Restore/);
  });

  it("refuses a file whose HEADER never ends, and reads one whose data record does not", async () => {
    // Hand-built damage: an unterminated quote turns the whole remainder into
    // one value, which is the one thing the forgiving reader will not forgive.
    const runaway = "x".repeat(MAPPING_MAX_RECORD_CHARS + 1);
    const noHeader = await mappingFor(Buffer.from(`"${runaway}`, "utf8"));
    expect(noHeader.refusal?.code).toBe(CSV_IMPORT_REFUSALS.recordTooLong);
    expect(noHeader.refusal?.message).toMatch(/never closed/);

    // A HEADER ALREADY IN HAND IS WORTH MORE THAN A REFUSAL. The damage is in
    // the data, the columns are still known, and the operator can still map
    // them; the PLAN is where a file this cannot read is actually refused.
    const mappable = await mappingFor(Buffer.from(`a,b\r\n"${runaway}`, "utf8"));
    expect(mappable.refusal).toBeNull();
    expect(mappable.columns.map((column) => column.header)).toEqual(["a", "b"]);
  });

  itPy("reports what the forgiving reader had to repair", async () => {
    // Hand-built, because Python's csv writer will not produce a quote inside
    // an unquoted value -- that is exactly what makes it a repair.
    const view = await mappingFor(Buffer.from('name\r\nBob "Bobby" Smith\r\n', "utf8"));
    expect(findings(view, CSV_IMPORT_FINDINGS.repaired)[0])
      .toMatch(/quote appeared inside an unquoted value/);
  });

  it("says so when the file is a sheet out of Conduit's own export", async () => {
    await createCompany(db, actorId, { name: "Acme" });
    const archive = await exportArchive();
    const sheet = await memberOf(archive, "companies.csv");
    const view = await mappingFor(sheet, ",");
    expect(findings(view, CSV_IMPORT_FINDINGS.looksLikeExport)[0])
      .toMatch(/sheet out of Conduit's own export/);
    // AND THE CLAIM IS PINNED TO THE REAL THING. If a column is ever added to
    // that sheet, this fails rather than leaving a note that quietly stopped
    // being true.
    expect(view.columns.map((column) => column.header)).toEqual([...EXPORT_SHEET_HEADERS[0] ?? []]);
  });
});

// --- the plan --------------------------------------------------------------

describe("the plan", () => {
  itPy("counts what a real Outlook export will create, and says what it will not", async () => {
    await createCompany(db, actorId, { name: "Analytical Engines" });
    const { plan } = await planFor(await foreign(outlookRows()), outlookMapping());
    expect(plan.refusal).toBeNull();
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0]?.op).toBe("insert-csv-contacts");
    expect(plan.effects[0]?.count).toBe(4);
    expect(plan.effects[0]?.destroys).toBe(false);
    // plannedTotal(plan, "row") -- proved by the exact importer, used here.
    expect(plannedTotal(planView(plan), "row")).toBe(4);

    // The typo is DROPPED and Cleo is KEPT, which is decision 1's one sentence.
    expect(findings(plan, CSV_IMPORT_FINDINGS.valueDropped)[0])
      .toMatch(/"not an address" is not an email address/);
    // Bob has no address at all, so nothing can match him.
    expect(findings(plan, CSV_IMPORT_FINDINGS.noKey)[0]).toMatch(/^1 of the rows/);
    // Two of the four name a company that IS here; Cleo's is not.
    expect(findings(plan, CSV_IMPORT_FINDINGS.companyUnlinked)[0])
      .toMatch(/1 of the contacts being created name a company this install cannot match/);
    expect(plan.effects[0]?.detail).toMatch(/2 of them linked to a company already here/);
    // EVERY COLUMN THE MAPPING LEFT OUT IS ACCOUNTED FOR, ten by name and the
    // rest by a count -- the same cap every repeating code here has, because
    // Outlook's real sheet has eighty columns and most of them are unmapped.
    const unmapped = findings(plan, CSV_IMPORT_FINDINGS.columnUnmapped);
    expect(unmapped[0]).toMatch(/column 2, "Middle Name", is not mapped/);
    expect(unmapped).toHaveLength(MAX_FINDINGS_PER_CODE + 1);
    expect(unmapped[MAX_FINDINGS_PER_CODE])
      .toMatch(/^11 columns in all are not mapped and are not imported\.$/);
  });

  itPy("refuses a mapping in csvMappingProblem's own words", async () => {
    const bytes = await foreign(outlookRows());
    const { plan } = await planFor(bytes, map([0, "contact.last_name"]));
    expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.mappingInvalid);
    expect(plan.refusal?.message)
      .toMatch(/no column is mapped to "First name", which every contact must have/);
    expect(plan.effects).toEqual([]);
  });

  itPy("refuses a file mapped to both kinds of record, and names the two-pass workflow", async () => {
    const bytes = await foreign([["Company", "First Name"], ["Acme", "Ada"]]);
    const { plan } = await planFor(bytes, map([0, "company.name"], [1, "contact.first_name"]));
    expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.mappingInvalid);
    expect(plan.refusal?.message).toMatch(/import the companies first/);
  });

  itPy("refuses a mapping that points past the end of this file's header", async () => {
    // THE STALE-MAPPING CASE: an operator with two uploads in front of them, or
    // a page that kept the last file's mapping. Refused before a row is read,
    // against THIS file's header rather than against a count a caller supplied.
    const bytes = await foreign([["Name"], ["Acme"]]);
    const { plan } = await planFor(bytes, map([0, "company.name"], [4, "company.domain"]));
    expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.mappingInvalid);
    expect(plan.refusal?.message).toMatch(/column 4 is not one of this file's 1 columns/);
  });

  itPy("skips a row with no value in the one required field, and names it", async () => {
    const bytes = await foreign([
      ["First Name", "Last Name"], ["Ada", "Lovelace"], ["", "Nameless"], ["Cleo", "Patra"],
    ]);
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.last_name"]));
    expect(plan.effects[0]?.count).toBe(2);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowSkipped))
      .toEqual(["row 3 is not imported because it has no first name."]);
  });

  itPy("skips a row with more values than the header has columns", async () => {
    // Hand-built: the ordinary cause is a delimiter inside an unquoted value,
    // which no correct writer produces and which shifts every column after it.
    const bytes = Buffer.from(
      "First Name,Last Name\r\nAda,Lovelace\r\nCleo,Patra,Alexandria\r\n", "utf8",
    );
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.last_name"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowSkipped)[0])
      .toMatch(/row 3 is not imported because it has 3 values where the header has 2 columns/);
  });

  itPy("keeps a row with FEWER values, because nothing after it is shifted", async () => {
    const bytes = Buffer.from("First Name,Last Name\r\nAda,Lovelace\r\nCleo\r\n", "utf8");
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.last_name"]));
    expect(plan.effects[0]?.count).toBe(2);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowShort)[0])
      .toMatch(/row 3 has 1 values where the header has 2 columns/);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowSkipped)).toEqual([]);
  });

  itPy("drops an over-long salutation rather than truncating it or losing the person", async () => {
    const bytes = await foreign([
      ["First Name", "Salutation"], ["Ada", "x".repeat(65)],
    ]);
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.salutation"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.valueDropped)[0])
      .toMatch(/its Salutation is longer than 64 characters/);
  });

  itPy("counts every repeating finding but shows at most ten worked examples", async () => {
    // THE FINDINGS ARRAY IS THE ONE PART OF A PLAN THAT GROWS WITH THE DATA,
    // which is exactly what this bound exists to stop -- a plan held for its
    // whole TTL and rendered into a page.
    // TWO COLUMNS, BECAUSE A RECORD OF ONE EMPTY VALUE IS A BLANK LINE and the
    // reader drops it before this module ever sees it -- which is right, and is
    // why a one-column version of this fixture would count nothing at all.
    const rows: string[][] = [["First Name", "Last Name"]];
    for (let n = 0; n < 25; n += 1) rows.push(["", `Nameless ${String(n)}`]);
    rows.push(["Ada", "Lovelace"]);
    const { plan } = await planFor(
      await foreign(rows), map([0, "contact.first_name"], [1, "contact.last_name"]),
    );
    const said = findings(plan, CSV_IMPORT_FINDINGS.rowSkipped);
    expect(said).toHaveLength(MAX_FINDINGS_PER_CODE + 1);
    expect(said[MAX_FINDINGS_PER_CODE]).toMatch(/^25 rows in all are not imported/);
    expect(plan.effects[0]?.count).toBe(1);
  });

  itPy("refuses a file with nothing left to add, and says how many rows it read", async () => {
    const bytes = await foreign([["First Name", "Last Name"], ["", "One"], ["", "Two"]]);
    const { plan } = await planFor(
      bytes, map([0, "contact.first_name"], [1, "contact.last_name"]),
    );
    expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.nothingToImport);
    expect(plan.refusal?.message).toMatch(/Of its 2 rows/);
    expect(plan.effects).toEqual([]);
  });

  itPy("does not count a blank line as a row at all", async () => {
    // A TRAILING BLANK LINE IS WHAT EVERY SPREADSHEET LEAVES BEHIND, and
    // offering it as a row with the wrong number of columns would put a warning
    // in front of the operator about something nobody typed.
    const bytes = Buffer.from("First Name\r\nAda\r\n\r\nCleo\r\n\r\n", "utf8");
    const { plan } = await planFor(bytes, map([0, "contact.first_name"]));
    expect(plan.effects[0]?.count).toBe(2);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowSkipped)).toEqual([]);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowShort)).toEqual([]);
  });
});

// --- duplicates ------------------------------------------------------------

describe("duplicate detection", () => {
  itPy("matches a contact already here on any of its email addresses, ignoring case", async () => {
    await createContact(db, actorId, { firstName: "Ada", emails: ["ADA@Analytical.Example"] });
    const bytes = await foreign([
      ["First Name", "Email"], ["Ada", "ada@analytical.example"], ["Cleo", "cleo@nile.example"],
    ]);
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.email"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.duplicateHere)).toEqual([
      "row 2 is already in this install (the email address ada@analytical.example) and is "
      + "left exactly as it is; the import does not change it.",
    ]);
  });

  itPy("matches a company already here on its domain, ignoring case", async () => {
    await createCompany(db, actorId, { name: "Acme", domain: "ACME.example" });
    const bytes = await foreign([
      ["Company Name", "Domain"], ["Acme Ltd", "acme.example"], ["Nile", "nile.example"],
    ]);
    const { plan } = await planFor(bytes, map([0, "company.name"], [1, "company.domain"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.duplicateHere)[0])
      .toMatch(/row 2 is already in this install \(the domain acme.example\)/);
  });

  itPy("counts an ARCHIVED row as already here, because Conduit never expunges", async () => {
    const company = await createCompany(db, actorId, { name: "Acme", domain: "acme.example" });
    await archiveCompany(db, actorId, company.id);
    const bytes = await foreign([["Company Name", "Domain"], ["Acme Ltd", "acme.example"]]);
    const { plan } = await planFor(bytes, map([0, "company.name"], [1, "company.domain"]));
    // Creating a second Acme beside the archived one is the outcome that cannot
    // be undone without work; un-archiving is one click.
    expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.nothingToImport);
  });

  itPy("tells a repeat WITHIN the file apart from one already in the install", async () => {
    // THE TWO-LAYER DISCRIMINATION FOR THE DUPLICATE RULE. This file's address
    // is in NEITHER the install nor an earlier row, and then in BOTH -- so
    // exactly one layer can fire in each half and the two say different things.
    await createContact(db, actorId, { firstName: "Here", emails: ["here@example.com"] });
    const bytes = await foreign([
      ["First Name", "Email"],
      ["Ada", "ada@example.com"],
      ["Ada again", "ADA@example.com"],
      ["Here too", "here@example.com"],
    ]);
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.email"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.duplicateInFile)).toEqual([
      "row 3 repeats an earlier row of this file (the email address ada@example.com) and is "
      + "imported only once.",
    ]);
    expect(findings(plan, CSV_IMPORT_FINDINGS.duplicateHere)).toEqual([
      "row 4 is already in this install (the email address here@example.com) and is left "
      + "exactly as it is; the import does not change it.",
    ]);
  });

  itPy("never matches a row with no key, and says how many there are", async () => {
    await createContact(db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });
    const bytes = await foreign([
      ["First Name", "Email"], ["Ada", ""], ["Ada", ""],
    ]);
    const { plan } = await planFor(bytes, map([0, "contact.first_name"], [1, "contact.email"]));
    // BOTH are created, and neither is matched against the Ada that is here --
    // which is precisely the number that turns into complaints later, so it is
    // in the preview.
    expect(plan.effects[0]?.count).toBe(2);
    expect(findings(plan, CSV_IMPORT_FINDINGS.noKey)[0])
      .toMatch(/2 of the rows being created have no email address/);
  });

  itPy("does not normalise beyond case, and the preview shows what that costs", async () => {
    // THE COST OF DECISION 2, ASSERTED RATHER THAN ONLY WRITTEN DOWN.
    // `www.acme.com` and `acme.com` are two companies here, because a cleverer
    // rule would have to be written twice -- once in SQL and once here.
    await createCompany(db, actorId, { name: "Acme", domain: "acme.example" });
    const bytes = await foreign([["Company Name", "Domain"], ["Acme", "www.acme.example"]]);
    const { plan } = await planFor(bytes, map([0, "company.name"], [1, "company.domain"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.duplicateHere)).toEqual([]);
  });
});

// --- the company link ------------------------------------------------------

describe("linking a contact to a company by name", () => {
  itPy("links to the one company with that name, ignoring case and surrounding space", async () => {
    const acme = await createCompany(db, actorId, { name: "Acme Ltd" });
    const bytes = await foreign([
      ["First Name", "Company"], ["Ada", "  acme ltd  "],
    ]);
    await importCsv(bytes, map([0, "contact.first_name"], [1, "contact.company_name"]));
    const [row] = await db.select().from(contacts).where(eq(contacts.firstName, "Ada"));
    expect(row?.companyId).toBe(acme.id);
  });

  itPy("links to nothing when more than one company answers to the name, and says so", async () => {
    // THE TWO COMPANIES GENUINELY CALLED ACME, which is the case that rules a
    // name out as a key in the first place.
    await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "ACME" });
    const bytes = await foreign([["First Name", "Company"], ["Ada", "Acme"]]);
    const mapping = map([0, "contact.first_name"], [1, "contact.company_name"]);
    const { plan, payload } = await planFor(bytes, mapping);
    // TWO SENTENCES, NOT ONE. "No company here answers to this name" is fixed by
    // importing the companies first; "more than one does" is not, and an
    // operator sent to the wrong remedy has been told nothing.
    expect(findings(plan, CSV_IMPORT_FINDINGS.companyUnlinked)[0])
      .toMatch(/0 name no company that is here, and 1 name one that more than one company/);
    await applyCsvImport({ plan, payload, db });
    const [row] = await db.select().from(contacts);
    expect(row?.companyId).toBeNull();
  });

  itPy("never creates a company from a contact import, and says to import them first", async () => {
    const bytes = await foreign([["First Name", "Company"], ["Ada", "Nowhere Ltd"]]);
    const mapping = map([0, "contact.first_name"], [1, "contact.company_name"]);
    await importCsv(bytes, mapping);
    expect(await db.select().from(companies)).toEqual([]);
    const [row] = await db.select().from(contacts);
    expect(row?.companyId).toBeNull();
  });

  itPy("does not look the links up again at apply, so a late company changes nothing", async () => {
    // `companyByName` IS FROZEN AT PLAN TIME, on knownOwners' argument:
    // re-measuring would let a company created while the operator read the
    // preview change what the import does, silently and after the fact.
    const bytes = await foreign([["First Name", "Company"], ["Ada", "Late Ltd"]]);
    const mapping = map([0, "contact.first_name"], [1, "contact.company_name"]);
    const { plan, payload } = await planFor(bytes, mapping);
    await createCompany(db, actorId, { name: "Late Ltd" });
    await applyCsvImport({ plan, payload, db });
    const [row] = await db.select().from(contacts);
    expect(row?.companyId).toBeNull();
  });

  itPy("imports companies then contacts, which is the workflow the refusal names", async () => {
    const companySheet = await foreign([
      ["Company Name", "Domain"],
      ["Analytical Engines", "analytical.example"],
      ["Nile Trading", "nile.example"],
    ]);
    await importCsv(companySheet, map([0, "company.name"], [1, "company.domain"]));
    expect(await db.select().from(companies)).toHaveLength(2);

    await importCsv(await foreign(outlookRows()), outlookMapping());
    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(4);
    const linked = rows.filter((row) => row.companyId !== null);
    expect(linked).toHaveLength(3);
  });
});

// --- apply -----------------------------------------------------------------

describe("applying an import", () => {
  itPy("imports a real foreign CSV end to end, with the rows verified", async () => {
    // THE DEFINITION OF DONE, IN ONE CASE: a CSV written by Python's own csv
    // module, mapped by hand, previewed, imported, and the rows read back.
    await createCompany(db, actorId, { name: "Analytical Engines" });
    const bytes = await foreign(outlookRows());
    // The fixture's own premise: Python wrote CRLF and quoted nothing it did
    // not have to.
    expect(bytes.toString("utf8")).toContain("\r\n");

    const { plan } = await importCsv(bytes, outlookMapping());
    expect(plan.effects[0]?.count).toBe(4);

    const rows = await db.select().from(contacts).orderBy(contacts.firstName);
    expect(rows.map((row) => row.firstName)).toEqual(["Ada", "Bob", "Cleo", "Dee"]);

    const ada = rows.find((row) => row.firstName === "Ada");
    expect(ada?.lastName).toBe("Lovelace");
    expect(ada?.jobTitle).toBe("Mathematician");
    // THREE COLUMNS ONTO ONE text[], IN COLUMN ORDER, with the third dropped as
    // a second spelling of the first -- which is what makes contact.email
    // repeatable in the first place.
    expect(ada?.emails).toEqual(["ada@analytical.example", "a.lovelace@analytical.example"]);
    expect(ada?.phones).toEqual(["+31 6 12345678"]);
    expect(ada?.companyId).not.toBeNull();
    // NOBODY OWNS AN IMPORTED ROW. A spreadsheet has no Conduit user in it.
    expect(ada?.ownerUserId).toBeNull();

    const cleo = rows.find((row) => row.firstName === "Cleo");
    // The typo was dropped and the person was kept.
    expect(cleo?.emails).toEqual(["cleo@nile.example"]);
    expect(cleo?.companyId).toBeNull();

    const bob = rows.find((row) => row.firstName === "Bob");
    expect(bob?.emails).toEqual([]);
    expect(bob?.phones).toEqual([]);
  });

  itPy("imports a European Excel companies sheet, BOM, semicolons and accents intact", async () => {
    const bytes = await foreign(
      [
        ["Bedrijfsnaam", "Domein", "Adres", "Branche"],
        ["M\u00FCller & S\u00F6hne GmbH", "mueller.example", "Hauptstra\u00DFe 1", "Fertigung"],
        ["Caf\u00E9 \u00C9lys\u00E9e", "elysee.example", "", ""],
      ],
      { delimiter: ";", encoding: "utf-8-sig" },
    );
    await importCsv(bytes, map(
      [0, "company.name"], [1, "company.domain"], [2, "company.address"], [3, "company.industry"],
    ));
    const rows = await db.select().from(companies).orderBy(companies.name);
    expect(rows.map((row) => row.name))
      .toEqual(["Caf\u00E9 \u00C9lys\u00E9e", "M\u00FCller & S\u00F6hne GmbH"]);
    expect(rows[1]?.address).toBe("Hauptstra\u00DFe 1");
    // AN EMPTY CELL IS NULL, which is the same choice the exact importer makes
    // and for the same reason: the create services never store an empty string
    // in these columns.
    expect(rows[0]?.address).toBeNull();
    expect(rows[0]?.industry).toBeNull();
  });

  it("does not reverse Conduit's own apostrophe transform, because it is not Conduit's file", async () => {
    // A LEADING APOSTROPHE IN SOMEBODY ELSE'S FILE IS THEIR DATA. Hand-built,
    // because what is under test is a byte a foreign writer had no reason to
    // put there and Conduit's own writer would have meant something by.
    const bytes = Buffer.from("Company Name\r\n'=SUM(A1)\r\n''already\r\n", "utf8");
    await importCsv(bytes, map([0, "company.name"]));
    const rows = await db.select().from(companies).orderBy(companies.name);
    expect(rows.map((row) => row.name)).toEqual(["''already", "'=SUM(A1)"]);
  });

  itPy("writes more rows than one batch, in one transaction", async () => {
    const rows: string[][] = [["First Name", "Email"]];
    for (let n = 0; n < 1200; n += 1) rows.push([`P${String(n)}`, `p${String(n)}@example.com`]);
    const { plan } = await importCsv(
      await foreign(rows), map([0, "contact.first_name"], [1, "contact.email"]),
    );
    expect(plan.effects[0]?.count).toBe(1200);
    const [counted] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM contacts`);
    expect(counted?.n).toBe("1200");
  });

  itPy("rolls the whole import back when a row became a duplicate while the preview was open", async () => {
    const bytes = await foreign([
      ["First Name", "Email"], ["Ada", "ada@example.com"], ["Cleo", "cleo@example.com"],
    ]);
    const { plan, payload } = await planFor(
      bytes, map([0, "contact.first_name"], [1, "contact.email"]),
    );
    expect(plan.effects[0]?.count).toBe(2);
    await createContact(db, actorId, { firstName: "Somebody", emails: ["ADA@example.com"] });

    const error = await applyCsvImport({ plan, payload, db }).catch((e: unknown) => e);
    // THE FRAME WRAPS A HANDLER'S OWN FAILURE and carries the partial outcome,
    // so the cause is what says whose fault this was -- the same shape
    // services/import-export.test.ts asserts for its own half.
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportCsvChangedError);
    expect((error as PlanApplyError).cause).toMatchObject({ planned: 2, inserted: 1 });
    expect((error as Error).message).toMatch(/the column mapping is unaffected/);
    // NOTHING WAS IMPORTED. Cleo would have landed before Ada was skipped; the
    // transaction is what takes her back out.
    expect(await db.select().from(contacts).where(eq(contacts.firstName, "Cleo"))).toEqual([]);
  });

  itPy("rolls back in the other direction too, when a row STOPPED being a duplicate", async () => {
    const gone = await createContact(db, actorId, {
      firstName: "Somebody", emails: ["ada@example.com"],
    });
    const bytes = await foreign([
      ["First Name", "Email"], ["Ada", "ada@example.com"], ["Cleo", "cleo@example.com"],
    ]);
    const { plan, payload } = await planFor(
      bytes, map([0, "contact.first_name"], [1, "contact.email"]),
    );
    expect(plan.effects[0]?.count).toBe(1);
    // The address moves off the contact rather than the contact being deleted:
    // createContact stamps a timeline event, and events.contact_id holds a
    // reference this test has no business tearing out.
    await db.update(contacts).set({ emails: [] }).where(eq(contacts.id, gone.id));

    const error = await applyCsvImport({ plan, payload, db }).catch((e: unknown) => e);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportCsvChangedError);
    expect((error as PlanApplyError).cause).toMatchObject({ planned: 1, inserted: 2 });
    expect(await db.select().from(contacts)).toHaveLength(1);
  });

  itPy("answers a moved database and a broken step with DIFFERENT errors", async () => {
    // WHICH LAYER FIRED. Two layers guard the count: this file's comparison,
    // whose cause is a database that moved, and the frame's accounting, whose
    // cause is a bug in a step. They must not arrive as one error, because an
    // operator acts on one of them and a developer on the other.
    const bytes = await foreign([["First Name", "Email"], ["Ada", "ada@example.com"]]);
    const { plan, payload } = await planFor(
      bytes, map([0, "contact.first_name"], [1, "contact.email"]),
    );
    await createContact(db, actorId, { firstName: "Somebody", emails: ["ada@example.com"] });
    const moved = await applyCsvImport({ plan, payload, db }).catch((e: unknown) => e);
    expect(moved).not.toBeInstanceOf(PlanExceededError);
    expect((moved as PlanApplyError).cause).toBeInstanceOf(ImportCsvChangedError);

    // The frame's layer, reached with a step that overspends -- the shape a bug
    // in this file would have.
    const overspend = await applyPlan<CsvImportEffect, CsvImportCarrier>({
      plan,
      reader: payload,
      carrier: { tx: db },
      handlers: {
        "insert-csv-companies": () => Promise.resolve(),
        "insert-csv-contacts": (effect, ctx) => {
          ctx.spend(effect.count + 1);
          return Promise.resolve();
        },
      },
    }).catch((e: unknown) => e);
    expect(overspend).toBeInstanceOf(PlanExceededError);
    expect(overspend).not.toBeInstanceOf(ImportCsvChangedError);
  });

  itPy("reads only the file its effect names", async () => {
    // The frame's containment, exercised through this half: a step that reaches
    // for a member its effect did not publish is refused rather than trusted.
    const bytes = await foreign([["First Name"], ["Ada"]]);
    const { plan, payload } = await planFor(bytes, map([0, "contact.first_name"]));
    const other = await stage(Buffer.from("x\r\n", "utf8"), "other.csv");
    const stolen = other.payload.members[0]?.ref;
    expect(stolen).toBeDefined();
    const error = await applyPlan<CsvImportEffect, CsvImportCarrier>({
      plan,
      reader: payload,
      carrier: { tx: db },
      handlers: {
        "insert-csv-companies": () => Promise.resolve(),
        "insert-csv-contacts": async (_effect, ctx) => {
          if (stolen !== undefined) await ctx.open(stolen);
        },
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanExceededError);
  });
});

// --- the value that cannot be stored, and the two layers that stop it -------

describe("a NUL in the file", () => {
  itPy("skips the row when the value is required, and names it", async () => {
    // Hand-built through Python, which will write a NUL quite happily -- it is
    // legal in a text file and it is not legal in a Postgres column.
    const bytes = await foreign([["Company Name"], ["Ac\u0000me"], ["Fine Ltd"]]);
    expect(bytes.includes(0)).toBe(true);
    const { plan } = await planFor(bytes, map([0, "company.name"]));
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.rowSkipped)[0])
      .toMatch(/row 2 is not imported because its company name holds a character that cannot be stored/);
  });

  itPy("drops the value and keeps the row when it is optional", async () => {
    const bytes = await foreign([["Company Name", "Industry"], ["Acme", "Fer\u0000tigung"]]);
    const { plan, payload } = await planFor(
      bytes, map([0, "company.name"], [1, "company.industry"]),
    );
    expect(plan.effects[0]?.count).toBe(1);
    expect(findings(plan, CSV_IMPORT_FINDINGS.valueDropped)[0])
      .toMatch(/its Industry holds a character that cannot be stored/);
    // AND THE APPLY GOES THROUGH, which is the half that matters: without the
    // drop this INSERT is a 22021 inside the transaction. See the case below.
    await applyCsvImport({ plan, payload, db });
    const [row] = await db.select().from(companies);
    expect(row?.name).toBe("Acme");
    expect(row?.industry).toBeNull();
  });

  it("is what Postgres itself refuses, which is the layer underneath", async () => {
    // THE SECOND LAYER, SHOWN FIRING. Without the check above, this is what an
    // import would meet -- in the middle of a transaction that has already
    // written thousands of rows, with a SQLSTATE and no row number. Proving it
    // here is what makes the check above an instrument rather than a belief.
    const error = await db.insert(companies).values({ name: "Ac\u0000me" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // drizzle wraps the driver's error, so the SQLSTATE is on the cause. That
    // is the shape an import would actually have to interpret, and it carries
    // no record number and no column name -- which is the argument for catching
    // this in the preview rather than here.
    const cause = (error as Error).cause;
    expect((cause as { code?: string }).code).toBe("22021");
    expect((cause as Error).message).toMatch(/invalid byte sequence/);
  });
});

// --- descriptors -----------------------------------------------------------

describe("the streams this module opens", () => {
  // /proc is the only way for a process to count its own open descriptors, and
  // it is Linux-only -- the same probe services/export.test.ts and
  // services/import-export.test.ts use for the same discipline.
  const HAVE_PROC = existsSync("/proc/self/fd");
  const itFd = HAVE_PROC && HAVE_PYTHON ? it : it.skip;

  async function openDescriptors(): Promise<number> {
    return (await readdir("/proc/self/fd")).length;
  }

  itFd("closes every stream on the path that finishes", async () => {
    // THIS MODULE OPENS FOUR STREAMS PER IMPORT: a bounded prefix at the
    // mapping step, a bounded prefix again for the plan's header and delimiter,
    // then the whole file to build the plan and the whole file again to apply
    // it. Every one is a descriptor on a file inside a credential store, and
    // 7.6 measured what an unclosed one costs -- five abandoned downloads left
    // five descriptors held for ever, and descriptor exhaustion fails every
    // file operation in the app rather than only the feature that leaked.
    const bytes = await foreign([["First Name", "Email"], ["Ada", "ada@example.com"]]);
    const mapping = map([0, "contact.first_name"], [1, "contact.email"]);

    const cycle = async (): Promise<void> => {
      // createContact stamps a timeline event, and events.contact_id references
      // the row -- so the events go first or the delete is a 23503.
      await db.delete(events);
      await db.delete(contacts);
      const { file, payload } = await stage(bytes);
      await inspectCsv({ file, payload });
      const plan = await planCsvImport({ file, payload, db, mapping });
      await applyCsvImport({ plan, payload, db });
      await payload.dispose();
    };

    await cycle();
    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) await cycle();
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  });

  itFd("closes the prefix stream the mapping step ABANDONS on its ordinary path", async () => {
    // THE PATH THAT LEAKS IF ANYTHING DOES, and here it is the ordinary path
    // rather than the exotic one: the mapping step reads a megabyte of a much
    // larger file and never asks for another byte. Whether that descriptor
    // closes is a `finally` in this module rather than a property of Node's
    // async-iterator machinery.
    const rows: string[][] = [["First Name", "Email"]];
    for (let n = 0; n < 40000; n += 1) rows.push([`P${String(n)}`, `p${String(n)}@example.com`]);
    const bytes = await foreign(rows);
    // THE FIXTURE'S OWN PREMISE. If the file fitted inside the prefix, the
    // stream would run to its end and this test would measure nothing.
    expect(bytes.length).toBeGreaterThan(SAMPLE_PREFIX_BYTES);

    const cycle = async (): Promise<void> => {
      const { file, payload } = await stage(bytes);
      const view = await inspectCsv({ file, payload });
      expect(view.refusal).toBeNull();
      expect(view.sampled).toBe(MAPPING_SAMPLE_RECORDS);
      await payload.dispose();
    };

    await cycle();
    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) await cycle();
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  });

  itFd("closes the stream a refusal abandons mid-parse", async () => {
    // ONE UNTERMINATED VALUE OVER BOTH BOUNDS -- the mapping step's own and the
    // reader's default. Each half throws from inside a generator half way
    // through the file and never asks for another byte, which is the shape
    // whose descriptor is a property of the code here rather than of the
    // reader's good manners. Slow on purpose: eight million characters is what
    // it takes to reach services/csv.ts's real bound, so this case carries its
    // own timeout rather than being made cheap and stopping measuring the plan.
    const bytes = Buffer.from(`"${"x".repeat(DEFAULT_MAX_RECORD_CHARS + 10)}`, "utf8");
    const cycle = async (): Promise<void> => {
      const { file, payload } = await stage(bytes);
      const view = await inspectCsv({ file, payload });
      expect(view.refusal?.code).toBe(CSV_IMPORT_REFUSALS.recordTooLong);
      const plan = await planCsvImport({ file, payload, db, mapping: map([0, "company.name"]) });
      expect(plan.refusal?.code).toBe(CSV_IMPORT_REFUSALS.recordTooLong);
      await payload.dispose();
    };

    await cycle();
    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) await cycle();
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  }, 60_000);

  itFd("closes the stream an apply that FAILS was reading", async () => {
    const bytes = await foreign([
      ["First Name", "Email"], ["Ada", "ada@example.com"], ["Cleo", "cleo@example.com"],
    ]);
    const mapping = map([0, "contact.first_name"], [1, "contact.email"]);

    const cycle = async (): Promise<void> => {
      // createContact stamps a timeline event, and events.contact_id references
      // the row -- so the events go first or the delete is a 23503.
      await db.delete(events);
      await db.delete(contacts);
      const { file, payload } = await stage(bytes);
      const plan = await planCsvImport({ file, payload, db, mapping });
      await createContact(db, actorId, { firstName: "Blocker", emails: ["ada@example.com"] });
      const error = await applyCsvImport({ plan, payload, db }).catch((e: unknown) => e);
      expect((error as PlanApplyError).cause).toBeInstanceOf(ImportCsvChangedError);
      await payload.dispose();
    };

    await cycle();
    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) await cycle();
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  });
});

// --- the environment this suite depends on ---------------------------------

it.runIf(Boolean(process.env.CI))("has python3 here, because CI must write the foreign fixtures", () => {
  expect(HAVE_PYTHON).toBe(true);
});

/** One member of a zip, read back out of a staging. */
async function memberOf(zipBytes: Buffer, name: string): Promise<Buffer> {
  const file = await receiveIntake({
    dataDir, source: Readable.from([zipBytes]), filename: "export.zip",
  });
  const payload = await stageArchive({ file, passphrase: null });
  staged.push(payload);
  const member = payload.byName(name);
  if (member === undefined) throw new Error(`no ${name} in this archive`);
  return await payload.readBytes(member.ref);
}
