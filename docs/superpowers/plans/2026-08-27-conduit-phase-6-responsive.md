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

The move must go through the **existing** deal-move service path — never a second one — so the compactor, SSE and optimistic-update behaviour are unchanged. `board-lib.ts` holds the move-target list (pure, tested: the current stage is excluded, order matches the pipeline, an archived pipeline offers none).

Above the breakpoint the board is untouched — including its drag-and-drop. ~8 tests.

### Task 5: The Gantt, read-only on a phone

**Files:** `packages/web/src/components/gantt/*`.

Below the breakpoint the chart renders **read-only with pan and zoom**, and **tapping a bar opens the task drawer** (where dates and dependencies are both editable — this is what makes the phase's no-capability-gap claim true, so verify it end to end rather than assuming).

**A drag must not appear to start.** If touch drag is unsupported, the bar must not show a drag affordance or move under the finger and snap back — that is worse than a plain tap target.

**FROM TASK 2's QUALITY REVIEW:** the task drawer's ✕ is the ONLY exit on a phone (full-screen, no outside to click, no Escape key) and measured 34.7px wide — Task 2's round is flooring it, but **verify it before you build the Gantt→drawer path**, or the no-capability-gap claim you are asked to prove end to end rests on a control that fails the phase's own touch floor. Also: `field-dates` wraps to FOUR lines at 375px with the `→` orphaned alone on one of them (Task 2 is hiding it below the breakpoint); the path works, but re-measure rather than trusting this note.

**INHERITED FROM TASK 1's review:** the Gantt's own `sticky` elements carry `z-20`/`z-30` (`gantt/chart.tsx:240,242`; `gantt/timescale.tsx:82,136`) and are NOT portalled. `<main>` is not a stacking context (`overflow-auto` alone does not create one), so they participate in the root stacking context above the bottom bar's `z-index: auto` and can paint OVER it — the bar's bottom padding keeps ordinary content clear but not these. Every other overlay in the app is portalled to the end of `<body>` and lands above the bar for free; the Gantt is the exception.

Above the breakpoint, unchanged: drag-to-reschedule, dependency editing, the compactor. ~6 tests.

### Task 6: Phone-viewport e2e + release prep (v0.10.0)

**Files:** `e2e/mobile.spec.ts` (new), three package.jsons, `manifest.toml`, server lockfile.

The journeys, at a phone viewport via Playwright device emulation — these ARE the definition of done expressed as tests: navigate via the bottom bar AND the More sheet; look up a company and read its rail; read a mail thread through the drill-in stack and reply; move a deal between stages via the Move action; open a Gantt bar's task drawer and change its dates; log a meeting and add a follow-up task.

Reuse the suite's conventions: `runId` + per-attempt `${runId}x${testInfo.retry}` fixtures, loaded sentinels rather than bare absences, `typeIntoEditor` from `e2e/helpers.ts` for any rich-text field. **The existing 72 desktop tests must pass unchanged.**

**From Task 3's quality review — five things about driving the stack:**
- `inbox-back` is the testid at TWO levels (folders and conversation), so it does not identify the level. Pin the level with the `h1` text or with pane visibility.
- Use auto-retrying `expect(locator).toBeFocused()`. The focus move is a passive effect; a one-shot `page.evaluate(() => document.activeElement)` right after a click reads the pre-effect value.
- `toBeVisible()`/`toBeHidden()`, never `toHaveCount(0)` — with ONE exception: the `conversation` testid genuinely has count 0 at the folders and threads levels, because `<Conversation>` renders only when `?thread=` is set. The always-in-the-DOM rule applies to the pane `div`, not that testid.
- **Assert all three panes' visibility at each of the three levels**, not just the pane you are driving — a level->pane inversion is untested anywhere else, so your e2e is the only thing that will catch it.
- Do not build a fixture that can produce `?thread=` with an EMPTY value: it passes route validation, reads as a selection, and renders a whole phone screen holding only Back and Compose.

**From Task 2's quality review:** `dialog-close` is reliable and genuinely desktop-invisible (measured `height: 0` and unfocusable at 1280). Two asserts worth adding: the rail's **Meetings** tab reachable after ARROW-KEY focus (Task 2's reviewer could not settle this — the browser pane reported the document unfocused throughout, and Radix Tabs does not call `scrollIntoView` itself), and a real click-through of the search sheet's dismissal. And if you add a `data-testid` to any `DialogContent`, **put `className` first** or Task 2's caller guard silently stops applying to it.

**Four facts from Task 1's quality review, each of which would otherwise cost you a CI cycle:** `nav-pipelines`/`nav-projects`/`nav-gantt`/`nav-settings` exist ONLY while the More sheet is open (Radix does not `forceMount`) — open `bottom-nav-more` first. Set the phone viewport at CONTEXT CREATION via a device descriptor, never mid-test: the CDP resize path updates `matches` without dispatching `change`, so the hook never sees it. Do NOT write a journey that crosses the breakpoint with a sheet open — the branch unmounts the bar, the portal goes with it, a typed query is lost and focus drops to `<body>` (Radix's cleanups DO run, so it is a UX consequence rather than a stuck page). And the search sheet's dismissal is currently covered only by a source-reading guard; a real click-through journey is worth having.

Release prep: bump 0.10.0 (three package.jsons + manifest `0.10.0~ynh1`), regenerate the server lockfile (diff must be versions-only), push, confirm CI green on the FINAL tip, and prepare `release-notes-v0.10.0.md` + `release-sequence-v0.10.0.md` in the session scratchpad. **The sequence must reuse v0.9.1's corrected shape** — the digest step greps `[0-9a-f]{64}` (not the word `sha256sum`), the published asset is downloaded and re-hashed as a non-optional cross-check, the hand-written notes are put on the release explicitly, and the close-out covers the branch, the worktree and pulling `main` in the primary checkout. Do NOT merge, tag, or touch the manifest sha — the coordinator gates the release, and for this phase the gate waits for Chris to try it on his actual phone.

---

Sequencing: 1 first (everything depends on the breakpoint and the hook). 2, 3, 4, 5 are independent of each other and each depends only on 1 — but they must run ONE AT A TIME, not concurrently: they share a worktree and a dev server, and a v0.9.1 review found a concurrent agent's work-in-progress contaminating another's server runs. 6 last. Each task: implement → adversarial spec review → quality review, the standing loop.
