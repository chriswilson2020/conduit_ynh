import { createHash } from "node:crypto";
import { test, expect, devices } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { pdfHasImage } from "../packages/api/src/test/pdf.js";
import { flatColourLogo } from "./logo.js";

/**
 * Phase 7's journey: a quote raised from a deal is a numbered, branded PDF on
 * that deal's record, and a quote already issued never changes.
 *
 * WHAT A GREEN RUN HERE CLAIMS, and it is narrower than the phase's test suite.
 * The arithmetic, the sanitiser profile, the renderer's scheme allowlist, the
 * number's no-gaps property and the immutability claim in its strong form (the
 * stub renderer's spawn count is asserted unchanged across three edits) all
 * live in the unit and integration suites, which run against the real binary in
 * the `test` job. What only this file can say is that the SURFACES are wired to
 * them: that a person can fill in an issuer profile, open a deal, type four
 * lines at three tax rates, and get back a PDF whose totals match what the form
 * showed them -- and that the record does not move when the world does.
 *
 * IT NEEDS THE BINARY. `issueQuote` spawns python3 with WeasyPrint's API inside
 * the issuing transaction, so every test below that raises a quote fails on a
 * runner without it. The e2e job installs it (`.github/workflows/test.yml`);
 * Task 1 flagged that the job did not, and it did not until this file existed.
 *
 * THE SCAFFOLDING IS API, THE JOURNEY IS UI. A company, a pipeline, a stage and
 * a deal are what a person raising a quote ALREADY HAS, and driving four
 * creation dialogs to get them would put three other phases' surfaces in the
 * failure path of this one. Everything the phase itself added -- the issuer
 * profile and its logo, the quote form, the documents list, the download, the
 * rename that must not reach an issued quote -- is driven in the browser.
 * `POST /api/deals` takes `companyId` directly, so unlike e2e/mail.spec.ts's
 * contact link this needs no patch-shaped workaround.
 *
 * FIXTURE NAMING follows the suite: everything carries a run id, so a local
 * database with a previous run's rows in it cannot satisfy an assertion here.
 * The org profile is the one exception and cannot be one -- it is a singleton
 * row, there is exactly one of it per install, and this file overwrites it.
 * Nothing else in the suite reads it.
 */

/**
 * A LONGER PER-TEST BUDGET, AND IT IS NOT PAPERING OVER ANYTHING. Playwright's
 * default is 30s, and one legitimate submit here can consume all of it on its
 * own: `renderPdf` bounds a render at 20s and the wait for a render slot at a
 * further 10s, so a saturated renderer is entitled to take 30s before it
 * answers 503. Each test that raises a quote performs one of those, either side of
 * up to thirty form actions -- and the desktop group's longest test fills four line
 * items before it submits. Scoped to this file -- `test.describe.configure` at the
 * top level configures the enclosing scope and nothing else -- so none of the
 * suite's other 96 tests gains a second of slack.
 */
test.describe.configure({ timeout: 120_000 });

/** The touch floor the app set for itself in v0.10.0. */
const TOUCH_FLOOR_PX = 44;

/**
 * THE LOGO THIS JOURNEY UPLOADS, AND ITS SIZE IS THE POINT OF v1.0.1.
 *
 * It was a 1x1 opaque PNG of 70 bytes, which exercised the upload and said
 * nothing about the limit -- and the limit is what changed: 32KB was too small
 * for flat-colour artwork on a large canvas, which is what a company logo is.
 * This is 2000 x 1400 and about 293KB, the shape and size of a real one, and it
 * is nine times what v1.0.0 would have accepted.
 *
 * It is a real PNG rather than a plausible one, and that is what the upload
 * needs: `logoDataUriProblem` decodes the header and requires a signature
 * matching the declared type -- precisely because `File.type` comes from the
 * EXTENSION and an SVG renamed to .png used to be drawn as vector art in the
 * PDF -- and, since v1.0.1, dimensions it can read and afford. A byte string
 * that merely claimed to be a PNG would be refused here for the right reason
 * and would tell us nothing about the journey.
 */
const LOGO_PNG = flatColourLogo();

/**
 * The four lines every quote in this file is built from, and the totals they
 * must produce. Spelled out here because the numbers are the assertion.
 *
 * THE FOURTH LINE IS THERE FOR ITS HALF CENT. 0.50 at 21% is 10.5 cents of tax,
 * which `divideRoundHalfUp` takes to 11 -- so the total ends 61 and not 60, and
 * a renderer, a server or a form that rounded half-down would fail on the last
 * digit rather than pass by a rounding mode nobody looked at. Tax is computed
 * PER LINE and summed, which is why three rates in one document is the case
 * worth driving: 21% of the subtotal is not the answer.
 *
 * Currency is EUR because that is what config.ts defaults DEFAULT_CURRENCY to
 * and playwright.config.ts does not override it, and a document copies its
 * deal's currency rather than taking one from the form. The strings are what
 * MONEY_LOCALE ("en-GB") formats -- the app's one locale for the screen and the
 * PDF alike, which is Task 2's convergence and a visible change for anyone
 * whose browser was Dutch.
 */
const QUOTE_LINES = [
  { description: "Consultancy day rate", qty: "2", unitPrice: "1000.00", taxRate: "21", total: "\u20AC2,000.00" },
  { description: "Hosting, annual", qty: "1", unitPrice: "500.00", taxRate: "9", total: "\u20AC500.00" },
  { description: "Printed handbook", qty: "3", unitPrice: "25.00", taxRate: "0", total: "\u20AC75.00" },
  { description: "Postage", qty: "1", unitPrice: "0.50", taxRate: "21", total: "\u20AC0.50" },
] as const;
const QUOTE_SUBTOTAL = "\u20AC2,575.50";
const QUOTE_TAX = "\u20AC465.11";
const QUOTE_TOTAL = "\u20AC3,040.61";
/** The first two lines alone, which is what the phone journey types. */
const PHONE_TOTAL = "\u20AC2,965.00";

interface Fixture {
  readonly companyId: string;
  readonly dealId: string;
}

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
}

/** A company with an address, a pipeline, a stage, and a deal linked to the company. */
async function seedDeal(page: Page, companyName: string, address: string, dealTitle: string): Promise<Fixture> {
  const company = await create(page, "/api/companies", { name: companyName, address });
  const pipeline = await create(page, "/api/pipelines", { name: `${dealTitle} pipeline`, scope: "global" });
  const stage = await create(page, `/api/pipelines/${pipeline.id}/stages`, { name: "Lead" });
  const deal = await create(page, "/api/deals", {
    title: dealTitle,
    pipelineId: pipeline.id,
    stageId: stage.id,
    companyId: company.id,
    valueCents: 304_061,
  });
  return { companyId: company.id, dealId: deal.id };
}

/** Type one line of the quote into the row at `index`. */
async function fillLine(page: Page, index: number, line: (typeof QUOTE_LINES)[number]): Promise<void> {
  await page.getByTestId(`quote-line-description-${String(index)}`).fill(line.description);
  await page.getByTestId(`quote-line-qty-${String(index)}`).fill(line.qty);
  await page.getByTestId(`quote-line-price-${String(index)}`).fill(line.unitPrice);
  await page.getByTestId(`quote-line-tax-${String(index)}`).fill(line.taxRate);
}

/**
 * The newest quote's number, read off the row the app rendered rather than
 * guessed from a counter.
 *
 * `document-QUO-` matches the list item and nothing else: the total is
 * `document-total-QUO-...` and the link is `document-download-QUO-...`, so
 * neither collides with the prefix. The list is newest first.
 */
async function newestQuoteNumber(page: Page): Promise<string> {
  const row = page.locator('[data-testid^="document-QUO-"]').first();
  await expect(row).toBeVisible();
  const testId = await row.getAttribute("data-testid");
  if (testId === null) throw new Error("the newest documents row carries no data-testid");
  return testId.slice("document-".length);
}

/** sha256 of what the download route actually streams, asserted to be a PDF on the way past. */
async function downloadQuote(page: Page, number: string): Promise<string> {
  const href = await page.getByTestId(`document-download-${number}`).getAttribute("href");
  if (href === null) throw new Error(`the download link for ${number} has no href`);
  const response = await page.request.get(href);
  expect(response.status(), `GET ${href}`).toBe(200);
  // The mime the file was STORED with, served back unchanged: files.ts only
  // rewrites the render-capable handful to application/octet-stream, and a PDF
  // is not one of them.
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const bytes = await response.body();
  // The magic, not the extension. A zero-byte "PDF" is the exact failure Task 1
  // found in the first renderPdf -- a child that exits 0 having written nothing
  // -- and it would satisfy every other assertion in this file.
  expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(bytes.byteLength).toBeGreaterThan(1000);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The same download, plus the assertion this release exists for: the LOGO IS IN
 * THE PDF.
 *
 * A byte count is not proof that it is. The whole journey -- a 293KB image
 * through the form, past `logoDataUriProblem`, into a `text` column, out of it
 * into a merge, through the sanitiser, down a pipe as a `data:` URI and into
 * WeasyPrint -- can succeed at every visible step and produce a quote with a
 * blank letterhead, which is exactly what happens if the renderer decides it
 * cannot decode the picture. `pdfHasImage` looks for the image XObject it
 * becomes, in the compressed streams as well as the plain bytes.
 */
async function downloadQuoteWithLogo(page: Page, number: string): Promise<string> {
  const href = await page.getByTestId(`document-download-${number}`).getAttribute("href");
  if (href === null) throw new Error(`the download link for ${number} has no href`);
  const digest = await downloadQuote(page, number);
  const bytes = await (await page.request.get(href)).body();
  expect(pdfHasImage(bytes)).toBe(true);
  // And the image is the logo rather than a rounding error: 2.8 megapixels of
  // artwork is a PDF several times the size of the 14KB one a logo-less quote
  // renders to (documents-seed.test.ts prints both).
  expect(bytes.byteLength).toBeGreaterThan(100_000);
  return digest;
}

/**
 * How far content runs past the edge, measured on `<main>` -- WHICH IS NOT WHERE
 * THIS USED TO LOOK, AND THE OLD READING COULD NOT FAIL.
 *
 * It read `documentElement.scrollWidth - innerWidth`, and `<main>` has carried
 * `overflow-auto` since the first web commit of this project. A scroll container
 * does not propagate its overflow to its ancestors, so the document never grew
 * however far a child ran over, and all three callers below were asserting
 * `0 <= 1` at every viewport from the day they were written. MEASURED, by
 * injecting a div 200px wider than the viewport into `main`: the document
 * answered 0 and `main.scrollWidth - main.clientWidth` answered 472 at 1280 and
 * 224 at 390.
 *
 * v1.1.0 first blamed the `max-md:overflow-clip` Task 2 added, and that was
 * wrong in a way worth recording: `clip` did not break this reading, it made the
 * CONSEQUENCE worse. Under `auto` the overflow was at least swipe-reachable;
 * under `clip` it is cut. The blindness is older than either.
 *
 * Reading `main` also gives the right exclusion for free: the line-item table's
 * own `overflow-x-auto` box is allowed to scroll by design, and a nested scroll
 * container does not propagate to `main` either. The threshold stays 1 for
 * sub-pixel rounding.
 */
async function pageOverflow(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main === null) throw new Error("this page has no <main> to measure");
    return main.scrollWidth - main.clientWidth;
  });
}

/** An element's box, or a failure that names the element rather than a null. */
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no box for ${String(locator)}`);
  return box;
}

/**
 * A touch target has to be big enough, on screen, and actually under the thumb, and
 * until this existed the seven assertion sites below -- fourteen controls between them
 * -- only asked the first of those.
 *
 * A BOUNDING BOX EXISTS WHETHER OR NOT THE CONTROL IS VISIBLE. `<main>` carries
 * `max-md:overflow-clip` (components/shell.tsx explains why: it is what lets a phone
 * page have a sticky strip at all), so below the breakpoint a control laid out past
 * its edge is CUT rather than scrolled to -- and `boundingBox().height` answers 44
 * for it exactly as it does for one a thumb can reach. The assertion meant to cover
 * that was `documentElement.scrollWidth`, which v1.1.0 found had been blind since the
 * first web commit; `pageOverflow` above is its repair, but it measures the PAGE and
 * cannot say which control went over the side.
 *
 * `toBeInViewport` is the instrument because it is IntersectionObserver, and an
 * intersection rect is clipped by every ancestor's clip rect on the way up. THE SCROLL
 * IN FRONT OF IT IS NOT DECORATION, and the obvious version of this guard -- a bare
 * `toBeInViewport` -- is simply wrong: measured in this file's own order with nothing
 * scrolled, EIGHT of the fourteen controls it covers are outside the viewport at the
 * moment they are reached, at intersection ratio 0. All four line fields and Add line
 * are below the fold inside the quote dialog, and `org-email`, the logo picker and
 * `org-save` are below it down the settings form. Every one of them is reachable; a
 * bare check would have failed them for being far away. Scrolling first is what a
 * person does, and a clip is the thing that cannot be scrolled past: `overflow: clip`
 * establishes no scroll container, and the clipped child does not reach the document's
 * scrolling area either, so nothing can bring it back.
 *
 * AND THE VIEWPORT IS NOT THE THUMB. IntersectionObserver does no occlusion testing,
 * and `scrollIntoViewIfNeeded` is a NO-OP on an element already inside the scrollport
 * -- including when "inside" means "underneath something". `BottomNav` is
 * `fixed inset-x-0 bottom-0` on every phone page, and NINE of these fourteen are on a
 * page rather than in the quote dialog -- the dialog is portalled to the end of
 * `<body>`, which is what puts it above a bar that carries no z-index. So the failure
 * has a standing shape here for those nine. MEASURED, by deleting
 * the bottom reservation `<main>` carries for exactly this reason
 * (`pb-[calc(6rem_+_env(safe-area-inset-bottom))]`, and components/bottom-nav.tsx says
 * why): `org-save` then sits at y 620..664 against a bar whose top edge is 619, with
 * the page already at its maximum scroll, `document.elementFromPoint` at the control's
 * centre returning the NAV -- and the viewport check passes. `tap({ trial: true })`
 * is what fails it: a trial action runs the actionability checks (visible, stable,
 * receives events) and performs no tap. It is `tap` rather than `click` because
 * `click` also waits for ENABLED and `org-save` carries `disabled={pending}`, and the
 * group is `devices["iPhone 13"]`, so touch exists to be trialled.
 *
 * PROVED AGAINST CASES THAT MUST FAIL, at 390x664 on this file's iPhone 13 group, one
 * displacement at a time injected at `org-save` on the SETTINGS page -- directly under
 * `<main>`'s `max-md:overflow-clip`, which is where the rows below were taken and is
 * not the container five of the seven sites sit in (see the next paragraph). The
 * height check answered PASS to every displacement here:
 *
 *   | displacement of `org-save`                     | height | viewport | tap |
 *   | 500px right, or 500px left, inside main's clip | PASS   | FAIL     | FAIL|
 *   | `position: fixed; left: -9999px`               | PASS   | FAIL     | FAIL|
 *   | 3000px down by `position: relative` (clipped)  | PASS   | FAIL     | FAIL|
 *   | 3000px down by MARGIN (main grows, doc scrolls)| PASS   | PASS     | PASS|
 *   | under the bar, page at maximum scroll          | PASS   | PASS     | FAIL|
 *   | a full-viewport `position: fixed` overlay      | PASS   | PASS     | FAIL|
 *   | `visibility: hidden`                           | PASS   | PASS     | FAIL|
 *   | `opacity: 0`                                   | PASS   | PASS     | PASS|
 *   | `display: none`                                | FAIL   | FAIL     | FAIL|
 *
 * The fourth row is the discrimination that keeps the scroll honest: the same 3000px
 * moves a control out of reach when `<main>` clips it and merely far down the page
 * when `<main>` grows with it. A settings tab pushed outside the nav's own
 * `overflow-x: auto` row passes both checks as well -- verified by giving the first
 * tab 600px of padding: intersection ratio 0 before the scroll, 1 after, tap in 49ms.
 *
 * WHAT IS STILL MISSED, and it is one thing rather than none. `opacity: 0` keeps its
 * box (56x44 on `org-save`), intersects, and receives events, so it walks past all
 * three checks; catching it needs a computed-style read, which is a different guard.
 * `display: none` is caught by the `boxOf` above -- which is also why the height is
 * taken FIRST: a missing control then fails as `no box for ...`, naming itself,
 * instead of spending a timeout inside the scroll.
 *
 * AND `overflow: hidden` MANUFACTURES A PASS, which is worth knowing before the next
 * reader generalises "a clip cannot be scrolled past". A `hidden` box is a scroll
 * container that simply has no scrollbar and cannot be panned by a thumb, so
 * `scrollIntoViewIfNeeded` scrolls it programmatically and everything below answers
 * PASS: measured twice, with `<main>` forced to `hidden` and `org-save` displaced
 * +500px (main scrolled to 476 and the control passed all three checks), and with the
 * settings nav forced to `hidden` around 881px of tabs (row scrolled to 539, pass).
 * Nothing in this app wraps any of the fourteen in `overflow-hidden` today, and
 * `clip` -- which is what shell.tsx actually uses -- does fail correctly.
 *
 * THE ROWS ABOVE WERE TAKEN UNDER `<main>`, AND FIVE OF THE SEVEN SITES ARE NOT
 * THERE. The four line fields and Add line are inside the quote dialog, whose phone
 * surface is `max-md:overflow-y-auto` on a `fixed` box and computes to
 * `overflow-x: auto` as well -- a scroll container on both axes, not a clip. So a
 * RIGHTWARD displacement inside the dialog is scroll-reachable and passes here, as it
 * should: measured, by pushing the description field 500px right, which this let
 * through and which the line table's own `overflow-x-auto` assertion below caught
 * instead. The per-guard mutations used `translateX(-500px)` precisely because
 * leftward overflow is unreachable in LTR whatever the container, so they say nothing
 * about the dialog's horizontal axis either. What guards these five is the clip on the
 * page behind them and the reachability of each field in a dialog that scrolls.
 *
 * RATIO 1 IS THE WHOLE CONTROL, and it is a measurement rather than an aspiration:
 * every one of the fourteen answers exactly 1 after its scroll, so nothing here is
 * passing on rounding slack (Playwright's own epsilon is 1e-9). A control that only
 * half clears the clip is the same defect as one entirely behind it. The one thing
 * ratio 1 cannot be asked about is a control BIGGER than the viewport, which can never
 * satisfy it -- measured, by inflating a nav tab to 708px in a 390px viewport, where
 * it fails after being scrolled correctly into view. Every control here is at most
 * 342x44.
 *
 * IT RETURNS NOTHING, DELIBERATELY. Callers that also compare geometry keep their own
 * `boxOf` call, because scrolling moves the frame: the description field measured at
 * y=680, and after its own scroll the three fields on the line under it measured y=390
 * -- a frame that moved 334px between two `boxOf` calls. Boxes handed back from
 * separate calls would sit in different coordinate systems, and any y comparison
 * across them would be arithmetic over two frames. Widths and heights are
 * scroll-invariant, which is why the height check here can be taken before the scroll.
 *
 * THE TRIAL TAP'S TIMEOUT IS BOUNDED because its failures are timeouts: a trial action
 * retries until it succeeds or the clock runs out, and with no bound that clock is
 * this file's 120s per-test budget. 5s is Playwright's own default expect timeout,
 * which the line above it already spends, and a passing trial on these controls
 * measured 43-51ms through this loop's ssh tunnel -- two orders of magnitude of slack.
 */
async function expectTouchTarget(locator: Locator): Promise<void> {
  const box = await boxOf(locator);
  expect(box.height, `${String(locator)} touch height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${String(locator)} reachable`).toBeInViewport({ ratio: 1 });
  await locator.tap({ trial: true, timeout: 5_000 });
}

/**
 * The computed width of the one open dialog, in CSS pixels.
 *
 * COMPUTED, and that is the whole reason this exists. Nothing in this repo has
 * ever asserted that a dialog is as wide as its caller asked -- the unit suite
 * has no DOM, and the guard that does exist reads the CALLERS' source strings,
 * which survive every mutation that makes those strings do nothing. That gap is
 * what let `ui/dialog.tsx` hard-code `max-w-md` into the shape and silently beat
 * every caller's width -- the three that predate this phase inert since the
 * utility was introduced, and the quote form born inert as a fourth. Tailwind
 * sorts `max-w-*` ALPHABETICALLY,
 * so `.max-w-md` is emitted after `.max-w-2xl` and `.max-w-3xl` and wins at
 * equal specificity, and class order in the attribute decides nothing. The quote
 * form therefore opened at 448px on a 1280px screen with 83px of table overflow
 * and its Remove button off the right-hand edge.
 *
 * Both numbers are read: `max-width` is the caller's class arriving at all, and
 * `width` is it deciding the box. The two together are what a re-introduced
 * `max-w-md` in the shape would fail.
 */
async function dialogWidth(page: Page): Promise<{ width: string; maxWidth: string }> {
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toHaveCount(1);
  return await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.width, maxWidth: style.maxWidth };
  });
}

// ---------------------------------------------------------------------------
// The desktop journey. One serial group sharing a page, the way crm.spec.ts and
// pipeline.spec.ts accumulate state: the org profile filled in the first test is
// what the quote raised in the second is branded with, and the quote raised in
// the second is what the fourth proves the rename never reached.
// ---------------------------------------------------------------------------

test.describe.serial("Raising a quote from a deal", () => {
  const runId = Date.now().toString(36);
  const companyAddress = "12 Market Street\nUtrecht\nNL";

  // `${runId}x${retry}`, the suite's convention, and the reason is the same one
  // e2e/mobile.spec.ts gives: nothing empties the database between attempts, and
  // several assertions below are whole-list or absence statements -- "this row does
  // not mention the new name", "this deal has exactly two documents" -- which a
  // previous attempt's identically-named rows would break for good. A serial group
  // re-runs from the top on a retry, so beforeAll is the one place guaranteed to run
  // again with the new index.
  let attemptId = "";
  let orgName = "";
  let companyName = "";
  let renamedCompany = "";
  let dealTitle = "";

  let page: Page;
  let fixture: Fixture;
  let firstNumber = "";
  let firstDigest = "";

  test.beforeAll(async ({ browser }, testInfo) => {
    attemptId = `${runId}x${String(testInfo.retry)}`;
    orgName = `Listerdale ${attemptId}`;
    companyName = `Quoteco ${attemptId}`;
    renamedCompany = `Quoteco Holdings ${attemptId}`;
    dealTitle = `Rollout ${attemptId}`;
    page = await browser.newPage();
    fixture = await seedDeal(page, companyName, companyAddress, dealTitle);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("fills in the organisation profile, logo and all", async () => {
    await page.goto("/settings/org");

    // THE SEED HAS TO HAVE HAPPENED BEFORE ANYTHING IS TYPED. The form renders
    // immediately with empty fields and a "Loading..." line, and seeds itself
    // from the server's row once -- so a fill that lands in that window is
    // overwritten by the seed a moment later, and the save that follows stores
    // whatever was on the server already. Waiting for the line to go is waiting
    // for the query to resolve, which is what the seed is keyed on.
    const form = page.getByTestId("org-settings");
    await expect(form).toBeVisible();
    await expect(form.getByText("Loading...", { exact: true })).toHaveCount(0);

    await page.getByTestId("org-name").fill(orgName);
    await page.getByTestId("org-address").fill("1 Kingsway\nLondon\nWC2B 6AA");
    await page.getByTestId("org-vat").fill("GB123456789");
    await page.getByTestId("org-registration").fill("09876543");
    await page.getByTestId("org-email").fill("accounts@example.test");
    await page.getByTestId("org-phone").fill("+44 20 7946 0000");
    await page.getByTestId("org-website").fill("https://example.test");
    await page.getByTestId("org-bank").fill("IBAN GB00 EXMP 0000 0000 0000 00");

    // THE ONE BRANCH IN THIS FILE, AND THE SINGLETON IS WHY. Every other fixture
    // here carries a run id and is therefore new; the issuer profile is one row
    // per install, so a previous run -- or a previous ATTEMPT, since a serial
    // group re-runs from the top on a retry and nothing empties the database
    // between attempts -- may already have left a logo on it. Clearing it first
    // is what makes "no logo means a plain letterhead" an assertion rather than
    // a statement about which run this is.
    const removeLogo = page.getByTestId("org-logo-remove");
    if (await removeLogo.count() > 0) await removeLogo.click();
    await expect(page.getByTestId("org-logo-empty")).toBeVisible();
    // THE SIZE IS AN ASSERTION, not an assumption about the generator: a logo
    // that quietly came out at 30KB would pass every step below and would be
    // testing v1.0.0's limit rather than this one. Past 32KB is the half that
    // has to be said here; inside 300KB is said by the upload being ACCEPTED
    // three lines below, which is the black-box version of the same claim and
    // does not need this process to import the app's constants.
    expect(LOGO_PNG.byteLength).toBeGreaterThan(32 * 1024);
    expect(LOGO_PNG.byteLength).toBe(293_138);
    await page.getByTestId("org-logo-input").setInputFiles({
      name: `logo-${attemptId}.png`,
      mimeType: "image/png",
      buffer: LOGO_PNG,
    });
    // Accepted rather than merely chosen: the preview only renders once
    // logoDataUriProblem has returned null, so its appearance IS the shared
    // check passing on the decoded bytes AND on the dimensions in the header,
    // and no refusal is on screen.
    await expect(page.getByTestId("org-logo-preview")).toBeVisible();
    await expect(page.getByTestId("org-logo-preview")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await expect(page.getByTestId("org-logo-problem")).toHaveCount(0);

    await page.getByTestId("org-save").click();
    await expect(page.getByTestId("org-saved")).toBeVisible();

    // It is a row, not a form state: reloaded from the server, the name and the
    // logo are still there. This is what the quote below is branded with.
    await page.reload();
    await expect(page.getByTestId("org-name")).toHaveValue(orgName);
    await expect(page.getByTestId("org-logo-preview")).toBeVisible();
  });

  test("refuses a quote by naming the box that is empty", async () => {
    await page.goto(`/deals/${fixture.dealId}`);
    // The company's name arriving on the page is the linked-company query having
    // resolved, which is what the form's recipient default is read from at mount.
    // Opening the dialog first would seed an empty Recipient for a reason that
    // has nothing to do with the deal.
    await expect(page.getByTestId("field-companyId")).toContainText(companyName);

    await expect(page.getByTestId("documents-empty")).toBeVisible();
    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();
    await expect(page.getByTestId("quote-recipient-name")).toHaveValue(companyName);

    // A quote that is refused for a reason nobody can act on is the failure Task
    // 5 found in the primary journey: every schema-level refusal read as Zod's
    // own English about a JSON value, and any deal with no linked company opens
    // with an empty Recipient, so that was the entire feedback beside two valid
    // lines and a total. The claim here is that the refusal NAMES THE FIELD.
    await page.getByTestId("quote-recipient-name").fill("");
    await fillLine(page, 0, QUOTE_LINES[0]);
    await page.getByTestId("quote-submit").click();

    const refusal = page.getByTestId("quote-refusal");
    await expect(refusal).toBeVisible();
    await expect(page.getByTestId("quote-problems")).toContainText("Recipient is required.");
    // Zod's raw sentence for the same failure, which names no field. Asserting
    // its absence is what fails if describeIssue is ever bypassed -- the message
    // alone would still be perfectly descriptive, and perfectly useless.
    await expect(page.getByTestId("quote-problems")).not.toContainText("Too small");
    // The refusal is where the person is, not 536px below the fold: the region
    // takes focus so the next Tab starts at the problem list and a screen
    // reader's cursor moves with it.
    await expect(refusal).toBeFocused();
  });

  test("raises a quote with four lines at three tax rates", async () => {
    // Continuing in the dialog the previous test left open, with the refusal on
    // screen: this is the fix-and-resubmit a person actually performs.
    await expect(page.getByTestId("quote-form")).toBeVisible();
    await page.getByTestId("quote-recipient-name").fill(companyName);
    await page.getByTestId("quote-recipient-contact").fill("Accounts Payable");
    await page.getByTestId("quote-recipient-address").fill(companyAddress);
    await page.getByTestId("quote-valid-until").fill("2026-12-31");
    await page.getByTestId("quote-notes").fill(`Prepared for ${dealTitle}.`);
    await page.getByTestId("quote-terms").fill("Payment within 30 days of issue.");

    for (let index = 1; index < QUOTE_LINES.length; index += 1) {
      await page.getByTestId("quote-add-line").click();
    }
    await expect(page.getByTestId("quote-line-count")).toContainText(`${String(QUOTE_LINES.length)} of`);
    for (const [index, line] of QUOTE_LINES.entries()) {
      await fillLine(page, index, line);
      await expect(page.getByTestId(`quote-line-total-${String(index)}`)).toHaveText(line.total);
    }

    // The form's running total, computed by the same @conduit/shared arithmetic
    // the server is about to run. Tax per line and summed: 21% of the subtotal
    // would be 540.86 and is not what a quote at three rates costs.
    await expect(page.getByTestId("quote-subtotal")).toHaveText(QUOTE_SUBTOTAL);
    await expect(page.getByTestId("quote-tax")).toHaveText(QUOTE_TAX);
    await expect(page.getByTestId("quote-total")).toHaveText(QUOTE_TOTAL);

    await page.getByTestId("quote-submit").click();
    // The dialog closing is the mutation having succeeded. Generously timed
    // because this is a real WeasyPrint subprocess inside a transaction, not a
    // stub: a one-page quote measured 0.6s on the server's 57.2 and the render
    // has a 20s ceiling of its own.
    await expect(page.getByTestId("quote-form")).toBeHidden({ timeout: 60_000 });

    firstNumber = await newestQuoteNumber(page);
    // Per type, per year, four digits, and the year is the ISSUE DATE's -- which
    // is why it is read off the form's own default rather than from this
    // machine's clock a step later.
    expect(firstNumber).toMatch(/^QUO-\d{4}-\d{4}$/);

    // The server's stored total, formatted from its own integer cents, agreeing
    // with the figure the form showed before anything was submitted. These are
    // two computations of the same arithmetic and this is the only place they
    // meet.
    await expect(page.getByTestId(`document-total-${firstNumber}`)).toHaveText(QUOTE_TOTAL);
    await expect(page.getByTestId(`document-${firstNumber}`)).toContainText(companyName);
    await expect(page.getByTestId("documents-empty")).toHaveCount(0);

    // AND ON THE FILES TAB, because the PDF is an ordinary files row against the
    // deal rather than a second kind of storage. There is no new download code
    // in this phase and this is what says so.
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByTestId("files")).toContainText(`${firstNumber}.pdf`);
  });

  test("downloads the quote, and the issuer's logo is really in it", async () => {
    await page.goto(`/deals/${fixture.dealId}`);
    firstDigest = await downloadQuoteWithLogo(page, firstNumber);
  });

  test("renaming the company does not reach a quote already issued", async () => {
    // The rename a person performs: inline on the company's own field card.
    await page.goto(`/companies/${fixture.companyId}`);
    const nameField = page.getByTestId("field-name");
    await nameField.click();
    const nameInput = nameField.locator("input");
    await nameInput.fill(renamedCompany);
    await nameInput.press("Enter");
    await expect(nameField).toContainText(renamedCompany);

    // The issuer moves too, which the row cannot show at all: `documents` stores
    // no issuer snapshot, so the PDF is the only record of who a quote was from.
    // A byte-identical download across this edit is the only assertion that
    // reaches it.
    await page.goto("/settings/org");
    await expect(page.getByTestId("org-settings").getByText("Loading...", { exact: true })).toHaveCount(0);
    await page.getByTestId("org-name").fill(`${orgName} Limited`);
    await page.getByTestId("org-save").click();
    await expect(page.getByTestId("org-saved")).toBeVisible();

    await page.goto(`/deals/${fixture.dealId}`);
    // The deal now shows the new name, so the FORM's default would be the new
    // one -- and the stored row still says what it said.
    await expect(page.getByTestId("field-companyId")).toContainText(renamedCompany);
    const row = page.getByTestId(`document-${firstNumber}`);
    await expect(row).toContainText(companyName);
    await expect(row).not.toContainText(renamedCompany);
    await expect(page.getByTestId(`document-total-${firstNumber}`)).toHaveText(QUOTE_TOTAL);

    // The artifact, not just the record. Compared as STORED BYTES and never
    // re-rendered: Task 1 measured three renders of identical input at 6899,
    // 6899 and 6898 bytes, so a re-render-and-diff test would fail for reasons
    // that have nothing to do with immutability.
    expect(await downloadQuote(page, firstNumber)).toBe(firstDigest);
  });

  test("a second quote takes its own number", async () => {
    await page.goto(`/deals/${fixture.dealId}`);
    await expect(page.getByTestId("field-companyId")).toContainText(renamedCompany);
    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();
    // Defaulted from the deal's company, which has been renamed since the first
    // quote: the SECOND quote is addressed to the new name and the first is not,
    // which is the snapshot working in both directions.
    await expect(page.getByTestId("quote-recipient-name")).toHaveValue(renamedCompany);

    await fillLine(page, 0, QUOTE_LINES[0]);
    await page.getByTestId("quote-submit").click();
    await expect(page.getByTestId("quote-form")).toBeHidden({ timeout: 60_000 });

    const secondNumber = await newestQuoteNumber(page);
    expect(secondNumber).not.toBe(firstNumber);
    // Consecutive, which is the property `nextval()` could not have given: the
    // allocation is a table row inside the issuing transaction, so a failed
    // render spends no number and the sequence has no holes to explain. Two
    // quotes raised back to back in one year are the cheapest observation of it
    // that does not require a fresh database.
    const sequenceOf = (number: string) => Number.parseInt(number.slice(-4), 10);
    expect(sequenceOf(secondNumber)).toBe(sequenceOf(firstNumber) + 1);
    expect(secondNumber.slice(0, -4)).toBe(firstNumber.slice(0, -4));

    await expect(page.locator('[data-testid^="document-QUO-"]')).toHaveCount(2);
    await expect(page.getByTestId(`document-${secondNumber}`)).toContainText(renamedCompany);
    await downloadQuote(page, secondNumber);
  });

  test("opens each dialog as wide as its caller asked", async () => {
    // THE GUARD THIS REPO HAS NEVER HAD. See dialogWidth: a caller's width class
    // was inert since the utility was introduced and every test in the suite stayed
    // green, because nothing anywhere measured a box. Three callers are read rather than one --
    // two at max-w-3xl and one at max-w-2xl -- because two dialogs of the SAME
    // width cannot tell "the caller's class decided" from "the default happens to
    // be 768px now". 672 and 768 in one run can.
    // ASSERTED, NOT SET. A mid-test resize is the one move e2e/mobile.spec.ts
    // warns against, and this group has never needed one: browser.newPage()
    // opens at Playwright's default 1280x720. The floor is 800 because that is
    // where the shape's own w-[calc(100%-2rem)] stops being the binding
    // constraint on the wider of the two caps below (768 + 32).
    const viewport = page.viewportSize();
    expect(viewport?.width ?? 0).toBeGreaterThanOrEqual(800);

    await page.goto(`/deals/${fixture.dealId}`);
    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();
    // max-w-3xl is 48rem. The shape's own w-[calc(100%-2rem)] would be 1248px
    // here, so 768 is the caller's cap deciding, and the pre-fix `max-w-md`
    // would read 448.
    expect(await dialogWidth(page)).toEqual({ width: "768px", maxWidth: "768px" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quote-form")).toHaveCount(0);

    // The mail composer, a Phase 4 surface the width fix reached: also max-w-3xl,
    // and one of the three dialogs that are wider at a desk than they were in
    // v0.10.0. It opens with no mail account configured -- the form renders and
    // says so in its From row -- so this needs none of e2e/mail.spec.ts's fixture.
    await page.goto("/mail");
    await page.getByTestId("compose-button").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    expect(await dialogWidth(page)).toEqual({ width: "768px", maxWidth: "768px" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer")).toHaveCount(0);

    // Mail settings at max-w-2xl (42rem). The one that makes the pair above a
    // measurement rather than a coincidence.
    await page.goto("/settings/mail");
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("account-form")).toBeVisible();
    expect(await dialogWidth(page)).toEqual({ width: "672px", maxWidth: "672px" });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("account-form")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// The phone. The line-item editor is the surface the spec names as the hard one
// -- a table of description, quantity, price and tax is the exact shape that
// does not fit 390px -- so it gets driven at 390px rather than measured once and
// asserted about in prose.
// ---------------------------------------------------------------------------

/**
 * WHY test.use AND NOT A `projects` ARRAY, and why the descriptor is spread
 * minus one key: both reasons are e2e/mobile.spec.ts's and are unchanged here.
 * `playwright.config.ts` has no `projects`, so adding one to give this file a
 * device would re-home all 96 existing tests, which is exactly the
 * re-baselining this task forbids; and `devices["iPhone 13"]` carries
 * `defaultBrowserType: "webkit"`, which `browserName` forwards, so spreading it
 * whole would move these tests onto a browser the e2e job deliberately does not
 * install (`npx playwright install chromium`, and only chromium).
 *
 * THE ONE DEVIATION FROM THAT FILE IS THE SCOPE, and it is deliberate: the
 * `test.use` is on this DESCRIBE rather than on the file, because the desktop
 * group above has to stay at a desk -- the dialog-width guard is a statement
 * about 1280px and means nothing at 390. A describe-scoped `test.use` keeps the
 * property that matters, which is that the viewport is set at CONTEXT CREATION:
 * a mid-test `setViewportSize` goes through CDP, which updates a
 * MediaQueryList's `matches` WITHOUT dispatching `change`, so `useIsMobile()`
 * -- a `useSyncExternalStore` over that event -- would never see it and the
 * desktop tree would render at a phone's width. Nothing below resizes.
 */
const { defaultBrowserType: _webkitByDefault, ...IPHONE_13 } = devices["iPhone 13"];

test.describe("The line-item editor on a phone", () => {
  test.use(IPHONE_13);

  test("stacks the line into a card, keeps the total in sight, and raises the quote", async ({ page }, testInfo) => {
    const attemptId = `${Date.now().toString(36)}x${String(testInfo.retry)}`;
    const companyName = `Phonequote ${attemptId}`;
    const fixture = await seedDeal(page, companyName, "3 Dorpsstraat\nAmersfoort", `Phone rollout ${attemptId}`);

    await page.goto(`/deals/${fixture.dealId}`);
    await expect(page.getByTestId("field-companyId")).toContainText(companyName);
    await page.getByTestId("new-quote-button").click();
    const form = page.getByTestId("quote-form");
    await expect(form).toBeVisible();

    // THE CARD, NOT THE TABLE. One DOM restyled rather than a second list
    // rendered beside a hidden table, so every `quote-line-*` testid the desktop
    // journey addresses is still a single element here. The column heads carry
    // no meaning at this width and are gone; each field carries its own label
    // instead.
    // Scoped to the form: `toBeHidden` on a locator that resolves to more than
    // one element is a strict-mode violation, and the page behind the sheet is
    // free to grow a table of its own.
    //
    // COUNT FIRST, BECAUSE toBeHidden PASSES ON A MISSING ELEMENT. The claim is that
    // the head EXISTS and is hidden by CSS -- one DOM restyled, not a second tree
    // rendered -- and a form that had stopped rendering its column headings
    // altogether would satisfy toBeHidden alone.
    await expect(form.locator("thead")).toHaveCount(1);
    await expect(form.locator("thead")).toBeHidden();
    const row = page.getByTestId("quote-line-0");
    for (const label of ["Description", "Qty", "Unit price", "Tax %", "Line total"]) {
      await expect(row.getByText(label, { exact: true })).toBeVisible();
    }

    // THE SHIPPED LAYOUT, AND THE HALF OF THE EXPECTED ANSWER IT REFUTED. One
    // field per line was the obvious phone layout and is wrong: a description
    // needs the full width, but a quantity, a price and a tax rate are three to
    // six characters each and giving them a line apiece takes a card from 230px
    // to 418px for nothing. So the claim is structural -- description alone on
    // its own line, the three money fields sharing the next -- rather than a
    // pixel count that would re-baseline on any font change.
    // THE FOUR BOXES ARE TAKEN BEFORE ANYTHING SCROLLS, and they have to be: these
    // are comparisons BETWEEN boxes, so all four must come from one coordinate frame.
    // The reachability pass below is what moves the frame, and it runs after.
    const descriptionBox = await boxOf(page.getByTestId("quote-line-description-0"));
    const qtyBox = await boxOf(page.getByTestId("quote-line-qty-0"));
    const priceBox = await boxOf(page.getByTestId("quote-line-price-0"));
    const taxBox = await boxOf(page.getByTestId("quote-line-tax-0"));
    expect(descriptionBox.y + descriptionBox.height).toBeLessThanOrEqual(qtyBox.y + 1);
    expect(Math.abs(priceBox.y - qtyBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(taxBox.y - qtyBox.y)).toBeLessThanOrEqual(1);
    expect(descriptionBox.width).toBeGreaterThan(qtyBox.width * 2);
    // Every one of them still reachable with a thumb -- big enough AND on screen.
    for (const id of ["quote-line-description-0", "quote-line-qty-0", "quote-line-price-0", "quote-line-tax-0"]) {
      await expectTouchTarget(page.getByTestId(id));
    }

    // AND NOTHING OVERFLOWS SIDEWAYS. The `Table` primitive puts its table in an
    // `overflow-x-auto` box, which is where a four-column row's 142px of excess
    // went before the cards: a scroll box that fits its content is the assertion
    // that the row was actually re-laid out rather than merely made scrollable.
    const scrollBox = page.getByTestId("quote-form").locator("div.overflow-x-auto").first();
    const overflow = await scrollBox.evaluate((element) => element.scrollWidth - element.clientWidth);
    // One pixel of slack for sub-pixel rounding: scrollWidth and clientWidth are
    // both integers over fractional layout, and the measurement this is about is
    // the 142px a four-column row overflowed by, not a rounding bit.
    expect(overflow).toBeLessThanOrEqual(1);

    // Adding a line takes no aim: full width, and above the floor.
    const addLine = page.getByTestId("quote-add-line");
    await expectTouchTarget(addLine);
    // Width only, and widths do not move when the frame does.
    const addBox = await boxOf(addLine);
    expect(addBox.width).toBeGreaterThan(descriptionBox.width * 0.9);

    await fillLine(page, 0, QUOTE_LINES[0]);
    await addLine.click();
    await fillLine(page, 1, QUOTE_LINES[1]);
    await expect(page.getByTestId("quote-total")).toHaveText(PHONE_TOTAL);

    // THE RUNNING TOTAL STAYS VISIBLE WHILE YOU TYPE. Below the breakpoint the
    // dialog is the scroll container -- pinned to all four edges, scrolling its
    // own content, because a dialog centred in the LAYOUT viewport takes its
    // fields under the on-screen keyboard -- which is what makes a sticky footer
    // inside it stick. Sampled at both ends of the scroll rather than once.
    const dialog = page.locator('[role="dialog"]');
    const totals = page.getByTestId("quote-totals");
    await expect(totals).toBeInViewport();
    // ASSERT THAT IT ACTUALLY SCROLLED. Setting scrollTop on an element that does not
    // overflow is a silent no-op, and three toBeInViewport checks against an
    // unscrolled dialog are one check written three times. The first of them is still
    // the user-visible half -- at scrollTop 0 the total is far below the fold in the
    // document's own flow and is only on screen because it is sticky.
    const scrolled = await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await expect(totals).toBeInViewport();
    await dialog.evaluate((element) => { element.scrollTop = 0; });
    await expect(totals).toBeInViewport();

    // And the quote is raised from the phone, not merely laid out on it.
    await page.getByTestId("quote-submit").click();
    await expect(form).toBeHidden({ timeout: 60_000 });
    const number = await newestQuoteNumber(page);
    expect(number).toMatch(/^QUO-\d{4}-\d{4}$/);
    await expect(page.getByTestId(`document-total-${number}`)).toHaveText(PHONE_TOTAL);
    await downloadQuote(page, number);

    // THE DOCUMENTS SECTION IS A SURFACE THIS PHASE ADDS, so it meets the same
    // standard rather than merely rendering. The row stacks below the breakpoint --
    // the number and date above, the total and Download below, instead of one line
    // that would put the link past the edge -- and Download is the only way to reach
    // the artifact from here, so it carries the floor.
    const documentRow = page.getByTestId(`document-${number}`);
    const numberBox = await boxOf(documentRow.getByText(number, { exact: true }));
    const downloadBox = await boxOf(page.getByTestId(`document-download-${number}`));
    // One frame for the stacking comparison, then the reachability pass.
    expect(downloadBox.y).toBeGreaterThanOrEqual(numberBox.y + numberBox.height - 1);
    await expectTouchTarget(page.getByTestId(`document-download-${number}`));
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  /**
   * THE OTHER TWO SURFACES THIS PHASE ADDS, and neither had a phone test.
   *
   * The spec's Definition of done says "every surface this phase adds works on a
   * phone, because v0.10.0 made that the standard for the whole app rather than a
   * phase's ambition". The phase adds four: the quote form, the deal's Documents
   * section, Settings -> Organisation and the quote template editor. The first two
   * are above. These are the other two, and until this test the template editor had
   * never been driven at ANY width by anything.
   *
   * The template half is worth more than its phone assertions. GET then PUT must be
   * byte-identical, or opening the template and saving it destroys the letterhead --
   * which is exactly what happened in Task 4's review round 2 (S2), where
   * `isPermittedUrl` refused the merge token in the logo's `src`, dropped the
   * attribute, and took the whole `<img>` with it: 38 characters shorter, no logo and
   * no warning. That was proved through the module. This proves it through the editor
   * a person actually uses, which is the only place the round trip really happens.
   */
  test("the issuer profile takes touch targets and the quote template survives a save", async ({ page }) => {
    await page.goto("/settings/org");
    const profile = page.getByTestId("org-settings");
    await expect(profile).toBeVisible();
    await expect(profile.getByText("Loading...", { exact: true })).toHaveCount(0);

    // All three settings destinations stay reachable at this width: each takes the
    // touch floor, can be brought fully on screen, and answers a trial tap -- which
    // for this row means scrolled to rather than merely laid out.
    //
    // A DELETED ASSERTION, AND WHY IT IS NOT REPLACED. This passage used to carry
    // `expect(navScroll.scrollWidth).toBeGreaterThanOrEqual(navScroll.clientWidth)`
    // beside a comment claiming "a row that clipped would fail the second and pass the
    // first". Both were false. `scrollWidth` is the width of the scrolling AREA and is
    // never below the client width: measured with every tab in this row hidden, and
    // again with them shrunk to a 1px font, the row still answered 342 against 342. It
    // was a fourth instrument of the kind v1.1.0 found three of.
    //
    // The obvious repair, `scrollWidth >= the last tab's right edge`, was measured too
    // and is vacuous in the same way -- including in the case it was proposed for. A
    // row forced to `overflow-x: clip` around 881px of tabs still reports scrollWidth
    // 881, not its 342px client width, so the comparison holds there exactly as it
    // holds untouched (342 against a 324px right edge) and under a transform that
    // moves a tab off the left (342 against -176). Chromium reports the content's
    // overflow in `scrollWidth` whether or not the box can be scrolled, which is what
    // makes every arithmetic form of this claim true by construction.
    //
    // What actually fails on a clipped row is the reachability check above, because a
    // clip cannot be scrolled: with the same 881px of tabs, `overflow-x: clip` leaves
    // the last tab unreachable (scrollLeft stuck at 0) and `expectTouchTarget` fails
    // it, while `auto` scrolls to 539 and passes. `hidden` also passes, and correctly
    // records the caveat in the helper's comment: it scrolls programmatically though
    // no thumb can pan it, which is why the `overflowX` line below is kept. That one
    // is failable -- it is the only surviving claim about what kind of box this is.
    const nav = page.getByTestId("settings-nav");
    // The fourth tab is 7.6's, added to this list rather than left out of it:
    // it is the same styled Link as the other three and carries the same 44px
    // floor, and a new control that nothing holds to the floor is how the floor
    // stops being true. 7.7 RENAMED IT -- "Export and backup" became "Export,
    // backup and restore" when the page behind it gained a third thing -- and
    // the name is written out here because `exact: true` means this list is a
    // guard on the label as well as on the geometry.
    for (const name of ["Mail accounts", "Templates", "Organisation", "Export, import, backup and restore"]) {
      await expectTouchTarget(nav.getByRole("link", { name, exact: true }));
    }
    const navOverflowX = await nav.evaluate((element) => getComputedStyle(element).overflowX);
    expect(navOverflowX, "the settings tab row is a scroll container").toBe("auto");
    for (const testId of ["org-name", "org-vat", "org-email"]) {
      await expectTouchTarget(page.getByTestId(testId));
    }
    // The logo picker is a styled <label> wrapping an sr-only input, so the input's
    // own box says nothing about what a thumb can hit -- the label is the target.
    await expectTouchTarget(page.getByText("Choose an image", { exact: true }));
    await expectTouchTarget(page.getByTestId("org-save"));
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    await page.goto("/settings/templates");
    await expect(page.getByTestId("document-template-settings")).toBeVisible();
    const editor = page.getByTestId("document-template-body");
    await expect(editor).toBeVisible();
    // THE WAIT IS THE ASSERTION. The textarea renders empty and fills in when the
    // query resolves, so `toBeVisible` is satisfied by a blank box -- reading it a
    // moment too early gave an empty string, and a round-trip of "" against "" would
    // have passed while proving nothing. Waiting on the letterhead token is waiting
    // for the real template AND naming the one thing whose loss is silent.
    await expect(editor).toHaveValue(/\{\{org\.logoDataUri\}\}/);
    const before = await editor.inputValue();
    expect(before.length).toBeGreaterThan(1000);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    // Saved back untouched and read off the server again. Anything the sanitiser
    // does on the way through shows up here as a difference.
    //
    // THIS STEP IS DESTRUCTIVE WHEN IT FAILS, which is worth knowing before it does.
    // The save is a real PUT: if the round trip is NOT a fixed point, the damaged
    // template is what the database now holds. Harmless in CI, where the database is
    // new each run and 0009 re-seeds it -- and the same property is proved
    // non-destructively in routes.test.ts, so a green CI does not depend on this one.
    //
    // WHAT A SECOND LOCAL RUN LOOKS LIKE, because the failure moves and that is
    // confusing: run 1 fails on the comparison below, and run 2 fails EARLIER, on the
    // `toHaveValue` regex waiting for the letterhead token -- the template no longer
    // contains it, so the wait times out and reads like a seeding problem rather than
    // a sanitiser one. Both mean the same thing. Re-seed by replaying the INSERT at
    // the end of packages/api/drizzle/0009_calm_rhodey.sql AND THEN 0011's UPDATE,
    // which amends the recipient line -- 0009 alone restores a v1.0.x template. That
    // is the same repair a `truncateAll()` from the unit suite already needs.
    //
    // The restore below makes the SUCCEEDING path leave nothing behind either.
    await page.getByTestId("document-template-save").click();
    await expect(page.getByTestId("document-template-saved")).toBeVisible();
    await expect(page.getByTestId("document-template-error")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("document-template-settings")).toBeVisible();
    // toHaveValue rather than a bare read, for the same reason as above: it waits for
    // the reloaded query and compares exactly, so a slow response cannot pass this by
    // arriving after the comparison.
    await expect(editor).toHaveValue(before);

    // PUT THE ORIGINAL BACK. On the success path this is a no-op by definition -- the
    // bytes are the ones just read -- so it costs one request and buys the guarantee
    // that a passing run never leaves the shared template in a state it did not find
    // it in. It cannot repair a FAILING run: the assertions above stop the test
    // before this line, which is deliberate, since a test that tidied away the
    // evidence of a real sanitiser regression would be worse than one that does not.
    const restore = await page.request.put("/api/document-templates/quote", {
      data: { bodyHtml: before },
    });
    expect(restore.ok(), "restoring the quote template").toBe(true);
  });
});
