import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  companySchema, contactSchema, noteSchema, fileMetaSchema, eventSchema,
  errorResponseSchema, listResponseSchema, searchResultsSchema,
  pipelineSchema, pipelineWithStagesSchema, stageSchema, dealSchema, funnelRowSchema,
  projectSchema, taskSchema, taskDependencySchema, shiftResultSchema, ganttPayloadSchema,
  meetingSchema, meetingDetailSchema, documentSchema, orgProfileSchema,
  documentTemplateSchema, CONTACT_FIELD_CAPS, DOCUMENT_MAX_DESCRIPTION_CHARS,
  DOCUMENT_MAX_LINES, MAX_TEMPLATE_BYTES,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import { seededQuoteTemplate } from "../test/seed-template.js";
import { buildApp, type BuildAppOptions } from "../app.js";
import { listFiles } from "../services/files.js";
import { listEvents } from "../services/timeline.js";
import { resolveUser } from "../users.js";
import { todayDateOnly, addDays } from "../services/scheduling.js";
import { documentTemplates, files } from "../db/schema.js";
import type { Config } from "../config.js";

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
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
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

let dataDir: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-routes-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(async () => {
  await handle.close();
});

async function app(overrides: Partial<Omit<BuildAppOptions, "config" | "db" | "dataDir">> = {}) {
  return buildApp({ config, db: handle.db, dataDir, ...overrides });
}

describe("companies routes", () => {
  it("creates a company and returns 201 with a contract-shaped body", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders,
      payload: { name: "Acme" },
    });
    expect(response.statusCode).toBe(201);
    const body = companySchema.parse(response.json());
    expect(body.name).toBe("Acme");
    await a.close();
  });

  it("lists companies filtered by q", async () => {
    const a = await app();
    await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });
    await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Globex" } });

    const response = await a.inject({ method: "GET", url: "/api/companies?q=acme", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(companySchema).parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe("Acme");
    await a.close();
  });

  it("returns 404 for an unknown company id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/companies/3f2504e0-4f89-41d3-9a0c-0305e82c3301", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("not_found");
    await a.close();
  });

  it("returns 409 when patching an archived company", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const id = created.json().id as string;
    await a.inject({ method: "POST", url: `/api/companies/${id}/archive`, headers: authHeaders });

    const response = await a.inject({
      method: "PATCH", url: `/api/companies/${id}`, headers: authHeaders, payload: { name: "New" },
    });
    expect(response.statusCode).toBe(409);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("archived");
    await a.close();
  });

  it("excludes an archived company from the default list", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const id = created.json().id as string;
    await a.inject({ method: "POST", url: `/api/companies/${id}/archive`, headers: authHeaders });

    const response = await a.inject({ method: "GET", url: "/api/companies", headers: authHeaders });
    const body = listResponseSchema(companySchema).parse(response.json());
    expect(body.items.find((c) => c.id === id)).toBeUndefined();
    await a.close();
  });

  it("returns 400 with 'invalid cursor' for a cursor that fails to decode", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/companies?cursor=not-valid-base64url-json", headers: authHeaders,
    });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("validation");
    expect(body.message).toBe("invalid cursor");
    await a.close();
  });

  it("returns 401 without an identity header", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: "/api/companies" });
    expect(response.statusCode).toBe(401);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("unauthenticated");
    await a.close();
  });
});

describe("contacts routes", () => {
  it("creates a contact attached to a company", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const response = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders,
      payload: { firstName: "Ada", companyId },
    });
    expect(response.statusCode).toBe(201);
    const body = contactSchema.parse(response.json());
    expect(body.companyId).toBe(companyId);
    await a.close();
  });

  it("lists contacts filtered by company_id", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;
    await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Ada", companyId },
    });
    await a.inject({ method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Grace" } });

    const response = await a.inject({
      method: "GET", url: `/api/contacts?company_id=${companyId}`, headers: authHeaders,
    });
    const body = listResponseSchema(contactSchema).parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.firstName).toBe("Ada");
    await a.close();
  });

  it("returns 400 validation for a malformed email", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders,
      payload: { firstName: "Ada", emails: ["not-an-email"] },
    });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("validation");
    await a.close();
  });

  // v1.1.0's two fields, over the wire: POST them, PATCH one, clear both. The
  // response is parsed by contactSchema, so a column the DTO forgot to carry would
  // fail here rather than showing up as a blank field on the detail page.
  it("round-trips a salutation and pronouns, and clears them with null", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders,
      payload: { firstName: "Ada", salutation: "Dr", pronouns: "she/her" },
    });
    expect(created.statusCode).toBe(201);
    const contact = contactSchema.parse(created.json());
    expect(contact).toMatchObject({ salutation: "Dr", pronouns: "she/her" });

    const patched = await a.inject({
      method: "PATCH", url: `/api/contacts/${contact.id}`, headers: authHeaders,
      payload: { salutation: "Prof" },
    });
    // The pronouns are UNTOUCHED by a patch that names only the salutation --
    // nothing here derives one from the other.
    expect(contactSchema.parse(patched.json())).toMatchObject({
      salutation: "Prof", pronouns: "she/her",
    });

    const cleared = await a.inject({
      method: "PATCH", url: `/api/contacts/${contact.id}`, headers: authHeaders,
      payload: { salutation: null, pronouns: null },
    });
    expect(contactSchema.parse(cleared.json())).toMatchObject({
      salutation: null, pronouns: null,
    });
    await a.close();
  });

  // The gate, at the layer that answers the form: a 400 naming the field, not a
  // 23514 from the CHECK behind it. The two bounds are the same number, so the
  // message is what says which one was hit.
  it("returns 400 naming the field for a salutation or pronouns past the cap", async () => {
    const a = await app();
    const past = "x".repeat(CONTACT_FIELD_CAPS.salutation + 1);
    for (const [field, word] of [["salutation", "salutation"], ["pronouns", "pronouns"]] as const) {
      const response = await a.inject({
        method: "POST", url: "/api/contacts", headers: authHeaders,
        payload: { firstName: "Ada", [field]: past },
      });
      expect(response.statusCode).toBe(400);
      const body = errorResponseSchema.parse(response.json());
      expect(body.error).toBe("validation");
      expect(body.message).toContain(word);
    }

    // ...and one character less is stored, so the bound is the cap and not one off it.
    const ok = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders,
      payload: { firstName: "Ada", salutation: past.slice(1), pronouns: past.slice(1) },
    });
    expect(ok.statusCode).toBe(201);
    expect(contactSchema.parse(ok.json()).salutation).toHaveLength(CONTACT_FIELD_CAPS.salutation);
    await a.close();
  });
});

describe("notes routes", () => {
  it("creates a note on a contact and returns 201", async () => {
    const a = await app();
    const contact = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Ada" },
    });
    const contactId = contact.json().id as string;

    const response = await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders,
      payload: { body: "Called about renewal", contactId },
    });
    expect(response.statusCode).toBe(201);
    const body = noteSchema.parse(response.json());
    expect(body.contactId).toBe(contactId);
    await a.close();
  });

  it("returns 400 when both companyId and contactId are supplied", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const contact = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Ada" },
    });

    const response = await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders,
      payload: { body: "x", companyId: company.json().id, contactId: contact.json().id },
    });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("validation");
    await a.close();
  });

  // See notes.ts's listQuerySchema comment: unlike files/events, GET /api/notes
  // requires exactly one of company_id/contact_id/deal_id -- there is no
  // "everything" notes list.
  it("GET requires exactly one of company_id, contact_id or deal_id", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const contact = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Ada" },
    });
    const companyId = company.json().id as string;
    const contactId = contact.json().id as string;

    const neither = await a.inject({ method: "GET", url: "/api/notes", headers: authHeaders });
    expect(neither.statusCode).toBe(400);
    expect(errorResponseSchema.parse(neither.json()).error).toBe("validation");

    const both = await a.inject({
      method: "GET", url: `/api/notes?company_id=${companyId}&contact_id=${contactId}`, headers: authHeaders,
    });
    expect(both.statusCode).toBe(400);
    expect(errorResponseSchema.parse(both.json()).error).toBe("validation");

    await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders, payload: { body: "hi", companyId },
    });
    const one = await a.inject({
      method: "GET", url: `/api/notes?company_id=${companyId}`, headers: authHeaders,
    });
    expect(one.statusCode).toBe(200);
    expect(z.array(noteSchema).parse(one.json())).toHaveLength(1);
    await a.close();
  });

  it("creates a note on a deal and filters GET by deal_id", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id);

    const response = await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders,
      payload: { body: "checking in", dealId: deal.id },
    });
    expect(response.statusCode).toBe(201);
    const body = noteSchema.parse(response.json());
    expect(body.dealId).toBe(deal.id);

    const listed = await a.inject({
      method: "GET", url: `/api/notes?deal_id=${deal.id}`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(z.array(noteSchema).parse(listed.json()).map((n) => n.id)).toEqual([body.id]);

    const both = await a.inject({
      method: "GET", url: `/api/notes?deal_id=${deal.id}&company_id=${pipeline.id}`, headers: authHeaders,
    });
    expect(both.statusCode).toBe(400);
    await a.close();
  });

  it("creates a note on a project and filters GET by project_id", async () => {
    const a = await app();
    const project = await makeProject(a);

    const response = await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders,
      payload: { body: "kickoff notes", projectId: project.id },
    });
    expect(response.statusCode).toBe(201);
    const body = noteSchema.parse(response.json());
    expect(body.projectId).toBe(project.id);

    const listed = await a.inject({
      method: "GET", url: `/api/notes?project_id=${project.id}`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(z.array(noteSchema).parse(listed.json()).map((n) => n.id)).toEqual([body.id]);
    await a.close();
  });

  it("returns a 409 conflict body creating a note on an archived project", async () => {
    const a = await app();
    const project = await makeProject(a);
    await a.inject({ method: "POST", url: `/api/projects/${project.id}/archive`, headers: authHeaders });

    const response = await a.inject({
      method: "POST", url: "/api/notes", headers: authHeaders,
      payload: { body: "too late", projectId: project.id },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });
});

/** Hand-build a multipart/form-data body. Fields must precede the file part -- see
 * routes/files.ts's fieldValue comment for why. */
function buildMultipart(fields: Record<string, string>, file: { name: string; content: string; mime: string }): { body: string; boundary: string } {
  const boundary = "----conduitTestBoundary1234567890";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.mime}\r\n\r\n${file.content}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(""), boundary };
}

describe("files routes", () => {
  it("round-trips a multipart upload through download", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const { body, boundary } = buildMultipart(
      { companyId },
      { name: "hello.txt", content: "hello world", mime: "text/plain" },
    );
    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    expect(meta.companyId).toBe(companyId);
    expect(meta.originalName).toBe("hello.txt");
    // Storage-leg coverage: part.mimetype (the real, harmless mime a genuine
    // upload declares) must reach the files row unmangled -- the deny-mime
    // table below only ever seeds a stored mime directly via db.update, so
    // without this assertion nothing exercises POST's own write of
    // part.mimetype into the row at all.
    expect(meta.mime).toBe("text/plain");

    const download = await a.inject({
      method: "GET", url: `/api/files/${meta.id}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello world");
    expect(download.headers["content-type"]).toBe("text/plain");
    expect(download.headers["content-disposition"])
      .toBe(`attachment; filename="hello.txt"; filename*=UTF-8''hello.txt`);
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["content-length"]).toBe(String(Buffer.byteLength("hello world", "utf8")));
    await a.close();
  });

  // mailparser's non-Latin-filename problem (see mail.test.ts) applies here too:
  // Node refuses to put any code point above U+00FF in a header value at all
  // (ERR_INVALID_CHAR, a 500 rather than a download), so this exercises the
  // shared contentDisposition helper's RFC 5987 form via a genuine upload.
  // U+8ACB U+6C42 U+66F8 is "invoice" in Chinese; sent through the extended
  // filename*=UTF-8''percent-encoded-value form (real UTF-8 bytes on the wire
  // would break the multipart header line itself), and the percent-encoding
  // below is written out literally rather than recomputed, so this asserts the
  // real bytes -- same technique the hostile-filename test below already uses.
  it("downloads a non-Latin filename with both an ASCII fallback and the RFC 5987 form", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const filename = `${String.fromCharCode(0x8acb, 0x6c42, 0x66f8)}.pdf`;
    const boundary = "----conduitCjkBoundary1234567890";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${companyId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodeURIComponent(filename)}\r\n` +
      `Content-Type: application/pdf\r\n\r\npdf bytes\r\n` +
      `--${boundary}--\r\n`;

    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    expect(meta.originalName).toBe(filename);

    const download = await a.inject({
      method: "GET", url: `/api/files/${meta.id}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    const disposition = download.headers["content-disposition"];
    expect(disposition).toBe(`attachment; filename="___.pdf"; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf`);
    // The header value itself must be transmittable: pure ASCII, no raw
    // Unicode anywhere in it.
    expect(disposition).toMatch(/^[\x20-\x7E]*$/);
    expect(download.body).toBe("pdf bytes");
    await a.close();
  });

  // A hostile declared content type must never come back as the response's
  // DECLARED Content-Type, even under an attachment disposition -- see
  // files.ts's isDownloadDeniedMime comment for why nosniff alone is not
  // enough. Table-driven over the deny list, its edge cases, and one control.
  //
  // Each case creates a file through a REAL upload (so it gets a genuine row,
  // actor, blob, etc.) and then overwrites the stored mime column directly.
  // That -- rather than trying to coax a particular byte sequence out of a
  // hand-built multipart Content-Type header -- is what guarantees the exact
  // stored value under test: whatever the upload path does or does not trim
  // on the way in, the route's own normalize-then-deny step is what this
  // test exists to pin down, so it drives that step from a stored value it
  // fully controls.
  it.each([
    // Bare denylist entries.
    { label: "text/html", stored: "text/html", expected: "application/octet-stream" },
    { label: "text/xml", stored: "text/xml", expected: "application/octet-stream" },
    { label: "application/xml", stored: "application/xml", expected: "application/octet-stream" },
    { label: "text/xsl", stored: "text/xsl", expected: "application/octet-stream" },
    { label: "multipart/x-mixed-replace", stored: "multipart/x-mixed-replace", expected: "application/octet-stream" },
    // Named +xml family members.
    { label: "image/svg+xml", stored: "image/svg+xml", expected: "application/octet-stream" },
    { label: "application/xhtml+xml", stored: "application/xhtml+xml", expected: "application/octet-stream" },
    // A +xml member the list never names explicitly -- caught only because
    // the rule closes the whole suffix family, not a list of names.
    { label: "application/rss+xml (unlisted +xml family member)", stored: "application/rss+xml", expected: "application/octet-stream" },
    // Leading whitespace must not bypass the check: a browser trims OWS
    // before parsing a declared Content-Type, so a stored " text/html" is
    // exactly as dangerous as "text/html" and must be caught the same way.
    { label: "leading-whitespace bypass attempt", stored: " text/html", expected: "application/octet-stream" },
    // MIME tokens are case insensitive (RFC 2045); the regex is lowercase
    // literals, so the comparison must lowercase first rather than miss this.
    { label: "mixed-case bypass attempt", stored: "TEXT/HTML", expected: "application/octet-stream" },
    // Control: a legitimate, harmless declared type must be left alone.
    { label: "application/pdf (control, not denied)", stored: "application/pdf", expected: "application/pdf" },
  ])("download denylist: $label", async ({ stored, expected }) => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const { body, boundary } = buildMultipart(
      { companyId },
      { name: "payload.bin", content: "bytes", mime: "application/octet-stream" },
    );
    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    await handle.db.update(files).set({ mime: stored }).where(eq(files.id, meta.id));

    const download = await a.inject({
      method: "GET", url: `/api/files/${meta.id}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe(expected);
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    await a.close();
  });

  it("returns 400 when neither companyId nor contactId is supplied", async () => {
    const a = await app();
    const { body, boundary } = buildMultipart({}, { name: "x.txt", content: "x", mime: "text/plain" });
    const response = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error).toBe("validation");
    await a.close();
  });

  it("uploads a file to a deal and filters GET by deal_id", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id);

    const { body, boundary } = buildMultipart(
      { dealId: deal.id },
      { name: "contract.pdf", content: "pdf bytes", mime: "application/pdf" },
    );
    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    expect(meta.dealId).toBe(deal.id);

    const listed = await a.inject({
      method: "GET", url: `/api/files?deal_id=${deal.id}`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(z.array(fileMetaSchema).parse(listed.json()).map((f) => f.id)).toEqual([meta.id]);
    await a.close();
  });

  it("uploads a file to a project and filters GET by project_id", async () => {
    const a = await app();
    const project = await makeProject(a);

    const { body, boundary } = buildMultipart(
      { projectId: project.id },
      { name: "spec.pdf", content: "spec bytes", mime: "application/pdf" },
    );
    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    expect(meta.projectId).toBe(project.id);

    const listed = await a.inject({
      method: "GET", url: `/api/files?project_id=${project.id}`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(z.array(fileMetaSchema).parse(listed.json()).map((f) => f.id)).toEqual([meta.id]);
    await a.close();
  });

  it("returns a 409 conflict body uploading a file to an archived project", async () => {
    const a = await app();
    const project = await makeProject(a);
    await a.inject({ method: "POST", url: `/api/projects/${project.id}/archive`, headers: authHeaders });

    const { body, boundary } = buildMultipart(
      { projectId: project.id },
      { name: "late.txt", content: "x", mime: "text/plain" },
    );
    const response = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });

  it("returns 404 downloading an unknown file id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/download", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("not_found");
    await a.close();
  });

  // multipartFileSizeLimit is a test-only override (see BuildAppOptions/CrmRouteDeps)
  // so this can exercise the 413/truncated path with a few KB instead of 50MB.
  it("returns 413 without creating a file row or event when the upload exceeds the size limit", async () => {
    const a = await app({ multipartFileSizeLimit: 16 });
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const { body, boundary } = buildMultipart(
      { companyId },
      { name: "big.txt", content: "x".repeat(4096), mime: "text/plain" },
    );
    const response = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(413);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error).toBe("too_large");

    expect(await listFiles(handle.db, { companyId })).toHaveLength(0);
    // The viewer is the same user the request above authenticated as; every
    // listEvents call names one since Phase 5 (mail rows are viewer-scoped).
    const viewerId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
    const events = await listEvents(handle.db, viewerId, { companyId });
    expect(events.items.some((e) => e.verb === "file_attached")).toBe(false);
    await a.close();
  });

  // A hostile filename must not be able to inject a header or break out of the
  // quoted-string in the download response's Content-Disposition, even though the
  // originalName is stored (and echoed back from POST/GET) verbatim -- sanitizing
  // only happens where it becomes a raw header value. Sent via RFC 5987's
  // filename*=charset''percent-encoded-value form (real CR/LF/quote bytes would
  // break the multipart header line itself; percent-encoding is how a client gets
  // those characters into a filename in the first place).
  //
  // The expected Content-Disposition below is contentDisposition()'s shape (see
  // routes/helpers.ts): control characters become "_" and quotes/backslashes are
  // dropped from the ASCII fallback, alongside the RFC 5987 filename* form -- not
  // the old naive `.replace(/[\r\n"]/g, "")` this route used to build by hand.
  it("sanitizes a hostile filename's CR/LF/quote in Content-Disposition while preserving it in storage", async () => {
    const a = await app();
    const company = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const companyId = company.json().id as string;

    const hostileFilename = 'evil\r\nX-Injected: 1".txt';
    const boundary = "----conduitHostileBoundary1234567890";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="companyId"\r\n\r\n${companyId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodeURIComponent(hostileFilename)}\r\n` +
      `Content-Type: text/plain\r\n\r\npayload\r\n` +
      `--${boundary}--\r\n`;

    const upload = await a.inject({
      method: "POST", url: "/api/files",
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = fileMetaSchema.parse(upload.json());
    expect(meta.originalName).toBe(hostileFilename);

    const download = await a.inject({
      method: "GET", url: `/api/files/${meta.id}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    const disposition = download.headers["content-disposition"];
    expect(typeof disposition).toBe("string");
    // The header legitimately contains two structural double-quotes (the
    // filename="..." delimiters), so the assertion checks the decoded value
    // between them rather than banning `"` from the whole header. No CR/LF
    // anywhere, and exactly those two structural quotes -- none embedded.
    expect(disposition).not.toMatch(/[\r\n]/);
    expect((disposition as string).match(/"/g)).toHaveLength(2);
    expect(disposition)
      .toBe(`attachment; filename="evil__X-Injected: 1.txt"; filename*=UTF-8''evil%0D%0AX-Injected%3A%201%22.txt`);
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    await a.close();
  });
});

describe("events routes", () => {
  it("lists events newest-first after a create and an update", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    const id = created.json().id as string;
    await a.inject({ method: "PATCH", url: `/api/companies/${id}`, headers: authHeaders, payload: { industry: "biotech" } });

    const response = await a.inject({
      method: "GET", url: `/api/events?company_id=${id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(eventSchema).parse(response.json());
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.verb).toBe("updated");
    expect(body.items[1]?.verb).toBe("created");
    await a.close();
  });

  it("filters by deal_id", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id);

    const response = await a.inject({
      method: "GET", url: `/api/events?deal_id=${deal.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(eventSchema).parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.verb).toBe("created");
    expect(body.items[0]?.dealId).toBe(deal.id);
    await a.close();
  });

  it("filters by task_id", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, { projectId: project.id });
    await makeTask(a, { projectId: project.id });

    const response = await a.inject({
      method: "GET", url: `/api/events?task_id=${taskA.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = listResponseSchema(eventSchema).parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.taskId).toBe(taskA.id);
    await a.close();
  });
});

describe("users route", () => {
  it("returns the seeded user ordered by username", async () => {
    const a = await app();
    await a.inject({ method: "GET", url: "/api/me", headers: authHeaders });

    const response = await a.inject({ method: "GET", url: "/api/users", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { users: { id: string; username: string; fullName: string | null }[] };
    expect(body.users.some((u) => u.username === "chris")).toBe(true);
    await a.close();
  });
});

/** POST /api/pipelines and return the parsed body. */
async function makePipeline(a: Awaited<ReturnType<typeof app>>, payload: Record<string, unknown> = { name: "Sales", scope: "global" }) {
  const response = await a.inject({ method: "POST", url: "/api/pipelines", headers: authHeaders, payload });
  return pipelineSchema.parse(response.json());
}
/** POST /api/pipelines/:id/stages and return the parsed body. */
async function makeStage(a: Awaited<ReturnType<typeof app>>, pipelineId: string, name: string) {
  const response = await a.inject({
    method: "POST", url: `/api/pipelines/${pipelineId}/stages`, headers: authHeaders, payload: { name },
  });
  return stageSchema.parse(response.json());
}
/** POST /api/deals and return the parsed body. */
async function makeDeal(
  a: Awaited<ReturnType<typeof app>>, pipelineId: string, stageId: string, extra: Record<string, unknown> = {},
) {
  const response = await a.inject({
    method: "POST", url: "/api/deals", headers: authHeaders,
    payload: { title: "Big Co deal", pipelineId, stageId, ...extra },
  });
  return dealSchema.parse(response.json());
}
/** POST /api/projects and return the parsed body. */
async function makeProject(a: Awaited<ReturnType<typeof app>>, extra: Record<string, unknown> = {}) {
  const response = await a.inject({
    method: "POST", url: "/api/projects", headers: authHeaders, payload: { name: "Launch", ...extra },
  });
  return projectSchema.parse(response.json());
}
/** POST /api/tasks and return the parsed body. */
async function makeTask(a: Awaited<ReturnType<typeof app>>, extra: Record<string, unknown> = {}) {
  const response = await a.inject({
    method: "POST", url: "/api/tasks", headers: authHeaders, payload: { title: "Do the thing", ...extra },
  });
  return taskSchema.parse(response.json());
}

describe("pipelines routes", () => {
  it("runs the pipeline CRUD happy path: create, composite get, patch, archive, unarchive", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    expect(pipeline.scope).toBe("global");

    const got = await a.inject({ method: "GET", url: `/api/pipelines/${pipeline.id}`, headers: authHeaders });
    expect(got.statusCode).toBe(200);
    const composite = pipelineWithStagesSchema.parse(got.json());
    expect(composite.pipeline.id).toBe(pipeline.id);
    expect(composite.stages).toEqual([]);

    const patched = await a.inject({
      method: "PATCH", url: `/api/pipelines/${pipeline.id}`, headers: authHeaders, payload: { name: "Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    expect(pipelineSchema.parse(patched.json()).name).toBe("Renamed");

    const archived = await a.inject({ method: "POST", url: `/api/pipelines/${pipeline.id}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);
    expect(pipelineSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const unarchived = await a.inject({ method: "POST", url: `/api/pipelines/${pipeline.id}/unarchive`, headers: authHeaders });
    expect(unarchived.statusCode).toBe(200);
    expect(pipelineSchema.parse(unarchived.json()).archivedAt).toBeNull();
    await a.close();
  });

  // Flagged as a gap by the P2.5 review: GET /api/pipelines/:id's 404 branch
  // (routes/pipelines.ts) had no test exercising it directly.
  it("returns 404 for an unknown pipeline id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/pipelines/3f2504e0-4f89-41d3-9a0c-0305e82c3301", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  it("lists pipelines filtered by scope and company_id", async () => {
    const a = await app();
    const company = await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });
    const companyId = company.json().id as string;
    await makePipeline(a, { name: "Global", scope: "global" });
    const scoped = await makePipeline(a, { name: "Scoped", scope: "company", companyId });

    const response = await a.inject({
      method: "GET", url: `/api/pipelines?scope=company&company_id=${companyId}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = z.array(pipelineSchema).parse(response.json());
    expect(body.map((p) => p.id)).toEqual([scoped.id]);
    await a.close();
  });

  // The wire-level pin the company page's "show archived" control rests on
  // (Phase 4.3): the service filter predates it, but until here nothing
  // proved `archived` survives this route's own query schema -- the test
  // above CLAIMED "and archived" in its title for two phases without ever
  // sending the flag.
  it("swaps the company's list to its archived pipelines with archived=true, explicit false matching absent", async () => {
    const a = await app();
    const company = await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });
    const companyId = company.json().id as string;
    const scoped = await makePipeline(a, { name: "Scoped", scope: "company", companyId });
    // Archived through its own route, so the archived arm filters within one
    // company rather than against an empty set.
    const retired = await makePipeline(a, { name: "Retired", scope: "company", companyId });
    const archived = await a.inject({ method: "POST", url: `/api/pipelines/${retired.id}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);

    // All three tri-state spellings: absent and explicit false both mean the
    // live rows; true swaps the list to the archived rows, each carrying a
    // non-null archivedAt for the client's Archived chip.
    const absent = await a.inject({
      method: "GET", url: `/api/pipelines?company_id=${companyId}`, headers: authHeaders,
    });
    expect(z.array(pipelineSchema).parse(absent.json()).map((p) => p.id)).toEqual([scoped.id]);
    const explicitFalse = await a.inject({
      method: "GET", url: `/api/pipelines?company_id=${companyId}&archived=false`, headers: authHeaders,
    });
    expect(z.array(pipelineSchema).parse(explicitFalse.json()).map((p) => p.id)).toEqual([scoped.id]);
    const archivedList = await a.inject({
      method: "GET", url: `/api/pipelines?company_id=${companyId}&archived=true`, headers: authHeaders,
    });
    const archivedBody = z.array(pipelineSchema).parse(archivedList.json());
    expect(archivedBody.map((p) => p.id)).toEqual([retired.id]);
    // ?? null so an ABSENT row fails this line on its own (undefined would
    // sail through .not.toBeNull()) instead of leaning on the toEqual above.
    expect(archivedBody[0]?.archivedAt ?? null).not.toBeNull();
    await a.close();
  });

  // Regression coverage for the P3.7 web-task fix: this route's own list
  // query schema had been left stale at scope enum(["global","company"]) with
  // no project_id param, well after project-scoped pipelines were wired up at
  // the service/shared-schema layer (P3.6) -- a project-detail page's
  // usePipelines({ projectId }) call would 400 before ever reaching the
  // (already correct) listPipelines service. Also covers the added
  // project_id-required-when-scope=project validation (see the route's own
  // doc comment for why that pairing is enforced here but scope=company is
  // deliberately left unpaired, unchanged).
  it("lists pipelines filtered by scope=project and project_id, excluding a company-scoped one, and 400s scope=project without project_id", async () => {
    const a = await app();
    const project = await makeProject(a);
    const company = await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });
    const companyId = company.json().id as string;
    const companyScoped = await makePipeline(a, { name: "Company scoped", scope: "company", companyId });
    const projectScoped = await makePipeline(a, { name: "Project scoped", scope: "project", projectId: project.id });

    const response = await a.inject({
      method: "GET", url: `/api/pipelines?scope=project&project_id=${project.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = z.array(pipelineSchema).parse(response.json());
    expect(body.map((p) => p.id)).toEqual([projectScoped.id]);
    expect(body.map((p) => p.id)).not.toContain(companyScoped.id);

    const missingProjectId = await a.inject({
      method: "GET", url: "/api/pipelines?scope=project", headers: authHeaders,
    });
    expect(missingProjectId.statusCode).toBe(400);
    expect(errorResponseSchema.parse(missingProjectId.json()).error).toBe("validation");
    await a.close();
  });

  it("creates and renames a stage, then reorders it to the front", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const first = await makeStage(a, pipeline.id, "Lead");
    const second = await makeStage(a, pipeline.id, "Qualified");

    const renamed = await a.inject({
      method: "PATCH", url: `/api/pipelines/${pipeline.id}/stages/${second.id}`, headers: authHeaders,
      payload: { name: "Qualifying" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(stageSchema.parse(renamed.json()).name).toBe("Qualifying");

    // Reorder second stage to sit BEFORE first (front of the pipeline): no
    // beforeStageId (nothing precedes it), afterStageId names the stage it
    // now sits immediately ahead of.
    const front = await a.inject({
      method: "POST", url: `/api/pipelines/${pipeline.id}/stages/${second.id}/reorder`, headers: authHeaders,
      payload: { afterStageId: first.id },
    });
    expect(front.statusCode).toBe(200);

    const composite = pipelineWithStagesSchema.parse(
      (await a.inject({ method: "GET", url: `/api/pipelines/${pipeline.id}`, headers: authHeaders })).json(),
    );
    expect(composite.stages.map((s) => s.id)).toEqual([second.id, first.id]);
    await a.close();
  });

  it("returns a 409 conflict body when a reorder names a neighbour from a different pipeline", async () => {
    const a = await app();
    const pipelineA = await makePipeline(a, { name: "A", scope: "global" });
    const pipelineB = await makePipeline(a, { name: "B", scope: "global" });
    const stageA = await makeStage(a, pipelineA.id, "Lead");
    const stageB = await makeStage(a, pipelineB.id, "Lead");

    const response = await a.inject({
      method: "POST", url: `/api/pipelines/${pipelineA.id}/stages/${stageA.id}/reorder`, headers: authHeaders,
      payload: { afterStageId: stageB.id },
    });
    expect(response.statusCode).toBe(409);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("conflict");
    await a.close();
  });
});

describe("deals routes", () => {
  it("requires pipeline_id on the list route", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: "/api/deals", headers: authHeaders });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("validation");
    await a.close();
  });

  it("applies config.defaultCurrency when a deal is created without one", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id);
    expect(deal.currency).toBe("EUR");
    await a.close();
  });

  it("respects an explicit currency over the configured default", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id, { currency: "USD" });
    expect(deal.currency).toBe("USD");
    await a.close();
  });

  it("moves a deal into another stage", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const qualified = await makeStage(a, pipeline.id, "Qualified");
    const deal = await makeDeal(a, pipeline.id, lead.id);

    const response = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/move`, headers: authHeaders,
      payload: { stageId: qualified.id },
    });
    expect(response.statusCode).toBe(200);
    expect(dealSchema.parse(response.json()).stageId).toBe(qualified.id);
    await a.close();
  });

  it("returns a 409 conflict body when moving next to a neighbour no longer in that stage", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const qualified = await makeStage(a, pipeline.id, "Qualified");
    const staleNeighbour = await makeDeal(a, pipeline.id, qualified.id);
    // Move the neighbour elsewhere so its stage membership is now stale.
    await a.inject({
      method: "POST", url: `/api/deals/${staleNeighbour.id}/move`, headers: authHeaders,
      payload: { stageId: lead.id },
    });
    const deal = await makeDeal(a, pipeline.id, lead.id);

    const response = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/move`, headers: authHeaders,
      payload: { stageId: qualified.id, beforeDealId: staleNeighbour.id },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  it("returns a 409 conflict body when moving a won deal", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const qualified = await makeStage(a, pipeline.id, "Qualified");
    const deal = await makeDeal(a, pipeline.id, lead.id);
    await a.inject({ method: "POST", url: `/api/deals/${deal.id}/win`, headers: authHeaders });

    const response = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/move`, headers: authHeaders,
      payload: { stageId: qualified.id },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  it("runs win, reopen, and lose happy paths, each stamping status and closedAt", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const dealA = await makeDeal(a, pipeline.id, lead.id);
    const dealB = await makeDeal(a, pipeline.id, lead.id);

    const won = await a.inject({ method: "POST", url: `/api/deals/${dealA.id}/win`, headers: authHeaders });
    expect(won.statusCode).toBe(200);
    const wonBody = dealSchema.parse(won.json());
    expect(wonBody.status).toBe("won");
    expect(wonBody.closedAt).not.toBeNull();

    const reopened = await a.inject({ method: "POST", url: `/api/deals/${dealA.id}/reopen`, headers: authHeaders });
    expect(reopened.statusCode).toBe(200);
    const reopenedBody = dealSchema.parse(reopened.json());
    expect(reopenedBody.status).toBe("open");
    expect(reopenedBody.closedAt).toBeNull();

    const lost = await a.inject({
      method: "POST", url: `/api/deals/${dealB.id}/lose`, headers: authHeaders, payload: { reason: "budget cut" },
    });
    expect(lost.statusCode).toBe(200);
    const lostBody = dealSchema.parse(lost.json());
    expect(lostBody.status).toBe("lost");
    expect(lostBody.lostReason).toBe("budget cut");
    await a.close();
  });

  it("returns a 409 conflict body for an illegal transition (winning an already-won deal)", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, lead.id);
    await a.inject({ method: "POST", url: `/api/deals/${deal.id}/win`, headers: authHeaders });

    const response = await a.inject({ method: "POST", url: `/api/deals/${deal.id}/win`, headers: authHeaders });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  it("returns 400 when losing a deal without a reason", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, lead.id);

    const response = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/lose`, headers: authHeaders, payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });

  // Flagged as a gap by the P2.5 review: GET /api/deals/:id's 404 branch
  // (routes/deals.ts) had no test exercising it directly.
  it("returns 404 for an unknown deal id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/deals/3f2504e0-4f89-41d3-9a0c-0305e82c3301", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  // Flagged as a gap by the P2.5 review: POST /api/deals/:id/archive and
  // .../unarchive had no route-level happy-path test (only the underlying
  // service was covered).
  it("runs the deal archive/unarchive happy path", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id);

    const archived = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/archive`, headers: authHeaders,
    });
    expect(archived.statusCode).toBe(200);
    expect(dealSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const unarchived = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/unarchive`, headers: authHeaders,
    });
    expect(unarchived.statusCode).toBe(200);
    expect(dealSchema.parse(unarchived.json()).archivedAt).toBeNull();
    await a.close();
  });

  it("returns the funnel shape for a pipeline with one open deal", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const lead = await makeStage(a, pipeline.id, "Lead");
    await makeDeal(a, pipeline.id, lead.id, { valueCents: 5000 });

    const response = await a.inject({ method: "GET", url: `/api/pipelines/${pipeline.id}/funnel`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = z.array(funnelRowSchema).parse(response.json());
    const row = body.find((r) => r.stageId === lead.id);
    expect(row?.count).toBe(1);
    expect(row?.valueCents).toBe(5000);
    await a.close();
  });
});

describe("projects routes", () => {
  it("runs the project CRUD happy path: create, get, patch, archive, unarchive", async () => {
    const a = await app();
    const project = await makeProject(a, { name: "Q4 rollout" });
    expect(project.status).toBe("active");

    const got = await a.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: authHeaders });
    expect(got.statusCode).toBe(200);
    expect(projectSchema.parse(got.json()).id).toBe(project.id);

    const patched = await a.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: authHeaders, payload: { name: "Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    expect(projectSchema.parse(patched.json()).name).toBe("Renamed");

    const archived = await a.inject({ method: "POST", url: `/api/projects/${project.id}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);
    expect(projectSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const unarchived = await a.inject({ method: "POST", url: `/api/projects/${project.id}/unarchive`, headers: authHeaders });
    expect(unarchived.statusCode).toBe(200);
    expect(projectSchema.parse(unarchived.json()).archivedAt).toBeNull();
    await a.close();
  });

  it("returns 404 for an unknown project id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/projects/3f2504e0-4f89-41d3-9a0c-0305e82c3301", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  it("returns 409 patching an archived project", async () => {
    const a = await app();
    const project = await makeProject(a);
    await a.inject({ method: "POST", url: `/api/projects/${project.id}/archive`, headers: authHeaders });

    const response = await a.inject({
      method: "PATCH", url: `/api/projects/${project.id}`, headers: authHeaders, payload: { name: "New" },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });

  it("lists projects filtered by company_id, status, and archived", async () => {
    const a = await app();
    const company = await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });
    const companyId = company.json().id as string;
    const owned = await makeProject(a, { name: "Owned", companyId });
    await makeProject(a, { name: "Standalone" });

    const response = await a.inject({
      method: "GET", url: `/api/projects?company_id=${companyId}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = z.array(projectSchema).parse(response.json());
    expect(body.map((p) => p.id)).toEqual([owned.id]);
    await a.close();
  });

  it("returns both forms of the gantt payload shaped by the schema", async () => {
    const a = await app();
    const project = await makeProject(a);
    await makeTask(a, { projectId: project.id, startDate: "2026-02-01", dueDate: "2026-02-05" });

    const perProject = await a.inject({
      method: "GET", url: `/api/projects/${project.id}/gantt`, headers: authHeaders,
    });
    expect(perProject.statusCode).toBe(200);
    const perProjectBody = ganttPayloadSchema.parse(perProject.json());
    expect(perProjectBody.tasks).toHaveLength(1);
    expect(perProjectBody.tasks[0]?.projectId).toBe(project.id);

    const global = await a.inject({ method: "GET", url: "/api/gantt", headers: authHeaders });
    expect(global.statusCode).toBe(200);
    const globalBody = ganttPayloadSchema.parse(global.json());
    expect(globalBody.tasks.map((t) => t.id)).toContain(perProjectBody.tasks[0]?.id);
    await a.close();
  });

  it("returns 404 for the gantt of an unknown project id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/projects/3f2504e0-4f89-41d3-9a0c-0305e82c3301/gantt", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  // "Remove slack" (Phase 3.1): POST /api/projects/:id/compact. Dates are
  // relative to today (not hardcoded) -- compactSchedule refuses to schedule
  // a movable task's start before today (Fix 1, hotfix v0.4.3), so a fixed
  // past date here would get clamped instead of landing on taskA's due date,
  // which is the wiring this smoke test actually cares about.
  it("compacts a project's schedule and returns the moved list", async () => {
    const a = await app();
    const day = (n: number) => addDays(todayDateOnly(), n);
    const project = await makeProject(a);
    const taskA = await makeTask(a, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    const taskB = await makeTask(a, { title: "B", projectId: project.id, startDate: day(69), dueDate: day(73) });
    await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });

    const response = await a.inject({ method: "POST", url: `/api/projects/${project.id}/compact`, headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = shiftResultSchema.parse(response.json());
    expect(body.moved).toEqual([{ id: taskB.id, startDate: day(64), dueDate: day(68), cascadedFrom: null }]);
    await a.close();
  });

  it("returns 404 compacting an unknown project id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/projects/3f2504e0-4f89-41d3-9a0c-0305e82c3301/compact", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  it("returns 409 compacting an archived project", async () => {
    const a = await app();
    const project = await makeProject(a);
    await a.inject({ method: "POST", url: `/api/projects/${project.id}/archive`, headers: authHeaders });

    const response = await a.inject({ method: "POST", url: `/api/projects/${project.id}/compact`, headers: authHeaders });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });
});

describe("tasks routes", () => {
  it("runs the task CRUD happy path: create, get, patch, archive, unarchive", async () => {
    const a = await app();
    const task = await makeTask(a, { title: "Write the spec" });
    expect(task.status).toBe("todo");

    const got = await a.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: authHeaders });
    expect(got.statusCode).toBe(200);
    expect(taskSchema.parse(got.json()).id).toBe(task.id);

    const patched = await a.inject({
      method: "PATCH", url: `/api/tasks/${task.id}`, headers: authHeaders, payload: { title: "Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    expect(taskSchema.parse(patched.json()).title).toBe("Renamed");

    const archived = await a.inject({ method: "POST", url: `/api/tasks/${task.id}/archive`, headers: authHeaders });
    expect(archived.statusCode).toBe(200);
    expect(taskSchema.parse(archived.json()).archivedAt).not.toBeNull();

    const unarchived = await a.inject({ method: "POST", url: `/api/tasks/${task.id}/unarchive`, headers: authHeaders });
    expect(unarchived.statusCode).toBe(200);
    expect(taskSchema.parse(unarchived.json()).archivedAt).toBeNull();
    await a.close();
  });

  it("returns 404 for an unknown task id", async () => {
    const a = await app();
    const response = await a.inject({
      method: "GET", url: "/api/tasks/3f2504e0-4f89-41d3-9a0c-0305e82c3301", headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    await a.close();
  });

  it("returns 409 patching an archived task", async () => {
    const a = await app();
    const task = await makeTask(a);
    await a.inject({ method: "POST", url: `/api/tasks/${task.id}/archive`, headers: authHeaders });

    const response = await a.inject({
      method: "PATCH", url: `/api/tasks/${task.id}`, headers: authHeaders, payload: { title: "New" },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });

  it("lists tasks filtered by project_id, standalone, assignee_id, status, dated, and archived", async () => {
    const a = await app();
    const project = await makeProject(a);
    const inProject = await makeTask(a, { title: "In project", projectId: project.id });
    const standalone = await makeTask(a, { title: "Standalone" });

    const byProject = await a.inject({
      method: "GET", url: `/api/tasks?project_id=${project.id}`, headers: authHeaders,
    });
    expect(z.array(taskSchema).parse(byProject.json()).map((t) => t.id)).toEqual([inProject.id]);

    const byStandalone = await a.inject({
      method: "GET", url: "/api/tasks?standalone=true", headers: authHeaders,
    });
    expect(z.array(taskSchema).parse(byStandalone.json()).map((t) => t.id)).toContain(standalone.id);
    await a.close();
  });

  it("sets a task's status, stamping completed_at", async () => {
    const a = await app();
    const task = await makeTask(a);

    const response = await a.inject({
      method: "POST", url: `/api/tasks/${task.id}/status`, headers: authHeaders, payload: { status: "done" },
    });
    expect(response.statusCode).toBe(200);
    const body = taskSchema.parse(response.json());
    expect(body.status).toBe("done");
    expect(body.completedAt).not.toBeNull();
    await a.close();
  });

  it("returns 400 for an invalid status value", async () => {
    const a = await app();
    const task = await makeTask(a);
    const response = await a.inject({
      method: "POST", url: `/api/tasks/${task.id}/status`, headers: authHeaders, payload: { status: "bogus" },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });

  it("moves a task on the board into another status column", async () => {
    const a = await app();
    const task = await makeTask(a);
    const response = await a.inject({
      method: "POST", url: `/api/tasks/${task.id}/board-move`, headers: authHeaders,
      payload: { status: "in_progress" },
    });
    expect(response.statusCode).toBe(200);
    expect(taskSchema.parse(response.json()).status).toBe("in_progress");
    await a.close();
  });

  it("returns 409 board-moving next to a neighbour in a different column", async () => {
    const a = await app();
    const taskA = await makeTask(a, { title: "A" });
    const taskB = await makeTask(a, { title: "B" });
    // taskB stays in todo; ask to move taskA into in_progress but name taskB
    // (still in todo) as a same-column neighbour -- a stale/mismatched pair.
    const response = await a.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/board-move`, headers: authHeaders,
      payload: { status: "in_progress", beforeTaskId: taskB.id },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");
    await a.close();
  });

  it("adds a dependency, 201, and rejects a cycle with 409", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, { title: "A", projectId: project.id });
    const taskB = await makeTask(a, { title: "B", projectId: project.id });

    const added = await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });
    expect(added.statusCode).toBe(201);
    const dep = taskDependencySchema.parse(added.json());
    expect(dep.predecessorId).toBe(taskA.id);
    expect(dep.successorId).toBe(taskB.id);

    // B already depends on A; adding A->B's reverse (B->A) would close a cycle.
    const cyclic = await a.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskB.id },
    });
    expect(cyclic.statusCode).toBe(409);
    const cyclicBody = errorResponseSchema.parse(cyclic.json());
    expect(cyclicBody.error).toBe("conflict");
    expect(cyclicBody.message).toContain("cycle");
    await a.close();
  });

  // Each addDependency rejection reason gets its own message now (P3.6
  // review): the UI branches on more than just the 409 status/error code, so
  // this pins the distinguishing substring for every one of the four cases,
  // not just the generic ConflictError code assertion.
  it("gives each dependency-add rejection its own distinguishing 409 message", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, { title: "A", projectId: project.id });
    const taskB = await makeTask(a, { title: "B", projectId: project.id });
    const standalone = await makeTask(a, { title: "Standalone" });

    const selfRef = await a.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });
    expect(selfRef.statusCode).toBe(409);
    const selfRefBody = errorResponseSchema.parse(selfRef.json());
    expect(selfRefBody.error).toBe("conflict");
    expect(selfRefBody.message).toContain("cannot depend on itself");

    const crossProject = await a.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: standalone.id },
    });
    expect(crossProject.statusCode).toBe(409);
    const crossProjectBody = errorResponseSchema.parse(crossProject.json());
    expect(crossProjectBody.error).toBe("conflict");
    expect(crossProjectBody.message).toContain("must belong to the same project");

    await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });
    const duplicate = await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });
    expect(duplicate.statusCode).toBe(409);
    const duplicateBody = errorResponseSchema.parse(duplicate.json());
    expect(duplicateBody.error).toBe("conflict");
    expect(duplicateBody.message).toContain("already exists");
    await a.close();
  });

  it("removes a dependency, and removing it again is an idempotent 204", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, { title: "A", projectId: project.id });
    const taskB = await makeTask(a, { title: "B", projectId: project.id });
    await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });

    const first = await a.inject({
      method: "DELETE", url: `/api/tasks/${taskB.id}/dependencies/${taskA.id}`, headers: authHeaders,
    });
    expect(first.statusCode).toBe(204);

    const second = await a.inject({
      method: "DELETE", url: `/api/tasks/${taskB.id}/dependencies/${taskA.id}`, headers: authHeaders,
    });
    expect(second.statusCode).toBe(204);
    await a.close();
  });

  it("lists a task's predecessors, and 404s for an unknown task id", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, { title: "A", projectId: project.id });
    const taskB = await makeTask(a, { title: "B", projectId: project.id });
    await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });

    const listed = await a.inject({
      method: "GET", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    const deps = taskDependencySchema.array().parse(listed.json());
    expect(deps.map((d) => d.predecessorId)).toEqual([taskA.id]);

    const emptyList = await a.inject({
      method: "GET", url: `/api/tasks/${taskA.id}/dependencies`, headers: authHeaders,
    });
    expect(taskDependencySchema.array().parse(emptyList.json())).toEqual([]);

    const missing = await a.inject({
      method: "GET", url: "/api/tasks/3f2504e0-4f89-41d3-9a0c-0305e82c3301/dependencies", headers: authHeaders,
    });
    expect(missing.statusCode).toBe(404);
    await a.close();
  });

  // The centrepiece: build a two-hop dependency chain via the API, shift the
  // head task's dates far enough right to violate both downstream tasks, and
  // assert the response's moved array (schema-parsed) shows the cascade.
  it("shift cascades through a dependency chain and returns every moved task", async () => {
    const a = await app();
    const project = await makeProject(a);
    const taskA = await makeTask(a, {
      title: "A", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-05",
    });
    const taskB = await makeTask(a, {
      title: "B", projectId: project.id, startDate: "2026-01-06", dueDate: "2026-01-10",
    });
    const taskC = await makeTask(a, {
      title: "C", projectId: project.id, startDate: "2026-01-11", dueDate: "2026-01-15",
    });
    await a.inject({
      method: "POST", url: `/api/tasks/${taskB.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskA.id },
    });
    await a.inject({
      method: "POST", url: `/api/tasks/${taskC.id}/dependencies`, headers: authHeaders,
      payload: { predecessorId: taskB.id },
    });

    const response = await a.inject({
      method: "POST", url: `/api/tasks/${taskA.id}/shift`, headers: authHeaders,
      payload: { startDate: "2026-01-10", dueDate: "2026-01-14" },
    });
    expect(response.statusCode).toBe(200);
    const body = shiftResultSchema.parse(response.json());
    expect(body.moved.length).toBeGreaterThan(1);
    expect(body.moved.map((m) => m.id)).toEqual(expect.arrayContaining([taskA.id, taskB.id, taskC.id]));
    const movedA = body.moved.find((m) => m.id === taskA.id);
    expect(movedA?.cascadedFrom).toBeNull();
    const movedC = body.moved.find((m) => m.id === taskC.id);
    expect(movedC?.cascadedFrom).toBe(taskA.id);
    await a.close();
  });

  it("returns 409 shifting an archived task", async () => {
    const a = await app();
    const task = await makeTask(a, { startDate: "2026-01-01", dueDate: "2026-01-05" });
    await a.inject({ method: "POST", url: `/api/tasks/${task.id}/archive`, headers: authHeaders });

    const response = await a.inject({
      method: "POST", url: `/api/tasks/${task.id}/shift`, headers: authHeaders,
      payload: { startDate: "2026-01-10", dueDate: "2026-01-14" },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("archived");
    await a.close();
  });

  it("returns 400 shifting with dueDate before startDate", async () => {
    const a = await app();
    const task = await makeTask(a);
    const response = await a.inject({
      method: "POST", url: `/api/tasks/${task.id}/shift`, headers: authHeaders,
      payload: { startDate: "2026-01-10", dueDate: "2026-01-05" },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });
});

describe("search route", () => {
  it("returns grouped results that parse against the shared schema", async () => {
    const a = await app();
    await a.inject({ method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" } });

    const response = await a.inject({ method: "GET", url: "/api/search?q=acme", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    expect(body.companies).toHaveLength(1);
    await a.close();
  });

  it("returns empty groups for a whitespace-only q without erroring", async () => {
    const a = await app();
    const response = await a.inject({ method: "GET", url: "/api/search?q=%20%20", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    expect(body).toEqual({ companies: [], contacts: [], notes: [], deals: [], tasks: [], mail: [] });
    await a.close();
  });

  it("returns a deals group that still contains a won deal by title", async () => {
    const a = await app();
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "Lead");
    const deal = await makeDeal(a, pipeline.id, stage.id, { title: "Quixotic Holdings renewal" });
    await a.inject({ method: "POST", url: `/api/deals/${deal.id}/win`, headers: authHeaders });

    const response = await a.inject({ method: "GET", url: "/api/search?q=Quixotic", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    expect(body.deals.map((d) => d.id)).toContain(deal.id);
    await a.close();
  });

  it("returns a tasks group that still contains a DONE task by title", async () => {
    const a = await app();
    const task = await makeTask(a, { title: "Wexfordbay handover" });
    await a.inject({ method: "POST", url: `/api/tasks/${task.id}/status`, headers: authHeaders, payload: { status: "done" } });

    const response = await a.inject({ method: "GET", url: "/api/search?q=Wexfordbay", headers: authHeaders });
    expect(response.statusCode).toBe(200);
    const body = searchResultsSchema.parse(response.json());
    expect(body.tasks.map((t) => t.id)).toContain(task.id);
    await a.close();
  });
});

async function makeMeeting(a: Awaited<ReturnType<typeof app>>, payload: Record<string, unknown>) {
  const response = await a.inject({ method: "POST", url: "/api/meetings", headers: authHeaders, payload });
  return meetingSchema.parse(response.json());
}

describe("meetings routes", () => {
  const occurredAt = new Date("2026-08-20T09:00:00.000Z").toISOString();
  const unknownId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  async function makeCompany(a: Awaited<ReturnType<typeof app>>) {
    const response = await a.inject({
      method: "POST", url: "/api/companies", headers: authHeaders, payload: { name: "Acme" },
    });
    return companySchema.parse(response.json());
  }

  it("creates a meeting and returns 201 with a contract-shaped body", async () => {
    const a = await app();
    const company = await makeCompany(a);

    const response = await a.inject({
      method: "POST", url: "/api/meetings", headers: authHeaders,
      payload: {
        title: "Kickoff", occurredAt, durationMinutes: 45, companyId: company.id,
        notes: "<p>Agreed the scope</p><script>alert(1)</script>",
        attendees: [{ guestName: "Their lawyer" }],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = meetingSchema.parse(response.json());
    expect(body.companyId).toBe(company.id);
    expect(body.notes).toBe("<p>Agreed the scope</p>");
    expect(body.attendees.map((x) => x.guestName)).toEqual(["Their lawyer"]);
    expect(body.taskCount).toBe(0);
    await a.close();
  });

  // The reachability rule reaches the client as a 400 (the zod refine), never
  // as a 500 from the meetings_has_link CHECK.
  it("returns 400 validation for a meeting linked to nothing", async () => {
    const a = await app();
    const response = await a.inject({
      method: "POST", url: "/api/meetings", headers: authHeaders,
      payload: { title: "Nowhere", occurredAt },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    await a.close();
  });

  // The patch shape carries no such refine (a patch cannot see the stored
  // row), so the same rule arrives from the service as a 409 -- still not the
  // CHECK's 500.
  it("returns 409 conflict for a patch that empties the last link", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });

    const response = await a.inject({
      method: "PATCH", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
      payload: { companyId: null },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conflict");

    const renamed = await a.inject({
      method: "PATCH", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
      payload: { title: "Kickoff II", attendees: [{ guestName: "Their lawyer" }] },
    });
    expect(renamed.statusCode).toBe(200);
    const patched = meetingSchema.parse(renamed.json());
    expect(patched.title).toBe("Kickoff II");
    expect(patched.attendees).toHaveLength(1);
    await a.close();
  });

  // Both of a meeting write's 409s, side by side, because they are the same
  // status and the client has to tell them apart: a duplicate attendee is one
  // row of the attendee list to fix, the emptied last link is a different
  // section of the form. Branching on the CODE, never on the prose.
  it("returns 409 duplicate_attendee when the same contact is listed twice, distinct from the conflict code", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const contact = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Dana" },
    });
    const contactId = contactSchema.parse(contact.json()).id;

    const response = await a.inject({
      method: "POST", url: "/api/meetings", headers: authHeaders,
      payload: {
        title: "Kickoff", occurredAt, companyId: company.id,
        attendees: [{ contactId }, { contactId }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("duplicate_attendee");

    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });
    const onPatch = await a.inject({
      method: "PATCH", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
      payload: { attendees: [{ contactId }, { contactId }] },
    });
    expect(onPatch.statusCode).toBe(409);
    expect(errorResponseSchema.parse(onPatch.json()).error).toBe("duplicate_attendee");

    const emptied = await a.inject({
      method: "PATCH", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
      payload: { companyId: null },
    });
    expect(emptied.statusCode).toBe(409);
    expect(errorResponseSchema.parse(emptied.json()).error).toBe("conflict");
    await a.close();
  });

  it("lists a meeting under a contact who only attended it, and honours the archived tri-state", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const contact = await a.inject({
      method: "POST", url: "/api/contacts", headers: authHeaders, payload: { firstName: "Dana" },
    });
    const contactId = contactSchema.parse(contact.json()).id;
    const meeting = await makeMeeting(a, {
      title: "Kickoff", occurredAt, companyId: company.id, attendees: [{ contactId }],
    });

    const listed = await a.inject({
      method: "GET", url: `/api/meetings?contact_id=${contactId}`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listResponseSchema(meetingSchema).parse(listed.json()).items.map((m) => m.id))
      .toEqual([meeting.id]);

    await a.inject({ method: "POST", url: `/api/meetings/${meeting.id}/archive`, headers: authHeaders });
    // "false" is a literal string on the wire, and it must not read as truthy.
    const live = await a.inject({ method: "GET", url: "/api/meetings?archived=false", headers: authHeaders });
    expect(listResponseSchema(meetingSchema).parse(live.json()).items).toHaveLength(0);
    const archived = await a.inject({ method: "GET", url: "/api/meetings?archived=true", headers: authHeaders });
    expect(listResponseSchema(meetingSchema).parse(archived.json()).items.map((m) => m.id))
      .toEqual([meeting.id]);

    const restored = await a.inject({
      method: "POST", url: `/api/meetings/${meeting.id}/unarchive`, headers: authHeaders,
    });
    expect(restored.statusCode).toBe(200);
    expect(meetingSchema.parse(restored.json()).archivedAt).toBeNull();
    await a.close();
  });

  // Meetings page by (occurred_at, id): a cursor minted by a created_at list
  // must be rejected here rather than silently paging from a timestamp that
  // means something else.
  it("returns 400 for a cursor belonging to another ordering", async () => {
    const a = await app();
    const foreign = Buffer.from(
      JSON.stringify({ createdAt: occurredAt, id: unknownId }), "utf8",
    ).toString("base64url");

    const response = await a.inject({
      method: "GET", url: `/api/meetings?cursor=${foreign}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).message).toBe("invalid cursor");
    await a.close();
  });

  it("answers the detail payload and 404s an unknown id", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });

    const response = await a.inject({
      method: "GET", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    const detail = meetingDetailSchema.parse(response.json());
    expect(detail.meeting.id).toBe(meeting.id);
    expect(detail.tasks).toEqual([]);

    const missing = await a.inject({
      method: "GET", url: `/api/meetings/${unknownId}`, headers: authHeaders,
    });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error).toBe("not_found");
    await a.close();
  });

  it("returns 409 archived for a patch on an archived meeting, and 404 for archive/unarchive of an unknown id", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });
    await a.inject({ method: "POST", url: `/api/meetings/${meeting.id}/archive`, headers: authHeaders });

    const patched = await a.inject({
      method: "PATCH", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
      payload: { title: "Kickoff II" },
    });
    expect(patched.statusCode).toBe(409);
    // `archived` and `conflict` are distinct 409 bodies the client branches
    // on: an archived row needs unarchiving first, a conflict needs a refetch.
    expect(errorResponseSchema.parse(patched.json()).error).toBe("archived");

    for (const action of ["archive", "unarchive"]) {
      const response = await a.inject({
        method: "POST", url: `/api/meetings/${unknownId}/${action}`, headers: authHeaders,
      });
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error).toBe("not_found");
    }
    await a.close();
  });

  it("creates a follow-up task with the meeting's links inherited, and lists it back on the meeting", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });

    const response = await a.inject({
      method: "POST", url: `/api/meetings/${meeting.id}/tasks`, headers: authHeaders,
      payload: { title: "Send the deck", type: "email" },
    });
    // 201 with the TASK, the same shape POST /api/tasks answers with -- one
    // task-created response however the task was reached.
    expect(response.statusCode).toBe(201);
    const task = taskSchema.parse(response.json());
    expect(task.companyId).toBe(company.id);
    expect(task.type).toBe("email");

    const detail = await a.inject({
      method: "GET", url: `/api/meetings/${meeting.id}`, headers: authHeaders,
    });
    const body = meetingDetailSchema.parse(detail.json());
    expect(body.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(body.meeting.taskCount).toBe(1);
    await a.close();
  });

  // The wire shape omits the four record links (they are inherited), and zod's
  // non-strict parse drops one sent anyway rather than rejecting the request --
  // the same parse every other input schema in this codebase uses. The
  // meeting's link is what the task gets, which is the point of the affordance.
  it("ignores a record link sent in the follow-up body", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const other = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });

    const response = await a.inject({
      method: "POST", url: `/api/meetings/${meeting.id}/tasks`, headers: authHeaders,
      payload: { title: "Send the deck", companyId: other.id },
    });
    expect(response.statusCode).toBe(201);
    expect(taskSchema.parse(response.json()).companyId).toBe(company.id);

    // The task rules travel with the route: a lone date is a 400 here exactly
    // as it is on POST /api/tasks.
    const halfDated = await a.inject({
      method: "POST", url: `/api/meetings/${meeting.id}/tasks`, headers: authHeaders,
      payload: { title: "Half dated", startDate: "2026-09-01" },
    });
    expect(halfDated.statusCode).toBe(400);
    expect(errorResponseSchema.parse(halfDated.json()).error).toBe("validation");
    await a.close();
  });

  it("returns 404 for a follow-up task on an unknown meeting and 409 archived on an archived one", async () => {
    const a = await app();
    const company = await makeCompany(a);
    const meeting = await makeMeeting(a, { title: "Kickoff", occurredAt, companyId: company.id });

    const missing = await a.inject({
      method: "POST", url: `/api/meetings/${unknownId}/tasks`, headers: authHeaders,
      payload: { title: "Nowhere" },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error).toBe("not_found");

    await a.inject({ method: "POST", url: `/api/meetings/${meeting.id}/archive`, headers: authHeaders });
    const archived = await a.inject({
      method: "POST", url: `/api/meetings/${meeting.id}/tasks`, headers: authHeaders,
      payload: { title: "Too late" },
    });
    expect(archived.statusCode).toBe(409);
    // `archived`, not `conflict`: unarchive the meeting and the same request
    // works, which is what that code tells a client.
    expect(errorResponseSchema.parse(archived.json()).error).toBe("archived");
    await a.close();
  });

  it("returns 401 without an identity header on every meetings route", async () => {
    const a = await app();
    const calls = [
      { method: "GET" as const, url: "/api/meetings" },
      { method: "POST" as const, url: "/api/meetings" },
      { method: "GET" as const, url: `/api/meetings/${unknownId}` },
      { method: "PATCH" as const, url: `/api/meetings/${unknownId}` },
      { method: "POST" as const, url: `/api/meetings/${unknownId}/archive` },
      { method: "POST" as const, url: `/api/meetings/${unknownId}/unarchive` },
      { method: "POST" as const, url: `/api/meetings/${unknownId}/tasks` },
    ];
    for (const call of calls) {
      const response = await a.inject({ ...call, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error).toBe("unauthenticated");
    }
    await a.close();
  });
});

describe("documents routes", () => {
  const unknownId = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

  /**
   * These run WITHOUT WEASYPRINT, on a stub `python3` (test/python-stub.ts) that
   * emits eight random bytes behind a `%PDF-` header. What this file is testing is
   * the HTTP surface -- status codes, body shapes, which failures are 4xx -- and
   * gating that on a binary would mean the refusal paths never run on a developer
   * machine at all. The real renderer is exercised in services/documents.test.ts.
   */
  const VARYING_PDF = [
    "printf '%s' '%PDF-1.7 conduit-stub-'",
    "od -An -N8 -tx1 /dev/urandom | tr -d ' \\n'",
  ].join("\n");

  /** truncateAll() empties document_templates too, so every test seeds its own. */
  async function seedTemplate(bodyHtml = seededQuoteTemplate()): Promise<void> {
    await handle.db.insert(documentTemplates).values({ type: "quote", bodyHtml });
  }

  async function makeQuotableDeal(a: Awaited<ReturnType<typeof app>>) {
    const pipeline = await makePipeline(a);
    const stage = await makeStage(a, pipeline.id, "New");
    return await makeDeal(a, pipeline.id, stage.id);
  }

  function quotePayload(overrides: Record<string, unknown> = {}) {
    return {
      issueDate: "2026-08-28",
      validUntilDate: "2026-09-27",
      recipientName: "Acme Manufacturing BV",
      recipientContactName: "Jane Smith",
      recipientAddress: "2 Low Street",
      notes: "", terms: "",
      lines: [{ description: "Widget", qtyMilli: 2000, unitPriceCents: 5000, taxRateBp: 2100 }],
      ...overrides,
    };
  }

  it("raises a quote on a deal, lists it, and serves the PDF through the existing files route", async () => {
    await seedTemplate();
    const a = await app();
    const deal = await makeQuotableDeal(a);

    const created = await withPythonStub(writePythonStub(dataDir, VARYING_PDF), async () =>
      await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`,
        headers: authHeaders, payload: quotePayload(),
      }));
    expect(created.statusCode).toBe(201);
    const document = documentSchema.parse(created.json());
    expect(document.number).toBe("QUO-2026-0001");
    expect(document.totalCents).toBe(12_100);
    expect(document.lines).toHaveLength(1);

    const listed = await a.inject({
      method: "GET", url: `/api/deals/${deal.id}/documents`, headers: authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(z.array(documentSchema).parse(listed.json())).toEqual([document]);

    // NO SECOND DOWNLOAD PATH. The PDF is an ordinary files row on the deal, so it
    // comes back through the route that already existed.
    const download = await a.inject({
      method: "GET", url: `/api/files/${document.fileId}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/pdf");
    expect(download.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(download.headers["content-disposition"]).toContain("QUO-2026-0001.pdf");
    await a.close();
  });

  it("answers 400 for each bound the CHECK constraints would otherwise raise after a render", async () => {
    // The three gates, at the HTTP surface: a client sees a validation error, not a
    // 500 raised once a subprocess had already run.
    await seedTemplate();
    const a = await app();
    const deal = await makeQuotableDeal(a);
    const bad = [
      { description: "Refund", qtyMilli: -1000, unitPriceCents: 5000, taxRateBp: 2100 },
      { description: "Credit", qtyMilli: 1000, unitPriceCents: -5000, taxRateBp: 2100 },
      { description: "Widget", qtyMilli: 1000, unitPriceCents: 5000, taxRateBp: 15_000 },
    ];
    for (const line of bad) {
      const response = await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`,
        headers: authHeaders, payload: quotePayload({ lines: [line] }),
      });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error).toBe("validation");
    }
    // Nothing was issued and no number was spent.
    const listed = await a.inject({
      method: "GET", url: `/api/deals/${deal.id}/documents`, headers: authHeaders,
    });
    expect(listed.json()).toEqual([]);
    await a.close();
  });

  it("turns a failed render into a 422 rather than a 500, and spends no number", async () => {
    await seedTemplate();
    const a = await app();
    const deal = await makeQuotableDeal(a);

    const failed = await withPythonStub(
      writePythonStub(dataDir, "echo 'Fatal: no fonts' >&2\nexit 5"),
      async () => await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`,
        headers: authHeaders, payload: quotePayload(),
      }),
    );
    expect(failed.statusCode).toBe(422);
    const body = errorResponseSchema.parse(failed.json());
    expect(body.error).toBe("render_failed");
    // The child's stderr can name server paths, so it stays in the log: the message
    // is this codebase's own short phrase.
    expect(body.message).toBe("renderer exited 5");
    expect(body.message).not.toContain("no fonts");

    const recovered = await withPythonStub(writePythonStub(dataDir, VARYING_PDF), async () =>
      await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`,
        headers: authHeaders, payload: quotePayload(),
      }));
    expect(documentSchema.parse(recovered.json()).number).toBe("QUO-2026-0001");
    await a.close();
  });

  it("answers 422 for a template that cannot terminate, and 409 for one that is missing", async () => {
    const a = await app();
    const deal = await makeQuotableDeal(a);

    const missing = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/documents`,
      headers: authHeaders, payload: quotePayload(),
    });
    expect(missing.statusCode).toBe(409);
    expect(errorResponseSchema.parse(missing.json()).error).toBe("template_missing");

    await seedTemplate(`${"{{#lines}}".repeat(40)}x${"{{/lines}}".repeat(40)}`);
    const looping = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/documents`,
      headers: authHeaders, payload: quotePayload(),
    });
    expect(looping.statusCode).toBe(422);
    expect(errorResponseSchema.parse(looping.json()).error).toBe("template_error");
    await a.close();
  });

  it("404s an unknown deal and 409s an archived one", async () => {
    await seedTemplate();
    const a = await app();
    const deal = await makeQuotableDeal(a);

    const unknown = await a.inject({
      method: "POST", url: `/api/deals/${unknownId}/documents`,
      headers: authHeaders, payload: quotePayload(),
    });
    expect(unknown.statusCode).toBe(404);

    await a.inject({ method: "POST", url: `/api/deals/${deal.id}/archive`, headers: authHeaders });
    const archived = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/documents`,
      headers: authHeaders, payload: quotePayload(),
    });
    expect(archived.statusCode).toBe(409);
    expect(errorResponseSchema.parse(archived.json()).error).toBe("archived");
    await a.close();
  });

  it("reads and writes the issuer profile, which starts empty rather than absent", async () => {
    const a = await app();
    const empty = await a.inject({ method: "GET", url: "/api/org-profile", headers: authHeaders });
    expect(empty.statusCode).toBe(200);
    expect(orgProfileSchema.parse(empty.json())).toMatchObject({ name: "", logoDataUri: "" });

    const saved = await a.inject({
      method: "PUT", url: "/api/org-profile", headers: authHeaders,
      payload: {
        name: "Listerdale Life Sciences", addressLines: "1 High St",
        vatNumber: "NL001234567B01", registrationNumber: "12345678",
        email: "hello@listerdale.test", phone: "+31 20 123 4567",
        website: "listerdale.test", bankDetails: "NL00 BANK 0123 4567 89",
        logoDataUri: "",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(orgProfileSchema.parse(saved.json()).name).toBe("Listerdale Life Sciences");

    const reread = await a.inject({ method: "GET", url: "/api/org-profile", headers: authHeaders });
    expect(orgProfileSchema.parse(reread.json()).vatNumber).toBe("NL001234567B01");

    const invalid = await a.inject({
      method: "PUT", url: "/api/org-profile", headers: authHeaders, payload: { name: "Only a name" },
    });
    expect(invalid.statusCode).toBe(400);
    await a.close();
  });

  it("refuses a quote that is over the render budget with a 400, before anything spawns", async () => {
    // The budget, at the HTTP surface. Every field is inside its own cap and the
    // total is not, which no per-field bound can express -- and the client gets a
    // sentence about the budget rather than a 413 naming a byte count from a
    // subprocess it never asked about.
    await seedTemplate();
    const a = await app();
    const deal = await makeQuotableDeal(a);
    const cjk = "\u6771";
    const response = await a.inject({
      method: "POST", url: `/api/deals/${deal.id}/documents`, headers: authHeaders,
      payload: quotePayload({
        recipientAddress: cjk.repeat(2000), notes: cjk.repeat(5000), terms: cjk.repeat(5000),
        lines: Array.from({ length: DOCUMENT_MAX_LINES }, () => ({
          description: cjk.repeat(DOCUMENT_MAX_DESCRIPTION_CHARS),
          qtyMilli: 1000, unitPriceCents: 100, taxRateBp: 0,
        })),
      }),
    });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("validation");
    expect(body.message).toContain("a document may use");
    await a.close();
  });

  it("answers 413 when a template outruns the renderer's input cap, which the gate cannot see", async () => {
    // THE NAMED EXCEPTION TO THE BUDGET'S CONSERVATISM. The gate counts a value once;
    // a template that prints `{{document.notes}}` forty times prints it forty times.
    // That is why renderPdf's input cap stays as the backstop, and this is the shape
    // that reaches it.
    //
    // FORTY, NOT TWO HUNDRED, and the difference is which refusal you get: at 200 the
    // merge produces a million characters and mergeTemplate's own 512K output bound
    // throws first, so the answer is a 422 template_error. Between 128KB and 512K the
    // merge succeeds and the RENDERER refuses it, which is the case under test here.
    // Both are 4xx and neither spends a number.
    await seedTemplate(`<p>${"{{document.notes}}".repeat(40)}</p>`);
    const a = await app();
    const deal = await makeQuotableDeal(a);
    const response = await withPythonStub(writePythonStub(dataDir, VARYING_PDF), async () =>
      await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`, headers: authHeaders,
        payload: quotePayload({ notes: "n".repeat(5000) }),
      }));

    expect(response.statusCode).toBe(413);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error).toBe("too_large");
    // THE MESSAGE COMES FROM THE MEASURED CHECK, NOT THE RENDERER. Both refuse the
    // same document with the same status; the difference is that this one runs where
    // the parts are still separable, so it can say which of them to shorten instead
    // of quoting a total from a subprocess the caller never asked about.
    expect(body.message).toContain("merges to");
    expect(body.message).toContain("Its template is");
    // Refused before the spawn, so no number was spent and there is nothing to list.
    const listed = await a.inject({
      method: "GET", url: `/api/deals/${deal.id}/documents`, headers: authHeaders,
    });
    expect(listed.json()).toEqual([]);
    await a.close();
  });

  it("reads and writes the quote template, with the warnings the editor needs", async () => {
    // THE TEMPLATE EDITOR HAD NO API AT ALL. document_templates was read in one place
    // and written nowhere outside tests, and `documentTemplateWarnings` was exported
    // for a Settings panel that had no server to call.
    const a = await app();
    const seeded = await a.inject({
      method: "GET", url: "/api/document-templates/quote", headers: authHeaders,
    });
    expect(seeded.statusCode).toBe(200);
    // truncateAll empties the table, so an install whose template was deleted reads
    // as an empty body a PUT can replace rather than as a 404 with nothing to edit.
    expect(documentTemplateSchema.parse(seeded.json())).toMatchObject({ type: "quote", bodyHtml: "" });

    const saved = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "<p>{{document.number}}</p><style>p{color:#333}</style>" },
    });
    expect(saved.statusCode).toBe(200);
    const body = documentTemplateSchema.parse(saved.json());
    expect(body.bodyHtml).toContain("{{document.number}}");
    expect(body.warnings).toEqual([]);

    // A merge field inside a <style> block is left unresolved -- one of the three
    // things this module does silently, and exactly what the editor has to say.
    const warned = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "<style>p{color:{{org.brandColour}}}</style><p>x</p>" },
    });
    expect(documentTemplateSchema.parse(warned.json()).warnings.length).toBeGreaterThan(0);

    // ...and the saved body is what a quote is then raised from.
    const deal = await makeQuotableDeal(a);
    await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "<p>{{document.number}} for {{document.recipientName}}</p>" },
    });
    const issued = await withPythonStub(writePythonStub(dataDir, VARYING_PDF), async () =>
      await a.inject({
        method: "POST", url: `/api/deals/${deal.id}/documents`,
        headers: authHeaders, payload: quotePayload(),
      }));
    expect(documentSchema.parse(issued.json()).number).toBe("QUO-2026-0001");
    await a.close();
  });

  it("refuses a template that is empty, unknown-typed, or larger than its share of the render budget", async () => {
    const a = await app();
    const tooBig = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "x".repeat(MAX_TEMPLATE_BYTES + 1) },
    });
    expect(tooBig.statusCode).toBe(400);

    const empty = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "" },
    });
    expect(empty.statusCode).toBe(400);

    // Sanitises to nothing: well-formed, and not a template.
    const stripped = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "<script>alert(1)</script>" },
    });
    expect(stripped.statusCode).toBe(400);
    expect(errorResponseSchema.parse(stripped.json()).message).toContain("sanitised");

    // An unknown type is the uniform 400 rather than a CHECK violation out of the
    // upsert, which is what validating the path parameter buys.
    const unknownType = await a.inject({
      method: "GET", url: "/api/document-templates/invoice", headers: authHeaders,
    });
    expect(unknownType.statusCode).toBe(400);
    await a.close();
  });

  it("gives the shipped template back byte for byte, image and all", async () => {
    // **THE SAVE THAT DESTROYED THE LOGO.** Sanitising a template judged
    // `src="{{org.logoDataUri}}"` as a URL -- it is not one yet -- dropped the `src`,
    // and `exclusiveFilter` then dropped the whole `<img>`. GET the seeded template,
    // PUT it back unmodified, and it came out 38 characters shorter with no logo,
    // silently, with no warning. That is exactly what Task 5's editor does the first
    // time somebody opens the template and saves it, and every quote after that
    // prints no letterhead.
    //
    // The property a save needs is f(x) = x, not f(f(x)) = f(x): idempotence would
    // have held all along while the first save ate the image.
    await seedTemplate();
    const a = await app();
    const fetched = await a.inject({
      method: "GET", url: "/api/document-templates/quote", headers: authHeaders,
    });
    const original = documentTemplateSchema.parse(fetched.json()).bodyHtml;
    expect(original).toContain("<img");
    expect(original).toBe(seededQuoteTemplate());

    const saved = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: original },
    });
    expect(saved.statusCode).toBe(200);
    const body = documentTemplateSchema.parse(saved.json());
    expect(body.bodyHtml).toBe(original);
    expect(body.warnings).toEqual([]);

    // ...and a second save changes nothing either, so the fixed point is real.
    const again = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: body.bodyHtml },
    });
    expect(documentTemplateSchema.parse(again.json()).bodyHtml).toBe(original);
    await a.close();
  });

  it("refuses a template that nests a block inside itself, and one that grows when sanitised", async () => {
    const a = await app();
    // The size multiplier: `{{#lines}}` inside `{{#lines}}` runs its body once per
    // line PER LEVEL, so a 114-character template plus an ordinary quote merges to
    // 130KB of table -- under the renderer's cap, and 353MB to lay out.
    const nested = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: "{{#lines}}{{#lines}}<p>{{description}}</p>{{/lines}}{{/lines}}" },
    });
    expect(nested.statusCode).toBe(400);
    expect(errorResponseSchema.parse(nested.json()).message).toContain("nested inside another");

    // THE SANITISER CAN GROW A BODY, so the length that matters is measured after it.
    // A raw `"` inside a single-quoted attribute is re-serialised as `&quot;`, which
    // is six bytes for one: 16,384 characters of it store as 97,546.
    const grows = await a.inject({
      method: "PUT", url: "/api/document-templates/quote", headers: authHeaders,
      payload: { bodyHtml: `<p title='${'"'.repeat(16_000)}'>x</p>` },
    });
    expect(grows.statusCode).toBe(400);
    expect(errorResponseSchema.parse(grows.json()).message).toContain("once sanitised");
    await a.close();
  });

  it("returns 401 without an identity header on every documents route", async () => {
    const a = await app();
    const calls = [
      { method: "GET" as const, url: `/api/deals/${unknownId}/documents` },
      { method: "POST" as const, url: `/api/deals/${unknownId}/documents` },
      { method: "GET" as const, url: "/api/org-profile" },
      { method: "PUT" as const, url: "/api/org-profile" },
      { method: "GET" as const, url: "/api/document-templates/quote" },
      { method: "PUT" as const, url: "/api/document-templates/quote" },
    ];
    for (const call of calls) {
      const response = await a.inject({ ...call, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error).toBe("unauthenticated");
    }
    await a.close();
  });
});
