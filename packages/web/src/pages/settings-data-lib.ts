import { installNameMatches, passphraseProblem, planIsApplicable } from "@conduit/shared";
import type { BackupPreflight, PlanUnit, PlanView } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";

/**
 * The Settings -> Export, backup and restore page's pure logic, kept out of the
 * page so it can be unit-tested without a DOM -- the same split
 * settings-mail-lib.ts and inbox-lib.ts already make, and for the same reason:
 * this package's vitest environment is `node`, so what is not extracted is only
 * ever exercised by Playwright.
 *
 * WHAT IS HERE IS THE PART THAT DECIDES, and on this page that is nearly all of
 * it: whether a passphrase can be used, what a failed download means in words,
 * whether a backup is going to take long enough to warn somebody about, and --
 * since 7.7 -- whether a restore may be confirmed, and which restore failures
 * leave the operator's upload usable for a second try.
 *
 * THE THIRD ARTEFACT DOES NOT SHARE THE FIRST TWO'S FUNCTIONS, deliberately.
 * `downloadProblem` and `restoreProblem` look alike and are not: one describes
 * a file that did not arrive, the other a database that may or may not still
 * exist. Merging them would put "check the connection and try again" in front
 * of somebody whose restore stopped half way.
 */

/**
 * WHY THERE IS A SECOND PASSPHRASE FIELD.
 *
 * There is NO RECOVERY PATH. Conduit never stores the passphrase, never logs
 * it and never writes it to disk, which is the property that makes the archive
 * safe to keep in cloud storage and also means a typo produces a file of random
 * bytes that nobody -- including the person who made it -- can ever open. The
 * mistake is not discovered at the keyboard; it is discovered on the day the
 * backup is needed.
 *
 * A repeat field is the only thing on this page that can catch that, and it is
 * why the two fields are compared as typed: no trim, no case folding. 7z takes
 * the passphrase as given, leading and trailing spaces included (measured by
 * Task 2), so "secret " and "secret" are two different passphrases and this
 * must say so rather than quietly accepting one for the other.
 */
export interface BackupFormState {
  passphrase: string;
  repeat: string;
}

export const EMPTY_BACKUP_FORM: BackupFormState = { passphrase: "", repeat: "" };

/**
 * The one reason this form cannot be submitted, or null.
 *
 * THE CHARACTER RULE IS THE SERVER'S OWN, imported rather than restated -- see
 * @conduit/shared's passphrase.ts. The page's job is to say it EARLY and say
 * WHY, next to the field, while the character is still on the screen; the
 * route's 400 is the control and this is the message. A UI that refused mutely,
 * or that let the request go and rendered "validation" back, would be the
 * failure this codebase has refused to ship three times.
 *
 * `touched` exists so an untouched form is not accused of being empty. A page
 * that opens with a red "a passphrase is required" under an empty box is
 * shouting at somebody who has not done anything yet -- but the button must
 * still be disabled, so the two answers are separated: the button reads
 * `canSubmitBackup`, the message reads this.
 */
export function backupFormProblem(state: BackupFormState, touched: boolean): string | null {
  if (state.passphrase === "") {
    return touched ? "Type a passphrase. A backup is never written unencrypted." : null;
  }
  const problem = passphraseProblem(state.passphrase);
  if (problem !== null) {
    // Capitalised for a sentence under a field. The server's wording is kept
    // otherwise, so the two refusals read as one answer.
    return problem.charAt(0).toUpperCase() + problem.slice(1) + ".";
  }
  if (state.repeat === "") {
    return touched ? "Type the passphrase again. There is no way to recover it later." : null;
  }
  if (state.repeat !== state.passphrase) {
    return "The two passphrases are not the same. They are compared exactly, including spaces.";
  }
  return null;
}

/** Whether the backup button may be pressed at all. */
export function canSubmitBackup(state: BackupFormState): boolean {
  return backupFormProblem(state, true) === null;
}

/**
 * WHAT WENT WRONG, IN WORDS SOMEBODY CAN ACT ON.
 *
 * Branching on `code` and never on message text, which is the rule api.ts
 * states for ApiError: the message carries interpolated values and is free to
 * change. Where the server's own message is already the actionable sentence --
 * the disk pre-flight's two byte counts, the missing package's name -- it is
 * passed through rather than replaced by a worse paraphrase.
 *
 * THE 401 IS THE INTERESTING ONE. It arrives in two shapes and they mean
 * opposite things: `reauth_failed` is "that password was wrong", which the
 * person can fix by retyping; `reauth_required` is "no valid ticket reached the
 * server", which after a successful re-authentication means the ticket was
 * spent or expired between the prompt and the click. Telling somebody to check
 * their password when the real answer is "that took more than five minutes"
 * would send them looking in the wrong place.
 */
export function downloadProblem(error: unknown): string {
  if (error instanceof ResponseShapeError) return error.message;
  if (!(error instanceof ApiError)) {
    return "The download did not start. Check the connection and try again.";
  }
  switch (error.code) {
    case "reauth_required":
      return "That confirmation is no longer valid -- a ticket is good for one download "
        + "and expires after five minutes. Confirm your password again.";
    case "reauth_failed":
      return "That password was not accepted. Nothing was downloaded.";
    case "reauth_throttled":
      return error.message;
    case "reauth_unavailable":
      return "Your password could not be checked right now, so nothing was downloaded. "
        + "That is a server problem rather than a wrong password; try again shortly.";
    case "export_busy":
    case "backup_busy":
      return "Another download is already running. Only one at a time is allowed, "
        + "because two would want the same memory and the same disk.";
    case "backup_tool_missing":
    case "backup_key_missing":
    case "backup_disk_space":
    case "validation":
      return error.message;
    case "backup_failed":
      return "The backup could not be produced. The server log has the detail; "
        + "nothing was written to your machine.";
    default:
      return error.message;
  }
}

/** Bytes as a round figure a person reads, never as a precise one they do not. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? "TB"}`;
}

/**
 * A duration in the units somebody waiting would use.
 *
 * Rounded UP to the next minute above a minute, because this figure is only
 * ever shown before a wait: rounding a 4-minute-50 wait down to "4 minutes" is
 * the direction that produces the reload and the second backup.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.max(seconds, 1))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${String(hours)} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The sentence shown before a backup starts, or null when there is nothing
 * worth interrupting anybody with.
 *
 * THIS IS HALF OF CHRIS'S RULING OF 31 AUG and the other half is in
 * conf/nginx.conf. The backup cannot stream: the whole archive is built before
 * the first byte, so from the browser a long backup and a hung one look
 * identical. Raising the proxy timeout buys the headroom; this stops the wait
 * being a surprise, which is the part a timeout cannot fix.
 *
 * THREE STATES, IN ORDER OF SEVERITY, and the disk comes first because it is
 * the one that will not work at all:
 *
 *   - not enough disk    -- the pre-flight will refuse, and it says so HERE
 *                           rather than after several minutes of dumping;
 *   - beyond the proxy   -- it would run past what nginx will wait for, so it
 *                           would 504 with nothing to show. The estimate is a
 *                           prediction, so this is a warning and not a refusal:
 *                           the archive may still finish, and refusing to try
 *                           on the strength of an estimate would be worse;
 *   - simply long        -- worth a number, not worth a colour.
 */
export function preflightWarning(preflight: BackupPreflight): string | null {
  if (!preflight.enoughDisk) {
    // THE SHORTFALL, NOT THE FREE SPACE. The route answers without a password
    // -- a warning has to come before the commitment it informs -- so the
    // server's free disk is deliberately not in its response at all. What an
    // operator needs is how much to clear, and that is what this says.
    return `There is not enough free space to build a backup: it needs about `
      + `${formatBytes(preflight.shortfallBytes)} more than is free `
      + `(the whole archive needs about ${formatBytes(preflight.requiredBytes)}). `
      + `Free some space and reload this page.`;
  }
  if (preflight.estimatedSeconds > preflight.timeoutSeconds) {
    return `This backup is estimated at ${formatDuration(preflight.estimatedSeconds)}, which is longer `
      + `than the ${formatDuration(preflight.timeoutSeconds)} the web server will wait. It may well fail `
      + `part way through. Taking one from the server's own command line avoids the wait entirely.`;
  }
  if (preflight.slow) {
    return `This backup is estimated at ${formatDuration(preflight.estimatedSeconds)} -- `
      + `${formatBytes(preflight.databaseBytes + preflight.blobBytes)} of database and files. `
      + `Nothing is downloaded until it is finished, so the page will look idle while it works. `
      + `Leave this tab open.`;
  }
  return null;
}

/**
 * How severe the warning is, so the page can colour it without re-deriving the
 * reasoning. Returns null exactly when preflightWarning does.
 *
 * A SEPARATE FUNCTION RATHER THAN A SECOND RETURN VALUE because the page needs
 * one of them in a className and the other in a text node, and a tuple would
 * have both call sites destructuring something they half-use. The two are held
 * together by the test that asserts they agree on every case.
 */
export function preflightSeverity(preflight: BackupPreflight): "blocking" | "warning" | "note" | null {
  if (!preflight.enoughDisk) return "blocking";
  if (preflight.estimatedSeconds > preflight.timeoutSeconds) return "warning";
  if (preflight.slow) return "note";
  return null;
}

// ---------------------------------------------------------------------------
// PHASE 7.7: THE RESTORE
// ---------------------------------------------------------------------------

/**
 * WHAT IS TYPED BEFORE A PREVIEW CAN BE ASKED FOR.
 *
 * NO REPEAT FIELD, AND THE ASYMMETRY WITH THE BACKUP FORM IS DELIBERATE. The
 * backup's second field exists because a mistyped passphrase there is
 * discovered on the day the backup is needed and there is no recovery path.
 * Here the passphrase either opens an archive that already exists or it does
 * not, and the answer comes back in seconds. A repeat field would be asking
 * somebody to prove they can type the same thing twice when the archive itself
 * is about to tell them.
 */
export interface RestoreFormState {
  file: File | null;
  passphrase: string;
}

export const EMPTY_RESTORE_FORM: RestoreFormState = { file: null, passphrase: "" };

/**
 * The one reason a preview cannot be asked for, or null.
 *
 * THE CHARACTER RULE IS THE SERVER'S OWN, imported rather than restated -- the
 * same arrangement backupFormProblem has, and the same reason. Only the
 * EMPTY-STRING sentence is written here, because @conduit/shared's is about
 * writing a backup ("a backup is never written unencrypted") and this form is
 * about opening one that already exists.
 *
 * `touched` exists for the reason it does above: a page that opens with a red
 * message under an empty box is shouting at somebody who has not done anything
 * yet. The button is still off, and restorePreviewBlocked says why beside it.
 */
export function restoreFormProblem(state: RestoreFormState, touched: boolean): string | null {
  if (state.file === null) {
    return touched ? "Choose the .7z backup you want to restore." : null;
  }
  if (state.passphrase === "") {
    return touched
      ? "Type the passphrase this backup was written with. Conduit cannot open it without one."
      : null;
  }
  const problem = passphraseProblem(state.passphrase);
  if (problem !== null) {
    // Capitalised for a sentence under a field, and otherwise the server's own
    // words, so the two refusals read as one answer.
    return problem.charAt(0).toUpperCase() + problem.slice(1) + ".";
  }
  return null;
}

/** Whether the preview button may be pressed at all. */
export function canPreviewRestore(state: RestoreFormState): boolean {
  return restoreFormProblem(state, true) === null;
}

/**
 * THE REASON THE PREVIEW BUTTON IS OFF, IN WORDS, or null when it is on.
 *
 * NO CONTROL IS EVER DISABLED FOR A REASON NOBODY CAN SEE. That is the rule
 * v1.2.2 settled and this codebase has now declined to ship a breach of four
 * times, and here it has a sharper edge than usual: the control being disabled
 * is the one an operator reaches for when their install is already broken.
 */
export function restorePreviewBlocked(
  state: RestoreFormState, busy: boolean, running: boolean,
): string | null {
  if (running) return null;
  // NAMES NO OPERATION, AND A REVIEW IS WHY. This used to say "waiting for the
  // download that is running", and `busy` is also true while this page is
  // checking a password, applying a restore or cancelling a preview -- so on
  // three of the five it named something that was not happening. A visible
  // WRONG reason is worse than a vague one; the rule is that the operator can
  // see why, not that the page guesses which.
  if (busy) return "One thing at a time. This is waiting for the operation already running.";
  if (state.file === null) return "Choose a backup file to enable this.";
  if (!canPreviewRestore(state)) return "Fill in the passphrase to enable this.";
  return null;
}

/**
 * THE REASON THE RESTORE BUTTON IS OFF, IN WORDS, or null when it is on.
 *
 * THE NAME COMPARISON IS @conduit/shared's installNameMatches AND NOT A SECOND
 * ONE. routes/restore.ts calls the same function and its 400 is the control;
 * this exists so that a typo does not cost a re-authentication ticket, because
 * a ticket is single-use and that route spends it before it ever looks at the
 * name. Two implementations of one comparison is the shape this phase's review
 * found five defects in, so there is one function and two callers.
 *
 * `installName === null` IS NOT A TYPO CASE AND MUST NOT READ AS ONE. The
 * server could not name its own database and will answer 503 to any apply at
 * all; a field nobody could satisfy, with "that is not the name" under it,
 * would send an operator looking for a spelling.
 */
export function restoreConfirmBlocked(input: {
  plan: PlanView;
  installName: string | null;
  typedName: string;
  passphrase: string;
}): string | null {
  if (input.installName === null) {
    return "This install's database cannot be named from its configuration, so a restore "
      + "cannot be confirmed by typing it. Nothing typed here will work, and an "
      + "administrator needs to look at the server's configuration.";
  }
  if (!planIsApplicable(input.plan)) {
    return "This backup cannot be restored. The reason is above.";
  }
  if (input.passphrase === "") {
    return "Type the archive passphrase again to enable this.";
  }
  // THE SHARED RULE APPLIES TO THIS FIELD TOO, and a review found it missing.
  // Neither this function nor routes/restore.ts's applyRequestSchema used to
  // check it here -- the schema bounds the length and nothing else -- so a
  // passphrase pasted with a line break in it reached the scrypt proof, failed
  // it, and the operator was told "that is not the passphrase this backup was
  // opened with" about a string that WAS the right passphrase carrying an
  // invisible character. The upload field one screen up refuses exactly that
  // and explains what 7z does with it; the same rule has to answer the same
  // way at both ends of the same page.
  const problem = passphraseProblem(input.passphrase);
  if (problem !== null) {
    return problem.charAt(0).toUpperCase() + problem.slice(1) + ".";
  }
  if (!installNameMatches(input.typedName, input.installName)) {
    return `Type ${input.installName} exactly to enable this.`;
  }
  return null;
}

/**
 * WHICH APPLY FAILURES LEAVE THE PREVIEW USABLE, as an explicit set.
 *
 * THIS IS A PROPERTY OF routes/restore.ts's GUARD ORDER AND NOT A GUESS. That
 * handler puts everything which can refuse WITHOUT consuming anything first --
 * its own comment says so in as many words -- and the session is looked up but
 * not taken until there is nothing left to refuse. So a mistyped name or a
 * mistyped passphrase leaves the operator with their upload and a second try
 * rather than a three-gigabyte re-upload, and the page must not throw that away
 * on their behalf.
 *
 * EVERYTHING NOT LISTED IS TREATED AS CONSUMED, which is the safe direction for
 * the offer this page makes: once `intakeSessions.use` has taken the session it
 * disposes of it in a `finally`, so every outcome that route's restoreFailure
 * reports means the staged archive is gone. Offering a "try again" button
 * against a plan id that no longer resolves would answer 404 and read as a
 * second, different failure.
 *
 * THE 401s ARE IN IT, and in practice they are the case that matters most: the
 * gate runs before anything else in the handler, so a password typed wrong at
 * the second prompt costs nothing but the password.
 */
const APPLY_KEEPS_THE_PREVIEW: ReadonlySet<string> = new Set([
  // Refused by requireUser, which runs FIRST in the handler. A review found
  // this missing: without it a request that never reached the gate was treated
  // as one that had consumed a plan.
  "unauthenticated",
  // Refused by requireReauth, before the body is even parsed.
  "reauth_required", "reauth_failed", "reauth_throttled", "reauth_unavailable",
  // Refused by the body schema, before the session is looked up.
  "validation",
  // Refused because the server cannot name its own database. Before the lookup.
  "restore_unnameable",
  // Looked up, NOT taken. These two are the whole point of this set.
  "restore_name_mismatch", "restore_passphrase_mismatch",
  // The write gate refused, or the drain ran out. Neither consumes the plan,
  // and the second one's own message says to try again in a moment -- which is
  // only true if the preview is still there to try it with.
  "restore_in_progress", "restore_writes_in_flight",
]);

/**
 * Whether a failed apply left the preview on the server.
 *
 * DEFAULTS TO FALSE, including for a network error, and the page says so rather
 * than pretending to know. A request that never came back may still have run.
 */
export function applyKeptThePreview(error: unknown): boolean {
  return error instanceof ApiError && APPLY_KEEPS_THE_PREVIEW.has(error.code);
}

/**
 * WHAT WENT WRONG, IN WORDS SOMEBODY CAN ACT ON.
 *
 * Branching on `code` and never on message text, which is api.ts's rule for
 * ApiError. Where the server's own message is already the actionable sentence
 * it is passed through WHOLE rather than paraphrased, and on this route that is
 * not a convenience: routes/restore.ts deliberately echoes services/restore.ts's
 * failure messages in full because they name the safety backup's path on disk
 * and print the commands that put the install back. A paraphrase would be this
 * page throwing away the only thing standing between an operator and a
 * half-restored database.
 *
 * `phase` CHANGES EXACTLY ONE ANSWER and it is the one that matters: a request
 * that did not come back. During a preview nothing was destroyed and saying so
 * is honest. During an apply nobody knows, and a page that said "nothing
 * happened" would be guessing about a database.
 */
export function restoreProblem(error: unknown, phase: "preview" | "apply"): string {
  // THE ONE SENTENCE THAT MATTERS WHEN NOBODY KNOWS WHAT HAPPENED, and every
  // path that cannot say more ends here.
  //
  // A PREVIEW DESTROYS NOTHING BY CONSTRUCTION -- inspect writes nothing to the
  // database and takes no backup -- so "nothing was changed" is a fact rather
  // than an optimism. An apply that did not answer is the opposite: it may have
  // run, and a page that guessed would be guessing about a database.
  const unknownOutcome = phase === "preview"
    ? "The preview did not come back. Nothing was changed and nothing was destroyed -- a "
      + "preview never writes to the database. Check the connection and try again."
    : "This page cannot say whether the restore finished. Do NOT start another one. Look at "
      + "the server's log, and at whether Conduit is still answering, before doing anything "
      + "else -- and if a safety backup was written, it is in Conduit's data directory.";

  // A SHAPE ERROR ON AN APPLY IS NOT A PARSING COMPLAINT, and a review found it
  // being reported as one. restoreOutcomeSchema declares `restored: z.literal(true)`
  // precisely so that a 200 saying otherwise fails to parse rather than
  // rendering as a success banner -- which means this branch fires on a
  // successful HTTP response from a route that has just been running a restore.
  // The shape is worth naming, but not on its own.
  if (error instanceof ResponseShapeError) {
    return phase === "preview" ? error.message : `${error.message} ${unknownOutcome}`;
  }
  if (!(error instanceof ApiError)) return unknownOutcome;
  switch (error.code) {
    case "reauth_required":
      return "That confirmation is no longer valid -- a confirmation is good for one request "
        + "and expires after five minutes. Type your password again.";
    case "reauth_failed":
      return "That password was not accepted. Nothing was uploaded, changed or destroyed.";
    case "reauth_throttled":
    case "restore_writes_in_flight":
    case "restore_in_progress":
      // The server's own sentence is the actionable one in all three: how long
      // to wait, and how many requests were still writing.
      return error.message;
    case "restore_busy":
      // THE ONE STATE THIS PAGE CANNOT GET ITSELF OUT OF, so it says what is
      // true rather than repeating an instruction that may be impossible. The
      // server says "apply or cancel it first" -- and a preview is reachable
      // only through the id the page that made it is holding, which a reload or
      // a second tab does not have. There is no route that cancels "whatever is
      // waiting", deliberately: it is addressed by id and bound to its owner.
      // So the honest answer is the other exit, which always works.
      return `${error.message} If that preview was made in another tab, or before this page `
        + "was reloaded, this page has no way to cancel it -- a preview is reachable only "
        + "from the page that made it. It is deleted on its own within half an hour, and a "
        + "restart of Conduit clears it immediately.";
    case "reauth_unavailable":
      return "Your password could not be checked right now, so nothing happened. That is a "
        + "server problem rather than a wrong password; try again shortly.";
    case "restore_archive_refused":
    case "too_large":
    case "restore_disk_space":
    case "restore_tool_missing":
    case "restore_unnameable":
    case "validation":
      return error.message;
    case "restore_plan_unknown":
      return "That preview is not available any more, so nothing was done. A preview lasts "
        + "half an hour and is thrown away once it is used. Upload the backup again.";
    case "restore_name_mismatch":
    case "restore_passphrase_mismatch":
      // Echoed rather than rewritten -- the name mismatch's body carries the
      // name -- with the one fact the server's sentence does not carry: the
      // upload survived, so this is a retype and not a re-upload.
      return `${error.message} Nothing has been changed, and your upload is still here.`;
    case "restore_safety_backup_failed":
      return `${error.message} The restore did NOT start, so nothing has been destroyed.`;
    case "restore_database_changed":
    case "restore_load_failed":
      return `${error.message} Your database is exactly as it was.`;
    case "restore_half_applied":
    case "restore_unexpected_result":
    case "restore_inventory_mismatch":
    case "restore_mail_key_failed":
    case "restore_migration_failed":
    case "restore_unexpected_migrations":
      // WHOLE, and this is the narrow exception to every other 5xx on this
      // page. These messages name the safety backup and print the commands that
      // put the install back.
      return error.message;
    case "restore_failed":
      return `${error.message} Do not start another restore until somebody has read that `
        + "log: this page cannot tell you what state the database is in.";
    case "unauthenticated":
      // routes/helpers.ts's requireUser, which runs before everything else in
      // both handlers. Its own message is about a missing SSOwat header and
      // means nothing to an operator.
      return "This browser is not signed in to Conduit any more, so nothing was done. "
        + "Reload the page and sign in again.";
    default:
      // THE DEFAULT IS NOT A PASS-THROUGH, and that is what makes every arm
      // above an instrument rather than documentation. It used to be
      // `return error.message`, which meant a case label could be deleted from
      // this switch without any test noticing -- and worse, three real codes
      // landed here with no guidance at all: app.ts answers `internal_error`
      // with NO message (so the operator was shown the word "internal_error"
      // as the whole account of what happened to their database), and api.ts
      // falls back to code "unknown" with "POST /restore/apply failed with 504"
      // whenever the body is not JSON -- which is exactly what nginx returns on
      // a 413, a 502 or a 504, and this change adds nginx blocks.
      //
      // So an unrecognised code says what IS known -- the server's own text,
      // when there is any beyond the code itself -- and then says plainly that
      // the outcome is unknown.
      return error.message === error.code
        ? unknownOutcome
        : `${error.message} ${unknownOutcome}`;
  }
}

/**
 * A count and its unit, as a person reads them.
 *
 * THE UNIT IS THE PLAN'S OWN. @conduit/shared's PlanUnit is a closed set for
 * exactly this: the page renders a unit as a word next to a number, and an open
 * string would let the server say "record" where the page said "row". The
 * plural is the only thing added here, and mail.key is why `key` is in the set
 * at all -- one key, never keys.
 */
export function planCountLabel(count: number, unit: PlanUnit): string {
  const word = count === 1 ? unit : `${unit}s`;
  return `${count.toLocaleString("en-GB")} ${word}`;
}
