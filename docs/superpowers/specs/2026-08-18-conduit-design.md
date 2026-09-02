# Conduit — a self-hosted CRM for YunoHost

## Context

Chris wants a Pipedrive-equivalent CRM that runs as a first-class YunoHost application on his own
server. Commercial CRMs don't self-host, and the existing open-source options model three of his
core requirements differently enough that bending their schemas would cost more than writing our
own. Specifically he needs:

- Standard CRM objects — companies, contacts, notes, timeline
- Pipelines with drag-and-drop between stages, **scoped per client and per project**, not just
  org-wide
- Project management with a Gantt chart whose bars can be **dragged to change duration**
- Task lists with assignees and start/due dates on everything
- An integrated email client
- Merge-field document templates

`/Users/chris/Documents/Development/PipeDrive` is currently empty. This is greenfield.

Decisions already taken with the user during brainstorming:

| Decision | Choice |
|---|---|
| Foundation | Build from scratch (not forking EspoCRM/Twenty) |
| Users | Small trusted team, 2–10 people, everyone sees everything |
| Pipeline model | Scoped pipelines: `global`, `company`, or `project` |
| Email scope | CRM-shaped inbox, not a Roundcube replacement |
| Documents | Merge-field → PDF |
| Stack | Node/TypeScript + React, PostgreSQL |
| Hardware | VPS with 4GB+ RAM |
| Packaging | YunoHost package **first**, as a walking skeleton |
| Task model | One unified task entity for CRM activities and project work |
| Name | Conduit (YunoHost app id: `conduit`) |

The intended outcome is that after each phase, `yunohost app upgrade conduit` puts working,
checkable software on Chris's real server.

---

## Architecture

One deployable: a Fastify server serving the JSON API under `/api/*` and the built React SPA for
everything else, backed by PostgreSQL, running as a single systemd service behind YunoHost's nginx.

```
nginx (YunoHost, SSOwat) ──> :$port  Fastify (systemd: conduit.service)
                                      ├── /api/*   REST + SSE
                                      ├── /*       SPA, index.html fallback
                                      └── worker   IMAP sync + jobs, in-process
                                            │
                             PostgreSQL ◄───┘     $data_dir/  uploads, generated PDFs
```

**No Redis, no Docker, no separate worker process.** The job queue is a Postgres table drained with
`SELECT … FOR UPDATE SKIP LOCKED`. At 2–10 users we will never need more, and every additional
daemon is another thing the YunoHost backup/restore scripts must handle correctly.

### Repository layout

```
conduit/
├── manifest.toml              # YunoHost packaging v2
├── scripts/                   # install, remove, upgrade, backup, restore, _common.sh
├── conf/                      # systemd unit, nginx snippet, .env template
├── tests/test.toml            # package_check config
├── packages/
│   ├── shared/                # zod schemas + inferred types, used by api and web
│   ├── api/                   # Fastify, Drizzle, migrations, workers
│   └── web/                   # React SPA
└── docs/superpowers/specs/    # this spec and successors
```

`packages/shared` is the load-bearing piece: entity schemas are defined once as zod schemas,
Drizzle tables are derived from them, and the SPA imports the inferred types. That is the whole
reason for choosing a single-language stack, so the boundary must be real from day one.

### Authentication

SSOwat authenticates in front of the app. YunoHost's nginx `proxy_params_with_auth` include
injects the authenticated identity on every proxied request:

| Header | Contents |
|---|---|
| `Ynh-User` | LDAP username |
| `Ynh-User-Email` | Primary email address |
| `Ynh-User-Fullname` | Display name |

(`REMOTE_USER` and `X-Forwarded-User` carry the same username as aliases.) SSOwat overwrites these
headers before proxying, so a client cannot set them itself.

Because every request already arrives authenticated, **the app issues no session cookie of its own**.
It reads `Ynh-User` per request and resolves it to a `users` row, creating the row on first sight
from the email and fullname headers. A short-lived in-memory cache (one minute) keeps that to one
query per user per minute rather than one per request — without it every request would write a row,
since resolution also stamps `last_seen_at`. The TTL is deliberately not process-lifetime: a
permanent cache would never notice an LDAP display-name or email change until a restart. This removes cookie signing, session storage, expiry, and logout from the app
entirely.

**Two of those four came back in 7.6, in one place and for one thing.** The export and the
encrypted backup are gated by a re-authentication check, and what it mints is a single-use
ticket held in memory with a five-minute lifetime — session storage and expiry, in the
narrow. There is still no cookie, nothing is signed, there is no logout, and no password is
stored: the check itself is an LDAP simple bind against YunoHost's own directory. The sentence
above is still the right description of how a REQUEST is authenticated; it is no longer a
complete description of what the app keeps.

**It went through the portal API until v1.4.1 and that was the wrong door**, for a reason worth
keeping here rather than only in a release note: the portal's job is to MINT A SESSION, and it
charged rent for one Conduit never wanted — a domain ACL evaluated against the request's `Host`
header, which over loopback is `127.0.0.1:6788` and belongs to nobody. It refused every correct
password. A simple bind asks the one question this gate actually has.

The security boundary is that **the app binds to `127.0.0.1` only**, so nothing can reach it without
passing through nginx and SSOwat. This is the standard YunoHost trust model, and it is worth stating
its limit plainly: another process already running on the same host could connect to the loopback
port and set `Ynh-User` freely. Defending against that would require a shared secret that other
local users could read from the world-readable nginx conf anyway, so it buys nothing real. If the
app ever needs to defend against hostile local processes, that is a change of threat model, not a
tweak.

**7.6 made that limit consequential without changing it.** `POST /api/reauth` checks a
password against YunoHost's portal, and the account it checks is the one in `Ynh-User` — so
a local process that sets the header freely can ask this app to test passwords for *any*
account on the box. Nothing upstream counts those attempts: the portal call goes over
loopback, YunoHost's fail2ban jails read nginx's logs, and YunoHost's own authenticator
carries a `FIXME` saying failed logins are not caught by fail2ban at all. The per-account
throttle in `services/reauth.ts` is the whole of what bounds it, which is why its check and
its count are one synchronous step rather than a read either side of an `await`.

A dev-only fake-user env var (`CONDUIT_DEV_USER`) stands in for the header when running off-YunoHost.
It hard-fails at boot when `NODE_ENV=production`. **7.6 added a second variable of exactly
this kind and with exactly this guard**: `CONDUIT_REAUTH_PASSWORD` replaces the portal bind
with a fixed value so the re-authentication gate can be exercised on a machine with no
YunoHost portal, and `parseConfig` refuses to boot with it set in production for the same
reason. They are a family of two now, not a single flag.

### Subpath support

YunoHost installs at either `domain.tld` or `domain.tld/conduit`. nginx's `proxy_pass` strips the
prefix, so the API never sees it and needs no route prefix — but the browser does, so SPA asset URLs
and the client router both do.

Rather than rebuild the SPA per install path, the SPA is built once with Vite `base: './'` (assets
resolve relative to `index.html`, valid at any depth) and the server rewrites a `__BASE_PATH__`
placeholder in `index.html` as it serves it. The router reads the injected value as its basename.
One build works at any path, and there is no Vite build on the server.

This must work from Phase 0 — retrofitting base-path handling into a finished SPA is painful and
touches every route, asset URL, and fetch call.

---

## Data model

Cross-entity links use **nullable foreign keys, not a polymorphic join table**. Notes, files, tasks,
and mail threads each carry nullable `company_id`, `contact_id`, `deal_id`, `project_id`. This gives
real FK constraints, real indexes, and readable SQL. A generic `links(source_type, source_id, …)`
table would be more elegant and considerably worse to query.

**Core**

- `users` — mirrored from LDAP on first login: username, display name, email, avatar
- `companies` — name, domain, address, phone, website, industry, `owner_user_id`, `custom` JSONB
- `contacts` — nullable `company_id`, emails[], phones[], job title, `owner_user_id`, `custom` JSONB
- `notes` — body, author, + the four nullable FKs
- `files` — filename, mime, size, storage path under `$data_dir`, uploader, + the four nullable FKs
- `events` — append-only timeline: `verb`, actor, subject FKs, JSONB payload. Renders the activity
  feed on every record and doubles as the audit log.

**Pipelines**

- `pipelines` — name, `scope` enum (`global` | `company` | `project`), nullable `company_id`,
  nullable `project_id`. A CHECK constraint enforces that the scope column matches which FK is set.
  This single column is what produces org-wide "New Business" alongside "Acme — Onboarding" nested
  under Acme.
- `stages` — `pipeline_id`, name, `position`, probability, `rot_days`
- `deals` — `pipeline_id`, `stage_id`, `position` (fractional index), title, value, currency,
  `expected_close_date`, `status` (`open`|`won`|`lost`), `lost_reason`, `owner_user_id`, links to
  company/contact/project

**Work**

- `projects` — name, nullable `company_id`, nullable originating `deal_id`, owner, status,
  `start_date`, `due_date`, colour
- `tasks` — the unified entity. Title, description, `type` (`task`|`call`|`meeting`|`email`|
  `deadline`), `status` (`todo`|`in_progress`|`blocked`|`done`), `assignee_user_id`, `start_date`,
  `due_date`, `completed_at`, `progress_pct`, `parent_task_id` (subtasks and Gantt grouping),
  `position`, + the four nullable FKs
- `task_dependencies` — `predecessor_id`, `successor_id`, `type`. Only finish-to-start is
  implemented initially; the `type` column exists so SS/FF/SF land later without a migration.

**Email**

- `mail_accounts` — per-user IMAP/SMTP settings; credentials encrypted at rest with a key stored in
  `$data_dir` (mode 0600, owned by the app system user, included in backups)
- `mail_threads` — subject, `last_message_at`, + nullable FKs for auto-linking
- `mail_messages` — `account_id`, RFC `message_id`, `in_reply_to`, `references[]`, `thread_id`,
  from/to/cc, subject, `body_text`, `body_html`, `sent_at`, folder, IMAP uid, seen flag, and a
  `tsvector` column with a GIN index for full-text search

Threads auto-link to contacts by matching From/To addresses against `contacts.emails`.

**Documents**

- `email_templates` — name, subject, body HTML
- `doc_templates` — name, body HTML with `{{merge.fields}}`, page settings
- `documents` — `template_id`, rendered HTML, generated PDF `file_id`, + nullable FKs

---

## Frontend

React 19 + Vite + TypeScript. TanStack Query for server state, TanStack Router for routing,
Tailwind + shadcn/ui (Radix primitives, self-hosted — YunoHost's CSP will block CDN assets anyway),
TipTap for rich text in email compose and document templates.

**Drag-and-drop is `@dnd-kit`** for both kanban and Gantt. Ordering uses fractional indices, so a
drop writes one row rather than renumbering a whole column.

**The Gantt is custom-built, and this is the main technical risk in the project.** Every mature
Gantt library is either commercially licensed (DHTMLX, Bryntum, SVAR) or too limited for
drag-to-resize with dependencies (frappe-gantt). Phase 3 therefore opens with a timeboxed throwaway
spike: a CSS-grid timeline with dnd-kit drag and resize handles. If the spike goes badly, buy a
licence rather than sink weeks into it. The decision point is explicit and early.

**Multi-user sync** is a single SSE endpoint broadcasting record-changed events, so a colleague's
drag appears on your board. SSE rather than WebSockets: the traffic is one-directional and it
behaves more predictably through nginx (requires `proxy_buffering off` in the nginx snippet).

---

## Phases

Every phase ends deployed on Chris's real YunoHost server and manually checkable.

| Phase | Ships |
|---|---|
| **0** | **Walking skeleton.** Installs, removes, upgrades, backs up, restores. SSO login works. Renders "logged in as chris" and a health endpoint. Almost no features — the point is retiring packaging risk on day one. |
| **1** | **CRM core.** Companies, contacts, notes, files, timeline, global search, user list from LDAP. |
| **2** | **Pipelines & deals.** Scoped pipelines, stages, kanban drag-and-drop, deal detail, won/lost, funnel view, SSE sync. |
| **3** | **Tasks, projects & Gantt.** Unified tasks, projects, task board, Gantt with draggable/resizable bars and finish-to-start dependencies. Opens with the Gantt spike. |
| **4** | **Email.** IMAP sync worker, threaded CRM inbox, contact auto-linking, compose/reply via SMTP, templates, signatures. |
| **5** | **Documents.** Merge-field templates rendered to PDF via WeasyPrint (an apt dependency at roughly 40MB, far lighter than shipping Chromium). |
| **6** | **Polish.** Reporting, notifications, CSV import/export, mobile layout. |

Each phase gets its own spec → plan → implementation cycle. This document specifies the whole
system and details Phase 0; later phases are specified when reached.

---

## Phase 0 in detail

The deliverable is a YunoHost app that does almost nothing, correctly.

**Packaging** — `manifest.toml` with `packaging_format = 2`, `helpers_version = "2.1"`,
`yunohost = ">= 12.1.17"`, `multi_instance = true`, and resources: `sources`, `system_user` (with `allow_email = true`, since
Phase 4 sends mail), `install_dir`, `data_dir`, `ports`, `nodejs` (version 24), `database`
(`type = "postgresql"`), and `permissions` with `main.url = "/"` and `auth_header = true`.

Releases ship **prebuilt** artifacts: `resources.sources` points at a GitHub release tarball holding
compiled API JavaScript, built SPA assets, and a `package.json`/`package-lock.json` pair covering
runtime dependencies only. No TypeScript compile and no Vite build happen on the server — those are
the slow, memory-hungry steps that can OOM a VPS mid-upgrade.

The install script does run `npm ci --omit=dev` to fetch runtime dependencies. Shipping
`node_modules` inside the tarball instead would be more hermetic, but it bloats the release and
fights npm's workspace hoisting for little gain at this scale.

**Scripts** — `install`, `remove`, `upgrade`, `backup`, `restore`, `_common.sh`. `backup` must cover
the install dir, the data dir, the Postgres dump, the systemd unit, and the nginx conf. `restore`
must round-trip them. This is the part packages most often get wrong, and it is why Phase 0 exists.

**API** — Fastify with `/api/health` (unauthenticated, returns version and DB connectivity) and
`/api/me` (returns the session user). Drizzle configured against the provisioned Postgres, with the
migration runner executing on boot. Pino logging to journald.

**Auth** — SSOwat header trust restricted to loopback, first-login user provisioning, signed session
cookie, dev-only local login behind an env flag that hard-fails when `NODE_ENV=production`.

**Web** — Vite SPA with base path from env, a single page showing the logged-in user and app
version, and a 404-to-index fallback proving client routing survives the subpath.

**Verification for Phase 0**

1. `npm test` — unit tests pass, including the spoofed-auth-header rejection test.
2. `npm run test:api` — integration tests against a throwaway Postgres.
3. `package_check` CI green on the repo.
4. On the real server: `yunohost app install`, visit the URL, confirm SSO redirects and the page
   names the logged-in user.
5. `yunohost backup create --apps conduit`, `yunohost app remove conduit`,
   `yunohost backup restore` — confirm the app returns intact with its data.
6. `yunohost app upgrade conduit -u <repo>` from a prior commit — confirm upgrade path works.
7. Install a second instance at a subpath (`domain.tld/conduit2`) — confirm base-path handling and
   `multi_instance`.

Steps 4–7 need Chris's server and will need his hands or credentials; the plan should surface that
rather than assume it.

---

## Testing strategy

- **Vitest** for units, especially the scoped-pipeline query builders and fractional indexing.
- **API integration tests against a real throwaway Postgres**, not mocks. The scoped-pipeline
  queries and the nullable-FK link filters are exactly where bugs will live, and mocks would hide
  them.
- **Playwright for every drag interaction.** Kanban reordering and Gantt bar drag/resize cannot be
  verified any other way, and they are the features most likely to silently regress.
- **YunoHost `package_check`** in CI, plus a real install/upgrade/backup/restore cycle at every
  phase gate.

---

## Open items to resolve during Phase 0

- Decide whether releases are built by GitHub Actions or locally; CI is preferable but requires the
  repo to be pushed to a forge.
- Confirm on the live server that `Ynh-User` arrives populated for the chosen permission group.
  The header set is confirmed from YunoHost's nginx conf, but only a real login proves the wiring.

Resolved during planning: the SSOwat header names (see Authentication above), and that PostgreSQL is
available via `[resources.apt] packages = "postgresql"` plus `[resources.database] type =
"postgresql"`, which is the pattern real Node apps such as `hedgedoc_ynh` use.

---


---

## Phase 0 verification

Run on 18 August 2026 against a real YunoHost 12.1.40.1 server (Debian 12.15, PostgreSQL 15.19,
Node 24.19.0), domain `conduit.listerdale.de`, app installed at `/conduit`.

| Check | Result |
|---|---|
| `yunohost app install` | Completed in 15.7s |
| Service running | `active`, listening on `127.0.0.1:11812` |
| Health endpoint | `{"status":"ok","version":"0.1.0","database":"connected"}` |
| SSO redirect for unauthenticated request | `302` to the YunoHost portal |
| **SSO login end to end** | A real browser login created the `users` row from the `Ynh-User` headers |
| SPA base path substitution | `__CONDUIT_BASE__ = "/conduit"` |
| `.env` rendering | `APP_VERSION=0.1.0`, non-empty |
| Backup archive contents | 39MB; contains `db.sql` (3582 bytes) with the schema, the drizzle migrations table, and the real user row |
| **Backup, remove, restore** | Restored with the *same* UUID `cf3f68a8-f747-47f2-a358-1862373281c6` and `created_at` to the microsecond, proving the data came from the archive rather than a recreated schema |
| Upgrade 0.1.0 to 0.1.1 | Version reported `0.1.1`, user row and `created_at` unchanged |
| Second instance at `/conduit2` | Installed as `conduit__2` with its own port and its own database; both instances healthy, both behind SSO, base paths `/conduit` and `/conduit2` |

Two defects were caught only because the packaging was built and exercised rather than assumed:

- `server.ts` defaulted `webRoot` one directory too high. Every unit test passed because tests pass
  `webRoot` explicitly; it failed only when the packaged tarball ran standalone.
- `scripts/_common.sh` was sourced before YunoHost's helpers, so `ynh_read_manifest` did not exist
  and `app_version` rendered empty into `.env`. It fails silently, showing a blank version rather
  than an install error.

**Not yet verified:** installing from the GitHub release asset. The repository is private, so the
asset returns 404 to unauthenticated fetches and verification served the tarball over loopback
instead. Making the repository public is the only change required.
