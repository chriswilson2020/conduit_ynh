import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { useSearch } from "../queries";
import { Input } from "./ui/input";

type FlatResult =
  | { kind: "company"; key: string; id: string; label: string }
  | { kind: "contact"; key: string; id: string; label: string; secondary: string | null }
  | { kind: "note"; key: string; snippet: string; companyId: string | null; contactId: string | null }
  | { kind: "deal"; key: string; id: string; label: string }
  | { kind: "task"; key: string; id: string; label: string; projectId: string | null };

const GROUP_LABEL: Record<FlatResult["kind"], string> = {
  company: "Companies",
  contact: "Contacts",
  note: "Notes",
  deal: "Deals",
  task: "Tasks",
};

/**
 * Global header search. Debounces the raw input 200ms (mirroring
 * entity-table.tsx's filter debounce) before it drives useSearch, which only
 * fires once the debounced value is non-empty (useSearch's own `enabled`
 * check -- see queries.ts). Results from every group are flattened into one
 * array, in Companies/Contacts/Notes/Deals/Tasks order (searchResultsSchema's
 * own field order), so ArrowUp/ArrowDown can move a single highlight index
 * across all of them regardless of group.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(rawQuery), 200);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const trimmed = debouncedQuery.trim();
  const { data } = useSearch(trimmed);

  const flattened = useMemo<FlatResult[]>(() => {
    if (!data) return [];
    const companies: FlatResult[] = data.companies.map((company) => ({
      kind: "company",
      key: `company-${company.id}`,
      id: company.id,
      label: company.name,
    }));
    const contacts: FlatResult[] = data.contacts.map((contact) => ({
      kind: "contact",
      key: `contact-${contact.id}`,
      id: contact.id,
      label: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
      secondary: contact.emails[0] ?? null,
    }));
    const notes: FlatResult[] = data.notes.map((note) => ({
      kind: "note",
      key: `note-${note.id}`,
      snippet: note.snippet,
      companyId: note.companyId,
      contactId: note.contactId,
    }));
    const deals: FlatResult[] = data.deals.map((deal) => ({
      kind: "deal",
      key: `deal-${deal.id}`,
      id: deal.id,
      label: deal.title,
    }));
    const tasks: FlatResult[] = data.tasks.map((task) => ({
      kind: "task",
      key: `task-${task.id}`,
      id: task.id,
      label: task.title,
      projectId: task.projectId,
    }));
    return [...companies, ...contacts, ...notes, ...deals, ...tasks];
  }, [data]);

  // A fresh result set always restarts the highlight at the top -- keyed on
  // `data` (not `flattened`, which is a new array reference every render)
  // so this doesn't fire on renders that don't change the underlying results.
  useEffect(() => {
    setHighlight(0);
  }, [data]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  function goTo(entry: FlatResult) {
    if (entry.kind === "company") {
      void navigate({ to: "/companies/$companyId", params: { companyId: entry.id } });
    } else if (entry.kind === "contact") {
      void navigate({ to: "/contacts/$contactId", params: { contactId: entry.id } });
    } else if (entry.kind === "deal") {
      void navigate({ to: "/deals/$dealId", params: { dealId: entry.id } });
    } else if (entry.kind === "task") {
      // A project task opens straight into its board's drawer; a standalone
      // task (no projectId) has no board to land on, so it opens via My
      // Tasks instead -- both routes read the same `?task=<id>` deep-link
      // param (Task 8's task-board.tsx / my-tasks.tsx). Deliberately a plain
      // push (no `replace`), unlike those two pages' own openTask/closeTask:
      // this navigation lands on a DIFFERENT route than wherever search was
      // invoked from, so it's a real navigation Back should undo -- only a
      // same-route ?task= toggle (the drawer opening/closing without
      // otherwise leaving the page) gets replace: true.
      if (entry.projectId !== null) {
        void navigate({ to: "/projects/$projectId/board", params: { projectId: entry.projectId }, search: { task: entry.id } });
      } else {
        void navigate({ to: "/my-tasks", search: { task: entry.id } });
      }
    } else if (entry.companyId !== null) {
      void navigate({ to: "/companies/$companyId", params: { companyId: entry.companyId } });
    } else if (entry.contactId !== null) {
      void navigate({ to: "/contacts/$contactId", params: { contactId: entry.contactId } });
    }
  }

  function selectResult(entry: FlatResult) {
    goTo(entry);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      event.currentTarget.blur();
      return;
    }
    if (!open || flattened.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, flattened.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = flattened[highlight];
      if (entry) selectResult(entry);
    }
  }

  const showDropdown = open && trimmed !== "";

  return (
    <div data-testid="global-search" ref={containerRef} className="relative">
      <Input
        data-testid="search-input"
        value={rawQuery}
        onChange={(event) => {
          const value = event.target.value;
          setRawQuery(value);
          setOpen(value.trim() !== "");
        }}
        onFocus={() => {
          if (rawQuery.trim() !== "") setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search companies, contacts, notes..."
        aria-label="Search"
      />
      {showDropdown && (
        <div className="absolute z-10 mt-1 max-h-96 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {flattened.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-400">No results</p>
          ) : (
            <ul>
              {flattened.map((entry, index) => {
                const previous = index === 0 ? undefined : flattened[index - 1];
                const showHeader = previous === undefined || previous.kind !== entry.kind;
                return (
                  <li key={entry.key}>
                    {showHeader && (
                      <div className="bg-slate-50 px-3 py-1 text-xs font-semibold uppercase text-slate-500">
                        {GROUP_LABEL[entry.kind]}
                      </div>
                    )}
                    <button
                      type="button"
                      data-testid="search-result"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => selectResult(entry)}
                      className={clsx(
                        "block w-full px-3 py-2 text-left text-sm",
                        index === highlight ? "bg-slate-100" : "hover:bg-slate-50",
                      )}
                    >
                      {entry.kind === "note" ? (
                        <span className="block text-slate-900">{entry.snippet}</span>
                      ) : (
                        <>
                          <span className="block text-slate-900">{entry.label}</span>
                          {entry.kind === "contact" && entry.secondary && (
                            <span className="block text-xs text-slate-400">{entry.secondary}</span>
                          )}
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
