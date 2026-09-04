import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, migrationsFolder, runMigrations, type DatabaseHandle } from "../db/client.js";
import { openTestDatabase } from "../test/db.js";
import {
  SCRATCH_DATABASE_PREFIXES, TEST_DATABASE_URL, withDatabaseName,
} from "../test/databases.js";
import { digestOf, HAVE_7Z } from "../test/archives.js";
import { resolveUser } from "../users.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { createCompany } from "./companies.js";
import {
  buildBackup, libpqEnvironment, measureInventory, pgDumpVersion, type BackupManifest,
} from "./backup.js";
import {
  decryptCredentials, encryptCredentials, forgetMailKey, loadMailKey,
} from "./mail-crypto.js";
import { readMigrationJournal } from "./migration-journal.js";
import {
  receiveIntake, stageArchive, INTAKE_WORK_PREFIX, type StagedPayload,
} from "./intake.js";
import { newPlan, PlanApplyError, PlanExceededError, PlanRefusedError } from "./intake-plan.js";
import {
  applyRestore, compareAppVersions, compareInventory, describeDatabaseShape, inspectRestore,
  readDumpLine, readInventory,
  proveArchiveOpens, psqlLoadArgs, psqlVersion, recoveryCommands, sameShape,
  RESTORE_FINDINGS, RESTORE_REFUSALS,
  RestoreDatabaseChangedError, RestoreHalfAppliedError, RestoreInventoryMismatchError,
  RestoreLoadFailedError,
  RestoreMigrationError, RestoreSafetyBackupError, RestoreUnexpectedMigrationsError,
  RestoreUnexpectedResultError,
  type DatabaseShape, type RestoreEffect, type RestorePlan, type SafetyBackupEffect,
} from "./restore.js";

// RESTORE: THE ONLY SUITE IN THIS REPOSITORY THAT DESTROYS A DATABASE ON
// PURPOSE, AND IT NEVER DESTROYS conduit_test.
//
// Every case that loads a dump does it into a scratch database created and
// dropped for that case, on db/schema.test.ts's precedent. That is not only
// hygiene: the spec requires a backup taken on one install and restored onto a
// DIFFERENT one, because a round trip on the same box can pass while a real
// restore fails -- identical paths, identical mail.key, identical schema. So
// `sourceInstall` and `targetInstall` below are two databases and two data
// directories, and nothing is shared between them but the archive.
//
// THE DATA IS VERIFIED BY EXACT ROW COUNTS, table by table, read back over a
// FRESH connection. Never an exit code, and never pg_stat_user_tables, whose
// estimates read identically before and after a full replacement.

const HAVE_PSQL = (await psqlVersion()) !== null;
const HAVE_PG_DUMP = (await pgDumpVersion()) !== null;
/** Everything a real restore needs. A developer on macOS gets a visible skip. */
const itRestore = HAVE_7Z && HAVE_PSQL && HAVE_PG_DUMP ? it : it.skip;
const it7z = HAVE_7Z ? it : it.skip;

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "1.4.0";

/** The error a promise rejected with, or a loud failure if it did not reject. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected this to be refused, and it was not");
}

// --- installs --------------------------------------------------------------

/** One Conduit install: its own database, its own $data_dir, its own mail.key. */
interface Install {
  name: string;
  url: string;
  handle: DatabaseHandle;
  dataDir: string;
  mailKeyPath: string;
}

/** The control connection. Used ONLY to create and drop scratch databases. */
const control = openTestDatabase();
/**
 * Every scratch database this file makes. Also what the boot sweep matches.
 *
 * NAMED IN test/databases.ts RATHER THAN HERE, because the sweep below is a
 * `DROP DATABASE` over everything that starts with it and this file is no longer
 * the only one running when it fires. The comment that used to sit on that sweep
 * -- "Nothing else in this repository creates this prefix" -- was already untrue
 * when it was written: the old value was `conduit_restore_`, and both
 * routes/restore.test.ts (`conduit_restore_routes_`) and backup.test.ts
 * (`conduit_restore_<hex>`) sat underneath it. Serially that never showed,
 * because a sweep only ever met databases from a finished run.
 */
const SCRATCH_PREFIX = SCRATCH_DATABASE_PREFIXES.restoreService;
let installs: Install[] = [];
let scratchDirs: string[] = [];

/**
 * Drop a scratch database, and do NOT use `WITH (FORCE)`.
 *
 * MEASURED ON THE DEPLOY TARGET, AFTER IT FAILED A RUN. `DROP DATABASE ... WITH
 * (FORCE)` terminates every other backend attached to the database, and an
 * AUTOVACUUM WORKER is one of them -- owned by the bootstrap superuser, so a
 * non-superuser's DROP fails with 42501, "permission denied to terminate
 * process". This suite writes and rewrites whole databases, so it attracts
 * autovacuum in a way db/schema.test.ts's two upgrade drills never did, and the
 * failure lands in teardown where it reads as an unrelated test failing.
 *
 * A PLAIN DROP IS THE ONE THAT HANDLES IT: PostgreSQL signals autovacuum
 * workers in the target database and waits for them, and only genuine client
 * connections make it fail. Every handle this file opens is closed before this
 * runs, so the retry is for the moment between a `close()` and the server
 * noticing it.
 */
async function dropScratchDatabase(name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await control.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      // Only our own client backends, and never the autovacuum worker, whose
      // exit PostgreSQL is already arranging.
      await control.db.execute(sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// A RUN THAT DIED LEAVES DATABASES BEHIND, and the next run should not inherit
// them: they cost disk on a shared dev server and they make a real leak
// impossible to see.
//
// `starts_with`, NOT `LIKE 'prefix%'`. In LIKE, `_` is a single-character
// wildcard, and every prefix in this repository is full of them -- so
// `LIKE 'conduit_scratch_restore_svc_%'` matches names that merely resemble it.
// That was harmless while the prefixes overlapped anyway and nothing else ran at
// the same time; with files running concurrently, a sweep is a DROP DATABASE
// aimed at another worker's live database, so it has to mean exactly what it says.
beforeAll(async () => {
  const stale = await control.db.execute<{ datname: string }>(sql`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${SCRATCH_PREFIX})
  `);
  for (const row of stale) await dropScratchDatabase(row.datname);
});

beforeEach(() => {
  installs = [];
  scratchDirs = [];
});

afterEach(async () => {
  for (const install of installs) {
    forgetMailKey(install.mailKeyPath);
    await install.handle.close();
    await dropScratchDatabase(install.name);
    await rm(install.dataDir, { recursive: true, force: true });
  }
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});
afterAll(async () => { await control.close(); });

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `conduit-restore-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A migrations folder holding only the first `count` journal entries.
 *
 * Derived from the REAL journal rather than hardcoded, on schema.test.ts's
 * precedent, so it keeps working when a later migration ships.
 */
async function trimmedMigrations(count: number): Promise<string> {
  const real = migrationsFolder();
  const journal = JSON.parse(
    await readFile(path.join(real, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const kept = journal.entries.slice(0, count);
  const folder = await scratchDir("migrations");
  await mkdir(path.join(folder, "meta"), { recursive: true });
  for (const entry of kept) {
    await copyFile(path.join(real, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  await writeFile(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

/**
 * Create an install: a scratch database migrated to `migrateToPosition` (the
 * whole journal by default) and a data directory with its own mail.key.
 *
 * THE mail.key IS DIFFERENT PER INSTALL by construction -- the byte fill is
 * derived from the label -- because "restoring onto a different install"
 * means the key really is somebody else's, which is the case the spec's third
 * risk is about.
 */
async function makeInstall(
  label: string, options: { migrateToPosition?: number } = {},
): Promise<Install> {
  const name = `${SCRATCH_PREFIX}${label}_${randomUUID().replace(/-/g, "")}`;
  await control.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  const url = withDatabaseName(TEST_DATABASE_URL, name);
  const handle = createDatabase(url, 2);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `conduit-restore-${label}-data-`));
  const mailKeyPath = path.join(dataDir, "mail.key");
  const install: Install = { name, url, handle, dataDir, mailKeyPath };
  installs.push(install);

  const fill = label.charCodeAt(0) % 251;
  await writeFile(mailKeyPath, Buffer.alloc(32, fill), { mode: 0o600 });
  await mkdir(path.join(dataDir, "files"), { recursive: true });

  if (options.migrateToPosition === undefined) {
    await runMigrations(handle.db);
  } else {
    await migrate(handle.db, {
      migrationsFolder: await trimmedMigrations(options.migrateToPosition),
    });
  }
  return install;
}

/** Put recognisable data in an install, through the real services. */
async function seed(install: Install, names: readonly string[]): Promise<string[]> {
  const actor = await resolveUser(install.handle.db, {
    username: "chris", email: null, fullName: null,
  });
  const ids: string[] = [];
  for (const name of names) {
    const company = await createCompany(install.handle.db, actor.id, { name });
    ids.push(company.id);
  }
  const bytes = Buffer.from(`%PDF-1.7\nquote for ${names.join(",")}\n`);
  const { sha256, sizeBytes } = await saveBlob(install.dataDir, Readable.from([bytes]));
  await attachFile(install.handle.db, actor.id, {
    originalName: "quote.pdf", mime: "application/pdf", sizeBytes, sha256,
    companyId: ids[0],
  });
  return ids;
}

/**
 * Every table's exact row count, read over a FRESH connection.
 *
 * FRESH BECAUSE THE POOL IS NOT THE DATABASE. A connection that was open
 * across the restore holds statements prepared against relations that were
 * dropped and recreated; verifying through it would be verifying this
 * process's view rather than what is on disk.
 */
async function rowCounts(url: string, schema = "public"): Promise<Record<string, number>> {
  const handle = createDatabase(url, 1);
  try {
    const tables = await handle.db.execute<{ name: string }>(sql`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ${schema} ORDER BY c.relname
    `);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const rows = await handle.db.execute<{ count: string }>(
        sql.raw(`SELECT count(*)::text AS count FROM "${schema}"."${table.name}"`),
      );
      counts[table.name] = Number(rows[0]?.count ?? "0");
    }
    return counts;
  } finally {
    await handle.close();
  }
}

// --- archives --------------------------------------------------------------

/** Run 7z with the passphrase on stdin and no `-p`, as the spine measured. */
async function sevenZip(args: readonly string[], passphrase: string | null): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn("7z", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => { resolve(code ?? -1); });
    if (passphrase !== null) child.stdin.write(passphrase);
    child.stdin.end();
  });
}

/** A real backup of an install, on disk, as an operator would have it. */
async function realBackup(install: Install, where: string): Promise<string> {
  const archive = await buildBackup({
    db: install.handle.db, dataDir: install.dataDir, mailKeyPath: install.mailKeyPath,
    databaseUrl: install.url, appVersion: APP_VERSION, passphrase: PASSPHRASE,
  });
  const target = path.join(where, "backup.7z");
  try {
    await pipeline(archive.stream, createWriteStream(target));
  } finally {
    await archive.dispose();
  }
  return target;
}

/** Unpack an archive so a test can edit it and pack it again. */
async function unpack(archivePath: string, into: string): Promise<void> {
  const code = await sevenZip(["x", `-o${into}`, "-bd", "-y", "--", archivePath], PASSPHRASE);
  if (code !== 0) throw new Error(`7z x exited ${String(code)}`);
}

/** Pack a directory tree back into an encrypted archive, same flags as 7.6. */
async function pack(dir: string, archivePath: string): Promise<void> {
  const roots = (await readdir(dir)).map((entry) => path.resolve(dir, entry));
  const code = await sevenZip(
    ["a", "-t7z", "-p", "-mhe=on", "-mx=1", "-bd", "-y", "--", archivePath, ...roots],
    PASSPHRASE,
  );
  if (code !== 0) throw new Error(`7z a exited ${String(code)}`);
}

/**
 * Take a real backup apart, let a test change the unpacked tree, and put it
 * back together.
 *
 * THE FIXTURES ARE REAL BACKUPS WITH ONE THING WRONG. A hand-built archive
 * would share whatever assumption the reader makes; this starts from what
 * services/backup.ts actually writes and edits exactly the thing under test.
 */
async function repackedBackup(
  install: Install, edit: (dir: string) => Promise<void>,
): Promise<string> {
  const work = await scratchDir("alter");
  const original = await realBackup(install, work);
  const unpacked = path.join(work, "unpacked");
  await mkdir(unpacked, { recursive: true });
  await unpack(original, unpacked);
  await edit(unpacked);
  const rebuilt = path.join(work, "altered.7z");
  await pack(unpacked, rebuilt);
  return rebuilt;
}

/** The same, for the ordinary case of changing one thing in the manifest. */
async function alteredBackup(
  install: Install,
  edit: (dir: string, manifest: BackupManifest) => Promise<BackupManifest | void>,
): Promise<string> {
  return await repackedBackup(install, async (dir) => {
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
    const updated = await edit(dir, manifest);
    await writeFile(manifestPath, `${JSON.stringify(updated ?? manifest, null, 2)}\n`);
  });
}

// --- staging and inspecting ------------------------------------------------

interface Staged { payload: StagedPayload; plan: RestorePlan }

async function stageAndInspect(
  archivePath: string, target: Install,
  overrides: Partial<Parameters<typeof inspectRestore>[0]> = {},
): Promise<Staged> {
  const file = await receiveIntake({
    dataDir: target.dataDir, source: createReadStream(archivePath), filename: "backup.7z",
  });
  const payload = await stageArchive({ file, passphrase: PASSPHRASE });
  const plan = await inspectRestore({
    file, payload, db: target.handle.db, dataDir: target.dataDir,
    mailKeyPath: target.mailKeyPath, appVersion: APP_VERSION,
    ...overrides,
  });
  return { payload, plan };
}

async function runRestore(
  staged: Staged, target: Install,
  overrides: Partial<Parameters<typeof applyRestore>[0]> = {},
): Promise<ReturnType<typeof applyRestore>> {
  return applyRestore({
    plan: staged.plan, payload: staged.payload, db: target.handle.db,
    databaseUrl: target.url, dataDir: target.dataDir, mailKeyPath: target.mailKeyPath,
    appVersion: APP_VERSION, passphrase: PASSPHRASE,
    ...overrides,
  });
}

/**
 * Where the staged `database.sql` landed, found by walking $data_dir.
 *
 * SERVICES/INTAKE.TS HIDES THIS FROM APPLY ON PURPOSE, and nothing here
 * undermines that: a handler still receives only a ref. This is the test
 * reaching around the outside to break the source WHILE the plan holds a
 * perfectly good ref to it -- which is the only way to reproduce a dump that
 * stops part way through, and it is the failure that committed a truncated
 * database on the deploy target.
 */
async function stagedDumpPath(install: Install): Promise<string> {
  const work = (await readdir(install.dataDir)).find((e) => e.startsWith(INTAKE_WORK_PREFIX));
  if (work === undefined) throw new Error("no intake work directory in $data_dir");
  return path.join(install.dataDir, work, "staged", "database.sql");
}

function safetyPathOf(plan: RestorePlan): string {
  const effect = plan.effects
    .find((candidate): candidate is SafetyBackupEffect => candidate.op === "safety-backup");
  if (effect === undefined) throw new Error("the plan has no safety-backup effect");
  return effect.archivePath;
}

function effectFor(plan: RestorePlan, op: RestoreEffect["op"]): RestoreEffect {
  const effect = plan.effects.find((candidate) => candidate.op === op);
  if (effect === undefined) throw new Error(`the plan has no ${op} effect`);
  return effect;
}

// ===========================================================================
// The pure half: no database, no archive, no destruction.
// ===========================================================================

describe("version ordering", () => {
  it("orders releases and refuses to guess at anything else", () => {
    expect(compareAppVersions("1.3.0", "1.4.0")).toBeLessThan(0);
    expect(compareAppVersions("1.4.0", "1.3.0")).toBeGreaterThan(0);
    expect(compareAppVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareAppVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareAppVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareAppVersions("1.4.0-test", "1.4.0")).toBe(0);
    expect(compareAppVersions("nightly", "1.4.0")).toBeNull();
    expect(compareAppVersions("1.4", "1.4.0")).toBeNull();
  });
});

describe("reading a dump the way psql reads it", () => {
  it("names the tables it creates", () => {
    const state = { inCopy: false };
    expect(readDumpLine("CREATE TABLE public.companies (", state))
      .toEqual({ kind: "table", name: "public.companies" });
    expect(readDumpLine("CREATE UNLOGGED TABLE public.scratch (", state))
      .toEqual({ kind: "table", name: "public.scratch" });
    expect(readDumpLine("    CREATE TABLE indented (", state)).toEqual({ kind: "other" });
    expect(readDumpLine("-- CREATE TABLE commented (", state)).toEqual({ kind: "other" });
  });

  // THE ONE THAT MATTERS, and it is the operator's own text doing it. A note
  // body or a company name whose value begins a line inside a COPY block is
  // not SQL, and a reader that did not know that would take a customer's
  // sentence for a table -- or for a psql command, and refuse the backup.
  it("reads nothing out of COPY data, and resumes after it", () => {
    const state = { inCopy: false };
    expect(readDumpLine("COPY public.notes (id, body) FROM stdin;", state))
      .toEqual({ kind: "other" });
    expect(state.inCopy).toBe(true);
    expect(readDumpLine("CREATE TABLE this is a note body, not SQL", state))
      .toEqual({ kind: "other" });
    expect(readDumpLine("\\q and so is this", state)).toEqual({ kind: "other" });
    expect(readDumpLine("\\.", state)).toEqual({ kind: "other" });
    expect(state.inCopy).toBe(false);
    expect(readDumpLine("CREATE TABLE public.deals (", state))
      .toEqual({ kind: "table", name: "public.deals" });
  });

  // MEASURED: a real plain pg_dump carries exactly these two outside its COPY
  // blocks, and the terminator inside them. Everything else is something psql
  // would ACT on, and the acting is the problem.
  it("allows the two meta-commands pg_dump emits and no others", () => {
    const state = { inCopy: false };
    expect(readDumpLine("\\restrict aBcD1234", state)).toEqual({ kind: "other" });
    expect(readDumpLine("\\unrestrict aBcD1234", state)).toEqual({ kind: "other" });
    for (const [line, command] of [
      ["\\q", "\\q"],
      ["\\connect otherdb", "\\connect"],
      ["\\i /etc/passwd", "\\i"],
      ["\\! rm -rf /", "\\!"],
      ["\\o /tmp/out", "\\o"],
    ] as const) {
      expect(readDumpLine(line, state)).toEqual({ kind: "meta", command });
    }
  });
});

describe("the psql arguments", () => {
  // The behaviour these encode is measured on the deploy target and recorded
  // in restore.ts's header. This asserts the encoding; the rollback and
  // accounting tests below assert the behaviour, which is what actually holds
  // them -- removing either flag changes what a real failed load does.
  it("is the one cell of the matrix that is both safe and truthful", () => {
    const args = psqlLoadArgs();
    expect(args).toContain("--single-transaction");
    expect(args).toContain("ON_ERROR_STOP=1");
    expect(args).toContain("--no-psqlrc");
  });
});

describe("shape comparison", () => {
  const shape = (schemas: string[], ids: string[]): DatabaseShape =>
    ({ schemas, tables: ids.length, tableIds: ids, tableNames: ids.map((id) => `s.t${id}`) });

  it("is sensitive to the schema list and to every table's identity", () => {
    const base = shape(["drizzle", "public"], ["100", "200"]);
    expect(sameShape(base, shape(["drizzle", "public"], ["100", "200"]))).toBe(true);
    expect(sameShape(base, shape(["public"], ["100", "200"]))).toBe(false);
    expect(sameShape(base, shape(["public", "drizzle"], ["100", "200"]))).toBe(false);
    // THE CASE THAT MATTERS MOST: the same schemas and the same NUMBER of
    // tables, recreated. A count says nothing changed; an identity says the
    // database was replaced. Measured on the deploy target as exactly this.
    expect(sameShape(base, shape(["drizzle", "public"], ["300", "400"]))).toBe(false);
  });

  // A LENGTH CHECK AND AN ELEMENT CHECK MASK EACH OTHER when one list is a
  // PREFIX of the other, because `every` is vacuously true over the shorter.
  // Both lists get the case, because the mask would be per-list.
  it("is not fooled by a list that is a prefix of the other", () => {
    const base = shape(["drizzle", "public"], ["100", "200"]);
    expect(sameShape(base, shape(["drizzle", "public", "extra"], ["100", "200"]))).toBe(false);
    expect(sameShape(base, shape(["drizzle", "public"], ["100", "200", "300"]))).toBe(false);
  });
});

// THE FIFTH INSTRUMENT, READ AS A VALUE. services/backup.ts records what the
// database HELD; this is restore deciding what that record means before any of
// it touches a database.
describe("reading a backup's inventory", () => {
  const good = { consistency: "shared-snapshot", tables: [{ table: "public.a", rows: 1 }] };

  // THE DISTINCTION THE WHOLE BACKWARD-COMPATIBILITY STORY RESTS ON. A v1.3.0
  // manifest has no `inventory` key; a manifest saying the database held
  // nothing has one with an empty list. If these collapsed, either every old
  // backup would be refused or every old backup would silently pass a check it
  // never made.
  it("tells an absent inventory from an inventory of nothing", () => {
    expect(readInventory(undefined)).toEqual({ kind: "absent" });
    // A writer that emitted an explicit null said the same thing as one that
    // omitted the key: `undefined` cannot survive JSON at all.
    expect(readInventory(null)).toEqual({ kind: "absent" });
    expect(readInventory({ consistency: "shared-snapshot", tables: [] }))
      .toEqual({ kind: "present", tables: [] });
  });

  // THE INSTRUMENT SHOWN NOT TO REFUSE EVERYTHING, before it is trusted to
  // refuse anything. A reader that answered "unreadable" to all of these would
  // pass every line below it and refuse every real backup.
  it("accepts the shape services/backup.ts writes", () => {
    expect(readInventory(good)).toEqual({ kind: "present", tables: good.tables });
  });

  it("refuses every shape it could not check, and says which", () => {
    const why = (raw: unknown): string => {
      const read = readInventory(raw);
      if (read.kind !== "unreadable") throw new Error(`expected a refusal, got ${read.kind}`);
      return read.why;
    };
    expect(why(42)).toContain("not an object");
    // An array is an object to typeof, and is not an inventory.
    expect(why([])).toContain("not an object");
    expect(why({ tables: [] })).toContain("how its counts were taken");
    expect(why({ consistency: "shared-snapshot" })).toContain("does not list any tables");
    expect(why({ ...good, tables: [{ table: "public.a" }] })).toContain("whole number of rows");
    expect(why({ ...good, tables: [{ table: "public.a", rows: -1 }] }))
      .toContain("whole number of rows");
    expect(why({ ...good, tables: [{ table: "public.a", rows: 1.5 }] }))
      .toContain("whole number of rows");
    expect(why({ ...good, tables: [{ table: "", rows: 1 }] })).toContain("no table name");
    expect(why({ ...good, tables: [{ table: "public.a", rows: 1 }, { table: "public.a", rows: 2 }] }))
      .toContain("twice");
  });

  // CHRIS'S DECISION 1, AT THE VALUE. A label this build cannot evaluate is not
  // damage and is not refused: it is a check that will not be made, which is a
  // different answer from both "unreadable" and "absent" and has to stay
  // distinguishable from them -- the message an operator reads is chosen from
  // it. The `why` is the same sentence the refusal used to carry, because what
  // changed is what Conduit DOES about it, not what it knows.
  it("degrades a consistency label it cannot check, rather than refusing it", () => {
    const read = readInventory({ ...good, consistency: "approximate" });
    expect(read.kind).toBe("uncheckable");
    expect(read.kind === "uncheckable" && read.why).toContain("approximate");
    expect(read.kind === "uncheckable" && read.why).toContain("does not know how to check");
  });

  // AND THE LINE THAT DECISION DRAWS, asserted rather than left to the comment.
  // A LATER WRITER degrades; DAMAGE is still refused. If the tolerance leaked
  // into the entry checks, an inventory whose rows are missing would be
  // "uncheckable" too -- and a restore would then be told it could skip the
  // check over a manifest that had simply been corrupted.
  it("tolerates a label it does not know and still refuses a manifest that is broken", () => {
    // The same archive, unknown label AND a damaged entry: the label is read
    // first, so this is the case that says which answer wins.
    expect(readInventory({ consistency: "approximate", tables: [{ table: "public.a" }] }).kind)
      .toBe("uncheckable");
    // ... and the known label with the same damaged entry is still a refusal.
    expect(readInventory({ ...good, tables: [{ table: "public.a" }] }).kind).toBe("unreadable");
    expect(readInventory({ tables: [] }).kind).toBe("unreadable");
    expect(readInventory(42).kind).toBe("unreadable");
  });
});

describe("comparing an inventory with a restored database", () => {
  const recorded = [{ table: "public.a", rows: 3 }, { table: "public.b", rows: 0 }];

  it("agrees with itself", () => {
    expect(compareInventory(recorded, recorded)).toEqual([]);
    // Order is not a disagreement; the comparison is by name.
    expect(compareInventory(recorded, [...recorded].reverse())).toEqual([]);
  });

  it("finds a count that moved, and a table that did not arrive", () => {
    expect(compareInventory(recorded, [{ table: "public.a", rows: 2 }, recorded[1]!]))
      .toEqual([{ table: "public.a", recorded: 3, restored: 2 }]);
    expect(compareInventory(recorded, [recorded[0]!]))
      .toEqual([{ table: "public.b", recorded: 0, restored: null }]);
  });

  // BOTH DIRECTIONS, and this is the one a one-sided comparison misses. `every`
  // over the RECORDED list is vacuously satisfied by a database holding
  // everything the backup listed plus a table nobody ever recorded -- the same
  // prefix mask sameList exists to close two describes above.
  it("finds a table the restored database has and the backup never recorded", () => {
    expect(compareInventory(recorded, [...recorded, { table: "public.c", rows: 9 }]))
      .toEqual([{ table: "public.c", recorded: null, restored: 9 }]);
    // And a database that is empty where the backup recorded everything.
    expect(compareInventory(recorded, [])).toEqual([
      { table: "public.a", recorded: 3, restored: null },
      { table: "public.b", recorded: 0, restored: null },
    ]);
  });
});

describe("the recovery instructions", () => {
  it("names the archive and the database, and carries no password", () => {
    const commands = recoveryCommands(
      "/data/conduit-safety-backup-2026-09-01T10-00-00Z.7z",
      "postgres://conduit:hunter2@localhost:5432/conduit_prod",
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("/data/conduit-safety-backup-2026-09-01T10-00-00Z.7z");
    expect(commands[1]).toContain("conduit_prod");
    expect(commands[1]).toContain("--single-transaction");
    expect(commands.join("\n")).not.toContain("hunter2");
  });

  // A COMMAND THAT DROPS SCHEMAS MUST NEVER GUESS WHICH DATABASE. The fallback
  // used to be the literal name "conduit", which EXISTS on the deploy target --
  // so a URL carrying no path printed a working command aimed at a different,
  // live install. The placeholder is unpasteable on purpose.
  it("never guesses a database name into a command that drops schemas", () => {
    const commands = recoveryCommands("/data/safety.7z", "postgres://user@host:5432",
      ["public"]);
    const psql = commands[1] ?? "";
    expect(psql).toContain("DROP SCHEMA");
    expect(psql).not.toMatch(/-d conduit\b/);
    expect(psql).toContain("<the database name from DATABASE_URL>");
  });

  it("says there is nothing to recover from when no safety backup was taken", () => {
    expect(recoveryCommands(null, "postgres:///conduit")).toEqual([]);
    const error = new RestoreHalfAppliedError(null, [], "measurement failed");
    expect(error.message).toContain("NO SAFETY BACKUP WAS TAKEN");
    expect(error.message).not.toContain("undefined");
    expect(error.message).not.toContain("null");
  });

  it("puts the path and both commands in the loud message", () => {
    const commands = recoveryCommands("/data/safety.7z", "postgres:///conduit_prod");
    const error = new RestoreHalfAppliedError("/data/safety.7z", commands, "it changed");
    expect(error.message).toContain("HALF-RESTORED");
    expect(error.message).toContain("/data/safety.7z");
    for (const command of commands) expect(error.message).toContain(command);
  });
});

describe("proving an archive opens", () => {
  // THE INSTRUMENT THE SAFETY BACKUP RESTS ON, shown failing before it is
  // trusted to pass. `7z t` decompresses every member and checks its CRC, so a
  // pass is a claim about the whole archive rather than about its header.
  it7z("accepts a good archive, refuses a wrong passphrase and refuses a truncated one",
    async () => {
      const dir = await scratchDir("prove");
      await writeFile(path.join(dir, "a.txt"), "hello");
      const archive = path.join(dir, "out.7z");
      await pack(dir, archive);

      expect((await proveArchiveOpens(archive, PASSPHRASE)).code).toBe(0);
      expect((await proveArchiveOpens(archive, "not the passphrase")).code).not.toBe(0);

      const size = (await stat(archive)).size;
      await truncate(archive, Math.floor(size / 2));
      expect((await proveArchiveOpens(archive, PASSPHRASE)).code).not.toBe(0);
    });
});

// ===========================================================================
// The refusals: every one reached with nothing written and nothing destroyed.
// ===========================================================================

describe("refusing before anything is destroyed", () => {
  itRestore("refuses a backup from a NEWER Conduit, on the app version alone", async () => {
    const source = await makeInstall("srcnewapp");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnewapp");
    const before = await rowCounts(target.url);

    // THE MIGRATION POSITION IS LEFT ALONE. Two independent layers refuse a
    // newer backup, and a fixture that moved both would let either one be
    // deleted without a test noticing -- the pattern that has produced three
    // defects on this project already.
    const archive = await alteredBackup(source, async (_dir, manifest) => {
      expect(manifest.migrationPosition).toBe((await readMigrationJournal()).position);
      return { ...manifest, appVersion: "9.9.9" };
    });
    const { plan } = await stageAndInspect(archive, target);

    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.newerApp);
    expect(plan.refusal?.message).toContain("9.9.9");
    expect(plan.effects).toEqual([]);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  itRestore("refuses a backup with a NEWER schema, on the migration position alone",
    async () => {
      const source = await makeInstall("srcnewsch");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstnewsch");
      const before = await rowCounts(target.url);

      // THE APP VERSION IS LEFT ALONE, for the same reason as above. This
      // backup claims to be from this exact build and to carry one migration
      // more than it ships -- which is what a migration merged ahead of a
      // version bump looks like.
      const archive = await alteredBackup(source, async (_dir, manifest) => {
        expect(manifest.appVersion).toBe(APP_VERSION);
        return { ...manifest, migrationPosition: manifest.migrationPosition + 1 };
      });
      const { plan } = await stageAndInspect(archive, target);

      expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.newerSchema);
      expect(plan.effects).toEqual([]);
      expect(await rowCounts(target.url)).toEqual(before);
    });

  itRestore("refuses a corrupted archive before anything is destroyed", async () => {
    const source = await makeInstall("srccorrupt");
    await seed(source, ["Acme", "Globex"]);
    const target = await makeInstall("dstcorrupt");
    await seed(target, ["Initech"]);
    const before = await rowCounts(target.url);

    // A WHOLE, WELL-FORMED FILE IN THE RIGHT PLACE, so 7z is perfectly happy
    // with it: the archive decompresses and every CRC matches. What is wrong
    // is that it is not the file the manifest recorded, which is the only
    // layer that can see this.
    const archive = await alteredBackup(source, async (dir) => {
      await writeFile(path.join(dir, "database.sql"), "-- not the dump that was taken\n");
    });
    const staged = await stageAndInspect(archive, target);
    const { plan } = staged;

    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.memberCorrupt);
    expect(plan.refusal?.message).toContain("database.sql");
    expect(plan.effects).toEqual([]);
    expect(await rowCounts(target.url)).toEqual(before);
    // And it is inert even if somebody tries: a refusal plan cannot dispatch.
    const failure = await rejection(runRestore({ payload: staged.payload, plan }, target));
    expect(failure).toBeInstanceOf(PlanRefusedError);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  itRestore("refuses a backup whose manifest lists a member the archive does not hold",
    async () => {
      const source = await makeInstall("srcgone");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstgone");
      const archive = await alteredBackup(source, async (dir, manifest) => {
        const blob = manifest.members.find((member) => member.path.startsWith("files/"));
        expect(blob).toBeDefined();
        await rm(path.join(dir, blob?.path ?? ""), { force: true });
      });
      const { plan } = await stageAndInspect(archive, target);
      expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.memberMissing);
    });

  itRestore("refuses an archive with no manifest at all", async () => {
    const source = await makeInstall("srcnoman");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnoman");
    const archive = await repackedBackup(source, async (dir) => {
      await rm(path.join(dir, "manifest.json"), { force: true });
    });
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.manifestMissing);
    expect(plan.effects).toEqual([]);
  });

  itRestore("refuses an archive whose manifest is not readable", async () => {
    const source = await makeInstall("srcbadman");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstbadman");
    const archive = await repackedBackup(source, async (dir) => {
      await writeFile(path.join(dir, "manifest.json"), "{ this is not json");
    });
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.manifestUnreadable);
  });

  itRestore("refuses a manifest that does not say where its schema came from", async () => {
    const source = await makeInstall("srcnopos");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnopos");
    const archive = await alteredBackup(source, async (_dir, manifest) =>
      ({ ...manifest, migrationPosition: "twelve" as unknown as number }));
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.manifestUnreadable);
    expect(plan.refusal?.message).toContain("schema");
  });

  itRestore("refuses an archive with no database.sql in it", async () => {
    const source = await makeInstall("srcnodump");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnodump");
    // Removed from the archive AND from the manifest, so the only rule left
    // that can see it is the required-member check -- which is the point:
    // a manifest that never listed the dump passes every digest it does list.
    const archive = await alteredBackup(source, async (dir, manifest) => {
      await rm(path.join(dir, "database.sql"), { force: true });
      return {
        ...manifest,
        members: manifest.members.filter((member) => member.path !== "database.sql"),
      };
    });
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.memberMissing);
    expect(plan.refusal?.message).toContain("database.sql");
  });

  // ===================================================================
  // THE MANIFEST THAT MAKES NO CLAIM.
  //
  // The digest sweep is the ONLY independent witness to the dump's contents --
  // the byte count the load checks is a stat() of the very file the load
  // streams, so it compares a file with itself. Drop `database.sql` out of
  // `members` and the sweep never looks at it: measured on tip, a dump cut
  // after a COPY terminator then inspected CLEAN, applied, and emptied all 26
  // tables with `{dispatched:5, realised:5, unrealised:[]}` and no error.
  //
  // The fixture is a manifest that OMITS the member, not a corrupted file --
  // a corrupted file was already refused, which is exactly why this hid.
  // ===================================================================
  itRestore("refuses a manifest that does not list database.sql", async () => {
    const source = await makeInstall("srcunlisted");
    await seed(source, ["Acme", "Globex"]);
    const target = await makeInstall("dstunlisted");
    await seed(target, ["Untouched"]);
    const before = await rowCounts(target.url);

    // The dump is cut AND the manifest stops mentioning it, so nothing but the
    // required-member rule can see anything wrong.
    const archive = await repackedBackup(source, async (dir) => {
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
      const dumpPath = path.join(dir, "database.sql");
      const dump = await readFile(dumpPath, "utf8");
      const terminator = dump.indexOf("\n\\.\n", dump.indexOf("\nCOPY "));
      expect(terminator).toBeGreaterThan(0);
      await writeFile(dumpPath, dump.slice(0, terminator + 4));
      await writeFile(manifestPath, `${JSON.stringify({
        ...manifest,
        members: manifest.members.filter((member) => member.path !== "database.sql"),
      }, null, 2)}\n`);
    });

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal?.code).toBe(RESTORE_REFUSALS.memberMissing);
    expect(staged.plan.refusal?.message).toContain("does not list database.sql");
    expect(staged.plan.effects).toEqual([]);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  itRestore("refuses a manifest whose declared size is not the size in the archive",
    async () => {
      const source = await makeInstall("srcbadsize");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstbadsize");
      // THE DIGEST IS LEFT CORRECT, so only the size check can see this -- and
      // the size is what the load takes its budget from, so a manifest that
      // lied about it would be found half way through replacing the database.
      const archive = await alteredBackup(source, async (_dir, manifest) => ({
        ...manifest,
        members: manifest.members.map((member) => member.path === "database.sql"
          ? { ...member, bytes: member.bytes + 1 }
          : member),
      }));
      const { plan } = await stageAndInspect(archive, target);
      expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.memberCorrupt);
      expect(plan.refusal?.message).toContain("bytes");
      expect(plan.effects).toEqual([]);
    });

  itRestore("refuses a manifest with no member list at all", async () => {
    const source = await makeInstall("srcnolist");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnolist");
    const archive = await repackedBackup(source, async (dir) => {
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      delete manifest.members;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const { plan } = await stageAndInspect(archive, target);
    // NOT "zero claims and they all hold", which is what
    // `Array.isArray(x) ? x : []` turned this into.
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.manifestUnreadable);
    expect(plan.refusal?.message).toContain("does not list what is in the archive");
  });

  // ===================================================================
  // THE DUMP THAT TELLS psql TO STOP.
  //
  // MEASURED with the exact command this module runs: a script whose second
  // line is `\q` exits 0 with one of three INSERTs committed. psql closes
  // WITHOUT reading to end of file, so the flags see no error, the byte count
  // sees a fully delivered file, and the table count sees every table -- all
  // three process instruments pass over a database that got a prefix.
  // ===================================================================
  itRestore("refuses a dump carrying a psql command that could stop it part way",
    async () => {
      const source = await makeInstall("srcmeta");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstmeta");
      await seed(target, ["Untouched"]);
      const before = await rowCounts(target.url);

      // Placed after the last CREATE TABLE, where every table exists and the
      // data does not -- the position that satisfies every other instrument.
      const archive = await alteredBackup(source, async (dir, manifest) => {
        const dumpPath = path.join(dir, "database.sql");
        const dump = await readFile(dumpPath, "utf8");
        const at = dump.indexOf("\nCOPY ");
        expect(at).toBeGreaterThan(0);
        const injected = `${dump.slice(0, at)}\n\\q\n${dump.slice(at)}`;
        await writeFile(dumpPath, injected);
        return {
          ...manifest,
          members: manifest.members.map((member) => member.path === "database.sql"
            ? { ...member, bytes: Buffer.byteLength(injected), sha256: digestOf(injected) }
            : member),
        };
      });

      const { plan } = await stageAndInspect(archive, target);
      expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.dumpMetaCommand);
      expect(plan.refusal?.message).toContain("\\q");
      expect(plan.effects).toEqual([]);
      expect(await rowCounts(target.url)).toEqual(before);
    });

  itRestore("refuses an archive with no mail.key in it", async () => {
    const source = await makeInstall("srcnokey");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstnokey");
    // Out of the archive AND out of the manifest, so the digest sweep cannot
    // see it either -- the required-member rule is the only layer left, which
    // is what makes this discriminate. The dump has the same fixture; the key
    // did not, in a commit claiming every guard was mutation-tested.
    const archive = await alteredBackup(source, async (dir, manifest) => {
      await rm(path.join(dir, "mail.key"), { force: true });
      return {
        ...manifest,
        members: manifest.members.filter((member) => member.path !== "mail.key"),
      };
    });
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.memberMissing);
    expect(plan.refusal?.message).toContain("mail.key");
    expect(plan.effects).toEqual([]);
  });

  itRestore("refuses an export, which is not a backup", async () => {
    const source = await makeInstall("srcexport");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstexport");
    const archive = await alteredBackup(source, async (_dir, manifest) =>
      ({ ...manifest, kind: "export" as unknown as "backup" }));
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.notABackup);
    expect(plan.refusal?.message).toContain("mail.key");
  });

  itRestore("refuses an archive format it does not read", async () => {
    const source = await makeInstall("srcfmt");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstfmt");
    const archive = await alteredBackup(source, async (_dir, manifest) =>
      ({ ...manifest, formatVersion: 99 }));
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.formatUnknown);
  });

  itRestore("refuses a dump from a newer PostgreSQL than this server", async () => {
    const source = await makeInstall("srcpg");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstpg");
    const archive = await alteredBackup(source, async (_dir, manifest) =>
      ({ ...manifest, postgres: { ...manifest.postgres, serverVersion: "99.1" } }));
    const { plan } = await stageAndInspect(archive, target);
    expect(plan.refusal?.code).toBe(RESTORE_REFUSALS.newerServer);
  });

  itRestore("refuses when psql or 7z is missing, and names the package", async () => {
    const source = await makeInstall("srctools");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dsttools");
    const work = await scratchDir("tools");
    const archive = await realBackup(source, work);

    const noPsql = await stageAndInspect(archive, target, {
      psqlPresent: async () => false,
    });
    expect(noPsql.plan.refusal?.code).toBe(RESTORE_REFUSALS.psqlMissing);
    expect(noPsql.plan.refusal?.message).toContain("postgresql-client");

    const noSevenZip = await stageAndInspect(archive, target, {
      sevenZipPresent: async () => false,
    });
    expect(noSevenZip.plan.refusal?.code).toBe(RESTORE_REFUSALS.sevenZipMissing);
    expect(noSevenZip.plan.refusal?.message).toContain("p7zip-full");
  });
});

// ===========================================================================
// The restore itself.
// ===========================================================================

describe("restoring onto a different install", () => {
  itRestore("replaces everything and the data is equal by exact row counts", async () => {
    const source = await makeInstall("srcfull");
    const companies = await seed(source, ["Acme", "Globex", "Initech"]);
    const sourceCounts = await rowCounts(source.url);
    const sourceKey = await readFile(source.mailKeyPath);

    const target = await makeInstall("dstfull");
    await seed(target, ["Somebody Else"]);
    const targetKeyBefore = await readFile(target.mailKeyPath);
    expect(targetKeyBefore.equals(sourceKey)).toBe(false);

    const work = await scratchDir("full");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();

    const outcome = await runRestore(staged, target);

    // EVERY EFFECT DISPATCHED AND EVERY EFFECT REALISED. On a plan that ran to
    // the end these are equal, because the executor refuses a plan whose
    // preparation has no consumer.
    expect(outcome.dispatched).toBe(staged.plan.effects.length);
    expect(outcome.realised).toBe(outcome.dispatched);
    expect(outcome.unrealised).toEqual([]);

    // THE DATA, TABLE BY TABLE, EXACT. Not an exit code.
    expect(await rowCounts(target.url)).toEqual(sourceCounts);
    const restored = createDatabase(target.url, 1);
    try {
      const rows = await restored.db.execute<{ name: string }>(
        sql`SELECT name FROM companies ORDER BY name`,
      );
      expect(rows.map((row) => row.name)).toEqual(["Acme", "Globex", "Initech"]);
      const ids = await restored.db.execute<{ id: string }>(sql`SELECT id FROM companies`);
      expect(new Set(ids.map((row) => row.id))).toEqual(new Set(companies));
    } finally {
      await restored.close();
    }

    // THE BLOBS AND THE KEY.
    const sourceBlobs = (await readdir(path.join(source.dataDir, "files"))).sort();
    const targetBlobs = (await readdir(path.join(target.dataDir, "files"))).sort();
    expect(targetBlobs).toEqual(expect.arrayContaining(sourceBlobs));
    expect((await readFile(target.mailKeyPath)).equals(sourceKey)).toBe(true);
  });

  // THE SINGLE ITEM THE SPEC SAYS THIS PHASE MUST NOT GET WRONG.
  itRestore("restores an archive carrying an unlisted files/ member", async () => {
    const source = await makeInstall("srcextra");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstextra");

    const extra = Buffer.from("%PDF-1.7\nuploaded while the backup was being written\n");
    const extraName = digestOf(extra);
    const archive = await alteredBackup(source, async (dir) => {
      // In the archive, NOT in the manifest -- exactly what an upload landing
      // between the blob walk and 7z reading the directory again produces.
      await writeFile(path.join(dir, "files", extraName), extra);
    });

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();
    const note = staged.plan.findings.find((f) => f.code === RESTORE_FINDINGS.extraBlobs);
    expect(note?.severity).toBe("note");

    const blobs = effectFor(staged.plan, "write-blobs");
    const listedBlobs = (await readdir(path.join(source.dataDir, "files"))).length;
    expect(blobs.count).toBe(listedBlobs + 1);

    const outcome = await runRestore(staged, target);
    expect(outcome.realised).toBe(outcome.dispatched);
    expect(await readFile(path.join(target.dataDir, "files", extraName))).toEqual(extra);
  });

  itRestore("migrates an older backup forward and verifies it", async () => {
    const journal = await readMigrationJournal();
    const source = await makeInstall("srcold", { migrateToPosition: journal.position - 1 });
    const actor = await resolveUser(source.handle.db, {
      username: "chris", email: null, fullName: null,
    });
    await createCompany(source.handle.db, actor.id, { name: "Ancient Holdings" });
    const target = await makeInstall("dstold");

    // The dump is of a pre-N database, and the manifest says so. buildBackup
    // always records the position the BUILD ships, so the older backup has to
    // be composed rather than taken.
    const archive = await alteredBackup(source, async (_dir, manifest) => ({
      ...manifest,
      migrationPosition: journal.position - 1,
      schemaVersion: "an-older-tag",
    }));

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();
    expect(staged.plan.findings.map((f) => f.code)).toContain(RESTORE_FINDINGS.olderSchema);
    const forward = effectFor(staged.plan, "migrate-forward");
    expect(forward.count).toBe(1);

    const outcome = await runRestore(staged, target);
    expect(outcome.realised).toBe(outcome.dispatched);

    const restored = createDatabase(target.url, 1);
    try {
      // MEASURED FROM THE DATABASE'S OWN BOOKKEEPING: the migrations really ran.
      const applied = await restored.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
      );
      expect(Number(applied[0]?.count)).toBe(journal.position);
      // WHY THE INVENTORY CHECK RUNS BEFORE THE MIGRATIONS AND NOT AFTER, said
      // as a measurement rather than as an ordering the reader has to trust.
      // The inventory describes the backup's schema; migrating forward CHANGES
      // the database it describes, and here it changes it by exactly one row of
      // drizzle bookkeeping. A check placed one step later would fail this
      // perfectly good restore, so the number that would have been compared is
      // asserted to be the wrong one.
      const load = effectFor(staged.plan, "load-dump") as RestoreEffect & {
        inventory: readonly { table: string; rows: number }[] | null;
      };
      const recordedBookkeeping = load.inventory
        ?.find((one) => one.table === "drizzle.__drizzle_migrations")?.rows;
      expect(recordedBookkeeping).toBe(journal.position - 1);
      expect(recordedBookkeeping).not.toBe(Number(applied[0]?.count));
      // And the data that was there before the migration survived it.
      const rows = await restored.db.execute<{ name: string }>(sql`SELECT name FROM companies`);
      expect(rows.map((row) => row.name)).toEqual(["Ancient Holdings"]);
      // And the schema really is this build's, table for table.
      const shape = await describeDatabaseShape(restored.db);
      expect(shape.tables).toBe(
        (await describeDatabaseShape(control.db)).tables,
      );
    } finally {
      await restored.close();
    }
  });

  // THE MIGRATION ACCOUNTING IS MEASURED, NOT ASSUMED, and this is what says
  // so. A step that simply spent its own declared count would pass every test
  // above without ever asking the database what ran -- so the plan is edited to
  // claim one migration more than there is, and the mismatch has to come from
  // drizzle's own bookkeeping rather than from arithmetic on the plan.
  itRestore("counts the migrations that actually ran, not the ones planned", async () => {
    const journal = await readMigrationJournal();
    const source = await makeInstall("srccountmig", {
      migrateToPosition: journal.position - 1,
    });
    const actor = await resolveUser(source.handle.db, {
      username: "chris", email: null, fullName: null,
    });
    await createCompany(source.handle.db, actor.id, { name: "Ancient Holdings" });
    const target = await makeInstall("dstcountmig");

    const archive = await alteredBackup(source, async (_dir, manifest) => ({
      ...manifest, migrationPosition: journal.position - 1, schemaVersion: "an-older-tag",
    }));
    const staged = await stageAndInspect(archive, target);
    const forward = effectFor(staged.plan, "migrate-forward");
    const edited = newPlan<RestoreEffect>({
      kind: "restore",
      source: staged.plan.source,
      effects: staged.plan.effects.map((effect) => effect.op === "migrate-forward"
        ? { ...forward, count: forward.count + 1 } as RestoreEffect
        : effect),
    });

    const failure = await rejection(runRestore({ ...staged, plan: edited }, target));
    // NOT the frame's accounting error, and this test used to ASSERT THAT IT
    // WAS -- over an install whose every table had already been replaced and
    // whose mail.key had already been swapped. `PlanExceededError` travels
    // unwrapped, so the caller got no outcome, no safety backup path and no
    // recovery commands: verbatim the hazard the load step was fixed for,
    // surviving one step further down the plan, with a green test on top of it.
    expect(failure).not.toBeInstanceOf(PlanExceededError);
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreUnexpectedMigrationsError);
    const message = (cause as Error).message;
    expect(message).toContain(`said ${String(forward.count + 1)}`);
    expect(message).toContain(`${String(forward.count)} ran`);
    expect(message).toContain("has HAPPENED");
    expect(message).toContain(safetyPathOf(staged.plan));
    // The partial outcome travels, which is the whole point of not letting the
    // frame report this.
    expect((failure as PlanApplyError).outcome.dispatched).toBeGreaterThan(0);
  });

  // A migration that THROWS after the load has committed is an ordinary way to
  // fail -- a constraint a years-old install violates is exactly what the
  // older-backup path exists for -- and it left the same silence.
  itRestore("says the database is restored when the migrations themselves fail", async () => {
    const journal = await readMigrationJournal();
    // FULLY migrated, so every object the last migration creates is already in
    // the dump...
    const source = await makeInstall("srcmigfail");
    await seed(source, ["Ancient Holdings"]);
    const target = await makeInstall("dstmigfail");

    // ...but the dump's own drizzle bookkeeping is made to forget the last one.
    // The restored database then has the schema and claims not to, so drizzle
    // applies a migration over objects that already exist and throws. No seam:
    // this is what migrating real data forward looks like when it goes wrong,
    // and it happens AFTER the load has committed.
    const archive = await alteredBackup(source, async (dir, manifest) => {
      const dumpPath = path.join(dir, "database.sql");
      const dump = await readFile(dumpPath, "utf8");
      const copyAt = dump.indexOf("COPY drizzle.");
      expect(copyAt).toBeGreaterThan(0);
      const endAt = dump.indexOf("\n\\.\n", copyAt);
      expect(endAt).toBeGreaterThan(copyAt);
      const head = dump.slice(0, copyAt);
      const block = dump.slice(copyAt, endAt);
      const tail = dump.slice(endAt);
      const rows = block.split("\n");
      expect(rows.length).toBeGreaterThan(2);
      const edited = `${head}${rows.slice(0, -1).join("\n")}${tail}`;
      await writeFile(dumpPath, edited);
      const inventory = manifest.inventory;
      if (inventory === undefined) throw new Error("the real backup carried no inventory");
      return {
        ...manifest,
        migrationPosition: journal.position - 1,
        schemaVersion: "an-older-tag",
        members: manifest.members.map((member) => member.path === "database.sql"
          ? { ...member, bytes: Buffer.byteLength(edited), sha256: digestOf(edited) }
          : member),
        // THE MANIFEST HAS TO DESCRIBE THE ARCHIVE IT IS IN, and since v1.4.0
        // that includes what the database held. The edit above removed a
        // bookkeeping row from the dump, so the fixture is an OLDER backup and
        // its inventory says so -- for exactly the reason the digest above is
        // recomputed. Left alone, the inventory check fires first and this test
        // never reaches the migration failure it is about, which is the check
        // doing its job rather than a fixture detail.
        inventory: {
          ...inventory,
          tables: inventory.tables.map((one) =>
            one.table === "drizzle.__drizzle_migrations"
              ? { ...one, rows: one.rows - 1 } : one),
        },
      };
    });
    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();

    const failure = await rejection(runRestore(staged, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreMigrationError);
    const message = (cause as Error).message;
    expect(message).toContain("was restored");
    expect(message).toContain("Do not use this install");

    // AND THE RESTORE REALLY DID HAPPEN, which is the half the old silence hid.
    const restored = createDatabase(target.url, 1);
    try {
      const rows = await restored.db.execute<{ name: string }>(sql`SELECT name FROM companies`);
      expect(rows.map((row) => row.name)).toEqual(["Ancient Holdings"]);
    } finally {
      await restored.close();
    }
  });

  itRestore("replaces mail.key atomically and drops this process's cached copy", async () => {
    const source = await makeInstall("srckey");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstkey");

    // Make this process cache the TARGET's key, the way a running server has.
    const before = loadMailKey(target.mailKeyPath);
    expect(before.equals(await readFile(source.mailKeyPath))).toBe(false);
    const sealed = encryptCredentials(before, {
      imapPassword: "under the old key", smtpPassword: "under the old key",
    });

    const work = await scratchDir("key");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);
    const warning = staged.plan.findings.find(
      (f) => f.code === RESTORE_FINDINGS.mailKeyReplaced,
    );
    expect(warning?.severity).toBe("warning");
    expect(staged.plan.findings.map((f) => f.code)).toContain(RESTORE_FINDINGS.restartRequired);

    await runRestore(staged, target);

    const onDisk = await readFile(target.mailKeyPath);
    expect(onDisk.equals(await readFile(source.mailKeyPath))).toBe(true);
    expect((await stat(target.mailKeyPath)).mode & 0o777).toBe(0o600);
    // No half-written sibling left behind by the rename.
    expect((await readdir(target.dataDir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
    // THE CACHE WAS DROPPED: the process now reads the restored key, so the
    // old ciphertext no longer decrypts -- which is the truth, and the reason
    // the plan warns about it.
    const reloaded = loadMailKey(target.mailKeyPath);
    expect(reloaded.equals(onDisk)).toBe(true);
    // Which is the honest consequence the plan warns about: what was sealed
    // under the replaced key no longer opens.
    expect(() => decryptCredentials(reloaded, sealed)).toThrow();
  });
});

// ===========================================================================
// The safety backup, proved before the destructive step.
// ===========================================================================

// THE MUTATION THAT SURVIVED, AND SHOULD NOT HAVE. Writing mail.key in place
// instead of to a sibling and renaming was reported as "not observable from a
// passing test without crash injection". That was wrong, and the distinction is
// an ordinary unix one: rename(2) needs write permission on the DIRECTORY,
// while writing in place needs it on the FILE. A read-only mail.key separates
// them exactly -- the real code replaces the inode and passes, an in-place
// write gets EACCES -- and it costs fifteen lines and no crash.
//
// Skipped for root, which ignores file permissions and would pass either way:
// a test that cannot fail is not a test. Neither CI nor the dev server runs as
// root, so this is a guard on the guard rather than a routine skip.
const itNotRoot = (process.getuid?.() ?? 0) !== 0 ? itRestore : it.skip;

describe("replacing mail.key without a window", () => {
  itNotRoot("replaces a read-only mail.key, which an in-place write could not",
    async () => {
      const source = await makeInstall("srcro");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstro");

      const work = await scratchDir("ro");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);

      // Read-only, and unwritable in place. The directory stays writable, so a
      // rename is still allowed -- which is the whole difference.
      await chmod(target.mailKeyPath, 0o400);
      await expect(writeFile(target.mailKeyPath, Buffer.alloc(32, 9))).rejects.toThrow();

      const outcome = await runRestore(staged, target);
      expect(outcome.realised).toBe(outcome.dispatched);

      // The key was replaced, and the new file carries its own mode rather
      // than inheriting the old inode's.
      expect((await readFile(target.mailKeyPath)).equals(await readFile(source.mailKeyPath)))
        .toBe(true);
      expect((await stat(target.mailKeyPath)).mode & 0o777).toBe(0o600);
      expect((await readdir(target.dataDir)).filter((n) => n.includes(".restoring-"))).toEqual([]);
    });
});

describe("the safety backup", () => {
  // THE NAME MUST BE UNIQUE TO A PLAN, NOT TO A SECOND, and a CI run is what
  // proved it was not. The archive is written with `wx`, so two plans made
  // inside the same second name the same file and the second write fails with
  // EEXIST -- which is reported as "the restore did not start", naming a file
  // the operator never created. The sequence that reaches it is the ordinary
  // one: a restore that fails fast, and a second attempt. It never showed on
  // the dev server, where the gap between two attempts happened to cross a
  // second boundary; a faster machine crossed nothing.
  //
  // NO ARCHIVE AND NO DATABASE IN THIS CASE. The property is a property of the
  // NAME, and the two clocks below are a millisecond apart inside one second --
  // which is the whole of what a whole-second stamp cannot tell apart.
  it7z("names a different file for two plans made inside one second", async () => {
    const source = await makeInstall("srcstamp");
    const target = await makeInstall("dststamp");
    const work = await scratchDir("stamp");
    const archive = await realBackup(source, work);

    const first = await stageAndInspect(archive, target, {
      now: new Date("2026-09-01T10:00:00.100Z"),
    });
    const second = await stageAndInspect(archive, target, {
      now: new Date("2026-09-01T10:00:00.900Z"),
    });
    try {
      expect(safetyPathOf(first.plan)).not.toBe(safetyPathOf(second.plan));
      // And the name is still something a person can read in an `ls`.
      expect(safetyPathOf(first.plan)).toContain("conduit-safety-backup-2026-09-01T10-00-00");
    } finally {
      await first.payload.dispose();
      await second.payload.dispose();
    }
  });

  itRestore("exists, is 0600, and opens with the operator's passphrase", async () => {
    const source = await makeInstall("srcsafe");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstsafe");
    await seed(target, ["The Install Being Replaced"]);

    const work = await scratchDir("safe");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);
    const safetyPath = safetyPathOf(staged.plan);
    // The preview NAMES the file, and it is the file that appears.
    expect(effectFor(staged.plan, "safety-backup").detail).toContain(safetyPath);

    await runRestore(staged, target);

    expect((await stat(safetyPath)).mode & 0o777).toBe(0o600);
    expect((await proveArchiveOpens(safetyPath, PASSPHRASE)).code).toBe(0);

    // AND IT IS A BACKUP OF WHAT WAS REPLACED, not of what replaced it.
    const opened = await scratchDir("safeopen");
    await unpack(safetyPath, opened);
    const dump = await readFile(path.join(opened, "database.sql"), "utf8");
    expect(dump).toContain("The Install Being Replaced");
    expect(dump).not.toContain("Acme");
  });

  itRestore("is already on disk when the load fails, which is what proves the order",
    async () => {
      const source = await makeInstall("srcorder");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstorder");
      await seed(target, ["Untouched"]);

      const archive = await alteredBackup(source, async (dir, manifest) => {
        const dumpPath = path.join(dir, "database.sql");
        const broken = `${await readFile(dumpPath, "utf8")}\nSELECT no_such_function();\n`;
        await writeFile(dumpPath, broken);
        return {
          ...manifest,
          members: manifest.members.map((member) => member.path === "database.sql"
            ? { ...member, bytes: Buffer.byteLength(broken), sha256: digestOf(broken) }
            : member),
        };
      });

      const staged = await stageAndInspect(archive, target);
      const safetyPath = safetyPathOf(staged.plan);
      await rejection(runRestore(staged, target));

      expect((await stat(safetyPath)).isFile()).toBe(true);
      expect((await proveArchiveOpens(safetyPath, PASSPHRASE)).code).toBe(0);
    });

  itRestore("stops the restore, having destroyed nothing, when it cannot be written",
    async () => {
      const source = await makeInstall("srcnospace");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstnospace");
      await seed(target, ["Still Here"]);
      const before = await rowCounts(target.url);

      const work = await scratchDir("nospace");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);

      // Plenty for buildBackup's own pre-flight (call one), then nothing left
      // for the copy that keeps the archive (call two). The seam is the one
      // services/backup.ts already has for exactly this: a check that cannot
      // be exercised on a machine with room.
      let call = 0;
      const failure = await rejection(runRestore(staged, target, {
        freeBytes: async () => {
          call += 1;
          return call === 1 ? 500 * 1024 * 1024 * 1024 : 1024;
        },
      }));

      const cause = failure instanceof PlanApplyError ? failure.cause : failure;
      expect(cause).toBeInstanceOf(RestoreSafetyBackupError);
      expect(failure).toBeInstanceOf(PlanApplyError);
      expect((failure as PlanApplyError).outcome.dispatched).toBe(0);
      expect((failure as PlanApplyError).outcome.realised).toBe(0);
      expect(await rowCounts(target.url)).toEqual(before);
    });

  itRestore("stops the restore when the archive cannot be written at all", async () => {
    const source = await makeInstall("srcunwritable");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstunwritable");
    await seed(target, ["Still Here"]);
    const before = await rowCounts(target.url);

    const work = await scratchDir("unwritable");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);

    // The plan names a path inside a directory that is not there, so the write
    // fails outright. What is under test is that a write which fails is a
    // REFUSAL and not something the restore carries on past.
    const safety = effectFor(staged.plan, "safety-backup") as SafetyBackupEffect;
    const edited = newPlan<RestoreEffect>({
      kind: "restore",
      source: staged.plan.source,
      effects: staged.plan.effects.map((effect) => effect.op === "safety-backup"
        ? { ...safety, archivePath: path.join(target.dataDir, "no-such-dir", "s.7z") }
        : effect),
    });

    const failure = await rejection(runRestore({ ...staged, plan: edited }, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreSafetyBackupError);
    expect((cause as Error).message).toContain("has not started");
    expect((failure as PlanApplyError).outcome.dispatched).toBe(0);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  // THE FLAG IS `wx` SO THAT A COLLISION REFUSES RATHER THAN OVERWRITES, and
  // the cleanup beside it must not undo that by deleting what it collided with.
  itRestore("refuses a name collision without touching the file already there", async () => {
    const source = await makeInstall("srccollide");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstcollide");
    await seed(target, ["Still Here"]);
    const before = await rowCounts(target.url);

    const work = await scratchDir("collide");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);
    const safetyPath = safetyPathOf(staged.plan);
    const squatter = Buffer.from("an earlier safety backup, and not this run's to delete");
    await writeFile(safetyPath, squatter);

    const failure = await rejection(runRestore(staged, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreSafetyBackupError);
    expect((failure as PlanApplyError).outcome.dispatched).toBe(0);
    expect(await readFile(safetyPath)).toEqual(squatter);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  itRestore("stops the restore when the archive it wrote cannot be opened again",
    async () => {
      const source = await makeInstall("srcnoopen");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstnoopen");
      await seed(target, ["Still Here"]);
      const before = await rowCounts(target.url);

      const work = await scratchDir("noopen");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);
      const safetyPath = safetyPathOf(staged.plan);

      const failure = await rejection(runRestore(staged, target, {
        proveOpens: async () => ({ code: 2, stderr: "Cannot open encrypted archive" }),
      }));
      const cause = failure instanceof PlanApplyError ? failure.cause : failure;
      expect(cause).toBeInstanceOf(RestoreSafetyBackupError);
      expect((cause as Error).message).toContain("has not started");
      expect((failure as PlanApplyError).outcome.dispatched).toBe(0);
      // NOTHING DESTROYED, and no archive left behind claiming to be an undo.
      expect(await rowCounts(target.url)).toEqual(before);
      await expect(stat(safetyPath)).rejects.toThrow();
    });
});

// ===========================================================================
// The failed load: rolled back, and REPORTED HONESTLY.
// ===========================================================================

/** A real backup whose dump is valid and then deliberately fails at the end. */
async function backupWithBrokenDump(source: Install): Promise<string> {
  return await alteredBackup(source, async (dir, manifest) => {
    const dumpPath = path.join(dir, "database.sql");
    const broken = `${await readFile(dumpPath, "utf8")}\nSELECT no_such_function();\n`;
    await writeFile(dumpPath, broken);
    return {
      ...manifest,
      members: manifest.members.map((member) => member.path === "database.sql"
        ? { ...member, bytes: Buffer.byteLength(broken), sha256: digestOf(broken) }
        : member),
    };
  });
}

describe("a load that fails", () => {
  itRestore("rolls back, leaves the operator where they started, and says so", async () => {
    const source = await makeInstall("srcroll");
    await seed(source, ["Acme", "Globex"]);
    const target = await makeInstall("dstroll");
    await seed(target, ["Exactly Where I Started"]);
    const before = await rowCounts(target.url);
    const keyBefore = await readFile(target.mailKeyPath);

    const archive = await backupWithBrokenDump(source);
    const staged = await stageAndInspect(archive, target);
    const failure = await rejection(runRestore(staged, target));

    expect(failure).toBeInstanceOf(PlanApplyError);
    const applyError = failure as PlanApplyError;
    expect(applyError.op).toBe("load-dump");
    expect(applyError.cause).toBeInstanceOf(RestoreLoadFailedError);
    expect((applyError.cause as Error).message).toContain("exactly as it was");

    // THE BLAST RADIUS, NAMED. destroy-schema dispatched and is NOT realised:
    // its DROPs were a preamble inside the transaction that rolled back, so
    // anything reading `dispatched` alone would report a destruction that did
    // not happen.
    expect(applyError.outcome.unrealised).toEqual(["destroy-schema"]);
    expect(applyError.outcome.dispatched - applyError.outcome.realised).toBe(1);

    // AND THE DATABASE AGREES, by exact row counts over a fresh connection.
    expect(await rowCounts(target.url)).toEqual(before);
    const still = createDatabase(target.url, 1);
    try {
      const rows = await still.db.execute<{ name: string }>(sql`SELECT name FROM companies`);
      expect(rows.map((row) => row.name)).toEqual(["Exactly Where I Started"]);
    } finally {
      await still.close();
    }
    // mail.key IS UNTOUCHED, which is why it is written after the load and not
    // before it: a replaced key over a rolled-back database would strand every
    // stored mail password, and the operator would NOT be where they started.
    expect((await readFile(target.mailKeyPath)).equals(keyBefore)).toBe(true);
  });

  // THE STATEMENT OF THE HAZARD IN ITS PUREST FORM: the destroy dispatches,
  // the load fails, and NOTHING is realised.
  itRestore("reports realised: 0 for a plan that is only the destroy and the load",
    async () => {
      const source = await makeInstall("srcpure");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstpure");
      await seed(target, ["Untouched"]);
      const before = await rowCounts(target.url);

      const archive = await backupWithBrokenDump(source);
      const staged = await stageAndInspect(archive, target);
      const destroy = effectFor(staged.plan, "destroy-schema");
      const load = effectFor(staged.plan, "load-dump");
      const minimal = newPlan<RestoreEffect>({
        kind: "restore",
        source: staged.plan.source,
        effects: [destroy, load],
      });

      const failure = await rejection(runRestore({ ...staged, plan: minimal }, target));
      const applyError = failure as PlanApplyError;
      expect(applyError.outcome.dispatched).toBe(1);
      expect(applyError.outcome.realised).toBe(0);
      expect(applyError.outcome.unrealised).toEqual(["destroy-schema"]);
      expect(await rowCounts(target.url)).toEqual(before);
    });

  // ===================================================================
  // THE DUMP THAT STOPS PART WAY THROUGH.
  //
  // psql's stdin is a pipe, and a pipe that stops is a CLEAN END OF FILE.
  // `--single-transaction` COMMITS on end of file, so a source that dies half
  // way produces exit 0 over a database whose own tables have been dropped and
  // partially replaced. Measured on the deploy target before these existed: 21
  // of 500 rows committed, the install's own table gone, exit 0.
  //
  // The cut is placed INSIDE THE COPY DATA on purpose. Every CREATE TABLE in a
  // plain pg_dump sits in the first few KB, so by then the table count and the
  // schema list are already what a successful restore would leave -- which is
  // why the proof has to be an identity and not a count.
  // ===================================================================
  itRestore("refuses to call a truncated dump a success, and says the database moved",
    async () => {
      const source = await makeInstall("srccut");
      await seed(source, ["Acme", "Globex"]);
      const target = await makeInstall("dstcut");
      await seed(target, ["Was Here"]);

      const work = await scratchDir("cut");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);
      const safetyPath = safetyPathOf(staged.plan);
      const load = effectFor(staged.plan, "load-dump");

      // CUT AFTER THE FIRST COPY BLOCK'S TERMINATOR, so the prefix is
      // PERFECTLY WELL FORMED: every statement complete, every COPY closed.
      // That is the cruel case and the one that commits -- psql reaches a clean
      // end of file with nothing to complain about, and --single-transaction
      // answers end of file with COMMIT. A cut in the middle of a row would
      // usually raise an error instead and roll back, which is the easy case
      // and proves nothing about this one.
      const dumpPath = await stagedDumpPath(target);
      const dump = await readFile(dumpPath, "utf8");
      const copyAt = dump.indexOf("\nCOPY ");
      expect(copyAt).toBeGreaterThan(0);
      const terminator = dump.indexOf("\n\\.\n", copyAt);
      expect(terminator).toBeGreaterThan(copyAt);
      const cut = terminator + 4;
      await writeFile(dumpPath, dump.slice(0, cut));
      expect(cut).toBeLessThan((load as { dumpBytes: number }).dumpBytes);

      const failure = await rejection(runRestore(staged, target));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
      const message = (cause as Error).message;
      expect(message).toContain("HALF-RESTORED");
      expect(message).toContain("reached the loader");
      expect(message).toContain(safetyPath);
      // AND NOT the sentence that would have been a lie.
      expect(message).not.toContain("exactly as it was");
      // The destroy is reported for what it is: dispatched, and NOT realised.
      expect((failure as PlanApplyError).outcome.unrealised).toEqual(["destroy-schema"]);
    });

  itRestore("refuses when the dump cannot be read at all, and names the safety backup",
    async () => {
      const source = await makeInstall("srcunread");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstunread");
      await seed(target, ["Was Here"]);

      const work = await scratchDir("unread");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);
      const safetyPath = safetyPathOf(staged.plan);

      // Readable when the plan was made, unreadable when the step runs. Only
      // the preamble reaches psql, which commits the DROP and exits 0 -- which
      // used to surface as a bare accounting error with the database empty.
      await chmod(await stagedDumpPath(target), 0o000);

      const failure = await rejection(runRestore(staged, target));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
      expect((cause as Error).message).toContain(safetyPath);
      expect(failure).toBeInstanceOf(PlanApplyError);
      // The partial outcome travels, which an unwrapped PlanExceededError
      // would not have done.
      expect((failure as PlanApplyError).outcome.unrealised).toEqual(["destroy-schema"]);
    });

  // ===================================================================
  // THE RECOVERY INSTRUCTIONS, RUN.
  //
  // THE THREE TESTS AROUND recoveryCommands ASSERT STRING CONTENTS AND THAT IS
  // NOT ENOUGH -- the commands had never been executed, and they did not work:
  // the safety backup's dump is a plain pg_dump with no --clean, so it cannot
  // load into a database that still holds its schema, which is precisely the
  // state this message is printed in. Typing the old form verbatim gave
  // `ERROR: schema "drizzle" already exists`, exit 3, and an install still
  // broken. So this one produces a real half-restored database, takes the
  // commands off the error object, and RUNS THEM.
  // ===================================================================
  itRestore("prints commands that actually put a half-restored install back", async () => {
    const source = await makeInstall("srcrecov");
    await seed(source, ["Acme", "Globex"]);
    const target = await makeInstall("dstrecov");
    await seed(target, ["The Install To Get Back"]);
    const before = await rowCounts(target.url);

    const work = await scratchDir("recov");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);

    // Half-restore it for real, by the measured route: a well-formed prefix,
    // a clean end of file, and a COMMIT.
    const dumpPath = await stagedDumpPath(target);
    const dump = await readFile(dumpPath, "utf8");
    const terminator = dump.indexOf("\n\\.\n", dump.indexOf("\nCOPY "));
    expect(terminator).toBeGreaterThan(0);
    await writeFile(dumpPath, dump.slice(0, terminator + 4));

    const failure = await rejection(runRestore(staged, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
    const commands = (cause as RestoreHalfAppliedError).recoveryCommands;
    expect(commands).toHaveLength(2);

    // THE PREMISE, CHECKED. If the database were still fine there would be
    // nothing for the recovery to do and this would pass for the wrong reason.
    expect(await rowCounts(target.url)).not.toEqual(before);

    // NOW TYPE THEM. The libpq environment stands in for the operator being on
    // the box: the printed command addresses the database by NAME, on purpose,
    // so a password never reaches a line somebody pastes into a bug report.
    const env = { ...process.env, ...libpqEnvironment(target.url) };
    for (const command of commands) {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn("bash", ["-c", command], { stdio: ["pipe", "ignore", "pipe"], env });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("close", (status) => {
          if (status !== 0) reject(new Error(`${command}\nexited ${String(status)}: ${stderr}`));
          else resolve(0);
        });
        // The 7z step prompts for the passphrase and reads it from stdin with
        // no -p, exactly as the operator would type it. The psql step ignores
        // stdin, and closing it is what stops it waiting on a terminal.
        child.stdin.end(PASSPHRASE);
      });
      expect(code).toBe(0);
    }

    // AND THE INSTALL IS BACK, by exact row counts over a fresh connection.
    expect(await rowCounts(target.url)).toEqual(before);
    const recovered = createDatabase(target.url, 1);
    try {
      const rows = await recovered.db.execute<{ name: string }>(sql`SELECT name FROM companies`);
      expect(rows.map((row) => row.name)).toEqual(["The Install To Get Back"]);
    } finally {
      await recovered.close();
    }
  });

  itRestore("is LOUD, and names the safety backup, when the rollback cannot be proved",
    async () => {
      const source = await makeInstall("srcloud");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstloud");
      await seed(target, ["Was Here"]);

      const archive = await backupWithBrokenDump(source);
      const staged = await stageAndInspect(archive, target);
      const safetyPath = safetyPathOf(staged.plan);

      // The load really fails; what is simulated is the database refusing to
      // look the way it did. See ApplyRestoreOptions.shapeOf for why this
      // branch has no other way to be reached.
      let call = 0;
      const failure = await rejection(runRestore(staged, target, {
        shapeOf: async (db) => {
          call += 1;
          const real = await describeDatabaseShape(db);
          if (call === 1) return real;
          // The same schemas and the same table COUNT, with every table
          // recreated -- which is precisely what a half-applied load leaves,
          // and precisely what a count cannot see.
          return {
            schemas: [...real.schemas],
            tables: real.tables,
            tableIds: real.tableIds.map((id) => `9${id}`),
            tableNames: [...real.tableNames],
          };
        },
      }));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
      const message = (cause as Error).message;
      expect(message).toContain("HALF-RESTORED");
      expect(message).toContain(safetyPath);
      for (const command of recoveryCommands(safetyPath, target.url, ["drizzle", "public"])) {
        expect(message).toContain(command);
      }
      // The safety backup the message names really is there and really opens.
      expect((await proveArchiveOpens(safetyPath, PASSPHRASE)).code).toBe(0);
    });

  itRestore("is loud when the database cannot be measured at all after a failure",
    async () => {
      const source = await makeInstall("srcnomeas");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstnomeas");
      const archive = await backupWithBrokenDump(source);
      const staged = await stageAndInspect(archive, target);

      let call = 0;
      const failure = await rejection(runRestore(staged, target, {
        shapeOf: async (db) => {
          call += 1;
          if (call === 1) return await describeDatabaseShape(db);
          throw new Error("the connection went away");
        },
      }));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
      expect((cause as Error).message).toContain("the connection went away");
    });

  // THE THREE MAIL-SYNC CASES THAT USED TO LIVE HERE MOVED TO
  // routes/restore.test.ts IN v1.4.1'S TASK 2, WITH THE SCOPE THEY WERE ABOUT.
  // They are named here rather than deleted quietly, because one of them --
  // "a sync that throws on the way down is still started again" -- found a real
  // bug the first time it was written and must not be lost in a move: it is
  // "starts it again when stopping it THREW, and does not restore" over there
  // now, and it asserts one thing more than it used to, since a stop that threw
  // is a stop that did not happen and the restore no longer runs after one.
  //
  // WHY THEY COULD NOT STAY: applyRestore has no sync any more. Stopping the
  // second writer became a decision -- refuse or proceed -- and a decision needs
  // the place where a refusal can still be cheap, which is above
  // `intakeSessions.use`. See this module's header.
});

// ===========================================================================
// The instruments, shown failing.
// ===========================================================================

describe("the database measurement", () => {
  itRestore("tells an intact database from one whose schema has been dropped", async () => {
    const install = await makeInstall("measure");
    const before = await describeDatabaseShape(install.handle.db);
    expect(before.schemas).toEqual(["drizzle", "public"]);
    expect(before.tables).toBeGreaterThan(0);

    await install.handle.db.execute(sql.raw("DROP SCHEMA public CASCADE"));
    const after = await describeDatabaseShape(install.handle.db);
    expect(after.schemas).toEqual(["drizzle"]);
    expect(after.tables).toBeLessThan(before.tables);
    expect(sameShape(before, after)).toBe(false);
  });
});

describe("a database that moved between the preview and the apply", () => {
  itRestore("refuses the destroy, having destroyed nothing", async () => {
    const source = await makeInstall("srcmoved");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstmoved");
    await seed(target, ["Untouched"]);
    const before = await rowCounts(target.url);

    const work = await scratchDir("moved");
    const archive = await realBackup(source, work);
    const staged = await stageAndInspect(archive, target);

    // A schema appears after the operator saw the preview. The preview said
    // two schemas would be dropped; three is a different destruction.
    await target.handle.db.execute(sql.raw('CREATE SCHEMA "appeared_later"'));

    const failure = await rejection(runRestore(staged, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreDatabaseChangedError);
    expect((cause as Error).message).toContain("appeared_later");
    // The safety backup and the blobs ran and are real; the destroy never
    // dispatched, so there is nothing unrealised and nothing destroyed.
    expect((failure as PlanApplyError).outcome.dispatched).toBe(2);
    expect((failure as PlanApplyError).outcome.realised).toBe(2);
    expect((failure as PlanApplyError).outcome.unrealised).toEqual([]);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  /**
   * A TABLE, NOT A SCHEMA, AND THE GUARD USED TO WAVE IT THROUGH.
   *
   * The re-measure compared the schema list only, while the sentence the
   * operator read said how many TABLES would be dropped. Measured before the
   * repair: the preview said "27 table(s) across 2 schema(s)", the database
   * held 28 at apply time, the extra table was DESTROYED, and the answer was
   * 200. Narrow to reach and it is the one effect marked `destroys: true`.
   */
  itRestore("refuses a table that appeared after the preview, having destroyed nothing",
    async () => {
      const source = await makeInstall("srctable");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dsttable");
      await seed(target, ["Untouched"]);
      const before = await rowCounts(target.url);

      const work = await scratchDir("movedtable");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);

      // No new SCHEMA -- the coarser check must stay satisfied, or this case
      // would pass on the guard it is not testing.
      await target.handle.db.execute(sql.raw('CREATE TABLE public."late_arrival" (id integer)'));

      const failure = await rejection(runRestore(staged, target));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreDatabaseChangedError);
      // IT NAMES THE TABLE. "It said 27 and there are 28" sends an operator
      // through the whole schema.
      expect((cause as Error).message).toContain("late_arrival");
      expect((cause as Error).message).toContain("added");
      expect((failure as PlanApplyError).outcome.unrealised).toEqual([]);
      // NOTHING WAS DESTROYED, the newcomer included.
      expect(await rowCounts(target.url)).toEqual({ ...before, late_arrival: 0 });
    });
});

describe("what the preview says is about to be destroyed", () => {
  /**
   * THE SPEC'S GUARD REQUIREMENT, WHICH NOTHING IMPLEMENTED UNTIL 7.7's
   * CORRECTION ROUND: "a plain statement of what is about to be destroyed --
   * ROW COUNTS FROM THE LIVE DATABASE, so the operator sees what they are
   * replacing rather than an abstraction". `inspectRestore` measured only
   * schemas and a table count, which is the abstraction that sentence refuses.
   */
  itRestore("counts the live rows, and says the number in the sentence a person reads",
    async () => {
      const source = await makeInstall("srcrows");
      const target = await makeInstall("dstrows");
      await seed(target, ["One", "Two", "Three"]);
      const work = await scratchDir("rows");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);
      try {
        const destroy = effectFor(staged.plan, "destroy-schema") as { rows: number };
        // MEASURED WITH THE SAME FUNCTION services/backup.ts USES, so the number
        // under the confirmation and the number an archive records cannot drift
        // into meaning different things.
        const live = await measureInventory(target.handle.db);
        const total = live.reduce((sum, one) => sum + one.rows, 0);
        expect(total).toBeGreaterThan(0);
        expect(destroy.rows).toBe(total);
        // AND IT REACHES THE OPERATOR. A number on an effect nobody renders is
        // not a statement of what is about to be destroyed.
        expect(effectFor(staged.plan, "destroy-schema").detail)
          .toContain(`${String(total)} row(s)`);
      } finally {
        await staged.payload.dispose();
      }
    });
});

describe("the plan the operator is shown", () => {
  itRestore("says what is destroyed, and the load is not one of those things", async () => {
    const source = await makeInstall("srcshown");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstshown");
    const work = await scratchDir("shown");
    const archive = await realBackup(source, work);
    const { plan } = await stageAndInspect(archive, target);

    const destructive = plan.effects.filter((effect) => effect.destroys).map((e) => e.op);
    expect(destructive).toEqual(["destroy-schema", "replace-mail-key"]);
    // ORDER IS THE DESIGN: the safety backup first, blobs before the database,
    // and mail.key AFTER it -- see restore.ts's header for why the last of
    // those is the other way round from the spec's numbered list.
    expect(plan.effects.map((effect) => effect.op)).toEqual([
      "safety-backup", "write-blobs", "destroy-schema", "load-dump", "replace-mail-key",
    ]);
    // AND THE PREPARATION NAMES ITS CONSUMER, which is what makes the outcome
    // able to tell dispatched from realised.
    expect(effectFor(plan, "destroy-schema").realisedBy).toBe("load-dump");
    expect(plan.findings.map((f) => f.code)).toContain(RESTORE_FINDINGS.mailSyncPauses);
  });

  itRestore("cannot be edited between the preview and the apply", async () => {
    const source = await makeInstall("srcfrozen");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstfrozen");
    const work = await scratchDir("frozen");
    const archive = await realBackup(source, work);
    const { plan } = await stageAndInspect(archive, target);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.effects)).toBe(true);
    expect(Object.isFrozen(effectFor(plan, "destroy-schema"))).toBe(true);
    // THE SPINE FREEZES `sources` AND NOTHING IT DOES NOT KNOW ABOUT. `schemas`
    // is restore's own array on restore's own effect, so restore has to freeze
    // it -- otherwise a caller still holding the array it passed in could add a
    // schema to the destruction after the preview had been rendered.
    const destroy = effectFor(plan, "destroy-schema") as { schemas: readonly string[] };
    expect(Object.isFrozen(destroy.schemas)).toBe(true);
    // AND THE INVENTORY, for the same reason and one level deeper. Object.freeze
    // is shallow, so a frozen list of live objects is a list whose row counts a
    // caller could still edit after the preview was rendered -- which is the
    // preview lying about the check it promised.
    const load = effectFor(plan, "load-dump") as {
      inventory: readonly { rows: number }[] | null;
    };
    if (load.inventory === null) throw new Error("the plan carried no inventory to freeze");
    expect(Object.isFrozen(load.inventory)).toBe(true);
    expect(Object.isFrozen(load.inventory[0])).toBe(true);
  });
});

describe("apply cannot exceed the plan", () => {
  itRestore("throws when the tables that arrived are not the tables the plan promised",
    async () => {
      const source = await makeInstall("srccount");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstcount");
      const work = await scratchDir("count");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);
      const targetKeyBefore = await readFile(target.mailKeyPath);

      // The plan's count is what the dump itself says it will create. An
      // effect claiming one more table than the dump has is the shape a load
      // that silently did less would produce -- and it is the shape a psql
      // reporting exit 0 over a rolled-back load would produce too.
      const load = effectFor(staged.plan, "load-dump");
      const edited = newPlan<RestoreEffect>({
        kind: "restore",
        source: staged.plan.source,
        effects: staged.plan.effects.map((effect) => effect.op === "load-dump"
          ? { ...load, count: load.count + 1 } as RestoreEffect
          : effect),
      });

      const failure = await rejection(runRestore({ ...staged, plan: edited }, target));
      // NOT a PlanExceededError, and that is the repair. The database has just
      // been replaced; the frame's accounting error would travel unwrapped,
      // name no safety backup, and tell the operator "the plan said otherwise"
      // about a restore that HAS HAPPENED.
      expect(failure).not.toBeInstanceOf(PlanExceededError);
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreUnexpectedResultError);
      const message = (cause as Error).message;
      // THE NUMBER IS THE ONE THAT WAS MEASURED, not the one the exit code
      // implied: the load committed, the tables were counted, and the count did
      // not match what the plan published.
      expect(message).toContain(`said ${String(load.count + 1)} table(s)`);
      expect(message).toContain(`now holds ${String(load.count)}`);
      expect(message).toContain("has HAPPENED");
      expect(message).toContain(safetyPathOf(staged.plan));
      // AND IT SAYS mail.key WAS NOT REPLACED, which this message did not until
      // 7.7's routes task and RestoreInventoryMismatchError's already did. Both
      // throw from the LOAD handler, so the key step and the migrations never
      // run: telling an operator "the restore has HAPPENED" without that leaves
      // them hunting a mail connection bug that points nowhere near the cause.
      expect(message).toContain("mail.key was NOT replaced");
      expect((await readFile(target.mailKeyPath)).equals(targetKeyBefore)).toBe(true);
      // And the partial outcome travels with it.
      expect((failure as PlanApplyError).outcome.unrealised).toEqual(["destroy-schema"]);
    });

  // THE RESULT CHECK IS ABOUT NAMES AND NOT A TALLY, and this is what says so:
  // the plan is edited to expect a table that will never arrive while the COUNT
  // stays exactly right. A tally is satisfied by any twenty-seven tables.
  itRestore("notices a table that did not arrive even when the count is right",
    async () => {
      const source = await makeInstall("srcnames");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstnames");
      const work = await scratchDir("names");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);

      const load = effectFor(staged.plan, "load-dump") as RestoreEffect & {
        tables: readonly string[];
      };
      const swapped = [...load.tables.slice(0, -1), "public.a_table_the_dump_never_creates"];
      expect(swapped).toHaveLength(load.tables.length);
      const edited = newPlan<RestoreEffect>({
        kind: "restore",
        source: staged.plan.source,
        effects: staged.plan.effects.map((effect) => effect.op === "load-dump"
          ? { ...load, tables: swapped } as RestoreEffect
          : effect),
      });

      const failure = await rejection(runRestore({ ...staged, plan: edited }, target));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreUnexpectedResultError);
      const message = (cause as Error).message;
      expect(message).toContain("a_table_the_dump_never_creates");
      expect(message).toContain("not there at all");
      expect(message).toContain("has HAPPENED");
    });

  itRestore("gives each step reading rights over exactly the members it needs",
    async () => {
      const source = await makeInstall("srcread");
      await seed(source, ["Acme"]);
      const target = await makeInstall("dstread");
      const work = await scratchDir("read");
      const archive = await realBackup(source, work);
      const staged = await stageAndInspect(archive, target);

      // MECHANISM 2 OF THE SPINE, AS RESTORE USES IT. A handler can read only
      // the members its own effect published, so what each effect names IS its
      // reading rights -- and the load step, which runs a child process over
      // whatever it is handed, must name the dump and nothing else.
      const named = (op: RestoreEffect["op"]): string[] =>
        (effectFor(staged.plan, op).sources ?? []).map((ref) => ref.id).sort();

      expect(named("load-dump")).toEqual(["database.sql"]);
      expect(named("replace-mail-key")).toEqual(["mail.key"]);
      expect(named("safety-backup")).toEqual([]);
      expect(named("destroy-schema")).toEqual([]);
      for (const name of named("write-blobs")) expect(name.startsWith("files/")).toBe(true);
      // Nothing may read the manifest: it was inspect's business, and inspect
      // has already turned everything it said into the plan itself.
      const everything = staged.plan.effects.flatMap((e) => (e.sources ?? []).map((r) => r.id));
      expect(everything).not.toContain("manifest.json");

      const outcome = await runRestore(staged, target);
      expect(outcome.opened).toContain("database.sql");
      expect(outcome.opened).not.toContain("manifest.json");
    });
});

// ===========================================================================
// THE RESULT AGAINST THE INVENTORY -- the fifth instrument, and the only one
// whose witness is not the dump the load consumed.
//
// The block above proves the result matches what `database.sql` DECLARED. That
// can only ever catch a load that diverged from its own file; it is blind to a
// backup that was already wrong when it was written, because the file it checks
// against is the file it loaded. These check the result against what
// manifest.json says the database HELD.
// ===========================================================================

describe("the inventory the backup records", () => {
  // ONE DEFINITION OF "A TABLE", ACROSS TWO MODULES. measureInventory reads the
  // catalogue for services/backup.ts and describeDatabaseShape reads it for the
  // failure path; if their predicates ever drift, a perfectly good restore
  // reports a table present in one list and missing from the other.
  it("agrees with the database measurement about what a table is", async () => {
    const install = await makeInstall("invsame");
    const inventory = await measureInventory(install.handle.db);
    const shape = await describeDatabaseShape(install.handle.db);
    expect(inventory.map((one) => one.table)).toEqual([...shape.tableNames].sort());
    expect(inventory.length).toBe(shape.tables);
  });

  // BACKWARD COMPATIBILITY, AND IT IS A REQUIREMENT RATHER THAN A COURTESY.
  // Chris has v1.3.0 backups on disk. A restore that refused them would be
  // worse than the gap the inventory closes.
  itRestore("restores a backup that records none, with the check reported as NOT MADE",
    async () => {
      const source = await makeInstall("srcnoinv");
      await seed(source, ["Acme", "Globex"]);
      const sourceCounts = await rowCounts(source.url);
      const target = await makeInstall("dstnoinv");

      // A v1.3.0-era archive: the key is not in the manifest at all. Composed
      // from a real backup rather than hand-built, so everything else about it
      // is exactly what services/backup.ts writes.
      const archive = await alteredBackup(source, async (_dir, manifest) => {
        const older = { ...manifest };
        delete older.inventory;
        return older;
      });

      const staged = await stageAndInspect(archive, target);
      expect(staged.plan.refusal).toBeNull();
      const finding = staged.plan.findings
        .find((f) => f.code === RESTORE_FINDINGS.inventoryMissing);
      // A WARNING, NOT A NOTE. A safety check that will not be made is
      // something to weigh before replacing an install.
      expect(finding?.severity).toBe("warning");
      expect(finding?.message).toContain("does not record what its database held");
      // NULL ON THE EFFECT, never an empty list standing in for it.
      const load = effectFor(staged.plan, "load-dump") as RestoreEffect & {
        inventory: readonly unknown[] | null;
      };
      expect(load.inventory).toBeNull();
      expect(load.detail).toContain("records no row counts");

      const outcome = await runRestore(staged, target);
      expect(outcome.realised).toBe(outcome.dispatched);
      expect(outcome.unrealised).toEqual([]);
      expect(await rowCounts(target.url)).toEqual(sourceCounts);
    });

  // "ABSENT" AND "AN INVENTORY OF NOTHING" ARE DIFFERENT MANIFESTS, and this is
  // the pair that proves this code treats them differently. The test above
  // removes the key and the restore succeeds; this one leaves the key with an
  // empty list, which is a positive claim that the database held no tables --
  // and the restored database holds all of them, so it fails.
  itRestore("checks an inventory of nothing rather than skipping it", async () => {
    const source = await makeInstall("srcemptyinv");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstemptyinv");

    const archive = await alteredBackup(source, async (_dir, manifest) => ({
      ...manifest,
      inventory: { consistency: "shared-snapshot", tables: [] },
    }));

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();
    // No "not made" finding: a claim WAS made, and it will be checked.
    expect(staged.plan.findings.map((f) => f.code))
      .not.toContain(RESTORE_FINDINGS.inventoryMissing);

    const failure = await rejection(runRestore(staged, target));
    const cause = (failure as PlanApplyError).cause;
    expect(cause).toBeInstanceOf(RestoreInventoryMismatchError);
    expect((cause as Error).message).toContain("the backup does not list it");
  });

  // THE MISMATCH, WITH THE SAME WEIGHT AS EVERY OTHER POST-COMMIT FAILURE.
  itRestore("reports a disagreement, names the safety backup and prints the way back",
    async () => {
      const source = await makeInstall("srcbadinv");
      await seed(source, ["Acme", "Globex", "Initech"]);
      const target = await makeInstall("dstbadinv");
      const targetKeyBefore = await readFile(target.mailKeyPath);

      // The backup claims seven more companies than its own dump carries --
      // which is what an archive that was already wrong when it was written
      // looks like from the restore's side.
      const archive = await alteredBackup(source, async (_dir, manifest) => {
        const inventory = manifest.inventory;
        if (inventory === undefined) throw new Error("the real backup carried no inventory");
        return {
          ...manifest,
          inventory: {
            ...inventory,
            tables: inventory.tables.map((one) => one.table === "public.companies"
              ? { ...one, rows: one.rows + 7 } : one),
          },
        };
      });

      const staged = await stageAndInspect(archive, target);
      expect(staged.plan.refusal).toBeNull();

      const failure = await rejection(runRestore(staged, target));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreInventoryMismatchError);
      // WHICH LAYER FIRED. The result matched the tables the DUMP declared --
      // the fourth instrument passed -- and only the comparison against the
      // backup's own record of the database caught this. Two checks that could
      // not be told apart would be one check with a spare.
      expect(cause).not.toBeInstanceOf(RestoreUnexpectedResultError);

      const message = (cause as Error).message;
      expect(message).toContain("public.companies: the backup recorded 10 row(s)");
      expect(message).toContain("this database holds 3");
      expect(message).toContain("has HAPPENED");
      // THE SAFETY BACKUP AND THE COMMANDS, exactly as RestoreHalfAppliedError
      // gives them: the person reading this has an install they cannot trust.
      expect(message).toContain(safetyPathOf(staged.plan));
      expect(message).toContain("7z x -o");
      expect(message).toContain("--single-transaction");
      expect((await stat(safetyPathOf(staged.plan))).isFile()).toBe(true);

      // AND THE PLAN STOPPED. mail.key is not replaced, so a suspect restore is
      // not followed by an irreversible key swap.
      expect((await readFile(target.mailKeyPath)).equals(targetKeyBefore)).toBe(true);
      expect(message).toContain("mail.key was NOT replaced");
      expect((failure as PlanApplyError).outcome.unrealised).toEqual(["destroy-schema"]);
    });

  // AN INVENTORY THAT CANNOT BE READ IS REFUSED, WITH NOTHING WRITTEN. Ignoring
  // it would be a restore whose safety check silently did not happen, which is
  // the shape of every silent half-restore this module has had.
  itRestore("refuses an unreadable inventory before anything is destroyed", async () => {
    const source = await makeInstall("srcbrokeninv");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstbrokeninv");
    await seed(target, ["Still Here Ltd"]);
    const before = await rowCounts(target.url);

    const archive = await alteredBackup(source, async (_dir, manifest) => ({
      ...manifest,
      inventory: { consistency: "shared-snapshot", tables: [{ table: "public.companies" }] },
    } as unknown as BackupManifest));

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal?.code).toBe(RESTORE_REFUSALS.inventoryUnreadable);
    expect(staged.plan.refusal?.message).toContain("whole number of rows");
    // A REFUSAL IS A PLAN WITH NO EFFECTS. Nothing was destroyed and nothing
    // can be: applying it is refused by the frame.
    expect(staged.plan.effects).toEqual([]);
    await expect(runRestore(staged, target)).rejects.toBeInstanceOf(PlanRefusedError);
    expect(await rowCounts(target.url)).toEqual(before);
  });

  // A LABEL THIS BUILD CANNOT EVALUATE, AT THE ARCHIVE RATHER THAN AT THE
  // VALUE, AND IT NO LONGER REFUSES -- Chris's decision 1, end to end. v1.4.0
  // stopped here with `inventoryUnreadable`; the counts might be perfectly good
  // and the archive is somebody's only backup, so it is restored with the
  // cross-check reported as NOT MADE.
  //
  // THE WORDS ARE PART OF THE DECISION AND ARE ASSERTED AS SUCH. "Degrades
  // silently" and "degrades" differ by exactly this finding, and a restore that
  // skipped a check without saying so would be the silent pass every other
  // instrument in this module exists to prevent.
  itRestore("restores an inventory whose consistency it cannot check, and says so", async () => {
    const source = await makeInstall("srcunkinv");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstunkinv");
    await seed(target, ["Replaced Ltd"]);

    const archive = await alteredBackup(source, async (_dir, manifest) => {
      const inventory = manifest.inventory;
      if (inventory === undefined) throw new Error("the real backup carried no inventory");
      return { ...manifest, inventory: { ...inventory, consistency: "best-effort" } };
    });

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.refusal).toBeNull();
    const finding = staged.plan.findings
      .find((one) => one.code === RESTORE_FINDINGS.inventoryUncheckable);
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("CANNOT BE MADE");
    expect(finding?.message).toContain("best-effort");
    // NOT the older-backup sentence: this archive is NEWER than this build, and
    // sending its owner looking for an upgrade rather than a downgrade is the
    // whole reason the two findings are separate codes.
    expect(staged.plan.findings.map((one) => one.code))
      .not.toContain(RESTORE_FINDINGS.inventoryMissing);

    // The check is not merely unreported -- it is not made. A load-dump effect
    // carrying the counts would compare them.
    const load = effectFor(staged.plan, "load-dump") as RestoreEffect & {
      inventory: readonly { table: string; rows: number }[] | null;
    };
    expect(load.inventory).toBeNull();
    expect(load.detail).toContain("cannot check");

    // AND IT REALLY RESTORES. The point of the decision is the recovery that
    // now happens, not the finding that describes it.
    const sourceCounts = await rowCounts(source.url);
    const outcome = await runRestore(staged, target);
    expect(outcome.realised).toBe(outcome.dispatched);
    expect(outcome.unrealised).toEqual([]);
    expect(await rowCounts(target.url)).toEqual(sourceCounts);
  });

  // THE ORDINARY CASE, SAID OUT LOUD: a real backup restored onto a different
  // install passes the inventory check, and the check was really made rather
  // than skipped. Without this the whole block could be green over a comparison
  // that never runs.
  itRestore("passes on a real backup, and the check was actually made", async () => {
    const source = await makeInstall("srcgoodinv");
    await seed(source, ["Acme", "Globex"]);
    const target = await makeInstall("dstgoodinv");
    const archive = await realBackup(source, await scratchDir("goodinv"));

    const staged = await stageAndInspect(archive, target);
    expect(staged.plan.findings.map((f) => f.code))
      .not.toContain(RESTORE_FINDINGS.inventoryMissing);
    const load = effectFor(staged.plan, "load-dump") as RestoreEffect & {
      inventory: readonly { table: string; rows: number }[] | null;
    };
    if (load.inventory === null) throw new Error("the plan carried no inventory to check");
    // The plan really carries the source's own numbers, and says so to the
    // operator before anything runs.
    const companies = load.inventory.find((one) => one.table === "public.companies");
    expect(companies?.rows).toBe(2);
    expect(load.detail).toContain("row(s) its database held");

    const outcome = await runRestore(staged, target);
    expect(outcome.realised).toBe(outcome.dispatched);
    // And the restored database really does hold what the backup recorded.
    const restored = createDatabase(target.url, 1);
    try {
      expect(await measureInventory(restored.db)).toEqual([...load.inventory]);
    } finally {
      await restored.close();
    }
  });
});
