import { defineConfig } from "vitest/config";

export default defineConfig({
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
