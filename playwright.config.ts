import { defineConfig } from "@playwright/test";

// The server under test is built, then started fresh for the whole test run (see
// webServer below). DATABASE_URL matches the shape vitest's CI job already uses:
// a full TCP connection string in CI (TEST_DATABASE_URL, set by the workflow to
// point at the postgres service container) with a local socket fallback for anyone
// running this on a machine that has PostgreSQL listening on its default socket.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // TEMPORARY DEBUG (re-test): CI's 2-worker default runs crm.spec.ts and
  // pipeline.spec.ts concurrently on shared CPU; testing whether serializing
  // removes enough scheduling jitter to close the keyboard-drag race, now
  // that the other real bugs are fixed (an earlier single test of this
  // predated those fixes and isn't conclusive on its own).
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "node packages/api/dist/server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "development",
      PORT: "3100",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres:///conduit_test",
      // Same fallback global-setup.ts documents for vitest: a bare "postgres:///db"
      // URL with no ambient PGHOST connects over TCP to localhost, which requires a
      // password this role does not have. Without this, `webServer` fails to boot
      // with "password authentication failed" on any shell that does not already
      // export PGHOST (e.g. remote.sh's non-interactive ssh invocation).
      PGHOST: process.env.PGHOST ?? "/run/postgresql",
      APP_VERSION: "0.1.0-e2e",
      CONDUIT_DEV_USER: "e2euser",
      BASE_PATH: "/",
      WEB_ROOT: "packages/web/dist",
    },
  },
});
