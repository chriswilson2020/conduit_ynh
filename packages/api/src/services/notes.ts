import { and, desc, eq } from "drizzle-orm";
import type { CreateNoteInput, Note } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, deals, events, notes, type NoteRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { publish } from "./sse.js";

function toNote(row: NoteRow): Note {
  return {
    id: row.id, body: row.body, authorUserId: row.authorUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    createdAt: row.createdAt.toISOString(),
  };
}

// CreateNoteInput's zod refine guarantees exactly one of companyId/contactId/
// dealId at parse time (the route layer); this only decides which one to
// check. Returns the deal's own companyId when the target is a deal (null if
// the deal has none) -- createNote below needs it to stamp the note_added
// event's companyId column, since the note row itself only ever carries
// companyId directly for a company target, never for a deal one. Returns null
// for the company/contact branches: their companyId already lands on the note
// row itself, so createNote has nothing extra to OR in.
//
// Reading via `db` outside the transaction (rather than `tx` inside it) is safe
// for existence the same way `assertCompanyExists` in contacts.ts is safe:
// companies, contacts, and deals are all archive-only, never hard-deleted, so an
// existence check outside the transaction cannot go stale. If a later phase adds
// hard delete, this needs to move inside the transaction to close the race
// instead of silently going stale.
//
// The archived check is a different, weaker guarantee than the existence check
// above: archived-at is a mutable flag, not a monotonic fact, so this read can go
// stale. Worst case: the target is archived microseconds after this SELECT and
// before the insert below, leaving a stray note on a now-archived record. That is
// accepted as low-stakes at this scale (a single misplaced note, not data
// corruption); a `SELECT ... FOR SHARE` here would close the window if it ever
// stops being acceptable.
//
// A deal's status (open/won/lost) is deliberately NOT checked here, only its
// archivedAt: a closed deal is still a perfectly valid place to leave
// commentary (e.g. "customer asked about a discount post-close"), the same way
// deals.ts's own assertCompanyExists/assertContactExists treat an archived
// company/contact as still a valid deal target -- only the deal's own archive
// flag (an explicit, separate lifecycle action) blocks new notes/files.
async function assertNoteTargetActive(db: Database, input: CreateNoteInput): Promise<string | null> {
  if (input.companyId != null) {
    const [row] = await db.select({ archivedAt: companies.archivedAt })
      .from(companies).where(eq(companies.id, input.companyId));
    if (row === undefined) throw new NotFoundError("company", input.companyId);
    if (row.archivedAt !== null) throw new ArchivedError("company", input.companyId);
    return null;
  } else if (input.contactId != null) {
    const [row] = await db.select({ archivedAt: contacts.archivedAt })
      .from(contacts).where(eq(contacts.id, input.contactId));
    if (row === undefined) throw new NotFoundError("contact", input.contactId);
    if (row.archivedAt !== null) throw new ArchivedError("contact", input.contactId);
    return null;
  } else if (input.dealId != null) {
    const [row] = await db.select({ archivedAt: deals.archivedAt, companyId: deals.companyId })
      .from(deals).where(eq(deals.id, input.dealId));
    if (row === undefined) throw new NotFoundError("deal", input.dealId);
    if (row.archivedAt !== null) throw new ArchivedError("deal", input.dealId);
    return row.companyId;
  }
  return null;
}

export async function createNote(db: Database, actorId: string, input: CreateNoteInput): Promise<Note> {
  const dealCompanyId = await assertNoteTargetActive(db, input);
  const note = await db.transaction(async (tx) => {
    const [row] = await tx.insert(notes).values({
      body: input.body, authorUserId: actorId,
      companyId: input.companyId ?? null, contactId: input.contactId ?? null, dealId: input.dealId ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    // Array.from splits on Unicode code points, not UTF-16 code units, so a
    // surrogate-pair character (e.g. most emoji) straddling index 120 stays intact
    // instead of tearing into a lone surrogate that Postgres would store as U+FFFD.
    const preview = Array.from(input.body).slice(0, 120).join("");
    await tx.insert(events).values({
      verb: "note_added", actorUserId: actorId,
      // row.companyId is only ever set for a company-target note -- ?? falls
      // through to dealCompanyId for a deal-target note (the deal's own
      // companyId, possibly still null), matching deals.ts's convention of
      // carrying both dealId and companyId on a deal's events so it surfaces
      // on both the deal's and its company's timeline.
      companyId: row.companyId ?? dealCompanyId, contactId: row.contactId, dealId: row.dealId,
      payload: { noteId: row.id, preview },
    });
    return toNote(row);
  });
  publish({ keys: [["notes"], ["events"], ["search"]] });
  return note;
}

export interface ListNotesOptions { companyId?: string; contactId?: string; dealId?: string; }

// Unbounded on purpose: Phase 1 assumes a single record's notes stay small enough
// to return in one page. Revisit with keyset pagination (and an index on
// companyId/contactId/dealId) if that assumption stops holding.
export async function listNotes(db: Database, opts: ListNotesOptions): Promise<Note[]> {
  const where = [];
  if (opts.companyId) where.push(eq(notes.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(notes.contactId, opts.contactId));
  if (opts.dealId) where.push(eq(notes.dealId, opts.dealId));
  const rows = await db.select().from(notes).where(and(...where))
    .orderBy(desc(notes.createdAt), desc(notes.id));
  return rows.map(toNote);
}
