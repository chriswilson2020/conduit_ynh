import type { MeResponse, HealthResponse } from "@conduit/shared";
import { errorResponseSchema } from "@conduit/shared";

declare global {
  interface Window {
    __CONDUIT_BASE__?: string;
  }
}

/** Public path the app is mounted at. Falls back to "/" during `vite dev`. */
export function basePath(): string {
  const injected = window.__CONDUIT_BASE__;
  if (injected === undefined || injected === "" || injected.startsWith("__")) return "/";
  return injected;
}

export function apiUrl(path: string): string {
  const base = basePath();
  return base === "/" ? `/api${path}` : `${base}/api${path}`;
}

/**
 * Thrown for any non-2xx response carrying the app's uniform error shape
 * (`{ error, message? }`, see errorResponseSchema). `status` is the HTTP
 * status code; `code` is the machine-readable `error` field ("archived",
 * "not_found", "validation", ...). Callers must branch on `status`/`code`,
 * never on `message` text -- that string is for display only and is free to
 * change (it already includes interpolated ids, e.g. "company <id> is
 * archived", so it can never be compared for equality against a constant).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Thrown when a response the server called SUCCESSFUL does not match the schema
 * this client parses it with (queries.ts's parseWith). It is contract drift
 * between API and UI -- a bug on one side or the other -- and never a transport
 * problem, which is the whole reason it has a type of its own: a caller that
 * treats "the request may not have arrived" as a distinct case (mail-lib's
 * bulkErrorMessage, whose timeout copy says the changes may still have applied)
 * must not tell that story about a 200 whose body it could not read. Carries no
 * status or code: there is no failing HTTP response behind it.
 */
export class ResponseShapeError extends Error {}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw await toApiError(response, `GET ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Builds the ApiError for a non-2xx response, parsing its body against the
 * app's uniform error shape when possible. `fallbackMessage` covers a body
 * that doesn't parse (empty, non-JSON, or shaped differently) -- code
 * "unknown" in that case, since there is no machine-readable error field to
 * report.
 */
async function toApiError(response: Response, fallbackMessage: string): Promise<ApiError> {
  const raw: unknown = await response.json().catch(() => undefined);
  const parsed = errorResponseSchema.safeParse(raw);
  if (parsed.success) {
    return new ApiError(parsed.data.message ?? parsed.data.error, response.status, parsed.data.error);
  }
  return new ApiError(fallbackMessage, response.status, "unknown");
}

/**
 * Shared POST/PATCH body sender. On a non-2xx response, throws an ApiError
 * built from the response -- see toApiError -- so callers get a message like
 * "company acme is archived" (not "PATCH /companies/... failed with 409")
 * plus a status/code they can branch on without parsing that message.
 */
async function sendJson<T>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw await toApiError(response, `${method} ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const postJson = <T>(path: string, body?: unknown) => sendJson<T>("POST", path, body);
export const patchJson = <T>(path: string, body?: unknown) => sendJson<T>("PATCH", path, body);

/**
 * DELETE with no request or response body (e.g. removing a task dependency
 * edge -- the route returns a bare 204). Error handling mirrors sendJson;
 * a successful response is simply discarded rather than parsed as JSON,
 * since a 204 has no body to parse.
 */
export async function deleteRequest(path: string): Promise<void> {
  const response = await fetch(apiUrl(path), { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw await toApiError(response, `DELETE ${path} failed with ${response.status}`);
  }
}

/**
 * DELETE that answers with a body, rather than the bare 204 deleteRequest
 * above covers: clearing a mail thread's link
 * (DELETE /api/mail/threads/:id/links/:kind) returns the UPDATED thread, the
 * same shape its POST counterpart does, so the caller can invalidate off the
 * response instead of refetching to find out what changed. Error handling
 * mirrors sendJson.
 */
export async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw await toApiError(response, `DELETE ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * POST a multipart/form-data body (file uploads). Deliberately does not set
 * Content-Type: fetch/the browser derives it from the FormData, including the
 * multipart boundary -- setting it manually would omit that boundary and the
 * server would fail to parse the body. Error handling mirrors sendJson.
 */
export async function postForm(path: string, form: FormData): Promise<unknown> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  if (!response.ok) {
    throw await toApiError(response, `POST ${path} failed with ${response.status}`);
  }
  return await response.json();
}

export const fetchMe = () => getJson<MeResponse>("/me");

/**
 * GET /api/health. Unlike other endpoints, a 503 here is not a failure to
 * report on health, it IS the health report: the API returns 200 with
 * `{ status: "ok", database: "connected" }` or 503 with
 * `{ status: "degraded", database: "disconnected" }`, and both are valid,
 * parseable HealthResponse bodies. Treating 503 as a thrown error would
 * discard "database: disconnected" (informative) in favour of a generic
 * "unavailable" (uninformative), so both statuses are parsed here. Only a
 * genuinely unexpected status or a network failure should reject.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(apiUrl("/health"), { headers: { Accept: "application/json" } });
  if (!response.ok && response.status !== 503) {
    throw new Error(`GET /health failed with ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
