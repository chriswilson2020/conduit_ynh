import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type {
  BulkThreadActionKind, MailAttachment, MailMessageWithAttachments,
} from "@conduit/shared";
import { apiUrl } from "../../api";
import { humanSize, relativeTime } from "../../lib";
import {
  useArchiveThread,
  useBulkThreadAction,
  useCompany,
  useContact,
  useMailAccounts,
  useMailThread,
  useMarkThreadRead,
  useUnarchiveThread,
} from "../../queries";
import { Composer, type ComposerSeed } from "./composer";
import { LinkPanel } from "./link-panel";
import { MessageFrame } from "./message-frame";
import {
  addressLabel,
  bulkErrorMessage,
  composeErrorMessage,
  forwardBody,
  forwardSubject,
  isThreadGone,
  messageIsInTrash,
  replyRecipients,
  replySource,
  replySubject,
  subjectLabel,
  summarizeBulkResult,
  THREAD_GONE_MESSAGE,
  type BulkActionSummary,
  type ComposerLinks,
} from "./mail-lib";
import { Button } from "../ui/button";

export interface ConversationProps {
  threadId: string;
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
  const { data, isLoading, error } = useMailThread(threadId);
  const markRead = useMarkThreadRead();
  const archive = useArchiveThread();
  const unarchive = useUnarchiveThread();
  const { data: accounts } = useMailAccounts();
  const move = useBulkThreadAction();
  const [moveSummary, setMoveSummary] = useState<BulkActionSummary | null>(null);
  const [moveFailure, setMoveFailure] = useState<string | null>(null);

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

  const toggle = useCallback((messageId: string) => {
    setExpanded((current) => {
      const next = new Set(current ?? defaultExpandedRef.current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  // Names for the composer's template placeholders, from whatever the thread
  // is linked to. Both hooks are disabled when the link is absent.
  const { data: linkedContact } = useContact(thread?.contactId ?? "");
  const { data: linkedCompany } = useCompany(thread?.companyId ?? "");

  /**
   * Mark read ONCE per opened thread, not once per render.
   *
   * The guard is a ref holding the thread this component has already marked:
   * the mutation invalidates ["mail-thread", id], which re-renders this with
   * fresh data, and a plain "has unread messages" condition would fire again
   * on that render (and on every render until the refetch landed) -- a POST
   * storm for one click. The ref is checked before the unread test rather
   * than after, so a thread whose messages become unread again server-side
   * while it is open is not re-marked underneath the user either.
   */
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    if (markedRef.current === threadId) return;
    if (!data.messages.some((message) => !message.seen)) return;
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
   * The single-thread server moves: Archive and Trash, through the same bulk
   * endpoint with ONE id and NO folder.
   *
   * No folder means WHOLE-THREAD mode (the spec's second mode, which exists for
   * exactly this surface): every message of the conversation except those
   * already in the target and those in the account's Sent folder, because
   * archiving a conversation must never empty Sent. That is a different
   * question from the list's multi-select, which is scoped to the folder view
   * the selection was made in.
   */
  function runMove(action: BulkThreadActionKind) {
    setMoveSummary(null);
    setMoveFailure(null);
    move.mutate({ threadIds: [threadId], action }, {
      onSuccess: (result) => setMoveSummary(summarizeBulkResult(action, result.results)),
      // A 504 means the answer was lost, not that the move failed -- the hook
      // has already refetched (see useBulkThreadAction).
      onError: (moveError) => setMoveFailure(bulkErrorMessage(moveError)),
    });
  }

  const links: ComposerLinks | undefined = thread === undefined ? undefined : {
    ...(thread.companyId === null ? {} : { companyId: thread.companyId }),
    ...(thread.contactId === null ? {} : { contactId: thread.contactId }),
    ...(thread.dealId === null ? {} : { dealId: thread.dealId }),
    ...(thread.projectId === null ? {} : { projectId: thread.projectId }),
  };

  const context = {
    contactName: linkedContact === undefined
      ? undefined : `${linkedContact.firstName} ${linkedContact.lastName ?? ""}`.trim(),
    companyName: linkedCompany?.name,
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

  function openReply(all: boolean) {
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
      context,
    });
  }

  function openForward() {
    if (thread === undefined) return;
    const source = messages[messages.length - 1];
    if (source === undefined) return;
    setSeed({
      accountId: seedAccountId(source),
      // No threadId: a forward starts its own conversation with someone new.
      subject: forwardSubject(thread.subject),
      bodyHtml: forwardBody(source),
      links,
      context,
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

  // Phase 4.3: hiddenAt is the per-viewer hide state (Task 1 still serves
  // the thread-global value under the new name -- behaviour identical).
  const hidden = thread.hiddenAt !== null;
  const expandedIds = expanded ?? defaultExpandedRef.current;
  const archiveError = archive.error ?? unarchive.error;

  return (
    <div data-testid="conversation" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-lg font-semibold text-slate-900">
          {subjectLabel(thread.subject)}
        </h2>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            </>
          )}
          {/* The CRM-only state, renamed "Hide in CRM" now that Archive above
              means something else entirely. The testids predate the rename and
              stay put: they are addresses, not labels. */}
          {hidden ? (
            <Button
              variant="outline"
              data-testid="unarchive-thread"
              disabled={unarchive.isPending}
              onClick={() => unarchive.mutate(thread.id)}
            >
              Unhide
            </Button>
          ) : (
            <Button
              variant="outline"
              data-testid="archive-thread"
              disabled={archive.isPending}
              onClick={() => archive.mutate(thread.id)}
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

      <LinkPanel thread={thread} dealSuggestions={data.dealSuggestions} />

      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="reply-button" onClick={() => openReply(false)}>Reply</Button>
        <Button variant="outline" data-testid="reply-all-button" onClick={() => openReply(true)}>
          Reply all
        </Button>
        <Button variant="outline" data-testid="forward-button" onClick={openForward}>
          Forward
        </Button>
      </div>

      {archiveError && (
        <p role="alert" className="text-sm text-red-600">
          {composeErrorMessage(archiveError)}
        </p>
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
          />
        ))}
      </ol>

      <Composer
        open={seed !== null}
        onOpenChange={(open) => { if (!open) setSeed(null); }}
        seed={seed ?? undefined}
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
  message, expanded, onToggle, remoteImages, inTrash,
}: {
  message: MailMessageWithAttachments;
  expanded: boolean;
  /** Takes the id, so the parent can hand every row ONE stable callback. */
  onToggle: (messageId: string) => void;
  remoteImages: boolean;
  /** This message sits in its account's Trash folder (Phase 4.1) -- a plain
   * boolean, so the memo above still bails out. */
  inTrash: boolean;
}) {
  const outbound = message.direction === "outbound";
  const from = message.fromName != null && message.fromName !== ""
    ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr;

  return (
    <li
      data-testid={`message-${message.id}`}
      className={clsx(
        "rounded-md border",
        outbound ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white",
      )}
    >
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
    </li>
  );
});

/** A download link to the authenticated attachment route -- the same
 * same-origin, cookie-authenticated route the body's inline images use, but
 * its `download` half (Content-Disposition: attachment). */
function AttachmentChip({ attachment }: { attachment: MailAttachment }) {
  return (
    <a
      data-testid={`attachment-${attachment.id}`}
      href={apiUrl(`/mail/attachments/${attachment.id}`)}
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200"
    >
      {attachment.filename}
      <span className="text-slate-400">{humanSize(attachment.sizeBytes)}</span>
    </a>
  );
}
