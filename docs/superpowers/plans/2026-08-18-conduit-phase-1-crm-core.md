# Conduit Phase 1 — CRM Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the walking skeleton into a usable CRM: companies, contacts, notes, files, a per-record timeline, and global search — deployed to the live server as v0.2.0.

**Architecture:** Five new tables via drizzle migrations applied on boot. A service layer per entity owns every mutation and writes the row plus its `events` row in one transaction; route handlers stay thin and validate all bodies with Zod schemas from `@conduit/shared`. The SPA gains its real foundation: Tailwind 4, Radix primitives, TanStack Router (basename from `__CONDUIT_BASE__`) and TanStack Query.

**Tech Stack:** Existing Phase 0 stack plus `@fastify/multipart`, `@tanstack/react-router`, `@tanstack/react-query`, `tailwindcss` + `@tailwindcss/vite`, `@radix-ui/react-{dialog,select,tabs}`, `clsx`.

---

## Conventions (carried from Phase 0 — read before any task)

- **All commands run on the dev server** via `./scripts/remote.sh '<cmd>'`. Never run npm/npx/psql on the Mac. The target host comes from the untracked `.conduit-remote` file. There is NO passwordless sudo anymore; nothing in Tasks 1–11 needs root.
- **ESM/NodeNext in `packages/api`**: relative imports need `.js` extensions. `packages/web` uses bundler resolution: NO extensions.
- **ASCII-only source files** (bytes <= 127). Write special characters as `\u` escapes. Verify with a Python byte scan before committing.
- Tests: `./scripts/remote.sh 'npx vitest run'` (87 passing at start). DB tests use the harness (`openTestDatabase()`, `truncateAll()` — truncateAll reads `pg_tables`, so new tables are covered automatically). Playwright: `npm run test:e2e` needs `npm run build` first.
- Migrations: `./scripts/remote.sh 'npm run db:generate -w @conduit/api'`, then rsync the generated files back: `rsync -az $(cat .conduit-remote):/home/chris/conduit/packages/api/drizzle/ packages/api/drizzle/`.
- After changing deps, `remote.sh` pulls back `package-lock.json` automatically; commit it.
- TDD throughout: failing test first, implement, verify, commit per task.

## File Structure

| Path | Responsibility |
|---|---|
| `packages/api/drizzle/0001_*.sql` | Generated migration for the five tables |
| `packages/api/src/db/schema.ts` | + `companies`, `contacts`, `notes`, `files`, `events` tables |
| `packages/shared/src/index.ts` | + entity schemas, input schemas, list/search response schemas |
| `packages/api/src/services/errors.ts` | `NotFoundError`, `ArchivedError` domain errors |
| `packages/api/src/services/pagination.ts` | Cursor encode/decode helpers |
| `packages/api/src/services/companies.ts` | Company CRUD + archive + events, all writes transactional |
| `packages/api/src/services/contacts.ts` | Same for contacts |
| `packages/api/src/services/notes.ts` | Note create/list + `note_added` event |
| `packages/api/src/services/blobs.ts` | sha256-addressed blob store under `DATA_DIR/files` |
| `packages/api/src/services/files.ts` | File metadata + `file_attached` event |
| `packages/api/src/services/search.ts` | ILIKE search with note snippets |
| `packages/api/src/routes/{companies,contacts,notes,files,events,users,search}.ts` | One route module each |
| `packages/api/src/config.ts` | + `dataDir` |
| `packages/web/src/{router.tsx,queries.ts}` | Router (basename-aware) and TanStack Query fetchers |
| `packages/web/src/components/ui/*.tsx` | Small vendored primitives (button, input, dialog, select, tabs, table) |
| `packages/web/src/components/{shell,search,entity-table,field-card,owner-select}.tsx` | Layout + shared widgets |
| `packages/web/src/components/rail/{timeline,notes,files}.tsx` | Detail-page right rail |
| `packages/web/src/pages/{companies,company-detail,contacts,contact-detail}.tsx` | The four pages |
| `e2e/crm.spec.ts` | The Phase 1 journey |

Route registration: `app.ts` gains `await registerCrmRoutes(app, { db, dataDir })` from `packages/api/src/routes/index.ts`, keeping `app.ts` small.

---

### Task 1: Schema + shared contracts

**Files:** Modify `packages/api/src/db/schema.ts`, `packages/shared/src/index.ts`, `packages/api/src/config.ts`, `conf/.env`; generate `packages/api/drizzle/0001_*.sql`; tests in `packages/shared/src/index.test.ts`, `packages/api/src/config.test.ts`.

- [ ] **Step 1: Failing tests for the shared contracts** — add to `packages/shared/src/index.test.ts`:

```typescript
import { companySchema, contactSchema, createNoteInputSchema } from "./index.js";

describe("companySchema", () => {
  const base = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", name: "Acme", domain: null, website: null,
    phone: null, address: null, industry: null, ownerUserId: null, archivedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  it("accepts a company", () => expect(companySchema.parse(base)).toEqual(base));
  it("rejects an empty name", () =>
    expect(() => companySchema.parse({ ...base, name: "" })).toThrow());
});

describe("contactSchema", () => {
  it("requires emails to be valid", () => {
    expect(() =>
      contactSchema.parse({
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", firstName: "Ann", lastName: null,
        companyId: null, emails: ["not-an-email"], phones: [], jobTitle: null,
        ownerUserId: null, archivedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe("createNoteInputSchema", () => {
  it("rejects a note with no entity", () =>
    expect(() => createNoteInputSchema.parse({ body: "hi" })).toThrow());
  it("rejects a note with two entities", () =>
    expect(() =>
      createNoteInputSchema.parse({
        body: "hi",
        companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        contactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }),
    ).toThrow());
});
```

- [ ] **Step 2: Run to confirm failure** — `./scripts/remote.sh 'npx vitest run packages/shared'` fails on missing exports.

- [ ] **Step 3: Add the contracts** to `packages/shared/src/index.ts`:

```typescript
const nullableString = z.string().min(1).nullable();
const timestamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };

export const companySchema = z.object({
  id: z.uuid(), name: z.string().min(1),
  domain: nullableString, website: nullableString, phone: nullableString,
  address: nullableString, industry: nullableString,
  ownerUserId: z.uuid().nullable(), archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Company = z.infer<typeof companySchema>;

export const createCompanyInputSchema = z.object({
  name: z.string().min(1),
  domain: nullableString.optional(), website: nullableString.optional(),
  phone: nullableString.optional(), address: nullableString.optional(),
  industry: nullableString.optional(), ownerUserId: z.uuid().nullable().optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;
export const updateCompanyInputSchema = createCompanyInputSchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

export const contactSchema = z.object({
  id: z.uuid(), firstName: z.string().min(1), lastName: nullableString,
  companyId: z.uuid().nullable(), emails: z.array(z.email()), phones: z.array(z.string().min(1)),
  jobTitle: nullableString, ownerUserId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Contact = z.infer<typeof contactSchema>;

export const createContactInputSchema = z.object({
  firstName: z.string().min(1), lastName: nullableString.optional(),
  companyId: z.uuid().nullable().optional(),
  emails: z.array(z.email()).optional(), phones: z.array(z.string().min(1)).optional(),
  jobTitle: nullableString.optional(), ownerUserId: z.uuid().nullable().optional(),
});
export type CreateContactInput = z.infer<typeof createContactInputSchema>;
export const updateContactInputSchema = createContactInputSchema.partial();
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

const exactlyOneEntity = (v: { companyId?: string | null; contactId?: string | null }) =>
  [v.companyId, v.contactId].filter((x) => x != null).length === 1;

export const createNoteInputSchema = z
  .object({ body: z.string().min(1), companyId: z.uuid().optional(), contactId: z.uuid().optional() })
  .refine(exactlyOneEntity, { message: "exactly one of companyId or contactId is required" });
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

export const noteSchema = z.object({
  id: z.uuid(), body: z.string().min(1), authorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), createdAt: z.iso.datetime(),
});
export type Note = z.infer<typeof noteSchema>;

export const fileMetaSchema = z.object({
  id: z.uuid(), originalName: z.string().min(1), mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().length(64),
  uploaderUserId: z.uuid(), companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

export const eventVerbSchema = z.enum([
  "created", "updated", "archived", "unarchived", "note_added", "file_attached",
]);
export const eventSchema = z.object({
  id: z.uuid(), verb: eventVerbSchema, actorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
});
export type Event = z.infer<typeof eventSchema>;

export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const searchResultsSchema = z.object({
  companies: z.array(z.object({ id: z.uuid(), name: z.string() })),
  contacts: z.array(z.object({
    id: z.uuid(), firstName: z.string(), lastName: z.string().nullable(),
    emails: z.array(z.string()),
  })),
  notes: z.array(z.object({
    id: z.uuid(), companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
    snippet: z.string(),
  })),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;
```

- [ ] **Step 4: Drizzle tables** — append to `packages/api/src/db/schema.ts` (import `jsonb`, `integer`, `check` as needed; note `sql` from `drizzle-orm`):

```typescript
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domain: text("domain"), website: text("website"), phone: text("phone"),
  address: text("address"), industry: text("industry"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  custom: jsonb("custom").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CompanyRow = typeof companies.$inferSelect;

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  firstName: text("first_name").notNull(), lastName: text("last_name"),
  companyId: uuid("company_id").references(() => companies.id),
  emails: text("emails").array().notNull().default([]),
  phones: text("phones").array().notNull().default([]),
  jobTitle: text("job_title"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  custom: jsonb("custom").notNull().default({}),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ContactRow = typeof contacts.$inferSelect;

const exactlyOne = sql`num_nonnulls(company_id, contact_id) = 1`;

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  body: text("body").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("notes_exactly_one_entity", exactlyOne)]);
export type NoteRow = typeof notes.$inferSelect;

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalName: text("original_name").notNull(), mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(), sha256: text("sha256").notNull(),
  uploaderUserId: uuid("uploader_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("files_exactly_one_entity", exactlyOne)]);
export type FileRow = typeof files.$inferSelect;

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  verb: text("verb").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  companyId: uuid("company_id").references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type EventRow = typeof events.$inferSelect;
```

- [ ] **Step 5: `dataDir` config** — in `packages/api/src/config.ts` add to the env schema `DATA_DIR: z.string().min(1).default("./data")`, to `Config` `dataDir: string;`, to the return `dataDir: value.DATA_DIR,`. Test: `parseConfig(valid).dataDir` defaults, and an explicit value carries through. Append `DATA_DIR=__DATA_DIR__` to `conf/.env` (the systemd unit already grants `ReadWritePaths=__DATA_DIR__`).

- [ ] **Step 6: Generate + verify migration** — `./scripts/remote.sh 'npm run db:generate -w @conduit/api'`, rsync `drizzle/` back, `cat` the new `0001_*.sql`: five `CREATE TABLE`s, both CHECK constraints, FKs. Boot-verify against `conduit_test` with a throwaway `verify-migrations.ts` (pattern from Phase 0 Task 4), then `psql conduit_test -c '\d companies'`. Delete the throwaway.

- [ ] **Step 7: Full suite + typecheck, commit** — `git commit -m "feat: add CRM schema and shared contracts"`.

---

### Task 2: Companies service

**Files:** Create `packages/api/src/services/errors.ts`, `services/pagination.ts`, `services/companies.ts`, `services/companies.test.ts`.

- [ ] **Step 1: Failing tests** — `services/companies.test.ts` (uses harness; create an actor with `resolveUser`):

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import {
  createCompany, updateCompany, archiveCompany, unarchiveCompany,
  listCompanies, getCompany,
} from "./companies.js";
import { NotFoundError, ArchivedError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

describe("companies service", () => {
  it("creates a company and records a created event", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    expect(company.name).toBe("Acme");
    const evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.verb).toBe("created");
  });

  it("updates fields, bumps updatedAt, and records the changed field names", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    const updated = await updateCompany(handle.db, actorId, c.id, { phone: "+31 6 1234", industry: "biotech" });
    expect(updated.phone).toBe("+31 6 1234");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(c.updatedAt).getTime());
    const evs = await handle.db.select().from(events).where(eq(events.companyId, c.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["phone", "industry"] });
  });

  it("archive hides from the default list but getCompany still returns it", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    expect((await listCompanies(handle.db, {})).items).toHaveLength(0);
    expect((await listCompanies(handle.db, { archived: true })).items).toHaveLength(1);
    expect((await getCompany(handle.db, c.id))?.archivedAt).not.toBeNull();
  });

  it("refuses to update an archived company", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await expect(updateCompany(handle.db, actorId, c.id, { name: "X" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("unarchive restores listability", async () => {
    const c = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, c.id);
    await unarchiveCompany(handle.db, actorId, c.id);
    expect((await listCompanies(handle.db, {})).items).toHaveLength(1);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateCompany(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters by q and paginates with a stable cursor", async () => {
    for (let i = 0; i < 3; i++) await createCompany(handle.db, actorId, { name: `Acme ${i}` });
    await createCompany(handle.db, actorId, { name: "Globex" });
    expect((await listCompanies(handle.db, { q: "acme" })).items).toHaveLength(3);
    const page1 = await listCompanies(handle.db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listCompanies(handle.db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((x) => x.id));
    expect(ids.size).toBe(4);
  });
});
```

- [ ] **Step 2: Confirm failure**, then implement.

`services/errors.ts`:

```typescript
export class NotFoundError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} not found`); }
}
export class ArchivedError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} is archived`); }
}
```

`services/pagination.ts`:

```typescript
export interface Cursor { createdAt: string; id: string; }
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
export function decodeCursor(raw: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof v.createdAt === "string" && typeof v.id === "string" ? v : null;
  } catch { return null; }
}
/** Escape %, _ and \ so user input cannot act as ILIKE wildcards. */
export function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }
```

`services/companies.ts` — the pattern every later service copies:

```typescript
import { and, desc, eq, ilike, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Company, CreateCompanyInput, UpdateCompanyInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, events, type CompanyRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { decodeCursor, encodeCursor, escapeLike } from "./pagination.js";

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id, name: row.name, domain: row.domain, website: row.website, phone: row.phone,
    address: row.address, industry: row.industry, ownerUserId: row.ownerUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCompany(db: Database, actorId: string, input: CreateCompanyInput): Promise<Company> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(companies).values({ ...input }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await tx.insert(events).values({ verb: "created", actorUserId: actorId, companyId: row.id, payload: {} });
    return toCompany(row);
  });
}

async function mustGet(db: Database, id: string): Promise<CompanyRow> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (row === undefined) throw new NotFoundError("company", id);
  return row;
}

export async function updateCompany(db: Database, actorId: string, id: string, patch: UpdateCompanyInput): Promise<Company> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("company", id);
  const changed = Object.keys(patch);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(companies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(companies.id, id)).returning();
    if (row === undefined) throw new NotFoundError("company", id);
    await tx.insert(events).values({ verb: "updated", actorUserId: actorId, companyId: id, payload: { changed } });
    return toCompany(row);
  });
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Company> {
  await mustGet(db, id);
  return db.transaction(async (tx) => {
    const [row] = await tx.update(companies)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(companies.id, id)).returning();
    if (row === undefined) throw new NotFoundError("company", id);
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId, companyId: id, payload: {},
    });
    return toCompany(row);
  });
}
export const archiveCompany = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveCompany = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

export async function getCompany(db: Database, id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  return row === undefined ? null : toCompany(row);
}

export interface ListOptions { q?: string; archived?: boolean; cursor?: string; limit?: number; }

export async function listCompanies(db: Database, opts: ListOptions): Promise<{ items: Company[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const where = [opts.archived ? isNotNull(companies.archivedAt) : isNull(companies.archivedAt)];
  if (opts.q) where.push(ilike(companies.name, `%${escapeLike(opts.q)}%`));
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    where.push(or(
      lt(companies.createdAt, new Date(cur.createdAt)),
      and(eq(companies.createdAt, new Date(cur.createdAt)), lt(companies.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(companies).where(and(...where))
    .orderBy(desc(companies.createdAt), desc(companies.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toCompany),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
```

- [ ] **Step 3: Tests pass, typecheck clean, commit** — `feat(api): companies service with transactional events`.

---

### Task 3: Contacts service

**Files:** Create `packages/api/src/services/contacts.ts`, `services/contacts.test.ts`.

Same shape as companies (`toContact`, `createContact`, `updateContact`, `archiveContact`, `unarchiveContact`, `getContact`, `listContacts`) with three differences, all of which need tests beyond the mirrored ones:

1. `listContacts` takes `companyId?: string` and filters `eq(contacts.companyId, ...)` — test that a company's contacts list excludes another company's contacts.
2. `q` matches `first_name`, `last_name`, OR any email: `or(ilike(contacts.firstName, p), ilike(contacts.lastName, p), sql\`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${p})\`)` — test a search by email fragment finds the contact.
3. `createContact` with a `companyId` that does not exist must surface `NotFoundError`, not a raw FK violation: pre-check with a select. Test it.

Event rows use `contactId` instead of `companyId`. Commit: `feat(api): contacts service`.

---

### Task 4: Notes + events services

**Files:** Create `packages/api/src/services/notes.ts`, `services/notes.test.ts`, `services/timeline.ts`, `services/timeline.test.ts`.

`notes.ts`: `createNote(db, actorId, input: CreateNoteInput): Promise<Note>` — inserts the note and a `note_added` event (payload `{ noteId, preview: body.slice(0, 120) }`) in one transaction; the event carries the same `companyId`/`contactId` as the note. `listNotes(db, { companyId?, contactId? })` newest first. Throw `NotFoundError` if the target entity does not exist; `ArchivedError` if it is archived.

`timeline.ts`: `listEvents(db, { companyId?, contactId?, cursor?, limit? })` — same keyset pagination as companies, ordered newest first, mapped to the shared `Event` type.

Tests: note creation emits exactly one event; note on an archived company rejects with `ArchivedError`; note on a missing contact rejects with `NotFoundError`; the DB CHECK rejects a hand-inserted note with both FKs (`await expect(handle.db.insert(notes).values({... both ...})).rejects.toThrow(/notes_exactly_one_entity/)`); timeline returns company events newest-first and paginates. Commit: `feat(api): notes and timeline services`.

---

### Task 5: Blob store + files service

**Files:** Create `packages/api/src/services/blobs.ts`, `services/blobs.test.ts`, `services/files.ts`, `services/files.test.ts`.

`blobs.ts`:

```typescript
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/** Store a stream under DATA_DIR/files/<sha256>. Duplicate content shares one blob. */
export async function saveBlob(dataDir: string, source: Readable): Promise<{ sha256: string; sizeBytes: number }> {
  const dir = path.join(dataDir, "files");
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  source.on("data", (chunk: Buffer) => { hash.update(chunk); sizeBytes += chunk.length; });
  try {
    await pipeline(source, createWriteStream(tmp));
    const sha256 = hash.digest("hex");
    const final = path.join(dir, sha256);
    try { await stat(final); await rm(tmp); }        // already have this content
    catch { await rename(tmp, final); }
    return { sha256, sizeBytes };
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

export function openBlob(dataDir: string, sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid sha256");
  return createReadStream(path.join(dataDir, "files", sha256));
}
```

`files.ts`: `attachFile(db, actorId, meta: { originalName, mime, sizeBytes, sha256, companyId?, contactId? })` — validates the target entity exists and is not archived (same as notes), inserts the `files` row plus a `file_attached` event (payload `{ fileId, originalName }`) transactionally. `listFiles(db, { companyId?, contactId? })`, `getFile(db, id)`.

Tests (blobs use a `mkdtemp` dataDir): saving the same content twice yields one blob file and identical sha; saved bytes round-trip through `openBlob`; a failed stream leaves no `.upload-*` temp behind; `openBlob` rejects a path-traversal "sha". Files service: attach emits event; attach to archived entity rejects; sha of stored row matches blob on disk. Commit: `feat(api): content-addressed blob store and files service`.

---

### Task 6: Search service

**Files:** Create `packages/api/src/services/search.ts`, `services/search.test.ts`.

```typescript
import { and, ilike, isNull, or, sql } from "drizzle-orm";
import type { SearchResults } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, notes } from "../db/schema.js";
import { escapeLike } from "./pagination.js";

const LIMIT_PER_TYPE = 8;

function snippet(body: string, q: string): string {
  const at = body.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return body.slice(0, 120);
  const start = Math.max(0, at - 60);
  const end = Math.min(body.length, at + q.length + 60);
  return `${start > 0 ? "..." : ""}${body.slice(start, end)}${end < body.length ? "..." : ""}`;
}

export async function search(db: Database, q: string): Promise<SearchResults> {
  const p = `%${escapeLike(q)}%`;
  const [companyRows, contactRows, noteRows] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies)
      .where(and(isNull(companies.archivedAt), ilike(companies.name, p))).limit(LIMIT_PER_TYPE),
    db.select({
      id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, emails: contacts.emails,
    }).from(contacts).where(and(isNull(contacts.archivedAt), or(
      ilike(contacts.firstName, p), ilike(contacts.lastName, p),
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${p})`,
    ))).limit(LIMIT_PER_TYPE),
    db.select({ id: notes.id, companyId: notes.companyId, contactId: notes.contactId, body: notes.body })
      .from(notes).where(ilike(notes.body, p)).limit(LIMIT_PER_TYPE),
  ]);
  return {
    companies: companyRows,
    contacts: contactRows,
    notes: noteRows.map((n) => ({ id: n.id, companyId: n.companyId, contactId: n.contactId, snippet: snippet(n.body, q) })),
  };
}
```

Tests: grouped results across all three types; archived company excluded; email-fragment match; snippet contains the match with ellipses on a long body; `%` in the query matches literally rather than as a wildcard (create "50% off" note, search `50%`). Note search must also exclude notes whose parent entity is archived — add a JOIN-based filter and a test proving a note on an archived company disappears from results. Commit: `feat(api): global search with note snippets`.

---

### Task 7: Routes

**Files:** Create `packages/api/src/routes/{index,companies,contacts,notes,files,events,users,search}.ts` + `routes/routes.test.ts`. Modify `packages/api/src/app.ts` (add `dataDir` to `BuildAppOptions`, call `registerCrmRoutes`); add `@fastify/multipart` to `packages/api` deps.

Route rules, uniform across modules:
- Parse bodies/queries with the shared Zod schemas; a Zod failure returns 400 `{ error: "validation", message }`.
- All CRM routes require `request.user`; return 401 otherwise (same shape as `/api/me`).
- `NotFoundError` maps to 404, `ArchivedError` to 409 `{ error: "archived", message }` — one shared `mapDomainError(reply, error)` helper in `routes/index.ts`.
- Responses are built from service returns (already shared-shaped).

`routes/index.ts` signature: `export async function registerCrmRoutes(app: FastifyInstance, deps: { db: Database; dataDir: string }): Promise<void>` — registers `@fastify/multipart` (`limits: { fileSize: 50 * 1024 * 1024, files: 1 }`) and each module.

Endpoints (all under `/api`): as specified in the spec — companies GET/POST/GET:id/PATCH:id/archive/unarchive; contacts likewise plus `?company_id=`; `GET/POST /api/notes`; `POST /api/files` (multipart field `file` + fields `companyId`/`contactId`; stream via `request.file()` into `saveBlob`, then `attachFile`), `GET /api/files?...`, `GET /api/files/:id/download` (Content-Disposition attachment with the original name, stream from `openBlob`); `GET /api/events`; `GET /api/users` (id, username, fullName, ordered by username); `GET /api/search?q=` (empty/whitespace q returns empty groups without querying).

`server.ts`: pass `dataDir: config.dataDir` through `buildApp`.

Tests (route level, via `app.inject`, ~15): one happy path per endpoint validating response with the shared schema; 400 on bad body; 401 without identity; 404 unknown id; 409 archived; multipart upload round-trip (inject with `form-data` payload) then download matches bytes and filename; search endpoint returns grouped shape. Commit: `feat(api): CRM REST routes`.

---

### Task 8: Web foundation

**Files:** Modify `packages/web/package.json` (add `@tanstack/react-router`, `@tanstack/react-query`, `tailwindcss`, `@tailwindcss/vite`, `@radix-ui/react-dialog`, `@radix-ui/react-select`, `@radix-ui/react-tabs`, `clsx`), `vite.config.ts` (add `tailwindcss()` plugin), `index.html` (keep placeholders!). Create `src/styles.css` (`@import "tailwindcss";`), `src/router.tsx`, `src/queries.ts`, `src/components/shell.tsx`, `src/components/ui/{button,input,textarea,dialog,select,tabs,table}.tsx`. Rewrite `src/main.tsx`; `src/App.tsx` becomes the dashboard route component (keeps its data-testids — the Phase 0 smoke test must stay green).

`router.tsx` core:

```tsx
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { basePath } from "./api";
import { Shell } from "./components/shell";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <Shell><Outlet /></Shell>
    </QueryClientProvider>
  ),
});
// child routes: / (dashboard), /companies, /companies/$companyId, /contacts, /contacts/$contactId
// assembled with createRoute({ getParentRoute: () => rootRoute, path, component }) and
export const router = createRouter({
  routeTree,
  basepath: basePath() === "/" ? undefined : basePath(),
});
```

`queries.ts`: typed fetch wrappers over the existing `apiUrl()` — `useCompanies(q, archived)`, `useCompany(id)`, `useCreateCompany()`, `useUpdateCompany()`, `useArchiveCompany()`, mirrored for contacts, plus `useNotes`, `useFiles`, `useEvents`, `useUsers`, `useSearch(q)` (the mutation hooks invalidate the relevant query keys). All parse responses with the shared schemas — a contract drift fails loudly in dev.

`shell.tsx`: sidebar nav (Companies, Contacts) via router `Link`, header slot for search (Task 10), `data-testid="shell"`.

UI primitives: small Tailwind-styled wrappers (Button variants, Input, Textarea, Dialog/Select/Tabs on Radix, Table). Keep each under ~60 lines; no theming system.

Verify: `npm run build` (root) succeeds; bundle grows but stays under 400 kB gzipped; Phase 0 e2e still passes (`npm run test:e2e` after build). Commit: `feat(web): app foundation with router, query and tailwind`.

---

### Task 9: Companies + contacts pages

**Files:** Create `src/pages/{companies,company-detail,contacts,contact-detail}.tsx`, `src/components/{entity-table,field-card,owner-select}.tsx`. Wire into `router.tsx`.

- `entity-table.tsx`: generic list — columns prop, rows, `onRowClick` navigate, header with filter input (`?q=` state), archived toggle, New button opening a Dialog whose form is passed in. `data-testid="entity-table"`.
- `field-card.tsx`: label/value grid; click a value to edit inline (Input appears, save on blur or Enter via the update mutation, Escape cancels). Archived records render read-only with an Unarchive button. `data-testid="field-{name}"`.
- `owner-select.tsx`: Radix Select fed by `useUsers()`, value `ownerUserId`, "Unassigned" option for null.
- Companies list: columns name / owner / updated. New dialog: name only (everything else on the detail page). Company detail: field card (name, domain, website, phone, address, industry, owner), contacts section listing `useContacts({ companyId })` with links, right-rail placeholder (Task 10).
- Contacts list: columns name (first + last) / company / owner. New dialog: first name + optional company select. Contact detail: field card including emails/phones as comma-separated editable text (split/trim/filter on save — invalid emails surface the 400 from the API as an inline error), company link.
- Archive button on both detail pages; archived list rows show an "archived" badge.

Verify in a browser: `./scripts/remote.sh 'npm run build'` then on the server `PGHOST=/run/postgresql DATABASE_URL=postgres:///conduit_dev CONDUIT_DEV_USER=chris WEB_ROOT=$PWD/packages/web/dist PORT=3000 node packages/api/dist/server.js` and click through create/edit/archive for both entities. Commit: `feat(web): companies and contacts pages`.

---

### Task 10: Right rail + global search UI

**Files:** Create `src/components/rail/{timeline,notes,files}.tsx`, `src/components/search.tsx`. Modify the two detail pages and `shell.tsx`.

- Right rail: Radix Tabs (Timeline / Notes / Files), props `{ companyId?: string; contactId?: string }`.
  - Timeline: `useEvents` — icon per verb, actor username, relative time, payload summary ("updated phone, industry" from `payload.changed`; note preview for `note_added`; filename for `file_attached`). `data-testid="timeline"`.
  - Notes: textarea + Add button (`useCreateNote` invalidates events too), list newest-first with author and time. `data-testid="notes"`.
  - Files: file input + drag-drop zone posting multipart, list with name/size/uploader, download link (`href={apiUrl(\`/files/\${id}/download\`)}`). `data-testid="files"`.
- `search.tsx` in the header: input debounced 200ms driving `useSearch`; dropdown grouped Companies / Contacts / Notes with snippets; ArrowUp/Down + Enter navigation; Escape closes; click or Enter navigates to the record (notes navigate to their parent entity). `data-testid="global-search"`.

Commit: `feat(web): timeline, notes, files rail and global search`.

---

### Task 11: Playwright journey

**Files:** Create `e2e/crm.spec.ts`. Modify `.github/workflows/test.yml` only if a longer timeout is needed.

One serial describe running the full journey against a fresh DB (the e2e workflow's Postgres is per-run; locally, truncate first via a `beforeAll` hitting a helper or psql):

1. Create company "Acme Biotech" via the New dialog; appears in the list.
2. Open it; inline-edit industry to "biotech"; timeline shows created + updated.
3. Create contact "Ann Verhoeven" linked to Acme from the contacts page; company detail lists her.
4. Add note "Met Ann at the Utrecht conference" on the contact; notes tab and timeline show it.
5. Upload a small text file on the company; files tab lists it; download returns identical bytes.
6. Global search: "acme" finds the company, "verhoeven" the contact, "utrecht" the note with snippet; Enter navigates.
7. Archive Acme; gone from the default list, visible with the archived toggle, detail page still loads read-only with Unarchive.
8. Unarchive; back in the list.

Run `./scripts/remote.sh 'npm run build && npm run test:e2e'` — all scenarios plus the 2 Phase 0 tests pass. Commit: `test: phase 1 CRM journey`.

---

### Task 12: Release 0.2.0 and live upgrade

- [ ] Bump versions: root/workspace `package.json`s to `0.2.0`, `manifest.toml` to `0.2.0~ynh1`.
- [ ] Full suite + typecheck + e2e green on the server; push branch; CI green.
- [ ] Merge `phase-1-crm-core` into `main` (ff), push.
- [ ] Tag `v0.2.0`, push tag; wait for the Release workflow; fetch the asset's sha256.
- [ ] Update `manifest.toml` sources url (`v0.2.0/conduit-0.2.0.tar.gz`) + sha256 on main; push.
- [ ] Hand Chris the upgrade command (needs sudo): `ssh -t "$(cat .conduit-remote)" 'sudo yunohost app upgrade conduit -u https://github.com/chriswilson2020/conduit_ynh'` — verify `/api/health` reports 0.2.0, the Phase 0 user row survives, and a company created in the live UI persists a service restart.
