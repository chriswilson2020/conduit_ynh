import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIL_OAUTH_CALLBACK_PATH } from "@conduit/shared";
import { GOOGLE_AUTHORIZE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../config.js";
import { readFolderListing } from "./mail-imapflow.js";
import { appendsSentCopy, buildAuthorizeUrl } from "./mail-oauth-signin.js";
import { missingSettingsFor } from "./mail-oauth.js";

/**
 * DOCUMENTATION THAT CANNOT DRIFT FROM THE REGISTRATION IT DESCRIBES.
 *
 * docs/mail-oauth-setup.md is the page an operator reads with an Azure or
 * Google console open in the other tab, once, at the only moment any of it
 * matters. Every load-bearing string in it -- the callback path, the scopes,
 * the setting names, which provider Conduit appends sent mail for -- is read
 * out of the MARKDOWN here and checked against the code that implements it.
 *
 * SEPARATE FROM mail-oauth-signin.test.ts, following backup-format.test.ts's
 * precedent: that file proves the sign-in is correct, this one proves the page
 * describing it is still true. They fail for different reasons and a reader
 * should be able to tell which happened.
 *
 * THE FAILURE THIS PREVENTS IS THE PHASE'S OWN. A symbol grep cannot see a
 * sentence, so a scope string edited in the provider table leaves this page
 * quietly wrong -- and "quietly wrong" here means an operator registers
 * permissions that do not match what Conduit asks for, and finds out at a
 * consent screen. That is the class of failure the whole of Task 4 is about.
 *
 * WHAT IT CANNOT DO, said plainly: it cannot check that the page is RIGHT about
 * Microsoft or Google. Nothing here can. It checks that the page agrees with
 * this repository; the claims about somebody else's console were read out of
 * their documentation and are listed as unverified in the page's last section.
 */

const DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..",
  "docs", "mail-oauth-setup.md",
);
const doc = await readFile(DOC_PATH, "utf8");

const CLIENT = {
  clientId: "client-id", clientSecret: "client-secret",
  tokenEndpoint: "https://token.example/t", authorizeEndpoint: "https://authorize.example/a",
  redirectUri: "https://conduit.example/api/mail/oauth/callback",
};

describe("docs/mail-oauth-setup.md", () => {
  // THE INSTRUMENT, SHOWN FAILING, before it is trusted to pass: an unreadable
  // or truncated file would make every `toContain` below a vacuous green.
  it("was actually read", () => {
    expect(doc.length).toBeGreaterThan(4000);
    expect(doc).toContain("# Signing a mailbox in with Microsoft or Google");
    expect(doc).not.toContain("A STRING THAT IS NOT IN THE DOCUMENT");
  });

  /** The one value an operator cannot guess and cannot get slightly wrong. A
   * page naming a path this server does not serve sends them to register a URI
   * that 404s with an authorisation code in the address bar. */
  it("names the callback path this server actually serves", () => {
    expect(doc).toContain(MAIL_OAUTH_CALLBACK_PATH);
  });

  /** Every setting the page tells them to write has to be a setting the server
   * reads. Taken from the sentence the server itself produces when a
   * registration is missing, so the two lists cannot diverge. */
  it("names every setting, in the spelling the server's own refusal uses", () => {
    for (const provider of ["microsoft", "google"] as const) {
      // "..._CLIENT_ID, _CLIENT_SECRET and _TENANT, and MAIL_OAUTH_REDIRECT_URI"
      // -- split back into the variable names it abbreviates.
      const names = missingSettingsFor(provider)
        .split(/,| and /)
        .map((part) => part.trim())
        .filter((part) => part.startsWith("MAIL_OAUTH_"));
      for (const name of names) expect(doc, name).toContain(name);
    }
    // The abbreviated halves the sentence above elides, spelled out in full on
    // the page because an operator cannot paste "_CLIENT_SECRET" into a file.
    for (const name of [
      "MAIL_OAUTH_MICROSOFT_CLIENT_SECRET", "MAIL_OAUTH_MICROSOFT_TENANT",
      "MAIL_OAUTH_GOOGLE_CLIENT_SECRET",
    ]) {
      expect(doc, name).toContain(name);
    }
  });

  /**
   * THE SCOPES, READ OUT OF THE AUTHORIZE URL THIS SERVER BUILDS rather than
   * out of the provider table, so the page is checked against what actually
   * goes to the consent screen. An operator granting permissions that do not
   * match what Conduit asks for gets a consent screen that refuses, or -- worse
   * -- a grant covering more than it should.
   */
  it("names exactly the scopes each provider is asked for", () => {
    for (const provider of ["microsoft", "google"] as const) {
      const url = new URL(buildAuthorizeUrl(provider, CLIENT, {
        state: "s", codeChallenge: "c", loginHint: "a@b.example",
      }));
      for (const scope of (url.searchParams.get("scope") ?? "").split(" ")) {
        expect(doc, scope).toContain(scope);
      }
    }
  });

  /** Graph's permissions are the ones an operator reaches for by default, and
   * they are wrong in a way that fails weeks later at an IMAP server. The page
   * has to say so rather than merely name the right ones. */
  it("says the permissions are Exchange's and not Graph's", () => {
    expect(doc).toContain("Office 365 Exchange Online");
    expect(doc).toContain("Graph");
  });

  /** The spec's Risk 2, item 1: a SPA registration refuses a client secret, and
   * the refusal arrives at the token endpoint rather than at the consent
   * screen -- so the operator sees a sign-in that appeared to work. */
  it("says the Azure platform must be Web rather than SPA", () => {
    expect(doc).toContain("must be Web, not SPA");
  });

  /**
   * The spec's Risk 2, item 2. IMAP syncing while every send fails is the
   * symptom that wastes the most time in this phase, and the remedy is a cmdlet
   * in the tenant.
   *
   * THE PARAMETER AND ITS VALUE, NOT THE WORDS AROUND THEM. A mutation
   * (M49) misspelled the parameter INSIDE the cmdlet and survived an earlier
   * version of this test: `SmtpClientAuthenticationDisabled` still appeared in
   * the prose above it and `Set-CASMailbox` still appeared on the line, so both
   * assertions passed while the line an operator would paste had stopped
   * working. A doc test that only proves the right words are somewhere on the
   * page cannot tell a runnable command from a broken one.
   */
  it("names the SMTP AUTH cmdlet correctly, because that failure looks like a Conduit bug", () => {
    expect(doc).toContain("Set-CASMailbox");
    expect(doc).toContain("-SmtpClientAuthenticationDisabled $false");
  });

  /**
   * THE GMAIL FORK, IN THE PLACE AN OPERATOR MAKES THE DECISION AT INSTALL
   * TIME. The UI carries it too (web: providerSigninCaveat) -- both, because
   * the person choosing an account and the person creating the registration are
   * doing it at different keyboards on different days.
   */
  it("states the Workspace/consumer fork with Google's own figures", () => {
    expect(doc).toContain("Testing");
    expect(doc).toContain("expires\nin 7 days");
    expect(doc).toContain("Internal");
    expect(doc).toContain("restricted");
    // Named as paid, without inventing a price: the assessment is a third
    // party's and its cost is not Google's to publish.
    expect(doc).toContain("paid");
  });

  /**
   * THE SENT-MAIL ASYMMETRY, and the page must not state it backwards. Both
   * providers auto-save; Conduit appends for one of them and not the other, and
   * an operator reading the opposite would go looking for a duplicate that
   * cannot happen or leave one that can.
   */
  it("says which provider Conduit appends a sent copy for, matching the code", () => {
    expect(appendsSentCopy("oauth_google")).toBe(false);
    expect(doc).toContain("Conduit does not append its own copy for\na Google account");

    expect(appendsSentCopy("oauth_microsoft")).toBe(true);
    expect(doc).toContain("Conduit keeps its own APPEND for Microsoft");
    // The runnable half, for the same reason the SMTP AUTH one is checked that
    // way: a parameter misspelled inside the cmdlet leaves every word on the
    // page and the command broken.
    expect(doc).toContain("-MessageCopyForSMTPClientSubmissionEnabled $false");
  });

  /**
   * THE THREE GMAIL VIEWS, CHECKED AGAINST THE ADAPTER THAT CLASSIFIES THEM.
   *
   * A page that told an operator these are off while discovery switched them on
   * would be worse than no page: they would not go looking for the duplicate
   * syncing, because they had been told it could not happen.
   */
  it("says the three Gmail views are left off, and the adapter agrees they are views", () => {
    for (const name of ["[Gmail]/All Mail", "[Gmail]/Starred", "[Gmail]/Important"]) {
      expect(doc, name).toContain(name);
    }
    expect(doc).toContain("Conduit leaves all three switched off");
    // The claim's other half: the adapter really does mark them, so
    // mail-folders.ts's defaultSyncEnabled really does see `virtual`.
    expect(readFolderListing([
      { path: "[Gmail]/All Mail", flags: new Set(["\\All"]), delimiter: "/" },
      { path: "[Gmail]/Starred", flags: new Set(["\\Flagged"]), delimiter: "/" },
      { path: "[Gmail]/Important", flags: new Set(["\\Important"]), delimiter: "/" },
    ]).map((item) => item.virtual)).toEqual([true, true, true]);
  });

  /** Gmail translates its whole special namespace, so the Sent folder Conduit
   * fills in is right only for an English mailbox. The page has to say which
   * field fixes it, because the OAuth form asks for no other server setting and
   * an operator would reasonably assume there is nothing to change. */
  it("warns that Gmail's folder names are localised, and names the remedy", () => {
    expect(doc).toContain("translated into your account's language");
    expect(doc).toContain("[Gmail]/Sent\nMail");
    expect(doc).toContain("editable field");
  });

  /** Google's endpoints are fixed and have no tenant equivalent; the page says
   * so, and this is what stops that sentence outliving a change to either. */
  it("does not describe Google as having a tenant", () => {
    expect(doc).toContain("no tenant equivalent");
    expect(GOOGLE_TOKEN_ENDPOINT).not.toContain("{tenant}");
    expect(GOOGLE_AUTHORIZE_ENDPOINT).not.toContain("{tenant}");
  });

  /** The upgrade trap, which is the reason .env.oauth exists at all: `.env` is
   * re-rendered from conf/.env on every upgrade, so a hand-added value there
   * disappears silently at the worst possible moment. */
  it("says where the settings go, and warns against the file that gets rewritten", () => {
    expect(doc).toContain(".env.oauth");
    expect(doc).toContain("Do not put these in `.env`");
  });

  /** The honest half. A page that quietly implied any of this had been tried
   * against a real provider would be the most expensive sentence in it. */
  it("says plainly that none of it was tested against a real provider", () => {
    expect(doc).toContain("Conduit's tests cannot reach either\nprovider");
  });
});
