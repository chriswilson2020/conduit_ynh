import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { MailKeyMissingError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

/**
 * The JSON payload encrypted into mail_accounts.credentials_ciphertext (spec's
 * "Key handling" section). imapPassword and smtpPassword are usually identical --
 * the account form offers one password field with an "SMTP differs" toggle -- but
 * both are always stored so a differing SMTP password survives independently.
 */
export interface MailCredentials {
  imapPassword: string;
  smtpPassword: string;
}

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
 * Inverse of encryptCredentials. Throws on: an unsupported/missing version
 * prefix, a malformed segment count, or GCM auth-tag verification failure
 * (wrong key, or any tampered byte in the IV/tag/data) -- decipher.final()
 * is where GCM raises that, so this function performs no manual integrity
 * check of its own.
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
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as MailCredentials;
}
