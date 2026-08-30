# Conduit — consolidated backlog

**Supersedes `docs/superpowers/plans/2026-08-21-conduit-roadmap-post-v0.8.0.md`**, which
predates Phases 6 and 7 entirely and describes a v1.0 that has since shipped.

Everything here has evidence attached — a file and line, a measurement, or the review that
found it. Items without evidence are marked as judgement rather than fact. Where one item
blocks another, that is stated rather than left to be rediscovered.

Current shipped version: **v1.1.0**. In flight: **Phase 7.5 → v1.2.0**.

---

## Scheduled

| | What | State |
|---|---|---|
| **7.5 → v1.2.0** | Keyboard-operable rows, the composer's focus, focus after a dialog closes, the `mail-sync` intermittent | Specced, in flight |
| **7.6 → v1.3.0** | Export and encrypted backup, downloadable from Settings | Specced, not started |
| **7.7** | Restore and import, with its decisions already recorded in 7.6's spec | Decided, not specced |
| **Phase 8** | M365 mail via Graph, Gmail XOAUTH2 behind it | **Trigger-based** — jumps the queue the day the Listerdale tenant needs syncing |
| **Phase 4.4** | Mail filing power tools: per-message selection, arbitrary folder moves, folder management, bulk unhide, live inbox beyond page one | Unspecced. Overlaps "emailing a quote" below |

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

**Touch-floor assertions are blind to clipping.** `documents.spec.ts:647,664,711,747,758,
763,765` assert `boundingBox().height >= TOUCH_FLOOR_PX`, and a bounding box exists whether
or not the control is on screen. With `<main>` clipping below the breakpoint, a control
clipped entirely off-screen still passes. The assertion that was meant to cover that was
one of the three vacuous overflow checks. **Fits 7.5's shape** and should be folded in.

**Two PDF text shapes the reader does not handle**, named in `packages/api/src/test/pdf.ts`,
plus the prose guard's remaining known holes — negative utilities matching nothing,
`familyOf` splitting on the last hyphen, a trailing `//` comment never stripped, and a docs
URL granting tree-wide amnesty. All listed at their code. Bare English words are
uncatchable by design.

---

## Intermittents — three, all timing-shaped, none has ever failed CI on its own

1. **`mail-sync.test.ts`, a backoff case.** Four sightings across two phases. Measured **1
   failure in 12 runs idle, 8 in 12 with a second vitest process running**. Two hypotheses
   falsified with evidence: not `waitFor`'s 10s deadline (vitest's 5000ms fires first, so
   that label can never appear) and not a slowdown (the case costs 180-240ms and instead
   **wedges**). Next suspect, untested: `ManualClock.wait(ms <= 0)` resolving without
   registering a pending entry. **7.5 Task 4 owns this.**
2. **`mail-integration.test.ts`'s Dovecot IDLE burst** — 17 of 20 messages. Surfaced during
   v1.1.0 on a diff touching no API source. Opt-in suite, CI-only.
3. **`e2e/mobile.spec.ts`'s phone kanban `addStage`** — once in eight runs, hidden by CI's
   two retries. **"Pre-existing" is not established**: `board.tsx:613` put a sticky strip
   directly above that button in v1.1.0, and the file went from 5 serial groups to 7.

**The fix for any of these must be deterministic, not a longer timeout.** `mail-sync.test.ts`
owns a `ManualClock`, and a wall-clock deadline inside a test that controls its own clock is
the defect.

---

## Test-infrastructure debt

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

## Resolved, pending application

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

**Not applied yet**: Phase 7.5 Task 1 is working in the worktree, and two writers on one
branch is the contamination this project serialises against.

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
