import { describe, it, expect } from "vitest";
import type { MailAccount } from "@conduit/shared";
import {
  buildCreateInput,
  buildTestInput,
  buildUpdatePatch,
  dovecotPreset,
  initialFormState,
  isPort,
  settingsFields,
  validateForm,
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
