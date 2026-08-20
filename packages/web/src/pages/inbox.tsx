import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMailAccounts } from "../queries";
import { BulkBar } from "../components/mail/bulk-bar";
import { Composer } from "../components/mail/composer";
import { Conversation } from "../components/mail/conversation";
import { FolderSidebar } from "../components/mail/folder-sidebar";
import { ThreadList, type ThreadListFilters, type ThreadToggle } from "../components/mail/thread-list";
import {
  allOnPageSelected,
  emptySelection,
  extendThreadSelection,
  selectedThreadIds,
  selectionForKey,
  threadFilterKey,
  toggleAllOnPage,
  toggleThreadSelected,
  type ThreadSelection,
} from "../components/mail/mail-lib";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/** Sentinel for "no account filter": a Radix select item cannot carry an
 * empty value, and this can never collide with an account id. */
const ALL_ACCOUNTS = "all";

/**
 * The mail inbox (/mail): folder rail, thread list, and the selected
 * conversation.
 *
 * The selection lives in the URL (`?thread=<id>`), not in component state, so
 * a conversation can be linked to from anywhere -- the global search's mail
 * group and every record page's Mail tab both navigate here with that param.
 * Selecting from the list REPLACES the history entry, the same rule the task
 * drawer follows (components/search.tsx's own comment): moving between
 * conversations inside the inbox is not something Back should have to walk
 * through one thread at a time, while arriving from elsewhere is.
 *
 * The MULTI-SELECT (Phase 4.1) is the other kind of selection here and lives in
 * ordinary state, keyed on the filter set: mail-lib's selectionForKey hands it
 * back only to the filters it was made under, so changing a filter or a folder
 * clears it by construction -- the same principle ThreadPages uses for paging,
 * and for the same reason (there is no render in which the new view holds the
 * old view's selection).
 */
export function InboxPage() {
  const navigate = useNavigate();
  const { thread: selectedId } = useSearch({ from: "/mail" });
  const { data: accounts } = useMailAccounts();

  const [accountChoice, setAccountChoice] = useState(ALL_ACCOUNTS);
  const [folder, setFolder] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  // Only the non-archived own accounts, plus every other user's, are offered
  // as a filter: an archived account has stopped syncing, so filtering by it
  // shows a frozen slice of history nobody asked for. Its threads still
  // render (and still carry its chip) under every other filter.
  const ownActive = (accounts?.own ?? []).filter((account) => account.archivedAt === null);
  const filterAccounts = [
    ...ownActive.map((account) => ({ id: account.id, label: account.label, email: account.email })),
    ...(accounts?.others ?? []),
  ];

  // The picked account, but only while it is still one of the options: an
  // account archived in another tab (or by another user) drops out of the list
  // above, and a filter that survived that would be an invisible one -- an
  // empty inbox with nothing on screen to explain it. Derived rather than
  // reset from an effect, so there is never a render (or a fetch) using the
  // stranded id. The picker itself renders this value, so the trigger cannot
  // show a label that no longer exists either.
  const accountStillOffered = filterAccounts.some((account) => account.id === accountChoice);
  const accountId = accountStillOffered ? accountChoice : ALL_ACCOUNTS;

  // ...and once the accounts have actually loaded, put the state back where the
  // derivation already points. Without this the stranded id sits in state
  // forever, quietly waiting to re-apply itself if that account is ever
  // unarchived -- the same shape as the cursor bug in thread-list, benign only
  // because the id is still meaningful. Guarded on `accounts` being loaded so
  // the first render (no accounts yet) does not clear a legitimate choice.
  useEffect(() => {
    if (accounts === undefined || accountChoice === ALL_ACCOUNTS || accountStillOffered) return;
    setAccountChoice(ALL_ACCOUNTS);
  }, [accounts, accountChoice, accountStillOffered]);

  // Assumed true until the accounts actually arrive: "add a mail account"
  // must not flash on screen while the list is still loading.
  const noActiveAccount = accounts !== undefined
    && !accounts.own.some((account) => account.archivedAt === null);

  // undefined rather than false for the three flags: an absent filter is not
  // the same query as an explicitly-false one, and keeping them out of the
  // object keeps the query key (and the accumulation key) to what is actually
  // being filtered on.
  const filters: ThreadListFilters = {
    accountId: accountId === ALL_ACCOUNTS ? undefined : accountId,
    unread: unread ? true : undefined,
    unlinked: unlinked ? true : undefined,
    archived: hidden ? true : undefined,
    folder: folder ?? undefined,
  };

  // The filter identity BOTH the paging accumulator and the selection are keyed
  // on -- computed once here so the two cannot drift apart.
  const filterKey = threadFilterKey({ ...filters });

  const [selectionState, setSelectionState] = useState<ThreadSelection>(() => emptySelection(filterKey));
  const selection = selectionForKey(selectionState, filterKey);
  const [rows, setRows] = useState<readonly string[]>([]);

  // The key as of this render, for the toggle callbacks below. They must be
  // STABLE -- every memoised row takes the one the list derives from them -- so
  // the key they act under travels through a ref rather than a dependency.
  const keyRef = useRef(filterKey);
  keyRef.current = filterKey;

  const toggleThread = useCallback((threadId: string, { shift, order }: ThreadToggle) => {
    setSelectionState((current) => (shift
      ? extendThreadSelection(current, keyRef.current, threadId, order)
      : toggleThreadSelected(current, keyRef.current, threadId)));
  }, []);

  const toggleAll = useCallback((order: readonly string[]) => {
    setSelectionState((current) => toggleAllOnPage(current, keyRef.current, order));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionState(emptySelection(keyRef.current));
  }, []);

  // Reference-guarded so a re-render that produced the same rows cannot loop
  // through this back into a new state object.
  const handleRows = useCallback((next: string[]) => {
    setRows((current) => (current.length === next.length && current.every((id, i) => id === next[i])
      ? current : next));
  }, []);

  const selectedThreads = selectedThreadIds(selection, filterKey, rows);

  // Stable, so the memoised rows in thread-list can bail out: a new closure
  // here every render would defeat their shallow comparison one prop before it
  // started.
  const select = useCallback((threadId: string) => {
    void navigate({ to: "/mail", search: { thread: threadId }, replace: true });
  }, [navigate]);

  /**
   * Picking a folder names its ACCOUNT too.
   *
   * The sidebar groups folders per account, so a click under a section heading
   * means "this account's INBOX", not "every account's". The route builds one
   * combined EXISTS for the pair (it must -- two independent filters would
   * match a thread whose INBOX message is on one account and whose folder
   * message is on another), which is exactly what this sends it. With a single
   * account the account term is redundant and harmless.
   */
  function chooseFolder(choice: { accountId: string; folder: string } | null) {
    if (choice === null) {
      setFolder(null);
      return;
    }
    setFolder(choice.folder);
    if (filterAccounts.some((account) => account.id === choice.accountId)) {
      setAccountChoice(choice.accountId);
    }
  }

  return (
    <div data-testid="inbox" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>
        <Button data-testid="compose-button" onClick={() => setComposeOpen(true)}>
          Compose
        </Button>
      </div>

      {/* Each pane scrolls itself, within the viewport, rather than growing the
          page: a thread list several "load more" pages long would otherwise
          make the whole window scroll, and a row scrolled into view by the
          `?thread=` deep link would drag the conversation off screen with it.
          The height budget is the viewport minus the shell's header and this
          page's own heading row. */}
      <div className="grid gap-4 lg:h-[calc(100vh-11rem)] lg:grid-cols-[minmax(0,11rem)_minmax(0,24rem)_minmax(0,1fr)]">
        <div className="min-w-0 lg:overflow-y-auto">
          <FolderSidebar
            accounts={ownActive}
            folder={folder}
            accountId={accountId === ALL_ACCOUNTS ? null : accountId}
            onSelect={chooseFolder}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2 lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            {filterAccounts.length > 1 && (
              <div className="w-48">
                <Select value={accountId} onValueChange={setAccountChoice}>
                  <SelectTrigger ariaLabel="Account" testId="filter-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_ACCOUNTS}>All accounts</SelectItem>
                    {filterAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>{account.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <FilterToggle testId="filter-unread" label="Unread" on={unread} onChange={setUnread} />
            <FilterToggle testId="filter-unlinked" label="Unlinked" on={unlinked} onChange={setUnlinked} />
            {/* "Hidden", not "Archived": since Phase 4.1 an Archive is a real
                IMAP move, and this filter is the CRM-side "Hide in CRM" state
                (mail_threads.archived_at), which is a different thing. The
                testid predates the rename and stays as it is. */}
            <FilterToggle testId="filter-archived" label="Hidden" on={hidden} onChange={setHidden} />
          </div>

          {selectedThreads.length > 0 && (
            <BulkBar
              threadIds={selectedThreads}
              // The current view's folder, or nothing at all in the unfiltered
              // list -- the mode selector; see BulkBarProps.folder.
              folder={folder ?? undefined}
              onDone={clearSelection}
              onClear={clearSelection}
            />
          )}

          <ThreadList
            filters={filters}
            onSelect={select}
            selectedId={selectedId ?? null}
            selectable
            selectedIds={selection.ids}
            onToggleThread={toggleThread}
            onToggleAll={toggleAll}
            allSelected={allOnPageSelected(selection, filterKey, rows)}
            onRowsChange={handleRows}
            // An inbox with no mail account is not an empty inbox, it is an
            // unconfigured one (spec: "Empty state points at Settings ->
            // Mail"), and that reading beats the hidden/unfiltered wording:
            // with no account there is nothing to have hidden either.
            emptyLabel={noActiveAccount ? (
              <span data-testid="inbox-no-account">
                No mail account yet.{" "}
                <Link to="/settings/mail" className="font-medium text-slate-900 underline hover:text-slate-700">
                  Add one in Settings {"\u2192"} Mail
                </Link>{" "}
                to start syncing your inbox.
              </span>
            ) : hidden ? "No hidden conversations" : "No conversations"}
          />
        </div>

        <div className="min-w-0 lg:overflow-y-auto">
          {selectedId === undefined ? (
            <p className="rounded-md border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
              Select a conversation to read it.
            </p>
          ) : (
            // Keyed on the thread: the conversation's local state (expanded
            // messages, remote images, an open composer) belongs to one
            // thread, and a remount is the cleanest way to leave it behind.
            <Conversation key={selectedId} threadId={selectedId} />
          )}
        </div>
      </div>

      <Composer open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}

function FilterToggle({
  testId, label, on, onChange,
}: {
  testId: string;
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Button
      variant={on ? "default" : "outline"}
      data-testid={testId}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {label}
    </Button>
  );
}
