import { useEffect, useMemo, useState } from "react";
import type { Meeting, MeetingAttendee, Task } from "@conduit/shared";
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
  advanceThreadPages, cursorForKey, emptyThreadPages, flattenThreadPages, mergeThreadPage,
  threadFilterKey, type ThreadPages,
} from "../mail/mail-lib";
import { RichTextEditor, RichTextView } from "../mail/rich-text";
import { OwnerSelect } from "../owner-select";
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
  durationLabel,
  emptyFollowUpDraft,
  emptyMeetingDraft,
  followUpErrorMessage,
  meetingErrorMessage,
  summarizeAttendees,
  taskCountLabel,
  type AttendeeDraft,
  type FollowUpDraft,
  type MeetingFormDraft,
  type RecordLinks,
} from "./meetings-lib";

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
  return (
    <div data-testid="meetings" className="flex flex-col gap-4">
      {selectedMeetingId === null
        ? <MeetingList links={links} onSelect={onSelectMeeting} />
        : <MeetingView meetingId={selectedMeetingId} onBack={() => onSelectMeeting(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function MeetingList({ links, onSelect }: { links: RecordLinks; onSelect: (id: string) => void }) {
  const [archived, setArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // Same cursor-page accumulator the timeline and the inbox use, keyed on the
  // filter set -- so toggling "Archived" starts at page one rather than
  // applying the live list's cursor to the archived one, and a background
  // ["meetings"] invalidation (another user logging a meeting on this record,
  // or a follow-up task changing a task count) replaces the page it refetched
  // instead of appending it again.
  const key = threadFilterKey({ ...links, archived });
  const [pages, setPages] = useState<ThreadPages<Meeting>>(() => emptyThreadPages<Meeting>(key));
  const cursor = cursorForKey(pages, key);
  const { data, isLoading } = useMeetings({ ...links, archived, cursor });

  useEffect(() => {
    if (!data) return;
    setPages((current) => mergeThreadPage(current, key, cursor, data.items, data.nextCursor));
  }, [data, cursor, key]);

  const rows = useMemo(() => (pages.key === key ? flattenThreadPages(pages) : []), [pages, key]);
  const hasMore = pages.key === key && pages.nextCursor !== null;

  return (
    <>
      <div className="flex items-center gap-3">
        <Button data-testid="log-meeting" onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? "Cancel" : "Log a meeting"}
        </Button>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            data-testid="show-archived-meetings"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Archived
        </label>
      </div>

      {formOpen && <MeetingForm links={links} onDone={() => setFormOpen(false)} />}

      {isLoading && rows.length === 0 && <p className="text-sm text-slate-400">Loading...</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((meeting) => (
          <MeetingRow key={meeting.id} meeting={meeting} onSelect={onSelect} />
        ))}
        {!isLoading && rows.length === 0 && (
          <li className="text-sm text-slate-400">{archived ? "No archived meetings" : "No meetings yet"}</li>
        )}
      </ul>

      {hasMore && (
        <Button variant="outline" onClick={() => setPages((current) => advanceThreadPages(current, key))}>
          Load more
        </Button>
      )}
    </>
  );
}

function MeetingRow({ meeting, onSelect }: { meeting: Meeting; onSelect: (id: string) => void }) {
  const duration = durationLabel(meeting.durationMinutes);
  return (
    <li data-testid={`meeting-row-${meeting.id}`} className="rounded-md border border-slate-200 bg-white">
      <button
        type="button"
        className="block w-full px-3 py-2 text-left hover:bg-slate-50"
        onClick={() => onSelect(meeting.id)}
      >
        <span className="block text-sm font-medium text-slate-900">{meeting.title}</span>
        <span className="mt-0.5 block text-xs text-slate-400">
          {new Date(meeting.occurredAt).toLocaleString()}
          {duration === null ? "" : ` \u00B7 ${duration}`}
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
        userName: user === undefined ? undefined : user.fullName ?? user.username,
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
  const userLabel = useUserLabel();

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

      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
          When
          <Input
            type="datetime-local"
            data-testid="meeting-when"
            value={draft.when}
            onChange={(event) => setDraft((current) => ({ ...current, when: event.target.value }))}
          />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs font-medium text-slate-500">
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
                className="text-slate-400 hover:text-slate-900"
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
            <OwnerSelect
              value={null}
              unassignedLabel="Add a colleague..."
              ariaLabel="Add a user attendee"
              testId="meeting-add-user"
              onChange={(userId) => {
                if (userId === null) return;
                addAttendee({ kind: "user", id: userId, label: userLabel(userId) });
              }}
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

/** The user picker hands back an id; this names them for the chip. Reads the
 * same ["users"] cache entry the picker itself renders from, so it is never a
 * second request. */
function useUserLabel(): (userId: string) => string {
  const { data: users = [] } = useUsers();
  return (userId: string) => {
    const user = users.find((u) => u.id === userId);
    return user === undefined ? "..." : user.fullName ?? user.username;
  };
}

// ---------------------------------------------------------------------------
// One meeting
// ---------------------------------------------------------------------------

function MeetingView({ meetingId, onBack }: { meetingId: string; onBack: () => void }) {
  const { data, isLoading, error } = useMeeting(meetingId);
  const meeting = data?.meeting;
  // THE ARCHIVED-PROJECT GATE'S ONE FETCH. GET /api/projects/:id answers for
  // an archived project too, and the hook keys on ["project", id] -- so this
  // is a cache read whenever the rail is already on that project's page, and
  // one request otherwise. See addTaskBlockedReason for why it is needed at
  // all.
  const { data: project } = useProject(meeting?.projectId ?? "");
  const { data: users = [] } = useUsers();
  const archiveMeeting = useArchiveMeeting();
  const unarchiveMeeting = useUnarchiveMeeting();
  const [banner, setBanner] = useState<string | null>(null);
  const [addingTask, setAddingTask] = useState(false);

  if (isLoading) return <p className="text-sm text-slate-400">Loading...</p>;
  if (error !== null) return <p className="text-sm text-red-600">{meetingErrorMessage(error)}</p>;
  if (data === undefined || meeting === undefined) return null;

  const owner = users.find((u) => u.id === meeting.ownerUserId);
  const duration = durationLabel(meeting.durationMinutes);
  const archived = meeting.archivedAt !== null;
  const blockedReason = addTaskBlockedReason({
    meetingArchived: archived,
    projectId: meeting.projectId,
    project,
  });

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
        {archived ? (
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
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium text-slate-900">{meeting.title}</h3>
        <p className="text-xs text-slate-400">
          {new Date(meeting.occurredAt).toLocaleString()}
          {duration === null ? "" : ` \u00B7 ${duration}`}
          {` \u00B7 logged by ${owner === undefined ? "\u2014" : owner.fullName ?? owner.username}`}
        </p>
        {archived && <p className="text-xs text-slate-500">This meeting is archived.</p>}
      </div>

      {banner !== null && <p role="alert" className="text-xs text-red-600">{banner}</p>}

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
            className="rounded-md border border-slate-200 px-3 py-2"
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">{taskCountLabel(data.tasks.length)}</span>
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
        {blockedReason !== null && (
          <p data-testid="meeting-add-task-blocked" className="text-xs text-slate-500">
            {blockedReason}
          </p>
        )}
        {addingTask && blockedReason === null && (
          <AddTaskForm meetingId={meeting.id} onDone={() => setAddingTask(false)} />
        )}
        <ul className="flex flex-col gap-1">
          {data.tasks.map((task) => (
            <FollowUpRow key={task.id} task={task} />
          ))}
        </ul>
      </section>
    </div>
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
