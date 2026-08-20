import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import type { MailThreadListItem } from "@conduit/shared";
import { relativeTime } from "../../lib";
import {
  useCompany,
  useContact,
  useDeal,
  useMailAccounts,
  useMailThreads,
  useProject,
  type MailThreadListParams,
} from "../../queries";
import {
  addressLabel,
  advanceThreadPages,
  cursorForKey,
  emptyThreadPages,
  flattenThreadPages,
  mergeThreadPage,
  subjectLabel,
  threadFilterKey,
  type ThreadPages,
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
  /** The visible rows, in order, whenever they change -- so the caller can turn
   * its selection into a request without duplicating the accumulator. */
  onRowsChange?: (threadIds: string[]) => void;
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
 * keyed on the filter set: mail-lib's mergeThreadPage starts over whenever
 * that key changes, so changing a filter can never leave the previous filter's
 * rows on screen.
 *
 * The cursor is stored WITH the key it belongs to and read back through it,
 * rather than reset from an effect: an effect would leave one render (and one
 * fetch) in which the new filters are paired with the old filter's page-two
 * cursor. The cursor itself lives INSIDE the accumulator, with the key that
 * issued it -- see mail-lib's ThreadPages for the bug that cost (a filter
 * toggled on and off again used to resurrect a page-two cursor and lose page
 * one).
 *
 * One consequence, accepted: only the CURRENT page is a live query, so after
 * "load more" an SSE invalidation refreshes the page that is mounted and the
 * earlier pages keep the rows they were fetched with until the list resets
 * (a filter change, or a remount). New mail still bumps its thread to the top
 * of page one -- it is just not re-fetched underneath an accumulated list.
 */
export function ThreadList({
  filters, onSelect, selectedId = null, limit = DEFAULT_LIMIT, emptyLabel = "No conversations",
  selectable = false, selectedIds, onToggleThread, onToggleAll, allSelected = false, onRowsChange,
}: ThreadListProps) {
  const key = threadFilterKey({ ...filters });
  const [pages, setPages] = useState<ThreadPages>(() => emptyThreadPages(key));
  const cursor = cursorForKey(pages, key);

  const { data, isLoading, isFetching, error } = useMailThreads({ ...filters, cursor, limit });

  useEffect(() => {
    if (data === undefined) return;
    // mergeThreadPage returns the SAME object when this page's items are the
    // array already stored, so this settles after one pass instead of looping.
    setPages((current) => mergeThreadPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, key, cursor]);

  const threads = useMemo(
    () => (pages.key === key ? flattenThreadPages(pages) : []),
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
   * The visible row order, for shift-ranges and select-all.
   *
   * Kept in a REF as well as reported upward, so the callback handed to every
   * row can have `onToggleThread` as its only dependency. A callback that closed
   * over the order directly would change identity on every appended page and
   * re-render every memoised row in the list -- exactly the cost ThreadRow's
   * memo exists to avoid.
   */
  const order = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const orderRef = useRef<readonly string[]>(order);
  orderRef.current = order;

  useEffect(() => {
    onRowsChange?.(order);
  }, [order, onRowsChange]);

  const toggleThread = useCallback((threadId: string, shift: boolean) => {
    onToggleThread?.(threadId, { shift, order: orderRef.current });
  }, [onToggleThread]);

  // Once anything is ticked, every row's checkbox stays visible: hunting for a
  // second checkbox by hovering, mid-selection, is the one case where the
  // hover-reveal gets in the way.
  const anySelected = (selectedIds?.size ?? 0) > 0;

  return (
    <div data-testid="thread-list" className="flex min-w-0 flex-col">
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-red-600">
          Could not load conversations: {error.message}
        </p>
      )}
      {selectable && threads.length > 0 && (
        <label className="flex items-center gap-2 px-3 py-1 text-xs text-slate-500">
          <input
            type="checkbox"
            data-testid="thread-select-all"
            checked={allSelected}
            onChange={() => onToggleAll?.(orderRef.current)}
            className="h-4 w-4"
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
          onClick={() => setPages((current) => advanceThreadPages(current, key))}
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
 * ticked and once when the last is cleared. `selectable` never changes at all.
 */
const ThreadRow = memo(function ThreadRow({
  thread, selected, onSelect, accountLabels, selectable, checked, anySelected, onToggle,
}: {
  thread: MailThreadListItem;
  selected: boolean;
  onSelect: (threadId: string) => void;
  accountLabels: Map<string, string>;
  selectable: boolean;
  checked: boolean;
  anySelected: boolean;
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

  return (
    <li className={clsx("group flex items-start", selected ? "bg-slate-100" : "hover:bg-slate-50")}>
      {selectable && (
        // A SIBLING of the row button, not a child: a checkbox inside a button
        // is invalid, and nesting one would also make every tick open the
        // conversation. `opacity` rather than conditional rendering so the rows
        // do not shift horizontally as the pointer moves down the list.
        <label
          className={clsx(
            "flex shrink-0 items-center self-stretch pl-3 pr-1",
            checked || anySelected
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <input
            type="checkbox"
            data-testid={`thread-checkbox-${thread.id}`}
            aria-label={`Select ${subjectLabel(thread.subject)}`}
            checked={checked}
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
