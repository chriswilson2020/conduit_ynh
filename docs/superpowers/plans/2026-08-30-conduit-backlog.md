# Conduit — consolidated backlog

**Supersedes `docs/superpowers/plans/2026-08-21-conduit-roadmap-post-v0.8.0.md`**, which
predates Phases 6 and 7 entirely and describes a v1.0 that has since shipped.

Everything here has evidence attached — a file and line, a measurement, or the review that
found it. Items without evidence are marked as judgement rather than fact. Where one item
blocks another, that is stated rather than left to be rediscovered.

Current shipped version: **v1.3.0**. In flight: **nothing**; next is **Phase 7.7**, restore
and import, whose decisions are already recorded in 7.6's spec and which therefore needs a
plan rather than a spec. All of 7.6 shipped and its record is below.

**v1.3.0 changes behaviour on a path Chris uses without thinking, and that is the first thing
in its notes rather than a footnote: both downloads now ask for the password again.**

---

## Scheduled

| | What | State |
|---|---|---|
| ~~**7.5 → v1.2.0**~~ | Keyboard-operable rows, the composer's focus, focus after a dialog closes, the `mail-sync` intermittent, and the touch floors folded in as Task 4b | **SHIPPED 30 Aug** |
| ~~**v1.2.1**~~ | The reply signature, the Mail tab composing to nobody, the GIF undercharge Chris moved in, and the first deliberate sweep for assertions that cannot fail | **SHIPPED 31 Aug** |
| ~~**v1.2.2**~~ | The MAIL template feature removed, table included (the QUOTE template stayed); the five lists given the loading branch their siblings have; and the Dovecot IDLE burst diagnosed -- **the answer was NO**, so nothing was reordered. **Ships `0012`, a `DROP TABLE`** | **SHIPPED 31 Aug** |
| ~~**7.6 → v1.3.0**~~ | Export (plain ZIP, readable, not restorable) and backup (AES-256 `.7z`, exact, not readable), told apart on a Settings page, **both behind a password re-prompt**. No schema change | **SHIPPED 31 Aug** |
| **7.7** | Restore and import, with its decisions already recorded in 7.6's spec | **NEXT.** Decided and specced-by-reference; needs a plan. Five carry-forward items below, one of which it must not get wrong |
| **Phase 8** | M365 mail via Graph, Gmail XOAUTH2 behind it | **Trigger-based** — jumps the queue the day the Listerdale tenant needs syncing |
| **Phase 4.4** | Mail filing power tools: per-message selection, arbitrary folder moves, folder management, bulk unhide, live inbox beyond page one | Unspecced. Overlaps "emailing a quote" below |

---

## 7.6 -> v1.3.0 -- SHIPPED 31 Aug. Retired here, and five things carried forward

Tag `v1.3.0` at `4d59019`. Release run `33437091338`; asset digest
`ba4c9b604c95891c2b41c7bb7503bfee02712faf20c6f641bf340a7a15af48e8`, verified twice. CI
`33436493145` on the bumped branch: 2741 passed, 1 skipped (2742), 184 e2e, attempt 1, no
`flaky` line. **Neither the Dovecot intermittent nor `pipeline.spec.ts`'s keyboard-drag flake
fired**, said explicitly because a retry would have been. The full working record is
`docs/superpowers/plans/2026-08-31-conduit-phase-7.6-export-backup.md`, whose per-task DONE
blocks are the authority; this is the closing summary.

**No schema change.** The last was v1.2.2's `0012`.

**THE ONE SKIPPED TEST IS BY DESIGN, NOT DRIFT.** The baseline was 0 skipped. The one skip is
`reauth.test.ts`'s real-portal probe, gated on a live POST to `http://127.0.0.1:6788/login`
answering 401. The dev server answers; runners and laptops do not, and it skips visibly. An
unexplained skip is exactly what this project keeps catching, so it is written down here as
well as in the plan.

### The five carry-forward items

**1. THE EXCEL VISUAL IS OUTSTANDING, and it needs a human with a screen.** Task 4's "an
export opened in a spreadsheet with accented characters intact" was never done: screen access
was declined and the agent correctly did not route around it rather than inventing a
substitute and calling it the same thing. Byte-level proof stands in its place and was re-run
at release time -- the artefact starts `EF BB BF`, and the same bytes without the BOM read as
cp1252 split every umlaut into two characters. The two files are prepared and differ only in
those three bytes: `t1-proof/excel/companies-WITH-BOM.csv` and
`t1-proof/excel/companies-NO-BOM.csv` in the session scratchpad, with `t1-bomproof.py` beside
them. **Judgement, not fact:** the BOM is almost certainly right, because the byte-level
behaviour is not in doubt; what is unproven is the last inch, that a real Excel on a real
machine renders it the way the bytes predict.

**2. THE PORTAL SESSION LITTER.** Every successful re-authentication makes YunoHost's portal
mint a session it did not need to: moulinette's login handler calls `set_session_cookie`,
which issues a three-day JWT **and** touches a file under
`/var/cache/yunohost-portal/sessions/`. Conduit discards the `Set-Cookie`, so the session is
never usable -- but the file stays, because purging only runs inside `get_session_cookie` and
nothing here calls it. One small file per successful re-auth, cleared the next time somebody
uses the portal itself. **Litter rather than a hole**, and the price of using the same door
the SSO portal uses instead of binding LDAP directly. Named in `services/reauth.ts` rather
than left to be discovered by whoever next reads that cache directory.

**3. `Ynh-User` IS FORGEABLE BY ANY LOCAL PROCESS, and the throttle is what bounds it.** This
app binds loopback and nginx forwards `$http_ynh_user`, so with no proxy in front the header
is whatever the caller says. That makes `/api/reauth` an oracle for guessing **any** account
on the box rather than only the caller's own -- and there is no upstream throttle to inherit:
YunoHost's fail2ban jails read nginx's logs, this app talks to the portal over loopback so
nothing there counts a failure, and YunoHost's own `ldap_ynhuser` authenticator carries a
FIXME on the `INVALID_CREDENTIALS` path saying failed logins are not caught by fail2ban
either. `ReauthThrottle` is therefore load-bearing rather than belt-and-braces, is keyed on
the **username** rather than `req.ip` (which behind nginx is one hop's `X-Forwarded-For` and
variable by anyone holding a session), and counts at the check rather than after the await --
`f8e647d` fixed exactly that. **Local forgery is a perimeter property and not something this
app can close**; it is recorded so nobody later reads the header as an authenticated identity.

**4. THE MANIFEST/BLOB-WALK WINDOW -- 7.7 MUST TREAT AN UNLISTED `files/` MEMBER AS EXTRA,
NOT AS DAMAGE.** The backup manifest's member list is the blob walk's snapshot, and `7z`
reads the directory **again** when it runs. An upload landing between the two puts a member in
the archive that the manifest does not list. That is harmless -- blobs are content-addressed
and immutable, so the extra member is a whole file rather than a partial one -- but a restore
that treats "in the archive, not in the manifest" as corruption would reject a perfectly good
backup. **This is the item 7.7 must not get wrong.** The opposite skew is neither harmless
nor silent and needs no handling: a blob **deleted** in that window makes `7z` exit non-zero,
which `runSevenZip` already turns into a failed backup rather than a short one. Naming each
blob individually would close the window and break the layout -- `7z` strips the parent of
every input, so `$data_dir/files/<digest>` would be stored as `<digest>` at the top level --
so it is recorded rather than fixed, with the reason the fix is not available.

**5. THE NGINX TIMEOUT CEILING, AND IT IS A CEILING RATHER THAN A GUARANTEE.**
`conf/nginx.conf` gained a `location` block of its own for the backup route at
`proxy_read_timeout 3600`; every other route, the app's own included, keeps the 300 it had.
The backup cannot stream -- the whole archive is built before the first byte leaves -- so the
gap between request and response **is** the build, and the read timeout measures exactly that
gap. At the measured `BACKUP_BYTES_PER_SECOND` of 24.4 MB/s the hour is about **87.8 decimal
GB** of headroom (81.8 GiB), against the **7.32 GB** the old global 300 allowed. **The "~85GB"
figure in circulation is a rounding of this and slightly understates it**; 87.8 is the one
that comes out of the constant. It is an **estimate announced as one**: a single-figure rate
for a mixed workload on one idle machine, and a busier server is slower. Nothing branches on
it except a sentence shown to a person before they commit to waiting.
`backup-nginx.test.ts` reads `conf/nginx.conf` and fails if the number moves, if the block
stops being scoped to the backup route, or if the app's own location gets raised along with
it.

---

## v1.2.1 -- SHIPPED 31 Aug. What it turned out to be

**The scope this section used to record is superseded by what happened.** It said three
defects in and two out; the GIF undercharge was moved IN by Chris before work started, so
four defects ran, and the sweep for vacuous assertions ran alongside them as the plan's
Task 5. Only the focus-after-navigation item stayed out, and it stays out for the reason
given below.

Each item is retired here rather than left open. The full working record is in
`docs/superpowers/plans/2026-08-30-conduit-v1.2.1-fixes.md`, whose per-task correction
blocks are the authority; this is the closing summary.

1. **The reply signature on a cold accounts cache -- FIXED, AND IT WAS LATENT RATHER THAN
   LIVE.** The reorder shipped: `composer.tsx` stamps its guard key only once a signature has
   been found, and the guard now remembers a SET of `(epoch, account)` pairs rather than the
   last one.

   **The "a real bug you could hit today" description of this item was wrong, and the
   correction matters more than the fix.** A review enumerated every construction of a
   `ComposerSeed` in `packages/web/src`: only `conversation.tsx` sets `seed.accountId`, from
   the same `["mail-accounts"]` query the composer reads, through an identical predicate. So a
   seeded account id IMPLIES a resolved cache, and the state the defect needs -- seeded id,
   empty `sendableAccounts` -- was unreachable. No route parameter, no per-record default, no
   restored draft, no browser storage anywhere in `packages/web/src`, and no
   `resetQueries`/`removeQueries`/`clear()`. It shipped anyway because the first caller to
   seed an account id from anywhere else reopens it.

   **A SECOND DEFECT IN THE SAME EFFECT WAS LIVE and was fixed here rather than filed:** the
   old guard remembered only the last pair, so switching account A -> B -> A appended A's
   signature twice, reachable from the From dropdown with two signed accounts.

2. **The Mail tab composing with no recipient -- FIXED, and the premise was half wrong.**
   Compose is now gated on the hops it reads, in three states: pending disables and says why,
   an error leaves Compose live beside an alert and a scoped retry, and settled-and-empty is
   allowed. The naive "disable until settled" form was measured and rejected -- a disabled
   query sits at `status: "pending"` for ever in TanStack v5, so it left the button dead on
   every tab.

   **THE CORRECTION: A PROJECT NEVER SEEDS A RECIPIENT AT ALL.** `rail/mail.tsx` reads
   `deal?.contactId` from its own `dealId` prop, and a project tab passes none -- so
   `useContact` is disabled there and a project composes with an empty To BY CONSTRUCTION,
   settled or not. Measured in Chromium with every query landed, and confirmed on the wire: a
   project page requests no `/api/contacts/<id>`. What a project does have two deep is
   **project -> company**, which fills `context.companyName` and feeds the MERGE CONTEXT
   rather than the recipient; held open, `{{company.name}}` reaches the composed body
   unsubstituted. So there were two races, not one, and only the deal's was silent.

   Coverage was the deliverable and it landed as `e2e/rail-compose.spec.ts`. "No test covers
   the deal or project tabs at all" was one word too strong: the PROJECT tab was genuinely
   untouched, but `e2e/mail.spec.ts` opens a DEAL tab -- it just never presses Compose, so the
   claim that holds is that no test had ever built a seed from either tab.

3. ~~**The empty pronoun brackets -- REVISITED AND DEFERRED A SECOND TIME, WITH THE
   MEASUREMENT.**~~ **CLOSED BY v1.2.2 Task 3, WITHOUT BEING FIXED: THE DEFECT IS NOW
   UNREACHABLE.** `({{contact.pronouns}})` could only render `()` inside a MAIL template,
   and mail templates no longer exist -- the merge, `PLACEHOLDER_KEYS`, `MERGE_EXAMPLES`
   and the guard on them all went with the feature. Nothing here was repaired and nothing
   should be re-opened on the old reasoning. Kept for the record: the deferral was a
   success rather than a failure, because the ruling was tested rather than inherited --
   **13 of the mail merge's 26 documented behaviours conflicted with the document
   engine**, measured by running mail's own contract through the real `mergeTemplate`,
   and the deciding one was that **mail's blanking rule had no block form**. The quote
   template's own `{{#path}}` blocks are untouched and keep working.

4. **The GIF undercharge -- FIXED, and the prescription was one shape short.** Chris moved
   this in from the OUT list. The prescribed "fall back to the logical screen descriptor"
   would have **accepted a 169-megapixel GIF that today's code refuses**: hide a huge frame
   behind one byte that is not a block introducer and the screen descriptor still says 1x1, so
   the naive fallback charges one pixel where Pillow skips the byte and opens the file at 169
   Mpx. `gifSize` now **resyncs the way Pillow's scanner does** and falls back to the largest
   extent it established, conditional on having reached an image descriptor -- which is
   Pillow's own condition for opening a GIF, measured against Pillow 12.3.0. Both forms are
   now charged 169,000,000 and refused. This was hardening on a ceiling that held (worst
   variant at 59% of the 512MB kernel limit) and should not be described as an open hole.

5. **The sweep for assertions that cannot fail -- RUN FOR THE FIRST TIME. Seven found and
   repaired.** Twenty-two mutations, eighteen through the local hybrid loop and four on
   throwaway CI branches. **Six of the seven are ONE SHAPE**, and it is cheap to look for: an
   absence asserted of a surface that has not rendered yet. Those rows all come from a query,
   so for the first moments after a navigation or a filter toggle there is nothing there at
   all -- and a **negated auto-retrying matcher is satisfied on its very first poll by an
   element that does not exist**. Each was repaired by putting a loaded-list sentinel in front
   of it and re-run under the mutation that had walked past its predecessor. The seventh was a
   sentence rather than an assertion. Full list in the Test-infrastructure debt section below,
   which this retires.

   **ALL SEVEN ARE DEFECTS IN THE TESTS, NOT IN THE APPLICATION**, and it is the thing a
   reader will get wrong. No repair changed application behaviour, and **no repaired assertion
   turned CI red** -- which is the evidence that nothing real was hiding behind them, since
   waking a dead assertion up is exactly what would have exposed it. **The one genuine
   application defect the sweep surfaced** is the five lists that render an empty label with no
   loading branch, and it was found by READING the surface behind a suspicious assertion
   rather than by a repair going red. Chris moved it into v1.2.2. **Conduit did not have seven
   bugs.**

**STILL EXPLICITLY OUT, unchanged:** focus lost after any navigation that unmounts the
focused element. It is the biggest item on the deferred list and the fix is a route-change
concern touching every page, so **it earns its own release**. It is NOT the five dialog roots
-- those are one entrance to it, and fixing them alone would make them the only navigations
in the app that land anywhere, while row links remain the commoner path to the same pages.

---

## v1.2.2 scope -- three items. Chris's decisions, 31 Aug

**Order: v1.2.1 (shipped) -> v1.2.2 -> Phase 7.6.**

1. **Remove the MAIL template feature entirely**, table included. The QUOTE template stays.
2. **The five lists that render their empty label with no loading branch.** Filed by v1.2.1
   Task 5's sweep, moved into scope by Chris.
3. **Determine whether the Dovecot IDLE burst is a test defect or a real hole in mail sync.
   DIAGNOSTIC ONLY -- report and STOP. Do not fix.**

**ITEM 3 CAN REORDER THE OTHER TWO.** If the answer is that the app can lose messages, it
jumps ahead of both. That is why it is worth doing first even though it produces no code.

---

## v1.2.2, item 1 -- remove email templates

### Why

Chris: "I don't think we should ever be templating emails, that's messy and ends up with
things like dear first name last name emails!" And: "I've never used the email templates!
Only quotes!"

He is right that the failure mode is real and that the current design does not prevent it --
an unresolved placeholder is left VISIBLE so the operator notices, but **nothing blocks
Send**. "You'll spot it" is not a control.

### Scope: remove the MAIL template feature. The QUOTE template stays.

`settings-templates.tsx` holds BOTH. Remove the mail half, keep the document half.

**11 source files carry it** (`dist/` and the migration excluded):

| file | what it carries |
|---|---|
| `packages/api/src/db/schema.ts` | the `email_templates` table |
| `packages/api/src/db/schema.test.ts` | its coverage |
| `packages/api/src/routes/mail.ts` + `mail.test.ts` | the CRUD endpoints |
| `packages/api/src/services/mail-templates.ts` + its test | store and sanitise |
| `packages/api/src/services/meetings.ts` | a comment reference only -- **CHECK, do not assume** |
| `packages/shared/src/index.ts` + `index.test.ts` | the `EmailTemplate` type and schemas |
| `packages/web/src/queries.ts` | 5 hooks |
| `packages/web/src/components/mail/composer.tsx` | the Template select |
| `packages/web/src/pages/settings-templates.tsx` | the mail half only |
| `packages/web/src/components/mail/mail-lib.ts` | `substitutePlaceholders`, `substitutePlaceholdersHtml`, `PLACEHOLDER_KEYS`, `MERGE_EXAMPLES` |

### The table CAN be dropped

Chris has never created one and the app is single-user. A YunoHost upgrade takes a safety
backup first, so the drop is recoverable. **So: full removal including the table, via a
GENERATED migration -- never hand-written, never `drizzle-kit push`.**

This is the first migration since v1.1.0's `0011`. Regenerating means restoring the journal's
`when`/`tag`, verifying the journal diff is empty, and **dropping and recreating
`conduit_test`** -- the migrator skips by timestamp.

### A trap waiting for v1.2.2's version bump, measured on `main` at the v1.2.1 release

**The lockfile must be regenerated with `npm install --package-lock-only`, never edited**, and
the reason gets worse rather than better each release. v1.2.0's brief claimed six
self-references at the outgoing version; there were three. At **1.2.1 there are FOUR
occurrences of `"version": "1.2.1"` and only three are this app** -- `packages/api`,
`packages/shared`, `packages/web`. The fourth is `node_modules/source-map-js`, genuinely at
that version and nothing to do with Conduit. (The three left at `1.2.0` are `node_modules/he`,
twice, and `node_modules/setprototypeof`.) **A search-and-replace of `1.2.1` -> `1.2.2` would
silently corrupt `source-map-js`'s pinned version and integrity pairing.** The foreign package
is a DIFFERENT one each release, so checking last release's list is no defence -- regenerate,
then confirm the diff is nothing but the three workspace version strings.

### Consequence for v1.1.0's work, and say it in the release notes

v1.1.0 added `{{contact.salutation}}` and `{{contact.pronouns}}` to the MAIL merge and paid
for the space-swallowing rule with a live defect. **That work goes with this.** The CONTACT
FIELDS STAY -- they are useful on the record, for reading before a call. **Only their
merge-field form goes.** `documents.recipient_salutation` is a separate snapshot on the quote
and is untouched.

**Also retires:** v1.2.1 Task 3's deferral (the empty-brackets defect becomes unreachable),
and the `MERGE_EXAMPLES` guard that task shipped.

### DONE, v1.2.2 Task 3 -- `6e3d0e3`, CI `33365166752` green

**2464 unit / 0 skipped** (from 2499) and **161 e2e** (from 164), both from that run.
The e2e line reads `1 flaky, 160 passed`: `pipeline.spec.ts:173`'s downward-drop keyboard
drag fired the dnd-kit intermittent this backlog already tracks and passed on retry, in a
file this commit does not touch. Said out loud rather than reported as a clean 161,
because a retry recorded as a pass is how a flaky test becomes a permanent lie.

**The quote path was proved end to end rather than assumed**, since it shares this page
and this sanitiser: `documents.spec.ts` (9) and `salutation.spec.ts` (6) both green
through the hybrid loop, and a quote was then issued and downloaded by hand --
QUO-2026-0005, `application/pdf`, 475,028 bytes, `%PDF-1.7`, rendering the letterhead
logo, the `{{#path}}` blocks, the money columns and the recipient's salutation.

**The file list above was two files short**, found by following the types rather than the
grep: `components/rail/mail.tsx` and `components/mail/conversation.tsx` each BUILD the
merge context that `ComposerSeed.context` carried, and neither is named above. Both are
now context-free; `conversation.tsx`'s `useContact`/`useCompany` calls existed only to
fill it and went with it. `mail-lib.test.ts` was not named either, and it held 22 of the
35 unit tests this removed.

**`meetings.ts` was a comment reference only, as suspected** -- one line naming
`email_templates.body_html` as a fellow user of `sanitizeMailHtml`. The claim was true
and is now false, so the comment was rewritten to name the users that remain
(`mail_accounts.signature_html` and every composed body). Three more comments said the
same thing elsewhere and were corrected the same way: `db/schema.ts` twice and
`services/documents.ts` once.

**A SYMBOL GREP CANNOT SEE A SENTENCE, AND THAT COST A SECOND SWEEP.** The four comments
above were all found by following `sanitizeMailHtml` -- an identifier. Four MORE described
the removed feature in prose that mentions no identifier at all, and were found only by
sweeping for the phrases "mail merge", "mail template" and "email template" after the symbols
were already gone (`0f9803c`): `components/contact-fields-lib.ts`'s table of who normalises
what, which had a row for the mail merge and v1.1.0's one-following-space rule and now
describes the QUOTE merge; `components/mail/rich-text.tsx`, which listed email templates
among the three surfaces it renders; `routes/documents.ts`'s "Only mail templates had
routes"; and `lib.ts`'s `overridableClass` note counting three pre-Phase-7 width callers, one
of them the templates dialog. **Eight comments in total, four of them reachable only by
reading prose.** The last two were dated rather than deleted, because the measurements they
record really did happen.

~~**ONE PIECE OF THE REMOVAL WAS DELIBERATELY NOT DONE, and it needs a decision rather than
a follow-up commit.**~~ **DECIDED AND DONE in item 2's task, 31 Aug.**
`components/rail/mail.tsx`'s compose gate read FOUR hops -- deal, project, contact,
company. After this task only `deal -> contact` decided anything the seed uses (`to`); the
project and company hops fed `context.companyName` for the merge and fed nothing after it,
so Compose was gated on data no seed reads. The coordinator ruled that a control held shut
by data nobody reads is a slower button and nothing else; it is narrowed to two hops, and
Chris can reverse it.

**The "two journeys" in this note was already one.** Two held `COMPANY_GET` before this
task; this task deleted the merge journey, so by the time the note was written one was
left -- and that one was not testing the company coupling at all. See item 2's entry below
for what happened to it, which is the more interesting half.

**What went from the tests, itemised, because the unit count moved 2499 -> 2464 (-35):**

| file | tests | what they covered |
|---|---|---|
| `packages/api/src/services/mail-templates.test.ts` | 7 | the whole service; file deleted |
| `packages/web/src/components/mail/mail-lib.test.ts` | 22 | `substitutePlaceholders` (14), `substitutePlaceholdersHtml` (5), `templateSubject` (3) |
| `packages/api/src/routes/mail.test.ts` | 4 | the five CRUD endpoints |
| `packages/shared/src/index.test.ts` | 2 | `emailTemplateSchema`, `createEmailTemplateInputSchema` |

E2E moved 164 -> 161 (-3). `rail-compose.spec.ts` lost one journey outright (the merge field
was the only way `context.companyName` was observable from outside the seed, and there is
no merge any more). `dialog-focus.spec.ts` lost its "goes back to New template" test in
both of its two suites -- it was the templates page's duplicate of the Add-account test
beside it -- and its "goes back to the ROW that opened it" test was MOVED to the mail
accounts page rather than deleted, because what it guards is `ui/dialog-focus.ts`, which
still ships and has no other two-opener coverage. That fixture now archives its accounts
in `afterAll`, asserted.

**The stylesheet moved by exactly one rule.** `index-M5teG3jg.css` (33,259 B, sha256
`3031a0c4...d90e2`) became `index-CKKLeVXr.css` (33,221 B, sha256 `ef95eb79...a46f`),
measured with `npx vite build` on the dev server (Debian 12, node v24.19.0). The base
tree was rebuilt from `git archive HEAD` beside it and reproduced the old name and hash
byte for byte, so the two are comparable: the ONLY difference is the deletion of
`.w-64{width:calc(var(--spacing) * 64)}`, 38 bytes, which is the whole 38-byte delta.
`w-64` was the width of the composer's Template select wrapper and occurred nowhere else.

---

## v1.2.2, item 2 -- the five lists that say "there is nothing here" while still fetching

**Filed by v1.2.1 Task 5's sweep, moved into scope by Chris on 31 Aug.** The full evidence is
under "Defects found and deliberately deferred" below and is not restated here; this section
records only that it is scheduled and what the fix is.

Five surfaces destructure `const { data: rows = [] } = use...()` and render their empty label
on `rows.length === 0` with **no loading branch**, so the reader is told the record has
nothing for as long as the fetch takes, and the list then appears underneath that sentence:

| where | label |
|---|---|
| `pages/company-detail.tsx`, Pipelines | `No pipelines` |
| `pages/project-detail.tsx`, Pipelines | `No pipelines` |
| `components/rail/notes.tsx` | `No notes yet` |
| `components/rail/files.tsx` | `No files yet` |
| `components/task-drawer.tsx`, Dependencies | `No dependencies` |

**The fix is to follow the pattern the app already has, not to invent one.** Seven sibling
surfaces do it correctly -- `entity-table.tsx`, `mail/thread-list.tsx`, `rail/meetings.tsx`,
`deal-detail.tsx`'s Documents, `settings-templates.tsx`, `pipelines.tsx`, and
**`company-detail.tsx`'s own CONTACTS section three sections above its Pipelines one**. That
last one is why this is a defect rather than a convention: the same file does it both ways.

All seven were re-checked on 31 Aug, at the moment this was scheduled, rather than carried
over from the filing.

**CORRECTED AFTER ITEM 1 LANDED, AND THE COUNT IS NOW SIX.** The scheduling note here said
`settings-templates.tsx` was on that list "twice over -- its MAIL half and its QUOTE half
each gate their empty label on `isLoading`", and told whoever did item 1 not to take the
loading branch out with the mail code. **Both halves of that were wrong.** The MAIL half was
the only one with an empty label (`No templates yet.` behind `!isLoading`); the QUOTE half
has a loading line and NO empty label at all, because there is always exactly one quote
template row. Removing the mail half therefore took the whole sibling with it, and nothing
was left behind to preserve. **Take the pattern from one of the remaining six** --
`company-detail.tsx`'s Contacts section is the closest, and is the one that makes the
Pipelines section beside it a defect.

**A CORRECTION TO THE ORIGINAL FILING, made while scheduling this.** It said `rail/notes.tsx`,
`rail/files.tsx` and `task-drawer.tsx` "do not currently destructure `isLoading` at all". True
of the first two; **false of `task-drawer.tsx`, which destructures it from `useTask` and
branches on it near the top of the component**. What holds is narrower and is about the CALL
SITE, not the file: `DependenciesSection` takes only `data` from `useTaskDependencies`. That
makes `task-drawer.tsx` a second file that does it both ways, alongside `company-detail.tsx`
-- which strengthens the argument rather than weakening it. Only `rail/notes.tsx` and
`rail/files.tsx` need the flag introducing to a file that has never used one.

### DONE, 31 Aug. Both halves, twenty mutations, and one instrument thrown away.

**THE COUNT OF SIX IS RIGHT AND THE LIST IT COUNTS WAS NEVER A CENSUS.** All six were
re-read: all six gate correctly. So do **`rail/timeline.tsx` and `settings-mail.tsx`**,
which no filing here ever named, and `mail/composer.tsx`'s From block, which picks between
"Loading accounts...", an empty-state line and the select. Six of the ENUMERATED do it
correctly; the app has at least eight. The difference decided nothing -- the pattern is
identical in all of them -- but nobody should quote six as a total. **And Contacts is one
section above Pipelines, not three:** `company-detail.tsx` has exactly two `<section>`
elements and they are adjacent. The three counts the field card and the owner row.

**The pattern taken is the majority one and not the nearest one.** Six of those eight pair
`{isLoading && <Loading/>}` with `{!isLoading && rows.length === 0 && <Empty/>}`, and that
is what the five got. `company-detail.tsx`'s Contacts section, the closest sibling to one of
them, uses the truthiness spelling instead and was deliberately not copied: the correction
above ("only `rail/notes.tsx` and `rail/files.tsx` need the flag introducing to a file that
has never used one") only makes sense if all five take a flag. `isLoading` rather than
`isPending`, because `isLoading` is `isPending && isFetching` in the installed query-core
5.101.4 -- so a DISABLED `useNotes`/`useFiles` reports false and shows its empty label at
once, which is correct, where `isPending` would say "Loading..." for ever.

**Guards proved, not assumed.** Five new journeys in `e2e/list-loading.spec.ts`, each
holding one list GET open and taking a ONE-SHOT read of the surface (a negated auto-retrying
matcher is satisfied the instant the lie goes away, which is v1.2.1's own lesson from the
other side), then walking to a second, genuinely empty record so the label is shown to still
arrive. All five were red before the fix. **Fifteen mutations, one at a time**: for each of
the five, dropping the `!isLoading` guard, deleting the loading line, and deleting the empty
label -- fifteen reds, each on its own journey and its own assertion.

**THE COMPOSE-GATE HALF CARRIED IN FROM ITEM 1** narrowed `rail/mail.tsx` from four hops to
two. Two journeys were added, each holding a dropped hop open and reading `isDisabled()`
once; both were red before the narrowing, and putting either hop back turns its own one red
again. The alert copy said "contact or company" and now says "contact".

**AND THE PART WORTH READING TWICE.** The one surviving `COMPANY_GET` journey built "one hop
stalled while another is in flight", the only state in which `composeGate`'s branch ORDER is
observable. Narrowing makes that state unreachable -- the contact's key comes from the deal,
so a deal that has not answered never starts a contact fetch. A replacement was written on
`mail-lib.ts`'s own claim that a Retry produces a single hop that is both. **That claim was
false and had never been measured.** Driven through a real QueryObserver against query-core
5.101.4: a query that has never succeeded reports `isError: false` while its refetch is out,
because `fetchState()` resets `error` and `status` whenever `data === undefined`. The
replacement therefore **passed with the two branches swapped**, and was deleted rather than
kept for the look of it. The rule survives as a property of a generic function, guarded by
the two unit tests that do go red under that swap (2 of 16). Three comments were corrected.

**Counts: unit 2464 unchanged, e2e 161 -> 166**, both green on CI run `33370646642` at
`13d1afa`, first attempt, no retries. The stylesheet did not move -- `index-CKKLeVXr.css`,
33,221 B, sha256 `ef95eb79...a46f`, byte-identical to item 1's, because the fix emits no
Tailwind class the build did not already carry.

---

## v1.2.2, item 3 -- CAN CONDUIT FETCH ONLY SOME OF A BATCH OF NEW MAIL AND NEVER COME BACK FOR THE REST?

**DIAGNOSTIC ONLY. The deliverable is an answer with evidence, not a repair. REPORT AND
STOP.** Chris, verbatim: *"test it but before spending a crap ton of tokens report back what
you find and we can decide together the next steps."* That stop is written into this entry on
purpose, because the natural drift from "I have found it" to "I have fixed it" is exactly what
must not happen here -- he decides what follows.

**FRAME IT AS THE QUESTION, NOT AS THE FLAKE.** The `mail-integration.test.ts` Dovecot IDLE
burst is how this surfaced, and it is tempting to treat it as a flaky test to be stabilised.
It may not be one. The open question is about the PRODUCT:

> Can Conduit fetch part of a batch of newly-delivered messages, report success, and never
> come back for the remainder?

If it can, that is a serious defect: **messages sitting on the server that never appear in
the app, with nothing to tell the operator anything is missing.** A CRM that silently drops
mail is worse than one that fails loudly. If instead it is the test's view of the IMAP server
lagging behind the delivery, it is a test fix and stays where intermittent 2 already is.

**WHAT TASK 4 ESTABLISHED, AND WHY THAT MAKES THIS ANSWERABLE NOW.**

- **4 events in 177 attempts, about 1 CI attempt in 44** -- a real rate rather than an
  impression, and a true per-attempt one because vitest sets no retries.
- **Every one of the four showed a PARTIAL view: 11, 16, 17 and 11 of the 20 messages. Never
  0, and never a wedged wait.** That is the shape that makes this a product question. A lost
  wake would look like 0; a hung connection would look like a timeout. Seeing most-but-not-all
  is what both candidate causes produce.
- **TWO OF THE FOUR HAD BEEN RE-RUN INTO INVISIBILITY**, which is why nobody had a number
  before. `gh run list` reports a workflow's LATEST attempt only, so a failed first attempt
  under a green second one vanishes from the run list.

**THE TWO CAUSES PRODUCE THE SAME SIGNATURE, AND THE EXISTING LOGS PROVABLY CANNOT SEPARATE
THEM.** `walkToEnd` stops as soon as one `fetchNewer` returns fewer than the batch size, on
the idler's own connection, the instant the wake settles. Both of these end the walk early
with a partial count:

| candidate | what it would mean |
|---|---|
| the IMAP connection's view is lagging the delivery | a test-side wait; the app would catch the rest on the next pass |
| `fetchNewer` has a genuine hole | a product defect: the walk ends and nothing returns for the remainder |

**So the first deliverable is INSTRUMENTATION that distinguishes them** -- what the server
reported existing at each step against what the walk actually fetched, and critically
**whether a later pass ever collects the missing messages**. That last one is close to the
whole question: a lagging view is self-healing, a hole is not.

**Do not change behaviour while measuring.** Any fix applied before the cause is known will
make the rate unmeasurable and the question unanswerable.

**Ordering consequence, stated so it is not missed:** if the answer is "the app can lose
messages", **this jumps ahead of items 1 and 2** and probably ahead of 7.6 as well. If the
answer is "the test's view lags", it goes back to being intermittent 2 with a recommendation
to schedule a test fix.

**A WARNING FOR WHOEVER RE-MEASURES THE RATE: COUNT ATTEMPTS, NOT RUNS.** Doing otherwise
halves the figure, which has already happened once -- "once in 22 runs on the v1.2.0 branch,
and once on `a15e6f6`" was **one event described twice**, and it was the number this project
believed until Task 4 read the attempts.

### ANSWERED, 31 Aug: NO. The test's view of the server lags -- and the brief's premise was false

**"The existing logs provably cannot separate them" was wrong, and that is the finding.**
vitest's `toHaveLength` failure prints the RECEIVED array, so two of the four events carry
their UID list, and both are the same **contiguous prefix** `[2..12]`, 11 of 20 -- four days
apart, on different branches. No instrumentation and no new runs were needed; the answer had
been sitting in CI since 27 August. The storm's twenty APPENDs are sequential and awaited, so
UIDs ascend in delivery order and the nine missing messages were appended AFTER the twelve
seen. **Nothing below the cursor was skipped.**

**Why that settles the product question.** A short batch ends the pass, the cursor is saved,
and the next pass searches `cursor+1:*`. So a **prefix costs a PASS; a hole would cost a
MESSAGE.** A pass is guaranteed: `waitForWork` caps IDLE at `pollIntervalMs`, and in
production the stragglers are already on the server, so re-entering IDLE draws an immediate
`EXISTS`. **Item 3 reordered nothing.**

#### THE CORRECTION TASK 2 MADE, AND IT RUNS IN THE DANGEROUS DIRECTION

The answer above rests on what the cursor is, and the first statement of it -- **"the cursor
is the highest UID actually ingested"** -- is FALSE. `syncFolder` computes `highest` over
every descriptor the SERVER LISTED in the batch, and advances the cursor to it whether or not
`ingestOne` stored anything. Read out of the shipped code rather than inferred:

- `fetchRaw` returning `null` (expunged between listing and fetch) returns early; the comment
  says in terms that "the cursor moves past it with the rest of the batch".
- a poison message that survives `POISON_RETRIES` is recorded and skipped, and the comment on
  the cursor assignment names this as the mechanism that moves past it -- "the skip needs no
  arithmetic of its own, because the batch's highest UID is already beyond it".

**So a message the server lists but Conduit cannot fetch moves the cursor past itself and is
never retried.** That is deliberate -- the alternative is walking an entire mailbox one
failure at a time -- but it means the honest answer to "can Conduit silently skip a message"
is **NO for the case that was asked about, and YES in this narrow one**. It does not change
the diagnosis: a lagging view lists nothing, so nothing is skipped past. It is written down
because the safe-sounding version of the sentence was the one that got written first.

**There is still no backstop if a hole ever did occur.** `reconcileFlags` only `UPDATE`s rows
matched on `(account, folder, imap_uid)`; it never ingests. A skipped UID is invisible for
ever. That is why item 3's second half was worth more than its first.

#### THE RECOVERY PROPERTY IS NOW TESTED, AND SO IS ITS CONTROL

`mail-sync.test.ts` gained a deterministic pair on `FakeImapClient`: a PREFIX on pass 1 and
the full set on pass 2 must store all twenty, and a HOLEY view's skipped UIDs must never
arrive. **The second is the load-bearing one** -- the first passes just as happily against a
loop that re-walks from zero. Its uniqueness is measured rather than claimed: loosen
`syncFolder` to advance only over a contiguous run and **2460 tests pass while that one alone
goes red**. It is the only thing in the codebase that would notice if the cursor discipline
regressed, and given there is no backstop it is the whole safety net.

#### FILED, NOT FIXED: the short-batch `break`

`syncFolder` ends the folder pass on `batch.length < BATCH_SIZE`. Deleting it is invisible to
all 62 tests in `mail-sync.test.ts`. It is left alone deliberately: without it the loop makes
one more `fetchNewer`, gets an empty batch, and exits through the non-advancing guard beside
it. **It costs a round trip and a spurious warning, never a message**, so there is nothing
here to repair and a test asserting a round-trip count would be asserting the implementation.

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
- **THE DIRECTION OF THIS ONE HAS REVERSED NOW THAT 7.6 HAS SHIPPED.** It used to read
  "7.6's export must include time entries, or a timesheet is trapped in the app". 7.6 shipped
  without them, correctly -- there is no time-entry table to export. So the obligation moves:
  **Phase 10 must add a sheet to the export in the same change that creates its table.**
  `export.ts` has one hand-written `*Sheet` function per entity with its columns selected
  explicitly; it does not walk the schema, so a table added later appears in the export only
  if somebody writes the function. **The backup needs nothing** -- it is a `pg_dump` of the
  whole database, so a new table is in it the day it exists, and the manifest lists archive
  members rather than tables. That asymmetry is the point: the exact half picks up new
  entities for free and the readable half does not, and a timesheet trapped in the app is the
  failure this bullet was always about.

---

## Defects found and deliberately deferred

~~**FIVE LISTS SAY "THERE IS NOTHING HERE" WHILE THEIR QUERY IS STILL ON THE WIRE**~~ **--
FIXED 31 Aug in v1.2.2's item 2; see that section above for what was done, what the count of
"seven siblings" below was actually counting, and the false comment the work turned up.**
Found during v1.2.1 Task 5's sweep, filed rather than fixed because the release was already
scoped. Each destructured `const { data: rows = [] } = use...()` and rendered its
empty label on `rows.length === 0` with no loading branch, so the reader was told the record
had no pipelines/notes/files/dependencies for as long as the fetch took, and the list then
appeared underneath that sentence:

| where | label |
|---|---|
| `pages/company-detail.tsx`, Pipelines | `No pipelines` |
| `pages/project-detail.tsx`, Pipelines | `No pipelines` |
| `components/rail/notes.tsx` | `No notes yet` |
| `components/rail/files.tsx` | `No files yet` |
| `components/task-drawer.tsx`, Dependencies | `No dependencies` |

**The app already has the right shape in seven other places** and they are what makes this a
defect rather than a convention: `components/entity-table.tsx` renders `Loading...` and
`No results` from the same cell; `components/mail/thread-list.tsx` renders its empty label
only `!isLoading && !error`; `rail/meetings.tsx`, `deal-detail.tsx`'s Documents,
`settings-templates.tsx` and `pipelines.tsx` all do the same; and `company-detail.tsx`'s
CONTACTS section -- three sections above its Pipelines one -- gates on
`contactsData && contactsData.items.length === 0`, which is the same claim spelled with a
truthiness check instead of a flag. **Fix:** give the five above the branch their
neighbours have. ~~`rail/notes.tsx`, `rail/files.tsx` and `task-drawer.tsx` do not currently
destructure `isLoading` at all.~~ **Corrected 31 Aug: that is true of the first two only.**
`task-drawer.tsx` destructures `isLoading` from `useTask` and branches on it; it is
`DependenciesSection`'s own call that takes only `data`. The claim is about the call site, not
the file -- see "v1.2.2, item 2" above, where this was fixed.

**AND "SEVEN OTHER PLACES" WAS TWO SHORT, found when the fix re-read them on 31 Aug.**
`rail/timeline.tsx` and `settings-mail.tsx` gate an empty label on `isLoading` too and appear
in no filing; `mail/composer.tsx`'s From block does the three-way version of it. With
`settings-templates.tsx`'s gone alongside the mail templates, the enumerated set is six and
the real one is at least eight. It changed nothing about the fix -- the pattern is the same
in all of them -- and it is recorded because a list of examples read as a census.

**HOW IT WAS FOUND, because the test consequence is the reason it matters.** Two e2e sites
leaned on one of these labels as a "the list has loaded" sentinel, and one of them said so
in a comment. `e2e/crm.spec.ts`'s archived-pipeline journey is the one that was measured:
with `listPipelines`'s archived filter removed server-side, so the archived row DOES come
back in the default list, its `toContainText("No pipelines")` pair passed twice and failed
four times over six attempts -- a race, decided by whether the response beat the first poll,
which is worse than either a pass or a failure. That test now waits on the response instead.
`e2e/mobile.spec.ts`'s `No dependencies` precondition is the same shape and was left alone:
it is a precondition rather than the test's claim, and a false pass there costs nothing. It
is a real sentinel now, as a side effect of the fix rather than by anyone editing it.

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

**DONE in v1.2.1 Task 4, and the prescription above is one shape short.** Falling back
to the SCREEN DESCRIPTOR alone leaves a fifth variant reading 1x1: hide the huge frame
behind one byte that is not a block introducer and Pillow skips the byte where a reader
that stops does not. So `gifSize` resyncs the way Pillow's scanner does and falls back
to the largest extent it established, conditional on having reached an image
descriptor -- which is Pillow's own condition for opening the file, measured, and what
keeps the logo path's "no image library could open it either" true. See the plan's
Task 4 corrections. The `length * 8256` = 429,312 above is right; the copy of it in
`shared/src/index.ts` said 305,472 and has been corrected.

~~**A reply's signature is silently lost on a cold accounts cache.**~~ **FIXED in v1.2.1
Task 1 -- AND THE DEFECT WAS LATENT, NOT LIVE.** The description of it below, and the one
given to Chris ("a real bug you could hit today"), are both wrong on that point. The state it
needs -- `seed.accountId` set while `sendableAccounts` is still `[]` -- is UNREACHABLE: a
review enumerated every `ComposerSeed` construction in `packages/web/src` and only
`conversation.tsx` sets an account id, from the same `["mail-accounts"]` query the composer
reads, through an identical predicate. **A seeded account id therefore implies a resolved
cache.** No route parameter, no per-record default, no restored draft, no browser storage
anywhere in `packages/web/src`, and no `resetQueries`/`removeQueries`/`clear()`. Measured in
Chromium against the real component: seeded and cold, the body ended empty; unseeded and
cold, the signature landed. The reorder shipped anyway, because the first caller to seed an
account id from somewhere else reopens it -- and a SECOND defect in the same effect WAS live
and went with it: the guard remembered only the last `(epoch, account)` pair, so A -> B -> A
appended A's signature twice from the From dropdown. It now remembers a set. *The original
entry is kept below because its mechanism is still the mechanism.*

`packages/web/src/components/mail/composer.tsx` stamped its guard key **before** discovering
whether a signature existed:

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

~~**A deal's or project's Mail tab can compose with no recipient.**~~ **FIXED in v1.2.1
Task 2, and the entry below is half wrong about the project.** Compose is now gated on the
hops it reads, in three states -- pending disables and says why, an error leaves Compose live
beside an alert and a scoped retry, and settled-and-empty is simply allowed. (The flat
"disable until settled" prescription below was measured and rejected: a disabled query sits
at `status: "pending"` for ever in TanStack v5, so it leaves the button dead on every tab,
which is the shape v1.1.0 already rejected once.)

**THE CORRECTION: A PROJECT NEVER SEEDS A RECIPIENT AT ALL, so "deal or project -> contact"
is not one mechanism with two entrances.** `rail/mail.tsx` reads `deal?.contactId` from its
own `dealId` prop and a project tab passes none, so `useContact` is disabled there and a
project composes with an empty To BY CONSTRUCTION, settled or not -- measured in Chromium
with every query landed, and confirmed on the wire: a project page requests no
`/api/contacts/<id>` at all. **What a project does have two deep is `project -> company`**,
which fills `context.companyName` and so feeds the MERGE CONTEXT rather than the recipient;
held open, `{{company.name}}` reaches the composed body unsubstituted. Two races, not one,
and only the deal's was silent -- an unfilled name placeholder stays visible, an empty To does
not. Coverage landed as `e2e/rail-compose.spec.ts`. *The original entry follows.*

`packages/web/src/components/rail/mail.tsx` resolved the contact as
`useContact(contactId ?? deal?.contactId ?? "")` -- so from a DEAL or PROJECT tab it is a
two-deep chain: the deal query must settle before the contact query is even enabled, and
`compose()` reads `contact` at CLICK time. Click Compose before both have landed and the
seed carries `to: []`, which is a blank compose: no recipient, and (since v1.2.0) the caret
in To rather than in Subject. Nothing waits on either query and no test covers the deal or
project tabs at all -- `e2e/composer-focus.spec.ts` uses a contact, whose chain is one deep
and which now waits on the record heading before clicking. (**That last claim is one word too
strong**, corrected while implementing: the PROJECT tab was genuinely untouched, but
`e2e/mail.spec.ts` opens a DEAL tab -- it never presses Compose, so what holds is that no test
had ever built a seed from either tab.) **Fix:** disable the Compose
button until the queries it reads have settled, which also removes the silent
wrong-recipient case rather than only the focus symptom. Found during 7.5 Task 2's review;
out of scope there because Task 2 owned the composer, not the rail.

~~**Conditional blocks in mail templates.**~~ **GONE, NOT FIXED: v1.2.2 Task 3 removed
the mail template feature outright, so there is no mail merge left to grow a conditional
into.** `({{contact.pronouns}})` rendered `()` for a contact with none; swallowing one
following space handled `Dear X Y` and nothing short of conditionals handled brackets or
labels. The document template's own `{{#path}}...{{/path}}` is unaffected. The record
below is kept because the MEASUREMENT is worth keeping, not because anything is open.

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

## Intermittents -- FIVE now, and every rate below is measured rather than remembered

**v1.2.1 Task 4 harvested 313 workflow runs, 18-31 Aug** -- every run of `test.yml` GitHub
still holds. 284 on `main`, the merged phase and version branches and the release tags; 13 on
the in-flight `worktree-v1.2.1-fixes`; 16 on deliberately-broken experiment branches, excluded
by name. **Every denominator is measured from the logs rather than inferred from a commit
date**: an attempt counts only if its own log shows that test running, so a rate is never
divided by attempts that predate the test. They are ATTEMPTS, not runs -- a re-run is a second
trial and hides the first.

**THE DOVECOT DENOMINATOR HAS BEEN STATED THREE WAYS, AND ALL THREE NUMBERS ARE CORRECT --
they count three different populations. The canonical one is 177.** Settled in v1.2.2's
release task by re-deriving each figure from the Actions API rather than by choosing between
them:

| figure | what it actually counts | measured |
|---|---|---|
| **177** | **ATTEMPTS of `test.yml` that ran the storm case**: everything since the Dovecot suite entered CI on 20 Aug, less the 16 experiment-branch runs excluded by name. **174 runs, 177 attempts** -- three re-runs in that window are the whole difference | 31 Aug 01:08Z |
| **313** | **RUNS of `test.yml` over its entire history** -- the harvest this section opens with, 284 + 13 + 16 exactly as broken down above. The same instant shows 319 attempts | the same instant |
| **354 / 360** | **runs / attempts of EVERY workflow in the repository**: `test.yml`, `Release`, `Mutation probe` and `Audit61` together (339 + 20 + 2 + 2 = 363 runs today) | 31 Aug 04:52Z |

Each was pinned by finding the instant at which the count is exactly that number, and each
instant lands inside the task that reported it: 313 runs is the moment `worktree-v1.2.1-fixes`
had exactly the 13 runs this section attributes to it, and 354 all-workflow runs is a run on
`worktree-v1.2.2-templates` at 04:52 on 31 Aug, in the middle of item 3's investigation.

**SO ITEM 3'S CORRECTION -- "the sample is 354 runs / 360 attempts, not 313" -- WAS ITSELF
WRONG, AND IS WITHDRAWN.** It compared its own all-workflow count against a `test.yml`-only
one and read the difference as an error in the earlier figure. `test.yml` has 339 runs in
total TODAY and has never had 354, so the number is arithmetically impossible for the
population it was correcting. **313 was right, and it was right as RUNS**, which is what
this section already called it.

**177 is canonical because it is the only one whose denominator could have produced the
numerator.** The other two include attempts that could not: 132 `test.yml` runs predate the
suite entirely, 20 `Release` runs never start Dovecot, and the experiment branches were red
on purpose. **4 in 177 = 2.3%, about 1 attempt in 44** -- which is the figure
`mail-integration.test.ts` states in its own prose, so the code and this table now agree.

**The population has since grown to 210 attempts with no further sighting**, so 1-in-44 is a
high-water mark rather than a current estimate. It is not restated as 4-in-210 because five
of the intervening attempts were deliberately-broken probe branches, where a Dovecot firing
would have been masked by the failure the branch existed to produce.

| intermittent | rate | 95% interval | over | recommendation |
|---|---|---|---|---|
| ~~Dovecot IDLE burst (2)~~ | **4 in 177, 2.3% -- 1 CI attempt in 44** | 0.9-5.7% | 20-31 Aug | **FIXED in v1.2.2.** Historical rate, kept for the method |
| `pipeline.spec.ts` keyboard-drag (5) | **2 in 179 since 20 Aug, 1.1%** | 0.3-4.0% | 20-31 Aug | **FILE IT** |
| `crm.spec.ts` "Other..." caret (4) | **1 in 50, 2.0%** | 0.4-10.5% | 29-31 Aug | leave and re-measure |
| phone kanban `addStage` (3) | **0 in 111** | 0-3.4% | 28-31 Aug | **CLOSE IT** |

The intervals are Wilson, and they are in the table because three of the four rates rest on
0, 1 or 2 events. **Only the Dovecot row is separated from zero.** The other three are each
consistent with anything from "never" to "one run in ten", and no amount of re-reading the
same logs will narrow them -- only more runs will.

**WHAT A GREEN RUN CANNOT TELL US, and it decides how to read three of those four rows.**
`playwright.config.ts` sets `retries: 2` on CI, so an e2e journey that fails once and passes
is a `flaky` line inside a GREEN run, and one that fails three times is a red run. **An e2e
rate measured this way is the rate of *at least one* failure in three attempts** -- it cannot
separate "fails 1 attempt in 3" from "fails 1 attempt in 100", so the three e2e figures above
are upper bounds on their per-attempt rates rather than the rates themselves. **`vitest.config.ts`
sets no retries at all**, so the Dovecot figure is a TRUE per-attempt rate and a unit flake
cannot hide inside a green run.

**AND A RE-RUN HIDES THE ATTEMPT BEFORE IT.** `gh run list` reports a workflow's LATEST
attempt only, so a first attempt that failed and a second that passed shows as a green run.
Two of the four Dovecot firings are invisible that way. Any future harvest must read
attempts, not runs.

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
2. ~~**`mail-integration.test.ts`'s Dovecot IDLE burst -- 4 in 177, about 1 CI attempt in
   44. RECOMMENDATION: SCHEDULE IT.**~~ **DIAGNOSED AND FIXED in v1.2.2 -- see item 3's
   answer below.** The test was asserting that twenty messages arrive in ONE walk, which is
   stronger than anything `AccountSync` promises; it now re-walks from the cursor until
   twenty arrive or a budget expires, which is what the loop does. Everything below is kept
   because the METHOD is what generalises -- reading attempts rather than runs, and refusing
   to divide by attempts that predate the test. The burst asserts 20 delivered and gets
   fewer. Opt-in suite, CI-only. It was the only intermittent here with a real number and
   the only one that turns CI red, because vitest sets no retries.

   **THE COUNT IS FOUR, NOT TWO, AND TWO OF THEM WERE RE-RUN INTO INVISIBILITY.** The two
   visible firings are run **33094190471** (27 Aug, the v0.9.0 tag, 11 of 20) and run
   **33325721506** (30 Aug, `a15e6f6`, 11 of 20). The two hidden ones are second attempts that
   went green over a failed first: **33191112378** attempt 1 (28 Aug, Phase 7, 16 of 20) and
   **33282731058** attempt 1 (30 Aug, v1.1.0, 17 of 20). **The visible history understates
   this by half**, which is exactly why the release checklist's "if it fires, re-run it and
   SAY SO" is load-bearing.

   **"ONCE IN 22 RUNS ON THE v1.2.0 BRANCH, AND ONCE ON `a15e6f6`" WAS ONE EVENT COUNTED
   TWICE**, and the old rate rested on it. `a15e6f6` IS on `worktree-v1.2.0-a11y`; that
   branch's 25 runs contain exactly one unit failure and it is that one.

   **What the four firings say about the mechanism.** They saw 11, 16, 17 and 11 of the 20
   messages -- never 0 and never a wedged wait -- so this is a PARTIAL VIEW rather than a lost
   wake. `walkToEnd` stops as soon as one `fetchNewer` returns fewer than the batch size, on
   the idler's own connection, the instant the wake settles; a lagging view on that connection
   and a real hole in `fetchNewer` both produce exactly this shape, and the logs cannot
   separate them. **Which of the two it is has to be measured before anything is changed** --
   the second would be a product defect in the sync loop, not a test-side wait.

   **SCHEDULED AS v1.2.2 ITEM 3, and framed there as the product question rather than as this
   flake: can Conduit fetch part of a batch of new mail and never come back for the rest?**
   That item is DIAGNOSTIC ONLY -- instrument, report, stop -- and if the answer is yes it
   reorders the rest of v1.2.2. Do not "stabilise" this test in the meantime: a change to
   behaviour before the cause is known makes the question unanswerable.

   **Why it is worth scheduling rather than watching.** At 4 in 177 a branch of 14 pushes has
   a **27%** chance of going red at least once, and it takes about 30 pushes to reach even
   odds. "It will probably not fire this release" is true, and is not much comfort.

   **A SURVIVING, DIFFERENTLY-SHAPED HAZARD IN `mail-sync.test.ts`, so it does not vanish
   under the struck-through entry above.** Two cases still assert a NEGATIVE over a
   wall-clock window: the poll-only degradation case sleeps a bare 50ms and then asserts
   `sync.stats.passes` is exactly 1, and the SyncManager section has a 30ms sibling. v0.9.1's
   backlog logged that shape as its own flake candidate. It is **not** the intermittent 7.5
   Task 4 fixed and was correctly left alone: a scheduler stall there falsifies an assertion
   and says so by name, rather than wedging into an anonymous timeout. Nothing to fix
   urgently; something to recognise if either case ever fails.
3. ~~**`e2e/mobile.spec.ts`'s phone kanban `addStage`.**~~ **0 in 111. IT HAS NEVER FLAKED IN
   CI AT ALL. RECOMMENDATION: CLOSE IT as a CI intermittent.** Not a flaky line, not a retry,
   not a red run, in the 111 attempts that ran it -- nor has any other `mobile.spec.ts`
   phone-kanban journey. **Both sightings were in the LOCAL hybrid loop**, where Playwright is
   configured `retries: 0` and the machine is doing other work. The "once in eight runs"
   figure the entry below opens with was never a CI rate.

   It is not proof of never -- the Wilson interval reaches 3.4% -- but there is **no CI
   evidence for the sticky-strip interception theory in either direction**, so chasing it
   would be chasing a local artifact. Re-open it the day one appears in a runner's logs. *The
   original entry is kept below for the occlusion lead, which is still the best guess anyone
   has.*

   **THIRD SIGHTING, AND STILL LOCAL ONLY.** v1.2.2 Task 3's hybrid loop hit it once on the
   same test ("builds a pipeline, which becomes a stage view once it has stages"), and it
   passed both in isolation and on a straight re-run of the whole file immediately after.
   The recommendation is unchanged and so is the reason: three sightings, all in the local
   loop, none in a runner.

   **"Pre-existing" is not established**: `board.tsx` put a sticky strip
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

4. **`e2e/crm.spec.ts`'s "Other..." caret journey -- 1 in 50, 2.0%. RECOMMENDATION: LEAVE IT
   AND RE-MEASURE** once v1.2.1 has accumulated runs. One event in a journey that was two days
   old when it was measured, and its interval reaches 10.5%, so "rare" is not yet established
   either. The one sighting is CI run **33311033649**, hidden by the first retry
   (`1 flaky, 131 passed`). It failed on `getByTestId("salutation-other")` "element(s) not
   found", i.e. the box the Select's "Other..." option reveals had not rendered when the value
   was read.
   **Sighted on a 7.5 Task 2 diff that cannot have caused it**: the only file Task 2 shares
   with `contact-fields.tsx` is `components/ui/input.tsx`, and that change is comment-only
   (`git diff 46a70b3..32ba01c -- packages/web/src/components/ui/input.tsx`). Worth noting
   beside the others because it is the only focus-shaped one -- the other four are a
   clock, an IMAP burst, a sticky strip and a keyboard drag -- and because `contact-fields.tsx`
   documents at length that this control's focus is restored by Radix *after* a re-render,
   which is a race the test observes rather than controls.

5. **`e2e/pipeline.spec.ts`'s two keyboard-drag journeys -- NEWLY NAMED, and it is the biggest
   intermittent in the logs. RECOMMENDATION: FILE IT.** Nobody had ever named this one, and
   **22 of the 27 flaky lines in all 313 harvested runs are these two journeys**. Almost all
   of that is historical -- 17 flaky and 18 red in the 82 runs to 19 Aug, while the drag was
   an open bug being fixed -- so the epidemic era is over. **Since 20 Aug it is 2 flaky in 179
   attempts and zero red**, which is a real but rare intermittent rather than a dead one.

   **It is much commoner in the LOCAL hybrid loop than on a runner**: v1.2.1 Task 5, running
   twenty-two mutation rounds through that loop, reported it firing in roughly **one run in
   three** there. That figure is Task 5's own working observation and is recorded here as
   reported -- it was not written down as an instrumented count in any commit, so treat it as
   an order of magnitude and not as a rate. It is consistent with the CI picture in the way
   that matters: `retries: 2` on CI absorbs most of it, and the local loop retries 0 times.

   Nothing has been changed here. This entry exists so the next person to see a red
   keyboard-drag finds a number instead of a shrug.

   **THIRD SIGHTING SINCE 20 AUG, on v1.2.2 Task 3's CI run `33365166752`** (`1 flaky, 160
   passed`), on `pipeline.spec.ts:173`'s downward-drop journey -- a file that commit does
   not touch. Reported rather than absorbed: the run is green because `retries: 2` caught
   it on the second attempt, not because the suite passed clean. The rate above is left as
   measured rather than recomputed, since that would need the whole harvest re-run; read it
   as 3 flaky since 20 Aug rather than 2, against an attempt count that has also grown.

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

~~**A SWEEP FOR ASSERTIONS THAT CANNOT FAIL. Nobody has ever gone looking.**~~ **RUN in
v1.2.1 as item 6. SEVEN FOUND AND REPAIRED**, from twenty-two mutations -- eighteen through
the local hybrid loop against the dev server (seventeen in the app, one in a test's own
fixture) and four on throwaway CI branches, for the two files that need Dovecot and Mailpit:

| file | the assertion that could not fail |
|---|---|
| `pipeline.spec.ts` | a won deal's absence from the board |
| `pipeline.spec.ts` | an archived pipeline's absence from the index |
| `crm.spec.ts` | an archived company's absence from the list |
| `crm.spec.ts` | an archived pipeline's absence from a company, and the "No pipelines" label it called a loaded-list sentinel |
| `tasks.spec.ts` | "Done starts off-screen", the premise the whole off-screen-drag regression rests on |
| `tasks.spec.ts` | "the cascade moved Build", which `toPass` had already established a line earlier |
| `mail.spec.ts` | a linked thread's absence under the unlinked filter |

**SIX OF THE SEVEN ARE ONE SHAPE, and it is cheap to look for: an absence asserted of a
surface that has not rendered yet.** Every one of those rows comes from a query, so for the
first moments after a navigation or a filter toggle there is nothing there at all -- and a
**negated auto-retrying matcher is satisfied on its very first poll by an element that does
not exist**. Each is repaired by putting a loaded-list sentinel in front of it: a row that IS
there, an empty label that renders only when the query has settled, or the response itself.
Every repair was then re-run under the mutation that had walked past its predecessor, and
every one went red. **The seventh is a sentence rather than an assertion** -- `mail.spec.ts`'s
warm reply test claimed two `rich-text.tsx` lines were what held it; measured on two CI
mutation branches, it holds one, and the comment now says which.

**READ THIS BEFORE QUOTING THE NUMBER SEVEN. THOSE SEVEN ARE DEFECTS IN THE TESTS, NOT IN
THE APPLICATION.** Repairing them changed no application behaviour -- every repair is a
sentinel or a response wait added to a spec -- and **not one repaired assertion turned CI
red**. That is the evidence, rather than an assurance: if something real had been hiding
behind a dead assertion, waking the assertion up is what would have exposed it, and nothing
was exposed. The suite was claiming less than it appeared to; the app was doing what it was
supposed to. **Conduit did not have seven bugs.**

**ONE GENUINE APPLICATION DEFECT CAME OUT OF THE SWEEP**, and it was found by READING the
surface behind a suspicious assertion rather than by a repair going red: the five lists that
render their empty label with no loading branch, at the head of the deferred-defects section
above. **Fixed in v1.2.2's item 2 on 31 Aug**, each with a journey shown failing first. That
is the whole application-side yield, and stating it plainly is the point -- the sweep's value
was in what the tests were failing to claim.

**The discovery-rate argument is now settled in the direction it was posed.** Seven in one
deliberate pass, against four found by accident in the whole project to date. The candidate
shapes below are still the right things to grep for; nobody should conclude the suite is now
clean.

The incidental evidence that argued for the sweep, kept because it is what set the method:

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
3. **Authentication.** Conduit has almost none of its own — it trusts a `Ynh-User` header
   that YunoHost's SSO injects. 7.6 added the one exception, and it is narrow enough to be
   worth stating precisely: `POST /api/reauth` checks a password against YunoHost's portal
   API before either data download, and mints a single-use ticket. Conduit still stores no
   password and still has no login of its own; what it has is one gate that asks YunoHost
   to check one. A non-YunoHost deployment is a packaging question only while it stays
   single-user; multi-user means real login, sessions and password reset — and 7.6's ticket
   store is the first thing in this codebase that would have to grow into the second of
   those.
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
