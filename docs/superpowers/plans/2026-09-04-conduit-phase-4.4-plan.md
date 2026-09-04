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

## Task 3: Live inbox beyond page one

- [ ] **`services/sse.ts` is the transport.** Not polling.
- [ ] **New mail must not reorder the list under the reader.** Ordering is by `last_message_at`,
      so a new message in an old thread moves it. Decide and write down what the reader sees --
      an inserted row, a "3 new" affordance, or nothing until they ask.
- [ ] **`inbox.tsx` has already ruled that state parallel to the URL is not kept**, which is why
      scroll position is not restored across levels. That ruling stands unless this task
      overturns it deliberately and says so.

## Task 4: Folder management — CREATE, RENAME, DELETE. THE RISK IS HERE

- [ ] Create and delete are ordinary. **Rename is a two-system write.**
- [ ] **`folder` is a byte-compared key**: a plain `text` column on `mail_messages`, part of the
      `mail_messages(account_id, folder, imap_uid)` index, and `folderNameSchema`'s comment says
      an IMAP mailbox name "is compared byte for byte everywhere it is used downstream". Renaming
      on the server leaves every stored message pointing at a name that no longer exists.
- [ ] **IMAP rename first, then the local re-key in ONE transaction; on a failed re-key, rename
      back.** The move service's discipline, not a new one. Chris approved this shape on 4 Sep.
- [ ] **Delete must not become this product's first expunge.** The CRM archives rather than
      expunges everywhere, and `mail_account_folders` rows are *never* deleted by existing
      convention -- "a folder that vanishes from a later LIST keeps its row". **State in the UI,
      before it happens, what becomes of the mail stored from that folder.**
- [ ] A folder with mail in it, and a folder with children, are two separate refusals or two
      separate warnings. IMAP servers differ on both; find out what this one does rather than
      assuming.

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
