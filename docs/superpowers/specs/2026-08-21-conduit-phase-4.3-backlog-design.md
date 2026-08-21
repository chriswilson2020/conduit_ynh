# Conduit Phase 4.3 — Per-user Hide + backlog sweep

## Context

The v0.8.0 backlog release, chosen by Chris from the deferred list after v0.7.0 shipped.
Two halves: the per-user Hide-in-CRM feature (completing 4.2's privacy story — today one
user hiding a conversation hides it for everyone, a documented v0.7.0 limitation) and a
small-fixes sweep of long-standing known limitations.

Decisions taken with Chris in the 4.3 brainstorm:

| Decision | Choice |
|---|---|
| Hide scope | **Gone everywhere, per person.** Hiding a conversation removes it from YOUR inbox, unread badge and counts, record Mail tabs, and search — symmetric with today's behaviour, but only for you. A **Hidden** filter view in the inbox lists your hidden conversations with Unhide. Other users are entirely unaffected by your hides. |
| Migration | **Upgrade changes nobody's view.** Existing thread-global hidden threads become personally hidden for every existing user (the migration writes the hide rows); each person can then unhide individually from the Hidden view. |
| Detail cap | **Latest 50 + Show earlier.** Thread detail returns the newest 50 messages plus the total; one click loads the rest. Closes the v0.5.0 "thread detail uncapped" limitation. |
| Sweep items | Forward keeps the original attachments; company detail gains an archived-pipelines view; the 1280px conversation-header overlap; the deepmerge-ts overrides entry. |

## Data model (migration 0007)

- New table `mail_thread_hides`: `thread_id` FK → mail_threads, `user_id` FK → users,
  `hidden_at` timestamptz NOT NULL DEFAULT now(); PRIMARY KEY (`thread_id`, `user_id`).
- Backfill in the same migration: one hide row per (currently-archived thread × existing
  user), carrying the thread's `archived_at` as `hidden_at` — this IS the
  upgrade-changes-nobody's-view decision.
- `mail_threads.archived_at` is then DROPPED: the thread-global flag retires entirely.
  Every `archivedAt IS NULL` filter in the mail read paths is replaced by the per-viewer
  hide predicate (below). Nothing else keeps writing or reading the old column — a
  half-retired flag would be two sources of truth.
- Scratch-DB upgrade drill via `withPreMigrationDatabase("0007", ...)`: a pre-0007
  archived thread comes back hidden for every pre-existing user, an unarchived one for
  none, and the column is gone.

## The hide predicate

One helper in mail-threads.ts, composed with (never replacing) the 4.2 visibility
predicate family:

- **hidden(U, T)**: EXISTS a `mail_thread_hides` row for (T, U).
- Default mail surfaces (inbox/folder lists, all three unread computations, record Mail
  tabs, search): visible per 4.2 **AND NOT hidden(U, T)**.
- The **Hidden view** (`?hidden=true` on the thread list): visible per 4.2 **AND
  hidden(U, T)** — same list machinery, inverted hide arm, folder/account filters
  compose unchanged.
- Thread **detail stays accessible** for a hidden thread (hide is a filing act, not a
  lock; the conversation view is also where Unhide lives — today's Unhide-in-conversation
  UX carries over per-user). Deal suggestions, SSE: unchanged (hints stay content-free;
  per-user results differ at refetch, exactly like 4.2 visibility).

## Hide/unhide semantics

- The bulk `hide` action and the conversation's Hide button write hide rows for the
  ACTOR alone; Unhide deletes the actor's row. Any viewer of a visible thread may
  hide/unhide for themselves (unchanged philosophy, now actually true). Idempotent both
  ways (hiding a hidden thread is a no-op, not an error).
- Archive/Trash (IMAP moves) untouched — 4.2's owner-only rules stand.
- The bulk result vocabulary is unchanged: hide cannot skip for ownership reasons and
  keeps its existing reason set.

## Thread-detail cap

- `getThreadDetail` returns the newest 50 messages, plus `totalMessages` and a
  `truncated` flag on the payload; `?all=true` returns everything. Attachments,
  reply-chain building and mark-read are computed from the FULL set server-side where
  they already are (mark-read marks the readable thread, not the rendered page; the
  reply chain already reads newest-visible directly) — the cap is a rendering payload
  bound, not a semantics change.
- UI: a "Show earlier messages (N more)" control at the top of the conversation loads
  the uncapped view.

## Sweep items

- **Forward re-attach**: forwarding a message includes its original attachments on the
  outgoing mail (v0.5.0 limitation "forward no re-attach"). Attachment bytes come from
  the stored blobs the CRM already serves; size cap = the existing compose attachment
  limits.
- **Company detail: archived pipelines** — the company page gains a way to view its
  archived pipelines (read-only list behind a "show archived" control, matching the
  archive-everywhere philosophy that data is never unreachable).
- **1280px conversation-header overlap** — the cosmetic layout fix.
- **deepmerge-ts**: add the root `overrides` entry pinning the patched version
  (advisory previously verified unreachable — this is hygiene, not a fix), lockfile
  regenerated on the server, full suite green.

## Amendments (coordinator, during execution)

1. **The archived-thread link guard retires with the shared state** (Task 1 quality
   review, coordinator ruling). Pre-4.3, changing a thread's record links 409'd while
   the thread was archived. Per-user hide has no shared "archived" state to guard: a
   personal filing act must never gate a shared CRM mutation, so link changes work
   regardless of any user's hide state — including the hider's own (linking from the
   Hidden view or the conversation is deliberate, and per 4.2's sharing line a deal
   link then shares the thread while it stays hidden in the hider's own inbox). The
   old 409 test is rewritten to pin the new behaviour, not deleted.
2. **Ingest into a hidden thread stays hidden** (Task 2 quality review, coordinator
   ruling). A new inbound message landing in a thread the viewer hid leaves their
   filing untouched: the thread stays out of their default list and unread badge and
   the new message simply grows the conversation in their Hidden view, while every
   other viewer's surfaces gain it normally. Resurfacing-on-new-mail is snooze
   behaviour, which the Out-of-scope list explicitly defers — a hide means "gone
   until I unhide it", not "gone until someone writes to me". Pinned two-sided
   (hider unchanged, other viewer updated) so an ingest change cannot break it
   silently.

## Out of scope (deferred, not rejected)

Per-thread manual share/unshare; mail filing power tools (per-message selection,
arbitrary-folder moves, folder management); team mailboxes; scheduling/snooze; Graph
API / XOAUTH2; merging mail into the events timeline.

## Testing

- Unit: the hide matrix — (hider / other user) × (default view / Hidden view / detail /
  each unread computation / record tabs / search), composed with 4.2 visibility (a
  hidden-but-invisible thread stays invisible; hiding never leaks existence);
  idempotency; the migration drill incl. the column drop and per-user backfill; the
  detail cap (truncated flag, ?all=true, boundary at exactly 50); forward re-attach
  (attachments present on the outgoing message, size caps enforced); archived-pipelines
  view authz/read-only.
- e2e: two-user hide journey (A hides — A's inbox loses it, B's keeps it; A's Hidden
  view lists it; A unhides — restored); Show-earlier on a >50-message fixture thread if
  fixture cost allows, else route-level; company archived-pipelines visible.
- Suite baseline at start: 1547 unit + 36 integration + 50 e2e, green.

## Rollout

v0.8.0, standard mechanics, branch `worktree-phase-4.3-backlog` from the v0.7.0
manifest commit. Live verification: post-upgrade nobody's inbox changed (the
migration's promise); Chris hides a thread — gone from his views only, listed in his
Hidden view; his other user's view untouched; a long thread shows the Show-earlier
control; forwarding carries the attachment.
