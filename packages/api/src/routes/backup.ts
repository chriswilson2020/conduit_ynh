import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, contentDisposition, parseOrReject } from "./helpers.js";
import { requireReauth } from "./reauth.js";
import {
  buildBackup, sweepAbandonedBackups, estimateBackup, MAX_PASSPHRASE_LENGTH,
  BackupToolMissingError, BackupKeyMissingError, BackupDiskSpaceError,
  BackupPassphraseError, BackupFailedError,
} from "../services/backup.js";

/**
 * How many backups may be in flight at once, across all callers.
 *
 * ONE, and the reasoning is NOT the export's. The export's limit is a memory
 * decision -- it materialises its largest CSV and ten at once would multiply
 * that. This one is a DISK decision, and it is the stronger argument of the
 * two: a backup needs free space roughly equal to the whole install, and the
 * pre-flight that checks for it (services/backup.ts's requiredFreeBytes)
 * cannot see a second backup that has not written anything yet. Two callers
 * would both pass the check and then both fill the disk of a live server --
 * the exact failure the pre-flight exists to prevent, reached through the one
 * door it cannot watch.
 *
 * A SEPARATE COUNTER FROM THE EXPORT'S, not a shared one, because they bound
 * different resources: an export in flight costs memory and no disk, a backup
 * costs disk and two child processes. Sharing one slot would make an export
 * refuse a backup for a reason that is not true of it. An operator who starts
 * both gets both, and the sum is still one of each.
 *
 * Per PROCESS, which is the whole deployment: one systemd unit, one node
 * process (conf/systemd.service).
 */
const MAX_CONCURRENT_BACKUPS = 1;
let backupsInFlight = 0;

/**
 * The request body. A PASSPHRASE AND NOTHING ELSE.
 *
 * The bounds are here as well as in validatePassphrase because this is where a
 * 100MB body gets refused before it reaches a child process's stdin; the
 * service's own check is the one that knows WHY each rule exists and is the
 * one that runs for a direct caller.
 */
const backupRequestSchema = z.object({
  passphrase: z.string()
    .min(1, "a passphrase is required; a backup is never written unencrypted")
    .max(MAX_PASSPHRASE_LENGTH, `the passphrase must be at most ${String(MAX_PASSPHRASE_LENGTH)} characters`),
});

/**
 * POST /api/backup -- the exact half of 7.6, as an encrypted download.
 *
 * POST, NOT GET, AND THAT IS A SECURITY DECISION RATHER THAN A REST ONE. The
 * passphrase has to reach the server, and the only other place to put it on a
 * GET is the query string -- where nginx writes it to the access log verbatim,
 * where it lands in the browser's history and in the Referer of anything the
 * page loads next. In a JSON body it appears in none of those. The cost is
 * paid by Task 3's page rather than here: a POST cannot be a plain link, so
 * the download has to be issued with fetch() and handed to the browser as a
 * blob.
 *
 * Behind the same `requireUser` gate as every other route and no stricter,
 * for the same reason the export is: Conduit has no role model, so every
 * authenticated caller can already read every record. What this route adds
 * over that is mail.key and the encrypted mail passwords -- which is a real
 * escalation in kind, and the honest answer is that a role model has to arrive
 * for all of Settings at once rather than being invented for one button. It is
 * recorded here so the next person to add roles knows this route is one of the
 * places that has been waiting for them.
 *
 * AND SINCE TASK 3 IT IS BEHIND A SECOND GATE -- see requireReauth. That
 * paragraph names this route as the one place where the escalation is real in
 * kind rather than only in convenience, and the gate is the answer that could
 * be given without inventing a role model for one button: not "who may", but
 * "prove you are still at the keyboard".
 */
export function registerBackupRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { db, dataDir, mailKeyPath, databaseUrl, appVersion } = deps;
  // AT BOOT, ONCE. A work directory in $data_dir can only have survived a
  // SIGKILL, an OOM kill or a power cut -- every other exit path disposes of
  // its own -- and what it holds is a partially written archive containing
  // mail.key. Fire and forget: a sweep that fails is logged, never fatal, and
  // buildBackup sweeps again before it creates its own directory.
  void sweepAbandonedBackups(dataDir).then(
    (removed) => {
      if (removed.length > 0) {
        app.log.warn(
          { count: removed.length },
          "removed abandoned backup work directories left by a previous run",
        );
      }
    },
    (error: unknown) => { app.log.warn({ err: error }, "could not sweep abandoned backup work directories"); },
  );

  /**
   * GET /api/backup/preflight -- what a backup would cost, before one starts.
   *
   * CHRIS RULED FOR BOTH HALVES ON 31 AUG: raise the proxy timeout AND warn
   * before starting, not either. The raise is in conf/nginx.conf; this is the
   * warning's source. The failure it exists to stop is the silent one -- the
   * backup cannot stream, so an install too large for the proxy's patience
   * produces a 504 after several minutes with nothing to show for it, and
   * every other pre-flight the service has would have passed.
   *
   * NO RE-AUTHENTICATION ON THIS ONE, and that is a decision rather than an
   * omission. It carries no data -- two sizes and a duration -- and requiring
   * a password to be told "this will take eleven minutes" would put the
   * warning AFTER the commitment it exists to inform. requireUser still
   * applies, like every other route.
   */
  app.get("/api/backup/preflight", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    return await estimateBackup({ db, dataDir });
  });

  app.post("/api/backup", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;

    // BEFORE THE BODY IS PARSED, so a caller with no ticket never gets a
    // validation message about the passphrase field -- which would be a small
    // free lesson in how to drive this endpoint.
    if (!requireReauth(request, reply, user, deps)) return;

    const body = parseOrReject(backupRequestSchema, request.body, reply);
    if (body === undefined) return;

    if (backupsInFlight >= MAX_CONCURRENT_BACKUPS) {
      return reply.code(503).send({
        error: "backup_busy",
        message: "another backup is already running; try again when it has finished",
      });
    }
    backupsInFlight += 1;

    let archive;
    try {
      // EVERY FAILURE THAT CAN BE REPORTED IS REPORTED HERE, before a byte of
      // the body exists: the tools, the versions, mail.key, the disk, and the
      // passphrase's shape. Once reply.send has the stream there is no status
      // line left to change.
      archive = await buildBackup({
        db, dataDir, mailKeyPath, databaseUrl, appVersion, passphrase: body.passphrase,
      });
    } catch (error) {
      // The slot comes back on the throwing path too, or one failed backup
      // closes the route for the lifetime of the process.
      backupsInFlight -= 1;
      // 503 and the package name. An operator can act on this one.
      if (error instanceof BackupToolMissingError) {
        return reply.code(503).send({
          error: "backup_tool_missing", message: error.message, aptPackage: error.aptPackage,
        });
      }
      // 503 rather than 500: the install is missing a file the packaging
      // scripts provision, which is an operator problem with a fix, and it is
      // the same status routes/mail.ts answers for the same absent file. The
      // message deliberately does NOT echo error.message, which carries the
      // server's filesystem path -- mapDomainError holds that same line for
      // MailKeyMissingError.
      if (error instanceof BackupKeyMissingError) {
        return reply.code(503).send({
          error: "backup_key_missing",
          message: "the mail encryption key is missing, so a backup could not restore mail; an administrator needs to look at this",
        });
      }
      // 507 Insufficient Storage, which is what it is. The message carries
      // both numbers because "not enough space" without them tells an operator
      // nothing about how much to free.
      if (error instanceof BackupDiskSpaceError) {
        return reply.code(507).send({
          error: "backup_disk_space", message: error.message,
          requiredBytes: error.requiredBytes, availableBytes: error.availableBytes,
        });
      }
      // 400, and the message describes the RULE rather than the value -- see
      // BackupPassphraseError. Nothing here ever echoes the passphrase.
      if (error instanceof BackupPassphraseError) {
        return reply.code(400).send({ error: "validation", message: error.message });
      }
      // 500 with a fixed message and the detail on the server side only. The
      // detail is a child process's stderr, which is a connection string away
      // from being a credential -- app.ts's own 5xx handler holds exactly this
      // line for every other error and there is no reason this one should be
      // laxer.
      if (error instanceof BackupFailedError) {
        request.log.error({ detail: error.detail }, error.message);
        return reply.code(500).send({
          error: "backup_failed",
          message: "the backup could not be produced; the server log has the detail",
        });
      }
      throw error;
    }

    // Released on `close`, which fastify emits for a finished response and an
    // abandoned one alike -- the same event buildBackup hangs the work
    // directory's removal on.
    archive.stream.once("close", () => { backupsInFlight -= 1; });

    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Type", "application/x-7z-compressed");
    reply.header("Content-Disposition", contentDisposition("attachment", archive.filename));
    // A Content-Length, WHERE THE EXPORT HAS NONE, and the difference is the
    // whole shape of this half: the archive is finished before the response
    // starts, so its length is known, and a browser that receives fewer bytes
    // than this knows the download was truncated rather than short.
    reply.header("Content-Length", String(archive.sizeBytes));
    return reply.send(archive.stream);
  });
}
