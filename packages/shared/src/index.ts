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
