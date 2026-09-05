import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { MailAccountCreateInput } from "@conduit/shared";
import { mailAccountSchema, mailAccountSummarySchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccounts } from "../db/schema.js";
import { encryptCredentials, encryptCredentialsAt } from "./mail-crypto.js";
import {
  createAccount, updateAccount, archiveAccount, unarchiveAccount, getOwnAccount, getAccountCredentialsAsSystem,
  listAccounts, testConnection, setAccountChangedHook,
  type TestConnectionDeps, type VerifySettings,
} from "./mail-accounts.js";
import {
  NotFoundError, ArchivedError, ConflictError, MailCredentialDecryptError, MailReauthRequiredError,
} from "./errors.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let actorId: string;
let otherActorId: string;
let dir: string;
let keyPath: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  otherActorId = (await resolveUser(handle.db, { username: "alex", email: null, fullName: null })).id;
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-accounts-"));
  keyPath = path.join(dir, "mail.key");
  await writeFile(keyPath, randomBytes(32));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => { await handle.close(); });

const baseInput: MailAccountCreateInput = {
  label: "Work", email: "chris@example.com",
  imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
  smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
  username: "chris", password: "hunter2",
};

function make(overrides: Partial<MailAccountCreateInput> = {}, actor = actorId) {
  return createAccount(handle.db, actor, { ...baseInput, ...overrides }, keyPath);
}

function okDeps(): TestConnectionDeps {
  return { imapVerify: async () => {}, smtpVerify: async () => {} };
}

/** The password a verify() was handed, or a marker naming what it got instead.
 * A marker rather than a throw or an empty string: an assertion comparing
 * passwords must FAIL loudly, and readably, when a token turns up where a
 * password was expected. */
function passwordOf(settings: VerifySettings): string {
  return settings.auth.kind === "password" ? settings.auth.password : `<oauth:${settings.auth.accessToken}>`;
}

// Test-only backdoors for states the service's own API cannot produce:
// status='error' is Task 5's sync loop's job in real use, and a corrupted
// ciphertext simulates a lost/rotated mail.key against an old row.
async function forceError(id: string): Promise<void> {
  await handle.db.update(mailAccounts).set({ status: "error", lastError: "boom" }).where(eq(mailAccounts.id, id));
}
async function forceReauthRequired(id: string): Promise<void> {
  await handle.db.update(mailAccounts)
    .set({ status: "auth_required", lastError: "microsoft would not renew this account's sign-in" })
    .where(eq(mailAccounts.id, id));
}
// A structurally-valid v1 ciphertext (right segment count, right IV/tag
// lengths) but encrypted under a DIFFERENT key than the one at keyPath, so
// decrypting it fails GCM authentication -- MailCredentialDecryptError, the
// "mail.key was rotated/restored since this row was encrypted" case, not the
// "not even v1-shaped" plain-Error case decryptCredentials also has.
async function corruptCiphertext(id: string): Promise<void> {
  const wrongKeyCiphertext = encryptCredentials(randomBytes(32), { imapPassword: "x", smtpPassword: "x" });
  await handle.db.update(mailAccounts).set({ credentialsCiphertext: wrongKeyCiphertext }).where(eq(mailAccounts.id, id));
}
// A ciphertext that is not even structurally v1 (wrong segment count) --
// decryptCredentials throws a plain Error for this, NOT MailCredentialDecryptError
// (see mail-crypto.ts) -- used to prove testConnection's decrypt catch is
// broad enough to cover this shape too, not just the two typed errors.
async function garbleCiphertext(id: string): Promise<void> {
  await handle.db.update(mailAccounts).set({ credentialsCiphertext: "not-even-v1-shaped" })
    .where(eq(mailAccounts.id, id));
}

describe("createAccount", () => {
  it("creates an account with status active and no credential fields on the returned shape", async () => {
    const account = await make();
    expect(account.status).toBe("active");
    expect(account.label).toBe("Work");
    expect(mailAccountSchema.safeParse(account).success).toBe(true);
    for (const key of Object.keys(account)) {
      expect(key.toLowerCase()).not.toMatch(/password|credential|secret|cipher/);
    }
  });

  // Phase 4.2: every account is BORN private (mail_accounts.visibility's DB
  // default) -- mailAccountCreateInputSchema carries no field to override
  // this at create time (see that schema's own comment), and toMailAccount
  // must surface the DB default back rather than silently dropping the
  // column.
  it("defaults a newly-created account's visibility to private", async () => {
    const account = await make();
    expect(account.visibility).toBe("private");
  });

  it("defaults smtpPassword to password when no override is given", async () => {
    const account = await make({ password: "shared-secret" });
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "shared-secret", smtpPassword: "shared-secret" });
  });

  it("keeps a distinct smtpPassword when the 'SMTP differs' override is given", async () => {
    const account = await make({ password: "imap-secret", smtpPassword: "smtp-secret" });
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "imap-secret", smtpPassword: "smtp-secret" });
  });

  it("applies DB defaults for omitted sentFolder/backfillDays and preserves an explicit null backfillDays", async () => {
    const withDefaults = await make();
    expect(withDefaults.sentFolder).toBe("Sent");
    expect(withDefaults.backfillDays).toBe(90);

    const unlimited = await make({ email: "other@example.com", backfillDays: null });
    expect(unlimited.backfillDays).toBeNull();
  });

  // trashFolder/archiveFolder are update-only (mailAccountUpdateInputSchema's
  // own comment): mailAccountCreateInputSchema never accepts them, so a
  // fresh account always starts out with nothing resolved yet -- folder
  // discovery (Task 2) or a Settings override are the only ways either ever
  // becomes non-null.
  it("starts trashFolder/archiveFolder as null -- nothing is discovered at create time", async () => {
    const account = await make({ email: "fresh@example.com" });
    expect(account).toMatchObject({ trashFolder: null, archiveFolder: null });
  });

  it("trims sent_folder on write, and treats a blank one as absent", async () => {
    // An IMAP mailbox name is compared byte for byte: a stored " Sent " is a
    // different mailbox from "Sent" everywhere it is used -- including
    // mail-ingest's check that an outbound message really is in this
    // account's own sent folder, which is what guards the stored Bcc list.
    const padded = await make({ sentFolder: "  Sent  " });
    expect(padded.sentFolder).toBe("Sent");

    // Whitespace-only is not a mailbox anyone can append to, so it means
    // "not given" and the column default applies.
    const blank = await make({ email: "blank@example.com", sentFolder: "   " });
    expect(blank.sentFolder).toBe("Sent");
  });

  it("publishes the mail-accounts SSE key", async () => {
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await make();
      const flat = hints.flat().map((k) => k.join(":"));
      expect(flat).toContain("mail-accounts");
    } finally {
      unsub();
    }
  });

  it("sanitizes signatureHtml on write: a script tag is stripped", async () => {
    const account = await make({ signatureHtml: "<p>Regards</p><script>alert(1)</script>" });
    expect(account.signatureHtml).not.toContain("<script>");
    expect(account.signatureHtml).toContain("Regards");
  });
});

describe("updateAccount", () => {
  it("updates a non-credential field without touching stored credentials", async () => {
    const account = await make({ password: "original" });
    const updated = await updateAccount(handle.db, actorId, account.id, { label: "Renamed" }, keyPath);
    expect(updated.label).toBe("Renamed");
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    // toMatchObject on the whole value rather than one field: the credential is a
    // union as of Phase 8, and asserting `kind` here is what keeps this test
    // honest about WHICH member survived an unrelated field edit.
    expect(creds).toMatchObject({ kind: "password", imapPassword: "original" });
  });

  it("trims sent_folder on update, and treats a resubmitted padded value as no change", async () => {
    const account = await make({ sentFolder: "Sent" });
    const moved = await updateAccount(handle.db, actorId, account.id, { sentFolder: "  Archive  " }, keyPath);
    expect(moved.sentFolder).toBe("Archive");

    // Normalised BEFORE the same-value diff, like signatureHtml: comparing
    // the raw submission against the stored (already trimmed) value would
    // read " Archive " as a change and fire an unearned SSE hint.
    const resubmitted = await updateAccount(
      handle.db, actorId, account.id, { sentFolder: " Archive " }, keyPath,
    );
    expect(resubmitted.sentFolder).toBe("Archive");
    expect(resubmitted.updatedAt).toBe(moved.updatedAt);
  });

  it("persists trashFolder/archiveFolder overrides, and toMailAccount surfaces them back", async () => {
    const account = await make();
    const withOverrides = await updateAccount(
      handle.db, actorId, account.id, { trashFolder: "Deleted Items", archiveFolder: "Archive" }, keyPath,
    );
    expect(withOverrides).toMatchObject({ trashFolder: "Deleted Items", archiveFolder: "Archive" });

    // Re-fetched from the DB, not just the in-memory return value -- proves
    // the columns actually persisted, not merely that toMailAccount echoed
    // the submitted patch.
    const refetched = await getOwnAccount(handle.db, actorId, account.id);
    expect(refetched).toMatchObject({ trashFolder: "Deleted Items", archiveFolder: "Archive" });

    // An explicit null clears a previously-set override.
    const cleared = await updateAccount(handle.db, actorId, account.id, { trashFolder: null }, keyPath);
    expect(cleared).toMatchObject({ trashFolder: null, archiveFolder: "Archive" });
  });

  // Phase 4.2: the owner-only Private/Shared toggle. Owner-scoping comes free
  // from updateAccount's existing mustGetOwned/locked-row path (no separate
  // guard needed) -- this test is about the FIELD flowing through, not
  // re-proving ownership enforcement, which the "rejects a patch from a
  // non-owner" test elsewhere in this file already covers for every field.
  it("persists a visibility change, and toMailAccount surfaces it back", async () => {
    const account = await make();
    expect(account.visibility).toBe("private");

    const flipped = await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
    expect(flipped.visibility).toBe("shared");

    const refetched = await getOwnAccount(handle.db, actorId, account.id);
    expect(refetched.visibility).toBe("shared");
  });

  it("trims trashFolder/archiveFolder, and reads a resubmitted padded value as no change", async () => {
    const account = await make();
    // An IMAP mailbox name is compared byte for byte by the move service, so
    // " Archive " must not be stored as a second mailbox (Task 4).
    const set = await updateAccount(
      handle.db, actorId, account.id, { trashFolder: " Deleted Items ", archiveFolder: " Archive " }, keyPath,
    );
    expect(set).toMatchObject({ trashFolder: "Deleted Items", archiveFolder: "Archive" });

    // Normalised BEFORE the same-value diff, like sentFolder and the
    // signature: otherwise a resubmitted padded value reads as an edit and
    // fires an unearned SSE hint.
    const resubmitted = await updateAccount(
      handle.db, actorId, account.id, { archiveFolder: "  Archive  " }, keyPath,
    );
    expect(resubmitted.updatedAt).toBe(set.updatedAt);
  });

  it("drops a whitespace-only override rather than storing an unselectable folder name", async () => {
    const account = await make();
    await updateAccount(handle.db, actorId, account.id, { trashFolder: "Trash" }, keyPath);
    // "" is rejected by the shared schema; " " reaches the service, and
    // storing it would leave a target no server can select -- so it is
    // dropped, exactly as a blank sent_folder is. Clearing an override is
    // what an explicit null is for.
    const blanked = await updateAccount(handle.db, actorId, account.id, { trashFolder: "   " }, keyPath);
    expect(blanked.trashFolder).toBe("Trash");
  });

  it("absent/empty password fields keep the stored credentials", async () => {
    const account = await make({ password: "keep-me", smtpPassword: "keep-me-too" });
    await updateAccount(handle.db, actorId, account.id, { label: "Renamed", password: "", smtpPassword: undefined }, keyPath);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "keep-me", smtpPassword: "keep-me-too" });
  });

  // RULING: a lone `password` means BOTH protocols (matches createAccount's
  // and testConnection's "SMTP differs" default) -- the settings form only
  // ever submits smtpPassword alongside password when its toggle is on.
  it("a lone password updates BOTH the imap and smtp password", async () => {
    const account = await make({ password: "imap-old", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { password: "both-new" }, keyPath);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "both-new", smtpPassword: "both-new" });
  });

  it("password + smtpPassword together: smtpPassword wins for smtp, password sets imap", async () => {
    const account = await make({ password: "imap-old", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { password: "imap-new", smtpPassword: "smtp-new" }, keyPath);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "imap-new", smtpPassword: "smtp-new" });
  });

  it("a lone smtpPassword changes only smtp, carrying the stored imap password forward", async () => {
    const account = await make({ password: "imap-unchanged", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { smtpPassword: "smtp-new" }, keyPath);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "imap-unchanged", smtpPassword: "smtp-new" });
  });

  it("a full password submission succeeds even against an undecryptable stored ciphertext (key-rotation recovery)", async () => {
    const account = await make();
    await corruptCiphertext(account.id);
    // password alone is fully self-determining (both halves), computed
    // BEFORE any transaction opens, so this must never need to decrypt the
    // broken stored blob -- the whole point of the lazy-decrypt design is
    // that a lost/rotated mail.key becomes fixable by submitting a fresh
    // password instead of a permanent dead end.
    await updateAccount(handle.db, actorId, account.id, { password: "recovered" }, keyPath);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toEqual({ kind: "password", imapPassword: "recovered", smtpPassword: "recovered" });
  });

  // Item 14 coverage: pins that smtpPassword-ALONE is explicitly NOT a
  // recovery path (unlike the password-present branch above) -- it always
  // decrypts the stored ciphertext to carry imap forward, so a broken blob
  // must surface as a real failure here, not a silent success.
  it("updateAccount({smtpPassword}) against an undecryptable stored ciphertext throws -- not a recovery path", async () => {
    const account = await make();
    await corruptCiphertext(account.id);
    await expect(updateAccount(handle.db, actorId, account.id, { smtpPassword: "new-smtp" }, keyPath))
      .rejects.toBeInstanceOf(MailCredentialDecryptError);
  });

  it("sanitizes signatureHtml on write: a script tag is stripped", async () => {
    const account = await make();
    const updated = await updateAccount(
      handle.db, actorId, account.id, { signatureHtml: "<p>Regards</p><script>alert(1)</script>" }, keyPath,
    );
    expect(updated.signatureHtml).not.toContain("<script>");
    expect(updated.signatureHtml).toContain("Regards");
  });

  // Item 12 regression: the changedKeys diff must compare the SANITIZED
  // submission against the stored (already-sanitized) value, not the raw
  // one -- otherwise resubmitting markup that sanitizes down to exactly
  // what's already stored (e.g. the same signature with a script tag
  // appended by some unrelated client-side quirk) would be misreported as
  // "changed" and fire an unearned write + SSE hint.
  it("a raw signatureHtml resubmission that sanitizes down to the stored value is a true no-op", async () => {
    const account = await make({ signatureHtml: "<p>Hello</p>" });
    const stored = account.signatureHtml;
    expect(stored).not.toBeNull();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      const result = await updateAccount(
        handle.db, actorId, account.id, { signatureHtml: `${stored}<script>alert(1)</script>` }, keyPath,
      );
      expect(result.signatureHtml).toBe(stored);
      expect(result.updatedAt).toBe(account.updatedAt);
      expect(hints).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it("resets an errored account to active and clears last_error when a connection field (imapHost) changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { imapHost: "imap.example.com" }, keyPath);
    expect(updated.status).toBe("active");
    expect(updated.lastError).toBeNull();
  });

  it("resets an errored account when smtpHost changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { smtpHost: "smtp.example.com" }, keyPath);
    expect(updated.status).toBe("active");
    expect(updated.lastError).toBeNull();
  });

  it("resets an errored account when imapSecurity changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { imapSecurity: "starttls" }, keyPath);
    expect(updated.status).toBe("active");
    expect(updated.lastError).toBeNull();
  });

  it("resets an errored account when only the password changes (wantsPasswordChange counts as a connection change)", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { password: "new-password" }, keyPath);
    expect(updated.status).toBe("active");
    expect(updated.lastError).toBeNull();
  });

  /**
   * A NEEDED SIGN-IN IS NOT A STALE ERROR, and the reset must not clear it.
   *
   * shouldResetStatus is gated on `status === 'error'` and the gate is doing
   * real work here rather than being incidentally correct: an OAuth account has
   * a host, a port and a security mode like any other, so an edit to any of
   * them counts as a "connection field change" and would otherwise flip a
   * lapsed grant back to Active. The row would then say the mailbox is fine
   * until the next sync pass, which is the whole failure this state exists to
   * prevent, reintroduced by a relabelling.
   *
   * Whether the grant came back is the sync loop's question, and it answers it
   * on the next pass -- see mail-sync.test.ts's recovery case.
   */
  it("does NOT clear a needed re-authorisation, even when a connection field changes", async () => {
    const account = await make();
    await forceReauthRequired(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { imapHost: "imap.example.com" }, keyPath);
    expect(updated.status).toBe("auth_required");
    expect(updated.lastError).toContain("sign-in");
  });

  it("does NOT reset an errored account when only an unrelated field (label) changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { label: "Renamed only" }, keyPath);
    expect(updated.status).toBe("error");
    expect(updated.lastError).toBe("boom");
  });

  it("does NOT reset an errored account when only backfillDays changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { backfillDays: 30 }, keyPath);
    expect(updated.status).toBe("error");
    expect(updated.lastError).toBe("boom");
  });

  it("does NOT reset an errored account when only signatureHtml changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { signatureHtml: "<p>New sig</p>" }, keyPath);
    expect(updated.status).toBe("error");
    expect(updated.lastError).toBe("boom");
  });

  // Phase 4.2: flipping Private/Shared is not a connection change (mail-
  // accounts.ts's CONNECTION_FIELDS comment) -- same shape as the label/
  // backfillDays/signatureHtml cases above, proving `visibility` was not
  // slipped into CONNECTION_FIELDS by mistake.
  it("does NOT reset an errored account when only visibility changes", async () => {
    const account = await make();
    await forceError(account.id);
    const updated = await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
    expect(updated.status).toBe("error");
    expect(updated.lastError).toBe("boom");
    expect(updated.visibility).toBe("shared");
  });

  it("publishes the mail-accounts SSE key on a real write", async () => {
    const account = await make();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await updateAccount(handle.db, actorId, account.id, { label: "Renamed" }, keyPath);
      const flat = hints.flat().map((k) => k.join(":"));
      expect(flat).toContain("mail-accounts");
    } finally {
      unsub();
    }
  });

  // Phase 4.2: a visibility flip changes what EVERY user's thread list and
  // unread badge contain (the predicate reads mail_accounts.visibility), so
  // its ONE post-commit publish carries the thread-side key families too.
  // Phase 5 Task 4 added `events`: the same predicate decides which mail
  // entries a viewer's RECORD TIMELINE renders, so flipping shared -> private
  // must retire them there as surely as from the thread list, and flipping
  // the other way must make them appear.
  it("publishes mail-accounts, mail-threads, mail-unread and events in one frame when visibility flips", async () => {
    const account = await make();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
      expect(hints).toEqual([[["mail-accounts"], ["mail-threads"], ["mail-unread"], ["events"]]]);
    } finally {
      unsub();
    }
  });

  it("keeps the narrow mail-accounts hint for an edit that does not touch visibility", async () => {
    // The widened frame is earned by the flip alone -- an ordinary Settings
    // edit must not tell every client to refetch every thread list.
    const account = await make();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await updateAccount(handle.db, actorId, account.id, { label: "Renamed" }, keyPath);
      expect(hints).toEqual([[["mail-accounts"]]]);
    } finally {
      unsub();
    }
  });

  it("publishes nothing for a same-value visibility patch", async () => {
    // The no-op short-circuit covers the toggle too: resubmitting the stored
    // value must not fan a refetch-everything frame out to every client.
    const account = await make();
    await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      const result = await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
      expect(result.visibility).toBe("shared");
      expect(hints).toEqual([]);
    } finally {
      unsub();
    }
  });

  it("a same-value patch is a no-op: updatedAt unchanged", async () => {
    const account = await make({ label: "Same" });
    const result = await updateAccount(handle.db, actorId, account.id, { label: "Same" }, keyPath);
    expect(result.updatedAt).toBe(account.updatedAt);
  });

  it("throws NotFoundError for another user's account (existence must not leak)", async () => {
    const account = await make({}, otherActorId);
    await expect(updateAccount(handle.db, actorId, account.id, { label: "X" }, keyPath))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a nonexistent account id, same as a foreign one", async () => {
    await expect(
      updateAccount(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { label: "X" }, keyPath),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to update an archived account", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    await expect(updateAccount(handle.db, actorId, account.id, { label: "X" }, keyPath))
      .rejects.toBeInstanceOf(ArchivedError);
  });
});

describe("updateAccount: concurrency", () => {
  // CRITICAL fix this test pins: updateAccount used to read the account row
  // ONCE, outside any transaction, and decide archived-ness, changedKeys,
  // and the status-reset from that snapshot. A concurrent archiveAccount
  // landing between that read and the eventual UPDATE could commit an
  // update against a row that was archived by the time it actually wrote.
  // The fix (SELECT ... FOR UPDATE inside one transaction, re-deciding
  // everything from the locked row) serializes the two calls on the row
  // lock, leaving exactly two legal outcomes -- never a third, silently
  // inconsistent one.
  it("updateAccount racing archiveAccount: never a silent update against an archived row", async () => {
    const account = await make();
    const [updateResult, archiveResult] = await Promise.allSettled([
      updateAccount(handle.db, actorId, account.id, { label: "Raced" }, keyPath),
      archiveAccount(handle.db, actorId, account.id),
    ]);
    // archiveAccount never throws ArchivedError on its own target (it is
    // idempotent by design), so it always fulfills regardless of ordering.
    expect(archiveResult.status).toBe("fulfilled");

    const final = await getOwnAccount(handle.db, actorId, account.id);
    if (updateResult.status === "fulfilled") {
      // updateAccount's transaction locked and committed BEFORE archive's
      // UPDATE got a chance to run -- archive then proceeds normally
      // afterwards (nothing about updateAccount touches archivedAt), so the
      // account ends up both updated AND archived.
      expect(final.label).toBe("Raced");
      expect(final.archivedAt).not.toBeNull();
    } else {
      // archiveAccount's UPDATE committed first (it does not open a
      // separate FOR UPDATE lock, but a single-statement UPDATE takes an
      // implicit row lock too, so the two still serialize) -- updateAccount
      // then locks the row, sees archivedAt set, and rejects with
      // ArchivedError instead of silently writing over it.
      expect(updateResult.reason).toBeInstanceOf(ArchivedError);
      expect(final.label).toBe("Work"); // untouched
      expect(final.archivedAt).not.toBeNull();
    }
  });

  // CRITICAL fix this test pins: the smtpPassword-alone branch used to
  // decrypt a pre-transaction snapshot of the stored ciphertext to carry
  // the imap half forward. A concurrent password-only update (which sets
  // BOTH halves and is self-determining, never reading the DB) landing
  // around the same time could have its imap change silently reverted by
  // the smtpPassword-alone call re-writing the OLD imap value it read
  // before the race. The fix decrypts the FOR-UPDATE-locked row instead, so
  // whichever call's transaction commits second always sees the first's
  // already-committed write.
  it("password-only update racing smtpPassword-only update: the carried-forward imap half is never stale", async () => {
    const account = await make({ password: "imap-original", smtpPassword: "smtp-original" });
    const [passwordResult, smtpResult] = await Promise.allSettled([
      updateAccount(handle.db, actorId, account.id, { password: "password-call-value" }, keyPath),
      updateAccount(handle.db, actorId, account.id, { smtpPassword: "smtp-call-value" }, keyPath),
    ]);
    expect(passwordResult.status).toBe("fulfilled");
    expect(smtpResult.status).toBe("fulfilled");

    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    // Two legal final states, determined by which transaction's row lock
    // wins (JS scheduling does not decide this):
    //   1. password-call committed first: the smtp-call locks the row
    //      afterwards, decrypts ITS committed value, and carries forward
    //      "password-call-value" for imap -> {imap: "password-call-value",
    //      smtp: "smtp-call-value"}.
    //   2. smtp-call committed first (correctly carrying forward the still-
    //      original imap half, since nothing had changed it yet): the
    //      password-call's ciphertext was computed before either
    //      transaction opened and never reads the DB, so it simply
    //      overwrites both halves -> {imap: "password-call-value", smtp:
    //      "password-call-value"}.
    // What must NEVER happen -- the bug this test pins -- is imap reverting
    // to "imap-original", or smtp remaining at "smtp-original": either
    // would mean a call read a stale pre-transaction snapshot instead of
    // the other's committed write.
    expect(creds).toMatchObject({ kind: "password", imapPassword: "password-call-value" });
    expect(["smtp-call-value", "password-call-value"]).toContain(
      creds.kind === "password" ? creds.smtpPassword : null,
    );
  });
});

describe("archiveAccount", () => {
  it("sets archivedAt and is idempotent", async () => {
    const account = await make();
    const archived = await archiveAccount(handle.db, actorId, account.id);
    expect(archived.archivedAt).not.toBeNull();
    const archivedAgain = await archiveAccount(handle.db, actorId, account.id);
    expect(archivedAgain.archivedAt).toBe(archived.archivedAt);
  });

  it("throws NotFoundError for another user's account", async () => {
    const account = await make({}, otherActorId);
    await expect(archiveAccount(handle.db, actorId, account.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("publishes the mail-accounts SSE key on a real archive", async () => {
    const account = await make();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await archiveAccount(handle.db, actorId, account.id);
      const flat = hints.flat().map((k) => k.join(":"));
      expect(flat).toContain("mail-accounts");
    } finally {
      unsub();
    }
  });
});

describe("unarchiveAccount", () => {
  it("clears archivedAt and is idempotent", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    const unarchived = await unarchiveAccount(handle.db, actorId, account.id);
    expect(unarchived.archivedAt).toBeNull();
    const unarchivedAgain = await unarchiveAccount(handle.db, actorId, account.id);
    expect(unarchivedAgain.archivedAt).toBeNull();
  });

  it("does not heal status/last_error -- unarchiving alone does not fix a broken connection", async () => {
    const account = await make();
    await forceError(account.id);
    await archiveAccount(handle.db, actorId, account.id);
    const unarchived = await unarchiveAccount(handle.db, actorId, account.id);
    expect(unarchived.status).toBe("error");
    expect(unarchived.lastError).toBe("boom");
  });

  it("throws NotFoundError for another user's account", async () => {
    const account = await make({}, otherActorId);
    await archiveAccount(handle.db, otherActorId, account.id);
    await expect(unarchiveAccount(handle.db, actorId, account.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("publishes the mail-accounts SSE key on a real unarchive", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await unarchiveAccount(handle.db, actorId, account.id);
      const flat = hints.flat().map((k) => k.join(":"));
      expect(flat).toContain("mail-accounts");
    } finally {
      unsub();
    }
  });
});

// RULING: duplicate-mailbox prevention -- a user adding the same mailbox
// twice would sync every message a second time under a new account_id,
// duplicating every thread it touches. Backed by drizzle/0004's hand-written
// partial unique index on (user_id, lower(email)) WHERE archived_at IS
// NULL; these tests exercise the SERVICE-level ConflictError mapping (the
// raw constraint itself is covered in db/schema.test.ts).
describe("duplicate-mailbox prevention", () => {
  it("createAccount: a second active account for the same (user, email) is a 409 ConflictError", async () => {
    await make({ email: "chris@example.com" });
    await expect(make({ email: "CHRIS@example.com" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("createAccount: an archived duplicate does not block re-adding the same mailbox", async () => {
    const first = await make({ email: "chris@example.com" });
    await archiveAccount(handle.db, actorId, first.id);
    const second = await make({ email: "chris@example.com" });
    expect(second.id).not.toBe(first.id);
    expect(second.archivedAt).toBeNull();
  });

  it("createAccount: the same email for a DIFFERENT user is allowed (per-user accounts, shared visibility)", async () => {
    await make({ email: "shared@example.com" });
    const theirs = await make({ email: "shared@example.com" }, otherActorId);
    expect(theirs.email).toBe("shared@example.com");
  });

  it("updateAccount: changing email to collide with another of the caller's own active accounts is a 409 ConflictError", async () => {
    await make({ email: "taken@example.com", label: "First" });
    const second = await make({ email: "chris2@example.com", label: "Second" });
    await expect(updateAccount(handle.db, actorId, second.id, { email: "taken@example.com" }, keyPath))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("updateAccount: changing email to match an ARCHIVED account's email is allowed", async () => {
    const first = await make({ email: "was-taken@example.com", label: "First" });
    await archiveAccount(handle.db, actorId, first.id);
    const second = await make({ email: "chris2@example.com", label: "Second" });
    const updated = await updateAccount(handle.db, actorId, second.id, { email: "was-taken@example.com" }, keyPath);
    expect(updated.email).toBe("was-taken@example.com");
  });
});

describe("SSE: no-op mutations publish nothing", () => {
  it("updateAccount with a same-value patch publishes nothing", async () => {
    const account = await make({ label: "Same" });
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await updateAccount(handle.db, actorId, account.id, { label: "Same" }, keyPath);
      expect(hints).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it("archiveAccount on an already-archived account publishes nothing", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await archiveAccount(handle.db, actorId, account.id);
      expect(hints).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it("unarchiveAccount on a non-archived account publishes nothing", async () => {
    const account = await make();
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await unarchiveAccount(handle.db, actorId, account.id);
      expect(hints).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});

describe("getOwnAccount", () => {
  it("returns the account with no credential fields", async () => {
    const account = await make();
    const fetched = await getOwnAccount(handle.db, actorId, account.id);
    expect(fetched).toEqual(account);
  });

  it("throws NotFoundError for another user's account", async () => {
    const account = await make({}, otherActorId);
    await expect(getOwnAccount(handle.db, actorId, account.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a nonexistent account id", async () => {
    await expect(getOwnAccount(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getAccountCredentialsAsSystem", () => {
  it("decrypts stored credentials regardless of who calls it (no owner check -- system callers only)", async () => {
    const account = await make({ password: "sync-secret" }, otherActorId);
    const creds = await getAccountCredentialsAsSystem(handle.db, account.id, keyPath);
    expect(creds).toMatchObject({ kind: "password", imapPassword: "sync-secret" });
  });

  it("throws NotFoundError for a nonexistent account", async () => {
    await expect(getAccountCredentialsAsSystem(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", keyPath))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  // RULING: archived accounts stop sync/send (spec) -- no legitimate system
  // caller should ever be decrypting an archived account's credentials.
  it("throws ArchivedError for an archived account", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    await expect(getAccountCredentialsAsSystem(handle.db, account.id, keyPath)).rejects.toBeInstanceOf(ArchivedError);
  });
});

describe("listAccounts", () => {
  it("returns own accounts in full (minus credentials) and others as id/label/email summaries", async () => {
    const mine = await make({ label: "Mine" });
    const theirs = await make({ label: "Theirs", email: "alex@example.com" }, otherActorId);

    const { own, others } = await listAccounts(handle.db, actorId);
    expect(own.map((a) => a.id)).toEqual([mine.id]);
    expect(own[0]?.imapHost).toBe("localhost"); // full shape, not just id/label/email

    expect(others.map((a) => a.id)).toEqual([theirs.id]);
    expect(Object.keys(others[0] ?? {}).sort()).toEqual(["email", "id", "label"]);
    expect(mailAccountSummarySchema.safeParse(others[0]).success).toBe(true);
  });

  // RULING: archived accounts are NOT filtered out of either collection.
  // `own` so Settings can show the user their own archived account; `others`
  // because a summary leaks nothing beyond an active one, and Task 10 still
  // needs to label threads sent through a now-archived account of someone
  // else's (the spec keeps an archived account's messages).
  it("keeps an archived own account in own, and an archived other-user account in others", async () => {
    const mine = await make({ label: "Mine" });
    await archiveAccount(handle.db, actorId, mine.id);
    const theirs = await make({ label: "Theirs", email: "alex@example.com" }, otherActorId);
    await archiveAccount(handle.db, otherActorId, theirs.id);

    const { own, others } = await listAccounts(handle.db, actorId);
    expect(own.map((a) => a.id)).toContain(mine.id);
    expect(own.find((a) => a.id === mine.id)?.archivedAt).not.toBeNull();
    expect(others.map((a) => a.id)).toContain(theirs.id);
  });

  it("orders both own and others by createdAt descending (newest first)", async () => {
    const a = await make({ label: "A" });
    const b = await make({ label: "B", email: "b@example.com" });
    const theirsA = await make({ label: "TheirsA", email: "ta@example.com" }, otherActorId);
    const theirsB = await make({ label: "TheirsB", email: "tb@example.com" }, otherActorId);

    const { own, others } = await listAccounts(handle.db, actorId);
    expect(own.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(others.map((x) => x.id)).toEqual([theirsB.id, theirsA.id]);
  });
});

describe("testConnection", () => {
  it("without accountId: verifies using the submitted fields and password directly", async () => {
    const calls: unknown[] = [];
    const deps: TestConnectionDeps = {
      imapVerify: async (s) => { calls.push(["imap", s]); },
      smtpVerify: async (s) => { calls.push(["smtp", s]); },
    };
    const result = await testConnection(handle.db, actorId, {
      imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls",
      smtpHost: "smtp.example.com", smtpPort: 587, smtpSecurity: "starttls",
      username: "chris", password: "fresh-secret",
    }, keyPath, deps);
    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    expect(calls).toEqual([
      ["imap", { host: "imap.example.com", port: 993, security: "tls", username: "chris", auth: { kind: "password", password: "fresh-secret" } }],
      ["smtp", { host: "smtp.example.com", port: 587, security: "starttls", username: "chris", auth: { kind: "password", password: "fresh-secret" } }],
    ]);
  });

  it("with accountId and no submitted password: decrypts and uses the stored credentials", async () => {
    const account = await make({ password: "stored-imap", smtpPassword: "stored-smtp" });
    // Protocol-tagged tuples (not bare passwords sorted together): a swapped
    // imap/smtp half -- deps.imapVerify wrongly receiving the smtp password
    // or vice versa -- must fail this assertion, which a plain sorted-set
    // comparison could never catch.
    const calls: [string, string][] = [];
    const deps: TestConnectionDeps = {
      imapVerify: async (s) => { calls.push(["imap", passwordOf(s)]); },
      smtpVerify: async (s) => { calls.push(["smtp", passwordOf(s)]); },
    };
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, deps);
    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    const sorted = [...calls].sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted).toEqual([["imap", "stored-imap"], ["smtp", "stored-smtp"]]);
  });

  // Item 14 coverage: the accountId+smtpPassword-alone combination -- smtp
  // uses the submitted override, imap falls back to the decrypted stored
  // password (distinct from updateAccount's OWN smtpPassword-alone
  // semantics, which never has a submitted imap override to fall back
  // to -- this is testConnection's own branch, exercised on its own).
  it("with accountId and smtpPassword alone: smtp uses the override, imap falls back to the stored password", async () => {
    const account = await make({ password: "stored-imap", smtpPassword: "stored-smtp" });
    const calls: [string, string][] = [];
    const deps: TestConnectionDeps = {
      imapVerify: async (s) => { calls.push(["imap", passwordOf(s)]); },
      smtpVerify: async (s) => { calls.push(["smtp", passwordOf(s)]); },
    };
    const result = await testConnection(
      handle.db, actorId, { accountId: account.id, smtpPassword: "override-smtp" }, keyPath, deps,
    );
    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    const sorted = [...calls].sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted).toEqual([["imap", "stored-imap"], ["smtp", "override-smtp"]]);
  });

  it("with accountId: a submitted field overrides the stored value", async () => {
    const account = await make({ imapHost: "old-host" });
    const calls: string[] = [];
    const deps: TestConnectionDeps = {
      imapVerify: async (s) => { calls.push(s.host); },
      smtpVerify: async () => {},
    };
    await testConnection(handle.db, actorId, { accountId: account.id, imapHost: "new-host" }, keyPath, deps);
    expect(calls).toEqual(["new-host"]);
  });

  it("with accountId and a fully-overridden password: never touches the (possibly broken) stored ciphertext", async () => {
    const account = await make();
    // Corrupt the stored ciphertext to simulate a rotated/lost mail.key -- a
    // fully-overridden test connection must not need to decrypt it at all.
    await corruptCiphertext(account.id);
    const result = await testConnection(
      handle.db, actorId, { accountId: account.id, password: "brand-new" }, keyPath, okDeps(),
    );
    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
  });

  it("with accountId and no submitted password: an unreadable stored ciphertext surfaces per-protocol, not a thrown error", async () => {
    const account = await make();
    await corruptCiphertext(account.id);
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, okDeps());
    expect(result).toEqual({
      imap: { ok: false, error: "credentials unreadable" },
      smtp: { ok: false, error: "credentials unreadable" },
    });
  });

  // Widened-catch case: a ciphertext that is not even structurally v1 throws
  // a plain Error from decryptCredentials (not MailCredentialDecryptError) --
  // this must surface the same way as any other decrypt failure, not as a
  // thrown 500. See garbleCiphertext's own comment.
  it("with accountId and no submitted password: a structurally-invalid stored ciphertext also surfaces per-protocol", async () => {
    const account = await make();
    await garbleCiphertext(account.id);
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, okDeps());
    expect(result).toEqual({
      imap: { ok: false, error: "credentials unreadable" },
      smtp: { ok: false, error: "credentials unreadable" },
    });
  });

  it("reports per-protocol failure independently: imap fails, smtp still succeeds", async () => {
    const account = await make();
    const deps: TestConnectionDeps = {
      imapVerify: async () => { throw new Error("bad imap login"); },
      smtpVerify: async () => {},
    };
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, deps);
    expect(result.imap).toEqual({ ok: false, error: "bad imap login" });
    expect(result.smtp).toEqual({ ok: true });
  });

  it("never echoes the password or ciphertext in the result", async () => {
    const account = await make({ password: "super-secret-value" });
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, okDeps());
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("throws NotFoundError for another user's account", async () => {
    const account = await make({}, otherActorId);
    await expect(testConnection(handle.db, actorId, { accountId: account.id }, keyPath, okDeps()))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ArchivedError for an archived account", async () => {
    const account = await make();
    await archiveAccount(handle.db, actorId, account.id);
    await expect(testConnection(handle.db, actorId, { accountId: account.id }, keyPath, okDeps()))
      .rejects.toBeInstanceOf(ArchivedError);
  });
});

/**
 * Phase 8 Task 3: the item Task 2 left here in as many words.
 *
 * This endpoint used to answer "credentials unreadable" for an OAuth account --
 * the right OUTCOME under the wrong words, because the credential read
 * perfectly and there was simply no password to try and, before Task 2, nothing
 * to try instead. There is now, and what it must do is test the SAME mechanism
 * a real connection would use rather than an approximation of it.
 */
describe("testConnection: an OAuth account", () => {
  /** An account that signs in with a provider: the column and the blob written
   * together, which is the invariant MailAuthMethodMismatchError guards. */
  async function makeOAuth(credentials: {
    refreshToken: string; accessToken?: string; accessTokenExpiresAt?: string;
  }): Promise<string> {
    const account = await make();
    await handle.db.update(mailAccounts).set({
      authMethod: "oauth_microsoft",
      credentialsCiphertext: encryptCredentialsAt(keyPath, { kind: "oauth", ...credentials }),
    }).where(eq(mailAccounts.id, account.id));
    return account.id;
  }

  const FAR_FUTURE = new Date(Date.now() + 3600_000).toISOString();

  it("tests BOTH protocols with the access token, never a password", async () => {
    const id = await makeOAuth({
      refreshToken: "r", accessToken: "cached-token", accessTokenExpiresAt: FAR_FUTURE,
    });
    const seen: [string, unknown][] = [];
    const result = await testConnection(handle.db, actorId, { accountId: id }, keyPath, {
      imapVerify: async (s) => { seen.push(["imap", s.auth]); },
      smtpVerify: async (s) => { seen.push(["smtp", s.auth]); },
    });

    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    // One token authenticates both protocols -- a mail grant's scopes cover
    // IMAP and SMTP together, so there is no half to pick and no way to pick
    // one wrong.
    const sorted = [...seen].sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted).toEqual([
      ["imap", { kind: "oauth", accessToken: "cached-token" }],
      ["smtp", { kind: "oauth", accessToken: "cached-token" }],
    ]);
  });

  it("REFRESHES ONCE for the two protocols, not twice", async () => {
    // Two refreshes against one stored refresh token produce two grants, of
    // which persistRefreshedToken's compare-and-set keeps exactly one -- and at
    // a provider that rotates (Microsoft always does) the discarded one may be
    // the grant that retired the stored one. Pressing "Test connection" must
    // not be the thing that strands an account.
    const id = await makeOAuth({ refreshToken: "r" });
    let refreshes = 0;
    await testConnection(handle.db, actorId, { accountId: id }, keyPath, {
      ...okDeps(),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve({ accessToken: "fresh", expiresInSeconds: 3600 });
      },
    });
    expect(refreshes).toBe(1);
  });

  it("says 'sign in again' rather than 'credentials unreadable' for a dead grant", async () => {
    const id = await makeOAuth({ refreshToken: "revoked" });
    const result = await testConnection(handle.db, actorId, { accountId: id }, keyPath, {
      ...okDeps(),
      refresh: () => Promise.reject(new MailReauthRequiredError("microsoft", "invalid_grant")),
    });
    // THE WHOLE POINT OF THE ITEM. "credentials unreadable" points an operator
    // at mail.key, which is fine; the answer they need names the remedy.
    for (const protocol of [result.imap, result.smtp]) {
      expect(protocol.ok).toBe(false);
      expect(protocol.error).toContain("Sign in again");
      expect(protocol.error).not.toContain("credentials unreadable");
    }
  });

  it("still says 'credentials unreadable' when mail.key really is the problem", async () => {
    // The other half: an OAuth account whose row will not decrypt is a key
    // problem, and must not be reported as a lapsed grant.
    const id = await makeOAuth({ refreshToken: "r" });
    await corruptCiphertext(id);
    const result = await testConnection(handle.db, actorId, { accountId: id }, keyPath, okDeps());
    expect(result.imap.error).toBe("credentials unreadable");
    expect(result.smtp.error).toBe("credentials unreadable");
  });

  it("names the missing settings when this install has no registration", async () => {
    // The default refresher is a refusal, not a no-op: a caller that forgot to
    // wire one gets a readable sentence rather than a TypeError.
    const id = await makeOAuth({ refreshToken: "r" });
    const result = await testConnection(handle.db, actorId, { accountId: id }, keyPath, okDeps());
    expect(result.imap.ok).toBe(false);
    expect(result.imap.error).toContain("no OAuth token refresher");
  });

  it("IGNORES a submitted password rather than reporting on a login it cannot make", async () => {
    const id = await makeOAuth({
      refreshToken: "r", accessToken: "cached-token", accessTokenExpiresAt: FAR_FUTURE,
    });
    const seen: unknown[] = [];
    await testConnection(
      handle.db, actorId, { accountId: id, password: "typed-by-hand" }, keyPath,
      { imapVerify: async (s) => { seen.push(s.auth); }, smtpVerify: async (s) => { seen.push(s.auth); } },
    );
    // Honouring it would report success for a password this account will never
    // authenticate with -- worse than any refusal, because it reads as proof.
    expect(seen).toEqual([
      { kind: "oauth", accessToken: "cached-token" },
      { kind: "oauth", accessToken: "cached-token" },
    ]);
  });

  it("never puts the token in the result", async () => {
    const id = await makeOAuth({
      refreshToken: "refresh-secret", accessToken: "access-secret", accessTokenExpiresAt: FAR_FUTURE,
    });
    const result = await testConnection(handle.db, actorId, { accountId: id }, keyPath, {
      imapVerify: () => Promise.reject(new Error("auth: rejected")),
      smtpVerify: () => Promise.reject(new Error("auth: rejected")),
    });
    expect(JSON.stringify(result)).not.toContain("access-secret");
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
  });
});

describe("account-changed hook", () => {
  interface HookCall { accountId: string; connectionChanged: boolean }

  function record(): { calls: HookCall[]; off: () => void } {
    const calls: HookCall[] = [];
    const off = setAccountChangedHook((accountId, change) => {
      calls.push({ accountId, connectionChanged: change.connectionChanged });
    });
    return { calls, off };
  }

  it("fires for create, update, archive and unarchive, flagging connection changes", async () => {
    const { calls, off } = record();
    try {
      const account = await make();
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: true }]);

      // A label edit changes nothing a connection is built from, so the sync
      // engine is told it can keep its connection and just re-read the row.
      calls.length = 0;
      await updateAccount(handle.db, actorId, account.id, { label: "Renamed" }, keyPath);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: false }]);

      // Nor do the move targets: where trashed or archived mail goes is not
      // part of a connection, so the live sync is woken to re-read the row,
      // never dropped and re-LOGINed (Task 4).
      calls.length = 0;
      await updateAccount(handle.db, actorId, account.id, { trashFolder: "Deleted Items" }, keyPath);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: false }]);

      // Nor does visibility (Phase 4.2): flipping Private/Shared changes
      // nothing IMAP/SMTP is built from either, so this is a wake, never a
      // restart -- CONNECTION_FIELDS must not have picked it up.
      calls.length = 0;
      await updateAccount(handle.db, actorId, account.id, { visibility: "shared" }, keyPath);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: false }]);

      calls.length = 0;
      await updateAccount(handle.db, actorId, account.id, { imapHost: "elsewhere.example" }, keyPath);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: true }]);

      // A password change counts even though no plain column moved: the
      // credentials the live connection was built with are stale.
      calls.length = 0;
      await updateAccount(handle.db, actorId, account.id, { password: "new-secret" }, keyPath);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: true }]);

      calls.length = 0;
      await archiveAccount(handle.db, actorId, account.id);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: true }]);

      // Unarchive has to notify too, or a restored account never syncs again
      // until the process restarts.
      calls.length = 0;
      await unarchiveAccount(handle.db, actorId, account.id);
      expect(calls).toEqual([{ accountId: account.id, connectionChanged: true }]);
    } finally {
      off();
    }
  });

  it("does not fire for a no-op update", async () => {
    const account = await make({ label: "Work" });
    const { calls, off } = record();
    try {
      await updateAccount(handle.db, actorId, account.id, { label: "Work" }, keyPath);
      expect(calls).toEqual([]);
    } finally {
      off();
    }
  });

  it("survives a hook that throws: the CRUD write already committed", async () => {
    // The hook runs after the transaction commits, so a sync-engine failure
    // must never turn a successful save into a 500.
    const off = setAccountChangedHook(() => { throw new Error("sync engine exploded"); });
    try {
      const account = await make();
      const [row] = await handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
      expect(row?.label).toBe("Work");
    } finally {
      off();
    }
  });

  it("unregisters by identity, so a stale unregister cannot silence a newer hook", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = setAccountChangedHook((id) => { first.push(id); });
    const offSecond = setAccountChangedHook((id) => { second.push(id); });
    try {
      // The first registration is already displaced; its unregister must be a
      // no-op rather than clearing the slot the second one now owns.
      offFirst();
      const account = await make();
      expect(first).toEqual([]);
      expect(second).toEqual([account.id]);
    } finally {
      offSecond();
    }
  });
});
