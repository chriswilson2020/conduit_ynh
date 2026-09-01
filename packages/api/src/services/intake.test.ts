import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  archiveMemberProblem, parseArchiveIndex, receiveIntake, safeFilename,
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

  // A zip written by an ordinary tool carries no unix mode at all, so the rule
  // has to accept an empty one rather than treating "unknown" as "hostile".
  it("accepts a zip member, which carries no unix mode", () => {
    expect(archiveMemberProblem(entry({ attributes: " -rw-r--r--" }))).toBeNull();
    expect(archiveMemberProblem(entry({ attributes: "" }))).toBeNull();
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

  it("refuses a device, a socket and a fifo", () => {
    for (const mode of ["crw-rw-rw-", "srwxrwxrwx", "prw-r--r--"]) {
      expect(archiveMemberProblem(entry({ attributes: `A ${mode}` })), mode)
        .toContain("not a plain file");
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
  const archivePath = path.join(scratch, "backup.7z");
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
    const { archivePath } = await backupArchive();

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
      const control = spawn(
        "7z", ["l", "-bd", "-y", `-p${PASSPHRASE}`, "--", archivePath],
        { stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100 && !foundInControl; attempt += 1) {
        try {
          const cmdline = await readFile(`/proc/${String(control.pid)}/cmdline`, "utf8");
          if (cmdline.split("\u0000").join(" ").includes(PASSPHRASE)) foundInControl = true;
        } catch { /* the child exited */ }
        if (!foundInControl) await new Promise((r) => setTimeout(r, 5));
      }
      control.kill();
    }
    expect(foundInControl, "the control must find a passphrase that IS in argv").toBe(true);

    // The real path. Every 7z this process spawns, scanned while it runs.
    const file = await landFile(archivePath, "b.7z");
    let leaked: string | null = null;
    const watcher = setInterval(() => {
      void (async () => {
        for (const pid of await readdir("/proc").catch(() => [])) {
          if (!/^\d+$/.test(pid)) continue;
          const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
          if (cmdline.includes(PASSPHRASE)) leaked = cmdline.split("\u0000").join(" ");
        }
      })();
    }, 3);
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
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
      relativeMember: "../../escaped.txt",
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
    await expect(stageArchive({
      file, passphrase: PASSPHRASE, limits: { maxStagedBytes: 1024 * 1024 },
    })).rejects.toBeInstanceOf(IntakeTooLargeError);
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
});
