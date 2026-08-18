import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { midpoint } from "@conduit/shared";
import type {
  Pipeline, PipelineScope, PipelineWithStages, CreatePipelineInput, UpdatePipelineInput,
  Stage, CreateStageInput, UpdateStageInput,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, pipelines, stages, events, type PipelineRow, type StageRow } from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";

function toPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id, name: row.name, scope: row.scope as PipelineScope, companyId: row.companyId,
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
// company: a global pipeline has no company (and no contact/deal) to attach
// an event row to, and nothing in the product renders a "global timeline", so
// a global-pipeline event would be permanently unreachable. Company-scoped
// pipeline mutations DO write one, carrying company_id, so they surface on
// that company's timeline. Every mutator below (create/update/archive/
// unarchive, and the stage mutators further down) checks companyId and skips
// the insert when it is null.
async function maybeEmitPipelineEvent(
  tx: Database, actorId: string, row: PipelineRow, verb: string, payload: Record<string, unknown>,
): Promise<void> {
  if (row.companyId === null) return;
  await tx.insert(events).values({ verb, actorUserId: actorId, companyId: row.companyId, payload });
}

export async function createPipeline(db: Database, actorId: string, input: CreatePipelineInput): Promise<Pipeline> {
  // createPipelineInputSchema's scopeCompanyPaired refine already guarantees
  // companyId is present iff scope is "company" -- this only checks that the
  // id it names actually exists.
  if (input.scope === "company") await assertCompanyExists(db, input.companyId!);
  const companyId = input.scope === "company" ? input.companyId! : null;

  return db.transaction(async (tx) => {
    // Siblings = same scope + same company (global pipelines never compete
    // for position with company-scoped ones, and two different companies'
    // pipelines never compete with each other).
    const [lastSibling] = await tx.select({ position: pipelines.position }).from(pipelines)
      .where(and(eq(pipelines.scope, input.scope), companyId === null ? isNull(pipelines.companyId) : eq(pipelines.companyId, companyId)))
      .orderBy(desc(pipelines.position)).limit(1);
    const position = midpoint(lastSibling?.position ?? null, null);

    const [row] = await tx.insert(pipelines).values({ name: input.name, scope: input.scope, companyId, position }).returning();
    if (row === undefined) throw new Error("insert returned no row");
    await maybeEmitPipelineEvent(tx, actorId, row, "created", {});
    return toPipeline(row);
  });
}

export async function updatePipeline(db: Database, actorId: string, id: string, patch: UpdatePipelineInput): Promise<Pipeline> {
  const existing = await mustGetPipeline(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("pipeline", id);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  const changed = (Object.keys(patch) as (keyof UpdatePipelineInput)[])
    .filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toPipeline(existing);

  return db.transaction(async (tx) => {
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
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Pipeline> {
  await mustGetPipeline(db, id);
  return db.transaction(async (tx) => {
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
      return toPipeline(recheck);
    }
    await maybeEmitPipelineEvent(tx, actorId, row, archived ? "archived" : "unarchived", {});
    return toPipeline(row);
  });
}
export const archivePipeline = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchivePipeline = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

export async function getPipeline(db: Database, id: string): Promise<PipelineWithStages | null> {
  const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
  if (row === undefined) return null;
  const stageRows = await db.select().from(stages).where(eq(stages.pipelineId, id)).orderBy(stages.position);
  return { pipeline: toPipeline(row), stages: stageRows.map(toStage) };
}

export interface ListPipelinesOptions { scope?: PipelineScope; companyId?: string; archived?: boolean; }

// No pagination: pipelines are bounded (a handful per company at most, plus a
// small number of global ones), the same tradeoff listNotes makes for a
// single record's notes. Unlike listCompanies/listContacts, which can grow
// into the thousands, a runaway pipeline count would itself be an anomaly
// worth surfacing rather than a case to paginate around.
export async function listPipelines(db: Database, opts: ListPipelinesOptions): Promise<Pipeline[]> {
  const where = [opts.archived ? isNotNull(pipelines.archivedAt) : isNull(pipelines.archivedAt)];
  if (opts.scope) where.push(eq(pipelines.scope, opts.scope));
  if (opts.companyId) where.push(eq(pipelines.companyId, opts.companyId));
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

  return db.transaction(async (tx) => {
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
    // generic "updated" verb with the stage id carried in the payload rather
    // than a dedicated stage_* verb.
    await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed: ["stage_added"], stageId: row.id });
    return toStage(row);
  });
}

export async function updateStage(db: Database, actorId: string, id: string, patch: UpdateStageInput): Promise<Stage> {
  const existing = await mustGetStage(db, id);

  const changed = (Object.keys(patch) as (keyof UpdateStageInput)[])
    .filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toStage(existing);

  return db.transaction(async (tx) => {
    const [row] = await tx.update(stages).set({ ...patch, updatedAt: new Date() })
      .where(eq(stages.id, id)).returning();
    if (row === undefined) throw new NotFoundError("stage", id);

    // row.pipelineId is immutable (stages never move between pipelines), so
    // this read is always fresh with respect to which pipeline owns the stage.
    const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, row.pipelineId));
    if (pipeline !== undefined) {
      await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed, stageId: id });
    }
    return toStage(row);
  });
}

export interface ReorderStageInput { beforeStageId?: string; afterStageId?: string; }

// The dry run for Task 3's moveDeal: re-read the two neighbour rows by id
// inside the transaction (never trust positions the caller sent -- only the
// ids), verify each actually belongs to the same pipeline as the stage being
// moved, then compute a midpoint between their *current* positions. A
// neighbour that no longer belongs to this pipeline means the caller's board
// view is stale (someone else reordered concurrently) -- ConflictError, not a
// silent misplace.
export async function reorderStage(db: Database, actorId: string, stageId: string, opts: ReorderStageInput): Promise<Stage> {
  return db.transaction(async (tx) => {
    const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId));
    if (stage === undefined) throw new NotFoundError("stage", stageId);

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

    const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, stage.pipelineId));
    if (pipeline !== undefined) {
      await maybeEmitPipelineEvent(tx, actorId, pipeline, "updated", { changed: ["position"], stageId });
    }
    return toStage(row);
  });
}
