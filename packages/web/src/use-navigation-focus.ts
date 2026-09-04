import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * WHERE THE CARET GOES AFTER A NAVIGATION THAT TOOK IT WITH IT.
 *
 * Clicking a row link unmounts the anchor that was focused, and the browser
 * parks `document.activeElement` on `<body>`: the next Tab restarts from the
 * top of the document and a screen reader announces nothing, because nothing
 * moved. components/ui/dialog-focus.ts had already measured this and written
 * it down as somebody else's problem -- "that is a route change's defect, not
 * a dialog's" -- and this module is that item.
 *
 * THE TARGET IS pages/inbox.tsx's, GENERALISED. That page reached it solving
 * one surface, and the part of its reasoning that survives generalisation is:
 * the heading GENUINELY MOVES, so it is announced, and it announces the
 * DESTINATION ("Companies, heading level 1") rather than the exit ("Acme BV,
 * link").
 *
 * THE SPEC SAYS TWO PAGES SOLVED IT BY HAND AND THAT IS ONE PAGE TOO MANY.
 * pages/board.tsx has the same `<h1>` with the same `tabIndex`, which is what
 * the spec read as a second hand-rolled copy of this rule -- but nothing there
 * watches a route change. That heading is the `fallback` argument to
 * `useDialogReturnFocus`, i.e. where the MOVE SHEET's close puts the caret;
 * see components/ui/dialog-focus.ts, which the spec puts out of scope. Two
 * pages agreeing that a heading is the right place to land is still the
 * evidence this module rests on. It is just not two copies of this rule.
 *
 * ---------------------------------------------------------------------------
 * WHICH ROUTER HOOK, WHICH IS THE ONE PART OF THIS THAT CAN LOOK RIGHT WHILE
 * BEING WRONG. Measured in Chromium against @tanstack/react-router 1.170.30,
 * clicking a company row on /companies. Each candidate recorded the `<h1>`s in
 * the document at the moment it fired:
 *
 *   candidate                                     t(ms)   h1 in the DOM
 *   useLocation() + useLayoutEffect, root route    204.8   "Companies"  <- OLD
 *   useLocation() + useEffect, root route          204.9   "Companies"  <- OLD
 *   router.subscribe("onLoad")                     205.0   "Companies"  <- OLD
 *   router.subscribe("onResolved")                 214.0   (none yet)
 *   useEffect + requestAnimationFrame              218.8   (none yet)
 *   useEffect + setTimeout 0                       219.4   (none yet)
 *
 * THE THREE EARLY ONES ARE NOT MERELY EARLY, THEY ARE WRONG. The router's
 * location store updates before the matched components commit -- the route
 * render is a React transition -- so an effect keyed on `useLocation()` runs
 * while the PREVIOUS page is still on screen. It would not have been a silent
 * no-op that a fast machine hides; it would have focused the heading of the
 * page being left. Watched again on a navigation FROM a company's detail page
 * TO /pipelines, those same three read the company's name -- the heading of
 * the page being navigated away from -- while `onResolved` read "Pipelines".
 *
 * `onResolved` is the first moment the destination is committed: on the
 * sidebar-link navigation above it reads "Pipelines", and on the row-link one
 * it reads no heading at all, which is the next paragraph.
 *
 * ---------------------------------------------------------------------------
 * THE DESTINATION USUALLY HAS NO HEADING YET, AND NO CHOICE OF HOOK FIXES
 * THAT. Every detail page in this app renders `<p>Loading...</p>` inside its
 * frame while its query is in flight, with no `<h1>` at all -- and row links
 * into detail pages are the single commonest way this app drops focus. The
 * heading arrives when the record does. Measured against a PostgreSQL socket
 * on the same machine: 18.5ms and 25.2ms after `onResolved`, and a real
 * round trip is not that.
 *
 * So the rule waits, with a MutationObserver rather than a frame or a timeout,
 * because the wait is for a query rather than for a paint. Neither the spec
 * nor the plan for this release anticipated this; it is the reason the rule is
 * more than one line.
 *
 * ---------------------------------------------------------------------------
 * WHAT STOPS THE WAIT FROM BECOMING A JUMP. Every re-check asks
 * `navigationDroppedFocus` again, so a caret that has landed somewhere real in
 * the meantime is left alone: a task drawer opening on `?task=` (measured:
 * `document.activeElement` is the Radix content DIV by the time `onResolved`
 * fires), a dialog handing focus back through components/ui/dialog-focus.ts, a
 * user who has simply pressed Tab. And a second navigation cancels the first
 * attempt outright rather than racing it.
 *
 * ---------------------------------------------------------------------------
 * THE FOCUS RING NEEDED NO CSS, AND THAT IS A MEASUREMENT RATHER THAN A HOPE.
 * A mouse user clicking a row loses the caret too, so this rule fires for them
 * and the heading takes it -- harmless until it paints a box round the next
 * page's title on every row click in the product.
 *
 * Chromium already separates the two cases on its own: it tracks whether the
 * last interaction was a keyboard one, and a programmatic `focus()` after a
 * CLICK does not match `:focus-visible`, so the UA stylesheet paints nothing;
 * after Enter on the same link it does, and it paints. Measured in situ on both
 * paths (`getComputedStyle(...).outlineStyle`, not a screenshot) and pinned in
 * BOTH DIRECTIONS by e2e/navigation-focus.spec.ts.
 *
 * SO THERE IS NOTHING HERE TO POINT AT, and the assertions are the deliverable.
 * They are not vacuous: `focus({ focusVisible: true })` on the line below, and
 * an `h1:focus` rule in the stylesheet, each turn the mouse assertion red;
 * `h1:focus { outline: none }` -- the one-line "fix" for either -- turns the
 * keyboard one red instead. All three were run.
 *
 * WHAT IS NOT COVERED: the e2e run is Chromium only (playwright.config.ts
 * declares no other project), so this is Chromium's heuristic that has been
 * measured, not the web platform's. Firefox and WebKit implement the same
 * selector and are believed to agree; nothing here has watched them.
 */

/**
 * The part of `document.activeElement` this module compares. An interface
 * rather than the DOM type so the decision below is exercisable from the
 * node-environment unit suite -- the same reason use-is-mobile.ts narrows a
 * MediaQueryList, and there is still no jsdom here.
 */
export interface NavigationFocusTrigger<T> {
  /**
   * `fromLocation` from the router's `onResolved` event: UNDEFINED on the
   * first resolve of a page load, and a location on every navigation after it.
   */
  readonly fromLocation: unknown;
  /** `document.activeElement`. */
  readonly active: T | null;
  /** `document.body`. */
  readonly body: T;
}

/**
 * WHETHER THIS NAVIGATION LOST THE CARET -- and the whole of the restraint the
 * spec asks for, which is that this rule is met only by the people the defect
 * harms.
 *
 * A rule that moved focus on EVERY navigation would be met by every user on
 * every click. A sidebar link keeps its own anchor across the route change and
 * a mouse click on inert content leaves the caret on `<main>` (shell.tsx gives
 * it `tabIndex={-1}` and says why); neither is a loss and neither is touched.
 *
 * THE FIRST RESOLVE IS EXCLUDED BECAUSE IT IS A LOAD, NOT A NAVIGATION.
 * Measured: a cold load fires `onResolved` with `fromLocation: undefined` and
 * the caret already on `<body>` -- every condition this function keys on --
 * and moving focus there would drop a reader INTO the page on every visit,
 * past the header and the sidebar, having lost nothing. `fromLocation` is the
 * only thing in the event that separates "arrived from somewhere" from
 * "started here" (`pathChanged` and `hrefChanged` are both true on a cold
 * load).
 */
export function navigationDroppedFocus<T>(trigger: NavigationFocusTrigger<T>): boolean {
  if (trigger.fromLocation === undefined) return false;
  return trigger.active === null || trigger.active === trigger.body;
}

/**
 * The part of a heading this module reads, for the same reason as above.
 *
 * `rectCount` is `getClientRects().length` and NOT `offsetParent`, which is
 * the other idiom for this. `offsetParent` is null for a `position: fixed`
 * element that is perfectly visible, so it answers "hidden" for a heading in
 * any sticky or fixed header somebody adds later -- a false negative that
 * would send the caret to the wrong heading, silently. Client rects are empty
 * for `display: none` (which is what a Tailwind `hidden` class produces, and
 * what pages/inbox.tsx puts on the panes it is not showing) and non-empty for
 * everything that occupies a box.
 */
export interface HeadingLike {
  /** `getClientRects().length`. */
  readonly rectCount: number;
  /** `getComputedStyle(el).visibility === "hidden"`. */
  readonly visibilityHidden: boolean;
}

/**
 * Whether a heading is somewhere the caret can actually land.
 *
 * BOTH CHECKS ARE LOAD-BEARING AND THEY CATCH DIFFERENT THINGS. `display:
 * none` removes the box, so the rect count answers it. `visibility: hidden`
 * KEEPS the box, so the rect count says yes -- and `focus()` on such an
 * element is a silent no-op that leaves the caret on `<body>`, which is the
 * defect this module exists to fix, arrived at through the fix.
 */
export function headingIsVisible(heading: HeadingLike): boolean {
  return heading.rectCount > 0 && !heading.visibilityHidden;
}

/**
 * The first heading on screen, or null if none is.
 *
 * FIRST *VISIBLE* RATHER THAN FIRST, and this is the honest state of that:
 * swept over every `<h1>` in this app, NO route renders two at once. The
 * doubles are mutually exclusive branches -- "Company not found" against the
 * company's name, the two page components that share pages/gantt.tsx -- and
 * the spec's claim that several pages carry a responsive PAIR, only one of
 * which is displayed, is not true of this codebase as it stands.
 *
 * The check stays anyway, and the reason is narrow enough to state: a
 * responsive heading pair is a normal thing to add, this app already builds
 * responsive pairs of other elements, and the failure mode if one arrived
 * without this is not a visible bug but a coin toss about which heading the
 * caret lands on. It costs one `getClientRects()` per heading on a route
 * change.
 */
export function firstVisibleHeading<T extends HeadingLike>(headings: readonly T[]): T | null {
  return headings.find(headingIsVisible) ?? null;
}

/**
 * How long to keep waiting for the destination's heading.
 *
 * The wait ends at whichever comes first: the heading arriving, the caret
 * landing somewhere real on its own, another navigation, or this. Measured
 * arrival against a local database is 18-25ms; this leaves room for a real
 * round trip on a connection that is having a bad day without the wait
 * outliving the navigation that started it.
 *
 * REACHING THE DEADLINE LEAVES THE CARET ON `<body>` -- the defect, unfixed --
 * and that is the intended behaviour rather than a hole left open. Getting here
 * means the destination has rendered no heading for two seconds, which on every
 * route in this app means its record's query has not come back and the page is
 * still showing "Loading...". There is no destination to announce yet, so
 * announcing one would be a lie about what is on screen. The alternative
 * considered and rejected was falling back to the `<main>` landmark
 * (components/ui/dialog-focus.ts's fallback, and already `tabIndex={-1}`): it
 * would restore the tab order, but it would also END the wait, so the heading
 * that arrives a moment later is never announced at all. Between announcing
 * nothing and announcing "main" over a spinner, nothing is the smaller lie, and
 * the next navigation gets a fresh attempt either way.
 */
const HEADING_DEADLINE_MS = 2000;

function activeElement(): Element | null {
  return document.activeElement;
}

function stillLost(fromLocation: unknown): boolean {
  return navigationDroppedFocus({ fromLocation, active: activeElement(), body: document.body });
}

function visibleHeading(): HTMLHeadingElement | null {
  const headings = Array.from(document.querySelectorAll("h1")).map((element) => ({
    element,
    rectCount: element.getClientRects().length,
    visibilityHidden: getComputedStyle(element).visibility === "hidden",
  }));
  return firstVisibleHeading(headings)?.element ?? null;
}

/**
 * Put the caret on the heading.
 *
 * `tabIndex = -1` IS SET HERE RATHER THAN ON THIRTEEN PAGES' JSX. Without it
 * `focus()` on an `<h1>` is a no-op, and -1 keeps the heading out of everyone's
 * TAB ORDER -- pages/inbox.tsx's phrasing, and its reasoning holds: a control
 * invented only to be focused would be a control every keyboard user then has
 * to Tab past.
 *
 * Doing it from here is a decision and not laziness. Thirteen pages carry
 * their own `<h1>` and four of them carry two; a fourteenth is a normal thing
 * to add, and an attribute a new page has to remember is an attribute a new
 * page will not have. React never removes it, because none of those headings
 * mentions `tabIndex` in its JSX -- the three that DID
 * (pages/inbox.tsx, pages/board.tsx, pages/deal-detail.tsx, all of them
 * `-1` and two of them only below the breakpoint) are now unconditional, so
 * nothing here is fighting a re-render for the attribute.
 */
function landOn(heading: HTMLHeadingElement): void {
  heading.tabIndex = -1;
  heading.focus();
}

/**
 * Move focus to the destination's heading after any navigation that dropped it
 * on `<body>`, and leave it exactly where it is after any navigation that did
 * not.
 *
 * Mounted once, by the root route (src/router.tsx). See this module's header
 * for why `onResolved` and not one of the three earlier hooks, and for what
 * the wait is for.
 */
export function useFocusAfterNavigation(): void {
  const router = useRouter();

  useEffect(() => {
    let observer: MutationObserver | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    function stopWaiting(): void {
      observer?.disconnect();
      observer = null;
      clearTimeout(deadline);
      deadline = undefined;
    }

    /**
     * TRUE MEANS "THERE IS NOTHING LEFT TO WAIT FOR", which covers two
     * outcomes rather than one: the caret is already somewhere real, so this
     * navigation was never this rule's business; or the heading was there and
     * now holds it. FALSE means only one thing -- the caret is on `<body>` and
     * the destination has not rendered a heading yet.
     */
    function settled(fromLocation: unknown): boolean {
      if (!stillLost(fromLocation)) return true;
      const heading = visibleHeading();
      if (heading === null) return false;
      landOn(heading);
      return true;
    }

    const unsubscribe = router.subscribe("onResolved", (event) => {
      // A second navigation abandons the first one's wait rather than racing
      // it: the heading it was waiting for belongs to a page nobody is on.
      stopWaiting();
      const { fromLocation } = event;
      if (settled(fromLocation)) return;

      observer = new MutationObserver(() => {
        if (settled(fromLocation)) stopWaiting();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      deadline = setTimeout(stopWaiting, HEADING_DEADLINE_MS);
    });

    return () => {
      stopWaiting();
      unsubscribe();
    };
  }, [router]);
}
