import type { MeResponse, HealthResponse } from "@conduit/shared";

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
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
