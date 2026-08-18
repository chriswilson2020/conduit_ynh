import { and, desc, eq, ilike, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Contact, CreateContactInput, UpdateContactInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { contacts, companies, events, type ContactRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { decodeCursor, encodeCursor, escapeLike } from "./pagination.js";
import { publish } from "./sse.js";

/** Invalidation keys every contact mutator publishes after its transaction commits. */
function publishContactHint(id: string): void {
  publish({ keys: [["contacts"], ["contact", id], ["events"], ["search"]] });
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id, firstName: row.firstName, lastName: row.lastName, companyId: row.companyId,
    emails: row.emails, phones: row.phones, jobTitle: row.jobTitle, ownerUserId: row.ownerUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// A companyId that does not exist would otherwise surface as a raw FK violation
// from Postgres. Pre-checking here turns that into the same NotFoundError shape
// every other unknown-id path already produces. An archived company is a valid
// link target on purpose: archiving hides a company from default listings, it
// does not sever contacts already (or newly) pointed at it.
//
// Reading via `db` outside the transaction (rather than `tx` inside it) is safe
// only because company existence is monotonic here: companies are archive-only,
// never hard-deleted, and an archived company still counts as existing. If a
// later phase adds hard delete, this check needs to move inside the transaction
// to close the race instead of silently going stale.
async function assertCompanyExists(db: Database, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (row === undefined) throw new NotFoundError("company", companyId);
}

export async function createContact(db: Database, actorId: string, input: CreateContactInput): Promise<Contact> {
  if (input.companyId != null) await assertCompanyExists(db, input.companyId);
  const contact = await db.transaction(async (tx) => {
    const [row] = await tx.insert(contacts).values({ ...input }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await tx.insert(events).values({ verb: "created", actorUserId: actorId, contactId: row.id, payload: {} });
    return toContact(row);
  });
  publishContactHint(contact.id);
  return contact;
}

async function mustGet(db: Database, id: string): Promise<ContactRow> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (row === undefined) throw new NotFoundError("contact", id);
  return row;
}

// Arrays and plain objects compare by order-sensitive JSON value; scalars by !==.
// Structural detection rather than a field-name whitelist, so a future field
// (e.g. the deferred `custom` jsonb) cannot silently fall back to reference
// inequality and misreport every same-value patch as a change. `null` must stay
// scalar-compared -- `typeof null === "object"` -- hence the `!== null` guards.
// emails/phones default to `[]` and are never null, but nullable scalar fields
// (lastName, jobTitle, companyId, ownerUserId) pass through this same helper.
function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

export async function updateContact(db: Database, actorId: string, id: string, patch: UpdateContactInput): Promise<Contact> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("contact", id);
  if (patch.companyId != null) await assertCompanyExists(db, patch.companyId);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  const changed = (Object.keys(patch) as (keyof UpdateContactInput)[])
    .filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toContact(existing);

  const contact = await db.transaction(async (tx) => {
    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGet read above and this UPDATE yields zero rows
    // here instead of silently mutating an archived record.
    const [row] = await tx.update(contacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), isNull(contacts.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(contacts).where(eq(contacts.id, id));
      throw recheck === undefined ? new NotFoundError("contact", id) : new ArchivedError("contact", id);
    }
    await tx.insert(events).values({ verb: "updated", actorUserId: actorId, contactId: id, payload: { changed } });
    return toContact(row);
  });
  publishContactHint(contact.id);
  return contact;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Contact> {
  await mustGet(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state already
  // matched what was requested, so nothing changed) -- that branch must not
  // publish, same as any other no-op short-circuit in this file.
  const { contact, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
    // requires the row currently unarchived, unarchiving requires it currently
    // archived. Zero rows back means the state already matched what was requested
    // (either a concurrent call got there first, or this call is a no-op repeat),
    // so re-select and return the current row instead of emitting a duplicate event.
    const [row] = await tx.update(contacts)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(contacts.id, id),
        archived ? isNull(contacts.archivedAt) : isNotNull(contacts.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(contacts).where(eq(contacts.id, id));
      if (recheck === undefined) throw new NotFoundError("contact", id);
      return { contact: toContact(recheck), wrote: false };
    }
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId, contactId: id, payload: {},
    });
    return { contact: toContact(row), wrote: true };
  });
  if (wrote) publishContactHint(contact.id);
  return contact;
}
export const archiveContact = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveContact = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

export async function getContact(db: Database, id: string): Promise<Contact | null> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row === undefined ? null : toContact(row);
}

export interface ListOptions { q?: string; companyId?: string; archived?: boolean; cursor?: string; limit?: number; }

export async function listContacts(db: Database, opts: ListOptions): Promise<{ items: Contact[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const where = [opts.archived ? isNotNull(contacts.archivedAt) : isNull(contacts.archivedAt)];
  if (opts.companyId) where.push(eq(contacts.companyId, opts.companyId));
  if (opts.q) {
    const p = `%${escapeLike(opts.q)}%`;
    // Non-null assertion: `or` only returns undefined when given zero conditions.
    // All three branches here are always present, so this is safe as written, but it
    // stops being safe if a future edit makes any branch conditional. Do not extend
    // this call with an optional/conditional argument without rechecking.
    where.push(or(
      ilike(contacts.firstName, p),
      ilike(contacts.lastName, p),
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${p})`,
    )!);
  }
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    // Non-null assertion: `or` only returns undefined when given zero conditions.
    // Both branches here are always present, so this is safe as written, but it
    // stops being safe if a future edit makes either branch conditional. Do not
    // extend this call with an optional/conditional argument without rechecking.
    where.push(or(
      lt(contacts.createdAt, new Date(cur.createdAt)),
      and(eq(contacts.createdAt, new Date(cur.createdAt)), lt(contacts.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(contacts).where(and(...where))
    .orderBy(desc(contacts.createdAt), desc(contacts.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toContact),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
