# Conduit Phase 10 → v1.9.0 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-06-conduit-phase-10-time-tracking-design.md`, approved
by Chris 6 Sep. Read it first.

**Baseline:** v1.8.0, shipped 6 Sep. `main` at `00dc105`.

**Order:** the table and the hand entry first, because everything reports over them. Meetings
next, because that is where double-counting is made impossible and it must be settled before
anything sums. The timer last — it is the phase's real risk and it should meet a working
timesheet rather than be built beside one.

---

## Task 1: The table, hand entry, and the export sheet

- [x] **`time_entries`**: a duration, a date, an owner, a billable flag, and the link set.
- [x] **Link rule: AT LEAST ONE of five** — task, deal, project, company, contact. Not
      exactly-one: an hour can belong to a project *and* the deal it came from. Not
      any-including-none: **unattached time appears in no report and can be found only by SQL**,
      which makes the week's total quietly wrong in the direction nobody checks.
- [x] **Phase 9 established the pattern for a five-way link set with a per-type CHECK** —
      `documents_entity_matches_type` in `0020`. Read it before inventing one.
- [x] **THE EXPORT SHEET SHIPS IN THIS TASK, not later.** `services/export.ts` has one
      hand-written `*Sheet` per entity and **does not walk the schema**. The backup is a
      `pg_dump` and gets the table for free; the readable half does not. **Phase 9's export was
      missed by three tasks running** — this is the whole reason the obligation is written here.
- [x] Billable is a **flag**. No rate — invoicing is out of Conduit, and a rate without a rate
      card is a number somebody retypes forever.

### Task 1 as built — migration 0021, `time_entries`

**Fourteen columns.** `id`, `work_date`, `minutes`, `description`, `billable`,
`owner_user_id`, the five record links, `archived_at`, `created_at`, `updated_at`. Two
CHECKs (`time_entries_has_link`, `time_entries_minutes_range`), six foreign keys, one
index. The migration moves no rows and alters no existing table, so it is the cheapest
kind there is.

**THREE COLUMNS ARE NOT IN THE SPEC'S LIST**, which names "a duration, a date, an owner,
a billable flag, and the link set". Each is argued at the column in `db/schema.ts`:

- `description` — the phase's definition of done is a timesheet that answers *where did
  the week go*, and five hours against a project with no words is a number, not an
  answer. Adding it later is a migration over live rows that all lack it.
- `archived_at` — **the only way an hour can leave a total.** Conduit never deletes, and
  an entry cannot be corrected to nothing either, because `minutes > 0`. Without it the
  duplicated afternoon that Risk 2 predicts would sit in the week for ever.
- `minutes` is bounded `> 0 AND <= 1440` in the database as well as on the wire, unlike
  `meetings.duration_minutes` whose bound is deliberately zod-only. The difference is
  what the column is for: nothing sums a meeting's duration, and these minutes **are**
  the week's total.

**`billable` HAS NO DEFAULT AND IS REQUIRED ON CREATE.** `documents.frozen`'s arrangement
and its reason: both values are ordinary, so any default is a guess made silently on the
row where it is hardest to notice — and the guess that reads worst (non-billable)
under-reports chargeable time in a product with no invoicing step to contradict it.

**`work_date` IS A `date`, NOT A TIMESTAMP.** A timesheet asks which *day* an hour belongs
to, and a `timestamptz` cannot answer that without also answering "in whose time zone",
which for a hand-typed row has no true answer. Storing an instant would make
`org_profile.time_zone` load-bearing on every read, so the same stored row would move
between weeks when somebody changed a setting.

### The link CHECK, and what the plan pointed at

```sql
CONSTRAINT "time_entries_has_link"
  CHECK (num_nonnulls(company_id, contact_id, deal_id, project_id, task_id) >= 1)
```

**`documents_entity_matches_type` was read first, as instructed, and only half of it
transfers.** The `num_nonnulls` COUNT spelling does — it is how all four of these rules are
written in this schema (`= 1` on notes/files/documents, `>= 1` on meetings) and this is that
family at a fifth column. The PER-TYPE half does not and cannot: 0020's constraint answers
"which record does a document of *this type* belong to" and needs `documents.type` to ask
it. **A time entry has no type and needs none** — an hour is an hour — so a CHECK of that
shape here would have had to invent a discriminator to hang itself on, which is 0016's
mistake in the other direction. **The five columns are not even the same five**: documents'
fifth is `meeting_id`; this table's is `task_id`.

### The export sheet

`time_entries.csv`, twenty columns:

```
id, work_date, minutes, billable, description,
owner_user_id, owner_username,
company_id, company_name, contact_id, contact_name,
deal_id, deal_title, project_id, project_name, task_id, task_title,
archived_at, created_at, updated_at
```

Every column of the table, plus a readable name beside each of the six ids. All five record
joins are LEFT — an INNER JOIN anywhere would drop most of the sheet, since at-least-one
means four of the five are null on an ordinary row, which is Phase 9's first miss exactly.
Ordered by the day the work was done. No `hours` column: minutes are already readable, and a
second stored representation of one number is how a CSV starts disagreeing with itself.

**`EXPORT_FORMAT_VERSION` STAYS AT 1.** A new member is additive in the way a new column is —
every existing reader finds every member it knew about — and bumping it would make a v1.9.0
export unreadable by a v1.8.0 install for no benefit, since nothing branches on the
difference.

### Two guards the export half did not have

- **`time_entries.csv`'s columns are checked against `information_schema`**, not against a
  list written in the test. Task 5 adds timer columns to this table, so the next chance to
  repeat Phase 9's third miss is one task away.
- **Every table in the schema is now either exported or declared unexported with a reason**
  (`describe("export coverage")` in `services/export.test.ts`). This is the guard for the
  failure the plan opens with. Nineteen tables carry a one-line reason; a table in neither
  map fails the test by name. It is not a claim that the absences are right — several are
  known formatVersion-1 gaps — only that each was decided rather than forgotten.

### Mutation evidence

**71 mutations. 67 killed, one refused by the harness before it could lie, and two green by
design.** One survivor was real and is now closed.

| mutation | caught by |
|---|---|
| `time_entries_has_link` removed / `>= 0` / `= 1` | the CHECK test, the service's create tests |
| the CHECK forgets `task_id` / `company_id` / `contact_id` / `deal_id` / `project_id` | "accepts an entry attached to each one of the five on its own" (one loop, five named failures) |
| `time_entries_minutes_range` removed, `> 0` → `>= 0`, `1440` → `1441`, `1440` → `1439` | the exact-edges test |
| `billable` gains a `DEFAULT false` | "gives billable no default" (the catalogue read, not the INSERT) |
| `work_date` becomes a `timestamptz` | the data_type assertion, and the export sheet |
| the work-date index is never created | the 0021 drill |
| the `task_id` / `owner_user_id` foreign key is never added | "enforces every foreign key" |
| **0021's journal `when` put back to what drizzle-kit generated** | the strictly-increasing journal test |
| the predicate becomes `.every` / forgets `taskId` / uses `!== null` | the 32-subset truth table, both sides of it |
| the create refine removed; `billable` made optional; the bound removed, widened, or made fractional; `workDate` loosened to a string; `description` admits `""` | the shared schema tests, and the route's 400s |
| **the PATCH shape gains the at-least-one refine it must not have** | "patches an entry, and 409s the patch that would leave it linked to nothing" |
| the service drops its re-assertion / its existence checks / the task existence check | the service's create tests, the route's 404 |
| the service hardcodes `billable: false` | 3 files |
| `normaliseDescription` stops trimming / stores `""` | "stores an omitted description as null, and a blank one as null too" |
| **updateTimeEntry checks the patch instead of the merged row** | the merged-row test |
| the empty-patch no-op removed; a `billable` or `workDate` patch dropped | the update tests |
| the list orders by `created_at`; loses its id tiebreaker; `from`/`to` made exclusive; `archived` inverted | the list tests, and the export sheet's ordering test |
| archive publishes on the no-op branch; unarchive sets the date instead of clearing it | the SSE test, the archive round trip |
| `toTimeEntry` turns the day into an instant | the service and route tests |
| the cursor is minted under the `createdAt` key | the paging test |
| **the sheet is never added to the archive** | the member list, the manifest count, the coverage map |
| the task join becomes INNER; the task title, billable or minutes cell blanked; the sheet ordered by `created_at`; archived rows filtered out | the export-time-entries tests |
| **the header drops `task_id`, or drops `billable`** | **the `information_schema` column-coverage guard** |
| the importer's NOT_IMPORTED entry removed | "names every sheet it does not import" |
| the coverage map forgets `time_entries` | "gives every table either a sheet or a declared reason" |
| the routes are never registered; the wrong cursor family validated; `archived` coerced; 201 → 200 | the route tests |

**THE ONE REAL SURVIVOR, AND IT WAS A GAP.** Deleting `isNull(timeEntries.archivedAt)` from
`updateTimeEntry`'s UPDATE was **green** across every test in the file. The early
`existing.archivedAt !== null` check catches everything a single-threaded test can produce,
so the WHERE clause that exists for the RACE was decoration. It is now held by a test that
makes the interleave deterministic — a `db` proxy whose first completed read archives the
row before the caller sees it — rather than by two `Promise.all`d calls that would be green
on the runs where the ordering happened to land. **The identical guard on `updateCompany`
and `updateMeeting` still has no test**, which is where the shape was copied from.

**TWO GREEN BY DESIGN.** A comment-only change, run first so the harness could be watched
reporting GREEN before any result was believed; and the Settings sentence reverted to its
nine-sheet list, which **nothing anywhere catches** — see the finding below.

**ONE MUTATION THE HARNESS REFUSED.** `].some((x) => x != null);` occurs twice in
`shared/index.ts` (the other is `meetingAtLeastOneLink`), and the harness asserts an exact
occurrence count before it edits. A mutation applied to the wrong function and then
surviving would have been recorded as a gap in these tests. Re-run against the full line, it
was killed. **Two more were bad instruments and were re-run corrected**: one left a dangling
comma in the `CREATE TABLE` so the migration would not parse (killed in 1.8s, which is far
too fast to be a test failure), and one was an equivalent mutant — `new Date("2026-09-01")`
is UTC-parsed by the ES spec, so `.toISOString().slice(0, 10)` returns what it was given in
every time zone.

### A new sheet has to be added to FOUR hand-written lists, not one

The plan names one — `services/export.ts`'s `*Sheet` functions. There are four, and nothing
derives any of them from any other:

1. `services/export.ts` — the sheet itself and the build list. *(the plan's one)*
2. `services/import-export.ts`'s `NOT_IMPORTED` — without an entry, the import preview says
   nothing at all about the new sheet: neither imported nor explained. **Its test caught
   this**, which is how it was found.
3. `packages/web/src/pages/settings-data.tsx` — the sentence that tells the operator what is
   in the archive. **Nothing tests it.** It read "companies, contacts, deals, projects,
   tasks, notes, meetings and documents" and would have gone on saying so, so an operator
   would not have known their timesheet was in the file. Reverting the fix is a mutation
   that survives the whole suite.
4. `e2e/data.spec.ts` — the preview's sheet-by-sheet assertions.

`routes/import.test.ts` had a fifth, weaker copy: `expect(skipped.length)
.toBeGreaterThanOrEqual(7)`, which is green for a new sheet with no `NOT_IMPORTED` entry
because the seven that already had one still clear the bar. Tightened to an exact count.

**The fix is one shared list of members that all four read**, and it is a real change to a
shipped format rather than a tidy-up, so it is written down here rather than done in passing.

### The journal trap: sixth time, and it cost nothing

`drizzle-kit generate` stamped 0021's `when` as **1788718705895** (2026-09-06T18:18Z, the
wall clock), which falls between 0014's `1788700000000` and 0015's `1788800000000` — so on
every install already past 0015, drizzle would have skipped this migration in silence.
**Phase 9's last task fixed it by construction**: `npm run db:generate` ran
`db/journal-stamp.ts`, which restamped to `1789300000001` and said so on stdout. The fix
worked on the first migration written after it. `schema.test.ts`'s strictly-increasing
check still stands as the net for `npx drizzle-kit generate` run directly, and a mutation
putting the raw value back is killed by it.

## Task 2: Meetings count, and the same hour cannot be counted twice

- [ ] **`meetings.duration_minutes` already holds tracked time** and has never been aggregated.
      The timesheet reads meetings and entries together.
- [ ] **A time entry naming a meeting is refused BY THE DATABASE.** Chris's decision, and the
      backlog's requirement in as many words: the other possibility must be **impossible rather
      than discouraged**. A CHECK, not a convention.
- [ ] **READ THIS BEFORE ADDING A COLUMN TO FORBID.** Task 1 shipped `time_entries` with **no
      `meeting_id` column at all**, so the refusal already exists and is stronger than a CHECK:
      an INSERT naming one does not violate a constraint, it fails to resolve against the table
      (42703, `undefined_column`) — a refusal that cannot be got around by dropping a
      constraint. `db/schema.test.ts` pins it, and pins that the same INSERT without that
      column succeeds, so the failure is the column and not the row.
      **Adding the column purely so a CHECK can name it in an error message would trade
      impossible for illegal**, which is the opposite of what the spec asks for. If Task 2
      wants a nameable refusal for the API's sake, that belongs in the service and the wire
      schema, where a 400 can say something useful — not in a column the database would then
      have to be told to hate.
- [ ] **A meeting with no duration contributes nothing, and that must be visible.** A report that
      silently treats "unknown length" as zero is the same failure in a smaller costume.

## Task 3: `tasks` gets an estimate, and booked-versus-estimated exists

- [ ] `tasks` carries **no effort or estimate column** — only `start_date`, `due_date`,
      `completed_at`, `status`, `progress_pct`. Dates and a percentage, never a quantity of work.
- [ ] **This changes a shipped surface.** The board, the Gantt and the task drawer all render
      tasks today. **If adding an estimate ripples further than expected, report it.**

## Task 4: The timesheet

- [ ] **A list, not a weekly grid.** The grid is the classic and is the hardest thing in this
      product to operate on a phone, which is where Chris is. No approval workflow — single user.
- [ ] It answers "where did the week go", summing entries and meetings without double-counting.
- [ ] **SUM IN SQL, NOT OVER A PAGE.** `listTimeEntries` caps at 100 rows, so a JavaScript sum
      over `items` is correct until somebody logs 101 entries in a week and is then silently
      SHORT — this phase's own failure mode, arriving through the one number the phase exists to
      produce. `COALESCE` it too: `SUM` over no rows is NULL and an empty week is 0 hours, not an
      absent one. Task 1 wrote and then deleted such a function rather than ship one with no
      reader; the argument is left at the foot of `services/time-entries.ts`.
- [ ] **The five record foreign keys on `time_entries` are deliberately unindexed** (0021 builds
      only `(work_date DESC, id DESC)`, for the list's own ordering and cursor). Task 4 is the
      first task with readers for them; build them then, with a measurement.
- [ ] **A `billable` filter and an `ownerUserId` filter are deliberately absent** from
      `timeEntryListFiltersSchema` for the same reason. The billable split is this task's.

## Task 5: The timer — LAST, AND THE RISK IS NOT THE TIMING

- [ ] **`minutes <= 1440` MEANS THE 62-HOUR WEEKEND CANNOT BE STORED.** The bound is one day
      because `work_date` is one day. So a timer that stops after a weekend has no "save the
      elapsed time and move on" branch available to it — the recovery interaction has to produce
      a real answer. That is the spec's own intent made unavoidable rather than merely
      recommended, and it is a constraint on the design rather than a bug to route around.
- [ ] **A timer that produces entries is a DIRECT SERVICE CALLER**, which is why
      `createTimeEntry` re-asserts the at-least-one rule itself rather than trusting the wire
      schema's refine. It also has to supply `billable`: the column has no default.
- [ ] **Timer columns added to `time_entries` must reach `time_entries.csv`.** The
      `information_schema` column-coverage guard in `services/export.test.ts` fails by name if
      they do not — which is precisely the miss Phase 9 made three times.

- [ ] **Running state must survive a restart, a closed tab and a second device.** Conduit is one
      process with no swap; a timer in memory dies with a deploy.
- [ ] **The weekend problem is the common failure, not an edge case.** "You left this running for
      62 hours" — and **the recovery interaction is most of the feature**: what the operator is
      offered, what the default is, what happens if they ignore it.
- [ ] **Two capture paths can double-count each other.** A timer entry and a hand entry for the
      same afternoon are exactly what Task 2 makes impossible for meetings, arriving by a
      different door. **Same treatment: impossible, not discouraged.**
- [ ] **If this turns out to be a phase of its own, say so and stop.** Four tasks shipped and one
      honestly reported beats five half-built — the instruction Phase 9's Task 4 was given, and it
      was right to have it.

---

## Definition of done

- Time bookable against a task, deal, project, company or contact, by timer and by hand.
- **A time entry naming a meeting refused by the database**, and meetings counted.
- `tasks` carries an estimate; booked-versus-estimated exists.
- A timesheet that answers "where did the week go", on a phone.
- **A time-entry sheet in the export, in the release that creates the table.**
- Full unit and e2e green, counts accounted for.

---

## Explicitly NOT in this phase

- **Rates and rate cards.** Billable is a flag; rates touch the products item on the backlog.
- **Invoicing.** Ruled out of Conduit.
- **Approval workflow.** Single user.
- **Microsoft Graph**, still deferred until Conduit wants the calendar.
