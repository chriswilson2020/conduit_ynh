import { describe, expect, it } from "vitest";
import type { BackupPreflight } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";
import {
  EMPTY_BACKUP_FORM, backupFormProblem, canSubmitBackup, downloadProblem,
  formatBytes, formatDuration, preflightSeverity, preflightWarning,
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
