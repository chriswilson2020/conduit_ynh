# Conduit Phase 10 → v1.9.0 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-06-conduit-phase-10-time-tracking-design.md`, approved
by Chris 6 Sep. Read it first.

**Baseline:** v1.8.0, shipped 6 Sep. `main` at `00dc105`.

**Order:** the table and the hand entry first, because everything reports over them. Meetings
next, because that is where double-counting is made impossible and it must be settled before
anything sums. The timer last — it is the phase's real risk and it should meet a working
timesheet rather than be built beside one.

---

## Task 1: The table, hand entry, and the export sheet

- [ ] **`time_entries`**: a duration, a date, an owner, a billable flag, and the link set.
- [ ] **Link rule: AT LEAST ONE of five** — task, deal, project, company, contact. Not
      exactly-one: an hour can belong to a project *and* the deal it came from. Not
      any-including-none: **unattached time appears in no report and can be found only by SQL**,
      which makes the week's total quietly wrong in the direction nobody checks.
- [ ] **Phase 9 established the pattern for a five-way link set with a per-type CHECK** —
      `documents_entity_matches_type` in `0020`. Read it before inventing one.
- [ ] **THE EXPORT SHEET SHIPS IN THIS TASK, not later.** `services/export.ts` has one
      hand-written `*Sheet` per entity and **does not walk the schema**. The backup is a
      `pg_dump` and gets the table for free; the readable half does not. **Phase 9's export was
      missed by three tasks running** — this is the whole reason the obligation is written here.
- [ ] Billable is a **flag**. No rate — invoicing is out of Conduit, and a rate without a rate
      card is a number somebody retypes forever.

## Task 2: Meetings count, and the same hour cannot be counted twice

- [ ] **`meetings.duration_minutes` already holds tracked time** and has never been aggregated.
      The timesheet reads meetings and entries together.
- [ ] **A time entry naming a meeting is refused BY THE DATABASE.** Chris's decision, and the
      backlog's requirement in as many words: the other possibility must be **impossible rather
      than discouraged**. A CHECK, not a convention.
- [ ] **A meeting with no duration contributes nothing, and that must be visible.** A report that
      silently treats "unknown length" as zero is the same failure in a smaller costume.

## Task 3: `tasks` gets an estimate, and booked-versus-estimated exists

- [ ] `tasks` carries **no effort or estimate column** — only `start_date`, `due_date`,
      `completed_at`, `status`, `progress_pct`. Dates and a percentage, never a quantity of work.
- [ ] **This changes a shipped surface.** The board, the Gantt and the task drawer all render
      tasks today. **If adding an estimate ripples further than expected, report it.**

## Task 4: The timesheet

- [ ] **A list, not a weekly grid.** The grid is the classic and is the hardest thing in this
      product to operate on a phone, which is where Chris is. No approval workflow — single user.
- [ ] It answers "where did the week go", summing entries and meetings without double-counting.

## Task 5: The timer — LAST, AND THE RISK IS NOT THE TIMING

- [ ] **Running state must survive a restart, a closed tab and a second device.** Conduit is one
      process with no swap; a timer in memory dies with a deploy.
- [ ] **The weekend problem is the common failure, not an edge case.** "You left this running for
      62 hours" — and **the recovery interaction is most of the feature**: what the operator is
      offered, what the default is, what happens if they ignore it.
- [ ] **Two capture paths can double-count each other.** A timer entry and a hand entry for the
      same afternoon are exactly what Task 2 makes impossible for meetings, arriving by a
      different door. **Same treatment: impossible, not discouraged.**
- [ ] **If this turns out to be a phase of its own, say so and stop.** Four tasks shipped and one
      honestly reported beats five half-built — the instruction Phase 9's Task 4 was given, and it
      was right to have it.

---

## Definition of done

- Time bookable against a task, deal, project, company or contact, by timer and by hand.
- **A time entry naming a meeting refused by the database**, and meetings counted.
- `tasks` carries an estimate; booked-versus-estimated exists.
- A timesheet that answers "where did the week go", on a phone.
- **A time-entry sheet in the export, in the release that creates the table.**
- Full unit and e2e green, counts accounted for.

---

## Explicitly NOT in this phase

- **Rates and rate cards.** Billable is a flag; rates touch the products item on the backlog.
- **Invoicing.** Ruled out of Conduit.
- **Approval workflow.** Single user.
- **Microsoft Graph**, still deferred until Conduit wants the calendar.
