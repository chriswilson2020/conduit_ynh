# Conduit Phase 4 — Email inbox

## Context

Phases 0-3.1 are live (v0.4.4 at release time): CRM core, scoped pipelines/deals, projects/tasks and the custom
Gantt with push-only cascade. Phase 4 delivers the email half of the original vision: an IMAP sync
worker, a threaded CRM inbox auto-linked to contacts and deals, compose/reply via SMTP, templates
and signatures. Ships as v0.5.0.

Decisions taken with Chris in the Phase 4 brainstorm:

| Decision | Choice |
|---|---|
| Mailbox model | **Per-user accounts, shared visibility.** Each user connects their own IMAP/SMTP account; synced threads are visible to every CRM user, in the inbox (filterable by account) and on linked records. Team mailboxes (info@) deferred. |
| Auto-linking | **Contacts + company auto, deals suggested.** Exact address match against `contacts.emails` links the thread to the contact and, through it, the company. Open deals of the linked contact/company appear as one-click suggestions on the thread — never linked automatically. |
| IMAP target | **One generic client; local Dovecot is a preset.** A single standard IMAP/SMTP code path; the account form offers a "Local Dovecot" preset that pre-fills localhost host/ports. No YunoHost-specific mail code path. |
| Sent mail | **SMTP send → IMAP APPEND to Sent → immediate DB insert.** Other mail clients see CRM-sent mail; the CRM never waits on sync to show your own send. |
| Sync engine | **In-process, IDLE + incremental poll.** A sync manager inside the existing Fastify server: imapflow connection per account, IDLE on INBOX for push, periodic incremental poll (UIDVALIDITY/UIDNEXT cursors) of INBOX and Sent. New mail broadcasts over the existing SSE channel. No new systemd service. |

Libraries: `imapflow` (IMAP), `mailparser` (MIME parsing), `nodemailer` (SMTP), `sanitize-html`
(ingest-time sanitization). All from the Nodemailer family except sanitize-html; all plain
dependencies of `@conduit/api`.

## Data model (migrations 0004+, additive)

- `mail_accounts` — id, `user_id` FK NOT NULL, `label` text NOT NULL, `email` text NOT NULL
  (the account's own address, used for direction detection and From), `imap_host`/`imap_port`/
  `imap_security` CHECK (`tls`|`starttls`), `smtp_host`/`smtp_port`/`smtp_security` CHECK
  (`tls`|`starttls`), `username` text NOT NULL, `credentials_ciphertext` text NOT NULL
  (AES-256-GCM; see Key handling), `sent_folder` text NOT NULL default `Sent`,
  `signature_html` text NULL (sanitized), `backfill_days` integer NULL (NULL = everything;
  default 90), `status` text CHECK (`active`|`error`) default active, `last_error` text NULL,
  `last_synced_at` timestamptz NULL, `archived_at`, timestamps. Archiving an account stops its
  sync and hides it from compose; its messages stay.
- `mail_folder_state` — id, `account_id` FK NOT NULL, `folder` text NOT NULL,
  `uidvalidity` bigint NOT NULL, `last_seen_uid` bigint NOT NULL default 0,
  `updated_at`; UNIQUE (account_id, folder). The incremental-sync cursor.
- `mail_threads` — id, `subject` text NOT NULL (normalized: leading Re:/Fwd:/Fw: chains
  stripped, original casing kept from the first message), `last_message_at` timestamptz NOT
  NULL, `message_count` integer NOT NULL default 0, `company_id` FK NULL, `contact_id` FK NULL,
  `deal_id` FK NULL, `project_id` FK NULL, `archived_at`, timestamps. Threads are global, not
  per-account: a conversation two users are both on is one thread. Archive is CRM-side only and
  never touches the mail server.
- `mail_messages` — id, `account_id` FK NOT NULL, `thread_id` FK NOT NULL, `message_id` text
  NOT NULL (RFC 5322 Message-ID; when a message lacks one, a synthetic
  `sha256:<hash-of-headers-and-body>` stands in), `in_reply_to` text NULL, `references` text[]
  NOT NULL default `{}`, `from_addr` text NOT NULL, `from_name` text NULL, `to_addrs` jsonb NOT
  NULL (array of `{address, name}`), `cc_addrs` jsonb NOT NULL default `[]`, `bcc_addrs` jsonb
  NOT NULL default `[]` (populated for outbound only), `subject` text NOT NULL default `''`,
  `body_text` text NOT NULL default `''`, `body_html` text NULL (sanitized at ingest),
  `snippet` text NOT NULL default `''` (first ~160 chars of text), `sent_at` timestamptz NOT
  NULL, `folder` text NOT NULL, `imap_uid` bigint NULL (NULL until an APPENDed send is next
  reconciled), `seen` boolean NOT NULL default false, `direction` text CHECK
  (`inbound`|`outbound`) NOT NULL, `search` tsvector generated column (english, from subject +
  body_text + from_addr + from_name) with a GIN index, timestamps.
  UNIQUE (account_id, message_id) — the same message seen in two folders (or via UIDVALIDITY
  refetch) collapses to one row whose `folder`/`imap_uid`/`seen` reflect the latest sighting.
- `mail_attachments` — id, `message_id` FK NOT NULL, `filename` text NOT NULL, `mime` text NOT
  NULL, `size_bytes` bigint NOT NULL, `blob_path` text NOT NULL (stored via the existing blobs
  service under `$data_dir`), `content_id` text NULL, `is_inline` boolean NOT NULL default
  false, `created_at`.
- `email_templates` — id, `name` text NOT NULL, `subject` text NOT NULL default `''`,
  `body_html` text NOT NULL (sanitized), `archived_at`, timestamps. Shared across users.
- No position columns anywhere — mail orders by `sent_at`/`last_message_at`. No changes to
  existing tables.

## Key handling

`$data_dir/mail.key` — 32 random bytes, generated by the install script (and idempotently by
upgrade if absent), mode 0600, owned by the app system user, included in backup/restore. The API
reads it lazily on first credential use; a missing key file is a startup warning and a 503 on
mail-account routes, not a crash. Ciphertext format: `v1:<iv-base64>:<tag-base64>:<data-base64>`
where data is the JSON `{imapPassword, smtpPassword}` (usually identical; the form offers one
password field with an "SMTP differs" toggle). Credentials are never returned by any API
response; the edit form leaves password fields blank and only overwrites when non-empty.
Losing mail.key strands every stored IMAP/SMTP credential permanently (users re-enter passwords;
nothing else is lost). Key rotation or restore-with-a-different-key requires a server restart
(the key is memoised per path).

## Sync engine (`services/mail-sync.ts`)

A `SyncManager` singleton starts after the server is ready and owns one `AccountSync` per
non-archived account, created/torn down on account CRUD and at boot.

Each `AccountSync` serializes all its work on an internal queue (one IMAP connection, one
operation at a time — the in-process analogue of the Phase 2/3 advisory-lock convention):

- **Backfill** (first sync of a folder): fetch envelopes+bodies for messages newer than
  `backfill_days` (all, when NULL), oldest first, recording the folder cursor as it goes so an
  interrupted backfill resumes rather than restarts.
- **Incremental**: for each of INBOX and `sent_folder`, fetch UIDs above `last_seen_uid`. Every
  poll also reconciles `\Seen` flags for messages from the last 30 days (cheap FLAGS-only
  fetch). Poll interval 5 minutes.
- **IDLE** on INBOX between polls for near-instant new-mail push; IDLE exit triggers an
  incremental pass. Servers without IDLE degrade to poll-only silently.
- **UIDVALIDITY change**: reset the cursor and refetch the folder; UNIQUE (account_id,
  message_id) makes the refetch converge without duplicates. Nothing is ever deleted —
  messages that vanished server-side stay in the CRM (archive-not-delete).
- **Ingest** (per message, one transaction): parse via mailparser → sanitize HTML (strip
  script/style/iframe/form/event handlers; keep structure and inline styles) → store
  attachments via the blobs service, rewriting `cid:` URLs in the sanitized HTML to the
  authenticated attachment route → thread (below) → auto-link (below) → insert → bump thread
  `last_message_at`/`message_count` → SSE key-hint `[["mail-threads"], ["mail-thread", threadId],
  ["mail-unread"]]`. `direction` is `outbound` when `from_addr` equals the account's `email`
  (case-insensitive), else `inbound`.
- **Errors**: per-account exponential backoff (1min → 32min cap), sets `status='error'` +
  `last_error`; any successful pass resets to `active`. All entry points are exception-guarded;
  a failing account can never take the server down. Reconnects on connection drop.

The manager exposes `syncNow(accountId)` for the account-created path and tests, and is fully
disabled under `NODE_ENV=test` unless explicitly started (unit tests drive `AccountSync` with a
fake client).

**ImapClient interface**: `AccountSync` talks to a thin interface (connect, disconnect, status,
fetchNewer, fetchRaw, fetchFlags, append, addFlags, idle) with two implementations —
`ImapflowClient` (real) and an in-memory fake for unit tests. This is a seam for testing, not an
abstraction layer to grow.

## Threading & auto-linking (`services/mail-threading.ts`)

- **Threading is references-graph only.** A new message joins the thread of the first of its
  `references` (walked right-to-left) or `in_reply_to` whose `message_id` already exists;
  otherwise it starts a new thread with the normalized subject. No subject-based fallback —
  "Invoice" from two unrelated senders must never merge. Out-of-order arrival during backfill is
  handled by ingesting each folder oldest-first and, when a message arrives whose references
  point at nothing yet, starting a thread that later messages can still join (the graph
  converges because children reference the full ancestor chain).
- **Auto-linking** runs when a thread is created and again whenever a thread with a NULL
  `contact_id` gains a message: all participant addresses (from/to/cc, lowercased) are matched
  exactly against `contacts.emails` (non-archived contacts). First match in participant order
  sets `contact_id`; the contact's `company_id` (if any) sets `company_id` when NULL. Links set
  manually are never overwritten; unlinking a record is manual-only. No domain-based matching
  (gmail.com would link half the world).
- **Deal suggestions** are computed at read time, not stored: open (`status='open'`) deals
  whose `contact_id` or `company_id` matches the thread's links, newest first, capped at 5.

## Send path (`services/mail-send.ts`)

`sendMail(db, actorId, {accountId, threadId?, to, cc, bcc, subject, bodyHtml, attachments,
links})`:

1. Authorize: the account must belong to the actor and be active (owner-only send; anyone can
   read).
2. Build MIME via nodemailer: sanitized HTML body + generated plain-text alternative; replies
   set `In-Reply-To` to the replied-to message and `References` to its chain.
3. SMTP send. Failure returns a 502-class error to the composer; nothing is stored.
4. IMAP APPEND to the account's `sent_folder` with `\Seen`. APPEND failure logs a warning and
   proceeds — the send succeeded and the DB record must still land (the message simply won't
   appear in other clients' Sent).
5. Insert into `mail_messages` (`direction='outbound'`, `seen=true`, `imap_uid` NULL until the
   next Sent-folder pass reconciles it via message_id), threading onto `threadId` when replying
   or a new thread when composing; apply the compose dialog's record links to new threads.
6. SSE broadcast.

Attachments are uploaded first through the existing multipart pattern and referenced by id.
Signatures: the composer pre-inserts the account's `signature_html`; it is ordinary editable
content. Templates: the composer's template picker inserts subject+body with client-side
substitution of `{{contact.name}}`, `{{company.name}}`, `{{user.name}}` from the linked/current
context; unresolved placeholders are left visible for the user to fill.

## Routes (`routes/mail.ts`)

All under the existing auth. "Own account" = `mail_accounts.user_id` is the current user.

- `GET/POST /api/mail/accounts`; `PATCH /api/mail/accounts/:id`;
  `POST /api/mail/accounts/:id/archive`; `POST /api/mail/accounts/:id/unarchive` — own accounts
  only in every mutating direction; the list returns other users' accounts as id+label+email
  (for filter UI), never settings. `POST /api/mail/accounts/test` dry-runs IMAP and SMTP logins with the
  submitted (or stored) credentials and returns per-protocol results.
- `GET /api/mail/threads` — filters: `account_id`, `unread`, `unlinked`, `company_id`,
  `contact_id`, `deal_id`, `project_id`, `archived`; keyset pagination by
  (`last_message_at`, id) matching the existing pagination helper.
- `GET /api/mail/threads/:id` — thread + messages (bodies, attachments) + deal suggestions.
- `POST /api/mail/threads/:id/read` — marks all messages seen in the DB and queues `\Seen`
  write-back to the server per affected account/uid (best-effort).
- `POST /api/mail/threads/:id/links` / `DELETE .../links/:kind` — set/clear the four FKs.
- `POST /api/mail/threads/:id/archive` (+ unarchive) — CRM-side only.
- `POST /api/mail/send` — compose and reply (threadId optional), as in Send path.
- `GET /api/mail/attachments/:id` — authenticated download (`Content-Disposition: attachment`);
  `GET /api/mail/attachments/:id/inline` is the variant a rewritten `cid:` src points at, and
  serves ONLY rows ingest marked `is_inline`. Both are ordinary authenticated same-origin
  routes (see the Frontend section's sandbox ruling) and send `X-Content-Type-Options: nosniff`;
  the inline route additionally declines to declare a non-image content type, falling back to
  an octet-stream download, so a hostile inbound `text/html` attachment cannot be rendered on
  the app's own origin by linking to it.
- `GET/POST/PATCH/archive/unarchive /api/mail/templates` — shared CRUD, archive-not-delete
  (and therefore, like accounts, an unarchive to undo it).
- `GET /api/mail/unread-count` — `{count}` of distinct non-archived threads with an unseen
  message; backs the nav item's unread badge.
- Global search: the existing search endpoint gains a `mail` section querying the tsvector
  (`websearch_to_tsquery`), returning thread-grouped hits.

SSE: the existing key-hint mechanism (`services/sse.ts`), not named events. Ingest and every
thread mutation (read/links/archive) publish `[["mail-threads"], ["mail-thread", id],
["mail-unread"]]`; account create/update/archive/unarchive and every sync status flip publish
`[["mail-accounts"]]` (drives the settings error badge); template create/update/archive/unarchive
publish `[["email-templates"]]`.

## Frontend (`packages/web`)

- **Inbox page** (`/mail`): two-pane — thread list (subject, participants, snippet, time,
  unread dot, account chip, link chips) with the filter bar, and the conversation view.
  Unread badge on the nav item, kept live via SSE. Empty state points at Settings → Mail.
- **Conversation view**: messages oldest-first, all but the latest collapsed. HTML bodies
  render in an iframe via `srcdoc` with
  `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` — scripts stay
  blocked (no `allow-scripts`, ever) — and a restrictive CSP meta tag: remote images blocked by default
  with a per-thread "Load remote images" button; text-only messages render as preformatted text.
  **Why `allow-same-origin` rather than an empty sandbox** (coordinator ruling, 20 Aug): an
  empty sandbox gives the frame an opaque origin, so SameSite cookies are not attached to its
  subresource loads, and the YunoHost SSOwat proxy in front of the app would bounce those
  cookieless inline-image requests to its login page — inline `cid:` images would simply never
  render. Signed attachment URLs would avoid that but require SSOwat `skipped_uris` packaging
  changes. With scripts blocked, ingest-time sanitization stripping `script`/`style` `url()`/
  forms, and the CSP meta still governing `img-src`, `allow-same-origin` is the accepted risk.
  The consequence for the API is that `GET /api/mail/attachments/:id/inline` is an ordinary
  authenticated same-origin route, not a signed one.
  **Why the two popup flags** (coordinator ruling, 20 Aug, amending the above): a link in a
  message opens in a new tab, the way it does in every mail client. Without `allow-popups` the
  sanitizer's own `target="_blank"` is inert and links do nothing at all — a broken app, not a
  security posture — and `allow-popups-to-escape-sandbox` is what makes the opened tab an
  ordinary one rather than one inheriting these flags. What the pair costs is already covered
  three times over: the ingest sanitizer stamps `rel="noopener noreferrer"` on every anchor
  (that transform is now load-bearing, not belt-and-braces), the escape flag keeps the new tab
  out of this frame's sandbox, and the frame's `no-referrer` meta covers the referrer. There is
  no CSP interaction — the flags live on the attribute, and the policy must never gain a
  `sandbox` directive, which would re-impose them and break links again — and nothing about the
  cookie story that motivated `allow-same-origin` changes. Accepted consequence: the sanitizer's
  scheme allowlist only constrains hrefs that carry a scheme, so inbound mail can link the
  user's own CRM and have it open in a new tab. That is a GET-only, user-initiated nuisance, and
  the same permissiveness is what lets legitimate same-origin links to CRM records work.
  Never granted: `allow-scripts`, `allow-forms`, `allow-top-navigation`, `allow-modals`. Attachment list with
  download. Link panel: chips for the four records with unlink, an entity picker to link
  manually, and the deal-suggestion one-click row. Reply / Reply-all / Forward.
- **Composer**: TipTap (already a design-doc dependency; first actual use), To/Cc/Bcc with
  address autocomplete from contacts, account selector (own active accounts), template picker,
  signature auto-inserted, attachment upload. Opens as reply from a thread, or fresh from the
  inbox and from contact/company/deal pages (pre-addressed and pre-linked).
- **Record pages**: contact/company/deal/project detail gain a Mail tab listing linked threads
  (reusing the thread-list component), with a compose button.
- **Settings → Mail accounts**: list with status/error badges, add/edit form with the "Local
  Dovecot" preset button (host localhost, IMAP 993 tls, SMTP 587 starttls, username = LDAP
  username), test-connection button, per-account signature editor (TipTap), archive.
- **Settings → Email templates**: shared template CRUD with TipTap editor.

## Packaging & deployment

- Install: generate `$data_dir/mail.key` (0600). Upgrade: generate only if absent. Backup/
  restore: include it (attachments already live under `$data_dir` via blobs).
- No new systemd services, ports, or nginx changes. `allow_email = true` has been set since
  Phase 0, so the app user may send.
- The Dovecot preset assumes the YunoHost mail stack's standard ports; it is only a form
  pre-fill, not configuration.

## Security

- Credentials AES-256-GCM at rest, key outside the DB, never serialized to clients.
- All HTML (inbound bodies, signatures, templates, compose payloads) sanitized server-side
  with one shared sanitizer profile; `cid:` URLs rewritten to authenticated routes at ingest.
- Sandboxed-iframe rendering (`allow-same-origin` plus the two popup flags — never
  `allow-scripts`/`allow-forms`/`allow-top-navigation`/`allow-modals`; see the Frontend section
  for both rulings and for why the sanitizer's `rel="noopener noreferrer"` anchor transform is
  load-bearing); remote content blocked until explicitly loaded per thread.
- Send restricted to the account owner; attachment downloads authenticated; account settings
  readable only by the owner.
- Users may point the sync at arbitrary hosts (inherent to an IMAP client); connections use
  TLS/STARTTLS only — no plaintext option.

## Testing

- **Unit (vitest, on the dev server via remote.sh as always)**: threading graph (in-order,
  out-of-order, missing Message-ID, refetch convergence), normalization, auto-link matrix
  (match/no-match/manual-wins/archived-contact), crypto roundtrip + tamper rejection,
  sanitizer profile (script/form/event-handler stripping, cid rewriting, remote images
  untouched at ingest), send-path ordering (SMTP fail → nothing stored; APPEND fail → stored),
  `AccountSync` state machine against the fake ImapClient (backfill resume, cursor advance,
  UIDVALIDITY reset, flag reconcile, backoff), routes/authz (owner-only account access and
  send), template substitution. All fixtures ASCII-only with `\u` escapes.
- **CI integration**: two Dovecot instances (STARTTLS and non-STARTTLS) plus Mailpit in the
  GitHub Actions job; integration tests drive `ImapflowClient` against them (login, fetch, IDLE
  wake, APPEND, STARTTLS enforcement, TLS verification, SMTP send) — the only place the real
  client is exercised. 26 integration cases.
- **e2e (Playwright, CI only)**: seed Dovecot with a small mailbox → add account through the
  UI (Dovecot preset) → sync → thread list and conversation render → mark read → link a deal
  suggestion → reply (SMTP captured by Mailpit) → sent message appears in thread. Existing e2e
  untouched.

## Rollout

Single release: bump to v0.5.0 → CI gate → ff-merge → tag → CI builds the release asset →
manifest sha update on main → Chris runs the one sudo yunohost upgrade command. Before the
first implementation branch is cut, PR #1 (keyboard-drag fix, `claude/sad-carson-38358f`) must
be merged or explicitly deferred — its e2e/playwright.config.ts changes are the only collision
surface with this phase. **Resolved:** merged 19 Aug via PRs #1/#2.

## Out of scope (deferred, not rejected)

With their likely landing, agreed in the brainstorm:

- **Folders beyond INBOX + Sent** — expected first real-usage gap (sieve-filed mail will not
  sync). v0.5.x point release once the inbox has seen real use.
- **External providers** (revised 19 Aug after discussion with Chris) — still YAGNI-gated on a
  real mailbox needing connection, but split by vendor: **Microsoft 365 goes straight to the
  Graph API** (delta-query sync + `sendMail`; a second sync driver behind a `provider`
  discriminator on `mail_accounts` — its own small phase, not a point release) because
  Microsoft is retiring SMTP AUTH and IMAP is the legacy door there; **Gmail stays
  IMAP+XOAUTH2** (Google keeps IMAP healthy; that path is a v0.5.x-sized auth mode).
- **Subject-fallback threading** — only if broken threads are observed in practice (senders
  that strip References); v0.5.x fix on evidence.
- **Merging mail into the events timeline** — Phase 6 (Polish); the Mail tab covers the need
  until then.
- **Scheduling/snooze/reminders, open/click tracking** — Phase 6 at the earliest; YAGNI until
  missed.
- **Team/shared mailboxes (info@)** — needs its own ownership/ACL brainstorm when a concrete
  shared mailbox exists; no slot assigned.

### Known limitations (v0.5.0)

Accepted for the initial release rather than deferred to a later phase — small enough that a
point release, not a phase, is the right size for each:

- **Thread detail returns every message uncapped.** `GET /api/mail/threads/:id` has no limit,
  and each message carries its full sanitized body; a very large mailing-list thread is a
  response no browser tab survives opening. v0.5.x fix: a server-side cap (newest N messages)
  plus a `truncated` flag the conversation renders as a "load earlier messages" control — it
  needs a schema field, so it did not fit as a patch.
- **Forward does not re-attach attachments.** `POST /api/files` links a file to exactly one
  record, so re-attaching on forward would copy each blob onto the forward's own record rather
  than reference the original rows — a real feature with a real storage cost, deferred rather
  than half-done.
- **Compose without a record link cannot attach files.** The same one-record-per-file constraint
  means the composer disables its attach control when opened with no company/contact/deal/project
  link in context (e.g. a bare reply whose thread carries no links yet).
- **Deals' contact/company have no UI picker.** `deals.contact_id`/`company_id` are reachable
  only through `PATCH /api/deals/:id` today — the board's New deal dialog takes just a title and
  value, and a deal's contact is read-only everywhere it is shown. A per-deal picker would close
  this; worth a line in a later phase's backlog, not a v0.5.0 change.
- **Accumulated inbox pages beyond the first are not live-refreshed.** Only the current page of
  the thread list is a live query; after "load more," an SSE invalidation refreshes that page
  while earlier pages keep the rows they were fetched with until the list resets (a filter
  change or remount).
