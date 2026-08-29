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
 * QUO-2026-0001. Four digits is a MINIMUM width on both halves, not a field size: the
 * 10,000th quote of a year formats as QUO-2026-10000 rather than wrapping or
 * truncating, because a number that repeats is worse than a number one character
 * wider.
 *
 * THE YEAR IS PADDED TOO, and that is belt to `documentDateSchema`'s braces. The
 * schema floors an issue date at a four-digit year -- it has to, because year zero is
 * a date Postgres refuses AFTER the render -- so nothing reachable arrives here with
 * a short year. If something ever does, `QUO-0005-0001` sorts and reads like a
 * document number where `QUO-5-0001` does not.
 */
export function formatDocumentNumber(type: string, year: number, value: number): string {
  const paddedYear = String(year).padStart(4, "0");
  return `${PREFIX[type] ?? "DOC"}-${paddedYear}-${String(value).padStart(4, "0")}`;
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
 * type and year serialise from here to the end of the transaction. That is the
 * behaviour you want anyway: consecutive numbers are consecutive.
 *
 * **IT DOES NOT SERIALISE ISSUING, and an earlier version of this comment claimed it
 * did.** The year comes from the caller's issue date, so two quotes dated in
 * different years take different rows and different locks and proceed side by side --
 * measured, and asserted permanently in documents.test.ts: two quotes in different
 * years render concurrently and two in the same year do not. Enough of them saturate
 * renderPdf's cap and the rest queue. The concurrency limit in documents-render.ts is
 * therefore reachable from this path and not merely a backstop for other callers.
 *
 * The figure this sentence used to carry -- six across six years reaching a
 * three-slot limit with three queued -- was measured when RENDER_MAX_CONCURRENCY was
 * 3. It is 2. The same superseded sentence lived in documents-render.ts and was
 * corrected there first, which is how this copy survived a file-scoped sweep.
 *
 * The lock hold is bounded by renderPdf's queue timeout plus its render timeout
 * (10s + 20s), which is only true because the queue wait itself is bounded; without
 * that, a saturated renderer would hold this lock, a pooled connection and an open
 * transaction indefinitely.
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
