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

- [ ] The whole content is a `meetings` row: title, date, attendees, notes. **The notes are
      already TipTap HTML**, so they go through the existing sanitiser rather than a new path.
- [ ] **No extra input at all**, which makes this the type that proves the model without a form
      confusing the picture. Build it first for that reason.
- [ ] **Not frozen** (Chris's decision) and **almost certainly wants no number** — `QUO-2026-0001`
      suits a quote and suits this not at all. Decide and say why.

## Task 3: The letter, and the NDA pair

- [ ] **Letter**: a company or contact, plus a rich-text body the user types. Reuses the composer
      and the sanitiser. **Not frozen** — it wants redrafting before it goes.
- [ ] **NDA and mutual NDA**: a company or contact, plus effective date, term and jurisdiction.
      **FROZEN on issue**, with the quote's guard — an agreement you can silently edit after
      sending is a different kind of document.
- [ ] **"Exactly one" will be tested here.** An NDA names a contact at a company; the spec says it
      attaches to the **company** and names the contact in its content. **If that turns out wrong
      in practice, report it — do not quietly widen the CHECK.** It is Chris's decision and
      reopening it is his call.

## Task 4: Project status report — the broadest source, and the schedule risk

- [ ] Content is a `projects` row plus its tasks, dates and Gantt state. **This is the one most
      likely to be larger than it looks**, and the spec says so.
- [ ] **Possibly a date range**, which no other type needs. Establish whether it is required
      before building a form for it.
- [ ] **Not frozen** — you regenerate it next month, and a stale report is worse than an edited
      one.
- [ ] **If this turns out to be a phase of its own, say so and stop.** Three types shipped and one
      reported is a better outcome than four types half-built.

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
