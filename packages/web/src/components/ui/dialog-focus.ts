import { useCallback, useRef } from "react";
import type { RefObject } from "react";

/**
 * GIVING A DIALOG'S CLOSE SOMEWHERE TO PUT THE CARET.
 *
 * Radix restores focus to the control a dialog was opened from, and it does it
 * from ONE place: `DialogContentModal` composes its own `onCloseAutoFocus`,
 * which calls `event.preventDefault()` and then
 * `context.triggerRef.current?.focus()` (@radix-ui/react-dialog
 * dist/index.mjs:154-157). `context.triggerRef` is written by `<DialogTrigger>`
 * and by nothing else.
 *
 * SO A DIALOG WITH NO `<DialogTrigger>` HAS NO RESTORE AT ALL. The ref is null,
 * the `preventDefault()` above has already disabled FocusScope's own fallback
 * (which would otherwise return the caret to whatever held it at mount --
 * @radix-ui/react-focus-scope dist/index.mjs:99), and the element that DID hold
 * focus was inside the dialog and has just been removed from the document with
 * it. The browser puts `document.activeElement` on `<body>`: a keyboard user is
 * back at the top of the document with nothing announced, and a screen-reader
 * user is told nothing at all.
 *
 * MEASURED, at 1280 and at 390. This app opens FIFTEEN `<Dialog>` roots across
 * eleven files. Five use this, and they are two different shapes:
 *
 *   the four driven by state instead of by a trigger --
 *   components/task-drawer.tsx, components/mail/composer.tsx,
 *   pages/settings-mail.tsx and pages/board.tsx's move sheet -- because the
 *   control that opens each of them is a different one on every row or card, or
 *   lives on another page entirely, so `<DialogTrigger>` cannot express it.
 *   Three of the four were measured landing on `<body>`; board's had a
 *   hand-rolled version of this and is the reason it is shared; and
 *
 *   pages/deal-detail.tsx's Lose dialog, which DOES use `<DialogTrigger>` and
 *   still fails, because a successful lose unmounts the Lose button -- Radix
 *   focuses a node on its way out and the browser answers `<body>` just the
 *   same. The same dialog DISMISSED restored its trigger correctly, so its
 *   failure is invisible unless the other exit is tried, and `forget()` below
 *   is what separates the two.
 *
 * (Sixteen roots across twelve files, and six users, until v1.2.2 removed the
 * mail template feature -- pages/settings-templates.tsx was a state-driven
 * caller and is now the quote template editor with no dialog at all. The ten
 * left to Radix below never included it, so only the first paragraph moved.)
 *
 * WHAT THE OTHER TEN ROOTS DO, AND WHY FIVE OF THEM ARE STILL LEFT ALONE. All
 * ten were measured restoring their trigger on a dismissal, and they divide
 * three ways at ROOT granularity -- five, two and three.
 *
 * FIVE ROOTS ALSO LAND ON `<body>` ON THEIR SUCCESS PATH, because they
 * `navigate()` in `onSuccess` from a trigger inside the router outlet, so the
 * whole page the trigger was on unmounts: entity-table.tsx's New (which
 * companies, contacts and projects share -- five roots, seven surfaces),
 * pipelines.tsx's, both of company-detail.tsx's, and project-detail.tsx's.
 *
 * TWO ROOTS NAVIGATE AND KEEP THEIR TRIGGER, and they are why this counts roots
 * rather than navigations: bottom-nav.tsx's More sheet and its search sheet are
 * rendered by the shell, OUTSIDE the outlet. Measured: picking a destination
 * returns the caret to More, picking a result returns it to the search icon.
 *
 * THREE ROOTS DO NOT NAVIGATE AT ALL -- a deal's New quote, the board's New
 * deal, the task board's New task -- so their trigger is simply still there.
 *
 * THAT IS A ROUTE CHANGE'S DEFECT, NOT A DIALOG'S, and it was measured that way
 * rather than argued: clicking an ordinary company ROW LINK -- no dialog within
 * reach -- and landing on the record leaves `document.activeElement` on `<body>`
 * too, for the identical reason (the anchor unmounted with the list). A sidebar
 * link, whose anchor SURVIVES the navigation, keeps focus on itself. So the
 * rule is "any navigation that unmounts the focused element", and this app has
 * far more of those through row links than through create dialogs. Fixing the
 * five here would make them the only navigations in the app that land
 * somewhere, which is a worse kind of inconsistent than landing nowhere. It is
 * recorded in the backlog as one item about routing.
 */

/**
 * The one decision, kept apart from the DOM so it can be tested rather than
 * read. `captured` is the control the dialog was opened from and `fallback` is
 * where to land when that control is no longer a place to land.
 *
 * TWO THINGS DISQUALIFY A CAPTURED CONTROL:
 *
 * - null: nothing captured it. A `?task=` deep link opens the task drawer on
 *   page load with no opener at all, and the gantt's phone tap targets are
 *   `aria-hidden` overlays that deliberately pass none.
 * - detached: the control has left the document -- an SSE update, or another
 *   tab, retiring it while the dialog merely sits open.
 *
 * `isConnected` IS NOT ENOUGH FOR A CONTROL THE DIALOG'S OWN ACTION RETIRES,
 * AND WHETHER IT IS DEPENDS ON THE MUTATION, WHICH IS WHY `forget()` EXISTS.
 * pages/deal-detail.tsx's Lose button is still connected when the caret is
 * handed back, and unmounts a frame later, so focus went to it and then to
 * `<body>` after all -- `useLoseDeal` invalidates on success, so the refetch
 * has not landed yet. Deleting that page's `forget()` puts both of its
 * lost-deal tests back on the old behaviour, which is how this is known rather
 * than believed.
 *
 * pages/board.tsx is the counter-example and it corrects an earlier claim in
 * this comment. `useMoveDeal` has an OPTIMISTIC onMutate, so the card is out of
 * the cache before the sheet closes and `isConnected` is already false: its
 * `forget()` was mutation-tested and every board test stayed green without it.
 * The first version of this file said board had been instrumented showing the
 * opposite; that reading came from a `setTimeout(0)` registered before the
 * click, which fires a whole commit earlier than the one Radix restores focus
 * in, and it was wrong. `forget()` stays there for the reason board's own
 * comment now gives, not for this one.
 *
 * A caller that knows its action has invalidated its opener calls `forget()`;
 * `isConnected` is the backstop for the event nobody can announce.
 *
 * WHAT THIS DOES NOT COVER, said plainly rather than guarded against: a control
 * that is still attached but no longer focusable -- disabled, or inside a
 * `display:none` subtree -- is returned here, and `focus()` on it is a no-op
 * that lands on `<body>` after all. No caller produces one today; a deal's New
 * quote trigger is `disabled={archived}` and would, but it is one of the ten
 * roots left to Radix, which has the same hole.
 */
export function dialogReturnTarget<T extends { isConnected: boolean }>(
  captured: T | null,
  fallback: T | null,
): T | null {
  if (captured !== null && captured.isConnected) return captured;
  return fallback;
}

/**
 * The app's content landmark, which is where focus lands when the control that
 * opened the dialog is gone. components/shell.tsx renders exactly one `<main>`
 * and gives it `tabIndex={-1}` so this can actually take.
 *
 * A LANDMARK RATHER THAN A HEADING, and the surfaces that already had a
 * post-close focus target chose a heading, so this is a real choice. A heading
 * is the better announcement, but it has to be made focusable one page at a
 * time and the two that were (pages/inbox.tsx, pages/board.tsx) are focusable
 * only below the breakpoint -- while this runs at both widths, and two of its
 * callers are components that do not know which page they are on. `<main>` is
 * one element, it is the same element everywhere, and "the caret is at the
 * start of the page's content" is a true and useful thing for a screen reader
 * to say. A caller with a better answer passes one, and two do.
 */
function mainLandmark(): HTMLElement | null {
  return document.querySelector("main");
}

/** What a dialog needs from this. */
export interface DialogReturnFocus {
  /**
   * Remember the control the dialog is being opened from. Call it from that
   * control's own click or key handler, with `event.currentTarget`, BEFORE the
   * state change that opens the dialog.
   *
   * `null` is a legitimate argument and means "this opener is not somewhere to
   * put the caret back" -- the gantt's `aria-hidden` phone tap overlays pass it.
   */
  capture: (trigger: HTMLElement | null) => void;
  /**
   * Drop the remembered control, so the close lands on the fallback. For a
   * caller that knows its action has invalidated the control: a move takes a
   * card to another stage, a lose unmounts the Lose button, archiving a task
   * takes its card off the board.
   */
  forget: () => void;
  /** The `onCloseAutoFocus` handler, and the only thing wired to Radix. */
  restore: (event: Event) => void;
}

/**
 * THE CAPTURE IS THE OPENER'S JOB, AND TWO EARLIER DESIGNS THAT TOOK IT AWAY
 * FROM THE OPENER WERE BOTH MEASURED FAILING. Both are the obvious thing to
 * try, so both are written down.
 *
 * 1. FROM RADIX'S `onOpenAutoFocus`, which is dispatched while the caret is
 *    still on the opener and looks like exactly the right moment. FocusScope
 *    gates its entire mount block on
 *    `if (!container.contains(document.activeElement))`
 *    (@radix-ui/react-focus-scope dist/index.mjs:80), so a dialog whose content
 *    marks a field `autoFocus` never dispatches it. That is three of the six
 *    callers, and all three closed onto the fallback instead of their opener --
 *    a REGRESSION for the Lose dialog, which Radix had been getting right. It is
 *    the same mechanism ui/dialog.tsx describes for OPENING focus, met from the
 *    other end.
 *
 * 2. READING `document.activeElement` ON THE RENDER WHERE `open` TURNS TRUE.
 *    This runs before the commit that moves the caret, whatever moves it, so it
 *    survives `autoFocus` -- and it is a ref written during render, which
 *    src/hooks.ts forbids in as many words and pages/inbox.tsx restates as a
 *    rule. It is worse than the case that rule was written for: the flag is an
 *    EDGE DETECTOR, so a render React throws away (suspended, interrupted,
 *    offscreen) consumes the edge permanently and the capture never happens at
 *    all -- silently, and looking exactly like the deep-link case. It also made
 *    the answer browser-dependent, since `document.activeElement` is the opener
 *    only in browsers that focus a `<button>` on click, and pages/board.tsx had
 *    passed the element explicitly since v1.1.0 precisely so it did not have to
 *    be.
 *
 * So: `event.currentTarget`, from the handler that opens the dialog. It is not
 * in the render phase, it runs before any `autoFocus`, it does not care how the
 * browser treats focus on click, and it is what board.tsx already did.
 *
 * The cost is plumbing: components/task-drawer.tsx and components/mail/composer.tsx
 * are opened from pages that mount them, so both take this object as a REQUIRED
 * prop -- required so that a new mount site is a type error rather than a
 * silent landing on `<main>`.
 *
 * `fallback` is a ref rather than a getter so `restore` can be stable: Radix
 * wraps `onCloseAutoFocus` in `useCallbackRef`, so its identity does not matter
 * to it, but a stable one keeps this hook from being a reason to re-render.
 */
export function useDialogReturnFocus(fallback?: RefObject<HTMLElement | null>): DialogReturnFocus {
  const triggerRef = useRef<HTMLElement | null>(null);

  const capture = useCallback((trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
  }, []);

  const forget = useCallback(() => {
    triggerRef.current = null;
  }, []);

  const restore = useCallback(
    (event: Event) => {
      // Radix's own restore is composed AFTER this handler and skipped once the
      // event is prevented, so this replaces it rather than racing it.
      event.preventDefault();
      const captured = triggerRef.current;
      // CLEARED SO A LATER OPEN CANNOT INHERIT THIS ONE'S TRIGGER. The paths
      // that open a dialog with no capture at all are real -- a `?task=` deep
      // link, the gantt's aria-hidden tap overlays -- and without this they
      // would be handed whatever opened the dialog last.
      //
      // REDUNDANT TODAY AND KEPT ANYWAY, said plainly rather than dressed up:
      // every one of those paths arrives after a NAVIGATION, which detaches the
      // previous trigger, so `isConnected` would refuse it regardless. That is
      // why no test covers this line. It keeps the invariant local instead of
      // resting on a fact about routing.
      //
      // ITS ONE HAZARD IS THE OPPOSITE OF WHAT IT READS LIKE. `restore` runs a
      // macrotask after the unmount, so a dialog re-opened INSIDE that window
      // has its fresh capture cleared by the previous close and lands on the
      // fallback. That needs a click between a dialog's unmount and the next
      // macrotask, which is not a gesture anyone could make, and it costs one
      // degraded landing rather than a lost caret.
      triggerRef.current = null;
      const target = dialogReturnTarget(captured, fallback?.current ?? mainLandmark());
      target?.focus();
    },
    [fallback],
  );

  return { capture, forget, restore };
}

/**
 * What a consumer gets when no provider is above it -- see
 * components/task-drawer.tsx's context, which is the only thing that needs a
 * default at all.
 *
 * A CAPTURE-LESS INSTANCE RATHER THAN A NO-OP, deliberately. Nothing captures,
 * so every close lands on the content landmark, which is exactly what the hook
 * itself does when its opener never recorded one. A `throw` would turn a
 * missing provider into a blank page, and a silent no-op would hand the close
 * back to Radix, which for a trigger-less dialog means `<body>` -- the bug.
 * Degrading to the fallback is the only one of the three that cannot make
 * things worse than they were.
 */
export const NO_RETURN_FOCUS: DialogReturnFocus = {
  capture: () => undefined,
  forget: () => undefined,
  restore: (event: Event) => {
    event.preventDefault();
    mainLandmark()?.focus();
  },
};
