import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { PlanView, ReauthScope } from "@conduit/shared";
import { buildApp } from "../app.js";
import { createDatabase, runMigrations, type DatabaseHandle } from "../db/client.js";
import { openTestDatabase } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { digestOf, HAVE_7Z } from "../test/archives.js";
import { TEST_REAUTH_PASSWORD, testReauthVerifier } from "../test/reauth.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { buildBackup, pgDumpVersion, type BackupManifest } from "../services/backup.js";
import { psqlVersion } from "../services/restore.js";
import { forgetMailKey } from "../services/mail-crypto.js";
import { INTAKE_WORK_PREFIX } from "../services/intake.js";
import { ReauthTickets } from "../services/reauth.js";
import type { ReauthVerifier } from "../services/reauth.js";
import { installName } from "./restore.js";
import type { Config } from "../config.js";

// THE ROUTES THAT DECIDE A RESTORE MAY HAPPEN, AND EVERY WAY OF GETTING PAST
// THEM THAT COULD BE THOUGHT OF.
//
// services/restore.test.ts proves the ENGINE: that a real backup restores onto
// a different install, that a failed load rolls back, that the instruments see
// what they claim to see. Nothing there can be reached without deciding to
// restore, and this file is about that decision -- re-authentication, the typed
// install name, the plan bound to its operator, and the writes that stop for
// the duration.
//
// IT NEVER DESTROYS conduit_test. Every app that could reach applyRestore is
// built against a scratch database created for that case and dropped after it;
// the guard is `assertScratch`, which is called by the only helper that builds
// such an app. A guard that failed here would otherwise take the whole suite's
// database with it, which is the loudest possible way to learn that a test was
// pointed at the wrong install.

const HAVE_PSQL = (await psqlVersion()) !== null;
const HAVE_PG_DUMP = (await pgDumpVersion()) !== null;
/** Everything a real restore needs. A developer on macOS gets a visible skip. */
const itRestore = HAVE_7Z && HAVE_PSQL && HAVE_PG_DUMP ? it : it.skip;
/**
 * Enough to BUILD and READ an archive, which is what every preview case needs:
 * a fixture is a real backup, so pg_dump is as required as 7z even though no
 * dump is loaded. Naming only 7z here would have turned a missing pg_dump into
 * a crash in a `beforeEach` rather than the visible skip the convention asks
 * for.
 */
const itArchive = HAVE_7Z && HAVE_PG_DUMP ? it : it.skip;

// /proc is the only way for a process to count its own open descriptors, and it
// is Linux-only. The dev server and CI are both Linux, which is where the
// descriptor discipline has to hold; a developer on macOS gets a visible skip.
const HAVE_PROC = await readdir("/proc/self/fd").then(() => true, () => false);
const itFd = HAVE_7Z && HAVE_PSQL && HAVE_PG_DUMP && HAVE_PROC ? it : it.skip;

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "1.4.0";
const SCRATCH_PREFIX = "conduit_restore_routes_";

const chris = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};
const sam = {
  "ynh-user": "sam",
  "ynh-user-email": "sam@example.com",
  "ynh-user-fullname": "Sam Patel",
};

/** The control connection. Used ONLY to create and drop scratch databases. */
const control = openTestDatabase();

interface Install {
  name: string;
  url: string;
  handle: DatabaseHandle;
  dataDir: string;
  mailKeyPath: string;
}

let installs: Install[] = [];
let scratchDirs: string[] = [];
let apps: FastifyInstance[] = [];

/**
 * Drop a scratch database without `WITH (FORCE)`.
 *
 * The same measurement services/restore.test.ts records: FORCE terminates every
 * other backend including an autovacuum worker, which a non-superuser may not
 * signal, and the failure lands in teardown reading as an unrelated test.
 */
async function dropScratchDatabase(name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await control.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await control.db.execute(sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

beforeAll(async () => {
  const stale = await control.db.execute<{ datname: string }>(sql`
    SELECT datname FROM pg_database WHERE datname LIKE ${`${SCRATCH_PREFIX}%`}
  `);
  for (const row of stale) await dropScratchDatabase(row.datname);
});

beforeEach(() => {
  installs = [];
  scratchDirs = [];
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
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
  const dir = await mkdtemp(path.join(os.tmpdir(), `conduit-restore-route-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

/** One Conduit install: its own database, its own $data_dir, its own mail.key. */
async function makeInstall(label: string): Promise<Install> {
  const name = `${SCRATCH_PREFIX}${label}_${randomUUID().replace(/-/g, "")}`;
  await control.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  const url = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${name}`);
  const handle = createDatabase(url, 2);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `conduit-restore-route-${label}-data-`));
  const mailKeyPath = path.join(dataDir, "mail.key");
  const install: Install = { name, url, handle, dataDir, mailKeyPath };
  installs.push(install);
  // Different per install by construction, because "restoring onto a different
  // install" means the key really is somebody else's.
  await writeFile(mailKeyPath, Buffer.alloc(32, label.charCodeAt(0) % 251), { mode: 0o600 });
  await mkdir(path.join(dataDir, "files"), { recursive: true });
  await runMigrations(handle.db);
  return install;
}

/**
 * THE ONE THING BETWEEN A MISTAKE IN THIS FILE AND conduit_test.
 *
 * Every app built here can reach applyRestore, which drops every schema in the
 * database it is pointed at. A test that reached for the shared handle by
 * accident would take the whole suite's database with it, and the symptom would
 * be forty unrelated files failing afterwards.
 */
function assertScratch(url: string): void {
  const name = installName(url);
  if (name === null || !name.startsWith(SCRATCH_PREFIX)) {
    throw new Error(
      `refusing to point a restore app at ${JSON.stringify(url)}: `
      + `only ${SCRATCH_PREFIX}* databases may be restored over`,
    );
  }
}

interface AppOptions {
  verifier?: ReauthVerifier;
  restoreMaxUploadBytes?: number;
  restoreDrainTimeoutMs?: number;
}

async function appFor(install: Install, options: AppOptions = {}): Promise<FastifyInstance> {
  assertScratch(install.url);
  const config: Config = {
    nodeEnv: "test",
    port: 0,
    databaseUrl: install.url,
    basePath: "/",
    version: APP_VERSION,
    devUser: null,
    dataDir: install.dataDir,
    defaultCurrency: "EUR",
    mailKeyPath: install.mailKeyPath,
    mailTlsRejectUnauthorized: true,
    ldapUrl: "ldap://127.0.0.1:389",
    reauthPassword: null,
  };
  const app = await buildApp({
    config,
    db: install.handle.db,
    dataDir: install.dataDir,
    reauthVerifier: options.verifier ?? testReauthVerifier(),
    restoreMaxUploadBytes: options.restoreMaxUploadBytes,
    restoreDrainTimeoutMs: options.restoreDrainTimeoutMs,
  });
  apps.push(app);
  return app;
}

/** Put recognisable data in an install, through the real service. */
async function seed(install: Install, names: readonly string[]): Promise<void> {
  const actor = await resolveUser(install.handle.db, {
    username: "chris", email: null, fullName: null,
  });
  for (const name of names) await createCompany(install.handle.db, actor.id, { name });
}

/** How many users a database holds, read over a FRESH connection. */
async function userCount(url: string): Promise<number> {
  const handle = createDatabase(url, 1);
  try {
    const rows = await handle.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM users`,
    );
    return Number(rows[0]?.count ?? "0");
  } finally {
    await handle.close();
  }
}

/** Company names in a database, read over a FRESH connection. */
async function companyNames(url: string): Promise<string[]> {
  const handle = createDatabase(url, 1);
  try {
    const rows = await handle.db.execute<{ name: string }>(
      sql`SELECT name FROM companies ORDER BY name`,
    );
    return rows.map((row) => row.name);
  } finally {
    await handle.close();
  }
}

// --- archives --------------------------------------------------------------

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

/**
 * Take a real backup apart, let a case change the unpacked tree, and put it
 * back together. A hand-built archive would share whatever assumption the
 * reader makes; this starts from what services/backup.ts actually writes.
 */
async function alteredBackup(
  install: Install,
  edit: (dir: string, manifest: BackupManifest) => Promise<BackupManifest | void>,
): Promise<string> {
  const work = await scratchDir("alter");
  const original = await realBackup(install, work);
  const unpacked = path.join(work, "unpacked");
  await mkdir(unpacked, { recursive: true });
  if (await sevenZip(["x", `-o${unpacked}`, "-bd", "-y", "--", original], PASSPHRASE) !== 0) {
    throw new Error("7z x failed unpacking a fixture");
  }
  const manifestPath = path.join(unpacked, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
  const updated = await edit(unpacked, manifest);
  await writeFile(manifestPath, `${JSON.stringify(updated ?? manifest, null, 2)}\n`);
  const rebuilt = path.join(work, "altered.7z");
  const roots = (await readdir(unpacked)).map((entry) => path.resolve(unpacked, entry));
  if (await sevenZip(
    ["a", "-t7z", "-p", "-mhe=on", "-mx=1", "-bd", "-y", "--", rebuilt, ...roots], PASSPHRASE,
  ) !== 0) {
    throw new Error("7z a failed rebuilding a fixture");
  }
  return rebuilt;
}

// --- HTTP --------------------------------------------------------------------

const BOUNDARY = "----conduit-restore-route-test";

/**
 * A multipart body, built by hand.
 *
 * THE PASSPHRASE FIELD COMES FIRST, and that is the route's documented
 * contract rather than this helper's taste: fastify-multipart is a streaming
 * parser, so a field declared after the file part has not been seen by the time
 * `request.file()` resolves. `fieldOrder` exists so the case that proves the
 * contract can put it the wrong way round.
 */
function upload(options: {
  content: Buffer;
  passphrase?: string;
  filename?: string;
  fieldOrder?: "passphrase-first" | "file-first";
  fileField?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const { content, passphrase, filename = "backup.7z", fileField = "file" } = options;
  const passphrasePart = passphrase === undefined ? [] : [Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n`
    + `${passphrase}\r\n`,
  )];
  const filePart = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fileField}"; `
      + `filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from("\r\n"),
  ];
  const parts = options.fieldOrder === "file-first"
    ? [...filePart, ...passphrasePart]
    : [...passphrasePart, ...filePart];
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/**
 * Mint one ticket through the real endpoint, for the identity in `headers` and
 * for one operation.
 *
 * THE SCOPE IS NAMED AT EVERY CALL AND HAS NO DEFAULT. A ticket is proof for
 * one operation since v1.4.1, and the two restore routes are the pair that
 * defect was sharpest between -- so a helper that guessed would be the one
 * place in this file able to hide it.
 */
async function ticket(
  app: FastifyInstance, headers: Record<string, string>, scope: ReauthScope,
): Promise<string> {
  const response = await app.inject({
    method: "POST", url: "/api/reauth", headers,
    payload: { password: TEST_REAUTH_PASSWORD, scope },
  });
  if (response.statusCode !== 200) {
    throw new Error(`could not mint a ticket: ${String(response.statusCode)} ${response.body}`);
  }
  return (response.json() as { ticket: string }).ticket;
}

/** `headers` plus a freshly minted, single-use ticket. One call, one request. */
async function reauthed(
  app: FastifyInstance, headers: Record<string, string>, scope: ReauthScope,
): Promise<Record<string, string>> {
  return { ...headers, "x-conduit-reauth": await ticket(app, headers, scope) };
}

/** Upload an archive and get the preview back. */
async function inspect(
  app: FastifyInstance, archivePath: string,
  options: { headers?: Record<string, string>; passphrase?: string } = {},
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  const headers = options.headers ?? await reauthed(app, chris, "restore-preview");
  const form = upload({
    content: await readFile(archivePath), passphrase: options.passphrase ?? PASSPHRASE,
  });
  return await app.inject({
    method: "POST", url: "/api/restore/inspect",
    headers: { ...headers, ...form.headers }, payload: form.payload,
  });
}

/** The preview's plan, or a loud failure. */
async function previewOf(app: FastifyInstance, archivePath: string): Promise<PlanView> {
  const response = await inspect(app, archivePath);
  if (response.statusCode !== 200) {
    throw new Error(`preview failed: ${String(response.statusCode)} ${response.body}`);
  }
  return (response.json() as { plan: PlanView }).plan;
}

async function applyRestoreRequest(
  app: FastifyInstance,
  body: Record<string, unknown>,
  options: { headers?: Record<string, string> } = {},
) {
  const headers = options.headers ?? await reauthed(app, chris, "restore-apply");
  return await app.inject({ method: "POST", url: "/api/restore/apply", headers, payload: body });
}

// --- the disk, as the discipline requires it to be --------------------------

/** Intake work directories left in an install's $data_dir. */
async function intakeWorkDirs(install: Install): Promise<string[]> {
  return (await readdir(install.dataDir)).filter((e) => e.startsWith(INTAKE_WORK_PREFIX));
}

/**
 * How many descriptors this process holds on anything inside an intake work
 * directory.
 *
 * `readlink` on /proc/self/fd/N reports a REMOVED file as "<path> (deleted)",
 * so this counts the leak the discipline exists to prevent: a directory removed
 * while a descriptor on it stayed open costs a descriptor and blocks for as
 * long as it is held.
 */
async function intakeDescriptors(): Promise<number> {
  let count = 0;
  for (const entry of await readdir("/proc/self/fd")) {
    try {
      if ((await readlink(path.join("/proc/self/fd", entry))).includes(INTAKE_WORK_PREFIX)) {
        count += 1;
      }
    } catch { /* the descriptor closed while we were looking */ }
  }
  return count;
}

// ---------------------------------------------------------------------------
// installName -- what the operator has to type
// ---------------------------------------------------------------------------

describe("installName", () => {
  it("is the database this install is connected to", () => {
    expect(installName("postgres://user:pw@127.0.0.1:5432/conduit")).toBe("conduit");
    // The empty-host form this project's own dev and test URLs use.
    expect(installName("postgres:///conduit_test")).toBe("conduit_test");
    // A second YunoHost instance on one box.
    expect(installName("postgres://u:p@h/conduit__2?sslmode=disable")).toBe("conduit__2");
    expect(installName("postgres://u:p@h/con%20duit")).toBe("con duit");
  });

  // NULL IS A REFUSAL, NEVER A DEFAULT -- the apply route answers 503 rather
  // than falling back to a constant, because a constant is a confirmation
  // string everybody can type.
  it("answers null rather than something typeable when it cannot name one", () => {
    expect(installName("not a url at all")).toBeNull();
    expect(installName("postgres://user:pw@127.0.0.1:5432")).toBeNull();
    expect(installName("postgres://user:pw@127.0.0.1:5432/")).toBeNull();
    expect(installName("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The boot sweep -- the one net under a crash that left a decrypted backup
// ---------------------------------------------------------------------------

describe("sweeping abandoned intakes at boot", () => {
  it("removes a work directory a previous run left, and leaves everything else", async () => {
    const install = await makeInstall("sweep");
    // What a SIGKILL leaves: an unpacked backup with mail.key in the clear.
    const abandoned = path.join(install.dataDir, `${INTAKE_WORK_PREFIX}abcdef`);
    await mkdir(path.join(abandoned, "staged"), { recursive: true });
    await writeFile(path.join(abandoned, "staged", "mail.key"), Buffer.alloc(32, 9));
    // And something that is not one, so the sweep is shown to be scoped.
    await mkdir(path.join(install.dataDir, "files", "ab"), { recursive: true });
    await writeFile(path.join(install.dataDir, "files", "ab", "cdef"), "a blob");

    await appFor(install);
    // The sweep is fired and forgotten at registration, so this waits for it
    // rather than assuming the ordering.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await intakeWorkDirs(install)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await intakeWorkDirs(install)).toEqual([]);
    // Scoped: the blob store and mail.key are untouched.
    expect(await readFile(path.join(install.dataDir, "files", "ab", "cdef"), "utf8"))
      .toBe("a blob");
    expect((await stat(install.mailKeyPath)).size).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// The gate. Bypass attempts, on BOTH routes.
// ---------------------------------------------------------------------------

describe("re-authentication gates both restore routes", () => {
  let install: Install;
  let app: FastifyInstance;
  /** A body that would be valid if it ever got past the gate. */
  let inspectForm: { payload: Buffer; headers: Record<string, string> };
  const applyBody = {
    planId: "11111111-2222-4333-8444-555555555555",
    passphrase: PASSPHRASE,
    confirmName: "whatever",
  };

  beforeEach(async () => {
    install = await makeInstall("gate");
    app = await appFor(install);
    inspectForm = upload({ content: Buffer.from("not really an archive"), passphrase: PASSPHRASE });
  });

  /** Every bypass attempt is run against both routes. */
  const routes = [
    { what: "inspect", url: "/api/restore/inspect", scope: "restore-preview" },
    { what: "apply", url: "/api/restore/apply", scope: "restore-apply" },
  ] as const;

  async function attempt(
    url: string, headers: Record<string, string>, query = "",
  ) {
    return url.endsWith("inspect")
      ? await app.inject({
        method: "POST", url: `${url}${query}`,
        headers: { ...headers, ...inspectForm.headers }, payload: inspectForm.payload,
      })
      : await app.inject({ method: "POST", url: `${url}${query}`, headers, payload: applyBody });
  }

  describe.each(routes)("bypassing the gate on $what", ({ url, scope }) => {
    it("fails with no ticket at all", async () => {
      const response = await attempt(url, chris);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });

    it("fails with an invented ticket", async () => {
      const response = await attempt(url, { ...chris, "x-conduit-reauth": "f".repeat(64) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });

    it("fails with an empty ticket header", async () => {
      const response = await attempt(url, { ...chris, "x-conduit-reauth": "" });
      expect(response.statusCode).toBe(401);
    });

    it("fails on a ticket that has already been spent", async () => {
      const spent = await ticket(app, chris, scope);
      const first = await attempt(url, { ...chris, "x-conduit-reauth": spent });
      // The first got PAST the gate -- it fails for its own reasons (the body
      // is not an archive, the plan id is unknown) and that is the point: if it
      // had been refused BY THE GATE the second assertion would pass for the
      // wrong reason.
      expect(first.body).not.toContain("reauth_required");
      const second = await attempt(url, { ...chris, "x-conduit-reauth": spent });
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ error: "reauth_required" });
    });

    it("fails on another account's ticket", async () => {
      const theirs = await ticket(app, sam, scope);
      const response = await attempt(url, { ...chris, "x-conduit-reauth": theirs });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });

    it("fails on an expired ticket", async () => {
      // The SAME class the app uses, constructed with a lifetime of nothing,
      // rather than a stub that says no.
      const expired = new ReauthTickets(0);
      const token = expired.issue("chris", scope);
      expect(expired.redeem(token, "chris", scope)).toBe(false);
      const response = await attempt(url, { ...chris, "x-conduit-reauth": token });
      expect(response.statusCode).toBe(401);
    });

    it("fails when a junk value rides alongside a real ticket, in either order", async () => {
      for (const order of ["junk-first", "ticket-first"] as const) {
        const real = await ticket(app, chris, scope);
        const value = order === "junk-first" ? `junk, ${real}` : `${real}, junk`;
        const response = await attempt(url, { ...chris, "x-conduit-reauth": value });
        expect(response.statusCode, order).toBe(401);
        expect(response.body, order).toContain("reauth_required");
      }
    });

    it("fails on a very long ticket value without reading it as anything", async () => {
      const response = await attempt(url, { ...chris, "x-conduit-reauth": "a".repeat(60_000) });
      expect(response.statusCode).toBe(401);
    });

    // THE TICKET MUST NOT TRAVEL SOMEWHERE THAT LOGS IT. nginx writes a query
    // string to its access log verbatim and the browser keeps it in history,
    // which is the whole reason v1.3.0 made the backup a POST.
    it("fails when the ticket is put in the query string", async () => {
      const real = await ticket(app, chris, scope);
      const response = await attempt(
        url, chris, `?x-conduit-reauth=${real}&ticket=${real}&reauth=${real}`,
      );
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });

    it("fails when the ticket is put in a cookie", async () => {
      const real = await ticket(app, chris, scope);
      const response = await attempt(url, {
        ...chris, cookie: `x-conduit-reauth=${real}; other=1`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "reauth_required" });
    });

    // AND THE DIRECTION THAT MUST STILL WORK. HTTP header names are
    // case-insensitive and node lower-cases them on the way in, so an
    // upper-cased header is the same header. Asserted rather than assumed,
    // because the failure would be a gate that refuses the operator who did
    // everything right -- and because the only way to find out is to look.
    it("accepts the ticket whatever case the header name is written in", async () => {
      const real = await ticket(app, chris, scope);
      const response = await attempt(url, { ...chris, "X-CONDUIT-REAUTH": real });
      expect(response.body).not.toContain("reauth_required");
    });

    it("answers unauthenticated before it answers reauth_required", async () => {
      // No identity at all: the answer must be about the session, not about a
      // ticket a caller with no session could never have.
      const response = await attempt(url, { "x-conduit-reauth": "f".repeat(64) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "unauthenticated" });
    });
  });

  // AND THE PROPERTY THE GATE IS FOR, which a status code alone does not show:
  // a refused upload writes NOTHING. The body is a complete, well-formed
  // multipart upload; the only thing missing is the proof.
  it("stages nothing at all when the preview is refused for want of a ticket", async () => {
    const response = await attempt("/api/restore/inspect", chris);
    expect(response.statusCode).toBe(401);
    expect(await intakeWorkDirs(install)).toEqual([]);
  });

  // THE PASSPHRASE MUST NOT REACH A GET, and neither must anything else here.
  // v1.3.0 made the backup a POST for exactly this and asserts it has no GET.
  it("has no GET or HEAD route anywhere in the family", async () => {
    for (const url of [
      "/api/restore", "/api/restore/inspect", "/api/restore/apply",
      `/api/restore/inspect?passphrase=${encodeURIComponent(PASSPHRASE)}`,
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app.inject({ method, url, headers: chris });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

describe("POST /api/restore/inspect", () => {
  let source: Install;
  let target: Install;
  let app: FastifyInstance;
  let archive: string;

  beforeEach(async () => {
    if (!HAVE_7Z || !HAVE_PG_DUMP) return;
    source = await makeInstall("src");
    await seed(source, ["Northwind Traders", "Umbrella BV"]);
    target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);
    app = await appFor(target);
    archive = await realBackup(source, await scratchDir("archive"));
  });

  itArchive("returns a plan and the install's name, and holds the staging", async () => {
    const response = await inspect(app, archive);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { plan: PlanView; installName: string };
    expect(body.installName).toBe(target.name);
    expect(body.plan.kind).toBe("restore");
    expect(body.plan.refusal).toBeNull();
    expect(body.plan.effects.map((e) => e.op)).toEqual([
      "safety-backup", "write-blobs", "destroy-schema", "load-dump", "replace-mail-key",
    ]);
    // AND THE STAGING IS THERE. This is also the control that makes every
    // "nothing was left behind" assertion below mean something: the counter can
    // see a work directory when one exists.
    expect(await intakeWorkDirs(target)).toHaveLength(1);
  });

  // THE PLAN NEVER TRAVELS. What comes back is a RENDERING: no staged-member
  // refs, which are the object identities that would let a caller describe
  // work, and nothing else the wire form does not declare.
  itArchive("sends a rendering of the plan and never the plan", async () => {
    const plan = await previewOf(app, archive);
    expect(Object.keys(plan).sort()).toEqual([
      "createdAt", "effects", "expiresAt", "findings", "kind", "planId", "refusal", "source",
    ]);
    for (const effect of plan.effects) {
      expect(Object.keys(effect).sort())
        .toEqual(["count", "destroys", "detail", "op", "subject", "unit"]);
      expect(effect).not.toHaveProperty("sources");
      expect(effect).not.toHaveProperty("realisedBy");
    }
    expect(JSON.stringify(plan)).not.toContain("sources");
  });

  itArchive("refuses a wrong passphrase without saying which of the two it was", async () => {
    const response = await inspect(app, archive, { passphrase: "not the passphrase" });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe("restore_archive_refused");
    // ONE MESSAGE FOR "WRONG PASSPHRASE" AND FOR "DAMAGED", because with
    // -mhe=on they are the same event at the same point in the same code path.
    expect(body.message).not.toMatch(/close|almost|correct/i);
    expect(await intakeWorkDirs(target)).toEqual([]);
  });

  itArchive("refuses a body that is not an archive, and stages nothing", async () => {
    const form = upload({ content: Buffer.from("hello, not a 7z"), passphrase: PASSPHRASE });
    const response = await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { ...await reauthed(app, chris, "restore-preview"), ...form.headers }, payload: form.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(await intakeWorkDirs(target)).toEqual([]);
  });

  itArchive("refuses a missing passphrase with the rule, not with a stack trace", async () => {
    const form = upload({ content: Buffer.from("anything") });
    const response = await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { ...await reauthed(app, chris, "restore-preview"), ...form.headers }, payload: form.payload,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain("passphrase is required");
    expect(await intakeWorkDirs(target)).toEqual([]);
  });

  // THE FIELD ORDER IS A CONTRACT AND IT IS NOT ASSERTED HERE, deliberately
  // and after trying. The route requires the passphrase field before the file
  // because fastify-multipart is a streaming parser -- but an in-process
  // injection hands the whole body over in one chunk, so busboy has parsed
  // every part before any await resolves and a "file first" body is accepted.
  // A test that passed on that would be asserting the harness, not the route,
  // and one written to fail would need a chunk-timing race of exactly the kind
  // this project has already lost once in CI. The refusal an absent passphrase
  // gets -- which is the same refusal -- is asserted above.
  itArchive("takes the passphrase field when it arrives before the file", async () => {
    const form = upload({
      content: Buffer.from("anything"), passphrase: PASSPHRASE, fieldOrder: "passphrase-first",
    });
    const response = await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { ...await reauthed(app, chris, "restore-preview"), ...form.headers }, payload: form.payload,
    });
    // Past the passphrase rule and refused by the archive, which is the only
    // way to see that the field was read at all.
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("restore_archive_refused");
  });

  itArchive("refuses a file field under any other name", async () => {
    const form = upload({
      content: Buffer.from("anything"), passphrase: PASSPHRASE, fileField: "archive",
    });
    const response = await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { ...await reauthed(app, chris, "restore-preview"), ...form.headers }, payload: form.payload,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('named "file"');
  });

  itArchive("refuses a request that is not multipart at all", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: await reauthed(app, chris, "restore-preview"), payload: { passphrase: PASSPHRASE },
    });
    expect(response.statusCode).toBe(400);
  });

  // THE UPLOAD BOUND, exercised with a cap a test can reach. Without the
  // `truncated` check the route would hand a PREFIX of a .7z to the stager and
  // report it as a damaged archive, which is a true sentence about the wrong
  // thing.
  itArchive("refuses an upload over the cap as too large, and leaves nothing staged", async () => {
    // ITS OWN INSTALL, so nothing else has an app pointed at this $data_dir:
    // a second app's boot sweep would remove the staging for its own reasons
    // and this assertion would pass without proving anything.
    const capped = await makeInstall("cap");
    const small = await appFor(capped, { restoreMaxUploadBytes: 4096 });
    const form = upload({ content: Buffer.alloc(16 * 1024, 7), passphrase: PASSPHRASE });
    const response = await small.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { ...await reauthed(small, chris, "restore-preview"), ...form.headers }, payload: form.payload,
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as { error: string }).error).toBe("too_large");
    expect(await intakeWorkDirs(capped)).toEqual([]);
  });

  // A REFUSAL IS STILL A PLAN, and it is NOT held: the archive is a decrypted
  // credential store with no remaining purpose, and the discipline says every
  // exit path removes one -- "success, refusal, failure and an abandoned
  // upload alike".
  itArchive("renders a refusal, holds nothing, and leaves nothing decrypted on disk", async () => {
    const newer = await alteredBackup(source, async (_dir, manifest) => {
      await Promise.resolve();
      return { ...manifest, appVersion: "99.0.0" };
    });
    const response = await inspect(app, newer);
    expect(response.statusCode).toBe(200);
    const plan = (response.json() as { plan: PlanView }).plan;
    expect(plan.refusal?.code).toBe("newer-app");
    expect(plan.effects).toEqual([]);
    expect(await intakeWorkDirs(target)).toEqual([]);

    // And its id cannot be applied, because nothing is holding it.
    const applied = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(applied.statusCode).toBe(404);
    expect(await companyNames(target.url)).toEqual(["Something Else Ltd"]);
  });

  // ONE AT A TIME, because a held session is an unpacked install sitting in
  // $data_dir and two of them is two installs.
  itArchive("refuses a second upload while one is waiting, and keeps the first", async () => {
    const first = await previewOf(app, archive);
    const second = await inspect(app, archive);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe("restore_busy");
    // The refused one took nothing with it: one staging, and it is the first's.
    expect(await intakeWorkDirs(target)).toHaveLength(1);
    const cancelled = await app.inject({
      method: "DELETE", url: `/api/restore/${first.planId}`, headers: chris,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(await intakeWorkDirs(target)).toEqual([]);
  });

  // CANCELLING IS THE SAFE DIRECTION, so it is behind the session and the
  // owner and not behind a second password: the failure mode of making it
  // harder to reach is a decrypted backup sitting in $data_dir until the plan
  // expires.
  itArchive("cancels only a plan that exists, and only for its owner", async () => {
    expect((await app.inject({
      method: "DELETE", url: `/api/restore/${randomUUID()}`, headers: chris,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE", url: "/api/restore/not-a-uuid", headers: chris,
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "DELETE", url: `/api/restore/${randomUUID()}`,
    })).statusCode).toBe(401);
  });

  // AND THE RACE THE CHEAP CHECK CANNOT SEE. Two uploads that both pass the
  // "is anything waiting" pre-check and only collide at `hold`. This is what
  // discriminates the two layers: the pre-check exists so a second operator is
  // not made to upload three gigabytes before being told, and `hold` is the one
  // that actually holds.
  itArchive("refuses the loser of two simultaneous uploads and disposes of its staging", async () => {
    const both = await Promise.all([inspect(app, archive), inspect(app, archive)]);
    const codes = both.map((response) => response.statusCode).sort((a, b) => a - b);
    expect(codes).toEqual([200, 409]);
    expect(await intakeWorkDirs(target)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The typed install name, the passphrase, and the operator the plan belongs to
// ---------------------------------------------------------------------------

describe("POST /api/restore/apply -- the guards in front of the destruction", () => {
  let source: Install;
  let target: Install;
  let app: FastifyInstance;
  let archive: string;
  let plan: PlanView;

  beforeEach(async () => {
    if (!HAVE_7Z || !HAVE_PG_DUMP || !HAVE_PSQL) return;
    source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);
    app = await appFor(target);
    archive = await realBackup(source, await scratchDir("archive"));
    plan = await previewOf(app, archive);
  });

  /** The target is untouched: the guard fired before anything was destroyed. */
  async function expectNothingDestroyed(): Promise<void> {
    expect(await companyNames(target.url)).toEqual(["Something Else Ltd"]);
    // And the plan is still the operator's to try again with.
    expect(await intakeWorkDirs(target)).toHaveLength(1);
  }

  itRestore("refuses a name that is not this install's, and destroys nothing", async () => {
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: "conduit",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "restore_name_mismatch", installName: target.name,
    });
    await expectNothingDestroyed();
  });

  itRestore("refuses an empty confirmation, which is the reflexive click", async () => {
    for (const confirmName of ["", "   ", "yes", target.name.toUpperCase()]) {
      const response = await applyRestoreRequest(app, {
        planId: plan.planId, passphrase: PASSPHRASE, confirmName,
      });
      expect(response.statusCode, JSON.stringify(confirmName)).toBe(400);
      expect((response.json() as { error: string }).error).toBe("restore_name_mismatch");
    }
    await expectNothingDestroyed();
  });

  // TRIMMED AND OTHERWISE EXACT: a copy-paste picks up surrounding whitespace
  // and refusing that teaches the operator nothing, while every other
  // relaxation would make the string easier to produce without having read it.
  itRestore("accepts the name with whitespace around it, and only that", async () => {
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: `  ${target.name}\n`,
    });
    // Past the guard: whatever happens next, it is not the name that stopped it.
    expect(response.body).not.toContain("restore_name_mismatch");
  }, 180_000);

  itRestore("refuses a passphrase the archive was not opened with", async () => {
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: "some other passphrase", confirmName: target.name,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("restore_passphrase_mismatch");
    await expectNothingDestroyed();
  });

  // THE PLAN IS BOUND TO THE OPERATOR WHO UPLOADED IT. Everything else about
  // sam's request is perfect: a real session, a real ticket, the right name and
  // the right passphrase.
  //
  // WHICH LAYER ANSWERS, SAID PLAINLY BECAUSE THIS CASE CANNOT TELL. The route
  // looks the session up with `get` before it consumes it with `use`, and both
  // compare the owner -- so `get` answers first and this case stays green with
  // `use`'s check removed. It is an instrument for the ROUTE passing an
  // identity at all, and not for either comparison; the two are separately
  // broken and separately caught in intake-plan.test.ts, which is where the
  // binding lives. Reading this as covering `use` would over-credit it.
  itRestore("will not let another account apply chris's plan, or cancel it", async () => {
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    }, { headers: await reauthed(app, sam, "restore-apply") });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe("restore_plan_unknown");

    const cancelled = await app.inject({
      method: "DELETE", url: `/api/restore/${plan.planId}`, headers: sam,
    });
    expect(cancelled.statusCode).toBe(404);
    await expectNothingDestroyed();
  });

  itRestore("refuses an unknown plan id without saying whether one exists", async () => {
    const response = await applyRestoreRequest(app, {
      planId: randomUUID(), passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(response.statusCode).toBe(404);
    await expectNothingDestroyed();
  });

  // THE PLAN DOES NOT TRAVEL, AND A CLIENT THAT TRIED TO SEND ONE IS TOLD SO
  // rather than having it silently stripped. A re-validated plan is a second
  // implementation of inspect, which is the one thing this design removes.
  itRestore("refuses a body carrying anything that looks like a plan", async () => {
    for (const extra of [
      { effects: [{ op: "load-dump", count: 1 }] },
      { plan: { effects: [] } },
      { destroys: false },
    ]) {
      const response = await applyRestoreRequest(app, {
        planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name, ...extra,
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      expect((response.json() as { error: string }).error).toBe("validation");
    }
    await expectNothingDestroyed();
  });

  itRestore("refuses a body missing any of the three fields", async () => {
    for (const body of [
      { passphrase: PASSPHRASE, confirmName: target.name },
      { planId: plan.planId, confirmName: target.name },
      { planId: plan.planId, passphrase: PASSPHRASE },
      { planId: "not-a-uuid", passphrase: PASSPHRASE, confirmName: target.name },
    ]) {
      const response = await applyRestoreRequest(app, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    await expectNothingDestroyed();
  });

  // NULL IS A REFUSAL, NEVER A DEFAULT. An install whose database cannot be
  // named has no confirmation string, and a constant would be one everybody can
  // type.
  itRestore("refuses to run at all when the install cannot be named", async () => {
    // ITS OWN $data_dir, AND THAT IS NOT INCIDENTAL. Every app sweeps abandoned
    // intake work directories at boot, and a sweep cannot tell one a crash left
    // behind from one another process is using -- so a second app pointed at
    // this target's directory deletes the preview the first one is holding.
    // There is one process per deployment, so this is a property of the test
    // bench rather than of the product, and it is written down because it cost
    // a red run.
    const elsewhere = await scratchDir("unnameable");
    const unnameable = await buildApp({
      config: {
        nodeEnv: "test", port: 0,
        databaseUrl: "postgres://user:pw@127.0.0.1:5432",
        basePath: "/", version: APP_VERSION, devUser: null, dataDir: elsewhere,
        defaultCurrency: "EUR", mailKeyPath: path.join(elsewhere, "mail.key"),
        mailTlsRejectUnauthorized: true, ldapUrl: "ldap://127.0.0.1:389",
        reauthPassword: null,
      },
      db: target.handle.db, dataDir: elsewhere, reauthVerifier: testReauthVerifier(),
    });
    apps.push(unnameable);
    const response = await applyRestoreRequest(unnameable, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: "anything",
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toBe("restore_unnameable");
    await expectNothingDestroyed();
  });
});

// ---------------------------------------------------------------------------
// "Refuse new writes" -- spec step 5's other half
// ---------------------------------------------------------------------------

describe("refusing new writes for the duration of a restore", () => {
  it("lets writes through when nothing is restoring", async () => {
    const install = await makeInstall("open");
    const app = await appFor(install);
    const response = await app.inject({
      method: "POST", url: "/api/companies", headers: chris, payload: { name: "Ordinary Ltd" },
    });
    expect(response.statusCode).toBe(201);
  });

  /**
   * THE WHOLE MECHANISM, IN ONE CASE, AND NOTHING IN IT IS TIMED.
   *
   * A write is held open inside the re-authentication verifier -- the one seam
   * this app already injects -- so the restore meets a second writer that
   * really is in flight rather than one a `setTimeout` hopes is. Three things
   * are asserted from that state:
   *
   *   - a NEW write is refused with 503 while the gate is closed;
   *   - the restore DOES NOT START, because the writer it is waiting for has a
   *     transaction it cannot see;
   *   - the in-flight write is not killed. It finishes normally, and it is the
   *     restore that gives way.
   *
   * The loop that observes the refusal is bounded by the apply request's own
   * promise, not by a clock: the drain cannot finish early while the blocked
   * writer is still there, so a pass is a real observation.
   */
  itRestore("refuses new writes, waits for the one in flight, and gives up rather than destroy", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);

    let armed = false;
    let entered: () => void = () => { /* replaced */ };
    let release: () => void = () => { /* replaced */ };
    const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const verifier: ReauthVerifier = async (_username, password) => {
      if (armed) {
        entered();
        await released;
      }
      return password === TEST_REAUTH_PASSWORD;
    };

    const app = await appFor(target, { verifier, restoreDrainTimeoutMs: 2_000 });
    const archive = await realBackup(source, await scratchDir("archive"));
    const plan = await previewOf(app, archive);
    // Minted BEFORE the verifier is armed, because apply redeems a ticket
    // rather than checking a password.
    const applyHeaders = await reauthed(app, chris, "restore-apply");

    armed = true;
    const blockedWrite = app.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    await hasEntered;

    const applying = app.inject({
      method: "POST", url: "/api/restore/apply", headers: applyHeaders,
      payload: { planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name },
    });
    let settled = false;
    void applying.then(() => { settled = true; }, () => { settled = true; });

    let refused: { statusCode: number; json: () => unknown; headers: Record<string, unknown> }
      | null = null;
    while (!settled && refused === null) {
      const response = await app.inject({
        method: "POST", url: "/api/companies", headers: chris, payload: { name: `probe-${randomUUID()}` },
      });
      if (response.statusCode === 503) refused = response;
    }
    expect(refused, "a write during a restore must be refused").not.toBeNull();
    expect(refused?.json()).toMatchObject({ error: "restore_in_progress" });
    expect(String(refused?.headers["retry-after"])).toBe("30");

    const applied = await applying;
    expect(applied.statusCode).toBe(503);
    expect(applied.json()).toMatchObject({ error: "restore_writes_in_flight" });
    expect((applied.json() as { stillWriting: number }).stillWriting).toBeGreaterThanOrEqual(1);

    // NOTHING WAS DESTROYED, and the plan is still there to try again with.
    expect(await companyNames(target.url)).toContain("Something Else Ltd");
    expect(await intakeWorkDirs(target)).toHaveLength(1);

    // THE IN-FLIGHT WRITE WAS NOT KILLED. It finishes normally; the restore is
    // what gave way.
    release();
    expect((await blockedWrite).statusCode).toBe(200);

    // And the gate is open again, because the route reopens it in a `finally`.
    const after = await app.inject({
      method: "POST", url: "/api/companies", headers: chris, payload: { name: "After" },
    });
    expect(after.statusCode).toBe(201);
  }, 180_000);

  /**
   * THE GET THAT WRITES, AND THE MECHANISM THAT DELIVERS IT INTO THE RESTORE.
   *
   * `resolve` is an UPSERT, so an ordinary read from a username this process
   * has not met INSERTS a users row. The first version of this module called
   * that a sub-millisecond window and said the operator was "by definition
   * cached". Both were false. PostgreSQL QUEUES a write blocked by the
   * restore's `DROP SCHEMA` lock and RELEASES IT AT COMMIT, so the insert is
   * delivered INTO the restored data -- the arrival window is the whole of
   * destroy-and-load, not the instructions after it.
   *
   * WHAT THIS CASE DOES IS THE MECHANISM, NOT A TIMING GUESS. It issues reads
   * from a FRESH identity every time, for the whole life of the apply request,
   * and then asks the two questions that matter: did the restore report
   * success, and does the restored database hold exactly the users the backup
   * recorded. Without the refusal in app.ts's identity hook the apply answers
   * 500 restore_inventory_mismatch -- "public.users: the backup recorded 1
   * row(s) and this database holds N" -- with mail.key left unreplaced and the
   * safety backup offered as the way out of a restore that WORKED.
   *
   * THE PROBE IS RATE-LIMITED AND CAPPED, and neither is a timing assumption.
   * An unthrottled loop injects fast enough to exhaust the worker's heap before
   * the restore finishes -- measured, as an out-of-memory crash rather than a
   * failure. 3ms is the interval the reviewer's own reproduction used, and the
   * cap is a ceiling on allocation, not a deadline: the loop still ENDS when
   * the apply promise settles, so nothing here waits on a clock for its answer.
   */
  itRestore("a read from an unknown identity cannot land a row inside the restore", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);
    const app = await appFor(target);
    const archive = await realBackup(source, await scratchDir("archive"));
    const expectedUsers = await userCount(source.url);
    const plan = await previewOf(app, archive);
    const headers = await reauthed(app, chris, "restore-apply");

    const applying = app.inject({
      method: "POST", url: "/api/restore/apply", headers,
      payload: { planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name },
    });
    let settled = false;
    void applying.then(() => { settled = true; }, () => { settled = true; });

    let reads = 0;
    let refused = 0;
    while (!settled && reads < 2_000) {
      const stranger = `probe-${randomUUID()}`;
      const read = await app.inject({
        method: "GET", url: "/api/companies",
        headers: {
          "ynh-user": stranger,
          "ynh-user-email": `${stranger}@example.com`,
          "ynh-user-fullname": "Probe",
        },
      });
      reads += 1;
      if (read.statusCode === 503) refused += 1;
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    const response = await applying;
    expect(response.statusCode, response.body).toBe(200);
    // THE GUARD ACTUALLY FIRED. Without this the case could pass on a restore
    // so fast that no read arrived during it, which is the vacuous version.
    expect(reads).toBeGreaterThan(0);
    expect(refused, "a read from an unknown identity must be refused during a restore")
      .toBeGreaterThan(0);
    // AND NOTHING LANDED. This is the assertion the mechanism defeats: read
    // over a fresh connection, against what the backup recorded.
    expect(await userCount(target.url)).toBe(expectedUsers);
  }, 300_000);

  // READS ARE NOT REFUSED, and that is the spec's own word: step 5 says refuse
  // new WRITES. A page that could not even report what was happening would be
  // worse than useless during the one operation an operator watches.
  itRestore("does not refuse reads while writes are refused", async () => {
    const source = await makeInstall("src");
    const target = await makeInstall("dst");
    let armed = false;
    let entered: () => void = () => { /* replaced */ };
    let release: () => void = () => { /* replaced */ };
    const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const verifier: ReauthVerifier = async (_username, password) => {
      if (armed) { entered(); await released; }
      return password === TEST_REAUTH_PASSWORD;
    };
    const app = await appFor(target, { verifier, restoreDrainTimeoutMs: 2_000 });
    const archive = await realBackup(source, await scratchDir("archive"));
    const plan = await previewOf(app, archive);
    const applyHeaders = await reauthed(app, chris, "restore-apply");

    armed = true;
    const blockedWrite = app.inject({
      method: "POST", url: "/api/reauth", headers: chris,
      payload: { password: TEST_REAUTH_PASSWORD, scope: "export" },
    });
    await hasEntered;
    const applying = app.inject({
      method: "POST", url: "/api/restore/apply", headers: applyHeaders,
      payload: { planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name },
    });
    let settled = false;
    void applying.then(() => { settled = true; }, () => { settled = true; });

    // RATE-LIMITED AND CAPPED for the reason the queued-write case is: an
    // unthrottled inject loop that never meets its exit condition exhausts the
    // worker's heap, and a mutation then shows up as an out-of-memory crash
    // rather than as the assertion below failing. Measured, on the mutation
    // that makes the cache lookup answer nothing. The loop still ends when the
    // apply settles, so there is no clock in the result.
    let sawRefusedWrite = false;
    let sawAllowedRead = false;
    let probes = 0;
    while (!settled && !(sawRefusedWrite && sawAllowedRead) && probes < 400) {
      probes += 1;
      const write = await app.inject({
        method: "POST", url: "/api/companies", headers: chris, payload: { name: `p-${randomUUID()}` },
      });
      if (write.statusCode === 503) {
        sawRefusedWrite = true;
        const read = await app.inject({ method: "GET", url: "/api/companies", headers: chris });
        if (read.statusCode === 200) sawAllowedRead = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    expect(sawRefusedWrite).toBe(true);
    expect(sawAllowedRead).toBe(true);
    await applying;
    release();
    await blockedWrite;
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The restore itself, end to end, onto a DIFFERENT install
// ---------------------------------------------------------------------------

describe("a restore that runs", () => {
  itRestore("replaces the target with the source, refusing writes while it does", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders", "Umbrella BV"]);
    const target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);
    const app = await appFor(target);
    const archive = await realBackup(source, await scratchDir("archive"));
    const plan = await previewOf(app, archive);
    const headers = await reauthed(app, chris, "restore-apply");

    const applying = app.inject({
      method: "POST", url: "/api/restore/apply", headers,
      payload: { planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name },
    });
    let settled = false;
    void applying.then(() => { settled = true; }, () => { settled = true; });
    // THE GATE IS CLOSED FOR THE REAL WORK, not only for the drain. Bounded by
    // the apply request's own promise: a restore takes a pg_dump and two 7z
    // runs, so there is no clock in this.
    let refusedDuring = false;
    while (!settled && !refusedDuring) {
      const write = await app.inject({
        method: "POST", url: "/api/companies", headers: chris, payload: { name: `p-${randomUUID()}` },
      });
      if (write.statusCode === 503) refusedDuring = true;
    }
    const response = await applying;
    expect(response.statusCode, response.body).toBe(200);
    expect(refusedDuring, "writes must be refused while the restore runs").toBe(true);

    const body = response.json() as { restored: boolean; message: string; unrealised: string[] };
    expect(body.restored).toBe(true);
    expect(body.unrealised).toEqual([]);
    expect(body.message).toContain("Restart Conduit");

    // VERIFIED OVER A FRESH CONNECTION. The pool this app used has sessions
    // that were open across a DROP SCHEMA of everything they referenced.
    expect(await companyNames(target.url)).toEqual(["Northwind Traders", "Umbrella BV"]);
    // mail.key is the source's now, which is the irreversible half.
    expect(await readFile(target.mailKeyPath)).toEqual(await readFile(source.mailKeyPath));
    // The staging is gone, and so is the plan.
    expect(await intakeWorkDirs(target)).toEqual([]);
    // AND THE GATE IS OPEN AGAIN -- but NOT that the write succeeds, and the
    // reason has been CORRECTED after a reviewer measured it. Immediately after
    // a restore this process still holds a user-resolver entry, a pool and a
    // mail key belonging to the install that was REPLACED, so a write fails on
    // the foreign key of a user id the restored database does not have.
    //
    // IT DOES NOT STAY THAT WAY. The resolver's TTL is 60 seconds, after which
    // the upsert re-binds the username to the restored row's id and the same
    // request answers 201 -- measured. So "writes fail" is NOT the signal that
    // a restart is needed: the process becomes silently usable again while
    // still holding stale state, and "Restart Conduit now" is advice with
    // nothing enforcing it. The Settings page must not be built on the failure.
    // What is asserted here is the gate alone.
    const after = await app.inject({
      method: "POST", url: "/api/companies", headers: chris, payload: { name: "After" },
    });
    expect(after.statusCode).not.toBe(503);
    expect(after.body).not.toContain("restore_in_progress");
  }, 300_000);

  // THE PLAN IS SINGLE USE. A second apply of the same id is a second restore.
  itRestore("cannot be applied twice", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    const app = await appFor(target);
    const archive = await realBackup(source, await scratchDir("archive"));
    const plan = await previewOf(app, archive);

    const first = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(second.statusCode, second.body).toBe(404);
  }, 300_000);

  // A LOAD THAT FAILS AND ROLLS BACK. The operator is exactly where they
  // started and the answer says so -- 409, not 500, because nothing is broken.
  itRestore("reports a rolled-back load as the operator being where they started", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    await seed(target, ["Something Else Ltd"]);
    const app = await appFor(target);
    // A dump that passes every check inspect makes -- no meta-commands, one
    // declared table, digests that match -- and that psql refuses part way.
    const broken = await alteredBackup(source, async (dir, manifest) => {
      const dump = "CREATE TABLE public.oops (id integer);\nSELECT 1/0;\n";
      await writeFile(path.join(dir, "database.sql"), dump);
      return {
        ...manifest,
        members: manifest.members.map((member) => member.path === "database.sql"
          ? { path: member.path, bytes: Buffer.byteLength(dump), sha256: digestOf(dump) }
          : member),
      };
    });
    const plan = await previewOf(app, broken);
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json() as { error: string; restored: boolean; message: string };
    expect(body.error).toBe("restore_load_failed");
    expect(body.restored).toBe(false);
    // NO CHILD PROCESS STDERR ON THE WIRE. The detail is logged, never sent.
    expect(body.message).not.toContain("psql:");
    // And the install really is where it started.
    expect(await companyNames(target.url)).toEqual(["Something Else Ltd"]);
    // The gate is open and the staging is gone.
    const after = await app.inject({
      method: "POST", url: "/api/companies", headers: chris, payload: { name: "After" },
    });
    expect(after.statusCode).toBe(201);
    expect(await intakeWorkDirs(target)).toEqual([]);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The credential store, counted rather than asserted
// ---------------------------------------------------------------------------

describe("descriptors and the staged archive", () => {
  itFd("leaves none open across success, refusal, failure and abort", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    const app = await appFor(target);
    const archive = await realBackup(source, await scratchDir("archive"));

    // The instrument, shown to see something before it is trusted to see
    // nothing: a held session IS a work directory.
    const held = await previewOf(app, archive);
    expect(await intakeWorkDirs(target)).toHaveLength(1);
    await app.inject({ method: "DELETE", url: `/api/restore/${held.planId}`, headers: chris });
    expect(await intakeDescriptors()).toBe(0);
    expect(await intakeWorkDirs(target)).toEqual([]);

    // REFUSAL: a wrong passphrase, which is where 7z fails at the header.
    expect((await inspect(app, archive, { passphrase: "wrong one" })).statusCode).toBe(400);
    expect(await intakeDescriptors(), "a refused upload must not leak a descriptor").toBe(0);
    expect(await intakeWorkDirs(target)).toEqual([]);

    // ABORT: the client goes away in the middle of the upload. Five times,
    // because one leaked descriptor is easy to miss and five is not.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const headers = await reauthed(app, chris, "restore-preview");
      const prologue = upload({ content: Buffer.alloc(0), passphrase: PASSPHRASE }).payload;
      const source$ = new Readable({
        read() {
          this.push(prologue.subarray(0, prologue.length - `--${BOUNDARY}--\r\n`.length));
          this.push(Buffer.alloc(512 * 1024, 3));
          this.destroy(new Error("the client went away"));
        },
      });
      await app.inject({
        method: "POST", url: "/api/restore/inspect",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
        payload: source$,
      }).catch(() => undefined);
    }
    expect(await intakeDescriptors(), "an aborted upload must not leak a descriptor").toBe(0);
    expect(await intakeWorkDirs(target)).toEqual([]);

    // FAILURE: an apply whose load is refused by psql and rolled back.
    const broken = await alteredBackup(source, async (dir, manifest) => {
      const dump = "CREATE TABLE public.oops (id integer);\nSELECT 1/0;\n";
      await writeFile(path.join(dir, "database.sql"), dump);
      return {
        ...manifest,
        members: manifest.members.map((member) => member.path === "database.sql"
          ? { path: member.path, bytes: Buffer.byteLength(dump), sha256: digestOf(dump) }
          : member),
      };
    });
    const failing = await previewOf(app, broken);
    const failed = await applyRestoreRequest(app, {
      planId: failing.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    // THE BODY RIDES ON EVERY ASSERTION ABOUT THIS ROUTE, and that is not
    // decoration: a bare status told a CI failure that a restore answered 503
    // and nothing about which of the four 503s it was, which cost a round trip
    // to find out. This endpoint's whole job is to say what state the install
    // is in; a test that throws that away is asking the wrong question.
    expect(failed.statusCode, failed.body).toBe(409);
    expect(await intakeDescriptors(), "a failed restore must not leak a descriptor").toBe(0);
    expect(await intakeWorkDirs(target)).toEqual([]);

    // SUCCESS.
    const good = await previewOf(app, archive);
    const succeeded = await applyRestoreRequest(app, {
      planId: good.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(succeeded.statusCode, succeeded.body).toBe(200);
    expect(await intakeDescriptors(), "a finished restore must not leak a descriptor").toBe(0);
    expect(await intakeWorkDirs(target)).toEqual([]);
  }, 600_000);

  // WHAT CI FOUND AND THE DEV SERVER HID. An aborted upload is a WRITE that was
  // admitted through the gate and may never produce a response -- so if the only
  // thing that decrements the in-flight count is the response, the count never
  // comes back and every later restore refuses to start with "requests were
  // still writing". Refusing forever is the safe direction of a leak and it is
  // still a denial of the one operation this whole phase exists for.
  //
  // THE DRAIN TIMEOUT IS SHORT HERE ON PURPOSE, so the case answers in
  // milliseconds either way: with the leak it is a 503 after 300ms, without it
  // the restore starts.
  itRestore("does not go on counting an upload the client abandoned", async () => {
    const source = await makeInstall("src");
    await seed(source, ["Northwind Traders"]);
    const target = await makeInstall("dst");
    const app = await appFor(target, { restoreDrainTimeoutMs: 300 });
    const archive = await realBackup(source, await scratchDir("archive"));

    const headers = await reauthed(app, chris, "restore-preview");
    const prologue = upload({ content: Buffer.alloc(0), passphrase: PASSPHRASE }).payload;
    const aborted = new Readable({
      read() {
        this.push(prologue.subarray(0, prologue.length - `--${BOUNDARY}--\r\n`.length));
        this.push(Buffer.alloc(256 * 1024, 3));
        this.destroy(new Error("the client went away"));
      },
    });
    await app.inject({
      method: "POST", url: "/api/restore/inspect",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
      payload: aborted,
    }).catch(() => undefined);

    const plan = await previewOf(app, archive);
    const response = await applyRestoreRequest(app, {
      planId: plan.planId, passphrase: PASSPHRASE, confirmName: target.name,
    });
    expect(response.body).not.toContain("restore_writes_in_flight");
    expect(response.statusCode, response.body).toBe(200);
  }, 300_000);

  // A SHUTDOWN WITH A PREVIEW STILL OPEN. What is in $data_dir at that moment
  // is a decrypted backup -- mail.key in the clear -- and the process must not
  // leave it there.
  itArchive("deletes a waiting preview's staging when the app closes", async () => {
    const source = await makeInstall("src");
    const target = await makeInstall("dst");
    const app = await appFor(target);
    const archive = await realBackup(source, await scratchDir("archive"));
    await previewOf(app, archive);
    expect(await intakeWorkDirs(target)).toHaveLength(1);
    await app.close();
    expect(await intakeWorkDirs(target)).toEqual([]);
  }, 180_000);
});
