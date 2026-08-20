import { useMemo } from "react";
import { clsx } from "clsx";
import type { MailAccountWithSyncStats, MailUnreadFolderCount } from "@conduit/shared";
import { useMailFolders, useUnreadMailCountsByFolder } from "../../queries";
import { buildFolderRows, type SidebarFolderRow } from "./mail-lib";

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
  /** Picking a folder names the account it belongs to as well: with two
   * accounts, "INBOX" alone would mean both of them (see the section note). */
  onSelect: (choice: { accountId: string; folder: string } | null) => void;
}

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
export function FolderSidebar({ accounts, folder, accountId, onSelect }: FolderSidebarProps) {
  // One query for every account's badges, mounted once here rather than per
  // section: it is a single grouped request, and the sections join to it by
  // name.
  const { data: counts } = useUnreadMailCountsByFolder();

  if (accounts.length === 0) return null;

  return (
    <nav data-testid="folder-sidebar" aria-label="Folders" className="flex min-w-0 flex-col gap-3">
      <FolderButton
        label="All mail"
        testId="folder-all"
        unread={null}
        active={folder === null}
        onClick={() => onSelect(null)}
      />
      {accounts.map((account) => (
        <AccountFolders
          key={account.id}
          account={account}
          counts={counts ?? []}
          showLabel={accounts.length > 1}
          folder={folder}
          accountId={accountId}
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
 */
function AccountFolders({
  account, counts, showLabel, folder, accountId, onSelect,
}: {
  account: MailAccountWithSyncStats;
  counts: readonly MailUnreadFolderCount[];
  showLabel: boolean;
  folder: string | null;
  accountId: string | null;
  onSelect: (choice: { accountId: string; folder: string } | null) => void;
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
          active={folder === row.folder && (accountId === null || accountId === account.id)}
          onClick={() => onSelect({ accountId: account.id, folder: row.folder })}
        />
      ))}
    </div>
  );
}

function FolderButton({
  label, testId, unread, stale = false, active, onClick,
}: {
  label: string;
  testId: string;
  /** null on "All mail", which has no per-folder count of its own -- the nav
   * badge already answers "unread anywhere". */
  unread: number | null;
  stale?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
        active ? "bg-slate-200 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      <span className={clsx("min-w-0 flex-1 truncate", stale && "italic text-slate-400")}>{label}</span>
      {stale && (
        // A folder the last discovery pass did not see -- deleted or renamed on
        // the server -- that the CRM still holds unread mail in. It stays
        // clickable so that mail is reachable; the title says why it looks
        // different.
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
}
