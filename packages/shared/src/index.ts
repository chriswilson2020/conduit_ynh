import { z } from "zod";

export { midpoint } from "./fractional.js";

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
export const eventVerbSchema = z.enum([
  "created", "updated", "archived", "unarchived", "note_added", "file_attached",
  "stage_changed", "won", "lost", "reopened",
  "shifted", "completed", "dependency_added", "dependency_removed",
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

export const mailSecuritySchema = z.enum(["tls", "starttls"]);
export type MailSecurity = z.infer<typeof mailSecuritySchema>;

export const mailAccountStatusSchema = z.enum(["active", "error"]);
export type MailAccountStatus = z.infer<typeof mailAccountStatusSchema>;

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
  signatureHtml: nullableString,
  backfillDays: z.number().int().positive().nullable(),
  status: mailAccountStatusSchema,
  lastError: nullableString,
  lastSyncedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

// userId is the actor, stamped server-side (mirrors notes' authorUserId --
// never a caller-supplied field). One password field with an optional
// smtpPassword override, per the "SMTP differs" toggle in the Phase 4 spec's
// Key handling section -- when smtpPassword is omitted, the service reuses
// password for both protocols.
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
export const mailAccountUpdateInputSchema = mailAccountCreateInputSchema
  .omit({ password: true, smtpPassword: true }).partial();
export type MailAccountUpdateInput = z.infer<typeof mailAccountUpdateInputSchema>;

// POST /api/mail/accounts/test dry-runs IMAP+SMTP logins with either the
// submitted credentials (composing a not-yet-saved account) or, when only
// accountId is given, the stored ones -- every other field is therefore
// optional here even though mailAccountCreateInputSchema requires them. The
// refine below only guards the coarse "gave us nothing to test" case
// (accountId XOR a fresh connection attempt to start from); the route does
// the fine-grained enforcement (e.g. imapHost present without imapSecurity).
export const mailAccountTestInputSchema = z.object({
  accountId: z.uuid().optional(),
  imapHost: z.string().min(1).optional(), imapPort: z.number().int().positive().optional(),
  imapSecurity: mailSecuritySchema.optional(),
  smtpHost: z.string().min(1).optional(), smtpPort: z.number().int().positive().optional(),
  smtpSecurity: mailSecuritySchema.optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
}).refine((v) => v.accountId !== undefined || v.imapHost !== undefined, {
  message: "either accountId or imapHost is required",
});
export type MailAccountTestInput = z.infer<typeof mailAccountTestInputSchema>;

export const mailThreadSchema = z.object({
  id: z.uuid(), subject: z.string().min(1),
  lastMessageAt: z.iso.datetime(), messageCount: z.number().int().nonnegative(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
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

// Query-side filter contract for GET /api/mail/threads (route layer maps its
// snake_case querystring onto this camelCase shape, same division of labour
// as e.g. tasks.ts's listQuerySchema/listTasks). unread/unlinked/archived
// are plain booleans here, not the wire tri-state string -- that coercion is
// the route's job, same as every other listQuerySchema in routes/*.ts.
export const threadListFiltersSchema = z.object({
  accountId: z.uuid().optional(),
  unread: z.boolean().optional(),
  unlinked: z.boolean().optional(),
  companyId: z.uuid().optional(), contactId: z.uuid().optional(),
  dealId: z.uuid().optional(), projectId: z.uuid().optional(),
  archived: z.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type ThreadListFilters = z.infer<typeof threadListFiltersSchema>;

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
  attachmentIds: z.array(z.uuid()).optional().default([]),
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
});
export type SearchResults = z.infer<typeof searchResultsSchema>;
