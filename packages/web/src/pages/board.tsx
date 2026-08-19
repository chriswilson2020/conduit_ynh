import { useMemo, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Deal, Stage } from "@conduit/shared";
import {
  useArchivePipeline, useCompanies, useCreateDeal, useCreateStage, useDeals, useMoveDeal, usePipeline,
  useUnarchivePipeline, useUpdateStage, useUsers,
} from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Funnel } from "../components/funnel";
import {
  KanbanEmptyPlaceholder, kanbanSortableItems, useKanbanBoard, useKanbanCardSortable, useKanbanColumnDroppable,
} from "../components/kanban-core";
import { parseDecimal } from "../lib";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function BoardPage() {
  const navigate = useNavigate();
  const { pipelineId } = useParams({ from: "/pipelines/$pipelineId" });
  const { data: pipelineData, isLoading } = usePipeline(pipelineId);
  const { data: dealsData } = useDeals(pipelineId);
  // Same limit-100 lookup tradeoff as ContactsPage's companyMap.
  const { data: companiesData } = useCompanies({ limit: 100 });
  const { data: users = [] } = useUsers();
  const moveDeal = useMoveDeal();
  const archivePipeline = useArchivePipeline();
  const unarchivePipeline = useUnarchivePipeline();

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

  // Ids-only projection of `grouped`, the shape kanban-core's drag machinery
  // needs (it never sees a Deal, only ids) -- see useKanbanBoard's own doc
  // comment on itemsByColumn.
  const itemsByColumn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [stageId, deals] of grouped) map.set(stageId, deals.map((deal) => deal.id));
    return map;
  }, [grouped]);

  // Board stays the default view (matches every existing board.spec.ts
  // Playwright assertion, which locates cards/columns without first
  // switching views) -- Funnel is opt-in per page load, not persisted.
  const [view, setView] = useState<"board" | "funnel">("board");

  const archived = pipelineData !== undefined && pipelineData.pipeline.archivedAt !== null;

  const { activeId, suppressCardClickRef, sensors, dndProps } = useKanbanBoard({
    itemsByColumn,
    onMove: (params) => {
      moveDeal.mutate({
        id: params.id, pipelineId, stageId: params.columnId, beforeDealId: params.beforeId, afterDealId: params.afterId,
      });
    },
    disabled: archived,
  });
  const activeDeal = activeId !== null ? (openDeals.find((deal) => deal.id === activeId) ?? null) : null;

  if (isLoading) return <p>Loading...</p>;
  if (!pipelineData) return null;

  const { pipeline, stages } = pipelineData;

  // Mirrors company-detail.tsx's handleArchive/handleUnarchive -- confirm,
  // then mutate. Archiving navigates back to the pipelines index (Phase
  // 3.1): there's nothing left worth looking at on a board that just went
  // read-only, unlike unarchiving, which stays put on the now-editable board.
  function handleArchivePipeline() {
    if (!window.confirm(`Archive ${pipeline.name}? The board becomes read-only until it's unarchived.`)) return;
    archivePipeline.mutate(pipelineId, { onSuccess: () => void navigate({ to: "/pipelines" }) });
  }
  function handleUnarchivePipeline() {
    unarchivePipeline.mutate(pipelineId);
  }

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
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link to="/pipelines" className="text-xs font-medium text-slate-500 hover:text-slate-700">
            {"\u2190"} Pipelines
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">{pipeline.name}</h1>
        </div>
        {!archived && (
          <Button data-testid="archive-pipeline-button" variant="danger" onClick={handleArchivePipeline}>
            Archive pipeline
          </Button>
        )}
      </div>

      {archived && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span>This pipeline is archived. The board is read-only.</span>
          <Button data-testid="unarchive-pipeline-button" variant="outline" onClick={handleUnarchivePipeline}>
            Unarchive
          </Button>
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
        <DndContext sensors={sensors} {...dndProps}>
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
  const { setNodeRef } = useKanbanColumnDroppable(stage.id, readOnly);
  const dealIds = deals.map((deal) => deal.id);
  const sortableItems = kanbanSortableItems(stage.id, dealIds);
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
          {deals.length === 0 && <KanbanEmptyPlaceholder columnId={stage.id} label="No deals" />}
        </SortableContext>
      </div>
      {!readOnly && <NewDealButton pipelineId={pipelineId} stageId={stage.id} />}
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
  const { attributes, listeners, setNodeRef, style } = useKanbanCardSortable(deal.id, deal.stageId, readOnly);

  const daysSinceUpdate = Math.floor((Date.now() - new Date(deal.updatedAt).getTime()) / MS_PER_DAY);
  const rotten = stage.rotDays != null && daysSinceUpdate > stage.rotDays;
  const rotTitle = `No activity for ${daysSinceUpdate} days (stage rots after ${stage.rotDays} days)`;

  // Cards navigate to the deal detail page on a plain click. See
  // suppressCardClickRef's doc comment in kanban-core's useKanbanBoard for
  // why the flag it checks is enough to tell a click apart from a
  // drag-and-drop's trailing click, without this card needing to know
  // whether IT was the one dragged.
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
