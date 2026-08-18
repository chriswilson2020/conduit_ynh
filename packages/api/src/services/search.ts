import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { SearchResults } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, notes, deals } from "../db/schema.js";
import { escapeLike } from "./pagination.js";

const LIMIT_PER_TYPE = 8;

function snippet(body: string, q: string): string {
  const points = Array.from(body);
  const lowerBody = body.toLowerCase();
  const at = lowerBody.indexOf(q.toLowerCase());
  // ILIKE (locale-aware, in Postgres) and toLowerCase (Unicode default folding)
  // can disagree (Turkish dotless I, ligatures). When they do, indexOf misses and
  // we fall back to a plain prefix -- a real excerpt of the matched note, just
  // without the match centred. Graceful, not exact.
  if (at < 0) return points.slice(0, 120).join("");
  // Convert the code-unit match offset to a code-point offset so the +/-60 window
  // slices between characters, never through a surrogate pair.
  const pointAt = Array.from(body.slice(0, at)).length;
  const qPoints = Array.from(q).length;
  const start = Math.max(0, pointAt - 60);
  const end = Math.min(points.length, pointAt + qPoints + 60);
  return `${start > 0 ? "..." : ""}${points.slice(start, end).join("")}${end < points.length ? "..." : ""}`;
}

export async function search(db: Database, q: string): Promise<SearchResults> {
  const p = `%${escapeLike(q)}%`;
  const [companyRows, contactRows, noteRows, dealRows] = await Promise.all([
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
    //
    // Every ILIKE here (this query and the two above) is an unindexed sequential
    // scan -- fine at Phase 1 scale with LIMIT 8, but revisit with a pg_trgm GIN
    // index on notes.body (and the other searched columns) if search slows as
    // data grows.
    db.select({ id: notes.id, companyId: notes.companyId, contactId: notes.contactId, body: notes.body })
      .from(notes)
      .leftJoin(companies, eq(notes.companyId, companies.id))
      .leftJoin(contacts, eq(notes.contactId, contacts.id))
      .where(and(
        ilike(notes.body, p),
        sql`COALESCE(${companies.archivedAt}, ${contacts.archivedAt}) IS NULL`,
      )).limit(LIMIT_PER_TYPE),
    // archivedAt excluded like every other group, but status is deliberately
    // NOT filtered: a won or lost deal must stay findable by title -- closing
    // a deal shouldn't make it vanish from search, and salespeople routinely
    // look up a closed deal by name (checking terms, reopening a lost one).
    // Only archiving (an explicit, separate lifecycle action) hides a deal
    // from search, the same rule every other group in this file follows.
    db.select({ id: deals.id, title: deals.title }).from(deals)
      .where(and(isNull(deals.archivedAt), ilike(deals.title, p))).limit(LIMIT_PER_TYPE),
  ]);
  return {
    companies: companyRows,
    contacts: contactRows,
    notes: noteRows.map((n) => ({ id: n.id, companyId: n.companyId, contactId: n.contactId, snippet: snippet(n.body, q) })),
    deals: dealRows,
  };
}
