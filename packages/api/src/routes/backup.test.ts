import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { TEST_DATABASE_URL } from "../test/global-setup.js";
import { buildApp } from "../app.js";
import { testReauthVerifier, reauthedHeaders } from "../test/reauth.js";
import { createCompany } from "../services/companies.js";
import { attachFile } from "../services/files.js";
import { saveBlob } from "../services/blobs.js";
import { resolveUser } from "../users.js";
import type { BackupManifest } from "../services/backup.js";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

// Same probe as services/backup.test.ts. 7z is an apt dependency of the app and
// present on the dev server and in CI; a developer on macOS gets a visible skip.
const HAVE_7Z = await (async () => {
  try {
    await execFileAsync("7z", ["i"]);
    return true;
  } catch {
    return false;
  }
})();
const it7z = HAVE_7Z ? it : it.skip;

const handle = openTestDatabase();

const PASSPHRASE = "correct horse battery staple";

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

let dataDir: string;
let scratch: string;
let actorId: string;
let config: Config;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, {
    username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-route-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-backup-route-out-"));
  await writeFile(path.join(dataDir, "mail.key"), Buffer.alloc(32, 7), { mode: 0o600 });
  config = {
    nodeEnv: "test",
    port: 0,
    // A REAL URL HERE, WHERE THE EXPORT'S ROUTE TEST USES A PLACEHOLDER: this
    // route is the one thing in the app that hands the connection string to a
    // separate process, so a placeholder would make every case below a
    // pg_dump failure.
    databaseUrl: TEST_DATABASE_URL,
    basePath: "/",
    version: "1.3.0-test",
    devUser: null,
    dataDir,
    defaultCurrency: "EUR",
    mailKeyPath: path.join(dataDir, "mail.key"),
    mailTlsRejectUnauthorized: true,
    // 7.6 Task 3's two config fields. No YunoHost portal exists here to bind
    // against and no fixed password is set either, so the default verifier is a
    // REAL one that cannot succeed -- a test that needs the re-authentication
    // gate to open hands buildApp its own. Nothing passes the gate by forgetting.
    ldapUrl: "ldap://127.0.0.1:389",
    reauthPassword: null,
  };
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

function app() {
  // THE RE-AUTHENTICATION GATE IS REAL IN THESE TESTS -- the same
  // fixed-password verifier a CI deployment uses, not a stub that agrees.
  // `post` below mints a ticket through POST /api/reauth for each request;
  // the tests that expect a refusal deliberately send none.
  return buildApp({ config, db: handle.db, dataDir, reauthVerifier: testReauthVerifier() });
}

/** Write a response body out and extract it with 7z, returning the root. */
async function extractResponse(name: string, body: Buffer): Promise<string> {
  const archivePath = path.join(scratch, `${name}.7z`);
  await writeFile(archivePath, body);
  const out = path.join(scratch, name);
  await execFileAsync("7z", ["x", `-p${PASSPHRASE}`, "-y", `-o${out}`, "--", archivePath]);
  return out;
}

/**
 * One backup request, carrying a freshly minted single-use ticket.
 *
 * `headers` is passed in by the ONE caller that needs two requests genuinely
 * concurrent: minting inside would put an await before the inject, and the
 * whole point there is that neither request has finished when the other
 * starts. Everywhere else the default is what the page does -- one
 * re-authentication, one archive.
 */
function post(
  a: Awaited<ReturnType<typeof app>>,
  passphrase: unknown = PASSPHRASE,
  headers?: Record<string, string>,
) {
  if (headers !== undefined) {
    return a.inject({ method: "POST", url: "/api/backup", headers, payload: { passphrase } });
  }
  return reauthedHeaders(a, authHeaders).then((fresh) =>
    a.inject({ method: "POST", url: "/api/backup", headers: fresh, payload: { passphrase } }));
}

describe("POST /api/backup", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await (await app()).inject({
      method: "POST", url: "/api/backup", payload: { passphrase: PASSPHRASE },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
  });

  // POST, NOT GET, AND THE ABSENCE OF A GET IS THE ASSERTION. A passphrase on a
  // GET would have to travel in the query string, where nginx writes it to the
  // access log verbatim and the browser keeps it in history. There must be no
  // way to ask for a backup that puts it there.
  it("has no GET, so a passphrase can never travel in a query string", async () => {
    const response = await (await app()).inject({
      method: "GET", url: `/api/backup?passphrase=${PASSPHRASE}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a missing or empty passphrase without echoing anything", async () => {
    const a = await app();
    for (const payload of [{}, { passphrase: "" }]) {
      // A ticket per attempt: the gate runs BEFORE the body is parsed and spends
      // the ticket, so a second attempt on the same one would 401 and this test
      // would stop asserting anything about validation at all.
      const response = await a.inject({
        method: "POST", url: "/api/backup",
        headers: await reauthedHeaders(a, authHeaders), payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: "validation" });
    }
    // And nothing was written for a request that never got past validation.
    expect((await readdir(dataDir)).filter((e) => e.startsWith(".backup-work-"))).toEqual([]);
  });

  it7z("answers a 7z with an attachment disposition, nosniff and a length", async () => {
    const response = await post(await app());
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-7z-compressed");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"])
      .toMatch(/^attachment; filename="conduit-backup-\d{4}-\d{2}-\d{2}\.7z"/);
    // A LENGTH, where the export deliberately has none: the archive is finished
    // before the response starts, so a short download is detectable as one.
    expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);
    // 7z's signature: "7z" then BC AF 27 1C. Whatever else is true, this is one.
    expect(response.rawPayload.subarray(0, 6))
      .toEqual(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  }, 120_000);

  it7z("downloads an archive that 7z opens with the passphrase, whole", async () => {
    const company = await createCompany(handle.db, actorId, { name: "M\u00FCller GmbH" });
    const content = Buffer.from("%PDF-1.7\nthe actual bytes\n");
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
    await attachFile(handle.db, actorId, {
      originalName: "Angebot-M\u00FCller.pdf", mime: "application/pdf", sizeBytes,
      sha256, companyId: company.id,
    });

    const response = await post(await app());
    expect(response.statusCode).toBe(200);

    const root = await extractResponse("download", response.rawPayload);
    expect((await readdir(root)).sort()).toEqual(["database.sql", "files", "mail.key", "manifest.json"]);
    // The blob's bytes, unchanged, through the whole HTTP path.
    expect(await readFile(path.join(root, "files", sha256))).toEqual(content);
    // mail.key, present -- the property this half exists for.
    expect(await readFile(path.join(root, "mail.key"))).toEqual(Buffer.alloc(32, 7));
    // The dump really is the database.
    expect(await readFile(path.join(root, "database.sql"), "utf8")).toContain("M\u00FCller GmbH");

    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as BackupManifest;
    // From config through CrmRouteDeps, not from a constant in the service.
    expect(manifest.appVersion).toBe("1.3.0-test");
    expect(manifest.kind).toBe("backup");
  }, 120_000);

  // THE TEMP FILE IS A CREDENTIAL STORE, and the removal is hung on the
  // stream's `close` rather than called by this route -- so it happens after
  // inject() has already resolved. Polled rather than slept on: if it never
  // happens this fails after five seconds instead of passing on a fast machine.
  it7z("leaves nothing behind in the data directory afterwards", async () => {
    const response = await post(await app());
    expect(response.statusCode).toBe(200);
    const deadline = Date.now() + 5_000;
    const left = async (): Promise<string[]> =>
      (await readdir(dataDir)).filter((e) => e.startsWith(".backup-work-"));
    while (Date.now() < deadline && (await left()).length > 0) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    }
    expect(await left()).toEqual([]);
  }, 120_000);

  // A BACKUP IS THE HEAVIEST THING THIS APP DOES, and the reason for the limit
  // is disk rather than the export's memory: two backups both pass a free-space
  // pre-flight that neither can see the other in, and then both fill it.
  it7z("refuses a second backup while one is running, and frees the slot after", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const content = Buffer.alloc(2 * 1024 * 1024, 9);
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
    await attachFile(handle.db, actorId, {
      originalName: "big.bin", mime: "application/octet-stream", sizeBytes, sha256,
      companyId: company.id,
    });

    const a = await app();
    // Started, then awaited: inject() resolves only once the whole body is
    // read, so awaiting the first would release its slot before the second ran.
    // Both tickets minted up front, so neither request waits on a round trip
    // the other could finish inside.
    const firstHeaders = await reauthedHeaders(a, authHeaders);
    const secondHeaders = await reauthedHeaders(a, authHeaders);
    const [one, two] = await Promise.all([
      post(a, PASSPHRASE, firstHeaders), post(a, PASSPHRASE, secondHeaders),
    ]);
    const statuses = [one.statusCode, two.statusCode].sort();
    expect(statuses).toEqual([200, 503]);
    const refused = one.statusCode === 503 ? one : two;
    expect(refused.json()).toMatchObject({ error: "backup_busy" });

    // THE SLOT COMES BACK. A guard that never releases turns one backup into a
    // permanently broken route -- which is worse than the problem it solves.
    //
    // Polled, because the release hangs off the response stream's `close` and
    // that fires a tick or two AFTER inject() has resolved: fastify has read
    // the last byte before the source stream finishes closing. A bare retry
    // here would be a flake in the other direction, so the deadline is what
    // makes this an assertion -- five seconds of 503s fails.
    const deadline = Date.now() + 5_000;
    let again = await post(a);
    while (again.statusCode === 503 && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      again = await post(a);
    }
    expect(again.statusCode).toBe(200);
  }, 180_000);

  // THE SLOT COMES BACK ON THE THROWING PATH TOO, which is the arm the export's
  // own guard needed and the one a happy-path test cannot reach.
  it7z("frees the slot when the build fails", async () => {
    const a = await app();
    await rm(path.join(dataDir, "mail.key"));
    const failed = await post(a);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: "backup_key_missing" });
    // The path is the server's business, not an authenticated client's.
    expect(JSON.stringify(failed.json())).not.toContain(dataDir);

    await writeFile(path.join(dataDir, "mail.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    expect((await post(a)).statusCode).toBe(200);
  }, 120_000);

  // THE PASSPHRASE MUST NOT REACH THE LOG, and "the logger is off in tests" is
  // not a proof of that -- so this one turns a real logger on and reads what it
  // wrote. Every other case in this file runs with config.nodeEnv "test", where
  // buildApp disables logging entirely.
  it7z("never writes the passphrase to the log", async () => {
    const lines: string[] = [];
    const marker = "PASSPHRASE-THAT-MUST-NOT-BE-LOGGED";
    const a = await buildApp({
      config: { ...config, nodeEnv: "development" },
      db: handle.db,
      dataDir,
      loggerStream: { write: (line: string) => { lines.push(line); } },
      reauthVerifier: testReauthVerifier(),
    });
    const response = await a.inject({
      method: "POST", url: "/api/backup",
      headers: await reauthedHeaders(a, authHeaders), payload: { passphrase: marker },
    });
    expect(response.statusCode).toBe(200);
    // The instrument, shown working: the logger really did capture this
    // request, so an empty transcript is not what makes the assertion pass.
    expect(lines.join("")).toContain("/api/backup");
    expect(lines.join("")).not.toContain(marker);
    // Nor in the response the browser gets.
    expect(response.headers["content-disposition"]).not.toContain(marker);
  }, 120_000);
});
