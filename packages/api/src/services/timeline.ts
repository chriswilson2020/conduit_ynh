import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Event } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { events, type EventRow } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "./pagination.js";

function toEvent(row: EventRow): Event {
  return {
    id: row.id, verb: row.verb as Event["verb"], actorUserId: row.actorUserId,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId,
    taskId: row.taskId, projectId: row.projectId,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListEventsOptions {
  companyId?: string; contactId?: string; dealId?: string; cursor?: string; limit?: number;
}

export async function listEvents(
  db: Database, opts: ListEventsOptions,
): Promise<{ items: Event[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const where = [];
  if (opts.companyId) where.push(eq(events.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(events.contactId, opts.contactId));
  if (opts.dealId) where.push(eq(events.dealId, opts.dealId));
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    // Non-null assertion: `or` only returns undefined when given zero conditions.
    // Both branches here are always present, so this is safe as written, but it
    // stops being safe if a future edit makes either branch conditional. Do not
    // extend this call with an optional/conditional argument without rechecking.
    where.push(or(
      lt(events.createdAt, new Date(cur.createdAt)),
      and(eq(events.createdAt, new Date(cur.createdAt)), lt(events.id, cur.id)),
    )!);
  }
  const rows = await db.select().from(events).where(and(...where))
    .orderBy(desc(events.createdAt), desc(events.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toEvent),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
