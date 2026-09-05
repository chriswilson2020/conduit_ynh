import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

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

/**
 * A number that changes whenever a write MADE IN THIS BROWSER settles
 * successfully. A nonce: only the fact that it CHANGED means anything.
 *
 * WHAT IT IS FOR. The lists that hold still under their reader (the inbox and
 * both record rails) all need to separate "somebody else's write, or the mail
 * sync, arrived" from "the reader just did something" -- the first is held
 * behind a count, the second is shown at once, and getting that backwards is
 * either a list that jumps or a list that hides the reader's own work behind a
 * button. The inbox can be told, because it has ONE caller making ONE kind of
 * write (thread-list.tsx's refreshToken prop). A record's timeline cannot: the
 * writes that put entries on it are every inline field edit, every note, every
 * file, every stage change, every task update -- twenty-odd mutation hooks in
 * queries.ts, none of which know a rail is on screen, reached from a detail
 * page, the task drawer, the board and the Gantt.
 *
 * THIS IS THAT refreshToken, SUPPLIED BY THE ONLY THING THAT CAN KNOW.
 * React Query's MutationCache sees every mutation this client runs and nothing
 * that happens anywhere else, which is exactly the line being drawn. An SSE
 * hint never touches it.
 *
 * WHY NOT ASK THE DATA. The obvious alternative on a timeline is to compare an
 * entry's actorUserId against the signed-in user. It is wrong for precisely
 * the case the hold exists for: a `mail_received` entry is written with the
 * MAILBOX OWNER as its actor (api: services/mail-ingest.ts's emitMailEvent
 * takes `account.userId`), so mail arriving in the reader's own account reads
 * as the reader's own activity and would move the list under them.
 *
 * ON SUCCESS ONLY, and after the mutation's own onSuccess has run: React Query
 * dispatches this state transition AFTER the callbacks, so by the time a
 * subscriber hears it the hook's invalidateQueries has already been issued and
 * a refetch is in flight -- which is what makes "refetch, then re-snapshot"
 * cheap rather than a second round trip. A failed mutation changed nothing and
 * is deliberately not a signal.
 *
 * EVERY mutation, not a filtered subset. A caller acts on this by re-fetching
 * one page and taking it, so a write that could not have changed its list
 * costs one request that returns what it already had; a filter here would be a
 * second list of which keys matter, kept in a third place, and wrong the day
 * somebody adds a verb.
 */
export function useOwnWriteNonce(): number {
  const queryClient = useQueryClient();
  const [nonce, setNonce] = useState(0);
  useEffect(
    () => queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") {
        setNonce((current) => current + 1);
      }
    }),
    [queryClient],
  );
  return nonce;
}
