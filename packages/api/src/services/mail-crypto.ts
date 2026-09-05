import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { MailKeyMissingError, MailCredentialDecryptError, MailCredentialKindError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const VERSION = "v1";

/**
 * The password payload, and the shape every credential blob written before
 * Phase 8 has (spec's "Key handling" section). imapPassword and smtpPassword
 * are usually identical -- the account form offers one password field with an
 * "SMTP differs" toggle -- but both are always stored so a differing SMTP
 * password survives independently.
 *
 * A zod schema (not just a TS interface) because decryptCredentials validates
 * the decrypted JSON against it -- a ciphertext can authenticate cleanly under
 * GCM and still not unwrap to this shape, e.g. if it were ever encrypted by
 * something else under the same key.
 *
 * `kind` IS OPTIONAL ON THE WAY IN AND ALWAYS PRESENT ON THE WAY OUT, and both
 * halves of that are load-bearing:
 *
 *   OPTIONAL IN, because no stored row has it. Every mail password on a live
 *   install is a blob written by the pre-union encoder as a bare
 *   `{imapPassword, smtpPassword}`, and mail.key is the only thing that can
 *   read it. Requiring a discriminator here would reject all of them at the
 *   safeParse below -- every account instantly "credentials unreadable", with
 *   only a backup to get them back. That is why this is a plain z.union and
 *   not z.discriminatedUnion: a discriminated union needs the tag present in
 *   the DATA, and half the data predates the tag. test/legacy-mail-credentials.ts
 *   holds blobs written by that old encoder, and mail-crypto.test.ts decrypts
 *   them here; they are the only real proof of this, since a round trip
 *   through this file's own encoder would agree with itself no matter what
 *   shape it had moved to.
 *
 *   ALWAYS OUT, because callers branch on it. The transform normalises the
 *   two accepted input forms into one output form, so `credentials.kind` is a
 *   genuine discriminant TypeScript can narrow on rather than an
 *   `undefined | "password"` that every call site has to reason about.
 *
 * NOTHING WRITES `kind: "password"`, and that is deliberate. encryptCredentials
 * serialises what it is handed, and every password call site hands it a bare
 * pair -- so a v1.7.0 install writes password blobs BYTE-IDENTICAL to the ones
 * v1.6.0 wrote, and a database moved between the two (a restore, a rollback)
 * needs no thought at all. The tag is accepted on input only so a blob that
 * does carry it -- a caller re-encrypting a decrypted value -- still reads
 * back.
 */
const passwordCredentialsSchema = z.object({
  kind: z.literal("password").optional(),
  imapPassword: z.string(),
  smtpPassword: z.string(),
}).transform((c) => ({
  kind: "password" as const,
  imapPassword: c.imapPassword,
  smtpPassword: c.smtpPassword,
}));

/**
 * The OAuth payload (Phase 8): what an account signed in with Microsoft or
 * Google stores instead of a password.
 *
 * THE REFRESH TOKEN IS THE CREDENTIAL. It is long-lived (Microsoft's do not
 * expire; a Google Internal app's do not either -- see the Phase 8 spec for
 * the consumer-Gmail fork, which is administrative rather than anything this
 * file can help with), and it is what the token endpoint is asked to exchange
 * for a short-lived access token before each connection. It carries exactly
 * the protection credentials_ciphertext already carries: never selected into
 * an API response, never logged.
 *
 * WHICH PROVIDER IS NOT IN HERE. mail_accounts.auth_method is the authority
 * for that (db/schema.ts), because Settings has to render "signed in with
 * Microsoft" WITHOUT touching mail.key -- that column is the whole reason this
 * release has a migration. Storing the provider in both places would create
 * two answers that can disagree, and the one behind the encryption is the one
 * nobody would think to check.
 *
 * THE CACHED ACCESS TOKEN AND ITS EXPIRY TRAVEL TOGETHER OR NOT AT ALL, and
 * the refinement below enforces it. An access token with no expiry would be
 * used until a provider rejected it (turning a routine refresh into an auth
 * error the operator sees); an expiry with no token is a fact about a token
 * nothing holds. "Neither" is the ordinary state right after authorisation and
 * after any refresh failure, so it stays legal.
 *
 * Strictness here costs nothing that the password shape's strictness costs:
 * no stored row has this shape yet, so there is no historical data to strand
 * -- the reason `refreshToken` may be non-empty where the passwords may be "".
 */
const oauthCredentialsSchema = z.object({
  kind: z.literal("oauth"),
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  // ISO 8601 with an offset, matching every other instant this project puts on
  // a wire (packages/shared's z.iso.datetime()). Epoch milliseconds were the
  // alternative and were rejected: this string is legible when a blob is ever
  // dumped into a debugger, and comparing it means one Date.parse rather than
  // one unit-of-time assumption nobody wrote down.
  accessTokenExpiresAt: z.iso.datetime().optional(),
}).refine(
  (c) => (c.accessToken === undefined) === (c.accessTokenExpiresAt === undefined),
  { message: "accessToken and accessTokenExpiresAt must be stored together" },
);

/**
 * The JSON payload encrypted into mail_accounts.credentials_ciphertext: a
 * password pair, or an OAuth refresh token.
 *
 * THE TWO MEMBERS ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION, so union member
 * order carries no meaning and nothing depends on which zod tries first. The
 * password member requires both passwords and refuses any tag but "password";
 * the OAuth member requires the tag "oauth" and a refresh token, and has no
 * password fields to satisfy. No payload can pass both, and
 * mail-crypto.test.ts pins each of those four halves rather than trusting the
 * reading.
 */
const mailCredentialsSchema = z.union([passwordCredentialsSchema, oauthCredentialsSchema]);

/** What decryptCredentials returns: `kind` is always present. */
export type MailCredentials = z.output<typeof mailCredentialsSchema>;
/** What encryptCredentials accepts: `kind` is optional on the password side,
 * which is what keeps every existing password call site writing the pre-union
 * bytes without naming a tag it does not need to know about. */
export type MailCredentialsInput = z.input<typeof mailCredentialsSchema>;
export type MailPasswordCredentials = Extract<MailCredentials, { kind: "password" }>;
export type MailOAuthCredentials = Extract<MailCredentials, { kind: "oauth" }>;

/**
 * Narrow to the password shape, or throw.
 *
 * EXISTS BECAUSE THE UNION LANDED BEFORE THE CODE THAT USES ITS OTHER HALF, AND
 * IT IS DOWN TO ONE CALL SITE. Four sites could only do something with a
 * password. Task 2 removed the two that mattered -- the IMAP connect and the
 * SMTP transport now take an already-resolved credential from mail-oauth.ts's
 * resolveConnectionAuth, which hands imapflow and nodemailer an access token
 * where there is one. Task 3 removed the third: testConnection resolves an
 * OAuth account's token and tests with it rather than demanding a password it
 * was never going to have.
 *
 * THE ONE THAT REMAINS IS NO LONGER A GAP. updateAccount's
 * carry-the-imap-half-forward branch still calls this, but the REFUSAL now
 * happens a few lines earlier and on mail_accounts.auth_method -- a column, in
 * the clear, needing no mail.key. This call is what narrows the union for the
 * type system, plus a fail-closed backstop for the one state the column cannot
 * see: a row claiming 'password' over a blob that is not one.
 *
 * A THROW RATHER THAN A FALLBACK, unchanged and still the point: a path that
 * quietly used an empty password would present as an auth failure against the
 * provider, which is precisely the "mail just stopped" symptom the spec's
 * Risk 3 is about.
 *
 * IT IS REACHABLE NOW, AND MAPPED. Task 3 makes an OAuth account creatable, so
 * MailCredentialKindError stopped being a class only tests construct --
 * routes/helpers.ts's mapDomainError answers it 409 rather than letting it
 * become a 500, which is what it would have been the first time somebody
 * PATCHed a password onto a provider mailbox.
 */
export function mustBePasswordCredentials(
  credentials: MailCredentials, accountId: string,
): MailPasswordCredentials {
  if (credentials.kind !== "password") {
    throw new MailCredentialKindError(accountId, credentials.kind);
  }
  return credentials;
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
 *
 * SERIALISES, DOES NOT VALIDATE -- unchanged by the union, and worth naming
 * now that there is a shape with real invariants in it. The type parameter is
 * the only gate; a caller that casts past it can seal a payload that
 * decryptCredentials will then refuse, and the row reads as "credentials
 * unreadable" from that point on. That is exactly how mail-crypto.test.ts
 * builds an authenticates-cleanly-but-wrong-shape ciphertext, which is the
 * reason it stays this way. It also means Task 3's token exchange has to
 * check its own provider response before sealing it, rather than expecting a
 * throw here.
 */
export function encryptCredentials(key: Buffer, credentials: MailCredentialsInput): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

/**
 * encryptCredentials, refusing anything decryptCredentials would then refuse.
 *
 * EXISTS BECAUSE SEALING IS IRREVERSIBLE IN THE WAY THAT MATTERS. Its sibling
 * above serialises whatever it is handed; a caller that gets past the type
 * parameter -- a cast, or a value assembled from a provider's JSON response --
 * can therefore write a blob that authenticates perfectly under GCM and yet
 * fails mailCredentialsSchema on every read from that moment on. The row then
 * reads "credentials unreadable" for ever, which points an operator at
 * mail.key, which is not the problem, and no backup helps because the bad bytes
 * were written on purpose. One safeParse before the cipher turns that into a
 * throw at the moment of the mistake.
 *
 * THE PAYLOAD ENCRYPTED IS THE CALLER'S OWN VALUE, NOT THE PARSED OUTPUT, and
 * that is deliberate rather than lazy. The password member's transform ADDS
 * `kind: "password"`, so sealing the parsed output would change the bytes a
 * v1.7.0 install writes for a password account -- the exact thing Task 1 went
 * out of its way to keep identical to v1.6.0's (see passwordCredentialsSchema's
 * "NOTHING WRITES kind: password"). The parse is a gate here, never a
 * normaliser.
 *
 * USED BY THE PATHS THAT SEAL SOMETHING THEY DID NOT CONSTRUCT THEMSELVES --
 * today mail-oauth.ts, writing a token an HTTP response supplied. The password
 * call sites in mail-accounts.ts stay on the plain encryptCredentials: each
 * builds `{imapPassword, smtpPassword}` inline from two strings it already has,
 * so there is nothing for a check to catch. mail-crypto.test.ts's
 * wrong-shape-ciphertext fixture depends on the plain one staying unchecked,
 * which is the other reason this is a second function and not a new behaviour
 * of the first.
 */
export function encryptCredentialsChecked(key: Buffer, credentials: MailCredentialsInput): string {
  const result = mailCredentialsSchema.safeParse(credentials);
  if (!result.success) {
    // No field values in the message: the payload being refused may be an
    // OAuth one, and its refresh token is the last thing that should reach an
    // error string. The zod issue PATHS are safe (they are key names) and are
    // what a caller needs to fix the payload.
    const paths = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new Error(`refusing to encrypt a credential payload that would not decrypt: ${paths}`);
  }
  return encryptCredentials(key, credentials);
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
export function encryptCredentialsAt(keyPath: string, credentials: MailCredentialsInput): string {
  return encryptCredentials(loadMailKey(keyPath), credentials);
}

export function decryptCredentialsAt(keyPath: string, ciphertext: string): MailCredentials {
  return decryptCredentials(loadMailKey(keyPath), ciphertext);
}
