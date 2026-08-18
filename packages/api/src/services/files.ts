import { and, desc, eq } from "drizzle-orm";
import type { FileMeta } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, events, files, type FileRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { publish } from "./sse.js";

export function toFileMeta(row: FileRow): FileMeta {
  return {
    id: row.id, originalName: row.originalName, mime: row.mime, sizeBytes: row.sizeBytes,
    sha256: row.sha256, uploaderUserId: row.uploaderUserId,
    companyId: row.companyId, contactId: row.contactId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AttachFileInput {
  originalName: string; mime: string; sizeBytes: number; sha256: string;
  companyId?: string; contactId?: string;
}

// Exactly-one-entity is the caller's job: the route layer enforces it via Zod at
// parse time, and the files_exactly_one_entity DB CHECK backstops any direct-write
// path. This only decides which one (if either) to pre-check.
//
// Reading via `db` outside the transaction (rather than `tx` inside it) is safe for
// existence the same way `assertCompanyExists` in contacts.ts is safe: both companies
// and contacts are archive-only, never hard-deleted, so an existence check outside the
// transaction cannot go stale. If a later phase adds hard delete, this needs to move
// inside the transaction to close the race instead of silently going stale.
//
// The archived check is a different, weaker guarantee than the existence check above:
// archived-at is a mutable flag, not a monotonic fact, so this read can go stale.
// Worst case: the target is archived microseconds after this SELECT and before the
// insert below, leaving a stray file attached to a now-archived record. That is
// accepted as low-stakes at this scale (a single misplaced attachment, not data
// corruption); a `SELECT ... FOR SHARE` here would close the window if it ever stops
// being acceptable.
async function assertFileTargetActive(db: Database, input: AttachFileInput): Promise<void> {
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

export async function attachFile(db: Database, actorId: string, meta: AttachFileInput): Promise<FileMeta> {
  await assertFileTargetActive(db, meta);
  const file = await db.transaction(async (tx) => {
    const [row] = await tx.insert(files).values({
      originalName: meta.originalName, mime: meta.mime, sizeBytes: meta.sizeBytes, sha256: meta.sha256,
      uploaderUserId: actorId, companyId: meta.companyId ?? null, contactId: meta.contactId ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await tx.insert(events).values({
      verb: "file_attached", actorUserId: actorId,
      companyId: row.companyId, contactId: row.contactId,
      payload: { fileId: row.id, originalName: row.originalName },
    });
    return toFileMeta(row);
  });
  publish({ keys: [["files"], ["events"]] });
  return file;
}

export interface ListFilesOptions { companyId?: string; contactId?: string; }

// Unbounded on purpose: Phase 1 assumes a single record's files stay small enough to
// return in one page. Revisit with keyset pagination (and an index on
// companyId/contactId) if that assumption stops holding.
export async function listFiles(db: Database, opts: ListFilesOptions): Promise<FileMeta[]> {
  const where = [];
  if (opts.companyId) where.push(eq(files.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(files.contactId, opts.contactId));
  const rows = await db.select().from(files).where(and(...where))
    .orderBy(desc(files.createdAt), desc(files.id));
  return rows.map(toFileMeta);
}

export async function getFile(db: Database, id: string): Promise<FileMeta | null> {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row === undefined ? null : toFileMeta(row);
}
