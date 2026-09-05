import {
  mailOAuthProviderOf,
  type MailAccount, type MailAccountCreateInput, type MailAccountStatus,
  type MailAccountTestInput, type MailAccountUpdateInput,
  type MailAccountUpdatePasswordFields, type MailAuthMethod, type MailSecurity,
  type MailOAuthProvider, type MailOAuthSigninInput,
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

// --- Signing in at a provider (Phase 8 Task 3) -------------------------------

/**
 * How the account being added signs in. "password" is the default and stays
 * the common case on this install (a self-hosted Dovecot); the other two exist
 * only when the deployment has an app registration for them.
 */
export type MailSigninMethod = "password" | MailOAuthProvider;

/**
 * The OAuth form's state, and what is NOT in it is the point.
 *
 * No host, no port, no security, no username, no password. Those are the
 * provider's and known (api: services/mail-oauth-signin.ts's provider table) --
 * the spec's second path, in as many words. What is left is what only the
 * operator knows: which mailbox, and what to call it.
 *
 * `sentFolder` is on the EDIT form only. The server fills it per provider
 * ("Sent Items", "[Gmail]/Sent Mail") because it is a fact about the provider
 * rather than a choice, and it is editable afterwards because a mailbox with a
 * non-default namespace can prove that fact wrong.
 */
export interface OAuthFormState {
  label: string;
  email: string;
  sentFolder: string;
  /** "30" | "90" | "all", or an existing account's own stored value. Shares
   * AccountFormState's convention so the two forms' Backfill controls behave
   * identically. */
  backfill: string;
}

export function initialOAuthFormState(account?: MailAccount): OAuthFormState {
  if (account === undefined) {
    return { label: "", email: "", sentFolder: "", backfill: "90" };
  }
  return {
    label: account.label,
    email: account.email,
    sentFolder: account.sentFolder,
    backfill: account.backfillDays === null ? "all" : String(account.backfillDays),
  };
}

/**
 * The one field-level gate, and it has two fields to check because that is all
 * the form has.
 *
 * THE ADDRESS IS NOT VERIFIED AGAINST THE MAILBOX SIGNED INTO, and cannot be
 * from here -- see the note at the foot of api: services/mail-oauth-signin.ts.
 * What this catches is an empty one, which would produce an authorise request
 * with no login hint and an account row naming nobody.
 */
export function validateOAuthForm(state: OAuthFormState, isEdit: boolean): string | null {
  if (state.label.trim() === "") return "A label is required.";
  if (isEdit) return null;
  if (state.email.trim() === "") return "The mailbox address is required.";
  // Deliberately not a full address grammar: the shared schema's z.email() is
  // the authority and answers a 400 with its own message. This is the cheap
  // check that stops the round trip for the ordinary mistake.
  if (!state.email.includes("@")) return "Enter the full mailbox address.";
  return null;
}

/** The body POST /api/mail/accounts/oauth/authorize takes to add a NEW
 * mailbox. */
export function buildOAuthSigninInput(
  state: OAuthFormState, provider: MailOAuthProvider,
): MailOAuthSigninInput {
  return {
    provider,
    label: state.label.trim(),
    email: state.email.trim(),
    backfillDays: state.backfill === "all" ? null : Number(state.backfill),
  };
}

/** The same body for RE-authorising an account that already exists. The
 * account supplies its own address server-side, so nothing else is sent -- a
 * label typed into the edit form is saved by the PATCH, not by this. */
export function buildReauthorizeInput(
  accountId: string, provider: MailOAuthProvider,
): MailOAuthSigninInput {
  return { provider, accountId };
}

/**
 * The PATCH an OAuth account's edit form sends.
 *
 * THREE FIELDS, AND THE OMISSIONS ARE ENFORCED SERVER-SIDE TOO. There is no
 * password half (the server answers 409 `mail_password_not_applicable` to one),
 * and the host/port/security/username are the provider's -- submitting them
 * would be this form claiming to own settings it does not. The address is not
 * here either: it is the mailbox the grant was issued for, and changing it
 * would leave a token that authenticates somebody else.
 */
export function buildOAuthUpdatePatch(state: OAuthFormState): AccountPatchBody {
  return {
    label: state.label.trim(),
    sentFolder: state.sentFolder.trim(),
    backfillDays: state.backfill === "all" ? null : Number(state.backfill),
  };
}

/** What the settings row says an OAuth account signs in with. Named here
 * rather than at the two call sites so "Microsoft" has one spelling. */
export function providerLabel(provider: MailOAuthProvider): string {
  return provider === "microsoft" ? "Microsoft" : "Google";
}

/** A warning shown BEFORE a sign-in is started, when the provider has one. */
export interface SigninCaveat {
  heading: string;
  paragraphs: string[];
}

/**
 * ---------------------------------------------------------------------------
 * WHAT "EXPERIMENTAL" MEANS HERE, WHERE PASSWORD AND PROVIDER ARE THE CHOICE
 * ---------------------------------------------------------------------------
 *
 * Chris, 5 Sep: "label the Microsoft and Google connectivity as experimental
 * for now. I don't have time to check it." The reason is in this phase's own
 * four task reports rather than in a mood. Nothing in it was ever exercised
 * against a real Microsoft or Google tenant -- the consent screens belong to
 * whoever owns the directory and cannot be honestly mocked -- and not one line
 * of the YunoHost packaging that carries its settings has been run either,
 * because nothing in this repository can reach a YunoHost. Every other feature
 * in this product has been used on the machine it runs on. This one has not,
 * and that difference is invisible from outside: the suites are green, and
 * green against a fake looks exactly like green against Microsoft.
 *
 * THE WORD ON ITS OWN WOULD BE A DISCLAIMER RATHER THAN INFORMATION, which is
 * the failure mode this codebase already named once, in oauthSetupHint: an
 * absence and a deployment step nobody has taken look identical. "Experimental"
 * unqualified reads as a hedge, gets skipped, and lets nobody decide anything.
 * What a reader needs is the SHAPE of the gap -- which half is proven and which
 * half nobody has run -- so that "try it on a mailbox that can afford a bad
 * afternoon" is a conclusion they reach rather than advice they are given.
 *
 * AND NOT OVERSTATED, which is the other way to be useless and the easier one
 * to fall into. What sits under this is tested and mutation-tested: the
 * authorise request and its PKCE, the redirect URI refused at boot, the token
 * exchange, the refresh, what actually reaches IMAP and SMTP, and the pages
 * describing all of it. "This might not work" would be false, and false in a
 * way anyone who looked would catch, which would cost the true half its
 * credibility too.
 *
 * WHY THE CHOOSER AND NOT THE PROVIDER FORM, where providerSigninCaveat below
 * lives. That one appears once a provider is picked because it is about WHICH
 * Google account. This one is about whether to use a provider at all, and its
 * alternative -- a password account -- is on screen only in the chooser. Put it
 * inside either provider's form and it arrives after the question it answers
 * has been answered.
 *
 * NOT A LIVE REGION, and that is the one substantive difference from the amber
 * box below. That box APPEARS when the Google radio is chosen, so without
 * role="alert" a screen reader user meets the seven days and never the warning.
 * This one is in the dialog's first paint, in document order above the radios,
 * so it is read on the way to them; an alert role here would announce text that
 * did not change, which is noise aimed at the same person.
 */
export function oauthExperimentalNotice(): SigninCaveat {
  return {
    heading: "Signing in at Microsoft or Google is experimental",
    paragraphs: [
      "This has never been run against a real Microsoft or Google account. The"
      + " consent screen belongs to whoever owns the directory and no test here"
      + " can honestly stand in for one, so what is covered is the request"
      + " Conduit builds, the values it refuses and what it does with what comes"
      + " back — not the round trip itself.",
      "The packaging that carries the server-side settings has never been run"
      + " either, so an upgrade is a second place this can go wrong. Expect one"
      + " round of correction on the first sign-in, and leave a mailbox that has"
      + " to work today on a password.",
    ],
  };
}

/**
 * What the operator has to know about this provider before they press the
 * button, or null when there is nothing.
 *
 * -------------------------------------------------------------------------
 * THIS IS THE GMAIL FORK, AND IT IS HERE BECAUSE HERE IS WHERE THE CHOICE IS
 * -------------------------------------------------------------------------
 *
 * The plan says it "must appear at the point of CHOOSING, not in a README", and
 * the reason is not tidiness. What Google does to a consumer account is revoke
 * the refresh token every seven days while the app's publishing status is
 * Testing -- so a Conduit that shipped this quietly would sync for a week,
 * stop, and be indistinguishable from broken. The operator would look for the
 * bug here. That is v1.4.1's error-that-blamed-the-wrong-thing exactly, and the
 * sentence that prevents it costs nothing as long as it is read BEFORE the
 * mailbox is connected rather than after it stops.
 *
 * IT DOES NOT REFUSE, AND THAT IS DELIBERATE. A consumer Gmail account signed
 * in weekly by an operator who KNOWS is a legitimate way to use this -- annoying
 * and honest. What is not legitimate is finding out on day eight. So this
 * informs and the button still works.
 *
 * THE FIGURES ARE GOOGLE'S OWN, checked 5 Sep against its OAuth 2.0
 * documentation and not paraphrased from memory: "A Google Cloud Platform
 * project with an OAuth consent screen configured for an external user type and
 * a publishing status of 'Testing' is issued a refresh token expiring in 7
 * days"; IMAP needs `https://mail.google.com/`, which is a RESTRICTED scope, and
 * restricted scopes require verification plus an annual security assessment by
 * a Google-approved third party. The assessment is the paid part, and its price
 * is not Google's to publish, so this says "paid" and does not invent a number.
 *
 * MICROSOFT HAS NO CAVEAT OF THIS KIND, which is why the return type is
 * nullable rather than a two-branch table pretending at symmetry. A
 * single-tenant registration in the operator's own directory needs no
 * verification, and its refresh token has no expiry a syncing mailbox can
 * reach: Entra's 90 days is an INACTIVITY limit and the token rotates on every
 * use, so a poll interval measured in minutes renews it indefinitely. (The spec
 * says "do not expire", which is that in shorter words and is wrong only for a
 * mailbox nothing has touched for three months -- a stopped account, or a
 * server that was off.) Microsoft's real traps are tenant-side switches
 * (SMTP AUTH, the Web-vs-SPA platform) that
 * cannot be met at this screen and cannot be fixed from it -- they belong in
 * docs/mail-oauth-setup.md, which is where the operator is when they can act on
 * them.
 */
export function providerSigninCaveat(provider: MailOAuthProvider): SigninCaveat | null {
  if (provider === "microsoft") return null;
  return {
    heading: "Which kind of Google account is this?",
    paragraphs: [
      "A Google Workspace mailbox on a domain you administer is fine. Publish your"
      + " own OAuth app as Internal in that organisation and the sign-in lasts"
      + " indefinitely, the same as Microsoft.",
      "A personal @gmail.com address is not. While your app's publishing status is"
      + " Testing, Google revokes the sign-in every 7 days — mail stops until you"
      + " come back to this page and sign in again, every week.",
      "Leaving Testing is not a setting. IMAP needs Google's restricted"
      + " https://mail.google.com/ scope, so the app has to pass Google's"
      + " verification and a paid annual security assessment by a third party"
      + " Google approves.",
    ],
  };
}

/**
 * What an operator sees where a provider button would have been, when this
 * install has no app registration at all.
 *
 * SILENCE WAS THE PREVIOUS ANSWER AND IT IS THE WRONG ONE. Task 3 was right
 * that an install with no registration must not be offered a button whose only
 * outcome is a 409 -- but the form then simply showed the password fields, and
 * an operator who came to Settings specifically to connect their Microsoft
 * mailbox got no explanation of where the option went. "Nothing here" and "this
 * needs setting up first" look identical and are not.
 *
 * IT NAMES THE CALLBACK PATH, WHICH IS THE HALF NOBODY CAN GUESS. Registering
 * an app at either provider asks for a redirect URI first, it is compared byte
 * for byte afterwards, and until this line existed the only place that string
 * was written down was a route file. The origin comes from the browser that is
 * displaying it -- correct by construction for the person reading it, and never
 * used by the server to build a redirect (api: config.ts refuses to derive one
 * from a request, and that is unchanged).
 *
 * NULL WHEN THE PATH IS NOT KNOWN, and that branch is here rather than in the
 * component on purpose. The no-provider case is also where a FAILED providers
 * query lands, and a hint assembled from an absent callbackPath would tell the
 * operator to register the site root -- a plausible-looking string that is
 * wrong, which is worse than the silence "we could not ask" deserves. Deciding
 * it here makes it a case a test can state; deciding it in the JSX made it a
 * `!== undefined` that no test in this repository could reach.
 *
 * IT CARRIES THE EXPERIMENTAL LABEL TOO, and this is the surface where the
 * label is worth most rather than the one where it is most obvious. The reader
 * of oauthExperimentalNotice above has a registration already; somebody has
 * spent the afternoon. The reader of THIS sentence has not, and what it asks of
 * them is a trip into a console they may not own, for an app registration only
 * a tenant administrator can make. Telling them afterwards that nothing here
 * has met a real provider would be telling them once the cost was sunk.
 */
export function oauthSetupHint(callbackPath: string | undefined, origin: string): string | null {
  if (callbackPath === undefined || callbackPath === "") return null;
  return `No mail provider is set up on this install, so a mailbox here signs in with a`
    + ` password. Adding Microsoft or Google is experimental: no sign-in here has ever`
    + ` completed against a real one, and the packaging that carries its settings has`
    + ` never been run. To set one up, register ${origin}${callbackPath} as the redirect`
    + ` URI at the provider and set MAIL_OAUTH_REDIRECT_URI to that exact string.`
    + ` docs/mail-oauth-setup.md has the rest.`;
}

/** "Signed in with Microsoft", or null for a password account. */
export function signedInWith(authMethod: MailAuthMethod): string | null {
  const provider = mailOAuthProviderOf(authMethod);
  return provider === null ? null : `Signed in with ${providerLabel(provider)}`;
}

export interface SigninBanner {
  tone: "ok" | "error";
  text: string;
}

/**
 * What the `?oauth=` the callback redirects with means, as a sentence.
 *
 * THE SERVER SENDS A CODE AND THE CLIENT OWNS THE PROSE, which is a security
 * decision rather than a layering preference (api:
 * services/mail-oauth-signin.ts's SigninOutcome). A redirect's query string
 * lands in a URL bar, a history entry and nginx's access log, so a provider's
 * own error_description must never ride one -- it goes to the journal instead,
 * and this table is what an operator reads.
 *
 * AN UNKNOWN REASON STILL SAYS SOMETHING TRUE. A client and a server that
 * disagree about the code set is a thing that happens across an upgrade, and
 * "the sign-in did not complete" is correct for every member of it.
 */
export function signinBanner(
  search: { oauth?: string; reason?: string },
  /**
   * MAIL_OAUTH_REDIRECT_URI as the server parsed it, when the page knows it.
   *
   * ONLY THE `provider` FAILURE USES IT, and only that one should. That outcome
   * already says "this is usually the app registration", which is true and is
   * advice with nowhere to go: the operator now has to find out what this
   * install actually sends and compare it, by eye, against a provider console.
   * The value IS the comparison, and it is compared BYTE FOR BYTE at the
   * provider (RFC 6749 3.1.2.3) -- a trailing slash or an http decides it -- so
   * showing it next to the failure is the difference between the spec's "one
   * round of real-world fixing" and four.
   *
   * Absent (or unset) leaves the sentence exactly as it was, because a banner
   * that said "the redirect URI is: null" would be worse than one that did not
   * mention it.
   */
  redirectUri?: string | null,
): SigninBanner | null {
  if (search.oauth === "connected") {
    return { tone: "ok", text: "That mailbox is connected. The first sync starts on its own." };
  }
  if (search.oauth !== "failed") return null;
  const text = SIGNIN_FAILURES[search.reason ?? ""] ?? SIGNIN_FAILED_GENERIC;
  if (search.reason === "provider" && redirectUri !== undefined && redirectUri !== null) {
    return {
      tone: "error",
      text: `${text} This install sends ${redirectUri} as the redirect URI; the provider`
        + " compares it character for character against the one registered there.",
    };
  }
  return { tone: "error", text };
}

const SIGNIN_FAILED_GENERIC =
  "The sign-in did not complete, and nothing was changed. Try again.";

const SIGNIN_FAILURES: Record<string, string> = {
  // Deliberately does NOT say "somebody may be attacking you". The overwhelming
  // majority of these are an expired state or a second tab, and an alarming
  // sentence for a routine timeout teaches an operator to ignore it.
  state: "That sign-in could not be verified — it may have taken too long, or been"
    + " started in another window. Start it again from this page.",
  denied: "The sign-in was declined at the provider, so nothing was changed.",
  provider: "The provider would not complete the sign-in. This is usually the app"
    + " registration rather than the mailbox; the server log has what it said.",
  no_refresh_token: "The provider signed in but did not grant offline access, so the"
    + " mailbox could not be saved. Try again and allow offline access when asked.",
  duplicate: "You already have an active mail account for that address. Archive the old"
    + " one first if you are replacing it.",
  account: "That mailbox could not accept this sign-in. It may be archived, or signed in"
    + " with a different provider.",
  failed: "The mailbox could not be saved. The server log has the details.",
};

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
 *
 * GOOGLE GETS ONE MORE SENTENCE, AND THIS IS THE SECOND PLACE THE GMAIL FORK
 * HAS TO APPEAR (Task 4). providerSigninCaveat says it before the sign-in; this
 * says it at the only other moment it matters, which is the one where the
 * operator has forgotten. A consumer @gmail.com account on an app still in
 * Testing arrives here every seven days, on the dot, and the row otherwise
 * reads exactly like a mailbox whose password changed -- so the operator's
 * conclusion is "this keeps breaking" and the thing they suspect is Conduit.
 * Naming the seven days turns a recurring mystery into a known cost of the
 * account they chose. It is CONDITIONAL prose ("if this is") rather than a
 * claim, because nothing on this row knows whether the mailbox is Workspace or
 * consumer: mail_accounts.auth_method records the provider and Conduit
 * deliberately never asked for an id token that would say more (api:
 * services/mail-oauth-signin.ts's scope note).
 */
export function accountReauthMessage(
  status: MailAccountStatus, authMethod: MailAuthMethod,
): string | null {
  if (status !== "auth_required") return null;
  const provider = mailOAuthProviderOf(authMethod);
  if (provider === null) return "This mailbox needs to be signed in to again before it can sync.";
  const base = `${providerLabel(provider)} has stopped accepting this mailbox's saved sign-in.`
    + " Sign in again to resume syncing and sending.";
  if (provider === "microsoft") return base;
  return `${base} If this is a personal @gmail.com address, Google does this every 7 days`
    + " until the OAuth app leaves Testing.";
}
