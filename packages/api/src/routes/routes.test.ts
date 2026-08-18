import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  companySchema, contactSchema, noteSchema, fileMetaSchema, eventSchema,
  errorResponseSchema, listResponseSchema, searchResultsSchema,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { buildApp } from "../app.js";
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

async function app() {
  return buildApp({ config, db: handle.db, dataDir });
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
    expect(body).toEqual({ companies: [], contacts: [], notes: [] });
    await a.close();
  });
});
