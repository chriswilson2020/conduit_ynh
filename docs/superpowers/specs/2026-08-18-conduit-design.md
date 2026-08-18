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

SSOwat authenticates in front of the app and injects the username as a request header
(`auth_header = true` on the permissions resource). The app:

1. Trusts that header **only** when the connection is from loopback — Fastify's `trustProxy` set to
   loopback only. Getting this wrong makes the app trivially impersonatable, so it needs a test that
   asserts a spoofed header from a non-loopback address is rejected.
2. Looks up or creates a `users` row from the LDAP username on first login.
3. Issues its own signed session cookie so the SPA and API don't re-parse headers per request.

The exact header name must be confirmed against the live server in Phase 0 rather than assumed.
A dev-only local login path (enabled by an env flag, hard-failing in production) lets the app run
off-YunoHost during development.

### Subpath support

YunoHost installs at either `domain.tld` or `domain.tld/conduit`. The SPA base path and API prefix
are templated from `$path` at install time. This must work from Phase 0 — retrofitting base-path
handling into a finished SPA is painful and touches every route, asset URL, and fetch call.

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

Releases ship **prebuilt** artifacts — the server does not run `npm install` or a Vite build.
`resources.sources` points at a GitHub release tarball containing compiled API JS, built SPA assets,
and pruned production `node_modules`. Building on a 4GB VPS during `yunohost app upgrade` is slow
and can OOM alongside other apps.

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

- Confirm the exact SSOwat header name and format on the live server; the design assumes a username
  header but does not depend on which one.
- Confirm PostgreSQL is available as a `resources.database` type on Chris's YunoHost version, and
  fall back to installing `postgresql` via `resources.apt` plus manual provisioning if not.
- Decide whether releases are built by GitHub Actions or locally; CI is preferable but requires the
  repo to be pushed to a forge.

---

