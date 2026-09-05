# Conduit Phase 4.4 — mail filing power tools

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.6.0.
**Predecessor:** v1.5.0, shipped 4 Sep.
**Scope set by Chris, 4 Sep:** all four items. He was offered the chance to cut and took none.

---

## What already exists, so this spec is about the gap and not the feature

Phase 4.3 built more than the backlog's one-line entry suggests, and reading it first is what
keeps this phase from rebuilding it:

- **Thread multi-select with bulk `trash` / `archive` / `hide`**, capped at 50 for the two that
  wait on a mail server and 200 for `hide`, which is a local row insert.
- **Folder-scoped selection semantics** -- when a selection is made in a folder view, the move
  acts only on each thread's messages *in that folder*.
- **A move service with compensation**, because a move that the mail server refuses must not
  leave Conduit claiming it happened.
- **Per-folder sync on/off** (`PATCH /api/mail/accounts/:id/folders`).

**The four gaps are the phase.**

---

## 1. Move to an arbitrary folder

Today's three bulk actions have fixed destinations. Filing mail is mostly *not* trash or archive
-- it is "put this in Clients" -- and there is no way to do it.

The mechanism already exists: `bulkThreadActionInputSchema` carries an optional `folder` and the
move service already writes to the server and compensates on refusal. **This is a fourth action
kind and a destination picker, not new machinery.** It inherits the 50-thread cap for the same
reason the other two have it.

> **Correction, 4 Sep, from building it.** The paragraph above is wrong about one thing, and it
> matters for Tasks 2 and 4, which read the same schema. **`folder` is the SOURCE, not the
> destination** -- its own comment says so: present means folder-scoped, and it names the VIEW
> the selection was made in (4.3's selection-granularity ruling). Filing out of the INBOX view
> into Clients has to say both which folder the selection was made in and which folder the mail
> is going to, so `file` needed a second field, `targetFolder`, required for that action and
> rejected on every other. Reusing `folder` as the destination would have destroyed the
> folder-scoped ruling this phase is built on top of. The rest of the paragraph holds: it is
> still an action kind plus a picker, and the move service resolves the named destination per
> account exactly where it used to read a column.

---

## 2. Bulk unhide, and per-message selection

**Unhide is the missing inverse and it is small.** `hide` is a row insert per thread; unhide is
a delete. It exists singly and not in bulk, so fifty threads hide in one gesture and unhide in
fifty.

**Per-message selection is not small, and it is the one item here that changes a ruling rather
than extending one.** Selection today is per THREAD; Phase 4.3's folder-scoped semantics exist
precisely because a thread's messages can be spread across folders. Selecting a single message
out of a conversation and filing it elsewhere is a different unit of work, and every bulk
endpoint currently takes `threadIds`.

**This spec treats it as its own surface rather than a widening of the thread one.** A parallel
`messageIds` path is honest; overloading `threadIds` to sometimes mean messages is how the
folder-scoped rule became necessary in the first place.

> **Correction, 4 Sep, from building it.** Two things above are wrong, and both make this item
> sound bigger than it is.
>
> **"Every bulk endpoint currently takes `threadIds`" is a claim about ONE endpoint.**
> `POST /api/mail/threads/bulk` is the only bulk endpoint in the app. Risk 2 below asks for a
> report if per-message selection "widens every bulk endpoint"; it cannot, because there is
> nothing to widen but the one, and the answer built instead is a second endpoint that is
> strictly NARROWER than it -- the three MOVE kinds only (a hide is a row per THREAD, so there
> is no per-message one), no source `folder` (a message id IS the scope), no `out_of_scope` (a
> named message has no scope to fall outside of), and results keyed on `messageId` because two
> messages of one conversation can land differently.
>
> **"Not small" is right about the CONTRACT and wrong about the MACHINERY.** Everything
> downstream of collection in `mail-move.ts` already operates on individual messages
> (`Candidate` rows), so the destination resolution, the sync switch, the optimistic write, the
> queued MOVE and the compensating revert were all reused unchanged. What per-message selection
> actually needed was a second collection, a second entry point and a narrower schema -- not new
> move machinery.

---

## 3. Live inbox beyond page one

The list asks for 25 and accumulates. What "live" must mean is decided here rather than left to
implementation:

- **New mail arriving while the reader is deep in a list must not reorder under them.** The list
  is ordered by `last_message_at`; a new message in an old thread moves it. Surfacing that as a
  silent jump loses the reader's place.
- **The existing SSE service (`services/sse.ts`) is the transport**, not polling.
- **Scroll position is the reader's**, and this codebase has already ruled once (in `inbox.tsx`)
  that state parallel to the URL is not kept. That ruling stands unless this phase overturns it
  deliberately.

> **Correction, 4 Sep, from building it.** The opening sentence is wrong, and the way it is
> wrong matters: **the list WAS live, on page one, and it was live by doing exactly what the
> first bullet forbids.** `mail-ingest.ts` has published `["mail-threads"]` after every ingest
> since Phase 4, `routes/stream.ts` fans it out and `components/sse.tsx` invalidates the key --
> so page one refetched on new mail and the accumulator swapped the whole page for the server's
> newest 25. Ordering is by `last_message_at`, so that is not an insertion, it is a re-order:
> a reply to an old conversation moves a row from the middle of the list to the top and shifts
> every row it passes. Risk 3 was not a risk to avoid, it was the shipped behaviour.
>
> What was genuinely missing is what the heading says: liveness BEYOND page one. After "load
> more" the observed query is page TWO, so page one -- where every new message lands -- had no
> observer and never refetched at all.
>
> So the two halves of the task needed OPPOSITE things, which is the part the section could not
> have anticipated: **less** adoption on page one, and a **second observer** for everything
> after it. The rest of the section holds: SSE is the transport (nothing was added to it), and
> the `inbox.tsx` ruling stands unchanged -- holding the rows still means there is never a
> scroll position to restore.

---

## 4. Folder management — AND THIS IS THE PHASE'S REAL RISK

Create, rename, delete. Two of the three are ordinary; **rename is a distributed write and must
be specified as one.**

**Read out of `schema.ts` rather than assumed:** `folder` is a plain `text` column on
`mail_messages` (and on `mail_account_folders`, and on a third table), and it is part of the
`mail_messages(account_id, folder, imap_uid)` index. **A folder name is a byte-compared key**
-- `folderNameSchema`'s own comment says an IMAP mailbox name "is compared byte for byte
everywhere it is used downstream", which is why it trims and rejects blanks rather than
defaulting.

So renaming a folder on the IMAP server **leaves every stored message pointing at a name that no
longer exists.** The rename and the re-key must both happen or neither must.

**Recommendation, and it is Chris's to overturn at review: support rename, with the move
service's discipline rather than a new one.** Do the IMAP rename first, then the local re-key in
one transaction; on a failed re-key, rename back. The alternative -- offering create and delete
but not rename -- is defensible and cheaper, but a folder tool that cannot rename is one people
work around by making a new folder and moving everything, which is strictly worse for the same
data.

**Delete has an existing convention that must be honoured**: `mail_account_folders` rows are
*never* deleted -- "a folder that vanishes from a later LIST keeps its row". Deleting a folder
in Conduit must therefore not delete that row either, and **must state what happens to messages
stored from it.** Deleting mail is not something this product does elsewhere: the CRM archives
rather than expunges, and that principle should not be quietly broken by a folder tool.

> **Correction, 4 Sep, from building it.** Four things. The first two change what a rename HAS
> to do rather than how it should do it.
>
> **"A plain `text` column on `mail_messages` (and on `mail_account_folders`, and on a third
> table)" counts THREE and the answer is SIX.** The three are right -- `mail_folder_state` is
> the third -- but `mail_accounts` holds folder NAMES in three columns of its own:
> `sent_folder`, `trash_folder` and `archive_folder`. They break exactly as completely and
> rather less visibly: rename Archive on the server without rewriting `archive_folder`, and
> every bulk Archive on that account fails at the server against a mailbox nobody can see is
> gone. The re-key is all six, in one transaction.
>
> **AN IMAP RENAME IS A SUBTREE RENAME, which this section does not say.** RFC 3501 6.3.5
> requires inferior hierarchical names to move with their parent, and Dovecot 2.3 does exactly
> that (renaming "Parent" moved "Parent/Child" in the same command -- observed, and pinned by an
> integration test). So the re-key is a PREFIX rewrite, not an exact-name one: a re-key of the
> exact name alone leaves every child's stored mail pointing at a mailbox that no longer exists,
> which is this section's own hazard one level down. It needs the server's hierarchy DELIMITER,
> which no table stores and which varies per server, so a rename LISTs for it.
>
> **The recommended ordering is kept, and sharpened: every PREDICTABLE local failure moves in
> FRONT of the server call.** The load-bearing one is a `mail_account_folders` row at the
> destination name -- a UNIQUE (account_id, folder) violation waiting to happen, and the one
> re-key failure this code can foresee -- so refusing it before the RENAME turns the most likely
> compensation into an unreachable state. The obviously better ordering was looked for and
> REJECTED, with a reason worth recording: holding ONE transaction open across the IMAP call and
> committing only if the server agreed would make a failed re-key unreachable rather than
> compensated, and it DEADLOCKS -- the IMAP call queues on the account's serial sync loop while
> the open transaction holds row locks that loop's own pass needs.
>
> **Delete needed a REFUSAL, not only a sentence.** "Must state what happens to messages" is
> necessary and not sufficient: DOVECOT DESTROYS A NON-EMPTY MAILBOX WITHOUT COMPLAINT
> (observed, and pinned), so there is no server-side refusal to lean on and Conduit's own is the
> only thing between a click and destroyed mail. A folder the server says still holds any is
> refused -- with the count, and pointing at this phase's own filing action as the way out. A
> folder with CHILDREN is refused too, and that one is not about mail at all: the placeholder
> Dovecot leaves behind stays in LIST looking selectable while SELECT fails, which would fail
> every sync pass for ever.

---

## Definition of done

- A thread or threads can be filed into any folder the account has, from the list, in one gesture.
- Unhide works in bulk, symmetrically with hide.
- A single message can be selected and filed independently of its thread.
- New mail appears without a reload and without moving the reader's place.
- Folders can be created, renamed and deleted, with rename provably atomic across IMAP and the
  database, and delete's effect on stored messages stated in the UI before it happens.
- Full unit and e2e green.

---

## Risks

1. **Rename is the schedule risk.** It is a two-system write with a byte-compared key on both
   sides, and it is the one item here that can leave data inconsistent rather than merely
   failing.
2. **Per-message selection changes a ruling** rather than extending one. If it turns out to
   widen every bulk endpoint, that is a finding to report before building it.
3. **"Live" can quietly become "reorders under the reader"**, which is worse than not being live.
4. **Delete must not become the product's first expunge.**
