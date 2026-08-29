# Conduit Phase 7 — Documents (quotes) → v1.0.0

## Context

The roadmap has carried this since 18 August, where it was the original "Phase 5":
merge-field templates rendered to PDF via WeasyPrint, chosen over shipping Chromium.

**The "roughly 40MB" the original design cited is wrong, and Task 1 measured the real
figures on the server.** `apt-get install weasyprint` on Debian 12 pulls 69 packages and
**508MB installed**, because `python3-fonttools` depends on the alternative
`python3-scipy | python3-munkres` and apt takes the first, which drags `g++`, `g++-12`,
`libboost1.74-dev` and `libopenblas-dev` onto a CRM server. Naming the second alternative
explicitly gives the same renderer in 39 packages and **89MB**, with no C++ toolchain.
The install is therefore `python3-munkres weasyprint`. **Co-presence in the install set
is what matters, not word order** — an earlier draft of this paragraph said the order was
load-bearing, and all four orderings measure 39 packages. YunoHost never runs that
command line anyway: `AptDependenciesAppResource` splits `packages` on commas and
generates a `${app}-ynh-deps` metapackage, so both names simply have to appear in it.

It is the last capability that makes someone
leave Conduit to finish a job: the CRM knows the deal, the company and the contact, and
then you go and write the quote somewhere else.

Ships as **v1.0.0**. That is a deliberate claim rather than a version increment: with
documents in place, Conduit does the whole loop — find the company, work the deal, send
the quote, keep the record.

Decisions taken with Chris in the Phase 7 brainstorm:

| Decision | Choice |
|---|---|
| First document type | **Quote.** Proposal and invoice reuse the machinery later. |
| Pricing | **Line items on the document.** Description, quantity, unit price, tax rate. No products catalogue; the deal record is untouched. |
| Templates | **One editable template per type**, HTML with merge fields, edited in Settings like email templates. |
| Numbering | **Per type, per year** — `QUO-2026-0001`, resetting each January. |

Four decisions taken by the coordinator while writing this, each flagged for objection:

| Decision | Reasoning |
|---|---|
| **A generated document is immutable.** | A quote you have sent must not change because someone edited the deal. Editing the deal afterwards leaves the PDF alone. A corrected quote is a new quote with a new number. |
| **No draft state.** | You fill the form and generate. A half-finished quote is a form you have not submitted, not a row in the database. This removes a status column, a lifecycle, and every question about what a draft's number is. |
| **The document snapshots its recipient.** | Company and contact details are copied onto the document at issue. Companies get renamed and move offices; a quote must keep saying what it said. |
| **The PDF is the artifact; the row is the record.** | The stored PDF is authoritative. The `documents` row records what was on it so the app can list and total without re-rendering. Re-rendering an old document from a since-edited template would NOT reproduce it byte for byte, and is not offered. |

## Definition of done (the scope rule, and it is testable)

**A quote raised from a deal is a numbered, branded PDF on that deal's record, and a
quote already issued never changes.**

Three things follow, and each is a test rather than an intention:

- Raising a quote produces a PDF in the deal's Files, a `documents` row, and a number
  that no other document has.
- Editing the deal, the company or the template afterwards changes nothing about an
  already-issued quote — not its PDF, not its stored totals, not its recipient details.
- Every surface this phase adds works on a phone, because v0.10.0 made that the
  standard for the whole app rather than a phase's ambition. The line-item editor is
  the hard case and is named as such.

## Mechanism

**Four parts, each independently testable, and one of them is a subprocess.**

### Rendering is a subprocess, not a library

WeasyPrint is Python. The API spawns it, writes merged HTML to stdin, reads PDF from
stdout. No Python runtime is embedded, no browser is shipped, and nothing about the
Node process changes.

Two properties are requirements, not defaults:

- **The renderer fetches nothing but `data:`, enforced by a URL fetcher — and the API
  is invoked, not the CLI, because that is the only way to say so.** Every asset — the
  logo above all — is inlined as a `data:` URI before the HTML reaches WeasyPrint.

  **Two earlier drafts of this bullet were wrong, and both were disproved on the target
  rather than argued about.** The first claimed omitting `--base-url` prevented fetches:
  a base URL only governs what RELATIVE references resolve against, and a bare
  `weasyprint` with none set fetched both an `<img>` and a `<link rel=stylesheet>` from a
  loopback server that records who asks it for anything. The second claimed the child's
  proxy variables were sufficient: they are not, because `file://` never consults a
  proxy. `default_url_fetcher` hands every absolute URI to `urllib.urlopen`, whose opener
  carries `FileHandler`, and WeasyPrint embeds `<link rel=attachment>` targets into the
  PDF's `/EmbeddedFiles`. Under the shipped proxy settings, `file:///etc/passwd` exited 0
  and came back out of the PDF byte for byte — which on a real deployment is
  `$DATA_DIR/mail.key`, readable by the user the API runs as, and with it every stored
  IMAP and SMTP password.

  The property is therefore enforced where it can be, and it takes **three** controls
  rather than one — the third and fourth drafts of this bullet both had to be corrected
  by evidence too. `documents-render.ts` spawns `python3` with WeasyPrint's API and:

  1. a **`url_fetcher` that allowlists `data:`** and raises on every other scheme;
  2. **`rel=attachment` deleted from the parsed tree** before rendering, because control
     1 does not reach attachments on every version — 61.1's `Attachment.__init__` binds
     the DEFAULT fetcher as a default argument, so the document's fetcher never arrives
     and the file is read with no fetcher call recorded at all;
  3. **the finished PDF refused if it embeds any file**, the only one of the three that
     is a statement about the output rather than a mechanism, and so the only one that
     would survive a future WeasyPrint growing a new route to the filesystem. It looks
     for `/EF` and `/Filespec`, NOT `/EmbeddedFiles` — the latter is a catalog name tree
     that `<link rel=attachment>` registers in and `<a rel=attachment>` does not, so it
     misses half the vector. It lives in TypeScript rather than in the render script,
     because as Python it was reachable only through a subprocess behind the other two
     controls and nothing ever fed it the payload that exposed the wrong needle.

  A blocked resource fails the render rather than degrading quietly — at that point
  either the document is an attack or Task 3's sanitiser has a hole, and both deserve an
  alarm. The proxy variables stay as a cheap second barrier for http(s), explicitly not
  as the control. Tested per scheme on both 57.2 and 61.1 — `file://` through five
  elements, `http://`, `ftp://`, `jar:` — because "tested one scheme and generalised" is
  exactly how the earlier drafts survived. Task 3's sanitiser still strips remote URLs:
  that is the braces to this belt.

  **Reads are asserted by atime, not by watching a loopback server.** The proxy
  variables stop an http request before it could arrive, so a "no request reached my
  server" assertion is vacuous — a fetcher mutated to read the file anyway passed every
  one of them. atime sees an `open` by any code path.

  **The transferable lesson, since Task 3 faces the same shape of problem:** every claim
  in this bullet that was wrong was wrong because it named a MECHANISM and tested that.
  The ones that held were properties — "the file was never opened", "the file is not in
  the output" — observed directly, and each confirmed by a mutant that fails them.
- **A timeout, an output cap and — the one that actually bounds cost — an INPUT cap.**
  A render that hangs, is fed an implausible document, or produces one, fails cleanly
  and leaves no `files` row and no number allocated. **The timeout cannot bound memory**,
  because the expensive documents are the ones fast enough to survive it: a 256KB table
  renders in 9.8s, inside any sane timeout, and costs 251MB on a server with no swap.
  The input cap is 128KB, which holds a render to ~157MB and is what makes the declared
  `ram.runtime` and Task 4's concurrency limit true.

  **Both figures in that last sentence are superseded.** Phase 7's own review re-measured
  128KB at 332MB (the shape matters more than the size: minimal table rows, not prose),
  and v1.0.1 re-ran the same measurement at **345MB**. The cap itself is gone: there are
  two now — 87,357 bytes of markup, which is what a render's memory actually tracks, and
  409,623 bytes of `data:` image payload, which cannot carry a table row. See the logo
  section below.

**This is the phase's deployment risk and it must be proved first.** WeasyPrint is an
apt dependency in `manifest.toml`; it is the first release since v0.6.0 whose upgrade is
not a pure application change. Task 1 proves the binary runs on the actual server and
produces a PDF before any feature work depends on it. If it cannot be made to work
there, that is a finding that reshapes the phase, and it is much cheaper on day one.

### Numbering is a table row, and that is the whole trick

`document_number_sequences` is keyed `(type, year)` and allocated with a single
`INSERT ... ON CONFLICT DO UPDATE SET last_value = last_value + 1 RETURNING`, so two
quotes raised at the same instant cannot take the same number.

**It is deliberately NOT a Postgres sequence, and the reason is gaps.** The number has
to be printed on the PDF, so it must be allocated before rendering — but a render that
then fails would burn it, and a quote numbering sequence with holes invites the question
of what was in the hole. A real `SEQUENCE` cannot help here: `nextval` is explicitly
non-transactional and a rollback does not give the number back. A table row does roll
back. So the whole operation — allocate, render, write the file, insert the document —
runs in ONE transaction, and a failed render leaves no number spent, no `files` row and
no document.

The cost is honest and acceptable: the transaction is open across a subprocess call, and
the `ON CONFLICT` update holds a row lock on that `(type, year)` row, so two quotes of
the same type in the same year serialise. That is bounded by the render timeout, and
serialising the allocation of consecutive numbers is what you want anyway.

### Templates are HTML with merge fields, and NOT the mail sanitiser's profile

Document templates are edited in Settings with the same editor as email templates. They
are **not** sanitised with the same profile, and this is called out because reusing it
would be the obvious wrong move: the mail profile exists to defang HTML written by
strangers, and it strips exactly the CSS that page layout depends on.

The document profile is wider on purpose, and defensible for a different reason:
documents are authored by authenticated users of this CRM, rendered offline with no
network, and never shown in a browser context that carries a session. "Wider than mail"
is not the same as "unfiltered". Concretely it must ALLOW `<style>` blocks and `style`
attributes, tables and their layout properties, page-level CSS (`@page`, margins,
running headers) and `<img>` with `data:` sources; and it must STRIP script in every
form (elements, `on*` handlers, `javascript:` URLs), embedded and object elements, and
**every URL in every attribute except `data:` and a bare `#fragment`** — in CSS `url()`,
`@import` and `@font-face src` as well as in attributes — plus `rel=attachment` on both
`<link>` and `<a>`.

**That sentence originally read "any remote URL", and it was wrong in the way that
matters.** `file:` is not remote, and `file:` is the scheme that actually worked against
this codebase: Task 1's review recovered a 32-byte mode-600 key byte-for-byte through
`<link rel="attachment" href="file:///...">`. An implementer who reads "remote" and
implements it literally rebuilds the hole. The rule is an allowlist of `data:`, not a
denylist of remote schemes.

Two consequences worth stating rather than discovering. `mailto:` and `tel:` are refused
by that allowlist — a deliberate, deferred capability loss taken for minimality, since
Task 3 proved no `href` of any scheme is ever fetched. And the sanitiser is the **only**
control for an `href`: an href is never fetched, so the renderer has no opinion about it,
but WeasyPrint writes it into the PDF as a link annotation.

This is what enforces the no-network property at the input rather than trusting the
renderer's flags alone — subject to the caveat that anything consuming this module's
output WITHOUT the renderer's own fetcher (an in-browser template preview, above all)
does not inherit the renderer's half of the guarantee. The profile is
unit-tested against each of those cases.

**An unknown merge field renders as empty and never throws.** A typo in a template is a
blank on a page, not a feature that stops working.

### The organisation profile is new, and the phase cannot ship without it

Conduit currently has nowhere to record **your own** company. A quote needs an issuer:
name, address, VAT and registration numbers, contact details, bank details, and a logo.
This is a settings singleton plus a logo upload, and it is small — but it is a real gap
found by reading the schema rather than assumed away, and every other part of the phase
depends on it.

**The logo upload must enforce a size limit, and Task 1's measurements set it.** The
logo reaches the renderer inlined as a `data:` URI at 4/3 of its stored size, and the
render input is capped at 128KB — a cap chosen because a TABLE-shaped document (which is
exactly what a quote is) costs about six times what prose costs at equal size: 128KB of
table is 5.2s and 157MB, while 2MB of table was 86s and 1.5GB. The timeout cannot bound
that, because the expensive documents are the ones fast enough to survive it. So a
stored logo much above 64KB cannot render at all, and the template and line items must
fit alongside it. **Task 5 bounds the upload well below that** — 32KB is the working
figure, leaving the document itself two thirds of the budget — and rejects an
oversized logo at upload time with a clear message, rather than letting it surface as a
failed render weeks later when someone raises a quote.

> **SUPERSEDED BY v1.0.1, AND THE PARAGRAPH ABOVE IS WHY IT HAD TO BE.** 32KB was too
> small for a real logo: flat-colour artwork on a large canvas lands around 300KB as a
> PNG and looks bad downscaled to fit. The reasoning above is sound and its conclusion
> followed from ONE premise that v1.0.1 removed — that the logo and the document's own
> text come out of a single render allowance. They no longer do. The renderer has two
> byte caps: 87,357 bytes of MARKUP (the template, the issuer's text and the quote's
> content, which are the same three allowances as before, summed) and 409,623 bytes of
> `data:` IMAGE PAYLOAD, which cannot contain a table row because the base64 alphabet
> has no `<` in it. `MAX_LOGO_BYTES` is 300KB and `DOCUMENT_CONTENT_BUDGET_BYTES` is
> unchanged at 66,688.
>
> **And a byte limit was never the bound that mattered.** A PNG's decoded raster is
> width × height × 4 whatever the file compressed to: measured on the server through
> the shipped `renderPdf`, a **12,227-byte** 1-bit PNG of 10,000 × 10,000 costs
> **535MB**, and 20,625 bytes of 13,000 × 13,000 costs **864MB** — the second of which
> fits inside `MAX_TEMPLATE_BYTES`, so v1.0.0's template editor could already reach it.
> v1.0.1 adds `MAX_LOGO_PIXELS` (16,000,000 — a 4000 × 4000 canvas), enforced at the
> upload AND at the renderer, where it also covers template-embedded images and logos
> stored before the gate existed. The numbers in the paragraph above are also stale as
> measurements: re-run by the same method, 128KB of dense table rows is **11.2s and
> 345MB**, not 5.2s and 157MB.
>
> **AND THE PIXEL BOUND NEEDED THE RENDERER'S HELP, WHICH THE SPEC REVIEW FOUND.** The
> first version of it recognised `data:image/(png|jpeg|gif|webp);base64,` and trusted
> the media type written there. WeasyPrint and Pillow trust neither — they sniff the
> bytes — so `data:image/bmp;base64,` in front of the same PNG, or capitals, or an
> empty type, or percent-encoding instead of base64, each charged **zero** pixels and
> rendered the 100-megapixel bomb at 534MB. The scanner now matches every `data:` URI
> and sniffs, and it cannot be a complete answer on its own: a **334-byte JPEG2000
> decodes to 36 megapixels**, so no per-byte charge can bound what an unidentifiable
> payload costs. The renderer's `url_fetcher` therefore allowlists the FORMAT as well
> as the scheme, refusing to decode anything that is not one of the four the bound can
> read — which also finishes this document's SVG exclusion, since an SVG embedded in a
> template was still being drawn as vector art until it existed.

## The work, surface by surface

### Data model (migration 0009)

- **`org_profile`** — a single row: display name, address lines, VAT and registration
  numbers, email, phone, website, bank details, and the logo **as a `data:` URI in a text
  column on this row** — NOT a `files` reference.

  **Corrected by Task 4, which found the logo unstorable as specified.** `files` carries
  `files_exactly_one_entity`, a CHECK requiring every row to belong to exactly one
  company, contact, deal or project. An issuer's logo belongs to none of them, so there
  was no legal `files` row for `logo_file_id` to point at. The two ways out were widening
  that CHECK to permit an orphan, or taking the logo out of `files` entirely.

  **Ruling: out of `files`.** The constraint is right — it says a file belongs to a
  record, which is what the Files tab means — and the logo is configuration rather than a
  record attachment; stored in `files` it would appear on no record's tab, which is
  exactly what the CHECK exists to prevent. Storing the `data:` URI directly also removes
  a read-and-encode step at render time, since the renderer accepts nothing else, and the
  32KB upload bound makes a blob store pointless for one small image. What is given up is
  sha256 dedup and streaming, neither of which means anything for a single logo.

  **v1.0.1 raised that bound to 300KB and the ruling still holds.** 300KB is 409,623
  characters in a `text` column, which Postgres stores out-of-line in TOAST and
  compresses; it is one row read on the path of a render that is about to spend seconds
  and hundreds of megabytes in a subprocess. Migration 0010 widens
  `org_profile_logo_size` from 43,715 to 409,623 characters.
- **`documents`** — number (unique), type, deal FK, currency, issue date, valid-until
  date, the recipient snapshot (name and address as text), subtotal/tax/total in cents,
  frozen notes and terms, the generated PDF's file id, who raised it, when.
- **`document_line_items`** — document FK, position, description, quantity, unit price
  in cents, tax rate, line total in cents.
- **`document_number_sequences`** — `(type, year)` → last value.
- **`document_templates`** — one row per type, HTML body, seeded with a working default
  in the migration so the feature works before anyone edits anything.

**Money and rounding are specified, not left to the implementer.** Amounts are integer
cents in `bigint`, as `deals.value_cents` already is. Quantity is `numeric(12,3)`. A line
total is `round(quantity × unit_price)` half-up; tax is computed per line and summed;
the subtotal is the sum of line totals. Stated here because off-by-one-cent totals are
the classic defect in this feature and the arithmetic is a pure function that can be
unit-tested to exhaustion.

### The deal record

A **Documents** section listing what has been raised — number, date, total, download —
and a **New quote** action opening a form: recipient (defaulted from the deal's company
and contact), dates, line items, notes and terms. Submitting renders and stores.

The PDF is an ordinary `files` row against the deal, so it also appears on the Files tab
with no new storage or download code.

### Settings

Two new panels: **Organisation** (the issuer profile and logo) and **Document
templates** (edit the quote template, with the merge fields documented on the page
rather than in a wiki nobody opens).

### The phone

Everything above meets the v0.10.0 standard. The line-item editor is the genuinely hard
surface — a table of description, quantity, price and tax is the exact shape that does
not fit 390px — and it becomes stacked cards with one field per line, an add-row action
that does not require aiming, and a running total that stays visible. The plan requires
a measurement of this at 390px before it is built, the way the Gantt's geometry was
measured in Phase 6.

## Out of scope (deferred, not rejected)

Invoices and proposals (same machinery, a later release); a products catalogue and deal
line items; e-signature; emailing the PDF directly from the composer (it is a stored
file, so Phase 4.4's attachment work reaches it); multi-currency conversion; VAT rules
by jurisdiction; credit notes; payment tracking; revisions and versioning beyond
"raise another one"; PDF/A archival profiles.

## Testing

- **Pure-lib unit tests** for the whole of the arithmetic (line totals, tax, subtotal,
  rounding at the half-cent), merge-field resolution including unknown and nested
  fields, the sanitiser profile, and number formatting.
- **Integration tests** for the render subprocess and the numbering allocation under
  concurrency, skipped when WeasyPrint is absent, so a developer without it still gets a
  green suite and CI still proves the path. **This is deliberately NOT quite the 36
  `MAIL_IT` tests' pattern**, which is an explicit opt-in and so fails loudly on a broken
  fixture: an auto-probing gate would skip silently if a packaging change stopped
  delivering the binary, and CI would stay green through it. The render suite therefore
  also asserts the binary is PRESENT whenever `CI` is set.
- **The renderer's scheme allowlist is tested per scheme**, never one-and-generalised:
  `file://` through several elements, `http://` against a loopback server that records
  requests, and at least one exotic scheme.
- **e2e** for the journey: fill a quote on a deal, generate it, find it on the record,
  download it and confirm it is a PDF. Plus the phone viewport for the line-item editor.
- **The immutability claim gets its own test**, because it is the one users would never
  forgive being wrong: raise a quote, then rename the company, edit the deal's value and
  edit the template, and assert the stored document and its PDF are byte-identical.
  **It must compare the STORED bytes across those edits and must never re-render.**
  Task 1 measured three renders of identical input on one version at 6899, 6899 and 6898
  bytes: the renderer is not reproducible, so a re-render-and-diff test would fail for
  reasons that have nothing to do with immutability — which is the same fact the "not
  offered" decision above already rests on.
- Suite baseline at start: 1829 unit + 36 integration skipped + 96 e2e, green.

## Rollout

v1.0.0, standard mechanics, branch `worktree-phase-7-documents` from `ee27322` (the
v0.10.0 manifest commit). Migration 0009.

**This upgrade is not a no-op, and the notes must say so.** Every release since v0.6.0
has been an application-only change; this one adds an apt dependency and a migration.
The upgrade will take longer, and the live checklist must confirm WeasyPrint is present
on the server before the first quote is raised rather than discovering it from a failed
render.

Size: six tasks — the org profile and packaging gate; the data model and arithmetic; the
render pipeline; the deal-side UI; the settings panels; and the e2e plus release.
