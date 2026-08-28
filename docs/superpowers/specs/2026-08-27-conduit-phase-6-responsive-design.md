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

## Amendments (coordinator, during execution)

1. **The three-site cap governs REACTIVE RENDER BRANCHING, not every read of the
   breakpoint.** Task 4's quality review established that the Gantt cannot satisfy the
   `md:`-CSS-only instruction: CSS can disable the pointer paths (verified in a browser —
   `max-md:pointer-events-none` on the move overlay, `max-md:hidden` on the resize strips
   and dependency handle), but **no CSS property stops a key event**, and the chart's
   `onKeyDown` commits real schedule changes (Arrow moves, Shift+Arrow resizes). Because
   the breakpoint is width-based this also bites a narrowed desktop window and a tablet
   with a keyboard — and `e2e/tasks.spec.ts` drives the Gantt by keyboard ONLY.

   **Ruling: an imperative `window.matchMedia(mobileMediaQuery()).matches` read INSIDE the
   key handler is permitted and is not a fourth site.** The rule exists for the reason the
   Mechanism section gives — "two component trees to maintain, and a first-paint flash on
   every page" — and a one-shot read at event time creates neither: no subscription, no
   re-render, no second tree. The breakpoint stays single-sourced through
   `mobileMediaQuery()`. **Explicitly ruled OUT: a differently-named hook over
   `subscribeToMediaQuery`/`readIsMobile`**, which would pass the guard by spelling while
   evading the rule. `useIsMobile()` itself remains closed at three sites.

2. **The Gantt's phone problem is geometry, not read-only-ness — and Task 5 must answer it
   before building.** Measured: the chart's sidebar is `sticky left-0, width: 240,
   flexShrink: 0`, so at 375px it takes 240 and leaves **135px of timeline** (about 4.5 day
   columns). Bars are 22px tall (8px on summary rows) against the phase's 44px floor, and a
   same-day bar is 6.4px wide at week zoom. Every dimension is an inline JS-computed style,
   so `max-md:` cannot rescale any of it. **A technically-read-only 135px chart is not
   obviously the deliverable**, and neither is a tap target 6.4px wide. Task 5 reports its
   assessment and its proposed geometry BEFORE implementing; if the honest answer is that
   the chart cannot be made useful at 375px and the phone should get the task-list fallback
   the brainstorm offered as an alternative, that is a finding to bring back, not a failure.

3. **There is no tap-to-open on a Gantt bar today** (no `onClick` anywhere under
   `components/gantt/`), so the drawer path — which carries the whole no-capability-gap
   claim — is an ADDITION, not a re-use. A `hidden max-md:block` tap layer with negative
   insets reaches 44px but overlaps 6px into each neighbouring row at the 32px row pitch;
   expect mis-taps at boundaries and say what you did about them.

4. **Amendment 1 extends to a mount-time read, on the same reasoning.** Task 5's gate
   measurement found the chart shows NO BARS at first paint on a phone: `RANGE_PAD_DAYS` is
   14, so day 0 is a fortnight before the earliest task, and with the visible band the
   phone has, bars fall outside it at `scrollLeft: 0`. "Technically read-only" would have
   shipped as technically blank. A one-shot `window.matchMedia(mobileMediaQuery()).matches`
   read at mount, to set an initial scroll position, is permitted for the same reason the
   key-handler read is: no subscription, no re-render, no second component tree, breakpoint
   still single-sourced. The exclusion is unchanged — **no differently-named hook over
   `subscribeToMediaQuery`/`readIsMobile`**. Scrolling at all widths is rejected: that is a
   desktop change.

5. **Remove slack stays reachable on a phone — and the earlier pre-ruling was wrong to list
   it as a pointer path.** It is a click plus a `window.confirm`, both phone-native, so
   hiding it would have created this phase's FIRST real capability exception, which the
   Definition of done forbids. Ruling: the **per-project** compact button stays visible
   below the breakpoint (it is already a floored `Button`); only the **per-group** one is
   hidden, because it measures 81x19 and at a narrowed sidebar its header row leaves the
   project name rendering as a single letter. The same sweep remains reachable from that
   project's own Gantt page, which `project-detail.tsx` links to. The Definition of done's
   "no stated capability exception" therefore still holds.

6. **The Gantt's phone tap target is the ROW, at 32px, and that is a deliberate exception to
   the 44px floor.** A 44px layer built with negative insets does not improve aim — at a
   32px row pitch it only formalises that the later sibling wins a 6px overlap band, which
   puts a wrong-task drawer one tap away. A full-row target instead removes the horizontal
   precision problem entirely, which is what actually defeats a 6.4px-wide same-day bar,
   and it makes the sidebar half tappable without panning at all. Recorded here so it is
   acknowledged rather than discovered in review.

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
