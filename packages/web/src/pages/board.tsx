import { useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Deal, Stage } from "@conduit/shared";
import { ApiError } from "../api";
import {
  useArchivePipeline, useCompanies, useCreateDeal, useCreateStage, useDeals, useMoveDeal, usePipeline,
  useUnarchivePipeline, useUpdateStage, useUsers,
} from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog, DialogContent, DialogTitle, DialogTrigger, SheetBody, SheetContent, SheetHeader,
} from "../components/ui/dialog";
import { Funnel } from "../components/funnel";
import {
  KanbanEmptyPlaceholder, kanbanSortableItems, useKanbanBoard, useKanbanCardSortable, useKanbanColumnDroppable,
} from "../components/kanban-core";
import { parseDecimal, userLabel } from "../lib";
import { useIsMobile } from "../use-is-mobile";
import { boardStageView, dealRot, stageValueLabel } from "./board-lib";

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
  // Mirrors company-detail.tsx's own bannerError/reportError pair -- until
  // now, this page's only mutations (drag/stage/deal edits) either had
  // nowhere useful to surface a failure or were already covered elsewhere;
  // archive/unarchive are the first board.tsx mutations whose failure the
  // user has no other way to notice (no optimistic UI to visibly snap back).
  const [bannerError, setBannerError] = useState<string | null>(null);

  const companyMap = useMemo(
    () => new Map((companiesData?.items ?? []).map((company) => [company.id, company.name])),
    [companiesData],
  );
  const userInitials = useMemo(
    () => new Map(users.map((user) => [user.id, userLabel(user, "").slice(0, 1).toUpperCase()])),
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

  const isMobile = useIsMobile();

  /**
   * WHICH STAGE THE PHONE IS LOOKING AT, AND WHY IT IS NOT IN THE URL.
   *
   * The inbox's equivalent state -- which conversation is open -- lives in
   * `?thread=`, and Task 3 leaned on that rather than shadowing it. That does
   * not transfer, and the reason is not merely that this route has no search
   * schema (one could be added in a line). It is that `?thread=<id>` MEANS THE
   * SAME THING AT BOTH WIDTHS: at a desk it selects the conversation in the
   * third pane, on a phone it selects the screen. A `?stage=` here would mean
   * something at one width and nothing at the other -- the desktop board shows
   * every stage at once and has nothing to do with it -- so the same URL would
   * describe two different screens depending on the window it was opened in,
   * and only one of the two would ever write it. A link is worth less than
   * that costs.
   *
   * WHAT IS GIVEN UP, deliberately and measurably. "Opening a card IS the
   * navigation" is not re-earned: tapping a card leaves for /deals/<id>, and
   * coming back re-mounts this page with the picker on the pipeline's first
   * stage rather than on the one that was being worked. That is a lost place
   * in a list, not a broken link, and it is the price of not inventing a URL
   * parameter that half the app disagrees about. Someone who finds it grating
   * in real use should say so -- the remedy is a search schema and this
   * paragraph rewritten, not a quiet second store of state.
   */
  const [chosenStageId, setChosenStageId] = useState<string | null>(null);

  /**
   * Where focus goes when a move unmounts the control that was focused -- the
   * same target and the same reasoning as pages/inbox.tsx's, so a phone user
   * meets one rule on both surfaces rather than two. See the stage view's own
   * comment for what makes the move a focus event at all.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * The phone's stage view: which stage is on screen, what the picker offers,
   * and where a card can go. Pure and tested as such -- pages/board-lib.ts
   * carries the reasoning, including why `stage === null` is exactly "render
   * the board that was always here".
   *
   * MEMOISED ON PURPOSE. `moveTargets` is an array, and the stage view hands
   * the same one to every card in the list; rebuilding it per render would
   * hand every card a fresh prop for nothing. Above the breakpoint the
   * function returns one shared frozen object, so the memo is inert there.
   */
  const stageView = useMemo(
    () => boardStageView({ isMobile, stages: pipelineData?.stages ?? [], chosenStageId, archived }),
    [isMobile, pipelineData, chosenStageId, archived],
  );

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

  // Mirrors company-detail.tsx's own reportError: ApiError.code is the
  // server's machine-readable `error` field, branched on so a stale-state
  // race (someone else archived/unarchived this pipeline in another tab a
  // moment ago) gets a specific, actionable message instead of the raw
  // "pipeline ... is archived" text.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This pipeline's archive state changed elsewhere. Reload the page.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  // Mirrors company-detail.tsx's handleArchive/handleUnarchive -- confirm,
  // then mutate. Archiving navigates back to the pipelines index (Phase
  // 3.1): there's nothing left worth looking at on a board that just went
  // read-only, unlike unarchiving, which stays put on the now-editable board.
  function handleArchivePipeline() {
    if (!window.confirm(`Archive ${pipeline.name}? The board becomes read-only until it's unarchived.`)) return;
    archivePipeline.mutate(pipelineId, { onSuccess: () => void navigate({ to: "/pipelines" }), onError: reportError });
  }
  function handleUnarchivePipeline() {
    unarchivePipeline.mutate(pipelineId, { onError: reportError });
  }

  /**
   * The phone's "Move to..." -- THE SAME MUTATION THE DRAG USES, deliberately.
   *
   * `useMoveDeal` is instantiated once on this page and both widths call it, so
   * the optimistic reposition, the rollback, the 409 refetch, the server's
   * position compaction and the SSE hint that follows are all the behaviour
   * they already were. A second path would have had to reproduce every one of
   * them and would have drifted from the first the day either changed.
   *
   * NEITHER NEIGHBOUR IS NAMED, which is moveDealInputSchema's "both omitted"
   * case: append at the tail of the target stage. That is the same landing spot
   * a desktop drag into a column's blank space produces, and it is the only
   * honest answer here -- the phone is not showing the target stage, so there
   * is no position in it the user could be said to have chosen.
   *
   * The per-call onError is additive: the mutation's own onError still rolls
   * the optimistic move back first. Without it a failure would be a card that
   * silently reappeared, which at a desk is at least visible as a snap-back
   * mid-gesture and on a phone is nothing at all.
   */
  function handleMoveDealToStage(deal: Deal, target: Stage) {
    moveDeal.mutate({ id: deal.id, pipelineId, stageId: target.id }, { onError: reportError });
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
      {bannerError && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          <span>{bannerError}</span>
          <button
            type="button"
            onClick={() => setBannerError(null)}
            className="ml-4 shrink-0 text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <Link to="/pipelines" className="text-xs font-medium text-slate-500 hover:text-slate-700">
            {"\u2190"} Pipelines
          </Link>
          {/* tabIndex only below the breakpoint, so the desktop heading keeps
              exactly the attributes it always had. -1 makes it a target for
              the stage view's post-move focus() without putting a heading into
              anyone's tab order. Same shape as pages/inbox.tsx's. */}
          <h1
            ref={headingRef}
            tabIndex={isMobile ? -1 : undefined}
            className="text-xl font-semibold text-slate-900"
          >
            {pipeline.name}
          </h1>
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

      {/* THE BRANCH, and the seam the inbox had to guard with a source reader
          is tied by the compiler here instead: StageView takes a NON-NULL
          stage, so inverting this test does not compile. `stage` is null for
          every input above the breakpoint (board-lib's DESKTOP_VIEW, pinned by
          a test over the cross-product), so the desktop reaches the same
          DndContext it always did, and the two are mutually exclusive IN THE
          DOM rather than one being hidden -- which matters beyond tidiness:
          pipeline.spec.ts counts `[data-testid^="column-"]` and looks up
          `card-<id>` at the page level, and a hidden second copy of either
          would be counted and would violate Playwright's strict mode. */}
      {view === "funnel" ? (
        <Funnel pipelineId={pipelineId} />
      ) : stageView.stage !== null ? (
        <StageView
          stage={stageView.stage}
          picker={stageView.picker}
          moveTargets={stageView.moveTargets}
          dealsByStage={grouped}
          companyMap={companyMap}
          userInitials={userInitials}
          pipelineId={pipelineId}
          archived={archived}
          headingRef={headingRef}
          onPick={setChosenStageId}
          onMove={handleMoveDealToStage}
        />
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
  // The mixed-currency rule this line used to carry inline now lives in
  // board-lib beside the stage view, which needed the same label. Same
  // computation, one copy, and a unit test on it.
  const formattedSum = stageValueLabel(deals);

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

/**
 * THE BOARD BELOW THE BREAKPOINT: one stage at a time.
 *
 * A kanban column is a horizontal thing and a phone has room for one, so this
 * is not the board re-laid-out -- it is the third and last of the three sites
 * the phase's spec allows a different INTERACTION MODEL. What replaces the drag
 * is "Move to...", which is what the gesture was for.
 *
 * NOTHING THE DESK CAN DO IS MISSING HERE, which is the phase's definition of
 * done and is the reason this component is longer than a list would need to be:
 * the picker reaches every stage, the header renames one and shows its count
 * and value, "New deal" creates in the stage on screen, "+ Stage" adds another,
 * a card opens its deal, and "Move" moves it. The only desktop gesture with no
 * phone equivalent is REORDERING WITHIN a stage, which is a position and not a
 * capability -- the server orders by position and the phone appends at the
 * tail, exactly as a drag into a column's blank space does.
 *
 * IT UNMOUNTS THE DESKTOP BOARD RATHER THAN HIDING IT, the opposite of what the
 * inbox stack chose, and the reason the two differ is worth stating so neither
 * looks like an oversight. The inbox hides because its panes hold accumulated
 * "Load more" pages and live query observers that an unmount would throw away.
 * Nothing here does: every card on this page is drawn from the ONE
 * useDeals(pipelineId) query the page itself owns, so an unmounted column
 * costs nothing to rebuild. And hiding would be actively wrong -- the desktop
 * journeys count `[data-testid^="column-"]` and address `card-<id>` at the page
 * level, and a display:none copy is still in the DOM to be counted.
 *
 * WHAT UNMOUNTING COSTS INSTEAD is a focus move, and it is paid below rather
 * than skipped: see the move handler.
 */
function StageView({
  stage,
  picker,
  moveTargets,
  dealsByStage,
  companyMap,
  userInitials,
  pipelineId,
  archived,
  headingRef,
  onPick,
  onMove,
}: {
  /** NON-NULL on purpose: this is what makes the page's branch a type error to
   * invert, rather than a phone-only defect nothing but an e2e run would see. */
  stage: Stage;
  picker: readonly Stage[];
  moveTargets: readonly Stage[];
  dealsByStage: Map<string, Deal[]>;
  companyMap: Map<string, string>;
  userInitials: Map<string, string>;
  pipelineId: string;
  archived: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onPick: (stageId: string) => void;
  onMove: (deal: Deal, target: Stage) => void;
}) {
  const [movingDealId, setMovingDealId] = useState<string | null>(null);
  const [moveResult, setMoveResult] = useState<string | null>(null);
  // Whether the sheet is closing because a move was made, rather than because
  // the user dismissed it -- read once by the close handler below.
  const movedRef = useRef(false);
  // The list of targets, so the sheet can open on the first of them rather than
  // on its own Close. See the sheet's onOpenAutoFocus.
  const targetsRef = useRef<HTMLDivElement>(null);
  // The Move button the sheet was opened from, so it can be given focus back.
  // Kept as the ELEMENT rather than an id because that is what the close
  // handler needs, and because `isConnected` on it answers the one question
  // that decides where focus goes -- see onCloseAutoFocus.
  const triggerRef = useRef<HTMLElement | null>(null);

  const deals = dealsByStage.get(stage.id) ?? [];
  // Resolved from the CURRENT list rather than held as an object, so a deal
  // that leaves this stage (a move, an SSE update, a win in another tab) takes
  // the sheet with it instead of stranding it over a card that is gone.
  const movingDeal = deals.find((deal) => deal.id === movingDealId) ?? null;

  function pickStage(stageId: string) {
    // The result line describes a move out of the stage being left; carrying it
    // to the next stage would read as a claim about that one.
    setMoveResult(null);
    onPick(stageId);
  }

  function requestMove(dealId: string, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setMovingDealId(dealId);
  }

  /**
   * THE MOVE, AND THE FOCUS IT COSTS.
   *
   * The card the user tapped Move on is in THIS stage and every target is
   * another one, so a successful move always unmounts the control focus would
   * otherwise return to. Dropping focus on <body> there is the same class of
   * defect this phase has now met four times (the search sheet opening on
   * Close, the task drawer's only exit, the inbox's drill-in), so the close
   * handler below sends it to the page's h1 instead -- the target
   * pages/inbox.tsx settled on, so the two phone surfaces do not disagree about
   * where focus goes when a screen changes under it.
   *
   * The h1 is not what ANNOUNCES the move -- it says the pipeline's name. The
   * live region does, which is why both exist. It is stated optimistically, as
   * the card's own disappearance is: the mutation rolls back and the page's
   * error banner speaks if the server refuses.
   */
  function handleMove(target: Stage) {
    if (movingDeal === null) return;
    onMove(movingDeal, target);
    setMoveResult(`Moved ${movingDeal.title} to ${target.name}.`);
    setMovingDealId(null);
    movedRef.current = true;
  }

  return (
    <div data-testid="stage-view" className="flex flex-col gap-3">
      {/* The picker scrolls rather than wrapping, so the strip is one line
          whatever a pipeline's stage count is, and each button carries its
          stage's deal count -- which is also the summary a phone loses by not
          seeing every column at once. shrink-0 on the buttons is what makes the
          container actually scrollable; without it a flex item is still free to
          be squeezed towards its min-content width (the same pairing
          ui/tabs.tsx documents for the record rail's strip). */}
      <div data-testid="stage-picker" className="flex gap-2 overflow-x-auto pb-1">
        {picker.map((option) => (
          <Button
            key={option.id}
            data-testid={`stage-pick-${option.id}`}
            variant={option.id === stage.id ? "default" : "outline"}
            aria-pressed={option.id === stage.id}
            onClick={() => pickStage(option.id)}
            className="shrink-0"
          >
            {option.name}
            <span className="ml-2 text-xs opacity-70">{(dealsByStage.get(option.id) ?? []).length}</span>
          </Button>
        ))}
      </div>

      {/* Always mounted, so a screen reader is watching the region before it
          fills -- components/mail/bulk-bar.tsx's BulkResult, same reasoning.
          Empty it has no line box and so no height; only the flex gap. */}
      <p data-testid="stage-move-result" role="status" aria-live="polite" className="text-xs text-slate-500">
        {moveResult}
      </p>

      <div className="flex flex-col gap-2 rounded-lg bg-slate-100 p-2">
        <StageHeader
          stage={stage}
          pipelineId={pipelineId}
          readOnly={archived}
          count={deals.length}
          valueLabel={stageValueLabel(deals)}
        />
        <div className="flex flex-col gap-2">
          {deals.map((deal) => (
            <StageDealCard
              key={deal.id}
              deal={deal}
              stage={stage}
              companyName={deal.companyId ? companyMap.get(deal.companyId) : undefined}
              ownerInitial={deal.ownerUserId ? userInitials.get(deal.ownerUserId) : undefined}
              // No targets means nowhere to go: an archived pipeline (read-only
              // at a desk too) or a pipeline with a single stage. A control
              // that could only fail is worse than no control.
              canMove={moveTargets.length > 0}
              onRequestMove={requestMove}
            />
          ))}
          {deals.length === 0 && (
            <p className="rounded-md border border-dashed border-slate-300 px-2 py-4 text-center text-xs text-slate-400">
              No deals
            </p>
          )}
        </div>
        {!archived && <NewDealButton pipelineId={pipelineId} stageId={stage.id} />}
      </div>

      {!archived && <AddStageTile pipelineId={pipelineId} />}

      {/* A bottom sheet, which ui/dialog.tsx's SHAPES table describes as the
          right shape for a short list of choices -- the page behind stays
          partly visible, so the card being moved is still there to look at. */}
      <Dialog
        open={movingDeal !== null}
        onOpenChange={(open) => {
          if (!open) setMovingDealId(null);
        }}
      >
        <SheetContent
          shape="bottom"
          data-testid="move-sheet"
          /* OPEN ON THE FIRST STAGE, not on Close. Radix focuses the first
             tabbable descendant, which is SheetHeader's Close -- a sheet whose
             whole purpose is picking a stage would announce "Close, button",
             the same defect Task 1 fixed for the search sheet and the reason
             ui/dialog.tsx forwards this hatch at all. (Marking the first target
             `autoFocus` is the other idiom that file names, and it works too;
             this one says what it means and does not depend on React's commit
             order relative to Radix's FocusScope.) */
          onOpenAutoFocus={(event) => {
            const first = targetsRef.current?.querySelector<HTMLButtonElement>("button");
            if (first == null) return;
            event.preventDefault();
            first.focus();
          }}
          /* BOTH EXITS ARE HANDLED HERE, because Radix handles NEITHER for a
             dialog opened the way this one is.

             Measured rather than assumed: dismissing this sheet with Close --
             no move, the trigger still in the DOM and still focusable -- left
             `document.activeElement` on <body>. The cause is that
             DialogContentModal's own onCloseAutoFocus focuses
             `context.triggerRef.current`, which is set by <DialogTrigger>; this
             sheet is one page-level dialog driven by state, because the trigger
             is a different button on every card, so that ref is null and Radix
             focuses nothing at all. Every state-driven Dialog in this app has
             the same hole -- the composer, the task drawer and the two settings
             dialogs -- which is pre-existing and desktop-visible, so it is a
             finding rather than something to fix from this page.

             So: the trigger back on a dismissal, the heading after a move (when
             the trigger has gone with its card). `isConnected` is the test
             rather than the flag alone, because an SSE update or another tab
             can retire that card while the sheet is open. */
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const moved = movedRef.current;
            movedRef.current = false;
            const trigger = triggerRef.current;
            triggerRef.current = null;
            if (!moved && trigger !== null && trigger.isConnected) trigger.focus();
            else headingRef.current?.focus();
          }}
        >
          <SheetHeader
            title={movingDeal === null ? "Move" : `Move ${movingDeal.title}`}
            closeTestId="move-sheet-close"
          />
          <SheetBody>
            <div ref={targetsRef} className="flex flex-col gap-2">
              {moveTargets.map((target) => (
                <Button
                  key={target.id}
                  data-testid={`move-to-${target.id}`}
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleMove(target)}
                >
                  {target.name}
                </Button>
              ))}
            </div>
          </SheetBody>
        </SheetContent>
      </Dialog>
    </div>
  );
}

/**
 * A deal on the phone's stage list: the same card content the desktop draws,
 * with the tap target and the Move action a column card does not need.
 *
 * TWO CONTROLS, NOT ONE. The desktop card is a single click target because a
 * drag and a click are told apart by movement; here "open it" and "move it" are
 * two taps in the same place, so they are two elements. The body is the button
 * rather than the wrapper so the Move control is not nested inside it.
 */
function StageDealCard({
  deal,
  stage,
  companyName,
  ownerInitial,
  canMove,
  onRequestMove,
}: {
  deal: Deal;
  stage: Stage;
  companyName?: string;
  ownerInitial?: string;
  canMove: boolean;
  onRequestMove: (dealId: string, trigger: HTMLElement) => void;
}) {
  const navigate = useNavigate();
  const rot = dealRot(deal.updatedAt, stage.rotDays, Date.now());

  return (
    <div
      // The SAME testid the desktop card carries. The two are mutually
      // exclusive in the DOM (see the page's branch), so this is one element at
      // either width and a journey addressing a card need not know which half
      // of the app it is in.
      data-testid={`card-${deal.id}`}
      className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
    >
      <button
        type="button"
        onClick={() => void navigate({ to: "/deals/$dealId", params: { dealId: deal.id } })}
        className="flex min-h-11 min-w-0 flex-1 flex-col gap-1 text-left"
      >
        <DealCardContent
          deal={deal}
          companyName={companyName}
          ownerInitial={ownerInitial}
          rotten={rot.rotten}
          rotTitle={rot.title}
        />
      </button>
      {canMove && (
        <Button
          data-testid={`move-${deal.id}`}
          variant="outline"
          // A list of buttons all reading "Move, button" says nothing about
          // which card each belongs to. The visible word stays the first word
          // of the accessible name, so a voice-control user saying "Move" still
          // matches (WCAG's label-in-name).
          aria-label={`Move ${deal.title}`}
          className="shrink-0"
          onClick={(event) => onRequestMove(deal.id, event.currentTarget)}
        >
          Move
        </Button>
      )}
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

  // Same rule, same strings as before -- moved to board-lib because the phone's
  // card needs the identical marker and a second copy would drift.
  const rot = dealRot(deal.updatedAt, stage.rotDays, Date.now());

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
      <DealCardContent deal={deal} companyName={companyName} ownerInitial={ownerInitial} rotten={rot.rotten} rotTitle={rot.title} />
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
          // Renaming a stage is a capability, and below the breakpoint this
          // 20px-tall button is the only way to reach it -- measured at 303 x 20
          // in the stage view, under the phase's 44px floor. The phone form is a
          // centring flex row rather than a bare min-height, or the label would
          // sit pinned to the top of a taller box (ui/select.tsx's SelectItem,
          // same shape). `max-md:` only: the desktop column header keeps the
          // dense row it has had since Phase 2.
          className="block w-full truncate text-left text-sm font-semibold text-slate-900 disabled:cursor-default max-md:flex max-md:min-h-11 max-md:items-center"
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

  // The `max-md:` widths are for the phone's stage view, where this is a row at
  // the foot of the page rather than a tile at the end of a row of columns. The
  // desktop board does not render below the breakpoint at all (see the page's
  // branch), so they are the stage view's rule wherever they are written.
  if (!adding) {
    return (
      <div className="w-72 shrink-0 max-md:w-full">
        <Button variant="outline" onClick={() => setAdding(true)}>
          {"+"} Stage
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-slate-100 p-2 max-md:w-full">
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
