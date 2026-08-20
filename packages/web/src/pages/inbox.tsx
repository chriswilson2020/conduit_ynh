import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMailAccounts } from "../queries";
import { Composer } from "../components/mail/composer";
import { Conversation } from "../components/mail/conversation";
import { ThreadList, type ThreadListFilters } from "../components/mail/thread-list";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/** Sentinel for "no account filter": a Radix select item cannot carry an
 * empty value, and this can never collide with an account id. */
const ALL_ACCOUNTS = "all";

/**
 * The mail inbox (/mail): thread list on the left, the selected conversation
 * on the right.
 *
 * The selection lives in the URL (`?thread=<id>`), not in component state, so
 * a conversation can be linked to from anywhere -- the global search's mail
 * group and every record page's Mail tab both navigate here with that param.
 * Selecting from the list REPLACES the history entry, the same rule the task
 * drawer follows (components/search.tsx's own comment): moving between
 * conversations inside the inbox is not something Back should have to walk
 * through one thread at a time, while arriving from elsewhere is.
 */
export function InboxPage() {
  const navigate = useNavigate();
  const { thread: selectedId } = useSearch({ from: "/mail" });
  const { data: accounts } = useMailAccounts();

  const [accountChoice, setAccountChoice] = useState(ALL_ACCOUNTS);
  const [unread, setUnread] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const [archived, setArchived] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  // Only the non-archived own accounts, plus every other user's, are offered
  // as a filter: an archived account has stopped syncing, so filtering by it
  // shows a frozen slice of history nobody asked for. Its threads still
  // render (and still carry its chip) under every other filter.
  const filterAccounts = [
    ...(accounts?.own ?? []).filter((account) => account.archivedAt === null)
      .map((account) => ({ id: account.id, label: account.label, email: account.email })),
    ...(accounts?.others ?? []),
  ];

  // The picked account, but only while it is still one of the options: an
  // account archived in another tab (or by another user) drops out of the list
  // above, and a filter that survived that would be an invisible one -- an
  // empty inbox with nothing on screen to explain it. Derived rather than
  // reset from an effect, so there is never a render (or a fetch) using the
  // stranded id. The picker itself renders this value, so the trigger cannot
  // show a label that no longer exists either.
  const accountId = filterAccounts.some((account) => account.id === accountChoice)
    ? accountChoice : ALL_ACCOUNTS;

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
    archived: archived ? true : undefined,
  };

  function select(threadId: string) {
    void navigate({ to: "/mail", search: { thread: threadId }, replace: true });
  }

  return (
    <div data-testid="inbox" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>
        <Button data-testid="compose-button" onClick={() => setComposeOpen(true)}>
          Compose
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
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
            <FilterToggle testId="filter-archived" label="Archived" on={archived} onChange={setArchived} />
          </div>

          <ThreadList
            filters={filters}
            onSelect={select}
            selectedId={selectedId ?? null}
            // An inbox with no mail account is not an empty inbox, it is an
            // unconfigured one (spec: "Empty state points at Settings ->
            // Mail"), and that reading beats the archived/unfiltered wording:
            // with no account there is nothing to have archived either.
            emptyLabel={noActiveAccount ? (
              <span data-testid="inbox-no-account">
                No mail account yet.{" "}
                <Link to="/settings/mail" className="font-medium text-slate-900 underline hover:text-slate-700">
                  Add one in Settings {"\u2192"} Mail
                </Link>{" "}
                to start syncing your inbox.
              </span>
            ) : archived ? "No archived conversations" : "No conversations"}
          />
        </div>

        <div className="min-w-0">
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
