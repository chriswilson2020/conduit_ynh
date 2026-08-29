import { z } from "zod";

export { midpoint } from "./fractional.js";
// The package exports "." and nothing else (package.json), so a sibling module is
// reachable from api and web only by being re-exported here -- fractional.js's line
// above is the precedent, and money.js needs it for the same reason: the quote
// form's running total and the stored total must be the same function.
import { documentTotals as computeDocumentTotals } from "./money.js";
export { lineTotalCents, taxCents, documentTotals } from "./money.js";
export type { LineInput, DocumentTotals } from "./money.js";
// Formatting is a separate module from the arithmetic, and reaches web the same
// way: the one locale every money figure in the app is rendered in, so the
// quote form and the PDF beside it cannot disagree.
export { formatMoneyCents, formatQtyMilli, formatTaxRateBp, MONEY_LOCALE } from "./money-format.js";

export const userSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1),
  email: z.email().nullable(),
  fullName: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const meResponseSchema = z.object({ user: userSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string().min(1),
  database: z.enum(["connected", "disconnected"]),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

const nullableString = z.string().min(1).nullable();
const timestamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };

// The companies/contacts tables carry a `custom` jsonb column that is deliberately
// absent from these schemas: custom fields are deferred (Phase 1 spec). Zod strips
// unknown keys, so the column stays invisible to the API until a later phase adds
// it here as a typed field.
export const companySchema = z.object({
  id: z.uuid(), name: z.string().min(1),
  domain: nullableString, website: nullableString, phone: nullableString,
  address: nullableString, industry: nullableString,
  ownerUserId: z.uuid().nullable(), archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Company = z.infer<typeof companySchema>;

export const createCompanyInputSchema = z.object({
  name: z.string().min(1),
  domain: nullableString.optional(), website: nullableString.optional(),
  phone: nullableString.optional(), address: nullableString.optional(),
  industry: nullableString.optional(), ownerUserId: z.uuid().nullable().optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;
export const updateCompanyInputSchema = createCompanyInputSchema.partial();
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

export const contactSchema = z.object({
  id: z.uuid(), firstName: z.string().min(1), lastName: nullableString,
  companyId: z.uuid().nullable(), emails: z.array(z.email()), phones: z.array(z.string().min(1)),
  jobTitle: nullableString, ownerUserId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Contact = z.infer<typeof contactSchema>;

export const createContactInputSchema = z.object({
  firstName: z.string().min(1), lastName: nullableString.optional(),
  companyId: z.uuid().nullable().optional(),
  emails: z.array(z.email()).optional(), phones: z.array(z.string().min(1)).optional(),
  jobTitle: nullableString.optional(), ownerUserId: z.uuid().nullable().optional(),
});
export type CreateContactInput = z.infer<typeof createContactInputSchema>;
export const updateContactInputSchema = createContactInputSchema.partial();
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

// Widened in Phase 2 (Task 7) from company/contact to company/contact/deal, and
// again in Phase 3 (Task 6) to include project: a note or file can now be
// attached to a project instead, mirroring the notes_exactly_one_entity /
// files_exactly_one_entity DB CHECKs (see schema.ts), which already gained a
// project_id column in the 0003 migration.
const exactlyOneEntity = (
  v: { companyId?: string | null; contactId?: string | null; dealId?: string | null; projectId?: string | null },
) => [v.companyId, v.contactId, v.dealId, v.projectId].filter((x) => x != null).length === 1;

export const createNoteInputSchema = z
  .object({
    body: z.string().min(1),
    companyId: z.uuid().optional(), contactId: z.uuid().optional(), dealId: z.uuid().optional(),
    projectId: z.uuid().optional(),
  })
  .refine(exactlyOneEntity, { message: "exactly one of companyId, contactId, dealId or projectId is required" });
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

export const noteSchema = z.object({
  id: z.uuid(), body: z.string().min(1), authorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Note = z.infer<typeof noteSchema>;

export const fileMetaSchema = z.object({
  id: z.uuid(), originalName: z.string().min(1), mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().length(64),
  uploaderUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

// Phase 2 (pipelines/deals) adds four more verbs, and (Task 7) a nullable
// dealId: a deal event carries both dealId and companyId (when the deal has
// one) so it surfaces on both the deal's own timeline and its company's --
// see services/deals.ts's publishDealHint/toDeal-adjacent comments. Phase 3
// adds shifted/completed/dependency_added/dependency_removed -- task
// reopening reuses the existing "reopened" verb rather than adding a
// task-specific one.
// Phase 5 adds "met" (a meeting was logged) and the two mail verbs, one per
// thread per direction per calendar day (api: mail-ingest.ts's throttle).
// Meeting archive/unarchive reuse "archived"/"unarchived" rather than adding
// meeting-specific verbs, the same way task reopening reuses "reopened".
// Kept in the same order as the events_verb_valid DB CHECK (api:
// db/schema.ts), which timeline.test.ts pins member-for-member (schema.test.ts
// covers the migration and the CHECK's own accept/reject behaviour, not the
// member-for-member correspondence).
export const eventVerbSchema = z.enum([
  "created", "updated", "archived", "unarchived", "note_added", "file_attached",
  "stage_changed", "won", "lost", "reopened",
  "shifted", "completed", "dependency_added", "dependency_removed",
  "met", "mail_sent", "mail_received",
]);
// taskId/projectId were deferred in P3.2 (the schema.ts columns existed but
// nothing read/wrote them through this shape yet); Task 3 widens this now
// that projects.ts and pipelines.ts's project scope both emit events carrying
// one or both of them -- a project-scoped pipeline event, for instance,
// carries taskId=null, projectId=<id>, and companyId=<the project's company,
// when it has one>, mirroring the existing dealId/companyId dual-stamp.
export const eventSchema = z.object({
  id: z.uuid(), verb: eventVerbSchema, actorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  taskId: z.uuid().nullable(), projectId: z.uuid().nullable(),
  // Phase 5's two pointers, both nullable because most events have neither.
  // meetingId links a "met"/"archived"/"unarchived" meeting entry back to its
  // meeting, beside the meeting's own record links in the columns above -- and
  // it rides one FOURTH kind of row: the "created" entry of a follow-up task
  // (api: services/tasks.ts's origin parameter), where it records the meeting
  // the task came FROM rather than what the entry is about. A client renders
  // that row's own wording and links to the meeting through this field; the
  // meeting's title is not in the payload, because a task's creation event
  // carries no render data for any task.
  meetingId: z.uuid().nullable(),
  // mailThreadId is the WHOLE of what a mail event stores about the mail
  // (spec's mail-privacy decision): no subject, snippet or address is ever
  // written -- not here and not in `payload` -- because an event row is
  // readable by every user of the CRM while a thread is not. The subject a
  // client renders is derived at READ time from mail_threads.subject through
  // Phase 4.2's visibility predicate composed with 4.3's hide predicate, and
  // a row whose thread the viewer may not see is dropped from the response
  // entirely rather than stubbed (api: timeline.ts, Task 4 -- which adds the
  // derived `mailSubject` field for that rendered value).
  mailThreadId: z.uuid().nullable(),
  // DERIVED AT READ TIME, NEVER STORED. There is no mail_subject column and
  // no payload key holding it: services/timeline.ts reads it from the joined
  // mail_threads row in the same statement -- and through the same join whose
  // ON clause carries Phase 4.2's record-visible predicate and Phase 4.3's
  // not-hidden predicate -- so a subject cannot be produced for a thread the
  // viewer may not see. That coupling is the point: were the field stored on
  // the event, it would be readable by every user of the CRM, and were it
  // joined separately from the predicate, a broken predicate would leak it.
  // Non-null exactly when mailThreadId is (mail_threads.subject is NOT NULL
  // and an unfiltered row is a row that passed both predicates); null on
  // every non-mail event, which is nearly all of them.
  //
  // A RENAME IS INVISIBLE HERE, deliberately: threads take their subject once
  // from their first message and never rewrite it (api: mail-ingest.ts), so
  // unlike a meeting's payload title this value cannot go stale against the
  // record it names.
  mailSubject: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
});
export type Event = z.infer<typeof eventSchema>;

// --- Pipelines, stages, deals (Phase 2) ---------------------------------

// 'project' completes the three-scope design (Phase 3 plan/spec): a pipeline
// now belongs to exactly one of global (no owner), a company, or a project.
// Deferred no longer -- P3.2 only widened the DB CHECK (pipelines_scope_valid,
// schema.ts) and left this enum and the pairing refine below for the task
// that actually wires project-scoped pipeline creation (this one).
export const pipelineScopeSchema = z.enum(["global", "company", "project"]);
export type PipelineScope = z.infer<typeof pipelineScopeSchema>;

export const pipelineSchema = z.object({
  id: z.uuid(), name: z.string().min(1),
  scope: pipelineScopeSchema, companyId: z.uuid().nullable(), projectId: z.uuid().nullable(),
  position: z.string().min(1),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Pipeline = z.infer<typeof pipelineSchema>;

// Mirrors the pipelines_scope_paired DB CHECK's three-way exclusivity:
// companyId present iff scope is "company", projectId present iff scope is
// "project", neither present for "global". Each side of the `===` is
// evaluated independently, so a caller can't satisfy the check by supplying
// BOTH companyId and projectId for either scoped value -- e.g. scope
// "company" with a projectId present fails the second clause even though the
// first is satisfied.
const scopePaired = (v: { scope: PipelineScope; companyId?: string; projectId?: string }) =>
  (v.scope === "company") === (v.companyId !== undefined) &&
  (v.scope === "project") === (v.projectId !== undefined);

export const createPipelineInputSchema = z
  .object({
    name: z.string().min(1), scope: pipelineScopeSchema,
    companyId: z.uuid().optional(), projectId: z.uuid().optional(),
  })
  .refine(scopePaired, {
    message: "companyId is required exactly when scope is company, projectId exactly when scope is project",
  });
export type CreatePipelineInput = z.infer<typeof createPipelineInputSchema>;

// Scope and companyId are immutable after creation (the pipeline's owner never
// changes), so only the name is patchable here.
export const updatePipelineInputSchema = z.object({ name: z.string().min(1).optional() });
export type UpdatePipelineInput = z.infer<typeof updatePipelineInputSchema>;

export const stageSchema = z.object({
  id: z.uuid(), pipelineId: z.uuid(), name: z.string().min(1), position: z.string().min(1),
  probability: z.number().int().min(0).max(100).nullable(),
  rotDays: z.number().int().positive().nullable(), ...timestamps,
});
export type Stage = z.infer<typeof stageSchema>;

// Composite response for "get one pipeline": its stages, already ordered by
// position, bundled alongside it. Only pipelineSchema/stageSchema existed when
// the pipelines service (Phase 2) needed a getPipeline return shape, so this
// wraps rather than flattens them -- { pipeline, stages }, not a spread -- to
// keep the two independently-versioned resources from colliding on field
// names (both have id/name/createdAt/updatedAt) if either ever grows one.
export const pipelineWithStagesSchema = z.object({
  pipeline: pipelineSchema,
  stages: z.array(stageSchema),
});
export type PipelineWithStages = z.infer<typeof pipelineWithStagesSchema>;

export const createStageInputSchema = z.object({
  name: z.string().min(1),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  rotDays: z.number().int().positive().nullable().optional(),
});
export type CreateStageInput = z.infer<typeof createStageInputSchema>;
export const updateStageInputSchema = createStageInputSchema.partial();
export type UpdateStageInput = z.infer<typeof updateStageInputSchema>;

export const dealStatusSchema = z.enum(["open", "won", "lost"]);
export type DealStatus = z.infer<typeof dealStatusSchema>;

const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "currency must be 3 uppercase letters");

export const dealSchema = z.object({
  id: z.uuid(), title: z.string().min(1),
  pipelineId: z.uuid(), stageId: z.uuid(), position: z.string().min(1),
  valueCents: z.number().int().safe().nullable(),
  currency: currencyCodeSchema,
  expectedCloseDate: z.iso.date().nullable(),
  status: dealStatusSchema,
  lostReason: nullableString,
  closedAt: z.iso.datetime().nullable(),
  ownerUserId: z.uuid().nullable(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Deal = z.infer<typeof dealSchema>;

export const createDealInputSchema = z.object({
  title: z.string().min(1),
  pipelineId: z.uuid(), stageId: z.uuid(),
  valueCents: z.number().int().safe().nullable().optional(),
  currency: currencyCodeSchema.optional(),
  expectedCloseDate: z.iso.date().nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  companyId: z.uuid().nullable().optional(), contactId: z.uuid().nullable().optional(),
});
export type CreateDealInput = z.infer<typeof createDealInputSchema>;

// pipelineId/stageId are excluded: a deal's pipeline never changes and its
// stage only ever changes through moveDealInputSchema below (moveDeal derives
// the new position from neighbour ids, which a generic field patch cannot do).
export const updateDealInputSchema = createDealInputSchema
  .omit({ pipelineId: true, stageId: true }).partial();
export type UpdateDealInput = z.infer<typeof updateDealInputSchema>;

/** beforeDealId/afterDealId name the neighbours the moved deal ends up BETWEEN:
 * beforeDealId is the neighbour immediately preceding it (lower position),
 * afterDealId the neighbour immediately following it (higher position). This is
 * NOT "insert before this id" -- the field names describe the neighbours'
 * placement relative to the moved item, and Task 3's service and the web client
 * must both read them this way. When BOTH are omitted, the deal is appended at
 * the tail of the target stage (mirrors createDeal's append semantics) --
 * NOT inserted at the front. */
export const moveDealInputSchema = z.object({
  stageId: z.uuid(),
  beforeDealId: z.uuid().optional(),
  afterDealId: z.uuid().optional(),
});
export type MoveDealInput = z.infer<typeof moveDealInputSchema>;

export const funnelRowSchema = z.object({
  stageId: z.uuid(), count: z.number().int().nonnegative(), valueCents: z.number().int().nonnegative(),
});
export type FunnelRow = z.infer<typeof funnelRowSchema>;

// --- Projects, tasks, task dependencies (Phase 3) -----------------------

export const projectStatusSchema = z.enum(["active", "completed"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex code (e.g. #1a2b3c)");

export const projectSchema = z.object({
  id: z.uuid(), name: z.string().min(1),
  companyId: z.uuid().nullable(), dealId: z.uuid().nullable(), ownerUserId: z.uuid().nullable(),
  status: projectStatusSchema,
  startDate: z.iso.date().nullable(), dueDate: z.iso.date().nullable(),
  color: hexColorSchema.nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Project = z.infer<typeof projectSchema>;

// status is deliberately absent here: a project always starts 'active' (same
// as a deal always opening "open"), so create has no use for it.
export const createProjectInputSchema = z.object({
  name: z.string().min(1),
  companyId: z.uuid().nullable().optional(), dealId: z.uuid().nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  startDate: z.iso.date().nullable().optional(), dueDate: z.iso.date().nullable().optional(),
  color: hexColorSchema.nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

// Unlike a deal's status (a state machine gated behind winDeal/loseDeal/
// reopenDeal), a project's status is freely settable through the generic
// update path -- there is no transition matrix, so it is added here rather
// than left out of a plain .partial() the way create's schema leaves every
// other field. See services/projects.ts's updateProject for why completing a
// project deliberately does not cascade to its tasks.
export const updateProjectInputSchema = createProjectInputSchema.partial()
  .extend({ status: projectStatusSchema.optional() });
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const taskTypeSchema = z.enum(["task", "call", "meeting", "email", "deadline"]);
export type TaskType = z.infer<typeof taskTypeSchema>;
export const taskStatusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.uuid(), title: z.string().min(1), description: nullableString,
  type: taskTypeSchema, status: taskStatusSchema,
  assigneeUserId: z.uuid().nullable(),
  startDate: z.iso.date().nullable(), dueDate: z.iso.date().nullable(),
  completedAt: z.iso.datetime().nullable(),
  progressPct: z.number().int().min(0).max(100).nullable(),
  parentTaskId: z.uuid().nullable(), position: z.string().min(1),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Mirrors the tasks_dates_paired DB CHECK: both null/omitted, or both present
 * with startDate <= dueDate. Shared between create (an absent key just means
 * "no dates yet") and update (an absent key means "leave this pair alone" --
 * partial-update semantics, so it can only ever see one snapshot, never the
 * row's persisted counterpart). A partial update may therefore only touch
 * startDate/dueDate together, never just one -- a lone value can't be
 * validated against a value this schema can't see.
 *
 * Exported so services/tasks.ts's updateTask/createTask can re-assert the
 * same invariant against a raw patch object -- a direct service caller (as
 * opposed to the zod-validated route) bypasses this file's .refine() entirely.
 */
export function taskDatesPaired(v: { startDate?: string | null; dueDate?: string | null }): boolean {
  // Checked directly on v.startDate/v.dueDate (not via intermediate booleans)
  // so TS actually narrows their type for the startDate <= dueDate comparison
  // below -- narrowing doesn't propagate through a derived boolean variable.
  if (v.startDate === undefined && v.dueDate === undefined) return true;
  if (v.startDate === undefined || v.dueDate === undefined) return false;
  if (v.startDate === null && v.dueDate === null) return true;
  if (v.startDate !== null && v.dueDate !== null) return v.startDate <= v.dueDate;
  return false;
}

const taskInputShape = z.object({
  title: z.string().min(1),
  description: nullableString.optional(),
  type: taskTypeSchema.optional(),
  assigneeUserId: z.uuid().nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  progressPct: z.number().int().min(0).max(100).nullable().optional(),
  parentTaskId: z.uuid().nullable().optional(),
  companyId: z.uuid().nullable().optional(), contactId: z.uuid().nullable().optional(),
  dealId: z.uuid().nullable().optional(), projectId: z.uuid().nullable().optional(),
});

// status/position/completedAt excluded from both: status changes go through
// the dedicated setTaskStatus action (which stamps completedAt itself),
// position through moveTaskOnBoard -- mirrors deals' pipelineId/stageId/
// position exclusion from createDealInputSchema/updateDealInputSchema.
export const createTaskInputSchema = taskInputShape.refine(taskDatesPaired, {
  message: "startDate and dueDate must both be set (with startDate <= dueDate) or both omitted",
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = taskInputShape.partial().refine(taskDatesPaired, {
  message: "startDate and dueDate must both be provided together (with startDate <= dueDate), or neither",
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** beforeTaskId/afterTaskId name the neighbours the moved task ends up BETWEEN
 * within the target status column -- same "neighbours, not an insertion
 * target" semantics as moveDealInputSchema above, adapted from stage to
 * status. Both omitted appends at the tail of the target status column
 * (mirrors createTask's append semantics). Board moves stay within the
 * task's own project/standalone pool -- there is no cross-project move, so
 * only status names the target column, not projectId. */
export const moveTaskOnBoardInputSchema = z.object({
  status: taskStatusSchema,
  beforeTaskId: z.uuid().optional(),
  afterTaskId: z.uuid().optional(),
});
export type MoveTaskOnBoardInput = z.infer<typeof moveTaskOnBoardInputSchema>;

// Column exists so SS/FF/SF become a CHECK (and enum) widening later, not a
// migration -- only 'FS' is valid in Phase 3.
export const taskDependencyTypeSchema = z.enum(["FS"]);
export type TaskDependencyType = z.infer<typeof taskDependencyTypeSchema>;

export const taskDependencySchema = z.object({
  id: z.uuid(), predecessorId: z.uuid(), successorId: z.uuid(),
  type: taskDependencyTypeSchema, createdAt: z.iso.datetime(),
});
export type TaskDependency = z.infer<typeof taskDependencySchema>;

// The successor is named by the route (POST /api/tasks/:id/dependencies,
// :id = successorId), so the body only needs the predecessor.
export const createTaskDependencyInputSchema = z.object({ predecessorId: z.uuid() });
export type CreateTaskDependencyInput = z.infer<typeof createTaskDependencyInputSchema>;

// A shift always sets both dates (see scheduling.ts's shiftTask): a resize
// changes one independently and a move shifts both by the same delta, but
// either way the caller computes the resulting pair client-side and sends it
// whole -- the service never needs to infer "which end moved."
export const shiftTaskInputSchema = z
  .object({ startDate: z.iso.date(), dueDate: z.iso.date() })
  .refine((v) => v.startDate <= v.dueDate, { message: "startDate must be on or before dueDate" });
export type ShiftTaskInput = z.infer<typeof shiftTaskInputSchema>;

export const shiftResultSchema = z.object({
  moved: z.array(z.object({
    id: z.uuid(), startDate: z.iso.date(), dueDate: z.iso.date(),
    // null for the dragged task itself; for every other (cascaded) entry,
    // the id of the DRAGGED task -- not the immediate predecessor that
    // happened to trip the violation. See scheduling.ts's shiftTask: the UI
    // flashes "moved because you dragged X", one consistent reason across
    // the whole cascade, not a different one per hop down the chain.
    cascadedFrom: z.uuid().nullable(),
  })),
});
export type ShiftResult = z.infer<typeof shiftResultSchema>;

// Extends taskSchema with the project's name/color so the chart can group and
// colour bars without a second round trip -- both null for a standalone task
// (no projectId). Used for both the per-project and global Gantt (Task 5's
// ganttPayload).
export const ganttTaskSchema = taskSchema.extend({
  projectName: z.string().min(1).nullable(),
  projectColor: hexColorSchema.nullable(),
});
export type GanttTask = z.infer<typeof ganttTaskSchema>;

export const ganttPayloadSchema = z.object({
  tasks: z.array(ganttTaskSchema),
  dependencies: z.array(taskDependencySchema),
});
export type GanttPayload = z.infer<typeof ganttPayloadSchema>;

export const sseHintSchema = z.object({ keys: z.array(z.array(z.string())) });
export type SseHint = z.infer<typeof sseHintSchema>;

export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// Mirrors the columns GET /api/users actually selects (see routes/users.ts):
// a plain listing for populating an owner picker, not the full userSchema (no
// email/createdAt).
export const userSummarySchema = z.object({
  id: z.uuid(), username: z.string().min(1), fullName: z.string().min(1).nullable(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const usersResponseSchema = z.object({ users: z.array(userSummarySchema) });
export type UsersResponse = z.infer<typeof usersResponseSchema>;

// --- Mail (Phase 4) ------------------------------------------------------

/**
 * How a mail connection failure is classified, as a stable prefix on the
 * error MESSAGE. The IMAP/SMTP adapter (api: services/mail-imapflow.ts) puts
 * one of these at the front of anything it throws that it can classify; the
 * text then travels, verbatim, into mail_accounts.last_error, the
 * test-connection response and the send path's 502 body.
 *
 * They live in SHARED, not in the api package, because the consumers are on
 * both sides of the wire: the settings UI branches on them to say "check your
 * password" versus "the server could not be reached", and packages/web cannot
 * import from packages/api. Anything unclassifiable carries no prefix at all
 * rather than a guessed one -- a UI matching these must treat "neither" as an
 * ordinary case, not an error.
 */
export const MAIL_AUTH_ERROR_PREFIX = "auth:";
export const MAIL_CONNECTION_ERROR_PREFIX = "connection:";

export const mailSecuritySchema = z.enum(["tls", "starttls"]);
export type MailSecurity = z.infer<typeof mailSecuritySchema>;

export const mailAccountStatusSchema = z.enum(["active", "error"]);
export type MailAccountStatus = z.infer<typeof mailAccountStatusSchema>;

// Phase 4.2: private by default, per account (spec's Decisions table: "the
// safe direction", the owner flips a mailbox to shared in Settings). Drives
// the inbox/record visibility predicate (api: mail-threads.ts, Task 2) --
// see mail_accounts.visibility's own comment (api: db/schema.ts) for what
// 'private'/'shared' each mean and why the DB default alone is the whole
// migration.
export const mailVisibilitySchema = z.enum(["private", "shared"]);
export type MailVisibility = z.infer<typeof mailVisibilitySchema>;

// mail_account_folders.special_use's five classified values (Phase 4.1) --
// the SPECIAL-USE attribute (RFC 6154) where the server offers it, else a
// case-insensitive name-heuristic fallback (api: services/mail-folders.ts).
// An ordinary, unclassified folder carries NULL here, not a sixth "none"
// member -- see mailAccountFolderSchema's specialUse field below.
export const specialUseSchema = z.enum(["archive", "drafts", "junk", "sent", "trash"]);
export type SpecialUse = z.infer<typeof specialUseSchema>;

// Deliberately excludes credentialsCiphertext (and any other secret) --
// mail_accounts.credentials_ciphertext is never serialized to a client (see
// the Phase 4 spec's "Key handling" section). This is the account shape
// every read route returns; index.test.ts asserts by construction that no
// key on this schema looks like a credential.
export const mailAccountSchema = z.object({
  id: z.uuid(), userId: z.uuid(), label: z.string().min(1), email: z.email(),
  imapHost: z.string().min(1), imapPort: z.number().int().positive(), imapSecurity: mailSecuritySchema,
  smtpHost: z.string().min(1), smtpPort: z.number().int().positive(), smtpSecurity: mailSecuritySchema,
  username: z.string().min(1),
  sentFolder: z.string().min(1),
  // Phase 4.1: resolved automatically from folder discovery when NULL,
  // user-overridable in Settings (mail_accounts.trash_folder/archive_folder,
  // db/schema.ts) -- NULL is a real, meaningful "not yet resolved" state,
  // same reasoning as signatureHtml/lastError below, not an omitted field.
  trashFolder: nullableString, archiveFolder: nullableString,
  signatureHtml: nullableString,
  backfillDays: z.number().int().positive().nullable(),
  visibility: mailVisibilitySchema,
  status: mailAccountStatusSchema,
  lastError: nullableString,
  lastSyncedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

// The ONLY shape another user's mail account may ever appear in (Task 3's
// listAccounts, Phase 4 spec's routes list: "the list returns other users'
// accounts as id+label+email (for filter UI), never settings"). Mirrors
// userSummarySchema above -- same reasoning, a plain listing shape for
// populating a filter/picker, not the full account. No host/port/security/
// username/status here on purpose: those are settings, and settings belong
// to their owner alone, same spirit as mailAccountSchema excluding
// credentialsCiphertext.
export const mailAccountSummarySchema = z.object({
  id: z.uuid(), label: z.string().min(1), email: z.email(),
});
export type MailAccountSummary = z.infer<typeof mailAccountSummarySchema>;

// userId is the actor, stamped server-side (mirrors notes' authorUserId --
// never a caller-supplied field). One password field with an optional
// smtpPassword override, per the "SMTP differs" toggle in the Phase 4 spec's
// Key handling section -- when smtpPassword is omitted, the service reuses
// password for both protocols.
//
// No `visibility` here, deliberately (Phase 4.2): every account is BORN
// private (mail_accounts.visibility's DB default, db/schema.ts) -- there is
// no "create it shared" gesture, only a later, deliberate flip in Settings
// once the mailbox exists. Same shape of omission as trashFolder/
// archiveFolder below: a field that is genuinely update-only stays off the
// create schema rather than being accepted-and-ignored.
export const mailAccountCreateInputSchema = z.object({
  label: z.string().min(1), email: z.email(),
  imapHost: z.string().min(1), imapPort: z.number().int().positive(), imapSecurity: mailSecuritySchema,
  smtpHost: z.string().min(1), smtpPort: z.number().int().positive(), smtpSecurity: mailSecuritySchema,
  username: z.string().min(1),
  password: z.string().min(1),
  smtpPassword: z.string().min(1).optional(),
  sentFolder: z.string().min(1).optional(),
  signatureHtml: nullableString.optional(),
  backfillDays: z.number().int().positive().nullable().optional(),
});
export type MailAccountCreateInput = z.infer<typeof mailAccountCreateInputSchema>;

// update omits password/smtpPassword on purpose here: the edit form leaves
// password fields blank and only overwrites when non-empty (spec, Key
// handling) -- that "blank means unchanged" behaviour is a service-layer
// concern, not something a single static shape can express, so credential
// updates route through mailAccountCreateInputSchema's password fields at
// the call site instead of living on this schema.
// trashFolder/archiveFolder are `.extend()`ed on AFTER the create-derived
// shape rather than living on mailAccountCreateInputSchema itself (and being
// `.omit()`-free-riding through the derivation like every other field here):
// nothing about them is ever supplied at CREATE time (Phase 4.1 spec --
// they're resolved from folder discovery, which only starts once the
// account exists and a first LIST pass has run), so create stays exactly as
// clean as it was pre-4.1 and these two are genuinely update-only. Typed via
// nullableString (not a plain optional string) so a blank-string submission
// is REJECTED outright, not silently accepted -- unlike sentFolder's own ""
// => "keep the column default" convention (normalizeSentFolder,
// mail-accounts.ts), "" is never a meaningful override here, only a real
// folder name or an explicit null. Trimming a real value is service-side
// work in Task 4 (mirroring normalizeSentFolder), not a schema concern.
//
// `visibility` joins trashFolder/archiveFolder in this `.extend()`, for the
// same reason: it is on THIS schema only, never mailAccountCreateInputSchema
// (see that schema's own comment on why an account is always born private).
// Owner-only like every other field here (mail-accounts.ts's updateAccount
// runs every patch through mustGetOwned before it touches a row) -- flipping
// it is a deliberate Settings act, not a connection change: it is excluded
// from updateAccount's CONNECTION_FIELDS (the sync loop is woken, never
// restarted), and a real flip widens the post-commit SSE publish to carry
// the thread-side key families beside [["mail-accounts"]].
export const mailAccountUpdateInputSchema = mailAccountCreateInputSchema
  .omit({ password: true, smtpPassword: true }).partial()
  .extend({
    trashFolder: nullableString.optional(), archiveFolder: nullableString.optional(),
    visibility: mailVisibilitySchema.optional(),
  });
export type MailAccountUpdateInput = z.infer<typeof mailAccountUpdateInputSchema>;

// The update-path counterpart to mailAccountCreateInputSchema's password/
// smtpPassword: unlike create's `.min(1)` (a password is mandatory when
// first saving an account), "" is a valid, MEANINGFUL value here -- blank
// means "keep the currently stored password" (mail-accounts.ts's
// updateAccount), not an invalid one. This is the schema a PATCH body's
// password fields validate through (Task 7); reusing
// mailAccountCreateInputSchema's stricter `.min(1)` fields for updates would
// reject the blank-means-unchanged submission the edit form relies on
// before it ever reached the service.
export const mailAccountUpdatePasswordFieldsSchema = z.object({
  password: z.string().optional(),
  smtpPassword: z.string().optional(),
});
export type MailAccountUpdatePasswordFields = z.infer<typeof mailAccountUpdatePasswordFieldsSchema>;

// POST /api/mail/accounts/test dry-runs IMAP+SMTP logins with either the
// submitted credentials (composing a not-yet-saved account) or, when only
// accountId is given, the stored ones -- every other field is therefore
// optional here even though mailAccountCreateInputSchema requires them.
export const mailAccountTestInputSchema = z.object({
  accountId: z.uuid().optional(),
  imapHost: z.string().min(1).optional(), imapPort: z.number().int().positive().optional(),
  imapSecurity: mailSecuritySchema.optional(),
  smtpHost: z.string().min(1).optional(), smtpPort: z.number().int().positive().optional(),
  smtpSecurity: mailSecuritySchema.optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
}).superRefine((v, ctx) => {
  if (v.accountId !== undefined) return; // the stored account supplies every field; anything else here only overrides it.
  // No accountId: this is a fresh, not-yet-saved connection attempt, so the
  // submission must be self-sufficient. smtpPassword stays optional even
  // here -- mail-accounts.ts's testConnection defaults it to `password`,
  // same "SMTP differs" convention as mailAccountCreateInputSchema. Reported
  // as field-level issues (not one coarse message) so routes/mail.ts (Task
  // 7) can surface exactly which one is missing, and so this schema makes
  // the service's own defensive "incomplete settings" branch unreachable
  // from any request that passed validation.
  const required = [
    ["imapHost", v.imapHost], ["imapPort", v.imapPort], ["imapSecurity", v.imapSecurity],
    ["smtpHost", v.smtpHost], ["smtpPort", v.smtpPort], ["smtpSecurity", v.smtpSecurity],
    ["username", v.username], ["password", v.password],
  ] as const;
  for (const [field, value] of required) {
    if (value === undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} is required when accountId is not given` });
    }
  }
});
export type MailAccountTestInput = z.infer<typeof mailAccountTestInputSchema>;

const mailTestProtocolResultSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
// POST /api/mail/accounts/test's response shape (Task 3's testConnection
// return value; Task 7 wires the route). Field-optional `error` mirrors
// mail-accounts.ts's ProtocolResult -- present only on failure, and its text
// must never contain a password or ciphertext (mail-accounts.ts's own
// contract).
export const mailAccountTestResultSchema = z.object({
  imap: mailTestProtocolResultSchema, smtp: mailTestProtocolResultSchema,
});
export type MailAccountTestResult = z.infer<typeof mailAccountTestResultSchema>;

// Live counters from the in-process sync engine (api:
// services/mail-sync.ts's AccountSyncStats), mirrored here by hand because
// packages/web cannot import from packages/api. Purely observational -- the
// durable facts about an account's health (status, lastError, lastSyncedAt)
// live on the account row itself; these say how the CURRENT process's loop
// has been getting on since it started, and reset on every restart.
export const mailAccountSyncStatsSchema = z.object({
  passes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  ingested: z.number().int().nonnegative(),
  poisonSkips: z.number().int().nonnegative(),
  idleWakes: z.number().int().nonnegative(),
  /** Consecutive failures; non-zero means the account is in backoff. */
  attempt: z.number().int().nonnegative(),
  stopped: z.boolean(),
});
export type MailAccountSyncStats = z.infer<typeof mailAccountSyncStatsSchema>;

// An own account plus whatever the sync engine can say about it right now.
// syncStats is optional AND nullable, and deliberately not defaulted: null
// is the honest answer for an account with no live sync (archived, never
// started, or a deployment with sync disabled -- NODE_ENV=test included),
// while absent lets every caller that only cares about the account row
// itself (every service, every fixture) keep using the plain account shape.
// The extension direction matters: mailAccountSchema stays the source of
// truth for what an account IS, and this adds the one derived field the
// settings page needs on top, rather than a second hand-written account
// shape that could drift from it.
export const mailAccountWithSyncStatsSchema = mailAccountSchema.extend({
  syncStats: mailAccountSyncStatsSchema.nullable().optional(),
});
export type MailAccountWithSyncStats = z.infer<typeof mailAccountWithSyncStatsSchema>;

// GET /api/mail/accounts' response shape (Task 3's listAccounts; Task 7
// wires the route). See listAccounts' own doc comment in mail-accounts.ts
// for why the shape is {own, others} rather than one discriminated list.
// Only `own` carries sync stats: another user's sync health is as much a
// setting as their host and port, and `others` exists purely to label a
// filter dropdown.
export const mailAccountListSchema = z.object({
  own: z.array(mailAccountWithSyncStatsSchema), others: z.array(mailAccountSummarySchema),
});
export type MailAccountList = z.infer<typeof mailAccountListSchema>;

// One row of GET /api/mail/accounts/:id/folders (Phase 4.1 Task 4's folder
// picker). Every field through lastDiscoveredAt mirrors mail_account_folders
// (api: db/schema.ts) field for field -- see that table's comments for what
// each carries and why syncEnabled/lastDiscoveredAt have no DB-level
// default -- EXCEPT `locked`, which has no DB column at all: it is computed
// per request by the SERVICE that reads the rows (mail-folders.ts's
// listAccountFolders, not the route -- the same derivation guards the PATCH,
// and one copy of the rule is what keeps the read and the write agreeing).
// True for INBOX and the account's current sent_folder, the two folders
// foldersOf always walks regardless of sync_enabled (spec), so the picker can
// grey them out without the client re-deriving that rule itself.
export const mailAccountFolderSchema = z.object({
  id: z.uuid(), accountId: z.uuid(), folder: z.string().min(1),
  specialUse: specialUseSchema.nullable(),
  syncEnabled: z.boolean(), selectable: z.boolean(), locked: z.boolean(),
  lastDiscoveredAt: z.iso.datetime(), ...timestamps,
});
export type MailAccountFolder = z.infer<typeof mailAccountFolderSchema>;

// Trimmed, non-blank IMAP folder name -- shared by every folder-carrying
// input field below (folderPatchInputSchema.folder,
// bulkThreadActionInputSchema.folder, threadListFiltersSchema.folder).
// Mirrors normalizeSentFolder's rationale (api: mail-accounts.ts) at the zod
// layer instead of the service layer: an IMAP mailbox name is compared byte
// for byte everywhere it is used downstream, so " Archive " and "Archive"
// must never become two different values purely because of incidental
// whitespace. Unlike sentFolder, none of these three fields has a DB column
// with its own default to fall back to when blank -- a blank folder
// filter/target/patch is simply invalid input, not "use the default", hence
// reject-after-trim (`.min(1)` on the trimmed value) rather than
// normalizeSentFolder's "blank becomes absent".
const folderNameSchema = z.string().trim().min(1);

// PATCH /api/mail/accounts/:id/folders body (Task 4): toggles one folder's
// sync_enabled. Identifies the row by folder NAME rather than id -- the
// picker renders straight from GET .../folders' list, and a name round-trip
// buys the route nothing an id lookup wouldn't already give it, while
// staying symmetric with bulkThreadActionInputSchema's folder field below
// (also a name, not an id).
export const folderPatchInputSchema = z.object({
  folder: folderNameSchema, syncEnabled: z.boolean(),
});
export type FolderPatchInput = z.infer<typeof folderPatchInputSchema>;

export const mailThreadSchema = z.object({
  id: z.uuid(),
  // No .min(1): a thread's subject derives from its first message's
  // subject, which can itself be '' (mail_messages.subject defaults to ''
  // for inbound mail lacking one) -- same reasoning as mailMessageSchema's
  // subject below. One thread with an empty subject must not throw on
  // parseWith and take the whole thread list down with it.
  subject: z.string(),
  lastMessageAt: z.iso.datetime(), messageCount: z.number().int().nonnegative(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  // Phase 4.3: PER-VIEWER, unlike every other field here -- when THIS
  // REQUEST'S viewer hid the thread (their mail_thread_hides row's
  // hidden_at), null when they have not. Replaces the retired thread-global
  // archivedAt: since 4.3 a hide is a per-person filing act, so "is it
  // hidden" has no thread-global answer to expose. Sourced from the
  // viewer's own hide row (api: mail-threads.ts's toThread takes it as an
  // explicit argument -- mustGetThread's join on the by-id surfaces, the
  // list page's join per row): null by construction on every default list
  // row (hidden threads are excluded there), the filing moment on every
  // Hidden-view row and on a hidden thread's still-openable detail.
  hiddenAt: z.iso.datetime().nullable(), ...timestamps,
});
export type MailThread = z.infer<typeof mailThreadSchema>;

export const mailDirectionSchema = z.enum(["inbound", "outbound"]);
export type MailDirection = z.infer<typeof mailDirectionSchema>;

// {address, name} mirrors mail_messages.to_addrs/cc_addrs/bcc_addrs' jsonb
// shape (spec: "array of {address, name}") -- name is optional/nullable
// because a raw address header ("bob@example.com" with no display name) is
// completely ordinary.
//
// address is deliberately z.string().min(1), NOT z.email(): this is the
// READ side, describing addresses that arrived over IMAP from the real
// world -- root@localhost, SRS-rewritten bounce addresses with embedded '='
// (bounces+SRS=abc@lists.example.org), quoted local parts, and other RFC
// 5321 forms zod v4's z.email() rejects outright. A thread whose parseWith
// throws on one address is a thread that never renders, so this schema must
// accept whatever mailparser handed the ingest pipeline. The COMPOSE side
// (sendMailInputSchema below) is different -- human-typed input -- and uses
// its own stricter schema with z.email().
export const mailAddressSchema = z.object({
  address: z.string().min(1), name: z.string().min(1).nullable().optional(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const mailMessageSchema = z.object({
  id: z.uuid(), accountId: z.uuid(), threadId: z.uuid(),
  messageId: z.string().min(1), inReplyTo: z.string().min(1).nullable(),
  referencesIds: z.array(z.string().min(1)),
  // Same reasoning as mailAddressSchema.address above -- real From headers
  // include forms z.email() rejects.
  fromAddr: z.string().min(1), fromName: nullableString,
  toAddrs: z.array(mailAddressSchema), ccAddrs: z.array(mailAddressSchema), bccAddrs: z.array(mailAddressSchema),
  // subject/bodyText/snippet default to '' at the DB (inbound mail can lack
  // a subject entirely), so no .min(1) here -- unlike mailAddressSchema's
  // name, empty string is the normal "absent" value for these, not null.
  subject: z.string(), bodyText: z.string(), bodyHtml: z.string().nullable(),
  snippet: z.string(),
  sentAt: z.iso.datetime(), folder: z.string().min(1),
  imapUid: z.number().int().nonnegative().nullable(),
  seen: z.boolean(), direction: mailDirectionSchema,
  ...timestamps,
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

// blobPath deliberately excluded -- mirrors fileMetaSchema above, which
// never exposes its own storage internals to a client either; downloads go
// through the authenticated GET /api/mail/attachments/:id route, which
// resolves the path server-side. The DB column (schema.ts's mailAttachments
// .blobPath) is unaffected -- only this client-facing shape changes.
export const mailAttachmentSchema = z.object({
  id: z.uuid(), messageId: z.uuid(), filename: z.string().min(1), mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentId: nullableString, isInline: z.boolean(), createdAt: z.iso.datetime(),
});
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

// One row of GET /api/mail/threads. The five extra fields are everything the
// thread-list row renders that is NOT on the thread itself (unread dot,
// senders summary, snippet, account chip, move-rights flag) -- derived per
// page from the thread's messages rather than denormalised onto mail_threads,
// because every one of them changes on ingest and none is worth a second
// writer.
export const mailThreadListItemSchema = mailThreadSchema.extend({
  /** At least one message is unseen -- among the messages THIS list's view
   * shows this viewer (the 4.1 unread-scopes-to-the-view ruling, composed
   * with the 4.2 visibility predicate; api: mail-threads.ts). */
  unread: z.boolean(),
  /** The most recent VISIBLE message's snippet (already placeholder-free). */
  snippet: z.string(),
  /**
   * Distinct From addresses, most recent first, capped at five server-side
   * (a mailing-list thread has hundreds and a list row shows a few).
   *
   * `senders`, not `participants`: it is derived from from_addr alone. The
   * To and Cc lines are NOT folded in, so this is who WROTE in the thread,
   * not everyone on it -- the honest name for what the column contains.
   */
  senders: z.array(mailAddressSchema),
  /** Every account whose mailbox carries this thread -- restricted to the
   * accounts the VIEWER may see into for this list's scope (own and shared
   * mailboxes; on record views, a deal/project-linked thread's private
   * accounts too). */
  accountIds: z.array(z.uuid()),
  /**
   * Phase 4.2: does the viewer own at least one account this thread carries a
   * message on? Computed in the same aggregate pass as `accountIds`/`senders`
   * (>= 1 message on an account owned by the requesting user), not persisted
   * anywhere -- "owner" is a fact about the ACCOUNT, and a thread can span
   * several. Drives the bulk bar's Archive/Trash gating (move rights are
   * owner-only, per the spec's Move rights section; web: bulk-bar.tsx's
   * disabled-with-reason state off this flag): `false` means every
   * message here belongs to someone else's mailbox, so only Hide-in-CRM
   * applies. Named for the viewer specifically because it answers "can THIS
   * request's actor move something here", not "does this thread have an
   * owner" in the abstract.
   */
  ownedByViewer: z.boolean(),
});
export type MailThreadListItem = z.infer<typeof mailThreadListItemSchema>;

// A thread-detail message carries its attachments inline: the conversation
// view renders chips under each body, and a second round trip per message
// would be one request per message on a long thread.
export const mailMessageWithAttachmentsSchema = mailMessageSchema.extend({
  attachments: z.array(mailAttachmentSchema),
});
export type MailMessageWithAttachments = z.infer<typeof mailMessageWithAttachmentsSchema>;

// Open deals of the thread's linked contact/company that the thread is not
// already linked to -- the one-click "link this deal" row in the link panel.
// {id, title} mirrors searchResultsSchema's deals group: enough to render a
// row and act on it, and nothing else.
export const mailDealSuggestionSchema = z.object({ id: z.uuid(), title: z.string().min(1) });
export type MailDealSuggestion = z.infer<typeof mailDealSuggestionSchema>;

// GET /api/mail/threads/:id. Messages are oldest-first (the conversation
// renders in that order) and every body_html has already had its stored
// `mailattachment:` placeholders resolved to real attachment routes -- the
// stored form never leaves the API (see api: mail-content.ts's
// resolveAttachmentUrls).
export const mailThreadDetailSchema = z.object({
  thread: mailThreadSchema,
  messages: z.array(mailMessageWithAttachmentsSchema),
  dealSuggestions: z.array(mailDealSuggestionSchema),
  // Phase 4.2: the conversation view's own copy of mailThreadListItemSchema's
  // `ownedByViewer` (same definition, same aggregate computation -- see that
  // field's comment) -- a sibling of `thread`/`messages`/`dealSuggestions`
  // rather than nested inside `thread`, because `thread` stays exactly the
  // mail_threads row shape (mailThreadSchema, shared with the list item via
  // `.extend()`) and this is a per-request, per-viewer derived fact about it,
  // the same relationship `dealSuggestions` already has to `thread`. Drives
  // the conversation view's single-thread Archive/Trash buttons (web:
  // conversation.tsx renders them only when this is true).
  ownedByViewer: z.boolean(),
  // Phase 4.3 (detail cap): how many messages this thread holds FOR THIS
  // VIEWER in total -- the same visibility-filtered set `messages` draws
  // from, so invisible messages count toward neither -- and whether
  // `messages` was truncated to the newest 50 of them (`?all=true` on the
  // detail route lifts the cap; the "Show earlier messages (N more)"
  // control derives N from totalMessages minus what it rendered). Both
  // describe THIS payload: an uncapped response, whether under the cap or
  // via all=true, carries truncated false and totalMessages =
  // messages.length -- an invariant that holds BY CONSTRUCTION, because the
  // server computes the counts as window aggregates on the page query
  // itself (one statement, one snapshot: a concurrent ingest cannot wedge a
  // contradiction between the page and its totals). The cap is a rendering
  // payload bound and nothing else
  // -- mark-read, the reply chain and ownedByViewer are still computed from
  // the full visible set server-side (api: mail-threads.ts's
  // getThreadDetail).
  totalMessages: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type MailThreadDetail = z.infer<typeof mailThreadDetailSchema>;

// POST /api/mail/threads/:id/read -- the thread as this viewer now sees it,
// plus whether the write actually flipped anything. `changed` is the
// CLIENT half of no-op suppression: the server already publishes no SSE
// hint when nothing was unseen (api: mail-threads.ts's markThreadRead), and
// this flag lets the requester skip its own invalidation cascade too --
// the conversation view fires mark-read unconditionally on open, so
// without it every click down an already-read inbox cost a round of
// refetches for a write that wrote nothing. SSE remains the always-path
// for REAL changes; this gates only the requester's own follow-ups.
export const markThreadReadResponseSchema = z.object({
  thread: mailThreadSchema,
  changed: z.boolean(),
});
export type MarkThreadReadResponse = z.infer<typeof markThreadReadResponseSchema>;

// GET /api/mail/unread-count -- distinct threads THE VIEWER HAS NOT HIDDEN
// holding at least one unseen message (per-user hides, Phase 4.3: a thread
// you filed away stops counting at you and keeps counting at everyone
// else). A count of THREADS, not messages: it drives the
// inbox nav badge, which counts conversations the way the thread list does.
// Messages sitting in their account's trash_folder do NOT count (Phase 4.1
// Task 4): trashing an unread message must not leave the badge counting it
// forever, and nothing ever re-sights an unsynced Trash to clear the flag.
// An ARCHIVED folder's unread messages DO count -- filing something is not
// reading it (api: mail-threads.ts's unreadThreadCount).
export const mailUnreadCountSchema = z.object({ count: z.number().int().nonnegative() });
export type MailUnreadCount = z.infer<typeof mailUnreadCountSchema>;

// GET /api/mail/unread-count?byFolder=1 -- the folder sidebar's badges
// (Phase 4.1 Task 4), one grouped query rather than one request per folder.
//
// Two things this shape deliberately does NOT do, both documented at the
// query (api: mail-threads.ts's unreadCountsByFolder):
//
// - it does NOT apply the trash exclusion above. Each count belongs to its
//   own folder row, so the Trash row's badge is the honest count of unread
//   mail in Trash; excluding it would make that row permanently read 0
//   while the messages under it are visibly unread.
// - it carries NO accountId, per the spec's shape. Folder names are
//   therefore counted across accounts: two accounts' INBOXes produce ONE
//   `INBOX` row holding both. Fine for the single-account case (Chris's,
//   and the reason the shape is this one); a multi-account sidebar that
//   wants per-account badges needs an account-scoped variant of this
//   endpoint, which v0.6.0 does not have.
export const mailUnreadFolderCountSchema = z.object({
  folder: z.string().min(1), count: z.number().int().nonnegative(),
});
export type MailUnreadFolderCount = z.infer<typeof mailUnreadFolderCountSchema>;

export const mailUnreadFolderCountsSchema = z.object({
  folders: z.array(mailUnreadFolderCountSchema),
});
export type MailUnreadFolderCounts = z.infer<typeof mailUnreadFolderCountsSchema>;

// Query-side filter contract for GET /api/mail/threads (route layer maps its
// snake_case querystring onto this camelCase shape, same division of labour
// as e.g. tasks.ts's listQuerySchema/listTasks). unread/unlinked/hidden
// are plain booleans here, not the wire tri-state string -- that coercion is
// the route's job, same as every other listQuerySchema in routes/*.ts.
export const threadListFiltersSchema = z.object({
  accountId: z.uuid().optional(),
  unread: z.boolean().optional(),
  unlinked: z.boolean().optional(),
  companyId: z.uuid().optional(), contactId: z.uuid().optional(),
  dealId: z.uuid().optional(), projectId: z.uuid().optional(),
  // Phase 4.3: the Hidden view. Absent (or false) = the default view,
  // threads the VIEWER has not hidden; true = only the viewer's hidden
  // threads, the inbox's Hidden filter (spec: `?hidden=true` on the thread
  // list). Applied against the viewer's own mail_thread_hides rows (api:
  // mail-threads.ts's hiddenByViewer), composed with -- never replacing --
  // the 4.2 visibility predicate, so the Hidden view still shows only what
  // its viewer may see and every other filter here works in both views.
  // Renames the pre-4.3 `archived` flag to match what the UI has called it
  // since 4.1 ("Hide in CRM") and what it now actually is.
  hidden: z.boolean().optional(),
  // The folder view driving the thread list (Phase 4.1): threads with >= 1
  // message in this folder (spec) -- absent means "every synced folder",
  // same as every other optional filter here. When accountId AND folder are
  // BOTH present, the route must build ONE combined EXISTS (a single
  // subquery testing account_id = ? AND folder = ? together), never two
  // separate per-filter EXISTS clauses -- the latter would each pass
  // independently for a thread whose INBOX message sits on account A and
  // whose matching-folder message sits on a DIFFERENT account B, wrongly
  // including it in the result (Task 4).
  folder: folderNameSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type ThreadListFilters = z.infer<typeof threadListFiltersSchema>;

// The three bulk/single-thread mail actions (Phase 4.1). trash/archive MOVE
// the underlying messages server-side (api: services/mail-move.ts); hide is
// the CRM-side, PER-ACTOR filing act (one mail_thread_hides row per thread
// for the requesting user, Phase 4.3) applied in bulk, named "Hide in CRM"
// in the UI so it is never confused with the other two (spec).
export const bulkThreadActionKindSchema = z.enum(["trash", "archive", "hide"]);
export type BulkThreadActionKind = z.infer<typeof bulkThreadActionKindSchema>;

// POST /api/mail/threads/bulk body (Task 4). folder is OPTIONAL and carries
// two distinct modes (spec, Move write-back). PRESENT means folder-scoped --
// the list multi-select case, where folder is the VIEW the selection was
// made in and the move service acts only on each thread's messages
// currently sitting in THAT folder, per the selection-granularity ruling.
// ABSENT means whole-thread semantics -- the single-thread buttons
// (conversation view, record Mail tabs), where the move service instead
// acts on ALL of the thread's messages EXCEPT those already in the target
// folder and those in the account's sent folder (archiving a conversation
// must never empty Sent). Either way, trash/archive target the owning
// account's trash_folder/archive_folder (spec: "only Trash/Archive targets
// in v0.6.0"); `hide` ignores folder entirely in both modes -- it is the
// per-actor CRM-side filing act (mail_thread_hides, Phase 4.3), which has
// no concept of an IMAP folder at all.
// threadIds capped at 200: large enough for a full page of multi-select,
// small enough that one request's per-account IMAP MOVE queueing stays
// bounded; `.min(1)` because a bulk action against zero threads is not a
// request, it's a bug in whatever sent it.
//
// 200 is the OUTER bound, and only `hide` reaches it. trash/archive wait on
// a real mail server -- each queued MOVE runs on its account's serial sync
// loop -- so the route applies a tighter per-action cap of 50 to those two
// and rejects a larger request with the uniform 400 (api: routes/mail.ts's
// bulk endpoint, Task 4 ruling). The CHECK lives there rather than in this
// schema because it is a property of the ACTION, not of the body shape, and
// this schema is also what the whole-thread single-id callers parse through
// -- but the NUMBER lives here, next to the outer bound it tightens, because
// the web client mirrors it too (web: mail-lib's select-all cap and its
// per-action disable), and three copies of 50 in three packages is three
// chances for the client to build a request the server answers with a 400.
export const BULK_THREAD_ACTION_CAP = 200;
export const MOVE_ACTION_THREAD_CAP = 50;

export const bulkThreadActionInputSchema = z.object({
  threadIds: z.array(z.uuid()).min(1).max(BULK_THREAD_ACTION_CAP),
  folder: folderNameSchema.optional(),
  action: bulkThreadActionKindSchema,
});
export type BulkThreadActionInput = z.infer<typeof bulkThreadActionInputSchema>;

// One entry of POST /api/mail/threads/bulk's response, in the same order as
// the request's threadIds so the client can zip failures back to specific
// rows for the toast/inline-alert (spec, Frontend section). Two
// correlations are enforced structurally here, not left to convention:
// `error` is present IFF `ok` is false (mirroring
// mailAccountTestResultSchema's per-protocol shape above), and
// `skipped: true` can only accompany `ok: true` -- a skip is the move
// service finding nothing eligible to move in this thread's relevant scope,
// which is a successful no-op, not a failure. Four things produce it
// (spec, Move write-back step 1, plus Phase 4.2's ownership rule): every
// in-scope message was awaiting reconciliation (NULL imap_uid), every one
// was already in the target folder, every one belongs to an ARCHIVED mail
// account -- whose rows survive but cannot be moved while the account stays
// archived (unarchiving in Settings restores its sync loop) -- or every one
// sits on an account the ACTOR does not own (Phase 4.2: move rights are
// owner-only), and are therefore excluded rather than failed: from the mail
// view the failure would be unactionable.
// WHY a thread failed, as a code rather than a sentence. `error` stays for
// display -- it carries the account label, or the server's own refusal text --
// but a client must never branch on English (the house rule api.ts states for
// every error shape): a UI that groups failures, offers "open Settings" for
// the fixable ones, or counts skips needs something stable, and these are it.
//
// Every value maps to one decision in services/mail-move.ts:
// - no_sync: the account has no running sync loop (and is not archived).
//   Not best-effort-skippable -- moving the rows with nothing to carry the
//   MOVE out would leave the CRM claiming a move that never happened.
// - no_target: trash_folder/archive_folder is NULL for that account, the
//   spec's "detect this for me" state. Fixable in Settings, or by waiting for
//   a discovery pass.
// - not_found: no such thread id.
// - server_refused: the queued IMAP MOVE was rejected; the optimistic rows
//   have been put back. `error` carries the server's text.
export const bulkThreadFailureReasonSchema = z.enum([
  "no_sync", "no_target", "not_found", "server_refused",
]);
export type BulkThreadFailureReason = z.infer<typeof bulkThreadFailureReasonSchema>;

// WHY a thread was a no-op. The first four are the spec's
// empty-eligible-set causes (Move write-back, step 1, plus Phase 4.2's
// ownership rule), listed in the precedence mail-move.ts's SKIP_REASON_RANK
// applies when one thread hits several:
// - archived_account: its messages belong to an archived mail account, whose
//   sync loop is torn down. Persistent, and fixable only in Settings, so it
//   outranks the others.
// - not_owner (Phase 4.2): its messages sit on an account the ACTOR does not
//   own -- move rights are owner-only (spec:
//   "a colleague must never reorganise your actual mailbox"). Ranked directly
//   below archived_account, NOT above it, for continuity: archived_account is
//   what a mixed thread already reported before 4.2, and keeping it at rank 0
//   means adding not_owner changes no existing thread's reported reason (an
//   archived account someone else owns keeps saying archived_account -- see
//   mail-move.ts's SKIP_REASON_RANK comment, whose per-row check order agrees
//   on purpose). It still outranks the two self-resolving reasons below,
//   which clear on their own or by simply asking again. UNLIKE
//   out_of_scope, this one IS recorded against individual messages (a message
//   this actor cannot move is still examined and classified, not skipped
//   before it is looked at), which is what makes it a NotedSkipReason and
//   gives it a rank slot at all -- see mail-move.ts's own NotedSkipReason
//   comment for that distinction. The precedence only matters when one
//   thread's messages hit more than one cause at once, which is rare.
// - awaiting_reconciliation: NULL imap_uid -- a just-sent message the Sent
//   pass has not re-sighted. Transient; asking again after the next pass
//   works.
// - already_in_target: everything in scope is already in the target folder.
//   The intended end state already holds.
// - out_of_scope: nothing of this thread was in scope AT ALL -- in the
//   folder-scoped mode every message is in some other folder, and in the
//   whole-thread mode the conversation is nothing but Sent mail (which
//   archiving must never empty). Distinct from already_in_target, which
//   reports the goal as reached; this one reports that the action never
//   applied to this thread, which is a different sentence to show a user and
//   the reason it is its own value rather than a fourth meaning loaded onto
//   the third. It takes no part in the precedence above: it is never recorded
//   against a message, only used when a thread finishes with no reason at all.
export const bulkThreadSkipReasonSchema = z.enum([
  "archived_account", "not_owner", "awaiting_reconciliation", "already_in_target", "out_of_scope",
]);
export type BulkThreadSkipReason = z.infer<typeof bulkThreadSkipReasonSchema>;

export const bulkThreadResultReasonSchema = z.enum([
  ...bulkThreadFailureReasonSchema.options, ...bulkThreadSkipReasonSchema.options,
]);
export type BulkThreadResultReason = z.infer<typeof bulkThreadResultReasonSchema>;

const FAILURE_REASONS = new Set<string>(bulkThreadFailureReasonSchema.options);
const SKIP_REASONS = new Set<string>(bulkThreadSkipReasonSchema.options);

const bulkThreadResultItemSchema = z.object({
  threadId: z.uuid(),
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
  reason: bulkThreadResultReasonSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.ok && v.error !== undefined) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "error must be absent when ok is true" });
  }
  if (!v.ok && v.error === undefined) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "error is required when ok is false" });
  }
  if (v.skipped === true && !v.ok) {
    ctx.addIssue({ code: "custom", path: ["skipped"], message: "skipped can only be true when ok is true" });
  }
  // A plain success is the one outcome with nothing to explain, so `reason` is
  // present exactly when there IS something -- a failure or a skip -- and its
  // half of the enum has to match which of the two it is. Enforced here rather
  // than left to convention, because a client switching on `reason` to decide
  // what to show would otherwise have to re-derive the flags it belongs to.
  const explained = !v.ok || v.skipped === true;
  if (explained && v.reason === undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is required when ok is false or skipped is true" });
  }
  if (!explained && v.reason !== undefined) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "reason must be absent on a plain success" });
  }
  if (v.reason !== undefined) {
    if (!v.ok && !FAILURE_REASONS.has(v.reason)) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a failure must carry a failure reason" });
    }
    if (v.skipped === true && !SKIP_REASONS.has(v.reason)) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "a skip must carry a skip reason" });
    }
  }
});
export const bulkThreadResultSchema = z.object({
  results: z.array(bulkThreadResultItemSchema),
});
export type BulkThreadResult = z.infer<typeof bulkThreadResultSchema>;

export const mailLinkKindSchema = z.enum(["company", "contact", "deal", "project"]);
export type MailLinkKind = z.infer<typeof mailLinkKindSchema>;

// Body shape for both POST /api/mail/threads/:id/links (set) and DELETE
// .../links/:kind (unlink uses only the path param, but kind+id together
// describe "this one link" as a single addressable value either way).
export const threadLinksInputSchema = z.object({
  kind: mailLinkKindSchema,
  id: z.uuid(),
});
export type ThreadLinksInput = z.infer<typeof threadLinksInputSchema>;

// Compose-side counterpart to mailAddressSchema: human-typed (or picked from
// a contact-address autocomplete) rather than parsed off the wire, so it can
// afford to hold the line at z.email() -- unlike inbound mail, a compose
// recipient the user typed wrong should be rejected before it reaches SMTP.
const composeAddressSchema = z.object({
  address: z.email(), name: z.string().min(1).nullable().optional(),
});

// Compose and reply share one shape (spec, Send path): threadId is present
// only when replying, absent when composing fresh. links pre-links a
// brand-new thread the way the compose dialog does when opened from a
// contact/company/deal/project page -- meaningless (and ignored) on a reply,
// which already has a thread.
export const sendMailInputSchema = z.object({
  accountId: z.uuid(),
  threadId: z.uuid().optional(),
  to: z.array(composeAddressSchema).min(1),
  cc: z.array(composeAddressSchema).optional().default([]),
  bcc: z.array(composeAddressSchema).optional().default([]),
  subject: z.string(),
  bodyHtml: z.string().min(1),
  // files.id, not mail_attachments.id -- attachments are uploaded first
  // through the existing multipart flow (spec, Send path) and referenced
  // here by that upload's id; mail_attachments rows only exist for messages
  // already ingested, which an in-progress compose is not.
  attachmentIds: z.array(z.uuid()).optional().default([]),
  // mail_attachments.id, the OTHER table (Phase 4.3, closing the v0.5.0
  // "forward no re-attach" limitation): a forward's re-attached originals,
  // streamed onto the outgoing mail from the same stored blobs the
  // attachment download route serves. A separate field rather than a widened
  // attachmentIds because the two name different rights as well as different
  // tables: an upload is a files row the actor OWNS, a forwarded original is
  // a mail_attachments row the actor may READ (record-scope visibility, the
  // download route's own rule -- api: mail-send.ts's loadForwardAttachments).
  // That right is the whole contract: the name says "forward" because that
  // is the flow that sends it, but the field accepts any record-readable
  // attachment id from any message -- the equivalent of downloading and
  // re-attaching, minus the round trip. Duplicate ids attach ONCE (the
  // service dedupes, first occurrence's position wins). max(50) mirrors
  // ingest's MAX_ATTACHMENTS -- no stored message holds more, so no honest
  // forward names more -- and it is checked on the RAW list, before the
  // server's dedupe: 51 entries 400 even when deduping would bring them
  // under the cap, because a request that repeats itself past the limit is
  // malformed, not generously interpretable. (attachmentIds above carries
  // no max of its own -- pre-existing, deliberately left untouched here.)
  forwardAttachmentIds: z.array(z.uuid()).max(50).optional().default([]),
  links: z.object({
    companyId: z.uuid().optional(), contactId: z.uuid().optional(),
    dealId: z.uuid().optional(), projectId: z.uuid().optional(),
  }).optional(),
});
export type SendMailInput = z.infer<typeof sendMailInputSchema>;

export const emailTemplateSchema = z.object({
  id: z.uuid(), name: z.string().min(1), subject: z.string(), bodyHtml: z.string().min(1),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const createEmailTemplateInputSchema = z.object({
  name: z.string().min(1), subject: z.string().optional(), bodyHtml: z.string().min(1),
});
export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateInputSchema>;
export const updateEmailTemplateInputSchema = createEmailTemplateInputSchema.partial();
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateInputSchema>;

export const searchResultsSchema = z.object({
  companies: z.array(z.object({ id: z.uuid(), name: z.string() })),
  contacts: z.array(z.object({
    id: z.uuid(), firstName: z.string(), lastName: z.string().nullable(),
    emails: z.array(z.string()),
  })),
  notes: z.array(z.object({
    id: z.uuid(), companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
    snippet: z.string(),
  })),
  deals: z.array(z.object({ id: z.uuid(), title: z.string() })),
  // Title ILIKE, archived excluded, done included -- see services/search.ts's
  // tasks-group query for why a done task still matters (finding finished
  // work by name is a feature, mirroring the deals group's won-deal rule).
  tasks: z.array(z.object({ id: z.uuid(), title: z.string(), projectId: z.uuid().nullable() })),
  // The one group that is full-text rather than ILIKE: mail_messages carries
  // a generated tsvector (schema.ts), so this group is
  // websearch_to_tsquery + ts_rank rather than a substring scan. Grouped by
  // THREAD, not message -- a hit means "this conversation matches", and the
  // id a client navigates to is the thread's. subject/snippet come from the
  // best-ranked message in that thread, so the excerpt shown is the one that
  // actually matched, not the newest message's.
  mail: z.array(z.object({
    threadId: z.uuid(),
    // Message subject, not thread subject: both can legitimately be "".
    subject: z.string(),
    snippet: z.string(),
  })),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

// --- Meetings (Phase 5) --------------------------------------------------

// The three mutually exclusive ways to name one attendee (spec's Attendees
// decision): a linked CRM contact, a Conduit user, or a free-text guest for
// someone in neither ("and their lawyer"). One field record, two schemas --
// the stored row below and the input shape it is derived into -- so a fourth
// kind of attendee could never arrive on one and not the other.
const attendeeIdentityFields = {
  contactId: z.uuid().nullable(),
  userId: z.uuid().nullable(),
  // Trimmed BEFORE .min(1), the same order folderNameSchema uses: a
  // whitespace-only guest name is a 400 here rather than a nameless attendee
  // row that satisfies both this schema and the exactly-one CHECK (which only
  // counts non-nulls, and "   " is not null). The stored value is the trimmed
  // one -- api: services/meetings.ts trims again for a direct service caller
  // that bypasses this gate.
  guestName: z.string().trim().min(1).nullable(),
};

// This predicate and the meeting_attendees_exactly_one DB CHECK
// (num_nonnulls(contact_id, user_id, guest_name) = 1, api: db/schema.ts) are
// ONE RULE WRITTEN IN TWO PLACES -- the same relationship exactlyOneEntity
// above has with notes_exactly_one_entity. Changing either without the other
// splits the contract: the API would start accepting shapes the database
// rejects (a 500 where a 400 belongs) or refusing rows the database would
// happily store. `!= null` covers undefined too, so this reads identically on
// the stored row (three nullable fields) and on the input shape (the same
// three, optional).
//
// The key list is DERIVED from attendeeIdentityFields rather than restated,
// which is what makes that record's "a fourth kind of attendee could never
// arrive on one and not the other" claim true of this predicate as well. A
// hand-written list would fail PERMISSIVELY on a fourth kind -- zod would
// accept a row naming two identities, and the CHECK would raise 23514 as a
// 500 where a 400 belongs.
const attendeeIdentityKeys = Object.keys(attendeeIdentityFields) as
  (keyof typeof attendeeIdentityFields)[];

const attendeeExactlyOne = (
  v: { contactId?: string | null; userId?: string | null; guestName?: string | null },
) => attendeeIdentityKeys.filter((key) => v[key] != null).length === 1;

const attendeeExactlyOneMessage =
  "exactly one of contactId, userId or guestName identifies an attendee";

export const meetingAttendeeSchema = z
  .object({ id: z.uuid(), meetingId: z.uuid(), ...attendeeIdentityFields })
  .superRefine((v, ctx) => {
    if (!attendeeExactlyOne(v)) ctx.addIssue({ code: "custom", message: attendeeExactlyOneMessage });
  });
export type MeetingAttendee = z.infer<typeof meetingAttendeeSchema>;

// What a caller sends per attendee: the same three fields, each optional
// (naming a contact means sending contactId alone, not the other two as
// explicit nulls). meetingId comes from the meeting being written and `id` is
// server-side, so both are absent here -- attendees are replaced as a SET on
// update (spec), never patched row by row, so a client never needs to name an
// existing attendee row's id.
export const meetingAttendeeInputSchema = z
  .object(attendeeIdentityFields).partial()
  .superRefine((v, ctx) => {
    if (!attendeeExactlyOne(v)) ctx.addIssue({ code: "custom", message: attendeeExactlyOneMessage });
  });
export type MeetingAttendeeInput = z.infer<typeof meetingAttendeeInputSchema>;

/**
 * This predicate and the meetings_has_link DB CHECK
 * (num_nonnulls(company_id, contact_id, deal_id, project_id) >= 1, api:
 * db/schema.ts) are likewise ONE RULE IN TWO PLACES -- the spec's
 * reachability decision, which exists because v0.9.0 ships no top-level
 * meetings list: a meeting linked to nothing could never be reached again
 * from any screen. AT LEAST one, not exactly one (the events multi-FK model,
 * not notes' exactly-one): a deal meeting legitimately carries its company
 * too, and appears on both records.
 *
 * Exported for the same reason taskDatesPaired above is: services/meetings.ts's
 * updateMeeting must re-assert this invariant against the MERGED row (the
 * stored links with the patch applied), because meetingUpdateInputSchema
 * deliberately carries no such refine -- a patch sees one snapshot, never its
 * persisted counterpart, so only the service can tell "clearing companyId
 * while dealId stays" from "clearing the last link". Without that check the
 * CHECK fires and a 400 arrives as a 500. The parameter type accepts a merge
 * result unchanged.
 */
export function meetingAtLeastOneLink(
  v: { companyId?: string | null; contactId?: string | null; dealId?: string | null; projectId?: string | null },
): boolean {
  return [v.companyId, v.contactId, v.dealId, v.projectId].some((x) => x != null);
}

export const meetingSchema = z.object({
  id: z.uuid(), title: z.string().min(1),
  // Past OR future: logging a meeting just had and noting one just arranged
  // are the same act (spec). No ordering constraint against createdAt.
  occurredAt: z.iso.datetime(),
  // Positive, and NULL for the honest "nobody recorded how long it ran"
  // (spec). The DB column carries no matching CHECK -- deliberately, since
  // the spec's data model lists none: this schema is the gate, the way
  // contacts.emails' format is zod-only (see that column's comment in api:
  // db/schema.ts), rather than the belt-and-braces pattern
  // projects.color/tasks.progress_pct use.
  durationMinutes: z.number().int().positive().nullable(),
  // Rich-text HTML, sanitized server-side on write (api: services/meetings.ts,
  // Task 2). "" is not a value: an empty note is NULL.
  notes: nullableString,
  ownerUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(),
  dealId: z.uuid().nullable(), projectId: z.uuid().nullable(),
  // Always carried, never a separate fetch: a meeting without its attendees
  // is not a meeting, and the rail's LIST rows render an attendee summary
  // (spec's Web section), so there is no read path that wants the bare row.
  // The follow-up tasks themselves ride the DETAIL payload below, not this
  // shape.
  attendees: z.array(meetingAttendeeSchema),
  // How many follow-up tasks this meeting produced -- a count on every
  // meeting, the full tasks only on meetingDetailSchema, which is the split
  // mailThreadSchema/mailThreadDetailSchema already draws (a list row renders
  // a number, a detail view renders the things). The rail's list shows
  // "title, when, attendee summary, task count" (spec's Web section), so a
  // page of rows must not pay for every task's full shape.
  //
  // Derived at read time from events.meeting_id (api: services/meetings.ts),
  // never a stored column: the meeting-to-task link already exists as an
  // event, and a second copy of it would be a second source of truth.
  taskCount: z.number().int().nonnegative(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Meeting = z.infer<typeof meetingSchema>;

// GET /api/meetings/:id. The meeting plus the follow-up tasks it produced
// (Task 3's POST /api/meetings/:id/tasks writes them; this shape reads them
// back), a sibling of `meeting` rather than a field inside it for the same
// reason mailThreadDetailSchema keeps `messages` beside `thread`: `meeting`
// stays exactly the row shape every other meeting-returning path answers
// with, and the collection only a detail view needs stays out of it.
export const meetingDetailSchema = z.object({
  meeting: meetingSchema,
  tasks: z.array(taskSchema),
});
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

// ownerUserId is absent on purpose: the owner is the actor, stamped
// server-side, the same rule notes' authorUserId and mail accounts' userId
// follow -- never a caller-supplied field.
const meetingInputShape = z.object({
  title: z.string().min(1),
  occurredAt: z.iso.datetime(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  notes: nullableString.optional(),
  companyId: z.uuid().nullable().optional(), contactId: z.uuid().nullable().optional(),
  dealId: z.uuid().nullable().optional(), projectId: z.uuid().nullable().optional(),
  // Absent means "no attendees" on create and "leave the set alone" on
  // update; present replaces the whole set, including with [] (api:
  // services/meetings.ts, Task 2).
  attendees: z.array(meetingAttendeeInputSchema).optional(),
});

export const meetingCreateInputSchema = meetingInputShape.superRefine((v, ctx) => {
  if (!meetingAtLeastOneLink(v)) {
    ctx.addIssue({
      code: "custom",
      message: "at least one of companyId, contactId, dealId or projectId is required",
    });
  }
});
export type MeetingCreateInput = z.infer<typeof meetingCreateInputSchema>;

// The at-least-one-link refine deliberately does NOT ride the patch shape,
// for the same reason taskDatesPaired documents on its own update schema: a
// partial update sees one snapshot, never the row's persisted counterpart.
// A patch clearing companyId on a meeting that also carries a dealId is
// legitimate and must not be rejected, while a patch that genuinely empties
// the last link can only be caught against the stored row -- which is what
// meetings_has_link does, as the backstop it exists to be. Task 2's
// updateMeeting therefore re-asserts the rule against the merged row --
// through the exported meetingAtLeastOneLink above, never a second copy of
// it -- and surfaces the failure as a 4xx rather than letting the CHECK
// raise a 500.
export const meetingUpdateInputSchema = meetingInputShape.partial();
export type MeetingUpdateInput = z.infer<typeof meetingUpdateInputSchema>;

// Query-side filter contract for GET /api/meetings, the Meetings rail tab's
// shape -- the same division of labour as threadListFiltersSchema above: the
// route maps its querystring onto this, so `archived` is a plain boolean
// here, not the wire's "true"/"false"/absent tri-state (that coercion is the
// route's job, per routes/companies.ts's listQuerySchema comment on why
// z.coerce.boolean() cannot be used for it).
//
// The four record filters are NOT mutually exclusive in shape, but a caller
// sends exactly one in practice (one rail, one record). contactId is the one
// that is not a plain FK match: it also matches meetings where that contact
// is an ATTENDEE (api: services/meetings.ts's listMeetings, Task 2), which is
// what makes contact attendance a real link (spec).
export const meetingListFiltersSchema = z.object({
  companyId: z.uuid().optional(), contactId: z.uuid().optional(),
  dealId: z.uuid().optional(), projectId: z.uuid().optional(),
  // true = ONLY archived meetings, absent/false = only live ones -- the house
  // semantics every archived list uses (api: services/companies.ts's
  // listCompanies).
  archived: z.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type MeetingListFilters = z.infer<typeof meetingListFiltersSchema>;

/**
 * Body of POST /api/meetings/:id/tasks -- the follow-up task a meeting
 * produces (spec's Follow-ups decision).
 *
 * DERIVED from the same shape createTaskInputSchema is built on, minus the
 * four record links, rather than restated: a task field added later (a
 * priority, an estimate) arrives on this affordance too, where a hand-copied
 * list would silently leave the meeting's Add-task form behind the task
 * drawer's. The .refine is re-applied because .omit() returns the bare object
 * shape, and a follow-up task obeys tasks_dates_paired exactly like any other
 * (the whole point of routing this through createTask).
 *
 * THE LINKS ARE OMITTED BECAUSE THEY ARE INHERITED: the task takes the
 * meeting's company/contact/deal/project, which is what "lands in the right
 * place without re-picking" means in the spec. api: services/meetings.ts's
 * createMeetingTask treats those as DEFAULTS and lets a caller-supplied link
 * win, so the merge stays correct for a direct service caller; this wire
 * shape simply does not offer the override in v0.9.0, and zod's non-strict
 * parse drops a link sent anyway.
 */
export const meetingTaskCreateInputSchema = taskInputShape
  .omit({ companyId: true, contactId: true, dealId: true, projectId: true })
  .refine(taskDatesPaired, {
    message: "startDate and dueDate must both be set (with startDate <= dueDate) or both omitted",
  });
export type MeetingTaskCreateInput = z.infer<typeof meetingTaskCreateInputSchema>;

/* ========================================================================== *
 *  DOCUMENTS (Phase 7)
 * ========================================================================== */

/**
 * A NUL, or half of a surrogate pair. Both are legal JSON and neither can be stored.
 *
 * **THIS WAS A FOURTH POST-RENDER 500.** `{"description": "a\u0000b"}` parses, passes
 * every bound, is charged one byte, survives the merge and the sanitiser, allocates a
 * number, SPAWNS python3 AND RENDERS, writes the blob, and then fails the INSERT with
 * `22021 invalid byte sequence` -- unmapped, so a bare 500 and an orphan blob, for a
 * value the form had called fine. It is the same shape as the three CHECK constraints
 * Step 5a exists to gate, with a fourth SQLSTATE.
 *
 * Postgres `text` holds any character except U+0000; an unpaired surrogate is the
 * other way to produce a byte sequence that is not valid UTF-8. Neither has any
 * business on a quote.
 */
const UNSTORABLE_TEXT = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A user-supplied string bounded in length and refused if a column could not hold it.
 *
 * `min` is a PARAMETER rather than something a caller chains on afterwards, and that
 * is not tidiness: `documentText(250).min(1)` type-checks, returns a fresh schema and
 * silently drops the refinement, so a description containing a NUL sails through and
 * fails the INSERT exactly as before. Every bound has to be inside the one expression.
 */
function documentText(max: number, min = 0) {
  return z.string().min(min).max(max).refine((value) => !UNSTORABLE_TEXT.test(value), {
    message: "text may not contain a NUL or an unpaired surrogate",
  });
}

/** The one document type v1.0.0 ships. `documents_type_valid` CHECKs the same set. */
export const documentTypeSchema = z.enum(["quote"]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * The UTF-8 cost of a value once it has been merged into a document, escaping
 * included.
 *
 * `&` becomes `&amp;` and `<` and `>` become `&lt;`/`&gt;`, all measured against the
 * shipped template. `"` and `'` cost ONE byte in text position -- escaped on the way
 * in and re-serialised bare -- and SIX in an attribute, which this cannot know from
 * the value alone. See DOCUMENT_CONTENT_BUDGET_BYTES for why that is an approximation
 * error rather than a correctness one.
 */
function escapedBytes(value: string): number {
  let bytes = new TextEncoder().encode(value).length;
  for (const char of value) {
    if (char === "&") bytes += 4;
    else if (char === "<" || char === ">") bytes += 3;
  }
  return bytes;
}

/** What an issuer profile will cost a render: its text, escaped, plus its logo. */
export function orgProfileBytes(profile: {
  name: string; addressLines: string; vatNumber: string; registrationNumber: string;
  email: string; phone: string; website: string; bankDetails: string; logoDataUri: string;
}): number {
  return escapedBytes(profile.name) + escapedBytes(profile.addressLines)
    + escapedBytes(profile.vatNumber) + escapedBytes(profile.registrationNumber)
    + escapedBytes(profile.email) + escapedBytes(profile.phone)
    + escapedBytes(profile.website) + escapedBytes(profile.bankDetails)
    + profile.logoDataUri.length;
}

/**
 * THE LOGO'S TWO BOUNDS, AND THEY ARE NOT THE SAME NUMBER.
 *
 * `MAX_LOGO_BYTES` bounds the IMAGE. `MAX_LOGO_DATA_URI_CHARS` bounds the COLUMN,
 * which holds base64 -- 4 characters per 3 bytes, plus the longest permitted prefix.
 * Reusing the first as the second would silently shrink the permitted logo to 24KB
 * and nothing would say so: every rejected upload would look like a user's mistake.
 *
 * 32KB of image is the figure the spec names. It reaches the renderer inlined at 4/3
 * of its size against a 128KB input cap, so it leaves the document itself roughly
 * three quarters of the budget.
 *
 * `org_profile_logo_size` CHECKs the same character count, and a test asserts the
 * constraint's literal equals this constant so the two cannot drift.
 */
export const MAX_LOGO_BYTES = 32 * 1024;
const LONGEST_LOGO_PREFIX = "data:image/jpeg;base64,".length;
export const MAX_LOGO_DATA_URI_CHARS = Math.ceil(MAX_LOGO_BYTES / 3) * 4 + LONGEST_LOGO_PREFIX;

const LOGO_DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The first `wanted` bytes of a base64 payload, decoded by hand.
 *
 * BY HAND BECAUSE NEITHER `atob` NOR `Buffer` IS AVAILABLE IN BOTH PLACES this
 * module runs, which is the same constraint that keeps the size check to
 * arithmetic. Only a dozen bytes are ever needed, so the cost is nil and the
 * portability is total.
 */
function decodeBase64Prefix(base64: string, wanted: number): number[] {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of base64) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) break;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= wanted) break;
    }
  }
  return out;
}

function startsWithBytes(bytes: readonly number[], signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * WHAT EACH DECLARED TYPE'S BYTES MUST ACTUALLY LOOK LIKE.
 *
 * A `data:` URI's media type is a CLAIM MADE BY WHOEVER BUILT IT, and in a
 * browser it comes from `File.type`, which is derived from the file's extension
 * rather than its contents. So `logo.svg` renamed to `logo.png` arrives as
 * `data:image/png;base64,<svg...>`, matched the prefix regex, and was stored --
 * and WeasyPrint, which sniffs properly, drew it as vector art on the quote.
 * The spec excludes SVG on purpose (it is a document format with its own
 * URL-bearing elements, arriving where neither the document sanitiser nor the
 * renderer's fetcher looks inside it), and until this existed that exclusion
 * was enforced only against a file honest enough to admit what it was.
 *
 * Not a vulnerability when it was found -- a spec reviewer built an SVG
 * carrying `file://` and loopback references and the render was refused with
 * `document referenced a blocked resource`, canary atime unchanged, no number
 * spent. Task 3's fetcher held. This is the layer in front of it doing its own
 * job rather than relying on that.
 */
const LOGO_SIGNATURES: Record<string, (bytes: readonly number[]) => boolean> = {
  png: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]),
  // "GIF8" then "7a" or "9a".
  gif: (b) => startsWithBytes(b, [0x47, 0x49, 0x46, 0x38])
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  // "RIFF", four bytes of length, then "WEBP" -- so twelve bytes are needed,
  // which is exactly what sixteen base64 characters carry.
  webp: (b) => startsWithBytes(b, [0x52, 0x49, 0x46, 0x46])
    && startsWithBytes(b.slice(8), [0x57, 0x45, 0x42, 0x50]),
};

/**
 * Why this string cannot be a logo, or null if it can. "" is a logo-less profile and
 * is always fine.
 *
 * A FUNCTION RATHER THAN A REGEX IN A SCHEMA, because the size bound is the half that
 * matters and it is arithmetic: the decoded length is exactly `4/3` of the base64
 * minus its padding, so it can be checked without decoding -- which matters because
 * this runs in a browser and on a server and `atob` and `Buffer` are not both there.
 *
 * SVG IS DELIBERATELY NOT ALLOWED. It is a document format with its own URL-bearing
 * elements, and it would arrive inside a `data:` URI where neither the document
 * sanitiser nor the renderer's fetcher looks inside it.
 *
 * AND THE TYPE IN THE URI IS NOT EVIDENCE OF ANYTHING, which is why the last check
 * reads the bytes. In a browser that string comes from `File.type`, which is decided
 * by the file's EXTENSION -- so an SVG renamed to .png declares `image/png`, passes
 * every check above, and gets drawn as vector art by a renderer that sniffs properly.
 * See LOGO_SIGNATURES.
 */
export function logoDataUriProblem(uri: string): string | null {
  if (uri === "") return null;
  if (!LOGO_DATA_URI.test(uri)) {
    return "a logo must be a base64 data: URI for a PNG, JPEG, GIF or WEBP image";
  }
  if (uri.length > MAX_LOGO_DATA_URI_CHARS) {
    return `a logo must be ${String(MAX_LOGO_BYTES)} bytes or less`;
  }
  const base64 = uri.slice(uri.indexOf(",") + 1);
  if (base64.length % 4 !== 0) return "the logo's base64 data is malformed";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  if (bytes > MAX_LOGO_BYTES) {
    return `a logo must be ${String(MAX_LOGO_BYTES)} bytes or less; this one is ${String(bytes)}`;
  }
  // The declared type has to be backed by the payload's own leading bytes.
  // Sixteen base64 characters carry the twelve bytes the widest signature needs.
  const declared = LOGO_DATA_URI.exec(uri)?.[1];
  const signature = declared === undefined ? undefined : LOGO_SIGNATURES[declared];
  if (signature === undefined || !signature(decodeBase64Prefix(base64.slice(0, 16), 12))) {
    return `a logo's contents must really be a ${String(declared)} image;`
      + " this file's data does not match the type it claims";
  }
  return null;
}

/**
 * The issuer: your own company, as printed at the top of a quote. A singleton, so
 * there is no id on the wire -- `org_profile` is pinned at id 1 and a caller has no
 * business naming it.
 *
 * Every field defaults to "" rather than being nullable, matching the columns: an
 * install that has filled in nothing is an ordinary state, not missing data, and the
 * seeded template wraps each of these in a conditional so an empty one prints neither
 * a label nor a blank.
 *
 * THE LOGO IS THE BYTES, not a file id. It was a `files` reference until Task 4's
 * review: `files_exactly_one_entity` requires every file to belong to exactly one
 * company, contact, deal or project, and an issuer's logo belongs to none of them, so
 * no legal row existed for that reference to name. It is stored as the `data:` URI
 * the renderer will accept and nothing else.
 */
export const orgProfileSchema = z.object({
  name: z.string(),
  addressLines: z.string(),
  vatNumber: z.string(),
  registrationNumber: z.string(),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
  bankDetails: z.string(),
  logoDataUri: z.string(),
  updatedAt: z.iso.datetime(),
});
export type OrgProfile = z.infer<typeof orgProfileSchema>;

/**
 * PUT /api/org-profile's body. A total replacement rather than a patch: it is one
 * form with nine fields and no concurrent editors, so "send me the form" is both the
 * simplest contract and the one where clearing a field is expressible.
 *
 * The field lengths are the only bound the columns do not carry (they are `text`),
 * and they exist because every one of these prints on the page: an address of a
 * megabyte is a quote that cannot render, discovered at issue time rather than here.
 * The measured contribution of these fields to a render is in DOCUMENT_MAX_LINES's
 * comment, which is sized around them.
 */
export const ORG_PROFILE_FIELD_CAPS = {
  name: 200,
  addressLines: 2000,
  vatNumber: 100,
  registrationNumber: 100,
  email: 200,
  phone: 100,
  website: 200,
  bankDetails: 500,
} as const;

export const orgProfileInputSchema = z.object({
  name: documentText(ORG_PROFILE_FIELD_CAPS.name),
  addressLines: documentText(ORG_PROFILE_FIELD_CAPS.addressLines),
  vatNumber: documentText(ORG_PROFILE_FIELD_CAPS.vatNumber),
  registrationNumber: documentText(ORG_PROFILE_FIELD_CAPS.registrationNumber),
  email: documentText(ORG_PROFILE_FIELD_CAPS.email),
  phone: documentText(ORG_PROFILE_FIELD_CAPS.phone),
  website: documentText(ORG_PROFILE_FIELD_CAPS.website),
  bankDetails: documentText(ORG_PROFILE_FIELD_CAPS.bankDetails),
  logoDataUri: z.string(),
}).superRefine((value, ctx) => {
  const problem = logoDataUriProblem(value.logoDataUri);
  if (problem !== null) ctx.addIssue({ code: "custom", path: ["logoDataUri"], message: problem });
  // THE RESERVE HAS TO BE ENFORCED SOMEWHERE OR IT IS A WISH. A quote's budget is the
  // render cap minus a template allowance minus what an issuer may cost, and nothing
  // bounded the issuer at all: a maxed profile is 47,115 bytes in ASCII and 60,715
  // with an `&` in every text field, because an ampersand escapes to five. The logo
  // and the text compete for the same reserve, which is why they are counted together
  // rather than separately.
  const bytes = orgProfileBytes(value);
  if (bytes > ORG_PROFILE_RESERVE_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["logoDataUri"],
      message: `this profile needs ${String(bytes)} bytes of the ${String(ORG_PROFILE_RESERVE_BYTES)}`
        + " a quote reserves for its issuer; use a smaller logo or shorter details",
    });
  }
});
export type OrgProfileInput = z.infer<typeof orgProfileInputSchema>;

/**
 * One priced line of an issued document, frozen at issue in money.ts's units:
 * quantity in THOUSANDTHS, price in CENTS, tax in BASIS POINTS.
 */
export const documentLineItemSchema = z.object({
  id: z.uuid(),
  position: z.number().int().positive(),
  description: z.string(),
  qtyMilli: z.number().int(),
  unitPriceCents: z.number().int().safe(),
  taxRateBp: z.number().int(),
  lineTotalCents: z.number().int().safe(),
});
export type DocumentLineItem = z.infer<typeof documentLineItemSchema>;

/**
 * An issued document, with its lines. NAMED `DocumentRecord` rather than `Document`
 * on purpose: `Document` is a DOM global, and a type by that name imported into
 * packages/web shadows it in every file that takes the import.
 *
 * There is no update shape anywhere below, and that is the phase's central claim
 * rather than an omission: an issued quote never changes.
 */
export const documentSchema = z.object({
  id: z.uuid(),
  number: z.string().min(1),
  type: documentTypeSchema,
  dealId: z.uuid(),
  fileId: z.uuid(),
  currency: currencyCodeSchema,
  issueDate: z.iso.date(),
  validUntilDate: z.iso.date().nullable(),
  recipientName: z.string(),
  recipientContactName: z.string(),
  recipientAddress: z.string(),
  subtotalCents: z.number().int().safe(),
  taxCents: z.number().int().safe(),
  totalCents: z.number().int().safe(),
  notes: z.string(),
  terms: z.string(),
  issuedByUserId: z.uuid(),
  createdAt: z.iso.datetime(),
  lines: z.array(documentLineItemSchema),
});
export type DocumentRecord = z.infer<typeof documentSchema>;

/**
 * THE RENDER BUDGET. Every number below was MEASURED against the shipped template,
 * `buildContext` and `prepareDocumentHtml`, because the first version of this comment
 * was arithmetic and the arithmetic was wrong twice.
 *
 * What it got wrong: it costed a line at "about 120 bytes" (measured: 139 to 186,
 * depending on the money strings the row prints -- a range the old note did not admit
 * existed), and it subtracted only the template and the logo, never `notes` (5000),
 * `terms` (5000), `recipientAddress` (2000) or the two 200-character names, all
 * permitted by this same schema. So the advertised 130 x 500 was not deliverable:
 * with every optional field maxed and a maxed logo it merges to 151,139 bytes in
 * ASCII and 216,139 accented, against a 131,072 cap. (An earlier note here said
 * 145,679 and 210,679, measured with narrower money strings -- same conclusion,
 * different premise, and the difference is exactly why a per-line figure has to say
 * what was in the row.)
 *
 * MEASURED, on the seeded template, every figure the merged AND SANITISED output in
 * UTF-8 BYTES -- both qualifications matter, since the same document is 2,205
 * characters and 2,211 bytes:
 *
 *   the template against an all-empty context        2,211 B
 *   a maxed org profile INCLUDING a maxed logo      +47,115 B
 *   maxed notes/terms/address/names (ASCII)         +12,486 B
 *   one more line item, shortest money strings         +139 B
 *   one more line item, widest money strings           +186 B
 *   one more character of ASCII description              +1 B
 *
 * `&` costs 5 bytes and `<` and `>` cost 4, because substitution escapes them and
 * the sanitiser leaves them escaped. `"` and `'` cost 1: they are escaped on the way
 * in and re-serialised bare in text position. Measured, not assumed -- and it is why
 * `documentContentBytes` counts escaped bytes rather than string length.
 */

/**
 * renderPdf's input cap, restated here because the whole budget derives from it --
 * and because THE AUTHORITATIVE CHECK IS NOT THIS FILE'S. `issueQuote` measures the
 * merged, sanitised bytes after the merge and before the spawn; everything below
 * PREDICTS that number from the inputs, and a prediction can be wrong.
 */
export const RENDER_INPUT_CAP_BYTES = 128 * 1024;

/**
 * What a user-edited template may cost, IN BYTES rather than characters. The shipped
 * one is 3,616, so this is four and a half times it -- room to rework the letterhead,
 * not room to paste a document in.
 *
 * BYTES, because a character cap does not bound a render: 16,384 characters of CJK is
 * 48,410 bytes, three times the reserve this constant is supposed to be. Measured on
 * PUT after the body has been sanitised, since the sanitiser can grow what it is
 * given.
 */
export const MAX_TEMPLATE_BYTES = 16 * 1024;

/**
 * What a quote reserves for its issuer: the logo plus the eight text fields, escaped.
 *
 * 48,000 was chosen from a measurement of a maxed ASCII profile (47,115) and was
 * simply hoped for: nothing bounded the profile, and the same fields full of `&`
 * measure 60,715. `orgProfileInputSchema` now enforces it, so the reserve is a fact
 * about what can be stored rather than an assumption about what people type.
 *
 * THOSE TWO FIGURES READ 47,320 AND 60,920 UNTIL PHASE 7'S QUALITY REVIEW, each
 * exactly 205 too high, in three places. The arithmetic is checkable in one
 * line and now is: the eight text fields cap at 3,400 characters and the logo
 * column at MAX_LOGO_DATA_URI_CHARS (43,715), so ASCII is 3,400 + 43,715 =
 * 47,115, and an `&` in every text position costs five bytes rather than one
 * for 17,000 + 43,715 = 60,715. The old pair implied a 43,920-character logo,
 * which is 205 more than the column can hold.
 */
export const ORG_PROFILE_RESERVE_BYTES = 48_000;

/**
 * A line's markup, without its description.
 *
 * MEASURED AT ITS LARGEST, not its smallest, AND THE FIGURE IS A RANGE. A row is 139
 * bytes when the money strings are their shortest and 186 with the widest values a
 * quote can carry -- the quantity, the unit price, the tax rate and the line total
 * are all printed in it, so "the cost of a line" is meaningless without saying what
 * was in it. Both ends measured against the shipped template through
 * `prepareDocumentHtml`, in MONEY_LOCALE.
 *
 * 160 was documented as "145 measured" and was neither, and SETTING IT TO 0 LEFT
 * EVERY TEST IN THE REPO GREEN. documents.test.ts now measures both ends and asserts
 * this constant sits at or above the top of them, so an undercharge fails.
 */
export const DOCUMENT_LINE_MARKUP_BYTES = 186;

/**
 * What is left for the quote's own content once the template and the issuer have
 * taken their reserves: 66,688 bytes.
 *
 * **THIS IS A PREDICTION AND IT IS NOT THE CHECK THAT DECIDES.** It exists so the
 * form can refuse a quote in the form, with a message about a field, instead of the
 * server refusing it after a merge. `issueQuote` measures the merged, sanitised bytes
 * and that measurement is authoritative -- it is exact, it is taken before anything
 * spawns, and it is immune to every way this arithmetic can be wrong. An earlier
 * version of this comment called the prediction conservative with one named
 * exception, and a review found four more:
 *
 *   - `"` costs one byte in text position and SIX in an attribute (`&quot;`), and
 *     this charges one. A 330-character template using each field once, filled with
 *     quote-heavy content, predicts 37,000 and merges to 165,735.
 *   - the issuer's reserve was not enforced, so a profile could cost 60,715 of the
 *     48,000 reserved for it. It is enforced now, which closes that one.
 *   - `MAX_TEMPLATE_BYTES` counted characters, so a CJK template cost three times its
 *     allowance. It counts bytes now, which closes that one too.
 *   - a template may repeat a field; the prediction counts a value once and the page
 *     prints it as often as the template asks.
 *
 * The first and the last are approximation quality now rather than correctness, and
 * they are why the measured check exists rather than a sixth attempt at predicting.
 * When the two disagree the measurement wins and the caller gets a 413 naming what
 * was too big; the cost of the disagreement is a worse error message, not a bad
 * document or a wasted render.
 */
export const DOCUMENT_CONTENT_BUDGET_BYTES =
  RENDER_INPUT_CAP_BYTES - MAX_TEMPLATE_BYTES - ORG_PROFILE_RESERVE_BYTES;

/**
 * THE PER-FIELD CAPS, SET TO WHAT IS DELIVERABLE IN THE WORST CASE RATHER THAN THE
 * BEST. 60 lines of 250 characters, with every optional field maxed, a maxed logo and
 * ACCENTED text throughout -- two bytes per character -- merges to about 113KB, which
 * fits. The same shape in ASCII is far under.
 *
 * Both halves are load-bearing, in opposite directions: without a description cap one
 * line exhausts the budget, and without a line cap 10,000 empty descriptions do.
 *
 * A script that costs three or four bytes a character (CJK, emoji) is NOT deliverable
 * at these maxima, and that is what `documentContentBytes` is for: it is exact for
 * any script, so such a quote is refused by the gate with a sentence about the budget
 * rather than by a 413 after a render. The caps are the ergonomic limit; the budget
 * is the real one.
 *
 * If renderPdf's input cap moves, every constant above moves with it.
 */
export const DOCUMENT_MAX_LINES = 60;
export const DOCUMENT_MAX_DESCRIPTION_CHARS = 250;

/**
 * What a submitted quote is PREDICTED to cost the renderer, in bytes.
 *
 * Exported so the form can show the remaining budget while somebody is typing, and so
 * the form and the server's early rejection cannot disagree. It is not what decides
 * whether a quote renders -- see DOCUMENT_CONTENT_BUDGET_BYTES.
 */
export function documentContentBytes(input: {
  recipientName?: string;
  recipientContactName?: string;
  recipientAddress?: string;
  notes?: string;
  terms?: string;
  lines: readonly { description: string }[];
}): number {
  let total = escapedBytes(input.recipientName ?? "") + escapedBytes(input.recipientContactName ?? "")
    + escapedBytes(input.recipientAddress ?? "") + escapedBytes(input.notes ?? "")
    + escapedBytes(input.terms ?? "");
  for (const line of input.lines) {
    total += DOCUMENT_LINE_MARKUP_BYTES + escapedBytes(line.description);
  }
  return total;
}

/**
 * A date a document can carry, which is narrower than a well-formed one.
 *
 * `z.iso.date()` accepts `0000-01-01`, and POSTGRES HAS NO YEAR ZERO: that value
 * computes its totals, allocates a number, RENDERS THE PDF, writes the blob, and then
 * dies on the INSERT with `22008 date/time field value out of range` -- a bare Error
 * that no domain mapping catches, so a 500 raised after a subprocess has already run,
 * through the public route. The same shape as the three CHECK constraints Step 5a
 * exists to gate, with a third error code.
 *
 * The floor is a four-digit year rather than 0001 because that is what everything
 * downstream assumes: the number printed on the page is `QUO-<year>-0001`, and a year
 * that is not four digits produces a number that sorts and reads wrong. The ceiling
 * comes free -- `z.iso.date()` will not parse five digits.
 */
const documentDateSchema = z.iso.date().refine(
  (value) => Number(value.slice(0, 4)) >= 1000,
  { message: "the date must fall in a four-digit year" },
);

/**
 * One line of a quote as submitted. **THE THREE BOUNDS HERE ARE THE THREE CHECK
 * CONSTRAINTS ON `document_line_items`**, restated where they can be enforced before
 * anything spawns: `qty_milli >= 0`, `unit_price_cents >= 0` and `tax_rate_bp BETWEEN
 * 0 AND 10000`.
 *
 * money.ts deliberately keeps a WIDER domain than all three -- `divideRoundHalfUp`
 * has a negative branch so a future credit note rounds correctly -- so a negative
 * quantity or a 150% tax rate computes a total, renders a PDF and only then dies on
 * the INSERT as a 23514: an opaque 500, after a subprocess has already run, for a
 * value the form said was fine. All three were reproduced end to end in exactly that
 * shape. The repo's split is "Zod is the primary gate, the CHECK is the backstop",
 * and this is the gate.
 *
 * The upper bounds are the storable ones: int4 for `qty_milli`, and
 * Number.MAX_SAFE_INTEGER for `unit_price_cents`, which is both what drizzle's
 * `mode: "number"` can read back and what `document_line_items_amounts_representable`
 * allows.
 */
export const documentLineInputSchema = z.object({
  description: documentText(DOCUMENT_MAX_DESCRIPTION_CHARS, 1),
  qtyMilli: z.number().int().min(0).max(2_147_483_647),
  unitPriceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  taxRateBp: z.number().int().min(0).max(10_000),
});
export type DocumentLineInput = z.infer<typeof documentLineInputSchema>;

/**
 * Body of POST /api/deals/:dealId/documents. The deal is the route param and the
 * currency is copied from that deal, so neither appears here: a document whose
 * currency disagreed with its deal's would be a record of two different amounts.
 *
 * THE superRefine IS THE FOURTH FAILURE PATH, and it is not one of the three CHECKs.
 * Every field above can be individually in range while the ARITHMETIC over them is
 * not: 130 lines of 2,147,483.647 units at MAX_SAFE_INTEGER cents each overflows the
 * representable range, and `documentTotals` throws a plain Error saying so. Left
 * ungated that is a 500 from a service call; here it is a 400 with a message, and it
 * costs one pass of the same arithmetic the service is about to run anyway. It
 * happens before the render either way -- no number is spent, nothing spawns -- so
 * this is about what the caller is told, not about what is wasted.
 */
/**
 * THE PER-FIELD CHARACTER CAPS, NAMED SO A FORM CAN DERIVE ITS OWN maxLength
 * FROM THEM instead of restating the numbers.
 *
 * Task 5's first round spelled 200/200/2000/5000/5000 into the quote form's
 * inputs by hand while its commit message claimed the form restated none of the
 * schema's bounds. They agreed, and nothing whatsoever kept them agreeing: an
 * edit here would have left the form silently truncating at the old figure, or
 * accepting past a new one and getting a 400 for it. The description's cap lives
 * in DOCUMENT_MAX_DESCRIPTION_CHARS above, which is already exported for the
 * same reason.
 */
export const DOCUMENT_FIELD_CAPS = {
  recipientName: 200,
  recipientContactName: 200,
  recipientAddress: 2000,
  notes: 5000,
  terms: 5000,
} as const;

export const issueQuoteInputSchema = z.object({
  issueDate: documentDateSchema,
  validUntilDate: documentDateSchema.nullable().optional(),
  recipientName: documentText(DOCUMENT_FIELD_CAPS.recipientName, 1),
  recipientContactName: documentText(DOCUMENT_FIELD_CAPS.recipientContactName).optional(),
  recipientAddress: documentText(DOCUMENT_FIELD_CAPS.recipientAddress).optional(),
  notes: documentText(DOCUMENT_FIELD_CAPS.notes).optional(),
  terms: documentText(DOCUMENT_FIELD_CAPS.terms).optional(),
  lines: z.array(documentLineInputSchema).min(1).max(DOCUMENT_MAX_LINES),
}).superRefine((value, ctx) => {
  try {
    computeDocumentTotals(value.lines);
  } catch {
    ctx.addIssue({
      code: "custom",
      path: ["lines"],
      message: "these line items total more than a document can represent",
    });
  }
  // THE BUDGET, WHICH THE PER-FIELD CAPS CANNOT EXPRESS. Every field can be inside
  // its own limit while the quote as a whole is too large to render -- a Japanese
  // description costs three bytes a character, an `&` costs five -- and without this
  // the refusal arrives as a 413 from renderPdf after the merge, naming a number the
  // person filling in the form has no way to act on.
  const bytes = documentContentBytes(value);
  if (bytes > DOCUMENT_CONTENT_BUDGET_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["lines"],
      message: `this quote needs ${String(bytes)} bytes of the ${String(DOCUMENT_CONTENT_BUDGET_BYTES)}`
        + " a document may use; shorten the notes, the terms or the line descriptions",
    });
  }
});
export type IssueQuoteInput = z.infer<typeof issueQuoteInputSchema>;

/**
 * One editable template per document type, as Settings reads and writes it.
 *
 * `warnings` is derived rather than stored: it is what `documentTemplateWarnings`
 * says the merge language will do SILENTLY to this body -- a field inside a `<style>`
 * block that will not be substituted, a `<style>` nobody closed, a block that never
 * closes. None of them can throw (a template being edited is half-written by
 * definition) and none of them should be invisible either, which is the whole reason
 * that function was exported with nothing to call it.
 */
export const documentTemplateSchema = z.object({
  type: documentTypeSchema,
  bodyHtml: z.string(),
  warnings: z.array(z.string()),
  updatedAt: z.iso.datetime(),
});
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;

/**
 * PUT /api/document-templates/:type's body.
 *
 * THE CAP HERE IS DELIBERATELY LOOSE, AND THE REAL ONE IS ON THE STORED BODY. What
 * bounds a render is MAX_TEMPLATE_BYTES measured AFTER sanitising, in
 * `saveDocumentTemplate` -- because the sanitiser can grow what it is given (16,384
 * characters of raw `"` inside a single-quoted attribute store as 97,546, 5.95x), so
 * a length checked before it bounds nothing, and because a body that came back from
 * GET must not be refused by PUT. This one only stops an absurd request body from
 * being parsed and sanitised at all; four times the real allowance leaves room for a
 * submission that sanitises down.
 *
 * `.min(1)` because an empty template is not a template: the row exists so a quote
 * renders before anyone opens Settings, and a blank body would produce a blank page
 * with a number on it.
 */
export const documentTemplateInputSchema = z.object({
  bodyHtml: documentText(MAX_TEMPLATE_BYTES * 4, 1),
});
export type DocumentTemplateInput = z.infer<typeof documentTemplateInputSchema>;
