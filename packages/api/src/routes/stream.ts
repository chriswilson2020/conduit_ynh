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
 * web client (components/sse.tsx, mounted once at the Shell) parses each frame
 * with sseHintSchema and invalidates the named TanStack Query keys.
 *
 * That parenthesis used to read "a later task", which it stopped being in the
 * same phase and stayed for four more -- long enough that Phase 4.4 Task 3 was
 * briefed as making the inbox live when the inbox had been live all along.
 * A stale "not yet" is a worse comment than none: it is read as a fact.
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

    let unsubscribe: () => void = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    // Idempotent: clearInterval on an already-cleared (or not-yet-assigned)
    // timer and calling unsubscribe (Set.delete under the hood) more than once
    // are both safe no-ops. That matters because cleanup can be reached from
    // three independent triggers below -- a clean client close, an async
    // socket error, or a write's own catch block -- with no guarantee only one
    // of them ever fires, so there is deliberately no additional guard flag.
    const cleanup = () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe();
    };

    // Attached BEFORE any write below, and before subscribing. A torn-down
    // socket (client vanished without a clean FIN -- a WiFi drop mid-write is
    // the textbook case, and precisely the moment the heartbeat below exists
    // to eventually discover) surfaces as an ASYNC 'error' event on the
    // response, not a synchronous throw from res.write(). An EventEmitter
    // 'error' with no listener attached is rethrown by Node as an uncaught
    // exception -- crashing the entire API process for every connected user
    // over one client's flaky network, not just failing this one connection.
    res.on("error", cleanup);
    request.raw.on("close", cleanup);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // retry: sets the browser's built-in EventSource reconnect delay (ms) if
    // this connection ever drops. Sent once, as the first frame.
    res.write("retry: 3000\n\n");

    unsubscribe = subscribe((hint) => {
      try {
        res.write(`data: ${JSON.stringify(hint)}\n\n`);
      } catch (error) {
        // Our own write failed synchronously. Don't rely on publish()'s
        // drop-on-throw backstop (services/sse.ts) to notice: that only drops
        // us from the hub's subscriber list, leaving this response's
        // heartbeat timer and event listeners running forever against a
        // socket nobody is reading from -- a zombie connection. Tear this one
        // down here instead, immediately, so the browser's EventSource
        // reconnect logic kicks in right away.
        request.log.error({ err: error }, "sse: write failed, closing stream");
        cleanup();
        reply.raw.end();
      }
    });

    // ":" lines are comments per the SSE spec -- EventSource's onmessage never
    // fires for these. Their only job is keeping the connection from looking
    // idle to anything between here and the browser.
    heartbeat = setInterval(() => {
      try {
        res.write(":hb\n\n");
      } catch (error) {
        // Belt-and-braces for the synchronous-throw path; the 'error'
        // listener registered above is the primary defence for the (far more
        // common) async case a half-open socket actually produces.
        request.log.error({ err: error }, "sse: heartbeat write failed");
        cleanup();
      }
    }, HEARTBEAT_MS);
  });
}
