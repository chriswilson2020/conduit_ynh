import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, taskDependencies } from "../db/schema.js";
import { createProject } from "./projects.js";
import { createTask, archiveTask, addDependency, getTask } from "./tasks.js";
import { shiftTask, ganttPayload } from "./scheduling.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let actorId: string;

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

async function makeProject(extra: Record<string, unknown> = {}) {
  return createProject(handle.db, actorId, { name: "Launch", ...extra });
}
async function makeDatedTask(extra: Record<string, unknown> = {}) {
  return createTask(handle.db, actorId, { title: "T", startDate: "2026-01-01", dueDate: "2026-01-05", ...extra });
}

describe("shiftTask: linear chain cascade", () => {
  it("A->B->C: dragging A right cascades both B and C by exactly the violation delta, durations preserved", async () => {
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-01", dueDate: "2026-01-05" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-06", dueDate: "2026-01-10" });
    const c = await createTask(handle.db, actorId, { title: "C", startDate: "2026-01-11", dueDate: "2026-01-15" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, b.id, c.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-10", dueDate: "2026-01-14" });

    expect(result.moved).toHaveLength(3);
    expect(result.moved[0]).toEqual({ id: a.id, startDate: "2026-01-10", dueDate: "2026-01-14", cascadedFrom: null });
    const bMoved = result.moved.find((m) => m.id === b.id)!;
    const cMoved = result.moved.find((m) => m.id === c.id)!;
    // B's violation: start 01-06 < A's new due 01-14 -- pushed by 8 days,
    // landing exactly on A's due; 4-day duration preserved (01-10..01-14).
    expect(bMoved).toEqual({ id: b.id, startDate: "2026-01-14", dueDate: "2026-01-18", cascadedFrom: a.id });
    // C's violation: start 01-11 < B's new due 01-18 -- pushed by 7 days;
    // 4-day duration preserved, and cascadedFrom is A (the dragged task),
    // not B (C's immediate predecessor).
    expect(cMoved).toEqual({ id: c.id, startDate: "2026-01-18", dueDate: "2026-01-22", cascadedFrom: a.id });
  });
});

describe("shiftTask: diamond convergence", () => {
  it("P->A, P->B, A->D, B->D: D shifts ONCE by the max of the two paths' violations", async () => {
    const p = await createTask(handle.db, actorId, { title: "P", startDate: "2026-01-01", dueDate: "2026-01-05" });
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-06", dueDate: "2026-01-10" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-06", dueDate: "2026-01-08" });
    const d = await createTask(handle.db, actorId, { title: "D", startDate: "2026-01-11", dueDate: "2026-01-15" });
    await addDependency(handle.db, actorId, p.id, a.id);
    await addDependency(handle.db, actorId, p.id, b.id);
    await addDependency(handle.db, actorId, a.id, d.id);
    await addDependency(handle.db, actorId, b.id, d.id);

    const result = await shiftTask(handle.db, actorId, p.id, { startDate: "2026-01-20", dueDate: "2026-01-24" });

    // A: pushed by 18 days -> 01-24..01-28. B: pushed by 18 days -> 01-24..01-26.
    // D via A needs start >= 01-28 (delta 17); via B needs start >= 01-26
    // (delta 15) -- the two paths disagree, D must land at the MAX: 01-28.
    const dMoved = result.moved.filter((m) => m.id === d.id);
    expect(dMoved).toHaveLength(1);
    expect(dMoved[0]).toEqual({ id: d.id, startDate: "2026-01-28", dueDate: "2026-02-01", cascadedFrom: p.id });

    const dEvents = await handle.db.select().from(events).where(and(eq(events.taskId, d.id), eq(events.verb, "shifted")));
    expect(dEvents).toHaveLength(1);
    expect(dEvents[0]?.payload).toEqual({
      from: { start: "2026-01-11", due: "2026-01-15" },
      to: { start: "2026-01-28", due: "2026-02-01" },
      cascadedFrom: p.id,
    });
  });
});

describe("shiftTask: no-violation and no-pull", () => {
  it("dragging right with enough slack produces no cascade -- result contains only the dragged task", async () => {
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-01", dueDate: "2026-01-05" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-10", dueDate: "2026-01-15" });
    await addDependency(handle.db, actorId, a.id, b.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-06", dueDate: "2026-01-08" });
    expect(result.moved).toEqual([{ id: a.id, startDate: "2026-01-06", dueDate: "2026-01-08", cascadedFrom: null }]);
    expect((await getTask(handle.db, b.id))?.startDate).toBe("2026-01-10");
  });

  it("dragging earlier never pulls a successor left -- slack is legal", async () => {
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-10", dueDate: "2026-01-15" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-20", dueDate: "2026-01-25" });
    await addDependency(handle.db, actorId, a.id, b.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-01", dueDate: "2026-01-05" });
    expect(result.moved).toEqual([{ id: a.id, startDate: "2026-01-01", dueDate: "2026-01-05", cascadedFrom: null }]);
    const bAfter = await getTask(handle.db, b.id);
    expect(bAfter?.startDate).toBe("2026-01-20");
    expect(bAfter?.dueDate).toBe("2026-01-25");
  });
});

describe("shiftTask: null-dated stopper", () => {
  it("a null-dated successor never shifts, and its OWN successors (even if dated) are left untouched", async () => {
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-01", dueDate: "2026-01-05" });
    const b = await createTask(handle.db, actorId, { title: "B" }); // no dates
    const c = await createTask(handle.db, actorId, { title: "C", startDate: "2026-01-06", dueDate: "2026-01-10" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, b.id, c.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-20", dueDate: "2026-01-24" });
    expect(result.moved).toEqual([{ id: a.id, startDate: "2026-01-20", dueDate: "2026-01-24", cascadedFrom: null }]);
    expect((await getTask(handle.db, b.id))?.startDate).toBeNull();
    const cAfter = await getTask(handle.db, c.id);
    expect(cAfter?.startDate).toBe("2026-01-06");
    expect(cAfter?.dueDate).toBe("2026-01-10");
  });
});

describe("shiftTask: zero-duration tasks", () => {
  it("preserves a same-day (start === due) span through a cascade", async () => {
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-01", dueDate: "2026-01-01" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-02", dueDate: "2026-01-02" });
    await addDependency(handle.db, actorId, a.id, b.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-10", dueDate: "2026-01-10" });
    const bMoved = result.moved.find((m) => m.id === b.id)!;
    expect(bMoved.startDate).toBe(bMoved.dueDate);
    expect(bMoved.startDate).toBe("2026-01-10");
  });
});

describe("shiftTask: long chain completes fast", () => {
  it("a 50-node chain, all violated, cascades fully well within the 500-pass depth guard", async () => {
    // All 50 tasks start on the SAME zero-duration day: T(i+1).start
    // (2026-01-01) is not YET less than T(i)'s due (also 2026-01-01) --
    // equal isn't a violation -- but as soon as T0 is dragged forward, every
    // successor's untouched 2026-01-01 start becomes strictly earlier than
    // its (newly pushed) predecessor's due, guaranteeing a real violation at
    // every hop, all the way down the chain.
    const chain = [];
    for (let i = 0; i < 50; i++) {
      chain.push(await createTask(handle.db, actorId, { title: `T${i}`, startDate: "2026-01-01", dueDate: "2026-01-01" }));
    }
    for (let i = 0; i < chain.length - 1; i++) {
      await addDependency(handle.db, actorId, chain[i]!.id, chain[i + 1]!.id);
    }

    const started = Date.now();
    const result = await shiftTask(handle.db, actorId, chain[0]!.id, { startDate: "2026-06-01", dueDate: "2026-06-01" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.moved).toHaveLength(50);
    // Zero duration at every node means each successor lands exactly on its
    // predecessor's due date -- the whole chain converges onto the single
    // day T0 was dragged to.
    expect(result.moved.every((m) => m.startDate === "2026-06-01" && m.dueDate === "2026-06-01")).toBe(true);
  });
});

describe("shiftTask: guards", () => {
  it("throws NotFoundError for an unknown task id", async () => {
    await expect(shiftTask(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", { startDate: "2026-01-01", dueDate: "2026-01-02" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to shift an archived task", async () => {
    const a = await makeDatedTask();
    await archiveTask(handle.db, actorId, a.id);
    await expect(shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-01", dueDate: "2026-01-02" }))
      .rejects.toBeInstanceOf(ArchivedError);
  });

  it("re-asserts startDate <= dueDate for a direct caller bypassing zod", async () => {
    const a = await makeDatedTask();
    const sneaky = { startDate: "2026-01-10", dueDate: "2026-01-05" } as Parameters<typeof shiftTask>[3];
    await expect(shiftTask(handle.db, actorId, a.id, sneaky)).rejects.toThrow();
  });
});

describe("shiftTask: SSE invalidation hints", () => {
  it("publishes tasks/gantt/events keys (no search) plus a my-tasks key per distinct assignee among moved tasks", async () => {
    const other = (await resolveUser(handle.db, { username: "jo", email: null, fullName: null })).id;
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, {
      title: "A", projectId: project.id, assigneeUserId: actorId, startDate: "2026-01-01", dueDate: "2026-01-05",
    });
    const b = await createTask(handle.db, actorId, {
      title: "B", projectId: project.id, assigneeUserId: other, startDate: "2026-01-06", dueDate: "2026-01-10",
    });
    await addDependency(handle.db, actorId, a.id, b.id);

    const hints: string[][][] = [];
    const unsub = subscribe((hint) => hints.push(hint.keys));
    try {
      await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-08", dueDate: "2026-01-12" });
      const flat = (hints[hints.length - 1] ?? []).map((k) => k.join(":"));
      expect(flat).toContain(`tasks:${project.id}`);
      expect(flat).toContain("gantt");
      expect(flat).toContain("events");
      expect(flat).toContain(`my-tasks:${actorId}`);
      expect(flat).toContain(`my-tasks:${other}`);
      expect(flat).not.toContain("search");
    } finally {
      unsub();
    }
  });
});

describe("shiftTask vs addDependency: concurrent, same project", () => {
  it("both succeed, and no interleaving leaves an inconsistent state", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-05" });
    const c = await createTask(handle.db, actorId, { title: "C", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-03" });

    const [depResult, shiftResult] = await Promise.all([
      addDependency(handle.db, actorId, a.id, c.id),
      shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-10", dueDate: "2026-01-14" }),
    ]);
    expect(depResult).toBeDefined();
    expect(shiftResult.moved.length).toBeGreaterThanOrEqual(1);

    const finalA = await getTask(handle.db, a.id);
    const finalC = await getTask(handle.db, c.id);
    const [depRow] = await handle.db.select().from(taskDependencies)
      .where(and(eq(taskDependencies.predecessorId, a.id), eq(taskDependencies.successorId, c.id)));
    expect(depRow).toBeDefined(); // the edge is committed either way -- both calls won

    // Serialisation ORDER between the two racing transactions is NOT
    // observable from committed timestamps: Postgres's now() pins to
    // transaction BEGIN, which is decorrelated from advisory-lock
    // acquisition order, and addDependency's own pre-transaction reads
    // (mustGetTask on predecessor/successor, done via `db` before its
    // transaction even opens) bias BEGIN time further still. Order is
    // therefore deliberately NOT asserted here, by timestamp or otherwise --
    // only that no interleaving produces a THIRD, inconsistent state is
    // checked. There are exactly two legal outcomes, distinguished by
    // whether C's row actually moved (its own committed dates, not a clock):
    //   1. The edge existed when shiftTask's cascade ran: C was pulled along
    //      and its final dates now satisfy the FS constraint against A's
    //      final due date.
    //   2. The edge did not exist yet: C is untouched, exactly as it was
    //      before the race -- a legal, if stale, state under push-only
    //      scheduling, which never retroactively enforces a constraint the
    //      moment an edge lands, only when something is actually dragged (a
    //      future shift on either task would resolve it then).
    // What must never happen -- and what a bug in the shared-lock
    // serialisation would produce -- is a third state: C partially or
    // incorrectly shifted while still violating the constraint.
    const cWasCascaded = finalC!.startDate !== "2026-01-01" || finalC!.dueDate !== "2026-01-03";
    if (cWasCascaded) {
      expect(finalC!.startDate! >= finalA!.dueDate!).toBe(true);
    } else {
      expect(finalC!.startDate).toBe("2026-01-01");
      expect(finalC!.dueDate).toBe("2026-01-03");
    }
  });
});

describe("shiftTask: cross-pass re-convergence", () => {
  it("a task revised upward on a LATER pass re-propagates the revision to its own successors", async () => {
    // A -> B -> E (short path, 2 hops) and A -> C -> D -> E (long path, 3
    // hops) both reach E; C carries a long duration so the long path pushes
    // E further right than the short path does. E is first touched via the
    // short path (whichever of B/D's edges into E is processed first) and
    // must be revised upward once the long path's larger requirement is
    // seen -- and that revision must re-propagate to E's own successor X,
    // which the short-path-only value would have under-shifted.
    const a = await createTask(handle.db, actorId, { title: "A", startDate: "2026-01-01", dueDate: "2026-01-03" });
    const b = await createTask(handle.db, actorId, { title: "B", startDate: "2026-01-04", dueDate: "2026-01-06" });
    const c = await createTask(handle.db, actorId, { title: "C", startDate: "2026-01-04", dueDate: "2026-01-13" });
    const d = await createTask(handle.db, actorId, { title: "D", startDate: "2026-01-14", dueDate: "2026-01-15" });
    const e = await createTask(handle.db, actorId, { title: "E", startDate: "2026-01-07", dueDate: "2026-01-08" });
    const x = await createTask(handle.db, actorId, { title: "X", startDate: "2026-01-09", dueDate: "2026-01-10" });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, a.id, c.id);
    await addDependency(handle.db, actorId, c.id, d.id);
    await addDependency(handle.db, actorId, b.id, e.id);
    await addDependency(handle.db, actorId, d.id, e.id);
    await addDependency(handle.db, actorId, e.id, x.id);

    const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-10", dueDate: "2026-01-12" });

    // Hand-traced (see the termination-argument comment in scheduling.ts):
    // short path pushes E to (01-14, 01-15); the long path (via C's 9-day
    // duration and D) requires E at (01-22, 01-23) -- E must land there, not
    // the short-path value, regardless of which edge into E is processed
    // first.
    const eMoved = result.moved.find((m) => m.id === e.id)!;
    expect(eMoved).toEqual({ id: e.id, startDate: "2026-01-22", dueDate: "2026-01-23", cascadedFrom: a.id });

    const eEvents = await handle.db.select().from(events).where(and(eq(events.taskId, e.id), eq(events.verb, "shifted")));
    expect(eEvents).toHaveLength(1); // exactly one event, however many times E was revised in-memory

    // X must reflect E's FINAL (long-path) due date, not whatever stale
    // value X might have first computed against E's short-path tentative
    // position -- proving the revision re-propagated downstream.
    const xMoved = result.moved.find((m) => m.id === x.id)!;
    expect(xMoved).toEqual({ id: x.id, startDate: "2026-01-23", dueDate: "2026-01-24", cascadedFrom: a.id });
  });
});

describe("ganttPayload", () => {
  it("project scope: only dated, unarchived tasks in that project, with projectName/projectColor joined", async () => {
    const project = await makeProject({ color: "#336699" });
    const dated = await createTask(handle.db, actorId, { title: "Dated", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    await createTask(handle.db, actorId, { title: "Undated", projectId: project.id });
    const archived = await createTask(handle.db, actorId, { title: "Archived", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    await archiveTask(handle.db, actorId, archived.id);

    const payload = await ganttPayload(handle.db, { projectId: project.id });
    expect(payload.tasks.map((t) => t.id)).toEqual([dated.id]);
    expect(payload.tasks[0]?.projectName).toBe("Launch");
    expect(payload.tasks[0]?.projectColor).toBe("#336699");
  });

  it("global scope: includes dated tasks across projects and standalone, with null project name/color for standalone", async () => {
    const project = await makeProject();
    const inProject = await createTask(handle.db, actorId, { title: "InProject", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    const standalone = await createTask(handle.db, actorId, { title: "Standalone", startDate: "2026-01-01", dueDate: "2026-01-02" });

    const payload = await ganttPayload(handle.db, { global: true });
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).toContain(inProject.id);
    expect(ids).toContain(standalone.id);
    const standaloneRow = payload.tasks.find((t) => t.id === standalone.id)!;
    expect(standaloneRow.projectName).toBeNull();
    expect(standaloneRow.projectColor).toBeNull();
  });

  it("root-first ordering: a parent task is immediately followed by its own children, in position order", async () => {
    const project = await makeProject();
    const parent = await createTask(handle.db, actorId, { title: "Parent", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    const child1 = await createTask(handle.db, actorId, { title: "Child1", projectId: project.id, parentTaskId: parent.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    const child2 = await createTask(handle.db, actorId, { title: "Child2", projectId: project.id, parentTaskId: parent.id, startDate: "2026-01-01", dueDate: "2026-01-02" });

    const payload = await ganttPayload(handle.db, { projectId: project.id });
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).toEqual([parent.id, child1.id, child2.id]);
  });

  it("dependency filtering: an edge with one end excluded (undated) is dropped; an edge between two included tasks is kept", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    const undated = await createTask(handle.db, actorId, { title: "Undated", projectId: project.id });
    const c = await createTask(handle.db, actorId, { title: "C", projectId: project.id, startDate: "2026-01-03", dueDate: "2026-01-04" });
    const d = await createTask(handle.db, actorId, { title: "D", projectId: project.id, startDate: "2026-01-05", dueDate: "2026-01-06" });
    await addDependency(handle.db, actorId, a.id, undated.id);
    await addDependency(handle.db, actorId, c.id, d.id);

    const payload = await ganttPayload(handle.db, { projectId: project.id });
    const pairs = payload.dependencies.map((d) => `${d.predecessorId}:${d.successorId}`);
    expect(pairs).not.toContain(`${a.id}:${undated.id}`);
    expect(pairs).toContain(`${c.id}:${d.id}`);
  });

  it("a dated child of an excluded (archived) parent still sorts via the invisible parent's position, without crashing", async () => {
    // The self-join to parentTasks is unfiltered by the dated/archived WHERE
    // above, so it reaches a parent row that is itself excluded from the
    // result set -- graceful degradation, not a bug (see the ORDER BY
    // comment in scheduling.ts): the child still needs SOME position to sort
    // by, and the excluded parent's is the best available anchor.
    const project = await makeProject();
    const parent = await createTask(handle.db, actorId, { title: "Parent", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-02" });
    const child = await createTask(handle.db, actorId, {
      title: "Child", projectId: project.id, parentTaskId: parent.id, startDate: "2026-01-03", dueDate: "2026-01-04",
    });
    await archiveTask(handle.db, actorId, parent.id);

    const payload = await ganttPayload(handle.db, { projectId: project.id });
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).not.toContain(parent.id);
    expect(ids).toContain(child.id);
  });
});
