import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type {
  BulkMessageActionKind, BulkThreadActionKind, MailAttachment, MailMessageWithAttachments,
} from "@conduit/shared";
import { apiUrl } from "../../api";
import { humanSize, relativeTime } from "../../lib";
import {
  useBulkMessageAction,
  useBulkThreadAction,
  useHideThread,
  useMailAccounts,
  useMailFolders,
  useMailThread,
  useMarkThreadRead,
  useUnhideThread,
} from "../../queries";
import { Composer, type ComposerSeed } from "./composer";
import { useDialogReturnFocus } from "../ui/dialog-focus";
import { LinkPanel } from "./link-panel";
import { MessageFrame } from "./message-frame";
import {
  addressLabel,
  bulkErrorMessage,
  bulkPendingLabel,
  composeErrorMessage,
  emptyMessageSelection,
  fileTargetsBlocked,
  forwardBody,
  forwardSubject,
  isThreadGone,
  messageActionBlocked,
  messageIsInTrash,
  replyRecipients,
  replySource,
  replySubject,
  selectedMessageIds,
  selectionLabel,
  showEarlierLabel,
  singleOwnAccount,
  subjectLabel,
  summarizeBulkResult,
  toggleMessageSelected,
  THREAD_GONE_MESSAGE,
  type BulkActionSummary,
  type ComposerLinks,
} from "./mail-lib";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export interface ConversationProps {
  threadId: string;
}

/**
 * One account's filable folder names, or none when there is no single account
 * to name them from.
 *
 * A HOOK because the conversation asks it twice -- once of the whole thread for
 * the header picker, once of the ticked messages for the message bar -- and
 * useMailFolders is keyed per account, so the two calls share a cache entry
 * whenever they land on the same mailbox and cost nothing extra. Passing "" is
 * the "no single account" case and the query is disabled for it.
 */
function useFileTargets(accountId: string): string[] {
  const { data } = useMailFolders(accountId);
  return useMemo(
    () => (data ?? []).filter((row) => row.selectable).map((row) => row.folder),
    [data],
  );
}

/**
 * One thread: header, link panel, its messages oldest-first, and the
 * reply/reply-all/forward buttons that seed the composer from it.
 *
 * Mount this with `key={threadId}` (the inbox does): every piece of local
 * state here -- which messages are expanded, whether remote images were
 * allowed, an open composer -- is about ONE conversation, and a remount is a
 * clearer reset than an effect per piece of state.
 */
export function Conversation({ threadId }: ConversationProps) {
  // The capped page and, once Show-earlier asks, the uncapped view (Phase
  // 4.3 detail cap). Two cache entries under one ["mail-thread", id]
  // prefix, so every existing invalidation reaches whichever is showing.
  // The capped query stays mounted while the full one loads -- the
  // conversation keeps rendering the newest 50 (a disabled query keeps its
  // cached data) instead of blanking to a spinner -- and once the full
  // payload lands it wins below. Exactly one of the pair is enabled at a
  // time: once showAll flips, refetching a capped payload nobody renders
  // any more would be pure waste. showAll resets per conversation via the
  // key={threadId} remount (the inbox is this component's only mount site).
  const [showAll, setShowAll] = useState(false);
  const capped = useMailThread(threadId, { enabled: !showAll });
  const full = useMailThread(threadId, { all: true, enabled: showAll });
  const data = showAll && full.data !== undefined ? full.data : capped.data;
  const { isLoading, error } = capped;
  const markRead = useMarkThreadRead();
  const hide = useHideThread();
  const unhide = useUnhideThread();
  const { data: accounts } = useMailAccounts();
  const move = useBulkThreadAction();
  const moveMessages = useBulkMessageAction();
  const [moveSummary, setMoveSummary] = useState<BulkActionSummary | null>(null);
  const [moveFailure, setMoveFailure] = useState<string | null>(null);

  /**
   * Which messages are ticked (Phase 4.4 Task 2).
   *
   * Lives here rather than in the bar below for the reason the inbox holds the
   * list's: a completed action's first act is to DROP the selection, which
   * unmounts the bar, and an outcome held there would be destroyed by the same
   * batched render that produced it. The summary already lives in this
   * component, so the selection joins it.
   *
   * Reset per conversation by the key={threadId} remount, like every other
   * piece of state here -- a selection of message ids is about ONE thread.
   */
  const [selection, setSelection] = useState(emptyMessageSelection);

  // null = "the user has not touched the accordion yet", which means the
  // default below applies -- the latest message open, everything else closed.
  // A Set, not an array: `has` on every row of a long thread should not be a
  // scan, and a Set is what makes the toggle callback below stable.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [remoteImages, setRemoteImages] = useState(false);
  const [seed, setSeed] = useState<ComposerSeed | null>(null);

  const thread = data?.thread;
  const messages = useMemo(() => data?.messages ?? [], [data]);

  /**
   * What "expanded" means before the user has touched anything: the last
   * message alone. Kept in a ref, not read from `messages` inside the toggle,
   * so `toggle` can have an EMPTY dependency list and therefore a stable
   * identity -- which is what lets the memoised Message rows below actually
   * bail out. Recomputed only when the last message changes.
   */
  const lastId = messages[messages.length - 1]?.id;
  const defaultExpandedRef = useRef<ReadonlySet<string>>(new Set());
  const defaultExpanded = useMemo(() => new Set(lastId === undefined ? [] : [lastId]), [lastId]);
  defaultExpandedRef.current = defaultExpanded;

  /** Stable, like `toggle` below and for the same reason: a new closure every
   * render would defeat the memoised rows' shallow comparison one prop before
   * it started. A state SETTER is stable, and the update reads only its own
   * previous value. */
  const selectMessage = useCallback((messageId: string) => {
    setSelection((current) => toggleMessageSelected(current, messageId));
  }, []);

  const toggle = useCallback((messageId: string) => {
    setExpanded((current) => {
      const next = new Set(current ?? defaultExpandedRef.current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  /**
   * Mark read ONCE per opened thread, not once per render.
   *
   * The guard is a ref holding the thread this component has already marked:
   * the mutation invalidates ["mail-thread", id], which re-renders this with
   * fresh data, so anything condition-shaped here would need to survive that
   * re-render -- the ref is what does, one POST per opened thread. A thread
   * whose messages become unread again server-side while it is open is not
   * re-marked underneath the user either, for the same reason.
   *
   * UNCONDITIONAL past the ref, deliberately -- no "has unread messages"
   * pre-check. Under the detail cap this component only sees the newest 50,
   * and a client-side unseen test over that page misses a reachable shape:
   * the sync engine flips seen back to false on EXISTING rows when the IMAP
   * flag is removed (and an initial sync ingests old unread wholesale), so
   * a long thread's only unseen messages can sit entirely below the page --
   * counted by the badge, invisible to the heuristic, stuck until
   * Show-earlier. Idempotence is the SERVER's job and it already does it:
   * markThreadRead writes only rows that are actually unseen, publishes no
   * hint when nothing changed, and reports that verdict back as `changed`
   * -- which useMarkThreadRead gates its invalidations on -- so the cost
   * of firing on an already-read thread is one no-op POST per open and
   * nothing else: no hint, no follow-up refetches.
   */
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    if (markedRef.current === threadId) return;
    markedRef.current = threadId;
    markRead.mutate(threadId);
  }, [threadId, data, markRead]);

  // Every mailbox this installation syncs, own and other users' alike: a
  // reply-all must not address one of them (see replyRecipients).
  const ownAddresses = useMemo(
    () => [
      ...(accounts?.own ?? []).map((account) => account.email),
      ...(accounts?.others ?? []).map((account) => account.email),
    ],
    [accounts],
  );

  /**
   * The accounts this viewer OWNS, as a set (Phase 4.4 Task 2).
   *
   * Own accounts only, everywhere below: filing, archiving and trashing are
   * server MOVEs and those are owner-only (Phase 4.2), so a message on someone
   * else's shared mailbox is not tickable, does not count towards which mailbox
   * the picker names, and is never sent.
   *
   * `accounts.others` is deliberately NOT in here even though this viewer can
   * read those messages -- readable is not movable, and the server would answer
   * not_owner for every one of them.
   */
  const ownAccountIds = useMemo(
    () => new Set((accounts?.own ?? []).map((account) => account.id)),
    [accounts],
  );

  /** The messages this viewer may act on, in rendered order -- the order
   * selectedMessageIds filters against, so a message that has left the
   * conversation since it was ticked is not sent. */
  const messageOrder = useMemo(
    () => messages.filter((row) => ownAccountIds.has(row.accountId)).map((row) => row.id),
    [messages, ownAccountIds],
  );

  /**
   * WHOSE folders each picker offers, and they ask the same question of
   * different message sets.
   *
   * The header's "File into…" files the WHOLE conversation, so it asks about
   * every message of it; the message bar files the ticked ones, so it asks
   * about those -- which is why unticking is a real remedy for a mixed
   * selection there and nothing is in the header. Both go through
   * singleOwnAccount, where the reasoning and the known detail-cap gap live.
   */
  const selectedMessages = useMemo(
    () => messages.filter((row) => selection.ids.has(row.id)),
    [messages, selection],
  );
  const threadAccountId = singleOwnAccount(messages, ownAccountIds);
  const messagesAccountId = singleOwnAccount(selectedMessages, ownAccountIds);

  // UNSELECTABLE FOLDERS ARE DROPPED, sync-off ones deliberately KEPT -- the
  // inbox picker's rule, for the inbox picker's reasons: a \Noselect row is a
  // hierarchy node that can hold no messages and the API refuses it, while a
  // sync-off folder is exactly what this feature is for.
  const threadFolders = useFileTargets(threadAccountId);
  const messageFolders = useFileTargets(messagesAccountId);

  // Each own account's Trash folder, for the per-message "in Trash" chip.
  // Only OWN accounts: trash_folder is a setting, and another user's account
  // reaches this client as id/label/email alone -- a missing chip there, never
  // a wrong one (see messageIsInTrash).
  const trashByAccount = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const account of accounts?.own ?? []) map.set(account.id, account.trashFolder);
    return map;
  }, [accounts]);

  /**
   * The single-thread server moves: Archive, Trash and -- since Phase 4.4 Task
   * 2 -- File, through the same bulk endpoint with ONE id and NO folder.
   *
   * No folder means WHOLE-THREAD mode (the spec's second mode, which exists for
   * exactly this surface): every message of the conversation except those
   * already in the target and those in the account's Sent folder, because
   * archiving a conversation must never empty Sent. That is a different
   * question from the list's multi-select, which is scoped to the folder view
   * the selection was made in.
   *
   * FILING FROM HERE IS A SECOND ENTRANCE, NOT A SECOND IMPLEMENTATION. Task 1
   * built filing on the list only, so reading a thread and wanting to file it
   * meant going back, finding it again and selecting it -- three steps to undo
   * one navigation. This is the same action, the same endpoint and the same
   * whole-thread mode the two buttons beside it already use; in particular the
   * unsynced-destination rule (the folder's sync is switched ON, before the
   * move is queued) is the server's, reached by calling it, and nothing here
   * asks about it first.
   */
  function runMove(action: BulkThreadActionKind, targetFolder?: string) {
    setMoveSummary(null);
    setMoveFailure(null);
    move.mutate(
      {
        threadIds: [threadId],
        // The DESTINATION, valid only for `file` -- the shared schema rejects
        // it on anything else rather than ignoring it.
        ...(action === "file" && targetFolder !== undefined ? { targetFolder } : {}),
        action,
      },
      {
        onSuccess: (result) => setMoveSummary(summarizeBulkResult(action, result.results, {
          targetFolder: targetFolder ?? null,
          // The server's answer, not an assumption: present only when a
          // folder's sync was actually switched on by this request.
          syncEnabled: result.syncEnabled ?? null,
        })),
        // A 504 means the answer was lost, not that the move failed -- the hook
        // has already refetched (see useBulkThreadAction).
        onError: (moveError) => setMoveFailure(bulkErrorMessage(moveError)),
      },
    );
  }

  /**
   * The per-message moves (Phase 4.4 Task 2): the ticked messages alone, on
   * their own endpoint.
   *
   * The ids ARE the scope, so this request carries no folder in either sense of
   * the word except the destination -- and it goes to POST
   * /api/mail/messages/bulk, whose results are keyed on `messageId` because two
   * messages of this one conversation can genuinely land differently.
   *
   * THE SELECTION IS DROPPED AFTER the outcome lands, in that order, for the
   * inbox's reason: nothing here may invite a blind retry (a second `trash`
   * would move whatever is now in the source folder), and the outcome has to
   * reach state that outlives the bar it came from.
   */
  function runMessageMove(action: BulkMessageActionKind, targetFolder?: string) {
    const messageIds = selectedMessageIds(selection, messageOrder);
    if (messageIds.length === 0) return;
    setMoveSummary(null);
    setMoveFailure(null);
    moveMessages.mutate(
      {
        messageIds,
        ...(action === "file" && targetFolder !== undefined ? { targetFolder } : {}),
        action,
      },
      {
        onSuccess: (result) => {
          setMoveSummary(summarizeBulkResult(action, result.results, {
            targetFolder: targetFolder ?? null,
            syncEnabled: result.syncEnabled ?? null,
            // So the copy says "message" where it names the unit -- the
            // unknown_target and not_found notes both do.
            unit: "message",
          }));
          setSelection(emptyMessageSelection());
        },
        onError: (moveError) => {
          setMoveFailure(bulkErrorMessage(moveError));
          setSelection(emptyMessageSelection());
        },
      },
    );
  }

  const links: ComposerLinks | undefined = thread === undefined ? undefined : {
    ...(thread.companyId === null ? {} : { companyId: thread.companyId }),
    ...(thread.contactId === null ? {} : { contactId: thread.contactId }),
    ...(thread.dealId === null ? {} : { dealId: thread.dealId }),
    ...(thread.projectId === null ? {} : { projectId: thread.projectId }),
  };

  /** Send from the account the conversation actually arrived through, when
   * that is one of the current user's own sendable accounts; otherwise leave
   * it unset and let the composer pick its default. */
  function seedAccountId(message: MailMessageWithAttachments | undefined): string | undefined {
    const own = (accounts?.own ?? []).find(
      (account) => account.id === message?.accountId && account.archivedAt === null && account.status === "active",
    );
    return own?.id;
  }

  // Reply, Reply all and Forward are all somewhere the caret can go back to
  // when the composer closes, and each is a different button -- so each hands
  // its own element in. See components/ui/dialog-focus.ts.
  const returnFocus = useDialogReturnFocus();

  function openReply(all: boolean, trigger: HTMLElement) {
    returnFocus.capture(trigger);
    if (thread === undefined) return;
    const source = replySource(messages);
    if (source === undefined) return;
    const { to, cc } = replyRecipients(source, { all, ownAddresses });
    setSeed({
      accountId: seedAccountId(source),
      threadId: thread.id,
      // "Re: ..." is display convention for the recipient's mail client; the
      // API threads the reply on `threadId`, not on this string.
      subject: replySubject(thread.subject),
      to,
      cc,
      // The thread's links, ALWAYS: a seed with no links at all disables the
      // composer's attach control outright (POST /api/files needs a record to
      // file an upload against -- Task 9's handover note).
      links,
    });
  }

  function openForward(trigger: HTMLElement) {
    returnFocus.capture(trigger);
    if (thread === undefined) return;
    const source = messages[messages.length - 1];
    if (source === undefined) return;
    setSeed({
      accountId: seedAccountId(source),
      // No threadId: a forward starts its own conversation with someone new.
      subject: forwardSubject(thread.subject),
      bodyHtml: forwardBody(source),
      // The original's stored attachments ride along (Phase 4.3 forward
      // re-attach): the composer lists them as removable chips and sends
      // their ids as forwardAttachmentIds, which the API re-attaches from
      // the same blobs the download chips below serve. All of them,
      // inline images included -- an inline original arrives as an ordinary
      // attachment, the same way every mail client forwards one.
      forwardAttachments: source.attachments,
      links,
    });
  }

  if (isLoading) return <p className="text-sm text-slate-400">Loading...</p>;
  if (error) {
    // The calm branch for the indistinguishable 404 (mail-lib's isThreadGone).
    // It matters most for a pane that was ALREADY OPEN: a visibility flip does
    // not invalidate ["mail-thread", id] (the accepted stale-pane window --
    // spec Amendment 5), so the open conversation lives on its cached bytes
    // until an ordinary refetch meets the 404. TanStack keeps the stale `data`
    // when a refetch errors, and this branch runs BEFORE the data render on
    // purpose: continuing to paint a conversation the server just said does
    // not exist for this viewer would turn "bounded staleness" into
    // "indefinite", one focus refetch at a time.
    if (isThreadGone(error)) {
      return (
        <p data-testid="conversation-gone" className="rounded-md border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
          {THREAD_GONE_MESSAGE}
        </p>
      );
    }
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load this conversation: {error.message}
      </p>
    );
  }
  if (data === undefined || thread === undefined) return null;

  // Phase 4.3: hiddenAt is THIS viewer's own hide state (their
  // mail_thread_hides row's timestamp, null when they have not hidden the
  // thread) -- so the Hide/Unhide button below reflects and changes only
  // the signed-in user's filing, never anyone else's.
  const hidden = thread.hiddenAt !== null;
  const expandedIds = expanded ?? defaultExpandedRef.current;
  const hideError = hide.error ?? unhide.error;
  const earlierLabel = showEarlierLabel(data);
  const threadFileNote = fileTargetsBlocked(
    "conversation", threadAccountId !== "", threadFolders.length,
  );
  const selectedIds = selectedMessageIds(selection, messageOrder);
  const messagePending = moveMessages.isPending ? moveMessages.variables?.action ?? null : null;

  return (
    <div data-testid="conversation" className="flex min-w-0 flex-col gap-3">
      {/* flex-wrap on the row and a shrinkable, self-wrapping action group
          (the settings-mail header's idiom): at 1280px the conversation pane
          is ~416px, narrower than the four buttons' single row, and the old
          shrink-0 group overflowed the pane -- buttons clipped at its edge,
          the subject crushed to a one-character column. Wrapped, the subject
          takes its own full-width line(s) and the buttons wrap below;
          ml-auto on the group is the ONE right-alignment mechanism (it
          covers both the shared line and the wrapped one, where a row-level
          justify-between would go dead), so the row carries none. On wide
          viewports where both fit, the one-line layout is unchanged. */}
      <div className="flex flex-wrap items-start gap-3">
        <h2 className="min-w-0 break-words text-lg font-semibold text-slate-900">
          {subjectLabel(thread.subject)}
        </h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!remoteImages && (
            <Button
              variant="outline"
              data-testid="load-remote-images"
              onClick={() => setRemoteImages(true)}
            >
              Load remote images
            </Button>
          )}
          {/* The two SERVER moves. "Archive" here files the mail in the
              account's Archive folder over IMAP, so it sticks in every mail
              client -- unlike the CRM-side state next to it.

              RENDERED ONLY FOR AN OWNER (Phase 4.2): moves are owner-only
              (the spec's Move rights line), and `ownedByViewer` -- computed
              server-side per request, >= 1 message on an account the viewer
              owns -- is the payload's answer. Absent, not disabled, per the
              spec's UI line; every other viewer of a shared or deal-linked
              thread keeps Hide in CRM below. Owned does NOT mean every click
              succeeds: the flag is thread-global while the in-scope set is
              not (Sent is excluded, rows can be archived/awaiting, and a
              whole-thread move can find only unowned rows in scope), so the
              per-reason notes in the move result below remain the backstop
              for a not_owner or any other skip arriving AFTER an enabled
              click. */}
          {data.ownedByViewer && (
            <>
              <Button
                variant="outline"
                data-testid="conversation-archive"
                disabled={move.isPending}
                onClick={() => runMove("archive")}
              >
                Archive
              </Button>
              <Button
                variant="outline"
                data-testid="conversation-trash"
                disabled={move.isPending}
                onClick={() => runMove("trash")}
              >
                Trash
              </Button>
              {/* The second entrance to filing (Phase 4.4 Task 2). Picking the
                  folder IS the gesture -- no second button to press after
                  choosing, exactly as on the list's bar, because the choice is
                  the instruction. Nothing here is destructive in the way that
                  would argue for a confirm step: a misfiled conversation is
                  filed back with the same control, and the mail is never
                  expunged. */}
              <FolderPicker
                testId="conversation-file"
                label="File into folder"
                folders={threadFolders}
                blocked={threadFileNote}
                disabled={move.isPending}
                onPick={(folder) => runMove("file", folder)}
              />
            </>
          )}
          {/* The CRM-only filing pair, driven by `hiddenAt` -- THIS viewer's
              own hide row, so the button reflects and changes only their
              filing. The hide-thread/unhide-thread testids are the Task 3
              rename of the old archive-thread pair (coordinator ruling): two
              actions spelled "archive" on one screen was a standing hazard,
              and conversation-archive above -- the real IMAP move -- is the
              one that keeps the name. */}
          {hidden ? (
            <Button
              variant="outline"
              data-testid="unhide-thread"
              disabled={unhide.isPending}
              onClick={() => unhide.mutate(thread.id)}
            >
              Unhide
            </Button>
          ) : (
            <Button
              variant="outline"
              data-testid="hide-thread"
              disabled={hide.isPending}
              onClick={() => hide.mutate(thread.id)}
            >
              Hide in CRM
            </Button>
          )}
        </div>
      </div>

      {/* The live region is MOUNTED WHETHER OR NOT IT HAS ANYTHING TO SAY, and
          only its contents come and go: a role="status" element inserted into
          the DOM together with its text is announced unreliably, because
          several screen readers only watch the regions that existed when they
          took their snapshot. Empty, it occupies nothing. */}
      <div
        data-testid="conversation-move-result"
        role="status"
        aria-live="polite"
        className="flex flex-col gap-1 empty:hidden"
      >
        {moveFailure !== null && <p className="text-sm text-red-600">{moveFailure}</p>}
        {moveSummary !== null && (
          <>
            <p className="text-sm text-slate-600">{moveSummary.headline}</p>
            {moveSummary.notes.map((note) => (
              <p key={note} className="text-xs text-slate-500">{note}</p>
            ))}
          </>
        )}
      </div>

      {/* Why the header's picker is grey, as TEXT -- a `title` on a disabled
          control is invisible to a touch screen and silent to a screen reader,
          which is the rule the whole bulk bar follows. Outside the live region
          above deliberately: this is a standing fact about the conversation,
          not something that just happened, and announcing it would be
          announcing the absence of an event. */}
      {data.ownedByViewer && threadFileNote !== null && (
        <p data-testid="conversation-file-blocked" className="text-xs text-amber-700">
          {threadFileNote}
        </p>
      )}

      <LinkPanel thread={thread} dealSuggestions={data.dealSuggestions} />

      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="reply-button" onClick={(event) => openReply(false, event.currentTarget)}>Reply</Button>
        <Button variant="outline" data-testid="reply-all-button" onClick={(event) => openReply(true, event.currentTarget)}>
          Reply all
        </Button>
        <Button variant="outline" data-testid="forward-button" onClick={(event) => openForward(event.currentTarget)}>
          Forward
        </Button>
      </div>

      {hideError && (
        <p role="alert" className="text-sm text-red-600">
          {composeErrorMessage(hideError)}
        </p>
      )}

      {/* The detail cap's escape hatch, at the TOP of the conversation --
          where the messages it would reveal belong. Rendered while the
          shown payload is truncated; the capped page stays on screen while
          the uncapped fetch runs (see the query pair above), so the button
          carries its own pending/error state instead of blanking the pane. */}
      {earlierLabel !== null && (
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className="self-start"
            data-testid="show-earlier"
            disabled={full.isFetching}
            // A failed uncapped fetch leaves showAll set, so the retry path
            // is an explicit refetch rather than a no-op state write.
            onClick={() => (showAll ? void full.refetch() : setShowAll(true))}
          >
            {full.isFetching ? "Loading..." : earlierLabel}
          </Button>
          {showAll && full.error !== null && (
            <p role="alert" className="text-sm text-red-600">
              Could not load the earlier messages: {full.error.message}
            </p>
          )}
        </div>
      )}

      {selectedIds.length > 0 && (
        <MessageBar
          count={selectedIds.length}
          capped={selection.capped}
          pendingAction={messagePending}
          pendingTarget={moveMessages.variables?.targetFolder ?? null}
          folders={messageFolders}
          blockedFile={fileTargetsBlocked(
            "messages", messagesAccountId !== "", messageFolders.length,
          )}
          blockedCap={messageActionBlocked(selectedIds.length)}
          onRun={runMessageMove}
          onClear={() => setSelection(emptyMessageSelection())}
        />
      )}

      <ol className="flex flex-col gap-2">
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            expanded={expandedIds.has(message.id)}
            onToggle={toggle}
            remoteImages={remoteImages}
            inTrash={messageIsInTrash(message, trashByAccount)}
            // Only the viewer's OWN mail is tickable: a move is owner-only, so
            // a checkbox on someone else's message would be a control whose
            // every click the server answers not_owner. Absent, not disabled,
            // which is the choice the header's buttons already make for the
            // same rule.
            selectable={ownAccountIds.has(message.accountId)}
            selected={selection.ids.has(message.id)}
            onSelect={selectMessage}
          />
        ))}
      </ol>

      <Composer
        open={seed !== null}
        onOpenChange={(open) => { if (!open) setSeed(null); }}
        seed={seed ?? undefined}
        returnFocus={returnFocus}
      />
    </div>
  );
}

/**
 * Memoised per-message row, mirroring thread-list's ThreadRow (and gantt's
 * bar) -- a long thread re-rendering every message on every mark-read
 * invalidation, composer open or remote-images flip is the one avoidable cost
 * here, and each message body is an iframe. Shallow comparison suffices:
 * `message` comes from React Query and only changes when the thread refetches,
 * `onToggle` is the stable useCallback above, and the two booleans change for
 * one row (or, for remoteImages, deliberately for all of them).
 */
const Message = memo(function Message({
  message, expanded, onToggle, remoteImages, inTrash, selectable, selected, onSelect,
}: {
  message: MailMessageWithAttachments;
  expanded: boolean;
  /** Takes the id, so the parent can hand every row ONE stable callback. */
  onToggle: (messageId: string) => void;
  remoteImages: boolean;
  /** This message sits in its account's Trash folder (Phase 4.1) -- a plain
   * boolean, so the memo above still bails out. */
  inTrash: boolean;
  /** This viewer owns the mailbox, so the message may be moved (Phase 4.2's
   * owner-only rule). False renders no checkbox at all. */
  selectable: boolean;
  selected: boolean;
  /** Takes the id, so every row shares ONE stable callback -- see onToggle. */
  onSelect: (messageId: string) => void;
}) {
  const outbound = message.direction === "outbound";
  const from = message.fromName != null && message.fromName !== ""
    ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr;

  return (
    <li
      data-testid={`message-${message.id}`}
      className={clsx(
        "flex rounded-md border",
        selected ? "border-slate-400 bg-slate-100"
          : outbound ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white",
      )}
    >
      {/* OUTSIDE the expand button, not inside it: a checkbox nested in a
          button is not operable as a checkbox (the outer button swallows the
          click and the accessibility tree carries one control, not two), and
          the two gestures mean different things -- ticking a message to file
          it must not also open it. */}
      {selectable && (
        <label className="flex shrink-0 items-start px-2 py-2.5 max-md:min-h-11">
          <input
            type="checkbox"
            data-testid={`select-message-${message.id}`}
            checked={selected}
            onChange={() => onSelect(message.id)}
            className="size-4 rounded border-slate-300"
          />
          <span className="sr-only">Select this message</span>
        </label>
      )}
      {/* The header button and the body are ONE column beside the checkbox --
          the row is a flex row now, and without this wrapper an expanded body
          would render alongside its own header rather than under it. */}
      <div className="flex min-w-0 flex-1 flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(message.id)}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{from}</span>
          {/* The CRM never expunges: a trashed message keeps its row, and this
              chip is how the conversation says where it now lives. */}
          {inTrash && (
            <span
              data-testid="trash-chip"
              className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            >
              in Trash
            </span>
          )}
          {outbound && <span className="shrink-0 text-[11px] uppercase text-slate-400">Sent</span>}
          <span className="shrink-0 text-xs text-slate-400" title={new Date(message.sentAt).toLocaleString()}>
            {relativeTime(message.sentAt)}
          </span>
        </span>
        {expanded ? (
          <span className="flex flex-col text-xs text-slate-500">
            <span>To: {message.toAddrs.map(addressLabel).join(", ") || "\u2014"}</span>
            {message.ccAddrs.length > 0 && <span>Cc: {message.ccAddrs.map(addressLabel).join(", ")}</span>}
            <span>{new Date(message.sentAt).toLocaleString()}</span>
          </span>
        ) : (
          <span className="truncate text-xs text-slate-500">{message.snippet}</span>
        )}
      </button>

      {expanded && (
        // `body-<id>`, deliberately NOT `message-body-<id>`: the `message-`
        // testid family is prefix-matched (`[data-testid^="message-"]` is how
        // the rows are counted), and a second family nested inside it would
        // double every count. `data-body-kind` tells a test which of the two
        // renderings it got without guessing -- only the html branch is an
        // iframe, and only an iframe can be reached with a frame locator.
        <div className="flex flex-col gap-2 border-t border-slate-100 px-3 py-2">
          {message.bodyHtml != null && message.bodyHtml !== "" ? (
            <MessageFrame
              html={message.bodyHtml}
              remoteImages={remoteImages}
              testId={`body-${message.id}`}
              bodyKind="html"
            />
          ) : (
            // Text-only mail renders directly: there is no untrusted markup to
            // isolate, and an iframe around a paragraph of plain text would
            // only cost a fixed-height box.
            <pre
              data-testid={`body-${message.id}`}
              data-body-kind="text"
              className="whitespace-pre-wrap break-words font-sans text-sm text-slate-800"
            >
              {message.bodyText}
            </pre>
          )}
          {message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} />
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </li>
  );
});

/**
 * The bar that appears while messages are ticked: Archive, Trash, File into…,
 * Clear.
 *
 * A SEPARATE COMPONENT FROM BulkBar, not five optional props bolted onto it,
 * and the reasoning is the same shape as the API's: BulkBar's props are
 * thread-shaped (`unowned`, `hiddenView`, `accountScoped`, per-action caps over
 * five kinds), while this bar has three kinds, one cap, no CRM-side pair and no
 * hidden view. Widening that component so one of them ignores half its props is
 * the overloading this whole task set out to avoid, one layer up.
 *
 * `role="group"`, not `role="toolbar"`, for BulkBar's reason: a toolbar is a
 * single tab stop with arrow-key navigation between its controls, and claiming
 * the role while implementing none of that leaves a keyboard user pressing
 * arrows at buttons that do not respond.
 *
 * EVERY TESTID HERE IS `selection-*`, NEVER `message-*`, and that is a real
 * constraint rather than a naming preference. This bar renders INSIDE
 * `[data-testid="conversation"]`, where `[data-testid^="message-"]` is how e2e
 * counts the conversation's rows (Message's own body-testid comment records
 * the same rule for the same reason). A `message-archive` here would be
 * counted as a message the moment anything was ticked, silently inflating
 * every such assertion.
 */
function MessageBar({
  count, capped, pendingAction, pendingTarget, folders, blockedFile, blockedCap, onRun, onClear,
}: {
  count: number;
  capped: number | null;
  pendingAction: BulkMessageActionKind | null;
  pendingTarget: string | null;
  folders: readonly string[];
  blockedFile: string | null;
  blockedCap: string | null;
  onRun: (action: BulkMessageActionKind, targetFolder?: string) => void;
  onClear: () => void;
}) {
  const pending = pendingAction !== null;
  const disabled = pending || blockedCap !== null;
  return (
    <div
      data-testid="selection-bar"
      role="group"
      aria-label="Message actions"
      aria-busy={pending}
      className="flex flex-col gap-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="selection-count" className="text-sm font-medium text-slate-700">
          {selectionLabel(count, capped)}
        </span>
        <Button
          variant="outline" data-testid="selection-archive" disabled={disabled}
          onClick={() => onRun("archive")}
        >
          Archive
        </Button>
        <Button
          variant="outline" data-testid="selection-trash" disabled={disabled}
          onClick={() => onRun("trash")}
        >
          Trash
        </Button>
        <FolderPicker
          testId="selection-file"
          label="File messages into folder"
          folders={folders}
          blocked={blockedCap ?? blockedFile}
          disabled={pending}
          onPick={(folder) => onRun("file", folder)}
        />
        <Button variant="ghost" data-testid="selection-clear" onClick={onClear} disabled={pending}>
          Clear
        </Button>
      </div>

      {/* What the greyed controls cannot say themselves, as text rather than as
          a title -- a disabled control's tooltip reaches neither a touch screen
          nor a screen reader. The pending line matters most: these actions
          queue behind a real mail server's serial loop and can take minutes, so
          a bar that only greyed out would read as a dead app. */}
      {pendingAction !== null && (
        <p data-testid="selection-pending" role="status" className="text-xs text-slate-500">
          {bulkPendingLabel(pendingAction, count, pendingTarget, "message")}
        </p>
      )}
      {!pending && blockedCap !== null && (
        <p data-testid="selection-blocked" className="text-xs text-amber-700">{blockedCap}</p>
      )}
      {!pending && blockedCap === null && blockedFile !== null && (
        <p data-testid="selection-file-blocked" className="text-xs text-amber-700">{blockedFile}</p>
      )}
    </div>
  );
}

/**
 * A destination picker: choosing the folder IS the gesture.
 *
 * ONE COMPONENT FOR BOTH of this file's pickers -- the header's whole-thread
 * one and the message bar's -- because the control is identical and only the
 * ids, the label and the blocked reason differ. There is no second "File"
 * button to press after choosing: the choice is the instruction, the same one
 * click the buttons beside it take.
 *
 * THE VALUE IS NEVER HELD. This is a trigger, not a setting: a Select that
 * remembered "Clients" would read as a filter on the conversation, and the
 * chosen folder is not a piece of state anything here wants back. So the
 * trigger always shows its placeholder.
 */
function FolderPicker({
  testId, label, folders, blocked, disabled, onPick,
}: {
  testId: string;
  label: string;
  folders: readonly string[];
  /** The reason it cannot be used, or null. Rendered as text by the caller --
   * this only decides whether the control responds. */
  blocked: string | null;
  disabled: boolean;
  onPick: (folder: string) => void;
}) {
  return (
    <Select value="" onValueChange={onPick} disabled={disabled || blocked !== null}>
      <SelectTrigger
        testId={testId}
        ariaLabel={label}
        className="w-auto min-w-44 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <SelectValue placeholder={"File into\u2026"} />
      </SelectTrigger>
      <SelectContent position="popper">
        {folders.map((folder) => (
          <SelectItem key={folder} value={folder}>{folder}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A download link to the authenticated attachment route -- the same
 * same-origin, cookie-authenticated route the body's inline images use, but
 * its `download` half (Content-Disposition: attachment).
 *
 * 24px tall at a desk, measured, so it takes the phase's floor below the
 * breakpoint like every other control. A min-height, not the chip-remove
 * idiom in ui/touch.ts: that one grows a hit box OUTWARD with negative
 * margins because the chip it sits in must not move, whereas this chip IS the
 * control and may simply be bigger. It is already a centring inline flex row,
 * so the filename and size stay put within the taller pill. */
function AttachmentChip({ attachment }: { attachment: MailAttachment }) {
  return (
    <a
      data-testid={`attachment-${attachment.id}`}
      href={apiUrl(`/mail/attachments/${attachment.id}`)}
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200 max-md:min-h-11"
    >
      {attachment.filename}
      <span className="text-slate-400">{humanSize(attachment.sizeBytes)}</span>
    </a>
  );
}
