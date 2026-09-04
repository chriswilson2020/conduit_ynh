import os from "node:os";

// ONE DATABASE PER VITEST WORKER, CLONED FROM A TEMPLATE THAT IS MIGRATED ONCE.
//
// The suite used to run strictly serially (`fileParallelism: false`) for one
// reason: every database-backed file truncated the SAME database in beforeEach,
// so two files running at once would delete each other's rows. That bought
// isolation at the price of the whole suite -- 92 files, 417s of test time
// measured on the dev server, on runners with cores standing idle.
//
// This module is the other way of buying the same isolation. global-setup.ts
// migrates ONE template database, then clones it once per worker with
// `CREATE DATABASE ... TEMPLATE ...`, which in PostgreSQL is a file copy of an
// already-migrated database rather than a re-run of the migrations. Each worker
// then truncates only its own copy, and `fileParallelism` goes back on.
//
// WHY A SEPARATE TEMPLATE DATABASE rather than cloning the base database
// directly: `CREATE DATABASE ... TEMPLATE x` fails outright while any backend is
// connected to x, and the base database is the one whose URL a developer has in
// their shell, the one psql lands in, and the one an interrupted earlier run may
// still hold a connection to. A dedicated `*_tmpl` that nothing but global-setup
// ever opens has no such traffic. The base database keeps one job -- somewhere to
// connect in order to issue CREATE/DROP DATABASE, which cannot run against the
// database being created or dropped.

/**
 * The database URL the runner was pointed at: `TEST_DATABASE_URL` in CI (a full
 * TCP string), or the local socket default on the dev server.
 *
 * NOT the URL any test file connects to. Test files get {@link TEST_DATABASE_URL},
 * which names their own worker's clone. This one is the maintenance connection.
 */
export const BASE_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres:///conduit_test";

/**
 * Swap the database name in a connection URL.
 *
 * VIA `URL`, NOT `String.replace`, AND THAT IS A FIX RATHER THAN A STYLE
 * PREFERENCE. Three call sites used to do this with `url.replace(/\/[^/]*$/, ...)`,
 * which eats any query string along with the name: `postgres:///conduit_test?options=-c%20timezone%3DUTC`
 * became `postgres:///conduit_scratch_x` and the connection quietly lost the
 * options it was given. mail-ingest.test.ts already knew URLs here can carry a
 * query string -- its time-zone case composes one -- and worked around it locally
 * instead of fixing the shared helper.
 */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** The database name a connection URL points at. */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

const BASE_DATABASE_NAME = databaseNameOf(BASE_DATABASE_URL);

/** The migrated database every worker's database is copied from. */
export const TEMPLATE_DATABASE_NAME = `${BASE_DATABASE_NAME}_tmpl`;
export const TEMPLATE_DATABASE_URL = withDatabaseName(BASE_DATABASE_URL, TEMPLATE_DATABASE_NAME);

/**
 * How many workers run test files at once -- and therefore exactly how many
 * databases global-setup.ts creates.
 *
 * SET EXPLICITLY AND READ FROM ONE PLACE. vitest.config.ts passes this as
 * `maxWorkers`, which is what bounds `VITEST_POOL_ID` to 1..N, and global-setup.ts
 * creates databases for 1..N. If the two numbers ever disagreed, a worker would
 * open a database nobody had created and the failure would read as "database
 * does not exist" from whichever file happened to land on the highest pool id.
 * Letting Vitest pick its own default and guessing it here is precisely the bug
 * that arrangement invites, so neither side guesses.
 *
 * CAPPED AT 4, which is the CI runner's core count; the dev server has 2 and
 * lands there by itself. Above the core count there is nothing left to overlap:
 * the work these files are waiting on is a PostgreSQL server on the same box,
 * competing for the same cores. Rejected: scaling with total RAM instead --
 * services/export.test.ts streams a 400MB archive and seeds a 61MB corpus, so
 * memory is a real constraint, but it binds later than cores on both machines
 * this runs on (3.8GB/2 cores here, 16GB/4 in CI).
 *
 * CONDUIT_TEST_WORKERS=1 reproduces the old serial behaviour without editing
 * anything, which is the first thing to try when a failure looks parallel-only.
 */
export const TEST_WORKER_COUNT = resolveWorkerCount();

function resolveWorkerCount(): number {
  const override = process.env.CONDUIT_TEST_WORKERS;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `CONDUIT_TEST_WORKERS must be a positive integer, got ${JSON.stringify(override)}`,
      );
    }
    return parsed;
  }
  return Math.max(1, Math.min(4, os.availableParallelism()));
}

/** The database worker `poolId` (1-based, as Vitest numbers them) owns. */
export function workerDatabaseName(poolId: number): string {
  return `${BASE_DATABASE_NAME}_w${String(poolId)}`;
}

export function workerDatabaseUrl(poolId: number): string {
  return withDatabaseName(BASE_DATABASE_URL, workerDatabaseName(poolId));
}

/** Every worker database global-setup.ts creates, in pool-id order. */
export function allWorkerDatabaseNames(): string[] {
  return Array.from({ length: TEST_WORKER_COUNT }, (_, i) => workerDatabaseName(i + 1));
}

/**
 * The database THIS process's test files use.
 *
 * `VITEST_POOL_ID` is set by the worker runtime on the "start" message, before
 * any test file is imported, so reading it at module scope is safe. It is unset
 * in the main Vitest process (where globalSetup runs) and in a plain `node`
 * -- both of which want the base database, not a worker's clone, hence the
 * fallback rather than a throw.
 */
export const TEST_DATABASE_URL = resolveWorkerUrl();

function resolveWorkerUrl(): string {
  const poolId = process.env.VITEST_POOL_ID;
  if (poolId === undefined) return BASE_DATABASE_URL;
  const parsed = Number(poolId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`VITEST_POOL_ID was ${JSON.stringify(poolId)}, which is not a pool id`);
  }
  return workerDatabaseUrl(parsed);
}

// ---------------------------------------------------------------------------
// SCRATCH DATABASES
// ---------------------------------------------------------------------------
//
// Four test files create databases of their own, on top of the worker database
// they were given: two restore suites (which need a SECOND install to restore
// onto), db/schema.test.ts (which needs a genuinely pre-migration database), and
// backup.test.ts (which puts its own pg_dump back to prove the artefact is worth
// something). Those are cluster-wide objects, so unlike table rows they are NOT
// isolated by giving each worker its own database -- they are visible to every
// worker at once.
//
// THREE OF THE FOUR NAMES USED TO OVERLAP, AND ONE OF THE FILES SWEEPS.
// services/restore.test.ts used `conduit_restore_` and drops everything matching
// it in beforeAll -- above a comment claiming "Nothing else in this repository
// creates this prefix". Two other files did:
//
//   routes/restore.test.ts   conduit_restore_routes_<uuid>
//   services/backup.test.ts  conduit_restore_<hex16>       (line 615, no sweep)
//
// Serially that is invisible: a sweep only ever meets databases from a run that
// is already over. In parallel it is a file deleting another file's database
// mid-test, and it would present as psql failing in backup.test.ts for no
// reason anyone reading that file could see.
//
// So the prefixes live here, together, where the fact that they must not overlap
// is visible -- and scratchPrefixOverlaps() proves it rather than asserting it.
// The shared `conduit_scratch_` stem is also what makes a leak cheap to clear:
// one `DROP DATABASE` sweep over `conduit_scratch_%` covers all four suites.

export const SCRATCH_DATABASE_PREFIXES = {
  /** services/restore.test.ts: an install to restore a backup onto. */
  restoreService: "conduit_scratch_restore_svc_",
  /** routes/restore.test.ts: the same, driven through the HTTP route. */
  restoreRoutes: "conduit_scratch_restore_route_",
  /** db/schema.test.ts: a database migrated only as far as a chosen migration. */
  schemaUpgrade: "conduit_scratch_upgrade_",
  /** services/backup.test.ts: somewhere to load its own pg_dump back into. */
  backupRoundTrip: "conduit_scratch_backup_",
} as const;

/** The stem every scratch prefix shares, for a sweep that clears all of them. */
export const SCRATCH_DATABASE_STEM = "conduit_scratch_";

/**
 * Every `[prefix, name]` pair where sweeping `prefix` would also take `name`.
 *
 * THE INVARIANT IS ABOUT PREFIXES THAT GET SWEPT, NOT ABOUT NAMES BEING
 * DISTINCT, and the difference is worth spelling out because the first version
 * of this function got it wrong and said so loudly: it compared every name with
 * every other, so it reported `conduit_test_w5` / `conduit_test_w55` as an
 * overlap. Those two names genuinely do share a prefix and it genuinely does not
 * matter -- a worker opens its own database by its exact name, and nothing
 * anywhere sweeps `DROP DATABASE` by a worker's name.
 *
 * What is swept is the four scratch prefixes, each by the suite that owns it. So
 * the rule is one-directional: for each scratch prefix, no OTHER name this
 * module can produce may start with it.
 *
 * Returns the offending pairs rather than throwing, so the test that calls it
 * can name them.
 */
export function scratchPrefixOverlaps(): [string, string][] {
  const prefixes = Object.values(SCRATCH_DATABASE_PREFIXES);
  const everythingElse: string[] = [
    ...prefixes,
    TEMPLATE_DATABASE_NAME,
    // Pool ids are bounded by TEST_WORKER_COUNT on the machine running this, but
    // the NAMES have to stay clear of the scratch prefixes on every machine, so
    // check further than this box will ever go.
    ...Array.from({ length: 64 }, (_, i) => workerDatabaseName(i + 1)),
  ];
  const overlaps: [string, string][] = [];
  for (const prefix of prefixes) {
    for (const name of everythingElse) {
      if (name !== prefix && name.startsWith(prefix)) overlaps.push([prefix, name]);
    }
  }
  return overlaps;
}
