import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "drizzle-orm";
import type { PlanFindingView, PlanRefusalView } from "@conduit/shared";
import { createDatabase, runMigrations, type Database } from "../db/client.js";
import {
  buildBackup, freeSpaceBytes, libpqEnvironment, majorVersion, sevenZipVersion,
  BACKUP_FORMAT_VERSION, DISK_MARGIN_BYTES, PG_DUMP_PACKAGE, SEVEN_ZIP_PACKAGE,
  type BackupManifest,
} from "./backup.js";
import { forgetMailKey } from "./mail-crypto.js";
import { readMigrationJournal } from "./migration-journal.js";
import {
  applyPlan, newPlan, planSource,
  type ApplyOutcome, type EffectHandlers, type Plan, type PlannedEffect,
} from "./intake-plan.js";
import type { IntakeFile, StagedPayload } from "./intake.js";

// RESTORE'S APPLY STEP. THE MOST DANGEROUS CODE IN THE PRODUCT.
//
// services/intake.ts landed and unpacked the archive; services/intake-plan.ts
// owns the plan and the frame apply runs in. What is left is the half that
// destroys the operator's database on purpose, and every decision below is
// about the two ways that goes wrong: destroying more than was previewed, and
// -- worse -- REPORTING a destruction differently from how it happened.
//
// ================ THE PSQL MATRIX, MEASURED, NOT INFERRED ==================
//
// The dump CANNOT be loaded through the database driver. A plain pg_dump
// carries `\restrict`, `\unrestrict` and the `\.` COPY terminator, all of them
// psql META-COMMANDS that no libpq client understands. Measured against a real
// dump of conduit_test on the deploy target: 2 restrict/unrestrict lines and 1
// COPY terminator in a 68KB dump of 27 tables. psql is a REQUIREMENT, not a
// convenience.
//
// And psql has exactly one honest configuration. Measured on the deploy target
// (PostgreSQL 15.19, Debian 12) with a real plain pg_dump and a deliberate
// error appended AFTER the COPY data, loading over a target that already held
// rows, and re-measured with the script arriving on STDIN as this module sends
// it -- identical both ways:
//
//   flags                                 exit   what the database actually held
//   ------------------------------------  -----  ------------------------------
//   --single-transaction + ON_ERROR_STOP      3  rolled back. HONEST.
//   --single-transaction alone                0  rolled back -- SUCCESS REPORTED
//                                                FOR A FAILED LOAD
//   ON_ERROR_STOP alone                       3  half-applied
//   neither                                   0  half-applied
//
// Only the first cell is both safe and truthful, and the second is the trap:
// an exit code of 0 over a database that kept its old contents. THAT IS WHY
// THE POST-LOAD STATE IS MEASURED RATHER THAN INFERRED FROM AN EXIT CODE --
// see loadDump, which counts the tables that actually exist and accounts for
// them against the number the plan published. Never pg_stat_user_tables: its
// estimates read identically before and after a full replacement.
//
// ================ THE ATOMIC ACT THE OPERATOR SEES AS TWO ==================
//
// Destroy-schema and load-dump are ONE psql transaction. The operator has to
// see two things -- what is destroyed, and what replaces it -- so the destroy
// step leaves its `DROP SCHEMA ... CREATE SCHEMA` preamble on the carrier and
// the load step runs psql over the preamble and the dump together. The
// atomicity lives inside the child process, which is the only place it can.
//
// THE REPORTING HAZARD THAT FOLLOWS IS THE ONE THING THIS MODULE MUST NOT GET
// WRONG. If the load throws, destroy-schema has already dispatched and already
// accounted -- so anything reading `dispatched` reports a destruction the
// transaction rolled back. `realisedBy` is what stops that: the executor
// refuses a plan whose preparation has no later consumer, and ApplyOutcome
// separates `dispatched` from `realised` and lists `unrealised`. A failed load
// leaves destroy-schema DISPATCHED AND UNREALISED, which is the truth.
//
// ====================== THE ORDER, AND WHY IT IS THIS ONE ==================
//
// blobs -> DATABASE -> mail.key -> migrations. Three documents prescribe three
// different orders, so the reasoning is written down rather than the citation.
//
//   the spec's numbered sequence ... dump, blobs, mail.key
//   the spec's failure analysis .... "database LAST, so a crash mid-blob leaves
//                                    a consistent database referencing files
//                                    that exist"
//   this task's brief ............. blobs, mail.key, database LAST
//
// THE BLOBS GO FIRST, which is the spec's failure analysis over its own
// numbered list. Blobs are content-addressed and immutable, so writing them is
// additive, idempotent and re-runnable: a load that rolls back afterwards
// leaves nothing worse than some unreferenced files, which is exactly what an
// interrupted upload already leaves. Writing them after the load would instead
// leave a restored database referencing files that are not there yet.
//
// mail.key GOES AFTER THE DATABASE, which is the brief's order refused and the
// spec's own position kept. mail.key is not additive -- it is a REPLACEMENT --
// and a replaced key over a database that rolled back strands every stored mail
// password under a key that is no longer on disk. That is precisely the state
// the rollback exists to prevent: the operator would NOT be where they started,
// which is the promise the whole failure path is built to keep. Putting it
// before the load places an irreversible act inside the blast radius of a
// rollback, and nothing is bought by it. It is written to a sibling temp file
// and renamed into place, so there is no instant at which it is neither key.
//
// THE MAIL SYNC IS STOPPED BEFORE THE SAFETY BACKUP, not after it as the spec
// numbers it. The sync is the second writer -- the one that can change the
// database with nobody touching a browser -- and a safety backup taken while it
// runs is an undo to a state that stopped being true a moment later. pg_dump's
// snapshot is internally consistent either way; what moves is everything the
// sync writes between the snapshot and the destruction, which the undo loses.
//
// ==================== WHAT IS NOT AN EFFECT, AND WHY =======================
//
// STOPPING AND RESTARTING THE SYNC IS A SCOPE, NOT AN EFFECT, for the same
// reason the transaction is not one: an effect that fails mid-plan is never
// undone, and a sync left stopped by a failed restore is an install that
// silently receives no mail. It is a `try/finally` around applyPlan, and the
// operator is told about it through a plan FINDING rather than through an
// effect that could be skipped.
//
// ======================= WHAT THE ROUTES TASK MUST ADD =====================
//
// Re-authentication and the typed install name are the guard, and they are not
// here: this module applies a plan somebody else decided to apply. The routes
// task owns both, owns binding a plan to the operator who uploaded it (see
// IntakeSession's own note), and owns calling sweepAbandonedIntakes at boot.
//
// A MIGRATION CANNOT HELP ANY OF THIS. Restore bookkeeping cannot live in a
// database the restore replaces: a row written before the destruction is
// dropped with the schema, and one written after is written by a build whose
// migrations may not have run yet. Everything this module remembers, it
// remembers on the filesystem or in the process.

/** The apt package that provides psql. The same one that provides pg_dump. */
export const PSQL_PACKAGE = PG_DUMP_PACKAGE;

/** 8KB of a child's stderr: enough to diagnose it, short enough to log. */
const STDERR_CAP_BYTES = 8 * 1024;

/** The archive members a backup must carry, by name. */
const DUMP_MEMBER = "database.sql";
const MANIFEST_MEMBER = "manifest.json";
const MAIL_KEY_MEMBER = "mail.key";
/** Everything under here is a blob. Content-addressed, immutable, additive. */
const BLOB_PREFIX = "files/";

/**
 * Every reason a restore refuses, as codes a test can assert without matching
 * prose.
 *
 * A REFUSAL IS A PLAN WITH NO EFFECTS -- see newPlan. Every one of these is
 * reached with nothing written and nothing destroyed, which is the whole
 * argument for inspect producing a value rather than doing work.
 */
export const RESTORE_REFUSALS = {
  /** psql is not installed, so the dump could not be loaded even if it were valid. */
  psqlMissing: "psql-missing",
  /** 7z is not installed, so the safety backup could not be taken. */
  sevenZipMissing: "7z-missing",
  /** No manifest.json in the archive. */
  manifestMissing: "manifest-missing",
  /** manifest.json is not JSON, or not a manifest. */
  manifestUnreadable: "manifest-unreadable",
  /** An export, not a backup. Restoring an export would lose mail and credentials. */
  notABackup: "not-a-backup",
  /** A layout version this build does not know how to read. */
  formatUnknown: "format-unknown",
  /** The backup was taken by a NEWER Conduit than this one. */
  newerApp: "newer-app",
  /** The backup's schema is ahead of this build's migrations. */
  newerSchema: "newer-schema",
  /** The dump came from a newer PostgreSQL major than this server. */
  newerServer: "newer-server",
  /** A member the manifest lists is not in the archive. */
  memberMissing: "member-missing",
  /** A member's bytes do not match the digest the manifest recorded. */
  memberCorrupt: "member-corrupt",
} as const;

/** Findings a restore plan can carry. Notes and warnings; never refusals. */
export const RESTORE_FINDINGS = {
  /** Extra files/ members the manifest does not list. EXTRA, NOT DAMAGE. */
  extraBlobs: "extra-blobs",
  /** A member outside files/ that the manifest does not list. Ignored. */
  unexpectedMember: "unexpected-member",
  /** The backup's mail.key differs from this install's. */
  mailKeyReplaced: "mail-key-replaced",
  /** The mail sync stops for the duration of the restore. */
  mailSyncPauses: "mail-sync-pauses",
  /** The process should be restarted once the restore finishes. */
  restartRequired: "restart-required",
  /** The backup's schema is older and will be migrated forward. */
  olderSchema: "older-schema",
} as const;

/** A tool the restore needs is not installed. The message names the package. */
export class RestoreToolMissingError extends Error {
  constructor(readonly tool: string, readonly aptPackage: string) {
    super(`${tool} is not available; install the ${aptPackage} package and try again`);
    this.name = "RestoreToolMissingError";
  }
}

/**
 * The safety backup could not be taken, or could not be opened once taken.
 *
 * THE RESTORE DOES NOT START. The safety backup is the only thing standing
 * between a broken restore and an operator with nothing, and it is only real
 * if it is PROVED before the destructive step rather than trusted after it.
 */
export class RestoreSafetyBackupError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "RestoreSafetyBackupError";
  }
}

/**
 * The world moved between the preview and the apply.
 *
 * A PLAN IS A SNAPSHOT, NOT A LEASE -- services/intake-plan.ts says so, and
 * this is restore deciding that for the destructive effect it is not good
 * enough. The schema list is re-measured at apply time and must be the one the
 * operator was shown; anything else and the preview named a destruction that
 * is no longer the destruction about to happen.
 */
export class RestoreDatabaseChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreDatabaseChangedError";
  }
}

/**
 * THE LOAD FAILED AND THE ROLLBACK HELD. The operator is exactly where they
 * started, and this says so in as many words.
 *
 * Reached only after the database has been MEASURED and found to be the shape
 * it was before the load. An exit code alone would not do: the matrix at the
 * top of this file has a cell that reports success over a rolled-back load.
 */
export class RestoreLoadFailedError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "RestoreLoadFailedError";
  }
}

/**
 * THE LOAD FAILED AND THE ROLLBACK COULD NOT BE PROVED. The worst outcome this
 * application can produce, and it is never silent.
 *
 * The message names the safety backup's path on disk and gives the exact two
 * commands to restore it by hand, because the person reading it has a broken
 * install and no reason to trust the thing that broke it. A silent half-restore
 * is unreachable: every path out of a failed load throws one of this or
 * RestoreLoadFailedError, and the difference between them is a measurement.
 */
export class RestoreHalfAppliedError extends Error {
  constructor(
    readonly safetyBackupPath: string | null,
    readonly recoveryCommands: readonly string[],
    detail: string,
  ) {
    super(
      "THE DATABASE MAY BE HALF-RESTORED. The load failed and this install could not be "
      + `shown to be in the state it was before it started (${detail}). `
      + (safetyBackupPath === null
        ? "NO SAFETY BACKUP WAS TAKEN, so there is nothing here to put it back from."
        : `A safety backup of that state is on disk at ${safetyBackupPath}, taken with the `
          + "passphrase you typed. To put this install back by hand, run:\n"
          + recoveryCommands.map((line) => `  ${line}`).join("\n")),
    );
    this.name = "RestoreHalfAppliedError";
  }
}

/**
 * WHAT THE DATABASE IS, MEASURED.
 *
 * The schema names and the exact number of ordinary and partitioned tables in
 * them. NOT pg_stat_user_tables, whose row estimates are collector statistics:
 * they are stale by construction and read identically before and after a full
 * replacement, so a restore verified with them would verify nothing.
 */
export interface DatabaseShape {
  /** Every non-system schema, sorted. */
  readonly schemas: readonly string[];
  /** Ordinary and partitioned tables across those schemas. */
  readonly tables: number;
}

/**
 * Measure the database. Two queries, both against the catalogue.
 *
 * `left(nspname, 3) <> 'pg_'` rather than `NOT LIKE 'pg\_%'` because `_` is a
 * LIKE wildcard and the escaping is one more thing to get wrong in a guard
 * whose failure mode is skipping a schema that should have been dropped.
 */
export async function describeDatabaseShape(db: Database): Promise<DatabaseShape> {
  const schemas = await db.execute<{ nspname: string }>(sql`
    SELECT nspname FROM pg_namespace
    WHERE left(nspname, 3) <> 'pg_' AND nspname <> 'information_schema'
    ORDER BY nspname
  `);
  const tables = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
  `);
  return {
    schemas: schemas.map((row) => row.nspname),
    tables: Number(tables[0]?.count ?? "0"),
  };
}

/** Whether two measurements describe the same database. */
export function sameShape(a: DatabaseShape, b: DatabaseShape): boolean {
  return a.tables === b.tables
    && a.schemas.length === b.schemas.length
    && a.schemas.every((name, at) => b.schemas[at] === name);
}

/**
 * The arguments psql is spawned with, and the ONE cell of the matrix that is
 * both safe and truthful. See the matrix at the top of this file.
 *
 * EXPORTED SO A TEST CAN ASSERT WHAT IS IN IT, but the flags are not held by
 * that assertion alone -- an argument list a test agrees with is not evidence.
 * Removing `--single-transaction` makes a failed load genuinely half-apply,
 * which the post-failure measurement catches and reports as
 * RestoreHalfAppliedError; removing ON_ERROR_STOP makes a failed load report
 * exit 0, which the post-load table count catches as an accounting mismatch.
 * Both mutations change the observable behaviour of real tests.
 *
 * `--no-psqlrc` because a ~/.psqlrc on the deploy target could set variables
 * this depends on -- including turning ON_ERROR_STOP back off, which is the
 * difference between the honest cell and a half-applied one.
 *
 * THE SCRIPT ARRIVES ON STDIN, and that is a capability decision rather than a
 * convenience. The dump is a staged member the apply step may only reach
 * through a ref; giving psql a `-f` would mean learning its path, which
 * services/intake.ts deliberately never publishes. Piping the member's own
 * stream keeps the reading rights exactly where the plan put them, and it
 * costs no second copy of a dump that can be gigabytes.
 */
export function psqlLoadArgs(): string[] {
  return [
    "--no-psqlrc",
    "--single-transaction",
    "-v", "ON_ERROR_STOP=1",
    "--quiet",
  ];
}

/** The version string psql prints, or null when it is not installed. */
export async function psqlVersion(): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn("psql", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { resolve(null); });
    child.on("close", (code) => { resolve(code === 0 ? out.trim() : null); });
  });
}

/**
 * Run psql over the preamble and then the dump, as one transaction.
 *
 * The password rides in the environment, never in argv -- see
 * backup.ts's libpqEnvironment for why, and note that the process environment
 * is MERGED rather than replaced: a socket-only DATABASE_URL contributes no
 * PGHOST, and the ambient one is how the test database is reached at all.
 */
async function runPsqlLoad(options: {
  databaseUrl: string;
  preamble: string;
  dump: Readable;
}): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("psql", psqlLoadArgs(), {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ...libpqEnvironment(options.databaseUrl) },
    });
    const errors: Buffer[] = [];
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= STDERR_CAP_BYTES) return;
      errorBytes += chunk.length;
      errors.push(chunk);
    });
    child.on("error", () => { reject(new RestoreToolMissingError("psql", PSQL_PACKAGE)); });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(errors).toString("utf8").slice(0, STDERR_CAP_BYTES),
      });
    });
    child.stdin.write(options.preamble);
    // A psql that exits early makes this reject with EPIPE, which is not the
    // outcome -- the exit code is. The close handler above is the only thing
    // that resolves.
    void pipeline(options.dump, child.stdin).catch(() => { /* see above */ });
  });
}

/**
 * Test an encrypted archive with 7z, the passphrase on stdin and NO `-p`.
 *
 * MEASURED ON THE DEPLOY TARGET (7-Zip 26.02 via p7zip 16.02), because `t`
 * could have differed from `x` and the whole safety-backup proof rests on it:
 *
 *   correct passphrase, no -p .. exit 0
 *   wrong passphrase,   no -p .. exit 2
 *   empty stdin,        no -p .. exit 255, "Break signaled". It does NOT hang.
 *   correct passphrase, -p ..... exit 2 -- a bare `-p` means the EMPTY
 *                                passphrase, exactly as it does for `x`.
 *
 * `t` rather than `l`: listing an -mhe=on archive proves the passphrase opens
 * the HEADER, which is a weaker claim than the one being made. `t` decompresses
 * every member and checks its CRC, so what this proves is that the archive the
 * operator has been promised as an undo actually reads back.
 */
export async function proveArchiveOpens(
  archivePath: string, passphrase: string,
): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("7z", ["t", "-bd", "-y", "--", archivePath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= STDERR_CAP_BYTES) return;
      errorBytes += chunk.length;
      errors.push(chunk);
    });
    child.on("error", () => { reject(new RestoreToolMissingError("7z", SEVEN_ZIP_PACKAGE)); });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(errors).toString("utf8").slice(0, STDERR_CAP_BYTES),
      });
    });
    // No trailing newline: 7z reads one line, on this side exactly as on the
    // writing side. See services/intake.ts's sevenZipExtractArgs.
    child.stdin.write(passphrase);
    child.stdin.end();
  });
}

/**
 * Compare two Conduit version strings. Negative, zero, positive; null when
 * either is not a `major.minor.patch` this can order.
 *
 * PRE-RELEASE SUFFIXES ARE IGNORED rather than ordered, and that is deliberate
 * in the safe direction: "1.3.0-test" and "1.3.0" are the same release as far
 * as the columns a dump references go, and inventing an ordering between them
 * would refuse a backup for a reason that has nothing to do with its contents.
 */
export function compareAppVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let at = 0; at < 3; at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * How many tables a plain pg_dump creates, counted the way psql parses it.
 *
 * THE COPY DATA IS SKIPPED, AND IT HAS TO BE. A dump's COPY blocks carry the
 * operator's own text -- a note body, a company name -- and a row whose value
 * begins a line with "CREATE TABLE " would otherwise be counted as a table.
 * The state machine below is psql's own rule: everything between a
 * `COPY ... FROM stdin;` and the `\.` on a line by itself is data, not SQL.
 *
 * MEASURED AGAINST THE REAL THING: a plain dump of conduit_test on the deploy
 * target has 27 `CREATE TABLE` statements, and the database it came from has
 * exactly 27 ordinary tables. That equality is what makes the count usable as
 * the load step's budget -- see loadDump, which measures the tables that
 * actually arrived and accounts for them against this number.
 */
export function countDumpTables(line: string, state: { inCopy: boolean }): number {
  if (state.inCopy) {
    if (line === "\\.") state.inCopy = false;
    return 0;
  }
  if (/^COPY .* FROM stdin;\s*$/.test(line)) {
    state.inCopy = true;
    return 0;
  }
  return /^CREATE (?:UNLOGGED )?TABLE /.test(line) ? 1 : 0;
}

/** Count the CREATE TABLE statements in a dump, streaming, bounded memory. */
async function countTablesInDump(stream: Readable): Promise<number> {
  const state = { inCopy: false };
  let tables = 0;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) tables += countDumpTables(line, state);
  return tables;
}

/** SHA-256 of a stream, without holding it. */
async function digestOfStream(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// --- the effects -----------------------------------------------------------

/**
 * ONE THING A RESTORE WILL DO.
 *
 * Each op is its own interface so the handler map is exhaustive by the type
 * system: an operation with no handler does not compile, and a handler for an
 * operation no effect carries does not compile either.
 */
export interface SafetyBackupEffect extends PlannedEffect {
  readonly op: "safety-backup";
  /**
   * Where the safety backup is written. ON THE EFFECT, so the sentence the
   * operator reads and the path the handler writes to are the same value --
   * a preview that named a different file from the one that appears would be
   * the preview lying about the only undo there is.
   */
  readonly archivePath: string;
}

export interface WriteBlobsEffect extends PlannedEffect {
  readonly op: "write-blobs";
}

export interface DestroySchemaEffect extends PlannedEffect {
  readonly op: "destroy-schema";
  /** The schemas measured at preview time, in the order they will be dropped. */
  readonly schemas: readonly string[];
}

export interface LoadDumpEffect extends PlannedEffect {
  readonly op: "load-dump";
}

export interface ReplaceMailKeyEffect extends PlannedEffect {
  readonly op: "replace-mail-key";
}

export interface MigrateForwardEffect extends PlannedEffect {
  readonly op: "migrate-forward";
  readonly fromPosition: number;
  readonly toPosition: number;
}

export type RestoreEffect =
  | SafetyBackupEffect
  | WriteBlobsEffect
  | DestroySchemaEffect
  | LoadDumpEffect
  | ReplaceMailKeyEffect
  | MigrateForwardEffect;

export type RestorePlan = Plan<RestoreEffect>;

/**
 * WHAT THE DESTROY STEP LEAVES FOR THE LOAD STEP.
 *
 * The carrier is the whole of what one effect can hand another, and this is
 * all restore needs it to be: the SQL that must run in the same transaction as
 * the dump. Everything else a handler needs -- paths, the database, the
 * passphrase -- is closed over by the handler map rather than carried, so a
 * step cannot reach for a capability by rummaging in a shared bag.
 */
export interface RestoreCarrier {
  /** Statements the load step runs before the dump, in ITS transaction. */
  preamble: string[];
  /** The shape measured immediately before the load, for the failure path. */
  shapeBeforeLoad: DatabaseShape | null;
}

// --- inspect ---------------------------------------------------------------

export interface InspectRestoreOptions {
  /** The upload, as services/intake.ts landed it. */
  file: IntakeFile;
  /** The staged archive. inspect may read all of it; apply may not. */
  payload: StagedPayload;
  /** The live database the restore would replace. */
  db: Database;
  /** $data_dir -- where the blob store, mail.key and the safety backup live. */
  dataDir: string;
  /** config.mailKeyPath. */
  mailKeyPath: string;
  /** This build's version, for the newer-backup refusal. */
  appVersion: string;
  /** Injected so the safety backup's filename is a value, not a moving target. */
  now?: Date;
  /** Probes, injected by the tests that prove the tool refusals fire. */
  psqlPresent?: () => Promise<boolean>;
  sevenZipPresent?: () => Promise<boolean>;
}

/** A refusal plan: no effects, nothing written, nothing destroyed. */
function refuse(
  options: InspectRestoreOptions, refusal: PlanRefusalView, findings: PlanFindingView[] = [],
): RestorePlan {
  return newPlan<RestoreEffect>({
    kind: "restore",
    source: planSource(options.file, options.payload),
    refusal,
    findings,
    now: options.now,
  });
}

/**
 * VALIDATE BEFORE MUTATE, AND PRODUCE A VALUE EITHER WAY.
 *
 * Every refusal below happens with nothing written: the archive is already
 * unpacked (the spine did that), and everything from here to applyRestore is
 * reading. A corrupted archive, a backup from a newer Conduit and a missing
 * psql are all VALUES a test can assert without a database being harmed.
 *
 * THE ORDER IS FROM CHEAPEST TO MOST EXPENSIVE and, more importantly, from
 * "this cannot work at all" to "this member's bytes are wrong". The digest
 * sweep is the only check that reads the whole archive, so it is last: an
 * operator who uploaded the wrong file, or a backup from a newer Conduit, is
 * refused from the manifest alone without 300MB of blobs being hashed first.
 */
export async function inspectRestore(options: InspectRestoreOptions): Promise<RestorePlan> {
  const {
    file, payload, db, dataDir, mailKeyPath, appVersion,
    now = new Date(),
    psqlPresent = async () => (await psqlVersion()) !== null,
    sevenZipPresent = async () => (await sevenZipVersion()) !== null,
  } = options;

  // THE TOOLS FIRST. A restore that validated an archive perfectly and then
  // discovered it has no psql has spent the operator's attention for nothing,
  // and one that discovered it after the destruction would be unforgivable.
  if (!await psqlPresent()) {
    return refuse(options, {
      code: RESTORE_REFUSALS.psqlMissing,
      message: `psql is not installed, so a backup cannot be loaded. Install the `
        + `${PSQL_PACKAGE} package and try again.`,
    });
  }
  if (!await sevenZipPresent()) {
    return refuse(options, {
      code: RESTORE_REFUSALS.sevenZipMissing,
      message: `7z is not installed, so the safety backup this restore takes first cannot `
        + `be written. Install the ${SEVEN_ZIP_PACKAGE} package and try again.`,
    });
  }

  const manifestMember = payload.byName(MANIFEST_MEMBER);
  if (manifestMember === undefined) {
    return refuse(options, {
      code: RESTORE_REFUSALS.manifestMissing,
      message: "this archive has no manifest.json, so it is not a Conduit backup.",
    });
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await payload.readText(manifestMember.ref)) as BackupManifest;
    if (typeof manifest !== "object" || manifest === null) throw new Error("not an object");
  } catch {
    return refuse(options, {
      code: RESTORE_REFUSALS.manifestUnreadable,
      message: "this archive's manifest.json could not be read, so the archive is damaged "
        + "or is not a Conduit backup.",
    });
  }

  // AN EXPORT IS NOT A BACKUP, and the manifest says which it is precisely so
  // this does not have to be inferred from a member list. Restoring an export
  // would replace the database with one that has no mail and no credentials.
  if (manifest.kind !== "backup") {
    return refuse(options, {
      code: RESTORE_REFUSALS.notABackup,
      message: "this archive is a Conduit export, not a backup. An export is readable but "
        + "not restorable: it carries no mail, no credentials and no mail.key.",
    });
  }

  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    return refuse(options, {
      code: RESTORE_REFUSALS.formatUnknown,
      message: `this backup is in archive format ${String(manifest.formatVersion)} and this `
        + `version of Conduit reads format ${String(BACKUP_FORMAT_VERSION)}.`,
    });
  }

  // A BACKUP FROM A NEWER CONDUIT IS REFUSED. Its dump may reference columns
  // this build does not have, and the failure would arrive after the schema
  // had been dropped. TWO INDEPENDENT LAYERS, and they are checked separately
  // rather than together on purpose: an operator can produce either alone (a
  // point release with no migrations, a migration shipped before a version
  // bump), and a check that only fired when both were newer would be a check
  // whose two halves each hid the other's absence.
  const versionOrder = compareAppVersions(manifest.appVersion, appVersion);
  if (versionOrder !== null && versionOrder > 0) {
    return refuse(options, {
      code: RESTORE_REFUSALS.newerApp,
      message: `this backup was taken by Conduit ${manifest.appVersion} and this install is `
        + `${appVersion}. A backup from a newer Conduit cannot be restored onto an older one: `
        + "its data may use columns this version does not have. Upgrade first, then restore.",
    });
  }

  const journal = await readMigrationJournal();
  const backupPosition = Number(manifest.migrationPosition);
  if (!Number.isInteger(backupPosition) || backupPosition < 0) {
    return refuse(options, {
      code: RESTORE_REFUSALS.manifestUnreadable,
      message: "this backup's manifest does not record where its database schema came from, "
        + "so it cannot be checked against this install.",
    });
  }
  if (backupPosition > journal.position) {
    return refuse(options, {
      code: RESTORE_REFUSALS.newerSchema,
      message: `this backup's database schema is newer than this install's: it carries `
        + `${String(backupPosition)} migrations and this build ships `
        + `${String(journal.position)}. Upgrade Conduit first, then restore.`,
    });
  }

  // The dump is only loadable into a server that understands it, and pg_dump's
  // asymmetry applies here too: an older server may not parse what a newer one
  // emitted. Narrowed to the direction that can actually go wrong, exactly as
  // services/backup.ts narrows its own version check.
  const serverRows = await db.execute<{ server_version: string }>(sql`SHOW server_version`);
  const liveMajor = majorVersion(serverRows[0]?.server_version ?? "");
  const dumpMajor = majorVersion(manifest.postgres?.serverVersion ?? "");
  if (liveMajor !== null && dumpMajor !== null && dumpMajor > liveMajor) {
    return refuse(options, {
      code: RESTORE_REFUSALS.newerServer,
      message: `this backup came from PostgreSQL ${String(dumpMajor)} and this server is `
        + `${String(liveMajor)}. A dump from a newer PostgreSQL cannot be loaded into an `
        + "older one.",
    });
  }

  // THE TWO MEMBERS THE RESTORE CANNOT DO WITHOUT, checked separately from the
  // manifest sweep below: a manifest that simply omitted them would pass every
  // digest it listed and still describe an archive with nothing to restore.
  // FIRST, because it costs two lookups and the sweep below reads every blob.
  const dumpMember = payload.byName(DUMP_MEMBER);
  if (dumpMember === undefined) {
    return refuse(options, {
      code: RESTORE_REFUSALS.memberMissing,
      message: `this backup is incomplete: it has no ${DUMP_MEMBER}.`,
    });
  }
  const keyMember = payload.byName(MAIL_KEY_MEMBER);
  if (keyMember === undefined) {
    return refuse(options, {
      code: RESTORE_REFUSALS.memberMissing,
      message: `this backup is incomplete: it has no ${MAIL_KEY_MEMBER}.`,
    });
  }

  // EVERY LISTED MEMBER MUST BE PRESENT AND MUST BE ITS OWN DIGEST. This is
  // the corruption check, and it is separate from 7z's: 7z verifies that the
  // archive decompressed to what was compressed, which says nothing about
  // whether what was compressed is what the manifest claims. A member swapped
  // for another whole, well-formed file passes 7z and fails here.
  //
  // LAST, because it is the only check that reads the whole archive. Every
  // refusal above answers from the manifest alone, so an operator who uploaded
  // the wrong file is told so without 300MB of blobs being hashed first.
  const listed = Array.isArray(manifest.members) ? manifest.members : [];
  for (const entry of listed) {
    const member = payload.byName(entry.path);
    if (member === undefined) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberMissing,
        message: `this backup is incomplete: its manifest lists ${entry.path} and the archive `
          + "does not contain it.",
      });
    }
    const digest = await digestOfStream(await payload.open(member.ref));
    if (digest !== entry.sha256) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberCorrupt,
        message: `this backup is damaged: ${entry.path} does not match the checksum its own `
          + "manifest records for it.",
      });
    }
  }

  // --- findings: everything the operator should know that does not stop it ---

  const findings: PlanFindingView[] = [];
  const listedNames = new Set(listed.map((entry) => entry.path));
  const blobMembers = payload.members.filter((member) => member.name.startsWith(BLOB_PREFIX));
  const extraBlobs = blobMembers.filter((member) => !listedNames.has(member.name));
  // AN UNLISTED files/ MEMBER IS EXTRA, NOT DAMAGE, and this is the single item
  // the spec says this phase must not get wrong. The manifest's member list is
  // the blob walk's snapshot and 7z reads the directory again when it runs, so
  // an upload landing between the two puts a whole, content-addressed file in
  // the archive that the manifest does not list. A restore that called that
  // corruption would reject a perfectly good backup. It is a NOTE, and the
  // blobs are written along with all the others.
  if (extraBlobs.length > 0) {
    findings.push({
      severity: "note",
      code: RESTORE_FINDINGS.extraBlobs,
      message: `this archive holds ${String(extraBlobs.length)} stored file(s) its manifest `
        + "does not list. That is normal: a file uploaded while the backup was being written "
        + "lands in the archive after the manifest was composed. They will be restored.",
    });
  }
  const unexpected = payload.members.filter((member) =>
    !member.name.startsWith(BLOB_PREFIX)
    && member.name !== MANIFEST_MEMBER
    && !listedNames.has(member.name));
  if (unexpected.length > 0) {
    findings.push({
      severity: "warning",
      code: RESTORE_FINDINGS.unexpectedMember,
      message: `this archive holds ${String(unexpected.length)} member(s) that are neither `
        + "stored files nor listed in its manifest. They will be ignored.",
    });
  }

  // mail.key REPLACEMENT IS IRREVERSIBLE IN EFFECT. Restoring an old key
  // strands every mail password encrypted under the current one, and the
  // operator has to be told BEFORE, not discover it when an account stops
  // connecting.
  const backupKeyDigest = await digestOfStream(await payload.open(keyMember.ref));
  const liveKeyDigest = await digestOfFileOrNull(mailKeyPath);
  if (liveKeyDigest !== null && liveKeyDigest !== backupKeyDigest) {
    findings.push({
      severity: "warning",
      code: RESTORE_FINDINGS.mailKeyReplaced,
      message: "this backup carries a different mail.key from the one this install uses. "
        + "Restoring replaces it, which is correct for the data in the backup -- but any mail "
        + "password stored since will no longer decrypt.",
    });
  }

  findings.push({
    severity: "note",
    code: RESTORE_FINDINGS.mailSyncPauses,
    message: "mail sync stops while the restore runs and starts again afterwards, so that "
      + "nothing writes to the database behind the restore.",
  });
  findings.push({
    severity: "warning",
    code: RESTORE_FINDINGS.restartRequired,
    message: "restart Conduit once the restore finishes. The running process holds "
      + "connections and caches for the install that was replaced.",
  });

  // --- the effects, in the order they run ---

  const shape = await describeDatabaseShape(db);
  const dumpTables = await countTablesInDump(await payload.open(dumpMember.ref));
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const archivePath = path.join(dataDir, `conduit-safety-backup-${stamp}.7z`);

  const effects: RestoreEffect[] = [
    {
      op: "safety-backup",
      subject: "this install",
      count: 1,
      unit: "file",
      destroys: false,
      detail: `A backup of this install as it is now is written to ${archivePath}, using the `
        + "passphrase you just typed, and is opened again to prove it reads back. If that "
        + "fails, nothing else happens.",
      archivePath,
    },
    {
      op: "write-blobs",
      subject: "stored files",
      count: blobMembers.length,
      unit: "file",
      destroys: false,
      detail: `${String(blobMembers.length)} stored file(s) are written into the file store. `
        + "Stored files are named after their own contents, so writing one that is already "
        + "there changes nothing and this step can be run again safely.",
      sources: blobMembers.map((member) => member.ref),
    },
    {
      op: "destroy-schema",
      subject: shape.schemas.join(", "),
      count: shape.schemas.length,
      unit: "schema",
      destroys: true,
      detail: `Everything in this database is dropped: ${String(shape.tables)} table(s) across `
        + `${String(shape.schemas.length)} schema(s). This happens in the same transaction as `
        + "the load below, so if the load fails nothing here is destroyed.",
      // FROZEN HERE BECAUSE THE SPINE CANNOT DO IT. newPlan copies and freezes
      // every effect and knows to freeze `sources` as well, because Object.freeze
      // is shallow -- but `schemas` is restore's own array on restore's own
      // effect, and nothing in intake-plan.ts has heard of it. Left live, a
      // caller still holding it could add a schema to the destruction after the
      // preview had been rendered, which is the exact escape newPlan's own
      // comment describes for `sources`.
      schemas: Object.freeze([...shape.schemas]),
      realisedBy: "load-dump",
    },
    {
      op: "load-dump",
      subject: "the backup's database",
      count: dumpTables,
      unit: "table",
      destroys: false,
      detail: `${String(dumpTables)} table(s) from the backup replace what was there. The `
        + "tables that arrive are counted afterwards rather than taken from an exit code.",
      sources: [dumpMember.ref],
    },
    {
      op: "replace-mail-key",
      subject: "mail.key",
      count: 1,
      unit: "key",
      destroys: true,
      detail: "The backup's mail encryption key replaces this install's, after the database "
        + "has loaded. It is written beside the old one and moved into place in one step, so "
        + "there is no moment at which it is neither.",
      sources: [keyMember.ref],
    },
  ];

  if (backupPosition < journal.position) {
    findings.push({
      severity: "note",
      code: RESTORE_FINDINGS.olderSchema,
      message: `this backup is from an older version of the database schema `
        + `(${String(backupPosition)} migrations against this build's `
        + `${String(journal.position)}). It is brought up to date after it loads.`,
    });
    effects.push({
      op: "migrate-forward",
      subject: "database migrations",
      count: journal.position - backupPosition,
      unit: "migration",
      destroys: false,
      detail: `${String(journal.position - backupPosition)} migration(s) run against the `
        + "restored database to bring its schema up to this build's.",
      fromPosition: backupPosition,
      toPosition: journal.position,
    });
  }

  return newPlan<RestoreEffect>({
    kind: "restore",
    source: planSource(file, payload),
    effects,
    findings,
    now,
  });
}

/** The digest of a file, or null when it is not there. */
async function digestOfFileOrNull(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return await digestOfStream(createReadStream(filePath));
}

// --- apply -----------------------------------------------------------------

/**
 * The slice of mail-sync.ts's SyncManager a restore uses.
 *
 * Structural, on mail-send.ts's precedent: the restore never imports the sync
 * engine, so it stays testable with a two-method stub and there is no import
 * cycle between a service that replaces the database and one that reads it.
 */
export interface RestoreSyncControl {
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

export interface ApplyRestoreOptions {
  plan: RestorePlan;
  payload: StagedPayload;
  /** The live database, used before the load and for the safety backup. */
  db: Database;
  databaseUrl: string;
  dataDir: string;
  mailKeyPath: string;
  appVersion: string;
  /** The one the operator typed. Encrypts the safety backup; never stored. */
  passphrase: string;
  /** The second writer. Stopped for the whole apply and started again after. */
  sync?: RestoreSyncControl | null;
  now?: Date;
  freeBytes?: (dir: string) => Promise<number>;
  /**
   * How the database is measured, injected by the test that proves the
   * half-applied branch fires.
   *
   * AN INSTRUMENT THAT HAS NEVER BEEN SHOWN TO FAIL IS NOT YET AN INSTRUMENT,
   * and this branch is otherwise unreachable from a test: with the arguments
   * psqlLoadArgs returns, a failed load rolls back, and there is no fixture
   * that makes PostgreSQL fail to roll back one. The seam is over the
   * MEASUREMENT, not over psql, so the real load still runs in every other
   * test -- and describeDatabaseShape is separately shown to tell a dropped
   * schema from an intact one. Production passes nothing.
   */
  shapeOf?: (db: Database) => Promise<DatabaseShape>;
  /**
   * How the safety backup is proved to open, injected by the test that proves
   * the restore stops when it does not.
   *
   * SAME ARGUMENT AS shapeOf, AND THE SAME NARROWNESS. proveArchiveOpens is
   * exported and shown separately to accept a good archive, refuse a wrong
   * passphrase and refuse a truncated one; what no fixture can produce is 7z
   * writing an archive it then cannot read, so the branch where the restore
   * REFUSES TO START has no other way to be exercised. It is the single most
   * important guarantee in this module, so it is exercised. Production passes
   * nothing.
   */
  proveOpens?: (archivePath: string, passphrase: string) =>
    Promise<{ code: number; stderr: string }>;
}

/**
 * APPLY A RESTORE PLAN. Nothing here decides to restore; it was decided.
 *
 * THE SYNC IS STOPPED AROUND THE WHOLE THING, IN A `finally`. It is not an
 * effect, because an effect that fails mid-plan is never undone and a sync left
 * stopped is an install that silently receives no mail. Stopping it before the
 * safety backup rather than after -- which is the other way round from the
 * spec's numbered list -- is deliberate: the sync is the second writer, and a
 * safety backup taken while it runs is an undo to a state that stopped being
 * true a moment later.
 */
export async function applyRestore(options: ApplyRestoreOptions): Promise<ApplyOutcome> {
  const {
    plan, payload, db, databaseUrl, dataDir, mailKeyPath, appVersion, passphrase,
    sync = null, now = new Date(),
    freeBytes = freeSpaceBytes,
    shapeOf = describeDatabaseShape,
    proveOpens = proveArchiveOpens,
  } = options;

  const carrier: RestoreCarrier = { preamble: [], shapeBeforeLoad: null };
  // READ OFF THE PLAN, AND NULL WHEN THE PLAN DOES NOT CARRY ONE. A default
  // path here would put a filename that does not exist into the loudest message
  // this product can print, told to somebody with a broken install who has no
  // way to check it except by looking. RestoreHalfAppliedError says "no safety
  // backup was taken" instead, which is worse news and true.
  const safetyBackupPath = plan.effects
    .find((effect): effect is SafetyBackupEffect => effect.op === "safety-backup")
    ?.archivePath ?? null;

  const handlers: EffectHandlers<RestoreEffect, RestoreCarrier> = {
    "safety-backup": async (effect, ctx) => {
      const archive = await buildBackup({
        db, dataDir, mailKeyPath, databaseUrl, appVersion, passphrase, now, freeBytes,
      });
      try {
        // THE SECOND COPY IS THE ONE NOBODY BUDGETED FOR. buildBackup's own
        // pre-flight covers the dump and the archive it is building; this
        // writes a THIRD file the same size as the archive, and it is checked
        // here rather than estimated beforehand because here the size is
        // known exactly instead of guessed from pg_database_size.
        const free = await freeBytes(dataDir);
        if (free < archive.sizeBytes + DISK_MARGIN_BYTES) {
          throw new RestoreSafetyBackupError(
            "there is not enough free disk space to keep a safety backup "
            + `(${String(archive.sizeBytes)} bytes needed, ${String(free)} free), and this `
            + "restore does not start without one.",
          );
        }
        // `wx`: this name must not already exist. The timestamp makes a
        // collision mean something has gone wrong, and truncating somebody
        // else's safety backup is not the response.
        //
        // AND A FAILED WRITE TAKES ITS OWN REMAINS WITH IT. A disk that fills
        // part way through leaves a truncated archive under a name that reads
        // as an undo, and the operator would find it exactly when they needed
        // it to be whole. The refusal below is the only outcome; a file is not.
        try {
          await pipeline(
            archive.stream, createWriteStream(effect.archivePath, { mode: 0o600, flags: "wx" }),
          );
          await chmod(effect.archivePath, 0o600);
        } catch (error) {
          // A NAME COLLISION IS NOT OURS TO CLEAN UP, and getting that
          // backwards would turn `wx` from a guard into the thing it guards
          // against: EEXIST means a file was already there, that file is
          // somebody's safety backup, and removing it is precisely what the
          // flag exists to prevent. Every other failure means this write
          // created the file and did not finish it, and a truncated archive
          // under a name that reads as an undo has to go.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            await rm(effect.archivePath, { force: true });
          }
          throw new RestoreSafetyBackupError(
            "the safety backup could not be written, so this restore has not started. "
            + `Nothing has been changed. (${errorText(error)})`,
          );
        }
      } finally {
        await archive.dispose();
      }

      // PROVED BEFORE THE DESTRUCTIVE STEP, NOT AFTER. An unopenable safety
      // backup is worse than none: it is a promise the operator would act on.
      const tested = await proveOpens(effect.archivePath, passphrase);
      if (tested.code !== 0) {
        await rm(effect.archivePath, { force: true });
        throw new RestoreSafetyBackupError(
          "the safety backup was written but could not be opened again with the passphrase "
          + "you typed, so this restore has not started. Nothing has been changed.",
          tested.stderr,
        );
      }
      ctx.spend(1);
    },

    "write-blobs": async (effect, ctx) => {
      // WHAT THE DIGEST SWEEP DID NOT COVER, said here because it sits a screen
      // away in inspectRestore and reads as though it covered everything. It
      // checks every member the MANIFEST LISTS; an unlisted files/ member has
      // no manifest entry to be checked against, so it arrives with 7z's own
      // CRC behind it and nothing else. That is the price of the rule this
      // phase must not get wrong -- an unlisted member is extra, not damage --
      // and it is a small one: the archive is encrypted under the operator's
      // own passphrase, and a blob is a whole file rather than a partial one
      // because services/blobs.ts renames it into place.
      const dir = path.join(dataDir, "files");
      await mkdir(dir, { recursive: true });
      for (const ref of effect.sources ?? []) {
        // The name is a member path the spine already refused a traversal in,
        // and BLOB_PREFIX is the only prefix planned here. `basename` is the
        // belt to those braces: whatever the name is, what is joined is a
        // single component.
        const target = path.join(dir, path.basename(ref.id));
        // CONTENT-ADDRESSED AND IMMUTABLE, so a blob already there is the same
        // blob. Writing to a temp sibling and renaming means a crash never
        // leaves a partial file under a digest name that claims to be whole.
        const temp = `${target}.restoring-${process.pid}`;
        await pipeline(await ctx.open(ref), createWriteStream(temp, { mode: 0o600 }));
        await rename(temp, target);
        ctx.spend(1);
      }
    },

    "destroy-schema": async (effect, ctx) => {
      // RE-MEASURED, NOT TRUSTED. The plan is a snapshot; the world it was
      // measured against can move. For the one effect marked `destroys: true`
      // that is not good enough, so the schema list is read again and must be
      // the list the operator was shown.
      const current = await shapeOf(db);
      const planned = [...effect.schemas];
      if (current.schemas.length !== planned.length
        || !current.schemas.every((name, at) => planned[at] === name)) {
        throw new RestoreDatabaseChangedError(
          `this database no longer looks the way the preview described it: it had `
          + `${planned.join(", ")} and now has ${current.schemas.join(", ")}. Nothing has been `
          + "changed. Take the preview again.",
        );
      }
      // THE PREAMBLE, NOT THE DESTRUCTION. This effect only prepares -- see
      // `realisedBy` above and PlannedEffect's own note on why its accounting
      // is vacuous. The DROPs run inside the load's transaction, so they are
      // undone by the same rollback that undoes the load.
      //
      // EVERY non-system schema, not a fixed list: a plain pg_dump emits
      // `CREATE SCHEMA drizzle` but not `CREATE SCHEMA public`, so public must
      // be recreated here and every other schema must be gone before the dump
      // tries to create it. Measured against a real conduit dump on the deploy
      // target, including a stale schema the dump knew nothing about.
      for (const schema of planned) {
        ctx.carrier.preamble.push(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      }
      ctx.carrier.preamble.push('CREATE SCHEMA IF NOT EXISTS "public";');
      ctx.carrier.shapeBeforeLoad = current;
      ctx.spend(planned.length);
    },

    "load-dump": async (effect, ctx) => {
      const before = ctx.carrier.shapeBeforeLoad;
      const ref = (effect.sources ?? [])[0];
      if (ref === undefined) throw new Error("the load step was planned with no dump to load");
      const result = await runPsqlLoad({
        databaseUrl,
        preamble: `${ctx.carrier.preamble.join("\n")}\n`,
        dump: await ctx.open(ref),
      });

      if (result.code !== 0) {
        // THE EXIT CODE SAYS THE LOAD FAILED. WHAT HAPPENED IS MEASURED.
        let after: DatabaseShape | null = null;
        let why = "";
        try {
          after = await shapeOf(db);
        } catch (error) {
          why = `the database could not be measured afterwards: ${errorText(error)}`;
        }
        if (before !== null && after !== null && sameShape(before, after)) {
          throw new RestoreLoadFailedError(
            "the backup's database could not be loaded, and the whole attempt was rolled "
            + "back. This install is exactly as it was before you started: nothing was "
            + "destroyed and nothing was replaced.",
            result.stderr,
          );
        }
        throw new RestoreHalfAppliedError(
          safetyBackupPath,
          recoveryCommands(safetyBackupPath, databaseUrl),
          why !== "" ? why
            : `it held ${describeShape(before)} before the load and ${describeShape(after)} now`,
        );
      }

      // THE POST-LOAD STATE IS MEASURED, NOT INFERRED FROM AN EXIT CODE. One
      // cell of the matrix at the top of this file reports exit 0 over a
      // rolled-back load, and this is what would catch it: the tables that
      // actually exist, accounted against the number the plan published from
      // the dump itself. A mismatch is a PlanExceededError out of the frame.
      const loaded = await shapeOf(db);
      ctx.spend(loaded.tables);
    },

    "replace-mail-key": async (effect, ctx) => {
      const ref = (effect.sources ?? [])[0];
      if (ref === undefined) throw new Error("the mail.key step was planned with no key");
      const bytes = await ctx.readBytes(ref);
      await mkdir(path.dirname(mailKeyPath), { recursive: true });
      // WRITTEN BESIDE AND RENAMED, so the window in which mail.key is neither
      // the old key nor the new one does not exist. rename(2) on the same
      // filesystem is atomic on the deploy target, which is why the temp file
      // is a sibling rather than in a temp directory.
      const temp = `${mailKeyPath}.restoring-${process.pid}`;
      await writeFile(temp, bytes, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, mailKeyPath);
      // THIS PROCESS CACHES THE KEY AND HAS NO INVALIDATION OF ITS OWN. Without
      // this, every mail password would be decrypted with the key this process
      // happened to load before the restore.
      forgetMailKey(mailKeyPath);
      ctx.spend(1);
    },

    "migrate-forward": async (effect, ctx) => {
      // A FRESH CONNECTION, NOT THE CALLER'S. The pool handed in has sessions
      // that were open across a DROP SCHEMA of everything they had ever
      // referenced; migrating over them would be relying on plan invalidation
      // reaching a pool this module does not own.
      const handle = createDatabase(databaseUrl, 1);
      try {
        const before = await appliedMigrationCount(handle.db);
        await runMigrations(handle.db);
        const after = await appliedMigrationCount(handle.db);
        // MEASURED FROM THE DATABASE'S OWN BOOKKEEPING, not from the journal
        // this build ships: what is being accounted for is what actually ran.
        ctx.spend(after - before);
      } finally {
        await handle.close();
      }
    },
  };

  await sync?.stop();
  try {
    return await applyPlan<RestoreEffect, RestoreCarrier>({
      plan, reader: payload, handlers, carrier,
    });
  } finally {
    // STARTED AGAIN WHATEVER HAPPENED. A failed restore that left the sync
    // stopped would be an install quietly not receiving mail, discovered days
    // later, with nothing on screen to connect it to the restore.
    try {
      await sync?.start();
    } catch { /* a sync that will not restart is not a reason to lose the outcome */ }
  }
}

/**
 * How many migrations the restored database itself says have been applied.
 *
 * 0 WHEN THE BOOKKEEPING IS NOT THERE AT ALL, rather than a throw. A dump that
 * carried no `drizzle` schema is a broken backup, but the failure that says so
 * should be the migrator's -- it will try to apply every migration over tables
 * that already exist and say exactly that -- not a catalogue query nobody can
 * read.
 */
async function appliedMigrationCount(db: Database): Promise<number> {
  try {
    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    return Number(rows[0]?.count ?? "0");
  } catch {
    return 0;
  }
}

/** A shape in one clause, for a message somebody reads while alarmed. */
function describeShape(shape: DatabaseShape | null): string {
  if (shape === null) return "an unknown shape";
  return `${String(shape.tables)} table(s) in ${shape.schemas.join(", ")}`;
}

/**
 * The exact commands that put this install back by hand.
 *
 * NAMED IN FULL, because the person reading them has a broken install and no
 * reason to trust the thing that broke it. The database is addressed by name
 * rather than by URL so a password never reaches a line somebody pastes into a
 * terminal and then into a bug report.
 */
export function recoveryCommands(
  safetyBackupPath: string | null, databaseUrl: string,
): string[] {
  if (safetyBackupPath === null) return [];
  const database = libpqEnvironment(databaseUrl).PGDATABASE ?? "conduit";
  const dir = `${safetyBackupPath}.recovered`;
  return [
    `7z x -o${dir} -- ${safetyBackupPath}`,
    `psql --single-transaction -v ON_ERROR_STOP=1 -d ${database} -f ${dir}/database.sql`,
  ];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
