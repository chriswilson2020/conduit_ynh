import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, devices } from "@playwright/test";
import type { Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

/**
 * PHASE 7.6'S JOURNEY: the Settings page where the artefacts are told apart,
 * the re-authentication gate in front of them, and -- the half that matters --
 * that going round the page does not get you an archive.
 *
 * IT SAID "THE TWO ARTEFACTS" UNTIL 7.7 PUT A THIRD ON THE PAGE. The restore
 * journeys are at the foot of this file, under their own header; everything
 * between here and there is still about the two downloads.
 *
 * WHAT ONLY THIS FILE CAN SAY. The unit suites already prove the archives
 * (services/export.test.ts, services/backup.test.ts), the gate's arithmetic
 * (services/reauth.test.ts), every bypass at the route (routes/reauth.test.ts)
 * and the words' logic (settings-data-lib.test.ts). What is untested anywhere
 * else is that the SURFACE is wired to all of it: that a person can read the
 * two limitations, type a passphrase, be asked for their password, and end up
 * with a file on their disk that 7z opens -- and that a request made from the
 * same page WITHOUT going through the prompt gets nothing.
 *
 * IT NEEDS 7z AND pg_dump. The backup journey drives the real archiver inside
 * the request, and then opens the downloaded file to prove it is what the page
 * claimed. Task 2 added p7zip-full to the unit job only; this file is why the
 * e2e job needs it too (.github/workflows/test.yml).
 *
 * IT NEEDS CONDUIT_REAUTH_PASSWORD. There is no YunoHost portal on a runner to
 * bind against, so playwright.config.ts sets the development-and-CI-only fixed
 * password that config.ts refuses under NODE_ENV=production. The gate itself is
 * the real one: the same verifier, the same tickets, the same refusals.
 *
 * SERIAL, DELIBERATELY. Both routes allow exactly one archive in flight per
 * process, which is a memory decision for the export and a disk decision for
 * the backup. Two of these tests running at once would meet a legitimate 503
 * and read it as a failure. CI already runs one worker; this makes the file
 * correct on a developer's machine too.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

/** What playwright.config.ts hands the app under test. */
const REAUTH_PASSWORD = "e2e-reauth-password";

const PASSPHRASE = "correct horse battery staple";

async function openDataSettings(page: Page): Promise<void> {
  await page.goto("/settings/data");
  await expect(page.getByTestId("data-settings")).toBeVisible();
}

/** Drive the prompt the way a person does, and wait for the file. */
async function downloadThrough(page: Page, button: string, password: string) {
  await page.getByTestId(button).click();
  await expect(page.getByTestId("reauth-dialog")).toBeVisible();
  await page.getByTestId("reauth-password").fill(password);
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("reauth-confirm").click();
  return await downloadPromise;
}

test.describe("Settings -> Export and backup", () => {
  test("says what each artefact is FOR and what it CANNOT do, next to its button", async ({ page }) => {
    await openDataSettings(page);

    // THE REQUIREMENT THE PAGE EXISTS FOR. Two similar-looking buttons is
    // exactly how somebody ends up with three years of tidy CSV exports and no
    // way to put Conduit back, so the page says so before either button.
    await expect(page.getByTestId("data-lead")).toContainText("no way to put Conduit back");
    await expect(page.getByTestId("data-lead")).toContainText("Take both");

    // Each limitation is IN its own card, not in a tooltip and not in a help
    // article -- which is what these two locators assert by being scoped.
    const exportCard = page.getByTestId("export-card");
    await expect(exportCard.getByTestId("export-limitation"))
      .toContainText("cannot be restored into Conduit");
    await expect(exportCard.getByTestId("export-download")).toBeVisible();

    const backupCard = page.getByTestId("backup-card");
    await expect(backupCard.getByTestId("backup-limitation"))
      .toContainText("not readable in a spreadsheet");
    await expect(backupCard.getByTestId("backup-credentials"))
      .toContainText("credential store");
    await expect(backupCard.getByTestId("backup-download")).toBeVisible();
  });

  test("names the tools that open a .7z, including the one a Mac needs", async ({ page }) => {
    await openDataSettings(page);
    const tools = page.getByTestId("backup-tools");
    await expect(tools).toContainText("7-Zip");
    await expect(tools).toContainText("Keka");
    await expect(tools).toContainText("Ark");
    // The measured claim: Archive Utility extracts an ordinary .7z and produces
    // nothing at all for an encrypted one, so this is a one-time install rather
    // than an optional convenience.
    await expect(tools).toContainText("will not open an encrypted archive");
  });

  test("says the passphrase cannot be recovered BEFORE the first backup", async ({ page }) => {
    await openDataSettings(page);
    const warning = page.getByTestId("backup-no-recovery");
    await expect(warning).toContainText("no way to recover this passphrase");
    await expect(warning).toContainText("never stores it");

    // BEFORE, in the document as well as on the screen: a screen reader reaches
    // the warning before the field it is about.
    const order = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="backup-no-recovery"]');
      const field = document.querySelector('[data-testid="backup-passphrase"]');
      if (notice === null || field === null) return "missing";
      // eslint-disable-next-line no-bitwise
      return (notice.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ? "warning first" : "field first";
    });
    expect(order).toBe("warning first");
  });

  test("says this does not replace yunohost backup", async ({ page }) => {
    await openDataSettings(page);
    await expect(page.getByTestId("data-yunohost"))
      .toContainText("does not replace yunohost backup");
    await expect(page.getByTestId("data-yunohost")).toContainText("nginx configuration");
  });

  test("refuses a passphrase with a control character, and says why", async ({ page }) => {
    await openDataSettings(page);

    // insertText, not type(): a browser will not deliver a control character
    // through synthesised key events, and this is how one really arrives -- a
    // paste from a password manager, dispatched as an insertText input event.
    await page.getByTestId("backup-passphrase").click();
    await page.keyboard.insertText("abc\u0007def");
    await page.getByTestId("backup-passphrase-repeat").click();
    await page.keyboard.insertText("abc\u0007def");

    // NOT REJECTED MUTELY. The message says what 7z would do, which is the only
    // form of this refusal that helps anybody.
    const problem = page.getByTestId("backup-form-problem");
    await expect(problem).toContainText("control characters");
    await expect(problem).toContainText("7z reads it up to the first line break");
    await expect(page.getByTestId("backup-download")).toBeDisabled();
    // And the reason the button is off is on the screen beside it.
    await expect(page.getByTestId("backup-blocked")).toBeVisible();
  });

  test("refuses a mismatched repeat, because there is no way back from a typo", async ({ page }) => {
    await openDataSettings(page);
    await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await page.getByTestId("backup-passphrase-repeat").fill(`${PASSPHRASE} `);
    await expect(page.getByTestId("backup-form-problem")).toContainText("not the same");
    await expect(page.getByTestId("backup-download")).toBeDisabled();
  });
});

/**
 * THE FOURTH SETTINGS TAB, ON A PHONE.
 *
 * 7.6 is the first phase to make that row overflow at a phone width -- three
 * tabs fit and four do not -- so the fourth is the first tab that has to be
 * scrolled to before it can be touched. 7.7 RENAMED IT AND MADE IT LONGER
 * ("Export, backup and restore"), which moves it further off the end of the
 * row rather than back onto it, so the property below is the same one and the
 * margin is smaller. e2e/documents.spec.ts's phone
 * journey holds every settings tab to the 44px floor and to being wholly in the
 * viewport; this asserts the same property and, when it fails, SAYS WHY IN
 * NUMBERS.
 *
 * The message is the point. The shared helper's failure is a bare viewport
 * ratio, and a ratio on its own cannot distinguish a row that did not scroll
 * from a container whose own edge is outside the viewport -- two different
 * defects with two different fixes. Every figure needed to tell them apart is
 * in the message here, so a failing CI run is a diagnosis rather than the start
 * of one.
 */
const { defaultBrowserType: _phoneDefault, ...IPHONE_13 } = devices["iPhone 13"];

test.describe("the settings tabs on a phone", () => {
  test.use(IPHONE_13);

  // BOTH PAGES, because the failure was page-dependent before it was understood:
  // the tab passed on 7.6's own page and failed on the issuer profile, which is
  // the sort of difference that looks like a mystery and turns out to be a flex
  // row squeezing its children by different amounts under different content.
  for (const route of ["/settings/data", "/settings/org"]) {
    test(`the fourth tab is a 44px target and wholly in the viewport on ${route}`, async ({ page }) => {
    await page.goto(route);
    const nav = page.getByTestId("settings-nav");
    await expect(nav).toBeVisible();
    const tab = nav.getByRole("link", { name: "Export, backup and restore", exact: true });

    const natural = await tab.boundingBox();
    expect(natural?.height ?? 0, "touch height").toBeGreaterThanOrEqual(44);
    // AND NOT SQUEEZED. These are flex children; before 7.6 gave them shrink-0
    // they compressed to about half the width their label needs -- 72.7px for
    // one that measures 148 -- which clipped the text and made the geometry
    // below depend on what else was on the page. A tab narrower than its own
    // label is not a tab a thumb can read.
    expect(natural?.width ?? 0, "tab width, uncompressed").toBeGreaterThan(120);

    await tab.scrollIntoViewIfNeeded();
    const box = await tab.boundingBox();
    const viewport = page.viewportSize();
    if (box === null || viewport === null) throw new Error("no geometry");
    const geometry = await nav.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        navLeft: rect.left, navRight: rect.right,
        scrollLeft: element.scrollLeft,
        maxScroll: element.scrollWidth - element.clientWidth,
        clientWidth: element.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        docScroll: document.documentElement.scrollLeft,
      };
    });
    const outside = Math.max(0, (box.x + box.width) - viewport.width) + Math.max(0, -box.x);
    const detail = `tab x=${box.x.toFixed(2)} w=${box.width.toFixed(2)}`
      + ` right=${(box.x + box.width).toFixed(2)} vw=${String(viewport.width)}`
      + ` | nav left=${geometry.navLeft.toFixed(2)} right=${geometry.navRight.toFixed(2)}`
      + ` client=${geometry.clientWidth.toFixed(2)}`
      + ` scroll=${geometry.scrollLeft.toFixed(2)}/${geometry.maxScroll.toFixed(2)}`
      + ` | doc overflow=${geometry.docOverflow.toFixed(2)} scroll=${geometry.docScroll.toFixed(2)}`;
    expect(outside, `pixels of the tab outside the viewport -- ${detail}`).toBe(0);
    });
  }
});

test.describe("the re-authentication gate", () => {
  test("asks for a password, and a wrong one downloads nothing", async ({ page }) => {
    await openDataSettings(page);
    await page.getByTestId("export-download").click();
    await expect(page.getByTestId("reauth-dialog")).toBeVisible();

    await page.getByTestId("reauth-password").fill("not-the-password");
    await page.getByTestId("reauth-confirm").click();

    await expect(page.getByTestId("data-error")).toContainText("was not accepted");
    await expect(page.getByTestId("data-done")).toHaveCount(0);
    // The dialog is closed on the failing path too, so a second attempt is a
    // deliberate act rather than a field left waiting under a red message.
    await expect(page.getByTestId("reauth-dialog")).toHaveCount(0);
  });

  test("BYPASSING IT FAILS: a request made without the prompt gets no archive", async ({ page }) => {
    await openDataSettings(page);

    // The attacker's request, made from inside the session that is already
    // authenticated -- which is exactly the position the gate exists for. This
    // is what a dialog alone would not stop.
    const bare = await page.evaluate(async () => {
      const response = await fetch("/api/export", { headers: { Accept: "application/json" } });
      return { status: response.status, body: await response.text() };
    });
    expect(bare.status).toBe(401);
    expect(bare.body).toContain("reauth_required");

    const invented = await page.evaluate(async () => {
      const response = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Conduit-Reauth": "f".repeat(64) },
        body: JSON.stringify({ passphrase: "correct horse" }),
      });
      return { status: response.status, body: await response.text() };
    });
    expect(invented.status).toBe(401);
    expect(invented.body).toContain("reauth_required");
  });

  test("a ticket is spent by one download and refused for a second", async ({ page }) => {
    await openDataSettings(page);
    const replay = await page.evaluate(async () => {
      const minted = await fetch("/api/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "e2e-reauth-password" }),
      });
      const { ticket } = (await minted.json()) as { ticket: string };
      const first = await fetch("/api/export", { headers: { "X-Conduit-Reauth": ticket } });
      // Drain it, so the slot is released before the second request.
      await first.blob();
      const second = await fetch("/api/export", { headers: { "X-Conduit-Reauth": ticket } });
      return { first: first.status, second: second.status, body: await second.text() };
    });
    expect(replay.first).toBe(200);
    expect(replay.second).toBe(401);
    expect(replay.body).toContain("reauth_required");
  });
});

test.describe("the two downloads", () => {
  let scratch: string;

  test.beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-e2e-data-"));
  });
  test.afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("downloads an export the browser saves, and it is a real zip", async ({ page }) => {
    await openDataSettings(page);
    const download = await downloadThrough(page, "export-download", REAUTH_PASSWORD);

    expect(download.suggestedFilename()).toMatch(/^conduit-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const saved = path.join(scratch, "export.zip");
    await download.saveAs(saved);
    // The zip local file header. Whatever else is true, the browser got an
    // archive rather than a JSON error saved under an archive's name.
    const head = (await readFile(saved)).subarray(0, 4);
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    await expect(page.getByTestId("data-done")).toContainText("conduit-export-");
  });

  test("downloads a backup that 7z opens with the passphrase that was typed", async ({ page }) => {
    await openDataSettings(page);
    await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await page.getByTestId("backup-passphrase-repeat").fill(PASSPHRASE);
    await expect(page.getByTestId("backup-download")).toBeEnabled();

    const download = await downloadThrough(page, "backup-download", REAUTH_PASSWORD);
    expect(download.suggestedFilename()).toMatch(/^conduit-backup-\d{4}-\d{2}-\d{2}\.7z$/);
    const saved = path.join(scratch, "backup.7z");
    await download.saveAs(saved);

    // THE CLAIM THE PAGE MAKES, CHECKED. The whole format argument is that a
    // person types this passphrase into an ordinary archive tool and gets their
    // data. This opens the downloaded file with exactly what was typed into the
    // form -- so a page that sent something else, trimmed it, or sent the
    // repeat field would fail here.
    const out = path.join(scratch, "opened");
    await execFileAsync("7z", ["x", `-p${PASSPHRASE}`, "-y", `-o${out}`, "--", saved]);
    expect((await readdir(out)).sort()).toEqual(["database.sql", "files", "mail.key", "manifest.json"]);

    // And the passphrase really is what protects it: the wrong one fails.
    await expect(
      execFileAsync("7z", ["t", "-pnot-the-passphrase", "--", saved]),
    ).rejects.toThrow();

    // The form is cleared once the archive it protects has been written.
    await expect(page.getByTestId("backup-passphrase")).toHaveValue("");
    await expect(page.getByTestId("data-done")).toContainText("conduit-backup-");
  });
});

test.describe("the pre-flight warning", () => {
  test("shows the size and the duration on an ordinary install", async ({ page }) => {
    await openDataSettings(page);
    // A test database is small, so this is the quiet form of the notice -- but
    // it is still the real numbers from the real route.
    await expect(page.getByTestId("backup-preflight")).toContainText("to archive");
  });

  test("the route answers without a password and discloses no free space", async ({ page }) => {
    // Two properties in one request, and they are two halves of one decision.
    // The warning has to come BEFORE the commitment it informs, so this route
    // is deliberately not behind the gate -- and because it is not, everything
    // in its answer is readable by any session holder, which is why the
    // server's free disk is not in it.
    await openDataSettings(page);
    const answer = await page.evaluate(async () => {
      const response = await fetch("/api/backup/preflight", { headers: { Accept: "application/json" } });
      return { status: response.status, body: await response.text() };
    });
    expect(answer.status).toBe(200);
    expect(answer.body).not.toContain("availableBytes");
    expect(answer.body).toContain("shortfallBytes");
  });

  test("WARNS when the estimate runs past what the proxy will wait for", async ({ page }) => {
    // The failure this exists to stop is silent: the backup cannot stream, so
    // an install too large for the proxy's patience produces a 504 after
    // minutes with nothing to show. An install that big cannot be built on a
    // runner, so the ROUTE is stubbed and the WARNING is what is under test --
    // the arithmetic behind it is covered by backup-estimate.test.ts.
    await page.route("**/api/backup/preflight", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          databaseBytes: 200 * 1024 ** 3, blobBytes: 0,
          requiredBytes: 400 * 1024 ** 3, enoughDisk: true, shortfallBytes: 0,
          estimatedSeconds: 8_800, slow: true, timeoutSeconds: 3600,
        }),
      });
    });
    await openDataSettings(page);
    const warning = page.getByTestId("backup-preflight-warning");
    await expect(warning).toHaveAttribute("data-severity", "warning");
    await expect(warning).toContainText("longer than");
    // AND IT DOES NOT DISABLE ANYTHING. The estimate is a prediction; refusing
    // to try on the strength of one would be worse than the wait.
    await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await page.getByTestId("backup-passphrase-repeat").fill(PASSPHRASE);
    await expect(page.getByTestId("backup-download")).toBeEnabled();
  });

  test("says the disk is too small before anything is dumped", async ({ page }) => {
    await page.route("**/api/backup/preflight", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          databaseBytes: 900 * 1024 ** 2, blobBytes: 0,
          requiredBytes: 1900 * 1024 ** 2, enoughDisk: false,
          shortfallBytes: 1800 * 1024 ** 2,
          estimatedSeconds: 40, slow: false, timeoutSeconds: 3600,
        }),
      });
    });
    await openDataSettings(page);
    const warning = page.getByTestId("backup-preflight-warning");
    await expect(warning).toHaveAttribute("data-severity", "blocking");
    await expect(warning).toContainText("not enough free space");
  });

  test("a pre-flight that fails to load disables NOTHING", async ({ page }) => {
    // "A control disabled for a reason nobody can see" is what this codebase
    // has refused to ship three times. A secondary request failing must not
    // take the button with it -- the server runs its own disk check before it
    // spawns anything, so this page's copy is a warning and never the control.
    await page.route("**/api/backup/preflight", async (route) => {
      await route.fulfill({
        status: 500, contentType: "application/json",
        body: JSON.stringify({ error: "internal_error" }),
      });
    });
    await openDataSettings(page);
    await expect(page.getByTestId("backup-preflight-error"))
      .toContainText("You can still take one");

    await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await page.getByTestId("backup-passphrase-repeat").fill(PASSPHRASE);
    await expect(page.getByTestId("backup-download")).toBeEnabled();
  });
});

/**
 * PHASE 7.7'S JOURNEY: THE THIRD THING ON THIS PAGE, AND THE ONE THAT DESTROYS.
 *
 * WHAT ONLY THIS FILE CAN SAY, and it is a narrower list than 7.6's because the
 * engine is covered so thoroughly elsewhere. routes/restore.test.ts drives
 * every guard, every refusal and REAL applies -- against scratch databases it
 * creates and drops, never against the suite's own. services/restore.test.ts
 * drives the load, the rollback and the inventory check. What is untested
 * anywhere else is that the SURFACE is wired to it: that a person can choose a
 * backup, be asked for their password, read a plan the SERVER built, type this
 * install's name, and have the request that goes back carry an id and nothing
 * else.
 *
 * WHY THERE IS NO REAL APPLY HERE, SAID PLAINLY RATHER THAN LEFT AS A GAP. The
 * app under test runs against conduit_test -- the suite's own database, shared
 * with every other spec file. A real apply would drop and reload it mid-run.
 * routes/restore.test.ts installs a guard called `assertScratch` for exactly
 * this reason, and its comment says what happens without one: "a test that
 * reached for the shared handle by accident would take the whole suite's
 * database with it, and the symptom would be forty unrelated files failing
 * afterwards." Writing the same mistake into an e2e where no guard can catch it
 * would be worse, not better.
 *
 * SO THE APPLY REQUEST IS REAL AND ONLY THE DESTRUCTION IS NOT. The journey
 * below drives the page's own Restore button against the REAL route with the
 * REAL second ticket, and lands on the real 400 from the passphrase proof --
 * which routes/restore.ts raises BEFORE the line its own comment draws
 * ("nothing below this line can refuse without consuming the plan"). So the
 * whole chain runs -- second prompt, second ticket, the three-field body, the
 * guard order, the refusal, the preview surviving -- with nothing destroyed.
 * The two things that can only happen after that line, a finished restore and a
 * half-applied one, are driven against a stubbed route, because the alternative
 * is not "a better test" but "no suite".
 *
 * IT NEEDS 7z, pg_dump AND psql. The preview is real: it takes a backup through
 * the page, uploads it back, and the server decrypts it, unpacks it and
 * measures the LIVE database to build the plan. inspectRestore probes for psql
 * before it will plan anything, so the restore half needs one more binary than
 * 7.6's half did. All three are on the runner (.github/workflows/test.yml).
 */

/** A plan the server did not build, for the two states a real run must not reach. */
const STUB_PLAN = {
  planId: "33333333-3333-4333-8333-333333333333",
  kind: "restore",
  createdAt: "2026-09-01T10:00:00.000Z",
  expiresAt: "2026-09-01T10:30:00.000Z",
  source: {
    filename: "conduit-backup-2026-09-01.7z",
    bytes: 4096,
    sha256: "b".repeat(64),
    stagedBytes: 8192,
    memberCount: 4,
  },
  effects: [
    {
      op: "safety-backup", subject: "this install", count: 1, unit: "file", destroys: false,
      detail: "A backup of this install as it is now is written first.",
    },
    {
      op: "destroy-schema", subject: "public, drizzle", count: 2, unit: "schema", destroys: true,
      detail: "Everything in this database is dropped: 14204 row(s) in 27 table(s) across "
        + "2 schema(s).",
    },
    {
      op: "load-dump", subject: "the backup's database", count: 27, unit: "table", destroys: false,
      detail: "27 table(s) from the backup replace what was there.",
    },
    {
      op: "replace-mail-key", subject: "mail.key", count: 1, unit: "key", destroys: true,
      detail: "The backup's mail encryption key replaces this install's.",
    },
  ],
  findings: [
    {
      severity: "warning", code: "restart-required",
      message: "restart Conduit once the restore finishes. The running process holds "
        + "connections and caches for the install that was replaced.",
    },
  ],
  refusal: null,
};

/** The name the app under test answers with: playwright.config.ts's database. */
const INSTALL_NAME = "conduit_test";

/**
 * Get a plan on screen without a server building one.
 *
 * ONLY `inspect` IS STUBBED. The re-authentication round trip stays real, so
 * these tests still prove the ticket is minted and carried; what they do not
 * prove is the plan, which the journey above proves for real.
 */
async function previewWithStub(
  page: Page, planOverrides: Record<string, unknown> = {},
): Promise<void> {
  await page.route("**/api/restore/inspect", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: { ...STUB_PLAN, ...planOverrides }, installName: INSTALL_NAME,
      }),
    });
  });
  await openDataSettings(page);
  await page.getByTestId("restore-file").setInputFiles({
    name: "conduit-backup-2026-09-01.7z",
    mimeType: "application/x-7z-compressed",
    buffer: Buffer.from([0x37, 0x7a, 0xbc, 0xaf]),
  });
  await page.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await page.getByTestId("restore-preview").click();
  await expect(page.getByTestId("reauth-dialog")).toBeVisible();
  await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
  await page.getByTestId("reauth-confirm").click();
  await expect(page.getByTestId("restore-plan")).toBeVisible();
}

test.describe("Settings -> restore", () => {
  test("reads as a third thing and not as a fourth download", async ({ page }) => {
    await openDataSettings(page);

    // 7.7's spec: the page must not let somebody reach for one thing when they
    // meant a restore. The lead of the page now points down at it and says what
    // it is, and the section says it again in its own words.
    await expect(page.getByTestId("data-lead")).toContainText("it destroys everything");

    const section = page.getByTestId("restore-section");
    await expect(section.getByTestId("restore-lead"))
      .toContainText("The two above take data out of Conduit");
    await expect(section.getByTestId("restore-lead")).toContainText("not a third download");

    // The limitation, in the same weight the export's and the backup's are in.
    await expect(section.getByTestId("restore-limitation"))
      .toContainText("nothing selective about it");
    // And the thing a person reaching for the wrong tool needs told.
    await expect(section.getByTestId("restore-limitation"))
      .toContainText("load a spreadsheet");
    // The undo, and its condition.
    await expect(section.getByTestId("restore-undo"))
      .toContainText("only an undo while you still have it");

    // NOT A REPLACEMENT FOR yunohost backup, now said from the restore side too.
    await expect(page.getByTestId("data-yunohost"))
      .toContainText("cannot install Conduit");
  });

  test("explains the two password prompts BEFORE the first one appears", async ({ page }) => {
    await openDataSettings(page);
    const note = page.getByTestId("restore-two-prompts");
    await expect(note).toContainText("asked for your password twice");
    // The reason, which is the part that stops a second prompt reading as a bug.
    await expect(note).toContainText("good for exactly one request");
    await expect(note).toContainText("at the keyboard");

    // BEFORE, in the document as well as on the screen, the same property 7.6's
    // no-recovery warning is held to.
    const order = await page.evaluate(() => {
      const notice = document.querySelector('[data-testid="restore-two-prompts"]');
      const field = document.querySelector('[data-testid="restore-file"]');
      if (notice === null || field === null) return "missing";
      // eslint-disable-next-line no-bitwise
      return (notice.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ? "warning first" : "field first";
    });
    expect(order).toBe("warning first");
  });

  test("never disables the preview button without saying why beside it", async ({ page }) => {
    await openDataSettings(page);
    const button = page.getByTestId("restore-preview");
    const blocked = page.getByTestId("restore-preview-blocked");

    await expect(button).toBeDisabled();
    await expect(blocked).toContainText("Choose a backup file");

    await page.getByTestId("restore-file").setInputFiles({
      name: "conduit-backup-2026-09-01.7z",
      mimeType: "application/x-7z-compressed",
      buffer: Buffer.from([0x37, 0x7a]),
    });
    await expect(button).toBeDisabled();
    await expect(blocked).toContainText("Fill in the passphrase");

    // The same shared rule the backup form enforces, at the same moment: a
    // control character is refused HERE, with the reason, rather than as a 400
    // that says "validation".
    await page.getByTestId("restore-passphrase").click();
    await page.keyboard.insertText("abc\u0007def");
    await expect(page.getByTestId("restore-form-problem"))
      .toContainText("7z reads it up to the first line break");
    await expect(button).toBeDisabled();

    await page.getByTestId("restore-passphrase").fill(PASSPHRASE);
    await expect(button).toBeEnabled();
    await expect(blocked).toHaveCount(0);
  });

  test("BYPASSING THE GATE FAILS on both routes, and there is no GET to leak a passphrase into a log", async ({ page }) => {
    await openDataSettings(page);
    const bare = await page.evaluate(async () => {
      const form = new FormData();
      form.append("passphrase", "correct horse");
      form.append("file", new File([new Uint8Array([0x37, 0x7a])], "b.7z"));
      const inspect = await fetch("/api/restore/inspect", { method: "POST", body: form });
      const apply = await fetch("/api/restore/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: "00000000-0000-4000-8000-000000000000",
          passphrase: "correct horse",
          confirmName: "conduit_test",
        }),
      });
      // There must be no GET in this family: nginx writes a query string to its
      // access log verbatim and the browser keeps it in history.
      const get = await fetch("/api/restore/inspect", { headers: { Accept: "application/json" } });
      return {
        inspect: inspect.status, inspectBody: await inspect.text(),
        apply: apply.status, applyBody: await apply.text(),
        get: get.status,
      };
    });
    // The attacker's request, made from inside a session that is already
    // authenticated -- which is exactly the position the gate exists for.
    expect(bare.inspect).toBe(401);
    expect(bare.inspectBody).toContain("reauth_required");
    expect(bare.apply).toBe(401);
    expect(bare.applyBody).toContain("reauth_required");
    expect(bare.get).toBe(404);
  });

  test("previews a REAL backup, refuses a wrong confirmation, and keeps the upload", async ({ page }) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-e2e-restore-"));
    try {
      await openDataSettings(page);

      // A REAL BACKUP, taken through this page a moment earlier, so what is
      // uploaded is the artefact the other half of the page produces.
      await page.getByTestId("backup-passphrase").fill(PASSPHRASE);
      await page.getByTestId("backup-passphrase-repeat").fill(PASSPHRASE);
      const download = await downloadThrough(page, "backup-download", REAUTH_PASSWORD);
      const saved = path.join(scratch, "to-restore.7z");
      await download.saveAs(saved);

      await page.getByTestId("restore-file").setInputFiles(saved);
      await page.getByTestId("restore-passphrase").fill(PASSPHRASE);
      await page.getByTestId("restore-preview").click();

      // THE FIRST PROMPT, and it says why there will be a second.
      await expect(page.getByTestId("reauth-dialog")).toBeVisible();
      await expect(page.getByTestId("reauth-reason"))
        .toContainText("Nothing is changed and nothing is destroyed by this step");
      await expect(page.getByTestId("reauth-reason")).toContainText("once more");
      await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
      await page.getByTestId("reauth-confirm").click();

      const plan = page.getByTestId("restore-plan");
      await expect(plan).toBeVisible({ timeout: 120_000 });

      // WHAT THE SERVER SAID ABOUT THE FILE, not what the page knows about it.
      const source = page.getByTestId("restore-plan-source");
      await expect(source).toContainText("to-restore.7z");
      // THE DIGEST IS CHECKED AGAINST THE BYTES ON DISK, and a review is why:
      // this was a bare /[0-9a-f]{64}/, which a hard-coded constant would have
      // satisfied. The archive is right there, so the assertion can be the real
      // one -- the server hashed what the browser uploaded, and it is this file.
      const digest = createHash("sha256").update(await readFile(saved)).digest("hex");
      await expect(source).toContainText(digest);
      // AND THE MEMBER COUNT, which the same review found being described in a
      // comment and asserted nowhere. A real backup carries database.sql,
      // mail.key, manifest.json and the blob store, so it is never one member
      // and never zero -- and it is the server's count of what it staged.
      const members = await source.textContent() ?? "";
      expect(members).toMatch(/Members:\s*[1-9]/);

      // THE DESTRUCTION LIST, WITH TABLES AND ROWS. The spec asks for row counts
      // from the LIVE database "so the operator sees what they are replacing
      // rather than an abstraction" -- so this asserts the numbers are there,
      // not merely a list of names. Neither figure is computed by the page.
      const destruction = page.getByTestId("restore-destruction");
      await expect(destruction).toContainText("What this destroys");
      const schemas = destruction.getByTestId("restore-destroys-destroy-schema");
      await expect(schemas).toContainText("public");
      await expect(schemas).toContainText(/\d+ row\(s\) in \d+ table\(s\)/);
      // mail.key is the other destructive effect and must not be quietly folded
      // into the first: it is a REPLACEMENT and it is irreversible in effect.
      await expect(destruction.getByTestId("restore-destroys-replace-mail-key")).toBeVisible();

      // AND THE NON-DESTRUCTIVE STEPS ARE MARKED AS SUCH, from the plan's own
      // flag rather than from anything the page inferred about the operation.
      await expect(page.getByTestId("restore-effect-safety-backup"))
        .toHaveAttribute("data-destroys", "no");
      await expect(page.getByTestId("restore-effect-load-dump"))
        .toHaveAttribute("data-destroys", "no");
      await expect(page.getByTestId("restore-effect-destroy-schema"))
        .toHaveAttribute("data-destroys", "yes");

      // The server's own restart finding, rendered as a warning.
      await expect(page.getByTestId("restore-finding-restart-required"))
        .toHaveAttribute("data-severity", "warning");

      // THE NAME IS PRINTED, because it is a deliberateness check and not a
      // secret. Read from the page rather than hard-coded, which is also what a
      // person does.
      const name = (await page.getByTestId("restore-install-name").textContent() ?? "").trim();
      expect(name).toMatch(/^[A-Za-z0-9_]+$/);

      const apply = page.getByTestId("restore-apply");
      const blocked = page.getByTestId("restore-apply-blocked");
      await expect(apply).toBeDisabled();
      await expect(blocked).toContainText("archive passphrase again");

      await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);
      await page.getByTestId("restore-confirm-name").fill(`${name}x`);
      await expect(apply).toBeDisabled();
      await expect(blocked).toContainText(`Type ${name} exactly`);

      // TRIMMED AND OTHERWISE EXACT, from the ONE comparison both sides use.
      await page.getByTestId("restore-confirm-name").fill(`  ${name}  `);
      await expect(apply).toBeEnabled();

      // NOW THE REAL APPLY REQUEST, aimed at the one refusal that happens before
      // anything can be consumed or destroyed: the name is right and the
      // passphrase is not. This is the page's own button, the real second
      // ticket, and the real guard chain.
      await page.getByTestId("restore-confirm-passphrase").fill("not the passphrase");
      await apply.click();
      await expect(page.getByTestId("reauth-dialog")).toBeVisible();
      // THE SECOND PROMPT SAYS WHAT IT IS FOR, and it is not the first one's
      // sentence.
      await expect(page.getByTestId("reauth-reason"))
        .toContainText("This is the one that destroys");
      await expect(page.getByTestId("reauth-reason")).toContainText("was spent on the preview");
      await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
      await page.getByTestId("reauth-confirm").click();

      const error = page.getByTestId("restore-error");
      await expect(error).toContainText("not the passphrase this backup was opened with");
      // A REFUSED CONFIRMATION LEAVES THE PLAN REUSABLE. This is the property
      // that saves a three-gigabyte re-upload, and it is the reason
      // applyKeptThePreview exists at all.
      await expect(error).toContainText("your upload is still here");
      await expect(plan).toBeVisible();
      await expect(page.getByTestId("restore-confirm-name")).toHaveValue(`  ${name}  `);

      // A retype is all it costs, and the button comes back.
      await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);
      await expect(apply).toBeEnabled();

      // AND THE OPERATOR CAN WALK AWAY, deleting the decrypted archive now
      // rather than in half an hour.
      await page.getByTestId("restore-cancel").click();
      await expect(plan).toHaveCount(0);
      await expect(page.getByTestId("restore-upload")).toBeVisible();

      // THE CANCEL REALLY FREED THE SLOT, and this is what discriminates that
      // from a page that merely stopped rendering the plan. The server allows
      // exactly one preview at a time; a second inspect while one is held
      // answers 409 restore_busy. This one is refused for the right reason
      // instead -- the file is not an archive.
      const after = await page.evaluate(async () => {
        const minted = await fetch("/api/reauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "e2e-reauth-password" }),
        });
        const { ticket } = (await minted.json()) as { ticket: string };
        const form = new FormData();
        form.append("passphrase", "correct horse");
        form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "not-a-backup.7z"));
        const response = await fetch("/api/restore/inspect", {
          method: "POST", headers: { "X-Conduit-Reauth": ticket }, body: form,
        });
        return { status: response.status, body: await response.text() };
      });
      expect(after.body).not.toContain("restore_busy");
      expect(after.status).toBe(400);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("a backup it cannot restore is shown as refused, with nothing to confirm", async ({ page }) => {
    // A REFUSAL IS STILL A PLAN and is rendered through the same path -- which
    // is the design decision @conduit/shared's plan.ts is built on. What must
    // NOT happen is a confirmation appearing under it.
    await previewWithStub(page, {
      effects: [],
      refusal: {
        code: "newer-app",
        message: "this backup was written by Conduit 9.9.9, which is newer than this "
          + "install. Its data may use columns this build does not have.",
      },
    });
    await expect(page.getByTestId("restore-refusal")).toContainText("newer than this install");
    await expect(page.getByTestId("restore-apply")).toHaveCount(0);
    await expect(page.getByTestId("restore-confirm-name")).toHaveCount(0);
    // And the destruction list says so rather than being absent.
    await expect(page.getByTestId("restore-destruction"))
      .toContainText("Nothing in this plan destroys anything");
  });

  test("sends back an ID AND NOTHING ELSE, and is honest that nothing enforces the restart", async ({ page }) => {
    await previewWithStub(page);

    let sent: { method: string; ticket: string | undefined; body: unknown } | null = null;
    await page.route("**/api/restore/apply", async (route) => {
      const request = route.request();
      sent = {
        method: request.method(),
        ticket: request.headers()["x-conduit-reauth"],
        body: request.postDataJSON(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          restored: true, dispatched: 4, realised: 4, unrealised: [],
          message: "the backup has been restored. Restart Conduit now: this process holds "
            + "connections and caches belonging to the install that was replaced.",
        }),
      });
    });

    await page.getByTestId("restore-confirm-name").fill(INSTALL_NAME);
    await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);
    await page.getByTestId("restore-apply").click();
    await expect(page.getByTestId("reauth-dialog")).toBeVisible();
    await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
    await page.getByTestId("reauth-confirm").click();

    await expect(page.getByTestId("restore-outcome")).toBeVisible();

    // THE PLAN DOES NOT TRAVEL. Three fields, one of them an id, and no
    // description of the work -- because a client that could describe the work
    // could describe different work. A page that had reconstructed the plan and
    // posted it back would fail here.
    const request = sent as unknown as { method: string; ticket?: string; body: Record<string, unknown> } | null;
    expect(request).not.toBeNull();
    expect(request?.method).toBe("POST");
    expect(request?.ticket ?? "").toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(request?.body ?? {}).sort())
      .toEqual(["confirmName", "passphrase", "planId"]);
    expect(request?.body.planId).toBe(STUB_PLAN.planId);

    // THE RESTART ADVICE, AND THE CLAIM THIS PHASE MEASURED AND WITHDREW. It
    // was believed that the app could not serve writes after a restore, so an
    // operator would find out. Measured: they fail for about sixty seconds --
    // the identity cache's TTL -- and then silently start working again with
    // the process still holding stale state. So the page must say that a
    // working write proves nothing, and must not imply anything is enforcing
    // the restart, because nothing is.
    const restart = page.getByTestId("restore-restart");
    await expect(restart).toContainText("nothing here will make you");
    await expect(restart).toContainText("about a minute");
    await expect(restart).toContainText("quietly start working again");
    await expect(restart).toContainText("is not evidence you can skip it");
    // The unit is named from the install's name, which under YunoHost is the
    // app id, the system user and the database all at once.
    await expect(restart).toContainText(`systemctl restart ${INSTALL_NAME}`);

    // The preview is gone on the server the moment apply took it, so the page
    // stops offering it.
    await expect(page.getByTestId("restore-plan")).toHaveCount(0);
  });

  test("passes a half-applied restore's own words through WHOLE, and drops the preview", async ({ page }) => {
    await previewWithStub(page);
    // The narrow exception to every other 5xx in this application: these
    // messages name the safety backup's path and print the commands that put
    // the install back, and a paraphrase would throw away the only thing
    // between an operator and a broken database.
    const message = "THE RESTORE HAS HAPPENED and this database is not what it was. A safety "
      + "backup of the install as it was is at "
      + "/var/lib/conduit/conduit-safety-backup-2026-09-01T10-00-00-000Z.7z. Put it back by "
      + "hand with: 7z x -p'<your passphrase>' -o/tmp/undo -- <that file> && psql -f "
      + "/tmp/undo/database.sql";
    await page.route("**/api/restore/apply", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "restore_half_applied",
          message,
          safetyBackupPath: "/var/lib/conduit/conduit-safety-backup-2026-09-01T10-00-00-000Z.7z",
          recoveryCommands: ["7z x ...", "psql -f ..."],
          restored: false,
          unrealised: ["load-dump"],
        }),
      });
    });

    await page.getByTestId("restore-confirm-name").fill(INSTALL_NAME);
    await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);
    await page.getByTestId("restore-apply").click();
    await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
    await page.getByTestId("reauth-confirm").click();

    const error = page.getByTestId("restore-error");
    await expect(error).toContainText("conduit-safety-backup-2026-09-01T10-00-00-000Z.7z");
    await expect(error).toContainText("psql -f");
    await expect(error).toContainText("THE RESTORE HAS HAPPENED");
    // The plan was taken by the apply and disposed of in a `finally`, so the
    // page must not leave a button pointing at an id that will answer 404.
    await expect(page.getByTestId("restore-plan")).toHaveCount(0);
    await expect(page.getByTestId("restore-apply")).toHaveCount(0);
  });
});

/**
 * THE RESTORE SURFACE AT A PHONE WIDTH.
 *
 * The page's own phone journey above holds the settings tab row to the touch
 * floor. This holds the thing the tab leads to: 7.7 adds the longest form on
 * this page and the widest control row, and both have to work on the device an
 * operator is most likely to be holding when they find out they need a restore.
 */
test.describe("the restore surface on a phone", () => {
  test.use(IPHONE_13);

  test("reads and confirms at 390, with nothing off the side", async ({ page }) => {
    await previewWithStub(page);

    // NOTHING OFF THE SIDE. The confirmation is three controls in one row; at
    // this width they wrap rather than push the page wider. One pixel of
    // tolerance, the same the page-overflow assertions elsewhere in this suite
    // allow for sub-pixel layout.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "pixels the page overflows horizontally").toBeLessThanOrEqual(1);

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("no viewport");

    await page.getByTestId("restore-confirm-name").fill(INSTALL_NAME);
    await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);

    // EVERY CONTROL IN THE SEQUENCE IS A 44px TARGET AND WHOLLY IN THE
    // VIEWPORT. A confirmation somebody cannot finish on a phone is a
    // confirmation they will finish on a laptop later, or not at all.
    for (const id of ["restore-confirm-name", "restore-confirm-passphrase", "restore-apply", "restore-cancel"]) {
      const control = page.getByTestId(id);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      if (box === null) throw new Error(`no geometry for ${id}`);
      expect(box.height, `${id} touch height`).toBeGreaterThanOrEqual(44);
      const outside = Math.max(0, (box.x + box.width) - viewport.width) + Math.max(0, -box.x);
      expect(outside, `pixels of ${id} outside the viewport`).toBe(0);
    }

    // AND THE DESTRUCTION LIST IS STILL READABLE rather than clipped: the
    // numbers are the whole point of it.
    await expect(page.getByTestId("restore-destroys-destroy-schema"))
      .toContainText(/\d+ row\(s\) in \d+ table\(s\)/);
  });
});
