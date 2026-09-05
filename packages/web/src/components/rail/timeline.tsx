import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Event } from "@conduit/shared";
import { useEvents, useUsers } from "../../queries";
import {
  advanceCursorPages, cursorForKey, emptyCursorPages, flattenCursorPages, identityKey,
  pendingArrivals, takeCursorPage, type CursorPages,
} from "../../lib";
import { useLatest } from "../../hooks";
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
 * SO THERE ARE TWO BEHAVIOURS RATHER THAN THE INBOX'S THREE:
 *
 *   1. Activity the reader cannot see -> counted, and a control at the top of
 *      the list offers to show it. Nothing moves until it is pressed.
 *      (lib.ts's pendingArrivals, and the control below.)
 *
 *   2. Asking is what takes the server's order, all of it, from page one.
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
 *   NEVER HOLD BACK THE READER'S OWN ACTIVITY, by comparing an entry's
 *   actorUserId against the signed-in user -- so that editing a task in the
 *   drawer showed its own entry at once instead of behind a button. Rejected
 *   because the signal is WRONG FOR EXACTLY THE CASE THIS EXISTS FOR: a
 *   `mail_received` entry is written with the MAILBOX OWNER as its actor (api:
 *   mail-ingest.ts's emitMailEvent takes `account.userId`), so mail arriving
 *   in the reader's own account is "the reader's own activity" by this test
 *   and would re-snapshot the list under them. The one signal that looks like
 *   it separates a write from an arrival is the one that cannot.
 *
 *   A refreshToken PROP, the way the inbox lets its caller say "that was me"
 *   (thread-list.tsx). The inbox has ONE caller making ONE kind of write; this
 *   component is rendered by the record rail and by the task drawer, and the
 *   writes that reach it come from some twenty mutation hooks across
 *   queries.ts, none of which know a timeline is on screen. Threading a nonce
 *   through all of them to save one click is a great deal of surface for a
 *   small gain -- and the rail's tabs unmount (Radix Tabs renders only the
 *   active one), so leaving the Timeline tab and coming back is already a
 *   fresh snapshot.
 *
 * WHAT THE READER'S OWN WRITE THEREFORE DOES: it is counted like anything
 * else, and one click shows it. Stated here because it is the one place this
 * is visibly less immediate than what shipped before.
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
  const { data, isLoading, isError, refetch } = useEvents({
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
   * `pages` is a dependency, which it has to be: a re-snapshot empties the
   * accumulator without changing the data, the key OR the cursor (page one's
   * cursor is undefined either way), and an effect that did not watch the
   * accumulator would leave the list empty until something else happened to
   * move. Safe because takeCursorPage settles -- its second call for the same
   * cursor returns the same object, so React bails out.
   */
  useEffect(() => {
    if (!data) return;
    setPages((current) => takeCursorPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, cursor, key, pages]);

  // pages.key can lag `key` by one render (the merge above runs in an effect),
  // and rendering the previous record's rows for that render is exactly the
  // leak the accumulator exists to prevent.
  const rows = useMemo(() => (pages.key === key ? flattenCursorPages(pages) : []), [pages, key]);
  const hasMore = pages.key === key && pages.nextCursor !== null;

  /**
   * Take a new snapshot: fetch page one, THEN start the accumulation over from
   * what came back.
   *
   * IN THAT ORDER, AND THE ORDER IS NOT LOAD-BEARING HERE -- WHICH IS WRITTEN
   * DOWN RATHER THAN LEFT TO BE REDISCOVERED. The only thing that asks for a
   * snapshot is the control below, and by the time that control exists the
   * head query has already refetched, because that is where its count came
   * from; so emptying first would adopt a page one that is fresh anyway. A
   * mutation reversing these two lines survived the whole suite, and that is
   * the honest state of it.
   *
   * IT IS STILL WRITTEN THIS WAY, for two reasons. It is the order the same
   * function has on the other two surfaces -- mail/thread-list.tsx's
   * resnapshot and meetings.tsx's reset -- where the snapshot DOES follow the
   * reader's own write, the cache is holding the answer from before it, and
   * the reverse order silently loses the thing they just did. Three copies of
   * one idea should not differ in a way that looks deliberate and is not. And
   * it is the order that stays correct if this component ever gains such a
   * trigger, which is exactly the change the header's rejected refreshToken
   * note describes.
   *
   * `refetch` on an in-flight query returns that fetch's own promise (React
   * Query dedupes), so the common case issues no second request.
   *
   * IT GOES BACK TO PAGE ONE, and the accumulated pages are re-fetched by
   * pressing "Load more" again rather than re-paged here: their cursors are
   * keyset positions in an ordering that has just moved, and page one is the
   * only boundary that is certainly still true.
   */
  const headRefetch = head.refetch;
  // The key AS OF THE RESET, not as of the ask: a record changing under this
  // component while the fetch is in flight would otherwise re-key the
  // accumulator backwards and blink the list empty for a render.
  const keyRef = useLatest(key);
  const resnapshot = useCallback(() => {
    void headRefetch().then(() => setPages(emptyCursorPages<Event>(keyRef.current)));
  }, [headRefetch, keyRef]);

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
      {isLoading && rows.length === 0 && <p className="text-sm text-slate-400">Loading...</p>}
      {/* A record with no activity and a timeline that FAILED to load are
          different facts. Rendering the first for the second is the worse
          mistake -- "No activity yet" on a busy record reads as data loss --
          and it is newly easy to hit: an old browser tab against a v0.9.0 API
          throws on the three verbs it has never heard of, so the whole page
          fails to parse. */}
      {!isLoading && !isError && rows.length === 0 && (
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
