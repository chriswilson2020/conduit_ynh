import { useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Task } from "@conduit/shared";
import { useMe, useMyTasks, useProjects, useSetTaskStatus } from "../queries";
import { TaskDrawer } from "../components/task-drawer";
import { useTaskDrawerFocus } from "../components/task-drawer-focus";
import { ROW_LINK, ROW_LINK_ROW } from "../components/row-link";
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

  const [bannerError, setBannerError] = useState<string | null>(null);

  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const groups = useMemo(() => groupTasks(tasks, todayLocalIso()), [tasks]);

  // replace: true -- same reasoning as task-board.tsx's openTask/closeTask:
  // this stays on /my-tasks and only flips the ?task= param, so a pushed
  // history entry per open/close would make Back reopen/reclose the drawer
  // instead of leaving the page. The OPENING half of that pair now lives on
  // TaskRow's own Link (which carries the same `replace`); only the close is
  // still driven from here, because a drawer's X is not a navigation anyone
  // wants to middle-click.
  //
  // The opening half is also where the drawer's close gets its target: the row
  // anchor records itself, since nothing downstream of the URL can. See
  // components/ui/dialog-focus.ts.
  const returnFocus = useTaskDrawerFocus();

  function closeTask() {
    void navigate({ to: "/my-tasks", search: (prev) => ({ ...prev, task: undefined }), replace: true });
  }

  // Checking marks a task done; unchecking reopens it to "todo" -- My Tasks
  // has no record of whatever status a task held before it was completed
  // (setTaskStatus's own completedAt pairing means that state isn't even
  // preserved server-side), so "todo" is the least-surprising landing spot,
  // same as a fresh task's own default status. onError mirrors the task
  // drawer's reportError: without it, a failed mutation just reverts the
  // checkbox (TanStack Query re-rendering from the un-mutated cache) with no
  // indication anything went wrong.
  function toggleDone(task: Task, checked: boolean) {
    setTaskStatus.mutate(
      { id: task.id, status: checked ? "done" : "todo" },
      {
        onError: (err) => {
          setBannerError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  }

  if (isLoading) return <p>Loading...</p>;

  return (
    <div data-testid="my-tasks" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">My Tasks</h1>
      {bannerError && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          <span>{bannerError}</span>
          <button type="button" onClick={() => setBannerError(null)} className="ml-4 shrink-0 text-red-500 hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}
      {groups.map((group) =>
        group.key === "done" ? (
          <DoneGroup
            key={group.key}
            group={group}
            projectNameById={projectNameById}
            onToggle={toggleDone}
            onOpen={returnFocus.capture}
          />
        ) : (
          <TaskGroupSection
            key={group.key}
            group={group}
            projectNameById={projectNameById}
            onToggle={toggleDone}
            onOpen={returnFocus.capture}
          />
        ),
      )}
      <TaskDrawer taskId={openTaskId ?? null} onClose={closeTask} returnFocus={returnFocus} />
    </div>
  );
}

function TaskGroupSection({
  group,
  projectNameById,
  onToggle,
  onOpen,
}: {
  group: Group;
  projectNameById: Map<string, string>;
  onToggle: (task: Task, checked: boolean) => void;
  onOpen: (trigger: HTMLElement | null) => void;
}) {
  return (
    <section data-testid={`group-${group.key}`}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
        {group.label}
        <span className="text-xs font-normal text-slate-400">{group.tasks.length}</span>
      </h2>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} projectName={projectNameById.get(task.projectId ?? "") ?? null} onToggle={onToggle} onOpen={onOpen} />
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
  onOpen,
}: {
  group: Group;
  projectNameById: Map<string, string>;
  onToggle: (task: Task, checked: boolean) => void;
  onOpen: (trigger: HTMLElement | null) => void;
}) {
  return (
    <details data-testid={`group-${group.key}`}>
      <summary className="mb-2 cursor-pointer text-sm font-semibold text-slate-900">
        {group.label} <span className="text-xs font-normal text-slate-400">{group.tasks.length}</span>
      </summary>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} projectName={projectNameById.get(task.projectId ?? "") ?? null} onToggle={onToggle} onOpen={onOpen} />
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
  onOpen,
}: {
  task: Task;
  projectName: string | null;
  onToggle: (task: Task, checked: boolean) => void;
  /** Hands the drawer's close somewhere to put the caret back. */
  onOpen: (trigger: HTMLElement | null) => void;
}) {
  const overdue = task.dueDate !== null && task.status !== "done" && task.dueDate < todayLocalIso();
  return (
    /*
      BELOW THE BREAKPOINT THE ROW WRAPS ONTO TWO LINES: title first, then the
      project, the date and the type badge under it. On one line at 375px the
      three fixed-width metadata columns (w-32 + w-24 + the badge, plus gaps)
      claim 276px of the 327px content box and leave the title about 24px --
      the one thing on the row that has to be readable.

      The break is forced by the title's flex-basis rather than by a wrapper
      element, because a wrapper would restructure the desktop row as well.
      The subtracted 2rem stands in for the checkbox and its gap, which
      measure 25px together (13 + 12) -- rounded UP deliberately, since the
      basis only has to be too wide to leave room for the next item, and a
      value that undershot would let the project name back onto line one.
    */
    <li
      data-testid={`task-row-${task.id}`}
      className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm text-slate-900 hover:bg-slate-50 max-md:min-h-11 max-md:flex-wrap max-md:py-3 ${ROW_LINK_ROW}`}
    >
      {/*
        LIFTED ABOVE THE ROW LINK'S OVERLAY, which is the one thing this row
        needs that a list of records does not: the checkbox is a real control
        living INSIDE the link's hit area, and without its own stacking the
        overlay swallows every click on it.

        MEASURED WITH elementFromPoint AT THE BOX'S CENTRE, in a real Chromium:
        as shipped it answers the INPUT; with the z-index alone taken off it
        answers the anchor. THE Z-INDEX IS THE LOAD-BEARING HALF -- `relative`
        on its own loses, because the overlay is a positioned box later in tree
        order.

        `relative` IS REDUNDANT TODAY AND KEPT ANYWAY, which is worth saying
        rather than leaving as a puzzle: the same measurement with `position`
        forced back to `static` still answers the INPUT, because a FLEX ITEM's
        z-index creates a stacking context even when it is not positioned. So
        the row being a flex container is what makes the z-index bite. It costs
        nothing (`relative` is already in the stylesheet for other callers) and
        it is what keeps this correct if the row ever stops being flex.

        The stopPropagation this used to carry is gone with the row's onClick.
        It existed to stop a click on the box from also opening the drawer, and
        there is no handler on the row left to stop.
      */}
      <input
        type="checkbox"
        className="relative z-10"
        checked={task.status === "done"}
        onChange={(event) => onToggle(task, event.target.checked)}
        aria-label={`Mark "${task.title}" ${task.status === "done" ? "not done" : "done"}`}
      />
      <span
        className={
          task.status === "done"
            ? "flex-1 text-slate-400 line-through max-md:basis-[calc(100%-2rem)]"
            : "flex-1 max-md:basis-[calc(100%-2rem)]"
        }
      >
        {/*
          THE DRAWER IS A URL, so the row that opens it is a link like any
          other -- `?task=<id>` is already a deep link this route validates, so
          this one can be middle-clicked or opened in a new tab and lands with
          the drawer open. `replace` keeps the history behaviour the removed
          openTask had: Back leaves My Tasks rather than closing the drawer.

          Only the TITLE is inside the anchor. The project, the date and the
          type badge stay row content, so the link announces "Ship the thing,
          link" instead of reading four columns out as one name.
        */}
        {/* The anchor is also what the drawer's close hands the caret back
            to, so it records itself on the way in -- see the page's onOpen and
            components/ui/dialog-focus.ts. A middle-click or a new tab never
            reaches this, which is correct: neither opens a drawer here. */}
        <Link
          to="/my-tasks"
          search={(prev) => ({ ...prev, task: task.id })}
          replace
          onClick={(event) => onOpen(event.currentTarget)}
          {...ROW_LINK}
        >
          {task.title}
        </Link>
      </span>
      <span className="w-32 shrink-0 truncate text-xs text-slate-500 max-md:w-auto">{projectName ?? "\u2014"}</span>
      <span
        className={
          overdue
            ? "w-24 shrink-0 text-xs font-medium text-red-600 max-md:w-auto"
            : "w-24 shrink-0 text-xs text-slate-400 max-md:w-auto"
        }
      >
        {task.dueDate ?? "\u2014"}
      </span>
      {/*
        THIS BADGE'S TOOLTIP IS THE ONE THING THE ROW LINK COSTS, and it is a
        choice rather than an oversight. Measured the same way as the checkbox
        above: elementFromPoint at the badge's centre answers the ANCHOR, so
        the browser resolves `title` from the anchor's ancestors and finds
        none -- this hint no longer appears on hover.

        Lifting the badge the way the checkbox is lifted would give the tooltip
        back and put a dead 16px square at the end of a row that is tappable
        end to end today. A hover hint at a desk is worth less than a whole row
        that opens the task under a thumb, so the badge stays under the link.
        The attribute is left in place: it is still the field's name for
        anything that reads the DOM, and it costs nothing.
      */}
      <span
        title={TYPE_LABEL[task.type]}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-slate-200 text-[10px] font-semibold text-slate-600"
      >
        {TYPE_BADGE[task.type]}
      </span>
    </li>
  );
}
