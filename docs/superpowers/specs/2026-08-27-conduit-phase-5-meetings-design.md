# Conduit Phase 5 — Meetings & the record timeline

## Context

Chris asked for meeting logging with the ability to "add tasks and things from it too".
Exploring first changed the shape of the phase: the timeline already exists. `events`
(Phase 2) is an activity log — verbs `created`/`note_added`/`stage_changed`/`won`/... ,
an actor, up to five record FKs, a jsonb payload, cursor-paginated by `listEvents` — and
every detail page already carries a right rail with **Timeline / Notes / Files / Mail**
tabs. Phase 5 therefore adds meetings as a first-class record that FEEDS the existing
timeline, exactly as notes and files already do (`note_added`, `file_attached`), and
finally folds mail into that timeline — the Phase 4 deferred item, cheap now that the
pattern is proven.

Decisions taken with Chris in the 5 brainstorm:

| Decision | Choice |
|---|---|
| Attendees | **Contacts + Conduit users + free-text guests.** An attendee is a linked CRM contact, a Conduit user, or a plain name for someone not in the CRM ("and their lawyer"). Contact attendance is a real link: the meeting appears on that contact's record. |
| Placement | **Rail tab + timeline entries.** A Meetings tab beside Notes/Files/Mail on company, contact, deal and project pages; each meeting also appears in that record's Timeline. No top-level Meetings page in v0.9.0. |
| Follow-ups | **Tasks created from inside the meeting, inheriting its links.** An action item becomes a real task linked back to the meeting and carrying the meeting's company/contact/deal/project links, so it lands in the right place without re-picking. |
| Mail in the timeline | **Yes.** Mail threads emit timeline entries, so a record's Timeline is the single story: mail, meetings, notes, files, stage changes. The Mail tab stays for reading. |
| Mail privacy (coordinator, from the placement decision) | **Timeline entries are POINTERS, never content.** A mail event stores no subject, snippet, or address; the subject is rendered at read time through Phase 4.2's visibility predicate and 4.3's hide predicate. A thread you cannot see produces no timeline entry for you. Phase 4.2's model is not weakened by this phase. |
| Reachability (coordinator, from the placement decision) | **Every meeting carries at least one record link.** With no top-level list, an unlinked meeting would be unreachable the moment it is saved. Enforced by a CHECK, surfaced in the UI as a required field. |

## Data model (migration 0008, additive)

- **`meetings`**: `id`, `title` text NOT NULL, `occurred_at` timestamptz NOT NULL,
  `duration_minutes` integer NULL (unknown is honest; not every logged meeting has one),
  `notes` text NULL (TipTap HTML, sanitized on write like notes.body),
  `owner_user_id` FK users NOT NULL, the four record FKs
  `company_id`/`contact_id`/`deal_id`/`project_id` (nullable, several may be set at once —
  the `events` model, NOT notes' exactly-one CHECK: a meeting about a deal legitimately
  carries its company too), `archived_at` (archive-not-delete, as everywhere),
  `created_at`/`updated_at`.
  - CHECK `meetings_has_link`: at least one of the four record FKs is non-null — the
    reachability decision above.
- **`meeting_attendees`**: `meeting_id` FK meetings, `contact_id` FK contacts NULL,
  `user_id` FK users NULL, `guest_name` text NULL, `id` PK.
  - CHECK `meeting_attendees_exactly_one`: exactly one of the three is non-null (notes'
    exactly-one pattern).
  - Partial unique indexes so the same contact/user cannot be added twice to one meeting;
    guests are free-text and not deduped.
- **`events`**: gains `meeting_id` FK meetings NULL and `mail_thread_id` FK mail_threads
  NULL (the pointer, per the privacy decision), and the verb CHECK gains `met`,
  `mail_sent`, `mail_received`. No other table changes; existing rows untouched.
- Backfill: **none**. Historical mail predates the feature; the timeline starts telling the
  mail story from upgrade forward. Stated in the release notes so absent history is not
  read as a bug. (Backfilling would mean synthesising events for every stored message —
  large, slow, and it would bury real activity under an import spike.)

## Meetings service

`packages/api/src/services/meetings.ts`, following notes.ts/files.ts shape:
create/update/archive/unarchive/list/get, attendees replaced as a set on update
(simplest correct semantics; the UI edits the whole list), `notes` HTML sanitized with the
existing sanitize-html configuration, `occurred_at` free (past OR future — logging a
meeting you have just had and noting one you have arranged are the same act; the UI
defaults to now).

- `listMeetings(db, {companyId|contactId|dealId|projectId, archived, cursor, limit})` —
  the rail's filter shape, matching notes/files exactly.
- **Contact attendance widens the contact filter**: a contact's Meetings tab lists
  meetings where the contact is the linked `contact_id` **OR** an attendee. This is what
  makes "attendees are real links" true. The other three filters are plain FK matches.
- Creating a meeting emits `met`; archiving emits `archived` (existing verb). The event
  carries the meeting's record FKs so it lands on every linked record's timeline, plus
  `meeting_id` so the entry links back.

## Follow-up tasks

`POST /api/meetings/:id/tasks` creates a task through the existing `createTask` service —
never a second task-creation path — with the meeting's four record links copied onto the
task, plus the meeting's own id recorded on the task's originating event payload so the
timeline entry reads "task created from this meeting". Tasks keep every existing rule
(scheduling, dependencies, the compactor). The meeting detail view lists the tasks it
produced.

- Deliberately NOT in this phase: editing those tasks from inside the meeting (the task
  drawer already exists and is one click away), and follow-up meetings from meetings
  (offered in the brainstorm, not taken).

## Mail in the timeline

- `ingestMessage` emits `mail_received` for an inbound message and `mail_sent` for an
  outbound one, carrying the thread's record FKs and `mail_thread_id`. **Payload holds no
  content** — no subject, no snippet, no addresses.
- `listEvents` gains the viewer's id (every caller already has it) and, for rows with
  `mail_thread_id`, joins the thread under the composed Phase 4.2 record-visible predicate
  AND the Phase 4.3 hide predicate:
  - a thread the viewer cannot see → the event row is **excluded entirely** (not rendered
    as a redacted stub: an "activity you can't see" entry would leak the fact and the
    timing of someone's private mail);
  - a visible thread → subject rendered live from `mail_threads.subject`, and the entry
    links to the thread.
- One event per message would flood a long thread. **One event per thread per direction
  per day**: the first inbound message of a thread on a given day emits `mail_received`;
  subsequent inbound messages that day do not. Cheap to enforce (an existence check on the
  same thread/verb/day), and it keeps the timeline readable — the Mail tab remains the
  place to read every message.
- Volume note: `listEvents`' page size is unchanged; a busy record's timeline now carries
  mail entries it did not before, which is the point.

## Web

- **Meetings rail tab** (fifth tab): list of meetings for the record (title, when,
  attendee summary, task count), a "Log a meeting" form (title, when, duration, attendees,
  notes), and a meeting view with its notes, attendees, follow-up tasks, and an
  "Add task" affordance. Archive available; archived hidden behind the house
  "show archived" control.
- **Timeline** renders the three new verbs with the existing single-letter badge idiom
  (no icon library in this project): `met` = M, `mail_received` = R, `mail_sent` = T.
  A meeting entry links to its meeting; a mail entry links to its thread.
- Attendee input: contact/user pickers plus a free-text guest field; the existing
  entity-picker patterns, no new component library.

## Out of scope (deferred, not rejected)

Top-level Meetings page and "my meetings this week"; calendar integration of any kind
(ICS export, invites, availability — logging only in v0.9.0); recurring meetings;
meeting templates/agendas; transcription or recording; follow-up meetings from meetings;
per-attendee response tracking; backfilling mail history into the timeline.

## Testing

- Unit: the meetings service (CRUD, attendee set replacement, the exactly-one and
  at-least-one CHECKs, contact-attendance widening the contact filter, archive semantics,
  HTML sanitization); follow-up task creation (links inherited, existing task rules
  intact); the migration drill via `withPreMigrationDatabase("0008")`.
- **The mail-privacy matrix is the phase's own core test**, reusing 4.2/4.3's fixtures:
  (owner | other user) x (private | shared account) x (unlinked | deal-linked) x
  (hidden | not hidden) against `listEvents` — an invisible or hidden thread contributes
  NO row, a visible one renders its live subject. Plus: no mail event payload ever
  contains content (assert the payload shape directly, so a future field addition trips
  the test).
- The per-thread-per-direction-per-day rule (second message same day emits nothing; next
  day emits again; opposite direction same day emits).
- e2e: log a meeting with a contact attendee and a guest → it appears on the contact's
  Meetings tab and Timeline; add a follow-up task from it → the task exists with inherited
  links; a mail exchange appears on the record's Timeline; the two-user privacy leg — B
  sees no timeline entry for A's private thread (the harness's second user, as 4.2/4.3).
- Suite baseline at start: 1586 unit + 36 integration + 57 e2e, green.

## Rollout

v0.9.0, standard mechanics, branch `worktree-phase-5-meetings` from the v0.8.0 manifest
commit (99edcf4). Live verification: log a meeting on a company with a contact attendee
and a guest; it appears on both records' Meetings tabs and Timelines; add a follow-up
task and find it on the record with the meeting's links; recent mail appears on a
record's Timeline; the second user sees no entry for a private thread.
