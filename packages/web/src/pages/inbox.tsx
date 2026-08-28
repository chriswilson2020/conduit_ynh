import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { clsx } from "clsx";
import type { BulkThreadActionKind } from "@conduit/shared";
import { useBulkThreadAction, useMailAccounts } from "../queries";
import { useLatest } from "../hooks";
import { useIsMobile } from "../use-is-mobile";
import { inboxStackView } from "./inbox-lib";
import { BulkBar, BulkResult, type BulkOutcome } from "../components/mail/bulk-bar";
import { Composer } from "../components/mail/composer";
import { Conversation } from "../components/mail/conversation";
import { FolderSidebar } from "../components/mail/folder-sidebar";
import {
  ThreadList, type ThreadListFilters, type ThreadRowInfo, type ThreadToggle,
} from "../components/mail/thread-list";
import { identityKey } from "../lib";
import {
  allOnPageSelected,
  bulkErrorMessage,
  emptySelection,
  extendThreadSelection,
  selectedThreadIds,
  selectionForKey,
  summarizeBulkResult,
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
 * clears it by construction -- the same principle CursorPages uses for paging,
 * and for the same reason (there is no render in which the new view holds the
 * old view's selection).
 *
 * BELOW THE BREAKPOINT THE GRID BECOMES A DRILL-IN STACK -- folders, threads,
 * conversation, one screen at a time (Phase 6, the second of the three
 * sanctioned useIsMobile() sites). What that costs this file is deliberately
 * small: the SAME three panes render, in the SAME grid, and the stack only
 * decides which of them is on screen. Nothing is duplicated for the phone, so
 * every testid stays a single element on the page and no pane loses its state
 * by being off screen -- see the grid's own comment for why that second point
 * matters more here than it looks.
 *
 * Above the breakpoint inboxStackView returns the desktop view for every other
 * input, so every branch below resolves to exactly what this file rendered
 * before the phase, class strings included.
 */
export function InboxPage() {
  const navigate = useNavigate();
  const { thread: selectedId } = useSearch({ from: "/mail" });
  const { data: accounts } = useMailAccounts();
  const isMobile = useIsMobile();

  const [accountChoice, setAccountChoice] = useState(ALL_ACCOUNTS);
  const [folder, setFolder] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  /**
   * The ONE piece of state the stack adds, and only because there is nothing
   * to derive it from: the folder screen is a place the user asks to go, not
   * a consequence of anything already in the URL. The other two levels are
   * derived -- the conversation from `?thread=`, the thread list from its
   * absence -- which is why opening a thread needs no state write to navigate
   * and a deep link lands on the right screen with no effect to fix it up.
   */
  const [foldersOpen, setFoldersOpen] = useState(false);

  // Only the non-archived own accounts, plus every other user's, are offered
  // as a filter: an archived account has stopped syncing, so filtering by it
  // shows a frozen slice of history nobody asked for. Its threads still
  // render (and still carry its chip) under every other filter.
  //
  // Memoised on the query's own data identity, which React Query only replaces
  // when the accounts actually change: this array is a prop of the folder rail,
  // whose sections are memoised, and a fresh array on every keystroke in the
  // filter bar would re-render every account's folder list for nothing.
  const ownActive = useMemo(
    () => (accounts?.own ?? []).filter((account) => account.archivedAt === null),
    [accounts],
  );
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
    hidden: hidden ? true : undefined,
    folder: folder ?? undefined,
  };

  // The filter identity BOTH the paging accumulator and the selection are keyed
  // on -- computed once here so the two cannot drift apart.
  const filterKey = identityKey({ ...filters });

  const [selectionState, setSelectionState] = useState<ThreadSelection>(() => emptySelection(filterKey));
  const selection = selectionForKey(selectionState, filterKey);
  const [rows, setRows] = useState<readonly ThreadRowInfo[]>([]);

  // The key as of the last committed render, for the toggle callbacks below.
  // They must be STABLE -- every memoised row takes the one the list derives
  // from them -- so the key they act under travels through a ref rather than a
  // dependency. Written from an effect (see useLatest), never during render: a
  // render React discards must not be able to move it.
  const keyRef = useLatest(filterKey);

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

  /**
   * What the last bulk action did, WITH the filter key it was done under.
   *
   * It lives here rather than in the bar because the bar does not survive it:
   * a completed action drops the selection, the bar is rendered only while the
   * selection is non-empty, and the two state updates are one batched render --
   * so a result held in the bar was destroyed before it could be painted, and
   * every sentence of that feedback (per-thread notes, the Settings link, the
   * timeout copy) was unreachable on this surface. Held here, it renders AFTER
   * the rows it describes have gone, which is exactly when it is worth reading.
   *
   * Keyed like the selection, and for the same reason: "2 moved to Trash" is a
   * statement about a view, and switching folder or filter leaves that view.
   * Stamped from the ref at the moment the outcome arrives, so a result cannot
   * outlive a view that is already gone.
   */
  const [outcome, setOutcome] = useState<{ key: string; outcome: BulkOutcome } | null>(null);
  const handleOutcome = useCallback((next: BulkOutcome | null) => {
    setOutcome(next === null ? null : { key: keyRef.current, outcome: next });
  }, [keyRef]);
  const dismissOutcome = useCallback(() => setOutcome(null), []);
  const shownOutcome = outcome !== null && outcome.key === filterKey ? outcome.outcome : null;

  /**
   * THE BULK MUTATION LIVES HERE, not in the bar, and this is not tidiness.
   *
   * A mutation observer fires the callbacks passed to `mutate` only while the
   * component that called it still has listeners -- i.e. only while it is
   * mounted (@tanstack/query-core's mutationObserver's own `hasListeners`
   * guard). The bar unmounts the moment the selection clears, which is what a
   * completed action does, so a mutation owned by the bar is one whose result
   * can be dropped on the floor whenever the two race. Owned by the page, which
   * outlives every selection, the callbacks always run.
   *
   * `isPending` is likewise a fact about the PAGE. Held in the bar, it was
   * reborn `false` with each new bar: clearing the selection mid-flight and
   * ticking another row produced a bar that cheerfully offered Trash again while
   * the first request was still queued behind an account's serial sync loop --
   * two moves of overlapping rows, the second acting on whatever the first had
   * left behind. Everything that can change the request or the view it was made
   * in is disabled while it runs (below).
   */
  const bulk = useBulkThreadAction();
  const pendingAction = bulk.isPending ? bulk.variables?.action ?? null : null;
  const busy = pendingAction !== null;

  // Reference-guarded so a re-render that produced the same rows cannot loop
  // through this back into a new state object. Both fields compare: a refetch
  // that flips a row's ownedByViewer (a new message landing on an account the
  // viewer owns) must reach the bulk bar's gating below, not be swallowed as
  // "same ids".
  const handleRows = useCallback((next: ThreadRowInfo[]) => {
    setRows((current) => (current.length === next.length
      && current.every((row, i) => row.id === next[i]?.id && row.ownedByViewer === next[i]?.ownedByViewer)
      ? current : next));
  }, []);

  const rowOrder = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedThreads = selectedThreadIds(selection, filterKey, rowOrder);
  // Selected AND visible AND unowned -- exactly the rows a move request would
  // send that the server's ownership rule would skip whole. One is enough to
  // grey Archive/Trash on the bar (mail-lib's bulkOwnershipBlocked); Hide
  // stays live for everyone.
  const unownedSelected = useMemo(
    () => rows.filter((row) => selection.ids.has(row.id) && !row.ownedByViewer).length,
    [rows, selection],
  );

  /**
   * Send one bulk action for the current selection.
   *
   * The order of the two callbacks' effects is what makes the feedback
   * survivable: the outcome lands in THIS component's state, and only then is
   * the selection dropped (which unmounts the bar). Nothing here invites a
   * retry -- for `trash` a blind second attempt would move whatever is now in
   * the source folder -- so the hook refetches from onSettled instead.
   */
  const runBulk = useCallback((action: BulkThreadActionKind) => {
    if (selectedThreads.length === 0) return;
    handleOutcome(null);
    bulk.mutate(
      {
        threadIds: [...selectedThreads],
        // `hide` ignores folder server-side either way; sending it only for the
        // two move actions keeps the request saying exactly what it means. With
        // no folder filter there is no folder view, so the request carries the
        // whole-thread mode instead (see BulkBarProps.folder).
        ...(folder !== null && action !== "hide" ? { folder } : {}),
        action,
      },
      {
        onSuccess: (result) => {
          handleOutcome({ kind: "summary", summary: summarizeBulkResult(action, result.results) });
          clearSelection();
        },
        // A throw is not necessarily a failed action: a proxy 504 means the
        // ANSWER was lost while the queued moves carry on (routes/mail.ts).
        onError: (error) => {
          handleOutcome({ kind: "failure", message: bulkErrorMessage(error) });
          clearSelection();
        },
      },
    );
  }, [bulk, clearSelection, folder, handleOutcome, selectedThreads]);

  // Stable, so the memoised rows in thread-list can bail out: a new closure
  // here every render would defeat their shallow comparison one prop before it
  // started. Both writes keep it that way -- a state SETTER is stable, and the
  // param is written through `navigate` rather than read from anywhere here.
  //
  // BELOW THE BREAKPOINT THIS IS ALSO THE DRILL-IN. The level is derived from
  // the param, so opening a conversation IS the navigation to its screen and
  // there is no second gesture to keep in step. The folder screen is closed
  // alongside it so that Back from the conversation lands on the thread list
  // even when the user reached the row from the folder rail.
  const select = useCallback((threadId: string) => {
    setFoldersOpen(false);
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
   *
   * "All mail" (accountId null) clears BOTH. It is the row that says
   * "everything", and leaving the account filter pinned from whichever folder
   * was clicked before would answer it with one account's mail -- a filter the
   * user did not set and, having just asked for everything, would not think to
   * look for.
   *
   * Two arguments rather than one object: this identity is a prop of every
   * memoised folder button in the rail, and an object built at the call site
   * would be a new one on every render.
   */
  const chooseFolder = useCallback((choiceAccountId: string | null, choiceFolder: string | null) => {
    setFolder(choiceFolder);
    setAccountChoice(choiceAccountId ?? ALL_ACCOUNTS);
    // Picking a folder is what the phone's folder screen is FOR, so it also
    // leaves it -- a picker that stayed open after a pick would answer the
    // gesture with the same list. Unconditional, not gated on the breakpoint:
    // above it this flag is always false already, React bails out of a write
    // that changes nothing, and gating it would put `isMobile` in this
    // callback's dependencies -- which is exactly the identity churn the
    // comment above says every memoised folder button depends on avoiding.
    setFoldersOpen(false);
  }, []);

  /**
   * The phone stack: which of the three panes is on screen, what the page is
   * called there, and how to leave. Pure, and tested as such -- pages/inbox-lib.ts
   * carries the reasoning, including why a deep-linked thread beats an open
   * folder screen.
   */
  const view = inboxStackView({
    isMobile,
    threadId: selectedId ?? null,
    foldersOpen,
    // The rail renders nothing without an own, non-archived account, so this
    // is what stops the folder screen being an empty room on an install that
    // has not added a mailbox yet.
    hasFolderRail: ownActive.length > 0,
  });

  const openFolders = useCallback(() => setFoldersOpen(true), []);

  // The two focus targets the effect below chooses between. One ref for the
  // leading control even though it is two different buttons, because only one
  // of them is ever rendered.
  const leadingRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * ONE Back, from either neighbour, always landing on the thread list.
   *
   * It clears BOTH halves of the stack's state rather than only the one the
   * current level came from. That is what makes the rule sayable in a
   * sentence: on the folder screen the param is already absent and the
   * navigate is a no-op; leaving a conversation that was deep-linked while
   * the folder screen happened to be open lands on the list, not on a screen
   * the user never asked for.
   *
   * `replace`, like every other write to this param (see the file's header):
   * moving between conversations inside the inbox is not something the
   * browser's own Back should have to walk through one thread at a time. The
   * consequence, accepted and identical to the desktop's: a system Back
   * gesture from an open conversation leaves the inbox rather than closing
   * the conversation. The control below is the affordance that does that, and
   * it is on screen at every level that has somewhere to go.
   */
  const backToThreads = useCallback(() => {
    setFoldersOpen(false);
    void navigate({ to: "/mail", search: (prev) => ({ ...prev, thread: undefined }), replace: true });
  }, [navigate]);

  /**
   * ARRIVING AT A LEVEL: start at its top, AND put focus somewhere real.
   *
   * The scroll half is the obvious one. Without it, opening a conversation
   * from a row far down a long list leaves the window scrolled to wherever
   * that row was and drops the reader into the middle of the thread. The
   * document is what scrolls here, not <main>: the root is `flex
   * min-h-screen` and a flex container's intrinsic height counts its growing
   * child's max-content contribution, so <main> only ever behaves as a scroll
   * container while its content fits (measured again on this page: at 375x812
   * with a conversation open the document is 2304 tall against an 812
   * client, and main's scrollHeight equals its own height).
   *
   * THE FOCUS HALF IS THE PRICE OF HIDING PANES RATHER THAN UNMOUNTING THEM,
   * and it was measured, not guessed: hiding the subtree that contains the
   * focused element drops focus to <body>. Focus the filter bar, drill into a
   * conversation, and `document.activeElement` was BODY -- on every drill-in,
   * and again on a Back that leaves the leading control unrendered (the
   * no-rail case). A keyboard or screen-reader user was put back at the top
   * of the document with nothing announced, on a surface whose whole point is
   * that it changed screens.
   *
   * So focus moves deliberately: to the new level's leading control when
   * there is one, and otherwise to the heading, which is made focusable with
   * tabIndex -1 rather than inventing a control that exists only to be
   * focused. The leading control is also why this must be deliberate rather
   * than left alone: with a rail, Back and Folders are the SAME element
   * relabelled, so a focus that merely stayed put would sit on a button that
   * silently became a different button.
   *
   * Keyed on the LEVEL alone. Keying on the leading control's kind as well
   * would cover one more case (the rail appearing or vanishing without a
   * level change) at the cost of a focus jump on every phone visit to this
   * page, because the rail is absent for the render before the accounts
   * query resolves -- focus would land on the heading and then hop to the
   * Folders button a moment later. The uncovered case is an account being
   * archived in another tab while this one sits on the thread list, which is
   * a focus loss nobody will meet; the jump would be met every time.
   *
   * The scroll applies to Back as well as to the two forward moves, which is
   * a trade: returning to the thread list loses the reader's place in it.
   * Restoring that place means remembering an offset per level -- state
   * parallel to the URL, which this surface is deliberately built without --
   * and the browser cannot restore it for us either, since the document's
   * height changed underneath the position while the pane was hidden.
   * Predictable beats nearly-right here.
   */
  useEffect(() => {
    if (!isMobile) return;
    window.scrollTo({ top: 0 });
    (leadingRef.current ?? headingRef.current)?.focus();
  }, [isMobile, view.level]);

  return (
    <div data-testid="inbox" className="flex flex-col gap-4">
      {/* The heading row is also the phone stack's title bar. Above the
          breakpoint `view.leading` is null, so this renders no node at all and
          the row is the two-child, justify-between row it has always been.
          Below it the three children land as leading / title / Compose, which
          is what justify-between does with three items and what a phone title
          bar looks like anyway.

          COMPOSE STAYS ON EVERY LEVEL. It is the one action here that belongs
          to no pane, and hiding it on the two screens that are not the list
          would make "write a new mail" a two-tap job from wherever the user
          happens to be -- the kind of quiet loss the phase's definition of
          done is about. */}
      <div className="flex items-center justify-between">
        {view.leading !== null && (
          <Button
            variant="ghost"
            // Two testids rather than one, because they are two different
            // promises: `inbox-back` leaves a level, `inbox-folders` opens
            // one, and a phone journey asserting the stack should not have to
            // read the label to know which it got. Neither exists above the
            // breakpoint -- this is a JS branch, not a hidden element, so a
            // desktop journey cannot see them at all.
            data-testid={view.leading.kind === "back" ? "inbox-back" : "inbox-folders"}
            onClick={view.leading.kind === "back" ? backToThreads : openFolders}
            ref={leadingRef}
          >
            {view.leading.label}
          </Button>
        )}
        {/* tabIndex only below the breakpoint, so the desktop heading keeps
            exactly the attributes it always had. -1 makes it a target for the
            level effect's focus() without putting a heading into anyone's tab
            order. */}
        <h1
          ref={headingRef}
          tabIndex={isMobile ? -1 : undefined}
          className="text-xl font-semibold text-slate-900"
        >
          {view.title}
        </h1>
        <Button data-testid="compose-button" onClick={() => setComposeOpen(true)}>
          Compose
        </Button>
      </div>

      {/* ABOVE THE BREAKPOINT each pane scrolls itself, within the viewport,
          rather than growing the page: a thread list several "load more" pages
          long would otherwise make the whole window scroll, and a row scrolled
          into view by the `?thread=` deep link would drag the conversation off
          screen with it. The height budget is the viewport minus the shell's
          header and this page's own heading row. (It always was an
          above-the-breakpoint rule -- both the cap and the per-pane scroll are
          `lg:`-gated -- and the paragraphs below say what happens under it.)

          THE PHONE STACK HIDES PANES, IT DOES NOT UNMOUNT THEM, and that is
          the load-bearing decision on this surface.

          The three panes below already stacked into one column at this width
          before the phase (the grid is `lg:`-gated), so what the stack changes
          is which of them is displayed -- not what exists. Unmounting the
          thread list to show a conversation would throw away the accumulated
          pages behind "Load more", drop its query observer so an SSE
          invalidation arriving while the reader is in a conversation refetches
          nothing, and leave this page holding the `rows` its unmount never
          retracted -- a bulk bar counting rows that are no longer listed.
          Displayed or not, every pane here stays mounted, keeps its state and
          keeps receiving exactly the invalidations it does at a desk.

          `display: none` takes the off-screen pane out of the accessibility
          tree and the tab order with it, which is right -- a screen reader on
          the conversation screen must not also be reading the list behind it
          -- BUT IT IS NOT FREE, and the cost is easy to miss because it is
          invisible on a pointer. If the focused element was in the pane being
          hidden, focus falls to <body>: measured here, focus `filter-unread`,
          drill in, and activeElement is BODY. That is why the level effect
          above moves focus deliberately rather than trusting the browser, and
          why this decision is a trade rather than a clean win.

          The class strings are the ones that shipped. Only the threads pane
          spells its display utility through a ternary, because it is the one
          pane that HAS a display utility to argue with: `flex` and `hidden`
          set the same property, and rather than depend on which of the two
          Tailwind emits last, the pane picks exactly one of them. The other
          two panes have no display utility, so appending the hidden one is
          unambiguous.

          NO HEIGHT IS SET HERE FOR THE PHONE, deliberately. The lg cap
          opposite is a desktop rule and stays one; below the breakpoint the
          document scrolls, which is what it already did at this width. A
          phone pane given its own internal scroll would need a definite
          height from something, and <main> does not provide one -- it grows
          with its content rather than capping the page (measured again on
          this page at 375x812). One scroll region beats two that disagree.
      */}
      <div className="grid gap-4 lg:h-[calc(100vh-11rem)] lg:grid-cols-[minmax(0,11rem)_minmax(0,24rem)_minmax(0,1fr)]">
        <div className={clsx("min-w-0 lg:overflow-y-auto", !view.panes.folders && "hidden")}>
          {/* Every control that could change WHICH rows are selected, or which
              view they were selected in, is disabled while a bulk request is in
              flight: the request carries ids and a folder that were true when it
              was sent, and the answer has to be readable against the same view.
              (The request itself is unaffected either way -- it is already at the
              server -- but a folder switched underneath it would clear the
              selection and file the result under a view nobody is looking at.) */}
          <FolderSidebar
            accounts={ownActive}
            folder={folder}
            accountId={accountId === ALL_ACCOUNTS ? null : accountId}
            disabled={busy}
            onSelect={chooseFolder}
          />
        </div>

        <div className={clsx(view.panes.threads ? "flex" : "hidden", "min-w-0 flex-col gap-2 lg:overflow-y-auto")}>
          <div className="flex flex-wrap items-center gap-2">
            {filterAccounts.length > 1 && (
              <div className="w-48">
                <Select value={accountId} onValueChange={setAccountChoice} disabled={busy}>
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
            <FilterToggle
              testId="filter-unread" label="Unread" on={unread} disabled={busy} onChange={setUnread}
            />
            <FilterToggle
              testId="filter-unlinked" label="Unlinked" on={unlinked} disabled={busy} onChange={setUnlinked}
            />
            {/* "Hidden", not "Archived": since Phase 4.1 an Archive is a real
                IMAP move, and this filter is the CRM-side Hidden view (the
                `hidden` list flag -- the viewer's own filed-away threads),
                which is a different thing. The testid joined the Task 3
                rename sweep (coordinator ruling, same rationale as
                hide-thread/unhide-thread): it was still spelled
                `filter-archived`, nothing referenced it yet, and the rename
                window closed with Task 4's e2e -- so it says what the chip
                does before anything came to depend on the old spelling. */}
            <FilterToggle
              testId="filter-hidden" label="Hidden" on={hidden} disabled={busy} onChange={setHidden}
            />
          </div>

          {selectedThreads.length > 0 && (
            <BulkBar
              count={selectedThreads.length}
              unowned={unownedSelected}
              capped={selection.capped}
              pendingAction={pendingAction}
              onRun={runBulk}
              onClear={clearSelection}
            />
          )}

          {/* Outside the selection gate above, on purpose: this is what the
              action LEFT BEHIND, and by the time it exists the selection is
              already empty. Mounted unconditionally so its live region is
              announced when it fills -- see BulkResult. */}
          <BulkResult outcome={shownOutcome} onDismiss={dismissOutcome} />

          <ThreadList
            filters={filters}
            onSelect={select}
            selectedId={selectedId ?? null}
            selectable
            selectionDisabled={busy}
            selectedIds={selection.ids}
            onToggleThread={toggleThread}
            onToggleAll={toggleAll}
            allSelected={allOnPageSelected(selection, filterKey, rowOrder)}
            // Neither none nor all: the header box reads as a dash rather than
            // claiming one of the two.
            someSelected={selectedThreads.length > 0}
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

        {/* The placeholder below is a DESKTOP state: on the phone this pane is
            shown only at the conversation level, which by construction is a
            level with a thread.

            WHAT A PHONE ACTUALLY MEETS WHEN THE THREAD IS GONE, measured
            rather than assumed, because the obvious answer is wrong.
            `conversation-gone` is the WARM case -- a pane that was already
            open when an ordinary refetch met the 404. A COLD deep link to a
            missing thread renders NOTHING at all: Conversation's own
            `data === undefined` guard returns null before the error branch
            has anything to say, so this div is empty at both 375 and 1280.
            On a phone that is a screen holding only Back and Compose. Not a
            dead end -- Back is in the heading row above -- but a poor screen,
            and the cause is in components/mail/conversation.tsx rather than
            here. Recorded as a phase-level finding, not patched from this
            file. */}
        <div className={clsx("min-w-0 lg:overflow-y-auto", !view.panes.conversation && "hidden")}>
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
  testId, label, on, disabled = false, onChange,
}: {
  testId: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Button
      variant={on ? "default" : "outline"}
      data-testid={testId}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      {label}
    </Button>
  );
}
