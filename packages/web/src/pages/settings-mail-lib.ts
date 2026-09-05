import {
  mailOAuthProviderOf,
  type MailAccount, type MailAccountCreateInput, type MailAccountStatus,
  type MailAccountTestInput, type MailAccountUpdateInput,
  type MailAccountUpdatePasswordFields, type MailAuthMethod, type MailSecurity,
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

// --- Folder management (Phase 4.4 Task 4) ------------------------------------

/**
 * Why this folder cannot be renamed, or null when it can.
 *
 * PURE, AND SEPARATE FROM THE COMPONENT, following restoreConfirmBlocked's
 * precedent (settings-data-lib): the interesting part of a destructive control
 * is which cases it refuses, and that is worth unit tests rather than a render
 * test per case.
 *
 * THE CLIENT'S COPY OF RULES THE SERVER ALSO ENFORCES, deliberately, and the
 * server is the authority: every one of these comes back as a 409 with a
 * sentence of its own if a request is made anyway. What the client copy buys is
 * that the sentence arrives BEFORE the gesture rather than after it -- which is
 * the whole difference between a control that explains itself and one that
 * punishes a click.
 *
 * Note which folders are NOT here. The account's Sent, Trash and Archive
 * folders can all be renamed: the rename rewrites the account columns that name
 * them, in the same transaction (api: renameFolder), so the account follows its
 * folder rather than breaking.
 */
export function folderRenameBlocked(
  folder: { folder: string; locked: boolean; selectable: boolean },
  options: { stale: boolean },
): string | null {
  // Refused by every mail server worth the name: IMAP reserves the name, and
  // the servers that do implement RENAME INBOX give it different semantics
  // (the messages move out and INBOX stays).
  if (folder.folder.toUpperCase() === "INBOX") return "INBOX cannot be renamed.";
  if (!folder.selectable) return NOT_A_FOLDER;
  if (options.stale) return GONE_FROM_SERVER;
  return null;
}

/**
 * The two reasons that block BOTH commands, spelled identically in both so the
 * row can render its reasons deduped and show one line rather than two
 * near-identical ones. Neither sentence names an action, precisely because the
 * two actions share it.
 */
const NOT_A_FOLDER =
  "This is a hierarchy node rather than a folder — it holds no messages of its own.";
const GONE_FROM_SERVER =
  "The last sync did not find this folder on the server. Conduit keeps the row because it"
  + " still holds the mail it stored from it.";

/** Why this folder cannot be deleted, or null when it can. See
 * folderRenameBlocked for why this is pure and why it duplicates the server. */
export function folderDeleteBlocked(
  folder: { folder: string; selectable: boolean },
  account: { sentFolder: string; trashFolder: string | null; archiveFolder: string | null },
  options: { stale: boolean },
): string | null {
  if (folder.folder.toUpperCase() === "INBOX") return "INBOX cannot be deleted.";
  // By NAME rather than by special_use, exactly as the server refuses it: it is
  // the account COLUMN that would break, and a folder can be the Archive target
  // without carrying the \Archive attribute.
  const role = folder.folder === account.sentFolder.trim() ? "Sent"
    : folder.folder === account.trashFolder?.trim() ? "Trash"
      : folder.folder === account.archiveFolder?.trim() ? "Archive" : null;
  if (role !== null) {
    return `This is the account's ${role} folder. Point ${role} at another folder below first.`;
  }
  if (!folder.selectable) return NOT_A_FOLDER;
  if (options.stale) return GONE_FROM_SERVER;
  return null;
}

/**
 * Every reason this row's commands are unavailable, deduped, in the order a
 * reader meets them.
 *
 * SHOWN AS TEXT, always, rather than left as the absence of a button. That
 * absence is a blocked reason like any other, and this codebase's rule for one
 * is that it is visible text -- never a `title`, which is invisible to touch
 * and silent to a screen reader (bulk-bar.tsx). "Why is there no Delete on my
 * Archive folder" is a question the row should answer where it is asked.
 *
 * Deduped because the two commands share two of their four refusals word for
 * word (see NOT_A_FOLDER and GONE_FROM_SERVER): a hierarchy node would
 * otherwise print two near-identical sentences, which reads as a bug.
 */
export function folderCommandReasons(
  folder: { folder: string; locked: boolean; selectable: boolean },
  account: { sentFolder: string; trashFolder: string | null; archiveFolder: string | null },
  options: { stale: boolean },
): string[] {
  return [...new Set([
    folderRenameBlocked(folder, options),
    folderDeleteBlocked(folder, account, options),
  ].filter((reason): reason is string => reason !== null))];
}

/**
 * What deleting this folder does, said BEFORE it happens (the spec's
 * requirement, in as many words).
 *
 * Three sentences and each one is load-bearing: what leaves, what stays, and
 * the one refusal a user cannot see coming. The middle one is the promise this
 * product makes everywhere -- it archives rather than expunges -- and the last
 * one is why a user with a full folder is about to be told no rather than asked
 * "are you sure".
 *
 * A count is deliberately NOT in it. Conduit only knows what it has synced, and
 * quoting that number here would understate a folder whose sync is off by
 * however much it has never seen. The server's real count arrives in the
 * refusal, which is the only place it is true.
 */
export function folderDeleteWarning(folder: string): string[] {
  return [
    `"${folder}" is removed from the mail server.`,
    "Every message Conduit has already stored from it is KEPT — still searchable, still on"
      + " the records its conversations are linked to, and still shown under this folder's name.",
    "If the folder still holds mail on the server, or has folders inside it, this is refused"
      + " rather than done: Conduit does not delete mail.",
  ];
}

// --- The account's state, as a row shows it (Phase 8 Task 2) -----------------

/**
 * What the status badge says.
 *
 * PURE AND SEPARATE FROM THE COMPONENT, following folderRenameBlocked's
 * precedent above: the interesting part of a state is which words it produces,
 * and that is worth a test per case rather than a render test per case.
 *
 * 'auth_required' READS AS AN INSTRUCTION, NOT A DIAGNOSIS. "Error" describes
 * the server's mood; "Sign in again" describes what the person looking at the
 * row has to do, which is the entire reason this state exists apart from
 * 'error' (see mailAccountStatusSchema in @conduit/shared). An operator who
 * reads "Error" waits for it to clear, and this one never clears on its own.
 */
export function accountStatusLabel(status: MailAccountStatus, archived: boolean): string {
  if (archived) return "Archived";
  switch (status) {
    case "auth_required": return "Sign in again";
    case "error": return "Error";
    case "active": return "Active";
    // Exhaustive by construction: a fourth status nobody adds here is a
    // compile error at the `never`, not a badge that silently reads "Active"
    // for a state the server considers broken.
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The sentence beneath the badge when an account's grant has lapsed, or null
 * when the row has nothing of this kind to say.
 *
 * NAMES THE PROVIDER, because "sign in again" is a different gesture at
 * Microsoft than at Google and the operator is about to go and do one of them.
 * The name comes from mail_accounts.auth_method, which is in the clear and is
 * the whole reason that column exists -- rendering this costs no trip to
 * mail.key.
 *
 * DELIBERATELY NOT last_error. That column still holds the provider's own words
 * (an AADSTS code, say) for whoever is diagnosing this, and those words are of
 * no use to the person who simply has to sign in again -- an operator reading a
 * technical string and concluding that waiting is the remedy is the exact
 * failure this state exists to prevent.
 *
 * The password branch is unreachable -- a password account has no grant to
 * lapse -- and returns a sentence rather than throwing: a row that somehow
 * reached this state should still say something true and actionable.
 */
export function accountReauthMessage(
  status: MailAccountStatus, authMethod: MailAuthMethod,
): string | null {
  if (status !== "auth_required") return null;
  const provider = mailOAuthProviderOf(authMethod);
  if (provider === null) return "This mailbox needs to be signed in to again before it can sync.";
  const name = provider === "microsoft" ? "Microsoft" : "Google";
  return `${name} has stopped accepting this mailbox's saved sign-in.`
    + " Sign in again to resume syncing and sending.";
}
