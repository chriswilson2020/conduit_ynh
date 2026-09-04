import { Link } from "@tanstack/react-router";
import type { BulkThreadActionKind } from "@conduit/shared";
import {
  bulkActionBlocked,
  bulkOwnershipBlocked,
  bulkPendingLabel,
  fileTargetsBlocked,
  selectionLabel,
  type BulkActionSummary,
} from "./mail-lib";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

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
  /** How many of them the viewer owns no account on (`ownedByViewer: false`,
   * Phase 4.2) -- one such thread disables Archive/Trash for the whole
   * selection, with the reason as text (bulkOwnershipBlocked). Hide is
   * unaffected. */
  unowned: number;
  /** What the last gesture asked for, when the cap cut it short (mail-lib's
   * ThreadSelection.capped) -- shown as text, not as a tooltip. */
  capped: number | null;
  /** The action currently in flight, or null. The MUTATION ITSELF lives in the
   * inbox page: a mutation observer only fires its per-call callbacks while the
   * component that called `mutate` is still mounted, and this component is
   * unmounted by its own success. */
  pendingAction: BulkThreadActionKind | null;
  /** The folder a pending `file` is filing into, for the pending line. */
  pendingTarget: string | null;
  /**
   * The destination folders this selection may be filed into (Phase 4.4) --
   * the CURRENT ACCOUNT'S own folder names, byte-exact as the server listed
   * them, unsyncable ones already dropped by the caller. Empty when the list
   * is not scoped to one account, which `accountScoped` tells apart from an
   * account that simply has none yet (fileTargetsBlocked words both).
   */
  folders: readonly string[];
  accountScoped: boolean;
  /**
   * The list is showing the viewer's HIDDEN threads, so the CRM-side button is
   * Unhide rather than Hide in CRM.
   *
   * SWAPPED, NOT ADDED, which is the same choice conversation.tsx makes from a
   * thread's own `hiddenAt`: the pair are inverses, exactly one of them is the
   * useful gesture for a given selection, and rendering both would put a
   * permanent no-op next to the action the user wants. In the Hidden view
   * every row is hidden by definition, so the swap needs no per-row state.
   */
  hiddenView: boolean;
  onRun: (action: BulkThreadActionKind, targetFolder?: string) => void;
  onClear: () => void;
}

/**
 * The bar that appears while rows are selected: Archive, Trash, File into…,
 * and Hide in CRM (or Unhide, in the Hidden view).
 *
 * All of them go through POST /api/mail/threads/bulk (see the inbox page,
 * which owns the mutation). The first three MOVE mail on the IMAP server --
 * Archive and Trash to the folders the ACCOUNT names, File to the one the
 * USER picks (Phase 4.4) -- while the last is the CRM-only, PER-ACTOR filing
 * act (Phase 4.3: hide rows for the clicking user alone -- nobody else's view
 * moves), labelled "Hide in CRM" everywhere so the two can never be confused.
 *
 * FILING INTO A FOLDER CONDUIT IS NOT SYNCING TURNS THAT SYNC ON, and nothing
 * here asks about it first: filing a thread into a folder IS the statement
 * that the folder matters (api: mail-move.ts's header, where the rejected
 * warn-instead design is recorded). What the user gets afterwards is a
 * sentence in the result below, not a dialog before the click.
 *
 * `role="group"`, not `role="toolbar"`: a toolbar is a single tab stop with
 * arrow-key navigation between its controls, and implementing none of that
 * while claiming the role leaves a keyboard user pressing arrows at buttons
 * that do not respond. A labelled group is what this actually is.
 */
export function BulkBar({
  count, unowned, capped, pendingAction, pendingTarget, folders, accountScoped, hiddenView,
  onRun, onClear,
}: BulkBarProps) {
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
          count={count} unowned={unowned} pending={pending} onRun={onRun}
        />
        <BulkButton
          testId="bulk-trash" label="Trash" action="trash"
          count={count} unowned={unowned} pending={pending} onRun={onRun}
        />
        <FilePicker
          count={count} unowned={unowned} pending={pending}
          folders={folders} accountScoped={accountScoped} onRun={onRun}
        />
        {hiddenView ? (
          <BulkButton
            testId="bulk-unhide" label="Unhide" action="unhide"
            count={count} unowned={unowned} pending={pending} onRun={onRun}
          />
        ) : (
          <BulkButton
            testId="bulk-hide" label="Hide in CRM" action="hide"
            count={count} unowned={unowned} pending={pending} onRun={onRun}
          />
        )}
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
          {bulkPendingLabel(pendingAction, count, pendingTarget)}
        </p>
      )}
      {!pending && (
        <BulkBlockedNote
          count={count} unowned={unowned} folders={folders} accountScoped={accountScoped}
        />
      )}
    </div>
  );
}

/**
 * The reasons the greyed-out buttons cannot give themselves, as text.
 *
 * TWO INDEPENDENT LINES, because they answer different questions and can
 * apply at once (200 rows ticked, some unowned: the cap line explains the
 * grey Hide, the ownership line the grey moves).
 *
 * The CAP line is unreachable today, on purpose, and kept. mail-lib caps
 * every selection gesture at SELECT_ALL_CAP, which is the move actions' own
 * cap, so no selection this UI can build is too large for any of the three --
 * this is the second half of a belt-and-braces pair, and the belt is what the
 * user actually meets. It stays because the two numbers are independent:
 * SELECT_ALL_CAP is a client decision about one gesture, the per-action caps
 * mirror the server's, and the day select-all is allowed the outer 200 for
 * `hide` (the obvious next step, noted in mail-lib) this line is what tells a
 * user with 200 rows ticked why Archive is grey -- which is exactly why it is
 * text and not a `title`.
 *
 * The OWNERSHIP line (Phase 4.2) is entirely reachable: tick any thread of a
 * shared or deal-linked mailbox the viewer does not own and the two moves
 * grey out with this explanation, while Hide stays live.
 */
function BulkBlockedNote({
  count, unowned, folders, accountScoped,
}: {
  count: number;
  unowned: number;
  folders: readonly string[];
  accountScoped: boolean;
}) {
  const moves = bulkActionBlocked("archive", count);
  const hide = bulkActionBlocked("hide", count);
  const capNote = hide ?? moves;
  const ownerNote = bulkOwnershipBlocked("archive", unowned);
  // The picker's own reason, and it is REACHABLE in the ordinary course of
  // using the app: a user with two mail accounts opens the inbox on "All
  // accounts", where a list of folder names would be one mailbox's names
  // pretending to be everyone's. (With ONE account the page treats "all" as
  // that account and the picker stays live -- see the inbox's fileAccountId,
  // where that case is settled.) Suppressed while the ownership note is up:
  // filing is owner-only too, so both would be showing and the ownership one
  // is the more specific answer.
  const fileNote = ownerNote === null ? fileTargetsBlocked(accountScoped, folders.length) : null;
  return (
    <>
      {capNote !== null && (
        <p data-testid="bulk-blocked" className="text-xs text-amber-700">
          {capNote}{hide === null && " Hide in CRM still works."}
        </p>
      )}
      {ownerNote !== null && (
        <p data-testid="bulk-owner-blocked" className="text-xs text-amber-700">
          {ownerNote}
        </p>
      )}
      {fileNote !== null && (
        <p data-testid="bulk-file-blocked" className="text-xs text-amber-700">
          {fileNote}
        </p>
      )}
    </>
  );
}

/**
 * "File into…": the destination picker, and the fourth bulk action.
 *
 * PICKING THE FOLDER IS THE GESTURE. There is no second "File" button to press
 * after choosing, because the choice IS the instruction -- the same one click
 * the other three buttons take, and the "one gesture" the spec asks for.
 * Nothing here is destructive in the way that would argue for a confirm step:
 * a misfiled conversation is filed back with the same control, and the mail
 * itself is never expunged.
 *
 * The value is never held. This is a trigger, not a setting: a Select that
 * remembered "Clients" would read as a filter on the bar, and the bar is gone
 * by the time the action lands anyway (the page drops the selection on
 * success). So the trigger always shows its placeholder.
 *
 * Disabled with the same three reasons as the buttons -- the cap, the
 * owner-only move rule, and the picker's own (no single account, or no folders
 * yet) -- and every one of them rendered as text by BulkBlockedNote above,
 * because a `title` on a disabled control is invisible to a touch screen and
 * silent to a screen reader.
 */
function FilePicker({
  count, unowned, pending, folders, accountScoped, onRun,
}: {
  count: number;
  unowned: number;
  pending: boolean;
  folders: readonly string[];
  accountScoped: boolean;
  onRun: (action: BulkThreadActionKind, targetFolder?: string) => void;
}) {
  const blocked = bulkActionBlocked("file", count)
    ?? bulkOwnershipBlocked("file", unowned)
    ?? fileTargetsBlocked(accountScoped, folders.length);
  return (
    <Select value="" onValueChange={(folder) => onRun("file", folder)} disabled={pending || blocked !== null}>
      <SelectTrigger
        testId="bulk-file"
        ariaLabel="File into folder"
        className="w-auto min-w-44 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <SelectValue placeholder="File into…" />
      </SelectTrigger>
      <SelectContent position="popper">
        {folders.map((folder) => (
          <SelectItem key={folder} value={folder}>{folder}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One action button, disabled while anything is in flight, while the
 * selection is larger than that action's per-request cap (50 for the two that
 * wait on a mail server, 200 for the CRM-side hide), and -- for the two moves
 * -- while any selected thread is unowned (Phase 4.2's owner-only move
 * rights). Every reason is rendered as text by BulkBlockedNote above rather
 * than hidden in a title. */
function BulkButton({
  testId, label, action, count, unowned, pending, onRun,
}: {
  testId: string;
  label: string;
  action: BulkThreadActionKind;
  count: number;
  unowned: number;
  pending: boolean;
  onRun: (action: BulkThreadActionKind) => void;
}) {
  const blocked = bulkActionBlocked(action, count) ?? bulkOwnershipBlocked(action, unowned);
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
 *
 * "ALWAYS MOUNTED" IS A CLAIM ABOUT THE DOM, NOT ABOUT THE ACCESSIBILITY
 * TREE, and the paragraph above overstated it until a Phase 6 review put the
 * two side by side. `empty:hidden` is `display: none` while the region has no
 * children, and a display:none element is not in the accessibility tree at
 * all -- so at EVERY width, this region is absent from that tree until the
 * instant it fills, which is the very situation the snapshot argument is
 * about. Picking the horn honestly: the original rationale is WEAKER than it
 * was written to be. What survives of it is real but smaller -- the node, its
 * id and its role never change, so nothing new is inserted at announce time
 * and the dismiss button still cannot take the announcer away with it -- and
 * the shape of the fix, if a screen reader is ever observed missing this, is
 * to drop `empty:hidden` for a zero-size region rather than to move the
 * region.
 *
 * THE PHONE CASE IS STILL WORSE, and is a different thing rather than the
 * same thing restated (Phase 6). This region renders inside the inbox's
 * THREADS pane, and the drill-in stack gives the panes it is not showing
 * `display: none`. With `empty:hidden` alone the region at least enters the
 * tree at the moment it fills; hidden inside a hidden pane it is out of the
 * tree when it fills AND stays out until the reader navigates back, so there
 * is no moment at which it could announce. The text itself survives -- the
 * page owns the outcome, not this component -- and is read on return. Every
 * gesture that can start a bulk action lives on the threads level, so
 * reaching this at all takes a drill-in while a request is in flight.
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
          {/* The floor on both axes, because the whole label is one glyph:
              this measured 17 x 20 before, which is the same shape of bug the
              phase already found in the task drawer's close. NOT the
              chip-remove idiom from ui/touch.ts -- that one overhangs its
              container's padding with negative margins, and this button's
              container has 4px of padding to overhang, so the hit box would
              reach past the pane's own edge. A plain box, centred, is what
              this needs. */}
          <button
            type="button"
            data-testid="bulk-result-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded px-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
          >
            {"\u00D7"}
          </button>
        </div>
      )}
    </div>
  );
}
