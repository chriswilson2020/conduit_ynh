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
 * SO SOME TESTS HERE CARRY A MAILBOX AND THE REST DO NOT, and that split is
 * deliberate. Three of the four plain tests fail against a composer with the
 * fix reverted (Close at 390, the chip button at 1280). The fourth -- a blank
 * compose at 1280 -- cannot: with no From select the To input IS the first
 * tabbable element, so the old behaviour and the new one agree there. The
 * mailbox tests below are separate so that if their fixture ever breaks, the
 * red tests are the ones whose names say the mailbox is the subject.
 *
 * THE FOUR PLAIN TESTS ARE ACCOUNT-FREE BY FILE ORDERING, AND NOTHING ASSERTS
 * IT. Accounts are per-user and this suite runs as one user, so any account
 * another spec leaves alive would render a From select in these composers too
 * -- which would not break them (the caret still goes to the first empty
 * field) but would quietly turn the desk blank compose into a discriminating
 * test, and a reader comparing mutation results across runs would be reading
 * two different fixtures. In CI the ordering is fixed: workers is 1 and
 * Playwright walks the files alphabetically, so "composer-focus" runs before
 * both specs that create an account -- e2e/mail.spec.ts (its beforeAll) and
 * e2e/mobile.spec.ts:1569 (its own phone journey). NEITHER archives its
 * account when it finishes; both instead SWEEP every live own account when
 * they start, so the alphabetical order is the whole of the guarantee. Locally,
 * with default workers, all three files can overlap in both directions: this
 * file's accounts can be swept by either sweeper mid-test, and either file's
 * account can appear in these composers. Run this file alone in that loop.
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

/**
 * The record's Mail tab, with the composer open on a seeded recipient.
 *
 * THE WAIT ON THE HEADING IS THE WHOLE OF WHY THIS IS A FUNCTION. The rail
 * builds its seed AT CLICK TIME from `useContact(contactId)` -- a contact
 * whose query has not resolved yet yields `to: []`, which is a blank compose,
 * which focuses To and is a perfectly plausible-looking pass of the wrong
 * assertion. Measured: without this, the two rail tests failed intermittently
 * on the CHIP assertion (the seed had no recipient) rather than on focus. The
 * detail page reads the same query key, so a heading carrying the contact's
 * name is proof the cache the rail is about to read is warm.
 */
async function openRailCompose(page: Page, contactId: string, surname: string): Promise<void> {
  await page.goto(`/contacts/${contactId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(surname);
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
    await openRailCompose(page, contactId, `Doelgericht${tag}`);
    // The instrument: the seed really did bring a recipient, so "Subject" is
    // the first EMPTY field rather than simply the first field.
    await expect(page.getByTestId("composer")).toContainText(`femke-${tag}@example.com`);
    await expect(page.getByTestId("composer-subject")).toBeFocused();
  });
});

/**
 * THE TWO TESTS THAT NEED A MAILBOX, and both need it for the same thing: a
 * composer with a From select in it. The first wants the combobox in FRONT of
 * the To field, because that is what a desktop compose used to open on and
 * without it a blank compose at 1280 lands on To whether this release's change
 * is present or not. The second wants two of them, so the account can be
 * switched mid-message and its signature appended under a caret the user
 * placed.
 *
 * THE ACCOUNTS ARE DELIBERATELY UNREACHABLE. 192.0.2.1 is TEST-NET-1
 * (RFC 5737), which routes nowhere: an account is created `active`, its first
 * sync pass blocks on a TCP connect that never completes, and only when that
 * times out does the row go to `status: 'error'` and drop out of the
 * composer's From select. Measured on the dev server: 25 seconds of `active`,
 * against tests that need two or three. They are archived at the end so they
 * cannot follow this file into another spec's composer -- which also matters
 * the other way round: e2e/mail.spec.ts's beforeAll archives EVERY
 * non-archived own account it finds, so an account left alive here would be
 * silently swept by that file if the two ever ran concurrently. They do not in
 * CI (workers: 1), and locally they can, which is exactly the loop this file
 * is written for. See the header for the ordering this file depends on.
 *
 * IF EITHER EVER GOES FLAKY, that window is the thing to look at -- a network
 * that answers TEST-NET-1 with an immediate ICMP unreachable would shrink it
 * to nothing. The repair is a slower failure, not a longer timeout: nothing
 * here waits on an account, it either exists in the select or it does not.
 *
 * AND NEITHER OF THESE IS LOAD-BEARING ON ITS OWN, which is worth saying so
 * that a flake here is triaged as a flake rather than as a hole. The desk's
 * opening focus is separated from the old behaviour by the record-rail test
 * above as well, which needs no mailbox at all -- a seeded To arrives holding
 * a chip, and the chip's Remove button is what the old code focused. And
 * packages/web/src/components/mail/composer-focus.test.ts pins both mechanisms
 * in the source without a browser, a database or a network.
 */
interface Fixture { id: string; label: string }

async function makeAccount(page: Page, label: string, signatureHtml: string | null): Promise<Fixture> {
  const created = await page.request.post("/api/mail/accounts", {
    data: {
      label,
      email: `${label.replace(/\W+/g, "-").toLowerCase()}@example.com`,
      imapHost: "192.0.2.1", imapPort: 993, imapSecurity: "tls",
      smtpHost: "192.0.2.1", smtpPort: 587, smtpSecurity: "starttls",
      username: "focus", password: "not-a-real-mailbox",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  if (signatureHtml !== null) {
    const patched = await page.request.patch(`/api/mail/accounts/${id}`, { data: { signatureHtml } });
    expect(patched.status(), await patched.text()).toBe(200);
  }
  return { id, label };
}

test.describe("A desk compose with a mailbox configured", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("puts the caret in To rather than the From combobox in front of it", async ({ page }) => {
    const account = await makeAccount(page, `Focus fixture ${Date.now().toString(36)}`, null);
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
      await page.request.post(`/api/mail/accounts/${account.id}/archive`);
    }
  });

  /**
   * SWITCHING ACCOUNTS MUST NOT DRAG THE CARET INTO THE SIGNATURE, and this is
   * the guard for rich-text.tsx's `updateSelection: false` on its own.
   *
   * The composer appends the selected account's signature at the end of the
   * body, and TipTap's insertContentAt updates the selection by default -- so
   * before v1.2.0 the append moved the caret to the end of the block it had
   * just inserted. Nothing could see it on open, because nothing had put a
   * caret in that editor; a user who was typing when they changed the From
   * account could, and the rest of their sentence went into the signature.
   *
   * NOTHING HERE TOUCHES rich-text.tsx's focus(), which is the point: the
   * caret is placed by a CLICK, and the composer's own opening focus went to
   * To (this is a blank compose). So the two halves of that pair, which are
   * dead-equivalent on the open path, are separable here -- this fails on the
   * updateSelection mutation alone.
   *
   * GETTING BACK INTO THE EDITOR IS THE HARD PART OF THIS TEST, and two
   * obvious ways are both wrong. Closing the Select takes focus out of the
   * editor entirely -- measured: document.activeElement is a div and the DOM
   * selection has left the composer altogether -- so the typing has to be
   * preceded by something. A second CLICK would place the caret itself and
   * prove nothing. A DOM focus() on the contenteditable is worse than useless:
   * the browser puts the caret at offset 0, ProseMirror reads that back into
   * its state, and the stored selection under test is destroyed by the act of
   * observing it (measured: "MORE" arrived as "MORETOPLINE" with the fix in
   * place, which is a false failure).
   *
   * SO THE GESTURE IS THE TOOLBAR'S BOLD BUTTON, which is the app's own
   * restore-the-caret path: rich-text.tsx's toolbar chains editor.focus()
   * before its command, and TipTap's focus() writes the STORED selection back
   * to the DOM rather than adopting whatever the browser chose. Measured, it
   * returns the caret to offset 7 -- the end of "TOPLINE". It is a different
   * call site from RichTextHandle.focus(), which is what keeps this test
   * independent of that function's "start" argument. The bold mark it leaves
   * on "MORE" does not reach innerText.
   *
   * THE NEWEST ACCOUNT IS THE SELECTED ONE -- the API lists own accounts
   * `desc(createdAt)` and the composer takes the first -- so the signed one is
   * created FIRST and the plain one second. That is asserted rather than
   * trusted: the trigger has to be showing the plain account, and the body has
   * to be free of the marker, before the switch means anything.
   */
  test("switching the From account leaves the caret where the user put it", async ({ page }) => {
    const tag = Date.now().toString(36);
    const marker = `Groeten ${tag}`;
    const signed = await makeAccount(page, `Signed ${tag}`, `<p>-- ${marker}</p>`);
    const plain = await makeAccount(page, `Plain ${tag}`, null);

    try {
      await page.goto("/mail");
      await page.getByTestId("compose-button").click();
      await expect(page.getByTestId("composer")).toBeVisible();
      const trigger = page.getByTestId("composer-account");
      await expect(trigger, "the plain account should be the one auto-selected").toContainText(plain.label);

      const body = page.getByTestId("composer-body");
      await expect(body).toHaveAttribute("contenteditable", "true");
      await expect(body, "no signature should be in the document yet").not.toContainText(marker);
      await body.click();
      await expect(body).toBeFocused();
      await page.keyboard.type("TOPLINE");
      await expect(body).toContainText("TOPLINE");

      await trigger.click();
      await page.getByRole("option", { name: new RegExp(signed.label) }).click();
      await expect(body, "the signed account's signature should have been appended")
        .toContainText(marker);

      await page.getByTestId("composer").getByRole("button", { name: "Bold" }).click();
      // TipTap's focus() lands in a requestAnimationFrame, so the caret is not
      // back in the editor on the click's own tick. Waiting on focus rather
      // than on a timer.
      await expect(body).toBeFocused();
      await page.keyboard.type("MORE");

      const text = (await body.innerText()).replace(/\s+/g, " ").trim();
      expect(text, "the caret was dragged into the signature by the append").toContain("TOPLINEMORE");
      expect(text.indexOf("TOPLINEMORE")).toBeLessThan(text.indexOf(marker));
    } finally {
      await page.request.post(`/api/mail/accounts/${signed.id}/archive`);
      await page.request.post(`/api/mail/accounts/${plain.id}/archive`);
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
    await openRailCompose(page, contactId, `Doelgericht${tag}`);
    await expect(page.getByTestId("composer")).toContainText(`femke-${tag}@example.com`);
    await expect(page.getByTestId("dialog-close")).toBeVisible();
    await expect(page.getByTestId("composer-subject")).toBeFocused();
  });
});
