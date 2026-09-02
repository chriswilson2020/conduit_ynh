import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
// installNameMatches MOVED TO @conduit/shared IN 7.7 TASK 4 and did not change
// on the way. The page has to be able to say "that is not the name" before it
// spends a re-authentication ticket -- a ticket is single-use, so a typo would
// otherwise cost the operator their password again -- and two implementations
// of one comparison is the shape this phase's review found five defects in.
// One function, two callers. The 400 below is still the control.
import {
  MAX_PASSPHRASE_LENGTH, installNameMatches, passphraseProblem, type PlanView,
} from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, parseOrReject } from "./helpers.js";
import { requireReauth } from "./reauth.js";
import {
  receiveIntake, stageArchive, sweepAbandonedIntakes,
  DEFAULT_MAX_UPLOAD_BYTES,
  IntakeArchiveError, IntakeDiskSpaceError, IntakePassphraseError, IntakeShapeError,
  IntakeToolMissingError, IntakeTooLargeError,
  type IntakeFile, type StagedPayload,
} from "../services/intake.js";
import {
  planView, PlanApplyError, PlanExceededError, PlanRefusedError,
  type IntakeSession,
} from "../services/intake-plan.js";
import { WriteGateBusyError, type DrainResult } from "../services/write-gate.js";
import {
  applyRestore, inspectRestore,
  RestoreDatabaseChangedError, RestoreHalfAppliedError, RestoreInventoryMismatchError,
  RestoreLoadFailedError, RestoreMailKeyError, RestoreMigrationError,
  RestoreSafetyBackupError, RestoreToolMissingError, RestoreUnexpectedMigrationsError,
  RestoreUnexpectedResultError,
  type RestoreEffect, type RestorePlan, type RestoreSyncControl,
} from "../services/restore.js";

/**
 * THE HTTP SURFACE OF THE MOST DANGEROUS OPERATION IN THIS PRODUCT, AND EVERY
 * GUARD BETWEEN A REQUEST AND THE ENGINE THAT REPLACES THE OPERATOR'S DATABASE.
 *
 * services/intake.ts lands and unpacks the archive, services/intake-plan.ts
 * holds the plan and frames apply, services/restore.ts destroys and reloads.
 * None of them decides that a restore MAY happen. That decision is four things,
 * and all four live here because all four need a request to exist:
 *
 *   1. RE-AUTHENTICATION, on BOTH requests. v1.3.0 put it in front of the two
 *      downloads; a restore is strictly more dangerous than a download, so it
 *      is not optional here. See the note on the apply route for why the
 *      preview is gated too and why one ticket cannot cover both.
 *   2. THE TYPED INSTALL NAME -- Chris's own ruling. See `installName`.
 *   3. THE PLAN BOUND TO THE OPERATOR WHO UPLOADED IT. The store does the
 *      comparison (IntakeSession.owner); this is what gives it the identity.
 *   4. REFUSING NEW WRITES for the duration. See services/write-gate.ts.
 *
 * THE PLAN NEVER TRAVELS, AND THAT IS ENFORCED BY THE SHAPE OF THIS FILE
 * RATHER THAN ASSERTED BY IT. Inspect answers with a RENDERING of the plan
 * (@conduit/shared's PlanView, which has no refs and no paths in it) and an id;
 * apply's body is a STRICT schema with three fields and no room for a
 * description of the work. A plan that made the round trip would have to be
 * re-validated on arrival, and a re-validated plan is a second implementation
 * of inspect -- the one thing the plan-as-a-value design exists to remove. The
 * strictness is deliberate over the ordinary "unknown keys are stripped": on
 * this endpoint a client that sent effects should be TOLD that the server does
 * not read them, rather than have them silently ignored.
 *
 * THE PASSPHRASE NEVER REACHES A GET. Both routes are POSTs for the reason
 * v1.3.0 made the backup one: nginx writes a query string to its access log
 * verbatim and the browser keeps it in history. There is no GET here that takes
 * one and there must never be.
 *
 * THE UPLOAD IS A CREDENTIAL STORE FROM THE MOMENT IT LANDS, and this file
 * never lets one outlive the request that could not use it: every exit path
 * from the preview disposes of the staging, `IntakeSessionStore.use` disposes
 * in a `finally` around apply, and `sweepAbandonedIntakes` runs at boot for the
 * one exit path no `finally` covers.
 */

const scrypt = promisify(scryptCallback);

/**
 * THE INSTALL'S NAME: THE DATABASE THIS INSTALL IS CONNECTED TO.
 *
 * Chris ruled that the operator confirms a restore by typing the install's
 * name. Deciding WHAT that name is meant asking what this application actually
 * knows about itself, and the answer is narrower than it first looks. Config
 * carries: the app version, the base path, the data directory, the port, the
 * portal URL and the database URL. Nothing carries a domain -- conf/.env has no
 * DOMAIN and the process never learns one -- and the `Host` header is the
 * client's to choose, which disqualifies it outright: a confirmation string an
 * attacker supplies is a confirmation that they typed what they sent.
 *
 * FOUR CANDIDATES WERE WEIGHED AND THREE FAIL ON A PROPERTY THIS NEEDS:
 *
 *   THE ORGANISATION PROFILE'S NAME is the operator's own words and the obvious
 *   first choice, and it is EMPTY ON A FRESH INSTALL (services/org-profile.ts's
 *   emptyProfile) -- which is exactly the install a recovery restore runs
 *   against. A guard whose token is the empty string precisely when it matters
 *   most is not a guard. It is also data, so it is inside the blast radius.
 *
 *   THE HOSTNAME distinguishes boxes but not installs: YunoHost is
 *   multi-instance, so two Conduits on one machine share it, and two tabs on
 *   one machine is the confusion that actually happens.
 *
 *   THE APP VERSION and THE BASE PATH are the same on every install of a
 *   release, which makes typing one prove nothing about which install is being
 *   destroyed.
 *
 *   THE DATABASE NAME is what is left, and it earns it rather than winning by
 *   elimination. It NAMES THE OBJECT THE RESTORE ACTUALLY DESTROYS -- the
 *   restore drops and reloads this database and nothing else. It cannot be
 *   empty, because DATABASE_URL is required and the process would not have
 *   booted without it. It is not in the archive: services/backup.ts's manifest
 *   records the app version, the schema version and the postgres versions, and
 *   no install identity at all, so a hostile or simply WRONG backup cannot
 *   supply its own confirmation. And under YunoHost it is the app's instance id
 *   -- `conduit`, `conduit__2` -- which is the name YunoHost itself uses for
 *   the install in `yunohost app info`, in the system user and in the systemd
 *   unit. That is as close to "the install's name" as this deployment has.
 *
 * WHAT IT DOES NOT DO, SAID RATHER THAN LEFT TO BE FOUND: two boxes each
 * running one stock Conduit both answer `conduit`, so the name alone does not
 * tell one machine from another. The confusion it is built to stop is the
 * reflexive click on the right install; the second-machine case is caught by
 * re-authentication (a different box, a different password) and by the archive
 * passphrase. It is recorded here rather than papered over with a composite
 * name that no operator would recognise as their install's.
 *
 * NULL IS A REFUSAL, NEVER A DEFAULT. A connection string this cannot name
 * makes the apply route answer 503 rather than fall back to a constant, because
 * a constant is a confirmation everybody can type.
 */
export function installName(databaseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  // The path of a libpq URL is the database name, and postgres.js accepts the
  // empty-host form this project's own test and dev URLs use
  // (`postgres:///conduit_test`), which parses to the same pathname.
  const raw = parsed.pathname.replace(/^\//, "");
  if (raw === "" || raw.includes("/")) return null;
  try {
    // NO SECOND EMPTINESS CHECK AFTER THIS, AND A MUTATION IS WHAT REMOVED IT.
    // There was a `name === "" ? null : name` here; breaking it failed nothing,
    // because decodeURIComponent cannot turn a non-empty string into an empty
    // one. A branch no test can reach is not a defence, it is a line that makes
    // the next reader think one exists.
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * PROOF THAT APPLY WAS GIVEN THE SAME PASSPHRASE THE ARCHIVE WAS OPENED WITH,
 * WITHOUT THE PASSPHRASE BEING KEPT.
 *
 * The spec's step 4 says the safety backup is encrypted "using the same
 * passphrase the operator just typed for the restore. They demonstrably have
 * it, so this adds no new thing to lose." That argument is only true if it IS
 * the same one. Apply is a second request and has to carry the passphrase again
 * -- the engine needs the plaintext to drive 7z -- so nothing structural makes
 * the two equal, and an operator who fat-fingered the second one would get a
 * safety backup encrypted under a string they have never successfully used.
 * That is a new thing to lose, and it is the ONE artefact that exists so a
 * broken restore is recoverable.
 *
 * SO THE SESSION HOLDS A KDF DIGEST AND NEVER THE PASSPHRASE. 7.6's rule is
 * that the passphrase is never stored, logged or written to disk, and a session
 * map holding one for thirty minutes would be the letter of that rule broken
 * for convenience. A salted scrypt digest cannot open an archive and cannot be
 * turned back into what was typed; what it can do is answer the one question
 * apply needs answered.
 *
 * THE COMPARISON IS TIMING-SAFE HERE, where the name's is not, because this one
 * really is a secret.
 */
interface PassphraseProof {
  readonly salt: Buffer;
  readonly digest: Buffer;
}

const PROOF_KEY_BYTES = 32;

async function proveOf(passphrase: string): Promise<PassphraseProof> {
  const salt = randomBytes(16);
  const digest = (await scrypt(passphrase, salt, PROOF_KEY_BYTES)) as Buffer;
  return { salt, digest };
}

async function proofAccepts(proof: PassphraseProof, passphrase: string): Promise<boolean> {
  const digest = (await scrypt(passphrase, proof.salt, PROOF_KEY_BYTES)) as Buffer;
  return digest.length === proof.digest.length && timingSafeEqual(digest, proof.digest);
}

/**
 * A restore's session: the spine's, plus the proof above.
 *
 * The extra field rides on the same object the store holds, so it has exactly
 * one lifetime -- a parallel map keyed by plan id would have to be swept in
 * step with the store's own expiry, and the day the two disagreed the survivor
 * would be a passphrase digest belonging to a plan that no longer exists.
 */
interface RestoreSession extends IntakeSession<RestoreEffect> {
  readonly passphraseProof: PassphraseProof;
}

/**
 * Read the proof back off a held session, or null.
 *
 * A RUNTIME CHECK RATHER THAN A CAST. The store is the shared spine's and holds
 * whichever of the three pipelines put a session in it; a cast would be this
 * route asserting something about a value it did not construct, and would fail
 * silently -- as `undefined` -- the day an importer holds a session of its own.
 */
function proofOf(session: IntakeSession): PassphraseProof | null {
  const candidate = (session as Partial<RestoreSession>).passphraseProof;
  if (candidate === undefined) return null;
  return Buffer.isBuffer(candidate.salt) && Buffer.isBuffer(candidate.digest) ? candidate : null;
}

/** Multipart field values arrive as `{ value, ... }` wrappers, not bare strings. */
function fieldValue(field: MultipartFile["fields"][string]): string | undefined {
  if (field === undefined || Array.isArray(field) || field.type !== "field") return undefined;
  return typeof field.value === "string" ? field.value : undefined;
}

/**
 * The apply request's body. THREE FIELDS, AND NOTHING ELSE IS ACCEPTED.
 *
 * `strictObject` rather than the ordinary strip: see this module's header. The
 * plan does not travel, and a client that tried to send one is told so.
 */
const applyRequestSchema = z.strictObject({
  planId: z.uuid("that is not a plan id"),
  passphrase: z.string()
    .min(1, "the archive's passphrase is required")
    .max(MAX_PASSPHRASE_LENGTH, `the passphrase must be at most ${String(MAX_PASSPHRASE_LENGTH)} characters`),
  confirmName: z.string().max(256, "that is not this install's name"),
});

const planIdParamSchema = z.object({ planId: z.uuid("that is not a plan id") });

export function registerRestoreRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const {
    db, dataDir, mailKeyPath, databaseUrl, appVersion, intakeSessions, writeGate,
  } = deps;
  const maxUploadBytes = deps.restoreMaxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  // AT BOOT, ONCE, AND THIS IS THE CALL services/intake.ts's own comment says
  // must exist. A `.intake-work-` directory in $data_dir can only have survived
  // a SIGKILL, an OOM kill or a power cut -- every other exit path disposes of
  // its own -- and what it holds is a DECRYPTED backup: mail.key in the clear,
  // every mail body, every encrypted mail password. That makes this the more
  // valuable of the two boot sweeps, not the lesser one. Fire and forget: a
  // sweep that fails is logged and never fatal.
  void sweepAbandonedIntakes(dataDir).then(
    (removed) => {
      if (removed.length > 0) {
        app.log.warn(
          { count: removed.length },
          "removed abandoned intake work directories left by a previous run; "
          + "each held a decrypted backup",
        );
      }
    },
    (error: unknown) => {
      app.log.warn({ err: error }, "could not sweep abandoned intake work directories");
    },
  );

  /**
   * POST /api/restore/inspect -- upload a backup and see what restoring it
   * would do, with nothing written and nothing destroyed.
   *
   * MULTIPART, AND THE PASSPHRASE FIELD MUST COME BEFORE THE FILE. Fastify's
   * multipart parser is streaming, so a field declared after the file part has
   * not been seen when `request.file()` resolves -- the same contract
   * routes/files.ts documents. A body with the passphrase last therefore reads
   * as a body with no passphrase, and is refused with the rule rather than
   * treated as an empty one.
   *
   * THAT ORDERING IS NOT EXERCISED BY THIS PROJECT'S TESTS, and saying so is
   * cheaper than a reader assuming it is. An in-process injection hands the
   * whole body over in one chunk, so busboy has parsed every part before any
   * await resolves and the order stops mattering -- which is the opposite of
   * what a three-gigabyte upload over a socket does. What IS tested is the
   * refusal an absent passphrase gets, which is the same refusal.
   *
   * RE-AUTHENTICATION BEFORE THE BODY IS TOUCHED. A caller with no ticket must
   * not get to write several gigabytes into $data_dir, and must not get a
   * validation message about the fields either -- which would be a free lesson
   * in how to drive this endpoint.
   */
  app.post("/api/restore/inspect", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    if (!requireReauth(request, reply, user, deps)) return;

    // BEFORE THE UPLOAD, so an operator whose previous preview is still open is
    // told to finish or cancel it rather than after spending ten minutes
    // uploading. `hold` refuses again below, which is what actually holds when
    // two callers race; this is the message that is worth reading.
    //
    // IT DOES TELL CALLER B THAT CALLER A HAS AN UPLOAD WAITING, which is the
    // one thing the "no such plan" answer elsewhere in this file exists to
    // avoid, and it is kept deliberately: a control refused for a reason
    // nobody can see is what this codebase has now declined to ship four
    // times, and the reason here is a capacity of one. It names nobody, and
    // the plan itself stays unreachable without its id and its owner.
    //
    // `size` EXCLUDES SESSIONS INSIDE `use`, so during an apply this check
    // reads zero and the capacity-of-one invariant rests entirely on the write
    // gate refusing POSTs for the duration. That is a real dependency between
    // two mechanisms and it is written down rather than relied on quietly.
    if (intakeSessions.size > 0) {
      return reply.code(409).send({
        error: "restore_busy",
        message: "another backup is already uploaded and waiting for a decision; "
          + "apply or cancel it first",
      });
    }

    let part: MultipartFile | undefined;
    try {
      // A PER-REQUEST LIMIT, because the app-wide one is 50MB for attachments
      // and a backup is roughly the size of the install. Truncation is what
      // this bound does -- busboy stops the stream and marks it -- so the
      // `truncated` check below is the refusal, not an exception.
      //
      // `files` IS REPEATED HERE ON PURPOSE. Per-request options replace the
      // plugin's `limits` object rather than merging into it, so naming only
      // `fileSize` would silently drop the app-wide `files: 1` for this route
      // -- the one route where an unbounded number of parts would be read from
      // a stranger's upload.
      part = await request.file({ limits: { fileSize: maxUploadBytes, files: 1 } });
    } catch {
      return reply.code(400).send({
        error: "validation", message: "a multipart file upload is required",
      });
    }
    if (part === undefined || part.fieldname !== "file") {
      part?.file.resume();
      return reply.code(400).send({
        error: "validation", message: 'a file field named "file" is required',
      });
    }

    const passphrase = fieldValue(part.fields.passphrase) ?? "";
    const problem = passphraseProblem(passphrase);
    if (problem !== null) {
      // Drained rather than left dangling: the parser is mid-stream and an
      // un-consumed part keeps the request open.
      part.file.resume();
      return reply.code(400).send({ error: "validation", message: problem });
    }

    let file: IntakeFile | null = null;
    let payload: StagedPayload | null = null;
    let held = false;
    /**
     * Delete the staging, unless the store has taken it.
     *
     * CALLED BEFORE EVERY ANSWER, AND AGAIN IN A `finally`, AND THE TWO ARE NOT
     * THE SAME GUARANTEE. The `finally` guarantees it HAPPENS; the explicit
     * calls guarantee it happens BEFORE THE ANSWER GOES OUT. A review found
     * that ordering the hard way: `reply.send()` dispatches the response
     * immediately, so a refusal written inside the try was observable while the
     * decrypted archive was still on disk -- a caller could see "that archive
     * was refused" and retry into a directory that had not been cleaned yet,
     * and a test asserting the credential store was gone raced the disposal and
     * failed. It is idempotent, so the belt costs nothing.
     */
    const discard = async (): Promise<void> => {
      if (held) return;
      // Disposing the payload removes the upload too -- they share one work
      // directory -- and either is safe to call twice.
      if (payload !== null) await payload.dispose();
      else if (file !== null) await file.dispose();
      file = null;
      payload = null;
    };
    try {
      file = await receiveIntake({
        dataDir, source: part.file, filename: part.filename, maxBytes: maxUploadBytes,
      });
      // MUST BE CHECKED AFTER THE STREAM HAS ENDED, exactly as routes/files.ts
      // checks its own: busboy sets this when it stops feeding the stream, and
      // receiveIntake has by then written a PREFIX of the archive to disk. A
      // prefix of a `.7z` is not a small archive, it is a broken one, and
      // staging it would refuse it as damage with no hint of why.
      if (part.file.truncated) {
        await discard();
        return reply.code(413).send({
          error: "too_large",
          message: `the upload is larger than the ${String(maxUploadBytes)} bytes this install accepts`,
        });
      }
      payload = await stageArchive({ file, passphrase });
      const plan: RestorePlan = await inspectRestore({
        file, payload, db, dataDir, mailKeyPath, appVersion,
      });
      // A REFUSAL IS STILL A PLAN AND IS STILL RENDERED -- that is the design,
      // and the page shows a newer-Conduit backup or a corrupt archive through
      // the same path as one that will run. IT IS NOT HELD, though, and that
      // follows from the discipline this whole spine is built on: the upload is
      // a credential store removed on every exit path, "success, refusal,
      // failure and an abandoned upload alike", and a refusal is an exit path.
      // Keeping a decrypted backup in $data_dir for half an hour so that
      // somebody could apply a plan that cannot be applied buys nothing. The
      // `planId` in the answer therefore resolves to nothing, which is what
      // planIsApplicable already tells the page.
      if (plan.refusal !== null) {
        await discard();
        return { plan: planView(plan), installName: installName(databaseUrl) };
      }
      const session: RestoreSession = {
        plan, payload, owner: user.username, passphraseProof: await proveOf(passphrase),
      };
      intakeSessions.hold(session);
      held = true;
      // THE RENDERING, NEVER THE PLAN. planView drops the staged-member refs,
      // which are object identities with no meaning off-process and are the
      // only thing that would let a caller describe work.
      const view: PlanView = planView(plan);
      return { plan: view, installName: installName(databaseUrl) };
    } catch (error) {
      // THE STAGING GOES BEFORE THE REFUSAL DOES. See `discard`.
      await discard();
      return intakeRefusal(reply, error);
    } finally {
      // EVERY EXIT PATH THAT DID NOT HAND THE STAGING TO THE STORE DELETES IT;
      // success is the only case where something else owns it. This is the
      // guarantee that it happens at all -- including from a path added later
      // that forgets to call `discard` itself.
      await discard();
    }
  });

  /**
   * POST /api/restore/apply -- destroy this install's database and put the
   * backup in its place.
   *
   * RE-AUTHENTICATION AGAIN, NOT ONCE FOR BOTH REQUESTS. A ticket is
   * single-use by design (services/reauth.ts), so one cannot span a preview and
   * an apply with a person reading a destruction list in between -- and it
   * should not: the proof that the operator is still at the keyboard is worth
   * exactly as much as how recently it was taken, and the moment that matters
   * is this one. The cost is that the page asks for the password twice and has
   * to say why; that is the conservative side of a decision that only goes one
   * way.
   *
   * THE ORDER OF THE GUARDS IS THE DESIGN. Everything that can refuse without
   * consuming anything runs first -- the session is looked up but NOT taken, so
   * a mistyped name or passphrase leaves the operator with their upload and a
   * second try rather than a three-gigabyte re-upload. Only when nothing is
   * left to refuse are writes stopped and the plan consumed.
   */
  app.post("/api/restore/apply", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    if (!requireReauth(request, reply, user, deps)) return;

    const body = parseOrReject(applyRequestSchema, request.body, reply);
    if (body === undefined) return;

    const expectedName = installName(databaseUrl);
    if (expectedName === null) {
      // REFUSED RATHER THAN DEFAULTED. There is no safe fallback: a constant
      // would be a confirmation string every caller can type, which is the
      // guard removed while still appearing to be there.
      request.log.error("the install has no nameable database, so a restore cannot be confirmed");
      return reply.code(503).send({
        error: "restore_unnameable",
        message: "this install's database cannot be named from its configuration, so a "
          + "restore cannot be confirmed by typing it. An administrator needs to look at this.",
      });
    }

    // BOUND TO THE OPERATOR WHO UPLOADED IT. The store compares; this passes
    // the identity SSOwat established, never anything from the body.
    const session = intakeSessions.get(body.planId, user.username);
    if (session === undefined) {
      return reply.code(404).send({
        error: "restore_plan_unknown",
        message: "that preview is not available any more; upload the backup again",
      });
    }

    if (!installNameMatches(body.confirmName, expectedName)) {
      return reply.code(400).send({
        error: "restore_name_mismatch",
        message: `type this install's name exactly to confirm: ${expectedName}`,
        installName: expectedName,
      });
    }

    // IS THIS ID A RESTORE PREVIEW AT ALL? The store is the shared spine's and
    // will hold the two importers' sessions too; a plan of another kind reached
    // through this route is the same non-answer an unknown id gets. It is also
    // what makes the `as RestorePlan` below sound rather than hopeful -- the id
    // is the plan's own id, so the session `use` finds is this one.
    const proof = proofOf(session);
    if (proof === null || session.plan.kind !== "restore") {
      return reply.code(404).send({
        error: "restore_plan_unknown",
        message: "that preview is not available any more; upload the backup again",
      });
    }

    if (!await proofAccepts(proof, body.passphrase)) {
      return reply.code(400).send({
        error: "restore_passphrase_mismatch",
        message: "that is not the passphrase this backup was opened with. The safety backup "
          + "is written with the passphrase you type here, so it has to be one you have "
          + "already used successfully.",
      });
    }

    // REFUSE NEW WRITES, THEN WAIT FOR THE ONES ALREADY RUNNING. Before the
    // safety backup rather than after it, for the reason services/restore.ts
    // stops the sync before it: an undo taken while a second writer runs is an
    // undo to a state that stopped being true a moment later. `except` is this
    // request, which is itself a write and would otherwise be waited for
    // forever.
    //
    // A SECOND APPLY THAT GOT THIS FAR IS REFUSED HERE AND REOPENS NOTHING.
    // Two applies can both pass the onRequest hook while the gate is still open
    // and only race in their handlers -- there is a scrypt between the two
    // points. A second caller that closed an already-closed gate, failed, and
    // then reopened it in its own `finally` would admit writes for the whole of
    // the first restore.
    let drain: DrainResult;
    try {
      drain = await writeGate.refuseNewWrites({
        reason: "a restore is replacing this install's data; nothing can be changed until it finishes",
        except: request.id,
        timeoutMs: deps.restoreDrainTimeoutMs,
      });
    } catch (error) {
      if (error instanceof WriteGateBusyError) {
        return reply.code(503).send({
          error: "restore_in_progress",
          message: "a restore is already running on this install; wait for it to finish",
        });
      }
      throw error;
    }
    if (!drain.drained) {
      writeGate.resume();
      // THE RESTORE DOES NOT START. A request that is still writing has a
      // transaction this restore cannot see, and destroying underneath it is
      // the failure the drain exists to prevent. Pressing the button again is
      // cheap; the other outcome is not recoverable.
      return reply.code(503).send({
        error: "restore_writes_in_flight",
        message: `${String(drain.stillWriting)} request(s) were still writing when the restore `
          + "tried to start, so it did not start. Nothing has been changed. Try again in a moment.",
        stillWriting: drain.stillWriting,
      });
    }

    // --- nothing below this line can refuse without consuming the plan ---
    //
    // MOVED DOWN IN 7.7 TASK 4, BECAUSE IT WAS TWO REFUSALS TOO HIGH. It sat
    // above the write-gate block, and both answers that block can give --
    // `restore_in_progress` when the gate is already closed, and
    // `restore_writes_in_flight` when the drain runs out -- return without ever
    // reaching `intakeSessions.use`, so the plan is still there and the
    // operator's upload is still on disk. That is not a nicety: it is what
    // makes "try again in a moment", which the second of those two messages
    // says in as many words, an instruction somebody can actually follow. The
    // page reads this line as its authority for which failures leave a preview
    // usable (pages/settings-data-lib.ts's APPLY_KEEPS_THE_PREVIEW), so a
    // marker in the wrong place is a marker that would have made the page throw
    // away a recoverable upload.
    const manager = deps.syncManager();
    const sync: RestoreSyncControl | null = manager === null
      ? null
      : { stop: () => manager.stop(), start: () => manager.start() };

    try {
      const outcome = await intakeSessions.use(body.planId, user.username, async (held) => {
        return await applyRestore({
          plan: held.plan as RestorePlan,
          payload: held.payload,
          db, databaseUrl, dataDir, mailKeyPath, appVersion,
          passphrase: body.passphrase, sync,
        });
      });
      if (outcome === undefined) {
        // Taken between the lookup above and here, which one other apply of
        // the same plan can do. `use` removed it from the map before the work
        // started, so this is the second caller and there is nothing to run.
        return reply.code(404).send({
          error: "restore_plan_unknown",
          message: "that preview is not available any more; upload the backup again",
        });
      }
      return {
        restored: true,
        dispatched: outcome.dispatched,
        realised: outcome.realised,
        unrealised: outcome.unrealised,
        message: "the backup has been restored. Restart Conduit now: this process holds "
          + "connections and caches belonging to the install that was replaced.",
      };
    } catch (error) {
      return restoreFailure(request.log, reply, error);
    } finally {
      // ADMITTED AGAIN WHATEVER HAPPENED. A failed restore that left the gate
      // closed would be an install that answers 503 to every write until
      // somebody restarts it -- and the failure paths below are exactly the
      // ones where an operator needs the install to keep working.
      //
      // AND THIS ONE REALLY CAN LIVE IN THE `finally`, WHERE THE PREVIEW'S
      // DISPOSAL COULD NOT, because the difference is whether it yields.
      // `reply.send()` schedules the response and returns, so the question is
      // what runs before the event loop can deliver it: `discard` awaits an
      // `rm` and therefore hands control back -- which is how a caller came to
      // see a refusal while the decrypted archive was still on disk -- and
      // `resume` is synchronous, so it completes in the same continuation as
      // the `return` that triggered it. There is no instant at which an answer
      // has gone out and the gate is still shut.
      writeGate.resume();
    }
  });

  /**
   * DELETE /api/restore/:planId -- change your mind, and delete the decrypted
   * archive now rather than in half an hour.
   *
   * NOT BEHIND RE-AUTHENTICATION, and that is the conservative direction rather
   * than the lax one. What this does is DELETE a staged credential store; the
   * failure mode of making it harder to reach is a decrypted backup sitting in
   * $data_dir for the rest of the plan's TTL. It is still bound to its owner,
   * so it is not a way to cancel somebody else's restore.
   */
  app.delete("/api/restore/:planId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(planIdParamSchema, request.params, reply);
    if (params === undefined) return;
    const discarded = await intakeSessions.discard(params.planId, user.username);
    if (!discarded) {
      return reply.code(404).send({
        error: "restore_plan_unknown",
        message: "that preview is not available any more",
      });
    }
    return reply.code(204).send();
  });
}

/**
 * What the preview answers when the archive could not be taken in.
 *
 * NOTHING HERE ECHOES A `detail`. IntakeArchiveError carries 7z's stderr, which
 * names paths inside $data_dir; the same line routes/backup.ts holds for
 * BackupFailedError. The MESSAGES are echoed, because every one of them
 * describes something the operator can act on and none of them names a path.
 */
function intakeRefusal(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof IntakeToolMissingError) {
    return reply.code(503).send({
      error: "restore_tool_missing", message: error.message, aptPackage: error.aptPackage,
    });
  }
  if (error instanceof IntakeDiskSpaceError) {
    return reply.code(507).send({
      error: "restore_disk_space", message: error.message,
      requiredBytes: error.neededBytes, availableBytes: error.freeBytes,
    });
  }
  if (error instanceof IntakeTooLargeError) {
    return reply.code(413).send({ error: "too_large", message: error.message });
  }
  // 400, all four: the archive is the caller's, and every one of these is a
  // fact about the file they chose. The passphrase and the damaged-header cases
  // are ONE message by construction -- with `-mhe=on` a wrong passphrase and a
  // corrupt header fail at the same point in the same code path, and inventing
  // a distinction the format does not offer would be the leak 7.6 avoided.
  if (error instanceof IntakePassphraseError || error instanceof IntakeArchiveError
    || error instanceof IntakeShapeError) {
    return reply.code(400).send({ error: "restore_archive_refused", message: error.message });
  }
  if (error instanceof PlanRefusedError) {
    return reply.code(409).send({ error: "restore_busy", message: error.message });
  }
  throw error;
}

/**
 * What apply answers when the restore did not finish, and the ONE rule that
 * governs all of it: THE OPERATOR IS TOLD WHICH STATE THEIR INSTALL IS IN.
 *
 * services/restore.ts wrote these messages for exactly this moment -- they name
 * the safety backup, they print the commands that put the install back, and
 * they say in as many words whether the restore HAPPENED. So they are echoed
 * whole, which is the opposite of the rule every other 5xx in this application
 * follows. That is deliberate and it is narrow: a 500 whose body is
 * `{ error: "internal_error" }` is right when the alternative is leaking a
 * connection string, and catastrophic when the alternative is an operator with
 * a half-restored database and no idea that a safety backup exists. The
 * `detail` fields, which carry a child process's stderr, are still logged and
 * never sent.
 */
function restoreFailure(
  log: { error: (context: object, message: string) => void },
  reply: FastifyReply,
  thrown: unknown,
): unknown {
  // UNWRAPPED FIRST, AND A TEST IS WHAT FOUND THAT THIS HAD TO BE. Every
  // failure raised by a restore STEP arrives as services/intake-plan.ts's
  // PlanApplyError with the real error on `cause` -- that is the frame's
  // contract, so a caller catching a mid-plan failure gets an honest account of
  // how far the run got. Dispatching on the wrapper instead would have replaced
  // every message services/restore.ts wrote for this moment -- the safety
  // backup's path, the commands that put the install back, "the restore has
  // HAPPENED" -- with a generic sentence about a step. That is verbatim the
  // reporting hazard that module's header is about, surviving one layer
  // further out.
  //
  // THE OUTCOME COMES WITH IT, because `unrealised` is the only honest answer
  // to "did the destruction happen": a failed load leaves destroy-schema
  // DISPATCHED AND UNREALISED, which is what the transaction actually did.
  const wrapped = thrown instanceof PlanApplyError ? thrown : null;
  const error = wrapped === null ? thrown : wrapped.cause;
  const unrealised = wrapped?.outcome.unrealised ?? [];

  // NOTHING WAS DESTROYED -- these two refuse before the destructive step.
  if (error instanceof RestoreToolMissingError) {
    return reply.code(503).send({
      error: "restore_tool_missing", message: error.message, aptPackage: error.aptPackage,
    });
  }
  if (error instanceof RestoreSafetyBackupError) {
    log.error({ detail: error.detail }, error.message);
    return reply.code(503).send({
      error: "restore_safety_backup_failed", message: error.message, restored: false,
    });
  }
  if (error instanceof RestoreDatabaseChangedError) {
    return reply.code(409).send({
      error: "restore_database_changed", message: error.message, restored: false,
    });
  }
  // THE LOAD FAILED AND THE ROLLBACK HELD. The operator is exactly where they
  // started, and the status says so: 409, not 500, because nothing is broken.
  if (error instanceof RestoreLoadFailedError) {
    log.error({ detail: error.detail }, error.message);
    return reply.code(409).send({
      error: "restore_load_failed", message: error.message, restored: false, unrealised,
    });
  }
  // AND THE ONES WHERE THE DATABASE IS NOT WHAT IT WAS. 500, and the message
  // travels whole.
  if (error instanceof RestoreHalfAppliedError) {
    log.error({ safetyBackupPath: error.safetyBackupPath }, error.message);
    return reply.code(500).send({
      error: "restore_half_applied", message: error.message,
      safetyBackupPath: error.safetyBackupPath,
      recoveryCommands: error.recoveryCommands, restored: false, unrealised,
    });
  }
  if (error instanceof RestoreUnexpectedResultError) {
    log.error({ safetyBackupPath: error.safetyBackupPath }, error.message);
    return reply.code(500).send({
      error: "restore_unexpected_result", message: error.message,
      safetyBackupPath: error.safetyBackupPath,
      recoveryCommands: error.recoveryCommands, restored: true,
    });
  }
  if (error instanceof RestoreInventoryMismatchError) {
    log.error({ safetyBackupPath: error.safetyBackupPath }, error.message);
    return reply.code(500).send({
      error: "restore_inventory_mismatch", message: error.message,
      disagreements: error.disagreements,
      safetyBackupPath: error.safetyBackupPath,
      recoveryCommands: error.recoveryCommands, restored: true,
    });
  }
  if (error instanceof RestoreMailKeyError) {
    log.error({ err: error.cause }, error.message);
    return reply.code(500).send({
      error: "restore_mail_key_failed", message: error.message, restored: true,
    });
  }
  if (error instanceof RestoreMigrationError) {
    log.error({ err: error.cause }, error.message);
    return reply.code(500).send({
      error: "restore_migration_failed", message: error.message, restored: true,
    });
  }
  if (error instanceof RestoreUnexpectedMigrationsError) {
    log.error({ safetyBackupPath: error.safetyBackupPath }, error.message);
    return reply.code(500).send({
      error: "restore_unexpected_migrations", message: error.message,
      safetyBackupPath: error.safetyBackupPath,
      recoveryCommands: error.recoveryCommands, restored: true,
    });
  }
  // NO ARM FOR PlanRefusedError, DELIBERATELY. applyPlan throws it for a plan
  // that carries a refusal or describes nothing, and neither can reach here:
  // the preview does not HOLD a refusal plan (see the inspect route), so its id
  // resolves to nothing and apply answers 404 before any of this. An arm for it
  // would be a branch no test could ever reach, which is the defence that is
  // not an instrument.
  //
  // THE FRAME'S OWN FAILURES. PlanExceededError is a bug in a step rather than
  // anything the operator did, and PlanApplyError wraps a handler failure that
  // is not one of the named ones above. Both carry the partial outcome, which
  // is the only honest account of how far the run got.
  if (error instanceof PlanExceededError) {
    log.error({ err: error }, "a restore step exceeded the plan it was given");
    return reply.code(500).send({
      error: "restore_failed",
      message: "the restore stopped because one of its steps did not match the preview. "
        + "The server log has the detail.",
    });
  }
  // A HANDLER FAILURE THAT IS NONE OF THE NAMED ONES. services/restore.ts gives
  // every state it knows about its own class, so reaching here means something
  // unforeseen -- and the one thing that must still be said is how far the run
  // got.
  if (wrapped !== null) {
    log.error({ err: error, op: wrapped.op, outcome: wrapped.outcome }, wrapped.message);
    return reply.code(500).send({
      error: "restore_failed",
      message: `the restore stopped during the ${wrapped.op} step. The server log has the detail.`,
      unrealised,
    });
  }
  throw error;
}
