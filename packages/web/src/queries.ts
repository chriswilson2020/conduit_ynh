import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  companySchema,
  contactSchema,
  dealSchema,
  eventSchema,
  fileMetaSchema,
  funnelRowSchema,
  ganttPayloadSchema,
  listResponseSchema,
  meResponseSchema,
  midpoint,
  noteSchema,
  pipelineSchema,
  pipelineWithStagesSchema,
  projectSchema,
  searchResultsSchema,
  shiftResultSchema,
  stageSchema,
  taskDependencySchema,
  taskSchema,
  usersResponseSchema,
  type Company,
  type Contact,
  type CreateCompanyInput,
  type CreateContactInput,
  type CreateDealInput,
  type CreateNoteInput,
  type CreatePipelineInput,
  type CreateProjectInput,
  type CreateStageInput,
  type CreateTaskInput,
  type Deal,
  type GanttPayload,
  type Pipeline,
  type PipelineScope,
  type Project,
  type ProjectStatus,
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
import { ApiError, deleteRequest, getJson, patchJson, postForm, postJson } from "./api";

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
 */
function parseWith<T>(schema: { parse: (v: unknown) => T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    // Contract drift between API and UI. Log the full issue list for debugging,
    // surface a short human message to whatever renders the error.
    console.error(`response validation failed for ${what}`, error);
    throw new Error(`Unexpected response shape from the server (${what})`);
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
