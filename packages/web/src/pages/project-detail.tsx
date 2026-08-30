import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { ProjectStatus, UpdateProjectInput } from "@conduit/shared";
import { ApiError } from "../api";
import {
  useArchiveProject, useCompany, useCreatePipeline, useDeal, usePipelines, useProject, useTasks,
  useUnarchiveProject, useUpdateProject,
} from "../queries";
import { FieldCard, type FieldCardField } from "../components/field-card";
import { OwnerSelect } from "../components/owner-select";
import { Rail } from "../components/rail/rail";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

const STATUS_LABEL: Record<ProjectStatus, string> = { active: "Active", completed: "Completed" };
const DEFAULT_COLOR = "#64748b";

function buildProjectPatch(name: string, value: string): UpdateProjectInput {
  const trimmed = value.trim();
  switch (name) {
    case "name":
      return { name: trimmed };
    default:
      return {};
  }
}

export function ProjectDetailPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project, isLoading, error } = useProject(projectId);
  const { data: linkedCompany } = useCompany(project?.companyId ?? "");
  const { data: linkedDeal } = useDeal(project?.dealId ?? "");
  const { data: pipelines = [] } = usePipelines({ projectId });
  const { data: tasks = [] } = useTasks({ projectId });
  const updateProject = useUpdateProject();
  const archiveProject = useArchiveProject();
  const unarchiveProject = useUnarchiveProject();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);

  const taskCounts = useMemo(() => {
    const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const task of tasks) counts[task.status] += 1;
    return counts;
  }, [tasks]);

  // ApiError.code is the server's machine-readable `error` field: branching on
  // it (rather than the human-readable message, which always includes the
  // interpolated project id) is what lets this reword the 409 a PATCH gets
  // back for an archived record into an actionable hint.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This project is archived. Unarchive it to make changes.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  function handleSave(name: string, value: string) {
    if (!project) return;
    setSavingField(name);
    updateProject.mutate(
      { id: project.id, patch: buildProjectPatch(name, value) },
      {
        onSuccess: () => setSavingField(null),
        onError: (err) => {
          setSavingField(null);
          reportError(err);
        },
      },
    );
  }

  function handleStatusChange(status: ProjectStatus) {
    if (!project) return;
    updateProject.mutate({ id: project.id, patch: { status } }, { onError: reportError });
  }

  // Unlike a task's startDate/dueDate (tasks_dates_paired DB CHECK, enforced
  // client-side too via taskDatesPaired), a project has no such pairing
  // constraint (see schema.ts's projects table -- only projects_status_valid
  // and projects_color_format) -- each date patches independently, same
  // pattern as deal-detail.tsx's single expectedCloseDate field.
  function handleStartDateChange(value: string) {
    if (!project) return;
    updateProject.mutate({ id: project.id, patch: { startDate: value === "" ? null : value } }, { onError: reportError });
  }
  function handleDueDateChange(value: string) {
    if (!project) return;
    updateProject.mutate({ id: project.id, patch: { dueDate: value === "" ? null : value } }, { onError: reportError });
  }

  function handleColorChange(value: string) {
    if (!project) return;
    updateProject.mutate({ id: project.id, patch: { color: value } }, { onError: reportError });
  }

  function handleOwnerChange(userId: string | null) {
    if (!project) return;
    updateProject.mutate({ id: project.id, patch: { ownerUserId: userId } }, { onError: reportError });
  }

  function handleArchive() {
    if (!project) return;
    if (!window.confirm(`Archive ${project.name}?`)) return;
    archiveProject.mutate(project.id, { onError: reportError });
  }

  function handleUnarchive() {
    if (!project) return;
    unarchiveProject.mutate(project.id, { onError: reportError });
  }

  // Inside the frame, not in place of it, and with the route param rather
  // than `project.id` -- see company-detail.tsx for what that keeps alive.
  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 lg:w-2/3">
          <p>Loading...</p>
        </div>
        <aside className="min-w-0 lg:w-1/3">
          <Rail projectId={projectId} />
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
          <h1 className="text-lg font-semibold text-slate-900">Project not found</h1>
          <Link to="/projects" className="mt-4 inline-block text-sm font-medium text-slate-900 underline">
            Back to projects
          </Link>
        </div>
      );
    }
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load project: {error.message}
      </p>
    );
  }

  if (!project) return null;

  const archived = project.archivedAt !== null;
  const fields: FieldCardField[] = [
    { name: "name", label: "Name", value: project.name, editable: true },
  ];

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

        {/*
          THE SAME SHAPE AS pages/deal-detail.tsx's HEADER, AND IT WAS MISSED
          WHEN THAT ONE WAS FIXED.
          Measured at 390 with a project whose name holds one long unbreakable
          word: this row ran to 546 against a 390 box, so the Archive button sat
          off the edge -- and at 320 its centre was outside the viewport
          entirely, which is a control that cannot be tapped at all. Before
          components/shell.tsx started clipping below the breakpoint that row
          was swipe-reachable, so this is that change's own regression and not a
          pre-existing one.
          `flex-wrap` drops the action group onto its own line; `min-w-0` on the
          title beside it is what lets the title shrink at all (a flex item
          defaults to `min-width: auto`, which floors it at its longest word),
          and `break-words` is what stops a single long word overflowing the
          line it has been given. All three are needed: the first two alone
          still left a 40-character word over the edge, measured.
        */}
        <div className="mb-4 flex items-center justify-between gap-4 max-md:flex-wrap">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="h-4 w-4 shrink-0 rounded-full border border-slate-300"
              style={{ backgroundColor: project.color ?? DEFAULT_COLOR }}
            />
            <h1 className="text-xl font-semibold break-words text-slate-900">{project.name}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/projects/$projectId/board"
              params={{ projectId: project.id }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Board
            </Link>
            <Link
              to="/projects/$projectId/gantt"
              params={{ projectId: project.id }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Gantt
            </Link>
            {!archived && (
              <Button variant="danger" onClick={handleArchive}>
                Archive
              </Button>
            )}
          </div>
        </div>

        <FieldCard
          fields={fields}
          onSave={handleSave}
          archived={archived}
          onUnarchive={handleUnarchive}
          savingField={savingField}
        />

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Status</span>
          <div data-testid="field-status" className="max-w-xs flex-1">
            <Select value={project.status} onValueChange={(next) => handleStatusChange(next as ProjectStatus)} disabled={archived}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{STATUS_LABEL.active}</SelectItem>
                <SelectItem value="completed">{STATUS_LABEL.completed}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Start date</span>
          {/* `min-w-0` for the reason pages/deal-detail.tsx's own date row
              carries it: Chromium's date control has an intrinsic min-content
              width that a `flex-1` item's default `min-width: auto` cannot
              shrink past, so at 320 this wrapper ran 185 to 326 against a 320
              box. Identical defect, identical fix, missed here first time. */}
          <div data-testid="field-startDate" className="min-w-0 flex-1">
            <input
              type="date"
              value={project.startDate ?? ""}
              onChange={(event) => handleStartDateChange(event.target.value)}
              disabled={archived}
              className="w-full max-w-xs rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Due date</span>
          <div data-testid="field-dueDate" className="min-w-0 flex-1">
            <input
              type="date"
              value={project.dueDate ?? ""}
              onChange={(event) => handleDueDateChange(event.target.value)}
              disabled={archived}
              className="w-full max-w-xs rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Color</span>
          <div data-testid="field-color" className="flex-1">
            <input
              type="color"
              value={project.color ?? DEFAULT_COLOR}
              onChange={(event) => handleColorChange(event.target.value)}
              disabled={archived}
              // 64x32 at a desk; the floor applies to the short axis only,
              // since 64 already clears it on the long one.
              className="h-8 w-16 cursor-pointer rounded border border-slate-300 disabled:cursor-not-allowed max-md:h-11"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Owner</span>
          <div data-testid="field-ownerUserId" className="max-w-xs flex-1">
            <OwnerSelect value={project.ownerUserId} onChange={handleOwnerChange} disabled={archived} />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Company</span>
          <div data-testid="field-companyId" className="min-w-0 flex-1 break-words text-sm text-slate-900">
            {project.companyId === null ? (
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
          <span className="w-32 shrink-0 text-sm font-medium text-slate-500">Originating deal</span>
          <div data-testid="field-dealId" className="min-w-0 flex-1 break-words text-sm text-slate-900">
            {project.dealId === null ? (
              <span>{"\u2014"}</span>
            ) : linkedDeal ? (
              <Link
                to="/deals/$dealId"
                params={{ dealId: linkedDeal.id }}
                className="text-slate-900 underline hover:text-slate-700"
              >
                {linkedDeal.title}
              </Link>
            ) : (
              <span>{"\u2026"}</span>
            )}
          </div>
        </div>

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Tasks</h2>
          <Link
            to="/projects/$projectId/board"
            params={{ projectId: project.id }}
            data-testid="tasks-summary"
            className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 hover:bg-slate-50"
          >
            <span>
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
              {" \u2014 "}
              {taskCounts.todo} todo, {taskCounts.in_progress} in progress, {taskCounts.blocked} blocked, {taskCounts.done} done
            </span>
            <span className="text-xs font-medium text-slate-500">Open board {"\u2192"}</span>
          </Link>
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Pipelines</h2>
            <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">New pipeline</Button>
              </DialogTrigger>
              <DialogContent>
                <NewProjectPipelineDialog projectId={project.id} onClose={() => setNewPipelineOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
          <ul
            data-testid="project-pipelines"
            className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white"
          >
            {pipelines.map((pipeline) => (
              <li key={pipeline.id}>
                <Link
                  to="/pipelines/$pipelineId"
                  params={{ pipelineId: pipeline.id }}
                  className="block px-4 py-2 text-sm text-slate-900 hover:bg-slate-50"
                >
                  {pipeline.name}
                </Link>
              </li>
            ))}
            {pipelines.length === 0 && <li className="px-4 py-2 text-sm text-slate-400">No pipelines</li>}
          </ul>
        </section>
      </div>
      <aside className="min-w-0 lg:w-1/3">
        <Rail projectId={projectId} />
      </aside>
    </div>
  );
}

// Always creates a project-scoped pipeline (scope: "project") prefilled with
// this project's id -- mirrors company-detail.tsx's NewPipelineDialog, one
// scope over.
function NewProjectPipelineDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const createPipeline = useCreatePipeline();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    createPipeline.mutate(
      { name: trimmed, scope: "project", projectId },
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
