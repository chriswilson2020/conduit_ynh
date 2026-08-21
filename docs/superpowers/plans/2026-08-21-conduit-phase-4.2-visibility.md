# Conduit Phase 4.2 — Mail Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Private-by-default mail visibility per account: a visibility predicate applied to every mail read path, owner-only IMAP moves, a per-account Private/Shared toggle — released as v0.7.0.

**Architecture:** One column (migration 0006), one predicate pair (`inbox-visible` / `record-visible`) built once in mail-threads.ts and applied exhaustively per the spec's table, one new skip reason (`not_owner`) in the move service, one Settings toggle. Spec: `docs/superpowers/specs/2026-08-21-conduit-phase-4.2-visibility-design.md` — the authority; its predicate table is the checklist.

**Tech Stack:** No new dependencies. All Phase 4/4.1 engine and review conventions are BINDING (CONDUIT_REMOTE_DIR remote.sh; ASCII with String.fromCharCode fixtures; the three-unread-computations lesson; the skip-reason precedence types; hand-written-index rules; comment discipline: state only what was measured). Suite at start: 1472 unit + 36 integration + 46 e2e, green. Branch `worktree-phase-4.2-visibility` from the v0.6.0 tip.

---

### Task 1: Schema 0006 + shared contracts

Migration 0006: `mail_accounts.visibility` text NOT NULL CHECK (`private`|`shared`) DEFAULT `'private'` — the ALTER's default IS the everything-becomes-private migration (assert in the drill: a pre-0006 account row comes back `private`). Extend the scratch-DB drill via the existing `withPreMigrationDatabase("0006", ...)` helper. Shared: `mailVisibilitySchema` enum; `visibility` on `mailAccountSchema` + the update input (NOT create — accounts are born private; comment why); `not_owner` added to `bulkThreadSkipReason` (the `NotedSkipReason`/rank types force the precedence decision at compile time — it IS a noted, per-row reason unlike `out_of_scope`; slot it in the rank table with a comment); `ownedByViewer: z.boolean()` on `mailThreadListItemSchema` AND the thread-detail schema. db:generate drift-free; conduit_test converged via plain migrate. ~8 tests.

### Task 2: The visibility predicate + every read path

`mail-threads.ts`: `visibleThreads(userId, scope: "inbox" | "record")` — one SQL helper pair (the `notInAccountTrash` pattern; EXISTS over mail_messages joined to mail_accounts on `owner = U OR visibility = 'shared'`, the record scope adding `deal_id IS NOT NULL OR project_id IS NOT NULL` on the thread). Applied per the spec's table: thread list (inbox scope), thread detail (record scope; invisible → the indistinguishable NotFoundError), ALL THREE unread computations (badge, list flag/filter, byFolder — each composed with the 4.1 unread-scopes rule, and the INCLUDE index's index-only property re-EXPLAINed after the predicate lands: state what was measured, extend 0006 with an index ONLY if measured necessary), record Mail tab filters (contact/company: record-visible AND linked-to-that-record; deal/project: record-visible), search mail group (record scope). `ownedByViewer` computed in the existing aggregate pass (>= 1 message on an actor-owned account). The predicate matrix (owner/other x private/shared x unlinked/contact-linked/deal-linked) tested against EVERY surface — the three unread computations each get the matrix; route-level authz tests for detail-404/list/search exclusion. ~30 tests. This is the phase's core task; the spec table is the completeness checklist and the reviewer's first grep.

### Task 3: Move rights + the Settings toggle (API side)

`mail-move.ts`: actor-ownership joins the candidate eligibility filters (BEFORE refusals, per the 4.1 ordering rule): messages on accounts the actor does not own → excluded with noted reason `not_owner`; a thread whose whole in-scope set is unowned → `{ok: true, skipped: true, reason: "not_owner"}`; mixed-ownership threads move the owned half (test). Bulk stays auth-only at the route (visibility enforced by the predicate: you cannot NAME a thread you cannot see — thread ids arrive from lists the predicate already filtered; the detail-404 rule covers direct probing; comment this authz chain explicitly). `hide` unchanged (any viewer; thread-global, documented). Mark-read unchanged. `updateAccount` accepts `visibility` (owner-only as ever; NOT a connection change — wake only; flipping publishes `[["mail-accounts"]]` + `[["mail-threads"]]` + `[["mail-unread"]]` — every user's lists change). ~14 tests.

### Task 4: Web + e2e + release prep

- Settings: the Private/Shared toggle with the spec's copy (owner-only card section, `visibility-toggle-<id>` testid); optimistic off, plain mutation.
- Thread UI: Archive/Trash controls (bulk bar buttons, conversation buttons) gate on `ownedByViewer` — for the bulk bar: enabled only when EVERY selected thread is owned (else the per-thread `not_owner` skips explain, but the cleaner UX is disabling with the visible reason text, reusing the 4.1 blocked-note pattern); Hide-in-CRM always available. No other UI changes — lists simply shrink per the predicate.
- e2e: verify whether the harness supports a second user (per-request auth headers — check how CONDUIT_DEV_USER / the auth hook works in the e2e webServer env); if yes, the spec's two-user journey (B's empty inbox; A deal-links a thread; B sees it on the deal + search, NOT inbox; B's move controls absent, Hide present); if not, the route-level matrix carries the two-user cases and e2e covers the single-user surfaces (toggle flip visible, ownedByViewer gating with a seeded second account owned by the same user is NOT a substitute — say so honestly and lean on route tests). RunId-scoped, retry-safe per the 4.1 fixtures pattern.
- Release prep: bump 0.7.0 (3 package.jsons + manifest + server lockfile), CI gate green, handoff artifacts (ff-merge sequence, notes draft covering the visibility model + migration behavior + the sharing line, Chris's sudo command, live checklist: his account private post-upgrade → new user sees empty inbox; deal-link → appears for them on the record; shared flip restores). Coordinator gates the merge.

---

Sequencing note: Tasks 1→2→3 strictly ordered; Task 4's web half can start once 3's contracts land. Each task: implement → spec review → quality review, the standing loop.
