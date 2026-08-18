import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../db/client.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export function openTestDatabase(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, 2);
}

/** Empty every application table. Call in beforeEach so tests never see each other's rows. */
export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
}
