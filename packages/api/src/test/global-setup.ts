import { sql } from "drizzle-orm";
import { createDatabase, runMigrations, type DatabaseHandle } from "../db/client.js";
import {
  allWorkerDatabaseNames, BASE_DATABASE_URL, TEMPLATE_DATABASE_NAME, TEMPLATE_DATABASE_URL,
  TEST_WORKER_COUNT, workerDatabaseName,
} from "./databases.js";

// vitest.config.ts sets `test.env.PGHOST` as a default, but that only reaches the
// pool-worker processes that run test files — globalSetup runs in-process in the
// main Vitest process, which never sees `test.env`. Without this, a bare `vitest run`
// in a shell with no ambient PGHOST fails here before any test file even loads.
process.env.PGHOST ??= "/run/postgresql";

/**
 * Drop a database, and NOT with `WITH (FORCE)`.
 *
 * The reason is the one services/restore.test.ts measured on the deploy target:
 * FORCE terminates every other backend attached to the database, an autovacuum
 * worker is one of them, and a non-superuser may not signal it -- so the drop
 * fails with 42501 rather than succeeding. A plain DROP is the one that copes,
 * because PostgreSQL signals autovacuum workers itself and waits for them; only
 * genuine client backends make it fail. The retry covers the gap between a
 * worker's `sql.end()` and the server noticing the socket is gone.
 */
async function dropDatabase(control: DatabaseHandle, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await control.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await control.db.execute(sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * The template, and every worker's copy of it.
 *
 * DROPPED FIRST, EVERY RUN, AND THAT IS THE LEAK STORY. Teardown below removes
 * these when the run ends normally; a run killed with SIGKILL -- Ctrl-C twice, a
 * CI cancellation, an agent that gave up -- never reaches it, and the dev server
 * has collected orphan test databases that way before. Sweeping at the START
 * means the next run cleans up after the last one, so a leak costs disk until
 * somebody runs the suite again rather than until somebody notices. It is also
 * why the template is rebuilt rather than reused: a template kept between runs
 * would be a migration state nothing re-derives, and a schema change would not
 * reach it.
 */
function transientDatabases(): string[] {
  return [...allWorkerDatabaseNames(), TEMPLATE_DATABASE_NAME];
}

/**
 * ONE RUN AT A TIME PER CLUSTER, AND IT SAYS SO INSTEAD OF WRECKING THE OTHER ONE.
 *
 * The sweep below drops `conduit_test_w*` by name. Two `vitest run`s against the
 * same PostgreSQL cluster therefore pick the SAME names, and the second one's
 * setup would drop databases the first one is running against -- forty files
 * failing at once, in the first run, caused by the second.
 *
 * That is not hypothetical here. This project's own documented way of hunting
 * intermittents is to start a second vitest against the same database
 * (mail-sync.test.ts:51 still records it in a comment), and the v1.2.0 notes
 * record that practice already corrupting a measurement once, when one run's
 * truncateAll ate the other's rows. Serially the collision was silent and
 * produced puzzling foreign-key failures; now it would be loud but blamed on the
 * wrong run. A session-level advisory lock makes it loud AND correctly blamed:
 * the second run refuses to start, and the first is untouched.
 *
 * Session-level (not xact) so it lives as long as this connection, which is why
 * `control` is held open for the whole run rather than closed here and reopened
 * in teardown.
 */
const RUN_LOCK = sql`SELECT pg_try_advisory_lock(hashtextextended('conduit-test-databases', 0)) AS held`;

export default async function setup(): Promise<() => Promise<void>> {
  const control = createDatabase(BASE_DATABASE_URL, 1);

  // OUTSIDE the try below, so its message reaches the reader as itself. Wrapped
  // in "is PostgreSQL running, does conduit_test exist" it would send someone to
  // check a server that is working perfectly and is merely busy.
  let held: boolean;
  try {
    held = (await control.db.execute<{ held: boolean }>(RUN_LOCK))[0]?.held === true;
  } catch (cause) {
    await control.close();
    throw new Error(reachabilityAdvice(), { cause });
  }
  if (!held) {
    await control.close();
    throw new Error(
      `Another vitest run already holds the test databases on ${BASE_DATABASE_URL}. `
      + `They are named per worker (${transientDatabases().join(", ")}), so starting a second `
      + `run here would drop the first one's databases out from under it. Wait for it to finish, `
      + `or give this run a database of its own with TEST_DATABASE_URL.`,
    );
  }

  try {
    for (const name of transientDatabases()) await dropDatabase(control, name);

    await control.db.execute(sql.raw(`CREATE DATABASE "${TEMPLATE_DATABASE_NAME}"`));
    const template = createDatabase(TEMPLATE_DATABASE_URL, 1);
    try {
      await runMigrations(template.db);
    } finally {
      // CLOSED BEFORE THE CLONES, not merely tidily. `CREATE DATABASE ... TEMPLATE t`
      // refuses outright while any backend is connected to t ("source database is
      // being accessed by other users"), so this close is load-bearing and the
      // retry in cloneFromTemplate covers the moment between it and the server
      // agreeing.
      await template.close();
    }

    // SEQUENTIAL, NOT Promise.all. Each of these copies the same source database,
    // and PostgreSQL's own concurrency around that is not something a test harness
    // should be discovering. Sequential costs nothing worth having: MEASURED ON
    // THE DEV SERVER, creating and migrating the template takes 263ms and each
    // clone takes 32-36ms, so the whole of this is ~330ms for two workers and
    // would be ~400ms for four.
    //
    // AND THAT MEASUREMENT SIZES THE TEMPLATE TRICK HONESTLY: it saves about
    // 230ms per worker over just migrating each database, which is real but is
    // not where the suite's 205 seconds came from. Running the files at all
    // concurrently is. The template earns its place by making the per-worker
    // databases cheap enough that nobody is tempted to share one again, not by
    // being a speed-up in itself.
    for (let poolId = 1; poolId <= TEST_WORKER_COUNT; poolId += 1) {
      await cloneFromTemplate(control, workerDatabaseName(poolId));
    }
  } catch (cause) {
    await control.close();
    throw new Error(reachabilityAdvice(), { cause });
  }

  return async function teardown(): Promise<void> {
    // THE SAME CONNECTION THE RUN LOCK IS HELD ON, which is why it stayed open
    // rather than being closed above and reopened here: a session advisory lock
    // dies with its session, so a control connection closed at the end of setup
    // would release the lock before the first test file even started.
    //
    // Dropping every database before closing means a normal run leaves nothing
    // behind. An abnormal one -- SIGKILL, a cancelled CI job -- never reaches
    // here, which is what the sweep at the top of setup is for, and what
    // scripts/drop-test-databases.sh is for when the next run is not imminent.
    try {
      for (const name of transientDatabases()) await dropDatabase(control, name);
    } finally {
      await control.close();
    }
  };
}

function reachabilityAdvice(): string {
  return (
    `Could not prepare the test databases from ${BASE_DATABASE_URL} (PGHOST=${process.env.PGHOST ?? "unset"}). `
    + `Is PostgreSQL running (systemctl status postgresql), does the base database exist `
    + `(sudo -u postgres createdb -O chris conduit_test), may this role CREATE DATABASE, `
    + `and is PGHOST set to /run/postgresql? `
    + `A "password authentication failed" error means the connection went over TCP instead of the socket.`
  );
}

/**
 * `CREATE DATABASE name TEMPLATE tmpl`: a file copy of an already-migrated
 * database, which is the whole point of this arrangement. Running the migrations
 * once per worker instead would put the cost back that parallelism just saved.
 *
 * The retry is for 55006 ("source database is being accessed by other users"),
 * which is what a not-yet-reaped connection to the template looks like. Not
 * narrowed to that code: a template that genuinely cannot be copied fails the
 * same way five attempts later, with the original error, and the message a
 * developer needs is the one PostgreSQL wrote.
 */
async function cloneFromTemplate(control: DatabaseHandle, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await control.db.execute(
        sql.raw(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE_NAME}"`),
      );
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await control.db.execute(sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${TEMPLATE_DATABASE_NAME} AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
      `);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
