import { useEffect, useMemo, useRef, useState } from "react";
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

export interface ThreadListProps {
  filters: ThreadListFilters;
  onSelect: (threadId: string) => void;
  selectedId?: string | null;
  /** Page size; the route's own default is used when omitted. */
  limit?: number;
  emptyLabel?: string;
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
 * cursor.
 */
export function ThreadList({
  filters, onSelect, selectedId = null, limit = DEFAULT_LIMIT, emptyLabel = "No conversations",
}: ThreadListProps) {
  const key = threadFilterKey({ ...filters });
  const [page, setPage] = useState<{ key: string; cursor?: string }>({ key });
  const cursor = page.key === key ? page.cursor : undefined;
  const [pages, setPages] = useState<ThreadPages>(() => emptyThreadPages(key));

  const { data, isLoading, isFetching, error } = useMailThreads({ ...filters, cursor, limit });

  useEffect(() => {
    if (data === undefined) return;
    // mergeThreadPage returns the SAME object when this page's items are the
    // array already stored, so this settles after one pass instead of looping.
    setPages((current) => mergeThreadPage(current, key, cursor, data.items));
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

  const showLoadMore = data?.nextCursor != null && data.nextCursor !== "";

  return (
    <div data-testid="thread-list" className="flex min-w-0 flex-col">
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-red-600">
          Could not load conversations: {error.message}
        </p>
      )}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {isLoading && threads.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-400">Loading...</li>
        )}
        {!isLoading && threads.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-400">{emptyLabel}</li>
        )}
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            selected={thread.id === selectedId}
            onSelect={onSelect}
            accountLabels={accountLabels}
          />
        ))}
      </ul>
      {showLoadMore && (
        <Button
          variant="outline"
          className="mt-2 self-start"
          data-testid="thread-list-more"
          disabled={isFetching}
          onClick={() => setPage({ key, cursor: data?.nextCursor ?? undefined })}
        >
          {isFetching ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}

function ThreadRow({
  thread, selected, onSelect, accountLabels,
}: {
  thread: MailThreadListItem;
  selected: boolean;
  onSelect: (threadId: string) => void;
  accountLabels: Map<string, string>;
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
    <li>
      <button
        ref={ref}
        type="button"
        data-testid={`thread-row-${thread.id}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(thread.id)}
        className={clsx(
          "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
          selected ? "bg-slate-100" : "hover:bg-slate-50",
        )}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden={!thread.unread}
            aria-label={thread.unread ? "Unread" : undefined}
            className={clsx(
              "h-2 w-2 shrink-0 rounded-full",
              thread.unread ? "bg-slate-900" : "bg-transparent",
            )}
          />
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
          <ThreadLinkChips thread={thread} />
        </span>
      </button>
    </li>
  );
}

/**
 * The record links a thread carries, as names rather than ids.
 *
 * Resolved with the ordinary per-record detail hooks, one query per link and
 * none at all for a link that is absent (each hook is disabled on an empty
 * id). They are cache reads in almost every case -- the record pages, the
 * conversation's link panel and the pickers all populate the same
 * ["company", id] / ["contact", id] / ["deal", id] / ["project", id] entries.
 */
function ThreadLinkChips({ thread }: { thread: { companyId: string | null; contactId: string | null; dealId: string | null; projectId: string | null } }) {
  const { data: company } = useCompany(thread.companyId ?? "");
  const { data: contact } = useContact(thread.contactId ?? "");
  const { data: deal } = useDeal(thread.dealId ?? "");
  const { data: project } = useProject(thread.projectId ?? "");

  const names = [
    contact === undefined ? null : `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    company?.name ?? null,
    deal?.title ?? null,
    project?.name ?? null,
  ].filter((name): name is string => name !== null && name !== "");

  return (
    <>
      {names.map((name) => (
        <span key={name} className="rounded bg-slate-900/5 px-1.5 py-0.5 text-[11px] text-slate-600">
          {name}
        </span>
      ))}
    </>
  );
}
