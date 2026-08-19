import { Link, useParams } from "@tanstack/react-router";
import { useProject } from "../queries";

/**
 * Placeholder for the per-project Gantt route (`/projects/$projectId/gantt`)
 * -- the real chart lands in Task 9, contingent on G0's prototype gate
 * (docs/superpowers/plans/2026-08-19-conduit-phase-3-projects-gantt.md,
 * Task 1), which already passed. project-detail.tsx links here today so that
 * link is honest (a route that exists and says what's coming) rather than a
 * 404 or a link to nowhere. Task 9 replaces this component's body wholesale
 * and keeps the route registration.
 */
export function ProjectGanttPlaceholderPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/gantt" });
  const { data: project } = useProject(projectId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          {"\u2190"} {project?.name ?? "Project"}
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">Gantt</h1>
      </div>
      <div data-testid="gantt-placeholder" className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <p className="text-sm text-slate-500">Gantt arrives in this phase.</p>
      </div>
    </div>
  );
}
