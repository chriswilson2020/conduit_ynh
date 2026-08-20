import { useEffect, useRef } from "react";

/**
 * The latest value of something, readable from a callback that must not change
 * identity when it changes.
 *
 * The pattern this replaces is `const ref = useRef(x); ref.current = x;` in the
 * body of a component -- which works today and is a bug waiting for concurrent
 * rendering: React may render a component and THROW THE RESULT AWAY (a
 * suspended, interrupted or offscreen render), and a ref written during that
 * render keeps a value from a tree the user never saw. Writing it from an
 * effect means only a COMMITTED render can move it.
 *
 * Nothing is lost by the delay. The readers are event handlers and mutation
 * callbacks, which cannot run before the commit that would have set the ref:
 * effects flush before the browser paints, and a click on something that has
 * not been painted is not a click a user made.
 *
 * Used by the mail inbox (the filter key its stable selection callbacks act
 * under) and the thread list (the visible row order a shift-range runs over).
 * Both need the SAME callback identity across renders -- the list's rows are
 * memoised on it -- while still acting on the current value.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
