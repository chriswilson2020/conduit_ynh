# Conduit Phase 3 — Projects, Tasks & Gantt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects, the unified task entity, a per-project status board, My Tasks, and a drag-resizable Gantt with push-only dependency cascade — released as v0.4.0, with the Gantt build-vs-buy decision made by an up-front prototype gate.

**Architecture:** Three new tables (projects, tasks, task_dependencies) plus scope/verb widenings. `scheduling.ts` owns the cascade as one transactional, advisory-locked operation. The Gantt is a custom CSS-grid timeline with raw pointer-event drag (not dnd-kit — bars need pixel-continuous movement, not sortable semantics), pending the G0 prototype verdict.

**Tech Stack:** Existing stack. No new dependencies expected (G0 may change that — that is its job).

---

## Conventions

Identical to Phase 2's plan: `./scripts/remote.sh` for every command; NodeNext `.js` extensions in api, none in web; ASCII-only sources with `\u` escapes, byte-scan before commit; ApiError code/status branching; testids for structure, roles for controls; Playwright runs ONLY in CI (iterate via push + `gh run view --log-failed`; the SSH-tunnel local trick from P2.9's report is available — document and clean up if used). Suite at start: 356 unit + 18 e2e, all green. Hardened service pattern: `services/deals.ts` + `pipelines.ts` (advisory `lockSiblingGroup`, atomic guards, diff events via `fieldChanged`, gap-tighten with directional ORDER BY, publish-after-commit SSE hints).

## File structure

| Path | Responsibility |
|---|---|
| `packages/web/src/pages/gantt-lab.tsx` (G0, throwaway) | Prototype gate: raw drag/resize timeline, synthetic data |
| `packages/api/drizzle/0003_*` + `db/schema.ts` | projects, tasks, task_dependencies; pipeline scope + events verbs widened; notes/files project_id |
| `packages/shared/src/index.ts` | project/task/dependency schemas + inputs, shift input/result, gantt payload, search tasks group |
| `packages/api/src/services/projects.ts` | Hardened CRUD/archive |
| `packages/api/src/services/tasks.ts` | Task CRUD/archive, status set (completed_at pairing), board moves, dependencies + cycle walk |
| `packages/api/src/services/scheduling.ts` | shiftTask cascade + ganttPayload |
| `packages/api/src/routes/{projects,tasks,gantt}.ts` | REST per Phase 2 conventions |
| `packages/web/src/pages/{projects,project-detail,my-tasks,gantt}.tsx` | The four pages |
| `packages/web/src/components/{task-board,task-drawer,gantt/*}.tsx` | Board reuse, drawer, chart pieces |
| `e2e/tasks.spec.ts` | The Phase 3 journey |

---

### Task 1 (G0): Gantt prototype gate — FIRST, and the verdict goes to Chris

**Files:** Create `packages/web/src/pages/gantt-lab.tsx` (+ route in router.tsx behind `import.meta.env.DEV || window.__CONDUIT_BASE__` — no: register it always but link it nowhere; it is throwaway and removed in Task 9). No API changes; synthetic data generated in the component.

Build, in deliberately rough form:
- A CSS grid: left column task names (200 synthetic tasks, 8 groups), timeline columns = days for 6 months (~180 cols), `grid-auto-columns: minmax(24px, 1fr)` at day zoom, week zoom = 26 cols.
- Bars: absolutely positioned divs inside row-height wrappers, `left/width` computed from dates at px-per-day.
- Drag body → move (both dates shift), drag 6px edge zones → resize; raw `pointerdown/pointermove/pointerup` with `setPointerCapture`, updating local state; `requestAnimationFrame`-throttled.
- Dependencies: 150 synthetic FS pairs; SVG overlay (`<svg>` absolutely positioned over the grid) drawing elbow connectors predecessor-end → successor-start, re-computed during drag.
- Today line, weekend shading (nth-child or computed), day/week zoom toggle.

**Acceptance criteria (the gate):**
1. Bar move and edge-resize visually track the pointer with no perceptible lag at 200 rows / 150 arrows (Chrome, dev server hardware).
2. Arrows follow their bars live during drag.
3. Both zoom levels legible; horizontal scroll smooth.
4. A one-paragraph written keyboard-accessibility plan for the real build (arrow-key nudge on a focused bar is sufficient).

**Verdict step:** build it, deploy the built SPA to the dev server on a spare port, and report PASS/FAIL per criterion with honest notes. The coordinator takes the verdict (and a URL) to Chris. **A FAIL re-plans Tasks 9-only around a commercial component; everything else proceeds regardless.** Do not polish; it is throwaway. Commit: `spike: gantt-lab prototype (throwaway)`.

### Task 2: Schema 0003 + shared contracts

Drizzle: the three tables per the spec verbatim (all CHECKs: dates pairing `(start_date IS NULL) = (due_date IS NULL) OR start_date <= due_date` — express as the spec says: both null or start <= due; completed_at iff done; progress 0-100; hex color format; dependency self-ref + FS + UNIQUE pair), `position` via the existing `positionText` customType, pipeline scope CHECK widened + `project_id` FK + pairing CHECK updated, events verbs + `task_id`/`project_id` FKs, notes/files `project_id` + exactly-one CHECK widened to four. Config untouched. Shared: `projectSchema`/`taskSchema`/`taskDependencySchema` + create/update inputs, `shiftTaskInputSchema` `{ startDate, dueDate }` (ISO dates, both required — a shift always sets both), `shiftResultSchema` `{ moved: [{ id, startDate, dueDate, cascadedFrom }] }`, `ganttPayloadSchema` `{ tasks: [...], dependencies: [...] }`, verbs, search `tasks` group. Migration 0002-style upgrade-with-data verification (existing notes/files/pipelines rows survive the CHECK swaps — test with rows present). Tests per Phase 2 Task 1 conventions.

### Task 3: Projects service

Hardened pattern copy (companies.ts shape): CRUD/archive, `listProjects({ companyId?, status?, archived? })` unpaginated with tradeoff comment, company/deal existence checks (monotonic comment), events on the project (project_id) dual-stamped with company_id when set, SSE keys `[["projects"], ["project", id], ["events"], ["search"]]`. Completing a project does not touch its tasks (comment). ~12 tests.

### Task 4: Tasks service

- CRUD: entity FKs freely combinable (existence checks each when supplied; archived targets VALID here — a task may reference an archived company deliberately, comment why: tasks are work items, not attachments; only an archived PROJECT rejects new tasks into it).
- `parent_task_id`: parent must be in the same project (or both standalone), parent must not itself have a parent (one level), ConflictError otherwise.
- `setTaskStatus(id, status)`: freely settable; entering `done` stamps completed_at + `completed` event; leaving done clears it (+ `reopened` event); other transitions emit `updated` with changed.
- `moveTaskOnBoard(id, { status, beforeTaskId?, afterTaskId? })`: Phase 2 moveDeal pattern verbatim (lock per project+status group, neighbour verify, directional gap-tighten, no-neighbours = tail).
- Dependencies: `addDependency(predecessorId, successorId)` — same-project-or-both-standalone check, then cycle walk INSIDE the transaction:

```typescript
// Reject a dependency that would create a cycle: if predecessor is reachable
// FROM successor via existing edges, adding successor->...->predecessor->successor
// would loop -- and the cascade in scheduling.ts would never terminate. The walk
// is a BFS over task_dependencies bounded by 10_000 visited nodes (defence in
// depth; a real project graph is tiny).
```

  BFS with a visited set via iterative `inArray` queries (batched per frontier, not per node). `removeDependency`. Events `dependency_added`/`dependency_removed` on the successor, payload `{ predecessorId }`.
- `listTasks({ projectId?, assigneeId?, status?, dated?, archived? })`; My Tasks uses `assigneeId`.
- SSE keys `[["tasks", projectId ?? "standalone"], ["gantt"], ["events"], ["search"]]` + `["my-tasks", assigneeId]` when assigned.
~20 tests incl. cycle chains (direct, transitive, self already blocked by CHECK), parent rules, board move race reuse.

### Task 5: Scheduling service

`shiftTask(db, actorId, taskId, { startDate, dueDate })`:

```typescript
// Push-only cascade, whole thing in ONE transaction under the project's advisory
// lock (group `gantt:${projectId ?? "standalone"}`):
// 1. Guard: task exists, not archived, dates valid (start <= due). Apply new dates.
// 2. frontier = [taskId]; moved = new Map([[taskId, {from, to, cascadedFrom: null}]])
// 3. While frontier not empty (depth guard: iterations > 500 -> throw, transaction
//    aborts -- a cycle slipped past addDependency's walk; better to fail loudly
//    than loop): load FS successors of the frontier with their dates; for each
//    successor whose start_date < its (possibly-just-moved) predecessor's due_date:
//    delta = predecessor.due - successor.start; shift BOTH its dates by delta
//    (duration preserved); record in moved (if already moved this walk, apply the
//    LARGER resulting start -- diamond convergence shifts once by the max, so
//    re-process it); push into next frontier.
// 4. Null-dated successors never shift and stop the walk through them.
// 5. Dragging earlier produces no violations -> no cascade. Slack is legal.
// 6. One UPDATE per moved task + one `shifted` event each, payload
//    { from: {start, due}, to: {start, due}, cascadedFrom } (null for the dragged
//    task). Return every moved row (shiftResultSchema shape).
```

Diamond note: process a task at most once per "settled" pass — simplest correct approach: loop until no violations remain (bounded by the depth guard), since each pass only pushes right and is monotonic; document termination argument. `ganttPayload(db, { projectId } | { global: true })`: dated unarchived tasks (+ their project name/color for grouping in global), ordered (project, parent-group, position), plus all dependencies among the returned set. SSE after commit: tasks/gantt/events + affected my-tasks keys. ~14 tests per the spec's list (chains, diamond max-once semantics, cycle abort, no-pull, null stopper, duration, events, payload shape).

### Task 6: Routes + search tasks

Per Phase 2 conventions and helpers: `/api/projects` CRUD+archive; `/api/tasks` CRUD+archive with the filters; `POST /api/tasks/:id/status`; `POST /api/tasks/:id/board-move`; `POST /api/tasks/:id/shift` (shiftResult response); `POST /api/tasks/:id/dependencies` + `DELETE /api/tasks/:id/dependencies/:predecessorId`; `GET /api/projects/:id/gantt`; `GET /api/gantt`. Search service + route + tests gain `tasks` (title ILIKE, archived excluded, done INCLUDED). defaultCurrency-style config threading not needed. ~14 route tests (happy + 400/404/409 per family, cycle 409, shift cascade visible in response).

### Task 7: Web — projects pages + task board

Hooks (queries.ts, parseWith, SSE-mirrored invalidation): `useProjects`/`useProject`/`useCreateProject`/`useUpdateProject`/`useArchiveProject`, `useTasks`, `useCreateTask`/`useUpdateTask`, `useSetTaskStatus`, `useBoardMoveTask`, `useAddDependency`/`useRemoveDependency`, `useShiftTask` (optimistic dates + flash list from response), `useGantt(projectId | global)`, `useMyTasks(userId)`. Projects index (entity-table pattern; columns name/company/owner/status/due). Project detail: FieldCard (name, status select, dates, colour swatch input `type="color"`, owner, company link), Pipelines section (project-scoped — reuse company-detail's), tasks summary list linking to board/gantt, rail with projectId. Task board page `/projects/$projectId/board`: four fixed status columns via the Phase 2 kanban machinery (custom collision + keyboard coordinate getter REUSED — extract shared pieces from board.tsx into `components/kanban-core.tsx` rather than copy-pasting; boards differ only in column source and card content+move call). Task cards: title, assignee initial, due date (red when overdue), type icon letter. New-task dialog per column.

### Task 8: Web — My Tasks + task drawer + search group

My Tasks `/my-tasks`: `useMyTasks(me.id)` grouped overdue/today/upcoming/undated; row click opens the drawer; quick status checkbox (done/undone). Task drawer (`components/task-drawer.tsx`, Radix Dialog side-panel styling): fields (title, description textarea, type select, status select, assignee, dates, progress number 0-100, entity links incl. project), dependencies list (predecessors with remove buttons + an "Add dependency" select of same-project tasks — the accessible path Playwright uses), archive. Search dropdown gains Tasks group (navigates to the drawer via the task's project board or My Tasks; simplest: `/projects/$projectId/board?task=<id>` opening the drawer on mount, standalone tasks via `/my-tasks?task=<id>`). Nav gains Projects + My Tasks.

### Task 9: Web — the real Gantt (contingent on G0 PASS)

`components/gantt/{chart,bar,arrows,timescale}.tsx` + `pages/gantt.tsx` (`/projects/$projectId/gantt` and `/gantt` global). Productionise the G0 approach: data from `useGantt`, bars per task (project colour; parent tasks render as slim summary spans), body-drag move + edge-resize → `useShiftTask` optimistic with rollback; cascade flash (response's moved list minus the dragged id gets a 1s highlight class); dependency-create by edge-handle drag to another bar with the drawer select as fallback; day/week zoom; today line; weekend shading; keyboard: focused bar, arrows nudge ±1 day (shift = resize), Enter opens drawer — per G0's written plan. Group rows by project in global view, standalone last. Delete `gantt-lab.tsx` and its route. Board/gantt/drawer testids: `gantt`, `gantt-bar-<taskId>`, `gantt-arrow-<pred>-<succ>`, `task-drawer`, `board`, `column-<status>`, `card-<taskId>`.

### Task 10: Playwright journey

`e2e/tasks.spec.ts`, serial, runId names: create project → open board → create 3 tasks in todo → drag one to in_progress (keyboard, reusing P2.9's proven pattern) → open drawer, set dates on A and B, add dependency A→B → open project Gantt → keyboard-nudge A right past B's start → assert B's bar shifted (dates via drawer or bar title attr) and a `shifted` timeline entry exists → drag B's card to done on the board → My Tasks shows the remaining assigned work → global Gantt shows the project group → search finds a task. CI-iterated; the SSH-tunnel local trick available.

### Task 11: Release 0.4.0

Phase 2 Task 10 mechanics verbatim (bump, CI gate, ff-merge to main, tag, Release workflow, manifest sha, branch cleanup, morning-command for Chris). Subpath spot-checks ride along on the live verification.
