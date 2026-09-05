import { test, expect } from "@playwright/test";

/**
 * ADDING A MAILBOX BY SIGNING IN, AND REFUSING A CALLBACK THAT WAS NOT ASKED FOR.
 *
 * Phase 8 Task 3. Two halves, and only one of them can be walked end to end
 * here -- which is the spec's Risk 2 in the concrete: "the registration is not
 * code and cannot be tested here."
 *
 * THE AUTHORISE HALF STOPS AT THE URL. playwright.config.ts gives this app a
 * FAKE Microsoft registration (a made-up tenant, a secret that is a credential
 * for nothing), so pressing Continue builds a real authorise URL pointing at a
 * consent screen no runner can or should reach. The navigation is aborted at
 * the route and the URL is what is asserted: the scopes, the PKCE challenge and
 * the registered redirect URI are exactly the things a wrong value breaks
 * silently at a provider months later.
 *
 * THE CALLBACK HALF RUNS FOR REAL, and it is where the security is. A forged
 * `state` is the CSRF hole this whole flow is built around -- an attacker who
 * completes an authorisation against their own mailbox and induces this browser
 * to load the callback would otherwise attach their mailbox to this account.
 * The refusal is a server route, a redirect and a sentence on a page, which is
 * three layers no unit test spans.
 *
 * NO ACCOUNT IS EVER CREATED BY THIS FILE, so it needs no cleanup and cannot
 * collide with e2e/mail.spec.ts's account: the only callback it completes is
 * one that is refused.
 */

const SETTINGS = "/settings/mail";

test.describe("signing a mailbox in at a provider", () => {
  test("offers the provider path beside the password one, and asks for no server settings", async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId("mail-settings")).toBeVisible();
    await page.getByRole("button", { name: "Add account" }).click();

    // The chooser only exists because this install has a registration. Without
    // one the dialog goes straight to the password form -- which is the
    // deployment target's ordinary case and is what e2e/mail.spec.ts walks.
    await expect(page.getByRole("radio", { name: "Password (IMAP and SMTP)" })).toBeChecked();
    await page.getByRole("radio", { name: "Microsoft" }).check();

    const form = page.getByTestId("oauth-account-form");
    await expect(form).toBeVisible();
    // THE ABSENCE IS THE FEATURE (the spec: "an OAuth account asks for none of
    // them -- the endpoints are the provider's and known"). Asserted through
    // the rendered page rather than only in a source guard, because a field
    // could reappear from the shared password form's grid rather than from this
    // component's own JSX.
    for (const field of ["imap-host", "imap-port", "smtp-host", "smtp-port", "username", "password"]) {
      await expect(form.getByTestId(`field-${field}`)).toHaveCount(0);
    }
    await expect(form.getByTestId("field-oauth-label")).toBeVisible();
    await expect(form.getByTestId("field-oauth-email")).toBeVisible();
  });

  test("builds an authorise URL with the mail scopes, PKCE and the registered redirect URI", async ({ page }) => {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByRole("radio", { name: "Microsoft" }).check();

    const form = page.getByTestId("oauth-account-form");
    await form.getByTestId("field-oauth-label").locator("input").fill("Microsoft 365");
    await form.getByTestId("field-oauth-email").locator("input").fill("chris@contoso.example");

    // The consent screen is a third party's page. Catch the navigation and
    // abort it: what this test is about is the URL this app built, and letting
    // the request out would make the suite depend on Microsoft being up.
    let authorizeUrl = "";
    await page.route("https://login.microsoftonline.com/**", async (route) => {
      authorizeUrl = route.request().url();
      await route.abort();
    });
    await form.getByRole("button", { name: "Continue with Microsoft" }).click();
    await expect.poll(() => authorizeUrl).not.toBe("");

    const url = new URL(authorizeUrl);
    expect(url.pathname).toBe("/e2e-tenant.example/oauth2/v2.0/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("e2e-client-id");
    // Compared byte for byte at the provider (RFC 6749 3.1.2.3), and never
    // built from the request's own Host header.
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3100/api/mail/oauth/callback");
    expect(url.searchParams.get("login_hint")).toBe("chris@contoso.example");
    // PKCE: the verifier stays on the server, so what a code lifted out of an
    // access log can be exchanged for is nothing.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    // The two mail scopes and offline_access, and nothing that would make the
    // grant multi-resource -- see the provider table in
    // api: services/mail-oauth-signin.ts for why a Graph or openid scope here
    // can hand the REFRESH a token IMAP refuses.
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(scopes).toContain("https://outlook.office.com/SMTP.Send");
    expect(scopes).not.toContain("openid");
    // Never in a URL that reaches a browser history and an access log.
    expect(authorizeUrl).not.toContain("e2e-client-secret-not-a-real-one");
  });

  test("REFUSES A FORGED CALLBACK, and says so on the settings page", async ({ page }) => {
    // Nothing minted this state, so nothing can redeem it. The whole journey
    // is real: the server route, the 303, the SPA route's search parsing, and
    // the banner.
    await page.goto("/api/mail/oauth/callback?code=stolen-code&state=" + "f".repeat(64));

    await expect(page).toHaveURL(/\/settings\/mail\?oauth=failed&reason=state/);
    const banner = page.getByTestId("oauth-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("could not be verified");
    // It says what to do. A refusal that only says no is a dead end.
    await expect(banner).toContainText("Start it again");

    // And nothing was created by it.
    await expect(page.getByTestId("mail-settings")).toBeVisible();
    await expect(
      page.locator('[data-testid^="mail-account-"]').filter({ hasText: "Microsoft 365" }),
    ).toHaveCount(0);
  });

  test("a callback with no state at all is refused the same way", async ({ page }) => {
    await page.goto("/api/mail/oauth/callback?code=stolen-code");
    await expect(page).toHaveURL(/\/settings\/mail\?oauth=failed&reason=state/);
    await expect(page.getByTestId("oauth-banner")).toBeVisible();
  });

  test("the provider's own error text never reaches the URL", async ({ page }) => {
    // A redirect's query string lands in a URL bar, a history entry and
    // nginx's access log. The server answers a CODE and the client owns the
    // prose (api: services/mail-oauth-signin.ts's SigninOutcome).
    //
    // This one is refused as `state` rather than as `denied`, and that ordering
    // is deliberate rather than incidental: the state is redeemed BEFORE the
    // provider's `error` is even looked at, so a callback nobody asked for
    // costs one map lookup whatever it claims to be carrying.
    await page.goto(
      "/api/mail/oauth/callback?error=access_denied"
      + "&error_description=AADSTS65004+user+declined+to+consent&state=" + "f".repeat(64),
    );
    expect(page.url()).not.toContain("AADSTS");
    expect(page.url()).not.toContain("declined");
    await expect(page.getByTestId("oauth-banner")).toBeVisible();
  });
});
