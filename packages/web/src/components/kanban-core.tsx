import { useRef, useState } from "react";
import type { RefObject } from "react";
import {
  DndContext, KeyboardCode, KeyboardSensor, MeasuringStrategy, PointerSensor, closestCenter,
  closestCorners, getFirstCollision, getScrollableAncestors, rectIntersection, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent, DroppableContainer, KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { arrayMove, hasSortableData, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * Generic kanban drag-and-drop core, extracted from pages/board.tsx (the
 * deals pipeline board, Phase 2) so pages/task-board.tsx (the per-project
 * task board, Phase 3 P3.7) can reuse the exact same hard-won machinery
 * instead of a second, subtly-diverging copy. Every piece below is
 * column/card-content agnostic: it only knows about a "column id" and an
 * "item id" string, never a stage/deal or a status/task specifically. The
 * board-specific parts (what a card looks like, what a column header shows,
 * which mutation onMove actually calls) stay in each page.
 *
 * Provenance: the collision detection, measuring strategy, keyboard
 * coordinate getter and onDragEnd neighbour-derivation below were each
 * hardened against a REAL bug found during Phase 2's pipeline board work
 * (P2.9's keyboard-drag Playwright journey and its follow-up review) -- see
 * each piece's own doc comment for the specific failure it fixes. Do not
 * "simplify" any of this without first reproducing the failure it guards
 * against; the comments are deliberately detailed so a future reader can
 * check that before touching it.
 */

export interface KanbanCardData { type: "card"; columnId: string }
export interface KanbanPlaceholderData { type: "placeholder"; columnId: string }
export interface KanbanColumnData { type: "column"; columnId: string }
export type KanbanDndData = KanbanCardData | KanbanPlaceholderData | KanbanColumnData;

/**
 * Every card sits inside BOTH its own sortable droppable AND its column's
 * wrapping useDroppable (added so pointer users can drop into blank space
 * below the last card, appending at the tail -- see useKanbanColumnDroppable
 * below). That containment relationship breaks a KEYBOARD drag under the
 * stock closestCenter algorithm two different ways (a pointer drag hits
 * neither -- the first pixel of movement already breaks any tie):
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
 * (kanbanKeyboardCoordinateGetter) snaps the ghost's rect to align with the
 * target card/placeholder on every arrow press, so afterwards the ghost
 * overlaps that one small card almost completely (ratio near 1) while only
 * covering a tiny fraction of the much larger enclosing column (ratio near
 * 0) -- the card wins outright without ever comparing centers. This also
 * preserves the pointer blank-space-drop case: a point that overlaps no
 * card at all still overlaps the column, so `over` still resolves to the
 * column there and onDragEnd's existing tail-append branch still fires.
 * closestCenter is kept as a fallback for the one case rectIntersection
 * can't answer -- nothing at all under the ghost -- which should not arise
 * on a well-formed board (every column always has either cards or its
 * empty-column placeholder) but is defensive rather than load-bearing.
 */
export const kanbanCollisionDetection: CollisionDetection = (args) => {
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
 * e2e/pipeline.spec.ts's keyboard-drag steps do) can complete all three key
 * events before that effect ever runs, leaving no measured rects for
 * anything but the origin card's own column. BeforeDragging instead
 * measures continuously while AT REST (so by the time any drag starts,
 * rects are already current -- no "wait for dragging to start" gate to
 * lose the race against) and freezes them for the duration of the drag
 * itself, which is cheaper than Always (no per-arrow-press remeasuring)
 * and correct here because nothing on a kanban board actually moves or
 * resizes mid-drag (no onDragOver-driven reflow -- see useKanbanBoard's
 * handleDragEnd).
 */
export const kanbanMeasuring = { droppable: { strategy: MeasuringStrategy.BeforeDragging } };

/**
 * Reimplements @dnd-kit/sortable's sortableKeyboardCoordinates (MIT) for all
 * four arrow keys, with two kanban-specific changes -- each guarding a REAL
 * failure; the body otherwise mirrors the stock function faithfully:
 *
 * 1. ArrowUp/ArrowDown only consider candidates in the SAME sortable
 *    container (i.e. the same column) as the active card. The stock Up/Down
 *    direction filter only checks vertical position (collisionRect.top vs a
 *    candidate's rect.top) -- it has no notion of which column a candidate
 *    belongs to. The empty-column placeholder that makes an empty column
 *    reachable via ArrowLeft/ArrowRight (see useKanbanColumnDroppable/
 *    KanbanEmptyPlaceholder below) is ALSO a valid "sortable" candidate by
 *    that rule, and a neighbouring column's placeholder can end up
 *    geometrically CLOSER by dnd-kit's own closestCorners ranking than the
 *    intended same-column sibling directly below/above the active card --
 *    sending an ArrowDown/ArrowUp press into a different column's empty
 *    placeholder instead of reordering within the current one. Confirmed by
 *    instrumenting moveDeal's inputs during the original (Phase 2)
 *    investigation: a same-column ArrowDown press resolved to a DIFFERENT
 *    column's placeholder id, moving the dragged deal out of its own column
 *    entirely instead of past its sibling.
 *
 * 2. ArrowLeft/ArrowRight scroll the chosen target into view before
 *    returning its coordinates. The stock getter picks the right target even
 *    when its column sits outside the board's visible area (droppable rects
 *    exist for off-screen nodes too), but KeyboardSensor then REFUSES the
 *    move: when the returned coordinates fall outside a scrollable
 *    ancestor's visible rect it never calls handleMove at all -- it fires
 *    scrollContainer.scrollTo({ behavior: "smooth" }) and returns, betting
 *    that the resulting async scroll events will walk `over` onto the target
 *    by themselves. A real user pressing slowly gets away with that; a
 *    scripted Space/Arrow/Space (or a fast typist) drops before the smooth
 *    scroll ever lands, so the card silently falls back onto its origin
 *    column -- reproduced 2/2 in CI runs 32271110864/32272013870 (the tasks
 *    journey under Playwright's default 1280px viewport, where Done starts
 *    off-screen; see e2e/tasks.spec.ts's off-screen-columns regression).
 *    scrollIntoView here is synchronous and instant (block/inline "nearest"
 *    makes it a no-op when the target is already visible), and the rects in
 *    droppableRects are dnd-kit Rect instances whose left/top getters
 *    live-compensate for ancestor scroll -- so reading them AFTER the scroll
 *    yields the target's current viewport position, the sensor's
 *    visible-rect check now passes, and the move commits inside this same
 *    keydown with nothing async left to race the drop. Horizontal candidates
 *    keep the stock geometry-only filter (no same-container restriction --
 *    Left/Right IS the cross-column gesture, and same-column candidates all
 *    share the active card's left edge so the strict inequality already
 *    excludes them); by the same token the stock same-container size offset
 *    is always zero here, so the horizontal branch returns the rect's
 *    top-left directly.
 *
 * Reimplemented in full (rather than filtering context.droppableContainers
 * down and delegating to sortableKeyboardCoordinates) because that function
 * calls `.getEnabled()` on context.droppableContainers, a method on
 * dnd-kit's own DroppableContainersMap class that a plain filtered array
 * does not have.
 */
export const kanbanKeyboardCoordinateGetter: KeyboardCoordinateGetter = (event, args) => {
  const verticalCodes: string[] = [KeyboardCode.Down, KeyboardCode.Up];
  const horizontalCodes: string[] = [KeyboardCode.Left, KeyboardCode.Right];
  const isVertical = verticalCodes.includes(event.code);
  if (!isVertical && !horizontalCodes.includes(event.code)) return undefined;
  // Mirrors the stock getter: direction keys are consumed by the drag even
  // when no move results, never left to scroll the page natively mid-drag.
  event.preventDefault();

  const { active, context } = args;
  const { collisionRect, droppableRects, droppableContainers, over, scrollableAncestors } = context;
  if (!collisionRect) return undefined;

  const activeContainer = droppableContainers.get(active);
  const activeContainerId = activeContainer && hasSortableData(activeContainer)
    ? activeContainer.data.current.sortable.containerId
    : undefined;

  const filteredContainers: DroppableContainer[] = [];
  for (const entry of droppableContainers.getEnabled()) {
    if (!entry || entry.disabled) continue;
    const rect = droppableRects.get(entry.id);
    if (!rect) continue;
    if (isVertical) {
      // Change 1: same-column candidates only for Up/Down.
      if (!hasSortableData(entry) || entry.data.current.sortable.containerId !== activeContainerId) continue;
      if (event.code === KeyboardCode.Down ? collisionRect.top < rect.top : collisionRect.top > rect.top) {
        filteredContainers.push(entry);
      }
    } else if (event.code === KeyboardCode.Right ? collisionRect.left < rect.left : collisionRect.left > rect.left) {
      filteredContainers.push(entry);
    }
  }

  const collisions = closestCorners({
    active: { id: active } as never, collisionRect, droppableRects,
    droppableContainers: filteredContainers, pointerCoordinates: null,
  });
  let closestId = getFirstCollision(collisions, "id");
  if (closestId === over?.id && collisions.length > 1) closestId = collisions[1]?.id ?? null;
  if (closestId == null) return undefined;

  const newDroppable = droppableContainers.get(closestId);
  const newRect = newDroppable ? droppableRects.get(newDroppable.id) : null;
  const newNode = newDroppable?.node.current;
  if (!newNode || !newRect || !activeContainer || !newDroppable) return undefined;

  if (!isVertical) {
    // Change 2: bring an off-screen target column into view NOW, so the
    // sensor's visible-rect check can't veto the move -- and only read the
    // (live, scroll-compensated) rect afterwards. No-op when already
    // visible.
    newNode.scrollIntoView({ block: "nearest", inline: "nearest" });
    return { x: newRect.left, y: newRect.top };
  }

  const newScrollAncestors = getScrollableAncestors(newNode);
  const hasDifferentScrollAncestors = newScrollAncestors.some((el, i) => scrollableAncestors[i] !== el);
  // Same-container by construction here (the filter above already enforces
  // it), so the vertical offset always applies -- unlike
  // sortableKeyboardCoordinates' general version, this branch never needs
  // to handle a cross-container Up/Down case.
  const isAfterActive = hasSortableData(activeContainer) && hasSortableData(newDroppable)
    && activeContainer.data.current.sortable.index < newDroppable.data.current.sortable.index;
  const offsetY = hasDifferentScrollAncestors ? 0 : (isAfterActive ? collisionRect.height - newRect.height : 0);
  return { x: newRect.left, y: newRect.top - offsetY };
};

/** An empty column has no card to register as a sortable item, so nothing
 * for the keyboard sensor's coordinateGetter to land on (it only considers
 * sortable-registered rects, not plain droppables) -- falling back to the
 * column's own id as the sole sortable item (see KanbanEmptyPlaceholder
 * below, which registers under that same id) keeps an empty column
 * reachable by keyboard, the same way a card in it would be. */
export function kanbanSortableItems(columnId: string, itemIds: string[]): string[] {
  return itemIds.length > 0 ? itemIds : [columnId];
}

/** Wraps a column's droppable registration -- added alongside each card's own
 * sortable so a pointer user can drop into blank space below the last card
 * (or anywhere in an otherwise-empty column) and still append at the tail,
 * not just when hovering an existing card. `disabled` mirrors a read-only
 * board (e.g. an archived pipeline). */
export function useKanbanColumnDroppable(columnId: string, disabled = false) {
  return useDroppable({
    id: `column:${columnId}`,
    data: { type: "column", columnId } satisfies KanbanColumnData,
    disabled,
  });
}

export function KanbanEmptyPlaceholder({ columnId, label }: { columnId: string; label: string }) {
  const { setNodeRef } = useSortable({
    id: columnId,
    data: { type: "placeholder", columnId } satisfies KanbanPlaceholderData,
  });
  return (
    <div ref={setNodeRef} className="rounded-md border border-dashed border-slate-300 px-2 py-4 text-center text-xs text-slate-400">
      {label}
    </div>
  );
}

/** A card's own sortable registration plus the transform/transition/opacity
 * style every dragged card needs -- shared by DealCard (board.tsx) and
 * TaskCard (task-board.tsx) so both stay pixel-identical in drag feel. */
export function useKanbanCardSortable(id: string, columnId: string, disabled = false) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: "card", columnId } satisfies KanbanCardData,
    disabled,
  });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return { attributes, listeners, setNodeRef, style, isDragging };
}

export interface KanbanMoveParams {
  id: string;
  columnId: string;
  beforeId?: string;
  afterId?: string;
}

export interface UseKanbanBoardOptions {
  /** Ordered item ids per column, as currently rendered -- e.g. board.tsx's
   * `grouped` (Deal[] per stage) mapped down to just ids. Read fresh on
   * every drag end, never cached across renders by this hook. */
  itemsByColumn: Map<string, string[]>;
  /** Called with the neighbours the moved item should land BETWEEN in its
   * target column -- see moveDealInputSchema/moveTaskOnBoardInputSchema's
   * shared "neighbours, not an insertion target" semantics in
   * @conduit/shared. Not called at all for a same-slot no-op drop. */
  onMove: (params: KanbanMoveParams) => void;
  /** True makes the whole board read-only (e.g. an archived pipeline) --
   * mirrors board.tsx's own `archived` flag: an empty sensor list is the
   * simplest way to disable every drag gesture without branching the
   * column/card JSX into two shapes. */
  disabled?: boolean;
}

export interface UseKanbanBoardResult {
  activeId: string | null;
  suppressCardClickRef: RefObject<boolean>;
  sensors: ReturnType<typeof useSensors>;
  dndProps: {
    collisionDetection: CollisionDetection;
    measuring: typeof kanbanMeasuring;
    onDragStart: (event: DragStartEvent) => void;
    onDragOver: (event: DragOverEvent) => void;
    onDragCancel: () => void;
    onDragEnd: (event: DragEndEvent) => void;
  };
}

/**
 * Owns the whole drag lifecycle (lift, over-tracking, drop, neighbour
 * derivation) for one kanban board. The calling page supplies the current
 * column/item layout and an onMove callback; this hook never calls a
 * mutation itself, so board.tsx and task-board.tsx each wire their own
 * (useMoveDeal vs. useBoardMoveTask) without this file needing to know
 * either exists.
 */
export function useKanbanBoard({ itemsByColumn, onMove, disabled = false }: UseKanbanBoardOptions): UseKanbanBoardResult {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Cards navigate to a detail page on click (see each page's own Card
  // component), but dnd-kit's own drag lifecycle must win when the user is
  // actually dragging, not clicking. PointerSensor's activationConstraint
  // below means a plain click (no pointer movement past 4px) never starts a
  // drag at all -- this ref only needs to guard the OTHER direction: a real
  // drag's mouseup can still fire a native "click" event afterward
  // (on whichever card happens to be under the pointer at drop time, which
  // is not necessarily the dragged card itself, since dnd-kit's live
  // reordering can shift a different card under it). handleDragStart only
  // ever fires once that 4px threshold is exceeded, so reaching it at all
  // already proves a genuine drag, not a click -- setting the flag there and
  // clearing it on a macrotask (after the synchronous click that follows the
  // same mouseup) suppresses that spurious click regardless of which card's
  // onClick ends up receiving it.
  const suppressCardClickRef = useRef(false);

  /**
   * dnd-kit's onDragEnd event carries `over` read from an internal ref
   * (sensorContext.current) that is only synced from React state via a
   * layout effect -- and that state is itself only set by a SEPARATE,
   * later-firing passive effect (the one that also fires onDragOver),
   * which only runs after the render that first computed the new position
   * has already committed. A keyboard drag's final "drop" keydown can
   * arrive (and dnd-kit's raw, non-React keydown listener processes it
   * synchronously) before that second render has happened, so
   * event.over on onDragEnd can reflect an ArrowRight-old position even
   * though onDragOver already fired with the correct one moments earlier.
   * onDragOver's own event object, by contrast, is built fresh from local
   * variables at the point it fires (not read back off that lagging ref),
   * so it is never subject to this gap. Tracking its value here and
   * preferring it in handleDragEnd sidesteps the race instead of trying to
   * win it.
   */
  const lastOverRef = useRef<{ id: string; data: KanbanDndData | undefined } | null>(null);

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: kanbanKeyboardCoordinateGetter });
  // Empty sensor list means no pointer/keyboard gesture can ever activate a
  // drag -- the simplest way to make the whole board read-only without
  // branching the JSX below into two shapes.
  const sensors = useSensors(...(disabled ? [] : [pointerSensor, keyboardSensor]));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    suppressCardClickRef.current = true;
    lastOverRef.current = null;
  }

  // See lastOverRef's doc comment: this is the freshest signal available
  // for "what is the drag currently over," captured as it happens rather
  // than read back later off a ref that can still be one render behind.
  function handleDragOver(event: DragOverEvent) {
    lastOverRef.current = event.over === null
      ? null
      : { id: String(event.over.id), data: event.over.data.current as KanbanDndData | undefined };
  }

  // dnd-kit calls onDragCancel instead of onDragEnd when a drag is aborted
  // (e.g. Escape mid-drag) -- without this, both activeId and
  // suppressCardClickRef would stay stuck from handleDragStart above,
  // leaving the DragOverlay showing a phantom card and the next plain click
  // silently swallowed.
  function handleDragCancel() {
    setActiveId(null);
    suppressCardClickRef.current = false;
    lastOverRef.current = null;
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    // See suppressCardClickRef's doc comment above for why this is a
    // macrotask reset rather than immediate: the drop gesture's native click
    // event (if any) dispatches synchronously, ahead of a setTimeout(0)
    // queued from here, so it still observes the flag as true.
    setTimeout(() => { suppressCardClickRef.current = false; }, 0);
    const { active } = event;
    // Prefer the last onDragOver-reported target over event.over -- see
    // lastOverRef's doc comment for why event.over can still be one render
    // behind it at drop time. Falls back to event.over for the (rarer) case
    // where the drag was dropped without ever moving (over never changed
    // from wherever it resolved to at lift, so onDragOver never fired).
    const over = lastOverRef.current ?? (event.over === null
      ? null
      : { id: String(event.over.id), data: event.over.data.current as KanbanDndData | undefined });
    lastOverRef.current = null;
    if (over === null || active.id === over.id) return;
    const activeData = active.data.current as KanbanDndData | undefined;
    const overData = over.data;
    if (activeData === undefined || activeData.type !== "card" || overData === undefined) return;

    const targetColumnId = overData.columnId;
    const activeItemId = String(active.id);
    const overId = over.id;

    let beforeId: string | undefined;
    let afterId: string | undefined;

    if (activeData.columnId === targetColumnId) {
      // Same-column reorder. Neighbours must be read off the same
      // reordering the user SAW, not derived from over's index in
      // isolation: dnd-kit's own drop preview follows
      // arrayMove(activeIndex, overIndex), which places a downward-dragged
      // card AFTER the card it's dropped on and an upward-dragged card
      // BEFORE it. Deriving insertAt from over's index alone (an earlier
      // version of this code, back on the deals board) reproduces only the
      // upward case -- column [A,B,C,D], dragging A onto C previews
      // [B,C,A,D] (A lands after C), but indexing on over's position in the
      // active-filtered array yields beforeId=B/afterId=C, landing A one
      // slot early, before C instead of after it. Running the SAME
      // arrayMove the preview uses and reading A's neighbours off the
      // result keeps this in sync with what was on screen for both
      // directions.
      const ids = itemsByColumn.get(targetColumnId) ?? [];
      const fromIndex = ids.indexOf(activeItemId);
      const toIndex = overData.type === "card" ? ids.indexOf(overId) : ids.length - 1;
      if (fromIndex === -1 || toIndex === -1) return;

      const reordered = arrayMove(ids, fromIndex, toIndex);
      const at = reordered.indexOf(activeItemId);
      beforeId = at > 0 ? reordered[at - 1] : undefined;
      afterId = at < reordered.length - 1 ? reordered[at + 1] : undefined;

      // Drop-in-place is a no-op: skip the callback entirely when the
      // computed neighbours match the ones the item already had before the
      // drag started (e.g. picked up and released without changing slot).
      const originalBefore = fromIndex > 0 ? ids[fromIndex - 1] : undefined;
      const originalAfter = fromIndex < ids.length - 1 ? ids[fromIndex + 1] : undefined;
      if (beforeId === originalBefore && afterId === originalAfter) return;
    } else {
      // Cross-column: the active item isn't in the target column's list yet,
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
      // appends at the tail, mirroring the append semantics every board's
      // create action already uses.
      const targetIds = itemsByColumn.get(targetColumnId) ?? [];
      let insertAt = targetIds.length;
      if (overData.type === "card") {
        const idx = targetIds.indexOf(overId);
        if (idx !== -1) insertAt = idx;
      }
      beforeId = insertAt > 0 ? targetIds[insertAt - 1] : undefined;
      afterId = insertAt < targetIds.length ? targetIds[insertAt] : undefined;
    }

    onMove({ id: activeItemId, columnId: targetColumnId, beforeId, afterId });
  }

  return {
    activeId,
    suppressCardClickRef,
    sensors,
    dndProps: {
      collisionDetection: kanbanCollisionDetection,
      measuring: kanbanMeasuring,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragCancel: handleDragCancel,
      onDragEnd: handleDragEnd,
    },
  };
}

// Re-exported so a page that needs the raw DndContext/component (board.tsx,
// task-board.tsx) doesn't have to import @dnd-kit/core a second time just
// for the wrapper component itself.
export { DndContext };
