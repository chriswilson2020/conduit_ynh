import type { FastifyInstance } from "fastify";
import type { CrmRouteDeps } from "./index.js";
import { requireUser } from "./helpers.js";
import { subscribe } from "../services/sse.js";

/** How often a heartbeat comment frame is written to keep the connection alive
 * through any idle timeout between here and the browser (nginx, a corporate
 * proxy, etc). 25s comfortably beats every default idle timeout in the stack. */
const HEARTBEAT_MS = 25_000;

/**
 * GET /api/stream -- one long-lived SSE connection per browser tab. Every hint
 * published via services/sse.ts's publish() (always AFTER the publishing
 * service's own transaction commits) is fanned out here as a `data:` frame; the
 * web client (a later task) parses each frame with sseHintSchema and invalidates
 * the named TanStack Query keys.
 *
 * nginx's proxy_buffering is off for this app (conf/nginx.conf) -- that is what
 * lets both the heartbeat and hint frames reach the browser promptly in
 * production instead of sitting queued in nginx's proxy buffer until it fills or
 * the connection closes, which would defeat the point of a live stream.
 */
export function registerStreamRoutes(app: FastifyInstance, _deps: CrmRouteDeps): void {
  app.get("/api/stream", async (request, reply) => {
    if (requireUser(request, reply) === null) return;

    // Hijack: tell Fastify to stop managing this response -- no automatic
    // serialization, no completing the reply lifecycle on return. Required
    // because an SSE response never "completes" the way a normal JSON response
    // does; it stays open, written to as hints (and heartbeats) arrive, until
    // the client disconnects.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // retry: sets the browser's built-in EventSource reconnect delay (ms) if
    // this connection ever drops. Sent once, as the first frame.
    res.write("retry: 3000\n\n");

    const unsubscribe = subscribe((hint) => {
      res.write(`data: ${JSON.stringify(hint)}\n\n`);
    });

    // ":" lines are comments per the SSE spec -- EventSource's onmessage never
    // fires for these. Their only job is keeping the connection from looking
    // idle to anything between here and the browser.
    const heartbeat = setInterval(() => {
      res.write(":hb\n\n");
    }, HEARTBEAT_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
