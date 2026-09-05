import { useCallback, useEffect, useMemo, useState } from "react";
import type { Meeting, MeetingAttendee, MeetingDetail, Task } from "@conduit/shared";
import {
  useArchiveMeeting,
  useContact,
  useCreateMeeting,
  useCreateMeetingTask,
  useMeeting,
  useMeetings,
  useProject,
  useUnarchiveMeeting,
  useUsers,
} from "../../queries";
import { EntityPicker } from "../entity-picker";
import {
  advanceCursorPages, cursorForKey, emptyCursorPages, flattenCursorPages, identityKey,
  pendingArrivals, refreshCursorRows, takeCursorPage, userLabel,
  type CursorPages, type PendingArrivals,
} from "../../lib";
import { useLatest } from "../../hooks";
import { RichTextEditor, RichTextView } from "../mail/rich-text";
import { OwnerSelect } from "../owner-select";
import { UserPicker } from "../user-picker";
import { STATUS_LABEL, TYPE_LABEL } from "../../pages/task-board";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  addAttendeeDraft,
  addTaskBlockedReason,
  attendeeDraftLabel,
  attendeeLabel,
  buildFollowUpInput,
  buildMeetingInput,
  emptyFollowUpDraft,
  emptyMeetingDraft,
  followUpErrorMessage,
  meetingErrorMessage,
  meetingWhenLabel,
  newMeetingsLabel,
  summarizeAttendees,
  taskCountLabel,
  type AttendeeDraft,
  type FollowUpDraft,
  type MeetingFormDraft,
  type RecordLinks,
} from "./meetings-lib";
import { CHECKBOX_LABEL, CHIP_REMOVE_TOUCH } from "../ui/touch";

export interface MeetingsProps extends RecordLinks {
  /**
   * The rail owns the selection rather than this component, because the
   * Timeline tab can open a meeting (rail.tsx switches tabs and sets this).
   * v0.9.0 ships no meetings route, so there is no URL to hold it instead.
   */
  selectedMeetingId: string | null;
  onSelectMeeting: (meetingId: string | null) => void;
}

/**
 * A record's Meetings tab: what was discussed, with whom, and what it produced.
 *
 * Master-detail rather than an expanding list: the rail is a third of a detail
 * page, and a meeting's own view carries notes, attendees, its follow-up tasks
 * and the form that adds one. The list is what a record's Meetings tab is for;
 * the view is where a single meeting is read.
 */
export function Meetings({
  companyId, contactId, dealId, projectId, selectedMeetingId, onSelectMeeting,
}: MeetingsProps) {
  const links: RecordLinks = { companyId, contactId, dealId, projectId };
  // THE LIST'S STATE LIVES HERE, not in MeetingList, because master-detail
  // UNMOUNTS the list while a meeting is open. Held one level down, "Archived"
  // silently unticked itself on the way back from an archived meeting -- so
  // the reader returned to the LIVE list, which by definition does not contain
  // the meeting they were just reading. The accumulated pages went with it,
  // which also made the accumulator decorative here: its state could never
  // survive a detail visit.
  const list = useMeetingList(links);
  return (
    <div data-testid="meetings" className="flex flex-col gap-4">
      {selectedMeetingId === null
        ? <MeetingList list={list} links={links} onSelect={onSelectMeeting} />
        : <MeetingView meetingId={selectedMeetingId} onBack={() => onSelectMeeting(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

interface MeetingListState {
  archived: boolean;
  setArchived: (next: boolean) => void;
  rows: Meeting[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /** Back to page one: fetch it, THEN discard every accumulated page. Used by
   * the reader's own "Log a meeting" and by the control that reveals what the
   * list is holding -- see the hook. */
  reset: () => void;
  retry: () => void;
  /** What has arrived that the list is not showing. */
  pending: PendingArrivals;
}

/** The column this list is ORDERED BY (api: services/meetings.ts's
 * `(occurred_at, id)` keyset), which is the only one the arrivals count may
 * read -- NOT createdAt, which is when the meeting was logged and is not what
 * decides where its row sits. At module scope so it keeps one identity. */
const occurredAtOf = (meeting: Meeting): string => meeting.occurredAt;

/**
 * The Meetings tab's list state, as one hook so it can be owned by the
 * component that stays mounted across the master-detail swap (see Meetings
 * above) while still being read by the one that renders it.
 *
 * Pages accumulate through the same cursor-page record the timeline and the
 * inbox use, keyed on the filter set -- so toggling "Archived" starts at page
 * one rather than applying the live list's cursor to the archived list.
 *
 * =====================================================================
 * THE LIST DOES NOT MOVE UNDER THE READER (v1.7.1)
 * =====================================================================
 *
 * WHAT THIS REPLACED. The accumulator took every page a fetch handed it,
 * including one it was already showing, and ["meetings"] is published by every
 * meeting write anyone makes (api: services/meetings.ts). The list is keyed
 * `(occurred_at, id)` descending and occurredAt is USER-SUPPLIED -- a colleague
 * logging a meeting, backdating one, correcting a time, or archiving one all
 * re-order the page a reader is looking at, and the row under their pointer
 * changes between two clicks. Same defect as the inbox's before v1.6.0, same
 * shape; thread-list.tsx carries the long version of the reasoning and this
 * records only what differs here.
 *
 * THE RULE: A ROW NEVER MOVES, APPEARS OR VANISHES WITHOUT THE READER ASKING;
 * A ROW THAT IS ALREADY ON SCREEN IS KEPT CURRENT WHERE IT STANDS.
 *
 * BOTH HALVES EARN THEIR KEEP HERE, which is what separates this list from the
 * timeline beside it. A timeline entry is immutable, so timeline.tsx holds and
 * refreshes nothing; a MEETING row changes constantly and in place -- its
 * follow-up task count when anyone adds a task from the meeting view, its
 * title, duration, attendees and notes when anyone edits it. Freezing outright
 * would leave "No follow-up tasks" under a meeting whose task the reader had
 * just added. So refreshCursorRows runs, from page one and only from page one
 * (its doc comment gives the one-writer argument).
 *
 * WHAT THAT COSTS, stated rather than discovered:
 *
 *   A meeting ARCHIVED by someone else keeps its row until the next snapshot.
 *   refreshCursorRows adds and removes nothing, and the archived meeting is
 *   simply absent from the live list's page one rather than present-and-
 *   changed. The row still opens, and the meeting view it opens says "This
 *   meeting is archived" with an Unarchive beside it -- stale, but never a
 *   lie, which is the trade the rule already makes for every held row.
 *
 *   A meeting BACKDATED BELOW EVERYTHING ON SCREEN is not counted either.
 *   lib.ts's pendingArrivals excludes a row older than the oldest listed,
 *   because that is how it tells an arrival from a row the server pulled up to
 *   close a gap, and it cannot tell those two apart. Such a meeting would sort
 *   below every row on screen, so nothing the reader is looking at is wrong --
 *   it is only late.
 *
 * A MEETING THE READER LOGS THEMSELVES IS NOT HELD BACK. MeetingForm calls
 * reset() when it closes, which is this surface's equivalent of the inbox's
 * refreshToken -- and unlike the timeline, this tab OWNS the write that makes
 * its own rows, so the token needs no threading. reset() takes the new
 * snapshot in the same fetch-then-empty order the control does, and for the
 * same reason: emptying first would adopt the page the cache is holding from
 * before the create, and the fresh page landing afterwards would find page one
 * held again and take nothing from it -- so the meeting just logged would
 * never appear at all.
 */
function useMeetingList(links: RecordLinks): MeetingListState {
  const [archived, setArchived] = useState(false);
  const key = identityKey({ ...links, archived });
  const [pages, setPages] = useState<CursorPages<Meeting>>(() => emptyCursorPages<Meeting>(key));
  const cursor = cursorForKey(pages, key);
  const { data, isLoading, isError, refetch } = useMeetings({ ...links, archived, cursor });
  // Page one, whatever page the reader is on: the only writer of refreshed
  // rows, the source of the arrivals count, and what makes this list live past
  // page one at all. On page one it hashes to the query above and shares its
  // cache entry and its fetch.
  const head = useMeetings({ ...links, archived });
  const headData = head.data;

  // ONLY EVER ADDS A PAGE. `pages` has to be a dependency: a re-snapshot
  // empties the accumulator without changing the data, the key or the cursor,
  // and an effect blind to it would leave the list empty until something else
  // moved. Safe because takeCursorPage settles.
  useEffect(() => {
    if (!data) return;
    setPages((current) => takeCursorPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, cursor, key, pages]);

  // ...AND PAGE ONE IS THE ONLY THING THAT REFRESHES WHAT IS ON SCREEN. Two
  // fetches writing row objects would hand out different objects for any row
  // they both covered and rewrite each other's, from an effect, for ever.
  useEffect(() => {
    if (!headData) return;
    setPages((current) => refreshCursorRows(current, key, headData.items));
  }, [headData, key, pages]);

  const rows = useMemo(() => (pages.key === key ? flattenCursorPages(pages) : []), [pages, key]);

  const headRefetch = head.refetch;
  // The key AS OF THE RESET, not as of the ask: "Archived" toggled while the
  // fetch is in flight would otherwise re-key the accumulator backwards.
  const keyRef = useLatest(key);
  const reset = useCallback(() => {
    void headRefetch().then(() => setPages(emptyCursorPages<Meeting>(keyRef.current)));
  }, [headRefetch, keyRef]);

  const pending = useMemo(
    () => (headData === undefined
      ? { count: 0, atLeast: false }
      : pendingArrivals(rows, headData.items, headData.nextCursor !== null, occurredAtOf)),
    [headData, rows],
  );

  return {
    archived,
    setArchived,
    rows,
    isLoading,
    isError,
    // pages.key can lag `key` by one render (the take runs in an effect), and
    // offering the previous filter's "Load more" for that render would page
    // the wrong list.
    hasMore: pages.key === key && pages.nextCursor !== null,
    loadMore: () => setPages((current) => advanceCursorPages(current, key)),
    reset,
    // The only escape from a failed page fetch. `loadMore` cannot serve: the
    // cursor is ALREADY at nextCursor, so advancing again produces the same
    // query key, which TanStack answers from its error state without going
    // near the network. Clicking would look like doing something and do
    // nothing, forever.
    retry: () => { void refetch(); },
    pending,
  };
}

function MeetingList({
  list, links, onSelect,
}: { list: MeetingListState; links: RecordLinks; onSelect: (id: string) => void }) {
  const [formOpen, setFormOpen] = useState(false);
  const { archived, rows, isLoading, isError } = list;

  return (
    <>
      <div className="flex items-center gap-3">
        <Button data-testid="log-meeting" onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? "Cancel" : "Log a meeting"}
        </Button>
        <label className={CHECKBOX_LABEL}>
          <input
            type="checkbox"
            data-testid="show-archived-meetings"
            checked={archived}
            onChange={(event) => list.setArchived(event.target.checked)}
          />
          Archived
        </label>
      </div>

      {formOpen && (
        <MeetingForm
          links={links}
          onDone={() => {
            setFormOpen(false);
            list.reset();
          }}
        />
      )}

      {/* MOUNTED ALWAYS, so its live region is announced when it fills, and
          NOT sticky -- the reasoning is thread-list.tsx's, which renders the
          same control for the same rule. */}
      <div data-testid="meetings-new" role="status" aria-live="polite" className="empty:hidden">
        {list.pending.count > 0 && (
          <Button
            variant="outline"
            className="w-full"
            data-testid="meetings-new-show"
            onClick={list.reset}
          >
            {newMeetingsLabel(list.pending)}
          </Button>
        )}
      </div>

      {isLoading && rows.length === 0 && <p className="text-sm text-slate-400">Loading...</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((meeting) => (
          <MeetingRow key={meeting.id} meeting={meeting} onSelect={onSelect} />
        ))}
        {/* An empty list and a FAILED list are different facts, and rendering
            the first for the second is the worse of the two mistakes: "No
            meetings yet" on a record that has plenty reads as data loss. */}
        {!isLoading && !isError && rows.length === 0 && (
          <li data-testid="meetings-empty" className="text-sm text-slate-400">
            {archived ? "No archived meetings" : "No meetings yet"}
          </li>
        )}
      </ul>

      {isError ? (
        <div className="flex items-center gap-2">
          <p role="alert" data-testid="meetings-error" className="text-xs text-red-600">
            {rows.length === 0 ? "Could not load meetings." : "Could not load more meetings."}
          </p>
          <Button variant="outline" className="px-2 py-1 text-xs" data-testid="meetings-retry" onClick={list.retry}>
            Retry
          </Button>
        </div>
      ) : list.hasMore && (
        <Button variant="outline" data-testid="meetings-load-more" onClick={list.loadMore}>
          Load more
        </Button>
      )}
    </>
  );
}

function MeetingRow({ meeting, onSelect }: { meeting: Meeting; onSelect: (id: string) => void }) {
  return (
    <li data-testid={`meeting-row-${meeting.id}`} className="rounded-md border border-slate-200 bg-white">
      <button
        type="button"
        className="block w-full px-3 py-2 text-left hover:bg-slate-50"
        onClick={() => onSelect(meeting.id)}
      >
        <span className="block text-sm font-medium text-slate-900">{meeting.title}</span>
        <span className="mt-0.5 block text-xs text-slate-400">
          {meetingWhenLabel(meeting.occurredAt, meeting.durationMinutes)}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">
          <AttendeeSummary attendees={meeting.attendees} />
        </span>
        <span className="mt-0.5 block text-xs text-slate-400">{taskCountLabel(meeting.taskCount)}</span>
      </button>
    </li>
  );
}

/** The named attendees plus a count of the rest -- see the cap's comment in
 * meetings-lib for why a row stops naming them. */
function AttendeeSummary({ attendees }: { attendees: readonly MeetingAttendee[] }) {
  const { shown, overflow } = summarizeAttendees(attendees);
  if (attendees.length === 0) return <>No attendees</>;
  return (
    <>
      {shown.map((attendee, index) => (
        <span key={attendee.id}>
          {index === 0 ? "" : ", "}
          <AttendeeName attendee={attendee} />
        </span>
      ))}
      {overflow > 0 && `, +${overflow} more`}
    </>
  );
}

/**
 * One attendee's name. A CONTACT costs a `GET /api/contacts/:id` -- there is
 * no lookup-by-id-set route, and this is the same per-id-hook shape the mail
 * link panel and the task drawer already use to name a record they hold only
 * an id for. TanStack keys it on ["contact", id], so the same person on
 * several of this record's meetings is fetched once.
 */
function AttendeeName({ attendee }: { attendee: MeetingAttendee }) {
  const { data: contact } = useContact(attendee.contactId ?? "");
  const { data: users = [] } = useUsers();
  const user = attendee.userId === null ? undefined : users.find((u) => u.id === attendee.userId);
  return (
    <>
      {attendeeLabel(attendee, {
        contactName: contact === undefined ? undefined : `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
        userName: userLabel(user, undefined),
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * "Log a meeting". The record links are taken from the rail's own props and
 * are NOT offered as fields: this tab is rendered on a record, that record is
 * what the meeting is about, and a meeting must carry at least one link to be
 * reachable at all (the spec's reachability decision -- there is no top-level
 * meetings list to find an unlinked one from).
 */
function MeetingForm({ links, onDone }: { links: RecordLinks; onDone: () => void }) {
  const [draft, setDraft] = useState<MeetingFormDraft>(() => emptyMeetingDraft());
  const [error, setError] = useState<string | null>(null);
  const [pickingContact, setPickingContact] = useState(false);
  const [guest, setGuest] = useState("");
  const createMeeting = useCreateMeeting();
  const chosenUserIds = draft.attendees.flatMap((a) => (a.kind === "user" ? [a.id] : []));

  function addAttendee(next: AttendeeDraft) {
    const merged = addAttendeeDraft(draft.attendees, next);
    if (merged === null) {
      // The duplicate the API would answer 409 `duplicate_attendee` for,
      // caught before the round trip.
      setError("That person is already on the attendee list.");
      return;
    }
    setError(null);
    setDraft((current) => ({ ...current, attendees: merged }));
  }

  function removeAttendee(index: number) {
    setDraft((current) => ({ ...current, attendees: current.attendees.filter((_, i) => i !== index) }));
  }

  function addGuest() {
    const name = guest.trim();
    if (name === "") return;
    addAttendee({ kind: "guest", name });
    setGuest("");
  }

  function submit() {
    const built = buildMeetingInput(draft, links);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    createMeeting.mutate(built.input, {
      // No draft reset: onDone unmounts this form, so reopening it starts from
      // emptyMeetingDraft() with a fresh "now" and a fresh editor.
      onSuccess: () => onDone(),
      onError: (err) => setError(meetingErrorMessage(err)),
    });
  }

  return (
    <div data-testid="meeting-form" className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3">
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        Title
        <Input
          data-testid="meeting-title"
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          placeholder="What was this meeting?"
        />
      </label>

      {/*
        The one side-by-side field pair in this form, stacked below the
        breakpoint: a datetime-local control has a wide intrinsic width of its
        own, and sharing a 300px rail column with a 7rem number field left it
        clipping its own AM/PM segment.
      */}
      <div className="flex gap-2 max-md:flex-col">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
          When
          <Input
            type="datetime-local"
            data-testid="meeting-when"
            value={draft.when}
            onChange={(event) => setDraft((current) => ({ ...current, when: event.target.value }))}
          />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs font-medium text-slate-500 max-md:w-full">
          Minutes
          <Input
            type="number"
            min={1}
            step={1}
            data-testid="meeting-duration"
            value={draft.durationMinutes}
            onChange={(event) => setDraft((current) => ({ ...current, durationMinutes: event.target.value }))}
            placeholder="Optional"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-slate-500">Attendees</span>
        <div className="flex flex-wrap items-center gap-1">
          {draft.attendees.length === 0 && <span className="text-xs text-slate-400">Nobody yet</span>}
          {draft.attendees.map((attendee, index) => (
            <span
              key={`${attendee.kind}:${attendee.kind === "guest" ? attendee.name : attendee.id}:${index}`}
              data-testid="meeting-attendee-chip"
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
            >
              {attendeeDraftLabel(attendee)}
              <button
                type="button"
                aria-label={`Remove ${attendeeDraftLabel(attendee)}`}
                className={`text-slate-400 hover:text-slate-900 ${CHIP_REMOVE_TOUCH}`}
                onClick={() => removeAttendee(index)}
              >
                {"\u00D7"}
              </button>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            data-testid="meeting-add-contact"
            onClick={() => setPickingContact((open) => !open)}
          >
            Add contact
          </Button>
          <div className="w-44">
            {/* Colleagues already on the list are not offered again, so the
                duplicate this used to answer with an error cannot be asked
                for. addAttendee's guard still covers contacts, which are
                picked from a search that knows nothing about this draft. */}
            <UserPicker
              chosenUserIds={chosenUserIds}
              placeholder="Add a colleague..."
              ariaLabel="Add a user attendee"
              testId="meeting-add-user"
              onPick={(id, label) => addAttendee({ kind: "user", id, label })}
            />
          </div>
        </div>

        {pickingContact && (
          <EntityPicker
            kind="contact"
            onPick={(id, label) => {
              setPickingContact(false);
              addAttendee({ kind: "contact", id, label });
            }}
            onCancel={() => setPickingContact(false)}
          />
        )}

        <div className="flex items-center gap-2">
          <Input
            data-testid="meeting-guest"
            aria-label="Guest name"
            placeholder="Someone not in the CRM"
            value={guest}
            onChange={(event) => setGuest(event.target.value)}
          />
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="meeting-add-guest"
            onClick={addGuest}
            disabled={guest.trim() === ""}
          >
            Add guest
          </Button>
        </div>
      </div>

      {/* A <div>, not a <label>: the editor is a contenteditable, which is not
          a labelable element, so a wrapping label would associate with nothing
          while still swallowing clicks meant for the toolbar buttons inside
          it. The accessible name comes from ariaLabel, which RichTextEditor
          puts on the editor itself. */}
      <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        <span>Notes</span>
        <RichTextEditor
          testId="meeting-notes"
          ariaLabel="Meeting notes"
          onChange={(html) => setDraft((current) => ({ ...current, notesHtml: html }))}
        />
      </div>

      {error !== null && <p role="alert" className="text-xs text-red-600">{error}</p>}

      <div className="flex justify-end">
        <Button data-testid="meeting-submit" onClick={submit} disabled={createMeeting.isPending}>
          {createMeeting.isPending ? "Saving..." : "Save meeting"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One meeting
// ---------------------------------------------------------------------------

/**
 * One meeting: the shell that fetches it, and the frame that is always
 * present.
 *
 * THE BACK CONTROL AND THE ERROR ARE NOT ALTERNATIVES. An earlier shape
 * returned the error INSTEAD of the view, which put `meeting-back` behind the
 * very condition a reader needs it for: the rail's selection still held this
 * meeting, so a failed fetch left no exit but navigating away or reloading the
 * page. It also threw away good data -- TanStack keeps `data` through an
 * error, so with a 10s staleTime and refetch-on-focus, one transient blip
 * after a refocus replaced a perfectly readable meeting (title, notes,
 * attendees, tasks) with a single red line.
 *
 * That shape was copied from conversation.tsx, where error-beats-stale-data is
 * a DELIBERATE privacy decision -- a thread the server has stopped saying you
 * may see must stop being painted. No such rule applies to a meeting: it is
 * visible to every user of this CRM, so stale is strictly better than blank,
 * and the error belongs beside it as a banner.
 */
function MeetingView({ meetingId, onBack }: { meetingId: string; onBack: () => void }) {
  const { data, isLoading, error } = useMeeting(meetingId);
  const archiveMeeting = useArchiveMeeting();
  const unarchiveMeeting = useUnarchiveMeeting();
  const [banner, setBanner] = useState<string | null>(null);

  const meeting = data?.meeting;
  const loadError = error === null ? null : meetingErrorMessage(error);

  function toggleArchive(next: boolean) {
    setBanner(null);
    const mutation = next ? archiveMeeting : unarchiveMeeting;
    mutation.mutate(meetingId, { onError: (err) => setBanner(meetingErrorMessage(err)) });
  }

  return (
    <div data-testid="meeting-view" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" className="px-2 py-1 text-xs" data-testid="meeting-back" onClick={onBack}>
          {"\u2190"} All meetings
        </Button>
        {meeting !== undefined && (meeting.archivedAt !== null ? (
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="meeting-unarchive"
            onClick={() => toggleArchive(false)}
          >
            Unarchive
          </Button>
        ) : (
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="meeting-archive"
            onClick={() => toggleArchive(true)}
          >
            Archive
          </Button>
        ))}
      </div>

      {loadError !== null && (
        <p role="alert" data-testid="meeting-error" className="text-xs text-red-600">{loadError}</p>
      )}
      {banner !== null && <p role="alert" className="text-xs text-red-600">{banner}</p>}

      {data === undefined
        ? isLoading && <p className="text-sm text-slate-400">Loading...</p>
        : <MeetingBody detail={data} />}
    </div>
  );
}

function MeetingBody({ detail }: { detail: MeetingDetail }) {
  const { meeting } = detail;
  // THE ARCHIVED-PROJECT GATE'S ONE FETCH. GET /api/projects/:id answers for
  // an archived project too, and the hook keys on ["project", id] -- so this
  // is a cache read whenever the rail is already on that project's page, and
  // one request otherwise. `isError` is passed rather than discarded so a
  // failed fetch does not read as one still running: see
  // addTaskBlockedReason.
  const { data: project, isError: projectFailed } = useProject(meeting.projectId ?? "");
  const { data: users = [] } = useUsers();
  const [addingTask, setAddingTask] = useState(false);

  const owner = users.find((u) => u.id === meeting.ownerUserId);
  const archived = meeting.archivedAt !== null;
  const blockedReason = addTaskBlockedReason({
    meetingArchived: archived,
    projectId: meeting.projectId,
    project,
    projectFailed,
  });

  return (
    <>
      <div>
        <h3 className="text-sm font-medium text-slate-900">{meeting.title}</h3>
        <p className="text-xs text-slate-400">
          {meetingWhenLabel(meeting.occurredAt, meeting.durationMinutes)}
          {` \u00B7 logged by ${userLabel(owner, "\u2014")}`}
        </p>
        {archived && <p className="text-xs text-slate-500">This meeting is archived.</p>}
      </div>

      <section className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">Attendees</span>
        <ul data-testid="meeting-attendees" className="flex flex-wrap gap-1">
          {meeting.attendees.length === 0 && <li className="text-xs text-slate-400">Nobody recorded</li>}
          {meeting.attendees.map((attendee) => (
            <li
              key={attendee.id}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
            >
              <AttendeeName attendee={attendee} />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">Notes</span>
        {meeting.notes === null ? (
          <p className="text-xs text-slate-400">No notes</p>
        ) : (
          // Keyed on updatedAt because the view reads its HTML once (see
          // RichTextView): an edit landing from another session must remount
          // it rather than leave the old document on screen.
          <RichTextView
            key={meeting.updatedAt}
            html={meeting.notes}
            testId="meeting-notes-body"
            ariaLabel="Meeting notes"
            className="rounded-md border border-slate-200 px-3 py-2"
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">{taskCountLabel(detail.tasks.length)}</span>
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="meeting-add-task"
            disabled={blockedReason !== null}
            onClick={() => setAddingTask((open) => !open)}
          >
            {addingTask ? "Cancel" : "Add task"}
          </Button>
        </div>
        {/* One testid for all four reasons, deliberately: they differ in TEXT,
            not in kind, and a test that wants to tell "checking" from "the
            project is archived" apart must read the message either way. */}
        {blockedReason !== null && (
          <p data-testid="meeting-add-task-blocked" className="text-xs text-slate-500">
            {blockedReason}
          </p>
        )}
        {addingTask && blockedReason === null && (
          <AddTaskForm meetingId={meeting.id} onDone={() => setAddingTask(false)} />
        )}
        <ul className="flex flex-col gap-1">
          {detail.tasks.map((task) => (
            <FollowUpRow key={task.id} task={task} />
          ))}
        </ul>
      </section>
    </>
  );
}

function FollowUpRow({ task }: { task: Task }) {
  return (
    <li
      data-testid={`meeting-task-${task.id}`}
      className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
    >
      <span className="block">{task.title}</span>
      <span className="block text-xs text-slate-400">
        {`${TYPE_LABEL[task.type]} \u00B7 ${STATUS_LABEL[task.status]}`}
      </span>
    </li>
  );
}

/**
 * The follow-up task form: a title, a description and an assignee, and
 * nothing else -- see buildFollowUpInput for why the record links, the parent
 * task and the dates are all deliberately absent. The task drawer is where a
 * follow-up gets scheduled; this is where it gets captured.
 */
function AddTaskForm({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
  const [draft, setDraft] = useState<FollowUpDraft>(() => emptyFollowUpDraft());
  const [error, setError] = useState<string | null>(null);
  const createMeetingTask = useCreateMeetingTask();

  function submit() {
    const built = buildFollowUpInput(draft);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    createMeetingTask.mutate({ meetingId, input: built.input }, {
      onSuccess: () => onDone(),
      onError: (err) => setError(followUpErrorMessage(err)),
    });
  }

  return (
    <div data-testid="meeting-task-form" className="flex flex-col gap-2 rounded-md border border-slate-200 p-2">
      <Input
        data-testid="meeting-task-title"
        aria-label="Follow-up task title"
        placeholder="What needs doing?"
        value={draft.title}
        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
      />
      <Textarea
        data-testid="meeting-task-description"
        aria-label="Follow-up task description"
        placeholder="Details (optional)"
        rows={2}
        value={draft.description}
        onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
      />
      <OwnerSelect
        value={draft.assigneeUserId}
        ariaLabel="Follow-up task assignee"
        testId="meeting-task-assignee"
        onChange={(assigneeUserId) => setDraft((current) => ({ ...current, assigneeUserId }))}
      />
      {error !== null && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end">
        <Button
          className="px-2 py-1 text-xs"
          data-testid="meeting-task-submit"
          onClick={submit}
          disabled={createMeetingTask.isPending}
        >
          {createMeetingTask.isPending ? "Adding..." : "Add task"}
        </Button>
      </div>
    </div>
  );
}
