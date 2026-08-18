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
// The archived check is a softer guarantee: unlike a contact's companyId link
// (where an archived company is a valid target), a note's target must be
// unarchived at creation time. Reading that flag outside the transaction leaves a
// narrow TOCTOU window -- the target could be archived between this check and the
// insert below -- which is accepted here at the same tolerance the rest of this
// phase uses for pre-transaction reads.
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
    await tx.insert(events).values({
      verb: "note_added", actorUserId: actorId,
      companyId: row.companyId, contactId: row.contactId,
      payload: { noteId: row.id, preview: input.body.slice(0, 120) },
    });
    return toNote(row);
  });
}

export interface ListNotesOptions { companyId?: string; contactId?: string; }

export async function listNotes(db: Database, opts: ListNotesOptions): Promise<Note[]> {
  const where = [];
  if (opts.companyId) where.push(eq(notes.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(notes.contactId, opts.contactId));
  const rows = await db.select().from(notes).where(and(...where))
    .orderBy(desc(notes.createdAt), desc(notes.id));
  return rows.map(toNote);
}
