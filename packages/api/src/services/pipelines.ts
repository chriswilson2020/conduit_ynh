import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { midpoint } from "@conduit/shared";
import type {
  Pipeline, PipelineScope, PipelineWithStages, CreatePipelineInput, UpdatePipelineInput,
  Stage, CreateStageInput, UpdateStageInput,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, projects, pipelines, stages, events, type PipelineRow, type StageRow } from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { publish } from "./sse.js";

/** Invalidation keys every pipeline/stage mutator publishes after its transaction
 * commits. Stages have no list/detail cache of their own -- they ride along inside
 * the pipeline-detail response -- so a stage change publishes the same two keys as
 * a pipeline change, keyed on the OWNING pipeline's id. */
function publishPipelineHint(pipelineId: string): void {
  publish({ keys: [["pipelines"], ["pipeline", pipelineId], ["events"]] });
}

function toPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id, name: row.name, scope: row.scope as PipelineScope,
    companyId: row.companyId, projectId: row.projectId,
    position: row.position,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function toStage(row: StageRow): Stage {
  return {
    id: row.id, pipelineId: row.pipelineId, name: row.name, position: row.position,
    probability: row.probability, rotDays: row.rotDays,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// Mirrors assertCompanyExists in contacts.ts: a companyId that does not exist
// would otherwise surface as a raw FK violation from Postgres. An archived
// company is a valid pipeline owner on purpose -- archiving hides a company
// from default listings, it does not sever pipelines already (or newly)
// pointed at it.
//
// Reading via `db` outside the transaction is safe only because company
// existence is monotonic: companies are archive-only, never hard-deleted. If a
// later phase adds hard delete, this check needs to move inside the
// transaction to close the race instead of silently going stale.
async function assertCompanyExists(db: Database, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (row === undefined) throw new NotFoundError("company", companyId);
}

// Same existence-only, archived-is-valid reasoning as assertCompanyExists
// above, applied to Phase 3's project scope -- a project, like a company, is
// archive-only, never hard-deleted, so this read is safe outside the
// transaction for the same monotonic-existence reason. Returns the project's
// companyId (possibly null) so createPipeline can dual-stamp its event on the
// project's own parent company, mirroring maybeEmitPipelineEvent's handling
// of project-scoped mutations further down.
async function assertProjectExists(db: Database, projectId: string): Promise<string | null> {
  const [row] = await db.select({ id: projects.id, companyId: projects.companyId })
    .from(projects).where(eq(projects.id, projectId));
  if (row === undefined) throw new NotFoundError("project", projectId);
  return row.companyId;
}

async function mustGetPipeline(db: Database, id: string): Promise<PipelineRow> {
  const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
  if (row === undefined) throw new NotFoundError("pipeline", id);
  return row;
}

async function mustGetStage(db: Database, id: string): Promise<StageRow> {
  const [row] = await db.select().from(stages).where(eq(stages.id, id));
  if (row === undefined) throw new NotFoundError("stage", id);
  return row;
}

// Serialises sibling-position writes: under READ COMMITTED, two concurrent
// inserts/moves into the same sibling group would otherwise both read the
// same tail (or neighbour) positions and compute identical midpoint()
// results, leaving `ORDER BY position` to tie-break nondeterministically.
// A partial unique index can't fix this either -- global pipelines share a
// NULL company_id, which Postgres treats as distinct in every unique index,
// so it would never catch a collision there. pg_advisory_xact_lock is
// transaction-scoped (auto-released at commit/rollback) and keyed on the
// sibling group, so unrelated groups (a different pipeline's stages, a
// different company's pipelines) never contend with each other.
// hashtextextended folds the group-key string into the bigint key the
// advisory-lock functions require. Call this first, before any read whose
// result feeds into the position this transaction computes -- deals.ts's
// createDeal and moveDeal (a stage's deals) reuse this same helper, keyed
// `stages:deals:${stageId}` -- distinct from this file's own
// `stages:${pipelineId}` stage-reorder keys, so the two families of sibling
// groups never contend with each other.
export async function lockSiblingGroup(tx: Database, groupKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${groupKey}, 0))`);
}

// Structural comparison, copied from contacts.ts's fieldChanged: arrays/objects
// compare by order-sensitive JSON value, scalars by !==. Neither pipeline nor
// stage patches currently carry an array/object field (name / probability /
// rotDays are all scalars), so this is presently equivalent to a plain !==,
// but it keeps the same shape as the other hardened services so a future
// field addition here does not silently regress to reference inequality.
function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

// [decision] Pipelines are timeline-relevant only through their owning
// company or project: a global pipeline has neither (and no contact/deal
// either) to attach an event row to, and nothing in the product renders a
// "global timeline", so a global-pipeline event would be permanently
// unreachable. Company-scoped pipeline mutations write one carrying
// company_id; project-scoped mutations write one carrying BOTH project_id
// and (when the project itself has a company) that company's id too --
// mirroring deals.ts's dealId/companyId dual-stamp, so a project pipeline's
// mutation surfaces on the project's own timeline AND its parent company's.
// Every mutator below (create/update/archive/unarchive, and the stage
// mutators further down) passes the pipeline row through here and this
// function decides which column(s), if any, get an event.
//
// The extra SELECT for a project-scoped row's companyId is a deliberate
// tradeoff over denormalising it onto the pipeline row: pipelines.company_id
// is reserved for company-scoped rows by the pipelines_scope_paired CHECK, so
// a project-scoped pipeline's own row never carries its project's company --
// it has to be looked up. Accepted at this scale the same way updateStage's
// extra mustGetPipeline call already is.
async function maybeEmitPipelineEvent(
  tx: Database, actorId: string, row: PipelineRow, verb: string, payload: Record<string, unknown>,
): Promise<void> {
  if (row.companyId === null && row.projectId === null) return;
  let companyId = row.companyId;
  if (row.projectId !== null) {
    const [project] = await tx.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, row.projectId));
    companyId = project?.companyId ?? null;
  }
  await tx.insert(events).values({ verb, actorUserId: actorId, companyId, projectId: row.projectId, payload });
}

export async function createPipeline(db: Database, actorId: string, input: CreatePipelineInput): Promise<Pipeline> {
  // createPipelineInputSchema's scopePaired refine already guarantees
  // companyId is present iff scope is "company" and projectId present iff
  // scope is "project" -- this only checks that the id it names actually
  // exists. An archived project is a valid pipeline owner, same as an
  // archived company (see assertProjectExists's comment).
  if (input.scope === "company") await assertCompanyExists(db, input.companyId!);
  if (input.scope === "project") await assertProjectExists(db, input.projectId!);
  const companyId = input.scope === "company" ? input.companyId! : null;
  const projectId = input.scope === "project" ? input.projectId! : null;

  const pipeline = await db.transaction(async (tx) => {
    // Siblings = same scope + same owner (global pipelines never compete for
    // position with company- or project-scoped ones, and two different
    // companies'/projects' pipelines never compete with each other). Group
    // key deliberately distinct per scope: `pipelines:project:${projectId}`
    // for project scope, matching the existing `pipelines:company:${companyId}`
    // shape.
    const scopeKey = input.scope === "company" ? companyId! : input.scope === "project" ? projectId! : "global";
    await lockSiblingGroup(tx, `pipelines:${input.scope}:${scopeKey}`);

    const [lastSibling] = await tx.select({ position: pipelines.position }).from(pipelines)
      .where(and(
        eq(pipelines.scope, input.scope),
        input.scope === "company" ? eq(pipelines.companyId, companyId!)
          : input.scope === "project" ? eq(pipelines.projectId, projectId!)
          : isNull(pipelines.companyId),
      ))
      .orderBy(desc(pipelines.position)).limit(1);
    const position = midpoint(lastSibling?.position ?? null, null);

    const [row] = await tx.insert(pipelines)
      .values({ name: input.name, scope: input.scope, companyId, projectId, position }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await maybeEmitPipelineEvent(tx, actorId, row, "created", {});
    return toPipeline(row);
  });
  publishPipelineHint(pipeline.id);
  return pipeline;
}

export async function updatePipeline(db: Database, actorId: string, id: string, patch: UpdatePipelineInput): Promise<Pipeline> {
  const existing = await mustGetPipeline(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("pipeline", id);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  const changed = (Object.keys(patch) as (keyof UpdatePipelineInput)[])
    .filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toPipeline(existing);

  const pipeline = await db.transaction(async (tx) => {
    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGetPipeline read above and this UPDATE yields
    // zero rows here instead of silently mutating an archived record.
    const [row] = await tx.update(pipelines)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(pipelines.id, id), isNull(pipelines.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(pipelines).where(eq(pipelines.id, id));
      throw recheck === undefined ? new NotFoundError("pipeline", id) : new ArchivedError("pipeline", id);
    }
    await maybeEmitPipelineEvent(tx, actorId, row, "updated", { changed });
    return toPipeline(row);
  });
  publishPipelineHint(pipeline.id);
  return pipeline;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Pipeline> {
  await mustGetPipeline(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state already
  // matched what was requested, so nothing changed) -- that branch must not
  // publish, same as any other no-op short-circuit in this file.
  const { pipeline, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
    // requires the row currently unarchived, unarchiving requires it currently
    // archived. Zero rows back means the state already matched what was requested
    // (either a concurrent call got there first, or this call is a no-op repeat),
    // so re-select and return the current row instead of emitting a duplicate event.
    const [row] = await tx.update(pipelines)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(pipelines.id, id),
        archived ? isNull(pipelines.archivedAt) : isNotNull(pipelines.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(pipelines).where(eq(pipelines.id, id));
      if (recheck === undefined) throw new NotFoundError("pipeline", id);
      return { pipeline: toPipeline(recheck), wrote: false };
    }
    await maybeEmitPipelineEvent(tx, actorId, row, archived ? "archived" : "unarchived", {});
    return { pipeline: toPipeline(row), wrote: true };
  });
  if (wrote) publishPipelineHint(pipeline.id);
  return pipeline;
}
export const archivePipeline = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchivePipeline = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

export async function getPipeline(db: Database, id: string): Promise<PipelineWithStages | null> {
  const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
  if (row === undefined) return null;
  const stageRows = await db.select().from(stages).where(eq(stages.pipelineId, id)).orderBy(stages.position);
  return { pipeline: toPipeline(row), stages: stageRows.map(toStage) };
}

export interface ListPipelinesOptions {
  scope?: PipelineScope; companyId?: string; projectId?: string; archived?: boolean;
}

// No pagination: pipelines are bounded (a handful per company/project at
// most, plus a small number of global ones), the same tradeoff listNotes
// makes for a single record's notes. Unlike listCompanies/listContacts,
// which can grow into the thousands, a runaway pipeline count would itself
// be an anomaly worth surfacing rather than a case to paginate around.
export async function listPipelines(db: Database, opts: ListPipelinesOptions): Promise<Pipeline[]> {
  const where = [opts.archived ? isNotNull(pipelines.archivedAt) : isNull(pipelines.archivedAt)];
  if (opts.scope) where.push(eq(pipelines.scope, opts.scope));
  if (opts.companyId) where.push(eq(pipelines.companyId, opts.companyId));
  if (opts.projectId) where.push(eq(pipelines.projectId, opts.projectId));
  const rows = await db.select().from(pipelines).where(and(...where)).orderBy(pipelines.position);
  return rows.map(toPipeline);
}

export async function createStage(db: Database, actorId: string, pipelineId: string, input: CreateStageInput): Promise<Stage> {
  // Read-then-check outside the transaction, same relaxed guarantee as notes.ts's
  // assertNoteTargetActive: archivedAt is a mutable flag, so this can go stale if
  // the pipeline is archived in the instant between this read and the insert
  // below. Accepted as low-stakes at this scale (one stray stage on a
  // just-archived pipeline, not data corruption) rather than paying for a
  // `SELECT ... FOR SHARE` here.
  const pipeline = await mustGetPipeline(db, pipelineId);
  if (pipeline.archivedAt !== null) throw new ArchivedError("pipeline", pipelineId);

  const stage = await db.transaction(async (tx) => {
    await lockSiblingGroup(tx, `stages:${pipelineId}`);

    const [lastSibling] = await tx.select({ position: stages.position }).from(stages)
      .where(eq(stages.pipelineId, pipelineId)).orderBy(desc(stages.position)).limit(1);
    const position = midpoint(lastSibling?.position ?? null, null);

    const [row] = await tx.insert(stages).values({
      pipelineId, name: input.name,
      probability: input.probability ?? null, rotDays: input.rotDays ?? null,
      position,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");

    // See maybeEmitPipelineEvent's comment: same company-only rule, but stages
    // have no row of their own on any timeline (events has no stage_id column),
    // so this always records against the pipeline's company, folded into the
    // generic "updated" verb with the stage id (and name, for a nicer future
    // timeline summary) carried in the payload rather than a dedicated
    // stage_* verb. "stages" (not "stage_added") in `changed` reads as
    // "updated stages" in a plain changed-fields rendering.
    await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed: ["stages"], stageId: row.id, stageName: row.name });
    return toStage(row);
  });
  publishPipelineHint(pipelineId);
  return stage;
}

export async function updateStage(db: Database, actorId: string, id: string, patch: UpdateStageInput): Promise<Stage> {
  const existing = await mustGetStage(db, id);
  // Resolved up front, not just for the event: an archived pipeline must
  // reject stage edits the same way createStage does (same relaxed,
  // read-then-check race as createStage's comment -- accepted at this scale).
  const pipeline = await mustGetPipeline(db, existing.pipelineId);
  if (pipeline.archivedAt !== null) throw new ArchivedError("pipeline", pipeline.id);

  const changed = (Object.keys(patch) as (keyof UpdateStageInput)[])
    .filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toStage(existing);

  const stage = await db.transaction(async (tx) => {
    const [row] = await tx.update(stages).set({ ...patch, updatedAt: new Date() })
      .where(eq(stages.id, id)).returning();
    if (row === undefined) throw new NotFoundError("stage", id);
    await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed, stageId: id });
    return toStage(row);
  });
  publishPipelineHint(pipeline.id);
  return stage;
}

/** beforeStageId/afterStageId name the neighbours the moved stage ends up
 * BETWEEN: beforeStageId is the neighbour immediately preceding it (lower
 * position), afterStageId the one immediately following it (higher
 * position). This is NOT "insert before this id" -- mirrors
 * moveDealInputSchema's JSDoc in @conduit/shared, which Task 3's moveDeal and
 * the web client must read the same way. */
export interface ReorderStageInput { beforeStageId?: string; afterStageId?: string; }

// The dry run for Task 3's moveDeal: re-read the two neighbour rows by id
// inside the transaction (never trust positions the caller sent -- only the
// ids), verify each actually belongs to the same pipeline as the stage being
// moved, then compute a midpoint between their *current* positions. A
// neighbour that no longer belongs to this pipeline means the caller's board
// view is stale (someone else reordered concurrently) -- ConflictError, not a
// silent misplace.
export async function reorderStage(db: Database, actorId: string, stageId: string, opts: ReorderStageInput): Promise<Stage> {
  const { stage: result, pipelineId } = await db.transaction(async (tx) => {
    const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId));
    if (stage === undefined) throw new NotFoundError("stage", stageId);

    // Same sibling group createStage locks (this transaction reads and writes
    // stage positions within the same pipeline), so a concurrent createStage
    // or reorderStage on this pipeline serialises against this one instead of
    // both computing a midpoint from the same stale neighbour snapshot.
    await lockSiblingGroup(tx, `stages:${stage.pipelineId}`);

    const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, stage.pipelineId));
    if (pipeline === undefined) throw new NotFoundError("pipeline", stage.pipelineId);
    if (pipeline.archivedAt !== null) throw new ArchivedError("pipeline", pipeline.id);

    let beforePos: string | null = null;
    if (opts.beforeStageId != null) {
      const [before] = await tx.select().from(stages).where(eq(stages.id, opts.beforeStageId));
      if (before === undefined) throw new NotFoundError("stage", opts.beforeStageId);
      if (before.pipelineId !== stage.pipelineId) throw new ConflictError("stage", opts.beforeStageId);
      beforePos = before.position;
    }
    let afterPos: string | null = null;
    if (opts.afterStageId != null) {
      const [after] = await tx.select().from(stages).where(eq(stages.id, opts.afterStageId));
      if (after === undefined) throw new NotFoundError("stage", opts.afterStageId);
      if (after.pipelineId !== stage.pipelineId) throw new ConflictError("stage", opts.afterStageId);
      afterPos = after.position;
    }
    const position = midpoint(beforePos, afterPos);

    const [row] = await tx.update(stages).set({ position, updatedAt: new Date() })
      .where(eq(stages.id, stageId)).returning();
    if (row === undefined) throw new NotFoundError("stage", stageId);

    await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed: ["position"], stageId });
    return { stage: toStage(row), pipelineId: pipeline.id };
  });
  publishPipelineHint(pipelineId);
  return result;
}
