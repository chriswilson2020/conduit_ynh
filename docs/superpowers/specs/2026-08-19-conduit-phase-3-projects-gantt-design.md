# Conduit Phase 3 — Projects, tasks & Gantt

## Context

Phases 0-2 are live (v0.3.0): CRM core plus pipelines/deals with kanban, funnel and SSE. Phase 3
delivers the project-management half of the original vision: projects, the unified task entity,
a per-project task board, and the drag-resizable Gantt — the design's #1 flagged technical risk,
handled through an explicit prototype gate.

Decisions taken with Chris in the Phase 3 brainstorm:

| Decision | Choice |
|---|---|
| Gantt component | Two-day throwaway prototype first; Chris gets a try-it-in-browser verdict before any build-vs-buy money question. Everything downstream assumes custom; a failed gate re-plans only the Gantt tasks around a commercial component. |
| Gantt scope | Per-project Gantt AND a global Gantt (all dated tasks across projects and standalone CRM tasks, grouped by project) |
| Drag behaviour | **Auto-shift dependents**: push-only cascade, server-authoritative (details below) |
| Project pipelines | Yes — pipelines gain the `project` scope, completing the original three-scope design |

## Data model (migrations 0003+, additive)

- `projects` — id, name NOT NULL, `company_id` FK NULL, `deal_id` FK NULL (originating deal),
  `owner_user_id` FK NULL, `status` text CHECK (`active`|`completed`) default active,
  `start_date` date NULL, `due_date` date NULL, `color` text NULL (hex, CHECK format),
  `archived_at`, timestamps.
- `tasks` — id, title NOT NULL, description text NULL (plain text), `type` text CHECK
  (`task`|`call`|`meeting`|`email`|`deadline`) default task, `status` text CHECK
  (`todo`|`in_progress`|`blocked`|`done`) default todo, `assignee_user_id` FK NULL,
  `start_date` date NULL, `due_date` date NULL, CHECK (both null or start <= due),
  `completed_at` timestamptz NULL CHECK (set iff status = done), `progress_pct` int NULL
  CHECK 0-100, `parent_task_id` FK tasks NULL (one level of subtask grouping — the service
  rejects a parent that itself has a parent), `position` text COLLATE "C" NOT NULL (fractional,
  advisory-locked appends; sibling group = same parent within the same project, or the
  standalone pool), `company_id` FK NULL, `contact_id` FK NULL, `deal_id` FK NULL,
  `project_id` FK NULL, `archived_at`, timestamps. Entity FKs are all optional and freely
  combinable (a task may reference a contact AND a project); unlike notes/files there is no
  exactly-one CHECK — tasks are first-class, not attachments.
- `task_dependencies` — `predecessor_id` FK NOT NULL, `successor_id` FK NOT NULL, `type` text
  CHECK (`FS`) NOT NULL default FS (column exists so SS/FF/SF are a CHECK widening later, not a
  migration), UNIQUE (predecessor_id, successor_id), CHECK (predecessor_id <> successor_id).
  **Cycle detection in the service**: adding a dependency runs a reachability walk inside the
  transaction and rejects with ConflictError if the successor already reaches the predecessor.
- `pipelines` — scope CHECK widens to (`global`|`company`|`project`), `project_id` FK NULL,
  pairing CHECK updated (company scope pairs company_id; project scope pairs project_id).
- `events` — verb list widens (`shifted`, `completed`, `reopened_task`, `dependency_added`,
  `dependency_removed`), gains `task_id` and `project_id` FKs. notes/files gain `project_id`
  and `task_id`? No: notes/files gain **project_id only** (exactly-one CHECK widens to four);
  tasks are not note/file targets in Phase 3 — commentary on work goes on the project or the
  linked CRM record.
- users untouched.

## Auto-shift semantics (push-only cascade)

`scheduling.ts` owns one operation: `shiftTask(db, actorId, taskId, { startDate, dueDate })`.

- Applies the new dates to the dragged task (resize = dates change independently; move = both
  shift by the same delta — the SERVICE just receives the new pair; the distinction lives in
  the UI).
- Then walks FS successors transitively: any successor whose `start_date` is now earlier than
  its predecessor's `due_date` shifts RIGHT by exactly the violation amount (its duration is
  preserved); its own successors re-check in turn. Tasks with null dates never shift and stop
  the walk through them.
- **Dragging earlier never pulls successors left.** Slack is legal. Only violations push.
- Days are days: no working-calendar arithmetic. Weekends shade on the chart, nothing more.
- The whole cascade runs in ONE transaction under an advisory lock keyed on the project (or the
  standalone pool), bounded by a depth guard (defence against a cycle that slipped past
  detection: abort the transaction rather than loop).
- Every shifted task gets its own `shifted` event with payload `{ from: {start,due},
  to: {start,due}, cascadedFrom: draggedTaskId }`; the dragged task's event has no
  cascadedFrom. The API response returns every moved task so the UI can flash them.
- SSE hints: `[["tasks", projectId], ["gantt"], ["events"]]` (+ `["my-tasks", assigneeId]` per
  distinct assignee touched).

## Services & routes

- `projects.ts` — hardened-pattern CRUD/archive; `listProjects({ companyId?, status?, archived? })`;
  completing a project does NOT auto-complete its tasks (deliberate; comment it).
- `tasks.ts` — CRUD/archive; status transitions (any-to-any except done requires progress
  semantics? No — statuses are freely settable; `done` stamps `completed_at`, leaving `done`
  clears it, CHECK enforces pairing); `moveTaskOnBoard` (status + position, kanban semantics
  reusing the Phase 2 neighbour/lock/gap-tighten pattern); assignment; `listTasks` filters
  (projectId, assigneeId, status, dated-only); dependency add/remove with cycle check.
- `scheduling.ts` — shiftTask as above; `ganttPayload(projectId | global)` returning tasks
  (dated, unarchived, grouped/ordered) + dependencies in one shape the chart consumes.
- Routes follow Phase 2 conventions (`/api/projects...`, `/api/tasks...`,
  `POST /api/tasks/:id/shift`, `POST /api/tasks/:id/dependencies`, `DELETE .../dependencies/:predecessorId`,
  `GET /api/projects/:id/gantt`, `GET /api/gantt`). Search gains a `tasks` group (title ILIKE,
  archived excluded). ConflictError already maps to 409.

## Frontend

- **G0, the prototype gate (first task of the phase):** throwaway route `/gantt-lab` behind the
  dev flag, synthetic data, CSS-grid timeline, dnd-kit-free raw pointer-event drag/resize (the
  Gantt needs pixel-continuous drag, not sortable semantics), SVG dependency arrows, 200 rows.
  Hard criteria in the plan: resize and move track the pointer without visible lag at 200 rows;
  arrows re-render during drag; day/week zoom both legible; keyboard fallback plan articulated.
  Verdict goes to Chris with a URL on the dev server; buy decision only if it fails.
- Projects index (list + create dialog) and detail (FieldCard incl. colour + status; its tasks
  list; its pipelines section — project-scoped now; rail with projectId).
- Per-project **task board**: fixed status columns (todo/in_progress/blocked/done), Phase 2
  kanban machinery (collision fix and all) with fixed columns instead of stages.
- **My Tasks** page: everything assigned to me, undated tasks included, grouped
  overdue/today/upcoming/undated; quick status toggle.
- **Gantt page(s)**: per-project and global (grouped by project, standalone tasks last).
  Rows grouped by parent task; bars coloured by project colour; drag body = move, drag edges =
  resize, wired to shiftTask with optimistic update + rollback; cascaded bars flash after the
  response lands; red arrows for violated dependencies that push-only could not fix (only
  possible transiently client-side); zoom day/week; today line; weekend shading; dependency
  create by dragging from a bar's edge handle to another bar (fallback: an "Add dependency"
  select on the task detail drawer for accessibility, which is also the Playwright path).
- Task detail as a drawer/panel from board or Gantt (fields, links, dependencies list, delete).
- Search dropdown gains Tasks group.

## Testing

- scheduling.test.ts is the centrepiece: linear chains, diamonds (two paths converge — task
  shifts by the MAX violation, exactly once), cycle rejection at insert, depth-guard abort,
  earlier-drag-no-pull, null-dated stopper, duration preservation, event cascadedFrom marking,
  cross-assignee SSE key lists.
- Board/position tests reuse Phase 2 patterns; project pipelines get scope tests.
- Playwright journey: project → 3 tasks → dependency A→B → drag A right → B visibly shifts →
  complete B via board drag to done → My Tasks reflects → global Gantt shows the project group
  → search finds the task.

## Rollout

v0.4.0 by the established mechanics; live upgrade is Chris's command. Deferred: SS/FF/SF
dependency types, working-day calendars, auto-pull on earlier drags, task templates, recurring
tasks, notes/files attached directly to tasks.
