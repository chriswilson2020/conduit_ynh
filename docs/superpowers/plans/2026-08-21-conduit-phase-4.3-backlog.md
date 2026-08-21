# Conduit Phase 4.3 — Per-user Hide + backlog sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Per-user Hide-in-CRM (hide rows per viewer, thread-global flag retired, Hidden view) plus the small-fixes sweep (detail cap, forward re-attach, archived-pipelines view, 1280px header, deepmerge-ts overrides) — released as v0.8.0.

**Architecture:** One table (`mail_thread_hides`, migration 0007 with backfill), one hide predicate composed with the 4.2 visibility family, one inverted-arm Hidden view on the existing list machinery, a payload-bound detail cap. Spec: `docs/superpowers/specs/2026-08-21-conduit-phase-4.3-backlog-design.md` — the authority.

**Tech Stack:** No new dependencies (the deepmerge-ts item is an overrides pin). All Phase 4/4.1/4.2 conventions BINDING (CONDUIT_REMOTE_DIR remote.sh; ASCII with String.fromCharCode fixtures; unshipped migrations editable in place with journal-timestamp preservation + psql convergence of conduit_test; the independent-EXISTS fold discipline; the three-unread-computations lesson; comment discipline: state only what was measured; targeted adds). Suite at start: 1547 unit + 36 integration + 50 e2e, green. Branch `worktree-phase-4.3-backlog` from the v0.7.0 manifest commit (58d0d63).

**Cross-phase sequencing note (load-bearing):** migration 0007 is built in TWO steps so every task compiles and stays green. Task 1 ships 0007 as CREATE TABLE + backfill only, with `mail_threads.archived_at` still present and every existing filter untouched. Task 2 appends the `DROP COLUMN` to the SAME 0007 file (unshipped → editable in place, journal timestamp preserved, conduit_test converged via psql) in the same commit that removes the column from schema.ts and swaps every reference to the hide predicate — the compiler then enforces the swap's completeness.

---

### Task 1: Schema 0007 (step one) + shared contracts

`mail_thread_hides`: `thread_id` FK, `user_id` FK, `hidden_at` timestamptz NOT NULL DEFAULT now(), PK (`thread_id`,`user_id`). Backfill in the same migration: INSERT one row per (archived thread × existing user) carrying `archived_at` as `hidden_at` — the upgrade-changes-nobody's-view decision. NO column drop yet (see sequencing note). Drill via `withPreMigrationDatabase("0007", ...)`: pre-0007 archived thread comes back hidden for every pre-existing user, unarchived for none. Shared contracts, all of them now with server placeholders where Task 2/3 fills in: thread list item + detail replace `archivedAt` with viewer-scoped `hiddenAt` (nullable ISO — comment that it is PER-VIEWER, sourced from the hide row, placeholder `null` until Task 2); `hidden` tri-state flag on threadListFilters (the archived-flag pattern); `totalMessages` + `truncated` on the detail schema + the `all` query param (placeholders: full count, false — faithful no-ops until Task 3). db:generate drift-free; conduit_test converged. ~8 tests.

### Task 2: The hide predicate + every read path + service surgery

Append `DROP COLUMN archived_at` to 0007; remove from schema.ts; the compiler lists every swap site. `hiddenByViewer(userId)` helper in mail-threads.ts composed with (never replacing) the 4.2 family — default surfaces get `AND NOT hidden`, the Hidden view (`?hidden=true`) gets `AND hidden` on the same list machinery (folder/account filters compose unchanged; fold discipline applies — the hide arm is a thread-level EXISTS, visibility stays message-granular). Swap sites per the compiler + the spec: list, all three unread computations, record tabs, search (search.ts's `isNull(mailThreads.archivedAt)` becomes the not-hidden arm — it needs the userId it already has), mail-move's hide path. Detail stays accessible for hidden threads (mustGetThread unchanged); `hiddenAt` surfaced on list + detail from the viewer's row. `setArchived`/`archiveThread`/`hideThreads` become per-actor hide-row insert/delete: idempotent both ways, bulk vocabulary unchanged, publishThreadHint unchanged (per-user results at refetch). The hide matrix tested per the spec's Testing section — hider/other × every surface, composed with visibility (hidden-but-invisible stays invisible). ~28 tests. The phase's core task.

### Task 3: Detail cap + forward re-attach + web sweep items

API: `getThreadDetail` returns the newest 50 VISIBLE messages (cap applies after the visibility filter — the payload bound is on what renders), `totalMessages` (visible total) + `truncated`; `?all=true` uncapped. Mark-read and reply-chain semantics unchanged (they already read the full/newest-visible sets server-side — assert in tests, boundary at exactly 50). Forward re-attach in mail-send: outgoing forward carries the original message's stored attachments (existing compose size caps enforced; test the cap refusal). Web: "Show earlier messages (N more)" control; Hidden view UI (inbox filter + Unhide button, testids); `hiddenAt`-aware conversation Hide/Unhide button state; the 1280px conversation-header fix. ~16 tests.

### Task 4: Archived pipelines + deps + e2e + release prep

Company detail: read-only archived-pipelines view (API list filter param if missing + web "show archived" control, matching the deals-side archive philosophy; authz unchanged). deepmerge-ts overrides entry in the root package.json; lockfile regenerated ON THE SERVER; full suite green proves the pin changes nothing. e2e: two-user hide journey (A hides — gone from A's inbox/search, present in A's Hidden view, B's view untouched; A unhides — restored); Show-earlier route-level unless a >50-message fixture is cheap; archived-pipelines visible. RunId + per-attempt retry-scoped fixtures. Release prep 0.8.0: version bumps (3 package.jsons + manifest), server lockfile, CI gate on the pushed branch, handoff artifacts (release notes covering the migration promise "upgrade changes nobody's view", sequence sheet citing the merge candidate's run, live checklist per the spec's Rollout). Coordinator gates the merge.

---

Sequencing: 1→2 strict (the sequencing note); 3 after 2 (same files); 4 last (its e2e needs 2+3). Each task: implement → spec review → quality review, the standing loop.
