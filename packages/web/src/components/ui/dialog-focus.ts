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
 * back at the top
 * of the document with nothing announced, and a screen-reader user is told
 * nothing at all.
 *
 * MEASURED, at 1280 and at 390, before this existed. This app opens SIXTEEN
 * `<Dialog>` roots across twelve files; five of them landed on `<body>`, and
 * they are two different shapes:
 *
 *   the four dialogs driven by state instead of by a trigger --
 *   components/task-drawer.tsx, components/mail/composer.tsx,
 *   pages/settings-mail.tsx, pages/settings-templates.tsx -- because the
 *   control that opens each of them is a different one on every row, or lives
 *   on another page entirely, so `<DialogTrigger>` cannot express it; and
 *
 *   pages/deal-detail.tsx's Lose dialog, which DOES use `<DialogTrigger>` and
 *   still fails, because a successful lose unmounts the Lose button -- Radix
 *   focuses a node that is on its way out and the browser answers `<body>`
 *   just the same. The same dialog DISMISSED restored its trigger correctly,
 *   so that one site is both a pass and a failure depending on how it is
 *   closed, and `forget()` below is what separates the two.
 *
 * ELEVEN OF THE SIXTEEN ARE TRIGGER-DRIVEN, AND ALL ELEVEN WERE MEASURED
 * RESTORING THEIR TRIGGER on a dismissal -- the Lose dialog included, which is
 * exactly why its failure is invisible unless the other exit is tried. Ten of
 * them need nothing at all and are deliberately left to Radix: nothing else
 * here has a trigger that its own dialog retires. A new one that does should
 * reach for this.
 *
 * A SIXTH CALLER IS WHAT MADE THIS SHARED. pages/board.tsx's move sheet had the
 * first hand-rolled version, with a comment recording the cause; the others are
 * what that comment predicted. It is the fifth state-driven root and the one
 * that already worked.
 */

/**
 * The one decision, kept apart from the DOM so it can be tested rather than
 * read. `captured` is the control the dialog was opened from, `body` is
 * `document.body`, and `fallback` is where to land when the control is no
 * longer a place to land.
 *
 * THREE THINGS DISQUALIFY A CAPTURED CONTROL and each of them happens here:
 *
 * - null: nothing held focus when the dialog opened. A `?task=` deep link
 *   opens the task drawer on page load with no opener at all.
 * - the body: the same case seen from the other side. `document.activeElement`
 *   is `<body>` rather than null in a live document with nothing focused, and
 *   focusing `<body>` is a no-op that lands exactly where the bug lands.
 * - detached: the control has left the document -- an SSE update, or another
 *   tab, retiring it while the dialog merely sits open.
 *
 * `isConnected` IS NOT ENOUGH FOR A CONTROL THE DIALOG'S OWN ACTION RETIRES,
 * and that was measured rather than reasoned: pages/deal-detail.tsx's Lose
 * button was still connected at the moment the caret was handed back to it,
 * and unmounted a frame later, so focus went to it and then to `<body>` after
 * all. A caller that knows its action has invalidated its opener calls
 * `forget()`; `isConnected` is the backstop for the event nobody can announce.
 *
 * WHAT THIS DOES NOT COVER, said plainly rather than guarded against: a control
 * that is still attached but no longer focusable -- disabled, or inside a
 * `display:none` subtree -- is returned here, and `focus()` on it is a no-op
 * that lands on `<body>` after all. Nothing in this app produces one (the six
 * callers' openers are ordinary buttons, links and cards that are either there
 * or gone), and a post-focus repair would be a branch no test could reach.
 */
export function dialogReturnTarget<T extends { isConnected: boolean }>(
  captured: T | null,
  body: T,
  fallback: T | null,
): T | null {
  if (captured !== null && captured !== body && captured.isConnected) return captured;
  return fallback;
}

/**
 * The app's content landmark, which is where focus lands when the control that
 * opened the dialog is gone. components/shell.tsx renders exactly one `<main>`
 * and gives it `tabIndex={-1}` so this can actually take.
 *
 * A LANDMARK RATHER THAN A HEADING, and the two surfaces that already had a
 * post-close focus target chose a heading, so this is a real choice. A heading
 * is the better announcement, but it has to be made focusable one page at a
 * time and the two that are (pages/inbox.tsx, pages/board.tsx) are focusable
 * only below the breakpoint -- while this runs at both widths, and two of its
 * callers are components that do not know which page they are on. `<main>` is
 * one element, it is the same element everywhere, and "the caret is at the
 * start of the page's content" is a true and useful thing for a screen reader
 * to say. A caller with a better answer passes one.
 */
function mainLandmark(): HTMLElement | null {
  return document.querySelector("main");
}

/** What a dialog needs from this. */
export interface DialogReturnFocus {
  /**
   * Drop the remembered control, so the close lands on the fallback. For a
   * caller that knows its action has invalidated the control -- pages/board.tsx
   * moves a deal to another stage, and the card it was moved from is not
   * somewhere to send the caret back to even in the moment before it unmounts.
   */
  forget: () => void;
  /** The `onCloseAutoFocus` handler, and the only thing a caller has to wire. */
  restore: (event: Event) => void;
}

/**
 * `open` is read rather than a `capture()` a caller calls, AND THE FIRST DRAFT
 * OF THIS DID IT THE OTHER WAY AND WAS WRONG IN A WAY WORTH RECORDING.
 *
 * The obvious capture point is Radix's `onOpenAutoFocus`: it is dispatched
 * while the caret is still on the opener, which is exactly the moment wanted.
 * But FocusScope gates its whole mount block on
 * `if (!container.contains(document.activeElement))` (@radix-ui/react-focus-scope
 * dist/index.mjs:80), so a dialog whose content marks a field `autoFocus`
 * never dispatches that event at all -- React has already put the caret inside
 * before FocusScope's effect runs. That is the same mechanism ui/dialog.tsx
 * describes for OPENING focus, met from the other end.
 *
 * MEASURED, on the draft that captured there: pages/settings-mail.tsx,
 * pages/settings-templates.tsx and pages/deal-detail.tsx's Lose all have an
 * `autoFocus` field, and all three closed onto the `<main>` fallback instead of
 * their opener -- which for the Lose dialog was a REGRESSION, since Radix had
 * been restoring its trigger correctly on a dismissal. The other two callers
 * have no `autoFocus` and worked. A capture point that three of six callers
 * silently skip is not a capture point.
 *
 * SO IT IS TAKEN ON THE RENDER WHERE `open` TURNS TRUE, which is before the
 * commit that moves the caret, whatever moves it. React documents this pattern
 * -- adjusting a ref while rendering when a prop changes -- and the read is of
 * external state that no render of this component can alter. Under
 * StrictMode's double render the second pass sees the edge already consumed
 * and skips, keeping the first pass's answer.
 *
 * `fallback` is a ref rather than a getter so `restore` can be stable: Radix
 * wraps `onCloseAutoFocus` in `useCallbackRef`, so its identity does not matter
 * to it, but a stable one keeps this hook from being a reason to re-render.
 */
export function useDialogReturnFocus(
  open: boolean,
  fallback?: RefObject<HTMLElement | null>,
): DialogReturnFocus {
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);

  if (open && !wasOpen.current) {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement ? active : null;
  }
  wasOpen.current = open;

  const forget = useCallback(() => {
    triggerRef.current = null;
  }, []);

  const restore = useCallback(
    (event: Event) => {
      // Radix's own restore is composed AFTER this handler and skipped once the
      // event is prevented, so this replaces it rather than racing it.
      event.preventDefault();
      const captured = triggerRef.current;
      // Cleared here rather than on open: a dialog can be opened and closed
      // many times, and a stale element from the last time is exactly the kind
      // of thing that would go unnoticed.
      triggerRef.current = null;
      const target = dialogReturnTarget(captured, document.body, fallback?.current ?? mainLandmark());
      target?.focus();
    },
    [fallback],
  );

  return { forget, restore };
}
