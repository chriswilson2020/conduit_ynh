import { and, desc, eq } from "drizzle-orm";
import type { FileMeta } from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, meetings, projects, events, files, type FileRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { publish } from "./sse.js";

export function toFileMeta(row: FileRow): FileMeta {
  return {
    id: row.id, originalName: row.originalName, mime: row.mime, sizeBytes: row.sizeBytes,
    sha256: row.sha256, uploaderUserId: row.uploaderUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId, projectId: row.projectId,
    meetingId: row.meetingId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AttachFileInput {
  originalName: string; mime: string; sizeBytes: number; sha256: string;
  companyId?: string; contactId?: string; dealId?: string; projectId?: string;
  /**
   * PHASE 9, AND NOT REACHABLE FROM THE UPLOAD ROUTE. The only caller that passes
   * it is services/documents.ts issuing a meeting summary, whose rendered PDF has
   * to live on the record its `documents` row says it belongs to. See
   * db/schema.ts's `files` table for why a meeting became a fifth parent here and
   * did not become one on `notes`.
   */
  meetingId?: string;
}

/**
 * The record links an event about this file should carry, which is not always the
 * file's own.
 *
 * A file on a DEAL emits a `file_attached` event carrying both the deal and the
 * deal's company, so the entry lands on both timelines -- that is the dual stamp
 * deals and tasks already use, and `linkedCompanyId` was the one-field version of
 * it. A file on a MEETING needs the general case: a meeting carries any subset of
 * company, contact, deal and project (`meetings_has_link` is at-least-one, not
 * exactly-one), and an event stamped with only one of them would be missing from
 * the other timelines the meeting itself appears on.
 *
 * WIDENED FROM `string | null` RATHER THAN ADDED BESIDE IT, so there is one answer
 * to "what does an event about this file link to" instead of two that agree today.
 * The four existing branches return exactly what they returned before: a company
 * id or nothing.
 */
interface EventLinks {
  companyId: string | null;
  contactId: string | null;
  dealId: string | null;
  projectId: string | null;
}

const NO_LINKS: EventLinks = { companyId: null, contactId: null, dealId: null, projectId: null };

// Exactly-one-entity is the caller's job: the route layer enforces it via
// Zod/its own field-count check at parse time, and the
// files_exactly_one_entity DB CHECK backstops any direct-write path. This
// only decides which one (if any) to pre-check.
//
// Reading via `db` outside the transaction (rather than `tx` inside it) is safe for
// existence the same way `assertCompanyExists` in contacts.ts is safe: companies,
// contacts, and deals are all archive-only, never hard-deleted, so an existence
// check outside the transaction cannot go stale. If a later phase adds hard delete,
// this needs to move inside the transaction to close the race instead of silently
// going stale.
//
// The archived check is a different, weaker guarantee than the existence check above:
// archived-at is a mutable flag, not a monotonic fact, so this read can go stale.
// Worst case: the target is archived microseconds after this SELECT and before the
// insert below, leaving a stray file attached to a now-archived record. That is
// accepted as low-stakes at this scale (a single misplaced attachment, not data
// corruption); a `SELECT ... FOR SHARE` here would close the window if it ever stops
// being acceptable.
//
// Mirrors assertNoteTargetActive in notes.ts: a deal's (or project's) status
// (open/won/lost, or active/completed) is deliberately not checked, only its
// archivedAt -- a closed deal still gets attachments (e.g. a signed contract
// on a just-won deal), and a completed project still gets attachments too.
// Returns the deal's or project's own companyId (or null) for those branches
// so attachFile below can stamp it on the file_attached event, same
// reasoning as notes.ts.
async function assertFileTargetActive(db: Database, input: AttachFileInput): Promise<EventLinks> {
  if (input.companyId != null) {
    const [row] = await db.select({ archivedAt: companies.archivedAt })
      .from(companies).where(eq(companies.id, input.companyId));
    if (row === undefined) throw new NotFoundError("company", input.companyId);
    if (row.archivedAt !== null) throw new ArchivedError("company", input.companyId);
    return NO_LINKS;
  } else if (input.contactId != null) {
    const [row] = await db.select({ archivedAt: contacts.archivedAt })
      .from(contacts).where(eq(contacts.id, input.contactId));
    if (row === undefined) throw new NotFoundError("contact", input.contactId);
    if (row.archivedAt !== null) throw new ArchivedError("contact", input.contactId);
    return NO_LINKS;
  } else if (input.dealId != null) {
    const [row] = await db.select({ archivedAt: deals.archivedAt, companyId: deals.companyId })
      .from(deals).where(eq(deals.id, input.dealId));
    if (row === undefined) throw new NotFoundError("deal", input.dealId);
    if (row.archivedAt !== null) throw new ArchivedError("deal", input.dealId);
    return { ...NO_LINKS, companyId: row.companyId };
  } else if (input.projectId != null) {
    const [row] = await db.select({ archivedAt: projects.archivedAt, companyId: projects.companyId })
      .from(projects).where(eq(projects.id, input.projectId));
    if (row === undefined) throw new NotFoundError("project", input.projectId);
    if (row.archivedAt !== null) throw new ArchivedError("project", input.projectId);
    return { ...NO_LINKS, companyId: row.companyId };
  } else if (input.meetingId != null) {
    const [row] = await db.select({
      archivedAt: meetings.archivedAt, companyId: meetings.companyId,
      contactId: meetings.contactId, dealId: meetings.dealId, projectId: meetings.projectId,
    }).from(meetings).where(eq(meetings.id, input.meetingId));
    if (row === undefined) throw new NotFoundError("meeting", input.meetingId);
    // ARCHIVED IS REFUSED HERE TOO, matching all four branches above and
    // issueQuote's refusal of an archived deal. A meeting that HAPPENED can be
    // logged against an archived company (meetings.ts's assertLinkedRecordsExist
    // checks existence only, on purpose) -- but that is about the past. Producing
    // a NEW document against a record somebody has archived is the present, and
    // it is the same act as raising a quote on an archived deal.
    if (row.archivedAt !== null) throw new ArchivedError("meeting", input.meetingId);
    // ALL FOUR OF THE MEETING'S OWN LINKS, which is what makes the `file_attached`
    // entry appear on exactly the timelines the meeting itself appears on. A
    // meeting may carry several, so taking only the company would drop the entry
    // from the deal's timeline -- and a meeting linked to a contact alone has no
    // company at all, which would leave the event on no timeline whatsoever.
    //
    // NOTE WHAT IS NOT STAMPED: events.meeting_id. timeline.ts's attendance
    // widening reaches rows whose meeting_id is set and whose task_id is NULL, and
    // its comment is explicit that this covers "the meeting's OWN lifecycle rows,
    // and only those" -- a contact who merely attended sees the meeting, not
    // everything the meeting spawned. A rendered summary is something it spawned.
    return {
      companyId: row.companyId, contactId: row.contactId,
      dealId: row.dealId, projectId: row.projectId,
    };
  }
  return NO_LINKS;
}

export async function attachFile(db: Database, actorId: string, meta: AttachFileInput): Promise<FileMeta> {
  // Named generically (not dealCompanyId) now that it covers the deal, project
  // and meeting target branches -- see notes.ts's identical linkedCompanyId.
  const linked = await assertFileTargetActive(db, meta);
  const file = await db.transaction(async (tx) => {
    const [row] = await tx.insert(files).values({
      originalName: meta.originalName, mime: meta.mime, sizeBytes: meta.sizeBytes, sha256: meta.sha256,
      uploaderUserId: actorId,
      companyId: meta.companyId ?? null, contactId: meta.contactId ?? null, dealId: meta.dealId ?? null,
      projectId: meta.projectId ?? null, meetingId: meta.meetingId ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await tx.insert(events).values({
      verb: "file_attached", actorUserId: actorId,
      // See createNote's identical companyId fallback in notes.ts for why. The
      // other three fall back the same way since Phase 9: a file attached to a
      // MEETING has none of the four of its own, and the meeting's links are what
      // put the entry on the timelines the meeting is already on.
      companyId: row.companyId ?? linked.companyId, contactId: row.contactId ?? linked.contactId,
      dealId: row.dealId ?? linked.dealId, projectId: row.projectId ?? linked.projectId,
      payload: { fileId: row.id, originalName: row.originalName },
    });
    return toFileMeta(row);
  });
  publish({ keys: [["files"], ["events"]] });
  return file;
}

// NO meetingId FILTER, deliberately, though the column exists. A meeting's own
// PDFs are reached through GET /api/meetings/:id/documents -- the `documents` rows
// are what a client wants (the type, the issue date, whether it is frozen), and the
// file is one field of each. Adding a fifth filter here would be a second way to
// ask a question with a worse answer, and nothing would call it.
export interface ListFilesOptions { companyId?: string; contactId?: string; dealId?: string; projectId?: string; }

// Unbounded on purpose: Phase 1 assumes a single record's files stay small enough to
// return in one page. Revisit with keyset pagination (and an index on
// companyId/contactId/dealId/projectId) if that assumption stops holding.
export async function listFiles(db: Database, opts: ListFilesOptions): Promise<FileMeta[]> {
  const where = [];
  if (opts.companyId) where.push(eq(files.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(files.contactId, opts.contactId));
  if (opts.dealId) where.push(eq(files.dealId, opts.dealId));
  if (opts.projectId) where.push(eq(files.projectId, opts.projectId));
  const rows = await db.select().from(files).where(and(...where))
    .orderBy(desc(files.createdAt), desc(files.id));
  return rows.map(toFileMeta);
}

export async function getFile(db: Database, id: string): Promise<FileMeta | null> {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row === undefined ? null : toFileMeta(row);
}
