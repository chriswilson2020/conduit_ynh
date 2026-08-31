import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod, mkdtemp, mkdir, open, readFile, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { promisify } from "node:util";
import type { Database } from "../db/client.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact, archiveContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal, archiveDeal } from "./deals.js";
import { createProject, archiveProject } from "./projects.js";
import { createTask, archiveTask } from "./tasks.js";
import { createNote } from "./notes.js";
import { createMeeting, archiveMeeting } from "./meetings.js";
import {
  companies as companiesTable, deals as dealsTable, documents as documentsTable,
  mailAccounts, mailAttachments, mailMessages, mailThreads,
} from "../db/schema.js";
import {
  archiveFileName, buildExport, withExportSnapshot,
  EXPORT_FORMAT_VERSION, type ExportManifest,
} from "./export.js";

const execFileAsync = promisify(execFile);

// EXTRACTION IS DONE BY unzip(1), NOT BY A READER WRITTEN HERE.
//
// A zip reader written in this file would share every assumption the writer
// makes, so an archive both agreed was well-formed could still be one nothing
// else opens -- which is the only property that matters for an artefact whose
// entire purpose is being opened by somebody else's software. unzip is Info-ZIP,
// it is on the dev machine, the dev server and the CI runner, and it is the same
// class of ordinary tool the spec names for the backup.
//
// Probed rather than assumed, on documents-render.test.ts's precedent: a
// developer without it gets a green suite, and the runIf(CI) test below is what
// makes an unexpected absence loud where it would matter.
const HAVE_UNZIP = await (async () => {
  try {
    await execFileAsync("unzip", ["-v"]);
    return true;
  } catch {
    return false;
  }
})();
const itZip = HAVE_UNZIP ? it : it.skip;

const handle = openTestDatabase();
let actorId: string;
let dataDir: string;
let scratch: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-export-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-export-out-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

/** Run the export and write the zip to disk, returning its path. */
async function writeArchive(overrides: { now?: Date } = {}): Promise<string> {
  const archive = await buildExport({
    db: handle.db, dataDir, appVersion: "1.3.0-test", now: overrides.now,
  });
  const zipPath = path.join(scratch, archive.filename);
  await pipeline(archive.stream, createWriteStream(zipPath));
  return zipPath;
}

/** Extract the archive with unzip and return the extraction root. */
async function extract(zipPath: string): Promise<string> {
  const out = path.join(scratch, "extracted");
  await mkdir(out, { recursive: true });
  await execFileAsync("unzip", ["-qq", "-o", zipPath, "-d", out]);
  return out;
}

/** Every member path in the archive, relative to its root, sorted. */
async function memberPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else found.push(rel);
    }
  };
  await walk(root, "");
  return found.sort();
}

/**
 * Parse one extracted CSV into header + records, with the BOM stripped.
 *
 * A real RFC 4180 parser, because a `split(",")` would silently agree with a
 * writer that had stopped quoting: quoted fields carrying commas and newlines
 * are exactly what these tests are checking survive.
 */
function parseCsv(text: string): { header: string[]; records: string[][] } {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(field); field = ""; records.push(row); row = []; i += 1;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); records.push(row); }
  const header = records.shift() ?? [];
  return { header, records };
}

/** One extracted CSV, parsed. */
async function readSheet(root: string, name: string): Promise<{ header: string[]; records: string[][] }> {
  return parseCsv(await readFile(path.join(root, name), "utf8"));
}

/** The value of one column of one record, by header name. */
function cell(sheet: { header: string[]; records: string[][] }, recordIndex: number, column: string): string {
  const index = sheet.header.indexOf(column);
  expect(index, `column ${column} is missing from ${sheet.header.join(",")}`).toBeGreaterThanOrEqual(0);
  return sheet.records[recordIndex]?.[index] ?? "";
}

async function readManifest(root: string): Promise<ExportManifest> {
  return JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as ExportManifest;
}

/** Store a blob and attach it as a `files` row against a company. */
async function attachBlob(
  db: Database, companyId: string, originalName: string, content: Buffer, mime = "application/pdf",
): Promise<{ id: string; sha256: string }> {
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
  const file = await attachFile(db, actorId, { originalName, mime, sizeBytes, sha256, companyId });
  return { id: file.id, sha256 };
}

/** A pipeline, a stage and a deal in it -- the shape deals.csv needs to be interesting. */
async function makeDeal(db: Database, title: string, companyId?: string, contactId?: string) {
  const pipeline = await createPipeline(db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(db, actorId, pipeline.id, { name: "Negotiation" });
  // ownerUserId is passed explicitly: createDeal leaves deals.owner_user_id
  // NULL unless a caller names an owner, and an unowned deal would leave
  // owner_username legitimately blank -- which is not what the denormalisation
  // test is trying to check.
  const deal = await createDeal(
    db, actorId,
    { title, pipelineId: pipeline.id, stageId: stage.id, companyId, contactId, ownerUserId: actorId, valueCents: 123_456 },
    "EUR",
  );
  return { pipeline, stage, deal };
}

describe("archiveFileName", () => {
  it("keeps an ordinary name exactly", () => {
    expect(archiveFileName("Quote QUO-2026-0001.pdf")).toBe("Quote QUO-2026-0001.pdf");
  });

  // The requirement, one directory over from the BOM's: an archive that
  // flattened accents in member names would fail the same test the CSVs pass.
  it("keeps accented characters rather than flattening them", () => {
    expect(archiveFileName("Angebot-M\u00FCller.pdf")).toBe("Angebot-M\u00FCller.pdf");
  });

  it("reduces a path to its last segment, so a member cannot escape the archive", () => {
    expect(archiveFileName("../../etc/passwd")).toBe("passwd");
    expect(archiveFileName("C:\\Users\\chris\\secret.txt")).toBe("secret.txt");
  });

  it("replaces the characters Windows refuses in a name", () => {
    expect(archiveFileName('re:port<1>|"2"?*.pdf')).toBe("re_port_1___2___.pdf");
  });

  it("drops control characters", () => {
    expect(archiveFileName("re\u0000po\u001Frt.pdf")).toBe("re_po_rt.pdf");
  });

  it("strips the trailing dots and spaces Windows silently drops", () => {
    expect(archiveFileName("report.pdf. ")).toBe("report.pdf");
    expect(archiveFileName("report   ")).toBe("report");
  });

  it("names an empty or dot-only result rather than producing one", () => {
    expect(archiveFileName("")).toBe("file");
    expect(archiveFileName(".")).toBe("file");
    expect(archiveFileName("..")).toBe("file");
    expect(archiveFileName("///")).toBe("file");
  });

  it("escapes a Windows reserved device name, extension and all", () => {
    expect(archiveFileName("CON.pdf")).toBe("_CON.pdf");
    expect(archiveFileName("nul")).toBe("_nul");
    expect(archiveFileName("COM4.txt")).toBe("_COM4.txt");
    // Not reserved: only COM1-9 and LPT1-9 are.
    expect(archiveFileName("COM10.txt")).toBe("COM10.txt");
    expect(archiveFileName("CONTRACT.pdf")).toBe("CONTRACT.pdf");
  });

  it("truncates a very long name to a byte budget, keeping the extension", () => {
    const name = archiveFileName(`${"a".repeat(400)}.pdf`);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(180);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  // THE CHARACTER WIDTH IS THE WHOLE TEST, and the first version of it proved
  // nothing. The budget is 176 bytes once ".pdf" is reserved; a name of TWO-byte
  // characters divides into that exactly, so cutting the buffer at byte 176 --
  // the bug -- lands on a character boundary anyway and the assertion passes
  // either way. A THREE-byte character does not divide into 176, so a byte cut
  // leaves two thirds of a character behind and the decoder yields U+FFFD.
  // Mutation-tested: replacing the loop with a Buffer.subarray cut survives the
  // 2-byte case and is caught by the 3-byte one.
  it("truncates on a character boundary, so no character is cut in half", () => {
    // U+20AC, three bytes in UTF-8.
    const name = archiveFileName(`${"\u20AC".repeat(100)}.pdf`);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(180);
    expect(name).not.toContain("\uFFFD");
    // Round-trips: every byte in the name is part of a whole character.
    expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    expect(name.endsWith(".pdf")).toBe(true);

    // And the 2-byte case still holds, for the size it actually produces.
    const twoByte = archiveFileName(`${"\u00FC".repeat(200)}.pdf`);
    expect(Buffer.byteLength(twoByte, "utf8")).toBeLessThanOrEqual(180);
    expect(twoByte).not.toContain("\uFFFD");
  });

  // ABOVE THE BMP, where trimming one UNIT at a time is wrong for a second
  // reason: JavaScript indexes strings by UTF-16 code unit, so one slice off the
  // end of a name of emoji removes half a surrogate pair, and a lone surrogate
  // encodes as U+FFFD exactly like a severed UTF-8 sequence does.
  //
  // THE EXTENSION IS `.jpeg` AND THAT IS THE WHOLE TEST. With `.pdf` the budget
  // is 176 bytes, which four-byte characters divide exactly, so even the buggy
  // code-unit trim stops on a whole character and the case proves nothing --
  // measured: it passes against the bug. `.jpeg` leaves 175, which they do not
  // divide, so the code-unit trim stops one unit into a pair.
  it("truncates whole code points, so no surrogate pair is cut in half", () => {
    const name = archiveFileName(`${"\u{1F600}".repeat(60)}.jpeg`);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(180);
    expect(name).not.toContain("\uFFFD");
    expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    expect(name.endsWith(".jpeg")).toBe(true);
  });
});

/** Every message down an error's `cause` chain, joined. */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/** The Postgres SQLSTATE from anywhere in an error's `cause` chain. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

// An export is supposed to be a picture of the database at a moment, and the
// nine sheets are nine separate queries. Both halves of what makes that true are
// asserted here directly, because neither is observable from the finished
// archive: a torn export and a consistent one are the same file shape.
describe("withExportSnapshot", () => {
  // THE READ-ONLY HALF. This phase is read-only by construction, and this is the
  // one place that claim is made TO the database rather than about it.
  it("refuses a write, so the export cannot mutate anything even by mistake", async () => {
    const caught = await withExportSnapshot(handle.db, async (tx) => {
      await tx.insert(companiesTable).values({ name: "Should never exist" });
      return null;
    }).then(() => null, (error: unknown) => error);

    // Matched down the CAUSE CHAIN, not on the top message: drizzle wraps a
    // driver error as "Failed query: insert into ...", so an assertion against
    // `.message` alone would pass for any failing insert -- including one the
    // transaction settings had nothing to do with.
    expect(errorChainText(caught)).toMatch(/read-only transaction/i);
    // SQLSTATE 25006, read_only_sql_transaction: the same claim in the form
    // that does not depend on the server's language.
    expect(sqlState(caught)).toBe("25006");

    // And nothing landed.
    expect(await handle.db.select().from(companiesTable)).toHaveLength(0);
  });

  // THE SNAPSHOT HALF. Under Postgres's default READ COMMITTED each statement
  // takes a fresh snapshot, so the second read below would see TWO rows where the
  // first saw one -- and in the export proper, a deals query running after a
  // companies query could name a company that companies.csv never wrote.
  // The test pool holds two connections, so the inner write genuinely runs in
  // another session rather than queuing behind this one.
  it("shows every read the same rows, even when another session commits between them", async () => {
    await createCompany(handle.db, actorId, { name: "Present at the start" });

    const [before, after] = await withExportSnapshot(handle.db, async (tx) => {
      const first = await tx.select().from(companiesTable);
      // A different session, committing while the snapshot is held.
      await createCompany(handle.db, actorId, { name: "Arrived mid-export" });
      const second = await tx.select().from(companiesTable);
      return [first, second];
    });

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("Present at the start");
    // The row really was committed -- outside the snapshot it is visible, which
    // is what makes the two assertions above mean something.
    expect(await handle.db.select().from(companiesTable)).toHaveLength(2);
  });
});

describe("export archive shape", () => {
  itZip("contains every entity sheet and a manifest", async () => {
    const root = await extract(await writeArchive());
    expect(await memberPaths(root)).toEqual([
      "companies.csv", "contacts.csv", "deals.csv", "documents.csv", "files.csv",
      "manifest.json", "meetings.csv", "notes.csv", "projects.csv", "tasks.csv",
    ]);
  });

  itZip("records the format, app and schema versions and the timestamp", async () => {
    const now = new Date("2026-08-31T09:30:00.000Z");
    const manifest = await readManifest(await extract(await writeArchive({ now })));
    expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.appVersion).toBe("1.3.0-test");
    // The migration journal position, not a hand-maintained number.
    expect(manifest.schemaVersion).toMatch(/^\d{4}_/);
    expect(manifest.generatedAt).toBe("2026-08-31T09:30:00.000Z");
  });

  itZip("names the archive after the day it was taken", async () => {
    const archive = await buildExport({
      db: handle.db, dataDir, appVersion: "1.3.0-test", now: new Date("2026-08-31T23:59:59.000Z"),
    });
    archive.stream.resume();
    expect(archive.filename).toBe("conduit-export-2026-08-31.zip");
  });

  // The manifest's whole job: a member that does not hash to its recorded
  // digest has been damaged, in transit or in the store.
  itZip("records a sha256 per member that the extracted bytes actually hash to", async () => {
    const company = await createCompany(handle.db, actorId, { name: "M\u00FCller GmbH" });
    await attachBlob(handle.db, company.id, "Angebot-M\u00FCller.pdf", Buffer.from("%PDF-1.7 fake"));

    const root = await extract(await writeArchive());
    const manifest = await readManifest(root);
    expect(manifest.members.length).toBe(10);
    for (const member of manifest.members) {
      const bytes = await readFile(path.join(root, member.path));
      expect(createHash("sha256").update(bytes).digest("hex"), member.path).toBe(member.sha256);
      expect(bytes.byteLength, member.path).toBe(member.bytes);
    }
  });

  itZip("does not list manifest.json among its own members", async () => {
    const manifest = await readManifest(await extract(await writeArchive()));
    expect(manifest.members.map((m) => m.path)).not.toContain("manifest.json");
  });

  itZip("opens as a valid archive by unzip's own integrity check", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await attachBlob(handle.db, company.id, "report.pdf", Buffer.from("a".repeat(5000)));
    const { stdout } = await execFileAsync("unzip", ["-t", await writeArchive()]);
    expect(stdout).toContain("No errors detected");
  });

  it.runIf(Boolean(process.env.CI))("has unzip available here, because CI must prove the archive opens", () => {
    expect(HAVE_UNZIP).toBe(true);
  });
});

describe("export contents", () => {
  itZip("exports a company with its accented name intact through a real extraction", async () => {
    await createCompany(handle.db, actorId, {
      name: "M\u00FCller GmbH", domain: "mueller.example", industry: "Fertigung",
    });
    const sheet = await readSheet(await extract(await writeArchive()), "companies.csv");
    expect(cell(sheet, 0, "name")).toBe("M\u00FCller GmbH");
    expect(cell(sheet, 0, "domain")).toBe("mueller.example");
  });

  itZip("writes money as a decimal string built from the integer cents", async () => {
    const { deal } = await makeDeal(handle.db, "Big one");
    expect(deal.valueCents).toBe(123_456);
    const sheet = await readSheet(await extract(await writeArchive()), "deals.csv");
    expect(cell(sheet, 0, "value")).toBe("1234.56");
    // No grouping separator and no symbol: a spreadsheet parses `1234.56` as a
    // number and `EUR 1,234.56` as text. The currency has its own column.
    expect(cell(sheet, 0, "currency")).toBe("EUR");
    expect(cell(sheet, 0, "value")).not.toContain(",");
  });

  // The reason decimalFromCents is BigInt arithmetic rather than `cents / 100`:
  // at this magnitude the double division loses the last digits.
  itZip("keeps every digit of an amount that double division would round", async () => {
    const huge = 9_007_199_254_740_991;
    const { deal } = await makeDeal(handle.db, "Enormous");
    await handle.db.update(dealsTable).set({ valueCents: huge }).where(eq(dealsTable.id, deal.id));
    const sheet = await readSheet(await extract(await writeArchive()), "deals.csv");
    expect(cell(sheet, 0, "value")).toBe("90071992547409.91");
    expect(cell(sheet, 0, "value")).not.toBe(String(huge / 100));
  });

  itZip("includes archived rows, with archived_at populated", async () => {
    const kept = await createCompany(handle.db, actorId, { name: "Still Trading" });
    const gone = await createCompany(handle.db, actorId, { name: "Wound Up" });
    await archiveCompany(handle.db, actorId, gone.id);

    const sheet = await readSheet(await extract(await writeArchive()), "companies.csv");
    const names = sheet.records.map((r) => r[sheet.header.indexOf("name")]);
    expect(names).toContain("Still Trading");
    expect(names).toContain("Wound Up");

    const archivedIndex = sheet.records.findIndex((r) => r[sheet.header.indexOf("id")] === gone.id);
    expect(cell(sheet, archivedIndex, "archived_at")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const keptIndex = sheet.records.findIndex((r) => r[sheet.header.indexOf("id")] === kept.id);
    expect(cell(sheet, keptIndex, "archived_at")).toBe("");
  });

  // Companies alone would leave five other archivable entities untested, and
  // "an export that silently dropped archived records would misrepresent the
  // data" is a property of all six or of none.
  itZip("includes an archived row of EVERY archivable entity it exports", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Wound Up Ltd" });
    const contact = await createContact(handle.db, actorId, { firstName: "Former", lastName: "Contact" });
    const { deal } = await makeDeal(handle.db, "Abandoned deal", company.id);
    const project = await createProject(handle.db, actorId, { name: "Cancelled rollout" });
    const task = await createTask(handle.db, actorId, { title: "Superseded task" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Cancelled kickoff", occurredAt: new Date("2026-08-01T09:00:00.000Z").toISOString(),
      companyId: company.id,
    });
    await archiveCompany(handle.db, actorId, company.id);
    await archiveContact(handle.db, actorId, contact.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await archiveProject(handle.db, actorId, project.id);
    await archiveTask(handle.db, actorId, task.id);
    await archiveMeeting(handle.db, actorId, meeting.id);

    const root = await extract(await writeArchive());
    const cases: [string, string][] = [
      ["companies.csv", company.id], ["contacts.csv", contact.id], ["deals.csv", deal.id],
      ["projects.csv", project.id], ["tasks.csv", task.id], ["meetings.csv", meeting.id],
    ];
    for (const [sheetName, id] of cases) {
      const sheet = await readSheet(root, sheetName);
      const index = sheet.records.findIndex((r) => r[sheet.header.indexOf("id")] === id);
      expect(index, `${sheetName} dropped its archived row`).toBeGreaterThanOrEqual(0);
      expect(cell(sheet, index, "archived_at"), sheetName).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  itZip("denormalises a readable name beside every id", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const contact = await createContact(handle.db, actorId, {
      firstName: "Jane", lastName: "Smith", companyId: company.id,
    });
    const { deal, pipeline, stage } = await makeDeal(handle.db, "Acme renewal", company.id, contact.id);

    const sheet = await readSheet(await extract(await writeArchive()), "deals.csv");
    expect(cell(sheet, 0, "pipeline_id")).toBe(pipeline.id);
    expect(cell(sheet, 0, "pipeline_name")).toBe("Sales");
    expect(cell(sheet, 0, "stage_id")).toBe(stage.id);
    expect(cell(sheet, 0, "stage_name")).toBe("Negotiation");
    expect(cell(sheet, 0, "company_name")).toBe("Acme Ltd");
    expect(cell(sheet, 0, "contact_name")).toBe("Jane Smith");
    expect(cell(sheet, 0, "owner_username")).toBe("chris");
    expect(cell(sheet, 0, "id")).toBe(deal.id);
  });

  itZip("keeps a comma, a quote and a newline inside one cell", async () => {
    const company = await createCompany(handle.db, actorId, {
      name: 'Smith, Jones & "Co"', address: "4 Long Lane\nLondon\nEC1A 9HA",
    });
    const sheet = await readSheet(await extract(await writeArchive()), "companies.csv");
    expect(cell(sheet, 0, "name")).toBe('Smith, Jones & "Co"');
    expect(cell(sheet, 0, "address")).toBe("4 Long Lane\nLondon\nEC1A 9HA");
    expect(company.name).toBe('Smith, Jones & "Co"');
  });

  itZip("puts a contact's emails and phones on separate lines in one cell", async () => {
    await createContact(handle.db, actorId, {
      firstName: "Jane", lastName: "Smith",
      emails: ["jane@example.com", "j.smith@example.com"], phones: ["+31 6 12345678"],
    });
    const sheet = await readSheet(await extract(await writeArchive()), "contacts.csv");
    expect(cell(sheet, 0, "emails")).toBe("jane@example.com\nj.smith@example.com");
    // Left as typed: the formula guard is deliberately not applied to a leading
    // plus, so a phone number is still a phone number.
    expect(cell(sheet, 0, "phones")).toBe("+31 6 12345678");
  });

  itZip("exports tasks, notes, projects and meetings with their links named", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const project = await createProject(handle.db, actorId, { name: "Rollout", companyId: company.id });
    await createTask(handle.db, actorId, { title: "Draft the plan", projectId: project.id });
    await createNote(handle.db, actorId, { body: "Called them back", companyId: company.id });
    await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: new Date("2026-08-20T10:00:00.000Z").toISOString(),
      companyId: company.id, attendees: [{ guestName: "Their lawyer" }],
    });

    const root = await extract(await writeArchive());
    const projects = await readSheet(root, "projects.csv");
    expect(cell(projects, 0, "name")).toBe("Rollout");
    expect(cell(projects, 0, "company_name")).toBe("Acme Ltd");

    const tasks = await readSheet(root, "tasks.csv");
    expect(cell(tasks, 0, "title")).toBe("Draft the plan");
    expect(cell(tasks, 0, "project_name")).toBe("Rollout");

    const notes = await readSheet(root, "notes.csv");
    expect(cell(notes, 0, "body")).toBe("Called them back");
    expect(cell(notes, 0, "company_name")).toBe("Acme Ltd");
    expect(cell(notes, 0, "author_username")).toBe("chris");

    const meetings = await readSheet(root, "meetings.csv");
    expect(cell(meetings, 0, "title")).toBe("Kickoff");
    expect(cell(meetings, 0, "occurred_at")).toBe("2026-08-20T10:00:00.000Z");
    expect(cell(meetings, 0, "attendees")).toBe("Their lawyer");
    expect(cell(meetings, 0, "company_name")).toBe("Acme Ltd");
  });
});

describe("export files", () => {
  itZip("puts a stored file under files/ with its bytes intact", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const content = Buffer.from("%PDF-1.7\nthe actual bytes\n");
    await attachBlob(handle.db, company.id, "Angebot-M\u00FCller.pdf", content);

    const root = await extract(await writeArchive());
    expect(await memberPaths(root)).toContain("files/Angebot-M\u00FCller.pdf");
    expect(await readFile(path.join(root, "files", "Angebot-M\u00FCller.pdf"))).toEqual(content);
  });

  itZip("indexes every stored file in files.csv, pointing at its member", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const stored = await attachBlob(handle.db, company.id, "contract.pdf", Buffer.from("x"));

    const sheet = await readSheet(await extract(await writeArchive()), "files.csv");
    expect(cell(sheet, 0, "id")).toBe(stored.id);
    expect(cell(sheet, 0, "original_name")).toBe("contract.pdf");
    expect(cell(sheet, 0, "archive_path")).toBe("files/contract.pdf");
    expect(cell(sheet, 0, "sha256")).toBe(stored.sha256);
    expect(cell(sheet, 0, "company_name")).toBe("Acme Ltd");
    expect(cell(sheet, 0, "uploader_username")).toBe("chris");
  });

  // Two rows can legitimately carry the same name, and on the case-insensitive
  // filesystem this archive is most often extracted onto the second would
  // otherwise silently replace the first.
  itZip("disambiguates colliding names, case-insensitively, and says so in files.csv", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await attachBlob(handle.db, company.id, "Report.pdf", Buffer.from("first"));
    await attachBlob(handle.db, company.id, "report.pdf", Buffer.from("second"));
    await attachBlob(handle.db, company.id, "REPORT.pdf", Buffer.from("third"));

    const root = await extract(await writeArchive());
    const members = (await memberPaths(root)).filter((p) => p.startsWith("files/"));
    expect(members).toHaveLength(3);
    expect(new Set(members.map((m) => m.toLowerCase())).size).toBe(3);

    // Asserted as a SET, not a list: files.created_at can tie and the tie-break
    // is a random uuid, so which row takes the bare name is not fixed. What is
    // fixed is that three rows produce three names that differ by more than
    // case, and that each row's own bytes are at its own recorded path.
    expect(members.map((m) => m.toLowerCase()).sort())
      .toEqual(["files/report (2).pdf", "files/report (3).pdf", "files/report.pdf"]);

    const sheet = await readSheet(root, "files.csv");
    const byContent = new Map<string, string>();
    for (const record of sheet.records) {
      const archivePath = record[sheet.header.indexOf("archive_path")] ?? "";
      byContent.set(await readFile(path.join(root, archivePath), "utf8"), archivePath);
    }
    expect([...byContent.keys()].sort()).toEqual(["first", "second", "third"]);
    expect(new Set(byContent.values()).size).toBe(3);
  });

  // A blob missing from the store is a broken install, not a reason to abandon
  // the download -- and the check happens before the response starts, because
  // after that there is no status left to change.
  itZip("exports the row but no member when a blob has vanished from the store", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const present = await attachBlob(handle.db, company.id, "here.pdf", Buffer.from("here"));
    const missing = await attachBlob(handle.db, company.id, "gone.pdf", Buffer.from("gone"));
    await rm(path.join(dataDir, "files", missing.sha256));

    const root = await extract(await writeArchive());
    expect((await memberPaths(root)).filter((p) => p.startsWith("files/"))).toEqual(["files/here.pdf"]);

    const sheet = await readSheet(root, "files.csv");
    const byId = (id: string): number => sheet.records.findIndex((r) => r[sheet.header.indexOf("id")] === id);
    expect(cell(sheet, byId(present.id), "archive_path")).toBe("files/here.pdf");
    expect(cell(sheet, byId(missing.id), "archive_path")).toBe("");
    expect(cell(sheet, byId(missing.id), "original_name")).toBe("gone.pdf");

    const manifest = await readManifest(root);
    expect(manifest.members.map((m) => m.path)).not.toContain("files/gone.pdf");
  });
});

// WHAT collectFiles' PRE-FLIGHT stat CANNOT CATCH, and what happens when the
// archiver hits it. The stat asks whether the blob is THERE; the pump asks
// whether it can be READ, later and separately. A blob that is present and
// unreadable passes the first and fails the second -- and that failure, left
// alone, is not a failed download but a dead server.
//
// UNREADABLE RATHER THAN DELETED, and the difference is that this one is not a
// race. A first version of this test deleted the blob after buildExport
// returned and asserted an ENOENT, and it passed about two runs in three: yazl
// opens a member on its own schedule rather than the consumer's, so whether the
// delete or the open landed first was down to the IO queue. Mode 000 is decided
// before anything opens anything, and stat() does not need read permission.
describe("export stream failure", () => {
  itZip("fails the download rather than the process when a blob cannot be read", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const stored = await attachBlob(handle.db, company.id, "unreadable.pdf", Buffer.from("x".repeat(200_000)));
    const blobPath = path.join(dataDir, "files", stored.sha256);
    await chmod(blobPath, 0o000);

    // Running as root would read it anyway and prove nothing, so the mode is
    // checked rather than assumed.
    const stillReadable = await readFile(blobPath).then(() => true, () => false);
    if (stillReadable) return;

    // The pre-flight stat still passes, so the member is in the manifest and in
    // the archive's plan -- which is the situation under test.
    const archive = await buildExport({ db: handle.db, dataDir, appVersion: "1.3.0-test" });
    expect(archive.manifest.members.map((m) => m.path)).toContain("files/unreadable.pdf");

    // WITHOUT the ZipFile error handler this does not reject: yazl emits on its
    // OWN emitter, nothing is listening, and an unhandled `error` event is an
    // uncaught exception that kills the process -- taking the rest of this suite
    // with it, which is how it announces itself.
    await expect((async () => {
      for await (const chunk of archive.stream) void chunk;
    })()).rejects.toThrow(/EACCES|permission denied/i);
  });
});

// The three absences that make this archive safe to hand to anyone, and the
// reason it needs no passphrase. Each is asserted against an install that HAS
// the thing, so the test would notice if it started coming along.
describe("export safety", () => {
  beforeEach(async () => {
    // A mail account with an encrypted password, a message, and an attachment
    // blob sitting in the same content-addressed store the export reads from.
    await writeFile(path.join(dataDir, "mail.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    await mkdir(path.join(dataDir, "files"), { recursive: true });

    const [account] = await handle.db.insert(mailAccounts).values({
      userId: actorId, label: "Work", email: "chris@listerdale.example",
      imapHost: "imap.example", imapPort: 993, imapSecurity: "tls",
      smtpHost: "smtp.example", smtpPort: 465, smtpSecurity: "tls",
      username: "chris", credentialsCiphertext: "SUPER-SECRET-CIPHERTEXT",
    }).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Re: the quote", lastMessageAt: new Date(),
    }).returning();
    const [message] = await handle.db.insert(mailMessages).values({
      threadId: thread?.id ?? "", accountId: account?.id ?? "", messageId: `<${randomUUID()}@example>`,
      fromAddr: "them@example", toAddrs: [{ address: "chris@listerdale.example" }],
      subject: "Re: the quote", sentAt: new Date(), folder: "INBOX", direction: "inbound",
      bodyText: "THE MAIL BODY THAT MUST NOT TRAVEL", bodyHtml: "<p>THE MAIL BODY THAT MUST NOT TRAVEL</p>",
    }).returning();

    const attachmentBytes = Buffer.from("THE MAIL ATTACHMENT THAT MUST NOT TRAVEL");
    const { sha256 } = await saveBlob(dataDir, Readable.from([attachmentBytes]));
    await handle.db.insert(mailAttachments).values({
      messageId: message?.id ?? "", filename: "their-terms.pdf", mime: "application/pdf",
      sizeBytes: attachmentBytes.byteLength, blobPath: sha256,
    });
  });

  itZip("carries no mail.key, no credentials and no mail body", async () => {
    const zipPath = await writeArchive();
    // The whole archive, as bytes: nothing has to be extracted for this, and a
    // member added by some future change is covered without being named.
    const raw = await readFile(zipPath);
    expect(raw.includes("SUPER-SECRET-CIPHERTEXT")).toBe(false);
    expect(raw.includes("THE MAIL BODY THAT MUST NOT TRAVEL")).toBe(false);
    expect(raw.includes("chris@listerdale.example")).toBe(false);

    const root = await extract(zipPath);
    const members = await memberPaths(root);
    expect(members).not.toContain("mail.key");
    expect(members.some((m) => m.includes("mail"))).toBe(false);
  });

  // The one-character difference between reading the `files` TABLE and reading
  // the $data_dir/files DIRECTORY. The directory holds mail attachments too.
  itZip("carries no mail attachment, though its blob shares the store", async () => {
    const zipPath = await writeArchive();
    expect((await readFile(zipPath)).includes("THE MAIL ATTACHMENT THAT MUST NOT TRAVEL")).toBe(false);

    const root = await extract(zipPath);
    const members = await memberPaths(root);
    expect(members.filter((m) => m.startsWith("files/"))).toEqual([]);
    expect(members).not.toContain("files/their-terms.pdf");
  });

  itZip("still exports an uploaded file from the same store", async () => {
    // The other half of the test above: proving the attachment is absent means
    // nothing if nothing at all is being exported from that directory.
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await attachBlob(handle.db, company.id, "ours.pdf", Buffer.from("OUR OWN UPLOAD"));
    const root = await extract(await writeArchive());
    expect((await memberPaths(root)).filter((m) => m.startsWith("files/"))).toEqual(["files/ours.pdf"]);
  });
});

describe("export documents", () => {
  itZip("exports an issued quote with its money as decimals and its PDF named", async () => {
    const company = await createCompany(handle.db, actorId, { name: "M\u00FCller GmbH" });
    const { deal } = await makeDeal(handle.db, "Fertigungsauftrag", company.id);
    // The quote's rendered PDF is an ORDINARY files row against the same deal
    // -- that is how documents.file_id works -- so the export picks it up
    // through the same query as every other stored file.
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([Buffer.from("%PDF-1.7 quote")]));
    const pdf = await attachFile(handle.db, actorId, {
      originalName: "Angebot QUO-2026-0007.pdf", mime: "application/pdf", sizeBytes, sha256, dealId: deal.id,
    });
    // Inserted directly rather than issued: issueQuote spawns WeasyPrint, and
    // what is under test here is the export's reading of the row, not the
    // renderer that wrote it.
    await handle.db.insert(documentsTable).values({
      number: "QUO-2026-0007", type: "quote", dealId: deal.id, fileId: pdf.id, currency: "EUR",
      issueDate: "2026-08-20", validUntilDate: "2026-09-20",
      recipientName: "M\u00FCller GmbH", recipientContactName: "Jana M\u00FCller",
      recipientSalutation: "Frau", recipientAddress: "Hauptstra\u00DFe 4\n50667 K\u00F6ln",
      subtotalCents: 1_000_000, taxCents: 190_000, totalCents: 1_190_000,
      notes: "", terms: "", issuedByUserId: actorId,
    });

    const root = await extract(await writeArchive());
    const sheet = await readSheet(root, "documents.csv");
    expect(cell(sheet, 0, "number")).toBe("QUO-2026-0007");
    expect(cell(sheet, 0, "deal_title")).toBe("Fertigungsauftrag");
    expect(cell(sheet, 0, "subtotal")).toBe("10000.00");
    expect(cell(sheet, 0, "tax")).toBe("1900.00");
    expect(cell(sheet, 0, "total")).toBe("11900.00");
    expect(cell(sheet, 0, "recipient_contact_name")).toBe("Jana M\u00FCller");
    expect(cell(sheet, 0, "recipient_address")).toBe("Hauptstra\u00DFe 4\n50667 K\u00F6ln");
    expect(cell(sheet, 0, "issued_by_username")).toBe("chris");

    // The link that gets a reader from a quote number to the page that was sent.
    const archivePath = cell(sheet, 0, "file_archive_path");
    expect(archivePath).toBe("files/Angebot QUO-2026-0007.pdf");
    expect(await readFile(path.join(root, archivePath), "utf8")).toBe("%PDF-1.7 quote");
  });
});

// THE MEMORY BOUND, AND THE ONE PROPERTY THE FORMAT DECISION WAS MADE FOR.
//
// The deploy target has 3.8GB and NO SWAP, and this is the codebase that spent
// a release learning that lesson about the PDF renderer. The claim being
// defended is that the archive is never held whole -- so the corpus here is
// deliberately far larger than the bound, and an implementation that collected
// the output, or read a blob with readFile instead of handing yazl its path,
// blows the bound by hundreds of megabytes rather than by a few.
//
// The blob is SPARSE, which is what makes a bound this large affordable in a
// test: ftruncate reserves no blocks, reads return zeros, and yazl streams the
// same bytes it would stream from a real PDF. Stored rather than deflated, like
// every files/ member.
describe("export memory", () => {
  const BLOB_BYTES = 400 * 1024 * 1024;
  // MEASURED ON BOTH SIDES, on the deploy target. Streaming: the resident set
  // grows 9-13MB across three runs. Buffering (addFile swapped for
  // `addBuffer(await readFile(...))`): 338MB. The ceiling sits between them
  // with an order of magnitude of headroom either way, so this fails on a
  // regression rather than on a busy machine.
  const RSS_CEILING_BYTES = 150 * 1024 * 1024;

  /** A sparse blob of `bytes` zeros, stored under its real digest. */
  async function sparseBlob(bytes: number): Promise<{ sha256: string; sizeBytes: number }> {
    const dir = path.join(dataDir, "files");
    await mkdir(dir, { recursive: true });
    const staging = path.join(dir, ".sparse");
    const handleForWrite = await open(staging, "w");
    await handleForWrite.truncate(bytes);
    await handleForWrite.close();
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(staging)) hash.update(chunk as Buffer);
    const sha256 = hash.digest("hex");
    await rename(staging, path.join(dir, sha256));
    return { sha256, sizeBytes: bytes };
  }

  itZip("streams a 400MB archive without the process growing by 400MB", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const { sha256, sizeBytes } = await sparseBlob(BLOB_BYTES);
    await attachFile(handle.db, actorId, {
      originalName: "big.bin", mime: "application/octet-stream", sizeBytes, sha256, companyId: company.id,
    });

    // THE BASELINE IS TAKEN BEFORE buildExport, not after, and that is the whole
    // difference between an instrument and a decoration. An earlier version
    // measured from after the build -- so an implementation that read each blob
    // into a Buffer while ASSEMBLING the archive had already allocated its
    // 400MB by the time `before` was sampled, the delta stayed flat, and the
    // mutation sailed through a green test. Sampling across the build AND the
    // stream is what catches buffering wherever it happens.
    global.gc?.();
    const before = process.memoryUsage.rss();
    let peak = before;
    const sampler = setInterval(() => {
      const rss = process.memoryUsage.rss();
      if (rss > peak) peak = rss;
    }, 10);

    // Counted and discarded. The count is what proves the whole archive really
    // did pass through: a bound met by streaming nothing would be no bound.
    let bytes = 0;
    try {
      const archive = await buildExport({ db: handle.db, dataDir, appVersion: "1.3.0-test" });
      for await (const chunk of archive.stream) bytes += (chunk as Buffer).length;
    } finally {
      clearInterval(sampler);
    }

    expect(bytes).toBeGreaterThan(BLOB_BYTES);
    const grew = peak - before;
    expect(
      grew,
      `resident set grew ${String(Math.round(grew / 1024 / 1024))}MB while streaming ` +
      `${String(Math.round(bytes / 1024 / 1024))}MB; a streaming implementation stays far below the ceiling`,
    ).toBeLessThan(RSS_CEILING_BYTES);
  }, 120_000);
});
