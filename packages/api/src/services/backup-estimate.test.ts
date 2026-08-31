import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTestDatabase, truncateAll } from "../test/db.js";
import {
  estimateBackup, isSlowBackup, requiredFreeBytes, freeSpaceBytes,
  BACKUP_BYTES_PER_SECOND, BACKUP_PROXY_READ_TIMEOUT_SECONDS, BACKUP_SLOW_SECONDS,
} from "./backup.js";

/**
 * THE PRE-FLIGHT THAT WARNS BEFORE A LONG BACKUP, which is the half of Chris's
 * 31 Aug ruling that conf/nginx.conf cannot make. The raise buys headroom; this
 * is what stops the failure being silent.
 *
 * No 7z needed anywhere in this file: the point of the estimate is that it
 * costs nothing to make.
 */

const handle = openTestDatabase();
let dataDir: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-estimate-"));
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
afterAll(async () => { await handle.close(); });

describe("estimateBackup", () => {
  it("counts the blob store, and tolerates a fresh install with no files at all", async () => {
    const empty = await estimateBackup({ db: handle.db, dataDir });
    expect(empty.blobBytes).toBe(0);

    await mkdir(path.join(dataDir, "files"), { recursive: true });
    await writeFile(path.join(dataDir, "files", "a"), Buffer.alloc(4096, 1));
    await writeFile(path.join(dataDir, "files", "b"), Buffer.alloc(2048, 2));
    const filled = await estimateBackup({ db: handle.db, dataDir });
    expect(filled.blobBytes).toBe(6144);
  });

  it("reads a real database size rather than reporting zero", async () => {
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    // A PostgreSQL database is never smaller than a few megabytes. Asserting
    // "greater than zero" would pass against a query that silently returned
    // NULL and was coerced.
    expect(estimate.databaseBytes).toBeGreaterThan(1_000_000);
  });

  it("shares its disk arithmetic with the run that enforces it", async () => {
    await mkdir(path.join(dataDir, "files"), { recursive: true });
    await writeFile(path.join(dataDir, "files", "a"), Buffer.alloc(8192, 1));
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    // The SAME function buildBackup calls, so the figure the page shows and the
    // figure the service refuses on cannot drift apart.
    expect(estimate.requiredBytes).toBe(requiredFreeBytes({
      databaseBytes: estimate.databaseBytes, blobBytes: estimate.blobBytes,
    }));
  });

  it("says there is not enough disk when there is not, and by how much", async () => {
    const estimate = await estimateBackup({
      db: handle.db, dataDir, freeBytes: () => Promise.resolve(1024),
    });
    expect(estimate.enoughDisk).toBe(false);
    expect(estimate.shortfallBytes).toBe(estimate.requiredBytes - 1024);
  });

  it("says there is enough when there is, and reports no shortfall", async () => {
    const estimate = await estimateBackup({
      db: handle.db, dataDir, freeBytes: () => Promise.resolve(1024 ** 4),
    });
    expect(estimate.enoughDisk).toBe(true);
    expect(estimate.shortfallBytes).toBe(0);
  });

  /**
   * THE SERVER'S FREE DISK IS NOT IN THE ANSWER, and that is a decision rather
   * than an oversight of the shape. This route deliberately answers WITHOUT a
   * password -- a warning has to come before the commitment it informs -- so
   * everything in its body is readable by any session holder. How much room is
   * left on the disk is exactly the fact that tells somebody how much they
   * would have to write to fill it, and it is not needed to warn anybody about
   * anything.
   */


  it("uses the real free-space probe by default", async () => {
    // Without this the default could be swapped for `() => Infinity` and no
    // test would notice -- the same reason freeSpaceBytes is exported at all.
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    const actual = await freeSpaceBytes(dataDir);
    // Not equality: a busy machine writes between the two calls. Within 1% is
    // the claim that this is the same measurement rather than a constant.
    expect(Math.abs(estimate.availableBytes - actual) / actual).toBeLessThan(0.01);
  });

  it("predicts a duration from the measured rate, and rounds up", async () => {
    await mkdir(path.join(dataDir, "files"), { recursive: true });
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    const expected = Math.ceil(
      (estimate.databaseBytes + estimate.blobBytes) / BACKUP_BYTES_PER_SECOND,
    );
    expect(estimate.estimatedSeconds).toBe(expected);
  });

  it("draws the slow boundary at the threshold, from both sides", () => {
    // Asserted from ABOVE as well as below, which nothing did while this was a
    // comparison buried in an object literal that needed a database to reach.
    expect(isSlowBackup(BACKUP_SLOW_SECONDS - 1)).toBe(false);
    expect(isSlowBackup(BACKUP_SLOW_SECONDS)).toBe(true);
    expect(isSlowBackup(BACKUP_SLOW_SECONDS + 1)).toBe(true);
    expect(isSlowBackup(0)).toBe(false);
  });

  it("does not call a small install slow", async () => {
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    // A scratch test database is a few megabytes: a second or two of work.
    expect(estimate.estimatedSeconds).toBeLessThan(BACKUP_SLOW_SECONDS);
    expect(estimate.slow).toBe(false);
  });

  it("reports the timeout the page has to warn against", async () => {
    const estimate = await estimateBackup({ db: handle.db, dataDir });
    expect(estimate.timeoutSeconds).toBe(BACKUP_PROXY_READ_TIMEOUT_SECONDS);
  });
});

describe("the numbers the warning is made of", () => {
  it("is the rate Task 2 measured for -mx=1, rounded in the SAFE direction", () => {
    // 367,002,306 bytes in 15.0 seconds, from COMPRESSION_LEVEL's own table,
    // which is 24,466,820 B/s. Written out here so that changing the constant
    // without re-measuring means changing a line that says where the
    // measurement came from.
    //
    // THE INEQUALITY IS THE POINT AND IT IS NOT SYMMETRIC. A rate higher than
    // what was measured predicts a SHORTER wait than the real one, and this
    // figure exists to warn -- so it must never be above the measurement. It
    // caught a real mistake: the brief's convenient "24.5 MB/s" is the
    // measurement rounded UP, and the constant was set to it.
    const measuredBytesPerSecond = 367_002_306 / 15.0;
    expect(BACKUP_BYTES_PER_SECOND).toBeLessThanOrEqual(measuredBytesPerSecond);
    // And not so conservative that it stops being that measurement.
    expect(BACKUP_BYTES_PER_SECOND).toBeGreaterThan(measuredBytesPerSecond * 0.99);
  });

  it("gives the raise the headroom the ruling was made for", () => {
    // The old global 300s allowed about 7.3GB. An hour is the reason to raise
    // it at all, and the figures are worth having in a test rather than in
    // prose that nothing checks. Decimal gigabytes, matching the comments on
    // both constants and on the nginx block.
    const oldHeadroomBytes = 300 * BACKUP_BYTES_PER_SECOND;
    const newHeadroomBytes = BACKUP_PROXY_READ_TIMEOUT_SECONDS * BACKUP_BYTES_PER_SECOND;
    expect(oldHeadroomBytes).toBeGreaterThan(7e9);
    expect(oldHeadroomBytes).toBeLessThan(7.5e9);
    expect(newHeadroomBytes).toBeGreaterThan(85e9);
  });
});
