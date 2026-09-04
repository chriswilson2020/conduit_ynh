# The three intermittents, counted — v1.4.1 Task 4

**DIAGNOSE, REPORT, STOP. Nothing in this release was changed as a result of this document**;
every recommendation below is a proposal for Chris, and the one file this task wrote is this
one.

Harvest instant: **2026-09-02, ~15:00Z**. Method, population and every command are in
"How this was measured" at the foot, so the next person re-derives the numbers instead of
trusting them.

---

## 1. The answer, in one table

| intermittent | rate | 95% interval | over | what it is |
|---|---|---|---|---|
| **`crm.spec.ts` "Other..." caret** | **3 in 135 attempts, 2.2% — 1 CI attempt in 45** | 0.8–6.3% | 29 Aug 22:46Z – 2 Sep 14:42Z | **three** sightings, all first-trial, all recovered on retry #1, all green runs |
| **dnd-kit keyboard drag** (`pipeline.spec.ts` + `tasks.spec.ts`) | **8 in 266 attempts since 20 Aug, 3.0% — 1 in 33** | 1.5–5.8% | 20 Aug – 2 Sep | all first-trial, all recovered on retry #1, **zero red** |
| *(same, the pre-20-Aug era, for scale)* | 43 in 94, 45.7% | 36.0–55.8% | 18–19 Aug | the epidemic while the drag was an open bug |
| **Dovecot IDLE burst** (`mail-integration.test.ts`) | **0 in 55 attempts since the v1.2.2 merge** | 0–6.5% | 31 Aug 08:29Z – 2 Sep | historical canonical figure stands at 4 in 177, 2.3% |

Excluding the eight attempts on deliberately-broken experiment branches, by the convention
v1.2.1 Task 4 set, the caret figure is **3 in 127, 2.4%** — the interval moves to 0.8–6.7% and
nothing else changes. The inclusive figure is the headline because for this test the log shows
the verdict of the test itself, so a red branch cannot mask it.

**A REFINEMENT ON THE PUBLISHED CAVEAT, AND IT IS GOOD NEWS.** The backlog warns that an e2e
rate measured from `flaky` lines is "the rate of *at least one* failure in three attempts" and
therefore an upper bound. That is true of a rate counted per *run*. It is not true here:
Playwright's `list` reporter prints **every trial** — `✘ … (5.3s)` for the first, `✓ … (retry
#1)` for the second — so numerator and denominator can both be restricted to first trials.
Every one of the eleven e2e firings counted above is a first-trial failure and not one of them
recurred on a retry. **These are true per-trial rates, not upper bounds.**

---

## 2. `crm.spec.ts`'s "Other..." caret: the three sightings

All three are the identical failure, on `e2e/crm.spec.ts:132`, with the identical error:

```
Error: expect(locator).toHaveValue(expected) failed
  Locator:  getByTestId('salutation-other')
  Expected: "Drs"
  Timeout:  5000ms
Error: element(s) not found
```

| # | run | attempt | branch | created | e2e summary |
|---|---|---|---|---|---|
| 1 | `33311033649` | 1 | `worktree-v1.2.0-a11y` | 2026-08-30T12:16:18Z | `1 flaky, 131 passed` |
| 2 | `33562516069` | 1 | `worktree-v1.4.0-restore` | 2026-09-01T21:42:26Z | `1 flaky, 183 passed` |
| 3 | `33588753472` | 1 | `worktree-v1.4.0-restore` | 2026-09-02T03:53:48Z | `1 flaky, 196 passed` |

**IT IS THREE, NOT ONE, AND IT WAS NOT UNRECORDED.** The task brief says the failure was "seen
once during 7.7's inventory round … recorded nowhere before now". Both halves are wrong, and
the correction is the most useful thing this harvest produced:

- Sighting 1 was **already measured and already written down**, by v1.2.1 Task 4, at "1 in 50,
  2.0%, RECOMMENDATION: LEAVE IT AND RE-MEASURE" — `2026-08-30-conduit-backlog.md`, item 4 of
  the intermittents section. It names run `33311033649` and quotes `1 flaky, 131 passed`.
- The backlog's 7.7 section then records it as **"a third e2e intermittent, now seen twice"**.
- This harvest finds a **third**. Sightings 2 and 3 are six hours apart on the same branch.

So the instruction this task was given — re-measure once runs have accumulated — is the
instruction the backlog itself left, and the answer is that **the rate has not moved**: 1 in
53 in the window the first measurement covered, 2 in 82 since. Both are the same number inside
their intervals. What has changed is the confidence: the interval has narrowed from 0.4–10.5%
to 0.8–6.3%, and **it is now separated from zero**, which the first measurement was not.

### Hypothesis: no happens-before between the commit and the navigation

**Supported, and the log carries the deduction rather than an intuition.** The test does:

```ts
await page.keyboard.press("Enter");   // commits {"salutation":"Drs"} — fire and forget
await page.reload();                   // no wait on the request, no wait on the response
await expect(page.getByTestId("salutation-other")).toHaveValue("Drs");
```

`contact-fields-lib.ts` decides whether the box exists at all:

```ts
export function optionForValue(value: string | null, presets: readonly string[]): string {
  if (value === null) return NONE_OPTION;
  return presets.includes(value) ? presetOption(value) : OTHER_OPTION;
}
```

and `contact-fields.tsx` renders the `salutation-other` input **only** under
`option === OTHER_OPTION`. "Drs" is not a preset, so a stored "Drs" always yields the box.
Therefore **"element(s) not found", sustained for the full 5000 ms, is proof that the reloaded
page read `salutation === null`** — the write was not visible to it. It is not a
slow render, not a hydration lag, not a query that had not settled: any of those would show
the box with the wrong value, or settle inside the 5 s poll.

That kills the explanation this failure has been carrying. The backlog attributes it to "the
Radix focus-restoration race `ui/input.tsx` documents". **The Radix race is the mechanism of
the FIRST half of this test** — the box mounting and losing focus to the trigger, which
`takeFocusFromTheMenu` exists to fix — **and it cannot explain a box that is absent after a
reload.** The v1.2.0 plan's own note is the accurate one: "a commit that had not landed before
the navigation … a missing happens-before … between a browser and an HTTP round trip".

`useUpdateContact` is a plain `useMutation` over `patchJson`, with no debounce and no queue, so
there is nothing between the keydown handler and the socket but the runtime. Two sub-mechanisms
fit, and they are the same bug wearing two hats:

1. **The PATCH never committed.** `page.reload()` cancels the old document's in-flight fetches.
   If the navigation commits before the request reaches the server, the write is simply lost.
2. **The PATCH committed into the blind window.** It reached the server, but after the
   reload's `GET /api/contacts/:id` was served and before the new page's SSE stream was
   subscribed — so the invalidation that `sse.tsx` would have turned into a refetch was
   emitted to nobody. This is the wider of the two windows (page load plus SSE connect, tens to
   hundreds of ms) and is the better fit for a 2% rate.

**A third possibility that must not be assumed away**: the reload could have landed the detail
page in an error or not-found state, in which case the whole salutation row is absent for a
reason that has nothing to do with the write. Nothing in the log excludes it.

### What would settle it, in order of cost

1. **Keep the report artifact on a flaky run.** Playwright already writes
   `test-results/…/error-context.md` for the failing trial — the failure message names the
   file. `.github/workflows/test.yml` uploads `playwright-report/` under `if: failure()`, so on
   a run that is flaky-but-green **the artifact is written on the runner and thrown away**.
   Verified: `actions/runs/<id>/artifacts` returns `total_count: 0` for all three sightings.
   Changing that condition to `if: always()` — or adding `trace: "on-first-retry"` — makes the
   next sighting self-explaining, and separates sub-mechanism 1 from 2 from the third
   possibility in one shot. **This is the whole fix to the instrumentation and it is two lines.**
2. **A deterministic reproduction**: `page.route` the PATCH with a delay, press Enter, reload
   immediately. If the hypothesis holds this fails 100% of the time, which converts the
   hypothesis into a fact without waiting for CI to oblige.
3. **The fix, when it is scheduled, is a happens-before, not a retry**: wait on the PATCH
   before reloading (`page.waitForResponse` on the contact PATCH), which is what the test
   currently assumes and does not assert. That is a one-line change to the test and it does not
   weaken what the test proves — but **it is out of scope for this task and is not made here.**

---

## 3. Recommendation

**RECORD IT, INSTRUMENT IT, AND DO NOT SCHEDULE THE FIX YET — but stop calling it Radix.**

- At 1 attempt in 45, absorbed by `retries: 2` every time, it has never turned a run red and
  has never cost anyone a re-run. That does not earn a slot ahead of anything in v1.4.1.
- **The interval is now separated from zero**, so it is a real intermittent and not a ghost.
  "Leave and re-measure" has been the recommendation once already; leaving it a second time
  with no change is how a flake becomes permanent furniture.
- So the cheap half is worth doing and the expensive half is not: **take the artifact-retention
  change (item 1 above), leave the test alone.** The next sighting then arrives with its own
  evidence, and whoever fixes it will not need to reproduce it first.
- **Correct the attribution in the backlog whenever it is next touched.** An entry that names
  the wrong mechanism is worse than one that says "unknown", because it stops the next reader
  looking.

For comparison, the keyboard drag is **three times commoner** (3.0% against 2.2%) and is the
one with a filed recommendation already. Nothing found here changes that ordering.

---

## 4. What the harvest turned up that nobody was looking for

1. **The keyboard-drag rate has roughly tripled against its published figure.** The backlog
   records "2 flaky in 179 attempts since 20 Aug, 1.1%", later corrected to 3. Measured to
   today it is **8 in 266, 3.0% (1.5–5.8%)**. The published figure was not wrong — this method
   reproduces it exactly at the instant it was taken — the population has simply grown and so
   has the count. Seven of the eight are `pipeline.spec.ts:173`'s downward-drop journey.
2. **The eighth is `tasks.spec.ts:466`, on 2 Sep, and that is the interesting one.** It is the
   off-screen-column journey in the very file whose `keyboardDragCard` helper was given
   aria-live waits so a swallowed keydown would "self-heal inside the test instead of burning a
   retry" (`playwright.config.ts`'s own comment). **The self-healing helper did not heal this
   one.** Worth a look by whoever owns that entry; it may mean the helper misses a case, or it
   may mean this sighting is a different mechanism wearing the same name.
3. **Every `flaky` line in the repository's history, for the first time in one place**: 36
   flaky test instances across 35 attempts of 400. 31 are the keyboard drag, 3 are the caret,
   1 is a leaked route (below), and 1 is on a deliberately-broken mutation branch. **There is no
   fifth unexplained e2e intermittent hiding in the logs** — which is itself worth recording,
   because until now nobody could say so.
4. **A one-off that is a test-isolation defect, not a product intermittent.** Run
   `33337452620`, 30 Aug, `worktree-v1.2.1-fixes`: `mail.spec.ts:1387` failed with
   `route.continue: Route is already handled!` raised from the **`**/api/mail/accounts` delay
   handler registered by a different test in the same file**, followed by `Target page … has
   been closed`. A route interceptor outlived its test. `e2e/mail.spec.ts` today registers that
   handler as a named `holdAccounts` and calls `page.unroute` for it, so this looks already
   closed, and there has been no second sighting in the 100+ attempts since. Recorded so it is
   not rediscovered as a new flake.
5. **Two runs that read green in `gh run list` had a failing first attempt** — `33191112378`
   and `33282731058`, both `mail-integration.test.ts`. Concrete confirmation of the backlog's
   "a re-run hides the attempt before it", with ids attached.
6. **The Dovecot fix is holding.** 0 firings in the 55 unit attempts since v1.2.2 merged, and
   all six `mail-integration` failures in the whole history predate that merge. The interval is
   0–6.5%, so this is "no evidence it still fires" rather than "proven gone".

---

## 5. For Task 5, which owns it: the `Errors 1 error` question

Noted in passing, not chased.

**In all 401 CI attempts of the unit job — the entire history of `test.yml` — there is not one
`Errors  N error` line, no `Unhandled Errors` banner, no `40P01`, and no `deadlock`.** Every
vitest summary in CI is `Test Files … passed / Tests … passed`, or a named test failure.

That is consistent with the phenomenon being **local to the dev server and not to vitest**, and
it fits the pairing reported today (an `Errors 1 error` alongside a `mail-move.test.ts`
deadlock in `truncateAll`, `PostgresError 40P01`): a deadlock between concurrent truncations is
a property of a database with other work on it, which CI's throwaway service container never
has and a shared dev server does. **It is a fit, not a finding** — one local pairing is one
observation, and CI's silence cannot confirm a mechanism it has never exhibited. Task 5 should
treat the CI figure as a boundary on where to look, not as an answer.

---

## How this was measured

**Population: every run of `.github/workflows/test.yml` that GitHub still holds — 394 runs,
401 attempts, 2026-08-18T15:21Z to 2026-09-02T14:42Z.** 388 runs have one attempt, 5 have two,
1 has three. 401 attempts carry a `test` (unit) job; 400 carry an `e2e` job — the exception is
run `32153940252`, the first run in the repository, from before the e2e job existed.

**ATTEMPTS, NOT RUNS, and here is how they were enumerated**, since this is the step the brief
warns about. `gh run list` reports a workflow's latest attempt only. The runs API does the
same, **but it returns `run_attempt`**, which is the count. So:

1. `gh api --paginate ".../actions/workflows/337101956/runs?per_page=100"` → id, `run_attempt`,
   branch, event, conclusion, `created_at` for all 394 runs. Summing `run_attempt` gives 401.
2. For each run and each `A` in `1..run_attempt`:
   `gh api ".../actions/runs/<id>/attempts/<A>/jobs"` → the job ids **for that attempt**.
   This is the endpoint that makes an earlier attempt visible at all.
3. For each job: `gh api ".../actions/jobs/<job_id>/logs"`, ANSI stripped, filtered to the
   lines that carry verdicts. 801 job logs, none empty.

**Every denominator is measured from the logs, never inferred from a commit date** — the rule
v1.2.1 Task 4 set. An attempt counts toward a test's denominator only if that attempt's own log
shows that test running:

- caret: 135 attempts contain the line
  `e2e/crm.spec.ts:… › puts the caret in the Other... box …`. The test entered CI at commit
  `95ee4f5`, 2026-08-29T22:46Z, and the first attempt to show it is `33279418794`, created
  2026-08-29T22:46:59Z. There is no attempt in the denominator that predates the test.
- keyboard drag: 360 attempts contain a `keyboard-drag` test line; 266 of them from 20 Aug.
- Dovecot: 268 attempts contain `mail-integration.test.ts`; 55 of them since the v1.2.2 merge
  (`cab7cd2`, 2026-08-31T08:28:56Z).

**Numerator: a `✘` line without a `(retry #N)` suffix** — a first-trial failure. Cross-checked
against the `N flaky` summary block, which lists the tests that failed and then passed. The two
agree on all eleven e2e firings.

**Deliberately-broken experiment branches**, excluded where stated and named rather than
guessed at: `tmp/mutation-check-task1/5/5b/5c/5d` (6 attempts that ran the caret test),
`probe/mutation-a` (1), `probe-v1.2.2-mail-recovery` (1). All eight concluded `failure` by
design. `claude/friendly-ishizaka-2c17b5` is **not** excluded — it was green.

**Intervals are Wilson at 95%**, the same as the backlog's table, so the two can be read
side by side.

**What this method still cannot do.** It sees a test that failed and passed on retry. It cannot
see a test that would have failed had the runner been half a millisecond slower, and it cannot
separate a 2% mechanism from a 20% mechanism that only arms itself under a condition CI meets
one time in ten. Only more runs, or the artifact this workflow currently discards, will do
that.
