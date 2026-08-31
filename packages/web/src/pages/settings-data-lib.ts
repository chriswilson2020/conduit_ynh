import { passphraseProblem } from "@conduit/shared";
import type { BackupPreflight } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";

/**
 * The Settings -> Export and backup page's pure logic, kept out of the page so
 * it can be unit-tested without a DOM -- the same split settings-mail-lib.ts
 * and inbox-lib.ts already make, and for the same reason: this package's vitest
 * environment is `node`, so what is not extracted is only ever exercised by
 * Playwright.
 *
 * WHAT IS HERE IS THE PART THAT DECIDES, and on this page that is nearly all of
 * it: whether a passphrase can be used, what a failed download means in words,
 * and whether a backup is going to take long enough to warn somebody about.
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
    return `There is not enough free space to build a backup: it needs about `
      + `${formatBytes(preflight.requiredBytes)} and ${formatBytes(preflight.availableBytes)} is free. `
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
