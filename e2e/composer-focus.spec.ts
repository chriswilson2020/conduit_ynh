import { test, expect, devices } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * WHERE THE CARET IS WHEN THE MAIL COMPOSER OPENS, AT A DESK AND UNDER A THUMB.
 *
 * v1.2.0 gives the composer an explicit opening focus: the FIRST EMPTY field,
 * in the order To, Subject, body (web: components/mail/mail-lib.ts's
 * composerInitialFocus, whose own doc comment carries the four seeds and why
 * "reply versus new" is the wrong discriminator). This file is the wiring half
 * of that -- that the field the rule names is the field the browser actually
 * focuses, at 1280 and at 390.
 *
 * WHAT IT WAS BEFORE, MEASURED RATHER THAN ASSUMED, because the finding as
 * written down was half wrong and the wrong half was the desk. It said "focus
 * is on Close". At 390 that is true of every seed: ui/dialog.tsx's md:hidden
 * Close is the first tabbable child of every dialog and Radix focuses the first
 * tabbable descendant, so a blank compose, a reply and a forward all opened on
 * the control that throws the draft away. At 1280 that control is display:none
 * and there were THREE different answers, not one:
 *
 *   seed                     mailbox              focus landed on
 *   any                      a sendable account   the From combobox
 *   To seeded (rail, reply)  no sendable account  "Remove <address>" (a chip)
 *   To empty (blank, fwd)    no sendable account  the To input -- correct, by
 *                                                 accident of DOM order
 *
 * The first is the plan's guess and it is right only when the user has a
 * mailbox configured. It is also the worst of the three: a Radix trigger takes
 * letter keys as TYPEAHEAD, so someone opening a compose and typing a
 * recipient silently changed which account the message would be sent from.
 * The second is worse than Close -- the first thing under the caret was the
 * button that removes the recipient the seed had just supplied.
 *
 * SO ONE TEST HERE CARRIES A MAILBOX AND THE REST DO NOT, and that split is
 * deliberate. Three of the four plain tests fail against a composer with the
 * fix reverted (Close at 390, the chip button at 1280). The fourth -- a blank
 * compose at 1280 -- cannot: with no From select the To input IS the first
 * tabbable element, so the old behaviour and the new one agree there. The
 * mailbox test below is the one that separates them, and it is on its own so
 * that if its fixture ever breaks, exactly one test goes red and its name says
 * what the subject is.
 *
 * THE REPLY AND THE FORWARD ARE NOT HERE, and there is nowhere else they could
 * be. Both seeds come from an open conversation, which exists only after a real
 * message has been synced from a real IMAP server -- e2e/mail.spec.ts and
 * e2e/mobile.spec.ts own that fixture between them, so the assertions ride
 * along in those journeys (search for toBeFocused). This file needs no mail
 * server at all, which is what lets it run in the local tunnel loop.
 */

// See mobile.spec.ts: everything the device describes except the browser
// choice, since the job installs chromium and only chromium.
const { defaultBrowserType: _webkitByDefault, ...IPHONE_13 } = devices["iPhone 13"];

/** A contact with an address, so the rail's Compose seeds a recipient. */
async function seedContact(page: Page, tag: string): Promise<string> {
  const company = await page.request.post("/api/companies", { data: { name: `Focusco ${tag}` } });
  expect(company.status(), await company.text()).toBe(201);
  const companyId = ((await company.json()) as { id: string }).id;
  const contact = await page.request.post("/api/contacts", {
    data: {
      firstName: "Femke",
      lastName: `Doelgericht${tag}`,
      companyId,
      emails: [`femke-${tag}@example.com`],
    },
  });
  expect(contact.status(), await contact.text()).toBe(201);
  return ((await contact.json()) as { id: string }).id;
}

/** The record's Mail tab, with the composer open on a seeded recipient. */
async function openRailCompose(page: Page, contactId: string): Promise<void> {
  await page.goto(`/contacts/${contactId}`);
  await page.getByTestId("mail-tab").click();
  await page.getByTestId("mail-compose").click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

test.describe.serial("The composer opens on the first empty field, at a desk", () => {
  const tag = `d${Date.now().toString(36)}`;
  let page: Page;
  let contactId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    contactId = await seedContact(page, tag);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a blank compose from the inbox puts the caret in To", async () => {
    await page.goto("/mail");
    await page.getByTestId("compose-button").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("composer-to")).toBeFocused();
  });

  test("a record's Mail tab puts it in Subject, because To is already filled", async () => {
    await openRailCompose(page, contactId);
    // The instrument: the seed really did bring a recipient, so "Subject" is
    // the first EMPTY field rather than simply the first field.
    await expect(page.getByTestId("composer")).toContainText(`femke-${tag}@example.com`);
    await expect(page.getByTestId("composer-subject")).toBeFocused();
  });
});

/**
 * THE ONE TEST THAT NEEDS A MAILBOX, and the only thing it needs it for is to
 * put the From combobox back in front of the To field -- that combobox is what
 * a desktop compose used to open on, and without it a blank compose at 1280
 * lands on To whether this release's change is present or not.
 *
 * THE ACCOUNT IS DELIBERATELY UNREACHABLE. 192.0.2.1 is TEST-NET-1 (RFC 5737),
 * which routes nowhere: the account is created `active`, its first sync pass
 * blocks on a TCP connect that never completes, and only when that times out
 * does the row go to `status: 'error'` and drop out of the composer's From
 * select. Measured on the dev server: 25 seconds of `active`, against a test
 * that needs about two. It is archived at the end so it cannot follow this
 * file into another spec's composer.
 *
 * IF THIS EVER GOES FLAKY, that window is the thing to look at -- a network
 * that answers TEST-NET-1 with an immediate ICMP unreachable would shrink it
 * to nothing. The repair is a slower failure, not a longer timeout: nothing
 * here waits on the account, it either exists in the select or it does not.
 */
test.describe("A desk compose with a mailbox configured", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("puts the caret in To rather than the From combobox in front of it", async ({ page }) => {
    const tag = `a${Date.now().toString(36)}`;
    const created = await page.request.post("/api/mail/accounts", {
      data: {
        label: `Focus fixture ${tag}`,
        email: `focus-${tag}@example.com`,
        imapHost: "192.0.2.1", imapPort: 993, imapSecurity: "tls",
        smtpHost: "192.0.2.1", smtpPort: 587, smtpSecurity: "starttls",
        username: "focus", password: "not-a-real-mailbox",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const accountId = ((await created.json()) as { id: string }).id;

    try {
      await page.goto("/mail");
      await page.getByTestId("compose-button").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      // THE INSTRUMENT, PROVED, in the shape e2e/row-links.spec.ts uses: this
      // test means nothing unless the control it is about is on screen.
      await expect(
        page.getByTestId("composer-account"),
        "the From combobox is missing, so this test is not the case it exists for -- see the account fixture note above",
      ).toBeVisible();
      await expect(page.getByTestId("composer-to")).toBeFocused();
    } finally {
      await page.request.post(`/api/mail/accounts/${accountId}/archive`);
    }
  });
});

test.describe.serial("The composer opens on the first empty field, under a thumb", () => {
  const tag = `p${Date.now().toString(36)}`;
  let page: Page;
  let contactId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ ...IPHONE_13 });
    contactId = await seedContact(page, tag);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a blank compose puts the caret in To, not on Close", async () => {
    await page.goto("/mail");
    await page.getByTestId("compose-button").click();
    await expect(page.getByTestId("composer")).toBeVisible();
    // The hazard this width has and the desk does not: the sheet's own way out
    // is the dialog's first tabbable child. It is still there -- a full-screen
    // sheet must keep it -- it just no longer holds the caret.
    await expect(page.getByTestId("dialog-close")).toBeVisible();
    await expect(page.getByTestId("composer-to")).toBeFocused();
  });

  test("a record's Mail tab puts it in Subject", async () => {
    await openRailCompose(page, contactId);
    await expect(page.getByTestId("composer")).toContainText(`femke-${tag}@example.com`);
    await expect(page.getByTestId("dialog-close")).toBeVisible();
    await expect(page.getByTestId("composer-subject")).toBeFocused();
  });
});
