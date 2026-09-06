# Conduit Phase 10 — time tracking and timesheets

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.9.0 (see the sequencing recommendation).
**Predecessor:** v1.8.0 (Phase 9), shipped 6 Sep.

---

## Chris's three decisions, 6 Sep

1. **Log time against anything, properly** — not the reporting-only version. Time bookable
   against the records Conduit holds, with the reporting that implies.
2. **Both capture paths** — a start/stop timer *and* after-the-fact entry.
3. **Meetings count, and cannot be double-booked** — the timesheet sums logged meetings
   alongside manual entries, and a manual entry cannot be attached to a meeting, so the same
   hour cannot be counted twice.

He was offered the smaller version of (1) and the single path of (2) and took neither. **This is
the largest phase since Phase 7**, and the spec says so rather than discovering it in Task 3.

---

## Two facts read out of `schema.ts`, not assumed

**1. `meetings.duration_minutes` already exists** (Phase 5, nullable because not every logged
meeting has a known length). **Conduit therefore already holds tracked time** — a logged meeting
with a duration is a recorded hour that has never been aggregated.

**2. `tasks` has no effort or estimate column.** It carries `start_date`, `due_date`,
`completed_at`, `status` and `progress_pct` — dates and a percentage, never a quantity of work.
**"Booked versus estimated" is usually the point of tracking time against tasks, and it cannot
exist until that column does.**

---

## What an hour belongs to

**Five tables already carry the same four foreign keys** — company, contact, deal, project — and
enforce **three different rules** over them:

| Tables | Rule |
|---|---|
| `notes`, `files` | exactly one (`num_nonnulls(...) = 1`) |
| `meetings` | at least one (`>= 1`) |
| `tasks`, `mail_threads` | any subset, including none |

**Exactly-one is wrong here**, and the backlog says why: an hour can legitimately belong to a
project *and* the deal it came from. So the live question is `meetings`' rule against `tasks`':
**is an hour attached to nothing a legal row?**

**Recommendation: at least one, plus `task_id`.** Unattached time is time that appears in no
report and can be found only by SQL — which makes the week's total quietly wrong in the one
direction nobody checks. A row that cannot be reported on is not a time entry, it is a note with
a number on it.

**`task_id` joins the set** because decision 1 is "against anything" and a task is the natural
unit for the estimate comparison. That makes five FKs, like `documents` — and Phase 9 established
the pattern for widening a link set with a CHECK that says *which* one per type.

---

## Double-counting is made impossible, not discouraged

The backlog's requirement, and Chris's choice: **a manual entry cannot be attached to a meeting.**

A logged meeting with a duration *is* an hour. The timesheet reads meetings and time entries
together; the schema forbids a time entry naming a meeting, so the same hour has one and only one
source. **This is a CHECK, not a convention** — the whole point of the decision is that the other
possibility is unspellable.

**A meeting without a duration contributes nothing**, which is correct and must be visible: a
report that silently treats "unknown length" as zero is the same failure in a smaller costume.

---

## The timer is most of the phase's risk, and it is not the timing

A start/stop timer sounds like a column. What it actually brings:

- **Running state that must survive** a restart, a closed tab, and a second device. Conduit is one
  process with no swap; a timer held in memory dies with a deploy.
- **The weekend problem.** "You left this running for 62 hours" is not an edge case, it is the
  common failure, and **the recovery interaction is most of the feature** — what the operator is
  offered, what the default is, and what happens if they ignore it.
- **Two paths that can produce the same hour.** A timer entry and a manual entry for the same
  afternoon are exactly the double-count that decision 3 rules out for meetings, arriving by a
  different door.

**Recommendation: sequence it, do not cut it.** Ship the data model, manual entry, meetings and
reporting first; the timer second, against a schema that already holds entries. That is not a
reduction of scope — both halves ship — it is the order that lets the timer be built against a
working timesheet rather than beside one. **Chris's call; the spec builds both either way.**

---

## Billable is a flag, not a rate

Invoicing is ruled out of Conduit. **Billable time here feeds reporting and export, not billing**,
so this is a boolean on an entry. **Rates are deliberately out** — they touch the products and
rate-card item already on the backlog, and a rate on a time entry without a rate card is a number
somebody has to keep re-typing.

---

## The export obligation, which reversed when 7.6 shipped

This item used to read "7.6's export must include time entries". **7.6 shipped without them,
correctly — there was no table to export.** So the obligation moves:

**Phase 10 must add a sheet to the export in the same change that creates its table.**
`services/export.ts` has one hand-written `*Sheet` function per entity with its columns selected
explicitly; **it does not walk the schema**, so a table added later appears in the export only if
somebody writes the function.

**The backup needs nothing** — it is a `pg_dump` of the whole database, so a new table is in it the
day it exists. That asymmetry is the point: the exact half picks up new entities for free and the
readable half does not, and **a timesheet trapped in the app is the failure this was always
about.** Phase 9's export was missed by three tasks running; this one is written down at the top.

---

## Timesheet shape

**A list, not a weekly grid.** The grid (days across, projects down) is the classic and is the
hardest thing in this product to get right on a phone — and Chris uses the phone. A list is easier
and less useful, and "less useful" is recoverable; a grid nobody can operate on a phone is not.
**No approval workflow** — single user.

---

## Definition of done

- Time bookable against a task, deal, project, company or contact, by timer and by hand.
- **Meetings counted, and a manual entry naming a meeting refused by the database.**
- `tasks` carries an estimate, and booked-versus-estimated exists.
- A timesheet that answers "where did the week go", on a phone.
- **A time-entry sheet in the export, in the same release that creates the table.**
- Full unit and e2e green.

---

## Risks

1. **The timer's recovery interaction is the phase's real content**, not its timing.
2. **Two capture paths can double-count each other**, which is decision 3's problem arriving by a
   different door. It needs the same treatment: impossible, not discouraged.
3. **An estimate column on `tasks` changes a shipped surface.** The board, the Gantt and the task
   drawer all render tasks today.
4. **The export is the half that does not pick things up for free**, and Phase 9 missed it three
   times running.
