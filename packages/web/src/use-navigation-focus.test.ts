import { describe, it, expect } from "vitest";
import {
  firstVisibleHeading, headingIsVisible, navigationDroppedFocus,
} from "./use-navigation-focus";

/**
 * The two decisions inside the navigation focus rule, tested without a DOM.
 *
 * There is no testing-library and no jsdom here (see use-is-mobile.test.ts,
 * which says the same thing about the same split), so the browser half -- that
 * TanStack's `onResolved` fires after the destination has rendered, that a
 * heading focused programmatically after a mouse click paints no ring -- is
 * e2e/navigation-focus.spec.ts's. What is left is exactly what this file
 * covers: WHETHER to move focus, and WHERE.
 */

const BODY = { tag: "body" };

describe("navigationDroppedFocus", () => {
  it("says yes when the browser has parked the caret on <body>", () => {
    expect(navigationDroppedFocus({ fromLocation: { href: "/companies" }, active: BODY, body: BODY }))
      .toBe(true);
  });

  it("says yes when there is no active element at all", () => {
    expect(navigationDroppedFocus({ fromLocation: { href: "/companies" }, active: null, body: BODY }))
      .toBe(true);
  });

  /**
   * THE WHOLE OF THE RESTRAINT. A navigation that left focus somewhere real --
   * a sidebar link, whose anchor survives the route change; a dialog that has
   * already handed the caret back through components/ui/dialog-focus.ts -- is
   * not this rule's business, and moving focus there would be a jump every
   * user meets rather than a repair only the affected ones do.
   */
  it("says no when focus is still on a real element", () => {
    const link = { tag: "a" };
    expect(navigationDroppedFocus({ fromLocation: { href: "/companies" }, active: link, body: BODY }))
      .toBe(false);
  });

  /**
   * THE FIRST RESOLVE IS NOT A NAVIGATION, and the router reports it as one:
   * measured against @tanstack/react-router 1.170.30, a cold load of
   * /companies fires `onResolved` with `fromLocation: undefined`,
   * `pathChanged: true` and `document.activeElement` already on `<body>` --
   * which is every condition this rule keys on.
   *
   * Firing there would move focus INTO the page on every cold load, past the
   * header and the sidebar, for a reader who has not asked to go anywhere and
   * has lost no position. `fromLocation` is what separates "arrived from
   * somewhere" from "started here".
   */
  it("says no on the router's first resolve, which is a load rather than a navigation", () => {
    expect(navigationDroppedFocus({ fromLocation: undefined, active: BODY, body: BODY })).toBe(false);
  });
});

describe("headingIsVisible", () => {
  it("accepts a heading that occupies a box", () => {
    expect(headingIsVisible({ rectCount: 1, visibilityHidden: false })).toBe(true);
  });

  /**
   * `display: none` -- what a Tailwind `hidden` class produces, and what
   * pages/inbox.tsx puts on the two panes it is not showing.
   */
  it("rejects a heading with no client rects", () => {
    expect(headingIsVisible({ rectCount: 0, visibilityHidden: false })).toBe(false);
  });

  /**
   * `visibility: hidden` keeps the box, so a rect count alone would accept it
   * -- and `focus()` on it is a silent no-op that lands the caret back on
   * `<body>`, which is the defect rather than the fix.
   */
  it("rejects a heading that has a box but is visibility:hidden", () => {
    expect(headingIsVisible({ rectCount: 1, visibilityHidden: true })).toBe(false);
  });
});

describe("firstVisibleHeading", () => {
  it("takes the first heading when it is visible", () => {
    const first = { rectCount: 1, visibilityHidden: false, name: "Inbox" };
    const second = { rectCount: 1, visibilityHidden: false, name: "Conversation" };
    expect(firstVisibleHeading([first, second])).toBe(first);
  });

  /**
   * FIRST *VISIBLE*, NOT FIRST. This is what lets one rule cover a route that
   * renders a responsive pair of headings, only one of which is displayed --
   * see the module for what was actually measured on that point.
   */
  it("skips a hidden heading to reach the one on screen", () => {
    const hidden = { rectCount: 0, visibilityHidden: false, name: "desktop" };
    const shown = { rectCount: 1, visibilityHidden: false, name: "phone" };
    expect(firstVisibleHeading([hidden, shown])).toBe(shown);
  });

  it("returns null when nothing is on screen yet", () => {
    expect(firstVisibleHeading([{ rectCount: 0, visibilityHidden: false }])).toBe(null);
  });

  /**
   * The state every detail page in this app is in for the first tens of
   * milliseconds after its route resolves -- see the module's DEADLINE
   * comment for the measurement.
   */
  it("returns null when the destination has rendered no heading at all", () => {
    expect(firstVisibleHeading([])).toBe(null);
  });
});
