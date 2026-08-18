# Conduit Phase 2 — Pipelines & deals

## Context

Phase 1 shipped the CRM core (companies, contacts, notes, files, timeline, search) as v0.2.0.
Phase 2 makes Conduit a sales tool: scoped pipelines, stages, deals on a drag-and-drop kanban,
won/lost tracking, a funnel view, and live multi-user sync via SSE.

Drafted overnight on Chris's standing instruction ("keep going... get started on phase 2").
Decisions below marked [overnight call] were taken without him and are flagged for morning review;
everything else restates the already-approved system design.

## Decisions

| Decision | Choice |
|---|---|
| Pipeline scoping | `scope` enum on the pipelines table, per the approved design |
| [overnight call] Scope values in Phase 2 | `global` and `company` only. The design's third value, `project`, requires the projects table Phase 3 creates; the enum is extended then. Shipping a scope that references a nonexistent table now would be worse. |
| Drag ordering | Fractional position strings (approved design), one row written per drop |
| [overnight call] Fractional index scheme | Lexicographic base-62 midpoint strings (the "fractional-indexing" algorithm), implemented in `packages/shared` (~60 lines) rather than a dependency, so api and web share one implementation and it is testable |
| Live sync | One SSE endpoint broadcasting entity-changed hints; clients invalidate TanStack Query keys (no payloads over the wire, just "companies changed", "deal X changed") |
| Won/lost | `status` enum open/won/lost + `lost_reason` text, per design; closing a deal stamps `closed_at` |
| Funnel view | Per-pipeline: deals count + value sum per stage, computed server-side in one grouped query |
| [overnight call] Currency | Single default currency per instance via an env-configurable `DEFAULT_CURRENCY` (default EUR), stored per deal as the design requires. Multi-currency UI deferred; the column exists so nothing migrates later. |

## Data model (migrations 0002+, additive)

- `pipelines` — id, name NOT NULL, `scope` text CHECK (`global` | `company`), `company_id` FK NULL,
  CHECK (scope = 'company') = (company_id IS NOT NULL), `position` text NOT NULL (ordering among
  sibling pipelines), `archived_at`, timestamps. Company-scoped pipelines render on the company page.
- `stages` — id, `pipeline_id` FK NOT NULL, name NOT NULL, `position` text NOT NULL,
  `probability` int NULL (0-100 CHECK), `rot_days` int NULL, timestamps. Deleting stages is not
  supported in Phase 2 (archive the pipeline instead); stages are reordered by position.
- `deals` — id, title NOT NULL, `pipeline_id` FK NOT NULL, `stage_id` FK NOT NULL, `position` text
  NOT NULL (fractional index within the stage), `value_cents` bigint NULL, `currency` char(3)
  NOT NULL default from config, `expected_close_date` date NULL, `status` text CHECK
  (`open`|`won`|`lost`) default open, `lost_reason` text NULL, `closed_at` timestamptz NULL,
  `owner_user_id` FK NULL, `company_id` FK NULL, `contact_id` FK NULL, `archived_at`, timestamps.
  CHECK: `lost_reason` only when status = lost; `closed_at` set iff status != open.
- `events` gains a nullable `deal_id` FK and the verb list grows: `stage_changed`, `won`, `lost`,
  `reopened`. Notes and files gain nullable `deal_id` FKs (CHECKs updated from
  `num_nonnulls(company_id, contact_id) = 1` to include deal_id).
- `users` untouched.

## Services (copying the hardened Phase 1 pattern: transactional row+event writes, atomic archived
guards, diff-based change events, keyset pagination)

- `pipelines.ts` — CRUD + archive; `listPipelines({ scope?, companyId? })`; stage management
  (create, rename, reorder via position) folded in here since stages have no independent life.
- `deals.ts` — create (into a stage, position appended at end), update, archive; `moveDeal(dealId,
  stageId, beforeDealId?, afterDealId?)` computing the fractional position server-side from its
  neighbours' positions (client sends neighbour ids, not positions — the server is authoritative);
  `winDeal`, `loseDeal(reason)`, `reopenDeal`; `listDeals({ pipelineId, stageId?, status?, ... })`;
  `funnel(pipelineId)` returning per-stage `{ stageId, count, valueCents }` for open deals.
- `sse.ts` — an in-process pub/sub: services publish `{ kind: "invalidate", keys: [...] }` after
  commit; the SSE route holds client connections and fans out. Single-process app, so no external
  broker. Heartbeat comment every 25s so proxies do not idle-close.
- Search gains deals (title ILIKE) as a fourth group.

## Routes

- `/api/pipelines` CRUD + `/api/pipelines/:id/stages` (POST create, PATCH :stageId, POST reorder)
- `/api/deals` CRUD + `POST /api/deals/:id/move` `{ stageId, beforeDealId?, afterDealId? }` +
  `POST .../win`, `POST .../lose` `{ reason }`, `POST .../reopen`
- `GET /api/pipelines/:id/funnel`
- `GET /api/stream` — SSE (text/event-stream). nginx conf already has `proxy_buffering off`.
- Search response gains `deals`.

## Frontend

- `@dnd-kit/core` + `@dnd-kit/sortable` kanban: columns = stages, cards = deals (title, value,
  company, owner avatar-letter, rot indicator when untouched > rot_days). Drag between/within
  columns calls `moveDeal` optimistically (TanStack Query optimistic update, rollback on error).
- Pipelines index page (global pipelines + per-company sections), pipeline board page, deal detail
  page (fields, win/lose/reopen buttons with lost-reason dialog, rail with timeline/notes/files —
  the rail components already accept entity props and gain `dealId`).
- Funnel view: horizontal bar per stage (count + formatted value), pure CSS widths.
- SSE client: one `EventSource` opened by the shell, invalidating query keys from hints;
  reconnects with backoff; ignores hints for data the tab does not hold.
- Company detail gains a Pipelines section listing company-scoped pipelines and a "New pipeline"
  affordance.

## Testing

Service/route tests as Phase 1 (fractional-index edge cases: repeated midpoints between the same
neighbours must stay ordered and bounded in length; move races: two concurrent moves of different
deals to the same gap must not collide thanks to per-move neighbour reads). SSE: route test
asserting events arrive on a subscribed connection after a mutation. Playwright: extend the journey
with a pipeline: create pipeline with 3 stages, create 2 deals, drag one between stages (dnd-kit
keyboard-accessible drag: use keyboard events, more reliable than mouse simulation in CI), win one,
assert funnel numbers and timeline entries.

## Rollout

v0.3.0 by the same release mechanics. The live upgrade is Chris's command, as ever.

Deferred: project scope (Phase 3), multi-currency UI, stage deletion/merge, pipeline templates
(design lists them under "Scoped + templates" as a later enhancement), weighted forecast views.
