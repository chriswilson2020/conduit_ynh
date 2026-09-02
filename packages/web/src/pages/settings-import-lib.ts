import { csvMappingProblem } from "@conduit/shared";
import type { CsvImportField, CsvMapping, CsvMappingView } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";

/**
 * The Settings page's IMPORT logic, kept out of the page for the reason
 * settings-data-lib.ts is: this package's vitest environment is `node`, so what
 * is not extracted here is only ever exercised by Playwright.
 *
 * A SECOND MODULE RATHER THAN MORE OF THE FIRST, and it is a decision rather
 * than filing. settings-data-lib.ts is about three artefacts that LEAVE or
 * REPLACE, and its two error functions are deliberately not one because "a file
 * did not arrive" and "a database may or may not still exist" are different
 * things to be told. An import is a third thing again -- it ADDS, and every
 * failure it has leaves the database exactly as it was -- so `importProblem`
 * has an answer no arm of `restoreProblem` could honestly give, and merging
 * them would mean one function whose every branch had to ask which of three
 * pipelines it was in.
 *
 * WHAT IS HERE IS THE PART THAT DECIDES: whether an upload can be sent, whether
 * a mapping can be used, what a failure means in words, and -- the one that
 * matters most on this surface -- WHICH FAILURES LEAVE THE OPERATOR'S WORK
 * WHERE IT IS.
 */

// ---------------------------------------------------------------------------
// The upload step, which both importers share
// ---------------------------------------------------------------------------

export interface ImportUploadState {
  file: File | null;
  /**
   * The column separator, overruling the sniff. "" means "let Conduit guess".
   *
   * FOREIGN CSV ONLY, and it is on the shared state rather than in a second
   * type because the exact importer simply never renders the control. A
   * sniffer nobody can correct decides the whole import on its own -- which is
   * @conduit/shared's CsvMapping.delimiter's own reason for existing -- and
   * Excel on a machine whose locale uses the comma as a decimal separator
   * writes semicolons silently.
   */
  delimiter: string;
}

export const EMPTY_IMPORT_UPLOAD: ImportUploadState = { file: null, delimiter: "" };

/**
 * THE REASON THE UPLOAD BUTTON IS OFF, IN WORDS, or null when it is on.
 *
 * NO CONTROL IS EVER DISABLED FOR A REASON NOBODY CAN SEE. That is the rule
 * v1.2.2 settled and this codebase has now declined to ship a breach of four
 * times. There is no `touched` here and there is no form problem beside it,
 * because there is nothing to mistype: an import's whole form is a file.
 *
 * `busy` NAMES NO OPERATION, on restorePreviewBlocked's own correction. A page
 * that guessed which of six things was running got it wrong on three of them,
 * and a visible WRONG reason is worse than a vague one.
 */
export function importUploadBlocked(
  state: ImportUploadState, busy: boolean, running: boolean,
): string | null {
  if (running) return null;
  if (busy) return "One thing at a time. This is waiting for the operation already running.";
  if (state.file === null) return "Choose a file to enable this.";
  return null;
}

// ---------------------------------------------------------------------------
// The mapping step, which only the foreign importer has
// ---------------------------------------------------------------------------

/**
 * WHAT THE OPERATOR HAS CHOSEN SO FAR, KEYED BY COLUMN POSITION.
 *
 * BY POSITION AND NEVER BY NAME, which is @conduit/shared's rule for this whole
 * value and not this module's preference: somebody else's spreadsheet can have
 * two columns both called "Email", a column called "", and a column whose name
 * differs from its neighbour only by a trailing space. A record keyed by header
 * text would silently apply one choice to both of the two.
 *
 * "" MEANS "DO NOT IMPORT THIS COLUMN", which is a real answer rather than an
 * unfilled one -- a foreign export is mostly columns Conduit has nowhere to put.
 */
export type MappingChoices = Readonly<Record<number, CsvImportField | "">>;

/**
 * What Conduit guessed, as the starting point the operator edits.
 *
 * THE GUESS IS THE DEFAULT AND NOT THE DECISION. services/import-csv.ts is
 * explicit that nothing downstream reads its suggestions -- the plan takes the
 * MAPPING -- so a wrong guess costs one click and can never cost a column. What
 * it buys is that a recognised Outlook or Pipedrive export is mapped before the
 * operator has touched anything.
 */
export function initialChoices(view: CsvMappingView): MappingChoices {
  const choices: Record<number, CsvImportField | ""> = {};
  for (const column of view.columns) choices[column.index] = column.suggestion ?? "";
  return choices;
}

/**
 * The choices, as the value the server takes.
 *
 * EMPTY CHOICES ARE DROPPED rather than sent as a field nothing answers to, and
 * the entries come out in column order because that is what makes a contact's
 * three email columns arrive in the order the operator sees them on screen --
 * services/import-csv.ts's resolveMapping sorts them anyway, and agreeing with
 * it here means the value the page validates is the value the server builds.
 */
export function mappingFrom(
  choices: MappingChoices, options: { delimiter?: string; owner?: string } = {},
): CsvMapping {
  const entries = Object.keys(choices)
    .map((key) => Number(key))
    .sort((a, b) => a - b)
    .flatMap((column) => {
      const field = choices[column];
      return field === undefined || field === "" ? [] : [{ column, field }];
    });
  return {
    entries,
    ...(options.delimiter !== undefined && options.delimiter !== ""
      ? { delimiter: options.delimiter }
      : {}),
    ...(options.owner !== undefined && options.owner !== "" ? { owner: options.owner } : {}),
  };
}

/**
 * THE REASON THE PREVIEW BUTTON IS OFF AT THE MAPPING STEP, or null.
 *
 * THE RULE IS csvMappingProblem AND NOT A SECOND ONE. That function is
 * @conduit/shared's for exactly this: the page disables its control on it and
 * services/import-csv.ts refuses a mapping that arrives anyway, on the
 * precedent passphraseProblem and installNameMatches already set. Two
 * comparisons that agree today are two that can stop agreeing, and the half
 * that drifted would be the one that let an operator spend five minutes on a
 * mapping the server then threw out.
 *
 * ITS SENTENCE IS SHOWN AS WRITTEN, capitalised for a line under a control. The
 * server answers a mapping that arrives anyway with the identical text, so the
 * two refusals read as one answer rather than as two phrasings of one rule.
 */
export function mappingBlocked(input: {
  mapping: CsvMapping;
  columnCount: number;
  busy: boolean;
  running: boolean;
}): string | null {
  if (input.running) return null;
  if (input.busy) {
    return "One thing at a time. This is waiting for the operation already running.";
  }
  const problem = csvMappingProblem(input.mapping, input.columnCount);
  if (problem === null) return null;
  return problem.charAt(0).toUpperCase() + problem.slice(1);
}

// ---------------------------------------------------------------------------
// What went wrong
// ---------------------------------------------------------------------------

/**
 * WHICH APPLY FAILURES LEAVE THE PREVIEW USABLE, as an explicit set.
 *
 * THIS IS A PROPERTY OF routes/import.ts's GUARD ORDER AND NOT A GUESS, exactly
 * as settings-data-lib.ts's APPLY_KEEPS_THE_PREVIEW is a property of
 * routes/restore.ts's. That handler looks the session up but does NOT take it
 * until the body has parsed and the plan's kind has been checked, so everything
 * refused before `intakeSessions.use` leaves the operator's upload where it is.
 *
 * EVERYTHING NOT LISTED IS TREATED AS CONSUMED, which is the safe direction for
 * the offer this page makes: `use` disposes of the staging in a `finally`, so
 * every outcome past it means the staged file is gone and the plan id would
 * answer 404. Offering "Import" again against it would read as a second,
 * different failure.
 *
 * `restore_in_progress` IS IN IT AND IS NOT A MISNOMER. app.ts's write gate
 * refuses every unsafe METHOD while a restore runs, and it does so in an
 * onRequest hook -- before this route's handler exists. An import apply refused
 * there has touched nothing at all.
 */
const APPLY_KEEPS_THE_PREVIEW: ReadonlySet<string> = new Set([
  // requireUser, which runs FIRST in the handler.
  "unauthenticated",
  // The strict body schema, before the session is looked up.
  "validation",
  // app.ts's write gate, before the handler runs at all.
  "restore_in_progress",
]);

/** Whether a failed apply left the preview on the server. */
export function applyKeptTheImportPreview(error: unknown): boolean {
  return error instanceof ApiError && APPLY_KEEPS_THE_PREVIEW.has(error.code);
}

/**
 * WHETHER THE COLUMN MAPPING IS STILL WORTH ANYTHING AFTER A FAILURE.
 *
 * A SEPARATE QUESTION FROM THE ONE ABOVE, and the reason it is separate is the
 * decision services/import-csv.ts asked the routes task to carry out: "a routes
 * task should keep the operator's mapping in front of them across a refused
 * apply, because nothing about the mapping became untrue -- only the counts
 * did." A changed-world refusal CONSUMES the plan and does NOT invalidate the
 * mapping, so the two answers differ on exactly the case that matters most.
 *
 * THE ONLY THING THAT MAKES A MAPPING UNTRUE IS A DIFFERENT FILE, because a
 * mapping is a list of column POSITIONS. That is `import_csv_file_changed`, and
 * it is the one code here that sends the operator back to the beginning.
 */
export function failureKeepsTheMapping(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    // A REQUEST THAT DID NOT COME BACK KEEPS IT. Nothing about the columns
    // depends on whether a response arrived, and throwing away five minutes of
    // somebody's work on the strength of a dropped connection would be this
    // page choosing the expensive guess.
    return true;
  }
  return error.code !== "import_csv_file_changed";
}

/**
 * WHAT WENT WRONG, IN WORDS SOMEBODY CAN ACT ON.
 *
 * Branching on `code` and never on message text, which is api.ts's rule for
 * ApiError. Where the server's own message is already the actionable sentence
 * it is passed through -- the engines write their refusals for a person to
 * read, and both changed-world messages say what to do next in their own words.
 *
 * `phase` CHANGES EXACTLY ONE ANSWER, and unlike the restore's it is not the
 * dangerous one. A preview writes nothing, so "nothing was changed" is a fact.
 * An apply that did not come back may have committed -- but its plan is spent
 * either way, so the honest instruction is to look before importing again
 * rather than to freeze.
 */
export function importProblem(error: unknown, phase: "preview" | "apply"): string {
  const unknownOutcome = phase === "preview"
    ? "The preview did not come back. Nothing was changed -- a preview never writes to the "
      + "database. Check the connection and try again."
    : "This page cannot say whether the import finished, and the preview is used up either "
      + "way. Reload the page and look at your companies and contacts before importing the "
      + "same file again, or you may end up with two of everything.";

  if (error instanceof ResponseShapeError) {
    return phase === "preview" ? error.message : `${error.message} ${unknownOutcome}`;
  }
  if (!(error instanceof ApiError)) return unknownOutcome;
  switch (error.code) {
    case "import_busy":
      // THE ONE STATE THIS PAGE CANNOT ALWAYS GET ITSELF OUT OF, and the answer
      // is settings-data-lib.ts's for the same shape: a preview is reachable
      // only from the page that made it, so "finish or cancel it first" is an
      // instruction a reload or a second tab cannot follow. The exits that
      // always work are named instead.
      return `${error.message}. That upload may be an import or a restore, and it may have `
        + "been made in another tab or before this page was reloaded -- in which case this "
        + "page cannot cancel it. It is deleted on its own within half an hour, and a "
        + "restart of Conduit clears it immediately.";
    case "import_file_refused":
    case "import_disk_space":
    case "import_tool_missing":
    case "too_large":
    case "import_owner_unknown":
    case "validation":
      // The server's own sentence is the actionable one in all six: which file
      // it was, how much space is short, which package is missing, what the
      // limit is, that the owner is not a user here, which field was wrong.
      return error.message;
    case "import_csv_file_changed":
      return `${error.message} Nothing has been imported.`;
    case "import_changed":
    case "import_csv_changed":
      // WHOLE, and this is the pair the whole surface turns on. Both messages
      // are the engines' own and both already say that NOTHING was imported and
      // what to do next -- and the CSV one says the thing this page then has to
      // act on: the column mapping is unaffected.
      return error.message;
    case "import_plan_unknown":
      return "That preview is not available any more, so nothing was done. A preview lasts "
        + "half an hour and is thrown away once it is used. Upload the file again.";
    case "restore_in_progress":
      // app.ts's write gate. The name is the restore's rather than this
      // pipeline's, and the message is the gate's own, which says what is
      // happening in the operator's words.
      return `${error.message}. Nothing has been imported; try again when it has finished.`;
    case "import_failed":
      return `${error.message} Nothing was imported: the whole of an import runs in one `
        + "transaction, and it has been rolled back.";
    case "unauthenticated":
      // routes/helpers.ts's requireUser, which runs before everything else. Its
      // own message is about a missing SSOwat header and means nothing here.
      return "This browser is not signed in to Conduit any more, so nothing was done. "
        + "Reload the page and sign in again.";
    default:
      // THE DEFAULT IS NOT A PASS-THROUGH, and that is what makes every arm
      // above an instrument rather than documentation. settings-data-lib.ts
      // records why: a bare `return error.message` means a case label can be
      // deleted from this switch without any test noticing, and three real
      // codes reach a default like this with nothing useful in them -- app.ts
      // answers `internal_error` with NO message, and api.ts falls back to
      // code "unknown" with "POST /import/csv/apply failed with 504" whenever
      // the body is not JSON, which is what nginx returns on a 413, a 502 or a
      // 504.
      return error.message === error.code
        ? unknownOutcome
        : `${error.message} ${unknownOutcome}`;
  }
}
