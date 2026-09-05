import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@conduit/shared";
import { useCreateNote, useNotes, useUsers } from "../../queries";
import {
  emptyHeldList, identityKey, newArrivalsLabel, pendingArrivals, takeWholeList, type HeldList,
} from "../../lib";
import { useLatest, useOwnWriteNonce } from "../../hooks";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** The column this list is ORDERED BY (api: services/notes.ts's
 * `(created_at, id)` descending), which is the only one the arrivals count may
 * read. At module scope so it keeps one identity across renders. */
const createdAtOf = (note: Note): string => note.createdAt;

export interface NotesProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/**
 * A record's Notes tab.
 *
 * =====================================================================
 * THE NOTES LIST DOES NOT MOVE UNDER THE READER (v1.7.2)
 * =====================================================================
 *
 * THE RULE IS THE ONE v1.7.1 SETTLED FOR THE TWO TABS BESIDE THIS ONE: A ROW
 * NEVER MOVES, APPEARS OR VANISHES WITHOUT THE READER ASKING; A ROW ALREADY ON
 * SCREEN IS KEPT CURRENT WHERE IT STANDS; THE READER'S OWN WRITES ARE NEVER
 * HELD. timeline.tsx carries the long version. What is recorded here is only
 * what a WHOLE-LIST fetch changes, which is more than it first appears.
 *
 * WHAT ACTUALLY MOVES, ESTABLISHED RATHER THAN ASSUMED. `["notes"]` is
 * published to every open browser whenever anybody writes a note (api:
 * services/notes.ts, through services/sse.ts), so a colleague's note refetches
 * this list under its reader. `created_at` is defaultNow() on the notes table
 * and there is no way to supply one, so the arriving note is newer than
 * everything on screen; the list is newest-first, so it lands at index 0 and
 * pushes every row down by exactly one. That is the whole defect: not a
 * re-sort, not a removal, an INSERTION AT THE TOP.
 *
 * ...AND NOTHING ELSE DOES, WHICH IS WHY THERE IS NO refreshCursorRows HERE.
 * routes/notes.ts exposes GET and POST and nothing else; the service exports
 * createNote and listNotes; nothing in the API updates or deletes a note row.
 * A note on screen is therefore INCAPABLE of going stale, so the rule's second
 * clause costs nothing -- the same deliberate absence timeline.tsx argues for,
 * on stronger evidence, because here the route surface was checked too. (The
 * author's name beside each row is not held: it comes from the separate
 * ["users"] query and stays live.)
 *
 * THIS TAB IS MILDER THAN THE FILES TAB AND IS FIXED ANYWAY. A note row is
 * text -- no link, no button -- so nothing here can be MIS-CLICKED the way a
 * download link one tab over can. What it does is move the sentence a reader
 * is in the middle of, by the height of somebody else's note, on a
 * page-scrolled surface where a long body can be many lines. The rule is
 * stated about rows and was settled for the rail; fixing Files and leaving
 * Notes would give two adjacent tabs in one rail different behaviour for a
 * difference no reader can see.
 *
 * =====================================================================
 * WHAT A WHOLE-LIST FETCH CHANGES
 * =====================================================================
 *
 * "ALREADY ON SCREEN" IS EASIER HERE, NOT HARDER. With no pages there is no
 * cursor naming a position in an ordering that has since moved, so the whole
 * question takeCursorPage exists to answer -- which of these rows did the
 * reader ask for? -- collapses into "all of them". lib.ts's takeWholeList is
 * what is left of that function when the pages are removed, and its doc
 * comment says why it is not takeCursorPage with a single page.
 *
 * THE COUNT IS EXACT, NEVER A FLOOR. pendingArrivals takes `headHasMore` and
 * is given `false` below as a fact rather than a simplification: `atLeast`
 * means the arrivals may run past the only page that was looked at, and there
 * is no page behind the whole list. Both of that function's exclusions are
 * also provably inert here -- nothing is ever deleted, so the fetch is a
 * SUPERSET of any snapshot of it, and every row it has gained is newer than
 * everything on screen. It is reused rather than re-derived precisely because
 * that is a reason to trust it.
 *
 * ONE QUERY, NOT TWO. The timeline and the Meetings tab each run a second
 * "page one, whatever page the reader is on" observer, because the list they
 * display can be page two while arrivals land on page one. The whole list IS
 * its own head, so there is nothing to observe separately.
 *
 * =====================================================================
 * THE ALTERNATIVES
 * =====================================================================
 *
 *   INSERT AND LET THE LIST RE-ORDER. What the code did. See above.
 *
 *   HOLD, AND REFRESH IN PLACE, WITH NO AFFORDANCE -- the shape the brief for
 *   this task suggested might be enough, and the one a whole-list fetch makes
 *   most tempting. It is not enough, and refreshing in place is not the part
 *   that fails: a note cannot change, so "refresh in place" is a no-op and the
 *   option degenerates to freezing silently. A reader with a customer's record
 *   open would then simply stop being told that a colleague had written on it,
 *   with the only way back an accident of the widget (Radix unmounts an
 *   inactive tab, so leaving the tab and returning re-snapshots) that nobody
 *   can discover. "Never moves" and "never says" are not the same promise, and
 *   the rule's own words are "without the reader ASKING" -- remove the control
 *   and there is nothing left to ask with.
 *
 *   KEEP EVERY SEEN ROW WHERE IT IS AND APPEND ARRIVALS AT THE BOTTOM. Only a
 *   whole-list fetch can even offer this -- a paged list does not know where
 *   the bottom is -- so it is the one genuinely new option here, and it is
 *   still wrong twice. A row APPEARS without the reader asking, which the rule
 *   forbids in the same breath as moving; and it destroys the ordering the
 *   surface promises, putting today's note under one from last year with both
 *   timestamps on screen to prove it.
 *
 *   PIN THE SCROLL POSITION AND LET THE ROWS INSERT. A viewport trick for a
 *   rule about rows. It keeps the pixels still while the row under them
 *   becomes a different row, which on the Files tab beside this one is exactly
 *   the bug rather than the fix.
 *
 *   RE-SNAPSHOT ON EVERY HINT. "Moves under the reader" with extra steps.
 *
 *   HOLD THE READER'S OWN WRITE TOO. Tried in v1.7.1 and reverted: it turns
 *   "write a note and watch it appear" into "write a note, then press a
 *   button", which on this tab is the primary gesture rather than an
 *   occasional one -- the composer sits at the top of the tab. useOwnWriteNonce
 *   is the signal, for the reasons hooks.ts gives.
 */
export function Notes({ companyId, contactId, dealId, projectId }: NotesProps) {
  const [draft, setDraft] = useState("");
  // Keyed because this component does NOT remount when the route params change
  // under it: without the key, a hold is the previous record's notes rendered
  // under the next record's name.
  const key = identityKey({ companyId, contactId, dealId, projectId });
  const [held, setHeld] = useState<HeldList<Note>>(() => emptyHeldList<Note>(key));
  const {
    data, isLoading, isFetching, isStale, refetch,
  } = useNotes({ companyId, contactId, dealId, projectId });
  const { data: users = [] } = useUsers();
  const createNote = useCreateNote();
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  /**
   * TAKE THE LIST ONCE, AND ONLY ONE THE QUERY STILL CALLS CURRENT.
   *
   * The `isStale` half is load-bearing rather than defensive, and the Files
   * tab is where it is easiest to see: raising a quote from the deal page's
   * Documents section invalidates ["files"] while the rail is showing some
   * other tab, so the Files tab MOUNTS over a cache entry that is present and
   * known to be out of date. Take that and hold it, and the reader's own quote
   * is behind a "Show 1 new file" button for ever -- because useOwnWriteNonce
   * below deliberately skips its mount pass, so nothing would rescue it. This
   * tab has the same shape through a note written just before the tab is left
   * (an invalidated query with no observer is not refetched, so the stale
   * entry is still there on the way back). isStale rather than isFetching for
   * the reason timeline.tsx's copy of this effect gives at length: it is a
   * property of the DATA, settled before any dispatch ordering.
   *
   * `held` IS NOT A DEPENDENCY. Every way it moves -- the take below, a record
   * change, a re-snapshot -- either writes the answer itself or moves `key`.
   */
  useEffect(() => {
    if (!data || isStale) return;
    setHeld((current) => takeWholeList(current, key, data));
  }, [data, isStale, key]);

  // held.key can lag `key` by one render (the take runs in an effect), and
  // rendering the previous record's notes for that render is the leak the key
  // exists to prevent. Memoised so the count below is not recomputed against a
  // fresh empty array on every render.
  const rows = useMemo(() => (held.key === key ? held.rows : []), [held, key]);

  /**
   * Take a new snapshot: fetch, and replace what is held with WHAT CAME BACK.
   *
   * IN THAT ORDER. Emptying first would adopt whatever the cache holds, which
   * after a write is the answer from BEFORE it -- so the note just written
   * would be missing, and the fresh list landing a moment later would find a
   * non-empty hold and take nothing from it. `refetch` on an in-flight query
   * returns that fetch's own promise, so following a mutation's own
   * invalidation costs no second request. A FAILED refetch changes nothing:
   * keeping the rows on screen beats clearing them to prove a request failed.
   */
  const keyRef = useLatest(key);
  const resnapshot = useCallback(() => {
    void refetch().then(({ data: fresh }) => {
      if (fresh === undefined) return;
      setHeld({ key: keyRef.current, rows: fresh });
    });
  }, [refetch, keyRef]);

  // The reader's own note, which is never held back. Only a CHANGE means
  // anything -- the value is a nonce -- so the mount pass is skipped rather
  // than costing a fetch on every Notes tab that ever opens.
  const ownWrite = useOwnWriteNonce();
  const seenOwnWrite = useRef(ownWrite);
  useEffect(() => {
    if (seenOwnWrite.current === ownWrite) return;
    seenOwnWrite.current = ownWrite;
    resnapshot();
  }, [ownWrite, resnapshot]);

  const pending = useMemo(
    () => (data === undefined
      ? { count: 0, atLeast: false }
      : pendingArrivals(rows, data, false, createdAtOf)),
    [data, rows],
  );

  function handleAdd() {
    const body = draft.trim();
    if (body === "") return;
    createNote.mutate({ body, companyId, contactId, dealId, projectId }, { onSuccess: () => setDraft("") });
  }

  return (
    <div data-testid="notes" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a note..."
          rows={3}
          disabled={createNote.isPending}
        />
        <div className="flex items-center justify-between gap-2">
          {createNote.isError && <p className="text-xs text-red-600">{createNote.error.message}</p>}
          <Button
            data-testid="add-note"
            className="ml-auto"
            onClick={handleAdd}
            disabled={createNote.isPending || draft.trim() === ""}
          >
            Add note
          </Button>
        </div>
      </div>
      {/* MOUNTED ALWAYS, so its live region is announced when it fills: a
          region that appears with its text already in it is one a screen
          reader has nothing to compare against. Same shape as the timeline's,
          and NOT sticky for the same reason -- a badge that follows a reader
          down the page is the interruption this design exists to remove. */}
      <div data-testid="notes-new" role="status" aria-live="polite" className="empty:hidden">
        {pending.count > 0 && (
          <Button
            variant="outline"
            className="w-full"
            data-testid="notes-new-show"
            onClick={resnapshot}
          >
            {newArrivalsLabel(pending, "note", "notes")}
          </Button>
        )}
      </div>
      {/* isFetching as well as isLoading, because of the effect above: a mount
          over data something has invalidated has `data` in hand and is still
          waiting for the answer it will actually take, and with rows still
          empty the label below would otherwise claim the record has no notes.
          Its two neighbours in this directory gate the same pair the same way.
          See pages/company-detail.tsx's Pipelines section for the full note on
          `isLoading` against `isPending`. */}
      {(isLoading || isFetching) && rows.length === 0 && (
        <p className="text-sm text-slate-400">Loading...</p>
      )}
      <ul className="flex flex-col gap-3">
        {/* NOT RE-SORTED HERE, and the line this replaces claimed it had to be
            ("the API doesn't guarantee note order"). It does: services/
            notes.ts orders `(created_at, id)` descending and notes.test.ts's
            "listNotes filters by entity and orders newest first" pins it. The
            re-sort was by createdAt alone over an array already in that order,
            which a stable sort leaves exactly as it found it -- so it was
            doing nothing, under a comment saying why it was necessary. It also
            has to go now that the order is load-bearing in a second place:
            createdAtOf above tells pendingArrivals which column this list is
            ordered by, and two statements of that could disagree. */}
        {rows.map((note) => (
          <li
            key={note.id}
            data-testid="note-row"
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              <span className="font-medium text-slate-600">{userMap.get(note.authorUserId) ?? "\u2014"}</span>
              <span>{new Date(note.createdAt).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-slate-900">{note.body}</p>
          </li>
        ))}
        {!isLoading && !isFetching && rows.length === 0 && (
          <li data-testid="notes-empty" className="text-sm text-slate-400">No notes yet</li>
        )}
      </ul>
    </div>
  );
}
