import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, migrationsFolder, runMigrations, type DatabaseHandle } from "../db/client.js";
import { openTestDatabase } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { digestOf, HAVE_7Z } from "../test/archives.js";
import { resolveUser } from "../users.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { createCompany } from "./companies.js";
import { buildBackup, pgDumpVersion, type BackupManifest } from "./backup.js";
import {
  decryptCredentials, encryptCredentials, forgetMailKey, loadMailKey,
} from "./mail-crypto.js";
import { readMigrationJournal } from "./migration-journal.js";
import { receiveIntake, stageArchive, type StagedPayload } from "./intake.js";
import { newPlan, PlanApplyError, PlanExceededError, PlanRefusedError } from "./intake-plan.js";
import {
  applyRestore, compareAppVersions, countDumpTables, describeDatabaseShape, inspectRestore,
  proveArchiveOpens, psqlLoadArgs, psqlVersion, recoveryCommands, sameShape,
  RESTORE_FINDINGS, RESTORE_REFUSALS,
  RestoreDatabaseChangedError, RestoreHalfAppliedError, RestoreLoadFailedError,
  RestoreSafetyBackupError,
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
/** Every scratch database this file makes. Also what the boot sweep matches. */
const SCRATCH_PREFIX = "conduit_restore_";
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
// impossible to see. Nothing else in this repository creates this prefix.
beforeAll(async () => {
  const stale = await control.db.execute<{ datname: string }>(sql`
    SELECT datname FROM pg_database WHERE datname LIKE ${`${SCRATCH_PREFIX}%`}
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
  const url = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${name}`);
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

describe("counting the tables a dump creates", () => {
  it("counts CREATE TABLE statements", () => {
    const state = { inCopy: false };
    expect(countDumpTables("CREATE TABLE public.companies (", state)).toBe(1);
    expect(countDumpTables("CREATE UNLOGGED TABLE public.scratch (", state)).toBe(1);
    expect(countDumpTables("    CREATE TABLE indented (", state)).toBe(0);
    expect(countDumpTables("-- CREATE TABLE commented (", state)).toBe(0);
  });

  // THE ONE THAT MATTERS, and it is the operator's own text doing it. A note
  // body or a company name whose value begins a line inside a COPY block is
  // not SQL, and a counter that did not know that would inflate the load
  // step's budget by however many times a customer wrote those two words.
  it("does not count CREATE TABLE inside COPY data, and resumes after it", () => {
    const state = { inCopy: false };
    expect(countDumpTables("COPY public.notes (id, body) FROM stdin;", state)).toBe(0);
    expect(state.inCopy).toBe(true);
    expect(countDumpTables("CREATE TABLE this is a note body, not SQL", state)).toBe(0);
    expect(countDumpTables("CREATE TABLE so is this", state)).toBe(0);
    expect(countDumpTables("\\.", state)).toBe(0);
    expect(state.inCopy).toBe(false);
    expect(countDumpTables("CREATE TABLE public.deals (", state)).toBe(1);
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
  it("is sensitive to the schema list and to the table count", () => {
    const base: DatabaseShape = { schemas: ["drizzle", "public"], tables: 27 };
    expect(sameShape(base, { schemas: ["drizzle", "public"], tables: 27 })).toBe(true);
    expect(sameShape(base, { schemas: ["drizzle", "public"], tables: 26 })).toBe(false);
    expect(sameShape(base, { schemas: ["public"], tables: 27 })).toBe(false);
    expect(sameShape(base, { schemas: ["public", "drizzle"], tables: 27 })).toBe(false);
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

    const stops: string[] = [];
    const outcome = await runRestore(staged, target, {
      sync: {
        stop: async () => { stops.push("stop"); },
        start: async () => { stops.push("start"); },
      },
    });

    // EVERY EFFECT DISPATCHED AND EVERY EFFECT REALISED. On a plan that ran to
    // the end these are equal, because the executor refuses a plan whose
    // preparation has no consumer.
    expect(outcome.dispatched).toBe(staged.plan.effects.length);
    expect(outcome.realised).toBe(outcome.dispatched);
    expect(outcome.unrealised).toEqual([]);
    expect(stops).toEqual(["stop", "start"]);

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
    expect(failure).toBeInstanceOf(PlanExceededError);
    expect((failure as PlanExceededError).op).toBe("migrate-forward");
    expect(failure.message).toContain(`accounted for ${String(forward.count)}`);
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

describe("the safety backup", () => {
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
          return call === 1 ? real : { schemas: [...real.schemas], tables: real.tables - 1 };
        },
      }));
      const cause = (failure as PlanApplyError).cause;
      expect(cause).toBeInstanceOf(RestoreHalfAppliedError);
      const message = (cause as Error).message;
      expect(message).toContain("HALF-RESTORED");
      expect(message).toContain(safetyPath);
      for (const command of recoveryCommands(safetyPath, target.url)) {
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

  itRestore("restarts the mail sync even when the restore fails", async () => {
    const source = await makeInstall("srcsync");
    await seed(source, ["Acme"]);
    const target = await makeInstall("dstsync");
    const archive = await backupWithBrokenDump(source);
    const staged = await stageAndInspect(archive, target);

    const events: string[] = [];
    await rejection(runRestore(staged, target, {
      sync: {
        stop: async () => { events.push("stop"); },
        start: async () => { events.push("start"); },
      },
    }));
    expect(events).toEqual(["stop", "start"]);
  });
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
      expect(failure).toBeInstanceOf(PlanExceededError);
      expect((failure as PlanExceededError).op).toBe("load-dump");
      // AND THE NUMBER IN THE MESSAGE IS THE ONE THAT WAS MEASURED, not the one
      // the exit code implied: the load succeeded, the tables were counted, and
      // the count did not match what the plan published.
      expect(failure.message).toContain(`described ${String(load.count + 1)}`);
      expect(failure.message).toContain(`accounted for ${String(load.count)}`);
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
