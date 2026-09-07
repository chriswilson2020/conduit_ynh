import { useEffect, useState } from "react";
import { timerSummary } from "@conduit/shared";
import type { RunningTimer } from "@conduit/shared";
import { useDiscardTimer, useRunningTimer, useStopTimer } from "../queries";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import {
  buildTimerStopInput, timerErrorMessage, timerLabel, timerLandingSentence, timerStopDraft,
  TIMER_TICK_MS, type TimerStopDraft,
} from "./timer-lib";

/**
 * **THE RUNNING TIMER, ON EVERY PAGE (Phase 10 Task 5).**
 *
 * **IT IS IN THE SHELL AND NOT ON /timesheet, AND THAT IS THE FEATURE RATHER
 * THAN A PLACEMENT.** The spec's second risk is "you left this running for 62
 * hours", and a timer visible only on the page an operator visits once a week is
 * a timer that is always left running. Conduit has nineteen routes; this is the
 * strip on the other eighteen.
 *
 * **AND IT IS WHERE THE WEEK'S TOTAL CAN SEE IT.** Task 2's rule is that an hour
 * excluded from a figure in SILENCE is the phase's own failure mode -- so a
 * timesheet reading "5h counted" while three hours are accruing off-screen would
 * be that failure with a new cause. A running timer is in no total and cannot be
 * (it is not a `time_entries` row), and `timerSummary` says "nothing is counted
 * until you stop it" in the same viewport as the total that leaves it out.
 *
 * ---
 *
 * **THE STRIP RENDERS `timerSummary` AND COMPOSES NOTHING.** The elapsed figure
 * and the sentence about what it can become are one string for
 * `timesheetSummary`'s reason: a surface that printed the stopwatch alone would
 * be showing a number with no statement of what it is, and -- past a day -- a
 * number the database will refuse. `timer-render.test.ts` reads this file off
 * disk and fails if it starts spelling any clause itself.
 *
 * **IT TICKS AGAINST THE DEVICE CLOCK, AND THE WIRE CARRIES NO DURATION.** The
 * payload has `startedAt` and nothing derived from it, so there is exactly one
 * definition of "how long has this run" (`timerElapsedMinutes`) rather than one
 * ticking here and one frozen in a response. A device a few seconds behind the
 * server clamps to nought rather than rendering a negative duration.
 *
 * ---
 *
 * **WHAT WAS REJECTED, AND WHY EACH ONE IS NOT REVISITED.**
 *
 * REJECTED: a bottom-bar tab or a rail tab for the timer. `PRIMARY_NAV_IDS` is
 * four by spec with More in the fifth slot, and Task 4 declined a fifth bottom
 * tab and a SIXTH rail tab against measurements (the rail's five labels are
 * 349px inside a 342px box at 390px). This costs no nav slot at all: it is a
 * row of its own between the header and the content, present only while
 * something is running.
 *
 * REJECTED: a floating pill. It would overlay content at the one width where
 * there is least of it, and the bottom bar is already `fixed` there.
 *
 * REJECTED: showing seconds. `formatMinutes` is the app's one duration
 * spelling and a seconds counter would be a second one, on the surface most
 * likely to be glanced at rather than read. The tick is a second so the two
 * transitions that matter -- the proposal appearing at one minute and being
 * withdrawn at a day -- are not late.
 *
 * REJECTED: starting a timer from here. A start needs a record picker, which
 * needs the width the strip does not have, and the answer to "start one" is
 * /timesheet's own button. Stopping is what has to be reachable from anywhere,
 * because that is the half an operator forgets.
 */
export function TimerStrip() {
  const { data } = useRunningTimer();
  const [stopping, setStopping] = useState(false);
  const timer = data?.timer ?? null;

  // ONE TICK FOR THE WHOLE STRIP, and it lives here rather than in a hook per
  // figure: `timerSummary` is one string derived from one clock reading, so one
  // `now` is what keeps its clauses from being computed a millisecond apart.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // The interval is torn down when nothing is running, so the eighteen pages
    // that do not have a timer pay nothing at all for this component.
    if (timer === null) return undefined;
    const handle = setInterval(() => setNow(new Date()), TIMER_TICK_MS);
    return () => { clearInterval(handle); };
  }, [timer === null]);

  if (timer === null) return null;

  return (
    <div
      data-testid="timer-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-slate-900"
    >
      <span data-testid="timer-label" className="min-w-0 flex-1 truncate font-medium">
        {timerLabel(timer)}
      </span>
      {/*
        THE SENTENCE, RENDERED AND NOT COMPOSED. It carries the elapsed figure,
        whether that figure can be logged, and -- always -- that nothing is
        counted until the timer stops. Below the breakpoint it takes a whole
        line of its own: at 390px it is the longest thing on the strip and the
        two controls beside it must stay at the 44px floor.
      */}
      <span data-testid="timer-summary" className="text-slate-700 max-md:basis-full">
        {timerSummary(timer, now)}
      </span>
      <Button data-testid="timer-stop" className="min-h-11" onClick={() => setStopping(true)}>
        Stop
      </Button>
      {stopping && <TimerStopDialog timer={timer} onClose={() => setStopping(false)} />}
    </div>
  );
}

/**
 * **THE RECOVERY INTERACTION, WHICH THE SPEC CALLS MOST OF THE FEATURE.**
 *
 * Three things are on this screen and each of them is a decision:
 *
 *   **THE MINUTES BOX, PRE-FILLED ONLY WHEN THE CLOCK'S ANSWER COULD BE AN
 *   ENTRY.** `timerStopDraft` fills it with the elapsed figure for an ordinary
 *   stop -- one tap, Save -- and leaves it EMPTY once the clock has run past a
 *   day, because there is no legal figure to default to. A form that pre-filled
 *   1440 for a forgotten weekend would be proposing a full day nobody worked,
 *   and a proposal is what gets accepted without reading.
 *
 *   **THE DAY THE HOURS WILL LAND ON, SPELLED OUT.** A timer left running since
 *   Friday books FRIDAY, not today, because the day comes off `started_at`. That
 *   is the recovery's actual surprise and it is stated before the operator
 *   commits rather than discovered in last week's total afterwards.
 *
 *   **DISCARD, BESIDE SAVE.** The other honest answer to a timer that ran all
 *   weekend is that it represents no work at all, and without this control the
 *   only way to clear the strip is to invent a number -- which is worse than
 *   nothing, because afterwards it is indistinguishable from a real hour. The
 *   row is kept either way; Conduit never expunges.
 *
 * **AND BILLABLE IS ASKED, NEVER PRE-TICKED**, `TimeEntryDialog`'s rule
 * inherited word for word: the column has no DEFAULT and both values are
 * ordinary, so a tick here would put the guess back one layer out where the
 * database's refusal cannot reach it. A timer knows how long it ran; it has
 * never known whether the work was chargeable.
 *
 * **NOTHING IS WRITTEN UNTIL SAVE, AND THE TIMER GOES ON RUNNING UNTIL THEN.**
 * There is no half-stopped state: closing this dialog, closing the tab or
 * losing the connection leaves the clock exactly where it was, and the operator
 * meets the same screen next time. That is what makes "what happens if they
 * ignore it" answerable -- it keeps running, and it never becomes an entry on
 * its own.
 */
function TimerStopDialog({ timer, onClose }: { timer: RunningTimer; onClose: () => void }) {
  // Built once, from the clock at the moment Stop was pressed. It deliberately
  // does NOT keep ticking: a proposal that changed under the operator's cursor
  // while they were deciding would be a form editing itself.
  const [draft, setDraft] = useState<TimerStopDraft>(() => timerStopDraft(timer));
  const [error, setError] = useState<string | null>(null);
  const stop = useStopTimer();
  const discard = useDiscardTimer();

  function submit() {
    setError(null);
    const built = buildTimerStopInput(draft);
    if (!built.ok) return setError(built.error);
    stop.mutate({ id: timer.id, input: built.input }, {
      onSuccess: () => onClose(),
      onError: (err) => setError(timerErrorMessage(err, "stop")),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="timer-stop-dialog">
        <DialogTitle className="text-lg font-semibold text-slate-900">Stop the timer</DialogTitle>
        <div className="mt-3 flex flex-col gap-3">
          <p data-testid="timer-landing" className="text-sm text-slate-600">
            {timerLandingSentence(timer.workDate)}
          </p>

          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-medium text-slate-500">Booked to</span>
            {timer.links.map((link) => (
              <span
                key={`${link.kind}-${link.id}`}
                data-testid="timer-link-chip"
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
              >
                {link.label}
              </span>
            ))}
          </div>

          <label className="flex w-32 flex-col gap-1 text-xs font-medium text-slate-500 max-md:w-full">
            Minutes
            {/* autoFocus for TimeEntryDialog's reason: below the breakpoint
                DialogContent's own Close is the first tabbable child, and a form
                whose point is typing must not open announcing "Close, button". */}
            <Input
              autoFocus
              type="number"
              min={1}
              step={1}
              data-testid="timer-minutes"
              value={draft.minutes}
              onChange={(event) => setDraft({ ...draft, minutes: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            What was it?
            <Input
              data-testid="timer-description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-slate-500">Billable?</legend>
            <div className="flex gap-4">
              {([["yes", true], ["no", false]] as const).map(([id, value]) => (
                <label key={id} className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="timer-billable"
                    data-testid={`timer-billable-${id}`}
                    checked={draft.billable === value}
                    onChange={() => setDraft({ ...draft, billable: value })}
                  />
                  {value ? "Billable" : "Not billable"}
                </label>
              ))}
            </div>
          </fieldset>

          {error !== null && (
            <p role="alert" data-testid="timer-error" className="text-sm text-red-700">{error}</p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              data-testid="timer-discard"
              className="mr-auto min-h-11"
              onClick={() => discard.mutate(timer.id, {
                onSuccess: () => onClose(),
                onError: (err) => setError(timerErrorMessage(err, "discard")),
              })}
            >
              Discard
            </Button>
            <Button variant="ghost" data-testid="timer-cancel" className="min-h-11" onClick={onClose}>
              Keep running
            </Button>
            <Button
              data-testid="timer-save"
              className="min-h-11"
              disabled={stop.isPending || discard.isPending}
              onClick={submit}
            >
              Log it
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
