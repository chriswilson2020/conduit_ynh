# Conduit Phase 4.1 — IMAP folders and bulk mail actions

## Context

Phase 4 shipped as v0.5.0: the CRM inbox syncs INBOX + Sent per account, read-mostly (the only
write-back is the `\Seen` flag). Chris's first real-use requests, the same day: see his IMAP
folders (sieve-filed mail is currently invisible), and select multiple conversations to delete
or archive. Delete/archive means the CRM starts MOVING messages on the server — a deliberate
capability step beyond v0.5.0's read-mostly posture. Ships as v0.6.0.

Decisions taken with Chris in the 4.1 brainstorm:

| Decision | Choice |
|---|---|
| Folder scope | **All folders except Junk/Trash by default, with a per-account picker.** Discovery via IMAP LIST; a Settings checklist can include/exclude any folder (Junk/Trash opt-in). |
| Delete | **IMAP MOVE to the account's Trash folder.** Real mail-client semantics; the server's retention owns actual destruction. The CRM never expunges, and the message row persists (`folder` becomes the Trash name) — archive-not-delete holds: the CRM destroys nothing. |
| Archive | **IMAP MOVE to the account's Archive folder.** Sticks across every mail client. The v0.5.0 CRM-side thread archive remains as a separate, purely-CRM state, renamed **"Hide in CRM"** in the UI so the two cannot be confused. |
| Selection | **Thread-level multi-select in the list** (checkboxes + shift-click). Actions apply to the selected threads' messages IN THE CURRENT FOLDER VIEW only. Per-message selection inside a conversation is deferred. |

## Data model (migration 0005, additive)

- `mail_account_folders` — id, `account_id` FK NOT NULL, `folder` text NOT NULL (the exact
  IMAP mailbox name, UTF-7 already decoded by imapflow), `special_use` text NULL CHECK
  (`archive`|`drafts`|`junk`|`sent`|`trash`) (from SPECIAL-USE attributes, name-heuristic
  fallback), `sync_enabled` boolean NOT NULL (default set at discovery: false for
  junk/trash, true otherwise), `selectable` boolean NOT NULL default true (`\Noselect`
  folders are listed but never synced), `last_discovered_at` timestamptz NOT NULL,
  timestamps; UNIQUE (account_id, folder). Rows are never deleted: a folder that vanishes
  from LIST keeps its row (and its messages keep their history) but is marked by
  `last_discovered_at` going stale and is dropped from the sync walk and the UI.
- `mail_accounts` — gains `trash_folder` text NULL and `archive_folder` text NULL
  (resolved automatically from special_use at discovery when NULL; user-overridable in
  Settings; a bulk action against an account whose target folder cannot be resolved fails
  that account's threads with an explanatory per-thread error rather than guessing).
- `mail_folder_state` unchanged (it is already keyed by (account, folder) and generalises
  as-is). `sent_folder` on mail_accounts unchanged (APPEND target; discovery marks it
  special_use=sent when they agree).
- ~~No new indexes expected beyond UNIQUE.~~ **MEASURED, and the expectation was wrong.**
  Task 4 EXPLAINed the folder filter at 20,000 threads / 85,000 messages (2 accounts, 7
  folders). The existing (account_id, folder, imap_uid) index cannot serve a folder-only
  filter — its leading column is absent from the predicate and it carries no `thread_id` —
  so the planner probed `mail_messages(thread_id)` once per candidate thread. Fine for a
  folder whose mail is recent (INBOX: 0.31ms / 357 buffers), but the honest worst case is a
  folder holding only OLD threads, where the ordered walk passes nearly every thread before
  it fills a page: **61.5ms and 122,737 buffers** for a 60-thread folder. One hand-written
  index in 0005, `mail_messages (folder, thread_id)`, takes that case to **3.8ms / 252** and
  trims the ordinary ones (INBOX → 0.24ms / 254; a mid-sized folder 1.48ms / 2,954 →
  1.08ms / 1,509; an empty folder 3.13ms / 824 → 0.05ms / 3). 1.6MB against a 35MB table.
  Figures are the top-level `Limit` node's, not the `Planning:` block's buffers line — an
  earlier draft of this bullet quoted the latter by mistake.
  **The 16x is a PLAN FLIP and it is folder-size dependent**: with few enough threads in the
  folder the planner drops the per-thread probe for a hash semi join over an index-only
  scan; at 2,000 old threads it keeps the nested loop and the index only makes each probe
  index-only (52.5ms / 110,443 → 36.3ms / 53,211 — about 1.5x time, 2x buffers). The index
  is justified either way (nothing measured slower), but the headline number is not what
  every folder gets. Named query and measurements live in the migration, per the house rule.
- **0005 also REPLACES 0004's unseen partial index**, adding `INCLUDE (folder, account_id)`
  (0004 shipped and is immutable, so the replacement lives here; the name is unchanged, so
  there is exactly one index and 0004's comment still describes it). Task 4's Trash carve-out
  made the badge read `folder` and `account_id`, which the old index did not carry — costing
  it the index-only scan it exists for. Measured at 85,000 messages / 8,000 unread: badge
  before the carve-out 9.98ms / 298 buffers, Heap Fetches 0; badge WITH the carve-out on the
  old index **25.4ms / 2,257 buffers**, bitmap heap scan over 1,962 heap blocks; with INCLUDE
  **19.3ms / 311 buffers, Heap Fetches 0** again. The per-folder counts gain it too (12.4ms /
  310, Heap Fetches 0 — `folder` is their GROUP BY key). INCLUDE rather than key columns
  because neither is ever a search term here. Cost: 264kB → 504kB.

## Folder discovery & classification

Each AccountSync pass begins with LIST (imapflow `list()`, which surfaces SPECIAL-USE
attributes where the server supports RFC 6154 — Dovecot does). Upsert into
`mail_account_folders`; new folders get the default `sync_enabled` per classification.
Classification precedence: SPECIAL-USE attribute; else case-insensitive name heuristics
(`trash|deleted`, `junk|spam`, `archive`, `drafts`, `sent`) on the last path segment; else
none. `trash_folder`/`archive_folder` on the account are filled from classification when
NULL. Discovery is cheap (one LIST per pass) and is what keeps the picker current.

## Sync walk generalisation

`foldersOf(account)` changes from the INBOX+sent pair to: all `sync_enabled AND selectable`
folders from `mail_account_folders` (INBOX and the sent folder are always walked regardless
of the flag — the send path and direction detection depend on them; the picker shows them
locked on). IDLE remains INBOX-only. Cursor/UIDVALIDITY/flag-reconcile semantics are
unchanged per folder. Backfill windows apply per folder on first sync (a folder enabled
later backfills from its enablement per `backfill_days`, same as a new account).
Cross-folder duplicate sightings already collapse via UNIQUE (account_id, message_id) with
`folder`/`imap_uid` reflecting the latest sighting — unchanged, and it is what makes MOVE
convergence free (below).

## Move write-back (`services/mail-move.ts` + sync-engine addition)

`ImapClient` gains `move(folder, uids, targetFolder)` (imapflow `messageMove`; throw on
falsy return per the established falsy-return discipline). `AccountSync` exposes
`moveMessages(folder, uids, targetFolder)` queued on the existing serial loop — same
contract as `markSeen`: runs between passes, fast-rejects with `SyncUnavailableError`
during backoff, never overlaps a pass.

Move service semantics, per thread, per account. Step 1 has two modes, selected by whether
the caller supplied a `folder` (quality-review ruling, mirrored on `bulkThreadActionInput`
below):
1. Collect the thread's messages whose `imap_uid` is NOT NULL (rows awaiting reconciliation
   are skipped and reported per-thread — rare, self-heals next pass), scoped one of two ways:
   - **Folder-scoped** (`folder` present — the list multi-select case): only messages whose
     `folder` equals the CURRENT VIEW's folder (the selection-granularity ruling).
   - **Whole-thread** (`folder` absent — the single-thread buttons in the conversation view
     and record Mail tabs): every one of the thread's messages EXCEPT those already in the
     target folder (nothing to do) and those in the account's sent folder (archiving a
     conversation must never empty Sent).
   If the resulting set is empty, the move is a no-op for this thread: reported as
   `{ ok: true, skipped: true }`, not a failure. Three things empty it: every in-scope
   message awaited reconciliation; every one was already in the target folder; or every one
   belongs to an ARCHIVED mail account, whose rows survive (archive-not-delete) but whose
   sync loop is torn down for as long as it stays archived (unarchiving rebuilds it) —
   unmovable by anything a user can do from the mail view, so they are excluded like a NULL
   uid rather than failed, which would leave such a thread un-archivable from every view
   forever. A per-account refusal (below) applies only to messages that SURVIVE these
   filters: an account that cannot move must not fail a thread whose messages of its own
   were never in scope.
2. Optimistic DB update inside one transaction: `folder` = target, `imap_uid` = NULL,
   `updated_at` bumped; SSE hints published after commit.
3. Queue the IMAP MOVE (grouped per account/folder, chunked per the existing UID_CHUNK).
   MOVE failure is caught and logged and the DB rows are REVERTED by a compensating update
   (same transaction shape) with the failure surfaced in the bulk result — the CRM view
   must never claim a move the server refused. (Failure after partial chunk success leaves
   the succeeded chunk moved — the next pass's re-sighting converges either way; the
   compensation applies only to unsent chunks. Comment this honestly.)
4. The next pass of the target folder re-sights the messages, and the (account_id,
   message_id) upsert restores `imap_uid` — the Phase 4 reconciliation machinery, unchanged.
   If the target folder is not sync-enabled (Trash by default), the rows simply keep
   `folder` = Trash with NULL uid: visible under a Trash filter, never updated again, never
   deleted.

Threads are not archived CRM-side by a server move: thread visibility in folder views is
derived from message folders. A thread whose messages have ALL left synced folders
naturally drops out of every folder view; it remains reachable via record Mail tabs,
search, and the "Hide in CRM" state remains orthogonal.

## Bulk API (`routes/mail.ts` additions)

- `GET /api/mail/accounts/:id/folders` — the picker's list (name, special_use, sync_enabled,
  selectable, locked flags for INBOX/sent). Owner-only, and a foreign account 404s exactly
  like a nonexistent one. `locked` is computed per request from the account's CURRENT
  sent_folder, never stored. Stale rows (a folder that vanished from LIST) and `\Noselect`
  rows are both RETURNED — the CRM may still hold messages filed under them, and
  `last_discovered_at`/`selectable` are on the wire so the picker can grey them out.
- `PATCH /api/mail/accounts/:id/folders` — toggle sync_enabled (owner-only; enabling
  triggers `syncNow`, fire-and-forget). Two 409s, both refused in BOTH directions because
  the switch is not real either way: a LOCKED folder (INBOX and the account's sent folder,
  always walked) and an UNSELECTABLE one (`\Noselect` holds no messages to sync). An
  unknown folder name is a 404, matched byte for byte as UNIQUE (account_id, folder) does.
  A same-value patch is a no-op: no write, no hint, no pass.
- `POST /api/mail/threads/bulk` — `{ threadIds[], folder?, action: "trash"|"archive"|"hide" }`.
  `folder` is now OPTIONAL, carrying the move service's two modes above: present = the view
  the selection was made in (list multi-select, folder-scoped); absent = whole-thread (the
  conversation view/record-tab single-thread buttons). `hide` (the existing CRM archive
  applied in bulk) ignores `folder` entirely either way. Server groups by account, applies
  the move service, returns per-thread results `{ threadId, ok, skipped?, error?, reason? }` —
  `skipped: true` (always paired with `ok: true`) means the thread's eligible set came out
  empty, for any of the three reasons in step 1 above (awaiting reconciliation, already in
  the target, or owned by an archived account); `error` is present iff `ok` is false.
  **`reason` is the machine-readable half, and the one a client branches on** — `error` stays
  free text for display and no UI may parse it (the house rule for every error shape).
  Failures carry `no_sync | no_target | not_found | server_refused`; skips carry
  `archived_account | awaiting_reconciliation | already_in_target | out_of_scope`, the first
  three in that precedence when one thread hits several (a message could not be moved, a
  message could not be moved, the goal already holds). It is present exactly when there is
  something to explain — a failure or a skip — and its half of the enum must match which;
  the shared schema enforces both. **`out_of_scope`** is the fourth skip value and takes no
  part in that precedence: it means nothing of the thread was in scope at all — in the
  folder-scoped mode every message is in some other folder, in the whole-thread mode the
  conversation is nothing but Sent mail — which is a different statement from
  `already_in_target` ("the action never applied here" vs "it was already done"), and one the
  same thread can swap between: a thread whose only message sits in Archive reports
  `out_of_scope` from the INBOX view and `already_in_target` from the Archive view. The
  free-text `error` is capped on the way out, since a mail server's refusal text is arbitrary
  and one response can carry 50 of them. An
  account in backoff, with an unresolvable target folder, or with no running sync loop while
  not archived fails ITS threads with a message — but only for messages the action was
  actually going to move; others proceed. Cap threadIds at 200 per request — the OUTER bound,
  reachable only by `hide`. **trash/archive are capped at 50 by the route** (400 otherwise):
  those two wait on a real mail server, since each queued MOVE runs on its account's serial
  sync loop, so the bound on the request is a bound on the SIZE of that wait rather than on
  its duration (a timeout would produce exactly the "claimed a move the server refused" state
  the compensation exists to prevent). Consequence the endpoint documents: **a proxy 504 does
  not mean the action failed** — the work continues on the loop, the SSE hints still fire, and
  the client must REFETCH rather than retry (a blind retry trashes whatever is now in the
  source folder).
- Thread list gains a `folder` filter (threads with >= 1 message in that folder); the
  unread-count endpoint gains an optional per-folder variant for sidebar badges (one grouped
  query, not N), shaped `{folders: [{folder, count}]}` — no accountId, so two accounts'
  INBOXes are one row.
- **"Unread" scopes to the view** (coordinator ruling, Task 4 quality review). Two scopes,
  and every unread computation belongs to exactly one:
  - **Unscoped** — the nav badge, the default list's per-row `unread` flag, and `?unread=true`
    with no folder — means "unread anywhere", and **excludes each account's trash_folder**.
    A move never touches `seen`, and nothing re-sights an unsynced Trash, so a trashed unread
    message would otherwise count forever. Archive-folder unread still counts: filing is not
    reading.
  - **Folder-scoped** — `?folder=F`'s per-row flag, `?folder=F&unread=true`, and each
    `?byFolder=1` count — means "unseen IN F", with `seen = false` folded into the SAME
    predicate as the folder term, and takes **no trash carve-out at all**. That is what
    resolves the Trash self-contradiction (a Trash view whose rows all claim to be read,
    under a sidebar badge counting them as unread): scoped to the view, the rows and the
    badge answer the same question and agree. Anywhere else the carve-out would be
    redundant — a trashed message is not in F.
  - When the view also names an account, the folder-scoped predicate carries it too, for the
    same reason the folder filter itself is one combined EXISTS: "unseen in INBOX" while
    looking at account A must not light up because account B's INBOX has something. An
    account filter ALONE is not a view in this sense and leaves the flag unscoped.
- SSE: one new key family, `[["mail-folders", accountId]]`, for the sidebar and the picker.
  Published by the folder toggle above (after its write) and by the sync engine when a
  discovery pass CREATES or RECLASSIFIES a folder (after discovery's DB work, before the
  walk — a new folder should reach the sidebar without waiting for its first backfill). Not
  published by a pass that merely re-sighted the same folders, which is every pass on a
  settled mailbox. `trash_folder`/`archive_folder` resolution keeps publishing
  `[["mail-accounts"]]` instead: those live on the account row.

## Frontend

- **Folder sidebar** on the inbox (per-account sections when multiple accounts; folder rows
  with unread badges; INBOX default view; Trash/Junk appear when sync-enabled OR when the
  CRM holds rows in them — moves create such rows even for unsynced Trash). Folder
  choice feeds the thread-list `folder` filter and is part of the accumulation filter key.
- **Multi-select**: checkbox per row (visible on hover/when any selected), shift-click
  ranges, select-all-on-page; a bulk-action bar (Archive / Trash / Hide in CRM) with
  per-thread failure toasts from the bulk result. Selection clears on filter/folder change.
- **Settings → Mail accounts**: per-account folder checklist (from the folders endpoint;
  INBOX/sent locked on; Junk/Trash default off), and editable Trash/Archive folder
  overrides with the auto-detected values as placeholders.
- **Conversation view**: single-thread Archive/Trash buttons using the same bulk endpoint
  (one thread); the existing CRM archive control renamed "Hide in CRM" everywhere.
- Message rows moved to Trash render with a subtle "in Trash" chip in conversations.

## Testing

- Unit: folder classification matrix (SPECIAL-USE, name heuristics, precedence, Noselect);
  discovery upsert/staleness; walk generalisation (enabled/locked/selectable); move service
  (optimistic update, compensation on failure, NULL-uid skip, chunking, per-account
  grouping); bulk route (authz, partial failure shape, cap); folder filter + per-folder
  unread counts; sidebar/selection pure logic (range selection, filter-key integration) in
  mail-lib with tests.
- Fake ImapClient gains list/move; the state-machine tests cover a move racing a pass
  (serialisation makes it sequential — assert it) and re-sighting convergence after a move.
- CI integration (the Task 8 suite): real LIST with SPECIAL-USE against Dovecot; real
  messageMove + re-sighting; move to a nonexistent folder → readable error.
- e2e: extend the mail journey — enable an extra folder via the picker, see its seeded
  message appear under the folder filter, multi-select two threads, Archive them, assert
  they land in the Archive folder via a direct IMAP check and vanish from the INBOX view.
- Suite baseline at start: 1262 unit + 26 integration + 42 e2e, green.

## Rollout

Single release: bump to v0.6.0 -> CI gate -> ff-merge -> tag -> manifest sha -> Chris runs
the one sudo yunohost upgrade command. Live verification against Chris's real mailbox: his
sieve-filed folders appear after the upgrade's first pass; archive two threads from the CRM
and see them move in his other mail client; trash one and find it in Trash there.

## Out of scope (deferred, not rejected)

Per-message selection inside conversations; moving mail INTO arbitrary folders (only
Trash/Archive targets in v0.6.0); folder creation/rename/delete; drafts sync; cross-account
bulk selections spanning different folder names are supported only via the per-account
grouping (no unified "All mail" bulk view yet); Junk training (spam reporting).
