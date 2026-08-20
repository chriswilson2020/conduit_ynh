import { defineConfig } from "@playwright/test";

// The server under test is built, then started fresh for the whole test run (see
// webServer below). DATABASE_URL matches the shape vitest's CI job already uses:
// a full TCP connection string in CI (TEST_DATABASE_URL, set by the workflow to
// point at the postgres service container) with a local socket fallback for anyone
// running this on a machine that has PostgreSQL listening on its default socket.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // The board's keyboard-drag journey (e2e/pipeline.spec.ts) scripts
  // Space/Arrow/Space with no delay between presses. dnd-kit's
  // KeyboardSensor attaches its own document-level keydown listener (for
  // everything after the initial lift) via a bare `setTimeout`, queued as
  // part of handling that lift -- under CI's shared, variable-load CPU,
  // that timer can occasionally still be pending when the very next
  // scripted keydown is dispatched, and the event is silently missed since
  // nothing is listening for it yet. That's environmental timing jitter in
  // a third-party library's own internals, not a bug this app's code can
  // close outright (see board.tsx's collision/coordinateGetter fixes for
  // the bugs that WERE this app's to fix). workers: 1 removes cross-file
  // CPU contention (crm.spec.ts and pipeline.spec.ts no longer race for the
  // same core), which measurably reduces how often this is lost; retries
  // catches whatever residual chance remains, the same way Playwright's own
  // CI guidance recommends for this class of flakiness. The drag helpers in
  // pipeline.spec.ts/tasks.spec.ts additionally wait on dnd-kit's aria-live
  // announcements after every press (re-pressing a swallowed arrow), so a
  // lost keydown now self-heals inside the test instead of burning a retry
  // -- see keyboardDragCard's doc comment in tasks.spec.ts.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 2 : 0,
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
      // This env block is a whitelist, not an inheritance, so a variable the
      // job sets reaches the app under test only by being named here. CI's
      // Dovecot and Mailpit serve self-signed certificates, and the mail
      // account e2e/mail.spec.ts adds is synced by THIS process, not by the
      // test's own connection -- so without the passthrough the app would
      // refuse the server the spec just told it to use. Defaults to "1"
      // (verify) everywhere else, exactly like config.ts.
      MAIL_TLS_REJECT_UNAUTHORIZED: process.env.MAIL_TLS_REJECT_UNAUTHORIZED ?? "1",
      APP_VERSION: "0.1.0-e2e",
      CONDUIT_DEV_USER: "e2euser",
      BASE_PATH: "/",
      WEB_ROOT: "packages/web/dist",
    },
  },
});
