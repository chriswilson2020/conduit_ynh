import { useCallback, useMemo, useSyncExternalStore } from "react";
import { MOBILE_BREAKPOINT } from "./lib";

/**
 * The part of a MediaQueryList this module actually uses. Narrowed to an
 * interface rather than taking the DOM type so the three functions below are
 * exercisable from the node-environment unit suite this repo runs (there is no
 * testing-library and no jsdom here): a plain object satisfies it.
 */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/**
 * The media query that means "below the breakpoint", built from the same
 * constant styles.css binds Tailwind's `md` variant to.
 *
 * Spelled as the NEGATION of the desktop condition rather than as the
 * `max-width: 47.99rem` idiom, because the negation is the exact complement:
 * `md:` utilities apply at `width >= 48rem` and this matches at every width
 * where they do not, with no dead band in between where a fractional viewport
 * width (browser zoom, a scaled display) could leave the CSS on one side of
 * the breakpoint and this hook on the other. The media type is spelled out
 * because `not` requires one.
 */
export function mobileMediaQuery(breakpoint: string = MOBILE_BREAKPOINT): string {
  return `not all and (min-width: ${breakpoint})`;
}

/**
 * The query's state as a boolean, with "there is no query to read" mapping to
 * FALSE -- i.e. to desktop.
 *
 * That default is what makes this safe to call where there is no `window` at
 * all (a server render, a unit test importing a component). Desktop is the
 * right default rather than an arbitrary one: it is what this app rendered
 * before this phase existed, so the fallback path is the unchanged app rather
 * than a phone layout on a machine that never asked for one.
 */
export function readIsMobile(query: MediaQueryListLike | null): boolean {
  return query?.matches ?? false;
}

/**
 * Subscribe to the query's changes, returning the unsubscribe.
 *
 * A `change` listener on the MediaQueryList, NOT a resize listener: the
 * browser fires this only when the query's answer actually flips, so dragging
 * a window edge across a hundred widths costs at most two callbacks rather
 * than a hundred re-renders. A null query (no `window`) subscribes to nothing
 * and returns a cleanup that is still safe to call, so callers need no branch.
 */
export function subscribeToMediaQuery(query: MediaQueryListLike | null, onChange: () => void): () => void {
  if (query === null) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function mobileMediaQueryList(): MediaQueryListLike | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(mobileMediaQuery());
}

/**
 * Whether the viewport is below the breakpoint.
 *
 * USE THIS ONLY WHERE THE INTERACTION MODEL DIFFERS -- where the small screen
 * is a different UI rather than the same UI re-laid-out. The phase spec names
 * the three sites: this shell's navigation, the inbox's drill-in stack and the
 * kanban's stage view. Everything else -- stacking, widths, column counts,
 * spacing, visibility -- is Tailwind's `md:` variant, which costs no
 * JavaScript and no re-render. A fourth call site should be a decision someone
 * argued for, not a habit.
 *
 * useSyncExternalStore rather than useState + useEffect: the first render
 * already reads the real width, so a phone never paints the desktop shell for
 * a frame before correcting itself, and React owns the subscription's
 * lifetime.
 */
export function useIsMobile(): boolean {
  const query = useMemo(mobileMediaQueryList, []);
  const subscribe = useCallback((onChange: () => void) => subscribeToMediaQuery(query, onChange), [query]);
  const getSnapshot = useCallback(() => readIsMobile(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
