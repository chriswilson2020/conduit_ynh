import { useState } from "react";
import {
  formatMinutes, timesheetBillableSummary, timesheetSummary,
} from "@conduit/shared";
import type { TimesheetDay, TimesheetFilters, TimesheetRow } from "@conduit/shared";
import {
  useArchiveTimeEntry, useCreateTimeEntry, useOrgProfile, useRunningTimer, useStartTimer,
  useTimesheet, useTimesheetDays, useUpdateTimeEntry,
} from "../queries";
import { timerErrorMessage } from "../components/timer-lib";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { EntityPicker } from "../components/entity-picker";
import { Input } from "../components/ui/input";
import { CHIP_REMOVE_TOUCH } from "../components/ui/touch";
import {
  addLink, buildTimeEntryInput, buildTimeEntryPatch, buildTimerStartInput, dayHeading, draftFromRow,
  emptyTimeEntryDraft, emptyTimerStartDraft, isToday, removeLink, rowLabel, timeEntryErrorMessage,
  uncountedLabel, weekAt, weekLabel, FILTER_KINDS, LINK_KINDS, LINK_LABEL,
  type FilterKind, type TimeEntryDraft, type TimeEntryLink, type TimeEntryLinkKind,
  type TimerStartDraft, type TimesheetFilterLink,
} from "./timesheet-lib";

/**
 * **THE TIMESHEET: WHERE DID THE WEEK GO (Phase 10 Task 4).**
 *
 * **A LIST, NOT A WEEKLY GRID**, which is the spec's decision and its reason: the
 * grid (days across, projects down) is the classic and is the hardest thing in
 * this product to operate on a phone, which is where Chris is. A list is easier
 * and less useful, and "less useful" is recoverable while a grid nobody can
 * operate on a phone is not. No approval workflow -- single user.
 *
 * ---
 *
 * **THIS PAGE COMPUTES NO FIGURE, AND THAT IS THE TASK'S FIRST RULE.**
 *
 * Every number here comes from `timesheetTotals` and `timesheetDays` (api:
 * services/timesheet.ts), summed in SQL over the whole range and COALESCEd. The
 * plan's warning is specific: `listTimeEntries` caps at 100 rows, so a JavaScript
 * sum over a page of entries is correct until somebody logs 101 in a week and is
 * then silently SHORT -- this phase's own failure mode arriving through the one
 * number the phase exists to produce. Even a DAY's figure is the service's; see
 * DaySection.
 *
 * **AND IT RENDERS `timesheetSummary`, NOT `countedMinutes`.** Task 2 put the
 * total, the split between entries and meetings, and the meetings that could NOT
 * be counted into one string precisely so a page cannot print the figure without
 * them: a count sitting beside a total in a payload is visible only to a UI that
 * chooses to render it, and this one must not choose. The headline field is
 * called `countedMinutes` rather than `totalMinutes` so a page printing it alone
 * reads as a lie in its own source. `timesheet-render.test.ts` reads this file
 * off disk and fails if it starts spelling any part of either sentence itself --
 * `settings-data-lib.test.ts`'s guard, which earned its place when reverting the
 * export's summary survived the entire suite.
 *
 * The uncounted meetings are ALSO rows in the list, because a sentence saying "2
 * meetings with no recorded length" that the operator cannot then look at is an
 * assertion rather than an answer.
 *
 * ---
 *
 * **WHAT IT LOOKS LIKE ON A PHONE, AND WHAT WAS REJECTED.**
 *
 * One column; a heading row; the week's controls; the two sentences; then seven
 * day sections, each a heading with the day's figure and a list of rows. Every
 * control is at the 44px floor and every row is `max-md:min-h-11`.
 *
 * REJECTED: a day-of-week strip (M T W T F S S) as the navigation. It is the
 * grid's top edge under another name, it wants seven targets across a 327px
 * content box -- 46px each, at the floor with nothing to spare -- and it answers
 * "which day", which scrolling already answers better.
 *
 * REJECTED: a five-way segmented control for the record filter. The record rail's
 * five tab labels MEASURE 349px inside a 342px box at 390px (e2e/mobile.spec.ts's
 * own figure), which is why that strip had to become its own scroll container. A
 * five-way control here would spill for the same reason, so the filter is four
 * ordinary buttons that wrap, and the chosen record becomes a chip.
 *
 * REJECTED: a Time tab on the record rail. Phase 9's Task 4 declined to add a
 * SIXTH tab there against that measurement and this would be a seventh. A
 * record's hours are reachable by narrowing this page instead, which costs no
 * width on any record page.
 *
 * REJECTED: a bottom-bar tab. `PRIMARY_NAV_IDS` is four by spec and the fifth
 * slot is More; the timesheet joins the More sheet and the desktop sidebar, which
 * is where Pipelines, Projects and the Gantt already are (components/nav-lib.ts).
 *
 * The form is a `DialogContent`, which is a full-screen sheet below the
 * breakpoint and a card at a desk, and which carries its own Close there -- so
 * the one dead end the responsive phase forbids cannot appear here.
 */
export function TimesheetPage() {
  const { data: profile } = useOrgProfile();
  // THE ORGANISATION'S CLOCK, because the report's own days are the
  // organisation's. Until the profile has loaded there is no honest week to ask
  // for, so nothing is fetched and no zone is guessed -- a phone in another zone
  // would otherwise ask for a week that is not the week the answer is about.
  const timeZone = profile?.timeZone ?? "";
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<TimesheetFilterLink | null>(null);
  const [editing, setEditing] = useState<TimesheetRow | "new" | null>(null);
  const [starting, setStarting] = useState(false);
  // WHETHER A CLOCK IS ALREADY RUNNING, so Start can say so rather than produce a
  // 409 the operator has to read. The running timer itself is rendered by the
  // shell's strip on every route (components/timer-strip.tsx), including this
  // one -- this page only decides whether its own button can do anything.
  const { data: timerState } = useRunningTimer();
  const timerRunning = timerState?.timer != null;

  const week = timeZone === "" ? { from: "", to: "" } : weekAt(timeZone, offset);
  const filters: TimesheetFilters = filter === null ? {} : { [`${filter.kind}Id`]: filter.id };
  const params = { ...week, ...filters };
  const totals = useTimesheet(params);
  const days = useTimesheetDays(params);

  return (
    <div data-testid="timesheet" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Timesheet</h1>
        {/*
          TWO CAPTURE PATHS, SIDE BY SIDE, which is the spec's second decision on
          one row: the clock and the hand entry are equals here rather than one
          being the primary control and the other a menu item.

          STARTING IS ON THIS PAGE AND STOPPING IS EVERYWHERE (the shell's
          strip), and the asymmetry is deliberate: a start needs a record picker,
          which needs width, and it is an act an operator performs while thinking
          about their work. Stopping is the half they forget, so it has to be
          reachable from whatever page they are on when they remember.

          DISABLED WHILE ONE IS RUNNING rather than allowed to 409: at most one
          timer runs per person (`timers_one_running_per_owner`), and a button
          that produced an error message every time would be teaching the
          operator to ignore error messages. The 409 handler stays for the race
          this cannot see -- a timer started on another device a moment ago.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            data-testid="start-timer"
            className="min-h-11"
            disabled={timerRunning}
            onClick={() => setStarting(true)}
          >
            {timerRunning ? "Timer running" : "Start timer"}
          </Button>
          <Button data-testid="log-time" className="min-h-11" onClick={() => setEditing("new")}>
            Log time
          </Button>
        </div>
      </div>

      <WeekControls from={week.from} to={week.to} offset={offset} onOffset={setOffset} />
      <FilterRow filter={filter} onFilter={setFilter} />

      {/*
        THE SENTENCES, RENDERED AND NOT COMPOSED. Two derived strings, and a line
        naming the clock the days were decided in -- formatDocumentInstant's rule:
        a report that fell back to UTC and did not say so is the failure that rule
        exists for, and this is the zone the ANSWER used rather than the stored
        string.
      */}
      <section
        data-testid="timesheet-summary"
        className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-900"
      >
        {totals.isPending && <p className="text-slate-400">Adding up the week...</p>}
        {totals.isError && (
          <p role="alert" className="text-red-700">{timeEntryErrorMessage(totals.error)}</p>
        )}
        {totals.data !== undefined && (
          <>
            <p data-testid="counted-summary">{timesheetSummary(totals.data)}</p>
            <p data-testid="billable-summary" className="mt-2 text-slate-600">
              {timesheetBillableSummary(totals.data)}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              Days are {totals.data.timeZone}
              {"’"}s.
            </p>
          </>
        )}
      </section>

      {days.isError && (
        <p role="alert" className="text-sm text-red-700">{timeEntryErrorMessage(days.error)}</p>
      )}
      {days.data !== undefined && days.data.days.map((day) => (
        <DaySection
          key={day.day}
          day={day}
          today={isToday(day.day, days.data.timeZone)}
          onEdit={setEditing}
        />
      ))}

      {editing !== null && (
        <TimeEntryDialog
          row={editing === "new" ? null : editing}
          defaultDay={week.from}
          onClose={() => setEditing(null)}
        />
      )}

      {starting && <TimerStartDialog onClose={() => setStarting(false)} />}
    </div>
  );
}

/**
 * **STARTING THE CLOCK: WHERE THE HOURS WILL GO, AND NOTHING ELSE.**
 *
 * Three fields the hand-entry form has are absent here, and each absence is
 * somebody else's answer rather than a shorter form:
 *
 *   NO DAY. It comes off `started_at`, read in the organisation's calendar, and
 *   the stop dialog states it before anything is committed.
 *
 *   NO MINUTES. That is what the clock is for.
 *
 *   NO BILLABLE FLAG, and this one is the interesting one: it is asked at STOP,
 *   because that is when an operator knows whether the work was chargeable.
 *   Asking it here would be asking them to guess, and a guess made at the start
 *   of two hours is the kind nobody revisits.
 *
 * **THE LINKS ARE REQUIRED AND THE REFUSAL IS THE POINT OF ASKING NOW.** A timer
 * attached to nothing could never become an entry (`time_entries_has_link`), and
 * meeting that refusal at stop would mean meeting it while holding hours with
 * nowhere to put them -- which is exactly the situation the recovery interaction
 * already exists to make survivable. Refused here it costs one tap.
 */
function TimerStartDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<TimerStartDraft>(emptyTimerStartDraft);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<TimeEntryLinkKind | null>(null);
  const start = useStartTimer();

  function submit() {
    setError(null);
    const built = buildTimerStartInput(draft);
    if (!built.ok) return setError(built.error);
    start.mutate(built.input, {
      onSuccess: () => onClose(),
      onError: (err) => setError(timerErrorMessage(err, "start")),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="timer-start-dialog">
        <DialogTitle className="text-lg font-semibold text-slate-900">Start a timer</DialogTitle>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            What are you working on?
            <Input
              autoFocus
              data-testid="timer-start-description"
              placeholder="Optional, and what the strip will say while it runs"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <TimeEntryLinkPicker
            links={draft.links}
            picking={picking}
            onPicking={setPicking}
            onLinks={(links) => setDraft({ ...draft, links })}
            testIdPrefix="timer-start-link"
          />

          {error !== null && (
            <p role="alert" data-testid="timer-start-error" className="text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" data-testid="timer-start-cancel" className="min-h-11" onClick={onClose}>
              Cancel
            </Button>
            <Button
              data-testid="timer-start-save"
              className="min-h-11"
              disabled={start.isPending}
              onClick={submit}
            >
              Start
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The five record links as chips and five pickers, shared by the two forms on
 * this page.
 *
 * **EXTRACTED WHEN THE SECOND CALLER ARRIVED, WHICH IS THE RULE THIS CODEBASE
 * APPLIES TO SERVICE HELPERS AND IS APPLIED HERE FOR A SHARPER REASON.** The two
 * forms must agree about what "booked to" means, because a timer's links become
 * an entry's links unchanged at stop -- a picker that let a timer hold a state an
 * entry could not would produce a stop that fails at the moment the operator can
 * least afford it. `addLink`'s at-most-one-per-kind rule is what keeps the form
 * from holding a state the ROW cannot, and there is now one copy of it in use.
 */
function TimeEntryLinkPicker({
  links, picking, onPicking, onLinks, testIdPrefix,
}: {
  links: TimeEntryLink[];
  picking: TimeEntryLinkKind | null;
  onPicking: (kind: TimeEntryLinkKind | null) => void;
  onLinks: (links: TimeEntryLink[]) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-slate-500">Booked to</span>
      <div className="flex flex-wrap items-center gap-1">
        {links.length === 0 && <span className="text-xs text-slate-400">Nothing yet</span>}
        {links.map((link) => (
          <span
            key={`${link.kind}-${link.id}`}
            data-testid={`${testIdPrefix}-chip`}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
          >
            {LINK_LABEL[link.kind]}: {link.label}
            <button
              type="button"
              aria-label={`Remove ${LINK_LABEL[link.kind]} ${link.label}`}
              className={`text-slate-400 hover:text-slate-900 ${CHIP_REMOVE_TOUCH}`}
              onClick={() => onLinks(removeLink(links, link.kind))}
            >
              {"×"}
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {LINK_KINDS.map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            data-testid={`${testIdPrefix}-${kind}`}
            className="min-h-11 px-3 text-xs"
            onClick={() => onPicking(picking === kind ? null : kind)}
          >
            {LINK_LABEL[kind]}
          </Button>
        ))}
      </div>
      {picking !== null && (
        <EntityPicker
          kind={picking}
          onPick={(id, label) => {
            onLinks(addLink(links, { kind: picking, id, label }));
            onPicking(null);
          }}
          onCancel={() => onPicking(null)}
        />
      )}
    </div>
  );
}

/**
 * Previous, the range, Next -- and This week only while it would do something.
 *
 * The two arrows are `min-h-11 min-w-11` at EVERY width, not `max-md:`: they are
 * the page's most-used controls on a phone and the glyph inside them is a few
 * pixels wide, so the target has to be the box rather than the character. Both
 * carry an aria-label, because an arrow announces as nothing.
 */
function WeekControls({
  from, to, offset, onOffset,
}: { from: string; to: string; offset: number; onOffset: (n: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        data-testid="week-previous"
        aria-label="Previous week"
        className="flex min-h-11 min-w-11 items-center justify-center px-3"
        onClick={() => onOffset(offset - 1)}
      >
        {"←"}
      </Button>
      <span data-testid="week-range" className="flex-1 text-center text-sm font-medium text-slate-900">
        {from === "" ? "—" : weekLabel(from, to)}
      </span>
      <Button
        variant="outline"
        data-testid="week-next"
        aria-label="Next week"
        className="flex min-h-11 min-w-11 items-center justify-center px-3"
        onClick={() => onOffset(offset + 1)}
      >
        {"→"}
      </Button>
      {offset !== 0 && (
        <Button
          variant="ghost"
          data-testid="week-today"
          className="min-h-11 px-3 text-sm"
          onClick={() => onOffset(0)}
        >
          This week
        </Button>
      )}
    </div>
  );
}

/**
 * The record filter: four buttons, then a chip and a way back to everything.
 *
 * A TASK CANNOT BE PICKED HERE and the picker is offered only the four kinds
 * that can narrow both halves of the report -- see FILTER_KINDS.
 */
function FilterRow({
  filter, onFilter,
}: { filter: TimesheetFilterLink | null; onFilter: (link: TimesheetFilterLink | null) => void }) {
  const [picking, setPicking] = useState<FilterKind | null>(null);

  if (filter !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span data-testid="timesheet-filter" className="rounded-full bg-slate-100 px-3 py-1">
          {LINK_LABEL[filter.kind]}: {filter.label}
        </span>
        <Button
          variant="ghost"
          data-testid="clear-filter"
          className="min-h-11 px-3 text-xs"
          onClick={() => onFilter(null)}
        >
          Show everything
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Narrow to</span>
        {FILTER_KINDS.map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            data-testid={`filter-${kind}`}
            className="min-h-11 px-3 text-xs"
            onClick={() => setPicking(picking === kind ? null : kind)}
          >
            {LINK_LABEL[kind]}
          </Button>
        ))}
      </div>
      {picking !== null && (
        <EntityPicker
          kind={picking}
          onPick={(id, label) => {
            setPicking(null);
            onFilter({ kind: picking, id, label });
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/**
 * One calendar day, with its own figure and its rows.
 *
 * **THE FIGURE COMES OFF THE PAYLOAD, NOT OUT OF THE ROWS.** `day.countedMinutes`
 * is summed by the service over rows it was not free to truncate, and
 * `timesheetWeekSchema` refuses a payload where a day's figure and its rows
 * disagree. A `rows.reduce` here would be the page adding up minutes, which is
 * the one thing this surface may not do -- and it would have to remember that an
 * uncounted meeting contributes nothing, which is exactly the sort of clause a
 * page drops.
 *
 * A day with rows but no counted minutes -- a Friday holding only meetings that
 * have not happened -- prints its rows and an em dash. That is the honest
 * reading.
 */
function DaySection({
  day, today, onEdit,
}: { day: TimesheetDay; today: boolean; onEdit: (row: TimesheetRow) => void }) {
  return (
    <section data-testid={`timesheet-day-${day.day}`}>
      <h2 className="mb-1 flex items-baseline justify-between gap-2 text-sm font-semibold text-slate-900">
        <span>
          {dayHeading(day.day)}
          {today && <span className="ml-2 text-xs font-normal text-slate-400">today</span>}
        </span>
        <span data-testid="day-total" className="text-xs font-normal text-slate-500">
          {day.countedMinutes === 0 ? "—" : formatMinutes(day.countedMinutes)}
        </span>
      </h2>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {day.rows.map((row) => <RowLine key={`${row.kind}-${row.id}`} row={row} onEdit={onEdit} />)}
        {day.rows.length === 0 && (
          <li className="px-4 py-2 text-sm text-slate-400">Nothing logged</li>
        )}
      </ul>
    </section>
  );
}

/**
 * One row: an entry the operator can open, or a meeting they cannot.
 *
 * **A MEETING IS NOT EDITABLE FROM HERE, DELIBERATELY.** Its minutes belong to
 * the meeting and are corrected on the record's Meetings tab, beside its
 * attendees and its notes. A second editor for `duration_minutes` on this page
 * would give the week's figure two front doors, and the correction this phase
 * relies on -- archive the meeting, log the hour by hand -- would then have two
 * as well.
 *
 * **BELOW THE BREAKPOINT THE ROW WRAPS**, with the minutes and the label on line
 * one and the badges and record chips beneath: at 375px the minutes column, two
 * badges and two chips would leave the label -- the one thing that has to be
 * readable -- a few dozen pixels. The basis is `calc(100% - 5rem)`, the minutes
 * column plus its gap, rounded up so nothing can creep back onto line one
 * (my-tasks.tsx's measurement and its reasoning).
 */
function RowLine({ row, onEdit }: { row: TimesheetRow; onEdit: (row: TimesheetRow) => void }) {
  const uncounted = uncountedLabel(row);
  return (
    <li
      data-testid={`timesheet-row-${row.id}`}
      data-kind={row.kind}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-slate-900 max-md:min-h-11 max-md:py-3"
    >
      <span
        data-testid="row-minutes"
        className={uncounted === null ? "w-16 shrink-0 font-medium" : "w-16 shrink-0 text-slate-400"}
      >
        {row.minutes === null ? "—" : formatMinutes(row.minutes)}
      </span>
      <span className="min-w-0 flex-1 truncate max-md:basis-[calc(100%-5rem)]">
        {row.kind === "entry" ? (
          <button
            type="button"
            data-testid="edit-entry"
            className="max-w-full truncate text-left underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
            onClick={() => onEdit(row)}
          >
            {rowLabel(row)}
          </button>
        ) : (
          rowLabel(row)
        )}
      </span>
      {row.kind === "meeting" && (
        <span className="shrink-0 rounded-sm bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
          meeting
        </span>
      )}
      {row.billable === true && (
        <span
          data-testid="row-billable"
          className="shrink-0 rounded-sm bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white"
        >
          billable
        </span>
      )}
      {uncounted !== null && (
        <span data-testid="row-uncounted" className="shrink-0 text-xs text-slate-400">{uncounted}</span>
      )}
      {row.links.map((link) => (
        <span key={`${link.kind}-${link.id}`} className="shrink-0 truncate text-xs text-slate-500">
          {link.label}
        </span>
      ))}
    </li>
  );
}

/**
 * **WHERE AN OPERATOR ACTUALLY REACHES TASK 1's HAND ENTRY.** The service and the
 * routes have existed since Task 1 and nothing in the product could call them;
 * this is the form, and it is the same form for a new hour and for correcting
 * one.
 *
 * **BILLABLE IS ASKED, NEVER PRE-TICKED.** `time_entries.billable` has no DEFAULT
 * and the wire schema requires it, both deliberately: a boolean whose two values
 * are equally ordinary has no default that is not a guess, and the guess that
 * reads worst -- non-billable -- under-reports chargeable time in a product with
 * no invoicing step to contradict it. A checkbox here would put that guess back
 * one layer out, where the database's refusal cannot reach it. So it is two
 * radios with neither pre-selected, and `buildTimeEntryInput` refuses a draft
 * that has not answered.
 *
 * **ARCHIVE, AND NO DELETE.** Archiving is the only way an hour leaves a total --
 * Conduit never expunges, and an entry cannot be corrected to nothing because
 * `minutes > 0` -- so this is the control that fixes a duplicated afternoon, and
 * it is the reason there is no Delete beside it.
 */
function TimeEntryDialog({
  row, defaultDay, onClose,
}: { row: TimesheetRow | null; defaultDay: string; onClose: () => void }) {
  const [draft, setDraft] = useState<TimeEntryDraft>(
    () => (row === null ? emptyTimeEntryDraft(defaultDay) : draftFromRow(row)),
  );
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<TimeEntryLinkKind | null>(null);
  const create = useCreateTimeEntry();
  const update = useUpdateTimeEntry();
  const archive = useArchiveTimeEntry();
  // The task this entry was on BEFORE the patch, so re-linking an hour refreshes
  // the booked total of the task it left as well as the one it joined -- the
  // server publishes both keys and this is the client half of the same rule.
  const previousTaskId = row?.links.find((link) => link.kind === "task")?.id ?? null;

  function submit() {
    setError(null);
    if (row === null) {
      const built = buildTimeEntryInput(draft);
      if (!built.ok) return setError(built.error);
      create.mutate(built.input, {
        onSuccess: () => onClose(),
        onError: (err) => setError(timeEntryErrorMessage(err)),
      });
      return;
    }
    const built = buildTimeEntryPatch(draft);
    if (!built.ok) return setError(built.error);
    update.mutate({ id: row.id, patch: built.input, previousTaskId }, {
      onSuccess: () => onClose(),
      onError: (err) => setError(timeEntryErrorMessage(err)),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="time-entry-dialog">
        <DialogTitle className="text-lg font-semibold text-slate-900">
          {row === null ? "Log time" : "Edit this entry"}
        </DialogTitle>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-2 max-md:flex-col">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
              Day
              <Input
                type="date"
                data-testid="entry-date"
                value={draft.workDate}
                onChange={(event) => setDraft({ ...draft, workDate: event.target.value })}
              />
            </label>
            <label className="flex w-28 flex-col gap-1 text-xs font-medium text-slate-500 max-md:w-full">
              Minutes
              {/* autoFocus: below the breakpoint DialogContent's own Close is the
                  first tabbable child, and Radix focuses that unless something
                  inside claims focus first -- see its doc comment. A form whose
                  point is typing must not open announcing "Close, button". */}
              <Input
                autoFocus
                type="number"
                min={1}
                step={1}
                data-testid="entry-minutes"
                value={draft.minutes}
                onChange={(event) => setDraft({ ...draft, minutes: event.target.value })}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            What was it?
            <Input
              data-testid="entry-description"
              placeholder="Optional, and the thing that makes a number an answer"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-slate-500">Billable?</legend>
            <div className="flex gap-4">
              {([["yes", true], ["no", false]] as const).map(([id, value]) => (
                <label key={id} className="flex items-center gap-2 text-sm text-slate-700 min-h-11">
                  <input
                    type="radio"
                    name="billable"
                    data-testid={`entry-billable-${id}`}
                    checked={draft.billable === value}
                    onChange={() => setDraft({ ...draft, billable: value })}
                  />
                  {value ? "Billable" : "Not billable"}
                </label>
              ))}
            </div>
          </fieldset>

          {/* THE SAME PICKER THE TIMER'S START FORM USES, and it must be: a
              timer's links become an entry's links unchanged at stop, so a
              picker that let one hold a state the other could not would produce
              a stop that fails at the moment the operator can least afford it.
              The testid prefix keeps every e2e selector on this form exactly
              what it was. */}
          <TimeEntryLinkPicker
            links={draft.links}
            picking={picking}
            onPicking={setPicking}
            onLinks={(links) => setDraft({ ...draft, links })}
            testIdPrefix="entry-link"
          />

          {error !== null && (
            <p role="alert" data-testid="entry-error" className="text-sm text-red-700">{error}</p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {row !== null && (
              <Button
                variant="outline"
                data-testid="archive-entry"
                className="mr-auto min-h-11"
                onClick={() => archive.mutate(row.id, {
                  onSuccess: () => onClose(),
                  onError: (err) => setError(timeEntryErrorMessage(err)),
                })}
              >
                Archive
              </Button>
            )}
            <Button variant="ghost" data-testid="entry-cancel" className="min-h-11" onClick={onClose}>
              Cancel
            </Button>
            <Button
              data-testid="entry-save"
              className="min-h-11"
              disabled={create.isPending || update.isPending}
              onClick={submit}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
