import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Company, Contact, Deal, Project, Task, TaskStatus, TaskType } from "@conduit/shared";
import { taskDatesPaired } from "@conduit/shared";
import { ApiError } from "../api";
import {
  useAddDependency,
  useArchiveTask,
  useCompany,
  useContact,
  useDeal,
  useProject,
  useRemoveDependency,
  useSetTaskStatus,
  useTask,
  useTaskDependencies,
  useTasks,
  useUnarchiveTask,
  useUpdateTask,
} from "../queries";
import { STATUSES, STATUS_LABEL, TASK_TYPES, TYPE_LABEL } from "../pages/task-board";
import { FieldCard, type FieldCardField } from "./field-card";
import { OwnerSelect } from "./owner-select";
import { Timeline } from "./rail/timeline";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogTitle, DrawerContent } from "./ui/dialog";
import type { DialogReturnFocus } from "./ui/dialog-focus";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface TaskDrawerProps {
  /** null keeps the Dialog mounted but closed -- see DrawerContent's own doc
   * comment for why Radix's `open` prop, not an unmount, drives visibility. */
  taskId: string | null;
  onClose: () => void;
  /**
   * Where the caret goes when this closes. REQUIRED, and owned by the page
   * rather than by this component, because the capture has to happen in the
   * handler of whatever opened the drawer -- a card on the task board, a row on
   * My Tasks, a bar on the Gantt -- and that handler is the page's. Required so
   * that a new mount site is a type error rather than a silent landing on
   * `<main>`. See components/ui/dialog-focus.ts.
   */
  returnFocus: DialogReturnFocus;
}

/**
 * Right-side task detail panel, opened from the task board, My Tasks, or a
 * search result (Task 8). `taskId` is expected to be sourced from a `?task=`
 * query param by the caller (task-board.tsx / my-tasks.tsx) so a deep link
 * opens straight to this drawer -- this component itself is agnostic to
 * where the id came from, it just renders (or doesn't) based on it.
 */
export function TaskDrawer({ taskId, onClose, returnFocus }: TaskDrawerProps) {
  /**
   * WHERE THE CARET GOES WHEN THIS CLOSES, which Radix cannot answer for a
   * drawer opened this way -- see components/ui/dialog-focus.ts for the
   * mechanism and for what was measured here before it existed (`<body>`, at
   * 1280 and at 390).
   *
   * THE `?task=` DEEP LINK IS THE CASE THAT DECIDED THE DESIGN: an element
   * cannot travel through a URL, so a drawer opened on page load has no opener
   * at all and lands on the fallback. That is asserted rather than assumed.
   */
  return (
    <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DrawerContent data-testid="task-drawer" onCloseAutoFocus={returnFocus.restore}>
        {taskId !== null && <TaskDrawerBody taskId={taskId} returnFocus={returnFocus} />}
      </DrawerContent>
    </Dialog>
  );
}

function buildTaskPatch(name: string, value: string): Record<string, unknown> {
  const trimmed = value.trim();
  switch (name) {
    case "title":
      return { title: trimmed };
    case "description":
      return { description: trimmed === "" ? null : trimmed };
    default:
      return {};
  }
}

function TaskDrawerBody({ taskId, returnFocus }: { taskId: string; returnFocus: DialogReturnFocus }) {
  const { data: task, isLoading, error } = useTask(taskId);
  const { data: linkedProject } = useProject(task?.projectId ?? "");
  const { data: linkedCompany } = useCompany(task?.companyId ?? "");
  const { data: linkedContact } = useContact(task?.contactId ?? "");
  const { data: linkedDeal } = useDeal(task?.dealId ?? "");

  const updateTask = useUpdateTask();
  const setTaskStatus = useSetTaskStatus();
  const archiveTask = useArchiveTask();
  const unarchiveTask = useUnarchiveTask();

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  // Paired date drafts -- reset from the fetched task whenever the drawer
  // switches to a different task (or the task's own dates change under it,
  // e.g. a shift cascade landing on it elsewhere), never on every render.
  const [startDraft, setStartDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  // Progress commits on blur, not on every keystroke, mirroring the pairing
  // rationale above -- a bare number input's onChange fires once per
  // keystroke, and a mutate-per-digit would be both noisy and, mid-edit
  // (e.g. the moment "1" is typed on the way to "15"), a needless write of a
  // value the user hasn't finished entering.
  const [progressDraft, setProgressDraft] = useState("");

  useEffect(() => {
    setStartDraft(task?.startDate ?? "");
    setDueDraft(task?.dueDate ?? "");
    setProgressDraft(task?.progressPct?.toString() ?? "");
  }, [task?.id, task?.startDate, task?.dueDate, task?.progressPct]);

  // Mirrors deal-detail.tsx/project-detail.tsx's reportError: ApiError.code
  // is the server's machine-readable field, branched on so an "archived" 409
  // rewords into an actionable hint rather than the generic interpolated
  // message every other error falls through to.
  function reportError(err: unknown) {
    if (err instanceof ApiError && err.code === "archived") {
      setBannerError("This task is archived. Unarchive it to make changes.");
      return;
    }
    setBannerError(err instanceof Error ? err.message : String(err));
  }

  function handleSave(name: string, value: string) {
    if (!task) return;
    setSavingField(name);
    updateTask.mutate(
      { id: task.id, patch: buildTaskPatch(name, value) },
      {
        onSuccess: () => setSavingField(null),
        onError: (err) => {
          setSavingField(null);
          reportError(err);
        },
      },
    );
  }

  function handleTypeChange(type: TaskType) {
    if (!task) return;
    updateTask.mutate({ id: task.id, patch: { type } }, { onError: reportError });
  }

  /**
   * TWO OF THIS DRAWER'S OWN ACTIONS RETIRE THE CARD IT WAS OPENED FROM, and
   * both leave the drawer standing, so the user closes it themselves at a
   * moment nobody can predict.
   *
   * A status change moves the card to a different column, which is a different
   * parent and therefore an unmount; an archive takes it off the board
   * altogether. Neither mutation is optimistic (queries.ts's useSetTaskStatus
   * and useArchiveTask invalidate on success), so there is a real window
   * between the click and the refetch -- and closing inside it was MEASURED
   * landing on the card, which then unmounted, leaving `<body>`. Wait for the
   * refetch first and `isConnected` catches it; do not wait and nothing does.
   *
   * So the drawer says so instead of hoping. `forget()` is unconditional rather
   * than conditional on the new status: a card that stays in its column is
   * reconciled in place and would still be a fine target, but distinguishing
   * the two means predicting React's reconciliation from here, and landing on
   * the page's content is not a bad outcome for a task the user just changed.
   */
  function handleStatusChange(status: TaskStatus) {
    if (!task) return;
    returnFocus.forget();
    setTaskStatus.mutate({ id: task.id, status }, { onError: reportError });
  }

  function handleOwnerChange(userId: string | null) {
    if (!task) return;
    updateTask.mutate(
      { id: task.id, patch: { assigneeUserId: userId }, previousAssigneeUserId: task.assigneeUserId },
      { onError: reportError },
    );
  }

  function handleProgressBlur() {
    if (!task) return;
    const trimmed = progressDraft.trim();
    if (trimmed === "") {
      if (task.progressPct !== null) updateTask.mutate({ id: task.id, patch: { progressPct: null } }, { onError: reportError });
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      setProgressDraft(task.progressPct?.toString() ?? "");
      return;
    }
    const progressPct = Math.max(0, Math.min(100, Math.round(parsed)));
    if (progressPct !== task.progressPct) updateTask.mutate({ id: task.id, patch: { progressPct } }, { onError: reportError });
  }

  // Both dates cleared, or both set with start <= due -- taskDatesPaired is
  // the exact same invariant updateTaskInputSchema's .refine enforces
  // server-side (@conduit/shared), reused here so the inline hint and the
  // Save button's disabled state agree with what the server will actually
  // accept, instead of drifting from it.
  const datesPaired = taskDatesPaired({
    startDate: startDraft === "" ? null : startDraft,
    dueDate: dueDraft === "" ? null : dueDraft,
  });
  const datesDirty = task !== undefined && task !== null
    && (startDraft !== (task.startDate ?? "") || dueDraft !== (task.dueDate ?? ""));

  function handleSaveDates() {
    if (!task || !datesPaired) return;
    updateTask.mutate(
      {
        id: task.id,
        patch: {
          startDate: startDraft === "" ? null : startDraft,
          dueDate: dueDraft === "" ? null : dueDraft,
        },
      },
      { onError: reportError },
    );
  }

  /** Takes the card off the board -- see handleStatusChange for the window. */
  function handleArchive() {
    if (!task) return;
    if (!window.confirm(`Archive ${task.title}?`)) return;
    returnFocus.forget();
    archiveTask.mutate(task.id, { onError: reportError });
  }

  function handleUnarchive() {
    if (!task) return;
    unarchiveTask.mutate(task.id, { onError: reportError });
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-slate-400">Loading...</p>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <DialogTitle>Task not found</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" aria-label="Close">{"\u2715"}</Button>
          </DialogClose>
        </div>
        <p role="alert" className="text-sm text-red-600">
          {error instanceof Error ? error.message : "Could not load this task."}
        </p>
      </div>
    );
  }

  const archived = task.archivedAt !== null;
  const fields: FieldCardField[] = [
    { name: "title", label: "Title", value: task.title, editable: true },
    { name: "description", label: "Description", value: task.description, editable: true, multiline: true },
  ];

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-2">
        <DialogTitle>{task.title}</DialogTitle>
        <DialogClose asChild>
          <Button variant="ghost" aria-label="Close">{"\u2715"}</Button>
        </DialogClose>
      </div>

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

      <FieldCard
        fields={fields}
        onSave={handleSave}
        archived={archived}
        onUnarchive={handleUnarchive}
        savingField={savingField}
      />

      <Field label="Type" testId="type">
        <Select value={task.type} onValueChange={(next) => handleTypeChange(next as TaskType)} disabled={archived}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_TYPES.map((type) => (
              <SelectItem key={type} value={type}>{TYPE_LABEL[type]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Status" testId="status">
        <Select value={task.status} onValueChange={(next) => handleStatusChange(next as TaskStatus)} disabled={archived}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>{STATUS_LABEL[status]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Assignee" testId="assigneeUserId">
        <OwnerSelect value={task.assigneeUserId} onChange={handleOwnerChange} disabled={archived} />
      </Field>

      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
        <span className="text-sm font-medium text-slate-500">Dates</span>
        {/*
          Two date pickers, an arrow and Save on one line need more width than
          a phone has; wrapping puts Save under the pair rather than squeezing
          a native date control until it drops its own segments. Task 5 opens
          this drawer from a Gantt bar, so this row is the phone's ONLY way to
          reschedule -- it has to survive the narrow case.
        */}
        <div data-testid="field-dates" className="mt-2 flex items-center gap-2 max-md:flex-wrap">
          <input
            type="date"
            aria-label="Start date"
            value={startDraft}
            onChange={(event) => setStartDraft(event.target.value)}
            disabled={archived}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 max-md:min-h-11"
          />
          {/* Decorative, and only meaningful while the two fields share a
              line -- once the row wraps it is an arrow pointing at nothing.
              Both inputs keep their aria-labels, so nothing is lost. */}
          <span className="text-slate-400 max-md:hidden">{"\u2192"}</span>
          <input
            type="date"
            aria-label="Due date"
            value={dueDraft}
            onChange={(event) => setDueDraft(event.target.value)}
            disabled={archived}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 max-md:min-h-11"
          />
          <Button onClick={handleSaveDates} disabled={archived || !datesPaired || !datesDirty}>
            Save
          </Button>
        </div>
        {!datesPaired && (
          <p className="mt-1 text-xs text-red-600">Set both a start and a due date, or clear both.</p>
        )}
      </div>

      <Field label="Progress" testId="progressPct">
        <input
          type="number"
          min={0}
          max={100}
          value={progressDraft}
          onChange={(event) => setProgressDraft(event.target.value)}
          onBlur={handleProgressBlur}
          disabled={archived}
          className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 max-md:min-h-11"
        />
        <span className="ml-2 text-sm text-slate-400">%</span>
      </Field>

      <Field label="Project" testId="projectId">
        <ProjectLink id={task.projectId} project={linkedProject} />
      </Field>
      <Field label="Company" testId="companyId">
        <CompanyLink id={task.companyId} company={linkedCompany} />
      </Field>
      <Field label="Contact" testId="contactId">
        <ContactLink id={task.contactId} contact={linkedContact} />
      </Field>
      <Field label="Deal" testId="dealId">
        <DealLink id={task.dealId} deal={linkedDeal} />
      </Field>

      <DependenciesSection task={task} archived={archived} />

      {!archived && (
        <Button variant="danger" onClick={handleArchive}>
          Archive
        </Button>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Activity</h2>
        <Timeline taskId={task.id} />
      </section>
    </div>
  );
}

/** One label+value row, mirroring deal-detail.tsx/project-detail.tsx's
 * repeated block markup (a labelled row below FieldCard, for fields that
 * aren't a plain inline-editable string). */
function Field({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <span className="w-24 shrink-0 text-sm font-medium text-slate-500">{label}</span>
      <div data-testid={`field-${testId}`} className="min-w-0 flex-1 break-words text-sm text-slate-900">
        {children}
      </div>
    </div>
  );
}

// A task's entity link fields (project/company/contact/deal) are all
// optional and follow the exact same three-state rendering deal-detail.tsx/
// project-detail.tsx already established: no id -> em dash, id present but
// the linked record hasn't loaded yet -> ellipsis, loaded -> a clickable
// Link. Written as four small concrete components (one per target route)
// rather than one generic component parameterised over `to` -- the router's
// route-typed `to`/`params` pairing doesn't generalise across routes without
// an unsound cast, and four short components reads no worse than one longer
// one plus that cast.
function ProjectLink({ id, project }: { id: string | null; project: Project | undefined }) {
  if (id === null) return <span>{"\u2014"}</span>;
  if (!project) return <span>{"\u2026"}</span>;
  return (
    <Link to="/projects/$projectId" params={{ projectId: id }} className="text-slate-900 underline hover:text-slate-700">
      {project.name}
    </Link>
  );
}

function CompanyLink({ id, company }: { id: string | null; company: Company | undefined }) {
  if (id === null) return <span>{"\u2014"}</span>;
  if (!company) return <span>{"\u2026"}</span>;
  return (
    <Link to="/companies/$companyId" params={{ companyId: id }} className="text-slate-900 underline hover:text-slate-700">
      {company.name}
    </Link>
  );
}

function ContactLink({ id, contact }: { id: string | null; contact: Contact | undefined }) {
  if (id === null) return <span>{"\u2014"}</span>;
  if (!contact) return <span>{"\u2026"}</span>;
  return (
    <Link to="/contacts/$contactId" params={{ contactId: id }} className="text-slate-900 underline hover:text-slate-700">
      {contact.firstName} {contact.lastName ?? ""}
    </Link>
  );
}

function DealLink({ id, deal }: { id: string | null; deal: Deal | undefined }) {
  if (id === null) return <span>{"\u2014"}</span>;
  if (!deal) return <span>{"\u2026"}</span>;
  return (
    <Link to="/deals/$dealId" params={{ dealId: id }} className="text-slate-900 underline hover:text-slate-700">
      {deal.title}
    </Link>
  );
}

/**
 * Predecessors list (remove button each) + an "Add dependency" select of
 * same-pool tasks (same project, or both standalone -- addDependency's own
 * rule, services/tasks.ts), excluding this task itself and its existing
 * predecessors. Done predecessors are deliberately NOT excluded -- a
 * finished predecessor is still a legal (if inert) dependency, per the
 * plan.
 */
function DependenciesSection({ task, archived }: { task: Task; archived: boolean }) {
  const { data: dependencies = [] } = useTaskDependencies(task.id);
  const { data: poolTasks = [] } = useTasks(
    task.projectId !== null ? { projectId: task.projectId } : { standalone: true },
  );
  const removeDependency = useRemoveDependency();
  const addDependency = useAddDependency();
  const [selected, setSelected] = useState("");

  const titleById = useMemo(() => new Map(poolTasks.map((t) => [t.id, t.title])), [poolTasks]);
  const existingIds = useMemo(() => new Set(dependencies.map((d) => d.predecessorId)), [dependencies]);
  const candidates = useMemo(
    () => poolTasks.filter((t) => t.id !== task.id && !existingIds.has(t.id)),
    [poolTasks, task.id, existingIds],
  );

  function handleAdd() {
    if (selected === "") return;
    addDependency.mutate(
      { predecessorId: selected, successorId: task.id },
      { onSuccess: () => setSelected("") },
    );
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-900">Dependencies</h2>
      <ul data-testid="dependency-list" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {dependencies.map((dep) => (
          <li key={dep.id} className="flex items-center justify-between px-4 py-2 text-sm text-slate-900">
            <span>{titleById.get(dep.predecessorId) ?? dep.predecessorId}</span>
            {!archived && (
              <Button
                variant="ghost"
                onClick={() => removeDependency.mutate({ predecessorId: dep.predecessorId, successorId: task.id })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
        {dependencies.length === 0 && <li className="px-4 py-2 text-sm text-slate-400">No dependencies</li>}
      </ul>
      {!archived && (
        <div className="mt-2 flex items-center gap-2">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue placeholder="Add dependency..." />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={handleAdd} disabled={selected === "" || addDependency.isPending}>
            Add
          </Button>
        </div>
      )}
      {addDependency.isError && (
        <p role="alert" className="mt-1 text-sm text-red-600">{addDependency.error.message}</p>
      )}
    </section>
  );
}
