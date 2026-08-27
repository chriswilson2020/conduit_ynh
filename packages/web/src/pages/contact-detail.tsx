import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { UpdateContactInput } from "@conduit/shared";
import { ApiError } from "../api";
import {
  useArchiveContact,
  useCompany,
  useContact,
  useUnarchiveContact,
  useUpdateContact,
} from "../queries";
import { FieldCard, type FieldCardField } from "../components/field-card";
import { OwnerSelect } from "../components/owner-select";
import { Rail } from "../components/rail/rail";
import { Button } from "../components/ui/button";

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function buildContactPatch(name: string, value: string): UpdateContactInput {
  const trimmed = value.trim();
  switch (name) {
    case "firstName":
      return { firstName: trimmed };
    case "lastName":
      return { lastName: trimmed === "" ? null : trimmed };
    case "jobTitle":
      return { jobTitle: trimmed === "" ? null : trimmed };
    case "emails":
      return { emails: splitList(value) };
    case "phones":
      return { phones: splitList(value) };
    default:
      return {};
  }
}

export function ContactDetailPage() {
  const { contactId } = useParams({ from: "/contacts/$contactId" });
  const { data: contact, isLoading, error } = useContact(contactId);
  const { data: linkedCompany } = useCompany(contact?.companyId ?? "");
  const updateContact = useUpdateContact();
  const archiveContact = useArchiveContact();
  const unarchiveContact = useUnarchiveContact();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});

  // ApiError.code is the server's machine-readable `error` field: branching
  // on it (rather than the human-readable message, which for "archived"
  // always includes the interpolated contact id) is what lets this reword
  // that 409 into an actionable hint.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This contact is archived. Unarchive it to make changes.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  function handleSave(name: string, value: string) {
    if (!contact) return;
    setSavingField(name);
    setFieldErrors((prev) => ({ ...prev, [name]: undefined }));
    updateContact.mutate(
      { id: contact.id, patch: buildContactPatch(name, value) },
      {
        onSuccess: () => setSavingField(null),
        onError: (err: unknown) => {
          setSavingField(null);
          // Invalid email format (code "validation") is the one error the
          // spec calls out to show inline, right under the emails field,
          // rather than in the banner; everything else (including a 409
          // while editing emails) goes to the shared top banner.
          if (name === "emails" && err instanceof ApiError && err.code === "validation") {
            setFieldErrors((prev) => ({ ...prev, emails: err.message }));
            return;
          }
          reportError(err);
        },
      },
    );
  }

  function handleOwnerChange(userId: string | null) {
    if (!contact) return;
    updateContact.mutate({ id: contact.id, patch: { ownerUserId: userId } }, { onError: reportError });
  }

  function handleArchive() {
    if (!contact) return;
    const label = `${contact.firstName} ${contact.lastName ?? ""}`.trim();
    if (!window.confirm(`Archive ${label}?`)) return;
    archiveContact.mutate(contact.id, { onError: reportError });
  }

  function handleUnarchive() {
    if (!contact) return;
    unarchiveContact.mutate(contact.id, { onError: reportError });
  }

  // Inside the frame, not in place of it, and with the route param rather
  // than `contact.id` -- see company-detail.tsx for what that keeps alive.
  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 lg:w-2/3">
          <p>Loading...</p>
        </div>
        <aside className="min-w-0 lg:w-1/3">
          <Rail contactId={contactId} />
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
          <h1 className="text-lg font-semibold text-slate-900">Contact not found</h1>
          <Link to="/contacts" className="mt-4 inline-block text-sm font-medium text-slate-900 underline">
            Back to contacts
          </Link>
        </div>
      );
    }
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load contact: {error.message}
      </p>
    );
  }

  if (!contact) return null;

  const fields: FieldCardField[] = [
    { name: "firstName", label: "First name", value: contact.firstName, editable: true },
    { name: "lastName", label: "Last name", value: contact.lastName, editable: true },
    { name: "jobTitle", label: "Job title", value: contact.jobTitle, editable: true },
    { name: "emails", label: "Emails", value: contact.emails.join(", "), editable: true },
    { name: "phones", label: "Phones", value: contact.phones.join(", "), editable: true },
  ];
  const archived = contact.archivedAt !== null;
  const fullName = `${contact.firstName} ${contact.lastName ?? ""}`.trim();

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
          <h1 className="text-xl font-semibold text-slate-900">{fullName}</h1>
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
          errors={fieldErrors}
        />

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Company</span>
          <div data-testid="field-companyId" className="flex-1 text-sm text-slate-900">
            {contact.companyId === null ? (
              <span>{"\u2014"}</span>
            ) : linkedCompany ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId: linkedCompany.id }}
                className="text-slate-900 underline hover:text-slate-700"
              >
                {linkedCompany.name}
              </Link>
            ) : (
              <span>{"\u2026"}</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Owner</span>
          <div data-testid="field-ownerUserId" className="max-w-xs flex-1">
            <OwnerSelect value={contact.ownerUserId} onChange={handleOwnerChange} disabled={archived} />
          </div>
        </div>
      </div>
      <aside className="min-w-0 lg:w-1/3">
        <Rail contactId={contactId} />
      </aside>
    </div>
  );
}
