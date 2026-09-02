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
  buildBackup, freeSpaceBytes, libpqEnvironment, majorVersion, measureInventory,
  sevenZipVersion,
  BACKUP_FORMAT_VERSION, DISK_MARGIN_BYTES, INVENTORY_CONSISTENCY, PG_DUMP_PACKAGE,
  SEVEN_ZIP_PACKAGE,
  type BackupInventoryTable, type BackupManifest,
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
// an exit code of 0 over a database that kept its old contents.
//
// THE EXIT CODE IS LOAD-BEARING, AND SO IS EVERYTHING BESIDE IT. An earlier
// version of this comment said "the post-load state is measured, never inferred
// from an exit code", and that was FALSE TWICE OVER -- said plainly here
// because a claim like it is exactly what stops the next reader looking.
//
//   - Dropping ON_ERROR_STOP made applyRestore RETURN SUCCESS over a load that
//     failed and rolled back. The compensating "measurement" was a table count,
//     and the table count MATCHES in that case -- it is the normal case for a
//     restore. The flag is what catches it; nothing else was.
//   - A count cannot see a half-applied load at all, because a half-applied
//     load recreates exactly the schemas and tables it dropped.
//
// THE MISTAKE UNDERNEATH ALL OF THIS, SAID ONCE, BECAUSE THREE REVIEW ROUNDS
// EACH FOUND A DIFFERENT DOOR INTO THE SAME ROOM: every instrument here began
// life measuring THE PROCESS -- the exit code, the flags, the bytes handed over
// -- and a process that goes perfectly can still leave the wrong result. Each
// round closed one door (a swallowed stream error, a count that could not see a
// replacement, a manifest that made no claims, a `\q`) and the next round found
// another, because the class was never addressed. The class is: A RESTORE IS
// NOT VERIFIED UNTIL THE RESULT IS COMPARED WITH WHAT WAS PROMISED.
//
// So there are now five instruments, three of them about the process and TWO
// about the result, and only the last two close the class:
//
//   THE FLAGS decide whether a failed statement rolls the transaction back.
//   THE SOURCE decides whether psql was handed the whole dump -- see
//     runPsqlLoad, because a truncated stream is a CLEAN END OF FILE and end of
//     file means COMMIT.
//   THE DUMP'S OWN CONTENT decides whether psql could diverge from it at all --
//     see ALLOWED_META_COMMANDS. Without this the other two are worthless:
//     measured, a `\q` makes psql commit a prefix and exit 0 having been handed
//     every byte.
//   THE RESULT AGAINST THE DUMP -- the tables that are actually in the database
//     afterwards, BY NAME, against the tables the dump declared -- decides
//     whether the restore did what the preview said. See LoadDumpEffect.tables.
//     And, on the failure path, the IDENTITY of every table (pg_class.oid, not
//     a count) decides whether the rollback held. See DatabaseShape.
//   THE RESULT AGAINST THE INVENTORY -- the tables and EXACT ROW COUNTS in the
//     database afterwards, against what the backup recorded the database
//     HOLDING when it was taken. See LoadDumpEffect.inventory.
//
// Never pg_stat_user_tables, whose estimates read identically before and after
// a full replacement -- and, for exactly the same reason, never a table count.
//
// WHY THE FIFTH EXISTS WHEN THE FOURTH LOOKS LIKE ENOUGH, said here because
// this is where the fourth was declared to close the class and it did not. The
// fourth compares the result against the DUMP, and the dump is THE SAME FILE
// THE LOAD CONSUMED. Every witness in the chain -- the exit code, the byte
// count, the allowed meta-commands, the table names -- is derived from that one
// artefact, so a backup that was ALREADY WRONG at the moment it was written
// restores perfectly against its own description and nothing notices. The fifth
// is the only witness that is not the dump: services/backup.ts measures the
// live database's tables and row counts from the CATALOGUE, in the same MVCC
// snapshot pg_dump reads, and records them in manifest.json.
//
// AND IT IS OPTIONAL, WHICH IS NOT A WEAKNESS BUT THE POINT. Chris has v1.3.0
// backups on disk and they have no inventory. A restore that refused them would
// be worse than the gap it closes, so an archive with no `inventory` key is
// restored with the check reported as NOT MADE -- a plan finding an operator
// reads, never a silent pass. "Absent" and "an inventory of nothing" are
// different manifests and are treated differently; see readInventory.
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
// AND STOPPING IT IS BEST-EFFORT, WHERE STOPPING HTTP IS NOT. The asymmetry is
// named here rather than left for a reader to infer from two files:
// services/write-gate.ts REFUSES the restore when in-flight writes will not
// drain inside its bound, and mail-sync.ts's `stop()` races a 15s deadline,
// logs "gave up waiting for syncs to stop, abandoning them", and RESOLVES --
// so `sync.stop()` below can return having stopped nothing, and this function
// proceeds. A wedged sync is then a second writer inside the restore, and its
// writes land the way every blocked write does: queued behind the DROP
// SCHEMA's lock and released at COMMIT, into the restored data.
//
// IT IS NOT CLOSED HERE BECAUSE THE SIGNAL DOES NOT EXIST. RestoreSyncControl
// takes `() => Promise<void>`, because that is what SyncManager offers; making
// the restore refuse on a sync that would not stop means `stop()` reporting
// whether it did, which is a change to the sync engine's contract rather than
// to this module. The exposure is narrower than the HTTP one it mirrors -- a
// wedged sync means an IMAP connection that has stopped answering, so it is
// usually writing nothing -- and that is a reason to rank it, not to omit it.
//
// ======================= WHERE THE GUARD LIVES, AND WHY ====================
//
// Re-authentication and the typed install name are the guard, and they are NOT
// here: this module applies a plan somebody else decided to apply. They live in
// routes/restore.ts, together with binding a plan to the operator who uploaded
// it (see IntakeSession.owner) and the boot call to sweepAbandonedIntakes.
//
// SO DOES THE OTHER SECOND WRITER, which is not the sync. The spec's step 5
// says "stop the mail sync AND REFUSE NEW WRITES". The first half is here; the
// second cannot be, because a service handed a database and a plan cannot see
// that a browser in another tab is posting a company. The argument is the one
// this module already makes -- a restore is only true if nothing else is
// writing -- and services/write-gate.ts is where it is carried out: writes are
// refused by HTTP method for the duration, and the apply route WAITS for the
// writes already in flight to finish before this function is called at all.
//
// TWO SMALLER THINGS THE ROUTES TRIP OVER, both of them still true:
//
//   mail-crypto.ts's key cache is keyed by the PATH STRING it was given, not by
//   a resolved path, whatever its own comment says -- so forgetMailKey only
//   clears what an identical string put there. Pass config.mailKeyPath, the
//   same value every other reader passes, or the invalidation silently misses.
//
//   countDumpTables is LEXICAL and describeDatabaseShape is CATALOGUE. They
//   agree across all thirteen migrations this build ships, and they are not
//   guaranteed to: a dump that ever carries a CREATE EXTENSION bringing its own
//   tables would make a perfectly successful restore report
//   RestoreUnexpectedResultError. That is the safe direction -- the database is
//   whole and the message says the restore HAPPENED -- but it is a false alarm
//   of the loudest kind, and the fix when it comes is to count what the dump
//   creates the way postgres does rather than the way a reader does.
//
// A MIGRATION CANNOT HELP ANY OF THIS. Restore bookkeeping cannot live in a
// database the restore replaces: a row written before the destruction is
// dropped with the schema, and one written after is written by a build whose
// migrations may not have run yet. Everything this module remembers, it
// remembers on the filesystem or in the process.

/** The apt package that provides psql. The same one that provides pg_dump. */
export const PSQL_PACKAGE = PG_DUMP_PACKAGE;

/**
 * WHAT nginx HAS TO LET THROUGH FOR A RESTORE, AND IT IS NOT WHAT IT LETS
 * THROUGH FOR EVERYTHING ELSE.
 *
 * 7.6 raised the read timeout for the backup route and said in conf/nginx.conf
 * why it was scoped rather than global. Restore needs the same treatment twice
 * over and for a reason 7.6 did not have: it is the first route in this
 * application that receives something large, and the app's own location block
 * carries `client_max_body_size 50M` -- a bound written for a mail attachment.
 *
 * MEASURED AGAINST THE APP'S OWN CEILING RATHER THAN GUESSED. services/intake.ts
 * accepts an upload of up to DEFAULT_MAX_UPLOAD_BYTES, and a backup is roughly
 * the size of the install. At 50M, every restore of a real install would be
 * refused BY nginx -- which answers its own HTML 413 that this application
 * never sees, so the operator gets an unstyled proxy error where the page had
 * promised a message naming the limit. The bound below is asserted against
 * DEFAULT_MAX_UPLOAD_BYTES by restore-nginx.test.ts, so the day somebody raises
 * one and not the other is the day a test fails rather than a restore does.
 *
 * WHY THE PROXY MUST NOT BUFFER THE REQUEST, AND THIS IS THE PART THAT IS ABOUT
 * A CREDENTIAL AND NOT ABOUT SIZE. nginx buffers a request body to disk by
 * default, in its own client_body_temp_path. The preview's body is multipart
 * and the PASSPHRASE FIELD COMES FIRST IN IT -- routes/restore.ts requires that
 * order for the streaming parser -- so a buffered body is the archive's
 * passphrase written to a file this application does not own, cannot chmod and
 * does not delete. 7.6's rule is that the passphrase is never stored, logged or
 * written to disk; `proxy_request_buffering off` is what keeps that true of the
 * deployment and not merely of the process. The archive is then written exactly
 * once, by receiveIntake, at 0600 inside $data_dir.
 *
 * BOTH ROUTES, AND THE APPLY ONE IS NOT AN AFTERTHOUGHT. Apply's body is three
 * short fields, so it needs no size at all -- but it takes a whole safety
 * backup before it destroys anything, which costs what the backup route costs,
 * and then loads a dump on top. It is the longest single request this
 * application has.
 */
export const RESTORE_PROXY_READ_TIMEOUT_SECONDS = 3600;

/**
 * `client_max_body_size` for the preview, as nginx spells it.
 *
 * A STRING BECAUSE nginx TAKES ONE, and the test parses it back to bytes rather
 * than matching the characters: `9g` and `9216m` are the same directive and a
 * guard that accepted only one spelling would be asserting about typography.
 *
 * ABOVE THE APP'S CEILING RATHER THAN EQUAL TO IT, AND A REVIEW IS WHY. The two
 * numbers measure different things: DEFAULT_MAX_UPLOAD_BYTES bounds the FILE
 * PART (routes/restore.ts hands it to `request.file`'s `fileSize` limit), and
 * nginx's directive bounds the WHOLE REQUEST BODY -- the multipart preamble,
 * the `passphrase` field, every boundary and every part header as well. Set
 * equal, a file of exactly the app's ceiling is refused BY NGINX with its own
 * HTML 413 a few hundred bytes over, which is the precise failure the block
 * exists to prevent. The margin is a whole GiB rather than a tight arithmetic
 * one because the alternative is arithmetic over a moving target, which is this
 * project's named recurring failure; restore-nginx.test.ts asserts a STRICT
 * inequality so the two can never be brought level again by accident.
 */
export const RESTORE_CLIENT_MAX_BODY_SIZE = "9g";

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
  /** The dump carries a psql meta-command that could stop it part way. */
  dumpMetaCommand: "dump-meta-command",
  /**
   * The manifest HAS an inventory and it cannot be read as one.
   *
   * REFUSED RATHER THAN IGNORED, and the choice is the conservative one in both
   * directions it could go wrong. Ignoring it would turn a damaged manifest into
   * a restore whose safety check silently did not happen -- the exact shape of
   * `Array.isArray(x) ? x : []`, which was a silent half-restore one field over.
   * Refusing costs nothing recoverable: it happens at inspect, with nothing
   * written and nothing destroyed, and the archive is still openable by hand.
   *
   * It is very unlikely to refuse a legitimate FUTURE backup by mistake, and
   * the qualifier is deliberate. A manifest written by a later Conduit -- one
   * that had added, say, an "approximate" label -- is normally refused by
   * `newerApp` before this is reached. NORMALLY, not always: compareAppVersions
   * answers null for an `appVersion` it cannot order, and `newerApp` then does
   * not fire. Every version Conduit's release process writes is an orderable
   * `major.minor.patch`, so the gap needs a manifest no release produced -- and
   * a refusal is still the safe side of it, because the alternative is checking
   * counts against a guarantee this build cannot evaluate.
   */
  inventoryUnreadable: "inventory-unreadable",
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
  /**
   * THE BACKUP RECORDS NO INVENTORY, so the restored result cannot be checked
   * against what the database held. A v1.3.0-era archive. A warning rather than
   * a note: a safety check that will not be made is something the operator
   * should weigh before replacing an install, not a footnote.
   */
  inventoryMissing: "inventory-missing",
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
 * The message names the safety backup's path on disk and gives the exact
 * commands to restore it by hand, because the person reading it has a broken
 * install and no reason to trust the thing that broke it. THE COMMANDS ARE RUN
 * BY A TEST, not merely spelled by one: the first version of them could not
 * work, because the safety backup's dump has no --clean and will not load over
 * a schema that still exists.
 *
 * "EVERY PATH OUT OF A FAILED LOAD THROWS THIS OR RestoreLoadFailedError" IS
 * WHAT THIS COMMENT USED TO CLAIM, AND THERE WERE TWO MORE. A dump that could
 * not be read left only the DROP preamble to psql, which committed it and
 * exited 0 -- and the accounting mismatch that followed travelled out as the
 * frame's own PlanExceededError: unwrapped, naming no safety backup, over an
 * empty database. And a load that committed something OTHER than what the
 * preview described was the same shape. Both now belong to the load step:
 * see RestoreUnexpectedResultError, and the source check in runPsqlLoad.
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
 * THE DATABASE IS RESTORED AND THE MIGRATIONS DID NOT FINISH.
 *
 * The restore itself committed; what failed is bringing an older backup's
 * schema up to this build's. The install is NOT broken in the way a failed load
 * would leave it -- the data is there and it is the backup's data -- but its
 * schema is behind the code that will be reading it, which is its own kind of
 * broken and needs saying rather than a stack trace about an accounting budget.
 */
export class RestoreMigrationError extends Error {
  constructor(
    readonly fromPosition: number,
    readonly toPosition: number,
    override readonly cause: unknown,
  ) {
    super(
      "the backup was restored, but bringing its database schema up to date failed "
      + `(${cause instanceof Error ? cause.message : String(cause)}). The restored data is `
      + `there and it is the backup's data, at migration ${String(fromPosition)} of `
      + `${String(toPosition)}. Do not use this install until the migrations run: restart `
      + "Conduit, which applies them at boot, and read the log if they fail again.",
    );
    this.name = "RestoreMigrationError";
  }
}

/**
 * THE MIGRATIONS RAN AND THERE WERE NOT THE NUMBER THE PREVIEW SAID.
 *
 * Sibling of RestoreUnexpectedResultError, one step later and for the same
 * reason: the database is already replaced, so this cannot be reported as a
 * step exceeding its plan. The likeliest cause is not damage -- the manifest's
 * migrationPosition is the number of migrations the build that TOOK the backup
 * shipped, not the number the dumped database had applied -- so it says what
 * happened and names the way back.
 */
export class RestoreUnexpectedMigrationsError extends Error {
  constructor(
    readonly plannedMigrations: number,
    readonly actualMigrations: number,
    readonly safetyBackupPath: string | null,
    readonly recoveryCommands: readonly string[],
  ) {
    super(
      "the backup was restored and its schema brought up to date, but not by the number of "
      + `migrations the preview described: it said ${String(plannedMigrations)} and `
      + `${String(actualMigrations)} ran. The restore has HAPPENED -- check the data before `
      + "using this install."
      + (safetyBackupPath === null ? ""
        : ` A safety backup of the previous state is at ${safetyBackupPath}. To go back:\n`
          + recoveryCommands.map((line) => `  ${line}`).join("\n")),
    );
    this.name = "RestoreUnexpectedMigrationsError";
  }
}

/**
 * THE DATABASE IS RESTORED AND mail.key IS NOT.
 *
 * The one window this module's ordering cannot close, said out loud. mail.key
 * is replaced AFTER the database commits, so that a failed load cannot strand
 * every stored mail password under a key that is no longer on disk. The price
 * is the mirror case: if the key write fails, or the process dies between the
 * commit and the rename, the restored database's passwords are under the
 * BACKUP's key while the OLD key is still on disk.
 *
 * Nothing is lost -- the key is in the archive that was just restored from --
 * and the message says so, because the symptom otherwise is "no mail account
 * will connect" and it points nowhere near the cause.
 */
export class RestoreMailKeyError extends Error {
  constructor(readonly mailKeyPath: string, override readonly cause: unknown) {
    super(
      "the database was restored, but its mail encryption key could not be written to "
      + `${mailKeyPath} (${cause instanceof Error ? cause.message : String(cause)}). The `
      + "restored data is intact; stored mail passwords will not decrypt until mail.key is "
      + "replaced with the one in the backup you restored from -- extract it with "
      + "`7z x` and copy it into place, mode 0600.",
    );
    this.name = "RestoreMailKeyError";
  }
}

/**
 * THE LOAD COMMITTED, AND THE RESULT IS NOT WHAT THE PREVIEW DESCRIBED.
 *
 * A DIFFERENT STATE FROM THE OTHER TWO, and it needs its own name because the
 * operator's next move is different. The transaction committed: the restore
 * happened, the database is whole and self-consistent, and nothing is
 * half-anything. What is wrong is that it does not match the plan they were
 * shown -- more or fewer tables arrived than the dump said it would create.
 *
 * IT USED TO BE A PlanExceededError, and that was wrong twice over. The frame's
 * accounting error travels UNWRAPPED, so the caller lost the partial outcome;
 * and its message ("the plan said otherwise") describes a bug in a step, at a
 * moment when the operator's database has just been replaced and what they need
 * is the safety backup's path.
 *
 * IT NAMES THE TABLES THAT ARE NOT THERE, which is the difference between this
 * and a count. "The preview said 27 and there are 26" sends an operator looking
 * at all of them; "mail_messages is not there at all" is the sentence that ends
 * the search.
 *
 * The most likely cause is not damage: readDumpLine reads CREATE TABLE
 * statements out of the SQL and describeDatabaseShape reads what postgres ended
 * up with, and the day a dump carries a CREATE EXTENSION that brings its own
 * tables the two disagree about a restore that worked perfectly. That direction
 * shows up as a COUNT mismatch with nothing missing, which is why both are
 * reported and why this says what happened rather than accusing anyone.
 *
 * AND IT SAYS mail.key WAS NOT REPLACED, for the reason
 * RestoreInventoryMismatchError does: both throw from the LOAD handler, so the
 * key step and the migrations never run. Telling an operator "the restore has
 * HAPPENED" while leaving out that this install still holds its own mail
 * encryption key is how the symptom -- no mail account will connect, or every
 * stored password suddenly does -- ends up pointing nowhere near the cause.
 */
export class RestoreUnexpectedResultError extends Error {
  constructor(
    readonly plannedTables: number,
    readonly actualTables: number,
    readonly missingTables: readonly string[],
    readonly safetyBackupPath: string | null,
    readonly recoveryCommands: readonly string[],
  ) {
    super(
      "the backup loaded and was committed, but the result is not what the preview "
      + `described: it said ${String(plannedTables)} table(s) and the database now holds `
      + `${String(actualTables)}`
      + (missingTables.length === 0 ? ""
        : `, and these are not there at all: ${missingTables.slice(0, 10).join(", ")}`)
      + ". The restore has HAPPENED -- check the data before using this install. mail.key was "
      + "NOT replaced and no migrations were run, so this install still holds its own mail "
      + "encryption key."
      + (safetyBackupPath === null ? ""
        : ` A safety backup of the previous state is at ${safetyBackupPath}. To go back:\n`
          + recoveryCommands.map((line) => `  ${line}`).join("\n")),
    );
    this.name = "RestoreUnexpectedResultError";
  }
}

/** One table the restored database does not agree with the backup about. */
export interface InventoryDisagreement {
  /** Schema-qualified, as both the manifest and the catalogue name it. */
  readonly table: string;
  /** What the backup recorded the database holding, or null when it listed none. */
  readonly recorded: number | null;
  /** What the restored database holds, or null when the table is not there. */
  readonly restored: number | null;
}

/**
 * THE LOAD COMMITTED, AND THE RESTORED DATABASE IS NOT WHAT THE BACKUP SAYS THE
 * ORIGINAL HELD.
 *
 * THE ONLY FAILURE IN THIS MODULE WHOSE WITNESS IS NOT THE DUMP.
 * RestoreUnexpectedResultError, one class up, compares the result against the
 * tables `database.sql` declares -- which is the file the load consumed, so it
 * cannot see a backup that was wrong before it was ever restored. This compares
 * the result against `manifest.json`'s inventory, which services/backup.ts
 * measured from the live catalogue in the same snapshot pg_dump read.
 *
 * IT IS A REPORT, NOT A PREVENTION, AND THAT IS DECIDED RATHER THAN CONCEDED.
 * By the time rows can be counted the transaction has committed: the operator's
 * database is already gone. There is no rollback left to take, and inventing
 * one -- reloading the safety backup automatically -- would mean answering a
 * failed restore with a second unattended destructive act on an install that
 * has just proved it can surprise us. So the answer is the one every other
 * post-commit failure here gives: say exactly what disagreed, name the safety
 * backup, and print the commands that put the install back, so the person
 * decides.
 *
 * AND IT STOPS THE PLAN, which is the other half of the decision. Throwing here
 * means mail.key is NOT replaced and the migrations do NOT run, so a suspect
 * restore is not followed by an irreversible key swap. The cost is stated in
 * the message rather than left to be discovered: the restored database's stored
 * mail passwords are under the BACKUP's key and the old key is still on disk,
 * which is the same residual window RestoreMailKeyError describes from the
 * other direction.
 *
 * IT NAMES THE TABLES AND BOTH NUMBERS. "The counts do not match" sends an
 * operator through twenty-seven tables; "companies: the backup recorded 42 rows
 * and this database holds 41" ends the search.
 */
export class RestoreInventoryMismatchError extends Error {
  constructor(
    readonly disagreements: readonly InventoryDisagreement[],
    readonly safetyBackupPath: string | null,
    readonly recoveryCommands: readonly string[],
  ) {
    const describe = (one: InventoryDisagreement): string =>
      one.restored === null
        ? `${one.table} is not in the restored database at all (the backup recorded `
          + `${String(one.recorded ?? 0)} row(s))`
        : one.recorded === null
          ? `${one.table} holds ${String(one.restored)} row(s) and the backup does not list it`
          : `${one.table}: the backup recorded ${String(one.recorded)} row(s) and this `
            + `database holds ${String(one.restored)}`;
    super(
      "the backup loaded and was committed, but the restored database is not what the backup "
      + "recorded the original holding: "
      + disagreements.slice(0, 10).map(describe).join("; ")
      + (disagreements.length > 10
        ? `; and ${String(disagreements.length - 10)} more` : "")
      + ". The restore has HAPPENED -- check the data before using this install. mail.key was "
      + "NOT replaced and no migrations were run, so this install still holds its own mail "
      + "encryption key."
      + (safetyBackupPath === null ? ""
        : ` A safety backup of the previous state is at ${safetyBackupPath}. To go back:\n`
          + recoveryCommands.map((line) => `  ${line}`).join("\n")),
    );
    this.name = "RestoreInventoryMismatchError";
  }
}

/**
 * WHAT THE DATABASE IS, MEASURED -- AND THE MEASUREMENT IS AN IDENTITY, NOT A
 * COUNT.
 *
 * A COUNT CANNOT SEE THE FAILURE THIS EXISTS FOR, and that was measured rather
 * than argued. A half-applied load recreates exactly the schemas and tables it
 * dropped, because the backup and the install share a schema -- so "two
 * schemas, twenty-seven tables" reads identically before and after. Measured on
 * the deploy target, cutting a dump at a clean EOF inside its COPY data:
 *
 *   psql exit ................... 0        <- it COMMITTED
 *   the install's own table ..... destroyed
 *   rows loaded ................. 21 of 500
 *   table count before / after .. 1 / 1     <- a count says NOTHING HAPPENED
 *   pg_class oids before/after .. DIFFERENT <- an identity says what did
 *
 * So `tableIds` is the load-bearing field. A rolled-back DROP leaves the
 * original catalogue rows untouched and their oids identical; a committed one
 * recreates every table with a new oid. It costs one catalogue query -- no
 * count(*) over the operator's data -- and it is exact.
 *
 * The same argument this module makes against pg_stat_user_tables applies
 * verbatim to a table count. Both are summaries, and a summary of a
 * replacement looks like the thing it replaced.
 */
export interface DatabaseShape {
  /** Every non-system schema, sorted. */
  readonly schemas: readonly string[];
  /** Ordinary and partitioned tables across those schemas. */
  readonly tables: number;
  /**
   * Every table's catalogue identity (pg_class.oid), sorted.
   *
   * THE FIELD THAT DISTINGUISHES A ROLLBACK FROM A REPLACEMENT. See above.
   */
  readonly tableIds: readonly string[];
  /**
   * Every table's schema-qualified name, sorted.
   *
   * WHAT THE RESULT IS COMPARED AGAINST. The oids say whether the tables were
   * replaced; the names say whether the RIGHT ones are there.
   */
  readonly tableNames: readonly string[];
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
  const tables = await db.execute<{ id: string; name: string }>(sql`
    SELECT c.oid::text AS id, n.nspname || '.' || c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    ORDER BY c.oid
  `);
  const tableIds = tables.map((row) => row.id);
  return {
    schemas: schemas.map((row) => row.nspname),
    tables: tableIds.length,
    tableIds,
    tableNames: tables.map((row) => row.name).sort(),
  };
}

/**
 * Whether two measurements describe the same database.
 *
 * ONE COMPARISON FOR BOTH LISTS, and that is a repair rather than tidiness. The
 * first version wrote the length check and the element check as separate
 * clauses per list, and deleting the LENGTH clause changed nothing any test
 * could see: `every` is vacuously true where one list is a PREFIX of the other,
 * so ["public"] and ["public", "leftover"] compared equal. Two clauses, each
 * masking the other's absence -- the fourth time that pattern has been found on
 * this project. There is now one helper and one place for it to be wrong.
 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, at) => b[at] === value);
}

export function sameShape(a: DatabaseShape, b: DatabaseShape): boolean {
  return sameList(a.schemas, b.schemas) && sameList(a.tableIds, b.tableIds);
}

/**
 * The arguments psql is spawned with, and the ONE cell of the matrix that is
 * both safe and truthful. See the matrix at the top of this file.
 *
 * EXPORTED SO A TEST CAN ASSERT WHAT IS IN IT, but the flags are not held by
 * that assertion alone -- an argument list a test agrees with is not evidence.
 * Removing `--single-transaction` makes a failed load genuinely half-apply,
 * which the post-failure measurement catches and reports as
 * RestoreHalfAppliedError.
 *
 * REMOVING ON_ERROR_STOP IS CAUGHT BY THE ROLLBACK TESTS AND BY NOTHING ELSE,
 * and an earlier version of this comment said the table count caught it. IT
 * DOES NOT: measured, applyRestore RETURNS SUCCESS, because a load that errored
 * part way still created every table and the count therefore matches. Four
 * tests fail on that mutation, and every one of them fails because it expected
 * a REFUSAL and did not get one. This module's header says the same thing 400
 * lines above -- "the flag is what catches it; nothing else was" -- and two
 * statements in one file disagreeing is how the next reader stops looking.
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
 * What psql did, and -- separately -- whether it was given the whole dump.
 *
 * THE SECOND FIELD IS NOT A DETAIL. See runPsqlLoad.
 */
interface PsqlLoadResult {
  code: number;
  stderr: string;
  /**
   * Bytes of the dump that actually reached psql's stdin.
   *
   * THE ONE THE CALLER DECIDES ON, against the size the plan published.
   */
  streamedBytes: number;
  /**
   * The stream's own failure, if it had one. Null when it ended by itself.
   *
   * DIAGNOSTIC, NOT A GUARD. A stream that fails delivers fewer bytes, so this
   * never fires where `streamedBytes` does not -- it exists to say WHY the
   * bytes stopped, in the message somebody reads at the worst moment.
   */
  streamError: Error | null;
}

/**
 * Run psql over the preamble and then the dump, as one transaction.
 *
 * THE EXIT CODE IS NOT ENOUGH, AND THIS IS THE WORST BUG THIS MODULE HAS HAD.
 * psql's stdin is a pipe. A dump that stops early -- a read error, a truncated
 * staged file, a stream destroyed by a failed pipeline -- reaches psql as a
 * CLEAN END OF FILE, and `--single-transaction` responds to end of file by
 * issuing COMMIT. Measured on the deploy target, cutting a real dump inside its
 * COPY data and feeding it to the exact command this module runs:
 *
 *   psql exit ............... 0
 *   the install's own table . destroyed
 *   rows loaded ............. 21 of 500, committed
 *
 * An earlier version of this function wrote `void pipeline(...).catch(() => {})`
 * and said in a comment that the exit code was the outcome. It is not: the exit
 * code cannot distinguish "the dump ended" from "the dump was cut off", because
 * to psql those are the same event. So the SOURCE is measured too -- how many
 * bytes reached the child, and whether the stream failed -- and the caller
 * compares that against the size the plan published. A load that was not given
 * the whole dump FAILED, whatever psql says about it.
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
}): Promise<PsqlLoadResult> {
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

    let streamedBytes = 0;
    let streamError: Error | null = null;
    let streamSettled = false;
    let closed: { code: number } | null = null;
    // BOTH HALVES MUST HAVE SETTLED, and the reason is NOT the one this comment
    // used to give. It said "psql closes only after reading to end of file, so
    // the counter is already final" -- which is false, and falsest in the cases
    // that matter: an ON_ERROR_STOP abort closes stdin mid-stream, and so does
    // `\q`, which is why ALLOWED_META_COMMANDS exists at all. A label that
    // tells the next reader not to look has to be true.
    //
    // The guarantee that actually holds is weaker and still enough: when the
    // counter is NOT final, the outcome is the same either way -- a mid-flight
    // count is short, a settled count after an early close is also short, and
    // either routes to the failure path, as does the non-zero exit that
    // accompanies most early closes. So no test can discriminate it, and it is
    // kept for a narrower reason: it makes `streamError` deterministic, so the
    // sentence an operator reads at the worst possible moment says WHY the
    // bytes stopped rather than only that they did.
    const finish = (): void => {
      if (closed === null || !streamSettled) return;
      resolve({
        code: closed.code,
        stderr: Buffer.concat(errors).toString("utf8").slice(0, STDERR_CAP_BYTES),
        streamedBytes,
        streamError,
      });
    };

    child.on("close", (code) => { closed = { code: code ?? -1 }; finish(); });
    child.stdin.write(options.preamble);
    // BOTH HALVES ARE WAITED FOR, and the stream's outcome is KEPT. A psql that
    // exits early makes this reject with EPIPE -- that one is not interesting,
    // because the exit code is non-zero and says so. The interesting rejection
    // is the other direction: a source that failed while psql was perfectly
    // happy, which the caller can only see from here.
    void pipeline(
      options.dump,
      async function* count(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          streamedBytes += chunk.length;
          yield chunk;
        }
      },
      child.stdin,
    ).then(
      () => { streamSettled = true; finish(); },
      (error: unknown) => {
        streamError = error instanceof Error ? error : new Error(String(error));
        streamSettled = true;
        finish();
      },
    );
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
 * THE ONLY psql META-COMMANDS A PLAIN pg_dump EMITS.
 *
 * MEASURED, not assumed: every backslash line in a real dump of conduit_test on
 * the deploy target, counted by kind, is one of exactly three --
 *
 *   \.            the COPY terminator (inside a COPY block, handled by state)
 *   \restrict     opens the dump
 *   \unrestrict   closes it
 *
 * Anything else is refused, and the reason is not tidiness. `\q` MAKES psql
 * COMMIT A PREFIX: measured with the exact command this module runs, a script
 * whose second line is `\q` exits 0 with one of three INSERTs committed and the
 * rest silently discarded. psql closes WITHOUT READING TO END OF FILE, so the
 * byte count sees a fully delivered file, ON_ERROR_STOP sees no error, and
 * `--single-transaction` commits what ran. Every process instrument passes.
 *
 * `\i`, `\o` and `\!` are worse in kind rather than degree -- they read files,
 * write files and run shell commands as the account this process runs as -- and
 * `\connect` would load the dump into a DIFFERENT DATABASE than the one the
 * preview described.
 *
 * THIS IS WHAT MAKES THE OTHER INSTRUMENTS MEAN ANYTHING. "psql exited 0 and
 * was handed every byte" only implies "the whole dump ran" if the dump cannot
 * tell psql to stop. It is not a security boundary: whoever built the archive
 * could put any SQL they liked in it, and the operator supplied the passphrase.
 * It is an INTEGRITY boundary, which is the one this module needs.
 */
const ALLOWED_META_COMMANDS = ["\\restrict ", "\\unrestrict "];

/** What one line of a dump is, read the way psql reads it. */
export type DumpLine =
  | { kind: "table"; name: string }
  | { kind: "meta"; command: string }
  | { kind: "other" };

/**
 * Read one line of a plain pg_dump.
 *
 * THE COPY DATA IS SKIPPED, AND IT HAS TO BE. A dump's COPY blocks carry the
 * operator's own text -- a note body, a company name -- and a row whose value
 * begins a line with "CREATE TABLE ", or with a backslash, would otherwise be
 * read as SQL. The state machine is psql's own rule: everything between a
 * `COPY ... FROM stdin;` and the `\.` on a line by itself is data.
 *
 * THE TABLE'S NAME, NOT JUST A TALLY. A count is satisfied by any twenty-seven
 * tables; the names are what let the load say WHICH of them failed to arrive.
 * Measured against the real thing: a plain dump of conduit_test has 27
 * `CREATE TABLE` statements and the database it came from has exactly those 27
 * tables, schema-qualified and matching name for name.
 */
export function readDumpLine(line: string, state: { inCopy: boolean }): DumpLine {
  if (state.inCopy) {
    if (line === "\\.") state.inCopy = false;
    return { kind: "other" };
  }
  if (/^COPY .* FROM stdin;\s*$/.test(line)) {
    state.inCopy = true;
    return { kind: "other" };
  }
  if (line.startsWith("\\")) {
    if (ALLOWED_META_COMMANDS.some((allowed) => line.startsWith(allowed))) {
      return { kind: "other" };
    }
    return { kind: "meta", command: line.trim().split(/\s+/)[0] ?? line.trim() };
  }
  const table = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([^\s(]+)/.exec(line);
  return table === null ? { kind: "other" } : { kind: "table", name: table[1] ?? "" };
}

/** What a dump says it will create, and anything in it that must not run. */
interface DumpContents {
  /** Every table the dump creates, schema-qualified, in the order declared. */
  tables: string[];
  /** The first meta-command that is not one pg_dump emits, or null. */
  forbidden: string | null;
}

/** Read a dump without holding it: one pass, bounded memory. */
async function readDumpContents(stream: Readable): Promise<DumpContents> {
  const state = { inCopy: false };
  const tables: string[] = [];
  let forbidden: string | null = null;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const read = readDumpLine(line, state);
    if (read.kind === "table") tables.push(read.name);
    else if (read.kind === "meta" && forbidden === null) forbidden = read.command;
  }
  return { tables, forbidden };
}

/** What a manifest's `inventory` field turned out to be. */
export type InventoryRead =
  | { kind: "absent" }
  | { kind: "unreadable"; why: string }
  | { kind: "present"; tables: BackupInventoryTable[] };

/**
 * READ manifest.json's INVENTORY, AND TELL THE THREE CASES APART.
 *
 * THE WHOLE FUNCTION IS THE DISTINCTION BETWEEN "NO INVENTORY" AND "AN
 * INVENTORY OF NOTHING", which is the thing a reader of this format has to be
 * able to do:
 *
 *   the key is not there ...... ABSENT. A v1.3.0-era backup. The check is
 *                               reported as NOT MADE, and the restore proceeds.
 *   "tables": [] .............. PRESENT, and a positive claim that the database
 *                               held no tables. The check IS made, against an
 *                               empty list, and a restored database with tables
 *                               in it fails it.
 *   anything else ............. UNREADABLE. Refused, with nothing written.
 *
 * `null` COUNTS AS ABSENT, and that is not sloppiness about JSON. `undefined`
 * cannot survive a round trip through JSON at all, so a writer that meant "no
 * inventory" and emitted `"inventory": null` has said the same thing as one
 * that omitted the key; treating the two differently would refuse an archive
 * over a serialiser's choice.
 *
 * PURE, SO EVERY CASE IS A VALUE. No archive, no database, no destruction --
 * the whole table above is assertable without any of them.
 */
export function readInventory(raw: unknown): InventoryRead {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "unreadable", why: "it is not an object" };
  }
  const inventory = raw as { consistency?: unknown; tables?: unknown };
  // THE CONSISTENCY LABEL IS CHECKED, NOT READ PAST. The counts are only
  // comparable if they were taken from the dump's own snapshot, and this build
  // knows exactly one way that is true. A label it does not recognise is a
  // claim it cannot evaluate, and the safe answer to a claim you cannot
  // evaluate, on the path that replaces a database, is to stop.
  if (typeof inventory.consistency !== "string") {
    return { kind: "unreadable", why: "it does not say how its counts were taken" };
  }
  if (inventory.consistency !== INVENTORY_CONSISTENCY) {
    return {
      kind: "unreadable",
      why: `its counts are labelled "${inventory.consistency}", which this version of `
        + "Conduit does not know how to check",
    };
  }
  if (!Array.isArray(inventory.tables)) {
    return { kind: "unreadable", why: "it does not list any tables" };
  }
  const tables: BackupInventoryTable[] = [];
  const seen = new Set<string>();
  for (const entry of inventory.tables as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return { kind: "unreadable", why: "one of its entries is not a table" };
    }
    const { table, rows } = entry as { table?: unknown; rows?: unknown };
    if (typeof table !== "string" || table === "") {
      return { kind: "unreadable", why: "one of its entries has no table name" };
    }
    // Number.isSafeInteger, not Number.isInteger: a row count beyond 2^53 could
    // not be compared with a measured one anyway, and a manifest carrying one
    // is not a manifest this can check.
    if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0) {
      return {
        kind: "unreadable",
        why: `it does not record a whole number of rows for ${table}`,
      };
    }
    // TWO ENTRIES FOR ONE TABLE CANNOT BOTH BE CHECKED, and picking one would be
    // picking which claim to ignore.
    if (seen.has(table)) {
      return { kind: "unreadable", why: `it lists ${table} twice` };
    }
    seen.add(table);
    tables.push({ table, rows });
  }
  return { kind: "present", tables };
}

/**
 * WHERE THE BACKUP'S RECORD AND THE RESTORED DATABASE DISAGREE.
 *
 * BOTH DIRECTIONS, and both are failures. A table the backup recorded that is
 * not in the restored database is the obvious one; a table in the restored
 * database that the backup never recorded is the same failure wearing the other
 * hat, because it means the load produced something the backup did not
 * describe. An earlier shape of this compared only the recorded side, and
 * `every` over the recorded list is vacuously satisfied by a database holding
 * everything plus more -- the prefix mask this project has now paid for four
 * times.
 *
 * PURE AND EXPORTED, so the comparison is assertable without a restore.
 */
export function compareInventory(
  recorded: readonly BackupInventoryTable[],
  restored: readonly BackupInventoryTable[],
): InventoryDisagreement[] {
  const recordedRows = new Map(recorded.map((one) => [one.table, one.rows]));
  const restoredRows = new Map(restored.map((one) => [one.table, one.rows]));
  const disagreements: InventoryDisagreement[] = [];
  for (const table of [...new Set([...recordedRows.keys(), ...restoredRows.keys()])].sort()) {
    const was = recordedRows.get(table) ?? null;
    const now = restoredRows.get(table) ?? null;
    if (was !== now) disagreements.push({ table, recorded: was, restored: now });
  }
  return disagreements;
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
  /**
   * Every table measured at preview time, schema-qualified and sorted.
   *
   * THE SCHEMA LIST ALONE WAS NOT THE THING THE OPERATOR WAS SHOWN, and that
   * gap was measured rather than argued: a table created between the preview
   * and the apply was DESTROYED while the preview said 27 and the database held
   * 28, RestoreDatabaseChangedError did not fire, and the answer was 200. The
   * re-measure now compares this list too, so the one effect marked
   * `destroys: true` is checked against the whole of what was previewed rather
   * than against the coarser half of it.
   */
  readonly tableNames: readonly string[];
  /**
   * How many rows those tables held when the preview was taken.
   *
   * THE SPEC'S GUARD REQUIREMENT, WHICH NOTHING IMPLEMENTED UNTIL NOW: "a plain
   * statement of what is about to be destroyed -- row counts from the live
   * database, so the operator sees what they are replacing rather than an
   * abstraction". A table count is the abstraction that sentence refuses.
   *
   * IT IS SHOWN AND NEVER ENFORCED, and the difference matters. Rows change
   * every time anybody uses the install, so refusing a restore because the
   * number moved would refuse every restore; the SHAPE is what must not have
   * changed, and that is what the re-measure compares. This is the sentence
   * under the confirmation, not a lock.
   */
  readonly rows: number;
}

export interface LoadDumpEffect extends PlannedEffect {
  readonly op: "load-dump";
  /**
   * How many bytes of dump the load must deliver to psql.
   *
   * ON THE EFFECT BECAUSE THE HANDLER CANNOT ASK. A staged member is reachable
   * only through a ref, and a ref carries no size -- so without this the step
   * has no way to tell a dump that ENDED from one that was CUT OFF, and psql
   * cannot tell it either: both arrive as a clean end of file, and
   * `--single-transaction` commits on end of file. See runPsqlLoad.
   */
  readonly dumpBytes: number;
  /**
   * Every table the dump creates, schema-qualified, as the dump declares them.
   *
   * A RESULT, NOT A PROCESS. Every other instrument on this step measures how
   * the load WENT -- the exit code, the bytes delivered, the flags. This is the
   * only one that measures what the load LEFT, and it is what the tables in the
   * database are compared against afterwards. Names rather than a tally,
   * because a tally is satisfied by any twenty-seven tables and cannot say
   * which one is missing.
   */
  readonly tables: readonly string[];
  /**
   * What the backup recorded the database HOLDING -- tables and exact row
   * counts -- or NULL when the backup recorded nothing.
   *
   * THE WITNESS THAT IS NOT THE DUMP. `tables` above is read out of
   * `database.sql`, which is the file the load consumes; this comes from
   * `manifest.json`, which services/backup.ts measured against the live
   * catalogue. A backup that was wrong when it was written passes the first and
   * fails this one.
   *
   * NULL IS "NOT RECORDED", AND AN EMPTY ARRAY IS "NOTHING WAS THERE". They
   * cannot be the same value or a v1.3.0 archive would silently pass a check it
   * never made. On the plan for the same reason every other decision is: apply
   * may do nothing inspect did not describe, and "verify these row counts" is
   * work.
   */
  readonly inventory: readonly BackupInventoryTable[] | null;
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

  // AN EXPORT IS NOT A BACKUP, and this is decided from the manifest rather
  // than inferred from a member list. Restoring an export would replace the
  // database with one that has no mail and no credentials.
  //
  // THE COMPARISON IS POSITIVE AND THE ABSENCE IS WHAT REFUSES AN EXPORT, said
  // plainly because this comment used to read as though services/export.ts
  // wrote `kind: "export"`. IT DOES NOT -- its ExportManifest has no `kind`
  // field at all -- so an export is refused here by not saying "backup", which
  // is the stricter behaviour and the one to keep: every archive whose manifest
  // does not positively declare itself a Conduit backup is refused, not merely
  // the ones this project happens to write. The message below names an export
  // because that is overwhelmingly what somebody will have handed it.
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

  // THE INVENTORY, READ FROM THE MANIFEST ALONE, so an archive that cannot be
  // checked is refused before 300MB of blobs are hashed. See readInventory for
  // the three cases and why "absent" is not "empty".
  const inventory = readInventory(manifest.inventory);
  if (inventory.kind === "unreadable") {
    return refuse(options, {
      code: RESTORE_REFUSALS.inventoryUnreadable,
      message: "this backup records what its database held, and that record cannot be read: "
        + `${inventory.why}. It is refused rather than ignored, because ignoring it would `
        + "restore without the one check that can tell whether the result matches what was "
        + "backed up. Nothing has been changed.",
    });
  }

  // THE MEMBER LIST IS A LIST, and a manifest whose `members` is missing or is
  // not an array described nothing. It used to be read as
  // `Array.isArray(...) ? ... : []`, which turned "this manifest makes no
  // claims at all" into "this manifest makes zero claims and they all hold".
  if (!Array.isArray(manifest.members)) {
    return refuse(options, {
      code: RESTORE_REFUSALS.manifestUnreadable,
      message: "this backup's manifest does not list what is in the archive, so nothing in "
        + "it can be checked.",
    });
  }
  const listed = manifest.members;

  // THE TWO MEMBERS THE RESTORE CANNOT DO WITHOUT, AND THEY MUST BE IN THE
  // MANIFEST, NOT MERELY IN THE ARCHIVE. This check used to ask payload.byName,
  // which reads the ARCHIVE, while its own comment claimed it caught "a
  // manifest that simply omitted them" -- and that gap was a silent
  // half-restore, measured. Dropping database.sql from `members` meant the
  // digest sweep below never looked at it, so a corrupted dump inspected
  // clean, applied, and emptied every table with `unrealised: []` and no error.
  //
  // The manifest entry is also where the load's byte count comes from, and that
  // is the point of finding it here: a size taken from a stat() of the file the
  // load is about to stream is a comparison of a file with itself.
  //
  // SAID PLAINLY: once the sweep below has checked the manifest's size AND
  // digest against the archive, the two numbers are equal, so mutation testing
  // cannot tell this provenance from the old one. It is kept because the
  // manifest is the DECLARED witness and the staged file is the thing being
  // judged -- and because the sweep is what makes them equal, which is a
  // guard, and which is tested.
  const dumpEntry = listed.find((entry) => entry.path === DUMP_MEMBER);
  const keyEntry = listed.find((entry) => entry.path === MAIL_KEY_MEMBER);
  for (const [name, entry] of [[DUMP_MEMBER, dumpEntry], [MAIL_KEY_MEMBER, keyEntry]] as const) {
    if (entry === undefined) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberMissing,
        message: `this backup's manifest does not list ${name}, so the archive cannot be `
          + "checked against it and must not be restored.",
      });
    }
    if (payload.byName(name) === undefined) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberMissing,
        message: `this backup is incomplete: it has no ${name}.`,
      });
    }
  }
  if (dumpEntry === undefined || keyEntry === undefined) return refuse(options, {
    code: RESTORE_REFUSALS.memberMissing,
    message: "this backup is incomplete.",
  });
  const dumpMember = payload.byName(DUMP_MEMBER);
  const keyMember = payload.byName(MAIL_KEY_MEMBER);
  if (dumpMember === undefined || keyMember === undefined) return refuse(options, {
    code: RESTORE_REFUSALS.memberMissing,
    message: "this backup is incomplete.",
  });

  // EVERY LISTED MEMBER MUST BE PRESENT AND MUST BE ITS OWN DIGEST. This is
  // the corruption check, and it is separate from 7z's: 7z verifies that the
  // archive decompressed to what was compressed, which says nothing about
  // whether what was compressed is what the manifest claims. A member swapped
  // for another whole, well-formed file passes 7z and fails here.
  //
  // LAST, because it is the only check that reads the whole archive. Every
  // refusal above answers from the manifest alone, so an operator who uploaded
  // the wrong file is told so without 300MB of blobs being hashed first.
  for (const entry of listed) {
    const member = payload.byName(entry.path);
    if (member === undefined) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberMissing,
        message: `this backup is incomplete: its manifest lists ${entry.path} and the archive `
          + "does not contain it.",
      });
    }
    // THE SIZE AS WELL AS THE DIGEST, and the size first because it is free.
    // The manifest's `bytes` is what the load's budget is taken from -- see
    // LoadDumpEffect.dumpBytes -- so a manifest whose size is wrong would be
    // discovered by the LOAD, half way through replacing the database, rather
    // than here where nothing has been touched.
    if (entry.bytes !== member.bytes) {
      return refuse(options, {
        code: RESTORE_REFUSALS.memberCorrupt,
        message: `this backup is damaged: its manifest says ${entry.path} is `
          + `${String(entry.bytes)} bytes and the archive holds ${String(member.bytes)}.`,
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

  // THE CHECK THAT WILL NOT BE MADE, SAID OUT LOUD. A backup taken by Conduit
  // 1.3.0 records no inventory, and this restore is the one that closes the
  // hole -- so the operator is told the difference rather than left to assume
  // every check ran. Reported as NOT MADE, never as passed.
  if (inventory.kind === "absent") {
    findings.push({
      severity: "warning",
      code: RESTORE_FINDINGS.inventoryMissing,
      message: "this backup does not record what its database held when it was taken, so the "
        + "restored result cannot be checked against it. Backups taken by Conduit 1.4.0 and "
        + "later carry that record; this one was written by an earlier version. The restore "
        + "itself is unaffected -- what is missing is a check, not data.",
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
  // WHAT THE OPERATOR IS ABOUT TO REPLACE, COUNTED. The spec asks for "row
  // counts from the live database, so the operator sees what they are replacing
  // rather than an abstraction", and until now the preview carried only a table
  // count -- which is the abstraction that sentence names. THE SAME FUNCTION
  // services/backup.ts USES, so the number under the confirmation and the number
  // a backup records cannot drift into meaning different things, and so a
  // restore that shows "14,204 rows" is showing what the archive would record.
  const liveInventory = await measureInventory(db);
  const liveRows = liveInventory.reduce((total, one) => total + one.rows, 0);
  const dump = await readDumpContents(await payload.open(dumpMember.ref));
  // A DUMP THAT CAN TELL psql TO STOP IS REFUSED, and this is what makes every
  // other instrument mean something -- see ALLOWED_META_COMMANDS. Refused
  // BEFORE anything is destroyed, like every other refusal here.
  if (dump.forbidden !== null) {
    return refuse(options, {
      code: RESTORE_REFUSALS.dumpMetaCommand,
      message: `this backup's database file contains ${dump.forbidden}, which is a psql `
        + "command rather than data and is not something a Conduit backup contains. It could "
        + "make only part of the backup load while reporting success, so it is refused.",
      });
  }
  const dumpTables = dump.tables.length;
  const inventoryRows = inventory.kind === "present"
    ? inventory.tables.reduce((total, one) => total + one.rows, 0)
    : 0;
  // THE MILLISECONDS ARE IN THE NAME, AND THEY WERE PUT BACK AFTER A CI RUN
  // REFUSED A PERFECTLY GOOD RESTORE. This stamp used to be trimmed to whole
  // seconds, which reads better and is wrong: the safety backup is written with
  // `wx`, so a second plan made inside the same second produces the SAME path
  // and the write fails with EEXIST -- reported as RestoreSafetyBackupError,
  // which says the restore did not start and names a file the operator did not
  // create. The sequence that reaches it is the ordinary one: a restore that
  // fails fast, and a second attempt. On the dev server the gap between two
  // attempts crossed a second boundary and it never showed; on a faster machine
  // it did not. `wx` STAYS -- truncating what might be somebody's only undo is
  // exactly what it exists to prevent -- so the name is what has to be unique.
  const stamp = now.toISOString().replace(/[:.]/g, "-");
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
      detail: `Everything in this database is dropped: ${String(liveRows)} row(s) in `
        + `${String(shape.tables)} table(s) across ${String(shape.schemas.length)} schema(s). `
        + "This happens in the same transaction as the load below, so if the load fails "
        + "nothing here is destroyed.",
      // FROZEN HERE BECAUSE THE SPINE CANNOT DO IT. newPlan copies and freezes
      // every effect and knows to freeze `sources` as well, because Object.freeze
      // is shallow -- but `schemas` is restore's own array on restore's own
      // effect, and nothing in intake-plan.ts has heard of it. Left live, a
      // caller still holding it could add a schema to the destruction after the
      // preview had been rendered, which is the exact escape newPlan's own
      // comment describes for `sources`.
      schemas: Object.freeze([...shape.schemas]),
      // FROZEN FOR THE REASON `schemas` IS: newPlan freezes what it knows about,
      // and restore's own arrays are not among them. This one is compared at
      // apply time, so a caller who could edit it after the preview had been
      // rendered could widen what the re-measure agrees to destroy.
      tableNames: Object.freeze([...shape.tableNames]),
      rows: liveRows,
      realisedBy: "load-dump",
    },
    {
      op: "load-dump",
      subject: "the backup's database",
      count: dumpTables,
      unit: "table",
      destroys: false,
      detail: `${String(dumpTables)} table(s) from the backup replace what was there. The `
        + `whole ${String(dumpEntry.bytes)} bytes must reach the loader, and the tables that `
        + "arrive are counted afterwards rather than taken from an exit code."
        + (inventory.kind === "present"
          ? ` The backup also records the ${String(inventoryRows)} row(s) its database held `
            + `across ${String(inventory.tables.length)} table(s), and the restored database `
            + "is counted against that."
          : " This backup records no row counts to check the result against."),
      sources: [dumpMember.ref],
      dumpBytes: dumpEntry.bytes,
      // FROZEN HERE for the reason `schemas` is: newPlan freezes what it knows
      // about, and restore's own arrays are not among them.
      tables: Object.freeze([...dump.tables]),
      // NULL WHEN THE BACKUP RECORDED NONE, never an empty array standing in
      // for it. See LoadDumpEffect.inventory.
      inventory: inventory.kind === "present"
        ? Object.freeze(inventory.tables.map((one) => Object.freeze({ ...one })))
        : null,
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
        // REMOVED ON EVERY EXIT PATH, which is the spine's rule for anything
        // this writes and not a nicety: a failed rename would otherwise leave a
        // whole blob under a name nothing will ever look at or clean up.
        try {
          await pipeline(await ctx.open(ref), createWriteStream(temp, { mode: 0o600 }));
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
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
      // BOTH LISTS, THROUGH THE ONE HELPER. The schema comparison was hand-rolled
      // here and checked the schemas alone, which let a table created between the
      // preview and the apply be destroyed with the answer still 200 -- measured.
      // `sameList` is the module's own repair for exactly this shape of bug (see
      // its comment), so there is one place for it to be wrong instead of two
      // more.
      if (!sameList(current.schemas, planned)) {
        throw new RestoreDatabaseChangedError(
          `this database no longer looks the way the preview described it: it had `
          + `${planned.join(", ")} and now has ${current.schemas.join(", ")}. Nothing has been `
          + "changed. Take the preview again.",
        );
      }
      if (!sameList(current.tableNames, effect.tableNames)) {
        // THE TABLES THAT DIFFER, NOT A COUNT. "It said 27 and there are 28"
        // sends an operator through the whole schema; naming the tables ends
        // the search, and it is the same choice RestoreUnexpectedResultError
        // makes one step later.
        const plannedTables = new Set(effect.tableNames);
        const appeared = current.tableNames.filter((name) => !plannedTables.has(name));
        const currentTables = new Set(current.tableNames);
        const gone = effect.tableNames.filter((name) => !currentTables.has(name));
        throw new RestoreDatabaseChangedError(
          "this database no longer holds the tables the preview described: it said "
          + `${String(effect.tableNames.length)} and it now has `
          + `${String(current.tableNames.length)}`
          + (appeared.length === 0 ? "" : `, with ${appeared.slice(0, 10).join(", ")} added`)
          + (gone.length === 0 ? "" : `, with ${gone.slice(0, 10).join(", ")} gone`)
          + ". Nothing has been changed. Take the preview again.",
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

      // THE LOAD FAILED IF psql SAID SO **OR** IF THE DUMP DID NOT ALL ARRIVE,
      // and the second half is not redundant with the first. psql cannot tell a
      // dump that ended from one that was cut off -- both are a clean end of
      // file, and --single-transaction COMMITS on end of file. Measured: a dump
      // cut inside its COPY data gives exit 0 over a database whose own tables
      // have been dropped and 21 of 500 rows committed in their place. So the
      // source is checked against the size the plan published, and a stream
      // that failed is a failure whatever the child reported.
      // ONE TEST OF IT, NOT TWO. An earlier version asked "did the stream fail
      // OR did it come up short", and mutation testing found the first half was
      // not independently observable: a stream that fails delivers fewer bytes,
      // so the SAME fixture satisfied both and deleting either changed nothing.
      // Two clauses that cannot be told apart are the two-layer mask this
      // project keeps paying for, so there is one clause. `streamError` is kept
      // for the MESSAGE, where it says why the bytes stopped, and decides
      // nothing.
      const delivered = result.streamedBytes === effect.dumpBytes;
      if (result.code !== 0 || !delivered) {
        // WHAT ACTUALLY HAPPENED IS MEASURED, and by IDENTITY rather than by
        // count -- see DatabaseShape. A half-applied load recreates exactly the
        // schemas and table count it dropped, so a count would report "nothing
        // was replaced" over a database whose rows are gone.
        let after: DatabaseShape | null = null;
        let unmeasurable = "";
        try {
          after = await shapeOf(db);
        } catch (error) {
          unmeasurable = `the database could not be measured afterwards: ${errorText(error)}`;
        }
        const why = result.code !== 0
          ? `psql exited ${String(result.code)}`
          : result.streamError !== null
            ? `the backup's database file could not be read: ${result.streamError.message}`
            : `only ${String(result.streamedBytes)} of ${String(effect.dumpBytes)} bytes of the `
              + "backup's database reached the loader, so psql was given a truncated file and "
              + "committed what it had";
        // `after !== null` is exactly `unmeasurable === ""` and is not written
        // twice; this module names that pattern four times and had it here.
        if (before !== null && after !== null && sameShape(before, after)) {
          throw new RestoreLoadFailedError(
            "the backup's database could not be loaded, and the whole attempt was rolled "
            + "back. This install is exactly as it was before you started: nothing was "
            + `destroyed and nothing was replaced. (${why})`,
            result.stderr,
          );
        }
        throw new RestoreHalfAppliedError(
          safetyBackupPath,
          recoveryCommands(safetyBackupPath, databaseUrl, schemasToClear(before, after)),
          unmeasurable !== "" ? `${why}; ${unmeasurable}`
            : `${why}; it held ${describeShape(before)} before the load and `
              + `${describeShape(after)} now`,
        );
      }

      // THE LOAD COMMITTED, AND NOW THE RESULT IS CHECKED RATHER THAN THE
      // PROCESS. Every instrument above measures how the load WENT; this one
      // measures what it LEFT, against the tables the dump said it would
      // create. Names, not a tally: a tally is satisfied by any twenty-seven
      // tables and cannot say which one is absent.
      //
      // A MISMATCH IS NOT AN ACCOUNTING BUG, so it is not left to the frame.
      // The database has already been replaced; a PlanExceededError out of the
      // executor would travel unwrapped, name no safety backup, and tell the
      // operator "the plan said otherwise" about a restore that has happened.
      const loaded = await shapeOf(db);
      const present = new Set(loaded.tableNames);
      const missing = [...effect.tables].filter((name) => !present.has(name)).sort();
      if (missing.length > 0 || loaded.tables !== effect.count) {
        throw new RestoreUnexpectedResultError(
          effect.count, loaded.tables, missing, safetyBackupPath,
          recoveryCommands(safetyBackupPath, databaseUrl, [...loaded.schemas]),
        );
      }

      // AND NOW THE SAME QUESTION ASKED OF A DIFFERENT WITNESS. The check above
      // compares the result with the DUMP, which is the file this load just
      // consumed -- so it cannot see a backup that was already wrong when it was
      // written. This compares the result with what the backup RECORDED THE
      // DATABASE HOLDING, measured from the live catalogue at backup time in the
      // dump's own snapshot.
      //
      // SECOND, NOT FIRST, and the order is chosen rather than incidental. The
      // dump check is free -- `loaded` is already in hand -- while this one
      // counts every row in every table, so a restore that produced the wrong
      // TABLES says so without first counting rows in them. The two are
      // separable in what they can see, not only in what they cost: a backup
      // whose inventory disagrees with its own dump passes the first check and
      // fails this one, and a load that lost a table the dump declared fails the
      // first and never reaches this one.
      //
      // NULL IS "THE BACKUP RECORDED NONE", and it is the v1.3.0 case. Skipping
      // is what backward compatibility means here; the operator was told at
      // preview time that this check would not be made.
      if (effect.inventory !== null) {
        // MEASURED WITH THE SAME FUNCTION THAT WROTE IT, so the two sides of the
        // comparison cannot drift into disagreeing about what a table is. This
        // runs BEFORE migrate-forward, deliberately: the inventory describes the
        // backup's schema, and a database already migrated past it would be
        // compared against a record of something else.
        const restored = await measureInventory(db);
        const disagreements = compareInventory(effect.inventory, restored);
        if (disagreements.length > 0) {
          throw new RestoreInventoryMismatchError(
            disagreements, safetyBackupPath,
            recoveryCommands(safetyBackupPath, databaseUrl, [...loaded.schemas]),
          );
        }
      }
      ctx.spend(effect.count);
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
      try {
        await writeFile(temp, bytes, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, mailKeyPath);
      } catch (error) {
        // THE RESIDUAL WINDOW, NAMED RATHER THAN LEFT TO BE FOUND. The database
        // has already committed by the time this runs -- that ordering is
        // deliberate, so that a failed LOAD cannot strand the passwords -- which
        // means a failure HERE leaves the mirror image: a restored database
        // whose stored mail passwords are encrypted under the backup's key,
        // and the OLD key still on disk. Nothing is lost, and the way out is
        // short, but an operator who is not told would hunt a connection bug.
        throw new RestoreMailKeyError(mailKeyPath, error);
      } finally {
        // A 32-BYTE AES KEY IS NOT LEFT LYING ABOUT under a name nothing
        // cleans up. Same rule as the blobs above, and more sharply: this one
        // is a credential.
        await rm(temp, { force: true });
      }
      // THIS PROCESS CACHES THE KEY AND HAS NO INVALIDATION OF ITS OWN. Without
      // this, every mail password would be decrypted with the key this process
      // happened to load before the restore.
      forgetMailKey(mailKeyPath);
      ctx.spend(1);
    },

    "migrate-forward": async (effect, ctx) => {
      // EVERYTHING HERE HAPPENS AFTER THE DATABASE HAS ALREADY BEEN REPLACED,
      // and that is why this step owns its own failure the way the load does.
      // It used to let the frame's accounting error out: unwrapped, carrying no
      // outcome, naming no safety backup, saying "the plan said otherwise" over
      // an install whose every table had just been swapped and whose mail.key
      // was about to be. That is verbatim the reporting hazard this module was
      // written to close, surviving one step further down the plan.
      //
      // A FRESH CONNECTION, NOT THE CALLER'S. The pool handed in has sessions
      // that were open across a DROP SCHEMA of everything they had ever
      // referenced; migrating over them would be relying on plan invalidation
      // reaching a pool this module does not own.
      const handle = createDatabase(databaseUrl, 1);
      let ran: number;
      try {
        const before = await appliedMigrationCount(handle.db);
        await runMigrations(handle.db);
        const after = await appliedMigrationCount(handle.db);
        // MEASURED FROM THE DATABASE'S OWN BOOKKEEPING, not from the journal
        // this build ships: what is accounted for is what actually ran.
        ran = after - before;
      } catch (error) {
        // MIGRATING REAL DATA FORWARD IS AN ORDINARY WAY TO FAIL -- a
        // constraint that a years-old install violates is exactly the case the
        // older-backup path exists for -- and the database is restored either
        // way. Say both halves.
        throw new RestoreMigrationError(effect.fromPosition, effect.toPosition, error);
      } finally {
        await handle.close();
      }
      // A COUNT THAT DISAGREES IS NOT AN ACCOUNTING BUG HERE EITHER. The
      // manifest's migrationPosition is what services/backup.ts recorded, and
      // it records the number of migrations the BUILD SHIPS rather than the
      // number the dumped database had applied -- so the two can differ for a
      // backup that is perfectly good, and the answer is a sentence rather than
      // an exception about a plan.
      if (ran !== effect.count) {
        throw new RestoreUnexpectedMigrationsError(
          effect.count, ran, safetyBackupPath,
          recoveryCommands(safetyBackupPath, databaseUrl, []),
        );
      }
      ctx.spend(effect.count);
    },
  };

  // INSIDE THE `try`, AND THAT IS THE WHOLE POINT OF THE `finally`. With the
  // stop outside it, a sync that threw on the way down was never started again
  // -- the exact failure the comment below forbids, one line above the comment.
  try {
    await sync?.stop();
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
  safetyBackupPath: string | null,
  databaseUrl: string,
  schemas: readonly string[] = [],
): string[] {
  if (safetyBackupPath === null) return [];
  // NEVER A DEFAULT NAME HERE. This line runs DROP SCHEMA ... CASCADE, and a
  // URL with no path used to make it say `-d conduit` -- a database that exists
  // on the deploy target. A command printed as the way back that can wreck a
  // DIFFERENT install is the worst thing in this file. The placeholder cannot
  // be pasted: it has spaces and angle brackets, so a shell refuses it.
  const database = libpqEnvironment(databaseUrl).PGDATABASE
    ?? "<the database name from DATABASE_URL>";
  const dir = `${safetyBackupPath}.recovered`;
  // THE DROPS ARE THE HALF THAT WAS MISSING, and without them the printed
  // command DOES NOT WORK -- proved by running it. The safety backup's dump is
  // a plain pg_dump with no --clean and no --if-exists (services/backup.ts
  // explains why: a dump that drops before it creates destroys a database when
  // it is run by mistake), so it cannot load into a database that still holds
  // its schema -- which is exactly the state this message describes. Typing the
  // old two-line form verbatim gave `ERROR: schema "drizzle" already exists`,
  // exit 3, and an install still broken.
  //
  // ONE psql INVOCATION, so the drops and the load are ONE TRANSACTION. psql
  // applies --single-transaction across every -c and -f it is given, in order,
  // which is the same atomic act the engine performs -- an operator who runs
  // this and has it fail is left where they were rather than one step worse.
  //
  // Identifiers are double-quoted for SQL and contain no single quote, so each
  // -c argument survives the shell's single quotes unescaped.
  const drops = [...new Set(schemas)]
    .map((schema) => `-c 'DROP SCHEMA IF EXISTS "${schema.replace(/"/g, '""')}" CASCADE' `)
    .join("");
  return [
    `7z x -o${dir} -- ${safetyBackupPath}`,
    `psql --single-transaction -v ON_ERROR_STOP=1 -d ${database} `
    + `${drops}-c 'CREATE SCHEMA IF NOT EXISTS "public"' -f ${dir}/database.sql`,
  ];
}

/**
 * Which schemas the printed recovery has to clear out of the way.
 *
 * THE UNION OF BEFORE AND AFTER, because either may be what is on the disk when
 * somebody types the command: the install's own schemas if the drop did not
 * commit, and the backup's if it did. Dropping one that is not there is a
 * no-op; failing to drop one that is stops the recovery dead.
 */
function schemasToClear(
  before: DatabaseShape | null, after: DatabaseShape | null,
): string[] {
  return [...new Set([...(before?.schemas ?? []), ...(after?.schemas ?? [])])].sort();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
