import { useEffect, useMemo, useState } from "react";
import type { Event } from "@conduit/shared";
import { useEvents, useUsers } from "../../queries";
import { Button } from "../ui/button";

export interface TimelineProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
  taskId?: string;
}

// Single-letter badges rather than pictographic icons: ASCII, one distinct
// letter per verb, and there is no icon library in this project (see the task
// spec). Distinctness is the whole point -- two verbs sharing a letter make a
// record's timeline unreadable -- so a new verb takes a free letter, or takes
// a used one only when a coordinator ruling moves the incumbent (Phase 5
// Amendment 1 did exactly that; see `met` below).
const VERB_BADGE: Record<Event["verb"], string> = {
  created: "C",
  updated: "U",
  archived: "A",
  unarchived: "R",
  note_added: "N",
  file_attached: "F",
  stage_changed: "S",
  won: "W",
  lost: "L",
  reopened: "O",
  // Task 8's real task-event badges (Phase 3 Task 2 widened eventVerbSchema
  // with these four; P2.1 only stubbed the map exhaustively typed against
  // it -- see search.ts's own tasks: [] stub for that same stub-now/
  // wire-later precedent). Letters chosen to stay distinct from every badge
  // above: H (sHifted), D (completeD), P (dePendency added). The fourth was
  // M (reMoved) until Phase 5 Amendment 1 moved it to X so `met` could have
  // M: a dependency removal is among the rarest entries a timeline carries
  // and a meeting among the most common, so the mnemonic letter belongs to
  // the meeting -- and X reads as "removed" at least as well as M did.
  shifted: "H",
  completed: "D",
  dependency_added: "P",
  dependency_removed: "X",
  // Phase 5's three verbs, at the letters spec Amendment 1 settles. The
  // spec's first draft collided twice (met = M against dependency_removed,
  // mail_received = R against unarchived); the ruling gave the intuitive
  // letter to whichever verb a user sees more often, which moved
  // dependency_removed to X above and put mail_received on I (Inbound) so
  // unarchived keeps R untouched. Rendering these three rows -- link targets
  // and the derived mail subject -- is still Task 5's; only the letters and
  // the compile-forced entries live here.
  met: "M",
  mail_received: "I",
  mail_sent: "T",
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
    // Payload shape written by moveDeal in services/deals.ts: { from, to,
    // fromName, toName }. fromName/toName are used (not from/to, which are
    // stage ids) so this never needs a second round trip to resolve a name.
    case "stage_changed": {
      const fromName = event.payload.fromName;
      const toName = event.payload.toName;
      if (typeof fromName === "string" && typeof toName === "string") {
        return `moved from ${fromName} to ${toName}`;
      }
      if (typeof toName === "string") return `moved to ${toName}`;
      return "moved stage";
    }
    // Payload shape written by setStatus's target === "won" branch:
    // { valueCents, currency }. Falls back to a bare "won" when either is
    // missing (e.g. an unpriced deal has valueCents: null).
    case "won": {
      const valueCents = event.payload.valueCents;
      const currency = event.payload.currency;
      if (typeof valueCents === "number" && typeof currency === "string") {
        const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(valueCents / 100);
        return `won ${formatted}`;
      }
      return "won";
    }
    // Payload shape written by setStatus's target === "lost" branch: { reason }.
    case "lost": {
      const reason = event.payload.reason;
      return typeof reason === "string" && reason !== "" ? `lost: ${reason}` : "lost";
    }
    case "reopened":
      return "reopened";
    // Payload shape written by scheduling.ts's shiftTask: { from: {start,
    // due}, to: {start, due}, cascadedFrom }. cascadedFrom is the DRAGGED
    // task's id for every event other than the dragged task's own (which
    // carries null) -- rendered generically as "(cascaded)" rather than
    // resolving that id to a title, mirroring dependency_added/_removed
    // below. `compacted: true` (Phase 3.1's compactSchedule, scheduling.ts)
    // is a THIRD, independent marker on the same verb -- a compaction event's
    // own cascadedFrom is always null (compactSchedule has no "one dragged
    // task" to trace back to), so this appends alongside "(cascaded)" rather
    // than replacing it, even though in practice the two never co-occur.
    case "shifted": {
      const fromRange = formatDateRange(event.payload.from);
      const toRange = formatDateRange(event.payload.to);
      if (fromRange === null || toRange === null) return "shifted";
      const cascaded = typeof event.payload.cascadedFrom === "string";
      const compacted = event.payload.compacted === true;
      return `shifted ${fromRange} ${"\u2192"} ${toRange}${cascaded ? " (cascaded)" : ""}${compacted ? " (compacted)" : ""}`;
    }
    case "completed":
      return "completed";
    // Payload for both: { predecessorId }, written by addDependency/
    // removeDependency in services/tasks.ts. predecessorId is a raw uuid --
    // rendered generically (no lookup of the predecessor's title), since a
    // timeline event has no project/task context handy to fetch it with.
    case "dependency_added":
      return "added a dependency";
    case "dependency_removed":
      return "removed a dependency";
    default:
      return event.verb;
  }
}

/** Narrows a shifted event's `from`/`to` payload half ({start, due}, both
 * date strings) into "start\u2013due", or null when the shape doesn't match
 * -- see summarize()'s "shifted" case. */
function formatDateRange(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const { start, due } = part as Record<string, unknown>;
  if (typeof start !== "string" || typeof due !== "string") return null;
  return `${start}\u2013${due}`;
}

/**
 * Company/contact activity feed. Paginates the same way companies.tsx does:
 * accumulated `rows` plus a `cursor` that only advances on "Load more", so a
 * fresh mount (new companyId/contactId, since this remounts per detail page)
 * starts clean.
 */
export function Timeline({ companyId, contactId, dealId, projectId, taskId }: TimelineProps) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Event[]>([]);
  const { data, isLoading } = useEvents({ companyId, contactId, dealId, projectId, taskId, cursor });
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
