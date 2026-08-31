import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, devices } from "@playwright/test";
import type { Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

/**
 * PHASE 7.6'S JOURNEY: the Settings page where the two artefacts are told
 * apart, the re-authentication gate in front of both, and -- the half that
 * matters -- that going round the page does not get you an archive.
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
 * tabs fit and four do not -- so "Export and backup" is the first tab that has
 * to be scrolled to before it can be touched. e2e/documents.spec.ts's phone
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
    const tab = nav.getByRole("link", { name: "Export and backup", exact: true });

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
