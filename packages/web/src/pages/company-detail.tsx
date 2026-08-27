import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { UpdateCompanyInput } from "@conduit/shared";
import { ApiError } from "../api";
import {
  useArchiveCompany,
  useCompany,
  useContacts,
  useCreateContact,
  useCreatePipeline,
  usePipelines,
  useUnarchiveCompany,
  useUpdateCompany,
} from "../queries";
import { FieldCard, type FieldCardField } from "../components/field-card";
import { OwnerSelect } from "../components/owner-select";
import { Rail } from "../components/rail/rail";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";

function buildCompanyPatch(name: string, value: string): UpdateCompanyInput {
  const trimmed = value.trim();
  switch (name) {
    case "name":
      return { name: trimmed };
    case "domain":
      return { domain: trimmed === "" ? null : trimmed };
    case "website":
      return { website: trimmed === "" ? null : trimmed };
    case "phone":
      return { phone: trimmed === "" ? null : trimmed };
    case "address":
      return { address: trimmed === "" ? null : trimmed };
    case "industry":
      return { industry: trimmed === "" ? null : trimmed };
    default:
      return {};
  }
}

export function CompanyDetailPage() {
  const { companyId } = useParams({ from: "/companies/$companyId" });
  const { data: company, isLoading, error } = useCompany(companyId);
  const { data: contactsData } = useContacts({ companyId });
  // Archived pipelines behind a "show archived" control (Phase 4.3): the
  // checkbox swaps the list between live and archived, the same shape the
  // pipelines index and entity-table's own "Archived" checkbox give every
  // other archive-not-delete entity. The archived view needs no read-only
  // gating HERE: this section renders pipelines as plain links, and the
  // board they lead to already gates every mutating affordance on an
  // archived pipeline (board.tsx's readOnly banner). The section's one
  // mutation, New pipeline, creates a fresh live pipeline either way.
  const [archivedPipelines, setArchivedPipelines] = useState(false);
  const { data: pipelines = [] } = usePipelines({ companyId, archived: archivedPipelines });
  const updateCompany = useUpdateCompany();
  const archiveCompany = useArchiveCompany();
  const unarchiveCompany = useUnarchiveCompany();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);

  // ApiError.code is the server's machine-readable `error` field: branching on
  // it (rather than the human-readable message, which always includes the
  // interpolated company id) is what lets this reword the 409 a PATCH gets
  // back for an archived record into an actionable hint.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This company is archived. Unarchive it to make changes.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  function handleSave(name: string, value: string) {
    if (!company) return;
    setSavingField(name);
    updateCompany.mutate(
      { id: company.id, patch: buildCompanyPatch(name, value) },
      {
        onSuccess: () => setSavingField(null),
        onError: (err) => {
          setSavingField(null);
          reportError(err);
        },
      },
    );
  }

  function handleOwnerChange(userId: string | null) {
    if (!company) return;
    updateCompany.mutate({ id: company.id, patch: { ownerUserId: userId } }, { onError: reportError });
  }

  function handleArchive() {
    if (!company) return;
    if (!window.confirm(`Archive ${company.name}?`)) return;
    archiveCompany.mutate(company.id, { onError: reportError });
  }

  function handleUnarchive() {
    if (!company) return;
    unarchiveCompany.mutate(company.id, { onError: reportError });
  }

  // THE FRAME OUTLIVES THE FETCH, and every detail page in this app now says
  // so the same way. A page-level `return <p>Loading...</p>` replaces the
  // whole layout, so a navigation to a record this browser has not fetched
  // before -- which is most of them -- UNMOUNTED the rail on the way, taking
  // its open tab and its selected meeting with it. Neither has anything to do
  // with the record being fetched, and rail.tsx's record-keyed guard cannot
  // help: it decides what a MOUNTED rail shows, and only ever ran between two
  // records already in the query cache.
  //
  // The rail is handed the ROUTE param here and below, never `company.id`, so
  // that guard's key is the same string across the loading render and the
  // loaded one by construction rather than by the server echoing the id back.
  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 lg:w-2/3">
          <p>Loading...</p>
        </div>
        <aside className="min-w-0 lg:w-1/3">
          <Rail companyId={companyId} />
        </aside>
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div
          data-testid="not-found"
          className="max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm"
        >
          <h1 className="text-lg font-semibold text-slate-900">Company not found</h1>
          <Link to="/companies" className="mt-4 inline-block text-sm font-medium text-slate-900 underline">
            Back to companies
          </Link>
        </div>
      );
    }
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load company: {error.message}
      </p>
    );
  }

  if (!company) return null;

  const fields: FieldCardField[] = [
    { name: "name", label: "Name", value: company.name, editable: true },
    { name: "domain", label: "Domain", value: company.domain, editable: true },
    { name: "website", label: "Website", value: company.website, editable: true },
    { name: "phone", label: "Phone", value: company.phone, editable: true },
    { name: "address", label: "Address", value: company.address, editable: true },
    { name: "industry", label: "Industry", value: company.industry, editable: true },
  ];
  const archived = company.archivedAt !== null;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 lg:w-2/3">
        {bannerError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            <span>{bannerError}</span>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              className="ml-4 shrink-0 text-red-500 hover:text-red-700"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">{company.name}</h1>
          {!archived && (
            <Button variant="danger" onClick={handleArchive}>
              Archive
            </Button>
          )}
        </div>

        <FieldCard
          fields={fields}
          onSave={handleSave}
          archived={archived}
          onUnarchive={handleUnarchive}
          savingField={savingField}
        />

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Owner</span>
          <div data-testid="field-ownerUserId" className="max-w-xs flex-1">
            <OwnerSelect value={company.ownerUserId} onChange={handleOwnerChange} disabled={archived} />
          </div>
        </div>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Contacts</h2>
            <Dialog open={newContactOpen} onOpenChange={setNewContactOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">New contact</Button>
              </DialogTrigger>
              <DialogContent>
                <NewContactDialog companyId={company.id} onClose={() => setNewContactOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
          <ul
            data-testid="company-contacts"
            className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white"
          >
            {(contactsData?.items ?? []).map((contact) => (
              <li key={contact.id}>
                <Link
                  to="/contacts/$contactId"
                  params={{ contactId: contact.id }}
                  className="block px-4 py-2 text-sm text-slate-900 hover:bg-slate-50"
                >
                  {contact.firstName} {contact.lastName ?? ""}
                </Link>
              </li>
            ))}
            {contactsData && contactsData.items.length === 0 && (
              <li className="px-4 py-2 text-sm text-slate-400">No contacts</li>
            )}
          </ul>
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Pipelines</h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  data-testid="show-archived-pipelines"
                  checked={archivedPipelines}
                  onChange={(event) => setArchivedPipelines(event.target.checked)}
                />
                Archived
              </label>
              <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">New pipeline</Button>
                </DialogTrigger>
                <DialogContent>
                  <NewPipelineDialog companyId={company.id} onClose={() => setNewPipelineOpen(false)} />
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <ul
            data-testid="company-pipelines"
            className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white"
          >
            {pipelines.map((pipeline) => (
              <li key={pipeline.id}>
                <Link
                  to="/pipelines/$pipelineId"
                  params={{ pipelineId: pipeline.id }}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-slate-900 hover:bg-slate-50"
                >
                  {pipeline.name}
                  {/* Set exactly on the archived view's rows (the default
                      view lists archivedAt-null rows only), so the list
                      says which state it is showing without this component
                      tracking it per row. */}
                  {pipeline.archivedAt !== null && (
                    <span
                      data-testid="pipeline-archived-chip"
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
                    >
                      Archived
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {pipelines.length === 0 && (
              <li className="px-4 py-2 text-sm text-slate-400">
                {archivedPipelines ? "No archived pipelines" : "No pipelines"}
              </li>
            )}
          </ul>
        </section>
      </div>
      <aside className="min-w-0 lg:w-1/3">
        <Rail companyId={companyId} />
      </aside>
    </div>
  );
}

function NewContactDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const createContact = useCreateContact();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = firstName.trim();
    if (trimmed === "") return;
    createContact.mutate(
      { firstName: trimmed, companyId },
      {
        onSuccess: (contact) => {
          onClose();
          void navigate({ to: "/contacts/$contactId", params: { contactId: contact.id } });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New contact</DialogTitle>
      <Input
        autoFocus
        value={firstName}
        onChange={(event) => setFirstName(event.target.value)}
        placeholder="First name"
        disabled={createContact.isPending}
      />
      {createContact.isError && <p className="text-sm text-red-600">{createContact.error.message}</p>}
      <Button type="submit" disabled={firstName.trim() === "" || createContact.isPending}>
        Create
      </Button>
    </form>
  );
}

// Always creates a company-scoped pipeline (scope: "company") prefilled with
// this company's id -- unlike PipelinesPage's own create dialog (which lets
// the user pick global vs. a company), this one only ever needs to offer the
// name field since the scope/companyId are already decided by where the
// dialog was opened from.
function NewPipelineDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const createPipeline = useCreatePipeline();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createPipeline.mutate(
      { name: trimmed, scope: "company", companyId },
      {
        onSuccess: (pipeline) => {
          onClose();
          void navigate({ to: "/pipelines/$pipelineId", params: { pipelineId: pipeline.id } });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New pipeline</DialogTitle>
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Pipeline name"
        disabled={createPipeline.isPending}
      />
      {createPipeline.isError && <p className="text-sm text-red-600">{createPipeline.error.message}</p>}
      <Button type="submit" disabled={name.trim() === "" || createPipeline.isPending}>
        Create
      </Button>
    </form>
  );
}
