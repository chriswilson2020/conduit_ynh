# Conduit Phase 6 — Responsive / mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Every capability the CRM offers reachable from a phone, with no surface a dead end and no change to the desktop experience — released as v0.10.0.

**Architecture:** One breakpoint constant shared between the Tailwind config and a single `useIsMobile()` hook. Tailwind breakpoints do all LAYOUT work; the hook is used at exactly THREE sites where the interaction model differs (bottom navigation, inbox drill-in, kanban stage view). Spec: `docs/superpowers/specs/2026-08-27-conduit-phase-6-responsive-design.md` — the authority; its Definition of done is the completeness checklist.

**Tech Stack:** No new dependencies (Tailwind, Radix, TanStack Router/Query, Playwright all present). All standing conventions BINDING: server commands via `CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh` from the worktree root, vitest from repo root; ASCII-only sources; NO NodeNext `.js` extensions in `packages/web` (but `e2e/` DOES use them); pure-lib web tests only (no testing-library in this repo — component rendering is proven by e2e); comment discipline; targeted `git add`; Playwright CI-only. Suite at start: 1723 unit + 36 integration + 72 e2e, green. Branch `worktree-phase-6-responsive` from the v0.9.1 manifest commit (1a4bc1d).

**THE HARD REQUIREMENT, binding on every task:** the desktop experience must not change. The existing 72 e2e tests run at the current viewport and must pass UNCHANGED — not adjusted, not re-baselined. If a task cannot achieve its goal without altering desktop behaviour, that is a finding to report, not a licence.

**File structure (locked in here):**

| File | Responsibility |
|---|---|
| `packages/web/src/styles.css` + `packages/web/src/lib.ts` | the one breakpoint constant, shared. **CORRECTED:** this plan's first draft named `tailwind.config.*`; no such file exists and none should — Tailwind v4 is CSS-first (`tailwindcss ^4` + `@tailwindcss/vite`), so the stylesheet IS the config. |
| `packages/web/src/use-is-mobile.ts` (new) + its test | the hook, over `matchMedia` |
| `packages/web/src/components/shell.tsx` | sidebar above the breakpoint, bottom bar below |
| `packages/web/src/components/bottom-nav.tsx` (new) + `nav-lib.ts` (new) | the bar, the More sheet, the primary/overflow split (pure, tested) |
| `packages/web/src/components/entity-table.tsx` | table above, cards below |
| `packages/web/src/components/ui/*` | dialog/drawer → sheet below the breakpoint; touch targets |
| `packages/web/src/pages/inbox.tsx` | the drill-in stack |
| `packages/web/src/pages/board.tsx` + `board-lib.ts` (new) | the stage view and the move-target list (pure, tested) |
| `packages/web/src/components/gantt/*` | read-only below the breakpoint; tap → drawer |
| `e2e/mobile.spec.ts` (new) | the phone-viewport journeys |

---

### Task 1: The breakpoint, the hook, and the shell

**Files:** the Tailwind config, `packages/web/src/lib.ts`, `use-is-mobile.ts` (new) + test, `components/shell.tsx`, `components/bottom-nav.tsx` (new), `components/nav-lib.ts` (new) + test.

One breakpoint constant, defined once and consumed by BOTH the Tailwind config and the hook — the hook builds its `matchMedia` query from the same value, so CSS and JS cannot disagree. Pick the value deliberately and comment the choice (Tailwind's own `md` at 768px is the obvious candidate; a phone in landscape is the case to think about).

`useIsMobile()`: `matchMedia` + subscription, SSR-safe default, no resize-listener polling. Test the pure part (the query string it builds, and the state mapping) — the browser half is e2e's.

`shell.tsx`: above the breakpoint, byte-identical behaviour to today. Below it, the sidebar is gone and a **bottom tab bar** carries Mail, Companies, Contacts, My Tasks + **More** (a sheet with Pipelines, Projects, Gantt, Settings). Mail keeps its unread badge. The header keeps the app name and puts global search behind an icon opening a sheet. `nav-lib.ts` holds the primary/overflow split as a pure function with a test — the spec fixes the four, so the test pins them.

Touch targets on the bar and the sheet reach 44px. `data-testid`s: `bottom-nav`, `bottom-nav-more`, `more-sheet`, `nav-<destination>` (reuse existing nav testids if any exist — check first).

~10 tests. **Desktop e2e must pass unchanged.**

> **DONE** (commits 59b9006 + this review round; spec review compliant-with-issues, NO correctness defect in the shell itself -- the one behavioural finding was in the search sheet's dismissal and is fixed here, the rest were comments that claimed more than was true). As built:
>
> - **The breakpoint: `MOBILE_BREAKPOINT = "48rem"`** in `lib.ts`, declared on the CSS side as `@theme { --breakpoint-md: 48rem; }` in `styles.css`. **There is no `tailwind.config.*` and none should exist** -- Tailwind v4 is CSS-first, so the stylesheet IS the config (this plan's file table now says so). 48rem is Tailwind's own `md` default, and the package had **zero `md:` utilities**, so the declaration is inert: the reviewer built the package and confirmed it adds one custom property and clobbers no default breakpoint. Spelled in `rem`, not px, because `rem` in a media query resolves against the browser's INITIAL font size and `matchMedia` evaluates it by the same rule -- so the two halves agree at every user font-size setting, which a px constant paired with rem breakpoints would not.
> - **The landscape case, corrected.** Portrait phones (430px at the widest) are below the breakpoint and are the case the phone UI is for; that is what settles the value. A phone in LANDSCAPE (844px+) is above it and keeps the sidebar -- a consequence of the width, **not a claim that the sidebar fits there**. It does not: measured 384px tall (68px title + 8 rows x 36px + 7 x 4px gaps) against roughly 345-350px of landscape viewport height, with no `overflow-y` on the aside and `flex min-h-screen` on the root, so the DOCUMENT scrolls on the axis landscape has none of and `<main>`'s scroll region loses its bottom off-screen; those rows are also 36px touch targets on a touch device. **Ruling: 48rem stands** (conventional, portrait covered, iPad portrait correctly keeps the sidebar, desktop e2e viewport safely above). The remedy is Task 2's and is recorded in its paragraph; `lib.ts`'s comment now says all of this rather than the original claim that the sidebar costs only width.
> - **The hook** (`use-is-mobile.ts`): `useSyncExternalStore` over a `MediaQueryList` `change` subscription -- no resize polling, no first-paint flash, React owns the subscription's lifetime. Three pure exports carry everything testable: `mobileMediaQuery(breakpoint?)`, `readIsMobile(query|null)` (null maps to DESKTOP, i.e. the app as it was), `subscribeToMediaQuery(query|null, onChange)` (null subscribes to nothing and still returns a safe cleanup). The query is `not all and (min-width: 48rem)` -- **the exact complement** of the condition `md:` compiles to, chosen over the `max-width: 47.99rem` idiom precisely because that idiom leaves a hundredth-of-a-pixel band (reachable by browser zoom or a scaled display) where the CSS and the JS would disagree about which half of the app the user is in.
> - **The shell branches in JS, not CSS**, so the two navigations are MUTUALLY EXCLUSIVE IN THE DOM rather than one being hidden by a class. That is load-bearing, not stylistic: the reviewer counted **roughly ten existing e2e selectors** (`unread-badge` in mail.spec, `search-input` across crm/pipeline/meetings/mail/tasks) that would have hit Playwright strict-mode violations against two rendered copies. Above the breakpoint every branch resolves to what the file rendered before, class strings included -- verified in a browser at 1280px (same 224px aside, same aside class string, `<main>` with exactly `flex-1 overflow-auto px-6 py-6`, exactly one `search-input`), and independently pinned by `e2e/tasks.spec.ts:87`, which hard-codes the 224px sidebar in its viewport arithmetic and still passes.
> - **The split** (`nav-lib.ts`, pure): bar = Mail, Companies, Contacts, My Tasks; More sheet = Pipelines, Projects, Gantt, Settings. `splitNav` orders by MEMBERSHIP not position, sends an unknown destination to overflow rather than dropping it, and partitions exactly (the property the "nothing is desktop-only" promise rests on). `isNavDestinationActive` is segment-aware -- `/companies/<id>` lights Companies, `/companies-archive` does not -- and gives Settings its `/settings` prefix so both its tabs read as current; `isAnyNavDestinationActive` lights More for anything in its sheet.
> - **Testids.** Added: `bottom-nav`, `bottom-nav-more`, `more-sheet`, `more-sheet-close`, `nav-mail`, `nav-companies`, `nav-contacts`, `nav-my-tasks`, `nav-pipelines`, `nav-projects`, `nav-gantt`, `nav-settings`, `open-search`, `search-sheet`, `search-sheet-close`. Reused unchanged: `unread-badge` (now on the bar's Mail tab below the breakpoint), `shell`, `global-search`/`search-input`. Checked first: **no e2e test navigates by clicking a nav link today** -- every journey uses `page.goto` -- and the sidebar carried no per-destination testids to reuse.
> - **Sheets close themselves after the thing they exist for.** The review caught the search sheet swallowing its own primary action: `shape="full"` is `fixed inset-0` with no outside to click and no keyboard to press Escape with, so tapping a result navigated BEHIND the sheet and left the user looking at their own query. `GlobalSearch` now takes an optional `onNavigate` (the desktop header passes nothing and is unchanged) and the sheet passes its dismiss. The contract is written into `Sheet`'s doc comment: anything inside a sheet that can navigate must close it, because Radix cannot see a navigation inside its own content.
> - **The anti-drift pin, mutation-verified in BOTH directions.** `use-is-mobile.test.ts` reads `styles.css` and asserts the declared `--breakpoint-md` equals the constant: moving the CSS value alone fails it, and moving the TS value alone fails it (both run, both observed red, both restored). The nav guard reads `shell.tsx` and compares every sidebar `to="/..."` against `NAV_DESTINATIONS`, and a third guard asserts `bottom-nav.tsx` never renders `GlobalSearch` without `onNavigate` (also mutation-verified red). **Both source-reading guards match a SPELLING, not a behaviour** -- a sidebar entry written as `to={ROUTES.x}` or as a plain `<a href>` slips past silently -- and their doc comments now say so, because a false sense of the phase's central promise is worse than none.
> - **Tests:** +22 on the 1723 baseline -> **1745** unit + 36 skipped, green on the server; typecheck clean on five projects; `npm run build` clean; **e2e 72 -> 72, unchanged** (no e2e file touched in either commit). One caveat worth not over-reading later: "byte-identical" holds for the desktop DOM and for the class strings, but the built stylesheet does gain that one inert custom property.
>
> **HANDOFFS.** Three items this task measured but could not fix from its own files were carried into **Task 2's paragraph above** (the landscape sidebar's missing `overflow-y`, `ui/input.tsx`'s 38px against the 44px floor and why it needs a `max-md:` variant rather than a bare `min-h-11`, and `env(safe-area-inset-*)` evaluating to 0px for want of `viewport-fit=cover`); the one place the bar's no-z-index argument does not hold went into **Task 5's** (the Gantt's non-portalled sticky `z-20`/`z-30`). They are recorded there rather than repeated here. What remains for everyone: **the hook has two sanctioned sites left** -- the inbox drill-in (Task 3) and the kanban stage view (Task 4) -- and everything else is `md:`. **Do not give the bottom bar a z-index**; it has none deliberately, so portalled overlays paint above it by DOM order. `Sheet` currently lives in `bottom-nav.tsx` because `components/ui` belongs to Task 2 -- promote it there when the dialog primitives become sheets, and let this file import it. `<main>` reserves 6rem at the bottom below the breakpoint, which Task 3 should note: `inbox.tsx`'s only height constraint is `lg:h-[calc(100vh-11rem)]`, above the breakpoint and untouched, so the phone stack has none yet. And one environment fact that costs an afternoon to rediscover: **the browser pane's CDP viewport and `prefers-color-scheme` emulation updates `matches` but never dispatches `change`** to a MediaQueryList, so live breakpoint flips cannot be observed there at all -- a plain page-registered listener gets zero events too. The subscription was proven instead by temporarily substituting a controllable store and watching React swap the shell both ways with exactly one listener retained.
>

### Task 2: The mechanical sweep — lists, forms, dialogs, touch targets

**Files:** `components/entity-table.tsx`, `components/ui/dialog.tsx` + `drawer`/`sheet` equivalents, `components/task-drawer.tsx`, the list pages (`companies`, `contacts`, `projects`, `pipelines`, `my-tasks`), the form-bearing components.

- Entity tables become **stacked cards below the breakpoint** (headers carry no meaning at that width). One change in the shared component, not five in the pages, if the component allows it — say so if it does not.
- **Forms single-column**, inputs full-width.
- **Dialogs and drawers become full-height sheets** below the breakpoint (task drawer, composer, link panel, meeting form). Prefer one change in the shared UI primitive over per-caller changes.
- **Touch targets ≥44px** below the breakpoint for icon buttons, tab triggers, list rows, menu items.
- **The record rail's five tabs must survive a narrow width** — check what they do today at 375px and fix if they overflow or truncate illegibly.
- **INHERITED FROM TASK 1 (its review measured these; they are yours because they live in files Task 1 could not touch):**
  - **The sidebar does not fit a landscape phone.** Measured 384px tall (68px title + 8 rows x 36px + 7 gaps) against roughly 345-350px of viewport on a 14 Pro in landscape, which sits ABOVE the breakpoint and so keeps the sidebar by design. The `<aside>` has no `overflow-y` and the root is `flex min-h-screen`, so the whole document scrolls vertically — on the one axis landscape has none of. Cheap, desktop-safe remedy: `max-lg:overflow-y-auto` on the aside. Also note those nav rows are 36px touch targets on a touch device above the breakpoint.
  - **`ui/input.tsx` computes to 38px**, not 44. Task 1 deliberately left it because that primitive is yours AND it is the same element as the desktop header's search box, so a bare `min-h-11` would grow the desktop input and break the hard requirement. A `max-md:` variant IS desktop-safe — that is the shape to use.
  - **`env(safe-area-inset-bottom)` currently evaluates to 0px everywhere**, because `packages/web/index.html`'s viewport meta has no `viewport-fit=cover`. The bottom bar's reservation is correct by accident (the browser reserves the home-indicator strip itself). Adding `viewport-fit=cover` is a real change with top/left/right consequences — decide it deliberately or leave it and let Task 1's corrected comment stand.

Pure-lib tests where logic appears; otherwise this task is proven by Task 6's e2e and by the desktop suite staying green. ~6 tests.

### Task 3: The inbox drill-in stack

**Files:** `packages/web/src/pages/inbox.tsx`, and whatever pane components need a `back` affordance.

Below the breakpoint the three-pane grid becomes **folders → threads → conversation, one at a time**, with back navigation at each level. This is the second `useIsMobile()` site. Above the breakpoint the existing grid is untouched.

Everything must stay reachable: bulk selection, the folder picker, Hide/Archive/Trash, the composer, Show-earlier. The selection already lives in the URL (`?thread=`), so lean on that rather than inventing parallel state — check how `inbox.tsx` holds its selection before designing the stack.

Watch for: the accumulator/`pages.key` guards Phase 5 and v0.9.1 touched; the conversation's `conversation-gone` state; SSE invalidations arriving while a pane is off-screen. ~8 tests (pure-lib for the stack's state machine).

### Task 4: The kanban stage view

**Files:** `packages/web/src/pages/board.tsx`, `board-lib.ts` (new) + test.

Below the breakpoint: a **stage picker**, the chosen stage's deals as a list, and **"Move to..."** on each card offering the other stages. This is the third and LAST `useIsMobile()` site. Deal creation stays available; the funnel/summary stays legible or collapses behind a disclosure.

The move must go through the **existing** deal-move service path — never a second one — so the compactor, SSE and optimistic-update behaviour are unchanged. `board-lib.ts` holds the move-target list (pure, tested: the current stage is excluded, order matches the pipeline, an archived pipeline offers none).

Above the breakpoint the board is untouched — including its drag-and-drop. ~8 tests.

### Task 5: The Gantt, read-only on a phone

**Files:** `packages/web/src/components/gantt/*`.

Below the breakpoint the chart renders **read-only with pan and zoom**, and **tapping a bar opens the task drawer** (where dates and dependencies are both editable — this is what makes the phase's no-capability-gap claim true, so verify it end to end rather than assuming).

**A drag must not appear to start.** If touch drag is unsupported, the bar must not show a drag affordance or move under the finger and snap back — that is worse than a plain tap target.

**INHERITED FROM TASK 1's review:** the Gantt's own `sticky` elements carry `z-20`/`z-30` (`gantt/chart.tsx:240,242`; `gantt/timescale.tsx:82,136`) and are NOT portalled. `<main>` is not a stacking context (`overflow-auto` alone does not create one), so they participate in the root stacking context above the bottom bar's `z-index: auto` and can paint OVER it — the bar's bottom padding keeps ordinary content clear but not these. Every other overlay in the app is portalled to the end of `<body>` and lands above the bar for free; the Gantt is the exception.

Above the breakpoint, unchanged: drag-to-reschedule, dependency editing, the compactor. ~6 tests.

### Task 6: Phone-viewport e2e + release prep (v0.10.0)

**Files:** `e2e/mobile.spec.ts` (new), three package.jsons, `manifest.toml`, server lockfile.

The journeys, at a phone viewport via Playwright device emulation — these ARE the definition of done expressed as tests: navigate via the bottom bar AND the More sheet; look up a company and read its rail; read a mail thread through the drill-in stack and reply; move a deal between stages via the Move action; open a Gantt bar's task drawer and change its dates; log a meeting and add a follow-up task.

Reuse the suite's conventions: `runId` + per-attempt `${runId}x${testInfo.retry}` fixtures, loaded sentinels rather than bare absences, `typeIntoEditor` from `e2e/helpers.ts` for any rich-text field. **The existing 72 desktop tests must pass unchanged.**

Release prep: bump 0.10.0 (three package.jsons + manifest `0.10.0~ynh1`), regenerate the server lockfile (diff must be versions-only), push, confirm CI green on the FINAL tip, and prepare `release-notes-v0.10.0.md` + `release-sequence-v0.10.0.md` in the session scratchpad. **The sequence must reuse v0.9.1's corrected shape** — the digest step greps `[0-9a-f]{64}` (not the word `sha256sum`), the published asset is downloaded and re-hashed as a non-optional cross-check, the hand-written notes are put on the release explicitly, and the close-out covers the branch, the worktree and pulling `main` in the primary checkout. Do NOT merge, tag, or touch the manifest sha — the coordinator gates the release, and for this phase the gate waits for Chris to try it on his actual phone.

---

Sequencing: 1 first (everything depends on the breakpoint and the hook). 2, 3, 4, 5 are independent of each other and each depends only on 1 — but they must run ONE AT A TIME, not concurrently: they share a worktree and a dev server, and a v0.9.1 review found a concurrent agent's work-in-progress contaminating another's server runs. 6 last. Each task: implement → adversarial spec review → quality review, the standing loop.
