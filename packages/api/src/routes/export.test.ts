import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
import { createCompany } from "../services/companies.js";
import { attachFile } from "../services/files.js";
import { saveBlob } from "../services/blobs.js";
import { resolveUser } from "../users.js";
import type { ExportManifest } from "../services/export.js";
import type { Config } from "../config.js";
import { testReauthVerifier, reauthedHeaders } from "../test/reauth.js";

const execFileAsync = promisify(execFile);

// Same probe as services/export.test.ts, and for the same reason: the archive's
// only interesting property is that somebody else's software opens it.
const HAVE_UNZIP = await (async () => {
  try {
    await execFileAsync("unzip", ["-v"]);
    return true;
  } catch {
    return false;
  }
})();
const itZip = HAVE_UNZIP ? it : it.skip;

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "1.3.0-test",
  devUser: null,
  dataDir: "./data",
  defaultCurrency: "EUR",
  mailKeyPath: "unused-in-tests",
  mailTlsRejectUnauthorized: true,
  // 7.6 Task 3's two config fields. No YunoHost portal exists here to bind
  // against and no fixed password is set either, so the default verifier is a
  // REAL one that cannot succeed -- a test that needs the re-authentication
  // gate to open hands buildApp its own. Nothing passes the gate by forgetting.
  ldapUrl: "ldap://127.0.0.1:389",
  reauthPassword: null,
  // No app registration: these tests build an app, never an OAuth account.
  mailOAuth: { microsoft: null, google: null },
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

let dataDir: string;
let scratch: string;
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  // Resolved here as well as by the app's own auth hook: a test that seeds rows
  // before it makes a request needs an owner, and both paths have to land on
  // the same `users` row (resolveUser is an upsert on username).
  actorId = (await resolveUser(handle.db, {
    username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-export-route-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-export-route-out-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

function app() {
  // THE RE-AUTHENTICATION GATE IS REAL IN THESE TESTS. Every request below
  // that expects an archive first mints a ticket through POST /api/reauth
  // with the right password (reauthedHeaders); the ones that expect a refusal
  // deliberately do not. See test/reauth.ts for why the verifier is the real
  // fixed-password one rather than a function that always agrees.
  return buildApp({ config, db: handle.db, dataDir, reauthVerifier: testReauthVerifier() });
}

/** Write one response body out and extract it, returning the extraction root. */
async function extractResponse(name: string, body: Buffer): Promise<string> {
  const zipPath = path.join(scratch, `${name}.zip`);
  await writeFile(zipPath, body);
  const out = path.join(scratch, name);
  await execFileAsync("unzip", ["-qq", "-o", zipPath, "-d", out]);
  return out;
}

describe("GET /api/export", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await (await app()).inject({ method: "GET", url: "/api/export" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("answers a zip with an attachment disposition and nosniff", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/export", headers: await reauthedHeaders(a, authHeaders, "export"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"])
      .toMatch(/^attachment; filename="conduit-export-\d{4}-\d{2}-\d{2}\.zip"/);
    // The zip local file header. Whatever else is true, the body is an archive.
    expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  itZip("downloads an archive whose members open and whose bytes are intact", async () => {
    const company = await createCompany(handle.db, actorId, { name: "M\u00FCller GmbH" });
    const content = Buffer.from("%PDF-1.7\nthe actual bytes\n");
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
    await attachFile(handle.db, actorId, {
      originalName: "Angebot-M\u00FCller.pdf", mime: "application/pdf", sizeBytes, sha256, companyId: company.id,
    });

    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/export", headers: await reauthedHeaders(a, authHeaders, "export"),
    });
    expect(response.statusCode).toBe(200);

    const root = await extractResponse("download", response.rawPayload);
    expect((await readdir(root)).sort()).toEqual([
      "companies.csv", "contacts.csv", "deals.csv", "documents.csv", "files",
      "files.csv", "manifest.json", "meetings.csv", "notes.csv", "projects.csv", "tasks.csv",
    ]);

    // The bytes, unchanged, through the whole HTTP path.
    expect(await readFile(path.join(root, "files", "Angebot-M\u00FCller.pdf"))).toEqual(content);
    expect(await readFile(path.join(root, "companies.csv"), "utf8")).toContain("M\u00FCller GmbH");

    // The manifest names the version this route was told to record, which comes
    // from config through CrmRouteDeps rather than from a constant in the
    // export service.
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as ExportManifest;
    expect(manifest.appVersion).toBe("1.3.0-test");
  });

  // THE MOST EXPENSIVE ENDPOINT IN THE APP HAD NO LIMIT ON IT. An export
  // materialises its largest CSV whole and reads the blob store end to end;
  // nothing stopped any authenticated caller from starting ten at once, on a
  // 3.8GB no-swap box, which multiplies the one bound buildExport works hardest
  // to hold. There is no role model here, so "any authenticated caller" is
  // every user.
  itZip("refuses a second export while one is still streaming, and frees the slot after", async () => {
    await createCompany(handle.db, actorId, { name: "Acme" });
    const content = Buffer.alloc(2 * 1024 * 1024, 9);
    const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
    await attachFile(handle.db, actorId, {
      originalName: "big.bin", mime: "application/octet-stream", sizeBytes, sha256,
      companyId: (await createCompany(handle.db, actorId, { name: "Holder" })).id,
    });

    const a = await app();
    // inject() resolves only once the whole body is read, so the two requests
    // are started and only then awaited -- otherwise the first has finished and
    // released its slot before the second is made.
    // Two tickets, minted up front. A ticket is spent by the request that
    // carries it, so the two concurrent requests cannot share one -- and the
    // minting has to happen before either starts, or awaiting it would let the
    // first export finish and release its slot.
    const firstHeaders = await reauthedHeaders(a, authHeaders, "export");
    const secondHeaders = await reauthedHeaders(a, authHeaders, "export");
    const first = a.inject({ method: "GET", url: "/api/export", headers: firstHeaders });
    const second = a.inject({ method: "GET", url: "/api/export", headers: secondHeaders });
    const [one, two] = await Promise.all([first, second]);

    const statuses = [one.statusCode, two.statusCode].sort();
    expect(statuses).toEqual([200, 503]);
    const refused = one.statusCode === 503 ? one : two;
    expect(refused.json()).toMatchObject({ error: "export_busy" });

    // THE SLOT COMES BACK. A guard that never releases turns one export into a
    // permanently broken route, which is worse than the problem it solves.
    const afterwards = await a.inject({
      method: "GET", url: "/api/export", headers: await reauthedHeaders(a, authHeaders, "export"),
    });
    expect(afterwards.statusCode).toBe(200);
  });

  // Conduit has no role model, so this route is no broader than the list
  // endpoints it summarises -- and that fact is worth pinning, because a future
  // reader will ask.
  itZip("gives a second authenticated user the same whole-database archive", async () => {
    await createCompany(handle.db, actorId, { name: "Acme" });
    const a = await app();
    const samHeaders = {
      "ynh-user": "sam", "ynh-user-email": "sam@example.com", "ynh-user-fullname": "Sam",
    };
    const theirs = await a.inject({
      method: "GET", url: "/api/export", headers: await reauthedHeaders(a, samHeaders, "export"),
    });
    expect(theirs.statusCode).toBe(200);
    const root = await extractResponse("theirs", theirs.rawPayload);
    expect(await readFile(path.join(root, "companies.csv"), "utf8")).toContain("Acme");
  });
});
