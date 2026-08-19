import { useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Task } from "@conduit/shared";
import { useMe, useMyTasks, useProjects, useSetTaskStatus } from "../queries";
import { TaskDrawer } from "../components/task-drawer";
import { TYPE_BADGE, TYPE_LABEL } from "./task-board";
import { todayLocalIso } from "../lib";

interface Group {
  key: string;
  label: string;
  tasks: Task[];
}

/**
 * Everything assigned to the current user, grouped by due date the way the
 * plan lays out: Overdue / Today / Upcoming / Undated, each showing only
 * NOT-done tasks, plus every done task (regardless of date) collected into
 * a collapsed Done group at the end -- a finished task shouldn't clutter the
 * groups someone actually works from day to day, but should stay a click
 * away rather than vanishing from the page entirely.
 */
function groupTasks(tasks: Task[], today: string): Group[] {
  const overdue: Task[] = [];
  const dueToday: Task[] = [];
  const upcoming: Task[] = [];
  const undated: Task[] = [];
  const done: Task[] = [];

  for (const task of tasks) {
    if (task.status === "done") {
      done.push(task);
    } else if (task.dueDate === null) {
      undated.push(task);
    } else if (task.dueDate < today) {
      overdue.push(task);
    } else if (task.dueDate === today) {
      dueToday.push(task);
    } else {
      upcoming.push(task);
    }
  }

  // Each active group sorts by due date (undated has none to sort by, so it
  // keeps the server's own ordering); done sorts most-recently-completed
  // first so the collapsed group's few visible rows (before it's expanded)
  // are the ones most likely to be relevant.
  const byDueDate = (a: Task, b: Task) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
  overdue.sort(byDueDate);
  dueToday.sort(byDueDate);
  upcoming.sort(byDueDate);
  done.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return [
    { key: "overdue", label: "Overdue", tasks: overdue },
    { key: "today", label: "Today", tasks: dueToday },
    { key: "upcoming", label: "Upcoming", tasks: upcoming },
    { key: "undated", label: "Undated", tasks: undated },
    { key: "done", label: "Done", tasks: done },
  ];
}

export function MyTasksPage() {
  const { task: openTaskId } = useSearch({ from: "/my-tasks" });
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: tasks = [], isLoading } = useMyTasks(me?.id ?? "");
  const { data: projects = [] } = useProjects();
  const setTaskStatus = useSetTaskStatus();

  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const groups = useMemo(() => groupTasks(tasks, todayLocalIso()), [tasks]);

  function openTask(id: string) {
    void navigate({ to: "/my-tasks", search: (prev) => ({ ...prev, task: id }) });
  }
  function closeTask() {
    void navigate({ to: "/my-tasks", search: (prev) => ({ ...prev, task: undefined }) });
  }

  // Checking marks a task done; unchecking reopens it to "todo" -- My Tasks
  // has no record of whatever status a task held before it was completed
  // (setTaskStatus's own completedAt pairing means that state isn't even
  // preserved server-side), so "todo" is the least-surprising landing spot,
  // same as a fresh task's own default status.
  function toggleDone(task: Task, checked: boolean) {
    setTaskStatus.mutate({ id: task.id, status: checked ? "done" : "todo" });
  }

  if (isLoading) return <p>Loading...</p>;

  return (
    <div data-testid="my-tasks" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">My Tasks</h1>
      {groups.map((group) =>
        group.key === "done" ? (
          <DoneGroup
            key={group.key}
            group={group}
            projectNameById={projectNameById}
            onToggle={toggleDone}
            onRowClick={openTask}
          />
        ) : (
          <TaskGroupSection
            key={group.key}
            group={group}
            projectNameById={projectNameById}
            onToggle={toggleDone}
            onRowClick={openTask}
          />
        ),
      )}
      <TaskDrawer taskId={openTaskId ?? null} onClose={closeTask} />
    </div>
  );
}

function TaskGroupSection({
  group,
  projectNameById,
  onToggle,
  onRowClick,
}: {
  group: Group;
  projectNameById: Map<string, string>;
  onToggle: (task: Task, checked: boolean) => void;
  onRowClick: (id: string) => void;
}) {
  return (
    <section data-testid={`group-${group.key}`}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
        {group.label}
        <span className="text-xs font-normal text-slate-400">{group.tasks.length}</span>
      </h2>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} projectName={projectNameById.get(task.projectId ?? "") ?? null} onToggle={onToggle} onRowClick={onRowClick} />
        ))}
        {group.tasks.length === 0 && <li className="px-4 py-2 text-sm text-slate-400">Nothing here</li>}
      </ul>
    </section>
  );
}

// A native <details>/<summary> keeps the collapse state entirely in the DOM
// (no useState needed) and stays keyboard/screen-reader accessible for free
// -- the same reason the plan calls for the Done group to start collapsed
// rather than just sorted to the bottom.
function DoneGroup({
  group,
  projectNameById,
  onToggle,
  onRowClick,
}: {
  group: Group;
  projectNameById: Map<string, string>;
  onToggle: (task: Task, checked: boolean) => void;
  onRowClick: (id: string) => void;
}) {
  return (
    <details data-testid={`group-${group.key}`}>
      <summary className="mb-2 cursor-pointer text-sm font-semibold text-slate-900">
        {group.label} <span className="text-xs font-normal text-slate-400">{group.tasks.length}</span>
      </summary>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} projectName={projectNameById.get(task.projectId ?? "") ?? null} onToggle={onToggle} onRowClick={onRowClick} />
        ))}
        {group.tasks.length === 0 && <li className="px-4 py-2 text-sm text-slate-400">Nothing here</li>}
      </ul>
    </details>
  );
}

function TaskRow({
  task,
  projectName,
  onToggle,
  onRowClick,
}: {
  task: Task;
  projectName: string | null;
  onToggle: (task: Task, checked: boolean) => void;
  onRowClick: (id: string) => void;
}) {
  const overdue = task.dueDate !== null && task.status !== "done" && task.dueDate < todayLocalIso();
  return (
    <li
      data-testid={`task-row-${task.id}`}
      className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm text-slate-900 hover:bg-slate-50"
      onClick={() => onRowClick(task.id)}
    >
      <input
        type="checkbox"
        checked={task.status === "done"}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggle(task, event.target.checked)}
        aria-label={`Mark "${task.title}" ${task.status === "done" ? "not done" : "done"}`}
      />
      <span className={task.status === "done" ? "flex-1 text-slate-400 line-through" : "flex-1"}>{task.title}</span>
      <span className="w-32 shrink-0 truncate text-xs text-slate-500">{projectName ?? "\u2014"}</span>
      <span className={overdue ? "w-24 shrink-0 text-xs font-medium text-red-600" : "w-24 shrink-0 text-xs text-slate-400"}>
        {task.dueDate ?? "\u2014"}
      </span>
      <span
        title={TYPE_LABEL[task.type]}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-slate-200 text-[10px] font-semibold text-slate-600"
      >
        {TYPE_BADGE[task.type]}
      </span>
    </li>
  );
}
