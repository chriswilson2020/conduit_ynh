import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * WHAT A RECORD'S MAIL TAB COMPOSES TO, WHEN THE QUERIES IT READS ARE STILL
 * ON THE WIRE.
 *
 * components/rail/mail.tsx builds the composer's seed AT CLICK TIME out of up
 * to four queries, and from a DEAL tab two of them are chained: the deal, then
 * `useContact(deal.contactId)`. A click that lands between the two seeds
 * `to: []` -- a compose addressed to nobody, with nothing on screen to say so.
 * Measured in Chromium against the real app before the fix: with the contact
 * GET held open, the composer opened with an empty To and the caret in it,
 * which is indistinguishable from a deliberate blank compose.
 *
 * NOTHING COVERED THE DEAL OR PROJECT TABS AT ALL until this file.
 * e2e/composer-focus.spec.ts drives the rail from a CONTACT, whose chain is one
 * deep and whose only hop the detail page's own heading already proves warm
 * (see openRailCompose's comment there, which is where the one-deep case was
 * closed in v1.2.0). The two-deep case was recorded then and left.
 *
 * THE PROJECT TAB IS NOT THE SAME DEFECT, AND MEASURING IT CORRECTED THE PLAN.
 * v1.2.1's plan and spec both say a project tab resolves the contact "deal ->
 * contact". It does not: the rail only reads `deal?.contactId` from its OWN
 * `dealId` prop, which a project tab does not pass, so `useContact` is disabled
 * and a project tab NEVER seeds a recipient -- measured, with every query
 * settled and two seconds to spare, and confirmed on the wire (a project page
 * requests no `/api/contacts/<id>` at all). What a project tab does have two
 * deep is project -> company, which fills `context.companyName` for the mail
 * merge; held open, `{{company.name}}` reaches the body unsubstituted. That is
 * the same race and it is visible rather than silent, which is why the deal's
 * empty To is the defect and this is the one beside it.
 *
 * THE THREE STATES ARE ALL TESTED, because two of them are legitimate and a
 * fix that gates on "the data has arrived" would break them:
 *
 *   pending   the queries are still on the wire  -> Compose waits, and says so
 *   failed    a query answered with an error     -> Compose works, with an alert
 *   empty     nothing to seed, and that is fine  -> Compose works, silently
 *
 * A deal with no linked contact, and a project or company tab, are all the
 * third row: `to: []` is the right answer and always was. See v1.1.0's ruling
 * against "disabled until the data arrives", which is indistinguishable from
 * "disabled" when a query fails -- the second row is that ruling's case, and
 * the alert is what it asked for.
 *
 * EVERY TEST SEEDS ITS OWN FIXTURE ON ITS OWN PAGE, rather than sharing one
 * across a `describe.serial` the way composer-focus.spec.ts does. The reason is
 * this file's own method: a serial group SKIPS the rest of its tests after the
 * first failure, and every claim here has to be shown failing on its own -- once
 * against the unfixed app, and once per mutation. A group that reports one
 * failure and five skips cannot do that. The config is `fullyParallel`, so a
 * shared page would have needed the serial mode to be safe at all.
 *
 * NO MAIL SERVER AND NO MAIL ACCOUNT, so this file runs in the local hybrid
 * loop the same way composer-focus.spec.ts does. It creates one email TEMPLATE
 * per template-using test (the only way `context.companyName` is observable
 * from outside the seed) and archives it again, because a live template puts a
 * Template select into every other spec's composer.
 */

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
}

/**
 * DELAY THE FIRST REQUEST MATCHING `pattern`, AND ONLY THE FIRST.
 *
 * The shape is dictated by a failure this suite has already paid for: a
 * handler that parks every matching request and continues it later throws
 * "Route is already handled!" ASYNCHRONOUSLY if one is still parked when the
 * test ends, and Playwright reports that on whichever test is running by then
 * -- it took down two unrelated second-user journeys in v1.2.1's Task 1 and was
 * triaged as a flake both times. So: exactly one request is held, every later
 * one is continued immediately, both continues swallow their errors, and every
 * caller unroutes in a finally. Each journey below also waits on an effect of
 * the release before it ends, so the held request is never still open at
 * teardown.
 */
async function delayFirst(page: Page, pattern: string, ms: number): Promise<() => Promise<void>> {
  let held = false;
  await page.route(pattern, async (route: Route) => {
    if (held) {
      await route.continue().catch(() => {});
      return;
    }
    held = true;
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  });
  return async () => {
    await page.unroute(pattern).catch(() => {});
  };
}

/** Answer every request matching `pattern` with a 500, the query client's one retry included. */
async function failAll(page: Page, pattern: string): Promise<() => Promise<void>> {
  await page.route(pattern, async (route: Route) => {
    await route
      .fulfill({ status: 500, contentType: "application/json", body: '{"error":"probe"}' })
      .catch(() => {});
  });
  return async () => {
    await page.unroute(pattern).catch(() => {});
  };
}

/**
 * The single-record GET, not the list. `/api/contacts?limit=10` is the nav's
 * own query and runs on every page in this app; a pattern matching it too would
 * hold a request this file is not about. Playwright's `*` stops at a `/`, and
 * the list URL has none after "contacts", so it does not match.
 */
const CONTACT_GET = "**/api/contacts/*";
const COMPANY_GET = "**/api/companies/*";

/** How long a held hop is held. Long enough that a click cannot beat it. */
const HELD_MS = 1_500;

interface Fixture {
  readonly companyId: string;
  readonly companyName: string;
  readonly contactId: string;
  readonly address: string;
  readonly dealId: string;
  readonly dealTitle: string;
  /** A second deal on the same pipeline with a company but NO contact. */
  readonly contactlessDealId: string;
  readonly contactlessDealTitle: string;
  readonly projectId: string;
  readonly projectName: string;
}

/** A company, a contact with an address, two deals and a project, all linked. */
async function seed(page: Page, tag: string): Promise<Fixture> {
  const companyName = `Railco ${tag}`;
  const address = `rail-${tag}@example.com`;
  const company = await create(page, "/api/companies", { name: companyName });
  const contact = await create(page, "/api/contacts", {
    firstName: "Pieter", lastName: `Ontvanger${tag}`, companyId: company.id, emails: [address],
  });
  const pipeline = await create(page, "/api/pipelines", { name: `Rail pipeline ${tag}`, scope: "global" });
  const stage = await create(page, `/api/pipelines/${pipeline.id}/stages`, { name: "Lead" });
  const dealTitle = `Rail deal ${tag}`;
  const deal = await create(page, "/api/deals", {
    title: dealTitle, pipelineId: pipeline.id, stageId: stage.id,
    companyId: company.id, contactId: contact.id,
  });
  const contactlessDealTitle = `Rail contactless deal ${tag}`;
  const contactlessDeal = await create(page, "/api/deals", {
    title: contactlessDealTitle, pipelineId: pipeline.id, stageId: stage.id,
    companyId: company.id,
  });
  const projectName = `Rail project ${tag}`;
  const project = await create(page, "/api/projects", {
    name: projectName, companyId: company.id, dealId: deal.id,
  });
  return {
    companyId: company.id, companyName, contactId: contact.id, address,
    dealId: deal.id, dealTitle,
    contactlessDealId: contactlessDeal.id, contactlessDealTitle,
    projectId: project.id, projectName,
  };
}

/** A tag no other test in this run shares, so a stale row cannot satisfy an assertion. */
function runTag(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Open a record's Mail tab, having waited for the page's own heading. */
async function openMailTab(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  await page.getByTestId("mail-tab").click();
  await expect(page.getByTestId("mail-compose")).toBeVisible();
}

const MERGE_OPEN = "MERGEOPEN";
const MERGE_CLOSE = "MERGECLOSE";

/**
 * A template whose body is the company-name placeholder between two markers,
 * so what reached the merge can be read off the composed body: the markers with
 * the company between them, the markers with nothing between them, or the
 * markers with the placeholder itself still between them.
 */
async function makeTemplate(page: Page, tag: string): Promise<{ id: string; name: string }> {
  const name = `Rail template ${tag}`;
  const template = await create(page, "/api/mail/templates", {
    name, subject: "", bodyHtml: `<p>${MERGE_OPEN}{{company.name}}${MERGE_CLOSE}</p>`,
  });
  return { id: template.id, name };
}

test.describe("A deal's Mail tab composes to the deal's contact, or waits", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /**
   * THE INSTRUMENT FIRST. Every assertion below about a MISSING recipient is
   * worth nothing unless this fixture can produce one, and the deal tab had no
   * test at all before this file -- so the settled case is measured before the
   * unsettled one, from the same seed function.
   */
  test("settled, it seeds the contact linked to the deal", async ({ page }) => {
    const fixture = await seed(page, runTag("ds"));
    await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
    await page.getByTestId("mail-compose").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("composer")).toContainText(fixture.address);
    await expect(page.getByRole("button", { name: `Remove ${fixture.address}` })).toBeVisible();
  });

  /**
   * THE DEFECT ITSELF, and the actions are a user's rather than the fix's: the
   * Mail tab is opened and Compose is pressed as soon as it is on screen, with
   * the second hop still on the wire. The only assertion is about the
   * RECIPIENT, so this test says nothing about how the fix works and fails on
   * the symptom the user would report.
   *
   * Before the fix, measured: the click landed immediately and the composer
   * opened with an empty To. After it, the click waits for a button that is
   * disabled while the chain settles, and lands on the seeded compose.
   */
  test("with the contact still on the wire, a click cannot compose to nobody", async ({ page }) => {
    const fixture = await seed(page, runTag("dw"));
    const unroute = await delayFirst(page, CONTACT_GET, HELD_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("composer")).toContainText(fixture.address);
      await expect(page.getByRole("button", { name: `Remove ${fixture.address}` })).toBeVisible();
    } finally {
      await unroute();
    }
  });

  /**
   * THE SAME WINDOW, SEEN FROM THE CONTROL. The test above would also pass
   * against a fix that opened the composer empty and filled the To field in
   * late, so this one pins which of the two shipped: the button is disabled
   * while the chain settles and carries a visible reason, and it comes back on
   * its own when the hop lands.
   *
   * "Disabled until the data arrives" is what v1.1.0 refused, and the refusal
   * was about the silence rather than the disabling -- so the reason on screen
   * is asserted here beside the disabled state, not separately from it.
   */
  test("while it waits, Compose is disabled and says why", async ({ page }) => {
    const fixture = await seed(page, runTag("dp"));
    const unroute = await delayFirst(page, CONTACT_GET, HELD_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose")).toBeDisabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeVisible();
      await expect(page.getByTestId("mail-compose")).toBeEnabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeHidden();
    } finally {
      await unroute();
    }
  });

  /**
   * THE STATE THE PLAN GLOSSES. `to: []` is not always wrong: a deal with no
   * linked contact has no address to seed, and composing to a manually typed
   * one is ordinary. A gate on ARRIVAL rather than on "still on the wire"
   * would disable this deal's Compose for ever, because a DISABLED query sits
   * at `status: "pending"` permanently in TanStack v5 -- the same distinction
   * pages/deal-detail.tsx's `defaultsInFlight` comment draws for the quote
   * form's defaults.
   */
  test("a deal with no contact composes with an empty To, immediately", async ({ page }) => {
    const fixture = await seed(page, runTag("de"));
    await openMailTab(page, `/deals/${fixture.contactlessDealId}`, fixture.contactlessDealTitle);
    await expect(page.getByTestId("mail-compose")).toBeEnabled();
    await expect(page.getByTestId("mail-compose-pending")).toBeHidden();
    await expect(page.getByTestId("mail-compose-error")).toBeHidden();
    await page.getByTestId("mail-compose").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("composer")).not.toContainText(fixture.address);
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  });

  /**
   * V1.1.0'S RULING, AS A TEST. A gate that cannot tell "not yet" from "never"
   * presents a dead button with no explanation when a hop 500s. Compose stays
   * live -- an operator can still type an address -- and an alert says the
   * details are missing, rather than leaving the empty To to be read as the
   * record's own answer.
   */
  test("when the contact hop fails, Compose still works and the failure is on screen", async ({ page }) => {
    const fixture = await seed(page, runTag("df"));
    const unroute = await failAll(page, CONTACT_GET);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose-error")).toBeVisible();
      await expect(page.getByTestId("mail-compose")).toBeEnabled();
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("composer")).not.toContainText(fixture.address);
    } finally {
      await unroute();
    }
  });
});

test.describe("A project's Mail tab, whose second hop is the company", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /**
   * MEASURED, AND IT IS NOT WHAT THE PLAN SAYS. A project tab seeds no
   * recipient at all, settled or not, because the rail reads `deal?.contactId`
   * from its own `dealId` prop and a project tab passes none -- there is no
   * project -> deal -> contact hop to race. Asserted here so that adding one
   * later is a red test rather than a surprise.
   */
  test("seeds no recipient, because it has no contact to reach", async ({ page }) => {
    const fixture = await seed(page, runTag("pn"));
    await openMailTab(page, `/projects/${fixture.projectId}`, fixture.projectName);
    await expect(page.getByTestId("mail-compose")).toBeEnabled();
    await page.getByTestId("mail-compose").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  });

  /**
   * THE PROJECT'S ACTUAL TWO-DEEP CHAIN, which is project -> company and fills
   * `context.companyName`. A merge template is the only way that field is
   * observable from outside the seed, so the body is the instrument: the
   * company's name between the two markers means the context arrived, and the
   * placeholder still sitting between them means it did not.
   */
  test("with the company still on the wire, the merge field still resolves", async ({ page }) => {
    const tag = runTag("pc");
    const fixture = await seed(page, tag);
    const template = await makeTemplate(page, tag);
    const unroute = await delayFirst(page, COMPANY_GET, HELD_MS);
    try {
      await openMailTab(page, `/projects/${fixture.projectId}`, fixture.projectName);
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await page.getByTestId("composer-template").click();
      await page.getByRole("option", { name: new RegExp(template.name) }).click();
      await expect(page.getByTestId("composer-body"))
        .toContainText(`${MERGE_OPEN}${fixture.companyName}${MERGE_CLOSE}`);
    } finally {
      await unroute();
      await page.request.post(`/api/mail/templates/${template.id}/archive`);
    }
  });
});

/**
 * UNDER A THUMB. The race is width-blind -- it is a query chain, not a layout
 * -- so what 390px adds is the SURFACE the click lands on: at this width the
 * composer is ui/dialog.tsx's full-screen sheet rather than the desk's dialog,
 * and the seeded recipient has to survive the wait on it too.
 *
 * NO OVERFLOW ASSERTION HERE, AND THE REASON IS A MEASUREMENT RATHER THAN AN
 * OVERSIGHT. The fix puts a new sibling into the rail's Compose row, which is
 * the sort of thing that runs a phone row out of box -- so it was measured, at
 * 390 with the pending line up: the rail's content box is 342px and the row
 * needs 175 (the line) + 8 (the gap) + 89 (the button) = 272, leaving 70px of
 * slack. Two mutations were then run against a `toBeInViewport` pair on those
 * two elements: dropping the row's `flex-wrap` left it passing (272 still fits),
 * and dropping `flex-wrap` AND widening the line past the slack left it passing
 * TOO, because a flex child shrinks before its container overflows. An
 * assertion nothing could make fail is not an assertion, so it was removed
 * rather than kept for the look of it -- see v1.2.1's Task 5, whose whole
 * subject this is. The 70px is fixture-free (the string is a constant), but it
 * is a margin and not a guard: a line half again as long would need the wrap.
 */
test.describe("Under a thumb", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the same click waits, and lands on a sheet that carries the recipient", async ({ page }) => {
    const fixture = await seed(page, runTag("tp"));
    const unroute = await delayFirst(page, CONTACT_GET, HELD_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose")).toBeDisabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeVisible();
      await page.getByTestId("mail-compose").click();
      // The sheet's own way out, which exists only below the breakpoint: proof
      // this is the phone surface and not the desk dialog at a narrow viewport.
      await expect(page.getByTestId("dialog-close")).toBeVisible();
      await expect(page.getByTestId("composer")).toContainText(fixture.address);
    } finally {
      await unroute();
    }
  });
});
