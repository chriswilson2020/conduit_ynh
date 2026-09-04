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
  await handle.db.execute(sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`));
}
