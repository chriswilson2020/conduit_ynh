# Conduit Phase 9 → v1.8.0 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-06-conduit-phase-9-document-types-design.md`, approved
by Chris 6 Sep. Read it first.

**Baseline:** v1.7.2, shipped 6 Sep. `main` at `5bc63e9`.

**Order:** the data model first, because it moves live data and everything else sits on it. Then
the type whose content Conduit already holds whole, then the two that need a form, then the one
whose source is broadest. **The riskiest content type is last on purpose**, the same reasoning
Phase 4.4 used.

---

## Task 1: `documents` stops being a quote table

- [x] **Read `schema.ts` before believing this plan.** `documents` carries `currency`,
      `subtotal_cents`, `tax_cents`, `total_cents`, `recipient_name` — all `NOT NULL` — plus
      `valid_until_date` and `deal_id NOT NULL`. Five shapes cannot live in that.
- [x] **A common table plus per-type detail.** `documents` keeps identity, type, rendered file,
      issue date, issuer, attachment and frozen-ness. The quote's money columns move to
      `document_quotes`.
- [x] **The FK set widens to five** — company, contact, deal, project, meeting — with
      `num_nonnulls(...) = 1`. **Copy `notes`/`files`' CHECK rather than inventing one**; it is
      the same rule and the codebase already enforces it in two places.
- [x] **THE MIGRATION MOVES CHRIS'S LIVE QUOTES.** Highest-consequence item in the phase.
      **Prove existing rows survive with a fixture written by the PRE-migration code**, committed,
      and read by the new schema — a round trip through the new code proves only that the new code
      agrees with itself. That is v1.7.0's credential-union lesson and it is not optional.
- [x] **Existing quotes must still open and still render.** The rendered PDFs are
      content-addressed and must not be re-rendered to survive.

### Task 1 as built — v1.8.0, migration 0016

`documents` now holds only what every type shares: id, number, type, the five record
FKs, file_id, issue_date, `frozen`, issued_by_user_id, created_at. The quote's eleven
columns live in `document_quotes`, keyed by document_id.

**THE PLAN AND THE SPEC BOTH UNDERSTATE THE MOVE.** Both name six columns (currency,
subtotal_cents, tax_cents, total_cents, recipient_name, valid_until_date). Five more
are just as quote-shaped and moved with them: `recipient_contact_name`,
`recipient_salutation`, `recipient_address`, `notes`, `terms`. Eleven columns, not six.
The recipient group is the one judgement call in the split and it is argued at the table
in `schema.ts`: an NDA and a letter are also addressed to somebody, but these four
columns are shaped by the quote (a salutation column exists because a quote prints a
greeting), and generalising a party model from the only type that has been built is how
this table became a quote table in the first place. Tasks 3 and 4 will have three
examples; a common `document_parties` is theirs to make.

**Freezing.** The spec reads two ways — "documents keeps ... whether it is frozen" is a
column, "a per-type flag and the guard that reads it" is not. Both halves are here:
`@conduit/shared`'s `documentTypeFreezes()` (a `switch`, so a type added without an
answer is a build error — verified: adding `"letter"` to `documentTypeSchema` gives
TS2366) tells the writer what to store, and `documents_frozen_matches_type` refuses a
row that disagrees. **Nothing READS the column yet.** Task 3 is where the guard that
reads it arrives; the column is here now because adding it later means a second
migration over live rows.

**What an existing quote looks like afterwards.** Its `documents` row keeps id, number,
type, file_id, issue_date, issued_by_user_id, created_at and deal_id, gains four NULL
record FKs (so `num_nonnulls(...) = 1` holds) and `frozen = true` from the ALTER's
DEFAULT. Everything else is a `document_quotes` row with the same id. Its lines are
untouched. **Its PDF is untouched**: 0016 names neither `files` nor the blob store, and
blobs are content-addressed, so an unchanged sha256 is the whole of "the same bytes,
not re-rendered".

### The proof that existing quotes survive

`packages/api/src/test/legacy-quote-rows.ts` holds two quotes **written by `issueQuote`
as it stood at 5dac366, before any Phase 9 edit**, against a database migrated only to
0015, rendered by the dev server's real WeasyPrint (14,565 and 13,191 bytes, one page
each), and dumped column by column with `row_to_json`. The file carries the commit and
the blob hashes of `services/documents.ts`, `db/schema.ts` and `shared/src/index.ts` so
it is checkable rather than asserted. It is replayed with `json_populate_record`, which
names the columns the FIXTURE recorded rather than the columns TypeScript knows about
today.

The drill pins its own premise by asserting the pre-0016 catalogue's column list equals
the fixture's — so the fixture cannot have been quietly reshaped to suit the new code
-- then migrates and asserts that the **new** `listDocuments` returns exactly what the
**old** `listDocuments` returned.

### Mutation evidence

**38 mutations. 36 killed by tests, one killed by typecheck, one green by design (a
comment-only change, run first to prove the harness can report GREEN).** One survivor,
and it was a real gap.

| mutation | caught by |
|---|---|
| the `INSERT ... SELECT` that fills `document_quotes` deleted | 0016 drill, 0011 drill |
| that INSERT's `subtotal_cents`/`tax_cents` swapped | 0016 drill |
| that INSERT drops `recipient_salutation` | 0016 drill |
| `frozen` backfilled `false` instead of `true` | 0016 drill, 0011 drill |
| `ALTER COLUMN frozen DROP DEFAULT` removed | "gives frozen no default" |
| `documents_frozen_matches_type` removed | the documentTypeFreezes sync test |
| `documentTypeFreezes("quote")` returns `false` | 23 tests across two files |
| the service hardcodes `frozen: false` | 22 of documents.test.ts's 45 |
| `documents_exactly_one_entity` forgets `meeting_id` | exactly-one, and the FK test |
| ...becomes `>= 1` | exactly-one |
| `deal_id` keeps its NOT NULL | exactly-one, and the FK test |
| the `meeting_id` foreign key never added | the FK test |
| `document_quotes.document_id` loses its PRIMARY KEY | the FK test |
| `documents.currency` never dropped | 11 tests |
| `document_quotes_totals_representable` narrowed by one cent | the exact-edges test |
| the journal's `when` for 0016 put back to what drizzle-kit generated | the journal test, and the 0016 drill |
| the reader swaps subtotal and tax | 3 tests |
| the reader blanks the salutation / loses valid-until / loses terms | 2, 1, 1 |
| the writer blanks the recipient / invents a currency | 1, 2 |
| the writer drops terms / notes / address / expiry / contact name / salutation | "stores every optional field it was given" (and one more for two of them) |
| the writer defaults an omitted optional to a placeholder | "stores an omitted optional as the empty string" |
| the export sheet reads the wrong total / blanks the address | the export documents test |
| `replayLegacyQuoteRows` inserts nothing | 0016 drill |
| the fixture's column list, expected tax, or expected PDF sha256 altered | 0016 drill |
| a second member added to `documentTypeSchema` | **typecheck** (TS2366) |

**THE SURVIVOR, AND IT PREDATES THIS TASK.** Replacing the writer's
`terms: quote.terms ?? ""` with `terms: ""` was **green** across documents.test.ts,
routes.test.ts and export.test.ts. `notes`, `terms`, `recipientAddress` and
`validUntilDate` were written by `issueQuote` and asserted by nobody: `buildContext`'s
suite covers what the TEMPLATE does with them and the migration drill covers what the
MIGRATION does with them, and between the two nothing had looked at what the INSERT did.
Closed with two tests in documents.test.ts — one giving every optional a DISTINCT value
(identical ones would still pass if the writer put notes in the terms column, which is
exactly the mistake an eleven-column move invites), one omitting them all. Re-run: all
seven writer-column mutations now fail, and name the new tests.

### Two findings that are not about this task's code

1. **`drizzle-kit generate` produced a migration that would have destroyed the data.**
   It emitted `ALTER TABLE "documents" ADD COLUMN "frozen" boolean NOT NULL` with no
   default — which fails outright on any table with a row in it — and, of course, no
   data move at all: eleven `DROP COLUMN`s and nothing to catch what was in them. On an
   empty test database the second half is invisible. The shipped file is hand-written;
   only the generated `meta/0016_snapshot.json` is kept.

2. **A journal `when` that goes backwards silently skips the migration.** drizzle
   applies a migration only when `lastDbMigration.created_at < migration.folderMillis`
   (`drizzle-orm/pg-core/dialect.js`), reading the ONE newest applied row. Entries 0013
   onwards carry hand-set round numbers that are in the future relative to the wall
   clock, so drizzle-kit's generated `when` for 0016 (1788663974827) landed between
   0013's and 0014's — and 0016 would have been skipped on every database that already
   had 0015, with no error. Fixed to 1788900000000, and `schema.test.ts` now pins the
   whole journal as strictly increasing, by name, for every future migration.

## Task 2: Meeting summary — the type with no form

- [x] The whole content is a `meetings` row: title, date, attendees, notes. **The notes are
      already TipTap HTML**, so they go through the existing sanitiser rather than a new path.
- [x] **No extra input at all**, which makes this the type that proves the model without a form
      confusing the picture. Build it first for that reason.
- [x] **Not frozen** (Chris's decision) and **almost certainly wants no number** — `QUO-2026-0001`
      suits a quote and suits this not at all. Decide and say why.

### Task 2 as built — v1.8.0, migration 0017

`meeting_summary` is a real type: `documentTypeSchema`, `documents_type_valid`,
`document_templates_type_valid`, a template seeded by 0017,
`issueMeetingSummary`, `listMeetingSummaries`, `POST`/`GET
/api/meetings/:id/documents`, a Summary section in the meeting view, and a
per-type Settings template editor. It attaches to its meeting and to nothing
else, and its `documents` row has `frozen = false`.

**A MEETING SUMMARY TAKES NO NUMBER, AND HERE ARE THE THREE REASONS** (they
live at `documentTypeNumbered` in `@conduit/shared`; "QUO-2026-0001 suits this
not at all" is an aesthetic judgement and two of these are not):

1. **A number is an EXTERNAL handle.** It exists so the person you sent the
   document to can quote it back, and so a commercial document belongs to a
   gapless auditable sequence. A summary is identified by the meeting it is of
   — title and date, both printed on it — and there is nobody on the other end
   holding a reference.
2. **Numbering serialises issuing, measurably.** `allocateNumber` takes a
   `(type, year)` row lock held to commit, and the render happens inside it
   (~600–700ms). For a quote that is the point: consecutive numbers are
   consecutive. For a summary it would make every summary of a given year queue
   behind every other one, to buy a string nobody reads.
3. **A summary is not frozen, so it can be produced again**, and a numbered
   thing that can be produced again must choose between spending a second
   number and reusing the first. Neither is better than having none.

So `documents.number` is nullable, and `documents_number_matches_type`
(`(number IS NOT NULL) = (type IN ('quote'))`) replaces `NOT NULL` with
something strictly stronger — it also forbids a NUMBERED summary, which
`NOT NULL` never could, and which `formatDocumentNumber`'s `?? "DOC"` fallback
would otherwise have minted as `DOC-2026-0001`. **The UNIQUE constraint needed
no change**: PostgreSQL treats NULLs as distinct unless `NULLS NOT DISTINCT` is
declared. A third enforcement is an ABSENCE:
`document_number_sequences_type_valid` is deliberately NOT widened, so a writer
that called `allocateNumber` for a summary fails on that INSERT.

**THE COMPOSITE `(document_id, type)` FOREIGN KEY IS IN.** Task 1 said Task 2
would be the first moment it could catch anything and be tested as more than
structure; both were true. What it catches is specific: without it, `INSERT
INTO document_quotes` naming a summary succeeds, and the row is not inert —
every read of a quote joins on `document_id`, so `listDocuments` and the
export's `documentsSheet` would start returning that summary AS a quote, with a
currency and three money columns. The redundant `document_quotes.type` costs
nothing to keep in step: `NOT NULL DEFAULT 'quote'` with a CHECK pinning it, so
no writer mentions it and none can change it.

### What the spec and the plan did not say, and needed to

1. **A MEETING SUMMARY WAS NOT STORABLE AS SPECIFIED.** `documents.file_id` is
   NOT NULL, every rendered PDF is an ordinary `files` row (Phase 7), and
   `files_exactly_one_entity` names four parents that do not include a meeting.
   Neither document mentions this. 0017 gives `files` a `meeting_id`; the
   rejected alternatives are at the table in `schema.ts` (filing it under one of
   the meeting's own links is an arbitrary rule and attaches the file to a
   record its own document says it is not about; a nullable `file_id` with a
   private blob path means two download stories; a `meeting_files` table makes
   every reader of files two readers). `notes` keeps the four — Phase 5's
   argument there is about what a PERSON writes.
2. **"The expensive parts are done" IS TOO STRONG.** The renderer, the
   sanitiser and content-addressed storage were indeed free. Three pieces of
   "done" machinery were not: the merge engine escaped every value and had no
   way to emit markup (a `MergeHtml` value, decided by the CONTEXT and never by
   the template — see the class for why a triple brace would be a privilege
   escalation here); `files` above; and the Settings template editor, which was
   hard-coded to `quote` and would have shipped four types whose templates only
   a `curl` could edit.
3. **THE EXPORT WOULD HAVE DROPPED EVERY SUMMARY, SILENTLY.**
   `services/export.ts`'s `documentsSheet` INNER JOINs `document_quotes`, and
   its own comment predicted this ("when a second type has rows, this file needs
   a decision"). Neither the spec nor the plan mentions the export at all, and
   it is an operator-facing data-loss path. Now a LEFT JOIN, with `meeting_id`,
   `meeting_title` and `frozen` columns; `files.csv` gained the meeting pair
   too, or a summary's PDF is the one member of `files/` with every record cell
   blank.
4. **"NUMBERING IS ALREADY PER TYPE PER YEAR AND GENERALISES" IS HALF TRUE.**
   The sequence table is per `(type, year)`, but
   `document_number_sequences_type_valid` admitted one value, and
   `formatDocumentNumber` falls back to a `DOC` prefix for anything else — so a
   second type would either have failed on the INSERT or started a private
   series, depending on which half you read.
5. **CONDUIT STORES NO TIMEZONE ANYWHERE, so the server cannot print the wall
   clock the operator typed.** `meetings.occurred_at` is a timestamptz built in
   the browser from a `datetime-local`; `org_profile` has no timezone column and
   neither does `users`. The summary prints `1 September 2026 at 13:30 UTC` —
   the zone NAMED, because a reader can convert an instant that says which clock
   it used and cannot even detect one that does not. **If Chris wants local
   time, the fix is an org-profile timezone field and one argument on
   `formatDocumentInstant`** — a Settings field, not a redesign. Reported rather
   than assumed.
6. **`drizzle-kit generate` PRODUCED A MIGRATION THAT CANNOT APPLY.** Task 1
   found it emitting a `NOT NULL` column with no default; this time it ordered
   the composite foreign key BEFORE the `UNIQUE (id, type)` it references, which
   fails with "there is no unique constraint matching given keys". It also
   stamped the journal `when` as 1788663974827-shaped again (1788668557605),
   below 0016's hand-set 1788900000000 — the silent skip Task 1 documented,
   reproduced exactly. The shipped file is hand-written; only
   `meta/0017_snapshot.json` is kept.
7. **A BUG IN `test/pdf.ts`, FOUND BY THIS TYPE'S FIRST REAL RENDER.**
   `pageCount` took the largest `/Count` anywhere in the file. WeasyPrint also
   writes an `/Outlines` dictionary with a `/Count` of its own, derived from the
   headings on the page — the quote template has one `<h1>` so its outline count
   coincided with its page count, and a one-page summary whose own footer reads
   "Page 1 of 1" was reported as three pages. It now reads the dictionary that
   says `/Type /Pages`.
8. **Two counts in the spec are off by the same type.** The phase is "four
   templates, four forms" — it is four templates and THREE forms, because this
   one has none. And the plan's Task 2 says "build it first", which it is not:
   it is second, after the data model, exactly as the plan's own ordering says.

### Mutation evidence

**48 mutations. 47 killed, one green by design** (a comment-only change, run
first to prove the harness can report GREEN). **Four survived the first pass and
all four are now killed**, each by an assertion that had been unable to tell two
implementations apart:

| survivor | why it survived | what closed it |
|---|---|---|
| `formatDocumentInstant` without `timeZone: "UTC"` | CI, the server and every machine here run at Etc/UTC, where "UTC" and "the process's zone" are the same string | the test moves `process.env.TZ` to America/New_York, which Node 24 re-reads for a formatter built afterwards |
| a `MergeHtml` block pushing the wrapper as a scope | `lookup` walks outward and the wrapper has no `document` key, so the ordinary case resolves either way | `{{#document.notes}}{{html}}{{/document.notes}}` must print a blank, not the raw markup |
| the notes reaching the context unsanitised | the merged PAGE is sanitised too, so the script came out either way | notes that sanitise away to nothing must make the template SAY there were none, which is an `isEmpty` question |
| `1 minute` losing its singular | `toContain("1 minute")` is satisfied by `"1 minutes"` | the assertion is closed round the `<td>` the template prints |

Killed on the first pass, in groups: the two new CHECKs and their weakenings
(4); the composite key, its column, its default and its target UNIQUE (4); the
files widening and its foreign key (2); the index, both type CHECKs, the
template seed and the journal `when` (5); both per-type rules in
`@conduit/shared` (2); three more on `formatDocumentInstant` (3); the merge
engine's raw-value emission, emptiness and paths reader (5); thirteen on the
service (frozen, sanitising, the wrapper, attendee names and order, the
filename's date and truncation, the list's predicate and order, the size
refusal's noun and provenance, the duration); three on `attachFile`; three on
the export; and one on the `pageCount` fix.

### Counts

Unit suite **3944 passed / 48 skipped in 98 files**, against **3884 / 48 in 97**
at Task 1's tip: **+60 tests, +1 file**. `npm run typecheck` clean. CI e2e found
one real regression and it is worth recording: `rail-live.spec.ts` stubs
`GET /api/files` with rows written by hand, so it is a second copy of
`fileMetaSchema` — the widened shape made `parseWith` throw and the Files tab
render nothing, which presented as two tests finding zero file rows.

## Task 2.5: The organisation's timezone — Chris's instruction, 6 Sep

Not in the original plan. Task 2's finding 5 reported that **Conduit stores no timezone
anywhere**, so a meeting summary printed `1 September 2026 at 13:30 UTC` for a meeting the
operator held at half past three in Amsterdam. Chris asked for local time, and asked for it
**before** Tasks 3 and 4 rather than after, because those add three more types that print dates.
Numbered 2.5 so Tasks 3 and 4 keep the numbers everything else refers to them by.

### As built — v1.8.0, migration 0018

`org_profile.time_zone`, a `text NOT NULL DEFAULT 'UTC'` with a shape CHECK; a
`packages/shared/src/time-zone.ts` holding `DEFAULT_TIME_ZONE`, `timeZoneProblem`,
`usableTimeZone`, `todayInZone` and `timeZoneLabel`; `formatDocumentInstant(iso, timeZone)`
with the zone **required**; a `<select>` in Settings → Organisation built from the browser's
own `Intl.supportedValuesOf("timeZone")`; and both of the summary's dates reading the new
column.

**THE DEFAULT IS UTC, AND IT IS THE ONLY ONE THAT CHANGES NOTHING.** With this zone
`formatDocumentInstant` emits the v1.7.x string byte for byte — trailing `UTC` included,
because en-GB's short zone name for UTC is exactly `UTC` — so re-rendering a summary issued
before the upgrade produces the same page. Rejected: reading the server's zone at migration
time, which is Etc/UTC on the YunoHost box (no better) and elsewhere is the zone of a machine
in a datacentre, which is not evidence about where the operator sits.

**THE ZONE IS STILL NAMED ON THE PAGE**, and the label now moves with the season: `CET` in
January, `CEST` in July, off one stored zone. Chris's argument for dropping it (a document
handed to somebody in the same office does not need `CEST`) is real and was rejected on two
grounds. These documents are PDFs that get downloaded and emailed, which is the whole point of
Phase 9, and the reader who needs the label is the one not in the room. And the label is what
makes the unresolvable-zone fallback honest rather than silent: the render falls back to UTC,
the page says UTC, and the printed time and the printed label agree. Drop the label and that
failure path needs an announcement mechanism of its own, on the one path nothing exercises.

**WHAT A RENDER DOES WITH A ZONE THAT NO LONGER RESOLVES**: formats in UTC, names UTC, never
throws. Refusing to issue the document was rejected — the zone is fixable in ten seconds in
Settings, and turning "your times print in UTC and say so" into "you cannot produce the
document your customer is waiting for" trades a cosmetic degradation for an outage. The
operator's copy of the warning is on the Settings page, which shows the stored value with
`timeZoneProblem`'s sentence under it.

### What the brief for this task got wrong

1. **"A free-text field that lets someone type `CET` produces a runtime throw at render time"
   is FALSE.** Measured on Node 24.19 (the server) and 24.15 (here):
   `new Intl.DateTimeFormat("en-GB", { timeZone: "CET" })` does not throw. `CET` is a real
   tzdata identifier, links to Europe/Brussels, and carries the right transitions. **The
   dangerous values are the ones `Intl` ACCEPTS**, which is the opposite failure mode and
   drove the whole design: `+02:00` is accepted and is a constant, so it prints an hour out
   for half the year with a plausible `GMT+2` beside it. That is the value the validator
   refuses, and it is the only refusal here that is a judgement rather than a fact.
2. **"The platform can answer 'is this a real zone' on its own" is true, and the obvious
   platform answer is the wrong one.** `Intl.supportedValuesOf("timeZone")` returns 418
   `Area/Location` names and contains **no `UTC`**, no `GMT` and nothing under `Etc/` — so a
   membership gate would have refused this column's own default. It also reports the
   PRE-rename primaries on this engine (`Asia/Calcutta`, `Europe/Kiev`) while a newer browser
   hands the form `Asia/Kolkata` and `Europe/Kyiv`, so a membership gate would refuse values
   the operator's own browser had just offered them. The gate is therefore "does
   `Intl.DateTimeFormat` accept it, and is it not an offset"; the LIST is used for the picker,
   where being incomplete costs nothing.
3. **"IANA renames zones" is the one mechanism that CANNOT break a stored zone.** A rename
   leaves the old name as a link, indefinitely — measured: `Asia/Calcutta`, `Europe/Kiev`,
   `America/Godthab` and `Pacific/Enderbury` all still resolve on Node 24, and this engine's
   `supportedValuesOf` still reports them as the primaries. Even `US/Pacific-New`, dropped
   from tzdata's `backward` file in 2020b, still resolves here, because ICU keeps more than
   IANA ships. What CAN leave an unresolvable value in the column is narrower: a name coined
   after this Node's tzdata (a form filled in from a newer browser), a restore or import from
   an install with different tzdata, and a hand-written API call. The requirement stands —
   nothing may throw mid-render — but the likelihood is much lower than the brief implies,
   which is why the answer is a fallback plus a Settings warning and not machinery.
4. **"One field and one argument" was one field and TWO dates.** The summary also prints
   `{{document.issueDate}}` and puts it in the PDF's filename, and that came from
   `scheduling.ts`'s `todayDateOnly()` — the server's UTC calendar day. A summary issued at
   00:30 in Amsterdam was dated the day before, in type, on a page sent to the people who were
   in the room. `todayInZone` is that second call site. `todayDateOnly` is untouched: its
   documented ±2h caveat is right for the Gantt clamp it was written for.
5. **The QUOTE's issue date is deliberately NOT changed.** It is client-supplied on a form
   (`documentDateSchema`), so it is the operator's own choice in the operator's own browser,
   and the organisation's zone is not a better answer than what they typed.

### The migration trap fired a third time

`drizzle-kit generate` stamped 0018's journal `when` as **1788674737914**, which falls between
0013's 1788600000000 and 0014's 1788700000000 — so 0018 would have been skipped, silently, on
every install already carrying 0014. Identical to 0016's and 0017's. Hand-set to 1789100000000;
Task 1's journal test catches it, and so does the 0018 drill (0017's `when` is above the
generated one, so the column never arrives). **The SQL itself was correct this time** — an
`ADD COLUMN ... DEFAULT 'UTC' NOT NULL` and a CHECK, in that order — which is the first of the
three that did not also need rewriting; only the tag and the `when` were changed, and the file
gained its header.

### One thing that went red and was not this task's code

`schema.test.ts`'s **0010** drill seeds `org_profile` with `insert(orgProfile)` against a
database migrated only to 0009. A drizzle insert spells out every column schema.ts knows about
— `time_zone` included, as `default` — so it failed with `column "time_zone" does not exist`.
This is the standing hazard the 0011 and 0017 drills already record in comments; it reached the
0010 drill now because `org_profile` had not gained a column since. Fixed with raw SQL, the
same way.

### Mutation evidence

**44 mutations. 37 killed by tests, 2 by typecheck, 5 green — one by design, one proved
equivalent, two redundant by design, and one a real and general gap that is reported rather
than closed.** Run against `shared`, `settings-org-lib`, `org-profile`, `documents-summary`,
`documents`, `schema` and `routes` — 662 tests — on an isolated remote directory and database.

**The harness was calibrated in both directions before any of it counted.** M00 changes only a
comment and must report GREEN; it did (373 passed, 0 failed). M01 makes `formatDocumentInstant`
return `""` unconditionally and must report RED; it did, naming 13 tests.

| mutation | caught by |
|---|---|
| `DEFAULT_TIME_ZONE` becomes Europe/Amsterdam | 15 |
| the fixed-offset refusal deleted | 6 |
| ...narrowed to a leading `+` only | the `-05:00` case |
| `resolveZone` swallows the RangeError and answers UTC | 10 |
| `MAX_TIME_ZONE_LENGTH` narrowed to 8 | 27 |
| `usableTimeZone` never falls back / always falls back | 5 / 8 |
| `timeZoneProblem` always answers null (every gate and the render fallback at once) | 14 |
| `todayInZone` ignores the zone it was given | the two-zone summary test, and todayInZone's own |
| `timeZoneLabel` asks for `shortGeneric` / for `long` | 12 / 13 |
| ...reads a fixed instant rather than the document's | 5 |
| ...stops falling back for a zone that is not one | its own direct test (see below) |
| the offset message stops naming the failure | the offset refusal test |
| `formatDocumentInstant` drops `timeZone` (falls to the process zone) | 5 |
| ...ignores its argument and formats in UTC | 5 |
| ...stops naming the zone / hard-codes `UTC` as the label | 12 / 5 |
| ...formats with the raw stored zone, so a render can throw | 3 |
| ...prints a numeric date | 13 |
| `toOrgProfile` repairs a broken stored zone on the way out | 23 |
| `emptyProfile` disagrees with the column default | 3, across three files |
| the summary context hard-codes UTC | "prints the organisation's wall clock once a zone is set" |
| the issue date goes back to the server's UTC calendar day | "dates the summary by the organisation's calendar" |
| the summary context reads the issue date as the meeting's moment | 3 |
| **the migration adds the column with no default** | 9, the 0018 drill among them |
| **the migration backfills the server's guess instead of UTC** | the 0018 drill, and 2 more |
| **the journal `when` put back to what drizzle-kit generated** | the journal test, and the 0018 drill |
| the migration's CHECK admits a leading sign / narrows to 20 / is never added | 3 / 1 / 3 |
| `timeZoneOptions` stops prepending the default | 4 |
| ...drops a stored zone the platform does not list | 3 |
| ...stops sorting | 1 |
| `supportedTimeZones` answers nothing | 2 |
| `orgProfileSchema` loses the field / `formatDocumentInstant` loses its parameter | **typecheck** |

**TWO SURVIVED THE FIRST PASS AND BOTH ARE NOW CLOSED.**

| survivor | why it survived | what closed it |
|---|---|---|
| `timeZoneProblem` drops its `value === ""` branch | `Intl` throws on `""` as readily as on `Factory`, so the value stayed refused and only the WORDS changed — and nothing read the words | an assertion that the two sentences differ: `""` gets told which value to send instead, `Factory` gets told this server does not know it |
| `timeZoneLabel` drops its own `usableTimeZone` call | its only caller had already resolved the zone before handing it over, so the guard was unreachable — true of today's caller, not of the function | a `describe` block for `timeZoneLabel` itself: the season, what en-GB gives outside Europe, the default, and the fallback. Four more mutations were run against it once it had one |

**THREE ARE GREEN AND STAY GREEN, WITH REASONS.**

1. **`todayInZone`'s `month: "2-digit"` swapped for `"numeric"` is an EQUIVALENT MUTANT, and
   it was measured rather than assumed.** ICU's en-GB numeric date pattern is `dd/MM/y`, so
   both options pad: `2026-01-02` either way, in every zone tried. `2-digit` stays because it
   is the spec-guaranteed request rather than a property of one locale's CLDR data, and the
   assertion is on the OUTPUT, so a future CLDR that stopped padding fails there rather than
   writing `2026-1-2` into a `date` column.
2. **Removing the zone check from `orgProfileInputSchema` alone, or from `saveOrgProfile`
   alone, is green — and that is what "the gate and the backstop" means.** It is the same
   pairing `logoDataUriProblem` already has and it is deliberately redundant, so removing
   either half leaves the other one answering. The pair is not collectively dead: M23 removes
   the predicate they both call and 14 tests fail.
3. **`schema.ts` declaring a different `.default()` from the migration is GREEN, and this is a
   real gap that is general rather than this column's.** The test database is built by running
   the migrations, so once a migration exists, `schema.ts`'s `.default()` is documentation:
   nothing in the suite compares the two. The catalogue test added here pins the MIGRATION's
   default against `DEFAULT_TIME_ZONE`, which is the pairing that decides what a row gets —
   but a `schema.ts` that drifts from `drizzle/` is invisible for every column in the file.
   Closing it properly is one test that runs `drizzle-kit generate` and asserts it emits
   nothing, which is its own piece of work and is **flagged for whoever takes Task 3.**

### Counts

Unit suite **3990 passed / 48 skipped in 100 files**, against **3944 / 48 in 98** at Task 2's
tip: **+46 tests, +2 files** (`shared/src/time-zone.test.ts`,
`web/src/pages/settings-org-lib.test.ts`). `npm run typecheck` clean. Run on an isolated
remote directory and database, both removed afterwards — `/home/chris/conduit` is shared and
the suite's advisory lock is cluster-wide.

## Task 3: The letter, and the NDA pair

- [x] **Letter**: a company or contact, plus a rich-text body the user types. Reuses the composer
      and the sanitiser. **Not frozen** — it wants redrafting before it goes.
- [x] **NDA and mutual NDA**: a company or contact, plus effective date, term and jurisdiction.
      **FROZEN on issue**, with the quote's guard — an agreement you can silently edit after
      sending is a different kind of document.
- [x] **"Exactly one" will be tested here.** An NDA names a contact at a company; the spec says it
      attaches to the **company** and names the contact in its content. **If that turns out wrong
      in practice, report it — do not quietly widen the CHECK.** It is Chris's decision and
      reopening it is his call.

### Task 3 as built — v1.8.0, migration 0019

`letter`, `nda` and `mutual_nda` are real types: `documentTypeSchema`, the three
widened CHECKs, `document_letters` and `document_agreements`, three templates seeded
by 0019, `issueLetter` / `issueAgreement` / `redraftLetter` / `listRecordDocuments`,
`GET`/`POST /api/companies/:id/documents` and its contact twin, `PUT
/api/documents/:id`, a Documents section on both detail pages, and three more tabs in
the Settings template editor. A letter attaches to a company or a contact and is
**not frozen**; both agreements attach to the same two records, are **numbered** and
are **frozen on issue**.

#### THE GUARD, WHICH IS THE POINT OF THE TASK

Task 1 shipped `documents.frozen` with "nothing READS the column yet". It is read in
three places now, and the third is the one that matters.

1. **`redraftLetter` refuses first**, with a typed `DocumentFrozenError` → 409
   `frozen`, before anything spawns.
2. **Its UPDATE carries `AND frozen = false`**, so the test and the write are one
   statement.
3. **`conduit_document_frozen_guard` — a trigger — refuses everything that is not
   `redraftLetter`.** `BEFORE UPDATE OR DELETE` on `documents` (with `WHEN
   (OLD.frozen)`) and on all three detail tables, which look the parent up. It holds
   for a psql session, an import, and a call site nobody has written yet.

**A CHECK CANNOT EXPRESS THIS RULE AND THAT IS WHY THE TRIGGER IS THE FIRST ONE IN
THIS SCHEMA.** A CHECK sees only the row being written; `frozen` does not say "this
value must be legal", it says "this row may not change", and OLD is a thing only a
trigger has. It is declared in the migration and not in `schema.ts` — drizzle-kit has
no vocabulary for a trigger, exactly as it has none for 0013's `conduit_lower_emails`
— so 0013's consequence stands: **`drizzle-kit push` must never be introduced.**

**THE DETAIL TABLES ARE GUARDED TOO, AND THAT IS THE HALF THAT MATTERS MOST.** The
parent row is where `frozen` lives, but the PRICE somebody was sent is in
`document_quotes` and the lines are in `document_line_items`. A guard on the parent
alone would leave both editable, with the `documents` row sitting there untouched
while the page it points at became a lie.

**IT BLOCKS NOTHING THAT EXISTED.** Verified across `packages/` and `e2e/` before it
was written: there was not one UPDATE or DELETE against any of the four tables.
TRUNCATE does not fire row-level triggers, so `truncateAll` is untouched; `restore`
loads a dump through psql after dropping the schema, so the trigger travels with the
dump like 0013's function.

#### Numbering per type — argued

**A LETTER TAKES NO NUMBER.** The three reasons are at `documentTypeNumbered` and each
is the summary's argument re-checked rather than assumed to carry over:

1. **The external handle is not missing, it is already taken.** A letter's reference
   is the operator's own convention — `Our ref:`, a project code — typed into the
   subject or the body. `LET-2026-0001` would sit beside it meaning nothing outside
   this database, and a document with two references has none.
2. **The lock is the same lock.** `allocateNumber` holds a `(type, year)` row lock to
   commit with the render inside it, so every letter of a year would queue behind
   every other one for a string nobody quotes back.
3. **The third reason is the summary's, SHARPENED.** A summary can be produced again;
   a letter is REDRAFTED, which is worse for a number rather than better. Producing
   again at least leaves each number attached to one immutable page; a redraft
   rewrites the page UNDER the number, so `LET-2026-0001` would name different
   content on Tuesday from the content it named on Monday — the one property a
   document number exists to deny.

**BOTH AGREEMENTS ARE NUMBERED**, the first `true` since the quote, and every one of
those reasons runs the other way: somebody else's legal team holds the reference;
"which agreements did we sign in 2026, and are there gaps" is an audit somebody
actually asks for; and the pathology cannot arise because an agreement is frozen, so
the number is allocated once and names bytes that can never change. `NDA-` and
`MNDA-`, two sequences, two prefixes — spelled that way rather than `NDA` and `NDA-M`
because `documents_number_unique` is global and the formatted numbers are what a
person reads.

**AT FIVE TYPES `documentTypeFreezes` AND `documentTypeNumbered` NOW ANSWER
IDENTICALLY, AND THAT IS A COINCIDENCE THAT MUST NOT BE COLLAPSED.** Task 2 predicted
the pairing ("an NDA is frozen AND numbered, a letter is neither") and argued against
merging them into one lookup; what arrived is agreement on all five members, which is
a more tempting coincidence than the prediction. The counterexamples are ordinary:
Task 4's status report is neither, and a credit note would be frozen and numbered
while a delivery note is numbered and freely reprinted. `schema.test.ts` asserts the
two sets as two independent literals rather than as `expect(frozen).toEqual(numbered)`,
because the second spelling would read as an invariant.

#### `document_parties` — NOT NOW, and what would change that

Task 1 left this to whoever had three examples. **This task had four types and did not
make the migration.** Three reasons, in the order they weigh (the full argument is at
`document_letters` in `schema.ts`):

1. **It would be a second migration over Chris's live quote rows in one release, for
   a refactor rather than a feature.** 0016 is the one migration in this project that
   has ever moved real data and the spec calls it the phase's highest-consequence
   item. Doing that again to spare some duplication — in the same release as three
   new types and a new guard — spends the risk in the wrong place.
2. **The four columns do not actually agree.** `recipient_salutation` exists because a
   quote PRINTS A GREETING, and so does a letter. An agreement has no greeting. A
   common table would either carry a column that is structurally empty for two of its
   four types — 0016's rejected "one table, several shapes, no guarantees", in the
   table built to avoid it — or share three columns while the fourth stays behind.
3. **"Recipient" is the quote's noun.** An agreement has PARTIES. A table called
   `document_parties` holding one recipient row per document is the quote's model
   wearing a general name, which is exactly how `documents` became a quote table. A
   real parties table is one row PER PARTY, and nothing motivates one: even a mutual
   NDA stores exactly one, because the other party is `org_profile` and is already on
   the letterhead.

**WHAT WOULD MAKE IT TIME:** a fourth type that needs the party group, at which point
all four column groups move together in a migration that does nothing else. What is
shared today is the LENGTHS (`DOCUMENT_PARTY_CAPS`), because a form spelling
`maxLength={200}` beside a schema that says something else is the only part of this
duplication that can drift into a bug silently.

### "Exactly one" held — and here is the consequence to look at

**THE NDA DID NOT BREAK IT.** The shape the spec worried about — an NDA naming a
contact at a company — is exactly the one Chris's answer handles: the document
attaches to the COMPANY and `document_agreements.party_contact_name` carries the
individual, which the template prints as "The Recipient acts through Jane Smith." The
CHECK was not widened, and `schema.test.ts` asserts that a document naming both a
company and a contact is refused.

**BUT THERE IS A CONSEQUENCE THE SPEC DOES NOT MENTION, AND IT IS THE LETTER'S, NOT
THE NDA'S.** A letter to Jane at Acme is raised on JANE, so it does not appear on
ACME's Documents list — and vice versa. `routes.test.ts` asserts that emptiness
deliberately, because it is the decision working rather than a bug. For an agreement
that is right: an NDA is with one legal entity and belongs to it. For
CORRESPONDENCE it is real friction — six months later, somebody opening Acme's record
sees no letters, because every letter went to a person.

**THE RECOMMENDATION IS A READ, NOT A COLUMN.** If Chris wants a company to show its
contacts' letters, the fix is a rollup in `listRecordDocuments` — `WHERE company_id =
$1 OR contact_id IN (SELECT id FROM contacts WHERE company_id = $1)`, behind a flag
the section can offer — and not a second owner. Widening the CHECK would make every
reader ask "which of the two is this document really about", which is the question
`num_nonnulls(...) = 1` exists to answer. **Reported rather than built: it is Chris's
decision, and it is a different decision from the one the spec asked about.**

### A REAL GAP THAT IS NOT THIS TASK'S TO CLOSE: which entity, per type

`documents_exactly_one_entity` says exactly one of five. **It does not say WHICH one
for a given type.** Nothing in the database stops a letter carrying a `deal_id` or a
quote carrying a `meeting_id`; only the writers do. That has been true since Task 2
(a summary could carry a deal) and this task made it true for three more types —
`redraftLetter` has to cope with a letter attached to neither a company nor a
contact, a shape no writer can produce, and it throws rather than dereferencing it.

The CHECK that would close it is five lines:

```sql
ALTER TABLE "documents" ADD CONSTRAINT "documents_entity_matches_type" CHECK (
     (type = 'quote'           AND deal_id    IS NOT NULL)
  OR (type = 'meeting_summary' AND meeting_id IS NOT NULL)
  OR (type IN ('letter','nda','mutual_nda') AND num_nonnulls(company_id, contact_id) = 1)
);
```

**IT IS NOT IN 0019, DELIBERATELY.** It is a rule about all five types, two of which
are not this task's, and adding it now means Task 4 widens a CHECK whose shape was
chosen without the status report in front of it — which is the same mistake 0016 made
by generalising a recipient model from the only type that existed, and which this task
declined to repeat over `document_parties`. Every existing row would satisfy it, so it
is a free migration whenever it is taken.

### What the spec and the plan did not say, and needed to

1. **THE MIGRATION TRAP FIRED A FOURTH TIME OUT OF FOUR, IDENTICALLY.**
   `drizzle-kit generate` stamped 0019's journal `when` as **1788691029541**, which
   falls between 0013's 1788600000000 and 0014's 1788700000000 — so 0019 would have
   been skipped, silently and without error, on every install already carrying 0014.
   Hand-set to 1789200000000. **The SQL itself was correct this time** (both CREATE
   TABLEs, the four foreign keys and the five CHECK swaps are drizzle-kit's work and
   are kept); what it cannot know about is the trigger, the two indexes and the three
   template rows.
2. **`test/seed-template.ts` COULD NOT READ A MIGRATION THAT SEEDS MORE THAN ONE
   TEMPLATE, AND WOULD HAVE FAILED SILENTLY.** Its pattern was anchored on the end of
   the FILE (`'\);\s*$`), which was an accident of 0009 and 0017 each ending with
   their INSERT. 0019 seeds three, so the greedy match would have run from the
   letter's opening quote to the mutual NDA's closing one and handed back all three
   templates concatenated AS THE LETTER TEMPLATE — and every suite that seeds its own
   copy would have merged against it. Now non-greedy and anchored on drizzle's own
   `--> statement-breakpoint`.
3. **THE TRIGGER SHADOWS A CHECK ON ANY FROZEN TYPE, AND ONE EXISTING TEST WAS
   PROBING THROUGH THE SHADOW.** `document_quotes_type_is_quote` was tested with an
   `UPDATE document_quotes SET type = ...`; a quote is frozen, so the guard now
   refuses first — same SQLSTATE, different constraint name — and the assertion went
   red on the NAME rather than on the refusal. The CHECK is not dead (nothing guards
   an INSERT, which is also the reachable path), so the probe moved there and the
   UPDATE is asserted as a refusal by whichever guard gets there first. **Generally:
   for a frozen type, a detail-table CHECK can only be probed on INSERT from now on.**
4. **THE EXPORT'S `documents.csv` NEVER HAD `company_id` OR `contact_id`, AND THE
   FAILURE WOULD HAVE BEEN QUIETER THAN TASK 2'S.** Task 2 found an INNER JOIN
   dropping every meeting summary. A letter would not have been dropped — its
   `documents` row would have come out looking perfect — it would have come out with
   its subject, its addressee and its BODY absent, and named no record at all. Six
   letter columns, six agreement columns and the company/contact pair are in the
   sheet now. **Neither the spec nor the plan mentions the export, for the second
   task running.**
5. **THE SPEC AND THE PLAN BOTH SAY "a record's Documents TAB". THE CODEBASE HAS
   NEVER HAD ONE.** The deal's is a section on the page and carries a comment saying
   why it is not a rail tab: "a document belongs to a deal alone; a sixth tab there
   would be empty on three of the four." Half of that expired with this task and the
   other half expires with Task 4. It is still a section, deliberately —
   consolidating means moving a shipped surface with its e2e specs and its
   `deal-documents` id, and the rail's tab strip carries a MEASURED phone claim about
   the last tab being reachable (`e2e/mobile.spec.ts`). **Flagged for Task 4, which
   will have four records in front of it instead of three.**
6. **`documentTypeSchema`'s OWN COMMENT STILL CARRIED THE SPEC'S MISCOUNT.** It called
   "letter, nda, mutual_nda, project_status_report" *the other three*, which is four —
   Task 2 recorded that the phase is four templates and THREE forms, and the wrong
   number had already reached the code. Corrected.
7. **`drizzle-kit generate` EMITTING NOTHING WOULD NOT CLOSE THE GAP TASK 2.5 FLAGGED
   IT FOR — measured, not reasoned.** Task 2.5 asked whoever took Task 3 to consider
   a test asserting `drizzle-kit generate` produces no migration, to catch a
   `schema.ts` `.default()` that has drifted from `drizzle/`. Run against this branch
   after 0019, generate emits nothing, so the test would pass and it would catch a
   `.default()` edited without a migration. **What it cannot see is everything
   `schema.ts` cannot express**, and that set is no longer small: it is now one
   function, five triggers and six indexes (`documents_deal_idx`,
   `documents_meeting_idx`, the two 0019 adds, and 0013's two expression indexes).
   None of those appears in `schema.ts` OR in the snapshots, so the diff is empty
   whether they exist or not — a migration that DROPPED `documents_company_idx` would
   pass the test. **Not built**, per the brief's "report rather than build": as a unit
   test it also has to shell out to `drizzle-kit` and write into a temp `out`
   directory, which is a fixture, not an assertion.

### Mutation evidence

**67 mutations over two passes. 63 killed, one green by design, three green with
reasons.** Run against `schema.test.ts`, `documents-letter.test.ts`,
`documents-number.test.ts`, `routes.test.ts`, `documents-errors.test.ts` and
`export.test.ts`, on an isolated remote directory and database. (The first pass
attempted 58 and could not apply three of them — the letter's `values` object is
written identically by the issue path and the redraft path, so the anchor was
ambiguous. The second pass runs those three against EACH path separately, which is
six mutations and the right number: a mutation of one path is invisible in the other.)

**The harness was calibrated in both directions before any of it counted.** M00
changes only a comment and must report GREEN; it did (131 passed, 0 failed). M01
inverts an `undefined` check in the letter writer and must report RED; it did, naming
22 tests.

**AND THE HARNESS ITSELF HAD A BUG THAT PRODUCED A FALSE SURVIVOR.** The remote
command ended `| tail -6`, so the exit status was TAIL's — always 0 — and a mutation
that stops the suite from STARTING (a migration that cannot apply) printed no
"Tests ... failed" line and was scored SURVIVED. `set -o pipefail` is the fix and the
two affected mutations were re-run under it; both are red. Recorded because "the
instrument reported green" and "nothing broke" looked identical, which is the failure
mode this project keeps finding.

#### The guard, which is what this task is about

| mutation | result |
|---|---|
| `redraftLetter`'s early `frozen` check removed | KILLED (3) |
| ...and the UPDATE's `AND frozen = false` removed **as well** — both service guards gone | **KILLED (3), by the trigger** |
| the `documents` trigger never created | KILLED (3) |
| the `document_quotes` trigger never created | KILLED (4) |
| the `document_line_items` trigger never created | KILLED (1) |
| the `document_agreements` trigger never created | KILLED (1) |
| the trigger's `WHEN (OLD.frozen)` removed, so it fires on every row | KILLED (4) |
| `BEFORE UPDATE OR DELETE` narrowed to `BEFORE UPDATE` | KILLED (3) |
| the detail guard's `IF owner_frozen` inverted | KILLED (9) |
| the detail guard returns NULL, silently cancelling the write | KILLED (5) |
| `documents_frozen_matches_type` not widened | KILLED (18) |
| `documentTypeFreezes` says an NDA is not frozen / a letter is | KILLED (14 / 25) |
| the service hardcodes `frozen: false` for an agreement / `true` for a letter | KILLED (11 / 22) |
| the 409 `frozen` arm removed from the route mapper | KILLED (2) |
| the trigger's route arm matches SQLSTATE 23514 alone | KILLED (1) |
| ...reads `error.message` instead of the driver's `cause.message` | KILLED (1) |

**THE ONE THAT MATTERS MOST IS THE SECOND ROW.** With BOTH service-side guards
deleted, `redraftLetter` still cannot edit a quote: the UPDATE reaches the database
and `conduit_document_frozen_guard` refuses it. The tests go red because the error is
the trigger's rather than `DocumentFrozenError`, and the quote's row is unchanged
either way — which is the claim.

#### Everything else, in groups

Numbering (6): `documentTypeNumbered` flipped for either type; `documents_number_matches_type`
not widened; `document_number_sequences_type_valid` widened to admit a letter; the
mutual NDA sharing the NDA's prefix; the NDA prefix missing so it falls back to `DOC`.

The migration (10): the journal `when` put back to what drizzle-kit generated; each of
the three type CHECKs not widened; the two indexes not built; either composite foreign
key dropped; `document_agreements_term_range` narrowed by one at each end;
`document_agreements_stated` dropped; `document_letters_type_is_letter` dropped; the
letter template losing `{{document.body}}`; the letter template not inserted at all.

The service (19): the body not sanitised; the empty-after-sanitising check removed; the
body emitted escaped; the subject emitted RAW; the term losing its singular; the raw
month count exposed to the template; the filename losing its date, its truncation, or
its subject-before-recipient rule; the redraft skipping its type check, keeping the old
issue date, or keeping the old file; the writer dropping the subject, swapping the
contact name and the salutation, or defaulting an omitted optional — **each of those
three run separately against the ISSUE path and the REDRAFT path, because the two
build the same values object and a mutation of one is invisible in the other**; the
list inner-joining, ordering oldest-first, or reading the wrong record column; the DTO
blanking the company id; the redraft's "attached to neither" branch removed.

The record gate (3): the archived check removed for a company or for a contact, and the
existence check removed.

The export (2): the letter join broken; a missing term exported as `0` rather than blank.

#### TWO SURVIVED THE FIRST PASS AND BOTH ARE NOW CLOSED

| survivor | why it survived | what closed it |
|---|---|---|
| `assertRecordIssuable`'s archived check deleted | `attachFile` refuses an archived record too, with the SAME `ArchivedError` — so the error type and an empty `documents` table were identical either way. But `attachFile` runs AFTER the merge, the caps, the render and the blob write | a renderer stub that fails if it is called at all, so the refusal has to arrive before anything spawns. Three assertions now, one per branch and one on the agreement path (where a spent number would be the visible trace) |
| `redraftLetter`'s "attached to neither a company nor a contact" branch | no writer can produce the row, so nothing reached it | a test that writes the row the way a psql session would — `UPDATE documents SET company_id = NULL, deal_id = ...` — which is also the concrete demonstration of the "which entity, per type" gap above |

#### THREE ARE GREEN AND STAY GREEN, WITH REASONS

0. **Altering the letter template's opening literal in the migration is green, and
   it is an EQUIVALENT MUTANT BY CONSTRUCTION rather than a gap in the assertions.**
   `test/seed-template.ts` derives the expected template from the same file the
   migration is read out of, so both sides of the drill's comparison move together
   — which that file's own header already warns about ("a migration that amends the
   body in some OTHER shape would be missed here silently"). What is NOT equivalent
   is a change that alters what the template NAMES or whether it lands at all, and
   both were run instead: dropping `{{document.body}}` from the letter template
   fails the token-set equality (5 tests), and inserting it under a misspelt type
   fails the "every type has a seeded template" assertion (which now comes off the
   enum).
1. **Removing the UPDATE's `AND frozen = false` ALONE is green, and it is an
   equivalent mutant that was measured rather than assumed.** Nothing can change
   `frozen` under a live row — `documents_frozen_matches_type` ties it to `type`, and
   the trigger refuses the UPDATE that would try — so the SELECT a few lines above and
   the UPDATE can never disagree. The clause stays anyway: what makes it unobservable
   is two OTHER guards holding, and a guard that leans on another guard should still
   state its own condition. Removing both service-side guards is red (see above).
2. **`issueAgreement` losing its `SET LOCAL lock_timeout` is green**, exactly as
   `issueQuote`'s identical line is. It bounds a pile-up of concurrent issues of the
   same type and year against a saturated renderer; no unit test creates that
   contention, and one that did would be measuring the renderer's queue rather than
   this line.

### Counts

Unit suite **4065 passed / 48 skipped in 101 files**, against **3990 / 48 in 100** at
Task 2.5's tip: **+75 tests, +1 file**
(`packages/api/src/services/documents-letter.test.ts`). `npm run typecheck` clean. Run
on an isolated remote directory and database, both removed afterwards —
`/home/chris/conduit` is shared and the suite's advisory lock is cluster-wide.

`drizzle-kit generate` answers "No schema changes, nothing to migrate" against this
branch, which is the measurement behind finding 7 above.

CI green on the first push: **4110 passed / 3 skipped in 101 files** for the unit
job (the runner has WeasyPrint and 7-Zip, so 45 of the dev server's 48 skips run
there) and **257 passed** for the e2e job. No e2e regression, which is worth naming
because Task 2's push found one: the letter and the agreement forms are new dialogs
on two existing pages, and the specs that measure those pages at 320px
(`mobile.spec.ts`'s overflow guard) pass with the section's header wrapping.

## Task 4: Project status report — the broadest source, and the schedule risk

- [x] Content is a `projects` row plus its tasks, dates and Gantt state. **This is the one most
      likely to be larger than it looks**, and the spec says so.
- [x] **Possibly a date range**, which no other type needs. Establish whether it is required
      before building a form for it.
- [x] **Not frozen** — you regenerate it next month, and a stale report is worse than an edited
      one.
- [x] **If this turns out to be a phase of its own, say so and stop.** Three types shipped and one
      reported is a better outcome than four types half-built.

### Task 4 as built — v1.8.0, migration 0020

`project_status_report` is a real type: `documentTypeSchema`, two widened CHECKs, a
template seeded by 0020, `documents_project_idx`, `issueStatusReport`,
`listProjectDocuments`, `GET`/`POST /api/projects/:id/documents`, a Documents section
on the project page, and a sixth tab in the Settings template editor. It attaches to
its project and to nothing else, takes **no number**, is **not frozen**, and has **no
detail table**.

Two things arrive that are not the type: **`documents_entity_matches_type`**, the CHECK
Task 3 wrote out in the plan and left for whoever had all the types; and the
**company Documents rollup** Task 3 recommended, as an opt-in read.

#### WAS IT THE PHASE-SIZED ITEM THE PLAN FEARED? NO — AND THE REASON IS THE DATE RANGE

**It is the SECOND TYPE WITH NO FORM**, which nobody expected. The spec's table gives
it "possibly a date range" as its extra input and the plan asked for that to be settled
before a form was built; settled NO, it has no input at all. (That also settles the
phase's counts, which nobody has got right yet — see finding 5: five templates, two
forms.)

The breadth the spec worried about is real and it is **entirely on the read**: which
tasks, in what order, with whose dependencies, summarised by seven counts and an
overdue rule. None of that is submitted by anybody, so none of it needed a form, a
validation schema, a detail table or a DTO field. The whole type is one service
function, one reader, two routes and a template.

#### THE DATE RANGE: NOT REQUIRED, AND HERE IS WHAT SETTLED IT

A range could only be one of two things.

1. **A FILTER over which tasks appear.** `tasks_dates_paired` admits a task with NO
   dates — both null, which is what every task looks like before anybody schedules it
   — so a range has to decide what to do with one, and both answers are wrong. Drop
   them and the report silently omits exactly the tasks that most need attention,
   which is the same class of failure as the export's INNER JOIN dropping every
   meeting summary. Keep them and the range is not a filter.

   **THE DECIDING EVIDENCE IS A PRECEDENT IN THIS CODEBASE AND IT POINTS THE OTHER
   WAY.** `ganttPayload` DOES drop undated tasks (`isNotNull(startDate),
   isNotNull(dueDate)`) — because a chart has nowhere to draw a bar with no ends. A
   report is a table: it has a row. So the one place Conduit already applies a date
   filter to tasks applies it for a reason that does not transfer.

   And over dated tasks a range only subtracts: narrower than the project hides work,
   wider contains the same tasks. The one genuinely interesting window — "what changed
   since the last report" — is not answerable from a range at all. It needs the
   previous report and a diff; `tasks` keeps no history, and reconstructing one from
   `events` is a different feature with a different name.

2. **A LABEL saying what period the report covers.** The project already has
   `start_date` and `due_date` and both are printed at the top of the page. A second,
   per-document range that can disagree with them is a second answer to "what period
   is this project", inside the document whose job is to be the answer.

**AND THE ISSUE DATE IS THE SERVER'S, NOT THE OPERATOR'S**, which is the same argument
one step on. A quote's issue date is client-supplied because the operator chose the
content too. A report's content is read LIVE at the moment it is produced, so a report
dated last Friday prints Friday's date over today's tasks — and the same value is what
the overdue count is measured against, so a back-dated report is arithmetically wrong
as well. `todayInZone(org.timeZone)`, which is v1.8.0's timezone field's third call
site.

#### NOT NUMBERED — AND THE LETTER'S REASON HAD TO BE TURNED INSIDE OUT

The three reasons are at `documentTypeNumbered`. The first two carry over (the handle
is the project and the date, both printed; the `(type, year)` row lock would serialise
"run this month's reports", which is a sentence about every active project at once).

**THE THIRD DOES NOT CARRY OVER AND SAYING SO IS THE POINT.** The letter's argument is
that a REDRAFT rewrites the page under a fixed number, so `LET-2026-0001` names
different content on Tuesday from Monday. A report is not redrafted — regenerating one
appends a SECOND document, exactly as a summary does — so that failure cannot arise
here. What arises instead is the summary's other one: the sequence fills with
near-duplicates. Twelve monthly reports on one project are twelve numbers, and "which
did we issue in 2026, and are there gaps" answers nothing, because two adjacent numbers
are the same report of the same project a month apart. **A gapless sequence is worth
having when its members are distinct commitments; successive answers to one standing
question are not.**

#### NO DETAIL TABLE, AND IT IS THE SECOND TYPE WITH NONE FOR A DIFFERENT REASON

A meeting summary needs none because its content is the `meetings` row it points at.
This one needs none because its content is a `projects` row, its `tasks` and their
`task_dependencies` — and unlike a letter's body, **not one byte of it was typed into
this document**. What a detail table would have bought is a snapshot of the counts, so
a Documents list could say "12 of 20 done" without re-reading the project; rejected as
a cache of a page that is already stored, in a table that would then have to be kept
truthful against a PDF nothing can regenerate, to spare one query on a list of
single-digit length.

#### THE THREE THINGS TASKS 1–3 DEFERRED HERE

**1. `documents_entity_matches_type` — BUILT, AND NOT AS THE PLAN SKETCHED IT.**

Task 3's five-line CHECK is in 0020, with one clause changed:

```sql
  OR (type IN ('letter','nda','mutual_nda')
      AND (company_id IS NOT NULL OR contact_id IS NOT NULL))   -- not num_nonnulls(...) = 1
```

`num_nonnulls(company_id, contact_id) = 1` admits exactly the same rows once
`documents_exactly_one_entity` stands beside it, and it costs the property this schema
keeps paying to protect: a letter naming BOTH a company and a contact would violate two
constraints at once, so PostgreSQL names whichever it reaches first and
`documents_exactly_one_entity` — Chris's decision of 6 Sep — could no longer be probed
by name **for the case it is most about**, the NDA-at-a-contact-of-a-company shape the
spec's third risk is entirely concerned with. Every arm now states which column and
none of them states how many.

**WHAT IT COST IN TESTS IS THE INTERESTING PART, BECAUSE EVERY PROBE IT BROKE WAS
MEASURING A GAP RATHER THAN A GUARANTEE.** Ten tests went red on first application,
and every one of them was writing a row the database now forbids:

| what went red | what it was really doing |
|---|---|
| `documents-summary.test.ts`'s "ignores a document on the meeting that is not a summary" | putting a QUOTE on a meeting to exercise `listMeetingSummaries`' type filter |
| `documents-letter.test.ts`'s "throws on a letter attached to a deal" | Task 3's own hand-written row, added to kill a surviving mutant |
| four enum-driven loops in `schema.test.ts` | hanging every type off the fixture's DEAL, which nothing had checked |

The first two are rewritten to assert the REFUSAL, which is the better test. **And both
leave a guard behind that is now unexercisable and is recorded as such rather than
quietly deleted**: `listMeetingSummaries`' `eq(type, 'meeting_summary')` and
`redraftLetter`'s "attached to neither a company nor a contact" branch are both green
under mutation from here on, because the state they handle is unreachable. Both stay —
a guard at a dereference costs a line, and what makes it unreachable is a constraint a
later migration could widen.

**THE ONE OVERLAP THAT CANNOT BE REMOVED**: an UNKNOWN type satisfies no arm here AND
breaks `documents_type_valid`, so from 0020 that constraint **cannot be probed by name
through an INSERT at all**. Its assertion moved to `pg_get_constraintdef`, compared
against `documentTypeSchema` — which is a stronger test than the INSERT ever was.
(Same shape as Task 3's finding 3 about the frozen trigger shadowing a detail-table
CHECK.)

**2. THE "Documents TAB" — STILL A SECTION, AND NOW WITH THE COST MEASURED.**

Both halves of the deal section's original reason have expired: after this task all
four records carry documents. It is still four sections, and here is what a sixth rail
tab would actually cost:

- **It would break a MEASURED phone claim.** `e2e/mobile.spec.ts`'s "reads the record
  rail, reaching its last tab by keyboard" arrows right FOUR times from Timeline and
  asserts Meetings is focused, is last, and is in the viewport. Its comment records the
  measurement: at 390px in Chrome on macOS the five labels are 349px of content in a
  342px box, and the test exists because below 360px that spill used to scroll the
  whole PAGE. A sixth label moves the number that was measured, and the guard would be
  rewritten by the same change that invalidates it.
- **It would move four shipped surfaces at once**, each with test ids and e2e specs:
  `deal-documents` (with the quote form), `record-documents` (two forms, three
  buttons and the redraft dialog) on two pages, and `project-documents`.
- **And the four are not one component.** A deal's raises quotes, a company's raises
  letters and agreements, a project's raises reports with no form at all. A shared tab
  is a switch over the record type wrapping three bodies — the consolidation people
  picture, one list of mixed types on one record, is not available, because
  `documents_exactly_one_entity` means a record carries only the types its own writers
  produce.

**Reported, not absorbed.** It is a UI task with an e2e measurement in it, not a
paragraph at the end of a data-model phase. **The spec's and the plan's "a record's
Documents TAB" is still wrong and has been wrong for four tasks.**

**3. THE LETTER ROLLUP — BUILT, OPT-IN, AND NO SECOND OWNER COLUMN.**

`listRecordDocuments(db, target, { includeContacts })`, exactly Task 3's SQL, behind
`GET /api/companies/:id/documents?includeContacts=true` and a checkbox on the company's
Documents section. Nothing about the data model moved: no widened CHECK, no second
owner, and a rolled-up row still comes back with `contactId` set and `companyId` null.

**DEFAULT OFF, WHICH IS WHY THE DECISION IS STILL VISIBLE.** Task 3's "keeps a
contact's documents separate from their company's" asserts a deliberate emptiness; a
rollup that turned itself on would have required deleting that test, which is how a
decision gets reversed by a task that was only asked to consider reversing it. Both
behaviours are asserted side by side now. Reversing the default later is one line.

**The query parameter is tested for the literal string `"true"`, not coerced.**
`z.coerce.boolean()` answers TRUE for the string `"false"`, which is the one value a
client is most likely to send when it means the opposite; `"false"`, `"1"`, `"yes"` and
`""` are all asserted to leave it off, and none of them is ever refused.

### What the spec and the plan did not say, and needed to

1. **THE MIGRATION TRAP FIRED A FIFTH TIME OUT OF FIVE — AND THIS TIME IT IS EXPLAINED
   RATHER THAN COUNTED.** `drizzle-kit generate` stamped 0020's journal `when` as
   **1788697198962** (measured twice), between 0013's 1788600000000 and 0014's
   1788700000000, so 0020 would have been skipped silently on every install already
   carrying 0014. Hand-set to 1789300000000.

   **THE DATES SAY WHY IT KEEPS HAPPENING AND WHY IT CANNOT BE FIXED FROM HERE.** `when`
   is `Date.now()`. 0013's is 2026-09-05T09:20Z, 0019's is 2026-09-12T08:00Z, 0020's is
   2026-09-13T11:46Z — each spaced by adding 1e11 ms rather than by re-reading the
   clock, so the entries have drifted steadily AHEAD of the wall clock, which today is
   2026-09-06. What matters is not which gap a generated value lands in but that it
   lands **below the newest entry**: drizzle reads the one newest applied row. So every
   migration generated before **2026-09-13T11:46Z** is skipped. And it cannot be fixed
   by choosing a smaller number for 0020, because a `when` must exceed 0019's and
   0019's is already six days ahead. **The trap is locked in for 0021 as well**, and
   the only things between it and a silent skip are the file header and
   `schema.test.ts`'s journal test.

2. **THE EXPORT WAS MISSED FOR THE THIRD TASK RUNNING, AND THIS FAILURE WOULD HAVE BEEN
   THE QUIETEST OF THE THREE.** Task 2 found an INNER JOIN dropping every meeting
   summary. Task 3 found no `company_id`/`contact_id`, so a letter named no record. A
   status report would not have been dropped and would not have looked wrong: its
   `documents` row would have come out perfectly, with `project_id` in a column that
   did not exist — so the ONE fact saying which project a report is about would have
   been absent from the archive entirely. `project_id` and `project_name` are in the
   sheet now. **Neither the spec nor the plan mentions the export, for the third task
   running.**

3. **TASK 3's COUNTEREXAMPLE AGAINST MERGING `documentTypeFreezes` AND
   `documentTypeNumbered` WAS NOT A COUNTEREXAMPLE.** It wrote: "The two rules are
   still independent and the counterexamples are ordinary: Task 4's status report is
   neither, and a credit note would be frozen and numbered..." **"Neither" is
   AGREEMENT** — both functions answer false — so the report, now built and indeed
   neither, made the coincidence **six for six** rather than breaking it. A prediction
   that a type would disagree was written down, the type was built, and it agreed. The
   two sets stay separate and the argument now stands on the rules answering different
   questions rather than on a promised counterexample; the remaining ones are all
   hypothetical.

4. **`recordDocumentSchema`'s COMMENT WAS WRONG ABOUT THIS TASK, IN ITS OWN LAST
   SENTENCE.** "If Task 4's status report attaches to a project, it joins this union."
   It attaches to a project and it does NOT join, because that union is the
   COMPANY-AND-CONTACT reader and a project is neither — the same reasoning the rest of
   the paragraph applies to the quote and the summary. Corrected; the rule the
   paragraph meant (a record that carries more than one type grows a union for its own
   reader) is untouched and correct.

5. **THE PHASE IS FIVE TEMPLATES AND TWO FORMS, AND BOTH PUBLISHED COUNTS ARE WRONG IN
   BOTH HALVES.** The spec says "four templates, four forms". Task 2 corrected that to
   "four templates and THREE forms, because this one has none" — which fixed one number
   with another wrong one and left the first alone. Counted off the shipped tree:

   - **Templates the phase seeds: five.** 0017 one (`meeting_summary`), 0019 three
     (`letter`, `nda`, `mutual_nda`), 0020 one (`project_status_report`). The spec's
     "four" comes from its own table, which collapses the NDA pair into one row — but
     they are two types with two `document_templates` rows and two different bodies,
     because 0019's whole reason for one detail table is that what separates them is
     wording.
   - **Forms the phase adds: two.** `LetterForm` and `AgreementForm` in
     `components/record-documents.tsx`, and nothing else — `AgreementForm` serves both
     NDAs (same fields, different `type`), the summary has none, and the status report
     has none. Three BUTTONS, two forms.

   So: five templates, two forms, six types in total once the quote is counted.

6. **`documents_type_valid` IS NOW LOGICALLY IMPLIED BY
   `documents_entity_matches_type`.** Every arm of the new CHECK names a known type, so
   any unknown type satisfies none of them and is refused there too. The two constraints
   are both violated by the same row and PostgreSQL names whichever it reaches first, so
   **`documents_type_valid` can no longer be probed by name through an INSERT**. It is
   emphatically not redundant — it states the rule directly, `document_templates` mirrors
   it, and a future type could legitimately relax the entity rule without relaxing the
   type list — but its test is now a `pg_get_constraintdef` read compared against
   `documentTypeSchema`, which is a better assertion than the INSERT it replaces.

7. **A DOCUMENT'S PDF MAY BE FILED AGAINST A DIFFERENT RECORD FROM THE DOCUMENT, AND
   0020 DOES NOT CLOSE THAT.** `documents.file_id` is a plain foreign key: nothing ties
   the `files` row's record to the `documents` row's, so a status report on project X
   pointing at a `files` row on deal Y is storable. Every writer gets it right (they
   pass the same `target` to `attachFile` and to the INSERT) and no test could tell the
   difference today. **A CHECK cannot express it** — it is a rule about two rows in two
   tables — so closing it means a second trigger, alongside
   `conduit_document_frozen_guard`. **Reported, not built:** it is the neighbouring hole
   to the one this task was asked to close, and it is a different mechanism.

8. **AN UNHANDLED `EPIPE` IN `services/restore.ts`, SURFACED BY THIS TASK'S EXTRA
   LOAD.** The full suite reported `Errors 1 error` while exiting **0** — the failure
   mode this project keeps finding. `proveArchiveOpens` writes the passphrase to 7z's
   stdin with no `error` listener on the stream (`child.on("error")` does not catch
   it), so when 7z exits before reading — which it does on the truncated archive the
   "refuses a truncated one" test builds — the write lands on a closed pipe. It did NOT
   reproduce in three consecutive isolated runs of `restore.test.ts`, so it is
   timing-dependent and this task's extra test file is what shifted the timing.
   **Reported, not fixed**: it is a one-line change in the most safety-critical path in
   the product and it wants a test that forces the race.

9. **`e2e/mobile.spec.ts`'s 320px OVERFLOW SWEEP COVERS TWO OF THE FOUR DETAIL PAGES,
   AND NONE OF SETTINGS.** "does not cut a long name or email off the screen" sweeps
   the CONTACT and the DEAL pages. The company page has carried a Documents section
   since Task 3, the project page has one now, and Settings → Templates has had a
   tab strip since Task 2 — none of the three is in the sweep. Two layouts were fixed
   here by REASONING where the swept pages have a measurement, and both are marked as
   such in the code: the project section's header takes `max-md:flex-wrap` (the same
   fix the project page's own header carries, for a longer button label), and the
   template tab strip takes `flex-wrap` because six labels are wider than a phone and
   that strip — unlike the record rail's — has no `overflow-x-auto` to scroll inside.
   **It was already the wrong shape at five tabs**, so the fix is the wrap rather than
   one fewer word.

10. **`listTasks`' ORDERING COMMENT DESCRIBES THE OPPOSITE OF WHAT ITS QUERY DOES, AND
    THIS TASK'S OWN REASONING DEPENDED ON WHICH WAY ROUND IT IS.** `services/tasks.ts`
    said `ORDER BY parent_task_id, position` "groups every top-level task
    (parent_task_id NULL) together, then each parent's children together" — roots
    first. **Measured on the dev server**: `SELECT x FROM (VALUES (2),(NULL),(1)) t(x)
    ORDER BY x ASC` gives `1, 2, NULL`, so NULLS LAST puts the ROOTS last and the
    children first. Nothing depends on it (the board and the drawer regroup, and
    `tasks.test.ts`'s ordering test carefully asserts only contiguity) — but the status
    report rejected that ordering for its printed table on exactly the property the
    comment got wrong, so a reader checking the rejection would have found the
    comment contradicting it. Corrected, with the measurement in it.

11. **`doc/DESCRIPTION.md` STILL SAYS "quotes rendered to PDF from your own
    templates".** That is the YunoHost catalogue's description of the product, and
    after this phase it names one of six document types. Tasks 2 and 3 both left it and
    so does this one, deliberately: it is release copy, v1.8.0 is not released, and the
    sentence becomes wrong at the release rather than now — so it belongs in whatever
    change cuts the release, worded by whoever is presenting the product, rather than
    half-updated by a task. **Flagged so it is not missed a fourth time.**

12. **THE STATUS LABELS LIVED IN `packages/web`, UNDER A COMMENT SAYING THEY MUST LIVE
    IN ONE PLACE.** `task-board.tsx`: "so a status/type's wording only ever lives in one
    place" — and `project-detail.tsx` had a private copy of the project's. The status
    report prints both into a PDF from the server, which is the first reader outside a
    browser, so `TASK_STATUS_LABEL` and `PROJECT_STATUS_LABEL` moved to
    `@conduit/shared`. `task-board.tsx` re-exports its one under the old name, so
    nothing that imported `STATUS_LABEL` changed.

### Mutation evidence

**65 distinct mutations, 77 runs over three passes. 58 killed by tests, 3 by typecheck,
2 green by design (the two calibrations), 2 green with reasons.** Run on an isolated
remote directory and database against `schema.test.ts`, `documents-report.test.ts`,
`documents-letter.test.ts`, `documents-summary.test.ts`, `documents.test.ts`,
`documents-seed.test.ts`, `export.test.ts`, `routes.test.ts`, `scheduling.test.ts`
(added for the second pass) and `shared/index.test.ts` — 711 tests at the first pass,
753 at the third.

**FIVE SURVIVED THE FIRST PASS AND ALL FIVE ARE NOW CLOSED**; two more first-pass
survivors turned out to be artefacts of the harness rather than gaps, and one first-pass
KILL turned out to be a flake.

**THE HARNESS WAS CALIBRATED IN BOTH DIRECTIONS BEFORE ANY OF IT COUNTED, AND ITS
VERDICT IS AN EXIT STATUS RATHER THAN A GREP.** M00 changes only a comment and must
report GREEN; it did (710 passed, 0 failed). M01 makes `buildStatusReportContext` report
a task count of zero and must report RED; it did.

**Task 3's `| tail` BUG IS WHY THE VERDICT IS AN EXIT STATUS.** Its harness ended the
remote command with `| tail -6`, so the status was TAIL's — always 0 — and a mutation
that stopped the suite from STARTING printed no "Tests … failed" line and scored
SURVIVED. `set -o pipefail` runs inside the remote command here and the harness reads
`returncode != 0`; nothing greps the output for a verdict.

#### AND THE HARNESS STILL HAD THREE DEFECTS OF ITS OWN, ALL FOUND BY ITS OWN OUTPUT

Recorded first, because every count below depends on them and each was invisible in a
green-looking result.

1. **A FALSE KILL, FROM AN INTERMITTENT — AND IT WAS CAUGHT ONLY BECAUSE THE PREDICTION
   WAS WRITTEN DOWN FIRST.** M41 removes `listProjectDocuments`' `eq(type,
   'project_status_report')`, which the code comment and this plan both say is
   unexercisable after 0020. The first pass scored it **KILLED (1 failed)**. Re-run
   twice with the same mutation applied: **710 passed, 0 failed, both times.** The kill
   was an unrelated flake in the 711-test set. A survivor that had been predicted to
   die would have been investigated; a KILL that agrees with nothing was only
   investigated because it contradicted a claim already in the source. **Verdicts here
   are one run each, so any of them could be a false kill; the ones that matter are the
   ones somebody predicted.**
2. **THE FIRST PASS MUTATED A FILE WHOSE OWN SUITE IT DID NOT RUN.** `taskOutlineOrder`
   lives in `services/scheduling.ts` and is shared with `ganttPayload`; the test set had
   no `scheduling.test.ts` in it, so M55 and M56 scored SURVIVED against a set that
   could not see the function's other caller. That is an artefact of the instrument,
   not a gap in the tests, and the second pass adds the file.
3. **A TYPECHECK-VERDICT MUTATION POISONS THE INCREMENTAL BUILD, AND THE POISONING
   OUTLIVES THE RESTORE.** `npm run typecheck` runs `tsc -b`, which emits `.d.ts` into
   `packages/*/dist` and stamps a `.tsbuildinfo` claiming it current. M22 (removing
   `statusReportSchema.projectId`) therefore left a stale declaration behind, and the
   next typecheck — on fully restored source — reported an error against a line that
   was demonstrably correct. **The consequence for the scoring is worse than the
   nuisance:** M57 ran after M22 and would have failed typecheck whatever it did to its
   own file, so its KILLED-BY-TYPECHECK verdict was not about M57. All three typecheck
   mutations are re-run in the second pass with the build state cleared first, and all
   three are genuinely red.

#### FIVE SURVIVORS FROM THE FIRST PASS, AND WHAT CLOSED EACH

| survivor | why it survived | what closed it |
|---|---|---|
| the report uses `listTasks`' ordering instead of the Gantt's outline order | **the assertion could not fail.** It searched the merged page for `>Design` and `>Design sketches` — and the first is a PREFIX of the second, so both `indexOf` calls returned whichever row came first. Under the mutation the four positions collapsed to two ascending pairs and the test passed | titles that are not prefixes of each other, a match CLOSED on the cell (`>Framing<`), and an explicit assertion that a ROOT precedes another root's child — which is exactly what `listTasks`' NULLS-LAST ordering reverses |
| the assignee prefers the username to the full name | the only name reaching a printed page was the project OWNER, who was the same user, and `issueStatusReport` builds that from a different expression the mutation did not touch. "Chris Wilson" appeared either way | a second user assigned to a task, whose username (`jsmith`) is not a substring of their full name, and an assertion that the username appears NOWHERE on the page |
| `PROJECT_STATUS_LABEL` loses its capitals | the assertion was `toBe(PROJECT_STATUS_LABEL.active)` — the value under test compared with itself. `db/schema.test.ts`'s `documentValues` had written this rule down already ("a fixture that asked the code under test what to expect could never disagree with it") and this was the same mistake one file over | the words spelled as literals, both of them, plus one assertion pinning the constant so the two really are one string |
| the filename stops truncating a long project name | every test used a short project name, so the `slice` was unreachable from the suite | a 280-character project name, asserted as a prefix AND as a length AND as under the export's 180-byte member limit — three, because an expectation built from the same `slice` would agree with an off-by-one |
| `taskOutlineOrder` stops ordering siblings by position (found in the second pass, as a failed RED calibration) | **every ordering test in the codebase gave each parent exactly ONE child** — this file's and `scheduling.test.ts`'s alike. The clause has been in `ganttPayload` since Phase 3 and nothing could tell if it stopped | two children of one parent, asserted in position order. **The gap was not this task's code**; the report is what put a second reader on a shared function and made it visible |

#### TWO ARE GREEN AND STAY GREEN, WITH REASONS

1. **`undatedCount` counting `startDate === null` instead of `dueDate === null` is an
   EQUIVALENT MUTANT, and it is equivalent because of a CHECK rather than by accident.**
   `tasks_dates_paired` admits both dates null or both set, never one, so the two
   spellings ask the same question of every storable row. `dueDate` stays because it is
   the half the OVERDUE rule turns on: "undated" then means exactly "not a task the
   Overdue count could ever have included", which is the sentence the two counts are
   printed side by side to make.
2. **`listProjectDocuments` dropping its `eq(type, 'project_status_report')` is green,
   and that is `documents_entity_matches_type` working.** After 0020 a project can carry
   no other type, from any writer including a psql session, so no test can build a row
   the predicate would filter. The predicate stays: it is what makes
   `toStatusReportRecord`'s literal `type` a fact rather than an assumption, and the day
   a second project-attached type exists — which means widening that CHECK — this
   function keeps meaning what its name says. **`redraftLetter`'s "attached to neither a
   company nor a contact" branch and `listMeetingSummaries`' type filter are green for
   the same reason and stay for the same reason**; both were reachable before 0020 and
   are not now, and both are recorded as such in their own files rather than left as
   silent survivors.

#### EVERYTHING ELSE, IN GROUPS

**The entity CHECK, which is what this task was asked to close (7, all killed):** the
constraint admitting everything; each of the four arms widened to admit any record; the
letter family narrowed to companies only; **and the letter arm spelled as the plan
sketched it** — `num_nonnulls(company_id, contact_id) = 1` — which is caught by
`documents_exactly_one_entity` no longer being nameable for the both-set case.

**The migration (8):** either type CHECK not widened; the index not built; the template
seeded under a misspelt type; the template misspelling a count, losing its
empty-project row, or losing the per-task dependency line; **the journal `when` put back
to what drizzle-kit generated**.

**@conduit/shared's per-type rules (7):** `documentTypeFreezes` and
`documentTypeNumbered` each flipped for the report; both status label maps altered, one
of them with its two words swapped; the enum losing the member and
`statusReportSchema` losing its `projectId` (both **typecheck**).

**The counts and the overdue rule (6):** overdue counting a task due TODAY, a DONE task,
or an UNDATED one; `doneCount` counting the wrong status; a null progress printing `0%`;
`undatedCount`'s equivalent spelling (green, above).

**The read (7):** archived tasks listed; `ganttPayload`'s date filter adopted, dropping
undated tasks; `listTasks`' ordering; the dependency read following the edge backwards;
the assignee's precedence; predecessor names run together with no separator; an
unassigned task printing a placeholder.

**The writer (10):** `frozen` hardcoded true; the issue date read in UTC rather than the
organisation's zone; the archived refusal removed; the filename losing its date, losing
its truncation, or truncating one character short; the size refusal losing the task
count or calling the document a quote; the PDF filed against nothing, and against the
wrong kind of record.

**The reader and the routes (5):** `listProjectDocuments` ordered oldest-first, ignoring
which project it was asked about, or losing its type predicate (green, above); the
project's GET and POST routes never registered.

**The rollup (4):** the flag ignored; the flag always on (which is what protects Task 3's
asserted separation); the subquery pulling in every contact rather than this company's;
the route coercing the query parameter so `?includeContacts=false` turns it ON.

**The export (2):** `documents.csv` blanking the project name, and losing the project
pair entirely.

**The shared ordering (4):** `taskOutlineOrder` losing its COALESCE, losing its
root-before-children clause, losing its sibling order, and reversing it.

**The merge context and the template reader (2):** `MergeContext` losing its `tasks`
collection (**typecheck**); the report's template migration misrecorded in
`test/seed-template.ts`.

### Counts

Unit suite **4097 passed / 48 skipped in 102 files**, against **4065 / 48 in 101** at
Task 3's tip: **+32 tests, +1 file**
(`packages/api/src/services/documents-report.test.ts`, 22 tests). `npm run typecheck`
clean. Run on an isolated remote directory and database, both removed afterwards —
`/home/chris/conduit` is shared and the suite's advisory lock is cluster-wide.

**ONE RUN REPORTED `Errors 1 error` WHILE EXITING 0, AND IT WAS NOT THIS TASK'S CODE**
— see finding 8. It has not recurred since; the run recorded here is clean.

**NO NEW e2e SPEC**, which is Task 3's decision repeated and is worth naming rather
than leaving as an absence: this type's surfaces are one section on one page with one
button and no form, the four e2e specs that touch document surfaces all measure the
DEAL's, and the two 320px sweeps do not cover the project page either way (finding 9).
An e2e spec written here would be written blind — the whole suite runs in CI — so the
push is what proves it rather than a local guess.

CI green on the first push: **4142 passed / 3 skipped in 102 files** for the unit job
(the runner has WeasyPrint and 7-Zip, so 45 of the dev server's 48 skips run there) and
**257 passed** for the e2e job. **No e2e regression, and the e2e count is unchanged from
Task 3's** — which is the measurement behind the paragraph above: the new section, the
sixth Settings tab and the rollup checkbox are all additions to pages the existing specs
already walk, and none of them moved anything those specs assert.

---

## Definition of done

- Four types produce a PDF from a record, through the existing renderer.
- **Existing quotes unchanged, still open, still render** — proven against a pre-migration fixture.
- Quote and NDA refuse to change after issue; summary, letter and status report do not.
- A record's Documents tab lists every type attached to it.
- Full unit and e2e green, counts accounted for.

---

## Explicitly NOT in this phase

- **Phase 10** (time tracking), and **Phase 8's Graph deferral** — unchanged.
- **Proposals.** Ruled out on 30 Aug: written in Word, more detailed than a merge-field template
  should attempt, and already attachable as a file.
- **`tasks.spec.ts:466`**, the 1-in-406 intermittent whose mechanism is recorded as not
  established. It stays that way until it fires with a trace.
