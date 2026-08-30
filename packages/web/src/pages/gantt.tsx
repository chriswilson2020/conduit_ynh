import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useProject } from "../queries";
import { GanttChart } from "../components/gantt/chart";
import { TaskDrawer } from "../components/task-drawer";
import { useDialogReturnFocus } from "../components/ui/dialog-focus";

/**
 * The real Gantt (Task 9), replacing project-gantt-placeholder.tsx (deleted
 * by this task) for `/projects/$projectId/gantt`, and adding the global
 * `/gantt` route the plan calls for. Both pages are thin: fetch/format the
 * page chrome (back link, heading), render <GanttChart>, and own the
 * `?task=` deep link into TaskDrawer -- exactly task-board.tsx's
 * openTask/closeTask pattern (replace: true, since opening/closing the
 * drawer stays on this same route rather than pushing a history entry per
 * toggle).
 */
export function ProjectGanttPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/gantt" });
  const { task: openTaskId } = useSearch({ from: "/projects/$projectId/gantt" });
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);

  const returnFocus = useDialogReturnFocus();

  function openTask(id: string, trigger: HTMLElement | null) {
    returnFocus.capture(trigger);
    void navigate({
      to: "/projects/$projectId/gantt", params: { projectId }, search: (prev) => ({ ...prev, task: id }), replace: true,
    });
  }
  function closeTask() {
    void navigate({
      to: "/projects/$projectId/gantt", params: { projectId }, search: (prev) => ({ ...prev, task: undefined }), replace: true,
    });
  }

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
      <GanttChart target={{ projectId }} onOpenTask={openTask} />
      <TaskDrawer taskId={openTaskId ?? null} onClose={closeTask} returnFocus={returnFocus} />
    </div>
  );
}

export function GlobalGanttPage() {
  const { task: openTaskId } = useSearch({ from: "/gantt" });
  const navigate = useNavigate();

  const returnFocus = useDialogReturnFocus();

  function openTask(id: string, trigger: HTMLElement | null) {
    returnFocus.capture(trigger);
    void navigate({ to: "/gantt", search: (prev) => ({ ...prev, task: id }), replace: true });
  }
  function closeTask() {
    void navigate({ to: "/gantt", search: (prev) => ({ ...prev, task: undefined }), replace: true });
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Gantt</h1>
      <GanttChart target={{ global: true }} onOpenTask={openTask} />
      <TaskDrawer taskId={openTaskId ?? null} onClose={closeTask} returnFocus={returnFocus} />
    </div>
  );
}
