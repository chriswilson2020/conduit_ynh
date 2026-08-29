# Conduit v1.1.0 — Salutation and pronouns on a contact

## Context

Chris asked for a salutation and pronouns on the contact record: *"For salutation you
need to be able to choose Mr Mrs Ms Dr Prof and any others that might be useful. For
pronouns you need to add in some options at least he she him her they them."*

Contacts today carry a first and last name, a company, emails, phones, a job title and an
owner. There is nowhere to record how a person is addressed, which is the gap you notice
the moment you write to them — and Conduit now writes to them twice over, in mail
templates and on a quote.

Ships as **v1.1.0**: two new fields is a feature, not a fix.

Decisions taken with Chris:

| Decision | Choice |
|---|---|
| Salutation | **Picker plus free text.** Mr, Mrs, Ms, Mx, Dr, Prof in the list, and an "Other..." that accepts anything. |
| Pronouns | **Preset sets plus custom.** he/him, she/her, they/them, and an "Other..." for anything else. Stored as one string. |
| Where they appear | The contact record, **the contact list**, **quote merge fields**, and **email-template merge fields**. |

## The rule that governs both fields

**Both are optional, and neither is ever inferred.** Not from the name, not from the
salutation, not from anything else. A blank field stays blank and renders as nothing.

This is stated as a requirement rather than left to implementation taste because the
inference is tempting and always wrong: a salutation of "Dr" says nothing about pronouns,
and a first name says nothing about either. A CRM that guesses will guess wrong about a
real person, in a letter, in front of a customer. The templates already render an unknown
merge field as empty and never throw, so a blank simply produces a shorter greeting.

## Data model (migration 0011)

Two nullable text columns on `contacts`. Note 0010 was taken by v1.0.1 (the logo column widening), so this is **0011**:

- **`salutation`** — free text, bounded. The picker's six values are a UI convenience, not
  a constraint; the column accepts what the user types under "Other...", because the list
  cannot anticipate Dhr, Mevr, Drs, Ir, Ing, Rev, Sir or a title in a language nobody has
  thought about yet. **No CHECK constraint and no enum** for the same reason.
- **`pronouns`** — free text, bounded, holding one string such as `she/her`. The three
  presets are again a convenience; `she/they` and language-specific sets must be typable.

Bounded means a length cap enforced by the Zod input schema with a CHECK as the backstop,
following the repo's existing "Zod is the gate, the CHECK is the backstop" split. 64
characters is generous for both.

## The one non-obvious consequence: a quote must snapshot the salutation

Phase 7's Definition of done is that **an issued quote never changes**, and it holds that
promise by copying the recipient's name and address onto the `documents` row at issue
rather than joining to the contact. A salutation read live would break exactly that: edit
a contact's title next year and a quote sent last year silently starts saying something
different.

So `documents` gains **`recipient_salutation`**, populated at issue alongside the name,
and the merge field is `{{document.recipientSalutation}}` — a snapshot, like everything
else on that row.

**Pronouns are deliberately NOT snapshotted onto a document.** A quote has no use for
them; the greeting takes the salutation. Freezing a personal detail into an immutable
artifact that is downloaded and emailed should need a reason, and there isn't one here.

## Mail templates take the live value

Mail is composed and sent in the moment, so `{{contact.salutation}}` and
`{{contact.pronouns}}` join the existing `{{contact.name}}`, `{{company.name}}` and
`{{user.name}}` and are filled at compose time from the current record. No snapshot, no
new storage — that mechanism already exists and this is two more keys in its context.

## Surfaces

- **The contact record.** Both fields on the detail page, editable, empty by default, with
  the picker offering the presets and an "Other..." that reveals a text input.
- **The contact list.** The salutation shows beside the name. Pronouns do not — a list is
  for finding someone, and a pronoun is for writing to them.
- **The quote form.** The recipient block already defaults from the deal's company and
  contact; it picks up the salutation the same way, and the user can edit it before
  issuing like every other recipient field.
- **Settings → Templates.** Both new merge fields are documented on the page itself,
  beside the existing ones, because that page is the only place anyone will look.

Every surface meets the v0.10.0 phone standard.

## Out of scope

Per-language salutation rules; automatic greeting construction ("Dear " + salutation +
last name) as anything other than what a template author writes themselves; pronouns on
users as opposed to contacts; declension beyond the stored string; and any inference
whatsoever.

## Testing

- **Unit** for the preset lists, the length bounds, and the "Other..." path that lets a
  typed value through unchanged.
- **A test that the inference does not exist**: a contact with a salutation of "Mr" and no
  pronouns renders no pronouns anywhere, and a contact named in a way that invites a guess
  gets none either.
- **API** for the two columns round-tripping, including empty and maximum-length values.
- **The immutability test extended**: issue a quote, then change the contact's salutation,
  and assert the stored document and its PDF are unchanged. This is the same shape as the
  existing company-rename case and is the reason `recipient_salutation` is a column.
- **e2e** for setting both on a contact, seeing the salutation in the list, and a quote
  carrying it.
- Baseline: 2347 unit + 105 e2e, green.

## Rollout

v1.1.0, standard mechanics, branch from `main` **after v1.0.1 (the logo limit) has
landed** — both touch `packages/shared/src/index.ts` and the manifest version, and this
repo has one worktree.
