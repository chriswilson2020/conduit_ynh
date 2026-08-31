import type { FastifyInstance } from "fastify";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, contentDisposition } from "./helpers.js";
import { requireReauth } from "./reauth.js";
import { buildExport } from "../services/export.js";

/**
 * How many exports may be in flight at once, across all callers.
 *
 * ONE, and it is a memory decision rather than a politeness one. An export
 * materialises its largest CSV whole (see buildExport) and reads the blob store
 * end to end; the deploy target has 3.8GB and no swap. Nothing stopped an
 * authenticated caller from starting ten at once, and ten would multiply the
 * one bound this module works hardest to hold. There is no role model here, so
 * "an authenticated caller" is every user.
 *
 * The counter is per PROCESS, which is the whole deployment: one systemd unit,
 * one node process (see conf/systemd.service).
 */
const MAX_CONCURRENT_EXPORTS = 1;
let exportsInFlight = 0;

/**
 * GET /api/export -- the readable half of 7.6, as a download.
 *
 * NO PASSPHRASE, and that is a property of the contents rather than an omission:
 * the archive carries no credentials, no mail.key and no mail bodies (see
 * services/export.ts), so there is nothing in it that encryption would be
 * protecting. The backup is the artefact that is always encrypted, and Task 3's
 * Settings page is where the two are told apart in words.
 *
 * Behind the same `requireUser` gate as every other CRM route, and no stricter,
 * because it is no broader: Conduit has no role model -- there is no admin flag
 * on `users` and no per-user visibility on any list -- so every authenticated
 * caller can already read every company, contact, deal and file through the
 * individual endpoints. This route changes how many requests that takes, not
 * who may make them. A role model would have to arrive for all of them at once.
 *
 * AND SINCE TASK 3 IT IS BEHIND A SECOND GATE AS WELL -- see requireReauth.
 * The paragraph above is still true and is exactly why the gate is not about
 * authorisation: nothing new is readable here. What changed is the EFFORT. A
 * session that used to be worth a page-by-page scrape is now worth one request
 * for the entire CRM, and on a YunoHost box with no second factor the session
 * cookie is the whole perimeter. So the download asks for the password again.
 */
export function registerExportRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { db, dataDir, appVersion } = deps;
  app.get("/api/export", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    // BEFORE THE CONCURRENCY SLOT, deliberately. A caller with no ticket must
    // not be able to occupy the one export slot, or refusing them would still
    // have cost every other caller the feature.
    if (!requireReauth(request, reply, user, deps)) return;

    if (exportsInFlight >= MAX_CONCURRENT_EXPORTS) {
      // 503 with its own code, matching the shape documents.ts answers for a
      // saturated renderer: the caller's request was fine, the server is busy,
      // and retrying shortly is the correct client behaviour.
      return reply.code(503).send({
        error: "export_busy",
        message: "another export is already running; try again when it has finished",
      });
    }
    exportsInFlight += 1;

    let archive;
    try {
      // Everything that CAN be checked is checked HERE, before a byte of the
      // body is written: the queries run inside one read-only snapshot, every
      // blob is stat'd, and the manifest is built. Once reply.send has the
      // stream there is no status line left to change, so anything that fails
      // afterwards can only truncate the download -- which buildExport's
      // ZipFile error handler turns into a truncated download rather than a
      // dead process.
      archive = await buildExport({ db, dataDir, appVersion });
    } catch (error) {
      // The slot has to come back on the throwing path too, or one failed
      // export closes the route for the lifetime of the process.
      exportsInFlight -= 1;
      throw error;
    }

    // Released on `close`, which fastify emits for a finished response and for
    // an abandoned one alike -- the same event buildExport hangs its descriptor
    // cleanup on, and for the same reason: a client that disappears must not
    // leave anything behind it.
    archive.stream.once("close", () => { exportsInFlight -= 1; });

    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", archive.filename));
    // NO Content-Length. The CSV members are deflated, so the finished length is
    // not knowable until the last one is written -- see buildExport's note on
    // the per-member compression split. The spec puts truncation detection in
    // manifest.json's per-member digests rather than in the transfer, and a zip
    // whose central directory never arrived does not open at all.
    return reply.send(archive.stream);
  });
}
