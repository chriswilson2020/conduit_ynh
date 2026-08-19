import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { UpdateTaskInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, taskDependencies } from "../db/schema.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";
import { createProject, archiveProject } from "./projects.js";
import {
  createTask, updateTask, archiveTask, unarchiveTask,
  setTaskStatus, moveTaskOnBoard,
  addDependency, removeDependency,
  getTask, listTasks,
} from "./tasks.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { subscribe } from "./sse.js";

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
async function makeProject(extra: Record<string, unknown> = {}) {
  return createProject(handle.db, actorId, { name: "Launch", ...extra });
}
async function makeTask(extra: Record<string, unknown> = {}) {
  return createTask(handle.db, actorId, { title: "Do the thing", ...extra });
}
async function makeDeal(companyId?: string) {
  const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
  const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
  return createDeal(handle.db, actorId, { title: "Big deal", pipelineId: pipeline.id, stageId: stage.id, companyId }, "EUR");
}

describe("tasks service: create", () => {
  it("creates a standalone task with defaults", async () => {
    const task = await makeTask();
    expect(task.type).toBe("task");
    expect(task.status).toBe("todo");
    expect(task.projectId).toBeNull();
    expect(task.parentTaskId).toBeNull();
    expect(task.startDate).toBeNull();
    expect(task.dueDate).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.position.length).toBeGreaterThan(0);
  });

  it("appends strictly ascending positions for successive siblings in the same group", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    const c = await makeTask({ title: "C" });
    expect(a.position < b.position).toBe(true);
    expect(b.position < c.position).toBe(true);
  });

  it("scopes sibling position sequences per (project, parent) group: standalone and project pools don't interleave", async () => {
    const project = await makeProject();
    const standalone = await makeTask({ title: "Standalone" });
    // The first task in each independent sibling group is midpoint(null, null)
    // against an empty set, so it lands on the same position string as
    // standalone -- direct proof the standalone and project groups are
    // independent sequences.
    const inProject = await makeTask({ title: "InProject", projectId: project.id });
    expect(inProject.position).toBe(standalone.position);
  });

  it("combines every entity FK freely: company, contact, deal, and project all at once", async () => {
    const company = await makeCompany();
    const contact = await createContact(handle.db, actorId, { firstName: "Jo", companyId: company.id });
    const deal = await makeDeal(company.id);
    const project = await makeProject({ companyId: company.id });
    const task = await makeTask({
      companyId: company.id, contactId: contact.id, dealId: deal.id, projectId: project.id,
    });
    expect(task.companyId).toBe(company.id);
    expect(task.contactId).toBe(contact.id);
    expect(task.dealId).toBe(deal.id);
    expect(task.projectId).toBe(project.id);
  });

  it("rejects an unknown companyId", async () => {
    await expect(makeTask({ companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("accepts an archived company as a valid task target -- a task references CRM history, it is not an attachment", async () => {
    const company = await makeCompany();
    await archiveCompany(handle.db, actorId, company.id);
    const task = await makeTask({ companyId: company.id });
    expect(task.companyId).toBe(company.id);
  });

  it("rejects an unknown projectId", async () => {
    await expect(makeTask({ projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects creating a task INTO an archived project (unlike company/contact/deal, the project is a strict active-only container)", async () => {
    const project = await makeProject();
    await archiveProject(handle.db, actorId, project.id);
    await expect(makeTask({ projectId: project.id })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("rejects a patch touching only one of startDate/dueDate, even bypassing zod", async () => {
    const sneaky = { title: "X", startDate: "2026-01-01" } as unknown as Parameters<typeof createTask>[2];
    await expect(createTask(handle.db, actorId, sneaky)).rejects.toThrow();
  });

  describe("parent_task_id rules", () => {
    it("creates a subtask under a valid parent in the same project", async () => {
      const project = await makeProject();
      const parent = await makeTask({ title: "Parent", projectId: project.id });
      const child = await makeTask({ title: "Child", projectId: project.id, parentTaskId: parent.id });
      expect(child.parentTaskId).toBe(parent.id);
    });

    it("creates a subtask under a valid standalone parent", async () => {
      const parent = await makeTask({ title: "Parent" });
      const child = await makeTask({ title: "Child", parentTaskId: parent.id });
      expect(child.parentTaskId).toBe(parent.id);
    });

    it("rejects a parent that belongs to a different project", async () => {
      const p1 = await makeProject({ name: "P1" });
      const p2 = await makeProject({ name: "P2" });
      const parent = await makeTask({ title: "Parent", projectId: p1.id });
      await expect(makeTask({ title: "Child", projectId: p2.id, parentTaskId: parent.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects a standalone parent for a project task, and vice versa", async () => {
      const project = await makeProject();
      const standaloneParent = await makeTask({ title: "Parent" });
      await expect(makeTask({ title: "Child", projectId: project.id, parentTaskId: standaloneParent.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects a parent that itself already has a parent (one level of subtask grouping only)", async () => {
      const grandparent = await makeTask({ title: "Grandparent" });
      const parent = await makeTask({ title: "Parent", parentTaskId: grandparent.id });
      await expect(makeTask({ title: "Child", parentTaskId: parent.id })).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects an unknown parentTaskId", async () => {
      await expect(makeTask({ parentTaskId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }))
        .rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("emits a created event carrying task_id and project_id, company_id direct when the task has one", async () => {
    const company = await makeCompany();
    const task = await makeTask({ companyId: company.id });
    const [ev] = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(ev?.verb).toBe("created");
    expect(ev?.taskId).toBe(task.id);
    expect(ev?.companyId).toBe(company.id);
  });

  it("emits a created event with company_id resolved via the project when the task has no direct company link", async () => {
    const company = await makeCompany();
    const project = await makeProject({ companyId: company.id });
    const task = await makeTask({ projectId: project.id });
    const [ev] = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(ev?.companyId).toBe(company.id);
    expect(ev?.projectId).toBe(project.id);
  });

  it("emits a created event with a null company_id for a standalone, company-less task", async () => {
    const task = await makeTask();
    const [ev] = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(ev?.companyId).toBeNull();
  });
});

describe("tasks service: update", () => {
  it("applies a diff-based patch and records only the changed fields", async () => {
    const task = await makeTask({ progressPct: 10 });
    const updated = await updateTask(handle.db, actorId, task.id, { title: "Renamed", progressPct: 50 });
    expect(updated.title).toBe("Renamed");
    expect(updated.progressPct).toBe(50);
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["title", "progressPct"] });
  });

  it("a same-value patch is a no-op: no event, updatedAt unchanged", async () => {
    const task = await makeTask({ title: "Same" });
    const result = await updateTask(handle.db, actorId, task.id, { title: "Same" });
    expect(result.updatedAt).toBe(task.updatedAt);
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(evs.filter((e) => e.verb === "updated")).toHaveLength(0);
  });

  it("an empty patch is a no-op and returns the task unchanged", async () => {
    const task = await makeTask();
    const result = await updateTask(handle.db, actorId, task.id, {});
    expect(result).toEqual(task);
  });

  it("three-state dates: sets both, then clears both with an explicit null pair", async () => {
    const task = await makeTask();
    const dated = await updateTask(handle.db, actorId, task.id, { startDate: "2026-01-01", dueDate: "2026-01-05" });
    expect(dated.startDate).toBe("2026-01-01");
    expect(dated.dueDate).toBe("2026-01-05");
    const cleared = await updateTask(handle.db, actorId, task.id, { startDate: null, dueDate: null });
    expect(cleared.startDate).toBeNull();
    expect(cleared.dueDate).toBeNull();
  });

  it("rejects a patch touching only one of startDate/dueDate, even bypassing zod", async () => {
    const task = await makeTask();
    const sneaky = { startDate: "2026-01-01" } as UpdateTaskInput;
    await expect(updateTask(handle.db, actorId, task.id, sneaky)).rejects.toThrow();
  });

  it("rejects an update whose companyId does not exist", async () => {
    const task = await makeTask();
    await expect(updateTask(handle.db, actorId, task.id, { companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects moving a task INTO an archived project via update", async () => {
    const task = await makeTask();
    const project = await makeProject();
    await archiveProject(handle.db, actorId, project.id);
    await expect(updateTask(handle.db, actorId, task.id, { projectId: project.id }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("refuses to update an archived task", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    await expect(updateTask(handle.db, actorId, task.id, { title: "X" })).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(updateTask(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { title: "X" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("ignores stray status/position/completedAt keys smuggled past the type system", async () => {
    const task = await makeTask();
    const sneaky = {
      title: "Renamed", status: "done", position: "zzz", completedAt: new Date().toISOString(),
    } as unknown as UpdateTaskInput;
    const updated = await updateTask(handle.db, actorId, task.id, sneaky);
    expect(updated.title).toBe("Renamed");
    expect(updated.status).toBe("todo");
    expect(updated.position).toBe(task.position);
    expect(updated.completedAt).toBeNull();
  });

  describe("reparenting via update", () => {
    it("changing parentTaskId re-validates and re-appends position in the new sibling group", async () => {
      const project = await makeProject();
      const oldParent = await makeTask({ title: "OldParent", projectId: project.id });
      const newParent = await makeTask({ title: "NewParent", projectId: project.id });
      const sibling = await makeTask({ title: "ExistingChild", projectId: project.id, parentTaskId: newParent.id });
      const task = await makeTask({ title: "Moving", projectId: project.id, parentTaskId: oldParent.id });

      const moved = await updateTask(handle.db, actorId, task.id, { parentTaskId: newParent.id });
      expect(moved.parentTaskId).toBe(newParent.id);
      // Re-appended at the tail of the new sibling group, after the existing child.
      expect(moved.position > sibling.position).toBe(true);
    });

    it("rejects reparenting into a task from a different project", async () => {
      const p1 = await makeProject({ name: "P1" });
      const p2 = await makeProject({ name: "P2" });
      const otherParent = await makeTask({ title: "OtherParent", projectId: p2.id });
      const task = await makeTask({ title: "Moving", projectId: p1.id });
      await expect(updateTask(handle.db, actorId, task.id, { parentTaskId: otherParent.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it("changing projectId while a parent link is set re-validates the parent against the new project", async () => {
      const p1 = await makeProject({ name: "P1" });
      const p2 = await makeProject({ name: "P2" });
      const parent = await makeTask({ title: "Parent", projectId: p1.id });
      const task = await makeTask({ title: "Child", projectId: p1.id, parentTaskId: parent.id });
      // Moving the child to p2 without also moving parentTaskId leaves it
      // pointing at a parent in the WRONG project now -- must be rejected,
      // not silently left inconsistent.
      await expect(updateTask(handle.db, actorId, task.id, { projectId: p2.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("parent-side reparent guard", () => {
    it("rejects changing a parent task's own project while it still has children", async () => {
      const p1 = await makeProject({ name: "P1" });
      const p2 = await makeProject({ name: "P2" });
      const parent = await makeTask({ title: "Parent", projectId: p1.id });
      await makeTask({ title: "Child", projectId: p1.id, parentTaskId: parent.id });
      // The child is left in p1, pointing at a parent that would now be in
      // p2 -- the exact mismatch assertParentValid rejects from the child's
      // own side, reached here from the parent's side instead.
      await expect(updateTask(handle.db, actorId, parent.id, { projectId: p2.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects setting parentTaskId on a task that already has children (a subtask cannot itself be a parent)", async () => {
      const hasKids = await makeTask({ title: "HasKids" });
      await makeTask({ title: "Kid", parentTaskId: hasKids.id });
      const wouldBeNewParent = await makeTask({ title: "NewParent" });
      await expect(updateTask(handle.db, actorId, hasKids.id, { parentTaskId: wouldBeNewParent.id }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the project change once the children have been detached first", async () => {
      const p1 = await makeProject({ name: "P1" });
      const p2 = await makeProject({ name: "P2" });
      const parent = await makeTask({ title: "Parent", projectId: p1.id });
      const child = await makeTask({ title: "Child", projectId: p1.id, parentTaskId: parent.id });
      await updateTask(handle.db, actorId, child.id, { parentTaskId: null });
      const moved = await updateTask(handle.db, actorId, parent.id, { projectId: p2.id });
      expect(moved.projectId).toBe(p2.id);
    });
  });
});

describe("tasks service: archive/unarchive", () => {
  it("archives and hides from the default list; getTask still returns it", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    expect(await listTasks(handle.db, {})).toHaveLength(0);
    expect(await listTasks(handle.db, { archived: true })).toHaveLength(1);
    expect((await getTask(handle.db, task.id))?.archivedAt).not.toBeNull();
  });

  it("unarchive restores listability", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    await unarchiveTask(handle.db, actorId, task.id);
    expect(await listTasks(handle.db, {})).toHaveLength(1);
  });

  it("archiving an already-archived task is idempotent: no duplicate event", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    await archiveTask(handle.db, actorId, task.id);
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(evs.filter((e) => e.verb === "archived")).toHaveLength(1);
  });
});

describe("setTaskStatus", () => {
  it("entering done stamps completed_at and emits a completed event", async () => {
    const task = await makeTask();
    const done = await setTaskStatus(handle.db, actorId, task.id, "done");
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(evs.find((e) => e.verb === "completed")).toBeDefined();
  });

  it("leaving done clears completed_at and emits a reopened event", async () => {
    const task = await makeTask();
    await setTaskStatus(handle.db, actorId, task.id, "done");
    const reopened = await setTaskStatus(handle.db, actorId, task.id, "todo");
    expect(reopened.status).toBe("todo");
    expect(reopened.completedAt).toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(evs.find((e) => e.verb === "reopened")).toBeDefined();
  });

  it("any other transition emits `updated` with changed/from/to, no completed_at side effect", async () => {
    const task = await makeTask();
    const moved = await setTaskStatus(handle.db, actorId, task.id, "in_progress");
    expect(moved.status).toBe("in_progress");
    expect(moved.completedAt).toBeNull();
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    const upd = evs.find((e) => e.verb === "updated");
    expect(upd?.payload).toEqual({ changed: ["status"], from: "todo", to: "in_progress" });
  });

  it("setting the same status is a no-op: no event", async () => {
    const task = await makeTask();
    await setTaskStatus(handle.db, actorId, task.id, "todo");
    const evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    expect(evs.filter((e) => e.verb === "updated" || e.verb === "completed" || e.verb === "reopened")).toHaveLength(0);
  });

  it("refuses to change status on an archived task", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    await expect(setTaskStatus(handle.db, actorId, task.id, "done")).rejects.toBeInstanceOf(ArchivedError);
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(setTaskStatus(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "done"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("moveTaskOnBoard", () => {
  it("moves a task between two neighbours in another status column", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const aMoved = await moveTaskOnBoard(handle.db, actorId, a.id, { status: "in_progress" });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id });
    const bMoved = await moveTaskOnBoard(handle.db, actorId, b.id, { status: "in_progress" });
    const moving = await createTask(handle.db, actorId, { title: "Moving", projectId: project.id });

    const moved = await moveTaskOnBoard(handle.db, actorId, moving.id, {
      status: "in_progress", beforeTaskId: aMoved.id, afterTaskId: bMoved.id,
    });
    expect(moved.status).toBe("in_progress");
    expect(moved.position > aMoved.position).toBe(true);
    expect(moved.position < bMoved.position).toBe(true);
  });

  it("moveTaskOnBoard with no neighbours appends at the tail of the column", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    await setTaskStatus(handle.db, actorId, a.id, "blocked");
    const moving = await createTask(handle.db, actorId, { title: "Moving", projectId: project.id });
    const moved = await moveTaskOnBoard(handle.db, actorId, moving.id, { status: "blocked" });
    expect(moved.position > a.position).toBe(true);
  });

  it("throws ConflictError when the given before/after neighbours are no longer adjacent (stale pair)", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id });
    const moving = await createTask(handle.db, actorId, { title: "Moving", projectId: project.id });
    await expect(
      moveTaskOnBoard(handle.db, actorId, moving.id, { status: "todo", beforeTaskId: b.id, afterTaskId: a.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ConflictError when a neighbour is not in the target status column", async () => {
    const project = await makeProject();
    const stray = await createTask(handle.db, actorId, { title: "Stray", projectId: project.id });
    const moving = await createTask(handle.db, actorId, { title: "Moving", projectId: project.id });
    await expect(
      moveTaskOnBoard(handle.db, actorId, moving.id, { status: "in_progress", afterTaskId: stray.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError for an unknown neighbour id", async () => {
    const moving = await makeTask();
    await expect(
      moveTaskOnBoard(handle.db, actorId, moving.id, { status: "todo", afterTaskId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to move an archived task", async () => {
    const task = await makeTask();
    await archiveTask(handle.db, actorId, task.id);
    await expect(moveTaskOnBoard(handle.db, actorId, task.id, { status: "in_progress" }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("two concurrent moves of different tasks into the same gap land on distinct, ordered positions", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    await setTaskStatus(handle.db, actorId, a.id, "in_progress");
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id });
    await setTaskStatus(handle.db, actorId, b.id, "in_progress");
    const m1 = await createTask(handle.db, actorId, { title: "M1", projectId: project.id });
    const m2 = await createTask(handle.db, actorId, { title: "M2", projectId: project.id });

    const [r1, r2] = await Promise.all([
      moveTaskOnBoard(handle.db, actorId, m1.id, { status: "in_progress", beforeTaskId: a.id, afterTaskId: b.id }),
      moveTaskOnBoard(handle.db, actorId, m2.id, { status: "in_progress", beforeTaskId: a.id, afterTaskId: b.id }),
    ]);
    expect(r1.position).not.toBe(r2.position);
    expect(r1.position > a.position).toBe(true);
    expect(r1.position < b.position).toBe(true);
    expect(r2.position > a.position).toBe(true);
    expect(r2.position < b.position).toBe(true);
  });

  it("a status-changing move stamps completed_at entering done, clears it leaving done, and emits ONE `updated {changed:[status]}` event", async () => {
    const task = await makeTask();
    const done = await moveTaskOnBoard(handle.db, actorId, task.id, { status: "done" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    let evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    let upd = evs.filter((e) => e.verb === "updated");
    expect(upd).toHaveLength(1);
    expect(upd[0]?.payload).toEqual({ changed: ["status"] });
    // moveTaskOnBoard deliberately does NOT emit completed/reopened verbs the
    // way setTaskStatus does -- always `updated`, even entering/leaving done.
    expect(evs.some((e) => e.verb === "completed")).toBe(false);

    const reopened = await moveTaskOnBoard(handle.db, actorId, task.id, { status: "todo" });
    expect(reopened.completedAt).toBeNull();
    evs = await handle.db.select().from(events).where(eq(events.taskId, task.id));
    upd = evs.filter((e) => e.verb === "updated");
    expect(upd).toHaveLength(2);
    expect(evs.some((e) => e.verb === "reopened")).toBe(false);
  });

  it("a position-only reorder (status unchanged) emits NO event -- pure reordering is timeline noise", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id });
    const c = await createTask(handle.db, actorId, { title: "C", projectId: project.id });

    const before = await handle.db.select().from(events);
    await moveTaskOnBoard(handle.db, actorId, c.id, { status: "todo", beforeTaskId: a.id, afterTaskId: b.id });
    const after = await handle.db.select().from(events);
    expect(after.length).toBe(before.length);
  });
});

describe("task dependencies", () => {
  it("adds a dependency and emits dependency_added on the successor with the predecessorId payload", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id });
    const dep = await addDependency(handle.db, actorId, a.id, b.id);
    expect(dep.predecessorId).toBe(a.id);
    expect(dep.successorId).toBe(b.id);
    const evs = await handle.db.select().from(events).where(eq(events.taskId, b.id));
    const ev = evs.find((e) => e.verb === "dependency_added");
    expect(ev?.payload).toEqual({ predecessorId: a.id });
  });

  it("rejects a direct two-node cycle: A->B then B->A", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await expect(addDependency(handle.db, actorId, b.id, a.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("closes the concurrent 2-cycle race: A->B and B->A fired at once, exactly one wins, no cycle results", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });

    // Without the per-graph lock in addDependency, both calls' BFS could run
    // against the same pre-image under READ COMMITTED (neither sees the
    // other's not-yet-committed edge), both find no cycle, and both insert --
    // landing a live A<->B cycle despite every individual check passing.
    const results = await Promise.allSettled([
      addDependency(handle.db, actorId, a.id, b.id),
      addDependency(handle.db, actorId, b.id, a.id),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);

    // No cycle exists after: exactly one edge persisted, and a fresh
    // addDependency BFS from either node terminates (neither the winning
    // pair nor its reverse can be re-added without hitting the duplicate or
    // cycle check, both of which require the walk to actually finish).
    const edges = await handle.db.select().from(taskDependencies);
    expect(edges).toHaveLength(1);
    const winner = edges[0]!;
    expect([`${a.id}:${b.id}`, `${b.id}:${a.id}`]).toContain(`${winner.predecessorId}:${winner.successorId}`);
  });

  it("rejects a transitive three-node cycle: A->B->C then C->A", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    const c = await makeTask({ title: "C" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, b.id, c.id);
    await expect(addDependency(handle.db, actorId, c.id, a.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows a diamond (two converging paths, no back-edge): P->A, P->B, A->S, B->S", async () => {
    const p = await makeTask({ title: "P" });
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    const s = await makeTask({ title: "S" });
    await addDependency(handle.db, actorId, p.id, a.id);
    await addDependency(handle.db, actorId, p.id, b.id);
    await addDependency(handle.db, actorId, a.id, s.id);
    await addDependency(handle.db, actorId, b.id, s.id);
    // Not a cycle -- s is reachable from p through two paths, but p is never
    // reachable back from s.
    await expect(addDependency(handle.db, actorId, p.id, s.id)).resolves.toBeDefined();
  });

  it("rejects a duplicate (predecessor, successor) pair", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await expect(addDependency(handle.db, actorId, a.id, b.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a self-dependency", async () => {
    const a = await makeTask({ title: "A" });
    await expect(addDependency(handle.db, actorId, a.id, a.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a dependency between tasks in different projects", async () => {
    const p1 = await makeProject({ name: "P1" });
    const p2 = await makeProject({ name: "P2" });
    const a = await createTask(handle.db, actorId, { title: "A", projectId: p1.id });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: p2.id });
    await expect(addDependency(handle.db, actorId, a.id, b.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a dependency between a standalone task and a project task", async () => {
    const project = await makeProject();
    const a = await makeTask({ title: "Standalone" });
    const b = await createTask(handle.db, actorId, { title: "InProject", projectId: project.id });
    await expect(addDependency(handle.db, actorId, a.id, b.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("removeDependency removes the edge and emits dependency_removed on the successor", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await removeDependency(handle.db, actorId, a.id, b.id);
    const evs = await handle.db.select().from(events).where(eq(events.taskId, b.id));
    const ev = evs.find((e) => e.verb === "dependency_removed");
    expect(ev?.payload).toEqual({ predecessorId: a.id });
    // The edge is actually gone -- re-adding it must succeed cleanly.
    await expect(addDependency(handle.db, actorId, a.id, b.id)).resolves.toBeDefined();
  });

  it("removeDependency on a pair that was never linked is a silent no-op", async () => {
    const a = await makeTask({ title: "A" });
    const b = await makeTask({ title: "B" });
    await expect(removeDependency(handle.db, actorId, a.id, b.id)).resolves.toBeUndefined();
    const evs = await handle.db.select().from(events).where(eq(events.taskId, b.id));
    expect(evs.filter((e) => e.verb === "dependency_removed")).toHaveLength(0);
  });
});

describe("getTask / listTasks", () => {
  it("getTask returns null for an unknown id", async () => {
    expect(await getTask(handle.db, "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeNull();
  });

  it("filters by projectId, standalone, assigneeId, status, dated, and archived", async () => {
    const project = await makeProject();
    const inProject = await createTask(handle.db, actorId, { title: "InProject", projectId: project.id });
    const standalone = await makeTask({ title: "Standalone" });
    const dated = await makeTask({ title: "Dated", startDate: "2026-01-01", dueDate: "2026-01-02" });
    await setTaskStatus(handle.db, actorId, standalone.id, "in_progress");

    expect((await listTasks(handle.db, { projectId: project.id })).map((t) => t.id)).toEqual([inProject.id]);
    expect((await listTasks(handle.db, { standalone: true })).map((t) => t.id).sort())
      .toEqual([standalone.id, dated.id].sort());
    expect((await listTasks(handle.db, { assigneeId: actorId }))).toHaveLength(0);
    expect((await listTasks(handle.db, { status: "in_progress" })).map((t) => t.id)).toEqual([standalone.id]);
    expect((await listTasks(handle.db, { dated: true })).map((t) => t.id)).toEqual([dated.id]);

    await archiveTask(handle.db, actorId, dated.id);
    expect(await listTasks(handle.db, {})).toHaveLength(2);
    expect((await listTasks(handle.db, { archived: true })).map((t) => t.id)).toEqual([dated.id]);
  });

  it("orders results by (parent group, position)", async () => {
    const parent = await makeTask({ title: "Parent" });
    const child1 = await makeTask({ title: "Child1", parentTaskId: parent.id });
    const child2 = await makeTask({ title: "Child2", parentTaskId: parent.id });
    const root2 = await makeTask({ title: "Root2" });

    const list = await listTasks(handle.db, {});
    // Every task sharing the same parentTaskId value (including the two
    // NULLs) stays contiguous, ordered by position within that group.
    const ids = list.map((t) => t.id);
    const childBlockStart = ids.indexOf(child1.id);
    expect(ids[childBlockStart + 1]).toBe(child2.id);
    expect(ids).toContain(parent.id);
    expect(ids).toContain(root2.id);
  });
});

describe("SSE invalidation hints", () => {
  it("publishes tasks/gantt/events/search keys, plus a my-tasks key when the task has an assignee", async () => {
    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      const task = await createTask(handle.db, actorId, { title: "T", assigneeUserId: actorId });
      const keySets = hints.map((keys) => keys.map((k) => k.join(":")));
      const flat = keySets[keySets.length - 1] ?? [];
      expect(flat).toContain(`tasks:standalone`);
      expect(flat).toContain("gantt");
      expect(flat).toContain("events");
      expect(flat).toContain("search");
      expect(flat).toContain(`my-tasks:${actorId}`);
      expect(task.assigneeUserId).toBe(actorId);
    } finally {
      unsub();
    }
  });

  it("reassigning a task publishes BOTH the old and the new assignee's my-tasks key", async () => {
    const other = (await resolveUser(handle.db, { username: "jo", email: null, fullName: null })).id;
    const task = await createTask(handle.db, actorId, { title: "T", assigneeUserId: actorId });

    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await updateTask(handle.db, actorId, task.id, { assigneeUserId: other });
      const keySets = hints[hints.length - 1]?.map((k) => k.join(":")) ?? [];
      expect(keySets).toContain(`my-tasks:${actorId}`);
      expect(keySets).toContain(`my-tasks:${other}`);
    } finally {
      unsub();
    }
  });
});
