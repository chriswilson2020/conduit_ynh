import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  archiveMemberProblem, archivePathProblem, attributeFlags, attributeMode,
  parseArchiveIndex, receiveIntake, safeFilename,
  sevenZipExtractArgs, sevenZipListArgs, stageArchive, stagedPathProblem, stageVerbatim,
  sweepAbandonedIntakes, StagedMemberRef,
  DEFAULT_MAX_TEXT_BYTES, INTAKE_WORK_PREFIX,
  IntakeArchiveError, IntakeDiskSpaceError, IntakePassphraseError, IntakeRefError,
  IntakeShapeError, IntakeTooLargeError,
  type ArchiveIndexEntry, type IntakeFile,
} from "./intake.js";
import {
  digestOf, readSevenZipIndex, writeSevenZip, writeSymlinkSevenZip, writeTraversalSevenZip,
  writeZip, HAVE_7Z,
} from "../test/archives.js";

// THE SPINE'S FIRST TWO STAGES, AND THE DISCIPLINES THEY EXIST TO HOLD.
//
// Everything here is about what happens BEFORE anything is decided: the upload
// lands as a credential store, the archive is refused for what its own index
// says about it, and nothing is unpacked until the disk has been asked. The
// plan, and the frame apply runs in, are intake-plan.test.ts.

const it7z = HAVE_7Z ? it : it.skip;

// /proc is the only way for a process to count its own open descriptors, and it
// is Linux-only. The dev server and the CI runner both have it, which is where
// the descriptor bound has to hold; a developer on macOS gets a visible skip
// rather than a silent pass. Same gate export.test.ts uses, for the same reason.
const HAVE_PROC = await readdir("/proc/self/fd").then(() => true, () => false);
const itFd = HAVE_PROC ? it : it.skip;
const it7zProc = HAVE_7Z && HAVE_PROC ? it : it.skip;

const PASSPHRASE = "correct horse battery staple";

/**
 * The error a promise rejected with, or a loud failure if it did not reject.
 *
 * NOT `.catch((e) => e as SomeError)`: that form types the value but says
 * nothing about whether the call rejected at all, so a guard that stopped
 * firing would read as an object with no `message` rather than as a failure.
 * This one has no path that returns without a rejection.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected this to be refused, and it was not");
}


let dataDir: string;
let scratch: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-intake-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-intake-scratch-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

/** Land a buffer as an upload, the way a route's multipart part would. */
async function land(
  content: Buffer | string, overrides: Partial<Parameters<typeof receiveIntake>[0]> = {},
): Promise<IntakeFile> {
  return await receiveIntake({
    dataDir,
    source: Readable.from([Buffer.from(content)]),
    filename: "upload.bin",
    ...overrides,
  });
}

/** How many work directories $data_dir currently holds. */
async function workDirs(): Promise<string[]> {
  return (await readdir(dataDir)).filter((entry) => entry.startsWith(INTAKE_WORK_PREFIX));
}

/**
 * How many descriptors this process holds on anything inside an intake work
 * directory, INCLUDING ONES ALREADY DELETED.
 *
 * `readlink` on /proc/self/fd/N reports a removed file as "<path> (deleted)",
 * which is exactly the leak worth catching: an abandoned upload whose directory
 * was removed while a descriptor on it stayed open costs a descriptor for the
 * life of the process AND keeps the blocks allocated, so the credential store
 * is still on the disk with no name to find it by.
 */
async function intakeDescriptors(): Promise<number> {
  const entries = await readdir("/proc/self/fd");
  let count = 0;
  for (const entry of entries) {
    try {
      if ((await readlink(path.join("/proc/self/fd", entry))).includes(INTAKE_WORK_PREFIX)) {
        count += 1;
      }
    } catch { /* the descriptor closed while we were looking */ }
  }
  return count;
}

// ---------------------------------------------------------------------------
// The pure rules. No disk, no child process, no archive: every hostile shape
// the spine refuses is a value here first, and an archive afterwards.
// ---------------------------------------------------------------------------

describe("safeFilename", () => {
  it("keeps an ordinary name", () => {
    expect(safeFilename("conduit-backup-2026-09-01.7z")).toBe("conduit-backup-2026-09-01.7z");
  });

  it("reduces a path to its last component", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\chris\\backup.7z")).toBe("backup.7z");
  });

  it("refuses to return something that names a directory", () => {
    expect(safeFilename("..")).toBe("upload");
    expect(safeFilename(".")).toBe("upload");
    expect(safeFilename("")).toBe("upload");
    expect(safeFilename("   ")).toBe("upload");
  });

  it("strips control characters, which would break any line it is printed on", () => {
    expect(safeFilename("back\nup\u0000.7z")).toBe("backup.7z");
  });
});

describe("parseArchiveIndex", () => {
  // The exact shape `7z l -slt` produces on the deploy target, prompt and all:
  // the passphrase prompt lands on STDOUT, so a parser that did not tolerate it
  // would fail on every encrypted archive and on no unencrypted one.
  const LISTING = [
    "",
    "7-Zip [64] 26.02 : Copyright (c) 1999-2026 Igor Pavlov : 2026-06-25",
    "",
    "Listing archive: a.7z",
    "",
    "Enter password (will not be echoed):",
    "--",
    "Path = a.7z",
    "Type = 7z",
    "Method = LZMA2:12 7zAES",
    "",
    "----------",
    "Path = files",
    "Size = 0",
    "Attributes = D drwxr-xr-x",
    "",
    "Path = files/aaaa",
    "Size = 20",
    "Attributes = A -rw-r--r--",
    "",
    "Path = manifest.json",
    "Size = 2",
    "Attributes = A -rw-r--r--",
    "",
  ].join("\n");

  it("reads the members that follow the separator, and not the archive itself", () => {
    const index = parseArchiveIndex(LISTING);
    expect(index.map((entry) => entry.path)).toEqual(["files", "files/aaaa", "manifest.json"]);
    expect(index.map((entry) => entry.bytes)).toEqual([0, 20, 2]);
  });

  it("keeps the attributes, which is how a directory and a symlink are told apart", () => {
    const index = parseArchiveIndex(LISTING);
    expect(index[0]?.attributes).toBe("D drwxr-xr-x");
    expect(index[1]?.attributes).toBe("A -rw-r--r--");
  });

  it("reads a blank Size as zero rather than NaN", () => {
    const index = parseArchiveIndex("----------\nPath = x\nSize = \n\n");
    expect(index[0]?.bytes).toBe(0);
  });

  it("returns nothing when there is no separator at all", () => {
    expect(parseArchiveIndex("7-Zip 26.02\nERROR: not an archive\n")).toEqual([]);
  });
});

describe("archiveMemberProblem", () => {
  const entry = (over: Partial<ArchiveIndexEntry>): ArchiveIndexEntry => ({
    path: "manifest.json", bytes: 10, attributes: "A -rw-r--r--", ...over,
  });

  it("accepts an ordinary 7z member", () => {
    expect(archiveMemberProblem(entry({ path: "files/ab12" }))).toBeNull();
  });

  // THE FOUR SHAPES `Attributes` ACTUALLY TAKES, all measured on the deploy
  // target in one run. The earlier version of this file called " -rw-r--r--" a
  // member that "carries no unix mode at all" -- it misread the format. The
  // LEADING SPACE is the empty DOS field and `-rw-r--r--` IS the mode, which is
  // precisely why a positional reader walked a ZIP symlink straight through.
  it("reads the mode out of every shape 7z prints it in", () => {
    expect(attributeMode("A -rw-r--r--")).toBe("-rw-r--r--");      // 7z: DOS, then mode
    expect(attributeMode(" lrwxrwxrwx")).toBe("lrwxrwxrwx");        // ZIP: empty DOS field
    expect(attributeMode("V 01800000 0rw-------")).toBe("0rw-------"); // ZIP: three tokens
    expect(attributeMode("D drwxr-xr-x")).toBe("drwxr-xr-x");
    expect(attributeMode("A")).toBe("");                            // no unix mode at all
    expect(attributeMode("")).toBe("");
  });

  it("reads the DOS flags without mistaking the mode or the hex for one", () => {
    expect(attributeFlags("A -rw-r--r--")).toBe("A");
    expect(attributeFlags("D drwxr-xr-x")).toBe("D");
    expect(attributeFlags(" lrwxrwxrwx")).toBe("");
    expect(attributeFlags("V 01800000 0rw-------")).toBe("V");
  });

  it("accepts a member whose mode carries no file-type bits", () => {
    // "0rw-------" is what a ZIP member written without unix type bits reports
    // -- an entirely ordinary file. A rule that demanded a leading "-" refused
    // it, which would have refused an operator's export.
    expect(archiveMemberProblem(entry({ attributes: "V 01800000 0rw-------" }))).toBeNull();
    expect(archiveMemberProblem(entry({ attributes: " -rw-r--r--" }))).toBeNull();
    expect(archiveMemberProblem(entry({ attributes: "A" }))).toBeNull();
    expect(archiveMemberProblem(entry({ attributes: "" }))).toBeNull();
  });

  // THE DEFECT THIS FILE SHIPPED. A ZIP member written on unix carries no DOS
  // flags, so 7z prints two spaces and a positional split calls the mode "".
  it("refuses a ZIP symlink, whose DOS field is empty", () => {
    expect(archiveMemberProblem(entry({ path: "files/evil", attributes: " lrwxrwxrwx" })))
      .toContain("symbolic link");
  });

  it("refuses a ZIP fifo, socket and device, which the same hole swallowed", () => {
    for (const mode of ["prw-r--r--", "srwxrwxrwx", "crw-rw-rw-", "brw-rw-rw-"]) {
      expect(archiveMemberProblem(entry({ attributes: ` ${mode}` })), mode)
        .toMatch(/named pipe|socket|character device|block device/);
    }
  });

  it("refuses an absolute path", () => {
    expect(archiveMemberProblem(entry({ path: "/etc/passwd" }))).toContain("absolute");
    expect(archiveMemberProblem(entry({ path: "\\windows\\system32" }))).toContain("absolute");
  });

  it("refuses a drive letter", () => {
    expect(archiveMemberProblem(entry({ path: "C:/Windows/System32/x" }))).toContain("drive");
  });

  it("refuses a '..' component, in either separator", () => {
    expect(archiveMemberProblem(entry({ path: "../../etc/passwd" }))).toContain("'..'");
    expect(archiveMemberProblem(entry({ path: "files/../../x" }))).toContain("'..'");
    expect(archiveMemberProblem(entry({ path: "files\\..\\..\\x" }))).toContain("'..'");
  });

  // NOT REFUSED, and that is deliberate: "..." and "a..b" are ordinary names,
  // and a rule that matched the substring would refuse a blob whose digest
  // happened to contain one.
  it("accepts a name that merely contains dots", () => {
    expect(archiveMemberProblem(entry({ path: "files/a..b" }))).toBeNull();
    expect(archiveMemberProblem(entry({ path: "..." }))).toBeNull();
  });

  it("refuses a symbolic link", () => {
    expect(archiveMemberProblem(entry({ attributes: "A lrwxrwxrwx" }))).toContain("symbolic link");
  });

  it("refuses a device, a socket and a fifo in the 7z form too", () => {
    for (const mode of ["crw-rw-rw-", "srwxrwxrwx", "prw-r--r--"]) {
      expect(archiveMemberProblem(entry({ attributes: `A ${mode}` })), mode)
        .toMatch(/named pipe|socket|character device/);
    }
  });

  it("refuses a member with no usable name", () => {
    for (const name of ["", ".", ".."]) {
      expect(archiveMemberProblem(entry({ path: name })), JSON.stringify(name))
        .toContain("no usable name");
    }
  });

  it("refuses an impossible size", () => {
    expect(archiveMemberProblem(entry({ bytes: -1 }))).toContain("impossible size");
    expect(archiveMemberProblem(entry({ bytes: Number.NaN }))).toContain("impossible size");
  });
});

describe("archivePathProblem", () => {
  // A DIRECTORY MEMBER STILL HAS A PATH. The kind rule skips directories -- a
  // real backup carries a `files` entry -- and filtering before checking let
  // `../../escapedir/` reach 7z with nothing having looked at it.
  it("refuses an escaping directory member, trailing slash and all", () => {
    expect(archivePathProblem("../../escapedir/")).toContain("'..'");
    expect(archivePathProblem("/absdir/")).toContain("absolute");
    expect(archivePathProblem("files/../../x/")).toContain("'..'");
  });

  it("accepts an ordinary directory member", () => {
    expect(archivePathProblem("files/")).toBeNull();
    expect(archivePathProblem("files")).toBeNull();
  });
});

describe("stagedPathProblem", () => {
  // The population this exists for is exactly the one archiveMemberProblem
  // already refuses -- which is the point. It is what stands between an archive
  // and $data_dir if that rule is ever loosened, so it is asserted firing on
  // the same names rather than assumed to.
  it("refuses a resolution that leaves the staging directory", () => {
    expect(stagedPathProblem("/data/.intake-work-a/staged", "/data/.intake-work-a/upload"))
      .toContain("outside");
    expect(stagedPathProblem("/data/.intake-work-a/staged", "/etc/passwd")).toContain("outside");
  });

  it("refuses the staging directory itself", () => {
    expect(stagedPathProblem("/data/x/staged", "/data/x/staged")).toContain("itself");
  });

  // A PREFIX MATCH WITHOUT THE SEPARATOR WOULD PASS THIS, and it is the classic
  // way a containment check is written wrong.
  it("refuses a sibling whose name merely starts with the destination's", () => {
    expect(stagedPathProblem("/data/x/staged", "/data/x/staged-elsewhere/f")).toContain("outside");
  });

  it("accepts a member inside it", () => {
    expect(stagedPathProblem("/data/x/staged", "/data/x/staged/files/ab")).toBeNull();
  });
});

describe("the 7z argument lists", () => {
  // EXPORTED SO A TEST CAN ASSERT WHAT IS NOT IN THEM. services/backup.ts makes
  // the same assertion about the write side; this is the read side, which is
  // the direction nothing had travelled before this phase.
  it("never carries the passphrase, and never carries a bare -p", () => {
    for (const args of [
      sevenZipListArgs("/data/x/upload"),
      sevenZipExtractArgs("/data/x/upload", "/data/x/staged"),
    ]) {
      expect(args).not.toContain("-p");
      expect(args.some((arg) => arg.startsWith("-p"))).toBe(false);
      expect(args.join(" ")).not.toContain(PASSPHRASE);
    }
  });

  // MEASURED, not stylistic: `7z x -o /dir` (separated) is not the same
  // argument as `7z x -o/dir`, and the separated form makes 7z treat the
  // directory as an archive to extract.
  it("joins the extraction directory to -o, which 7z requires", () => {
    expect(sevenZipExtractArgs("/a/b.7z", "/a/staged")).toContain("-o/a/staged");
  });
});

// ---------------------------------------------------------------------------
// INGEST. The upload is a credential store from the moment it lands.
// ---------------------------------------------------------------------------

describe("receiveIntake", () => {
  it("lands the upload 0600 inside a 0700 directory inside $data_dir", async () => {
    const file = await land("hello");
    expect(file.path.startsWith(dataDir + path.sep)).toBe(true);
    // NEVER /tmp, and asserted rather than assumed. conf/systemd.service's
    // ProtectSystem=full makes $data_dir the only writable path in production,
    // but the fixtures here run with no such restriction -- so the property has
    // to be checked, not inherited.
    expect(file.path.startsWith(os.tmpdir() + path.sep + "conduit-intake-data-")).toBe(true);
    expect(path.dirname(path.dirname(file.path))).toBe(dataDir);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file.path))).mode & 0o777).toBe(0o700);
    expect(path.basename(path.dirname(file.path)).startsWith(INTAKE_WORK_PREFIX)).toBe(true);
    await file.dispose();
  });

  // THE TWO MECHANISMS THAT KEEP THIS FILE AT 0600 MASKED EACH OTHER, AND SO
  // NEITHER WAS GUARDED. Mutating the creation mode to 0644 alone was not
  // caught -- the chmod after the last chunk fixed it. Removing that chmod
  // alone was not caught either -- the creation mode had already made it 0600.
  // Only both together failed, so "there is no instant at which this file is
  // wider than 0600" was prose. These two tests separate them.

  it("is already 0600 while the bytes are still arriving", async () => {
    // The creation mode on its own, measured DURING the write. A source that
    // waits after its first chunk gives the test a window in which only
    // createWriteStream's own mode can have applied.
    // A source that pushes one chunk and then waits to be ended, so the file
    // exists and the pipeline is open while the mode is read.
    const source = new Readable({ read() { /* ended below */ } });
    source.push(Buffer.alloc(1024, 7));

    const landing = receiveIntake({ dataDir, source, filename: "backup.7z" });
    let uploadPath = "";
    for (let attempt = 0; attempt < 200 && uploadPath === ""; attempt += 1) {
      const dirs = await workDirs();
      if (dirs[0] !== undefined) {
        const candidate = path.join(dataDir, dirs[0], "upload");
        if (await stat(candidate).then(() => true, () => false)) uploadPath = candidate;
      }
      if (uploadPath === "") await new Promise((r) => setTimeout(r, 5));
    }
    expect(uploadPath, "the upload should exist while the stream is open").not.toBe("");
    const modeDuring = (await stat(uploadPath)).mode & 0o777;

    source.push(null);
    const file = await landing;
    expect(modeDuring, "0600 from the moment the file exists, not from the end").toBe(0o600);
    await file.dispose();
  });

  it("is 0600 even under a umask that would have stripped the owner's bits", async () => {
    // The chmod on its own. A umask can only NARROW a requested mode, so the
    // file is never WIDER than 0600 -- but 0o400 in the umask makes it 0200,
    // which is not the mode this discipline claims and is not one the staging
    // can read back. The chmod after the last chunk is the only thing that
    // settles it, and this is the only condition under which that line does
    // anything at all.
    //
    // 0o400 AND NOT 0o200, measured: stripping the WRITE bit makes the open
    // itself fail with EACCES, so there is nothing left for a chmod to fix.
    const previous = process.umask(0o400);
    try {
      const file = await land("secret bytes");
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
      // AND THE DIRECTORY, which the same umask narrows to 0300 -- traversable
      // by name, but not readable, so the recursive remove in `dispose` fails
      // with EACCES and the credential store cannot be deleted at all. Found by
      // this test rather than reasoned about.
      expect((await stat(path.dirname(file.path))).mode & 0o777).toBe(0o700);
      await file.dispose();
      expect(await workDirs()).toEqual([]);
    } finally {
      process.umask(previous);
    }
  });

  it("reports the size and the digest of what actually arrived", async () => {
    const content = randomBytes(64 * 1024);
    const file = await land(content);
    expect(file.bytes).toBe(content.length);
    expect(file.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(await readFile(file.path)).toEqual(content);
    await file.dispose();
  });

  it("remembers the operator's filename as a label and never as a path", async () => {
    const file = await land("x", { filename: "../../etc/passwd" });
    expect(file.filename).toBe("passwd");
    expect(path.basename(file.path)).toBe("upload");
    await file.dispose();
  });

  it("refuses an upload past the cap, and leaves nothing behind", async () => {
    await expect(land(randomBytes(4096), { maxBytes: 1024 }))
      .rejects.toBeInstanceOf(IntakeTooLargeError);
    expect(await workDirs()).toEqual([]);
  });

  // THE ORDINARY FAILURE, NOT THE EXOTIC ONE. An operator who changes their
  // mind about uploading a 3GB backup produces exactly this, and what it must
  // not leave in $data_dir is a partial credential store.
  it("removes everything when the upload is abandoned part-way", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(1024, 1));
        this.destroy(new Error("the client went away"));
      },
    });
    await expect(receiveIntake({ dataDir, source, filename: "backup.7z" })).rejects.toThrow();
    expect(await workDirs()).toEqual([]);
  });

  it("refuses to start on a disk with no room, before creating anything", async () => {
    await expect(land("x", { freeBytes: async () => Promise.resolve(1024) }))
      .rejects.toBeInstanceOf(IntakeDiskSpaceError);
    expect(await workDirs()).toEqual([]);
  });

  it("disposes idempotently", async () => {
    const file = await land("x");
    await file.dispose();
    await file.dispose();
    expect(await workDirs()).toEqual([]);
  });

  // v1.3.0 COUNTED DESCRIPTORS AFTER ABORTED REQUESTS AND FOUND A REAL LEAK.
  // This is the same instrument pointed the other way: an abandoned upload that
  // left a descriptor open would keep the blocks allocated with no name left to
  // find them by -- a credential store on the disk that no sweep can remove.
  itFd("leaves no descriptor open after five abandoned uploads", async () => {
    expect(await intakeDescriptors()).toBe(0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const source = new Readable({
        read() {
          this.push(Buffer.alloc(256 * 1024, attempt));
          this.destroy(new Error("abandoned"));
        },
      });
      await expect(receiveIntake({ dataDir, source, filename: "backup.7z" })).rejects.toThrow();
    }
    await new Promise<void>((resolve) => { setImmediate(() => { resolve(); }); });
    expect(await intakeDescriptors(), "an abandoned upload must not leak a descriptor").toBe(0);
    expect(await workDirs()).toEqual([]);
  });

  itFd("leaves no descriptor open after an upload that succeeds and is disposed", async () => {
    const file = await land(randomBytes(512 * 1024));
    await file.dispose();
    await new Promise<void>((resolve) => { setImmediate(() => { resolve(); }); });
    expect(await intakeDescriptors()).toBe(0);
  });
});

describe("sweepAbandonedIntakes", () => {
  it("removes intake work directories and nothing else", async () => {
    await mkdir(path.join(dataDir, `${INTAKE_WORK_PREFIX}abc`), { recursive: true });
    await writeFile(path.join(dataDir, `${INTAKE_WORK_PREFIX}abc`, "upload"), "secret");
    // The backup's own prefix. A sweep that took this too would delete a
    // running backup's work directory out from under it -- which is the whole
    // reason the two prefixes differ.
    await mkdir(path.join(dataDir, ".backup-work-xyz"), { recursive: true });
    await mkdir(path.join(dataDir, "files"), { recursive: true });

    expect(await sweepAbandonedIntakes(dataDir)).toEqual([`${INTAKE_WORK_PREFIX}abc`]);
    expect((await readdir(dataDir)).sort()).toEqual([".backup-work-xyz", "files"]);
  });

  it("says nothing and throws nothing when $data_dir is unreadable", async () => {
    expect(await sweepAbandonedIntakes(path.join(dataDir, "does-not-exist"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// STAGE, for something that is not an archive. The shape that proves the spine.
// ---------------------------------------------------------------------------

describe("stageVerbatim", () => {
  const CSV = "First Name;Last Name;E-mail\r\nAda;Lovelace;ada@example.com\r\n";

  it("stages a foreign CSV as one member, with nothing unpacked", async () => {
    const file = await land(CSV, { filename: "outlook-contacts.csv" });
    const payload = stageVerbatim({ file });
    expect(payload.members).toHaveLength(1);
    expect(payload.members[0]?.name).toBe("outlook-contacts.csv");
    expect(payload.members[0]?.bytes).toBe(Buffer.byteLength(CSV));
    expect(payload.stagedBytes).toBe(Buffer.byteLength(CSV));
    await payload.dispose();
  });

  it("reads the member back through its ref", async () => {
    const file = await land(CSV, { filename: "c.csv" });
    const payload = stageVerbatim({ file });
    const ref = payload.byName("c.csv")?.ref;
    expect(ref).toBeDefined();
    expect(await payload.readText(ref!)).toBe(CSV);
    await payload.dispose();
  });

  it("disposes the upload with the payload", async () => {
    const file = await land(CSV);
    const payload = stageVerbatim({ file });
    await payload.dispose();
    expect(await workDirs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE REFS. The mechanism the whole "apply cannot exceed its plan" property
// rests on, tested here where it is minted rather than where it is consumed.
// ---------------------------------------------------------------------------

describe("staged member refs", () => {
  it("cannot be minted from outside services/intake.ts", () => {
    expect(() => new StagedMemberRef(Symbol("not the mint"), "manifest.json"))
      .toThrow(IntakeRefError);
  });

  it("refuses a ref that was cast into the type rather than minted", async () => {
    const file = await land("a,b\r\n1,2\r\n", { filename: "c.csv" });
    const payload = stageVerbatim({ file });
    const forged = { id: "c.csv" } as unknown as StagedMemberRef;
    await expect(payload.readText(forged)).rejects.toBeInstanceOf(IntakeRefError);
    await payload.dispose();
  });

  // THE MAP IS KEYED BY THE OBJECT, NOT BY THE ID, and this is the assertion
  // that proves it. Two payloads whose single member has the SAME NAME still
  // mint different refs, so a ref that leaked across a concurrency boundary
  // reads nothing rather than reading the wrong install's data.
  it("refuses a genuine ref that belongs to a different staging", async () => {
    const one = stageVerbatim({ file: await land("one", { filename: "c.csv" }) });
    const two = stageVerbatim({ file: await land("two", { filename: "c.csv" }) });
    const refFromOne = one.members[0]!.ref;
    expect(refFromOne.id).toBe(two.members[0]!.ref.id);
    await expect(two.readText(refFromOne)).rejects.toBeInstanceOf(IntakeRefError);
    expect(await one.readText(refFromOne)).toBe("one");
    await one.dispose();
    await two.dispose();
  });

  it("refuses to read a member larger than the cap it was given", async () => {
    const file = await land(randomBytes(4096), { filename: "c.csv" });
    const payload = stageVerbatim({ file });
    await expect(payload.readText(payload.members[0]!.ref, 1024))
      .rejects.toBeInstanceOf(IntakeTooLargeError);
    expect((await payload.readBytes(payload.members[0]!.ref)).length).toBe(4096);
    expect(DEFAULT_MAX_TEXT_BYTES).toBeGreaterThan(4096);
    await payload.dispose();
  });
});

// ---------------------------------------------------------------------------
// STAGE, for an archive. Everything below drives the real `7z`, because a
// reader written here would share every assumption the writer makes.
// ---------------------------------------------------------------------------

/** A backup-shaped `.7z`: the four members docs/backup-format.md declares. */
async function backupArchive(options: {
  extraBlob?: boolean;
  passphrase?: string;
  // A CALLER THAT WANTS TWO ARCHIVES NEEDS TWO NAMES. `7z a` APPENDS to an
  // existing file rather than replacing it, so a second call to the default name
  // does not overwrite the first archive -- it tries to add members to it, with
  // whatever passphrase it was given. The passphrase-in-argv case below builds
  // two archives with two different passphrases and would have hit exactly that.
  fileName?: string;
} = {}): Promise<{ archivePath: string; blob: string; extra: string | null }> {
  const blobContent = randomBytes(512);
  const blob = digestOf(blobContent);
  const extraContent = randomBytes(256);
  const extra = digestOf(extraContent);
  const members = [
    { name: "manifest.json", content: JSON.stringify({ kind: "backup", formatVersion: 1 }) },
    { name: "database.sql", content: "SELECT 1;\n" },
    { name: "mail.key", content: randomBytes(32) },
    { name: `files/${blob}`, content: blobContent },
  ];
  if (options.extraBlob === true) {
    members.push({ name: `files/${extra}`, content: extraContent });
  }
  const archivePath = path.join(scratch, options.fileName ?? "backup.7z");
  await writeSevenZip({
    archivePath,
    workDir: await mkdtemp(path.join(scratch, "payload-")),
    members,
    passphrase: options.passphrase ?? PASSPHRASE,
  });
  return { archivePath, blob, extra: options.extraBlob === true ? extra : null };
}

/** Land a file that already exists on disk as an upload. */
async function landFile(filePath: string, filename: string): Promise<IntakeFile> {
  return await receiveIntake({
    dataDir, source: Readable.from([await readFile(filePath)]), filename,
  });
}

describe("stageArchive, on an encrypted .7z", () => {
  it7z("unpacks the four members a Conduit backup declares", async () => {
    const { archivePath, blob } = await backupArchive();
    const file = await landFile(archivePath, "conduit-backup.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    expect([...payload.members].map((m) => m.name).sort())
      .toEqual(["database.sql", `files/${blob}`, "mail.key", "manifest.json"]);
    expect(JSON.parse(await payload.readText(payload.byName("manifest.json")!.ref)))
      .toEqual({ kind: "backup", formatVersion: 1 });
    expect(payload.stagedBytes).toBeGreaterThan(0);
    await payload.dispose();
    expect(await workDirs()).toEqual([]);
  }, 60_000);

  // THE MEASUREMENT THIS MODULE WAS BUILT ON, asserted rather than quoted. If
  // `7z x` ever stops taking the passphrase from stdin, this is the test that
  // says so -- and it says so before an operator finds out with a restore.
  it7z("takes the passphrase from stdin, which is the whole of sevenZipExtractArgs", async () => {
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    expect(payload.members.length).toBe(4);
    await payload.dispose();
  }, 60_000);

  it7z("refuses a wrong passphrase, with nothing unpacked", async () => {
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    await expect(stageArchive({ file, passphrase: "not the passphrase" }))
      .rejects.toBeInstanceOf(IntakeArchiveError);
    // The upload survives -- disposing it is the caller's business, because the
    // caller is the one that knows whether the operator gets another try.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // THE MESSAGE MUST NOT SAY HOW CLOSE THE PASSPHRASE WAS, and with -mhe=on it
  // could not: the header is encrypted, so a wrong passphrase and a damaged
  // header are the same event to the same code path. Conduit never compares a
  // passphrase to anything, which is why there is nothing here that could leak.
  //
  // THE HEADER OF A .7z IS AT ITS END, and this test learned that the hard way
  // -- an earlier version corrupted bytes 40..80 and the archive LISTED
  // perfectly, because what sits there is compressed data rather than the
  // index. That is the distinction the next test records.
  it7z("says the same thing for a wrong passphrase and for a damaged header", async () => {
    const { archivePath } = await backupArchive();
    const wrongPass = await landFile(archivePath, "b.7z");
    const bytes = await readFile(archivePath);
    bytes.fill(0, bytes.length - 48);
    const damagedPath = path.join(scratch, "damaged.7z");
    await writeFile(damagedPath, bytes);
    const damaged = await landFile(damagedPath, "b.7z");

    const first = await rejection(stageArchive({ file: wrongPass, passphrase: "wrong" }));
    const second = await rejection(stageArchive({ file: damaged, passphrase: PASSPHRASE }));
    expect(first).toBeInstanceOf(IntakeArchiveError);
    expect(second).toBeInstanceOf(IntakeArchiveError);
    expect(first.message).toBe(second.message);
    await wrongPass.dispose();
    await damaged.dispose();
  }, 60_000);

  // AND THE OTHER HALF OF THAT, which is not a leak and is worth telling apart.
  // Damage to the compressed BODY is found at extraction rather than at
  // listing, by which point the passphrase has already been proved correct --
  // so the two messages differ, and they should: one means "you cannot open
  // this", the other means "you opened it and it is broken".
  it7z("distinguishes a damaged body, and stages nothing when it finds one", async () => {
    const { archivePath } = await backupArchive();
    const bytes = await readFile(archivePath);
    // Past the 32-byte signature header and well short of the end header.
    bytes.fill(0xff, 40, 96);
    const damagedPath = path.join(scratch, "body.7z");
    await writeFile(damagedPath, bytes);
    const file = await landFile(damagedPath, "b.7z");

    const error = await rejection(stageArchive({ file, passphrase: PASSPHRASE }));
    expect(error).toBeInstanceOf(IntakeArchiveError);
    expect(error.message).toContain("did not unpack completely");
    // The half-extracted staging is removed, so nothing downstream can read a
    // truncated dump believing it is whole.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // THE PASSPHRASE MUST NOT REACH argv, and the control is what makes the scan
  // an instrument: it shows the same scan FINDING a passphrase when one is
  // passed as -p<value>, so a pass on the real path means the scan looked.
  it7zProc("never puts the passphrase on a command line", async () => {
    // THE CONTROL GETS ITS OWN SECRET, AND THAT IS THE FIX FOR A TEST THAT WAS
    // CATCHING ITSELF.
    //
    // The scan further down reads EVERY process on the machine. The control
    // deliberately puts a passphrase in argv; while that was the same PASSPHRASE
    // the scan then looks for, the control was a process the scan was entitled
    // to find -- and did. Measured on the dev server, 4 Sep, on the SERIAL suite,
    // so this predates file parallelism entirely:
    //
    //   AssertionError: the passphrase must never appear in any process's argv
    //   Received: "/usr/lib/p7zip/7z l -bd -y -pcorrect horse battery staple
    //              -- /tmp/conduit-intake-scratch-UlE2AQ/backup.7z"
    //
    // That argv is the CONTROL'S, not stageArchive's: `-- <scratch>/backup.7z` is
    // the path only the control passes, and stageArchive never puts -p<value>
    // anywhere. `control.kill()` had not stopped it, because Debian's /usr/bin/7z
    // is a shell wrapper that does not exec -- the signal reaches the wrapper and
    // the /usr/lib/p7zip/7z it started runs on. The test was racing its own
    // leftovers, and lost.
    //
    // backup.test.ts's equivalent case already had the answer and this file did
    // not borrow it: it watches for a `PASSPHRASE-${randomUUID()}` marker nothing
    // else on the machine could hold. Same idea, mirrored -- the CONTROL takes
    // the unique value, so a control that outlives its kill is invisible to the
    // scan for the real one. It matters more now that test files run
    // concurrently: seven suites share the "correct horse battery staple"
    // literal, and a whole-machine scan for it was never safe beside them.
    const controlMarker = `CONTROL-PASSPHRASE-${randomUUID()}`;
    const { archivePath: controlArchive } = await backupArchive({
      passphrase: controlMarker, fileName: "control.7z",
    });

    // CONTROL: the same scan, against a 7z that IS given -p<value>. RETRIED,
    // because what is being observed is a process that lives for a few
    // milliseconds: one attempt that missed the window would fail this test for
    // a timing reason rather than a security one, and a control nobody trusts
    // is not a control. Five rounds of up to half a second; one sighting is
    // enough, since the claim is only that this scan CAN see a passphrase in
    // argv, and the direction a miss errs in is a red test rather than a
    // green one.
    let foundInControl = false;
    for (let round = 0; round < 5 && !foundInControl; round += 1) {
      // detached, so the kill below takes THE WRAPPER AND THE BINARY IT STARTED.
      // `child.kill()` signals only /usr/bin/7z, which is a shell script that
      // does not exec; the /usr/lib/p7zip/7z behind it survives, which is how the
      // sighting quoted above came to exist. Killing the process GROUP stops it.
      // Hygiene rather than correctness now that the marker is unique -- but a
      // shared dev server does not need this suite's orphans accumulating on it.
      const control = spawn(
        "7z", ["l", "-bd", "-y", `-p${controlMarker}`, "--", controlArchive],
        { stdio: "ignore", detached: true },
      );
      for (let attempt = 0; attempt < 100 && !foundInControl; attempt += 1) {
        try {
          const cmdline = await readFile(`/proc/${String(control.pid)}/cmdline`, "utf8");
          if (cmdline.split("\u0000").join(" ").includes(controlMarker)) foundInControl = true;
        } catch { /* the child exited */ }
        if (!foundInControl) await new Promise((r) => setTimeout(r, 5));
      }
      if (control.pid !== undefined) {
        try { process.kill(-control.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    expect(foundInControl, "the control must find a passphrase that IS in argv").toBe(true);

    // The real path, WITH A PASSPHRASE NO OTHER TEST CAN BE HOLDING.
    //
    // This scan reads every process on the machine, so what it looks for decides
    // what it can be fooled by. Looking for the shared "correct horse battery
    // staple" made three other suites into false positives the moment test files
    // stopped running one at a time -- they hand 7z that exact literal in argv,
    // legitimately, to open an archive they just wrote:
    //
    //   routes/backup.test.ts:98            7z x -p<PASSPHRASE> ...
    //   services/backup-format.test.ts:125  7z x -p<PASSPHRASE> ...
    //   services/backup.test.ts:191         7z x -p<passphrase> ...
    //
    // A run with any of those alongside this one would report a passphrase leak
    // in stageArchive that stageArchive had nothing to do with -- a red test
    // pointing at the wrong file, about security, which is the worst kind to
    // send someone chasing. A per-run marker cannot be confused for anyone
    // else's: if the scan sees it, this test's own code path put it there.
    const realMarker = `INTAKE-PASSPHRASE-${randomUUID()}`;
    const { archivePath } = await backupArchive({ passphrase: realMarker });
    const file = await landFile(archivePath, "b.7z");
    let leaked: string | null = null;
    const watcher = setInterval(() => {
      void (async () => {
        for (const pid of await readdir("/proc").catch(() => [])) {
          if (!/^\d+$/.test(pid)) continue;
          const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
          if (cmdline.includes(realMarker)) leaked = cmdline.split("\u0000").join(" ");
        }
      })();
    }, 3);
    const payload = await stageArchive({ file, passphrase: realMarker });
    clearInterval(watcher);
    expect(leaked, "the passphrase must never appear in any process's argv").toBeNull();
    await payload.dispose();
  }, 60_000);

  // The shared rule, reused rather than re-derived. 7z reads ONE LINE on the
  // way out exactly as it does on the way in -- measured -- so a passphrase
  // with a newline would be silently truncated here too.
  it("refuses a passphrase 7z would truncate, before it spawns anything", async () => {
    const file = await land("not really an archive", { filename: "b.7z" });
    await expect(stageArchive({ file, passphrase: "correct horse\nbattery staple" }))
      .rejects.toBeInstanceOf(IntakePassphraseError);
    // NOTHING WAS UNPACKED, which is the property that makes this cheap to get
    // right: a refusal that had already spawned 7z would have written a
    // directory for an archive it then refused to read.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  });

  it7z("refuses an archive carrying a symlink, before extracting anything", async () => {
    const archivePath = path.join(scratch, "sym.7z");
    await writeSymlinkSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "sympay-")),
      passphrase: PASSPHRASE,
    });

    // WHAT THIS BUILD OF 7z ACTUALLY STORED, read back before anything is
    // asserted about it. "The archive was written" does not mean "the archive
    // holds a link": 7-Zip's own Linux builds follow a symlink on the way in
    // unless `-snl` is given, and the unix mode that reveals one in the index
    // is an extension rather than a guarantee. An archive that lost the link
    // would stage cleanly and make this test pass by asserting a refusal that
    // never happened -- which is exactly how it failed on the CI runner before
    // this was here.
    const stored = await readSevenZipIndex(archivePath, PASSPHRASE);
    const indexShowsLink = stored.some((member) => /\bl[rwxst-]{9}/.test(member.attributes));

    const file = await landFile(archivePath, "b.7z");
    const error = await rejection(stageArchive({ file, passphrase: PASSPHRASE }));
    expect(error, JSON.stringify(stored)).toBeInstanceOf(IntakeShapeError);
    // NOTHING SURVIVES EITHER WAY. Whichever layer refused it, the staging is
    // gone and only the upload is left for the caller to dispose of.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);

    if (indexShowsLink) {
      // The cheap layer: refused from the INDEX, so no staging directory was
      // ever created and 7z never got the chance to recreate the link.
      expect(error.message).toContain("symbolic link");
    } else {
      // The other layer, on a build whose index does not admit to the link:
      // caught by lstat after extraction, which asks what the member IS rather
      // than what it points at.
      expect(error.message, JSON.stringify(stored)).toContain("did not unpack as a plain file");
    }
    await file.dispose();
  }, 60_000);

  // THE SECOND LAYER ON ITS OWN, on every platform rather than only on one
  // whose 7z hides the link. Without this the lstat rule would be exercised by
  // whichever build happened to run it, which is not an instrument.
  it7z("refuses a member that turns out to be a symlink after extraction", async () => {
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    const error = await rejection(stageArchive({
      file,
      passphrase: PASSPHRASE,
      onExtracted: async (destination) => {
        // A member the index called an ordinary file, replaced by a link to a
        // real file outside the staging. `stat` would follow it and report a
        // regular file; `lstat` reports the link.
        await rm(path.join(destination, "manifest.json"), { force: true });
        await symlink("/etc/passwd", path.join(destination, "manifest.json"));
      },
    }));
    expect(error).toBeInstanceOf(IntakeShapeError);
    expect(error.message).toContain("did not unpack as a plain file");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  it7z("refuses an archive whose member escapes with '..', before extracting", async () => {
    const archivePath = path.join(scratch, "trav.7z");
    const cwd = await mkdtemp(path.join(scratch, "travpay-"));
    await mkdir(path.join(cwd, "a", "b"), { recursive: true });
    await writeTraversalSevenZip({
      archivePath,
      cwd: path.join(cwd, "a", "b"),
      relativeMembers: ["../../escaped.txt"],
      passphrase: PASSPHRASE,
    });
    const file = await landFile(archivePath, "b.7z");
    const error = await rejection(stageArchive({ file, passphrase: PASSPHRASE }));
    expect(error).toBeInstanceOf(IntakeShapeError);
    expect(error.message).toContain("'..'");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // THE BOMB. A small archive that claims a large unpack is not hypothetical:
  // measured on the deploy target, a 2,207-byte .7z listed 4,194,304 bytes of
  // content. A cap on the UPLOAD does not bound the UNPACK.
  it7z("refuses an archive that claims more unpacked bytes than the cap", async () => {
    const archivePath = path.join(scratch, "bomb.7z");
    await writeSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "bombpay-")),
      members: [{ name: "database.sql", content: Buffer.alloc(4 * 1024 * 1024) }],
      passphrase: PASSPHRASE,
    });
    const file = await landFile(archivePath, "b.7z");
    // The archive itself is far smaller than what it claims -- which is the
    // whole reason the claim is what gets checked.
    expect(file.bytes).toBeLessThan(1024 * 1024);
    // BEFORE EXTRACTION, AND SAID SO DIRECTLY. There is a second size bound
    // AFTER extraction, and the two masked each other: mutating this one away
    // left the bomb refused by the other and nothing failed. The hook is the
    // discriminator -- it does not run at all if the refusal came first.
    let extracted = false;
    const error = await rejection(stageArchive({
      file,
      passphrase: PASSPHRASE,
      limits: { maxStagedBytes: 1024 * 1024 },
      onExtracted: async () => { extracted = true; await Promise.resolve(); },
    }));
    expect(error).toBeInstanceOf(IntakeTooLargeError);
    expect(extracted, "a bomb must be refused from its index, not after unpacking").toBe(false);
    expect(error.message).toContain("unpacked size");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  it7z("refuses an archive with more members than the cap", async () => {
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    await expect(stageArchive({ file, passphrase: PASSPHRASE, limits: { maxMembers: 3 } }))
      .rejects.toBeInstanceOf(IntakeTooLargeError);
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  it7z("refuses to unpack onto a disk that cannot hold it", async () => {
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    await expect(stageArchive({
      file, passphrase: PASSPHRASE,
      // Enough to LAND the upload, not enough to unpack it: receiveIntake's own
      // check demands only the margin, so this proves the second check exists
      // rather than riding on the first.
      freeBytes: async () => Promise.resolve(64 * 1024 * 1024 + 16),
    })).rejects.toBeInstanceOf(IntakeDiskSpaceError);
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // The instrument the onExtracted hook exists for -- see its comment in
  // services/intake.ts. Without the hook there is no fixture that lists a
  // member and then declines to produce it, so this check would ship untested.
  it7z("refuses when a listed member did not arrive", async () => {
    const { archivePath, blob } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    const error = await rejection(stageArchive({
      file,
      passphrase: PASSPHRASE,
      onExtracted: async (destination) => {
        await rm(path.join(destination, "files", blob), { force: true });
      },
    }));
    expect(error).toBeInstanceOf(IntakeArchiveError);
    expect(error.message).toContain("did not produce it");
    // AND THE HALF-STAGED TREE IS GONE. This is the one refusal that happens
    // after the extraction, so it is the only one with anything to clear up --
    // and what it would otherwise leave behind is a decrypted mail.key.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  it7z("refuses an empty archive", async () => {
    const archivePath = path.join(scratch, "empty.7z");
    const payloadDir = await mkdtemp(path.join(scratch, "emptypay-"));
    await mkdir(path.join(payloadDir, "files"), { recursive: true });
    await writeSevenZip({
      archivePath, workDir: payloadDir, members: [], passphrase: PASSPHRASE,
      extraInputs: [path.join(payloadDir, "files")],
    });
    const file = await landFile(archivePath, "b.7z");
    await expect(stageArchive({ file, passphrase: PASSPHRASE }))
      .rejects.toBeInstanceOf(IntakeArchiveError);
    await file.dispose();
  }, 60_000);

  itFd("leaves no descriptor open after staging and disposing", async () => {
    if (!HAVE_7Z) return;
    const { archivePath } = await backupArchive();
    const file = await landFile(archivePath, "b.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    await payload.readText(payload.byName("manifest.json")!.ref);
    await payload.dispose();
    await new Promise<void>((resolve) => { setImmediate(() => { resolve(); }); });
    expect(await intakeDescriptors()).toBe(0);
    expect(await workDirs()).toEqual([]);
  }, 60_000);
});

describe("stageArchive, on an unencrypted .zip", () => {
  // ONE ARCHIVER FOR BOTH CONTAINERS, and it is a measurement rather than a
  // hope: `7z l -slt` and `7z x` read a plain zip with an empty stdin and no
  // -p, so Conduit's own export needs no second reader, no second temp-file
  // discipline and no second set of shape rules.
  it7z("stages Conduit's own export with no passphrase at all", async () => {
    const zipPath = path.join(scratch, "export.zip");
    await writeZip({
      zipPath,
      members: [
        { name: "manifest.json", content: JSON.stringify({ formatVersion: 1 }) },
        { name: "companies.csv", content: "\uFEFFname\r\nAcme\r\n" },
        { name: "files/quote.pdf", content: randomBytes(128) },
      ],
    });
    const file = await landFile(zipPath, "conduit-export.zip");
    const payload = await stageArchive({ file, passphrase: null });
    expect([...payload.members].map((m) => m.name).sort())
      .toEqual(["companies.csv", "files/quote.pdf", "manifest.json"]);
    expect(await payload.readText(payload.byName("companies.csv")!.ref))
      .toBe("\uFEFFname\r\nAcme\r\n");
    await payload.dispose();
  }, 60_000);

  it7z("refuses a file that is not an archive at all", async () => {
    const file = await land(randomBytes(2048), { filename: "notes.txt" });
    await expect(stageArchive({ file, passphrase: null }))
      .rejects.toBeInstanceOf(IntakeArchiveError);
    await file.dispose();
  }, 60_000);

  // THE DEFECT THIS SUITE SHIPPED, END TO END, IN THE CONTAINER THE IMPORT
  // PIPELINE ACTUALLY USES. A zip symlink's `Attributes` is " lrwxrwxrwx" --
  // one token after a trim, because a member written on unix carries no DOS
  // flags -- and the positional reader called that "no mode" and let it past.
  // 7z then recreated the link. The refusal came only from the post-extraction
  // lstat, while this module's own words said it came from the index.
  it7z("refuses a ZIP symlink FROM THE INDEX, with nothing extracted", async () => {
    const zipPath = path.join(scratch, "evil.zip");
    await writeZip({
      zipPath,
      members: [
        { name: "manifest.json", content: JSON.stringify({ formatVersion: 1 }) },
        // A symlink's content IS its target. 0o120777 is S_IFLNK | 0777, and
        // yazl writes it into the external file attributes.
        { name: "files/evil", content: "/etc/passwd", mode: 0o120777 },
      ],
    });
    // The fixture's own premise: 7z must report this as a link.
    const stored = await readSevenZipIndex(zipPath, null);
    expect(
      stored.map((member) => member.attributes).join("|"),
      JSON.stringify(stored),
    ).toMatch(/\blrwxrwxrwx/);

    const file = await landFile(zipPath, "export.zip");
    const error = await rejection(stageArchive({ file, passphrase: null }));
    expect(error).toBeInstanceOf(IntakeShapeError);
    expect(error.message).toContain("symbolic link");
    // FROM THE INDEX: no staging directory was created at all, so 7z never got
    // the chance to write the link.
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  it7z("refuses a ZIP fifo, which the same hole swallowed", async () => {
    const zipPath = path.join(scratch, "fifo.zip");
    await writeZip({
      zipPath,
      members: [
        { name: "manifest.json", content: "{}" },
        { name: "files/pipe", content: "", mode: 0o010644 },
      ],
    });
    const file = await landFile(zipPath, "export.zip");
    const error = await rejection(stageArchive({ file, passphrase: null }));
    expect(error).toBeInstanceOf(IntakeShapeError);
    expect(error.message).toContain("named pipe");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // A DIRECTORY MEMBER IS FILTERED OUT OF THE KIND CHECK, so before the path
  // rule was moved ahead of that filter this reached `7z x` unlooked-at. No
  // escape was reproduced -- 7-Zip sanitises it -- and relying on that is
  // exactly the position this module refuses to take.
  it7z("refuses an escaping DIRECTORY member, which no rule used to look at", async () => {
    // BUILT WITH 7z RATHER THAN yazl, because yazl refuses the path outright
    // ("invalid relative path") -- a good library declining to write a bad
    // archive, and therefore useless as a fixture for one. `7z a -spf` writes
    // it without complaint.
    const zipPath = path.join(scratch, "escdir.7z");
    const cwd = path.join(await mkdtemp(path.join(scratch, "escdirpay-")), "a", "b");
    await mkdir(cwd, { recursive: true });
    await writeTraversalSevenZip({
      archivePath: zipPath,
      cwd,
      // An EMPTY escaping directory beside an ordinary file: the only thing in
      // the archive that any rule could object to is the directory's path.
      relativeMembers: ["../../escapedir/", "manifest.json"],
      passphrase: PASSPHRASE,
    });
    const stored = await readSevenZipIndex(zipPath, PASSPHRASE);
    expect(
      stored.map((member) => member.path),
      "the fixture must actually carry the escaping directory",
    ).toContain("../../escapedir");
    const file = await landFile(zipPath, "b.7z");
    const error = await rejection(stageArchive({ file, passphrase: PASSPHRASE }));
    expect(error).toBeInstanceOf(IntakeShapeError);
    expect(error.message).toContain("'..'");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // THE SECOND LAYER'S ABSOLUTE CEILING, reached the only way it can be: an
  // index whose claim is under the cap and a payload that lands over it. The
  // pre-extraction bound catches everything an honest index declares, so
  // without this the post-extraction ceiling was unreachable and untested.
  it7z("refuses a payload that unpacked past the absolute ceiling", async () => {
    const zipPath = path.join(scratch, "ceiling.zip");
    await writeZip({
      zipPath,
      members: [
        { name: "manifest.json", content: "{}" },
        { name: "companies.csv", content: "name\r\nAcme\r\n" },
      ],
    });
    const file = await landFile(zipPath, "export.zip");
    const error = await rejection(stageArchive({
      file,
      passphrase: null,
      // Above what the index claims (a few bytes), below what lands.
      limits: { maxStagedBytes: 4096 },
      onExtracted: async (destination) => {
        await writeFile(path.join(destination, "companies.csv"), randomBytes(64 * 1024));
      },
    }));
    expect(error).toBeInstanceOf(IntakeTooLargeError);
    expect(error.message).toContain("unpacked payload");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);

  // THE SIZE RULE'S SECOND LAYER. The symlink rule got two because an index is
  // "a claim about an archive and not the archive"; the size rule had one until
  // this. 7z could not be made to under-report -- the reviewer tried, and a lie
  // in the zip headers truncated extraction to the lie -- so the hook is what
  // creates the state, exactly as it does for "listed but did not arrive".
  it7z("refuses a payload that unpacked past what its index claimed", async () => {
    const zipPath = path.join(scratch, "grow.zip");
    await writeZip({
      zipPath,
      members: [
        { name: "manifest.json", content: "{}" },
        { name: "companies.csv", content: "name\r\nAcme\r\n" },
      ],
    });
    const file = await landFile(zipPath, "export.zip");
    const error = await rejection(stageArchive({
      file,
      passphrase: null,
      onExtracted: async (destination) => {
        await writeFile(path.join(destination, "companies.csv"), randomBytes(64 * 1024));
      },
    }));
    expect(error).toBeInstanceOf(IntakeArchiveError);
    expect(error.message).toContain("claimed");
    expect(await readdir(path.dirname(file.path))).toEqual(["upload"]);
    await file.dispose();
  }, 60_000);
});
