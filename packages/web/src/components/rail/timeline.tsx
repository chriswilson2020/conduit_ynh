import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Event } from "@conduit/shared";
import { useEvents, useUsers } from "../../queries";
import {
  advanceCursorPages, cursorForKey, emptyCursorPages, flattenCursorPages, identityKey,
  pendingArrivals, takeCursorPage, type CursorPages,
} from "../../lib";
import { useLatest, useOwnWriteNonce } from "../../hooks";
import { Button } from "../ui/button";
import { VERB_BADGE, eventLink, newActivityLabel, summarize } from "./timeline-lib";

/** The column this list is ORDERED BY (api: services/timeline.ts's
 * `(created_at, id)` keyset), which is the only one the arrivals count may
 * read. At module scope so it keeps one identity across renders. */
const createdAtOf = (event: Event): string => event.createdAt;

export interface TimelineProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
  taskId?: string;
  /**
   * Opens a meeting, for the entries that name one. v0.9.0 ships no meetings
   * route -- a meeting lives inside its record's Meetings tab -- so only the
   * rail, which owns both tabs, can honour this; the task drawer renders the
   * same timeline without it, and those entries stay plain text there rather
   * than offering a link to somewhere that does not exist.
   */
  onOpenMeeting?: (meetingId: string) => void;
}

/**
 * Company/contact/deal/project/task activity feed.
 *
 * PAGES ARE ACCUMULATED THROUGH lib.ts's cursor-page record, not through a
 * "rows so far" array. The array version (which this replaces) appended
 * whatever the current query held whenever that query's DATA changed, which
 * was harmless while only this browser's own writes invalidated ["events"] --
 * and stopped being harmless in Phase 5, where mail ingest publishes that key
 * in the background (Task 4). Every such invalidation re-appended the loaded
 * page to itself. The same array also survived a change of record: this
 * component does not remount when the route params change under it (nor when
 * the task drawer switches tasks), so page two of the company you were just
 * looking at stayed on screen under the next one's name. Keying the
 * accumulator on the filter set fixes both by construction -- see
 * lib.ts's CursorPages, whose doc comment carries the full reasoning.
 *
 * =====================================================================
 * THE TIMELINE DOES NOT MOVE UNDER THE READER (v1.7.1)
 * =====================================================================
 *
 * WHAT THIS REPLACED. The accumulator above took every page a fetch handed it,
 * including a page it was already showing -- and ["events"] is invalidated by
 * every write in this app that touches the record (queries.ts) and, since
 * Phase 5, by mail arriving on a linked thread (api: mail-ingest.ts publishes
 * it whenever a message writes a timeline entry). Events are keyed
 * `(created_at, id)` descending, so re-taking page one INSERTS at the top and
 * pushes every row on screen down one. A reader aiming at an entry's "View
 * conversation" got a different entry's link under the pointer between two
 * clicks. This is the same defect the inbox carried before v1.6.0, in the same
 * shape, and it was found and left alone by Phase 4.4's Task 3 because that
 * task was about mail.
 *
 * THE RULE IS THE INBOX'S, WORD FOR WORD (mail/thread-list.tsx): A ROW NEVER
 * MOVES, APPEARS OR VANISHES WITHOUT THE READER ASKING; A ROW THAT IS ALREADY
 * ON SCREEN IS KEPT CURRENT WHERE IT STANDS.
 *
 * ...AND ITS SECOND CLAUSE COSTS NOTHING HERE, WHICH IS THE ONE REAL
 * DIFFERENCE. A timeline entry is APPEND-ONLY AND IMMUTABLE: services/
 * timeline.ts exports listEvents and nothing else, there is no PATCH or DELETE
 * on /api/events, and no service updates a row once inserted. A row on screen
 * therefore cannot go stale, so this component does NOT call
 * refreshCursorRows. That is a deliberate absence, not an omission: calling it
 * would be a per-hint walk of every held page that can never replace anything,
 * and it would import the one-writer constraint its doc comment imposes for a
 * guarantee nothing here needs. (The Meetings tab beside this one DOES call
 * it, because a meeting row's task count, title and attendees all change under
 * a reader -- see meetings.tsx.)
 *
 * SO THERE ARE THE INBOX'S THREE BEHAVIOURS, WITH ITS SECOND ONE EMPTY:
 *
 *   1. Activity from ANYWHERE ELSE -- a colleague's write, mail landing on a
 *      linked thread -- is counted, and a control at the top of the list
 *      offers to show it. Nothing moves until it is pressed. (lib.ts's
 *      pendingArrivals, and the control below.)
 *
 *   2. Nothing, because nothing can change in place. See above.
 *
 *   3. The reader's OWN write -> a new snapshot, at once and with no gesture.
 *      They edited a field beside this rail, or a task above this drawer, and
 *      an activity feed that answered "Show 1 new entry" to the thing they
 *      just did would be hiding their own work behind a button. hooks.ts's
 *      useOwnWriteNonce is how that write is told from an arrival, and its
 *      doc comment carries the reasoning.
 *
 * THE ALTERNATIVES, and why each is worse:
 *
 *   INSERT AND LET THE LIST RE-ORDER. What the code did; (1) is the case
 *   against it.
 *
 *   FREEZE WITH NO AFFORDANCE, which is one query shorter. It trades a list
 *   that moves for a list that is silently wrong: this surface is live today,
 *   and a reader with a record page open would simply stop being told anything
 *   had happened on it. "Never moves" and "never says" are not the same
 *   promise, and only the first one was asked for.
 *
 *   REFETCH EVERY ACCUMULATED PAGE ON EACH HINT. The cursors are keyset
 *   positions in an ordering that has moved: page two's was issued by the page
 *   one that existed before three entries arrived, so refetch page one and the
 *   three rows between its new end and that cursor are returned by neither
 *   fetch and are shown nowhere. flattenCursorPages' dedupe cannot help --
 *   these are rows that arrive from no page at all.
 *
 *   RE-SNAPSHOT ON EVERY HINT. "Reorders under the reader" with extra steps:
 *   it throws away their paging as well as their place, on somebody else's
 *   schedule.
 *
 *   HOLD THE READER'S OWN WRITE TOO, AND LET THEM CLICK FOR IT. This was the
 *   first shape, and it is the one alternative that was tried rather than
 *   argued about: it turns "edit the industry field and watch it land on the
 *   timeline" into "edit the field, then press a button", on the app's busiest
 *   surface, for every note, file, stage change and task edit. Two existing
 *   journeys assert against it (e2e/crm.spec.ts's inline edit, and
 *   e2e/meetings.spec.ts's archive, where the reader's own archive has to take
 *   the row away), and they were right to. Behaviour 3 is not a nicety; it is
 *   what stops the hold from being a regression.
 *
 *   TELLING THE READER'S OWN WRITE BY ITS actorUserId, which is the obvious
 *   way to do behaviour 3 and is wrong for exactly the case the hold exists
 *   for: a `mail_received` entry is written with the MAILBOX OWNER as its
 *   actor (api: mail-ingest.ts's emitMailEvent takes `account.userId`), so
 *   mail arriving in the reader's own account reads as their own activity and
 *   would move the list under them. The signal used instead is the mutation
 *   cache, which sees this browser's writes and nothing else -- hooks.ts's
 *   useOwnWriteNonce.
 *
 *   A refreshToken PROP, the way the inbox lets its caller say "that was me"
 *   (thread-list.tsx). The inbox has ONE caller making ONE kind of write; this
 *   component is rendered by the record rail and by the task drawer, and the
 *   writes that reach it come from some twenty mutation hooks across
 *   queries.ts, none of which know a timeline is on screen. That prop is the
 *   right idea with the wrong supplier, which is what useOwnWriteNonce is.
 *
 * TWO OBSERVERS, ONE OF THEM FREE, exactly as the inbox has it: `head` below
 * is page one whatever page the reader is on, which is also what makes this
 * list live past page one at all (after "Load more" the paging query is
 * watching page two, and page one -- where every new entry lands -- had no
 * observer). On page one the two calls hash to the same query key, since
 * React Query's key hash drops undefined values, so they share one cache entry
 * and one fetch.
 */
export function Timeline({ companyId, contactId, dealId, projectId, taskId, onOpenMeeting }: TimelineProps) {
  const key = identityKey({ companyId, contactId, dealId, projectId, taskId });
  const [pages, setPages] = useState<CursorPages<Event>>(() => emptyCursorPages<Event>(key));
  const cursor = cursorForKey(pages, key);
  const { data, isLoading, isError, isFetching, refetch } = useEvents({
    companyId, contactId, dealId, projectId, taskId, cursor,
  });
  // Page one, whatever page the reader is on. See the header.
  const head = useEvents({ companyId, contactId, dealId, projectId, taskId });
  const headData = head.data;
  const { data: users = [] } = useUsers();
  // The LOGIN, deliberately, rather than lib.ts's userLabel: every rail tab
  // that names a person (this one, Notes, Files) shows the username, so routing
  // just this one through the full-name label would spell the same person two
  // ways on one rail. Changing all three is a visible change, not a refactor.
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  /**
   * THE PAGING QUERY ONLY EVER ADDS A PAGE. takeCursorPage returns the record
   * UNCHANGED for a cursor already held, so a refetch of a page on screen
   * cannot move, insert or drop a row -- and since nothing here refreshes what
   * is already held (see the header), a held page is simply final until the
   * reader asks for a new snapshot.
   *
   * ...AND ONLY FROM A FETCH THAT HAS SETTLED. `data` while `isFetching` is a
   * CACHE ENTRY, not an answer: React Query hands back what it has while it
   * revalidates. Taking that and then holding it locks in a page that was
   * already known to be out of date, and it is not a corner case -- this rail
   * lives in Radix tabs, which unmount the inactive one, so the ordinary
   * "write a note on the Notes tab, then look at the Timeline" gesture
   * remounts this component over a cache entry the write has just
   * invalidated. Before the hold, the fresh page simply replaced the stale
   * one; with it, the reader's own note would have been held behind a count
   * for ever. (e2e/crm.spec.ts walks exactly that, and caught exactly this.)
   *
   * WAITING COSTS ONE ROUND TRIP AND ONLY WHERE THE DATA IS ALREADY WRONG. A
   * cold mount has no `data` to take anyway; a warm mount inside the 10s
   * staleTime is not fetching, so it paints from cache with no delay; only a
   * mount over data something has invalidated waits -- and the alternative
   * there is painting rows that are known to be stale and then keeping them.
   * The loading line below is gated on the same flag so that wait does not
   * render as "No activity yet".
   *
   * `pages` is a dependency, which it has to be: a re-snapshot replaces the
   * accumulator without changing the data, the key OR the cursor (page one's
   * cursor is undefined either way), and an effect that did not watch the
   * accumulator would leave the list showing the old rows until something
   * else happened to move. Safe because takeCursorPage settles -- its second
   * call for the same cursor returns the same object, so React bails out.
   */
  useEffect(() => {
    if (!data || isFetching) return;
    setPages((current) => takeCursorPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, isFetching, cursor, key, pages]);

  // pages.key can lag `key` by one render (the take above runs in an effect),
  // and rendering the previous record's rows for that render is exactly the
  // leak the accumulator exists to prevent.
  const rows = useMemo(() => (pages.key === key ? flattenCursorPages(pages) : []), [pages, key]);
  const hasMore = pages.key === key && pages.nextCursor !== null;

  /**
   * Take a new snapshot: fetch page one, and start the accumulation over from
   * WHAT CAME BACK.
   *
   * IN THAT ORDER, AND THE ORDER IS THE WHOLE FUNCTION. Emptying first would
   * adopt whatever the cache is holding, which after a write is the answer
   * from BEFORE it -- so the entry the reader just made would be missing, and
   * the fresh page landing a moment later would find page one held again and
   * take nothing from it. `refetch` on an in-flight query returns that fetch's
   * own promise (React Query dedupes), so following a mutation's own
   * invalidation costs no second request.
   *
   * IN ONE setPages RATHER THAN TWO, which the inbox does not need and this
   * does. Emptying and then letting the effect above re-take page one leaves
   * one committed render with no rows in it, and useEffect is passive -- it
   * flushes after paint, so that render can be seen. The inbox re-snapshots
   * on a deliberate gesture a handful of times a session; this one also runs
   * on every write the reader makes, where a frame of empty list would be a
   * flicker under their hands.
   *
   * IT GOES BACK TO PAGE ONE, and the accumulated pages are re-fetched by
   * pressing "Load more" again rather than re-paged here: their cursors are
   * keyset positions in an ordering that has just moved, and page one is the
   * only boundary that is certainly still true.
   *
   * A FAILED REFETCH CHANGES NOTHING. `data` is undefined only when the fetch
   * itself failed, and keeping the rows already on screen is better than
   * clearing them to prove a request went wrong -- the error line below is
   * what says that.
   */
  const headRefetch = head.refetch;
  // The key AS OF THE SNAPSHOT, not as of the ask: a record changing under
  // this component while the fetch is in flight would otherwise re-key the
  // accumulator backwards and blink the list empty for a render.
  const keyRef = useLatest(key);
  const resnapshot = useCallback(() => {
    void headRefetch().then(({ data: fresh }) => {
      if (fresh === undefined) return;
      const snapshotKey = keyRef.current;
      setPages(takeCursorPage(
        emptyCursorPages<Event>(snapshotKey), snapshotKey, undefined, fresh.items, fresh.nextCursor,
      ));
    });
  }, [headRefetch, keyRef]);

  /**
   * THE READER'S OWN WRITE IS NEVER HELD BACK (behaviour 3 in the header).
   *
   * Only a CHANGE means anything -- the value is a nonce -- so the mount pass,
   * where there is nothing to refresh, is skipped rather than costing a fetch
   * and a render on every timeline that ever mounts. Exactly the shape
   * thread-list.tsx gives its refreshToken prop; the difference is only where
   * the signal comes from, which hooks.ts explains.
   */
  const ownWrite = useOwnWriteNonce();
  const seenOwnWrite = useRef(ownWrite);
  useEffect(() => {
    if (seenOwnWrite.current === ownWrite) return;
    seenOwnWrite.current = ownWrite;
    resnapshot();
  }, [ownWrite, resnapshot]);

  /**
   * What has arrived that the list is not showing. Both sides are this
   * record's by construction: `rows` is empty for any key the accumulator is
   * not holding, and a changed key gives `head` a different query rather than
   * the old one's data (nothing here sets placeholderData).
   */
  const pending = useMemo(
    () => (headData === undefined
      ? { count: 0, atLeast: false }
      : pendingArrivals(rows, headData.items, headData.nextCursor !== null, createdAtOf)),
    [headData, rows],
  );

  return (
    <div data-testid="timeline" className="flex flex-col gap-3">
      {/* MOUNTED ALWAYS, so its live region is announced when it fills: a
          region that appears with its text already in it is one a screen
          reader has nothing to compare against. Same shape as the inbox's
          (thread-list.tsx), and for the same reason it is NOT sticky -- a
          badge that follows a reader down the page is the interruption this
          whole design exists to remove, in a smaller font. */}
      <div data-testid="timeline-new" role="status" aria-live="polite" className="empty:hidden">
        {pending.count > 0 && (
          <Button
            variant="outline"
            className="w-full"
            data-testid="timeline-new-show"
            onClick={resnapshot}
          >
            {newActivityLabel(pending)}
          </Button>
        )}
      </div>
      {/* isFetching as well as isLoading, because of the effect above: a mount
          over data something has invalidated has `data` in hand and is still
          waiting for the answer it will actually take, and with rows still
          empty the line below would otherwise claim there is no activity. */}
      {(isLoading || isFetching) && rows.length === 0 && (
        <p className="text-sm text-slate-400">Loading...</p>
      )}
      {/* A record with no activity and a timeline that FAILED to load are
          different facts. Rendering the first for the second is the worse
          mistake -- "No activity yet" on a busy record reads as data loss --
          and it is newly easy to hit: an old browser tab against a v0.9.0 API
          throws on the three verbs it has never heard of, so the whole page
          fails to parse. */}
      {!isLoading && !isFetching && !isError && rows.length === 0 && (
        <p data-testid="timeline-empty" className="text-sm text-slate-400">No activity yet</p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((event) => (
          <li key={event.id} data-testid="timeline-entry" className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600"
            >
              {VERB_BADGE[event.verb]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-slate-900">
                <span className="font-medium">{userMap.get(event.actorUserId) ?? "\u2014"}</span>{" "}
                {summarize(event)}
              </p>
              <p className="flex items-center gap-2 text-xs text-slate-400">
                <span>{new Date(event.createdAt).toLocaleString()}</span>
                <EntryLink event={event} onOpenMeeting={onOpenMeeting} />
              </p>
            </div>
          </li>
        ))}
      </ul>
      {isError ? (
        <div className="flex items-center gap-2">
          <p role="alert" data-testid="timeline-error" className="text-xs text-red-600">
            {rows.length === 0 ? "Could not load this timeline." : "Could not load more activity."}
          </p>
          {/* Retry, not "Load more": after a failed page fetch the cursor is
              ALREADY at nextCursor, so advancing again produces the same query
              key and TanStack answers it from its error state without going
              near the network -- a control that looks like it does something
              and does nothing, forever. */}
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="timeline-retry"
            onClick={() => { void refetch(); }}
          >
            Retry
          </Button>
        </div>
      ) : hasMore && (
        <Button
          variant="outline"
          data-testid="timeline-load-more"
          onClick={() => setPages((current) => advanceCursorPages(current, key))}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

/**
 * Where an entry leads, when it leads anywhere: a mail entry to the
 * conversation in the inbox, a meeting entry to the meeting in this record's
 * own Meetings tab.
 *
 * The mail half is a real <Link> because /mail?thread=<id> is a real route
 * (the same deep link the inbox and global search already use); the meeting
 * half is a button because there is no meetings route to link to, and its
 * absence is what makes `onOpenMeeting` optional rather than the rail simply
 * always passing one.
 */
function EntryLink({ event, onOpenMeeting }: { event: Event; onOpenMeeting?: (meetingId: string) => void }) {
  const link = eventLink(event);
  if (link === null) return null;
  if (link.kind === "thread") {
    return (
      <Link
        to="/mail"
        search={{ thread: link.threadId }}
        data-testid="timeline-thread-link"
        className="font-medium text-slate-500 underline hover:text-slate-900"
      >
        View conversation
      </Link>
    );
  }
  if (onOpenMeeting === undefined) return null;
  return (
    <button
      type="button"
      data-testid="timeline-meeting-link"
      className="font-medium text-slate-500 underline hover:text-slate-900"
      onClick={() => onOpenMeeting(link.meetingId)}
    >
      View meeting
    </button>
  );
}
