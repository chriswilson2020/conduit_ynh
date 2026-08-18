import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { UpdateCompanyInput } from "@conduit/shared";
import {
  useArchiveCompany,
  useCompany,
  useContacts,
  useCreateContact,
  useUnarchiveCompany,
  useUpdateCompany,
} from "../queries";
import { FieldCard, type FieldCardField } from "../components/field-card";
import { OwnerSelect } from "../components/owner-select";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";

// getJson (src/api.ts) throws a plain Error with no structured status code, so
// a 404 can only be recognised by matching its "... failed with 404" message.
// Fragile, but there is nowhere else to get the status from with today's api.ts.
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /failed with 404$/.test(error.message);
}

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
  const updateCompany = useUpdateCompany();
  const archiveCompany = useArchiveCompany();
  const unarchiveCompany = useUnarchiveCompany();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [newContactOpen, setNewContactOpen] = useState(false);

  function reportError(err: unknown, archivedHint: string) {
    const message = err instanceof Error ? err.message : String(err);
    setBannerError(message === "archived" ? archivedHint : message);
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
          reportError(err, "This company is archived. Unarchive it to make changes.");
        },
      },
    );
  }

  function handleOwnerChange(userId: string | null) {
    if (!company) return;
    updateCompany.mutate(
      { id: company.id, patch: { ownerUserId: userId } },
      { onError: (err) => reportError(err, "This company is archived. Unarchive it to make changes.") },
    );
  }

  function handleArchive() {
    if (!company) return;
    if (!window.confirm(`Archive ${company.name}?`)) return;
    archiveCompany.mutate(company.id, { onError: (err) => reportError(err, "") });
  }

  function handleUnarchive() {
    if (!company) return;
    unarchiveCompany.mutate(company.id, { onError: (err) => reportError(err, "") });
  }

  if (isLoading) return <p>Loading...</p>;

  if (error) {
    if (isNotFoundError(error)) {
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
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
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
      </div>
      <aside data-testid="rail-placeholder" className="w-72 shrink-0" />
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
