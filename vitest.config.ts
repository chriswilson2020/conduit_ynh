import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its SOURCE, not its build output.
      // packages/shared/dist is gitignored, so remote.sh's rsync --delete removes it
      // from the server and every test run would otherwise need a build first. tsc -b
      // still typechecks the real dist entrypoints, so the built artefact is covered.
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
