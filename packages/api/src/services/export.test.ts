import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod, mkdtemp, mkdir, open, readFile, readdir, readlink, rename, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { promisify } from "node:util";
import type { Database } from "../db/client.js";
import { EXPORT_MEMBER_NAMES, MEMBER_BY_TABLE } from "@conduit/shared";
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
import { createTimeEntry, archiveTimeEntry } from "./time-entries.js";
import {
  companies as companiesTable, deals as dealsTable, documents as documentsTable,
  documentAgreements, documentLetters, documentQuotes as documentQuotesTable,
  mailAccounts, mailAttachments, mailMessages, mailThreads,
} from "../db/schema.js";
import {
  archiveFileName, buildExport, withExportSnapshot,
  EXPORT_CELL_TRANSFORM, EXPORT_FORMAT_VERSION, type ExportManifest,
} from "./export.js";
import { unescapeCellValue } from "./csv.js";

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

// /proc is the only way for a process to count its own open descriptors, and it
// is Linux-only. The dev server and the CI runner both have it, which is where
// the descriptor bound has to hold; a developer on macOS gets a visible skip
// rather than a silent pass.
/**
 * Force a garbage collection, or fail loudly.
 *
 * NOT `global.gc?.()`. The optional call is what let an earlier version of the
 * memory bounds read as though a collection had happened when none could: with
 * no --expose-gc the property is undefined and the `?.` swallows it silently.
 * If the flag ever stops being passed, these tests must say so rather than
 * quietly measure something else.
 */
function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    // `test.execArgv`, not `poolOptions`, which this line named until now and
    // which Vitest 4 removed -- vitest.config.ts says so on the very line that
    // sets the flag. A pointer in an error message is only ever read by someone
    // who has just hit the error, so it is the one place a stale name costs the
    // most.
    throw new Error("these bounds need --expose-gc; see test.execArgv in vitest.config.ts");
  }
  gc();
}

const HAVE_PROC = await readdir("/proc/self/fd").then(() => true, () => false);
const itFd = HAVE_PROC ? it : it.skip;

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

  it("escapes a Windows reserved device name", () => {
    expect(archiveFileName("CON.pdf")).toBe("_CON.pdf");
    expect(archiveFileName("nul")).toBe("_nul");
    expect(archiveFileName("COM4.txt")).toBe("_COM4.txt");
    // Not reserved: only COM1-9 and LPT1-9 are.
    expect(archiveFileName("COM10.txt")).toBe("COM10.txt");
    expect(archiveFileName("CONTRACT.pdf")).toBe("CONTRACT.pdf");
  });

  // WIN32 STOPS AT THE FIRST DOT, and the first version of this rule asked
  // splitExtension -- which correctly splits at the LAST one, because its job is
  // to keep a collision suffix in front of the extension. So it read the stem of
  // `CON.tar.gz` as `CON.tar` and let the device name straight through. The old
  // test was titled "extension and all" and exercised only single extensions.
  it("escapes a reserved name under a COMPOUND extension, which Win32 also resolves", () => {
    expect(archiveFileName("CON.tar.gz")).toBe("_CON.tar.gz");
    expect(archiveFileName("COM1.tar.gz")).toBe("_COM1.tar.gz");
    expect(archiveFileName("nul.a.b")).toBe("_nul.a.b");
    expect(archiveFileName("LPT9.blah.txt")).toBe("_LPT9.blah.txt");
    // Trailing spaces go before Win32 resolves the segment, so this is the
    // device too.
    expect(archiveFileName("CON .pdf")).toBe("_CON .pdf");
    // And the negatives still hold under a compound extension.
    expect(archiveFileName("CONTRACT.tar.gz")).toBe("CONTRACT.tar.gz");
    expect(archiveFileName("COM10.tar.gz")).toBe("COM10.tar.gz");
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

  // THE WIRING, WHICH NOTHING ASSERTED BEFORE. The two tests here prove both
  // properties of the HELPER; neither noticed whether buildExport used it.
  // Replacing `withExportSnapshot(db, read)` with `read(db)` survived the whole
  // suite, and it always would have -- as the comment above this describe says
  // in as many words, a torn export and a consistent one are the same file
  // shape. So the seam is asserted directly.
  it("is what buildExport opens its reads in, with both settings", async () => {
    const calls: unknown[] = [];
    // Object.create rather than a Proxy: drizzle's own internals stay on the
    // prototype and resolve normally, and only `transaction` is observed.
    const observed = Object.create(handle.db) as Database;
    (observed as { transaction: unknown }).transaction = ((
      fn: (tx: Database) => Promise<unknown>, config: unknown,
    ) => {
      calls.push(config);
      return handle.db.transaction(fn, config as Parameters<Database["transaction"]>[1]);
    }) as Database["transaction"];

    const archive = await buildExport({ db: observed, dataDir, appVersion: "1.3.0-test" });
    archive.stream.resume();

    expect(calls, "buildExport must open exactly one transaction").toHaveLength(1);
    expect(calls[0]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
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
    expect(await memberPaths(root))
      .toEqual([...EXPORT_MEMBER_NAMES, "manifest.json"].sort());

    // AND IN THE DECLARED ORDER. memberPaths sorts, so the assertion above is a
    // set: it would be just as green with the sheets written backwards. The
    // manifest records them in the order they were added, and that order is a
    // property of a SHIPPED FORMAT -- @conduit/shared's list is where it is
    // decided, and reordering it reorders the archive.
    const manifest = await readManifest(root);
    expect(manifest.members.map((member) => member.path)).toEqual([...EXPORT_MEMBER_NAMES]);
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
    // Every sheet, plus the one attached blob. manifest.json is not a member of
    // itself -- a digest over a file containing that digest cannot exist.
    expect(manifest.members.length).toBe(EXPORT_MEMBER_NAMES.length + 1);
    for (const member of manifest.members) {
      const bytes = await readFile(path.join(root, member.path));
      expect(createHash("sha256").update(bytes).digest("hex"), member.path).toBe(member.sha256);
      expect(bytes.byteLength, member.path).toBe(member.bytes);
    }
  });

  // THE RULING'S OTHER HALF. Making the escape reversible is worth nothing to
  // 7.7's importer if the archive does not SAY it was applied -- and nothing
  // asserted that it did, so removing the declaration survived the whole suite.
  itZip("declares the cell transform, named and versioned", async () => {
    const manifest = await readManifest(await extract(await writeArchive()));
    expect(manifest.cellTransforms).toHaveLength(1);
    const [transform] = manifest.cellTransforms;
    expect(transform?.name).toBe("leading-apostrophe-escape");
    expect(transform?.version).toBe(1);
    expect(transform?.description).toMatch(/remove exactly one leading apostrophe/i);
    expect(transform).toEqual(EXPORT_CELL_TRANSFORM);
  });

  // THE PROPERTY THE DECLARATION EXISTS FOR, end to end: a note the guard
  // rewrote comes back byte-identical once the declared rule is applied. This
  // is the whole of what 7.7's exact importer will do.
  itZip("round-trips a guarded cell through the archive and the declared inverse", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const bodies = ["== Zusammenfassung ==", "@here please review", "'already quoted", "+31 6 12345678"];
    for (const body of bodies) await createNote(handle.db, actorId, { body, companyId: company.id });

    const root = await extract(await writeArchive());
    const manifest = await readManifest(root);
    expect(manifest.cellTransforms.map((t) => t.name)).toContain("leading-apostrophe-escape");

    const sheet = await readSheet(root, "notes.csv");
    const recovered = sheet.records
      .map((r) => unescapeCellValue(r[sheet.header.indexOf("body")] ?? ""))
      .sort();
    expect(recovered).toEqual([...bodies].sort());

    // And the guard really did fire on the two it should have, so the round
    // trip is not passing because nothing was transformed.
    const written = sheet.records.map((r) => r[sheet.header.indexOf("body")] ?? "");
    expect(written).toContain("'== Zusammenfassung ==");
    expect(written).toContain("'@here please review");
    expect(written).toContain("''already quoted");
    expect(written).toContain("+31 6 12345678");
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

    // v1.9.0's new column, present and EMPTY on an unestimated task -- not "0",
    // which would be an estimate of no work rather than the absence of one.
    expect(cell(tasks, 0, "estimate_minutes")).toBe("");

    const meetings = await readSheet(root, "meetings.csv");
    expect(cell(meetings, 0, "title")).toBe("Kickoff");
    expect(cell(meetings, 0, "occurred_at")).toBe("2026-08-20T10:00:00.000Z");
    expect(cell(meetings, 0, "attendees")).toBe("Their lawyer");
    expect(cell(meetings, 0, "company_name")).toBe("Acme Ltd");
  });

  /**
   * **THE ESTIMATE LEAVES IN THE READABLE HALF TOO (v1.9.0, 0022).** The backup
   * is a `pg_dump` and gets a new column for free; this half gets it never, and
   * "booked versus estimated" is only answerable outside Conduit if BOTH halves
   * of the comparison are in the archive -- `time_entries.csv` carries the booked
   * minutes and this carries the estimate. MINUTES IN BOTH, so a reader with a
   * spreadsheet can subtract one column from a SUM of the other without knowing
   * this product's unit conventions.
   */
  itZip("carries a task's estimate in the same unit time_entries.csv carries its minutes", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    const task = await createTask(handle.db, actorId, {
      title: "Draft the plan", projectId: project.id, estimateMinutes: 240,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 90, billable: true, taskId: task.id,
    });

    const root = await extract(await writeArchive());
    const tasks = await readSheet(root, "tasks.csv");
    expect(cell(tasks, 0, "estimate_minutes")).toBe("240");
    const entries = await readSheet(root, "time_entries.csv");
    expect(cell(entries, 0, "minutes")).toBe("90");
    expect(cell(entries, 0, "task_id")).toBe(task.id);
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

  // THE SAME DESTRUCTIVE COLLISION AS ABOVE, THROUGH THE OTHER DOOR, and the
  // one the first version missed: `toLowerCase()` does not normalise. macOS
  // uploads have historically carried NFD filenames while Windows and Linux
  // carry NFC, so an install with both is ordinary rather than contrived.
  // Measured before the fix, end to end with real unzip: two members, ONE file
  // on disk, the first silently overwritten -- with files.csv still naming both
  // paths and one of them now pointing at the other's bytes. On an archive
  // whose stated purpose is carrying accented filenames.
  itZip("disambiguates NFC and NFD spellings of one name, which lowercasing alone does not", async () => {
    const nfc = "Caf\u00E9.pdf";           // e-acute as one code point
    const nfd = "Cafe\u0301.pdf";          // e + combining acute
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    expect(nfc.toLowerCase()).not.toBe(nfd.toLowerCase());

    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await attachBlob(handle.db, company.id, nfc, Buffer.from("i am the nfc file"));
    await attachBlob(handle.db, company.id, nfd, Buffer.from("i am the nfd file"));

    const root = await extract(await writeArchive());
    const sheet = await readSheet(root, "files.csv");
    const paths = sheet.records.map((r) => r[sheet.header.indexOf("archive_path")] ?? "");
    expect(paths).toHaveLength(2);

    // THE ASSERTION IS ON THE MEMBER NAMES, NOT ON THE EXTRACTED FILES, and the
    // first version of this test got that wrong and could not fail here. ext4
    // stores the two spellings as the different byte sequences they are, so
    // even the buggy archive extracts to two files on the dev server and in CI
    // -- the destruction only happens on the normalising filesystem the
    // operator is likely to be using. What is true on every platform is that
    // two members whose names differ ONLY by normalisation are one name
    // wherever it matters, so that is what is checked.
    const distinctOnANormalisingFilesystem = new Set(paths.map((m) => m.normalize("NFC").toLowerCase()));
    expect(
      distinctOnANormalisingFilesystem.size,
      `two members that collide once normalised: ${paths.join(" and ")}`,
    ).toBe(2);

    // Every row's own bytes are at its own recorded path.
    const contents: string[] = [];
    for (const archivePath of paths) contents.push(await readFile(path.join(root, archivePath), "utf8"));
    expect(contents.sort()).toEqual(["i am the nfc file", "i am the nfd file"]);
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

/** Exactly 32 bytes, like a real AES-256 key, and findable by a byte scan. */
const MAIL_KEY_BYTES = "MAIL-KEY-BYTES-MUST-NEVER-TRAVEL";
const CREDENTIAL_CIPHERTEXT = "SUPER-SECRET-CIPHERTEXT";
const MAIL_BODY = "THE MAIL BODY THAT MUST NOT TRAVEL";
const MAIL_ATTACHMENT = "THE MAIL ATTACHMENT THAT MUST NOT TRAVEL";

/**
 * Search every EXTRACTED member for a string, returning the members that hold
 * it.
 *
 * EXTRACTED, NOT THE RAW ZIP, and that is the whole of this helper's reason to
 * exist. The first version of these tests scanned the archive's own bytes --
 * which is a live check for a STORED member and a dead one for a DEFLATED
 * member, and every CSV is deflated. Proved by building an archive whose
 * mail_accounts.csv literally contained the ciphertext: the raw scan returned
 * false while the CSV plainly held it. Two of the three assertions this suite
 * leads with were passing for that reason and could not have failed.
 *
 * Scanning the extracted members catches what the name check cannot: a
 * `credentials_ciphertext` column appearing on users.csv, or a mail body
 * reaching notes.csv, neither of which introduces a member called `mail`.
 */
async function membersContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const member of await memberPaths(root)) {
    const bytes = await readFile(path.join(root, member));
    if (bytes.includes(needle)) hits.push(member);
  }
  return hits;
}

// The three absences that make this archive safe to hand to anyone, and the
// reason it needs no passphrase. Each is asserted against an install that HAS
// the thing, so the test would notice if it started coming along.
describe("export safety", () => {
  beforeEach(async () => {
    // A mail account with an encrypted password, a message, and an attachment
    // blob sitting in the same content-addressed store the export reads from.
    // 32 bytes, as a real key is, but RECOGNISABLE -- the first version wrote
    // 32 copies of 0x07, which no scan could look for, so mail.key was only
    // ever checked by NAME.
    await writeFile(path.join(dataDir, "mail.key"), Buffer.from(MAIL_KEY_BYTES), { mode: 0o600 });
    await mkdir(path.join(dataDir, "files"), { recursive: true });

    const [account] = await handle.db.insert(mailAccounts).values({
      userId: actorId, label: "Work", email: "chris@listerdale.example",
      imapHost: "imap.example", imapPort: 993, imapSecurity: "tls",
      smtpHost: "smtp.example", smtpPort: 465, smtpSecurity: "tls",
      username: "chris", credentialsCiphertext: CREDENTIAL_CIPHERTEXT,
    }).returning();
    const [thread] = await handle.db.insert(mailThreads).values({
      subject: "Re: the quote", lastMessageAt: new Date(),
    }).returning();
    const [message] = await handle.db.insert(mailMessages).values({
      threadId: thread?.id ?? "", accountId: account?.id ?? "", messageId: `<${randomUUID()}@example>`,
      fromAddr: "them@example", toAddrs: [{ address: "chris@listerdale.example" }],
      subject: "Re: the quote", sentAt: new Date(), folder: "INBOX", direction: "inbound",
      bodyText: MAIL_BODY, bodyHtml: `<p>${MAIL_BODY}</p>`,
    }).returning();

    const attachmentBytes = Buffer.from(MAIL_ATTACHMENT);
    const { sha256 } = await saveBlob(dataDir, Readable.from([attachmentBytes]));
    await handle.db.insert(mailAttachments).values({
      messageId: message?.id ?? "", filename: "their-terms.pdf", mime: "application/pdf",
      sizeBytes: attachmentBytes.byteLength, blobPath: sha256,
    });
  });

  // THE INSTRUMENT, SHOWN WORKING, before anything is asserted absent. A scan
  // that cannot find a string that IS there proves nothing about the strings
  // that are not, and the raw-bytes version of this suite failed exactly that
  // way against every deflated member.
  itZip("finds a string that really is in a deflated CSV member", async () => {
    await createCompany(handle.db, actorId, { name: "A Findable Company Name" });
    const root = await extract(await writeArchive());
    expect(await membersContaining(root, "A Findable Company Name")).toEqual(["companies.csv"]);
  });

  itZip("carries no credential, no mail body and no mail.key CONTENTS", async () => {
    // A company too, so the archive is not trivially empty of everything.
    await createCompany(handle.db, actorId, { name: "Acme" });
    const root = await extract(await writeArchive());

    expect(await membersContaining(root, CREDENTIAL_CIPHERTEXT)).toEqual([]);
    expect(await membersContaining(root, MAIL_BODY)).toEqual([]);
    expect(await membersContaining(root, "chris@listerdale.example")).toEqual([]);
    // THE BYTES, not only the name. mail.key's contents were never scanned
    // before, so a copy of it under any other member name would have passed.
    expect(await membersContaining(root, MAIL_KEY_BYTES)).toEqual([]);

    const members = await memberPaths(root);
    expect(members).not.toContain("mail.key");
    expect(members.some((m) => m.includes("mail"))).toBe(false);
  });

  // The one-character difference between reading the `files` TABLE and reading
  // the $data_dir/files DIRECTORY. The directory holds mail attachments too.
  itZip("carries no mail attachment, though its blob shares the store", async () => {
    const root = await extract(await writeArchive());
    expect(await membersContaining(root, MAIL_ATTACHMENT)).toEqual([]);
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
    expect(await membersContaining(root, "OUR OWN UPLOAD")).toEqual(["files/ours.pdf"]);
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
    const [document] = await handle.db.insert(documentsTable).values({
      number: "QUO-2026-0007", type: "quote", dealId: deal.id, fileId: pdf.id,
      issueDate: "2026-08-20", frozen: true, issuedByUserId: actorId,
    }).returning();
    await handle.db.insert(documentQuotesTable).values({
      documentId: document!.id, currency: "EUR", validUntilDate: "2026-09-20",
      recipientName: "M\u00FCller GmbH", recipientContactName: "Jana M\u00FCller",
      recipientSalutation: "Frau", recipientAddress: "Hauptstra\u00DFe 4\n50667 K\u00F6ln",
      subtotalCents: 1_000_000, taxCents: 190_000, totalCents: 1_190_000,
      notes: "", terms: "",
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
    // The two columns Phase 9 added, on a row that has neither. `frozen` stopped
    // being derivable from `type` by a reader of the archive when freezing became
    // per type, so it is a column rather than an inference.
    expect(cell(sheet, 0, "meeting_id")).toBe("");
    expect(cell(sheet, 0, "meeting_title")).toBe("");
    expect(cell(sheet, 0, "frozen")).toBe("true");
  });

  /**
   * **THE SHEET USED TO DROP THIS ROW ENTIRELY, SILENTLY.** documentsSheet joined
   * `document_quotes` with an INNER JOIN, which was right while every document was
   * a quote and became data loss the moment one was not: a meeting summary has no
   * detail row, so it matched nothing and vanished from the one artefact whose
   * justification is that an operator can read all of their data out of it. The
   * join is a LEFT JOIN now and this is the test that says so.
   */
  itZip("exports a meeting summary, with its meeting named and its money columns blank", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff with Acme", occurredAt: "2026-09-01T13:30:00.000Z",
      companyId: company.id, attendees: [],
    });
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([Buffer.from("%PDF-1.7 summary")]));
    const pdf = await attachFile(handle.db, actorId, {
      originalName: "Meeting summary.pdf", mime: "application/pdf", sizeBytes, sha256,
      meetingId: meeting.id,
    });
    await handle.db.insert(documentsTable).values({
      number: null, type: "meeting_summary", meetingId: meeting.id, fileId: pdf.id,
      issueDate: "2026-09-06", frozen: false, issuedByUserId: actorId,
    });

    const root = await extract(await writeArchive());
    const sheet = await readSheet(root, "documents.csv");
    expect(sheet.records).toHaveLength(1);
    expect(cell(sheet, 0, "type")).toBe("meeting_summary");
    expect(cell(sheet, 0, "meeting_id")).toBe(meeting.id);
    expect(cell(sheet, 0, "meeting_title")).toBe("Kickoff with Acme");
    expect(cell(sheet, 0, "frozen")).toBe("false");
    // BLANK, NOT "0.00". A spreadsheet parses `0.00` as a number and would sum it
    // into a column total -- a figure about documents that have no figures.
    for (const column of ["number", "deal_id", "currency", "subtotal", "tax", "total"]) {
      expect(cell(sheet, 0, column), column).toBe("");
    }
    // ...and its page is still reachable from the row, which is the whole point of
    // the sheet carrying a file_archive_path at all.
    const archivePath = cell(sheet, 0, "file_archive_path");
    expect(await readFile(path.join(root, archivePath), "utf8")).toBe("%PDF-1.7 summary");

    // files.csv names the meeting too, or a meeting summary's PDF would be the one
    // member of files/ whose every record column is blank.
    const filesSheet = await readSheet(root, "files.csv");
    expect(cell(filesSheet, 0, "meeting_id")).toBe(meeting.id);
    expect(cell(filesSheet, 0, "meeting_title")).toBe("Kickoff with Acme");
    expect(cell(filesSheet, 0, "company_id")).toBe("");
  });

  /**
   * **THE SAME LESSON ONE TASK ON, AND IT WOULD HAVE BEEN A QUIETER FAILURE.**
   * The summary above was DROPPED by an INNER JOIN. A letter would not have been
   * dropped -- its `documents` row would have come out perfectly -- it would have
   * come out with its subject, its addressee and its BODY absent, which is the one
   * thing about a letter that exists nowhere else in the archive. The row would
   * have looked fine.
   *
   * AND `company_id` IS NEW TO THIS SHEET. Until Task 3 every document was of a
   * deal or of a meeting, so `deal_id` and `meeting_id` covered the file; a letter
   * is of a company or a contact, so without those columns a letter's row named no
   * record at all.
   */
  itZip("exports a letter with its body, and an agreement with its terms", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const blob = async (bytes: string) =>
      await saveBlob(dataDir, Readable.from([Buffer.from(bytes)]));

    const letterBlob = await blob("%PDF-1.7 letter");
    const letterPdf = await attachFile(handle.db, actorId, {
      originalName: "Letter - Renewal - 2026-09-06.pdf", mime: "application/pdf",
      sizeBytes: letterBlob.sizeBytes, sha256: letterBlob.sha256, companyId: company.id,
    });
    const [letter] = await handle.db.insert(documentsTable).values({
      number: null, type: "letter", companyId: company.id, fileId: letterPdf.id,
      issueDate: "2026-09-06", frozen: false, issuedByUserId: actorId,
    }).returning();
    await handle.db.insert(documentLetters).values({
      documentId: letter!.id, subject: "Renewal", recipientName: "Acme Ltd",
      recipientContactName: "Jana Müller", recipientSalutation: "Frau Müller",
      recipientAddress: "Hauptstraße 4\n50667 Köln",
      bodyHtml: "<p>Thank you.</p>",
    });

    const ndaBlob = await blob("%PDF-1.7 nda");
    const ndaPdf = await attachFile(handle.db, actorId, {
      originalName: "NDA-2026-0001.pdf", mime: "application/pdf",
      sizeBytes: ndaBlob.sizeBytes, sha256: ndaBlob.sha256, companyId: company.id,
    });
    const [nda] = await handle.db.insert(documentsTable).values({
      number: "NDA-2026-0001", type: "nda", companyId: company.id, fileId: ndaPdf.id,
      issueDate: "2026-09-06", frozen: true, issuedByUserId: actorId,
    }).returning();
    await handle.db.insert(documentAgreements).values({
      documentId: nda!.id, type: "nda", effectiveDate: "2026-09-01", termMonths: 36,
      jurisdiction: "the Netherlands", partyName: "Acme Ltd", partyContactName: "Jana Müller",
      partyAddress: "Hauptstraße 4",
    });

    const root = await extract(await writeArchive());
    const sheet = await readSheet(root, "documents.csv");
    expect(sheet.records).toHaveLength(2);
    // `number` leads the ORDER BY and PostgreSQL sorts NULLs last, so the NDA is
    // row 0 and the letter is row 1.
    expect(cell(sheet, 0, "type")).toBe("nda");
    expect(cell(sheet, 1, "type")).toBe("letter");

    expect(cell(sheet, 1, "company_id")).toBe(company.id);
    expect(cell(sheet, 1, "company_name")).toBe("Acme Ltd");
    expect(cell(sheet, 1, "letter_subject")).toBe("Renewal");
    expect(cell(sheet, 1, "letter_recipient_contact_name")).toBe("Jana Müller");
    expect(cell(sheet, 1, "letter_recipient_salutation")).toBe("Frau Müller");
    expect(cell(sheet, 1, "letter_recipient_address")).toBe("Hauptstraße 4\n50667 Köln");
    // THE BODY, VERBATIM. Named `_html` for meetings.csv's `notes_html` reason:
    // flattening it to plain text would make it the one lossy column in the file.
    expect(cell(sheet, 1, "letter_body_html")).toBe("<p>Thank you.</p>");
    expect(cell(sheet, 1, "frozen")).toBe("false");

    expect(cell(sheet, 0, "number")).toBe("NDA-2026-0001");
    expect(cell(sheet, 0, "agreement_effective_date")).toBe("2026-09-01");
    expect(cell(sheet, 0, "agreement_term_months")).toBe("36");
    expect(cell(sheet, 0, "agreement_jurisdiction")).toBe("the Netherlands");
    expect(cell(sheet, 0, "agreement_party_name")).toBe("Acme Ltd");
    expect(cell(sheet, 0, "frozen")).toBe("true");

    // THE COLUMNS THAT BELONG TO THE OTHER TYPES ARE BLANK RATHER THAN 0 OR "0.00",
    // and `agreement_term_months` is in the list for the money columns' reason: a
    // spreadsheet parses 0 as a number and would average it into a column about
    // documents that have no term.
    for (const column of [
      "currency", "subtotal", "tax", "total", "recipient_name",
      "agreement_term_months", "agreement_jurisdiction",
    ]) {
      expect(cell(sheet, 1, column), column).toBe("");
    }
    for (const column of ["letter_subject", "letter_body_html", "subtotal"]) {
      expect(cell(sheet, 0, column), column).toBe("");
    }

    // Both pages are still reachable from their rows.
    expect(await readFile(path.join(root, cell(sheet, 1, "file_archive_path")), "utf8"))
      .toBe("%PDF-1.7 letter");
    expect(await readFile(path.join(root, cell(sheet, 0, "file_archive_path")), "utf8"))
      .toBe("%PDF-1.7 nda");
  });

  /**
   * **THE THIRD TASK RUNNING TO FIND THIS SHEET A TYPE BEHIND, AND THE FAILURE
   * WOULD HAVE BEEN THE QUIETEST YET.** Task 2 found an INNER JOIN dropping every
   * meeting summary. Task 3 found no `company_id`/`contact_id`, so a letter named
   * no record. A status report would have come out looking perfect and named no
   * record either -- `project_id` was not a column of this sheet, so the ONE fact
   * that says which project a report is about would have been absent from the
   * archive entirely. Neither the spec nor the plan mentions the export, for the
   * third task running.
   *
   * **AND ITS CONTENT COLUMNS ARE ALL BLANK, WHICH IS COMPLETE RATHER THAN
   * LOSSY.** This type has no detail table because it holds nothing that was
   * typed into the document: the project is in projects.csv, the tasks are in
   * tasks.csv, and what the page SAID on the day it was made is the PDF at
   * `file_archive_path`. That is the difference from the letter, whose body
   * exists nowhere else and therefore had to become six columns.
   */
  itZip("exports a status report, with its project named and every content column blank", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const project = await createProject(handle.db, actorId, {
      name: "Rye Lane rollout", companyId: company.id,
    });
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([Buffer.from("%PDF-1.7 report")]));
    const pdf = await attachFile(handle.db, actorId, {
      originalName: "Status report - Rye Lane rollout - 2026-09-06.pdf",
      mime: "application/pdf", sizeBytes, sha256, projectId: project.id,
    });
    await handle.db.insert(documentsTable).values({
      number: null, type: "project_status_report", projectId: project.id, fileId: pdf.id,
      issueDate: "2026-09-06", frozen: false, issuedByUserId: actorId,
    });

    const root = await extract(await writeArchive());
    const sheet = await readSheet(root, "documents.csv");
    expect(sheet.records).toHaveLength(1);
    expect(cell(sheet, 0, "type")).toBe("project_status_report");
    // THE TWO COLUMNS THIS TASK ADDED. Without them the row names no record.
    expect(cell(sheet, 0, "project_id")).toBe(project.id);
    expect(cell(sheet, 0, "project_name")).toBe("Rye Lane rollout");
    expect(cell(sheet, 0, "frozen")).toBe("false");
    for (const column of [
      "number", "company_id", "contact_id", "deal_id", "meeting_id",
      "currency", "subtotal", "tax", "total", "letter_subject", "letter_body_html",
      "agreement_term_months",
    ]) {
      expect(cell(sheet, 0, column), column).toBe("");
    }
    // ...and its page is reachable from the row, which is where the content that
    // is NOT derivable from projects.csv and tasks.csv actually lives.
    expect(await readFile(path.join(root, cell(sheet, 0, "file_archive_path")), "utf8"))
      .toBe("%PDF-1.7 report");

    // files.csv names the project too, which it has done since Phase 3 -- unlike
    // the meeting, which 0017 had to add.
    const filesSheet = await readSheet(root, "files.csv");
    expect(cell(filesSheet, 0, "project_id")).toBe(project.id);
    expect(cell(filesSheet, 0, "project_name")).toBe("Rye Lane rollout");
  });

  /**
   * The order the sheet is written in, now that some rows have no number to order
   * by. PostgreSQL sorts NULLs last in ASC, so the numbered documents keep the
   * order a reader expects and created_at/id make the unnumbered tail
   * deterministic rather than whatever the plan produced.
   */
  itZip("orders numbered documents first and the rest deterministically", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme Ltd" });
    const { deal } = await makeDeal(handle.db, "Big Deal", company.id);
    const meeting = await createMeeting(handle.db, actorId, {
      title: "Kickoff", occurredAt: "2026-09-01T13:30:00.000Z",
      companyId: company.id, attendees: [],
    });
    async function pdfFor(name: string, target: { dealId?: string; meetingId?: string }) {
      const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([Buffer.from(name)]));
      return await attachFile(handle.db, actorId, {
        originalName: name, mime: "application/pdf", sizeBytes, sha256, ...target,
      });
    }
    const summaryPdf = await pdfFor("s1.pdf", { meetingId: meeting.id });
    const quotePdf = await pdfFor("q1.pdf", { dealId: deal.id });
    // The summary is written FIRST, so an ordering that fell back to insertion
    // order would put it before the quote.
    await handle.db.insert(documentsTable).values({
      number: null, type: "meeting_summary", meetingId: meeting.id, fileId: summaryPdf.id,
      issueDate: "2026-09-06", frozen: false, issuedByUserId: actorId,
    });
    const [quote] = await handle.db.insert(documentsTable).values({
      number: "QUO-2026-0001", type: "quote", dealId: deal.id, fileId: quotePdf.id,
      issueDate: "2026-09-05", frozen: true, issuedByUserId: actorId,
    }).returning();
    await handle.db.insert(documentQuotesTable).values({
      documentId: quote!.id, currency: "EUR", recipientName: "Acme Ltd",
      subtotalCents: 100, taxCents: 21, totalCents: 121,
    });

    const sheet = await readSheet(await extract(await writeArchive()), "documents.csv");
    expect(sheet.records.map((_r, i) => cell(sheet, i, "type")))
      .toEqual(["quote", "meeting_summary"]);
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
describe("export time entries", () => {
  /** A company, contact, deal, project and task, so an entry can name all five. */
  async function everyRecord() {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Jane", lastName: "Smith" });
    const { deal } = await makeDeal(handle.db, "Big one", company.id, contact.id);
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    const task = await createTask(handle.db, actorId, { title: "Migrate the data", projectId: project.id });
    return { company, contact, deal, project, task };
  }

  // THE SHEET'S WHOLE JOB, AND PHASE 9'S THIRD MISS IN ADVANCE. A status report
  // exported with `project_id` in a column that did not exist named no project
  // anywhere in the archive; an hour whose task title is missing is the same
  // failure on the one table whose entire content is what the time went on.
  itZip("names all five records an entry can belong to, id and readable name for each", async () => {
    const { company, contact, deal, project, task } = await everyRecord();
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 90, billable: true,
      description: "Data migration dry run",
      companyId: company.id, contactId: contact.id, dealId: deal.id,
      projectId: project.id, taskId: task.id,
    });

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    expect(cell(sheet, 0, "company_id")).toBe(company.id);
    expect(cell(sheet, 0, "company_name")).toBe("Acme");
    expect(cell(sheet, 0, "contact_id")).toBe(contact.id);
    expect(cell(sheet, 0, "contact_name")).toBe("Jane Smith");
    expect(cell(sheet, 0, "deal_id")).toBe(deal.id);
    expect(cell(sheet, 0, "deal_title")).toBe("Big one");
    expect(cell(sheet, 0, "project_id")).toBe(project.id);
    expect(cell(sheet, 0, "project_name")).toBe("Rollout");
    expect(cell(sheet, 0, "task_id")).toBe(task.id);
    expect(cell(sheet, 0, "task_title")).toBe("Migrate the data");
    expect(cell(sheet, 0, "owner_user_id")).toBe(actorId);
    expect(cell(sheet, 0, "owner_username")).toBe("chris");
    expect(cell(sheet, 0, "description")).toBe("Data migration dry run");
  });

  // THE OTHER HALF OF THAT, AND PHASE 9'S FIRST MISS IN ADVANCE: an INNER JOIN
  // anywhere among those five would drop this row entirely, because
  // at-least-one means the ordinary entry has four NULL links.
  itZip("exports an entry that names ONE record, with the other four blank", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-02", minutes: 30, billable: false, projectId: project.id,
    });

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    expect(sheet.records).toHaveLength(1);
    expect(cell(sheet, 0, "project_id")).toBe(project.id);
    for (const blank of ["company_id", "company_name", "contact_id", "contact_name",
      "deal_id", "deal_title", "task_id", "task_title", "description"]) {
      expect(cell(sheet, 0, blank), blank).toBe("");
    }
  });

  itZip("writes minutes as a plain integer and billable the way documents.csv writes frozen", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 90, billable: true, projectId: project.id,
    });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 15, billable: false, projectId: project.id,
    });

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    const minutes = sheet.records.map((r) => r[sheet.header.indexOf("minutes")]).sort();
    expect(minutes).toEqual(["15", "90"]);
    // Both spellings present, so a mutation that hardcodes either one is caught.
    // "true"/"false" is documents.csv's `frozen`, so the archive has one boolean
    // dialect rather than a second one in its tenth file.
    expect(sheet.records.map((r) => r[sheet.header.indexOf("billable")]).sort())
      .toEqual(["false", "true"]);
    // No hours column: minutes are readable, and a second representation of one
    // number is how a CSV starts disagreeing with itself.
    expect(sheet.header).not.toContain("hours");
  });

  // A BARE DATE STAYS A BARE DATE, which is the whole reason the column is one.
  // Turning it into an instant here would put the day an hour belongs to at the
  // mercy of whoever opens the file, in exactly the direction (a day earlier)
  // that moves an hour into the previous week.
  itZip("keeps work_date the day it was, with no time and no offset", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-01-01", minutes: 60, billable: true, projectId: project.id,
    });

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    expect(cell(sheet, 0, "work_date")).toBe("2026-01-01");
    // created_at, on the same row, IS an instant -- so the two kinds of column
    // stay visibly different in the file, which is what services/export.ts's
    // `timestamp` comment claims and nothing asserted for this sheet.
    expect(cell(sheet, 0, "created_at")).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  // Conduit never expunges, and archiving is the ONLY way an hour leaves a
  // total -- so an export that dropped archived entries would disagree with the
  // database about how much time exists. Same rule, and same test, as every
  // other sheet with an archived_at.
  itZip("includes an archived entry, with archived_at populated", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-03", minutes: 45, billable: false, projectId: project.id,
    });
    await archiveTimeEntry(handle.db, actorId, entry.id);

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    expect(sheet.records).toHaveLength(1);
    expect(cell(sheet, 0, "archived_at")).not.toBe("");
  });

  itZip("orders by the day the work was done, not by the order the rows were typed", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    // Typed newest-first, deliberately: with created_at ordering these come out
    // backwards, so this fails against the wrong ORDER BY rather than passing by
    // coincidence of insertion order.
    for (const workDate of ["2026-09-05", "2026-09-03", "2026-09-04"]) {
      await createTimeEntry(handle.db, actorId, {
        workDate, minutes: 60, billable: true, projectId: project.id,
      });
    }

    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");
    expect(sheet.records.map((r) => r[sheet.header.indexOf("work_date")]))
      .toEqual(["2026-09-03", "2026-09-04", "2026-09-05"]);
  });

  /**
   * **THE GUARD THE PLAN'S OPENING OBLIGATION ASKS FOR, ONE LEVEL DOWN.**
   *
   * The sheet exists; this is what stops it going stale. Phase 9 lost a letter's
   * body and a report's project because a table gained columns and a
   * hand-written `*Sheet` did not -- silently, with the row still coming out
   * looking perfect. Task 5 adds timer columns to this very table, so the next
   * chance to repeat that failure is one task away.
   *
   * READ OUT OF `information_schema`, NEVER OUT OF A LIST WRITTEN HERE. A list
   * would have to be updated by the same person who forgot the sheet.
   */
  itZip("names every time_entries column, so a column added later cannot ship unexported", async () => {
    const project = await createProject(handle.db, actorId, { name: "Rollout" });
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 90, billable: true, projectId: project.id,
    });
    const sheet = await readSheet(await extract(await writeArchive()), "time_entries.csv");

    const rows = await handle.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'time_entries'
      ORDER BY column_name
    `);
    const catalogue = rows.map((row) => row.column_name);
    // The premise: the catalogue was really read. A typo in the table name
    // returns nothing and every assertion below would pass over an empty set.
    expect(catalogue).toContain("work_date");
    expect(catalogue.length).toBeGreaterThanOrEqual(14);

    expect(catalogue.filter((name) => !sheet.header.includes(name))).toEqual([]);

    // THE INSTRUMENT, WATCHED FAILING RATHER THAN TRUSTED. The identical
    // comparison against a header with one column taken out of it names exactly
    // that column -- so the empty result above is a comparison that ran, not one
    // that could not fail.
    const mutilated = sheet.header.filter((name) => name !== "billable");
    expect(catalogue.filter((name) => !mutilated.includes(name))).toEqual(["billable"]);
  });
});

/**
 * **EVERY TABLE IS EITHER EXPORTED OR DECLARED UNEXPORTED, WITH A REASON.**
 *
 * This is the guard for the failure the Phase 10 plan opens with: "one
 * hand-written `*Sheet` per entity, and it does not walk the schema", so a table
 * added later appears only if somebody writes the function. The backup gets a
 * new table for free because it is a `pg_dump`; this half gets it never.
 *
 * WHAT IT COSTS THE NEXT AUTHOR is one line saying which it is -- which is
 * exactly the decision that was skipped three times running in Phase 9, and
 * making it explicit is the whole point. A table in NEITHER map fails this test
 * by name.
 *
 * IT IS NOT A CLAIM THAT THE UNEXPORTED ONES ARE RIGHT to be unexported. Several
 * are known gaps in formatVersion 1 (there is no pipelines.csv, and
 * services/import-export.ts's header is a list of what that costs). It is a
 * claim that each absence was decided rather than forgotten.
 */
describe("export coverage", () => {
  /**
   * Which member carries each table -- @conduit/shared's declaration, read here
   * rather than restated. Several tables share documents.csv, which is one row
   * per document with its detail tables joined on (see documentsSheet for why
   * that is one sheet and not four).
   *
   * **THIS IS THE OTHER END OF THE DERIVATION, AND IT IS WHY DERIVING EVERYTHING
   * FROM ONE LIST IS NOT A WAY OF LOSING A SHEET QUIETLY.** Every other reader
   * of that list would be perfectly green if a member were DELETED from it: the
   * export would stop writing the sheet, and every expectation would stop
   * expecting it. This test is the one that would not, because what it compares
   * the list against is the database's own catalogue -- the deleted member's
   * table would then be carried by nothing and declared unexported by nobody,
   * and it fails below by name.
   */
  const EXPORTED = Object.fromEntries(MEMBER_BY_TABLE);

  /** Why each remaining table is absent. One sentence each, and each one is a
   * decision somebody made rather than a table nobody thought about. */
  const NOT_EXPORTED: Record<string, string> = {
    users: "the export names people by id and username inline; a users sheet would be a "
      + "directory of accounts in an archive whose whole selling point is that it is safe to "
      + "hand to anyone",
    pipelines: "a known gap in formatVersion 1 -- deals.csv carries pipeline_name, but the "
      + "pipeline rows themselves are absent, which is why the importer cannot create a deal",
    stages: "the same gap as pipelines, and the same consequence",
    task_dependencies: "join rows with no identity of their own; a file of (predecessor, "
      + "successor) uuid pairs is the one shape a person with a spreadsheet cannot read",
    meeting_attendees: "folded into meetings.csv's `attendees` cell as display names -- see "
      + "meetingsSheet, which explains why this is a fold rather than a tenth sheet",
    events: "the timeline is derived history over rows that are all exported already, and it "
      + "is by far the largest table on a live install",
    org_profile: "the issuer's own letterhead and logo, which is configuration rather than "
      + "data -- and its logo column is a base64 image that would be one enormous cell",
    document_line_items: "a known gap in formatVersion 1, named in "
      + "services/import-export.ts: an imported quote would print an empty table under a "
      + "frozen total",
    document_number_sequences: "the per-year allocator's counters; they describe numbers "
      + "already printed on the documents that were exported",
    document_templates: "editable HTML templates, which are configuration and are restored "
      + "from a backup, not read out of a spreadsheet",
    mail_accounts: "NO CREDENTIALS LEAVE IN THE EXPORT -- see services/export.ts's header. "
      + "This absence is a security property, not a gap",
    mail_account_folders: "mailbox structure belongs to the mail server and is rediscovered",
    mail_folder_state: "sync cursors; they describe a connection, not the operator's data",
    mail_threads: "mail bodies are enormous, already exist on the mail server, and nobody "
      + "wants them in a spreadsheet; they are in the backup instead",
    mail_thread_hides: "per-user visibility state over threads that are not exported",
    mail_messages: "the same as mail_threads, and the bulk of it",
    mail_attachments: "deliberately absent, and the export reads the `files` TABLE rather "
      + "than the blob DIRECTORY precisely so these are never swept up",
  };

  itZip("gives every table in the schema either a sheet or a declared reason it has none", async () => {
    const rows = await handle.db.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    const tables = rows.map((row) => row.tablename);
    // The premise: this really read the catalogue of a migrated database.
    expect(tables.length).toBeGreaterThan(20);
    expect(tables).toContain("time_entries");

    const undeclared = tables.filter((t) => !(t in EXPORTED) && !(t in NOT_EXPORTED));
    expect(
      undeclared,
      "these tables are neither exported nor declared unexported. Add the table to a "
      + "member of EXPORT_MEMBERS in @conduit/shared (and a builder for it in "
      + "services/export.ts, which will not compile until you do), or a one-line reason to "
      + "NOT_EXPORTED above -- but decide, because the readable export is the half that never "
      + "picks a new table up for free.",
    ).toEqual([]);

    // Neither map may name a table that is not there: a stale entry would let a
    // DROPPED table go on standing in for a NEW one of a similar name.
    const phantom = [...Object.keys(EXPORTED), ...Object.keys(NOT_EXPORTED)]
      .filter((t) => !tables.includes(t));
    expect(phantom).toEqual([]);
    // And no table is in both, which would make the whole check vacuous for it.
    expect(Object.keys(EXPORTED).filter((t) => t in NOT_EXPORTED)).toEqual([]);
  });

  /**
   * **AND EVERY COLUMN OF EVERY EXPORTED TABLE IS EITHER IN ITS SHEET OR
   * DECLARED ABSENT WITH A REASON.** One level below the test above, which asks
   * only whether a TABLE has a sheet.
   *
   * **THIS GENERALISES A GUARD THAT COVERED EXACTLY ONE TABLE.** Task 1 wrote
   * the `information_schema` column check for `time_entries` and wrote down why:
   * "Phase 9 lost a letter's body and a report's project because a table gained
   * columns and a hand-written `*Sheet` did not -- silently, with the row still
   * coming out looking perfect." That reasoning was never specific to
   * `time_entries`, and the very next task to add a column added it to `tasks`,
   * where NOTHING WOULD HAVE NOTICED: `tasks.csv` has no such check, and the
   * Phase 10 plan's own convention note claims it has. It has one now, and so
   * does every other exported table.
   *
   * READ OUT OF `information_schema`, NEVER OUT OF A LIST WRITTEN HERE -- a list
   * would have to be updated by the same person who forgot the sheet. And the
   * headers are read out of a REAL ARCHIVE rather than out of `export.ts`, so a
   * column named in a header but never written into a row would still be caught
   * downstream by that sheet's own tests.
   *
   * **IT MATCHES ON NAMES, WHICH IS WHY A RENAME NEEDS A LINE TOO.** Seventeen
   * columns are carried under a different header -- `deals.value_cents` as
   * `value` in major units, the letter's and the agreement's fields under their
   * own prefixes, and so on -- and every one of them is a decision somebody made
   * for a stated reason. A guard that guessed at the mapping (strip `_cents`,
   * allow a prefix) would excuse a genuine miss the day a new column happened to
   * look like one of those shapes, so it does not guess: it asks for a sentence.
   */
  const COLUMNS_NOT_NAMED_IN_A_HEADER: Record<string, Record<string, string>> = {
    tasks: {
      position: "GENUINELY ABSENT: the fractional index that orders a board column, an "
        + "opaque collation-sensitive string with no meaning outside this database. "
        + "services/import-export.ts already names its absence as the first reason "
        + "tasks.csv cannot be imported back",
    },
    deals: {
      position: "GENUINELY ABSENT, for tasks.position' reason exactly",
      value_cents: "carried as `value`, in major units -- see money(), which is how every "
        + "amount in this archive is written, so a reader is never asked which unit a "
        + "column is in",
    },
    meetings: {
      notes: "carried as `notes_html`, named for what it holds: sanitised rich text, "
        + "exported verbatim rather than flattened, which would make it the one lossy "
        + "column in the file",
    },
    document_quotes: {
      document_id: "the join key -- it IS documents.csv's `id`, and a second column "
        + "holding the same uuid would invite a reader to check they matched",
      subtotal_cents: "carried as `subtotal`, in major units (see deals.value_cents)",
      tax_cents: "carried as `tax`, in major units",
      total_cents: "carried as `total`, in major units",
    },
    document_letters: {
      document_id: "the join key, as document_quotes.document_id",
      subject: "carried as `letter_subject`. The prefix is deliberate and documentsSheet "
        + "argues it: the letter's fields are NOT folded into the quote's, because two "
        + "tables mean two things and a coalesce would stop being true the day they diverge",
      body_html: "carried as `letter_body_html` -- the column Phase 9 shipped EMPTY, which "
        + "is the miss this whole guard exists for",
    },
    document_agreements: {
      document_id: "the join key, as document_quotes.document_id",
      effective_date: "carried as `agreement_effective_date` (the prefix, for "
        + "document_letters.subject' reason)",
      term_months: "carried as `agreement_term_months`",
      jurisdiction: "carried as `agreement_jurisdiction`",
      party_name: "carried as `agreement_party_name`",
      party_contact_name: "carried as `agreement_party_contact_name`",
      party_address: "carried as `agreement_party_address`",
    },
  };

  itZip("names every column of every exported table, or declares why it does not", async () => {
    const root = await extract(await writeArchive());
    const headerOf = new Map<string, string[]>();
    for (const member of new Set(MEMBER_BY_TABLE.values())) {
      headerOf.set(member, (await readSheet(root, member)).header);
    }

    const rows = await handle.db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `);
    // The premise: the catalogue was really read. A typo in the filter returns
    // nothing, and every assertion below would then pass over an empty set.
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.some((r) => r.table_name === "tasks" && r.column_name === "estimate_minutes")).toBe(true);

    const missing: string[] = [];
    for (const [table, member] of MEMBER_BY_TABLE) {
      const header = headerOf.get(member) ?? [];
      const declared = COLUMNS_NOT_NAMED_IN_A_HEADER[table] ?? {};
      for (const { column_name: column } of rows.filter((r) => r.table_name === table)) {
        if (!header.includes(column) && !(column in declared)) missing.push(`${table}.${column}`);
      }
    }
    expect(
      missing,
      "these columns exist in the database and no sheet names them. Add the column to "
      + "its *Sheet in services/export.ts, or -- if it is carried under a different header "
      + "-- a one-line reason to COLUMNS_NOT_NAMED_IN_A_HEADER above saying where it went. "
      + "But decide, because a hand-written sheet is the half of this product that never "
      + "picks up a new column for free, and a row missing one still looks perfect.",
    ).toEqual([]);

    // A STALE EXCEPTION IS AS BAD AS A MISSING COLUMN, because it stands ready
    // to excuse a NEW column that happens to reuse the name.
    const phantom: string[] = [];
    for (const [table, columns] of Object.entries(COLUMNS_NOT_NAMED_IN_A_HEADER)) {
      for (const column of Object.keys(columns)) {
        const exists = rows.some((r) => r.table_name === table && r.column_name === column);
        const exported = headerOf.get(MEMBER_BY_TABLE.get(table) ?? "")?.includes(column) === true;
        if (!exists || exported) phantom.push(`${table}.${column}`);
      }
    }
    expect(phantom, "declared absent, but the column is gone or is in the sheet after all")
      .toEqual([]);

    // THE INSTRUMENT, WATCHED FAILING RATHER THAN TRUSTED. The identical
    // comparison against a tasks header with one column taken out of it names
    // exactly that column -- so the empty result above is a comparison that ran,
    // not one that could not fail.
    const mutilated = (headerOf.get("tasks.csv") ?? []).filter((n) => n !== "estimate_minutes");
    expect(rows.filter((r) => r.table_name === "tasks" && !mutilated.includes(r.column_name)
      && !(r.column_name in (COLUMNS_NOT_NAMED_IN_A_HEADER.tasks ?? {}))).map((r) => r.column_name))
      .toEqual(["estimate_minutes"]);
  });

  itZip("actually writes every member the EXPORTED map claims", async () => {
    const members = await memberPaths(await extract(await writeArchive()));
    for (const [table, member] of Object.entries(EXPORTED)) {
      expect(members, `${table} claims ${member}`).toContain(member);
    }
  });
});

// EVERY ABORTED DOWNLOAD USED TO COST A FILE DESCRIPTOR, PERMANENTLY.
//
// Measured before the fix: five aborted downloads left five open descriptors on
// the blob, and neither a forced GC nor closing the app reclaimed them.
// Descriptor exhaustion fails every file operation in the process, not only
// exports -- and cancelling a large download is a far more ordinary act than
// any of the failures the error forwarding was built for.
describe("export descriptors", () => {
  /**
   * How many descriptors this process holds on `target`.
   *
   * /proc is the only way to see this from inside the process. It exists on the
   * dev server and on the CI runner, which is where this has to hold; a
   * developer on macOS gets a skip rather than a false pass.
   */
  async function openDescriptorsFor(target: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir("/proc/self/fd");
    } catch {
      return -1;
    }
    let count = 0;
    for (const entry of entries) {
      try {
        if (await readlink(path.join("/proc/self/fd", entry)) === target) count += 1;
      } catch { /* the descriptor closed while we were looking */ }
    }
    return count;
  }

  itFd("closes the blob's descriptor when the download is abandoned", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    // Big enough that the read is still in flight when the client goes away.
    const stored = await attachBlob(handle.db, company.id, "big.pdf", Buffer.alloc(4 * 1024 * 1024, 3));
    const blobPath = path.join(dataDir, "files", stored.sha256);
    expect(await openDescriptorsFor(blobPath)).toBe(0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const archive = await buildExport({ db: handle.db, dataDir, appVersion: "1.3.0-test" });
      const stream = archive.stream as Readable;
      // Read one chunk so the pump is genuinely under way, then walk off --
      // which is what fastify does to the stream when a client disconnects.
      await new Promise<void>((resolve) => stream.once("data", () => { resolve(); }));
      stream.destroy();
      await new Promise<void>((resolve) => stream.once("close", () => { resolve(); }));
    }

    // Give the destroy a turn to propagate through yazl's pipe.
    await new Promise<void>((resolve) => { setImmediate(() => { resolve(); }); });
    expect(
      await openDescriptorsFor(blobPath),
      "an abandoned download must not leave the blob open",
    ).toBe(0);
  }, 60_000);

  itFd("leaves nothing open after a download that completes", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const stored = await attachBlob(handle.db, company.id, "big.pdf", Buffer.alloc(2 * 1024 * 1024, 4));
    const blobPath = path.join(dataDir, "files", stored.sha256);

    const archive = await buildExport({ db: handle.db, dataDir, appVersion: "1.3.0-test" });
    for await (const chunk of archive.stream) void chunk;
    await new Promise<void>((resolve) => { setImmediate(() => { resolve(); }); });
    expect(await openDescriptorsFor(blobPath)).toBe(0);
  }, 60_000);
});

// THE OTHER HALF OF THE MEMORY STORY, and the half the blob bound never
// touched. An export cannot stream its CSVs -- manifest.json records a SHA-256
// per member, and a digest needs the whole member -- so the question is not
// whether a sheet is materialised but how many are materialised AT ONCE. The
// first implementation held all nine: the mapped rows, the finished buffers,
// and yazl's deflated copies, simultaneously.
describe("export row memory", () => {
  const ROWS_PER_SHEET = 40_000;
  const BODY_CHARS = 400;
  // MEASURED ON BOTH SHAPES, on the deploy target, against 61MB of CSV spread
  // over three large sheets. One sheet at a time: 53, 59, 60MB of live heap
  // across three runs. Every sheet held at once, which is the shape this
  // replaced: 93MB. The ceiling sits between them.
  //
  // The gap is 1.6x rather than 3x because the mutation measured holds only the
  // ROWS; the implementation it replaced also held every finished buffer and
  // yazl'''s deflated copies on top. So this bound is conservative: it fires
  // on the mildest version of the regression.
  const ROW_HEAP_CEILING_BYTES = 75 * 1024 * 1024;

  /** Fill three of the sheets with enough text to be measurable. */
  async function seedWideCorpus(): Promise<void> {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    // Raw SQL rather than the services: 120,000 rows through createNote would
    // dominate the runtime of the thing being measured.
    await handle.db.execute(sql`
      INSERT INTO notes (body, author_user_id, company_id)
      SELECT repeat('n', ${BODY_CHARS}), ${actorId}::uuid, ${company.id}::uuid
      FROM generate_series(1, ${ROWS_PER_SHEET})
    `);
    await handle.db.execute(sql`
      INSERT INTO companies (name, address)
      SELECT 'Company ' || g, repeat('a', ${BODY_CHARS})
      FROM generate_series(1, ${ROWS_PER_SHEET}) g
    `);
    await handle.db.execute(sql`
      INSERT INTO contacts (first_name, last_name, job_title)
      SELECT 'First' || g, 'Last' || g, repeat('t', ${BODY_CHARS})
      FROM generate_series(1, ${ROWS_PER_SHEET}) g
    `);
  }

  it("holds one sheet at a time, not all of them at once", async () => {
    await seedWideCorpus();

    // FORCED COLLECTION AT EVERY SAMPLE, which is the only way this reading
    // means anything. Both shapes allocate the same rows; the difference is
    // whether they are still REFERENCED when the next sheet is built, and
    // resident set on its own cannot tell "dropped" from "held" because V8 does
    // not return dropped pages promptly. Measured without it, the two shapes
    // read 298MB and 328MB -- a 30MB gap for a difference of the whole corpus.
    // vitest.config.ts enables --expose-gc for exactly this.
    // HEAP USED, NOT RESIDENT SET, and that is what makes the two shapes
    // separable. The mapped rows are JavaScript strings and arrays, so they live
    // on the V8 heap; the finished CSVs are Buffers, which do not. Resident set
    // sums both plus V8'''s slack and reads 211MB against 250MB for shapes whose
    // real difference is the whole corpus. heapUsed after a forced collection is
    // the live row data and almost nothing else.
    forceGc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      forceGc();
      const heap = process.memoryUsage().heapUsed;
      if (heap > peak) peak = heap;
    }, 100);

    let bytes = 0;
    let csvBytes = 0;
    try {
      const archive = await buildExport({ db: handle.db, dataDir, appVersion: "1.3.0-test" });
      for (const member of archive.manifest.members) {
        if (member.path.endsWith(".csv")) csvBytes += member.bytes;
      }
      for await (const chunk of archive.stream) bytes += (chunk as Buffer).length;
    } finally {
      clearInterval(sampler);
    }

    // The corpus really is large enough for the question to mean something.
    expect(csvBytes).toBeGreaterThan(40 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(0);

    const grew = peak - before;
    expect(
      grew,
      `live heap grew ${String(Math.round(grew / 1024 / 1024))}MB while building `
      + `${String(Math.round(csvBytes / 1024 / 1024))}MB of CSV across three large sheets; `
      + "holding every sheet at once costs roughly three times this",
    ).toBeLessThan(ROW_HEAP_CEILING_BYTES);
  }, 300_000);
});

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
    // A REAL collection before the baseline. An earlier version wrote
    // `global.gc?.()` with nothing enabling it, so the call was always
    // undefined and the line implied a guarantee it never gave;
    // vitest.config.ts now passes --expose-gc and forceGc throws if it is
    // missing rather than silently doing nothing.
    forceGc();
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
