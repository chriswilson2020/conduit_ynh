import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { saveBlob, openBlob } from "./blobs.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-blobs-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function readStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (c: Buffer) => chunks.push(c));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

async function filesInBlobsDir(): Promise<string[]> {
  try { return await readdir(path.join(dataDir, "files")); }
  catch { return []; }
}

describe("blobs service", () => {
  it("computes the correct sha256 and byte count", async () => {
    const content = "the quick brown fox jumps over the lazy dog";
    const expectedSha = createHash("sha256").update(content).digest("hex");
    const result = await saveBlob(dataDir, Readable.from([Buffer.from(content)]));
    expect(result.sha256).toBe(expectedSha);
    expect(result.sizeBytes).toBe(Buffer.byteLength(content));
  });

  it("dedupes identical content into a single blob", async () => {
    const content = Buffer.from("duplicate me");
    const first = await saveBlob(dataDir, Readable.from([content]));
    const second = await saveBlob(dataDir, Readable.from([content]));
    expect(second.sha256).toBe(first.sha256);
    const entries = await filesInBlobsDir();
    expect(entries).toEqual([first.sha256]);
  });

  it("round-trips saved bytes through openBlob", async () => {
    const content = Buffer.from("round trip payload");
    const { sha256 } = await saveBlob(dataDir, Readable.from([content]));
    const readBack = await readStream(openBlob(dataDir, sha256));
    expect(readBack).toEqual(content);
  });

  it("leaves no .upload-* temp file behind when the source stream errors mid-way", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial chunk"));
        process.nextTick(() => this.destroy(new Error("boom")));
      },
    });
    await expect(saveBlob(dataDir, source)).rejects.toThrow("boom");
    const entries = await filesInBlobsDir();
    expect(entries.filter((e) => e.startsWith(".upload-"))).toEqual([]);
  });

  it("openBlob throws on a path-traversal sha", () => {
    expect(() => openBlob(dataDir, "../../etc/passwd")).toThrow("invalid sha256");
  });

  it("openBlob throws on an uppercase or short hash", () => {
    expect(() => openBlob(dataDir, "A".repeat(64))).toThrow("invalid sha256");
    expect(() => openBlob(dataDir, "abc123")).toThrow("invalid sha256");
  });

  it("two concurrent saves of identical new content both succeed and leave exactly one blob", async () => {
    const content = Buffer.from("racing upload payload");
    const expectedSha = createHash("sha256").update(content).digest("hex");
    const [a, b] = await Promise.all([
      saveBlob(dataDir, Readable.from([content])),
      saveBlob(dataDir, Readable.from([content])),
    ]);
    expect(a.sha256).toBe(expectedSha);
    expect(b.sha256).toBe(expectedSha);
    expect(a.sizeBytes).toBe(content.length);
    expect(b.sizeBytes).toBe(content.length);
    const entries = await filesInBlobsDir();
    expect(entries).toEqual([expectedSha]);
  });
});
