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

- [x] `tasks` carries **no effort or estimate column** — only `start_date`, `due_date`,
      `completed_at`, `status`, `progress_pct`. Dates and a percentage, never a quantity of work.
- [x] **This changes a shipped surface.** The board, the Gantt and the task drawer all render
      tasks today. **If adding an estimate ripples further than expected, report it.**

### Task 3 as built — migration 0022, `tasks.estimate_minutes`

**ONE NULLABLE COLUMN AND ONE CHECK.** `estimate_minutes integer`, and
`tasks_estimate_range`: `estimate_minutes IS NULL OR (estimate_minutes > 0 AND
estimate_minutes <= 525600)`. The migration alters one table, moves no rows and adds
no default, so a populated install upgrades in one statement pair.

**MINUTES, BECAUSE THE OTHER HALF OF THE COMPARISON IS MINUTES.** `time_entries.minutes`
and `meetings.duration_minutes` are both integer minutes, so an estimate in hours would
put a conversion and a rounding between a number and the number it exists to be read
against. Hours-as-numeric was rejected for the reason `time_entries.csv` has no `hours`
column: `formatMinutes` already renders 90 as "1h 30m", so a second representation buys
nothing at the display end and costs correctness at the comparison end.

**THE BOUND, ARGUED AT BOTH ENDS.**

- **`> 0`.** NULL already spells "nobody has estimated this". A zero would be a second
  spelling of one absence, and the one that reads as a *claim* — an estimate of no work,
  against which the first minute booked is infinitely over. `normaliseDescription`'s rule
  (`""` stored as null) and `time_entries.minutes > 0`'s.
- **`<= 525600`, one year of wall clock, and deliberately NOT 1440.** `MAX_TIME_ENTRY_MINUTES`
  is definitional because `work_date` is one day; a task's dates are a **span**
  (`tasks_dates_paired`, and the Gantt draws a bar across it), so the same bound here would
  refuse true rows in bulk. What a year draws instead is the line between two entities this
  schema already has: **a work item estimated at more than a person-year is a project**, and
  `tasks.project_id` is the column that says so. Wall clock rather than an eight-hour working
  day for `MAX_TIME_ENTRY_MINUTES`' reason — Conduit does not know the operator's working day,
  and the one place the schema would have had to guess (`time_entries.billable`) it refused to.
- **AND A BOUND EXISTS AT ALL BECAUSE THE COLUMN IS EMPTY TODAY.** This is Task 2's finding
  used rather than repeated: `meetingSchema.durationMinutes` takes 999,999,999 and now
  dominates a week's total, and it **cannot** be tightened, because a `.max()` would make the
  client refuse to parse rows that already exist. **A bound is free exactly once, on the day
  the column is created**, and this is that day. In the database *and* on the wire, unlike
  that column.
- **REJECTED, so it is not revisited: bounding the estimate by the task's own
  `start_date..due_date` span.** It is the tempting cross-column CHECK and it is wrong twice.
  A span is elapsed time and an estimate is effort — eight hours of work inside a two-week
  window is the normal case, not an error — and it would make an ordinary reschedule that
  narrows the dates fail against an estimate already stored, leaving a row that cannot be
  patched out of its state one field at a time.

### `taskEffort`, and where it deliberately does not live

`taskEffort(db, taskId)` joins `timesheetTotals` in `services/timesheet.ts` — one table
further along that module's founding reason: it reads `tasks` and `time_entries` and belongs
to neither. `GET /api/tasks/:id/effort` serves it.

**NOT A FIELD ON `taskSchema`, WHICH IS THE RIPPLE THAT WAS MEASURED AND REFUSED.** A board
of forty cards would become forty aggregates over `time_entries` to draw something nobody put
on a card, and the Gantt, My Tasks, search and a meeting's follow-up list would each pay the
same. It is a second endpoint under the same `:id`, exactly as the drawer's dependency list
already is.

**THE BOOKED HALF IS `time_entries` ALONE, AND THAT IS THE SCHEMA'S DOING.** `meetings` has
four record links and `task_id` is not one of them, so no meeting minute can reach a task's
total; `db/schema.test.ts` pins that against the catalogue rather than arguing it. The one
link between the two halves is a meeting's follow-up TASK, and Task 2 settled it — an hour
booked there is different work. Tested as a reading.

### An estimate on a task nobody has started — the question Task 2's third bucket raises

**IT COUNTS, IN FULL, FROM THE MOMENT IT IS TYPED, AND THERE IS NO BUCKET FOR IT.** Nothing
in `taskEffort` or `taskEffortSummary` asks about `status`, `progress_pct`, `start_date` or
`completed_at`. Task 2 excluded meetings that have not happened because the timesheet sums
time that **happened** and an arranged meeting is a plan; **an estimate never claims anything
happened**, so "has it started" is not a question it has to answer. Dropping unstarted tasks
would also make the estimated side *shrink as work went undone*, which is backwards — and a
task estimated at four hours with nothing booked is the most informative row this comparison
produces.

**AND NO ESTIMATE EVER REACHES `countedMinutes`.** `timesheetTotals` does not read `tasks` at
all and must not start: adding estimates into the week's total would answer "where did the
week go" with work nobody has done. A test fails the day somebody does.

**AN ARCHIVED ENTRY IS NOT BOOKED; AN ARCHIVED TASK STILL ANSWERS.** The asymmetry is
deliberate. Archiving is the only way an hour leaves a total anywhere in this phase, so an
archived entry that still counted would break the correction for a mis-booked afternoon on
this reading alone. An archived task, by contrast, is one somebody has opened the drawer to
ask about.

### How far the ripple actually went

| surface | what changed |
|---|---|
| the **board** | **nothing.** The card renders title, type badge, due date and owner; `Task` gained a field it does not read |
| the **Gantt** | **one line**, and the compiler found it: `services/scheduling.ts` has a SECOND hand-written `toTask`, and `ganttPayload`'s `GanttTask[]` annotation makes a missing field `TS2322` rather than a silently thinner payload |
| the **task drawer** | the real surface: an Estimate field and the derived sentence |
| **`services/documents.ts`** | **deliberately not changed.** `StatusReportTask` is a projection for a frozen PDF template; adding a column would change the shape of every future status report without anybody asking |
| **`services/time-entries.ts`** | **the ripple nobody would have predicted** — see below |

**THE SSE HINT IS THE PART THAT WOULD HAVE GONE WRONG QUIETLY.** The booked figure's only
source is a write in `services/time-entries.ts`, and **nothing on a task surface listened to
`["time-entries"]`.** So `publishTimeEntryHint` now also publishes `["task", id]` when the
entry names one — the exact key `publishTaskHint` uses, so TanStack's prefix match reaches
`["task", id, "effort"]` with no key of its own. An UPDATE publishes **both** the pre- and
post-patch task: re-linking an hour changes two totals, and a drawer open on the task it left
is as stale as one open on the task it arrived at. That is `publishTaskHint`'s
`extraAssigneeIds` shape, one table over.

**ONE SENTENCE, NEVER TWO FIGURES SIDE BY SIDE.** `taskEffortSummary` composes the booked
total, the estimate and the gap, because "5h booked" on a task estimated at two hours is a
number that is wrong without looking wrong — `timesheetSummary`'s arrangement and
`EXPORT_ARCHIVE_SUMMARY`'s. `task-effort-render.test.ts` reads the drawer off disk and fails
if it starts spelling any part of the comparison itself, which is
`settings-data-lib.test.ts`'s guard at a smaller card.

### THE PLAN'S OWN CONVENTION NOTE IS WRONG, AND IT WOULD HAVE COST THIS TASK

**"`tasks.csv`'s columns are checked against `information_schema`, so a missing one may fail
by itself" IS FALSE.** Task 1 wrote that guard for **`time_entries` alone**, and the very next
task to add a column added it to `tasks` — where nothing would have noticed. The estimate
could have shipped unexported in silence, which is Phase 9's miss for the fourth time.

Task 1's reasoning was never specific to one table, so the check now covers **every table any
member carries**, read out of `information_schema` and compared against the headers of a real
archive. **What it found on its first run:** seventeen columns are carried under a *different*
header — `deals.value_cents` as `value` in major units, `meetings.notes` as `notes_html`, the
letter's and the agreement's fields under their own prefixes (because `documentsSheet`
refuses to coalesce two tables into one set of columns), and three detail tables'
`document_id`, which *is* `documents.csv`'s own `id`. Two are genuinely absent:
`tasks.position` and `deals.position`. Each is now a stated line. **It matches on names and
asks for a sentence rather than guessing at the mapping**: a guard that stripped `_cents` or
allowed a prefix would excuse a real miss the day a new column looked like one of those shapes.

`tasks.csv` gains `estimate_minutes`, in minutes, so a reader with a spreadsheet can subtract
it from a `SUM` over `time_entries.csv`'s `minutes`. `EXPORT_FORMAT_VERSION` stays at 1.

### The index the plan assigns to Task 4 is wanted a task early, and is still not built

**"Task 4 is the first task with readers for [the five record foreign keys]" IS NO LONGER
TRUE.** `taskEffort` is a reader for `task_id`, it arrives a task early, and it runs on every
drawer open rather than a few times a day. Measured on the dev server against a database built
by the real migrations, entries spread over 200 tasks with a tenth archived, warm, without and
then with a partial index on `(task_id) WHERE archived_at IS NULL`:

```
    5,000 entries,  22 live on the task:   0.42ms /    73 buffers  ->  0.04ms /  24, index  56kB / 584kB heap
  200,000 entries, 907 live on the task:  18.80ms / 2,881 buffers  ->  0.78ms / 910, index 1.2MB /  23MB heap
```

Five thousand entries is a decade of a single operator logging two entries a working day, and
the difference there is four tenths of a millisecond on a request that already costs a network
round trip. **Not built** — 0017/0019/0020's rule, and Task 2's decision on
`meetings(occurred_at)` against the same evidence at the same scale. Note that even at 200k the
index saves only two thirds of the buffers: a task's hours are scattered across years of insert
order, so the bitmap heap scan still visits 907 pages.

**THE MEASUREMENT'S FIRST DRAFT WAS A BAD INSTRUMENT AND SAID SO.** It spread entries over
tasks with `g % 200` and archived them with `g % 10`, and 10 divides 200 — so every entry on
the target task had one fixed `g mod 10` and **all of them were archived**. It reported nought
rows on the task, which is the only reason it was caught rather than written down as a fast
query.

### The journal trap: seventh time, and it cost nothing again

`drizzle-kit generate` stamped 0022's `when` as the wall clock again. `npm run db:generate`
restamped to `1789300000002` and said so on stdout. A mutation putting the raw value back is
killed by `schema.test.ts`'s strictly-increasing check **and** by the 0022 drill, which finds
the column simply absent.

### Mutation evidence

**Forty-four mutations, all forty-four killed, plus a control watched GREEN first.** The
harness reads vitest's exit status from `spawnSync`'s `status` **before any output is piped
anywhere**, and refuses to edit unless its search string occurs **exactly once** in the target
file.

**FIVE BAD INSTRUMENTS WERE CAUGHT, AND FOUR OF THEM SHARED ONE CAUSE WORTH WRITING DOWN.**

- **Four DDL mutations were aimed at `db/schema.ts` and changed nothing the tests can see.**
  Every database in this suite is built by `migrate(migrationsFolder)` — out of
  `drizzle/*.sql`. `db/schema.ts` is what drizzle-kit reads to *generate* those files and what
  the query builder types itself from; **a CHECK deleted there is still enforced by the
  database.** Re-aimed at `0022_task_estimate.sql`, all four are killed, along with a
  fifth (the column arriving as `text`) and a sixth (the journal trap). **The standing gap
  this exposes is real and general: nothing in the suite compares `db/schema.ts` to the
  migrations**, so the two could drift and the only symptom would be a spurious `DROP
  CONSTRAINT` in whatever migration is generated next. It predates this task and is left
  recorded rather than fixed in passing.
- **One "survivor" inserted `AND true` beside a predicate instead of deleting it** — a no-op
  dressed as a mutation. Deleting `isNull(timeEntries.archivedAt)` properly is killed.

**FOUR WERE REFUSED BY THE HARNESS BEFORE THEY COULD LIE.** Twice because
`estimateMinutes: z.number().int().min(1).max(MAX_TASK_ESTIMATE_MINUTES).nullable(),` occurs in
**both** `taskSchema` and `taskEffortSchema` — a mutation applied to the wrong one and then
surviving would have been recorded as a gap in these tests. Twice because a search string had a
typo and matched nothing.

**AND ONE EQUIVALENT MUTANT WAS RECOGNISED RATHER THAN RECORDED AS A SURVIVOR.** `gap < 0 ? … :
…` rewritten as `gap > 0 ? … : …` with the branches exchanged is the *same function*, because
`gap === 0` has already returned above it. Replaced by two that genuinely differ — the words
"over" and "left" exchanged, and the subtraction reversed — and both are killed by six tests.

| mutation | answered by |
|---|---|
| `tasks_estimate_range` never added / admits a zero / ceiling ±1 | the exact-edges test and the 0022 drill |
| the column arrives with `DEFAULT 0` | 5 tests, including the drill's "existing tasks read back unestimated" |
| the column arrives as `text` | the catalogue test, which also compares it against `time_entries.minutes` |
| **0022's journal `when` put back to what drizzle-kit generated** | the strictly-increasing journal test, and the drill finding no column |
| `MAX_TASK_ESTIMATE_MINUTES` becomes the entry bound | the shared test, the schema test's pinned literal |
| the wire floor drops to 0; either ceiling removed; `taskEffortSchema` unbounded | the shared tests and the route's 400s |
| `taskEffortSchema`'s same-population refine removed | "refuses minutes with no entries" |
| the summary drops its estimate clause / its "no time booked yet" branch / "exactly on" / the sign / the plural | 1–9 tests each, in shared and in the service |
| **the words "over" and "left" swapped; the gap subtracted the wrong way round** | 6 tests each |
| the archived-entry filter deleted; the task filter dropped; the sum not COALESCEd | the `taskEffort` tests |
| **the `::int` casts dropped, so the driver returns bigint strings** | the runtime-type test and the route's schema parse |
| the 404 removed; the estimate not carried back; minutes and count swapped; an archived task refused | the `taskEffort` tests |
| `toTask` drops the estimate; it is not patchable; create ignores it; the UPDATE never writes it | 3–4 tests each, in the service and over HTTP |
| **the task key never published; only the arriving task published; archive silent; create silent; the Set removed** | the four hint tests — the ripple's own guard |
| `estimate_minutes` dropped from the sheet's header | **the new column-coverage guard**, by name |
| the estimate cell blanked, or exported as `0` for an unestimated task | the export tests |
| the effort route never registered | the route test |
| **the drawer composes the comparison itself; it clamps against a typed-out 525600** | `task-effort-render.test.ts`, reading the page off disk |
| **the Gantt's own `toTask` forgets the field** | `tsc` (exit 2): `TS2322`. Nothing had to run |
| a comment-only change (**the control**) | green, watched first |

**WHAT IS NOT COVERED, AND IS SAID RATHER THAN GLOSSED.** `handleEstimateBlur`'s clamp has no
unit-level behavioural test — this repo has no DOM testing, so its unit guard reads the source.
The e2e now types a `0` and asserts the field reads back `1`, which is the only place that
branch runs end to end.

## Task 4: The timesheet

### What Task 2 built for this task, and the three rules that come with it

- [x] **THE SUM IS ALREADY WRITTEN.** `GET /api/timesheet?from=&to=` →
      `services/timesheet.ts`'s `timesheetTotals`. It is summed in SQL, COALESCEd and cast;
      **do not compute a total on the page.** The bullet below is answered, not pending.
- [x] **RENDER `timesheetSummary`, NOT `countedMinutes`.** The uncounted meetings — the ones
      with no recorded length and the ones that have not happened yet — are in the same string
      as the figure precisely so a page cannot print the figure without them. A page that
      renders `countedMinutes` and calls it the week's total is the failure the spec names,
      and the field is named `countedMinutes` so that page reads as a lie in its own source.
      **Nothing tests a page that does not exist yet: this bullet is the guard.** If the design
      wants the numbers laid out rather than a sentence, the uncounted ones are not optional
      furniture — see `settings-data-lib.test.ts` for the shape of a test that reads a page off
      disk and fails if it typed out what it should have derived.
- [x] **IF YOU ADD A CONTACT FILTER, USE AN EXISTS AND NOT A JOIN.** `listMeetings` widens its
      contact filter to attendance, and as a JOIN to `meeting_attendees` a meeting with three
      attendees is summed three times. The aggregate deliberately has no join; a mutation
      adding one is killed by a test, and that test is why it is worth reading before editing
      the query.
- [x] The record filters and the billable split are still this task's, and the five record
      indexes with them. `meetings(occurred_at)` was measured and not built — see Task 2's
      figures; if your filters change the query's shape, that index joins yours.

- [x] **A list, not a weekly grid.** The grid is the classic and is the hardest thing in this
      product to operate on a phone, which is where Chris is. No approval workflow — single user.
- [x] It answers "where did the week go", summing entries and meetings without double-counting.
- [x] **SUM IN SQL, NOT OVER A PAGE.** `listTimeEntries` caps at 100 rows, so a JavaScript sum
      over `items` is correct until somebody logs 101 entries in a week and is then silently
      SHORT — this phase's own failure mode, arriving through the one number the phase exists to
      produce. `COALESCE` it too: `SUM` over no rows is NULL and an empty week is 0 hours, not an
      absent one. Task 1 wrote and then deleted such a function rather than ship one with no
      reader; the argument is left at the foot of `services/time-entries.ts`.
- [x] **The five record foreign keys on `time_entries` are deliberately unindexed** (0021 builds
      only `(work_date DESC, id DESC)`, for the list's own ordering and cursor). Task 4 is the
      first task with readers for them; build them then, with a measurement.
- [x] **A `billable` filter and an `ownerUserId` filter are deliberately absent** from
      `timeEntryListFiltersSchema` for the same reason. The billable split is this task's.

### Task 4 as built — `/timesheet`, and NO MIGRATION AT ALL

**A list, day by day, one column, at a phone width.** `GET /api/timesheet` gains four
record filters and a billable split; `GET /api/timesheet/days` is new and answers the week
ROW BY ROW; `pages/timesheet.tsx` renders both, `pages/timesheet-lib.ts` holds every
decision, and `/timesheet` is the ninth nav destination. **`drizzle/` is untouched** — no
column, no index, no journal entry, no stamper run — so this task changes no schema and the
export's `information_schema` column guard has nothing new to cover.

**THE ROW LIST IS THE PART THE PLAN DID NOT ASK FOR, AND IT IS WHY THE PAGE IS HONEST.**
The summary says "and 2h 30m across 3 meetings. Not counted: 2 meetings with no recorded
length" — and a page listing only `time_entries` under that sentence gives the reader no
way to check a third of the figure, and nothing at all to look at for the uncounted two.
So `timesheetDays` reads BOTH tables over the same range with the same predicates, and
every row says whether it counted and why not. `timesheetWeekSchema` refuses a payload
where a day's figure is not its own rows, where a day falls outside the range, or where a
row is uncounted for no stated reason.

**THE BUCKETS ARE NOT DECIDED TWICE.** `meetingBuckets(now)` returns the two `sql`
expressions and the row list SELECTs them back as booleans, rather than comparing
`occurredAt` to `now` in JavaScript with its own choice of `<` or `<=`. A test seeds one of
everything — counted, unmeasured, not-yet, archived on both sides, rows outside the range —
and holds the list against the aggregate bucket for bucket.

### The four rules, and where each is now held

| the rule | what holds it |
|---|---|
| render `timesheetSummary`, not `countedMinutes` | `pages/timesheet-render.test.ts` — reads the page off disk, refuses nine figure names, refuses `totals.data.countedMinutes` **and its destructured form**, and refuses every clause of both sentences as literal text |
| an unmeasured or not-yet meeting must be visible | the sentence, AND a row carrying the same words, AND an e2e that asserts both |
| sum in SQL and COALESCE it | neither the page nor its lib may `reduce` or add minutes — the same source guard — and a day's figure comes off the payload |
| the week is the ORGANISATION's calendar | `weekAt` goes through `todayInZone(org.timeZone)`, never `todayLocalIso`; a unit case runs Amsterdam against UTC across `23:30Z` and gets two DIFFERENT WEEKS |

### The billable split, and the clause that stops it reading as a share of the week

`billable` has had no default since Task 1 and **until this task nothing in the product
could read it back** — the spec says billable time "feeds reporting and export, not
billing", and with no report it was a write-only column the operator is forced to answer on
every entry. `timesheetTotals` now carries `billableEntryMinutes` and `billableEntryCount`,
out of the SAME aggregate as the thing they split (a `FILTER` clause, not a second query),
and `timesheetTotalsSchema` refuses a half larger than its whole.

**IT IS A SENTENCE FOR `timesheetSummary`'S REASON.** "3h billable" printed beside a 7h 30m
week invites `7h 30m − 3h = 4h 30m non-billable`, which is wrong by exactly the meetings:
`meetings` has no billable column, so their minutes are in NEITHER half.
`timesheetBillableSummary` says so in the same string, and drops the clause only when there
are no meetings for it to be about.

**AND THE FORM ASKS RATHER THAN PRE-TICKING.** `TimeEntryDraft.billable` is
`boolean | null` and `buildTimeEntryInput` refuses the null: a pre-ticked checkbox would
put the guess the column refuses back one layer out, where the database cannot reach it.

### FOUR RECORD FILTERS, NOT FIVE — the plan says "the record filters" and there are five links

**`taskId` IS REFUSED, AND THAT IS THE DECISION.** `meetings` carries four record links and
`task_id` is not one of them, so a task-filtered timesheet answers "0m across 0 meetings"
for **every task that has ever existed** — an uncounted-hours silence whose cause (no
meeting CAN name a task) appears nowhere on the page. And Task 3 already answers the
question better: `GET /api/tasks/:id/effort` gives a task's booked minutes *against its
estimate*. A second, weaker answer on another surface is how two numbers about one thing
start disagreeing. The web-side type is narrowed to four kinds, so a task filter does not
compile.

The contact arm on the meetings side is an **EXISTS**, widened to attendance exactly as
`listMeetings` is — Task 2 wrote that hazard down for this task by name, and a mutation
turning it into a `leftJoin(meetingAttendees)` is killed by "counts a filtered meeting once
however many attendees it had", on the aggregate and on the row list.

### `["timesheet"]`, AND TASK 2'S ROUTE COMMENT WAS WRONG

`routes/timesheet.ts` said a client "refetches it on the `["time-entries"]` and
`["meetings"]` hints the two mutators already publish". **That cannot work.** A TanStack
query has ONE key: nested under `["meetings"]` the week goes stale after every entry write,
and under `["time-entries"]` after every meeting. The report reads two tables, so it needs a
key of its own — `publishTimeEntryHint` and `publishMeetingHint` both publish
`["timesheet"]` now, and both have a test for it.

### The phone, and what was rejected

One column. Heading row, week controls, the two sentences, then seven day sections. Every
control is at the 44px floor; the two week arrows are `min-h-11 min-w-11` at every width
because the glyph inside them is a few pixels wide, and both carry an `aria-label`. Rows
are `max-md:min-h-11` and wrap, the label's `max-md:basis-[calc(100%-5rem)]` forcing the
break — my-tasks.tsx's measurement one row over. An e2e case reads
`scrollWidth - clientWidth` at 390px and asserts the page does not scroll sideways, which
is the one thing a list is supposed to buy over a grid.

- **REJECTED: the weekly grid.** The spec's own decision, and its reason.
- **REJECTED: a day-of-week strip (M T W T F S S) as the navigation.** It is the grid's top
  edge under another name; seven targets across a 327px content box is 46px each, at the
  floor with nothing spare; and it answers "which day", which scrolling answers better.
- **REJECTED: a five-way segmented control for the filter.** The record rail's five labels
  MEASURE 349px inside a 342px box at 390px (`e2e/mobile.spec.ts`), which is why that strip
  had to become its own scroll container. Four wrapping buttons instead.
- **REJECTED: a Time tab on the record rail.** Phase 9's Task 4 declined a SIXTH tab against
  that measurement; this would be a seventh. A record's hours are reached by narrowing this
  page instead, which costs no width on any record page.
- **REJECTED: a fifth bottom-bar tab.** `PRIMARY_NAV_IDS` is four by spec and the fifth slot
  is More. The timesheet joins the More sheet and the sidebar beside Pipelines, Projects and
  the Gantt; `e2e/mobile.spec.ts`'s overflow journey now walks five.
- **REJECTED: editing a meeting's minutes from this page.** Two front doors for
  `duration_minutes` would give the correction this phase relies on — archive the meeting,
  log the hour by hand — two front doors as well.

**THE FORM HOLDS A LIST OF LINKS, NOT ONE**, and that is the spec's central example rather
than a flourish: the rule is at-least-one and not exactly-one *because* "an hour can
legitimately belong to a project AND the deal it came from". A single-link form would have
silently CLEARED the others on every edit, because the patch sends all five columns —
`timeEntryUpdateInputSchema` treats an absent field as "leave it alone", so the nulls are
what clear a link the operator removed and they have to be spelled out.

### THE INDEXES: MEASURED, NONE BUILT, AND ONE FIGURE SAYS THE PLAN WAS WRONG

The plan assigns "the five record indexes" here because this is the first task with readers
for them. There now are readers, so they were measured — dev server, database built by the
real migrations, seven years of rows across 199 projects with an eighth of them on the
project being filtered for, a seventh archived, a fifth of meetings untimed. Warm,
`EXPLAIN (ANALYZE, BUFFERS)` on the four shapes the page issues, without and then with
partial indexes on every record column and on `meetings(occurred_at)`:

```
  5,000 entries / 5,000 meetings (11 entries, 12 meetings in the week)
    totals, entries, unfiltered      0.034ms /  15 buf  ->  0.031ms /  15
    totals, entries, one project     0.053ms /  18      ->  0.051ms /  10
    totals, meetings, unfiltered     0.441ms /  81      ->  0.028ms /  14
    rows,   entries + 5 joins        0.182ms /  21      ->  0.202ms /  21
    rows,   meetings + 4 joins       0.532ms /  87      ->  0.166ms /  20

  200,000 / 200,000 (468 entries, 496 meetings in the week; 58 and 61 on the project)
    totals, entries, unfiltered      0.52ms  / 552      ->  0.38ms  / 552
    totals, entries, one project     0.41ms  / 555      ->  0.72ms  /  87
    totals, meetings, unfiltered    21.6ms   / 3,226    ->  0.39ms  / 499
    rows,   entries + 5 joins        1.56ms  / 558      ->  1.36ms  / 558
    rows,   meetings + 4 joins      16.8ms   / 3,390    ->  0.99ms  / 505
```

**THE FIVE RECORD INDEXES DO NOT HELP THIS READER, AND AT 200k THEY MAKE IT SLOWER.** The
project-filtered aggregate goes 0.41ms → 0.72ms with the index and the row list 0.39ms →
0.84ms, on a sixth of the buffers. Repeated three times, consistently: 0.38/0.45/0.47
against 0.84/0.87/1.04. The cause is structural rather than a planner accident, which is
why it is written down as a conclusion: **the timesheet is DATE-RANGED FIRST**,
`time_entries_work_date_idx` (0021) already exists and already reduces the table to one
week, and the record predicate is then a filter over a few hundred rows — cheaper than a
second index scan plus a BitmapAnd plus a heap fetch. An index earns its place when the
record is the SELECTIVE half, and on this surface the date always is. **`taskEffort` is the
one reader whose record predicate is all it has, which is exactly why Task 3's figures for
the same column point the other way.**

**`meetings(occurred_at)` IS THE ONE THAT WOULD MATTER, AND IT IS STILL NOT BUILT.** At 200k
it turns two whole-table scans per page open into index scans. At 5,000 meetings — a decade
of heavy single-operator use — the page's two meeting queries cost 0.97ms together and
would cost 0.19ms, on a request that has already spent a network round trip. That is Task
2's decision against the same evidence at the same scale, and one more caller does not
entitle this task to a different answer. **It now has THREE readers waiting for it**
(`listMeetings` since Phase 5, plus both halves of this report), so it is the first index
anybody should build the day that table gets big.

**THE INSTRUMENT LIED FIRST AND SAID SO.** Its first draft spread rows with `g % 199`,
which gives the filtered project one row in 199 — about 25 of 5,000, over seven years, so
**none in the measured week**. The "filtered" queries were measuring a project with nothing
on it and came back instantly. Caught only because the probe PRINTS the row count it is
about to measure: Task 3's lesson used rather than repeated.

### THREE THINGS THE SPEC AND THE PLAN ARE WRONG OR SILENT ABOUT

**1. A ZOD `.refine` RUNS EVEN WHEN THE OBJECT'S OWN FIELDS FAILED, AND IT IS HANDED THE RAW
VALUE.** Measured on the deploy target, zod 4.4.3: `z.object({ from: z.iso.date(), … })
.refine(fn)` called `fn` with `{ from: "2026-09" }` **after** `from` had produced an
`invalid_format` issue, and a chained second refine ran too. So the rows route's span check
— which calls `calendarDaySpan`, and that THROWS on anything that is not a calendar day —
turned a 400 into a **500** for a request the field validators had already refused. Found by
its own route test, closed with an `isCalendarDay` guard. **This is general, not this
route's quirk: any `.refine` in this codebase that does more than compare already-parsed
primitives can be handed rubbish, and one that throws converts a 4xx into a 5xx.** Recorded
rather than audited in passing.

**2. AN ENTRY DATED IN THE FUTURE COUNTS AND A MEETING DATED IN THE FUTURE DOES NOT, AND
NOTHING SAYS SO.** `work_date` admits any day in either direction (its own comment argues
why), and `timesheetTotals`' entries query has no `now` in it — so an hour typed against
Friday is in Wednesday's total. Task 2's meeting half deliberately excludes the future,
because `occurred_at` is free in both directions and no column distinguishes "had" from
"arranged". Both readings are defensible on their own and the ASYMMETRY is inherited rather
than chosen here; nothing in the spec or the plan notices it. It is left alone deliberately
— excluding future entries would silently drop hours somebody typed on purpose, which is
this phase's failure mode — and the day list makes such an entry visible within the week.
**A decision for Chris if he wants them to agree.**

**3. THE PLAN'S "Task 4 is the first task with readers for [the record foreign keys]; build
them then" IS AN INSTRUCTION TO BUILD SOMETHING THAT MAKES THE READER SLOWER.** See the
figures above. The premise was already corrected once by Task 3 (`taskEffort` arrived a task
early); what the measurement adds is that the premise is wrong in the other direction too —
this reader's record predicate is never the selective half.

### Mutation evidence

**Sixty-six mutations plus a control, watched GREEN first.** Sixty-two killed on the first
pass. Of the four that survived: one was a **bad instrument**, re-aimed and killed; one is
an **equivalent mutant**; one is **green by design** and now says so in the source; and
**ONE WAS REAL and is closed**. The harness reads vitest's exit status from `spawnSync`'s
`status` **before any output is piped anywhere** (Phase 9 lost a result to a `| tail`) and
refuses to edit unless its search string occurs **exactly once** in the target file — none
were refused this time.

**THE REAL SURVIVOR, AND IT IS THE ONE TASK 2 ALREADY PAID FOR ONCE.** Turning the DAY
LIST's `occurred_at < endExclusive` into `<=` was green across the whole file. It is the
identical mutation Task 2 recorded surviving on the AGGREGATE, arriving on the second query
built over the same range — a meeting at 00:30 local cannot tell the two spellings apart,
and every fixture in the file sits comfortably inside a week. Closed the way Task 2 closed
it: a meeting on the **stroke of midnight** at each end, asserting that the two weeks around
it hold one row each and 75 minutes between them. Killed.

**THE BAD INSTRUMENT.** "The contact filter becomes a JOIN" was written as
`IN (SELECT … FROM meeting_attendees)`, which is a subquery and fans nothing out — a no-op
dressed as a mutation, and it "survived" honestly. Re-aimed at the thing it was supposed to
be, `.leftJoin(meetingAttendees, …)` on the aggregate, it is killed by "counts a filtered
meeting once however many attendees it had".

**THE EQUIVALENT MUTANT.** `label: link.label ?? link.id` → `?? ""`. The fallback is
unreachable: nothing in this schema is ever hard-deleted, so a LEFT JOIN on a primary key
always finds its row. Recorded rather than chased.

**GREEN BY DESIGN, AND THE SOURCE NOW SAYS SO.** Deleting `timesheetDays`' "a row fell
outside the range" throw is green, because the instant bounds and the day conversion are
built from the SAME zone — nothing this function can be given puts a row outside its own
range, not even a zone with a day that does not exist. It is the arrangement the file's two
"an aggregate returned no row" throws already have, and its comment now records the probe
rather than implying a reachable case.

| mutation | answered by |
|---|---|
| `isoWeekRange`: Sunday starts its own week; the week is six days; the offset counts days; the day is not validated | `time-zone.test.ts`'s two-year sweep and its named cases, plus `weekAt`'s |
| `calendarDaysBetween` drops the last day; `calendarDaySpan` excludes one end | the shared tests, the service's "every day of the range", the route's exact-span case |
| `isCalendarDay` drops the round trip, so `2026-02-30` is a day | the shared test — and this guard is what keeps a 400 from being a 500 |
| `zonedDayFormatter` uses the zone unresolved | "falls back to UTC for a zone that no longer resolves" |
| the billable sum loses its FILTER / its COALESCE / its `::int`; the billable count becomes the entry count | 1–8 tests each, in the service, the routes and shared |
| the schema stops holding the billable half against its whole | "refuses a billable half larger than the entries it is a half of" |
| **`timesheetBillableSummary` drops its meetings clause**; splits nothing rather than saying so; names the whole where the half belongs | the shared tests, the service's, the route's, and an e2e that reads the sentence off the screen |
| the filters never reach the entries / never reach the meetings | "narrows the entries AND the meetings to the same record", and the route's |
| the contact filter stops reaching attendance | "reaches a meeting the contact merely attended" |
| **the aggregate gains a real `leftJoin(meetingAttendees)`** | "counts a filtered meeting once however many attendees it had" |
| the filter contract grows a `taskId`; the page offers a task filter | `timesheetFiltersSchema`'s key list, and `FILTER_KINDS`' |
| the day list drops the meetings / drops the entries; an empty day is omitted | the cross-check against the aggregate, and the route's row counts |
| a day's figure counts the rows it could not count | "says which meetings were not counted", and the wire schema's day refine |
| an archived entry / an archived meeting is still listed | "leaves archived entries and archived meetings out of the list entirely" |
| not-yet stops taking precedence over unmeasured; the two reasons are exchanged | the three-meeting bucket test, row by row |
| an entry claims to be uncounted; a meeting gains `billable: false` | the cross-check, the route's parse, and `timesheetRowSchema` |
| the record joins become INNER; an entry's links lose the task | "carries a readable name for every record a row names" |
| **the day list joins `meeting_attendees`** | "lists a meeting once however many attendees it had" |
| **the meeting range's upper bound is made inclusive** | **THE REAL SURVIVOR** — closed by the stroke-of-midnight test above |
| a meeting's day is taken from the instant rather than the organisation's clock | "puts a meeting on the day the organisation's calendar has it" |
| the rows list gains a `.limit(100)` | "lists every entry of the week, past the page size the entries list stops at" |
| `timesheetWeekSchema` stops holding a day's figure against its rows / admits a day outside the range; `timesheetRowSchema` admits an uncounted row with no reason, or a billable meeting | the shared tests, one per refine |
| the span bound is dropped; **the `isCalendarDay` guard is removed, so a malformed day is a 500**; the rows route is never registered; the route drops the filters | the route tests |
| **a time-entry write, or a meeting write, stops publishing `["timesheet"]`** | the two hint tests |
| **the page prints `countedMinutes` and calls it the week's total**; drops the billable sentence; adds up the day's rows itself; types out the bound | `timesheet-render.test.ts`, reading the page off disk |
| the form defaults billable to false; lets an hour be booked to nothing; appends a second link of one kind; a patch omits the links it is clearing; takes the device's today; the bound off by one; a blank description stored as `""`; an unmeasured meeting reads "0m"; `weekLabel` drops the year; the conflict message stops saying what to do | `timesheet-lib.test.ts`, 1–4 tests each |
| **the timesheet is not a nav destination, so it is desktop-only**; the sidebar and the sheet disagree about its name | `nav-lib.test.ts`'s partition and its sidebar scrape |
| a comment-only change (**the control**) | green, watched first |

### AND THE E2E'S FIRST DRAFT WAS A BAD INSTRUMENT TOO, WHICH CI CAUGHT

It asserted the week's **absolute** total. CI failed it three times with 2h, then 3h 30m,
then 5h: this suite shares one database, `e2e/tasks.spec.ts` books an hour of its own, and
a `describe.serial` RE-RUNS FROM THE TOP on retry — so each attempt added its own entry to
the figure the next attempt asserted. An absolute total over a database other journeys write
to is a measurement of the whole suite. Every figure is now read through the page's own
record filter, narrowed to the journey's own project, and the filter's contrast is a SECOND
project asserted by row rather than by total.

**AND CI CAUGHT A SECOND ONE, WHICH IS A FINDING ABOUT THE SUITE RATHER THAN THIS FILE.**
The next attempt failed with the not-yet-happened clause simply absent, because
**`e2e/documents.spec.ts` sets `org_profile.time_zone` to Europe/Amsterdam** as part of its
own journey and sorts before this one. The week's instant bounds are then
`[Sun 22:00Z, Sun 22:00Z)`, and the meeting placed at "Sunday 23:59Z, later this week" was
in the NEXT week. **That setting is global and another file owns it**, and this journey may
not fight for it — writing UTC back would make `documents.spec.ts` flaky the moment the two
run in parallel, which they do outside CI. So the zone is FETCHED and every fixture derives
from it: the past meetings sit at `now` (inside the current week by construction, past by
the time the server evaluates), and the arranged one is next WEDNESDAY, which is in the
future for every clock and inside next week's bounds for every zone. Verified on the dev
server against a real browser at **UTC, Europe/Amsterdam (CI's own value), UTC+14 and
UTC−11**: 14 passed in each.

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
