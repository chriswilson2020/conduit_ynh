# Conduit Phase 6 — Responsive / mobile UI

## Context

Chris asked for an interface "usable comfortably on a laptop or mobile phone" (21 Aug,
recorded in the post-v0.8.0 roadmap). The app is desktop-only today in a stronger sense
than it looks: about thirty breakpoint utilities exist across the whole web package,
nearly all of them the `lg:flex-row` / `lg:w-2/3` detail-page frames Phase 5 touched.
The shell itself — a fixed `w-56` dark sidebar beside the content — carries no
breakpoint at all, so on a phone the navigation occupies most of the viewport before
any content is drawn. Ships as v0.10.0.

Decisions taken with Chris in the Phase 6 brainstorm:

| Decision | Choice |
|---|---|
| Ambition | **Everything works on a phone.** Not a mobile subset and not read-only: every job the CRM does can be done from a phone. |
| Navigation | **Bottom tab bar + overflow.** Four primary destinations in a thumb-reachable bar below the breakpoint, the rest behind a More sheet. The existing sidebar is unchanged above it. |
| Deals kanban | **One stage at a time, with a Move action.** A stage picker, that stage's deals as a list, and "Move to..." on each card. No touch drag. |
| Gantt | **Read-only pan and zoom**, tapping a bar opens the task drawer. |

## Definition of done (the scope rule, and it is testable)

**Every capability the app offers is reachable on a phone, and no surface is a dead end.**

Two surfaces reach it by a different interaction than desktop, and neither loses a
capability in doing so — this was checked, not assumed:

- The kanban's purpose is moving a deal between stages; "Move to..." does exactly that.
- The Gantt's chart edits are rescheduling and dependencies. **Both are also in the task
  drawer** (`field-dates`, `dependency-list`, add/remove), which is an ordinary
  phone-usable surface. A read-only chart plus tap-to-drawer therefore removes no
  capability at all.

So the phase has no stated capability exception. If implementation discovers one, that is
a finding for a coordinator ruling, not something to absorb quietly.

## Mechanism

**Hybrid, with one rule that decides which half applies:**

- **Tailwind breakpoints do all LAYOUT work** — stacking, widths, column counts, spacing,
  visibility. This is the large majority of the phase and needs no JavaScript.
- **A single `useIsMobile()` hook is used ONLY where the INTERACTION MODEL differs** —
  where the small screen is not a re-layout of the same UI but a different one: the
  bottom navigation, the inbox's drill-in stack, the kanban's stage view. Three sites,
  named here so a fourth is a deliberate addition rather than a drift.
- **One breakpoint constant**, defined once and shared between the Tailwind config and
  the hook, so CSS and JS can never disagree about what "mobile" means. The hook is
  implemented over `matchMedia` with the same query string the config generates.

Rejected: CSS-only (drill-in navigation needs state, not layout); hook-everywhere (two
component trees to maintain, and a first-paint flash on every page rather than three).

## The work, surface by surface

### The shell (the biggest single win)

Below the breakpoint: the sidebar is replaced by a **bottom tab bar** carrying four
primary destinations plus **More**, which opens a sheet listing the rest. The header
keeps the app name and collapses global search behind an icon that opens it as a sheet.
Above the breakpoint nothing changes — the current sidebar and header are untouched, and
that is a hard requirement: this phase must not alter the desktop experience.

**The four primary destinations are Mail, Companies, Contacts and My Tasks**, with
Pipelines, Projects, Gantt and Settings behind More. The reasoning is what a phone is
actually for here: looking someone up, reading mail, and checking what you owe. Working
a pipeline or a schedule is desk work, and both remain one tap away. Mail leads because
it carries the unread badge. An implementer who finds this wrong in use should say so
rather than silently reorder — the split is also a unit-testable function.

### The mechanical sweep

- **Lists/tables → cards below the breakpoint.** The entity tables (companies, contacts,
  projects, pipelines, my tasks) become stacked cards; column headers have no meaning at
  that width.
- **Forms single-column**, inputs full-width, no side-by-side field pairs.
- **Dialogs and drawers become full-height sheets** on a phone (the task drawer, the
  composer, the link panel, the meeting form).
- **Touch targets**: interactive elements reach the platform minimum (44px) below the
  breakpoint. Applies to icon buttons, tab triggers, list rows and menu items.
- **The record rail** already stacks under the detail content (Phase 5's `lg:flex-row`);
  its five tabs need to survive a narrow width, which today they may not.

### The inbox

Below the breakpoint the three-pane grid becomes a **drill-in stack**: folders → threads
→ conversation, one at a time, with back navigation at each level. The panes already
exist as components; this is a navigation state, not a rewrite. Above the breakpoint the
existing grid is unchanged. Bulk selection, the folder picker and Hide/Archive/Trash all
remain reachable — per the definition of done, nothing may become desktop-only.

### The kanban

Below the breakpoint: a **stage picker** (the stages as a scrollable segmented control or
a select), the chosen stage's deals as a list, and a **"Move to..."** action on each card
listing the other stages. Deal creation stays available. The funnel/summary that sits
above the board should remain legible or collapse behind a disclosure.

### The Gantt

Below the breakpoint: the chart renders **read-only** with pan and zoom; dragging bars and
editing dependencies are desktop-only interactions, and **tapping a bar opens the task
drawer**, where both are editable. The chart must not silently ignore a drag attempt —
if a touch drag is not supported it should not appear to start one.

## Out of scope (deferred, not rejected)

Installing to the home screen (PWA/manifest/service worker); offline support; push
notifications; a native app; touch drag on the kanban; editing the Gantt from a phone;
responsive email *rendering* beyond what the existing sandboxed frame does (a sender's
HTML is their own).

## Testing

- **The existing 72 e2e tests must pass unchanged** at their current viewport. This phase
  is additive to desktop, and a desktop regression is the main risk of a sweep this wide.
- **New phone-viewport e2e journeys** using Playwright device emulation: navigate via the
  bottom bar and the More sheet; look up a company and read its rail; read a mail thread
  through the drill-in stack and reply; move a deal between stages via the Move action;
  open a Gantt bar's task drawer and change its dates; log a meeting and add a follow-up
  task. Together these ARE the definition of done, expressed as tests.
- **Pure-lib unit tests** for any new logic (the breakpoint hook's query, the nav's
  primary/overflow split, the kanban's move-target list). This repo has no
  testing-library, so component rendering is proven by e2e only — as in Phase 5.
- Suite baseline at start: 1723 unit + 36 integration + 72 e2e, green.

## Rollout

v0.10.0, standard mechanics, branch `worktree-phase-6-responsive` from the v0.9.1
manifest commit (1a4bc1d). No migration; no server-side change expected at all — if a
task believes it needs one, that is a finding to report rather than implement. Live
verification is the point of this phase and is best done on Chris's actual phone: reach
every destination from the bottom bar, read and reply to a mail thread, move a deal, log
a meeting, open a task from the Gantt.
