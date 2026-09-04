import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  backupPreflightSchema,
  bulkThreadResultSchema,
  bulkMessageResultSchema,
  companySchema,
  contactSchema,
  csvInspectionSchema,
  dealSchema,
  documentSchema,
  documentTemplateSchema,
  eventSchema,
  fileMetaSchema,
  funnelRowSchema,
  importInspectionSchema,
  importOutcomeSchema,
  ganttPayloadSchema,
  listResponseSchema,
  mailAccountFolderSchema,
  mailAccountListSchema,
  mailAccountSchema,
  mailAccountTestResultSchema,
  mailMessageSchema,
  mailThreadDetailSchema,
  mailThreadListItemSchema,
  mailThreadSchema,
  mailUnreadCountSchema,
  mailUnreadFolderCountsSchema,
  markThreadReadResponseSchema,
  meResponseSchema,
  meetingDetailSchema,
  meetingSchema,
  midpoint,
  noteSchema,
  orgProfileSchema,
  reauthTicketSchema,
  restoreInspectionSchema,
  restoreOutcomeSchema,
  pipelineSchema,
  pipelineWithStagesSchema,
  projectSchema,
  searchResultsSchema,
  shiftResultSchema,
  stageSchema,
  taskDependencySchema,
  taskSchema,
  usersResponseSchema,
  type BulkThreadActionInput,
  type BulkMessageActionInput,
  type Company,
  type Contact,
  type CreateCompanyInput,
  type CsvMapping,
  type CreateContactInput,
  type CreateDealInput,
  type CreateNoteInput,
  type CreatePipelineInput,
  type CreateProjectInput,
  type CreateStageInput,
  type CreateTaskInput,
  type Deal,
  type DocumentRecord,
  type DocumentTemplate,
  type DocumentTemplateInput,
  type DocumentType,
  type IssueQuoteInput,
  type FolderPatchInput,
  type GanttPayload,
  type MailAccountCreateInput,
  type MailAccountFolder,
  type MailAccountTestInput,
  type MailAccountUpdateInput,
  type MailAccountUpdatePasswordFields,
  type MailLinkKind,
  type MailMessage,
  type MailThread,
  type MarkThreadReadResponse,
  type Meeting,
  type MeetingCreateInput,
  type MeetingTaskCreateInput,
  type OrgProfile,
  type OrgProfileInput,
  type Pipeline,
  type PipelineScope,
  type Project,
  type ProjectStatus,
  type ReauthScope,
  type SendMailInput,
  type ShiftResult,
  type Stage,
  type Task,
  type TaskStatus,
  type UpdateCompanyInput,
  type UpdateContactInput,
  type UpdateDealInput,
  type UpdatePipelineInput,
  type UpdateProjectInput,
  type UpdateStageInput,
  type UpdateTaskInput,
} from "@conduit/shared";
import {
  ApiError, ResponseShapeError, deleteJson, deleteRequest, downloadArchive, getJson,
  patchJson, postForm, postFormWithTicket, postJson, postJsonWithTicket, putJson, saveBlob,
} from "./api";

const companyListSchema = listResponseSchema(companySchema);
const contactListSchema = listResponseSchema(contactSchema);
const eventListSchema = listResponseSchema(eventSchema);
const noteListSchema = noteSchema.array();
const fileListSchema = fileMetaSchema.array();
const pipelineListSchema = pipelineSchema.array();
const dealListSchema = dealSchema.array();
const funnelListSchema = funnelRowSchema.array();
const projectListSchema = projectSchema.array();
const taskListSchema = taskSchema.array();
const taskDependencyListSchema = taskDependencySchema.array();
const mailThreadListSchema = listResponseSchema(mailThreadListItemSchema);
const mailAccountFolderListSchema = mailAccountFolderSchema.array();
const meetingListSchema = listResponseSchema(meetingSchema);

/** Builds a `?a=1&b=2` query string, dropping keys whose value is undefined. */
function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? "" : `?${qs}`;
}

/**
 * Every fetcher below runs its response through a Zod schema so contract
 * drift between the API and this UI fails loudly rather than producing
 * `undefined`s deep in a component. A raw `schema.parse()` failure surfaces
 * as a JSON-stringified Zod issue array in `error.message`, which is fine in
 * a log but unreadable wherever a caught error gets rendered to a user. This
 * wraps that: the full issue list still goes to the console for debugging,
 * but the thrown error carries a short, readable message instead.
 *
 * The thrown type is ResponseShapeError, not a bare Error, so a caller can tell
 * "the server answered and this client could not read it" apart from "the
 * request may never have been answered at all" -- see its doc comment in api.ts,
 * and bulkErrorMessage, which must not offer its timeout copy for a 200.
 */
function parseWith<T>(schema: { parse: (v: unknown) => T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    // Contract drift between API and UI. Log the full issue list for debugging,
    // surface a short human message to whatever renders the error.
    console.error(`response validation failed for ${what}`, error);
    throw new ResponseShapeError(`Unexpected response shape from the server (${what})`);
  }
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export interface CompanyListParams {
  q?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}

export function useCompanies(params: CompanyListParams = {}) {
  return useQuery({
    queryKey: ["companies", params],
    queryFn: async () => {
      const qs = toQueryString({
        q: params.q, archived: params.archived, cursor: params.cursor, limit: params.limit,
      });
      return parseWith(companyListSchema, await getJson<unknown>(`/companies${qs}`), "companies list");
    },
  });
}

export function useCompany(id: string) {
  return useQuery({
    queryKey: ["company", id],
    queryFn: async () => parseWith(companySchema, await getJson<unknown>(`/companies/${id}`), "company"),
    enabled: id !== "",
  });
}

/**
 * Every company mutation below invalidates ["companies"] (all list queries,
 * since TanStack Query treats an invalidated key as a prefix match),
 * ["events"] (a company change always writes a timeline event server-side),
 * and ["search"] (an archived/renamed company must stop/change matching a
 * search hit immediately, not after the query's staleTime lapses). Update/
 * archive/unarchive additionally invalidate the specific ["company", id]
 * detail query; create has no prior detail query to invalidate.
 */
function useInvalidateCompany() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["companies"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["company", id] });
  };
}

export function useCreateCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (input: CreateCompanyInput) =>
      parseWith(companySchema, await postJson<unknown>("/companies", input), "company"),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useUpdateCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateCompanyInput }) =>
      parseWith(companySchema, await patchJson<unknown>(`/companies/${id}`, patch), "company"),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useArchiveCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(companySchema, await postJson<unknown>(`/companies/${id}/archive`), "company"),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useUnarchiveCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(companySchema, await postJson<unknown>(`/companies/${id}/unarchive`), "company"),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactListParams {
  q?: string;
  archived?: boolean;
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export function useContacts(params: ContactListParams = {}) {
  return useQuery({
    queryKey: ["contacts", params],
    queryFn: async () => {
      const qs = toQueryString({
        q: params.q, archived: params.archived, company_id: params.companyId,
        cursor: params.cursor, limit: params.limit,
      });
      return parseWith(contactListSchema, await getJson<unknown>(`/contacts${qs}`), "contacts list");
    },
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ["contact", id],
    queryFn: async () => parseWith(contactSchema, await getJson<unknown>(`/contacts/${id}`), "contact"),
    enabled: id !== "",
  });
}

// Mirrors useInvalidateCompany above -- see its doc comment.
function useInvalidateContact() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["contact", id] });
  };
}

export function useCreateContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (input: CreateContactInput) =>
      parseWith(contactSchema, await postJson<unknown>("/contacts", input), "contact"),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useUpdateContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateContactInput }) =>
      parseWith(contactSchema, await patchJson<unknown>(`/contacts/${id}`, patch), "contact"),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useArchiveContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(contactSchema, await postJson<unknown>(`/contacts/${id}/archive`), "contact"),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useUnarchiveContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(contactSchema, await postJson<unknown>(`/contacts/${id}/unarchive`), "contact"),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

// projectId (Phase 3 P3.6) is a fourth optional entity filter alongside the
// original three, mirroring the notes/files/events routes' own widened
// company_id/contact_id/deal_id/project_id query params.
export interface EntityFilterParams {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

export function useNotes(params: EntityFilterParams) {
  return useQuery({
    queryKey: ["notes", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId, project_id: params.projectId,
      });
      return parseWith(noteListSchema, await getJson<unknown>(`/notes${qs}`), "notes list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined || params.dealId !== undefined
      || params.projectId !== undefined,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateNoteInput) =>
      parseWith(noteSchema, await postJson<unknown>("/notes", input), "note"),
    // A note's body is searchable server-side, so a newly created note must
    // also stop being invisible to search immediately -- see
    // useInvalidateCompany's doc comment for why ["search"] is invalidated
    // eagerly rather than left to expire on its own.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function useFiles(params: EntityFilterParams) {
  return useQuery({
    queryKey: ["files", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId, project_id: params.projectId,
      });
      return parseWith(fileListSchema, await getJson<unknown>(`/files${qs}`), "files list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined || params.dealId !== undefined
      || params.projectId !== undefined,
  });
}

export interface UploadFileInput {
  file: File;
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, companyId, contactId, dealId, projectId }: UploadFileInput) => {
      const form = new FormData();
      // The entity id field(s) must be appended before the file field: the API
      // (packages/api/src/routes/files.ts) streams the multipart body and only
      // sees fields that arrive ahead of the file part.
      if (companyId !== undefined) form.append("companyId", companyId);
      if (contactId !== undefined) form.append("contactId", contactId);
      if (dealId !== undefined) form.append("dealId", dealId);
      if (projectId !== undefined) form.append("projectId", projectId);
      form.append("file", file);
      return parseWith(fileMetaSchema, await postForm("/files", form), "file");
    },
    // Broad ["files"] invalidation (all list queries, prefix-matched), mirroring
    // useCreateNote above, rather than reconstructing the one filter combination
    // this upload matches -- simpler, and correct regardless of how a caller
    // sliced its useFiles({ companyId, contactId }) params.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Pipelines + stages
// ---------------------------------------------------------------------------

export interface PipelineListParams {
  scope?: PipelineScope;
  companyId?: string;
  // Phase 3 P3.7: project-scoped pipelines (project-detail.tsx's own
  // Pipelines section, mirroring company-detail.tsx's).
  projectId?: string;
  archived?: boolean;
}

// Unpaginated, mirroring listPipelines server-side (see its doc comment in
// services/pipelines.ts) -- a plain array, not { items, nextCursor }.
export function usePipelines(params: PipelineListParams = {}) {
  return useQuery({
    queryKey: ["pipelines", params],
    queryFn: async () => {
      const qs = toQueryString({
        scope: params.scope, company_id: params.companyId, project_id: params.projectId, archived: params.archived,
      });
      return parseWith(pipelineListSchema, await getJson<unknown>(`/pipelines${qs}`), "pipelines list");
    },
  });
}

// Composite { pipeline, stages } response -- see pipelineWithStagesSchema's
// doc comment in @conduit/shared for why getPipeline returns the bundle.
export function usePipeline(id: string) {
  return useQuery({
    queryKey: ["pipeline", id],
    queryFn: async () =>
      parseWith(pipelineWithStagesSchema, await getJson<unknown>(`/pipelines/${id}`), "pipeline"),
    enabled: id !== "",
  });
}

// Mirrors useInvalidateCompany's doc comment: publishPipelineHint in
// services/pipelines.ts publishes ["pipelines"], ["pipeline", id], ["events"]
// after every pipeline/stage mutation, so this invalidates the same set for
// mutations issued from this tab (the SSE client, wired in a later task,
// covers the ones issued elsewhere).
function useInvalidatePipeline() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["pipeline", id] });
  };
}

export function useCreatePipeline() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async (input: CreatePipelineInput) =>
      parseWith(pipelineSchema, await postJson<unknown>("/pipelines", input), "pipeline"),
    onSuccess: (pipeline: Pipeline) => invalidate(pipeline.id),
  });
}

export function useUpdatePipeline() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdatePipelineInput }) =>
      parseWith(pipelineSchema, await patchJson<unknown>(`/pipelines/${id}`, patch), "pipeline"),
    onSuccess: (pipeline: Pipeline) => invalidate(pipeline.id),
  });
}

export function useArchivePipeline() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(pipelineSchema, await postJson<unknown>(`/pipelines/${id}/archive`), "pipeline"),
    onSuccess: (pipeline: Pipeline) => invalidate(pipeline.id),
  });
}

// Mirrors useArchivePipeline above -- board.tsx's read-only banner (Phase
// 3.1) is the first caller, restoring an archived pipeline to an editable
// board the same way useUnarchiveCompany/useUnarchiveProject already do for
// their own entities.
export function useUnarchivePipeline() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(pipelineSchema, await postJson<unknown>(`/pipelines/${id}/unarchive`), "pipeline"),
    onSuccess: (pipeline: Pipeline) => invalidate(pipeline.id),
  });
}

// Stages have no cache of their own -- they ride along inside the
// pipeline-detail response (pipelineWithStagesSchema) -- so every stage
// mutation below invalidates the owning ["pipeline", pipelineId] (which
// refetches the bundle, stages included) via the same helper pipeline
// mutations use.
export function useCreateStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async ({ pipelineId, input }: { pipelineId: string; input: CreateStageInput }) =>
      parseWith(stageSchema, await postJson<unknown>(`/pipelines/${pipelineId}/stages`, input), "stage"),
    onSuccess: (_stage: Stage, { pipelineId }) => invalidate(pipelineId),
  });
}

export function useUpdateStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async (
      { pipelineId, stageId, patch }: { pipelineId: string; stageId: string; patch: UpdateStageInput },
    ) =>
      parseWith(
        stageSchema,
        await patchJson<unknown>(`/pipelines/${pipelineId}/stages/${stageId}`, patch),
        "stage",
      ),
    onSuccess: (_stage: Stage, { pipelineId }) => invalidate(pipelineId),
  });
}

export interface ReorderStageParams {
  pipelineId: string;
  stageId: string;
  beforeStageId?: string;
  afterStageId?: string;
}

export function useReorderStage() {
  const invalidate = useInvalidatePipeline();
  return useMutation({
    mutationFn: async ({ pipelineId, stageId, beforeStageId, afterStageId }: ReorderStageParams) =>
      parseWith(
        stageSchema,
        await postJson<unknown>(`/pipelines/${pipelineId}/stages/${stageId}/reorder`, {
          beforeStageId, afterStageId,
        }),
        "stage",
      ),
    onSuccess: (_stage: Stage, { pipelineId }) => invalidate(pipelineId),
  });
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

// pipeline_id is required server-side (see listDeals's doc comment in
// services/deals.ts): a kanban board always renders exactly one pipeline's
// columns, so this hook takes the id directly rather than a params object.
export function useDeals(pipelineId: string) {
  return useQuery({
    queryKey: ["deals", pipelineId],
    queryFn: async () => {
      const qs = toQueryString({ pipeline_id: pipelineId });
      return parseWith(dealListSchema, await getJson<unknown>(`/deals${qs}`), "deals list");
    },
    enabled: pipelineId !== "",
  });
}

// Mirrors publishDealHint in services/deals.ts: every deal mutation
// publishes ["deals", pipelineId], ["deal", id], ["funnel", pipelineId],
// ["events"], ["search"] after commit -- see useInvalidateCompany's doc
// comment for why ["search"] is invalidated eagerly rather than left to
// expire on its own (a deal title change or an archive must stop/change
// matching a search hit immediately).
function useInvalidateDeal() {
  const queryClient = useQueryClient();
  return (pipelineId: string, id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["deals", pipelineId] });
    void queryClient.invalidateQueries({ queryKey: ["deal", id] });
    void queryClient.invalidateQueries({ queryKey: ["funnel", pipelineId] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
  };
}

// Single-deal detail query, mirroring useCompany/useContact -- the ["deal", id]
// key this uses is already the one publishDealHint/useInvalidateDeal target
// (added ahead of this hook back in P2.3/P2.6), so every deal mutation already
// invalidates it correctly; this was just the missing reader.
export function useDeal(id: string) {
  return useQuery({
    queryKey: ["deal", id],
    queryFn: async () => parseWith(dealSchema, await getJson<unknown>(`/deals/${id}`), "deal"),
    enabled: id !== "",
  });
}

export function useCreateDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async (input: CreateDealInput) =>
      parseWith(dealSchema, await postJson<unknown>("/deals", input), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useUpdateDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateDealInput }) =>
      parseWith(dealSchema, await patchJson<unknown>(`/deals/${id}`, patch), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useArchiveDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async (id: string) => parseWith(dealSchema, await postJson<unknown>(`/deals/${id}/archive`), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useUnarchiveDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(dealSchema, await postJson<unknown>(`/deals/${id}/unarchive`), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export interface MoveDealParams {
  id: string;
  pipelineId: string;
  stageId: string;
  beforeDealId?: string;
  afterDealId?: string;
}

interface MoveDealContext {
  queryKey: readonly [string, string];
  previous: Deal[] | undefined;
}

/**
 * Optimistic move: onMutate snapshots the ["deals", pipelineId] cache,
 * reassigns the dragged deal's stageId, and computes a plausible new
 * position with the same midpoint() the server uses -- so the card lands in
 * roughly the right slot before the network round-trip returns, instead of
 * snapping back to its old spot for a beat. That local position is only ever
 * a guess: onSuccess invalidates the same key set every other deal mutation
 * does (see useInvalidateDeal), which refetches the server's authoritative
 * order (moveDeal's neighbour-narrowing in services/deals.ts can land the
 * deal somewhere slightly different than this guess when the drop gap wasn't
 * empty). onError rolls back to the snapshot; a 409 specifically ("conflict"
 * -- the board's view of the target gap was stale, per moveDealInputSchema's
 * JSDoc) ALSO invalidates ["deals", pipelineId] on top of the rollback, since
 * the pre-drag snapshot itself may now be stale too and only a refetch gets
 * the client back to truth.
 */
export function useMoveDeal() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateDeal();
  return useMutation<Deal, unknown, MoveDealParams, MoveDealContext>({
    mutationFn: async ({ id, stageId, beforeDealId, afterDealId }: MoveDealParams) =>
      parseWith(
        dealSchema,
        await postJson<unknown>(`/deals/${id}/move`, { stageId, beforeDealId, afterDealId }),
        "deal",
      ),
    onMutate: async (params) => {
      const queryKey = ["deals", params.pipelineId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Deal[]>(queryKey);
      if (previous !== undefined) {
        const positionOf = (id?: string) => (id === undefined ? null : previous.find((d) => d.id === id)?.position ?? null);
        const beforePos = positionOf(params.beforeDealId);
        const afterPos = positionOf(params.afterDealId);
        let position: string;
        try {
          if (beforePos !== null || afterPos !== null) {
            position = midpoint(beforePos, afterPos);
          } else {
            // Neither neighbour named: append at the tail of the target
            // stage, mirroring moveDealInputSchema's "both omitted" append
            // semantics.
            const tail = previous
              .filter((d) => d.stageId === params.stageId && d.id !== params.id)
              .reduce<string | null>((max, d) => (max === null || d.position > max ? d.position : max), null);
            position = midpoint(tail, null);
          }
        } catch {
          // A stale/invalid neighbour pair locally (e.g. the board's cached
          // copy of the two named neighbours is no longer adjacent) --
          // keep the deal's current position rather than crash the drag;
          // the server's response (or the rollback below) corrects it.
          position = previous.find((d) => d.id === params.id)?.position ?? "";
        }
        queryClient.setQueryData<Deal[]>(
          queryKey,
          previous.map((deal) => (deal.id === params.id ? { ...deal, stageId: params.stageId, position } : deal)),
        );
      }
      return { queryKey, previous };
    },
    onError: (error, params, context) => {
      if (context !== undefined) queryClient.setQueryData(context.queryKey, context.previous);
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["deals", params.pipelineId] });
      }
    },
    onSuccess: (deal: Deal, params) => invalidate(params.pipelineId, deal.id),
  });
}

export function useWinDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async (id: string) => parseWith(dealSchema, await postJson<unknown>(`/deals/${id}/win`), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useLoseDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      parseWith(dealSchema, await postJson<unknown>(`/deals/${id}/lose`, { reason }), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useReopenDeal() {
  const invalidate = useInvalidateDeal();
  return useMutation({
    mutationFn: async (id: string) => parseWith(dealSchema, await postJson<unknown>(`/deals/${id}/reopen`), "deal"),
    onSuccess: (deal: Deal) => invalidate(deal.pipelineId, deal.id),
  });
}

export function useFunnel(pipelineId: string) {
  return useQuery({
    queryKey: ["funnel", pipelineId],
    queryFn: async () =>
      parseWith(funnelListSchema, await getJson<unknown>(`/pipelines/${pipelineId}/funnel`), "funnel"),
    enabled: pipelineId !== "",
  });
}

// ---------------------------------------------------------------------------
// Projects (Phase 3)
// ---------------------------------------------------------------------------

export interface ProjectListParams {
  companyId?: string;
  status?: ProjectStatus;
  archived?: boolean;
}

// Unpaginated, mirroring listProjects server-side (see its doc comment in
// services/projects.ts) -- a plain array, not { items, nextCursor }, same
// shape usePipelines already uses for the same reason.
export function useProjects(params: ProjectListParams = {}) {
  return useQuery({
    queryKey: ["projects", params],
    queryFn: async () => {
      const qs = toQueryString({ company_id: params.companyId, status: params.status, archived: params.archived });
      return parseWith(projectListSchema, await getJson<unknown>(`/projects${qs}`), "projects list");
    },
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: async () => parseWith(projectSchema, await getJson<unknown>(`/projects/${id}`), "project"),
    enabled: id !== "",
  });
}

// Mirrors publishProjectHint in services/projects.ts: every project mutation
// publishes ["projects"], ["project", id], ["events"], ["search"] after
// commit -- see useInvalidateCompany's doc comment for why ["search"] is
// invalidated eagerly rather than left to expire on its own.
function useInvalidateProject() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["project", id] });
  };
}

export function useCreateProject() {
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) =>
      parseWith(projectSchema, await postJson<unknown>("/projects", input), "project"),
    onSuccess: (project: Project) => invalidate(project.id),
  });
}

export function useUpdateProject() {
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateProjectInput }) =>
      parseWith(projectSchema, await patchJson<unknown>(`/projects/${id}`, patch), "project"),
    onSuccess: (project: Project) => invalidate(project.id),
  });
}

export function useArchiveProject() {
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(projectSchema, await postJson<unknown>(`/projects/${id}/archive`), "project"),
    onSuccess: (project: Project) => invalidate(project.id),
  });
}

export function useUnarchiveProject() {
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(projectSchema, await postJson<unknown>(`/projects/${id}/unarchive`), "project"),
    onSuccess: (project: Project) => invalidate(project.id),
  });
}

// ---------------------------------------------------------------------------
// Tasks (Phase 3)
// ---------------------------------------------------------------------------

export interface TaskListParams {
  projectId?: string;
  standalone?: boolean;
  assigneeId?: string;
  status?: TaskStatus;
  dated?: boolean;
  archived?: boolean;
}

/**
 * Unpaginated, mirroring listTasks server-side. The query key's second
 * segment mirrors publishTaskHint's own invalidation key shape
 * (services/tasks.ts: `["tasks", task.projectId ?? "standalone"]`) so a task
 * mutation's project-scoped invalidation prefix-matches every useTasks call
 * scoped to that same project (the task board's own useTasks({ projectId })
 * call, in particular) regardless of which extra filters (status/dated/
 * archived) it also applies. A caller that names neither projectId nor
 * standalone -- there is none in this phase; My Tasks uses useMyTasks below
 * instead, which keys off ["my-tasks", assigneeId] to match the server's own
 * per-assignee publish hint directly -- falls back to a literal "all"
 * segment so the key stays well-formed rather than colliding with either
 * scoped shape.
 */
export function useTasks(params: TaskListParams = {}) {
  const scope = params.projectId ?? (params.standalone === true ? "standalone" : "all");
  return useQuery({
    queryKey: ["tasks", scope, params],
    queryFn: async () => {
      const qs = toQueryString({
        project_id: params.projectId, standalone: params.standalone, assignee_id: params.assigneeId,
        status: params.status, dated: params.dated, archived: params.archived,
      });
      return parseWith(taskListSchema, await getJson<unknown>(`/tasks${qs}`), "tasks list");
    },
  });
}

// Single-task detail query for the task drawer (Task 8), mirroring
// useDeal/useProject -- the ["task", id] key this uses is exactly what
// publishTaskHint (services/tasks.ts) publishes on every task mutation
// (added alongside deals'/projects' own ["deal", id]/["project", id]
// precedent), so both this and useTaskDependencies below (a deeper key
// under the same prefix) invalidate correctly whether the mutation landed
// in this tab or arrived over SSE from another one.
export function useTask(id: string) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: async () => parseWith(taskSchema, await getJson<unknown>(`/tasks/${id}`), "task"),
    enabled: id !== "",
  });
}

// This task's predecessors -- GET /api/tasks/:id/dependencies
// (services/tasks.ts's listDependencies), scoped under ["task", id] (see
// useTask's doc comment above) rather than a sibling top-level key, so
// invalidating ["task", id] anywhere also refreshes this.
export function useTaskDependencies(id: string) {
  return useQuery({
    queryKey: ["task", id, "dependencies"],
    queryFn: async () =>
      parseWith(taskDependencyListSchema, await getJson<unknown>(`/tasks/${id}/dependencies`), "task dependencies"),
    enabled: id !== "",
  });
}

/**
 * Mirrors publishTaskHint in services/tasks.ts: every task mutation
 * publishes ["tasks", scope], ["task", id], ["gantt"], ["events"],
 * ["search"], plus ["my-tasks", assigneeId] for every assignee actually
 * touched (the task's current one, and -- via extraAssigneeIds -- its
 * pre-patch one on a reassignment, so both the old and new My Tasks lists
 * refresh).
 */
function useInvalidateTask() {
  const queryClient = useQueryClient();
  return (task: Task, extraAssigneeIds: (string | null)[] = []) => {
    const scope = task.projectId ?? "standalone";
    void queryClient.invalidateQueries({ queryKey: ["tasks", scope] });
    void queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    void queryClient.invalidateQueries({ queryKey: ["gantt"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    const assignees = new Set<string>();
    if (task.assigneeUserId !== null) assignees.add(task.assigneeUserId);
    for (const a of extraAssigneeIds) if (a !== null) assignees.add(a);
    for (const a of assignees) void queryClient.invalidateQueries({ queryKey: ["my-tasks", a] });
  };
}

export function useCreateTask() {
  const invalidate = useInvalidateTask();
  return useMutation({
    mutationFn: async (input: CreateTaskInput) =>
      parseWith(taskSchema, await postJson<unknown>("/tasks", input), "task"),
    onSuccess: (task: Task) => invalidate(task),
  });
}

export function useUpdateTask() {
  const invalidate = useInvalidateTask();
  return useMutation({
    // previousAssigneeUserId is optional: passed by a caller that already
    // holds the pre-patch task (e.g. the task drawer, Task 8) so a
    // reassignment invalidates both the old and new My Tasks lists,
    // mirroring the server's own extraAssigneeIds parameter. A caller
    // without it handy still self-heals within the query's own staleTime.
    mutationFn: async (
      { id, patch }: { id: string; patch: UpdateTaskInput; previousAssigneeUserId?: string | null },
    ) => parseWith(taskSchema, await patchJson<unknown>(`/tasks/${id}`, patch), "task"),
    onSuccess: (task: Task, { previousAssigneeUserId }) =>
      invalidate(task, previousAssigneeUserId !== undefined ? [previousAssigneeUserId] : []),
  });
}

export function useSetTaskStatus() {
  const invalidate = useInvalidateTask();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: TaskStatus }) =>
      parseWith(taskSchema, await postJson<unknown>(`/tasks/${id}/status`, { status }), "task"),
    onSuccess: (task: Task) => invalidate(task),
  });
}

// Archive/unarchive, mirroring useArchiveDeal/useArchiveProject -- the task
// drawer (Task 8) is the first caller.
export function useArchiveTask() {
  const invalidate = useInvalidateTask();
  return useMutation({
    mutationFn: async (id: string) => parseWith(taskSchema, await postJson<unknown>(`/tasks/${id}/archive`), "task"),
    onSuccess: (task: Task) => invalidate(task),
  });
}

export function useUnarchiveTask() {
  const invalidate = useInvalidateTask();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(taskSchema, await postJson<unknown>(`/tasks/${id}/unarchive`), "task"),
    onSuccess: (task: Task) => invalidate(task),
  });
}

export interface BoardMoveTaskParams {
  id: string;
  projectId: string | null;
  status: TaskStatus;
  beforeTaskId?: string;
  afterTaskId?: string;
}

interface BoardMoveTaskContext {
  queryKey: readonly [string, string, TaskListParams];
  previous: Task[] | undefined;
}

/**
 * Optimistic board move, mirroring useMoveDeal's shape exactly (see its own
 * doc comment for the full reasoning): onMutate snapshots the scoped
 * useTasks({ projectId }) cache entry, reassigns the dragged task's status
 * and a plausible new position via the same midpoint() the server uses, and
 * rolls back on error -- a 409 additionally invalidates the scoped key so a
 * stale local view of the target column's gap gets corrected from the
 * server rather than just reverted.
 */
export function useBoardMoveTask() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTask();
  return useMutation<Task, unknown, BoardMoveTaskParams, BoardMoveTaskContext>({
    mutationFn: async ({ id, status, beforeTaskId, afterTaskId }: BoardMoveTaskParams) =>
      parseWith(
        taskSchema,
        await postJson<unknown>(`/tasks/${id}/board-move`, { status, beforeTaskId, afterTaskId }),
        "task",
      ),
    onMutate: async (params) => {
      const scope = params.projectId ?? "standalone";
      // Matches exactly the params shape task-board.tsx's useTasks({ projectId })
      // call produces (projectId, everything else undefined) -- TanStack's
      // default key hashing treats undefined-valued keys as absent, so this
      // hashes identically to that call's own queryKey.
      const filterParams: TaskListParams = { projectId: params.projectId ?? undefined };
      const queryKey = ["tasks", scope, filterParams] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Task[]>(queryKey);
      if (previous !== undefined) {
        const positionOf = (id?: string) => (id === undefined ? null : previous.find((t) => t.id === id)?.position ?? null);
        const beforePos = positionOf(params.beforeTaskId);
        const afterPos = positionOf(params.afterTaskId);
        let position: string;
        try {
          if (beforePos !== null || afterPos !== null) {
            position = midpoint(beforePos, afterPos);
          } else {
            // Neither neighbour named: append at the tail of the target
            // status column, mirroring createTask's append semantics.
            const tail = previous
              .filter((t) => t.status === params.status && t.id !== params.id)
              .reduce<string | null>((max, t) => (max === null || t.position > max ? t.position : max), null);
            position = midpoint(tail, null);
          }
        } catch {
          // A stale/invalid neighbour pair locally -- keep the task's
          // current position rather than crash the drag; the server's
          // response (or the rollback below) corrects it.
          position = previous.find((t) => t.id === params.id)?.position ?? "";
        }
        queryClient.setQueryData<Task[]>(
          queryKey,
          previous.map((t) => (t.id === params.id ? { ...t, status: params.status, position } : t)),
        );
      }
      return { queryKey, previous };
    },
    onError: (error, _params, context) => {
      if (context !== undefined) queryClient.setQueryData(context.queryKey, context.previous);
      if (error instanceof ApiError && error.status === 409 && context !== undefined) {
        void queryClient.invalidateQueries({ queryKey: context.queryKey });
      }
    },
    onSuccess: (task: Task) => invalidate(task),
  });
}

/**
 * Dependency mutations only know the two task ids involved, not either
 * task's current project/assignee -- the precise scoped invalidation
 * useInvalidateTask computes from a whole Task isn't available here, so
 * this falls back to broad ["tasks"]/["gantt"] prefixes (a strict superset
 * of the server's own successor-scoped publish hint in
 * services/tasks.ts's addDependency/removeDependency). Correctness over
 * precision for a low-frequency mutation.
 *
 * ["task", successorId] IS precise, though: it's exactly the key
 * publishTaskHint's ["task", task.id] entry targets (services/tasks.ts --
 * addDependency/removeDependency both call publishTaskHint on the successor),
 * and TanStack's prefix match reaches the task drawer's deeper
 * ["task", id, "dependencies"] cache (useTaskDependencies below) too, so the
 * drawer's predecessor list refreshes from this same call with no separate
 * key.
 */
function invalidateAfterDependencyChange(queryClient: ReturnType<typeof useQueryClient>, successorId: string): void {
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  void queryClient.invalidateQueries({ queryKey: ["task", successorId] });
  void queryClient.invalidateQueries({ queryKey: ["gantt"] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
}

export function useAddDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    // :id in the route names the successor -- see services/tasks.ts's
    // addDependency doc comment for why the dependency direction is
    // predecessor -> successor.
    mutationFn: async ({ predecessorId, successorId }: { predecessorId: string; successorId: string }) =>
      parseWith(
        taskDependencySchema,
        await postJson<unknown>(`/tasks/${successorId}/dependencies`, { predecessorId }),
        "task dependency",
      ),
    onSuccess: (_dep, { successorId }) => invalidateAfterDependencyChange(queryClient, successorId),
  });
}

export function useRemoveDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ predecessorId, successorId }: { predecessorId: string; successorId: string }) => {
      await deleteRequest(`/tasks/${successorId}/dependencies/${predecessorId}`);
    },
    onSuccess: (_void, { successorId }) => invalidateAfterDependencyChange(queryClient, successorId),
  });
}

export interface ShiftTaskParams {
  id: string;
  startDate: string;
  dueDate: string;
}

/**
 * Optimistic dates on the dragged task only -- the server decides which
 * successors actually cascade, and Task 9's Gantt is expected to read the
 * moved list off this mutation's own `data` (the raw ShiftResult response,
 * kept around by useMutation automatically) for its post-commit cascade
 * flash, rather than anything written to a query cache here; see
 * shiftResultSchema's own doc comment in @conduit/shared for why
 * cascadedFrom needs the whole response, not a per-task cache patch.
 *
 * Patches every currently-cached ["gantt", ...] query that contains this
 * task, rather than one specific key the way useMoveDeal/useBoardMoveTask
 * target a single list -- Task 9's per-project and global Gantt pages are
 * the first and only callers, and there is no way to know in advance which
 * of the two shapes (or both) is mounted. onError rolls every patched query
 * back to its own snapshot.
 */
export function useShiftTask() {
  const queryClient = useQueryClient();
  return useMutation<ShiftResult, unknown, ShiftTaskParams, Map<readonly unknown[], GanttPayload>>({
    mutationFn: async ({ id, startDate, dueDate }: ShiftTaskParams) =>
      parseWith(shiftResultSchema, await postJson<unknown>(`/tasks/${id}/shift`, { startDate, dueDate }), "shift result"),
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ["gantt"] });
      const snapshots = new Map<readonly unknown[], GanttPayload>();
      const queries = queryClient.getQueriesData<GanttPayload>({ queryKey: ["gantt"] });
      for (const [key, data] of queries) {
        if (data === undefined) continue;
        snapshots.set(key, data);
        if (!data.tasks.some((t) => t.id === params.id)) continue;
        queryClient.setQueryData<GanttPayload>(key, {
          ...data,
          tasks: data.tasks.map((t) => (t.id === params.id ? { ...t, startDate: params.startDate, dueDate: params.dueDate } : t)),
        });
      }
      return snapshots;
    },
    onError: (_error, _params, snapshots) => {
      if (snapshots === undefined) return;
      for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["gantt"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      // my-tasks keys are deliberately not invalidated here: this hook has
      // no Task/assignee list handy (only the ShiftResult's moved ids), and
      // scheduling.ts's shiftTask already scopes its own my-tasks SSE hints
      // to the assignees actually touched -- a same-tab caller sees the
      // moved dates immediately via the optimistic patch above regardless.
    },
  });
}

/**
 * "Remove slack" (Phase 3.1) -- POST /api/projects/:id/compact
 * (services/scheduling.ts's compactSchedule). Invalidates the EXACT same key
 * set useShiftTask's onSuccess does: from the client's point of view a
 * project-wide compaction is just a bigger version of the same "some tasks'
 * dates changed" event a single drag produces. No optimistic patch (unlike
 * useShiftTask): a compaction can move an unbounded number of tasks in one
 * call, so there's no single dragged task's dates to preview locally --
 * chart.tsx's compact button waits for the real response and flashes off of
 * its `moved` list directly, same as it already does with useShiftTask's.
 */
export function useCompactSchedule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      parseWith(shiftResultSchema, await postJson<unknown>(`/projects/${projectId}/compact`), "shift result"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["gantt"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    },
  });
}

export type GanttTarget = { projectId: string } | { global: true };

export function useGantt(target: GanttTarget) {
  const key = "projectId" in target ? target.projectId : "global";
  return useQuery({
    queryKey: ["gantt", key],
    queryFn: async () => {
      const path = "projectId" in target ? `/projects/${target.projectId}/gantt` : "/gantt";
      return parseWith(ganttPayloadSchema, await getJson<unknown>(path), "gantt payload");
    },
    enabled: "projectId" in target ? target.projectId !== "" : true,
  });
}

// My Tasks (Task 8) keys off ["my-tasks", assigneeId] directly rather than
// through useTasks' ["tasks", scope, params] shape, so it matches the
// server's own per-assignee publish hint (publishTaskHint's extraAssigneeIds
// loop in services/tasks.ts) exactly -- an assigned task can live in any
// project (or none), so there is no single ["tasks", scope] prefix that
// would cover every task this needs to show.
export function useMyTasks(assigneeId: string) {
  return useQuery({
    queryKey: ["my-tasks", assigneeId],
    queryFn: async () => {
      const qs = toQueryString({ assignee_id: assigneeId });
      return parseWith(taskListSchema, await getJson<unknown>(`/tasks${qs}`), "tasks list");
    },
    enabled: assigneeId !== "",
  });
}

// ---------------------------------------------------------------------------
// Events (timeline)
// ---------------------------------------------------------------------------

// taskId (Phase 3 P3.6) lets the task drawer's own timeline (Task 8) filter
// down to one task's events, mirroring the project_id filter EntityFilterParams
// already carries -- events.ts's route accepts both alongside the original
// three.
export interface EventListParams extends EntityFilterParams {
  taskId?: string;
  cursor?: string;
  limit?: number;
}

export function useEvents(params: EventListParams = {}) {
  return useQuery({
    queryKey: ["events", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId,
        task_id: params.taskId, project_id: params.projectId,
        cursor: params.cursor, limit: params.limit,
      });
      return parseWith(eventListSchema, await getJson<unknown>(`/events${qs}`), "events list");
    },
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => parseWith(usersResponseSchema, await getJson<unknown>("/users"), "users list").users,
  });
}

// A react-query-flavoured GET /api/me, alongside App.tsx's own plain
// fetchMe()-in-a-useEffect (api.ts) -- that one exists to gate the whole
// app's first paint on identity resolving and has no reason to route
// through the query cache. My Tasks (Task 8) needs the current user's id as
// a normal read inside an already-mounted page (useMyTasks(me.id)), so it
// goes through this hook instead -- same parseWith validation every other
// hook here gets, and free caching/staleTime like any other query.
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => parseWith(meResponseSchema, await getJson<unknown>("/me"), "me").user,
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: async () =>
      parseWith(searchResultsSchema, await getJson<unknown>(`/search?q=${encodeURIComponent(q)}`), "search results"),
    enabled: q.trim() !== "",
  });
}

// ---------------------------------------------------------------------------
// Mail (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Every query key below is EXACTLY the key the API's own mail SSE hints
 * publish -- ["mail-accounts"] (services/mail-accounts.ts, and mail-sync.ts's
 * status flips), ["mail-threads"]/["mail-thread", id]/["mail-unread"]
 * (services/mail-threads.ts's publishThreadHint and mail-ingest.ts's ingest
 * hint) -- so components/sse.tsx's invalidation works on them unchanged, with
 * no mail-specific case.
 *
 * Phase 4.1 adds one more published family, registered here so the next hook
 * to need it uses the key the server already sends rather than inventing one:
 *
 * - ["mail-folders", accountId] -- one account's discovered folder set
 *   (api: services/mail-folders.ts's publishFoldersHint). Published by the
 *   Settings folder toggle and by any sync pass whose discovery CREATES or
 *   RECLASSIFIES a folder. Per account, not global: a busy second mailbox has
 *   no business invalidating the first account's picker. Read by
 *   useMailFolders below (the sidebar and the Settings picker).
 *
 * And one key that is NOT a published family, noted here for the same reason:
 *
 * - ["mail-unread", "by-folder"] -- where the sidebar's per-folder counts
 *   (GET /api/mail/unread-count?byFolder=1) belong. Nesting it UNDER
 *   ["mail-unread"] is the whole point: the server publishes the parent, and
 *   TanStack Query's prefix matching invalidates both the badge and the
 *   per-folder counts from that one hint, so the sidebar stays live without
 *   the API needing a second key for the same fact. Read by
 *   useUnreadMailCountsByFolder below.
 *
 * ["search"] is the one key the mail hints deliberately do NOT carry: an
 * ingest or a thread archive does not invalidate the global search cache
 * server-side, exactly as in Phases 1-3, where each MUTATION HOOK lists
 * ["search"] among its own invalidations (see useInvalidateCompany's doc
 * comment for why it is invalidated eagerly rather than left to expire). The
 * mail mutation hooks below follow that same division of labour.
 */

export interface MailAccountsOptions {
  /**
   * Polling interval, in ms, for the mounting component only.
   *
   * FRESHNESS CONTRACT (routes/mail.ts's GET /api/mail/accounts doc comment):
   * `syncStats` on each own account is a set of in-process counters read at
   * fetch time, and nothing publishes a hint when they move -- the
   * ["mail-accounts"] hint fires on account mutations and status flips, a
   * much rarer event. The Settings mail page owns freshness for its own view
   * by passing an interval here; every OTHER consumer must treat this hook as
   * an SSE-invalidated cache of the account ROWS and leave this unset.
   */
  refetchInterval?: number;
}

export function useMailAccounts(options: MailAccountsOptions = {}) {
  return useQuery({
    // Deliberately NOT keyed on the options above: a polling consumer and a
    // non-polling one must share one cache entry (and one SSE key), the same
    // way two useCompanies({}) callers do -- refetchInterval is an observer
    // setting, not part of the query's identity.
    queryKey: ["mail-accounts"],
    queryFn: async () =>
      parseWith(mailAccountListSchema, await getJson<unknown>("/mail/accounts"), "mail accounts"),
    refetchInterval: options.refetchInterval,
  });
}

// Mirrors useInvalidateCompany: ["mail-accounts"] is the list every account
// mutation changes, and ["search"] rides along per the house convention
// documented at the top of this section.
function useInvalidateMailAccount() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["mail-accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
  };
}

export function useCreateMailAccount() {
  const invalidate = useInvalidateMailAccount();
  return useMutation({
    mutationFn: async (input: MailAccountCreateInput) =>
      parseWith(mailAccountSchema, await postJson<unknown>("/mail/accounts", input), "mail account"),
    onSuccess: () => invalidate(),
  });
}

/**
 * PATCH body: settings, password fields, or both -- exactly the merge
 * routes/mail.ts's accountPatchSchema performs. The password halves are
 * optional and "" means KEEP THE STORED ONE (mailAccountUpdatePasswordFields
 * Schema in @conduit/shared, and mail-accounts.ts's updateAccount); a lone
 * `password` sets both protocols, `password`+`smtpPassword` sets them
 * separately, which is the settings form's "SMTP differs" toggle off/on.
 */
export type MailAccountPatch = MailAccountUpdateInput & MailAccountUpdatePasswordFields;

export function useUpdateMailAccount() {
  const invalidate = useInvalidateMailAccount();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: MailAccountPatch }) =>
      parseWith(mailAccountSchema, await patchJson<unknown>(`/mail/accounts/${id}`, patch), "mail account"),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveMailAccount() {
  const invalidate = useInvalidateMailAccount();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(mailAccountSchema, await postJson<unknown>(`/mail/accounts/${id}/archive`), "mail account"),
    onSuccess: () => invalidate(),
  });
}

export function useUnarchiveMailAccount() {
  const invalidate = useInvalidateMailAccount();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(mailAccountSchema, await postJson<unknown>(`/mail/accounts/${id}/unarchive`), "mail account"),
    onSuccess: () => invalidate(),
  });
}

/**
 * Dry-run IMAP+SMTP login. The ONLY mail mutation hook here that invalidates
 * nothing -- mail-accounts.ts's testConnection persists no row and publishes
 * no hint (it does not even flip `status`), so there is nothing for a cache
 * to have gone stale about. Takes either a stored account (`{ accountId }`,
 * optionally with field overrides) or a complete, not-yet-saved set of
 * settings; blank password fields must be OMITTED rather than sent as "" --
 * mailAccountTestInputSchema holds them to `.min(1)`, and an omitted password
 * on an `accountId` test is what makes it use the stored credentials.
 */
export function useTestMailAccount() {
  return useMutation({
    mutationFn: async (input: MailAccountTestInput) =>
      parseWith(
        mailAccountTestResultSchema,
        await postJson<unknown>("/mail/accounts/test", input),
        "mail account test result",
      ),
  });
}

/**
 * One account's discovered folders (Phase 4.1) -- the Settings picker and the
 * inbox sidebar.
 *
 * Keyed EXACTLY as the server publishes it: `[["mail-folders", accountId]]`
 * (api: services/mail-folders.ts's publishFoldersHint), fired by the folder
 * PATCH and by any discovery pass that creates or reclassifies a folder. Per
 * account, so a busy second mailbox does not invalidate the first one's picker.
 *
 * Owner-only server-side: another user's account 404s exactly like a
 * nonexistent one, so this is only ever called with an id from `own`.
 */
export function useMailFolders(accountId: string) {
  return useQuery({
    queryKey: ["mail-folders", accountId],
    queryFn: async () =>
      parseWith(
        mailAccountFolderListSchema,
        await getJson<unknown>(`/mail/accounts/${accountId}/folders`),
        "mail folders",
      ),
    enabled: accountId !== "",
  });
}

/**
 * Toggle one folder's sync_enabled (PATCH .../folders, by folder NAME).
 *
 * Invalidates this account's folders plus the thread/unread families: enabling
 * a folder changes what the sidebar offers AND, once its first pass lands, what
 * the list holds. The server asks its own sync loop for a pass (fire and
 * forget) and publishes the folder hint after the write, so the two paths agree.
 */
export function useSetFolderSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId, input }: { accountId: string; input: FolderPatchInput }) =>
      parseWith(
        mailAccountFolderSchema,
        await patchJson<unknown>(`/mail/accounts/${accountId}/folders`, input),
        "mail folder",
      ),
    onSuccess: (_folder: MailAccountFolder, { accountId }) => {
      void queryClient.invalidateQueries({ queryKey: ["mail-folders", accountId] });
      void queryClient.invalidateQueries({ queryKey: ["mail-threads"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-unread"] });
    },
  });
}

export interface MailThreadListParams {
  accountId?: string;
  unread?: boolean;
  unlinked?: boolean;
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
  /** The Hidden view (Phase 4.3): true lists only the viewer's hidden
   * threads, absent is the default not-hidden view -- the route's `hidden`
   * tri-state flag (see the shared threadListFiltersSchema.hidden). */
  hidden?: boolean;
  /** The folder view (Phase 4.1): threads with at least one message in this
   * folder. Sent BYTE-EXACT as the folders endpoint listed it -- an IMAP
   * mailbox name is matched as bytes all the way down. */
  folder?: string;
  cursor?: string;
  limit?: number;
}

// Keyset-paginated { items, nextCursor } by (last_message_at, id), like every
// other list route behind listResponseSchema -- NOT the plain array
// usePipelines/useProjects return.
export function useMailThreads(params: MailThreadListParams = {}) {
  return useQuery({
    queryKey: ["mail-threads", params],
    queryFn: async () => {
      const qs = toQueryString({
        account_id: params.accountId, unread: params.unread, unlinked: params.unlinked,
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId,
        project_id: params.projectId, hidden: params.hidden,
        // `folder`, not `folder_id` or a snake_case variant: it is a NAME, and
        // the route's own query schema spells it exactly this way.
        folder: params.folder,
        cursor: params.cursor, limit: params.limit,
      });
      return parseWith(mailThreadListSchema, await getJson<unknown>(`/mail/threads${qs}`), "mail threads list");
    },
  });
}

// Composite { thread, messages, dealSuggestions } response -- see
// mailThreadDetailSchema in @conduit/shared for why the bundle is one fetch.
//
// `all` is the detail cap's escape hatch (Phase 4.3): true asks for the
// uncapped conversation (`?all=true`), absent/false the newest-50 page. The
// two are separate cache entries -- distinct payloads must not share a key --
// but both sit under the ["mail-thread", id] prefix, so every existing
// invalidation (useInvalidateMailThread, the SSE hints) reaches both without
// knowing the flag exists. `enabled` gates the `all` fetch until the
// Show-earlier control actually asks (see conversation.tsx, which mounts
// this pair and prefers the uncapped answer once it lands).
export function useMailThread(id: string, opts: { all?: boolean; enabled?: boolean } = {}) {
  const all = opts.all === true;
  return useQuery({
    queryKey: all ? ["mail-thread", id, "all"] : ["mail-thread", id],
    queryFn: async () =>
      parseWith(
        mailThreadDetailSchema,
        await getJson<unknown>(`/mail/threads/${id}${all ? "?all=true" : ""}`),
        "mail thread",
      ),
    enabled: (opts.enabled ?? true) && id !== "",
  });
}

// The three keys services/mail-threads.ts's publishThreadHint publishes on
// every thread mutation, plus ["search"] (see this section's header comment).
function useInvalidateMailThread() {
  const queryClient = useQueryClient();
  return (threadId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["mail-threads"] });
    void queryClient.invalidateQueries({ queryKey: ["mail-thread", threadId] });
    void queryClient.invalidateQueries({ queryKey: ["mail-unread"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
  };
}

// Invalidation is GATED on the response's `changed` flag: the conversation
// view fires this unconditionally on open (its unseen state is not
// derivable from a capped page -- see conversation.tsx), so an already-read
// thread would otherwise cost a full invalidation round per click for a
// write that wrote nothing. The server publishes no SSE hint on that same
// no-op path; when something DID change, both this gate and the hint fire,
// and SSE remains the always-path for every other client.
export function useMarkThreadRead() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(
        markThreadReadResponseSchema,
        await postJson<unknown>(`/mail/threads/${id}/read`),
        "mark thread read",
      ),
    onSuccess: (result: MarkThreadReadResponse) => {
      if (result.changed) invalidate(result.thread.id);
    },
  });
}

export function useSetThreadLink() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async ({ threadId, kind, id }: { threadId: string; kind: MailLinkKind; id: string }) =>
      parseWith(
        mailThreadSchema,
        await postJson<unknown>(`/mail/threads/${threadId}/links`, { kind, id }),
        "mail thread",
      ),
    onSuccess: (thread: MailThread) => invalidate(thread.id),
  });
}

export function useClearThreadLink() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async ({ threadId, kind }: { threadId: string; kind: MailLinkKind }) =>
      parseWith(
        mailThreadSchema,
        await deleteJson<unknown>(`/mail/threads/${threadId}/links/${kind}`),
        "mail thread",
      ),
    onSuccess: (thread: MailThread) => invalidate(thread.id),
  });
}

// Hide/Unhide in CRM, the per-actor filing pair (Phase 4.3). The hooks are
// named for what they do; the WIRE keeps its `/archive`/`/unarchive` paths --
// an address, not a label (api: routes/mail.ts's hide routes).
export function useHideThread() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(mailThreadSchema, await postJson<unknown>(`/mail/threads/${id}/archive`), "mail thread"),
    onSuccess: (thread: MailThread) => invalidate(thread.id),
  });
}

export function useUnhideThread() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(mailThreadSchema, await postJson<unknown>(`/mail/threads/${id}/unarchive`), "mail thread"),
    onSuccess: (thread: MailThread) => invalidate(thread.id),
  });
}

/**
 * Compose and reply (POST /api/mail/send, 201 with the stored outbound
 * message). A send lands a new message -- and, when composing fresh, a new
 * thread -- so it invalidates the same key family a thread mutation does,
 * keyed on the message's own threadId. An SMTP refusal arrives as an
 * ApiError with status 502 / code "smtp_failed" and nothing is stored, so the
 * composer still holds the draft and can retry it as-is.
 */
export function useSendMail() {
  const invalidate = useInvalidateMailThread();
  return useMutation({
    mutationFn: async (input: SendMailInput) =>
      parseWith(mailMessageSchema, await postJson<unknown>("/mail/send", input), "sent mail message"),
    onSuccess: (message: MailMessage) => invalidate(message.threadId),
  });
}

// Distinct non-archived threads holding an unseen message -- the inbox nav
// badge (Task 10). ["mail-unread"] is published by ingest AND by every thread
// mutation, so the badge follows both a new arrival and a mark-read without
// polling.
export function useUnreadMailCount() {
  return useQuery({
    queryKey: ["mail-unread"],
    queryFn: async () =>
      parseWith(mailUnreadCountSchema, await getJson<unknown>("/mail/unread-count"), "mail unread count").count,
  });
}

/**
 * The folder sidebar's badges: one grouped query, not one request per folder.
 *
 * Keyed UNDER ["mail-unread"] so the server's own bare ["mail-unread"] hint --
 * published by ingest and by every thread mutation -- invalidates these counts
 * by prefix along with the nav badge. There is no separate server key for this,
 * and there does not need to be (see this section's header comment).
 *
 * The two answers are NOT the same number sliced differently, and neither is
 * derived from the other here: the nav badge is "unread anywhere, excluding
 * each account's Trash", while every row of this one is "unseen IN that folder"
 * with no Trash carve-out at all -- so a Trash row's badge honestly counts the
 * unread mail in Trash (the two-scope ruling, spec's Bulk API section). Render
 * what the API returns; do not re-derive either from the other.
 */
export function useUnreadMailCountsByFolder() {
  return useQuery({
    queryKey: ["mail-unread", "by-folder"],
    queryFn: async () =>
      parseWith(
        mailUnreadFolderCountsSchema,
        await getJson<unknown>("/mail/unread-count?byFolder=1"),
        "mail unread counts by folder",
      ).folders,
  });
}

/**
 * The bulk thread actions: Trash, Archive and File (Phase 4.4) MOVE messages
 * on the IMAP server, "Hide in CRM" and its inverse set and clear the
 * CRM-side, per-viewer hide row.
 *
 * `folder` carries the move service's two modes and the caller decides which:
 * PRESENT means folder-scoped (a multi-select made in a folder view acts only
 * on the messages in THAT folder), ABSENT means whole-thread (the conversation
 * view's single-thread buttons). See bulk-bar.tsx for the ruling on the
 * unfiltered list. `targetFolder` is a DIFFERENT field and a different
 * question -- where the mail is going, for `file` alone.
 *
 * ALWAYS 200 when the request was valid: per-thread failures ride inside the
 * body, so a caller must read `results` rather than trusting the absence of a
 * throw. And a THROW is not the same as a failure either -- a proxy 504 means
 * the answer was lost while the queued moves carry on (the route says so in as
 * many words), which is why the invalidation below hangs off onSettled: after
 * this call the client's view of the mail is unknown either way, and the fix is
 * to refetch, never to retry.
 */
export function useBulkThreadAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkThreadActionInput) =>
      parseWith(
        bulkThreadResultSchema,
        await postJson<unknown>("/mail/threads/bulk", input),
        "bulk thread action result",
      ),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ["mail-threads"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-unread"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      // Filing can have switched a folder's sync ON (api: mail-move.ts), which
      // changes what the sidebar shows and what the picker says about it. The
      // server publishes its own folders hint from that write, so this is the
      // belt to that braces: a client whose SSE stream is down still sees the
      // switch it just caused. Every accountId's, because the response says
      // WHICH folder was enabled but not on which accounts, and a bulk
      // selection can span several.
      if (input.action === "file") {
        void queryClient.invalidateQueries({ queryKey: ["mail-folders"] });
      }
      // Each touched thread's own detail entry: the conversation on screen may
      // be one of them, and its messages' folders have just changed.
      for (const threadId of input.threadIds) {
        void queryClient.invalidateQueries({ queryKey: ["mail-thread", threadId] });
      }
    },
  });
}

/**
 * The per-message actions (Phase 4.4 Task 2): Trash, Archive and File applied
 * to individual messages of a conversation rather than to whole threads.
 *
 * ITS OWN HOOK AND ITS OWN ENDPOINT, matching the API's ruling: a message id is
 * a different unit from a thread id, the response is keyed on `messageId`, and
 * there is no `folder` because the ids ARE the scope. The two hooks share no
 * body shape, which is the point -- one that took either would be the
 * overloading the whole task exists to avoid.
 *
 * WHAT IT INVALIDATES IS DELIBERATELY THE SAME SET, minus the one key it cannot
 * name. Filing a message changes which folder views its THREAD appears in (a
 * thread is "in" a folder when any of its messages is), so the thread list and
 * the unread counts move exactly as they do for a thread action -- filing one
 * message out of an INBOX-only conversation removes that conversation from the
 * INBOX view. The key it cannot name is the thread's own detail entry: the
 * response carries message ids, not the threads they belong to. ["mail-thread"]
 * as a PREFIX covers every open conversation instead, which is at most the one
 * on screen and its capped/uncapped pair -- the coarser invalidation is the
 * honest one here, since guessing the thread id client-side would mean trusting
 * a cache to still hold rows the server has just moved.
 */
export function useBulkMessageAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkMessageActionInput) =>
      parseWith(
        bulkMessageResultSchema,
        await postJson<unknown>("/mail/messages/bulk", input),
        "bulk message action result",
      ),
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ["mail-threads"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-unread"] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
      void queryClient.invalidateQueries({ queryKey: ["mail-thread"] });
      // Filing can have switched a folder's sync ON (api: mail-move.ts), which
      // changes what the sidebar shows and what the picker offers. The server
      // publishes its own folders hint from that write; this is the belt to
      // that braces, for a client whose SSE stream is down.
      if (input.action === "file") {
        void queryClient.invalidateQueries({ queryKey: ["mail-folders"] });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Meetings (Phase 5)
// ---------------------------------------------------------------------------

/**
 * The keys below are EXACTLY the ones the meetings service publishes --
 * ["meetings"], ["meeting", id], ["events"] (api: services/meetings.ts's
 * publishMeetingHint) -- so components/sse.tsx invalidates them with no
 * meetings-specific case, exactly as the mail keys work.
 *
 * ["search"] is deliberately NOT among them, here or in the mutation hooks:
 * meetings are not a search group (searchResultsSchema has no meetings
 * member), so nothing about a meeting can change a search result. Notes and
 * files invalidate it because their bodies and filenames ARE indexed.
 *
 * No viewer segment on any key, matching every other family in this file: the
 * cache is per browser session and identity comes from the reverse proxy's
 * Ynh-User header, which cannot change within one (Phase 5 Task 4's O4
 * ruling, which settled this for the mail keys and applies unchanged here).
 */
export interface MeetingListParams extends EntityFilterParams {
  archived?: boolean;
  cursor?: string;
  limit?: number;
}

export function useMeetings(params: MeetingListParams = {}) {
  return useQuery({
    queryKey: ["meetings", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId,
        deal_id: params.dealId, project_id: params.projectId,
        archived: params.archived, cursor: params.cursor, limit: params.limit,
      });
      return parseWith(meetingListSchema, await getJson<unknown>(`/meetings${qs}`), "meetings list");
    },
    // GET /api/meetings without a record filter is a valid "every meeting"
    // request server-side, but nothing in v0.9.0 wants one -- there is no
    // top-level meetings page -- and firing it from a rail that has not
    // resolved its record yet would fetch the whole table. Mirrors useNotes.
    enabled: params.companyId !== undefined || params.contactId !== undefined || params.dealId !== undefined
      || params.projectId !== undefined,
  });
}

/** GET /api/meetings/:id, which answers `{ meeting, tasks }`
 * (meetingDetailSchema) -- the follow-up tasks ride the detail payload while
 * list rows carry only `taskCount`. */
export function useMeeting(id: string) {
  return useQuery({
    queryKey: ["meeting", id],
    queryFn: async () => parseWith(meetingDetailSchema, await getJson<unknown>(`/meetings/${id}`), "meeting"),
    enabled: id !== "",
  });
}

/**
 * PATCH/archive/unarchive answer with a bare `Meeting` while GET answers
 * `{ meeting, tasks }`, so a mutation result cannot be written through into
 * the detail cache -- there is no `tasks` half to write. Invalidate both, and
 * let the refetch produce the one shape each cache entry holds.
 */
function useInvalidateMeeting() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["meeting", id] });
  };
}

export function useCreateMeeting() {
  const invalidate = useInvalidateMeeting();
  return useMutation({
    mutationFn: async (input: MeetingCreateInput) =>
      parseWith(meetingSchema, await postJson<unknown>("/meetings", input), "meeting"),
    onSuccess: (meeting: Meeting) => invalidate(meeting.id),
  });
}

export function useArchiveMeeting() {
  const invalidate = useInvalidateMeeting();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(meetingSchema, await postJson<unknown>(`/meetings/${id}/archive`), "meeting"),
    onSuccess: (meeting: Meeting) => invalidate(meeting.id),
  });
}

export function useUnarchiveMeeting() {
  const invalidate = useInvalidateMeeting();
  return useMutation({
    mutationFn: async (id: string) =>
      parseWith(meetingSchema, await postJson<unknown>(`/meetings/${id}/unarchive`), "meeting"),
    onSuccess: (meeting: Meeting) => invalidate(meeting.id),
  });
}

/**
 * A follow-up task, created through the meeting rather than through
 * POST /api/tasks -- the meeting's four record links are INHERITED server-side
 * and the body carries none of them (meetingTaskCreateInputSchema omits them,
 * and a link sent anyway is silently dropped by zod's non-strict parse).
 * 201 answers with the TASK, the same shape POST /api/tasks does.
 *
 * Both invalidations run locally rather than being left to the SSE hop: the
 * server does publish the meeting's keys as well as the task's, but that hop
 * carries a 100ms coalesce window (components/sse.tsx) and a mutation the user
 * just watched should not wait on a round trip through the event stream to
 * show its result. The task half reuses useInvalidateTask so a follow-up task
 * reaches My Tasks, the board and the Gantt exactly as a directly created one
 * does.
 */
export function useCreateMeetingTask() {
  const invalidateTask = useInvalidateTask();
  const invalidateMeeting = useInvalidateMeeting();
  return useMutation({
    mutationFn: async ({ meetingId, input }: { meetingId: string; input: MeetingTaskCreateInput }) =>
      parseWith(taskSchema, await postJson<unknown>(`/meetings/${meetingId}/tasks`, input), "task"),
    onSuccess: (task: Task, { meetingId }) => {
      invalidateTask(task);
      invalidateMeeting(meetingId);
    },
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const documentListSchema = documentSchema.array();

/**
 * A deal's issued documents, newest first with each one's lines in position
 * order -- the order the route returns them in, kept rather than re-sorted so
 * the list reads the same here as it does anywhere else that consumes it.
 *
 * Unbounded, like the deal's Files and Notes tabs: a deal's quotes stay
 * countable, and there is no cursor on this route to page with.
 */
export function useDealDocuments(dealId: string) {
  return useQuery({
    queryKey: ["documents", dealId],
    queryFn: async () =>
      parseWith(documentListSchema, await getJson<unknown>(`/deals/${dealId}/documents`), "documents list"),
    enabled: dealId !== "",
  });
}

/**
 * Raise a quote. 201 answers with the document; the PDF is not in the body,
 * because it is an ordinary `files` row and downloads through the existing
 * route.
 *
 * THE FILES AND EVENTS KEYS ARE INVALIDATED TOO, and that is not
 * over-invalidation. Issuing a quote writes a `files` row against the same
 * deal and stamps a `file_attached` entry on its timeline, so the rail's Files
 * and Timeline tabs are stale the instant this returns -- exactly as they are
 * after an upload, which is why useUploadFile invalidates the same pair.
 *
 * There is deliberately no update or delete hook beside this one: an issued
 * quote never changes, which is the phase's central claim rather than a
 * missing feature.
 */
export function useIssueQuote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ dealId, input }: { dealId: string; input: IssueQuoteInput }) =>
      parseWith(documentSchema, await postJson<unknown>(`/deals/${dealId}/documents`, input), "document"),
    onSuccess: (_document: DocumentRecord, { dealId }) => {
      void queryClient.invalidateQueries({ queryKey: ["documents", dealId] });
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}

/**
 * The issuer profile. Always 200 -- an install that has never opened Settings
 * has an EMPTY profile rather than a missing one, so there is no 404 branch to
 * write here or anywhere that reads it.
 */
export function useOrgProfile() {
  return useQuery({
    queryKey: ["org-profile"],
    queryFn: async () => parseWith(orgProfileSchema, await getJson<unknown>("/org-profile"), "org profile"),
  });
}

export function useSaveOrgProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: OrgProfileInput) =>
      parseWith(orgProfileSchema, await putJson<unknown>("/org-profile", input), "org profile"),
    onSuccess: (profile: OrgProfile) => queryClient.setQueryData(["org-profile"], profile),
  });
}

/**
 * A document template, keyed by TYPE rather than by id: there is one row per
 * type by unique constraint, and the type is what the URL means to a reader.
 *
 * `warnings` on the response is derived rather than stored -- what the merge
 * language will do SILENTLY to this body. It is carried through to the editor
 * because none of those things can throw and none of them should be invisible.
 */
export function useDocumentTemplate(type: DocumentType) {
  return useQuery({
    queryKey: ["document-template", type],
    queryFn: async () =>
      parseWith(documentTemplateSchema, await getJson<unknown>(`/document-templates/${type}`), "document template"),
  });
}

export function useSaveDocumentTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ type, input }: { type: DocumentType; input: DocumentTemplateInput }) =>
      parseWith(
        documentTemplateSchema,
        await putJson<unknown>(`/document-templates/${type}`, input),
        "document template",
      ),
    // The response body is the SANITISED template, which is what a later quote
    // will actually merge -- so it is written into the cache rather than
    // refetched, and the editor shows what was stored rather than what was
    // typed.
    onSuccess: (template: DocumentTemplate) =>
      queryClient.setQueryData(["document-template", template.type], template),
  });
}

/**
 * PHASE 7.6: THE TWO DOWNLOADS, AND THE GATE IN FRONT OF THEM.
 *
 * Read Settings -> Export, import, backup and restore (pages/settings-data.tsx)
 * alongside these.
 * The shape is unusual for this file and the reason is worth stating: nothing
 * here caches, and nothing here belongs in a query cache. A ticket is
 * single-use, an archive is hundreds of megabytes, and a passphrase must not
 * outlive the request it was typed for. So all three are mutations, and the one
 * genuine query -- the pre-flight -- is the only thing with a queryKey.
 */

/**
 * What a backup would cost, asked BEFORE the passphrase field is filled in.
 *
 * `staleTime: 0` against this file's 10-second default: the numbers are the
 * database's current size and the disk's current free space, and a stale
 * "there is room" is the one answer that would be worth nothing.
 */
export function useBackupPreflight() {
  return useQuery({
    queryKey: ["backup-preflight"],
    queryFn: async () =>
      parseWith(backupPreflightSchema, await getJson<unknown>("/backup/preflight"), "backup preflight"),
    staleTime: 0,
  });
}

/**
 * Exchange the operator's password for a single-use ticket for ONE operation.
 *
 * THE SCOPE IS THE PROMPT'S OWN STATE, PASSED THROUGH RATHER THAN DECIDED
 * HERE. The page already knows which prompt the operator answered -- it is the
 * `Pending` value the dialog is open for -- and handing that same value to the
 * mint is what makes the ticket unable to do anything else. Deriving it here
 * from the path about to be called would be a second source of truth for a
 * question already answered on screen.
 *
 * A PLAIN FUNCTION, NOT A MUTATION, AND THAT IS THE WHOLE POINT OF IT.
 *
 * It was `useMutation` and carried a comment saying the password was never
 * stored. A review measured otherwise: TanStack Query v5 keeps a mutation's
 * `variables` in the observer's result AND in the shared queryClient's
 * mutation cache after it settles, surviving the observer unsubscribing, until
 * the mutation is garbage-collected. The page cleared its own React state and
 * never called `reset()`, so the copy in the cache outlived the request that
 * needed it. Browser memory only -- but the comment claimed the opposite of
 * what the library does, which is worse than saying nothing.
 *
 * Nothing here needed a mutation. There is no cache to invalidate, no retry
 * that would be safe, and no state worth keeping: one request, one answer, and
 * the password should be unreachable the moment it returns. As a plain
 * function the password is an argument that goes out of scope with the call,
 * and the only copy that outlives it is the page's own field state, which
 * closing the prompt clears.
 */
export async function requestReauthTicket(password: string, scope: ReauthScope) {
  return parseWith(
    reauthTicketSchema, await postJson<unknown>("/reauth", { password, scope }), "reauth ticket",
  );
}

/**
 * Download the readable half. Spends a ticket.
 *
 * A MUTATION RATHER THAN A QUERY even though the server call is a GET, and it
 * is not a technicality: it spends a single-use ticket and writes a file to the
 * operator's disk. A query would be free to retry it, refetch it on a window
 * focus, or serve it from a cache -- and each of those is either a wasted
 * ticket or a second copy of the entire CRM in the browser's memory.
 */
export function useDownloadExport() {
  return useMutation({
    mutationFn: async (ticket: string) => {
      const archive = await downloadArchive({
        path: "/export", method: "GET", ticket,
        fallbackFilename: "conduit-export.zip",
      });
      saveBlob(archive.blob, archive.filename);
      return archive.filename;
    },
  });
}

/**
 * Download the exact half. Spends a ticket, and carries the passphrase.
 *
 * The passphrase reaches the server in a POST body and nowhere else -- see
 * routes/backup.ts for why that is a security decision rather than a REST one.
 */
export function useDownloadBackup() {
  return useMutation({
    mutationFn: async ({ ticket, passphrase }: { ticket: string; passphrase: string }) => {
      const archive = await downloadArchive({
        path: "/backup", method: "POST", ticket, body: { passphrase },
        fallbackFilename: "conduit-backup.7z",
      });
      saveBlob(archive.blob, archive.filename);
      return archive.filename;
    },
  });
}

/**
 * PHASE 7.7: THE RESTORE, AND WHY NOT ONE OF THESE IS A MUTATION EITHER.
 *
 * Read Settings -> Export, import, backup and restore (pages/settings-data.tsx)
 * alongside these. The argument requestReauthTicket's own comment makes applies
 * to all three and applies harder: TanStack Query v5 keeps a mutation's
 * `variables` in the shared queryClient's mutation cache after it settles,
 * surviving the observer unsubscribing. For the restore those variables are the
 * ARCHIVE PASSPHRASE, and -- for the preview -- the File handle to a decrypted
 * backup's container. There is no cache to invalidate here, no retry that would
 * be safe (apply destroys a database; a refetch on window focus would be
 * unthinkable), and nothing worth keeping. So they are plain functions, the
 * passphrase is an argument that goes out of scope with the call, and the page
 * tracks "in flight" with a boolean it owns.
 */

/**
 * Upload a backup and get back what restoring it WOULD do. Spends a ticket.
 *
 * NOTHING IS WRITTEN AND NOTHING IS DESTROYED by this call -- but the archive
 * IS decrypted onto the server's disk for the life of the plan, which is why
 * cancelRestore exists and why the page offers it.
 *
 * THE PASSPHRASE PART IS APPENDED FIRST, AND THAT IS A CONTRACT RATHER THAN A
 * STYLE. Fastify's multipart parser is streaming: a field declared after the
 * file part has not been seen when the route's `request.file()` resolves, so a
 * body with the passphrase last reads as a body with NO passphrase and is
 * refused. FormData preserves insertion order and fetch serialises it in that
 * order, so these two lines are load-bearing and must not be reordered.
 */
export async function inspectRestore(
  input: { ticket: string; file: File; passphrase: string },
) {
  const form = new FormData();
  form.append("passphrase", input.passphrase);
  form.append("file", input.file);
  return parseWith(
    restoreInspectionSchema,
    await postFormWithTicket("/restore/inspect", input.ticket, form),
    "restore preview",
  );
}

/**
 * Destroy this install's database and put the backup in its place. Spends a
 * SECOND ticket.
 *
 * `planId` IS THE ONLY DESCRIPTION OF THE WORK THAT TRAVELS. The plan is held
 * on the server and this client could not describe different work if it wanted
 * to -- see @conduit/shared's plan.ts. `confirmName` is what the operator
 * typed; the server compares it with the same installNameMatches this page
 * used to enable the button, and its 400 is the control.
 */
export async function applyRestore(
  input: { ticket: string; planId: string; passphrase: string; confirmName: string },
) {
  return parseWith(
    restoreOutcomeSchema,
    await postJsonWithTicket<unknown>("/restore/apply", input.ticket, {
      planId: input.planId,
      passphrase: input.passphrase,
      confirmName: input.confirmName,
    }),
    "restore outcome",
  );
}

/**
 * Throw the preview away, and with it the decrypted archive on the server.
 *
 * NOT BEHIND THE GATE, and that is the conservative direction rather than the
 * lax one: what this does is DELETE a staged credential store, and the failure
 * mode of making it harder to reach is a decrypted backup sitting in $data_dir
 * for the rest of the plan's half hour. The route binds it to its owner, so it
 * is not a way to cancel somebody else's restore.
 */
export async function cancelRestore(planId: string): Promise<void> {
  await deleteRequest(`/restore/${planId}`);
}

/**
 * PHASE 7.7'S OTHER HALF: THE TWO IMPORTERS, AND WHY THESE ARE PLAIN FUNCTIONS
 * TOO.
 *
 * Read Settings -> Export, import, backup and restore
 * (pages/settings-data.tsx and pages/settings-import.tsx) alongside these. The
 * argument the restore's block above makes is thinner here -- there is no
 * passphrase in any of these bodies -- but two of its three reasons survive
 * whole. TanStack Query keeps a mutation's `variables` in the shared cache
 * after it settles, and for these the variables are a File handle to somebody's
 * entire contact list. And there is no retry that would be safe: an apply that
 * a refetch-on-focus repeated would be a second import of the same file, which
 * is exactly the duplicate the engines refuse to create by hand.
 *
 * NO TICKET ON ANY OF THEM, and routes/import.ts argues that at length rather
 * than leaving it to be noticed. An import neither exfiltrates nor destroys,
 * and three password prompts to load a spreadsheet teaches the reflex the gate
 * exists to defeat. That argument used to have a third leg -- a fifth gated
 * route would widen what one FUNGIBLE ticket authorised -- and v1.4.1 removed
 * the fungibility, so it is gone from there and from here rather than left
 * standing where it would still read as true.
 */

/**
 * Upload a Conduit export and get back what importing it WOULD create.
 *
 * THE ARCHIVE IS UNPACKED ONTO THE SERVER'S DISK for the life of the plan,
 * which is why cancelImport exists and why the page offers it. It carries no
 * credentials -- services/export.ts writes none -- so this is the operator's
 * own data rather than a credential store; the handling is identical either
 * way, because receiveIntake is the only way in.
 */
export async function inspectExportImport(input: { file: File }) {
  const form = new FormData();
  form.append("file", input.file);
  return parseWith(
    importInspectionSchema, await postForm("/import/export/inspect", form), "import preview",
  );
}

/**
 * READ THE COLUMNS OF A FOREIGN FILE. The one interactive step in the spine.
 *
 * NOTHING IS HELD BY THIS CALL -- routes/import.ts's decision 2 -- so there is
 * no id in the answer and nothing to cancel. What comes back identifies the
 * upload to a PERSON ("contacts.csv, 1.2 MB") and carries the digest the next
 * call has to quote.
 */
export async function inspectCsvImport(input: { file: File; delimiter?: string }) {
  const form = new FormData();
  // THE FIELD BEFORE THE FILE, and it is a contract rather than a style:
  // Fastify's multipart parser is streaming, so a field declared after the file
  // part has not been seen when the route's `request.file()` resolves. FormData
  // preserves insertion order and fetch serialises it in that order, so this
  // ordering is load-bearing and must not be rearranged.
  if (input.delimiter !== undefined) form.append("delimiter", input.delimiter);
  form.append("file", input.file);
  return parseWith(
    csvInspectionSchema, await postForm("/import/csv/inspect", form), "column mapping",
  );
}

/**
 * THE SAME FILE AGAIN, WITH WHAT THE OPERATOR DECIDED ABOUT ITS COLUMNS.
 *
 * SENT TWICE ON PURPOSE. routes/import.ts's decision 2 carries the argument:
 * the mapping step holds nothing on the server, so a person can read a column
 * list for as long as they like without occupying the one intake slot the whole
 * install shares. The cost is one more upload of a file the browser still has.
 *
 * `sha256` IS THE SERVER'S OWN DIGEST OF THE BYTES THE COLUMNS WERE READ FROM,
 * echoed back untouched. A mapping is a list of column POSITIONS, so applying
 * one to a different file with the same number of columns would import every
 * value into the wrong field with a preview that read perfectly. The page never
 * computes this; it quotes what the mapping step reported.
 */
export async function planCsvImport(
  input: { file: File; mapping: CsvMapping; sha256: string },
) {
  const form = new FormData();
  form.append("mapping", JSON.stringify(input.mapping));
  form.append("sha256", input.sha256);
  form.append("file", input.file);
  return parseWith(
    importInspectionSchema, await postForm("/import/csv/plan", form), "import preview",
  );
}

/**
 * Add the rows the preview described.
 *
 * `planId` IS THE ONLY DESCRIPTION OF THE WORK THAT TRAVELS, and the route's
 * body schema is strict so a client that tried to send more is told rather than
 * quietly stripped. The plan is held on the server; what apply consumes is the
 * object the operator read.
 */
export async function applyImport(input: { planId: string; kind: "export" | "csv" }) {
  return parseWith(
    importOutcomeSchema,
    await postJson<unknown>(`/import/${input.kind}/apply`, { planId: input.planId }),
    "import outcome",
  );
}

/**
 * Throw the preview away, and with it the staged upload on the server.
 *
 * ONE ROUTE FOR BOTH IMPORTERS, because a delete takes no description of any
 * work and the store does not care which pipeline filled it. It is bound to its
 * owner, so it is not a way to cancel somebody else's import.
 */
export async function cancelImport(planId: string): Promise<void> {
  await deleteRequest(`/import/${planId}`);
}
