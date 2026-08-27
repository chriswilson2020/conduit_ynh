import { useState } from "react";
import type { MailDealSuggestion, MailLinkKind, MailThread } from "@conduit/shared";
import {
  useClearThreadLink,
  useCompany,
  useContact,
  useDeal,
  useProject,
  useSetThreadLink,
} from "../../queries";
import { EntityPicker, KIND_LABEL } from "../entity-picker";
import { Button } from "../ui/button";

export interface LinkPanelProps {
  thread: MailThread;
  /** From the thread detail: open deals of whoever the thread is already
   * linked to, that it is not linked to yet. */
  dealSuggestions: readonly MailDealSuggestion[];
}

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
                className="text-slate-400 hover:text-slate-900 max-md:-my-2 max-md:-mr-2 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center"
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
              className="self-start rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 max-md:min-h-11"
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
