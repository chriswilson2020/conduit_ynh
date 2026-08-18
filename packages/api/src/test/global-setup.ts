import { createDatabase, runMigrations } from "../db/client.js";

// vitest.config.ts sets `test.env.PGHOST` as a default, but that only reaches the
// pool-worker processes that run test files — globalSetup runs in-process in the
// main Vitest process, which never sees `test.env`. Without this, a bare `vitest run`
// in a shell with no ambient PGHOST fails here before any test file even loads.
process.env.PGHOST ??= "/run/postgresql";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres:///conduit_test";

export default async function setup(): Promise<void> {
  const handle = createDatabase(TEST_DATABASE_URL, 1);
  try {
    await runMigrations(handle.db);
  } catch (cause) {
    throw new Error(
      `Could not migrate the test database at ${TEST_DATABASE_URL} (PGHOST=${process.env.PGHOST ?? "unset"}). ` +
        `Is PostgreSQL running (systemctl status postgresql), does conduit_test exist ` +
        `(sudo -u postgres createdb -O chris conduit_test), and is PGHOST set to /run/postgresql? ` +
        `A "password authentication failed" error means the connection went over TCP instead of the socket.`,
      { cause },
    );
  } finally {
    await handle.close();
  }
}
