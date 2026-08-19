import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import type { Project, ProjectStatus, CreateProjectInput, UpdateProjectInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, deals, projects, events, type ProjectRow } from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { publish } from "./sse.js";

/** Invalidation keys every project mutator publishes after its transaction commits. */
function publishProjectHint(id: string): void {
  publish({ keys: [["projects"], ["project", id], ["events"], ["search"]] });
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id, name: row.name,
    companyId: row.companyId, dealId: row.dealId, ownerUserId: row.ownerUserId,
    status: row.status as ProjectStatus,
    startDate: row.startDate, dueDate: row.dueDate,
    color: row.color,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// Existence-only, mirroring assertCompanyExists in contacts.ts/deals.ts/
// pipelines.ts -- deliberately NOT notes.ts's assertNoteTargetActive, which
// also blocks an archived target. A project is expected to go on referencing
// its company/originating deal for its whole lifecycle, including after that
// company is archived or that deal closes/archives: archiving/closing hides a
// record from default listings, it does not sever links already (or newly)
// pointed at it. Same monotonic-existence reasoning as deals.ts: safe to read
// via `db` outside the transaction only because companies/deals are
// archive-only, never hard-deleted -- a later hard-delete phase needs to move
// this inside the transaction to close the race instead of silently going
// stale.
async function assertCompanyExists(db: Database, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (row === undefined) throw new NotFoundError("company", companyId);
}
async function assertDealExists(db: Database, dealId: string): Promise<void> {
  const [row] = await db.select({ id: deals.id }).from(deals).where(eq(deals.id, dealId));
  if (row === undefined) throw new NotFoundError("deal", dealId);
}

// Structural comparison, copied from deals.ts/pipelines.ts's fieldChanged:
// arrays/objects compare by order-sensitive JSON value, scalars by !==. None
// of a project's patchable fields are arrays/objects today, but this keeps
// the same shape as the other hardened services so a future field addition
// here does not silently regress to reference inequality.
function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

export async function createProject(db: Database, actorId: string, input: CreateProjectInput): Promise<Project> {
  if (input.companyId != null) await assertCompanyExists(db, input.companyId);
  if (input.dealId != null) await assertDealExists(db, input.dealId);

  const project = await db.transaction(async (tx) => {
    const [row] = await tx.insert(projects).values({
      name: input.name,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      color: input.color ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");

    // Carries both project_id and company_id (when set) so the event surfaces
    // on the project's own timeline AND its company's, mirroring deals.ts's
    // convention. Every other event this file emits follows the same rule.
    await tx.insert(events).values({
      verb: "created", actorUserId: actorId, companyId: row.companyId, projectId: row.id, payload: {},
    });
    return toProject(row);
  });
  publishProjectHint(project.id);
  return project;
}

async function mustGet(db: Database, id: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (row === undefined) throw new NotFoundError("project", id);
  return row;
}

// status included alongside the create-input fields: unlike a deal's status
// (gated behind winDeal/loseDeal/reopenDeal's state machine), a project's
// status is freely settable here -- see updateProjectInputSchema's doc
// comment in @conduit/shared. There is deliberately no side effect on the
// project's tasks when status flips to/from "completed": bulk-mutating every
// task's status on a project-level flip would surprise a user who marked the
// PROJECT done while intentionally leaving a follow-up task open, and if the
// project is later reopened, nothing here would know which of those tasks to
// restore to their prior state. Completion is a project-level label, not a
// task-cascading action.
const PATCHABLE_FIELDS = [
  "name", "companyId", "dealId", "ownerUserId", "startDate", "dueDate", "color", "status",
] as const satisfies readonly (keyof UpdateProjectInput)[];

export async function updateProject(db: Database, actorId: string, id: string, patch: UpdateProjectInput): Promise<Project> {
  const existing = await mustGet(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("project", id);
  if (patch.companyId != null) await assertCompanyExists(db, patch.companyId);
  if (patch.dealId != null) await assertDealExists(db, patch.dealId);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  const changed = PATCHABLE_FIELDS.filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toProject(existing);

  const project = await db.transaction(async (tx) => {
    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGet read above and this UPDATE yields zero rows
    // here instead of silently mutating an archived record.
    const [row] = await tx.update(projects)
      .set({
        name: patch.name, companyId: patch.companyId, dealId: patch.dealId, ownerUserId: patch.ownerUserId,
        startDate: patch.startDate, dueDate: patch.dueDate, color: patch.color, status: patch.status,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), isNull(projects.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(projects).where(eq(projects.id, id));
      throw recheck === undefined ? new NotFoundError("project", id) : new ArchivedError("project", id);
    }
    await tx.insert(events).values({
      verb: "updated", actorUserId: actorId, companyId: row.companyId, projectId: id, payload: { changed },
    });
    return toProject(row);
  });
  publishProjectHint(project.id);
  return project;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Project> {
  await mustGet(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state already
  // matched what was requested, so nothing changed) -- that branch must not
  // publish, same as any other no-op short-circuit in this file.
  const { project, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
    // requires the row currently unarchived, unarchiving requires it currently
    // archived. Zero rows back means the state already matched what was requested
    // (either a concurrent call got there first, or this call is a no-op repeat),
    // so re-select and return the current row instead of emitting a duplicate event.
    const [row] = await tx.update(projects)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(projects.id, id),
        archived ? isNull(projects.archivedAt) : isNotNull(projects.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(projects).where(eq(projects.id, id));
      if (recheck === undefined) throw new NotFoundError("project", id);
      return { project: toProject(recheck), wrote: false };
    }
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId,
      companyId: row.companyId, projectId: id, payload: {},
    });
    return { project: toProject(row), wrote: true };
  });
  if (wrote) publishProjectHint(project.id);
  return project;
}
export const archiveProject = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveProject = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

export async function getProject(db: Database, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row === undefined ? null : toProject(row);
}

export interface ListProjectsOptions { companyId?: string; status?: ProjectStatus; archived?: boolean; }

// Unbounded and unpaginated, the same deliberate tradeoff listPipelines makes
// in pipelines.ts: projects are bounded by what an organisation actually
// runs concurrently (a handful to a few dozen), not a CRM-scale collection
// like companies/contacts that can grow into the thousands. A runaway project
// count would itself be an anomaly worth surfacing, not a case to paginate
// around.
export async function listProjects(db: Database, opts: ListProjectsOptions): Promise<Project[]> {
  const where = [opts.archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)];
  if (opts.companyId) where.push(eq(projects.companyId, opts.companyId));
  if (opts.status) where.push(eq(projects.status, opts.status));
  const rows = await db.select().from(projects).where(and(...where))
    .orderBy(desc(projects.createdAt), desc(projects.id));
  return rows.map(toProject);
}
