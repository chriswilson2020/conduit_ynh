import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Project } from "@conduit/shared";
import { userLabel } from "../lib";
import { useCompanies, useCreateProject, useProjects, useUsers } from "../queries";
import { EntityTable, type EntityTableColumn } from "../components/entity-table";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

// Radix reserves the empty string for "no selection" -- same sentinel role
// GLOBAL/UNASSIGNED play in pipelines.tsx/owner-select.tsx.
const NO_COMPANY = "none";

export function ProjectsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);

  // listProjects is unpaginated (see its own doc comment in
  // services/projects.ts) -- a plain array, so unlike CompaniesPage's cursor
  // accumulation this fetches everything matching `archived` in one shot and
  // filters the free-text query CLIENT-side (the projects route has no `q`
  // param -- a project count is bounded by what an org actually runs
  // concurrently, not CRM-scale, so this is a fine tradeoff for now).
  const { data: projects = [], isLoading } = useProjects({ archived });
  // Same limit-100 id -> name lookup tradeoff as ContactsPage's companyMap.
  const { data: companiesData } = useCompanies({ limit: 100 });
  const { data: users = [] } = useUsers();

  const companyMap = useMemo(
    () => new Map((companiesData?.items ?? []).map((company) => [company.id, company.name])),
    [companiesData],
  );
  const userMap = useMemo(
    () => new Map(users.map((user) => [user.id, userLabel(user, "")])),
    [users],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle === "") return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(needle));
  }, [projects, q]);

  const columns: EntityTableColumn<Project>[] = useMemo(
    () => [
      { key: "name", header: "Name", render: (project) => project.name },
      {
        key: "company",
        header: "Company",
        render: (project) => (project.companyId === null ? "\u2014" : companyMap.get(project.companyId) ?? "\u2026"),
      },
      {
        key: "owner",
        header: "Owner",
        render: (project) => (project.ownerUserId === null ? "\u2014" : userMap.get(project.ownerUserId) ?? "\u2026"),
      },
      {
        key: "status",
        header: "Status",
        render: (project) => (project.status === "active" ? "Active" : "Completed"),
      },
      // Raw ISO date string (YYYY-MM-DD), not routed through Date/
      // toLocaleDateString -- dueDate is a date-only value with no time-of-day,
      // and parsing it through a local-timezone Date can shift it a calendar
      // day either way depending on the viewer's offset from UTC.
      { key: "due", header: "Due", render: (project) => project.dueDate ?? "\u2014" },
    ],
    [companyMap, userMap],
  );

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Projects</h1>
      <EntityTable
        columns={columns}
        rows={filtered}
        isLoading={isLoading}
        onRowClick={(row) => void navigate({ to: "/projects/$projectId", params: { projectId: row.id } })}
        onQueryChange={setQ}
        onArchivedChange={setArchived}
        renderCreateDialog={(close) => <NewProjectDialog onClose={close} />}
      />
    </div>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const { data: companiesData } = useCompanies({ limit: 100 });
  const createProject = useCreateProject();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createProject.mutate(
      { name: trimmed, companyId },
      {
        onSuccess: (project) => {
          onClose();
          void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New project</DialogTitle>
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Project name"
        disabled={createProject.isPending}
      />
      <Select value={companyId ?? NO_COMPANY} onValueChange={(next) => setCompanyId(next === NO_COMPANY ? null : next)}>
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
      {createProject.isError && <p className="text-sm text-red-600">{createProject.error.message}</p>}
      <Button type="submit" disabled={name.trim() === "" || createProject.isPending}>
        Create
      </Button>
    </form>
  );
}
