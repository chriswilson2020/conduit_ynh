# Conduit Phase 9 — four more document types

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.8.0.
**Predecessor:** v1.7.2, shipped 6 Sep.

---

## The four, and why these four

**Meeting summary, project status report, NDA and mutual NDA, and a plain letter on the
letterhead.** Agreed 30 Aug against the test the scope decision implies: **a document belongs
here when Conduit already holds its content in structured form.** That is why proposals were
excluded — they are written in Word, are far more detailed than a merge-field template should
attempt, and already attach to a deal as a file.

They are not four variations on the quote. Between them they exercise three different content
sources, which is the phase's real shape:

| Type | Source of content | Extra input |
|---|---|---|
| Meeting summary | a `meetings` row — title, date, attendees, notes (already TipTap HTML) | none |
| Project status report | a `projects` row plus its tasks, dates and Gantt state | possibly a date range |
| NDA / mutual NDA | a company and/or contact | effective date, term, jurisdiction |
| Letter | a company and/or contact | a rich-text body the user types |

So a document type is **(a source of structured data) + (a form for what the CRM does not know)
+ (a template)**. The quote is deal + line-item form + template.

---

## THE FINDING THAT SHAPES THE PHASE: `documents` is not a document table

The backlog warns that `documents.deal_id` is `NOT NULL` and the FK model has to widen. **That
is the small half.** Read out of `schema.ts`: the table also carries `currency`,
`subtotal_cents`, `tax_cents`, `total_cents` and `recipient_name` — all `NOT NULL` — plus
`valid_until_date`.

**A meeting summary has no currency. A letter has no total.** `documents` is a quote table
wearing a generic name, and every one of those `NOT NULL`s is a promise the four new types
cannot keep.

### The recommendation: a common table plus per-type detail

**What is genuinely common to all five**: the identity, the type, the rendered file, the issue
date, who issued it, what it is attached to, and whether it is frozen. **Everything else is
type-specific**, and the quote's five money columns are the proof.

So `documents` keeps the common part, and each type that needs more gets its own detail table —
`document_quotes` first, carrying the columns that move out of `documents`.

**Rejected, with reasons, because the cheap option is genuinely tempting:**

- **Make the quote columns nullable and add more.** One table, no join, smallest migration. Rejected
  because it deletes every guarantee at once: `currency NOT NULL` becomes "currency, sometimes",
  and nothing then prevents a meeting summary with a tax total. The table would carry five shapes
  and enforce none, and this codebase's habit is the opposite — three different `num_nonnulls`
  CHECKs on one family of columns, because the rule is worth stating.
- **A JSON payload per type.** Flexible and quick. Rejected because it moves validation out of the
  database into whichever reader remembers, and because the money columns are queried — a
  document list showing totals would have to unpack JSON per row.
- **A table per type, no common table.** Honest about the differences, but there is a real common
  surface — a record's Documents tab lists all types together — and five tables with no shared
  parent make that a five-way union in every reader.

**The migration moves existing quote rows into `document_quotes`.** That is real data on Chris's
install, so it is the highest-consequence item in the phase and it is the same discipline
v1.7.0's credential union used: **prove the old rows survive with a fixture written before the
change, not by the new code's own writer.**

---

## Chris's two decisions, 6 Sep

### 1. Freezing is PER TYPE, not universal

Phase 7 made an issued document immutable, and that is right for a quote: you sent somebody a
price and must be able to prove what you sent. **Treating it as a property of documents in
general would make three of these four annoying to use.**

- **Quote and NDA freeze on issue.** Both are handed to someone else, and an agreement you can
  silently edit after sending is a different kind of document from one you cannot.
- **Meeting summary, status report and letter stay editable.** A stale status report is worse than
  an edited one; a letter wants redrafting before it goes.

**Each type declares its own rule.** The machinery already permits either — this is a per-type
flag and the guard that reads it, not a new mechanism.

### 2. A document belongs to EXACTLY ONE thing

`num_nonnulls(...) = 1`, the rule `notes` and `files` already use — so it is a pattern the
codebase enforces rather than a new one, and the CHECK is copied rather than invented.

**The FK set widens to five**: company, contact, deal, project, meeting. A quote is of a deal, a
summary of a meeting, a report of a project, an NDA of a company. **An NDA naming a contact at a
company attaches to the company and names the contact in its content** — that was the trade
against "at least one", and it is Chris's call.

---

## What is reused unchanged, and it is most of the cost

**Everything hardened in Phase 7 and v1.0.1**: the renderer with its three file-read controls and
kernel memory ceiling, the sanitiser, the merge engine with `{{#path}}` conditional blocks,
content-addressed storage, and the seeded-template migration pattern. **The expensive parts are
done.** This phase is a data model, four templates, four forms, and the per-type rules.

---

## Numbering is per type, and not every type wants one

Numbering is already per type per year and generalises. But `QUO-2026-0001` suits a quote and
probably suits nothing else here — **whether an NDA or a letter wants a sequence at all is a
per-type decision**, and the machinery already permits either. A meeting summary almost certainly
does not.

---

## Definition of done

- All four types produce a PDF from a record, with the existing renderer.
- **Existing quotes are unchanged and still open** — proven against a row written before the
  migration, not by the new code.
- Quote and NDA refuse to change after issue; the other three can be edited or regenerated.
- A record's Documents tab lists every type attached to it.
- Full unit and e2e green.

---

## Risks

1. **The migration moves live quote data.** Highest-consequence item; mitigated the way the
   credential union was.
2. **Four templates is four content problems, not one.** The status report's source is the
   broadest — a project's tasks, dates and Gantt state — and is the one most likely to turn out
   larger than it looks. If it does, that is a finding to report, not to absorb silently.
3. **"Exactly one" will be tested by the NDA.** If it turns out an NDA genuinely needs both a
   company and a contact as owners rather than one owner and a named party, that is Chris's
   decision reopened, and it should be reported rather than worked around.
4. **Per-type freezing is a new axis in a guard that currently has none.** The rule that an issued
   document never changes is currently unconditional; making it conditional is where a mistake
   would let a quote be edited.
