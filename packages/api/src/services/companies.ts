import { and, desc, eq, ilike, isNull, isNotNull, lt, or } from "drizzle-orm";
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
