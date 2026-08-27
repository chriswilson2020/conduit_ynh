# Conduit roadmap — the backlog in phases (post-v0.8.0)

Drafted 21 Aug 2026, after v0.8.0 shipped. Shipped so far: CRM core, pipelines/deals,
projects/tasks/Gantt, email (sync, folders, bulk actions, privacy, per-user hide).
Each phase below gets its own brainstorm -> spec -> plan -> reviewed-task loop when it
starts; the "open decisions" lines are what that brainstorm settles. Order is the
coordinator's recommendation — Chris reorders at will.

---

## Phase 5 — Meetings & the record timeline → v0.9.0  *(recommended next)*

The meeting-logging request, plus the long-deferred "merge mail into the events
timeline" — they are one feature seen from two sides: things that happened on a record.

- **Meeting entity**: date/time, duration, attendees, linked company/contact/deal/
  project, rich-text notes (TipTap, as notes today), owner.
- **Follow-ups from inside the meeting**: create tasks (and notes) in-context; created
  items link back to the meeting and inherit its record links — the "add tasks and
  things from it" ask, done where the momentum is.
- **Record timeline**: a unified chronological activity strip on company/contact/deal/
  project detail — meetings, notes, and (if scope allows, else the immediate follow-up)
  linked mail threads as timeline entries.
- Open decisions: attendee model (linked contacts, free-text guests, or both);
  logging-only vs. calendar artifacts (ICS export/invites — recommend logging-only
  first); which event types the timeline shows in v1.
- Size: ~4–5 tasks. Classic phase shape: new entity + service + UI + timeline + e2e.

## Phase 6 — Responsive / mobile UI → v0.10.0

Comfortable on a laptop AND a phone. One deliberate pass, not per-page patching.

- Foundation: breakpoint conventions, a mobile navigation shell, touch targets.
- The mostly-mechanical sweep: list/detail pages, settings, forms, search.
- The three hard surfaces, each its own decision: the mail inbox's three panes
  (drill-in stack on narrow screens), the deals kanban (touch drag vs. per-stage list
  view on phone), the Gantt (recommend view-only pan/zoom on phone, list fallback).
- Open decisions: which surfaces are phone-first-class vs. laptop-graceful; kanban
  touch strategy; Gantt phone strategy.
- Size: ~5–6 tasks. Sequencing note: running this AFTER Meetings means the meetings UI
  gets swept along with everything else; running it FIRST means new features build
  responsive-native. Recommendation stands on value-sooner, but if phone use is the
  daily pain, flip Phases 5 and 6 — both orders are safe.

## Phase 7 — Documents (WeasyPrint) → v1.0.0

The original "Phase 5", unchanged in content: generate branded PDFs from CRM data —
quotes/proposals/invoices off deals and companies, stored in Files, served from the
record. Open decisions: document types first cut; template authoring UX; numbering
sequences. Feels like the v1.0 milestone.

## Phase 8 — Modern mail auth (Graph API + XOAUTH2) — trigger-based

M365 mail via Microsoft Graph (its own mini-phase, per the 19 Aug ruling for the
Listerdale tenant); Gmail XOAUTH2 behind it. Scheduled when the M365 need is real
rather than by order — it can jump the queue the day Chris wants that tenant synced.

## Phase 4.4 — Mail filing power tools *(flexible slot, smaller release)*

Per-message selection within a thread; moves to arbitrary folders; folder management
from Settings; bulk Unhide in the Hidden view; compose-attachments without a record
link; live inbox accumulation beyond page one. A tighter release that fits between big
phases — or a good budget-constrained week's work.

---

## Riders (attach to whichever phase is convenient — not phases themselves)

YunoHost `test_upgrade_from`/package_check wiring; the esbuild/drizzle-kit audit item
(breaking-change major bump, needs its own verification); actor-scoped SSE hints;
`useThreadDetail` extraction; the shared 50MB constant; project-detail
archived-pipelines parity with company detail; forwardBody inline-URL cleanup.

## Deferred indefinitely (unchanged)

Team mailboxes; scheduling/snooze; subject-fallback threading (revisit on evidence);
per-thread manual share/unshare; per-user audit trail.
