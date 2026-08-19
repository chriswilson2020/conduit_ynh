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
import { encryptCredentials } from "./mail-crypto.js";
import {
  createAccount, updateAccount, archiveAccount, unarchiveAccount, getOwnAccount, getAccountCredentials,
  listAccounts, testConnection, type TestConnectionDeps,
} from "./mail-accounts.js";
import { NotFoundError, ArchivedError } from "./errors.js";
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

// Test-only backdoors for states the service's own API cannot produce:
// status='error' is Task 5's sync loop's job in real use, and a corrupted
// ciphertext simulates a lost/rotated mail.key against an old row.
async function forceError(id: string): Promise<void> {
  await handle.db.update(mailAccounts).set({ status: "error", lastError: "boom" }).where(eq(mailAccounts.id, id));
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

  it("defaults smtpPassword to password when no override is given", async () => {
    const account = await make({ password: "shared-secret" });
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "shared-secret", smtpPassword: "shared-secret" });
  });

  it("keeps a distinct smtpPassword when the 'SMTP differs' override is given", async () => {
    const account = await make({ password: "imap-secret", smtpPassword: "smtp-secret" });
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "imap-secret", smtpPassword: "smtp-secret" });
  });

  it("applies DB defaults for omitted sentFolder/backfillDays and preserves an explicit null backfillDays", async () => {
    const withDefaults = await make();
    expect(withDefaults.sentFolder).toBe("Sent");
    expect(withDefaults.backfillDays).toBe(90);

    const unlimited = await make({ email: "other@example.com", backfillDays: null });
    expect(unlimited.backfillDays).toBeNull();
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
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds.imapPassword).toBe("original");
  });

  it("absent/empty password fields keep the stored credentials", async () => {
    const account = await make({ password: "keep-me", smtpPassword: "keep-me-too" });
    await updateAccount(handle.db, actorId, account.id, { label: "Renamed", password: "", smtpPassword: undefined }, keyPath);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "keep-me", smtpPassword: "keep-me-too" });
  });

  // RULING: a lone `password` means BOTH protocols (matches createAccount's
  // and testConnection's "SMTP differs" default) -- the settings form only
  // ever submits smtpPassword alongside password when its toggle is on.
  it("a lone password updates BOTH the imap and smtp password", async () => {
    const account = await make({ password: "imap-old", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { password: "both-new" }, keyPath);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "both-new", smtpPassword: "both-new" });
  });

  it("password + smtpPassword together: smtpPassword wins for smtp, password sets imap", async () => {
    const account = await make({ password: "imap-old", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { password: "imap-new", smtpPassword: "smtp-new" }, keyPath);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "imap-new", smtpPassword: "smtp-new" });
  });

  it("a lone smtpPassword changes only smtp, carrying the stored imap password forward", async () => {
    const account = await make({ password: "imap-unchanged", smtpPassword: "smtp-old" });
    await updateAccount(handle.db, actorId, account.id, { smtpPassword: "smtp-new" }, keyPath);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "imap-unchanged", smtpPassword: "smtp-new" });
  });

  it("a full password submission succeeds even against an undecryptable stored ciphertext (key-rotation recovery)", async () => {
    const account = await make();
    await corruptCiphertext(account.id);
    // password alone is fully self-determining (both halves), so this must
    // never need to decrypt the broken stored blob -- the whole point of the
    // lazy-decrypt design is that a lost/rotated mail.key becomes fixable by
    // submitting a fresh password instead of a permanent dead end.
    await updateAccount(handle.db, actorId, account.id, { password: "recovered" }, keyPath);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds).toEqual({ imapPassword: "recovered", smtpPassword: "recovered" });
  });

  it("sanitizes signatureHtml on write: a script tag is stripped", async () => {
    const account = await make();
    const updated = await updateAccount(
      handle.db, actorId, account.id, { signatureHtml: "<p>Regards</p><script>alert(1)</script>" }, keyPath,
    );
    expect(updated.signatureHtml).not.toContain("<script>");
    expect(updated.signatureHtml).toContain("Regards");
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

  it("publishes the mail-accounts SSE key", async () => {
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

  it("publishes the mail-accounts SSE key", async () => {
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

  it("publishes the mail-accounts SSE key", async () => {
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
});

describe("getAccountCredentials", () => {
  it("decrypts stored credentials regardless of who calls it (no owner check -- internal primitive)", async () => {
    const account = await make({ password: "sync-secret" }, otherActorId);
    const creds = await getAccountCredentials(handle.db, account.id, keyPath);
    expect(creds.imapPassword).toBe("sync-secret");
  });

  it("throws NotFoundError for a nonexistent account", async () => {
    await expect(getAccountCredentials(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", keyPath))
      .rejects.toBeInstanceOf(NotFoundError);
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
      ["imap", { host: "imap.example.com", port: 993, security: "tls", username: "chris", password: "fresh-secret" }],
      ["smtp", { host: "smtp.example.com", port: 587, security: "starttls", username: "chris", password: "fresh-secret" }],
    ]);
  });

  it("with accountId and no submitted password: decrypts and uses the stored credentials", async () => {
    const account = await make({ password: "stored-imap", smtpPassword: "stored-smtp" });
    const calls: unknown[] = [];
    const deps: TestConnectionDeps = {
      imapVerify: async (s) => { calls.push(s.password); },
      smtpVerify: async (s) => { calls.push(s.password); },
    };
    const result = await testConnection(handle.db, actorId, { accountId: account.id }, keyPath, deps);
    expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    expect(calls.sort()).toEqual(["stored-imap", "stored-smtp"]);
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
