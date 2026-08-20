import { and, asc, eq, isNull, isNotNull } from "drizzle-orm";
import type { CreateEmailTemplateInput, EmailTemplate, UpdateEmailTemplateInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { emailTemplates, type EmailTemplateRow } from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { sanitizeMailHtml } from "./mail-content.js";
import { publish } from "./sse.js";

/**
 * Shared email templates: the compose dialog's template picker, edited in
 * Settings. Deliberately NOT owner-scoped -- email_templates has no owner
 * column at all (see db/schema.ts) because a template is house boilerplate
 * ("our standard intro"), not personal correspondence, and the team wants
 * one copy of it rather than one per salesperson. Every authenticated user
 * may therefore read, write and archive every template; the route layer only
 * enforces that there IS a user.
 *
 * Like every other mail table, templates emit no events-table rows (mail
 * stays out of the CRM timeline per the Phase 4 spec), so the SSE hint below
 * is the only invalidation signal.
 */
function publishTemplatesHint(): void {
  publish({ keys: [["email-templates"]] });
}

function toTemplate(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id, name: row.name, subject: row.subject, bodyHtml: row.bodyHtml,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Sanitize a submitted body through the one shared mail profile (spec,
 * Security: "All HTML (inbound bodies, signatures, templates, compose
 * payloads) sanitized server-side with one shared sanitizer profile"). No
 * cidMap: a template has no attachments and therefore no cid: references to
 * rewrite -- an `<img src="cid:...">` pasted into one is dropped, exactly as
 * an unmapped cid is dropped at ingest.
 *
 * A body that sanitizes away to nothing (a submission that was ONLY script/
 * style/form markup) is refused rather than stored. Two reasons: the stored
 * value has to satisfy the shared emailTemplateSchema, whose bodyHtml is
 * `.min(1)`, so an empty body would produce a row no client could parse
 * back; and a template that renders as nothing is not a template. 409 rather
 * than a 400 because the submission WAS well-formed -- the sanitizer profile
 * is the thing it conflicts with, and the message says so.
 */
function sanitizeBody(bodyHtml: string): string {
  const sanitized = sanitizeMailHtml(bodyHtml);
  if (sanitized.trim() === "") {
    throw new ConflictError(
      "email template", "body",
      "the template body is empty once sanitized; it contained no content the mail sanitizer keeps",
    );
  }
  return sanitized;
}

export interface ListTemplatesOptions {
  /** Archived-only when true, non-archived when false/absent -- the same
   * two-state flag every other list in this codebase uses. */
  archived?: boolean;
}

/** Unbounded and unpaginated, like listTasks/listDeals: a template picker
 * shows every template at once, and a team's boilerplate count is bounded by
 * what humans maintain by hand. */
export async function listTemplates(db: Database, opts: ListTemplatesOptions = {}): Promise<EmailTemplate[]> {
  const rows = await db.select().from(emailTemplates)
    .where(opts.archived ? isNotNull(emailTemplates.archivedAt) : isNull(emailTemplates.archivedAt))
    // By name, then id: the picker is an alphabetical list, and the id
    // tiebreaker keeps two templates sharing a name in a stable order.
    .orderBy(asc(emailTemplates.name), asc(emailTemplates.id));
  return rows.map(toTemplate);
}

export async function getTemplate(db: Database, id: string): Promise<EmailTemplate> {
  const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
  if (row === undefined) throw new NotFoundError("email template", id);
  return toTemplate(row);
}

export async function createTemplate(db: Database, input: CreateEmailTemplateInput): Promise<EmailTemplate> {
  const [row] = await db.insert(emailTemplates).values({
    name: input.name,
    subject: input.subject ?? "",
    bodyHtml: sanitizeBody(input.bodyHtml),
  }).returning();
  if (row === undefined) throw new Error("createTemplate: insert returned no row");
  publishTemplatesHint();
  return toTemplate(row);
}

export async function updateTemplate(
  db: Database, id: string, patch: UpdateEmailTemplateInput,
): Promise<EmailTemplate> {
  const [existing] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
  if (existing === undefined) throw new NotFoundError("email template", id);
  if (existing.archivedAt !== null) throw new ArchivedError("email template", id);

  const values: Partial<typeof emailTemplates.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.subject !== undefined) values.subject = patch.subject;
  if (patch.bodyHtml !== undefined) values.bodyHtml = sanitizeBody(patch.bodyHtml);

  // archived_at IS NULL in the WHERE makes the guard atomic against a
  // concurrent archive, the same idiom updateTask uses: the read above is
  // what produces the friendly error, this is what makes it true.
  const [row] = await db.update(emailTemplates).set(values)
    .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.archivedAt))).returning();
  if (row === undefined) throw new ArchivedError("email template", id);
  publishTemplatesHint();
  return toTemplate(row);
}

async function setArchived(db: Database, id: string, archived: boolean): Promise<EmailTemplate> {
  const [row] = await db.update(emailTemplates)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(and(
      eq(emailTemplates.id, id),
      archived ? isNull(emailTemplates.archivedAt) : isNotNull(emailTemplates.archivedAt),
    )).returning();
  if (row !== undefined) {
    publishTemplatesHint();
    return toTemplate(row);
  }
  // No row updated: either it does not exist, or it is already in the state
  // being asked for. Archive/unarchive are idempotent everywhere else in this
  // codebase, so the second case returns the row rather than erroring.
  const [existing] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
  if (existing === undefined) throw new NotFoundError("email template", id);
  return toTemplate(existing);
}

export function archiveTemplate(db: Database, id: string): Promise<EmailTemplate> {
  return setArchived(db, id, true);
}
export function unarchiveTemplate(db: Database, id: string): Promise<EmailTemplate> {
  return setArchived(db, id, false);
}
