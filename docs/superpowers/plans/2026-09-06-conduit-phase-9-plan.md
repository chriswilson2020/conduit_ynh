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

- [ ] **Read `schema.ts` before believing this plan.** `documents` carries `currency`,
      `subtotal_cents`, `tax_cents`, `total_cents`, `recipient_name` — all `NOT NULL` — plus
      `valid_until_date` and `deal_id NOT NULL`. Five shapes cannot live in that.
- [ ] **A common table plus per-type detail.** `documents` keeps identity, type, rendered file,
      issue date, issuer, attachment and frozen-ness. The quote's money columns move to
      `document_quotes`.
- [ ] **The FK set widens to five** — company, contact, deal, project, meeting — with
      `num_nonnulls(...) = 1`. **Copy `notes`/`files`' CHECK rather than inventing one**; it is
      the same rule and the codebase already enforces it in two places.
- [ ] **THE MIGRATION MOVES CHRIS'S LIVE QUOTES.** Highest-consequence item in the phase.
      **Prove existing rows survive with a fixture written by the PRE-migration code**, committed,
      and read by the new schema — a round trip through the new code proves only that the new code
      agrees with itself. That is v1.7.0's credential-union lesson and it is not optional.
- [ ] **Existing quotes must still open and still render.** The rendered PDFs are
      content-addressed and must not be re-rendered to survive.

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
