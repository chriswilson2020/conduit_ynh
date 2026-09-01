import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdtemp, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "drizzle-orm";
import { passphraseProblem } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { readMigrationJournal } from "./migration-journal.js";

// THE EXACT HALF (7.6 Task 2). Everything needed to reconstruct the install:
// a pg_dump of the database, the whole blob store, mail.key, and a manifest.
//
// IT IS THE MIRROR IMAGE OF THE EXPORT, and every property is inverted. The
// export is readable, not restorable, and carries no secrets; this is exact,
// always encrypted, and carries EVERY secret in the system -- mail.key plus
// every encrypted mail password plus every mail body. So the safety test
// inverts with it: where export.test.ts proves the secrets are ABSENT, this
// module's tests prove they are PRESENT. A backup that quietly omitted
// mail.key would restore into an install that cannot decrypt a single mail
// password, and nobody would find out until the day they needed it.
//
// WHY .7z AND NOT AN ENCRYPTED ZIP -- Chris's ruling, 31 Aug, and not
// relitigated here. Two reasons, both measurable:
//
//   - .7z stretches the passphrase 2^19 = 524,288 times (SHA-256). The ZIP
//     standard's AES stretches it 1,000. The passphrase is one a person types
//     rather than one Conduit generates, so that 500x is the whole argument
//     for an archive that will sit in a Downloads folder or a cloud drive.
//     It is visible in the archive itself: `7z l -slt` reports the method as
//     "7zAES:19", and backup.test.ts asserts exactly that string rather than
//     trusting this comment.
//   - -mhe=on encrypts the HEADERS, so the file NAMES are unreadable without
//     the passphrase. Without it, an archive listing leaks that this install
//     has a mail.key, how many blobs it holds and how big they are.
//
// The requirement the format serves is stronger than "encrypted": a backup
// must be openable by DOUBLE-CLICKING IT AND TYPING THE PASSPHRASE. No
// command line, no recipe. docs/backup-format.md names the three tools that
// do that, and a test in backup.test.ts opens a real archive with 7z and
// compares the contents, so the documentation cannot drift from the writer.
//
// WHAT THE ARCHIVE RECORDS ABOUT THE DATABASE, AND WHY IT IS NOT JUST THE DUMP
// (v1.4.0). The manifest carries an INVENTORY: every table the database held,
// by name, with its EXACT row count. It exists because restore's own result
// check compares the restored database against the tables `database.sql`
// declares -- and that is the same file the load consumed, so a backup that was
// already wrong at the moment it was written restores "successfully" into a
// wrong state with nothing to notice. The inventory is the independent witness:
// measured from the catalogue, not read out of the file it travels with.
//
// It is only worth anything if it AGREES with the dump, and agreeing is the
// hard part rather than the obvious one -- pg_dump takes its own snapshot, so
// counting separately counts a database that may have moved. See
// dumpWithInventory for the measurement, the shared snapshot, and the control
// that shows the race is real.
//
// WHAT IT COSTS, HANDLED HERE RATHER THAN DISCOVERED LATER: 7z cannot be
// driven as a pipe. It seeks to write its headers, and with -mhe=on the
// header block is only final once the archive is. So the backup builds to a
// temp file and then streams it, and that temp file is a credential store on
// disk -- see buildBackup for the discipline that follows from it.

/**
 * The layout version of the archive, bumped when a member is renamed or
 * removed or the dump's flags change -- not when a field is added to the
 * manifest, which every reader tolerates.
 *
 * 7.7's restore branches on this rather than guessing from what it finds.
 *
 * NOT BUMPED BY THE INVENTORY (v1.4.0), AND THAT IS A REQUIREMENT RATHER THAN
 * AN OPINION. `inventory` is a new manifest FIELD; no member is renamed, none
 * is removed, and the dump's own flags are unchanged. And restore compares this
 * number with `!==` -- an exact equality, not a floor -- so bumping it would
 * make this build refuse every backup Chris has already taken. A format whose
 * additive change breaks its own predecessors is not additive.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * How an inventory's row counts relate to the dump beside them. ONE VALUE
 * TODAY, and it is a value rather than a boolean because the honest
 * alternatives are not a yes/no: a future backup that could not share a
 * snapshot should be able to say what it did instead rather than lie by
 * omission.
 *
 * "shared-snapshot" means the counts were taken inside the SAME MVCC snapshot
 * pg_dump read, by exporting it from a REPEATABLE READ transaction and handing
 * it to `pg_dump --snapshot`. See dumpWithInventory.
 */
export const INVENTORY_CONSISTENCY = "shared-snapshot";

/**
 * The apt package that provides /usr/bin/7z. Named in the failure message
 * because "7z not found" tells an operator nothing they can act on, and this
 * is the one dependency of the feature that an install can be missing.
 */
export const SEVEN_ZIP_PACKAGE = "p7zip-full";

/** The apt package that provides pg_dump on the deploy target. */
export const PG_DUMP_PACKAGE = "postgresql-client";

/**
 * THE COMPRESSION LEVEL, AND IT IS A MEASUREMENT RATHER THAN A DEFAULT.
 *
 * Measured on the deploy target (Debian 12, 2 CPUs, 3.8GB, NO SWAP) against
 * 367MB of input -- 315MB of incompressible blobs plus a 52MB SQL dump, which
 * is the shape a real install has:
 *
 *   level        time     archive bytes    peak RSS of 7z
 *   -mx=0        1.0 s     367,002,306          9.4 MB
 *   -mx=1       15.0 s     314,764,642         19.0 MB
 *   default     42.0 s     314,920,274        393.6 MB
 *
 * -mx=1 BEATS THE DEFAULT ON EVERY AXIS, which is not the usual shape of a
 * compression trade and is why it is written down. It is 2.8x faster, it uses
 * 20x less memory, and the archive it produces is 155KB SMALLER -- the
 * default's larger dictionary buys nothing on blobs that are already
 * compressed and costs framing on them.
 *
 * The memory column is the one that decides it. 393MB in a second process on a
 * 3.8GB box with no swap is the same ceiling the PDF renderer spent a release
 * learning about, and it would be spent on 155KB. backup.test.ts samples the
 * CHILD's resident set from /proc and asserts a ceiling that the default level
 * fails -- so this constant is guarded by an instrument, not by this comment.
 *
 * -mx=0 is not chosen despite being 15x faster: the 52MB of dump it would stop
 * compressing is the half of the archive that compresses 10:1, and an operator
 * downloading a backup over a domestic uplink pays for those bytes.
 */
const COMPRESSION_LEVEL = "-mx=1";

/**
 * The prefix every work directory carries, inside $data_dir.
 *
 * A FIXED, RECOGNISABLE PREFIX IS WHAT MAKES THE CRASH CASE RECOVERABLE.
 * sweepAbandonedBackups matches on it, so a work directory orphaned by a
 * SIGKILL -- the one exit path no `finally` can cover -- is removed at the
 * next boot and at the next backup instead of sitting in $data_dir with a
 * half-written credential store in it until somebody notices.
 *
 * The leading dot keeps it out of an operator's `ls` and, more importantly,
 * out of any future code that walks $data_dir looking for real content.
 */
const WORK_PREFIX = ".backup-work-";

/**
 * Bytes of slack the disk pre-flight demands beyond its own estimate.
 *
 * 64MB, and it is not a rounding allowance: it is what stops a backup that
 * fits EXACTLY from leaving a live server with zero free blocks, where the
 * next write from any other part of the system -- the journal, Postgres's WAL,
 * an upload -- is the one that fails.
 *
 * EXPORTED FOR 7.7's INTAKE, which makes the same demand for the same reason
 * before it unpacks an archive (services/intake.ts). One number rather than
 * two that agree today: the argument above is about the machine, not about
 * which direction the bytes are travelling in.
 */
export const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** One table, and exactly how many rows it held. */
export interface BackupInventoryTable {
  /** Schema-qualified, e.g. "public.companies". */
  table: string;
  /**
   * EXACT. `count(*)`, never pg_stat_user_tables and never reltuples.
   *
   * This project has already been bitten by the estimate: the planner's
   * statistics read IDENTICALLY before and after a full replacement, which is
   * why services/restore.ts's own measurement refuses them. An inventory made
   * of estimates would be a check that passes over the failure it exists for.
   */
  rows: number;
}

/**
 * WHAT THE DATABASE HELD WHEN THE BACKUP WAS TAKEN.
 *
 * THE WITNESS THAT IS NOT THE DUMP. Restore already compares the restored
 * database against the tables `database.sql` declares -- but that is the same
 * file the load consumed, so a backup that was ALREADY WRONG when it was
 * written restores "successfully" into a wrong state and nothing notices. This
 * is the independent record: the tables that were in the database, by name,
 * with their exact row counts, measured from the catalogue rather than read out
 * of the file.
 *
 * ABSENT MEANS NOT RECORDED. EMPTY MEANS NOTHING WAS THERE. That distinction is
 * load-bearing and it is the reason `tables` is not allowed to be optional
 * inside a present `inventory`: a v1.3.0 backup has no `inventory` key at all
 * and a restore reports the check as NOT MADE, while an inventory with
 * `"tables": []` is a positive claim that the database held no tables and a
 * restore checks it. `Array.isArray(x) ? x : []` is exactly the collapse that
 * turned "this manifest makes no claims" into "its zero claims all hold" one
 * field over, in services/restore.ts's member list, and it was a silent
 * half-restore. It is not repeated here.
 */
export interface BackupInventory {
  /**
   * How these counts relate to the dump. See INVENTORY_CONSISTENCY.
   *
   * RECORDED RATHER THAN ASSUMED, so a reader never has to take the
   * consistency on trust from the version number that happened to write it.
   */
  consistency: string;
  /** Every ordinary and partitioned table, sorted by name. */
  tables: BackupInventoryTable[];
}

/** One archive member, as the manifest records it. */
export interface BackupManifestMember {
  /** The member's path inside the archive, exactly as an extractor will write it. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  formatVersion: number;
  /**
   * "backup", against the export's absence of the field. An operator with two
   * archives and a manifest in each should not have to infer which is which
   * from the member list, and 7.7 must never restore an export.
   */
  kind: "backup";
  appVersion: string;
  /** The last migration tag this build ships, e.g. "0012_misty_phantom_reporter". */
  schemaVersion: string;
  /** How many migrations that is -- the journal POSITION, which is orderable. */
  migrationPosition: number;
  /** When the backup was taken, ISO 8601 UTC. */
  generatedAt: string;
  /**
   * Both halves of the dump's provenance. A dump is only restorable into a
   * server that understands it, and 7.7 has to be able to check that without
   * parsing the SQL: `serverVersion` is what was dumped, `pgDumpVersion` is
   * what dumped it, and `pgDumpArgs` is how -- so a restore knows whether the
   * file carries ownership and privilege statements before it runs one.
   *
   * `pgDumpArgs` IS THE FLAGS THAT DECIDE WHAT IS IN THE FILE, and since
   * v1.4.0 it is no longer the whole command line. A `--snapshot=<id>` is
   * passed too (see dumpWithInventory), and it is deliberately not recorded
   * here: it changes WHICH MVCC snapshot was read, never which statements come
   * out, and the id itself is a transaction triple that means nothing once the
   * exporting session has ended. What a reader needs from it -- that the dump
   * and the inventory saw one snapshot -- is `inventory.consistency`, which is
   * a claim rather than an ephemeral identifier.
   */
  postgres: {
    serverVersion: string;
    pgDumpVersion: string;
    pgDumpArgs: string[];
  };
  /**
   * WHAT THE DATABASE HELD, independently of the dump. OPTIONAL BECAUSE
   * v1.3.0 BACKUPS EXIST AND MUST STILL RESTORE.
   *
   * Absent -- the key is not in the JSON at all -- is a v1.3.0-era archive, and
   * a restore reports the check as NOT MADE rather than as passed. Present with
   * an empty `tables` is a positive claim that there was nothing to record. See
   * BackupInventory for why those two must not collapse into one.
   */
  inventory?: BackupInventory;
  /**
   * What it takes to open this file, recorded INSIDE the file for the reader
   * who already has it open and outside it in docs/backup-format.md for the
   * one who does not.
   */
  encryption: {
    container: "7z";
    cipher: "AES-256";
    /** Whether the member names are encrypted too (-mhe=on). Always true. */
    headerEncryption: boolean;
    /** e.g. "SHA-256, 2^19 (524288) iterations" -- the 7zAES:19 the archive reports. */
    keyDerivation: string;
  };
  /**
   * Every member except manifest.json, which cannot carry its own digest.
   *
   * WHERE THE BLOB DIGESTS COME FROM, because it is not a second read. A blob
   * in $data_dir/files is named by its own SHA-256 -- that is what
   * services/blobs.ts's saveBlob computes from the bytes as it writes them --
   * so the name IS the digest and re-hashing 300MB to rediscover it would
   * double the read for nothing. A file under files/ whose name is not a
   * 64-hex digest (a `.upload-` temp file from an interrupted upload) is
   * hashed for real, because for those the name says nothing.
   */
  members: BackupManifestMember[];
}

/**
 * A tool the backup needs is not installed. 503 at the route, and the message
 * NAMES THE PACKAGE -- the spec's requirement, and the difference between an
 * operator running one apt command and an operator filing a bug.
 */
export class BackupToolMissingError extends Error {
  constructor(readonly tool: string, readonly aptPackage: string, detail = "") {
    super(
      `${tool} is not available${detail === "" ? "" : ` (${detail})`}; `
      + `install the ${aptPackage} package and try again`,
    );
    this.name = "BackupToolMissingError";
  }
}

/**
 * mail.key is absent, so the backup would be missing the one file without
 * which every stored mail password is unrecoverable.
 *
 * THIS FAILS THE BACKUP RATHER THAN OMITTING THE FILE, deliberately. An
 * install whose mail.key has gone is already broken -- mail-crypto's
 * loadMailKey answers 503 on every mail route -- and the failure an operator
 * must not be allowed to have is the silent one: a backup taken today, trusted
 * for a year, restored after a disk failure, and only then found to contain no
 * key. Refusing is loud, immediate and fixable.
 */
export class BackupKeyMissingError extends Error {
  constructor(keyPath: string) {
    super(`mail key not found at ${keyPath}; a backup without it could not restore mail`);
    this.name = "BackupKeyMissingError";
  }
}

/** Not enough free space in $data_dir to build the archive. Numbers included. */
export class BackupDiskSpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number) {
    super(
      `a backup needs about ${formatMiB(requiredBytes)} of free space and `
      + `${formatMiB(availableBytes)} is available; free some space and try again`,
    );
    this.name = "BackupDiskSpaceError";
  }
}

/**
 * The passphrase cannot be used as given.
 *
 * NEVER ECHOES THE PASSPHRASE. Every message here describes the RULE that was
 * broken, never the value that broke it -- a validation error is one of the
 * few places a secret gets copied into a string that is on its way to a log,
 * a browser console and a bug report.
 */
export class BackupPassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPassphraseError";
  }
}

/** pg_dump or 7z ran and failed. The detail never carries the passphrase. */
export class BackupFailedError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "BackupFailedError";
  }
}

function formatMiB(bytes: number): string {
  return `${String(Math.ceil(bytes / (1024 * 1024)))}MB`;
}

/**
 * Reject a passphrase 7z would not use as typed.
 *
 * THE RULE MOVED TO @conduit/shared IN TASK 3 AND THE REASONING WENT WITH IT --
 * see passphrase.ts there for what 7z does to a newline and why the archive it
 * writes is unrecoverable. It moved because the Settings page has to refuse the
 * same passphrase at the keyboard, next to the field, while the character is
 * still on the screen; two independent checks that agree today are two checks
 * that can stop agreeing, and the one a person reads would be the one that
 * drifted.
 *
 * WHAT STAYS HERE IS THE THROW. The shared function returns a sentence or null,
 * because a browser has nothing to do with a BackupPassphraseError; this is
 * where that sentence becomes the exception routes/backup.ts maps to a 400, and
 * it is still the check that runs for a caller who never opened the page.
 */
export function validatePassphrase(passphrase: string): void {
  const problem = passphraseProblem(passphrase);
  if (problem !== null) throw new BackupPassphraseError(problem);
}

/**
 * Re-exported rather than redefined, so routes/backup.ts's request schema and
 * the page's `maxLength` are bounded by one number. See @conduit/shared's
 * passphrase.ts for what 256 is and is not.
 */
export { MAX_PASSPHRASE_LENGTH } from "@conduit/shared";

/**
 * The argument list 7z is spawned with. EXPORTED SO A TEST CAN ASSERT WHAT IS
 * NOT IN IT.
 *
 * THE PASSPHRASE IS NOT HERE, and that is the point of the function existing
 * separately from the spawn. `-p` with no value makes 7z read the passphrase
 * from ITS STDIN; `-p<value>` would put it in argv, and on Linux
 * /proc/<pid>/cmdline is world-readable, so every other local user -- every
 * other YunoHost app on the box -- could read the passphrase of a backup while
 * it was being written. Measured on the deploy target: a piped passphrase
 * produces an archive that opens with that passphrase, and the trailing
 * newline is stripped, so nothing is appended here.
 *
 * (The read side is not symmetric, and it is worth knowing: `7z x -p` reading
 * from a pipe does NOT work on p7zip 16.02 -- it fails with "Cannot open
 * encrypted archive. Wrong password?". The test that opens an archive here
 * passes -p<value> on a command line, where the passphrase is a fixture rather
 * than a secret.
 *
 * SINCE 7.7 THE REST OF THAT SENTENCE IS KNOWN, and it is the opposite of what
 * this comment used to imply. The obvious conclusion from the line above --
 * that reading an archive must therefore put the passphrase in argv -- is
 * FALSE. `7z x` with NO `-p` AT ALL prompts and reads that prompt from stdin,
 * which a pipe satisfies exactly as a terminal does; a bare `-p` on extraction
 * means the EMPTY passphrase. Measured as a 2x2 over the flag and the trailing
 * newline, and recorded in full on services/intake.ts's sevenZipExtractArgs,
 * which is where the read side now lives. The passphrase reaches argv on
 * neither side.)
 */
export function sevenZipArgs(archivePath: string, inputs: readonly string[]): string[] {
  return [
    "a",              // add to archive
    "-t7z",           // the container, stated rather than inferred from the extension
    "-p",             // read the passphrase from stdin: see above
    "-mhe=on",        // encrypt the headers, so the member names do not leak
    COMPRESSION_LEVEL,
    "-bd",            // no progress indicator: this is not a terminal
    "-y",             // never prompt; a prompt here would hang the request
    "--",
    archivePath,
    ...inputs,
  ];
}

/**
 * A DATABASE_URL as the libpq environment variables every postgres client
 * binary reads.
 *
 * THE DATABASE PASSWORD GOES IN THE ENVIRONMENT, NOT THE ARGUMENT LIST, and
 * the split is the whole reason this is a function rather than three lines at
 * the call site. `pg_dump "postgres://user:pw@host/db"` is the obvious form
 * and it puts the password in /proc/<pid>/cmdline, which every local user can
 * read. /proc/<pid>/environ is readable only by the process's own owner.
 *
 * PGPASSWORD is only set when the URL carries one -- the deploy target's
 * DATABASE_URL does (conf/.env), the test database's socket URL does not, and
 * an empty PGPASSWORD is not the same as an absent one to libpq.
 *
 * ONE READER, TWO CONSUMERS, on migration-journal.ts's precedent. 7.7's
 * restore drives `psql` and needs exactly this environment for exactly this
 * reason; a second copy of the derivation would be a copy that drifts silently,
 * and the direction it would drift in is a password reaching a command line.
 */
export function libpqEnvironment(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {};
  // A URL's components are percent-encoded; libpq wants the decoded values.
  if (url.hostname !== "") env.PGHOST = decodeURIComponent(url.hostname);
  if (url.port !== "") env.PGPORT = url.port;
  if (url.username !== "") env.PGUSER = decodeURIComponent(url.username);
  if (url.password !== "") env.PGPASSWORD = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== "") env.PGDATABASE = database;
  return env;
}

/** How pg_dump is invoked: the arguments, and separately the environment. */
export function pgDumpInvocation(
  databaseUrl: string,
): { args: string[]; env: Record<string, string> } {
  return { args: [...PG_DUMP_ARGS], env: libpqEnvironment(databaseUrl) };
}

/**
 * The dump's flags, fixed and recorded in the manifest so 7.7 knows what it is
 * reading without parsing the SQL.
 *
 * --no-owner and --no-privileges because a restore lands in a database whose
 * role is generated by YunoHost at install time and is NOT the role that was
 * dumped: `ynh_psql_setup_db` mints a fresh user and password. A dump carrying
 * ALTER ... OWNER TO for a role that no longer exists fails every one of those
 * statements on restore.
 *
 * NO --clean, and that is 7.7's decision to make rather than this task's: a
 * dump that drops before it creates is a dump that destroys a database when it
 * is run by mistake, and the spec puts "restore replaces everything" behind a
 * typed confirmation and an automatic backup. The file stays additive; the
 * restore decides how to make room for it.
 *
 * Plain SQL rather than a custom-format archive, because the whole format
 * argument is that an operator can open this without Conduit -- and a .sql
 * file is readable in any editor and restorable with psql alone, where a
 * custom dump needs pg_restore and the right version of it.
 *
 * Every non-system schema is included, which is what carries drizzle's own
 * `drizzle` schema and therefore the applied-migration bookkeeping. Without it
 * a restored database would re-run every migration over its own restored data.
 */
const PG_DUMP_ARGS = ["--no-owner", "--no-privileges", "--format=plain"] as const;

/** Run a command that produces no interesting output, resolving its exit status. */
async function probeVersion(command: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { resolve(null); });
    child.on("close", (code) => { resolve(code === 0 ? out.trim() : null); });
  });
}

/** The version string 7z prints, or null when it is not installed. */
export async function sevenZipVersion(): Promise<string | null> {
  // 7z has no --version; `7z` with no arguments prints the banner and exits 0
  // on p7zip 16.02. The banner's first non-empty line is the version.
  return await new Promise<string | null>((resolve) => {
    const child = spawn("7z", ["i"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { resolve(null); });
    child.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("7-Zip"));
      resolve(line ?? "7-Zip");
    });
  });
}

/** The version string pg_dump prints, or null when it is not installed. */
export async function pgDumpVersion(): Promise<string | null> {
  return await probeVersion("pg_dump");
}

/** The major version out of "pg_dump (PostgreSQL) 15.19 (Debian ...)" or "15.19". */
export function majorVersion(versionText: string): number | null {
  const match = /(\d+)(?:\.\d+)*/.exec(versionText.replace(/^\D*\(PostgreSQL\)\s*/, ""));
  return match === null ? null : Number(match[1]);
}

/**
 * What the archive will cost in free disk space before it exists.
 *
 * TWO COPIES OF THE DUMP AND ONE OF THE BLOBS, and each term is a real file
 * that is on the disk at the same moment as the others:
 *
 *   - the plain dump, written to the work directory and still there while 7z
 *     reads it;
 *   - the dump AGAIN inside the archive. It compresses roughly 10:1 in
 *     practice, so counting it at full size is deliberate over-estimation --
 *     the alternative is a pre-flight that passes and then runs out;
 *   - the blob store inside the archive, at full size, because blobs are PDFs
 *     and images and do not compress. Measured: 315MB of blobs produced a
 *     314.8MB archive.
 *
 * `databaseBytes` comes from pg_database_size, which counts indexes, the
 * visibility map and dead tuples that a plain dump does not carry -- so it
 * over-estimates the dump too, again in the safe direction.
 *
 * Exported and pure so the arithmetic can be tested without a database, a
 * disk, or a filesystem that can be made full.
 */
export function requiredFreeBytes(input: { databaseBytes: number; blobBytes: number }): number {
  return input.databaseBytes * 2 + input.blobBytes + DISK_MARGIN_BYTES;
}

/**
 * HOW FAST A BACKUP IS WRITTEN, MEASURED, AND WHY A NUMBER EXISTS AT ALL.
 *
 * 24.4 MB/s. It is COMPRESSION_LEVEL's own measurement read the other way
 * round: 367,002,306 bytes of real-shaped input took 15.0 seconds at -mx=1 on
 * the deploy target, which is 24,466,820 B/s -- rounded DOWN to the nearest
 * tenth of a megabyte, because a lower rate predicts a LONGER wait and this
 * figure exists to warn. Rounding it up to the 24.5 that reads more naturally
 * makes every estimate slightly optimistic, which is the one direction a
 * warning must not err in; backup-estimate.test.ts holds the constant to the
 * measurement and caught exactly that mistake while this was being written.
 *
 * THE POINT OF HAVING IT: the backup cannot stream. The whole archive is built
 * before the first byte leaves, so the gap between the request and the response
 * IS the build, and nginx's proxy_read_timeout measures exactly that gap. At
 * the 300 seconds conf/nginx.conf carried before this task, an install of about
 * 7.3GB would 504 with nothing to show for it -- and the disk pre-flight would
 * have passed, because there was nothing wrong with the disk.
 *
 * IT IS AN ESTIMATE AND IT IS ANNOUNCED AS ONE. It is a single-figure rate for
 * a mixed workload on one machine: a dump that compresses 10:1 runs slower per
 * input byte than blobs 7z gives up on, and a busier server is slower than the
 * idle one this was measured on. Nothing branches on it except a sentence
 * shown to a person before they commit to waiting.
 */
export const BACKUP_BYTES_PER_SECOND = 24_400_000;

/**
 * The read timeout conf/nginx.conf gives the backup route, in seconds.
 *
 * ONE HOUR, SCOPED TO THAT ONE ROUTE. Chris ruled on 31 Aug that the timeout
 * should be raised AND the wait warned about -- both, not either: the raise
 * buys headroom, the warning stops the failure being silent. At
 * BACKUP_BYTES_PER_SECOND this is about 88GB of headroom against the 7.3GB the
 * old global 300 allowed (87.8 and 7.32 decimal gigabytes exactly).
 *
 * NOT RAISED GLOBALLY. Every other route in this app answers in milliseconds,
 * and a global hour would turn a wedged handler into an hour of a held
 * connection instead of a 504 somebody notices. YunoHost's own config makes
 * the same distinction in the same file family -- its admin API location
 * carries proxy_read_timeout 3600s while its portal location carries 30s.
 *
 * DECLARED HERE AND ASSERTED AGAINST THE FILE. backup-nginx.test.ts reads
 * conf/nginx.conf and fails if the block's number is not this one, if the block
 * stops being scoped to the backup route, or if the app's own location has been
 * raised along with it. A constant that only agrees with the deployment by
 * having been correct once is not a constant anyone can rely on.
 */
export const BACKUP_PROXY_READ_TIMEOUT_SECONDS = 3600;

/**
 * How long a wait has to be before it is worth interrupting somebody with.
 *
 * 60 seconds. Below a minute the honest advice is "it is working"; above it,
 * a progress-less spinner is indistinguishable from a hang, and the person
 * deserves to be told the number before they start rather than after they have
 * reloaded the page and started a second one.
 */
export const BACKUP_SLOW_SECONDS = 60;

/**
 * Whether a wait of this length is worth interrupting somebody with.
 *
 * A FUNCTION SO THE BOUNDARY CAN BE ASSERTED FROM BOTH SIDES. It was a `>=`
 * buried in an object literal that needed a database to reach, so the only
 * test that could touch it approached from far below and the boundary itself
 * was never exercised.
 */
export function isSlowBackup(estimatedSeconds: number): boolean {
  return estimatedSeconds >= BACKUP_SLOW_SECONDS;
}

export interface BackupEstimate {
  /** pg_database_size of the current database. */
  databaseBytes: number;
  /** The blob store on disk, at full size. */
  blobBytes: number;
  /** What requiredFreeBytes says this backup needs. */
  requiredBytes: number;
  /**
   * Free space where the archive would be built.
   *
   * MEASURED HERE AND NOT SENT ANYWHERE. routes/backup.ts projects this
   * interface onto the wire shape by hand and leaves this field out -- see the
   * pre-flight route, and shortfallBytes below, for why. It stays on the
   * service's own answer because the service's job is to report what it
   * measured, and because a probe nothing can read is a probe nothing can
   * check: without it, swapping the default for `() => Infinity` would be
   * invisible to every test.
   */
  availableBytes: number;
  /** False when the pre-flight would refuse before spawning anything. */
  enoughDisk: boolean;
  /**
   * How much MORE space a backup needs than there is, or 0 when there is
   * enough.
   *
   * THE SHORTFALL IS WHAT THE ROUTE SENDS, AND THE FREE SPACE IS NOT. The
   * pre-flight deliberately does not require a password -- a warning has to
   * come before the commitment it informs -- so everything in its response is
   * readable by any session holder. The size of the install is something they
   * can already work out by reading it; how much room is left on the server's
   * disk is not, and it is exactly the fact that tells somebody how much they
   * would have to write to fill it. When there IS enough this is 0 and says
   * nothing at all; when there is not, it is the one number an operator needs,
   * and they were going to be told the backup could not run either way.
   */
  shortfallBytes: number;
  /** Predicted build time, whole seconds, rounded up. */
  estimatedSeconds: number;
  /** Long enough to be worth a sentence before starting. */
  slow: boolean;
  /** What nginx allows the route, so the page can say what happens at the end. */
  timeoutSeconds: number;
}

/**
 * What a backup would cost, WITHOUT STARTING ONE.
 *
 * IT ANSWERS THE QUESTION THE DISK PRE-FLIGHT CANNOT. buildBackup's own checks
 * are perfectly good and they all happen after the operator has committed:
 * they run inside the request, and the one failure they cannot report at all
 * is the one where everything was fine and the proxy gave up waiting. This
 * runs BEFORE the button, cheaply, so a wait that will be long is a sentence
 * rather than a surprise.
 *
 * CHEAP DELIBERATELY: two catalogue queries and a directory listing. It does
 * NOT hash anything, which is the one expensive thing collectBlobs does and
 * the reason this does not call it -- a pre-flight that read every byte of the
 * blob store would cost about what the backup costs, to decide whether to take
 * one.
 *
 * IT SHARES requiredFreeBytes AND freeSpaceBytes WITH THE REAL RUN, so the
 * disk verdict shown here and the disk verdict enforced there are one
 * calculation. They can still disagree across the gap between the two calls --
 * something else can fill the disk in between -- and that is why this is a
 * warning and buildBackup's is the control.
 */
export async function estimateBackup(options: {
  db: Database;
  dataDir: string;
  freeBytes?: (dir: string) => Promise<number>;
}): Promise<BackupEstimate> {
  const { db, dataDir, freeBytes = freeSpaceBytes } = options;

  const databaseBytesRows = await db.execute<{ size: string }>(
    sql`SELECT pg_database_size(current_database())::text AS size`,
  );
  const databaseBytes = Number(databaseBytesRows[0]?.size ?? "0");
  const blobBytes = await blobStoreBytes(path.join(dataDir, "files"));

  const requiredBytes = requiredFreeBytes({ databaseBytes, blobBytes });
  const availableBytes = await freeBytes(dataDir);
  const enoughDisk = availableBytes >= requiredBytes;

  // THE INPUT 7z READS, not the archive it writes: the rate was measured
  // against input bytes, and the dump is read once and the blobs once.
  const estimatedSeconds = Math.ceil((databaseBytes + blobBytes) / BACKUP_BYTES_PER_SECOND);

  return {
    databaseBytes, blobBytes, requiredBytes, availableBytes, enoughDisk,
    shortfallBytes: enoughDisk ? 0 : requiredBytes - availableBytes,
    estimatedSeconds,
    slow: isSlowBackup(estimatedSeconds),
    timeoutSeconds: BACKUP_PROXY_READ_TIMEOUT_SECONDS,
  };
}

/**
 * The blob store's size on disk, without hashing a byte of it.
 *
 * The same walk collectBlobs makes and the same tolerance of an absent
 * directory (a fresh install has uploaded nothing), minus the digest -- see
 * estimateBackup for why that difference is the whole reason this exists
 * separately.
 */
async function blobStoreBytes(blobDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(blobDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    const info = await stat(path.join(blobDir, name));
    if (info.isFile()) total += info.size;
  }
  return total;
}

/**
 * Free bytes available to an unprivileged writer under `dir`.
 *
 * Exported so the DEFAULT probe can be checked against df. Every other
 * disk-pre-flight test injects a replacement -- a machine with 28GB free
 * cannot be made to fail the real one -- and without a test on this function
 * itself, swapping statfs for `() => Infinity` would break nothing.
 */
export async function freeSpaceBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  // bavail, not bfree: bfree includes the blocks reserved for root, which this
  // process cannot use.
  return Number(info.bavail) * Number(info.bsize);
}

/**
 * Remove work directories left behind by a previous run.
 *
 * THE EXIT PATH NO `finally` COVERS. Everything else -- a failed build, a
 * refused passphrase, an abandoned download -- is cleaned by buildBackup's own
 * disposal. A SIGKILL, an OOM kill or a power cut is not, and what it leaves
 * in $data_dir is a partially written archive containing mail.key. This is
 * what removes it: called at route registration (so it runs at every boot) and
 * again at the start of every build.
 *
 * Safe to call while a backup is running only because the route allows exactly
 * one at a time and calls this BEFORE creating its own directory -- see
 * MAX_CONCURRENT_BACKUPS. Never throws: a sweep that cannot read $data_dir is
 * not a reason to fail a backup that has not started yet.
 */
export async function sweepAbandonedBackups(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(WORK_PREFIX)) continue;
    try {
      await rm(path.join(dataDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch { /* an unremovable orphan is not a reason to fail the next backup */ }
  }
  return removed;
}

export interface BuildBackupOptions {
  db: Database;
  /** $data_dir: the blob store's parent, mail.key's home, and where the work directory goes. */
  dataDir: string;
  /** config.mailKeyPath -- normally $data_dir/mail.key, but overridable. */
  mailKeyPath: string;
  /** config.databaseUrl, for pg_dump. Never logged; the password reaches libpq via the environment. */
  databaseUrl: string;
  appVersion: string;
  /** What the archive is encrypted with. Never stored, never logged, never on a command line. */
  passphrase: string;
  /** Injected by tests so the manifest's timestamp is a value, not a moving target. */
  now?: Date;
  /**
   * Injected by the disk pre-flight's test, which needs the check to fail on a
   * machine that has plenty of space. Production uses statfs.
   */
  freeBytes?: (dir: string) => Promise<number>;
}

export interface BackupArchive {
  /** The finished archive, as a stream over the temp file. Nothing holds it whole. */
  stream: Readable;
  /** Known exactly, unlike the export's: the archive is finished before a byte is sent. */
  sizeBytes: number;
  /** Suggested download name, e.g. "conduit-backup-2026-08-31.7z". */
  filename: string;
  /** What went in. Also the archive's own manifest.json. */
  manifest: BackupManifest;
  /**
   * Destroy the read stream and remove the work directory. IDEMPOTENT, and
   * already wired to the stream's `close` event -- so an abandoned download
   * cleans itself up without the route having to notice.
   */
  dispose: () => Promise<void>;
}

/**
 * Build the encrypted backup and return it as a stream over its temp file.
 *
 * THE TEMP FILE IS A CREDENTIAL STORE ON DISK, and every line of its handling
 * follows from that:
 *
 *   - IN $data_dir, NEVER /tmp. The spec says so and the systemd unit enforces
 *     it: conf/systemd.service sets ProtectSystem=full with
 *     ReadWritePaths=__DATA_DIR__, so $data_dir is the only place this process
 *     can write at all. (PrivateTmp=yes would make /tmp private per-service
 *     anyway; that is a reason the rule is cheap, not a reason to bend it.)
 *   - MODE 0700 ON THE DIRECTORY, 0600 ON THE ARCHIVE. mkdtemp creates the
 *     directory 0700, which is the bound that actually holds: a file inside a
 *     directory nobody else can traverse is unreachable whatever its own mode
 *     says. 7z creates the archive under the process umask, so it is chmod'd
 *     to 0600 the moment it exists -- belt and braces, and the property a test
 *     can assert directly.
 *   - REMOVED ON EVERY EXIT PATH. Success, failure, and an abandoned download
 *     alike, via `dispose` on the stream's `close`. The one path that cannot
 *     be covered from inside the process is a SIGKILL, and
 *     sweepAbandonedBackups covers that from the next boot.
 *
 * MEMORY IS BOUNDED IN TWO PROCESSES, NOT ONE, and the second is the larger.
 * Node never holds the archive: pg_dump's stdout is piped straight to a file
 * and the finished archive is read back with a 64KB stream. 7z is the process
 * with the appetite, and COMPRESSION_LEVEL is what bounds it -- 19MB at -mx=1
 * against 393MB at the default, measured. backup.test.ts asserts a ceiling on
 * each.
 *
 * DISK IS THE OTHER CEILING and it is checked before anything is written. See
 * requiredFreeBytes for what the estimate is made of.
 */
export async function buildBackup(options: BuildBackupOptions): Promise<BackupArchive> {
  const {
    db, dataDir, mailKeyPath, databaseUrl, appVersion, passphrase,
    now = new Date(), freeBytes = freeSpaceBytes,
  } = options;

  // FIRST, BEFORE ANYTHING TOUCHES THE DISK. A refused passphrase must cost
  // nothing, and validation that ran after a 300MB pg_dump would be a denial
  // of service wearing a validation message.
  validatePassphrase(passphrase);

  // EVERYTHING THAT CAN FAIL, FAILS BEFORE A FILE IS CREATED. The route has a
  // status line to send right up until it calls reply.send, and every check
  // below exists so an operator gets a sentence rather than a truncated
  // download.
  const sevenZip = await sevenZipVersion();
  if (sevenZip === null) {
    throw new BackupToolMissingError("7z", SEVEN_ZIP_PACKAGE);
  }
  const pgDump = await pgDumpVersion();
  if (pgDump === null) {
    throw new BackupToolMissingError("pg_dump", PG_DUMP_PACKAGE);
  }

  const serverVersionRows = await db.execute<{ server_version: string }>(
    sql`SHOW server_version`,
  );
  const serverVersion = serverVersionRows[0]?.server_version ?? "unknown";
  const serverMajor = majorVersion(serverVersion);
  const dumpMajor = majorVersion(pgDump);
  // NEWER pg_dump IS FINE, OLDER IS NOT, and the asymmetry is pg_dump's own:
  // it refuses to dump from a server newer than itself, and the error it gives
  // ("server version mismatch") arrives after the spawn where this arrives
  // before it. The spec asks that pg_dump "match the server's major version";
  // this is that requirement in the direction that can actually go wrong,
  // narrowed deliberately -- a runner with pg_dump 16 against a PostgreSQL 15
  // server is an ordinary, working setup, and refusing it would refuse CI.
  if (serverMajor !== null && dumpMajor !== null && dumpMajor < serverMajor) {
    throw new BackupToolMissingError(
      "pg_dump", `${PG_DUMP_PACKAGE}-${String(serverMajor)}`,
      `pg_dump is version ${String(dumpMajor)} and the database server is ${String(serverMajor)}`,
    );
  }

  // mail.key BEFORE THE DUMP, because this is the check whose failure is the
  // whole reason the backup exists. See BackupKeyMissingError.
  let keyBytes: number;
  try {
    const info = await stat(mailKeyPath);
    if (!info.isFile()) throw new Error("not a file");
    keyBytes = info.size;
  } catch {
    throw new BackupKeyMissingError(mailKeyPath);
  }

  // THE MEMBER LIST IS EXPLICIT, NEVER "$data_dir". Archiving the data
  // directory wholesale would sweep in the work directory this function is
  // about to create -- an archive containing a partial copy of itself -- and
  // any future file that lands there. Naming mail.key and files/ means a new
  // thing in $data_dir is a deliberate decision to include it.
  const blobDir = path.join(dataDir, "files");
  const blobs = await collectBlobs(blobDir);
  const blobBytes = blobs.reduce((total, blob) => total + blob.bytes, 0);

  const databaseBytesRows = await db.execute<{ size: string }>(
    sql`SELECT pg_database_size(current_database())::text AS size`,
  );
  const databaseBytes = Number(databaseBytesRows[0]?.size ?? "0");

  const required = requiredFreeBytes({ databaseBytes, blobBytes });
  const available = await freeBytes(dataDir);
  if (available < required) {
    throw new BackupDiskSpaceError(required, available);
  }

  // Anything orphaned by an earlier crash goes now, before this run adds a
  // directory of its own -- so a stale credential store is never on the disk
  // beside a live one.
  await sweepAbandonedBackups(dataDir);

  // mkdtemp gives 0700 and a name nothing can predict. Inside $data_dir, which
  // the systemd unit makes the only writable path anyway.
  const work = await mkdtemp(path.join(dataDir, WORK_PREFIX));
  const archivePath = path.join(work, "backup.7z");
  let disposed = false;
  let stream: Readable | null = null;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (stream !== null && !stream.destroyed) stream.destroy();
    await rm(work, { recursive: true, force: true });
  };

  try {
    const dumpPath = path.join(work, "database.sql");
    // THE DUMP AND THE RECORD OF WHAT IT CAME OUT OF, FROM ONE SNAPSHOT. Not
    // two steps that agree today: see dumpWithInventory for the measurement
    // that says they would not.
    const { sha256: dumpDigest, inventory } = await dumpWithInventory({
      db, databaseUrl, dumpPath,
    });
    const dumpBytes = (await stat(dumpPath)).size;

    const members: BackupManifestMember[] = [
      { path: "database.sql", bytes: dumpBytes, sha256: dumpDigest },
      { path: "mail.key", bytes: keyBytes, sha256: await digestOf(mailKeyPath) },
      ...blobs.map((blob) => ({
        path: `files/${blob.name}`, bytes: blob.bytes, sha256: blob.sha256,
      })),
    ];

    const journal = await readMigrationJournal();
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      kind: "backup",
      appVersion,
      schemaVersion: journal.tag,
      migrationPosition: journal.position,
      generatedAt: now.toISOString(),
      postgres: { serverVersion, pgDumpVersion: pgDump, pgDumpArgs: [...PG_DUMP_ARGS] },
      inventory,
      encryption: {
        container: "7z",
        cipher: "AES-256",
        headerEncryption: true,
        keyDerivation: "SHA-256, 2^19 (524288) iterations",
      },
      members,
    };
    const manifestPath = path.join(work, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    // 7z strips each input's parent directory and stores what is below it --
    // verified on the deploy target, which is why four inputs from two
    // different parents produce the flat layout the manifest declares:
    // database.sql, manifest.json, mail.key, files/<digest>.
    //
    // THE BLOB STORE IS NAMED AS A DIRECTORY, NOT AS A LIST, and there is one
    // consequence worth stating rather than discovering. The manifest's member
    // list is the walk's snapshot; 7z reads the directory again when it runs.
    // An upload that lands between the two puts a member in the archive that
    // the manifest does not list -- harmless, because blobs are
    // content-addressed and immutable, so the extra member is a whole file
    // rather than a partial one, and 7.7 should treat an unlisted files/ member
    // as extra rather than as damage. The opposite skew is not benign and is
    // not silent: a blob DELETED in that window makes 7z exit non-zero, which
    // runSevenZip turns into a failed backup rather than a short one.
    //
    // Naming each blob individually instead would close the window and break
    // the layout: 7z strips the parent of every input it is given, so
    // $data_dir/files/<digest> would be stored as <digest> at the top level
    // rather than under files/.
    //
    // ABSOLUTE, AND THAT IS WHAT MAKES THE LAYOUT A PROPERTY OF THE FORMAT
    // RATHER THAN OF THE DEPLOYMENT. "7z strips the parent" is true only of an
    // ABSOLUTE input: given a RELATIVE one it keeps the path as written, so a
    // DATA_DIR of "./data" -- which config.ts not only permits but DEFAULTS to
    // -- produced an archive whose whole contents sat under a top-level `data`
    // directory. Every test here used mkdtemp, which is absolute, so nothing
    // saw it until 7.6 Task 3's e2e journey downloaded a backup from the page
    // on a runner where DATA_DIR was left at its default. docs/backup-format.md
    // states the four members as a fact about the format, and 7.7's restore
    // will read them by name; an archive one layer deeper is one that restore
    // would not recognise.
    const inputs = [dumpPath, manifestPath, mailKeyPath].map((input) => path.resolve(input));
    if (blobs.length > 0) inputs.push(path.resolve(blobDir));
    await runSevenZip(archivePath, inputs, passphrase);

    // The window in which the archive carries 7z's umask-derived mode is
    // spent entirely inside a 0700 directory, so nothing else could open it
    // then either. This is the belt to that directory's braces, and the
    // property a test can read off the file itself.
    await chmod(archivePath, 0o600);
    const sizeBytes = (await stat(archivePath)).size;

    stream = createReadStream(archivePath);
    // THE SAME EVENT THE EXPORT LEARNED TO HANG ITS CLEANUP ON. `close` fires
    // for a finished response and an abandoned one alike, so a client that
    // disappears mid-download takes the work directory with it rather than
    // leaving a credential store behind. Idempotent, so the route calling
    // dispose too is free.
    stream.once("close", () => { void dispose(); });

    const day = now.toISOString().slice(0, 10);
    return { stream, sizeBytes, filename: `conduit-backup-${day}.7z`, manifest, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

interface CollectedBlob { name: string; bytes: number; sha256: string }

/**
 * Every file in the blob store, with its size and digest.
 *
 * THE WHOLE DIRECTORY, NOT THE `files` TABLE, and that is the exact inversion
 * of the export. The export reads the TABLE precisely so that mail attachments
 * -- which live in the same content-addressed directory -- stay out of it. A
 * backup that dropped them would restore an install whose messages had lost
 * their attachments, so here the directory is the right source and the table
 * would be the bug.
 */
async function collectBlobs(blobDir: string): Promise<CollectedBlob[]> {
  let names: string[];
  try {
    names = await readdir(blobDir);
  } catch {
    return [];   // a fresh install has uploaded nothing yet
  }
  names.sort();
  const collected: CollectedBlob[] = [];
  for (const name of names) {
    const full = path.join(blobDir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    collected.push({
      name,
      bytes: info.size,
      // The name IS the digest for anything saveBlob wrote. Anything else --
      // an interrupted upload's `.upload-` temp file -- has to be hashed.
      sha256: /^[0-9a-f]{64}$/.test(name) ? name : await digestOf(full),
    });
  }
  return collected;
}

/** SHA-256 of a file, streamed. */
async function digestOf(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Anything that can run a query. The pool, or one transaction on it.
 *
 * THE INVENTORY HAS TO BE COUNTABLE INSIDE A TRANSACTION, which is the whole
 * point of it, so measureInventory cannot take a `Database` and be done.
 */
type QueryRunner = Pick<Database, "execute">;

/**
 * EVERY TABLE AND EXACTLY HOW MANY ROWS IT HOLDS, from the catalogue.
 *
 * THE TABLE LIST COMES FROM postgres, NEVER FROM A CALLER, and that is what
 * makes this safe to run over a restored database whose table names arrived
 * inside an archive an operator uploaded. Nothing from a manifest reaches this
 * query: the names are read out of pg_class and quoted by postgres's own
 * `format('%I')`, so there is no identifier for anybody to inject into. The
 * comparison against a manifest happens afterwards, in TypeScript, between two
 * lists of strings.
 *
 * `query_to_xml` IS HOW A `count(*)` PER TABLE BECOMES ONE ROUND TRIP. It runs
 * the generated SQL and returns its result as XML, so the whole inventory is a
 * single statement -- which is not a performance nicety here but a correctness
 * one: on the backup side every count must land in ONE transaction's snapshot,
 * and a loop of statements from Node would be a loop of chances to get that
 * wrong.
 *
 * THE SAME PREDICATE AS services/restore.ts's describeDatabaseShape, and
 * deliberately so: `left(nspname, 3) <> 'pg_'` rather than `NOT LIKE 'pg\_%'`,
 * because `_` is a LIKE wildcard and the escaping is one more thing to get
 * wrong. The two must agree on what a table is, or a perfectly good restore
 * would report a table missing from one list and present in the other.
 *
 * relkind 'r' AND 'p', matching that function. A partitioned parent and its
 * partitions are therefore counted separately, so a database with partitions
 * has its rows counted twice in the TOTAL -- and per table each figure is still
 * exact, which is what the comparison actually uses. Conduit ships no
 * partitioned table today; this is written down so that the day one arrives the
 * behaviour is a decision rather than a surprise.
 */
export async function measureInventory(db: QueryRunner): Promise<BackupInventoryTable[]> {
  const rows = await db.execute<{ name: string; rows: string | null }>(sql`
    SELECT n.nspname || '.' || c.relname AS name,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                               false, true, '')))[1]::text AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    ORDER BY 1
  `);
  return rows.map((row) => ({ table: row.name, rows: Number(row.rows ?? "0") }));
}

export interface DumpWithInventory {
  /** SHA-256 of the dump file, hashed as it was written. */
  sha256: string;
  /** What the database held in the snapshot the dump was taken from. */
  inventory: BackupInventory;
}

/**
 * TAKE THE DUMP AND THE INVENTORY OUT OF ONE SNAPSHOT.
 *
 * THE PROBLEM THIS SOLVES, BECAUSE IT IS THE ONLY HARD PART. pg_dump opens its
 * own transaction and takes its own MVCC snapshot. Counting rows separately --
 * before it, after it, or beside it -- counts a database that may have moved,
 * and an inventory that disagrees with the dump it travels with is worse than
 * no inventory at all: a restore would report a perfectly good backup as a
 * failed one, at the loudest volume this product has, over an install that had
 * just been replaced.
 *
 * SO THE SNAPSHOT IS SHARED, AND IT WAS MEASURED BEFORE IT WAS DESIGNED
 * AROUND. On the deploy target (PostgreSQL 15.19, Debian 12), with a holder
 * session in REPEATABLE READ exporting its snapshot and a third session writing
 * in between:
 *
 *   counted in the holder ....... t=500  u=7   (v did not exist)
 *   concurrent writer ........... +500 rows in t, -3 in u, CREATE TABLE v
 *   pg_dump --snapshot=<id> ..... t=500  u=7   v absent   <- AGREES
 *   pg_dump with its own ........ t=1000 u=4   v present  <- the race, real
 *
 * The last line is the control, and it is why this function exists: without the
 * shared snapshot the two halves of a backup genuinely do disagree, on an
 * ordinary write that arrives while the backup runs.
 *
 * THE ORDER IS EXPORT, THEN COUNT, THEN DUMP. The export takes the
 * transaction's snapshot; every count after it in the SAME REPEATABLE READ
 * transaction reads that same snapshot; pg_dump imports it by id.
 *
 * THE ISOLATION LEVEL IS NOT DECORATION, AND THAT WAS MEASURED TOO -- by
 * mutation rather than by the probe above, which only exercised the flag.
 * Deleting `isolationLevel` makes each count take a fresh snapshot of its own,
 * and backup.test.ts's consistency case fails with the INVENTORY five rows
 * ahead of the dump; deleting `--snapshot` fails the same case with the DUMP
 * two rows ahead of the inventory. Two halves of one guarantee, and each has
 * been shown breaking on its own.
 *
 * THE EXPORTING TRANSACTION MUST OUTLIVE THE IMPORT, so it is held open across
 * the whole of pg_dump rather than closed once the id is in hand: an exported
 * snapshot is importable only until the transaction that exported it ends, and
 * there is no way from here to observe the instant pg_dump imports it. The cost
 * is one idle REPEATABLE READ transaction for the length of the dump, which is
 * the same length pg_dump already holds one of its own for, against the same
 * database.
 */
export async function dumpWithInventory(options: {
  db: Database;
  databaseUrl: string;
  dumpPath: string;
  /**
   * Runs immediately after the snapshot is exported and BEFORE the counts, so a
   * test can write to the database in the window the shared snapshot exists to
   * close.
   *
   * IT IS THE ONLY WAY TO PROVE EITHER HALF, and it proves both from one place.
   * A write landing here is invisible to a correct run and visible to each
   * mutation, in opposite directions: drop `--snapshot` and the DUMP grows past
   * the inventory; drop the REPEATABLE READ and the INVENTORY grows past the
   * dump. Production passes nothing.
   */
  afterSnapshot?: () => Promise<void>;
}): Promise<DumpWithInventory> {
  const { db, databaseUrl, dumpPath, afterSnapshot } = options;
  return await db.transaction(async (tx) => {
    const exported = await tx.execute<{ id: string | null }>(
      sql`SELECT pg_export_snapshot() AS id`,
    );
    const snapshotId = exported[0]?.id ?? null;
    // NO SILENT FALLBACK TO AN UNSHARED DUMP, on the precedent
    // BackupKeyMissingError sets two hundred lines above: the failure an
    // operator must not be allowed to have is the silent one. A backup that
    // quietly dropped its inventory would look exactly like a v1.3.0 archive,
    // and the day it was restored the check would report itself "not made" with
    // nobody able to say why.
    //
    // THIS IS A MESSAGE, NOT AN INSTRUMENT, AND IT IS LABELLED AS ONE. No
    // fixture can make pg_export_snapshot answer nothing, so no test can show
    // this branch failing -- and the correctness it looks like it protects is
    // already held by pg_dump, measured on the deploy target: `--snapshot=`
    // exits 1 with `could not read file "pg_snapshots/": Is a directory`, and
    // `--snapshot=not-a-snapshot` exits 1 with `invalid snapshot identifier`.
    // Either way the backup fails rather than half-succeeding. What this buys
    // is the sentence an operator reads instead of that one.
    if (snapshotId === null || snapshotId === "") {
      throw new BackupFailedError(
        "the database would not export a snapshot, so the backup's dump and its record of "
        + "what the database held could not be taken from the same instant",
      );
    }
    // BEFORE THE COUNTS, NOT AFTER THEM, AND THE DIFFERENCE WAS MEASURED. With
    // this line below measureInventory the counts ran before the write and the
    // dump ran after it, so only the DUMP's half of the guarantee was under
    // test: deleting `isolationLevel` changed nothing any test could see, and
    // the mutation survived. Here it exercises both halves at once.
    if (afterSnapshot !== undefined) await afterSnapshot();
    const tables = await measureInventory(tx);
    const sha256 = await runPgDump(databaseUrl, dumpPath, snapshotId);
    return { sha256, inventory: { consistency: INVENTORY_CONSISTENCY, tables } };
  }, { isolationLevel: "repeatable read" });
}

/**
 * Dump the database to `dumpPath`, returning the dump's SHA-256.
 *
 * HASHED ON THE WAY PAST rather than in a second read: the bytes are already
 * moving through this process on their way from pg_dump's stdout to the file,
 * and a 50MB dump re-read to hash it is 50MB of disk for nothing. Nothing is
 * buffered -- the pipeline's back-pressure is what keeps a dump of any size
 * costing one 64KB chunk of memory.
 *
 * `snapshotId` IS NOT OPTIONAL, and that is the guard rather than a signature
 * preference. A default would make "dump whatever you can see" the thing that
 * happens when a caller forgets, and what a caller forgets here is the one
 * property the inventory rests on. Every dump this module writes shares a
 * snapshot with the counts recorded beside it.
 */
async function runPgDump(
  databaseUrl: string, dumpPath: string, snapshotId: string,
): Promise<string> {
  const { args, env } = pgDumpInvocation(databaseUrl);
  // AFTER pgDumpInvocation RATHER THAN INSIDE IT, so the manifest's pgDumpArgs
  // stays the fixed list that describes the FILE. See BackupManifest.postgres.
  args.push(`--snapshot=${snapshotId}`);
  const child = spawn("pg_dump", args, {
    stdio: ["ignore", "pipe", "pipe"],
    // The password rides in here, where /proc/<pid>/environ is readable only
    // by this process's own owner -- see pgDumpInvocation.
    env: { ...process.env, ...env },
  });

  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes >= STDERR_CAP_BYTES) return;
    errorBytes += chunk.length;
    errors.push(chunk);
  });

  const hash = createHash("sha256");
  const out = createWriteStream(dumpPath, { mode: 0o600 });
  // HASHED AS A TRANSFORM IN THE PIPELINE, NEVER AS A SECOND `data` LISTENER.
  // services/blobs.ts learned this one: a second listener puts the stream in
  // flowing mode alongside the pipeline's own reads, so correctness would
  // depend on Node's internal consumption strategy rather than on this code.
  // One consumer, and the digest is a side effect of the bytes passing.
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new BackupFailedError("could not start pg_dump", error.message));
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new BackupFailedError(`pg_dump was killed by ${signal}`, stderrText(errors)));
        return;
      }
      if (code !== 0) {
        reject(new BackupFailedError(`pg_dump exited ${String(code)}`, stderrText(errors)));
        return;
      }
      resolve();
    });
  });

  await Promise.all([pipeline(child.stdout, hasher, out), exited]);
  return hash.digest("hex");
}

/** 8KB of a child's stderr is plenty to diagnose it and short enough to log. */
const STDERR_CAP_BYTES = 8 * 1024;

function stderrText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").slice(0, STDERR_CAP_BYTES).trim();
}

/**
 * Run 7z, feeding the passphrase to its stdin.
 *
 * EXIT 1 IS A FAILURE HERE, where for most callers of 7z it is a warning. 7z
 * answers 1 when it could not read one of the files it was asked to archive --
 * which for a backup is precisely the outcome that must never be presented as
 * a success. A backup missing one blob is a backup that restores an install
 * with a missing document, discovered years later.
 */
async function runSevenZip(
  archivePath: string, inputs: readonly string[], passphrase: string,
): Promise<void> {
  const child = spawn("7z", sevenZipArgs(archivePath, inputs), {
    stdio: ["pipe", "ignore", "pipe"],
  });

  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes >= STDERR_CAP_BYTES) return;
    errorBytes += chunk.length;
    errors.push(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new BackupFailedError("could not start 7z", error.message));
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new BackupFailedError(`7z was killed by ${signal}`, stderrText(errors)));
        return;
      }
      if (code !== 0) {
        reject(new BackupFailedError(`7z exited ${String(code)}`, stderrText(errors)));
        return;
      }
      resolve();
    });
    // Registered before the write: a 7z that fails immediately closes its
    // stdin while this write is in flight, and the EPIPE that follows must not
    // become an unhandled 'error' event. `close` reports the real reason.
    child.stdin.on("error", () => { /* see above */ });
    // NO TRAILING NEWLINE. 7z strips one if it is there (measured), so adding
    // one would be harmless -- but "harmless because the tool trims it" is a
    // property of p7zip 16.02 rather than of the format, and the passphrase a
    // person types has no newline in it.
    child.stdin.end(passphrase, "utf8");
  });
}
