import { useEffect, useState } from "react";
import type { MailLinkKind } from "@conduit/shared";
import { useCompanies, useContacts, useProjects, useSearch } from "../queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * Type-to-search over one record kind: the app's one entity picker.
 *
 * Written for Phase 4's mail link panel and lifted out of it in Phase 5, when
 * the Meetings tab needed the same "find a contact by typing" interaction for
 * its attendee input. It sits at components/ root rather than inside either
 * feature for the reason owner-select.tsx does: a picker used by two features
 * belongs to neither. Nothing about the component changed in the move --
 * including its `link-`prefixed testids, which existing mail e2e locates it
 * by.
 *
 * `MailLinkKind` is reused as the kind enum rather than a second identical
 * union being declared here: its four members ARE the four record kinds this
 * app has, and one of them going out of step with the other would be a bug in
 * either spelling.
 */
export type EntityPickerKind = MailLinkKind;

export const KIND_LABEL: Record<EntityPickerKind, string> = {
  contact: "Contact",
  company: "Company",
  deal: "Deal",
  project: "Project",
};

/**
 * Mirrors the global search's own debounce-then-query shape
 * (components/search.tsx) rather than inventing a second interaction for the
 * same job.
 *
 * One results component per kind, mounted only for the kind being picked, so
 * exactly one query runs -- calling all four hooks here and ignoring three
 * would fire three requests nobody asked for on every keystroke.
 */
export function EntityPicker({
  kind, onPick, onCancel,
}: {
  kind: EntityPickerKind;
  onPick: (id: string, label: string) => void;
  onCancel: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw.trim()), 200);
    return () => clearTimeout(timer);
  }, [raw]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-200 p-2">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          data-testid={`link-search-${kind}`}
          aria-label={`Search ${KIND_LABEL[kind].toLowerCase()}s`}
          placeholder={`Search ${KIND_LABEL[kind].toLowerCase()}s...`}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
        />
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {kind === "company" && <CompanyResults query={query} onPick={onPick} />}
      {kind === "contact" && <ContactResults query={query} onPick={onPick} />}
      {kind === "deal" && <DealResults query={query} onPick={onPick} />}
      {kind === "project" && <ProjectResults query={query} onPick={onPick} />}
    </div>
  );
}

const RESULT_LIMIT = 8;

/** The label rides back out through onPick alongside the id: every caller
 * needs something to show for what was picked, and the results list has
 * already resolved it -- a second lookup by id would be a request for a name
 * this component was just holding. */
type PickPayload = (id: string, label: string) => void;

function PickerResults({ results, onPick }: { results: { id: string; label: string }[]; onPick: PickPayload }) {
  if (results.length === 0) return <p className="px-1 text-xs text-slate-400">No matches</p>;
  return (
    <ul className="max-h-48 overflow-auto">
      {results.map((result) => (
        <li key={result.id}>
          <button
            type="button"
            data-testid={`link-option-${result.id}`}
            className="block w-full rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-100"
            onClick={() => onPick(result.id, result.label)}
          >
            {result.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CompanyResults({ query, onPick }: { query: string; onPick: PickPayload }) {
  const { data } = useCompanies(query === "" ? { limit: RESULT_LIMIT } : { q: query, limit: RESULT_LIMIT });
  return <PickerResults results={(data?.items ?? []).map((c) => ({ id: c.id, label: c.name }))} onPick={onPick} />;
}

function ContactResults({ query, onPick }: { query: string; onPick: PickPayload }) {
  const { data } = useContacts(query === "" ? { limit: RESULT_LIMIT } : { q: query, limit: RESULT_LIMIT });
  return (
    <PickerResults
      results={(data?.items ?? []).map((contact) => ({
        id: contact.id,
        label: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
      }))}
      onPick={onPick}
    />
  );
}

/**
 * Deals have no global list route -- GET /api/deals requires a pipeline id
 * (services/deals.ts) -- so the picker searches them through the global search
 * endpoint, which does index deal titles across every pipeline. It only
 * answers a non-empty query, hence the hint below.
 */
function DealResults({ query, onPick }: { query: string; onPick: PickPayload }) {
  const { data } = useSearch(query);
  if (query === "") return <p className="px-1 text-xs text-slate-400">Type to search deals</p>;
  return (
    <PickerResults
      results={(data?.deals ?? []).slice(0, RESULT_LIMIT).map((deal) => ({ id: deal.id, label: deal.title }))}
      onPick={onPick}
    />
  );
}

/**
 * Projects are listed unpaginated and unfiltered by the API (queries.ts's
 * useProjects mirrors listProjects), so the filtering is done here rather than
 * by a query parameter that does not exist.
 */
function ProjectResults({ query, onPick }: { query: string; onPick: PickPayload }) {
  const { data = [] } = useProjects({ archived: false });
  const needle = query.toLowerCase();
  const results = data
    .filter((project) => needle === "" || project.name.toLowerCase().includes(needle))
    .slice(0, RESULT_LIMIT)
    .map((project) => ({ id: project.id, label: project.name }));
  return <PickerResults results={results} onPick={onPick} />;
}
