import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";

/**
 * Store a stream under DATA_DIR/files/<sha256>. Duplicate content shares one blob.
 *
 * The returned sizeBytes/sha256 reflect exactly what was read from `source` -- if the
 * source can silently truncate under some external limit (e.g. fastify-multipart's
 * per-file size cap), this function has no way to detect that: a truncated stream just
 * ends, indistinguishable from a short file that legitimately ended there. The CALLER
 * is responsible for checking its own truncation signal (e.g. multipart's
 * `file.truncated`) after the stream ends, before trusting the result.
 */
export async function saveBlob(dataDir: string, source: Readable): Promise<{ sha256: string; sizeBytes: number }> {
  const dir = path.join(dataDir, "files");
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  // Hashing happens inside the pipeline, as a single consumer of `source`, rather than
  // via a second listener alongside it. That makes correctness independent of Node's
  // internal readable-stream consumption strategy (flowing-mode broadcast vs pipeline's
  // own reads), which a second "data" listener would otherwise rely on.
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, hasher, createWriteStream(tmp));
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
    try {
      await stat(final);
      await rm(tmp, { force: true });                 // already have this content
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await rename(tmp, final);
    }
    return { sha256, sizeBytes };
  } catch (error) {
    // Best-effort cleanup: if the rm itself fails, the temp file leaks (acceptable --
    // it's a bounded, identifiable orphan) rather than masking the original error,
    // which is the one the caller actually needs to see.
    try { await rm(tmp, { force: true }); } catch { /* leaked tmp file; original error wins */ }
    throw error;
  }
}

export function openBlob(dataDir: string, sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid sha256");
  return createReadStream(path.join(dataDir, "files", sha256));
}
