import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { passphraseProblem } from "@conduit/shared";
import { DISK_MARGIN_BYTES, freeSpaceBytes, SEVEN_ZIP_PACKAGE } from "./backup.js";

// THE SHARED SPINE'S FIRST TWO STAGES: INGEST AND STAGE.
//
// Phase 7.7 is three pipelines with four stages in common and one that
// differs:
//
//              ingest  stage        inspect             plan           apply
//   restore    .7z     7z x + pass  manifest, versions  destroyed      load
//   import zip .zip    7z x         manifest, format    created        insert
//   import csv .csv    nothing      headers, delimiter  mapping, rows  insert
//
// This module owns ingest and stage for all three, so neither half re-invents
// them; services/intake-plan.ts owns the plan inspect produces and the frame
// apply runs in.
//
// EVERYTHING HERE FOLLOWS FROM ONE SENTENCE: THE UPLOAD IS A CREDENTIAL STORE
// FROM THE MOMENT IT LANDS. A backup carries mail.key, every encrypted mail
// password and every mail body; an export carries every customer record; a
// foreign CSV carries somebody else's customer records. The disciplines are
// the ones services/backup.ts established for its temp file, in the direction
// nothing had travelled before this phase:
//
//   - INSIDE $data_dir, NEVER /tmp. conf/systemd.service sets
//     ProtectSystem=full with ReadWritePaths=__DATA_DIR__, so this is also the
//     only place the process can write.
//   - MODE 0700 ON THE DIRECTORY, 0600 ON THE UPLOAD. mkdtemp gives the
//     directory, and the directory is the bound that actually holds: nothing
//     inside a directory nobody else can traverse is reachable whatever its
//     own mode says. The 0600 is the belt to those braces and the property a
//     test can assert.
//   - REMOVED ON EVERY EXIT PATH -- success, refusal, failure and an abandoned
//     upload alike. The one path no `finally` can cover is a SIGKILL, and
//     sweepAbandonedIntakes is what will cover that, once the route family of a
//     later task calls it at boot; see its own comment for why nothing has been
//     missed in the meantime.
//
// AND FROM A SECOND: LIMITS COME BEFORE UNPACKING. A 2,207-byte archive listing
// 4,194,304 bytes of content is not a hypothetical -- it is measured, below --
// so the size an archive CLAIMS is read from its own index and checked against
// the disk before a single member is written. An archive whose members are not
// plain relative files is refused from the same listing, before extraction,
// because 7z will happily recreate a symlink.
//
// THAT LAST RULE HAS TWO LAYERS, AND THE SECOND WAS PAID FOR. The index is
// where a symlink is caught cheaply -- before anything is written -- but only
// where the index says so, and the unix mode in `Attributes` is an extension
// rather than a guarantee. A build whose archive omits it would present a
// stored link as an ordinary member. So the post-extraction check uses `lstat`
// and not `stat`: it asks what the member IS, not what it points at.



/**
 * Where an intake unpacks, and how a sweep recognises one.
 *
 * A DIFFERENT PREFIX FROM THE BACKUP'S, AND THAT IS LOAD-BEARING RATHER THAN
 * TIDY. services/backup.ts sweeps `.backup-work-` at every boot and again at
 * the start of every build, and it does not ask whether anybody is using the
 * directory it is removing. A restore takes a safety backup of its own while
 * its uploaded archive is still staged; sharing the prefix would have that
 * backup delete the archive it is protecting the operator against losing.
 *
 * The leading dot keeps it out of an operator's `ls` and out of any future
 * code that walks $data_dir looking for real content.
 */
export const INTAKE_WORK_PREFIX = ".intake-work-";

/**
 * The file name the upload lands under, inside the work directory.
 *
 * FIXED RATHER THAN DERIVED FROM WHAT WAS UPLOADED. The operator's filename is
 * remembered as a label (IntakeFile.filename) and never used to build a path:
 * a name is a thing an attacker chooses, and the only way for a chosen name to
 * be harmless is for it never to reach the filesystem.
 */
const UPLOAD_NAME = "upload";

/** Where an archive is unpacked, inside the work directory. */
const STAGED_DIR = "staged";

/**
 * The largest upload this will accept by default, in bytes.
 *
 * 8 GiB, AND IT IS A CEILING RATHER THAN AN EXPECTATION. A backup is roughly
 * the size of the install: the deploy target's blob store alone was 315MB when
 * 7.6 measured it, and an install that has been running for years is the one
 * whose restore matters most. A cap tight enough to be interesting would be a
 * cap that refuses the restore an operator actually needs.
 *
 * WHAT ACTUALLY PROTECTS THE DISK IS NOT THIS NUMBER. It is the free-space
 * check before the write starts and the listed-size check before the unpack --
 * see stageArchive. This bound exists so a stream that never ends is stopped
 * by something, and so the number has a name.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The largest staged payload this will accept by default, in bytes.
 *
 * 64 GiB, and its whole job is to be checked BEFORE statfs. An archive index
 * is attacker-controlled: a member can claim any size at all, and the answer
 * to a claim of a petabyte should be a refusal rather than a disk query whose
 * answer happens to also be no. It is the arithmetic guard; the disk is the
 * real one.
 */
export const DEFAULT_MAX_STAGED_BYTES = 64 * 1024 * 1024 * 1024;

/**
 * The most members an archive may declare by default.
 *
 * 250,000, AND IT BOUNDS MEMORY RATHER THAN DISK. Every member becomes an
 * entry in the listing, a ref object and a Map entry that live for as long as
 * the plan does -- so a listing with fifty million zero-byte members would
 * cost nothing in disk and exhaust the heap, which is the shape a size bound
 * alone does not see. The figure is far above anything this deployment shape
 * holds: 250,000 blobs at even the 100KB an ordinary PDF runs to would be 25GB
 * of content, against the 315MB 7.6 measured on the deploy target.
 */
export const DEFAULT_MAX_MEMBERS = 250_000;

/**
 * How much of a member readText will read by default, in bytes.
 *
 * 64MB. A manifest carries one entry per blob, so it grows with the install
 * and cannot be assumed small -- but a member being read into a string as
 * though it were a manifest, that turns out to be a 4GB pg_dump, is a heap
 * exhaustion with a stack trace pointing at the wrong line.
 *
 * SINCE v1.4.0 IT ALSO CARRIES ONE ENTRY PER TABLE (the inventory -- see
 * services/backup.ts), and that term does NOT move this number: it grows with
 * the SCHEMA rather than with the install, twenty-seven entries of a few dozen
 * bytes against a blob list that reaches hundreds of thousands. The bound is
 * still the blob term.
 */
export const DEFAULT_MAX_TEXT_BYTES = 64 * 1024 * 1024;

/** What an intake is allowed to cost. Every field has a documented default. */
export interface IntakeLimits {
  maxUploadBytes: number;
  maxStagedBytes: number;
  maxMembers: number;
}

export const DEFAULT_INTAKE_LIMITS: IntakeLimits = {
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  maxStagedBytes: DEFAULT_MAX_STAGED_BYTES,
  maxMembers: DEFAULT_MAX_MEMBERS,
};

/** 8KB of a child's stderr: enough to diagnose it, short enough to log. */
const STDERR_CAP_BYTES = 8 * 1024;

/** The upload is bigger than this intake is allowed to accept. */
export class IntakeTooLargeError extends Error {
  constructor(readonly limitBytes: number, what = "the upload") {
    super(`${what} is larger than the ${String(limitBytes)} bytes this install accepts`);
    this.name = "IntakeTooLargeError";
  }
}

/** There is not enough free disk to land or to unpack this. */
export class IntakeDiskSpaceError extends Error {
  constructor(readonly neededBytes: number, readonly freeBytes: number) {
    super(
      `not enough free disk space: this needs about ${formatMiB(neededBytes)} `
      + `and ${formatMiB(freeBytes)} is free`,
    );
    this.name = "IntakeDiskSpaceError";
  }
}

/**
 * The archive's own index describes something this will not unpack.
 *
 * SEPARATE FROM IntakeArchiveError BECAUSE IT IS NOT DAMAGE. The archive opened
 * and its index parsed; what it holds is a shape that would write outside the
 * staging directory, or one this code has no way to handle safely.
 */
export class IntakeShapeError extends Error {
  constructor(readonly member: string, readonly reason: string) {
    super(`the archive member ${JSON.stringify(member)} cannot be unpacked: ${reason}`);
    this.name = "IntakeShapeError";
  }
}

/**
 * The archive could not be opened or did not come out whole.
 *
 * ONE ERROR FOR "WRONG PASSPHRASE" AND FOR "DAMAGED", DELIBERATELY. With
 * `-mhe=on` the two are the same event: the header is encrypted, so a bad
 * passphrase and a corrupt header both fail at the same point with the same
 * message, and 7z's own wording ("Cannot open encrypted archive. Wrong
 * password?") says no more than that. Splitting them here would mean inventing
 * a distinction the format does not offer -- and a message that told an
 * attacker which of the two it was would be the leak 7.6 was careful not to
 * have.
 */
export class IntakeArchiveError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "IntakeArchiveError";
  }
}

/** The passphrase is one 7z would silently mangle. See @conduit/shared. */
export class IntakePassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakePassphraseError";
  }
}

/** 7z is not installed. The message names the package, as 7.6's does. */
export class IntakeToolMissingError extends Error {
  constructor(readonly tool: string, readonly aptPackage: string) {
    super(`${tool} is not available; install the ${aptPackage} package and try again`);
    this.name = "IntakeToolMissingError";
  }
}

/**
 * A ref was presented to a payload that did not mint it.
 *
 * THIS IS THE ERROR THAT MAKES "APPLY CANNOT EXCEED ITS PLAN" A MECHANISM
 * RATHER THAN A CONVENTION -- see StagedPayload.open and
 * services/intake-plan.ts.
 */
export class IntakeRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeRefError";
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Remove intake work directories left behind by a previous run.
 *
 * THE EXIT PATH NO `finally` COVERS, exactly as services/backup.ts's
 * sweepAbandonedBackups is. What a SIGKILL leaves in $data_dir here is an
 * uploaded backup archive and its decrypted contents -- mail.key in the clear
 * -- so this is the more valuable of the two sweeps, not the lesser.
 *
 * NO PRODUCTION CALLER YET, and that is stated rather than hidden. The routes
 * this spine serves arrive in a later task of this phase, and the function that
 * registers them MUST call this at registration, the way registerBackupRoutes
 * calls its own. Nothing has been missed in the meantime: no route can create
 * an intake work directory yet, so there is nothing for a boot-time sweep to
 * find, and every exit path a running process has is covered by the disposers
 * below.
 *
 * Never throws: a sweep that cannot read $data_dir is not a reason to fail an
 * intake that has not started yet.
 */
export async function sweepAbandonedIntakes(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(INTAKE_WORK_PREFIX)) continue;
    try {
      await rm(path.join(dataDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch { /* an unremovable orphan is not a reason to fail the next intake */ }
  }
  return removed;
}

/**
 * The token that mints a ref. NOT EXPORTED, and that is the point: no code
 * outside this module can construct a StagedMemberRef, so the only refs in
 * existence are ones a staging produced for a member it actually holds.
 */
const MINT = Symbol("intake.mint");

/**
 * A HANDLE ON ONE STAGED MEMBER, AND THE ONLY WAY TO READ ONE.
 *
 * THIS TYPE IS THE SPINE'S CENTRAL DECISION, so it is worth saying plainly what
 * it buys. `apply` is handed a plan and a reader, and the reader takes refs
 * rather than names or paths. It therefore cannot ASK for a file the plan did
 * not describe: there is no string to construct, the constructor throws for
 * anyone who does not hold the module-private token above, and the payload
 * resolves refs through a Map keyed by OBJECT IDENTITY -- so even a ref cast
 * into the type, or a genuine ref belonging to a different staging, resolves to
 * nothing.
 *
 * WHAT IT DOES NOT BUY, said here rather than discovered later: TypeScript has
 * no capability-safe module system, so a handler that imported `node:fs` could
 * read anything the process can read. Two things stand in the way of that being
 * an accident rather than a decision. The staging directory's name is a
 * mkdtemp suffix that apply is never told -- it is not on the context, not in
 * the plan, and not derivable -- so reaching it means walking $data_dir looking
 * for it. And services/intake-plan.ts requires each handler to account for what
 * it did against the count the plan published, which turns the ordinary version
 * of this bug (work nobody wrote down) into a thrown error.
 */
export class StagedMemberRef {
  /** Stable within one staging. For logs and messages; NEVER a path. */
  readonly id: string;

  constructor(token: symbol, id: string) {
    if (token !== MINT) {
      throw new IntakeRefError(
        "a StagedMemberRef can only be minted by services/intake.ts; "
        + "an apply step reads what its plan describes and nothing else",
      );
    }
    this.id = id;
  }
}

/** One member of a staged payload, as inspect sees it. */
export interface StagedMember {
  readonly ref: StagedMemberRef;
  /**
   * The member's path inside the payload -- "manifest.json", "files/<digest>".
   * Guaranteed relative, `..`-free and slash-separated: archiveMemberProblem
   * refused everything else before extraction.
   */
  readonly name: string;
  readonly bytes: number;
}

/**
 * Read one staged member. The reader half of the spine's capability model.
 *
 * `open`/`readText`/`readBytes` ONLY, AND NO WAY TO ENUMERATE. StagedPayload
 * below adds `members` and `byName` for inspect, which is allowed to look at
 * everything; this narrower interface is what services/intake-plan.ts hands to
 * apply, which is not.
 */
export interface StagedReader {
  open: (ref: StagedMemberRef) => Promise<Readable>;
  readBytes: (ref: StagedMemberRef, maxBytes?: number) => Promise<Buffer>;
  readText: (ref: StagedMemberRef, maxBytes?: number) => Promise<string>;
}

/**
 * The unpacked payload: what inspect reads to build a plan.
 *
 * THERE IS NO `root` AND THERE WILL NOT BE ONE. The staging directory's path is
 * held in a private field and never published, so a consumer's only route to
 * the bytes is a ref -- which is what makes the reader above a real narrowing
 * rather than a naming convention.
 */
export interface StagedPayload extends StagedReader {
  readonly members: readonly StagedMember[];
  /** Total bytes on disk under the staging directory, as extracted. */
  readonly stagedBytes: number;
  /** The member with this exact path, or undefined. For inspect only. */
  byName: (name: string) => StagedMember | undefined;
  /** Remove the whole intake -- upload and staging alike. Idempotent. */
  dispose: () => Promise<void>;
}

/**
 * THE UPLOADED FILE, ON DISK, 0600, INSIDE $data_dir.
 *
 * `path` is published because staging needs it and because the tests that hold
 * this module to the discipline above have to be able to stat the thing. It is
 * never handed to an apply step: apply receives a reader and a plan, and this
 * object appears in neither.
 */
export interface IntakeFile {
  readonly path: string;
  /** The operator's filename, reduced to a basename. A label, never a path. */
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Remove the whole intake. Idempotent, and safe to call after staging. */
  dispose: () => Promise<void>;
}

/**
 * Reduce an uploaded filename to something safe to show and impossible to
 * follow.
 *
 * THE RESULT IS NEVER JOINED TO A PATH -- see UPLOAD_NAME -- so this is about
 * what an operator reads, not about traversal. It still strips directory
 * components, because a "filename" of `../../etc/passwd` rendered verbatim in a
 * confirmation dialog is a lie about what was uploaded.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "upload" : cleaned.slice(0, 255);
}

export interface ReceiveIntakeOptions {
  /** $data_dir. The work directory goes directly inside it. */
  dataDir: string;
  /** The uploaded bytes. Consumed; never buffered whole. */
  source: Readable;
  /** What the operator called it. A label only. */
  filename: string;
  maxBytes?: number;
  /** Injected by the disk pre-flight's test, which runs on a machine with space. */
  freeBytes?: (dir: string) => Promise<number>;
}

/**
 * INGEST: land the upload on disk as a credential store, and hash it.
 *
 * THE FILE IS CREATED INSIDE A 0700 DIRECTORY BEFORE A BYTE IS WRITTEN, so
 * there is no window in which the upload exists somewhere another user could
 * open it. The 0600 is applied to the file itself immediately after creation,
 * for the same belt-and-braces reason services/backup.ts chmods its archive.
 *
 * EVERY FAILURE REMOVES THE DIRECTORY, including the size refusal and an
 * aborted upload -- which is the ordinary case rather than the exotic one: an
 * operator who changes their mind about restoring a 3GB backup produces
 * exactly this path, and a half-written backup left in $data_dir is the failure
 * mode the discipline exists to prevent.
 *
 * THE DIGEST COSTS NOTHING EXTRA because it is taken from the same chunks on
 * their way to the file. It is what lets the preview identify the file the
 * operator uploaded, and what a later task can compare against a manifest.
 */
export async function receiveIntake(options: ReceiveIntakeOptions): Promise<IntakeFile> {
  const {
    dataDir, source, filename,
    maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
    freeBytes = freeSpaceBytes,
  } = options;

  // BEFORE THE DIRECTORY EXISTS. Landing an upload on a disk that is already
  // full turns one problem into two: the upload fails AND the server has no
  // room for its own journal while it says so.
  const free = await freeBytes(dataDir);
  if (free < DISK_MARGIN_BYTES) {
    throw new IntakeDiskSpaceError(DISK_MARGIN_BYTES, free);
  }

  const work = await mkdtemp(path.join(dataDir, INTAKE_WORK_PREFIX));
  // mkdtemp ASKS FOR 0700 AND THE UMASK MAY NARROW IT, which is not the harmless
  // direction it sounds like. Found by the test that runs this under
  // `umask 0400`: the directory comes out 0300, the process can still traverse
  // it by name but cannot readdir it, and `dispose` -- a recursive remove --
  // fails with EACCES. A credential store that cannot be deleted is the exact
  // failure this whole module exists to prevent, so the mode is asserted here
  // rather than requested and hoped for.
  await chmod(work, 0o700);
  const uploadPath = path.join(work, UPLOAD_NAME);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(work, { recursive: true, force: true });
  };

  try {
    const digest = createHash("sha256");
    let bytes = 0;
    // `wx` because this name must not already exist: mkdtemp just made the
    // directory, so a file here would mean something has gone very wrong, and
    // truncating it silently is not the response.
    //
    // THE MODE ON CREATION IS WHAT CLOSES THE WINDOW, and the chmod after the
    // last chunk is what fixes an aggressive umask. A umask can only NARROW a
    // requested mode, so there is no instant at which this file is wider than
    // 0600; what a umask of, say, 0077 in the wrong direction could do is make
    // it 0000, which is unreadable to the process that has to stage it. The
    // chmod settles it in the one direction the umask cannot.
    const sink = createWriteStream(uploadPath, { mode: 0o600, flags: "wx" });

    await pipeline(
      source,
      async function* count(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new IntakeTooLargeError(maxBytes);
          digest.update(chunk);
          yield chunk;
        }
      },
      sink,
    );

    await chmod(uploadPath, 0o600);
    return {
      path: uploadPath,
      filename: safeFilename(filename),
      bytes,
      sha256: digest.digest("hex"),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * The argument list `7z` is spawned with to LIST an archive's index.
 *
 * EXPORTED SO A TEST CAN ASSERT WHAT IS NOT IN IT, exactly as
 * services/backup.ts's sevenZipArgs is, and for the same reason: the passphrase
 * must not appear.
 *
 * THERE IS NO `-p` HERE, AND ITS ABSENCE IS WHAT MAKES THE PASSPHRASE WORK.
 * See sevenZipExtractArgs below for the measurement; listing takes the
 * passphrase by the identical mechanism, because with `-mhe=on` an archive
 * cannot even be listed without it.
 */
export function sevenZipListArgs(archivePath: string): string[] {
  return [
    "l",        // list
    "-slt",     // one "Key = Value" block per member: parseable, unlike the table
    "-bd",      // no progress indicator: this is not a terminal
    "-y",       // never prompt for anything except the passphrase
    "--",
    archivePath,
  ];
}

/**
 * The argument list `7z` is spawned with to EXTRACT, and the single most
 * surprising thing this phase measured.
 *
 * THERE IS NO `-p` HERE AT ALL. That is not the shape the write side uses, and
 * it is the opposite of what v1.3.0's note predicted.
 *
 * services/backup.ts records that `7z a -p` reads the passphrase from stdin
 * (true, and untouched here) and that `7z x -p` from a pipe does NOT work --
 * "Cannot open encrypted archive. Wrong password?". That second half is true.
 * The conclusion it invites -- that extraction must therefore put the
 * passphrase in argv, where /proc/<pid>/cmdline exposes it to every other local
 * user on the box -- is FALSE, and this module would have been built around a
 * leak if it had been taken on trust.
 *
 * MEASURED ON THE DEPLOY TARGET (7-Zip 26.02 via p7zip 16.02), as a 2x2 over
 * the flag and the trailing newline, because the first run confounded them:
 *
 *   -p, no trailing newline ..... exit 2, nothing extracted
 *   -p, trailing newline ........ exit 2, nothing extracted
 *   no -p, no trailing newline .. exit 0, every member extracted
 *   no -p, trailing newline ..... exit 0, every member extracted
 *
 * So the flag is the variable and the newline is not. With no `-p`, 7z prints
 * "Enter password (will not be echoed):" and READS THAT PROMPT FROM STDIN,
 * which a pipe satisfies exactly as a terminal does. A bare `-p` on extraction
 * means the EMPTY passphrase -- the opposite of what the same flag means to
 * `a`.
 *
 * The failure modes were measured in the same run, because a restore that
 * hangs is worse than one that fails:
 *
 *   empty stdin ...... exit 255, "Break signaled". It does NOT wait for a
 *                      terminal that will never answer.
 *   wrong passphrase . exit 2, and the message says nothing about how close it
 *                      was.
 *   two lines piped .. 7z READS ONE LINE, exactly as it does on creation: a
 *                      passphrase split across two lines fails (exit 2), and a
 *                      correct passphrase followed by a second line succeeds.
 *                      That is why passphraseProblem is reused here rather
 *                      than re-derived -- the rule protects this direction too.
 *
 * The upshot is that the passphrase reaches argv on NEITHER side, and
 * intake.test.ts asserts it against /proc after a control that shows the same
 * scan finding a passphrase passed as `-p<value>`.
 */
export function sevenZipExtractArgs(archivePath: string, destination: string): string[] {
  return [
    "x",                    // extract WITH full paths, so files/ stays files/
    `-o${destination}`,     // joined, not a separate argument: 7z requires -o<dir>
    "-bd",
    "-y",                   // never prompt on overwrite; the passphrase prompt still reads stdin
    "--",
    archivePath,
  ];
}

/** One member as `7z l -slt` reports it, before anything is decided about it. */
export interface ArchiveIndexEntry {
  path: string;
  bytes: number;
  /** The raw `Attributes` value, e.g. "A -rw-r--r--", "D drwxr-xr-x", "A lrwxrwxrwx". */
  attributes: string;
}

/**
 * Parse `7z l -slt` output into an index.
 *
 * PURE AND EXPORTED, so every shape this has to survive is a string in a test
 * rather than an archive somebody has to build. ONE PARSER SERVES BOTH
 * CONTAINERS: a `.7z` with `-mhe=on` and a plain `.zip` both produce the
 * `----------` separator and the same `Key = Value` blocks, differing only in
 * which keys they fill in -- a zip carries no `Method` or `Packed Size` and may
 * carry no unix mode at all. intake.test.ts stages one of each, which is the
 * evidence for that rather than this sentence.
 *
 * The `----------` line is the separator between the archive's own block and
 * the member blocks, and it is what makes this parse rather than guess: without
 * it the archive's own `Path = backup.7z` reads as a member.
 */
export function parseArchiveIndex(listing: string): ArchiveIndexEntry[] {
  const lines = listing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "----------");
  if (start === -1) return [];
  const entries: ArchiveIndexEntry[] = [];
  let current: Partial<ArchiveIndexEntry> = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        bytes: current.bytes ?? 0,
        attributes: current.attributes ?? "",
      });
    }
    current = {};
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { flush(); continue; }
    const split = line.indexOf(" = ");
    if (split === -1) continue;
    const key = line.slice(0, split);
    const value = line.slice(split + 3);
    if (key === "Path") { flush(); current.path = value; }
    else if (key === "Size") { current.bytes = value.trim() === "" ? 0 : Number(value); }
    else if (key === "Attributes") { current.attributes = value; }
  }
  flush();
  return entries;
}

/**
 * A ten-character unix mode token: one type character and nine permission
 * characters.
 *
 * MATCHED BY SHAPE RATHER THAN BY POSITION, and that is a repair rather than a
 * preference. `7z l -slt` writes `Attributes` as a DOS field then a unix field,
 * and EITHER MAY BE ABSENT, so the token index is not the field index.
 * Measured on the deploy target, all four shapes from one run:
 *
 *   "A -rw-r--r--" ........... 7z member: DOS flags, then the mode
 *   " lrwxrwxrwx" ............ ZIP symlink: EMPTY DOS field, then the mode.
 *                              Splitting on whitespace gives ONE token, so a
 *                              positional reader calls the mode "" and the
 *                              symlink an ordinary file.
 *   " prw-r--r--" ............ ZIP fifo, same shape, same hole.
 *   "V 01800000 0rw-------" .. ZIP member written with no unix type bits (a
 *                              Python `writestr`, among others): THREE tokens,
 *                              and a positional reader takes the DOS hex as the
 *                              mode and refuses a perfectly ordinary file.
 *
 * The permission tail is what identifies the token: nine characters drawn from
 * the `rwxsStT-` set. Nothing else 7z prints in this field looks like that.
 */
const MODE_TOKEN = /^.[rwxsStT-]{9}$/;

/** The unix mode 7z reported for this member, or "" when it reported none. */
export function attributeMode(attributes: string): string {
  return attributes.trim().split(/\s+/).find((token) => MODE_TOKEN.test(token)) ?? "";
}

/**
 * The DOS attribute letters 7z reported, concatenated. "D" is a directory.
 *
 * Every token that is NOT the mode and is made only of capitals -- so the
 * `01800000` hex above contributes nothing, and neither does the mode itself.
 */
export function attributeFlags(attributes: string): string {
  return attributes.trim().split(/\s+/)
    .filter((token) => !MODE_TOKEN.test(token) && /^[A-Z]+$/.test(token))
    .join("");
}

/**
 * Whether an index entry names a directory rather than a file.
 *
 * THREE SIGNALS, BECAUSE THE CONTAINERS DISAGREE AND SO DO THE WRITERS. A
 * `.7z` reports "D drwxr-xr-x"; a `.zip` may report the DOS bit, the mode, or
 * only a trailing slash. Directories are SKIPPED rather than refused -- a real
 * Conduit backup contains a `files` entry, and refusing it would refuse every
 * backup ever taken -- but they are NOT skipped before their PATH is checked;
 * see stageArchive.
 */
function isDirectoryEntry(entry: ArchiveIndexEntry): boolean {
  if (entry.path.endsWith("/")) return true;
  if (attributeFlags(entry.attributes).includes("D")) return true;
  return attributeMode(entry.attributes).startsWith("d");
}

/**
 * WHY THIS PATH CANNOT BE UNPACKED, OR NULL. Decided from the INDEX, before a
 * byte is extracted, which is the whole point of listing first.
 *
 * SEPARATE FROM THE KIND RULE BELOW BECAUSE IT APPLIES TO MORE MEMBERS.
 * Directories are skipped by the kind rule -- a real backup has a `files`
 * entry -- but a DIRECTORY MEMBER STILL HAS A PATH, and `../../escapedir/`
 * reaching `7z x` unchecked was a class of member neither layer looked at.
 * stageArchive now runs this over every index entry and the kind rule over the
 * files. No escape was reproduced (7-Zip sanitises both), and that is not the
 * standard this module holds itself to.
 *
 * PURE AND EXPORTED so every hostile shape is a unit test rather than an
 * archive somebody has to craft -- though intake.test.ts crafts them too,
 * because a rule agreeing with itself is not evidence.
 *
 * The three refusals, each measured on the deploy target rather than assumed:
 *
 *   AN ABSOLUTE PATH, and a Windows drive letter with it. 7z's own `a` strips
 *   these, so they cannot arrive from an archive Conduit wrote -- which is
 *   exactly why they are worth refusing: the only way one arrives is
 *   deliberately.
 *
 *   A `..` COMPONENT. `7z a -spf` stores `../../data/manifest.json` verbatim
 *   -- measured -- so a `..` member is a thing an attacker can build with the
 *   stock binary and nothing else. The trailing slash a directory entry may
 *   carry is stripped first, so `a/../b/` is judged on its components rather
 *   than on its punctuation.
 *
 *   AN EMPTY OR DOT PATH, which no legitimate member has and which would
 *   resolve to the staging directory itself.
 */
export function archivePathProblem(name: string): string | null {
  if (name === "" || name === "." || name === "..") return "it has no usable name";
  if (name.startsWith("/") || name.startsWith("\\")) return "it is an absolute path";
  if (/^[A-Za-z]:/.test(name)) return "it carries a drive letter";
  const parts = name.replace(/\/$/, "").split(/[/\\]/);
  if (parts.includes("..")) return "it points outside the archive with '..'";
  return null;
}

/**
 * WHY THIS MEMBER'S KIND CANNOT BE UNPACKED, and the refused types named rather
 * than inferred.
 *
 * A SYMLINK IS THE ONE THAT WOULD HAVE BEEN MISSED, TWICE. 7z preserves
 * symlinks and recreates them: an archive carrying `files/link -> /etc/passwd`
 * extracted to a link 7z had re-rooted inside the destination, and a RELATIVE
 * link escaping the destination made `7z x` exit 2 while still writing a file
 * in its place. Two behaviours for one idea, neither of them a refusal.
 *
 * The second miss was this rule's own: reading the mode by POSITION meant a ZIP
 * symlink, whose DOS field is empty, was read as having no mode at all and
 * waved through. See MODE_TOKEN for the four shapes that field takes.
 *
 * THE TYPE CHARACTER IS READ AS A TYPE, NOT AS "NOT A DASH". An earlier version
 * refused every mode that did not begin `-` or `d`, which refuses the
 * `0rw-------` that a ZIP member written without unix type bits reports -- an
 * entirely ordinary file, measured on the deploy target. So the refused set is
 * enumerated: a type character this code has never seen is not a reason to
 * reject an operator's only backup.
 */
const REFUSED_TYPES: Record<string, string> = {
  l: "it is a symbolic link, and this unpacks only plain files",
  b: "it is a block device",
  c: "it is a character device",
  p: "it is a named pipe",
  s: "it is a socket",
};

export function archiveMemberProblem(entry: ArchiveIndexEntry): string | null {
  const pathProblem = archivePathProblem(entry.path);
  if (pathProblem !== null) return pathProblem;
  const mode = attributeMode(entry.attributes);
  const refused = REFUSED_TYPES[mode.slice(0, 1)];
  if (refused !== undefined) return `${refused} (mode ${mode})`;
  if (attributeFlags(entry.attributes).includes("L")) {
    return "it is a reparse point or a link";
  }
  if (!Number.isFinite(entry.bytes) || entry.bytes < 0) return "it declares an impossible size";
  return null;
}

/**
 * WHY THIS EXTRACTED MEMBER CANNOT BE KEPT, OR NULL. The belt to
 * archiveMemberProblem's braces.
 *
 * TWO CHECKS THAT LOOK LIKE ONE. The rule above reads a NAME out of an index
 * and decides whether it is safe; this one reads the PATH that name resolved
 * to and decides whether it landed where it was supposed to. They can disagree
 * -- a normalisation this code did not anticipate, a separator this platform
 * treats differently -- and when they do, the second is the one standing
 * between an archive and the rest of $data_dir.
 *
 * PURE AND EXPORTED so it is an instrument rather than a hope: intake.test.ts
 * shows it firing on the names the first rule already refuses, which is exactly
 * the population it exists to catch if that rule ever loosens.
 */
export function stagedPathProblem(destination: string, resolved: string): string | null {
  if (resolved === destination) return "it resolves to the staging directory itself";
  if (!resolved.startsWith(destination + path.sep)) {
    return "it resolves outside the staging directory";
  }
  return null;
}

/** Run 7z with the passphrase on its stdin and nowhere else. */
async function runSevenZip(
  args: readonly string[], passphrase: string | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("7z", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_CAP_BYTES) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });
    // A spawn that never started. In practice this is ENOENT -- 7z is an apt
    // dependency of the app (manifest.toml's resources.apt) and an install
    // missing it must say which package to install rather than report a
    // damaged archive, which is what a generic failure here would look like.
    child.on("error", () => { reject(new IntakeToolMissingError("7z", SEVEN_ZIP_PACKAGE)); });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, STDERR_CAP_BYTES),
      });
    });
    // NO TRAILING NEWLINE, and it is not superstition: 7z reads one line, so a
    // newline here would be read as the end of the passphrase either way -- but
    // writing exactly the bytes the operator typed keeps this side of the pipe
    // free of anything the other side has to be trusted to strip.
    if (passphrase !== null) child.stdin.write(passphrase);
    child.stdin.end();
  });
}

export interface StageArchiveOptions {
  file: IntakeFile;
  /**
   * Null for an unencrypted container (Conduit's own export `.zip`).
   * A `.7z` with `-mhe=on` cannot even be LISTED without it.
   */
  passphrase: string | null;
  limits?: Partial<IntakeLimits>;
  freeBytes?: (dir: string) => Promise<number>;
  /**
   * Injected by the test that proves the post-extraction verification fires.
   *
   * AN INSTRUMENT THAT HAS NEVER BEEN SHOWN TO FAIL IS NOT YET AN INSTRUMENT,
   * and the check that every listed member actually arrived is otherwise
   * unreachable from a test: 7z either extracts an archive or does not, so
   * there is no fixture that lists a member and then declines to produce it.
   * This hook is how the test creates that state -- it deletes one -- and it is
   * the same arrangement `freeBytes` above has for the disk pre-flight, which
   * cannot be exercised on a machine with room. Production passes nothing.
   */
  onExtracted?: (destination: string) => Promise<void>;
}

/**
 * STAGE: unpack the upload, having first refused everything about it that is
 * refusable from its index.
 *
 * THE ORDER IS THE DESIGN, and every step before the extraction is a step at
 * which the operator has lost nothing:
 *
 *   1. THE PASSPHRASE RULE, from @conduit/shared, before a child process is
 *      spawned. 7z reads one line on the way in as it does on the way out, so
 *      the rule that stops a backup being written under a passphrase nobody
 *      typed is the same rule that stops one being read that way.
 *   2. LIST THE ARCHIVE. This is also where a wrong passphrase and a damaged
 *      file are found, and it is the cheapest possible place to find them:
 *      nothing has been written.
 *   3. CHECK THE SHAPE OF EVERY MEMBER, from the index. Absolute paths, `..`
 *      and symlinks are refused here rather than survived afterwards.
 *   4. CHECK THE SIZE THE ARCHIVE CLAIMS against the member cap, the byte cap
 *      and the free disk. MEASURED: a 2,207-byte `.7z` listing 4,194,304 bytes
 *      of content. A cap on the upload does not bound the unpack, and the
 *      unpack is what fills a live server's disk.
 *   5. ONLY THEN EXTRACT.
 *   6. AND VERIFY WHAT ARRIVED against what was listed, because an index is a
 *      claim about an archive and not the archive.
 */
export async function stageArchive(options: StageArchiveOptions): Promise<StagedPayload> {
  const { file, passphrase, freeBytes = freeSpaceBytes, onExtracted } = options;
  const limits = { ...DEFAULT_INTAKE_LIMITS, ...options.limits };

  if (passphrase !== null) {
    const problem = passphraseProblem(passphrase);
    if (problem !== null) throw new IntakePassphraseError(problem);
  }

  const work = path.dirname(file.path);
  const destination = path.join(work, STAGED_DIR);

  const listing = await runSevenZip(sevenZipListArgs(file.path), passphrase);
  if (listing.code !== 0) {
    throw new IntakeArchiveError(
      "the archive could not be opened. Either the passphrase is wrong, or the file is "
      + "damaged, incomplete, or not an archive at all.",
      listing.stderr,
    );
  }

  const index = parseArchiveIndex(listing.stdout);
  // EVERY ENTRY'S PATH, INCLUDING THE DIRECTORIES. The kind rule below skips
  // directories -- a real backup carries a `files` entry -- but a directory
  // member still has a path, and filtering before checking let
  // `../../escapedir/` reach `7z x` unlooked-at.
  for (const entry of index) {
    const problem = archivePathProblem(entry.path);
    if (problem !== null) throw new IntakeShapeError(entry.path, problem);
  }
  const files = index.filter((entry) => !isDirectoryEntry(entry));
  if (files.length === 0) {
    throw new IntakeArchiveError("the archive holds no files");
  }
  if (files.length > limits.maxMembers) {
    throw new IntakeTooLargeError(limits.maxMembers, "the archive's member count");
  }
  for (const entry of files) {
    const problem = archiveMemberProblem(entry);
    if (problem !== null) throw new IntakeShapeError(entry.path, problem);
  }

  const claimedBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (claimedBytes > limits.maxStagedBytes) {
    throw new IntakeTooLargeError(limits.maxStagedBytes, "the archive's unpacked size");
  }
  const free = await freeBytes(work);
  if (claimedBytes + DISK_MARGIN_BYTES > free) {
    throw new IntakeDiskSpaceError(claimedBytes + DISK_MARGIN_BYTES, free);
  }

  const extraction = await runSevenZip(
    sevenZipExtractArgs(file.path, destination), passphrase,
  );
  if (extraction.code !== 0) {
    await rm(destination, { recursive: true, force: true });
    throw new IntakeArchiveError(
      "the archive opened but did not unpack completely; it is damaged or incomplete.",
      extraction.stderr,
    );
  }

  if (onExtracted !== undefined) await onExtracted(destination);

  const members: StagedMember[] = [];
  const paths = new Map<StagedMemberRef, string>();
  let stagedBytes = 0;
  try {
    for (const entry of files) {
      const name = entry.path.split("\\").join("/");
      const full = path.join(destination, name);
      const placement = stagedPathProblem(destination, full);
      if (placement !== null) throw new IntakeShapeError(entry.path, placement);
      let info;
      try {
        // lstat, NOT stat, AND THAT IS THE SECOND LINE OF DEFENCE RATHER THAN A
        // STYLE CHOICE. archiveMemberProblem refuses a symlink from the index,
        // but only where the index SAYS so: the unix mode in `Attributes` is an
        // extension, and a build that omits it would present a stored link as
        // an ordinary member. `stat` follows the link and reports the TARGET --
        // so a link to /etc/passwd would pass isFile() and be staged as a
        // member. `lstat` reports the link itself, whatever any index claimed.
        info = await lstat(full);
      } catch {
        throw new IntakeArchiveError(
          `the archive listed ${JSON.stringify(entry.path)} but did not produce it`,
        );
      }
      if (!info.isFile()) {
        throw new IntakeShapeError(entry.path, "it did not unpack as a plain file");
      }
      const ref = new StagedMemberRef(MINT, name);
      paths.set(ref, full);
      members.push({ ref, name, bytes: info.size });
      stagedBytes += info.size;
    }
    // WHAT ACTUALLY LANDED, NOT ONLY WHAT WAS CLAIMED. The symlink rule got two
    // layers because an index is a claim about an archive and not the archive;
    // the size rule had only one until this. Both bounds are re-applied to the
    // bytes on the disk: the absolute ceiling, and the archive's own claim,
    // which the disk pre-flight was computed from. An extraction that produced
    // more than its index promised has already spent the difference, so this
    // cannot prevent it -- what it does is stop the plan being built on a
    // payload nobody bounded, and make the lie loud.
    if (stagedBytes > limits.maxStagedBytes) {
      throw new IntakeTooLargeError(limits.maxStagedBytes, "the unpacked payload");
    }
    if (stagedBytes > claimedBytes) {
      throw new IntakeArchiveError(
        `the archive unpacked to ${String(stagedBytes)} bytes after its index `
        + `claimed ${String(claimedBytes)}`,
      );
    }
  } catch (error) {
    // A REFUSAL LEAVES NOTHING HALF-STAGED. Everything above this point refuses
    // before a byte is written; this is the one stretch that runs AFTER the
    // extraction, so it is the one that has something to clear up. The upload
    // itself survives -- disposing of that is the caller's business, because
    // the caller is the one that knows whether the operator gets another try.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }

  return makePayload({ members, paths, stagedBytes, dispose: file.dispose });
}

export interface StageVerbatimOptions {
  file: IntakeFile;
  /**
   * What the single member is called inside the payload. Defaults to the
   * upload's own (sanitised) filename, because a foreign CSV's name is the only
   * label the operator will recognise it by.
   */
  memberName?: string;
}

/**
 * STAGE, FOR SOMETHING THAT IS NOT AN ARCHIVE.
 *
 * THE FOREIGN CSV IS THE SHAPE THAT PROVES THE SPINE, precisely because it has
 * no archive, no manifest and nothing to unpack. If the pipeline only fitted
 * things with an index, the "shared" spine would be restore's pipeline with the
 * importers bolted to it -- which is the knot this phase was reordered to
 * avoid.
 *
 * It costs one function because the interesting part was never the unpacking:
 * it is the ref, and a payload of exactly one member mints exactly one ref.
 * Everything downstream -- inspect, the plan, the executor's containment -- is
 * identical, and intake.test.ts runs the same assertions over this payload as
 * over an archive's.
 */
export function stageVerbatim(options: StageVerbatimOptions): StagedPayload {
  const { file, memberName = file.filename } = options;
  const ref = new StagedMemberRef(MINT, memberName);
  const paths = new Map<StagedMemberRef, string>([[ref, file.path]]);
  return makePayload({
    members: [{ ref, name: memberName, bytes: file.bytes }],
    paths,
    stagedBytes: file.bytes,
    dispose: file.dispose,
  });
}

/**
 * The reader, built around a Map KEYED BY THE REF OBJECT ITSELF.
 *
 * NOT KEYED BY THE ID STRING, and that is the difference between a capability
 * and a naming convention. A string key would resolve any object carrying the
 * right `id`, including one a caller assembled; an object key resolves only the
 * refs this staging minted, so a ref from a DIFFERENT intake -- the shape a
 * concurrency bug produces -- is refused rather than silently reading the wrong
 * archive.
 */
function makePayload(input: {
  members: StagedMember[];
  paths: Map<StagedMemberRef, string>;
  stagedBytes: number;
  dispose: () => Promise<void>;
}): StagedPayload {
  const { members, paths, stagedBytes } = input;
  const byName = new Map(members.map((member) => [member.name, member]));

  const resolve = (ref: StagedMemberRef): string => {
    const full = paths.get(ref);
    if (full === undefined) {
      throw new IntakeRefError(
        "this staged payload did not mint that member reference; "
        + "a step reads only what its plan describes",
      );
    }
    return full;
  };

  const readBytes = async (
    ref: StagedMemberRef, maxBytes = DEFAULT_MAX_TEXT_BYTES,
  ): Promise<Buffer> => {
    const full = resolve(ref);
    const info = await stat(full);
    if (info.size > maxBytes) {
      throw new IntakeTooLargeError(maxBytes, `the member ${JSON.stringify(ref.id)}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(full)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  return {
    members,
    stagedBytes,
    byName: (name) => byName.get(name),
    open: async (ref) => Promise.resolve(createReadStream(resolve(ref))),
    readBytes,
    readText: async (ref, maxBytes) => (await readBytes(ref, maxBytes)).toString("utf8"),
    dispose: input.dispose,
  };
}
