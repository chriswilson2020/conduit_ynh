# Conduit — consolidated backlog

**Supersedes `docs/superpowers/plans/2026-08-21-conduit-roadmap-post-v0.8.0.md`**, which
predates Phases 6 and 7 entirely and describes a v1.0 that has since shipped.

Everything here has evidence attached — a file and line, a measurement, or the review that
found it. Items without evidence are marked as judgement rather than fact. Where one item
blocks another, that is stated rather than left to be rediscovered.

Current shipped version: **v1.2.0**. In flight: **nothing**; next is **v1.2.1**, whose
scope is fixed and recorded below.

---

## Scheduled

| | What | State |
|---|---|---|
| ~~**7.5 → v1.2.0**~~ | Keyboard-operable rows, the composer's focus, focus after a dialog closes, the `mail-sync` intermittent, and the touch floors folded in as Task 4b | **SHIPPED 30 Aug** |
| **v1.2.1** | Three defects, scope fixed by Chris on 30 Aug -- see "v1.2.1 scope" below | Decided, not specced |
| **7.6 → v1.3.0** | Export and encrypted backup, downloadable from Settings | Specced, not started |
| **7.7** | Restore and import, with its decisions already recorded in 7.6's spec | Decided, not specced |
| **Phase 8** | M365 mail via Graph, Gmail XOAUTH2 behind it | **Trigger-based** — jumps the queue the day the Listerdale tenant needs syncing |
| **Phase 4.4** | Mail filing power tools: per-message selection, arbitrary folder moves, folder management, bulk unhide, live inbox beyond page one | Unspecced. Overlaps "emailing a quote" below |

---

## v1.2.1 scope -- decided by Chris, 30 Aug, on the v1.2.0 release

Three defects in, two out. All five are already written up in full under "Defects found and
deliberately deferred" below; this section decides which of them move, and does not restate
the evidence.

**IN:**

1. **The reply signature silently lost on a cold accounts cache.** `composer.tsx` stamps its
   guard key before discovering whether a signature exists, so the epoch-1 pass on a cold
   `useMailAccounts` claims the key with `sendableAccounts` still `[]` and the pass that runs
   when the accounts arrive returns early on that same key. A warm cache hides it completely,
   which is why it has never been seen in use.

   **A NOTE FOR WHOEVER TAKES IT, because the fix reorders two things that another file's
   option exists to survive.** Fixing this moves the signature append to a pass **after** the
   caret placement. That is exactly the case `rich-text.tsx`'s `updateSelection: false`
   covers, and today it is load-bearing only on the account-switch path, which is where it is
   tested. After this fix it is load-bearing on the reply path too. **Check that guard still
   holds before shipping the reorder**, and if the order is ever reversed again, fix the
   option's test first. `composer.tsx`'s pending-body-focus comment currently asserts the
   append happens before the caret placement -- true on a warm cache only, and it will need
   correcting with the fix.

2. **A deal's or project's Mail tab can compose with no recipient.** `rail/mail.tsx` resolves
   the contact through a two-deep query chain from a deal or project tab, and `compose()`
   reads it at click time, so a click before both queries land seeds `to: []`. The fix is to
   disable Compose until the queries it reads have settled, which removes the silent
   wrong-recipient case and not merely the focus symptom. **No test covers the deal or project
   tabs at all** -- `composer-focus.spec.ts` uses a contact, whose chain is one deep -- so this
   one needs coverage written, not just a fix.

3. **`({{contact.pronouns}})` renders empty brackets** for a contact with none. Swallowing a
   following space handles `Dear X Y` and nothing short of conditionals handles brackets or
   labels. The document template already has `{{#path}}...{{/path}}`; the mail merge does not.
   v1.1.0's ruling was to document the limitation rather than grow the template language
   mid-release -- v1.2.1 is where that ruling is revisited, not overturned by default.
   **Outcome: revisited and DEFERRED AGAIN with a measurement** (v1.2.1 plan, Task 3).
   13 of the mail merge's 26 documented behaviours conflict with the document engine, and
   its "no record in scope" rule has no block form, so the port would have to invent a
   second dialect. The limitation stays documented, and the Settings page's claims about
   empty fields are now derived from the substitution rather than typed beside it. The
   full entry is in the deferred list below.

**EXPLICITLY OUT, and both for reasons about scope rather than severity:**

- **Focus lost after any navigation that unmounts the focused element.** This is the biggest
  item on the deferred list and it is out of v1.2.1 precisely because of that. The fix is a
  route-change concern, so it touches every page in the app, and it would let two hand-rolled
  cases in `inbox.tsx` and `board.tsx` go at the same time. **It earns its own release**; it
  does not belong in a three-defect patch. Note that it is NOT the five dialog roots -- those
  are one entrance to it, and fixing them alone would make them the only navigations in the
  app that land anywhere, while row links remain the commoner path to the same pages.
- **The GIF dimension undercharge.** This is hardening on a ceiling that held. The worst of
  the four variants ran at **59% of the 512MB kernel limit**; the other three were stopped by
  it outright. Worth fixing, and worth fixing where a payload-size discussion is already open
  rather than in a patch release about mail and templates.

---

## Scope decision, 30 Aug: the quote is the only document Conduit produces

**Invoices are out, on principle.** An invoice is a financial record — legal retention,
unbroken numbering for the tax authority, VAT returns, payment reconciliation. That is
accounting software's job, and issuing them here would make two systems both claim to know
what is owed. A quote is a sales document made while working a deal, which is what a CRM is
for.

This **removes the `companies` VAT blocker entirely**: that prerequisite existed only
because an invoice needs the recipient's VAT number. A quote does not. (Note the two were
easy to confuse: `org_profile.vat_number` is the ISSUER's and already prints in every
quote's footer; `companies` has no VAT field, and that only ever mattered for invoices.)

**Proposals are out too.** They were kept for a day on the grounds that they are a sales
document, then dropped once the implementation reality was clear: a quote's body is
GENERATED from structured line items, while a proposal's body is WRITTEN prose, different
every time, and Conduit has nowhere to put it. "Proposals reuse the same machinery" was
never true beyond the letterhead. In practice they are written in Word and are far more
detailed than a merge-field template should attempt.

**What already serves that need:** a Word or PDF proposal attaches to the deal today via
the Files tab, appears on the record, and is included in a backup. The only friction is
emailing it — which is the "emailing a quote" item below, and covers proposals for free.

**Consequence for the code, recorded so nobody completes the abstraction.** The document
machinery is deliberately type-generic — `documents.type` has a widen-ready CHECK,
numbering is per type per year, `documents-number.ts` carries a prefix map. **There is now
no planned second type.** Leave the generality (removing it is churn with no benefit) but do
not build FOR a second type, and treat comments that say "when invoices land" as historical
rather than as a plan.

---

## Phase 9 — four more document types (agreed 30 Aug, unspecced)

**Meeting summary, project status report, NDA and mutual NDA, and a plain letter on the
letterhead.** Selected against the test the scope decision above implies: a document belongs
here when **Conduit already holds its content in structured form**. That is why these four
qualify and proposals did not.

They are not four variations on the quote. Between them they exercise three different
content sources, and that is the phase's real shape:

| Type | Source of content | Extra input needed |
|---|---|---|
| Meeting summary | a `meetings` row — title, date, attendees, notes (already TipTap HTML) | none |
| Project status report | a `projects` row plus its tasks, dates and Gantt state | possibly a date range |
| NDA / mutual NDA | a company and/or contact | a small form: effective date, term, jurisdiction |
| Letter | a company and/or contact | a rich-text body the user types |

So a document type is **(a source of structured data) + (a form for whatever the CRM does
not know) + (a template)**. The quote is deal + line-item form + template. With five
instances the generic engine is probably worth building rather than five bespoke paths —
but that is a brainstorm decision, not a foregone one.

**Two structural facts that will shape it, both found while agreeing the list:**

1. **`documents.deal_id` is `NOT NULL`.** A meeting summary belongs to a meeting, a status
   report to a project, an NDA to a company, a letter to anyone. The FK model has to widen,
   and this schema already contains three different answers to that question — see the
   table under Phase 10 below, which enumerates them. Which one applies is a real decision
   rather than a detail, and Phases 9 and 10 face it independently.
2. **Immutability is per type, not universal.** A quote is frozen because you sent somebody
   a price. A **status report** you would legitimately want to regenerate next month, and a
   **letter** may want redrafting before it goes. Phase 7's "an issued document never
   changes" is a property of the quote, and treating it as a property of documents in
   general would make three of these four annoying to use.

**Related, smaller:** numbering is per type per year and generalises — but `QUO-2026-0001`
suits a quote and probably suits nothing else here. Whether an NDA or a letter wants a
sequence at all is a per-type decision, and the machinery already permits either.

**Everything hardened in Phase 7 and v1.0.1 is reused unchanged**: the renderer with its
three file-read controls and kernel memory ceiling, the sanitiser, the merge engine with
`{{#path}}` blocks, content-addressed storage, and the seeded-template migration pattern.
The expensive parts are done.

---

## Phase 10 - time tracking and timesheets (agreed 30 Aug, unspecced)

Record time against work, and see it back as a timesheet.

**Two structural facts, read out of `schema.ts` rather than assumed:**

1. **`meetings.duration_minutes` already exists** (Phase 5, nullable because not every
   logged meeting has a known length). Conduit therefore ALREADY HOLDS TRACKED TIME -- a
   logged meeting with a duration is a recorded hour, just never aggregated. **A timesheet
   that ignores it under-reports the week; one that counts it alongside a manual entry for
   the same hour double-counts.** That is a day-one decision, not a later refinement.
2. **`tasks` has no effort or estimate column.** It carries `start_date`, `due_date`,
   `completed_at`, `status` and `progress_pct` -- dates and a percentage, never a quantity
   of work. "Booked versus estimated", which is usually the point of tracking time against
   tasks, needs a column adding before it can exist at all.

**The precedent to copy is a three-way choice, not a two-way one.** Exactly five tables carry
the same four foreign keys -- company / contact / deal / project -- and they enforce three
DIFFERENT rules over them:

| Tables | Rule | Constraint |
|---|---|---|
| `notes`, `files` | exactly one | `num_nonnulls(...) = 1` |
| `meetings` | at least one | `num_nonnulls(...) >= 1` |
| `tasks`, `mail_threads` | any subset, including none | no CHECK at all |

(`events` is NOT a sixth member of that family and is the wrong thing to copy: it carries
**seven** entity FKs -- those four plus `task_id`, `meeting_id` and `mail_thread_id` -- and
no link CHECK. It is a log of things that happened to rows, not a row that belongs to
something.)

An hour can legitimately belong to a project AND the deal it came from, so exactly-one is
wrong here. The live question is `meetings`' rule against `tasks`': **is an hour attached to
nothing a legal row?** Answer it in the schema, because the reporting consequence is the
whole feature -- unattached time is time that never appears in any report and can only be
found by SQL.

**Questions the brainstorm has to settle, none of them obvious:**

- **What do you book against?** A task is the natural unit, but not all work is a task --
  admin, a sales call, travel. See the rule choice above.
- **Timer or after the fact?** A start/stop timer is nicer, and brings running state to
  store plus the "left a timer going over the weekend" problem. Post-hoc duration entry is
  simpler and is what most people actually do. Both is a bigger feature than either.
- **Do meetings become time entries automatically**, or stay separate and get summed at
  report time? See fact 1 -- whichever is chosen, **the other must be impossible rather
  than merely discouraged**, or the week's total is quietly wrong.
- **Billable or not, and at what rate.** Invoicing is ruled out of Conduit, so billable time
  here feeds REPORTING AND EXPORT, not billing. Rates would touch the products/rate-card
  item already on this list.
- **Timesheet shape.** A weekly grid (days across, projects down) is the classic and is the
  hardest thing to get right on a phone; a list is easier and less useful. No approval
  workflow -- single user.

**What it connects to, already on this list:**

- **Phase 9's project status report** would naturally carry time booked against the project.
- **The quote becomes comparable to reality**: quoted line items against hours actually
  spent is the margin question, and neither half exists without this.
- **7.6's export must include time entries**, or a timesheet is trapped in the app.

---

## Defects found and deliberately deferred

**THE SERVER CAN STORE A SIGNATURE ITS OWN RESPONSE SCHEMA REJECTS, AND THE WEB CLIENT
THEN FAILS ON EVERY `GET /api/mail/accounts` FOR THAT USER -- found during v1.2.1 Task 1,
outside that commit's subject.** `mailAccountUpdateInputSchema`'s `signatureHtml` is
`nullableString` (`z.string().min(1).nullable()`), so `PATCH /api/mail/accounts/:id` with
`{ signatureHtml: "<script>alert(1)</script>" }` is accepted; `sanitizeMailHtml` strips it
to `""`; and `""` is what gets stored. On the way back out, `mailAccountSchema` applies the
same `min(1)`, so `parseWith` throws a `ResponseShapeError` and `useMailAccounts` errors --
for the composer, the inbox and the settings page alike -- until the row is repaired
directly in the database. The write validates the INPUT and the read validates the OUTPUT,
and nothing validates the sanitizer's effect in between.

*Not in scope for the signature-guard fix, which is a client-side ordering defect.* The
repair is server-side and there is a choice to make: reject a payload that sanitizes to
empty (a 422 the settings page would have to render), or store `NULL` for it (silent, and
consistent with what the settings UI already does with a blank editor on its own way in).
The same shape may exist on other sanitized-then-stored fields; template bodies are the
obvious neighbour to check.

**A NAVIGATION THAT UNMOUNTS THE FOCUSED ELEMENT LEAVES THE CARET ON `<body>` -- found
during 7.5 Task 3, deliberately not fixed there, and it is bigger than the dialogs that
exposed it.** Measured at 1280: click a company ROW LINK, land on the record, and
`document.activeElement` is `<body>` -- the anchor unmounted with the list and TanStack
Router moves focus nowhere. A SIDEBAR link, whose anchor survives the navigation, keeps
focus on itself, which is what isolates the rule: it is not "navigation", it is "the
focused element went away".

**Five `<Dialog>` roots -- seven dialog surfaces -- are one entrance to it** and were left
alone for that reason (`entity-table.tsx`'s New is one root that companies, contacts and
projects share):
`entity-table.tsx`'s New (companies, contacts, projects), `pipelines.tsx`, both of
`company-detail.tsx`'s, and `project-detail.tsx`'s all `navigate()` in `onSuccess`. Each
was measured landing on `<body>`. `components/ui/dialog-focus.ts` would fix all five roots
in one line each -- deliberately not applied, because that would make them the only
navigations in the app that land anywhere, and row links are by far the commoner path to
the same destination pages. Each of the five roots carries a comment saying so.

**Fix, when it is taken:** move focus on route change, once, where the router can see
every navigation -- `<main>` already carries `tabIndex={-1}` for the dialog work, and
`pages/inbox.tsx` and `pages/board.tsx` already do the same thing by hand for their own
phone screen changes. That would let those two hand-rolled cases go as well.

**A GIF undercharge — v1.0.2's first item.** A **37-byte** GIF whose logical screen
descriptor claims 8000x8000 but which fails the trailer check returns `null` from
`gifSize`, is charged `length * 8256` = 429,312 pixels, and Pillow opens it at **64
megapixels — it renders, at 302MB**. Three larger variants (10000, 13000, and one simply
*missing its trailer*, which is a real artifact rather than a crafted one) are all stopped
by the 512MB kernel ceiling. Random fuzzing found the same mechanism in 5 of 185 cases.
**Fix:** fall back to the screen descriptor's dimensions instead of `null` on those four
paths, which would have charged all four 64-169Mpx and refused every one. Also correct
`shared/src/index.ts:2542`, whose justification — that the fetcher's signature check
catches what the arithmetic cannot — does not hold for a payload that *starts* `GIF89a`.
**This is the ceiling working**: the worst variant ran at 59% of the limit rather than
taking the server down.

**A reply's signature is silently lost on a cold accounts cache -- found during 7.5 Task 2,
deliberately not fixed there.** `packages/web/src/components/mail/composer.tsx:265-273`
stamps its guard key **before** discovering whether a signature exists:

```
if (editorEpoch === 0 || selectedAccountId === null) return;
const key = `${editorEpoch}:${selectedAccountId}`;
if (signedFor.current === key) return;
signedFor.current = key;                       // <- stamped here
const signature = sendableAccounts.find(...)?.signatureHtml;   // <- looked up after
if (signature == null || signature === "") return;
```

`selectedAccountId` is `accountId ?? sendableAccounts[0]?.id ?? null`, and `accountId`
starts at `seed?.accountId`. **The reply path sets that seed** (`conversation.tsx`'s
`seedAccountId`), so on a cold `useMailAccounts` cache `selectedAccountId` is a real id
while `sendableAccounts` is still `[]`. The epoch-1 pass therefore stamps the key, finds no
account, appends nothing, and the pass that runs when the accounts arrive returns early on
the same key. A warm cache hides it completely, which is why it has never been seen: open
the inbox first and the query is already populated. **Fix:** stamp `signedFor.current` only
on the paths that actually append, or key the guard on the resolved account object rather
than on the id.

**It interacts with Task 2's work, in both directions.** `composer.tsx`'s
pending-body-focus comment says that on the epoch carrying both, the signature is appended
and then the caret is placed -- true only on a warm cache; cold, the append lands on a later
pass, after the caret. That later append is exactly the case `rich-text.tsx`'s
`updateSelection: false` covers, so fixing this bug makes that option load-bearing on the
reply path as well as on the account-switch path it is tested through. Fix the option's
test first if the order is ever reversed.

**A deal's or project's Mail tab can compose with no recipient, for a reason Task 2 fixed
one instance of.** `packages/web/src/components/rail/mail.tsx:37` resolves the contact as
`useContact(contactId ?? deal?.contactId ?? "")` -- so from a DEAL or PROJECT tab it is a
two-deep chain: the deal query must settle before the contact query is even enabled, and
`compose()` reads `contact` at CLICK time. Click Compose before both have landed and the
seed carries `to: []`, which is a blank compose: no recipient, and (since v1.2.0) the caret
in To rather than in Subject. Nothing waits on either query and no test covers the deal or
project tabs at all -- `e2e/composer-focus.spec.ts` uses a contact, whose chain is one deep
and which now waits on the record heading before clicking. **Fix:** disable the Compose
button until the queries it reads have settled, which also removes the silent
wrong-recipient case rather than only the focus symptom. Found during 7.5 Task 2's review;
out of scope there because Task 2 owned the composer, not the rail.

**Conditional blocks in mail templates.** `({{contact.pronouns}})` renders `()` for a
contact with none. Swallowing one following space handles `Dear X Y`; nothing short of
conditionals handles brackets or labels. The document template already has
`{{#path}}...{{/path}}`; the mail merge does not. Coordinator ruling at the time was to
document the limitation rather than grow the language mid-release.

**v1.2.1 REVISITED THIS AND DEFERRED IT AGAIN, WITH A MEASUREMENT** -- full record in
that release's plan, Task 3. The short form, so nobody re-opens it on the old reasoning:
the obstacle is not the cost of moving `mergeTemplate` into `@conduit/shared`, it is that
**13 of the mail merge's 26 documented behaviours conflict with the document engine**
(measured by running mail's own contract through it). An absent path is empty there and
literal here; the one-space swallow has no expression in a node tree; the escaper is
fixed at five characters where mail needs none for a subject; and `mergeTemplate` throws
where `composer.tsx` has no `catch`. **The deciding one: mail's "no record in scope
leaves the placeholder visible" rule has no block form** -- every answer for
`{{#contact.pronouns}}` with no contact is a new language decision the document engine
cannot supply, so the port must invent a second dialect inside the quote renderer. Had
the semantics agreed it would still have been ~14 files across two packages. **Whoever
picks this up next owns a language design, not a port**, and the first thing to settle is
what a block does when the composer has no record.

~~**Touch-floor assertions are blind to clipping.**~~ **FIXED by 7.5 Task 4b** (`fc2b0d3`,
round 2 `d2fb306`); the full record is that task's DONE block in the v1.2.0 plan. Seven
sites in `documents.spec.ts` now go through one `expectTouchTarget` helper: height, then
`scrollIntoViewIfNeeded`, then `toBeInViewport({ ratio: 1 })`, then `tap({ trial: true })`.
Six of the seven guards were vacuous against a displaced control and the seventh was
covered only by an expensive accident. **The line numbers in the original entry were
already stale by exactly 20 when the task picked it up**, which is why the fix is found
by `TOUCH_FLOOR_PX` and not by line. **Two things the fix did NOT cover are open below**:
the two `mobile.spec.ts` sites, and `opacity: 0`, which keeps a box and intersects and so
walks past every one of the four checks.

**Two PDF text shapes the reader does not handle**, named in `packages/api/src/test/pdf.ts`,
plus the prose guard's remaining known holes — negative utilities matching nothing,
`familyOf` splitting on the last hyphen, a trailing `//` comment never stripped, and a docs
URL granting tree-wide amnesty. All listed at their code. Bare English words are
uncatchable by design.

---

## Intermittents -- four, all timing-shaped; the first is FIXED, and the second HAS now failed CI on its own

**The old heading here read "none has ever failed CI on its own" and stopped being true on
30 Aug**, which is the kind of claim this file exists to keep honest. Number 2 failed run
**33325721506** outright. The distinction that still matters is between the two runners:
`playwright.config.ts` sets `retries: 2` on CI, so an e2e intermittent (3 and 4) surfaces as
a `flaky` line inside a green run. **`vitest.config.ts` sets no retries at all**, so a unit
intermittent (1 and 2) cannot hide inside a green run -- each failure is one occurrence and
it fails the whole `test` job.

1. ~~**`mail-sync.test.ts`, a backoff case.**~~ **FIXED by 7.5 Task 4; the full record is
   that task's DONE block in the v1.2.0 plan.** Three hypotheses were falsified in the end,
   not two: it was not `waitFor`'s 10s deadline, not a slowdown, and not
   `ManualClock.wait(ms <= 0)` either -- that branch is taken exactly once in the 60-case
   file and never in the case that flakes. The case repaired the account AFTER the
   `clock.fire()` that starts the pass the repair was for, and won that race by a **median
   7.3ms, minimum 3.3ms** over 20 instrumented runs; losing it parks the loop in a ninth
   32-minute backoff nothing fires. The repair now happens while the loop is parked.

   **DO NOT REUSE THE "8 in 12 with a second vitest process running" FIGURE.** Two vitest
   processes share `conduit_test` and truncate each other's rows mid-case; reproducing that
   condition gave foreign-key violations and vanished account rows within three runs, in
   cases unrelated to the backoff one. It measured the harness, not the race. Contending
   with a second vitest on `packages/shared` (CPU only, no truncate) gave **0 in 12**, and
   0 in 24 with four busy loops on top.
2. **`mail-integration.test.ts`'s Dovecot IDLE burst** -- the burst asserts 20 delivered and
   gets fewer. Surfaced during v1.1.0 on a diff touching no API source; **17 of 20** that
   time, **11 of 20** on run **33325721506** during 7.5, which failed the `test` job. Opt-in
   suite, CI-only. **Rate, from a sweep of the v1.2.0 branch: once in 22 runs.** Because
   vitest retries nothing, that figure is a true occurrence count rather than a lower bound
   -- unlike 3 and 4, whose real rates are unknown because Playwright's retries absorb them.

   **A SURVIVING, DIFFERENTLY-SHAPED HAZARD IN `mail-sync.test.ts`, so it does not vanish
   under the struck-through entry above.** Two cases still assert a NEGATIVE over a
   wall-clock window: the poll-only degradation case sleeps a bare 50ms and then asserts
   `sync.stats.passes` is exactly 1, and the SyncManager section has a 30ms sibling. v0.9.1's
   backlog logged that shape as its own flake candidate. It is **not** the intermittent 7.5
   Task 4 fixed and was correctly left alone: a scheduler stall there falsifies an assertion
   and says so by name, rather than wedging into an anonymous timeout. Nothing to fix
   urgently; something to recognise if either case ever fails.
3. **`e2e/mobile.spec.ts`'s phone kanban `addStage`** — once in eight runs, hidden by CI's
   two retries. **"Pre-existing" is not established**: `board.tsx:613` put a sticky strip
   directly above that button in v1.1.0, and the file went from 5 serial groups to 7.

   **SIGHTED A SECOND TIME during 7.5 Task 4b's local sweep**, in a file that task does not
   touch, on the test "builds a pipeline, which becomes a stage view once it has stages".
   It then passed on re-run and through 18 further repeats of that group. **The shape of
   the second sighting is the new information**: it failed as `locator.click` exceeding its
   timeout, NOT as an element that was missing. A click that times out rather than failing
   to find its target is what Playwright reports when another element keeps intercepting
   pointer events -- which is the same shape as Task 4b round 2's occlusion finding, and the
   sticky strip named above sits directly above this button. **This is a lead, not a
   diagnosis**: it could not be reproduced under instrumentation, so the call log that would
   actually say "intercepts pointer events" was never captured. Whoever takes it should
   start by capturing that log rather than by trusting this paragraph.

4. **`e2e/crm.spec.ts:115`, the "Other..." caret journey** -- one sighting, CI run
   **33311033649**, hidden by the first retry (`1 flaky, 131 passed`). It failed on
   `getByTestId("salutation-other")` "element(s) not found" at `crm.spec.ts:132`, i.e. the
   box the Select's "Other..." option reveals had not rendered when the value was read.
   **Sighted on a 7.5 Task 2 diff that cannot have caused it**: the only file Task 2 shares
   with `contact-fields.tsx` is `components/ui/input.tsx`, and that change is comment-only
   (`git diff 46a70b3..32ba01c -- packages/web/src/components/ui/input.tsx`). Worth noting
   beside the others because it is the FIRST focus-shaped one -- the other three are a
   clock, an IMAP burst and a sticky strip -- and because `contact-fields.tsx:51-67`
   documents at length that this control's focus is restored by Radix *after* a re-render,
   which is a race the test observes rather than controls.

**The fix for any of these must be deterministic, not a longer timeout.** The one that is
fixed was fixed by ordering two statements, and it now survives a 500ms stall injected on
either side of the moment that used to decide it.

**AND THE DIAGNOSTIC HALF IS WORTH COPYING.** Vitest's default `testTimeout` is 5000ms and
nothing raises it, so any in-test polling helper with a longer budget can never name the
wait that stopped moving -- which is why every sighting of the first one arrived anonymous.
`mail-sync.test.ts`'s helper now takes its budget from the start of the case BODY -- stamped
at the END of `beforeEach`, because `testTimeout` excludes hook time (measured: a 3500ms
hook plus a 3000ms body passes at 6510ms, a 5600ms body alone dies at 5006ms), so a stamp
taken before the hook would spend the body's budget on setup. `mail-move.test.ts` still has
the same hole from the other side (a `5_000` default, exactly vitest's own). **The remedy
there is the same case-start treatment, NOT a smaller constant** -- its deadline is
`Date.now() + 5_000` at the call, so a smaller number would only make the label reachable
when pre-call setup happens to be short. It has one call site and has never flaked; left
alone deliberately.

---

## Test-infrastructure debt

**A SWEEP FOR ASSERTIONS THAT CANNOT FAIL. Nobody has ever gone looking; every one found so
far was found by accident, while working on something else.** That is the whole argument for
scheduling it: the discovery rate is not evidence of scarcity, it is evidence of nobody
searching. Until this runs, **the honest position is that nobody knows how many more exist.**

The evidence, all of it incidental:

| found | where | what made it vacuous |
|---|---|---|
| v1.1.0 | three overflow checks | `documentElement.scrollWidth` is blind to page-content overflow, so the comparison is over a number that never moves |
| 7.5 Task 4b | **six of seven** touch floors in `documents.spec.ts` | a `boundingBox()` exists whether or not the control is on screen |
| 7.5 Task 4b | the settings nav's `scrollWidth >= clientWidth` | a self-comparison: `scrollWidth` is never below `clientWidth` |
| 7.5 Task 4b r2 | **the coordinator's proposed REPLACEMENT for that line** | see below |

**The fourth row is the one that should set the sweep's method.** The replacement proposed
for the dead nav line was `nav.scrollWidth >= lastTab.offsetLeft + lastTab.offsetWidth`,
argued to "fail if a tab is displaced or the row stops accommodating its content". It was
measured instead of accepted, and it does not: with 881px of tabs in a 342px row forced to
`overflow-x: clip`, Chromium still reports `scrollWidth` **881**, not the 342 the argument
assumed. It holds identically untouched (342 vs a 324px right edge), under `overflow-x:
hidden` (881/881), under a transform throwing a tab off the left (342 vs -176), and with
every tab hidden (342 vs -24). **`scrollWidth` reports content overflow whether or not the
box can be scrolled, which makes EVERY arithmetic form of that claim true by construction.**
So a vacuous assertion was diagnosed correctly and then replaced with another one, by the
person who had just diagnosed it. The line was deleted rather than replaced.

**Method, therefore: a candidate is vacuous until a mutation has been shown to fail it.**
Reasoning about whether an assertion can fail is exactly what produced the fourth row.
Task 4b's DONE block in the v1.2.0 plan carries a worked example of the discipline --
per-guard mutation in the app rather than in the test, one displacement at a time, with a
pristine pre-fix copy of the file run alongside as the control.

Candidate shapes to grep for, from the four rows above: any comparison of two properties of
the same element; any `>=` against a quantity that is a lower bound by definition; any
geometry read that survives the element being unreachable; and any assertion whose stated
justification is about layout while its expression is about size.

**TWO KNOWN SITES ARE ALREADY WAITING FOR IT, and they are NOT equally exposed** -- the
asymmetry matters because it decides whether each is a live gap or a regression guard.
Both are in `e2e/mobile.spec.ts` and both floor a control on `boundingBox()` alone with no
viewport claim:

- **The Gantt's `compact-button` is inside `<main>` under `max-md:overflow-clip`, and is
  genuinely the same vacuous class** as the seven Task 4b fixed. A clip is not a scroll
  container, so a control past its edge is cut rather than reachable, and the box survives.
- **The task drawer's Close (floored on both axes) sits in a portalled `fixed ...
  overflow-y-auto` surface, which IS a scroll container** -- so it is the weaker case. A
  control past that edge can be scrolled to, and `scrollIntoViewIfNeeded` would reach it.
  Worth converting for consistency; not worth claiming it hides the same defect.

Note that `toBeVisible()` sitting next to the compact one does **not** close it: Playwright's
visibility test is box-plus-`visibility`, and a clipped element keeps its box. A third site
in the same file already pairs its height with `toBeInViewport()` at the default ratio, so
the pattern was known in this suite and simply was not carried across.

**AND THE HELPER'S HOME IS AN OPEN TENSION, to be settled when those two are converted.**
`expectTouchTarget` currently lives in `e2e/documents.spec.ts`, beside `boxOf`. `e2e/helpers.ts`'s
own rule is that a helper earns a place there **by being about a property of the app that
several journeys touch** -- and the 44px floor is exactly that: asserted in `documents.spec.ts`
and at three sites in `mobile.spec.ts`. By that rule it belongs in `helpers.ts`. It was left
in place at the time only because moving it would have been a change to a file Task 4b had
no measurements for. **Doing the move together with the two conversions above is what avoids
the duplication that leaving it where it is otherwise guarantees.**

**`documentElement.scrollWidth` is blind to page overflow** and has been since the **first
web commit**, at every viewport — a scroll container does not propagate, and neither does a
clip. Three assertions written in Phase 7 were vacuous the day they were written; they now
read `main` and prove their instrument by injecting an over-wide probe. **Any future
overflow assertion must do the same.**

**Seven migration drills seed pre-migration rows through the ORM**, which names every column
of the *current* schema — so adding a column to `deals`, `users`, `companies`, `files` or
`org_profile` breaks a drill in a file far from the change. One was converted to raw SQL in
v1.1.0; the rest are enumerated at that fix.

---

## If it becomes a product

Ordered by how much more expensive each gets if retrofitted rather than designed in.

1. **Data isolation.** Everything is shared by construction — one set of companies, one
   pipeline list. Phase 4.2/4.3 did per-user *mail* visibility, so there is a precedent for
   the shape, but retrofitting tenancy touches every table at once.
2. **Permissions.** `PUT /api/document-templates/:type` is gated only by `requireUser`, so
   any authenticated user rewrites the shared quote template. Fine for one person, wrong for
   a team, and there will be a dozen more like it.
3. **Authentication.** Conduit has none of its own — it trusts a `Ynh-User` header that
   YunoHost's SSO injects. A non-YunoHost deployment is a packaging question only while it
   stays single-user; multi-user means real login, sessions and password reset.
4. **An audit trail.** Currently "deferred indefinitely". The moment two people can edit the
   same deal, "who changed this" is the first question, and it cannot be reconstructed after
   the fact.
5. **GDPR shape.** Contacts are personal data, so portability and erasure become
   obligations. 7.6's export answers portability. Erasure is in tension with the design
   principle that this CRM archives and never expunges.
6. **Accessibility as procurement.** 7.5's keyboard work stops being craft and starts being
   a tender question.

---

## Resolved and applied

*(This section was "Resolved, pending application" while its one item waited on the 7.5
worktree. The item shipped in v1.2.0 and the section is kept only for the reasoning.)*

**`autoupdate.strategy` in `manifest.toml`.** Decision taken 30 Aug: **remove the line.**

Verified directly rather than from a summary: YunoHost's live `apps.toml` carries
`[conduit]` at line 718, category `communication`, listed as an alternative to Discord,
Signal, Telegram and WhatsApp — the Matrix homeserver, catalogued since 2023-08-11 at level
8. `chriswilson2020` appears **0 times** across 707 catalogued apps. So the autoupdater
never runs against this repository, and the app id is already taken.

`schemas/manifest.v2.schema.json` shows `asset` accepts either a string or an object keyed
by `amd64|i386|armhf|arm64`. What it does **not** define is the string's matching semantics.
Adding a key whose semantics could not be verified, in order to fix a declaration nobody
verified, repeats the original mistake — and cataloguing would require a different app id
anyway, at which point the manifest is being rewritten and the declaration can be added
against the tooling's behaviour at that time.

**APPLIED in `357b800`, shipped in v1.2.0.** The line is gone and `manifest.toml` carries
the reasoning above in a comment block where the declaration used to sit, specifically so
that the next person to notice its absence finds the argument instead of re-adding it.
**v1.1.0's release runbook showed a four-line `[resources.sources.main]` block including
`autoupdate.strategy`; the block is two lines now, `url` and `sha256`.** Copying an older
runbook verbatim is the one way this comes back.

---

## Deferred indefinitely (unchanged)

Team mailboxes; scheduling and snooze; subject-fallback threading (revisit on evidence);
per-thread manual share and unshare.

---

## Riders — attach to whichever phase is convenient

YunoHost `test_upgrade_from` / `package_check` wiring; the esbuild/drizzle-kit audit item
(breaking-change major bump, needs its own verification); actor-scoped SSE hints;
`useThreadDetail` extraction; the shared 50MB constant; project-detail archived-pipelines
parity with company detail; `forwardBody` inline-URL cleanup.
