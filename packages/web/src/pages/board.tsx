import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useParams } from "@tanstack/react-router";
import type { Deal, Stage } from "@conduit/shared";
import {
  useCompanies, useCreateDeal, useCreateStage, useDeals, useMoveDeal, usePipeline, useUpdateStage, useUsers,
} from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CardDndData { type: "card"; stageId: string }
interface PlaceholderDndData { type: "placeholder"; stageId: string }
interface ColumnDndData { type: "column"; stageId: string }
type DndData = CardDndData | PlaceholderDndData | ColumnDndData;

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

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeDeal = activeId !== null ? (openDeals.find((deal) => deal.id === activeId) ?? null) : null;

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const archived = pipelineData !== undefined && pipelineData.pipeline.archivedAt !== null;
  // Empty sensor list means no pointer/keyboard gesture can ever activate a
  // drag -- the simplest way to make the whole board read-only for an
  // archived pipeline without branching the JSX below into two shapes.
  const sensors = useSensors(...(archived ? [] : [pointerSensor, keyboardSensor]));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeData = active.data.current as DndData | undefined;
    const overData = over.data.current as DndData | undefined;
    if (activeData === undefined || activeData.type !== "card" || overData === undefined) return;

    const targetStageId = overData.stageId;
    const targetIds = (grouped.get(targetStageId) ?? [])
      .map((deal) => deal.id)
      .filter((id) => id !== active.id);

    // Neighbours in the TARGET column, per moveDealInputSchema's JSDoc:
    // dropping on a card places the moved deal directly above it (so that
    // card becomes afterDealId); dropping on the column itself (empty space
    // or the empty-column placeholder) appends at the tail.
    let insertAt = targetIds.length;
    if (overData.type === "card") {
      const idx = targetIds.indexOf(String(over.id));
      if (idx !== -1) insertAt = idx;
    }
    const beforeDealId = insertAt > 0 ? targetIds[insertAt - 1] : undefined;
    const afterDealId = insertAt < targetIds.length ? targetIds[insertAt] : undefined;

    moveDeal.mutate({ id: String(active.id), pipelineId, stageId: targetStageId, beforeDealId, afterDealId });
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {columns}
        <DragOverlay>
          {activeDeal ? (
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2 shadow-lg">
              <span className="text-sm font-medium text-slate-900">{activeDeal.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
}: {
  stage: Stage;
  deals: Deal[];
  companyMap: Map<string, string>;
  userInitials: Map<string, string>;
  pipelineId: string;
  readOnly: boolean;
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
  const currency = deals[0]?.currency ?? "EUR";
  const formattedSum = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(valueSum / 100);

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
}: {
  deal: Deal;
  stage: Stage;
  companyName?: string;
  ownerInitial?: string;
  readOnly: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.id,
    data: { type: "card", stageId: deal.stageId } satisfies CardDndData,
    disabled: readOnly,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  const daysSinceUpdate = Math.floor((Date.now() - new Date(deal.updatedAt).getTime()) / MS_PER_DAY);
  const rotten = stage.rotDays != null && daysSinceUpdate > stage.rotDays;
  const formattedValue = deal.valueCents != null
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: deal.currency }).format(deal.valueCents / 100)
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`card-${deal.id}`}
      className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{deal.title}</span>
        {rotten && (
          <span
            title={`No activity for ${daysSinceUpdate} days (stage rots after ${stage.rotDays})`}
            className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-500"
          />
        )}
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
    </div>
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
    const trimmedValue = value.trim();
    const valueCents = trimmedValue === "" ? undefined : Math.round(Number(trimmedValue) * 100);
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
