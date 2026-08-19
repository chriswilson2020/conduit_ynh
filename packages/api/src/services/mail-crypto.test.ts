import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMailKey, encryptCredentials, decryptCredentials, type MailCredentials } from "./mail-crypto.js";
import { MailKeyMissingError } from "./errors.js";

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
    expect(parts[0]).toBe("v1");
    const base64Re = /^[A-Za-z0-9+/]*={0,2}$/;
    expect(parts[1]).toMatch(base64Re);
    expect(parts[2]).toMatch(base64Re);
    expect(parts[3]).toMatch(base64Re);
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12); // random 12-byte IV
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
    const dataBytes = Buffer.from(data, "base64");
    dataBytes[0] = dataBytes[0] ^ 0xff;
    const tampered = [version, iv, tag, dataBytes.toString("base64")].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow();
  });

  it("throws when a byte of the auth tag is tampered with", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const ciphertext = encryptCredentials(key, creds);
    const [version, iv, tag, data] = ciphertext.split(":");
    const tagBytes = Buffer.from(tag, "base64");
    tagBytes[0] = tagBytes[0] ^ 0xff;
    const tampered = [version, iv, tagBytes.toString("base64"), data].join(":");
    expect(() => decryptCredentials(key, tampered)).toThrow();
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

  it("throws when decrypting with the wrong key", async () => {
    const key = loadMailKey(await writeKey(randomBytes(32)));
    const wrongKey = randomBytes(32);
    const ciphertext = encryptCredentials(key, creds);
    expect(() => decryptCredentials(wrongKey, ciphertext)).toThrow();
  });
});
