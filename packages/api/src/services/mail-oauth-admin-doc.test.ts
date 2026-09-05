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
const notification = await readFile(path.join(REPO, "doc", "POST_INSTALL.md"), "utf8");
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
 * doc/POST_INSTALL.md, WHICH IS A NOTIFICATION RATHER THAN A DOC PAGE, and
 * YunoHost does not treat the two alike. Verified in yunohost's own source at
 * tag debian/12.1.17 -- the minimum this package's manifest declares:
 *
 *   app_utils.py _parse_app_doc_and_notifications: one function, two loops.
 *     The doc-page loop matches `([A-Z]*)(_[a-z]{2,3})?.md`, whose first group
 *     CANNOT CONTAIN AN UNDERSCORE, so "POST_INSTALL.md" does not match it at
 *     all and is dropped by `if not m: continue` -- not, as it first looks, by
 *     the `if pagename in notification_names: continue` two lines below, which
 *     no underscored name can ever reach. The notification loop then picks the
 *     file up on its own terms, `re.match("POST_INSTALL" + "(_[a-z]{2,3})?.md")`
 *     over `glob("POST_INSTALL*.md")`. So this file can never appear as an Admin
 *     doc tab, and its name has to be exactly that: `post_install.md` matches
 *     NEITHER loop and is dropped in silence, leaving an install that shows
 *     nothing and says nothing about why.
 *   app.py app_install (the block after `installation_complete`): `settings =
 *     _get_app_settings(app_instance_name)`, then
 *     `_filter_and_hydrate_notifications(manifest["notifications"]
 *     ["POST_INSTALL"], data=settings)` -- which calls the SAME
 *     _hydrate_app_template that doc pages go through, with settings from the
 *     same function (the one injecting `settings["app"] = app`). Jinja and
 *     __VAR__ substitution therefore behave here exactly as they do in
 *     ADMIN.md, and `hydrate` above is as faithful for this file as for that
 *     one. An empty render is dropped rather than shown blank.
 *
 * WHERE IT IS SHOWN, which is what its shape has to answer to. Three surfaces,
 * not one:
 *   - the webadmin, immediately after the install, as a modal that cannot be
 *     cancelled -- yunohost-admin AppInstall.vue passes the hydrated text to
 *     modalConfirm with `{ markdown: true, cancelable: false }`, under a title
 *     of its own ("Post-install notifications for '<app>'");
 *   - that app's info page for the following seven days, as a dismissible alert
 *     under an h2 of its own (AppInfo.vue), until somebody presses Understood
 *     or _notification_is_dismissed retires it on install_time + 7 days;
 *   - and `yunohost app install` at a terminal, where _display_notifications
 *     PRINTS THE MARKDOWN RAW between two rules and blocks on a confirmation.
 *
 * That last surface is the difference from ADMIN.md that shapes this file.
 * ADMIN.md is only ever rendered; this one is also read as characters, so
 * anything that means nothing until it is rendered is noise to whoever installs
 * from a terminal -- and both rendered surfaces supply a heading already, so
 * one here would sit under a title as a second title.
 *
 * SHOWDOWN AT GITHUB FLAVOUR, which is a property of the renderer and not of
 * taste: yunohost-admin's main.ts registers VueShowdownPlugin with
 * `flavor: "github"`, so simpleLineBreaks turns every hard wrap into a <br> and
 * ghMentions turns a bare @something into a link to github.com/something. Hence
 * the shape test below, which is the same reason ADMIN.md is written unwrapped.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY IS THE REDIRECT URI, and that is the
 * choice most worth defending. The URI is compared byte for byte at the
 * provider, it already has a home on the page this file points at, and a second
 * copy would be a second thing to keep right -- including the doubled slash a
 * root install produces, which the tests above exist to catch in one place. A
 * notification is read once; the page it points at is read with a provider
 * console open. So this one is a signpost, and the test below is what stops it
 * growing into a second copy of the page.
 */
describe("doc/POST_INSTALL.md", () => {
  // THE INSTRUMENT, shown failing before the assertions below are trusted.
  it("was actually read", () => {
    expect(notification.length).toBeGreaterThan(300);
    expect(notification).not.toContain("A STRING THAT IS NOT IN THE DOCUMENT");
  });

  /**
   * BREVITY IS THE FEATURE, so it is the thing under test.
   *
   * This is shown at the one moment an operator is certainly looking, in a
   * modal they must dismiss to continue. A notification nobody finishes is
   * worse than a short one, because it spends that moment and returns nothing.
   * ADMIN.md is where length belongs; it is sixteen times this file.
   *
   * TWO CLAUSES BECAUSE THERE ARE TWO WAYS TO GROW. The paragraph count is the
   * sharper half and is pinned exactly: anything appended fails here rather
   * than in somebody's modal. The character bound is what catches a paragraph
   * swelling in place instead, and it is an editorial line drawn on purpose --
   * 700 against the 555 written, so a short clarification fits and another
   * explanation does not.
   *
   * BOTH EARLIER DRAFTS OF THAT NUMBER WERE MUTATION-TESTED AND BOTH FAILED THE
   * TEST: at 1200 and then at 800, a paragraph with one more explaining
   * sentence bolted on -- the exact way this file will be asked to grow --
   * passed unnoticed. A bound nothing can exceed is not a bound.
   */
  it("stays short enough to be read at the one moment somebody is looking", () => {
    expect(notification.trim().split(/\n{2,}/)).toHaveLength(3);
    expect(notification.length).toBeLessThan(700);
  });

  /**
   * THE TWO WAYS GITHUB-FLAVOURED SHOWDOWN REWRITES ORDINARY PROSE.
   * simpleLineBreaks makes a <br> of every hard wrap, so a wrapped paragraph
   * renders as a ragged column; ghMentions makes `github.com/gmail.com` of a
   * bare `@gmail.com`, which is a link to a stranger's account printed in an
   * administrator's console. Neither shows up in the source.
   */
  it("survives github-flavoured showdown: unwrapped paragraphs, no bare mention", () => {
    const lines = notification.trim().split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      expect(lines[index + 1] ?? "", `line ${index + 1} is hard-wrapped into the next`)
        .toBe("");
    }
    // Inline code spans removed first, because a backticked address is exactly
    // how ADMIN.md defuses this and is allowed here too.
    expect(notification.replace(/`[^`]*`/g, ""), "a bare @ becomes a github.com link")
      .not.toContain("@");
  });

  /**
   * NO HEADING OF ITS OWN. Both webadmin surfaces put this text under a heading
   * they supply, and shift any heading in it down to h3 or h4 to sit beneath
   * theirs; the CLI prints the `#` characters. A title here is redundant twice
   * and noise once.
   */
  it("carries no heading, because every surface that shows it supplies one", () => {
    expect(notification.match(/^#{1,6} .*/m)).toBeNull();
  });

  /**
   * THE TWO CLAIMS IT EXISTS TO MAKE, in the words the other two surfaces use.
   * The operator meeting this notification, the one reading DESCRIPTION.md
   * before installing and the one reading ADMIN.md afterwards are the same
   * person on three different days, and "app registration" is the phrase they
   * have to recognise as the same thing each time.
   */
  it("says the password case needs nothing, and names the two providers that do", () => {
    expect(notification).toContain("password");
    expect(notification).toContain("Microsoft 365");
    expect(notification).toContain("Google Workspace");
    for (const surface of [notification, doc, description]) {
      expect(surface, "all three surfaces name the same thing").toContain("app registration");
    }
    // Who has to make it, which is the half that decides whether the reader can
    // act at all: on most installs it is somebody else, in somebody else's
    // console, and finding that out later is the wasted afternoon.
    expect(notification).toContain("administrator");
  });

  /**
   * THE SIGNPOST, CHECKED AGAINST WHAT IT PROMISES IS THERE. This file's whole
   * job is to send the reader somewhere else, so the test is not that it says
   * so -- it is that the page it names still carries both things it promises:
   * the steps, and this install's own redirect URI.
   */
  it("points at the admin page, and that page still has the steps and the URI", () => {
    expect(notification).toContain("webadmin");
    expect(notification).toContain("redirect URI");
    expect(doc).toContain("It needs a one-time app registration");
    expect(doc).toContain(MAIL_OAUTH_CALLBACK_PATH);
    expect(doc).toContain("__DOMAIN__");
  });

  /**
   * NO URL OF ITS OWN, IN ANY INSTALL SHAPE. The doubled-slash trap the tests
   * above exist for is a trap only for a file that prints a URL; the cheapest
   * way not to fall in it twice is to have one place that prints one. This
   * fails the moment somebody helpfully pastes the URI in here.
   */
  it("prints no URL of its own, in any install shape this package produces", () => {
    for (const [name, settings] of Object.entries(INSTALLS)) {
      expect(hydrate(notification, settings).match(/https?:\/\/\S+/g), name).toBeNull();
    }
  });

  /** The same two guards the page above carries, for the same reasons: a
   * construct `hydrate` cannot reproduce would make every assertion here a
   * check on a rendering YunoHost does not produce, and a placeholder whose
   * setting does not exist is left on screen verbatim rather than emptied. */
  it("uses only reproducible constructs, and leaves no placeholder behind", () => {
    expect(notification).not.toContain("{{");
    expect(notification).not.toContain("{#");
    for (const [name, settings] of Object.entries(INSTALLS)) {
      expect(hydrate(notification, settings).match(/__[A-Z0-9_]+__/g), name).toBeNull();
    }
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
