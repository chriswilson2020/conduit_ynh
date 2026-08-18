import { and, desc, eq } from "drizzle-orm";
import type { CreateNoteInput, Note } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, events, notes, type NoteRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";

function toNote(row: NoteRow): Note {
  return {
    id: row.id, body: row.body, authorUserId: row.authorUserId,
    companyId: row.companyId, contactId: row.contactId,
    createdAt: row.createdAt.toISOString(),
  };
}

// CreateNoteInput's zod refine guarantees exactly one of companyId/contactId at
// parse time (the route layer, not yet implemented); this only decides which one
// to check.
//
// Reading via `db` outside the transaction (rather than `tx` inside it) is safe
// for existence the same way `assertCompanyExists` in contacts.ts is safe: both
// companies and contacts are archive-only, never hard-deleted, so an existence
// check outside the transaction cannot go stale. If a later phase adds hard
// delete, this needs to move inside the transaction to close the race instead of
// silently going stale.
//
// The archived check is a different, weaker guarantee than the existence check
// above: archived-at is a mutable flag, not a monotonic fact, so this read can go
// stale. Worst case: the target is archived microseconds after this SELECT and
// before the insert below, leaving a stray note on a now-archived record. That is
// accepted as low-stakes at this scale (a single misplaced note, not data
// corruption); a `SELECT ... FOR SHARE` here would close the window if it ever
// stops being acceptable.
async function assertNoteTargetActive(db: Database, input: CreateNoteInput): Promise<void> {
  if (input.companyId != null) {
    const [row] = await db.select({ archivedAt: companies.archivedAt })
      .from(companies).where(eq(companies.id, input.companyId));
    if (row === undefined) throw new NotFoundError("company", input.companyId);
    if (row.archivedAt !== null) throw new ArchivedError("company", input.companyId);
  } else if (input.contactId != null) {
    const [row] = await db.select({ archivedAt: contacts.archivedAt })
      .from(contacts).where(eq(contacts.id, input.contactId));
    if (row === undefined) throw new NotFoundError("contact", input.contactId);
    if (row.archivedAt !== null) throw new ArchivedError("contact", input.contactId);
  }
}

export async function createNote(db: Database, actorId: string, input: CreateNoteInput): Promise<Note> {
  await assertNoteTargetActive(db, input);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(notes).values({
      body: input.body, authorUserId: actorId,
      companyId: input.companyId ?? null, contactId: input.contactId ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    // Array.from splits on Unicode code points, not UTF-16 code units, so a
    // surrogate-pair character (e.g. most emoji) straddling index 120 stays intact
    // instead of tearing into a lone surrogate that Postgres would store as U+FFFD.
    const preview = Array.from(input.body).slice(0, 120).join("");
    await tx.insert(events).values({
      verb: "note_added", actorUserId: actorId,
      companyId: row.companyId, contactId: row.contactId,
      payload: { noteId: row.id, preview },
    });
    return toNote(row);
  });
}

export interface ListNotesOptions { companyId?: string; contactId?: string; }

// Unbounded on purpose: Phase 1 assumes a single record's notes stay small enough
// to return in one page. Revisit with keyset pagination (and an index on
// companyId/contactId) if that assumption stops holding.
export async function listNotes(db: Database, opts: ListNotesOptions): Promise<Note[]> {
  const where = [];
  if (opts.companyId) where.push(eq(notes.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(notes.contactId, opts.contactId));
  const rows = await db.select().from(notes).where(and(...where))
    .orderBy(desc(notes.createdAt), desc(notes.id));
  return rows.map(toNote);
}
