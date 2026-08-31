import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { resolveUser } from "../users.js";
import { saveBlob } from "./blobs.js";
import { attachFile } from "./files.js";
import { createCompany } from "./companies.js";
import { buildBackup, type BackupManifest } from "./backup.js";

// DOCUMENTATION THAT CANNOT DRIFT FROM THE FORMAT.
//
// docs/backup-format.md is the page an operator reads two years from now, on a
// different machine, with an archive and no Conduit. Every load-bearing claim
// it makes -- what the members are called, which tools open the file, what the
// encryption is, what the manifest holds -- is read out of the MARKDOWN here
// and checked against a REAL backup opened with 7z and the passphrase.
//
// Separate from backup.test.ts deliberately: that file proves the archive is
// correct, this one proves the page describing it is still true. They fail for
// different reasons and a reader should be able to tell which happened.
//
// The failure this prevents is specific and it has happened on this project
// before: a symbol grep cannot see a sentence, so a member renamed in the
// service leaves the doc's table quietly wrong and nothing notices until
// somebody needs it.

const execFileAsync = promisify(execFile);

const HAVE_7Z = await (async () => {
  try {
    await execFileAsync("7z", ["i"]);
    return true;
  } catch {
    return false;
  }
})();
const it7z = HAVE_7Z ? it : it.skip;

const DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs", "backup-format.md",
);
const doc = await readFile(DOC_PATH, "utf8");

const PASSPHRASE = "correct horse battery staple";

const handle = openTestDatabase();
let actorId: string;
let dataDir: string;
let scratch: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-doc-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-doc-out-"));
  await writeFile(path.join(dataDir, "mail.key"), Buffer.alloc(32, 3), { mode: 0o600 });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

/** A real backup, on disk, of an install that has an uploaded file in it. */
async function realBackup(): Promise<{ path: string; filename: string; manifest: BackupManifest }> {
  const company = await createCompany(handle.db, actorId, { name: "Acme" });
  const bytes = Buffer.from("%PDF-1.7\nan issued quote\n");
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([bytes]));
  await attachFile(handle.db, actorId, {
    originalName: "quote.pdf", mime: "application/pdf", sizeBytes, sha256, companyId: company.id,
  });

  const archive = await buildBackup({
    db: handle.db, dataDir, mailKeyPath: path.join(dataDir, "mail.key"),
    databaseUrl: TEST_DATABASE_URL, appVersion: "1.3.0-test", passphrase: PASSPHRASE,
  });
  const target = path.join(scratch, archive.filename);
  await pipeline(archive.stream, createWriteStream(target));
  return { path: target, filename: archive.filename, manifest: archive.manifest };
}

/**
 * The member names the page's "What is inside" table actually lists.
 *
 * PARSED, NOT SEARCHED, and that distinction was found by a mutation rather
 * than by reasoning. The first version asked `doc.toContain("`database.sql`")`,
 * which SURVIVED renaming the table's row to `db.sql` -- because the same
 * string also appears in the manifest sample and in a sentence two sections
 * later. A guard scoped to the construct it guards is the convention this
 * project keeps relearning; "somewhere on the page" is not that scope.
 */
function documentedMembers(): string[] {
  const section = doc.split("## What is inside")[1]?.split("###")[0] ?? "";
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match !== null) names.push(match[1] ?? "");
  }
  return names.sort();
}

/**
 * The top-level field names the page's manifest sample shows.
 *
 * Same reasoning as documentedMembers: read out of the fenced JSON block, so a
 * field that is described in prose but missing from the sample does not pass.
 */
function documentedManifestFields(): string[] {
  const block = doc.split("```json")[1]?.split("```")[0] ?? "";
  return Object.keys(JSON.parse(block) as Record<string, unknown>).sort();
}

/** Open it the way the page says to, and list what is inside. */
async function open7z(archivePath: string): Promise<{ root: string; members: string[] }> {
  const root = await mkdtemp(path.join(scratch, "extracted-"));
  await execFileAsync("7z", ["x", `-p${PASSPHRASE}`, "-y", `-o${root}`, "--", archivePath]);
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else found.push(rel);
    }
  };
  await walk(root, "");
  return { root, members: found.sort() };
}

describe("docs/backup-format.md", () => {
  // THE INSTRUMENT, SHOWN FAILING, before it is trusted to pass. If the file
  // were empty or unreadable every `toContain` below would be a vacuous green.
  it("was actually read", () => {
    expect(doc.length).toBeGreaterThan(2000);
    expect(doc).toContain("# The Conduit backup format");
    expect(doc).not.toContain("A STRING THAT IS NOT IN THE DOCUMENT");
  });

  // The spec names three tools and one caveat, and the caveat is the one that
  // decides whether a Mac user's double-click works or fails mysteriously.
  it("names the three tools, and says macOS needs one installed", () => {
    expect(doc).toContain("7-Zip");
    expect(doc).toContain("Keka");
    expect(doc).toContain("Ark");
    expect(doc).toContain("7z x");
    expect(doc).toContain("macOS's built-in Archive Utility will not open an encrypted archive");
  });

  it("says the passphrase cannot be recovered", () => {
    expect(doc).toContain("There is no recovery path for the passphrase.");
  });

  // TASK 3 DROVE ARCHIVE UTILITY, WHICH TASK 2 COULD NOT. Task 2 wrote the Mac
  // line from the command-line tools and said so; this asserts the page now
  // records what the GUI unarchiver actually did, and in the narrower form the
  // measurement supports -- it opened an unencrypted .7z from the same writer
  // and produced nothing for the encrypted one, so the claim is about
  // encryption rather than about the extension.
  it("says what Archive Utility was measured doing, not more", () => {
    expect(doc).toContain("it extracted an unencrypted `.7z`");
    expect(doc).toContain("produced\n  **nothing at all**");
    expect(doc).toContain('not "macOS cannot open a `.7z`"');
  });

  // The rule the Settings page enforces at the keyboard and this service
  // enforces at the boundary. On the page BECAUSE it is unrecoverable: an
  // archive encrypted with a truncated passphrase is lost the moment it is
  // written, and nothing would have said so.
  it("says a passphrase may not contain a line break, and why", () => {
    expect(doc).toContain("cannot contain a line break");
    expect(doc).toContain("encrypts with `abc` and reports success");
  });

  // The spec's own words: the Settings page and the docs must not imply this
  // replaces YunoHost's own backup.
  it("says this does not replace yunohost backup", () => {
    expect(doc).toContain("This does not replace `yunohost backup`.");
  });

  it7z("lists exactly the members a real backup contains", async () => {
    const backup = await realBackup();
    const { members } = await open7z(backup.path);

    // BOTH DIRECTIONS, off the page's own table: a member in the archive that
    // the page does not list, and a member the page lists that the archive
    // does not have, are the same failure. `files/` appears as a directory
    // because its members are content digests rather than names.
    const inArchive = [...new Set(
      members.map((m) => (m.startsWith("files/") ? "files/" : m)),
    )].sort();
    expect(documentedMembers()).toEqual(inArchive);
  }, 120_000);

  it7z("describes the encryption the archive actually reports", async () => {
    const backup = await realBackup();
    const { stdout } = await execFileAsync(
      "7z", ["l", "-slt", `-p${PASSPHRASE}`, "--", backup.path],
    );
    // The page claims 7zAES:19, i.e. AES-256 with 2^19 = 524,288 iterations.
    // This is the claim the whole format choice rests on, so it is read off the
    // archive rather than off the code that wrote it.
    expect(doc).toContain("`7zAES:19`");
    expect(stdout).toContain("7zAES:19");
    expect(doc).toContain("2^19 = 524,288");
    expect(doc).toContain("AES-256");

    // -mhe=on: without the passphrase the archive cannot even be listed.
    expect(doc).toContain("Encrypted headers");
    await expect(execFileAsync("7z", ["l", "-pwrong", "--", backup.path])).rejects.toThrow();

    // -mx=1, and the page states the measurement that chose it.
    expect(doc).toContain("`-mx=1`");
    expect(doc).toContain("19MB against 394MB");
  }, 120_000);

  it7z("describes the manifest the archive actually carries", async () => {
    const backup = await realBackup();
    const { root } = await open7z(backup.path);
    const manifest = JSON.parse(
      await readFile(path.join(root, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    // Every top-level field of the real manifest is in the page's sample, and
    // every field of the sample is in the real manifest -- read out of the
    // fenced JSON rather than grepped for, so a field added to the manifest
    // without a line there fails this test instead of going undocumented.
    expect(documentedManifestFields()).toEqual(Object.keys(manifest).sort());
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.kind).toBe("backup");
    expect(backup.manifest.encryption.keyDerivation).toBe("SHA-256, 2^19 (524288) iterations");
    expect(doc).toContain("SHA-256, 2^19 (524288) iterations");
    expect(doc).toContain('"--no-owner", "--no-privileges", "--format=plain"');
    expect(backup.manifest.postgres.pgDumpArgs)
      .toEqual(["--no-owner", "--no-privileges", "--format=plain"]);
  }, 120_000);

  it7z("names the file the way the page says it is named", async () => {
    const backup = await realBackup();
    expect(doc).toContain("`conduit-backup-YYYY-MM-DD.7z`");
    expect(backup.filename).toMatch(/^conduit-backup-\d{4}-\d{2}-\d{2}\.7z$/);
  }, 120_000);

  it7z("is right that 7z t verifies a backup", async () => {
    const backup = await realBackup();
    expect(doc).toContain("7z t conduit-backup-");
    await expect(execFileAsync("7z", ["t", `-p${PASSPHRASE}`, "--", backup.path]))
      .resolves.toBeDefined();
  }, 120_000);
});
