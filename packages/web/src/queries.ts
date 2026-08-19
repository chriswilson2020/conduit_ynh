import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  companySchema,
  contactSchema,
  dealSchema,
  eventSchema,
  fileMetaSchema,
  funnelRowSchema,
  listResponseSchema,
  midpoint,
  noteSchema,
  pipelineSchema,
  pipelineWithStagesSchema,
  searchResultsSchema,
  stageSchema,
  usersResponseSchema,
  type Company,
  type Contact,
  type CreateCompanyInput,
  type CreateContactInput,
  type CreateDealInput,
  type CreateNoteInput,
  type CreatePipelineInput,
  type CreateStageInput,
  type Deal,
  type Pipeline,
  type PipelineScope,
  type Stage,
  type UpdateCompanyInput,
  type UpdateContactInput,
  type UpdateDealInput,
  type UpdatePipelineInput,
  type UpdateStageInput,
} from "@conduit/shared";
import { ApiError, getJson, patchJson, postForm, postJson } from "./api";

const companyListSchema = listResponseSchema(companySchema);
const contactListSchema = listResponseSchema(contactSchema);
const eventListSchema = listResponseSchema(eventSchema);
const noteListSchema = noteSchema.array();
const fileListSchema = fileMetaSchema.array();
const pipelineListSchema = pipelineSchema.array();
const dealListSchema = dealSchema.array();
const funnelListSchema = funnelRowSchema.array();

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

export interface EntityFilterParams {
  companyId?: string;
  contactId?: string;
  dealId?: string;
}

export function useNotes(params: EntityFilterParams) {
  return useQuery({
    queryKey: ["notes", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId,
      });
      return parseWith(noteListSchema, await getJson<unknown>(`/notes${qs}`), "notes list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined || params.dealId !== undefined,
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
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId,
      });
      return parseWith(fileListSchema, await getJson<unknown>(`/files${qs}`), "files list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined || params.dealId !== undefined,
  });
}

export interface UploadFileInput {
  file: File;
  companyId?: string;
  contactId?: string;
  dealId?: string;
}

export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, companyId, contactId, dealId }: UploadFileInput) => {
      const form = new FormData();
      // The entity id field(s) must be appended before the file field: the API
      // (packages/api/src/routes/files.ts) streams the multipart body and only
      // sees fields that arrive ahead of the file part.
      if (companyId !== undefined) form.append("companyId", companyId);
      if (contactId !== undefined) form.append("contactId", contactId);
      if (dealId !== undefined) form.append("dealId", dealId);
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
  archived?: boolean;
}

// Unpaginated, mirroring listPipelines server-side (see its doc comment in
// services/pipelines.ts) -- a plain array, not { items, nextCursor }.
export function usePipelines(params: PipelineListParams = {}) {
  return useQuery({
    queryKey: ["pipelines", params],
    queryFn: async () => {
      const qs = toQueryString({ scope: params.scope, company_id: params.companyId, archived: params.archived });
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
// Events (timeline)
// ---------------------------------------------------------------------------

export interface EventListParams extends EntityFilterParams {
  cursor?: string;
  limit?: number;
}

export function useEvents(params: EventListParams = {}) {
  return useQuery({
    queryKey: ["events", params],
    queryFn: async () => {
      const qs = toQueryString({
        company_id: params.companyId, contact_id: params.contactId, deal_id: params.dealId,
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
