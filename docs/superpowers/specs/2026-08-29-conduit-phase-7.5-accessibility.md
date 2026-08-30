# Conduit Phase 7.5 — Keyboard access, focus, and the flake → v1.2.0

## Context

Phases 6 and 7 each wrote findings down and deliberately did not fix them, on the grounds
that a phase should ship what it set out to ship. That list has now stopped growing and
started aging, and Chris has scheduled it as **Phase 7.5, before Phase 8**.

Four items. Three are correctness in the app; one is a test-infrastructure defect that has
cost real time and has finally become reproducible.

**Three items from that list are NOT here** — the 36px recipient suggestions, the rail's
download link with no touch floor, and the kanban's non-sticky stage picker. They are CSS,
they are an hour, and they ride along with **v1.1.0** (salutation and pronouns), which is
already touching those surfaces. Splitting them out into their own release would cost more
ceremony than the fixes are worth.

Ships as **v1.2.0**: rows gaining a keyboard interaction they never had is more than a
patch.

## 1. Entity rows are keyboard-inert, and that is the largest item here

**The finding was recorded as a screen-reader gap and that undersells it.** The rows in
every entity list — companies, contacts, projects, pipelines, my tasks — have no role, no
accessible name and **no tab stop**. So they cannot be opened from the keyboard at all, by
anyone, at a desk or on a phone. A screen reader is simply where it was noticed; at phone
width the rows also lose their table semantics, which makes it worse there, and that is how
Phase 6 came to write it down.

**The fix is to make a row what it already behaves like: a link to the record.** Navigation
is what a row does, so an anchor is the honest element, and it brings a tab stop, Enter,
middle-click and open-in-new-tab for free — none of which the current handler supports.
A button would give the tab stop and lose the rest.

Three constraints, and the third is the one that will bite:

- **The visual result must not change**, at either width. This is an accessibility and
  interaction fix, not a redesign.
- **The desktop table semantics must survive.** A row is a `<tr>` at desk width; the link
  has to live inside it without breaking the table, and the phone card layout has to keep
  working from the same DOM.
- **The e2e safety net here is TWO tests, not the hundred-odd this sentence used to claim.**
  Measured during Task 1's review: `crm.spec.ts:54` (companies at 1280) and
  `mobile.spec.ts:169` (companies at 390) are the only tests that click a row this change
  touches. Two others locate a contacts row and assert text only; nothing clicks a projects,
  pipelines or task row. The earlier figure counted every test in the suite rather than the
  tests that exercise a row, and it made the net look far denser than it is.

  So the constraint stands but its enforcement does not: a selector that keeps working
  proves almost nothing here, and the change needs guards of its own rather than confidence
  in the existing suite. A test that needed *loosening* is still a signal the change went
  too far.

## 2. The composer opens with Close focused

Open a new mail and the focus is on the Close button, so the first thing anyone does is
reach for the To field with a mouse or tab past a control that discards their work.

**Phase 6 measured why this was deferred**: the first tabbable element on desktop is the
From `SelectTrigger`, so fixing the phone changes the desktop too, and v0.10.0 had forbidden
altering the desktop experience.

**Coordinator decision, flagged for objection: make the change at both widths.** Focusing
the To field on a new compose is better everywhere, and v0.10.0's rule existed to stop a
responsive sweep silently degrading the desk — not to freeze a defect. A reply should focus
the **body** instead, since the recipient is already known; that distinction is part of the
work rather than a refinement of it.

## 3. Closing a dialog leaves focus on `<body>`

Pre-existing, visible at a desk as well as on a phone, and affecting the task drawer, the
composer and both settings dialogs. Radix restores focus to the trigger by default, so
**something is overriding or unmounting it** — finding what is most of this task. Do not
"fix" it by focusing something plausible on close; find the cause first, because a
workaround here will paper over whatever is also causing it elsewhere.

## 4. The `mail-sync` flake, which is now reproducible

Four sightings across Phases 6 and 7, none of them ever failing CI. Established by Phase 4
of this phase's predecessor: **1 failure in 12 runs on an idle machine, 8 in 12 with a
second vitest process running.** So contention amplifies a real race rather than causing it.

Two hypotheses are already dead and both are recorded: it is not `waitFor`'s 10s deadline
(vitest's own 5000ms timeout always fires first, so that label can never appear), and it is
not a slowdown (the case normally costs 180-240ms and instead **wedges**).

**Named next suspect, untested:** `ManualClock.wait(ms <= 0)` resolving without registering
a pending entry, so a `waitFor(() => clock.pendingCount() > 0)` waits for something that has
already happened and never will again.

**The fix must be deterministic, not a longer timeout.** That file owns a `ManualClock`, and
a wall-clock deadline inside a test that controls its own clock is the actual defect. If the
named suspect is wrong, say so and report what it is instead — a second falsified hypothesis
with evidence is a good outcome here, and better than a timeout bump that hides it for
another two phases.

## Out of scope

A general accessibility audit; ARIA beyond what these four items need; keyboard shortcuts;
focus management anywhere the four items do not reach; and the three CSS items, which are
in v1.1.0.

## Testing

- **Keyboard journeys in e2e**: tab to a row and press Enter, at both widths, for at least
  two entity lists. This repo has no testing-library, so e2e is the only place component
  behaviour is proven.
- **The composer's focus asserted on open**, for a new compose and for a reply, at both
  widths — they are different assertions and both are the point.
- **Focus after a dialog closes** asserted against the trigger rather than against `<body>`.
  Phase 6 recorded the current behaviour as a known finding, so this test is the record of
  it being fixed.
- **The flake**: a test that fails deterministically against the defect. If the mechanism
  turns out to be the clock, the repair is to make those waits clock-driven, and the proof
  is the reproduction recipe (CPU contention, 12 runs) coming back clean.
- Baseline at start: whatever v1.1.0 ships with — currently 2347 unit + 105 e2e.

## Rollout

v1.2.0, standard mechanics, branch from `main` after v1.1.0. Size: four tasks, of which
item 1 is the largest and item 4 the most self-contained. No migration expected; if a task
believes it needs one, that is a finding to report rather than implement.
