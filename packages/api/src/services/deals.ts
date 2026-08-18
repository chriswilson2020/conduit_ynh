import { and, desc, eq, gt, inArray, isNull, isNotNull, lt, ne, sql } from "drizzle-orm";
import { midpoint } from "@conduit/shared";
import type {
  Deal, DealStatus, CreateDealInput, UpdateDealInput, MoveDealInput, FunnelRow,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, pipelines, stages, deals, events,
  type DealRow, type PipelineRow, type StageRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { lockSiblingGroup } from "./pipelines.js";
import { publish } from "./sse.js";

/** Invalidation keys every deal mutator (create/update/archive/move/win/lose/reopen)
 * publishes after its transaction commits. */
function publishDealHint(pipelineId: string, id: string): void {
  publish({ keys: [["deals", pipelineId], ["deal", id], ["funnel", pipelineId], ["events"], ["search"]] });
}

function toDeal(row: DealRow): Deal {
  return {
    id: row.id, title: row.title,
    pipelineId: row.pipelineId, stageId: row.stageId, position: row.position,
    valueCents: row.valueCents, currency: row.currency,
    expectedCloseDate: row.expectedCloseDate,
    status: row.status as DealStatus,
    lostReason: row.lostReason,
    closedAt: row.closedAt?.toISOString() ?? null,
    ownerUserId: row.ownerUserId,
    companyId: row.companyId, contactId: row.contactId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
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

async function mustGetDeal(db: Database, id: string): Promise<DealRow> {
  const [row] = await db.select().from(deals).where(eq(deals.id, id));
  if (row === undefined) throw new NotFoundError("deal", id);
  return row;
}

// Existence-only, like assertCompanyExists in contacts.ts/pipelines.ts --
// deliberately NOT notes.ts's assertNoteTargetActive, which also blocks an
// archived target. A deal, like a pipeline, is expected to go on referencing
// its company/contact for its whole lifecycle, including after that company
// or contact is archived: archiving hides a record from default listings, it
// does not sever links already (or newly) pointed at it. A brand-new note on
// an archived record is the one place Phase 1 chose the stricter "active"
// rule, not the general one -- deals follow pipelines' and contacts' looser
// rule instead.
async function assertCompanyExists(db: Database, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (row === undefined) throw new NotFoundError("company", companyId);
}
async function assertContactExists(db: Database, contactId: string): Promise<void> {
  const [row] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId));
  if (row === undefined) throw new NotFoundError("contact", contactId);
}

// Structural comparison, copied from pipelines.ts/contacts.ts's fieldChanged:
// arrays/objects compare by order-sensitive JSON value, scalars by !==. None
// of a deal's patchable fields are arrays/objects today, but this keeps the
// same shape as the other hardened services so a future field addition here
// does not silently regress to reference inequality.
function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || (typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

/**
 * currency defaults to the caller-supplied defaultCurrency (the deals route
 * passes config.defaultCurrency; tests pass whatever they like) only when
 * input.currency is omitted -- never silently overriding an explicit
 * currency the caller sent.
 */
export async function createDeal(
  db: Database, actorId: string, input: CreateDealInput, defaultCurrency: string,
): Promise<Deal> {
  // Existence-then-relationship, same order reorderStage uses for its
  // neighbour checks: does the stage exist at all, THEN does it belong where
  // the caller claims. Both reads happen outside the transaction, the same
  // relaxed monotonic-existence guarantee assertCompanyExists documents above
  // -- pipelines/stages are archive-only, never hard-deleted, in Phase 2.
  const stage = await mustGetStage(db, input.stageId);
  const pipeline = await mustGetPipeline(db, input.pipelineId);
  if (stage.pipelineId !== pipeline.id) throw new ConflictError("stage", input.stageId);
  if (pipeline.archivedAt !== null) throw new ArchivedError("pipeline", pipeline.id);

  if (input.companyId != null) await assertCompanyExists(db, input.companyId);
  if (input.contactId != null) await assertContactExists(db, input.contactId);

  const deal = await db.transaction(async (tx) => {
    // Siblings = all deals currently in this stage, regardless of status or
    // archived state, same as pipelines.ts's createPipeline/createStage
    // consider every sibling row (not just unarchived ones) when computing
    // the tail position. Group key deliberately distinct from this
    // pipeline's own `stages:${pipelineId}` stage-reorder key (see
    // lockSiblingGroup's comment in pipelines.ts).
    await lockSiblingGroup(tx, `stages:deals:${input.stageId}`);

    const [lastSibling] = await tx.select({ position: deals.position }).from(deals)
      .where(eq(deals.stageId, input.stageId)).orderBy(desc(deals.position)).limit(1);
    const position = midpoint(lastSibling?.position ?? null, null);

    const [row] = await tx.insert(deals).values({
      title: input.title, pipelineId: input.pipelineId, stageId: input.stageId, position,
      valueCents: input.valueCents ?? null,
      currency: input.currency ?? defaultCurrency,
      expectedCloseDate: input.expectedCloseDate ?? null,
      ownerUserId: input.ownerUserId ?? null,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
    }).returning();
    if (row === undefined) throw new Error("insert returned no row");

    // Carries both deal_id and company_id (when set) so the event surfaces on
    // the deal's own timeline AND its company's, per the Phase 2 events.deal_id
    // comment in schema.ts. Every other event this file emits follows the
    // same two-column rule.
    await tx.insert(events).values({
      verb: "created", actorUserId: actorId, companyId: row.companyId, dealId: row.id, payload: {},
    });
    return toDeal(row);
  });
  publishDealHint(deal.pipelineId, deal.id);
  return deal;
}

// pipelineId/stageId/position/status are not accepted here. At the type
// level, UpdateDealInput (packages/shared) omits pipelineId/stageId entirely
// and never had position/status in the first place, and zod's default
// (non-strict) object parsing silently drops any of those keys a caller
// still sends over HTTP. But `patch` reaching this function is only as safe
// as its caller: a direct service caller (as opposed to the zod-validated
// route) could construct an object with a stray stageId/status key and the
// TS type alone would not stop it at runtime. PATCHABLE_FIELDS is the actual
// enforcement -- both the diff below and the UPDATE's .set() are built from
// this fixed whitelist, not from `patch`'s own keys or a spread, so a stray
// key is silently ignored rather than smuggled through. Those four fields
// only ever change through moveDeal/winDeal/loseDeal/reopenDeal below, each
// with its own state-machine guard -- a generic field patch has no business
// deciding a legal stage/status transition.
const PATCHABLE_FIELDS = [
  "title", "valueCents", "currency", "expectedCloseDate", "ownerUserId", "companyId", "contactId",
] as const satisfies readonly (keyof UpdateDealInput)[];

export async function updateDeal(db: Database, actorId: string, id: string, patch: UpdateDealInput): Promise<Deal> {
  const existing = await mustGetDeal(db, id);
  if (existing.archivedAt !== null) throw new ArchivedError("deal", id);
  if (patch.companyId != null) await assertCompanyExists(db, patch.companyId);
  if (patch.contactId != null) await assertContactExists(db, patch.contactId);

  // Record only fields that actually change, so the timeline never lies and a
  // same-value or empty patch is a true no-op (no row write, no event).
  const changed = PATCHABLE_FIELDS.filter((k) => patch[k] !== undefined && fieldChanged(patch[k], existing[k]));
  if (changed.length === 0) return toDeal(existing);

  const deal = await db.transaction(async (tx) => {
    // archived_at IS NULL in the WHERE makes the guard atomic: a concurrent
    // archive between the mustGetDeal read above and this UPDATE yields zero
    // rows here instead of silently mutating an archived record.
    const [row] = await tx.update(deals)
      .set({
        title: patch.title, valueCents: patch.valueCents, currency: patch.currency,
        expectedCloseDate: patch.expectedCloseDate, ownerUserId: patch.ownerUserId,
        companyId: patch.companyId, contactId: patch.contactId,
        updatedAt: new Date(),
      })
      .where(and(eq(deals.id, id), isNull(deals.archivedAt))).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(deals).where(eq(deals.id, id));
      throw recheck === undefined ? new NotFoundError("deal", id) : new ArchivedError("deal", id);
    }
    await tx.insert(events).values({
      verb: "updated", actorUserId: actorId, companyId: row.companyId, dealId: id, payload: { changed },
    });
    return toDeal(row);
  });
  publishDealHint(deal.pipelineId, deal.id);
  return deal;
}

async function setArchived(db: Database, actorId: string, id: string, archived: boolean): Promise<Deal> {
  await mustGetDeal(db, id);
  // wrote is false on the recheck-and-return-as-is branch below (state already
  // matched what was requested, so nothing changed) -- that branch must not
  // publish, same as any other no-op short-circuit in this file.
  const { deal, wrote } = await db.transaction(async (tx) => {
    // The WHERE guard makes archive/unarchive idempotent and race-safe: archiving
    // requires the row currently unarchived, unarchiving requires it currently
    // archived. Zero rows back means the state already matched what was requested
    // (either a concurrent call got there first, or this call is a no-op repeat),
    // so re-select and return the current row instead of emitting a duplicate event.
    const [row] = await tx.update(deals)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(deals.id, id),
        archived ? isNull(deals.archivedAt) : isNotNull(deals.archivedAt),
      )).returning();
    if (row === undefined) {
      const [recheck] = await tx.select().from(deals).where(eq(deals.id, id));
      if (recheck === undefined) throw new NotFoundError("deal", id);
      return { deal: toDeal(recheck), wrote: false };
    }
    await tx.insert(events).values({
      verb: archived ? "archived" : "unarchived", actorUserId: actorId,
      companyId: row.companyId, dealId: id, payload: {},
    });
    return { deal: toDeal(row), wrote: true };
  });
  if (wrote) publishDealHint(deal.pipelineId, deal.id);
  return deal;
}
export const archiveDeal = (db: Database, a: string, id: string) => setArchived(db, a, id, true);
export const unarchiveDeal = (db: Database, a: string, id: string) => setArchived(db, a, id, false);

// Re-reads the deal and its neighbours entirely inside the transaction (never
// trusts positions or relationships the caller sent, only ids), the same
// stale-board defence reorderStage uses for stages. A neighbour that no
// longer belongs to the target stage, or a target stage that no longer
// belongs to the deal's pipeline, means the caller's board view is stale
// (someone else moved things concurrently) -- ConflictError, not a silent
// misplace.
export async function moveDeal(db: Database, actorId: string, dealId: string, opts: MoveDealInput): Promise<Deal> {
  const deal = await db.transaction(async (tx) => {
    // Lock the TARGET stage's deal group before any read whose result feeds
    // the position computed below (same lockSiblingGroup discipline as
    // createDeal). Locking the target rather than the source stage is what
    // makes two concurrent moves of two DIFFERENT deals into the same gap
    // serialise against each other and land on distinct positions: both
    // moves contend for the same lock because they share a target, even
    // though their source stages (and the deals themselves) differ.
    await lockSiblingGroup(tx, `stages:deals:${opts.stageId}`);

    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId));
    if (deal === undefined) throw new NotFoundError("deal", dealId);
    if (deal.archivedAt !== null) throw new ArchivedError("deal", dealId);
    // Only an open deal has anywhere left to move: a won/lost deal's stage is
    // frozen at whatever it was when it closed. reopenDeal is the only way
    // back to a state where moveDeal applies again.
    if (deal.status !== "open") throw new ConflictError("deal", dealId);

    const [targetStage] = await tx.select().from(stages).where(eq(stages.id, opts.stageId));
    if (targetStage === undefined) throw new NotFoundError("stage", opts.stageId);
    if (targetStage.pipelineId !== deal.pipelineId) throw new ConflictError("stage", opts.stageId);

    let beforePos: string | null = null;
    if (opts.beforeDealId != null) {
      const [before] = await tx.select().from(deals).where(eq(deals.id, opts.beforeDealId));
      if (before === undefined) throw new NotFoundError("deal", opts.beforeDealId);
      if (before.stageId !== opts.stageId) throw new ConflictError("deal", opts.beforeDealId);
      beforePos = before.position;
    }
    let afterPos: string | null = null;
    if (opts.afterDealId != null) {
      const [after] = await tx.select().from(deals).where(eq(deals.id, opts.afterDealId));
      if (after === undefined) throw new NotFoundError("deal", opts.afterDealId);
      if (after.stageId !== opts.stageId) throw new ConflictError("deal", opts.afterDealId);
      afterPos = after.position;
    }

    // Stale-pair guard: if both neighbours were given but are no longer
    // adjacent (someone reordered between them, or the caller's before/after
    // are simply the wrong way round), beforePos >= afterPos and midpoint()
    // below would throw its own plain Error -- an opaque 500, not a domain
    // error the client can react to. Surface it the same way every other
    // stale-board case in this function does.
    if (beforePos !== null && afterPos !== null && beforePos >= afterPos) {
      throw new ConflictError("deal", dealId);
    }

    // Narrow the requested gap to whatever CURRENTLY occupies it, rather than
    // trusting the named neighbours' stored positions as the final word.
    // midpoint() is a pure function of its two inputs: two concurrent
    // moveDeal calls naming the IDENTICAL neighbour pair -- the realistic
    // "two users drop into the same visual gap" race -- would otherwise both
    // compute the exact same string and tie, even serialised one after the
    // other by lockSiblingGroup, because the named neighbours' own rows never
    // moved. This extra read (still inside the same lock) is what actually
    // breaks the tie: the loser of the lock race runs second, so its query
    // sees the winner's freshly committed row sitting in the gap and narrows
    // against THAT instead -- the same self-correcting shape createDeal/
    // createStage get from re-reading the live tail under lock, adapted to a
    // bounded gap instead of an open-ended append.
    //
    // Which side narrows depends on which bound anchors the gap, and getting
    // this backwards is exactly the bug a review caught here: ordering ASC
    // unconditionally is correct when beforePos anchors the gap (the nearest
    // occupant ABOVE beforePos is always the tightest new upper bound,
    // whatever afterDealId's stored position says) -- but for a front insert
    // (beforeDealId omitted), the only anchor is afterPos, and ASC with no
    // lower bound would pick the stage's global topmost row instead of the
    // nearest occupant, leaping over every card a concurrent user prepended
    // and landing the moved card above all of them. That direction must
    // order DESC and narrow beforePos, not afterPos.
    if (beforePos === null && afterPos === null) {
      // No neighbours at all: append at the tail of the stage, mirroring
      // createDeal's append semantics (see moveDealInputSchema's JSDoc in
      // @conduit/shared) -- not "insert unbounded," which without this
      // branch would fall into the front-insert case below with afterPos
      // also null and land at the very front instead.
      const [tail] = await tx.select({ position: deals.position }).from(deals)
        .where(and(eq(deals.stageId, opts.stageId), ne(deals.id, dealId)))
        .orderBy(desc(deals.position)).limit(1);
      beforePos = tail?.position ?? null;
    } else if (beforePos === null) {
      // Front insert: afterPos is the only anchor. The preceding branch
      // already ruled out both being null, so afterPos is non-null here --
      // TS can't chain that across the two branches' conditions (they narrow
      // different variables), hence the explicit guard, kept purely to
      // satisfy the type checker and document the runtime invariant.
      if (afterPos === null) throw new Error("moveDeal: unreachable -- both bounds null is handled above");
      const anchor = afterPos;
      const [tightest] = await tx.select({ position: deals.position }).from(deals)
        .where(and(eq(deals.stageId, opts.stageId), ne(deals.id, dealId), lt(deals.position, anchor)))
        .orderBy(desc(deals.position)).limit(1);
      if (tightest !== undefined) beforePos = tightest.position;
    } else {
      // beforePos anchors the gap (afterDealId given too, or omitted for an
      // "append after X" move). The nearest CURRENT occupant above it
      // narrows the upper bound (ASC/limit 1).
      const anchor: string = beforePos;
      const gapConditions = [eq(deals.stageId, opts.stageId), ne(deals.id, dealId), gt(deals.position, anchor)];
      if (afterPos !== null) gapConditions.push(lt(deals.position, afterPos));
      const [tightest] = await tx.select({ position: deals.position }).from(deals)
        .where(and(...gapConditions)).orderBy(deals.position).limit(1);
      if (tightest !== undefined) afterPos = tightest.position;
    }

    const position = midpoint(beforePos, afterPos);

    const [row] = await tx.update(deals).set({ stageId: opts.stageId, position, updatedAt: new Date() })
      .where(eq(deals.id, dealId)).returning();
    if (row === undefined) throw new NotFoundError("deal", dealId);

    // fromName resolved for a nicer timeline summary without the client
    // needing a second round trip to a stage id -> name lookup. A move
    // within the same stage (reorder only) never looks this up twice.
    const fromStage = deal.stageId === targetStage.id
      ? targetStage
      : (await tx.select().from(stages).where(eq(stages.id, deal.stageId)))[0];
    await tx.insert(events).values({
      verb: "stage_changed", actorUserId: actorId, companyId: row.companyId, dealId,
      payload: {
        from: deal.stageId, to: targetStage.id,
        fromName: fromStage?.name ?? null, toName: targetStage.name,
      },
    });
    return toDeal(row);
  });
  publishDealHint(deal.pipelineId, deal.id);
  return deal;
}

// Single hardened state-machine guard shared by winDeal/loseDeal/reopenDeal:
// one UPDATE, WHERE-guarded on both archivedAt and the caller-supplied legal
// "from" statuses, so the transition check and the write happen atomically --
// a concurrent transition landing between any read and this UPDATE yields
// zero rows here instead of double-applying (e.g. two racing winDeal calls
// both succeeding) or applying over a state that stopped being legal. Zero
// rows back means recheck-and-disambiguate, same shape as setArchived/
// updateDeal above: NotFoundError if the row is gone, ArchivedError if it's
// archived, ConflictError otherwise (the transition itself was illegal).
async function setStatus(
  db: Database, actorId: string, id: string,
  target: DealStatus, fromStatuses: DealStatus[], lostReason: string | null,
): Promise<Deal> {
  const deal = await db.transaction(async (tx) => {
    const [row] = await tx.update(deals).set({
      status: target,
      // closed_at iff status != open; lost_reason only when status = lost --
      // both DB CHECKs (deals_closed_at_paired, deals_lost_reason_paired) are
      // satisfied by construction here, not just trusted.
      closedAt: target === "open" ? null : new Date(),
      lostReason: target === "lost" ? lostReason : null,
      updatedAt: new Date(),
    }).where(and(
      eq(deals.id, id),
      isNull(deals.archivedAt),
      inArray(deals.status, fromStatuses),
    )).returning();

    if (row === undefined) {
      const [recheck] = await tx.select().from(deals).where(eq(deals.id, id));
      if (recheck === undefined) throw new NotFoundError("deal", id);
      if (recheck.archivedAt !== null) throw new ArchivedError("deal", id);
      throw new ConflictError("deal", id);
    }

    const verb = target === "won" ? "won" : target === "lost" ? "lost" : "reopened";
    const payload = target === "won" ? { valueCents: row.valueCents, currency: row.currency }
      : target === "lost" ? { reason: row.lostReason }
      : {};
    await tx.insert(events).values({ verb, actorUserId: actorId, companyId: row.companyId, dealId: id, payload });
    return toDeal(row);
  });
  publishDealHint(deal.pipelineId, deal.id);
  return deal;
}

export const winDeal = (db: Database, actorId: string, id: string): Promise<Deal> =>
  setStatus(db, actorId, id, "won", ["open"], null);

// Zod's shape validation (a route-level loseDealInputSchema, added with the
// routes in a later task) only guarantees reason is a string; it does not by
// itself stop an empty one from a caller that constructs the input by hand
// (as these tests do, calling the service directly) rather than through the
// route. This defensive check keeps "a lost deal must be able to say why" a
// service-level invariant, not just a route-level one.
// async, not a plain function returning setStatus's promise: a bare `function`
// that throws synchronously on the empty-reason check would throw out of the
// call itself instead of yielding a rejected promise, breaking every caller
// (routes and tests alike) that uniformly does `await`/`.rejects` against
// this and every other exported deal mutator here.
export async function loseDeal(db: Database, actorId: string, id: string, reason: string): Promise<Deal> {
  if (reason.trim().length === 0) throw new Error("loseDeal: reason must not be empty");
  return setStatus(db, actorId, id, "lost", ["open"], reason);
}

export const reopenDeal = (db: Database, actorId: string, id: string): Promise<Deal> =>
  setStatus(db, actorId, id, "open", ["won", "lost"], null);

export async function getDeal(db: Database, id: string): Promise<Deal | null> {
  const [row] = await db.select().from(deals).where(eq(deals.id, id));
  return row === undefined ? null : toDeal(row);
}

export interface ListDealsOptions {
  pipelineId: string; stageId?: string; status?: DealStatus; archived?: boolean;
}

// Unbounded and unpaginated, the same deliberate tradeoff listPipelines makes
// in pipelines.ts: a kanban board needs every deal in the pipeline, ordered
// by each stage's own board position and then the deal's position within it,
// for its columns to render correctly in one shot -- a page boundary
// mid-column would be a rendering bug, not a UX nicety. Boards are bounded by
// what a team can usefully keep on one view; a runaway deal count is itself
// an anomaly worth surfacing, not a case to paginate around. A separate
// paginated cross-pipeline deal listing is deliberately out of scope for
// Phase 2 (the plan's "listDealsByStatus" was considered and cut).
export async function listDeals(db: Database, opts: ListDealsOptions): Promise<Deal[]> {
  const where = [
    eq(deals.pipelineId, opts.pipelineId),
    opts.archived ? isNotNull(deals.archivedAt) : isNull(deals.archivedAt),
  ];
  if (opts.stageId) where.push(eq(deals.stageId, opts.stageId));
  if (opts.status) where.push(eq(deals.status, opts.status));
  // Joined to stages and ordered by stages.position, NOT deals.stageId: the
  // stage id is a random UUID with no relation to column order on the board,
  // so sorting by it directly would scramble the columns. stages.position is
  // the fractional index that actually decides left-to-right column order.
  const rows = await db.select({ deal: deals }).from(deals)
    .innerJoin(stages, eq(deals.stageId, stages.id))
    .where(and(...where))
    .orderBy(stages.position, deals.position);
  return rows.map((r) => toDeal(r.deal));
}

// One GROUP BY, LEFT JOIN from stages (not deals) so every stage in the
// pipeline appears in the result even with zero open deals -- an INNER JOIN
// or a `deals`-rooted GROUP BY would silently drop empty stages, and the
// board's funnel view needs a zero-width bar for those, not a missing one.
// The FILTER clauses (not a WHERE on the join) are what let a stage's won/
// lost/archived deals still be joined without counting toward its bar.
export async function funnel(db: Database, pipelineId: string): Promise<FunnelRow[]> {
  const openUnarchived = and(eq(deals.status, "open"), isNull(deals.archivedAt));
  const rows = await db.select({
    stageId: stages.id,
    count: sql<string>`count(${deals.id}) filter (where ${openUnarchived})`,
    valueCents: sql<string>`coalesce(sum(coalesce(${deals.valueCents}, 0)) filter (where ${openUnarchived}), 0)`,
  })
    .from(stages)
    .leftJoin(deals, eq(deals.stageId, stages.id))
    .where(eq(stages.pipelineId, pipelineId))
    .groupBy(stages.id)
    .orderBy(stages.position);
  return rows.map((r) => ({ stageId: r.stageId, count: Number(r.count), valueCents: Number(r.valueCents) }));
}
