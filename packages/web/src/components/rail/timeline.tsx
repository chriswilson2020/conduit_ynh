import { useEffect, useMemo, useState } from "react";
import type { Event } from "@conduit/shared";
import { useEvents, useUsers } from "../../queries";
import { Button } from "../ui/button";

export interface TimelineProps {
  companyId?: string;
  contactId?: string;
}

// Single-letter badges rather than pictographic icons: ASCII, unambiguous per
// verb, and there is no icon library in this project (see the task spec).
const VERB_BADGE: Record<Event["verb"], string> = {
  created: "C",
  updated: "U",
  archived: "A",
  unarchived: "R",
  note_added: "N",
  file_attached: "F",
  // Phase 2 (pipelines/deals) verbs. The badges/summaries below are placeholders
  // pending Task 7 (deal detail + rail), which is where these events start being
  // emitted and where a dealId link/summary treatment gets designed properly.
  stage_changed: "S",
  won: "W",
  lost: "L",
  reopened: "O",
};

/**
 * Turns an event's untyped `payload` (z.record(string, unknown) -- see
 * shared's eventSchema) into the one-line human summary the spec calls for.
 * Each case narrows defensively: the payload shape is a server-side
 * convention, not something Zod verifies field-by-field here, so a missing or
 * mistyped key degrades to an empty/verb-only string instead of throwing.
 */
function summarize(event: Event): string {
  switch (event.verb) {
    case "updated": {
      const changed = event.payload.changed;
      return `updated ${Array.isArray(changed) ? changed.join(", ") : ""}`;
    }
    case "note_added": {
      const preview = event.payload.preview;
      return `"${typeof preview === "string" ? preview : ""}"`;
    }
    case "file_attached": {
      const name = event.payload.originalName;
      return typeof name === "string" ? name : "";
    }
    default:
      return event.verb;
  }
}

/**
 * Company/contact activity feed. Paginates the same way companies.tsx does:
 * accumulated `rows` plus a `cursor` that only advances on "Load more", so a
 * fresh mount (new companyId/contactId, since this remounts per detail page)
 * starts clean.
 */
export function Timeline({ companyId, contactId }: TimelineProps) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Event[]>([]);
  const { data, isLoading } = useEvents({ companyId, contactId, cursor });
  const { data: users = [] } = useUsers();
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  useEffect(() => {
    if (!data) return;
    setRows((prev) => (cursor === undefined ? data.items : [...prev, ...data.items]));
  }, [data, cursor]);

  return (
    <div data-testid="timeline" className="flex flex-col gap-3">
      {isLoading && rows.length === 0 && <p className="text-sm text-slate-400">Loading...</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-slate-400">No activity yet</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((event) => (
          <li key={event.id} data-testid="timeline-entry" className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600"
            >
              {VERB_BADGE[event.verb]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-slate-900">
                <span className="font-medium">{userMap.get(event.actorUserId) ?? "\u2014"}</span>{" "}
                {summarize(event)}
              </p>
              <p className="text-xs text-slate-400">{new Date(event.createdAt).toLocaleString()}</p>
            </div>
          </li>
        ))}
      </ul>
      {data?.nextCursor && (
        <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? undefined)}>
          Load more
        </Button>
      )}
    </div>
  );
}
