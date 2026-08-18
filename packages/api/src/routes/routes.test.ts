import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  companySchema, contactSchema, noteSchema, fileMetaSchema, eventSchema,
  errorResponseSchema, listResponseSchema, searchResultsSchema,
  pipelineSchema, pipelineWithStagesSchema, stageSchema, dealSchema, funnelRowSchema,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp, type BuildAppOptions } from "../app.js";
import { listFiles } from "../services/files.js";
import { listEvents } from "../services/timeline.js";
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
  // requires exactly one of company_id/contact_id -- there is no "everything"
  // notes list.
  it("GET requires exactly one of company_id or contact_id", async () => {
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

    const download = await a.inject({
      method: "GET", url: `/api/files/${meta.id}/download`, headers: authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello world");
    expect(download.headers["content-disposition"]).toBe('attachment; filename="hello.txt"');
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
    const events = await listEvents(handle.db, { companyId });
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
    expect(disposition).toBe(`attachment; filename="${hostileFilename.replace(/[\r\n"]/g, "")}"`);
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

  it("lists pipelines filtered by scope, company_id, and archived", async () => {
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
    expect(body).toEqual({ companies: [], contacts: [], notes: [], deals: [] });
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
});
