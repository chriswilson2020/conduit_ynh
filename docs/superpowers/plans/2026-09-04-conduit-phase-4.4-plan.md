# Conduit Phase 4.4 → v1.6.0 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-04-conduit-phase-4.4-mail-filing-design.md`, approved
by Chris 4 Sep. Read it first; it carries the reasoning this plan does not repeat.

**Baseline:** v1.5.0, shipped 4 Sep. Unit 3419 passed / 3 skipped, e2e 216, no `flaky` line.
The suite runs in parallel now (a database per worker); CI's test step is ~151s.

**Order is deliberate: cheapest and most-used first, riskiest last.** Task 4 is the one that can
leave data inconsistent, and it should meet a codebase that already has this phase's other three
landed and green rather than being entangled with them.

---

## Task 1: File into any folder, and unhide in bulk — LANDED

**Correction found while building it, and Tasks 2 and 4 read the same schema so it is here
rather than only in the report: `bulkThreadActionInputSchema.folder` is the SOURCE, not the
destination.** Both this plan's first bullet and the spec's section 1 describe it as the
destination the new action already had. It is not -- present means folder-scoped, naming the
VIEW the selection was made in (4.3's ruling). `file` therefore carries a second field,
`targetFolder`, required for that action and rejected on every other; reusing `folder` would
have destroyed the folder-scoped ruling. Still an action kind plus a picker, as the bullet says.

- [x] **A fourth bulk action kind with a destination.** `bulkThreadActionInputSchema` already
      carries an optional `folder`, and the move service already writes to the server and
      compensates when it refuses. This is an action kind plus a picker, **not new machinery** --
      if it turns out to need new machinery, that is a finding to report before building it.
- [x] It inherits the **50-thread cap**, for the reason the existing two have it: the request
      waits on a real mail server, and bounding size rather than duration is what stops a timeout
      producing the "claimed a move the server refused" state.
- [x] **Bulk unhide**, symmetric with `hide`. Hide is a row insert per thread; unhide is a
      delete, so it takes the 200 cap rather than the 50.
- [x] The destination picker offers the account's known folders (`mail_account_folders`),
      **including ones whose sync is off.**
- [x] **FILING INTO AN UNSYNCED FOLDER TURNS ITS SYNC ON. It does not warn, and it does not
      refuse.** Corrected 4 Sep after Chris rejected the first version of this line, which said
      to allow the move and warn that the thread would then vanish from Conduit's view. He was
      right and the reason is worth keeping: **a warning there is an admission that the design is
      wrong.** It offers the operator a choice between two bad outcomes -- lose the thread, or
      don't file it where it belongs -- and calls that informed consent.
      **Filing a thread into a folder IS the statement that the folder matters.** Acting on that
      statement is the whole job; asking the operator to restate it in a dialog is not. The
      machinery already exists (`setFolderSyncEnabled`, the same call `PATCH
      /api/mail/accounts/:id/folders` makes), so this is a call, not a mechanism.
- [x] **Say what happened, after the fact and quietly** -- "Filed into Clients, and Conduit is
      now syncing that folder" -- because enabling a sync is a real consequence and an operator
      should not discover it from a bandwidth graph. That is a notification, not a gate.
- [x] **The two-system write is answered by ORDERING, not by hoping.** The sync switch runs
      BEFORE the optimistic write and the queued MOVE. After a successful move, a failed switch
      would leave mail filed into a folder Conduit does not watch -- the vanishing thread this
      rule exists to prevent, reached by accident instead of by warning. Before it, the only
      reachable failure is the harmless one (a folder syncing that need not be, one click to
      undo in the picker), and a throw lands before anything has moved, so the request did
      nothing rather than half of something. Pinned by observation rather than argument: the
      test fake reads the folder row from inside `moveMessages`.

## Task 2: Per-message selection, and filing from inside a conversation — LANDED

**Chris added the second half on 4 Sep**, answering the question Task 1 left open. It is folded
in here rather than given its own task because it lands on the same surface -- the conversation
view -- and two agents editing that in sequence would be two chances to disagree about it.

**Risk 2 did not materialise, and the phrase it is written in overstates the surface. "Every
bulk endpoint" is a set of SIZE ONE:** `POST /api/mail/threads/bulk` is the only bulk endpoint
in the app (the spec's section 2 says "every bulk endpoint currently takes `threadIds`", which
is true of the one that exists). So the choice was never "widen them all"; it was one new
endpoint beside one old one, and the new one is strictly NARROWER.

**The second finding is the opposite of what the spec expected.** Section 2 calls per-message
selection "not small". The CONTRACT was the thread-shaped part; the MACHINERY was already
message-granular and needed nothing. Everything downstream of collection in `mail-move.ts` --
`fileTargetsOf`, `enableTargetSync`, `applyOptimisticMove`, `queueMoves`, `revertMove`,
`groupForQueue` -- operates on `Candidate` rows that are individual messages already, and is
reused unchanged. What was actually built is a second collection, a second entry point, and a
narrower schema.

- [x] **FILE A WHOLE THREAD FROM INSIDE THE CONVERSATION.** Task 1 built filing on the list only,
      because the definition of done said "from the list". Reading a thread and wanting to file
      it currently means going back to the list first, finding it again, and selecting it -- three
      steps to undo one navigation. The action already exists; this is a second entrance to it.
      **No server change at all**: the conversation's picker sends the same one-thread, no-folder
      request the Archive and Trash buttons beside it already send, and whole-thread `file` was
      already covered by a Task 1 test.
- [x] **The same rule applies: an unsynced destination has its sync switched on**, in the same
      order (before the move is queued), for the reason Task 1 records. Do not reimplement that
      decision -- call the same path. **Both new paths call `enableTargetSync`**, and the
      per-message one is pinned by observation the same way (the test fake reads the folder row
      from inside the request).
- [x] **Its own `messageIds` path, not a widening of `threadIds`.** The spec's reasoning:
      overloading one field to sometimes mean a different unit is exactly how 4.3's
      folder-scoped rule became necessary. It is narrower on four axes, each enforced by a type
      or a schema rather than by a comment: **the three MOVE kinds only** (a hide is one
      `mail_thread_hides` row per THREAD, so there is no per-message one to offer -- `MoveAction`
      is now an alias of `BulkMessageActionKind` so neither set can grow without the other
      answering); **no source `folder`** (the ids ARE the scope, and the input is `.strict()` so
      a body carrying one is rejected rather than stripped); **no `out_of_scope`** (a named
      message has no scope to fall outside of, so every skip is a NOTED one -- the narrower enum
      plus a generic on `Outcomes` make it unrepresentable, and `tsc` rejects a test that even
      compares against it); and **results keyed on `messageId`**, because two messages of one
      conversation can genuinely land differently.
- [x] **REPORT BEFORE BUILDING if this turns out to widen every bulk endpoint.** See above: it
      does not, and the reason is worth keeping -- the answer was a SMALLER surface than the
      spec imagines, exactly as the bullet allowed for.
- [x] A single message filed out of a thread leaves the thread intact. What the list then shows
      for that thread is a decision to make explicitly, not a consequence to discover.
      **The decision: the thread is untouched and is LISTED IN BOTH FOLDER VIEWS AT ONCE.** The
      `mail_threads` row is not written -- not its subject, not its links, and not
      `last_message_at`, because filing is not receiving and nothing about it may reorder the
      list. What changes is only which folder views the thread appears in, and that follows 4.1's
      existing rule unchanged: a thread is "in" a folder when any of its messages is (the folder
      EXISTS in `mail-threads.ts`). So it stays in the source view while it still has a message
      there, leaves that view when the filed message was the last one, and appears in the
      destination view alongside. **The alternatives were rejected**: moving the thread with the
      message means splitting the conversation, which destroys the reply chain threading exists
      for; a thread-level "partially filed" mark would be a new fact with no reader, since the
      folder views already say it truthfully per message. **This is not a new rule -- it is 4.3's
      folder-scoped shape, which per-message filing simply makes happen ON PURPOSE rather than
      by accident of how mail arrived.** Asserted through `listThreads` itself rather than a
      re-implementation of its filter, and end to end against Dovecot.

**One pre-existing bug found and fixed while building it.** `queueMoves` keyed its failures by
THREAD, so when two chunks of one thread both failed the second overwrote the first in the map
and the LAST refusal's text was reported -- while `Outcomes` documents, in as many words, that
the FIRST is. Keying per message (which the new path needs anyway) makes the promise true.
Nothing covered the difference; a test now does.

## Task 3: Live inbox beyond page one — LANDED

**Correction found while building it, and it changes what this task WAS. The spec's section 3
and this plan's own heading both read as "the list is not live yet". PAGE ONE WAS ALREADY LIVE,
AND IT WAS LIVE BY DOING EXACTLY WHAT RISK 3 FORBIDS.** The whole transport was already in
place: `mail-ingest.ts` publishes `["mail-threads"]` after every ingest, `routes/stream.ts` fans
it out, and `components/sse.tsx` -- which routes/stream.ts's own comment still calls "a later
task" -- invalidates the key. So page one refetched on new mail and `mergeCursorPage` swapped
the whole page for the server's newest 25: rows moving under a reader mid-list, which is Risk 3
happening rather than threatened. e2e/mail.spec.ts's `pollWithReload` says so in as many words:
"The inbox IS live over SSE, so most of these pass on the first attempt."

What was genuinely missing is what the heading says -- liveness BEYOND page one. After "load
more" the observed query is page TWO, so page one, where every new message lands, had no
observer and never refetched at all. **So this task was not "make it live". It was "make the
liveness safe, and extend it past page one", and the two halves needed opposite things: less
adoption on page one, and a second observer for everything after it.**

- [x] **`services/sse.ts` is the transport.** Not polling. Nothing was added to the transport;
      what changed is what the client DOES with a hint. Proved from the other side too: the new
      e2e waits out a window with the list stale by a whole conversation and no hint sent, and
      a `refetchInterval` on the list query turns that assertion red.
- [x] **New mail must not reorder the list under the reader.** THE DECISION, written into
      `thread-list.tsx`'s header with the alternatives it beat: **a row never moves, appears or
      vanishes without the reader asking; a row that is already on screen is kept current where
      it stands.** New mail in a conversation the reader can SEE arrives in place -- new
      snippet, new time, unread dot back on, at the position it already occupies. New mail in
      one they cannot see is counted behind a "Show 3 new conversations" control at the top of
      the list, and nothing moves until that is pressed.
      **The rejected alternatives are recorded in the same place**: inserting the rows (what the
      code did before, and Risk 3 itself); freezing the list outright (one function shorter, and
      wrong within a click -- opening a conversation marks it read, which invalidates the list,
      so a list that adopted nothing would keep the bold unread row for the conversation being
      read); refetching every accumulated page on each hint (the cursors are keyset positions in
      an ordering that has moved, so rows fall between the pages and are shown nowhere); and
      re-snapshotting on every hint (the reader's paging thrown away as well as their place).
- [x] **THE READER'S OWN WRITES ARE THE EXCEPTION**, and they have to be: trash ten
      conversations and those rows are genuinely gone. Every write on this page re-snapshots,
      including the ones made inside the conversation pane, because "the reader's own gesture"
      is a fact about the reader and not about which pane they made it in. Marking read
      deliberately does NOT -- it changes what a row says, not whether it belongs, and
      re-snapshotting there would re-order the list on every single click.
- [x] **THE IN-FLIGHT BULK ACTION, checked rather than discovered** -- Task 2's finding one pane
      wider. Two answers, and the first is the load-bearing one: liveness can no longer change
      the list's MEMBERSHIP at all, so `rows`, `selectedThreads` and `unownedSelected` cannot
      move under a request that named them, by construction rather than by timing. The second is
      ordering: the re-snapshot after a bulk action FETCHES page one and only then starts over
      from what came back, because the mutation hook has already invalidated `["mail-threads"]`
      by the time the call site's callback runs -- adopting the cache there would put the rows
      the reader just trashed straight back on screen. Both are pinned by an e2e that parks the
      bulk response and lands new mail while it is parked.
- [x] **`inbox.tsx` has already ruled that state parallel to the URL is not kept**, which is why
      scroll position is not restored across levels. **THAT RULING STANDS AND IS NOT
      OVERTURNED** -- and holding the rows still is what makes it free rather than a compromise:
      the answer here is not to restore the reader's place after moving it, it is never to move
      it. Nothing added by this task remembers an offset and nothing calls `scrollTo`.
- [x] **A second e2e file, `e2e/inbox-live.spec.ts`, stubs the arrival.** mail.spec.ts's own
      Task 3 leg is the end-to-end proof and can only run where Dovecot does; it is also a poor
      place to show a claim FAILING (every mutation costs a mailbox seed, and a request still in
      flight or an inbox with no mail at all cannot be arranged from outside). The stubbed file
      runs anywhere in a few seconds and is what the mutation testing was done against.

## Task 4: Folder management — CREATE, RENAME, DELETE. THE RISK IS HERE — LANDED

**Correction found while building it, and it is the same KIND of error the other three found:
the spec undercounts what a rename has to re-key. "A plain `text` column on `mail_messages`
(and on `mail_account_folders`, and on a third table)" counts THREE and the answer is SIX.**
The three it names are right -- `mail_folder_state` is the third. What it misses is that
`mail_accounts` holds folder NAMES in three columns of its own -- `sent_folder`,
`trash_folder`, `archive_folder` -- and they break exactly as completely and rather less
visibly: rename Archive on the server without rewriting `archive_folder` and every bulk
Archive on that account fails at the server, against a mailbox nobody can see is gone. The
re-key is all six, in one transaction.

**Second correction, and it changes what a rename IS: an IMAP RENAME is a SUBTREE rename.**
RFC 3501 6.3.5 requires inferior names to move with their parent, and Dovecot 2.3 does exactly
that -- renaming `Parent` moved `Parent/Child` in the same command (observed, and pinned by an
integration test). Neither the spec nor this plan says so, and a re-key of the exact name alone
would leave every child's stored mail pointing at a mailbox that no longer exists -- this
task's own bug, one level down. So the re-key is a PREFIX rewrite using the server's own
DELIMITER, which nothing stores and which a rename therefore LISTs for.

- [x] Create and delete are ordinary. **Rename is a two-system write.**
- [x] **`folder` is a byte-compared key** -- see the correction above for the real count.
- [x] **IMAP rename first, then the local re-key in ONE transaction; on a failed re-key, rename
      back.** Chris's shape, kept -- and sharpened by moving every PREDICTABLE local failure in
      FRONT of the server call, which is what shrinks the compensated window to the
      unpredictable ones. The load-bearing one is the destination collision: a
      `mail_account_folders` row at the new name is a UNIQUE (account_id, folder) violation
      waiting to happen and the ONE re-key failure this code can foresee, so refusing it before
      the RENAME turns the most likely compensation into an unreachable state.
- [x] **A BETTER ORDERING WAS LOOKED FOR, FOUND, AND REJECTED -- with a reason worth keeping.**
      The Task 1-shaped improvement is to hold ONE transaction open across the IMAP call and
      COMMIT only if the server agreed, which makes a failed re-key UNREACHABLE rather than
      compensated. **It deadlocks.** The IMAP call is queued on the account's serial sync loop
      and waits for that loop to reach it -- a whole first backfill, in the worst case -- while
      the open transaction holds row locks on every `mail_messages` row of the folder being
      renamed. If the pass the loop is running is ingesting into that folder, the pass blocks on
      those locks, the loop never reaches the queued RENAME, and the transaction never commits.
      Not contrived: it is renaming a busy folder while its own folder is syncing.
- [x] **THE ROW IS RE-KEYED IN PLACE, which is the fix for the first thing the earlier tasks
      left.** The rename hazard mail-folders' own header describes -- a new row at a fresh
      default beside a stale old one, and a user's sync toggle silently undone -- is what
      LIST-only rename DETECTION can do. A rename made THROUGH Conduit knows it is a rename, so
      the row keeps its id, its `sync_enabled` and its `created_at`, and **no stale row is left
      for the filing picker to go on offering.**
- [x] **`imap_uid` is deliberately NOT nulled.** A move nulls it because the message changed
      mailbox; a rename changes the mailbox's NAME and moves no message, and Dovecot carries
      UIDVALIDITY and the UIDs across untouched (observed, pinned). Nulling them would force a
      full re-walk AND make every message in the folder look like the awaiting-reconciliation
      state that excludes it from every move.
- [x] **Postgres measures its own parameters.** The prefix rewrite asks for
      `char_length(<the parameter>)` rather than being handed a JavaScript length:
      `String.length` counts UTF-16 code units and Postgres counts characters, so the two
      disagree on any name with a character outside the BMP -- ordinary here, since names arrive
      already decoded out of modified UTF-7. `left(...) = prefix` rather than `LIKE`, so a name
      containing `%` or `_` needs no escaping rule to get right.
- [x] **Delete did not become this product's first expunge, and it took a REFUSAL to stop it.**
      DOVECOT DESTROYS A NON-EMPTY MAILBOX WITHOUT COMPLAINT (observed: a folder holding one
      message was deleted and the message was gone). There is no server-side refusal to lean on,
      so Conduit's own is the only thing between a click and destroyed mail: **a folder the
      server says still holds any is refused**, with the count and with the way out -- file the
      mail elsewhere, which is this phase's own Task 1, then delete. The count comes from the
      SERVER, never from `mail_messages`: Conduit holds only what it has synced, so counting
      rows would leave exactly the unsynced folders a user is most likely to tidy up deletable
      while full.
- [x] **`mail_account_folders` rows are still never deleted.** A deleted folder's row survives
      with `sync_enabled = false` -- it is what gives the kept messages a folder to be listed
      under -- and goes stale by the ordinary mechanism, which is why the route asks for a pass
      afterwards. **The UI says all of this BEFORE it happens**: what leaves, what stays ("every
      message Conduit has already stored from it is KEPT -- still searchable, still on the
      records its conversations are linked to"), and that a folder still holding mail is refused
      rather than emptied. No count in that sentence, deliberately: Conduit's own number would
      understate an unsynced folder by however much it has never seen, and the server's real one
      arrives in the refusal.
- [x] **A folder with mail and a folder with children are two separate refusals, and the second
      is not about mail at all.** Deleting a parent with a child destroyed the parent's own mail
      and LEFT THE PARENT IN LIST -- carrying `\HasChildren` and NEITHER `\Noselect` NOR
      `\NonExistent` -- while STATUS answered false and APPEND answered "Mailbox doesn't exist"
      (all observed together). Discovery would go on recording that as a live selectable folder,
      the walk would open it, and the pass would fail. Every pass. That is a permanently
      backed-off account, which is why children are refused rather than attempted.
- [x] **The second thing the earlier tasks left is fixed too**: the filing picker now drops
      folders the last discovery pass did not re-sight -- the staleness rule the sidebar and the
      settings picker have both used since 4.1. Filing into a vanished folder used to fail at
      IMAP, late, after an optimistic write and a compensating revert, in the mail server's
      words rather than the app's.

**43 mutations, 43 killed -- but only after two survived and one of those was a real bug.** The
server-side destination check counted the SOURCE'S OWN CHILDREN as folders in the destination's
way, so promoting a child onto its parent's name was refused because of the very rows it was
about to rewrite; the stored-row check already excluded them and the server check did not. The
other survivor was a claim with no test behind it (`left(...)` rather than `LIKE`), now pinned
by a folder named `A_B` beside a sibling `AxB`. The two adapter guards were mutated against a
real Dovecot rather than a fake, and each is killed by its own integration case.

---

## Definition of done

- Threads file into any folder from the list in one gesture; unhide works in bulk.
- A single message can be filed independently of its thread.
- New mail appears without a reload and without moving the reader's place.
- Folders create, rename and delete, with rename provably atomic across IMAP and the database.
- Full unit and e2e green, counts accounted for.

---

## Explicitly NOT in this phase

- **Phase 8** (M365 via Graph, Gmail XOAUTH2). Still trigger-based.
- **"Emailing a quote"**, which the backlog notes overlaps this phase. It is a document concern
  wearing a mail costume and it does not become cheaper by being done here.
- **The dnd-kit keyboard-drag intermittent** (1 in 33). Waiting for its next sighting, which now
  carries a Playwright trace because v1.4.1 changed the artifact upload to `always()`.
