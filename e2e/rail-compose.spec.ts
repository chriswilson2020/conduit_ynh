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
 * NOTHING COMPOSED FROM A DEAL OR A PROJECT TAB BEFORE THIS FILE, and the
 * project tab was not opened at all -- which is one word weaker than the plan,
 * whose "no test covers the deal or project tabs AT ALL" is wrong about the
 * deal. e2e/mail.spec.ts's "carries the deal-linked thread to the second user"
 * journey does open a deal's Mail tab; it reads the THREAD LIST there and never
 * presses Compose. The only rail compose in the suite was
 * e2e/composer-focus.spec.ts's, from a CONTACT, whose chain is one deep and
 * whose only hop the detail page's own heading already proves warm (see
 * openRailCompose's comment there, which is where the one-deep case was closed
 * in v1.2.0). The two-deep case was recorded then and left.
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
 *   resolving  something is on the wire   -> Compose waits, and says so
 *   failed     errored, or offline        -> Compose works, with an alert and a Retry
 *   ready      nothing to seed, or cached -> Compose works, silently
 *
 * A deal with no linked contact, a project tab and a company tab are all the
 * third row: `to: []` is the right answer and always was. See v1.1.0's ruling
 * against "disabled until the data arrives", which is indistinguishable from
 * "disabled" when a query fails -- the second row is that ruling's case, and
 * the alert and the Retry are what it asked for.
 *
 * QUERIES.TS'S `enabled: id !== ""` IS BOUND HERE AND NOWHERE ELSE. The gate
 * deliberately does not restate that predicate -- mail-lib.ts's ComposeHop says
 * why, and the flag that used to carry it was measured inert and deleted -- so
 * no unit test can notice if queries.ts changes it. These journeys are the whole
 * net, and they hold in BOTH directions. Measured: enabling `useContact` on an
 * empty id turns `["contact", ""]` into a 404 and takes down two of them,
 * including the contactless deal's; disabling it outright takes down seven.
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
 * A held request, and whether it is STILL held.
 *
 * `holding()` is the fixture checking itself, and it exists because two of the
 * journeys below -- including the one that is the whole defect -- assert only
 * that the recipient arrived. On a slow runner a hold that expired before the
 * click would leave those passing without ever exercising the race, silently.
 * Asserted rather than trusted, so the failure says "the hold expired" instead
 * of saying nothing at all.
 */
interface Hold {
  /** A matching request has arrived and has not been let go. */
  holding: () => boolean;
  unroute: () => Promise<void>;
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
function delayFirst(page: Page, pattern: string, ms: number): Promise<Hold> {
  let arrived = false;
  let released = false;
  const routed = page.route(pattern, async (route: Route) => {
    if (arrived) {
      await route.continue().catch(() => {});
      return;
    }
    arrived = true;
    await new Promise((resolve) => setTimeout(resolve, ms));
    released = true;
    await route.continue().catch(() => {});
  });
  return routed.then(() => ({
    holding: () => arrived && !released,
    unroute: async () => { await page.unroute(pattern).catch(() => {}); },
  }));
}

/**
 * Answer every request matching `pattern` with a 500, the query client's one
 * retry included, until `stop()` is called -- after which they are continued
 * to the real server, so a journey can fail a hop and then repair it.
 */
async function failUntilStopped(page: Page, pattern: string): Promise<{ stop: () => void; unroute: () => Promise<void> }> {
  let failing = true;
  await page.route(pattern, async (route: Route) => {
    if (!failing) {
      await route.continue().catch(() => {});
      return;
    }
    await route
      .fulfill({ status: 500, contentType: "application/json", body: '{"error":"probe"}' })
      .catch(() => {});
  });
  return {
    stop: () => { failing = false; },
    unroute: async () => { await page.unroute(pattern).catch(() => {}); },
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

/**
 * Longer, and only where a hold has to OUTLIVE a failing hop's retries.
 *
 * THE ARITHMETIC, because this number is the whole discriminating window. The
 * query client is `retry: 1` and TanStack's first retry delay is
 * `min(1000 * 2 ** 0, 30000)` = 1s, so a hop answered 500 twice reaches its
 * error state about a second in. Three seconds leaves two seconds during which
 * one hop has failed and another is still on the wire -- the only moment at
 * which the gate's ORDER is observable -- and still lands the alert inside
 * Playwright's default five-second expect budget with two seconds to spare.
 * HELD_MS would have been gone before the failure arrived and the two states
 * would never have overlapped at all.
 */
const OUTLAST_RETRIES_MS = 3_000;

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

/**
 * Archive it again, ASSERTED. A silently failed archive leaves a live template
 * that puts a Template select into every composer in every spec that runs after
 * this file -- the hazard this file's own header names.
 */
async function archiveTemplate(page: Page, id: string): Promise<void> {
  const response = await page.request.post(`/api/mail/templates/${id}/archive`);
  expect(response.status(), await response.text()).toBe(200);
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
   * the second hop still on the wire. The only assertion about the APP is about
   * the RECIPIENT, so this test says nothing about how the fix works and fails
   * on the symptom the user would report.
   *
   * Before the fix, measured: the click landed immediately and the composer
   * opened with an empty To. After it, the click waits for a button that is
   * disabled while the chain settles, and lands on the seeded compose.
   */
  test("with the contact still on the wire, a click cannot compose to nobody", async ({ page }) => {
    const fixture = await seed(page, runTag("dw"));
    const hold = await delayFirst(page, CONTACT_GET, HELD_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      expect(hold.holding(), "the contact hop was already back: this click never raced anything").toBe(true);
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("composer")).toContainText(fixture.address);
      await expect(page.getByRole("button", { name: `Remove ${fixture.address}` })).toBeVisible();
    } finally {
      await hold.unroute();
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
    const hold = await delayFirst(page, CONTACT_GET, HELD_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose")).toBeDisabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeVisible();
      await expect(page.getByTestId("mail-compose")).toBeEnabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeHidden();
    } finally {
      await hold.unroute();
    }
  });

  /**
   * THE STATE THE PLAN GLOSSES. `to: []` is not always wrong: a deal with no
   * linked contact has no address to seed, and composing to a manually typed
   * one is ordinary. A gate on ARRIVAL would disable this deal's Compose for
   * ever, because the contact it is waiting for is never going to arrive; the
   * gate asks instead whether anything is ON THE WIRE, and for a hop nobody
   * asked for the answer is no. Same distinction pages/deal-detail.tsx's
   * `defaultsInFlight` comment draws for the quote form's defaults.
   *
   * "ON THE FIRST LOOK" IS A ONE-SHOT READ, and it has to be. Every other
   * assertion in this file auto-retries for five seconds (playwright.config.ts
   * declares no `expect` block, so the default stands), which would let a
   * regression that disabled Compose for four seconds pass a test whose name
   * said "immediately". `isDisabled()` is a single query with no retry, and
   * the wait that precedes it is on the page's OWN rendering of both hops --
   * the company field filled, the contact field showing the em dash -- so the
   * read happens at a moment when nothing is legitimately outstanding.
   */
  test("a deal with no contact has Compose live on the first look", async ({ page }) => {
    const fixture = await seed(page, runTag("de"));
    await page.goto(`/deals/${fixture.contactlessDealId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(fixture.contactlessDealTitle);
    await expect(page.getByTestId("field-companyId")).toContainText(fixture.companyName);
    await expect(page.getByTestId("field-contactId")).toContainText("\u2014");
    await page.getByTestId("mail-tab").click();
    await expect(page.getByTestId("mail-compose")).toBeVisible();

    expect(
      await page.getByTestId("mail-compose").isDisabled(),
      "Compose was disabled with nothing outstanding to wait for",
    ).toBe(false);
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
    const failure = await failUntilStopped(page, CONTACT_GET);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose-error")).toBeVisible();
      await expect(page.getByTestId("mail-compose-retry")).toBeVisible();
      await expect(page.getByTestId("mail-compose")).toBeEnabled();
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("composer")).not.toContainText(fixture.address);
    } finally {
      await failure.unroute();
    }
  });

  /**
   * AND THE WAY BACK, which is what separates this alert from the two the rail
   * already had. Typing an address by hand recovers the recipient; it does not
   * recover `context.companyName` or `contactName`, which feed the template
   * placeholders and cannot be typed anywhere -- so without a Retry the only
   * repair is a page reload. rail/timeline.tsx and rail/meetings.tsx both pair
   * this alert with this control and both say why.
   */
  test("Retry asks again, and the alert goes when the hop answers", async ({ page }) => {
    const fixture = await seed(page, runTag("dr"));
    const failure = await failUntilStopped(page, CONTACT_GET);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      await expect(page.getByTestId("mail-compose-error")).toBeVisible();
      failure.stop();
      await page.getByTestId("mail-compose-retry").click();
      await expect(page.getByTestId("mail-compose-error")).toBeHidden();
      // The proof it refetched rather than merely hiding the alert: the seed
      // now carries the recipient the failed hop was holding up.
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toContainText(fixture.address);
    } finally {
      await failure.unroute();
    }
  });

  /**
   * ONE HOP FAILED, ANOTHER STILL ON THE WIRE, and the button's state is the
   * first of those rather than the second. A deal reaches its company through
   * `deal.companyId`, independently of the contact hop, so failing the contact
   * and holding the company puts both states in play at once.
   *
   * THE DISCRIMINATOR IS `hold.holding()`, NOT THE SEQUENCE OF STATES, and the
   * first version of this test taught that the hard way. It asserted disabled,
   * then pending, then the alert hidden, then the alert visible, then enabled
   * -- and a composeGate with the two branches SWAPPED passes every one of
   * those, because it walks through the same states EARLIER: it paints the
   * alert as soon as the contact's retry is spent, about a second in, against
   * the OUTLAST_RETRIES_MS the hold runs for. Every assertion in this file
   * auto-retries for five seconds, which is longer than either, so "earlier"
   * is invisible to a sequence. What separates the two orders is
   * WHETHER ANYTHING WAS STILL ON THE WIRE when the alert appeared: with the
   * shipped order the company hop has landed by then, with the branches swapped
   * it has not. Measured both ways.
   */
  test("a hop still on the wire keeps Compose shut, and the alert waits its turn", async ({ page }) => {
    const fixture = await seed(page, runTag("dm"));
    const failure = await failUntilStopped(page, CONTACT_GET);
    const hold = await delayFirst(page, COMPANY_GET, OUTLAST_RETRIES_MS);
    try {
      await openMailTab(page, `/deals/${fixture.dealId}`, fixture.dealTitle);
      expect(hold.holding(), "the company hop was already back before the race began").toBe(true);
      await expect(page.getByTestId("mail-compose")).toBeDisabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeVisible();
      await expect(page.getByTestId("mail-compose-error")).toBeHidden();

      // ...and once the company lands, the contact's failure is what is left.
      await expect(page.getByTestId("mail-compose-error")).toBeVisible();
      expect(
        hold.holding(),
        "the alert was painted while a hop was still on the wire: the gate reported a failure it should have deferred",
      ).toBe(false);
      await expect(page.getByTestId("mail-compose")).toBeEnabled();
      await expect(page.getByTestId("mail-compose-pending")).toBeHidden();
    } finally {
      await hold.unroute();
      await failure.unroute();
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
    try {
      const hold = await delayFirst(page, COMPANY_GET, HELD_MS);
      try {
        await openMailTab(page, `/projects/${fixture.projectId}`, fixture.projectName);
        expect(hold.holding(), "the company hop was already back: this click never raced anything").toBe(true);
        await page.getByTestId("mail-compose").click();
        await expect(page.getByTestId("composer")).toBeVisible();
        await page.getByTestId("composer-template").click();
        await page.getByRole("option", { name: new RegExp(template.name) }).click();
        await expect(page.getByTestId("composer-body"))
          .toContainText(`${MERGE_OPEN}${fixture.companyName}${MERGE_CLOSE}`);
      } finally {
        await hold.unroute();
      }
    } finally {
      await archiveTemplate(page, template.id);
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
 * TOO, because a flex child shrinks to min-content before its container
 * overflows -- and `toBeInViewport` defaults to ANY intersection, so even a
 * mostly-clipped element satisfies it. An assertion nothing could make fail is
 * not an assertion, so it was removed rather than kept for the look of it --
 * see v1.2.1's Task 5, whose whole subject this is.
 */
test.describe("Under a thumb", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the same click waits, and lands on a sheet that carries the recipient", async ({ page }) => {
    const fixture = await seed(page, runTag("tp"));
    const hold = await delayFirst(page, CONTACT_GET, HELD_MS);
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
      await hold.unroute();
    }
  });
});
