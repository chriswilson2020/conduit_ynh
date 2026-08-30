import { useMemo, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Task, TaskStatus, TaskType } from "@conduit/shared";
import { useBoardMoveTask, useCreateTask, useProject, useSetTaskStatus, useTasks, useUsers } from "../queries";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { TaskDrawer } from "../components/task-drawer";
import { useTaskDrawerFocus } from "../components/task-drawer-focus";
import {
  KanbanEmptyPlaceholder, kanbanSortableItems, useKanbanBoard, useKanbanCardSortable, useKanbanColumnDroppable,
} from "../components/kanban-core";
import { todayLocalIso, userLabel } from "../lib";

// Fixed status columns, not stages (per the design's task board: kanban
// machinery reused with a fixed column set instead of a per-pipeline one).
// Exported: the task drawer (Task 8) and My Tasks reuse these same labels/
// badges rather than redefining them, so a status/type's wording only ever
// lives in one place.
export const STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done",
};
export const TYPE_BADGE: Record<TaskType, string> = { task: "T", call: "C", meeting: "M", email: "E", deadline: "D" };
export const TYPE_LABEL: Record<TaskType, string> = {
  task: "Task", call: "Call", meeting: "Meeting", email: "Email", deadline: "Deadline",
};
export const TASK_TYPES: TaskType[] = ["task", "call", "meeting", "email", "deadline"];

export function TaskBoardPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/board" });
  // `?task=<id>` deep-links straight to the drawer (Task 8's plan: read on
  // mount, open, clear on close) -- the URL is the single source of truth
  // for which task is open, so a card click and a search-result navigation
  // both just set this same param rather than a separate local state that
  // could drift from it.
  const { task: openTaskId } = useSearch({ from: "/projects/$projectId/board" });
  const navigate = useNavigate();
  const { data: project } = useProject(projectId);
  const { data: tasks = [], isLoading } = useTasks({ projectId });
  const { data: users = [] } = useUsers();
  const boardMoveTask = useBoardMoveTask();

  // replace: true -- these two stay on THIS route and only flip the ?task=
  // param, so pushing a history entry per open/close would mean Back doesn't
  // leave the board, it just reopens/recloses the drawer. Contrast with
  // search.tsx's task-result navigation, which lands on a DIFFERENT route
  // (this board, or My Tasks) and deliberately stays a push -- that one's a
  // real navigation a user expects Back to undo.
  //
  // The drawer's close needs the card back, and only the card knows which card
  // it was -- so the capture happens in the handler that opens the drawer, not
  // inside it. components/ui/dialog-focus.ts says why that is the only place
  // it can happen.
  const returnFocus = useTaskDrawerFocus();

  function openTask(id: string, trigger: HTMLElement | null) {
    returnFocus.capture(trigger);
    void navigate({
      to: "/projects/$projectId/board", params: { projectId }, search: (prev) => ({ ...prev, task: id }), replace: true,
    });
  }
  function closeTask() {
    void navigate({
      to: "/projects/$projectId/board", params: { projectId }, search: (prev) => ({ ...prev, task: undefined }), replace: true,
    });
  }

  const userInitials = useMemo(
    () => new Map(users.map((user) => [user.id, userLabel(user, "").slice(0, 1).toUpperCase()])),
    [users],
  );

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const status of STATUSES) map.set(status, []);
    for (const task of tasks) {
      const list = map.get(task.status) ?? [];
      list.push(task);
      map.set(task.status, list);
    }
    // position is a fractional string, COLLATE C server-side -- plain string
    // comparison (< / >) matches, mirroring board.tsx's own deal sort.
    for (const list of map.values()) {
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    }
    return map;
  }, [tasks]);

  // Ids-only projection of `grouped`, the shape kanban-core's drag machinery
  // needs -- see useKanbanBoard's own doc comment on itemsByColumn.
  const itemsByColumn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const status of STATUSES) map.set(status, (grouped.get(status) ?? []).map((task) => task.id));
    return map;
  }, [grouped]);

  const { activeId, suppressCardClickRef, sensors, dndProps } = useKanbanBoard({
    itemsByColumn,
    onMove: (params) => {
      boardMoveTask.mutate({
        id: params.id, projectId, status: params.columnId as TaskStatus,
        beforeTaskId: params.beforeId, afterTaskId: params.afterId,
      });
    },
  });
  const activeTask = activeId !== null ? (tasks.find((task) => task.id === activeId) ?? null) : null;

  if (isLoading) return <p>Loading...</p>;

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
        <h1 className="text-xl font-semibold text-slate-900">Task board</h1>
      </div>

      <DndContext sensors={sensors} {...dndProps}>
        <div data-testid="board" className="flex items-start gap-4 overflow-x-auto pb-4">
          {STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={grouped.get(status) ?? []}
              projectId={projectId}
              userInitials={userInitials}
              suppressCardClickRef={suppressCardClickRef}
              onCardClick={openTask}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="flex flex-col gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 shadow-lg">
              <TaskCardContent
                task={activeTask}
                ownerInitial={activeTask.assigneeUserId ? userInitials.get(activeTask.assigneeUserId) : undefined}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <TaskDrawer taskId={openTaskId ?? null} onClose={closeTask} returnFocus={returnFocus} />
    </div>
  );
}

function Column({
  status,
  tasks,
  projectId,
  userInitials,
  suppressCardClickRef,
  onCardClick,
}: {
  status: TaskStatus;
  tasks: Task[];
  projectId: string;
  userInitials: Map<string, string>;
  suppressCardClickRef: RefObject<boolean>;
  onCardClick: (id: string, trigger: HTMLElement | null) => void;
}) {
  const { setNodeRef } = useKanbanColumnDroppable(status);
  const taskIds = tasks.map((task) => task.id);
  const sortableItems = kanbanSortableItems(status, taskIds);

  return (
    <div data-testid={`column-${status}`} className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-slate-100 p-2">
      <div className="px-1">
        <h2 className="text-sm font-semibold text-slate-900">{STATUS_LABEL[status]}</h2>
        <div className="mt-0.5 text-xs text-slate-500">{tasks.length}</div>
      </div>
      <div ref={setNodeRef} className="flex min-h-8 flex-1 flex-col gap-2">
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              ownerInitial={task.assigneeUserId ? userInitials.get(task.assigneeUserId) : undefined}
              suppressCardClickRef={suppressCardClickRef}
              onClick={onCardClick}
            />
          ))}
          {tasks.length === 0 && <KanbanEmptyPlaceholder columnId={status} label="No tasks" />}
        </SortableContext>
      </div>
      <NewTaskButton projectId={projectId} status={status} />
    </div>
  );
}

function TaskCard({
  task,
  ownerInitial,
  suppressCardClickRef,
  onClick,
}: {
  task: Task;
  ownerInitial?: string;
  suppressCardClickRef: RefObject<boolean>;
  onClick: (id: string, trigger: HTMLElement | null) => void;
}) {
  const { attributes, listeners, setNodeRef, style } = useKanbanCardSortable(task.id, task.status);

  // Opens the task drawer (Task 8) via the ?task= query param -- see
  // TaskBoardPage's openTask. suppressCardClickRef still has to be checked
  // here regardless of what the click does, since dnd-kit's drop gesture can
  // still fire a trailing native click event (see kanban-core's
  // useKanbanBoard doc comment on suppressCardClickRef).
  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (suppressCardClickRef.current) return;
    onClick(task.id, event.currentTarget);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`card-${task.id}`}
      onClick={handleClick}
      className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
      {...attributes}
      {...listeners}
    >
      <TaskCardContent task={task} ownerInitial={ownerInitial} />
    </div>
  );
}

// Shared between the resting card above and the DragOverlay ghost, so the
// overlay -- which has no ownerInitial context of its own beyond what's
// passed in -- still shows the same content as the card it's standing in for.
function TaskCardContent({ task, ownerInitial }: { task: Task; ownerInitial?: string }) {
  const overdue = task.dueDate !== null && task.status !== "done" && task.dueDate < todayLocalIso();

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{task.title}</span>
        <span
          title={TYPE_LABEL[task.type]}
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-slate-200 text-[10px] font-semibold text-slate-600"
        >
          {TYPE_BADGE[task.type]}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className={overdue ? "text-xs font-medium text-red-600" : "text-xs text-slate-400"}>
          {task.dueDate ?? ""}
        </span>
        {ownerInitial && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[10px] font-semibold text-white">
            {ownerInitial}
          </span>
        )}
      </div>
    </>
  );
}

function NewTaskButton({ projectId, status }: { projectId: string; status: TaskStatus }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">
          New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <NewTaskDialog projectId={projectId} status={status} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewTaskDialog({
  projectId,
  status,
  onClose,
}: {
  projectId: string;
  status: TaskStatus;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const createTask = useCreateTask();
  const setTaskStatus = useSetTaskStatus();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "") return;
    createTask.mutate(
      { title: trimmed, projectId },
      {
        onSuccess: (task) => {
          // createTask always lands a new task in the default "todo" status
          // (see services/tasks.ts) -- a column other than todo needs one
          // more call to actually preset it, mirroring the plan's "status
          // preset" per-column dialog. Accepted tradeoff: this is two round
          // trips, so a task created from e.g. the "Blocked" column can
          // render in the "To do" column for one refetch before the status
          // call lands -- if that flicker ever grates, the real fix is
          // letting createTask accept an initial status server-side rather
          // than working around it here.
          if (status !== "todo") setTaskStatus.mutate({ id: task.id, status });
          onClose();
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>New task</DialogTitle>
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Task title"
        disabled={createTask.isPending}
      />
      {createTask.isError && <p className="text-sm text-red-600">{createTask.error.message}</p>}
      <Button type="submit" disabled={title.trim() === "" || createTask.isPending}>
        Create
      </Button>
    </form>
  );
}
