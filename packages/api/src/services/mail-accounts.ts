import { and, desc, eq, isNull, isNotNull, ne } from "drizzle-orm";
import type {
  MailAccount, MailAccountCreateInput, MailAccountUpdateInput, MailAccountTestInput,
  MailAccountUpdatePasswordFields, MailAccountSummary, MailAccountList, MailAccountTestResult,
  MailSecurity, MailAccountStatus, MailVisibility, MailAuthMethod,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, type MailAccountRow } from "../db/schema.js";
import {
  NotFoundError, ArchivedError, ConflictError, IncompleteTestConnectionSettingsError,
  MailCredentialKindError,
} from "./errors.js";
import {
  encryptCredentialsAt, decryptCredentialsAt, mustBePasswordCredentials, type MailCredentials,
} from "./mail-crypto.js";
import type { MailConnectionAuth } from "./mail-imap.js";
import { resolveConnectionAuth, unconfiguredTokenRefresher, type MailTokenRefresher } from "./mail-oauth.js";
import { sanitizeMailHtml } from "./mail-content.js";
import { publish } from "./sse.js";

/** Invalidation frame every mail-account mutator publishes after its write commits.
 * Mail accounts emit NO events-table rows (mail stays out of the CRM timeline per
 * the Phase 4 spec) -- this SSE hint is the only invalidation signal, driving both
 * the settings page and (via the account-status flip) the inbox's error badge.
 * `widenWith` exists for the one mutation whose blast radius is bigger than the
 * settings page -- updateAccount's visibility flip appends the thread-side key
 * families to the SAME single frame -- so the accounts key has one definition
 * here and a widened publish still costs one frame. */
function publishAccountsHint(widenWith: string[][] = []): void {
  publish({ keys: [["mail-accounts"], ...widenWith] });
}

/**
 * Notified after every account mutation that changes whether or how this
 * account should be syncing: create (start one), update (restart or wake --
 * see `connectionChanged`), archive (tear down), unarchive (start again).
 * mail-sync.ts's SyncManager registers itself here at start() and
 * unregisters at stop().
 *
 * Registration runs in this direction -- the sync engine registering with
 * the accounts service, rather than this file importing the sync engine --
 * so the mutating service stays independent of its consumer: mail-accounts.ts
 * remains unit-testable with no sync engine in the picture at all, and the
 * two modules do not form an import cycle (mail-sync has to import
 * getAccountCredentialsAsSystem from here). sse.ts's subscribe() runs the
 * same direction, but is NOT the precedent for the mechanism: that is a Set
 * of many subscribers, and this is a single slot with last-writer-wins --
 * this file's own design, appropriate because there is exactly one sync
 * engine per process and a second registration means a bug, not a second
 * listener.
 */
export interface AccountChange {
  /**
   * Whether anything a CONNECTION is built from moved -- host, port,
   * security, username, or either password. It is the only distinction the
   * sync engine needs: a connection-affecting change forces a restart, while
   * anything else (label, signature, sent_folder, backfill window) is picked
   * up by the running loop's next account read. Computed here because this
   * is where it is known; updateAccount already derives the same fact for
   * its own status-reset decision.
   */
  connectionChanged: boolean;
}
type AccountChangedHook = (accountId: string, change: AccountChange) => void;
let accountChangedHook: AccountChangedHook | null = null;

/** Register the hook; returns an unregister function that only clears the
 * hook if it is still the one it installed, so a replaced registration
 * cannot be torn down by a stale unregister. */
export function setAccountChangedHook(hook: AccountChangedHook): () => void {
  accountChangedHook = hook;
  return () => {
    if (accountChangedHook === hook) accountChangedHook = null;
  };
}

/**
 * Called after the mutation's transaction has committed, alongside the SSE
 * hint and for the same reason: the sync engine must react to the row that is
 * actually stored, never to one a rollback erased.
 *
 * Never throws. A sync-engine failure must not fail the user's CRUD request,
 * which has already committed by this point -- the worst case is one account
 * whose sync is out of step until the next restart, which is not worth a 500
 * on a successful save. (The hook itself is synchronous by contract; the
 * manager's implementation kicks off its own async reconcile and handles that
 * promise internally.)
 */
function notifyAccountChanged(accountId: string, change: AccountChange): void {
  const hook = accountChangedHook;
  if (hook === null) return;
  try {
    hook(accountId, change);
  } catch (error) {
    console.error("mail-accounts: account-changed hook threw", { accountId, error });
  }
}

/**
 * sent_folder, normalised at the WRITE.
 *
 * An IMAP mailbox name is compared byte for byte, so a stored " Sent " is a
 * different mailbox from "Sent" everywhere it is used: mail-sync.ts trims it
 * when it loads an account (so its passes and APPENDs agree with each other),
 * but mail-ingest.ts compares the raw column against the folder a sighting
 * came from to decide whether an outbound message is really in the account's
 * own Sent folder -- and that comparison fails for every stray space, taking
 * the Bcc rule with it. Trimming here means the two can never disagree in the
 * first place; loadAccount's trim stays as the backstop for rows written
 * before this.
 *
 * Whitespace-only becomes "no value", so the column default ("Sent") applies
 * on create and nothing is written on update: "" is not a mailbox anyone can
 * append to, and storing it would only turn a typo into a silent failure at
 * send time.
 */
function normalizeSentFolder(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * trash_folder/archive_folder, normalised at the WRITE -- normalizeSentFolder's
 * rule applied to the two Phase 4.1 move targets (Task 4, once the Settings
 * folder picker started submitting them).
 *
 * Same reason as sent_folder's: an IMAP mailbox name is compared byte for byte
 * downstream, so a stored " Archive " is a different mailbox from "Archive"
 * everywhere it is used -- and here that means services/mail-move.ts, which
 * reads these columns as the MOVE target. It already trims on read as a
 * backstop for rows written before this; trimming at the write is what keeps
 * the stored value and the picker's own display of it in agreement.
 *
 * THREE INPUTS, THREE ANSWERS:
 * - `undefined` (field absent from the PATCH): unchanged, like every other
 *   optional field.
 * - `null`: a real, intended value -- "detect this for me", which the next
 *   discovery pass fills back in (mail-folders.ts's fillMoveTargets). Passed
 *   through untouched.
 * - a string: trimmed. Whitespace-only trims to nothing and is REJECTED as an
 *   override -- dropped from the patch, exactly as normalizeSentFolder drops a
 *   blank sent_folder. Unlike sent_folder there is no column default to fall
 *   back to, so writing "" would store a mailbox name no server can select and
 *   turn every bulk move on that account into a server-side failure. The empty
 *   string never gets this far anyway (the shared schema's nullableString
 *   rejects it outright); this covers " ".
 */
function normalizeFolderOverride(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toMailAccount(row: MailAccountRow) {
  return {
    id: row.id, userId: row.userId, label: row.label, email: row.email,
    imapHost: row.imapHost, imapPort: row.imapPort, imapSecurity: row.imapSecurity as MailSecurity,
    smtpHost: row.smtpHost, smtpPort: row.smtpPort, smtpSecurity: row.smtpSecurity as MailSecurity,
    username: row.username,
    sentFolder: row.sentFolder,
    trashFolder: row.trashFolder, archiveFolder: row.archiveFolder,
    signatureHtml: row.signatureHtml, backfillDays: row.backfillDays,
    visibility: row.visibility as MailVisibility,
    authMethod: row.authMethod as MailAuthMethod,
    status: row.status as MailAccountStatus, lastError: row.lastError,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  } satisfies MailAccount;
}

function toSummary(row: Pick<MailAccountRow, "id" | "label" | "email">) {
  return { id: row.id, label: row.label, email: row.email } satisfies MailAccountSummary;
}

/**
 * Loads an account and enforces ownership in one place, used by every
 * mutating path plus getOwnAccount and testConnection's accountId branch.
 * Deliberately the SAME NotFoundError for "no such row" and "row belongs to
 * someone else" -- existence must not leak another user's account settings,
 * so a foreign account 404s exactly like a nonexistent one.
 */
async function mustGetOwned(db: Database, actorId: string, id: string): Promise<MailAccountRow> {
  const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  if (row === undefined || row.userId !== actorId) throw new NotFoundError("mail account", id);
  return row;
}

// drizzle-orm wraps every driver error in a DrizzleQueryError; the original
// postgres.js PostgresError (carrying the actual Postgres error code) sits on
// its `.cause`, not on the wrapper itself -- checking `err.code` directly
// here would never match. Mirrors tasks.ts's identical helper (not shared
// across files -- neither is the one it was copied from).
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === "23505";
}

const DUPLICATE_MAILBOX_MESSAGE = "you already have an active mail account for this email address";

export async function createAccount(
  db: Database, actorId: string, input: MailAccountCreateInput, mailKeyPath: string,
): Promise<MailAccount> {
  // "SMTP differs" toggle: when the form's smtpPassword override is absent,
  // the single password field covers both protocols (spec, Key handling).
  const credentialsCiphertext = encryptCredentialsAt(mailKeyPath, {
    imapPassword: input.password,
    smtpPassword: input.smtpPassword ?? input.password,
  });
  const sentFolder = normalizeSentFolder(input.sentFolder);

  let row: MailAccountRow | undefined;
  try {
    [row] = await db.insert(mailAccounts).values({
      userId: actorId, label: input.label, email: input.email,
      imapHost: input.imapHost, imapPort: input.imapPort, imapSecurity: input.imapSecurity,
      smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecurity: input.smtpSecurity,
      username: input.username,
      credentialsCiphertext,
      // Conditional spreads (not `?? default`) so an omitted field lets the DB's
      // own default apply (sentFolder "Sent", backfillDays 90) while an
      // explicit null on backfillDays (meaning "sync everything") is preserved
      // rather than coerced back into the default.
      ...(sentFolder !== undefined ? { sentFolder } : {}),
      ...(input.backfillDays !== undefined ? { backfillDays: input.backfillDays } : {}),
      // Signatures render directly in the main document, no iframe/CSP
      // isolation (spec) -- this service is the only write path for
      // signature_html, so it is the one place that must run the shared
      // sanitizer profile (mail-content.ts's sanitizeMailHtml, no cidMap: a
      // signature has no attachments to rewrite cid: references against).
      signatureHtml: input.signatureHtml != null ? sanitizeMailHtml(input.signatureHtml) : null,
      status: "active",
    }).returning();
  } catch (err) {
    // mail_accounts_user_email_active_unique (drizzle/0004_*.sql): a
    // non-archived account for this (user, lower(email)) already exists.
    // Re-adding the same mailbox would sync every message a second time
    // under a new account_id, duplicating every thread it touches.
    if (isUniqueViolation(err)) throw new ConflictError("mail account", input.email, DUPLICATE_MAILBOX_MESSAGE);
    throw err;
  }
  if (row === undefined) throw new Error("insert returned no row");
  // A brand-new account has no sync at all yet, so this is always the full
  // create path.
  notifyAccountChanged(row.id, { connectionChanged: true });
  publishAccountsHint();
  return toMailAccount(row);
}

/** The connection an OAuth account is created with -- the provider's own
 * endpoints, resolved by services/mail-oauth-signin.ts's provider table.
 *
 * TAKEN AS PLAIN FIELDS RATHER THAN A PROVIDER NAME, so this module stays the
 * writer of mail_accounts and never becomes a directory of mailbox hosts. It is
 * the same division mail-imapflow.ts has with `rejectUnauthorized`: the caller
 * that knows resolves, and the one that writes takes values. */
export interface OAuthAccountConnection {
  imapHost: string; imapPort: number; imapSecurity: MailSecurity;
  smtpHost: string; smtpPort: number; smtpSecurity: MailSecurity;
  username: string; sentFolder: string;
}

export interface OAuthAccountInput extends OAuthAccountConnection {
  label: string;
  email: string;
  /** 'oauth_microsoft' or 'oauth_google'. Typed as the whole enum because the
   * column is, and narrowed by the caller that built it from a provider. */
  authMethod: MailAuthMethod;
  backfillDays?: number | null;
}

/**
 * Create an account that authenticates with a provider (Phase 8 Task 3).
 *
 * A SECOND CREATE FUNCTION RATHER THAN A BRANCH IN THE FIRST, and the reason is
 * what each is handed. createAccount takes a MailAccountCreateInput -- a form
 * submission, with a password in it -- and seals that password itself. This
 * takes a CIPHERTEXT that mail-oauth-signin.ts already sealed with
 * encryptCredentialsChecked, because the payload came from an HTTP response and
 * had to be validated before the cipher rather than after (mail-crypto.ts's
 * encryptCredentials: "serialises, does not validate"). Folding the two into
 * one function would mean one signature carrying both a plaintext password and
 * a sealed blob, with a comment explaining that exactly one of them is ever set.
 *
 * THE COLUMN AND THE BLOB ARE WRITTEN IN ONE STATEMENT, which is the invariant
 * MailAuthMethodMismatchError exists to guard: auth_method and
 * credentials_ciphertext are two halves of one fact, and this is the only place
 * that creates them.
 *
 * NO status ARGUMENT. A new account is 'active' like any other; whether the
 * grant works is the first sync pass's question.
 */
export async function createOAuthAccount(
  db: Database, actorId: string, input: OAuthAccountInput, credentialsCiphertext: string,
): Promise<MailAccount> {
  let row: MailAccountRow | undefined;
  try {
    [row] = await db.insert(mailAccounts).values({
      userId: actorId, label: input.label, email: input.email,
      imapHost: input.imapHost, imapPort: input.imapPort, imapSecurity: input.imapSecurity,
      smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecurity: input.smtpSecurity,
      username: input.username,
      credentialsCiphertext,
      authMethod: input.authMethod,
      sentFolder: input.sentFolder,
      // Conditional spread for the same reason createAccount uses one: an
      // omitted backfill takes the column default (90 days), while an explicit
      // null means "sync everything" and must survive.
      ...(input.backfillDays !== undefined ? { backfillDays: input.backfillDays } : {}),
      // No signature: there is no field for one on the OAuth form and the
      // column is nullable. Settings adds one afterwards like any other.
      status: "active",
    }).returning();
  } catch (err) {
    // The same unique index createAccount meets, for the same reason: re-adding
    // a mailbox that is already here would sync every message a second time
    // under a new account id. Reachable from a DIFFERENT gesture, though --
    // signing in to a mailbox that is already configured with a password -- so
    // the message is the one an operator needs either way.
    if (isUniqueViolation(err)) throw new ConflictError("mail account", input.email, DUPLICATE_MAILBOX_MESSAGE);
    throw err;
  }
  if (row === undefined) throw new Error("insert returned no row");
  notifyAccountChanged(row.id, { connectionChanged: true });
  publishAccountsHint();
  return toMailAccount(row);
}

/**
 * Replace an OAuth account's stored grant with a freshly authorised one -- the
 * "Sign in again" path (Phase 8 Task 3).
 *
 * IT RESETS status, WHICH MAKES THIS A THIRD WRITER OF THAT COLUMN, and the
 * entitlement is worth stating because two writers to a state column is how a
 * state gets silently overwritten (mail-oauth.ts's header says so about the
 * refresh path, which deliberately does NOT write it). The difference is
 * causal: 'auth_required' is a verdict about a SPECIFIC refresh token, and this
 * statement replaces that token in the same transaction. The verdict is stale
 * by construction the moment the bytes change, so leaving it would leave the
 * row telling the operator to do the thing they have just done. It is the same
 * argument updateAccount's shouldResetStatus makes for a password change, one
 * credential type over.
 *
 * IT DOES NOT CLEAR 'active', obviously, and it does not need to distinguish
 * 'error' from 'auth_required': a new grant plausibly fixes either, the sync
 * loop re-decides on its very next pass, and notifyAccountChanged below makes
 * that pass happen in seconds rather than at the end of a 32-minute backoff.
 *
 * THE RACE IS REAL AND IT SELF-HEALS, which is why it is named rather than
 * locked against. A pass that started BEFORE this transaction can finish after
 * it and write 'auth_required' back, from a verdict about the token this
 * statement has already replaced -- so the badge can flicker back for one
 * interval. It does not stick: notifyAccountChanged restarts the AccountSync,
 * whose first pass then succeeds and writes 'active'. Holding a lock across
 * that would mean holding one across a provider round trip, which is the thing
 * persistRefreshedToken's own comment is careful not to do.
 *
 * THREE REFUSALS, ALL ConflictError, all under the row lock:
 *
 * - AN ARCHIVED ACCOUNT. Archiving stops sync and hides the mailbox; signing
 *   in to one would store a live credential for something deliberately put
 *   away. Unarchive first, exactly as updateAccount requires.
 * - A DIFFERENT PROVIDER. Re-authorising a Microsoft account against Google is
 *   not a re-authorisation, it is a different mailbox wearing this row's label
 *   -- and it would leave every stored message filed under an account that no
 *   longer points at the server they came from.
 * - A PASSWORD ACCOUNT. Converting one to OAuth is a real thing an operator
 *   might want and is NOT this gesture: the addresses need not match, the
 *   stored password would be destroyed, and there is no screen that asks for
 *   any of that. Refused rather than half-supported; the way to move a mailbox
 *   to OAuth today is to add it as an OAuth account and archive the old row.
 */
export async function replaceOAuthCredentials(
  db: Database, actorId: string, id: string, authMethod: MailAuthMethod,
  credentialsCiphertext: string, now: Date,
): Promise<MailAccount> {
  await mustGetOwned(db, actorId, id);

  const row = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id)).for("update");
    if (locked === undefined) throw new NotFoundError("mail account", id);
    if (locked.archivedAt !== null) throw new ArchivedError("mail account", id);
    if (locked.authMethod !== authMethod) {
      throw new ConflictError(
        "mail account", id,
        locked.authMethod === "password"
          ? "this mailbox signs in with a password; add it again as a provider mailbox instead of"
            + " signing in to this one"
          : `this mailbox is signed in with '${locked.authMethod}', not '${authMethod}'`,
      );
    }
    const [updated] = await tx.update(mailAccounts).set({
      credentialsCiphertext,
      status: "active" as const,
      lastError: null,
      updatedAt: now,
      // isNull(archivedAt) is the same defence in depth updateAccount carries:
      // the FOR UPDATE above already makes a concurrent archive impossible, and
      // this keeps a future writer that forgets the lock failing closed.
    }).where(and(eq(mailAccounts.id, id), isNull(mailAccounts.archivedAt))).returning();
    if (updated === undefined) throw new ArchivedError("mail account", id);
    return updated;
  });

  // connectionChanged, so the AccountSync RESTARTS rather than merely waking:
  // an account that reached 'auth_required' is sitting in a capped 32-minute
  // backoff, and a wake would leave the operator watching a row that says
  // nothing for half an hour after a sign-in that worked.
  notifyAccountChanged(id, { connectionChanged: true });
  publishAccountsHint();
  return toMailAccount(row);
}

/**
 * Service-level update input: the shared mailAccountUpdateInputSchema
 * deliberately excludes password/smtpPassword (see its comment in
 * packages/shared) because "blank means keep the stored value" is a
 * service-layer concern, not something a single static shape can express.
 * mailAccountUpdatePasswordFieldsSchema (packages/shared) is the schema a
 * PATCH body's password fields actually validate through -- unlike
 * mailAccountCreateInputSchema's `.min(1)` fields, it permits "" -- and the
 * route layer (Task 7) is the "call site" that merges its parse result in
 * here.
 */
export type UpdateAccountInput = MailAccountUpdateInput & MailAccountUpdatePasswordFields;

// Fields whose change means a previously-broken account might now connect --
// see the status-reset comment in updateAccount below.
const CONNECTION_FIELDS = [
  "imapHost", "imapPort", "imapSecurity", "smtpHost", "smtpPort", "smtpSecurity", "username",
] as const satisfies readonly (keyof MailAccountUpdateInput)[];

/**
 * Password-field convention (matches createAccount and testConnection's
 * "SMTP differs" default): a lone `password` sets BOTH the imap and smtp
 * password, unless `smtpPassword` is also submitted, in which case that
 * wins for smtp. A lone `smtpPassword` changes ONLY smtp, carrying the
 * stored imap password forward unchanged. The settings form (Task 9)
 * submits `password` alone when its "SMTP differs" toggle is off, and both
 * fields when it is on -- so this mirrors the form's own two states exactly
 * rather than introducing a third.
 *
 * Concurrency: everything that decides WHAT changed (changedKeys, the
 * status-reset decision, and the smtpPassword-alone branch's carried-forward
 * imap half) is computed from a row locked with SELECT ... FOR UPDATE inside
 * one transaction, never from a pre-transaction snapshot. Two concurrent
 * updateAccount calls on the same id therefore serialize on that lock:
 * whichever acquires it second always sees the first's already-committed
 * write. Without this (an earlier version of this function read the row
 * once before opening any transaction), two races were reproducible: (a)
 * this function proceeding to update an account that a concurrent
 * archiveAccount had just archived, because the archived check read a
 * stale pre-archive snapshot; and (b) the smtpPassword-alone branch
 * carrying forward a stale imap password, silently reverting a concurrent
 * password-only change. Only the smtpPassword-alone branch's decrypt reads
 * the locked row -- sanitizeMailHtml and the password-present branch's
 * encryptCredentialsAt are pure functions of the SUBMITTED input, so they
 * run BEFORE the transaction even opens (no reason to hold a row lock
 * across them, and it means a missing mail.key -- MailKeyMissingError --
 * surfaces before any lock is ever taken).
 */
export async function updateAccount(
  db: Database, actorId: string, id: string, patch: UpdateAccountInput, mailKeyPath: string,
): Promise<MailAccount> {
  const { password, smtpPassword, ...rest } = patch;

  // Existence/ownership only -- 404 must not depend on ever taking a row
  // lock, and this pre-check no longer supplies any value used to decide
  // WHAT to write (see the transaction below for that).
  await mustGetOwned(db, actorId, id);

  // Pure, key-file work hoisted above the transaction (see the doc comment
  // above). Sanitizing here too (not after the changedKeys diff) matters:
  // comparing the RAW submission against the stored (already-sanitized)
  // value would register a change whenever sanitization alone would have
  // altered the markup -- a false "changed" for a resubmission that is
  // byte-identical to what's stored once normalised, which would wrongly
  // skip the same-value no-op short-circuit and fire an unearned SSE hint.
  // sentFolder is trimmed here, alongside the signature and for the same
  // reason: the diff below compares the submission against the STORED value,
  // so a normalisation applied later would register " Sent " as a change from
  // (and then overwrite) the "Sent" already in the column. A whitespace-only
  // submission normalises to undefined, i.e. drops out of the patch entirely
  // -- see normalizeSentFolder.
  // trashFolder/archiveFolder are trimmed here for exactly the same reason,
  // and in the same place, so the same-value diff below compares like with
  // like: a resubmitted " Archive " must read as unchanged against the stored
  // "Archive", not as an edit that then overwrites it with the padded form.
  // See normalizeFolderOverride for the three-way undefined/null/string rule.
  //
  // Neither column is in CONNECTION_FIELDS, and that is the right answer, not
  // an omission: changing where trashed or archived mail goes changes nothing
  // a connection is built from, so the AccountSync is WOKEN rather than
  // restarted (see notifyAccountChanged's call below). The running loop reads
  // the account row on its next pass, and mail-move.ts re-reads these two
  // columns at move time precisely because a pass can fill them underneath it.
  //
  // `visibility` (Phase 4.2) is the same shape of non-omission: flipping
  // Private/Shared changes nothing IMAP/SMTP is built from either, so it is
  // deliberately absent from CONNECTION_FIELDS too -- a wake, not a restart.
  // What DOES differ from trashFolder/archiveFolder is the SSE fan-out: every
  // OTHER user's thread list and unread count change when an account's
  // visibility flips (the spec's Settings section), not just this account's
  // own row -- so when `visibility` is among `changedKeys` the post-commit
  // publish below carries `[["mail-threads"]]` and `[["mail-unread"]]`
  // beside `[["mail-accounts"]]`.
  const withSentFolder = rest.sentFolder !== undefined
    ? { ...rest, sentFolder: normalizeSentFolder(rest.sentFolder) }
    : rest;
  const withFolderOverrides = {
    ...withSentFolder,
    ...(rest.trashFolder !== undefined ? { trashFolder: normalizeFolderOverride(rest.trashFolder) } : {}),
    ...(rest.archiveFolder !== undefined ? { archiveFolder: normalizeFolderOverride(rest.archiveFolder) } : {}),
  };
  const normalizedRest = withFolderOverrides.signatureHtml != null
    ? { ...withFolderOverrides, signatureHtml: sanitizeMailHtml(withFolderOverrides.signatureHtml) }
    : withFolderOverrides;
  const passwordProvided = password !== undefined && password !== "";
  const smtpPasswordProvided = smtpPassword !== undefined && smtpPassword !== "";
  const freshCredentialsCiphertext = passwordProvided
    ? encryptCredentialsAt(mailKeyPath, {
        imapPassword: password,
        smtpPassword: smtpPasswordProvided ? smtpPassword : password,
      })
    : undefined;
  // Only true when smtpPassword is the SOLE credential submission -- the one
  // remaining branch that must decrypt (and therefore must run inside the
  // transaction, against the locked row).
  const wantsSmtpPasswordAloneChange = !passwordProvided && smtpPasswordProvided;

  const { row, wrote, connectionChanged, visibilityChanged } = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id)).for("update");
    if (locked === undefined) throw new NotFoundError("mail account", id);
    if (locked.archivedAt !== null) throw new ArchivedError("mail account", id);

    // Same-value patches are a true no-op (no write, no SSE hint) -- mirrors
    // companies.ts's updateCompany. Only fields that actually differ count;
    // normalizedRest's keys are a subset of MailAccountRow's own field names
    // (checked structurally by the compiler), so indexing `locked[k]` is safe.
    const changedKeys = (Object.keys(normalizedRest) as (keyof MailAccountUpdateInput)[])
      .filter((k) => normalizedRest[k] !== undefined && normalizedRest[k] !== locked[k]);
    // Empty/absent password fields mean "keep stored" (spec, Key handling); a
    // non-empty submission always counts as an intended change even if it
    // happens to match the old plaintext -- we do not decrypt just to compare.
    const wantsPasswordChange = passwordProvided || smtpPasswordProvided;
    if (changedKeys.length === 0 && !wantsPasswordChange) {
      return { row: locked, wrote: false, connectionChanged: false, visibilityChanged: false };
    }

    // A PASSWORD SUBMITTED FOR AN OAUTH ACCOUNT IS REFUSED, AND UNTIL TASK 3 IT
    // WAS NOT. This is the seam Tasks 1 and 2 left here, and reading it again
    // once an OAuth account could actually EXIST turned up more than the
    // carry-forward branch below.
    //
    // Without this line, a PATCH carrying `password` on an OAuth account
    // reached freshCredentialsCiphertext -- computed above, outside the
    // transaction, from the submission alone -- and that password blob was
    // written straight over the row's refresh token. auth_method stayed
    // 'oauth_microsoft'. The result is the exact state
    // MailAuthMethodMismatchError calls "unreachable by construction": the
    // column and the blob disagreeing, the grant destroyed with no backup that
    // helps, and every subsequent connection failing with a mismatch nobody
    // asked for. It was genuinely unreachable while nothing could create an
    // OAuth account; this task is what makes it reachable, so this task is
    // where it is closed.
    //
    // ON THE COLUMN, NOT ON THE BLOB, which is the other half of the fix. This
    // needs no mail.key and no decrypt, so it refuses correctly even on an
    // install whose key is missing or has been restored from the wrong backup
    // -- the two states in which the decrypt-and-narrow below would throw
    // something about credentials being unreadable over a request whose real
    // problem is that this mailbox has no password to set.
    if (wantsPasswordChange && locked.authMethod !== "password") {
      throw new MailCredentialKindError(id, "oauth");
    }

    let credentialsCiphertext = freshCredentialsCiphertext;
    if (credentialsCiphertext === undefined && wantsSmtpPasswordAloneChange) {
      // The ciphertext holds BOTH imap+smtp passwords as one JSON blob (GCM
      // is atomic over the whole payload), so changing only smtp still
      // requires decrypting the current pair to carry imap forward
      // unchanged -- decrypting the row THIS transaction holds a lock on,
      // not a pre-transaction read, is what makes this race-safe (see the
      // doc comment above).
      // mustBePasswordCredentials, not a cast, and it is no longer the guard --
      // the auth_method check above is, and it fires before this line for every
      // OAuth account without touching mail.key. What remains here is the
      // NARROWING the type system needs (decryptCredentialsAt returns the
      // union; this branch wants `.imapPassword`) plus a fail-closed backstop
      // for the one state the column check cannot see: a row whose auth_method
      // says 'password' over a blob that is not one. That is exactly what
      // MailCredentialKindError was written for, and a cast here would turn it
      // into an undefined password sealed into a new blob.
      const current = mustBePasswordCredentials(
        decryptCredentialsAt(mailKeyPath, locked.credentialsCiphertext), id,
      );
      credentialsCiphertext = encryptCredentialsAt(mailKeyPath, {
        imapPassword: current.imapPassword,
        smtpPassword: smtpPassword as string,
      });
    }

    // A stale last_error must not survive a fix, but an unrelated edit (e.g.
    // relabelling the account) must not fake-heal a genuinely still-broken
    // connection either -- so the reset is gated on whether something that
    // could plausibly have fixed the connection actually changed.
    const connectionFieldChanged = changedKeys.some((k) => (CONNECTION_FIELDS as readonly string[]).includes(k))
      || wantsPasswordChange;
    const shouldResetStatus = locked.status === "error" && connectionFieldChanged;

    let updated: MailAccountRow | undefined;
    try {
      [updated] = await tx.update(mailAccounts).set({
        ...normalizedRest,
        updatedAt: new Date(),
        ...(credentialsCiphertext !== undefined ? { credentialsCiphertext } : {}),
        ...(shouldResetStatus ? { status: "active" as const, lastError: null } : {}),
        // isNull(archivedAt) here is defence in depth, not the primary
        // guard -- the FOR UPDATE lock above plus the archivedAt check just
        // above already make an archive landing mid-update impossible. It
        // stays so a future edit that adds another writer without taking
        // the same lock still fails closed (zero rows, not a silent update
        // of an archived row) instead of relying solely on this function's
        // own discipline.
      }).where(and(eq(mailAccounts.id, id), isNull(mailAccounts.archivedAt))).returning();
    } catch (err) {
      // mail_accounts_user_email_active_unique: only reachable here when
      // email is part of this patch (it is the sole unique constraint on
      // this table, and nothing else in this statement touches user_id or
      // archived_at).
      if (isUniqueViolation(err)) {
        throw new ConflictError("mail account", normalizedRest.email ?? locked.email, DUPLICATE_MAILBOX_MESSAGE);
      }
      throw err;
    }
    if (updated === undefined) {
      const [recheck] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id));
      if (recheck === undefined) throw new NotFoundError("mail account", id);
      throw new ArchivedError("mail account", id);
    }
    return {
      row: updated, wrote: true, connectionChanged: connectionFieldChanged,
      visibilityChanged: changedKeys.includes("visibility"),
    };
  });
  if (wrote) {
    // Restarts the AccountSync when a connection field moved, so it picks up
    // the new settings/credentials and drops any backoff it was sitting in
    // after the status reset; otherwise just wakes it, since the running
    // loop re-reads the account row on its very next pass anyway.
    notifyAccountChanged(id, { connectionChanged });
    // A visibility flip changes what EVERY user's thread list, unread badge
    // and RECORD TIMELINE contain (the Phase 4.2 predicate reads this
    // column), not just this account's settings row -- so the one post-commit
    // publish widens to carry those key families beside the accounts key.
    // `["events"]` joined them in Phase 5 Task 4: a timeline's mail entries
    // are filtered through that same predicate at read time
    // (services/timeline.ts), so flipping shared -> private must retire them
    // from other users' timelines as surely as from their thread lists, and
    // private -> shared must make them appear. A cached timeline is never a
    // leak -- the server re-filters every request, so a stale client holds
    // only what it was already entitled to see -- but it would go on offering
    // a click through to a thread that is no longer there.
    // Same-value patches never reach here (the no-op short-circuit above),
    // so toggling nothing publishes nothing.
    publishAccountsHint(visibilityChanged ? [["mail-threads"], ["mail-unread"], ["events"]] : []);
  }
  return toMailAccount(row);
}

/** Archive-not-delete: sets archived_at, never removes the row (its messages
 * stay -- spec). Idempotent and race-safe via the same WHERE-guarded
 * conditional update, wrapped in one transaction with its recheck fallback
 * (companies.ts's setArchived precedent: both the UPDATE and the recheck
 * read/write through the same `tx`), as archiveCompany: a concurrent archive
 * between mustGetOwned and this UPDATE yields zero rows, in which case the
 * current (already-archived) state is re-read and returned rather than
 * treated as an error -- and that branch must not publish, same as any
 * other no-op short-circuit in this file. unarchiveAccount below is the
 * mirror -- re-adding the same mailbox as a brand-new account row instead
 * would re-ingest every message under a new account_id and duplicate every
 * thread it touches, so archiving needs a real way back rather than being
 * terminal. */
export async function archiveAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  const existing = await mustGetOwned(db, actorId, id);
  if (existing.archivedAt !== null) return toMailAccount(existing);

  const { row, wrote } = await db.transaction(async (tx) => {
    const [updated] = await tx.update(mailAccounts)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.archivedAt)))
      .returning();
    if (updated === undefined) {
      const [recheck] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id));
      if (recheck === undefined) throw new NotFoundError("mail account", id);
      return { row: recheck, wrote: false };
    }
    return { row: updated, wrote: true };
  });
  if (wrote) {
    // Tears down this account's AccountSync (spec: archiving stops its sync).
    notifyAccountChanged(id, { connectionChanged: true });
    publishAccountsHint();
  }
  return toMailAccount(row);
}

/** Mirror of archiveAccount: clears archived_at, same owner check, same
 * idempotent/race-safe WHERE-guarded pattern wrapped in one transaction.
 * Deliberately does NOT touch status/last_error -- an account archived
 * while erroring un-archives still erroring, which is correct (nothing
 * about unarchiving fixed the connection); the ArchivedError guard on
 * updateAccount/testConnection is what actually re-enables editing/testing
 * it. */
export async function unarchiveAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  const existing = await mustGetOwned(db, actorId, id);
  if (existing.archivedAt === null) return toMailAccount(existing);

  const { row, wrote } = await db.transaction(async (tx) => {
    const [updated] = await tx.update(mailAccounts)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(mailAccounts.id, id), isNotNull(mailAccounts.archivedAt)))
      .returning();
    if (updated === undefined) {
      const [recheck] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id));
      if (recheck === undefined) throw new NotFoundError("mail account", id);
      return { row: recheck, wrote: false };
    }
    return { row: updated, wrote: true };
  });
  if (wrote) {
    // Starts an AccountSync for this account again.
    notifyAccountChanged(id, { connectionChanged: true });
    publishAccountsHint();
  }
  return toMailAccount(row);
}

/** Read-only, owner-scoped, and decrypts NOTHING -- the credential ciphertext
 * never leaves this module except through getAccountCredentialsAsSystem below. */
export async function getOwnAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  return toMailAccount(await mustGetOwned(db, actorId, id));
}

/**
 * The ONLY decrypt path in this service. Named "AsSystem" (not
 * getAccountCredentials) deliberately: the name itself has to carry that
 * there is NO owner check here, unlike every other exported function in
 * this file. Callers are system processes acting on an accountId they
 * already know is theirs to operate on -- sync/send (background work with
 * no HTTP actor to own-check against) -- and testConnection's accountId
 * branch below, which does its own owner check BEFORE reaching for
 * credentials, same as any other mutating-adjacent path in this file.
 * Archived accounts are rejected: archiving stops sync and hides an account
 * from compose (spec), so no legitimate system caller should ever be
 * decrypting an archived account's credentials -- if one does, that is a
 * caller bug this guard surfaces immediately instead of silently handing
 * back a password nothing should be using anymore.
 */
export async function getAccountCredentialsAsSystem(
  db: Database, id: string, mailKeyPath: string,
): Promise<MailCredentials> {
  const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  if (row === undefined) throw new NotFoundError("mail account", id);
  if (row.archivedAt !== null) throw new ArchivedError("mail account", id);
  return decryptCredentialsAt(mailKeyPath, row.credentialsCiphertext);
}

/**
 * Shape: `{ own, others }` rather than one discriminated flat list. Task 9's
 * settings page only ever wants the caller's own accounts (to render
 * edit/test/archive controls) and never needs to distinguish "is this mine"
 * per row if the two collections are already split; Task 10's inbox filter
 * bar wants the union (own accounts to filter by directly, others' id/label/
 * email to label threads sent through an account the current user does not
 * own) and can trivially concatenate. A flat discriminated-union list would
 * make BOTH call sites re-filter/narrow on every read for no benefit.
 *
 * Neither collection filters archived accounts out at the SERVICE layer.
 * `own` needs them so the settings page can show an account the user
 * archived (e.g. to confirm it took effect). `others` needs them too, for a
 * different reason: a summary leaks nothing (id/label/email only, same as
 * an active one), and the spec keeps an archived account's messages --
 * Task 10 still has to label threads sent through a now-archived account of
 * someone else's, so dropping it from `others` would leave those threads
 * unable to name their own account. Task 10's account FILTER PICKER
 * (choosing which account to filter the inbox by, as opposed to labelling
 * an already-rendered thread) is a different concern with a different
 * answer -- it should exclude the caller's OWN archived accounts (nothing
 * new will ever arrive through one to filter for) while still accepting
 * `others` entries for labelling; that distinction belongs in the UI layer,
 * not here, since "list every account so its label is available" and
 * "offer this account as a filter option" are genuinely different
 * questions this one read cannot answer for both callers at once.
 *
 * Column selection: `others` rows are select()ed with an explicit column
 * list (id/label/email only) rather than the full row -- another user's
 * credentials_ciphertext has no business ever entering this process's
 * memory, even transiently and even though toSummary would have discarded
 * it before the response left this function (routes/users.ts's plain
 * listing is the precedent for this narrow-select style).
 */
export async function listAccounts(db: Database, actorId: string): Promise<MailAccountList> {
  const ownRows = await db.select().from(mailAccounts)
    .where(eq(mailAccounts.userId, actorId))
    .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id));
  const otherRows = await db
    .select({ id: mailAccounts.id, label: mailAccounts.label, email: mailAccounts.email })
    .from(mailAccounts)
    .where(ne(mailAccounts.userId, actorId))
    .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id));
  return {
    own: ownRows.map(toMailAccount),
    others: otherRows.map(toSummary),
  } satisfies MailAccountList;
}

/** One protocol's connection settings, as testConnection resolves them (and
 * as mail-imapflow.ts's real imapVerify/smtpVerify consume them). Exported so
 * the adapter can name the type rather than redeclare it and hope the two
 * stay identical.
 *
 * `password: string` BECAME `auth: MailConnectionAuth` IN TASK 3, which is the
 * change mail-imapflow.ts's verifyAuth said would be Task 3's and not an
 * oversight. Until now the only credential this endpoint could reach was a
 * stored password, because an OAuth account could not exist; now one can, and
 * "test this connection" has to mean the same thing for both. It is the same
 * type the sync engine and the send path already resolve to
 * (mail-imap.ts's MailConnectionAuth), so there is one answer to "what
 * authenticates a connection" rather than one per entry point. */
export interface VerifySettings {
  host: string; port: number; security: MailSecurity; username: string;
  auth: MailConnectionAuth;
}
export interface TestConnectionDeps {
  // Resolve on a successful login, reject with an Error otherwise -- mirrors
  // nodemailer's transporter.verify() (the real Task 6 implementation).
  imapVerify: (settings: VerifySettings) => Promise<void>;
  smtpVerify: (settings: VerifySettings) => Promise<void>;
  /**
   * How an OAuth account's refresh token becomes an access token to test with.
   *
   * OPTIONAL, AND THE DEFAULT IS A REFUSAL RATHER THAN A NO-OP -- the same
   * arrangement, and the same reasoning, as mail-sync.ts's and mail-send.ts's
   * (mail-oauth.ts's unconfiguredTokenRefresher). Every password account tests
   * without touching it, which is every account on this deployment, so a caller
   * that never signs in at a provider passes nothing; a caller that does and
   * forgot gets a readable sentence in the result rather than a TypeError.
   */
  refresh?: MailTokenRefresher;
  /** The clock the token's expiry is compared against. Defaults to the real
   * one; a test moves it rather than waiting an hour. */
  now?: () => Date;
}
type ProtocolTestResult = MailAccountTestResult["imap"];

const CREDENTIALS_UNREADABLE = "credentials unreadable";

async function runVerify(verify: () => Promise<void>): Promise<ProtocolTestResult> {
  try {
    await verify();
    return { ok: true };
  } catch (err) {
    // The underlying verify() implementations (nodemailer/imapflow) report
    // connection-level failures ("Invalid login", ECONNREFUSED, etc.) -- they
    // do not echo the password back in their own error text, and nothing
    // here constructs a message containing one either, so this never leaks a
    // credential into the result the client sees.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A submitted password as a connection credential, or undefined when there is
 * no submission. One function so the two protocol halves cannot spell the same
 * wrapping two different ways. */
function passwordAuth(password: string | undefined): MailConnectionAuth | undefined {
  return password === undefined ? undefined : { kind: "password", password };
}

/**
 * What the stored credential authenticates each protocol with -- or, when it
 * cannot, the ONE SENTENCE both protocols report.
 *
 * A RESULT RATHER THAN A THROW, for the reason the old broad catch here existed:
 * somebody pressing "Test connection" on a broken account needs the answer, not
 * an error page. What changed in Task 3 is that there are now two genuinely
 * different answers behind that, and collapsing them was the wrong-words problem
 * Task 2 named:
 *
 * - "credentials unreadable" is about mail.key. It covers a missing key file, a
 *   key that no longer decrypts this row (a restore, a rotation), and a
 *   ciphertext that is not structurally v1 -- three causes with one remedy, and
 *   the remedy is to submit a fresh password, which is why the wording steers
 *   there. Deliberately broad, unchanged.
 * - A DEAD OR UNRENEWABLE GRANT is not that. The row decrypted perfectly and the
 *   provider refused, or could not be reached, or this install has no
 *   registration to ask with. Reporting mail.key for any of those would send an
 *   operator to a file that is fine. So the token layer's own message is
 *   carried through, and it is already written for an operator to read
 *   (MailReauthRequiredError's ends "Sign in again to resume syncing").
 *
 * NO TOKEN CAN REACH THE STRING. Everything returned here is either the fixed
 * CREDENTIALS_UNREADABLE constant or an error message from mail-oauth.ts, which
 * redacts this request's own secrets out of provider text and never adds one
 * itself (that module's `redact`, and MailReauthRequiredError's own note).
 */
async function resolveStoredAuth(
  db: Database, account: MailAccountRow, mailKeyPath: string, deps: TestConnectionDeps,
): Promise<{ imap: MailConnectionAuth; smtp: MailConnectionAuth } | { failure: string }> {
  let credentials: MailCredentials;
  try {
    credentials = decryptCredentialsAt(mailKeyPath, account.credentialsCiphertext);
  } catch {
    // MailKeyMissingError, MailCredentialDecryptError, and the plain Error a
    // non-v1 ciphertext throws. See above for why they share one answer.
    return { failure: CREDENTIALS_UNREADABLE };
  }
  const authDeps = {
    db, mailKeyPath,
    refresh: deps.refresh ?? unconfiguredTokenRefresher,
    now: deps.now ?? (() => new Date()),
  };
  try {
    const imap = await resolveConnectionAuth(authDeps, account, credentials, "imap");
    // ONE RESOLUTION FOR AN OAUTH ACCOUNT, TWO FOR A PASSWORD ONE, and the
    // asymmetry is the contract rather than an optimisation. An OAuth account
    // has a single access token that authenticates both protocols (see
    // resolveConnectionAuth: "there is nothing to pick"), while a password
    // account has two halves and getting them the wrong way round is a failure
    // that only shows up at the server.
    //
    // ASKING TWICE WOULD BE WORSE THAN WASTEFUL. `credentials` is one in-memory
    // value, so a second call sees the SAME expired token and refreshes again --
    // two grants against one refresh token, of which persistRefreshedToken's
    // compare-and-set then keeps exactly one. At a provider that rotates
    // (Microsoft always does) the discarded one may be the grant that retired
    // the stored one, which is the unrecoverable case that write exists to
    // avoid. Pressing "Test connection" must not be the thing that strands an
    // account.
    const smtp = imap.kind === "oauth"
      ? imap
      : await resolveConnectionAuth(authDeps, account, credentials, "smtp");
    return { imap, smtp };
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dry-runs an IMAP + SMTP login without persisting anything. Two shapes of
 * input (mailAccountTestInputSchema's superRefine: accountId XOR the full
 * connection field set):
 *
 * - With accountId: owner-checked, archived accounts rejected (same as
 *   updateAccount -- an archived account cannot be tested any more than it
 *   can be edited). Non-credential fields (host/port/security/username)
 *   default from the stored row, overridable by anything the caller
 *   submits. The stored ciphertext is decrypted lazily -- only when the
 *   caller did NOT submit `password` -- specifically so that testing a
 *   *replacement* password after mail.key was lost/rotated (the exact
 *   scenario where decrypting the OLD ciphertext would fail) still works:
 *   a fully-overridden test never touches the broken ciphertext at all. When
 *   decryption IS attempted and fails, for ANY reason (missing key, wrong
 *   key, or a structurally-invalid ciphertext), that surfaces as a normal
 *   per-protocol `{ok: false, error: "credentials unreadable"}` result for
 *   BOTH protocols -- never a thrown error -- because a user testing a
 *   broken account needs the answer, not an error page.
 * - Without accountId: submitted fields are used directly.
 *   mailAccountTestInputSchema's superRefine already requires the full
 *   connection set in this shape, so routes/mail.ts (Task 7) cannot reach
 *   the IncompleteTestConnectionSettingsError branch below -- it is a
 *   defensive guard for a direct service caller that bypasses the schema
 *   (e.g. a test), not a reachable route outcome.
 *
 * AN OAUTH ACCOUNT IS TESTED WITH A TOKEN (Phase 8 Task 3), which is the item
 * Task 2 left here in as many words: this endpoint used to answer "credentials
 * unreadable" for one, and that was the right OUTCOME under the wrong words --
 * the credential read perfectly, there was simply no password to try and, until
 * Task 2, nothing to try instead. There is now. The token resolution is the
 * same resolveConnectionAuth the sync loop and the send path use, so what this
 * endpoint proves is what a real connection would do rather than an
 * approximation of it -- including a dead grant, which arrives here as the same
 * "sign in again" sentence the Settings row carries.
 */
export async function testConnection(
  db: Database, actorId: string, input: MailAccountTestInput, mailKeyPath: string, deps: TestConnectionDeps,
): Promise<MailAccountTestResult> {
  let account: MailAccountRow | undefined;
  let storedImapAuth: MailConnectionAuth | undefined;
  let storedSmtpAuth: MailConnectionAuth | undefined;
  let isOAuth = false;

  if (input.accountId !== undefined) {
    account = await mustGetOwned(db, actorId, input.accountId);
    if (account.archivedAt !== null) throw new ArchivedError("mail account", input.accountId);
    // On the COLUMN, not on the decrypted blob: this decides whether to read
    // mail.key at all, so it cannot depend on having read it.
    isOAuth = account.authMethod !== "password";

    // A SUBMITTED PASSWORD IS IGNORED FOR AN OAUTH ACCOUNT, rather than
    // short-circuiting the stored credential as it does for a password one.
    // The override exists so a REPLACEMENT password can be tested after
    // mail.key was lost -- a repair that has no meaning here, because this
    // account will never authenticate with a password whatever the test says.
    // Honouring one would report success for a login the account cannot make,
    // which is worse than any refusal.
    const needsStored = input.password === undefined || isOAuth;
    if (needsStored) {
      const resolved = await resolveStoredAuth(db, account, mailKeyPath, deps);
      if ("failure" in resolved) {
        return { imap: { ok: false, error: resolved.failure }, smtp: { ok: false, error: resolved.failure } };
      }
      storedImapAuth = resolved.imap;
      storedSmtpAuth = resolved.smtp;
    }
  }

  const imapHost = input.imapHost ?? account?.imapHost;
  const imapPort = input.imapPort ?? account?.imapPort;
  const imapSecurity = (input.imapSecurity ?? account?.imapSecurity) as MailSecurity | undefined;
  const smtpHost = input.smtpHost ?? account?.smtpHost;
  const smtpPort = input.smtpPort ?? account?.smtpPort;
  const smtpSecurity = (input.smtpSecurity ?? account?.smtpSecurity) as MailSecurity | undefined;
  const username = input.username ?? account?.username;
  // TWO PRECEDENCES, AND WHICH ONE APPLIES IS THE ACCOUNT'S AUTH METHOD.
  //
  // For a password account, a submission WINS over storage, unchanged from
  // before Phase 8: an explicit smtpPassword covers SMTP, else the single
  // password field covers both protocols, else the stored pair. That ordering
  // is what makes "test a replacement password against an account whose stored
  // ciphertext no longer decrypts" work, and what makes the smtpPassword-alone
  // case test the override against the stored IMAP half.
  //
  // For an OAuth account, STORAGE WINS and there is nothing to fall back to:
  // see `needsStored` above for why honouring a submitted password there would
  // report on a login the account cannot make.
  const imapAuth = isOAuth ? storedImapAuth : (passwordAuth(input.password) ?? storedImapAuth);
  const smtpAuth = isOAuth
    ? storedSmtpAuth
    : (passwordAuth(input.smtpPassword ?? input.password) ?? storedSmtpAuth);

  if (imapHost === undefined || imapPort === undefined || imapSecurity === undefined
    || username === undefined || imapAuth === undefined) {
    throw new IncompleteTestConnectionSettingsError(
      "testConnection: incomplete IMAP settings (missing accountId or required fields)",
    );
  }
  if (smtpHost === undefined || smtpPort === undefined || smtpSecurity === undefined
    || smtpAuth === undefined) {
    throw new IncompleteTestConnectionSettingsError(
      "testConnection: incomplete SMTP settings (missing accountId or required fields)",
    );
  }

  const [imap, smtp] = await Promise.all([
    runVerify(() => deps.imapVerify({ host: imapHost, port: imapPort, security: imapSecurity, username, auth: imapAuth })),
    runVerify(() => deps.smtpVerify({ host: smtpHost, port: smtpPort, security: smtpSecurity, username, auth: smtpAuth })),
  ]);
  return { imap, smtp } satisfies MailAccountTestResult;
}
