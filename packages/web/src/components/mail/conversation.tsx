import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type { MailAttachment, MailMessageWithAttachments } from "@conduit/shared";
import { apiUrl } from "../../api";
import { humanSize, relativeTime } from "../../lib";
import {
  useArchiveThread,
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
  forwardBody,
  forwardSubject,
  replyRecipients,
  replySource,
  replySubject,
  subjectLabel,
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

  const [expanded, setExpanded] = useState<string[] | null>(null);
  const [remoteImages, setRemoteImages] = useState(false);
  const [seed, setSeed] = useState<ComposerSeed | null>(null);

  const thread = data?.thread;
  const messages = useMemo(() => data?.messages ?? [], [data]);

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
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load this conversation: {error.message}
      </p>
    );
  }
  if (data === undefined || thread === undefined) return null;

  const archived = thread.archivedAt !== null;
  const lastId = messages[messages.length - 1]?.id;
  const expandedIds = expanded ?? (lastId === undefined ? [] : [lastId]);

  function toggle(messageId: string) {
    setExpanded((current) => {
      const base = current ?? (lastId === undefined ? [] : [lastId]);
      return base.includes(messageId)
        ? base.filter((id) => id !== messageId)
        : [...base, messageId];
    });
  }

  return (
    <div data-testid="conversation" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words text-lg font-semibold text-slate-900">
          {subjectLabel(thread.subject)}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {!remoteImages && (
            <Button
              variant="outline"
              data-testid="load-remote-images"
              onClick={() => setRemoteImages(true)}
            >
              Load remote images
            </Button>
          )}
          {archived ? (
            <Button
              variant="outline"
              data-testid="unarchive-thread"
              disabled={unarchive.isPending}
              onClick={() => unarchive.mutate(thread.id)}
            >
              Unarchive
            </Button>
          ) : (
            <Button
              variant="outline"
              data-testid="archive-thread"
              disabled={archive.isPending}
              onClick={() => archive.mutate(thread.id)}
            >
              Archive
            </Button>
          )}
        </div>
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

      <ol className="flex flex-col gap-2">
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            expanded={expandedIds.includes(message.id)}
            onToggle={() => toggle(message.id)}
            remoteImages={remoteImages}
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

function Message({
  message, expanded, onToggle, remoteImages,
}: {
  message: MailMessageWithAttachments;
  expanded: boolean;
  onToggle: () => void;
  remoteImages: boolean;
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
        onClick={onToggle}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{from}</span>
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
        <div className="flex flex-col gap-2 border-t border-slate-100 px-3 py-2">
          {message.bodyHtml != null && message.bodyHtml !== "" ? (
            <MessageFrame
              html={message.bodyHtml}
              remoteImages={remoteImages}
              testId={`message-body-${message.id}`}
            />
          ) : (
            // Text-only mail renders directly: there is no untrusted markup to
            // isolate, and an iframe around a paragraph of plain text would
            // only cost a fixed-height box.
            <pre
              data-testid={`message-body-${message.id}`}
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
}

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
