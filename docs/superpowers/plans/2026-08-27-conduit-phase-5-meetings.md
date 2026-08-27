# Conduit Phase 5 — Meetings & the record timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meetings as a first-class record with attendees and follow-up tasks, feeding the existing events timeline — and mail folded into that timeline without weakening Phase 4.2/4.3 privacy. Released as v0.9.0.

**Architecture:** Two new tables (`meetings`, `meeting_attendees`) in migration 0008 plus two new FK columns and three verbs on the existing `events` table. A meetings service shaped like notes.ts/files.ts, a fifth rail tab, and one privacy-critical change to `listEvents`: mail rows are pointers, joined at read time through the composed 4.2 visibility + 4.3 hide predicates. Spec: `docs/superpowers/specs/2026-08-27-conduit-phase-5-meetings-design.md` — the authority; its Decisions table and the mail-privacy matrix are the completeness checklists.

**Tech Stack:** No new dependencies (TipTap, sanitize-html, Drizzle, TanStack Query all present). All Phase 2-4.3 conventions BINDING: every command on the dev server via `CONDUIT_REMOTE_DIR=/home/chris/conduit-phase4 ./scripts/remote.sh '<cmd>'` from the worktree root (vitest from repo root); ASCII-only sources with `String.fromCharCode` for non-ASCII fixtures; NodeNext `.js` import extensions in `packages/api` only, none in `packages/web`; NEVER `drizzle-kit push`; shipped migrations immutable, unshipped ones editable in place with the journal timestamp preserved and `conduit_test` converged via psql; `db:generate` drift-free at every task end; the independent-EXISTS fold discipline; comment discipline (state only what was measured, never narrate changes); targeted `git add` only; archive-not-delete everywhere. Suite at start: 1586 unit + 36 integration + 57 e2e, green. Branch `worktree-phase-5-meetings` from the v0.8.0 manifest commit (99edcf4).

**File structure (locked in here, referenced by task):**

| File | Responsibility |
|---|---|
| `packages/api/src/db/schema.ts` | `meetings`, `meetingAttendees` tables; `events.meetingId`/`events.mailThreadId`; widened verb CHECK |
| `packages/api/drizzle/0008_*.sql` (+ snapshot, journal) | migration 0008 |
| `packages/api/src/db/schema.test.ts` | the `withPreMigrationDatabase("0008")` drill + constraint tests |
| `packages/shared/src/index.ts` | `meetingSchema`, `meetingAttendeeSchema`, create/update inputs, list filters, widened `eventVerbSchema`, `meetingId`/`mailThreadId` on `eventSchema` |
| `packages/api/src/services/meetings.ts` (new) | meetings CRUD, attendee set replacement, list filters incl. contact-attendance widening, event emission |
| `packages/api/src/services/meetings.test.ts` (new) | that service's tests |
| `packages/api/src/routes/meetings.ts` (new) | `/api/meetings` routes incl. `POST /:id/tasks` |
| `packages/api/src/routes/index.ts` | register the meetings routes |
| `packages/api/src/services/timeline.ts` | actor-aware `listEvents`; the mail-pointer join + visibility/hide filtering |
| `packages/api/src/services/timeline.test.ts` | the mail-privacy matrix |
| `packages/api/src/services/mail-ingest.ts` | emit `mail_received`/`mail_sent` with the per-thread-per-direction-per-day throttle |
| `packages/web/src/components/rail/meetings.tsx` (new) | the Meetings rail tab: list, log form, meeting view, follow-up tasks |
| `packages/web/src/components/rail/rail.tsx` | mount the fifth tab |
| `packages/web/src/components/rail/timeline.tsx` | badges + rendering for `met`/`mail_received`/`mail_sent` |
| `packages/web/src/queries.ts` | meetings hooks + the events hook's actor-scoped keys |
| `e2e/meetings.spec.ts` (new) | the meeting journey + the two-user privacy leg |

---

### Task 1: Migration 0008 + shared contracts

**Files:** `packages/api/src/db/schema.ts`, `packages/api/drizzle/0008_*.sql` + `meta/`, `packages/api/src/db/schema.test.ts`, `packages/shared/src/index.ts`, `packages/shared/src/index.test.ts`

`meetings`: `id` uuid PK defaultRandom, `title` text NOT NULL, `occurredAt` timestamptz NOT NULL, `durationMinutes` integer NULL, `notes` text NULL, `ownerUserId` uuid NOT NULL FK users, `companyId`/`contactId`/`dealId`/`projectId` uuid NULL FKs, `archivedAt` timestamptz NULL, `createdAt`/`updatedAt` timestamptz NOT NULL defaultNow. CHECK `meetings_has_link`: `company_id IS NOT NULL OR contact_id IS NOT NULL OR deal_id IS NOT NULL OR project_id IS NOT NULL` (the spec's reachability decision — comment WHY: no top-level list exists, so an unlinked meeting is unreachable the moment it saves). Follow the `events` multi-FK model deliberately, NOT notes' exactly-one — comment that a deal meeting legitimately carries its company too.

`meeting_attendees`: `id` uuid PK, `meetingId` uuid NOT NULL FK meetings, `contactId` uuid NULL FK contacts, `userId` uuid NULL FK users, `guestName` text NULL. CHECK `meeting_attendees_exactly_one` (notes' `notes_exactly_one_entity` is the pattern to mirror — read it first). Two partial unique indexes: `(meeting_id, contact_id) WHERE contact_id IS NOT NULL` and `(meeting_id, user_id) WHERE user_id IS NOT NULL`; guests deliberately not deduped (comment why: free text, two people can share a first name).

`events`: add `meetingId` uuid NULL FK meetings and `mailThreadId` uuid NULL FK mail_threads; widen the `events_verb_valid` CHECK with `met`, `mail_sent`, `mail_received`. Existing rows untouched; no backfill anywhere in 0008.

FK style: plain NO ACTION, matching every FK in this schema (archive-not-delete; nothing is ever deleted — see the 0007 DONE block's note).

Drill via the existing `withPreMigrationDatabase("0008", ...)` helper (0007's drill is the freshest example — copy its shape, including the premise-pinning assertion: assert BOTH new tables ABSENT before `migrate()` runs). Seed a pre-0008 company + event through raw SQL naming only pre-0008 columns; after migrate, assert the tables exist, the pre-existing event survived with NULL `meeting_id`/`mail_thread_id`, and that the widened CHECK accepts `met` while still rejecting a bogus verb. Constraint tests on the shared handle: both CHECKs, both partial uniques, the FKs.

Shared: `meetingSchema` (all columns, ISO strings for timestamps), `meetingAttendeeSchema` (discriminated by which id is set — model it as three nullable fields plus a superRefine enforcing exactly-one, mirroring how the DB CHECK reads, and comment that the refine and the CHECK are the same rule in two places), `meetingCreateInputSchema` (title, occurredAt, durationMinutes?, notes?, the four record links, attendees array) with a superRefine enforcing at-least-one-link (the CHECK's twin), `meetingUpdateInputSchema` (all optional; attendees replace the set when present), `meetingListFiltersSchema` (the record filters + `archived` tri-state, matching `threadListFiltersSchema`'s house shape), and widen `eventVerbSchema` + add `meetingId`/`mailThreadId` to `eventSchema`. `db:generate` drift-free; `conduit_test` converged by plain migrate. ~12 tests.

### Task 2: The meetings service + routes

**Files:** `packages/api/src/services/meetings.ts` (new), `packages/api/src/services/meetings.test.ts` (new), `packages/api/src/routes/meetings.ts` (new), `packages/api/src/routes/index.ts`, `packages/api/src/routes/routes.test.ts`

Read `packages/api/src/services/notes.ts` and `files.ts` first — this service copies their shape (service owns the rules, routes own the wire). `createMeeting`, `getMeeting`, `updateMeeting`, `archiveMeeting`, `unarchiveMeeting`, `listMeetings`.

- `notes` HTML sanitized with the SAME sanitize-html configuration notes.ts uses (import it, do not re-derive — if it is inline there, extract it to one place and say so in the commit).
- Attendees are replaced as a set on update when `attendees` is present, left alone when absent. One statement per side (delete-not-in + insert-missing, or delete-all + insert — measure nothing, just keep it obviously correct and comment the choice).
- `occurredAt` accepts past OR future (the spec's line: logging what happened and noting what is arranged are the same act).
- `listMeetings(db, opts)`: filters `companyId`/`dealId`/`projectId` are plain FK matches; **`contactId` matches `meetings.contact_id = C OR EXISTS an attendee row for C`** — this is the decision that makes attendance a real link, and it is the reviewer's first grep. Cursor pagination + `archived` tri-state exactly as notes/files do (reuse `pagination.ts`).
- Event emission through the existing pattern (read how notes.ts emits `note_added`): create emits `met` carrying the meeting's four record FKs AND `meetingId`; archive/unarchive emit the existing `archived`/`unarchived` verbs with `meetingId`. No content in any payload beyond what notes already puts there.
- Routes: `GET /api/meetings` (filters), `POST /api/meetings`, `GET/PATCH /api/meetings/:id`, `POST /api/meetings/:id/archive`, `POST /api/meetings/:id/unarchive`. `requireUser` on every route, as every other route file does; owner is the actor. Register in `routes/index.ts`.

Tests (~18): CRUD; both CHECKs surfacing as clean 4xx not 500s (at-least-one-link is caught by the zod refine BEFORE the DB — pin both layers); attendee set replacement (add, remove, replace-with-empty, the partial-unique rejection of a duplicate contact); the contact-attendance widening (a meeting linked to company A with contact C as attendee appears under `?contactId=C` — and does NOT appear for an unrelated contact); archived filtering; sanitization (a `<script>` in notes does not survive); event emission (a `met` event lands on every linked record with `meetingId` set); route-level authz + shape.

### Task 3: Follow-up tasks from a meeting

**Files:** `packages/api/src/services/meetings.ts`, `packages/api/src/services/meetings.test.ts`, `packages/api/src/routes/meetings.ts`, `packages/api/src/routes/routes.test.ts`, `packages/shared/src/index.ts`

`POST /api/meetings/:id/tasks` → `createMeetingTask(db, actorId, meetingId, input)`, which:
- loads the meeting (404 if absent/archived — archived meetings do not sprout new work; comment the ruling),
- calls the EXISTING `createTask` service (never a second task-creation path — the compactor, scheduling and dependency rules live there),
- copies the meeting's four record links onto the task, with any link the caller supplies taking precedence (comment: the meeting's links are defaults, not a cage),
- records `meetingId` on the task's originating event payload so the timeline entry can read "created from this meeting".

The input schema is the existing task-create input MINUS the record links (they are inherited) — derive it from the existing schema rather than restating fields, so a future task field cannot drift.

`getMeeting` gains the tasks it produced by querying `events` for rows with this `meetingId` and a task-creation verb, then loading those tasks — deliberately NOT a new column on `tasks`: the link already exists in the event payload, and a denormalised column would be a second source of truth for the same fact. Comment that reasoning where the query lives. ~8 tests: links inherited; caller override wins; archived meeting refuses; the created task obeys every existing task rule (assert one scheduling behaviour to prove `createTask` really ran); the meeting view lists its tasks.

### Task 4: Mail in the timeline (the privacy-critical task)

**Files:** `packages/api/src/services/mail-ingest.ts`, `packages/api/src/services/timeline.ts`, `packages/api/src/services/timeline.test.ts`, `packages/api/src/routes/events.ts`, `packages/web/src/queries.ts` (key only)

**Emission** (`mail-ingest.ts`): after a message is stored and its thread links resolved, emit `mail_received` (inbound) or `mail_sent` (outbound) carrying the thread's record FKs and `mailThreadId`. **The payload carries NO content** — no subject, no snippet, no addresses. Throttle: one event per `(thread, verb)` per calendar day (UTC — say so in the comment), enforced by an existence check on the same thread/verb/day before inserting. A thread with no record links emits nothing (there is no timeline for it to appear on).

**Read-time filtering** (`timeline.ts`): `listEvents` gains the viewer's id — every caller already has one (`routes/events.ts` has `requireUser`; check the task-drawer path too). For rows carrying `mailThreadId`:
- join `mail_threads` under the composed **Phase 4.2 record-visible predicate AND the Phase 4.3 not-hidden predicate** — import the existing helpers from `mail-threads.ts`, never re-derive them (4.2's `visibleThreads`/`visibleMessageTerm` and 4.3's `notHiddenByViewer`; read their headers for the un-aliased preconditions);
- a thread the viewer cannot see (or has hidden) → the event row is **excluded from the result entirely**, not rendered as a stub — an "activity you can't see" entry leaks both existence and timing;
- a visible thread → the response carries the subject rendered LIVE from `mail_threads.subject` (a new nullable `mailSubject` field on the event payload shape in shared — comment that it is derived-at-read, never stored).
- Exclusion happens BEFORE the limit, like every other predicate in this codebase, so a page is never short (the 4.3 pagination lesson — pin it with a test).

Tests (~20, the phase's core): the mail-privacy matrix — (owner | other user) x (private | shared account) x (unlinked | deal-linked) x (hidden | not hidden) against `listEvents`, asserting excluded-entirely vs. live-subject; **a payload-shape assertion that no mail event payload contains content** (assert the stored payload keys directly so a future field addition trips it); the throttle (second same-direction message same day emits nothing; next day emits; opposite direction same day emits); exclusion-before-limit; non-mail events unaffected by the new join (a regression guard for the whole existing timeline).

### Task 5: Web — the Meetings rail tab + timeline rendering

**Files:** `packages/web/src/components/rail/meetings.tsx` (new), `packages/web/src/components/rail/rail.tsx`, `packages/web/src/components/rail/timeline.tsx`, `packages/web/src/queries.ts`, `packages/web/src/components/mail/mail-lib.ts` or a new `rail/meetings-lib.ts` for pure logic

Read `packages/web/src/components/rail/notes.tsx` and `files.tsx` first — the new tab copies their structure (list + form + mutations, `useInvalidate*` patterns, testids).

- `rail.tsx`: fifth tab `Meetings`, testid `meetings-tab`, passing the same four record props the other tabs take.
- `meetings.tsx`: the list (title, when, attendee summary, follow-up-task count), a "Log a meeting" form (title, when — defaulting to now, duration, attendees, notes via the existing TipTap editor component notes.tsx uses), a meeting view showing notes/attendees/tasks with an "Add task" affordance, archive + the house "show archived" control. Testids: `meeting-form`, `meeting-row-<id>`, `meeting-add-task`, `show-archived-meetings`.
- Attendee input: contact picker + user picker + free-text guest field, reusing the existing picker components (find them — do not build a new one).
- `timeline.tsx`: add the three verbs to `VERB_BADGE` (the map is exhaustively typed against `eventVerbSchema`, so the compiler names them): `met` = M, `mail_received` = R, `mail_sent` = T. A `met` entry links to its meeting; a mail entry renders the derived `mailSubject` and links to the thread.
- Per the repo's pure-lib web-test convention (no testing-library in this project — see the 4.3 Task 3 DONE block), extract the label/summary logic into a lib module and unit-test THAT; render/interaction coverage is Task 6's e2e. ~10 tests.

### Task 6: e2e + release prep (v0.9.0)

**Files:** `e2e/meetings.spec.ts` (new), `e2e/mail.spec.ts` (if the privacy leg fits better beside the existing two-user fixtures), three `package.json`s, `manifest.toml`, server lockfile

e2e, runId + per-attempt (`${runId}x${testInfo.retry}`) fixtures per the 4.1/4.2/4.3 pattern:
- Log a meeting on a company with a contact attendee and a free-text guest → it appears on the company's Meetings tab AND on the contact's (the attendance widening, end to end) AND as a Timeline entry.
- Add a follow-up task from it → the task exists with the meeting's links inherited.
- A mail exchange on a linked record → a Timeline entry appears with the thread's subject.
- **The two-user privacy leg** (reuse the `ynh-user`-header second context from mail.spec.ts): B's timeline on the shared record shows NO entry for A's private thread — asserted against a loaded timeline (a sentinel entry B CAN see), per the 4.3 loaded-list-sentinel lesson.

Release prep: bump 0.9.0 (three package.jsons + manifest `0.9.0~ynh1`), regenerate the server lockfile, CI gate green on the pushed branch (report run id + tip sha — the run must cover the final tip), handoff artifacts in the session scratchpad: `release-notes-v0.9.0.md` (meetings, follow-up tasks, mail in the timeline, the no-backfill note so absent history is not read as a bug, the privacy rule stated plainly) and `release-sequence-v0.9.0.md` (the worktree-runnable sequence: `git push origin HEAD:main` → tag → Release workflow sha256 → manifest commit → Chris's sudo command → the spec's Rollout checklist). Do NOT merge, tag, or edit the manifest sha — the coordinator gates the release.

---

Sequencing: 1→2→3, then 4 (needs only Task 1's schema; may run once 1 lands), 5 after 2+4's contracts, 6 last. Each task: implement → adversarial spec review → quality review, the standing loop. The spec's Decisions table and the mail-privacy matrix are the completeness checklists.
