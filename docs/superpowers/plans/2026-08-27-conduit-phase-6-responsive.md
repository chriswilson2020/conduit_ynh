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

> **DONE** (commits 59b9006 + 97b209a + this quality round; spec review compliant-with-issues, quality review with-fixes -- NO correctness defect in either. The spec round's one behavioural finding was the search sheet's dismissal; the quality round's were an accessibility gap, an opening-focus gap, a build warning and two guards that did not guard what this file claimed. The quality reviewer also confirmed the hook is sound under concurrent rendering, leaks nothing across repeated crossings, and that all three kill-mutations it attempted died). As built:
>
> - **The breakpoint: `MOBILE_BREAKPOINT = "48rem"`** in `lib.ts`, declared on the CSS side as `@theme { --breakpoint-md: 48rem; }` in `styles.css`. **There is no `tailwind.config.*` and none should exist** -- Tailwind v4 is CSS-first, so the stylesheet IS the config (this plan's file table now says so). 48rem is Tailwind's own `md` default, and the package had **zero `md:` utilities**, so the declaration is inert: the reviewer built the package and confirmed it adds one custom property and clobbers no default breakpoint. Spelled in `rem`, not px, because `rem` in a media query resolves against the browser's INITIAL font size and `matchMedia` evaluates it by the same rule -- so the two halves agree at every user font-size setting, which a px constant paired with rem breakpoints would not.
> - **The landscape case, corrected.** Portrait phones (430px at the widest) are below the breakpoint and are the case the phone UI is for; that is what settles the value. A phone in LANDSCAPE (844px+) is above it and keeps the sidebar -- a consequence of the width, **not a claim that the sidebar fits there**. It does not: measured 384px tall (68px title + 8 rows x 36px + 7 x 4px gaps) against roughly 345-350px of landscape viewport height, with no `overflow-y` on the aside and `flex min-h-screen` on the root, so the DOCUMENT scrolls on the axis landscape has none of and `<main>`'s scroll region loses its bottom off-screen; those rows are also 36px touch targets on a touch device. **Ruling: 48rem stands** (conventional, portrait covered, iPad portrait correctly keeps the sidebar, desktop e2e viewport safely above). The remedy is Task 2's and is recorded in its paragraph; `lib.ts`'s comment now says all of this rather than the original claim that the sidebar costs only width.
> - **The hook** (`use-is-mobile.ts`): `useSyncExternalStore` over a `MediaQueryList` `change` subscription -- no resize polling, no first-paint flash, React owns the subscription's lifetime. Three pure exports carry everything testable: `mobileMediaQuery(breakpoint?)`, `readIsMobile(query|null)` (null maps to DESKTOP, i.e. the app as it was), `subscribeToMediaQuery(query|null, onChange)` (null subscribes to nothing and still returns a safe cleanup). The query is `not all and (min-width: 48rem)` -- **the exact complement** of the condition `md:` compiles to, chosen over the `max-width: 47.99rem` idiom precisely because that idiom leaves a hundredth-of-a-pixel band (reachable by browser zoom or a scaled display) where the CSS and the JS would disagree about which half of the app the user is in.
> - **The shell branches in JS, not CSS**, so the two navigations are MUTUALLY EXCLUSIVE IN THE DOM rather than one being hidden by a class. That is load-bearing, not stylistic: the reviewer counted **roughly ten existing e2e selectors** (`unread-badge` in mail.spec, `search-input` across crm/pipeline/meetings/mail/tasks) that would have hit Playwright strict-mode violations against two rendered copies. Above the breakpoint every branch resolves to what the file rendered before, class strings included -- verified in a browser at 1280px (same 224px aside, same aside class string, `<main>` with exactly `flex-1 overflow-auto px-6 py-6`, exactly one `search-input`), and independently pinned by `e2e/tasks.spec.ts:87`, which hard-codes the 224px sidebar in its viewport arithmetic and still passes.
> - **The split** (`nav-lib.ts`, pure): bar = Mail, Companies, Contacts, My Tasks; More sheet = Pipelines, Projects, Gantt, Settings. `splitNav` orders by MEMBERSHIP not position, sends an unknown destination to overflow rather than dropping it, and partitions exactly (the property the "nothing is desktop-only" promise rests on). `isNavDestinationActive` is segment-aware -- `/companies/<id>` lights Companies, `/companies-archive` does not -- and gives Settings its `/settings` prefix so both its tabs read as current; `isAnyNavDestinationActive` lights More for anything in its sheet.
> - **Testids.** Added: `bottom-nav`, `bottom-nav-more`, `more-sheet`, `more-sheet-close`, `nav-mail`, `nav-companies`, `nav-contacts`, `nav-my-tasks`, `nav-pipelines`, `nav-projects`, `nav-gantt`, `nav-settings`, `open-search`, `search-sheet`, `search-sheet-close`. Reused unchanged: `unread-badge` (now on the bar's Mail tab below the breakpoint), `shell`, `global-search`/`search-input`. Checked first: **no e2e test navigates by clicking a nav link today** -- every journey uses `page.goto` -- and the sidebar carried no per-destination testids to reuse.
> - **Sheets close themselves after the thing they exist for.** The review caught the search sheet swallowing its own primary action: `shape="full"` is `fixed inset-0` with no outside to click and no keyboard to press Escape with, so tapping a result navigated BEHIND the sheet and left the user looking at their own query. `GlobalSearch` now takes an optional `onNavigate` (the desktop header passes nothing and is unchanged) and the sheet passes its dismiss. The contract is written into `Sheet`'s doc comment: anything inside a sheet that can navigate must close it, because Radix cannot see a navigation inside its own content.
> - **The anti-drift pin, mutation-verified in BOTH directions.** `use-is-mobile.test.ts` reads `styles.css` and asserts the declared `--breakpoint-md` equals the constant: moving the CSS value alone fails it, and moving the TS value alone fails it (both run, both observed red, both restored). The nav guard reads `shell.tsx` and compares every sidebar `to="/..."` against `NAV_DESTINATIONS`, and a third guard asserts `bottom-nav.tsx` never renders `GlobalSearch` without `onNavigate` (also mutation-verified red). The sidebar guard was then WIDENED, because the quality review demonstrated two mutations that survived it: renaming `label: "Gantt"` to `"Timeline"` left the sidebar saying Gantt and the sheet saying Timeline with all 14 tests green, and swapping two sidebar `<Link>`s left the sheet's order diverging from the order `nav-lib.ts` claims to copy, also green -- because only the four PRIMARY labels were asserted and the guard sorted both sides. It now compares **target, label AND position**, with the one legitimate divergence (the sidebar's "Inbox" is the bar's "Mail") declared in a `SIDEBAR_LABEL` map instead of hidden by a loose assertion. Both demonstrated mutations were re-run against the widened guard and both now fail it. **Both source-reading guards match a SPELLING, not a behaviour** -- a sidebar entry written as `to={ROUTES.x}` or as a plain `<a href>` slips past silently -- and their doc comments now say so, because a false sense of the phase's central promise is worse than none.
> - **The navigation says "you are here" to a screen reader, not only to a sighted one.** Measured at `/settings/templates`, 375px: the More trigger and the Settings row inside its sheet had `aria-current: null` and conveyed their state by colour alone. The four primary tabs escaped only because TanStack sets `aria-current` itself when ITS match agrees -- so the hole fell exactly where nav-lib deliberately disagrees with TanStack (`match: "/settings"` against `to: "/settings/mail"`) and on the one control that is not a Link. All five now carry the marker, from the SAME rule that picks the colour, via a `currentProps` helper that spreads the attribute or nothing rather than passing `undefined` -- an explicit `undefined` can win over Link's own computed value and would have STRIPPED the marker from the tabs TanStack gets right. Verified after: More reports `true`, the Settings row `page`, everything else nothing; on `/companies/<id>` the Companies tab reports `page`. The desktop sidebar has the same hole and keeps it -- it is pre-existing and desktop has other cues.
> - **The search sheet opens on its own search box.** Radix focuses the first tabbable descendant and the header precedes the content, so opening a full-screen search surface parked focus on Close and announced "Close, button" for a sheet whose entire purpose is typing. `Sheet` now takes an `onOpenAutoFocus` hatch -- exposed rather than hard-coded because Task 2 folds this primitive into `ui/dialog.tsx` and should inherit it -- and the search sheet uses it. Verified: `activeElement` is `search-input`, and Close still returns focus to the trigger with the scroll lock released.
> - **A build warning this task itself introduced, removed.** The previous round's comment named the utility in abbreviated bracket syntax; Tailwind v4 scans source as plain text, does not know a comment from code, emitted it as a real rule, and lightningcss rejected it -- so every build from here, including the v0.10.0 release build, carried a warning that read like a CSS bug. The prose no longer spells a class in brackets, and the constraint is written down where the next person would repeat it. Build is warning-free again.
> - **Tests:** +22 on the 1723 baseline -> **1745** unit + 36 skipped, green on the server; typecheck clean on five projects; `npm run build` clean; **e2e 72 -> 72, unchanged** (no e2e file touched in either commit). One caveat worth not over-reading later: "byte-identical" holds for the desktop DOM and for the class strings, but the built stylesheet does gain that one inert custom property.
>
> **CARRIED, DELIBERATELY NOT FIXED HERE** -- recorded so nobody re-litigates them, and so the next person knows they were seen rather than missed:
>
> - **`shell.tsx:44`'s `inSettings` is a looser rule than the tested one.** It is a bare `startsWith("/settings")`, which `nav-lib`'s segment-aware `isNavDestinationActive` was written to replace; a route named `/settings-export` would light the desktop Settings entry. It stays because it is pre-existing desktop behaviour and this phase may not touch it.
> - **The unread badge is a bare number.** No accessible name (a screen reader reads "7" beside "Mail" and nothing else), no "99+" cap, and `min-width: auto`, so a five-digit count squeezes its neighbouring tabs. Worth a `sr-only` suffix and a cap whenever someone owns that element next.
> - **The `<nav>` has no accessible name.** With one landmark it is survivable; the moment a second `<nav>` exists on a phone page, both need `aria-label`.
> - **`PRIMARY_NAV_IDS` is typed `readonly string[]`**, which erases the literals: a typo in one of the four does not fail typecheck, it silently demotes that tab to the More sheet. Widening `splitNav` to a structural `{ id: string }` is what bought the "an unknown destination goes to overflow" test, and the trade was made knowingly -- but the array itself could be `readonly NavId[]` without losing that.
> - **`ui/input.tsx`'s 38px degrades a Task 1 surface** (the search sheet's own field), not just Task 2's forms. The fix is still Task 2's, for the reason recorded in its paragraph: the element is shared with the desktop header.
>
> **TWO THINGS SETTLED, so they need no further thought:** the old-Safari `addListener` fallback that a `matchMedia` hook usually carries is UNREACHABLE here -- Vite 8's default target is safari16.4+, and a browser without `MediaQueryList.addEventListener` cannot run the bundle at all -- and creating a MediaQueryList per hook call is fine; the browser dedupes the underlying query and the reviewer found no leak across repeated crossings.
>
> **HANDOFFS.** Three items this task measured but could not fix from its own files were carried into **Task 2's paragraph above** (the landscape sidebar's missing `overflow-y`, `ui/input.tsx`'s 38px against the 44px floor and why it needs a `max-md:` variant rather than a bare `min-h-11`, and `env(safe-area-inset-*)` evaluating to 0px for want of `viewport-fit=cover`); the one place the bar's no-z-index argument does not hold went into **Task 5's** (the Gantt's non-portalled sticky `z-20`/`z-30`). They are recorded there rather than repeated here. What remains for everyone: **the hook has two sanctioned sites left** -- the inbox drill-in (Task 3) and the kanban stage view (Task 4) -- and everything else is `md:`. **Do not give the bottom bar a z-index**; it has none deliberately, so portalled overlays paint above it by DOM order. `Sheet` currently lives in `bottom-nav.tsx` because `components/ui` belongs to Task 2 -- promote it there when the dialog primitives become sheets, and let this file import it, **keeping its `onOpenAutoFocus` hatch**: a sheet whose header precedes its content will always open focused on Close unless a caller says otherwise. Task 2's paragraph also carries the warning that the desktop-only nav guard fires on ANY link added to `shell.tsx`, wordmark-as-home-link included. `<main>` reserves 6rem at the bottom below the breakpoint, which Task 3 should note: `inbox.tsx`'s only height constraint is `lg:h-[calc(100vh-11rem)]`, above the breakpoint and untouched, so the phone stack has none yet. And one environment fact that costs an afternoon to rediscover: **the browser pane's CDP viewport and `prefers-color-scheme` emulation updates `matches` but never dispatches `change`** to a MediaQueryList, so live breakpoint flips cannot be observed there at all -- a plain page-registered listener gets zero events too. The subscription was proven instead by temporarily substituting a controllable store and watching React swap the shell both ways with exactly one listener retained.
>

### Task 2: The mechanical sweep — lists, forms, dialogs, touch targets

**Files:** `components/entity-table.tsx`, `components/ui/dialog.tsx`, `components/ui/input.tsx`, `components/task-drawer.tsx`, `components/shell.tsx` (the aside's landscape overflow), the list pages (`companies`, `contacts`, `projects`, `pipelines`, `my-tasks`), the form-bearing components. **CORRECTED:** this plan's first draft named `components/ui/drawer.tsx`; no such file exists — `DrawerContent` lives inside `ui/dialog.tsx`.

**RULING on the Sheet (Task 1's quality review): fold it INTO `ui/dialog.tsx` as a third content variant. Do NOT create a parallel `ui/sheet.tsx`.** `DialogContent`, `DrawerContent` and `Sheet` already repeat an identical `Portal > Overlay > Content` skeleton three times; a separate primitive makes four. Two things to settle while folding: `Sheet` is more opinionated than its neighbours (it takes `title` + `trigger` and builds its own header, where `DialogContent` takes children and lets callers compose) — decide which composition style `ui/` speaks rather than shipping both; and give the folded version an `onOpenAutoFocus` escape hatch, which Task 1 needs and cannot reach.

**WARNING:** `nav-lib.test.ts`'s desktop-only guard scrapes every `to="/..."` in `shell.tsx` and demands exact multiset equality, so ANY link you add to that file — even making the wordmark a link home — fails it with a diff that explains nothing. Scope the scrape to the `<aside>` or to a `data-nav` attribute as part of your shell work, and say so in the comment.

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

> **DONE.** As built, with every measurement below taken in a browser against a build of this branch rather than reasoned about:
>
> - **The Sheet fold.** `ui/dialog.tsx` now holds ONE `Portal > Overlay > Content` skeleton (a private `Overlaid`) and a `SHAPES` table of four complete class strings -- `dialog`, `drawer`, `sheetBottom`, `sheetFull`. `DialogContent`, `DrawerContent` and `SheetContent` are thin wrappers over it, so the count of skeletons went 3 -> 1 while the count of shapes went 3 -> 4. **No `ui/sheet.tsx` exists**, and a test asserts it never does.
> - **The composition style settled: `ui/` speaks COMPOSITION, so the sheet lost its props.** Task 1's `Sheet` took `title` + `trigger` and assembled its own header; every other export in this directory (Dialog/DialogTrigger/DialogContent/DialogTitle, Tabs/TabsList/TabsTrigger) hands the caller pieces. The folded version is `SheetContent` + `SheetHeader` + `SheetBody`, and `bottom-nav.tsx` composes them at both call sites with no local wrapper -- shipping a convenience wrapper there would have been shipping both languages after all. `onOpenAutoFocus` survives because the whole of Radix's Content props are forwarded, and the search sheet was verified still opening focused on `search-input` rather than on Close.
> - **`max-md:` OVERRIDES ON TOP OF THE DESKTOP STRING, not a mobile-first base with `md:` restoring the desk.** The desktop class strings are therefore literally the ones that shipped. The cost is that overrides must be property-for-property (`max-md:left-0` against `left-1/2`, never a blanket `max-md:inset-0`): Tailwind orders the inset shorthand BEFORE the longhands, so only a variant of the SAME utility reliably wins. Verified at 1280px that the dialog is still a 448px card at (416, 309) with 8px radius, 24px padding, `overflow: visible` and a 38px input; at 375px the same element is 375x812 at (0, 0) with no radius and no cap.
> - **A DEAD END THE SWEEP WOULD HAVE CREATED, found and closed.** A dialog that fills a phone has no outside to click, and a phone has no Escape key -- so the two ways a dialog is normally dismissed both vanish at once. **Eight `DialogContent` callers render no Cancel of their own** (the create dialogs on companies, contacts, projects, pipelines, the task board, the company page's two, the deal and the project pages'), and every one would have become exactly the dead end the definition of done forbids. `DialogContent` now renders a `md:hidden` Close above its children -- `display: none` at a desk, so out of the accessibility tree and not a second Cancel for the dialogs that have one. Testid `dialog-close`.
> - **Entity tables -> cards in ONE shared change, not five in the pages.** `ui/table.tsx` turns table/thead/tbody/tr/td into blocks below the breakpoint and `entity-table.tsx` renders each column's heading per cell (`md:hidden`); companies, contacts and projects did not change by a line. Restyling one DOM rather than rendering a table and a card list under `md:hidden`/`hidden md:block` was deliberate: two copies means two elements per `row-<id>` testid, and `crm.spec.ts` addresses those. **What it costs is written down in the file**: changing `display` on a table box drops its table semantics, so below the breakpoint a screen reader stops hearing rows and cells -- intended, since a one-column card list is not a table, and the per-cell labels are what replace the headings.
> - **The rail's five tabs at 375px, measured.** Timeline/Notes/Files/Mail/Meetings have a FIXED 349px intrinsic width -- each label is one unbreakable word, so a trigger cannot shrink below its text. Against `<main>`'s 327px content box that is a 22px spill at 375px (absorbed by the page's right padding, so all five stay on screen by 1.6px); **at 360px and below the spill becomes a horizontal scroll of `<main>` itself and the Meetings tab leaves the screen** -- at 320px, `main.scrollWidth` was 373 against a 320px client. `max-md:overflow-x-auto` on the list plus `max-md:shrink-0` on the triggers; at 320px after, `main.scrollWidth` is 320 and the strip scrolls its own 77px. **IT IS A TRADE AT EXACTLY 375px, not pure gain, and the spec review was right to say so.** Before, the 22px overflowed VISIBLY into the page's right padding, so all five triggers painted and "Meetings" was fully legible. After, the strip is a scroll container clipped at its 327px box: it renders "Meeting" with the last letter cut, over a scrollbar track. Nothing becomes unreachable -- the strip scrolls and the tab is one swipe away -- and everything at or below 360px, where the tab used to leave the screen entirely, is genuinely fixed. **The same 21px spill exists at 1280px** (the rail is 328px there) and is deliberately left alone as pre-existing desktop behaviour.
> - **Touch targets.** The floor is `max-md:min-h-11` on `Button`, `Input`, `Textarea`, `SelectTrigger`, `SelectItem` (plus a centring flex row, or the label sits at the top of the box) and `TabsTrigger`, which covers most of the app through the primitives. Beyond them: the settings area's two route-Link tabs, `entity-picker`'s result rows, `field-card`'s tap-to-edit span (the EDITABLE branch only -- read-only text is not a control), the task drawer's three hand-rolled date/number inputs, the "Archived" checkbox labels on the entity tables and pipelines (the label is the target, not the 13px box), and the chip-remove glyphs in the composer, the link panel and the meeting form (negative margins so the hit box overhangs the chip and the painted glyph does not move). Already at 44px and left alone: the pipelines rows (`py-3` + 20px line). Measured after: filter input, New button, Archived label and tab triggers all exactly 44.
> - **The hand-rolled controls the first pass missed**, all found by the spec review and all floored with the same `max-md:` discipline: `mail/rich-text.tsx`'s Bold/Italic/Bullet toolbar -- **the app's clearest icon buttons, and inside the composer this task turned into a full-screen sheet, the meeting form it stacked, and both settings pages** -- 24x24 and 19.4x24 before, 44x44 after; `settings-mail.tsx`'s folder-picker rows (the label wraps the box AND the folder name, so flooring it makes the whole row tappable); `project-detail.tsx`'s colour swatch, 64x32 -> 64x44, the short axis only since 64 already cleared it; and the four remaining "Archived" checkbox labels (`rail/meetings.tsx`, `company-detail.tsx`, `settings-mail.tsx`, `settings-templates.tsx`), 20px -> 44px, the identical case to the two already done. Measured at 375px after: toolbar 44x44 x3, all three reachable Archived labels 77.8x44, the SMTP-password label 327x44, the colour swatch 64x44. The folder-picker row needs a live IMAP account to render and so was NOT measured in a browser; it carries the same class as the labels that were. Re-checked at 1280 AND at 1000: toolbar back to 24x24 / 19.4x24 / 21.7x24, Archived labels 20px, settings tabs 38px, the dialog still a 448px card at x=416 with its phone Close `display: none`.
> - **Forms.** The five field grids in `settings-mail.tsx` (including the three-column host/port/security rows) collapse to one column; the meeting form's When/Minutes pair stacks; the composer's template select takes its own line. `Input`/`Textarea` were already `w-full`, and the entity tables' filter now drops `max-w-xs` below the breakpoint and takes the first line to itself.
> - **INHERITED 1, the landscape sidebar -- and the proposed remedy was wrong.** `max-lg:overflow-y-auto` ALONE does not fix it, tested: an overflow container still reports its content height as its hypothetical cross size, so the row stayed 384px tall and the document still grew. What works is `max-lg:sticky max-lg:top-0 max-lg:h-screen max-lg:overflow-y-auto` -- the cap is what stops the sidebar setting the row's height, the scroll is what keeps the eighth link reachable once capped, and sticky keeps it in place while `<main>` scrolls past. `h-screen` rather than a dynamic-viewport unit so it matches the root's own `min-h-screen`; a shorter cap would leave a strip of page background under a sidebar meant to reach the bottom. Verified at 844x350: the aside is 350 tall with a 384 scroll height, and at 1280 it is `position: static`, `overflow-y: visible`, 224x826 exactly as before. **The rows inside stay 36px**, deliberately: this is the desktop sidebar, and raising them would also raise them for a 1000px laptop window.
> - **INHERITED 2, `ui/input.tsx`'s 38px:** fixed as `max-md:min-h-11`, and `ui/ui.test.ts` asserts for every primitive both that the floor is there AND that it is not unscoped, since an unscoped one is the mutation that breaks the hard requirement.
> - **INHERITED 3, `viewport-fit=cover`: DECIDED AGAINST.** Without it the layout viewport already stops short of the notch and the home indicator, the browser reserves those strips itself, and every `env(safe-area-inset-*)` is 0px -- so Task 1's reservation is correct and the terms are inert. Adding it moves the layout viewport out under the hardware on ALL FOUR edges, so the header, `<main>`, the bar, the sheets, the drawer's right edge and -- in landscape, which is above the breakpoint and still renders the sidebar -- the sidebar's left edge would each need their own inset. That is a landscape audit on hardware this loop cannot test, bought for no visible gain. The reasoning lives in `shell.tsx` beside the reservation that depends on it, with a pointer from `index.html`, and `use-is-mobile.test.ts` now pins the meta so the day someone adds it they are told which three comments stop being true.
> - **The nav guard, rescoped as warned.** `nav-lib.test.ts` slices `shell.tsx` between `<aside` and `</aside>` before scraping, with sentinel assertions so a sidebar that stops being one aside block fails loudly instead of silently guarding an empty string. Mutation-verified BOTH ways: a link added to the header now passes (it used to fail with a diff that explained nothing), and renaming a sidebar label still fails.
> - **Tests: +12 on the 1745 baseline -> 1757** unit + 36 skipped, green (**and the quality round below added three more, so the commit this task actually hands on carries 1760** -- this line was written before that round and Task 3's spec review caught the stale arithmetic; anyone computing a delta from here should start at 1760); typecheck clean on five projects; `npm run build` clean with **no CSS warning**; no e2e file touched. Eleven of the twelve are `ui/ui.test.ts` (the one skeleton, no parallel sheet file, the props pass-through, the phone dialog's way out, what a caller may tune, the floor on five primitives, the scrolling strip); the twelfth is the viewport-meta pin. Five mutations were run and all behaved: the unscoped floor, the deleted phone Close, `viewport-fit=cover`, the renamed sidebar label (all red) and the header link (green).
>
> **THE QUALITY ROUND, which found the sweep's worst bug in its own primitive.** `ui/button.tsx` took `max-md:min-h-11` and no `max-md:min-w-11`, so a button whose whole label is a glyph stayed as narrow as the glyph. The task drawer's close measured **34.7 x 44** -- and below the breakpoint that drawer is full-screen, so it was the ONLY exit from the surface Task 5 opens from a Gantt bar. The floor is now on both axes (44x44 measured; 34.7x36 at 1280 AND at 1000, i.e. exactly what it always was), and the same button in the drawer's "Task not found" state, which had no `aria-label` at all, has one.
>
> **FOUR OF ELEVEN GUARDS PASSED THE MUTATION THEY ADVERTISED**, which is the more useful finding of the two: a guard scoped to the wrong thing has a guard's shape and none of its substance. All four were re-scoped and all four now fail the mutation that walked through them:
>
> | Mutation | Before | Now | Why it escaped |
> |---|---|---|---|
> | Delete the floor from `SelectTrigger` only | green | **red** | the assertion was FILE-scoped; select.tsx holds two independent controls |
> | Move the tab pairing onto `TabsList` | green | **red** | same, and it un-floors every trigger while re-opening the flex squeeze the pairing exists to prevent |
> | A fourth skeleton as `ui/panel.tsx` | green | **red** | the count ran over dialog.tsx alone, and the "no parallel file" check guarded one literal filename |
> | A caller class after `data-testid` | green | **red** | the regex required `className` to be the FIRST attribute -- likelier now that DialogContent forwards every Radix prop |
>
> Assertions are now scoped to the ELEMENT (each primitive's source sliced from its `export function` to the next), and the tree-wide properties are counted over the tree with the same `walk()` the caller scan already used. **A tripwire went with them**: naming the bare floor utility in a COMMENT used to turn the suite red with `unexpectedly matched` and no file or line, which in a codebase with this comment discipline was a matter of time -- every absence assertion now runs over comment-stripped source, verified by writing exactly that comment and watching the suite stay green.
>
> **Also this round.** `SheetContent` can be composed without `SheetHeader`, which would be an unlabelled Radix dialog with no Close, no Escape and (on the full shape) no outside -- the dead end Task 1's configured `Sheet` made structurally impossible and composition traded away; a guard buys it back, and `closeTestId` is now REQUIRED so a sheet's only exit cannot be unaddressable from e2e. `SheetHeader` gained a `leading` slot for Task 3's Back control, so the drill-in does not have to hand-roll a header and then remember the Title and the Close. The sheet-shape ternary became an exhaustive `Record`, so a third shape is a type error rather than a silent fall back to the bottom sheet. The two sheet entries' shared chrome is named once (the "complete class string" rule is about the PIN, not about retyping the chrome).
>
> **A convention adopted and written down** in the new `ui/touch.ts`: **extract a `max-md:` run to a named constant the moment it appears in a SECOND place.** The chip-remove idiom had been retyped 5 times and the checkbox-label idiom 6, in the same commit that extracted the identical concern locally in `rich-text.tsx`. Both are now single constants; a run only one file uses stays in that file.
>
> **Two comments were measured false and corrected.** A `<button>` centres its own content whatever its `display` is -- measured at 375px, the toolbar buttons are 44x44 with the glyph gaps 15/15 top-to-bottom and equal left-to-right, on `display: block` -- so `rich-text.tsx`'s flex classes were redundant and their stated reason wrong; they are gone. `settings-layout.tsx`'s claim that "a min-height on an inline box does nothing" was wrong for its own reason: those Links are flex ITEMS and already blockified, so the min-height always bit. The flex there stays, because an anchor really does not centre its own text in a taller box -- which is what `select.tsx` says correctly about its menu items, and that one was left alone.
>
> **TWO MORE THINGS MEASURED AND DELIBERATELY NOT FIXED.**
>
> - **Three `DialogContent` width caps are inert at every width, and always were.** Tailwind sorts `max-w-*` ALPHABETICALLY, not by size, so the shape's `.max-w-md` is emitted after `.max-w-2xl` and `.max-w-3xl` and wins in the base layer: at 1280 a dialog carrying `max-w-3xl` computes `max-width: 448px`. So `composer.tsx`, `settings-mail.tsx` and `settings-templates.tsx` have been getting a 448px dialog, not a wide one, since long before this phase. Widening three desktop dialogs is a desktop change and is out of bounds here; `ui/ui.test.ts`'s guard now says which families genuinely tune and which are silently overridden, rather than implying all of them apply.
> - **A phone list row is unreachable to a screen reader.** `<TableRow onClick>` has no role, no accessible name and no tab stop, and below the breakpoint it loses row semantics too (see ui/table.tsx) -- so on the companies list at 375px an assistive-technology user gets an unstructured run of label/value lines with no way to open a company. **Pre-existing**: those rows were keyboard-inert at a desk before this phase, and fixing it properly adds desktop tab stops, which is out of bounds here. It is the largest accessibility gap the phone UI has and it wants a phase-level decision, not a Task 2 patch.
> - **Four smaller things about the card layout**, recorded so the next person does not rediscover them: `colSpan` is inert once the cells are blocks, while `TableCell`'s comment still explains it as the reason for the prop spread; a column whose `render()` returns more than one node gets those nodes spread apart by `justify-between`; a future selection column would become its own full-width row rather than a leading checkbox; and a cell whose value is a link would read better with `items-start` than stretched.
> - **The phone Close is the first tabbable child of every dialog**, so Radix's default opening focus would land on it -- the very bug Task 1 fixed for the search sheet. It does not bite today only because all eight no-Cancel callers `autoFocus` their first input (checked: every one of those files carries at least one) and Radix's FocusScope skips its own autofocus once focus is already inside. Verified live at 375px: the templates dialog opens with `activeElement` an INPUT, not the Close. A dialog added later WITHOUT an autoFocus'd field will open announcing "Close, button", so the dependency is written where the Close is rendered.
>
> **FOUND WHILE MEASURING, NOT MINE TO FIX -- and Task 3 needs it.** `<main class="flex-1 overflow-auto">` does NOT cap the page: the root is `flex min-h-screen`, so its height is indefinite, and a flex container's intrinsic height counts a `flex-grow` child's max-content contribution -- an `overflow: auto` child does not shrink it. So `<main>` only behaves as a scroll container while its content FITS; past that the DOCUMENT scrolls and `<main>` grows with it. Measured at 375x812 on the companies list: `main` is 1089 tall, its own scrollHeight equal to its height, and the document is 1158 against an 812 client. **Task 3's height budget (`<main>` box y69->812, clientHeight 743) is therefore a budget for a pane that fits, not a hard frame**, and a phone pane that wants its own internal scroll has to be given a definite height by something. This is pre-existing at every width (1280x800 gives a 826px document) so changing it -- `h-screen` on the root, say -- would move the desktop's scroll container and is out of bounds here.
>
> **HANDOFFS.** **Task 3:** the mail pane internals (`thread-list`, `folder-sidebar`, `conversation`, `bulk-bar`) were deliberately NOT swept -- their rows are the ones the drill-in stack restructures, and touching their padding now would only collide. Their rows are ~36px today and the 44px floor is yours to apply as you build the stack; `Button`, `Input` and `SelectItem` inside them are already floored. The composer is a full-screen sheet on a phone and carries both a Close and its own Cancel. **`SheetHeader` now takes a `leading` slot** -- put Back there rather than hand-rolling a header, which would mean remembering the Title and the Close yourself, and a guard now fails a `SheetContent` rendered without one. **Task 4:** `board.tsx`'s and `task-board.tsx`'s create dialogs are already phone sheets with a Close; `kanban-core.tsx` and `funnel.tsx` were not touched at all. **Task 5:** the task drawer is a full-screen sheet on a phone and its `field-dates` row wraps to one control per line, so the reschedule path your no-capability-gap claim rests on is usable at 375px -- verified open. **Task 6:** one testid added, `dialog-close`, on every `DialogContent`; it is `display: none` above the breakpoint, so a desktop journey cannot see it and a phone journey can rely on it. The rail strip clips its last tab by 22.4px at rest and `scrollIntoView` reveals it; whether ARROW-KEY focus does could not be settled here (the browser pane reported the document unfocused), so that is an assertion worth adding. `more-sheet-close` and `search-sheet-close` survive the fold unchanged. **Everyone:** the `max-md:`-over-desktop-string convention is written down in `ui/dialog.tsx`'s SHAPES comment -- follow it. **An earlier version of this block gave a FALSE reason for it and the spec review caught it**: the claim was that a variant only beats the base utility of the SAME property, so a blanket `max-md:inset-0` could not beat `left-1/2`. Tailwind does order the inset shorthand first, but only within the base layer, and every `max-md` rule is emitted after that layer ends -- so the blanket form would have worked. Property-for-property is kept because it does not DEPEND on knowing that: it survives a `md:` sibling, a caller's own variant class, and a future Tailwind that emits variants differently. Defensive, not required. The corrected reasoning is in the file; do not carry the old rule forward.

### Task 3: The inbox drill-in stack

**Files:** `packages/web/src/pages/inbox.tsx`, and whatever pane components need a `back` affordance.

Below the breakpoint the three-pane grid becomes **folders → threads → conversation, one at a time**, with back navigation at each level. This is the second `useIsMobile()` site. Above the breakpoint the existing grid is untouched.

Everything must stay reachable: bulk selection, the folder picker, Hide/Archive/Trash, the composer, Show-earlier. The selection already lives in the URL (`?thread=`), so lean on that rather than inventing parallel state — check how `inbox.tsx` holds its selection before designing the stack.

Watch for: the accumulator/`pages.key` guards Phase 5 and v0.9.1 touched; the conversation's `conversation-gone` state; SSE invalidations arriving while a pane is off-screen. ~8 tests (pure-lib for the stack's state machine).

**THE HEIGHT BUDGET, measured by Task 1's quality review at 375x812 — design against these, do not re-derive them.** `<main>` is the scroll container (`overflow: auto`): box y69->812, `clientHeight` 743, padding 24px top / 96px bottom, **content box 623px ending at y=716**, with the bar's top edge at **y=767**. So an `h-full` child clears the bar by 51px — dead space at the bottom of any pane meant to fill the screen, because the 96px reservation sits INSIDE the scroll region rather than under it. **`100vh`/`100dvh` know none of this**: `inbox.tsx`'s existing `lg:h-[calc(100vh-11rem)]` is above the breakpoint and untouched, and that shape must NOT be mirrored below it. Size from `<main>`'s own box or with flex. A pane wanting its own internal scroll must be `h-full overflow-hidden` inside main and inherits the dead band; if that reads badly, the reservation at `shell.tsx` is what moves. `px-6` leaves 327px of content width at 375px (Task 2's to change, but you design against it).

**FROM TASK 2's QUALITY REVIEW — four things about the surfaces you inherit:**
- **"Not swept" is not "unchanged".** The handoff says the mail panes were left for you, but `LinkPanel` renders INSIDE `conversation.tsx` and WAS swept (its unlink glyphs use negative margins that overhang their container's padding, so restructuring that pane's padding lands them differently), and `bulk-bar`, `conversation` and `thread-list` all render `Button`s that are now 44px tall below the breakpoint. **Re-measure; do not inherit the handoff's geometry.**
- **`SheetHeader` has NO slot for a Back button** — its signature is `{title, closeTestId}`. A drill-in level built as a sheet must hand-roll its header, and then must supply its own `Dialog.Title` AND `Close`, because `SheetContent` guarantees neither. (Task 2's round is adding a leading slot for exactly this; check what shipped before hand-rolling.)
- **Two different full-screen phone modals now exist**: `DialogContent`'s phone form (`p-6`, in-flow text Close, caller's own `DialogTitle`) and `sheetFull` (bordered title bar, scrolling body). The composer is the first, the search sheet the second. Pick deliberately and say why.
- The `EntityTableColumn.render` cell assumes exactly two children; anything else gets spread by `justify-between`.

**QUALIFIED BY TASK 2 — read this before using the numbers above.** `<main class="flex-1 overflow-auto">` does NOT cap the page. The root is `flex min-h-screen`, so its height is indefinite, and a flex container's intrinsic height counts a `flex-grow` child's max-content contribution — an `overflow:auto` child does not shrink it. `<main>` therefore behaves as a scroll container only while its content FITS; past that the document scrolls and `<main>` grows with it (measured at 375x812 on the companies list: `main` 1089 tall, scrollHeight equal to its height, document 1158 against an 812 client). **So the budget above is a budget for a pane that fits, not a hard frame.** A phone pane wanting its own internal scroll must be given a definite height by something — do not assume `h-full` inside `<main>` bounds you. This is pre-existing at every width (1280x800 gives an 826px document), so FIXING it would move the desktop's scroll container and is out of bounds for this phase; work within it or report.

> **DONE** (commits ba5f680 + the spec-review round + this quality round; spec
> review compliant-with-issues, quality review with-fixes -- NO correctness
> defect in either. The spec round verified the hard requirement live at 1280
> through a tunnel, upheld the hide-don't-unmount decision on all three counts,
> and found the one mechanism that could have falsified it -- Load-more being
> an IntersectionObserver rather than a button -- and confirmed it is not; its
> findings were an unacknowledged focus cost, a comment asserting a branch that
> does not fire, and a dead cross-task API carrying a false comment. The
> quality round confirmed the state machine is total over all 16 combinations,
> that the matrix test is a real cross-product rather than a sample, that
> `hasFolderRail` cannot desync from the rail's own null condition, and that
> the hidden-pane cost is bounded (Conversation only mounts when `selectedId`
> is set, so there is no invisible refetch at the folders level); its findings
> were an EVADABLE comment stripper, an untied level-to-pane seam, a focus
> target that could not fire for the case it named, and four smaller things.
> All are fixed below). As built:
>
> - **THE STACK'S SHAPE: three screens, with the THREAD LIST AS THE HUB rather
>   than as the middle of a strict line.** folders <-> threads <-> conversation,
>   one at a time. The hub is where the Mail tab lands (an inbox that opened on
>   a folder list would cost every visit a tap), and both neighbours are one
>   control away in each direction: `inbox-folders` goes out to the rail,
>   `inbox-back` returns from either side. What satisfies "no surface is a dead
>   end" is that **every level has a way BACK** -- not that every level has a
>   leading control, which an earlier version of this block said and which is
>   not the distinction: the hub HAS a leading control, it just points forward.
>   The hub needs no way back because it is the screen the bottom bar itself
>   always reaches, and it is the only level that can be without one.
> - **WHERE THE STATE LIVES: the URL, plus exactly one boolean.** The
>   conversation level is DERIVED from `?thread=`, so opening a thread IS the
>   navigation to its screen -- no second gesture to keep in step, and a deep
>   link lands on the right screen with no effect to fix it up. Only the folder
>   screen needed state (`foldersOpen`), because nothing in the URL implies it.
>   `pages/inbox-lib.ts`'s `inboxStackView` turns the pair into level, title,
>   leading control and which panes, and returns the UNCHANGED DESKTOP VIEW for
>   every input above the breakpoint -- so the phase's hard requirement is an
>   assertion in the unit suite rather than a hope. A deep-linked thread beats a
>   folder screen left open (the only way to hold both is arriving from global
>   search or a record's Mail tab, and a link that landed on a folder list would
>   be a broken link); Back clears both.
> - **THE LOAD-BEARING DECISION: the stack HIDES panes, it does not unmount
>   them.** The same three panes render in the same grid; only `display`
>   changes. Unmounting the list to show a conversation would have thrown away
>   the accumulated "Load more" pages, dropped its query observer so an SSE
>   invalidation arriving while the reader is in a conversation refetches
>   nothing, and left the page holding `rows` the unmount never retracted -- a
>   bulk bar counting rows no longer listed. Verified live at 375 with a
>   36-thread fixture: **36 rows before opening a thread, 36 while it is open,
>   36 after Back**, with "Load more" correctly gone.
> - **THE COST OF THAT, MEASURED AND PAID (the spec review's main finding, then
>   corrected by the quality round).** Hiding the subtree holding the focused
>   element drops focus to `<body>`: focus `filter-unread`, drill into a
>   conversation, and `activeElement` was BODY -- on every drill-in, and again
>   on a Back that leaves the leading control unrendered. This was the THIRD
>   instance of the class in this phase (Task 1's search sheet opening on
>   Close, Task 2's `dialog-close` hazard).
> - **FOCUS GOES TO THE HEADING, ALWAYS -- the first fix went to the leading
>   control and DID NOT WORK, which is worth recording because it is invisible
>   from outside.** With a rail, Back and Folders are the SAME Button
>   relabelled: React reconciles it in place, so `leadingRef.current` is the
>   same DOM node across folders->threads, and `focus()` on the element that
>   already has focus does nothing -- no event, no re-announcement. The case
>   that most needed a deliberate move was precisely the one that approach
>   could not fix, and measuring `activeElement` afterwards could not tell
>   "moved here" from "never left". **Measured directly:** park focus on
>   `inbox-back` at the folders level, click it, and
>   `relabelledButton === theNodeFocusedBefore` is **true** while its label is
>   now "Folders". The heading is better on every axis: it genuinely moves
>   (`focusStayedOnIt: false`), it announces the DESTINATION ("Conversation,
>   heading level 1") rather than the exit ("Back, button"), and it costs a
>   keyboard user nothing since the heading sits between the two buttons.
>   `leadingRef`, the `??` fallback and the whole `ButtonProps.ref` addition
>   are deleted -- `ui/button.tsx` is byte-identical to its pre-Task-3 state.
>   **Re-measured, all five transitions:** threads->conversation, Back to
>   threads, threads->folders, folders->threads (the relabel case, with focus
>   parked on the control), and Back with no rail -- every one lands on the
>   `h1` carrying the destination's own name ("Conversation" / "Inbox" /
>   "Folders"), `tabindex="-1"`. Every one was BODY before the fix. The effect
>   keys on the LEVEL alone, deliberately: keying on the leading control's kind
>   as well would cover the rail appearing or vanishing without a level change,
>   at the cost of a focus jump on every phone visit (the rail is absent for
>   the render before the accounts query resolves, so focus would land on the
>   heading and hop a moment later). The uncovered case is now handled by the
>   latch cleanup below instead.
> - **THE 44px FLOOR ON THE MAIL PANES, which Task 2 deliberately left -- and
>   the handoff's geometry was wrong.** Measured before: folder rows **28**
>   (not the "~36" the handoff carried), the select-all label **24**, the
>   attachment chip **24**. Thread rows (98.5) and message headers (54-70) were
>   already over the floor. **The most important correction is the row
>   checkbox: its short axis is its WIDTH, 32px, not its height** -- the
>   handoff's "rows are ~36px" framing would have led to flooring the height
>   (already 98.5, so a no-op) and leaving a 32px target on the gesture that
>   starts a bulk selection. Fixed with a min-width, so the painted checkbox
>   does not move and the row starts 12px further in (293 -> 281). `LinkPanel`'s
>   unlink glyphs were checked for the warned-about overhang and do NOT have
>   one: 44x44 at x=258, right edge 302, inside the panel's 24..351 box -- the
>   stack changes `display`, not padding, so the interaction never arises. The
>   `bulk-result-dismiss` glyph took a plain 44x44 floor rather than
>   `ui/touch.ts`'s chip-remove idiom, whose negative margins would have
>   overhung its 4px container and reached past the pane edge.
> - **NO MODAL WAS ADDED, deliberately, and that is the answer to the "pick one
>   of the two full-screen phone forms" question.** The levels are the PAGE --
>   no portal, no scrim, no focus trap. A sheet for the folder rail would mean
>   either two `folder-sidebar` elements in the DOM (the strict-mode hazard
>   Task 1's JS branch exists to avoid) or a branch that moves the rail,
>   churning `useMailFolders`/`useUnreadMailCountsByFolder` observers on every
>   open and close; it would also mix a sheet's Close with a stack's Back.
>   **`SheetHeader`'s `leading` slot is therefore unused**, and its doc comment
>   -- which claimed "Task 3's drill-in stack needs one at every level" -- now
>   says so instead of asserting a caller that does not exist. The slot is kept
>   as a reasonable API for a sheet-based drill-in somebody may still want.
> - **NO HEIGHT WAS SET BELOW THE BREAKPOINT.** The `lg` cap stays a desktop
>   rule and was not mirrored; the document scrolls, which it already did at
>   that width. A unit guard fails a second viewport-unit rule in this file,
>   and says in its own comment that it would not catch a height expressed some
>   other way.
> - **Desktop re-measured at 1280x800 and identical**, before and after both
>   rounds: 224x800 aside; `<main>` exactly `flex-1 overflow-auto px-6 py-6`;
>   the grid class string and box (248,139) 1008x624; panes 176/384/416 at
>   x=248/440/840 with byte-identical class strings; the heading row with
>   **exactly two children**; **the `h1` carrying only `class` and no
>   `tabindex`**; `activeElement` BODY (focus is not stolen at a desk); folder
>   row 176x28, select-all 384x24, checkbox 32x98.5, thread row 350x98.5,
>   filter 74.1x38, attachment 200.5x24; document 1280x800, no scroll. A
>   110-line DOM skeleton dump differs from the pre-phase one only by inert
>   `max-md:` utilities, and the built CSS hash never changed
>   (`index-BMpU6pHC.css`) because every utility used already existed. **Also
>   checked at 900x800**, between `md` and `lg`: sidebar present, no stack
>   controls, three panes stacked, folder rows still 28 -- that band is
>   untouched.
> - **THE COMMENT STRIPPER WAS EVADABLE, AND `withoutComments` IS NOW SHARED.**
>   The version in this task's test file stripped from ANY `//` to end of line,
>   including inside a string: the reviewer hid a genuine second
>   `<ThreadList>` behind `<a href="https://conduit.example/help">` on one line
>   and the "rendered exactly once" guard stayed GREEN, because everything
>   after `https:` had been thrown away. The same trick hides a banned utility
>   from an absence assertion, and a URL before a guarded literal produces a
>   spurious red. Fixed to `ui/ui.test.ts`'s whole-line form -- **and, because
>   this was the third consecutive round in which a source guard was found
>   silently not guarding, the function is extracted to
>   `packages/web/src/test/source.ts`** and imported by both files, so the
>   fourth author cannot write a fifth variant. **Mutation-verified in both
>   directions:** loose stripper + the evasion = green (the hole reproduced);
>   strict stripper + the same evasion = red.
> - **THE LEVEL-TO-PANE SEAM IS TIED.** Inverting the folders div's gate to
>   `view.panes.conversation` left all 341 web tests green -- a phone showing
>   the folder rail while you read a conversation, shipping until Task 6's
>   e2e. A new guard walks the gates in source order, pins the sequence to one
>   per level in grid order, and checks each gate's region holds its own
>   component. **The inversion now fails it**, and the guard's comment says
>   what it cannot see (a pane moved into a child component, or a gate written
>   some other way).
> - **`ALL_PANES` and `DESKTOP_VIEW` are FROZEN.** `readonly` stops the
>   innocent path and nothing else: one cast, and
>   `(view.panes as Record<string, boolean>).conversation = false` drops a pane
>   from every subsequent desktop render -- the exact outcome the module exists
>   to prevent. These are ES modules, so the write now throws. A test pins it
>   and dies when the freeze is removed. Proportionate for this one constant
>   and not applied elsewhere in the file.
> - **`foldersOpen` no longer outlives its rail.** It was a latch: tap Folders,
>   have the last own account archived in another tab (the level silently drops
>   to the thread list, the button vanishes, the flag stays true), un-archive
>   it, and the user is thrown onto the folder screen without touching
>   anything. Folded into the effect that already cleans up a stranded
>   `accountChoice`, keyed on the same `hasFolderRail` the view is given -- so
>   the cleanup and the gate cannot disagree about what "there is a rail" means.
> - **Tests: +13 on the 1760 baseline -> 1773** unit + 36 skipped, green;
>   typecheck clean on five projects; `npm run build` clean with no CSS
>   warning; **no e2e file touched, 72 -> 72**. All thirteen are
>   `pages/inbox-lib.test.ts`: ten over `inboxStackView` (the desktop pin over
>   an 8-input matrix, exactly-one-pane, all-three-panes-reached,
>   every-level-has-an-exit, the deep-link precedence, the no-rail case) and
>   three source guards over `inbox.tsx` (the grid literal, no phone
>   viewport-height frame, each mail pane rendered exactly once). **Four
>   mutations run, all died:** a phone viewport-height rule on the grid, a
>   duplicated `<ThreadList>`, flipped level precedence, and a removed desktop
>   guard. Absence assertions run over comment-stripped source, following
>   `ui/ui.test.ts`'s tripwire. **The quality round added two more -> 1775**
>   (the level-to-pane gate and the freeze), and ran three further mutations,
>   all of which died: the stripper loosened, the level-to-pane inversion, and
>   the freeze removed.
>
> **THE COMPOSER'S PHONE FOCUS -- RULING WITHDRAWN, BACKLOG FOR AFTER v0.10.0.**
> Measured: at 375 the composer opens with `activeElement` on `dialog-close`;
> at 1280 it opens on `composer-account`. The coordinator's first ruling
> assumed the desktop already focused `composer-to` and that scoping the fix
> would therefore be desktop-inert; the spec review measured that the first
> tabbable descendant on desktop is the From `SelectTrigger`
> (`composer.tsx:279`), which precedes `composer-to` and renders whenever
> there is at least one sendable account -- so desktop compose AND desktop
> reply both open on `composer-account`, and the premise was false for both
> cases. Phone-scoping it would need a width branch inside `composer.tsx`, a
> **FOURTH `useIsMobile()` site** where the spec names three "so a fourth is a
> deliberate addition rather than a drift". Not sanctioned for a focus
> nicety. `composer.tsx` is untouched. It is not a dead end -- the Close works
> and the fields are one tap away -- but it is the same shape as the bug Task 1
> fixed for the search sheet, and it wants a `DialogContent`-level answer
> rather than a per-caller patch.
>
> **THREE COMMENT CLAIMS THAT OVERSTATED, CORRECTED.** `inbox-lib.ts` said the
> grid stops being three panes below the breakpoint; it stopped at `lg`
> (1024px), not `md` (768px), and `inbox.tsx` stated the accurate version, so
> the two contradicted -- the file now separates the CSS stacking (below 1024,
> pre-existing, not ours) from what this module adds (below 768, one pane shown
> at a time), and says the 768-1024 band is what it always was. `inbox.tsx`'s
> `chooseFolder` said the folder flag "is always false already" above the
> breakpoint; it is not -- open the folder screen on a phone, widen past 768,
> click a folder in the desktop rail, and that line runs with the flag true.
> The write is still unconditional, for the identity-stability reason, and the
> comment now gives that reason instead of a false one. And **the
> `empty:hidden` contradiction in `bulk-bar.tsx` is resolved rather than left
> standing**: the horn picked is that the PRE-EXISTING desktop rationale was
> overstated -- a `display:none` element is not in the accessibility tree, so
> "always mounted" was a claim about the DOM and not about the tree a screen
> reader watches, and the region is absent until the instant it fills at every
> width. What survives is smaller and real (the node, its id and its role never
> change, so nothing is inserted at announce time and the dismiss button cannot
> take the announcer with it), and the remedy if a reader is ever seen missing
> it is to drop `empty:hidden` for a zero-size region. **The phone case is
> still worse and is a different thing:** with `empty:hidden` alone the region
> at least enters the tree at the moment it fills; inside a hidden pane it is
> out of the tree when it fills AND stays out until the reader navigates back,
> so there is no moment at which it could announce.
>
> **RECORDED, NOT FIXED.**
>
> - **`/mail?thread=` with an EMPTY value passes route validation** (`typeof ""
>   === "string"`), reads as a selection, and puts the stack on the
>   conversation level. Measured: the pane renders
>   `<div class="min-w-0 lg:overflow-y-auto"></div>` and the thread list is
>   `display: none`, so a phone gets a whole screen holding only Back and
>   Compose. Pre-existing as an empty pane at a desk; the stack promotes it to
>   a full screen. It belongs with the `conversation.tsx` follow-up below
>   rather than in `validateSearch`, since normalising it there would change
>   desktop rendering.
> - **The heading shifts on cold load**: the row has two children and then
>   three as `hasFolderRail` resolves, because the rail is absent for the
>   render before the accounts query returns. Same root cause the focus comment
>   already names, and the reason first arrival focuses the heading rather than
>   a control.
>
> - **A cold deep link to a MISSING thread renders an empty pane**, at 375 and
>   at 1280 alike: an empty pane div, API 404, `conversation-gone` ABSENT. That
>   testid is the WARM case only -- a pane already open when an ordinary
>   refetch meets the 404 -- because `Conversation`'s `data === undefined`
>   guard returns null before the error branch has anything to say. On a phone
>   that is a whole screen holding only Back and Compose. Not a dead end, but a
>   poor screen; the cause is pre-existing in
>   `components/mail/conversation.tsx` and was not patched from the page.
>   `inbox.tsx`'s comment, which previously asserted the opposite, now says
>   what actually happens.
> - **`composer-suggestion` (`composer.tsx:632`) is 36px** -- the
>   recipient-autocomplete rows, under the floor on a phone. Task 2 residue
>   that nothing in the plan caught. Task 6 or a follow-up.
> - **`BulkResult`'s always-mounted `role="status"` sits INSIDE the threads
>   pane**, so an outcome landing while the reader has drilled into a
>   conversation is not announced -- the text itself survives (the page owns
>   it) and is read on return, but the region was `display: none` when it
>   filled. Every gesture that starts a bulk action is on the threads level, so
>   it needs a mid-flight drill-in to reach. Noted in `bulk-bar.tsx`.
> - **The scroll-to-top effect keys on `view.level`**, so a global-search
>   navigation from one conversation to ANOTHER stays at the same level and
>   does not reset the scroll; it also fires on mount and on a breakpoint
>   crossing. Both cosmetic.
> - **The `replace` on `?thread=` is kept at both widths**, so a system Back
>   gesture from an open conversation leaves the inbox rather than closing the
>   conversation -- identical to the desktop's behaviour today, and the reason
>   `inbox-back` is on screen at every level that has somewhere to go.
>
> **HANDOFFS. Task 4:** nothing here blocks you; the pattern worth copying is a
> `*-lib.ts` whose view function returns the unchanged DESKTOP shape for
> `isMobile: false`, with a unit test pinning it -- it turns the hard
> requirement into an assertion. Also prefer a mutually-exclusive display
> ternary over appending a hidden utility to a class string that already
> carries one: two utilities setting the same property is a precedence
> question you do not need to have. And if you hide rather than unmount
> anything, budget for the focus move -- it is not optional. **Task 6:** new
> testids `inbox-back` and `inbox-folders`, which exist ONLY below the
> breakpoint (a JS branch, not a hidden element), so no desktop journey can
> see them. **`thread-list`, `folder-sidebar` and `conversation` are in the
> DOM at EVERY level**, `display: none` when off screen -- assert
> `toBeVisible()`/`toBeHidden()`, never `toHaveCount(0)`. `/mail?thread=<id>`
> lands directly on the conversation level. The composer opens focused on
> `dialog-close` at a phone viewport, so a journey that types immediately
> types into nothing -- focus the field first. Two asserts worth having: focus
> after a drill-in (it is the finding this round fixed and nothing but e2e
> re-checks it), and that the accumulated list survives a round trip through a
> conversation (open a thread from page two, Back, count the rows) -- that is
> the property the whole design rests on.

### Task 4: The kanban stage view

**Files:** `packages/web/src/pages/board.tsx`, `board-lib.ts` (new) + test.

Below the breakpoint: a **stage picker**, the chosen stage's deals as a list, and **"Move to..."** on each card offering the other stages. This is the third and LAST `useIsMobile()` site. Deal creation stays available; the funnel/summary stays legible or collapses behind a disclosure.

**FROM TASK 3's QUALITY REVIEW — what transfers from the inbox pattern and what does NOT:**
- **Transferable:** a pure view function that returns the UNCHANGED desktop value for `isMobile: false`, plus a test pinning that over the full input cross-product. That turns the hard requirement into an assertion.
- **NOT transferable — the inbox's selection lives in the URL; yours cannot.** `/pipelines/$pipelineId` has no search schema, so the chosen stage is component state: no free deep link, and "opening a card IS the navigation" has to be re-earned or given up deliberately. Say which you chose.
- **Return-value identity is asymmetric in the inbox's function** (desktop returns one shared object, mobile a fresh one per call). If `board-lib` returns the move-target ARRAY, memoise it or key on primitives, or every memoised card re-renders on every render.
- **Breakpoint alignment:** `useIsMobile` is `md` (48rem) but the inbox grid is `lg:`-gated, so 768-1023px is single-column but not "mobile" — no stack controls, no `max-md:` floors. Gate your CSS at `md:` to line up with `isMobile`; mixing `md` JS with `lg` CSS is what leaves that 256px band behind.
- **If you hide rather than unmount, budget the focus move** — and pick the SAME target the inbox settles on, so the two surfaces do not disagree.
- **The seam nothing tests:** in the inbox, changing which pane a level gates on left all 341 web tests green. If you copy the pattern, either guard the level->pane wiring or accept that Task 6's e2e is the only thing that will catch an inversion.

The move must go through the **existing** deal-move service path — never a second one — so SSE and optimistic-update behaviour are unchanged. (**CORRECTED:** this sentence used to say "the compactor". There is no deal position compactor anywhere in the tree — the only `compact*` is `compactSchedule` in `services/scheduling.ts`, the Gantt's Remove-slack. The wording was this plan's, and Task 4 inherited it into a source comment; both are fixed.) `board-lib.ts` holds the move-target list (pure, tested: the current stage is excluded, order matches the pipeline, an archived pipeline offers none).

Above the breakpoint the board is untouched — including its drag-and-drop. ~8 tests.

> **DONE** (commits 616b1e7 + 2d4b5de + 0b4fc69 + this spec-review round;
> spec review compliant-with-issues, NO correctness defect. The reviewer
> verified the hard requirement by MEASUREMENT rather than by reading -- it
> rendered the branch's own compiled CSS in Chromium at 375/767/768/1280 and
> confirmed the JS branch and the `max-md:` CSS turn over at the SAME pixel in
> both directions -- reproduced the funnel and rename numbers independently,
> and established the Radix focus finding live by building a harness from this
> repo's own `ui/dialog.tsx` and Radix build, isolating the cause by contrast
> with a triggered dialog. Its findings were one seam the type system does not
> cover and three comments that claimed more than was true). As built:
>
> - **THE SHAPE: a stage picker, one stage's deals as a list, "Move to..." per
>   card.** The picker is a horizontally-scrolling `role="group"` /
>   `aria-label="Stages"` strip of buttons, one per stage, each carrying that
>   stage's deal count and `aria-pressed` from the SAME rule that picks its
>   colour. Under it a `role="status"` line, then the stage's own block: the
>   existing `StageHeader` (rename, count, value), the cards, `New deal`; then
>   `+ Stage`. **Nothing the desk can do is missing** -- the only desktop
>   gesture with no phone equivalent is REORDERING WITHIN a stage, which is a
>   position and not a capability.
> - **WHERE THE STATE LIVES: component state, and the deep link is GIVEN UP
>   deliberately.** The reasoning is in `board.tsx` and the load-bearing half is
>   this: the same URL would describe two different screens depending on the
>   window it was opened in, since the desktop board shows every stage at once
>   and would ignore a `?stage=` only one width ever writes. (The reviewer
>   judged the argument sound but slightly over-pressed -- a mobile-only search
>   param the desktop ignores is a common benign pattern -- so read the
>   URL-means-two-things half as the reason and the rest as support.) **The
>   stated cost:** "opening a card IS the navigation" is NOT re-earned; tapping
>   a card leaves for `/deals/<id>` and coming back re-mounts the picker on the
>   pipeline's first stage. A lost place in a list, not a broken link. The
>   remedy if it grates in use is a search schema and that paragraph rewritten,
>   not a quiet second store of state.
> - **IT UNMOUNTS THE DESKTOP BOARD RATHER THAN HIDING IT -- the opposite of
>   Task 3's ruling, and the reason the two differ is recorded so neither looks
>   like an oversight.** The inbox hides because its panes hold accumulated
>   "Load more" pages and live query observers an unmount would throw away.
>   Nothing here does: every card comes from the ONE `useDeals(pipelineId)`
>   query the page owns. And hiding would be actively WRONG here --
>   `pipeline.spec.ts` counts `[data-testid^="column-"]` and addresses
>   `card-<id>` at page level, and a `display:none` copy is still counted and
>   still a strict-mode violation.
> - **ONE MOVE PATH, verified end to end.** `useMoveDeal` is instantiated once
>   and called by both the drag and the sheet, with neither neighbour named
>   (`moveDealInputSchema`'s append-at-the-tail). Verified against a live
>   server: a deal moved into a stage holding one deal at `"a0"` landed at
>   `"a1"` -- `midpoint("a0", null)` -- and produced the SAME `stage_changed`
>   event the drag produces. A per-call `onError` is additive on top of the
>   mutation's own rollback.
> - **THE FOCUS, both exits, because Radix handles NEITHER for a dialog opened
>   this way.** Measured: dismissing the sheet with Close left `activeElement`
>   on `<body>` with the trigger still in the DOM. `DialogContentModal`'s own
>   `onCloseAutoFocus` focuses `context.triggerRef.current`, which only
>   `<DialogTrigger>` sets; this is one page-level dialog driven by state
>   because the trigger is a different button on every card. Handled
>   explicitly: the trigger back on a dismissal (`isConnected`-checked, so an
>   SSE retirement mid-sheet falls through), the page `h1` after a move -- the
>   inbox's target, `tabIndex={-1}` below the breakpoint only, so the desktop
>   heading keeps exactly the attributes it had. The sheet also opens on the
>   first stage rather than on its own Close. **This became the phase-level
>   finding above**, which is where it now lives.
> - **TWO THINGS MEASURED ON THE PHONE AND FIXED RATHER THAN LEFT.** The
>   **funnel** spilled: its three fixed columns (160 + 48 + 112) plus padding
>   came to 368px inside a 327px content box at 375px, so the flex-1 track was
>   squeezed to ZERO and the value column was pushed out of the box. **Be
>   accurate about where that overflow went** -- the DOCUMENT did not scroll
>   sideways but `<main>` did (`scrollWidth` 393 against `clientWidth` 375,
>   `overflow-x: auto`, and setting `scrollLeft` revealed the value column in
>   full), so the numbers were reachable by a sideways scroll nothing
>   signalled: worse than plainly absent for being deniable, not absent. The
>   row now wraps below the breakpoint (name on its own line, track ~157px; the
>   reviewer measured 158.2px independently). And the **stage rename button**
>   was 303x20, under the phase's 44px floor, and it is the only way to reach
>   that capability on a phone.
> - **THE THREE `useIsMobile()` SITES ARE NOW CLOSED AS A SET.** A guard in
>   `use-is-mobile.test.ts` walks `packages/web/src` and asserts the callers are
>   exactly `components/shell.tsx`, `pages/board.tsx`, `pages/inbox.tsx`. It
>   could only be written once the third site existed. Not a veto -- it obliges
>   a fourth to be argued for in the same commit, which is what the spec asks.
> - **THE SEAM: the type system covers the gate and STOPS THERE, and that limit
>   is now written down and guarded.** Inverting the branch IS a type error --
>   `StageView` takes a non-null stage, so the else-branch's `null` has nowhere
>   to go (TS2322, mutation run) -- and that is a better tool than a source
>   guard WHERE THE GATE'S VALUE IS THE PAYLOAD. It does not generalise: the
>   reviewer showed that swapping `picker` and `moveTargets`, same-typed
>   SIBLING PROPS, typechecks clean and passed all 367 web tests, giving an
>   archived pipeline no picker at all and a Move sheet offering the stage the
>   card is already in -- exactly the class `inbox-lib.test.ts` guards for its
>   level-to-pane wiring. A source guard now pins both props and the `isMobile`
>   argument's spelling; **both demonstrated mutations were re-run and both now
>   fail it** (the props swap, and `isMobile: !isMobile`, which gives the
>   desktop a stage view and a phone the board). The `isMobile` hole is shaped
>   identically at `inbox.tsx:359` and is unguarded there, so this closes it
>   for one file rather than for the phase.
> - **THE CROSS-PRODUCT IS NOW A REAL ONE.** The desktop pin's `COMBINATIONS`
>   was eight hand-picked shapes of the eighteen the three inputs allow, while
>   every comment around it said "the cross-product". It is now GENERATED --
>   3 pipeline shapes x 3 stage choices x 2 archived flags = 18 -- with its own
>   length pinned, and the assertion is by IDENTITY (every desktop call returns
>   the one shared frozen object).
> - **Desktop re-measured at 1280x800, identical before and after:** 224px
>   aside with its class string; `<main>` exactly `flex-1 overflow-auto px-6
>   py-6`; the board row's class string and 1008px box; five 288px columns at
>   the same 304px pitch; the card's class string and 272x62 box; the `h1`
>   carrying only `class` and **no `tabindex`**; one `DndLiveRegion`;
>   `activeElement` BODY; document 1280x800, no scroll; the funnel row still
>   160/626/48/112 on one line at 38px. **Also checked at 800px** (sidebar,
>   five columns, no stage view, rename still 20px) **and at 767px** (stage
>   view, bottom bar, rename 44px).
> - **Tests: +25 on the 1775 baseline -> 1800** unit + 36 skipped, green;
>   typecheck clean on five projects; `npm run build` clean with no CSS
>   warning; **no e2e file touched, 72 -> 72 unchanged**, confirmed green in CI
>   on the final tip. Twenty-four are `pages/board-lib.test.ts` and one is the
>   three-sites guard. **Seven mutations run, all died:** the gate inverted
>   (typecheck), the props swapped, `isMobile` negated, the desktop column
>   class edited, a hand-rolled second move path, the rot boundary loosened to
>   `>=`, and a fourth `useIsMobile()` site. **The quality round added one more
>   -> 1801** (the phone-half cross-product; the element count folded into the
>   existing sibling-prop guard) and ran two
>   further mutations, both of which died: a mis-wired second `<StageView>`
>   placed AFTER the real one, and a second `useIsMobile()` call inside
>   `shell.tsx`.
>
> **FROM THE QUALITY ROUND** (it called `board-lib.ts` "the strongest unit file
> the phase has produced" -- 8 behaviour mutants, all 8 died -- verified the
> move path independently down to the server's matching both-null branch and
> the shared `lockSiblingGroup`/`midpoint`, and singled out the close handler's
> `isConnected` check as "the case most implementations miss". Its findings
> were two more false claims, a state bug, a cost estimate that was wrong by
> enough to have changed a decision, and two guard gaps):
>
> - **AN API GAP, FOUND BY DISBELIEVING A COMMENT.** `board-lib.ts` claimed an
>   archived pipeline's move would be refused by the server "anyway". **False,
>   and verified so:** `moveDeal` (services/deals.ts) checks the DEAL's
>   `archivedAt`, its status and the target stage's `pipelineId` -- it never
>   loads the pipeline row, and `archivePipeline` does not cascade `archivedAt`
>   onto deals. `createDeal`, `createStage` and `updateStage` all DO gate on the
>   pipeline; `moveDeal` alone does not, and no test covers it (only an archived
>   DEAL, at `deals.test.ts:330`). So `POST /api/deals/<id>/move` on an archived
>   pipeline **succeeds**. The UI decision to offer no targets is unchanged and
>   still right -- it matches the desktop, whose drag sensors are simply absent
>   -- but the UI is the only thing enforcing it. **Backlog item, not fixed
>   here.**
> - **THE FALLBACK'S NAMED CAUSES DID NOT EXIST.** It said a stage could be
>   "deleted or renamed away in another tab". There is no stage-delete endpoint
>   at all (`routes/pipelines.ts` has POST/PATCH/reorder and no DELETE;
>   `deals.ts` states the rule outright), and a rename changes `name` while the
>   lookup is by `id`. The fallback stays -- it is correct defensive code and
>   the initial-null path is the common one -- but it now names causes that are
>   real.
> - **THE MOVE SHEET COULD RE-OPEN BY ITSELF, and now cannot.** `open` derives
>   from the live list, but `movingDealId` was cleared only by a dismissal or a
>   completed move. So: open the sheet on deal D, a colleague moves D away over
>   SSE (the sheet closes, focus correctly goes to the h1) -- and the id
>   survives. The colleague moves D back and the sheet re-opened with no user
>   action, taking focus to its first target. The same event the `isConnected`
>   check was praised for handling: it covered the focus half and not the state
>   half. An effect now clears the id when the deal leaves the list. **Verified
>   live at 375px against a real server:** open on Globex, move it out
>   out-of-band (sheet closed, `activeElement` the `h1`), move it back (card
>   returns, `sheetReopened: 0`, focus still on the `h1`).
> - **THE LIVE REGION IS RETRACTED ON FAILURE NOW, because the cost estimate
>   that decided otherwise was wrong.** The previous round justified leaving it
>   as needing the mutation's outcome "threaded down into the component"; the
>   failure callback already lives on the page beside the error banner, and the
>   whole change is one parameter on `onMove`. **Verified live with a delayed
>   forced 409:** the line reads "Moved Initech migration to Qualified." with
>   the card gone (3 cards), then empties with the card back (4 cards) and the
>   banner carrying the message. A wrong cost estimate is worth recording
>   separately from the behaviour it produced.
> - **TWO GUARD GAPS CLOSED, both mutation-verified.** The sibling-prop guard
>   used `indexOf`, so a mis-wired SECOND `<StageView>` placed AFTER the real
>   one walked straight past it (one placed BEFORE was already caught -- that
>   asymmetry is what makes "found" the wrong test); it now counts the element
>   and fails at two. The three-sites guard counted FILES, so a second
>   `useIsMobile()` call inside `shell.tsx` left the suite green under a test
>   named "at exactly the three sites"; it now pushes one entry per call. Both
>   evasions were re-run and both now fail. **One evasion is recorded rather
>   than closed:** the correct spellings kept alive in a TRAILING `//` comment
>   while the real props are swapped. `withoutComments` strips only comments
>   that BEGIN a line -- deliberately, per `test/source.ts`'s own history -- so
>   these guards match TEXT, not code. The fix is a parser; the evasion needs
>   someone writing the right answer beside the wrong one.
> - **THE PHONE HALF NOW GETS THE CROSS-PRODUCT TOO.** Fair point from the
>   review: the desktop pin's eighteen cases all exercise one `return` on the
>   function's first line, so the identity assertion is what makes it strong,
>   not the breadth. The same eighteen now run through `isMobile: true` as
>   PROPERTY assertions -- picker identity, a stage shown exactly when there is
>   one, target count, the current stage never offered, pipeline order
>   preserved -- which is the half where the fallback, the picker and the filter
>   actually branch.
>
> **RECORDED, NOT FIXED.**
>
> - **The picker is not sticky**, and on a busy stage that is the real cost of
>   this surface -- rated by the review as a larger real-use problem than the
>   picker-scroll item below. 200 deals is roughly 12,000px of list, so `New
>   deal` and `+ Stage` sit at the bottom of it and switching stages means
>   scrolling all the way back. `sticky top-0` with a background plus `-mx-6
>   px-6` to bleed `<main>`'s padding is the fix; it wants measuring on a real
>   long list rather than adding at the end of a review round. **The source
>   comment deliberately does NOT spell those class names**, and this one can
>   only afford to because Tailwind's scan is rooted at `packages/web` and does
>   not reach `docs/`: naming them in the source emitted a real, dead `.-mx-6`
>   rule into the built stylesheet (Task 1's hazard, caught here by the built
>   CSS growing 50 bytes and its hash moving).
> - **An archived pipeline reached mid-sheet** leaves the targets empty, so the
>   sheet body renders nothing and Close is the only exit. Degrades acceptably.
> - **The `useMemo` on `stageView` buys nothing today**, and its comment now
>   says so rather than claiming otherwise. No card is `React.memo`'d and the
>   callbacks the cards receive are fresh identities every render, so memoising
>   one array changes nothing a profiler would find. Kept because it is correct
>   and is the shape that keeps working if a card ever is memoised.
> - **A phone with no stages at all falls to the DESKTOP branch**
>   (`stage === null`), which at that width renders an empty board row holding
>   only `+ Stage`. That is the honest empty state and it works, but it means
>   `data-testid="board"` can exist at a phone viewport in exactly that case.
> - **The picker does not scroll the chosen stage into view.** Unreachable
>   today (it opens on the first stage and the DOM node persists across picks),
>   but a pipeline with many stages plus a future restored selection would meet
>   it. Milder than it reads, per the quality round: `StageHeader` names the
>   current stage directly above the list, so the redundancy saves it.
>
> **HANDOFFS. Task 5:** the Radix focus finding above is yours too -- your
> Gantt->drawer path ends in a drawer whose closer is its only exit, and
> `task-drawer.tsx` is one of the four callers with no restore. `useIsMobile()`
> is closed at three and enforced, so the Gantt's read-only mode must be `md:`
> CSS, not a fourth site. **Task 6:** new phone-only testids `stage-view`,
> `stage-picker`, `stage-pick-<stageId>`, `stage-move-result`,
> `move-<dealId>`, `move-sheet`, `move-sheet-close`, `move-to-<stageId>`;
> `card-<dealId>` is REUSED at both widths and is one element at either. Unlike
> the inbox's panes, `column-<id>`, `board` and `DndLiveRegion` are genuinely
> ABSENT below the breakpoint -- `toHaveCount(0)` is right there. Worth
> pinning, because nothing but e2e re-checks it: focus on the `h1` after a
> move, and focus back on the trigger after a Close. The sheet opens focused on
> its first target, so a journey may act immediately. Two environment facts:
> the browser pane's CDP resize updates `matches` without dispatching `change`
> (set the viewport at context creation), and **`@fastify/static` caches** -- a
> rebuilt `dist` needs a server restart or every asset 404s into the SPA
> fallback.

---

## Phase-level findings (carried out of Phase 6, for the release notes and the backlog)

- **Every state-driven `Dialog` in this app restores focus to nothing on close.** Radix's `onCloseAutoFocus` focuses `context.triggerRef.current`, which only `<DialogTrigger>` sets — so a dialog opened from state leaves `activeElement` on `<body>`. Task 4's reviewer isolated the cause live (a harness built from this repo's own `ui/dialog.tsx` and Radix build: an otherwise identical dialog WITH a trigger restores correctly). Exactly four callers: `composer.tsx:97`, `task-drawer.tsx:46`, `settings-mail.tsx:137`, `settings-templates.tsx:61`. **Pre-existing and desktop-visible, so out of bounds for this phase** — it belongs with the composer's opening-focus item already deferred past v0.10.0. Task 4 handled both exits explicitly for its own sheet; the other four are untouched.
- **The composer opens focused on `dialog-close` at a phone viewport**, because it is the only `DialogContent` caller with no `autoFocus`'d field. The coordinator's ruling to redirect focus was WITHDRAWN in Task 3: the first tabbable on desktop is the From `SelectTrigger`, so both compose and reply would change desktop, and phone-scoping needs a fourth `useIsMobile()` site the spec caps at three. Deferred past v0.10.0.
- **A cold deep link to a missing thread renders nothing** — `conversation-gone` is the WARM case only (a pane already open when a refetch meets a 404); a cold link returns null from `Conversation`'s `data === undefined` guard before the error branch speaks. On a phone that is a screen holding only Back and Compose. Cause is in `conversation.tsx`; not patched from the page.
- **`/mail?thread=` with an EMPTY value** passes route validation, reads as a selection, and produces the same empty screen. Normalising it in `validateSearch` would change desktop rendering.
- **`composer-suggestion` is 36px** — recipient-autocomplete rows, under the phone floor. Task 2 residue that no task owned.
- **The phone list row (`<TableRow onClick>`) has no role, no accessible name and no tab stop**, and below the breakpoint loses row semantics too, so a screen-reader user on the companies list gets an unstructured run of label/value lines with no way to open a company. Pre-existing (those rows were keyboard-inert at desktop before the phase); fixing it adds desktop tab stops, so it needs its own decision.
- **In the 768-1023px band you get the DESKTOP shell over already-narrow layouts — and an earlier version of this finding had it exactly backwards, which is why it is spelled out here.** `mobileMediaQuery()` is `not all and (min-width: 48rem)`, so `isMobile` is FALSE from 768px up, and `shell.tsx` renders its `<aside>` when `!isMobile`: at 900px you get the dark sidebar and no bottom bar. Meanwhile every `lg:`-gated layout has already gone narrow at 1024px, so the inbox's three panes are stacked in one column and the detail pages have dropped their rail under the content — measured by Task 3 at 900x800 ("sidebar present, no stack controls, three panes stacked, folder rows still 28"). Every `max-md:` rule is off there too, so no 44px floors and the entity tables are still tables. The old wording claimed the opposite (phone navigation over wide layouts) and illustrated it with a funnel wrap that cannot happen in that band at all — `funnel.tsx`'s wrap is `max-md:flex-wrap`, i.e. below 768. **This plan's Task 4 guidance states the rule correctly and always did**; this bullet is what disagreed with it. Cosmetic, compliant, and the honest consequence of one breakpoint rather than two.
- **The record rail's tab spill is FONT-STACK DEPENDENT, so nothing may assert it.** Task 2 measured the five tabs at 349px intrinsic against a 342px box at 390px, and Task 6 reproduced that exactly in Chrome on macOS. On CI's Ubuntu runner the same five labels measure narrower and the strip FITS with nothing to scroll — a red run is how this was found. `max-md:overflow-x-auto` is therefore insurance that pays out on some font stacks and not others, which is the right shape for it; but a test may only assert the mechanism (the strip is its own scroll container), never the spill or a scrollLeft that follows from it. Which way Chris's own handset falls is decided by iOS's system font.
- **The browser pane cannot settle any question about focus EVENTS.** `document.hasFocus()` is false in it, and Blink defers focus events for a page that does not have focus: `element.focus()` moves `document.activeElement` and fires nothing, so Radix's roving focus never activates a tab and any scroll-into-view that focus would have caused never happens. That is why Task 2's reviewer could not settle the arrow-key question there, and it sits beside the pane's other known blind spot (a CDP viewport change updates `matches` without dispatching `change`). Playwright is where a focus question gets an answer.

### Task 5: The Gantt, read-only on a phone

**Files:** `packages/web/src/components/gantt/*`.

Below the breakpoint the chart renders **read-only with pan and zoom**, and **tapping a bar opens the task drawer** (where dates and dependencies are both editable — this is what makes the phase's no-capability-gap claim true, so verify it end to end rather than assuming).

**A drag must not appear to start.** If touch drag is unsupported, the bar must not show a drag affordance or move under the finger and snap back — that is worse than a plain tap target.

**FROM TASK 2's QUALITY REVIEW:** the task drawer's ✕ is the ONLY exit on a phone (full-screen, no outside to click, no Escape key) and measured 34.7px wide — Task 2's round is flooring it, but **verify it before you build the Gantt→drawer path**, or the no-capability-gap claim you are asked to prove end to end rests on a control that fails the phase's own touch floor. Also: `field-dates` wraps to FOUR lines at 375px with the `→` orphaned alone on one of them (Task 2 is hiding it below the breakpoint); the path works, but re-measure rather than trusting this note.

**INHERITED FROM TASK 1's review:** the Gantt's own `sticky` elements carry `z-20`/`z-30` (`gantt/chart.tsx:240,242`; `gantt/timescale.tsx:82,136`) and are NOT portalled. `<main>` is not a stacking context (`overflow-auto` alone does not create one), so they participate in the root stacking context above the bottom bar's `z-index: auto` and can paint OVER it — the bar's bottom padding keeps ordinary content clear but not these. Every other overlay in the app is portalled to the end of `<body>` and lands above the bar for free; the Gantt is the exception.

Above the breakpoint, unchanged: drag-to-reschedule, dependency editing, the compactor. ~6 tests.

> **DONE.** Every number below was measured in a browser at 375x812 against a
> build of this branch on the dev server, not reasoned about. The gate
> Amendment 2 required came first and produced spec Amendments 4-6; this block
> records what was built under them.
>
> **THE GATE'S OWN CORRECTION, because it changes the size of the problem.**
> Amendment 2 computed 375 - 240 = 135px of timeline. `<main>` carries `px-6`,
> so the grid's client width is **325**, and the sidebar left **85px** -- 2.8
> day columns, not 4.5. And the chart did not merely open cramped: `computeRange`
> starts the window `RANGE_PAD_DAYS` (14) before the earliest task, so at
> `scrollLeft: 0` **no bar was on screen at all**. On the original three-task
> data the bars sat at `offsetLeft: 420` and were visible only for `scrollLeft`
> between roughly 335 and 480. "Technically read-only" was shipping as
> technically blank.
>
> **THE GEOMETRY, and the one idea the whole task rests on.** Amendment 2 said
> every dimension is an inline JS-computed style, so `max-md:` cannot rescale
> any of it. True of all but one: **`SIDEBAR_WIDTH` feeds no date arithmetic**
> -- unlike `ROW_HEIGHT` and `pxPerDay`, which feed `rowTop`, bar left/width
> and the SVG arrow endpoints -- so it is the one constant a stylesheet can
> take over. It is now `SIDEBAR_WIDTH_CSS`, built in `geometry.ts` by
> interpolation as `var(--gantt-sidebar-width, 240px)`, so the desktop value
> and the fallback are the same value BY CONSTRUCTION rather than by a test's
> vigilance. The phone override is a Tailwind arbitrary-property variant on the
> grid box, `max-md:[--gantt-sidebar-width:8rem]` -- so no hand-written media
> query exists and the breakpoint stays single-sourced through Tailwind's own
> variant. Measured: sidebar 240 -> 128, timeline **85px -> 247px**, 8.2 day
> columns at day zoom and 19.2 days at week zoom.
>
> Three more classes ride on the same box, all layout, all `max-md:`:
> `max-md:-mx-6` gives back the page's side padding (48px of a 375px screen),
> `max-md:rounded-none max-md:border-x-0` because a rounded border pushed to
> the screen edge reads as a rendering fault, and `max-md:isolate` -- see the
> tap theft below.
>
> **THE TAP THEFT, which was a bug and not a cosmetic one.** Task 1's handoff
> warned the Gantt's sticky elements carry `z-20`/`z-30` and are not portalled,
> so they can paint over the bottom bar. Measured at 375px, it was worse than
> painting: `document.elementFromPoint` over the bar's **Mail** tab returned a
> Gantt sidebar row, i.e. **the bottom navigation was untappable on this page**.
> `max-md:isolate` on the grid box confines those z-indices to it; the bar keeps
> its deliberate absence of a z-index and wins on DOM order. Probe before:
> `"flex items-center truncate border-b border-slate-100 text-xs text-slate-700 px-2"`.
> Probe after: `bottom-nav`. Desktop is `isolation: auto`, as it always was.
>
> **PER AMENDMENT 1 (the key handler).** One `window.matchMedia(mobileMediaQuery()).matches`
> read inside `handleBarKeyDown`, placed after the Enter branch and after the
> modifier/direction guards, before `preventDefault`. Two consequences worth
> stating: **Enter still opens the drawer**, which is the phone's whole way in;
> and the refusal returns WITHOUT `preventDefault`, unlike every other refusal
> in that handler, so an arrow key keeps its default action -- which inside a
> scrolling grid is exactly the pan this chart is supposed to have. Measured at
> 375px on a focused bar: four ArrowRights, a Shift+ArrowLeft and a Shift+ArrowUp
> left the title at `Call Ada: 2026-08-27 to 2026-08-28` with `transform: none`,
> and Enter then opened the drawer. At 1280px, three ArrowRights still render a
> live `matrix(1, 0, 0, 1, 90, 0)` preview and commit as one shift (`2026-08-21
> to 2026-08-23` -> `2026-08-24 to 2026-08-26`) -- the path `e2e/tasks.spec.ts:234-269`
> drives.
>
> **PER AMENDMENT 4 (the opening scroll), and the target choice.** A second
> imperative read, in a LAYOUT effect so the offset is in place before the
> first paint rather than as a jump after it. **The target is today, clamped
> into the span of the work** (`initialScrollLeft`, pure and tested), and the
> clamp is the whole point -- it is what makes all three real cases land on a
> day that has a bar near it:
>
> | The chart someone opens | Where it opens | Why not today |
> |---|---|---|
> | work under way (today between first and last bar) | today | -- |
> | work entirely in the future | the FIRST bar | today is the empty run-up |
> | work entirely in the past | the LAST bar | today is empty grid after the end |
>
> The coordinator's instinct was the earliest task's start. That is right for
> two of the three cases and wrong for the commonest one: on a six-month project
> a phone would open on work that finished in March, with today a hundred and
> fifty columns away. Clamping keeps the "skip the fortnight of padding"
> property that instinct was after while opening on the day a phone glance is
> actually for. Measured: `scrollLeft: 708` on load = day 24 (today) x 30px
> minus the 12px lead-in, exactly. It re-applies **whenever the zoom
> CHANGES**, not once per mount, because an offset in day-zoom pixels is
> meaningless after a switch to week (297 = 24 x 12.857 - 12, measured). What
> it guarantees is that nothing at an UNCHANGED zoom -- a refetch, an SSE
> update, any re-render -- can yank the view out from under a thumb mid-pan. Desktop: `scrollLeft: 0`, untouched.
>
> **PER AMENDMENT 5 (Remove slack).** The per-project `compact-button` stays --
> measured **116.5 x 44** at 375px on `/projects/$id/gantt`, over the floor,
> because it is already a `Button`. Only the per-group one carries
> `max-md:hidden`; it was **81.3 x 19.3** and was never floored by Task 2's
> sweep (it is hand-rolled in `chart.tsx`), and at a 128px sidebar its 28px
> header row renders the project name as a single letter. Both are visible at
> 1280.
>
> **PER AMENDMENT 6 (the tap target), and the mis-tap answer.** Two
> `hidden max-md:block` layers per task row, both `aria-hidden` and both calling
> the SAME `onOpenTask` that Enter has always called -- the no-capability-gap
> claim rests on the existing path, not a second one:
>
> - `gantt-tap-<taskId>` spans the full chart width at the row's own `top`, 32px
>   tall (1530 x 32 measured on the fixture).
> - `gantt-label-tap-<taskId>` covers the task's NAME in the sidebar (127 x 31).
>   This is the half that needs no panning at all: the sidebar is sticky, so
>   every task's name is on screen whatever the timeline is scrolled to.
>
> **There is no mis-tap band, because there is no overlap.** Amendment 3
> expected 44px layers with negative insets overlapping 6px into each
> neighbour; Amendment 6 accepted the argument against them, and what shipped
> has neither. The 44px floor is not met vertically (32px, the row pitch) and
> that is the recorded exception. What it buys, measured on the worst bar in the
> chart -- the same-day milestone, **15px wide at day zoom and 6.42px at week
> zoom** -- is that a hit test at the bar's centre, at the far LEFT of its row,
> at the far RIGHT of its row, and on its name in the sidebar all four return
> that same task's layer.
>
> **THE DRAWER PATH, END TO END AT 375px, because the phase's whole
> no-capability-gap claim is this path.** Tapped the 15px same-day bar (the
> element `elementFromPoint` says a finger lands on) -> drawer opened at
> `/gantt?task=f28e9eca...` titled "Fixture same-day milestone", full-screen
> 375x812. **Dates:** set 2026-09-02/2026-09-02 to 2026-09-04/2026-09-07, Save
> enabled on edit, committed -- the bar behind the drawer became
> `Fixture same-day milestone: 2026-09-04 to 2026-09-07` and grew from 15px to
> 90px, and the drawer's own Activity gained "chris updated startDate, dueDate".
> **Dependencies:** added "Call Ada" as a predecessor; `dependency-list` went
> from "No dependencies" to the task plus its Remove, and the chart drew
> `gantt-arrow-89a444f0-...-f28e9eca-...`. **The exit:** Task 2's fix
> re-verified rather than trusted -- the drawer's close is **44 x 44**, and it
> returned to `/gantt` with the drawer unmounted.
>
> **A DRAG CANNOT APPEAR TO START.** The three pre-ruled classes are in place
> and verified by computed style at 375px: the move overlay is
> `pointer-events: none` (NOT hidden -- it still paints the title), and the two
> resize strips and the dependency handle are `display: none`. What a tap lands
> on over a bar is the row's tap layer, which has no pointer handlers at all, so
> no gesture is tracked, no `setPointerCapture` is taken and nothing can move
> under a finger and snap back. At 1280 the overlay is `pointer-events: auto`
> and all three zones are `block`.
>
> **DESKTOP, MEASURED AT 1280x900 AFTER THE CHANGE:** sidebar 240 (the
> fallback), inner flex row 1770 (240 + 1530, the same total as before),
> `isolation: auto`, margins 0, 1px side borders, 6px radius, `scrollLeft: 0`,
> both compact buttons `block`, every tap layer `display: none`, the sidebar
> rows `position: static`, and the element under a bar's centre is still the
> move overlay. **No e2e file was touched.**
>
> **Tests: +20 on the 1801 baseline -> 1821** unit + 36 skipped, green on the
> server; typecheck clean on five projects; `npm run build` clean **with no CSS
> warning** (the stylesheet went 30.52 -> 30.85 kB, `index-4ov9J3ir` ->
> `index-CBvyyNUj`, which is the six new utilities and not a dead-rule leak:
> `--gantt-sidebar-width:8rem` and `isolation:isolate` each appear exactly once
> in the built CSS). Seven of the twenty are `initialScrollLeft`'s cases; the
> rest are source guards in the new `gantt/phone.test.ts`.
>
> **ELEVEN MUTATIONS RUN, TEN RED AND THE ELEVENTH GREEN ON PURPOSE.** The
> guards were verified against the breakages they advertise rather than
> asserted to work: the move overlay left live; the move overlay hidden instead
> of neutralised; a resize strip left live; the dependency handle left live;
> the keyboard read moved ABOVE the Enter branch (which would stop a phone
> opening the drawer at all); the sidebar's box pinned back to a fixed 240; the
> stacking context deleted; the per-project compact button hidden too; the chart
> row's tap layer stripped of its variant; a third imperative read added. All
> ten failed the suite. The eleventh is the **tripwire** Tasks 1 and 4 both hit:
> a comment that spells `max-md:hidden` and `useIsMobile` in prose -- it stays
> GREEN, because both subjects are comment-stripped ONCE at the top of the file.
> That single strip also protects the element-scoping helper, which finds the
> nearest element start before its marker and would otherwise treat a comment
> mentioning any tag as an element.
>
> **A DEFECT IN THE MUTATION HARNESS ITSELF, worth recording** because it
> produced four minutes of false confidence: one mutation deleted a class by
> replacing it with the empty string, so its REVERT replaced the empty string --
> which matches at index 0 -- and silently corrupted `chart.tsx`, after which
> every later mutation "failed" for the wrong reason. Four verdicts were
> re-run against a repaired tree. The harness now refuses a mutation whose
> either side is empty.
>
> **CARRIED, MEASURED AND DELIBERATELY NOT FIXED:**
>
> - **Focus goes to `<body>` when the drawer closes**, confirmed on this path at
>   375px. It is the phase-level Radix finding (four state-driven `Dialog`
>   callers with no trigger to restore to, `task-drawer.tsx:46` among them),
>   pre-existing and desktop-visible, and explicitly out of bounds for this
>   phase.
> - **The sidebar clips long titles without an ellipsis.** `truncate` is on a
>   flex row whose text is an anonymous flex item, so the text is cut at the
>   border rather than ending in a marker. Pre-existing at 240px (the same
>   happens to a long title at a desk) and merely more frequent at 128px, so
>   fixing it is a desktop change.
> - **The label tap is 31px, not 32** -- `border-box` plus the row's bottom
>   border. One pixel, named so it is not rediscovered as a bug.
> - **A phone still has no way to see a dependency ARROW's direction** other
>   than reading it off the chart; the drawer lists predecessors, which is the
>   capability. Nothing is lost, but the two are not the same view.
>
> **HANDOFFS. Task 6:** new phone-only testids, one pair per task row --
> `gantt-tap-<taskId>` (the chart row) and `gantt-label-tap-<taskId>` (the name
> in the sidebar). Both are `display: none` at a desk, so a desktop journey
> cannot see them and a phone journey can rely on them; `gantt-bar-<taskId>`,
> `gantt-group-<id>`, `gantt-arrow-<pred>-<succ>`, `compact-button`,
> `compact-button-<projectId>` and `gantt-zoom` are unchanged at both widths.
> Three things that will otherwise cost a CI cycle. **(1)** The opening scroll
> means a phone journey does NOT start at `scrollLeft: 0`, so a fixture whose
> tasks are all in the past or all in the future opens somewhere specific --
> assert on the drawer, never on a pixel offset. **(2)** Driving the drawer's
> **Add dependency** picker needs Radix's own idiom: opening it leaves focus on
> the trigger, and a synthetic click on the option does not commit -- Playwright
> real input is fine, but if a journey ever reaches for `evaluate`, the item
> commits on ITS OWN Enter after `item.focus()`. **(3)** `window.confirm` gates
> both Remove-slack buttons, and the per-project one is now reachable at a phone
> viewport, so a journey that taps it needs a dialog handler. Worth pinning
> because nothing else re-checks them: that the bottom bar is hit-testable on
> `/gantt` (the tap-theft regression), and that six arrow presses on a focused
> bar change no dates at a phone viewport while Enter opens the drawer.
> **Everyone:** the sidebar's width is the only Gantt constant a stylesheet can
> take over -- `ROW_HEIGHT` and `pxPerDay` feed `rowTop` and the SVG arrow
> endpoints, and an SVG path cannot hold a `calc()`, so a phone-specific row
> height would mean re-deriving every arrow coordinate. That is why the row
> pitch, and therefore the 32px tap target, is what it is.

> **THE SPEC ROUND (compliant-with-issues), and it found a guard that protected
> the phone half of a rule and not the desktop half.** Every geometry number
> above survived independent measurement -- the 85 -> 247px, the 116.5x44
> button, the 127x31 label, both `scrollLeft` values, all four hit tests, and
> the CSS delta proven to be six real utilities by rebuilding the base in a
> scratch checkout and diffing the stylesheets. It also found the tap theft was
> WORSE than recorded here: pre-fix, a tap on the Mail tab did not merely do
> nothing, it returned `gantt-label-tap-<taskId>` -- it would have opened a task
> drawer. Five things were not right.
>
> - **THE GUARD BUG, and it is the one worth reading.** `phone.test.ts`
>   asserted `toContain("hidden")` against the element's whole opening TAG --
>   which contains `aria-hidden="true"`, **so the assertion passed on the
>   attribute**. Deleting the base `hidden` class from both tap layers left all
>   three assertions green. What that ships is a full-width, click-handling
>   rectangle over every row of the DESKTOP chart, rendered after the bars:
>   drag-to-reschedule, resize and dependency-dragging all dead. Nothing else in
>   the repo would have caught it -- **the suite has no pointer-drag coverage of
>   the Gantt at any viewport**, which is worth knowing well beyond this task.
>   Every class assertion now runs over a parsed class LIST (`classesOf`), which
>   an attribute cannot satisfy and which also tells `hidden` from
>   `max-md:hidden` -- a distinction a substring match cannot make either. The
>   review's exact mutation, re-run against the fix: `AssertionError:
>   gantt-tap-: expected [ Array(3) ] to include 'hidden'`. Each pointer zone
>   and both tap layers now also assert the ABSENCE of the unscoped class, so
>   the same hole cannot open from the other side.
> - **The clamp took its upper bound from the STARTS, not the spans.** Its own
>   docstring, this block and the commit message all said "the span of the
>   work"; the code said "the span of the starts". Measured on an ordinary
>   mid-project chart -- every task begun, one still running -- "today is after
>   every start" was true while the work was still going on, so the phone opened
>   on the last START: **3048 is where it opens now (today, day 102 x 30 - 12);
>   1308 is where it opened before, exactly 1740px and 58 days behind, with the
>   today line off screen.** That is the "opens on work that finished in March"
>   failure the clamp was argued into existence to prevent, reached from the
>   other end. `initialScrollLeft` now takes both of each bar's ends and bounds
>   by the latest DUE. The seven original unit tests could not catch it because
>   the function was never given a due date; there are now nine, two of them the
>   mid-project case and a long-bar case where the last task to start is not the
>   last to finish.
> - **The "no mis-tap band by construction" claim had a 1px exception.**
>   `gantt-today-line` is an ordinary div at `z-20`, painted above the tap
>   layers, so its single column of pixels took the tap and opened nothing --
>   and the opening scroll parks it a lead-in's width from the sidebar edge,
>   i.e. exactly where a thumb goes first. It is now untappable below the
>   breakpoint only (`max-md:pointer-events-none`); at a desk it lies over the
>   bars' own drag zones, where passing pointers through to them would change
>   what a click on it does. Measured after: a tap on the line returns
>   `gantt-tap-<taskId>`, and at 1280 the line is still `pointer-events: auto`.
> - **Two recorded measurements were wrong and are corrected above.** The
>   same-day milestone at week zoom is **6.42px**, not 12.9 -- 12.9 is
>   `WEEK_ZOOM_PX_PER_DAY` itself, and the bar measured had been rescheduled to
>   three days by this task's OWN drawer test minutes earlier, so the narrowest
>   bar on screen was a one-day bar. Re-measured on a restored same-day task:
>   15px at day zoom, **6.42px** at week, with all four hit tests still landing
>   on its row layer. And `chart.tsx`'s comment said 245px of timeline where
>   this block and the commit message said 247: 247 is right, because the side
>   borders come off with the corners.
> - **"Once per zoom value, never twice for the same one" was false** --
>   `appliedScrollZoomRef` holds one number, not a set, so day -> week -> day
>   re-applies. The behaviour is deliberate (each switch is a fresh request to
>   see the schedule at that scale, and after one you are looking at a different
>   set of columns anyway); the claim was not something one slot can promise.
>   Both the source comment and the paragraph above now say what it does.
>
> **Five more mutations run, all five red:** each tap layer stripped of its base
> class (the review's own, individually AND together), a resize strip given the
> unscoped class instead of the scoped one, the today line made untappable at
> every width, and the clamp's upper bound taken from the starts again.
>
> **RECORDED, NOT FIXED (for the phase findings).** Amendment 5's fallback route
> is itself under the touch floor: the link to a project's own Gantt page
> (`project-detail.tsx:198-204`) is a plain `<Link>` at `py-1.5 text-sm`, about
> 34px, which `Button`'s floor does not cover. The capability is reachable; the
> target is short. Task 2 residue that no task owned.
>
> **Round two: +3 tests (1821 -> 1824)**, typecheck clean on five projects,
> build clean with no CSS warning and **the stylesheet hash unmoved**
> (`index-CBvyyNUj`, 30.85 kB -- the today line's class already existed in the
> bundle, so nothing was added to it).

> **THE QUALITY ROUND (with fixes), and what it found was the guard file, not
> the feature.** The implementation came through both earlier rounds intact --
> the reviewer re-derived both round-two corrections, confirmed the clamp
> always lands inside the scroller by construction and that
> `SIDEBAR_WIDTH_CSS`'s interpolation makes drift impossible. Then it ran
> mutations against the FULL 392-test web suite and **five survived**, one of
> them a silent violation of the phase's hard requirement. All five now fail;
> each was re-run against the whole web package, not just this directory.
>
> | Mutation that survived | What it would have shipped | Now |
> |---|---|---|
> | tap layers rendered BEFORE the bars | the bar root paints above the layer, so on a phone a tap on the BAR -- the obvious target -- does nothing, and only empty row space opens the drawer; at a desk the dependency drag's hit test lands on an element with no `data-task-id` | **red** |
> | `max-md:relative` deleted from the sidebar row | every label span positions against the sticky sidebar instead of its row, so all N stretch over the whole sidebar and the last one takes every tap: **tapping any task's name opens the LAST task's drawer** | **red** |
> | a render-time `matchMedia` read added to `timescale.tsx` | the read guard counted `chart.tsx` only, and the hook-disguise loop covered two of the four files | **red** |
> | the mount read's `!` dropped | **the DESKTOP chart scrolls on mount and the phone stays at 0** -- a hard-requirement violation that leaves the read count at two and every other guard green | **red** |
> | `useLayoutEffect` -> `useEffect` | the offset lands after paint, i.e. as the visible jump the layout effect exists to avoid | **red** |
>
> The read guards now count over **every non-test source in this directory**
> (`ganttSources`), because the rule is the phase's and not one file's. Worth
> writing down beyond this task: **a render-time read is worse than an extra
> read**, not better -- it never re-runs on a breakpoint crossing, so it holds
> a stale answer for as long as the component stays mounted, which is the bug
> subscribing exists to prevent.
>
> **THE ORDERING DEFECT IN THE OPENING SCROLL, fixed -- and what I could not
> reproduce.** The effect claimed `appliedScrollZoomRef` BEFORE building
> `bars`, and guarded on `taskRows.length` instead, which is not the same test:
> a row whose task is missing either date contributes no bar. `bars` is built
> first now, an empty list returns before the slot is spent, and the row-count
> guard is gone -- it was dead, since no rows means the component has already
> returned its empty state. **The reviewer's concrete scenario I could NOT
> reach, and the DONE block should say so rather than claim a measurement it
> does not have:** `ganttPayload` filters on `isNotNull` for both dates, and
> `useShiftTask`'s optimistic patch only ever writes two strings, so a row
> without dates cannot reach this component. Measured on an all-undated
> project at 375px: the chart renders `gantt-empty` ("No dated tasks yet") and
> **no grid at all**, so the effect returns on `grid === null` and no slot is
> spent. The ordering was still wrong and is still worth fixing -- it was one
> payload change away from being reachable, and it cost nothing to make safe.
>
> **Two comments corrected.** `bar.tsx` said the resize strips are "1.5 and 2
> CSS pixels": those are utility names, and at this project's spacing scale
> they are **6 and 8** -- which the arithmetic further down the same file
> already said, so the file contradicted itself. And the Sidebar memo claim was
> false in general: the page builds `openTask` as a plain function declaration
> while its three siblings are `useCallback`s, so `Sidebar` re-renders on every
> page render, **including every drawer open and close**. The claim holds for
> the case it was written for and the only hot one -- a drag frame re-renders
> the chart from its own state without re-rendering the page -- and the comment
> now says exactly that. Wrapping the page's two handlers would make it general
> and is a one-line change in `gantt.tsx`, a file outside this task.
>
> **RECORDED, NOT FIXED (carried at the coordinator's direction):**
>
> - **The Remove-slack guard is vacuous in one direction.** That `Button`
>   carries no `className`, so `classesOf` returns `[]` and "does not carry
>   `max-md:hidden`" holds however the button is hidden. Demonstrated: putting
>   `max-md:hidden` on the wrapping toolbar div hides the compact button AND
>   the zoom control at phone widths, with the whole web suite green.
> - **`openingTagAround` inherits Task 2's attribute-order fragility.** It ends
>   its slice at the first `>` after the marker, and both tap layers' `onClick`
>   arrow contains one. Today every subject spells `className` before any such
>   attribute; reorder them and `classesOf` silently returns `[]`, so positive
>   assertions fail opaquely and negative ones pass vacuously. The hazard is
>   now written in the helper's own doc comment.
> - **Nested vertical scroll, unmeasured.** Above about 19 rows
>   (`GRID_MAX_HEIGHT` 640 / `ROW_HEIGHT` 32) the grid gains its own vertical
>   overflow, so a vertical swipe inside it scrolls the grid rather than the
>   page -- a scroll trap on a long project. This task's fixtures were three
>   and twenty rows; nobody has measured the trap itself.
> - **The tap layers are built, not skipped, at desktop, and are not
>   memoised** -- 200 rows means 200 elements and 200 closures rebuilt per
>   animation frame during a desktop drag, for something `display: none`.
>   Hoisting them into a memoised component would make it zero per frame.
>
> **Round three: +5 tests (1824 -> 1829)**, typecheck clean on five projects,
> build clean with no CSS warning, stylesheet hash unmoved (`index-CBvyyNUj`).
> Desktop re-verified after the reordering: `scrollLeft: 0`, sidebar 240, every
> tap layer `display: none`, the today line still `pointer-events: auto`, and a
> point on a bar still resolves through the move overlay to an element whose
> `data-task-id` is that bar's -- the dependency drag's hit test intact.

### Task 6: Phone-viewport e2e + release prep (v0.10.0)

**Files:** `e2e/mobile.spec.ts` (new), three package.jsons, `manifest.toml`, server lockfile.

The journeys, at a phone viewport via Playwright device emulation — these ARE the definition of done expressed as tests: navigate via the bottom bar AND the More sheet; look up a company and read its rail; read a mail thread through the drill-in stack and reply; move a deal between stages via the Move action; open a Gantt bar's task drawer and change its dates; log a meeting and add a follow-up task.

Reuse the suite's conventions: `runId` + per-attempt `${runId}x${testInfo.retry}` fixtures, loaded sentinels rather than bare absences, `typeIntoEditor` from `e2e/helpers.ts` for any rich-text field. **The existing 72 desktop tests must pass unchanged.**

**READ ALL FIVE DONE BLOCKS, not just this section.** This section predates Tasks 4 and 5 and was never updated: Tasks 1-3's facts are inlined here, but **Task 4's and Task 5's Task-6 handoffs exist only inside their own DONE blocks** — the stage-view testids, the `@fastify/static` restart fact, and all three Gantt cautions.

**CONTRADICTION, resolved here.** This section says "`toBeVisible()`/`toBeHidden()`, never `toHaveCount(0)` — with ONE exception". Task 4's DONE block records a SECOND: `column-<id>`, `board` and `DndLiveRegion` are genuinely absent below the breakpoint, so `toHaveCount(0)` is right for those. **The rule is: assert absence only where the element is genuinely not rendered** (the `conversation` testid at non-conversation levels; the kanban's desktop-only testids below the breakpoint). Everything hidden by CSS — the inbox panes, both Gantt tap layers at desktop — is `toBeHidden()`.

**From Task 5's quality review — six things about driving the Gantt:**
- **Drive the drawer from `gantt-label-tap-<id>`, not `gantt-tap-<id>`.** The row layer is `width: chartWidth` (1530px on the fixture) against a ~247px timeline; `locator.click()` clicks the centre of its VISIBLE INTERSECTION, which can fall inside the sticky sidebar's 128px band and be reported as intercepted. The label tap is 127x31, lives in the sticky sidebar, and is on screen at every scroll position. If you must drive the row layer, pass `{ position: { x: 20, y: 16 } }`.
- **`toBeVisible()` on a bar proves nothing about the opening scroll** — Playwright's visibility does not require viewport intersection, and `tasks.spec.ts:229` already asserts it at desktop. To prove Amendment 4, the assertion is **`toBeInViewport()`**.
- **Set the phone viewport with file-level `test.use({ ...devices["iPhone 13"] })` in `e2e/mobile.spec.ts`, NOT a `projects` array.** The config has no `projects` today; adding one re-homes the existing 72 tests, which the hard requirement forbids. File-level `test.use` still applies at context creation.
- Both tap layers are `aria-hidden="true"` — reachable by `getByTestId` only; `getByRole`/`getByText` will not see them.
- `window.confirm` fires on BOTH compact paths; Playwright auto-dismisses, so an unhandled dialog makes Remove-slack a silent no-op. The per-project button exists only on `/projects/$id/gantt`, not on `/gantt`.
- The drawer is a Radix `Dialog`: the chart behind is inert while it is open, and focus lands on `<body>` after close (a phase-level finding). Close it before touching the chart again; do not chain a focus assertion off the close. Consider a **>19-row fixture** — above 640/32 rows the grid gains its own vertical scroll, which is the one phone geometry nobody has measured.

**From Task 3's quality review — five things about driving the stack:**
- `inbox-back` is the testid at TWO levels (folders and conversation), so it does not identify the level. Pin the level with the `h1` text or with pane visibility.
- Use auto-retrying `expect(locator).toBeFocused()`. The focus move is a passive effect; a one-shot `page.evaluate(() => document.activeElement)` right after a click reads the pre-effect value.
- `toBeVisible()`/`toBeHidden()`, never `toHaveCount(0)` — with ONE exception: the `conversation` testid genuinely has count 0 at the folders and threads levels, because `<Conversation>` renders only when `?thread=` is set. The always-in-the-DOM rule applies to the pane `div`, not that testid.
- **Assert all three panes' visibility at each of the three levels**, not just the pane you are driving — a level->pane inversion is untested anywhere else, so your e2e is the only thing that will catch it.
- Do not build a fixture that can produce `?thread=` with an EMPTY value: it passes route validation, reads as a selection, and renders a whole phone screen holding only Back and Compose.

**From Task 2's quality review:** `dialog-close` is reliable and genuinely desktop-invisible (measured `height: 0` and unfocusable at 1280). Two asserts worth adding: the rail's **Meetings** tab reachable after ARROW-KEY focus (Task 2's reviewer could not settle this — the browser pane reported the document unfocused throughout, and Radix Tabs does not call `scrollIntoView` itself), and a real click-through of the search sheet's dismissal. And if you add a `data-testid` to any `DialogContent`, **put `className` first** or Task 2's caller guard silently stops applying to it.

**Four facts from Task 1's quality review, each of which would otherwise cost you a CI cycle:** `nav-pipelines`/`nav-projects`/`nav-gantt`/`nav-settings` exist ONLY while the More sheet is open (Radix does not `forceMount`) — open `bottom-nav-more` first. Set the phone viewport at CONTEXT CREATION via a device descriptor, never mid-test: the CDP resize path updates `matches` without dispatching `change`, so the hook never sees it. Do NOT write a journey that crosses the breakpoint with a sheet open — the branch unmounts the bar, the portal goes with it, a typed query is lost and focus drops to `<body>` (Radix's cleanups DO run, so it is a UX consequence rather than a stuck page). And the search sheet's dismissal is currently covered only by a source-reading guard; a real click-through journey is worth having.

Release prep: bump 0.10.0 (three package.jsons + manifest `0.10.0~ynh1`), regenerate the server lockfile (diff must be versions-only), push, confirm CI green on the FINAL tip, and prepare `release-notes-v0.10.0.md` + `release-sequence-v0.10.0.md` in the session scratchpad. **The sequence must reuse v0.9.1's corrected shape** — the digest step greps `[0-9a-f]{64}` (not the word `sha256sum`), the published asset is downloaded and re-hashed as a non-optional cross-check, the hand-written notes are put on the release explicitly, and the close-out covers the branch, the worktree and pulling `main` in the primary checkout. Do NOT merge, tag, or touch the manifest sha — the coordinator gates the release, and for this phase the gate waits for Chris to try it on his actual phone.

> **DONE.** As built:
>
> - **THE FILE: `e2e/mobile.spec.ts`, 24 tests in five serial groups, and the
>   72 that existed are untouched -- 72 -> 96.** No source file was changed by
>   this task: every surface the journeys drive was given a phone-only testid by
>   the task that built it, so the definition of done turned out to be
>   assertable without a single new hook into the app.
> - **THE VIEWPORT, and the one place the instruction could not be followed
>   literally.** File-level `test.use`, no `projects` array, exactly as
>   required. But `devices["iPhone 13"]` carries `defaultBrowserType: "webkit"`,
>   and `browserName` is a fixture that simply forwards it
>   (`playwright/lib/index.js:192-193`) -- so a whole spread would have moved
>   this FILE onto WebKit, which the e2e job does not install (`npx playwright
>   install chromium`, and only chromium). The run would have died on a missing
>   executable. The descriptor is therefore spread MINUS that one key, which
>   keeps the 390x664 viewport, `isMobile`, `hasTouch`, the device pixel ratio
>   and the iOS user agent, and leaves the worker options identical to every
>   other file's so nothing restarts a worker for nothing.
> - **THE GEOMETRY WAS MEASURED, at 390x664 in a browser against a build of this
>   branch on the dev server, before a line of it was asserted.** The chart's
>   grid is a 390x638 box over 1208x740 of content, so 22 rows really do overflow
>   it; the opening scroll lands at `scrollLeft: 498`, which is day 17
>   (today) x 30px minus the 12px lead-in, exactly as `initialScrollLeft`
>   computes it; the first bar sits at (110, 263) 90x22, so `toBeInViewport()`
>   has something to be true about; both tap layers compute `display: block`;
>   `compact-button` is 116.5x44; the drawer's close is 44x44; the account form
>   is a 390x664 sheet with `max-height: none` (the caller's `max-h-[85vh]` IS
>   overridden) and all eight fields; `thead` is `display: none` on the
>   companies list and the cells carry Name/Owner/Updated themselves; a
>   stage-less pipeline renders `board` with one `DndLiveRegion` and no
>   `stage-view`, and two stages later it renders `stage-view` with **zero** of
>   each.
>
>   **BE PRECISE ABOUT WHICH OF THOSE THE FILE ACTUALLY ASSERTS, because an
>   earlier version of this block said "every one of them" and that was false.**
>   **Asserted:** the grid's own overflow on BOTH axes, read off the chart's
>   scroll box rather than inferred from the page (a later round found the
>   inferred form vacuous -- see below); the opening scroll (`toBeInViewport()`
>   on the first bar); both tap layers' visibility; the drawer's close on both
>   axes against the 44px floor; `compact-button`'s HEIGHT against that floor;
>   `thead` hidden with a per-cell label visible beside it; `board` and
>   `stage-view` on BOTH sides of the first stage; and `column-` and
>   `DndLiveRegion` **only after** it.
>
>   **Measured but NOT asserted, and therefore context rather than coverage:**
>   the account form's `390x664` box and its `max-height: none` -- the most
>   interesting number in the list, since it is what stops the app's longest
>   form being clipped at 85vh, and nothing re-checks it; `compact-button`'s
>   116.5px WIDTH (only its height is asserted); the stage-less pipeline's
>   `DndLiveRegion` count of ONE and its `column-` count of zero (the file
>   asserts those only after the stages exist); and the exact pixel positions
>   above, which informed the assertions without being them. An earlier version
>   of this paragraph said all four of that group were asserted "on either
>   side", which the file contradicts -- two of them are one-sided.
> - **THE ONE MEASUREMENT THAT SAVED A CI CYCLE, and it is not the obvious one.**
>   With the page at rest, `gantt-label-tap-<last>` sits at viewport y 637-668
>   against a bottom bar occupying 619-664. Playwright reveals an element with
>   the SMALLEST scroll that works, so it would have left the row flush with the
>   viewport's bottom edge, under the bar, and the click would have been
>   reported as intercepted. `<main>`'s 6rem reservation is the fix: taking the
>   PAGE to its own end first puts that reservation between the chart and the
>   bar (measured after: the row lands at 536-567, and `elementFromPoint` at its
>   centre returns the tap layer itself), and the grid's remaining internal
>   scroll is then Playwright's to do safely.
> - **TWO ASSERTIONS DID COST A CYCLE, and both were the same mistake: a number
>   where the claim was a capability.** CI run 33146942529 was green on 90 and
>   red on these two.
>   - **The rail strip's spill is a FONT-METRIC ACCIDENT.** At 390px in Chrome on
>     macOS the five tab labels measure 349px inside a 342px box, so Meetings
>     hangs 7px over -- Task 2's 375px measurement reproduced. On the Ubuntu
>     runner the same five labels measure narrower, the strip FITS, and
>     `scrollWidth - clientWidth` is 0. Asserting the spill, or a `scrollLeft`
>     that could only follow from it, pinned the runner's font stack. What is
>     asserted now is the mechanism, which no font can move: below the breakpoint
>     the strip is its own horizontal scroll container (`overflow-x: auto`), so
>     wherever a spill appears it scrolls the strip and never the page. **This is
>     a phase-level finding, recorded above:** the strip is insurance, not a
>     permanent state, and on Chris's own handset the system font decides which.
>   - **"Nothing to compact" was simply false.** `compactSchedule` pulls every
>     MOVABLE task to the project's floor -- with no project start date, the
>     earliest start among its own dated tasks -- whether or not it has a
>     predecessor, so the task the previous test had pushed into next week came
>     back and the note read "1 task compacted". The assertion matches either
>     sentence now, because either one means the confirm was accepted and the
>     sweep ran; an unhandled dialog, which Playwright auto-dismisses, leaves the
>     note empty. Amendment 5's claim is reachability, and that is what is
>     asserted.
> - **THE SIX JOURNEYS, and what each is actually for.**
>   1. **The bar and the More sheet** (3 tests): all four primary destinations,
>      each reporting `aria-current="page"`; the four overflow destinations,
>      absent until `bottom-nav-more` is open and each closing the sheet behind
>      it, with More reporting `aria-current="true"` for a destination inside it;
>      and the search sheet driven end to end -- it opens focused on
>      `search-input` rather than on Close, and taking a result dismisses it,
>      which until now was covered only by a source-reading guard.
>   2. **A company, its list and its rail** (2 tests): the list is cards
>      (`thead` hidden, each cell carrying its own label) and the shell has no
>      `<aside>`; the create dialog carries `dialog-close`; and the rail's five
>      tabs are walked by ARROW KEY to the last one, which activates -- the
>      question Task 2's reviewer could not settle from a browser pane (see the
>      environment finding above for why).
>
>      **BE HONEST ABOUT WHAT THE VIEWPORT HALF OF THAT IS WORTH ON THIS
>      RUNNER: nothing.** `toBeInViewport()` on the Meetings tab is real
>      coverage only where the strip actually spills, and by this task's own
>      font-metric finding it does not spill on CI's Ubuntu -- so there every
>      tab intersects the viewport whether or not Radix scrolled anything, and
>      that assertion cannot fail. It earns its place on a font stack where the
>      strip is clipped, which is the case a phone is likelier to be in than
>      the runner. The ACTIVATION assertions beside it are what carry this test
>      everywhere.
>   3. **The kanban** (3 tests): a stage-less pipeline is the desktop branch and
>      says so; two stages later `board`, `column-<id>` and `DndLiveRegion` are
>      genuinely gone; a deal is created in the stage on screen, moved with
>      `move-<id>` -> `move-to-<id>`, and found under the other stage's picker
>      button, with the current stage never offered as a target. Both focus
>      contracts are pinned because nothing else re-checks them: the `h1` after a
>      move (the trigger left with its card) and the trigger after a Close.
>   4. **The Gantt** (7 tests): a 22-row fixture seeded over the API; the opening
>      scroll proved with `toBeInViewport()` rather than `toBeVisible()`; both
>      tap layers present; the bottom bar hit-testable over its Mail tab (the
>      tap-theft regression, which nothing else re-checks); **zoom and pan, which
>      is the other half of the brainstorm's decision for this surface** -- the
>      zoom asserted by the bar getting NARROWER rather than by a class on the
>      button pressed, and the pan by a wheel over the chart taking that bar out
>      of the viewport and bringing it back; four arrows and two Shift+arrows
>      changing no date and rendering no transform while **Enter still opens the
>      drawer**; a reschedule driven from `gantt-label-tap-<id>` through
>      `field-dates` with the bar's `title` following; **a DEPENDENCY added
>      through the drawer's picker** (see the bullet below, which is the
>      important one); the last of the 22 rows reached below the chart's own
>      fold, with that fold asserted on the grid's own scroll box; and Remove
>      slack tapped with a dialog handler.
>   5. **Meetings** (2 tests): logged from the rail with a guest and TipTap notes
>      through `typeIntoEditor`, read back, and a follow-up task added.
>   6. **The inbox** (7 tests): its own IMAP fixture and its own account, added
>      through the settings form AT THIS VIEWPORT (the app's longest form, and
>      nothing else in the suite renders it below the breakpoint); all three
>      panes asserted at all three levels; the heading taking focus on every
>      transition, including the folders->threads case where Back and Folders are
>      the same relabelled node; **a folder TAPPED**, which is the folder
>      screen's whole purpose and was reachable by nothing else -- `chooseFolder`
>      clears `foldersOpen` itself, `inbox-lib.test.ts` takes that flag as an
>      INPUT so it cannot say who clears it, and the drill-out test leaves by
>      Back; delete that one line and a phone user taps a folder and stays on the
>      rail with the whole suite green; a reply sent from the conversation level;
>      and a deep link landing straight on it.
> - **THE DEPENDENCY PATH, WHICH IS WHERE THE PHASE'S WHOLE CLAIM LIVES -- and
>   it holds, measured rather than assumed.** `bar.tsx` does not render the
>   dependency handle below the breakpoint, and the spec absorbs that removal
>   with one sentence: rescheduling and dependencies are "both also in the task
>   drawer". The reschedule half was proved end to end by Task 5 and by this
>   file; the dependency half was proved by neither until the spec review said
>   so. It is also this file's ONLY Radix Select, and `select.tsx` documents a
>   real trap in exactly this shape -- `position="item-aligned"` computes the
>   popup's place from the SELECTED item, and this picker is pinned at no
>   selection, which is the case that left `user-picker.tsx` unplaced.
>
>   **Measured at 390x664 on a live build, with 21 candidates in the list:** the
>   popup's wrapper is `position: fixed` at (24, 424), the listbox is 286x220 at
>   (24, 434) -- bottom edge 654 against a 664 viewport, so it is placed and
>   fully on screen -- and each option is 44px tall, which meets the floor a
>   menu item is named for. Choosing one commits to the trigger, `Add` sends it,
>   `dependency-list` goes from "No dependencies" to the task plus its Remove,
>   and the chart behind draws `gantt-arrow-<pred>-<succ>`. **So there is no
>   capability exception and the trap did not bite** -- item-aligned positioning
>   fails when there is NO item to position against, and `user-picker.tsx` can
>   legitimately offer an empty list where this picker, on any project with two
>   tasks, cannot. The degenerate case (a one-task project, so no candidate at
>   all) is untested and is equally degenerate at a desk.
> - **THE ONE JOURNEY ASSERTION THAT IS A SUBSTITUTE, said plainly.** Task 3
>   asked for "open a thread from page two, Back, count the rows" -- the property
>   the hide-don't-unmount decision rests on. The thread list's default page is
>   **50** (`services/mail-threads.ts`'s `DEFAULT_LIMIT`), not 25, so reaching
>   page two needs 51 seeded threads: a minute of IMAP APPENDs and a much longer
>   first sync, for one assertion. What the file does instead is stamp an
>   attribute on the live `thread-list` NODE, drill in, reply, come back, and
>   assert the attribute survived -- an unmount and remount would have replaced
>   that element. That proves the mechanism the accumulator depends on; it does
>   NOT prove the accumulator's own state, and the file says so where it does it.
> - **The mail fixture is deliberately its own.** It archives whatever live
>   accounts it finds first (a second account on the same mailbox ingests every
>   message twice into the same thread, which is the one thing run-id scoping
>   cannot fix), then seeds a two-message References chain and adds an account.
>   The IMAP/SMTP coordinates are DUPLICATED from `mail.spec.ts` rather than
>   lifted into `helpers.ts`, because moving a constant out of that file would
>   have changed it and the hard requirement is that it does not change.
> - **Release prep, prepared and NOT executed.** 0.10.0 across the three
>   package.jsons and `0.10.0~ynh1` in the manifest; the server lockfile
>   regenerated on the dev server and inspected -- three lines, all versions.
>   The manifest's `url`/`sha256` deliberately still point at v0.9.1: that
>   tarball exists and v0.10.0's does not. `release-notes-v0.10.0.md` and
>   `release-sequence-v0.10.0.md` are in the session scratchpad; the sequence
>   reuses v0.9.1's four corrections verbatim and its step 7 is rewritten as a
>   PHONE walkthrough, because for this phase the gate is Chris's handset and
>   not a green pipeline.
> - **Suite: 1829 unit + 36 skipped (unchanged -- this task added no unit test,
>   and had no lib to test), typecheck clean on five projects, `npm run build`
>   clean with no CSS warning and the stylesheet hash unmoved
>   (`index-CBvyyNUj`, 30.85 kB), e2e 72 -> 96 with the 72 untouched.**
>   The 20-test form of this file was proved in CI on **run 33147238771** (tip
>   b07ef4d): both jobs green, e2e 92 passed in 55.4s with no flaky line, and
>   test 1865 passed across 51 files (the 1829 plus the 36 MAIL_IT integration
>   tests CI provisions mail servers for). The spec review's four additional
>   tests came after it. A commit cannot name the run of the commit that
>   contains it, so **the run covering the FINAL tip -- and therefore the 96 --
>   is cited in `release-sequence-v0.10.0.md`**, which is untracked and can
>   name it.
>
> **THE QUALITY ROUND, and what it found was two claims rather than two bugs.**
> The file held where it counts: five deliberate defects -- including both of
> the newest tests and the phase's own worst bug -- each caught for the right
> reason with the right error, no vacuous negatives, and 23/23 across nine
> isolated runs with retries off, which settles that the zero-retry result is
> structure rather than luck. What it broke were two comments that outran their
> assertions, and both are now true rather than softened:
>
> - **THE PAN DID NOT PIN WHAT IT SAID IT PINNED.** Its comment claimed the two
>   wheels proved Task 5's guarantee -- that nothing re-applies the opening
>   offset at an unchanged zoom -- and deleting `chart.tsx:521`, the
>   `appliedScrollZoomRef` guard that is the whole of that guarantee, left the
>   Gantt group at 7/7. The reason is exact: a wheel triggers no React render,
>   and the layout effect's deps are `[taskRows, pxPerDay, rangeStartMs]`, so
>   the guard is never REACHED in the window a pan observes. Made true rather
>   than dropped, because the guarantee is real and was tested nowhere: the
>   test now provokes a REFETCH between the two wheels -- a progress edit from
>   the drawer, chosen because `useInvalidateTask` invalidates `["gantt"]` while
>   progress moves no date and so cannot move `rangeStartMs` and make the re-run
>   legitimate -- and asserts the chart's `scrollLeft` is exactly where the pan
>   left it. That is the SSE-update-mid-pan case in miniature. **Re-run against
>   the fix, the same deletion now fails it.**
> - **THE LAST-ROW TEST ASSERTED THE PAGE'S FOLD, NOT THE GRID'S.**
>   `GRID_MAX_HEIGHT = 640 -> 4000` removes the nested scroller outright and the
>   test stayed at 7/7, because `not.toBeInViewport()` follows from the page
>   being taller than the viewport whether or not the grid clips anything, and
>   the manual `scrollTo` reveals the row either way. So the nested vertical
>   scroll was still the geometry nobody had measured. It is now read off the
>   chart's own scroll box (`scrollHeight > clientHeight`, and `scrollWidth >
>   clientWidth` beside it, which doubles as the check that the helper did not
>   walk up to `<main>`). **Re-run against the fix, the same mutation now fails
>   it.**
> - **Also this round:** `toBeInViewport()` is `ratio > 0`, i.e. ANY
>   intersection, so the dependency popup's "fully on screen" claim is now
>   `{ ratio: 1 }` where that is what is meant and stays bare where it is not
>   (an option inside a scrolling list, and a tab that is SUPPOSED to be partly
>   clipped on a spilling font stack); the comment naming the chart's row order
>   said "by start date, then title" where `ganttPayload` orders by POSITION,
>   which is creation order for this fixture -- every index into `taskIds` was
>   correct BECAUSE the comment was wrong, the worst version of that class; the
>   file header's "touches no other spec" is now "edits no other spec file",
>   since the inbox group does touch state `mail.spec.ts` owns; and that
>   group's archive loop is now GUARDED rather than merely commented -- it
>   refuses to run at more than one worker, because a label or address filter
>   would not contain the hazard, it would defeat the block (the account it
>   most needs to stop is exactly `mail.spec.ts`'s, on the same mailbox).
> - **One optional taken:** a source guard that reads `mail.spec.ts` and fails
>   if it stops reading any of the six `E2E_MAIL_*` variables this file
>   duplicates. Worth it because that duplication drifts SILENTLY -- every read
>   has a `?? default` and the defaults are the values CI sets, so a rename in
>   one file changes nothing until somebody points the suite at a mailbox that
>   is not on the default ports.
>
> **RECORDED, NOT FIXED.**
>
> - **The desktop half of each phone-only rule is asserted by the unit guards,
>   not here.** A journey cannot cross the breakpoint mid-test (the hook would
>   never see it), so this file can say `gantt-label-tap-<id>` is visible at
>   390px and cannot say it is hidden at 1280. `gantt/phone.test.ts` and
>   `ui/ui.test.ts` are what hold that half, over source rather than over a DOM.
> - **ONE Radix Select is driven on a phone, and it is the drawer's dependency
>   picker.** That one is measured and asserted (above). The others are not: the
>   composer's From select, the drawer's type/status/assignee, the meeting
>   form's colleague picker and the inbox's account filter are all driven at a
>   desk by other specs and never at this width. They share the primitive, so
>   the positioning finding transfers; the empty-list case that primitive
>   actually fails on does not, and `user-picker.tsx` is the caller that can
>   reach it.
> - **The Gantt fixture is 22 identical-shaped bars**, and it is not a realistic
>   schedule: no summary rows, no done tasks, and exactly one dependency, added
>   by the journey itself rather than seeded. It is enough to make the grid
>   overflow, enough to put a bar under today, and enough to draw one arrow. A
>   chart with overlapping arrows, group headers and frozen in-progress rows is
>   still unexercised at this width.
> - **The 22 tasks are seeded over the API.** `tasks.spec.ts` creates its three
>   through the UI and this file does not; the trade is stated in the test and is
>   about runtime, not about coverage, since the journey itself is all UI.

---

Sequencing: 1 first (everything depends on the breakpoint and the hook). 2, 3, 4, 5 are independent of each other and each depends only on 1 — but they must run ONE AT A TIME, not concurrently: they share a worktree and a dev server, and a v0.9.1 review found a concurrent agent's work-in-progress contaminating another's server runs. 6 last. Each task: implement → adversarial spec review → quality review, the standing loop.
