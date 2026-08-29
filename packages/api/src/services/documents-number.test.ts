import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { documentNumberSequences } from "../db/schema.js";
import { allocateNumber, formatDocumentNumber } from "./documents-number.js";

const handle = openTestDatabase();

beforeEach(async () => { await truncateAll(handle); });
afterAll(async () => { await handle.close(); });

describe("formatDocumentNumber", () => {
  it("formats a quote number with a four-digit sequence", () => {
    expect(formatDocumentNumber("quote", 2026, 1)).toBe("QUO-2026-0001");
  });

  it("does not truncate past four digits", () => {
    expect(formatDocumentNumber("quote", 2026, 12_345)).toBe("QUO-2026-12345");
  });

  // Nothing can reach this today -- documents_type_valid CHECKs `quote` on all three
  // tables -- but a prefix table with a silent fallback is exactly the kind of thing
  // that gets a second entry added without one, so the fallback is pinned rather
  // than left to be discovered by a quote numbered `undefined-2026-0001`.
  it("falls back to DOC for a type with no prefix of its own", () => {
    expect(formatDocumentNumber("invoice", 2026, 7)).toBe("DOC-2026-0007");
  });
});

describe("allocateNumber", () => {
  it("starts at one and counts up within a (type, year)", async () => {
    await handle.db.transaction(async (tx) => {
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0001");
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0002");
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0003");
    });
    const [row] = await handle.db.select().from(documentNumberSequences)
      .where(eq(documentNumberSequences.year, 2026));
    expect(row?.lastValue).toBe(3);
  });

  it("keeps a separate series per year, so January starts again at one", async () => {
    await handle.db.transaction(async (tx) => {
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0001");
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0002");
      expect(await allocateNumber(tx, "quote", 2027)).toBe("QUO-2027-0001");
    });
  });

  // THE PROPERTY THE TABLE EXISTS FOR, and the one a SEQUENCE cannot have: rolling
  // back gives the number back. Without it a failed render leaves a hole, which is
  // the defect the whole one-transaction design is built around.
  it("gives the number back when its transaction rolls back", async () => {
    await expect(handle.db.transaction(async (tx) => {
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0001");
      throw new Error("the render failed");
    })).rejects.toThrow("the render failed");

    const rows = await handle.db.select().from(documentNumberSequences);
    expect(rows).toHaveLength(0);

    await handle.db.transaction(async (tx) => {
      expect(await allocateNumber(tx, "quote", 2026)).toBe("QUO-2026-0001");
    });
  });

  // Two quotes racing for the same (type, year). The ON CONFLICT update takes a row
  // lock held to commit, so the second INSERT blocks on the first's row rather than
  // reading a stale last_value -- which is what makes "no two quotes take the same
  // number" a database property instead of a hope about timing.
  //
  // Both transactions are genuinely open at once (openTestDatabase uses max: 2), so
  // this exercises the lock rather than a queue for a connection.
  it("serialises two concurrent allocations rather than issuing the same number twice", async () => {
    let releaseFirst: () => void = () => { /* replaced below */ };
    const firstHasAllocated = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstNumber = "";
    let secondNumber = "";

    const first = handle.db.transaction(async (tx) => {
      firstNumber = await allocateNumber(tx, "quote", 2026);
      releaseFirst();
      // Hold the lock long enough that the second allocation is certainly waiting
      // on it rather than merely running after it.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const second = (async () => {
      await firstHasAllocated;
      await handle.db.transaction(async (tx) => {
        secondNumber = await allocateNumber(tx, "quote", 2026);
      });
    })();

    await Promise.all([first, second]);
    expect([firstNumber, secondNumber].sort()).toEqual(["QUO-2026-0001", "QUO-2026-0002"]);
  });

  it("refuses a type the CHECK constraint does not know", async () => {
    await expect(handle.db.transaction(async (tx) => {
      await allocateNumber(tx, "invoice", 2026);
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
