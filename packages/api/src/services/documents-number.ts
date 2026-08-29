import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { documentNumberSequences } from "../db/schema.js";

/**
 * The printed prefix per document type. `documents.number` is UNIQUE GLOBALLY even
 * though numbering is per (type, year), which forbids nothing the numbering rule
 * allows -- two formatted numbers can only collide if two types share a prefix. If a
 * future type is ever given one that collides, the unique constraint rejects the
 * second document loudly at issue rather than minting a duplicate.
 */
const PREFIX: Record<string, string> = { quote: "QUO" };

/**
 * QUO-2026-0001. Four digits is a MINIMUM width, not a field size: the 10,000th
 * quote of a year formats as QUO-2026-10000 rather than wrapping or truncating,
 * because a number that repeats is worse than a number that is one character wider.
 */
export function formatDocumentNumber(type: string, year: number, value: number): string {
  return `${PREFIX[type] ?? "DOC"}-${String(year)}-${String(value).padStart(4, "0")}`;
}

/**
 * Take the next number for (type, year).
 *
 * MUST RUN INSIDE THE CALLER'S TRANSACTION, and that is the whole reason this is a
 * table rather than a Postgres SEQUENCE. The number is PRINTED on the page, so it has
 * to be allocated before the render -- and `nextval()` is explicitly
 * non-transactional, so a render that then failed would leave a permanent hole in the
 * quote sequence. A hole invites the question of what was in it. A row rolls back.
 *
 * The ON CONFLICT update takes a row lock held to commit, so two quotes of the same
 * type and year serialise from here to the end of the transaction. That is bounded by
 * renderPdf's 20s timeout and is the behaviour you want anyway: consecutive numbers
 * are consecutive. It also means the render concurrency limit in documents-render.ts
 * is never contended by this path -- with one type and one current year, this lock
 * has already reduced issuing to one at a time.
 */
export async function allocateNumber(tx: Database, type: string, year: number): Promise<string> {
  const [row] = await tx.insert(documentNumberSequences)
    .values({ type, year, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentNumberSequences.type, documentNumberSequences.year],
      set: { lastValue: sql`${documentNumberSequences.lastValue} + 1` },
    })
    .returning({ lastValue: documentNumberSequences.lastValue });
  if (row === undefined) throw new Error("number allocation returned no row");
  return formatDocumentNumber(type, year, row.lastValue);
}
