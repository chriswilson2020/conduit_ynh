import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_WORKER_COUNT } from "./packages/api/src/test/databases.js";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its SOURCE, not its build output.
      // remote.sh excludes dist from its rsync (a locally-built dist can be stale
      // relative to what's being synced -- see that script's header comment), so
      // packages/shared/dist exists on the server only once its own `npm run build`
      // has produced it, and never as a side effect of a sync. Resolving to source
      // here means a test run never depends on that having happened. tsc -b still
      // typechecks the real dist entrypoints, so the built artefact is covered by
      // typecheck even though vitest itself never touches it.
      "@conduit/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // TWENTY SECONDS, BECAUSE 5000 WAS VITEST'S DEFAULT AND NOBODY EVER CHOSE IT.
    //
    // THE EXPOSURE IS THE PARALLELISATION'S, AND IT SHOWED UP ONE TASK LATER.
    // A CI run of Phase 4.4 Task 2 failed four cases in services/restore.test.ts
    // -- all `Test timed out in 5000ms`, no assertion failures, in code that task
    // never touched -- and a re-run of the same commit was green. The file took
    // 206s in that run against roughly 60s in a quiet one.
    //
    // WHY CONTENTION AND NOT A HANG. Per-worker databases removed the shared
    // DATABASE, not the shared PostgreSQL SERVER: four workers still compete for
    // one instance's CPU, I/O and buffers, and the two restore files are the
    // heaviest in the suite precisely because they drop and reload real schemas
    // (26.8% of all test time between them, measured 4 Sep). At the ~3.4x
    // slowdown that run saw, the file's ordinary 1.5s cases land past 5s. The
    // tests are not wrong and the code is not slow; the budget was set for unit
    // tests by somebody who had never seen this suite.
    //
    // RAISED RATHER THAN THE FILE PINNED TO ONE WORKER, which was the other
    // option: pinning buys back the contention but also the serialisation, on
    // exactly the two files that gained most from running alongside something
    // else. And raised globally rather than per-file, because there is nothing
    // special about restore -- it is merely first to the cliff.
    //
    // WHAT IT COSTS: a genuinely hung test now takes 20s to report instead of 5.
    // That is paid only on failures, and a hang that a 5s budget catches and a
    // 20s one does not is not a shape anything here produces -- the failure mode
    // this suite actually has is a query waiting on a lock, which waits for ever.
    testTimeout: 20_000,
    // TEST FILES RUN CONCURRENTLY AGAIN, AND THE REASON THEY COULD NOT IS GONE.
    //
    // What used to stand here: "Test files run one at a time. The database-backed
    // tests share a single PostgreSQL database and truncate it between cases, so
    // running two files concurrently would have them deleting each other's rows."
    // True, and it cost the whole suite: 92 files, 417s of test time measured on
    // the dev server, on runners with idle cores.
    //
    // They no longer share a database. global-setup.ts migrates one TEMPLATE and
    // clones it per worker (packages/api/src/test/databases.ts); a worker's files
    // truncate that worker's own copy and nobody else's. `fileParallelism: true`
    // is Vitest's default, but it is written out because the line it replaces was
    // load-bearing and a reader arriving from that comment needs to see the answer
    // and not an absence.
    fileParallelism: true,
    // maxWorkers pins what VITEST_POOL_ID counts up to, which is exactly how many
    // databases global-setup.ts creates. Both numbers come from TEST_WORKER_COUNT
    // so they cannot drift apart; see that constant for why it is capped at 4.
    maxWorkers: TEST_WORKER_COUNT,
    globalSetup: ["./packages/api/src/test/global-setup.ts"],
    // Only reaches pool workers, not globalSetup — which runs in the main
    // process and sets its own PGHOST fallback. See test/global-setup.ts.
    env: { PGHOST: process.env.PGHOST ?? "/run/postgresql" },
    // --expose-gc, for the two memory bounds in
    // packages/api/src/services/export.test.ts and for nothing else.
    //
    // THEY CANNOT MEASURE WHAT THEY CLAIM WITHOUT IT. Both compare an
    // implementation that releases memory against one that holds it, and V8
    // does not hand released memory back promptly -- so resident set alone reads
    // the same for "dropped" and "still referenced", and the row bound measured
    // a 30MB gap where the real difference is the whole corpus. Forcing a
    // collection at each sample makes the reading track LIVE memory, which is
    // the property under test.
    //
    // An earlier version of those tests called `global.gc?.()` with nothing
    // enabling it, so the call was always undefined and the line implied a
    // guarantee it never gave. Enabling it costs nothing for the other test
    // files, which never call it.
    // Top-level rather than under poolOptions, which Vitest 4 removed.
    execArgv: ["--expose-gc"],
  },
});
