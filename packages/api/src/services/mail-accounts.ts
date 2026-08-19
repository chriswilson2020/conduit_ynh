import { and, desc, eq, isNull, isNotNull, ne } from "drizzle-orm";
import type {
  MailAccount, MailAccountCreateInput, MailAccountUpdateInput, MailAccountTestInput,
  MailAccountUpdatePasswordFields, MailAccountSummary, MailAccountList, MailAccountTestResult,
  MailSecurity, MailAccountStatus,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, type MailAccountRow } from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError, IncompleteTestConnectionSettingsError } from "./errors.js";
import { encryptCredentialsAt, decryptCredentialsAt, type MailCredentials } from "./mail-crypto.js";
import { sanitizeMailHtml } from "./mail-content.js";
import { publish } from "./sse.js";

/** Invalidation key every mail-account mutator publishes after its write commits.
 * Mail accounts emit NO events-table rows (mail stays out of the CRM timeline per
 * the Phase 4 spec) -- this SSE hint is the only invalidation signal, driving both
 * the settings page and (via the account-status flip) the inbox's error badge. */
function publishAccountsHint(): void {
  publish({ keys: [["mail-accounts"]] });
}

/**
 * Notified after every account mutation that changes whether or how this
 * account should be syncing: create (start one), update (restart, so the new
 * settings/credentials take effect), archive (tear down), unarchive (start
 * again). mail-sync.ts's SyncManager registers itself here at start() and
 * unregisters at stop().
 *
 * Registration runs in this direction -- the sync engine registering with the
 * accounts service, rather than this file importing the sync engine -- for
 * the same reason stream.ts registers with sse.ts's subscribe() instead of
 * sse.ts importing the route: the mutating service stays independent of the
 * consumer, mail-accounts.ts remains unit-testable with no sync engine in the
 * picture at all, and the two modules do not form an import cycle (mail-sync
 * has to import getAccountCredentialsAsSystem from here).
 */
type AccountChangedHook = (accountId: string) => void;
let accountChangedHook: AccountChangedHook | null = null;

/** Register the hook; returns an unregister function that only clears the
 * hook if it is still the one it installed (sse.ts's subscribe() precedent),
 * so a replaced registration cannot be torn down by a stale unregister. */
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
function notifyAccountChanged(accountId: string): void {
  const hook = accountChangedHook;
  if (hook === null) return;
  try {
    hook(accountId);
  } catch (error) {
    console.error("mail-accounts: account-changed hook threw", { accountId, error });
  }
}

function toMailAccount(row: MailAccountRow) {
  return {
    id: row.id, userId: row.userId, label: row.label, email: row.email,
    imapHost: row.imapHost, imapPort: row.imapPort, imapSecurity: row.imapSecurity as MailSecurity,
    smtpHost: row.smtpHost, smtpPort: row.smtpPort, smtpSecurity: row.smtpSecurity as MailSecurity,
    username: row.username,
    sentFolder: row.sentFolder, signatureHtml: row.signatureHtml, backfillDays: row.backfillDays,
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
      ...(input.sentFolder !== undefined ? { sentFolder: input.sentFolder } : {}),
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
  notifyAccountChanged(row.id);
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
  const normalizedRest = rest.signatureHtml != null
    ? { ...rest, signatureHtml: sanitizeMailHtml(rest.signatureHtml) }
    : rest;
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

  const { row, wrote } = await db.transaction(async (tx) => {
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
    if (changedKeys.length === 0 && !wantsPasswordChange) return { row: locked, wrote: false };

    let credentialsCiphertext = freshCredentialsCiphertext;
    if (credentialsCiphertext === undefined && wantsSmtpPasswordAloneChange) {
      // The ciphertext holds BOTH imap+smtp passwords as one JSON blob (GCM
      // is atomic over the whole payload), so changing only smtp still
      // requires decrypting the current pair to carry imap forward
      // unchanged -- decrypting the row THIS transaction holds a lock on,
      // not a pre-transaction read, is what makes this race-safe (see the
      // doc comment above).
      const current = decryptCredentialsAt(mailKeyPath, locked.credentialsCiphertext);
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
    return { row: updated, wrote: true };
  });
  if (wrote) {
    // Restarts the AccountSync, so it picks up new settings/credentials and
    // drops any backoff it was sitting in after the status reset.
    notifyAccountChanged(id);
    publishAccountsHint();
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
    notifyAccountChanged(id);
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
    notifyAccountChanged(id);
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

interface VerifySettings {
  host: string; port: number; security: MailSecurity; username: string; password: string;
}
export interface TestConnectionDeps {
  // Resolve on a successful login, reject with an Error otherwise -- mirrors
  // nodemailer's transporter.verify() (the real Task 6 implementation).
  imapVerify: (settings: VerifySettings) => Promise<void>;
  smtpVerify: (settings: VerifySettings) => Promise<void>;
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
 */
export async function testConnection(
  db: Database, actorId: string, input: MailAccountTestInput, mailKeyPath: string, deps: TestConnectionDeps,
): Promise<MailAccountTestResult> {
  let account: MailAccountRow | undefined;
  let storedImapPassword: string | undefined;
  let storedSmtpPassword: string | undefined;

  if (input.accountId !== undefined) {
    account = await mustGetOwned(db, actorId, input.accountId);
    if (account.archivedAt !== null) throw new ArchivedError("mail account", input.accountId);

    if (input.password === undefined) {
      try {
        const creds = decryptCredentialsAt(mailKeyPath, account.credentialsCiphertext);
        storedImapPassword = creds.imapPassword;
        storedSmtpPassword = creds.smtpPassword;
      } catch {
        // Deliberately broad: catches MailKeyMissingError, MailCredentialDecryptError,
        // AND the plain Error decryptCredentials throws for a ciphertext that
        // is not even structurally v1 (see mail-crypto.ts) -- every failure
        // mode ends up meaning the same thing to a caller here, "cannot read
        // the stored credentials." This is a test endpoint: someone pressing
        // "Test connection" on a broken account needs an answer, never an
        // unhandled 500.
        return {
          imap: { ok: false, error: CREDENTIALS_UNREADABLE },
          smtp: { ok: false, error: CREDENTIALS_UNREADABLE },
        };
      }
    }
  }

  const imapHost = input.imapHost ?? account?.imapHost;
  const imapPort = input.imapPort ?? account?.imapPort;
  const imapSecurity = (input.imapSecurity ?? account?.imapSecurity) as MailSecurity | undefined;
  const smtpHost = input.smtpHost ?? account?.smtpHost;
  const smtpPort = input.smtpPort ?? account?.smtpPort;
  const smtpSecurity = (input.smtpSecurity ?? account?.smtpSecurity) as MailSecurity | undefined;
  const username = input.username ?? account?.username;
  // Same "SMTP differs" default as create/update: an explicit smtpPassword
  // wins, else the single password field covers both protocols, else fall
  // back to whatever was decrypted from storage above.
  const imapPassword = input.password ?? storedImapPassword;
  const smtpPassword = input.smtpPassword ?? input.password ?? storedSmtpPassword;

  if (imapHost === undefined || imapPort === undefined || imapSecurity === undefined
    || username === undefined || imapPassword === undefined) {
    throw new IncompleteTestConnectionSettingsError(
      "testConnection: incomplete IMAP settings (missing accountId or required fields)",
    );
  }
  if (smtpHost === undefined || smtpPort === undefined || smtpSecurity === undefined
    || smtpPassword === undefined) {
    throw new IncompleteTestConnectionSettingsError(
      "testConnection: incomplete SMTP settings (missing accountId or required fields)",
    );
  }

  const [imap, smtp] = await Promise.all([
    runVerify(() => deps.imapVerify({ host: imapHost, port: imapPort, security: imapSecurity, username, password: imapPassword })),
    runVerify(() => deps.smtpVerify({ host: smtpHost, port: smtpPort, security: smtpSecurity, username, password: smtpPassword })),
  ]);
  return { imap, smtp } satisfies MailAccountTestResult;
}
