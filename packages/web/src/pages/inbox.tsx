import { useState } from "react";
import { relativeTime } from "../lib";
import { useMailThreads } from "../queries";
import { Composer } from "../components/mail/composer";
import { Button } from "../components/ui/button";

/**
 * The mail inbox (/mail).
 *
 * FIRST CUT, deliberately: a flat thread list and a Compose button, standing
 * the never-yet-executed Phase 4 web layer up against a real API before the
 * two-pane inbox is built on top of it. Every hook here runs its response
 * through parseWith, so contract drift fails loudly at this size rather than
 * three components deep.
 */
export function InboxPage() {
  const { data, isLoading, error } = useMailThreads({});
  const [composeOpen, setComposeOpen] = useState(false);

  return (
    <div data-testid="inbox" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>
        <Button data-testid="compose-button" onClick={() => setComposeOpen(true)}>
          Compose
        </Button>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          Could not load mail: {error.message}
        </p>
      )}

      <ul data-testid="thread-list" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {(data?.items ?? []).map((thread) => (
          <li
            key={thread.id}
            data-testid={`thread-row-${thread.id}`}
            className="flex items-baseline gap-3 px-4 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
              {thread.subject === "" ? "(no subject)" : thread.subject}
            </span>
            <span className="min-w-0 flex-1 truncate text-slate-500">{thread.snippet}</span>
            <span className="shrink-0 text-xs text-slate-400">{relativeTime(thread.lastMessageAt)}</span>
          </li>
        ))}
        {data && data.items.length === 0 && <li className="px-4 py-2 text-sm text-slate-400">No mail</li>}
      </ul>

      <Composer open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}
