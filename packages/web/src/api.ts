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

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Shared POST/PATCH body sender. On a non-2xx response, the body is checked
 * against the app's uniform error shape (`{ error, message? }`, see
 * errorResponseSchema) and, when it matches, the thrown error carries the
 * server's `message` (falling back to `error`) instead of a generic
 * "<method> <path> failed with <status>" -- callers surfacing this in the UI
 * get "company acme is archived", not "PATCH /companies/... failed with 409".
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
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = errorResponseSchema.safeParse(raw);
    const message = parsed.success
      ? (parsed.data.message ?? parsed.data.error)
      : `${method} ${path} failed with ${response.status}`;
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const postJson = <T>(path: string, body?: unknown) => sendJson<T>("POST", path, body);
export const patchJson = <T>(path: string, body?: unknown) => sendJson<T>("PATCH", path, body);

/**
 * POST a multipart/form-data body (file uploads). Deliberately does not set
 * Content-Type: fetch/the browser derives it from the FormData, including the
 * multipart boundary -- setting it manually would omit that boundary and the
 * server would fail to parse the body. Error-shape unwrapping mirrors sendJson.
 */
export async function postForm(path: string, form: FormData): Promise<unknown> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => undefined);
    const parsed = errorResponseSchema.safeParse(raw);
    const message = parsed.success
      ? (parsed.data.message ?? parsed.data.error)
      : `POST ${path} failed with ${response.status}`;
    throw new Error(message);
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
