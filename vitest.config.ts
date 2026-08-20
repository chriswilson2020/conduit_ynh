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
  },
});
