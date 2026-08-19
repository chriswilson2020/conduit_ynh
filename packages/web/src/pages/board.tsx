import { useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, PointerSensor, closestCenter, rectIntersection,
  useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Deal, Stage } from "@conduit/shared";
import {
  useCompanies, useCreateDeal, useCreateStage, useDeals, useMoveDeal, usePipeline, useUpdateStage, useUsers,
} from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Funnel } from "../components/funnel";
import { parseDecimal } from "../lib";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CardDndData { type: "card"; stageId: string }
interface PlaceholderDndData { type: "placeholder"; stageId: string }
interface ColumnDndData { type: "column"; stageId: string }
type DndData = CardDndData | PlaceholderDndData | ColumnDndData;

/**
 * Every card sits inside BOTH its own sortable droppable AND its column's
 * wrapping useDroppable (added so pointer users can drop into blank space
 * below the last card, appending at the tail -- see Column's comment below).
 * That containment relationship breaks a KEYBOARD drag under the stock
 * closestCenter algorithm two different ways (a pointer drag hits neither --
 * the first pixel of movement already breaks any tie):
 *
 *   1. On lift, the active card's own collisionRect exactly equals its own
 *      resting droppable rect -- distance zero to itself -- so `over` locks
 *      onto the dragged card and no arrow press can ever move it anywhere.
 *   2. Even once the active id is excluded, a column's droppable rect
 *      spatially CONTAINS every card inside it, and closestCenter ranks
 *      candidates by distance between RECT CENTERS -- for a compact column
 *      the column's own center can be closer to the ghost's center than any
 *      individual sibling card's center is, so `over` sticks on the column
 *      and a same-column ArrowDown/ArrowUp never reaches a sibling card.
 *
 * rectIntersection sidesteps both by ranking candidates on overlap RATIO
 * instead of center distance. The keyboard sensor's own coordinateGetter
 * (sortableKeyboardCoordinates) snaps the ghost's rect to align with the
 * target card/placeholder on every arrow press, so afterwards the ghost
 * overlaps that one small card almost completely (ratio near 1) while only
 * covering a tiny fraction of the much larger enclosing column (ratio near
 * 0) -- the card wins outright without ever comparing centers. This also
 * preserves the pointer blank-space-drop case: a point that overlaps no
 * card at all still overlaps the column, so `over` still resolves to the
 * column there and onDragEnd's existing tail-append branch still fires.
 * closestCenter is kept as a fallback for the one case rectIntersection
 * can't answer -- nothing at all under the ghost -- which should not arise
 * on this board (every column always has either cards or its empty-column
 * placeholder) but is defensive rather than load-bearing.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const withoutActive = {
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => container.id !== args.active.id),
  };
  const intersections = rectIntersection(withoutActive);
  return intersections.length > 0 ? intersections : closestCenter(withoutActive);
};

/**
 * dnd-kit's default droppable measuring strategy (MeasuringStrategy.
 * WhileDragging, MeasuringFrequency.Optimized) only (re)measures droppable
 * rects in response to a `useEffect` that fires after `dragging` flips to
 * true -- an async, paint-gated pass, not something that completes inside
 * the same synchronous keydown handling that lifts the item. A real user's
 * "pick up, THEN arrow, THEN drop" is spread across enough wall-clock time
 * for that effect to have long since flushed; Playwright's scripted
 * `Space, ArrowRight, Space` (no delay between presses, exactly what
 * e2e/pipeline.spec.ts's keyboard-drag steps do) can complete all three
 * key events before that effect ever runs. With no measured rects yet for
 * anything but the origin card's own column, sortableKeyboardCoordinates'
 * candidate scan (which explicitly skips any droppable it has no rect for)
 * finds nothing in the pressed direction and the ArrowRight becomes a
 * silent no-op -- the immediately-following Space then drops the card right
 * back into whatever `over` already was: its own origin column. Forcing
 * MeasuringStrategy.Always removes the "wait for dragging to start" gate
 * entirely, so droppable rects are always current, not just eventually
 * current. The board is small (a handful of stages/deals, per the design's
 * own "bounded by what a team can usefully keep on one view" cap), so the
 * extra continuous measuring this trades in for is not a real cost here.
 */
const boardMeasuring = { droppable: { strategy: MeasuringStrategy.Always } };

export function BoardPage() {
  const { pipelineId } = useParams({ from: "/pipelines/$pipelineId" });
  const { data: pipelineData, isLoading } = usePipeline(pipelineId);
  const { data: dealsData } = useDeals(pipelineId);
  // Same limit-100 lookup tradeoff as ContactsPage's companyMap.
  const { data: companiesData } = useCompanies({ limit: 100 });
  const { data: users = [] } = useUsers();
  const moveDeal = useMoveDeal();

  const companyMap = useMemo(
    () => new Map((companiesData?.items ?? []).map((company) => [company.id, company.name])),
    [companiesData],
  );
  const userInitials = useMemo(
    () => new Map(users.map((user) => [user.id, (user.fullName ?? user.username).slice(0, 1).toUpperCase()])),
    [users],
  );

  // Won/lost deals never render on the board -- a closed deal's stage is
  // frozen (see moveDeal's status guard in services/deals.ts) and its home
  // from here on is the deal detail page (Task 7), not a kanban column.
  const openDeals = useMemo(() => (dealsData ?? []).filter((deal) => deal.status === "open"), [dealsData]);

  const grouped = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const deal of openDeals) {
      const list = map.get(deal.stageId) ?? [];
      list.push(deal);
      map.set(deal.stageId, list);
    }
    // position is a fractional string, COLLATE C server-side -- plain string
    // comparison (< / >) matches, per moveDealInputSchema's JSDoc.
    for (const list of map.values()) {
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    }
    return map;
  }, [openDeals]);

  // Board stays the default view (matches every existing board.spec.ts
  // Playwright assertion, which locates cards/columns without first
  // switching views) -- Funnel is opt-in per page load, not persisted.
  const [view, setView] = useState<"board" | "funnel">("board");

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeDeal = activeId !== null ? (openDeals.find((deal) => deal.id === activeId) ?? null) : null;

  // Cards navigate to the deal detail page on click (see DealCard below), but
  // dnd-kit's own drag lifecycle must win when the user is actually dragging,
  // not clicking. PointerSensor's activationConstraint below means a plain
  // click (no pointer movement past 4px) never starts a drag at all -- this
  // ref only needs to guard the OTHER direction: a real drag's mouseup can
  // still fire a native "click" event afterward (on whichever card happens to
  // be under the pointer at drop time, which is not necessarily the dragged
  // card itself, since dnd-kit's live reordering can shift a different card
  // under it). handleDragStart only ever fires once that 4px threshold is
  // exceeded, so reaching it at all already proves a genuine drag, not a
  // click -- setting the flag there and clearing it on a macrotask (after the
  // synchronous click that follows the same mouseup) suppresses that
  // spurious click regardless of which card's onClick ends up receiving it.
  const suppressCardClickRef = useRef(false);

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const archived = pipelineData !== undefined && pipelineData.pipeline.archivedAt !== null;
  // Empty sensor list means no pointer/keyboard gesture can ever activate a
  // drag -- the simplest way to make the whole board read-only for an
  // archived pipeline without branching the JSX below into two shapes.
  const sensors = useSensors(...(archived ? [] : [pointerSensor, keyboardSensor]));

  // TEMPORARY DEBUG INSTRUMENTATION -- capture-phase listener on the
  // document, independent of dnd-kit entirely, to see exactly which
  // keydowns physically arrive and when.
  useMemo(() => {
    if (typeof document === "undefined") return;
    const seen = (document as unknown as { __dbgKeyListenerInstalled?: boolean }).__dbgKeyListenerInstalled;
    if (seen) return;
    (document as unknown as { __dbgKeyListenerInstalled?: boolean }).__dbgKeyListenerInstalled = true;
    document.addEventListener(
      "keydown",
      (e) => {
        // eslint-disable-next-line no-console
        console.log(`[dbg keydown] code=${e.code} t=${performance.now().toFixed(1)}`);
      },
      true,
    );
  }, []);

  function handleDragStart(event: DragStartEvent) {
    // eslint-disable-next-line no-console
    console.log(`[dbg onDragStart] id=${event.active.id} t=${performance.now().toFixed(1)}`);
    setActiveId(String(event.active.id));
    suppressCardClickRef.current = true;
  }

  // TEMPORARY DEBUG INSTRUMENTATION -- see the keyboard-drag race
  // investigation in commit history.
  function handleDragOver() {
    // eslint-disable-next-line no-console
    console.log(`[dbg onDragOver] t=${performance.now().toFixed(1)}`);
  }

  // dnd-kit calls onDragCancel instead of onDragEnd when a drag is aborted
  // (e.g. Escape mid-drag) -- without this, both activeId and
  // suppressCardClickRef would stay stuck from the handleDragStart above,
  // leaving the DragOverlay showing a phantom card and the next plain click
  // silently swallowed.
  function handleDragCancel() {
    // eslint-disable-next-line no-console
    console.log(`[dbg onDragCancel] t=${performance.now().toFixed(1)}`);
    setActiveId(null);
    suppressCardClickRef.current = false;
  }

  function handleDragEnd(event: DragEndEvent) {
    // eslint-disable-next-line no-console
    console.log(`[dbg onDragEnd] over=${event.over?.id ?? null} t=${performance.now().toFixed(1)}`);
    setActiveId(null);
    // See suppressCardClickRef's doc comment above for why this is a
    // macrotask reset rather than immediate: the drop gesture's native click
    // event (if any) dispatches synchronously, ahead of a setTimeout(0)
    // queued from here, so it still observes the flag as true.
    setTimeout(() => { suppressCardClickRef.current = false; }, 0);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeData = active.data.current as DndData | undefined;
    const overData = over.data.current as DndData | undefined;
    if (activeData === undefined || activeData.type !== "card" || overData === undefined) return;

    const targetStageId = overData.stageId;
    const activeDealId = String(active.id);
    const overId = String(over.id);

    let beforeDealId: string | undefined;
    let afterDealId: string | undefined;

    if (activeData.stageId === targetStageId) {
      // Same-column reorder. Neighbours must be read off the same
      // reordering the user SAW, not derived from over's index in
      // isolation: dnd-kit's own drop preview follows
      // arrayMove(activeIndex, overIndex), which places a downward-dragged
      // card AFTER the card it's dropped on and an upward-dragged card
      // BEFORE it. Deriving insertAt from over's index alone (the previous
      // version of this code) reproduces only the upward case -- column
      // [A,B,C,D], dragging A onto C previews [B,C,A,D] (A lands after C),
      // but indexing on over's position in the active-filtered array yields
      // beforeDealId=B/afterDealId=C, landing A one slot early, before C
      // instead of after it. Running the SAME arrayMove the preview uses
      // and reading A's neighbours off the result keeps this in sync with
      // what was on screen for both directions.
      const ids = (grouped.get(targetStageId) ?? []).map((deal) => deal.id);
      const fromIndex = ids.indexOf(activeDealId);
      const toIndex = overData.type === "card" ? ids.indexOf(overId) : ids.length - 1;
      if (fromIndex === -1 || toIndex === -1) return;

      const reordered = arrayMove(ids, fromIndex, toIndex);
      const at = reordered.indexOf(activeDealId);
      beforeDealId = at > 0 ? reordered[at - 1] : undefined;
      afterDealId = at < reordered.length - 1 ? reordered[at + 1] : undefined;

      // Drop-in-place is a no-op: skip the network call entirely when the
      // computed neighbours match the ones the deal already had before the
      // drag started (e.g. picked up and released without changing slot).
      const originalBefore = fromIndex > 0 ? ids[fromIndex - 1] : undefined;
      const originalAfter = fromIndex < ids.length - 1 ? ids[fromIndex + 1] : undefined;
      if (beforeDealId === originalBefore && afterDealId === originalAfter) return;
    } else {
      // Cross-column: the active deal isn't in the target column's list yet,
      // so there is no "prior slot" for arrayMove to reorder from -- dnd-kit
      // treats a foreign card entering another column's sortable list as a
      // plain insert at the hovered card's index (displacing it and
      // everything after it down by one), which is exactly what its own
      // drop preview shows for this case. That's a genuinely different rule
      // from the same-column branch above (which continues PAST the hovered
      // card when dragging downward) -- both match what dnd-kit itself
      // renders, they just differ because one starts from "already in the
      // list" and the other from "not in the list yet". Dropping on the
      // column itself (blank space, or the empty-column placeholder)
      // appends at the tail, mirroring moveDealInputSchema's append
      // semantics for "both neighbours omitted".
      const targetIds = (grouped.get(targetStageId) ?? []).map((deal) => deal.id);
      let insertAt = targetIds.length;
      if (overData.type === "card") {
        const idx = targetIds.indexOf(overId);
        if (idx !== -1) insertAt = idx;
      }
      beforeDealId = insertAt > 0 ? targetIds[insertAt - 1] : undefined;
      afterDealId = insertAt < targetIds.length ? targetIds[insertAt] : undefined;
    }

    moveDeal.mutate({ id: activeDealId, pipelineId, stageId: targetStageId, beforeDealId, afterDealId });
  }

  if (isLoading) return <p>Loading...</p>;
  if (!pipelineData) return null;

  const { pipeline, stages } = pipelineData;

  const columns = (
    <div data-testid="board" className="flex items-start gap-4 overflow-x-auto pb-4">
      {stages.map((stage) => (
        <Column
          key={stage.id}
          stage={stage}
          deals={grouped.get(stage.id) ?? []}
          companyMap={companyMap}
          userInitials={userInitials}
          pipelineId={pipelineId}
          readOnly={archived}
          suppressCardClickRef={suppressCardClickRef}
        />
      ))}
      {!archived && <AddStageTile pipelineId={pipelineId} />}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link to="/pipelines" className="text-xs font-medium text-slate-500 hover:text-slate-700">
          {"\u2190"} Pipelines
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{pipeline.name}</h1>
      </div>

      {archived && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          This pipeline is archived. The board is read-only.
        </div>
      )}

      <div data-testid="view-toggle" className="flex gap-2">
        <Button variant={view === "board" ? "default" : "outline"} onClick={() => setView("board")}>
          Board
        </Button>
        <Button variant={view === "funnel" ? "default" : "outline"} onClick={() => setView("funnel")}>
          Funnel
        </Button>
      </div>

      {view === "funnel" ? (
        <Funnel pipelineId={pipelineId} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollisionDetection}
          measuring={boardMeasuring}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          {columns}
          <DragOverlay>
            {activeDeal ? (
              <div className="flex flex-col gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 shadow-lg">
                <DealCardContent
                  deal={activeDeal}
                  companyName={activeDeal.companyId ? companyMap.get(activeDeal.companyId) : undefined}
                  ownerInitial={activeDeal.ownerUserId ? userInitials.get(activeDeal.ownerUserId) : undefined}
                  rotten={false}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function Column({
  stage,
  deals,
  companyMap,
  userInitials,
  pipelineId,
  readOnly,
  suppressCardClickRef,
}: {
  stage: Stage;
  deals: Deal[];
  companyMap: Map<string, string>;
  userInitials: Map<string, string>;
  pipelineId: string;
  readOnly: boolean;
  suppressCardClickRef: RefObject<boolean>;
}) {
  const { setNodeRef } = useDroppable({
    id: `column:${stage.id}`,
    data: { type: "column", stageId: stage.id } satisfies ColumnDndData,
    disabled: readOnly,
  });
  const dealIds = deals.map((deal) => deal.id);
  // An empty column has no card to register as a sortable item, so nothing
  // for the keyboard sensor's coordinateGetter to land on (it only considers
  // sortable-registered rects, not plain droppables) -- registering the
  // stage's own id as the sole sortable item when empty (see
  // EmptyPlaceholder below) keeps an empty column reachable by keyboard, the
  // same way a card in it would be.
  const sortableItems = dealIds.length > 0 ? dealIds : [stage.id];
  const valueSum = deals.reduce((sum, deal) => sum + (deal.valueCents ?? 0), 0);
  const currencies = new Set(deals.map((deal) => deal.currency));
  // A single Conduit instance has one DEFAULT_CURRENCY (see the Phase 2
  // design's currency decision), so a mixed-currency column is unreachable
  // through this board's own "New deal" dialog today -- but updateDeal's
  // currency field is directly PATCHable via the API regardless, and a
  // future per-deal currency picker would make it reachable through the UI
  // too. Summing raw cents across currencies would silently misreport the
  // total (100 EUR + 100 USD is not "200"), so this falls back to a literal
  // "mixed" label instead of a wrong number.
  const formattedSum = currencies.size > 1
    ? "mixed"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: deals[0]?.currency ?? "EUR" }).format(valueSum / 100);

  return (
    <div data-testid={`column-${stage.id}`} className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-slate-100 p-2">
      <StageHeader stage={stage} pipelineId={pipelineId} readOnly={readOnly} count={deals.length} valueLabel={formattedSum} />
      <div ref={setNodeRef} className="flex min-h-8 flex-1 flex-col gap-2">
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              stage={stage}
              companyName={deal.companyId ? companyMap.get(deal.companyId) : undefined}
              ownerInitial={deal.ownerUserId ? userInitials.get(deal.ownerUserId) : undefined}
              readOnly={readOnly}
              suppressCardClickRef={suppressCardClickRef}
            />
          ))}
          {deals.length === 0 && <EmptyPlaceholder stageId={stage.id} />}
        </SortableContext>
      </div>
      {!readOnly && <NewDealButton pipelineId={pipelineId} stageId={stage.id} />}
    </div>
  );
}

function EmptyPlaceholder({ stageId }: { stageId: string }) {
  const { setNodeRef } = useSortable({
    id: stageId,
    data: { type: "placeholder", stageId } satisfies PlaceholderDndData,
  });
  return (
    <div ref={setNodeRef} className="rounded-md border border-dashed border-slate-300 px-2 py-4 text-center text-xs text-slate-400">
      No deals
    </div>
  );
}

function DealCard({
  deal,
  stage,
  companyName,
  ownerInitial,
  readOnly,
  suppressCardClickRef,
}: {
  deal: Deal;
  stage: Stage;
  companyName?: string;
  ownerInitial?: string;
  readOnly: boolean;
  suppressCardClickRef: RefObject<boolean>;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    data: { type: "card", stageId: deal.stageId } satisfies CardDndData,
    disabled: readOnly,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  const daysSinceUpdate = Math.floor((Date.now() - new Date(deal.updatedAt).getTime()) / MS_PER_DAY);
  const rotten = stage.rotDays != null && daysSinceUpdate > stage.rotDays;
  const rotTitle = `No activity for ${daysSinceUpdate} days (stage rots after ${stage.rotDays} days)`;

  // Cards navigate to the deal detail page on a plain click. See
  // suppressCardClickRef's doc comment in BoardPage for why the flag it
  // checks is enough to tell a click apart from a drag-and-drop's trailing
  // click, without this card needing to know whether IT was the one dragged.
  function handleClick() {
    if (suppressCardClickRef.current) return;
    void navigate({ to: "/deals/$dealId", params: { dealId: deal.id } });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`card-${deal.id}`}
      onClick={handleClick}
      className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
      {...attributes}
      {...listeners}
    >
      <DealCardContent deal={deal} companyName={companyName} ownerInitial={ownerInitial} rotten={rotten} rotTitle={rotTitle} />
    </div>
  );
}

// Shared between the resting card above and the DragOverlay ghost rendered
// while dragging, so the overlay -- which has no stage/rot context of its
// own -- still shows the same value + company line as the card it's
// standing in for, not just the bare title.
function DealCardContent({
  deal,
  companyName,
  ownerInitial,
  rotten,
  rotTitle,
}: {
  deal: Deal;
  companyName?: string;
  ownerInitial?: string;
  rotten: boolean;
  rotTitle?: string;
}) {
  const formattedValue = deal.valueCents != null
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: deal.currency }).format(deal.valueCents / 100)
    : null;

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{deal.title}</span>
        {rotten && <span title={rotTitle} className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-500" />}
      </div>
      {formattedValue && <span className="text-xs text-slate-600">{formattedValue}</span>}
      <div className="flex items-center justify-between">
        <span className="truncate text-xs text-slate-400">{companyName ?? ""}</span>
        {ownerInitial && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[10px] font-semibold text-white">
            {ownerInitial}
          </span>
        )}
      </div>
    </>
  );
}

function StageHeader({
  stage,
  pipelineId,
  readOnly,
  count,
  valueLabel,
}: {
  stage: Stage;
  pipelineId: string;
  readOnly: boolean;
  count: number;
  valueLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stage.name);
  const updateStage = useUpdateStage();

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === stage.name) return;
    updateStage.mutate({ pipelineId, stageId: stage.id, patch: { name: trimmed } });
  }

  return (
    <div className="px-1">
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              setDraft(stage.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            setDraft(stage.name);
            setEditing(true);
          }}
          className="block w-full truncate text-left text-sm font-semibold text-slate-900 disabled:cursor-default"
        >
          {stage.name}
        </button>
      )}
      <div className="mt-0.5 text-xs text-slate-500">
        {count} {"\u00b7"} {valueLabel}
      </div>
    </div>
  );
}

function AddStageTile({ pipelineId }: { pipelineId: string }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const createStage = useCreateStage();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createStage.mutate(
      { pipelineId, input: { name: trimmed } },
      {
        onSuccess: () => {
          setName("");
          setAdding(false);
        },
      },
    );
  }

  if (!adding) {
    return (
      <div className="w-72 shrink-0">
        <Button variant="outline" onClick={() => setAdding(true)}>
          {"+"} Stage
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-slate-100 p-2">
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Stage name"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setName("");
            setAdding(false);
          }
        }}
        disabled={createStage.isPending}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={name.trim() === "" || createStage.isPending}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setName("");
            setAdding(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewDealButton({ pipelineId, stageId }: { pipelineId: string; stageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">
          New deal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <NewDealDialog pipelineId={pipelineId} stageId={stageId} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewDealDialog({
  pipelineId,
  stageId,
  onClose,
}: {
  pipelineId: string;
  stageId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const createDeal = useCreateDeal();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "") return;
    // parseDecimal (src/lib.ts) tolerates a comma decimal separator ("12,50")
    // on top of the dot form the type="number" input already accepts, and
    // returns null (rather than NaN) for an empty/garbage draft.
    const parsedValue = parseDecimal(value);
    const valueCents = parsedValue === null ? undefined : Math.round(parsedValue * 100);
    createDeal.mutate({ title: trimmed, pipelineId, stageId, valueCents }, { onSuccess: () => onClose() });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New deal</DialogTitle>
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Deal title"
        disabled={createDeal.isPending}
      />
      <Input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Value (optional)"
        disabled={createDeal.isPending}
      />
      {createDeal.isError && <p className="text-sm text-red-600">{createDeal.error.message}</p>}
      <Button type="submit" disabled={title.trim() === "" || createDeal.isPending}>
        Create
      </Button>
    </form>
  );
}
