import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, devices } from "@playwright/test";
import type { Page } from "@playwright/test";
// TYPE ONLY, and it is the coupling a review found missing. The fixture below
// is a PlanView the server did not build; in a file whose subject is a page
// that must render exactly what the server sent, a fixture free to drift from
// that shape is the one uncoupled pair on the branch.
import type { PlanView } from "@conduit/shared";

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
 * TWICE: first to "Export, backup and restore" when the restore landed, then to
 * "Export, import, backup and restore" when the two importers did. Each rename
 * moves it further off the end of the row rather than back onto it, so the
 * property below is the same one every time and the margin is smaller every
 * time. e2e/documents.spec.ts's phone journey holds every settings tab to the
 * 44px floor and to being wholly in the viewport; this asserts the same
 * property and, when it fails, SAYS WHY IN NUMBERS.
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
    const tab = nav.getByRole("link", { name: "Export, import, backup and restore", exact: true });

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
        body: JSON.stringify({ password: "e2e-reauth-password", scope: "export" }),
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

  /**
   * A DOWNLOAD'S PROOF WILL NOT DESTROY THE DATABASE. v1.4.1's headline defect,
   * asserted through a real browser against a real server rather than only at
   * the route: before it, this ticket -- minted for an export, from inside an
   * authenticated session, exactly as the page mints one -- was a live
   * authorisation to run the restore for the next five minutes.
   *
   * THE APPLY BODY IS DELIBERATELY EMPTY. The gate runs before the body is
   * parsed and before any plan is looked up, so nothing here can destroy
   * anything even if the assertion fails: what a spent-scope ticket would get
   * is a 400 about the body, and the assertion tells that from the 401 the
   * gate answers.
   */
  test("BYPASSING IT SIDEWAYS FAILS: a download's ticket cannot reach the restore", async ({ page }) => {
    await openDataSettings(page);
    const crossed = await page.evaluate(async () => {
      const minted = await fetch("/api/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "e2e-reauth-password", scope: "export" }),
      });
      const { ticket } = (await minted.json()) as { ticket: string };
      const applied = await fetch("/api/restore/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Conduit-Reauth": ticket },
        body: JSON.stringify({}),
      });
      return { status: applied.status, body: await applied.text() };
    });
    expect(crossed.status).toBe(401);
    expect(crossed.body).toContain("reauth_required");
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
 * WHY THERE IS NO REAL APPLY HERE, AND THE TWO REASONS THAT ACTUALLY BITE. The
 * first draft of this paragraph said a real apply "would take the whole suite's
 * database with it", and a review was right that that is the weakest argument
 * available: the journey backs conduit_test up and would restore it from a dump
 * of itself, so the rows come back. What does not come back is everything else.
 *
 *   THE OTHER SPEC FILES ARE IN THAT DATABASE AT THE SAME TIME.
 *   `test.describe.configure({ mode: "serial" })` orders THIS file and nothing
 *   else; CI runs one worker, but a developer's default is several, and a
 *   `DROP SCHEMA ... CASCADE` under a concurrently running spec takes it out
 *   with a failure that looks like anything but its cause.
 *
 *   AND THE PROCESS WOULD BE POISONED FOR A MINUTE AFTERWARDS -- which is the
 *   very thing RestartAdvice on the page under test documents. After a real
 *   apply the app holds identity state belonging to the install that was
 *   replaced, so writes fail for about sixty seconds and then start working
 *   again. Every spec that ran in that window would fail for a reason nothing
 *   in the suite could explain, and the suite has no way to restart the server
 *   between files.
 *
 * routes/restore.test.ts refuses the same thing from the other direction, with
 * a guard called `assertScratch`: every app that can reach applyRestore is
 * built against a scratch database created for the case and dropped after it.
 * There is no equivalent guard available to a Playwright spec, which is the
 * argument for not needing one.
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

/**
 * A plan the server did not build, for the states a real run must not reach.
 *
 * `satisfies PlanView` RATHER THAN A BARE OBJECT. It cannot drift in the
 * direction that would matter at runtime -- restoreInspectionSchema.parse runs
 * over it in the page -- but the compiler is what says so, and the shared module
 * two files away holds its own schema against the same type in both directions
 * for exactly this reason.
 */
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
} satisfies PlanView;

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
  page: Page,
  planOverrides: Record<string, unknown> = {},
  // NULLABLE, because the server's answer is: routes/restore.ts refuses to
  // invent a name it cannot read from its own configuration, and the page has a
  // whole branch for that which no journey reached until a review said so.
  installName: string | null = INSTALL_NAME,
): Promise<void> {
  await page.route("**/api/restore/inspect", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plan: { ...STUB_PLAN, ...planOverrides }, installName }),
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
    //
    // THE SENTENCES MOVED WHEN THE IMPORTERS LANDED, and the PROPERTY did not.
    // The lead used to end "it destroys everything that is here now" about the
    // one way in; there are now three ways in and two of them are additive, so
    // the lead names the contrast instead of one half of it. What is asserted
    // is the same requirement: this page's opening paragraph says, before any
    // button, that one of the things below replaces everything.
    await expect(page.getByTestId("data-lead")).toContainText("an import ADDS records");
    await expect(page.getByTestId("data-lead"))
      .toContainText("a restore REPLACES everything that is here");

    const section = page.getByTestId("restore-section");
    // AND THE SECTION'S OWN LEAD NAMES THE THING IT IS MOST CONFUSED WITH.
    // "The two above take data out of Conduit" stopped being true the moment
    // the import section landed between them, and it stopped being true in the
    // direction that matters: the pair a person can now confuse is an import
    // and a restore, because both take an upload and both show a preview.
    await expect(section.getByTestId("restore-lead")).toContainText("This is not an import");
    await expect(section.getByTestId("restore-lead"))
      .toContainText("destroying everything that is here first");

    // The limitation, in the same weight the export's and the backup's are in.
    await expect(section.getByTestId("restore-limitation"))
      .toContainText("nothing selective about it");
    // And the thing a person reaching for the wrong tool needs told -- which is
    // now a place to go rather than only a warning, because the tool exists.
    await expect(section.getByTestId("restore-limitation"))
      .toContainText("load a spreadsheet");
    await expect(section.getByTestId("restore-limitation"))
      .toContainText("Import section above");
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
      // AND ONLY WHAT DESTROYS IS IN THE BOX. destructiveEffects is a shared
      // helper written so the confirmation cannot disagree with the list below
      // it; swapping it for plan.effects would put the safety backup and the
      // load under a heading that says "What this destroys", and a review found
      // that nothing would have noticed.
      await expect(destruction.getByTestId("restore-destroys-safety-backup")).toHaveCount(0);
      await expect(destruction.getByTestId("restore-destroys-load-dump")).toHaveCount(0);
      await expect(destruction.locator("li")).toHaveCount(2);

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
          body: JSON.stringify({ password: "e2e-reauth-password", scope: "restore-preview" }),
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
    // AND THE EXPIRY PARAGRAPH IS NOT THERE, which is the assertion this test
    // was missing and a review found. A refusal is not HELD: routes/restore.ts
    // disposes of the staging before it writes the answer, so the archive is
    // already gone and the plan id resolves to nothing. A paragraph promising
    // to delete it in half an hour is the page predicting server state instead
    // of rendering it -- a defect this branch has already repaired once, with
    // nothing holding the repair.
    await expect(page.getByTestId("restore-expiry")).toHaveCount(0);
  });

  test("RENDERS EVERY FINDING THE SERVER SENT, codes repeated or not", async ({ page }) => {
    // WHAT THIS HOLDS: nothing filters, slices or de-duplicates the findings on
    // the way to the screen. A finding the server chose to show is shown.
    //
    // WHAT IT CANNOT HOLD, SAID RATHER THAN IMPLIED. The list is keyed by React
    // on `${finding.code}-${index}` because keying on the code alone is a
    // reconciliation hazard -- PlanFindingView documents `code` only as "a
    // stable identifier, so a test can assert a finding without matching
    // prose", and the CSV importer PlanKind already reserves emits one finding
    // per bad row and one per unmapped column. But that hazard is NOT visible
    // here and this test was written believing it would be: mutating the key
    // back to the bare code leaves this green. React renders duplicate-keyed
    // children on a FIRST mount and only drops them when the list reconciles,
    // its warning is compiled out of the production bundle this suite drives,
    // and the plan card unmounts between previews so no reconciliation of this
    // list is reachable from the page at all. The key is right by construction
    // and by consistency with the two effect lists beside it; no instrument in
    // this suite can see it, and inventing one that passed for another reason
    // would be worse than saying so.
    await previewWithStub(page, {
      findings: [
        { severity: "warning", code: "row-refused", message: "row 12 has no company name" },
        { severity: "warning", code: "row-refused", message: "row 40 has no company name" },
        { severity: "note", code: "row-refused", message: "row 41 was a duplicate" },
      ],
    });
    const findings = page.getByTestId("restore-findings");
    await expect(findings.locator("li")).toHaveCount(3);
    await expect(findings).toContainText("row 12");
    await expect(findings).toContainText("row 40");
    await expect(findings).toContainText("row 41");
  });

  test("REFUSES TO OFFER A CONFIRMATION when the server cannot name its own database", async ({ page }) => {
    // routes/restore.ts answers 503 to any apply it cannot name an install for,
    // and refuses to fall back to a constant because "a constant is a
    // confirmation everybody can type". The page has to refuse in the same
    // direction rather than showing a field nobody can satisfy. Nothing
    // rendered this branch before a review pointed out that no journey ever
    // supplied a null name.
    await previewWithStub(page, {}, null);
    await expect(page.getByTestId("restore-unnameable"))
      .toContainText("cannot be named from its configuration");
    await expect(page.getByTestId("restore-unnameable")).toContainText("administrator");
    // NO FIELDS, because there is no string that would satisfy them -- a box
    // with "that is not the name" under it would send somebody hunting for a
    // spelling that does not exist.
    await expect(page.getByTestId("restore-confirm-name")).toHaveCount(0);
    await expect(page.getByTestId("restore-confirm-passphrase")).toHaveCount(0);
    // THE BUTTON STAYS, DISABLED, WITH THE REASON BESIDE IT -- and this
    // assertion was written the other way round first, which was the test being
    // wrong rather than the page. A control that VANISHES is its own kind of
    // unexplained: the rule this page is built on is that nothing is off
    // without a visible reason, not that nothing is ever off.
    await expect(page.getByTestId("restore-apply")).toBeDisabled();
    await expect(page.getByTestId("restore-apply-blocked"))
      .toContainText("cannot be named from its configuration");
    // But the upload can still be got rid of, which is the whole reason the
    // cancel is not behind the same gate.
    await expect(page.getByTestId("restore-cancel")).toBeEnabled();
  });

  test("CLEARS THE FILE AFTER A CANCEL, so the reason beside the dark button is true", async ({ page }) => {
    // The upload card is unmounted by a preview and REMOUNTED by a cancel, so
    // its file input comes back empty. Form state that survived would leave the
    // page believing it held a file nobody can see -- "Fill in the passphrase
    // to enable this" over an input reading "No file chosen" -- and Preview
    // would silently re-upload the previous archive.
    await previewWithStub(page);
    await page.getByTestId("restore-cancel").click();
    await expect(page.getByTestId("restore-upload")).toBeVisible();
    await expect(page.getByTestId("restore-file")).toHaveValue("");
    await expect(page.getByTestId("restore-preview-blocked"))
      .toContainText("Choose a backup file");
    await expect(page.getByTestId("restore-preview")).toBeDisabled();
  });

  test("SAYS WHY when Apply and Cancel go dark for something happening elsewhere", async ({ page }) => {
    // With a plan on screen the two downloads above are still live, and both of
    // these controls read `busy`. A review found them going dark with nothing
    // beside them -- and the Cancel is the control that deletes a decrypted
    // credential store from the server, which makes it the worst instance on
    // this page of the failure this page exists not to ship.
    await previewWithStub(page);
    // A COMPLETE CONFIRMATION FIRST, so the baseline is a live row with nothing
    // to explain. Without this the span is already showing "type the archive
    // passphrase again", and the assertion below would pass on the wrong
    // sentence.
    await page.getByTestId("restore-confirm-name").fill(INSTALL_NAME);
    await page.getByTestId("restore-confirm-passphrase").fill(PASSPHRASE);
    await expect(page.getByTestId("restore-apply")).toBeEnabled();
    await expect(page.getByTestId("restore-apply-blocked")).toHaveCount(0);

    // The export is held open so `busy` stays true while the assertions run.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/export", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/zip", body: "PK" });
    });
    await page.getByTestId("export-download").click();
    await page.getByTestId("reauth-password").fill(REAUTH_PASSWORD);
    await page.getByTestId("reauth-confirm").click();

    const blocked = page.getByTestId("restore-apply-blocked");
    await expect(blocked).toContainText("One thing at a time");
    await expect(page.getByTestId("restore-apply")).toBeDisabled();
    await expect(page.getByTestId("restore-cancel")).toBeDisabled();
    release();
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

/**
 * PHASE 7.7'S LAST SURFACE: THE TWO IMPORTERS.
 *
 * WHAT ONLY THIS FILE CAN SAY. routes/import.test.ts proves every guard on the
 * six routes -- who may import, what travels, what a second upload is told,
 * what is left on the disk -- and settings-import-lib.test.ts proves the words
 * and the two "does this failure leave the operator's work" decisions. What is
 * untested anywhere else is that the SURFACE is wired to all of it: that a
 * person can choose a spreadsheet, be shown their own column names, say what
 * each one holds, read what that would create, press a button and find the
 * records in Conduit.
 *
 * THE FOREIGN IMPORTER IS EXERCISED FOR REAL, END TO END, because it can be:
 * every row it creates is new, so nothing has to be deleted to make room.
 *
 * THE EXACT IMPORTER IS EXERCISED FOR REAL ONLY AS FAR AS ITS PREVIEW, and that
 * is a limit of the fixture rather than of the code, said here rather than left
 * to look like a gap. The only real export this suite can obtain is an export
 * of the install it is running against -- so every id in it is already here,
 * and the honest answer the importer gives is "there is nothing to add". That
 * refusal IS the journey for the limitation requirement, because the seven
 * sheet-by-sheet findings are pushed before it and travel with it. The
 * CREATING path needs an archive whose rows are absent from the install, which
 * means deleting rows, which this application deliberately cannot do -- so it
 * is proved at the route (routes/import.test.ts imports a real export into an
 * emptied install and checks the ids came back) and the page's half of it is
 * driven here against a stub.
 */

/** A CSV whose rows cannot collide with a previous run of this suite. */
function foreignCsv(tag: string): string {
  return [
    "Given name,Family name,E-mail Address,Notes",
    `Ada,Lovelace ${tag},ada.${tag}@example.com,first programmer`,
    `Alan,Turing ${tag},alan.${tag}@example.com,`,
  ].join("\r\n");
}

async function chooseCsv(page: Page, csv: string, filename = "contacts.csv"): Promise<void> {
  await page.getByTestId("import-csv-file").setInputFiles({
    name: filename, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8"),
  });
}

/** Upload a CSV and get to the mapping step. */
async function readColumns(page: Page, csv: string): Promise<void> {
  await chooseCsv(page, csv);
  await page.getByTestId("import-csv-columns").click();
  await expect(page.getByTestId("import-csv-mapping")).toBeVisible({ timeout: 60_000 });
}

test.describe("Settings -> import", () => {
  test("reads as a way IN, and the restore points back at it", async ({ page }) => {
    await openDataSettings(page);

    // THE PAGE'S LEAD NOW NAMES BOTH DIRECTIONS. It described two downloads and
    // one destruction; a lead that named only the destructive way in would
    // leave somebody holding a spreadsheet with the restore as the only
    // candidate on offer.
    await expect(page.getByTestId("data-lead")).toContainText("an import ADDS records");
    await expect(page.getByTestId("data-lead")).toContainText("a restore REPLACES everything");

    // THE SECTION SAYS WHAT IT IS IN ITS FIRST SENTENCE.
    const section = page.getByTestId("import-section");
    await expect(section.getByTestId("import-lead")).toContainText("ADD rows to this install");
    await expect(section.getByTestId("import-lead"))
      .toContainText("Nothing that is already here is changed");
    await expect(section.getByTestId("import-lead")).toContainText("restore below");

    // EACH ARTEFACT STATES WHAT IT CANNOT DO, in the same component and the
    // same weight the export's and the backup's do -- which is the requirement
    // rather than the styling, and is now asserted on all five.
    await expect(section.getByTestId("import-export-limitation"))
      .toContainText("Not deals, tasks, projects, notes, meetings, documents or files");
    await expect(section.getByTestId("import-csv-limitation"))
      .toContainText("One file creates one kind of record");

    // AND THE RESTORE POINTS BACK UP HERE, which it could not do before this
    // section existed. Its limitation used to end "this is not the tool" with
    // nowhere to send anybody.
    await expect(page.getByTestId("restore-lead")).toContainText("This is not an import");
    await expect(page.getByTestId("restore-lead")).toContainText("Import section above");
    await expect(page.getByTestId("restore-limitation")).toContainText("Import section above");

    // THE ORDER IS THE REQUIREMENT: harmless, additive, irreversible. Somebody
    // scrolling for "get my data in" meets the import first.
    const order = await page.evaluate(() => {
      const importing = document.querySelector('[data-testid="import-section"]');
      const restore = document.querySelector('[data-testid="restore-section"]');
      if (importing === null || restore === null) return "missing";
      // eslint-disable-next-line no-bitwise
      return (importing.compareDocumentPosition(restore) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ? "import first" : "restore first";
    });
    expect(order).toBe("import first");
  });

  test("never disables an import control without saying why beside it", async ({ page }) => {
    await openDataSettings(page);
    for (const [button, blocked] of [
      ["import-export-preview", "import-export-blocked"],
      ["import-csv-columns", "import-csv-blocked"],
    ] as const) {
      await expect(page.getByTestId(button)).toBeDisabled();
      await expect(page.getByTestId(blocked)).toContainText("Choose a file to enable this");
    }

    await chooseCsv(page, foreignCsv("blocked"));
    await expect(page.getByTestId("import-csv-columns")).toBeEnabled();
    await expect(page.getByTestId("import-csv-blocked")).toHaveCount(0);
  });

  test("IMPORTS A SPREADSHEET END TO END, mapping included", async ({ page }) => {
    const tag = `e2e${String(Date.now())}`;
    const csv = foreignCsv(tag);
    await openDataSettings(page);
    await readColumns(page, csv);

    // WHAT IS IN THE FILE, from the server rather than from the browser: the
    // operator's own column names and the values underneath them, which are
    // what a person actually reads to decide what a column is.
    // THE LIST, NOT THE BUTTON. The upload stage's button and the mapping
    // stage's column list are two different testids on purpose: they are never
    // on screen together, but a single name shared by a control and a container
    // is a locator that silently means one thing today and the other tomorrow.
    const columns = page.getByTestId("import-csv-column-list");
    await expect(columns.getByTestId("import-csv-column-0")).toContainText("Given name");
    await expect(columns.getByTestId("import-csv-column-0")).toContainText("Ada");
    await expect(columns.getByTestId("import-csv-column-3")).toContainText("Notes");
    await expect(columns.getByTestId("import-csv-column-3")).toContainText("first programmer");

    // AND CONDUIT'S GUESS IS THE STARTING POINT AND NOT THE DECISION. "Given
    // name", "Family name" and "E-mail Address" are spellings the reader knows;
    // "Notes" is one it has nowhere to put, and it is left unmapped rather than
    // guessed at.
    await expect(page.getByTestId("import-csv-field-0")).toHaveValue("contact.first_name");
    await expect(page.getByTestId("import-csv-field-1")).toHaveValue("contact.last_name");
    await expect(page.getByTestId("import-csv-field-2")).toHaveValue("contact.email");
    await expect(page.getByTestId("import-csv-field-3")).toHaveValue("");

    // THE OWNER IS A MAPPING CONTROL AND ITS DEFAULT IS NOBODY, which is the
    // answer that cannot be wrong.
    await expect(page.getByTestId("import-csv-owner")).toHaveValue("");

    await page.getByTestId("import-csv-preview").click();
    const plan = page.getByTestId("import-plan");
    await expect(plan).toBeVisible({ timeout: 60_000 });
    await expect(plan).toHaveAttribute("data-kind", "csv");

    // WHAT IT ADDS, FROM THE PLAN. Nothing on this page counted it.
    await expect(page.getByTestId("import-creates-insert-csv-contacts"))
      .toContainText("2 rows");
    await expect(page.getByTestId("import-creates-insert-csv-contacts"))
      .toHaveAttribute("data-destroys", "no");
    // AND THE SENTENCE THAT ANSWERS "will this delete what I have?" without an
    // operator having to reason about it.
    await expect(page.getByTestId("import-creates"))
      .toContainText("No record already in this install is changed");
    // The unmapped column is reported rather than silently dropped.
    await expect(page.getByTestId("import-finding-column-unmapped")).toContainText("Notes");

    await page.getByTestId("import-apply").click();
    await expect(page.getByTestId("import-outcome")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("import-outcome")).toContainText("2 rows were added");
    // The preview is gone on the server the moment apply took it, so the page
    // stops offering it.
    await expect(page.getByTestId("import-plan")).toHaveCount(0);

    // AND THE RECORDS ARE IN CONDUIT, which is the only assertion in this file
    // that the import actually happened rather than merely reported that it
    // had.
    await page.goto("/contacts");
    await expect(page.getByRole("cell", { name: `Ada Lovelace ${tag}` })).toBeVisible();
    await expect(page.getByRole("cell", { name: `Alan Turing ${tag}` })).toBeVisible();

    // A SECOND IMPORT OF THE SAME FILE ADDS NOTHING, and says so rather than
    // creating two of everybody -- which is the duplicate rule working through
    // the whole surface rather than in a unit test.
    await openDataSettings(page);
    await readColumns(page, csv);
    await page.getByTestId("import-csv-preview").click();
    await expect(page.getByTestId("import-refusal")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("import-refusal")).toContainText("nothing in this file to add");
    // THE BUTTON STAYS, DISABLED, WITH THE REASON BESIDE IT. The restore's own
    // journey had to be written this way round after a review: a control that
    // VANISHES is its own kind of unexplained, and the rule this page is built
    // on is that nothing is off without a visible reason -- not that nothing is
    // ever off.
    await expect(page.getByTestId("import-apply")).toBeDisabled();
    await expect(page.getByTestId("import-apply-blocked"))
      .toContainText("nothing here to import");
    await page.getByTestId("import-cancel").click();
    await expect(page.getByTestId("import-plan")).toHaveCount(0);
  });

  test("DISABLES THE MAPPING ON THE SHARED RULE, with that rule's own sentence", async ({ page }) => {
    // ONE FUNCTION, BOTH SIDES. csvMappingProblem is what this control is
    // disabled on and what services/import-csv.ts refuses an arriving mapping
    // with, so the two refusals read as one answer. What this journey adds to
    // the unit test is that the sentence is ON THE SCREEN beside the dead
    // button rather than merely returned by a function.
    await openDataSettings(page);
    await readColumns(page, foreignCsv("mapping"));

    // Map a company field beside the contact ones: one file creates one kind
    // of record.
    await page.getByTestId("import-csv-field-3").selectOption("company.name");
    await expect(page.getByTestId("import-csv-preview")).toBeDisabled();
    await expect(page.getByTestId("import-csv-mapping-blocked"))
      .toContainText("mapped to both companies and contacts");
    // The refusal names the way out rather than being a dead end.
    await expect(page.getByTestId("import-csv-mapping-blocked"))
      .toContainText("import the companies first");

    // Take the required field away instead.
    await page.getByTestId("import-csv-field-3").selectOption("");
    await page.getByTestId("import-csv-field-0").selectOption("");
    await expect(page.getByTestId("import-csv-preview")).toBeDisabled();
    await expect(page.getByTestId("import-csv-mapping-blocked")).toContainText("First name");

    // And two columns fighting over a field that holds one value.
    await page.getByTestId("import-csv-field-0").selectOption("contact.first_name");
    await page.getByTestId("import-csv-field-3").selectOption("contact.last_name");
    await expect(page.getByTestId("import-csv-preview")).toBeDisabled();
    await expect(page.getByTestId("import-csv-mapping-blocked")).toContainText("Last name");

    await page.getByTestId("import-csv-field-3").selectOption("");
    await expect(page.getByTestId("import-csv-preview")).toBeEnabled();
    await expect(page.getByTestId("import-csv-mapping-blocked")).toHaveCount(0);
  });

  test("KEEPS THE MAPPING when the world moves between preview and apply", async ({ page }) => {
    // THE DECISION services/import-csv.ts LEFT TO THIS TASK, in its own words:
    // "a routes task should keep the operator's mapping in front of them across
    // a refused apply, because nothing about the mapping became untrue -- only
    // the counts did."
    //
    // THE APPLY IS STUBBED AND THE REST IS REAL. Making a real row appear
    // between a preview and an apply from inside a browser journey would mean a
    // second writer this suite has no way to be; what is under test here is
    // what the PAGE does with the answer, and the answer's shape is held to the
    // server's by routes/import.test.ts, which produces this exact 409 from a
    // real race.
    await openDataSettings(page);
    await readColumns(page, foreignCsv("changed"));
    await page.getByTestId("import-csv-field-3").selectOption("contact.job_title");
    await page.getByTestId("import-csv-preview").click();
    await expect(page.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });

    let stubbedPlanId = "";
    await page.route("**/api/import/csv/apply", async (route) => {
      stubbedPlanId = (route.request().postDataJSON() as { planId: string }).planId;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "import_csv_changed",
          imported: false,
          message: "the preview said 2 contacts would be created and 1 were, because this "
            + "install changed while the preview was open. Nothing has been imported, and the "
            + "column mapping is unaffected. Take a fresh preview of the same file.",
        }),
      });
    });
    await page.getByTestId("import-apply").click();

    const error = page.getByTestId("import-error");
    await expect(error).toContainText("the column mapping is unaffected");
    await expect(error).toContainText("Nothing has been imported");

    // THE PLAN IS GONE, because the server consumed it and disposed of the
    // upload in a `finally`; a button pointing at that id would answer 404 and
    // read as a second, different failure.
    await expect(page.getByTestId("import-plan")).toHaveCount(0);

    // AND THE MAPPING IS STILL ON THE SCREEN, with every choice the operator
    // made -- including the one they made by hand, which is the one that would
    // have cost them their time.
    await expect(page.getByTestId("import-csv-mapping")).toBeVisible();
    await expect(page.getByTestId("import-csv-field-3")).toHaveValue("contact.job_title");
    await expect(page.getByTestId("import-csv-field-0")).toHaveValue("contact.first_name");

    // THE STUB HAS TO FINISH WHAT THE REAL SERVER WOULD HAVE DONE, and a run
    // that did not caught this: intercepting the apply means the request never
    // reached the route, so the plan is STILL HELD on the server -- while the
    // page, correctly, has stopped offering it. That is a state a real
    // `import_csv_changed` cannot produce (it is thrown from inside
    // `intakeSessions.use`, which disposes in a `finally`), and leaving it
    // would make the re-preview below meet a 409 for a reason this journey is
    // not about. Deleting it here is the stub being faithful rather than the
    // test working around the app.
    expect(stubbedPlanId).toMatch(/^[0-9a-f-]{36}$/);
    const released = await page.request.delete(`/api/import/${stubbedPlanId}`);
    expect(released.status()).toBe(204);

    // One press re-plans it, against the same file the browser still holds.
    await page.unroute("**/api/import/csv/apply");
    await page.getByTestId("import-csv-preview").click();
    await expect(page.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("import-cancel").click();
    await expect(page.getByTestId("import-plan")).toHaveCount(0);
  });

  test("SHOWS WHAT AN EXPORT CANNOT BRING BACK, sheet by sheet, in its preview", async ({ page }) => {
    // THE LIMITATION HAS TO BE VISIBLE BEFORE THE IMPORT, not discovered in an
    // empty deals list afterwards. This uploads a REAL export of the install
    // this suite is running against, taken through the page's own download a
    // moment earlier -- so what is under test is the whole chain: the archive
    // 7.6 writes, the intake that unpacks it, the digest sweep, and the
    // findings on the screen.
    const scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-e2e-import-"));
    try {
      await openDataSettings(page);
      const download = await downloadThrough(page, "export-download", REAUTH_PASSWORD);
      const saved = path.join(scratch, "conduit-export.zip");
      await download.saveAs(saved);

      await page.getByTestId("import-export-file").setInputFiles(saved);
      await page.getByTestId("import-export-preview").click();
      const plan = page.getByTestId("import-plan");
      await expect(plan).toBeVisible({ timeout: 120_000 });
      await expect(plan).toHaveAttribute("data-kind", "export");

      // THE HEADLINE, AND THEN THE SPECIFIC GAPS. A count alone would pass on
      // seven copies of one sentence.
      await expect(page.getByTestId("import-finding-partial-import"))
        .toContainText("imports companies and contacts from an export");
      const findings = page.getByTestId("import-findings");
      for (const sheet of ["deals.csv", "tasks.csv", "projects.csv", "notes.csv",
        "meetings.csv", "documents.csv", "files.csv"]) {
        await expect(findings, `no finding names ${sheet}`).toContainText(sheet);
      }
      // Each one says WHAT is missing rather than only that it is skipped.
      await expect(findings).toContainText("position");

      // AND THE HONEST ANSWER FOR AN EXPORT OF THIS VERY INSTALL: every id in
      // it is already here, so there is nothing to add and the page says so
      // instead of offering a button that would do nothing.
      await expect(page.getByTestId("import-refusal"))
        .toContainText("already in this install");
      await expect(page.getByTestId("import-apply")).toBeDisabled();
      await expect(page.getByTestId("import-apply-blocked"))
        .toContainText("nothing here to import");
      // A refusal is not held, so there is no expiry paragraph promising to
      // delete something that is already gone.
      await expect(page.getByTestId("import-expiry")).toHaveCount(0);
      await page.getByTestId("import-cancel").click();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("SAYS ONE UPLOAD AT A TIME, on every other control, rather than meeting a 409", async ({ page }) => {
    // services/intake-plan.ts holds ONE session for the whole install, shared
    // with the restore. A page that offered the other buttons would be offering
    // a button whose only possible answer is a refusal.
    await openDataSettings(page);
    await readColumns(page, foreignCsv("busy"));
    await page.getByTestId("import-csv-preview").click();
    await expect(page.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });

    await expect(page.getByTestId("import-export-preview")).toBeDisabled();
    await expect(page.getByTestId("import-export-blocked"))
      .toContainText("A preview is already waiting below");
    // AND IT NAMES THE RESTORE, because that is the control an operator would
    // otherwise reach for next and be refused by the same slot.
    await expect(page.getByTestId("import-export-blocked")).toContainText("restore");

    // AND THE MAPPING STEP'S OWN BUTTON, which is the one a review found live.
    // A successful preview does not unmount the mapping step -- the plan card
    // renders BESIDE it, so the operator can still see what they mapped and so
    // it is already there if a changed-world refusal drops them back onto it.
    // That left "Preview what this creates" pressable under a plan that was
    // already waiting, and its only possible answer was the 409 this page
    // exists to say out loud rather than meet.
    await expect(page.getByTestId("import-csv-preview")).toBeDisabled();
    await expect(page.getByTestId("import-csv-mapping-blocked"))
      .toContainText("A preview is already waiting below");

    await page.getByTestId("import-cancel").click();
    await expect(page.getByTestId("import-plan")).toHaveCount(0);
    await expect(page.getByTestId("import-export-blocked"))
      .toContainText("Choose a file to enable this");
  });

  test("REFUSES A BACKUP AND AN ARCHIVE at the two import controls", async ({ page }) => {
    // The asymmetry, guarded from the import side. An operator who typed a
    // passphrase into an importer has reached for the wrong control at the one
    // moment they needed the right one.
    await openDataSettings(page);
    await page.getByTestId("import-csv-file").setInputFiles({
      name: "conduit-backup.7z",
      mimeType: "application/x-7z-compressed",
      buffer: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]),
    });
    await page.getByTestId("import-csv-columns").click();
    await expect(page.getByTestId("import-csv-refusal")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("import-csv-refusal")).toContainText("not a CSV");
    // AND IT NAMES THE TWO CONTROLS THAT DO TAKE ONE, so a refusal is not a
    // dead end.
    await expect(page.getByTestId("import-csv-refusal")).toContainText("Restore");
    await page.getByTestId("import-csv-restart").click();
    await expect(page.getByTestId("import-csv-file")).toHaveValue("");
  });
});

/**
 * THE IMPORT SURFACE AT A PHONE WIDTH.
 *
 * The mapping step is the widest control this application has -- a header, its
 * sample values and a picker, once per column -- and an operator with a
 * spreadsheet to load is exactly as likely to be holding a phone as anybody
 * else. What this holds is the same pair the restore's phone journey does:
 * nothing off the side, and every control in the sequence a 44px target wholly
 * inside the viewport.
 */
test.describe("the import surface on a phone", () => {
  test.use(IPHONE_13);

  test("maps and previews at 390, with nothing off the side", async ({ page }) => {
    await openDataSettings(page);
    await readColumns(page, foreignCsv("phone"));

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "pixels the page overflows horizontally").toBeLessThanOrEqual(1);

    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("no viewport");

    for (const id of [
      "import-csv-field-0", "import-csv-field-3", "import-csv-owner",
      "import-csv-preview", "import-csv-restart",
    ]) {
      const control = page.getByTestId(id);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      if (box === null) throw new Error(`no geometry for ${id}`);
      expect(box.height, `${id} touch height`).toBeGreaterThanOrEqual(44);
      const outside = Math.max(0, (box.x + box.width) - viewport.width) + Math.max(0, -box.x);
      expect(outside, `pixels of ${id} outside the viewport`).toBe(0);
    }

    // AND THE PREVIEW IS STILL READABLE rather than clipped: its counts are the
    // whole point of it.
    await page.getByTestId("import-csv-preview").click();
    await expect(page.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("import-creates-insert-csv-contacts")).toContainText("2 rows");
    const after = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(after, "pixels the page overflows with a plan on screen").toBeLessThanOrEqual(1);

    for (const id of ["import-apply", "import-cancel"]) {
      const control = page.getByTestId(id);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      if (box === null) throw new Error(`no geometry for ${id}`);
      expect(box.height, `${id} touch height`).toBeGreaterThanOrEqual(44);
      const outside = Math.max(0, (box.x + box.width) - viewport.width) + Math.max(0, -box.x);
      expect(outside, `pixels of ${id} outside the viewport`).toBe(0);
    }

    // The upload is deleted rather than left to the half hour, which is also
    // what leaves the next journey a free slot.
    await page.getByTestId("import-cancel").click();
    await expect(page.getByTestId("import-plan")).toHaveCount(0);
  });
});
