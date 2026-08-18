import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../db/client.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

// max: 2, not 1 — a single test occasionally issues two queries concurrently (e.g. a
// query racing a truncate in a differently-scoped connection), and with max: 1 the
// second would queue behind the first instead of running. Isolation between test
// files does not come from connection limits, though: it relies on `fileParallelism:
// false` in vitest.config.ts, which keeps files from truncating the shared database
// out from under each other. If that ever gets flipped on for speed, this stops being
// a loud error and becomes silent cross-file data races.
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
