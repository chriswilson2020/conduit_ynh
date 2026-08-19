import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, taskDependencies } from "../db/schema.js";
import { createProject, archiveProject } from "./projects.js";
import { createTask, archiveTask, addDependency, getTask, setTaskStatus } from "./tasks.js";
import { shiftTask, ganttPayload, compactSchedule, todayDateOnly, addDays } from "./scheduling.js";
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
      const result = await shiftTask(handle.db, actorId, a.id, { startDate: "2026-01-08", dueDate: "2026-01-12" });
      // The drag cascaded onto B too (its startDate no longer clears A's new
      // dueDate) -- both ids must actually be in the result for the
      // per-task-key assertion below to mean anything.
      expect(result.moved.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

      const flat = (hints[hints.length - 1] ?? []).map((k) => k.join(":"));
      expect(flat).toContain(`tasks:${project.id}`);
      expect(flat).toContain("gantt");
      expect(flat).toContain("events");
      expect(flat).toContain(`my-tasks:${actorId}`);
      expect(flat).toContain(`my-tasks:${other}`);
      expect(flat).not.toContain("search");
      // A ["task", id] per moved task -- mirrors publishTaskHint's own key
      // (tasks.ts), so a task drawer open on a cascaded task (not just the
      // dragged one) also picks up its shifted dates live.
      expect(flat).toContain(`task:${a.id}`);
      expect(flat).toContain(`task:${b.id}`);
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

describe("compactSchedule", () => {
  // Every date in this block (bar the two self-floor-defining, permanently
  // clamp-immune cases noted at their own tests) is expressed relative to
  // "today" rather than as a fixed calendar date. These tests exercise plain
  // compaction/floor/diamond semantics, not Fix 2's today-clamp (hotfix
  // v0.4.3, see scheduling.ts's TODAY CLAMP comment) -- so every date here is
  // offset comfortably (60+ days) into the future from whenever the suite
  // actually runs, which keeps the clamp from ever engaging and keeps these
  // tests valid on any run day, not just the day they were written.
  const day = (n: number) => addDays(todayDateOnly(), n);

  it("chain compacts left, each successor settling against its PREDECESSOR's already-compacted due date", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id, startDate: day(69), dueDate: day(73) });
    const c = await createTask(handle.db, actorId, { title: "C", projectId: project.id, startDate: day(79), dueDate: day(83) });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, b.id, c.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // A has no predecessors, so (Fix 1, hotfix v0.4.2) it's subject to the
    // floor-pull rule -- but it stays put anyway, because with no project
    // startDate and nothing done/in_progress, A is itself the earliest dated
    // task in the project, i.e. A DEFINES the floor it would otherwise pull
    // toward. Not in the moved list at all.
    expect(result.moved.some((m) => m.id === a.id)).toBe(false);
    // B: pulled to sit exactly on A's due date, 4-day duration preserved.
    const bMoved = result.moved.find((m) => m.id === b.id)!;
    expect(bMoved).toEqual({ id: b.id, startDate: day(64), dueDate: day(68), cascadedFrom: null });
    // C settles against B's NEW (compacted) due date, not B's original one --
    // this is the one-topological-pass argument in action.
    const cMoved = result.moved.find((m) => m.id === c.id)!;
    expect(cMoved).toEqual({ id: c.id, startDate: day(68), dueDate: day(72), cascadedFrom: null });

    expect((await getTask(handle.db, a.id))?.startDate).toBe(day(60));
  });

  it("a sole no-predecessor task never moves -- it defines the floor it would otherwise pull toward (Fix 1)", async () => {
    // Self-floor-defining (the project's only dated task), so this is
    // permanently immune to Fix 2's today-clamp regardless of how far in the
    // past or future its own dates sit -- see this function's TODAY CLAMP
    // doc comment: a task the pull-only rule leaves alone isn't being pulled
    // anywhere, so there's nothing for the clamp to clamp. Deliberately kept
    // as a fixed past-relative-to-2026-08-19 date to prove exactly that.
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: "2026-02-10", dueDate: "2026-02-12" });

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved).toEqual([]);
    const after = await getTask(handle.db, a.id);
    expect(after?.startDate).toBe("2026-02-10");
    expect(after?.dueDate).toBe("2026-02-12");
  });

  it("done/in_progress tasks never move themselves, but their (unchanged) due date still constrains successors", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    await setTaskStatus(handle.db, actorId, a.id, "done");
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id, startDate: day(69), dueDate: day(74) });
    await addDependency(handle.db, actorId, a.id, b.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved.some((m) => m.id === a.id)).toBe(false);
    const aAfter = await getTask(handle.db, a.id);
    expect(aAfter?.startDate).toBe(day(60));
    expect(aAfter?.dueDate).toBe(day(64));
    // B still settles against A's due date, 5-day duration preserved.
    const bMoved = result.moved.find((m) => m.id === b.id)!;
    expect(bMoved).toEqual({ id: b.id, startDate: day(64), dueDate: day(69), cascadedFrom: null });
  });

  it("a constraint VIOLATION (successor starts before predecessor's due) is fixed by pushing the successor right", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(69) });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id, startDate: day(61), dueDate: day(63) });
    await addDependency(handle.db, actorId, a.id, b.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    const bMoved = result.moved.find((m) => m.id === b.id)!;
    // B's 2-day duration preserved, pushed to land exactly on A's due date.
    expect(bMoved).toEqual({ id: b.id, startDate: day(69), dueDate: day(71), cascadedFrom: null });
  });

  it("diamond convergence: the converging task settles at the MAX of both compacted predecessor due dates", async () => {
    const project = await makeProject();
    const p = await createTask(handle.db, actorId, { title: "P", projectId: project.id, startDate: day(60), dueDate: day(62) });
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(69), dueDate: day(71) });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id, startDate: day(63), dueDate: day(64) });
    const d = await createTask(handle.db, actorId, { title: "D", projectId: project.id, startDate: day(79), dueDate: day(81) });
    await addDependency(handle.db, actorId, p.id, a.id);
    await addDependency(handle.db, actorId, p.id, b.id);
    await addDependency(handle.db, actorId, a.id, d.id);
    await addDependency(handle.db, actorId, b.id, d.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // A: pulled to P's due (day 62), 2-day duration -> 62..64.
    // B: pulled to P's due (day 62), 1-day duration -> 62..63.
    // D via A needs start >= 64; via B needs start >= 63 -- MAX wins.
    const dMoved = result.moved.find((m) => m.id === d.id)!;
    expect(dMoved).toEqual({ id: d.id, startDate: day(64), dueDate: day(66), cascadedFrom: null });
  });

  it("an undated task never moves itself, and its successor -- having no DATED predecessor -- pulls to the floor (Fix 1)", async () => {
    // CHANGED by Fix 1 (hotfix v0.4.2): C's only predecessor is the undated
    // B, so C has no DATED predecessor to settle against -- exactly the same
    // "nothing to settle against" category a truly pred-less task falls
    // into (see this function's own doc comment, which has always grouped
    // "no predecessors at all" and "every predecessor undated" together).
    // Under the OLD semantics that meant C stayed anchored forever; under
    // the NEW semantics it now pulls LEFT to the floor like any other
    // no-dated-predecessor task. Floor here = the earliest dated task in the
    // project pre-compaction (no project startDate, nothing done/
    // in_progress) = A's own start.
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id }); // no dates
    const c = await createTask(handle.db, actorId, { title: "C", projectId: project.id, startDate: day(79), dueDate: day(81) });
    await addDependency(handle.db, actorId, a.id, b.id);
    await addDependency(handle.db, actorId, b.id, c.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved.some((m) => m.id === b.id)).toBe(false);
    // C's 2-day duration preserved, pulled to A's floor-defining start.
    const cMoved = result.moved.find((m) => m.id === c.id)!;
    expect(cMoved).toEqual({ id: c.id, startDate: day(60), dueDate: day(62), cascadedFrom: null });
  });

  it("a task with BOTH a dated and an undated predecessor settles against the dated one only", async () => {
    // Exercises the mixed branch of predDueDates's null-filter -- every
    // other test here has either all-dated or all-undated predecessors, so
    // this is the only one where SOME (not zero, not all) entries get
    // filtered out of the same array.
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    const u = await createTask(handle.db, actorId, { title: "U", projectId: project.id }); // no dates
    const t = await createTask(handle.db, actorId, { title: "T", projectId: project.id, startDate: day(69), dueDate: day(71) });
    await addDependency(handle.db, actorId, a.id, t.id);
    await addDependency(handle.db, actorId, u.id, t.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // U contributes nothing -- T settles at A's due date alone, 2-day
    // duration preserved.
    const tMoved = result.moved.find((m) => m.id === t.id)!;
    expect(tMoved).toEqual({ id: t.id, startDate: day(64), dueDate: day(66), cascadedFrom: null });
  });

  it("an empty project, and a project with no dependencies at all, are both a clean no-op", async () => {
    const empty = await makeProject({ name: "Empty" });
    expect((await compactSchedule(handle.db, actorId, empty.id)).moved).toEqual([]);

    const lonely = await makeProject({ name: "Lonely" });
    // Self-floor-defining, same as the "sole no-predecessor task" test above
    // -- permanently clamp-immune, so a fixed past-relative date is fine
    // here too.
    await createTask(handle.db, actorId, { title: "Solo", projectId: lonely.id, startDate: "2026-03-01", dueDate: "2026-03-02" });
    expect((await compactSchedule(handle.db, actorId, lonely.id)).moved).toEqual([]);
  });

  it("every moved task's `shifted` event carries the compacted marker and a null cascadedFrom", async () => {
    const project = await makeProject();
    const a = await createTask(handle.db, actorId, { title: "A", projectId: project.id, startDate: day(60), dueDate: day(64) });
    const b = await createTask(handle.db, actorId, { title: "B", projectId: project.id, startDate: day(69), dueDate: day(73) });
    await addDependency(handle.db, actorId, a.id, b.id);

    await compactSchedule(handle.db, actorId, project.id);

    const bEvents = await handle.db.select().from(events).where(and(eq(events.taskId, b.id), eq(events.verb, "shifted")));
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]?.payload).toEqual({
      from: { start: day(69), due: day(73) },
      to: { start: day(64), due: day(68) },
      cascadedFrom: null,
      compacted: true,
    });
    // A never moved -- no event at all for it.
    const aEvents = await handle.db.select().from(events).where(and(eq(events.taskId, a.id), eq(events.verb, "shifted")));
    expect(aEvents).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown project id", async () => {
    await expect(compactSchedule(handle.db, actorId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to compact an archived project", async () => {
    const project = await makeProject();
    await archiveProject(handle.db, actorId, project.id);
    await expect(compactSchedule(handle.db, actorId, project.id)).rejects.toBeInstanceOf(ArchivedError);
  });
});

describe("compactSchedule: Fix 1 (hotfix v0.4.2) -- no-predecessor tasks pull to a floor", () => {
  it("the user's regression scenario: a no-pred todo pulls to the earliest done/in_progress start, and its dependents follow", async () => {
    // Design is real, finished work; Build is real, in-progress work; both
    // are non-movable and therefore both real floor candidates -- Design's
    // start is earlier than Build's, so Design defines the floor. Content
    // has NO predecessors at all and sits weeks later, with nothing
    // constraining it -- under the OLD semantics it would stay exactly there
    // forever ("anchored"); under Fix 1 it pulls LEFT to the floor, keeping
    // its own 2-day duration. Design's floor and Build's due date are both
    // deliberately placed in the PAST relative to today (Fix 2, hotfix
    // v0.4.3): Content's pull target is therefore today, not Design's stale
    // start -- see this describe block's own name and scheduling.ts's TODAY
    // CLAMP comment. QA then settles at the max of Build's (untouched, still
    // in the FUTURE) due date and Content's NEW (today-clamped) due date --
    // Build wins -- and Launch simply follows QA. All dates are relative to
    // "today" (not hardcoded) so this test's outcome doesn't depend on which
    // day it happens to run.
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "Regression" });
    const design = await createTask(handle.db, actorId, {
      title: "Design", projectId: project.id, startDate: day(-9), dueDate: day(-5),
    });
    await setTaskStatus(handle.db, actorId, design.id, "done");
    const build = await createTask(handle.db, actorId, {
      title: "Build", projectId: project.id, startDate: day(-2), dueDate: day(3),
    });
    await setTaskStatus(handle.db, actorId, build.id, "in_progress");
    const content = await createTask(handle.db, actorId, {
      title: "Content", projectId: project.id, startDate: day(24), dueDate: day(26),
    });
    const qa = await createTask(handle.db, actorId, {
      title: "QA", projectId: project.id, startDate: day(32), dueDate: day(34),
    });
    const launch = await createTask(handle.db, actorId, {
      title: "Launch", projectId: project.id, startDate: day(43), dueDate: day(45),
    });
    await addDependency(handle.db, actorId, build.id, qa.id);
    await addDependency(handle.db, actorId, content.id, qa.id);
    await addDependency(handle.db, actorId, qa.id, launch.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // Design/Build never move -- done/in_progress, as always.
    expect(result.moved.some((m) => m.id === design.id)).toBe(false);
    expect(result.moved.some((m) => m.id === build.id)).toBe(false);

    // Content: floor = Design's start (earliest dated non-movable start),
    // but Design's start is in the past, so Fix 2 clamps the target to
    // TODAY instead -- 2-day duration preserved.
    const contentMoved = result.moved.find((m) => m.id === content.id)!;
    expect(contentMoved.startDate).toBe(todayIso);
    expect(contentMoved.dueDate).toBe(day(2));
    expect(contentMoved.cascadedFrom).toBeNull();

    // QA = max(Build's due, Content's NEW clamped due, today). Build's due
    // is still in the future and is later than both Content's clamped due
    // and today, so it wins -- 2-day duration preserved.
    const qaMoved = result.moved.find((m) => m.id === qa.id)!;
    expect(qaMoved.startDate).toBe(build.dueDate);
    expect(qaMoved.dueDate).toBe(day(5));
    expect(qaMoved.cascadedFrom).toBeNull();

    // Launch: settles directly against QA's new due date, 2-day duration.
    const launchMoved = result.moved.find((m) => m.id === launch.id)!;
    expect(launchMoved.startDate).toBe(qaMoved.dueDate);
    expect(launchMoved.dueDate).toBe(day(7));
    expect(launchMoved.cascadedFrom).toBeNull();
  });

  it("a project with an explicit startDate uses it as the floor, ahead of any task's own dates", async () => {
    // Floor and task both kept comfortably in the future (relative to
    // today) so this test exercises the floor-priority rule itself, not
    // Fix 2's today-clamp -- that's covered separately below.
    const day = (n: number) => addDays(todayDateOnly(), n);
    const project = await makeProject({ name: "Explicit", startDate: day(60) });
    const a = await createTask(handle.db, actorId, {
      title: "A", projectId: project.id, startDate: day(69), dueDate: day(71),
    });

    const result = await compactSchedule(handle.db, actorId, project.id);

    const aMoved = result.moved.find((m) => m.id === a.id)!;
    expect(aMoved).toEqual({ id: a.id, startDate: day(60), dueDate: day(62), cascadedFrom: null });
  });

  it("a no-predecessor task already starting before the floor is left alone -- pull-only, never pushed right", async () => {
    // The floor is a compaction TARGET, not a constraint: a task that
    // already starts earlier than the floor has nothing to pull TOWARD (it's
    // already left of it), and this function never pushes a no-violation
    // task right just to reach a target. Both dates are fixed and in the
    // past (relative to 2026-08-19) on purpose: this is the one case Fix 2's
    // today-clamp does NOT reach (see scheduling.ts's TODAY CLAMP comment --
    // a task the pull-only rule leaves alone was never being pulled
    // anywhere, so there's nothing to clamp), and stays permanently valid
    // however far "today" advances from here.
    const project = await makeProject({ name: "AlreadyEarly", startDate: "2026-06-01" });
    const a = await createTask(handle.db, actorId, {
      title: "A", projectId: project.id, startDate: "2026-01-01", dueDate: "2026-01-03",
    });

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved).toEqual([]);
    const after = await getTask(handle.db, a.id);
    expect(after?.startDate).toBe("2026-01-01");
    expect(after?.dueDate).toBe("2026-01-03");
  });

  it("an all-todo project (nothing done/in_progress, no project startDate) uses its own earliest dated task as the floor", async () => {
    const day = (n: number) => addDays(todayDateOnly(), n);
    const project = await makeProject({ name: "AllTodo" });
    // Earliest -- no predecessors either, so it's the floor definer and
    // therefore doesn't move itself.
    const earliest = await createTask(handle.db, actorId, {
      title: "Earliest", projectId: project.id, startDate: day(60), dueDate: day(61),
    });
    // A second, unrelated no-pred todo sitting later in the same project --
    // pulls LEFT to the same floor the earliest task itself defines.
    const later = await createTask(handle.db, actorId, {
      title: "Later", projectId: project.id, startDate: day(150), dueDate: day(153),
    });

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved.some((m) => m.id === earliest.id)).toBe(false);
    const laterMoved = result.moved.find((m) => m.id === later.id)!;
    // 3-day duration preserved, pulled to the earliest task's floor.
    expect(laterMoved).toEqual({ id: later.id, startDate: day(60), dueDate: day(63), cascadedFrom: null });
  });
});

describe("compactSchedule: Fix 2 (hotfix v0.4.3) -- never schedules a movable task's start before today", () => {
  it("a floor sitting in the past clamps the pull target to today, not the stale floor date", async () => {
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    // An explicit project startDate a month in the past -- the OLD floor
    // rule would pull straight to it; Fix 2 clamps the target up to today
    // instead.
    const project = await makeProject({ name: "PastFloor", startDate: day(-30) });
    const a = await createTask(handle.db, actorId, {
      title: "A", projectId: project.id, startDate: day(20), dueDate: day(23),
    });

    const result = await compactSchedule(handle.db, actorId, project.id);

    const aMoved = result.moved.find((m) => m.id === a.id)!;
    expect(aMoved.startDate).toBe(todayIso);
    expect(aMoved.dueDate).toBe(day(3)); // 3-day duration preserved
    expect(aMoved.cascadedFrom).toBeNull();
  });

  it("a dependent whose predecessor's due date is last week clamps to today, not that stale due date", async () => {
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "PastPredecessor" });
    const predecessor = await createTask(handle.db, actorId, {
      title: "Predecessor", projectId: project.id, startDate: day(-14), dueDate: day(-7),
    });
    await setTaskStatus(handle.db, actorId, predecessor.id, "done");
    const dependent = await createTask(handle.db, actorId, {
      title: "Dependent", projectId: project.id, startDate: day(10), dueDate: day(12),
    });
    await addDependency(handle.db, actorId, predecessor.id, dependent.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    expect(result.moved.some((m) => m.id === predecessor.id)).toBe(false); // done, frozen as ever
    const dependentMoved = result.moved.find((m) => m.id === dependent.id)!;
    expect(dependentMoved.startDate).toBe(todayIso);
    expect(dependentMoved.dueDate).toBe(day(2)); // 2-day duration preserved
    expect(dependentMoved.cascadedFrom).toBeNull();
  });

  it("a predecessor's constraint due AFTER today is unaffected by the clamp", async () => {
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "FutureConstraint" });
    const predecessor = await createTask(handle.db, actorId, {
      title: "Predecessor", projectId: project.id, startDate: day(-5), dueDate: day(10),
    });
    await setTaskStatus(handle.db, actorId, predecessor.id, "done");
    const dependent = await createTask(handle.db, actorId, {
      title: "Dependent", projectId: project.id, startDate: day(20), dueDate: day(22),
    });
    await addDependency(handle.db, actorId, predecessor.id, dependent.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    const dependentMoved = result.moved.find((m) => m.id === dependent.id)!;
    // maxDue (day 10) is already after today -- max(maxDue, today) == maxDue,
    // exactly the pre-Fix-2 behaviour.
    expect(dependentMoved.startDate).toBe(predecessor.dueDate);
    expect(dependentMoved.dueDate).toBe(day(12)); // 2-day duration preserved
    expect(dependentMoved.cascadedFrom).toBeNull();
  });
});

describe("compactSchedule: v0.4.4 -- an in_progress task is only frozen once it has actually started", () => {
  it("the user's second regression: in_progress with a FUTURE start pulls back like a todo, and its dependents follow", async () => {
    // Mirrors the live demo project exactly as reported: Design finished
    // last week, Build is flagged in_progress but SCHEDULED weeks out --
    // under the v0.4.3 rule Build's status alone froze it, stranding QA and
    // Launch in the future no matter how much slack sat in between. The
    // v0.4.4 refinement (see scheduling.ts's MOVABLE doc comment) says a
    // future-start in_progress task is being worked on NOW, so its
    // future-dated slot is slack: it pulls (today-clamped) like a todo.
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "SecondRegression" });
    const design = await createTask(handle.db, actorId, {
      title: "Design", projectId: project.id, startDate: day(-9), dueDate: day(-5),
    });
    await setTaskStatus(handle.db, actorId, design.id, "done");
    const build = await createTask(handle.db, actorId, {
      title: "Build", projectId: project.id, startDate: day(15), dueDate: day(20),
    });
    await setTaskStatus(handle.db, actorId, build.id, "in_progress");
    const content = await createTask(handle.db, actorId, {
      title: "Content", projectId: project.id, startDate: day(0), dueDate: day(3),
    });
    const qa = await createTask(handle.db, actorId, {
      title: "QA", projectId: project.id, startDate: day(20), dueDate: day(22),
    });
    const launch = await createTask(handle.db, actorId, {
      title: "Launch", projectId: project.id, startDate: day(22), dueDate: day(22),
    });
    await addDependency(handle.db, actorId, design.id, build.id);
    await addDependency(handle.db, actorId, build.id, qa.id);
    await addDependency(handle.db, actorId, content.id, qa.id);
    await addDependency(handle.db, actorId, qa.id, launch.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // Build: movable now. Its only predecessor (Design) has a due date in
    // the past, so the target clamps to today -- 5-day duration preserved.
    const buildMoved = result.moved.find((m) => m.id === build.id)!;
    expect(buildMoved.startDate).toBe(todayIso);
    expect(buildMoved.dueDate).toBe(day(5));

    // QA settles against max(Build's NEW clamped due day(5), Content's due
    // day(3), today) = day(5) -- the September stranding is gone.
    const qaMoved = result.moved.find((m) => m.id === qa.id)!;
    expect(qaMoved.startDate).toBe(day(5));
    expect(qaMoved.dueDate).toBe(day(7));
    const launchMoved = result.moved.find((m) => m.id === launch.id)!;
    expect(launchMoved.startDate).toBe(day(7));
  });

  it("an in_progress task whose start is today or earlier stays frozen, and still constrains its successors", async () => {
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "StartedStaysPut" });
    const started = await createTask(handle.db, actorId, {
      title: "Started", projectId: project.id, startDate: day(0), dueDate: day(9),
    });
    await setTaskStatus(handle.db, actorId, started.id, "in_progress");
    const dependent = await createTask(handle.db, actorId, {
      title: "Dependent", projectId: project.id, startDate: day(30), dueDate: day(32),
    });
    await addDependency(handle.db, actorId, started.id, dependent.id);

    const result = await compactSchedule(handle.db, actorId, project.id);

    // start == today is the boundary case: started, therefore frozen.
    expect(result.moved.some((m) => m.id === started.id)).toBe(false);
    const after = await getTask(handle.db, started.id);
    expect(after?.startDate).toBe(day(0));
    expect(after?.dueDate).toBe(day(9));
    const dependentMoved = result.moved.find((m) => m.id === dependent.id)!;
    expect(dependentMoved.startDate).toBe(day(9));
    expect(dependentMoved.dueDate).toBe(day(11));
  });

  it("a future-start in_progress task does not anchor the floor -- the earliest dated task does", async () => {
    // No project startDate and no genuinely-started work, so the floor
    // falls through to the earliest dated task overall. Under v0.4.3 the
    // future-start in_progress task counted as a "reality anchor" and set
    // the floor at day(50); now it's just another movable task, so the
    // earliest todo (day 30) defines the floor and everything no-pred pulls
    // toward THAT.
    const todayIso = todayDateOnly();
    const day = (n: number) => addDays(todayIso, n);
    const project = await makeProject({ name: "NoFalseAnchor" });
    const earliest = await createTask(handle.db, actorId, {
      title: "Earliest", projectId: project.id, startDate: day(30), dueDate: day(32),
    });
    const inprog = await createTask(handle.db, actorId, {
      title: "FutureInProgress", projectId: project.id, startDate: day(50), dueDate: day(54),
    });
    await setTaskStatus(handle.db, actorId, inprog.id, "in_progress");
    const late = await createTask(handle.db, actorId, {
      title: "Late", projectId: project.id, startDate: day(70), dueDate: day(72),
    });

    const result = await compactSchedule(handle.db, actorId, project.id);

    // Earliest defines the floor, stays put.
    expect(result.moved.some((m) => m.id === earliest.id)).toBe(false);
    // Both no-pred movables (the future-start in_progress included) pull to
    // the day(30) floor, durations preserved.
    const inprogMoved = result.moved.find((m) => m.id === inprog.id)!;
    expect(inprogMoved.startDate).toBe(day(30));
    expect(inprogMoved.dueDate).toBe(day(34));
    const lateMoved = result.moved.find((m) => m.id === late.id)!;
    expect(lateMoved.startDate).toBe(day(30));
    expect(lateMoved.dueDate).toBe(day(32));
  });
});
