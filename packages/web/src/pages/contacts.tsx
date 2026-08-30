import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Contact } from "@conduit/shared";
import { useCompanies, useContacts, useCreateContact, useUsers } from "../queries";
import { nameWithSalutation } from "../components/contact-fields-lib";
import { EntityTable, type EntityTableColumn } from "../components/entity-table";
import { ROW_LINK } from "../components/row-link";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

// No dedicated company Select entry maps to "no company" -- Radix reserves
// the empty string, so this sentinel plays the same role UNASSIGNED does in
// owner-select.tsx.
const NO_COMPANY = "none";

export function ContactsPage() {
  const [q, setQ] = useState<string | undefined>(undefined);
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Contact[]>([]);

  const { data, isLoading } = useContacts({ q, archived, cursor });
  const { data: users = [] } = useUsers();
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  // The contacts list endpoint returns companyId, not a company name, and
  // there is no server-side join to fetch one alongside it. The simplest
  // correct fix within today's API is a single extra request for up to 100
  // companies, turned into a client-side id -> name lookup below. That is
  // right for a Phase 1-sized deployment but would silently show a dash for
  // companies past the 100th if a tenant's company count grows well beyond
  // that -- worth revisiting (e.g. a server-side embed) if it becomes a
  // real limit.
  const { data: companiesData } = useCompanies({ limit: 100 });
  const companyMap = useMemo(
    () => new Map((companiesData?.items ?? []).map((company) => [company.id, company.name])),
    [companiesData],
  );

  useEffect(() => {
    if (!data) return;
    setRows((prev) => (cursor === undefined ? data.items : [...prev, ...data.items]));
  }, [data, cursor]);

  const columns: EntityTableColumn<Contact>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        /*
         * THE SALUTATION SHOWS HERE AND THE PRONOUNS DO NOT, which is a
         * decision rather than an omission: a list is for finding someone, and
         * a pronoun is for writing to them. nameWithSalutation is not even
         * given the field -- see its signature.
         *
         * A contact without a salutation reads exactly as it did before
         * v1.1.0: a blank contributes nothing, not a placeholder and not a
         * dash, so the column does not gain a ragged left edge for the
         * majority of rows that will never carry one.
         */
        render: (contact) => nameWithSalutation(contact),
      },
      {
        key: "company",
        header: "Company",
        render: (contact) =>
          contact.companyId ? (companyMap.get(contact.companyId) ?? "\u2014") : "\u2014",
      },
      {
        key: "owner",
        header: "Owner",
        render: (contact) =>
          contact.ownerUserId ? (userMap.get(contact.ownerUserId) ?? contact.ownerUserId) : "\u2014",
      },
    ],
    [companyMap, userMap],
  );

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Contacts</h1>
      <EntityTable
        columns={columns}
        rows={rows}
        isLoading={isLoading}
        renderRowLink={(row, name) => (
          <Link to="/contacts/$contactId" params={{ contactId: row.id }} className={ROW_LINK}>
            {name}
          </Link>
        )}
        onQueryChange={(next) => {
          setQ(next.trim() === "" ? undefined : next.trim());
          setCursor(undefined);
        }}
        onArchivedChange={(next) => {
          setArchived(next);
          setCursor(undefined);
        }}
        nextCursor={data?.nextCursor ?? null}
        onLoadMore={() => {
          if (data?.nextCursor) setCursor(data.nextCursor);
        }}
        renderCreateDialog={(close) => <CreateContactDialog onClose={close} />}
      />
    </div>
  );
}

function CreateContactDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const { data: companiesData } = useCompanies({ limit: 100 });
  const createContact = useCreateContact();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = firstName.trim();
    if (trimmed === "") return;
    createContact.mutate(
      { firstName: trimmed, companyId: companyId ?? undefined },
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
      <Select
        value={companyId ?? NO_COMPANY}
        onValueChange={(next) => setCompanyId(next === NO_COMPANY ? null : next)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_COMPANY}>No company</SelectItem>
          {(companiesData?.items ?? []).map((company) => (
            <SelectItem key={company.id} value={company.id}>
              {company.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {createContact.isError && <p className="text-sm text-red-600">{createContact.error.message}</p>}
      <Button type="submit" disabled={firstName.trim() === "" || createContact.isPending}>
        Create
      </Button>
    </form>
  );
}
