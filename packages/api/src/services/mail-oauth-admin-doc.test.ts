import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIL_OAUTH_CALLBACK_PATH } from "@conduit/shared";
import { parseConfig, redirectUriProblem } from "../config.js";
import { buildAuthorizeUrl } from "./mail-oauth-signin.js";
import { missingSettingsFor } from "./mail-oauth.js";

/**
 * THE PAGE THE YUNOHOST ADMIN CONSOLE SHOWS, PINNED TO THE INSTALL IT DESCRIBES.
 *
 * doc/ADMIN.md is rendered by YunoHost on the app's own info page in the
 * webadmin, and it is a DIFFERENT DOCUMENT FOR A DIFFERENT READER than
 * docs/mail-oauth-setup.md (pinned by mail-oauth-doc.test.ts next door). That
 * one is the long form, read with a provider console open. This one is read by
 * somebody standing in the webadmin who does not yet know a registration is
 * required at all -- so it is short, ordered, and carries THIS INSTALL'S REAL
 * VALUES rather than a template to assemble.
 *
 * WHAT MAKES IT REAL VALUES, and why this file has to simulate a Python
 * function: YunoHost hydrates doc pages before displaying them. Verified in
 * yunohost's own source at tag debian/12.1.17 -- the minimum this package's
 * manifest declares -- and unchanged on `dev`:
 *
 *   src/app.py app_info():        _hydrate_app_template(content, settings)
 *                                 for every doc page, with the app's settings
 *   src/utils/app_utils.py:       jinja2 render IF the text contains "{%",
 *                                 then re.findall(r"__[A-Z0-9]+?[A-Z0-9_]*?
 *                                 [A-Z0-9]*?__") replaced from those settings
 *
 * So __DOMAIN__ and __PATH__ become this install's domain and path. `hydrate`
 * below reproduces both stages for the two constructs the page uses, and a
 * separate test refuses any construct it cannot faithfully reproduce, so the
 * simulation can never quietly drift from the page.
 *
 * THE VALUE THIS EXISTS FOR IS THE REDIRECT URI. It is compared byte for byte
 * at the provider (RFC 6749 3.1.2.3), it is the single value most likely to be
 * got wrong, and the obvious template for it -- `https://__DOMAIN____PATH__` --
 * IS WRONG AT A ROOT INSTALL: YunoHost's WebPathOption.normalize returns
 * "/" + value.strip(" /"), so `path` is exactly "/" at the root and the page
 * would print https://box.example//api/mail/oauth/callback. A doubled slash is
 * invisible to the eye, survives redirectUriProblem's suffix check, and fails
 * at somebody else's consent screen. That is the failure this file exists to
 * make impossible, and the reason the expected string is taken from the
 * sentence config.ts itself prints rather than retyped here.
 *
 * WHAT IT CANNOT DO. It cannot prove YunoHost renders the page the way this
 * simulation says, because nothing in this repository can reach a YunoHost.
 * It cannot prove anything about Microsoft's or Google's consoles either --
 * same limit as the sibling test, and the page says so itself.
 */

const REPO = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..",
);
const doc = await readFile(path.join(REPO, "doc", "ADMIN.md"), "utf8");
const description = await readFile(path.join(REPO, "doc", "DESCRIPTION.md"), "utf8");
const common = await readFile(path.join(REPO, "scripts", "_common.sh"), "utf8");
const upgrade = await readFile(path.join(REPO, "scripts", "upgrade"), "utf8");

/** A domain no install can have, so a match below is the page's and not a
 * coincidence with some URL Microsoft or Google publishes. */
const DOMAIN = "crm.example";

/**
 * Three installs this package can really produce, as YunoHost would hand their
 * settings to the hydrator.
 *
 * `app` and `install_dir` ARE settings and not a guess: resources.py's
 * InstallDirAppResource ends in `self.set_setting("install_dir", self.dir)`,
 * and app_utils.py's _get_app_settings injects `settings["app"] = app` before
 * returning ("Make the app id available as $app too"). `path` is what
 * form.py's WebPathOption.normalize produced at install time --
 * `"/" + value.strip().strip(" /")` -- which is why the root case is "/"
 * exactly and never "".
 *
 * THE SECOND INSTANCE IS HERE BECAUSE manifest.toml SAYS multi_instance = true.
 * Its unit and its install directory are `conduit__2`, so a page that hard-coded
 * `systemctl restart conduit` would send the operator to restart somebody
 * else's app -- one that is running fine, which is the worst way to be wrong.
 */
const INSTALLS = {
  "root": { domain: DOMAIN, path: "/", app: "conduit", install_dir: "/var/www/conduit" },
  "sub-path": {
    domain: DOMAIN, path: "/conduit", app: "conduit", install_dir: "/var/www/conduit",
  },
  "second instance": {
    domain: DOMAIN, path: "/crm", app: "conduit__2", install_dir: "/var/www/conduit__2",
  },
} as const;

const CLIENT = {
  clientId: "client-id", clientSecret: "client-secret",
  tokenEndpoint: "https://token.example/t", authorizeEndpoint: "https://authorize.example/a",
  redirectUri: `https://${DOMAIN}${MAIL_OAUTH_CALLBACK_PATH}`,
};

/**
 * YunoHost's _hydrate_app_template, for the constructs this page uses.
 *
 * DELIBERATELY NOT A JINJA ENGINE. It handles `{% if <name> <op> "<literal>" %}
 * ... {% endif %}` and nothing else, and the test below asserts the page
 * contains nothing else -- so an author reaching for a construct this cannot
 * reproduce gets a failure saying so, rather than a green run against a
 * rendering YunoHost would not produce. A faithful-looking simulation that is
 * quietly wrong would be worse than no test at all here.
 *
 * The `__VAR__` regex is transcribed from app_utils.py character for
 * character, INCLUDING the behaviour that matters most: a placeholder whose
 * setting does not exist is LEFT ALONE rather than emptied. That is what makes
 * a mistyped placeholder show up as literal `__PATH__` in the webadmin instead
 * of silently vanishing out of a URL.
 */
function hydrate(template: string, settings: Record<string, string>): string {
  let out = template;
  if (out.includes("{%")) {
    out = out.replace(
      /\{%\s*if\s+([a-z_]+)\s*(==|!=)\s*"([^"]*)"\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
      (_match, name: string, op: string, literal: string, body: string) => {
        const equal = settings[name] === literal;
        return (op === "==" ? equal : !equal) ? body : "";
      },
    );
  }
  return out.replace(/__[A-Z0-9]+?[A-Z0-9_]*?[A-Z0-9]*?__/g, (placeholder) => {
    // `.strip("_")` in the original; the leading and trailing runs, not every
    // underscore, which is why an instance name like conduit__2 survives.
    const name = placeholder.replace(/^_+|_+$/g, "").toLowerCase();
    const value = settings[name];
    return value === undefined ? placeholder : value;
  });
}

/**
 * The redirect URI THIS SERVER TELLS AN OPERATOR TO REGISTER, read out of the
 * sentence config.ts prints when it refuses a bad one.
 *
 * NOT REBUILT FROM MAIL_OAUTH_CALLBACK_PATH AND A JOIN RULE RETYPED HERE, which
 * was the first version and was worth nothing: it would have agreed with a
 * broken page and a broken server equally. Going through the real refusal means
 * the join rule -- `basePath === "/" ? "" : basePath`, the exact place the
 * doubled slash comes from -- is read from the code that implements it, so
 * changing that rule fails this test.
 */
function uriTheServerTellsYouToRegister(basePath: string): string {
  const refusal = (() => {
    try {
      parseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://conduit:pw@localhost/conduit",
        APP_VERSION: "1.7.0",
        BASE_PATH: basePath,
        // A URL that parses and is not this server's callback, so the check
        // under test is the one that reaches the sentence being read.
        MAIL_OAUTH_REDIRECT_URI: "https://example.invalid/not-the-callback",
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  expect(refusal, "config.ts must still refuse a URI that is not its callback").not.toBeNull();
  const match = /https:\/\/<this install's domain>(\S*)$/.exec(refusal as string);
  expect(match, `config.ts's refusal no longer quotes a path: ${refusal}`).not.toBeNull();
  return `https://${DOMAIN}${(match as RegExpExecArray)[1]}`;
}

describe("doc/ADMIN.md", () => {
  // THE INSTRUMENT, SHOWN FAILING before it is trusted to pass, exactly as the
  // sibling test's first case is: a truncated or half-written file would make
  // every `toContain` below a vacuous green.
  it("was actually read", () => {
    expect(doc.length).toBeGreaterThan(1500);
    expect(doc).toContain("## Mail sign-in with Microsoft 365 or Google");
    expect(doc).not.toContain("A STRING THAT IS NOT IN THE DOCUMENT");
  });

  /**
   * THE GUARD ON THE SIMULATION ITSELF. `hydrate` is honest only for as long as
   * the page stays inside what it reproduces, and the moment somebody adds a
   * `{{ ... }}` or a `{% for %}` this file would be checking a rendering
   * YunoHost does not produce. Fail there instead.
   */
  it("uses only the template constructs this test can faithfully reproduce", () => {
    expect(doc, "jinja interpolation is not simulated here").not.toContain("{{");
    expect(doc, "jinja comments are not simulated here").not.toContain("{#");
    expect(doc.match(/\{%[^%]*%\}/g)).toEqual(['{% if path != "/" %}', "{% endif %}"]);
  });

  /**
   * THE SUB-PATH INSTALL, which is this package's default (manifest.toml's
   * install.path defaults to /conduit) and the case the naive template gets
   * right.
   */
  it("shows the redirect URI this server accepts, at a sub-path install", () => {
    const rendered = hydrate(doc, INSTALLS["sub-path"]);
    const expected = uriTheServerTellsYouToRegister("/conduit");

    expect(expected).toBe(`https://${DOMAIN}/conduit${MAIL_OAUTH_CALLBACK_PATH}`);
    // EVERY absolute URL on this install's domain, not merely one of them: a
    // page that printed the right URI beside a wrong one would be worse than a
    // page that printed only the wrong one, because it looks like a choice.
    expect(rendered.match(new RegExp(`https://${DOMAIN}\\S*`, "g"))).toEqual([expected]);
    expect(redirectUriProblem(expected, MAIL_OAUTH_CALLBACK_PATH)).toBeNull();
  });

  /**
   * THE ROOT INSTALL, and the whole reason the page carries a conditional.
   * `path` is exactly "/" here (yunohost src/utils/form.py, WebPathOption.
   * normalize: `return "/" + value.strip().strip(" /")`), so the obvious
   * `__DOMAIN____PATH__` renders a doubled slash.
   *
   * redirectUriProblem CANNOT CATCH THAT ONE -- it checks the path as a suffix,
   * and "//api/mail/oauth/callback" ends with "/api/mail/oauth/callback" -- so
   * a server that booted happily would still fail at the provider's byte-for-
   * byte compare. Hence the explicit assertion on the doubled slash below,
   * rather than trusting the config check to notice.
   */
  it("shows the redirect URI this server accepts, at a root install", () => {
    const rendered = hydrate(doc, INSTALLS.root);
    const expected = uriTheServerTellsYouToRegister("/");

    expect(expected).toBe(`https://${DOMAIN}${MAIL_OAUTH_CALLBACK_PATH}`);
    expect(rendered.match(new RegExp(`https://${DOMAIN}\\S*`, "g"))).toEqual([expected]);
    expect(rendered, "a doubled slash is invisible and fails at the consent screen")
      .not.toContain(`https://${DOMAIN}//`);
    expect(redirectUriProblem(expected, MAIL_OAUTH_CALLBACK_PATH)).toBeNull();
  });

  /** Nothing may be left un-substituted in any install shape: a literal
   * `__DOMAIN__` on screen is a value an operator would paste, and a
   * placeholder whose setting does not exist is left exactly like that by
   * app_utils.py rather than emptied. */
  it("leaves no placeholder behind, in any install shape this package produces", () => {
    for (const [name, settings] of Object.entries(INSTALLS)) {
      expect(hydrate(doc, settings).match(/__[A-Z0-9_]+__/g), name).toBeNull();
    }
  });

  /** The literal this server registers the route at, named on the page so the
   * operator can recognise it in the URI above. */
  it("names the callback path this server actually serves", () => {
    expect(doc).toContain(MAIL_OAUTH_CALLBACK_PATH);
  });

  /**
   * Every setting the page tells them to write has to be a setting the server
   * reads, in the server's own spelling -- taken from the sentence it produces
   * when a registration is missing, so the two cannot diverge. Same derivation
   * as the sibling test, because a second list would be a second thing to keep
   * true.
   */
  it("names every setting, in the spelling the server's own refusal uses", () => {
    for (const provider of ["microsoft", "google"] as const) {
      const names = missingSettingsFor(provider)
        .split(/,| and /)
        .map((part) => part.trim())
        .filter((part) => part.startsWith("MAIL_OAUTH_"));
      for (const name of names) expect(doc, name).toContain(name);
    }
    // The halves that sentence abbreviates ("_CLIENT_SECRET"), spelled out in
    // full because an operator cannot paste an abbreviation into a file.
    for (const name of [
      "MAIL_OAUTH_MICROSOFT_CLIENT_SECRET", "MAIL_OAUTH_MICROSOFT_TENANT",
      "MAIL_OAUTH_GOOGLE_CLIENT_SECRET",
    ]) {
      expect(doc, name).toContain(name);
    }
  });

  /**
   * THE SCOPES, READ OUT OF THE AUTHORIZE URL THIS SERVER BUILDS, so what the
   * page tells them to grant is checked against what actually reaches the
   * consent screen. A grant that does not match is a consent screen that
   * refuses, or -- worse, on Microsoft -- a renewal scoped to the wrong
   * resource that IMAP rejects weeks later.
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

  /** Graph's permissions are the ones an operator reaches for by default and
   * they fail weeks later at an IMAP server, so naming the right ones is not
   * enough -- the page has to say the obvious ones are wrong. */
  it("says the permissions are Exchange's and not Graph's", () => {
    expect(doc).toContain("Office 365 Exchange Online");
    expect(doc).toContain("Graph");
  });

  /** Spec Risk 2, item 1: a SPA registration refuses a client secret and the
   * refusal arrives at the token endpoint, so the sign-in appears to work. */
  it("says the Azure platform must be Web rather than SPA", () => {
    expect(doc).toContain("must be Web, not SPA");
  });

  /**
   * Spec Risk 2, item 2, and THE PARAMETER RATHER THAN THE WORDS AROUND IT.
   * The sibling test learned this from mutation M49: a parameter misspelt
   * INSIDE the cmdlet left every keyword on the page intact while the line an
   * operator would paste had stopped working.
   */
  it("names the SMTP AUTH cmdlet correctly, because that failure looks like a Conduit bug", () => {
    expect(doc).toContain("Set-CASMailbox");
    expect(doc).toContain("-SmtpClientAuthenticationDisabled $false");
  });

  /** The Workspace/consumer fork, with Google's own figures. The operator
   * choosing the account and the operator creating the registration are often
   * the same person on different days, which is why it is on every surface. */
  it("states the Workspace/consumer fork with Google's own figures", () => {
    expect(doc).toContain("Internal");
    expect(doc).toContain("Testing");
    expect(doc).toContain("7 days");
    expect(doc).toContain("restricted");
    // Named as paid without inventing a price: the assessment is a third
    // party's and its cost is not Google's to publish.
    expect(doc).toContain("paid");
  });

  /**
   * THE UPGRADE TRAP, CHECKED AGAINST THE PACKAGING RATHER THAN AGAINST ITSELF.
   * The page's claim is that .env.oauth survives an upgrade and .env does not;
   * both halves are properties of scripts/, so both are read from scripts/.
   * A page asserting this on its own authority is a page that outlives the
   * arrangement it describes.
   */
  it("sends the settings to the file an upgrade keeps, not the one it rewrites", () => {
    expect(doc).toContain("__INSTALL_DIR__/.env.oauth");
    expect(doc).toContain("Not `.env`");

    // The half that creates it, and never overwrites it -- including the path,
    // so that "$install_dir/.env.oauth" and the page's __INSTALL_DIR__ cannot
    // come to mean two different files.
    expect(common).toContain("conduit_ensure_oauth_env()");
    expect(common).toContain('local target="$install_dir/.env.oauth"');
    // The half that preserves it across the source swap...
    expect(upgrade).toContain('--keep=".env .env.oauth"');
    // ...and the line that re-renders .env two steps later, which is precisely
    // why a hand-added value THERE disappears. Both halves, because the page's
    // claim is a contrast and half of it would be a different, wrong claim.
    expect(upgrade).toContain('ynh_config_add --template=".env"');
    expect(upgrade).not.toContain('ynh_config_add --template=".env.oauth"');
  });

  /**
   * THE UNIT AND THE DIRECTORY, WHICH ARE NOT `conduit` ON EVERY INSTALL.
   * manifest.toml declares multi_instance = true, so a second install is
   * `conduit__2` in both -- and a page that hard-coded the first would send an
   * operator to restart an app that is running perfectly well.
   */
  it("names this instance's own service and install directory", () => {
    expect(doc).toContain("systemctl restart __APP__");
    expect(doc).toContain("journalctl -u __APP__");

    const first = hydrate(doc, INSTALLS["sub-path"]);
    expect(first).toContain("/var/www/conduit/.env.oauth");
    expect(first).toContain("systemctl restart conduit");

    const second = hydrate(doc, INSTALLS["second instance"]);
    expect(second).toContain("/var/www/conduit__2/.env.oauth");
    expect(second).toContain("systemctl restart conduit__2");
    // The closing backtick is the discriminator: `conduit` and `conduit__2`
    // share a prefix, so only the end of the inline-code span can tell a page
    // that named the right unit from one that named the first instance's.
    expect(second, "the first instance's unit must not appear on the second's page")
      .not.toContain("systemctl restart conduit`");
  });

  /** The short page is a route into the long one, not a replacement for it.
   * The pointer is checked against the file so it cannot outlive it. */
  it("points at the long guide, and the long guide is still there", async () => {
    expect(doc).toContain("docs/mail-oauth-setup.md");
    const guide = await readFile(path.join(REPO, "docs", "mail-oauth-setup.md"), "utf8");
    expect(guide).toContain("# Signing a mailbox in with Microsoft or Google");
  });

  /** The honest half, as on the long guide: nothing here has met a real
   * provider, and a page that implied otherwise would be its most expensive
   * sentence. */
  it("says plainly that none of it was tested against a real provider", () => {
    expect(doc).toContain("has not been tested against a real Microsoft or Google");
  });
});

/**
 * doc/DESCRIPTION.md, which has ONE property worth a test and it is not its
 * prose.
 *
 * IT IS THE ONE DOC PAGE SHOWN BEFORE THE APP IS INSTALLED, and at that moment
 * there are no settings to substitute from: app.py's app_manifest() reads the
 * doc folder and returns it WITHOUT calling _hydrate_app_template, which only
 * app_info() -- an installed app -- does. So a `__DOMAIN__` here would render
 * as those literal characters in the install form, and then silently start
 * working after installation, which is the shape of bug nobody reproduces.
 *
 * The rest of the file is claims about the product rather than about the code,
 * and pinning prose to nothing would be theatre. What is checked is that it
 * exists at all -- without it the app's info page falls back to manifest.toml's
 * one-line description (yunohost-admin AppInfo.vue: `formatI18nField(DESCRIPTION)
 * || app_.description`) -- and that it sends the reader to the page above rather
 * than repeating it.
 */
describe("doc/DESCRIPTION.md", () => {
  it("carries no placeholder, because nothing substitutes one before install", () => {
    expect(description.length).toBeGreaterThan(200);
    expect(description.match(/__[A-Z0-9_]+__/g)).toBeNull();
  });

  it("says a provider sign-in needs a registration, and points at the admin page", () => {
    expect(description).toContain("app registration");
    expect(description).toContain("admin documentation");
  });
});
