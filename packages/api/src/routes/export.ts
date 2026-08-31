import type { FastifyInstance } from "fastify";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, contentDisposition } from "./helpers.js";
import { buildExport } from "../services/export.js";

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
 */
export function registerExportRoutes(app: FastifyInstance, { db, dataDir, appVersion }: CrmRouteDeps): void {
  app.get("/api/export", async (request, reply) => {
    if (requireUser(request, reply) === null) return;

    // Everything that CAN be checked is checked HERE, before a byte of the body
    // is written: the queries run inside one read-only snapshot, every blob is
    // stat'd, and the manifest is built. Once reply.send has the stream there is
    // no status line left to change, so anything that fails afterwards can only
    // truncate the download -- which buildExport's ZipFile error handler is what
    // turns into a truncated download rather than a dead process.
    const archive = await buildExport({ db, dataDir, appVersion });

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
