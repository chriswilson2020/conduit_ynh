import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { plannedTotal } from "@conduit/shared";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { companies, contacts, users } from "../db/schema.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { HAVE_7Z, writeZip } from "../test/archives.js";
import { reauthedHeaders, testReauthVerifier } from "../test/reauth.js";
import { resolveUser } from "../users.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { receiveIntake, stageArchive, type IntakeFile, type StagedPayload } from "./intake.js";
import { planView, PlanApplyError, PlanExceededError } from "./intake-plan.js";
import {
  applyImport, inspectImport,
  IMPORT_FINDINGS, IMPORT_REFUSALS, ImportDatabaseChangedError,
  type ImportPlan,
} from "./import-export.js";

// THE EXACT IMPORTER, EXERCISED AGAINST A REAL EXPORT AND NOT AGAINST A FIXTURE
// THAT RESEMBLES ONE.
//
// Every archive below starts life as the bytes GET /api/export actually
// produced -- routed through the real re-authentication gate, built by
// services/export.ts, zipped by yazl -- and is then staged by
// services/intake.ts with the same `7z` an operator has. The refusal cases
// rewrite ONE member of that archive, so what they prove is a refusal of a real
// export with one thing wrong with it rather than of a hand-built approximation
// that could be wrong in ways nobody modelled.
//
// A DEVELOPER WITHOUT 7z SEES A SKIP, on backup.test.ts's precedent. The dev
// server and the CI runner both have it, which is where the archive path has to
// hold; the it.runIf(CI) case at the foot of this file is what makes an
// unexpected absence loud.

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
  ldapUrl: "ldap://127.0.0.1:389",
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
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-import-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-import-out-"));
  staged = [];
});
afterEach(async () => {
  // THE UPLOAD IS A CREDENTIAL STORE EVEN HERE, where the content is a plain
  // export: services/intake.ts's discipline is that nothing survives the run
  // that made it, and a test that leaked one would be a test that stopped
  // proving the discipline holds.
  for (const payload of staged) await payload.dispose();
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

/** The bytes GET /api/export answers with, through the real re-auth gate. */
async function exportArchive(): Promise<Buffer> {
  const app = await buildApp({ config, db, dataDir, reauthVerifier: testReauthVerifier() });
  const headers = await reauthedHeaders(app, authHeaders, "export");
  const response = await app.inject({ method: "GET", url: "/api/export", headers });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}

/** Land a zip through the spine's ingest and stage, exactly as a route would. */
async function stage(zipBytes: Buffer): Promise<{ file: IntakeFile; payload: StagedPayload }> {
  const file = await receiveIntake({
    dataDir, source: Readable.from([zipBytes]), filename: "conduit-export.zip",
  });
  const payload = await stageArchive({ file, passphrase: null });
  staged.push(payload);
  return { file, payload };
}

/** Stage an archive and build its plan. */
async function planFor(zipBytes: Buffer): Promise<{ plan: ImportPlan; payload: StagedPayload }> {
  const { file, payload } = await stage(zipBytes);
  return { plan: await inspectImport({ file, payload, db }), payload };
}

/** Every member of an archive, by name, read back out of a staging. */
async function membersOf(zipBytes: Buffer): Promise<Map<string, Buffer>> {
  const { payload } = await stage(zipBytes);
  const members = new Map<string, Buffer>();
  for (const member of payload.members) {
    members.set(member.name, await payload.readBytes(member.ref));
  }
  return members;
}

/** Re-zip a member map with yazl -- the library services/export.ts itself uses. */
async function zipOf(members: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const zipPath = path.join(scratch, `rebuilt-${randomUUID()}.zip`);
  await writeZip({
    zipPath,
    members: [...members].map(([name, content]) => ({ name, content })),
  });
  return await readFile(zipPath);
}

interface Manifest {
  formatVersion: number;
  cellTransforms: { name: string; version: number; description: string }[];
  members: { path: string; bytes: number; sha256: string }[];
  [key: string]: unknown;
}

function readManifest(members: ReadonlyMap<string, Buffer>): Manifest {
  return JSON.parse((members.get("manifest.json") ?? Buffer.alloc(0)).toString("utf8")) as Manifest;
}

function writeManifest(members: Map<string, Buffer>, manifest: Manifest): void {
  members.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
}

/** Replace one member and keep the manifest's digest for it honest. */
function replaceMember(members: Map<string, Buffer>, name: string, content: Buffer): void {
  members.set(name, content);
  const manifest = readManifest(members);
  for (const member of manifest.members) {
    if (member.path !== name) continue;
    member.bytes = content.byteLength;
    member.sha256 = createHash("sha256").update(content).digest("hex");
  }
  writeManifest(members, manifest);
}

/** The user row the export's owner ids point at, recreated after a truncate. */
async function restoreOperator(): Promise<void> {
  await db.insert(users).values({
    id: actorId, username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  });
}

/** Wipe the install the way an empty one is, keeping the operator's identity. */
async function emptyInstallWithOperator(): Promise<void> {
  await truncateAll(handle);
  await restoreOperator();
}

function findingCodes(plan: ImportPlan): string[] {
  return plan.findings.map((finding) => finding.code);
}

/**
 * Put `value` in one column of one data record of a sheet, keeping the BOM
 * where it belongs.
 *
 * SPLITS ON THE COMMA, WHICH IS ONLY SAFE FOR THE MINIMAL SEEDS BELOW. Every
 * caller of this seeds one company called "Acme" and one contact called "Ada",
 * whose cells contain no comma and no quote -- so the naive split is exact
 * there and nowhere else. Anything richer goes through csvDocument instead.
 */
function editCell(sheet: string, column: string, value: string, record = 1): string {
  const body = sheet.startsWith("\uFEFF") ? sheet.slice(1) : sheet;
  const lines = body.split("\r\n");
  const at = (lines[0] ?? "").split(",").indexOf(column);
  expect(at, `column ${column} is missing from ${lines[0] ?? ""}`).toBeGreaterThanOrEqual(0);
  const cells = (lines[record] ?? "").split(",");
  cells[at] = value;
  lines[record] = cells.join(",");
  return `\uFEFF${lines.join("\r\n")}`;
}

// --- the round trip --------------------------------------------------------

describe("importing a real export", () => {
  /**
   * Seed the shapes that make an export interesting to read back: an accent, a
   * value the formula guard rewrites, an archived row, arrays, and the two
   * capped free-text columns.
   */
  async function seed(): Promise<void> {
    const muller = await createCompany(db, actorId, {
      // Spelled as escapes so this file stays ASCII, as csv.test.ts does. The
      // accents are the point: they are what the export's BOM exists for and
      // what a reader that mishandled UTF-8 would mangle on the way back.
      name: "M\u00FCller GmbH",
      domain: "mueller.example",
      website: "https://mueller.example",
      phone: "+31 6 12345678",
      address: "Hauptstra\u00DFe 1\n12345 K\u00F6ln",
      industry: "Fertigung",
      ownerUserId: actorId,
    });
    // A NAME THAT ALREADY STARTS WITH AN APOSTROPHE. csvCell doubles it, which
    // is the whole reason the transform is invertible -- see csv.ts.
    await createCompany(db, actorId, { name: "'Acme (formerly)", ownerUserId: actorId });
    // A NAME THE FORMULA GUARD REWRITES, so the archive carries a cell that is
    // not the stored value.
    await createCompany(db, actorId, { name: "=SUM(A1:A2) Holdings" });
    const archived = await createCompany(db, actorId, { name: "Gone Ltd" });
    await archiveCompany(db, actorId, archived.id);
    // A jsonb payload, which no create input accepts -- written directly, the
    // way the custom-fields path does.
    await db.update(companies).set({ custom: { segment: "enterprise", seats: 42 } })
      .where(eq(companies.id, muller.id));

    await createContact(db, actorId, {
      firstName: "J\u00FCrgen",
      lastName: "M\u00FCller",
      companyId: muller.id,
      emails: ["jurgen@mueller.example", "j.mueller@example.org"],
      phones: ["+31 6 87654321", "+49 221 1234"],
      jobTitle: "@here reviewer",
      salutation: "Dr",
      pronouns: "he/him",
      ownerUserId: actorId,
    });
    await createContact(db, actorId, { firstName: "Solo" });
  }

  it7z("puts every company and contact back exactly as it was", async () => {
    await seed();
    const before = {
      companies: await db.select().from(companies).orderBy(companies.id),
      contacts: await db.select().from(contacts).orderBy(contacts.id),
    };
    expect(before.companies).toHaveLength(4);
    expect(before.contacts).toHaveLength(2);

    const archive = await exportArchive();
    await emptyInstallWithOperator();

    const { plan, payload } = await planFor(archive);
    expect(plan.refusal).toBeNull();
    const outcome = await applyImport({ plan, payload, db });
    expect(outcome.dispatched).toBe(2);
    expect(outcome.realised).toBe(2);
    expect(outcome.spent).toBe(6);

    const after = {
      companies: await db.select().from(companies).orderBy(companies.id),
      contacts: await db.select().from(contacts).orderBy(contacts.id),
    };
    // FIELD FOR FIELD, ROW FOR ROW, INCLUDING THE IDS AND THE TIMESTAMPS. An
    // assertion on names alone would pass over a lost owner, a lost archived_at
    // and a created_at rewritten to now, which are three of the four things an
    // "exact" importer exists to preserve.
    expect(after).toEqual(before);
  });

  it7z("reverses the declared transform, on a cell that carries a leading apostrophe", async () => {
    await seed();
    const archive = await exportArchive();

    // THE GUARD REALLY FIRED. Without this the round trip could be passing
    // because nothing was ever escaped, which is the vacuous version of this
    // test and the one worth naming.
    const members = await membersOf(archive);
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    expect(sheet).toContain("''Acme (formerly)");
    expect(sheet).toContain("'=SUM(A1:A2) Holdings");
    expect(sheet).not.toContain(",'Acme (formerly)");

    await emptyInstallWithOperator();
    const { plan, payload } = await planFor(archive);
    await applyImport({ plan, payload, db });

    const names = (await db.select({ name: companies.name }).from(companies)).map((r) => r.name);
    expect(names).toContain("'Acme (formerly)");
    expect(names).toContain("=SUM(A1:A2) Holdings");
    expect(names).not.toContain("''Acme (formerly)");

    const [contact] = await db.select().from(contacts).where(eq(contacts.firstName, "J\u00FCrgen"));
    expect(contact?.jobTitle).toBe("@here reviewer");
  });

  it7z("says it will reverse the transform, naming it and its version", async () => {
    await seed();
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan } = await planFor(archive);
    const transform = plan.findings.find((f) => f.code === IMPORT_FINDINGS.cellTransform);
    expect(transform?.message).toContain("leading-apostrophe-escape");
    expect(transform?.message).toContain("version 1");
  });

  it7z("reads cells verbatim when the manifest declares no transform", async () => {
    // THE PROOF THAT THE DECLARATION IS READ RATHER THAN ASSUMED. The same
    // bytes, with the declaration removed, must come back with the apostrophe
    // still on them -- because in that archive the apostrophe is data.
    await createCompany(db, actorId, { name: "'Acme (formerly)" });
    const members = await membersOf(await exportArchive());
    const manifest = readManifest(members);
    manifest.cellTransforms = [];
    writeManifest(members, manifest);

    await emptyInstallWithOperator();
    const { plan, payload } = await planFor(await zipOf(members));
    expect(plan.refusal).toBeNull();
    expect(findingCodes(plan)).not.toContain(IMPORT_FINDINGS.cellTransform);
    await applyImport({ plan, payload, db });

    const [company] = await db.select().from(companies);
    expect(company?.name).toBe("''Acme (formerly)");
  });

  it7z("counts its rows in the unit the shared summary reads", async () => {
    // plannedTotal(plan, "row") answers 0 for every restore plan, because no
    // restore effect uses the row unit -- filed as a v1.4.1 item to check
    // before anything relied on it. This is the first pipeline that does, and
    // this is the check.
    await seed();
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan } = await planFor(archive);
    const view = planView(plan);
    expect(plannedTotal(view, "row")).toBe(6);
    expect(plannedTotal(view, "file")).toBe(0);
    expect(view.effects.map((effect) => effect.op)).toEqual(["insert-companies", "insert-contacts"]);
    expect(view.effects.every((effect) => !effect.destroys)).toBe(true);
  });

  it7z("names one member per effect and nothing else", async () => {
    await seed();
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan, payload } = await planFor(archive);
    expect(plan.effects.map((effect) => effect.sources?.length)).toEqual([1, 1]);
    const outcome = await applyImport({ plan, payload, db });
    expect(outcome.opened).toEqual(["companies.csv", "contacts.csv"]);
  });
});

// --- identity --------------------------------------------------------------

describe("identity", () => {
  it7z("keeps the export's own ids", async () => {
    const company = await createCompany(db, actorId, { name: "Acme" });
    const contact = await createContact(db, actorId, { firstName: "Ada", companyId: company.id });
    const archive = await exportArchive();
    await emptyInstallWithOperator();

    const { plan, payload } = await planFor(archive);
    await applyImport({ plan, payload, db });

    expect((await db.select({ id: companies.id }).from(companies))[0]?.id).toBe(company.id);
    const [imported] = await db.select().from(contacts);
    expect(imported?.id).toBe(contact.id);
    // AND THE LINK SURVIVES BECAUSE THE ID DID. This is the whole argument for
    // preserving ids rather than minting: nothing had to translate anything.
    expect(imported?.companyId).toBe(company.id);
  });

  it7z("leaves a row whose id is already here exactly as it is", async () => {
    const company = await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    // The same id, edited since the export. An import that overwrote would be
    // destroying data on a plan whose every effect says destroys: false.
    await db.insert(companies).values({ id: company.id, name: "Acme, renamed since" });

    const { plan, payload } = await planFor(archive);
    const [effect] = plan.effects;
    expect(effect?.count).toBe(1);
    expect(findingCodes(plan)).toContain(IMPORT_FINDINGS.alreadyPresent);
    await applyImport({ plan, payload, db });

    const rows = await db.select().from(companies).orderBy(companies.name);
    expect(rows.map((row) => row.name)).toEqual(["Acme, renamed since", "Beta"]);
  });

  it7z("leaves a CONTACT that is already here alone too", async () => {
    // THE SECOND SHEET NEEDS ITS OWN CASE. A mutation campaign found that
    // removing the conflict clause from the contacts insert killed no test:
    // the only contact-duplicate case asserted that the import THREW, which a
    // raw 23505 satisfies just as well as the honest count mismatch. This one
    // asserts the skip itself.
    const kept = await createContact(db, actorId, { firstName: "Ada" });
    await createContact(db, actorId, { firstName: "Grace" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    await db.insert(contacts).values({ id: kept.id, firstName: "Ada, renamed since" });

    const { plan, payload } = await planFor(archive);
    expect(plan.effects.map((effect) => effect.op)).toEqual(["insert-contacts"]);
    expect(plan.effects[0]?.count).toBe(1);
    await applyImport({ plan, payload, db });

    const rows = await db.select().from(contacts).orderBy(contacts.firstName);
    expect(rows.map((row) => row.firstName)).toEqual(["Ada, renamed since", "Grace"]);
  });

  it7z("refuses when every row is already here, rather than applying nothing", async () => {
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada" });
    const archive = await exportArchive();
    // Nothing removed: the same install, re-importing its own export.
    const { plan } = await planFor(archive);
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.nothingToImport);
    expect(plan.effects).toHaveLength(0);
  });

  it7z("imports a row whose owner this install has never seen, with no owner", async () => {
    await createCompany(db, actorId, { name: "Acme", ownerUserId: actorId });
    const archive = await exportArchive();
    await truncateAll(handle);
    // A DIFFERENT INSTALL: the operator exists, under a different id. The
    // export names an owner by a uuid in a users table it does not carry.
    const other = await resolveUser(db, { username: "someone-else", email: null, fullName: null });
    expect(other.id).not.toBe(actorId);

    const { plan, payload } = await planFor(archive);
    expect(findingCodes(plan)).toContain(IMPORT_FINDINGS.ownerUnknown);
    await applyImport({ plan, payload, db });

    const [company] = await db.select().from(companies);
    expect(company?.name).toBe("Acme");
    expect(company?.ownerUserId).toBeNull();
  });
});

// --- duplicates between preview and apply ----------------------------------

describe("a plan is a snapshot, not a lease", () => {
  it7z("rolls the whole import back when a row became a duplicate in between", async () => {
    const company = await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    await createContact(db, actorId, { firstName: "Ada" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();

    const { plan, payload } = await planFor(archive);
    expect(plan.effects[0]?.count).toBe(2);
    // Another session inserts one of them while the operator reads the preview.
    await db.insert(companies).values({ id: company.id, name: "Acme, from elsewhere" });

    const error = await applyImport({ plan, payload, db }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportDatabaseChangedError);
    expect((error as PlanApplyError).cause).toMatchObject({ planned: 2, inserted: 1 });

    // NOTHING AT ALL WAS IMPORTED. The one company here is the one the other
    // session inserted, and the contact never arrived even though its own
    // effect had nothing wrong with it.
    const rows = await db.select().from(companies);
    expect(rows.map((row) => row.name)).toEqual(["Acme, from elsewhere"]);
    expect(await db.select().from(contacts)).toHaveLength(0);
  });

  it7z("rolls back just as firmly when a row STOPPED being a duplicate", async () => {
    // The other direction, and it is the one an "insert what still fits"
    // importer would get silently wrong: the preview said one row, and two
    // would land.
    const company = await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    await db.insert(companies).values({ id: company.id, name: "Acme, already here" });

    const { plan, payload } = await planFor(archive);
    expect(plan.effects[0]?.count).toBe(1);
    await db.delete(companies).where(eq(companies.id, company.id));

    const error = await applyImport({ plan, payload, db }).catch((e: unknown) => e);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportDatabaseChangedError);
    expect((error as PlanApplyError).cause).toMatchObject({ planned: 1, inserted: 2 });
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it7z("says which layer refused: the importer's, not the frame's", async () => {
    // TWO LAYERS GUARD THE SAME NUMBER -- this module's comparison and
    // services/intake-plan.ts's accounting -- and a test that only asserted
    // "it threw" would not notice if the outer one stopped working. The frame's
    // error means a step exceeded its plan, which would name the wrong culprit
    // for a database that merely moved.
    const company = await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan, payload } = await planFor(archive);
    await db.insert(companies).values({ id: company.id, name: "Acme, from elsewhere" });

    const error = await applyImport({ plan, payload, db }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PlanExceededError);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportDatabaseChangedError);
    expect((error as Error).message).toMatch(/Upload the export again/);
  });
});

// --- one transaction -------------------------------------------------------

describe("partial failure", () => {
  it7z("commits companies and contacts together or not at all", async () => {
    const company = await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada", companyId: company.id });
    const second = await createContact(db, actorId, { firstName: "Grace" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();

    const { plan, payload } = await planFor(archive);
    expect(plan.effects.map((effect) => effect.count)).toEqual([1, 2]);
    // The contacts step will now come up one short. The companies step has
    // already run and accounted for itself by the time it does.
    await db.insert(contacts).values({ id: second.id, firstName: "Grace, from elsewhere" });

    // THE CAUSE IS ASSERTED, NOT ONLY THE THROW. "It threw" is satisfied by a
    // raw duplicate-key error too, which is what an insert with no conflict
    // clause would raise -- so an assertion that stopped at PlanApplyError
    // would pass over the skip having stopped working.
    const error = await applyImport({ plan, payload, db }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanApplyError);
    expect((error as PlanApplyError).cause).toBeInstanceOf(ImportDatabaseChangedError);

    // THE COMPANIES STEP IS GONE TOO. It succeeded, it accounted, and its
    // effect was dispatched -- and none of that survives a failure in a later
    // effect, because the carrier is one transaction.
    expect(await db.select().from(companies)).toHaveLength(0);
    const remaining = await db.select().from(contacts);
    expect(remaining.map((row) => row.firstName)).toEqual(["Grace, from elsewhere"]);
  });

  it7z("streams a sheet larger than one insert batch, in one transaction", async () => {
    // MORE ROWS THAN INSERT_BATCH_ROWS, so the batching, the accounting and the
    // rollback are all exercised over more than one statement. 1,200 is enough
    // to cross the boundary twice and cheap enough to run every time; the
    // 200,000-row case is measured on the branch rather than committed here.
    const rows = Array.from({ length: 1200 }, (_, n) => ({
      id: randomUUID(), name: `Company ${String(n).padStart(5, "0")}`,
    }));
    await db.insert(companies).values(rows);
    const archive = await exportArchive();
    await emptyInstallWithOperator();

    const { plan, payload } = await planFor(archive);
    expect(plan.effects[0]?.count).toBe(1200);
    const outcome = await applyImport({ plan, payload, db });
    expect(outcome.spent).toBe(1200);
    expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(1200);
  });

  it7z("leaves nothing behind when a batched sheet fails at the end", async () => {
    const rows = Array.from({ length: 1200 }, (_, n) => ({
      id: randomUUID(), name: `Company ${String(n).padStart(5, "0")}`,
    }));
    await db.insert(companies).values(rows);
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan, payload } = await planFor(archive);
    // One of them arrives from elsewhere after the preview: 1,199 land where
    // 1,200 were promised, and all 1,199 go back.
    await db.insert(companies).values({ id: rows[600]?.id ?? "", name: "from elsewhere" });

    await expect(applyImport({ plan, payload, db })).rejects.toThrow(PlanApplyError);
    expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(1);
  });
});

// --- refusals --------------------------------------------------------------

describe("refusals, every one of them with nothing written", () => {
  async function refusalOf(members: Map<string, Buffer>): Promise<ImportPlan> {
    const { plan } = await planFor(await zipOf(members));
    expect(plan.effects).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
    return plan;
  }

  async function realExport(): Promise<Map<string, Buffer>> {
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    return members;
  }

  it7z("refuses an archive with no manifest.json", async () => {
    const members = await realExport();
    members.delete("manifest.json");
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.manifestMissing);
  });

  it7z("refuses a manifest that is not JSON", async () => {
    const members = await realExport();
    members.set("manifest.json", Buffer.from("{ not json", "utf8"));
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.manifestUnreadable);
  });

  it7z("refuses a manifest that is JSON but not an object", async () => {
    const members = await realExport();
    members.set("manifest.json", Buffer.from("[1,2,3]", "utf8"));
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.manifestUnreadable);
  });

  it7z("refuses a BACKUP reaching the importer", async () => {
    // THE ASYMMETRY, FROM THIS SIDE. services/restore.ts refuses anything whose
    // manifest does not say "backup"; this refuses anything that does. An
    // operator who reached for the wrong control at the moment they needed the
    // right one is told which one they wanted.
    const members = await realExport();
    const manifest = readManifest(members);
    manifest.kind = "backup";
    writeManifest(members, manifest);
    const plan = await refusalOf(members);
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.notAnExport);
    expect(plan.refusal?.message).toMatch(/Restore/);
  });

  it7z("refuses an export written by a newer Conduit", async () => {
    const members = await realExport();
    const manifest = readManifest(members);
    manifest.formatVersion = 2;
    writeManifest(members, manifest);
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.formatUnknown);
  });

  it7z("refuses a cell transform it cannot reverse, by version", async () => {
    // THE MOST IMPORTANT REFUSAL IN THE FILE. Version 1's inverse applied to
    // version 2's escaping would corrupt the values quietly, and the damage
    // would be indistinguishable from data afterwards.
    const members = await realExport();
    const manifest = readManifest(members);
    manifest.cellTransforms = [
      { name: "leading-apostrophe-escape", version: 2, description: "something else" },
    ];
    writeManifest(members, manifest);
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.transformUnknown);
  });

  it7z("refuses a cell transform it cannot reverse, by name", async () => {
    const members = await realExport();
    const manifest = readManifest(members);
    manifest.cellTransforms = [{ name: "rot13", version: 1, description: "no" }];
    writeManifest(members, manifest);
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.transformUnknown);
  });

  it7z("refuses an archive missing a member its own manifest lists", async () => {
    const members = await realExport();
    members.delete("deals.csv");
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.memberMissing);
  });

  it7z("refuses a member whose bytes do not match its recorded digest", async () => {
    const members = await realExport();
    // The bytes change and the manifest does not: damage, in transit or in the
    // store, which is the manifest's whole reason for carrying digests.
    members.set("notes.csv", Buffer.from("\uFEFFid\r\ntampered\r\n", "utf8"));
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.memberCorrupt);
  });

  it7z("refuses an archive with no companies.csv", async () => {
    const members = await realExport();
    const manifest = readManifest(members);
    manifest.members = manifest.members.filter((m) => m.path !== "companies.csv");
    writeManifest(members, manifest);
    members.delete("companies.csv");
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.sheetMissing);
  });

  it7z("refuses a sheet missing a column this install reads", async () => {
    const members = await realExport();
    // The format's own rule is that a REMOVED column bumps formatVersion, so a
    // version-1 sheet without one is not the version it claims to be.
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(members, "companies.csv", Buffer.from(sheet.replace("archived_at,", ""), "utf8"));
    const plan = await refusalOf(members);
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.columnMissing);
    expect(plan.refusal?.message).toContain("archived_at");
  });

  it7z("tolerates a column it does not read, which the format promises", async () => {
    // The other side of the same rule: EXPORT_FORMAT_VERSION is not bumped when
    // a column is ADDED, "which every reader tolerates". A reader that indexed
    // by position would break here while the version number said it should not.
    await createCompany(db, actorId, { name: "Acme" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    // PREPENDED, not appended, because a reader that indexed by position would
    // still find every column if the new one went on the end. The byte order
    // mark has to stay the document's first character, or the test would be
    // asserting the wrong refusal.
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    const body = sheet.startsWith("\uFEFF") ? sheet.slice(1) : sheet;
    const widened = "\uFEFF" + body
      .split("\r\n")
      .map((line, at) => (line === "" ? line : at === 0 ? `nickname,${line}` : `whatever,${line}`))
      .join("\r\n");
    replaceMember(members, "companies.csv", Buffer.from(widened, "utf8"));

    const { plan, payload } = await planFor(await zipOf(members));
    expect(plan.refusal).toBeNull();
    await applyImport({ plan, payload, db });
    expect((await db.select({ name: companies.name }).from(companies))[0]?.name).toBe("Acme");
  });

  it7z("refuses a sheet whose records cannot be parsed", async () => {
    // THE REAL HEADER, so this reaches the parser rather than the column check
    // -- the two refusals are different guards and a fixture that tripped the
    // first would say nothing about the second.
    const members = await realExport();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(members, "companies.csv", Buffer.from(`${sheet}"never closed\r\n`, "utf8"));
    const plan = await refusalOf(members);
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.sheetUnreadable);
    expect(plan.refusal?.message).toMatch(/ended inside a quoted field/);
  });

  it7z("refuses a record with a different number of fields from the header", async () => {
    // A parser that guessed here would misassign every column of the record and
    // then carry on, which is the failure the whole reader is strict to avoid.
    const members = await realExport();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(members, "companies.csv", Buffer.from(`${sheet}a,b,c\r\n`, "utf8"));
    const plan = await refusalOf(members);
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.sheetUnreadable);
    expect(plan.refusal?.message).toMatch(/3 fields where the header has 13/);
  });

  it7z("refuses a sheet that names the same id twice", async () => {
    const members = await realExport();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    const lines = sheet.split("\r\n");
    // The one data record, repeated. No export Conduit wrote can do this: the
    // column is a primary key in the database it was taken from.
    replaceMember(
      members, "companies.csv",
      Buffer.from(`${lines[0] ?? ""}\r\n${lines[1] ?? ""}\r\n${lines[1] ?? ""}\r\n`, "utf8"),
    );
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.duplicateId);
  });

  it7z("refuses a contact naming a company that is nowhere", async () => {
    const members = await realExport();
    const sheet = (members.get("contacts.csv") ?? Buffer.alloc(0)).toString("utf8");
    const header = (sheet.split("\r\n")[0] ?? "").split(",");
    const at = header.indexOf("company_id");
    const rewritten = sheet.split("\r\n").map((line, index) => {
      if (index !== 1 || line === "") return line;
      const cells = line.split(",");
      cells[at] = randomUUID();
      return cells.join(",");
    }).join("\r\n");
    replaceMember(members, "contacts.csv", Buffer.from(rewritten, "utf8"));
    expect((await refusalOf(members)).refusal?.code).toBe(IMPORT_REFUSALS.danglingCompany);
  });
});

// --- findings --------------------------------------------------------------

describe("findings", () => {
  it7z("accepts a member the manifest does not list, as EXTRA rather than damage", async () => {
    // The 7.7 spec's rule, from the import side. The manifest deliberately does
    // not list ITSELF either, so a rule that called an unlisted member damage
    // would refuse every export ever written.
    await createCompany(db, actorId, { name: "Acme" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    members.set("files/a-blob-that-arrived-late.pdf", Buffer.from("%PDF-1.7 late", "utf8"));

    const { plan, payload } = await planFor(await zipOf(members));
    expect(plan.refusal).toBeNull();
    const extra = plan.findings.find((f) => f.code === IMPORT_FINDINGS.extraMember);
    expect(extra?.severity).toBe("note");
    expect(extra?.message).toContain("a-blob-that-arrived-late.pdf");
    await applyImport({ plan, payload, db });
    expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(1);
  });

  it7z("skips a record it cannot read, names it, and imports the rest", async () => {
    await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    const lines = sheet.split("\r\n");
    const broken = (lines[1] ?? "").replace(/^[0-9a-f-]{36}/, "not-a-uuid-at-all-------------------");
    replaceMember(
      members, "companies.csv",
      Buffer.from([lines[0], broken, lines[2], ""].join("\r\n"), "utf8"),
    );

    const { plan, payload } = await planFor(await zipOf(members));
    expect(plan.effects[0]?.count).toBe(1);
    const bad = plan.findings.find((f) => f.code === IMPORT_FINDINGS.rowUnreadable);
    expect(bad?.severity).toBe("warning");
    expect(bad?.message).toContain("companies.csv record 2");
    expect(bad?.message).toContain("its id is not a uuid");

    await applyImport({ plan, payload, db });
    expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(1);
  });

  it7z("REFUSES A RECORD CARRYING A CHARACTER POSTGRES WILL NOT STORE", async () => {
    // THE DEFECT THIS CLOSES, said plainly because the shape is the one the
    // whole plan-as-a-value design exists to prevent. buildCompany checked the
    // uuid, the name, the JSON-ness of `custom` and the timestamps -- and not
    // @conduit/shared's unstorableText, which services/import-csv.ts calls
    // mandatory and proves with a control. So a doctored export produced a
    // preview saying "2 companies are created" and an apply that failed with
    // 22021 part way through the transaction. Nothing was half-written, because
    // the whole import rolls back -- but THE PREVIEW LIED, and that is the
    // failure this file exists to make impossible.
    //
    // ANY AUTHENTICATED CALLER CAN BUILD ONE: the manifest lives inside the
    // archive, so replaceMember keeps its digests consistent, exactly as it
    // does for every other doctored-archive case above.
    await createCompany(db, actorId, { name: "Acme" });
    await createCompany(db, actorId, { name: "Beta" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    const lines = sheet.split("\r\n");
    // Into the NAME of the first record, which is a bare cell -- services/csv.ts
    // passes a NUL through in a bare cell and in a quoted one, and
    // unescapeCellValue keeps it.
    const poisoned = (lines[1] ?? "").replace(/,(Acme|Beta),/, ",Ac\u0000me,");
    expect(poisoned).not.toBe(lines[1]);
    replaceMember(
      members, "companies.csv",
      Buffer.from([lines[0], poisoned, lines[2], ""].join("\r\n"), "utf8"),
    );

    const { plan, payload } = await planFor(await zipOf(members));
    // THE PREVIEW COUNTS ONE, NOT TWO. Without the check it counted two and the
    // apply below threw.
    expect(plan.effects[0]?.count).toBe(1);
    const bad = plan.findings.find((f) => f.code === IMPORT_FINDINGS.rowUnreadable);
    expect(bad?.severity).toBe("warning");
    expect(bad?.message).toContain("companies.csv record 2");
    expect(bad?.message).toContain("holds a character the database cannot store");
    // AND IT NAMES THE COLUMN, so an operator can find it in their own file
    // rather than being told a record number and nothing else.
    expect(bad?.message).toContain("name");

    // AND THE APPLY GOES THROUGH. This is the half that matters: the preview's
    // count is what the executor budgets the handler against, so a record the
    // plan counted and the INSERT refused is an accounting failure inside a
    // transaction rather than a finding on a page.
    await applyImport({ plan, payload, db });
    const rows = await db.select({ name: companies.name }).from(companies);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).not.toContain("\u0000");
  });

  it7z("refuses one hiding inside `custom`, which survives JSON.parse", async () => {
    // THE CELL AND NOT THE PARSED VALUE, which is why the sweep runs over the
    // raw columns. A NUL inside a JSON string parses perfectly and only fails
    // at the jsonb cast, with 22P05 rather than 22021 -- a different SQLSTATE
    // from a different layer, and just as unpreviewed. readCustom's own check
    // is about JSON-ness and cannot see it.
    await createCompany(db, actorId, { name: "Acme" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(
      members, "companies.csv",
      Buffer.from(editCell(sheet, "custom", '"{""a"":""x\u0000y""}"'), "utf8"),
    );

    const { plan } = await planFor(await zipOf(members));
    // Every record is refused, so there is nothing to add and the plan says so
    // rather than offering an import that would fail.
    expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.nothingToImport);
    const bad = plan.findings.find((f) => f.code === IMPORT_FINDINGS.rowUnreadable);
    expect(bad?.message).toContain("custom");
    expect(bad?.message).toContain("holds a character the database cannot store");
  });

  it7z("REFUSES ONE IN A CONTACT TOO, which is the half a mutation found untested", async () => {
    // BOTH BUILDERS, BECAUSE THERE ARE TWO OF THEM. The first version of this
    // fix was proved only against companies.csv -- and deleting the sweep from
    // buildContact left the whole suite GREEN, which is the two-layer shape
    // this branch has already paid for six times. One test per builder, and the
    // mutation that removes either is red.
    //
    // A CONTACT ALSO REACHES A COLUMN A COMPANY HAS NOT: `emails` is a text[],
    // and a NUL survives readList's split into an array element, so the failure
    // would arrive from the array cast rather than from a scalar one.
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });
    await createContact(db, actorId, { firstName: "Alan", emails: ["alan@example.com"] });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("contacts.csv") ?? Buffer.alloc(0)).toString("utf8");
    const lines = sheet.split("\r\n");
    const poisoned = (lines[1] ?? "").replace(/,(Ada|Alan),/, ",A\u0000da,");
    expect(poisoned).not.toBe(lines[1]);
    replaceMember(
      members, "contacts.csv",
      Buffer.from([lines[0], poisoned, lines[2], lines[3] ?? ""].join("\r\n"), "utf8"),
    );

    const { plan, payload } = await planFor(await zipOf(members));
    const contactEffect = plan.effects.find((effect) => effect.op === "insert-contacts");
    expect(contactEffect?.count).toBe(1);
    const bad = plan.findings.find(
      (f) => f.code === IMPORT_FINDINGS.rowUnreadable && f.message.includes("contacts.csv"),
    );
    expect(bad?.message).toContain("holds a character the database cannot store");

    await applyImport({ plan, payload, db });
    expect(await db.select({ id: contacts.id }).from(contacts)).toHaveLength(1);
  });

  it("is what Postgres itself refuses, which is the layer underneath", async () => {
    // THE SECOND LAYER, SHOWN FIRING -- the control services/import-csv.test.ts
    // has for the forgiving engine and this file did not have for the exact
    // one. Without the check above, this is what an import meets: in the middle
    // of a transaction that has already written thousands of rows, with a
    // SQLSTATE and no record number.
    const text = await db.insert(companies).values({ name: "Ac\u0000me" })
      .catch((e: unknown) => e);
    expect(text).toBeInstanceOf(Error);
    expect(((text as Error).cause as { code?: string }).code).toBe("22021");

    // AND THE OTHER ONE, which is the reason the sweep covers `custom` too.
    // A different SQLSTATE from a different layer of the same INSERT.
    const json = await db.insert(companies)
      .values({ name: "Fine", custom: { a: "x\u0000y" } })
      .catch((e: unknown) => e);
    expect(json).toBeInstanceOf(Error);
    expect(((json as Error).cause as { code?: string }).code).toBe("22P05");
  });

  it7z("caps the extra-member notes too, and totals them", async () => {
    // The same bound on the other repeating code. Eleven is one past the cap,
    // which is what makes the summary line reachable.
    await createCompany(db, actorId, { name: "Acme" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    for (let n = 0; n < 11; n += 1) {
      members.set(`files/late-${String(n)}.pdf`, Buffer.from(`%PDF-1.7 ${String(n)}`, "utf8"));
    }

    const { plan } = await planFor(await zipOf(members));
    expect(plan.refusal).toBeNull();
    const extras = plan.findings.filter((f) => f.code === IMPORT_FINDINGS.extraMember);
    expect(extras).toHaveLength(11);
    expect(extras.at(-1)?.message).toContain("11 members in all");
  });

  it7z("caps the repeating findings and says how many there were in all", async () => {
    // THE FINDINGS ARRAY IS THE ONE PART OF A PLAN THAT GROWS WITH THE DATA.
    // Thirty broken records must not become thirty entries held for the plan's
    // whole TTL and rendered into a page.
    const rows = Array.from({ length: 30 }, (_, n) => ({ id: randomUUID(), name: `C${String(n)}` }));
    await db.insert(companies).values(rows);
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    const lines = sheet.split("\r\n");
    const broken = lines.map((line, at) => (at === 0 || line === "" ? line : `bad-id,${line.split(",").slice(1).join(",")}`));
    replaceMember(members, "companies.csv", Buffer.from(broken.join("\r\n"), "utf8"));

    const { plan } = await planFor(await zipOf(members));
    const bad = plan.findings.filter((f) => f.code === IMPORT_FINDINGS.rowUnreadable);
    expect(bad).toHaveLength(11);
    expect(bad.at(-1)?.message).toContain("30 records of companies.csv");
  });

  it7z("names every sheet it does not import, and what is missing from each", async () => {
    await createCompany(db, actorId, { name: "Acme" });
    const archive = await exportArchive();
    await emptyInstallWithOperator();
    const { plan } = await planFor(archive);

    const skipped = plan.findings.filter((f) => f.code === IMPORT_FINDINGS.sheetNotImported);
    expect(skipped.map((f) => f.message.split(" ")[0])).toEqual([
      "deals.csv", "projects.csv", "tasks.csv", "notes.csv",
      "meetings.csv", "documents.csv", "files.csv",
    ]);
    // THE REASONS ARE SPECIFIC, because they are the specification for the
    // formatVersion 2 that would close them.
    expect(skipped.find((f) => f.message.startsWith("deals.csv"))?.message)
      .toMatch(/no pipelines or stages/);
    expect(skipped.find((f) => f.message.startsWith("documents.csv"))?.message)
      .toMatch(/no line items/);
    expect(findingCodes(plan)).toContain(IMPORT_FINDINGS.partialImport);
  });
});

// --- every arm of "this record cannot become a row" ------------------------

describe("records this importer declines, one arm at a time", () => {
  /**
   * A minimal real export with ONE cell rewritten.
   *
   * THE CONTACT IS DELIBERATELY UNLINKED. A contact pointing at a company whose
   * record this importer then declines is a DANGLING reference and refuses the
   * whole archive -- a different guard, with its own test -- which would hide
   * every company arm below behind it.
   */
  async function declined(member: string, column: string, value: string): Promise<ImportPlan> {
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get(member) ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(members, member, Buffer.from(editCell(sheet, column, value), "utf8"));
    return (await planFor(await zipOf(members))).plan;
  }

  const arms: readonly { member: string; column: string; value: string; reason: string }[] = [
    { member: "companies.csv", column: "id", value: "not-a-uuid", reason: "its id is not a uuid" },
    { member: "companies.csv", column: "name", value: "", reason: "it has no name" },
    {
      member: "companies.csv", column: "custom", value: "[1]",
      reason: "its custom field is not a JSON object",
    },
    {
      member: "companies.csv", column: "custom", value: "not-json",
      reason: "its custom field is not a JSON object",
    },
    {
      member: "companies.csv", column: "created_at", value: "the day before yesterday",
      reason: "its created_at is not a timestamp",
    },
    {
      member: "companies.csv", column: "updated_at", value: "",
      reason: "its updated_at is not a timestamp",
    },
    {
      member: "companies.csv", column: "archived_at", value: "soon",
      reason: "its archived_at is not a timestamp",
    },
    {
      member: "companies.csv", column: "owner_user_id", value: "chris",
      reason: "its owner_user_id is not a uuid",
    },
    {
      member: "contacts.csv", column: "first_name", value: "",
      reason: "it has no first name",
    },
    {
      member: "contacts.csv", column: "company_id", value: "acme",
      reason: "its company_id is not a uuid",
    },
    {
      member: "contacts.csv", column: "salutation", value: "D".repeat(65),
      reason: "its salutation is longer than 64 characters",
    },
    {
      member: "contacts.csv", column: "pronouns", value: "t".repeat(65),
      reason: "its pronouns are longer than 64 characters",
    },
  ];

  // THE TWO LENGTH ARMS ARE NOT DECORATION. contacts_salutation_length and
  // contacts_pronouns_length are database CHECKs, so a 65-character value
  // reaching the INSERT would be a 23514 in the middle of a transaction that
  // had already written thousands of rows -- a whole import lost to one cell.
  for (const arm of arms) {
    it7z(`declines a record ${arm.member} whose ${arm.column} is ${JSON.stringify(arm.value.slice(0, 20))}`, async () => {
      const plan = await declined(arm.member, arm.column, arm.value);
      expect(plan.refusal).toBeNull();
      const bad = plan.findings.filter((f) => f.code === IMPORT_FINDINGS.rowUnreadable);
      expect(bad).toHaveLength(1);
      expect(bad[0]?.message).toBe(`${arm.member} record 2 is not imported because ${arm.reason}.`);
      // AND THE OTHER SHEET STILL IMPORTS. A declined record is one record, not
      // a refusal of the archive.
      expect(plan.effects).toHaveLength(1);
      expect(plan.effects[0]?.count).toBe(1);
    });
  }
});

// --- descriptors -----------------------------------------------------------

describe("the streams this module opens", () => {
  // /proc is the only way for a process to count its own open descriptors, and
  // it is Linux-only -- the same probe services/export.test.ts uses for the
  // same discipline. The dev server and the CI runner both have it.
  const HAVE_PROC = existsSync("/proc/self/fd");
  const itFd = HAVE_PROC ? it7z : it.skip;

  async function openDescriptors(): Promise<number> {
    return (await readdir("/proc/self/fd")).length;
  }

  itFd("closes every member it reads, on the path that finishes", async () => {
    // THE ONE NEW THING THIS MODULE DOES TO THE FILESYSTEM is open staged
    // members: once per listed member for the digest sweep, once per sheet at
    // inspect, and once per sheet again at apply. Every one of them is a
    // descriptor on a file inside a credential store, and 7.6 measured what
    // happens when a read stream is detached rather than destroyed -- five
    // abandoned downloads, five descriptors held for ever, and every file
    // operation in the app failing once they ran out.
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada" });
    const archive = await exportArchive();

    // One cycle first, so nothing lazily-initialised is counted as a leak.
    await emptyInstallWithOperator();
    const warm = await planFor(archive);
    await applyImport({ plan: warm.plan, payload: warm.payload, db });

    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) {
      await emptyInstallWithOperator();
      const { plan, payload } = await planFor(archive);
      await applyImport({ plan, payload, db });
    }
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  });

  itFd("closes the member it was reading when a parse abandons it", async () => {
    // THE PATH THAT LEAKS IF ANYTHING DOES. Every other read runs to the end of
    // its stream, which closes it; this one throws from inside the generator
    // half way through a member and never asks for another byte.
    await createCompany(db, actorId, { name: "Acme" });
    await createContact(db, actorId, { firstName: "Ada" });
    const members = await membersOf(await exportArchive());
    await emptyInstallWithOperator();
    const sheet = (members.get("companies.csv") ?? Buffer.alloc(0)).toString("utf8");
    replaceMember(members, "companies.csv", Buffer.from(`${sheet}"never closed\r\n`, "utf8"));
    const broken = await zipOf(members);

    const warm = await planFor(broken);
    expect(warm.plan.refusal?.code).toBe(IMPORT_REFUSALS.sheetUnreadable);

    const before = await openDescriptors();
    for (let n = 0; n < 5; n += 1) {
      const { plan } = await planFor(broken);
      expect(plan.refusal?.code).toBe(IMPORT_REFUSALS.sheetUnreadable);
    }
    expect(await openDescriptors()).toBeLessThanOrEqual(before);
  });
});

// --- the environment this suite depends on ---------------------------------

it.runIf(Boolean(process.env.CI))("has 7z available here, because CI must open the archive", () => {
  expect(HAVE_7Z).toBe(true);
});
