import { memo, useMemo } from "react";
import { clsx } from "clsx";
import type { MailAccountWithSyncStats, MailUnreadFolderCount } from "@conduit/shared";
import { useMailFolders, useUnreadMailCountsByFolder } from "../../queries";
import { buildFolderRows } from "./mail-lib";

/**
 * Picking a folder names the account it belongs to as well: with two accounts,
 * "INBOX" alone would mean both of them (see the section note). Both arguments
 * are null for the "All mail" row, which clears the folder AND the account
 * filter -- it is the row that means "everything".
 *
 * TWO ARGUMENTS, NOT ONE OBJECT, because this function's identity is a prop of
 * every memoised row below: a `{ accountId, folder }` literal built at the call
 * site would be a new object on every render and defeat the memo it is passed
 * through.
 */
export type FolderChoice = (accountId: string | null, folder: string | null) => void;

export interface FolderSidebarProps {
  /** The user's OWN, non-archived accounts. Folders are owner-only server-side
   * (a foreign account 404s), so another user's mailbox has no sidebar here --
   * their threads still appear in the unfiltered list, chipped with their
   * account label, exactly as before. */
  accounts: readonly MailAccountWithSyncStats[];
  /** The folder currently being viewed, byte-exact, or null for "all mail". */
  folder: string | null;
  /** The account the current folder view is scoped to, when it is scoped. */
  accountId: string | null;
  /** Held still while the inbox is waiting on a bulk request: changing the view
   * mid-flight would clear the selection that request was made from. */
  disabled?: boolean;
  onSelect: FolderChoice;
}

/** One stable empty array, so a render before the counts arrive does not hand
 * every section a new `[]` and re-render all of them. */
const NO_COUNTS: readonly MailUnreadFolderCount[] = [];

/**
 * The inbox's folder rail: one section per own account, each listing that
 * account's synced folders with their unread badges.
 *
 * WHAT THE BADGES MEAN (the two-scope ruling, spec's Bulk API section): each
 * one is that folder's OWN unread count, straight from
 * `?byFolder=1` -- including Trash, whose badge honestly counts the unread mail
 * in Trash. The nav badge in the shell is the other scope ("unread anywhere,
 * excluding Trash") and the two are not meant to add up. Nothing is re-derived
 * client-side; these render exactly what the API returned.
 *
 * WHAT ONE COUNT ROW COVERS: the counts carry no accountId, so two accounts'
 * INBOXes are ONE row and both sections show the same number. That is the
 * endpoint's documented shape for v0.6.0 (single-account installs are this
 * release's target) and a per-account badge needs an account-scoped variant it
 * does not have. The LIST is scoped correctly regardless -- picking a folder
 * scopes the view to its account too, and the route builds one combined EXISTS
 * for the pair.
 */
export function FolderSidebar(props: FolderSidebarProps) {
  // ABOVE the rail, so that the counts query below is never mounted for a user
  // with no own mail account: there is no sidebar to badge, and the request
  // would be one more thing for an unconfigured install's empty inbox to do
  // before showing "add a mail account". A hook cannot be skipped, so the
  // component holding it is what is skipped instead.
  if (props.accounts.length === 0) return null;
  return <FolderRail {...props} />;
}

function FolderRail({ accounts, folder, accountId, disabled = false, onSelect }: FolderSidebarProps) {
  // One query for every account's badges, mounted once here rather than per
  // section: it is a single grouped request, and the sections join to it by
  // name.
  const { data: counts } = useUnreadMailCountsByFolder();

  return (
    <nav data-testid="folder-sidebar" aria-label="Folders" className="flex min-w-0 flex-col gap-3">
      <FolderButton
        label="All mail"
        // Not `folder-all`: folder rows below are addressed as
        // `folder-<NAME>`, and a mailbox literally called "all" -- an ordinary
        // name, and the one Gmail's IMAP gateway uses for [Gmail]/All Mail --
        // would collide with it. `folder-view-all` names the VIEW, which is
        // what this row is: no folder filter at all.
        testId="folder-view-all"
        unread={null}
        accountId={null}
        folder={null}
        active={folder === null}
        disabled={disabled}
        onSelect={onSelect}
      />
      {accounts.map((account) => (
        <AccountFolders
          key={account.id}
          account={account}
          counts={counts ?? NO_COUNTS}
          showLabel={accounts.length > 1}
          folder={folder}
          accountId={accountId}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
}

/**
 * One account's section. A component per account, not a loop over a combined
 * query: `useMailFolders` is per-account (that is the key the server publishes)
 * and hooks cannot be called in a loop, so the account that is not on screen
 * mounts no observer -- the same argument thread-list.tsx's per-kind link chips
 * make.
 *
 * MEMOISED, like the thread rows and for the same reason: this rail sits beside
 * the busiest list in the app and re-renders with it, while its own inputs
 * change only when mail arrives. Every prop is either a value React Query hands
 * out (stable between refetches), a primitive, or the caller's stable callback,
 * so the default shallow comparison is the right one.
 */
const AccountFolders = memo(function AccountFolders({
  account, counts, showLabel, folder, accountId, disabled, onSelect,
}: {
  account: MailAccountWithSyncStats;
  counts: readonly MailUnreadFolderCount[];
  showLabel: boolean;
  folder: string | null;
  accountId: string | null;
  disabled: boolean;
  onSelect: FolderChoice;
}) {
  const { data: folders } = useMailFolders(account.id);

  const rows = useMemo(
    () => buildFolderRows(folders ?? [], counts, { trashFolder: account.trashFolder }),
    [folders, counts, account.trashFolder],
  );

  if (rows.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {showLabel && (
        <span className="truncate px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {account.label}
        </span>
      )}
      {rows.map((row) => (
        <FolderButton
          key={row.folder}
          label={row.folder}
          // The plan's testid, verbatim. With several accounts two sections can
          // carry the same folder NAME and therefore the same testid; the names
          // are the only stable identity a folder has (the picker and the
          // filter both address folders by name), and the e2e journey runs one
          // account.
          testId={`folder-${row.folder}`}
          unread={row.unread}
          stale={row.stale}
          accountId={account.id}
          folder={row.folder}
          active={folder === row.folder && (accountId === null || accountId === account.id)}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
});

/** Memoised too: a rail of a dozen of these re-rendering on every keystroke in
 * the filter bar is the cost AccountFolders' own memo exists to avoid, and it
 * would pay it back one level down. Its props are all primitives plus the
 * caller's stable onSelect -- which is why the click passes its ids as
 * arguments rather than closing over an object. */
const FolderButton = memo(function FolderButton({
  label, testId, unread, stale = false, accountId, folder, active, disabled, onSelect,
}: {
  label: string;
  testId: string;
  /** null on "All mail", which has no per-folder count of its own -- the nav
   * badge already answers "unread anywhere". */
  unread: number | null;
  stale?: boolean;
  accountId: string | null;
  folder: string | null;
  active: boolean;
  disabled: boolean;
  onSelect: FolderChoice;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onClick={() => onSelect(accountId, folder)}
      className={clsx(
        // 28px at a desk, measured, and the whole folder rail is a full screen
        // of its own below the breakpoint (pages/inbox.tsx's drill-in stack) --
        // so these rows are the entire target on that screen and the 44px
        // floor belongs on them. Scoped, like every floor in this phase: an
        // unscoped one would grow the desktop rail. The row is already a
        // centring flex line, so the label does not move within the taller box.
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm disabled:opacity-50 max-md:min-h-11",
        active ? "bg-slate-200 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      <span className={clsx("min-w-0 flex-1 truncate", stale && "italic text-slate-400")}>{label}</span>
      {stale && (
        // A folder the last discovery pass did not see -- deleted or renamed on
        // the server -- that the CRM still holds mail in. It stays clickable so
        // that mail is reachable; the title says why it looks different.
        <span className="shrink-0 text-[10px] uppercase text-slate-400" title="Not seen in the last sync">
          gone
        </span>
      )}
      {unread !== null && unread > 0 && (
        <span className="shrink-0 rounded-full bg-slate-900 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {unread}
        </span>
      )}
    </button>
  );
});
