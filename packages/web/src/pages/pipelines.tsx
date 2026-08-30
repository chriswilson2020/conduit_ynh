import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Pipeline } from "@conduit/shared";
import { useCompanies, useCreatePipeline, usePipelines } from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { CHECKBOX_LABEL } from "../components/ui/touch";

// No dedicated company Select entry maps to "global" -- Radix reserves the
// empty string, so this sentinel plays the same role NO_COMPANY/UNASSIGNED
// play in contacts.tsx/owner-select.tsx.
const GLOBAL = "global";

export function PipelinesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  // Archived pipelines hidden by default (usePipelines({}) -- archived
  // undefined -- already resolves to the server's own default of "only
  // unarchived", see listPipelines in services/pipelines.ts), toggled the
  // same way entity-table.tsx's own "Archived" checkbox works for the other
  // list pages -- this page is hand-rolled (no EntityTable here), so the
  // checkbox is reproduced directly rather than pulled from that component.
  const [archived, setArchived] = useState(false);
  const { data: pipelines = [], isLoading } = usePipelines({ archived });
  // Same limit-100 id -> name lookup tradeoff as ContactsPage's companyMap
  // (see its doc comment): right for today's scale, worth revisiting if a
  // tenant's company count grows well past that.
  const { data: companiesData } = useCompanies({ limit: 100 });
  const companyMap = useMemo(
    () => new Map((companiesData?.items ?? []).map((company) => [company.id, company.name])),
    [companiesData],
  );

  const globalPipelines = useMemo(() => pipelines.filter((p) => p.scope === "global"), [pipelines]);

  // Grouped by companyId, preserving first-seen order (listPipelines already
  // orders by position within a scope, so a Map built by a single pass over
  // the already-ordered array keeps each company's own pipelines ordered too).
  const byCompany = useMemo(() => {
    const groups = new Map<string, Pipeline[]>();
    for (const pipeline of pipelines) {
      if (pipeline.scope !== "company" || pipeline.companyId === null) continue;
      const list = groups.get(pipeline.companyId) ?? [];
      list.push(pipeline);
      groups.set(pipeline.companyId, list);
    }
    return groups;
  }, [pipelines]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Pipelines</h1>
        <div className="flex items-center gap-3">
          <label className={CHECKBOX_LABEL}>
            <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />
            Archived
          </label>
          {/* Loses the caret on success and is deliberately left that way:
              CreatePipelineDialog navigates, which unmounts this trigger, and
              the same `<body>` landing was measured after an ordinary row-link
              navigation with no dialog involved. It is a route change's defect.
              See components/entity-table.tsx for the long form, and
              components/ui/dialog-focus.ts for the mechanism. */}
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>New pipeline</Button>
            </DialogTrigger>
            <DialogContent>
              <CreatePipelineDialog onClose={() => setCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading...</p>}

      <PipelineSection title="Global" pipelines={globalPipelines} />

      {[...byCompany.entries()].map(([companyId, companyPipelines]) => (
        <PipelineSection
          key={companyId}
          title={companyMap.get(companyId) ?? "Unknown company"}
          pipelines={companyPipelines}
        />
      ))}

      {!isLoading && pipelines.length === 0 && <p className="text-sm text-slate-400">No pipelines yet.</p>}
    </div>
  );
}

function PipelineSection({ title, pipelines }: { title: string; pipelines: Pipeline[] }) {
  if (pipelines.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{title}</h2>
      <ul data-testid="pipeline-list" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {pipelines.map((pipeline) => (
          <li key={pipeline.id}>
            {/*
              THE ONE ROW IN THIS APP THAT ALREADY HAD A TAB STOP, and it is
              still changing. A `<button>` was reachable and Enter worked, but
              it announced itself as a button and could not be middle-clicked or
              opened in a new tab -- and this row does nothing but navigate.

              THE SHAPE IS NOT NEW TO THE APP: company-detail.tsx has listed a
              company's pipelines as `<li><Link>` since 403b3bf (Phase 2), and
              e2e/crm.spec.ts addresses those rows with `getByRole("link")`.
              This page was the odd one out.

              It needs no ROW_LINK overlay: the anchor is already `block w-full`,
              so it IS the row. Every class is the button's, unchanged, so the
              row renders exactly as it did.

              `draggable={false}` is the one thing it needs that ROW_LINK would
              otherwise have carried. A button is not draggable and an anchor
              is, so without it this row would have gained a link-drag the
              button never had -- the same difference that costs the entity
              lists their name selection. Spelled out rather than spread,
              because this link takes no overlay and so takes no ROW_LINK.
            */}
            <Link
              to="/pipelines/$pipelineId"
              params={{ pipelineId: pipeline.id }}
              data-testid={`pipeline-row-${pipeline.id}`}
              draggable={false}
              className="block w-full px-4 py-3 text-left text-sm text-slate-900 hover:bg-slate-50"
            >
              {pipeline.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreatePipelineDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const { data: companiesData } = useCompanies({ limit: 100 });
  const createPipeline = useCreatePipeline();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createPipeline.mutate(
      companyId === null ? { name: trimmed, scope: "global" } : { name: trimmed, scope: "company", companyId },
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
      <Select value={companyId ?? GLOBAL} onValueChange={(next) => setCompanyId(next === GLOBAL ? null : next)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={GLOBAL}>Global (no company)</SelectItem>
          {(companiesData?.items ?? []).map((company) => (
            <SelectItem key={company.id} value={company.id}>
              {company.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {createPipeline.isError && <p className="text-sm text-red-600">{createPipeline.error.message}</p>}
      <Button type="submit" disabled={name.trim() === "" || createPipeline.isPending}>
        Create
      </Button>
    </form>
  );
}
