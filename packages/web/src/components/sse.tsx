import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sseHintSchema } from "@conduit/shared";
import { apiUrl } from "../api";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A burst of hints from one bulk operation (e.g. a multi-deal import, or the
// SSE hub simply fanning out several publishes back to back) would otherwise
// trigger one invalidateQueries call -- and therefore one refetch -- per
// hint. Coalescing everything that arrives within this window into a single
// Set of keys collapses that burst into one refetch per distinct key
// instead. 100ms is well under anything a human perceives as "not live".
const COALESCE_MS = 100;

/**
 * Serialises a TanStack `queryKey` (e.g. `["deal", id]`) into a string so
 * duplicate keys collapse in a Set/Map -- `queryKey` arrays aren't
 * reference-equal across hints even when they describe the same key, so a
 * plain `Set<string[]>` would never dedupe anything.
 */
function keyToString(key: string[]): string {
  return JSON.stringify(key);
}

/**
 * Opens one `EventSource` to `/api/stream` (cookies/SSOwat headers ride
 * along automatically, same-origin) and invalidates the TanStack Query keys
 * named in each hint frame the server publishes -- see routes/stream.ts and
 * services/sse.ts server-side, and sseHintSchema's doc comment for the wire
 * shape. Mount once, at the Shell level: one connection per browser tab, not
 * per page.
 *
 * Reconnection has two layers. `EventSource` already auto-reconnects on a
 * dropped connection using the `retry:` value the server sends as its first
 * frame (routes/stream.ts writes `retry: 3000`) -- that covers a transient
 * network blip on its own, with no code needed here. What it does NOT
 * recover from is a *fatal* close: the browser sets `readyState` to
 * `CLOSED` (rather than leaving it `CONNECTING`) after certain errors --
 * e.g. a 401 the first time a session cookie expires -- and gives up for
 * good. `onerror` below checks for exactly that case and falls back to a
 * manual `new EventSource(...)` with jittered exponential backoff
 * (1s..30s), so a stale session still recovers once it's refreshed rather
 * than leaving the tab silently disconnected from live updates forever.
 */
export function useSseInvalidation(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = INITIAL_BACKOFF_MS;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingKeys = new Map<string, string[]>();
    let cancelled = false;

    function flushPending() {
      coalesceTimer = undefined;
      const keys = pendingKeys;
      pendingKeys = new Map();
      for (const key of keys.values()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }

    function handleMessage(event: MessageEvent<string>) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch (error) {
        console.debug("sse: malformed frame (not JSON), ignoring", error);
        return;
      }
      const result = sseHintSchema.safeParse(parsed);
      if (!result.success) {
        console.debug("sse: malformed frame (schema mismatch), ignoring", result.error);
        return;
      }
      for (const key of result.data.keys) {
        pendingKeys.set(keyToString(key), key);
      }
      // Restart the coalescing window on every frame (rather than a fixed
      // interval) so a single, isolated hint still invalidates promptly
      // instead of always waiting out the full 100ms.
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flushPending, COALESCE_MS);
    }

    function connect() {
      if (cancelled) return;
      const es = new EventSource(apiUrl("/stream"));
      source = es;

      es.onopen = () => {
        console.debug("sse: connection open");
        // A successful open proves the connection recovered -- reset the
        // backoff so the NEXT fatal close starts counting from 1s again
        // instead of picking up wherever a previous run of failures left off.
        backoffMs = INITIAL_BACKOFF_MS;
      };

      es.onmessage = handleMessage;

      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) {
          // CONNECTING: the browser's own auto-reconnect (per the server's
          // `retry:` field) is already in flight -- nothing to do here.
          return;
        }
        console.debug("sse: connection closed, scheduling manual reconnect");
        es.close();
        if (cancelled) return;
        // Full jitter: a random delay in [0, backoffMs) rather than a fixed
        // one, so a server restart that drops every open connection at once
        // doesn't have every tab reconnect in the same instant.
        const delay = Math.random() * backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      source?.close();
    };
  }, [queryClient]);
}
