# The mail e2e run that went red — diagnosed

**DIAGNOSE, REPORT, STOP. Nothing was changed as a result of this document**; every
recommendation is a proposal for Chris, and the one file this task wrote is this one. The two
lines that would fix the biggest of these are named below and deliberately not applied.

Harvest instant: **2026-09-05, ~07:30Z**. Method and commands are in "How this was measured"
at the foot. The subject is CI run **33947079397** on `9924b58` (`spec-phase-8`, docs-only),
and the `playwright-report` artifact that `if: always()` kept — the first time this repository
has had one from a run like this, and it settled the question in an afternoon.

---

## 0. Three corrections to the brief, before anything else

The brief's reading of the log is wrong in three ways, and each changes the diagnosis.

1. **`mail.spec.ts:1083` did not "fail outright after all retries". It is one of the two
   flaky ones.** It passed on attempt 0 (924 ms) and attempt 1 (6605 ms) and failed on
   attempt 2. The `unexpected` verdict — the run's red — belongs to **`mail.spec.ts:2667`**,
   which failed on its **first trial** and **was never retried at all**.
2. **Nothing in this run was retried three times and failed three times.** The three `✘` lines
   are three *different* tests failing on three *different* attempts. The block is
   `test.describe.serial`, so a failure skips the rest of the block and restarts the whole
   block; each restart died at an *earlier* test than the one before.
3. **This is not the first time, and it is not close to it.** It is the **sixth** red run of
   this family in **26 attempts**, and the fifth was **the v1.6.0 release run itself**
   (`33946140366`, 21 minutes earlier, on ref `v1.6.0`). That run's report artifact also
   survives, and it reproduces the whole mechanism independently.

---

## 1. The answer, in one table

| | what it is | supported? |
|---|---|---|
| **Why the run is RED** | A serial block restarts from the top on retry, into a **Dovecot mailbox and a Postgres database that are never reset between attempts**. Each restart leaves a full fixture set behind, so each restart fails *earlier* than the last. The test that actually failed first is therefore never re-run, and its verdict stands. **Retries do not converge here; they diverge.** | **yes** — two independent runs, monotone and identical |
| **`2667`** (first trial, the red) | Two IMAP appends 0.8 s apart in consecutive tests. `Date:` headers are RFC 2822, **whole seconds**, so the two threads tie on `last_message_at`, and the list's tiebreak is `desc(id)` over a **random UUID**. A coin flip decides row order. | **yes** — the two UUIDs in the error message are in exactly the order `desc(id)` produces |
| **`1620`** (retry #1, "4 selected") | Phase 4.4 Task 3 added two messages dated `new Date()` **in the last two tests of the file**. When attempt 0 dies there, the next attempt's `seedMailbox()` runs ~1.6 s later and back-dates its bulk trio to `now−1s…now−4s` — a window that now **straddles the instant the previous attempt finished**. Those two leftovers sort *between* the archive pair, so the shift-range takes four rows. | **yes** — the geometry is preserved in the *other* failure's page snapshot |
| **`1083`** (retry #2) | Page one is **25 rows** (`thread-list.tsx`'s `DEFAULT_LIMIT`). Each attempt contributes ~8–11 threads newer than its own `now−20 min`, and every attempt's leftovers stay. By the third attempt the 25 slots are full and **Alice's thread is on page two** — where the assertion, which runs *before* `loadAllThreadsOn`, cannot see it. Deterministic, not racy. | **yes** — in the release run, row 25 is Bob's thread at `now−10 min` and Alice's at `now−20 min` is the next one |
| **`2566`** (first trial of the release run) | `Backlog … 00` absent with a "Load more" still on screen and only 25 rows. | **NO — see §6. I will not name a mechanism I cannot support.** |

**Rate: 6 red in 26 attempts since Phase 4.4 opened, 23.1% (Wilson 95%: 11.0–42.1%).**
Before Phase 4.4: **1 red in 308 attempts, 0.3% (0.1–1.8%)** — and that one was a
deterministic feature-branch bug, not an intermittent (§7). The intervals do not overlap.

**And the number that matters most: since Phase 4.4, the retry recovery rate on this spec is
0 of 6.** Every first-trial failure turned its run red. For scale, the prior harvest's figure
for every other e2e intermittent in repository history is 36 recoveries out of 36.

---

## 2. Why the run is red: the cascade

`playwright.config.ts` sets `retries: 2` in CI, and `e2e/mail.spec.ts` is one
`test.describe.serial` block of 39 tests sharing one page and one `beforeAll`. Playwright's
serial mode, on a failure, **skips the remainder of the block and re-runs the entire block**
in a fresh worker.

Nothing resets the mailbox or the database between those attempts. `beforeAll` re-seeds a
complete fixture set into the same Dovecot INBOX every time, and the spec's answer to that is
per-attempt naming — `attemptId = ${runId}x${testInfo.retry}` — which keeps *subjects* unique
but leaves every earlier attempt's threads in the list, in the rail, and in the sort order.
The file knows this and says so in a dozen comments. It is a deliberate design, and it works
right up to the point where the number of leftovers crosses a threshold.

What the report artifact shows is that the threshold is now crossed on the second and third
attempt, every time. Both surviving reports show the same monotone shape:

| | run `33947079397` | run `33946140366` (the v1.6.0 release run) |
|---|---|---|
| attempt 0 dies at | **L2667** (39th test) | **L2566** (37th test) |
| attempt 1 dies at | **L1620** (15th test) | **L1698** (17th test) |
| attempt 2 dies at | **L1083** (4th test) | **L1083** (4th test) |

And the same dose-response on the one test that ran in all three attempts of both runs:

| L1083 | attempt 0 | attempt 1 | attempt 2 |
|---|---|---|---|
| `33947079397` | passed, 924 ms | passed, **6605 ms** | **failed, 60635 ms** |
| `33946140366` | (not reached) | passed, **6613 ms** | **failed, 60577 ms** |

6605 ms and 6613 ms, in two independent runs. That is not a race. That is a list filling up.

**The consequence is the red.** In `33947079397`, L2667 failed at 05:27:31 on attempt 0. It
was never run again: attempt 1 died at L1620 and attempt 2 at L1083, both far earlier in the
block, so L2667 was `skipped` twice. Its `unexpected` verdict is what makes the run red, and
**no retry ever addressed it**. The retry budget was spent entirely on failures the retries
themselves created.

---

## 3. `mail.spec.ts:2667` — a one-second tie, decided by a random UUID

This is the failure that turned the run red, and it is **not** a contamination failure: it
happened on attempt 0, against a mailbox holding only its own fixtures.

The chain is short and every link is checkable:

- The fixtures write `Date: ${new Date().toUTCString()}` — RFC 2822, **whole seconds**.
  `rfc822()` is a plain header join and adds nothing.
- `mail-ingest.ts:802` — `const sentAt = parsed.date ?? new Date();` — takes that header
  verbatim, and `lastMessageAt` is set from it (`:869`, `:1017`).
- `mail-threads.ts:808` — `.orderBy(desc(mailThreads.lastMessageAt), desc(mailThreads.id))`.
- `schema.ts:552` — `id: uuid("id").primaryKey().defaultRandom()`. **A tie is broken by a
  random UUID.**

Test L2622 appends the backlog reply at ~05:27:30.1; test L2667 appends `Latebreaking` at
~05:27:30.9 (from the report's own per-test start times). **Both truncate to the second
`05:27:30`**, so both threads carry the same `last_message_at`, and the sort falls through to
the UUID.

The error message is the proof rather than an intuition:

```
Expected: "thread-row-acf29584-92b9-4abe-9771-26661004b102"   <- Latebreaking, appended LAST
Received: "thread-row-c90d5a82-4592-4926-adcc-fcb6d29415b9"   <- the backlog thread
```

`c90d…` sorts above `acf2…` under `desc(id)` — **exactly the order observed**. Had the two
timestamps differed by even one second the id would never have been consulted, and the
later-appended message would have won. Only a tie explains this.

The gap between the two appends is ~0.8 s, so they share a clock second on the order of 20% of
runs, and the tiebreak is then fair. The two `spec-phase-8` runs 75 seconds apart — one green,
one red, both docs-only — are that coin being tossed twice.

---

## 4. `mail.spec.ts:1620` — "4 selected", and an invariant that Task 3 quietly broke

`folderFixtures` back-dates the bulk trio to `now−1s … now−4s` and states its invariant in
capitals:

> Nothing else in this mailbox — from this attempt or any earlier one — can carry a timestamp
> inside a window three seconds wide that was opened when this attempt started, so nothing can
> sort between them.

**That was true until Phase 4.4 Task 3, and it is now false in a systematic way, not a lucky
one.** Task 3 (commit `3434467`) added two APPENDs dated `Date: new Date()` — i.e. dated *the
moment they run* — in tests L2622 and L2667, which are **the last two tests in the file**.

So when attempt 0 dies in those two tests, the timeline is:

```
05:27:30.1   attempt 0, L2622 appends the backlog reply    (Date: ...:30)
05:27:30.9   attempt 0, L2667 appends Latebreaking          (Date: ...:30)
05:27:31.8   attempt 0 fails; worker torn down
~05:27:33.1  attempt 1's seedMailbox() takes `now`
             -> its bulk trio is dated 05:27:29.1 .. 05:27:32.1
```

The two leftovers land **inside** the window the archive pair reserves. The retry gap and the
back-dating window are the same size, so this is not a rare coincidence — the retry
systematically aims at it.

**The evidence is direct, and it is preserved in a different test's snapshot.** The retry-#2
page snapshot of the same run still shows the geometry that failed on retry #1:

```
row 7   Shipping mtnxyelbx1        <- archiveSubjects[1], attempt 1, ticked first
row 8   Backlog mtnxwviux0 02      <- attempt 0's leftover, dated at attempt 0's end
row 9   Latebreaking mtnxwviux0    <- attempt 0's leftover, dated at attempt 0's end
row 10  Invoice mtnxyelbx1         <- archiveSubjects[0], attempt 1, shift-clicked
```

The range takes every row between the two clicked, over the **visible** order
(`thread-list.tsx`'s `ThreadToggle.order`). Four rows. `bulk-count` said `4 selected`. The
assertion did its job perfectly — it caught a range that had swept up two extra rows, which is
precisely what its comment says it exists to catch.

---

## 5. `mail.spec.ts:1083` — page one is full, and no amount of polling will help

The failing assertion is the first one in the test:

```ts
await pollWithReload(async () => {
  await expect(threadRow(aliceSubject)).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
  ...
  await loadAllThreadsOn(page);          // <- 11 lines BELOW the assertion that failed
```

Alice's second message is dated `now − 20 min`. Page one is 25 rows. The snapshot shows
**exactly 25 rows and a "Load more" button**, and `Renewal mtnxyvay` is not among them.

**It was ingested; it was simply on page two.** Two independent lines of evidence:

1. Alice's two messages are the **first** entries in `fixtures()` and are appended before
   everything else — yet fixtures appended *later in the same loop* (`Proposal mtnxyvayx2`,
   `Statement mtnxyvayx2`) are on screen. A sync that had not reached Alice could not have
   reached those.
2. In the release run's snapshot of the identical failure, **row 25 is `Logistics mtnx7yiv`** —
   Bob's thread, dated `now − 10 min` — and Alice's, at `now − 20 min`, is the very next row.
   The page-one boundary falls exactly between them.

The arithmetic: each attempt contributes roughly 8–11 threads newer than its own `now−20 min`
(four folder fixtures seconds old, two Task 2 conversations 6.5–8.5 min old, Bob at 10 min,
plus whichever threads that attempt bumped to "now" by replying, forwarding or filing). Two
prior attempts' worth plus the current attempt's own fills 25. Attempt 1 has room; attempt 2
does not. That is why it passes at 6.6 s on attempt 1 and dies at 60 s on attempt 2, in both
runs.

`pollWithReload` cannot rescue it, because its recovery action is `page.reload()`, which resets
the list to page one — the very place the row is not.

Note that commit `57c814b` ("the e2e fixtures collided with a per-run subject, **and sat past
page one**") fixed exactly this class one release ago, and added `loadAllThreadsOn` for the
Task 2 pairs. It stopped one line short of the base fixtures.

---

## 6. `mail.spec.ts:2566` — an honest "unknown"

The release run's first-trial failure was L2566, `Backlog mtnx5hxox0 00` not found after
`loadAllThreadsOn`. Its snapshot shows 25 rows, backlog items 20–29 present, item 00 absent,
and **a "Load more" button still on screen** — i.e. the helper returned with the list
unexpanded.

There is a plausible story: `loadAllThreadsOn` returns on `(await more.count()) === 0`, which
cannot distinguish "no more pages" from "the list has not rendered yet", and `pollWithReload`
reloads on every failure, so a helper that returns early once can do so every round.

**I cannot support that from this evidence and I am not going to name it.** The report carries
no trace and no network log for that attempt, so "the helper returned early" and "the button
was disabled for 25 s" and "the ingest had not finished" are not separated by anything I can
point at. This project has already carried one intermittent misattributed to a Radix focus race
for three releases; a fifth named mechanism nobody can check is how that happens again.

What can be said: L2566, L2622 and L2667 all arrived in commit `3434467`, and each has now
produced a first-trial failure within 19 attempts.

---

## 7. Is it new? Yes, and the intervals do not overlap

| window | attempts | red from `mail.spec.ts` | rate | Wilson 95% |
|---|---|---|---|---|
| before Phase 4.4 (< 4 Sep 13:42Z) | **308** | **1** | 0.3% | 0.1–1.8% |
| Phase 4.4 era (≥ 4 Sep 13:42Z, `a57ef2c`) | **26** | **6** | **23.1%** | 11.0–42.1% |
| since Task 4.4.3 (≥ 4 Sep 21:05Z, `3434467`) | **19** | **4** | **21.1%** | 8.5–43.3% |
| since v1.6.0 merged (≥ 5 Sep 05:01Z) | **12** | **2** | 16.7% | 4.7–44.8% |

Deliberately-broken experiment branches are excluded by the convention v1.2.1 Task 4 set and
the 2 Sep harvest followed; they contributed six more `mail.spec.ts` failure lines and are
named in the method note. Including them changes nothing about the comparison, because all six
predate Phase 4.4.

**In 308 pre-Phase-4.4 attempts — the complete population back to the first run in the
repository — `mail.spec.ts` failed in exactly two, and neither is this phenomenon:**

- `33337452620`, 30 Aug, `worktree-v1.2.1-fixes`: the `route.continue: Route is already
  handled!` leak the 2 Sep harvest already recorded as a closed one-off. **That run went
  green.** It remains the only `mail.spec.ts` failure in repository history that a retry ever
  recovered.
- `32414822541`, 20 Aug, `worktree-phase-4.1-folders`: red, and **deterministic**. The same
  test failed on all three attempts with the same error in 217 / 199 / 231 ms —
  `locator.check: Clicking the checkbox did not change its state`, on the controlled folder
  checkbox. It is the bug `mail.spec.ts`'s own "click(), NOT check()" comment was written
  after, on the branch where that feature was being built.

**That second run is worth the space because it is the control.** It is the only pre-Phase-4.4
attempt where `mail.spec.ts` exhausted its retries, and it has the **opposite** signature to
§2: the same test failing at the same point three times, in a fifth of a second each. The
cascade — each attempt dying *earlier* than the last, at a *different* test — appears nowhere
in this repository before 4 September.

The six red runs, all within 16 hours:

| run | created | branch/ref | first-trial failure |
|---|---|---|---|
| `33879539048` | 4 Sep 13:42Z | `task-4.4.1-file-into-folder` | L1485 |
| `33905490830` | 4 Sep 18:21Z | `task-4.4.2-conversation-filing` | L965 |
| `33926946287` | 4 Sep 22:47Z | `task-4.4.4-folder-management` | L1870 |
| `33927258896` | 4 Sep 22:51Z | `task-4.4.4-folder-management` | L1870 |
| `33946140366` | 5 Sep 05:02Z | **`v1.6.0`** | L2566 |
| `33947079397` | 5 Sep 05:23Z | `spec-phase-8` | L2667 |

The first four had first-trial failures that were genuine defects under development (fixed by
`57c814b`, `bd859d1`, `91844a6`). **The last two did not** — they are docs-only and
release-tag commits, and their first-trial failures are the two new intermittents in §3 and §6.
But every one of the six shows the same cascade underneath, which means the cascade has been
present for the whole of Phase 4.4 and has been silently converting every mail e2e hiccup into
a red run.

**Is it one of the three known intermittents wearing different clothes? No.** The caret
(`crm.spec.ts`), the dnd-kit keyboard drag (`pipeline`/`tasks`) and the Dovecot IDLE burst
(`mail-integration.test.ts`) are all elsewhere, all absorbed by retries, and all still behaving
as the 2 Sep harvest measured. This is a fourth thing, and it is the first one in this
repository's history that retries make **worse**.

---

## 8. Do the three share a cause?

**Two do; one does not; and the one that does not is the trigger.**

- **`1620` and `1083` share a cause exactly**: state that survives a Playwright retry. So does
  the release run's `1698` (`folder-Spam` expected 0, received 1 — attempt 0 had filed into
  Spam, which switched that folder's sync on and put a row in the rail that the retry then
  found already there). Three different assertions, one defect: **the mailbox and the database
  are not reset between attempts.**
- **`2667` is independent.** A whole-second timestamp tie broken by a random UUID has nothing
  to do with leftovers; it fired on attempt 0 against a clean mailbox.

They coincide because **`2667` is what drives the block to a second and third attempt in the
first place.** Without a first-trial failure the leftovers never accumulate. So the honest
description is a two-stage failure: **an independent coin-flip test starts the cascade, and the
un-reset mailbox guarantees the cascade cannot recover.** Fixing either one alone would have
kept this run green; fixing only `2667` would leave the next trigger to do the same job.

One further link worth recording: `3434467` supplied both halves. It added the tie-prone test
*and* the two `Date: new Date()` messages that break `1620`'s three-second invariant.

---

## 9. What would settle it, in order of cost

1. **Reset the mailbox and the mail tables when `testInfo.retry > 0`.** This is the whole class
   — `1620`, `1083`, `1698`, and the ~40 comments in `mail.spec.ts` that exist only to work
   around leftovers. A `doveadm` expunge plus a truncate of the mail tables in `beforeAll`, or
   a per-attempt IMAP folder namespace. **This is the recommendation.**
2. **Confirm `2667` deterministically, which costs one test and no waiting.** Append two
   messages with an *identical* explicit `Date:` header and assert the order. If §3 is right it
   fails about half the time, which converts the hypothesis into a fact. Then give the two
   live-list appends distinct explicit `Date:` headers, or assert set membership rather than
   `after[0]`/`after[1]` by index.
3. **Move `loadAllThreadsOn(page)` above the Alice/Bob assertions in L1083** — the one-line
   change `57c814b` made for the Task 2 pairs and stopped short of making here. It is a
   one-line repair and **it is Chris's call, not mine; it is not made in this branch.**
4. **Keep `if: always()` and add `trace: "on-first-retry"`.** The always-upload is what made
   this diagnosis possible and it paid for itself twice over — two of the six red runs still
   have readable reports. What is still missing is a trace for the *first* trial, which is
   exactly the attempt whose evidence is thinnest, and it is why §6 has to say "unknown".
5. **Re-measure after any of the above.** 19 attempts is a small denominator; the interval on
   21.1% runs from 8.5% to 43.3%.

**Do not reach for `retries: 3`.** On this spec a third retry does not add a chance of
success; it adds one more restart into a dirtier mailbox.

---

## How this was measured

**Population: every run of `.github/workflows/test.yml` GitHub still holds — 472 runs, 483
attempts, 2026-08-18 to 2026-09-05T06:21Z.** Enumerated exactly as the 2 Sep harvest
prescribes, because `gh run list` shows only a re-run's latest attempt:

1. `gh api --paginate ".../actions/workflows/337101956/runs?per_page=100"` → id, `run_attempt`,
   branch, conclusion, `created_at`. Summing `run_attempt` gives 483.
2. For each run and each `A` in `1..run_attempt`:
   `gh api ".../actions/runs/<id>/attempts/<A>/jobs"` — the endpoint that makes a hidden
   earlier attempt visible at all.
3. For each job: `gh api ".../actions/jobs/<job_id>/logs"`, ANSI stripped.

**All 483 attempt logs were fetched and read — the complete population, 2026-08-18T15:21Z to
2026-09-05T06:21Z**, of which 334 non-excluded attempts show `e2e/mail.spec.ts` running (141
predate the spec or its e2e job). No window in §7 relies on extrapolation, and none relies on
the 2 Sep harvest: that report is used here only to corroborate, and it agrees.

**Numerator: an attempt whose log carries at least one `✘ … e2e/mail.spec.ts:N` line.** "Red"
additionally requires the run's own conclusion to be `failure`. First-trial failures are
separated from retries by the absence of a `(retry #N)` suffix, the same discriminator the
2 Sep harvest used.

**Excluded by convention**: `tmp/mutation-check-*` and `probe/mutation-*`, deliberately-broken
experiment branches. They account for six `mail.spec.ts` failure lines, all on 30–31 Aug, all
on branches that concluded `failure` by design.

**Intervals are Wilson at 95%**, matching the backlog and the 2 Sep harvest so the tables can be
read side by side.

**The two artifacts.** `playwright-report` from `33947079397` (494,298 bytes) and from
`33946140366` (500,312 bytes). Each is an HTML report with the full result JSON base64'd inside
`index.html` — that is where the per-attempt statuses, durations and start times in §2 come
from — plus `data/*.md` error contexts carrying the page snapshots quoted in §4 and §5.
**Neither contains a trace or a screenshot**, because `playwright.config.ts` enables neither.
That limit is the whole reason §6 is an "unknown" rather than an answer.

**What this method still cannot do.** It sees a test that failed. It cannot see the tie in §3
when the coin lands the other way, and it cannot tell how close any green attempt came to the
page-one boundary in §5. Only instrumentation, or the deterministic reproductions in §9, will
do that.
