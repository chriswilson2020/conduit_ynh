import { Link } from "@tanstack/react-router";
import type { BulkThreadActionKind } from "@conduit/shared";
import {
  bulkActionBlocked,
  bulkPendingLabel,
  selectionLabel,
  type BulkActionSummary,
} from "./mail-lib";
import { Button } from "../ui/button";

/**
 * What one completed bulk action left behind: the server's per-thread verdicts,
 * summarized, or the message for a call that threw.
 *
 * THIS DOES NOT LIVE IN THE BAR, and that is the point of the type existing.
 * The bar is rendered only while rows are selected, and a completed action's
 * first act is to DROP the selection (nothing may invite a blind retry -- see
 * the inbox's runBulk). Held here, the outcome would be destroyed by the same
 * batched render that produced it: state update, unmount, no paint. The whole
 * feedback surface -- headline, per-thread notes, the Settings link, the timeout
 * copy -- was unreachable that way. The owner is therefore whoever outlives the
 * selection (pages/inbox.tsx), which renders BulkResult below with it.
 */
export type BulkOutcome =
  | { kind: "summary"; summary: BulkActionSummary }
  | { kind: "failure"; message: string };

export interface BulkBarProps {
  /** How many threads the action would be sent for. */
  count: number;
  /** What the last gesture asked for, when the cap cut it short (mail-lib's
   * ThreadSelection.capped) -- shown as text, not as a tooltip. */
  capped: number | null;
  /** The action currently in flight, or null. The MUTATION ITSELF lives in the
   * inbox page: a mutation observer only fires its per-call callbacks while the
   * component that called `mutate` is still mounted, and this component is
   * unmounted by its own success. */
  pendingAction: BulkThreadActionKind | null;
  onRun: (action: BulkThreadActionKind) => void;
  onClear: () => void;
}

/**
 * The bar that appears while rows are selected: Archive, Trash, Hide in CRM.
 *
 * All three go through POST /api/mail/threads/bulk (see the inbox page, which
 * owns the mutation). The first two MOVE mail on the IMAP server (to the
 * account's Archive/Trash folder); the third is the CRM-only thread archive,
 * renamed "Hide in CRM" everywhere so the two can never be confused.
 *
 * `role="group"`, not `role="toolbar"`: a toolbar is a single tab stop with
 * arrow-key navigation between its controls, and implementing none of that
 * while claiming the role leaves a keyboard user pressing arrows at buttons
 * that do not respond. A labelled group is what this actually is.
 */
export function BulkBar({ count, capped, pendingAction, onRun, onClear }: BulkBarProps) {
  const pending = pendingAction !== null;
  return (
    <div
      data-testid="bulk-bar"
      role="group"
      aria-label="Bulk actions"
      aria-busy={pending}
      className="flex flex-col gap-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="bulk-count" className="text-sm font-medium text-slate-700">
          {selectionLabel(count, capped)}
        </span>
        <BulkButton
          testId="bulk-archive" label="Archive" action="archive"
          count={count} pending={pending} onRun={onRun}
        />
        <BulkButton
          testId="bulk-trash" label="Trash" action="trash"
          count={count} pending={pending} onRun={onRun}
        />
        <BulkButton
          testId="bulk-hide" label="Hide in CRM" action="hide"
          count={count} pending={pending} onRun={onRun}
        />
        <Button variant="ghost" data-testid="bulk-clear" onClick={onClear} disabled={pending}>
          Clear
        </Button>
      </div>

      {/* What the buttons cannot say themselves. A disabled control with a
          `title` is invisible to a touch screen and silent to a screen reader,
          so both of these are text. The pending line matters most: these
          actions queue behind a real mail server's serial loop and can take
          minutes, and a bar that only greyed out would read as a dead app. */}
      {pendingAction !== null && (
        <p data-testid="bulk-pending" role="status" className="text-xs text-slate-500">
          {bulkPendingLabel(pendingAction, count)}
        </p>
      )}
      {!pending && <BulkBlockedNote count={count} />}
    </div>
  );
}

/**
 * The cap message for whichever actions the current selection is too large for.
 * One line, not one per button: the two move actions share a cap, and "Select 50
 * or fewer" twice is noise.
 *
 * UNREACHABLE TODAY, ON PURPOSE, and kept. mail-lib caps every selection gesture
 * at SELECT_ALL_CAP, which is the move actions' own cap, so no selection this UI
 * can build is too large for any of the three -- this is the second half of a
 * belt-and-braces pair, and the belt is what the user actually meets. It stays
 * because the two numbers are independent: SELECT_ALL_CAP is a client decision
 * about one gesture, the per-action caps mirror the server's, and the day
 * select-all is allowed the outer 200 for `hide` (the obvious next step, noted
 * in mail-lib) this line is what tells a user with 200 rows ticked why Archive
 * is grey -- which is exactly why it is text and not a `title`.
 */
function BulkBlockedNote({ count }: { count: number }) {
  const moves = bulkActionBlocked("archive", count);
  const hide = bulkActionBlocked("hide", count);
  const note = hide ?? moves;
  if (note === null) return null;
  return (
    <p data-testid="bulk-blocked" className="text-xs text-amber-700">
      {note}{hide === null && " Hide in CRM still works."}
    </p>
  );
}

/** One action button, disabled while anything is in flight and while the
 * selection is larger than that action's per-request cap (50 for the two that
 * wait on a mail server, 200 for the CRM-side hide -- the reason is rendered as
 * text by BulkBlockedNote above rather than hidden in a title). */
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
      onClick={() => onRun(action)}
    >
      {label}
    </Button>
  );
}

/**
 * What one bulk action did, rendered where the bar used to render it -- by a
 * component that OUTLIVES the selection, since by the time this has anything to
 * say the rows it describes have left the list and the bar has left the page.
 *
 * THE LIVE REGION IS ALWAYS MOUNTED, and only its contents come and go. A
 * `role="status"` element that is inserted into the DOM together with its text
 * is announced unreliably -- several screen readers only watch regions that
 * were present when they took their snapshot -- so the wrapper renders
 * unconditionally and stays empty until there is something to say. That is also
 * why the dismiss button lives inside it: removing the region to hide a message
 * would take the announcer with it.
 */
export function BulkResult({
  outcome, onDismiss,
}: {
  outcome: BulkOutcome | null;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="bulk-result"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-1 px-1 empty:hidden"
    >
      {outcome !== null && (
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {outcome.kind === "failure" ? (
              <p className="text-sm text-red-600">{outcome.message}</p>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-700">{outcome.summary.headline}</p>
                {outcome.summary.notes.map((note) => (
                  <p key={note} className="text-xs text-slate-500">{note}</p>
                ))}
                {outcome.summary.settingsLink && (
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
          <button
            type="button"
            data-testid="bulk-result-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded px-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            {"\u00D7"}
          </button>
        </div>
      )}
    </div>
  );
}
