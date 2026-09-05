import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * WHAT AN OPERATOR ACTUALLY SEES WHEN AN OAUTH GRANT LAPSES (Phase 8 Task 2).
 *
 * WHY THIS FILE EXISTS, AND WHY IT STUBS. The unit suite proves the two halves
 * separately -- mail-sync.test.ts that a refused refresh becomes
 * status='auth_required' on the row, settings-mail-lib.test.ts that the state
 * produces the words "Sign in again" and a sentence naming the provider. What
 * neither can show is the two halves JOINED: that the settings page reads that
 * column and renders those words. A pure-function test passing while the
 * component never calls the function is exactly the shape of vacuous assertion
 * this repository keeps finding, and it is the shape that matters most here --
 * the whole feature is "the operator is told", so a helper nobody renders is
 * the feature not existing.
 *
 * IT CANNOT BE DRIVEN FROM OUTSIDE ANY OTHER WAY. Reaching this state for real
 * needs a Microsoft or Google tenant to revoke a grant, which is Risk 2's
 * "cannot be tested from here" in the concrete; and nothing in v1.7.0 Task 2
 * can even CREATE an OAuth account (no route, no form, no writer -- that is
 * Task 3). So `/api/mail/accounts` is served from this file and everything else
 * -- the session, the nav, the page itself -- is the real app, following
 * inbox-live.spec.ts's precedent and its reasoning.
 *
 * NO MAIL SERVER, so this runs everywhere mail.spec.ts's journey cannot, and it
 * is deterministic: every claim below can be arranged in a second and shown red
 * against a broken build.
 */

const ACCOUNT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3311";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3312";

type AuthMethod = "password" | "oauth_microsoft" | "oauth_google";
type Status = "active" | "error" | "auth_required";

/** One account, exactly as GET /api/mail/accounts serializes it. */
async function stubAccount(
  page: Page, overrides: { status: Status; authMethod: AuthMethod; lastError: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await page.route((url) => url.pathname === "/api/mail/accounts", async (route: Route) => {
    await route.fulfill({
      json: {
        own: [{
          id: ACCOUNT_ID, userId: USER_ID, label: "Stub mailbox", email: "stub@example.com",
          imapHost: "outlook.office365.com", imapPort: 993, imapSecurity: "tls",
          smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls",
          username: "stub", sentFolder: "Sent",
          trashFolder: "Trash", archiveFolder: "Archive", signatureHtml: null,
          backfillDays: 90, visibility: "private",
          authMethod: overrides.authMethod,
          status: overrides.status, lastError: overrides.lastError,
          lastSyncedAt: now, archivedAt: null, createdAt: now, updatedAt: now,
          syncStats: null,
        }],
        others: [],
      },
    });
  });
  // The folder picker's read, which the card fetches lazily; an empty list is a
  // real answer and keeps this file about the account row.
  await page.route(
    (url) => url.pathname.startsWith("/api/mail/accounts/") && url.pathname.endsWith("/folders"),
    async (route: Route) => { await route.fulfill({ json: [] }); },
  );
}

function card(page: Page) {
  return page.getByTestId(`mail-account-${ACCOUNT_ID}`);
}

test.describe("a lapsed OAuth grant, on the Settings row", () => {
  /**
   * THE INSTRUCTION, NOT THE DIAGNOSIS. "Error" describes the server's mood and
   * invites waiting; this state never clears on its own, so the badge has to
   * name the action. An implementation that folded auth_required into the error
   * branch would pass every unit test in the repository and still produce the
   * spec's Risk 3 -- mail that stopped, and a row that reads like it might come
   * back.
   */
  test("says Sign in again, and does not say Error", async ({ page }) => {
    await stubAccount(page, {
      status: "auth_required", authMethod: "oauth_microsoft",
      lastError: "microsoft would not renew this account's sign-in (invalid_grant).",
    });
    await page.goto("/settings/mail");

    await expect(card(page)).toContainText("Sign in again");
    await expect(card(page)).not.toContainText("Error");
    await expect(card(page)).not.toContainText("Active");
  });

  /** The provider is named because signing in again is a different errand at
   * each one, and the operator is about to go and do one of them. It comes from
   * auth_method, in the clear -- no trip to mail.key to render a row. */
  test("names the provider and what signing in again restores", async ({ page }) => {
    await stubAccount(page, {
      status: "auth_required", authMethod: "oauth_microsoft", lastError: "invalid_grant",
    });
    await page.goto("/settings/mail");

    const alert = card(page).getByRole("alert");
    await expect(alert).toContainText("Microsoft");
    await expect(alert).toContainText("Sign in again");
    await expect(alert).toContainText("syncing");
  });

  test("names Google for a Google account", async ({ page }) => {
    await stubAccount(page, {
      status: "auth_required", authMethod: "oauth_google", lastError: "invalid_grant",
    });
    await page.goto("/settings/mail");

    await expect(card(page).getByRole("alert")).toContainText("Google");
  });

  /**
   * THE DISCRIMINATING CASE. Without it, every claim above is satisfied by a
   * page that shows "Sign in again" for any failure at all -- which would tell
   * an operator to re-authorise over a mail server that was rebooting, and send
   * them away from the Test connection button that is the right control for it.
   */
  test("still shows an ordinary failure as an error, with the server's own words", async ({ page }) => {
    await stubAccount(page, {
      status: "error", authMethod: "oauth_microsoft",
      lastError: "connection: connect ECONNREFUSED 10.0.0.1:993",
    });
    await page.goto("/settings/mail");

    await expect(card(page)).toContainText("Error");
    await expect(card(page)).not.toContainText("Sign in again");
    await expect(card(page).getByRole("alert")).toContainText("Server unreachable");
  });

  /**
   * THE OTHER HALF OF THE CASE ABOVE, added by Task 3 because that case caught
   * Task 3 getting this wrong.
   *
   * The re-authorise control was labelled "Sign in again" at first -- the
   * badge's own words for status='auth_required' -- and putting them on a
   * button that renders for EVERY provider row put them on the error card the
   * case above forbids them on. It failed, which is the case doing its job.
   *
   * So the control names the PROVIDER, and this is what stops the fix from
   * being a rename that quietly removed the control instead: a card that lost
   * the button altogether would satisfy the negative assertion above perfectly.
   * Two claims, and neither is satisfiable by the other's failure.
   */
  test("offers a re-authorise control that names the provider, in both failure states", async ({ page }) => {
    for (const status of ["auth_required", "error"] as const) {
      await stubAccount(page, { status, authMethod: "oauth_microsoft", lastError: "whatever" });
      await page.goto("/settings/mail");
      await expect(
        card(page).getByRole("button", { name: "Sign in with Microsoft" }),
      ).toBeVisible();
    }
  });

  /** And it is absent from a PASSWORD account, which has no grant to renew --
   * offering one would be a control whose only outcome is a refusal. */
  test("offers no re-authorise control on a password account", async ({ page }) => {
    await stubAccount(page, { status: "error", authMethod: "password", lastError: "connection: nope" });
    await page.goto("/settings/mail");
    await expect(card(page)).toContainText("Error");
    await expect(card(page).getByRole("button", { name: /^Sign in with/ })).toHaveCount(0);
  });
});
