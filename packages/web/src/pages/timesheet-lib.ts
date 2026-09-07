import {
  MAX_TIME_ENTRY_MINUTES, isoWeekRange, timeEntryAtLeastOneLink, todayInZone,
} from "@conduit/shared";
import type {
  TimeEntryCreateInput, TimeEntryUpdateInput, TimerStartInput, TimesheetRow,
} from "@conduit/shared";
import { ApiError } from "../api";

/**
 * The timesheet page's pure half (Phase 10 Task 4).
 *
 * **WHAT IS HERE IS WHAT DECIDES**, which is settings-data-lib.ts's and
 * inbox-lib.ts's split and their reason: this package's vitest environment is
 * `node` and the repo has no testing-library, so anything left in the .tsx is
 * only ever exercised by Playwright. The week the page is looking at, what a
 * half-filled form may be submitted as, and what a failure means in words are
 * all decisions, and all of them are here.
 *
 * **WHAT IS DELIBERATELY NOT HERE: THE FIGURES.** No total is computed in this
 * file or in the page. `timesheetSummary` and `timesheetBillableSummary`
 * (@conduit/shared) are the sentences the page renders, and `timesheetDays`
 * (api: services/timesheet.ts) is where every minute is added up -- in SQL, over
 * the whole range rather than over a page of it. A helper here that summed a
 * day's rows would be the JavaScript sum the plan spends a paragraph forbidding,
 * one file further from the query. `timesheet-render.test.ts` reads the page off
 * disk and fails if either of those sentences is spelled out instead of derived.
 */

/* -------------------------------------------------------------------------- *
 *  Which week the page is looking at
 * -------------------------------------------------------------------------- */

/**
 * The week the page opens on, and the week each tap of Previous/Next moves to.
 *
 * **THE ORGANISATION'S TODAY, NOT THE BROWSER'S.** `todayLocalIso` (lib.ts) reads
 * the device clock, which is right for "is this task overdue" on My Tasks and
 * wrong here: the report's own days are `org_profile.time_zone`'s (api:
 * services/timesheet.ts), so a phone in another zone would ask for a week that is
 * not the week the answer is about. The zone comes from the org profile the page
 * already has to load.
 *
 * The arithmetic itself is `isoWeekRange`'s, shared with the service tests, so
 * "this week" is one definition rather than two that agree today.
 */
export function weekAt(timeZone: string, offset: number, now: Date = new Date()): { from: string; to: string } {
  return isoWeekRange(todayInZone(timeZone, now), offset);
}

/**
 * How the range reads above the list: "7 – 13 September 2026".
 *
 * **THE MONTH AND THE YEAR ARE NOT DROPPED WHEN THEY MATCH**, because a week
 * spanning a month end ("28 September – 4 October 2026") is exactly when a reader
 * needs both, and a label that changed shape between weeks would be harder to
 * scan than one that does not. en-GB, like every other date this app prints.
 */
export function weekLabel(from: string, to: string): string {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const opts = { timeZone: "UTC", day: "numeric", month: "long" } as const;
  const startText = start.toLocaleDateString("en-GB", opts);
  const endText = end.toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  // A ONE-DAY RANGE IS NOT "1 - 1 January", which is what the general form
  // produces and which reads as a fault rather than as a day. Unreachable from
  // the page -- `isoWeekRange` always answers seven days -- and handled anyway,
  // because a helper that is wrong on an input its caller happens not to send is
  // a trap for the caller that eventually does.
  if (from === to) return endText;
  // Only the leading MONTH is dropped when the two days share one, because
  // "7 September - 13 September 2026" says it twice. The year is never dropped:
  // an operator four taps into last year needs it on the screen.
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${sameMonth ? String(start.getUTCDate()) : startText} – ${endText}`;
}

/** A day's own heading: "Monday 7 September". No year -- the range above the
 * list carries it, and repeating it on seven headings is noise on a phone. */
export function dayHeading(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
  });
}

/**
 * Whether a day is the organisation's today -- what the page marks so the eye
 * lands on the right row without reading seven headings.
 *
 * Compared as STRINGS, never as Dates: `new Date("2026-09-07")` is UTC midnight,
 * and any local formatting of it can move it a day, which is the class of bug
 * `work_date` is a `date` to avoid.
 */
export function isToday(day: string, timeZone: string, now: Date = new Date()): boolean {
  return day === todayInZone(timeZone, now);
}

/* -------------------------------------------------------------------------- *
 *  The rows
 * -------------------------------------------------------------------------- */

/**
 * What a row says about itself when it has no words of its own.
 *
 * An entry's description is nullable -- "" is stored as null
 * (`normaliseDescription`) -- so a blank one has to render as something. It reads
 * as the record it was booked to, because that is the only true thing left to
 * say about it, and as a last resort the em-dash placeholder this app uses
 * everywhere for "nothing to show".
 */
export function rowLabel(row: TimesheetRow): string {
  if (row.label !== null && row.label !== "") return row.label;
  const first = row.links[0];
  return first === undefined ? "—" : first.label;
}

/**
 * What the page prints in a row's minutes column when there are none.
 *
 * **A MEETING NOBODY TIMED MUST NOT READ AS "0m".** The spec's own words: "a
 * report that silently treats unknown length as zero is the same failure in a
 * smaller costume". `durationLabel` (rail/meetings-lib.ts) keeps its null branch
 * for the same reason at a different surface; this is that decision on the
 * timesheet, and the words are the ones `timesheetSummary` uses so the sentence
 * above the list and the row below it name the same thing.
 */
export function uncountedLabel(row: TimesheetRow): string | null {
  switch (row.uncountedReason) {
    case "no-recorded-length": return "no recorded length";
    case "not-yet-happened": return "has not happened yet";
    default: return null;
  }
}

/* -------------------------------------------------------------------------- *
 *  Logging an hour by hand
 * -------------------------------------------------------------------------- */

/** The five records an hour may be booked to. Not `EntityPickerKind`, which is
 * `MailLinkKind` and has four: a time entry's fifth link is a TASK. */
export type TimeEntryLinkKind = "company" | "contact" | "deal" | "project" | "task";

export interface TimeEntryLink {
  kind: TimeEntryLinkKind;
  id: string;
  label: string;
}

/** The word for each kind, including the fifth `KIND_LABEL` (entity-picker.tsx)
 * has never had to carry. */
export const LINK_LABEL: Record<TimeEntryLinkKind, string> = {
  company: "Company", contact: "Contact", deal: "Deal", project: "Project", task: "Task",
};

/** Column order, so a set of chips reads the same way twice. */
export const LINK_KINDS: readonly TimeEntryLinkKind[] =
  ["company", "contact", "deal", "project", "task"];

/**
 * The four a TIMESHEET can be narrowed by, which is not the five an hour can be
 * booked to.
 *
 * `meetings` has no `task_id`, so a task-filtered report would answer "0m across
 * 0 meetings" for a structural reason no clause on the page could explain, and
 * `GET /api/tasks/:id/effort` already answers that question against the task's
 * estimate. The argument is written out at `timesheetFiltersSchema`
 * (@conduit/shared); this array is what stops the page offering the fifth.
 */
export const FILTER_KINDS = ["company", "contact", "deal", "project"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/**
 * A record the timesheet has been narrowed to.
 *
 * **A NARROWER TYPE THAN `TimeEntryLink`, SO THE COMPILER HOLDS THE RULE.** With
 * the five-kind type here, `{ [`${filter.kind}Id`]: filter.id }` widens to a
 * plain `string` key and a task filter would compile, travel, and be dropped in
 * silence by the route's zod parse -- an absence with nothing anywhere saying
 * why. Four kinds means a task filter does not typecheck at all.
 */
export interface TimesheetFilterLink {
  kind: FilterKind;
  id: string;
  label: string;
}

/**
 * Add a link to a draft, replacing any of the same kind it already had.
 *
 * **AT MOST ONE PER KIND, BECAUSE THE COLUMN HOLDS ONE.** `time_entries` has five
 * nullable record columns, not a join table, so picking a second project can only
 * mean changing the project. Replacing rather than appending is what stops the
 * form holding a state the row cannot.
 */
export function addLink(links: readonly TimeEntryLink[], link: TimeEntryLink): TimeEntryLink[] {
  const next = [...links.filter((existing) => existing.kind !== link.kind), link];
  return LINK_KINDS.flatMap((kind) => next.filter((l) => l.kind === kind));
}

export function removeLink(
  links: readonly TimeEntryLink[], kind: TimeEntryLinkKind,
): TimeEntryLink[] {
  return links.filter((link) => link.kind !== kind);
}

/**
 * The form's own state, as strings, because that is what inputs hold.
 *
 * **`billable` IS `null` UNTIL SOMEBODY ANSWERS IT, AND THAT IS THE WHOLE POINT.**
 * The column has no DEFAULT and the wire schema requires the field, both
 * deliberately (Task 1): a boolean whose two values are equally ordinary has no
 * default that is not a guess, and the guess that reads worst -- non-billable --
 * under-reports chargeable time in a product with no invoicing step to contradict
 * it. A pre-ticked checkbox in this form would put that guess back, one layer
 * further out, where the database's refusal cannot reach it. So the draft carries
 * a third state and `buildTimeEntryInput` refuses it.
 */
export interface TimeEntryDraft {
  workDate: string;
  minutes: string;
  description: string;
  billable: boolean | null;
  /**
   * **A LIST, NOT ONE LINK, AND THE SPEC'S CENTRAL EXAMPLE IS WHY.** The
   * at-least-one rule is not exactly-one precisely because "an hour can
   * legitimately belong to a project AND the deal it came from" -- so a form
   * holding one link would silently CLEAR the others every time such an entry
   * was edited, since `buildTimeEntryPatch` sends all five columns. That is data
   * loss with nothing on screen to show for it.
   */
  links: TimeEntryLink[];
}

export function emptyTimeEntryDraft(workDate: string): TimeEntryDraft {
  return { workDate, minutes: "", description: "", billable: null, links: [] };
}

/**
 * The draft that edits an existing entry, built from the ROW the page already
 * holds rather than from a second fetch of the entry.
 *
 * The row carries every field the form needs -- the day, the minutes, the
 * description, the flag and every record it names, already resolved to labels --
 * because `timesheetDays` selects them for the list itself. A
 * `GET /api/time-entries/:id` here would be a round trip for data on the screen.
 */
export function draftFromRow(row: TimesheetRow): TimeEntryDraft {
  return {
    workDate: row.day,
    minutes: row.minutes === null ? "" : String(row.minutes),
    description: row.label ?? "",
    billable: row.billable,
    links: row.links.map((link) => ({ kind: link.kind, id: link.id, label: link.label })),
  };
}

export type BuildResult<T> = { ok: true; input: T } | { ok: false; error: string };

/**
 * The five link columns: an id for each kind the draft carries, and NULL for each
 * kind it does not.
 *
 * **THE NULLS ARE THE LOAD-BEARING HALF.** On a create they are the columns the
 * row will not have; on a PATCH they are what CLEARS a link the operator removed,
 * because `timeEntryUpdateInputSchema` treats an ABSENT field as "leave it
 * alone". So a patch built from a draft that dropped its project has to say
 * `projectId: null` out loud, or the link stays and the entry goes on appearing
 * in a report the operator has just taken it out of. Written once so the create
 * and the patch cannot disagree about it.
 */
export function linkFields(links: readonly TimeEntryLink[]): {
  companyId: string | null; contactId: string | null; dealId: string | null;
  projectId: string | null; taskId: string | null;
} {
  const idOf = (kind: TimeEntryLinkKind): string | null =>
    links.find((link) => link.kind === kind)?.id ?? null;
  return {
    companyId: idOf("company"), contactId: idOf("contact"), dealId: idOf("deal"),
    projectId: idOf("project"), taskId: idOf("task"),
  };
}

/**
 * What the form may be sent as -- and every refusal here is one the server would
 * have made anyway, in words the operator can act on.
 *
 * The bounds are the SHARED ones, never numbers typed into a page:
 * `MAX_TIME_ENTRY_MINUTES` is one day because `work_date` is one day, and a
 * literal here would go on accepting the old value the day it moved
 * (`task-effort-render.test.ts`'s rule at a bigger form).
 */
export function buildTimeEntryInput(draft: TimeEntryDraft): BuildResult<TimeEntryCreateInput> {
  const workDate = draft.workDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return { ok: false, error: "Pick the day this work was done." };
  }

  const minutes = Number(draft.minutes.trim());
  if (draft.minutes.trim() === "" || !Number.isInteger(minutes) || minutes <= 0) {
    return { ok: false, error: "How many minutes? A whole number above nought." };
  }
  if (minutes > MAX_TIME_ENTRY_MINUTES) {
    return {
      ok: false,
      // Named in hours as well, because 1440 read on its own looks like a typo
      // rather than a bound -- and this is the message a mistyped 900 meets.
      error: `One entry cannot be longer than a day (${String(MAX_TIME_ENTRY_MINUTES)} minutes).`,
    };
  }

  // BILLABLE OR NOT IS ASKED, NOT ASSUMED. See TimeEntryDraft.
  if (draft.billable === null) {
    return { ok: false, error: "Say whether this time is billable." };
  }

  const links = linkFields(draft.links);
  if (!timeEntryAtLeastOneLink(links)) {
    return {
      ok: false,
      error: "Book this time to a company, contact, deal, project or task -- "
        + "time attached to nothing appears in no report.",
    };
  }

  return {
    ok: true,
    input: {
      workDate,
      minutes,
      // Blank -> null, never "": `nullableString` is `.min(1).nullable()`, and
      // the service trims to null anyway. Doing it here means the request the
      // page sends is the one the row will hold.
      description: draft.description.trim() === "" ? null : draft.description.trim(),
      billable: draft.billable,
      ...links,
    },
  };
}

/**
 * The same draft as a PATCH.
 *
 * **EVERY FIELD IS SENT, INCLUDING THE LINKS IT IS CLEARING**, which is the
 * difference from a create rather than an oversight. `timeEntryUpdateInputSchema`
 * carries no at-least-one refine (a patch sees one snapshot), so moving an entry
 * from a project to a task means sending `projectId: null` alongside
 * `taskId: <id>` in ONE patch -- the service merges and re-asserts, and a patch
 * that cleared the last link on its own would be a 409 telling the operator to
 * set another link in the same patch. Sending the whole form is what makes that
 * impossible to get wrong from here.
 */
export function buildTimeEntryPatch(draft: TimeEntryDraft): BuildResult<TimeEntryUpdateInput> {
  const built = buildTimeEntryInput(draft);
  return built.ok ? { ok: true, input: built.input } : built;
}

/* -------------------------------------------------------------------------- *
 *  Starting the clock (Phase 10 Task 5)
 * -------------------------------------------------------------------------- */

/**
 * The start form's own state: where the hours will go, and optionally what the
 * work is.
 *
 * **NO DAY, NO MINUTES AND NO BILLABLE FLAG**, and every one of those absences
 * is somebody else's answer rather than a simplification. The duration is what
 * the clock is for; the day comes off `started_at` on the server, in the
 * organisation's calendar; and the flag is asked when the work is DONE, because
 * that is when an operator knows whether it was chargeable -- a timer that
 * decided it at the start would be guessing on the row where the guess is
 * hardest to notice, which is what `time_entries.billable` has no DEFAULT to
 * prevent.
 *
 * The links are a LIST for `TimeEntryDraft.links`' reason exactly: at-least-one
 * is not exactly-one because an hour can belong to a project AND the deal it
 * came from, and the clock has to be able to start against both.
 */
export interface TimerStartDraft {
  description: string;
  links: TimeEntryLink[];
}

export function emptyTimerStartDraft(): TimerStartDraft {
  return { description: "", links: [] };
}

/**
 * **THE AT-LEAST-ONE RULE, REFUSED HERE BECAUSE OF WHEN IT WOULD OTHERWISE BE
 * REFUSED.** A timer with no link could not become an entry, and the server says
 * so too (`timers_has_link`, and `startTimer`'s own re-assertion) -- but a
 * refusal that arrives at STOP lands on somebody recovering from a forgotten
 * weekend, holding hours with nothing to attach them to. Here it costs one tap,
 * with the picker still on the screen.
 *
 * The message is `buildTimeEntryInput`'s, one form over, because it is the same
 * rule and an operator meeting it twice should not have to work out that it is.
 */
export function buildTimerStartInput(draft: TimerStartDraft): BuildResult<TimerStartInput> {
  const links = linkFields(draft.links);
  if (!timeEntryAtLeastOneLink(links)) {
    return {
      ok: false,
      error: "Start this timer against a company, contact, deal, project or task -- "
        + "time attached to nothing appears in no report.",
    };
  }
  return {
    ok: true,
    input: {
      description: draft.description.trim() === "" ? null : draft.description.trim(),
      ...links,
    },
  };
}

/**
 * What went wrong, in words about a timesheet rather than about a table.
 *
 * `conflict` is the interesting one and it is the only refusal here an operator
 * has to ACT on rather than retry: a patch that would leave an entry linked to
 * nothing. The page cannot produce it today -- the form always sends a link --
 * but the API can answer it to a stale tab, and the server's own sentence names
 * columns rather than the form's Booked to field.
 */
export function timeEntryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "conflict":
        return "An entry has to stay booked to something. Choose a record, or archive the entry instead.";
      case "archived":
        return "This entry is archived. Unarchive it to make changes.";
      case "not_found":
        return "This entry, or the record it names, could not be found. Refresh to see the current state.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
