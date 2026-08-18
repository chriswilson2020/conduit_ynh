import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  companySchema,
  contactSchema,
  eventSchema,
  fileMetaSchema,
  listResponseSchema,
  noteSchema,
  searchResultsSchema,
  usersResponseSchema,
  type Company,
  type Contact,
  type CreateCompanyInput,
  type CreateContactInput,
  type CreateNoteInput,
  type UpdateCompanyInput,
  type UpdateContactInput,
} from "@conduit/shared";
import { getJson, patchJson, postForm, postJson } from "./api";

const companyListSchema = listResponseSchema(companySchema);
const contactListSchema = listResponseSchema(contactSchema);
const eventListSchema = listResponseSchema(eventSchema);
const noteListSchema = noteSchema.array();
const fileListSchema = fileMetaSchema.array();

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
}

export function useNotes(params: EntityFilterParams) {
  return useQuery({
    queryKey: ["notes", params],
    queryFn: async () => {
      const qs = toQueryString({ company_id: params.companyId, contact_id: params.contactId });
      return parseWith(noteListSchema, await getJson<unknown>(`/notes${qs}`), "notes list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined,
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
      const qs = toQueryString({ company_id: params.companyId, contact_id: params.contactId });
      return parseWith(fileListSchema, await getJson<unknown>(`/files${qs}`), "files list");
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined,
  });
}

export interface UploadFileInput {
  file: File;
  companyId?: string;
  contactId?: string;
}

export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, companyId, contactId }: UploadFileInput) => {
      const form = new FormData();
      // The entity id field(s) must be appended before the file field: the API
      // (packages/api/src/routes/files.ts) streams the multipart body and only
      // sees fields that arrive ahead of the file part.
      if (companyId !== undefined) form.append("companyId", companyId);
      if (contactId !== undefined) form.append("contactId", contactId);
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
        company_id: params.companyId, contact_id: params.contactId,
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
