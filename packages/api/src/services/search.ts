import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
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
    // LEFT JOINs to both possible parents rather than a subquery: the DB CHECK
    // (notes_exactly_one_entity) guarantees exactly one of companyId/contactId is
    // set, so exactly one join matches and COALESCE picks that parent's
    // archivedAt. A note whose parent is archived must not surface in search even
    // though the note row itself has no archivedAt of its own -- this is the fix
    // for the spec gap in the original draft, which filtered notes.body only and
    // let notes on archived companies/contacts leak through.
    db.select({ id: notes.id, companyId: notes.companyId, contactId: notes.contactId, body: notes.body })
      .from(notes)
      .leftJoin(companies, eq(notes.companyId, companies.id))
      .leftJoin(contacts, eq(notes.contactId, contacts.id))
      .where(and(
        ilike(notes.body, p),
        sql`COALESCE(${companies.archivedAt}, ${contacts.archivedAt}) IS NULL`,
      )).limit(LIMIT_PER_TYPE),
  ]);
  return {
    companies: companyRows,
    contacts: contactRows,
    notes: noteRows.map((n) => ({ id: n.id, companyId: n.companyId, contactId: n.contactId, snippet: snippet(n.body, q) })),
  };
}
