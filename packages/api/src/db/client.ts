import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(databaseUrl: string, maxConnections = 10): DatabaseHandle {
  // No onnotice override: postgres.js's default logs notices to stdout, which reaches
  // journald under systemd. This is a self-hosted app an operator debugs from the
  // journal, so notices (e.g. from migrations) should stay visible, not be discarded.
  const sql = postgres(databaseUrl, { max: maxConnections });
  return {
    db: drizzle(sql, { schema }),
    // Graceful shutdown with a deadline: let in-flight queries finish, but never hang
    // the process waiting on a connection that won't close.
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Directory holding the generated .sql migrations, resolved relative to this module. */
export function migrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
}

// drizzle applies all pending migrations in a single transaction, so a failure during
// boot rolls back cleanly and the next boot attempt can safely retry. Known limitation:
// there is no advisory lock around this, so two processes migrating the same database
// concurrently (e.g. two instances starting at once) could race each other.
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
