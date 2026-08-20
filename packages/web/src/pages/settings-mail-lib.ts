import type {
  MailAccount, MailAccountCreateInput, MailAccountTestInput, MailAccountUpdateInput,
  MailAccountUpdatePasswordFields, MailSecurity,
} from "@conduit/shared";

/**
 * The mail-account form's pure logic, kept out of the page so it can be
 * unit-tested without a DOM: what an empty/edit form starts as, what counts
 * as valid, and -- the part worth the most tests -- exactly which fields each
 * of the four password-convention submissions carries.
 *
 * The convention itself is the server's (mail-accounts.ts's updateAccount doc
 * comment, and createAccount/testConnection's matching defaults):
 *
 *   1. create, "SMTP differs" OFF -> `password` alone, covering both protocols
 *   2. create, "SMTP differs" ON  -> `password` + `smtpPassword`
 *   3. edit, both fields blank    -> NEITHER key present (keep both stored)
 *   4. edit, password only        -> `password` alone, replacing both halves
 *
 * A blank field is always OMITTED, never submitted as "": the create and test
 * schemas hold passwords to `.min(1)`, and on a test with an accountId an
 * absent password is precisely what makes it use the stored credentials.
 */

export interface AccountFormState {
  label: string;
  email: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
  username: string;
  /** The form's two password states, and there is no third one. */
  smtpDiffers: boolean;
  password: string;
  smtpPassword: string;
  sentFolder: string;
  /** "30" | "90" | "all", or an existing account's own stored value. */
  backfill: string;
}

/** PATCH body shape for an account: settings, password fields, or both --
 * the same merge routes/mail.ts's accountPatchSchema performs. */
export type AccountPatchBody = MailAccountUpdateInput & MailAccountUpdatePasswordFields;

/** The "Local Dovecot" preset: a form pre-fill for the YunoHost mail stack's
 * standard ports, never configuration (spec). */
export const LOCAL_DOVECOT = {
  imapHost: "localhost", imapPort: "993", imapSecurity: "tls" as MailSecurity,
  smtpHost: "localhost", smtpPort: "587", smtpSecurity: "starttls" as MailSecurity,
};

/** The preset applied to a form: server fields fixed, username taken from the
 * signed-in user (on a YunoHost box the mailbox login IS the LDAP username),
 * everything else left alone. */
export function dovecotPreset(state: AccountFormState, username: string | undefined): AccountFormState {
  return { ...state, ...LOCAL_DOVECOT, username: username ?? state.username };
}

export function initialFormState(account?: MailAccount): AccountFormState {
  if (account === undefined) {
    return {
      label: "", email: "",
      imapHost: "", imapPort: "993", imapSecurity: "tls",
      smtpHost: "", smtpPort: "587", smtpSecurity: "starttls",
      username: "", smtpDiffers: false, password: "", smtpPassword: "",
      sentFolder: "Sent", backfill: "90",
    };
  }
  return {
    label: account.label, email: account.email,
    imapHost: account.imapHost, imapPort: String(account.imapPort), imapSecurity: account.imapSecurity,
    smtpHost: account.smtpHost, smtpPort: String(account.smtpPort), smtpSecurity: account.smtpSecurity,
    username: account.username,
    // Password fields always start blank on an edit: blank means "keep the
    // stored password", and a stored credential is never sent to a client to
    // pre-fill them with in the first place.
    smtpDiffers: false, password: "", smtpPassword: "",
    sentFolder: account.sentFolder,
    backfill: account.backfillDays === null ? "all" : String(account.backfillDays),
  };
}

export function isPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
}

/** The one field-level validation gate, shared by Save and Test connection --
 * a test with half a form is as useless as a save with one. */
export function validateForm(state: AccountFormState, isEdit: boolean): string | null {
  if (state.label.trim() === "") return "A label is required.";
  if (state.email.trim() === "") return "An email address is required.";
  if (state.imapHost.trim() === "" || state.smtpHost.trim() === "") return "IMAP and SMTP hosts are required.";
  if (!isPort(state.imapPort) || !isPort(state.smtpPort)) return "Ports must be whole numbers between 1 and 65535.";
  if (state.username.trim() === "") return "A username is required.";
  if (!isEdit && state.password === "") return "A password is required.";
  // Half a pair is the one state the server's convention cannot express: a
  // lone `password` would silently overwrite the stored SMTP half too.
  if (state.smtpDiffers && (state.password === "") !== (state.smtpPassword === "")) {
    return isEdit
      ? "With separate SMTP credentials, fill in both password fields, or leave both blank to keep the stored ones."
      : "Enter both the IMAP and the SMTP password.";
  }
  return null;
}

/** The non-credential half of the submission, identical for create and
 * update -- the server no-ops fields whose value has not changed. */
export function settingsFields(state: AccountFormState) {
  return {
    label: state.label.trim(),
    email: state.email.trim(),
    imapHost: state.imapHost.trim(),
    imapPort: Number(state.imapPort),
    imapSecurity: state.imapSecurity,
    smtpHost: state.smtpHost.trim(),
    smtpPort: Number(state.smtpPort),
    smtpSecurity: state.smtpSecurity,
    username: state.username.trim(),
    sentFolder: state.sentFolder.trim() === "" ? "Sent" : state.sentFolder.trim(),
    backfillDays: state.backfill === "all" ? null : Number(state.backfill),
  };
}

/** Shapes 1 and 2 of the password convention. */
export function buildCreateInput(state: AccountFormState): MailAccountCreateInput {
  return {
    ...settingsFields(state),
    password: state.password,
    ...(state.smtpDiffers ? { smtpPassword: state.smtpPassword } : {}),
  };
}

/** Shapes 3 and 4 of the password convention. */
export function buildUpdatePatch(state: AccountFormState): AccountPatchBody {
  return {
    ...settingsFields(state),
    ...(state.password !== "" ? { password: state.password } : {}),
    ...(state.smtpDiffers && state.smtpPassword !== "" ? { smtpPassword: state.smtpPassword } : {}),
  };
}

/**
 * Test-connection body. With an accountId the stored row supplies every field
 * and these only override it -- which is why omitting a blank password
 * matters here as much as on a save: it is what makes "test the account as
 * saved" possible at all.
 */
export function buildTestInput(state: AccountFormState, accountId?: string): MailAccountTestInput {
  const overrides = {
    imapHost: state.imapHost.trim(), imapPort: Number(state.imapPort), imapSecurity: state.imapSecurity,
    smtpHost: state.smtpHost.trim(), smtpPort: Number(state.smtpPort), smtpSecurity: state.smtpSecurity,
    username: state.username.trim(),
    ...(state.password !== "" ? { password: state.password } : {}),
    ...(state.smtpDiffers && state.smtpPassword !== "" ? { smtpPassword: state.smtpPassword } : {}),
  } satisfies MailAccountTestInput;
  return accountId === undefined ? overrides : { accountId, ...overrides };
}
