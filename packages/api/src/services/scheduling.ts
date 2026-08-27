import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import type { ShiftTaskInput, ShiftResult, GanttPayload, GanttTask, TaskType, TaskStatus, TaskDependencyType } from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  tasks, taskDependencies, projects, events,
  type TaskRow, type TaskDependencyRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { lockSiblingGroup } from "./pipelines.js";
import { resolveEventCompanyId } from "./tasks.js";
import { publish } from "./sse.js";

// --- date-only arithmetic -------------------------------------------------
//
// Task dates are pure calendar dates (the `date` column mode, YYYY-MM-DD
// strings), with no time-of-day or timezone component -- "the day after
// 2026-03-08" means the same thing everywhere on Earth. This is NOT
// timezone-sensitive date math (no DST, no working-calendar, no
// business-hours concept): every operation below only adds/subtracts whole
// calendar days and reads back whole calendar fields, so it can't drift.
//
// Dates are parsed at UTC NOON, not midnight. Pure epoch-day arithmetic
// would be exactly as correct at midnight (this file never touches
// time-of-day), but noon leaves a wide margin on both sides before crossing
// a UTC calendar-day boundary -- defence in depth against some future
// caller carelessly feeding the underlying Date value to something
// timezone-sensitive (e.g. a local toLocaleDateString()) instead of reading
// its UTC fields back out, the way this file always does.
const MS_PER_DAY = 86_400_000;

function parseDateOnly(s: string): number {
  return Math.floor(Date.parse(`${s}T12:00:00Z`) / MS_PER_DAY);
}
function formatDateOnly(epochDay: number): string {
  const d = new Date(epochDay * MS_PER_DAY);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Exported alongside todayDateOnly (below) so tests can build dates relative
// to "today" the same way this file does, instead of hardcoding calendar
// dates that drift into the past as real time moves on.
export function addDays(s: string, days: number): string {
  return formatDateOnly(parseDateOnly(s) + days);
}
function diffDays(a: string, b: string): number {
  return parseDateOnly(a) - parseDateOnly(b);
}

// Server-authoritative "today", date-only, for compactSchedule's Fix 1 clamp
// (hotfix v0.4.3) -- see that function's doc comment. Deliberately NOT
// per-client: the server has no reliable way to know the timezone of whoever
// clicked "Remove slack", and date-only semantics (no time-of-day) make the
// resulting window harmless either way -- the worst case is a task landing on
// "today" as measured up to roughly +/-2h away from a particular user's own
// local calendar day at the moment of the click, never more, since this reads
// straight off the server's system clock in UTC. Exported so tests can derive
// their expected dates from the same source this function uses, instead of
// hardcoding a date that would only be "today" on the day this was written.
export function todayDateOnly(): string {
  return formatDateOnly(Math.floor(Date.now() / MS_PER_DAY));
}

// --- shared mapping helpers ------------------------------------------------
//
// File-local, mirroring every other service's own toX() convention (see
// projects.ts's toProject, tasks.ts's toTask) rather than importing tasks.ts's
// private (unexported) versions -- only resolveEventCompanyId is exported
// from tasks.ts for reuse, per that file's own comment on it.

function toTask(row: TaskRow) {
  return {
    id: row.id, title: row.title, description: row.description,
    type: row.type as TaskType, status: row.status as TaskStatus,
    assigneeUserId: row.assigneeUserId,
    startDate: row.startDate, dueDate: row.dueDate,
    completedAt: row.completedAt?.toISOString() ?? null,
    progressPct: row.progressPct,
    parentTaskId: row.parentTaskId, position: row.position,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId, projectId: row.projectId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function toTaskDependency(row: TaskDependencyRow) {
  return {
    id: row.id, predecessorId: row.predecessorId, successorId: row.successorId,
    type: row.type as TaskDependencyType, createdAt: row.createdAt.toISOString(),
  };
}

async function mustGetTaskRow(tx: Database, id: string): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
  if (row === undefined) throw new NotFoundError("task", id);
  return row;
}

// --- shiftTask ---------------------------------------------------------

interface MovedEntry {
  id: string;
  // Captured ONCE, at first touch -- the task's dates as they stood before
  // this whole shiftTask call, for the `shifted` event's `from`. Re-touching
  // an already-moved task (diamond convergence) updates toStart/toDue only;
  // fromStart/fromDue and cascadedFrom never change after first touch.
  fromStart: string | null;
  fromDue: string | null;
  toStart: string;
  toDue: string;
  cascadedFrom: string | null;
  // The row as read before any write this call makes -- companyId/projectId/
  // assigneeUserId are unaffected by a date shift, so this snapshot stays
  // valid for resolveEventCompanyId and the assignee SSE-key set even though
  // it's read once, before the final UPDATE batch.
  row: TaskRow;
}

export async function shiftTask(
  db: Database, actorId: string, taskId: string, input: ShiftTaskInput,
): Promise<ShiftResult> {
  const { result, projectId, assigneeIds } = await db.transaction(async (tx) => {
    // Probe-only read to build the lock key -- mirrors moveTaskOnBoard's own
    // probe in tasks.ts. NOT used to decide anything below: existence,
    // archived state, and the dragged task's current dates all come from the
    // authoritative row read immediately below, taken AFTER the lock is
    // held.
    const [probe] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
    if (probe === undefined) throw new NotFoundError("task", taskId);

    // Shares the EXACT lock key tasks.ts's addDependency uses
    // (`deps:${projectId ?? "standalone"}`) -- deliberately the same group,
    // not a parallel `gantt:...` key. addDependency's cycle-rejecting BFS and
    // shiftTask's cascade both read-then-reason-over the same two pieces of
    // state: the project's dependency graph, and every task's current dates.
    // Without a shared lock, a shiftTask cascade computing violations while
    // addDependency concurrently inserts a new edge (or the reverse order)
    // could each act on a view the other is about to invalidate -- the shift
    // could finish without ever seeing an edge that just committed, or
    // addDependency's cycle walk could reason over dates a not-yet-committed
    // shift is mid-way through changing. One lock, one key, shared across
    // both files, serialises the two operations against each other the same
    // way it already serialises concurrent addDependency calls against one
    // another.
    await lockSiblingGroup(tx, `deps:${probe.projectId ?? "standalone"}`);

    const dragged = await mustGetTaskRow(tx, taskId);
    if (dragged.archivedAt !== null) throw new ArchivedError("task", taskId);
    // shiftTaskInputSchema's .refine already enforces this at the HTTP
    // boundary; re-assert here for a direct service caller that bypasses zod
    // entirely (same precedent as tasks.ts's taskDatesPaired re-asserts).
    if (input.startDate > input.dueDate) {
      throw new Error("shiftTask: startDate must be on or before dueDate");
    }

    const moved = new Map<string, MovedEntry>();
    moved.set(taskId, {
      id: taskId,
      fromStart: dragged.startDate, fromDue: dragged.dueDate,
      toStart: input.startDate, toDue: input.dueDate,
      cascadedFrom: null,
      row: dragged,
    });

    // Push-only settle loop. frontier = tasks moved in the previous pass (the
    // dragged task, to start); each pass loads their FS successors and shifts
    // whichever ones are now violated.
    //
    // TERMINATION ARGUMENT: every pass only ever moves a date RIGHT (a
    // successor's new start is its predecessor's due date, strictly later
    // than the successor's start before the shift, since the shift only
    // fires when start < due) -- shifts are monotonically non-decreasing
    // across the whole call, never reversed, and a task revised on a LATER
    // pass (diamond convergence) only ever moves further right, never back.
    // Each task's `to` position lives in a finite state space bounded above
    // by the dragged task's new dates plus the total duration along the
    // longest predecessor chain reaching it -- a fixed number determined by
    // the graph's structure, not by how many passes this loop takes. The
    // dependency graph is finite (a fixed number of rows) and, by
    // addDependency's insert-time cycle rejection under this SAME lock,
    // acyclic. Critically, EVERY revision -- first touch or a later
    // diamond-driven increase -- unconditionally re-enters `nextFrontier`,
    // so any successor whose position just changed is guaranteed to have its
    // own successors re-examined against the new value. Combined with the
    // bounded state space, that means the total number of (task, violation)
    // pairs strictly decreases pass over pass: a pass that finds nothing left
    // to violate adds nothing to the next frontier, and the loop ends. This
    // is airtight for termination, but it is NOT a tight bound on pass
    // count: an adversarial within-pass edge ordering can revise a task
    // upward on one pass and only propagate that revision to its successors
    // on the NEXT pass, one reconciliation pass later than the graph's
    // longest-path length alone would suggest. In practice pass count tracks
    // the longest path length, occasionally +1 under unlucky edge ordering
    // (see the cross-pass re-convergence test below) -- never anywhere near
    // 500. The 500-pass guard is therefore a backstop against a cycle that
    // should be impossible by construction, not a bound estimate this
    // algorithm is expected to approach in real use (see the guard's own
    // comment).
    let frontier = [taskId];
    let pass = 0;
    while (frontier.length > 0) {
      pass++;
      // Defence against a cycle that slipped past addDependency's insert-time
      // walk (a bug there, a manual DB edit, or a future migration that
      // forgets to re-check existing data): a genuinely acyclic graph can
      // never need more passes than it has nodes, and no real project's
      // dependency graph approaches 500. Aborting the whole transaction (a
      // plain throw -- the route maps an unhandled error to a 500) is
      // correct here: this is a true never-happens backstop, not a
      // recoverable domain error with its own ApiError code.
      if (pass > 500) {
        throw new Error("shiftTask: exceeded 500 cascade passes -- a cycle slipped past addDependency's cycle guard");
      }

      const edges = await tx.select({
        predecessorId: taskDependencies.predecessorId,
        successorId: taskDependencies.successorId,
      }).from(taskDependencies).where(inArray(taskDependencies.predecessorId, frontier));
      if (edges.length === 0) break;

      const successorIds = [...new Set(edges.map((e) => e.successorId))];
      const successorRows = await tx.select().from(tasks).where(inArray(tasks.id, successorIds));
      const successorById = new Map(successorRows.map((r) => [r.id, r]));

      const nextFrontier = new Set<string>();
      for (const edge of edges) {
        const succRow = successorById.get(edge.successorId);
        // Defensive only -- the FK guarantees this row exists.
        if (succRow === undefined) continue;
        // Null-dated successors never shift, and the walk stops through
        // them: with no dates, "violation" is undefined, and their own
        // successors are left exactly as they were (not added to
        // nextFrontier).
        if (succRow.startDate === null || succRow.dueDate === null) continue;

        // The predecessor is always already in `moved`: it is a member of
        // `frontier` for this pass, and every id ever placed in `frontier`
        // was placed in `moved` first (the dragged task seeds both; every
        // other addition below sets `moved` and adds to `nextFrontier` in
        // the same step).
        const predEntry = moved.get(edge.predecessorId);
        if (predEntry === undefined) continue;

        // The successor's CURRENT best position: if an earlier edge in this
        // same pass (or an earlier pass) already shifted it -- diamond
        // convergence -- use that; otherwise its unmodified DB value (no
        // write has happened yet; every UPDATE runs after this loop
        // settles).
        const succEntry = moved.get(edge.successorId);
        const currentStart = succEntry ? succEntry.toStart : succRow.startDate;
        const currentDue = succEntry ? succEntry.toDue : succRow.dueDate;

        // ISO YYYY-MM-DD strings compare lexicographically in calendar
        // order, so a plain string comparison is exact here -- no need to
        // parse for the violation check itself, only for the delta below.
        if (currentStart >= predEntry.toDue) continue; // no violation; slack absorbs

        const delta = diffDays(predEntry.toDue, currentStart);
        const newStart = addDays(currentStart, delta); // == predEntry.toDue
        const newDue = addDays(currentDue, delta); // duration preserved

        if (succEntry) {
          // Re-processed with a larger shift: keep the original from/
          // cascadedFrom, just move the current best further right.
          succEntry.toStart = newStart;
          succEntry.toDue = newDue;
        } else {
          moved.set(edge.successorId, {
            id: edge.successorId,
            fromStart: succRow.startDate, fromDue: succRow.dueDate,
            toStart: newStart, toDue: newDue,
            // The DRAGGED task's id, not the immediate predecessor -- every
            // cascaded task's event traces back to the one drag gesture that
            // caused it, so the UI can flash "moved because you dragged X"
            // consistently regardless of how many hops down the chain this
            // task sits.
            cascadedFrom: taskId,
            row: succRow,
          });
        }
        nextFrontier.add(edge.successorId);
      }
      frontier = [...nextFrontier];
    }

    const movedList = [...moved.values()]; // Map insertion order: dragged task first.
    for (const entry of movedList) {
      await tx.update(tasks)
        .set({ startDate: entry.toStart, dueDate: entry.toDue, updatedAt: new Date() })
        .where(eq(tasks.id, entry.id));

      const eventCompanyId = await resolveEventCompanyId(tx, entry.row);
      await tx.insert(events).values({
        verb: "shifted", actorUserId: actorId, taskId: entry.id, projectId: entry.row.projectId,
        companyId: eventCompanyId,
        payload: {
          from: { start: entry.fromStart, due: entry.fromDue },
          to: { start: entry.toStart, due: entry.toDue },
          cascadedFrom: entry.cascadedFrom,
        },
      });
    }

    const assignees = new Set<string>();
    for (const entry of movedList) if (entry.row.assigneeUserId !== null) assignees.add(entry.row.assigneeUserId);

    return {
      result: {
        moved: movedList.map((e) => ({ id: e.id, startDate: e.toStart, dueDate: e.toDue, cascadedFrom: e.cascadedFrom })),
      } satisfies ShiftResult,
      projectId: dragged.projectId,
      assigneeIds: [...assignees],
    };
  });

  publish({
    keys: [
      ["tasks", projectId ?? "standalone"], ["gantt"], ["events"],
      // One ["task", id] per moved task (the dragged task plus every
      // cascaded successor) -- mirrors publishTaskHint's own ["task", id]
      // entry in tasks.ts, so a task drawer open on any task this cascade
      // touches (not just the one actually dragged) picks up its new dates
      // live instead of only refreshing on next visit. Bounded by the
      // cascade's own size (a real dependency graph is tiny, same bound
      // addDependency's cycle BFS already assumes), and the SSE client
      // coalesces a burst of keys from one publish into one refetch each.
      ...result.moved.map((m) => ["task", m.id]),
      ...assigneeIds.map((a) => ["my-tasks", a]),
    ],
  });
  return result;
}

// --- compactSchedule ("Remove slack") -------------------------------------
//
// Phase 3.1: shiftTask's sibling. Where shiftTask reacts to ONE task moving
// (pushing violated successors right, just enough), compactSchedule sweeps
// an entire project at once and pins every movable task to EXACTLY the max
// of its predecessors' due dates -- pulling slack out AND fixing violations
// in the same pass, since both are the same operation from this function's
// point of view (the task's new start is never a function of its OLD start
// at all, only of its predecessors' current due dates).
//
// MOVABLE means: dated (both startDate and dueDate set), and its status is
// "todo" or "blocked" -- or (refinement, hotfix v0.4.4) "in_progress" with a
// startDate still in the FUTURE (start > todayIso, the same server-side
// "today" the TODAY CLAMP below uses). Everything else keeps its own dates
// untouched, but (if dated) still contributes its due date to whichever
// successors settle against it:
//   * status "done", or "in_progress" with start <= today -- deliberately
//     frozen (work already started/finished doesn't get silently
//     rescheduled), but still a real constraint for anything downstream of
//     it. This holds even when such a task is ITSELF currently violating its
//     own predecessors' due dates -- compactSchedule never fixes a protected
//     task's own violation, only movable ones; a frozen task that started
//     early (or whose predecessor moved later after the fact) stays exactly
//     where it is, constraint or no constraint. The v0.4.4 refinement exists
//     because the anchoring rationale -- "don't rewrite history" -- only
//     holds for work that has actually begun on the calendar: an
//     "in_progress" task whose scheduled start is still weeks away is being
//     worked on NOW, so its future-dated slot is exactly the slack this
//     function exists to remove; it gets pulled (and today-clamped) like a
//     todo. An in_progress task with dates but start <= today, or with no
//     dates at all, stays frozen as before.
//   * Undated -- exactly shiftTask's own null-stopper (see its cascade loop
//     comment): an undated task can't be moved (no dates to move) and can't
//     usefully constrain a successor either (there is nothing to compare
//     against), so it's transparent -- a successor whose ONLY predecessor is
//     undated has no dated predecessor at all, and is handled by the FLOOR
//     rule below, same as a successor with no predecessor edge at all.
//
// FLOOR RULE (Fix 1, hotfix v0.4.2) -- a movable task with NO dated
// predecessor (no predecessor edges at all, or every predecessor is
// undated: the same "nothing to settle against" category above) no longer
// stays anchored forever. It PULLS LEFT to a floor, computed ONCE, from
// pre-compaction data, before any task in this sweep moves -- so every
// no-dated-predecessor task in the project pulls toward the exact same
// reference point regardless of processing order. In priority order:
//   1. The project's own startDate, if set -- the plan's explicit
//      beginning always wins.
//   2. Otherwise, the earliest startDate among the project's dated
//      non-movable tasks (done, or in_progress with start <= today -- the
//      same frozen set the MOVABLE definition above carves out) --
//      "reality" anchors: work that has actually started or finished is
//      the truest baseline a plan has, so a still-open task with nothing
//      constraining it settles against where real work began. A
//      future-start in_progress task is movable (v0.4.4) and so
//      deliberately does NOT anchor the floor -- its future slot is slack,
//      not reality.
//   3. Otherwise (a project of pure todo/blocked, nothing has started yet),
//      the earliest startDate among ALL the project's dated tasks,
//      pre-compaction -- a plan with no external anchor at all keeps its
//      own earliest start as its baseline, so compacting doesn't drift the
//      whole plan's start date around depending on which task happens to
//      have no predecessors.
// This is PULL-ONLY: a no-dated-predecessor task that already starts before
// the floor is left exactly where it is -- the floor is a compaction
// TARGET, not a constraint, and this function never pushes a task right
// just to reach one. done/in_progress tasks are, as ever, never subject to
// any of this -- frozen is frozen, floor or no floor.
//
// TODAY CLAMP (Fix 2, hotfix v0.4.3) -- neither the floor above nor a
// predecessor's due date is allowed to pull (or leave) a movable task's
// START before today, `todayDateOnly()` (see that function's own comment on
// why "today" is measured server-side, date-only). Concretely: wherever this
// function would otherwise settle a movable task's start at some
// `constraintOrFloorStart` (a predecessor's max due date, or the floor),
// the actual target is `max(constraintOrFloorStart, todayIso)` instead --
// string comparison is exact here since both sides are YYYY-MM-DD. This
// applies uniformly to both settling paths below: the predecessor-due path
// (even when the predecessor's due date is itself in the past -- e.g. a
// done task that finished last month) and the no-dated-predecessor floor
// path (even when the floor itself, project startDate or otherwise, is in
// the past). It does NOT apply to a no-dated-predecessor task that already
// starts before the (possibly today-clamped) floor and is therefore left
// alone by the pull-only rule above -- that task isn't being pulled
// anywhere by this sweep, so there is nothing for the clamp to clamp; its
// past start is whatever a prior manual drag put there, and manual drags
// into the past remain allowed (only compactSchedule itself refuses to
// produce one).
//
// Subtlety worth confirming explicitly: a task clamped to today still
// constrains its OWN successors by its clamped (not its original,
// pre-clamp) due date -- this falls out for free from the existing
// topological-pass design with no extra plumbing, because `settledDue` is
// set to the task's FINAL post-clamp due date the same way it's always set
// to a task's final post-settle due date, and every successor reads its
// predecessors' due dates back out of `settledDue`, never off the original
// `taskById` rows. A successor processed after a today-clamped predecessor
// therefore sees exactly the clamped value, with no special-casing needed.
export async function compactSchedule(db: Database, actorId: string, projectId: string): Promise<ShiftResult> {
  const { result, assigneeIds } = await db.transaction(async (tx) => {
    // Same lock, same key shiftTask/addDependency already use for this
    // project's dependency graph (`deps:${projectId}`) -- see shiftTask's own
    // doc comment on this lock for the full shared-contract reasoning. This
    // function reads-then-reasons over exactly the same two pieces of state
    // (the project's dependency edges, and every task's current dates) that
    // shiftTask's cascade and addDependency's cycle BFS do, so it needs to be
    // serialised against both the same way they're serialised against each
    // other: a shiftTask cascade or an addDependency insert landing mid-sweep
    // could otherwise see (or produce) a graph/dates snapshot this function's
    // single topological pass never re-validates once it starts.
    await lockSiblingGroup(tx, `deps:${projectId}`);

    const [project] = await tx.select({ archivedAt: projects.archivedAt, startDate: projects.startDate })
      .from(projects).where(eq(projects.id, projectId));
    if (project === undefined) throw new NotFoundError("project", projectId);
    if (project.archivedAt !== null) throw new ArchivedError("project", projectId);

    const projectTasks = await tx.select().from(tasks).where(eq(tasks.projectId, projectId));
    const taskIds = projectTasks.map((t) => t.id);
    const taskById = new Map(projectTasks.map((t) => [t.id, t] as const));

    // Fix 2 (hotfix v0.4.3) -- server-authoritative "today", computed once,
    // before the topological loop moves anything, exactly like `floor`
    // below (which now also reads it, so it comes first). See this
    // function's TODAY CLAMP doc comment for the full rationale; see
    // todayDateOnly() itself for why "today" is measured this way.
    const todayIso = todayDateOnly();

    // The v0.4.4 movable/frozen split, shared by the floor's "reality
    // anchor" filter below and the per-task movable check in the loop --
    // see the MOVABLE section of this function's doc comment.
    const isFrozen = (t: typeof projectTasks[number]): boolean =>
      t.status === "done" || (t.status === "in_progress" && (t.startDate === null || t.startDate <= todayIso));

    // Fix 1's floor -- see this function's doc comment for the full
    // priority-order rationale. Computed here, ONCE, from projectTasks as
    // read above (pre-compaction, before the topological loop below moves
    // anything).
    let floor: string | null = project.startDate;
    if (floor === null) {
      const datedNonMovable = projectTasks.filter((t) =>
        t.startDate !== null && t.dueDate !== null && isFrozen(t));
      const datedAny = projectTasks.filter((t) => t.startDate !== null && t.dueDate !== null);
      for (const t of (datedNonMovable.length > 0 ? datedNonMovable : datedAny)) {
        if (floor === null || t.startDate! < floor) floor = t.startDate!;
      }
    }

    // Every edge with a predecessor in this project's task set. addDependency
    // only ever links two tasks in the SAME project (or both standalone), so
    // an edge whose predecessor is one of this project's tasks is guaranteed
    // to have its successor here too -- no separate successorId-in-taskIds
    // check needed.
    const edges = taskIds.length === 0 ? [] : await tx.select({
      predecessorId: taskDependencies.predecessorId,
      successorId: taskDependencies.successorId,
    }).from(taskDependencies).where(inArray(taskDependencies.predecessorId, taskIds));

    const predecessorsOf = new Map<string, string[]>();
    const successorsOf = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const id of taskIds) {
      predecessorsOf.set(id, []);
      successorsOf.set(id, []);
      inDegree.set(id, 0);
    }
    for (const edge of edges) {
      predecessorsOf.get(edge.successorId)?.push(edge.predecessorId);
      successorsOf.get(edge.predecessorId)?.push(edge.successorId);
      inDegree.set(edge.successorId, (inDegree.get(edge.successorId) ?? 0) + 1);
    }

    // Kahn's algorithm: a task is only READY (pushed onto the queue) once
    // every one of its predecessors has already been settled, so by the time
    // this loop processes a task, `settledDue` already holds each of its
    // predecessors' FINAL (possibly-just-compacted) due date -- never a stale
    // pre-compaction value. That is exactly what makes ONE pass sufficient
    // here, unlike shiftTask's repeated-settle cascade: shiftTask reacts to a
    // single external change and has to re-examine a task every time ANY of
    // its predecessors moves again (a diamond can revise the same successor
    // upward more than once, see its cross-pass re-convergence test), but
    // compactSchedule computes each task's position ONCE, as a pure function
    // of its predecessors' final values -- and topological order guarantees
    // those are already final by the time this task is reached. A cycle
    // would break that guarantee (no node in a cycle is ever "ready"), but
    // addDependency's insert-time BFS rejects cycles under this same lock, so
    // the graph reaching this point is acyclic by construction -- the
    // `processed !== taskIds.length` check below is a defensive backstop for
    // that invariant, not a case expected to ever fire.
    let head = 0;
    const queue: string[] = taskIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
    // Only the DUE date is ever read back out (by a successor computing its
    // own max) -- a settled task's start never feeds anything downstream, so
    // there's no parallel settledStart map to maintain.
    const settledDue = new Map<string, string | null>();
    for (const id of taskIds) settledDue.set(id, taskById.get(id)!.dueDate);

    const moved = new Map<string, MovedEntry>();
    let processed = 0;
    while (head < queue.length) {
      const id = queue[head]!;
      head++;
      processed++;
      const row = taskById.get(id)!;

      const movable = row.startDate !== null && row.dueDate !== null && !isFrozen(row);
      if (movable) {
        // Undated predecessors contribute nothing (see this function's doc
        // comment) -- filtered out here, not treated as an always-satisfied
        // (or always-violating) bound.
        const predDueDates = (predecessorsOf.get(id) ?? [])
          .map((p) => settledDue.get(p) ?? null)
          .filter((d): d is string => d !== null);
        if (predDueDates.length > 0) {
          const maxDue = predDueDates.reduce((a, b) => (a > b ? a : b));
          // Fix 2 (hotfix v0.4.3): the target is never earlier than today,
          // even when the predecessor's max due date itself is in the past
          // (e.g. a done/in_progress predecessor that finished before
          // today) -- see the TODAY CLAMP doc comment above. String compare
          // is exact for YYYY-MM-DD.
          const target = maxDue < todayIso ? todayIso : maxDue;
          if (target !== row.startDate) {
            const duration = diffDays(row.dueDate!, row.startDate!);
            const newStart = target;
            const newDue = addDays(newStart, duration);
            settledDue.set(id, newDue);
            moved.set(id, {
              id, fromStart: row.startDate, fromDue: row.dueDate,
              toStart: newStart, toDue: newDue, cascadedFrom: null, row,
            });
          }
        } else if (floor !== null) {
          // Fix 1: no DATED predecessor to settle against -- pull to the
          // floor instead of staying anchored. Fix 2 (hotfix v0.4.3): the
          // floor itself is first clamped up to today (never down), so a
          // floor sitting in the past -- an old project startDate, or the
          // earliest dated task's start -- pulls a task no further left
          // than today. Pull-only (see this function's doc comment): the
          // move still only fires when this (possibly today-clamped) floor
          // is strictly EARLIER than the task's current start; a task
          // already sitting before it -- floor, today-clamped or not -- is
          // left alone, never pushed right to reach it. That "already
          // early" case is exactly the one the clamp does NOT reach: this
          // sweep isn't pulling that task anywhere, so there is nothing to
          // clamp (see the doc comment above).
          const effectiveFloor = floor < todayIso ? todayIso : floor;
          if (effectiveFloor < row.startDate!) {
            const duration = diffDays(row.dueDate!, row.startDate!);
            const newStart = effectiveFloor;
            const newDue = addDays(newStart, duration);
            settledDue.set(id, newDue);
            moved.set(id, {
              id, fromStart: row.startDate, fromDue: row.dueDate,
              toStart: newStart, toDue: newDue, cascadedFrom: null, row,
            });
          }
        }
      }

      for (const succ of successorsOf.get(id) ?? []) {
        const next = (inDegree.get(succ) ?? 0) - 1;
        inDegree.set(succ, next);
        if (next === 0) queue.push(succ);
      }
    }
    if (processed !== taskIds.length) {
      throw new Error("compactSchedule: dependency graph contains a cycle that slipped past addDependency's cycle guard");
    }

    const movedList = [...moved.values()];
    for (const entry of movedList) {
      await tx.update(tasks)
        .set({ startDate: entry.toStart, dueDate: entry.toDue, updatedAt: new Date() })
        .where(eq(tasks.id, entry.id));

      const eventCompanyId = await resolveEventCompanyId(tx, entry.row);
      await tx.insert(events).values({
        verb: "shifted", actorUserId: actorId, taskId: entry.id, projectId: entry.row.projectId,
        companyId: eventCompanyId,
        payload: {
          from: { start: entry.fromStart, due: entry.fromDue },
          to: { start: entry.toStart, due: entry.toDue },
          cascadedFrom: null,
          // Distinguishes a compaction-driven move from an interactive drag's
          // own `shifted` event on the timeline (see the doc comment on this
          // function, and timeline-lib.ts's summarize()) -- cascadedFrom alone
          // can't do that here since it's always null for compactSchedule.
          compacted: true,
        },
      });
    }

    const assignees = new Set<string>();
    for (const entry of movedList) if (entry.row.assigneeUserId !== null) assignees.add(entry.row.assigneeUserId);

    return {
      result: {
        moved: movedList.map((e) => ({ id: e.id, startDate: e.toStart, dueDate: e.toDue, cascadedFrom: null })),
      } satisfies ShiftResult,
      assigneeIds: [...assignees],
    };
  });

  // Same SSE key shape as shiftTask's own publish (see its comment) -- a
  // project-wide compaction is just a bigger version of the same "some
  // tasks' dates changed" event from every consumer's point of view.
  publish({
    keys: [
      ["tasks", projectId], ["gantt"], ["events"],
      ...result.moved.map((m) => ["task", m.id]),
      ...assigneeIds.map((a) => ["my-tasks", a]),
    ],
  });
  return result;
}

// --- ganttPayload --------------------------------------------------------

export type GanttPayloadOptions = { projectId: string } | { global: true };

// Self-join alias: fetching a child row's own PARENT row alongside it lets
// the ORDER BY below group each parent with its own children (root
// immediately followed by its children, in position order) without a
// recursive query -- Phase 3 supports exactly one level of subtask nesting,
// so a single self-join covers every case.
const parentTasks = alias(tasks, "parent_tasks");

export async function ganttPayload(db: Database, opts: GanttPayloadOptions): Promise<GanttPayload> {
  const where = [isNull(tasks.archivedAt), isNotNull(tasks.startDate), isNotNull(tasks.dueDate)];
  if ("projectId" in opts) where.push(eq(tasks.projectId, opts.projectId));

  const rows = await db.select({
    task: tasks,
    projectName: projects.name,
    projectColor: projects.color,
  }).from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(parentTasks, eq(tasks.parentTaskId, parentTasks.id))
    .where(and(...where))
    .orderBy(
      // Standalone tasks (projectId NULL) sort last within the returned set,
      // Postgres's default NULLS LAST on an ascending sort -- same convention
      // as projects.ts/tasks.ts's own orderings.
      tasks.projectId,
      // Root-first within each (project, parent-group): a child's group key
      // is its PARENT's position (via the self-join); a root task's group
      // key is its own position. Same-group rows (a root and its children)
      // land contiguous, ordered by that shared key.
      //
      // The self-join is unfiltered by the WHERE above (no dated/archived
      // check on parentTasks), so a dated, unarchived child whose parent is
      // itself excluded from this payload (undated, or archived) still finds
      // its row via the join and sorts by that invisible parent's position.
      // This is intentional graceful degradation, not a bug: the child has
      // nowhere better to sort (its own group has no visible root to anchor
      // on), and reusing the excluded parent's position at least keeps it
      // near where its sibling group would have rendered, instead of the
      // COALESCE falling through to the child's own position and scattering
      // it away from any siblings it does have.
      sql`COALESCE(${parentTasks.position}, ${tasks.position})`,
      // Within a group, the root itself (parentTaskId IS NULL, false/0)
      // sorts before its children (true/1) at the same group key.
      sql`(${tasks.parentTaskId} IS NOT NULL)`,
      // Children of the same parent, ordered among themselves.
      tasks.position,
    );

  const ganttTasks: GanttTask[] = rows.map((r) => ({
    ...toTask(r.task),
    projectName: r.projectName ?? null,
    projectColor: r.projectColor ?? null,
  }));

  const taskIds = ganttTasks.map((t) => t.id);
  // Dependencies where BOTH ends are in the returned set: an edge to a task
  // excluded from this payload (undated, archived, or in a different
  // project than requested) is dropped -- the chart has nowhere to draw an
  // arrow whose one end has no bar.
  const dependencyRows = taskIds.length === 0 ? [] : await db.select().from(taskDependencies)
    .where(and(inArray(taskDependencies.predecessorId, taskIds), inArray(taskDependencies.successorId, taskIds)));

  return {
    tasks: ganttTasks,
    dependencies: dependencyRows.map(toTaskDependency),
  };
}
