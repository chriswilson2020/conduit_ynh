import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { MailAccount } from "@conduit/shared";
import { withoutComments } from "../test/source";
import {
  accountReauthMessage,
  accountStatusLabel,
  buildCreateInput,
  buildTestInput,
  buildUpdatePatch,
  dovecotPreset,
  folderCommandReasons,
  folderDeleteBlocked,
  folderDeleteWarning,
  folderRenameBlocked,
  buildOAuthSigninInput,
  buildOAuthUpdatePatch,
  buildReauthorizeInput,
  initialFormState,
  initialOAuthFormState,
  isPort,
  providerLabel,
  settingsFields,
  signedInWith,
  signinBanner,
  validateForm,
  validateOAuthForm,
  type AccountFormState,
} from "./settings-mail-lib";

const storedAccount: MailAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  label: "Work",
  email: "chris@example.com",
  imapHost: "mail.example.com", imapPort: 993, imapSecurity: "tls",
  smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris",
  sentFolder: "Sent",
  trashFolder: null,
  archiveFolder: null,
  signatureHtml: null,
  backfillDays: 90,
  visibility: "private",
  authMethod: "password",
  status: "active",
  lastError: null,
  lastSyncedAt: null,
  archivedAt: null,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

function filled(overrides: Partial<AccountFormState> = {}): AccountFormState {
  return {
    ...initialFormState(),
    label: "Work", email: "chris@example.com",
    imapHost: "mail.example.com", smtpHost: "mail.example.com",
    username: "chris", password: "hunter2",
    ...overrides,
  };
}

describe("isPort", () => {
  it("accepts an ordinary port", () => {
    expect(isPort("993")).toBe(true);
  });

  it("rejects zero, a negative, and anything past 65535", () => {
    expect(isPort("0")).toBe(false);
    expect(isPort("-1")).toBe(false);
    expect(isPort("65536")).toBe(false);
  });

  it("rejects a non-integer or non-numeric value", () => {
    expect(isPort("99.3")).toBe(false);
    expect(isPort("")).toBe(false);
    expect(isPort("993abc")).toBe(false);
  });
});

describe("initialFormState", () => {
  it("starts a new account on the common defaults", () => {
    const state = initialFormState();
    expect(state).toMatchObject({
      imapPort: "993", imapSecurity: "tls", smtpPort: "587", smtpSecurity: "starttls",
      sentFolder: "Sent", backfill: "90", smtpDiffers: false,
    });
  });

  it("mirrors a stored account, with BOTH password fields blank", () => {
    const state = initialFormState(storedAccount);
    expect(state).toMatchObject({
      label: "Work", email: "chris@example.com",
      imapHost: "mail.example.com", imapPort: "993", smtpPort: "587", username: "chris",
      backfill: "90",
    });
    // Blank is the whole point: it means "keep the stored password", and a
    // stored credential is never sent to a client to pre-fill from.
    expect(state.password).toBe("");
    expect(state.smtpPassword).toBe("");
    expect(state.smtpDiffers).toBe(false);
  });

  it("shows a null backfill window as 'all'", () => {
    expect(initialFormState({ ...storedAccount, backfillDays: null }).backfill).toBe("all");
  });
});

describe("dovecotPreset", () => {
  it("fills the local host/port/security set and the signed-in username", () => {
    expect(dovecotPreset(initialFormState(), "chris")).toMatchObject({
      imapHost: "localhost", imapPort: "993", imapSecurity: "tls",
      smtpHost: "localhost", smtpPort: "587", smtpSecurity: "starttls",
      username: "chris",
    });
  });

  it("keeps whatever username is typed when the session has none", () => {
    expect(dovecotPreset(filled({ username: "typed" }), undefined).username).toBe("typed");
  });

  it("leaves the label and email alone", () => {
    const state = dovecotPreset(filled({ label: "Mine", email: "me@example.com" }), "chris");
    expect(state.label).toBe("Mine");
    expect(state.email).toBe("me@example.com");
  });
});

describe("validateForm", () => {
  it("accepts a complete create form", () => {
    expect(validateForm(filled(), false)).toBeNull();
  });

  it("accepts an edit form with both password fields blank", () => {
    expect(validateForm(filled({ password: "" }), true)).toBeNull();
  });

  it("requires a password on create", () => {
    expect(validateForm(filled({ password: "" }), false)).toBe("A password is required.");
  });

  it("requires a label, an email, hosts and a username", () => {
    expect(validateForm(filled({ label: " " }), false)).toBe("A label is required.");
    expect(validateForm(filled({ email: "" }), false)).toBe("An email address is required.");
    expect(validateForm(filled({ imapHost: "" }), false)).toBe("IMAP and SMTP hosts are required.");
    expect(validateForm(filled({ username: "" }), false)).toBe("A username is required.");
  });

  it("rejects a malformed port", () => {
    expect(validateForm(filled({ smtpPort: "nope" }), false))
      .toBe("Ports must be whole numbers between 1 and 65535.");
  });

  // Half a pair is the one submission the server's convention cannot express.
  it("rejects half a pair when SMTP differs is on, on create", () => {
    expect(validateForm(filled({ smtpDiffers: true, smtpPassword: "" }), false))
      .toBe("Enter both the IMAP and the SMTP password.");
  });

  it("rejects half a pair when SMTP differs is on, on edit", () => {
    expect(validateForm(filled({ smtpDiffers: true, password: "hunter2", smtpPassword: "" }), true))
      .toMatch(/^With separate SMTP credentials/);
  });

  it("accepts both blank on edit with SMTP differs on (keep both stored)", () => {
    expect(validateForm(filled({ smtpDiffers: true, password: "", smtpPassword: "" }), true)).toBeNull();
  });
});

describe("settingsFields", () => {
  it("trims text, numbers the ports, and defaults an empty sent folder", () => {
    expect(settingsFields(filled({
      label: " Work ", email: " chris@example.com ", imapHost: " mail.example.com ",
      sentFolder: "  ", imapPort: "143", smtpPort: "25",
    }))).toMatchObject({
      label: "Work", email: "chris@example.com", imapHost: "mail.example.com",
      sentFolder: "Sent", imapPort: 143, smtpPort: 25,
    });
  });

  it("maps the 'all' backfill window to null, not a number", () => {
    expect(settingsFields(filled({ backfill: "all" })).backfillDays).toBeNull();
    expect(settingsFields(filled({ backfill: "30" })).backfillDays).toBe(30);
  });
});

/**
 * The four password-convention submission shapes (see settings-mail-lib's
 * header comment, and mail-accounts.ts's updateAccount server-side). A blank
 * field is OMITTED, never sent as "" -- the create/test schemas hold
 * passwords to `.min(1)`.
 */
describe("password convention", () => {
  it("shape 1: create with SMTP differs OFF sends `password` alone", () => {
    const input = buildCreateInput(filled({ smtpDiffers: false, password: "hunter2", smtpPassword: "ignored" }));
    expect(input.password).toBe("hunter2");
    expect("smtpPassword" in input).toBe(false);
  });

  it("shape 2: create with SMTP differs ON sends both halves", () => {
    const input = buildCreateInput(filled({ smtpDiffers: true, password: "imap-pw", smtpPassword: "smtp-pw" }));
    expect(input.password).toBe("imap-pw");
    expect(input.smtpPassword).toBe("smtp-pw");
  });

  it("shape 3: edit with both fields blank sends NEITHER key", () => {
    const patch = buildUpdatePatch(filled({ password: "", smtpPassword: "" }));
    expect("password" in patch).toBe(false);
    expect("smtpPassword" in patch).toBe(false);
    // The settings half still goes, so the no-op is only about credentials.
    expect(patch.label).toBe("Work");
  });

  it("shape 4: edit with a lone password sends `password` alone (both halves)", () => {
    const patch = buildUpdatePatch(filled({ smtpDiffers: false, password: "new-pw" }));
    expect(patch.password).toBe("new-pw");
    expect("smtpPassword" in patch).toBe(false);
  });

  it("edit with SMTP differs ON and both filled sends both", () => {
    const patch = buildUpdatePatch(filled({ smtpDiffers: true, password: "imap-pw", smtpPassword: "smtp-pw" }));
    expect(patch.password).toBe("imap-pw");
    expect(patch.smtpPassword).toBe("smtp-pw");
  });

  it("edit with SMTP differs ON but a blank smtp half never sends an empty string", () => {
    // validateForm rejects this combination before it can be submitted; this
    // pins that the builder would not manufacture a "" either.
    const patch = buildUpdatePatch(filled({ smtpDiffers: true, password: "imap-pw", smtpPassword: "" }));
    expect("smtpPassword" in patch).toBe(false);
  });
});

describe("buildTestInput", () => {
  it("tests a stored account by id, with no password keys when the fields are blank", () => {
    const input = buildTestInput(initialFormState(storedAccount), storedAccount.id);
    expect(input.accountId).toBe(storedAccount.id);
    expect(input).toMatchObject({
      imapHost: "mail.example.com", imapPort: 993, imapSecurity: "tls",
      smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls", username: "chris",
    });
    // Absent, not "": an omitted password is exactly what makes the server
    // fall back to the stored credentials.
    expect("password" in input).toBe(false);
    expect("smtpPassword" in input).toBe(false);
  });

  it("sends a typed password as an override on a stored account", () => {
    const withPassword = buildTestInput(filled({ password: "typed" }), storedAccount.id);
    expect(withPassword.password).toBe("typed");
  });

  it("sends a self-sufficient body for an account that does not exist yet", () => {
    const input = buildTestInput(filled({ password: "hunter2" }));
    expect("accountId" in input).toBe(false);
    expect(input.password).toBe("hunter2");
    expect(input.username).toBe("chris");
  });
});

describe("folder command gating", () => {
  const fresh = { stale: false };
  const account = { sentFolder: "Sent", trashFolder: "Bin", archiveFolder: "Filed" };
  const folder = (name: string, selectable = true) =>
    ({ folder: name, locked: false, selectable });

  describe("folderRenameBlocked", () => {
    it("allows an ordinary folder, and the account's own move targets", () => {
      expect(folderRenameBlocked(folder("Projects"), fresh)).toBeNull();
      // Sent, Trash and Archive are renameable: the server-side rename rewrites
      // the account columns that name them, in the same transaction, so the
      // account follows its folder rather than breaking.
      expect(folderRenameBlocked({ ...folder("Sent"), locked: true }, fresh)).toBeNull();
      expect(folderRenameBlocked(folder("Bin"), fresh)).toBeNull();
      expect(folderRenameBlocked(folder("Filed"), fresh)).toBeNull();
    });

    it("refuses INBOX whatever case it is spelled in", () => {
      expect(folderRenameBlocked(folder("INBOX"), fresh)).toMatch(/cannot be renamed/);
      // RFC 3501 makes INBOX the one case-insensitive mailbox name, so a server
      // that listed it lower-case is still the same mailbox.
      expect(folderRenameBlocked(folder("inbox"), fresh)).toMatch(/cannot be renamed/);
    });

    it("refuses a hierarchy node and a folder the last sync did not find", () => {
      expect(folderRenameBlocked(folder("Lists", false), fresh)).toMatch(/hierarchy node/);
      expect(folderRenameBlocked(folder("Gone"), { stale: true }))
        .toMatch(/did not find this folder on the server/);
    });
  });

  describe("folderCommandReasons", () => {
    it("says nothing at all for a folder both commands accept", () => {
      expect(folderCommandReasons(folder("Projects"), account, fresh)).toEqual([]);
    });

    it("DEDUPES the two refusals the commands share word for word", () => {
      // A hierarchy node and a vanished folder block both commands for one
      // reason each, and printing the same sentence twice reads as a bug.
      expect(folderCommandReasons(folder("Lists", false), account, fresh)).toHaveLength(1);
      expect(folderCommandReasons(folder("Gone"), account, { stale: true })).toHaveLength(1);
    });

    it("keeps two genuinely different reasons apart", () => {
      // INBOX refuses each command for its own reason, and both are true.
      const inbox = folderCommandReasons(folder("INBOX"), account, fresh);
      expect(inbox).toHaveLength(2);
      expect(inbox[0]).toMatch(/renamed/);
      expect(inbox[1]).toMatch(/deleted/);
    });

    it("gives a move target the one reason that applies to it", () => {
      // Sent can be RENAMED -- the server-side rename rewrites sent_folder with
      // it -- so the only sentence is delete's, and it names the fix.
      expect(folderCommandReasons({ ...folder("Sent"), locked: true }, account, fresh))
        .toEqual(["This is the account's Sent folder. Point Sent at another folder below first."]);
    });
  });

  describe("folderDeleteBlocked", () => {
    it("allows an ordinary folder", () => {
      expect(folderDeleteBlocked(folder("Projects"), account, fresh)).toBeNull();
    });

    it("refuses INBOX and each of the account's three move targets by NAME", () => {
      expect(folderDeleteBlocked(folder("INBOX"), account, fresh)).toMatch(/cannot be deleted/);
      // By name rather than by special_use, exactly as the server refuses it: a
      // folder can be the Archive target without carrying \Archive, and it is
      // the account COLUMN that would break.
      expect(folderDeleteBlocked(folder("Sent"), account, fresh)).toMatch(/account's Sent folder/);
      expect(folderDeleteBlocked(folder("Bin"), account, fresh)).toMatch(/account's Trash folder/);
      expect(folderDeleteBlocked(folder("Filed"), account, fresh)).toMatch(/account's Archive folder/);
    });

    it("tolerates the stored whitespace the server side trims around", () => {
      const padded = { sentFolder: " Sent ", trashFolder: " Bin ", archiveFolder: null };
      expect(folderDeleteBlocked(folder("Sent"), padded, fresh)).toMatch(/Sent folder/);
      expect(folderDeleteBlocked(folder("Bin"), padded, fresh)).toMatch(/Trash folder/);
      // A null target names no folder, so nothing is refused for being it.
      expect(folderDeleteBlocked(folder("Filed"), padded, fresh)).toBeNull();
    });

    it("refuses a hierarchy node and a folder the last sync did not find", () => {
      expect(folderDeleteBlocked(folder("Lists", false), account, fresh)).toMatch(/hierarchy node/);
      expect(folderDeleteBlocked(folder("Gone"), account, { stale: true }))
        .toMatch(/did not find this folder on the server/);
    });
  });

  describe("folderDeleteWarning", () => {
    it("says what leaves, what stays, and what is refused -- before it happens", () => {
      const lines = folderDeleteWarning("Projects");
      expect(lines[0]).toContain('"Projects" is removed from the mail server');
      // The promise this product makes everywhere, said where it matters most.
      expect(lines[1]).toMatch(/KEPT/);
      expect(lines[1]).toMatch(/still on the records/);
      expect(lines[2]).toMatch(/Conduit does not delete mail/);
      // No count: Conduit knows only what it has synced, and quoting that here
      // would understate a folder whose sync is off by however much it has
      // never seen. The server's real count arrives in the refusal.
      expect(lines.join(" ")).not.toMatch(/\d/);
    });
  });
});

// --- The account's state, as a row shows it (Phase 8 Task 2) -----------------

describe("accountStatusLabel", () => {
  /**
   * THE WHOLE POINT OF THE THIRD STATE IS THESE THREE WORDS. "Error" is a
   * description of the server's mood and invites waiting; a lapsed OAuth grant
   * never clears on its own, so the badge has to name the action instead. An
   * implementation that folded this into "Error" would pass every other test in
   * this repo and still produce the failure the spec's Risk 3 describes.
   */
  it("tells an operator what to DO when a grant has lapsed", () => {
    expect(accountStatusLabel("auth_required", false)).toBe("Sign in again");
  });

  it("leaves the two pre-existing states alone", () => {
    expect(accountStatusLabel("active", false)).toBe("Active");
    expect(accountStatusLabel("error", false)).toBe("Error");
  });

  /** Archiving stops syncing, so whatever the loop last thought is history --
   * and an archived row must not nag about a sign-in it no longer needs. */
  it("says Archived regardless of the status underneath", () => {
    expect(accountStatusLabel("auth_required", true)).toBe("Archived");
    expect(accountStatusLabel("error", true)).toBe("Archived");
  });
});

describe("accountReauthMessage", () => {
  it("names the provider, because signing in again is a different errand at each", () => {
    expect(accountReauthMessage("auth_required", "oauth_microsoft")).toContain("Microsoft");
    expect(accountReauthMessage("auth_required", "oauth_google")).toContain("Google");
  });

  it("says what to do and what it fixes", () => {
    const message = accountReauthMessage("auth_required", "oauth_microsoft") ?? "";
    expect(message).toContain("Sign in again");
    expect(message).toContain("syncing");
  });

  /** Silent for every other state: an account in ordinary error already shows
   * last_error, and two alerts on one row read as two problems. */
  it("says nothing for an account that is not in that state", () => {
    expect(accountReauthMessage("active", "oauth_microsoft")).toBeNull();
    expect(accountReauthMessage("error", "oauth_microsoft")).toBeNull();
  });

  /** Unreachable -- a password account has no grant to lapse -- but a row that
   * somehow got there must still say something true and actionable rather than
   * throwing on the settings page. */
  it("still says something useful for a password account", () => {
    expect(accountReauthMessage("auth_required", "password")).toContain("signed in");
  });
});

// --- Phase 8 Task 3: the form's second path ---------------------------------

describe("the OAuth form", () => {
  const empty = initialOAuthFormState();

  it("starts empty for a new account, with the ordinary backfill default", () => {
    expect(empty).toEqual({ label: "", email: "", sentFolder: "", backfill: "90" });
  });

  it("starts an edit from the stored account, including the folder the server chose", () => {
    const account = {
      ...storedAccount, label: "Work", email: "chris@contoso.example",
      sentFolder: "Sent Items", backfillDays: 30,
    };
    expect(initialOAuthFormState(account))
      .toEqual({ label: "Work", email: "chris@contoso.example", sentFolder: "Sent Items", backfill: "30" });
  });

  it("reads a null backfill as Everything, like the password form does", () => {
    expect(initialOAuthFormState({ ...storedAccount, backfillDays: null }).backfill).toBe("all");
  });

  it("requires a label and an address to create", () => {
    expect(validateOAuthForm(empty, false)).toContain("label");
    // AN EMPTY FIELD AND A MALFORMED ONE GET DIFFERENT SENTENCES, and the
    // distinction is asserted rather than assumed. A mutation deleting the
    // empty-string check survived at first: "" contains no "@" either, so the
    // second branch caught it and the suite could not tell the two apart --
    // which would have quietly replaced "you have not filled this in" with
    // "what you typed is wrong" for the commonest mistake on the form.
    expect(validateOAuthForm({ ...empty, label: "Work" }, false))
      .toBe("The mailbox address is required.");
    expect(validateOAuthForm({ ...empty, label: "Work", email: "not-an-address" }, false))
      .toBe("Enter the full mailbox address.");
    expect(validateOAuthForm({ ...empty, label: "Work", email: "a@b.example" }, false)).toBeNull();
  });

  it("does not ask an EDIT for an address, because the address cannot be changed", () => {
    // The address is the mailbox the grant was issued for and the username
    // XOAUTH2 authenticates as; the control is disabled and the patch omits it.
    expect(validateOAuthForm({ ...empty, label: "Work" }, true)).toBeNull();
  });

  it("sends the provider, the label, the address and the backfill -- and nothing else", () => {
    // THE ABSENCES ARE THE ASSERTION, and they are the spec's second path in as
    // many words: no host, no port, no security, no username, no password.
    const input = buildOAuthSigninInput(
      { label: " Work ", email: " chris@contoso.example ", sentFolder: "", backfill: "30" },
      "microsoft",
    );
    expect(input).toEqual({
      provider: "microsoft", label: "Work", email: "chris@contoso.example", backfillDays: 30,
    });
    expect(Object.keys(input).sort()).toEqual(["backfillDays", "email", "label", "provider"]);
  });

  it("sends Everything as a null backfill, not as the string", () => {
    expect(buildOAuthSigninInput({ ...empty, label: "W", email: "a@b.example", backfill: "all" }, "google"))
      .toMatchObject({ backfillDays: null, provider: "google" });
  });

  it("re-authorising sends the account and the provider, and no mailbox address", () => {
    // The address comes from the stored row server-side; taking the client's
    // word for it would let one request's login hint be pointed at somebody
    // else's mailbox.
    expect(buildReauthorizeInput("acc-1", "microsoft"))
      .toEqual({ accountId: "acc-1", provider: "microsoft" });
  });

  it("patches the three fields that are still this install's business", () => {
    const patch = buildOAuthUpdatePatch({
      label: " Work ", email: "chris@contoso.example", sentFolder: " Sent Items ", backfill: "all",
    });
    expect(patch).toEqual({ label: "Work", sentFolder: "Sent Items", backfillDays: null });
    // No password half (the server answers 409 to one), no host/port/security
    // (they are the provider's), no email (see above).
    for (const forbidden of ["password", "smtpPassword", "imapHost", "imapPort", "username", "email"]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });
});

describe("signedInWith and providerLabel", () => {
  it("names the provider for an OAuth account and says nothing for a password one", () => {
    expect(signedInWith("oauth_microsoft")).toBe("Signed in with Microsoft");
    expect(signedInWith("oauth_google")).toBe("Signed in with Google");
    // Rendering nothing rather than "Signed in with a password": the password
    // row already shows a username and a host, which is the same fact.
    expect(signedInWith("password")).toBeNull();
  });

  it("spells each provider once", () => {
    expect(providerLabel("microsoft")).toBe("Microsoft");
    expect(providerLabel("google")).toBe("Google");
  });
});

describe("signinBanner", () => {
  it("says nothing when the page was not reached from a callback", () => {
    expect(signinBanner({})).toBeNull();
    expect(signinBanner({ reason: "state" })).toBeNull();
  });

  it("congratulates a connection and says the sync starts by itself", () => {
    const banner = signinBanner({ oauth: "connected" });
    expect(banner?.tone).toBe("ok");
    expect(banner?.text).toContain("connected");
  });

  it("gives each failure its own sentence", () => {
    const texts = new Set<string>();
    for (const reason of ["state", "denied", "provider", "no_refresh_token", "duplicate", "account", "failed"]) {
      const banner = signinBanner({ oauth: "failed", reason });
      expect(banner?.tone, reason).toBe("error");
      texts.add(banner!.text);
    }
    // Seven reasons, seven sentences: an operator who is told the same thing
    // for a declined consent and a broken app registration has been told
    // nothing.
    expect(texts.size).toBe(7);
  });

  it("does not accuse anybody of an attack over an expired state", () => {
    // The overwhelming majority of these are a timeout or a second tab, and an
    // alarming sentence for a routine one teaches an operator to ignore it.
    const text = signinBanner({ oauth: "failed", reason: "state" })!.text;
    // It still has to say what to do, or it is a dead end dressed as calm.
    expect(text).toContain("Start it again");
    expect(text.toLowerCase()).not.toContain("attack");
  });

  it("still says something true for a reason it does not recognise", () => {
    // A client and a server that disagree about the code set is a thing that
    // happens across an upgrade.
    const banner = signinBanner({ oauth: "failed", reason: "something-new" });
    expect(banner?.tone).toBe("error");
    expect(banner?.text).toContain("did not complete");
  });

  it("carries no provider prose, because the redirect it reads never carries any", () => {
    // The server sends a CODE; a provider's error_description would otherwise
    // ride a URL into a history entry and nginx's access log.
    const banner = signinBanner({ oauth: "failed", reason: "AADSTS50011: the reply URL does not match" });
    expect(banner?.text).not.toContain("AADSTS");
  });
});

describe("the OAuth form's source", () => {
  /**
   * A SOURCE GUARD, because the rule lives in JSX and this package has no
   * testing-library. The spec's requirement is that an OAuth account asks for
   * no host, port, security or password -- an absence, which no behavioural
   * assertion in this file can see, and which a well-meaning edit adding "just
   * the port, for a proxy" would break silently.
   */
  it("asks for no host, port, security, username or password", () => {
    const source = withoutComments(
      readFileSync(new URL("./settings-mail.tsx", import.meta.url), "utf8"),
    );
    const form = source.slice(
      source.indexOf("function OAuthAccountForm("),
      source.indexOf("function BackfillSelect("),
    );
    // The slice really found the function: an indexOf that missed would make
    // every assertion below vacuously true against an empty string.
    expect(form.length).toBeGreaterThan(500);
    // FIELD SPELLINGS, NOT THE WORD "password". The form's own copy says
    // "Conduit never sees the password", which is the sentence that makes the
    // absence legible to the operator -- banning the word would ban the
    // explanation. What must not be here is a CONTROL.
    for (const control of [
      "imapHost", "imapPort", "smtpHost", "smtpPort", "SecuritySelect", "smtpDiffers",
      'type="password"',
    ]) {
      expect(form, control).not.toContain(control);
    }
  });

  /** The other half, and the one the spec is most insistent about: the
   * password path is UNTOUCHED. A self-hosted IMAP server with a password is
   * still the common case on this install. */
  it("leaves the password form asking for all of them", () => {
    const source = withoutComments(
      readFileSync(new URL("./settings-mail.tsx", import.meta.url), "utf8"),
    );
    // Bounded at the next component, not at the end of the file: `Field` and
    // `SecuritySelect` are DEFINED below it, so an unbounded slice would pass
    // this on the definitions rather than on the password form using them.
    const form = source.slice(
      source.indexOf("function PasswordAccountForm("),
      source.indexOf("function Field("),
    );
    expect(form.length).toBeGreaterThan(500);
    for (const control of [
      "imapHost", "imapPort", "smtpHost", "smtpPort", "SecuritySelect", "smtpDiffers",
      'type="password"',
    ]) {
      expect(form, control).toContain(control);
    }
  });
});
