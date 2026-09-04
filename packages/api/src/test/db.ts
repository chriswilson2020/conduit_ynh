import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../db/client.js";
import { TEST_DATABASE_URL } from "./databases.js";

// max: 2, not 1 — a single test occasionally issues two queries concurrently (e.g. a
// query racing a truncate in a differently-scoped connection), and with max: 1 the
// second would queue behind the first instead of running. Second reason, since Phase
// 4: mail-ingest.test.ts's concurrency case needs two transactions genuinely open at
// once to exercise the global ingest advisory lock — at max: 1 the second would wait
// for a connection rather than for the lock, and the test would pass without proving
// anything.
//
// ISOLATION BETWEEN TEST FILES NO LONGER COMES FROM RUNNING THEM ONE AT A TIME.
// This comment used to end by warning that `fileParallelism: false` was the only
// thing keeping two files from truncating the shared database out from under each
// other, and that flipping it on for speed would turn a loud error into a silent
// data race. It has now been flipped on, and the warning is answered rather than
// ignored: TEST_DATABASE_URL names a database of this WORKER'S own
// (packages/api/src/test/databases.ts), cloned from a migrated template before any
// file runs. Two files running at once truncate two different databases.
export function openTestDatabase(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, 2);
}

/**
 * Empty every table in the public schema. Call in beforeEach so tests never see
 * each other's rows.
 *
 * The list is read from the catalogue rather than hardcoded, so tables added in
 * later phases are covered automatically — including any with no foreign-key path
 * back to users, which CASCADE alone would silently miss.
 *
 * RESTART IDENTITY is a no-op today (users.id is a UUID with no sequence) but is kept
 * so any serial/identity primary key a later phase adds resets too, instead of
 * silently continuing to climb across tests.
 *
 * drizzle's migration bookkeeping lives in the separate `drizzle` schema, so it is
 * untouched and migrations are not re-run between tests.
 */
export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  const rows = await handle.db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((row) => `"${row.tablename}"`).join(", ");
  try {
    await handle.db.execute(sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`));
  } catch (cause) {
    throw new Error(explainTruncateFailure(cause), { cause });
  }
}

/**
 * THE DETAIL LINE, KEPT, BECAUSE LAST TIME IT WAS THROWN AWAY.
 *
 * On 2 Sep a run on the dev server died here with `PostgresError 40P01`
 * (deadlock detected) in mail-move.test.ts. Two write-ups exist and they
 * disagree about what the other lock holder was: the intermittent-rates report
 * calls it "a database with other work on it", i.e. another process; the v1.4.1
 * plan calls it "the OTHER connection of the max: 2 pool", i.e. this same file.
 * Neither cites the raw error, because nobody has it. PostgreSQL says exactly
 * which it was, in the DETAIL line -- "Process 123 waits for AccessExclusiveLock
 * on relation X of database Y; blocked by process 456" -- and postgres.js puts
 * that on `error.detail`, a property beside the message rather than in it, which
 * is why the reporter printed the one and not the other.
 *
 * Folding it into the message costs nothing on a passing run and means the next
 * sighting settles the question instead of adding a third opinion. The same
 * reasoning as the CI workflow's "upload the Playwright report on green runs
 * too": the evidence is produced either way, and the only decision is whether it
 * survives being produced.
 *
 * DEMONSTRATED rather than assumed -- see the commit message for the transcript:
 * a session holding `LOCK TABLE ... IN ROW SHARE MODE` in the reverse order to
 * this TRUNCATE's makes PostgreSQL abort one side, and the message this builds
 * carries the code and both PIDs where the bare error carried neither.
 */
function explainTruncateFailure(cause: unknown): string {
  // WALKS `cause`, AND THE FIRST VERSION DID NOT -- which the demonstration
  // caught and no amount of reading would have. drizzle does not rethrow
  // postgres.js's error; it wraps it in a DrizzleQueryError whose own message is
  // "Failed query: TRUNCATE TABLE ..." and which carries no `code` and no
  // `detail` of its own. Reading those off the caught object produced exactly
  // the message this function exists to replace, with the interesting half still
  // one level down.
  interface Layer {
    message?: string; code?: string; detail?: string; hint?: string; cause?: unknown;
  }
  let deepest = "";
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const layer = current as Layer;
    if (layer.message !== undefined) deepest = layer.message;
    if (layer.code !== undefined) parts.push(`code ${layer.code}`);
    // The line that answers the whole question: PostgreSQL names both processes
    // and both lock modes here, and nowhere else.
    if (layer.detail !== undefined) parts.push(`detail: ${layer.detail}`);
    if (layer.hint !== undefined) parts.push(`hint: ${layer.hint}`);
    current = layer.cause;
  }
  // Which database, because now that every worker has its own, "whose truncate"
  // and "whose other connection" are different questions with different answers,
  // and the name is what tells them apart.
  parts.push(`database: ${TEST_DATABASE_URL}`);
  // The innermost message leads: PostgreSQL's "deadlock detected" is the useful
  // sentence, and drizzle's wrapper is a hundred characters of table list in
  // front of it.
  return `truncateAll failed: ${deepest === "" ? String(cause) : deepest} | ${parts.join(" | ")}`;
}
