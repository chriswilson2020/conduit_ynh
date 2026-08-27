import type {
  MeetingAttendee, MeetingAttendeeInput, MeetingCreateInput, MeetingTaskCreateInput,
} from "@conduit/shared";
import { meetingAtLeastOneLink } from "@conduit/shared";
import { ApiError } from "../../api";
import { htmlIsBlank } from "../mail/mail-lib";

/**
 * The Meetings rail tab's pure parts: the form's draft-to-wire conversion, the
 * attendee draft list, the labels the list and detail views render, and the
 * two error-mapping functions. Kept out of meetings.tsx so they can be
 * unit-tested without a DOM -- this project wires no testing-library, so a
 * component's logic is only reachable by a test once it is a pure module
 * (mail-lib.ts is the precedent this follows).
 *
 * Nothing here touches the network, React or TipTap.
 */

// ---------------------------------------------------------------------------
// The "when" field
// ---------------------------------------------------------------------------

/**
 * `now` as an <input type="datetime-local"> value, which is a LOCAL wall-clock
 * string with no zone -- the same reason lib.ts's todayLocalIso builds its
 * date by hand rather than slicing toISOString(): that method is always UTC,
 * so anyone east or west of Greenwich would find the form pre-filled with the
 * wrong hour (and, near midnight, the wrong day).
 *
 * Seconds are deliberately absent: the browser widget hides them by default,
 * and a value carrying them makes it show a seconds spinner nobody wants for
 * "when was this meeting".
 */
export function nowLocalInput(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * The inverse: a datetime-local value to the UTC ISO instant the API takes.
 *
 * THE CONVERSION IS NOT OPTIONAL. `occurredAt` is `z.iso.datetime()`, which
 * rejects both a bare local string ("2026-08-27T14:30", no zone) and an
 * offset-bearing one ("...+02:00") -- only a Z instant parses, so posting the
 * input's raw value is a 400 every time. `new Date(value)` reads a
 * zone-less date-TIME as local (a date-ONLY string would be UTC, which is the
 * asymmetry in the ECMAScript grammar that makes this worth stating), and
 * toISOString() then names that same instant in UTC.
 *
 * Returns null for anything that is not a complete local date-TIME -- an empty
 * field, or a partial value -- so the caller reports one clean "enter a date"
 * rather than posting "Invalid Date".
 *
 * THE SHAPE IS CHECKED BEFORE `new Date` RUNS, rather than left to it. Date's
 * parser is lenient about what it accepts outside the ECMAScript grammar, and
 * silently reads the fragments it does accept as UTC -- "2026-08-" parses as
 * midnight UTC on the 1st -- which is exactly the local/UTC asymmetry named
 * above, arriving as a plausible-looking instant instead of a NaN. A shape
 * this narrow can only be the complete form, which Date reads as local.
 * Seconds are optional because a widget given a `step` can supply them.
 */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function localInputToIso(value: string): string | null {
  if (!LOCAL_DATE_TIME.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Row labels
// ---------------------------------------------------------------------------

/** "45m", "1h", "1h 30m" -- or null for the honest "nobody recorded how long
 * it ran", which the row renders as nothing at all rather than as "0m"
 * (durationMinutes is `.int().positive().nullable()`, so 0 is not a value it
 * can hold). */
export function durationLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function taskCountLabel(count: number): string {
  if (count === 0) return "No follow-up tasks";
  return count === 1 ? "1 follow-up task" : `${count} follow-up tasks`;
}

/** How many attendees a list row names before it stops naming them. Each
 * named CONTACT attendee costs a `GET /api/contacts/:id` (there is no
 * lookup-by-id-set route), so the cap is what keeps a page of rows from
 * turning into a request per attendee -- TanStack dedupes by key, which
 * collapses the repeats but not the first sighting of each. */
export const ATTENDEE_SUMMARY_CAP = 3;

/** Splits an attendee list into the ones a row names and a count of the rest.
 * Generic because the caller holds `MeetingAttendee`s and the test holds
 * anything with the same shape; the rule is about arity, not about attendees. */
export function summarizeAttendees<T>(
  attendees: readonly T[], cap: number = ATTENDEE_SUMMARY_CAP,
): { shown: T[]; overflow: number } {
  const shown = attendees.slice(0, cap);
  return { shown, overflow: attendees.length - shown.length };
}

/** Names resolved elsewhere: a user's from the one `useUsers()` list every
 * rail already holds, a contact's from that contact's own query. Both are
 * optional because either can still be in flight. */
export interface AttendeeNames {
  contactName?: string | undefined;
  userName?: string | undefined;
}

/**
 * What one stored attendee is called. A guest carries their own name (that IS
 * the row), so it never waits on anything; a contact or user shows an ellipsis
 * until their name arrives rather than a raw uuid or a blank.
 */
export function attendeeLabel(attendee: MeetingAttendee, names: AttendeeNames = {}): string {
  if (attendee.guestName !== null) return attendee.guestName;
  if (attendee.contactId !== null) return names.contactName ?? "...";
  if (attendee.userId !== null) return names.userName ?? "...";
  // Unreachable while meeting_attendees_exactly_one holds (api: db/schema.ts):
  // no row can have all three null. Rendered rather than thrown, because a
  // timeline tab is not the place to discover a violated CHECK.
  return "\u2014";
}

// ---------------------------------------------------------------------------
// Attendee drafts (the form, before the meeting exists)
// ---------------------------------------------------------------------------

/**
 * One attendee as the form holds it: the identity the API needs, plus the
 * label the picker already resolved. Keeping the label means a chip in the
 * form never re-fetches a name the picker was holding a moment ago.
 */
export type AttendeeDraft =
  | { kind: "contact"; id: string; label: string }
  | { kind: "user"; id: string; label: string }
  | { kind: "guest"; name: string };

/**
 * Appends an attendee, or returns null when the list already names that
 * person -- which is the 409 `duplicate_attendee` the API answers with
 * (services/meetings.ts, mapped from the two partial unique indexes 0008
 * ships). Refusing it here means the common case never round-trips to find
 * that out.
 *
 * GUESTS ARE NEVER DEDUPED, matching the database: 0008 indexes contact and
 * user attendance and deliberately leaves guest_name alone, because two
 * people at one meeting can share a first name and the CRM knows nothing
 * about either of them.
 */
export function addAttendeeDraft(
  list: readonly AttendeeDraft[], next: AttendeeDraft,
): AttendeeDraft[] | null {
  if (next.kind !== "guest") {
    const clash = list.some((a) => a.kind === next.kind && a.id === next.id);
    if (clash) return null;
  }
  return [...list, next];
}

export function attendeeDraftLabel(draft: AttendeeDraft): string {
  return draft.kind === "guest" ? draft.name : draft.label;
}

/** Draft list to wire shape. Guest names are trimmed here as well as by the
 * shared schema's own `.trim()`, so a blank one is caught by the form's
 * validation below rather than by a 400. */
export function attendeeDraftsToInput(list: readonly AttendeeDraft[]): MeetingAttendeeInput[] {
  return list.map((draft) => {
    switch (draft.kind) {
      case "contact":
        return { contactId: draft.id };
      case "user":
        return { userId: draft.id };
      case "guest":
        return { guestName: draft.name.trim() };
    }
  });
}

// ---------------------------------------------------------------------------
// The "Log a meeting" form
// ---------------------------------------------------------------------------

export interface MeetingFormDraft {
  title: string;
  /** Raw <input type="datetime-local"> value. */
  when: string;
  /** Raw text; blank means "nobody recorded how long it ran". */
  durationMinutes: string;
  /** TipTap's HTML. Blank (which is `<p></p>` from an untouched editor, not
   * "") becomes null: `notes` is `.min(1).nullable()`, so "" is a 400 and not
   * an empty note. */
  notesHtml: string;
  attendees: readonly AttendeeDraft[];
}

/** The four record links the meeting inherits from the rail it was logged in.
 * Exactly the props every rail tab takes. */
export interface RecordLinks {
  companyId?: string | undefined;
  contactId?: string | undefined;
  dealId?: string | undefined;
  projectId?: string | undefined;
}

export function emptyMeetingDraft(now: Date = new Date()): MeetingFormDraft {
  return { title: "", when: nowLocalInput(now), durationMinutes: "", notesHtml: "", attendees: [] };
}

export type BuildResult<T> = { ok: true; input: T } | { ok: false; error: string };

/**
 * The form's one validation gate, ordered so the message names the first thing
 * a user can fix. Every rule here has a server-side twin that would answer 400
 * -- this exists to answer instantly and in words about the field, not to be
 * the only check.
 *
 * The at-least-one-link rule runs through the SHARED predicate
 * (meetingAtLeastOneLink), never a fourth hand-written copy of it: it is the
 * same rule as the meetings_has_link CHECK and meetingCreateInputSchema's
 * refine. In practice a rail always passes one of the four -- it is rendered
 * on a record -- so this arm is a guard against a future caller, and the
 * spec's "surfaced in the UI as a required field" for the case where there is
 * genuinely nothing to link to.
 */
export function buildMeetingInput(draft: MeetingFormDraft, links: RecordLinks): BuildResult<MeetingCreateInput> {
  const title = draft.title.trim();
  if (title === "") return { ok: false, error: "A meeting needs a title." };

  const occurredAt = localInputToIso(draft.when);
  if (occurredAt === null) return { ok: false, error: "Enter the date and time this meeting happened." };

  const durationMinutes = parseDurationMinutes(draft.durationMinutes);
  if (durationMinutes === "invalid") {
    return { ok: false, error: "Duration must be a whole number of minutes, or left blank." };
  }

  if (draft.attendees.some((a) => a.kind === "guest" && a.name.trim() === "")) {
    return { ok: false, error: "A guest attendee needs a name." };
  }

  if (!meetingAtLeastOneLink(links)) {
    return { ok: false, error: "A meeting must be linked to a company, contact, deal or project." };
  }

  return {
    ok: true,
    input: {
      title,
      occurredAt,
      durationMinutes,
      // Blank -> null, never "": nullableString is `.min(1).nullable()`.
      notes: htmlIsBlank(draft.notesHtml) ? null : draft.notesHtml,
      ...links,
      attendees: attendeeDraftsToInput(draft.attendees),
    },
  };
}

/** null for a blank field (the API's "unknown", and what the column stores),
 * "invalid" for anything that is not a positive whole number -- 0 and 12.5 are
 * both 400s against `.int().positive()`, so neither may be sent. */
function parseDurationMinutes(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return "invalid";
  return parsed;
}

// ---------------------------------------------------------------------------
// The follow-up task form
// ---------------------------------------------------------------------------

export interface FollowUpDraft {
  title: string;
  description: string;
  assigneeUserId: string | null;
}

export function emptyFollowUpDraft(): FollowUpDraft {
  return { title: "", description: "", assigneeUserId: null };
}

/**
 * NO RECORD LINKS, deliberately: `meetingTaskCreateInputSchema` omits all four
 * because the task INHERITS the meeting's, and zod's non-strict parse would
 * drop any this form sent -- so a form offering them would look like it worked
 * and quietly do something else.
 *
 * NO `parentTaskId` either, though the wire does accept one: it answers 409
 * `conflict` when the parent lives in another project or is itself a subtask
 * (Phase 3's one-level rule), and an affordance that can fail that way owes
 * the user an explanation of a rule this tab is not the place to teach. The
 * task drawer, which is where subtasks are grouped, is one click away.
 *
 * Dates are absent for a related reason: they are valid only in pairs
 * (tasks_dates_paired), and a follow-up captured in a meeting is an action
 * item, not a schedule. The drawer sets them.
 */
export function buildFollowUpInput(draft: FollowUpDraft): BuildResult<MeetingTaskCreateInput> {
  const title = draft.title.trim();
  if (title === "") return { ok: false, error: "A follow-up task needs a title." };
  const description = draft.description.trim();
  return {
    ok: true,
    input: {
      title,
      // `.min(1).nullable()` again: blank is null, never "".
      description: description === "" ? null : description,
      assigneeUserId: draft.assigneeUserId,
    },
  };
}

// ---------------------------------------------------------------------------
// The archived-project dead end
// ---------------------------------------------------------------------------

export const MEETING_ARCHIVED_REASON =
  "This meeting is archived. Unarchive it to add follow-up tasks.";

/**
 * THE REASON THIS GATE EXISTS. A follow-up task inherits the meeting's four
 * record links, and createTask refuses a task into an ARCHIVED project
 * (assertProjectActive, api: services/tasks.ts) -- while the wire shape omits
 * the links, so no client can send `projectId: null` to opt out. A meeting
 * linked to an archived project therefore has no reachable follow-up path at
 * all, and the 409 it answers with names the PROJECT while carrying the same
 * `archived` code as an archived MEETING: indistinguishable to a client, and
 * unexplainable on screen. Better to say so before the click.
 */
export const PROJECT_ARCHIVED_REASON =
  "This meeting's project is archived, so it cannot take new tasks. Unarchive the project first.";

/** Shown while the meeting's project is still being fetched. Blocking rather
 * than allowing is deliberate: the only two outcomes are "briefly disabled"
 * and "a 409 nothing on screen explains", and the first is the smaller harm.
 * A project link is a real FK to a row nothing ever deletes, so this state
 * resolves on the next successful fetch. */
export const PROJECT_UNKNOWN_REASON = "Checking this meeting's project...";

/**
 * Why "Add task" is unavailable, or null when it is available.
 *
 * `project` is whatever `useProject(meeting.projectId ?? "")` currently holds
 * -- `GET /api/projects/:id` returns archived projects, and the hook keys on
 * ["project", id], so a rail showing several meetings in one project pays for
 * one fetch, not one per meeting.
 */
export function addTaskBlockedReason(input: {
  meetingArchived: boolean;
  projectId: string | null;
  project: { archivedAt: string | null } | undefined;
}): string | null {
  if (input.meetingArchived) return MEETING_ARCHIVED_REASON;
  if (input.projectId === null) return null;
  if (input.project === undefined) return PROJECT_UNKNOWN_REASON;
  return input.project.archivedAt === null ? null : PROJECT_ARCHIVED_REASON;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Branches on ApiError.code -- the server's machine-readable `error` field --
 * never on message text, which carries interpolated ids and is for display
 * only (see src/api.ts). The codes these two functions branch on exist
 * BECAUSE they are meant to be branched on: DuplicateAttendeeError was given
 * its own code purely so a client could tell "fix this one row of the attendee
 * list" from "refetch and retry" (api: services/errors.ts).
 */
export function meetingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "duplicate_attendee":
        return "That person is already an attendee of this meeting.";
      case "archived":
        return "This meeting is archived. Unarchive it to make changes.";
      case "not_found":
        return "This meeting no longer exists. Refresh to see the current list.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The follow-up task's own mapping. `archived` is the interesting one: the
 * same code answers for an archived MEETING and for the archived PROJECT the
 * task would have inherited, with nothing in the response to tell them apart
 * -- so the message names both. addTaskBlockedReason above is what makes this
 * a rare race rather than the normal way to discover either.
 */
export function followUpErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "archived":
        return "This meeting, or the project it belongs to, has been archived. Refresh to see its current state.";
      case "not_found":
        return "This meeting no longer exists. Refresh to see the current list.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
