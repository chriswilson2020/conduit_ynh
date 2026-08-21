# Conduit Phase 4.2 — Mail visibility: private by default

## Context

Phases 4/4.1 shipped shared-visibility mail (a deliberate brainstorm decision, modelled on
Pipedrive's small-team default): every CRM user sees every synced thread. The day Chris added
a second real user, the assumption behind that decision expired — deal-linked mail being
team-visible is the CRM's value; a whole personal INBOX being team-visible is a different
trade. Phase 4.2 inverts the default. Ships as v0.7.0.

Decisions taken with Chris in the 4.2 brainstorm:

| Decision | Choice |
|---|---|
| Default | **Private by default, per account.** `mail_accounts` gains `visibility` (`private`\|`shared`), default private. The migration makes EVERY existing account private — the safe direction; the owner flips a mailbox to shared in Settings. |
| Sharing line | **Automation never shares; deliberate acts do.** A private account's thread becomes visible to other users only through a DEAL or PROJECT link (always click-made). Automatic contact/company links keep working — auto-linking, suggestions, the owner's own record views — but never expose content to others. |
| Move rights | **Only the mailbox owner performs IMAP moves.** Archive/Trash act on messages of accounts the ACTOR owns; other viewers of a shared-visible thread get Hide-in-CRM only. A colleague must never reorganise your actual mailbox. |
| Inbox scope (coordinator ruling) | **The inbox is a mailbox view; records are the CRM view.** Folder/inbox lists show only threads carried by your own accounts or shared accounts. Deliberately-linked threads from someone else's private account surface on the record Mail tabs and in search — not in your personal inbox. |

## Data model (migration 0006, additive)

- `mail_accounts` gains `visibility` text NOT NULL CHECK (`private`|`shared`) DEFAULT
  `'private'`. No backfill statement needed — the default applies to existing rows via the
  ALTER, which IS the "everything becomes private" migration decision. No other schema
  changes; no new indexes expected (the predicate reuses existing joins — Task authors
  EXPLAIN before claiming, per the house rule).

## The visibility predicate (the core of the phase)

One SQL helper (the `notInAccountTrash` pattern: built once in `mail-threads.ts`, used
everywhere) defining, for user U and thread T:

- **inbox-visible(U, T)**: T has >= 1 message on an account owned by U, OR on an account
  with `visibility = 'shared'`.
- **record-visible(U, T)**: inbox-visible(U, T) OR (T.`deal_id` IS NOT NULL OR
  T.`project_id` IS NOT NULL).

Application, exhaustively (every mail read path — the 4.1 reviews proved these drift when
touched piecemeal):

| Surface | Predicate |
|---|---|
| Thread list (inbox + folder views) | inbox-visible |
| Thread detail | record-visible; invisible → the indistinguishable 404 |
| All three unread computations (badge, list flag/filter, byFolder) | inbox-visible (scoped per the 4.1 unread-scopes-to-the-view rule, unchanged otherwise) |
| Record Mail tabs | contact/company tabs: record-visible restricted to threads linked to that record; deal/project tabs: record-visible |
| Search mail group | record-visible |
| Deal suggestions | unchanged (they render inside a thread view the caller can already see) |
| SSE | unchanged — hints are content-free invalidation keys; per-user results differ at refetch time |

## Move rights & bulk semantics

- `moveThreads` gains the actor-ownership rule: messages on accounts NOT owned by the actor
  are excluded from candidates with a new skip reason `not_owner` (the archived-account
  pattern — skip semantics, never failure; a thread whose whole in-scope set is unowned
  reports `{ok: true, skipped: true, reason: "not_owner"}`).
- The shared `bulkThreadSkipReason` enum gains `not_owner`; superRefine halves updated.
- UI: Archive/Trash controls render only when the thread carries >= 1 message on an account
  the viewer owns (the thread payload gains a lightweight `ownedByViewer` boolean computed in
  the same aggregate pass); Hide-in-CRM stays available to every viewer. As built (Task 4,
  per the plan's UX note): "render only when" is the CONVERSATION's shape — its two buttons
  are absent for a non-owner — while the multi-select BULK BAR disables the two moves with
  the reason as visible text whenever the selection holds any unowned thread, because a bar
  whose buttons vanish as ticks change reads as breakage, and the disabled-with-reason note
  is the 4.1 blocked-note pattern. Hide remains
  thread-global in v0.7.0 (one user hiding hides for all — documented limitation; per-user
  hide is deferred).
- Mark-read: unchanged (any viewer; `\Seen` write-back already flows through each message's
  own account loop and is a reading act, not a filing act).

## Settings

Per-account **Private / Shared** toggle beside the folder picker (owner-only, like every
account setting; `visibility` rides `mailAccountSchema` + the update input). Copy states the
sharing line: "Private: only you see this mailbox's conversations. Threads you link to a
deal or project become visible on that record. Shared: every CRM user sees this mailbox."
Flipping publishes one frame carrying the existing `[["mail-accounts"]]` hint plus
`[["mail-threads"]]` and `[["mail-unread"]]` (every user's lists, badge and per-folder
counts change -- corrected from two families to three by Amendment 5).

## Out of scope (deferred, not rejected)

Per-user Hide-in-CRM; per-thread manual share/unshare overrides; visibility for email
templates (stay shared); an audit trail of who viewed what; retroactive unsharing semantics
beyond flipping the account back to private (which simply re-applies the predicate — linked
threads remain record-visible, by design).

## Testing

- Unit: the predicate matrix (owner/other x private/shared x unlinked/contact-linked/
  deal-linked) across EVERY surface in the table above — the three unread computations each
  get the matrix; route authz tests for detail-404, list exclusion, search exclusion;
  moveThreads' not_owner skip incl. the mixed-ownership thread (owned half moves, unowned
  half skips); the ownedByViewer aggregate.
- e2e: a second CI user (the harness supports per-request user headers — verify; else a
  seeded second account under the same user exercises the predicate's account-ownership arm
  and the UI gating, with the two-user matrix covered at route level). Journey: user B sees
  an empty inbox while A's mail syncs; A links a thread to a deal; B sees it on the deal's
  Mail tab and in search but NOT in B's inbox; B's Archive/Trash controls absent there,
  Hide-in-CRM present.
- Suite baseline at start: 1472 unit + 36 integration + 46 e2e, green.

## Rollout

v0.7.0, the standard mechanics. Live verification: Chris's account flips to private on
upgrade (his new user sees an empty inbox immediately — the phase's acceptance test);
linking a thread to a deal makes exactly that thread appear for the other user on the deal;
flipping a mailbox to shared restores 4.1 behaviour for it.

## Amendments (coordinator, during execution)

Ruled during Task 2's spec review; each supersedes the corresponding line above.

1. **Record Mail tabs' unread flag and filter run at RECORD scope**, deviating from the
   predicate table's "all three unread computations: inbox-visible" row. A deal/project
   tab renders a linked private thread's content, so an unseen message the tab lets the
   viewer read must not render as read there — the row's dot and `?unread=true` on a
   record-filtered list both compose the unread-scopes-to-the-view rule with
   record-visible. The badge, the inbox/folder lists' unread, and the per-folder counts
   stay inbox-visible: record-visible mail is readable on the record, not WAITING in
   anyone else's mailbox.
2. **Mark-read is scoped to the messages the viewer's record scope can read**, superseding
   "Mark-read: unchanged (any viewer)". Marking read is a reading act, so it applies to
   what the view lets you read: on a deal/project-linked thread that is every message
   (whole thread marks, as before); on an unlinked cross-account thread it is the viewer's
   own half — the other user's private copies keep their seen state, and no `\Seen`
   write-back group is built for an account whose messages the viewer cannot see. Any
   viewer of a visible thread may still mark it read.
3. **Reply requires record-visibility of the target thread** ("you may reply to what you
   may open"): the send path resolves a reply's `threadId` through the same visibility
   gate as the detail route — an invisible thread is the indistinguishable 404, before
   anything is composed or sent — and builds its In-Reply-To/References chain from the
   newest message the viewer may read, never leaking an invisible message's Message-ID
   into outgoing headers.
4. **Messages the actor cannot see are out of scope entirely on the move paths** (ruled
   during Task 3's spec review). collectCandidates' messages read carries the
   record-scope visibility term, so an invisible message is never examined and never
   noted: a folder-scoped move on a folder holding only foreign private copies answers
   `out_of_scope` (the viewer's own world's truth), and a foreign invisible copy can
   never outrank the viewer's own skip reason. Among visible in-scope messages, unowned
   ones note `not_owner` — which therefore means precisely "a message you can see but do
   not own" (a shared account's, or any message of a deal/project-linked thread).
5. **The visibility flip publishes three hint families, not the Settings section's
   original two**: `[["mail-accounts"]]` + `[["mail-threads"]]` + `[["mail-unread"]]` —
   the unread computations are visibility-scoped, so the badge and per-folder counts
   change for every user too. The Settings line above is corrected in place. The frame
   deliberately carries no per-thread `["mail-thread", <id>]` keys, so an already-open
   conversation pane is NOT invalidated by a flip — it lives on its cached,
   already-delivered bytes until the next refetch. Task 4's decision, coordinator-ruled:
   that bounded window is ACCEPTED and documented, not engineered away — the bytes were
   already delivered, nothing further leaks server-side, and close-on-list-exit
   machinery would tie the pane (which renders off the URL param) to a list it is
   deliberately independent of. The obligation that comes with accepting it: the pane
   meets the eventual indistinguishable 404 with a calm "This conversation is no longer
   available." state (web: conversation.tsx's `conversation-gone` branch, status-keyed
   via mail-lib's isThreadGone), never a raw error line — pinned by unit tests and by
   the two-user e2e journey's flip-back step.

6. **The accounts endpoint keeps disclosing every account's existence** (ruled during
   Task 2's review; recorded here by Task 4): `GET /api/mail/accounts` returns every
   other user's account as id+label+email to all authenticated users — required so
   reply-all can never cc a mailbox this CRM syncs, and for the account chips and
   filter UI. A private mailbox's EXISTENCE, label and address therefore stay listed
   to every user while its mail does not. Deliberate, and surfaced to the operator in
   the v0.7.0 release notes rather than silently shipped.
