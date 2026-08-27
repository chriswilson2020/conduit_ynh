# Conduit Phase 6 — Responsive / mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Every capability the CRM offers reachable from a phone, with no surface a dead end and no change to the desktop experience — released as v0.10.0.

**Architecture:** One breakpoint constant shared between the Tailwind config and a single `useIsMobile()` hook. Tailwind breakpoints do all LAYOUT work; the hook is used at exactly THREE sites where the interaction model differs (bottom navigation, inbox drill-in, kanban stage view). Spec: `docs/superpowers/specs/2026-08-27-conduit-phase-6-responsive-design.md` — the authority; its Definition of done is the completeness checklist.

**Tech Stack:** No new dependencies (Tailwind, Radix, TanStack Router/Query, Playwright all present). All standing conventions BINDING: server commands via `CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh` from the worktree root, vitest from repo root; ASCII-only sources; NO NodeNext `.js` extensions in `packages/web` (but `e2e/` DOES use them); pure-lib web tests only (no testing-library in this repo — component rendering is proven by e2e); comment discipline; targeted `git add`; Playwright CI-only. Suite at start: 1723 unit + 36 integration + 72 e2e, green. Branch `worktree-phase-6-responsive` from the v0.9.1 manifest commit (1a4bc1d).

**THE HARD REQUIREMENT, binding on every task:** the desktop experience must not change. The existing 72 e2e tests run at the current viewport and must pass UNCHANGED — not adjusted, not re-baselined. If a task cannot achieve its goal without altering desktop behaviour, that is a finding to report, not a licence.

**File structure (locked in here):**

| File | Responsibility |
|---|---|
| `packages/web/tailwind.config.*` + `packages/web/src/lib.ts` | the one breakpoint constant, shared |
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

### Task 2: The mechanical sweep — lists, forms, dialogs, touch targets

**Files:** `components/entity-table.tsx`, `components/ui/dialog.tsx` + `drawer`/`sheet` equivalents, `components/task-drawer.tsx`, the list pages (`companies`, `contacts`, `projects`, `pipelines`, `my-tasks`), the form-bearing components.

- Entity tables become **stacked cards below the breakpoint** (headers carry no meaning at that width). One change in the shared component, not five in the pages, if the component allows it — say so if it does not.
- **Forms single-column**, inputs full-width.
- **Dialogs and drawers become full-height sheets** below the breakpoint (task drawer, composer, link panel, meeting form). Prefer one change in the shared UI primitive over per-caller changes.
- **Touch targets ≥44px** below the breakpoint for icon buttons, tab triggers, list rows, menu items.
- **The record rail's five tabs must survive a narrow width** — check what they do today at 375px and fix if they overflow or truncate illegibly.

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

Above the breakpoint, unchanged: drag-to-reschedule, dependency editing, the compactor. ~6 tests.

### Task 6: Phone-viewport e2e + release prep (v0.10.0)

**Files:** `e2e/mobile.spec.ts` (new), three package.jsons, `manifest.toml`, server lockfile.

The journeys, at a phone viewport via Playwright device emulation — these ARE the definition of done expressed as tests: navigate via the bottom bar AND the More sheet; look up a company and read its rail; read a mail thread through the drill-in stack and reply; move a deal between stages via the Move action; open a Gantt bar's task drawer and change its dates; log a meeting and add a follow-up task.

Reuse the suite's conventions: `runId` + per-attempt `${runId}x${testInfo.retry}` fixtures, loaded sentinels rather than bare absences, `typeIntoEditor` from `e2e/helpers.ts` for any rich-text field. **The existing 72 desktop tests must pass unchanged.**

Release prep: bump 0.10.0 (three package.jsons + manifest `0.10.0~ynh1`), regenerate the server lockfile (diff must be versions-only), push, confirm CI green on the FINAL tip, and prepare `release-notes-v0.10.0.md` + `release-sequence-v0.10.0.md` in the session scratchpad. **The sequence must reuse v0.9.1's corrected shape** — the digest step greps `[0-9a-f]{64}` (not the word `sha256sum`), the published asset is downloaded and re-hashed as a non-optional cross-check, the hand-written notes are put on the release explicitly, and the close-out covers the branch, the worktree and pulling `main` in the primary checkout. Do NOT merge, tag, or touch the manifest sha — the coordinator gates the release, and for this phase the gate waits for Chris to try it on his actual phone.

---

Sequencing: 1 first (everything depends on the breakpoint and the hook). 2, 3, 4, 5 are independent of each other and each depends only on 1 — but they must run ONE AT A TIME, not concurrently: they share a worktree and a dev server, and a v0.9.1 review found a concurrent agent's work-in-progress contaminating another's server runs. 6 last. Each task: implement → adversarial spec review → quality review, the standing loop.
