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
  const sql = postgres(databaseUrl, { max: maxConnections, onnotice: () => {} });
  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Directory holding the generated .sql migrations, resolved relative to this module. */
export function migrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
