import { describe, expect, it } from "vitest";
import type { BackupPreflight, PlanEffectView, PlanView } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";
import {
  EMPTY_BACKUP_FORM, EMPTY_RESTORE_FORM, applyKeptThePreview, backupFormProblem,
  canPreviewRestore, canSubmitBackup, downloadProblem, formatBytes, formatDuration,
  planCountLabel, preflightSeverity, preflightWarning, restoreConfirmBlocked,
  restoreFormProblem, restorePreviewBlocked, restoreProblem,
} from "./settings-data-lib";

const GOOD = "correct horse battery staple";

describe("backupFormProblem", () => {
  it("says nothing about an untouched, empty form", () => {
    // A page that opens with a red "a passphrase is required" is shouting at
    // somebody who has not done anything yet.
    expect(backupFormProblem(EMPTY_BACKUP_FORM, false)).toBeNull();
    // But the button is still off, and for a visible reason -- see the two
    // being separate in canSubmitBackup.
    expect(canSubmitBackup(EMPTY_BACKUP_FORM)).toBe(false);
  });

  it("asks for a passphrase once the form has been touched", () => {
    expect(backupFormProblem(EMPTY_BACKUP_FORM, true))
      .toContain("never written unencrypted");
  });

  it("REFUSES A NEWLINE AND SAYS WHY, rather than rejecting mutely", () => {
    // The requirement, and the reason the check is here and not only at the
    // API boundary: 7z reads one line, so this passphrase would encrypt the
    // archive with "abc" and report success -- with no recovery path.
    const problem = backupFormProblem({ passphrase: "abc\ndef", repeat: "abc\ndef" }, true);
    expect(problem).not.toBeNull();
    expect(problem).toContain("line break");
    expect(problem).toContain("7z reads it up to the first line break");
    expect(canSubmitBackup({ passphrase: "abc\ndef", repeat: "abc\ndef" })).toBe(false);
  });

  it("refuses other control characters the same way", () => {
    for (const bad of ["a\rb", "a\tb", "a\u000Bb", "a\u0000b", "a\u007Fb"]) {
      const state = { passphrase: bad, repeat: bad };
      expect(backupFormProblem(state, true), JSON.stringify(bad)).toContain("control characters");
      expect(canSubmitBackup(state)).toBe(false);
    }
  });

  it("shares the server's own wording, so the two refusals are one answer", () => {
    // Capitalised and full-stopped for a sentence under a field, and otherwise
    // the string services/backup.ts throws.
    const problem = backupFormProblem({ passphrase: "a\nb", repeat: "a\nb" }, true) ?? "";
    expect(problem.startsWith("The passphrase must not contain")).toBe(true);
    expect(problem.endsWith(".")).toBe(true);
  });

  it("asks for the repeat, and refuses a mismatch", () => {
    expect(backupFormProblem({ passphrase: GOOD, repeat: "" }, true))
      .toContain("no way to recover it");
    expect(backupFormProblem({ passphrase: GOOD, repeat: "correct hors" }, true))
      .toContain("not the same");
  });

  it("compares the two EXACTLY, including a trailing space", () => {
    // 7z takes the passphrase as given -- measured -- so "secret " and "secret"
    // are two different passphrases and this must not quietly accept one for
    // the other. Getting this wrong produces an archive that opens with
    // something the operator does not believe they typed.
    expect(backupFormProblem({ passphrase: "secret ", repeat: "secret" }, true))
      .toContain("not the same");
    expect(backupFormProblem({ passphrase: "Secret", repeat: "secret" }, true))
      .toContain("not the same");
    expect(backupFormProblem({ passphrase: " secret ", repeat: " secret " }, true)).toBeNull();
  });

  it("accepts a good pair", () => {
    expect(backupFormProblem({ passphrase: GOOD, repeat: GOOD }, true)).toBeNull();
    expect(canSubmitBackup({ passphrase: GOOD, repeat: GOOD })).toBe(true);
  });
});

describe("downloadProblem", () => {
  it("tells a wrong password and a spent ticket apart", () => {
    // They are both 401 and they mean opposite things. Telling somebody to
    // check their password when the real answer is "that took more than five
    // minutes" sends them looking in the wrong place.
    expect(downloadProblem(new ApiError("x", 401, "reauth_failed")))
      .toContain("was not accepted");
    const stale = downloadProblem(new ApiError("x", 401, "reauth_required"));
    expect(stale).toContain("one download");
    expect(stale).not.toContain("was not accepted");
  });

  it("passes through the server's own actionable sentences unchanged", () => {
    // The disk pre-flight's two byte counts and the missing package's name are
    // already the sentence somebody can act on; a paraphrase would lose them.
    const disk = new ApiError("needs 900MB, 100MB free", 507, "backup_disk_space");
    expect(downloadProblem(disk)).toBe("needs 900MB, 100MB free");
    const tool = new ApiError("7z is not installed: apt install p7zip-full", 503, "backup_tool_missing");
    expect(downloadProblem(tool)).toContain("p7zip-full");
    const validation = new ApiError("the passphrase must not contain line breaks", 400, "validation");
    expect(downloadProblem(validation)).toContain("line breaks");
  });

  it("does not repeat the server's internal detail for a failed build", () => {
    const failed = new ApiError("the server log has the detail", 500, "backup_failed");
    expect(downloadProblem(failed)).toContain("nothing was written to your machine");
  });

  it("explains a busy slot as a limit rather than a fault", () => {
    expect(downloadProblem(new ApiError("busy", 503, "export_busy")))
      .toContain("Only one at a time");
    expect(downloadProblem(new ApiError("busy", 503, "backup_busy")))
      .toContain("Only one at a time");
  });

  it("separates a server that cannot check from a password that is wrong", () => {
    expect(downloadProblem(new ApiError("x", 503, "reauth_unavailable")))
      .toContain("server problem rather than a wrong password");
  });

  it("has something to say about a transport failure and a shape failure", () => {
    expect(downloadProblem(new TypeError("Failed to fetch"))).toContain("Check the connection");
    expect(downloadProblem(new ResponseShapeError("Unexpected response shape")))
      .toContain("Unexpected response shape");
  });

  it("falls back to the server's message for a code it does not know", () => {
    expect(downloadProblem(new ApiError("something new", 418, "brand_new_code")))
      .toBe("something new");
  });
});

describe("formatBytes", () => {
  it("reads as a person would say it", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(367_002_306)).toBe("350 MB");
    expect(formatBytes(7 * 1024 ** 3)).toBe("7.0 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });

  it("does not run off the end of its unit list", () => {
    expect(formatBytes(9 * 1024 ** 6)).toContain("TB");
  });
});

describe("formatDuration", () => {
  it("never says zero seconds for work that is about to happen", () => {
    expect(formatDuration(0)).toBe("1 seconds");
    expect(formatDuration(30)).toBe("30 seconds");
  });

  it("rounds UP into minutes, because this is shown before a wait", () => {
    // Rounding 4m50 down to "4 minutes" is the direction that produces the
    // reload and the second backup.
    expect(formatDuration(60)).toBe("about 1 minute");
    expect(formatDuration(290)).toBe("about 5 minutes");
    expect(formatDuration(3540)).toBe("about 59 minutes");
  });

  it("goes to hours rather than saying 90 minutes", () => {
    expect(formatDuration(3600)).toBe("about 1 hour");
    expect(formatDuration(7200)).toBe("about 2 hours");
  });
});

function preflight(over: Partial<BackupPreflight> = {}): BackupPreflight {
  return {
    databaseBytes: 20 * 1024 ** 2,
    blobBytes: 10 * 1024 ** 2,
    requiredBytes: 200 * 1024 ** 2,
    enoughDisk: true,
    shortfallBytes: 0,
    estimatedSeconds: 2,
    slow: false,
    timeoutSeconds: 3600,
    ...over,
  };
}

describe("preflightWarning", () => {
  it("says nothing about a small, fast backup", () => {
    expect(preflightWarning(preflight())).toBeNull();
    expect(preflightSeverity(preflight())).toBeNull();
  });

  it("warns about a long one, and says the page will look idle", () => {
    // The failure this exists to prevent: nothing downloads until the archive
    // is finished, so a long backup and a hung one look identical.
    const warning = preflightWarning(preflight({ estimatedSeconds: 600, slow: true }));
    expect(warning).toContain("about 10 minutes");
    expect(warning).toContain("look idle");
    expect(preflightSeverity(preflight({ estimatedSeconds: 600, slow: true }))).toBe("note");
  });

  it("warns harder when the estimate runs past what the proxy will wait for", () => {
    const over = preflight({ estimatedSeconds: 5000, slow: true, timeoutSeconds: 3600 });
    const warning = preflightWarning(over) ?? "";
    expect(warning).toContain("longer than");
    expect(warning).toContain("about 1 hour");
    expect(preflightSeverity(over)).toBe("warning");
  });

  it("leads with the disk, because that one will not work at all", () => {
    const full = preflight({
      enoughDisk: false, shortfallBytes: 800 * 1024 ** 2,
      requiredBytes: 900 * 1024 ** 2, estimatedSeconds: 5000, slow: true,
    });
    const warning = preflightWarning(full) ?? "";
    expect(warning).toContain("not enough free space");
    // The SHORTFALL is what an operator acts on, and it is what the server
    // sends: the free-space figure is deliberately absent from the response.
    expect(warning).toContain("800 MB");
    expect(warning).toContain("900 MB");
    expect(preflightSeverity(full)).toBe("blocking");
  });

  it("keeps the message and the severity agreeing on every case", () => {
    // The two are separate functions because the page needs one in a className
    // and the other in a text node; this is what stops them drifting.
    const cases = [
      preflight(),
      preflight({ slow: true, estimatedSeconds: 90 }),
      preflight({ slow: true, estimatedSeconds: 99_999 }),
      preflight({ enoughDisk: false }),
    ];
    for (const value of cases) {
      expect(preflightWarning(value) === null).toBe(preflightSeverity(value) === null);
    }
  });
});

// ---------------------------------------------------------------------------
// PHASE 7.7: THE RESTORE
//
// Everything here is a question about VALUES -- a form, a plan, an error -- so
// none of it needs a browser, a server or an archive. That is the same property
// @conduit/shared's plan.test.ts relies on and it is the reason the plan is a
// value in the first place: the hard cases of a destructive operation are
// assertable without destroying anything.
// ---------------------------------------------------------------------------

const INSTALL = "conduit";

/** A file, without a disk. Node 24 has File globally. */
function upload(name = "conduit-backup-2026-09-01.7z"): File {
  return new File([new Uint8Array([0x37, 0x7a])], name);
}

function effect(overrides: Partial<PlanEffectView> = {}): PlanEffectView {
  return {
    op: "load-dump",
    subject: "the backup's database",
    count: 27,
    unit: "table",
    destroys: false,
    detail: "27 table(s) from the backup replace what was there.",
    ...overrides,
  };
}

function restorePlan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    planId: "22222222-2222-4222-8222-222222222222",
    kind: "restore",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:30:00.000Z",
    source: {
      filename: "conduit-backup-2026-09-01.7z",
      bytes: 1024,
      sha256: "a".repeat(64),
      stagedBytes: 4096,
      memberCount: 4,
    },
    effects: [
      effect({
        op: "destroy-schema", subject: "public, drizzle", count: 2, unit: "schema",
        destroys: true,
        detail: "Everything in this database is dropped: 14204 row(s) in 27 table(s) "
          + "across 2 schema(s).",
      }),
      effect(),
    ],
    findings: [],
    refusal: null,
    ...overrides,
  };
}

function apiError(code: string, message = "server said so", status = 400): ApiError {
  return new ApiError(message, status, code);
}

describe("restoreFormProblem", () => {
  it("says nothing about an untouched, empty form", () => {
    expect(restoreFormProblem(EMPTY_RESTORE_FORM, false)).toBeNull();
    // The button is still off, and restorePreviewBlocked says why beside it.
    expect(canPreviewRestore(EMPTY_RESTORE_FORM)).toBe(false);
  });

  it("asks for a file first, because there is nothing to open without one", () => {
    expect(restoreFormProblem(EMPTY_RESTORE_FORM, true)).toContain("Choose the .7z backup");
  });

  it("asks for the passphrase once a file has been chosen", () => {
    const state = { file: upload(), passphrase: "" };
    expect(restoreFormProblem(state, true)).toContain("passphrase this backup was written with");
    expect(canPreviewRestore(state)).toBe(false);
  });

  it("REFUSES A CONTROL CHARACTER IN THE SERVER'S OWN WORDS", () => {
    // The rule is @conduit/shared's, imported by both sides rather than
    // restated, so the page's refusal and the route's 400 are one answer. This
    // asserts the SHARED sentence rather than a paraphrase of it, which is what
    // would catch the page quietly growing a rule of its own.
    const state = { file: upload(), passphrase: "abc\ndef" };
    const problem = restoreFormProblem(state, true) ?? "";
    expect(problem).toContain("7z reads it up to the first line break");
    expect(problem.startsWith("The passphrase must not contain")).toBe(true);
    expect(problem.endsWith(".")).toBe(true);
    expect(canPreviewRestore(state)).toBe(false);
  });

  it("accepts a file and an ordinary passphrase", () => {
    const state = { file: upload(), passphrase: "correct horse battery staple" };
    expect(restoreFormProblem(state, true)).toBeNull();
    expect(canPreviewRestore(state)).toBe(true);
  });
});

describe("restorePreviewBlocked", () => {
  const ready = { file: upload(), passphrase: "correct horse" };

  it("says nothing while this very operation is the one running", () => {
    expect(restorePreviewBlocked(ready, true, true)).toBeNull();
  });

  it("says something is running WITHOUT naming which, because it cannot know", () => {
    // `busy` covers the password check for this very preview, an apply and a
    // cancel as well as the two downloads. This used to name "the download that
    // is running" and was wrong on three of the five. A visible reason that is
    // false is worse than a vague one.
    const answer = restorePreviewBlocked(ready, true, false) ?? "";
    expect(answer).toContain("One thing at a time");
    expect(answer).not.toContain("download");
  });

  it("names the missing file, and then the missing passphrase, in that order", () => {
    expect(restorePreviewBlocked(EMPTY_RESTORE_FORM, false, false))
      .toContain("Choose a backup file");
    expect(restorePreviewBlocked({ file: upload(), passphrase: "" }, false, false))
      .toContain("Fill in the passphrase");
  });

  it("is silent when the button is on, so nothing is explained that is not happening", () => {
    expect(restorePreviewBlocked(ready, false, false)).toBeNull();
  });
});

describe("restoreConfirmBlocked", () => {
  const base = {
    plan: restorePlan(), installName: INSTALL, typedName: INSTALL, passphrase: "correct horse",
    busy: false, running: false,
  };

  it("lets a complete, correct confirmation through", () => {
    expect(restoreConfirmBlocked(base)).toBeNull();
  });

  it("DOES NOT READ AN UNNAMEABLE INSTALL AS A TYPO", () => {
    // The server will answer 503 to any apply at all. A field nobody could
    // satisfy, with "that is not the name" under it, would send an operator
    // looking for a spelling that does not exist.
    const problem = restoreConfirmBlocked({ ...base, installName: null }) ?? "";
    expect(problem).toContain("cannot be named from its configuration");
    expect(problem).not.toContain("Type ");
  });

  it("refuses a plan the server has already refused", () => {
    const refused = restorePlan({
      effects: [], refusal: { code: "newer-app", message: "from a newer Conduit" },
    });
    expect(restoreConfirmBlocked({ ...base, plan: refused }))
      .toContain("cannot be restored");
  });

  it("asks for the archive passphrase before it complains about the name", () => {
    // The order matters: a person who has typed neither should be told about
    // the field their cursor is in, not sent back up the form.
    expect(restoreConfirmBlocked({ ...base, passphrase: "", typedName: "" }))
      .toContain("archive passphrase again");
  });

  it("NAMES THE INSTALL IN THE REASON, because the name is not a secret", () => {
    expect(restoreConfirmBlocked({ ...base, typedName: "conduit_" }))
      .toBe(`Type ${INSTALL} exactly to enable this.`);
  });

  it("uses @conduit/shared's comparison and not a second one", () => {
    // Trimmed -- a copy-paste picks up whitespace and refusing that teaches
    // nobody anything -- and otherwise exact. Case is NOT folded: every
    // relaxation makes the string easier to produce without having read it,
    // which is the whole property being bought. If this page ever grew a
    // comparison of its own, one of these three would move.
    expect(restoreConfirmBlocked({ ...base, typedName: `  ${INSTALL}\t` })).toBeNull();
    expect(restoreConfirmBlocked({ ...base, typedName: INSTALL.toUpperCase() })).not.toBeNull();
    expect(restoreConfirmBlocked({ ...base, typedName: `${INSTALL}x` })).not.toBeNull();
  });
});

describe("applyKeptThePreview", () => {
  /**
   * THE SET IS A PROPERTY OF routes/restore.ts's GUARD ORDER, so these two
   * lists are the two halves of that handler read as data: everything before
   * the line its own comment draws ("nothing below this line can refuse without
   * consuming the plan"), and everything after it.
   */
  it("keeps the upload for every refusal that happens before the plan is taken", () => {
    for (const code of [
      "reauth_required", "reauth_failed", "reauth_throttled", "reauth_unavailable",
      "validation", "restore_unnameable",
      "restore_name_mismatch", "restore_passphrase_mismatch",
      "restore_in_progress", "restore_writes_in_flight",
    ]) {
      expect(applyKeptThePreview(apiError(code)), code).toBe(true);
    }
  });

  it("gives it up for everything reported after the plan was taken", () => {
    // Once `intakeSessions.use` has the session it disposes of it in a
    // `finally`, so the staged archive is gone whatever happened next.
    for (const code of [
      "restore_plan_unknown", "restore_tool_missing", "restore_safety_backup_failed",
      "restore_database_changed", "restore_load_failed", "restore_half_applied",
      "restore_unexpected_result", "restore_inventory_mismatch", "restore_mail_key_failed",
      "restore_migration_failed", "restore_unexpected_migrations", "restore_failed",
    ]) {
      expect(applyKeptThePreview(apiError(code, "x", 500)), code).toBe(false);
    }
  });

  it("gives it up for a request that never came back, because nobody knows", () => {
    expect(applyKeptThePreview(new TypeError("Failed to fetch"))).toBe(false);
    expect(applyKeptThePreview(new ResponseShapeError("odd shape"))).toBe(false);
    expect(applyKeptThePreview("restore_name_mismatch")).toBe(false);
  });
});

describe("restoreProblem", () => {
  it("TELLS THE TWO PHASES APART WHEN THE REQUEST DID NOT COME BACK", () => {
    // The one answer that differs, and the reason `phase` exists. During a
    // preview nothing was destroyed and saying so is honest; during an apply
    // nobody knows, and a page that said "nothing happened" would be guessing
    // about a database.
    const dropped = new TypeError("Failed to fetch");
    expect(restoreProblem(dropped, "preview")).toContain("Nothing was changed");
    const applying = restoreProblem(dropped, "apply");
    expect(applying).toContain("cannot say whether the restore finished");
    expect(applying).not.toContain("Nothing was changed");
  });

  it("says a mistyped name changed nothing AND that the upload survived", () => {
    // Both halves matter: the first stops a panic, the second stops a
    // re-upload. The server's own sentence carries the name and is kept.
    const answer = restoreProblem(
      apiError("restore_name_mismatch", "type this install's name exactly to confirm: conduit"),
      "apply",
    );
    expect(answer).toContain("conduit");
    expect(answer).toContain("Nothing has been changed");
    expect(answer).toContain("your upload is still here");
  });

  it("says the same about a mistyped passphrase, for the same reason", () => {
    const answer = restoreProblem(apiError("restore_passphrase_mismatch"), "apply");
    expect(answer).toContain("your upload is still here");
  });

  it("PASSES A HALF-APPLIED RESTORE'S MESSAGE THROUGH WHOLE", () => {
    // The narrow exception to every other 5xx on this page. These messages name
    // the safety backup's path and print the commands that put the install
    // back; a paraphrase would throw away the only thing between an operator
    // and a broken database.
    const message = "the restore has HAPPENED and the database is not what it was. The "
      + "safety backup is at /var/lib/conduit/conduit-safety-backup-x.7z. Run: 7z x ...";
    for (const code of [
      "restore_half_applied", "restore_unexpected_result", "restore_inventory_mismatch",
      "restore_mail_key_failed", "restore_migration_failed", "restore_unexpected_migrations",
    ]) {
      expect(restoreProblem(apiError(code, message, 500), "apply"), code).toBe(message);
    }
  });

  it("says the restore did NOT start when the safety backup failed", () => {
    // The distinction the operator most needs and the one a generic 5xx would
    // destroy: this refusal happens before the destructive step.
    const answer = restoreProblem(
      apiError("restore_safety_backup_failed", "could not write the safety backup", 503),
      "apply",
    );
    expect(answer).toContain("did NOT start");
    expect(answer).toContain("nothing has been destroyed");
  });

  it("says the database is untouched when the load failed and rolled back", () => {
    for (const code of ["restore_load_failed", "restore_database_changed"]) {
      expect(restoreProblem(apiError(code, "the load failed", 409), "apply"), code)
        .toContain("exactly as it was");
    }
  });

  it("passes the server's own actionable sentence through where it has one", () => {
    for (const code of [
      "restore_writes_in_flight", "restore_in_progress", "reauth_throttled",
      "restore_archive_refused", "too_large", "restore_disk_space", "restore_tool_missing",
      "restore_unnameable", "validation",
    ]) {
      expect(restoreProblem(apiError(code, "the server's own words"), "preview"), code)
        .toBe("the server's own words");
    }
  });

  it("NAMES THE OTHER EXIT when a preview this page cannot reach is in the way", () => {
    // The one state the surface cannot get itself out of. A preview is
    // addressed by an id, bound to its owner, and held only by the page that
    // made it -- so after a reload, or from a second tab, "apply or cancel it
    // first" is an instruction nobody can follow. Repeating it alone would be a
    // refusal with no way out; the expiry and the restart are the ways out that
    // always work.
    const answer = restoreProblem(
      apiError("restore_busy", "another backup is already uploaded and waiting for a decision; "
        + "apply or cancel it first", 409),
      "preview",
    );
    expect(answer).toContain("apply or cancel it first");
    expect(answer).toContain("no way to cancel it");
    expect(answer).toContain("within half an hour");
    expect(answer).toContain("restart of Conduit clears it");
  });

  it("explains an expired preview rather than echoing a bare 404", () => {
    expect(restoreProblem(apiError("restore_plan_unknown", "gone", 404), "apply"))
      .toContain("half an hour");
  });

  it("reports a shape error as itself, never as a transport problem", () => {
    // Contract drift between API and UI, and never "the request may not have
    // arrived" -- which is the whole reason ResponseShapeError has a type of
    // its own. On a PREVIEW that is the entire answer; the apply case gains a
    // sentence about the outcome and is asserted separately below.
    expect(restoreProblem(new ResponseShapeError("Unexpected response shape"), "preview"))
      .toBe("Unexpected response shape");
    expect(restoreProblem(new ResponseShapeError("Unexpected response shape"), "apply"))
      .toContain("Unexpected response shape");
  });
});

describe("planCountLabel", () => {
  it("agrees with the number in front of it", () => {
    expect(planCountLabel(1, "key")).toBe("1 key");
    expect(planCountLabel(2, "schema")).toBe("2 schemas");
    expect(planCountLabel(0, "file")).toBe("0 files");
  });

  it("groups thousands, because a restore's numbers are big", () => {
    expect(planCountLabel(14204, "row")).toBe("14,204 rows");
  });
});

// ---------------------------------------------------------------------------
// WHAT AN ADVERSARIAL REVIEW OF THIS SURFACE FOUND, held as tests so it cannot
// come back. Each of these names the defect it was written for.
// ---------------------------------------------------------------------------

describe("restoreConfirmBlocked, and the rule that was missing from it", () => {
  const base = {
    plan: restorePlan(), installName: INSTALL, typedName: INSTALL, passphrase: "correct horse",
    busy: false, running: false,
  };

  it("APPLIES THE SHARED PASSPHRASE RULE TO THE CONFIRMATION FIELD TOO", () => {
    // The defect: this checked only for the empty string, and
    // routes/restore.ts's apply schema checks only min and max. So a passphrase
    // pasted with a line break in it reached the scrypt proof, failed it, and
    // the operator was told "that is not the passphrase this backup was opened
    // with" about a string that WAS their passphrase carrying an invisible
    // character. The upload field one screen up refuses exactly that.
    const problem = restoreConfirmBlocked({ ...base, passphrase: "correct\nhorse" }) ?? "";
    expect(problem).toContain("7z reads it up to the first line break");
    // The SHARED sentence, so the two fields on one page answer alike.
    expect(problem.startsWith("The passphrase must not contain")).toBe(true);
  });

  it("still lets an ordinary passphrase with spaces through", () => {
    // The rule allows everything printable, spaces at either end included --
    // and 7z takes the passphrase as given, so a page that trimmed one here
    // would refuse a legitimate archive.
    expect(restoreConfirmBlocked({ ...base, passphrase: "  two words  " })).toBeNull();
  });
});

describe("applyKeptThePreview, and the code that was on the wrong side of it", () => {
  it("KEEPS THE UPLOAD WHEN THE REQUEST NEVER REACHED THE GATE", () => {
    // routes/helpers.ts's requireUser runs FIRST in the apply handler, before
    // re-authentication and long before the session is looked up. Treating its
    // 401 as a consumed plan threw away an upload nothing had touched.
    expect(applyKeptThePreview(apiError("unauthenticated", "no Ynh-User header", 401))).toBe(true);
  });
});

describe("restoreProblem's default arm, which used to be a pass-through", () => {
  it("SAYS THE OUTCOME IS UNKNOWN FOR A CODE IT DOES NOT RECOGNISE", () => {
    // The defect this closes has three real instances, and it is also what made
    // every named arm above unfailable: with `default: return error.message`,
    // deleting any case label changed nothing that any test could see.
    const answer = restoreProblem(apiError("something_new", "the server said this", 500), "apply");
    expect(answer).toContain("the server said this");
    expect(answer).toContain("cannot say whether the restore finished");
    expect(answer).toContain("Do NOT start another one");
  });

  it("DOES NOT PRINT A BARE ERROR CODE AS THE ACCOUNT OF WHAT HAPPENED", () => {
    // app.ts answers `{ error: "internal_error" }` with NO message, and api.ts's
    // toApiError then sets message = the code. The operator was shown the word
    // "internal_error" as the whole story of what became of their database.
    const answer = restoreProblem(apiError("internal_error", "internal_error", 500), "apply");
    expect(answer).not.toBe("internal_error");
    expect(answer.startsWith("internal_error")).toBe(false);
    expect(answer).toContain("cannot say whether the restore finished");
  });

  it("HANDLES A BODY THAT IS NOT JSON AT ALL, which is what a proxy answers", () => {
    // api.ts falls back to code "unknown" and a message naming the status
    // whenever the body does not parse -- which is exactly what nginx returns
    // for a 413, a 502 or a 504, and this change adds nginx blocks in front of
    // both restore routes.
    const answer = restoreProblem(
      apiError("unknown", "POST /restore/apply failed with 504", 504), "apply",
    );
    expect(answer).toContain("504");
    expect(answer).toContain("cannot say whether the restore finished");
  });

  it("still says nothing was destroyed when the same thing happens to a PREVIEW", () => {
    // A preview writes nothing to the database and takes no backup, so this is
    // a fact rather than an optimism -- and it is the difference `phase` exists
    // for, now reached by the default arm as well.
    const answer = restoreProblem(apiError("something_new", "odd", 500), "preview");
    expect(answer).toContain("nothing was destroyed");
    expect(answer).not.toContain("cannot say whether the restore finished");
  });

  it("explains the sign-out rather than echoing a header name at somebody", () => {
    const answer = restoreProblem(
      apiError("unauthenticated", "no Ynh-User header was present on this request", 401), "apply",
    );
    expect(answer).toContain("not signed in");
    expect(answer).not.toContain("Ynh-User");
  });
});

describe("restoreProblem and a 200 that could not be parsed", () => {
  it("DOES NOT REPORT AN APPLY'S SHAPE ERROR AS A PARSING COMPLAINT ALONE", () => {
    // restoreOutcomeSchema declares `restored: z.literal(true)` on purpose, so
    // a 200 saying otherwise fails to parse rather than rendering a success
    // banner. That means this branch fires on a successful HTTP response from a
    // route that has just been running a restore -- the most ambiguous outcome
    // there is, and it was getting the least guidance of any.
    const answer = restoreProblem(
      new ResponseShapeError("Unexpected response shape from the server (restore outcome)"),
      "apply",
    );
    expect(answer).toContain("Unexpected response shape");
    expect(answer).toContain("cannot say whether the restore finished");
  });

  it("leaves the preview's shape error as itself, because nothing was at stake", () => {
    const answer = restoreProblem(new ResponseShapeError("Unexpected response shape"), "preview");
    expect(answer).toBe("Unexpected response shape");
  });
});

describe("restoreConfirmBlocked, and the two controls that used to go dark in silence", () => {
  const ready = {
    plan: restorePlan(), installName: INSTALL, typedName: INSTALL,
    passphrase: "correct horse", busy: false, running: false,
  };

  it("EXPLAINS BOTH CONTROLS when something else on the page is running", () => {
    // This function used to take no `busy` at all while its sibling
    // restorePreviewBlocked had an explicit arm for it. With a plan on screen
    // the two downloads above stay live, so starting an export turned BOTH
    // "Restore, replacing everything" and "Cancel and delete the upload" off
    // with nothing beside either -- and the Cancel is the control that deletes
    // a decrypted credential store.
    const answer = restoreConfirmBlocked({ ...ready, busy: true }) ?? "";
    expect(answer).toContain("One thing at a time");
    expect(answer).toContain("Nothing here can be pressed");
  });

  it("SAYS NOTHING while the confirmation itself is what is running", () => {
    // The buttons say it: "Restoring..." and "Deleting...", with restore-running
    // underneath. A second sentence repeating them would be noise at the one
    // moment the operator is watching the screen hardest.
    expect(restoreConfirmBlocked({ ...ready, busy: true, running: true })).toBeNull();
  });

  it("puts the busy reason AHEAD of the form's, because it explains more", () => {
    // A half-typed confirmation while an export runs is two reasons at once,
    // and only one of them is why Cancel is off.
    const answer = restoreConfirmBlocked({
      ...ready, typedName: "wrong", passphrase: "", busy: true,
    }) ?? "";
    expect(answer).toContain("One thing at a time");
    expect(answer).not.toContain("archive passphrase again");
  });
});

describe("twoSentences, through the messages that append to the server's", () => {
  it("DOES NOT RUN TWO SENTENCES TOGETHER when the server's does not end in one", () => {
    // routes/restore.ts's name mismatch ends with the install's name and no
    // full stop, so the page was rendering "...confirm: conduit_test Nothing
    // has been changed" -- one sentence about a name that is not one. Both
    // tests used toContain, so neither could see it.
    const answer = restoreProblem(
      apiError("restore_name_mismatch", "type this install's name exactly to confirm: conduit"),
      "apply",
    );
    expect(answer).toContain("confirm: conduit. Nothing has been changed");
    expect(answer).not.toContain("conduit Nothing");
  });

  it("adds no second full stop when the server's message already ends in one", () => {
    const answer = restoreProblem(
      apiError("restore_passphrase_mismatch", "that is not the passphrase."), "apply",
    );
    expect(answer).toContain("passphrase. Nothing has been changed");
    expect(answer).not.toContain("passphrase.. ");
  });
});
