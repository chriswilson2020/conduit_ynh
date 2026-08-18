import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/** Store a stream under DATA_DIR/files/<sha256>. Duplicate content shares one blob. */
export async function saveBlob(dataDir: string, source: Readable): Promise<{ sha256: string; sizeBytes: number }> {
  const dir = path.join(dataDir, "files");
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  source.on("data", (chunk: Buffer) => { hash.update(chunk); sizeBytes += chunk.length; });
  try {
    await pipeline(source, createWriteStream(tmp));
    const sha256 = hash.digest("hex");
    const final = path.join(dir, sha256);
    // Race between two concurrent uploads of the SAME new content: both can pass this
    // stat as a miss and both fall into rename below. On Linux (the deploy target),
    // rename(2) onto an existing destination is atomic replacement -- never a partial
    // or corrupt file -- and both temp files hold byte-identical content (same source
    // bytes producing the same sha256), so whichever rename lands last simply
    // overwrites the final path with an identical copy. Both callers still observe
    // their own correctly computed sha256/sizeBytes from their own stream, and the
    // blobs dir ends up with exactly one file either way.
    try { await stat(final); await rm(tmp); }        // already have this content
    catch { await rename(tmp, final); }
    return { sha256, sizeBytes };
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

export function openBlob(dataDir: string, sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid sha256");
  return createReadStream(path.join(dataDir, "files", sha256));
}
