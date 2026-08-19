import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  MailAccount, MailAccountCreateInput, MailAccountUpdateInput, MailAccountTestInput,
  MailAccountSummary, MailSecurity, MailAccountStatus,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccounts, type MailAccountRow } from "../db/schema.js";
import { NotFoundError, ArchivedError, MailKeyMissingError, MailCredentialDecryptError } from "./errors.js";
import { encryptCredentialsAt, decryptCredentialsAt, type MailCredentials } from "./mail-crypto.js";
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
    signatureHtml: input.signatureHtml ?? null,
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

  let credentialsCiphertext: string | undefined;
  if (wantsPasswordChange) {
    // The ciphertext holds BOTH imap+smtp passwords as one JSON blob (GCM is
    // atomic over the whole payload -- there is no way to update just one
    // field in place), so changing only one of the two still requires
    // decrypting the current pair to carry the untouched one forward
    // unchanged into the new ciphertext.
    const current = decryptCredentialsAt(mailKeyPath, existing.credentialsCiphertext);
    const next: MailCredentials = {
      imapPassword: password !== undefined && password !== "" ? password : current.imapPassword,
      smtpPassword: smtpPassword !== undefined && smtpPassword !== "" ? smtpPassword : current.smtpPassword,
    };
    credentialsCiphertext = encryptCredentialsAt(mailKeyPath, next);
  }

  // A stale last_error must not survive a fix, but an unrelated edit (e.g.
  // relabelling the account) must not fake-heal a genuinely still-broken
  // connection either -- so the reset is gated on whether something that
  // could plausibly have fixed the connection actually changed.
  const connectionFieldChanged = changedKeys.some((k) => (CONNECTION_FIELDS as readonly string[]).includes(k))
    || wantsPasswordChange;
  const shouldResetStatus = existing.status === "error" && connectionFieldChanged;

  const [row] = await db.update(mailAccounts).set({
    ...rest,
    updatedAt: new Date(),
    ...(credentialsCiphertext !== undefined ? { credentialsCiphertext } : {}),
    ...(shouldResetStatus ? { status: "active" as const, lastError: null } : {}),
  }).where(eq(mailAccounts.id, id)).returning();
  if (row === undefined) throw new NotFoundError("mail account", id);
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
 * treated as an error. There is no unarchive counterpart for mail accounts
 * (unlike companies/deals) -- the spec's route list only ever lists archive. */
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
 * `others` excludes archived accounts (an inactive filter option for an
 * account you cannot manage is just noise) but `own` does NOT filter
 * archived accounts out -- the settings page is exactly where a user needs
 * to see an account they archived, e.g. to confirm it took effect. This
 * asymmetry is intentional, not an oversight.
 */
export async function listAccounts(db: Database, actorId: string): Promise<MailAccountList> {
  const rows = await db.select().from(mailAccounts)
    .orderBy(desc(mailAccounts.createdAt), desc(mailAccounts.id));
  const own = rows.filter((r) => r.userId === actorId).map(toMailAccount);
  const others = rows
    .filter((r) => r.userId !== actorId && r.archivedAt === null)
    .map(toSummary);
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
 *   decryption IS attempted and fails (MailKeyMissingError or
 *   MailCredentialDecryptError), that surfaces as a normal per-protocol
 *   `{ok: false, error: "credentials unreadable"}` result for BOTH
 *   protocols -- never a thrown 503 -- because a user testing a broken
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
      } catch (err) {
        if (err instanceof MailKeyMissingError || err instanceof MailCredentialDecryptError) {
          return {
            imap: { ok: false, error: CREDENTIALS_UNREADABLE },
            smtp: { ok: false, error: CREDENTIALS_UNREADABLE },
          };
        }
        throw err;
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
