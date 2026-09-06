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

### The fix, as built — `@conduit/shared`'s `EXPORT_MEMBERS`

**IT WAS TEN PLACES, NOT FOUR.** The note above counts four hand-written lists plus one weak
assertion, which is what Task 1 found from the product side. Counted properly while building
the fix, the same ten member names were typed out in **ten** places — three in the product
(`services/export.ts`, `services/import-export.ts`, `settings-data.tsx`) and seven in the
tests (`e2e/data.spec.ts`, `routes/import.test.ts`'s count, `routes/export.test.ts`'s readdir
list, `services/import-export.test.ts`'s ordered skip list, and **three in
`services/export.test.ts`** — the member list, the manifest member count, and the thirteen-entry
`EXPORTED` map that Task 1 had just added as the guard). The guard was itself a copy. All
seven test copies fail loudly when they go stale — the one that did not,
`toBeGreaterThanOrEqual(7)`, Task 1 had already tightened — so they were nuisances rather than
hazards. The silent one was the product's third: the Settings sentence.

**One list; ten entries; four fields each** — the member's path in the archive, the schema
tables it carries (`documents.csv` carries four), the noun the operator reads, and whether the
exact importer reads it back. The last is a **union**, not a flag beside an optional reason:
`{ imported: true } | { imported: false, notImported: string }`, so an unimported member
cannot exist without the sentence the preview shows, and an imported one cannot carry prose
nobody will ever see.

**What now derives, and what each one is compared against.** The point is that not one of
them is compared against another copy of the list:

| place | before | now |
|---|---|---|
| `services/export.ts` | an array of ten thunks | `Record<ExportMemberName, builder>` — **a member with no builder does not compile** |
| `services/import-export.ts` | `NOT_IMPORTED`, eight hand-written entries | `NOT_IMPORTED_MEMBERS`, derived |
| `settings-data.tsx` | a typed sentence, **untested** | renders `EXPORT_ARCHIVE_SUMMARY`, composed from the nouns |
| `e2e/data.spec.ts` | eight member names typed out | the declaration, walked against the real preview |
| `routes/import.test.ts` | `toBe(8)` | `toBe(NOT_IMPORTED_MEMBERS.length)` |
| `services/export.test.ts` | a members list, a count, and a 13-entry `EXPORTED` map | all three derived; the map is `MEMBER_BY_TABLE` |
| `routes/export.test.ts` | a sorted readdir list | the declaration plus `files/` and the manifest |

**THE COMPILER HOLDS THE FIRST ONE, WHICH IS A DIFFERENT KIND OF GUARANTEE FROM A TEST.**
`EXPORT_MEMBERS` is `as const satisfies`, so the member names survive as literal types; adding
an entry with no builder in `services/export.ts` is `TS2741: Property '"invoices.csv"' is
missing`. Nothing has to run, and nobody has to remember.

**AND DELETION IS HELD FROM THE OTHER END.** Deriving everything from one list creates an
obvious new failure: remove a member and every reader stops expecting it, in unison. What does
not stop is `describe("export coverage")`, because what IT compares the list against is the
database's own catalogue — the orphaned table is then carried by no member and declared
unexported by nobody, and it fails by name. Adding a table and deleting a member are both
caught, at opposite ends of the same list.

**THE OPERATOR'S SENTENCE, WHICH IS THE ONE THAT MATTERED.** It is now
`EXPORT_ARCHIVE_SUMMARY` in `settings-data-lib.ts` — the whole paragraph, not a list
interpolated into prose that could still describe the archive wrongly. `settings-data.tsx`
renders it and nothing else, and two tests hold that: one checks the sentence names every
member in archive order, and one **reads `settings-data.tsx` off disk** and fails if the card
contains `EXPORT_MEMBERS`' nouns as literal text. That second test is unusual and is the only
thing that can catch the mutation Task 1 recorded as surviving the entire suite; it was
watched failing against the page's own pre-v1.9.0 paragraph before the page was changed. e2e
asserts the rendered card names every member, so a page that stopped rendering the derived
sentence is red in CI as well.

**`files.csv` GAINED A NOUN, WHICH CHANGES THE SENTENCE AN OPERATOR READS.** The old copy
listed nine record types and then said "plus every file you have uploaded" — so the archive's
TENTH sheet, the index that says which company each stored file belongs to, was not mentioned
at all. Every member now contributes a noun, because a member that contributes none is
invisible again by construction.

**NO EXPORT BYTES CHANGED.** `EXPORT_FORMAT_VERSION` stays at 1; no member was added, removed
or renamed; the order is the old build list's order. `Sheet` lost its `name` field — the
member it is written as is now the key it was fetched under, so a sheet cannot disagree with
its own filename — and no `*Sheet` body changed otherwise (the diff is ten deleted
`name: "….csv",` lines and nothing else inside those functions).

**MEASURED RATHER THAN ARGUED.** A scratch probe built an export over an empty database with a
fixed `now` and appVersion, at this commit and with `services/export.ts` swapped back to its
pre-change version, and printed the manifest and every sheet's header row. The two are
identical: same ten members, same order, same byte counts, same SHA-256s, `formatVersion` 1.

```
companies.csv 120 3a045de174836489   notes.csv        145 42fe6d83beec5530
contacts.csv  166 32c8e49ba48d85c7   meetings.csv     217 ff1260ea43793f7c
deals.csv     234 97ebf2b2499e7448   time_entries.csv 219 da52526bc6732fab
projects.csv  151 15556aee35f3d206   documents.csv    642 1ff2537be7a0321c
tasks.csv     258 7c84fea6fc0fe4c0   files.csv        219 68f0693ccf2c9d70
```

An empty database is what makes the comparison exact — every row this export writes carries a
generated uuid and a wall-clock timestamp, so a seeded one could only ever be compared
loosely. What it holds is the members, their order, and every header; what it cannot see is
row rendering, which no line of this change touches.

### Mutation evidence

**Twelve mutations, run one at a time against the isolated remote, with the vitest exit status
captured BEFORE anything was piped anywhere** — Phase 9's harness lost one to a `| tail` and
recorded a survivor as a kill. The mutator refuses to edit unless its search string occurs
exactly once in the target file, so a mutation that applied to nothing is an error here rather
than a green result. Watched failing AND watched passing: the control below was run first.

| mutation | answered by |
|---|---|
| **the operator's sentence typed out again in the page, derivation dropped** | `settings-data-lib.test.ts` — "expected … to contain `{EXPORT_ARCHIVE_SUMMARY}`". **This is the mutation Task 1 recorded as surviving the entire suite.** |
| the sentence typed out again BESIDE the derived one | the same test's noun scan, by name: `"companies" is typed into the export card` |
| `exportMemberNouns` drops the last noun | the shared test and the summary test, both naming `documents.csv` |
| **a member added to the list with no builder** | `tsc` (exit 2): `TS2741: Property '"invoices.csv"' is missing … but required in type 'Record<…>'`. Nothing had to run. |
| **a member deleted from the list, builder and all** | `describe("export coverage")`: `expected [ 'time_entries' ] to deeply equal []`. `tsc` is silent here, which is exactly why the catalogue guard is load-bearing. |
| a member claiming a table the database has not got | the same guard, naming `files` |
| the archive written in the wrong order | "contains every entity sheet and a manifest" — the manifest's member order |
| the importer drops one of its "not imported" notes | `routes/import.test.ts` (`expected 7 to be 8`) and `services/import-export.test.ts` (the ordered list) |
| **a member declared `imported: true` that the importer never opens** | `applyImport`'s `opened`, compared against `importedMembers()` |
| **a member the importer DOES read, declared `imported: false`** | `tsc` (exit 2): `Type '"contacts.csv"' is not assignable to type '"companies.csv"'` |
| a comment-only change (**the control**) | green, watched first, so a red result afterwards means something |

**WHAT CANNOT FAIL, AND SHOULD NOT.** Adding a member to the list and writing its builder
makes no test go red — the import preview's note, the Settings sentence, the archive's member
list, the coverage map and the e2e journey all follow it. That is the deliverable, not a gap:
the guards fire on *inconsistency*, and after this change there is nothing left to be
inconsistent with.

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

- [x] **`meetings.duration_minutes` already holds tracked time** and has never been aggregated.
      The timesheet reads meetings and entries together.
- [x] **A time entry naming a meeting is refused BY THE DATABASE.** Chris's decision, and the
      backlog's requirement in as many words: the other possibility must be **impossible rather
      than discouraged**. A CHECK, not a convention.
- [x] **READ THIS BEFORE ADDING A COLUMN TO FORBID.** Task 1 shipped `time_entries` with **no
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
- [x] **A meeting with no duration contributes nothing, and that must be visible.** A report that
      silently treats "unknown length" as zero is the same failure in a smaller costume.

### Task 2 as built — `services/timesheet.ts`, and no migration at all

**NO COLUMN WAS ADDED AND NO CHECK WAS WRITTEN.** Task 1's warning was followed: the
refusal that already stands is the strongest available, and a `meeting_id` column added
so a constraint could name it would have made the impossible merely illegal. The
`db/schema.test.ts` case that pins 42703 is unchanged apart from its comment, which now
records the decision instead of anticipating it. **This task ships no migration** —
`drizzle/` is untouched, so there is no journal entry, no snapshot and no stamper run.

**THE READING LAYER IS A THIRD MODULE.** `timesheetTotals(db, {from, to}, now)` reads
`time_entries` and `meetings` and belongs to neither, so it is `services/timesheet.ts`
rather than a function in either file. `GET /api/timesheet?from=&to=` is its one caller;
Task 4's page renders what it answers and computes none of it. The "NO SUM FUNCTION HERE"
note Task 1 left at the foot of `services/time-entries.ts` is now a pointer here.

**SUMMED IN SQL, COALESCED, AND CAST.** Two aggregates, no GROUP BY, no join. A test logs
**101 entries in one week and asks the list for five hundred** — the list still returns
100, so there is no page size at which a JavaScript sum is right. `::int` on every
aggregate is load-bearing rather than cosmetic: `SUM`/`COUNT` over an `integer` are
`bigint`, which postgres.js hands back as a **string**, and `sql<number>` is a claim
TypeScript takes on trust — uncast, `entryMinutes + meetingMinutes` is `"120" + "45"` =
`"12045"`. The test asserts the runtime type of every numeric field.

### What the operator sees for a meeting with no duration

**A NUMBER IN THE ANSWER, INSIDE THE SAME SENTENCE AS THE TOTAL.** The payload carries
`meetingsUnmeasured` and `timesheetSummary` (in `@conduit/shared`) renders:

> `7h 30m counted from 2026-09-07 to 2026-09-13: 5h across 4 entries, and 2h 30m across 3
> meetings. Not counted: 2 meetings with no recorded length, and 1 meeting that has not
> happened yet.`

**ONE STRING, BECAUSE A PAGE CANNOT DROP A CLAUSE IT NEVER HAD.** A count sitting beside a
total in a payload is visible only to a UI that chooses to render it, which is the same
silence in a different place. This is `EXPORT_ARCHIVE_SUMMARY`'s arrangement and its
reason. The headline field is called **`countedMinutes`, never `totalMinutes`**, so a page
that prints it alone and labels it the week's total reads as a lie in its own source.
**Task 4 renders this sentence.**

### THREE THINGS THE SPEC AND THE PLAN ARE WRONG OR SILENT ABOUT

**1. THE SPEC AND PLAN NEVER ASK WHICH CALENDAR DAY A MEETING FELL ON, AND THE TIMESHEET
CANNOT BE BUILT WITHOUT AN ANSWER.** `time_entries.work_date` is a `date` and
`meetings.occurred_at` is a `timestamptz`. `2026-09-06T23:30Z` is Sunday in UTC and Monday
in Amsterdam — not a different day but a different **week**. The answer taken here is the
organisation's clock (`org_profile.time_zone`, 0018), because that field exists for exactly
this class of question and already decides what day a document is dated; UTC would
reintroduce the bug 0018 was built to remove, in the one report where an hour out moves an
hour between weeks. `zonedDayRange` in `@conduit/shared` converts the closed day range into
a **half-open instant range**, and the closed form is deliberately unspellable there: an
upper bound of the last day's own start drops that day, and "start plus 86,399,999ms" is an
hour wrong on both of Amsterdam's 23- and 25-hour days.

**2. THE SPEC'S PREMISE THAT "A LOGGED MEETING WITH A DURATION IS A RECORDED HOUR" IS FALSE
FOR HALF THE TABLE, AND NOTHING SAYS WHICH HALF.** Phase 5 decided `occurred_at` is free in
both directions because "noting a meeting you have just had and one you have just arranged
are the same act", and **no column distinguishes them**. So the current week contains
Friday's arranged meetings on Wednesday morning, and counting them answers "where did the
week go" with work nobody has done. A third bucket, `meetingsNotYetOccurred`, reports them
and does not count them — the same treatment an unmeasured meeting gets, for the same
reason: an hour excluded in silence is this task's own failure mode, whether it is excluded
for being unknown or for being in the future. **This is not in the spec. If Chris wants
arranged meetings counted, it is one filter to change.**

**3. THE STATED REASON FOR LEAVING `meetings.duration_minutes` UNBOUNDED HAS JUST EXPIRED,
AND THE EXPOSURE IT LEAVES IS REAL.** `db/schema.ts` and `MAX_TIME_ENTRY_MINUTES` both
argued that `time_entries.minutes` gets a CHECK and that column does not because **"nothing
sums a meeting's duration"**. This task makes that false. Both comments are corrected in
place. **No CHECK was added and that is argued rather than deferred**: `minutes <= 1440`
follows from `work_date` being one day, while `occurred_at` is a *start* and an offsite
logged as one meeting can honestly run longer than a day — so the same bound there would
refuse a true row, and would still not catch the mistype that happens (60 typed as 600
passes any bound). **What IS exposed: `meetingSchema.durationMinutes` is
`z.number().int().positive()` with NO upper bound**, so one meeting can carry 999,999,999
minutes and now dominate a week's total. Adding a `.max()` would make the CLIENT refuse to
parse any meeting already carrying such a value, turning a silly figure into a broken page,
so it is written down here rather than changed in passing. **A decision for Chris.**

### How double-counting is made impossible, and the indirect route that was open

The direct route is unspellable and stays that way. Every indirect one was enumerated and
tested:

| route | what closes it |
|---|---|
| a time entry naming a meeting | no `meeting_id` column: 42703, not a constraint (Task 1, pinned) |
| **a JOIN that fans a meeting out over its attendees** | the aggregate has NO join; a mutation adding `leftJoin(meetingAttendees)` is killed by "counts a meeting once however many attendees it had" |
| a meeting summed once per linked record | same: the aggregate is over `meetings` alone |
| a meeting in two of the three buckets | the three are `FILTER` clauses over one population from one predicate, and `timesheetTotalsSchema` refuses a payload where they do not add up to `COUNT(*)` |
| **a boundary meeting counted in two consecutive weeks** | **THIS ONE WAS OPEN.** `occurred_at <= endExclusive` survived every test in the file — a meeting at 00:30 local cannot tell `<` from `<=`. Closed by a test that puts a meeting on the **stroke of midnight** at each end and asserts the three weeks around it sum to two meetings |
| an archived meeting still contributing | `archived_at IS NULL` on both sides — and on the meeting side that is **part of the rule, not tidiness**: the correction for a wrongly-recorded meeting length is to archive it and log the hour by hand, so an archived meeting that still counted would BE the double count |

An hour booked against a follow-up task the meeting produced is **not** a double count and
is tested as a reading rather than left for somebody to "fix": a follow-up task is different
work. That `events.meeting_id` link is the only real join between the two halves.

### The index that was measured and not built

`meetings` carries no index on `occurred_at` at all — 0008 built none and `listMeetings` has
sorted the whole table since Phase 5. Measured on the dev server against a database built by
the real migrations, EXPLAIN (ANALYZE, BUFFERS) on this week's aggregate, without and then
with a partial index on `(occurred_at) WHERE archived_at IS NULL`:

```
  5,000 rows,  13 in the week:   0.462ms /    81 buffers  ->  0.043ms /  3, index 120kB / 648kB heap
200,000 rows, 493 in the week:   19.2ms  / 3,226 buffers  ->  0.187ms / 15, index 3.9MB / 25MB heap
```

Five thousand meetings is a decade of heavy single-operator use and the difference there is
four tenths of a millisecond. **Not built** (0017/0019/0020's rule); the 200k figure is
recorded so Task 4 can add it alongside the five `time_entries` record indexes if its
filters change the query's shape.

### Mutation evidence

**Thirty-three mutations plus a control. Thirty-one killed on the first run, TWO SURVIVED
AND ARE NOW CLOSED, two were refused by the harness before they could lie, and one was a
bad instrument caught and re-run.** The harness reads vitest's exit status from
`spawnSync`'s `status` **before any output is piped anywhere** (Phase 9 lost a result to a
`| tail`) and refuses to edit unless its search string occurs exactly once.

**THE CONTROL RAN FIRST AND WAS WATCHED GREEN**, so a red result afterwards means something.

| mutation | answered by |
|---|---|
| the range's upper bound is the last day itself; `nextDay` does not advance; the boundary search compares `>` not `>=`; the bracket narrows to 12h | `zonedDayRange`'s own tests, including the exhaustive one over all 419 zones |
| the zone is used unresolved, with no UTC fallback | "falls back to UTC when the stored zone no longer resolves" |
| an inverted range is answered instead of refused | the shared test and the service's |
| **the calendar round trip is dropped, so `2026-13-01` is a day** | **SURVIVOR.** `toThrow()` with no pattern was green because `"2026-13-01"` sorts after the `to` bound and the BACKWARDS check threw instead — a test certifying whichever refusal it happened to get. Now `toThrow(/calendar day/)`, with `2026-02-30` and `0026-09-07` added |
| the total need not be its own halves; the buckets need not account for the range | `timesheetTotalsSchema`'s refines |
| **the sentence drops its uncounted clause**; names not-yet-happened only above one; always uses the plural | `timesheetSummary`'s tests, the service's, and the route's |
| `formatMinutes` rounds instead of flooring | the shared tests |
| `durationLabel` loses its null branch, so an untimed meeting reads "0m" | `meetings-lib.test.ts` — the two contracts really do differ at zero |
| archived entries / archived meetings still summed | "drops an archived meeting and an archived entry out of every bucket" |
| the entries sum is not COALESCEd | "answers an empty range with nought, not with nothing" |
| **the `::int` cast dropped, so the driver returns bigint strings** | 8 tests, including `entryMinutes + meetingMinutes` coming back as `"12045"` |
| the last day of the entry range is excluded; the meeting range's lower bound made exclusive | the inclusive-bounds tests |
| **the meeting range's upper bound made inclusive** | **SURVIVOR.** Closed by the stroke-of-midnight test above |
| a meeting starting exactly now counted as future; the not-yet filter inverted; `unmeasured` stops requiring the meeting to have started; the counted predicate forgets its null test | the bucket tests |
| the organisation's clock ignored and UTC assumed | the three timezone tests |
| the total forgets the meetings; `entryCount` answers minutes; `meetingsInRange` derived in JS from two buckets | the totals tests and the schema's refine |
| **the aggregate gains `leftJoin(meetingAttendees)`** | "counts a meeting once however many attendees it had" |
| the route accepts a backwards range; makes both bounds optional; is never registered | the route tests |
| a comment-only change (**the control**) | green, watched first |

**TWO REFUSED BEFORE THEY COULD LIE.** `const zone = usableTimeZone(timeZone);` occurs
twice in `time-zone.ts` (the other is in `timeZoneLabel`), and the first control's search
string occurred zero times. Both were errors here rather than results.

**ONE BAD INSTRUMENT.** Swapping `gte` for `gt` in the meetings range "killed" 20 tests on
its first run — because `gt` was not imported, so it was a ReferenceError rather than a
wrong answer. Re-run with the import added, it is killed by one test, which is the honest
figure.

**AND ONE MORE INSTRUMENT FAILED IN THE OPPOSITE DIRECTION, BEFORE ANY MUTATION RAN.** The
exhaustive zone test took **19.7s against a 20s `testTimeout`** on the dev server and
0.109s on a laptop, because the first `zonedDayStart` built an `Intl.DateTimeFormat` inside
its search loop. A green run one scheduling hiccup from a flake, invisible to the machine it
was written on. Hoisting the formatter took it to 1.6s — and, incidentally, made
`todayInZone` an independent oracle in that test rather than a restatement of the
implementation.

## Task 3: `tasks` gets an estimate, and booked-versus-estimated exists

- [ ] `tasks` carries **no effort or estimate column** — only `start_date`, `due_date`,
      `completed_at`, `status`, `progress_pct`. Dates and a percentage, never a quantity of work.
- [ ] **This changes a shipped surface.** The board, the Gantt and the task drawer all render
      tasks today. **If adding an estimate ripples further than expected, report it.**

## Task 4: The timesheet

### What Task 2 built for this task, and the three rules that come with it

- [ ] **THE SUM IS ALREADY WRITTEN.** `GET /api/timesheet?from=&to=` →
      `services/timesheet.ts`'s `timesheetTotals`. It is summed in SQL, COALESCEd and cast;
      **do not compute a total on the page.** The bullet below is answered, not pending.
- [ ] **RENDER `timesheetSummary`, NOT `countedMinutes`.** The uncounted meetings — the ones
      with no recorded length and the ones that have not happened yet — are in the same string
      as the figure precisely so a page cannot print the figure without them. A page that
      renders `countedMinutes` and calls it the week's total is the failure the spec names,
      and the field is named `countedMinutes` so that page reads as a lie in its own source.
      **Nothing tests a page that does not exist yet: this bullet is the guard.** If the design
      wants the numbers laid out rather than a sentence, the uncounted ones are not optional
      furniture — see `settings-data-lib.test.ts` for the shape of a test that reads a page off
      disk and fails if it typed out what it should have derived.
- [ ] **IF YOU ADD A CONTACT FILTER, USE AN EXISTS AND NOT A JOIN.** `listMeetings` widens its
      contact filter to attendance, and as a JOIN to `meeting_attendees` a meeting with three
      attendees is summed three times. The aggregate deliberately has no join; a mutation
      adding one is killed by a test, and that test is why it is worth reading before editing
      the query.
- [ ] The record filters and the billable split are still this task's, and the five record
      indexes with them. `meetings(occurred_at)` was measured and not built — see Task 2's
      figures; if your filters change the query's shape, that index joins yours.

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
