import { test, expect } from "@playwright/test";

/**
 * ADDING A MAILBOX BY SIGNING IN, AND REFUSING A CALLBACK THAT WAS NOT ASKED FOR.
 *
 * Phase 8 Task 3. Two halves, and only one of them can be walked end to end
 * here -- which is the spec's Risk 2 in the concrete: "the registration is not
 * code and cannot be tested here."
 *
 * THE AUTHORISE HALF STOPS AT THE URL. playwright.config.ts gives this app FAKE
 * registrations for BOTH providers (a made-up tenant, secrets that are
 * credentials for nothing), so pressing Continue builds a real authorise URL
 * pointing at a consent screen no runner can or should reach. The navigation is
 * aborted at the route and the URL is what is asserted: the scopes, the PKCE
 * challenge and the registered redirect URI are exactly the things a wrong
 * value breaks silently at a provider months later.
 *
 * BOTH, FROM TASK 4, and that is the point rather than symmetry. The phase's
 * claim is that Microsoft and Google are one code path with two configurations;
 * with one registration these journeys could only ever exercise one
 * configuration, and the three parameters that make Google's request different
 * -- access_type, prompt, its single restricted scope -- would have gone to
 * production unwalked.
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

  /**
   * GOOGLE'S AUTHORISE REQUEST, WHICH IS NOT MICROSOFT'S (Phase 8 Task 4).
   *
   * The phase's claim is that the two providers are one code path with two
   * configurations, and the way that claim fails is by being true of the code
   * and false of the configuration. Three of these values are the difference
   * between a working Google sign-in and one that appears to work:
   * `access_type=offline` is the only way Google is asked for a refresh token
   * at all, `prompt=consent` is what makes it issue one AGAIN on a
   * re-authorisation, and `https://mail.google.com/` is the only scope that
   * grants IMAP. Each of them fails at a consent screen or, worse, at the
   * second sign-in weeks later.
   */
  test("builds Google's own authorise URL, with the parameters Google needs", async ({ page }) => {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByRole("radio", { name: "Google" }).check();

    const form = page.getByTestId("oauth-account-form");
    await form.getByTestId("field-oauth-label").locator("input").fill("Gmail");
    await form.getByTestId("field-oauth-email").locator("input").fill("chris@example.com");

    let authorizeUrl = "";
    await page.route("https://accounts.google.com/**", async (route) => {
      authorizeUrl = route.request().url();
      await route.abort();
    });
    await form.getByRole("button", { name: "Continue with Google" }).click();
    await expect.poll(() => authorizeUrl).not.toBe("");

    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("e2e-google-client-id");
    // Without this Google issues no refresh token at all, and without the
    // second it issues none on a REPEAT authorisation -- so "Sign in again"
    // would complete happily and store nothing usable.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // The restricted scope, which is the one that grants IMAP. The narrower
    // gmail.* scopes do not, and it is also the scope behind the consumer-Gmail
    // fork this form warns about.
    expect(url.searchParams.get("scope")).toBe("https://mail.google.com/");
    // One redirect URI for both registrations -- there is one callback route,
    // and `state` rather than the path is what says which sign-in came back.
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3100/api/mail/oauth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl).not.toContain("e2e-google-secret-not-a-real-one");
  });

  /**
   * THE GMAIL FORK, ON SCREEN, BEFORE THE OPERATOR COMMITS.
   *
   * The plan calls shipping this silently "the worst outcome available": a
   * consumer @gmail.com account has its sign-in revoked every seven days, mail
   * stops weekly, and the operator concludes Conduit is broken. Asserted
   * through the rendered page rather than only as a unit test on the string,
   * because the property is that a person about to press the button SEES it --
   * a caveat that exists in a module and is never rendered is the same as no
   * caveat.
   */
  test("warns about consumer Gmail at the point of choosing, and not on Microsoft", async ({ page }) => {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Add account" }).click();

    await page.getByRole("radio", { name: "Google" }).check();
    const caveat = page.getByTestId("oauth-provider-caveat");
    await expect(caveat).toBeVisible();
    // A live region, because the box APPEARS when the radio changes: without
    // one, a screen reader user meets the seven-day revocation and never the
    // warning about it, which is the failure this box exists to prevent aimed
    // at the person least able to recover from it.
    await expect(caveat).toHaveAttribute("role", "alert");
    await expect(caveat).toContainText("7 days");
    await expect(caveat).toContainText("@gmail.com");
    // Half a warning is worse than none: an operator told only that Google is
    // trouble abandons a Workspace mailbox that would have worked.
    await expect(caveat).toContainText("Workspace");

    // Microsoft has no caveat of this kind -- a single-tenant registration in
    // the operator's own directory needs no verification and its refresh tokens
    // do not expire on a timer. Its real traps are tenant-side switches this
    // screen cannot fix, and they are in docs/mail-oauth-setup.md.
    await page.getByRole("radio", { name: "Microsoft" }).check();
    await expect(page.getByTestId("oauth-provider-caveat")).toHaveCount(0);
  });

  /**
   * THE EXPERIMENTAL LABEL, ON SCREEN, WHATEVER IS SELECTED.
   *
   * Chris, 5 Sep: "label the Microsoft and Google connectivity as experimental
   * for now. I don't have time to check it." What this file is exists to make
   * that concrete rather than decorative, and it is the same argument the Gmail
   * caveat's test makes one block up: a label that lives in a module and never
   * reaches a screen is the same as no label, and only a browser can tell the
   * two apart.
   *
   * ASSERTED IN ALL THREE STATES, WHICH IS THE PART A UNIT TEST CANNOT REACH.
   * The box is rendered by the chooser rather than by either provider form, so
   * it must survive the radio changing -- including to Password, where it is
   * still the reason somebody might stay there. A version that had drifted into
   * OAuthAccountForm would pass on Microsoft and Google and fail here, which is
   * exactly the failure worth catching: it would mean the label had stopped
   * being visible at the moment the choice is made.
   *
   * NOT A LIVE REGION, and asserted as such rather than left to chance. The
   * amber box above IS one because it appears when the radio changes; this one
   * is in the dialog's first paint, so an alert role would announce unchanged
   * text over the top of the box that does need announcing.
   */
  test("says the provider path is experimental, whichever option is selected", async ({ page }) => {
    await page.goto(SETTINGS);
    await page.getByRole("button", { name: "Add account" }).click();

    const notice = page.getByTestId("oauth-experimental-notice");
    await expect(notice).toBeVisible();
    await expect(notice, "an alert role here would announce text that never changed")
      .not.toHaveAttribute("role", /.*/);
    await expect(notice).toContainText("experimental");
    // The two halves of what the word means, and the counterweight. Each is a
    // sentence a tidy-up would delete first, and each is the reason the label
    // lets somebody decide instead of merely worry.
    await expect(notice).toContainText("never been run against a real Microsoft or Google account");
    await expect(notice).toContainText("packaging that carries the server-side settings has never been run");
    await expect(notice).toContainText("the request Conduit builds");

    // Present before any choice is made, and still present after either. The
    // password radio is checked on arrival, so the first assertion above
    // already covered that state.
    for (const provider of ["Microsoft", "Google"]) {
      await page.getByRole("radio", { name: provider }).check();
      await expect(page.getByTestId("oauth-experimental-notice")).toBeVisible();
    }
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
