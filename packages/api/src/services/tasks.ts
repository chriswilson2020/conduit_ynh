import { and, desc, eq, gt, inArray, isNull, isNotNull, lt, ne } from "drizzle-orm";
import { midpoint, taskDatesPaired } from "@conduit/shared";
import type {
  Task, TaskType, TaskStatus, CreateTaskInput, UpdateTaskInput, MoveTaskOnBoardInput,
  TaskDependency, TaskDependencyType,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects, tasks, taskDependencies, events,
  type TaskRow, type TaskDependencyRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { lockSiblingGroup } from "./pipelines.js";
import { publish } from "./sse.js";

/**
 * Invalidation keys every task mutator publishes after its transaction
 * commits. extraAssigneeIds lets a reassignment publish BOTH the pre- and
 * post-patch assignee's My Tasks key in one call -- updateTask passes the
 * pre-patch assignee here unconditionally; the Set dedupes the common case
 * where the assignee didn't actually change, so callers never need to check
 * first.
 *
 * ["task", task.id] mirrors publishDealHint's ["deal", id] (services/deals.ts):
 * the task drawer's single-task useTask(id) query (queries.ts) keys off
 * exactly this, and TanStack's prefix-matched invalidateQueries also reaches
 * a deeper ["task", id, "dependencies"] cache (the drawer's predecessor
 * list) for free -- addDependency/removeDependency below both already call
 * this with the successor task, so a dependency edit invalidates the
 * drawer's dependency list the same way a field edit invalidates its fields,
 * with no separate key needed.
 */
function publishTaskHint(task: Task, extraAssigneeIds: (string | null)[] = []): void {
  const keys: string[][] = [
    ["tasks", task.projectId ?? "standalone"], ["task", task.id], ["gantt"], ["events"], ["search"],
  ];
  const assignees = new Set<string>();
  if (task.assigneeUserId !== null) assignees.add(task.assigneeUserId);
  for (const a of extraAssigneeIds) if (a !== null) assignees.add(a);
  for (const a of assignees) keys.push(["my-tasks", a]);
  publish({ keys });
}

// Exported so meetings.ts's detail payload renders the follow-up tasks a
// meeting produced through the SAME row-to-wire mapper every other task
// surface uses -- a second copy would be a second place for a new task field
// to be forgotten.
export function toTask(row: TaskRow): Task {
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

function toTaskDependency(row: TaskDependencyRow): TaskDependency {
  return {
    id: row.id, predecessorId: row.predecessorId, successorId: row.successorId,
    type: row.type as TaskDependencyType, createdAt: row.createdAt.toISOString(),
  };
}

async function mustGetTask(db: Database, id: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (row === undefined) throw new NotFoundError("task", id);
  return row;
}

// Existence-only, mirroring assertCompanyExists in deals.ts/projects.ts --
// deliberately NOT notes.ts's assertNoteTargetActive, which also blocks an
// archived target. Unlike notes/files (attachments whose Phase 1 rule is
// stricter), a task is a first-class work item that legitimately references
// CRM history: a task closing out work on a company that has since been
// archived, or a contact who has left, still belongs on that record's
// timeline. Only the PROJECT a task lives IN gets the stricter check below --
// see assertProjectActive.
async function assertCompanyExists(db: Database, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (row === undefined) throw new NotFoundError("company", companyId);
}
async function assertContactExists(db: Database, contactId: string): Promise<void> {
  const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId));
  if (row === undefined) throw new NotFoundError("contact", contactId);
}
async function assertDealExists(db: Database, dealId: string): Promise<void> {
  const [row] = await db.select({ id: deals.id }).from(deals).where(eq(deals.id, dealId));
  if (row === undefined) throw new NotFoundError("deal", dealId);
}

// Only an archived PROJECT rejects a new (or reparented-into) task -- unlike
// company/contact/deal above, which stay valid targets even archived. A
// project is the container the task lives IN, not history the task merely
// references: an archived project has deliberately stopped accepting new
// work, the same way createDeal refuses a new deal into an archived
// pipeline. A task already sitting in a project that's archived LATER is
// untouched (archiving a project doesn't cascade to its tasks, same
// no-cascade principle as projects.ts's updateProject).
async function assertProjectActive(db: Database, projectId: string): Promise<void> {
  const [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId));
  if (row === undefined) throw new NotFoundError("project", projectId);
  if (row.archivedAt !== null) throw new ArchivedError("project", projectId);
}

// parent_task_id rules: the parent must exist, must live in the same
// project as the task being created/reparented into it (or both standalone
// -- no project at all), and must not itself have a parent -- Phase 3
// supports exactly one level of subtask grouping, not arbitrary nesting.
async function assertParentValid(db: Database, parentTaskId: string, projectId: string | null): Promise<void> {
  const parent = await mustGetTask(db, parentTaskId);
  if (parent.projectId !== projectId) throw new ConflictError("task", parentTaskId);
  if (parent.parentTaskId !== null) throw new ConflictError("task", parentTaskId);
}

// Mirrors deals.ts/notes.ts's dual-stamp convention: a task's OWN company_id
// (when set directly) wins; otherwise fall back to its project's company_id
// so the event still surfaces on that company's timeline even when the task
// itself carries no direct company link. Reused by every event this file
// emits, not just `created` -- an update/status-change/dependency event on a
// project-linked-but-not-company-linked task should surface the same way.
//
// Exported so scheduling.ts's shiftTask can dual-stamp its `shifted` events
// the same way, instead of duplicating this lookup -- shiftTask's moved
// tasks (the dragged one and every cascaded successor) need exactly the same
// direct-or-via-project company resolution as every other mutation in this
// file.
export async function resolveEventCompanyId(tx: Database, row: TaskRow): Promise<string | null> {
  if (row.companyId !== null) return row.companyId;
  if (row.projectId === null) return null;
  const [proj] = await tx.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, row.projectId));
  return proj?.companyId ?? null;
}

// Structural comparison, copied from deals.ts/projects.ts's fieldChanged.
function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

/**
 * Where a task came from, when it came from something other than a plain
 * "new task" (Phase 5: a meeting's follow-up). OPTIONAL at every call site --
 * POST /api/tasks and every test that predates it pass nothing and are
 * untouched -- and deliberately an object rather than a bare `meetingId`
 * string, so a second kind of origin (a mail thread, say) is a field here
 * instead of a fifth positional parameter.
 *
 * It exists because the provenance has to ride createTask's OWN event insert.
 * services/meetings.ts's taskCreatedFromMeeting reads `verb = 'created' AND
 * task_id IS NOT NULL` filtered by events.meeting_id, i.e. the task's own
 * creation row must carry the meeting; and appending a second `created` row
 * after this function returns would satisfy that count while putting TWO
 * creation entries for one task on that task's timeline, in a separate
 * transaction that a crash could leave unwritten. One row, stamped where it
 * is already being written.
 */
export interface TaskOrigin { meetingId: string }

export async function createTask(
  db: Database, actorId: string, input: CreateTaskInput, origin?: TaskOrigin,
): Promise<Task> {
  // createTaskInputSchema's .refine already enforces this at the HTTP
  // boundary; re-assert here for a direct service caller (tests, or a future
  // internal caller) that constructs the input by hand and bypasses zod.
  if (!taskDatesPaired(input)) {
    throw new Error("createTask: startDate and dueDate must both be set (with startDate <= dueDate) or both omitted");
  }

  if (input.companyId != null) await assertCompanyExists(db, input.companyId);
  if (input.contactId != null) await assertContactExists(db, input.contactId);
  if (input.dealId != null) await assertDealExists(db, input.dealId);
  if (input.projectId != null) await assertProjectActive(db, input.projectId);

  const projectId = input.projectId ?? null;
  const parentTaskId = input.parentTaskId ?? null;
  if (parentTaskId !== null) await assertParentValid(db, parentTaskId, projectId);

  const task = await db.transaction(async (tx) => {
    // Sibling group = same parent within the same project, or the
    // standalone pool -- distinct from moveTaskOnBoard's own
    // `tasks:board:...` groups below, so a create-time append never
    // contends with a concurrent board move (they order different things:
    // parent/project grouping here, status column there).
    const groupKey = `tasks:${projectId ?? "standalone"}:${parentTaskId ?? "root"}`;
    await lockSiblingGroup(tx, groupKey);
    const siblingWhere = [
      parentTaskId === null ? isNull(tasks.parentTaskId) : eq(tasks.parentTaskId, parentTaskId),
      projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, projectId),
    ];
    const [lastSibling] = await tx.select({ position: tasks.position }).from(tasks)
      .where(and(...siblingWhere)).orderBy(desc(tasks.position)).limit(1);
    const position = midpoint(lastSibling?.position ?? null, null);

    const [row] = await tx.insert(tasks).values({
      title: input.title,
      description: input.description ?? null,
      type: input.type ?? "task",
      assigneeUserId: input.assigneeUserId ?? null,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      progressPct: input.progressPct ?? null,
      parentTaskId,
      position,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      projectId,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");

    // Carries task_id + project_id, and company_id direct-or-via-project
    // (resolveEventCompanyId), so the event surfaces on the task's own
    // timeline, its project's, and its company's -- mirrors deals.ts's
    // convention, extended with the project fallback.
    const eventCompanyId = await resolveEventCompanyId(tx, row);
    await tx.insert(events).values({
      verb: "created", actorUserId: actorId, taskId: row.id, projectId: row.projectId,
      companyId: eventCompanyId,
      // The COLUMN carries the provenance, not the payload: it is what
      // meetings.ts's criterion reads, what events_meeting_id_idx
      // (drizzle/0008) indexes, and it already reaches the client as
      // Event.meetingId (shared's eventSchema), so a payload copy would be a
      // second spelling of one fact. The payload stays {} because a task's
      // `created` entry renders as bare "created" for every task -- it does
      // not even name the task -- so there is no render data for this row to
      // be missing (web: rail/timeline.tsx's summarize).
      meetingId: origin?.meetingId ?? null,
      payload: {},
    });
    return toTask(row);
  });
  publishTaskHint(task);
  return task;
}

// status/position/completedAt excluded: status changes go through the
// dedicated setTaskStatus (which also owns completedAt's pairing), position
// through moveTaskOnBoard or the reposition-on-reparent logic in updateTask
// below -- a generic field patch has no business deciding either. Mirrors
// deals.ts's PATCHABLE_FIELDS convention.
const PATCHABLE_FIELDS = [
  "title", "description", "type", "assigneeUserId", "startDate", "dueDate",
  "progressPct", "parentTaskId", "companyId", "contactId", "dealId", "projectId",
] as const satisfies readonly (keyof UpdateTaskInput)[];

export async function updateTask(db: Database, actorId: string, id: string, patch: UpdateTaskInput): Promise<Task> {
  const existing = await mustGetTask(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("task", id);

  // Three-state date handling: an absent key leaves that date untouched, an
  // explicit null pair clears both, a value pair sets both. This function
  // only ever sees ONE snapshot of the patch, never the row's persisted
  // counterpart, so a patch touching only one of the pair can never be
  // validated against the other -- updateTaskInputSchema's .refine already
  // rejects this at the HTTP boundary; taskDatesPaired re-asserts it here for
  // a direct service caller that bypasses zod entirely.
  if (!taskDatesPaired(patch)) {
    throw new Error("updateTask: startDate and dueDate must both be provided together (with startDate <= dueDate), or neither");
  }

  if (patch.companyId != null) await assertCompanyExists(db, patch.companyId);
  if (patch.contactId != null) await assertContactExists(db, patch.contactId);
  if (patch.dealId != null) await assertDealExists(db, patch.dealId);
  if (patch.projectId != null) await assertProjectActive(db, patch.projectId);

  // Record only fields that actually change, so the timeline never lies and
  // a same-value or empty patch is a true no-op (no row write, no event).
  const changed = PATCHABLE_FIELDS.filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toTask(existing);

  // The task's project/parent AFTER this patch -- an absent key falls back to
  // the row's current value (leave-untouched semantics, same as every other
  // field). groupChanged decides whether the position needs re-appending
  // into a different sibling group (project+parent pair) -- the same formula
  // createTask's groupKey uses. Either half of the pair changing changes the
  // group, so a plain project move (parentTaskId untouched, still top-level
  // in both) needs a reposition just as much as a reparent does.
  const nextProjectId = patch.projectId !== undefined ? patch.projectId : existing.projectId;
  const nextParentTaskId = patch.parentTaskId !== undefined ? patch.parentTaskId : existing.parentTaskId;
  const groupChanged = nextProjectId !== existing.projectId || nextParentTaskId !== existing.parentTaskId;
  if (nextParentTaskId !== null && groupChanged) {
    await assertParentValid(db, nextParentTaskId, nextProjectId);
  }

  // Parent-side reparent guard: assertParentValid above only protects the
  // CHILD's own invariant (my new parent is in my project, and isn't itself
  // a subtask). It says nothing about a task's EXISTING children when the
  // task itself is the one being edited here. Two ways that hole bites:
  //   1. Moving THIS task to a different project while it still has children
  //      left behind in the old project -- exactly the same
  //      parent/child-project mismatch assertParentValid rejects from the
  //      child's side, just reached from the parent's side instead.
  //   2. Setting parentTaskId on THIS task (making it a subtask) while it
  //      still has children of its own -- Phase 3's one-level rule forbids a
  //      task from being both a parent and a child, and that must hold no
  //      matter which end of the relationship the request edits.
  // Deliberately NOT cascade-reassigning the children's projectId (or
  // detaching them) to make the patch "just work": silently moving N
  // subtasks across projects (or orphaning them into the standalone pool) as
  // a side effect of a one-field edit is the exact kind of surprise
  // projects.ts's updateProject rejects for project-completion cascading
  // onto tasks -- the caller must move or detach the subtasks explicitly
  // first, and gets told so.
  const projectChanging = patch.projectId !== undefined && patch.projectId !== existing.projectId;
  const becomingChild = patch.parentTaskId !== undefined && patch.parentTaskId !== null;
  const needsChildGuard = projectChanging || becomingChild;

  const task = await db.transaction(async (tx) => {
    if (needsChildGuard) {
      // Checked fresh inside the transaction (not against a pre-transaction
      // snapshot) so a child inserted concurrently, between the reads above
      // and this point, can't slip past the guard.
      const [child] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentTaskId, id)).limit(1);
      if (child !== undefined) {
        throw new ConflictError(
          "task", id,
          `task ${id} has subtasks; move or detach them before changing its project or making it a subtask itself`,
        );
      }
    }

    let position: string | undefined;
    if (groupChanged) {
      const groupKey = `tasks:${nextProjectId ?? "standalone"}:${nextParentTaskId ?? "root"}`;
      await lockSiblingGroup(tx, groupKey);
      const siblingWhere = [
        nextParentTaskId === null ? isNull(tasks.parentTaskId) : eq(tasks.parentTaskId, nextParentTaskId),
        nextProjectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, nextProjectId),
        ne(tasks.id, id),
      ];
      const [lastSibling] = await tx.select({ position: tasks.position }).from(tasks)
        .where(and(...siblingWhere)).orderBy(desc(tasks.position)).limit(1);
      position = midpoint(lastSibling?.position ?? null, null);
    }

    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGetTask read above and this UPDATE yields zero
    // rows here instead of silently mutating an archived record.
    const [row] = await tx.update(tasks)
      .set({
        title: patch.title, description: patch.description, type: patch.type,
        assigneeUserId: patch.assigneeUserId, startDate: patch.startDate, dueDate: patch.dueDate,
        progressPct: patch.progressPct, parentTaskId: patch.parentTaskId,
        companyId: patch.companyId, contactId: patch.contactId, dealId: patch.dealId, projectId: patch.projectId,
        ...(position !== undefined ? { position } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), isNull(tasks.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(tasks).where(eq(tasks.id, id));
      throw recheck === undefined ? new NotFoundError("task", id) : new ArchivedError("task", id);
    }
    const eventCompanyId = await resolveEventCompanyId(tx, row);
    await tx.insert(events).values({
      verb: "updated", actorUserId: actorId, taskId: id, projectId: row.projectId,
      companyId: eventCompanyId, payload: { changed },
    });
    return toTask(row);
  });
  // existing.assigneeUserId is the pre-patch assignee -- passed unconditionally
  // so a reassignment publishes both the old and new My Tasks keys; the Set in
  // publishTaskHint collapses this to one key when the assignee didn't change.
  publishTaskHint(task, [existing.assigneeUserId]);
  return task;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Task> {
  await mustGetTask(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state
  // already matched what was requested, so nothing changed) -- that branch
  // must not publish, same as any other no-op short-circuit in this file.
  const { task, wrote } = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasks)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(tasks.id, id),
        archived ? isNull(tasks.archivedAt) : isNotNull(tasks.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(tasks).where(eq(tasks.id, id));
      if (recheck === undefined) throw new NotFoundError("task", id);
      return { task: toTask(recheck), wrote: false };
    }
    const eventCompanyId = await resolveEventCompanyId(tx, row);
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId,
      taskId: id, projectId: row.projectId, companyId: eventCompanyId, payload: {},
    });
    return { task: toTask(row), wrote: true };
  });
  if (wrote) publishTaskHint(task);
  return task;
}
export const archiveTask = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveTask = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

// Statuses are freely settable -- unlike deals, task workflow has no
// transition matrix. Entering `done` stamps completed_at; leaving it clears
// completed_at -- the tasks_completed_at_paired CHECK is satisfied by
// construction here, not just trusted. `existing` is read outside the
// transaction (same precedent as updateDeal/updateProject's diff read) so
// the "from" status feeding the event payload/verb choice is a best-effort
// snapshot, not itself part of the atomic guard; the UPDATE's own
// archived_at IS NULL WHERE clause is what stays atomic against a concurrent
// archive.
export async function setTaskStatus(db: Database, actorId: string, id: string, status: TaskStatus): Promise<Task> {
  const existing = await mustGetTask(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("task", id);
  // Same-status "set" is a true no-op: no row write, no event, matching
  // updateDeal/updateProject's same-value-patch convention.
  if (existing.status === status) return toTask(existing);

  const fromStatus = existing.status as TaskStatus;
  const enteringDone = status === "done";
  const leavingDone = fromStatus === "done" && status !== "done";

  const task = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasks)
      .set({ status, completedAt: enteringDone ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), isNull(tasks.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(tasks).where(eq(tasks.id, id));
      throw recheck === undefined ? new NotFoundError("task", id) : new ArchivedError("task", id);
    }
    const eventCompanyId = await resolveEventCompanyId(tx, row);
    const verb = enteringDone ? "completed" : leavingDone ? "reopened" : "updated";
    const payload = verb === "updated" ? { changed: ["status"], from: fromStatus, to: status } : {};
    await tx.insert(events).values({
      verb, actorUserId: actorId, taskId: id, projectId: row.projectId, companyId: eventCompanyId, payload,
    });
    return toTask(row);
  });
  publishTaskHint(task);
  return task;
}

// Phase 2 moveDeal pattern, verbatim: re-reads the task and its neighbours
// entirely inside the transaction (never trusts positions or relationships
// the caller sent, only ids), locks the TARGET (project, status) column's
// sibling group before any read that feeds the computed position (so two
// concurrent moves into the same gap serialise and land on distinct
// positions), and narrows the requested gap to whatever currently occupies
// it rather than trusting the named neighbours' stored positions. See
// deals.ts's moveDeal for the full reasoning on gap-narrowing direction and
// the neighbour re-read discipline -- this is the same algorithm with
// stage/pipeline swapped for status/project.
export async function moveTaskOnBoard(
  db: Database, actorId: string, taskId: string, opts: MoveTaskOnBoardInput,
): Promise<Task> {
  const task = await db.transaction(async (tx) => {
    // Board moves stay within the task's own project (or standalone pool) --
    // there is no cross-project drag, only a column (status) change within
    // it -- so the lock/sibling-group key needs to know which project that
    // is before anything can be locked, unlike moveDeal's target-stage lock
    // (entirely caller-supplied, no read required first). This probe is used
    // ONLY to build the lock key, never to decide anything: existence,
    // archived state, and the row's own current status/completedAt all come
    // from the authoritative mustGetTask re-read immediately below, AFTER
    // the lock is held -- same lock-before-any-decision-feeding-read
    // discipline deals.ts's moveDeal follows, just with one extra read up
    // front because this lock key isn't fully caller-supplied.
    const [probe] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
    if (probe === undefined) throw new NotFoundError("task", taskId);
    await lockSiblingGroup(tx, `tasks:board:${probe.projectId ?? "standalone"}:${opts.status}`);

    const existing = await mustGetTask(tx, taskId);
    if (existing.archivedAt !== null) throw new ArchivedError("task", taskId);
    const projectId = existing.projectId;

    const sameColumn = (t: TaskRow) => t.projectId === projectId && t.status === opts.status;

    let beforePos: string | null = null;
    if (opts.beforeTaskId != null) {
      const before = await mustGetTask(tx, opts.beforeTaskId);
      if (!sameColumn(before)) throw new ConflictError("task", opts.beforeTaskId);
      beforePos = before.position;
    }
    let afterPos: string | null = null;
    if (opts.afterTaskId != null) {
      const after = await mustGetTask(tx, opts.afterTaskId);
      if (!sameColumn(after)) throw new ConflictError("task", opts.afterTaskId);
      afterPos = after.position;
    }

    // Stale-pair guard: named neighbours no longer adjacent (or given
    // reversed) -- surface as a domain ConflictError, not an opaque midpoint()
    // throw.
    if (beforePos !== null && afterPos !== null && beforePos >= afterPos) {
      throw new ConflictError("task", taskId);
    }

    const columnWhere = (extra: ReturnType<typeof eq>[]) => and(
      eq(tasks.status, opts.status),
      projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, projectId),
      ne(tasks.id, taskId),
      ...extra,
    );

    if (beforePos === null && afterPos === null) {
      // No neighbours: append at the tail of the column, mirroring
      // createTask's append semantics.
      const [tail] = await tx.select({ position: tasks.position }).from(tasks)
        .where(columnWhere([])).orderBy(desc(tasks.position)).limit(1);
      beforePos = tail?.position ?? null;
    } else if (beforePos === null) {
      // Front insert: afterPos is the only anchor (the branch above already
      // ruled out both being null). Narrow to the nearest CURRENT occupant
      // above afterPos, not the column's global topmost row -- see
      // deals.ts's moveDeal front-insert comment for the regression this
      // guards against. TS can't chain the "both null" exclusion across the
      // two branches' conditions (they narrow different variables), hence
      // the explicit guard -- purely to satisfy the type checker and
      // document the runtime invariant.
      if (afterPos === null) throw new Error("moveTaskOnBoard: unreachable -- both bounds null is handled above");
      const anchor: string = afterPos;
      const [tightest] = await tx.select({ position: tasks.position }).from(tasks)
        .where(columnWhere([lt(tasks.position, anchor)])).orderBy(desc(tasks.position)).limit(1);
      if (tightest !== undefined) beforePos = tightest.position;
    } else {
      // beforePos anchors the gap; the nearest CURRENT occupant above it
      // narrows the upper bound.
      const anchor = beforePos;
      const extra = [gt(tasks.position, anchor)];
      if (afterPos !== null) extra.push(lt(tasks.position, afterPos));
      const [tightest] = await tx.select({ position: tasks.position }).from(tasks)
        .where(columnWhere(extra)).orderBy(tasks.position).limit(1);
      if (tightest !== undefined) afterPos = tightest.position;
    }

    const position = midpoint(beforePos, afterPos);
    const statusChanged = existing.status !== opts.status;
    const enteringDone = statusChanged && opts.status === "done";
    const leavingDone = statusChanged && existing.status === "done" && opts.status !== "done";

    // archived_at IS NULL in the WHERE closes the same TOCTOU gap
    // updateTask/updateCompany guard against: without it, a concurrent
    // archive landing between the mustGetTask read above and this UPDATE
    // would silently reposition/restatus an archived task instead of the
    // zero-row recheck below catching it.
    const [row] = await tx.update(tasks).set({
      status: opts.status,
      position,
      // completedAt piggybacks setTaskStatus's done-pairing rules; unchanged
      // when status didn't change (statusChanged false collapses both
      // entering/leavingDone to false, so this falls through to the existing
      // value).
      completedAt: enteringDone ? new Date() : leavingDone ? null : existing.completedAt,
      updatedAt: new Date(),
    }).where(and(eq(tasks.id, taskId), isNull(tasks.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      throw recheck === undefined ? new NotFoundError("task", taskId) : new ArchivedError("task", taskId);
    }

    // Position-only reorders (status unchanged) emit NO event -- pure board
    // reordering is timeline noise nobody wants to see. Only a genuine
    // column (status) change is worth a line on the timeline, and it's
    // reported minimally as `updated {changed:["status"]}` -- board moves
    // deliberately do NOT also emit `completed`/`reopened` the way
    // setTaskStatus does; completedAt is still stamped/cleared per the same
    // done rules, just without a second event verb for what is, from the
    // board's perspective, one drag gesture.
    if (statusChanged) {
      const eventCompanyId = await resolveEventCompanyId(tx, row);
      await tx.insert(events).values({
        verb: "updated", actorUserId: actorId, taskId, projectId: row.projectId,
        companyId: eventCompanyId, payload: { changed: ["status"] },
      });
    }
    return toTask(row);
  });
  publishTaskHint(task);
  return task;
}

// drizzle-orm wraps every driver error in a DrizzleQueryError; the original
// postgres.js PostgresError (carrying the actual Postgres error code) sits on
// its `.cause`, not on the wrapper itself -- checking `err.code` directly
// here would never match.
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === "23505";
}

// Adding predecessor->successor. Both must exist, live in the same project
// (or both be standalone), and not be the same task (the CHECK backs the
// self-ref case; this is a friendlier pre-check that avoids a raw DB error).
export async function addDependency(
  db: Database, actorId: string, predecessorId: string, successorId: string,
): Promise<TaskDependency> {
  const predecessor = await mustGetTask(db, predecessorId);
  const successor = await mustGetTask(db, successorId);
  if (predecessorId === successorId) {
    throw new ConflictError("task", predecessorId, "a task cannot depend on itself");
  }
  if (predecessor.projectId !== successor.projectId) {
    throw new ConflictError("task", successorId, "tasks must belong to the same project to depend on each other");
  }

  const dep = await db.transaction(async (tx) => {
    // Serialises check+insert per dependency graph: without this, two
    // concurrent addDependency calls forming the two edges of a 2-cycle
    // (A->B and B->A) each run their BFS under READ COMMITTED against the
    // pre-image of the graph (neither sees the other's not-yet-committed
    // edge), both find no cycle, and both insert -- landing a live cycle in
    // the committed data despite every individual check passing. That cycle
    // is sticky downstream: scheduling.ts's shiftTask cascade would walk
    // into it and abort at its depth guard forever, with no repair endpoint
    // short of a manual DELETE. Locking the whole graph (keyed by project, or
    // the standalone pool -- same group predecessor/successor already agree
    // on) before the BFS forces the second caller to wait, re-run its BFS
    // against the FIRST caller's now-committed edge, and correctly find the
    // cycle. Same tool this file already uses twice (createTask/updateTask's
    // sibling-group locks), just guarding a graph invariant instead of a
    // position sequence.
    await lockSiblingGroup(tx, `deps:${predecessor.projectId ?? "standalone"}`);

    // Reject a dependency that would create a cycle: if predecessor is
    // reachable FROM successor via EXISTING edges, adding
    // predecessor->successor on top of that closes a loop
    // (predecessor->successor->...->predecessor), and scheduling.ts's
    // cascade would walk it forever. The walk is a BFS starting at successor
    // and following existing edges FORWARD (successor's own successors, and
    // theirs, ...) -- NOT backward from predecessor, which is the classic
    // inverted-direction bug here: walking backward from predecessor would
    // find nodes that feed INTO predecessor, which says nothing about
    // whether predecessor can get back to itself through successor. Finding
    // predecessorId anywhere in the forward-reachable set from successor
    // means the new edge would close that loop.
    //
    // Batched per frontier level via inArray (not per-node), bounded by
    // 10_000 visited nodes -- defence in depth; a real project's dependency
    // graph is tiny, so this bound is not expected to ever bind in practice.
    let frontier = [successorId];
    const visited = new Set<string>([successorId]);
    while (frontier.length > 0) {
      const rows = await tx.select({ successorId: taskDependencies.successorId })
        .from(taskDependencies).where(inArray(taskDependencies.predecessorId, frontier));
      const next: string[] = [];
      for (const r of rows) {
        if (r.successorId === predecessorId) {
          throw new ConflictError(
            "task", predecessorId, `adding this dependency would create a cycle (predecessor ${predecessorId})`,
          );
        }
        if (!visited.has(r.successorId)) {
          visited.add(r.successorId);
          next.push(r.successorId);
        }
      }
      if (visited.size > 10_000) throw new ConflictError("task", "dependency graph too large");
      frontier = next;
    }

    let row: TaskDependencyRow;
    try {
      const [inserted] = await tx.insert(taskDependencies).values({ predecessorId, successorId }).returning();
      if (inserted === undefined) throw new Error("insert returned no row");
      row = inserted;
    } catch (err) {
      // UNIQUE(predecessor_id, successor_id) violation -- this exact pair
      // already exists. Remapped to a domain ConflictError so a duplicate-add
      // is a 409, not a raw DB error leaking through. Thrown immediately
      // (no further statements attempted on this transaction), so drizzle's
      // transaction wrapper rolls back cleanly even though the connection is
      // now in Postgres's aborted-transaction state.
      if (isUniqueViolation(err)) throw new ConflictError("task", successorId, "this dependency already exists");
      throw err;
    }

    // Dependency events live on the SUCCESSOR (the task whose scheduling is
    // affected), carrying task_id + project_id + company_id (direct or via
    // project).
    const eventCompanyId = await resolveEventCompanyId(tx, successor);
    await tx.insert(events).values({
      verb: "dependency_added", actorUserId: actorId, taskId: successorId, projectId: successor.projectId,
      companyId: eventCompanyId, payload: { predecessorId },
    });
    return toTaskDependency(row);
  });
  publishTaskHint(toTask(successor));
  return dep;
}

// Idempotent: deleting an edge that doesn't exist is a silent no-op (zero
// rows, no event), same idempotency convention as archiveTask/unarchiveTask.
export async function removeDependency(db: Database, actorId: string, predecessorId: string, successorId: string): Promise<void> {
  const successor = await db.transaction(async (tx) => {
    const [row] = await tx.delete(taskDependencies)
      .where(and(eq(taskDependencies.predecessorId, predecessorId), eq(taskDependencies.successorId, successorId)))
      .returning();
    if (row === undefined) return null;

    const [succRow] = await tx.select().from(tasks).where(eq(tasks.id, successorId));
    if (succRow === undefined) return null;
    const eventCompanyId = await resolveEventCompanyId(tx, succRow);
    await tx.insert(events).values({
      verb: "dependency_removed", actorUserId: actorId, taskId: successorId, projectId: succRow.projectId,
      companyId: eventCompanyId, payload: { predecessorId },
    });
    return succRow;
  });
  if (successor !== null) publishTaskHint(toTask(successor));
}

export async function getTask(db: Database, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row === undefined ? null : toTask(row);
}

// Predecessors of `id` -- the edges the task drawer's dependency list needs
// (this task is the successor end of each). mustGetTask 404s a bad task id
// rather than silently returning an empty list, mirroring getTask's route
// (routes/tasks.ts) 404ing a missing id instead of returning null-as-200.
// Ordered by createdAt so the drawer's list is stable (insertion order)
// rather than whatever order Postgres happens to return rows in.
export async function listDependencies(db: Database, id: string): Promise<TaskDependency[]> {
  await mustGetTask(db, id);
  const rows = await db.select().from(taskDependencies)
    .where(eq(taskDependencies.successorId, id)).orderBy(taskDependencies.createdAt);
  return rows.map(toTaskDependency);
}

export interface ListTasksOptions {
  projectId?: string; standalone?: boolean; assigneeId?: string;
  status?: TaskStatus; dated?: boolean; archived?: boolean;
}

// Unbounded and unpaginated, the same deliberate tradeoff listDeals/
// listProjects make: a project's task board, My Tasks, and the Gantt all
// need every matching task in one shot for their columns/rows/bars to render
// correctly -- a page boundary mid-board would be a rendering bug, not a UX
// nicety. Bounded by what a team can usefully keep on one board/Gantt; a
// runaway task count is itself an anomaly worth surfacing, not a case to
// paginate around.
export async function listTasks(db: Database, opts: ListTasksOptions): Promise<Task[]> {
  const where = [opts.archived ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt)];
  if (opts.projectId) where.push(eq(tasks.projectId, opts.projectId));
  if (opts.standalone) where.push(isNull(tasks.projectId));
  if (opts.assigneeId) where.push(eq(tasks.assigneeUserId, opts.assigneeId));
  if (opts.status) where.push(eq(tasks.status, opts.status));
  if (opts.dated) where.push(isNotNull(tasks.startDate));
  // Ordered (parent group, position): Postgres's default NULLS LAST on an
  // ascending sort groups every top-level task (parent_task_id NULL)
  // together, then each parent's children together, each group internally
  // ordered by its fractional position.
  const rows = await db.select().from(tasks).where(and(...where))
    .orderBy(tasks.parentTaskId, tasks.position);
  return rows.map(toTask);
}
