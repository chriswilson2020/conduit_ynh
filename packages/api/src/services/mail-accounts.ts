import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import type {
  MailAccount, MailAccountCreateInput, MailAccountUpdateInput, MailAccountTestInput,
  MailAccountSummary, MailSecurity, MailAccountStatus,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, type MailAccountRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
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

function toMailAccount(row: MailAccountRow): MailAccount {
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
  };
}

function toSummary(row: MailAccountRow): MailAccountSummary {
  return { id: row.id, label: row.label, email: row.email };
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

export async function createAccount(
  db: Database, actorId: string, input: MailAccountCreateInput, mailKeyPath: string,
): Promise<MailAccount> {
  // "SMTP differs" toggle: when the form's smtpPassword override is absent,
  // the single password field covers both protocols (spec, Key handling).
  const credentialsCiphertext = encryptCredentialsAt(mailKeyPath, {
    imapPassword: input.password,
    smtpPassword: input.smtpPassword ?? input.password,
  });
  const [row] = await db.insert(mailAccounts).values({
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
  if (row === undefined) throw new Error("insert returned no row");
  // Task 5 wires accountChanged here (start a new AccountSync for this account).
  publishAccountsHint();
  return toMailAccount(row);
}

/**
 * Service-level update input: the shared mailAccountUpdateInputSchema
 * deliberately excludes password/smtpPassword (see its comment in
 * packages/shared) because "blank means keep the stored value" is a
 * service-layer concern, not something a static wire schema can express. The
 * route layer (Task 7) is the "call site" that validates password/
 * smtpPassword separately and merges them in here.
 */
export interface UpdateAccountInput extends MailAccountUpdateInput {
  password?: string;
  smtpPassword?: string;
}

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
 */
export async function updateAccount(
  db: Database, actorId: string, id: string, patch: UpdateAccountInput, mailKeyPath: string,
): Promise<MailAccount> {
  const existing = await mustGetOwned(db, actorId, id);
  if (existing.archivedAt !== null) throw new ArchivedError("mail account", id);

  const { password, smtpPassword, ...rest } = patch;
  // Same-value patches are a true no-op (no write, no SSE hint) -- mirrors
  // companies.ts's updateCompany. Only fields that actually differ count;
  // rest's keys are a subset of MailAccountRow's own field names (checked
  // structurally by the compiler), so indexing `existing[k]` is safe.
  const changedKeys = (Object.keys(rest) as (keyof MailAccountUpdateInput)[])
    .filter((k) => rest[k] !== undefined && rest[k] !== existing[k]);
  // Empty/absent password fields mean "keep stored" (spec, Key handling); a
  // non-empty submission always counts as an intended change even if it
  // happens to match the old plaintext -- we do not decrypt just to compare.
  const wantsPasswordChange = (password ?? "") !== "" || (smtpPassword ?? "") !== "";

  if (changedKeys.length === 0 && !wantsPasswordChange) return toMailAccount(existing);

  // A stale last_error must not survive a fix, but an unrelated edit (e.g.
  // relabelling the account) must not fake-heal a genuinely still-broken
  // connection either -- so the reset is gated on whether something that
  // could plausibly have fixed the connection actually changed.
  const connectionFieldChanged = changedKeys.some((k) => (CONNECTION_FIELDS as readonly string[]).includes(k))
    || wantsPasswordChange;
  const shouldResetStatus = existing.status === "error" && connectionFieldChanged;

  // SELECT (for the decrypt-and-carry-forward branch below) -> decrypt ->
  // UPDATE is a read-modify-write on the same row: two concurrent updates
  // that both only touch smtpPassword would otherwise both decrypt the same
  // pre-transaction snapshot and the loser's imap half silently reverts to
  // stale data. Wrapping in a transaction and re-reading fresh (see the
  // smtpPassword-alone branch below) closes that window; companies.ts's
  // updateCompany is the precedent for wrapping the mutating half of an
  // update in a transaction while the initial ownership/archived check
  // above stays outside it.
  const row = await db.transaction(async (tx) => {
    let credentialsCiphertext: string | undefined;
    if (password !== undefined && password !== "") {
      // Fully determined by the submission -- covers both protocols (smtp
      // too, unless overridden below) -- so this branch never reads the
      // stored ciphertext at all. That is what makes a key-rotated (no
      // longer decryptable) account recoverable: submit a fresh password
      // and the broken stored blob is simply overwritten, never decrypted.
      credentialsCiphertext = encryptCredentialsAt(mailKeyPath, {
        imapPassword: password,
        smtpPassword: smtpPassword !== undefined && smtpPassword !== "" ? smtpPassword : password,
      });
    } else if (smtpPassword !== undefined && smtpPassword !== "") {
      // smtpPassword alone: only smtp changes, so the stored imap half must
      // be carried forward -- the one remaining case that still needs to
      // decrypt. Re-read inside the transaction (not the `existing` read
      // from before it started) so a concurrent password change landing in
      // between is not silently clobbered by encrypting a stale imap half.
      const [fresh] = await tx.select().from(mailAccounts).where(eq(mailAccounts.id, id));
      if (fresh === undefined) throw new NotFoundError("mail account", id);
      const current = decryptCredentialsAt(mailKeyPath, fresh.credentialsCiphertext);
      credentialsCiphertext = encryptCredentialsAt(mailKeyPath, {
        imapPassword: current.imapPassword,
        smtpPassword,
      });
    }

    const [updated] = await tx.update(mailAccounts).set({
      ...rest,
      // Same write-path sanitization as createAccount -- see its comment.
      // Only overrides rest.signatureHtml when it is a non-null string; an
      // explicit null (clearing the signature) or an absent key both pass
      // through the spread above unchanged.
      ...(rest.signatureHtml != null ? { signatureHtml: sanitizeMailHtml(rest.signatureHtml) } : {}),
      updatedAt: new Date(),
      ...(credentialsCiphertext !== undefined ? { credentialsCiphertext } : {}),
      ...(shouldResetStatus ? { status: "active" as const, lastError: null } : {}),
    }).where(eq(mailAccounts.id, id)).returning();
    if (updated === undefined) throw new NotFoundError("mail account", id);
    return updated;
  });
  // Task 5 wires accountChanged here (restart the AccountSync so it picks up
  // new settings/credentials, or clears its backoff after the status reset).
  publishAccountsHint();
  return toMailAccount(row);
}

/** Archive-not-delete: sets archived_at, never removes the row (its messages
 * stay -- spec). Idempotent and race-safe via the same WHERE-guarded
 * conditional update as companies.ts's setArchived: a concurrent archive
 * between mustGetOwned and this UPDATE yields zero rows, in which case the
 * current (already-archived) state is re-read and returned rather than
 * treated as an error. unarchiveAccount below is the mirror -- re-adding
 * the same mailbox as a brand-new account row instead would re-ingest every
 * message under a new account_id and duplicate every thread it touches, so
 * archiving needs a real way back rather than being terminal. */
export async function archiveAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  const existing = await mustGetOwned(db, actorId, id);
  if (existing.archivedAt !== null) return toMailAccount(existing);

  const [row] = await db.update(mailAccounts)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(mailAccounts.id, id), isNull(mailAccounts.archivedAt)))
    .returning();
  if (row === undefined) {
    const [recheck] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    if (recheck === undefined) throw new NotFoundError("mail account", id);
    return toMailAccount(recheck);
  }
  // Task 5 wires accountChanged here (tear down this account's AccountSync).
  publishAccountsHint();
  return toMailAccount(row);
}

/** Mirror of archiveAccount: clears archived_at, same owner check, same
 * idempotent/race-safe WHERE-guarded pattern. Deliberately does NOT touch
 * status/last_error -- an account archived while erroring un-archives still
 * erroring, which is correct (nothing about unarchiving fixed the
 * connection); the ArchivedError guard on updateAccount/testConnection is
 * what actually re-enables editing/testing it. */
export async function unarchiveAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  const existing = await mustGetOwned(db, actorId, id);
  if (existing.archivedAt === null) return toMailAccount(existing);

  const [row] = await db.update(mailAccounts)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(mailAccounts.id, id), isNotNull(mailAccounts.archivedAt)))
    .returning();
  if (row === undefined) {
    const [recheck] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    if (recheck === undefined) throw new NotFoundError("mail account", id);
    return toMailAccount(recheck);
  }
  // Task 5 wires accountChanged here (start a new AccountSync for this account again).
  publishAccountsHint();
  return toMailAccount(row);
}

/** Read-only, owner-scoped, and decrypts NOTHING -- the credential ciphertext
 * never leaves this module except through getAccountCredentials below. */
export async function getOwnAccount(db: Database, actorId: string, id: string): Promise<MailAccount> {
  return toMailAccount(await mustGetOwned(db, actorId, id));
}

/**
 * The ONLY decrypt path in this service -- used by sync/send (background
 * work with no HTTP actor to own-check against; the caller already knows
 * which accountId it means to operate on) and by testConnection's
 * accountId branch below (which does its own owner check before calling
 * this). Deliberately takes no actorId: callers that need an owner check
 * must do it themselves (see mustGetOwned) before reaching for credentials.
 */
export async function getAccountCredentials(
  db: Database, id: string, mailKeyPath: string,
): Promise<MailCredentials> {
  const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  if (row === undefined) throw new NotFoundError("mail account", id);
  return decryptCredentialsAt(mailKeyPath, row.credentialsCiphertext);
}

export interface MailAccountList {
  own: MailAccount[];
  others: MailAccountSummary[];
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
 * Neither collection filters archived accounts out. `own` needs them so the
 * settings page can show an account the user archived (e.g. to confirm it
 * took effect). `others` needs them too, for a different reason: a
 * summary leaks nothing (id/label/email only, same as an active one), and
 * the spec keeps an archived account's messages -- Task 10 still has to
 * label threads sent through a now-archived account of someone else's, so
 * dropping it from `others` would leave those threads unable to name their
 * own account.
 */
export async function listAccounts(db: Database, actorId: string): Promise<MailAccountList> {
  const rows = await db.select().from(mailAccounts)
    .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id));
  const own = rows.filter((r) => r.userId === actorId).map(toMailAccount);
  const others = rows.filter((r) => r.userId !== actorId).map(toSummary);
  return { own, others };
}

export interface VerifySettings {
  host: string; port: number; security: MailSecurity; username: string; password: string;
}
export interface TestConnectionDeps {
  // Resolve on a successful login, reject with an Error otherwise -- mirrors
  // nodemailer's transporter.verify() (the real Task 6 implementation).
  imapVerify: (settings: VerifySettings) => Promise<void>;
  smtpVerify: (settings: VerifySettings) => Promise<void>;
}
export interface ProtocolResult { ok: boolean; error?: string; }
export interface TestConnectionResult { imap: ProtocolResult; smtp: ProtocolResult; }

const CREDENTIALS_UNREADABLE = "credentials unreadable";

async function runVerify(verify: () => Promise<void>): Promise<ProtocolResult> {
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
 * input (mailAccountTestInputSchema's refine: accountId XOR imapHost):
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
 *   BOTH protocols -- never a thrown 503 -- because a user testing a broken
 *   account needs the answer, not an error page.
 * - Without accountId: submitted fields are used directly. Fine-grained
 *   "all required fields present" enforcement is the route's job (Task 7,
 *   per the schema's own comment); this only guards against literally
 *   missing values reaching a verify() call with a plain Error, which is a
 *   caller-contract violation rather than a connection-test outcome.
 */
export async function testConnection(
  db: Database, actorId: string, input: MailAccountTestInput, mailKeyPath: string, deps: TestConnectionDeps,
): Promise<TestConnectionResult> {
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
    throw new Error("testConnection: incomplete IMAP settings (missing accountId or required fields)");
  }
  if (smtpHost === undefined || smtpPort === undefined || smtpSecurity === undefined
    || smtpPassword === undefined) {
    throw new Error("testConnection: incomplete SMTP settings (missing accountId or required fields)");
  }

  const [imap, smtp] = await Promise.all([
    runVerify(() => deps.imapVerify({ host: imapHost, port: imapPort, security: imapSecurity, username, password: imapPassword })),
    runVerify(() => deps.smtpVerify({ host: smtpHost, port: smtpPort, security: smtpSecurity, username, password: smtpPassword })),
  ]);
  return { imap, smtp };
}
