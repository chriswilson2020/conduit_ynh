import { and, desc, eq, ilike, isNull, isNotNull, lt, or } from "drizzle-orm";
import type { Company, CreateCompanyInput, UpdateCompanyInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, events, type CompanyRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { decodeCursor, encodeCursor, escapeLike } from "./pagination.js";
import { publish } from "./sse.js";

/** Invalidation keys every company mutator publishes after its transaction commits. */
function publishCompanyHint(id: string): void {
  publish({ keys: [["companies"], ["company", id], ["events"], ["search"]] });
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id, name: row.name, domain: row.domain, website: row.website, phone: row.phone,
    address: row.address, industry: row.industry, ownerUserId: row.ownerUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCompany(db: Database, actorId: string, input: CreateCompanyInput): Promise<Company> {
  const company = await db.transaction(async (tx) => {
    const [row] = await tx.insert(companies).values({ ...input }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await tx.insert(events).values({ verb: "created", actorUserId: actorId, companyId: row.id, payload: {} });
    return toCompany(row);
  });
  publishCompanyHint(company.id);
  return company;
}

async function mustGet(db: Database, id: string): Promise<CompanyRow> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (row === undefined) throw new NotFoundError("company", id);
  return row;
}

export async function updateCompany(db: Database, actorId: string, id: string, patch: UpdateCompanyInput): Promise<Company> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("company", id);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  // Scalar equality only: a later copy of this file with an array/object field
  // (e.g. contacts' emails/phones) needs order-sensitive JSON equality here
  // instead of !==, or a same-value patch with reordered array elements will be
  // misreported as unchanged.
  const changed = (Object.keys(patch) as (keyof UpdateCompanyInput)[])
    .filter((k) => patch[k] !== undefined && patch[k] !== existing[k]);
  if (changed.length === 0) return toCompany(existing);

  const company = await db.transaction(async (tx) => {
    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGet read above and this UPDATE yields zero rows
    // here instead of silently mutating an archived record.
    const [row] = await tx.update(companies)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(companies.id, id), isNull(companies.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(companies).where(eq(companies.id, id));
      throw recheck === undefined ? new NotFoundError("company", id) : new ArchivedError("company", id);
    }
    await tx.insert(events).values({ verb: "updated", actorUserId: actorId, companyId: id, payload: { changed } });
    return toCompany(row);
  });
  publishCompanyHint(company.id);
  return company;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Company> {
  await mustGet(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state already
  // matched what was requested, so nothing changed) -- that branch must not
  // publish, same as any other no-op short-circuit in this file.
  const { company, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
    // requires the row currently unarchived, unarchiving requires it currently
    // archived. Zero rows back means the state already matched what was requested
    // (either a concurrent call got there first, or this call is a no-op repeat),
    // so re-select and return the current row instead of emitting a duplicate event.
    const [row] = await tx.update(companies)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(companies.id, id),
        archived ? isNull(companies.archivedAt) : isNotNull(companies.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(companies).where(eq(companies.id, id));
      if (recheck === undefined) throw new NotFoundError("company", id);
      return { company: toCompany(recheck), wrote: false };
    }
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId, companyId: id, payload: {},
    });
    return { company: toCompany(row), wrote: true };
  });
  if (wrote) publishCompanyHint(company.id);
  return company;
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
    // Non-null assertion: `or` only returns undefined when given zero conditions.
    // Both branches here are always present, so this is safe as written, but it
    // stops being safe if a future edit makes either branch conditional. Do not
    // extend this call with an optional/conditional argument without rechecking.
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
