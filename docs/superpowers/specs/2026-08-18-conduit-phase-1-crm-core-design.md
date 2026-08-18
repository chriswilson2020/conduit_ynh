# Conduit Phase 1 — CRM core

## Context

Phase 0 shipped the walking skeleton: a YunoHost app that installs, authenticates via SSOwat,
survives backup/restore and upgrades, verified live on conduit.listerdale.de (v0.1.2). Phase 1 makes
it a usable CRM: companies, contacts, notes, files, a per-record timeline, and global search.

Decisions taken with Chris during the Phase 1 brainstorm:

| Decision | Choice |
|---|---|
| Custom fields | Deferred entirely; `custom` JSONB column exists but nothing touches it |
| Global search | Company names, contact names/emails, and note bodies with snippets |
| Notes | Plain text; rich text waits for Phase 4's editor |
| Assignable owners | The `users` table (anyone who has logged in once) |
| Deletion | Archive (`archived_at`), never hard delete |

## Data model

All additive; drizzle migrations `0001+`, applied on boot (mechanism proven in Phase 0).

- `companies` — `id` uuid PK, `name` text NOT NULL, `domain`, `website`, `phone`, `address`,
  `industry` (all nullable text), `owner_user_id` FK users, `custom` jsonb NOT NULL default `{}`,
  `archived_at` timestamptz NULL, `created_at`/`updated_at` timestamptz NOT NULL.
- `contacts` — `first_name` text NOT NULL, `last_name` text NULL, `company_id` FK companies NULL,
  `emails` text[] NOT NULL default `{}`, `phones` text[] NOT NULL default `{}`, `job_title`,
  `owner_user_id`, `custom`, `archived_at`, timestamps.
- `notes` — `body` text NOT NULL (plain text), `author_user_id` FK users NOT NULL,
  `company_id` NULL, `contact_id` NULL, `created_at`. Exactly one entity FK must be set
  (CHECK constraint), matching the API contract. Deal/project FKs are added by the phases that create those tables.
- `files` — `original_name`, `mime`, `size_bytes`, `sha256` (blob path under `$data_dir/files/`),
  `uploader_user_id`, `company_id` NULL, `contact_id` NULL, `created_at`. Same CHECK.
- `events` — append-only timeline/audit: `verb` text (`created` | `updated` | `archived` |
  `unarchived` | `note_added` | `file_attached`), `actor_user_id`, `company_id` NULL,
  `contact_id` NULL, `payload` jsonb (changed-field summary), `created_at`. Never updated or
  deleted; renders the timeline.

Blobs are stored once under their sha256; duplicate uploads share a blob. Blob deletion is out of
scope (archive semantics mean file rows persist).

## API

REST under `/api`, cookie-free (SSOwat headers per request, as Phase 0). Every request and response
body is validated with Zod schemas exported from `@conduit/shared`.

- `GET /api/companies` — cursor pagination, `?q=` name filter, `?archived=true`
- `POST /api/companies`, `GET/PATCH /api/companies/:id`
- `POST /api/companies/:id/archive`, `POST /api/companies/:id/unarchive`
- Contacts: same shape, plus `?company_id=` filter
- `POST /api/notes` (body + exactly one entity FK), `GET /api/notes?company_id=…`
- `POST /api/files` (multipart, 50MB cap matching nginx), `GET /api/files/:id/download`,
  `GET /api/files?contact_id=…`
- `GET /api/events?company_id=…` — newest first, paginated
- `GET /api/users` — id, username, fullName for the owner dropdown
- `GET /api/search?q=` — grouped: companies (name ILIKE), contacts (name/email ILIKE), notes
  (body ILIKE, ±60-char snippet around the first match). Archived records excluded. Simple ILIKE;
  tsvector deliberately waits for Phase 4.

**Service layer** (`packages/api/src/services/companies.ts` etc.): each mutation writes its row AND
its `events` row in one transaction. Route handlers stay thin; the "every mutation records an
event" rule lives in exactly one place per entity.

Validation errors: 400 with the shared error shape. Unknown ids: 404. Archived targets of
mutations: 409 (`error: "archived"`), so the UI can prompt to unarchive.

## Frontend

Foundation installed this phase (from the original design): Tailwind, shadcn/ui vendored primitives
(no CDN — the YunoHost CSP), TanStack Router (basename from `__CONDUIT_BASE__`), TanStack Query.

- App shell: left nav (Companies, Contacts), header with global search (debounced 200ms, grouped
  dropdown, arrow-key navigation, Enter to open).
- List pages: table (name, owner, updated), client-side sort, `?q=` filter box, archived toggle,
  New dialog.
- Detail pages: field card with inline edit (save on blur, optimistic via TanStack Query), owner
  picker, archive/unarchive; right rail tabs Timeline / Notes / Files. Company page lists its
  contacts; contact page links its company.
- Files: input + drag-drop, list with size and uploader, download link.

## Testing

- Service + route tests against real Postgres: archive semantics (list exclusion, 409 on mutate,
  link reachability), event emission per mutation, search grouping and snippets, file round-trip
  (upload → dedupe → download), note CHECK constraint.
- Playwright: ~8 scenarios — the create-company → contact → note → file → timeline → search →
  archive journey, run in CI as Phase 0's e2e job.

## Rollout

Version 0.2.0. Tag → CI release → `yunohost app upgrade` on the live server. The upgrade doubles as
the migration test; the Phase 0 user row must survive. `manifest.toml` updated to the CI-built
asset's checksum, as v0.1.2 established.

Deferred: custom fields UI, deals/pipelines (Phase 2), SSE sync (Phase 2), rich text (Phase 4),
CSV import (Phase 6).
