import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Event } from "@conduit/shared";
import { useEvents, useUsers } from "../../queries";
import {
  advanceCursorPages, cursorForKey, emptyCursorPages, flattenCursorPages, identityKey,
  mergeCursorPage, type CursorPages,
} from "../../lib";
import { Button } from "../ui/button";
import { VERB_BADGE, eventLink, summarize } from "./timeline-lib";

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
 */
export function Timeline({ companyId, contactId, dealId, projectId, taskId, onOpenMeeting }: TimelineProps) {
  const key = identityKey({ companyId, contactId, dealId, projectId, taskId });
  const [pages, setPages] = useState<CursorPages<Event>>(() => emptyCursorPages<Event>(key));
  const cursor = cursorForKey(pages, key);
  const { data, isLoading, isError, refetch } = useEvents({
    companyId, contactId, dealId, projectId, taskId, cursor,
  });
  const { data: users = [] } = useUsers();
  // The LOGIN, deliberately, rather than lib.ts's userLabel: every rail tab
  // that names a person (this one, Notes, Files) shows the username, so routing
  // just this one through the full-name label would spell the same person two
  // ways on one rail. Changing all three is a visible change, not a refactor.
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  useEffect(() => {
    if (!data) return;
    // mergeCursorPage returns the SAME object when nothing about this page
    // changed, so this cannot loop on its own state.
    setPages((current) => mergeCursorPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, cursor, key]);

  // pages.key can lag `key` by one render (the merge above runs in an effect),
  // and rendering the previous record's rows for that render is exactly the
  // leak the accumulator exists to prevent.
  const rows = useMemo(() => (pages.key === key ? flattenCursorPages(pages) : []), [pages, key]);
  const hasMore = pages.key === key && pages.nextCursor !== null;

  return (
    <div data-testid="timeline" className="flex flex-col gap-3">
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
