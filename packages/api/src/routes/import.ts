import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import { CSV_IMPORT_FIELDS } from "@conduit/shared";
import type { CsvImportField, CsvMappingView, PlanView } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, parseOrReject } from "./helpers.js";
import { users } from "../db/schema.js";
import { FOREIGN_CSV_DELIMITERS } from "../services/csv.js";
import {
  receiveIntake, stageArchive, stageVerbatim,
  DEFAULT_MAX_UPLOAD_BYTES,
  IntakeArchiveError, IntakeDiskSpaceError, IntakePassphraseError, IntakeShapeError,
  IntakeToolMissingError, IntakeTooLargeError,
  type IntakeFile, type StagedPayload,
} from "../services/intake.js";
import {
  planView, PlanApplyError, PlanExceededError, PlanRefusedError,
  type IntakeSession,
} from "../services/intake-plan.js";
import {
  applyImport, inspectImport, ImportDatabaseChangedError,
  type ImportEffect, type ImportPlan,
} from "../services/import-export.js";
import {
  applyCsvImport, inspectCsv, planCsvImport, ImportCsvChangedError,
  type CsvImportEffect, type CsvImportPlan,
} from "../services/import-csv.js";

/**
 * THE HTTP SURFACE OF THE TWO IMPORTERS, AND THE FIVE DECISIONS THE ENGINES
 * DELIBERATELY LEFT TO A REQUEST.
 *
 * services/intake.ts lands and stages the upload, services/intake-plan.ts holds
 * the plan and frames apply, services/import-export.ts and
 * services/import-csv.ts decide what a file WOULD create. None of them decides
 * that an import MAY happen, or who it belongs to, or what an operator is told
 * when the world moved underneath them. All of that needs a request, so all of
 * it is here.
 *
 * ============ 1. THERE IS NO RE-AUTHENTICATION ON THESE ROUTES ============
 *
 * AND THAT IS AN ARGUMENT RATHER THAN AN OMISSION, because the neighbouring
 * file does the opposite and copying it would have been the easy thing.
 *
 * WHAT THE GATE IS FOR, in v1.3.0's own words and routes/restore.ts's: 7.6
 * turns a stolen or borrowed session into a one-click copy of the entire CRM,
 * and of the mail key and every stored mail password with it; a restore turns
 * one into the destruction of the database. Both gated routes EXFILTRATE OR
 * DESTROY EVERYTHING. An import does neither. Every effect either importer can
 * plan carries `destroys: false`; both refuse to overwrite or merge a row that
 * is already here; and what a mistaken import leaves behind is rows an operator
 * can archive, which is the exact line 7.7's spec draws between the two halves
 * of this phase.
 *
 * AND ADDING A FIFTH GATED ROUTE WOULD MAKE THE GATE WEAKER, WHICH IS THE PART
 * THAT DECIDED IT. v1.4.1 records that a ticket is FUNGIBLE ACROSS EVERY GATED
 * ROUTE: /api/reauth mints one ticket and any gated route will spend it. So a
 * ticket the operator minted meaning "let me preview an import" is a ticket
 * that can be spent on a backup download. Every route added to that set widens
 * what one confirmation authorises, and the routes worth protecting are the
 * ones that lose by it.
 *
 * THE THIRD REASON IS HABITUATION, and it is the one a design review would
 * raise. The CSV pipeline is three requests -- read the columns, preview,
 * import. Gating them is three password prompts to load a spreadsheet of
 * contacts, which teaches an operator to type their password at any prompt this
 * application shows them. The restore's second prompt only means anything
 * because prompts here are rare and each one says what it is buying.
 *
 * WHAT IS STILL REFUSED: everything requireUser refuses. These routes are
 * behind SSOwat and behind the identity hook like every other route in the
 * application, and a plan is bound to the operator who uploaded it
 * (IntakeSession.owner).
 *
 * THE ONE THING AN IMPORT LEAKS, SAID RATHER THAN LEFT TO BE FOUND. A preview
 * reports how many of the file's rows are ALREADY HERE, and names worked
 * examples. Somebody who can upload a file can therefore ask "is this address
 * one of your contacts?" a thousand times at once. That is an oracle, and it is
 * not a privilege escalation: the caller is an authenticated Conduit user who
 * can read /api/contacts directly and get the same answer more easily and in
 * full. If Conduit ever grows a user who may import but may not read, this
 * paragraph is the note that says the two must be reconsidered together.
 *
 * ========== 2. THE MAPPING STEP HOLDS NOTHING, AND THE FILE IS SENT ==========
 * ========== AGAIN WITH THE MAPPING                                 ==========
 *
 * @conduit/shared's CsvMappingView left this open in as many words: a mapping
 * step happens BEFORE a plan exists, so what would have to be held is the
 * staged upload on its own -- "and whether that is an IntakeSession whose plan
 * is not built yet, or a second kind of hold, is a question about the store".
 *
 * THE ANSWER IS NEITHER. IntakeSessionStore's own header says what it is:
 * "WHERE A PLAN WAITS WHILE A PERSON LOOKS AT IT". A mapping step has no plan
 * and nothing to decide about yet, so nothing about it belongs in that store,
 * and both of the offered options would have meant surgery on the module that
 * holds a decrypted backup for the most dangerous operation in the product --
 * for a pipeline that adds contacts.
 *
 * SO THE CSV IS UPLOADED TWICE: once to read its columns, once with the
 * mapping. THE COST IS REAL AND IT IS NAMED: a 14MB spreadsheet of 200,000
 * contacts (services/import-csv.ts's measured figure) is sent twice instead of
 * once. THREE THINGS BUY IT BACK, and the third is the one that settled it:
 *
 *   - THE CAPACITY-OF-ONE SLOT IS NOT HELD FOR HUMAN-THINKING TIME. The store
 *     holds one session at a time and is shared with the restore; an operator
 *     who opened a mapping step and went to lunch would otherwise refuse every
 *     restore on the install until the plan TTL ran out.
 *   - NOTHING IS DECRYPTED, UNPACKED OR HELD ON THE SERVER while a person reads
 *     a column list. The staged file lives for the length of one request.
 *   - AND THE UPLOAD THE HOLD WOULD HAVE SAVED IS DISPOSED OF EXACTLY WHEN IT
 *     WOULD MATTER. IntakeSessionStore.use deletes the staging in a `finally`,
 *     so an apply refused by ImportCsvChangedError -- the case where an
 *     operator has the most to lose -- destroys the staged file either way. The
 *     hold would have saved an upload on every path except the one the whole
 *     question was about.
 *
 * AND THE RE-SEND IS CHECKED RATHER THAN TRUSTED. The plan request carries the
 * `sha256` the mapping step reported for the bytes it read, and this route
 * refuses a mapping whose digest does not match the file that arrived with it.
 * A mapping is a list of COLUMN POSITIONS, so applying one to a different file
 * with the same number of columns would put a postcode in a phone number with
 * nothing on screen to say so. It also makes "the mapping step happened at all"
 * a fact this route can check, which is the one thing a hold would have given
 * it for free.
 *
 * ================= 3. THE CAPACITY STAYS AT ONE ==========================
 *
 * Three pipelines share one slot and that is kept, on IntakeSessionStore's own
 * reason: a held session is an unpacked archive sitting in $data_dir, and two
 * of them is two of them. An export archive is roughly the size of the install
 * it came from, so this is not a theoretical bound. Raising it would also mean
 * deciding what a second operator is allowed to see about the first, which is
 * a worse question than the wait.
 *
 * WHAT THE OPERATOR IS TOLD WHEN IT BITES NAMES NO PIPELINE. Until this task
 * the store could only ever hold a restore, so routes/restore.ts's refusal
 * could say "another BACKUP is already uploaded" and be right. It can now be
 * wrong, and that sentence is corrected in the same commit as this file rather
 * than filed: a message that names the wrong artefact sends an operator looking
 * for a restore to cancel that does not exist. That the refusal tells one
 * caller that ANOTHER has an upload waiting at all is the separate v1.4.1 item
 * and is deliberately not changed here.
 *
 * ============ 4. THE WORLD MOVING BETWEEN PREVIEW AND APPLY IS A 409 =========
 *
 * Both engines refuse an apply whose insert count differs from the count the
 * preview published, in either direction, and roll the whole import back.
 * That is 409 for routes/restore.ts's reason for RestoreDatabaseChangedError:
 * nothing is broken, nothing was written, and the request can be made again
 * once the caller has a fresh preview. A 500 would say the server failed; a 200
 * would say it worked.
 *
 * THE TWO ARE SEPARATE CODES BECAUSE THE PAGE DOES DIFFERENT THINGS WITH THEM,
 * and services/import-csv.ts asked for exactly that: "a routes task should keep
 * the operator's mapping in front of them across a refused apply, because
 * nothing about the mapping became untrue -- only the counts did." So
 * `import_csv_changed` says the mapping survives and `import_changed` does not,
 * and the page keeps the mapping on screen for the first and offers a re-upload
 * for the second.
 *
 * ================== 5. THE OWNER IS A MAPPING CONTROL =====================
 *
 * services/import-csv.ts named this one and left it here: an owner "is a
 * MAPPING CONTROL rather than a column, so it belongs to the routes task".
 * @conduit/shared's CsvMapping.owner carries it, THIS route proves it names a
 * user before a byte of the file is read -- earlier and cheaper than a refusal
 * plan -- and the engine freezes it onto the effect so the preview's sentence
 * about who these rows will belong to is what apply writes.
 *
 * ONLY THE FOREIGN IMPORTER HAS ONE. The exact importer reads
 * `owner_user_id` out of the export and keeps it when the user exists on this
 * install, which is a better answer than any picker: the rows come back owned
 * by whoever owned them. Offering a picker there would be offering to overwrite
 * that.
 *
 * ================== AND THE CONSTRAINTS THIS BRANCH PAID FOR ================
 *
 * THE PLAN NEVER TRAVELS. Every preview answers with a RENDERING (planView) and
 * an id; every apply's body is a `strictObject` with ONE field. A client that
 * sent effects is told the server does not read them rather than having them
 * silently stripped -- routes/restore.ts's argument, unchanged.
 *
 * THE UPLOAD IS HANDLED WITH THE CREDENTIAL DISCIPLINE AND IS NOT A CREDENTIAL,
 * and the distinction is worth one sentence rather than a borrowed claim. A
 * backup carries mail.key in the clear; a contacts spreadsheet carries personal
 * data and no secret. What is the same is the handling, because receiveIntake
 * is the only way in: 0600, inside $data_dir, never /tmp, removed on every exit
 * path including a refusal and an abandoned upload. routes/restore.ts's boot
 * sweep covers the one exit path no `finally` reaches, and covers these
 * directories too because it is the same prefix in the same directory.
 *
 * THERE IS NO GET IN THIS FAMILY. Nothing here takes a passphrase, so the
 * access-log argument that made restore's routes POSTs does not apply -- but a
 * GET that uploaded a file is not a thing, and a GET that applied a plan would
 * be a plan applied by a link.
 */

/** How large an upload either importer accepts, before nginx is consulted. */
const importUploadCap = (deps: CrmRouteDeps): number =>
  deps.importMaxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

/**
 * conf/nginx.conf's `client_max_body_size` for the three routes that receive a
 * file, published so routes/import-nginx.test.ts compares the deployment
 * against the application rather than against a number typed twice.
 *
 * 9g AND NOT 8g, FOR RESTORE'S REASON EXACTLY: the app's cap is on the FILE
 * PART and nginx's is on the WHOLE BODY, which also carries the multipart
 * preamble, the mapping field and every boundary. Set equal, a file of exactly
 * the app's ceiling is refused a few hundred bytes over.
 */
export const IMPORT_CLIENT_MAX_BODY_SIZE = "9g";

/**
 * conf/nginx.conf's `proxy_read_timeout` for the import family.
 *
 * THE SAME HOUR THE RESTORE TAKES, AND FOR A NARROWER REASON. Nothing is
 * written to the response until the whole of the work is done: a preview
 * unpacks an archive and reads every row of it before it answers, and an apply
 * of 200,000 rows measured 21.5s for the exact importer and 43.9s for the
 * foreign one on the deploy target. Those fit inside the app's default 300s and
 * a file ten times the size does not, and the app's own ceiling is 8 GiB.
 */
export const IMPORT_PROXY_READ_TIMEOUT_SECONDS = 3600;

/** Multipart field values arrive as `{ value, ... }` wrappers, not bare strings. */
function fieldValue(field: MultipartFile["fields"][string]): string | undefined {
  if (field === undefined || Array.isArray(field) || field.type !== "field") return undefined;
  return typeof field.value === "string" ? field.value : undefined;
}

/**
 * The apply request's body. ONE FIELD, AND NOTHING ELSE IS ACCEPTED.
 *
 * `strictObject` rather than the ordinary strip, on routes/restore.ts's
 * argument: the plan does not travel, and a client that tried to send one
 * should be told the server does not read it rather than have it ignored.
 */
const applyRequestSchema = z.strictObject({
  planId: z.uuid("that is not a plan id"),
});

const planIdParamSchema = z.object({ planId: z.uuid("that is not a plan id") });

/**
 * Every field a column may be mapped onto, AS A SCHEMA DERIVED FROM THE LIST
 * THE PICKER IS BUILT FROM.
 *
 * NOT A SECOND LIST OF FOURTEEN STRINGS. @conduit/shared's CSV_IMPORT_FIELDS is
 * what the mapping step offers, what csvImportField resolves and what
 * csvMappingProblem reasons about; a hand-written enum here would be a fifth
 * copy of it and the one that drifted would refuse a mapping the page had just
 * offered.
 */
const csvImportFieldSchema = z.enum(
  CSV_IMPORT_FIELDS.map((def) => def.field) as [CsvImportField, ...CsvImportField[]],
);

/**
 * WHAT THE OPERATOR DECIDED, ARRIVING FROM A CLIENT.
 *
 * THE ONE THING IN THE WHOLE SPINE THAT TRAVELS AND IS ACTED ON -- and
 * @conduit/shared's CsvMapping says why that is not a hole in the plan-as-a-
 * value design: a plan is a DESCRIPTION OF WORK, and re-validating one would be
 * a second implementation of inspect; this is a DECISION ONLY A PERSON CAN
 * MAKE, and it is validated on arrival like any other input.
 *
 * THE DELIMITER IS THE READER'S OWN CLOSED SET, imported rather than restated,
 * so an operator cannot overrule the sniff with a character
 * services/csv.ts cannot count fields on.
 *
 * WHAT IS NOT CHECKED HERE IS THE COLUMNS, deliberately. csvMappingProblem is
 * the one rule both sides use and it needs the file's column count, which does
 * not exist until the upload has been staged -- so it runs inside
 * planCsvImport, over the header of the very bytes that arrived, and its
 * sentence is what a refused mapping is answered with.
 */
const csvMappingSchema = z.strictObject({
  entries: z.array(z.strictObject({
    column: z.int().nonnegative("a column is identified by its position, from 0"),
    field: csvImportFieldSchema,
  })),
  delimiter: z.enum(FOREIGN_CSV_DELIMITERS).optional(),
  owner: z.uuid("that is not a user id").optional(),
});

export function registerImportRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { db, dataDir, intakeSessions } = deps;
  const maxUploadBytes = importUploadCap(deps);

  /**
   * Take the file part off a multipart request, or answer and return null.
   *
   * ONE HELPER FOR THREE ROUTES rather than three copies of a refusal chain
   * that has to end with the stream drained. An un-consumed part keeps the
   * request open, which is the failure mode that looks like a hang rather than
   * like a bug.
   */
  const takeFile = async (
    request: FastifyRequest, reply: FastifyReply,
  ): Promise<MultipartFile | null> => {
    let part: MultipartFile | undefined;
    try {
      // A PER-REQUEST LIMIT, because the app-wide one is 50MB for attachments
      // and an export archive is roughly the size of the install.
      //
      // `files` IS REPEATED ON PURPOSE. Per-request options REPLACE the
      // plugin's `limits` object rather than merging into it, so naming only
      // `fileSize` would silently drop the app-wide `files: 1` on exactly the
      // routes that read an unbounded upload from a stranger.
      part = await request.file({ limits: { fileSize: maxUploadBytes, files: 1 } });
    } catch {
      void reply.code(400).send({
        error: "validation", message: "a multipart file upload is required",
      });
      return null;
    }
    if (part === undefined || part.fieldname !== "file") {
      part?.file.resume();
      void reply.code(400).send({
        error: "validation", message: 'a file field named "file" is required',
      });
      return null;
    }
    return part;
  };

  /**
   * REFUSED BEFORE THE UPLOAD, so an operator whose previous preview is still
   * open is told to finish or cancel it rather than after ten minutes of
   * uploading. `hold` refuses again below, which is what actually holds when
   * two callers race; this is the message that is worth reading.
   *
   * IT NAMES NO PIPELINE, and routes/restore.ts's twin has been corrected to
   * match. What is waiting may be a restore, an export import or a CSV import,
   * and a sentence that guessed would send somebody hunting for the wrong
   * control. That it says an upload is waiting AT ALL is the v1.4.1 item and is
   * unchanged.
   *
   * `size` EXCLUDES SESSIONS INSIDE `use`, so during an apply this reads zero.
   * For the restore that gap is covered by the write gate refusing every POST;
   * an import does not close the gate, so two applies of two DIFFERENT plans
   * could in principle overlap. They cannot in practice -- the store holds one
   * plan, so a second plan cannot exist to be applied -- and the honest
   * statement is that the capacity of one is what closes it here rather than
   * anything this route does.
   */
  const refuseIfBusy = (reply: FastifyReply): boolean => {
    if (intakeSessions.size === 0) return false;
    void reply.code(409).send({
      error: "import_busy",
      message: "another upload is already waiting for a decision on this install; "
        + "finish or cancel it first",
    });
    return true;
  };

  /**
   * POST /api/import/export/inspect -- upload a Conduit export and see what
   * importing it would add, with nothing written.
   */
  app.post("/api/import/export/inspect", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    if (refuseIfBusy(reply)) return;

    const part = await takeFile(request, reply);
    if (part === null) return;

    let file: IntakeFile | null = null;
    let payload: StagedPayload | null = null;
    let held = false;
    /**
     * Delete the staging, unless the store has taken it.
     *
     * CALLED BEFORE EVERY ANSWER AND AGAIN IN A `finally`, AND THE TWO ARE NOT
     * THE SAME GUARANTEE -- routes/restore.ts learned that the hard way and the
     * reasoning carries over unchanged. The `finally` guarantees it HAPPENS;
     * the explicit calls guarantee it happens BEFORE THE ANSWER GOES OUT, so
     * there is no instant in which a caller has been told the archive was
     * refused while it is still on the disk. It is idempotent.
     */
    const discard = async (): Promise<void> => {
      if (held) return;
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
      // and routes/restore.ts check their own: busboy sets this when it stops
      // feeding the stream, and receiveIntake has by then written a PREFIX of
      // the archive. A prefix of a zip is not a small archive, it is a broken
      // one, and staging it would refuse it as damage with no hint of why.
      if (part.file.truncated) {
        await discard();
        return reply.code(413).send({
          error: "too_large",
          message: `the upload is larger than the ${String(maxUploadBytes)} bytes this install `
            + "accepts",
        });
      }
      // NO PASSPHRASE, AND null IS THE WHOLE STATEMENT. An export is not
      // encrypted and has nothing to encrypt: services/export.ts writes no
      // credentials, no mail and no mail.key, which is why it needs none. A
      // `.7z` that reached this control is refused by inspectImport's
      // `notAnExport`, which is the same line restore's `notABackup` draws from
      // the other side.
      payload = await stageArchive({ file, passphrase: null });
      const plan: ImportPlan = await inspectImport({ file, payload, db });
      if (plan.refusal !== null) {
        // A REFUSAL IS STILL A PLAN AND IS STILL RENDERED, and it is NOT HELD
        // -- routes/restore.ts's rule, and for the same reason: the staging is
        // removed on every exit path and a refusal is an exit path. Keeping an
        // unpacked archive for half an hour so somebody could apply a plan that
        // cannot be applied buys nothing.
        await discard();
        return { plan: planView(plan) };
      }
      const session: IntakeSession<ImportEffect> = { plan, payload, owner: user.username };
      intakeSessions.hold(session);
      held = true;
      const view: PlanView = planView(plan);
      return { plan: view };
    } catch (error) {
      await discard();
      return intakeRefusal(reply, error);
    } finally {
      await discard();
    }
  });

  /**
   * POST /api/import/csv/inspect -- what is in this file? Columns, samples and
   * a guess, and NOTHING about what would be created.
   *
   * NOTHING IS HELD BY THIS ROUTE. See this module's decision 2: the staged
   * file is deleted before the answer goes out, and the mapping arrives with
   * the file again.
   */
  app.post("/api/import/csv/inspect", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    // BUSY IS STILL REFUSED HERE even though this route holds nothing, and it
    // is the conservative direction rather than a copied line: what it protects
    // is the DISK, which a staged upload occupies for the length of this
    // request whether or not it is held afterwards, and the one thing an
    // operator with a preview waiting should be doing is deciding about it.
    if (refuseIfBusy(reply)) return;

    const part = await takeFile(request, reply);
    if (part === null) return;

    const chosen = fieldValue(part.fields.delimiter);
    // THE OPERATOR'S OVERRULE OF THE SNIFF, checked against the reader's own
    // closed set. An unparseable one is refused rather than silently sniffed:
    // a page that asked for a semicolon and got a comma would be reading a
    // different file from the one on screen.
    if (chosen !== undefined
      && !(FOREIGN_CSV_DELIMITERS as readonly string[]).includes(chosen)) {
      part.file.resume();
      return reply.code(400).send({
        error: "validation",
        message: "a column separator has to be one of a comma, a semicolon, a tab or a pipe",
      });
    }

    let file: IntakeFile | null = null;
    let payload: StagedPayload | null = null;
    const discard = async (): Promise<void> => {
      if (payload !== null) await payload.dispose();
      else if (file !== null) await file.dispose();
      file = null;
      payload = null;
    };
    try {
      file = await receiveIntake({
        dataDir, source: part.file, filename: part.filename, maxBytes: maxUploadBytes,
      });
      if (part.file.truncated) {
        await discard();
        return reply.code(413).send({
          error: "too_large",
          message: `the upload is larger than the ${String(maxUploadBytes)} bytes this install `
            + "accepts",
        });
      }
      payload = stageVerbatim({ file });
      const mapping: CsvMappingView = await inspectCsv({ file, payload, delimiter: chosen });
      // BEFORE THE ANSWER GOES OUT, which is the ordering routes/restore.ts had
      // to learn: `reply.send` dispatches immediately, so a caller could
      // otherwise see the column list while the file was still on the disk.
      await discard();
      return { mapping };
    } catch (error) {
      await discard();
      return intakeRefusal(reply, error);
    } finally {
      await discard();
    }
  });

  /**
   * POST /api/import/csv/plan -- the file again, plus what the operator decided
   * about its columns, and what that would create.
   *
   * THE FIELDS MUST COME BEFORE THE FILE PART. Fastify's multipart parser is
   * streaming, so a field declared after the file has not been seen when
   * `request.file()` resolves -- the same contract routes/files.ts and
   * routes/restore.ts document. A body with the mapping last therefore reads as
   * a body with no mapping and is refused with the rule rather than treated as
   * an empty one. THIS PROJECT'S TESTS CANNOT EXERCISE THAT ORDERING, and
   * saying so is cheaper than a reader assuming they do: an in-process
   * injection hands the whole body over in one chunk, so busboy has parsed
   * every part before any await resolves. What IS tested is the refusal an
   * absent mapping gets, which is the same refusal.
   */
  app.post("/api/import/csv/plan", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    if (refuseIfBusy(reply)) return;

    const part = await takeFile(request, reply);
    if (part === null) return;

    const raw = fieldValue(part.fields.mapping);
    const expected = fieldValue(part.fields.sha256);
    if (raw === undefined || expected === undefined) {
      part.file.resume();
      return reply.code(400).send({
        error: "validation",
        message: 'a "mapping" field and the "sha256" the columns were read from are required',
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      part.file.resume();
      return reply.code(400).send({
        error: "validation", message: "the mapping field is not JSON",
      });
    }
    const mapping = csvMappingSchema.safeParse(parsed);
    if (!mapping.success) {
      part.file.resume();
      return reply.code(400).send({
        error: "validation",
        message: mapping.error.issues[0]?.message ?? "that is not a column mapping",
      });
    }

    // THE OWNER IS PROVED TO NAME A USER BEFORE A BYTE IS READ, which is both
    // cheaper than a refusal plan and earlier than one: the alternative is
    // reading a 45MB file to discover that a picker sent an id nothing answers
    // to. It is a SELECT and never an insert, so nothing is created for a name
    // that does not exist -- resolveUser's cache-miss write belongs to the
    // identity hook and has no business here.
    let owner: { id: string; label: string } | null = null;
    if (mapping.data.owner !== undefined) {
      const found = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, mapping.data.owner))
        .limit(1);
      const row = found[0];
      if (row === undefined) {
        part.file.resume();
        return reply.code(400).send({
          error: "import_owner_unknown",
          message: "the owner chosen for this import is not a user of this install. Choose "
            + "somebody from the list, or import the rows with no owner.",
        });
      }
      owner = { id: row.id, label: row.username };
    }

    let file: IntakeFile | null = null;
    let payload: StagedPayload | null = null;
    let held = false;
    const discard = async (): Promise<void> => {
      if (held) return;
      if (payload !== null) await payload.dispose();
      else if (file !== null) await file.dispose();
      file = null;
      payload = null;
    };
    try {
      file = await receiveIntake({
        dataDir, source: part.file, filename: part.filename, maxBytes: maxUploadBytes,
      });
      if (part.file.truncated) {
        await discard();
        return reply.code(413).send({
          error: "too_large",
          message: `the upload is larger than the ${String(maxUploadBytes)} bytes this install `
            + "accepts",
        });
      }
      // THE FILE THE MAPPING WAS BUILT AGAINST, AND NOT MERELY A FILE.
      //
      // A mapping is a list of COLUMN POSITIONS -- never names, because a
      // foreign file can have two columns called "Email" -- so a mapping
      // applied to a different file with the same number of columns imports
      // every value into the wrong field, silently, with a preview that reads
      // perfectly. csvMappingProblem cannot see that: it is pure and it is
      // about the columns, and both files have five of them.
      //
      // THE DIGEST IS THE SERVER'S OWN, of the bytes that just arrived
      // (receiveIntake hashes them on their way to the disk), compared against
      // the one the mapping step reported for the bytes IT read. A client that
      // lies about it can only mis-import its own upload, which it could do by
      // sending a wrong mapping anyway; what this closes is the accident.
      if (file.sha256 !== expected) {
        await discard();
        return reply.code(409).send({
          error: "import_csv_file_changed",
          message: "this is not the file the columns were read from, so the mapping cannot be "
            + "trusted to line up with it -- a mapping points at column POSITIONS. Read the "
            + "columns again and map them.",
        });
      }
      payload = stageVerbatim({ file });
      const plan: CsvImportPlan = await planCsvImport({
        file, payload, db, mapping: mapping.data, owner,
      });
      if (plan.refusal !== null) {
        await discard();
        return { plan: planView(plan) };
      }
      const session: IntakeSession<CsvImportEffect> = { plan, payload, owner: user.username };
      intakeSessions.hold(session);
      held = true;
      const view: PlanView = planView(plan);
      return { plan: view };
    } catch (error) {
      await discard();
      return intakeRefusal(reply, error);
    } finally {
      await discard();
    }
  });

  /**
   * POST /api/import/export/apply -- add the rows the preview described.
   *
   * THE KIND CHECK IS A GUARD AND NOT A CAST. The store is the shared spine's
   * and holds whichever of the three pipelines put a session in it, so a
   * restore's plan or a CSV plan reached through this route gets the same
   * non-answer an unknown id gets. It is also what makes the `as ImportPlan`
   * below sound rather than hopeful.
   */
  app.post("/api/import/export/apply", async (request, reply) => {
    return await applyOne(request, reply, "import-export");
  });

  /** POST /api/import/csv/apply -- the same, for a mapped spreadsheet. */
  app.post("/api/import/csv/apply", async (request, reply) => {
    return await applyOne(request, reply, "import-csv");
  });

  async function applyOne(
    request: FastifyRequest, reply: FastifyReply, kind: "import-export" | "import-csv",
  ): Promise<unknown> {
    const user = requireUser(request, reply);
    if (user === null) return;
    const body = parseOrReject(applyRequestSchema, request.body, reply);
    if (body === undefined) return;

    // LOOKED UP AND NOT TAKEN, so the two refusals below leave the operator's
    // upload where it is. Everything past `use` consumes the plan.
    const session = intakeSessions.get(body.planId, user.username);
    if (session === undefined || session.plan.kind !== kind) {
      return reply.code(404).send({
        error: "import_plan_unknown",
        message: "that preview is not available any more; upload the file again",
      });
    }

    try {
      const outcome = await intakeSessions.use(body.planId, user.username, async (session) => {
        return kind === "import-export"
          ? await applyImport({ plan: session.plan as ImportPlan, payload: session.payload, db })
          : await applyCsvImport({
            plan: session.plan as CsvImportPlan, payload: session.payload, db,
          });
      });
      if (outcome === undefined) {
        // Taken between the lookup above and here, which a second apply of the
        // same plan can do. `use` removed it from the map before the work
        // started, so this is the second caller and there is nothing to run.
        return reply.code(404).send({
          error: "import_plan_unknown",
          message: "that preview is not available any more; upload the file again",
        });
      }
      return {
        imported: true,
        dispatched: outcome.dispatched,
        realised: outcome.realised,
        spent: outcome.spent,
        message: `${outcome.spent.toLocaleString("en-GB")} rows were added. Nothing that was `
          + "already here was changed.",
      };
    } catch (error) {
      return importFailure(request.log, reply, error);
    }
  }

  /**
   * DELETE /api/import/:planId -- change your mind, and delete the upload now
   * rather than in half an hour.
   *
   * ONE ROUTE FOR BOTH IMPORTERS AND NOT TWO, which is the opposite of the
   * apply routes and for a reason that survives the inconsistency: what this
   * does is DELETE, it takes no description of any work, and the store's
   * `discard` does not care what kind of plan it is holding. Two routes would
   * be two places to forget the owner check.
   *
   * NOT BEHIND ANYTHING BEYOND THE OWNER CHECK, which is the conservative
   * direction here as it is for the restore's: the failure mode of making it
   * harder to reach is a staged upload sitting in $data_dir for the rest of the
   * plan's TTL, holding the one slot the whole install shares.
   */
  app.delete("/api/import/:planId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(planIdParamSchema, request.params, reply);
    if (params === undefined) return;
    const discarded = await intakeSessions.discard(params.planId, user.username);
    if (!discarded) {
      return reply.code(404).send({
        error: "import_plan_unknown",
        message: "that preview is not available any more",
      });
    }
    return reply.code(204).send();
  });
}

/**
 * What a preview answers when the upload could not be taken in.
 *
 * NOTHING HERE ECHOES A `detail`. IntakeArchiveError carries 7z's stderr, which
 * names paths inside $data_dir -- the same line routes/restore.ts and
 * routes/backup.ts hold. The MESSAGES are echoed, because every one of them
 * describes something the operator can act on and none of them names a path.
 */
function intakeRefusal(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof IntakeToolMissingError) {
    return reply.code(503).send({
      error: "import_tool_missing", message: error.message, aptPackage: error.aptPackage,
    });
  }
  if (error instanceof IntakeDiskSpaceError) {
    return reply.code(507).send({
      error: "import_disk_space", message: error.message,
      requiredBytes: error.neededBytes, availableBytes: error.freeBytes,
    });
  }
  if (error instanceof IntakeTooLargeError) {
    return reply.code(413).send({ error: "too_large", message: error.message });
  }
  // 400, all three: the file is the caller's, and every one of these is a fact
  // about the file they chose. IntakePassphraseError is in the list and cannot
  // fire on these routes -- stageArchive only checks a passphrase it was given
  // one for, and these routes give it null -- so the arm is here for the shape
  // of the union rather than for a path, and is named as such rather than left
  // to look like a defence somebody tested.
  if (error instanceof IntakeArchiveError || error instanceof IntakeShapeError
    || error instanceof IntakePassphraseError) {
    return reply.code(400).send({ error: "import_file_refused", message: error.message });
  }
  if (error instanceof PlanRefusedError) {
    return reply.code(409).send({ error: "import_busy", message: error.message });
  }
  throw error;
}

/**
 * What an apply answers when the rows did not go in.
 *
 * THE ONE RULE: NOTHING WAS IMPORTED, AND THE OPERATOR IS TOLD SO PLAINLY.
 * Every failure here leaves the database exactly as it was, because both
 * engines run their whole import inside one transaction that rolls back as a
 * unit -- which is the difference between this function and its opposite number
 * in routes/restore.ts, where the whole difficulty is that the answer to "did
 * it happen" is sometimes yes.
 */
function importFailure(
  log: { error: (context: object, message: string) => void },
  reply: FastifyReply,
  thrown: unknown,
): unknown {
  // UNWRAPPED FIRST, for routes/restore.ts's reason: every failure raised by a
  // step arrives as services/intake-plan.ts's PlanApplyError with the real
  // error on `cause`. Dispatching on the wrapper would answer every one of the
  // cases below with a generic sentence about a step.
  const wrapped = thrown instanceof PlanApplyError ? thrown : null;
  const error = wrapped === null ? thrown : wrapped.cause;

  // THE WORLD MOVED. 409 and not 500: nothing is broken and nothing was
  // written. The two codes differ because the page does -- see decision 4.
  if (error instanceof ImportCsvChangedError) {
    return reply.code(409).send({
      error: "import_csv_changed", message: error.message, imported: false,
    });
  }
  if (error instanceof ImportDatabaseChangedError) {
    return reply.code(409).send({
      error: "import_changed", message: error.message, imported: false,
    });
  }
  if (error instanceof PlanExceededError) {
    log.error({ err: error }, "an import step exceeded the plan it was given");
    return reply.code(500).send({
      error: "import_failed",
      message: "the import stopped because one of its steps did not match the preview, and "
        + "nothing was imported. The server log has the detail.",
      imported: false,
    });
  }
  if (wrapped !== null) {
    log.error({ err: error, op: wrapped.op, outcome: wrapped.outcome }, wrapped.message);
    return reply.code(500).send({
      error: "import_failed",
      message: `the import stopped during the ${wrapped.op} step and nothing was imported: the `
        + "whole of it runs in one transaction, which has been rolled back. The server log has "
        + "the detail.",
      imported: false,
    });
  }
  // NO ARM FOR PlanRefusedError, and the reason is the same as its absence from
  // routes/restore.ts's failure map: applyPlan throws it for a plan that
  // carries a refusal or describes nothing, and neither can reach here, because
  // a refusal plan is not HELD and so its id resolves to nothing. An arm for it
  // would be a branch no test could reach.
  throw error;
}