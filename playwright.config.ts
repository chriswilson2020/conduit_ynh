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
  use: {
    baseURL: "http://127.0.0.1:3100",
    // THE FIRST TRIAL IS THE ATTEMPT WHOSE EVIDENCE IS THINNEST, and that is
    // what this buys. The `if: always()` report upload settled the mail e2e
    // cascade in an afternoon (see docs/superpowers/reports/), but the same
    // exercise had to record one failure as an honest "unknown" because the
    // report carries no trace and no screenshot for the attempt that failed
    // FIRST -- "the helper returned early", "the button was disabled" and "the
    // ingest had not finished" are not separated by anything an HTML report
    // can show.
    //
    // `retain-on-first-failure`, NOT `on-first-retry`, and the difference is
    // the whole point rather than a preference. `on-first-retry` records the
    // RETRY -- the attempt that usually passes -- and keeps nothing at all
    // from the trial that failed. It is the cheaper setting and it answers a
    // different question. This one traces every test's first run and keeps the
    // trace only where that run failed, which is exactly the artifact the
    // diagnosis wanted and did not have. The price is tracing overhead on
    // first runs; against a spec whose first-trial failures have gone
    // unexplained across three releases, it is worth paying.
    trace: "retain-on-first-failure",
  },
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
      // 7.6's re-authentication gate, which checks a password against
      // YunoHost's portal API in a real deployment. There is no portal here, so
      // this is the development-and-CI-only fixed password config.ts refuses
      // under NODE_ENV=production -- the same guard CONDUIT_DEV_USER above has
      // carried since Phase 0. THE GATE ITSELF IS THE REAL ONE: the same
      // verifier type, the same single-use tickets, the same 401s. Without this
      // the journey could only ever prove that the prompt appears, which is not
      // the property (see e2e/data.spec.ts).
      CONDUIT_REAUTH_PASSWORD: "e2e-reauth-password",
      // Phase 8: an app registration, so the add-account form's second path
      // exists to be walked (e2e/mail-oauth.spec.ts).
      //
      // A FAKE ONE, AND THE SPEC NEVER LEAVES THIS MACHINE. The tenant is a
      // made-up string, so the authorise URL points at a login.microsoftonline
      // .com path nothing here can reach -- the journey asserts on the URL the
      // app builds and aborts the navigation before it is issued. The half that
      // does run end to end is the CALLBACK, which is this server's own route
      // and is where the security lives: a forged `state` has to be refused,
      // and the refusal has to reach the page as a sentence.
      //
      // The secret is a literal because there is nothing behind it. It is not a
      // credential for anything, at any provider, ever.
      MAIL_OAUTH_MICROSOFT_CLIENT_ID: "e2e-client-id",
      MAIL_OAUTH_MICROSOFT_CLIENT_SECRET: "e2e-client-secret-not-a-real-one",
      MAIL_OAUTH_MICROSOFT_TENANT: "e2e-tenant.example",
      MAIL_OAUTH_REDIRECT_URI: "http://127.0.0.1:3100/api/mail/oauth/callback",
      BASE_PATH: "/",
      WEB_ROOT: "packages/web/dist",
    },
  },
});
