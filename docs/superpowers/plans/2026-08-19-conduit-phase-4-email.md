# Conduit Phase 4 — Email Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user IMAP/SMTP mail accounts, an in-process sync engine (IDLE + incremental poll), a threaded shared-visibility CRM inbox auto-linked to contacts/companies with deal suggestions, compose/reply via SMTP with IMAP APPEND to Sent, templates and signatures — released as v0.5.0.

**Architecture:** Six new tables. Ingest (parse, sanitize, thread, auto-link) is one transactional service; the sync engine talks to a thin `ImapClient` interface (real imapflow adapter vs in-memory fake for tests); send is SMTP → APPEND → DB insert in strict order. All mail HTML passes one shared sanitizer. Spec: `docs/superpowers/specs/2026-08-19-conduit-phase-4-email-design.md` — read it first; it is the authority on semantics.

**Tech Stack:** New api deps: `imapflow`, `mailparser`, `nodemailer`, `sanitize-html` (+ `@types/nodemailer`, `@types/mailparser`, `@types/sanitize-html`). New web deps: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`. Lockfile MUST be regenerated on the server (`./scripts/remote.sh npm install`) — a macOS-generated lockfile omits Linux binaries.

---

## Conventions

Identical to Phase 3's plan: `./scripts/remote.sh` for every command (the worktree lacks the untracked `.conduit-remote` — copy it from the main checkout before the first run); NodeNext `.js` extensions in api, none in web; ASCII-only sources with `\u` escapes, byte-scan before commit (email fixtures included — encode any non-ASCII test content as escapes); ApiError code/status branching; testids for structure, roles for controls; Playwright ONLY in CI (iterate via push + `gh run view --log-failed`). Suite at start: 603 unit + 31 e2e, green. Hardened service pattern per `services/deals.ts`/`tasks.ts` (atomic guards, publish-after-commit SSE hints). Mail needs no advisory locks — each AccountSync serialises its own account in-process and never two writers race one folder cursor.

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
- `sanitizeMailHtml(html, { cidMap? })` — sanitize-html profile: allow structural/text tags + `table` family + `img` + `a` + inline `style` attr; strip `script/style/iframe/object/embed/form/input` and all `on*` attrs; `a` gains `rel="noopener noreferrer" target="_blank"`; `img src` allowed schemes http/https/cid — cid:X rewritten via cidMap to `/api/mail/attachments/<id>/inline`, unmapped cid dropped. Remote images stay in the markup — blocking is render-time (message-frame CSP), not ingest-time.
- `normalizeSubject(s)` — iteratively strip leading `re:/fw:/fwd:` (case-insensitive, optional `[n]`), collapse whitespace; empty → `(no subject)`.
- `makeSnippet(text)` — collapse whitespace, first 160 chars.
- `syntheticMessageId(parsed)` — `sha256:` + hex over from_addr + ISO sent_at + subject + first 1k of body_text (stable across refetch).
- `extractAddresses(parsed)` — mailparser AddressObject → `{address (lowercased), name}` arrays for from/to/cc/bcc.
~18 tests (sanitizer matrix is the bulk; fixtures ASCII with `\u` escapes).

### Task 3: Accounts service

`mail-accounts.ts`: `createAccount(db, userId, input)` (encrypt creds; smtpPassword defaults to password), `updateAccount` (password fields optional — empty/absent keeps stored), `archiveAccount`, `getOwnAccount` (decrypts NOTHING — a separate `getAccountCredentials(db, id)` is the only decrypt path, used by sync/send/test), `listAccounts(db, userId)` → own rows full (minus creds) + others as `{id, label, email}` (assert shape in test), `testConnection(db, userId, input, deps)` — deps-injected `{ imapVerify, smtpVerify }` (real impls arrive Task 6; unit tests inject fakes) returning per-protocol `{ok, error?}`. Owner checks on every mutating path (NotFoundError for other users' accounts — existence must not leak settings). SSE `[["mail-accounts"]]`. ~14 tests.

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
  status(folder): Promise<{uidvalidity, uidnext}>;
  fetchNewer(folder, sinceUid, limit): Promise<{uid, raw, flags}[]>;  // ascending
  fetchFlags(folder, sinceDate): Promise<{uid, flags}[]>;
  append(folder, raw, flags): Promise<void>;
  setFlags(folder, uids, flags): Promise<void>;  // \Seen write-back
  idle(folder, signal): Promise<"new-mail"|"timeout"|"aborted">;
}
```

`AccountSync(db, account, client, opts)` — single async loop, all work serialised:
- Pass = for INBOX + sent_folder: `status()`; UIDVALIDITY mismatch → reset cursor to 0 (dedupe makes refetch converge); fetch in batches of 50 ascending from `last_seen_uid` (skipping messages older than `backfill_days` on the first-ever pass — filter by INTERNALDATE, the adapter handles it via SEARCH SINCE), ingest each, advance cursor AFTER each batch (resume property); then `fetchFlags(folder, now - 30d)` reconcile `seen`.
- Between passes: `idle("INBOX", signal)` capped at `pollIntervalMs` (default 300_000, injectable) — "new-mail" or timeout both trigger the next pass immediately/on schedule.
- Errors anywhere: `status='error'` + `last_error`, backoff `min(60s * 2^attempt, 32min)` (timer injectable), successful pass resets `status='active'`, `last_synced_at`, attempt=0. Every status flip publishes `[["mail-accounts"]]` (drives the settings error badge).
- `markSeen(folder, uids)` and `appendSent(raw)` queue onto the same serial loop (exposed for routes/send).
- `stop()` — abort idle, disconnect, resolve.

`SyncManager` — `start(db)` loads non-archived accounts → AccountSync each (clientFactory injectable); `accountChanged(id)` create/restart/teardown after CRUD; `syncNow(id)`; `get(id)` for send/markSeen access; NOT started under NODE_ENV=test. Wire `start` into server.ts after listen; `accountChanged` into mail-accounts service. Tests (~16, fake ImapClient + fake timers): backfill honours backfill_days & resumes mid-batch after injected crash; cursor advance; UIDVALIDITY reset converges without dupes; flag reconcile flips seen; idle wake triggers pass; backoff doubles & caps & resets; error → status flip; stop is clean; markSeen writes flags through; manager teardown on archive.

### Task 6: imapflow adapter + send service

`mail-imapflow.ts`: `ImapflowClient implements ImapClient` — imapflow with `secure`/STARTTLS per `imap_security`, mailbox locks around ops, SEARCH SINCE for the backfill filter, `client.idle()` with AbortSignal race. Also export `imapVerify(settings)` / `smtpVerify(settings)` (nodemailer `verify()`) and wire them as the real deps of Task 3's testConnection. Unit tests: none beyond construction — this file is covered by Task 8's integration suite; keep it thin enough that that is honest.

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
// 5. Reuse ingest primitives to insert the outbound row (direction outbound,
//    seen true, folder = sent_folder, imap_uid null, thread = input.threadId
//    or new thread with input.links applied). Same transaction as thread bump.
// 6. SSE. Return the message row.
```

Tests (~12): ordering matrix (SMTP fail → no row; APPEND fail → row + warn), reply headers chain, new-thread links applied, owner check (404 on foreign account), sanitization applied, text alt generated, attachment streaming, archived/error account rejected (409).

### Task 7: Routes + templates + search

`mail-templates.ts`: CRUD/archive, `body_html` sanitised on write, shared (no owner column). ~6 tests.

`routes/mail.ts` per the spec's route list verbatim: accounts (list/create/update/archive/test), threads (list with filters + keyset pagination by (last_message_at, id) — pagination.ts pattern; detail with messages + attachments + deal suggestions (open deals matching thread contact/company, newest 5); read → db update + best-effort `syncManager.get().markSeen` per account/uid group; links set/clear; archive/unarchive), send, attachments (`GET /:id` download + `GET /:id/inline` — inline only when `is_inline`, correct content-type, `Content-Disposition: attachment` on the download route), templates, `GET /api/mail/unread-count` → `{count}` of distinct non-archived threads having an unseen message. Search service + route + tests gain `mail` group: `websearch_to_tsquery('english', q)` against the tsvector, thread-grouped (best-ranked message per thread, ts_rank ordered, limit 5), archived threads excluded. Route tests (~20): happy + 400/404/409 per family, credential leak assertions (list/create/update responses NEVER contain password/ciphertext fields), foreign-account 404s, filter combos, unread count, search relevance smoke.

### Task 8: CI Dovecot + Mailpit integration

TLS story (settled here, used by Tasks 8 and 11): the account schema keeps its strict `tls|starttls` CHECK — no plaintext mode exists anywhere. CI Dovecot serves IMAPS on 993 with a self-signed cert; Mailpit serves STARTTLS on 1025 with its built-in self-signed cert. `config.ts` gains `MAIL_TLS_REJECT_UNAUTHORIZED` (default `1`); when `0` (CI only) the adapter passes `rejectUnauthorized: false` to imapflow/nodemailer.

`.github/workflows/test.yml`: `mailpit` (image `axllent/mailpit`, ports 1025/8025) fits the `services:` block. Dovecot needs config files (passwd-file auth: one user `conduit@test.local` / `testpass`, self-signed cert), and `services:` containers start before the workspace exists — so start it in a step instead: write the config + `openssl req` cert to a temp dir, then `docker run -d -v` the `dovecot/dovecot:2.3-latest` image, port 993. Add that step to both jobs. `packages/api/src/test/mail-integration.test.ts`, top-level `describe.skipIf(!process.env.MAIL_IT)`; test.yml sets `MAIL_IT=1`, host/port env, and `MAIL_TLS_REJECT_UNAUTHORIZED=0`. Integration coverage: login, APPEND then fetchNewer sees it, flags roundtrip via setFlags/fetchFlags, SEARCH SINCE backfill filter, idle wake on APPEND (with timeout guard), smtpVerify against Mailpit, nodemailer send → Mailpit API shows the message. Iterate via push; keep total runtime under ~90s. The e2e job's app boot env also gets `MAIL_TLS_REJECT_UNAUTHORIZED=0` plus `E2E_MAIL_*` host/port env consumed by mail.spec.ts (Task 11).

### Task 9: Web — settings, hooks, composer

`./scripts/remote.sh npm install` for the TipTap deps (lockfile!). Hooks in queries.ts (parseWith, SSE-mirrored invalidation): `useMailAccounts`/`useCreateMailAccount`/`useUpdateMailAccount`/`useArchiveMailAccount`/`useTestMailAccount`, `useMailThreads(filters)`/`useMailThread(id)`/`useMarkThreadRead`/`useSetThreadLinks`/`useArchiveThread`, `useSendMail`, `useMailTemplates` + CRUD, `useUnreadCount` (SSE `mail.message` invalidates). No Settings area exists yet — this task creates it: a `Settings` nav entry in shell.tsx with `/settings/mail` and `/settings/templates` routes (registered per the existing route registration pattern; a plain two-tab settings layout, no framework). Mail accounts page: account cards with status/error badge + last_synced_at, add/edit dialog (label, email, IMAP/SMTP host/port/security selects, username, password fields blank-means-keep, sent folder, backfill select 30/90/all, "Local Dovecot" preset button filling host=localhost, imap 993 tls, smtp 587 starttls, username = current username), Test connection button rendering per-protocol results, signature TipTap editor per account, archive. Settings → Templates page: list + editor dialog (name, subject, TipTap body). `components/mail/composer.tsx`: TipTap (StarterKit + Link), To/Cc/Bcc token inputs with contact-email autocomplete (useContacts search), account select (own active), template picker (applies subject when composing fresh, body inserted at cursor; `{{contact.name}}`/`{{company.name}}`/`{{user.name}}` substituted from props context, unresolved left literal), signature block appended on account select, attachment upload via existing files multipart hook, send → useSendMail with pending/error states. Composer is a controlled dialog component — inbox and record pages mount it with different seeds. Testids: `mail-settings`, `mail-account-<id>`, `composer`, `composer-send`.

### Task 10: Web — inbox, conversation, record Mail tabs

`/mail` route + nav item "Inbox" with unread badge (useUnreadCount). Two-pane: `thread-list.tsx` (virtualised not needed — keyset "load more" per house pattern; row: unread dot, participants summary, subject, snippet, relative time, account chip, link chips) + filter bar (account select, unread toggle, unlinked toggle, archived toggle); `conversation.tsx`: header (subject, link-panel), messages oldest-first collapsed except last (`message-<id>` testid, click expands), each body in `message-frame.tsx` — iframe `srcdoc` with `sandbox=""` (no scripts, no same-origin) and an injected CSP meta tag: default state `default-src 'none'; img-src data: <app-origin>; style-src 'unsafe-inline'` (inline `cid:` attachments are app-origin, so they always render); the per-thread "Load remote images" button re-renders frames with `img-src` widened by `https: http:`. Frame sizing: fixed `max-h-[32rem] overflow-auto` (the empty sandbox blocks scripts, so no in-frame measurement — do not attempt auto-resize). Text-only messages render `<pre className="whitespace-pre-wrap">` directly, no iframe. Attachment chips (download links). `link-panel.tsx`: four link chips with unlink x, entity-picker popovers (existing search endpoints), deal-suggestion row (one-click link). Reply/Reply-all/Forward buttons seed the composer (forward inlines quoted body + reattaches). Record Mail tabs: contact/company/deal/project detail pages get a Mail tab (existing tab pattern from company-detail) rendering thread-list with the record filter + a Compose button seeded with the record's addresses/links. Testids: `inbox`, `thread-row-<id>`, `conversation`, `message-<id>`, `link-panel`, `deal-suggestion-<id>`, `load-remote-images`.

### Task 11: Playwright journey

`e2e/mail.spec.ts`, serial, runId names. Seed via IMAP APPEND from the test (imapflow as a root devDependency for e2e, `tls: { rejectUnauthorized: false }`, CI Dovecot host/creds from Task 8's `E2E_MAIL_*` env): a 3-message thread (2 inbound from `alice@example.com` + 1 unrelated message). Journey: create contact Alice with that email → Settings → add mail account via Dovecot preset, then overwrite host/port fields from the env values → test connection green → wait for sync (poll inbox until `thread-row` count == 2) → thread auto-linked to Alice (link chip visible) → open thread, mark-read clears unread badge → create a deal for Alice, reopen thread, deal suggestion appears, click links it → reply ("Thanks Alice") → Mailpit API (request via `page.request`) shows the message → sent message renders in conversation → unlinked filter hides the linked thread, shows the unrelated one → search finds the thread by body text. Existing 31 e2e untouched.

### Task 12: Packaging + release 0.5.0

`scripts/install`: after data_dir setup — `openssl rand -out "$data_dir/mail.key" 32`, `chmod 600`, `chown $app:$app` (match the existing file-provisioning idiom in the script). `scripts/upgrade`: same, guarded by `[ -f ]`. `scripts/backup`/`restore`: mail.key rides the existing data_dir coverage — VERIFY that data_dir is fully included (it is for files); add an explicit line only if the scripts enumerate paths. Config: `MAIL_KEY_PATH` env in the systemd service/config template pointing at `$data_dir/mail.key`. Also in this task (Chris's decision, 19 Aug): merge branch `fix/fastify-static-advisories` (commit 901f205, @fastify/static v8 -> v10 security migration, verified against v0.4.3) into the phase branch before the version bump — regenerate the lockfile on the server after the merge, re-run the full suite, mention the migration in the release notes, and drop the `conduit_test_secfix` database on the dev server. Then Phase 2 Task 10 release mechanics verbatim (bump all versions to 0.5.0, CI gate, ff-merge to main, tag v0.5.0, Release workflow builds the asset, manifest sha update on main, branch cleanup, hand Chris the one sudo upgrade command). Live verification checklist: add real account (Chris's local Dovecot via preset), watch sync populate, link a deal, send a reply from the CRM and see it in his normal mail client's Sent.
