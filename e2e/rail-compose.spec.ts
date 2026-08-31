import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { delayFirst } from "./helpers.js";

/**
 * WHAT A RECORD'S MAIL TAB COMPOSES TO, WHEN THE QUERIES IT READS ARE STILL
 * ON THE WIRE.
 *
 * components/rail/mail.tsx builds the composer's seed AT CLICK TIME out of up
 * to two queries, and from a DEAL tab they are chained: the deal, then
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
 * requests no `/api/contacts/<id>` at all). What a project tab HAD two deep was
 * project -> company, filling `context.companyName` for the mail merge; held
 * open, `{{company.name}}` reached the body unsubstituted. v1.2.2 deleted the
 * merge and then the two hops that only fed it, so a project tab now has no
 * enabled query in its gate at all -- which its journey below holds the project
 * GET open to say.
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
 * net, and they hold in BOTH directions. RE-MEASURED against this file as it
 * now stands, because the journey set changed in v1.2.2 and so did both numbers:
 * enabling `useContact` on an empty id takes down FOUR of the nine, and
 * disabling it outright takes down SEVEN -- the two that survive that being the
 * contactless deal's and the project tab's, which are exactly the two whose
 * whole claim is that nothing is fetched for them.
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
 * loop the same way composer-focus.spec.ts does.
 *
 * WHAT v1.2.2 TOOK OUT OF HERE, IN TWO STEPS, so the gap is on record rather
 * than discovered. Removing the mail templates removed the merge, and
 * `context.companyName` with it: that value was the ONLY way a company hop was
 * observable from outside the seed, so the journey that read it back out of a
 * composed body went at the same time. The project and company hops then had
 * nothing left to feed, and narrowing the gate to `to`'s own chain dropped them
 * too. Each dropped hop is now held open by a journey that asserts Compose does
 * not wait for it: the company's is new, and the project tab's existing one was
 * rewritten to hold `PROJECT_GET` rather than merely to find Compose enabled.
 * Both were red before the narrowing.
 *
 * AND ONE JOURNEY WAS RETIRED BECAUSE THE STATE IT BUILT NO LONGER EXISTS, not
 * because it was redundant. "A hop still on the wire keeps Compose shut, and the
 * alert waits its turn" failed the contact and HELD THE COMPANY, putting two
 * independent hops in the two states composeGate resolves by order. With the
 * chain narrowed to deal -> contact there is no second hop to put anywhere: the
 * contact's key comes from the deal, so a failed or unanswered deal never starts
 * a contact fetch at all, and no two hops can be stalled and in flight together.
 *
 * A REPLACEMENT ON THE SINGLE HOP WAS WRITTEN, MEASURED, AND THROWN AWAY, which
 * is the part worth keeping on record. mail-lib.ts said a hop can be both at
 * once because "a failed query being refetched is `isError` with
 * `fetchStatus: fetching` and no data, which is exactly what the Retry button
 * produces". IT IS NOT. Driven through a real QueryObserver against the
 * installed @tanstack/query-core 5.101.4: a query that has NEVER succeeded
 * reports `isError: false, fetchStatus: "fetching", data: undefined` during its
 * refetch, because `fetchState()` resets `error` and `status` whenever
 * `data === undefined`. The replacement journey therefore passed with
 * composeGate's two branches SWAPPED -- an assertion that could not fail -- and
 * was deleted rather than kept for the look of it. The ordering rule survives in
 * mail-lib.ts as a property of a function generic over its chain, guarded by the
 * two unit tests in mail-lib.test.ts that DO go red under that swap.
 */

/** POST as the dev user, failing with the server's own words rather than a bare status. */
async function create(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  const body = await response.text();
  expect(response.status(), `POST ${path} answered ${String(response.status())}: ${body}`).toBe(201);
  return JSON.parse(body) as { id: string };
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
const PROJECT_GET = "**/api/projects/*";

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
   * THE HOP THAT WAS NARROWED OUT IN v1.2.2, ASSERTED FROM THE OUTSIDE.
   *
   * The company hop fed `context.companyName` for the mail merge and nothing
   * else. The merge went with the templates, so no field of the seed reads a
   * company any more -- and a control held shut by data nobody reads is just a
   * slower button. Holding the company GET open used to disable Compose here;
   * measured before the narrowing, this test failed on exactly that.
   *
   * THE CONTACT IS WAITED FOR FIRST, on the page's OWN rendering of it, so the
   * one-shot read below happens at a moment when the company is the only thing
   * outstanding -- otherwise a slow contact would disable Compose legitimately
   * and this would be measuring the wrong hop. `isDisabled()` rather than
   * `toBeEnabled()` for the same reason the contactless deal's test gives: an
   * auto-retrying matcher would let a four-second wait pass a test whose claim
   * is that there is no wait at all.
   */
  test("the company hop is gone: holding it open no longer shuts Compose", async ({ page }) => {
    const fixture = await seed(page, runTag("dc"));
    const hold = await delayFirst(page, COMPANY_GET, HELD_MS);
    try {
      await page.goto(`/deals/${fixture.dealId}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(fixture.dealTitle);
      await expect(page.getByTestId("field-contactId")).toContainText("Ontvanger");
      await page.getByTestId("mail-tab").click();
      await expect(page.getByTestId("mail-compose")).toBeVisible();

      const disabled = await page.getByTestId("mail-compose").isDisabled();
      const pending = await page.getByTestId("mail-compose-pending").count();
      expect(hold.holding(), "the company hop was already back: this read raced nothing").toBe(true);
      expect(disabled, "Compose waited for a company no field of the seed reads").toBe(false);
      expect(pending, "the rail said it was fetching this record's details for a hop it no longer has").toBe(0);

      // ...and the hop that DOES decide something still decides it.
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toContainText(fixture.address);
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
   * already had. Retry is how a reader gets the recipient after a failed hop
   * without reloading the page; the alternative is typing the address by hand,
   * which means knowing it. rail/timeline.tsx and rail/meetings.tsx both pair
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

});

test.describe("A project's Mail tab, which reaches no hop at all", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /**
   * MEASURED, AND IT IS NOT WHAT THE PLAN SAYS. A project tab seeds no
   * recipient at all, settled or not, because the rail reads `deal?.contactId`
   * from its own `dealId` prop and a project tab passes none -- there is no
   * project -> deal -> contact hop to race. Asserted here so that adding one
   * later is a red test rather than a surprise.
   *
   * AND SINCE v1.2.2 IT WAITS FOR NOTHING EITHER. What a project tab used to
   * have two deep was project -> company, filling `context.companyName` for the
   * mail merge; the merge is gone and both of those hops went with it, so this
   * tab's gate now has no enabled query in it whatsoever. The project GET is
   * held open here to say so: the rail is mounted inside project-detail.tsx's
   * own loading branch (THE FRAME OUTLIVES THE FETCH), so the Mail tab is
   * reachable while the record it belongs to is still on the wire -- and
   * measured before the narrowing, Compose was disabled at exactly this moment.
   */
  test("seeds no recipient, and waits for no record, because it has neither", async ({ page }) => {
    const fixture = await seed(page, runTag("pn"));
    const hold = await delayFirst(page, PROJECT_GET, HELD_MS);
    try {
      await page.goto(`/projects/${fixture.projectId}`);
      await page.getByTestId("mail-tab").click();
      await expect(page.getByTestId("mail-compose")).toBeVisible();

      const disabled = await page.getByTestId("mail-compose").isDisabled();
      expect(hold.holding(), "the project hop was already back: this read raced nothing").toBe(true);
      expect(disabled, "Compose waited for a project that decides nothing it seeds").toBe(false);

      await expect(page.getByRole("heading", { level: 1 })).toContainText(fixture.projectName);
      await page.getByTestId("mail-compose").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    } finally {
      await hold.unroute();
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
