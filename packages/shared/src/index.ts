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

// Widened in Phase 2 (Task 7) from company/contact to company/contact/deal: a
// note or file can now be attached to a deal instead, mirroring the
// notes_exactly_one_entity / files_exactly_one_entity DB CHECKs (see
// schema.ts), which already gained a deal_id column back in P2.1.
const exactlyOneEntity = (v: { companyId?: string | null; contactId?: string | null; dealId?: string | null }) =>
  [v.companyId, v.contactId, v.dealId].filter((x) => x != null).length === 1;

export const createNoteInputSchema = z
  .object({
    body: z.string().min(1),
    companyId: z.uuid().optional(), contactId: z.uuid().optional(), dealId: z.uuid().optional(),
  })
  .refine(exactlyOneEntity, { message: "exactly one of companyId, contactId or dealId is required" });
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

export const noteSchema = z.object({
  id: z.uuid(), body: z.string().min(1), authorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Note = z.infer<typeof noteSchema>;

export const fileMetaSchema = z.object({
  id: z.uuid(), originalName: z.string().min(1), mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().length(64),
  uploaderUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

// Phase 2 (pipelines/deals) adds four more verbs, and (Task 7) a nullable
// dealId: a deal event carries both dealId and companyId (when the deal has
// one) so it surfaces on both the deal's own timeline and its company's --
// see services/deals.ts's publishDealHint/toDeal-adjacent comments.
export const eventVerbSchema = z.enum([
  "created", "updated", "archived", "unarchived", "note_added", "file_attached",
  "stage_changed", "won", "lost", "reopened",
]);
export const eventSchema = z.object({
  id: z.uuid(), verb: eventVerbSchema, actorUserId: z.uuid(),
  companyId: z.uuid().nullable(), contactId: z.uuid().nullable(), dealId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
});
export type Event = z.infer<typeof eventSchema>;

// --- Pipelines, stages, deals (Phase 2) ---------------------------------

export const pipelineScopeSchema = z.enum(["global", "company"]);
export type PipelineScope = z.infer<typeof pipelineScopeSchema>;

export const pipelineSchema = z.object({
  id: z.uuid(), name: z.string().min(1),
  scope: pipelineScopeSchema, companyId: z.uuid().nullable(),
  position: z.string().min(1),
  archivedAt: z.iso.datetime().nullable(), ...timestamps,
});
export type Pipeline = z.infer<typeof pipelineSchema>;

// company_id pairs with scope exactly as the pipelines_scope_company_paired DB
// CHECK requires: present iff scope is "company", absent iff scope is "global".
const scopeCompanyPaired = (v: { scope: PipelineScope; companyId?: string }) =>
  (v.scope === "company") === (v.companyId !== undefined);

export const createPipelineInputSchema = z
  .object({ name: z.string().min(1), scope: pipelineScopeSchema, companyId: z.uuid().optional() })
  .refine(scopeCompanyPaired, { message: "companyId is required exactly when scope is company" });
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
});
export type SearchResults = z.infer<typeof searchResultsSchema>;
