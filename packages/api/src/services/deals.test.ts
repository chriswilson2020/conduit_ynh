import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { UpdateDealInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact, archiveContact } from "./contacts.js";
import { createPipeline, archivePipeline, createStage } from "./pipelines.js";
import {
  createDeal, updateDeal, archiveDeal, unarchiveDeal,
  moveDeal, winDeal, loseDeal, reopenDeal,
  getDeal, listDeals, funnel,
} from "./deals.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;
const DEFAULT_CURRENCY = "EUR";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

async function makeCompany(name = "Acme") {
  return createCompany(handle.db, actorId, { name });
}
async function makeContact(companyId?: string) {
  return createContact(handle.db, actorId, { firstName: "Jo", companyId: companyId ?? null });
}
async function makePipelineWithStages(names = ["Lead", "Qualified", "Won"]) {
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stages = [];
  for (const name of names) stages.push(await createStage(handle.db, actorId, pipeline.id, { name }));
  return { pipeline, stages };
}
async function makeDeal(pipelineId: string, stageId: string, extra: Record<string, unknown> = {}) {
  return createDeal(handle.db, actorId, { title: "Big Co deal", pipelineId, stageId, ...extra }, DEFAULT_CURRENCY);
}

describe("deals service: create", () => {
  it("appends strictly ascending positions for successive deals in the same stage", async () => {
    const { pipeline, stages } = await makePipelineWithStages();
    const a = await makeDeal(pipeline.id, stages[0]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[0]!.id, { title: "B" });
    const c = await makeDeal(pipeline.id, stages[0]!.id, { title: "C" });
    expect(a.position < b.position).toBe(true);
    expect(b.position < c.position).toBe(true);
  });

  it("scopes position sequences per stage: different stages don't interleave", async () => {
    const { pipeline, stages } = await makePipelineWithStages();
    const a1 = await makeDeal(pipeline.id, stages[0]!.id, { title: "A1" });
    // The first deal in each independent stage sibling group is
    // midpoint(null, null) against an empty set, so it lands on the same
    // position string as a1 -- direct proof the sequences are independent.
    const b1 = await makeDeal(pipeline.id, stages[1]!.id, { title: "B1" });
    expect(b1.position).toBe(a1.position);
  });

  it("defaults currency to the caller-supplied defaultCurrency when omitted", async () => {
    const { pipeline, stages } = await makePipelineWithStages();
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    expect(deal.currency).toBe("EUR");
  });

  it("uses an explicit currency instead of the default when given", async () => {
    const { pipeline, stages } = await makePipelineWithStages();
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { currency: "USD" });
    expect(deal.currency).toBe("USD");
  });

  it("rejects a stage that does not belong to the given pipeline", async () => {
    const { pipeline: p1 } = await makePipelineWithStages(["Lead"]);
    const { stages: p2stages } = await makePipelineWithStages(["Other"]);
    await expect(makeDeal(p1.id, p2stages[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects creation on an archived pipeline", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    await archivePipeline(handle.db, actorId, pipeline.id);
    await expect(makeDeal(pipeline.id, stages[0]!.id)).rejects.toBeInstanceOf(ArchivedError);
  });

  it("rejects an unknown company id", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    await expect(
      makeDeal(pipeline.id, stages[0]!.id, { companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an unknown contact id", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    await expect(
      makeDeal(pipeline.id, stages[0]!.id, { contactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts an archived company as a valid deal target", async () => {
    const company = await makeCompany();
    await archiveCompany(handle.db, actorId, company.id);
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { companyId: company.id });
    expect(deal.companyId).toBe(company.id);
  });

  it("links a deal to a contact", async () => {
    const contact = await makeContact();
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { contactId: contact.id });
    expect(deal.contactId).toBe(contact.id);
  });

  it("accepts an archived contact as a valid deal target", async () => {
    const contact = await makeContact();
    await archiveContact(handle.db, actorId, contact.id);
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { contactId: contact.id });
    expect(deal.contactId).toBe(contact.id);
  });

  it("emits a created event carrying deal_id and company_id when the deal has a company", async () => {
    const company = await makeCompany();
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { companyId: company.id });
    const [ev] = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    expect(ev?.verb).toBe("created");
    expect(ev?.companyId).toBe(company.id);
    expect(ev?.dealId).toBe(deal.id);
  });

  it("emits a created event with a null company_id when the deal has no company", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    const [ev] = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    expect(ev?.companyId).toBeNull();
  });
});

describe("deals service: update", () => {
  it("applies a diff-based patch and records only the changed fields", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 1000 });
    const updated = await updateDeal(handle.db, actorId, deal.id, { title: "Renamed", valueCents: 2000 });
    expect(updated.title).toBe("Renamed");
    expect(updated.valueCents).toBe(2000);
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["title", "valueCents"] });
  });

  it("a same-value patch is a no-op: no event, updatedAt unchanged", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { title: "Same" });
    const result = await updateDeal(handle.db, actorId, deal.id, { title: "Same" });
    expect(result.updatedAt).toBe(deal.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("refuses to update an archived deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await expect(updateDeal(handle.db, actorId, deal.id, { title: "X" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateDeal(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { title: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("ignores a stray pipelineId/stageId/status key smuggled past the type system", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    // Casts around UpdateDealInput's type to simulate a caller that bypasses
    // both the route's zod parsing and the TS type -- proves PATCHABLE_FIELDS
    // enforces the whitelist at runtime, not just at the type boundary.
    const sneaky = { title: "Renamed", stageId: stages[1]!.id, status: "won" } as unknown as UpdateDealInput;
    const updated = await updateDeal(handle.db, actorId, deal.id, sneaky);
    expect(updated.title).toBe("Renamed");
    expect(updated.stageId).toBe(stages[0]!.id);
    expect(updated.status).toBe("open");
  });
});

describe("deals service: archive/unarchive", () => {
  it("archives and hides from the default list; getDeal still returns it", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    expect(await listDeals(handle.db, { pipelineId: pipeline.id })).toHaveLength(0);
    expect(await listDeals(handle.db, { pipelineId: pipeline.id, archived: true })).toHaveLength(1);
    expect((await getDeal(handle.db, deal.id))?.archivedAt).not.toBeNull();
  });

  it("unarchive restores listability", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await unarchiveDeal(handle.db, actorId, deal.id);
    expect(await listDeals(handle.db, { pipelineId: pipeline.id })).toHaveLength(1);
  });

  it("archiving an already-archived deal is idempotent: no duplicate event", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await archiveDeal(handle.db, actorId, deal.id);
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    expect(evs.filter((e) => e.verb === "archived")).toHaveLength(1);
  });
});

describe("moveDeal", () => {
  it("moves a deal between two neighbours in another stage", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const a = await makeDeal(pipeline.id, stages[1]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[1]!.id, { title: "B" });
    const moving = await makeDeal(pipeline.id, stages[0]!.id, { title: "Moving" });

    const moved = await moveDeal(handle.db, actorId, moving.id, {
      stageId: stages[1]!.id, beforeDealId: a.id, afterDealId: b.id,
    });
    expect(moved.stageId).toBe(stages[1]!.id);
    expect(moved.position > a.position).toBe(true);
    expect(moved.position < b.position).toBe(true);
  });

  it("moves a deal to the front of a stage (no beforeDealId)", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const a = await makeDeal(pipeline.id, stages[0]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[0]!.id, { title: "B" });
    const moved = await moveDeal(handle.db, actorId, b.id, { stageId: stages[0]!.id, afterDealId: a.id });
    expect(moved.position < a.position).toBe(true);
  });

  it("moves a deal to the end of a stage (no afterDealId)", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const a = await makeDeal(pipeline.id, stages[0]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[0]!.id, { title: "B" });
    const moved = await moveDeal(handle.db, actorId, a.id, { stageId: stages[0]!.id, beforeDealId: b.id });
    expect(moved.position > b.position).toBe(true);
  });

  it("reorders a deal within its own stage", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const a = await makeDeal(pipeline.id, stages[0]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[0]!.id, { title: "B" });
    const c = await makeDeal(pipeline.id, stages[0]!.id, { title: "C" });
    const moved = await moveDeal(handle.db, actorId, c.id, { stageId: stages[0]!.id, beforeDealId: a.id, afterDealId: b.id });
    expect(moved.position > a.position).toBe(true);
    expect(moved.position < b.position).toBe(true);
  });

  it("throws ConflictError when a neighbour no longer belongs to the target stage (stale board)", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const stray = await makeDeal(pipeline.id, stages[0]!.id, { title: "Stray" });
    const moving = await makeDeal(pipeline.id, stages[0]!.id, { title: "Moving" });
    await expect(
      moveDeal(handle.db, actorId, moving.id, { stageId: stages[1]!.id, afterDealId: stray.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError for an unknown neighbour id", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const moving = await makeDeal(pipeline.id, stages[0]!.id);
    await expect(
      moveDeal(handle.db, actorId, moving.id, { stageId: stages[0]!.id, afterDealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError when the target stage belongs to a different pipeline", async () => {
    const { pipeline: p1, stages: s1 } = await makePipelineWithStages(["Lead"]);
    const { stages: s2 } = await makePipelineWithStages(["Other"]);
    const moving = await makeDeal(p1.id, s1[0]!.id);
    await expect(moveDeal(handle.db, actorId, moving.id, { stageId: s2[0]!.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ConflictError moving a won deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await winDeal(handle.db, actorId, deal.id);
    await expect(moveDeal(handle.db, actorId, deal.id, { stageId: stages[1]!.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ArchivedError moving an archived deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await expect(moveDeal(handle.db, actorId, deal.id, { stageId: stages[1]!.id }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("emits a stage_changed event with from/to ids and names, carrying deal_id and company_id", async () => {
    const company = await makeCompany();
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { companyId: company.id });
    await moveDeal(handle.db, actorId, deal.id, { stageId: stages[1]!.id });
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const moved = evs.find((e) => e.verb === "stage_changed");
    expect(moved?.companyId).toBe(company.id);
    expect(moved?.payload).toEqual({
      from: stages[0]!.id, to: stages[1]!.id, fromName: "Lead", toName: "Won",
    });
  });

  it("two concurrent moves of different deals into the same gap land on distinct, ordered positions", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const a = await makeDeal(pipeline.id, stages[1]!.id, { title: "A" });
    const b = await makeDeal(pipeline.id, stages[1]!.id, { title: "B" });
    const mover1 = await makeDeal(pipeline.id, stages[0]!.id, { title: "M1" });
    const mover2 = await makeDeal(pipeline.id, stages[0]!.id, { title: "M2" });

    const [r1, r2] = await Promise.all([
      moveDeal(handle.db, actorId, mover1.id, { stageId: stages[1]!.id, beforeDealId: a.id, afterDealId: b.id }),
      moveDeal(handle.db, actorId, mover2.id, { stageId: stages[1]!.id, beforeDealId: a.id, afterDealId: b.id }),
    ]);
    expect(r1.position).not.toBe(r2.position);
    expect(r1.position > a.position).toBe(true);
    expect(r1.position < b.position).toBe(true);
    expect(r2.position > a.position).toBe(true);
    expect(r2.position < b.position).toBe(true);
  });
});

describe("win/lose/reopen transitions", () => {
  it("wins an open deal: status, closed_at, and event payload", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 5000, currency: "USD" });
    const won = await winDeal(handle.db, actorId, deal.id);
    expect(won.status).toBe("won");
    expect(won.closedAt).not.toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const ev = evs.find((e) => e.verb === "won");
    expect(ev?.payload).toEqual({ valueCents: 5000, currency: "USD" });
  });

  it("loses an open deal with a reason: status, closed_at, lost_reason, event payload", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    const lost = await loseDeal(handle.db, actorId, deal.id, "Too expensive");
    expect(lost.status).toBe("lost");
    expect(lost.lostReason).toBe("Too expensive");
    expect(lost.closedAt).not.toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    const ev = evs.find((e) => e.verb === "lost");
    expect(ev?.payload).toEqual({ reason: "Too expensive" });
  });

  it("rejects an empty or whitespace-only lost reason", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await expect(loseDeal(handle.db, actorId, deal.id, "   ")).rejects.toThrow();
  });

  it("reopens a won deal: clears closed_at, status back to open", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await winDeal(handle.db, actorId, deal.id);
    const reopened = await reopenDeal(handle.db, actorId, deal.id);
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeNull();
  });

  it("reopens a lost deal: clears closed_at and lost_reason", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await loseDeal(handle.db, actorId, deal.id, "Timing");
    const reopened = await reopenDeal(handle.db, actorId, deal.id);
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.lostReason).toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.dealId, deal.id));
    expect(evs.find((e) => e.verb === "reopened")?.payload).toEqual({});
  });

  it("rejects winning an already-won deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await winDeal(handle.db, actorId, deal.id);
    await expect(winDeal(handle.db, actorId, deal.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects losing a won deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await winDeal(handle.db, actorId, deal.id);
    await expect(loseDeal(handle.db, actorId, deal.id, "reason")).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects reopening an already-open deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await expect(reopenDeal(handle.db, actorId, deal.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects transitioning an archived deal", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    await expect(winDeal(handle.db, actorId, deal.id)).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError transitioning an unknown deal", async () => {
    await expect(winDeal(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getDeal / listDeals", () => {
  it("getDeal returns null for an unknown id", async () => {
    expect(await getDeal(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeNull();
  });

  it("lists deals for a pipeline ordered by (stage, position)", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const b = await makeDeal(pipeline.id, stages[1]!.id, { title: "B" });
    const a = await makeDeal(pipeline.id, stages[0]!.id, { title: "A" });
    const list = await listDeals(handle.db, { pipelineId: pipeline.id });
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
  });

  it("filters by stageId and status", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Won"]);
    const open = await makeDeal(pipeline.id, stages[0]!.id, { title: "Open" });
    const toWin = await makeDeal(pipeline.id, stages[0]!.id, { title: "ToWin" });
    await winDeal(handle.db, actorId, toWin.id);

    expect((await listDeals(handle.db, { pipelineId: pipeline.id, stageId: stages[1]!.id }))).toHaveLength(0);
    const openOnly = await listDeals(handle.db, { pipelineId: pipeline.id, status: "open" });
    expect(openOnly.map((d) => d.id)).toEqual([open.id]);
    const wonOnly = await listDeals(handle.db, { pipelineId: pipeline.id, status: "won" });
    expect(wonOnly.map((d) => d.id)).toEqual([toWin.id]);
  });

  it("excludes archived deals by default and includes them with archived: true", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id);
    await archiveDeal(handle.db, actorId, deal.id);
    expect(await listDeals(handle.db, { pipelineId: pipeline.id })).toHaveLength(0);
    expect(await listDeals(handle.db, { pipelineId: pipeline.id, archived: true })).toHaveLength(1);
  });
});

describe("funnel", () => {
  it("returns count and value sum per stage for open unarchived deals, every stage present", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead", "Qualified", "Won"]);
    await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 1000 });
    await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 2000 });
    const toWin = await makeDeal(pipeline.id, stages[1]!.id, { valueCents: 500 });
    await winDeal(handle.db, actorId, toWin.id);
    // "Won" stage (index 2) never receives a deal in this test -- proof the
    // LEFT JOIN keeps it in the result with zero count/value.

    const rows = await funnel(handle.db, pipeline.id);
    expect(rows).toHaveLength(3);
    const byStage = Object.fromEntries(rows.map((r) => [r.stageId, r]));
    expect(byStage[stages[0]!.id]).toEqual({ stageId: stages[0]!.id, count: 2, valueCents: 3000 });
    // toWin was won, so it must not count toward stage 1's open funnel numbers.
    expect(byStage[stages[1]!.id]).toEqual({ stageId: stages[1]!.id, count: 0, valueCents: 0 });
    expect(byStage[stages[2]!.id]).toEqual({ stageId: stages[2]!.id, count: 0, valueCents: 0 });
  });

  it("treats a null value_cents as 0 in the sum", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 1000 });
    await makeDeal(pipeline.id, stages[0]!.id); // no valueCents given -> null
    const rows = await funnel(handle.db, pipeline.id);
    expect(rows[0]).toEqual({ stageId: stages[0]!.id, count: 2, valueCents: 1000 });
  });

  it("excludes archived deals from the funnel", async () => {
    const { pipeline, stages } = await makePipelineWithStages(["Lead"]);
    const deal = await makeDeal(pipeline.id, stages[0]!.id, { valueCents: 1000 });
    await archiveDeal(handle.db, actorId, deal.id);
    const rows = await funnel(handle.db, pipeline.id);
    expect(rows[0]).toEqual({ stageId: stages[0]!.id, count: 0, valueCents: 0 });
  });
});
