/**
 * The app's navigation destinations, and the rule that decides which of them
 * reach the phone's bottom tab bar directly and which sit behind More.
 *
 * Pure on purpose. This repo has no testing-library, so a component's
 * rendering is only ever proven by e2e; keeping the split, the ordering and
 * the active-path rule out here means the parts with actual decisions in them
 * are unit-tested, and bottom-nav.tsx is left with nothing but markup.
 */

export type NavId = "mail" | "companies" | "contacts" | "my-tasks" | "pipelines" | "projects" | "gantt" | "settings";

export interface NavDestination {
  readonly id: NavId;
  /** Bottom-bar label. Not always the sidebar's word for it: the sidebar says "Inbox". */
  readonly label: string;
  /** Where the link goes. */
  readonly to: string;
  /**
   * The path PREFIX that means "the user is here", which is not always `to`:
   * Settings links at one of its two tabs but must read as current on both.
   * Basepath-relative, like every path in this app -- router-core strips a
   * configured basepath before the location is stored, so `location.pathname`
   * never carries it (see shell.tsx's note on the same point).
   */
  readonly match: string;
}

/**
 * Every destination the shell offers, in the desktop sidebar's own order.
 *
 * This list and the sidebar's literal JSX in shell.tsx are pinned to each
 * other by nav-lib.test.ts -- in TARGET, LABEL AND POSITION, so "the sidebar's
 * own order" above is a fact the suite enforces rather than a hope. The
 * phase's definition of done is that nothing is desktop-only, and a ninth
 * sidebar entry added without a line here would be exactly that: reachable at
 * a desk and nowhere else. The sidebar is not driven FROM this list because
 * this phase may not alter the desktop shell at all, and rewriting eight
 * hand-tuned links into a map would do just that.
 *
 * A label that must legitimately differ between the two (the sidebar says
 * "Inbox" where the bar says "Mail") is declared in that test's SIDEBAR_LABEL
 * rather than allowed by a looser comparison.
 */
export const NAV_DESTINATIONS = [
  { id: "mail", label: "Mail", to: "/mail", match: "/mail" },
  { id: "companies", label: "Companies", to: "/companies", match: "/companies" },
  { id: "contacts", label: "Contacts", to: "/contacts", match: "/contacts" },
  { id: "pipelines", label: "Pipelines", to: "/pipelines", match: "/pipelines" },
  { id: "projects", label: "Projects", to: "/projects", match: "/projects" },
  { id: "my-tasks", label: "My Tasks", to: "/my-tasks", match: "/my-tasks" },
  { id: "gantt", label: "Gantt", to: "/gantt", match: "/gantt" },
  { id: "settings", label: "Settings", to: "/settings/mail", match: "/settings" },
] as const satisfies readonly NavDestination[];

/**
 * The four that get a tab of their own, in the order they sit in the bar.
 *
 * Fixed by the phase spec, and this array is what pins it: what a phone is
 * for here is looking someone up, reading mail and checking what you owe.
 * Working a pipeline or a schedule is desk work, and both stay one tap away
 * behind More. Mail leads because it carries the unread badge. Reordering
 * this is a decision to argue for, not a tweak -- the test names the four.
 */
export const PRIMARY_NAV_IDS: readonly string[] = ["mail", "companies", "contacts", "my-tasks"];

export interface NavSplit<T> {
  /** Tabs in the bar, in PRIMARY_NAV_IDS order. */
  readonly primary: T[];
  /** Everything else, behind More, in the order it was given. */
  readonly overflow: T[];
}

/**
 * Split destinations into the bar and the More sheet.
 *
 * Membership decides, not position: the bar reads in PRIMARY_NAV_IDS order
 * however the input is ordered, and anything not named there falls to
 * overflow rather than being dropped. Between them the two halves are exactly
 * the input, once each -- which is the property that makes "no destination is
 * a dead end" checkable instead of hopeful.
 */
export function splitNav<T extends { readonly id: string }>(destinations: readonly T[]): NavSplit<T> {
  const primary: T[] = [];
  for (const id of PRIMARY_NAV_IDS) {
    const found = destinations.find((destination) => destination.id === id);
    if (found !== undefined) primary.push(found);
  }
  const overflow = destinations.filter((destination) => !PRIMARY_NAV_IDS.includes(destination.id));
  return { primary, overflow };
}

/**
 * Whether `pathname` is at or below a destination.
 *
 * Segment-aware rather than a bare `startsWith`, so "/companies" does not
 * light up on a hypothetical "/companies-archive" while still lighting up on
 * "/companies/<id>" -- a detail page is somewhere the Companies tab took you.
 */
export function isNavDestinationActive(pathname: string, destination: { readonly match: string }): boolean {
  return pathname === destination.match || pathname.startsWith(`${destination.match}/`);
}

/** Whether any of them is active -- what decides the More tab's own state. */
export function isAnyNavDestinationActive(
  pathname: string,
  destinations: readonly { readonly match: string }[],
): boolean {
  return destinations.some((destination) => isNavDestinationActive(pathname, destination));
}
