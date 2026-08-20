import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BulkThreadActionKind } from "@conduit/shared";
import { useBulkThreadAction } from "../../queries";
import {
  bulkActionBlocked,
  bulkErrorMessage,
  summarizeBulkResult,
  type BulkActionSummary,
} from "./mail-lib";
import { Button } from "../ui/button";

export interface BulkBarProps {
  /** The selected threads, in visible order. Already filtered to rows still on
   * screen (mail-lib's selectedThreadIds). */
  threadIds: readonly string[];
  /**
   * The folder the selection was made in, or undefined when the list has no
   * folder filter -- and the difference is the request's MODE, not a detail.
   *
   * THE UNFILTERED LIST SENDS NO FOLDER (coordinator ruling). The spec scopes a
   * multi-select to "the current folder view"; with no folder filter there is
   * no such view, the list is all mail, and the honest reading of "archive
   * these conversations" there is the whole-thread mode the API already
   * supports for the single-thread surfaces -- every message of the thread
   * except those already in the target and those in the account's Sent folder,
   * which archiving must never empty. The alternative (refusing to act, or
   * inventing INBOX as the scope) would either disable the bar in the default
   * view or silently leave half a conversation behind.
   */
  folder: string | undefined;
  /** Called after a completed action, so the caller can drop the selection. */
  onDone: () => void;
  onClear: () => void;
}

/**
 * The bar that appears while rows are selected: Archive, Trash, Hide in CRM.
 *
 * All three go through POST /api/mail/threads/bulk. The first two MOVE mail on
 * the IMAP server (to the account's Archive/Trash folder); the third is the
 * CRM-only thread archive, renamed "Hide in CRM" everywhere so the two can
 * never be confused.
 *
 * FEEDBACK BRANCHES ON `reason` CODES, never on message text -- see
 * summarizeBulkResult, which owns every sentence this renders. The summary
 * distinguishes moved / skipped / failed rather than reporting "done", because
 * a bulk action routinely half-succeeds and "nothing happened" must not look
 * like success.
 */
export function BulkBar({ threadIds, folder, onDone, onClear }: BulkBarProps) {
  const bulk = useBulkThreadAction();
  const [summary, setSummary] = useState<BulkActionSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function run(action: BulkThreadActionKind) {
    setSummary(null);
    setFailure(null);
    bulk.mutate(
      {
        threadIds: [...threadIds],
        // `hide` ignores folder server-side either way; sending it only for the
        // two move actions keeps the request saying exactly what it means.
        ...(folder !== undefined && action !== "hide" ? { folder } : {}),
        action,
      },
      {
        onSuccess: (result) => {
          setSummary(summarizeBulkResult(action, result.results));
          onDone();
        },
        // A throw here is not necessarily a failed action: a proxy 504 means the
        // ANSWER was lost while the queued moves carry on (routes/mail.ts).
        // bulkErrorMessage says so, the hook's onSettled has already refetched,
        // and the selection is dropped so nothing invites a blind retry -- which
        // for `trash` would move whatever is now in the source folder.
        onError: (error) => {
          setFailure(bulkErrorMessage(error));
          onDone();
        },
      },
    );
  }

  const count = threadIds.length;

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="bulk-bar"
        role="toolbar"
        aria-label="Bulk actions"
        className="flex flex-wrap items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2"
      >
        <span className="text-sm font-medium text-slate-700">
          {count} selected
        </span>
        <BulkButton
          testId="bulk-archive"
          label="Archive"
          action="archive"
          count={count}
          pending={bulk.isPending}
          onRun={run}
        />
        <BulkButton
          testId="bulk-trash"
          label="Trash"
          action="trash"
          count={count}
          pending={bulk.isPending}
          onRun={run}
        />
        <BulkButton
          testId="bulk-hide"
          label="Hide in CRM"
          action="hide"
          count={count}
          pending={bulk.isPending}
          onRun={run}
        />
        <Button variant="ghost" data-testid="bulk-clear" onClick={onClear} disabled={bulk.isPending}>
          Clear
        </Button>
      </div>

      {/* Announced rather than only shown: the rows this describes have just
          left the list, so a screen reader user has nothing else to go on. */}
      {(summary !== null || failure !== null) && (
        <div data-testid="bulk-result" role="status" aria-live="polite" className="flex flex-col gap-1 px-1">
          {failure !== null && <p className="text-sm text-red-600">{failure}</p>}
          {summary !== null && (
            <>
              <p className="text-sm font-medium text-slate-700">{summary.headline}</p>
              {summary.notes.map((note) => (
                <p key={note} className="text-xs text-slate-500">{note}</p>
              ))}
              {summary.settingsLink && (
                <Link
                  to="/settings/mail"
                  className="self-start text-xs font-medium text-slate-900 underline hover:text-slate-700"
                >
                  Open Settings {"\u2192"} Mail
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One action button, disabled with the server's own reason when the selection
 * is larger than that action's per-request cap (50 for the two that wait on a
 * mail server, 200 for the CRM-side hide). */
function BulkButton({
  testId, label, action, count, pending, onRun,
}: {
  testId: string;
  label: string;
  action: BulkThreadActionKind;
  count: number;
  pending: boolean;
  onRun: (action: BulkThreadActionKind) => void;
}) {
  const blocked = bulkActionBlocked(action, count);
  return (
    <Button
      variant="outline"
      data-testid={testId}
      disabled={pending || blocked !== null}
      title={blocked ?? undefined}
      onClick={() => onRun(action)}
    >
      {label}
    </Button>
  );
}
