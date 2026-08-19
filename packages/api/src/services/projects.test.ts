import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events } from "../db/schema.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal, archiveDeal } from "./deals.js";
import {
  createProject, updateProject, archiveProject, unarchiveProject,
  getProject, listProjects,
} from "./projects.js";
import { NotFoundError, ArchivedError } from "./errors.js";

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

async function makeDeal(companyId?: string) {
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
  return createDeal(handle.db, actorId, { title: "Big deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR");
}

describe("projects service: create", () => {
  it("creates a standalone project and records a created event with no companyId", async () => {
    const project = await createProject(handle.db, actorId, { name: "Q4 rollout" });
    expect(project.name).toBe("Q4 rollout");
    expect(project.status).toBe("active");
    expect(project.companyId).toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.projectId, project.id));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.verb).toBe("created");
    expect(evs[0]?.companyId).toBeNull();
  });

  it("creates a company-linked project and dual-stamps the created event with company_id", async () => {
    const company = await makeCompany();
    const project = await createProject(handle.db, actorId, { name: "Website relaunch", companyId: company.id });
    expect(project.companyId).toBe(company.id);
    const evs = await handle.db.select().from(events).where(eq(events.projectId, project.id));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.verb).toBe("created");
    expect(evs[0]?.companyId).toBe(company.id);
  });

  it("rejects a project whose companyId does not exist", async () => {
    await expect(
      createProject(handle.db, actorId, { name: "X", companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts an archived company as a valid project owner", async () => {
    const company = await makeCompany();
    await archiveCompany(handle.db, actorId, company.id);
    const project = await createProject(handle.db, actorId, { name: "Website relaunch", companyId: company.id });
    expect(project.companyId).toBe(company.id);
  });

  it("rejects a project whose dealId does not exist", async () => {
    await expect(
      createProject(handle.db, actorId, { name: "X", dealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts an archived deal as a valid originating deal", async () => {
    const deal = await makeDeal();
    await archiveDeal(handle.db, actorId, deal.id);
    const project = await createProject(handle.db, actorId, { name: "Onboarding", dealId: deal.id });
    expect(project.dealId).toBe(deal.id);
  });
});

describe("projects service: update", () => {
  it("updates fields via the diff-based patch and records changed field names", async () => {
    const p = await createProject(handle.db, actorId, { name: "Old", color: "#112233" });
    const updated = await updateProject(handle.db, actorId, p.id, { name: "New", color: "#445566" });
    expect(updated.name).toBe("New");
    expect(updated.color).toBe("#445566");
    const evs = await handle.db.select().from(events).where(eq(events.projectId, p.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["name", "color"] });
  });

  it("a same-value patch is a no-op: no event, updatedAt unchanged", async () => {
    const p = await createProject(handle.db, actorId, { name: "Same" });
    const result = await updateProject(handle.db, actorId, p.id, { name: "Same" });
    expect(result.updatedAt).toBe(p.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.projectId, p.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("an empty patch is a no-op and returns the project unchanged", async () => {
    const p = await createProject(handle.db, actorId, { name: "Acme" });
    const result = await updateProject(handle.db, actorId, p.id, {});
    expect(result).toEqual(p);
  });

  // Status is freely settable via the generic update path (no win/lose-style
  // transition matrix, unlike deals) -- completing then reopening must not
  // touch anything else, and in particular must not reach into tasks.ts
  // (which does not even exist yet at this point in the plan).
  it("freely sets status to completed and back to active, no transition matrix", async () => {
    const p = await createProject(handle.db, actorId, { name: "Launch" });
    const completed = await updateProject(handle.db, actorId, p.id, { status: "completed" });
    expect(completed.status).toBe("completed");
    const reopened = await updateProject(handle.db, actorId, p.id, { status: "active" });
    expect(reopened.status).toBe("active");
  });

  it("rejects an update whose companyId does not exist", async () => {
    const p = await createProject(handle.db, actorId, { name: "X" });
    await expect(
      updateProject(handle.db, actorId, p.id, { companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to update an archived project", async () => {
    const p = await createProject(handle.db, actorId, { name: "Old" });
    await archiveProject(handle.db, actorId, p.id);
    await expect(updateProject(handle.db, actorId, p.id, { name: "New" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateProject(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { name: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("projects service: archive/unarchive", () => {
  it("archives and hides from the default list; getProject still returns it", async () => {
    const p = await createProject(handle.db, actorId, { name: "Launch" });
    await archiveProject(handle.db, actorId, p.id);
    expect(await listProjects(handle.db, {})).toHaveLength(0);
    expect(await listProjects(handle.db, { archived: true })).toHaveLength(1);
    expect((await getProject(handle.db, p.id))?.archivedAt).not.toBeNull();
  });

  it("unarchive restores listability", async () => {
    const p = await createProject(handle.db, actorId, { name: "Launch" });
    await archiveProject(handle.db, actorId, p.id);
    await unarchiveProject(handle.db, actorId, p.id);
    expect(await listProjects(handle.db, {})).toHaveLength(1);
  });

  it("archiving an already-archived company-linked project is idempotent: no duplicate event", async () => {
    const company = await makeCompany();
    const p = await createProject(handle.db, actorId, { name: "Launch", companyId: company.id });
    await archiveProject(handle.db, actorId, p.id);
    await archiveProject(handle.db, actorId, p.id);
    const evs = await handle.db.select().from(events).where(eq(events.projectId, p.id));
    expect(evs.filter((e) => e.verb === "archived")).toHaveLength(1);
  });
});

describe("projects service: getProject / listProjects", () => {
  it("returns null for an unknown id", async () => {
    expect(await getProject(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeNull();
  });

  it("filters by companyId, status, and archived", async () => {
    const company = await makeCompany();
    const own = await createProject(handle.db, actorId, { name: "Owned", companyId: company.id });
    await createProject(handle.db, actorId, { name: "Standalone" });
    await updateProject(handle.db, actorId, own.id, { status: "completed" });

    expect((await listProjects(handle.db, { companyId: company.id })).map((p) => p.name)).toEqual(["Owned"]);
    expect((await listProjects(handle.db, { status: "completed" })).map((p) => p.name)).toEqual(["Owned"]);
    expect((await listProjects(handle.db, { status: "active" })).map((p) => p.name)).toEqual(["Standalone"]);

    await archiveProject(handle.db, actorId, own.id);
    expect((await listProjects(handle.db, { companyId: company.id }))).toHaveLength(0);
    expect((await listProjects(handle.db, { companyId: company.id, archived: true })).map((p) => p.name)).toEqual(["Owned"]);
  });
});
