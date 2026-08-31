import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod, mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, writeFile,
} from "node:fs/promises";
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
import { mailAccounts, mailAttachments, mailMessages, mailThreads } from "../db/schema.js";
import {
  buildBackup, freeSpaceBytes, majorVersion, pgDumpInvocation, requiredFreeBytes,
  sevenZipArgs, sweepAbandonedBackups, validatePassphrase,
  BACKUP_FORMAT_VERSION, MAX_PASSPHRASE_LENGTH, PG_DUMP_PACKAGE, SEVEN_ZIP_PACKAGE,
  BackupDiskSpaceError, BackupFailedError, BackupKeyMissingError,
  BackupPassphraseError, BackupToolMissingError,
  type BackupManifest,
} from "./backup.js";

const execFileAsync = promisify(execFile);

// EXTRACTION IS DONE BY 7z ITSELF, FROM OUTSIDE THIS PROCESS, and that is the
// whole point of this suite rather than an implementation convenience. The
// spec's requirement is that a backup be openable WITHOUT Conduit -- by
// double-clicking it and typing the passphrase into 7-Zip, Keka or Ark. A
// reader written here would share every assumption the writer makes, so an
// archive both agreed was well-formed could still be one no ordinary tool
// opens. Driving the same binary those three tools embed is the closest a
// test can get to the operator's Saturday morning.
//
// Probed rather than assumed, on documents-render.test.ts's precedent: 7z is
// an apt dependency of the app (manifest.toml's resources.apt) and it is on
// the dev server and in CI, but a developer on macOS has no /usr/bin/7z and
// should get a visible skip rather than a red suite.
const HAVE_7Z = await (async () => {
  try {
    await execFileAsync("7z", ["i"]);
    return true;
  } catch {
    return false;
  }
})();
const it7z = HAVE_7Z ? it : it.skip;

// /proc is the only way for a process to count its own open descriptors or to
// read another process's resident set, and it is Linux-only. The dev server
// and the CI runner both have it, which is where these bounds have to hold; a
// developer on macOS gets a visible skip rather than a silent pass.
const HAVE_PROC = await readdir("/proc/self/fd").then(() => true, () => false);
const it7zProc = HAVE_7Z && HAVE_PROC ? it : it.skip;

// psql, createdb and dropdb, for the one test that puts the dump back. They
// ship with pg_dump, so a machine that can take a backup can almost always
// check one -- but "almost always" is what a probe is for, and the role also
// has to be allowed to create a database.
const HAVE_PSQL = await (async () => {
  try {
    await execFileAsync("psql", ["--version"]);
    await execFileAsync("createdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
const it7zPsql = HAVE_7Z && HAVE_PSQL ? it : it.skip;

/**
 * Force a garbage collection, or fail loudly. Same reasoning as
 * export.test.ts's: `global.gc?.()` with nothing enabling it is a line that
 * implies a guarantee it never gives. vitest.config.ts passes --expose-gc.
 */
function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    throw new Error("these bounds need --expose-gc; see vitest.config.ts");
  }
  gc();
}

const handle = openTestDatabase();
let actorId: string;
let dataDir: string;
let scratch: string;

/** The fixture passphrase. Never a secret here -- see the note on sevenZipArgs. */
const PASSPHRASE = "correct horse battery staple";

// Recognisable rather than random, so a scan can look FOR them. The export's
// suite proves each of these is absent; this one proves the same four are
// present, from the same install shape. That symmetry is the point: the two
// archives are mirror images and their safety tests have to be too.
const MAIL_KEY_BYTES = "MAIL-KEY-BYTES-THAT-MUST-TRAVEL";  // 31 chars + 1 below = 32
const CREDENTIAL_CIPHERTEXT = "SUPER-SECRET-CIPHERTEXT";
const MAIL_BODY = "THE MAIL BODY THAT MUST TRAVEL";
const MAIL_ATTACHMENT = "THE MAIL ATTACHMENT THAT MUST TRAVEL";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-out-"));
  await writeMailKey();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

/** A 32-byte mail.key whose bytes a scan can recognise. */
async function writeMailKey(): Promise<void> {
  await writeFile(path.join(dataDir, "mail.key"), Buffer.from(`${MAIL_KEY_BYTES}!`), { mode: 0o600 });
}

interface RunOptions {
  passphrase?: string;
  now?: Date;
  freeBytes?: (dir: string) => Promise<number>;
}

async function run(options: RunOptions = {}) {
  return await buildBackup({
    db: handle.db,
    dataDir,
    mailKeyPath: path.join(dataDir, "mail.key"),
    databaseUrl: TEST_DATABASE_URL,
    appVersion: "1.3.0-test",
    passphrase: options.passphrase ?? PASSPHRASE,
    now: options.now,
    freeBytes: options.freeBytes,
  });
}

/** Build a backup and write it to `scratch`, returning its path and manifest. */
async function writeArchive(options: RunOptions = {}): Promise<{ path: string; manifest: BackupManifest }> {
  const archive = await run(options);
  const target = path.join(scratch, archive.filename);
  await pipeline(archive.stream, createWriteStream(target));
  return { path: target, manifest: archive.manifest };
}

/**
 * Extract an archive with 7z and the passphrase, returning the root.
 *
 * -p ON THE COMMAND LINE HERE, AND ONLY HERE. The service never does it -- see
 * sevenZipArgs -- because /proc/<pid>/cmdline is world-readable and a real
 * passphrase must not be in it. This is a fixture on a test machine, and the
 * read side leaves no choice: `7z x -p` reading from a pipe does NOT work on
 * p7zip 16.02 (measured: it answers "Cannot open encrypted archive. Wrong
 * password?"), where the write side does. Conduit only ever writes.
 */
async function extract(archivePath: string, passphrase = PASSPHRASE): Promise<string> {
  const out = await mkdtemp(path.join(scratch, "extracted-"));
  await execFileAsync("7z", ["x", `-p${passphrase}`, "-y", `-o${out}`, "--", archivePath]);
  return out;
}

/** Every member path in the extraction, relative to its root, sorted. */
async function memberPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else found.push(rel);
    }
  };
  await walk(root, "");
  return found.sort();
}

/**
 * Which EXTRACTED members contain `needle`.
 *
 * EXTRACTED, NEVER THE ARCHIVE'S OWN BYTES. Task 1 paid for this lesson on the
 * export, where a raw-byte scan was a dead assertion against every deflated
 * member. Here it would be worse than dead: the archive is encrypted, so a raw
 * scan finds nothing at all and every "is it present?" question would answer
 * no while the file plainly held it.
 */
async function membersContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const member of await memberPaths(root)) {
    const bytes = await readFile(path.join(root, member));
    if (bytes.includes(needle)) hits.push(member);
  }
  return hits;
}

/** The work directories currently sitting in $data_dir. */
async function workDirs(): Promise<string[]> {
  return (await readdir(dataDir)).filter((entry) => entry.startsWith(".backup-work-")).sort();
}

/**
 * Wait for the removal that `close` triggers, then assert nothing is left.
 *
 * A POLL RATHER THAN A SLEEP, AND A POLL RATHER THAN AN AWAITED dispose(). The
 * disposal this suite cares about is the one nothing calls -- it hangs off the
 * stream's `close` event, so a client that vanishes mid-download still takes
 * the credential store with it. Awaiting dispose() from the test would prove
 * the explicit path and leave the automatic one untested; a fixed sleep would
 * be a flake waiting for a slower machine. If the removal never happens this
 * fails after five seconds, which is what makes it an instrument.
 */
async function expectNoWorkDirs(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await workDirs()).length > 0) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  expect(await workDirs()).toEqual([]);
}

/** Seed a mail account, message and attachment -- every secret the backup must carry. */
async function seedMail(): Promise<{ attachmentSha256: string }> {
  const [account] = await handle.db.insert(mailAccounts).values({
    userId: actorId, label: "Work", email: "chris@listerdale.example",
    imapHost: "imap.example", imapPort: 993, imapSecurity: "tls",
    smtpHost: "smtp.example", smtpPort: 465, smtpSecurity: "tls",
    username: "chris", credentialsCiphertext: CREDENTIAL_CIPHERTEXT,
  }).returning();
  const [thread] = await handle.db.insert(mailThreads).values({
    subject: "Re: the quote", lastMessageAt: new Date(),
  }).returning();
  const [message] = await handle.db.insert(mailMessages).values({
    threadId: thread?.id ?? "", accountId: account?.id ?? "", messageId: `<${randomUUID()}@example>`,
    fromAddr: "them@example", toAddrs: [{ address: "chris@listerdale.example" }],
    subject: "Re: the quote", sentAt: new Date(), folder: "INBOX", direction: "inbound",
    bodyText: MAIL_BODY, bodyHtml: `<p>${MAIL_BODY}</p>`,
  }).returning();

  const attachmentBytes = Buffer.from(MAIL_ATTACHMENT);
  const { sha256 } = await saveBlob(dataDir, Readable.from([attachmentBytes]));
  await handle.db.insert(mailAttachments).values({
    messageId: message?.id ?? "", filename: "their-terms.pdf", mime: "application/pdf",
    sizeBytes: attachmentBytes.byteLength, blobPath: sha256,
  });
  return { attachmentSha256: sha256 };
}

/** An ordinary uploaded file, so the blob store holds more than mail. */
async function seedUpload(name = "ours.pdf", body = "AN ORDINARY UPLOAD"): Promise<string> {
  const company = await createCompany(handle.db, actorId, { name: "Acme" });
  const bytes = Buffer.from(body);
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([bytes]));
  await attachFile(handle.db, actorId, {
    originalName: name, mime: "application/pdf", sizeBytes, sha256, companyId: company.id,
  });
  return sha256;
}

// ---------------------------------------------------------------------------

describe("backup archive", () => {
  it7z("opens with 7z and the passphrase, and holds what the manifest says", async () => {
    await seedMail();
    const uploadSha = await seedUpload();
    const { path: archivePath, manifest } = await writeArchive();

    const root = await extract(archivePath);
    const members = await memberPaths(root);
    expect(members).toEqual([
      ...manifest.members.map((m) => m.path).sort(),
      "manifest.json",
    ].sort());
    expect(members).toContain("database.sql");
    expect(members).toContain("mail.key");
    expect(members).toContain(`files/${uploadSha}`);

    // The manifest inside the archive is the one the caller was handed.
    const inside = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as BackupManifest;
    expect(inside).toEqual(manifest);
  }, 120_000);

  it7z("records a digest per member that the extracted bytes match", async () => {
    await seedMail();
    await seedUpload();
    const { path: archivePath, manifest } = await writeArchive();
    const root = await extract(archivePath);

    for (const member of manifest.members) {
      const bytes = await readFile(path.join(root, member.path));
      expect(bytes.byteLength, `${member.path} size`).toBe(member.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), `${member.path} digest`)
        .toBe(member.sha256);
    }
    // Not vacuous: there is more than the two fixed members in there.
    expect(manifest.members.length).toBeGreaterThan(2);
  }, 120_000);

  it7z("passes 7z's own integrity test", async () => {
    await seedUpload();
    const { path: archivePath } = await writeArchive();
    await expect(execFileAsync("7z", ["t", `-p${PASSPHRASE}`, "--", archivePath])).resolves.toBeDefined();
  }, 120_000);

  it7z("refuses the wrong passphrase", async () => {
    await seedUpload();
    const { path: archivePath } = await writeArchive();
    await expect(execFileAsync("7z", ["t", "-pnot-the-passphrase", "--", archivePath]))
      .rejects.toThrow();
  }, 120_000);

  // THE 500x THE FORMAT WAS CHOSEN FOR, READ OFF THE ARTEFACT. "7zAES:19" is
  // 7z's own name for AES-256 with 2^19 = 524,288 SHA-256 iterations, which is
  // the number the spec compares against ZIP AES's 1,000. Asserting it here
  // means the claim in docs/backup-format.md and in the module comment is
  // checked against what was actually written, not against what was intended.
  it7z("stretches the passphrase 2^19 times, as 7zAES:19", async () => {
    await seedUpload();
    const { path: archivePath } = await writeArchive();
    const { stdout } = await execFileAsync(
      "7z", ["l", "-slt", `-p${PASSPHRASE}`, "--", archivePath],
    );
    expect(stdout).toContain("7zAES:19");
  }, 120_000);

  // -mhe=on. Without it the member names sit in the clear and a stolen archive
  // announces that this install has a mail.key and how many blobs it holds.
  it7z("encrypts the headers, so listing without the passphrase fails", async () => {
    await seedUpload();
    const { path: archivePath } = await writeArchive();
    // A deliberately wrong passphrase rather than none: with -mhe=on 7z cannot
    // even read the header block, which is exactly the property under test.
    await expect(execFileAsync("7z", ["l", "-pwrong", "--", archivePath])).rejects.toThrow();
    // And the names are not sitting in the file's bytes either.
    const raw = await readFile(archivePath);
    expect(raw.includes("mail.key")).toBe(false);
    expect(raw.includes("database.sql")).toBe(false);
  }, 120_000);

  // A SKIP IS ONLY ACCEPTABLE ON A MACHINE THAT NEVER HAD TO PROVE THIS. CI
  // installs p7zip-full (see .github/workflows/test.yml, which also smoke-tests
  // that a piped passphrase and 7zAES:19 behave the way this suite needs), so
  // an unexpected absence there must be loud rather than fifty quiet skips --
  // export.test.ts's precedent for unzip.
  it.runIf(Boolean(process.env.CI))("has 7z available here, because CI must prove the archive opens", () => {
    expect(HAVE_7Z).toBe(true);
  });

  it7z("names the file for the day it was taken", async () => {
    const archive = await run({ now: new Date("2026-08-31T09:15:00Z") });
    expect(archive.filename).toBe("conduit-backup-2026-08-31.7z");
    await archive.dispose();
  }, 120_000);

  it7z("records the app version, the schema version and the journal position", async () => {
    const { manifest } = await writeArchive();
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.kind).toBe("backup");
    expect(manifest.appVersion).toBe("1.3.0-test");
    // The journal's own last entry, read from the folder runMigrations applies.
    const journal = JSON.parse(
      await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(manifest.schemaVersion).toBe(journal.entries[journal.entries.length - 1]?.tag);
    expect(manifest.migrationPosition).toBe(journal.entries.length);
    expect(manifest.postgres.serverVersion).toMatch(/^\d+/);
    expect(manifest.postgres.pgDumpVersion).toContain("pg_dump");
    expect(manifest.postgres.pgDumpArgs).toEqual(["--no-owner", "--no-privileges", "--format=plain"]);
    expect(manifest.encryption).toEqual({
      container: "7z", cipher: "AES-256", headerEncryption: true,
      keyDerivation: "SHA-256, 2^19 (524288) iterations",
    });
  }, 120_000);
});

// THE INVERTED SAFETY TEST. export.test.ts proves these four are ABSENT from
// the readable half; this proves the same four are PRESENT in the exact half,
// from the same install shape. A backup that quietly omitted mail.key would
// restore into an install that cannot send mail, and nobody would find out
// until the day they needed it.
describe("backup completeness", () => {
  // THE INSTRUMENT, SHOWN FAILING, before anything is asserted present. A scan
  // that reports every string as found proves nothing about the strings that
  // are. This one runs against a real archive and looks for something that is
  // definitely not in it.
  it7z("does not find a string that is not there", async () => {
    await seedMail();
    const root = await extract((await writeArchive()).path);
    expect(await membersContaining(root, "THIS STRING IS IN NOTHING")).toEqual([]);
  }, 120_000);

  it7z("carries mail.key, byte for byte", async () => {
    const root = await extract((await writeArchive()).path);
    expect(await membersContaining(root, MAIL_KEY_BYTES)).toEqual(["mail.key"]);
    const extracted = await readFile(path.join(root, "mail.key"));
    expect(extracted).toEqual(Buffer.from(`${MAIL_KEY_BYTES}!`));
    expect(extracted.byteLength).toBe(32);
  }, 120_000);

  it7z("carries the encrypted mail passwords", async () => {
    await seedMail();
    const root = await extract((await writeArchive()).path);
    expect(await membersContaining(root, CREDENTIAL_CIPHERTEXT)).toEqual(["database.sql"]);
  }, 120_000);

  it7z("carries the mail bodies and the mail attachments", async () => {
    const { attachmentSha256 } = await seedMail();
    const root = await extract((await writeArchive()).path);
    expect(await membersContaining(root, MAIL_BODY)).toEqual(["database.sql"]);
    // The blob store is taken WHOLE -- the exact inversion of the export,
    // which reads the `files` table precisely to leave attachments out.
    expect(await readFile(path.join(root, "files", attachmentSha256), "utf8"))
      .toBe(MAIL_ATTACHMENT);
  }, 120_000);

  it7z("carries drizzle's migration bookkeeping, so a restore does not re-run them", async () => {
    const root = await extract((await writeArchive()).path);
    const dump = await readFile(path.join(root, "database.sql"), "utf8");
    expect(dump).toContain("drizzle");
    expect(dump).toContain("__drizzle_migrations");
  }, 120_000);

  it7z("carries the CRM rows themselves", async () => {
    await createCompany(handle.db, actorId, { name: "A Findable Company Name" });
    const root = await extract((await writeArchive()).path);
    expect(await membersContaining(root, "A Findable Company Name")).toEqual(["database.sql"]);
  }, 120_000);

  // THE ONLY EVIDENCE THE ARTEFACT IS WORTH ANYTHING.
  //
  // Everything else in this suite checks that the archive contains what it
  // says it contains. This one puts the dump BACK -- into a scratch database
  // created for the purpose and dropped afterwards -- and reads the rows out
  // of the restored copy. The spec puts this in the phase even though restore
  // does not land until 7.7, for the reason it gives: a backup that is subtly
  // wrong would otherwise not be discovered until the day something depends
  // on it.
  //
  // ON_ERROR_STOP=1, because psql's default is to log a failed statement and
  // carry on -- which would let a dump that half-restores pass as one that
  // restored. Three things are checked in the copy and they are deliberately
  // different in kind: an ordinary row, an encrypted mail credential (the
  // secret this half exists to carry), and drizzle's own migration
  // bookkeeping, without which a restored install would re-run every
  // migration over its own restored data.
  it7zPsql("restores its pg_dump into a scratch database", async () => {
    await createCompany(handle.db, actorId, { name: "Restored Ltd" });
    await seedMail();
    const root = await extract((await writeArchive()).path);

    const scratchDb = `conduit_restore_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const { env } = pgDumpInvocation(TEST_DATABASE_URL);
    const psqlEnv = { ...process.env, ...env };
    const query = async (statement: string): Promise<string> => (
      await execFileAsync("psql", ["-tAc", statement, "-d", scratchDb], { env: psqlEnv })
    ).stdout.trim();

    await execFileAsync("createdb", [scratchDb], { env: psqlEnv });
    try {
      await execFileAsync("psql", [
        "-v", "ON_ERROR_STOP=1", "-q", "-d", scratchDb,
        "-f", path.join(root, "database.sql"),
      ], { env: psqlEnv });

      expect(await query("SELECT name FROM companies ORDER BY name")).toContain("Restored Ltd");
      expect(await query("SELECT credentials_ciphertext FROM mail_accounts"))
        .toBe(CREDENTIAL_CIPHERTEXT);
      expect(await query("SELECT body_text FROM mail_messages")).toBe(MAIL_BODY);
      expect(Number(await query('SELECT count(*) FROM drizzle."__drizzle_migrations"')))
        .toBeGreaterThan(0);
    } finally {
      await execFileAsync("dropdb", ["--if-exists", scratchDb], { env: psqlEnv });
    }
  }, 180_000);

  // REFUSES RATHER THAN OMITS. The failure an operator must never be allowed
  // to have is the silent one: a backup taken today, trusted for a year, and
  // only found to be keyless after a disk failure.
  it7z("refuses to produce a backup at all when mail.key is missing", async () => {
    await rm(path.join(dataDir, "mail.key"));
    await expect(run()).rejects.toThrow(BackupKeyMissingError);
    expect(await workDirs()).toEqual([]);
  }, 120_000);
});

describe("backup temp-file discipline", () => {
  // THE TEMP FILE IS A CREDENTIAL STORE. It holds mail.key and every encrypted
  // mail password, and it lives in $data_dir on a machine other apps share.
  it7z("builds inside $data_dir, never /tmp, with 0700 on the directory and 0600 on the archive", async () => {
    await seedUpload();
    const archive = await run();
    try {
      const dirs = await workDirs();
      expect(dirs).toHaveLength(1);
      const work = path.join(dataDir, dirs[0] ?? "");
      // Inside $data_dir by construction, which the systemd unit also
      // enforces: ProtectSystem=full with ReadWritePaths=__DATA_DIR__.
      expect(work.startsWith(dataDir)).toBe(true);
      expect((await stat(work)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(work, "backup.7z"))).mode & 0o777).toBe(0o600);
    } finally {
      await archive.dispose();
    }
  }, 120_000);

  // THE INTERMEDIATE FILES MATTER AS MUCH AS THE ARCHIVE: database.sql is the
  // whole database in plain text -- every mail body, every encrypted password --
  // and manifest.json names every blob the install holds. Both survive until
  // dispose, so this is a deterministic read rather than a sampled one.
  it7z("gives the dump and the manifest 0600 too", async () => {
    await seedUpload();
    const archive = await run();
    try {
      const work = path.join(dataDir, (await workDirs())[0] ?? "");
      expect((await readdir(work)).sort()).toEqual(["backup.7z", "database.sql", "manifest.json"]);
      expect((await stat(path.join(work, "database.sql"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(work, "manifest.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await archive.dispose();
    }
  }, 120_000);

  it7z("removes the work directory when the download finishes", async () => {
    await seedUpload();
    await writeArchive();
    await expectNoWorkDirs();
  }, 120_000);

  // A HALF-WRITTEN BACKUP SURVIVING A FAILURE IS THE FAILURE MODE TO DESIGN
  // AGAINST. An unreadable blob makes 7z exit non-zero part-way through, which
  // is as close to a crash mid-archive as a test can arrange deliberately.
  it7z("removes the work directory when the build fails", async () => {
    const sha = await seedUpload();
    // Mode 000 rather than a delete: the pre-flight stat still succeeds (stat
    // needs no read permission) so the failure lands where it is wanted, in
    // 7z rather than in the walk.
    await chmod(path.join(dataDir, "files", sha), 0o000);
    await expect(run()).rejects.toThrow(BackupFailedError);
    expect(await workDirs()).toEqual([]);
  }, 120_000);

  // THE SAME CLASS OF BUG THE EXPORT SHIPPED AND HAD TO FIX: a client that
  // cancels a large download must not leave anything behind -- not a
  // descriptor, and here not a credential store either.
  it7zProc("removes the work directory and closes the descriptor when the download is abandoned", async () => {
    // Big enough, and INCOMPRESSIBLE, so the finished archive is still megabytes
    // and the read is genuinely in flight when the reader goes away. 4MB of "x"
    // compresses to nothing and the stream would be over before the first
    // sample.
    await seedUpload("big.bin", randomBytes(8 * 1024 * 1024).toString("base64"));
    const archive = await run();
    const dirs = await workDirs();
    expect(dirs).toHaveLength(1);
    const archivePath = path.join(dataDir, dirs[0] ?? "", "backup.7z");

    // One chunk, then the client goes away.
    await new Promise<void>((resolve) => { archive.stream.once("data", () => { resolve(); }); });
    expect(await openDescriptorsFor(archivePath)).toBeGreaterThan(0);
    archive.stream.destroy();

    await new Promise<void>((resolve) => { archive.stream.once("close", () => { resolve(); }); });
    await expectNoWorkDirs();
    expect(await openDescriptorsFor(archivePath)).toBe(0);
  }, 120_000);

  it("sweeps a work directory left behind by a crash", async () => {
    const orphan = path.join(dataDir, ".backup-work-abc123");
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(path.join(orphan, "backup.7z"), "half an archive", { mode: 0o600 });
    // Something that is NOT a work directory, to prove the sweep is scoped.
    await mkdir(path.join(dataDir, "files"), { recursive: true });
    await writeFile(path.join(dataDir, "keep-me"), "not ours");

    expect(await sweepAbandonedBackups(dataDir)).toEqual([".backup-work-abc123"]);
    expect(await workDirs()).toEqual([]);
    expect(await readdir(dataDir)).toEqual(expect.arrayContaining(["files", "keep-me", "mail.key"]));
  });

  it7z("sweeps an orphan before it builds", async () => {
    await mkdir(path.join(dataDir, ".backup-work-stale"), { mode: 0o700 });
    await writeArchive();
    await expectNoWorkDirs();
  }, 120_000);

  it("never throws when $data_dir cannot be read", async () => {
    await expect(sweepAbandonedBackups(path.join(dataDir, "does-not-exist"))).resolves.toEqual([]);
  });
});

describe("backup disk pre-flight", () => {
  it("adds two copies of the database to one of the blobs, plus a margin", () => {
    // The dump on disk, the dump again inside the archive, the blobs inside
    // the archive at full size (they do not compress), and 64MB of slack.
    expect(requiredFreeBytes({ databaseBytes: 1_000, blobBytes: 2_000 }))
      .toBe(2_000 + 2_000 + 64 * 1024 * 1024);
  });

  // MADE TO FAIL, on a machine with 28GB free. Injecting the probe is the only
  // way to exercise this without filling a real disk, and the arithmetic it
  // guards is tested above.
  it("refuses, with both numbers, when the disk cannot hold the archive", async () => {
    await seedUpload();
    const error = await run({ freeBytes: async () => Promise.resolve(1) })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(BackupDiskSpaceError);
    expect((error as BackupDiskSpaceError).availableBytes).toBe(1);
    expect((error as BackupDiskSpaceError).requiredBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect((error as Error).message).toMatch(/free space/);
    // Nothing was written, which is the point of a pre-flight.
    expect(await workDirs()).toEqual([]);
  }, 120_000);

  // THE DEFAULT PROBE, AGAINST A SECOND OPINION. Without this, replacing
  // statfs with `() => Infinity` would break no test -- every other case here
  // either injects the probe or has plenty of room.
  it.runIf(HAVE_PROC)("reports what df reports", async () => {
    const mine = await freeSpaceBytes(dataDir);
    const { stdout } = await execFileAsync("df", ["-k", "--output=avail", dataDir]);
    const df = Number(stdout.trim().split("\n")[1]) * 1024;
    expect(mine).toBeGreaterThan(0);
    // Within 1%: a busy filesystem moves between the two calls.
    expect(Math.abs(mine - df) / df).toBeLessThan(0.01);
  });
});

describe("backup passphrase handling", () => {
  it("requires one", () => {
    expect(() => { validatePassphrase(""); }).toThrow(BackupPassphraseError);
    expect(() => { validatePassphrase(""); }).toThrow(/never written unencrypted/);
  });

  it("accepts spaces, punctuation and non-ASCII", () => {
    expect(() => { validatePassphrase("  leading and trailing  "); }).not.toThrow();
    expect(() => { validatePassphrase("p\u00E4ss w\u00F6rd'\"$x"); }).not.toThrow();
    expect(() => { validatePassphrase("a".repeat(MAX_PASSPHRASE_LENGTH)); }).not.toThrow();
  });

  it("refuses control characters and an over-long passphrase", () => {
    for (const bad of ["one\ntwo", "one\rtwo", "one\ttwo", "one two", "onetwo"]) {
      expect(() => { validatePassphrase(bad); }, JSON.stringify(bad)).toThrow(BackupPassphraseError);
    }
    expect(() => { validatePassphrase("a".repeat(MAX_PASSPHRASE_LENGTH + 1)); })
      .toThrow(BackupPassphraseError);
  });

  // THROUGH buildBackup, not only through the exported check. Nothing else in
  // this suite would notice if the call disappeared from the build path: the
  // route's own schema catches an empty passphrase and an over-long one, but
  // the control-character rule -- the one that stops 7z silently encrypting
  // with a prefix of what was typed -- lives only here.
  it("refuses a passphrase with a line break before it writes anything", async () => {
    await expect(run({ passphrase: "one\ntwo" })).rejects.toThrow(BackupPassphraseError);
    expect(await workDirs()).toEqual([]);
  }, 120_000);

  // WHY THAT RULE EXISTS, PROVED AGAINST THE REAL BINARY RATHER THAN ASSERTED.
  // 7z reads the passphrase as ONE LINE from stdin, so "abc\ndef" encrypts
  // with "abc" and reports success -- an archive whose passphrase is a prefix
  // of what the operator typed, which with no recovery path is an archive
  // nobody opens again. If this ever stops being true, the rule above can be
  // relaxed; while it is true, the rule is the only thing standing between an
  // operator and a silently unopenable backup.
  it7z("7z really does truncate a passphrase at the first line break", async () => {
    const dir = await mkdtemp(path.join(scratch, "truncation-"));
    await writeFile(path.join(dir, "a.txt"), "hello");
    const archivePath = path.join(dir, "out.7z");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("7z", sevenZipArgs(archivePath, [path.join(dir, "a.txt")]), {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`7z exited ${String(code)}`));
      });
      child.stdin.end("abc\ndef", "utf8");
    });
    // The prefix opens it; what was typed does not.
    await expect(execFileAsync("7z", ["t", "-pabc", "--", archivePath])).resolves.toBeDefined();
    await expect(execFileAsync("7z", ["t", "-pabc\ndef", "--", archivePath])).rejects.toThrow();
  }, 120_000);
});

describe("backup secrecy of arguments", () => {
  /** Every command line currently visible in /proc, as one string. */
  async function processArguments(): Promise<string> {
    const parts: string[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        parts.push((await readFile(`/proc/${entry}/cmdline`)).toString("utf8"));
      } catch { /* the process exited while we looked */ }
    }
    return parts.join(" ");
  }

  it("keeps the passphrase out of the argument list it builds", () => {
    const args = sevenZipArgs("/data/.backup-work-x/backup.7z", ["/data/mail.key"]);
    expect(args).toContain("-p");
    expect(args.join(" ")).not.toContain(PASSPHRASE);
    // The bare "-p" is what makes 7z read stdin. A "-p<value>" would be the bug.
    expect(args.filter((a) => a.startsWith("-p"))).toEqual(["-p"]);
    expect(args).toContain("-mhe=on");
    expect(args).toContain("-mx=1");
  });

  it("keeps the database password out of pg_dump's argument list", () => {
    const { args, env } = pgDumpInvocation("postgres://conduit:hunter2@127.0.0.1:5432/conduit_prod");
    expect(args.join(" ")).not.toContain("hunter2");
    expect(args.join(" ")).not.toContain("conduit_prod");
    expect(env).toEqual({
      PGHOST: "127.0.0.1", PGPORT: "5432", PGUSER: "conduit",
      PGPASSWORD: "hunter2", PGDATABASE: "conduit_prod",
    });
  });

  it("decodes percent-encoding, and sets no PGPASSWORD when the url carries none", () => {
    const { env } = pgDumpInvocation("postgres://us%40er:p%40ss%2Fword@db.example:5433/con%20duit");
    expect(env.PGUSER).toBe("us@er");
    expect(env.PGPASSWORD).toBe("p@ss/word");
    expect(env.PGDATABASE).toBe("con duit");
    const socket = pgDumpInvocation("postgres:///conduit_test");
    expect(socket.env.PGPASSWORD).toBeUndefined();
    expect(socket.env.PGDATABASE).toBe("conduit_test");
  });

  // THE SCANNER, SHOWN FINDING SOMETHING, before it is trusted to find
  // nothing. A /proc sweep that silently returned "" would pass the real test
  // below for ever.
  it7zProc("the /proc scan can see a passphrase that IS on a command line", async () => {
    const dir = await mkdtemp(path.join(scratch, "control-"));
    await writeFile(path.join(dir, "a.txt"), "x".repeat(8 * 1024 * 1024));
    const marker = `CONTROL-${randomUUID()}`;
    const child = spawn("7z", [
      "a", "-t7z", `-p${marker}`, "-mhe=on", "-mx=9", "-bd", "-y", "--",
      path.join(dir, "out.7z"), path.join(dir, "a.txt"),
    ], { stdio: "ignore" });
    let found = false;
    while (child.exitCode === null && !found) {
      if ((await processArguments()).includes(marker)) found = true;
    }
    child.kill("SIGKILL");
    expect(found).toBe(true);
  }, 120_000);

  // AND NOW THE REAL ONE. /proc/<pid>/cmdline is world-readable, so a
  // passphrase in argv is readable by every other local user -- every other
  // YunoHost app on the box -- for as long as the archive takes to write.
  it7zProc("never puts the passphrase in a process argument list", async () => {
    // Enough INCOMPRESSIBLE data that 7z runs for seconds, so the poll below has
    // a real window to catch it in -- the control test above needs the same and
    // gets it from -mx=9 over the same shape.
    await seedUpload("big.bin", randomBytes(16 * 1024 * 1024).toString("base64"));
    const marker = `PASSPHRASE-${randomUUID()}`;
    let sightings = 0;
    let polls = 0;
    let settled = false;
    const build = run({ passphrase: marker });
    const poll = (async () => {
      for (;;) {
        polls += 1;
        if ((await processArguments()).includes(marker)) sightings += 1;
        if (settled) return;
      }
    })();
    let archive;
    try {
      archive = await build;
    } finally {
      settled = true;
      await poll;
    }
    await archive.dispose();
    expect(polls).toBeGreaterThan(5);
    expect(sightings).toBe(0);
  }, 180_000);
});

describe("backup missing tools", () => {
  /**
   * Put a directory on the front of PATH holding a stub for `name`, run `body`,
   * and put PATH back. documents-render.test.ts's precedent for proving the
   * absent-binary path without uninstalling anything.
   */
  async function withStub<T>(name: string, script: string, body: () => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(scratch, "stub-"));
    await writeFile(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const original = process.env.PATH;
    process.env.PATH = `${dir}:${original ?? ""}`;
    try {
      return await body();
    } finally {
      process.env.PATH = original;
    }
  }

  it("fails at the button when 7z is absent, naming p7zip-full", async () => {
    const error = await withStub("7z", "exit 127", () => run().then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(BackupToolMissingError);
    expect((error as Error).message).toContain(SEVEN_ZIP_PACKAGE);
    // NEVER HALF-PRODUCES AN ARCHIVE. The spec's words, and the reason the
    // probe runs before anything is written.
    expect(await workDirs()).toEqual([]);
  }, 120_000);

  it("fails at the button when pg_dump is absent, naming postgresql-client", async () => {
    const error = await withStub("pg_dump", "exit 127", () => run().then(() => null, (e: unknown) => e));
    expect(error).toBeInstanceOf(BackupToolMissingError);
    expect((error as Error).message).toContain(PG_DUMP_PACKAGE);
    expect(await workDirs()).toEqual([]);
  }, 120_000);

  it("fails when pg_dump is older than the server it would dump", async () => {
    const error = await withStub(
      "pg_dump", 'echo "pg_dump (PostgreSQL) 9.6.24"',
      () => run().then(() => null, (e: unknown) => e),
    );
    expect(error).toBeInstanceOf(BackupToolMissingError);
    expect((error as Error).message).toMatch(/pg_dump is version 9 and the database server is \d+/);
  }, 120_000);

  it7z("accepts a pg_dump NEWER than the server, which is an ordinary setup", async () => {
    // THE DIRECTION pg_dump ITSELF TOLERATES, and refusing it would refuse a CI
    // runner with client 16 against a PostgreSQL 15 service container -- which
    // is why the guard is "older than" rather than the spec's literal "match".
    // The stub reports a version from the future and then execs the real
    // binary, so this exercises the whole path and not only the check.
    const real = (await execFileAsync("sh", ["-c", "command -v pg_dump"])).stdout.trim();
    await expect(withStub(
      "pg_dump",
      `if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 99.1"; exit 0; fi\nexec ${real} "$@"`,
      async () => { const a = await run(); await a.dispose(); return true; },
    )).resolves.toBe(true);
  }, 120_000);

  it("reads a major version out of every shape pg_dump prints", () => {
    expect(majorVersion("pg_dump (PostgreSQL) 15.19 (Debian 15.19-0+deb12u1)")).toBe(15);
    expect(majorVersion("pg_dump (PostgreSQL) 17.2")).toBe(17);
    expect(majorVersion("15.19")).toBe(15);
    expect(majorVersion("nothing numeric")).toBeNull();
  });
});

describe("backup memory", () => {
  /**
   * The peak resident set of the 7z child, sampled from /proc.
   *
   * THE CHILD IS THE PROCESS WITH THE APPETITE, and it is the half a node-side
   * bound cannot see. Measured on the deploy target against a 78MB corpus:
   * -mx=1 peaks at 19-20MB, the default level at 396MB, -mx=9 at 836MB, on a
   * box with 3.8GB and NO SWAP. The ceiling below sits between the first two
   * with 5x headroom either way, so it fires on a changed compression level
   * rather than on a busy machine.
   */
  async function peakRssOfSevenZip(signal: { done: boolean }): Promise<number> {
    let peak = 0;
    while (!signal.done) {
      // 20ms, not a flat-out spin: 7z holds its dictionary for its whole run,
      // so the peak is not a spike that has to be caught, and a busy loop on a
      // 2-CPU box would be competing with the process it is measuring.
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = (await readFile(`/proc/${entry}/cmdline`)).toString("utf8");
          if (!cmdline.includes("-mhe=on") || !cmdline.includes(dataDir)) continue;
          const status = await readFile(`/proc/${entry}/status`, "utf8");
          const match = /VmRSS:\s+(\d+) kB/.exec(status);
          if (match !== null) peak = Math.max(peak, Number(match[1]) * 1024);
        } catch { /* it exited while we looked */ }
      }
    }
    return peak;
  }

  const CHILD_RSS_CEILING_BYTES = 100 * 1024 * 1024;
  const NODE_RSS_CEILING_BYTES = 120 * 1024 * 1024;
  const CORPUS_BYTES = 66 * 1024 * 1024;

  it7zProc("bounds BOTH processes: 7z's resident set and this one's", async () => {
    // Incompressible, in three blobs, because that is the shape of a real blob
    // store and because compressible filler would let 7z off the dictionary
    // allocation this bound exists to catch.
    await mkdir(path.join(dataDir, "files"), { recursive: true });
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    for (let i = 0; i < 3; i += 1) {
      const bytes = randomBytes(CORPUS_BYTES / 3);
      const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([bytes]));
      await attachFile(handle.db, actorId, {
        originalName: `blob${String(i)}.bin`, mime: "application/octet-stream",
        sizeBytes, sha256, companyId: company.id,
      });
    }

    const signal = { done: false };
    const childPeak = peakRssOfSevenZip(signal);

    forceGc();
    const before = process.memoryUsage.rss();
    let nodePeak = before;
    const sampler = setInterval(() => {
      const rss = process.memoryUsage.rss();
      if (rss > nodePeak) nodePeak = rss;
    }, 10);

    let bytes = 0;
    try {
      const archive = await run();
      for await (const chunk of archive.stream) bytes += (chunk as Buffer).length;
    } finally {
      clearInterval(sampler);
      signal.done = true;
    }
    const childRss = await childPeak;

    // The corpus really did go through, so neither bound was met by doing
    // nothing.
    expect(bytes).toBeGreaterThan(CORPUS_BYTES * 0.9);
    expect(childRss).toBeGreaterThan(0);

    expect(
      childRss,
      `7z peaked at ${String(Math.round(childRss / 1024 / 1024))}MB while writing `
      + `${String(Math.round(bytes / 1024 / 1024))}MB; the default compression level costs 396MB for 155KB less archive`,
    ).toBeLessThan(CHILD_RSS_CEILING_BYTES);

    const grew = nodePeak - before;
    expect(
      grew,
      `this process grew ${String(Math.round(grew / 1024 / 1024))}MB while building and streaming `
      + `${String(Math.round(bytes / 1024 / 1024))}MB; an implementation that read the archive into a buffer would grow by its whole size`,
    ).toBeLessThan(NODE_RSS_CEILING_BYTES);
  }, 300_000);
});

async function openDescriptorsFor(target: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir("/proc/self/fd");
  } catch {
    return -1;
  }
  let count = 0;
  for (const entry of entries) {
    try {
      if (await readlink(path.join("/proc/self/fd", entry)) === target) count += 1;
    } catch { /* the descriptor closed while we were looking */ }
  }
  return count;
}
