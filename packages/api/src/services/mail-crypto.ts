import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { MailKeyMissingError, MailCredentialDecryptError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const VERSION = "v1";

/**
 * The JSON payload encrypted into mail_accounts.credentials_ciphertext (spec's
 * "Key handling" section). imapPassword and smtpPassword are usually identical --
 * the account form offers one password field with an "SMTP differs" toggle -- but
 * both are always stored so a differing SMTP password survives independently.
 * A zod schema (not just a TS interface) because decryptCredentials validates the
 * decrypted JSON against it -- a ciphertext can authenticate cleanly under GCM and
 * still not unwrap to this shape, e.g. if it were ever encrypted by something else
 * under the same key.
 */
const mailCredentialsSchema = z.object({
  imapPassword: z.string(),
  smtpPassword: z.string(),
});
export type MailCredentials = z.infer<typeof mailCredentialsSchema>;

// Keyed by resolved path rather than a single module-level slot: tests use a
// fresh temp file per case (see mail-crypto.test.ts), and keying by path means
// each gets its own memoised entry with no cross-test bleed or need for an
// explicit reset hook, mirroring how blobs.ts/files.ts take dataDir as a plain
// parameter rather than reading it off a global. Production has exactly one
// path (config.mailKeyPath), so this degenerates to the intended single-entry
// cache there.
const keyCache = new Map<string, Buffer>();

/**
 * Load the AES-256-GCM key from `keyPath` (config.ts's `mailKeyPath`,
 * `$data_dir/mail.key` by default -- see the Phase 4 spec's "Key handling"
 * section). Installed/upgraded idempotently by the packaging scripts; a
 * deployment that has not run them yet, or lost the file, must not crash the
 * server, so a missing file throws the typed MailKeyMissingError that routes
 * map to 503 rather than an unhandled 500. Any other read failure (permission
 * denied, etc.) propagates as-is -- that is an operator problem with no
 * dedicated handling.
 *
 * The returned Buffer is cached and shared across every caller for a given
 * keyPath (see keyCache above) -- treat it as read-only. The cache is dropped
 * only by forgetMailKey, which is the one caller that replaces the file
 * underneath it; for everything else, rotating the key is still a
 * restart-the-server operation rather than a live one.
 */
export function loadMailKey(keyPath: string): Buffer {
  const cached = keyCache.get(keyPath);
  if (cached !== undefined) return cached;

  let raw: Buffer;
  try {
    raw = readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MailKeyMissingError(keyPath);
    }
    throw err;
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(`mail key at ${keyPath} must be exactly ${KEY_BYTES} bytes, got ${raw.length}`);
  }
  keyCache.set(keyPath, raw);
  return raw;
}

/**
 * Drop the memoised key for `keyPath`, so the next loadMailKey reads the file.
 *
 * EXISTS FOR EXACTLY ONE CALLER: services/restore.ts, which replaces the file
 * on disk. Without it a restored install decrypts with the key it happened to
 * have loaded before the restore -- so every mail password would fail to
 * decrypt until somebody restarted the server, and the symptom (an account
 * that will not connect) points nowhere near the cause.
 *
 * IT IS NOT A ROTATION MECHANISM. It repairs THIS process's view of a file
 * that has already been replaced; it does nothing about the connections, the
 * caches and the in-flight work that a restore also invalidates, which is why
 * the restore plan still carries a "restart the server" finding. Idempotent,
 * and a no-op for a path that was never loaded.
 */
export function forgetMailKey(keyPath: string): void {
  keyCache.delete(keyPath);
}

/**
 * AES-256-GCM encrypt with a fresh random 12-byte IV, format
 * `v1:<iv-base64>:<tag-base64>:<data-base64>` per the spec. `key` comes from
 * loadMailKey -- kept as a separate parameter (rather than a keyPath) so this
 * function stays pure filesystem-wise and easy to unit-test with an
 * in-memory key.
 */
export function encryptCredentials(key: Buffer, credentials: MailCredentials): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

/**
 * Inverse of encryptCredentials. Throws a plain Error for a ciphertext that
 * is not even structurally v1 (wrong segment count, unrecognised version
 * prefix) -- that is a caller/format bug, not a key problem. Throws the
 * typed MailCredentialDecryptError for everything downstream of that: a
 * malformed IV/tag length, GCM authentication failure (wrong key, or any
 * tampered byte), or a decrypted payload that is not valid JSON matching
 * MailCredentials -- all cases where "the key you have does not work for
 * this ciphertext" is the useful thing for a caller to know, without any
 * key/IV/tag/plaintext material leaking into the error message.
 */
export function decryptCredentials(key: Buffer, ciphertext: string): MailCredentials {
  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 4 || version === undefined || ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
    throw new Error("malformed mail credential ciphertext: expected 4 ':'-separated segments");
  }
  if (version !== VERSION) {
    throw new Error(`unsupported mail credential ciphertext version: ${version}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  // Node accepts a GCM auth tag shorter than the full 16 bytes rather than
  // rejecting it outright (see DEP0182) -- a truncated tag verifies against
  // far fewer bits than intended, a real integrity downgrade, not just a
  // formatting nicety. Reject both non-standard lengths up front, before
  // either ever reaches the cipher.
  if (iv.length !== IV_BYTES) {
    throw new MailCredentialDecryptError(`invalid IV length: expected ${IV_BYTES} bytes`);
  }
  if (tag.length !== AUTH_TAG_BYTES) {
    throw new MailCredentialDecryptError(`invalid auth tag length: expected ${AUTH_TAG_BYTES} bytes`);
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    // Node's own error here can be more detailed than this needs to be --
    // never forward it (or the key/iv/tag bytes) verbatim. Callers only
    // need to know decryption failed, e.g. because mail.key was
    // rotated/restored since this row was encrypted.
    throw new MailCredentialDecryptError("authentication failed (wrong key or corrupted ciphertext)");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new MailCredentialDecryptError("decrypted payload was not valid JSON");
  }
  const result = mailCredentialsSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new MailCredentialDecryptError("decrypted payload did not match the expected credentials shape");
  }
  return result.data;
}

/**
 * Thin keyPath-taking wrappers -- the spirit of blobs.ts's
 * `saveBlob(dataDir, ...)` -- for callers holding `config.mailKeyPath`
 * (Task 3's account service, mainly) that just want to encrypt/decrypt in
 * one call without separately threading loadMailKey through every call
 * site. Prefer the pure key-based functions above wherever a Buffer key is
 * already in hand (e.g. inside a loop over several accounts) to avoid
 * repeated Map lookups.
 */
export function encryptCredentialsAt(keyPath: string, credentials: MailCredentials): string {
  return encryptCredentials(loadMailKey(keyPath), credentials);
}

export function decryptCredentialsAt(keyPath: string, ciphertext: string): MailCredentials {
  return decryptCredentials(loadMailKey(keyPath), ciphertext);
}
