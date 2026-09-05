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
// decimalFromCents rides along for the CSV export (services/export.ts), which
// needs the bare decimal and not the formatted currency string -- see its own
// comment for why a spreadsheet cell must have neither symbol nor separator.
export {
  decimalFromCents, formatMoneyCents, formatQtyMilli, formatTaxRateBp, MONEY_LOCALE,
} from "./money-format.js";
// 7.6's backup passphrase rule, reaching web the same way and for the same
// reason the money helpers do: the Settings page refuses a passphrase before it
// is sent and services/backup.ts refuses one that arrives anyway, and those two
// refusals have to be the same sentence rather than two that agree today.
export { MAX_PASSPHRASE_LENGTH, passphraseProblem } from "./passphrase.js";
// 7.7's plan -- what a restore or an import is about to do, as a value. Here
// for the same reason as the rule above: the page renders the plan and the
// engine builds it, and a preview of a DESTRUCTIVE operation that disagreed
// with what runs is the worst failure this application has available to it.
export {
  destructiveEffects, planIsApplicable, plannedTotal,
} from "./plan.js";
export type {
  PlanEffectView, PlanFindingView, PlanKind, PlanRefusalView, PlanSourceView,
  PlanUnit, PlanView,
} from "./plan.js";
// 7.7's ONE INTERACTIVE STEP: the column mapping for a foreign CSV. Here for
// the plan's own reason and one more of its own -- csvMappingProblem is the
// single rule the page disables its control with and services/import-csv.ts
// refuses an arriving mapping with, on the passphraseProblem precedent.
export {
  csvImportField, csvMappingEntity, csvMappingProblem, CSV_IMPORT_FIELDS,
} from "./import-mapping.js";
export type {
  CsvColumnView, CsvDialectView, CsvImportEntity, CsvImportField, CsvImportFieldDef,
  CsvMapping, CsvMappingEntry, CsvMappingFinding, CsvMappingRefusal, CsvMappingView,
} from "./import-mapping.js";
// 7.7's confirmation rule, here for the reason the passphrase rule above is:
// the page refuses a mistyped install name before it spends a single-use
// ticket, and routes/restore.ts refuses one that arrives anyway. One function,
// two callers -- not two comparisons that agree today.
export { installNameMatches } from "./install-name.js";
// IN SCOPE, not merely re-exported: the zod schema at the foot of this file is
// held against this type by the compiler, and a `export type ... from` does not
// bring the name into this module.
import type { PlanView } from "./plan.js";
// The same arrangement for 7.7's OTHER rendered value, and for the same reason:
// csvMappingViewSchema at the foot of this file is held against this type by
// the compiler rather than by whoever edits one of the two.
import type { CsvMappingView } from "./import-mapping.js";

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

/**
 * HOW LONG A SALUTATION OR A SET OF PRONOUNS MAY BE, named so a form can derive
 * its own maxLength instead of restating the number (DOCUMENT_FIELD_CAPS exists
 * for the same reason, after a round where the quote form spelled its caps out by
 * hand and nothing kept them agreeing).
 *
 * 64 is generous for both -- "Dhr" is 3, "she/they" is 8, and the longest honorific
 * anybody has proposed for this field is well inside it -- and it is what
 * contacts_salutation_length and contacts_pronouns_length CHECK. This is the gate;
 * those are the backstop.
 *
 * IT IS A LENGTH AND NOTHING ELSE. There is no enum and no permitted-value list
 * anywhere in this codebase: the picker's presets are a UI convenience, and a title
 * or a pronoun set in any language must be typable. See db/schema.ts's contacts.
 */
export const CONTACT_FIELD_CAPS = { salutation: 64, pronouns: 64 } as const;

/**
 * A nullable free-text field with a length cap, refusing what a `text` column cannot
 * hold.
 *
 * `min(1)`, the cap and the refinement are inside the ONE expression on purpose --
 * `nullableString.max(n)` does not type-check against a nullable schema, and chaining
 * after `.nullable()` returns a fresh schema with the bound silently dropped. That is
 * the same trap `documentText` records, one type further along.
 *
 * THE NUL AND SURROGATE CHECK IS documentText's, AND IT IS HERE BECAUSE THIS RELEASE
 * PINS THE TWO ENDS TOGETHER. `DOCUMENT_FIELD_CAPS.recipientSalutation` is set to
 * `CONTACT_FIELD_CAPS.salutation` so a value the contact record accepts can always be
 * copied onto a quote -- and without this, `"Dr\0X"` was a clean 400 on the quote
 * side and a 500 on the contact side, where Postgres refuses the NUL with `22021
 * invalid byte sequence` after every layer above has called it fine. An unpaired
 * surrogate is the other way to build a string that is not valid UTF-8; it was stored
 * as U+FFFD, which is a value the user never typed.
 */
const cappedNullableString = (max: number, what: string) =>
  z.string().min(1)
    .max(max, `a ${what} may be at most ${String(max)} characters`)
    // UNSTORABLE_TEXT is declared further down this file (with the document field it
    // was written for); this closure reads it at parse time, long after module
    // evaluation, so the forward reference is fine.
    .refine((value) => !UNSTORABLE_TEXT.test(value), {
      message: `a ${what} may not contain a NUL or an unpaired surrogate`,
    })
    .nullable();

/**
 * THE ONE RULE FOR WHAT COUNTS AS AN EMAIL ADDRESS ON A CONTACT.
 *
 * NAMED AND EXPORTED RATHER THAN SPELLED `z.email()` AT EACH USE, because
 * db/schema.ts's `contacts.emails` says in its own words that the format is
 * validated here and that "any future direct-write path (import, seed) must go
 * through those schemas to keep this guarantee". 7.7's foreign CSV importer is
 * exactly that path, and it needs the rule for ONE VALUE at a time -- it drops
 * an unusable address and keeps the person rather than parsing a whole contact
 * and losing them. Referencing this is what keeps that a use of the rule rather
 * than a second copy of it.
 */
export const contactEmailSchema = z.email();

export const contactSchema = z.object({
  id: z.uuid(), firstName: z.string().min(1), lastName: nullableString,
  companyId: z.uuid().nullable(),
  emails: z.array(contactEmailSchema), phones: z.array(z.string().min(1)),
  jobTitle: nullableString,
  // Both optional, both free text, and NEITHER IS EVER INFERRED -- not from the
  // name, not from each other, not from anything. A blank stays blank and renders
  // as nothing. Stated here as well as in db/schema.ts because this is the shape
  // every client sees, and a guess in a letter is wrong in front of a customer.
  salutation: nullableString, pronouns: nullableString,
  ownerUserId: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Contact = z.infer<typeof contactSchema>;

export const createContactInputSchema = z.object({
  firstName: z.string().min(1), lastName: nullableString.optional(),
  companyId: z.uuid().nullable().optional(),
  emails: z.array(contactEmailSchema).optional(), phones: z.array(z.string().min(1)).optional(),
  jobTitle: nullableString.optional(),
  salutation: cappedNullableString(CONTACT_FIELD_CAPS.salutation, "salutation").optional(),
  pronouns: cappedNullableString(CONTACT_FIELD_CAPS.pronouns, "set of pronouns").optional(),
  ownerUserId: z.uuid().nullable().optional(),
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

/**
 * What the sync engine last had to say about an account (mail_accounts.status
 * -- api: db/schema.ts). Written by the sync loop and by nothing else, so that
 * the three values can never disagree with each other.
 *
 * 'auth_required' IS PHASE 8's, AND IT IS A THIRD STATE RATHER THAN A FLAVOUR
 * OF 'error' FOR ONE REASON: it is the only one a retry can never clear. An
 * 'error' account is one the next pass might get past -- a server that was
 * down, a socket that dropped -- and the engine's whole answer to it is to
 * back off and try again. A provider that has stopped honouring the stored
 * refresh token will answer identically for ever, and the ONLY thing that
 * changes it is a person signing in again. Rendering that as an error would
 * tell an operator to wait for something that is never going to happen, which
 * is exactly the "mail quietly stopped" failure the Phase 8 spec's Risk 3
 * names.
 *
 * A THIRD ENUM MEMBER, NOT A PARSED PREFIX ON last_error. The `auth:` /
 * `connection:` prefixes below are a real machine-readable contract and a
 * `reauth:` sibling was the cheaper option, considered and rejected: those
 * classify a CONNECTION FAILURE for a message that is displayed, while this is
 * a LIFECYCLE STATE that a badge, a send gate and (Task 3) a re-authorise
 * control all branch on. A client deciding a lifecycle state by matching prose
 * is the thing DuplicateAttendeeError's comment (api: services/errors.ts)
 * exists to warn about.
 *
 * ONE ROLLBACK NOTE, because it is the only cost. A v1.7.0 install that writes
 * 'auth_required' and is then rolled back to v1.6.0 has rows carrying a value
 * that release's enum does not know. Nothing crashes -- no route validates its
 * own response against this schema and the client does not parse one -- but
 * v1.6.0's StatusBadge falls through to "Active" for such a row, i.e. the
 * rollback loses the warning rather than corrupting anything. Stated here
 * rather than discovered: 0015's header carries the same note beside the CHECK.
 */
export const mailAccountStatusSchema = z.enum(["active", "error", "auth_required"]);
export type MailAccountStatus = z.infer<typeof mailAccountStatusSchema>;

// Phase 4.2: private by default, per account (spec's Decisions table: "the
// safe direction", the owner flips a mailbox to shared in Settings). Drives
// the inbox/record visibility predicate (api: mail-threads.ts, Task 2) --
// see mail_accounts.visibility's own comment (api: db/schema.ts) for what
// 'private'/'shared' each mean and why the DB default alone is the whole
// migration.
export const mailVisibilitySchema = z.enum(["private", "shared"]);
export type MailVisibility = z.infer<typeof mailVisibilitySchema>;

// Phase 8: how an account authenticates, and with whom when that is OAuth
// (mail_accounts.auth_method -- api: db/schema.ts, which carries the reasoning
// for it being ONE column rather than a kind/provider pair). Lives in shared
// because the settings UI branches on it to render "signed in with Microsoft"
// in place of a password field, and packages/web cannot import from
// packages/api.
//
// This is the ONE fact about an OAuth account that crosses the wire. The
// refresh token behind it never does -- same rule credentials_ciphertext has
// always had.
export const mailAuthMethodSchema = z.enum(["password", "oauth_microsoft", "oauth_google"]);
export type MailAuthMethod = z.infer<typeof mailAuthMethodSchema>;

export const mailOAuthProviderSchema = z.enum(["microsoft", "google"]);
export type MailOAuthProvider = z.infer<typeof mailOAuthProviderSchema>;

// The provider half of an auth method, or null for a password account.
//
// A FUNCTION RATHER THAN A SECOND COLUMN, and rather than each call site
// slicing the string itself: "does this start with oauth_" is exactly the
// prefix test that gets written slightly differently in three places and then
// disagrees. Exhaustive by construction -- a new member of
// mailAuthMethodSchema that nobody adds here is a compile error at the
// `never`, not a silent null.
export function mailOAuthProviderOf(method: MailAuthMethod): MailOAuthProvider | null {
  switch (method) {
    case "password": return null;
    case "oauth_microsoft": return "microsoft";
    case "oauth_google": return "google";
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

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
  // Phase 8. Safe to serialize where credentialsCiphertext is not, and the
  // distinction is the point: this says an account signs in with Microsoft,
  // never what it signs in WITH. The settings row is rendered from this alone,
  // so nothing on the read path has to reach for mail.key.
  authMethod: mailAuthMethodSchema,
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

// --- Folder management (Phase 4.4 Task 4) -----------------------------------
//
// Create, rename and delete a mailbox ON THE SERVER, which is what makes these
// three different in kind from the toggle above: that one writes a Conduit
// preference about a folder the server already has, and these three change
// what the server has. Every one of them is therefore a TWO-SYSTEM write, and
// the api service (mail-folders.ts) is where the ordering that makes each of
// them safe is argued.
//
// THREE BODIES, THREE ENDPOINTS, rather than more fields on
// folderPatchInputSchema. Phase 4.4 learned this twice already -- `folder`
// meaning source-or-destination depending on the action (Task 1's correction)
// and `threadIds` meaning threads-or-messages (Task 2's ruling) -- and both
// times the answer was a separate, narrower shape. A `newFolder` bolted onto
// the patch schema would make `syncEnabled` meaningless for half the requests
// that carry it, which is the same mistake one field wide.
//
// `.strict()` on all three, matching bulkMessageActionInputSchema's reasoning:
// a body carrying a field this shape does not have is a caller who has
// misunderstood which endpoint they are talking to, and rejecting says so
// where silently stripping would let them believe it scoped something.

// POST /api/mail/accounts/:id/folders -- CREATE one mailbox.
export const folderCreateInputSchema = z.object({
  folder: folderNameSchema,
}).strict();
export type FolderCreateInput = z.infer<typeof folderCreateInputSchema>;

// POST /api/mail/accounts/:id/folders/rename.
//
// POST rather than PATCH-with-a-name-in-the-path, and the same for delete
// below, for the reason the test-connection route is already POST: an IMAP
// mailbox name is arbitrary user text -- it can contain the path separator,
// spaces, and any non-ASCII the server's namespace allows -- and a name in a
// URL is a name in every access log and proxy trace between here and the
// browser. It is also the reason neither takes a `:folder` path parameter:
// the name is data, and data belongs in the body.
export const folderRenameInputSchema = z.object({
  folder: folderNameSchema, newFolder: folderNameSchema,
}).strict().refine((input) => input.folder !== input.newFolder, {
  // Rejected in the SCHEMA rather than as a service conflict, because it is a
  // malformed request and not a state clash: there is no folder arrangement
  // that would make renaming a folder to its own name meaningful. Compared
  // AFTER folderNameSchema's trim (both fields parse through it), so " Sent "
  // and "Sent" are caught as the same name rather than sent to a mail server
  // that would refuse them as a collision.
  path: ["newFolder"],
  message: "the new name is the same as the current one",
});
export type FolderRenameInput = z.infer<typeof folderRenameInputSchema>;

// POST /api/mail/accounts/:id/folders/delete.
export const folderDeleteInputSchema = z.object({
  folder: folderNameSchema,
}).strict();
export type FolderDeleteInput = z.infer<typeof folderDeleteInputSchema>;

// What a rename actually moved. Both counts cover the folder AND every
// descendant of it, because an IMAP RENAME is a SUBTREE rename -- verified
// against Dovecot 2.3, which renames "Parent" and "Parent/Child" together
// (api: renameFolder, and the integration test that pins it) -- so a rename
// that re-keyed only the exact name would leave every child's stored mail
// pointing at a name the server no longer has.
//
// The counts are on the wire because the UI says them afterwards. Renaming a
// folder silently moves potentially thousands of stored messages, and "Renamed
// to Clients; 412 stored messages moved with it" is the difference between an
// operator who knows what happened and one who finds out from a search that
// stops matching.
export const folderRenameResultSchema = z.object({
  folder: mailAccountFolderSchema,
  /** mail_messages rows re-keyed. */
  messages: z.number().int().nonnegative(),
  /** Folder rows re-keyed: the folder itself plus each descendant. */
  folders: z.number().int().nonnegative(),
});
export type FolderRenameResult = z.infer<typeof folderRenameResultSchema>;

// What a delete left behind. `folder` is the row, WHICH STILL EXISTS: this
// table's rows are never deleted (api: db/schema.ts, "a folder that vanishes
// from a later LIST keeps its row"), and a Conduit-driven delete is not the
// exception that proves it. `messages` is the count of stored messages Conduit
// KEPT -- the promise the confirmation made beforehand, restated as a fact
// afterwards.
export const folderDeleteResultSchema = z.object({
  folder: mailAccountFolderSchema,
  messages: z.number().int().nonnegative(),
});
export type FolderDeleteResult = z.infer<typeof folderDeleteResultSchema>;

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

// The bulk/single-thread mail actions. Three MOVE the underlying messages
// server-side (api: services/mail-move.ts) and two are the CRM-side,
// PER-ACTOR filing act (one mail_thread_hides row per thread for the
// requesting user, Phase 4.3):
//
// - trash/archive (Phase 4.1): move to the OWNING ACCOUNT'S configured
//   trash_folder/archive_folder -- a destination the request never names.
// - file (Phase 4.4): move to a destination the request DOES name
//   (`targetFolder` below). The fourth kind exists because filing mail is
//   mostly not trash or archive, it is "put this in Clients", and the first
//   two have no way to say so.
// - hide/unhide: the CRM-side pair, named "Hide in CRM" in the UI so it is
//   never confused with the IMAP moves. `unhide` (Phase 4.4) is `hide`'s
//   inverse -- a hide-row DELETE where hide is an INSERT -- and exists in
//   bulk because without it fifty threads hide in one gesture and unhide in
//   fifty.
export const bulkThreadActionKindSchema = z.enum([
  "trash", "archive", "hide", "unhide", "file",
]);
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
// in v0.6.0"); `hide`/`unhide` ignore folder entirely in both modes -- they
// are the per-actor CRM-side filing act (mail_thread_hides, Phase 4.3),
// which has no concept of an IMAP folder at all.
//
// `folder` IS THE SOURCE, NEVER THE DESTINATION, and Phase 4.4's `file`
// action is where that stopped being an academic distinction. Both the 4.4
// spec and its plan describe this field as the destination the new action
// already had ("bulkThreadActionInputSchema already carries an optional
// folder") -- it does not, and reusing it that way would have destroyed
// 4.3's folder-scoped selection ruling, since filing out of the INBOX view
// into Clients has to say BOTH which folder the selection was made in and
// which folder the mail is going to. Hence `targetFolder`, a second field
// rather than a second meaning on the first. It is REQUIRED for `file` and
// REJECTED for every other kind (the superRefine below): trash/archive read
// their destination off the account, and hide/unhide have none, so a
// targetFolder on any of them is a request whose sender misunderstands what
// it is asking for -- better a 400 than a silently ignored field.

// threadIds capped at 200: large enough for a full page of multi-select,
// small enough that one request's per-account IMAP MOVE queueing stays
// bounded; `.min(1)` because a bulk action against zero threads is not a
// request, it's a bug in whatever sent it.
//
// 200 is the OUTER bound, and only the CRM-side pair reaches it. The three
// MOVE kinds wait on a real mail server -- each queued MOVE runs on its
// account's serial sync loop -- so the route applies a tighter per-action cap
// of 50 to those and rejects a larger request with the uniform 400 (api:
// routes/mail.ts's bulk endpoint, Task 4 ruling). The CHECK lives there
// rather than in this schema because it is a property of the ACTION, not of
// the body shape, and this schema is also what the whole-thread single-id
// callers parse through -- but the NUMBERS live here, next to the outer bound
// they tighten, because the web client mirrors them too (web: mail-lib's
// select-all cap and its per-action disable), and three copies of 50 in three
// packages is three chances for the client to build a request the server
// answers with a 400.
export const BULK_THREAD_ACTION_CAP = 200;
export const MOVE_ACTION_THREAD_CAP = 50;

// The cap per action, as a Record over the kind enum rather than as the
// "everything except hide" test the route used to make. That negation was
// correct while `hide` was the only CRM-side kind and became a latent bug the
// moment 4.4 added a second one: `unhide` would have inherited the 50 by
// falling on the wrong side of a `!== "hide"`, silently, with nothing to fail.
// A Record is what makes a new kind a COMPILE error until someone decides
// which side of the wait it is on -- the same reasoning as web mail-lib's
// REASON_NOTES table, and the reason this replaces the client's own copy of
// it rather than joining it.
export const BULK_ACTION_THREAD_CAPS: Record<BulkThreadActionKind, number> = {
  trash: MOVE_ACTION_THREAD_CAP,
  archive: MOVE_ACTION_THREAD_CAP,
  // Files into an arbitrary folder, so it waits on the server exactly as the
  // other two moves do and takes their cap for exactly their reason.
  file: MOVE_ACTION_THREAD_CAP,
  hide: BULK_THREAD_ACTION_CAP,
  // A hide-row DELETE. Local, no mailbox, nothing to wait on -- so it takes
  // the outer bound, symmetric with the INSERT it undoes.
  unhide: BULK_THREAD_ACTION_CAP,
};

export const bulkThreadActionInputSchema = z.object({
  threadIds: z.array(z.uuid()).min(1).max(BULK_THREAD_ACTION_CAP),
  folder: folderNameSchema.optional(),
  targetFolder: folderNameSchema.optional(),
  action: bulkThreadActionKindSchema,
}).superRefine((v, ctx) => {
  // Enforced structurally rather than left to the service, for the same
  // reason bulkThreadResultItemSchema correlates its own flags: a `file` with
  // no destination has no defensible default (the account's Archive is a
  // different action the caller could have asked for), and the honest answer
  // to a request that does not say where is a 400 at the door.
  if (v.action === "file" && v.targetFolder === undefined) {
    ctx.addIssue({
      code: "custom", path: ["targetFolder"],
      message: "targetFolder is required when action is file",
    });
  }
  if (v.action !== "file" && v.targetFolder !== undefined) {
    ctx.addIssue({
      code: "custom", path: ["targetFolder"],
      message: "targetFolder is only valid when action is file",
    });
  }
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
//   a discovery pass. NEVER produced by `file`, which names its own
//   destination -- see unknown_target.
// - not_found: no such thread id.
// - server_refused: the queued IMAP MOVE was rejected; the optimistic rows
//   have been put back. `error` carries the server's text.
// - unknown_target (Phase 4.4, `file` only): the named destination is not a
//   folder this message's account has -- either the account never had it, or
//   the picker's list is stale against a folder renamed on the server. Its
//   own code rather than a second meaning on no_target, because the two have
//   different remedies and the client BRANCHES on that: no_target offers
//   "Open Settings -> Mail", which is the wrong place to send someone whose
//   only problem is that the second account in a mixed selection has no
//   folder called Clients (web: summarizeBulkResult's settingsLink). It also
//   covers a \Noselect destination -- a hierarchy node holding no messages,
//   which cannot receive mail and is refused BEFORE the optimistic write
//   rather than being left to the server (see api: mail-move.ts's
//   fileTargetsOf).
export const bulkThreadFailureReasonSchema = z.enum([
  "no_sync", "no_target", "not_found", "server_refused", "unknown_target",
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

/**
 * The flag correlations every bulk result item obeys, whatever unit it is
 * about -- factored out when Phase 4.4's per-message path arrived rather than
 * copied into it. They are properties of ONE ANSWER (a failure carries text, a
 * skip is a success, an explained outcome names its reason), and none of them
 * mentions threads; a second, quieter copy beside the first is precisely how
 * the two shapes would come to disagree about what `skipped` means.
 *
 * IT TAKES NO PER-PATH SKIP SET, which the first draft of it did: the
 * per-message path cannot produce `out_of_scope`, and the place that enforces
 * that is its `reason` ENUM, which rejects the value before this function ever
 * sees it. A narrower set passed in here would have been a parameter no test
 * could distinguish from SKIP_REASONS -- caught by trying to mutate it and
 * finding nothing failed.
 */
function refineBulkResultItem(
  v: { ok: boolean; skipped?: boolean | undefined; error?: string | undefined; reason?: string | undefined },
  ctx: z.RefinementCtx,
): void {
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
}

const bulkThreadResultItemSchema = z.object({
  threadId: z.uuid(),
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
  reason: bulkThreadResultReasonSchema.optional(),
}).superRefine(refineBulkResultItem);
export const bulkThreadResultSchema = z.object({
  results: z.array(bulkThreadResultItemSchema),
  // Phase 4.4, `file` only: the destination folder whose sync THIS REQUEST
  // switched on, absent when it switched none on.
  //
  // FILING INTO A FOLDER IS THE STATEMENT THAT THE FOLDER MATTERS, so filing
  // into one whose sync is off turns that sync on (api: mail-move.ts). It
  // does not warn and it does not refuse: the rejected alternative was to
  // allow the move and warn that the thread would then vanish from Conduit's
  // view, which is not informed consent -- it is a choice between losing the
  // thread and not filing it where it belongs, dressed as one.
  //
  // This field exists so the consequence is still SAID, after the fact:
  // enabling a sync is real (bandwidth, storage, a folder Conduit now walks
  // every pass) and nobody should discover it from a graph. A notification,
  // not a gate -- the client renders "Filed into Clients, and Conduit is now
  // syncing that folder" beside the per-thread summary.
  //
  // ONE NAME, not one per account: the destination is a single string for the
  // whole request, so every account this turned on turned on THAT folder, and
  // the sentence is true of each. Present when at least one was switched;
  // absent when the folder was already synced everywhere it mattered, when it
  // is INBOX or a Sent folder (always synced, never toggleable), or when
  // nothing was filed at all.
  syncEnabled: z.string().min(1).optional(),
});
export type BulkThreadResult = z.infer<typeof bulkThreadResultSchema>;

// ---------------------------------------------------------------------------
// Per-message selection (Phase 4.4 Task 2) -- POST /api/mail/messages/bulk
// ---------------------------------------------------------------------------
//
// A SECOND SURFACE, NOT A WIDENING OF THE FIRST. Selection in this app has
// been per THREAD since 4.3, and 4.3's folder-scoped rule (the `folder` field
// above) exists precisely because one conversation's messages spread across
// folders: a thread id cannot say WHICH of its messages a gesture meant, so
// the view it was made in had to say it instead. Filing a single message out
// of a thread is a different unit of work, and the spec's ruling is that it
// gets its own path -- overloading `threadIds` to sometimes mean messages is
// how the folder-scoped rule became necessary in the first place.
//
// WHAT THE SECOND SURFACE DELIBERATELY DOES NOT COPY, each a decision:
//
// - NO hide/unhide. A hide is one mail_thread_hides row per THREAD, for the
//   acting user. There is no per-message hide to ask for, and inventing one
//   would be a new visibility concept rather than a wider version of this one.
//   That is what keeps this enum at three kinds -- exactly the MOVE actions
//   (api: mail-move.ts's MoveAction), which is also why the two files' sets
//   are the same size.
// - NO `folder`. It is the SOURCE on the thread schema -- the view a selection
//   was made in -- and a message id IS that scope, exactly, with nothing left
//   to approximate. Rejected rather than ignored, for the reason targetFolder
//   is rejected on the kinds that have no destination: a silently dropped
//   field is how a caller comes to believe it scoped something.
// - NO `out_of_scope` (see bulkMessageResultSchema below).
//
// What it DOES share is the destination rule, byte for byte: `targetFolder` is
// required for `file` and rejected on the other two, and filing into a folder
// whose sync is off turns that sync ON rather than warning about it -- the
// same service call, not a second decision (api: mail-move.ts's
// enableTargetSync).
export const bulkMessageActionKindSchema = z.enum(["trash", "archive", "file"]);
export type BulkMessageActionKind = z.infer<typeof bulkMessageActionKindSchema>;

// 50, and it is the MOVE cap's number for the MOVE cap's reason: every kind
// here waits on a real mail server, each queued MOVE runs on its account's
// serial sync loop, and bounding the SIZE of that wait rather than its
// duration is what stops a timeout producing the "claimed a move the server
// refused" state (api: routes/mail.ts's bulk endpoints).
//
// A SEPARATE CONSTANT FROM MOVE_ACTION_THREAD_CAP despite sharing its value,
// because the two count different things: 50 threads can carry hundreds of
// messages, so this is the tighter bound of the two and tying them together
// would make one of them move when the other was reasoned about. Its own
// second justification is that it matches what the surface can offer -- the
// conversation view renders the newest 50 messages of a thread (api:
// mail-threads.ts's THREAD_DETAIL_MESSAGE_CAP), so one full page of a
// conversation selects and files in one gesture, and only a thread expanded
// past that page can build a selection this refuses.
export const BULK_MESSAGE_ACTION_CAP = 50;

export const bulkMessageActionInputSchema = z.object({
  messageIds: z.array(z.uuid()).min(1).max(BULK_MESSAGE_ACTION_CAP),
  targetFolder: folderNameSchema.optional(),
  action: bulkMessageActionKindSchema,
// STRICT, unlike the thread input above, and that is what enforces the "no
// `folder`" ruling: a plain z.object strips unknown keys silently, which would
// accept `{ messageIds, folder: "INBOX" }` and file the mail while telling the
// caller nothing about the scope it thought it had asked for.
}).strict().superRefine((v, ctx) => {
  if (v.action === "file" && v.targetFolder === undefined) {
    ctx.addIssue({
      code: "custom", path: ["targetFolder"],
      message: "targetFolder is required when action is file",
    });
  }
  if (v.action !== "file" && v.targetFolder !== undefined) {
    ctx.addIssue({
      code: "custom", path: ["targetFolder"],
      message: "targetFolder is only valid when action is file",
    });
  }
});
export type BulkMessageActionInput = z.infer<typeof bulkMessageActionInputSchema>;

// The skip reasons a per-message request can actually reach: the four the move
// service NOTES against an individual row, and no fifth.
//
// `out_of_scope` is the one left out, and leaving it out is the contract
// saying something true rather than a comment claiming it. That reason means
// "this action never applied to this thread at all" -- in the folder-scoped
// mode every message sat in some other folder, in the whole-thread mode the
// conversation was nothing but Sent mail -- and it is the FALLBACK the thread
// path reaches for when a thread finishes with no reason recorded against any
// of its messages. A request that named a message by id leaves that message no
// scope to fall outside of: it is looked at, and whatever happens to it is
// noted against it. So every skip here is a noted one, which is exactly the
// set api: mail-move.ts already types as NotedSkipReason.
export const bulkMessageSkipReasonSchema = z.enum([
  "archived_account", "not_owner", "awaiting_reconciliation", "already_in_target",
]);
export type BulkMessageSkipReason = z.infer<typeof bulkMessageSkipReasonSchema>;

export const bulkMessageResultReasonSchema = z.enum([
  ...bulkThreadFailureReasonSchema.options, ...bulkMessageSkipReasonSchema.options,
]);
export type BulkMessageResultReason = z.infer<typeof bulkMessageResultReasonSchema>;

// KEYED ON messageId, in request order, and that key is the whole reason this
// is a separate response shape rather than the thread one reused. Two messages
// of ONE conversation can come out differently -- one filed, one refused by
// the server, one already in the destination -- and a threadId-keyed result
// has no way to say so: it would have to collapse them into a single verdict
// per thread, which is either a lie about the ones that worked or a lie about
// the ones that did not.
//
// The FAILURE reasons are shared with the thread path unchanged, because each
// of them is a fact about a message and its account (no running loop, no
// classified target, the server said no, that account has no such folder)
// rather than about the unit a request selected in.
const bulkMessageResultItemSchema = z.object({
  messageId: z.uuid(),
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
  reason: bulkMessageResultReasonSchema.optional(),
}).superRefine(refineBulkResultItem);

export const bulkMessageResultSchema = z.object({
  results: z.array(bulkMessageResultItemSchema),
  // The same after-the-fact notification the thread result carries, for the
  // same rule applied by the same call: filing into a folder IS the statement
  // that the folder matters, so a destination whose sync is off is switched on
  // and then SAID -- never asked about first.
  syncEnabled: z.string().min(1).optional(),
});
export type BulkMessageResult = z.infer<typeof bulkMessageResultSchema>;

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
 * Whether Postgres would refuse to store this string at all.
 *
 * THE PREDICATE IS EXPORTED AND THE PATTERN IS NOT, so there is one description
 * of the rule and no way for a caller to end up holding a `RegExp` with state of
 * its own. 7.7's foreign CSV importer is the caller that needed it: a NUL in
 * somebody else's spreadsheet is not exotic, and a row carrying one has to be
 * declined IN THE PREVIEW rather than reaching an INSERT inside a transaction
 * that has already written thousands of rows -- where it arrives as `22021
 * invalid byte sequence` and takes the whole import down with it.
 */
export function unstorableText(value: string): boolean {
  return UNSTORABLE_TEXT.test(value);
}

/**
 * A user-supplied string bounded in length and refused if a column could not hold it.
 *
 * `min` is a PARAMETER rather than something a caller chains on afterwards, and that
 * is not tidiness: `documentText(250).min(1)` type-checks, returns a fresh schema and
 * silently drops the refinement, so a description containing a NUL sails through and
 * fails the INSERT exactly as before. Every bound has to be inside the one expression.
 *
 * IT ATTACHES NO FIELD-NAMING MESSAGE, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 * `cappedNullableString` above DOES name its field ("a salutation may be at most 64
 * characters"), so the two halves of v1.1.0 look inconsistent; they are not, and the
 * difference is which layer the person reading the refusal is standing in front of.
 *
 * A contact is edited through pages/contact-detail.tsx, which puts `ApiError.message`
 * -- the route's 400, which is `issues[0].message` verbatim -- straight into its
 * banner. The schema's own words ARE what the operator reads there, so they have to
 * name the field.
 *
 * A quote is not. components/document-form.tsx runs THIS schema client-side before it
 * posts, and renders its issues through `describeIssue`, which reads the issue PATH
 * and writes its own sentence -- discarding `issue.message` outright for every
 * too_big and too_small. A message added here would therefore be invisible on the
 * only path an operator takes, and would create a SECOND list of human names for
 * these fields to keep in step with that function's FIELD_LABELS. This release had
 * just finished removing one such pair elsewhere in this file.
 *
 * AND THE ASYMMETRY IS WEAKER THAN THAT, WHICH ARGUES THE SAME WAY. The length
 * message is not merely invisible from the quote form -- it is UNREACHABLE from
 * either form, because every capped control carries its cap as the input's own
 * `maxLength`, on the quote side and on the contact side alike (DOCUMENT_FIELD_CAPS
 * and CONTACT_FIELD_CAPS are exported so the forms derive them rather than restate
 * them). So the claim that an operator reads the schema's words on the contact page
 * is not demonstrable for a length either; what is demonstrable is that the contact
 * page has no rewriting layer at all, so whatever DOES reach it arrives verbatim.
 * Fewer messages, not more.
 *
 * So: every field built on this function keeps Zod's own English. There are SIXTEEN
 * of them -- the eight on orgProfileInputSchema, the six on issueQuoteInputSchema
 * (recipientName, recipientContactName, recipientSalutation, recipientAddress, notes
 * and terms; the two dates are documentDateSchema and `lines` is an array),
 * documentLineInputSchema's description, and the template body. THE ARGUMENT ABOVE
 * IS ABOUT THE QUOTE FORM'S SEVEN of those, which are the ones `describeIssue`
 * renames; the org profile and the template editor surface their own messages and
 * are not what this paragraph reasons about. Two earlier versions of this sentence
 * miscounted: "all seven fields" of the schema, which is a different count of a
 * different set, and then "seven call sites", which silently narrowed "every field
 * built on this function" to the subset being discussed. The
 * naming is `describeIssue`'s job alone -- held there by a test that walks this
 * schema's shape, so the layer that does the naming cannot silently gain a hole. The
 * residual reader is a direct API caller. `parseOrReject` sends `{error, message}`
 * and NOTHING ELSE -- the issue's `path` never leaves the process -- so what that
 * caller gets is "Too big: expected string to have <=64 characters" with no field
 * named anywhere in the response. An earlier version of this paragraph said the path
 * travelled beside it; that was true of the Zod issue and false of the HTTP body.
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

/**
 * What an issuer profile's TEXT will cost a render, escaped.
 *
 * IT USED TO ADD THE LOGO IN and be called `orgProfileBytes`, and that sum is what
 * made the two compete: the logo was charged against the same budget as the eight
 * fields printed beside it, so a bigger logo could only come out of the address. The
 * logo is charged to the render's image allowance now and is not counted here. See
 * ORG_PROFILE_TEXT_RESERVE_BYTES.
 */
export function orgProfileTextBytes(profile: {
  name: string; addressLines: string; vatNumber: string; registrationNumber: string;
  email: string; phone: string; website: string; bankDetails: string;
}): number {
  return escapedBytes(profile.name) + escapedBytes(profile.addressLines)
    + escapedBytes(profile.vatNumber) + escapedBytes(profile.registrationNumber)
    + escapedBytes(profile.email) + escapedBytes(profile.phone)
    + escapedBytes(profile.website) + escapedBytes(profile.bankDetails);
}

/**
 * THE LOGO'S THREE BOUNDS, AND THEY ARE NOT THE SAME NUMBER OR EVEN THE SAME UNIT.
 *
 * `MAX_LOGO_BYTES` bounds the IMAGE and is what `logoDataUriProblem` checks.
 * `MAX_LOGO_DATA_URI_CHARS` bounds the COLUMN, which holds base64 -- 4 characters per
 * 3 bytes, plus the longest permitted prefix. Reusing the first as the second would
 * silently shrink the permitted logo to 225KB and nothing would say so: every
 * rejected upload would look like a user's mistake.
 *
 * **300KB, NOT THE 32KB v1.0.0 SHIPPED, BECAUSE 32KB WAS TOO SMALL FOR A REAL LOGO.**
 * Flat-colour artwork on a large canvas lands around 300KB as a PNG and looks bad
 * downscaled to fit an arbitrary limit. It reaches the renderer inlined at 4/3 of its
 * size -- 409,600 bytes -- which is more than v1.0.0's ENTIRE 131,072-byte render
 * input cap, and that is why this is not a one-line change: the logo used to compete
 * with the document's text for one shared allowance and now has its own. See
 * RENDER_MARKUP_CAP_BYTES.
 *
 * **`MAX_LOGO_PIXELS` IS THE BOUND THAT ACTUALLY PROTECTS THE RENDERER, BECAUSE FILE
 * BYTES ARE A POOR PROXY FOR WHAT A RENDERER HOLDS.** A PNG's decoded raster is
 * width x height x 4 whatever its file size, so a small file can decode to an
 * enormous bitmap. Measured on the server, through renderPdf, sampling the child's
 * peak RSS from /proc: a 12,227-byte 1-bit PNG of 10,000 x 10,000 costs 535MB, and a
 * 20,625-byte one of 13,000 x 13,000 costs 864MB. Both are far below any byte limit
 * worth having. A render's cost tracks PIXELS: peak RSS is about 56MB + 7.65MB per
 * megapixel across 3Mpx (78MB), 11Mpx (143MB), 25Mpx (250MB) and 45Mpx (401MB).
 *
 * 16,000,000 pixels is 4000 x 4000, or 8000 x 2000 -- 5.7x the 2000 x 1400 canvas the
 * logo this limit was raised for uses. At the byte cap it costs 180MB alone and 353MB
 * in the worst document that can carry it (a full markup budget of minimal table rows
 * beside it), which is what `ram.runtime` is built from. The next size up a design
 * tool would offer, 5000 x 4000, measures 210MB alone and 384MB in that same
 * document: 31MB per render over the budget, 62MB across the two that can run at
 * once, on a server with no swap where overshooting is an OOM kill.
 *
 * Pillow refuses anything over 178,956,970 pixels outright (twice its
 * MAX_IMAGE_PIXELS) and drops the image from the page, so the window this bound
 * closes is the one BELOW that: 169Mpx decoded happily and cost 864MB.
 *
 * `org_profile_logo_size` CHECKs the same character count, and a test asserts the
 * constraint's literal equals this constant so the two cannot drift.
 */
export const MAX_LOGO_BYTES = 300 * 1024;
export const MAX_LOGO_PIXELS = 16_000_000;
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
    // WHITESPACE IS SKIPPED, NOT A TERMINATOR, BECAUSE THAT IS WHAT THE DECODER DOES.
    // Python's `base64.decodebytes`, which is what `urlopen` hands a `data:` URI to,
    // discards it. Stopping here instead meant a single space three characters in
    // made a 100-megapixel bomb look like a 3-byte image: charged 24,768 pixels,
    // rendered at 534MB. Found by a quality review, and it is the whole of that bug.
    if (/\s/.test(character)) continue;
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

/** A decoded image's shape. Both sides are positive; a zero is "unreadable". */
export interface ImageSize { readonly width: number; readonly height: number; }

function be16(b: readonly number[], at: number): number {
  return (at8(b, at) << 8) | at8(b, at + 1);
}

function be32(b: readonly number[], at: number): number {
  // `>>> 0` rather than `|`: a width with its top bit set is a positive 32-bit
  // number, and the bitwise form would hand back a negative one that compares
  // BELOW the pixel bound. PNG's fields are unsigned.
  return ((at8(b, at) << 24) | (at8(b, at + 1) << 16)
    | (at8(b, at + 2) << 8) | at8(b, at + 3)) >>> 0;
}

/** The IHDR, which the spec requires to be the first chunk and 13 bytes long. */
function pngSize(b: readonly number[]): ImageSize | null {
  if (!startsWithBytes(b.slice(8), [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

/** One byte, or 0 past the end -- so a truncated header reads as zeros, not undefined. */
function at8(b: readonly number[], at: number): number {
  return b[at] ?? 0;
}

/**
 * A GIF'S REAL CANVAS, WHICH IS NOT ITS LOGICAL SCREEN DESCRIPTOR.
 *
 * **THIS READ THE SCREEN DESCRIPTOR AND NOTHING ELSE, AND THAT WAS A BYPASS THROUGH
 * THE LOGO UPLOAD ITSELF.** A GIF's frames carry their own extents and Pillow expands
 * the image to fit them. A valid GIF89a whose screen says 1x1 and whose first frame is
 * 13000x13000 is 51KB -- inside the logo cap -- and it was ACCEPTED as a logo, charged
 * ONE pixel by `renderInputCost`, and rendered at 703MB. One stored logo would have
 * made every quote a 700MB render.
 *
 * So this walks the block stream and takes the largest of the screen and every frame's
 * `left + width` by `top + height`. Walking means reading the whole file: extension
 * blocks and image data are variable-length chains of sub-blocks, and a later frame
 * can be the biggest one.
 *
 * **AND A WALK THAT DOES NOT REACH THE TRAILER ANSWERS WITH THE LARGEST EXTENT IT
 * ESTABLISHED, RATHER THAN NULL.** Giving up used to look like the conservative
 * choice -- an incomplete maximum is smaller than the real one -- but null is not a
 * refusal here: `renderInputCost` charges an unreadable payload per CHARACTER, so a
 * 37-byte GIF whose screen claims 8000x8000 and whose walk runs out of bytes was
 * charged 429,312 pixels against a 16,000,000 cap and waved through, while Pillow
 * opened it at 64 megapixels. Four variants of that shape were built in v1.0.1; the
 * worst rendered at 302MB and the other three died on the kernel bound. The screen
 * descriptor was in hand the whole time.
 *
 * **THE FALLBACK IS CONDITIONAL ON HAVING PARSED AN IMAGE DESCRIPTOR, because that is
 * exactly Pillow's condition for opening the file at all.** `GifImageFile._open`
 * scans for the first `,` and raises EOFError if it reaches the end without one, so a
 * GIF with no frame is not an image anybody can draw and stays unreadable -- which is
 * the answer `logoDataUriProblem` needs, and it is measured rather than assumed: a
 * probe was built for each of the six ways the old walk could answer null, and Pillow
 * refuses the five that reach no image descriptor and opens the one that does, at the
 * size this now returns.
 *
 * **A BYTE THAT IS NOT A BLOCK INTRODUCER RESYNCS RATHER THAN ENDING THE WALK, for
 * the same reason: Pillow's scanner skips it and carries on.** Ending the walk there
 * and then falling back would have opened a fresh undercharge rather than closing
 * one -- a 1x1 screen with a 13000x13000 frame hidden behind a single 0x00 byte reads
 * as 1x1 to a reader that stops, and Pillow opens it at 169 megapixels. Measured on
 * Pillow 12.3.0: with the resync this file is charged 169,000,000 and refused; the
 * padded form of it was refused by the per-character charge before this change and
 * would have become acceptable without the resync.
 */
function gifSize(b: readonly number[]): ImageSize | null {
  if (b.length < 13) return null;
  let width = at8(b, 6) | (at8(b, 7) << 8);
  let height = at8(b, 8) | (at8(b, 9) << 8);
  // A global colour table, if the packed field says so: 3 bytes per entry, 2^(N+1)
  // entries.
  let at = 13 + ((at8(b, 10) & 0x80) === 0 ? 0 : 3 * (1 << ((at8(b, 10) & 0x07) + 1)));
  let framed = false;

  /** Past a chain of length-prefixed sub-blocks, or -1 if it runs off the end. */
  const skipSubBlocks = (from: number): number => {
    let cursor = from;
    for (;;) {
      if (cursor >= b.length) return -1;
      const size = at8(b, cursor);
      if (size === 0) return cursor + 1;
      cursor += 1 + size;
    }
  };

  /**
   * The answer for a walk that ended before the trailer: everything established so
   * far if a frame was reached, and otherwise nothing, because Pillow could not have
   * opened the file either.
   */
  const soFar = (): ImageSize | null => (framed ? { width, height } : null);

  for (;;) {
    if (at >= b.length) return soFar();
    const block = at8(b, at);
    if (block === 0x3b) break; // the trailer: the file is complete, so is the answer
    if (block === 0x21) {
      // An extension: a label, then sub-blocks. Comment, graphic-control and
      // application blocks all take this shape.
      at = skipSubBlocks(at + 2);
      if (at === -1) return soFar();
      continue;
    }
    if (block === 0x2c) {
      // An image descriptor: left, top, width, height, packed. A truncated one is
      // read by nobody -- Pillow's own unpack raises on the short buffer -- so it
      // contributes no extent, and any earlier frame still counts.
      if (at + 10 > b.length) return soFar();
      const left = at8(b, at + 1) | (at8(b, at + 2) << 8);
      const top = at8(b, at + 3) | (at8(b, at + 4) << 8);
      width = Math.max(width, left + (at8(b, at + 5) | (at8(b, at + 6) << 8)));
      height = Math.max(height, top + (at8(b, at + 7) | (at8(b, at + 8) << 8)));
      framed = true;
      const packed = at8(b, at + 9);
      const local = (packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1));
      // The local colour table, the LZW minimum code size, then the image's own
      // sub-blocks.
      at = skipSubBlocks(at + 10 + local + 1);
      if (at === -1) return soFar();
      continue;
    }
    at += 1; // malformed: skip the byte and keep looking, which is what Pillow does
  }
  return { width, height };
}

/**
 * THE FRAME HEADER, WHICH IS NOT AT A FIXED OFFSET, so this walks the marker
 * segments to the first SOFn. A JPEG may carry EXIF, an ICC profile and a thumbnail
 * ahead of it; DIMENSION_BYTES is how far that walk is willing to go.
 */
function jpegSize(b: readonly number[]): ImageSize | null {
  let at = 2;
  while (at + 8 < b.length) {
    if (at8(b, at) !== 0xff) return null;
    const marker = at8(b, at + 1);
    // Padding, and the standalone markers that carry no length field.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    // SOF0..SOF15, less the three markers that share the range and are not frames
    // (DHT, JPG, DAC). Height precedes width, which is the way round it is easy to
    // get wrong -- and on a square test image, impossible to notice.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(b, at + 5), width: be16(b, at + 7) };
    }
    // The scan: the frame header can no longer appear ahead of us.
    if (marker === 0xda) return null;
    const length = be16(b, at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * ALL THREE WEBP VARIANTS, because reading only the one everybody names would leave
 * the other two as a way past the pixel bound. A lossy file is `VP8 `, a lossless one
 * `VP8L` with its dimensions packed 14 bits at a time, and an extended one `VP8X`
 * with a 24-bit canvas size -- and an encoder picks between them.
 */
function webpSize(b: readonly number[]): ImageSize | null {
  const fourcc = String.fromCharCode(at8(b, 12), at8(b, 13), at8(b, 14), at8(b, 15));
  if (fourcc === "VP8X") {
    if (b.length < 30) return null;
    return {
      width: 1 + (at8(b, 24) | (at8(b, 25) << 8) | (at8(b, 26) << 16)),
      height: 1 + (at8(b, 27) | (at8(b, 28) << 8) | (at8(b, 29) << 16)),
    };
  }
  if (fourcc === "VP8 ") {
    // The key-frame start code, which is what says the header is where we think.
    if (b.length < 30) return null;
    if (at8(b, 23) !== 0x9d || at8(b, 24) !== 0x01 || at8(b, 25) !== 0x2a) return null;
    return {
      width: (at8(b, 26) | (at8(b, 27) << 8)) & 0x3fff,
      height: (at8(b, 28) | (at8(b, 29) << 8)) & 0x3fff,
    };
  }
  if (fourcc === "VP8L") {
    if (b.length < 25 || at8(b, 20) !== 0x2f) return null;
    const packed = (at8(b, 21) | (at8(b, 22) << 8) | (at8(b, 23) << 16) | (at8(b, 24) << 24)) >>> 0;
    return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) };
  }
  return null;
}

/**
 * How many bytes of each format have to be decoded before its dimensions are
 * readable. Three of them are a fixed header; JPEG is a walk, and 64KB is past any
 * plausible pile of EXIF and thumbnails. A template-embedded image cannot exceed
 * MAX_TEMPLATE_BYTES of base64 anyway, so for that path this is the whole file.
 *
 * A JPEG whose frame header is past the window reads as unidentified, which is
 * charged rather than trusted -- see MAX_PIXELS_PER_PAYLOAD_BYTE -- so running out of
 * window is safe in the direction that matters.
 */
const DIMENSION_BYTES: Record<string, number> = {
  png: 24,
  webp: 30,
  jpeg: 65_536,
  // GIF IS (ALL BUT 15 BYTES OF) THE WHOLE FILE, because its answer is a maximum over
  // every frame and the biggest frame can be the last one. Reading it all is a few
  // milliseconds on a payload the image cap already bounds.
  //
  // **THE 15 BYTES ARE REAL AND THIS COMMENT SAID "THE WHOLE FILE" FLATLY UNTIL
  // v1.2.1.** RENDER_IMAGE_CAP_BYTES admits 409,623 payload characters; the longest
  // DECODABLE prefix of that is 409,620, since Python raises "Incorrect padding" on
  // the three-character tail, and 409,620 characters is 307,215 bytes against this
  // window's 307,200. It could not matter before, because a walk that ran out of
  // window answered null and a payload that long was then charged billions of pixels.
  // It can now: `gifSize` falls back to the largest extent it established, and an
  // extent hiding in those 15 bytes is not in it. What keeps it harmless is that
  // Pillow sizes a still image from the screen descriptor and FRAME ZERO, both inside
  // the first ~800 bytes (a global colour table is at most 768); a later frame
  // enlarges `_size` only for a caller that seeks to it, and the render path never
  // does. Left at MAX_LOGO_BYTES rather than widened: widening is a behaviour change
  // with no failing case behind it, and this is a patch release. Recorded here so the
  // next reader does not have to rediscover that the window and the cap differ.
  gif: MAX_LOGO_BYTES,
};

const IMAGE_SIZE_READERS: Record<string, (b: readonly number[]) => ImageSize | null> = {
  png: pngSize, gif: gifSize, jpeg: jpegSize, webp: webpSize,
};

/** A `data:` URI split at its comma: what encoding the payload is in, and the payload. */
interface DataUriPayload {
  readonly text: string;
  readonly base64: boolean;
}

/**
 * The payload of a `data:` URI, or null if the string is not one.
 *
 * **THE MEDIA TYPE IS NOT READ, AND THAT IS THE POINT OF THIS FUNCTION EXISTING.**
 * RFC 2397 puts an optional type, optional parameters and an optional `;base64`
 * between `data:` and the comma, all of them free text written by whoever built the
 * URI -- so `data:image/bmp`, `data:image/PNG`, `data:;base64` and
 * `data:image/png;charset=utf-8;base64` are four spellings of the same thing to a
 * renderer, which sniffs the bytes. Only the ENCODING is taken from here, because
 * only the encoding changes what the bytes are.
 */
function dataUriPayload(uri: string): DataUriPayload | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  // No comma is not a data: URI at all -- `urlopen` raises on it, nothing is
  // fetched, and it is prose that happens to start with "data:".
  if (comma === -1) return null;
  const parameters = uri.slice("data:".length, comma).toLowerCase().split(";");
  return { text: uri.slice(comma + 1), base64: parameters.includes("base64") };
}

/**
 * The first `wanted` bytes of a percent-encoded payload.
 *
 * The OTHER encoding a `data:` URI can use, and the one an attacker reaches for
 * second: `data:image/png,%89PNG...` carries the same file with no base64 anywhere
 * in it. Stops at a malformed escape rather than guessing, which costs nothing --
 * the signature check downstream then fails and the payload is charged as unknown.
 */
function decodePercentPrefix(text: string, wanted: number): number[] {
  const out: number[] = [];
  for (let at = 0; at < text.length && out.length < wanted; at += 1) {
    const character = text[at] ?? "";
    if (character === "%") {
      const hex = text.slice(at + 1, at + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return out;
      out.push(parseInt(hex, 16));
      at += 2;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code > 0xff) return out;
    out.push(code);
  }
  return out;
}

/** The first `wanted` bytes of a payload, in whichever encoding it declares. */
function payloadPrefix(payload: DataUriPayload, wanted: number): number[] {
  // NOT SLICED TO `wanted * 4 / 3` CHARACTERS FIRST, which is what it used to do and
  // which stopped being right the moment whitespace was allowed inside a payload: a
  // wrapped base64 blob carries fewer than three bytes per four characters, so the
  // slice cut the header short and a 10,000-pixel width read as 9,984. Both decoders
  // already stop at `wanted` bytes, so handing them the whole payload costs nothing
  // and cannot be off by an encoding's overhead.
  return payload.base64
    ? decodeBase64Prefix(payload.text, wanted)
    : decodePercentPrefix(payload.text, wanted);
}

/** Which of the four formats these bytes ARE, by signature, or null for none of them. */
function sniffImage(bytes: readonly number[]): string | null {
  for (const [type, matches] of Object.entries(LOGO_SIGNATURES)) {
    if (matches(bytes)) return type;
  }
  return null;
}

/**
 * How large an image a `data:` URI decodes to, or null if its own bytes do not say.
 *
 * **SNIFFED, NOT DECLARED, AND THAT WAS A REAL BYPASS RATHER THAN A PRECAUTION.**
 * This read the media type out of the URI and used the reader for that type. A spec
 * reviewer changed one character -- `data:image/bmp;base64,` in front of PNG bytes --
 * and the 100-megapixel bomb was charged zero pixels, because the reader for "bmp"
 * does not exist and the URI no longer matched a regex that named four types. Pillow
 * and WeasyPrint do not read that field at all: they sniff. So this sniffs, and the
 * declared type is now only ever used by `logoDataUriProblem`, to insist that an
 * UPLOAD says what it is.
 *
 * THE HEADER, NOT THE PAYLOAD: the same hand-rolled prefix decoders the signature
 * check uses (see decodeBase64Prefix for why they are hand-rolled), reading tens of
 * bytes rather than hundreds of thousands. Nothing here decodes an image.
 *
 * A null is "these bytes do not say how big the picture is", which covers a file that
 * is not one of the four formats at all. `logoDataUriProblem` treats it as a refusal;
 * `renderInputCost` charges it the most it could possibly cost.
 */
export function imageDataUriSize(uri: string): ImageSize | null {
  const payload = dataUriPayload(uri);
  if (payload === null) return null;
  const kind = sniffImage(payloadPrefix(payload, 12));
  if (kind === null) return null;
  const size = IMAGE_SIZE_READERS[kind]?.(payloadPrefix(payload, DIMENSION_BYTES[kind] ?? 0)) ?? null;
  if (size === null || size.width < 1 || size.height < 1) return null;
  return size;
}

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
 * AND THE TYPE IN THE URI IS NOT EVIDENCE OF ANYTHING, which is why the fourth check
 * reads the bytes. In a browser that string comes from `File.type`, which is decided
 * by the file's EXTENSION -- so an SVG renamed to .png declares `image/png`, passes
 * every check above, and gets drawn as vector art by a renderer that sniffs properly.
 * See LOGO_SIGNATURES.
 *
 * THE FIFTH CHECK IS THE ONE THE BYTE BOUND CANNOT MAKE, and v1.0.0 did not have it.
 * A file's size says nothing about the raster it decodes to: 12,227 bytes of 1-bit
 * PNG is 10,000 x 10,000 and costs the renderer 535MB. See MAX_LOGO_PIXELS.
 */
export function logoDataUriProblem(uri: string): string | null {
  if (uri === "") return null;
  if (!LOGO_DATA_URI.test(uri)) {
    return "a logo must be a base64 data: URI for a PNG, JPEG, GIF or WEBP image";
  }
  const base64 = uri.slice(uri.indexOf(",") + 1);
  if (base64.length % 4 !== 0) return "the logo's base64 data is malformed";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  // THE DECODED SIZE IS THE BOUND, AND IT IS THE ONLY SIZE BOUND HERE. There was a
  // second one on the string's length, which fired first and said less; at 32KB it
  // was reachable, because 32,768 and 32,769 bytes produce the same 43,692
  // characters and only the arithmetic could tell them apart. At 307,200 -- a
  // multiple of 3 -- the base64 boundary lands exactly on the limit, so anything the
  // string-length bound would have caught this one catches first, with the size in
  // the sentence. Keeping both would have left one that no test could fail.
  //
  // Nothing that passes here can overrun `org_profile_logo_size`, and that is
  // arithmetic rather than hope: MAX_LOGO_BYTES bytes is 409,600 characters of
  // base64, and the longest permitted prefix is 23, which is MAX_LOGO_DATA_URI_CHARS
  // exactly. org-profile.test.ts asserts it for every prefix the regex allows.
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
  // And the raster it decodes to has to be one the renderer can afford, which its
  // file size does not say. An unreadable header is refused rather than waved
  // through: no image library could open it either, so it would print as nothing.
  //
  // THAT LAST CLAUSE WAS FALSE OF GIF UNTIL v1.2.1 and is what the fallback in
  // `gifSize` is for. A GIF whose walk stopped short read as unreadable here and was
  // refused with this sentence, while Pillow opened the same bytes at the size in its
  // screen descriptor -- so the refusal was right for the wrong reason, and the same
  // bytes inside a TEMPLATE, where there is no upload check, were charged per
  // character and accepted. `gifSize` now answers null only where Pillow raises
  // EOFError for want of an image descriptor, which is what makes the clause true.
  //
  // THE COST IS ONE UPLOAD THAT USED TO BE REFUSED AND NOW IS NOT: a small GIF whose
  // frame descriptor is whole and whose image data is truncated. Pillow opens it at
  // the declared size and fails on `load()`, so it draws as nothing -- but so does
  // the `org-logo-preview` <img> on the same screen, since a browser cannot decode it
  // either, and the sentence this used to refuse it with was the false half of the
  // clause above. Pinned in index.test.ts so it stays a decision.
  const size = imageDataUriSize(uri);
  if (size === null) {
    return `this file's header does not say how large the image is,`
      + ` so it is not a ${String(declared)} a renderer could draw`;
  }
  if (size.width * size.height > MAX_LOGO_PIXELS) {
    return `a logo must be ${String(MAX_LOGO_PIXELS)} pixels or fewer; this one is `
      + `${String(size.width)} x ${String(size.height)}, which is `
      + `${String(size.width * size.height)}`;
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
  // THE RESERVE HAS TO BE ENFORCED SOMEWHERE OR IT IS A WISH. A quote's markup budget
  // is the render's markup cap minus a template allowance minus what an issuer's text
  // may cost, and nothing bounded the issuer at all: 3,400 characters of ASCII is
  // 3,400 bytes and the same fields with an `&` in every position are 17,000, because
  // an ampersand escapes to five.
  //
  // THE LOGO IS NO LONGER PART OF THIS SUM, and the path of the issue moved with it:
  // it is the text that can overrun this now, so the message names the text and the
  // issue lands on the first field rather than on the logo the user did not change.
  const bytes = orgProfileTextBytes(value);
  if (bytes > ORG_PROFILE_TEXT_RESERVE_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: `this profile's details need ${String(bytes)} bytes of the `
        + `${String(ORG_PROFILE_TEXT_RESERVE_BYTES)} a quote reserves for them; `
        + "shorten them (an & costs five bytes, not one)",
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
  // Snapshot at issue, not read from the contact -- see documents.recipient_salutation
  // in db/schema.ts. Pronouns are deliberately absent from this record.
  recipientSalutation: z.string(),
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
 * UTF-8 BYTES -- both qualifications matter, since the same document is 2,106
 * characters and 2,112 bytes. THE SIX BYTES ARE THREE EURO SIGNS: `buildContext`
 * formats the subtotal, the tax and the total whatever they are, so even an
 * all-empty quote carries three 3-byte glyphs. Measure without `buildContext` in the
 * pipeline and the document is 2,091 ASCII bytes with nothing to illustrate, which
 * is how this row gets mis-measured.
 *
 *   the template against an all-empty context        2,112 B
 *   a maxed org profile, no logo                     +3,560 B
 *   a maxed org profile INCLUDING a maxed logo     +413,228 B
 *   maxed notes/terms/address/names/salutation      +12,551 B
 *     (ASCII; it was +12,486 before v1.1.0 taught
 *      the template to print the salutation, which
 *      is 64 characters and the space after it)
 *   one more line item, shortest money strings         +139 B
 *   one more line item, widest money strings           +186 B
 *   one more character of ASCII description              +1 B
 *
 * The first two rows read 2,211 and +47,115 until v1.1.0 re-measured them. NEITHER
 * MOVED BECAUSE OF v1.1.0 -- the salutation sits inside
 * `{{#document.recipientContactName}}`, so an empty context renders none of it, and
 * the 2,112 above measures the same on 0009's own body as on the amended one.
 *
 * The logo row was correct when written and went stale: it read +47,320 at the commit
 * that measured it, and 413,228 - 47,320 is 365,908, which is exactly v1.0.1 raising
 * the logo from 43,715 characters to 409,623. The 47,320 became 47,115 in the same
 * edit that corrected ORG_PROFILE_TEXT_RESERVE_BYTES's INPUT arithmetic from one to
 * the other -- but this row measures a merged DOCUMENT, so the edit did not belong
 * to it and 47,320 is the figure that stands.
 *
 * WHAT THE 205 BETWEEN THEM IS HAS NOW BEEN ASKED AND ONLY PARTLY ANSWERED, and the
 * answer this comment gave twice was wrong. It said the 205 bytes ARE the markup the
 * template prints around the URI. That markup is
 * `<div class="logo"><img src="" alt="" /></div>` once the placeholder is
 * substituted, which is 45 bytes, counted. So 45 of the 205 are the markup and the
 * remaining 160 are not attributed to anything -- the row is a difference between two
 * measurements rather than a sum anybody built, and nothing in this file establishes
 * what else moved. Left as an open figure rather than given a second story that
 * happens to fit: the row's own number is the measured one, and the composition of
 * the gap wants a fresh merge measurement, not a guess.
 *
 * The empty-document row has no such story: 0009's body measures 2,106/2,112 at every
 * commit that has ever held it, so 2,205/2,211 was never reproducible and its
 * provenance is unknown. (The only later edit to that part of the template was
 * `<img>` becoming `<img />`, which an empty document does not print at all.)
 *
 * `&` costs 5 bytes and `<` and `>` cost 4, because substitution escapes them and
 * the sanitiser leaves them escaped. `"` and `'` cost 1: they are escaped on the way
 * in and re-serialised bare in text position. Measured, not assumed -- and it is why
 * `documentContentBytes` counts escaped bytes rather than string length.
 */

/**
 * **THE RENDERER HAS TWO BYTE CAPS NOW, AND THAT IS THE WHOLE OF v1.0.1'S DESIGN.**
 * Restated here because the budget below divides one of them up -- and because THE
 * AUTHORITATIVE CHECK IS NOT THIS FILE'S. `issueQuote` measures the merged, sanitised
 * bytes after the merge and before the spawn; everything below PREDICTS that number
 * from the inputs, and a prediction can be wrong.
 *
 * MARKUP AND IMAGE PAYLOAD ARE SEPARATE BECAUSE THEY DO NOT COST THE SAME THING. A
 * render's memory tracks ROWS, not bytes: measured on the server, 128KB of minimal
 * `<tr><td>x</td></tr>` peaks at 345MB where the same 128KB of prose is 71MB. The
 * base64 inside a `data:` URI cannot be a row -- it has no `<` in it, by definition
 * of the alphabet -- so giving it its own allowance lets the logo grow without
 * letting the row count grow with it.
 *
 * v1.0.0 had one cap of 131,072 and the logo took 43,715 of it. A 300KB logo inlines
 * to 409,623, so keeping one cap would mean 496,980 bytes of ANY shape: 128KB of rows
 * costs 345MB, and a cap three times larger costs proportionally more. Measured, the
 * rejected design (a 128KB markup budget with the image allowance added on top)
 * peaks at 440MB against this one's 353MB.
 *
 * The markup half is therefore SMALLER than v1.0.0's single cap, and no document
 * loses anything by it: the template (16,384), the issuer's text (4,285) and the
 * quote's content (66,688) each keep exactly the allowance they had, and what has
 * gone is the 43,715 the logo used to occupy inside the same figure. A merged
 * document that used that slack -- a template repeating a field, with no logo -- is
 * the one case this refuses where v1.0.0 did not.
 */
export const RENDER_IMAGE_CAP_BYTES = MAX_LOGO_DATA_URI_CHARS;

/**
 * What a user-edited template may cost, IN BYTES rather than characters. The shipped
 * one is 3,715 -- 3,616 as 0009 seeds it, plus the 99 bytes 0011's salutation rewrite
 * adds, and a fresh install runs both -- so this is 4.41 times it: room to rework the
 * letterhead, not room to paste a document in.
 *
 * 0011 CHECKS ITS REWRITE AGAINST THIS CONSTANT before applying it, because those 99
 * bytes would otherwise push a template already at the cap past it and leave the
 * operator unable to save their own letterhead. See the migration.
 *
 * BYTES, because a character cap does not bound a render: 16,384 characters of CJK is
 * 48,410 bytes, three times the reserve this constant is supposed to be. Measured on
 * PUT after the body has been sanitised, since the sanitiser can grow what it is
 * given.
 */
export const MAX_TEMPLATE_BYTES = 16 * 1024;

/**
 * What a quote reserves for its issuer's TEXT: the eight fields, escaped, and not
 * the logo -- which is exactly what changed in v1.0.1.
 *
 * v1.0.0 reserved 48,000 for the two together, and that number was 43,715 of logo
 * plus 4,285 of slack around 3,400 characters of text. Adding the two up was the
 * thing that made a bigger logo look impossible: the sum was measured against the
 * SAME cap the document's own content came out of, so every byte of logo was a byte
 * of quote. They are counted separately now -- the logo against MAX_LOGO_BYTES and
 * the image half of the render cap, this against the markup half.
 *
 * 4,285 IS THE SAME BOUND ON THE TEXT AS BEFORE, not a new one: 3,400 characters of
 * ASCII fit (they did), and the same fields full of `&` cost 17,000 and do not (they
 * did not). `orgProfileInputSchema` enforces it, so the reserve is a fact about what
 * can be stored rather than an assumption about what people type.
 *
 * THE FIGURES READ 47,320 AND 60,920 UNTIL PHASE 7'S QUALITY REVIEW, each exactly 205
 * too high, in three places, because the old pair implied a 43,920-character logo --
 * 205 more than the column could hold. The arithmetic is checkable in one line and
 * now is one: 3,400 characters of text, five bytes each in the worst case.
 *
 * THAT CORRECTION WAS APPLIED TO ONE PLACE TOO MANY, and v1.1.0 put it back. The
 * budget table above has a row measuring a maxed org profile in a MERGED DOCUMENT,
 * which is a different quantity from this reserve, so 47,320 was right in that row
 * and was edited to 47,115 along with these. One number, two meanings.
 *
 * WHY THE 205 IS 205 THERE IS NOT SETTLED, and this paragraph used to claim it was:
 * it said the gap IS the `<div class="logo">...</div>` markup the template prints
 * around the URI. Counted, that markup is 45 bytes. The other 160 are unattributed.
 * The budget table above carries the same correction; do not re-derive the old story
 * from this end.
 */
export const ORG_PROFILE_TEXT_RESERVE_BYTES = 4_285;

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
 * What a quote's own content may cost: 66,688 bytes, THE SAME FIGURE v1.0.0 SHIPPED.
 *
 * IT USED TO BE A REMAINDER AND IS A PRIMARY ALLOWANCE NOW, which is the direction
 * v1.0.1 reversed. It was `cap - template - issuer`, where `issuer` included the
 * logo; raising the logo would either have shrunk this or been impossible. The three
 * markup allowances are the given numbers now, and the markup cap is their sum, so
 * this constant did not move when the logo grew by 365,908 bytes -- which is the
 * point of the exercise, stated as arithmetic.
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
 *   - the issuer's reserve was not enforced, so a profile's text could cost 17,000 of
 *     the 4,285 reserved for it. It is enforced now, which closes that one.
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
export const DOCUMENT_CONTENT_BUDGET_BYTES = 66_688;

/**
 * WHAT THE RENDERER WILL ACCEPT THAT IS NOT AN IMAGE PAYLOAD: 87,357 bytes, the sum
 * of the three allowances above and nothing else.
 *
 * **THIS IS THE FIGURE THE MEMORY ARITHMETIC IS BUILT ON, because rows are what cost
 * a render and only markup can carry a row.** Measured on the server through
 * renderPdf with the child's peak RSS sampled from /proc: 87,357 bytes of
 * `<tr><td>x</td></tr>` peaks at 250MB, where the 131,072 v1.0.0 allowed peaks at
 * 345MB. A logo at the pixel bound adds 103MB to the first of those, which is the
 * 353MB documents-render.ts's RENDER_MAX_CONCURRENCY and manifest.toml's
 * `ram.runtime` are computed from.
 *
 * There is no slack in it on purpose: it is exactly what the three parts may cost, so
 * a merged document that overruns it has overrun one of them (or a template repeating
 * a field, which the prediction cannot see and the measurement can).
 */
export const RENDER_MARKUP_CAP_BYTES =
  MAX_TEMPLATE_BYTES + ORG_PROFILE_TEXT_RESERVE_BYTES + DOCUMENT_CONTENT_BUDGET_BYTES;

/**
 * Both halves together: 496,980 bytes. Nothing enforces this on its own -- the two
 * caps are enforced separately, since a document made ENTIRELY of markup up to this
 * figure is exactly what the split exists to refuse -- but a caller reporting what a
 * document cost wants one number for it.
 */
export const RENDER_INPUT_CAP_BYTES = RENDER_MARKUP_CAP_BYTES + RENDER_IMAGE_CAP_BYTES;

/**
 * The pixels a whole document's images may decode to, summed.
 *
 * SUMMED, not per image, because the renderer decodes all of them: four images of
 * 3000 x 2100 measured 198MB, against 250MB for the one 25Mpx image they add up to.
 * A per-image bound would leave the sum unbounded, and it is the sum the machine
 * pays for.
 *
 * It is MAX_LOGO_PIXELS rather than a multiple of it: a quote has one logo, and a
 * template that embeds images of its own is spending the same allowance. A document
 * that wants both has to keep them under it between them.
 */
export const RENDER_IMAGE_PIXEL_CAP = MAX_LOGO_PIXELS;

/** What one document will cost the renderer, split the way the caps are. */
export interface RenderInputCost {
  /** Every byte of it, UTF-8. */
  readonly totalBytes: number;
  /** The payloads of its `data:` URIs, which cannot contain markup. */
  readonly imageBytes: number;
  /** Everything else: the tags, the text, the CSS -- where the rows live. */
  readonly markupBytes: number;
  /**
   * What those payloads decode to, summed: exactly, where the bytes say, and
   * MAX_PIXELS_PER_PAYLOAD_BYTE per character where they do not.
   */
  readonly imagePixels: number;
  /** How many `data:` URIs there are, identifiable or not. */
  readonly images: number;
  /** How many of those could not be identified as one of the four formats. */
  readonly unreadableImages: number;
}

/**
 * ANY `data:` URI anywhere in a document, whatever it claims to be.
 *
 * **IT USED TO NAME THE FOUR TYPES AND THE BASE64 ENCODING, AND THAT WAS THE
 * BYPASS.** `data:image/(png|jpeg|gif|webp);base64,` matched four canonical
 * spellings; the renderer matches none, because it sniffs. Six one-character
 * variations -- `image/bmp`, `image/PNG`, an empty type, an extra parameter,
 * percent-encoding instead of base64 -- were each charged ZERO pixels and ZERO image
 * bytes, and their whole payload was counted as cheap markup. Every one of them
 * rendered the 100-megapixel bomb at ~534MB while passing all three caps. A
 * recogniser narrower than the thing it is protecting is not a control.
 *
 * NOT ANCHORED, unlike LOGO_DATA_URI, because this one is looking INSIDE a page. The
 * run stops at the first character that cannot be in a URL there -- a quote, a
 * bracket, whitespace, or an angle bracket -- and THAT is what keeps the markup
 * accounting honest: a `<` always ends the run, so bytes charged to the image half
 * can never be a table row. (The old comment argued this from the base64 alphabet.
 * The alphabet is no longer what bounds the run; the terminator set is, and it
 * contains `<` explicitly rather than incidentally.)
 */
const EMBEDDED_DATA_URI = /data:[^\s"'`<>)]*/g;

/**
 * How much further a base64 payload runs once whitespace is allowed inside it.
 *
 * **THE RUN ENDING AT A SPACE WAS AN UNDERCHARGE VECTOR, NOT JUST AN ACCOUNTING
 * DETAIL.** `base64.decodebytes` discards whitespace, so `...base64,AAA <the rest>` is
 * one image to the renderer and was three bytes to this scanner: 24,768 pixels
 * charged, 534MB rendered. The run therefore continues across whitespace and stops at
 * the first character that is neither whitespace nor base64 -- which in a document is
 * the closing quote, and in prose is the first punctuation mark, so a sentence
 * mentioning `data:image/png;base64,` still costs a few hundred pixels rather than a
 * refusal.
 */
const BASE64_CONTINUATION = /^[\sA-Za-z0-9+/=]+/;

/**
 * The whole of a `data:` URI starting at a match, whitespace inside a base64 payload
 * included. See BASE64_CONTINUATION.
 */
function wholeDataUri(html: string, uri: string, at: number | undefined): string {
  const payload = dataUriPayload(uri);
  if (payload === null || !payload.base64 || at === undefined) return uri;
  const more = BASE64_CONTINUATION.exec(html.slice(at + uri.length));
  return more === null ? uri : uri + more[0];
}

/**
 * What a payload this cannot identify is CHARGED, per character: 8,256 pixels.
 *
 * **IT IS A PRE-FLIGHT ESTIMATE AND IT IS NOT WHAT MAKES THE PIXEL BOUND SOUND.**
 * Saying otherwise would be the same mistake twice: the bound it comes from is
 * DEFLATE's maximum expansion of 1032:1 (RFC 1951: a 258-byte match from the shortest
 * possible code) times eight pixels per decompressed byte at one bit each, so 8,256 --
 * and the worst 1-bit PNG built for these measurements reached 8,192, which is 99.2%
 * of it. That is tight for every zlib-based format and MEANINGLESS for the rest:
 * measured on the server, a **334-byte JPEG2000 decodes to 36 megapixels**, which is
 * 107,784 pixels per byte and thirteen times this figure. Pillow opens forty formats.
 *
 * documents-render.ts's fetcher catches MOST of what this cannot bound, by refusing
 * to hand the renderer anything whose signature is not a PNG, JPEG, GIF or WEBP --
 * and this charge exists so the large ones are refused EARLY, in a sentence about
 * pixels, before a render slot and a document number are spent. A payload of about
 * 1,938 characters exhausts the cap on its own: far more than a stray `data:` token
 * in prose (whitespace ends the run), far less than a font somebody embedded in a
 * template.
 *
 * **BUT "THE FETCHER STOPS IT" IS NOT TRUE OF EVERY UNIDENTIFIABLE PAYLOAD, AND AN
 * EARLIER VERSION OF THIS COMMENT SAID IT WAS.** The fetcher sniffs the same four
 * signatures, so a payload that BEGINS `GIF89a` passes it and could still be
 * unidentifiable HERE: a 37-byte GIF whose screen descriptor says 8000x8000 but whose
 * block walk ran off the end was charged 429,312 pixels, and Pillow opens it at 64
 * megapixels and renders it, measured at 302MB. The kernel bound was what held there
 * -- 302MB is 59% of RENDER_MEMORY_LIMIT_BYTES -- and it was the only thing that did.
 * Three larger variants of the same trick, including a GIF that is simply missing its
 * trailer, died on that bound instead.
 *
 * **THAT NUMBER WAS WRITTEN AS 37 x 8,256 = 305,472 AND IT WAS WRONG, in a comment
 * whose own last line says why**: the charge is per CHARACTER of the payload as
 * written, and 37 bytes is 52 base64 characters, so it was 52 x 8,256 = 429,312. Both
 * figures are far under the 16,000,000 cap, so the conclusion held and only the
 * arithmetic did not.
 *
 * **FIXED IN v1.2.1**: `gifSize` now falls back to the largest extent it established
 * rather than null, wherever the walk ends before the trailer having reached a frame,
 * and all four variants are charged 64 to 169 megapixels and refused. What remains
 * unidentifiable is a GIF that reaches no frame at all, which Pillow will not open
 * either -- so this per-character charge is no longer what stands between a GIF and
 * the renderer, and the JPEG2000 case above is now the whole of its job.
 *
 * Charged per CHARACTER of the payload as written, which over-charges base64 by 4/3,
 * deliberately and in the safe direction.
 */
export const MAX_PIXELS_PER_PAYLOAD_BYTE = 8_256;

/**
 * What a finished document will cost the renderer, measured on the bytes themselves.
 *
 * **THE MARKUP HALF AND THE IMAGE HALF ARE NOT INTERCHANGEABLE**, which is the whole
 * reason this exists rather than one `byteLength`: 128KB of table rows peaked at
 * 345MB and 128KB of prose at 71MB, and a payload cannot be a table row at all --
 * the run that carries it stops at the first `<`. See RENDER_MARKUP_CAP_BYTES.
 *
 * **AND IT IS POSITION-BLIND ON PURPOSE.** It reads the raw bytes rather than parsing
 * the page, so it cannot be walked past by putting an image somewhere the parser was
 * not looking -- a CSS `url()`, an `xlink:href`, an attribute added to the
 * sanitiser's allowlist next year. The cost of that choice is that a `data:` token in
 * ordinary prose is charged as though it were an image, which is why an unidentified
 * payload is charged what it COULD cost rather than refused outright: a short token
 * costs a rounding error and a real payload cannot hide.
 *
 * `imagePixels` is exact for the four formats whose headers can be read and
 * MAX_PIXELS_PER_PAYLOAD_BYTE per character for everything else, which is the
 * fail-closed half. `unreadableImages` counts the second kind so a refusal can say
 * which it was: "this is bigger than the cap" and "this might be, and nothing here
 * can tell" are different sentences.
 */
export function renderInputCost(html: string): RenderInputCost {
  const encoder = new TextEncoder();
  let imageBytes = 0;
  let imagePixels = 0;
  let images = 0;
  let unreadableImages = 0;
  for (const match of html.matchAll(EMBEDDED_DATA_URI)) {
    const uri = wholeDataUri(html, match[0], match.index);
    const payload = dataUriPayload(uri);
    // Not a data: URI: no comma, so nothing fetches it and nothing decodes it. Its
    // bytes stay charged to the markup half, where they already were.
    if (payload === null) continue;
    images += 1;
    imageBytes += payload.text.length;
    const size = imageDataUriSize(uri);
    if (size === null) {
      unreadableImages += 1;
      imagePixels += payload.text.length * MAX_PIXELS_PER_PAYLOAD_BYTE;
    } else {
      imagePixels += size.width * size.height;
    }
  }
  // A payload is written in ASCII whichever encoding it uses -- base64's alphabet and
  // percent-encoding's escapes are both one byte per character -- so subtracting
  // characters from a UTF-8 byte count is exact rather than approximately right.
  const totalBytes = encoder.encode(html).length;
  return {
    totalBytes, imageBytes, markupBytes: totalBytes - imageBytes,
    imagePixels, images, unreadableImages,
  };
}

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
  recipientSalutation?: string;
  recipientAddress?: string;
  notes?: string;
  terms?: string;
  lines: readonly { description: string }[];
}): number {
  let total = escapedBytes(input.recipientName ?? "") + escapedBytes(input.recipientContactName ?? "")
    + escapedBytes(input.recipientSalutation ?? "")
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
  // The same 64 as CONTACT_FIELD_CAPS.salutation, because this field is filled by
  // copying that one: a cap the contact record permits and the quote form refuses
  // would break the defaulting the moment somebody used the length they were given.
  recipientSalutation: CONTACT_FIELD_CAPS.salutation,
  recipientAddress: 2000,
  notes: 5000,
  terms: 5000,
} as const;

export const issueQuoteInputSchema = z.object({
  issueDate: documentDateSchema,
  validUntilDate: documentDateSchema.nullable().optional(),
  recipientName: documentText(DOCUMENT_FIELD_CAPS.recipientName, 1),
  recipientContactName: documentText(DOCUMENT_FIELD_CAPS.recipientContactName).optional(),
  recipientSalutation: documentText(DOCUMENT_FIELD_CAPS.recipientSalutation).optional(),
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

/**
 * WHAT A TICKET IS PROOF FOR. POST /api/reauth's body carries one of these and
 * the ticket it mints spends at that gate and no other.
 *
 * IT IS HERE RATHER THAN SPELLED TWICE, and that is the opposite of the
 * decision made for the header name (see the web's api.ts): a header name is a
 * transport detail neither side parses, and a mismatch there shows up as a 401
 * the round trip catches. This is a value the client SENDS and the server
 * VALIDATES, so a mismatch would be a 400 nobody sees until an operator meets
 * it -- and the four names below have to agree with the four gated routes
 * exactly. One spelling, checked by the compiler on both sides.
 *
 * WHY FOUR AND NOT ONE PER FILE: the restore is two operations, not one. A
 * preview uploads and decrypts an archive; an apply destroys the database. A
 * ticket for the first must not open the second, which is the whole reason
 * this type exists -- see ReauthTickets in the API's services/reauth.ts for
 * what was true before it did.
 */
export const reauthScopeSchema = z.enum([
  "export", "backup", "restore-preview", "restore-apply",
]);
export type ReauthScope = z.infer<typeof reauthScopeSchema>;

/**
 * POST /api/reauth's answer: a single-use ticket for one download.
 *
 * NOTHING ABOUT THE USER IS IN IT. The ticket is opaque -- 32 random bytes as
 * hex -- and the server remembers which account it belongs to; a client that
 * could read an identity out of it would be a client somebody would eventually
 * trust to.
 *
 * NOR THE SCOPE IT WAS MINTED FOR, for the same reason and one more: the
 * caller asked for it, so echoing it back tells them nothing they did not just
 * say, and a client that read a scope out of a ticket would be a client
 * somebody would eventually let CHOOSE one.
 */
export const reauthTicketSchema = z.object({
  ticket: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});
export type ReauthTicket = z.infer<typeof reauthTicketSchema>;

/**
 * GET /api/backup/preflight's answer: what a backup would cost, before one is
 * started.
 *
 * IT EXISTS BECAUSE THE BACKUP CANNOT STREAM. The whole archive is built before
 * the first byte of the response, so the wait is invisible from the browser and
 * a proxy that gives up on it produces a 504 with nothing to show. Chris ruled
 * on 31 Aug for both halves of the answer: nginx's read timeout is raised for
 * that one route (conf/nginx.conf), and this is what lets the page say how long
 * it will take BEFORE somebody commits to waiting.
 *
 * `estimatedSeconds` is a prediction from a rate measured on the deploy target,
 * not a promise -- see BACKUP_BYTES_PER_SECOND in the API's backup service for
 * what it is made of and how wrong it is allowed to be.
 */
export const backupPreflightSchema = z.object({
  databaseBytes: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
  requiredBytes: z.number().nonnegative(),
  enoughDisk: z.boolean(),
  // How much MORE space is needed than there is, and 0 when there is enough.
  // The server's free disk is deliberately NOT here: this route answers
  // without a password, so everything in it is readable by any session holder.
  shortfallBytes: z.number().nonnegative(),
  estimatedSeconds: z.number().int().nonnegative(),
  slow: z.boolean(),
  timeoutSeconds: z.number().int().positive(),
});
export type BackupPreflight = z.infer<typeof backupPreflightSchema>;

/**
 * POST /api/restore/inspect's answer, PARSED RATHER THAN CAST.
 *
 * WHY THIS ONE IS PARSED WHEN A CAST WOULD COMPILE. Every other response in
 * this file is parsed because a shape mismatch is contract drift worth
 * reporting; this one is parsed because THE PAGE RENDERS IT AS A CONFIRMATION
 * THAT DESTRUCTION IS ABOUT TO HAPPEN. A malformed plan that reached the
 * confirmation as `undefined` effects and a missing refusal would render as
 * "nothing will be destroyed" beside a button that destroys everything. There
 * is no cheaper way to be sure the object under the operator's eyes is the
 * object the server built.
 *
 * THE SCHEMA AND plan.ts's TYPES ARE HELD TOGETHER BY THE COMPILER, not by
 * whoever edits one of them -- see planViewSchemaAgreesWithPlanView below. A
 * field added to PlanView and not to this schema would be silently dropped from
 * the value the page renders, which on this page is the failure mode that
 * matters.
 */
export const planEffectViewSchema = z.object({
  op: z.string(),
  subject: z.string(),
  count: z.number().int().nonnegative(),
  unit: z.enum(["row", "file", "table", "schema", "key", "migration"]),
  destroys: z.boolean(),
  detail: z.string(),
}).readonly();

export const planFindingViewSchema = z.object({
  severity: z.enum(["note", "warning"]),
  code: z.string(),
  message: z.string(),
}).readonly();

export const planRefusalViewSchema = z.object({
  code: z.string(),
  message: z.string(),
}).readonly();

export const planSourceViewSchema = z.object({
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  stagedBytes: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
}).readonly();

export const planViewSchema = z.object({
  planId: z.string(),
  kind: z.enum(["restore", "import-export", "import-csv"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  source: planSourceViewSchema,
  effects: z.array(planEffectViewSchema).readonly(),
  findings: z.array(planFindingViewSchema).readonly(),
  refusal: planRefusalViewSchema.nullable(),
}).readonly();

/**
 * THE INSTRUMENT THAT KEEPS THE SCHEMA ABOVE AND plan.ts's TYPES FROM DRIFTING.
 *
 * Assignability BOTH WAYS, because neither direction sees what the other does.
 * WHAT EACH ONE CATCHES WAS MEASURED, by making the mutation and reading which
 * line the compiler named -- a type-level guard nobody has watched fail is the
 * same nothing a vacuous assertion is, and a tuple `[true, true]` was the first
 * draft and had to go: it reported both failures at one line and column with
 * one sentence, so the error could not say which direction had broken.
 *
 *   PARSED -> PlanView fails when the schema DROPS a field the type has, or
 *   WIDENS one. This is the direction that fails silently at runtime, and it is
 *   the reason the guard exists at all: zod strips what it was not told about,
 *   so the page would render a plan missing exactly the field somebody had just
 *   added for it to render. Measured: adding a field to PlanView alone, and
 *   relaxing `unit` to z.string(), both fail here.
 *
 *   PlanView -> PARSED fails when the schema declares a field the type does
 *   NOT, or NARROWS one -- drift the other way, where the parse would reject a
 *   body the type says is legal. Measured: adding a field to this schema alone
 *   fails here and NOT above.
 */
type ParsedIsUsableAsPlanView = z.infer<typeof planViewSchema> extends PlanView ? true : false;
type PlanViewIsUsableAsParsed = PlanView extends z.infer<typeof planViewSchema> ? true : false;
const parsedPlanIsUsableAsAPlanView: ParsedIsUsableAsPlanView = true;
const aPlanViewIsUsableAsAParsedPlan: PlanViewIsUsableAsParsed = true;
// Referenced so neither constant is dead code to a linter; they exist for the
// two type annotations above and have no runtime meaning.
export const PLAN_VIEW_SCHEMA_AGREES =
  parsedPlanIsUsableAsAPlanView && aPlanViewIsUsableAsAParsedPlan;

/**
 * What the preview answers with, beside the plan.
 *
 * `installName` IS NULLABLE BECAUSE THE SERVER'S ANSWER IS. routes/restore.ts
 * refuses to invent one when it cannot name the database, and a page that
 * defaulted it to a constant would print a confirmation string every caller can
 * type. Null here means the apply route will answer 503, and the page says so
 * rather than offering a field nothing can satisfy.
 */
export const restoreInspectionSchema = z.object({
  plan: planViewSchema,
  installName: z.string().nullable(),
});
export type RestoreInspection = z.infer<typeof restoreInspectionSchema>;

/**
 * What POST /api/restore/apply answers when the restore finished.
 *
 * `restored: true` IS A LITERAL, NOT A BOOLEAN. Every failure body on that
 * route that carries the field at all carries `restored: false`, and those
 * arrive as a non-2xx and therefore as an ApiError rather than through here. A
 * 200 that said `restored: false` would be a contract this client does not
 * understand, and the honest response to it is the shape error rather than a
 * success banner.
 */
export const restoreOutcomeSchema = z.object({
  restored: z.literal(true),
  dispatched: z.number().int().nonnegative(),
  realised: z.number().int().nonnegative(),
  unrealised: z.array(z.string()).readonly(),
  message: z.string(),
});
export type RestoreOutcome = z.infer<typeof restoreOutcomeSchema>;

/**
 * PHASE 7.7'S LAST TWO ARTEFACTS: what the two importers answer with.
 *
 * PARSED FOR THE REASON restoreInspectionSchema IS PARSED, WITH THE DANGER
 * POINTING THE OTHER WAY. A restore preview is parsed because a malformed plan
 * would render as "nothing will be destroyed" beside a button that destroys
 * everything. An import preview is parsed because a malformed plan would render
 * as "nothing will be created" beside a button that creates -- and, more to the
 * point on this pipeline, because the MAPPING VIEW is what the one interactive
 * control in the whole spine is built out of. A `targets` array that arrived as
 * `undefined` would be a picker with no options and no explanation, which is
 * the disabled-for-an-invisible-reason failure this page exists not to ship.
 */
export const csvImportFieldSchema = z.enum([
  "company.name", "company.domain", "company.website", "company.phone",
  "company.address", "company.industry",
  "contact.first_name", "contact.last_name", "contact.email", "contact.phone",
  "contact.job_title", "contact.salutation", "contact.pronouns", "contact.company_name",
]);

export const csvImportFieldDefSchema = z.object({
  field: csvImportFieldSchema,
  entity: z.enum(["company", "contact"]),
  label: z.string(),
  required: z.boolean(),
  repeatable: z.boolean(),
  hint: z.string(),
}).readonly();

export const csvColumnViewSchema = z.object({
  index: z.number().int().nonnegative(),
  header: z.string(),
  samples: z.array(z.string()).readonly(),
  filled: z.number().int().nonnegative(),
  suggestion: csvImportFieldSchema.nullable(),
}).readonly();

export const csvDialectViewSchema = z.object({
  delimiter: z.string(),
  delimiterName: z.string(),
  sniffed: z.boolean(),
}).readonly();

export const csvMappingViewSchema = z.object({
  source: planSourceViewSchema,
  dialect: csvDialectViewSchema,
  columns: z.array(csvColumnViewSchema).readonly(),
  targets: z.array(csvImportFieldDefSchema).readonly(),
  sampled: z.number().int().nonnegative(),
  findings: z.array(planFindingViewSchema).readonly(),
  refusal: planRefusalViewSchema.nullable(),
}).readonly();

/**
 * THE INSTRUMENT THAT KEEPS THE SCHEMA ABOVE AND import-mapping.ts's TYPES FROM
 * DRIFTING, on planViewSchemaAgreesWithPlanView's exact precedent and for the
 * exact reason -- including that the two directions are two constants rather
 * than one tuple, so a failure names which way the drift went.
 *
 * MEASURED RATHER THAN ASSUMED, the same way its sibling was. Relaxing
 * `suggestion` to z.string().nullable() fails the first line and not the
 * second; adding a field to this schema alone fails the second and not the
 * first; deleting `targets` from the schema fails the first.
 */
type ParsedIsUsableAsCsvMappingView =
  z.infer<typeof csvMappingViewSchema> extends CsvMappingView ? true : false;
type CsvMappingViewIsUsableAsParsed =
  CsvMappingView extends z.infer<typeof csvMappingViewSchema> ? true : false;
const parsedMappingIsUsableAsAMappingView: ParsedIsUsableAsCsvMappingView = true;
const aMappingViewIsUsableAsAParsedMapping: CsvMappingViewIsUsableAsParsed = true;
export const CSV_MAPPING_VIEW_SCHEMA_AGREES =
  parsedMappingIsUsableAsAMappingView && aMappingViewIsUsableAsAParsedMapping;

/** POST /api/import/csv/inspect's answer: what is in this file? */
export const csvInspectionSchema = z.object({ mapping: csvMappingViewSchema });
export type CsvInspection = z.infer<typeof csvInspectionSchema>;

/**
 * What both importers' preview routes answer with.
 *
 * NO `installName` BESIDE IT, and the absence is the point rather than an
 * omission. A restore is confirmed by typing the name of the database it
 * destroys; an import destroys nothing, so there is nothing to confirm by
 * name and a field asking for one would be teaching the reflex that the
 * restore's field depends on being unusual.
 */
export const importInspectionSchema = z.object({ plan: planViewSchema });
export type ImportInspection = z.infer<typeof importInspectionSchema>;

/**
 * What an apply answers when the rows are in.
 *
 * `imported: true` IS A LITERAL, on restoreOutcomeSchema's precedent: every
 * failure body carries `imported: false` and arrives as a non-2xx, so a 200
 * saying otherwise is a contract this client does not understand and the honest
 * response is a shape error rather than a success banner.
 *
 * THERE IS NO `unrealised` HERE AND ITS ABSENCE IS A FACT ABOUT IMPORTS RATHER
 * THAN AN OMISSION. A restore needs that field because its destroy step is a
 * PREPARATION -- it satisfies its accounting before anything is destroyed, so
 * `dispatched` and `realised` can differ and the difference is the only honest
 * answer to "did the destruction happen". Neither importer has a preparatory
 * effect: every effect does its own work, services/intake-plan.ts refuses a
 * plan whose preparation has no consumer, and a failure answers a non-2xx and
 * never reaches this shape at all. The field would be `[]` on every response
 * this schema can ever parse.
 */
export const importOutcomeSchema = z.object({
  imported: z.literal(true),
  dispatched: z.number().int().nonnegative(),
  realised: z.number().int().nonnegative(),
  spent: z.number().int().nonnegative(),
  message: z.string(),
});
export type ImportOutcome = z.infer<typeof importOutcomeSchema>;
