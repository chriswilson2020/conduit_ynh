import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { pdfVisibleText } from "../packages/api/src/test/pdf.js";

/**
 * v1.1.0's journey: how a contact is addressed, from the picker to the printed
 * page -- and the one thing that must NOT follow it there.
 *
 * THE LAST TEST IS THE RELEASE'S ARGUMENT. `documents.recipient_salutation` is a
 * column rather than a join to the contact, and the whole reason is that an issued
 * quote never changes: re-title somebody next year and a quote sent last year has
 * to go on saying what it said. That claim is only worth anything if something
 * tries to break it, so this file issues a quote, re-titles the contact through
 * the real picker, and then asserts the stored row, the stored bytes AND the words
 * on the page are all exactly what they were. The quote raised afterwards, which
 * DOES carry the new title, is the other half: without it the immutability
 * assertion would pass just as happily if the edit had done nothing at all.
 *
 * WHAT THE PDF ASSERTIONS REALLY READ. A word printed by WeasyPrint is not in the
 * file as that word -- the font is subset and the text is glyph ids -- so
 * `pdfVisibleText` (packages/api/src/test/pdf.ts) translates them back through the
 * font's own `/ToUnicode` table. Without it a `not.toContain` here would pass
 * vacuously whatever the page said, which is the failure mode that matters most in
 * the immutability test.
 *
 * AND EVERY `not.toContain` BELOW SITS IMMEDIATELY AFTER A `toContain` ON THE SAME
 * BUFFER, which is not a stylistic habit but the thing actually holding those
 * assertions up. `pdfVisibleText` reads five text-operator shapes it does not
 * handle (they are listed at `textRuns`, and neither renderer here writes one),
 * and a run it failed to read would make an absence pass for the wrong reason. A
 * reader that came back empty, or that dropped the very line the assertion is
 * about, fails the positive claim first and never reaches the negative one. Keep
 * the pairing; an absence asserted on its own here would have nothing under it.
 *
 * THE SCAFFOLDING IS API AND THE JOURNEY IS UI, the rule e2e/documents.spec.ts
 * states: a company, a contact, a pipeline, a stage and a deal are what somebody
 * recording a salutation already has, and driving five creation dialogs would put
 * four other phases' surfaces in this one's failure path. Everything v1.1.0 itself
 * added -- both pickers, the "Other..." box, the salutation on the contacts list,
 * the quote form's fourth recipient box and what reaches the PDF -- is driven in
 * the browser.
 *
 * WHAT IS NOT HERE. The focus question (a Radix Select restoring focus to its
 * trigger, and letter keys becoming typeahead) is e2e/crm.spec.ts's and
 * e2e/mobile.spec.ts's, at both widths, and is not re-driven; this file uses
 * `fill()` on the typed box for that reason and because racing a commit is
 * flaky -- see `retitle` below. Escape-then-type on a field showing a PRESET
 * still commits that preset by typeahead, app-wide Radix behaviour that v1.1.0
 * deliberately did not change, and NOTHING here asserts it: a test over it would
 * enshrine a behaviour the release chose to leave alone. The length bound, the
 * "Other..." path's byte-for-byte storage and the absence of any inference are
 * unit work (contact-fields-lib.test.ts, services/contacts.test.ts).
 */

/**
 * The same 120s budget e2e/documents.spec.ts takes, for the same reason: three of
 * the tests below submit a quote, `renderPdf` bounds one render at 20s and the
 * wait for a render slot at a further 10s, so a single legitimate submit is
 * entitled to the whole of Playwright's 30s default on its own. File-scoped, so
 * no other spec gains a second of slack.
 */
test.describe.configure({ timeout: 120_000 });

/**
 * THE TWO VALUES, ONE FROM THE PICKER AND ONE FROM THE BOX, which is what makes
 * this a test of both paths rather than of the list twice. "Prof" is a preset;
 * "hij/hem" is not, and reaches the column only through "Other...".
 */
const SALUTATION = "Prof";
const PRONOUNS = "hij/hem";
/** The re-title. Not a preset either, so the edit goes through the typed box. */
const RETITLE = "Vrouwe";

/**
 * SHORT ON PURPOSE. The printed assertions are about a LINE -- the salutation
 * standing immediately in front of the name, which is the thing migration 0011
 * changed -- and `pdfVisibleText` joins text-showing operators with a newline so
 * two unrelated lines can never be read as one. A recipient long enough to wrap
 * inside the template's address block would therefore be two lines and the
 * assertion would be about typography rather than about the field. Measured
 * against the seeded template: 26 characters sits on one line comfortably.
 */
const FIRST_NAME = "Wilhelmina";
const LAST_NAME = "Zeldenrust";
const CONTACT_NAME = `${FIRST_NAME} ${LAST_NAME}`;

interface Fixture {
  readonly companyId: string;
  readonly contactId: string;
  readonly dealId: string;
}

/**
 * What GET /api/deals/:id/documents answers with, narrowed to what is read here.
 *
 * The parsed value carries every field the route sends; this type names only the
 * three the assertions below touch. `toEqual` in the immutability test compares
 * the WHOLE parsed row -- the number, both recipient fields, the address, all
 * three money columns, the issuer and every line item -- and not just these.
 */
interface DocumentJson {
  readonly number: string;
  readonly fileId: string;
  readonly recipientSalutation: string;
}

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
}

/** The deal's documents, newest first, straight from the route the page reads. */
async function documentsOf(page: Page, dealId: string): Promise<readonly DocumentJson[]> {
  const response = await page.request.get(`/api/deals/${dealId}/documents`);
  expect(response.status(), `GET /api/deals/${dealId}/documents`).toBe(200);
  return JSON.parse(await response.text()) as DocumentJson[];
}

/** The newest document on a deal, or a failure that says so rather than an undefined. */
async function newestDocument(page: Page, dealId: string): Promise<DocumentJson> {
  const [newest] = await documentsOf(page, dealId);
  if (newest === undefined) throw new Error(`deal ${dealId} has no documents`);
  return newest;
}

/**
 * The bytes the download link really streams, asserted to be a PDF on the way past.
 *
 * e2e/documents.spec.ts has a near-neighbour of this that returns a DIGEST; this
 * one returns the BYTES, because every assertion in this file reads the page's
 * text as well as its identity. Left as two small functions rather than folded
 * into one shared one, so the existing files stay as close to untouched as the
 * work allows.
 *
 * "THE 109 THIS RELEASE MUST NOT MOVE" WAS THE WRONG BASELINE, and this sentence
 * used to say it. `origin/main` has 105; the 109 already included four tests
 * v1.1.0's own Tasks 1 and 2 wrote, so quoting it silently counted this release's
 * work as somebody else's baseline. The release adds THIRTEEN. The property that
 * actually matters is stronger than the count anyway and is worth stating in its
 * place: no test that existed before this release has had an executable line
 * changed by it. e2e/documents.spec.ts's `pageOverflow` is the one exception and
 * it is a CORRECTION -- it measured the document, which a scroll container has
 * never propagated to, so its three callers were asserting `0 <= 1` at every
 * viewport since the day they were written.
 */
async function downloadQuote(page: Page, number: string): Promise<Buffer> {
  const href = await page.getByTestId(`document-download-${number}`).getAttribute("href");
  if (href === null) throw new Error(`the download link for ${number} has no href`);
  const response = await page.request.get(href);
  expect(response.status(), `GET ${href}`).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const bytes = await response.body();
  // The magic, not the extension: a zero-byte "PDF" would satisfy everything else.
  expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  return bytes;
}

/**
 * Type a title into the picker's "Other..." box and commit it by leaving the box.
 *
 * `fill()` AND A BLUR, not the keyboard and not Enter, and the reason is a race
 * rather than a preference: a commit re-renders the row from the stored value the
 * moment the PATCH settles, so a test that types and then asserts against the
 * mutation's own timing is asserting against a control that may already have been
 * rebuilt underneath it. Every check here is an auto-retrying assertion on the
 * value read back AFTER a reload instead, which is the only claim worth making --
 * that the column holds it. The keyboard path is e2e/crm.spec.ts's and
 * e2e/mobile.spec.ts's, where the question is focus and the keyboard IS the test.
 */
async function typeTitle(page: Page, value: string): Promise<void> {
  await page.getByTestId("salutation").click();
  await page.getByRole("option", { name: "Other..." }).click();
  const box = page.getByTestId("salutation-other");
  await box.fill(value);
  await box.blur();
}

test.describe.serial("A contact's salutation, from the picker to the PDF", () => {
  const runId = Date.now().toString(36);
  // `${runId}x${retry}`, the suite's convention: nothing empties the database
  // between attempts, and a serial group re-runs from the top on a retry, so
  // beforeAll is the one place guaranteed to run again with the new index.
  let attemptId = "";
  let companyName = "";

  let page: Page;
  let fixture: Fixture;
  /** The quote raised while the contact is a "Prof", and what it must stay. */
  let issuedNumber = "";
  let issuedRow: DocumentJson | null = null;
  let issuedDigest = "";

  test.beforeAll(async ({ browser }, testInfo) => {
    attemptId = `${runId}x${String(testInfo.retry)}`;
    companyName = `Zeldenco ${attemptId}`;
    page = await browser.newPage();

    const company = await create(page, "/api/companies", {
      name: companyName,
      address: "3 Prinsengracht\n1015 DX Amsterdam",
    });
    const contact = await create(page, "/api/contacts", {
      firstName: FIRST_NAME,
      lastName: LAST_NAME,
      companyId: company.id,
    });
    const pipeline = await create(page, "/api/pipelines", { name: `Salutation ${attemptId}`, scope: "global" });
    const stage = await create(page, `/api/pipelines/${pipeline.id}/stages`, { name: "Lead" });
    const deal = await create(page, "/api/deals", {
      title: `Advisory ${attemptId}`,
      pipelineId: pipeline.id,
      stageId: stage.id,
      companyId: company.id,
      contactId: contact.id,
      valueCents: 50_000,
    });
    fixture = { companyId: company.id, contactId: contact.id, dealId: deal.id };
  });

  test.afterAll(async () => {
    await page.close();
  });

  /**
   * BOTH FIELDS, AND BOTH PATHS TO A VALUE. The salutation is chosen from the
   * preset list; the pronouns are typed into the box "Other..." reveals, which is
   * the path the release exists for -- no list anticipates every pronoun set, so a
   * value that is not on it has to reach the column unchanged.
   *
   * Asserted after a RELOAD, which is what makes it a claim about the column
   * rather than about React state.
   */
  test("records a preset on one field and a typed value on the other", async () => {
    await page.goto(`/contacts/${fixture.contactId}`);

    // Empty by default, both of them, which is the spec's first rule and the
    // cheapest place in the suite to state it.
    // toContainText, not toHaveText: the trigger renders a chevron beside its
    // value, and the chevron is not what this asserts.
    await expect(page.getByTestId("salutation")).toContainText("None");
    await expect(page.getByTestId("pronouns")).toContainText("None");

    await page.getByTestId("salutation").click();
    await page.getByRole("option", { name: SALUTATION, exact: true }).click();

    await page.getByTestId("pronouns").click();
    await page.getByRole("option", { name: "Other..." }).click();
    const pronounBox = page.getByTestId("pronouns-other");
    await pronounBox.fill(PRONOUNS);
    await pronounBox.blur();

    await page.reload();
    await expect(page.getByTestId("salutation")).toContainText(SALUTATION);
    await expect(page.getByTestId("pronouns-other")).toHaveValue(PRONOUNS);
  });

  /**
   * THE LIST SHOWS ONE OF THEM, AND THAT IS A DECISION. A list is for finding
   * someone and a pronoun is for writing to them, so the salutation stands beside
   * the name and the pronouns appear nowhere on the page.
   *
   * The name cell's WHOLE text is asserted rather than a substring: "beside the
   * name" is a claim about one cell, and a `toContainText` over the row would be
   * satisfied by a salutation in a column of its own three cells away.
   */
  test("shows the salutation beside the name in the list, and never the pronouns", async () => {
    await page.goto("/contacts");
    await page.getByPlaceholder("Filter...").fill(LAST_NAME);
    const row = page.getByTestId(`row-${fixture.contactId}`);
    await expect(row).toBeVisible();
    // The cell's ACCESSIBLE NAME, which is the suite's idiom here and also the
    // only reading that excludes the per-cell column heading entity-table.tsx
    // renders for the phone layout and hides at a desk -- `textContent` carries
    // that "Name" along and `toHaveText` would be asserting the wrong string.
    await expect(row.getByRole("cell", { name: `${SALUTATION} ${CONTACT_NAME}`, exact: true }))
      .toBeVisible();
    // Not in another column, not in a title attribute, not anywhere.
    await expect(page.getByTestId("entity-table")).not.toContainText(PRONOUNS);
  });

  /**
   * THE WINDOW IN WHICH A BLANK COULD BE FROZEN ONTO AN IMMUTABLE ARTIFACT.
   *
   * The quote form seeds its recipient block from the deal's company and contact,
   * which are separate queries; a quote submitted before they arrive stored an
   * empty salutation on a row that can never be corrected, only re-raised under a
   * new number. The submit is held while either is in flight, and it SAYS SO --
   * a control disabled for a reason nobody can see is the thing this release twice
   * refused to ship.
   *
   * The contact's response is held open by the test rather than waited for, so the
   * window is a fact of the run and not a lucky moment. It is held on the CONTACT
   * alone, which is also what makes the company's name on the page below a usable
   * signal that the rest of the deal has arrived.
   */
  test("holds the quote's submit while the recipient's details are on the wire", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/contacts/*", async (route) => {
      await held;
      await route.continue();
    });

    await page.goto(`/deals/${fixture.dealId}`);
    await expect(page.getByTestId("field-companyId")).toContainText(companyName);
    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();

    await expect(page.getByTestId("quote-defaults-loading")).toBeVisible();
    await expect(page.getByTestId("quote-submit")).toBeDisabled();
    // The state that must never be issued: the box the contact fills is empty.
    await expect(page.getByTestId("quote-recipient-salutation")).toHaveValue("");

    release();
    // And the default arrives into a form that was already open, which is the
    // re-seed doing its half of the job.
    await expect(page.getByTestId("quote-recipient-salutation")).toHaveValue(SALUTATION);
    await expect(page.getByTestId("quote-submit")).toBeEnabled();
    await expect(page.getByTestId("quote-defaults-loading")).toHaveCount(0);

    await page.unroute("**/api/contacts/*");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("quote-form")).toBeHidden();
  });

  /**
   * THE QUOTE CARRIES IT, AND SO DOES THE PDF. The row is the record; the PDF is
   * what the customer reads, and only one of the two is sent to them.
   */
  test("defaults the quote's salutation from the contact and prints it", async () => {
    await page.goto(`/deals/${fixture.dealId}`);
    // The deal's Contact row carrying the name is the linked-contact query having
    // resolved, which is where the form's salutation default comes from. Opening
    // the dialog before it would be asserting against a race.
    await expect(page.getByTestId("field-contactId")).toContainText(CONTACT_NAME);

    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();
    await expect(page.getByTestId("quote-recipient-salutation")).toHaveValue(SALUTATION);
    await expect(page.getByTestId("quote-recipient-contact")).toHaveValue(CONTACT_NAME);

    await page.getByTestId("quote-line-description-0").fill("Advice, one afternoon");
    await page.getByTestId("quote-line-qty-0").fill("1");
    await page.getByTestId("quote-line-price-0").fill("500.00");
    await page.getByTestId("quote-line-tax-0").fill("21");
    await page.getByTestId("quote-submit").click();
    // The dialog closing is a real WeasyPrint subprocess having finished inside
    // the issuing transaction, not a stub.
    await expect(page.getByTestId("quote-form")).toBeHidden({ timeout: 60_000 });

    issuedRow = await newestDocument(page, fixture.dealId);
    issuedNumber = issuedRow.number;
    expect(issuedRow.recipientSalutation).toBe(SALUTATION);
    await expect(page.getByTestId(`document-${issuedNumber}`)).toBeVisible();

    const pdf = await downloadQuote(page, issuedNumber);
    issuedDigest = createHash("sha256").update(pdf).digest("hex");
    // The salutation immediately in front of the name, on one line, which is what
    // migration 0011 rewrote the seeded template's recipient block to produce.
    expect(pdfVisibleText(pdf)).toContain(`${SALUTATION} ${CONTACT_NAME}`);
  });

  /**
   * THE TEST THE COLUMN EXISTS FOR. Same shape as the company rename in
   * e2e/documents.spec.ts, one field further in: the contact is re-titled through
   * the picker a person would really use, and the quote already issued does not
   * move -- not the row, not the stored bytes, and not the words on the page.
   *
   * The bytes are compared as STORED and never re-rendered: three renders of
   * identical input measured 6899, 6899 and 6898 bytes during Phase 7, so a
   * render-and-diff would fail for reasons that have nothing to do with
   * immutability.
   */
  test("re-titling the contact does not reach a quote already issued", async () => {
    await page.goto(`/contacts/${fixture.contactId}`);
    await typeTitle(page, RETITLE);
    await page.reload();
    await expect(page.getByTestId("salutation-other")).toHaveValue(RETITLE);

    await page.goto(`/deals/${fixture.dealId}`);
    await expect(page.getByTestId("field-contactId")).toContainText(CONTACT_NAME);

    // The whole stored row, field for field and line for line.
    const after = await documentsOf(page, fixture.dealId);
    expect(after.find((row) => row.number === issuedNumber)).toEqual(issuedRow);

    const pdf = await downloadQuote(page, issuedNumber);
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(issuedDigest);
    const printed = pdfVisibleText(pdf);
    expect(printed).toContain(`${SALUTATION} ${CONTACT_NAME}`);
    // The half that needs the glyph table to mean anything at all: the new title
    // is not on the page. Against the raw bytes this would pass whatever the page
    // said, because the words are not in the file as words.
    expect(printed).not.toContain(RETITLE);
  });

  /**
   * THE OTHER DIRECTION, and without it the test above would be satisfied by an
   * edit that never happened: the NEXT quote is addressed the new way. A snapshot
   * that froze everything for ever would pass one of these two and not both.
   */
  test("a quote raised afterwards carries the new title", async () => {
    await page.getByTestId("new-quote-button").click();
    await expect(page.getByTestId("quote-form")).toBeVisible();
    await expect(page.getByTestId("quote-recipient-salutation")).toHaveValue(RETITLE);

    await page.getByTestId("quote-line-description-0").fill("Advice, a second afternoon");
    await page.getByTestId("quote-line-qty-0").fill("1");
    await page.getByTestId("quote-line-price-0").fill("500.00");
    await page.getByTestId("quote-line-tax-0").fill("21");
    await page.getByTestId("quote-submit").click();
    await expect(page.getByTestId("quote-form")).toBeHidden({ timeout: 60_000 });

    const second = await newestDocument(page, fixture.dealId);
    expect(second.number).not.toBe(issuedNumber);
    expect(second.recipientSalutation).toBe(RETITLE);
    expect(pdfVisibleText(await downloadQuote(page, second.number)))
      .toContain(`${RETITLE} ${CONTACT_NAME}`);
  });
});
