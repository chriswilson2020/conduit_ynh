import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import { createCompany, archiveCompany } from "./companies.js";
import {
  createPipeline, updatePipeline, archivePipeline, unarchivePipeline,
  getPipeline, listPipelines,
  createStage, updateStage, reorderStage,
} from "./pipelines.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

async function makeCompany(name = "Acme") {
  return createCompany(handle.db, actorId, { name });
}

describe("pipelines service: create", () => {
  it("creates a global pipeline with no company and writes no event", async () => {
    const before = await handle.db.select().from(events);
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    expect(pipeline.scope).toBe("global");
    expect(pipeline.companyId).toBeNull();
    const after = await handle.db.select().from(events);
    // Proof of the [decision] comment in pipelines.ts: a global-scope mutation
    // must not grow the events table at all, not just skip a companyId.
    expect(after.length).toBe(before.length);
  });

  it("creates a company-scoped pipeline and writes a created event carrying company_id", async () => {
    const company = await makeCompany();
    // makeCompany itself already wrote one "created" event for the company, so
    // this asserts the increment createPipeline is responsible for, not an
    // absolute count.
    const before = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    const pipeline = await createPipeline(handle.db, actorId, { name: "Acme deals", scope: "company", companyId: company.id });
    expect(pipeline.companyId).toBe(company.id);
    const after = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(after.length).toBe(before.length + 1);
    const created = after.filter((e) => e.verb === "created");
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a company-scoped pipeline whose company does not exist", async () => {
    await expect(
      createPipeline(handle.db, actorId, { name: "X", scope: "company", companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts an archived company as a valid pipeline owner", async () => {
    const company = await makeCompany();
    await archiveCompany(handle.db, actorId, company.id);
    const pipeline = await createPipeline(handle.db, actorId, { name: "Acme deals", scope: "company", companyId: company.id });
    expect(pipeline.companyId).toBe(company.id);
  });

  it("appends strictly ascending positions for successive global pipelines", async () => {
    const a = await createPipeline(handle.db, actorId, { name: "A", scope: "global" });
    const b = await createPipeline(handle.db, actorId, { name: "B", scope: "global" });
    const c = await createPipeline(handle.db, actorId, { name: "C", scope: "global" });
    expect(a.position < b.position).toBe(true);
    expect(b.position < c.position).toBe(true);
  });

  it("scopes position sequences separately: global and per-company pipelines don't interleave", async () => {
    const companyX = await makeCompany("X");
    const companyY = await makeCompany("Y");
    const g1 = await createPipeline(handle.db, actorId, { name: "G1", scope: "global" });
    // The first pipeline in each independent sequence (global, company X, company Y)
    // is midpoint(null, null) computed against an empty sibling set, so all three
    // land on the identical position string -- direct proof the sequences are
    // independent, not proof by inference from ordering alone.
    const x1 = await createPipeline(handle.db, actorId, { name: "X1", scope: "company", companyId: companyX.id });
    const y1 = await createPipeline(handle.db, actorId, { name: "Y1", scope: "company", companyId: companyY.id });
    expect(x1.position).toBe(g1.position);
    expect(y1.position).toBe(g1.position);

    // A second pipeline for company X is appended relative to X1 only, unaffected
    // by G1 or Y1 having been created in between.
    const x2 = await createPipeline(handle.db, actorId, { name: "X2", scope: "company", companyId: companyX.id });
    expect(x1.position < x2.position).toBe(true);
    const y1Again = await listPipelines(handle.db, { companyId: companyY.id });
    expect(y1Again.map((p) => p.position)).toEqual([y1.position]);
  });
});

describe("pipelines service: update", () => {
  it("renames a company-scoped pipeline and records the changed fields on its company", async () => {
    const company = await makeCompany();
    const p = await createPipeline(handle.db, actorId, { name: "Old", scope: "company", companyId: company.id });
    const updated = await updatePipeline(handle.db, actorId, p.id, { name: "New" });
    expect(updated.name).toBe("New");
    const evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["name"] });
  });

  it("renaming a global pipeline writes no event", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Old", scope: "global" });
    const before = await handle.db.select().from(events);
    await updatePipeline(handle.db, actorId, p.id, { name: "New" });
    const after = await handle.db.select().from(events);
    expect(after.length).toBe(before.length);
  });

  it("a same-value patch is a no-op: no event, updatedAt unchanged", async () => {
    const company = await makeCompany();
    const p = await createPipeline(handle.db, actorId, { name: "Same", scope: "company", companyId: company.id });
    const result = await updatePipeline(handle.db, actorId, p.id, { name: "Same" });
    expect(result.updatedAt).toBe(p.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("refuses to update an archived pipeline", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Old", scope: "global" });
    await archivePipeline(handle.db, actorId, p.id);
    await expect(updatePipeline(handle.db, actorId, p.id, { name: "New" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updatePipeline(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("pipelines service: archive/unarchive", () => {
  it("archives and hides from the default list; getPipeline still returns it", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    await archivePipeline(handle.db, actorId, p.id);
    expect(await listPipelines(handle.db, {})).toHaveLength(0);
    expect(await listPipelines(handle.db, { archived: true })).toHaveLength(1);
    expect((await getPipeline(handle.db, p.id))?.pipeline.archivedAt).not.toBeNull();
  });

  it("unarchive restores listability", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    await archivePipeline(handle.db, actorId, p.id);
    await unarchivePipeline(handle.db, actorId, p.id);
    expect(await listPipelines(handle.db, {})).toHaveLength(1);
  });

  it("archiving an already-archived company-scoped pipeline is idempotent: no duplicate event", async () => {
    const company = await makeCompany();
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "company", companyId: company.id });
    await archivePipeline(handle.db, actorId, p.id);
    await archivePipeline(handle.db, actorId, p.id);
    const evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs.filter((e) => e.verb === "archived")).toHaveLength(1);
  });
});

describe("pipelines service: getPipeline / listPipelines", () => {
  it("returns null for an unknown id", async () => {
    expect(await getPipeline(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeNull();
  });

  it("returns stages ordered by position, reflecting insertion and reorder", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "Lead" });
    await createStage(handle.db, actorId, p.id, { name: "Qualified" });
    const s3 = await createStage(handle.db, actorId, p.id, { name: "Won" });

    let got = await getPipeline(handle.db, p.id);
    expect(got?.stages.map((s) => s.name)).toEqual(["Lead", "Qualified", "Won"]);

    // Move "Won" to the front.
    await reorderStage(handle.db, actorId, s3.id, { afterStageId: s1.id });
    got = await getPipeline(handle.db, p.id);
    expect(got?.stages.map((s) => s.name)).toEqual(["Won", "Lead", "Qualified"]);
  });

  it("filters by scope, company, and archived", async () => {
    const company = await makeCompany();
    await createPipeline(handle.db, actorId, { name: "G", scope: "global" });
    const c = await createPipeline(handle.db, actorId, { name: "C", scope: "company", companyId: company.id });
    await archivePipeline(handle.db, actorId, c.id);

    expect((await listPipelines(handle.db, { scope: "global" })).map((p) => p.name)).toEqual(["G"]);
    expect(await listPipelines(handle.db, { companyId: company.id })).toHaveLength(0);
    expect((await listPipelines(handle.db, { companyId: company.id, archived: true })).map((p) => p.name)).toEqual(["C"]);
  });
});

describe("stages service", () => {
  it("rejects stage creation on an archived pipeline", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    await archivePipeline(handle.db, actorId, p.id);
    await expect(createStage(handle.db, actorId, p.id, { name: "Lead" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("rejects stage creation on an unknown pipeline", async () => {
    await expect(createStage(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "Lead" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("appends strictly ascending positions for successive stages", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "Lead" });
    const s2 = await createStage(handle.db, actorId, p.id, { name: "Qualified" });
    const s3 = await createStage(handle.db, actorId, p.id, { name: "Won" });
    expect(s1.position < s2.position).toBe(true);
    expect(s2.position < s3.position).toBe(true);
  });

  it("stage mutations on a company-scoped pipeline emit events; global pipelines emit none", async () => {
    const company = await makeCompany();
    const globalP = await createPipeline(handle.db, actorId, { name: "G", scope: "global" });
    const companyP = await createPipeline(handle.db, actorId, { name: "C", scope: "company", companyId: company.id });

    const beforeAll = await handle.db.select().from(events);
    await createStage(handle.db, actorId, globalP.id, { name: "Lead" });
    const afterGlobalCreate = await handle.db.select().from(events);
    expect(afterGlobalCreate.length).toBe(beforeAll.length);

    const cs = await createStage(handle.db, actorId, companyP.id, { name: "Lead" });
    let evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(1);

    await updateStage(handle.db, actorId, cs.id, { probability: 50 });
    evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(2);

    const cs2 = await createStage(handle.db, actorId, companyP.id, { name: "Won" });
    await reorderStage(handle.db, actorId, cs2.id, { afterStageId: cs.id });
    evs = await handle.db.select().from(events).where(eq(events.companyId, company.id));
    // create(cs), create(cs2), update(probability), reorder = 4 "updated" verbs
    // total, minus the +1 for cs2's own creation counted above.
    expect(evs.filter((e) => e.verb === "updated").length).toBeGreaterThanOrEqual(4);
  });

  it("renames and updates probability/rotDays via the hardened update pattern, no-op on empty patch", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s = await createStage(handle.db, actorId, p.id, { name: "Lead" });
    const updated = await updateStage(handle.db, actorId, s.id, { name: "Qualified", probability: 30, rotDays: 14 });
    expect(updated.name).toBe("Qualified");
    expect(updated.probability).toBe(30);
    expect(updated.rotDays).toBe(14);

    const noop = await updateStage(handle.db, actorId, s.id, { name: "Qualified" });
    expect(noop.updatedAt).toBe(updated.updatedAt);
  });

  it("throws NotFoundError updating an unknown stage", async () => {
    await expect(updateStage(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reorderStage", () => {
  it("moves a stage between two neighbours", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "A" });
    const s2 = await createStage(handle.db, actorId, p.id, { name: "B" });
    const s3 = await createStage(handle.db, actorId, p.id, { name: "C" });

    // Move C between A and B: beforeStageId names the neighbour that ends up
    // immediately before the moved stage (the lower-position bound),
    // afterStageId the one immediately after (the upper-position bound).
    const moved = await reorderStage(handle.db, actorId, s3.id, { beforeStageId: s1.id, afterStageId: s2.id });
    expect(moved.position > s1.position).toBe(true);
    expect(moved.position < s2.position).toBe(true);
  });

  it("moves a stage to the front (no beforeStageId)", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "A" });
    const s2 = await createStage(handle.db, actorId, p.id, { name: "B" });
    // No lower bound (beginning of the list); s1 is the upper bound.
    const moved = await reorderStage(handle.db, actorId, s2.id, { afterStageId: s1.id });
    expect(moved.position < s1.position).toBe(true);
  });

  it("moves a stage to the end (no afterStageId)", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "A" });
    const s2 = await createStage(handle.db, actorId, p.id, { name: "B" });
    // No upper bound (end of the list); s2 is the lower bound.
    const moved = await reorderStage(handle.db, actorId, s1.id, { beforeStageId: s2.id });
    expect(moved.position > s2.position).toBe(true);
  });

  it("throws ConflictError when a neighbour belongs to a different pipeline", async () => {
    const p1 = await createPipeline(handle.db, actorId, { name: "P1", scope: "global" });
    const p2 = await createPipeline(handle.db, actorId, { name: "P2", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p1.id, { name: "A" });
    const other = await createStage(handle.db, actorId, p2.id, { name: "Other" });
    await expect(reorderStage(handle.db, actorId, s1.id, { afterStageId: other.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError for an unknown neighbour id", async () => {
    const p = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const s1 = await createStage(handle.db, actorId, p.id, { name: "A" });
    await expect(reorderStage(handle.db, actorId, s1.id, { afterStageId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for an unknown stage id", async () => {
    await expect(reorderStage(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", {}))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
