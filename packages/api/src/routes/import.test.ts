import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CsvMapping, PlanView } from "@conduit/shared";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { companies, contacts, users } from "../db/schema.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { HAVE_7Z } from "../test/archives.js";
import { reauthedHeaders, testReauthVerifier } from "../test/reauth.js";
import { resolveUser } from "../users.js";
import { createCompany } from "../services/companies.js";
import { createContact } from "../services/contacts.js";
import { INTAKE_WORK_PREFIX } from "../services/intake.js";

// THE ROUTES THAT DECIDE AN IMPORT MAY HAPPEN, AND THE FIVE DECISIONS
// routes/import.ts MAKES THAT NO ENGINE COULD.
//
// services/import-export.test.ts and services/import-csv.test.ts prove the two
// ENGINES: what a plan says, what apply writes, what is refused and why. None
// of that can be reached without a request, and this file is about the request
// -- who may make it, what a second one is told, what travels, what does not,
// and what happens to the staged upload on every way out.
//
// IT NEEDS 7z FOR HALF OF ITSELF. The exact importer reads a `.zip`, which
// services/intake.ts unpacks with the same `7z` an operator has; the CSV half
// stages verbatim and needs nothing. A developer without it sees a skip on the
// archive cases and a green run on the rest, which is the precedent
// services/backup.test.ts set.

const it7z = HAVE_7Z ? it : it.skip;

const handle = openTestDatabase();
const db = handle.db;

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "1.4.0-test",
  devUser: null,
  dataDir: "./data",
  defaultCurrency: "EUR",
  mailKeyPath: "unused-in-tests",
  mailTlsRejectUnauthorized: true,
  portalApiUrl: "http://127.0.0.1:6788",
  reauthPassword: null,
};

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

let dataDir: string;
let apps: FastifyInstance[] = [];
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(db, {
    username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  })).id;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-import-route-"));
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.close();
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

/**
 * Wipe the install the way an empty one is, keeping the operator's identity.
 *
 * A PLAIN DELETE WOULD NOT DO. `createCompany` stamps a timeline event that
 * references the row, so deleting companies on their own trips the foreign key;
 * truncating the schema is what an import onto a fresh install actually meets.
 * The operator's `users` row goes back under its ORIGINAL id, because the
 * export's owner columns point at it and the exact importer keeps an owner it
 * can still resolve.
 */
async function emptyInstallWithOperator(): Promise<void> {
  await truncateAll(handle);
  await db.insert(users).values({
    id: actorId, username: "chris", email: "chris@example.com", fullName: "Chris Wilson",
  });
}

async function appFor(options: { importMaxUploadBytes?: number } = {}) {
  const app = await buildApp({
    config, db, dataDir,
    reauthVerifier: testReauthVerifier(),
    importMaxUploadBytes: options.importMaxUploadBytes,
  });
  apps.push(app);
  return app;
}

/**
 * HOW MANY STAGED UPLOADS ARE STILL ON THE DISK.
 *
 * THE ROUTE-LEVEL HALF OF THE CREDENTIAL DISCIPLINE. services/intake.test.ts
 * and services/import-csv.test.ts count file DESCRIPTORS, which is the property
 * that a stream was closed; what a route can get wrong is different and coarser
 * -- an exit path that answers without disposing -- and it shows up as a
 * `.intake-work-` directory nobody owns. Every case below that produces a
 * refusal asserts this is zero afterwards.
 */
async function stagedDirectories(): Promise<string[]> {
  const entries = await readdir(dataDir);
  return entries.filter((name) => name.startsWith(INTAKE_WORK_PREFIX));
}

// --- HTTP ------------------------------------------------------------------

const BOUNDARY = "----conduit-import-route-test";

/**
 * A multipart body, built by hand.
 *
 * THE FIELDS COME FIRST, and that is routes/import.ts's documented contract
 * rather than this helper's taste: fastify-multipart is a streaming parser, so
 * a field declared after the file part has not been seen by the time
 * `request.file()` resolves. An in-process injection cannot actually exercise
 * that -- the whole body arrives in one chunk -- which is why the route says so
 * in its own words and why what is tested here is the refusal an ABSENT field
 * gets, which is the same refusal.
 */
function upload(options: {
  content: Buffer | string;
  fields?: Record<string, string>;
  filename?: string;
  fileField?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const { fields = {}, filename = "upload.zip", fileField = "file" } = options;
  const content = typeof options.content === "string"
    ? Buffer.from(options.content, "utf8")
    : options.content;
  const fieldParts = Object.entries(fields).map(([name, value]) => Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  ));
  const filePart = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fileField}"; `
      + `filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from("\r\n"),
  ];
  return {
    payload: Buffer.concat([...fieldParts, ...filePart, Buffer.from(`--${BOUNDARY}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/** The bytes GET /api/export answers with, through the real re-auth gate. */
async function exportArchive(app: FastifyInstance): Promise<Buffer> {
  const headers = await reauthedHeaders(app, chris);
  const response = await app.inject({ method: "GET", url: "/api/export", headers });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}

async function postUpload(
  app: FastifyInstance,
  url: string,
  body: ReturnType<typeof upload>,
  headers: Record<string, string> = chris,
) {
  return await app.inject({
    method: "POST", url,
    headers: { ...body.headers, ...headers },
    payload: body.payload,
  });
}

/** A CSV of contacts, with the header the mapping step will report. */
function contactsCsv(rows: readonly (readonly string[])[]): string {
  return ["First,Last,Email", ...rows.map((row) => row.join(","))].join("\r\n");
}

function digestOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** The whole mapping step, for a file whose columns this file already knows. */
async function mappingFor(app: FastifyInstance, csv: string, filename = "contacts.csv") {
  const response = await postUpload(
    app, "/api/import/csv/inspect", upload({ content: csv, filename }),
  );
  expect(response.statusCode).toBe(200);
  return response.json() as { mapping: { columns: { index: number }[]; refusal: unknown } };
}

/** Ask for a plan from a mapping, with the digest the mapping step reported. */
async function planCsv(
  app: FastifyInstance,
  csv: string,
  mapping: CsvMapping,
  overrides: {
    sha256?: string;
    filename?: string;
    headers?: Record<string, string>;
    /** Send the mapping with its `delimiter` stripped, as a client could. */
    omitDelimiter?: boolean;
  } = {},
) {
  const sent = overrides.omitDelimiter === true
    ? { ...mapping, delimiter: undefined }
    : mapping;
  return await postUpload(
    app,
    "/api/import/csv/plan",
    upload({
      content: csv,
      filename: overrides.filename ?? "contacts.csv",
      fields: { mapping: JSON.stringify(sent), sha256: overrides.sha256 ?? digestOf(csv) },
    }),
    overrides.headers ?? chris,
  );
}

/**
 * The three-column contact mapping every CSV case below uses.
 *
 * IT CARRIES A DELIMITER, because the plan route requires one. See the
 * "a mapping is a decision about a PARSE" case for why that field is not
 * optional, and `planCsv`'s `omitDelimiter` for how the refusal is exercised.
 */
const NAME_AND_EMAIL: CsvMapping = {
  delimiter: ",",
  entries: [
    { column: 0, field: "contact.first_name" },
    { column: 1, field: "contact.last_name" },
    { column: 2, field: "contact.email" },
  ],
};

// ---------------------------------------------------------------------------

describe("who may import", () => {
  it("REFUSES A CALLER WITH NO IDENTITY on every route in the family", async () => {
    const app = await appFor();
    const body = upload({ content: contactsCsv([["Ada", "Lovelace", "ada@example.com"]]) });
    const urls = [
      "/api/import/export/inspect", "/api/import/csv/inspect", "/api/import/csv/plan",
    ];
    for (const url of urls) {
      const response = await app.inject({
        method: "POST", url, headers: body.headers, payload: body.payload,
      });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: "unauthenticated" });
    }
    for (const url of ["/api/import/export/apply", "/api/import/csv/apply"]) {
      const response = await app.inject({
        method: "POST", url, payload: { planId: "00000000-0000-4000-8000-000000000000" },
      });
      expect(response.statusCode, url).toBe(401);
    }
    const cancel = await app.inject({
      method: "DELETE", url: "/api/import/00000000-0000-4000-8000-000000000000",
    });
    expect(cancel.statusCode).toBe(401);
    // NOTHING WAS STAGED BY A REQUEST THAT NEVER GOT PAST THE FIRST LINE.
    expect(await stagedDirectories()).toEqual([]);
  });

  /**
   * THE DECISION, AS AN ASSERTION RATHER THAN AS A COMMENT.
   *
   * routes/import.ts argues at length that an import is NOT behind the
   * re-authentication gate: it neither exfiltrates nor destroys, a fifth gated
   * route widens what one fungible ticket authorises, and three prompts to load
   * a spreadsheet teaches the reflex the gate exists to defeat. A decision
   * recorded only in prose is a decision the next `requireReauth` copy-paste
   * silently reverses, so this is the instrument: a session with NO TICKET AT
   * ALL gets a preview.
   *
   * IT IS SHOWN TO FAIL BY THE CASE ABOVE, which is the pair that makes it an
   * instrument rather than a tautology: strip the identity and the same request
   * is refused, so what this asserts is the absence of the TICKET requirement
   * and not the absence of authentication.
   */
  it("NEEDS NO RE-AUTHENTICATION TICKET, which is the decision and not an oversight", async () => {
    const app = await appFor();
    const response = await postUpload(
      app, "/api/import/csv/inspect",
      upload({ content: contactsCsv([["Ada", "Lovelace", "ada@example.com"]]) }),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { mapping: { columns: unknown[] } };
    expect(body.mapping.columns).toHaveLength(3);
  });

  it("binds a plan to the operator who uploaded it, and answers nobody else", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };

    // SAM CANNOT APPLY IT, and gets the same non-answer an unknown id gets --
    // a caller who learned that a plan exists but is not theirs would have
    // learned that somebody is mid-import and what their plan id is.
    const stolen = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: sam,
      payload: { planId: plan.planId },
    });
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json()).toMatchObject({ error: "import_plan_unknown" });

    // NOR CANCEL IT. Cancelling somebody else's import is a denial of service.
    const cancelled = await app.inject({
      method: "DELETE", url: `/api/import/${plan.planId}`, headers: sam,
    });
    expect(cancelled.statusCode).toBe(404);

    // AND THE OWNER STILL HAS IT.
    const mine = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(mine.statusCode).toBe(200);
  });

  /**
   * THE CASE THAT MAKES THE OWNER ARGUMENT AN INSTRUMENT, AND A MUTATION IS WHY
   * IT EXISTS.
   *
   * The apply route asks the store twice: `get` looks the session up without
   * taking it (so a wrong kind or an unknown id refuses without consuming a
   * preview), and `use` takes it. BOTH take the caller's identity. Replacing
   * either one's `user.username` with a constant left every case above green,
   * because they all run as the same person and the two refusals are
   * byte-for-byte identical: the store answers "no such plan" for an unknown
   * id, an expired one and somebody else's alike, deliberately, so nothing
   * outside can tell which layer refused.
   *
   * SO THE DISCRIMINATOR IS NOT A CROSS-OWNER REFUSAL BUT A SECOND PERSON'S
   * SUCCESS. Under a hard-coded owner, sam's own plan stops resolving for sam,
   * and this case goes red where none of the refusal cases can.
   *
   * AND THE PAIR CANNOT BE SPLIT FURTHER, said rather than left as a gap: for
   * the cross-owner request the two layers produce the same status and the same
   * body, which is IntakeSessionStore's own design ("a caller who learned that
   * a plan exists but is not theirs would have learned that somebody is
   * mid-import"). No test can say which of them fired, because the store exists
   * to make that unanswerable.
   */
  it("LETS A SECOND OPERATOR IMPORT THEIR OWN FILE, which is what proves the binding", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Grace", "Hopper", "grace@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL, { headers: sam });
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };

    const applied = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: sam,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(200);
    const rows = await db.select({ id: contacts.id }).from(contacts);
    expect(rows).toHaveLength(1);
  });

  it("RUNS ONE PLAN ONCE when two applies race for it", async () => {
    // `use` removes the session from the map BEFORE the work starts, so a
    // second apply of the same plan finds nothing to run. That branch answers
    // `outcome === undefined` and is the only thing standing between a slow
    // import and a double one -- and it is reachable only from a race, so it
    // needs a race rather than a comment.
    const app = await appFor();
    const csv = contactsCsv([
      ["Ada", "Lovelace", "ada@example.com"],
      ["Alan", "Turing", "alan@example.com"],
    ]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST", url: "/api/import/csv/apply", headers: chris,
        payload: { planId: plan.planId },
      }),
      app.inject({
        method: "POST", url: "/api/import/csv/apply", headers: chris,
        payload: { planId: plan.planId },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([200, 404]);

    // AND THE ROWS WENT IN ONCE. A second run of the same plan would have
    // inserted nothing (the duplicate probe would catch it) and thrown
    // ImportCsvChangedError, which would have rolled the FIRST one back too if
    // they had shared a transaction; they do not, and this is what says so.
    const rows = await db.select({ id: contacts.id }).from(contacts);
    expect(rows).toHaveLength(2);
  });
});

describe("what travels", () => {
  it("REFUSES AN APPLY THAT DESCRIBES THE WORK, rather than ignoring the description", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };

    // THE PLAN DOES NOT TRAVEL, and `strictObject` is what says so out loud. A
    // client that sent effects is TOLD the server does not read them; the
    // ordinary zod strip would have accepted this body and silently ignored the
    // half of it that mattered.
    const response = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: {
        planId: plan.planId,
        effects: [{ op: "insert-csv-contacts", subject: "contacts", count: 9999 }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation" });

    // AND NOTHING WAS APPLIED BY THE REFUSED REQUEST: the plan is still there.
    const retry = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(retry.statusCode).toBe(200);
  });

  it("answers a preview with a rendering that carries no paths and no refs", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const body = planned.json() as { plan: PlanView };
    // planView drops `sources`, which are object identities with no meaning
    // off-process and the only thing that would let a caller describe work.
    expect(JSON.stringify(body)).not.toContain(dataDir);
    expect(JSON.stringify(body)).not.toContain("sources");
    expect(body.plan.effects[0]?.op).toBe("insert-csv-contacts");
  });

  it("ROUTES ONLY THE EXACT PATHS THE PROXY MATCHES, so a trailing slash is a 404", async () => {
    // WHAT THIS IS REALLY ABOUT IS conf/nginx.conf, and a review is why it is
    // asserted here rather than assumed there. Every one of the five import
    // blocks -- and the restore's two -- is a `location =`, an EXACT match. If
    // Fastify were built with `ignoreTrailingSlash: true`, then
    // `/api/import/csv/inspect/` would reach this handler while matching NO
    // nginx block, so it would fall through to the app's own `location
    // __PATH__/`: 50M instead of 9g, 300s instead of an hour, and -- on the
    // restore preview, which is the one that matters -- REQUEST BUFFERING BACK
    // ON, which puts the archive passphrase into disk blocks. Every nginx test
    // in this repository would stay green through that change, because they all
    // read the config file and none of them reads the router.
    //
    // Fastify's default is `false` and app.ts does not set it, so what this
    // pins is a default the deployment depends on. `initialConfig` is Fastify's
    // own read-back of the options it booted with, which is the router's answer
    // rather than a grep of the source.
    const app = await appFor();
    expect(app.initialConfig.ignoreTrailingSlash ?? false).toBe(false);
    for (const url of [
      "/api/import/csv/inspect/", "/api/import/csv/plan/", "/api/import/export/inspect/",
      "/api/import/csv/apply/", "/api/import/export/apply/",
    ]) {
      const response = await app.inject({ method: "POST", url, headers: chris });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("has no GET that applies a plan or takes an upload", async () => {
    const app = await appFor();
    for (const url of [
      "/api/import/export/inspect", "/api/import/csv/inspect",
      "/api/import/csv/plan", "/api/import/csv/apply", "/api/import/export/apply",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: chris });
      // Fastify has no GET declared for any of these, so the router refuses
      // before any handler runs. What matters is that none of them ANSWERS.
      expect([404, 405], url).toContain(response.statusCode);
    }
  });
});

describe("one upload at a time, across all three pipelines", () => {
  it("REFUSES A SECOND UPLOAD WHILE A PLAN IS WAITING, and names no artefact", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    expect(planned.statusCode).toBe(200);

    // THE STORE IS ONE STORE. A CSV plan waiting refuses an EXPORT import and
    // a CSV mapping step, which is what "three pipelines, one slot" means in
    // practice and is the property a per-pipeline store would silently lose.
    for (const url of [
      "/api/import/csv/inspect", "/api/import/csv/plan", "/api/import/export/inspect",
    ]) {
      const response = await postUpload(app, url, upload({ content: csv }));
      expect(response.statusCode, url).toBe(409);
      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe("import_busy");
      // NAMES NO ARTEFACT. What is waiting may be a restore, an export import
      // or a spreadsheet, and a sentence that guessed would send an operator
      // hunting for a control that does not exist.
      expect(body.message).not.toContain("backup");
      expect(body.message).not.toContain("spreadsheet");
      expect(body.message).toContain("finish or cancel it first");
    }

    // AND A REFUSED SECOND UPLOAD LEFT NOTHING BEHIND: exactly the one staging
    // the held plan owns.
    expect(await stagedDirectories()).toHaveLength(1);
  });

  it("frees the slot on a cancel, and deletes the staged upload with it", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    expect(await stagedDirectories()).toHaveLength(1);

    const cancelled = await app.inject({
      method: "DELETE", url: `/api/import/${plan.planId}`, headers: chris,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(await stagedDirectories()).toEqual([]);

    // THE SLOT REALLY CAME BACK, which is what discriminates a freed store from
    // a page that merely stopped rendering the plan.
    const again = await postUpload(app, "/api/import/csv/inspect", upload({ content: csv }));
    expect(again.statusCode).toBe(200);

    // AND A SECOND CANCEL IS A 404 RATHER THAN A CRASH.
    const twice = await app.inject({
      method: "DELETE", url: `/api/import/${plan.planId}`, headers: chris,
    });
    expect(twice.statusCode).toBe(404);
  });
});

describe("the mapping step", () => {
  it("HOLDS NOTHING, which is this route's answer to the store question", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const response = await postUpload(app, "/api/import/csv/inspect", upload({ content: csv }));
    expect(response.statusCode).toBe(200);

    // THE STAGED FILE IS GONE BEFORE THE ANSWER WENT OUT, and the slot was
    // never taken -- so a person can read a column list for as long as they
    // like without refusing everybody else's restore.
    expect(await stagedDirectories()).toEqual([]);
    const second = await postUpload(app, "/api/import/csv/inspect", upload({ content: csv }));
    expect(second.statusCode).toBe(200);

    // AND THERE IS NO ID IN THE ANSWER, because there is nothing to address.
    expect(JSON.stringify(response.json())).not.toContain("planId");
  });

  it("reports the columns, their samples and what Conduit guessed", async () => {
    const app = await appFor();
    const csv = contactsCsv([
      ["Ada", "Lovelace", "ada@example.com"],
      ["Alan", "Turing", "alan@example.com"],
    ]);
    const { mapping } = await mappingFor(app, csv);
    const view = mapping as unknown as {
      columns: { index: number; header: string; samples: string[]; suggestion: string | null }[];
      targets: unknown[];
      sampled: number;
    };
    expect(view.columns.map((column) => column.header)).toEqual(["First", "Last", "Email"]);
    expect(view.columns[2]?.suggestion).toBe("contact.email");
    expect(view.columns[0]?.samples).toEqual(["Ada", "Alan"]);
    expect(view.sampled).toBe(2);
    // The picker's options come from the server rather than from a second list
    // the page keeps.
    expect(view.targets.length).toBeGreaterThan(0);
  });

  it("refuses a separator the reader cannot count fields on", async () => {
    const app = await appFor();
    const response = await postUpload(
      app, "/api/import/csv/inspect",
      upload({ content: "a\r\n1", fields: { delimiter: "x" } }),
    );
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain("comma");
    expect(await stagedDirectories()).toEqual([]);
  });

  it("REQUIRES THE DELIMITER, because a mapping is a decision about a PARSE", async () => {
    // THE HOLE THE DIGEST DOES NOT CLOSE, and this module's header used to
    // claim it did. The `sha256` pins the BYTES; it says nothing about how they
    // were split. With `delimiter` optional, planCsvImport fell back to
    // re-sniffing, so a mapping made at a semicolon-overridden mapping step and
    // sent without one was planned against a different parse of the same file.
    const app = await appFor();
    // MEASURED, AND CHOSEN FOR THE PROPERTY THAT MAKES IT INVISIBLE: this file
    // yields TWO columns under a comma AND under a semicolon, with entirely
    // different contents. csvMappingProblem(mapping, 2) returns null for both,
    // so neither side of the one shared rule can tell them apart.
    const csv = "Name;Town,Country\r\nAcme;Delft,NL\r\n";

    const sniffed = await postUpload(
      app, "/api/import/csv/inspect", upload({ content: csv, filename: "companies.csv" }),
    );
    const guess = (sniffed.json() as {
      mapping: { dialect: { delimiter: string; sniffed: boolean }; columns: unknown[] };
    }).mapping;
    // THE SNIFF GETS IT WRONG, which is the whole reason the operator can
    // overrule it -- and the whole reason the overrule must travel.
    expect(guess.dialect.delimiter).toBe(",");
    expect(guess.dialect.sniffed).toBe(true);
    expect(guess.columns).toHaveLength(2);

    const chosen = await postUpload(
      app, "/api/import/csv/inspect",
      upload({ content: csv, filename: "companies.csv", fields: { delimiter: ";" } }),
    );
    const semi = (chosen.json() as {
      mapping: { columns: { header: string }[]; dialect: { delimiter: string } };
    }).mapping;
    expect(semi.dialect.delimiter).toBe(";");
    // TWO COLUMNS EITHER WAY, and different ones. This is the assertion that
    // makes the rest of the case necessary rather than theoretical.
    expect(semi.columns.map((column) => column.header)).toEqual(["Name", "Town,Country"]);

    const asCompany: CsvMapping = {
      delimiter: ";",
      entries: [{ column: 0, field: "company.name" }],
    };

    // A CLIENT THAT LEAVES IT OUT IS TOLD, rather than silently re-sniffed.
    const without = await planCsv(app, csv, asCompany, { omitDelimiter: true });
    expect(without.statusCode).toBe(400);
    expect(without.json()).toMatchObject({ error: "validation" });
    expect((without.json() as { message: string }).message).toContain("separator");
    expect(await stagedDirectories()).toEqual([]);

    // AND WITH IT, THE OPERATOR'S PARSE IS WHAT RUNS. Under the sniffed comma
    // this company would have been created as "Acme;Delft" -- silently, behind
    // a preview that read perfectly.
    const planned = await planCsv(app, csv, asCompany);
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };
    const applied = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(200);
    const rows = await db.select({ name: companies.name }).from(companies);
    expect(rows).toEqual([{ name: "Acme" }]);
  });

  it("REFUSES A MAPPING BUILT AGAINST A DIFFERENT FILE, by the digest", async () => {
    // A mapping is a list of COLUMN POSITIONS, so applying one to a different
    // file with the same number of columns imports every value into the wrong
    // field with a preview that reads perfectly. csvMappingProblem cannot see
    // that -- it is pure, and both files have three columns.
    const app = await appFor();
    const mapped = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const other = "Email,First,Last\r\nada@example.com,Ada,Lovelace";
    const response = await planCsv(app, other, NAME_AND_EMAIL, { sha256: digestOf(mapped) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "import_csv_file_changed" });
    expect(await stagedDirectories()).toEqual([]);
  });

  it("requires the mapping and the digest, rather than treating an absent one as empty", async () => {
    // THE ASSERTION NAMES BOTH FIELDS, AND A MUTATION IS WHY. It used to be
    // `toContain("mapping")` against the no-fields case alone -- and deleting
    // the presence check entirely left it GREEN, because `JSON.parse(undefined)`
    // throws and the next refusal down says "the mapping field is not JSON",
    // which contains the word "mapping". A vacuous assertion is one that cannot
    // tell its own guard from the guard behind it.
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const noFields = await postUpload(
      app, "/api/import/csv/plan", upload({ content: csv }),
    );
    expect(noFields.statusCode).toBe(400);
    expect((noFields.json() as { message: string }).message).toContain("sha256");

    // AND THE DIGEST ON ITS OWN, which is the half no other case reaches: with
    // a mapping present and no digest, removing the check does not fall through
    // to a parse failure at all -- it falls through to the digest COMPARISON,
    // which answers 409 about a file that is perfectly correct.
    const noDigest = await postUpload(
      app, "/api/import/csv/plan",
      upload({ content: csv, fields: { mapping: JSON.stringify(NAME_AND_EMAIL) } }),
    );
    expect(noDigest.statusCode).toBe(400);
    expect((noDigest.json() as { error: string }).error).toBe("validation");

    const notJson = await postUpload(
      app, "/api/import/csv/plan",
      upload({ content: csv, fields: { mapping: "{not json", sha256: digestOf(csv) } }),
    );
    expect(notJson.statusCode).toBe(400);
    expect((notJson.json() as { message: string }).message).toContain("not JSON");
    expect(await stagedDirectories()).toEqual([]);
  });

  it("REFUSES A MAPPING CARRYING A FIELD IT DOES NOT READ, rather than stripping it", async () => {
    // `strictObject`, on routes/restore.ts's argument for the apply body: a
    // client that sent something this server does not read should be TOLD, not
    // have it silently ignored. Here it is sharper than on the apply, because
    // the mapping is the ONE value in the whole spine that travels and is acted
    // on -- a client sending a key this build does not know is a client and a
    // server disagreeing about what a mapping IS.
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const extra = await postUpload(
      app, "/api/import/csv/plan",
      upload({
        content: csv,
        fields: {
          mapping: JSON.stringify({ ...NAME_AND_EMAIL, skipRows: 3 }),
          sha256: digestOf(csv),
        },
      }),
    );
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: "validation" });

    // And inside one entry, where a stripped key would be a column mapped to
    // something nobody asked for.
    const entry = await postUpload(
      app, "/api/import/csv/plan",
      upload({
        content: csv,
        fields: {
          mapping: JSON.stringify({
            entries: [{ column: 0, field: "contact.first_name", transform: "upper" }],
          }),
          sha256: digestOf(csv),
        },
      }),
    );
    expect(entry.statusCode).toBe(400);
    expect(await stagedDirectories()).toEqual([]);
  });

  it("REFUSES AN ARRIVING MAPPING WITH csvMappingProblem'S OWN SENTENCE", async () => {
    // ONE RULE, BOTH SIDES. The page disables its Continue control on
    // csvMappingProblem and the server refuses a mapping that arrives anyway --
    // and what comes back is that function's sentence, unaltered, so the two
    // refusals read as one answer rather than as two phrasings of a rule.
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const bothEntities: CsvMapping = {
      delimiter: ",",
      entries: [
        { column: 0, field: "contact.first_name" },
        { column: 1, field: "company.name" },
      ],
    };
    const response = await planCsv(app, csv, bothEntities);
    expect(response.statusCode).toBe(200);
    const { plan } = response.json() as { plan: PlanView };
    expect(plan.refusal?.code).toBe("mapping-invalid");
    expect(plan.refusal?.message).toContain("both companies and contacts");
    expect(plan.effects).toHaveLength(0);
    // A REFUSAL IS NOT HELD, so the slot is free and the staging is gone.
    expect(await stagedDirectories()).toEqual([]);
  });

  it("refuses a mapping that points past the end of the header", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const response = await planCsv(app, csv, {
      delimiter: ",",
      entries: [
        { column: 0, field: "contact.first_name" },
        { column: 7, field: "contact.email" },
      ],
    });
    const { plan } = response.json() as { plan: PlanView };
    expect(plan.refusal?.message).toContain("column 7 is not one of this file's 3 columns");
  });
});

describe("the owner picker", () => {
  it("REFUSES AN OWNER THAT NAMES NOBODY, before it reads a byte of the file", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const response = await planCsv(app, csv, {
      ...NAME_AND_EMAIL, owner: "00000000-0000-4000-8000-000000000000",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "import_owner_unknown" });
    // BEFORE THE FILE: nothing was staged at all, which is the whole reason
    // this check is at the route rather than in a refusal plan.
    expect(await stagedDirectories()).toEqual([]);
  });

  it("names the chosen owner in the preview and writes it on every row", async () => {
    const app = await appFor();
    const csv = contactsCsv([
      ["Ada", "Lovelace", "ada@example.com"],
      ["Alan", "Turing", "alan@example.com"],
    ]);
    const planned = await planCsv(app, csv, { ...NAME_AND_EMAIL, owner: actorId });
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };
    // THE PREVIEW SAYS WHO, so an operator can check the picker before they
    // commit. A finding emitted only for the UNOWNED case would have left the
    // wrong-name mistake with nothing on screen to catch it.
    const owner = plan.findings.find((finding) => finding.code === "owner-unknown");
    expect(owner?.message).toContain("owned by chris");

    const applied = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(200);
    const rows = await db.select({ owner: contacts.ownerUserId }).from(contacts);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.owner === actorId)).toBe(true);
  });

  it("leaves rows unowned when nobody was chosen, and says so", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    const owner = plan.findings.find((finding) => finding.code === "owner-unknown");
    expect(owner?.message).toContain("arrive with no owner");

    await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    const rows = await db.select({ owner: contacts.ownerUserId }).from(contacts);
    expect(rows).toEqual([{ owner: null }]);
  });
});

describe("the world moving between preview and apply", () => {
  it("ANSWERS 409 AND SAYS THE MAPPING SURVIVED, for the foreign importer", async () => {
    const app = await appFor();
    const csv = contactsCsv([
      ["Ada", "Lovelace", "ada@example.com"],
      ["Alan", "Turing", "alan@example.com"],
    ]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    expect(plan.effects[0]?.count).toBe(2);

    // SOMEBODY ELSE CREATED ONE OF THEM WHILE THE OPERATOR READ THE PREVIEW.
    // The duplicate probe runs inside the transaction, so the count moves.
    await createContact(db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });

    const applied = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(409);
    const body = applied.json() as { error: string; message: string; imported: boolean };
    expect(body.error).toBe("import_csv_changed");
    expect(body.imported).toBe(false);
    // THE SENTENCE THE ENGINE WROTE FOR THIS MOMENT, echoed rather than
    // paraphrased: it is the one that says the column mapping is unaffected.
    expect(body.message).toContain("the column mapping is unaffected");

    // AND NOTHING WAS IMPORTED. One transaction, rolled back as a unit.
    const rows = await db.select({ id: contacts.id }).from(contacts);
    expect(rows).toHaveLength(1);
  });

  it7z("ANSWERS 409 WITH A DIFFERENT CODE for the exact importer", async () => {
    const app = await appFor();
    const seeded = await createCompany(db, actorId, { name: "Acme" });
    const archive = await exportArchive(app);
    await emptyInstallWithOperator();

    const planned = await postUpload(
      app, "/api/import/export/inspect",
      upload({ content: archive, filename: "conduit-export.zip" }),
    );
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };
    const companyEffect = plan.effects.find((effect) => effect.op === "insert-companies");
    expect(companyEffect?.count).toBe(1);

    // THE ROW CAME BACK UNDER ITS OWN ID while the operator read the preview --
    // somebody restored it, or a second import ran. The insert is
    // ON CONFLICT (id) DO NOTHING and counts what actually landed, so the count
    // moves and the whole import rolls back.
    await db.insert(companies).values({ id: seeded.id, name: "Acme" });

    const applied = await app.inject({
      method: "POST", url: "/api/import/export/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(409);
    const body = applied.json() as { error: string; message: string; imported: boolean };
    // A DIFFERENT CODE FROM THE FOREIGN IMPORTER'S, because the page does a
    // different thing with it: there is no mapping to keep, so the only way
    // forward is a fresh upload, and the engine's own sentence says exactly
    // that.
    expect(body.error).toBe("import_changed");
    expect(body.imported).toBe(false);
    expect(body.message).toContain("Upload the export again");
    expect(body.message).not.toContain("column mapping");
  });
});

describe("the exact importer", () => {
  it7z("SHOWS WHAT IT CANNOT IMPORT, sheet by sheet, in the preview", async () => {
    // THE LIMITATION HAS TO BE VISIBLE BEFORE THE IMPORT, not discovered in an
    // empty deals list afterwards. The engine emits one finding per sheet it
    // skipped, each naming the specific missing thing; this asserts the ROUTE
    // passes every one of them through to the rendering.
    const app = await appFor();
    await createCompany(db, actorId, { name: "Acme" });
    const archive = await exportArchive(app);
    await emptyInstallWithOperator();

    const response = await postUpload(
      app, "/api/import/export/inspect",
      upload({ content: archive, filename: "conduit-export.zip" }),
    );
    expect(response.statusCode).toBe(200);
    const { plan } = response.json() as { plan: PlanView };
    const skipped = plan.findings.filter(
      (finding) => finding.code === "sheet-not-imported",
    );
    // Seven sheets of nine are not imported, and each says which column it
    // could not fill. A count assertion alone would pass on seven copies of one
    // sentence, so the messages are checked for the specific gaps too.
    expect(skipped.length).toBeGreaterThanOrEqual(7);
    const all = skipped.map((finding) => finding.message).join(" ");
    for (const sheet of ["deals", "tasks", "projects", "notes", "meetings", "documents"]) {
      expect(all, `no finding names ${sheet}`).toContain(sheet);
    }
  });

  it7z("refuses a BACKUP uploaded to the import control", async () => {
    // THE ASYMMETRY, GUARDED FROM THIS SIDE. A backup carries mail bodies,
    // mail.key and every encrypted mail password, and an operator who typed a
    // passphrase into an importer has reached for the wrong control at the one
    // moment they needed the right one.
    const app = await appFor();
    const sevenZipMagic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0, 0, 0]);
    const response = await postUpload(
      app, "/api/import/export/inspect",
      upload({ content: sevenZipMagic, filename: "conduit-backup.7z" }),
    );
    // A `.7z` with no valid header is refused at the stage, which is the
    // cheapest place: nothing has been unpacked.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "import_file_refused" });
    expect(await stagedDirectories()).toEqual([]);
  });

  it7z("refuses a CSV uploaded to the exact importer's control", async () => {
    const app = await appFor();
    const response = await postUpload(
      app, "/api/import/export/inspect",
      upload({ content: contactsCsv([["Ada", "L", "a@example.com"]]), filename: "contacts.csv" }),
    );
    expect(response.statusCode).toBe(400);
    expect(await stagedDirectories()).toEqual([]);
  });

  it("refuses an ARCHIVE uploaded to the CSV control, naming the other two controls", async () => {
    const app = await appFor();
    const zipMagic = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64),
    ]);
    const response = await postUpload(
      app, "/api/import/csv/inspect",
      upload({ content: zipMagic, filename: "conduit-export.zip" }),
    );
    expect(response.statusCode).toBe(200);
    const { mapping } = response.json() as {
      mapping: { refusal: { code: string; message: string } | null };
    };
    expect(mapping.refusal?.code).toBe("not-a-csv");
    expect(mapping.refusal?.message).toContain("Restore");
    expect(await stagedDirectories()).toEqual([]);
  });

  it7z("imports a real export end to end, and skips what is already here", async () => {
    const app = await appFor();
    await createCompany(db, actorId, { name: "Acme", domain: "acme.com" });
    await createContact(db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });
    const archive = await exportArchive(app);

    const kept = await db.select({ id: companies.id }).from(companies);
    await emptyInstallWithOperator();

    const planned = await postUpload(
      app, "/api/import/export/inspect",
      upload({ content: archive, filename: "conduit-export.zip" }),
    );
    expect(planned.statusCode).toBe(200);
    const { plan } = planned.json() as { plan: PlanView };
    expect(plan.kind).toBe("import-export");
    expect(plan.effects.every((effect) => !effect.destroys)).toBe(true);

    const applied = await app.inject({
      method: "POST", url: "/api/import/export/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(applied.statusCode).toBe(200);
    const outcome = applied.json() as { imported: boolean; spent: number; message: string };
    expect(outcome.imported).toBe(true);
    expect(outcome.spent).toBe(2);

    // THE EXPORT'S OWN IDS ARE KEPT, which is what makes "is this row already
    // here?" an exact question the primary key answers.
    const back = await db.select({ id: companies.id }).from(companies);
    expect(back).toEqual(kept);

    // AND THE PLAN IS GONE: applied once, and the staging with it.
    expect(await stagedDirectories()).toEqual([]);
    const again = await app.inject({
      method: "POST", url: "/api/import/export/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(again.statusCode).toBe(404);
  });

  it7z("refuses a CSV plan id at the exact importer's apply, and the reverse", async () => {
    // THE STORE IS SHARED, so a plan of another kind reached through the wrong
    // apply is the same non-answer an unknown id gets. Without this check the
    // `as ImportPlan` below it would be hopeful rather than sound.
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };

    const wrongRoute = await app.inject({
      method: "POST", url: "/api/import/export/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(wrongRoute.statusCode).toBe(404);
    expect(wrongRoute.json()).toMatchObject({ error: "import_plan_unknown" });

    // AND THE PLAN SURVIVED THE WRONG ROUTE. A guard that consumed the session
    // before checking its kind would have destroyed a good preview.
    const rightRoute = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: plan.planId },
    });
    expect(rightRoute.statusCode).toBe(200);
  });

  it("refuses a plan id nothing answers to", async () => {
    const app = await appFor();
    const response = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("the upload, and the ways out of a request", () => {
  it("REFUSES A REQUEST THAT IS NOT MULTIPART AT ALL, without a lesson in the fields", async () => {
    const app = await appFor();
    for (const url of ["/api/import/export/inspect", "/api/import/csv/inspect"]) {
      const response = await app.inject({
        method: "POST", url, headers: chris, payload: { file: "hello" },
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({ error: "validation" });
    }
    expect(await stagedDirectories()).toEqual([]);
  });

  it("refuses a file part under the wrong field name", async () => {
    const app = await appFor();
    const response = await postUpload(
      app, "/api/import/csv/inspect",
      upload({ content: "a,b\r\n1,2", fileField: "upload" }),
    );
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('"file"');
    expect(await stagedDirectories()).toEqual([]);
  });

  it("REFUSES AN UPLOAD OVER THE CAP AS 413, and leaves nothing on the disk", async () => {
    // The bound is checked AFTER the stream has ended, exactly as
    // routes/files.ts checks its own: busboy stops feeding the stream and marks
    // it, having already written a PREFIX to disk. A prefix of a CSV is a
    // truncated file, and planning from it would report counts for half a
    // spreadsheet.
    const app = await appFor({ importMaxUploadBytes: 64 });
    const big = contactsCsv(
      Array.from({ length: 40 }, (_, at) => [`First${String(at)}`, "Last", `${String(at)}@x.com`]),
    );
    const response = await postUpload(app, "/api/import/csv/inspect", upload({ content: big }));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: "too_large" });
    expect(await stagedDirectories()).toEqual([]);
  });

  it("leaves nothing on the disk after a successful preview is cancelled", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    expect(await stagedDirectories()).toHaveLength(1);
    await app.inject({ method: "DELETE", url: `/api/import/${plan.planId}`, headers: chris });
    expect(await stagedDirectories()).toEqual([]);
  });

  it("leaves nothing on the disk after an apply, successful or refused", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);

    const first = await planCsv(app, csv, NAME_AND_EMAIL);
    const firstPlan = (first.json() as { plan: PlanView }).plan;
    await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: firstPlan.planId },
    });
    expect(await stagedDirectories()).toEqual([]);

    // AND ON THE REFUSED PATH. `use` disposes in a `finally`, so a throw from
    // apply deletes the staging on its way out -- which is the same reason the
    // page cannot offer a retry against a refused apply's plan id.
    //
    // THE ROW THE FIRST APPLY CREATED GOES FIRST, and the order is the whole
    // case rather than tidying up: planning against an install that already
    // holds Ada is planning nothing, and a refusal plan is not HELD -- so the
    // second apply would have answered 404 for a reason that has nothing to do
    // with what this asserts. (It did, before this line moved.) The import
    // writes no `events`, so the plain delete is enough here and the service
    // call below is what puts the row back with its timeline entry.
    await db.delete(contacts);
    const second = await planCsv(app, csv, NAME_AND_EMAIL);
    const secondPlan = (second.json() as { plan: PlanView }).plan;
    await createContact(db, actorId, { firstName: "Ada", emails: ["ada@example.com"] });
    const refused = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: secondPlan.planId },
    });
    expect(refused.statusCode).toBe(409);
    expect(await stagedDirectories()).toEqual([]);
  });

  it("refuses an apply of a plan id that is not a uuid", async () => {
    const app = await appFor();
    const response = await app.inject({
      method: "POST", url: "/api/import/csv/apply", headers: chris,
      payload: { planId: "not-a-uuid" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain("plan id");
  });
});

describe("an import is additive, and the page has to be able to say so", () => {
  it("plans nothing that destroys, on either importer", async () => {
    const app = await appFor();
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    expect(plan.effects).not.toHaveLength(0);
    expect(plan.effects.some((effect) => effect.destroys)).toBe(false);
  });

  it("LEAVES A ROW THAT IS ALREADY HERE EXACTLY AS IT IS", async () => {
    const app = await appFor();
    const existing = await createContact(db, actorId, {
      firstName: "Ada", lastName: "Byron", emails: ["ada@example.com"],
    });
    const csv = contactsCsv([["Ada", "Lovelace", "ada@example.com"]]);
    const planned = await planCsv(app, csv, NAME_AND_EMAIL);
    const { plan } = planned.json() as { plan: PlanView };
    // Every row is a duplicate, so there is nothing to add and the plan says
    // so rather than offering an import that would do nothing.
    expect(plan.refusal?.code).toBe("nothing-to-import");

    const row = await db.select().from(contacts).where(eq(contacts.id, existing.id));
    expect(row[0]?.lastName).toBe("Byron");
  });
});
