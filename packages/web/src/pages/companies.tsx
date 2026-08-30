import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Company } from "@conduit/shared";
import { useCompanies, useCreateCompany, useUsers } from "../queries";
import { EntityTable, type EntityTableColumn } from "../components/entity-table";
import { ROW_LINK } from "../components/row-link";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DialogTitle } from "../components/ui/dialog";

export function CompaniesPage() {
  const [q, setQ] = useState<string | undefined>(undefined);
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Company[]>([]);

  const { data, isLoading } = useCompanies({ q, archived, cursor });
  const { data: users = [] } = useUsers();
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  // A fresh (non-"load more") page always replaces the accumulated rows; a
  // "load more" page (cursor set) appends. Query params changing resets
  // cursor to undefined below, which naturally makes this a replace.
  useEffect(() => {
    if (!data) return;
    setRows((prev) => (cursor === undefined ? data.items : [...prev, ...data.items]));
  }, [data, cursor]);

  const columns: EntityTableColumn<Company>[] = useMemo(
    () => [
      { key: "name", header: "Name", render: (company) => company.name },
      {
        key: "owner",
        header: "Owner",
        render: (company) =>
          company.ownerUserId ? (userMap.get(company.ownerUserId) ?? company.ownerUserId) : "\u2014",
      },
      {
        key: "updated",
        header: "Updated",
        render: (company) => new Date(company.updatedAt).toLocaleDateString(),
      },
    ],
    [userMap],
  );

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Companies</h1>
      <EntityTable
        columns={columns}
        rows={rows}
        isLoading={isLoading}
        renderRowLink={(row, name) => (
          <Link to="/companies/$companyId" params={{ companyId: row.id }} className={ROW_LINK}>
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
        renderCreateDialog={(close) => <CreateCompanyDialog onClose={close} />}
      />
    </div>
  );
}

function CreateCompanyDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const createCompany = useCreateCompany();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createCompany.mutate(
      { name: trimmed },
      {
        onSuccess: (company) => {
          onClose();
          void navigate({ to: "/companies/$companyId", params: { companyId: company.id } });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New company</DialogTitle>
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Company name"
        disabled={createCompany.isPending}
      />
      {createCompany.isError && <p className="text-sm text-red-600">{createCompany.error.message}</p>}
      <Button type="submit" disabled={name.trim() === "" || createCompany.isPending}>
        Create
      </Button>
    </form>
  );
}
