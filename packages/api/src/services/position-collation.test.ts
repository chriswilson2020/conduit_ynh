import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { midpoint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { pipelines, stages, deals } from "../db/schema.js";

const handle = openTestDatabase();

beforeEach(async () => { await truncateAll(handle); });
afterAll(async () => { await handle.close(); });

/**
 * ~60 fractional-index keys built from three insertion patterns a real kanban
 * board actually produces: appending at the tail, prepending at the head, and
 * splitting an existing gap. The three runs are pushed in generation order
 * (not sorted order), so DB insertion order never coincides with the final
 * sorted order below -- an ORDER BY that happened to just echo insertion order
 * back would not be able to fake a pass here.
 */
function buildPositions(): string[] {
  const positions: string[] = [];

  let tail = midpoint(null, null);
  positions.push(tail);
  for (let i = 0; i < 20; i++) {
    tail = midpoint(tail, null);
    positions.push(tail);
  }

  let head = positions[0]!;
  for (let i = 0; i < 20; i++) {
    head = midpoint(null, head);
    positions.push(head);
  }

  for (let i = 0; i < 20; i++) {
    const sorted = [...positions].sort();
    const idx = (Math.floor(sorted.length / 2) + i) % (sorted.length - 1);
    const before = sorted[idx]!;
    const after = sorted[idx + 1]!;
    positions.push(midpoint(before, after));
  }

  return positions;
}

describe("position column collation", () => {
  it("sanity: buildPositions produces ~60 distinct keys", () => {
    const positions = buildPositions();
    expect(positions.length).toBeGreaterThanOrEqual(60);
    expect(new Set(positions).size).toBe(positions.length);
  });

  // This is the failure this whole file exists to guard against: proven here
  // directly, not just asserted, so the guard below has documented teeth. Run
  // against a session-local TEMP TABLE (no COLLATE "C" pin, so it inherits the
  // database's default en_US.UTF-8 collation) inside a single transaction --
  // the connection pool has more than one member, and a temp table is only
  // visible on the connection that created it, so create/insert/select must
  // share one connection.
  it("PROOF: without COLLATE \"C\", en_US.UTF-8 disagrees with JS string sort on these keys", async () => {
    const positions = buildPositions();
    const jsSorted = [...positions].sort();

    const dbOrder = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE position_no_collation (position text) ON COMMIT DROP`);
      for (const p of positions) {
        await tx.execute(sql`INSERT INTO position_no_collation (position) VALUES (${p})`);
      }
      const rows = await tx.execute<{ position: string }>(
        sql`SELECT position FROM position_no_collation ORDER BY position`,
      );
      return rows.map((r) => r.position);
    });

    // Not toEqual: the whole point is that these two orders genuinely differ.
    expect(dbOrder).not.toEqual(jsSorted);
    // Concretely, per the reviewer's finding: en_US.UTF-8 interleaves letter
    // case, so an uppercase and a lowercase key that JS puts on opposite ends
    // of the sort no longer are, under the default collation.
    const jsFirstUpper = jsSorted.findIndex((p) => /[A-Z]/.test(p[0]!));
    const jsFirstLower = jsSorted.findIndex((p) => /[a-z]/.test(p[0]!));
    if (jsFirstUpper !== -1 && jsFirstLower !== -1) {
      const dbFirstUpper = dbOrder.findIndex((p) => /[A-Z]/.test(p[0]!));
      const dbFirstLower = dbOrder.findIndex((p) => /[a-z]/.test(p[0]!));
      const jsOrderHolds = (jsFirstUpper < jsFirstLower) === (dbFirstUpper < dbFirstLower);
      expect(jsOrderHolds).toBe(false);
    }
  });

  // The guard itself: the real `deals.position` column (positionText, pinned
  // to COLLATE "C" in schema.ts) must sort identically to plain JS string
  // comparison, for the same key set that just proved the database's default
  // collation gets it wrong.
  it("the deals.position column sorts identically to JS string comparison", async () => {
    const positions = buildPositions();
    const jsSorted = [...positions].sort();

    const [pipeline] = await handle.db.insert(pipelines)
      .values({ name: "Collation check", scope: "global", position: "a0" }).returning();
    const [stage] = await handle.db.insert(stages)
      .values({ pipelineId: pipeline!.id, name: "Stage", position: "a0" }).returning();
    await handle.db.insert(deals).values(
      positions.map((position) => ({
        title: "Deal", pipelineId: pipeline!.id, stageId: stage!.id, position, currency: "EUR",
      })),
    );

    const rows = await handle.db.select({ position: deals.position }).from(deals)
      .where(eq(deals.stageId, stage!.id)).orderBy(asc(deals.position));
    const dbOrder = rows.map((r) => r.position);

    expect(dbOrder).toEqual(jsSorted);
  });
});
