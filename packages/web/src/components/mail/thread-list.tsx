import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import type { MailThreadListItem } from "@conduit/shared";
import {
  advanceCursorPages,
  cursorForKey,
  emptyCursorPages,
  flattenCursorPages,
  identityKey,
  refreshCursorRows,
  relativeTime,
  takeCursorPage,
  type CursorPages,
} from "../../lib";
import {
  useCompany,
  useContact,
  useDeal,
  useMailAccounts,
  useMailThreads,
  useProject,
  type MailThreadListParams,
} from "../../queries";
import { useLatest } from "../../hooks";
import {
  addressLabel, hiddenChipLabel, newMailLabel, pendingArrivals, subjectLabel,
} from "./mail-lib";
import { Button } from "../ui/button";

/**
 * Which threads to list. Exactly the query-side filters the route accepts
 * (queries.ts's MailThreadListParams) minus the paging pair, which this
 * component owns -- see the accumulation below.
 */
export type ThreadListFilters = Omit<MailThreadListParams, "cursor" | "limit">;

/** What a row's checkbox reports: the row, and whether the click was a
 * shift-click, plus the VISIBLE ROW ORDER a shift-range would run over. The
 * order rides on the event because only this component knows it -- see the
 * ref below for why it does not travel as a prop. */
export interface ThreadToggle {
  shift: boolean;
  order: readonly string[];
}

/** One visible row as onRowsChange reports it: the id, plus the one per-row
 * fact the caller's bulk bar needs (Phase 4.2's move-rights gating) -- a pair
 * rather than the whole MailThreadListItem, so the caller's
 * reference-equality guard has exactly two fields to compare and a refetch
 * that changed neither does not ripple a new array upward. */
export interface ThreadRowInfo {
  id: string;
  ownedByViewer: boolean;
}

export interface ThreadListProps {
  filters: ThreadListFilters;
  onSelect: (threadId: string) => void;
  selectedId?: string | null;
  /** Page size; the route's own default is used when omitted. */
  limit?: number;
  /** A node, not just a string: the inbox's empty state links at Settings
   * when there is no mail account to have received anything yet. */
  emptyLabel?: ReactNode;
  /**
   * Multi-select, off unless a caller opts in (the inbox does; a record page's
   * Mail tab has no bulk bar to act on a selection).
   *
   * The SELECTION ITSELF lives in the caller -- the bulk bar is its sibling, not
   * this component's child -- and mail-lib owns the rules. All this does is
   * render ticks and report clicks.
   */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleThread?: (threadId: string, toggle: ThreadToggle) => void;
  onToggleAll?: (order: readonly string[]) => void;
  /** Whether the header checkbox reads as ticked; the caller decides, since it
   * holds the selection (mail-lib's allOnPageSelected). */
  allSelected?: boolean;
  /** Some rows ticked, but not all of them: the header box renders
   * INDETERMINATE rather than picking one of the two lies. */
  someSelected?: boolean;
  /**
   * Freezes the ticks while the caller is acting on them (the inbox's bulk
   * request). The rows stay readable and the conversation still opens -- only
   * the selection is held still, because the request that is in flight names
   * the ids that were selected when it was sent.
   */
  selectionDisabled?: boolean;
  /** The visible rows, in order, whenever they change -- so the caller can turn
   * its selection into a request (and gate its move buttons on each row's
   * ownership) without duplicating the accumulator. */
  onRowsChange?: (rows: ThreadRowInfo[]) => void;
  /**
   * Bump this to make the list take a NEW SNAPSHOT: fetch page one afresh and
   * start the accumulation over from it.
   *
   * The caller's own writes are what this is for (Phase 4.4 Task 3). The list
   * holds still under mail arriving from elsewhere -- see the header comment --
   * and a write the reader themselves made is the opposite case: they trashed
   * ten conversations and those rows must go. The number is a nonce; only the
   * fact that it CHANGED is read, so a caller may increment it from wherever
   * its mutation settles without thinking about what the value means.
   *
   * NOT for a write that only changes what a row SAYS. Marking a conversation
   * read is the one every reader does constantly, and re-snapshotting on it
   * would move the list under them on every click -- exactly what this task
   * exists to stop. The refresh in place handles that case with no gesture at
   * all: the dot goes out where the row stands.
   */
  refreshToken?: number;
}

const DEFAULT_LIMIT = 25;

/**
 * The thread list, shared by the inbox's left pane and every record page's
 * Mail tab -- which is why it takes a filter set and a selection callback
 * rather than owning either. The inbox's filter BAR lives in the inbox: a
 * record's Mail tab has no account/unread pickers, it just passes
 * `{ contactId }` and gets that record's conversations.
 *
 * PAGING. The list route is keyset-paginated and the cursor is part of the
 * query key, so each page is its own cache entry and this is deliberately not
 * an infinite query (Task 9's handover note, and the house pattern every other
 * "load more" list here follows). The pages are accumulated in state instead,
 * keyed on the filter set: lib.ts's mergeCursorPage starts over whenever
 * that key changes, so changing a filter can never leave the previous filter's
 * rows on screen.
 *
 * The cursor is stored WITH the key it belongs to and read back through it,
 * rather than reset from an effect: an effect would leave one render (and one
 * fetch) in which the new filters are paired with the old filter's page-two
 * cursor. The cursor itself lives INSIDE the accumulator, with the key that
 * issued it -- see lib.ts's CursorPages for the bug that cost (a filter
 * toggled on and off again used to resurrect a page-two cursor and lose page
 * one).
 *
 * =====================================================================
 * LIVE, AND THE LIST DOES NOT MOVE UNDER THE READER (Phase 4.4 Task 3)
 * =====================================================================
 *
 * WHAT THIS REPLACED, because the starting point was not "not live". The
 * transport was already here: api/services/mail-ingest.ts publishes
 * ["mail-threads"] after every ingest and components/sse.tsx invalidates it,
 * so page one refetched on new mail and mergeCursorPage swapped the whole page
 * for the server's newest 25. THAT is the thing the spec's third risk names.
 * The list is ordered by `last_message_at`, so a reply to a three-week-old
 * conversation does not add a row at the top -- it MOVES one there, from
 * wherever it was, and every row in between shifts down by one. A reader
 * halfway down, ticking rows or aiming at one, got a different row under the
 * cursor between two clicks. What was genuinely missing was liveness BEYOND
 * page one: after "load more" the observed query is page two, so page one --
 * where new mail lands -- had no observer and never refetched at all.
 *
 * THE RULE, and it is one sentence: A ROW NEVER MOVES, APPEARS OR VANISHES
 * WITHOUT THE READER ASKING; A ROW THAT IS ALREADY ON SCREEN IS KEPT CURRENT
 * WHERE IT STANDS.
 *
 * So there are three behaviours, and the second is the one worth being sure
 * about:
 *
 *   1. A conversation the reader cannot see gets new mail -> counted, and a
 *      control at the top of the list offers to show it. Nothing moves until
 *      it is pressed. (mail-lib's pendingArrivals, and the control below.)
 *
 *   2. A conversation the reader CAN see gets new mail -> its row is refreshed
 *      in place: new snippet, new time, the unread dot back on, at the
 *      position it already occupies. The mail is on screen immediately; what
 *      is withheld is only the jump to the top. (lib.ts's refreshCursorRows.)
 *
 *   3. The reader's own write -> a new snapshot, because those rows really
 *      have gone (see the refreshToken prop).
 *
 * THE ALTERNATIVES, and why each is worse:
 *
 *   INSERT THE ROWS AND LET THE LIST RE-ORDER. This is what the code did
 *   before, and (1) is the whole of the case against it.
 *
 *   FREEZE THE LIST COMPLETELY UNTIL ASKED. One function shorter, and wrong
 *   within a click: opening a conversation marks it read, which publishes
 *   ["mail-threads"], and a list that adopted nothing would keep the bold
 *   unread row for the conversation the reader is looking at. Behaviour (2)
 *   is not a nicety, it is what makes the rule survive its own side effects.
 *
 *   REFETCH EVERY ACCUMULATED PAGE ON EACH HINT. The cursors are keyset
 *   positions in an ordering that has moved. Page two's cursor was issued by
 *   the page one that existed BEFORE three messages arrived; refetch page one
 *   and it now ends three rows earlier, so the three rows between its new end
 *   and that cursor are returned by neither fetch and are shown nowhere. The
 *   dedupe in flattenCursorPages cannot help -- these are rows that arrive
 *   from no page at all.
 *
 *   RE-SNAPSHOT ON EVERY HINT. That is "reorders under the reader" with extra
 *   steps: it throws away their paging as well as their place, on somebody
 *   else's schedule.
 *
 * SCROLL POSITION IS UNTOUCHED, AND THAT IS THE POINT. inbox.tsx rules that
 * this surface keeps no state parallel to the URL, which is why it does not
 * restore a scroll offset across its levels. THIS TASK DOES NOT OVERTURN THAT
 * RULING AND DOES NOT NEED TO: the answer here is not to restore the reader's
 * place after moving it, it is never to move it. Nothing below remembers an
 * offset, and nothing calls scrollTo.
 *
 * TWO OBSERVERS, ONE OF THEM FREE. `head` below is page one, always -- which
 * is what makes the list live past page one at all, since after "load more"
 * the paging query is watching page two. While the reader is ON page one the
 * two calls hash to the SAME query key (React Query's key hash drops
 * undefined values, so `{cursor: undefined}` and no cursor are one entry), so
 * they share one cache entry and one fetch and the second observer costs
 * nothing. Only a reader who has paged pays for a second entry, and that is
 * exactly the reader it exists for.
 */
export function ThreadList({
  filters, onSelect, selectedId = null, limit = DEFAULT_LIMIT, emptyLabel = "No conversations",
  selectable = false, selectedIds, onToggleThread, onToggleAll, allSelected = false,
  someSelected = false, selectionDisabled = false, onRowsChange, refreshToken = 0,
}: ThreadListProps) {
  const key = identityKey({ ...filters });
  const [pages, setPages] = useState<CursorPages<MailThreadListItem>>(
    () => emptyCursorPages<MailThreadListItem>(key),
  );
  const cursor = cursorForKey(pages, key);

  const { data, isLoading, isFetching, error } = useMailThreads({ ...filters, cursor, limit });
  // Page one, whatever page the reader is on. See the header: on page one this
  // IS the query above, sharing its entry and its fetch.
  const head = useMailThreads({ ...filters, limit });
  const headData = head.data;

  /**
   * THE PAGING QUERY ONLY EVER ADDS A PAGE. takeCursorPage returns the record
   * UNCHANGED for a cursor already held, so a refetch of a page on screen
   * cannot move, insert or drop a row; refreshing what is already here is the
   * other effect's job, and only the other effect's.
   *
   * `pages` is a dependency, which it has to be: a re-snapshot empties the
   * accumulator without changing the data, the key OR the cursor (page one's
   * cursor is undefined either way), and an effect that did not watch the
   * accumulator would leave the list empty until something else happened to
   * move. Safe because takeCursorPage settles -- its second call for the same
   * cursor returns the same object, so React bails out.
   */
  useEffect(() => {
    if (data === undefined) return;
    setPages((current) => takeCursorPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, key, cursor, pages]);

  /**
   * ...AND PAGE ONE IS THE ONLY THING THAT REFRESHES WHAT IS ON SCREEN.
   *
   * ONE WRITER, and lib.ts's refreshCursorRows says why it must be exactly
   * one: two fetches writing row objects would hand out different objects for
   * any row they both covered, and each would rewrite the other's, from an
   * effect, for ever. The overlap is rare (page one and a later page's window
   * are disjoint while nothing above the cursor is deleted) and an infinite
   * render loop is not a thing to leave resting on "rare".
   *
   * PAGE ONE IS ALSO THE RIGHT ONE to be the writer: new mail is what makes a
   * row's copy stale, and a conversation with new mail is by definition among
   * the newest, so page one is where every fresh copy arrives -- whatever page
   * the reader happens to be showing that row on.
   *
   * WHAT THAT COSTS, stated rather than discovered: a row below page one that
   * changes WITHOUT becoming recent -- the unread dot on a conversation the
   * reader opened at row 60 -- keeps its old copy until the next snapshot.
   * Before this task the last-loaded page refetched into view and the earlier
   * ones did not, so the same staleness was already here with a different
   * boundary; what is new is that it is now a rule with a reason instead of a
   * consequence of which query happened to be observed.
   */
  useEffect(() => {
    if (headData === undefined) return;
    setPages((current) => refreshCursorRows(current, key, headData.items));
  }, [headData, key, pages]);

  /**
   * Take a new snapshot: fetch page one, THEN start the accumulation over from
   * what came back.
   *
   * IN THAT ORDER, AND THE ORDER IS THE WHOLE FUNCTION. The caller's most
   * important reason to ask is a write it has just made (refreshToken), and by
   * then its mutation hook has already invalidated ["mail-threads"] -- so a
   * fetch is in flight and the cache still holds the answer from BEFORE the
   * write. Emptying the accumulator first would adopt that stale page, putting
   * the ten conversations the reader just trashed straight back on screen; and
   * the fresh page landing a moment later would find its cursor held again and
   * refresh those rows in place rather than remove them, so they would stay
   * there. Waiting for the fetch costs one round trip and is never wrong.
   *
   * `refetch` on an in-flight query returns that fetch's own promise (React
   * Query dedupes), so the common case does not issue a second request.
   *
   * IT GOES BACK TO PAGE ONE, and the accumulated pages are re-fetched by
   * pressing "Load more" again rather than re-paged here. Their cursors are
   * keyset positions in the ordering that has just moved, so re-fetching each
   * one with the cursor it was issued would leave the rows between page one's
   * new end and page two's old cursor returned by no fetch at all. Page one is
   * the only boundary that is certainly still true.
   */
  const headRefetch = head.refetch;
  // The key AS OF THE RESET, not as of the ask: a filter changed while the
  // fetch was in flight would otherwise re-key the accumulator backwards, and
  // the list would blink empty for a render. Through a ref, so this callback
  // keeps one identity (the effect below has it as a dependency).
  const keyRef = useLatest(key);
  const resnapshot = useCallback(() => {
    void headRefetch().then(() => setPages(emptyCursorPages<MailThreadListItem>(keyRef.current)));
  }, [headRefetch, keyRef]);

  // Only a CHANGE means anything -- the value is a nonce -- so the mount pass,
  // where there is nothing to refresh, is skipped rather than costing a fetch
  // and a render on every list that ever mounts.
  const seenToken = useRef(refreshToken);
  useEffect(() => {
    if (seenToken.current === refreshToken) return;
    seenToken.current = refreshToken;
    resnapshot();
  }, [refreshToken, resnapshot]);

  const threads = useMemo(
    () => (pages.key === key ? flattenCursorPages(pages) : []),
    [pages, key],
  );

  const { data: accounts } = useMailAccounts();
  // Own accounts AND other users' summaries: an archived account still labels
  // the threads it brought in, even though the inbox's account FILTER offers
  // only the live ones.
  const accountLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts?.own ?? []) map.set(account.id, account.label);
    for (const account of accounts?.others ?? []) map.set(account.id, account.label);
    return map;
  }, [accounts]);

  // Read off the ACCUMULATOR, not off the live query: pressing "load more"
  // switches to a cache entry with no data yet, and a button that unmounted
  // for the duration of its own fetch could never show that it was fetching.
  const showLoadMore = pages.key === key && pages.nextCursor !== null;

  /**
   * What has arrived that the list is not showing -- the difference between
   * the freshest page one and the rows on screen. mail-lib's pendingArrivals
   * owns the two exclusions that keep the number honest.
   *
   * Both sides are this filter set's by construction, with no guard needed for
   * it: `threads` is empty for any key the accumulator is not holding, and a
   * changed key gives `head` a different query rather than the old one's data
   * (nothing here sets placeholderData). An empty list counts nothing, so the
   * render between a filter change and its first page offers nothing.
   */
  const pending = useMemo(
    () => (headData === undefined
      ? { count: 0, atLeast: false }
      : pendingArrivals(threads, headData.items, headData.nextCursor !== null)),
    [headData, threads],
  );

  /**
   * The visible row order, for shift-ranges and select-all.
   *
   * Kept in a REF as well as reported upward, so the callback handed to every
   * row can have `onToggleThread` as its only dependency. A callback that closed
   * over the order directly would change identity on every appended page and
   * re-render every memoised row in the list -- exactly the cost ThreadRow's
   * memo exists to avoid.
   */
  const order = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const orderRef = useLatest<readonly string[]>(order);

  // Reported as {id, ownedByViewer} pairs, not bare ids: the inbox's bulk bar
  // greys Archive/Trash whenever a selected thread is unowned, and this is
  // the one channel that already carries "the visible rows" to it.
  const rowsInfo = useMemo(
    () => threads.map((thread) => ({ id: thread.id, ownedByViewer: thread.ownedByViewer })),
    [threads],
  );

  useEffect(() => {
    onRowsChange?.(rowsInfo);
  }, [rowsInfo, onRowsChange]);

  const toggleThread = useCallback((threadId: string, shift: boolean) => {
    onToggleThread?.(threadId, { shift, order: orderRef.current });
  }, [onToggleThread, orderRef]);

  // Once anything is ticked, every row's checkbox stays fully visible: hunting
  // for a second checkbox by hovering, mid-selection, is the one case where the
  // hover-reveal gets in the way.
  const anySelected = (selectedIds?.size ?? 0) > 0;

  return (
    <div data-testid="thread-list" className="flex min-w-0 flex-col">
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-red-600">
          Could not load conversations: {error.message}
        </p>
      )}
      {/* NOT STICKY, AND NOT A TOAST. A reader deep in a list is precisely the
          reader this whole design is protecting from interruption, and a badge
          that follows them down the page is the interruption in a smaller
          font. It sits at the top of the list, where a reader who has come
          back up to look for it will find it -- and the nav's unread badge
          (live, and untouched by any of this) is the signal that says "there
          is new mail" wherever they are.

          MOUNTED ALWAYS, so its live region is announced when it fills:
          exactly BulkResult's shape below the filter bar, and for the same
          reason -- a region that appears with its text already in it is a
          region a screen reader has nothing to compare against. */}
      <div data-testid="thread-list-new" role="status" aria-live="polite" className="empty:hidden">
        {pending.count > 0 && (
          <Button
            variant="outline"
            className="mb-2 w-full"
            data-testid="thread-list-new-show"
            onClick={resnapshot}
          >
            {newMailLabel(pending)}
          </Button>
        )}
      </div>
      {selectable && threads.length > 0 && (
        // 24px at a desk, measured. The TARGET is the label, not the 16px box
        // inside it -- a native checkbox cannot be resized without replacing
        // it, and the label already carries the click through. Not
        // ui/touch.ts's CHECKBOX_LABEL: that constant carries its own padding
        // and type scale for the "Archived" toggles, and this row is a
        // different one (px-3, text-xs, slate-500) that only shares the floor.
        <label className="flex items-center gap-2 px-3 py-1 text-xs text-slate-500 max-md:min-h-11">
          <TriStateCheckbox
            testId="thread-select-all"
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            disabled={selectionDisabled}
            ariaLabel="Select all conversations"
            onChange={() => onToggleAll?.(orderRef.current)}
          />
          Select all
        </label>
      )}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {isLoading && threads.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-400">Loading...</li>
        )}
        {/* Not while `error` is set: a failed fetch means "we do not know what
            is here", which is not the same claim as "there is nothing here". */}
        {!isLoading && !error && threads.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-400">{emptyLabel}</li>
        )}
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            selected={thread.id === selectedId}
            onSelect={onSelect}
            accountLabels={accountLabels}
            selectable={selectable}
            checked={selectedIds?.has(thread.id) ?? false}
            anySelected={anySelected}
            selectionDisabled={selectionDisabled}
            onToggle={toggleThread}
          />
        ))}
      </ul>
      {showLoadMore && (
        <Button
          variant="outline"
          className="mt-2 self-start"
          data-testid="thread-list-more"
          disabled={isFetching}
          onClick={() => setPages((current) => advanceCursorPages(current, key))}
        >
          {isFetching ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}

/**
 * Memoised per-thread row, the same way gantt/bar.tsx memoises a bar and for
 * the same reason: this list is the busiest thing on the page, and everything
 * above it re-renders on every SSE invalidation, every selection change and
 * every keystroke in the filter bar.
 *
 * The default shallow comparison is the RIGHT one here, prop by prop: `thread`
 * is an object React Query hands out and only replaces when its page actually
 * refetches, `accountLabels` is memoised on the accounts query, `onSelect` is
 * the caller's stable callback (the inbox wraps its own in useCallback), and
 * `selected` is a boolean that changes for exactly two rows when the selection
 * moves. So a re-render of the list re-renders no rows at all unless their own
 * data moved.
 *
 * THE MULTI-SELECT PROPS KEEP THAT PROPERTY (Phase 4.1). `onToggle` is the
 * list's own useCallback, stable because the visible row order it needs travels
 * through a ref rather than through its closure; `checked` changes for the one
 * row that was ticked (or, on a select-all, for the rows that changed);
 * `anySelected` flips exactly twice per selection -- once when the first row is
 * ticked and once when the last is cleared. `selectable` never changes at all,
 * and `selectionDisabled` flips twice per bulk request.
 */
const ThreadRow = memo(function ThreadRow({
  thread, selected, onSelect, accountLabels, selectable, checked, anySelected,
  selectionDisabled, onToggle,
}: {
  thread: MailThreadListItem;
  selected: boolean;
  onSelect: (threadId: string) => void;
  accountLabels: Map<string, string>;
  selectable: boolean;
  checked: boolean;
  anySelected: boolean;
  selectionDisabled: boolean;
  /** Takes the id and whether shift was held, so the list can hand every row
   * ONE stable callback (mirroring conversation.tsx's onToggle). */
  onToggle: (threadId: string, shift: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Brings a row selected from somewhere else into view -- the `?thread=`
  // deep link the global search navigates to, in particular. `nearest` so a
  // row that is already visible is left exactly where it is.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const senders = thread.senders.map(addressLabel).join(", ");
  // "Hidden <when>" from the VIEWER'S OWN filing moment -- hiddenAt is null
  // by construction on every default-list row, so the chip appears exactly
  // on the Hidden view's rows (mail-lib's hiddenChipLabel), naming when the
  // thread was filed away and marking the row as one Unhide (in the
  // conversation) restores.
  const hiddenChip = hiddenChipLabel(thread.hiddenAt);

  return (
    <li className={clsx("group flex items-start", selected ? "bg-slate-100" : "hover:bg-slate-50")}>
      {selectable && (
        // A SIBLING of the row button, not a child: a checkbox inside a button
        // is invalid, and nesting one would also make every tick open the
        // conversation. `opacity` rather than conditional rendering so the rows
        // do not shift horizontally as the pointer moves down the list.
        //
        // NEVER opacity-0. A hover-reveal is not a reveal on a touch screen --
        // there is no hover -- and a checkbox at zero opacity there is a control
        // that does not exist: multi-select was simply unreachable on a phone or
        // a tablet. Faded is enough to keep an unselected list quiet while still
        // being visible and tappable everywhere.
        <label
          className={clsx(
            // THE SHORT AXIS HERE IS THE WIDTH. `self-stretch` already makes
            // this label as tall as the row (98.5px, measured), but it was
            // 32px WIDE -- 12 + 16 + 4 -- so the thing under a thumb was well
            // under the floor on the one gesture that turns a reading list
            // into a bulk selection. The floor is a min-width rather than
            // extra padding so the painted checkbox stays exactly where it
            // is; what grows is the empty half of the hit box, and the row
            // beside it starts 12px further in on a phone.
            "flex shrink-0 items-center self-stretch pl-3 pr-1 transition-opacity max-md:min-w-11",
            checked || anySelected
              ? "opacity-100"
              : "opacity-40 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <input
            type="checkbox"
            data-testid={`thread-checkbox-${thread.id}`}
            aria-label={`Select ${subjectLabel(thread.subject)}`}
            checked={checked}
            disabled={selectionDisabled}
            // React maps a checkbox's onChange onto the native CLICK, so the
            // native event carries the modifier keys -- which is how a
            // shift-click reaches the range logic. A keyboard tick is a
            // synthesized click with no modifiers, i.e. a plain toggle.
            onChange={(event) => onToggle(thread.id, isShiftClick(event.nativeEvent))}
            className="h-4 w-4"
          />
        </label>
      )}
      <button
        ref={ref}
        type="button"
        data-testid={`thread-row-${thread.id}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(thread.id)}
        className={clsx(
          "flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left",
        )}
      >
        <span className="flex items-center gap-2">
          {/* role="img" so the label is announced: an aria-label on a bare
              <span> is ignored by screen readers, which have no role to
              attach it to. The placeholder half keeps the rows aligned and
              stays hidden. */}
          {thread.unread ? (
            <span role="img" aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-slate-900" />
          ) : (
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-transparent" />
          )}
          <span
            className={clsx(
              "min-w-0 flex-1 truncate text-sm",
              thread.unread ? "font-semibold text-slate-900" : "text-slate-700",
            )}
          >
            {senders === "" ? "\u2014" : senders}
          </span>
          <span className="shrink-0 text-xs text-slate-400">{relativeTime(thread.lastMessageAt)}</span>
        </span>
        <span className="truncate pl-4 text-sm text-slate-900">{subjectLabel(thread.subject)}</span>
        <span className="truncate pl-4 text-xs text-slate-500">{thread.snippet}</span>
        <span className="flex flex-wrap items-center gap-1 pl-4">
          {hiddenChip !== null && (
            <span
              data-testid="hidden-chip"
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            >
              {hiddenChip}
            </span>
          )}
          {thread.accountIds.map((accountId) => {
            const label = accountLabels.get(accountId);
            return label === undefined ? null : (
              <span key={accountId} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                {label}
              </span>
            );
          })}
          {thread.contactId !== null && <ContactChip contactId={thread.contactId} />}
          {thread.companyId !== null && <CompanyChip companyId={thread.companyId} />}
          {thread.dealId !== null && <DealChip dealId={thread.dealId} />}
          {thread.projectId !== null && <ProjectChip projectId={thread.projectId} />}
        </span>
      </button>
    </li>
  );
});

/** Was the tick a shift-click? Narrowed rather than cast: a keyboard-driven
 * change is a click event too, so the instanceof is what tells a real modifier
 * from a synthesized one. */
function isShiftClick(event: Event): boolean {
  return event instanceof MouseEvent && event.shiftKey;
}

/**
 * A checkbox that can also read INDETERMINATE -- the header box when some rows
 * are ticked and some are not.
 *
 * `indeterminate` is a DOM property with no HTML attribute behind it, so React
 * cannot set it from JSX and it has to be written to the node itself. It is
 * purely a visual/announced state: the box still reports `checked` when
 * clicked, and the caller decides what a click means (here: tick everything, or
 * clear everything).
 */
function TriStateCheckbox({
  testId, checked, indeterminate, disabled, ariaLabel, onChange,
}: {
  testId: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      data-testid={testId}
      aria-label={ariaLabel}
      aria-checked={indeterminate ? "mixed" : checked}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4"
    />
  );
}

/**
 * The record links a thread carries, as names rather than ids: ONE COMPONENT
 * PER KIND, mounted only when that link exists.
 *
 * The obvious shape -- a single ThreadLinkChips calling all four detail hooks
 * with `id ?? ""` -- reads better and costs far more. A disabled query issues
 * no request, but it is still a live cache observer, and an unlinked inbox of
 * a hundred rows would mount four hundred of them for nothing. Split this way,
 * an unlinked thread mounts NONE, and a linked one mounts exactly as many as
 * it has links. (link-panel.tsx makes the same argument for its pickers: the
 * component that is not being used should not be mounted.)
 *
 * The queries themselves are cache reads in almost every case -- the record
 * pages, the conversation's link panel and the pickers all populate the same
 * ["company", id] / ["contact", id] / ["deal", id] / ["project", id] entries.
 */
function LinkChip({ name }: { name: string | undefined }) {
  if (name === undefined || name === "") return null;
  return (
    <span className="rounded bg-slate-900/5 px-1.5 py-0.5 text-[11px] text-slate-600">{name}</span>
  );
}

function ContactChip({ contactId }: { contactId: string }) {
  const { data } = useContact(contactId);
  return <LinkChip name={data === undefined ? undefined : `${data.firstName} ${data.lastName ?? ""}`.trim()} />;
}

function CompanyChip({ companyId }: { companyId: string }) {
  const { data } = useCompany(companyId);
  return <LinkChip name={data?.name} />;
}

function DealChip({ dealId }: { dealId: string }) {
  const { data } = useDeal(dealId);
  return <LinkChip name={data?.title} />;
}

function ProjectChip({ projectId }: { projectId: string }) {
  const { data } = useProject(projectId);
  return <LinkChip name={data?.name} />;
}
