import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    // Test files run one at a time. The database-backed tests share a single
    // PostgreSQL database and truncate it between cases, so running two files
    // concurrently would have them deleting each other's rows.
    fileParallelism: false,
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
