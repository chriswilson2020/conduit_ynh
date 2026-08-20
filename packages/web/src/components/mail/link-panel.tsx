import { useEffect, useState } from "react";
import type { MailDealSuggestion, MailLinkKind, MailThread } from "@conduit/shared";
import {
  useClearThreadLink,
  useCompanies,
  useCompany,
  useContact,
  useContacts,
  useDeal,
  useProject,
  useProjects,
  useSearch,
  useSetThreadLink,
} from "../../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface LinkPanelProps {
  thread: MailThread;
  /** From the thread detail: open deals of whoever the thread is already
   * linked to, that it is not linked to yet. */
  dealSuggestions: readonly MailDealSuggestion[];
}

const KIND_LABEL: Record<MailLinkKind, string> = {
  contact: "Contact",
  company: "Company",
  deal: "Deal",
  project: "Project",
};

const KINDS: MailLinkKind[] = ["contact", "company", "deal", "project"];

/**
 * The four record links a thread carries, plus the two ways to add one: an
 * entity picker per kind, and the one-click deal suggestions the thread detail
 * already computed server-side.
 *
 * Linking is what makes a conversation part of the CRM rather than just mail:
 * a linked thread shows up on the record's Mail tab, and it is what the
 * inbox's "unlinked" triage filter is the complement of.
 */
export function LinkPanel({ thread, dealSuggestions }: LinkPanelProps) {
  const setLink = useSetThreadLink();
  const clearLink = useClearThreadLink();
  const [picking, setPicking] = useState<MailLinkKind | null>(null);

  const { data: company } = useCompany(thread.companyId ?? "");
  const { data: contact } = useContact(thread.contactId ?? "");
  const { data: deal } = useDeal(thread.dealId ?? "");
  const { data: project } = useProject(thread.projectId ?? "");

  const linked: Record<MailLinkKind, { id: string; name: string } | null> = {
    contact: thread.contactId === null ? null : {
      id: thread.contactId,
      name: contact === undefined ? "..." : `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    },
    company: thread.companyId === null ? null : { id: thread.companyId, name: company?.name ?? "..." },
    deal: thread.dealId === null ? null : { id: thread.dealId, name: deal?.title ?? "..." },
    project: thread.projectId === null ? null : { id: thread.projectId, name: project?.name ?? "..." },
  };

  function link(kind: MailLinkKind, id: string) {
    setPicking(null);
    setLink.mutate({ threadId: thread.id, kind, id });
  }

  const error = setLink.error ?? clearLink.error;

  return (
    <div data-testid="link-panel" className="flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Linked to</span>
        {KINDS.every((kind) => linked[kind] === null) && (
          <span className="text-xs text-slate-400">Nothing yet</span>
        )}
        {KINDS.map((kind) => {
          const entry = linked[kind];
          return entry === null ? null : (
            <span
              key={kind}
              data-testid={`thread-link-${kind}`}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
            >
              <span className="text-slate-400">{KIND_LABEL[kind]}</span>
              {entry.name}
              <button
                type="button"
                aria-label={`Unlink ${KIND_LABEL[kind].toLowerCase()}`}
                className="text-slate-400 hover:text-slate-900"
                onClick={() => clearLink.mutate({ threadId: thread.id, kind })}
              >
                {"\u00D7"}
              </button>
            </span>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {KINDS.map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            className="px-2 py-1 text-xs"
            data-testid={`link-${kind}`}
            onClick={() => setPicking((current) => (current === kind ? null : kind))}
          >
            {linked[kind] === null ? `Link ${KIND_LABEL[kind].toLowerCase()}` : `Change ${KIND_LABEL[kind].toLowerCase()}`}
          </Button>
        ))}
      </div>

      {picking !== null && (
        <EntityPicker kind={picking} onPick={(id) => link(picking, id)} onCancel={() => setPicking(null)} />
      )}

      {dealSuggestions.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-slate-100 pt-2">
          <span className="text-xs font-medium text-slate-500">Open deals for this conversation</span>
          {dealSuggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              data-testid={`deal-suggestion-${suggestion.id}`}
              className="self-start rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
              onClick={() => link("deal", suggestion.id)}
            >
              Link {suggestion.title}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error.message}
        </p>
      )}
    </div>
  );
}

/**
 * Type-to-search over one record kind, mirroring the global search's own
 * debounce-then-query shape (components/search.tsx) rather than inventing a
 * second interaction for the same job.
 *
 * One results component per kind, mounted only for the kind being picked, so
 * exactly one query runs -- calling all four hooks here and ignoring three
 * would fire three requests nobody asked for on every keystroke.
 */
function EntityPicker({
  kind, onPick, onCancel,
}: {
  kind: MailLinkKind;
  onPick: (id: string) => void;
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

function PickerResults({ results, onPick }: { results: { id: string; label: string }[]; onPick: (id: string) => void }) {
  if (results.length === 0) return <p className="px-1 text-xs text-slate-400">No matches</p>;
  return (
    <ul className="max-h-48 overflow-auto">
      {results.map((result) => (
        <li key={result.id}>
          <button
            type="button"
            data-testid={`link-option-${result.id}`}
            className="block w-full rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-100"
            onClick={() => onPick(result.id)}
          >
            {result.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CompanyResults({ query, onPick }: { query: string; onPick: (id: string) => void }) {
  const { data } = useCompanies(query === "" ? { limit: RESULT_LIMIT } : { q: query, limit: RESULT_LIMIT });
  return <PickerResults results={(data?.items ?? []).map((c) => ({ id: c.id, label: c.name }))} onPick={onPick} />;
}

function ContactResults({ query, onPick }: { query: string; onPick: (id: string) => void }) {
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
function DealResults({ query, onPick }: { query: string; onPick: (id: string) => void }) {
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
function ProjectResults({ query, onPick }: { query: string; onPick: (id: string) => void }) {
  const { data = [] } = useProjects({ archived: false });
  const needle = query.toLowerCase();
  const results = data
    .filter((project) => needle === "" || project.name.toLowerCase().includes(needle))
    .slice(0, RESULT_LIMIT)
    .map((project) => ({ id: project.id, label: project.name }));
  return <PickerResults results={results} onPick={onPick} />;
}
