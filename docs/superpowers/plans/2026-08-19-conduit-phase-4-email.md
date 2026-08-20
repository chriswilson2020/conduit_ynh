# Conduit Phase 4 — Email Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user IMAP/SMTP mail accounts, an in-process sync engine (IDLE + incremental poll), a threaded shared-visibility CRM inbox auto-linked to contacts/companies with deal suggestions, compose/reply via SMTP with IMAP APPEND to Sent, templates and signatures — released as v0.5.0.

**Architecture:** Six new tables. Ingest (parse, sanitize, thread, auto-link) is one transactional service; the sync engine talks to a thin `ImapClient` interface (real imapflow adapter vs in-memory fake for tests); send is SMTP → APPEND → DB insert in strict order. All mail HTML passes one shared sanitizer. Spec: `docs/superpowers/specs/2026-08-19-conduit-phase-4-email-design.md` — read it first; it is the authority on semantics.

**Tech Stack:** New api deps: `imapflow`, `mailparser`, `nodemailer`, `sanitize-html` (+ `@types/nodemailer`, `@types/mailparser`, `@types/sanitize-html`). New web deps: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`. Lockfile MUST be regenerated on the server (`./scripts/remote.sh npm install`) — a macOS-generated lockfile omits Linux binaries.

---

## Conventions

Identical to Phase 3's plan: `./scripts/remote.sh` for every command (the worktree lacks the untracked `.conduit-remote` — copy it from the main checkout before the first run); NodeNext `.js` extensions in api, none in web; ASCII-only sources with `\u` escapes, byte-scan before commit (email fixtures included — encode any non-ASCII test content as escapes); ApiError code/status branching; testids for structure, roles for controls; Playwright ONLY in CI (iterate via push + `gh run view --log-failed`). Suite at start: 603 unit + 31 e2e, green. Hardened service pattern per `services/deals.ts`/`tasks.ts` (atomic guards, publish-after-commit SSE hints). Mail's folder cursors need no advisory locks — each AccountSync serialises its own account in-process and never two writers race one folder cursor — but global thread resolution does take one: `mail-ingest.ts` holds `lockSiblingGroup(tx, "mail:ingest")` (pipelines.ts's `pg_advisory_xact_lock` helper) for its WHOLE ingest transaction — acquired as the first statement, so the duplicate guard's read and the attachment blob writes sit inside it too, not just thread-resolution+insert — because threads are global and two AccountSyncs ingesting related messages concurrently would otherwise each find no ancestor and split one conversation into two threads. `mail-send` (Task 6) must take the same lock wherever it resolves or creates a thread.

0004's indexes (the search GIN index, mail_messages(thread_id)/(message_id)/(account_id, folder, imap_uid)/(thread_id) WHERE seen = false — the unread badge's partial index, added by Task 7's quality review, 41ms → 4.9ms at 85k messages — mail_attachments(message_id), mail_threads(last_message_at DESC, id DESC), and the four mail_threads FK columns) are hand-written directly into `drizzle/0004_*.sql` — they exist in the database but have no representation in `schema.ts` or the drizzle-kit snapshot. Two consequences for every later task: never introduce `drizzle-kit push` to this project (it diffs schema.ts against the live database and would DROP every one of these indexes, having no record of them); and declaring any one of them later via drizzle's `index()` builder requires first deleting its hand-written `CREATE INDEX` statement, or a future `db:generate` will try to create a duplicate.

## File structure

| Path | Responsibility |
|---|---|
| `packages/api/drizzle/0004_*` + `db/schema.ts` | mail_accounts, mail_folder_state, mail_threads, mail_messages (tsvector generated column), mail_attachments, email_templates |
| `packages/shared/src/index.ts` | mail zod schemas + inputs (account create/update/test, thread list filters, links, send, template) |
| `packages/api/src/services/mail-crypto.ts` | key-file load (lazy, memoised), AES-256-GCM encrypt/decrypt `v1:iv:tag:data` |
| `packages/api/src/services/mail-content.ts` | sanitizer profile, cid rewrite, snippet, subject normalisation, address extraction, synthetic message-id |
| `packages/api/src/services/mail-accounts.ts` | owner-scoped CRUD/archive, test-connection, other-users minimal list |
| `packages/api/src/services/mail-ingest.ts` | one-transaction ingest: parse → sanitize → attachments → thread → auto-link → upsert → SSE hint |
| `packages/api/src/services/mail-sync.ts` | `ImapClient` interface, `AccountSync` state machine, `SyncManager` lifecycle |
| `packages/api/src/services/mail-imapflow.ts` | real imapflow adapter (CI-integration-tested only) |
| `packages/api/src/services/mail-send.ts` | authz → MIME build → SMTP → APPEND → DB → SSE |
| `packages/api/src/services/mail-threads.ts` | thread list (keyset)/detail/read/links/archive, deal suggestions, attachment lookup, unread count (added in Task 7: routes stay thin per house convention) |
| `packages/api/src/services/mail-templates.ts` | shared template CRUD/archive, sanitised on write |
| `packages/api/src/routes/mail.ts` | REST per conventions; search gains mail |
| `packages/api/src/test/mail-integration.test.ts` | env-gated Dovecot/Mailpit integration (CI) |
| `packages/web/src/pages/{inbox,settings-mail,settings-templates}.tsx` | pages |
| `packages/web/src/components/mail/{thread-list,conversation,message-frame,link-panel,composer}.tsx` | inbox pieces (thread-list reused by record Mail tabs) |
| `packages/web/src/pages/{contact,company,deal,project}-detail.tsx` | + Mail tab |
| `.github/workflows/test.yml` | Dovecot + Mailpit services on both jobs |
| `scripts/{install,upgrade,backup,restore}` | `$data_dir/mail.key` lifecycle |
| `e2e/mail.spec.ts` | the Phase 4 journey |

---

### Task 1: Schema 0004 + shared contracts

Drizzle: the six tables per the spec verbatim (every column, CHECK, default, UNIQUE and FK listed there — `mail_folder_state` UNIQUE (account_id, folder); `mail_messages` UNIQUE (account_id, message_id), `security`/`status`/`direction` CHECKs). The tsvector column via a `customType` emitting `tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(from_addr,'') || ' ' || coalesce(from_name,''))) STORED` — drizzle-kit will not generate this; write it (and the GIN index, plus indexes on mail_messages(thread_id), mail_threads(last_message_at), and the four thread FKs) into the migration SQL by hand after `db:generate`, the Phase 1 search-migration precedent. Shared: `mailAccountSchema` (NO credential fields in the output schema — assert this in a test), `mailAccountCreateInput` (single `password` + optional `smtpPassword`), `mailAccountTestInput`, `mailThreadSchema`, `mailMessageSchema`, `mailAttachmentSchema`, `threadListFilters`, `threadLinksInput` (`{ kind: company|contact|deal|project, id }`), `sendMailInput` (`{ accountId, threadId?, to[], cc[], bcc[], subject, bodyHtml, attachmentIds[], links? }`), `emailTemplateSchema` + inputs. (SSE uses the existing key-hint mechanism, not named events — keys are specified per task.) Migration test with pre-existing data rows (0002-style). Run `./scripts/remote.sh npm install` to add the api deps + regenerated lockfile in THIS task so later tasks have them. ~10 tests.

### Task 2: mail-crypto + mail-content

`mail-crypto.ts`: `loadMailKey()` — reads `MAIL_KEY_PATH` (config.ts gains it, default `${DATA_DIR}/mail.key`), 32 bytes exact or throw; memoised; missing file → typed `MailKeyMissingError` (routes map to 503). `encryptCredentials(obj)` / `decryptCredentials(str)` — AES-256-GCM, random 12-byte IV, format `v1:<iv b64>:<tag b64>:<data b64>`. Tests: roundtrip, tamper (flip a ciphertext byte → throws), wrong key size, missing file, unknown version prefix.

`mail-content.ts` (pure, no DB):
- `sanitizeMailHtml(html, { cidMap? })` — sanitize-html profile: allow structural/text tags + `table` family + `img` + `a` + a bounded inline-`style` property allowlist (color/font/text-align/margin/padding/border/width/height/line-height/vertical-align, value regexes excluding `url(`); strip `script/style/iframe/object/embed/form/input` and all `on*` attrs; `a` gains `rel="noopener noreferrer" target="_blank"`; `img src` allowed schemes http/https/`mailattachment` (a stable placeholder scheme) — cid:X rewritten via cidMap to `mailattachment:<id>`, unmapped cid dropped. No absolute path is ever baked into stored HTML (would break on YunoHost `change_url`); a separate pure helper `resolveAttachmentUrls(html, apiBase)` swaps the placeholder for `${apiBase}/api/mail/attachments/<id>/inline` at serve time (Task 7 calls it on read, never persists the result). Remote images stay in the markup — blocking is render-time (message-frame CSP), not ingest-time.
- `normalizeSubject(s)` — iteratively strip leading `re:/fw:/fwd:` (case-insensitive, optional `[n]`, no space between word and bracket), collapse whitespace, hard-capped at 1000 input chars; empty → `''` (matches the DB default — "(no subject)" is a display placeholder the web layer renders, not something normalizeSubject or the stored/hashed data should bake in; see Task 10).
- `makeSnippet(text)` — collapse whitespace, first 160 chars.
- `syntheticMessageId(parsed)` — `sha256:` + hex over from_addr + ISO sent_at + subject + first 1k of body_text (stable across refetch).
- `extractAddresses(parsed)` — mailparser AddressObject → `{address (lowercased), name}` arrays for from/to/cc/bcc.
~18 tests (sanitizer matrix is the bulk; fixtures ASCII with `\u` escapes).

### Task 3: Accounts service

`mail-accounts.ts`: `createAccount(db, userId, input)` (encrypt creds; smtpPassword defaults to password), `updateAccount` (a lone `password` sets BOTH imap+smtp, matching create's default; `smtpPassword` submitted alongside it wins for smtp; `smtpPassword` alone changes only smtp, carrying the stored imap password forward; both fields empty/absent keeps both stored — quality-review ruling, 19 Aug), `archiveAccount`, `unarchiveAccount` (mirror; re-adding an archived mailbox as a new row would re-ingest and duplicate every thread it touches), `getOwnAccount` (decrypts NOTHING — a separate `getAccountCredentialsAsSystem(db, id)` is the only decrypt path, used by sync/send/test; no owner check by design, and named accordingly), `listAccounts(db, userId)` → own rows full (minus creds) + others as `{id, label, email}` (assert shape in test), `testConnection(db, userId, input, deps)` — deps-injected `{ imapVerify, smtpVerify }` (real impls arrive Task 6; unit tests inject fakes) returning per-protocol `{ok, error?}`. Owner checks on every mutating path (NotFoundError for other users' accounts — existence must not leak settings). Duplicate-mailbox prevention: ConflictError on create/email-change against a non-archived (user, lower(email)) collision, backed by a hand-written partial unique index. SSE `[["mail-accounts"]]`. ~14 tests.

### Task 4: Ingest service (threading + auto-linking)

`mail-ingest.ts`: `ingestMessage(db, accountId, folder, uid, raw, flags)` — ONE transaction:

```typescript
// 1. Parse (mailparser simpleParser), build fields per spec: message_id (or
//    syntheticMessageId), direction = from == account.email (case-insensitive),
//    seen from flags.
// 2. Upsert guard: ON CONFLICT (account_id, message_id) DO UPDATE
//    folder/imap_uid/seen only -- a refetch or cross-folder sighting must not
//    duplicate, re-thread, or re-link. If the row existed, STOP (return it).
// 3. Thread resolution: walk references right-to-left, then in_reply_to; first
//    id found in mail_messages (any account -- threads are global) wins. None ->
//    INSERT mail_threads (normalised subject, last_message_at = sent_at).
// 4. Attachments: store via blobs service, INSERT mail_attachments, build cidMap,
//    THEN sanitize html with it (order matters -- ids must exist first).
// 5. INSERT message; bump thread message_count + last_message_at = GREATEST(...).
// 6. Auto-link: if thread.contact_id IS NULL, match participants (from,to,cc
//    lowercased, in that order) against non-archived contacts.emails; first hit
//    sets contact_id, and its company_id fills thread.company_id only when NULL.
//    Manual links are never overwritten (contact_id set = do not touch).
// 7. SSE hint after commit: [["mail-threads"], ["mail-thread", threadId],
//    ["mail-unread"]].
```

Fixture-driven tests (~20): in-order chain threads; out-of-order backfill converges (child before parent — child starts thread, parent's own references walk finds nothing, BUT a later sibling referencing both joins the child's thread — assert the documented behaviour); no-references new thread; subject normalisation; missing Message-ID synthetic id stable across double-ingest; duplicate upsert no-op; direction detection; auto-link matrix (from-match, to-match, cc-match, no match, archived contact skipped, manual-link preserved, company only filled when NULL); attachments + cid rewrite; seen flag.

### Task 5: Sync engine (fake-client driven)

`mail-sync.ts`:

```typescript
export interface ImapClient {
  connect(): Promise<void>;                      // throws -> backoff
  disconnect(): Promise<void>;
  status(folder): Promise<{uidvalidity}>;        // uidnext dropped: never read
  // AS BUILT (Task 5), per the lazy-fetch decision below: descriptors only,
  // no bodies -- ascending, {sinceUid, limit, sinceDate} carries the
  // backfill window (SEARCH SINCE) for the adapter.
  fetchNewer(folder, {sinceUid, limit, sinceDate}): Promise<{uid, flags}[]>;
  fetchRaw(folder, uid): Promise<Buffer|null>;   // null = expunged meanwhile
  fetchFlags(folder, sinceDate): Promise<{uid, flags}[]>;
  append(folder, raw, flags): Promise<void>;
  addFlags(folder, uids, flags): Promise<void>;  // \Seen write-back, ADD not SET
  idle(signal): Promise<"new-mail"|"aborted">;  // INBOX only
}
```

**This interface, its types, `SyncClock`, `SyncLogger` and `IngestMessageFn` live in `services/mail-imap.ts`** (re-exported from mail-sync.ts), which carries the FULL adapter contract as doc comments -- that is the file Task 6 reads. In summary: `connect()` is called on a fresh instance every time (imapflow throws on re-connect, so the factory must never cache or singleton a client); `disconnect()` must be safe after a failed `connect()` (use `close()`, not `logout()`, there); NOTHING except `idle()` is cancellable, so the adapter MUST set `connectTimeout`/`greetingTimeout`/`socketTimeout` -- they are the only bound on shutdown besides SyncManager's own 15s race; after abort fires the next command may be issued before `idle()`'s promise settles (imapflow's DONE preCheck makes this safe -- a contract, not a coincidence); `status()` must convert BigInt `uidValidity` to Number; throw wherever imapflow RETURNS falsy (`status` false, `search` undefined, `fetchOne` false, `download` {}) rather than passing an empty result through; `addFlags` must use `messageFlagsAdd` (NOT `messageFlagsSet`, which REPLACES the flag set and would wipe `\Answered`/`\Flagged`/keywords); `append` takes no INTERNALDATE and returns nothing on purpose (the next Sent pass re-sights it); `fetchFlags` is deliberately limitless at a 30-day window. `fetchNewer` carries an **exactly-limit contract**: return exactly `limit` descriptors whenever at least `limit` UIDs above `sinceUid` exist -- a short batch means the folder is exhausted, and a short-but-not-exhausted batch silently truncates the sync. Cost model: IMAP SEARCH has no LIMIT, so the intended strategy is to cache the UID list keyed on the (folder, sinceUid-chain) of one walk and slice it across batches, discarding the cache on any call that does not continue the chain.

A UID list plus a per-UID `fetchRaw`, rather than an async iterator yielding bodies, for three reasons recorded on the interface: both consumers of a batch address messages BY UID (the poison contract retries one UID; the cursor advances to a batch's highest), an iterator held open across a batch would pin the adapter's mailbox lock across 50 ingest TRANSACTIONS (each taking the global ingest advisory lock and writing blobs), and it maps directly onto imapflow (`fetch` for flags, `fetchOne(uid, {source:true})` per message).

`AccountSync(db, account, client, opts)` — single async loop, all work serialised:
- Pass = for INBOX + sent_folder: `status()`; UIDVALIDITY mismatch → reset cursor to 0 (dedupe makes refetch converge); fetch in batches of 50 ascending from `last_seen_uid` (skipping messages older than `backfill_days` on the first-ever pass — filter by INTERNALDATE, the adapter handles it via SEARCH SINCE), ingest each, advance cursor AFTER each batch (resume property); then `fetchFlags(folder, now - 30d)` reconcile `seen`.
- Between passes: `idle(signal)` (INBOX only, by design) capped at `pollIntervalMs` (default 300_000, injectable) — a "new-mail" outcome or an elapsed cap triggers the next pass.
- Errors anywhere: `status='error'` + `last_error`, backoff `min(60s * 2^attempt, 32min)` (timer injectable), successful pass resets `status='active'`, `last_synced_at`, attempt=0. Both the backoff and the poll wait are DEADLINES, not fresh timers per entry (quality-review ruling): an interrupted wait resumes its remainder, so repeated queued work can neither starve the poll (fatal on a no-IDLE server, where the poll is the only fetch) nor hand every task its own connect attempt straight through the backoff's rate limit. While an account is in backoff, `markSeen`/`appendSent` reject immediately with `SyncUnavailableError` carrying the stored `last_error`, rather than opening a connection. A server that rejects IDLE is latched after the FIRST rejection (logged once, at info) and polled thereafter; the latch clears on recovery from a pass-level failure or a manager restart, not on the reconnect the rejection itself causes -- clearing there would reinstate the 288-per-day log-and-reconnect cycle the latch removes. Every status flip publishes `[["mail-accounts"]]` (drives the settings error badge).
- `markSeen(folder, uids)` and `appendSent(raw)` queue onto the same serial loop (exposed for routes/send). Queued work wakes the loop but does NOT mark a pass due (spec review, Task 5): Task 7 calls `markSeen` once per thread the user opens, and a status/fetchNewer/fetchFlags round over both folders per click would be waste. Passes run only on an IDLE wake, the poll timer, an elapsed backoff, or an explicit `syncNow`. During a backoff, queued work is rejected outright (`SyncUnavailableError`) and never touches the wait — the backoff deadline is resumed, never restarted.
- **UIDVALIDITY re-walk clears stored UIDs first (spec review, Task 5):** a re-walk only re-sights messages inside the `backfill_days` window, so rows older than it would keep UIDs from the dead namespace — and both `reconcileFlags` and Task 7's `\Seen` write-back match on (account, folder, imap_uid), so a renumbered mailbox would apply one message's flags to another message's row. `loadCursor`'s mismatch branch therefore runs `UPDATE mail_messages SET imap_uid = NULL WHERE account_id = ? AND folder = ?` in the same transaction as the cursor reset, before the re-walk; rows the re-walk re-sights get a fresh UID from ingest's duplicate-guard UPDATE.
- `stop()` — abort idle, disconnect, resolve.
- **Poison-message contract (ruling, Task 4 quality review):** every `ingestMessage` call is individually try/caught — ingest raises one typed `MailIngestError` carrying accountId/folder/uid plus a ≤200-char reason (services/errors.ts), so the loop has what it needs without unwrapping driver errors. First failure for a UID: retry it once within the same pass. Second failure: **advance the cursor past that UID** and record the truncated reason in `last_error`, leaving `status='active'` — one unparseable, oversized or otherwise hostile message must never wedge a mailbox behind a cursor that will not move. Nothing is deleted: the message stays on the server and a later manual refetch (cursor reset) can retry it. This is the one error class that does NOT flip the account to `error` + backoff.
- **Fetching:** pull each message's raw body lazily, one at a time inside the per-message loop — never materialise a batch of 50 raw buffers (50 × up to 25MB is a heap spike no server needs). Ingest applies two guards of its own before `simpleParser`, both surfacing as `MailIngestError` and therefore handled by the poison contract above: **25MB on the whole message**, which bounds memory and disk (parse buffer, decoded parts, blob writes), and **64KB on the header block** (lowered from 256KB in Task 5's prelude — the final Task 4 review measured a 7.2s worst case at 256KB with minimal addresses, i.e. under the cap and therefore accepted; 64KB puts it under a second and is still an order of magnitude above any real header block), which bounds parse TIME. The second is the one that matters for hostile input — mailparser's address parsing is superlinear in address count, so a ~1MB message (a 709KB `To:` header, 2.7% of the raw cap) measured 6.1s and ~150k addresses stalled the event loop >8min, all of it well under the whole-message cap.
- **SSE coalescing** is a batch-boundary decision, not a per-message one: ingest publishes its own `[["mail-threads"], ["mail-thread", id], ["mail-unread"]]` hint per new message, so a 50-message backfill batch fires 150 key hints. If that proves noisy in the web layer, coalesce at the end of each batch (one hint per pass) rather than suppressing ingest's — ingest has no idea whether it is inside a batch.
- **SSE coalescing — DECIDED (Task 5): accept the per-message hints; the sync loop adds no coalescing of its own.** Three reasons, recorded as a comment on the batch loop in `mail-sync.ts`. (1) Measured cost is trivial where it lands: `publish()` is a synchronous fan-out with no I/O, 2.9us per hint across 5 subscribers on the dev server (15,000 hints, i.e. a 5000-message first backfill, = 44ms of CPU total), and a hint frame is ~106 bytes. (2) Decisively, **the web layer already coalesces**: `components/sse.tsx` buffers incoming keys in a Map (duplicates collapse) behind a 100ms debounce that RESTARTS on every frame, so a backfill streaming hints continuously produces ONE invalidation round when it pauses. Coalescing server-side would sit upstream of a mechanism that is strictly better at it — it dedupes across batches and knows the render cost. (3) The storm-shaped case is already silent at the source: a UIDVALIDITY reset re-walks a whole folder and ingest publishes nothing for a re-sighting that changed no field. What still publishes per message is genuinely new mail, which is exactly what IDLE exists to surface promptly.

`SyncManager` — constructed with `{db, dataDir, mailKeyPath, clientFactory, clock?, logger?, pollIntervalMs?}`, `start()` loads non-archived accounts → AccountSync each; `accountChanged(id)` create/restart/teardown after CRUD (per-account promise chain, so overlapping reconciles can never leave two loops on one mailbox); `syncNow(id)`; `get(id)` for send/markSeen access; NOT started under NODE_ENV=test (`startSyncManager()` is the gate, checking both the parsed config value and `process.env`). Wired into server.ts after listen, and into the SIGTERM/SIGINT path before `app.close()`. `accountChanged` reaches mail-accounts.ts through a hook the manager REGISTERS there (`setAccountChangedHook`, returning an unregister function) — the same direction as stream.ts registering with sse.ts's `subscribe()`, chosen because mail-sync must import `getAccountCredentialsAsSystem` from mail-accounts and the reverse import would be a cycle. Tests (~16, fake ImapClient + fake timers): backfill honours backfill_days & resumes mid-batch after injected crash; cursor advance; UIDVALIDITY reset converges without dupes; flag reconcile flips seen; idle wake triggers pass; backoff doubles & caps & resets; error → status flip; stop is clean; markSeen writes flags through; manager teardown on archive.

### Task 6: imapflow adapter + send service

`mail-imapflow.ts`: `ImapflowClient implements ImapClient` — imapflow with `secure`/STARTTLS per `imap_security`, mailbox locks around ops, SEARCH SINCE for the backfill filter, `client.idle()` with AbortSignal race. Also export `imapVerify(settings)` / `smtpVerify(settings)` (nodemailer `verify()`) and wire them as the real deps of Task 3's testConnection. Unit tests: none beyond construction — this file is covered by Task 8's integration suite; keep it thin enough that that is honest.

**Moved here from Task 8 (done, 20 Aug):** `config.ts`'s `MAIL_TLS_REJECT_UNAUTHORIZED` (default `1`; `0` makes the adapters pass `rejectUnauthorized: false`) is adapter-owned, so it landed with the adapter rather than with the CI job that uses it. Task 8 only has to SET the env now. server.ts passes `config.mailTlsRejectUnauthorized` into the client factory; `imapVerify`/`smtpVerify` read the env directly, because `TestConnectionDeps` fixes their signature and leaves no room for a config parameter.

`mail-send.ts`: `sendMail(db, actorId, input, deps)` — deps `{ transportFactory, syncManager }`:

```typescript
// 1. Account owner check (actor owns accountId, status active). Reply: load
//    thread + last inbound-or-any message for In-Reply-To/References chain.
// 2. sanitizeMailHtml(bodyHtml) (no cidMap); text alt via html-to-text-lite:
//    strip tags + entity decode (write a 15-line helper in mail-content.ts,
//    not a new dep). Attachments: load mail-compose uploads by id (files
//    service rows owned by actor), stream from blob storage.
// 3. nodemailer sendMail via transportFactory(account). Failure -> ApiError 502
//    "smtp_failed", NOTHING stored.
// 4. syncManager.get(accountId)?.appendSent(rfc822) -- try/catch, log.warn on
//    failure, proceed (spec: send succeeded, DB record must land).
// 5. Call ingestMessage(db, dataDir, {accountId, folder: account.sent_folder,
//    uid: null, raw: <the MIME just sent>, flags: ["\\Seen"], threadId?,
//    links?}) -- the WHOLE row, not "ingest primitives": ingest stays the
//    single writer of mail_messages/mail_threads/mail_attachments (ruling,
//    Task 4 quality review), so direction, threading, the thread bump,
//    auto-linking, the advisory lock and the SSE hint all happen once, in
//    one place. threadId short-circuits thread resolution on a reply; links
//    apply only when a new thread is created. It also makes the later
//    Sent-folder sighting of the same message dedupe onto this row via
//    UNIQUE (account_id, message_id) instead of duplicating it.
// 6. Return the message row (ingest published the SSE hint).
```

Tests (~12): ordering matrix (SMTP fail → no row; APPEND fail → row + warn), reply headers chain, new-thread links applied, owner check (404 on foreign account), sanitization applied, text alt generated, attachment streaming, archived/error account rejected (409).

### Task 7: Routes + templates + search

`mail-templates.ts`: CRUD/archive/unarchive (archive-not-delete, so unarchive too, like accounts), `body_html` sanitised on write, shared (no owner column). A body that sanitises away to nothing is refused (409) rather than stored -- `emailTemplateSchema.bodyHtml` is `.min(1)`, so an empty stored body would be a row no client could parse back. ~6 tests.

`mail-threads.ts` (AS BUILT, Task 7): the thread query/mutation service the route file delegates to -- list (keyset), detail, mark-read, links, archive, deal suggestions, attachment lookup, unread count. Not in the original file table; added because every other route file in this codebase is thin over a service, and putting this much SQL in `routes/mail.ts` would have broken that. Threads are SHARED (no per-user visibility column), so nothing here is owner-scoped -- accounts and send remain the only owner-scoped mail surfaces. The list returns `mailThreadListItemSchema` (thread + `unread`, `snippet`, `participants`, `accountIds`), derived per page from the threads' messages in two extra queries rather than denormalised onto `mail_threads` -- that is exactly the row Task 10's thread-list renders (unread dot, participants summary, snippet, account chip), so Tasks 9/10 need no further API change for it.

`routes/mail.ts` per the spec's route list verbatim: accounts (list/create/update/archive/unarchive/test), threads (list with filters + keyset pagination by (last_message_at, id) — pagination.ts pattern; detail with messages + attachments + deal suggestions (open deals matching thread contact/company, newest 5); read → db update + best-effort `syncManager.get().markSeen` per account/uid group; links set/clear; archive/unarchive), send, attachments (`GET /:id` download + `GET /:id/inline` — inline only when `is_inline`, correct content-type, `Content-Disposition: attachment` on the download route, `X-Content-Type-Options: nosniff` on both; AS BUILT the inline route also refuses to DECLARE a non-image content type, serving such a row as an octet-stream download instead -- nosniff stops a browser guessing `text/html`, not a response that says so, and the sanitiser permits an ordinary https link to this app's own attachment route), templates, `GET /api/mail/unread-count` → `{count}` of distinct non-archived threads having an unseen message. Search service + route + tests gain `mail` group: `websearch_to_tsquery('english', q)` against the tsvector, thread-grouped (best-ranked message per thread, ts_rank ordered, limit 5), archived threads excluded. Route tests (~20): happy + 400/404/409 per family, credential leak assertions (list/create/update responses NEVER contain password/ciphertext fields), foreign-account 404s, filter combos, unread count, search relevance smoke.

### Task 8: CI Dovecot + Mailpit integration

TLS story (settled here, used by Tasks 8 and 11): the account schema keeps its strict `tls|starttls` CHECK — no plaintext mode exists anywhere. CI Dovecot serves IMAPS on 993 with a self-signed cert; Mailpit serves STARTTLS on 1025 with its built-in self-signed cert. `MAIL_TLS_REJECT_UNAUTHORIZED` (default `1`; when `0`, CI only, the adapters pass `rejectUnauthorized: false` to imapflow/nodemailer) already exists — it shipped with the adapter in Task 6, since that is what owns it. This task only sets it in the workflow env.

`.github/workflows/test.yml`: `mailpit` (image `axllent/mailpit`, ports 1025/8025) fits the `services:` block. Dovecot needs config files (passwd-file auth: one user `conduit@test.local` / `testpass`, self-signed cert), and `services:` containers start before the workspace exists — so start it in a step instead: write the config + `openssl req` cert to a temp dir, then `docker run -d -v` the `dovecot/dovecot:2.3-latest` image, port 993. Add that step to both jobs. `packages/api/src/test/mail-integration.test.ts`, top-level `describe.skipIf(!process.env.MAIL_IT)`; test.yml sets `MAIL_IT=1`, host/port env, and `MAIL_TLS_REJECT_UNAUTHORIZED=0`.

**Drive `ImapflowClient` / `createImapClientFactory` / `createSmtpTransportFactory` — never raw imapflow or nodemailer.** These tests are the only place the real adapter runs, so they must exercise the adapter's own translation layer (option mapping, falsy-return handling, error normalisation, the walk cache); a test that talks to the library directly proves the container works and nothing about the code that ships.

Integration coverage — the seven from Task 6's handoff: login; APPEND then fetchNewer sees it; flags roundtrip via addFlags/fetchFlags; SEARCH SINCE backfill filter; idle wake on APPEND (with timeout guard); smtpVerify against Mailpit; send through the transport factory → Mailpit's API shows the message. Plus eight the Task 6 quality review identified as unit-untestable and therefore uncovered until here:

1. **Walk cache against a real SEARCH**: seed more than one BATCH_SIZE of messages and walk the folder to exhaustion through `fetchNewer`, asserting every message arrives exactly once — the cache's continuation keys are unit-tested as pure functions, but only a real server proves they line up with what the loop actually passes.
2. **Exactly-limit for real**: with N > limit messages present, one call returns exactly `limit` descriptors.
3. **`uid: "n:*"` past the end of the mailbox**: a cursor above the highest UID must return nothing. IMAP evaluates that range against the highest existing UID, so the adapter's `> sinceUid` filter is the only thing stopping it re-fetching the last message forever.
4. **STARTTLS both directions**: `doSTARTTLS: true` succeeds against a server offering it, and FAILS (rather than silently continuing in the clear) against one that does not — the whole point of requiring rather than opportunistic upgrade.
5. **`rejectUnauthorized` actually reaches the socket**: the same connection succeeds with `MAIL_TLS_REJECT_UNAUTHORIZED=0` and fails without it, against Dovecot's self-signed cert.
6. **The `'error'` listener under a real disconnect**: kill the connection mid-IDLE and assert the process survives (an unhandled `'error'` event on the client would take the server down).
7. **Error normalisation against real failures**: wrong password → `auth:`; wrong port → `connection:` (the `ClosedAfterConnectText` case); STARTTLS demanded but unavailable → `connection:` (the codeless `tlsFailed` case).
8. **APPEND to a missing folder, and `status().uidvalidity` is `typeof "number"`** (not a BigInt) — the one that would otherwise re-walk every folder forever.

Iterate via push; keep total runtime under ~90s. The e2e job's app boot env also gets `MAIL_TLS_REJECT_UNAUTHORIZED=0` plus `E2E_MAIL_*` host/port env consumed by mail.spec.ts (Task 11).

**AS BUILT (20 Aug).** `.github/scripts/start-dovecot.sh` + `wait-for-mail.mjs`, `packages/api/src/test/mail-integration.test.ts` (26 cases, ~16s). Four things the sketch above did not anticipate:

- **Mailpit has to be told to make a certificate.** It ships none: with `MP_SMTP_TLS_CERT` unset it never advertises STARTTLS at all, and nodemailer's `requireTLS` then correctly refuses to send. `MP_SMTP_TLS_CERT=sans:localhost,127.0.0.1` (and the matching `_KEY`) has it generate a self-signed pair at boot — which is what keeps it in `services:`, since it still needs no workspace file. `MP_SMTP_AUTH_ACCEPT_ANY=true` goes with it, and Mailpit only advertises AUTH LOGIN/PLAIN once encrypted, so the credentials still cross after the upgrade rather than before it.
- **Two Dovecots.** One instance cannot be both halves of case 4: it cannot offer STARTTLS on 143 and also not offer it. `conduit-dovecot` serves 993 + 1144, `conduit-dovecot-nostarttls` serves 1143 with `ssl = no`.
- **The test folders are Dovecot config.** `ImapClient` has no create-mailbox call and no expunge, so a suite that made or cleared its own folders would have to reach past the adapter — which the "never raw imapflow" rule forbids. Sent/Walk/Drop/Flags/Dates/Big/Empty are `auto = create` mailboxes, and every case records the folder's highest UID before it appends.
- **`SEARCH SINCE` is not what goes on the wire.** imapflow rewrites `since` to RFC 5032 `YOUNGER <seconds ago>` whenever the server advertises WITHIN, which Dovecot does — so the window is second-granular, not the whole-day granularity RFC 3501 gives, and a `sinceDate` at or after `now` clamps to `YOUNGER 0`, which Dovecot rejects as BAD. Unreachable from the app (every window is a positive number of days in the past) but documented on `fetchFlags` and asserted in the suite.

**One adapter defect** it found, fixed here: imapflow rejects every NO/BAD with the bare message `"Command failed"` and parks the server's own sentence on a property, so a renamed Sent folder reached `mail_accounts.last_error` as `"Command failed"`. `normalizeMailError` now folds the reply in, reading `responseText` first — the connection sets that for every NO/BAD, and for FETCH (the sync loop's hottest path), NOOP, IDLE and STATUS it is the only one there is — and falling back to `response` only when it is a string, since its original shape is the parsed response object and `status()` puts an `Error` there.

**One defensive hardening, not a defect.** `append`'s falsy guard widened from `=== false` to `!result`. The earlier note here claimed the runtime could return `undefined`; it cannot — imapflow 1.7.1 coerces with `|| false` at the public `append()` boundary (`imap-flow.js:3401`), so the `.d.ts` and the runtime agree and the old guard was already sufficient. A refused APPEND throws, which is the path the suite exercises. The wider guard is kept because it costs nothing if that coercion ever moves.

Also unrecorded until now: both jobs' `timeout-minutes` went 15 → 20, for the container pulls and boot the mail servers add.

Waived, with reasons: a mid-stream download failure and the falsy-SEARCH/FETCH returns (not inducible against a real server without a proxy; the pure functions are unit-tested); a read-only mailbox's `NO` on a flag write (needs the ACL plugin); a UIDVALIDITY change mid-pass (no adapter call creates or deletes a mailbox — convergence is covered by mail-sync.test.ts); the `ClosedAfterConnectText` permutation specifically (a plaintext client against 993 deadlocks until the 15s greeting timeout, which is a sixth of the suite's budget for a case whose classification three other cases already prove); and **case 6 is PARTIAL** — the connection is torn down client-side, because nothing Dovecot can be told to do hangs up on an idling client on demand. That proves the wait ends cleanly and no unhandled rejection escapes; it does not prove the constructor's `'error'` listener is load-bearing, which needs a server-side kill.

### Task 9: Web — settings, hooks, composer

`./scripts/remote.sh npm install` for the TipTap deps (lockfile!). Hooks in queries.ts (parseWith, SSE-mirrored invalidation): `useMailAccounts`/`useCreateMailAccount`/`useUpdateMailAccount`/`useArchiveMailAccount`/`useTestMailAccount`, `useMailThreads(filters)`/`useMailThread(id)`/`useMarkThreadRead`/`useSetThreadLinks`/`useArchiveThread`, `useSendMail`, `useMailTemplates` + CRUD, `useUnreadCount` (SSE `mail.message` invalidates). No Settings area exists yet — this task creates it: a `Settings` nav entry in shell.tsx with `/settings/mail` and `/settings/templates` routes (registered per the existing route registration pattern; a plain two-tab settings layout, no framework). Mail accounts page: account cards with status/error badge + last_synced_at, add/edit dialog (label, email, IMAP/SMTP host/port/security selects, username, password fields blank-means-keep, sent folder, backfill select 30/90/all, "Local Dovecot" preset button filling host=localhost, imap 993 tls, smtp 587 starttls, username = current username), Test connection button rendering per-protocol results, signature TipTap editor per account, archive. The password field submits as mail-accounts.ts's single `password` (covering both imap+smtp) when the form's "SMTP differs" toggle is off, and as `password`+`smtpPassword` together when it is on — there is no third state. Settings → Templates page: list + editor dialog (name, subject, TipTap body). `components/mail/composer.tsx`: TipTap (StarterKit + Link), To/Cc/Bcc token inputs with contact-email autocomplete (useContacts search), account select (own active), template picker (applies subject when composing fresh, body inserted at cursor; `{{contact.name}}`/`{{company.name}}`/`{{user.name}}` substituted from props context, unresolved left literal), signature block appended on account select, attachment upload via existing files multipart hook, send → useSendMail with pending/error states. Composer is a controlled dialog component — inbox and record pages mount it with different seeds. Testids: `mail-settings`, `mail-account-<id>`, `composer`, `composer-send`.

Two contracts Task 7 hands over (quality review, 20 Aug):

- **`syncStats` freshness is this page's job.** `GET /api/mail/accounts` returns each own account's live sync counters as of that fetch, and nothing keeps them current — they are in-process counters, not rows, so no write publishes a hint when they move (`[["mail-accounts"]]` fires on account mutations and status flips, a much rarer event). The Settings mail page therefore owns freshness for its own view via a `refetchInterval`; every other consumer treats `useMailAccounts` as an SSE-invalidated cache of the account ROWS and must not depend on stats being current. Anything else needing a live counter needs its own endpoint, not a shorter assumption about this one.
- **Mail mutation hooks must invalidate `["search"]` themselves.** The mail SSE hints (`mail-threads`/`mail-thread`/`mail-unread`/`mail-accounts`/`email-templates`) deliberately do not carry a search key, so an ingest or a thread archive does not invalidate the global search cache on its own — the same division of labour every Phase 1-3 hook already follows (each mutation hook lists `["search"]` among its own invalidations). Follow it here rather than widening the server-side hints.

As built (Task 9, 20 Aug) — seven deviations from the paragraph above:

- **`parseWith`, not casts.** Every fetcher in queries.ts validates its response through `parseWith`
  (only api.ts casts), and the mail hooks follow that, so contract drift fails loudly.
- **api.ts gained `deleteJson`.** `DELETE /api/mail/threads/:id/links/:kind` answers with the updated
  thread; the existing `deleteRequest` is for bare 204s and discards the body.
- **`useTestMailAccount` invalidates nothing** — the one deliberate exception to the "every mail
  mutation also invalidates `["search"]`" rule: `testConnection` writes no row, publishes no hint and
  does not even flip `status`, so there is no cache for it to have staled.
- **Hook names** settled as `useUnreadMailCount`, `useSetThreadLink`/`useClearThreadLink` (singular,
  matching the service's own `setThreadLink`/`clearThreadLink`), and templates as `useMailTemplates` +
  `useCreate`/`useUpdate`/`useArchive`/`useUnarchiveMailTemplate`.
- **StarterKit v3 bundles the Link extension**, so components/mail/rich-text.tsx registers
  `StarterKit.configure({ link: false })` alongside its own configured `Link` rather than both copies.
- **Signature append is once per account SELECTION**, at the end of the body, never matched-and-replaced:
  TipTap normalises the markup on the way in, so there is nothing reliable left to match a previously
  inserted block against.
- **The Settings nav highlight is computed**, not `activeProps`: one entry has to stay lit across both
  tabs, so shell.tsx tests `useRouterState`'s `location.pathname` against a literal `"/settings"`. That
  pathname is basepath-RELATIVE at every install path — a configured basepath installs router-core's own
  basepath rewrite, whose input leg slices the base off before the location is stored, which is the same
  fact every other nav item's basepath-relative `to`/activeProps already depends on. There is no bare
  `/settings` route — the nav links straight at `/settings/mail`.

Pure logic lives in two tested libs rather than inside the components: `components/mail/composer-lib.ts`
(recipient parsing and submit-time resolution, template substitution, the prefix→message mapping,
attachment target, error mapping) and `pages/settings-mail-lib.ts` (form state, validation, and the
four password-convention submission shapes).

### Task 10: Web — inbox, conversation, record Mail tabs

`/mail` route + nav item "Inbox" with unread badge (useUnreadCount). Two-pane: `thread-list.tsx` (virtualised not needed — keyset "load more" per house pattern; row: unread dot, participants summary, subject, snippet, relative time, account chip, link chips) + filter bar (account select, unread toggle, unlinked toggle, archived toggle); `conversation.tsx`: header (subject, link-panel), messages oldest-first collapsed except last (`message-<id>` testid, click expands), each body in `message-frame.tsx` — iframe `srcdoc` with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` (scripts still blocked: never add `allow-scripts`; see the popup ruling below) and an injected CSP meta tag: default state `default-src 'none'; img-src data: <app-origin>; style-src 'unsafe-inline'` (inline `cid:` attachments are app-origin, so they always render); the per-thread "Load remote images" button re-renders frames with `img-src` widened by `https: http:`. **`allow-same-origin`, not an empty sandbox** (coordinator ruling, 20 Aug; spec's Frontend bullet carries the same text): an empty sandbox gives the frame an opaque origin, SameSite cookies are therefore not sent with its subresource loads, and SSOwat bounces the cookieless inline-image requests to its login page — inline images would never render. Signed URLs would fix that but need SSOwat `skipped_uris` packaging changes. Scripts blocked + ingest-time sanitization + the CSP meta governing `img-src` make this the accepted risk, and it is why `GET /api/mail/attachments/:id/inline` (Task 7) is an ordinary authenticated same-origin route rather than a signed one. **Amended 20 Aug (coordinator ruling, reviewer-assessed): the sandbox also grants `allow-popups allow-popups-to-escape-sandbox`**, so a link in a message opens in a new tab the way it does in any mail client -- without the pair the sanitizer's own `target="_blank"` is inert and links do nothing, which reads as a broken app. Three layers already cover what the pair costs: the ingest sanitizer stamps `rel="noopener noreferrer"` on every anchor (so the opened tab cannot reach back through `window.opener`, and leaks no referrer), `-to-escape-sandbox` makes that tab an ORDINARY tab rather than one inheriting these flags, and the frame's `<meta name="referrer" content="no-referrer">` covers the rest. No CSP interaction (the popup flags live on the attribute; the policy must NOT gain a `sandbox` directive, which would re-impose the flags and break links again) and no change to the cookie story that motivated `allow-same-origin`. ACCEPTED consequence: `allowedSchemesByTag` only constrains hrefs that HAVE a scheme, so inbound mail can link the user's own CRM (a relative or same-origin href) and have it open in a new tab -- a GET-only, user-initiated nuisance, and the same permissiveness is what makes legitimate same-origin links to CRM records work. The flags NOT granted, and never to be: `allow-scripts`, `allow-forms`, `allow-top-navigation`, `allow-modals` (asserted by a unit test over `MESSAGE_FRAME_SANDBOX`). Frame sizing: fixed `max-h-[32rem] overflow-auto` (the sandbox blocks scripts, so no in-frame measurement — do not attempt auto-resize). Text-only messages render `<pre className="whitespace-pre-wrap">` directly, no iframe. Attachment chips (download links). `link-panel.tsx`: four link chips with unlink x, entity-picker popovers (existing search endpoints), deal-suggestion row (one-click link). Reply/Reply-all/Forward buttons seed the composer (forward inlines the quoted body; attachments are NOT re-attached -- see the as-built note). Record Mail tabs: contact/company/deal/project detail pages get a Mail tab (existing tab pattern from company-detail) rendering thread-list with the record filter + a Compose button seeded with the record's addresses/links. Testids: `inbox`, `thread-row-<id>`, `conversation`, `message-<id>`, `link-panel`, `deal-suggestion-<id>`, `load-remote-images`.


Task 9 hands over (as built, 20 Aug):

- **Attachments need a record link.** `POST /api/files` requires exactly one of
  companyId/contactId/dealId/projectId, so the composer disables its attach control when the seed
  carries no links at all (target order: deal → project → contact → company). Opening the composer from
  a conversation MUST therefore pass the THREAD's links, or Attach is silently unavailable on replies.
  Accepted for v0.5.0 (coordinator, 20 Aug) rather than widening the files route.
- **`useMailThreads` returns `{ items, nextCursor }`** and the cursor is part of the query key, so each
  page is its own cache entry. Task 10 accumulates pages itself behind a "load more" button — this is
  deliberately NOT an infinite query, matching the house keyset pattern.
- **Global search already has a mail group server-side.** `searchResultsSchema.mail`
  (threadId/subject/snippet) is populated, but components/search.tsx still flattens only the original
  five groups. Task 10 adds the mail group's render and its navigation once `/mail` exists.
- **Mount the composer in the FIRST commit, and smoke it end to end.** components/mail/composer.tsx is
  546 lines that have never executed: nothing imports it yet, so the build only typechecks it. Wire it
  into the inbox and actually compose, apply a template, attach, and send before building anything on
  top of it.
- **Exercise the eight dormant thread hooks early**, for the same reason: `useMailThreads`/`useMailThread`
  /`useMarkThreadRead`/`useSetThreadLink`/`useClearThreadLink`/`useArchiveThread`/`useUnarchiveThread`/
  `useUnreadMailCount` have never issued a request. Each one runs its response through `parseWith`, which
  fails LOUDLY on any contract drift — give it that chance against the real API before three components
  deep depend on the shapes.
- **`composer-lib.ts` may want renaming** once the inbox imports `friendlyMailError` from it (the settings
  page already does): it is the mail feature's lib, not the composer's. `mail-lib.ts` if the import list
  makes the current name look wrong — a mechanical rename, worth doing in the same commit that widens its
  audience rather than later.
- **`useMailAccounts()` must stay option-less everywhere except Settings.** Its `refetchInterval` option
  exists solely for the settings page's `syncStats` freshness contract; every other consumer treats the
  hook as an SSE-invalidated cache of the account rows.

Task 10 as built (20 Aug):

- **The record Mail tab lives on the RAIL**, not as a per-page section. `components/rail/rail.tsx`
  IS the tab strip company/contact/deal/project detail pages share (Timeline / Notes / Files), so
  one tab there is the same feature on all four with the filter shape they already pass for notes
  and files -- the plan's "existing tab pattern from company-detail" resolved to this. The tab
  content (`components/rail/mail.tsx`) is the shared thread-list with a record filter plus a
  Compose seeded from the record; a row navigates to `/mail?thread=<id>` rather than rendering a
  second conversation view inside a third of a detail page.
- **The account filter select renders only when there is more than one selectable account.** With a
  single account "All accounts" vs. that account is a no-op picker. TASK 11: `filter-account` is
  therefore ABSENT in the e2e journey, which adds one account -- do not assert on it. The three
  toggles (`filter-unread`, `filter-unlinked`, `filter-archived`) are always present.
- **Frame sizing is a fixed `h-[32rem]`, not `max-h-[32rem]`**: an iframe with only a max-height
  renders at the HTML default of 150px, so the plan's `max-h` alone would have shrunk every message
  body. Same intent (fixed box, internal scroll, no in-frame measurement), spelled the way that
  actually produces it.
- **Forward does not re-attach attachments** (the plan's original "+ reattaches" is corrected
  above). `POST /api/files` links a file to exactly one record, so re-attaching would COPY each
  blob onto the forward's own record rather than reference the original rows -- a real feature with
  a real storage cost, deferred rather than half-done, and commented as such in `forwardBody`.
- `humanSize` was written twice (Files rail, mail attachment chips) and now lives in `lib.ts` with
  its own tests.
- `composer-lib.ts` -> `mail-lib.ts` (the rename Task 9 flagged), and it now also holds the inbox's
  page accumulation, the reply/forward rules, `MESSAGE_FRAME_SANDBOX` and the CSP builder.
- Accepted freshness limit: only the CURRENT page of the thread list is a live query, so after
  "load more" an SSE invalidation refreshes that page while earlier pages keep the rows they were
  fetched with until the list resets (filter change or remount).
- **Accepted payload limit (v0.5.0): the thread-detail route returns EVERY message in the thread**
  -- `GET /api/mail/threads/:id` has no cap, and each message carries its full sanitized body. A
  5000-message mailing-list thread at ~50KB of body each is a response no browser tab survives
  opening. Nothing in a normal CRM conversation comes close, which is why this ships as-is; the 4.x
  fix is a server-side cap (newest N messages) plus a `truncated` flag the conversation renders as
  a "load earlier messages" control, and it needs a schema field, so it is not a patch-release
  change.
- **Task 12 bundle note**: the web bundle is ONE chunk, measured at end of Task 10 as 332.1KB gzip
  of JS plus 5.9KB of CSS -- ~338KB against the 400KB budget, so roughly 62KB of headroom, of which
  Phase 4 spent about 20KB (TipTap, the mail views). When that headroom runs out, the `/mail` leaf
  is the import() boundary to reach for first: it is a whole route's worth of components (composer,
  conversation, thread list, link panel) that the four non-mail areas of the app never render.

### Task 11: Playwright journey

`e2e/mail.spec.ts`, serial, runId names. Seed via IMAP APPEND from the test (imapflow as a root devDependency for e2e, `tls: { rejectUnauthorized: false }`, CI Dovecot host/creds from Task 8's `E2E_MAIL_*` env): a 3-message thread (2 inbound from `alice@example.com` + 1 unrelated message). Journey: create contact Alice with that email → Settings → add mail account via Dovecot preset, then overwrite host/port fields from the env values → test connection green → wait for sync (poll inbox until `thread-row` count == 2) → thread auto-linked to Alice (link chip visible) → open thread, mark-read clears unread badge → create a deal for Alice, reopen thread, deal suggestion appears, click links it → reply ("Thanks Alice") → Mailpit API (request via `page.request`) shows the message → sent message renders in conversation → unlinked filter hides the linked thread, shows the unrelated one → search finds the thread by body text. Existing 31 e2e untouched.

### Task 12: Packaging + release 0.5.0

`scripts/install`: after data_dir setup — `openssl rand -out "$data_dir/mail.key" 32`, `chmod 600`, `chown $app:$app` (match the existing file-provisioning idiom in the script). `scripts/upgrade`: same, guarded by `[ -f ]`. `scripts/backup`/`restore`: mail.key rides the existing data_dir coverage — VERIFY that data_dir is fully included (it is for files); add an explicit line only if the scripts enumerate paths. Config: `MAIL_KEY_PATH` env in the systemd service/config template pointing at `$data_dir/mail.key`. Also in this task (Chris's decision, 19 Aug): merge branch `fix/fastify-static-advisories` (commit 901f205, @fastify/static v8 -> v10 security migration, verified against v0.4.3) into the phase branch before the version bump — regenerate the lockfile on the server after the merge, re-run the full suite, mention the migration in the release notes, and drop the `conduit_test_secfix` database on the dev server. Then Phase 2 Task 10 release mechanics verbatim (bump all versions to 0.5.0, CI gate, ff-merge to main, tag v0.5.0, Release workflow builds the asset, manifest sha update on main, branch cleanup, hand Chris the one sudo upgrade command). Live verification checklist: add real account (Chris's local Dovecot via preset), watch sync populate, link a deal, send a reply from the CRM and see it in his normal mail client's Sent.
