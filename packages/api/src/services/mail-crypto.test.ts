import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadMailKey,
  encryptCredentials,
  decryptCredentials,
  encryptCredentialsAt,
  decryptCredentialsAt,
  type MailCredentials,
} from "./mail-crypto.js";
import { MailKeyMissingError, MailCredentialDecryptError } from "./errors.js";
import { LEGACY_MAIL_KEY_BASE64, LEGACY_PASSWORD_BLOBS } from "../test/legacy-mail-credentials.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "conduit-mail-crypto-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeKey(bytes: Buffer, name = "mail.key"): Promise<string> {
  const keyPath = path.join(dir, name);
  await writeFile(keyPath, bytes);
  return keyPath;
}

describe("loadMailKey", () => {
  it("reads a 32-byte key file", async () => {
    const bytes = randomBytes(32);
    const keyPath = await writeKey(bytes);
    const key = loadMailKey(keyPath);
    expect(key).toEqual(bytes);
  });

  it("memoises: a second call does not re-read the file", async () => {
    const bytes = randomBytes(32);
    const keyPath = await writeKey(bytes);
    const first = loadMailKey(keyPath);
    // Overwrite on disk with different (still 32-byte) content -- if the
    // second call were still hitting the filesystem, it would pick this up.
    await writeFile(keyPath, randomBytes(32));
    const second = loadMailKey(keyPath);
    expect(second).toBe(first);
    expect(second).toEqual(bytes);
  });

  it("throws a typed MailKeyMissingError when the file does not exist", () => {
    const keyPath = path.join(dir, "does-not-exist.key");
    expect(() => loadMailKey(keyPath)).toThrow(MailKeyMissingError);
  });

  it("throws when the key file is smaller than 32 bytes", async () => {
    const keyPath = await writeKey(randomBytes(16));
    expect(() => loadMailKey(keyPath)).toThrow(/32 bytes/);
  });

  it("throws when the key file is larger than 32 bytes", async () => {
    const keyPath = await writeKey(randomBytes(48));
    expect(() => loadMailKey(keyPath)).toThrow(/32 bytes/);
  });
});

describe("encryptCredentials / decryptCredentials", () => {
  const creds: MailCredentials = { imapPassword: "hunter2", smtpPassword: "hunter2" };

  it("round-trips credentials through encrypt then decrypt", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    expect(decryptCredentials(key, ciphertext)).toEqual(creds);
  });

  it("round-trips distinct imap/smtp passwords", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const distinct: MailCredentials = { imapPassword: "alpha-secret", smtpPassword: "beta-secret" };
    const ciphertext = encryptCredentials(key, distinct);
    expect(decryptCredentials(key, ciphertext)).toEqual(distinct);
  });

  it("produces the documented v1:<iv>:<tag>:<data> base64 format", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(4);
    const [version, ivB64, tagB64, dataB64] = parts;
    if (version === undefined || ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
      throw new Error("expected 4 ':'-separated segments");
    }
    expect(version).toBe("v1");
    const base64Re = /^[A-Za-z0-9+/]*={0,2}$/;
    expect(ivB64).toMatch(base64Re);
    expect(tagB64).toMatch(base64Re);
    expect(dataB64).toMatch(base64Re);
    expect(Buffer.from(ivB64, "base64")).toHaveLength(12); // random 12-byte IV
  });

  it("uses a random IV on every call: two encryptions of the same object differ", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const a = encryptCredentials(key, creds);
    const b = encryptCredentials(key, creds);
    expect(a).not.toBe(b);
  });

  it("throws when a byte of the ciphertext data segment is tampered with", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const [version, iv, tag, data] = ciphertext.split(":");
    if (version === undefined || iv === undefined || tag === undefined || data === undefined) {
      throw new Error("expected 4 ':'-separated segments");
    }
    const dataBytes = Buffer.from(data, "base64");
    dataBytes[0] = dataBytes[0]! ^ 0xff;
    const tampered = [version, iv, tag, dataBytes.toString("base64")].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow(MailCredentialDecryptError);
  });

  it("throws when a byte of the auth tag is tampered with", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const [version, iv, tag, data] = ciphertext.split(":");
    if (version === undefined || iv === undefined || tag === undefined || data === undefined) {
      throw new Error("expected 4 ':'-separated segments");
    }
    const tagBytes = Buffer.from(tag, "base64");
    tagBytes[0] = tagBytes[0]! ^ 0xff;
    const tampered = [version, iv, tagBytes.toString("base64"), data].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow(MailCredentialDecryptError);
  });

  it("throws on an unknown version prefix", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const withoutVersion = ciphertext.slice(ciphertext.indexOf(":") + 1);
    expect(() => decryptCredentials(key, `v2:${withoutVersion}`)).toThrow();
  });

  it("throws on a malformed ciphertext with the wrong number of segments", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    expect(() => decryptCredentials(key, "v1:onlyoneseparator")).toThrow();
  });

  it("throws a typed MailCredentialDecryptError (not a raw Node error) when decrypting with the wrong key", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const wrongKey = randomBytes(32);
    const ciphertext = encryptCredentials(key, creds);
    expect(() => decryptCredentials(wrongKey, ciphertext)).toThrow(MailCredentialDecryptError);
  });

  it("does not leak key material into the wrong-key error message", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const wrongKey = randomBytes(32);
    const ciphertext = encryptCredentials(key, creds);
    let threw = false;
    try {
      decryptCredentials(wrongKey, ciphertext);
    } catch (err) {
      threw = true;
      const message = (err as Error).message;
      expect(message).not.toContain(key.toString("base64"));
      expect(message).not.toContain(wrongKey.toString("base64"));
      expect(message).not.toContain(key.toString("hex"));
    }
    expect(threw).toBe(true);
  });

  it("rejects a truncated (4-byte) auth tag before it ever reaches the cipher", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const [version, iv, tag, data] = ciphertext.split(":");
    if (tag === undefined) {
      throw new Error("expected a tag segment");
    }
    const truncatedTag = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    const tampered = [version, iv, truncatedTag, data].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow(MailCredentialDecryptError);
    expect(() => decryptCredentials(key, tampered)).toThrow(/tag/i);
  });

  it("rejects a wrong-size (8-byte) IV before it ever reaches the cipher", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const [version, , tag, data] = ciphertext.split(":");
    const wrongIv = randomBytes(8).toString("base64");
    const tampered = [version, wrongIv, tag, data].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow(MailCredentialDecryptError);
    expect(() => decryptCredentials(key, tampered)).toThrow(/IV/i);
  });

  it("rejects a decrypted payload that does not match the {imapPassword, smtpPassword} shape", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    // encryptCredentials only serialises its argument -- it does not itself
    // validate the shape -- so this constructs a ciphertext that decrypts
    // and authenticates cleanly but unwraps to the wrong JSON shape.
    const ciphertext = encryptCredentials(key, { foo: "bar" } as unknown as MailCredentials);
    expect(() => decryptCredentials(key, ciphertext)).toThrow(MailCredentialDecryptError);
  });
});

describe("encryptCredentialsAt / decryptCredentialsAt", () => {
  const creds: MailCredentials = { imapPassword: "hunter2", smtpPassword: "hunter3" };

  it("round-trips credentials given only a keyPath", async () => {
    const keyPath = await writeKey(randomBytes(32));
    const ciphertext = encryptCredentialsAt(keyPath, creds);
    expect(decryptCredentialsAt(keyPath, ciphertext)).toEqual(creds);
  });

  it("decryptCredentialsAt throws MailKeyMissingError when the key file is absent", () => {
    const keyPath = path.join(dir, "does-not-exist.key");
    expect(() => decryptCredentialsAt(keyPath, "v1:a:b:c")).toThrow(MailKeyMissingError);
  });
});

/**
 * THE HIGHEST-CONSEQUENCE TEST IN THIS FILE, and the reason Phase 8 Task 1
 * exists in the order it does. Every stored mail password on a live install is
 * a blob written by the pre-union encoder; if the union stops accepting that
 * shape they are all stranded behind a schema that no longer matches, and only
 * a backup gets them back.
 *
 * Nothing here encrypts. The ciphertexts come from test/legacy-mail-credentials.ts,
 * which records the commit that produced them -- see that file for why a fixture
 * generated by the code under test would be a failed proof rather than a passed
 * one.
 */
describe("backward compatibility with blobs written before the credential union", () => {
  const legacyKey = Buffer.from(LEGACY_MAIL_KEY_BASE64, "base64");

  for (const blob of LEGACY_PASSWORD_BLOBS) {
    it(`decrypts a pre-Phase-8 blob byte-for-byte: ${blob.name}`, () => {
      // toMatchObject, not toEqual: this assertion is about the two passwords
      // surviving, and it must keep meaning exactly that whatever else the
      // union's parsed output grows around them.
      expect(decryptCredentials(legacyKey, blob.ciphertext)).toMatchObject({
        imapPassword: blob.imapPassword,
        smtpPassword: blob.smtpPassword,
      });
    });
  }

  // Guards the fixture itself rather than the decrypter. If the committed key
  // were ever regenerated without regenerating the blobs (or vice versa) the
  // cases above would fail loudly -- but a fixture whose ciphertext had somehow
  // become decryptable under ANY key would pass them while proving nothing, so
  // pin that the ciphertext really is bound to this key.
  it("the committed blobs are genuinely bound to the committed key", () => {
    for (const blob of LEGACY_PASSWORD_BLOBS) {
      expect(() => decryptCredentials(randomBytes(32), blob.ciphertext))
        .toThrow(MailCredentialDecryptError);
    }
  });
});
