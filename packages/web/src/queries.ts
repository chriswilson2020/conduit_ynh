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
import { getJson, patchJson, postJson } from "./api";

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
      return companyListSchema.parse(await getJson<unknown>(`/companies${qs}`));
    },
  });
}

export function useCompany(id: string) {
  return useQuery({
    queryKey: ["company", id],
    queryFn: async () => companySchema.parse(await getJson<unknown>(`/companies/${id}`)),
    enabled: id !== "",
  });
}

/**
 * Every company mutation below invalidates ["companies"] (all list queries,
 * since TanStack Query treats an invalidated key as a prefix match) and
 * ["events"] (a company change always writes a timeline event server-side).
 * Update/archive/unarchive additionally invalidate the specific ["company",
 * id] detail query; create has no prior detail query to invalidate.
 */
function useInvalidateCompany() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["companies"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["company", id] });
  };
}

export function useCreateCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (input: CreateCompanyInput) =>
      companySchema.parse(await postJson<unknown>("/companies", input)),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useUpdateCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateCompanyInput }) =>
      companySchema.parse(await patchJson<unknown>(`/companies/${id}`, patch)),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useArchiveCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (id: string) => companySchema.parse(await postJson<unknown>(`/companies/${id}/archive`)),
    onSuccess: (company: Company) => invalidate(company.id),
  });
}

export function useUnarchiveCompany() {
  const invalidate = useInvalidateCompany();
  return useMutation({
    mutationFn: async (id: string) =>
      companySchema.parse(await postJson<unknown>(`/companies/${id}/unarchive`)),
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
      return contactListSchema.parse(await getJson<unknown>(`/contacts${qs}`));
    },
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ["contact", id],
    queryFn: async () => contactSchema.parse(await getJson<unknown>(`/contacts/${id}`)),
    enabled: id !== "",
  });
}

// Mirrors useInvalidateCompany above -- see its doc comment.
function useInvalidateContact() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["events"] });
    if (id !== undefined) void queryClient.invalidateQueries({ queryKey: ["contact", id] });
  };
}

export function useCreateContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (input: CreateContactInput) =>
      contactSchema.parse(await postJson<unknown>("/contacts", input)),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useUpdateContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateContactInput }) =>
      contactSchema.parse(await patchJson<unknown>(`/contacts/${id}`, patch)),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useArchiveContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (id: string) => contactSchema.parse(await postJson<unknown>(`/contacts/${id}/archive`)),
    onSuccess: (contact: Contact) => invalidate(contact.id),
  });
}

export function useUnarchiveContact() {
  const invalidate = useInvalidateContact();
  return useMutation({
    mutationFn: async (id: string) =>
      contactSchema.parse(await postJson<unknown>(`/contacts/${id}/unarchive`)),
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
      return noteListSchema.parse(await getJson<unknown>(`/notes${qs}`));
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateNoteInput) => noteSchema.parse(await postJson<unknown>("/notes", input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
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
      return fileListSchema.parse(await getJson<unknown>(`/files${qs}`));
    },
    enabled: params.companyId !== undefined || params.contactId !== undefined,
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
      return eventListSchema.parse(await getJson<unknown>(`/events${qs}`));
    },
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => usersResponseSchema.parse(await getJson<unknown>("/users")).users,
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: async () => searchResultsSchema.parse(await getJson<unknown>(`/search?q=${encodeURIComponent(q)}`)),
    enabled: q.trim() !== "",
  });
}
