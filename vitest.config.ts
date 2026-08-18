import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ["./packages/api/src/test/global-setup.ts"],
    env: { PGHOST: process.env.PGHOST ?? "/run/postgresql" },
  },
});
