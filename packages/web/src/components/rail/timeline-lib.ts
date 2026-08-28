import type { Event } from "@conduit/shared";
import { formatMoneyCents } from "@conduit/shared";
import { subjectLabel } from "../mail/mail-lib";

/**
 * The timeline's pure parts: the badge letter for a verb, the one-line human
 * summary of an event, and where (if anywhere) an entry links to.
 *
 * Split out of timeline.tsx in Phase 5 for the reason mail-lib.ts exists --
 * this project wires no testing-library, so a rendering component's logic is
 * only reachable by a unit test once it is a pure module. Nothing here touches
 * React, the network or the DOM; timeline.tsx is the rendering half.
 */

// Single-letter badges rather than pictographic icons: ASCII, one distinct
// letter per verb, and there is no icon library in this project (see the task
// spec). Distinctness is the whole point -- two verbs sharing a letter make a
// record's timeline unreadable -- so a new verb takes a free letter, or takes
// a used one only when a coordinator ruling moves the incumbent (Phase 5
// Amendment 1 did exactly that; see `met` below).
export const VERB_BADGE: Record<Event["verb"], string> = {
  created: "C",
  updated: "U",
  archived: "A",
  unarchived: "R",
  note_added: "N",
  file_attached: "F",
  stage_changed: "S",
  won: "W",
  lost: "L",
  reopened: "O",
  // Task 8's real task-event badges (Phase 3 Task 2 widened eventVerbSchema
  // with these four; P2.1 only stubbed the map exhaustively typed against
  // it -- see search.ts's own tasks: [] stub for that same stub-now/
  // wire-later precedent). Letters chosen to stay distinct from every badge
  // above: H (sHifted), D (completeD), P (dePendency added). The fourth was
  // M (reMoved) until Phase 5 Amendment 1 moved it to X so `met` could have
  // M: a dependency removal is among the rarest entries a timeline carries
  // and a meeting among the most common, so the mnemonic letter belongs to
  // the meeting -- and X reads as "removed" at least as well as M did.
  shifted: "H",
  completed: "D",
  dependency_added: "P",
  dependency_removed: "X",
  // Phase 5's three verbs, at the letters spec Amendment 1 settles. The
  // spec's first draft collided twice (met = M against dependency_removed,
  // mail_received = R against unarchived); the ruling gave the intuitive
  // letter to whichever verb a user sees more often, which moved
  // dependency_removed to X above and put mail_received on I (Inbound) so
  // unarchived keeps R untouched.
  met: "M",
  mail_received: "I",
  mail_sent: "T",
};

/**
 * Where an entry can take the reader, when it can take them anywhere.
 *
 * A THREAD link is an ordinary route (`/mail?thread=<id>`); a MEETING link is
 * not, because v0.9.0 ships no meetings route -- a meeting is only reachable
 * inside its record's Meetings tab, so the rail (which owns both tabs) is the
 * only thing that can honour one. timeline.tsx therefore renders a meeting
 * link only when its caller passed a handler; in the task drawer, which has no
 * Meetings tab beside it, the same entry renders as plain text.
 */
export type EventLink =
  | { kind: "thread"; threadId: string }
  | { kind: "meeting"; meetingId: string };

export function eventLink(event: Event): EventLink | null {
  // Both pointers on one row is legal at schema level and nothing in Phase 5
  // writes such a row (api: db/schema.test.ts pins that as column shape, not
  // as a use case), so the order here is arbitrary rather than a precedence
  // rule -- it exists only so this function is total.
  if (event.mailThreadId !== null) return { kind: "thread", threadId: event.mailThreadId };
  if (event.meetingId !== null) return { kind: "meeting", meetingId: event.meetingId };
  return null;
}

/**
 * Turns an event's untyped `payload` (z.record(string, unknown) -- see
 * shared's eventSchema) into the one-line human summary the spec calls for.
 * Each case narrows defensively: the payload shape is a server-side
 * convention, not something Zod verifies field-by-field here, so a missing or
 * mistyped key degrades to an empty/verb-only string instead of throwing.
 */
export function summarize(event: Event): string {
  switch (event.verb) {
    // A task's creation entry names nothing -- not even the task -- for every
    // task in the app, which is why the follow-up arm below adds wording
    // rather than a title: the row's payload is deliberately `{}` (spec
    // Amendment 2), the meeting rides the events.meeting_id COLUMN, and
    // createTask's `origin` parameter (api: services/tasks.ts) is that
    // column's only writer on a `created` row. The meeting's own `met` entry,
    // which IS on these same timelines, is the one that names it.
    case "created":
      return event.meetingId !== null ? "created a follow-up task from a meeting" : "created";
    case "updated": {
      const changed = event.payload.changed;
      return `updated ${Array.isArray(changed) ? changed.join(", ") : ""}`;
    }
    // Only a MEETING's archive/unarchive carries a payload title: every other
    // record type stamps `{}` on these two verbs (api: companies.ts,
    // contacts.ts, deals.ts, projects.ts, tasks.ts) because its entry sits on
    // its own record's timeline, where the subject is never in doubt. A
    // meeting's lands on a record that may hold dozens, so meetings.ts stamps
    // the title for exactly this render -- and meetingId is what tells the two
    // cases apart.
    case "archived":
    case "unarchived": {
      const verb = event.verb === "archived" ? "archived" : "unarchived";
      if (event.meetingId === null) return verb;
      const title = event.payload.title;
      return typeof title === "string" && title !== "" ? `${verb} the meeting ${quoted(title)}` : `${verb} a meeting`;
    }
    case "note_added": {
      const preview = event.payload.preview;
      return `"${typeof preview === "string" ? preview : ""}"`;
    }
    case "file_attached": {
      const name = event.payload.originalName;
      return typeof name === "string" ? name : "";
    }
    // Payload shape written by moveDeal in services/deals.ts: { from, to,
    // fromName, toName }. fromName/toName are used (not from/to, which are
    // stage ids) so this never needs a second round trip to resolve a name.
    case "stage_changed": {
      const fromName = event.payload.fromName;
      const toName = event.payload.toName;
      if (typeof fromName === "string" && typeof toName === "string") {
        return `moved from ${fromName} to ${toName}`;
      }
      if (typeof toName === "string") return `moved to ${toName}`;
      return "moved stage";
    }
    // Payload shape written by setStatus's target === "won" branch:
    // { valueCents, currency }. Falls back to a bare "won" when either is
    // missing (e.g. an unpriced deal has valueCents: null).
    case "won": {
      const valueCents = event.payload.valueCents;
      const currency = event.payload.currency;
      if (typeof valueCents === "number" && typeof currency === "string") {
        const formatted = formatMoneyCents(valueCents, currency);
        return `won ${formatted}`;
      }
      return "won";
    }
    // Payload shape written by setStatus's target === "lost" branch: { reason }.
    case "lost": {
      const reason = event.payload.reason;
      return typeof reason === "string" && reason !== "" ? `lost: ${reason}` : "lost";
    }
    case "reopened":
      return "reopened";
    // Payload shape written by scheduling.ts's shiftTask: { from: {start,
    // due}, to: {start, due}, cascadedFrom }. cascadedFrom is the DRAGGED
    // task's id for every event other than the dragged task's own (which
    // carries null) -- rendered generically as "(cascaded)" rather than
    // resolving that id to a title, mirroring dependency_added/_removed
    // below. `compacted: true` (Phase 3.1's compactSchedule, scheduling.ts)
    // is a THIRD, independent marker on the same verb -- a compaction event's
    // own cascadedFrom is always null (compactSchedule has no "one dragged
    // task" to trace back to), so this appends alongside "(cascaded)" rather
    // than replacing it, even though in practice the two never co-occur.
    case "shifted": {
      const fromRange = formatDateRange(event.payload.from);
      const toRange = formatDateRange(event.payload.to);
      if (fromRange === null || toRange === null) return "shifted";
      const cascaded = typeof event.payload.cascadedFrom === "string";
      const compacted = event.payload.compacted === true;
      return `shifted ${fromRange} ${"\u2192"} ${toRange}${cascaded ? " (cascaded)" : ""}${compacted ? " (compacted)" : ""}`;
    }
    case "completed":
      return "completed";
    // Payload for both: { predecessorId }, written by addDependency/
    // removeDependency in services/tasks.ts. predecessorId is a raw uuid --
    // rendered generically (no lookup of the predecessor's title), since a
    // timeline event has no project/task context handy to fetch it with.
    case "dependency_added":
      return "added a dependency";
    case "dependency_removed":
      return "removed a dependency";
    // Payload shape written by meetings.ts's meetingEventValues: { title }, a
    // SNAPSHOT of the title as it stood when the meeting was logged. A later
    // rename leaves this entry reading the old one, which is correct for an
    // append-only history and is why the entry also links to the meeting: the
    // text says what was true then, the link leads to what is true now.
    case "met": {
      const title = event.payload.title;
      return typeof title === "string" && title !== "" ? `logged the meeting ${quoted(title)}` : "logged a meeting";
    }
    // The subject is DERIVED at read time from the joined thread and reaches
    // this client on the event itself (api: services/timeline.ts) -- never
    // stored, never rendered for a thread the viewer may not see, because such
    // a row does not reach the client at all. It can legitimately be the EMPTY
    // STRING (a message that arrived with no Subject header normalises to ''
    // and mail_threads.subject is NOT NULL), which is what subjectLabel is
    // for; null is the non-mail case and cannot occur on these two verbs.
    case "mail_received":
      return `received mail ${quoted(subjectLabel(event.mailSubject ?? ""))}`;
    case "mail_sent":
      return `sent mail ${quoted(subjectLabel(event.mailSubject ?? ""))}`;
    default:
      return event.verb;
  }
}

/** Curly-free quoting, so this module stays ASCII like every other source
 * here and the quotes match note_added's existing rendering. */
function quoted(value: string): string {
  return `"${value}"`;
}

/** Narrows a shifted event's `from`/`to` payload half ({start, due}, both
 * date strings) into "start\u2013due", or null when the shape doesn't match
 * -- see summarize()'s "shifted" case. */
function formatDateRange(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const { start, due } = part as Record<string, unknown>;
  if (typeof start !== "string" || typeof due !== "string") return null;
  return `${start}\u2013${due}`;
}
