import { describe, expect, it } from "vitest";
import { CSV_IMPORT_FIELDS, csvMappingProblem } from "@conduit/shared";
import type { CsvColumnView, CsvMappingView } from "@conduit/shared";
import { ApiError, ResponseShapeError } from "../api";
import {
  EMPTY_IMPORT_UPLOAD, applyKeptTheImportPreview, failureKeepsTheMapping, importProblem,
  importUploadBlocked, initialChoices, mappingBlocked, mappingFrom,
} from "./settings-import-lib";

/**
 * THE IMPORT SURFACE'S DECISIONS, WITHOUT A DOM.
 *
 * This package's vitest environment is `node`, so what is not in
 * settings-import-lib.ts is only ever exercised by Playwright. What IS here is
 * the part that decides, and on this surface that is three things a journey
 * could only observe indirectly: whether a control may be pressed, whether a
 * failure leaves the operator's work where it is, and what a failure means in
 * words.
 */

function apiError(code: string, message = "server said so", status = 400): ApiError {
  return new ApiError(message, status, code);
}

function column(over: Partial<CsvColumnView> = {}): CsvColumnView {
  return { index: 0, header: "First", samples: ["Ada"], filled: 1, suggestion: null, ...over };
}

function view(columns: readonly CsvColumnView[]): CsvMappingView {
  return {
    source: {
      filename: "contacts.csv", bytes: 120, sha256: "a".repeat(64),
      stagedBytes: 120, memberCount: 1,
    },
    dialect: { delimiter: ",", delimiterName: "comma", sniffed: true },
    columns,
    targets: CSV_IMPORT_FIELDS,
    sampled: 2,
    findings: [],
    refusal: null,
  };
}

/** A file object without a DOM: only `name` and identity are ever read. */
const A_FILE = { name: "contacts.csv" } as unknown as File;

describe("importUploadBlocked", () => {
  it("says a file is needed, rather than disabling the button mutely", () => {
    expect(importUploadBlocked(EMPTY_IMPORT_UPLOAD, false, false))
      .toBe("Choose a file to enable this.");
  });

  it("says nothing once a file is chosen", () => {
    expect(importUploadBlocked({ file: A_FILE, delimiter: "" }, false, false)).toBeNull();
  });

  it("NAMES NO OPERATION when something else on the page is running", () => {
    // restorePreviewBlocked had to have this correction: `busy` is true for six
    // different things, and a page that guessed which one named the wrong one
    // on three of them. A visible WRONG reason is worse than a vague one.
    const blocked = importUploadBlocked({ file: A_FILE, delimiter: "" }, true, false);
    expect(blocked).toBe("One thing at a time. This is waiting for the operation already running.");
    expect(blocked).not.toContain("download");
    expect(blocked).not.toContain("restore");
  });

  it("is SILENT while this control is the thing running, because the button says so", () => {
    expect(importUploadBlocked({ file: A_FILE, delimiter: "" }, true, true)).toBeNull();
    // And even with no file: a control mid-flight is not a control waiting for
    // one, and the label reads "Opening the archive..." beside it.
    expect(importUploadBlocked(EMPTY_IMPORT_UPLOAD, true, true)).toBeNull();
  });
});

describe("initialChoices", () => {
  it("starts from Conduit's guess, and leaves an unrecognised column unmapped", () => {
    const choices = initialChoices(view([
      column({ index: 0, header: "First name", suggestion: "contact.first_name" }),
      column({ index: 1, header: "Field 7", suggestion: null }),
    ]));
    expect(choices).toEqual({ 0: "contact.first_name", 1: "" });
  });

  it("KEYS BY POSITION, so two columns with one name do not share a choice", () => {
    // The rule @conduit/shared's import-mapping.ts is built on: somebody else's
    // spreadsheet can have two columns both called "Email". A record keyed by
    // header text would have collapsed these two into one entry.
    const choices = initialChoices(view([
      column({ index: 0, header: "Email", suggestion: "contact.email" }),
      column({ index: 1, header: "Email", suggestion: "contact.email" }),
    ]));
    expect(Object.keys(choices)).toEqual(["0", "1"]);
  });

  it("handles a column with no name at all", () => {
    expect(initialChoices(view([column({ index: 0, header: "", suggestion: null })])))
      .toEqual({ 0: "" });
  });
});

describe("mappingFrom", () => {
  it("drops the columns the operator chose not to import", () => {
    const mapping = mappingFrom({ 0: "contact.first_name", 1: "", 2: "contact.email" });
    expect(mapping.entries).toEqual([
      { column: 0, field: "contact.first_name" },
      { column: 2, field: "contact.email" },
    ]);
  });

  it("SORTS BY COLUMN, so three email columns arrive in the order they are on screen", () => {
    // services/import-csv.ts's resolveMapping sorts them anyway; agreeing here
    // means the value this page VALIDATES is the value the server BUILDS, which
    // is the whole point of csvMappingProblem being one function.
    const mapping = mappingFrom({ 5: "contact.email", 1: "contact.email", 3: "contact.email" });
    expect(mapping.entries.map((entry) => entry.column)).toEqual([1, 3, 5]);
  });

  it("leaves the delimiter and the owner off entirely when neither was chosen", () => {
    // ABSENT AND NOT EMPTY-STRING. The route's schema takes a uuid or nothing
    // for the owner and one of four characters or nothing for the delimiter, so
    // "" would be a 400 rather than a default.
    const mapping = mappingFrom({ 0: "contact.first_name" }, { delimiter: "", owner: "" });
    expect(mapping).toEqual({ entries: [{ column: 0, field: "contact.first_name" }] });
    expect("delimiter" in mapping).toBe(false);
    expect("owner" in mapping).toBe(false);
  });

  it("carries them when they were", () => {
    const mapping = mappingFrom(
      { 0: "contact.first_name" }, { delimiter: ";", owner: "11111111-1111-4111-8111-111111111111" },
    );
    expect(mapping.delimiter).toBe(";");
    expect(mapping.owner).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("mappingBlocked", () => {
  const good = { 0: "contact.first_name", 1: "contact.email" } as const;

  it("is silent for a mapping the server would accept", () => {
    expect(mappingBlocked({
      mapping: mappingFrom(good), columnCount: 2, busy: false, running: false,
    })).toBeNull();
  });

  it("USES csvMappingProblem'S OWN SENTENCE, and not a second phrasing of it", () => {
    // ONE RULE, BOTH SIDES. The page disables its control on it and
    // services/import-csv.ts refuses a mapping that arrives anyway; the two
    // refusals have to read as one answer. This asserts the page's text IS the
    // shared function's, capitalised, rather than merely agreeing with it -- so
    // a rewording of either cannot drift past this test.
    const mapping = mappingFrom({ 0: "contact.first_name", 1: "company.name" });
    const shared = csvMappingProblem(mapping, 2);
    expect(shared).not.toBeNull();
    const blocked = mappingBlocked({ mapping, columnCount: 2, busy: false, running: false });
    expect(blocked).toBe((shared ?? "").charAt(0).toUpperCase() + (shared ?? "").slice(1));
    expect(blocked).toContain("both companies and contacts");
  });

  it("refuses a mapping with nothing in it, and one with no required field", () => {
    expect(mappingBlocked({
      mapping: mappingFrom({ 0: "" }), columnCount: 1, busy: false, running: false,
    })).toContain("Map at least one column");
    expect(mappingBlocked({
      mapping: mappingFrom({ 0: "contact.email" }), columnCount: 1, busy: false, running: false,
    })).toContain("First name");
  });

  it("refuses a mapping that points past the end of THIS file's header", () => {
    // `columnCount` is the file's, so a mapping built against a different
    // upload is refused before it is sent -- which is the client half of the
    // digest check routes/import.ts makes on arrival.
    expect(mappingBlocked({
      mapping: mappingFrom(good), columnCount: 1, busy: false, running: false,
    })).toContain("Column 1 is not one of this file's 1 columns");
  });

  it("says why it is off when something else is running, and is silent when THIS is", () => {
    expect(mappingBlocked({
      mapping: mappingFrom(good), columnCount: 2, busy: true, running: false,
    })).toContain("One thing at a time");
    expect(mappingBlocked({
      mapping: mappingFrom(good), columnCount: 2, busy: true, running: true,
    })).toBeNull();
  });
});

describe("applyKeptTheImportPreview", () => {
  it("KEEPS IT for everything routes/import.ts refuses before it takes the session", () => {
    // requireUser, the strict body schema and app.ts's write gate all run
    // before `intakeSessions.use`, so the operator's upload is still there.
    for (const code of ["unauthenticated", "validation", "restore_in_progress"]) {
      expect(applyKeptTheImportPreview(apiError(code)), code).toBe(true);
    }
  });

  it("TREATS EVERYTHING ELSE AS CONSUMED, which is the safe direction", () => {
    // `use` disposes of the staging in a `finally`, so every outcome past it
    // means the plan id would answer 404. Offering Import again against it
    // would read as a second, different failure.
    for (const code of [
      "import_changed", "import_csv_changed", "import_failed", "import_plan_unknown",
      "import_busy", "unknown",
    ]) {
      expect(applyKeptTheImportPreview(apiError(code)), code).toBe(false);
    }
  });

  it("defaults to false for anything that is not an ApiError", () => {
    // A request that never came back may still have run.
    expect(applyKeptTheImportPreview(new Error("network"))).toBe(false);
    expect(applyKeptTheImportPreview(new ResponseShapeError("bad shape"))).toBe(false);
  });
});

describe("failureKeepsTheMapping", () => {
  it("KEEPS THE MAPPING ACROSS A CHANGED WORLD, which is the decision this exists for", () => {
    // services/import-csv.ts left this to the routes task in as many words: "a
    // routes task should keep the operator's mapping in front of them across a
    // refused apply, because nothing about the mapping became untrue -- only
    // the counts did." The plan is consumed and the mapping is not.
    expect(failureKeepsTheMapping(apiError("import_csv_changed", "counts moved", 409))).toBe(true);
    expect(applyKeptTheImportPreview(apiError("import_csv_changed", "counts moved", 409)))
      .toBe(false);
  });

  it("THROWS IT AWAY FOR THE ONE FAILURE THAT MAKES IT UNTRUE: a different file", () => {
    // A mapping is a list of column POSITIONS. Against a different file there
    // is nothing to keep, and keeping it would be the page offering to import
    // a postcode into a phone number.
    expect(failureKeepsTheMapping(apiError("import_csv_file_changed", "not that file", 409)))
      .toBe(false);
  });

  it("keeps it when the request did not come back at all", () => {
    // Nothing about the columns depends on whether a response arrived, and
    // throwing away five minutes of somebody's work on the strength of a
    // dropped connection would be the expensive guess.
    expect(failureKeepsTheMapping(new Error("network"))).toBe(true);
  });
});

describe("importProblem", () => {
  it("SAYS NOTHING WAS CHANGED when a PREVIEW does not come back, because that is a fact", () => {
    // A preview writes nothing to the database, so this is not optimism. The
    // apply's answer below is deliberately different.
    const answer = importProblem(new Error("offline"), "preview");
    expect(answer).toContain("never writes to the database");
  });

  it("REFUSES TO GUESS when an APPLY does not come back, and says what to do", () => {
    const answer = importProblem(new Error("offline"), "apply");
    expect(answer).toContain("cannot say whether the import finished");
    // The instruction that makes it actionable rather than merely honest: the
    // preview is spent either way, so a second import of the same file is a
    // real risk and looking first is the answer.
    expect(answer).toContain("two of everything");
  });

  it("PASSES THE ENGINES' CHANGED-WORLD SENTENCES THROUGH WHOLE", () => {
    // Both messages already say that nothing was imported and what to do next,
    // and the CSV one says the thing the page then acts on. A paraphrase would
    // throw away the only sentence that tells an operator their mapping is
    // safe.
    const csv = "the preview said 2 contacts would be created and 1 were, because this "
      + "install changed while the preview was open. Nothing has been imported, and the "
      + "column mapping is unaffected. Take a fresh preview of the same file.";
    expect(importProblem(apiError("import_csv_changed", csv, 409), "apply")).toBe(csv);
    const exact = "the preview said 104 companies would be created and 103 were, because this "
      + "install changed while the preview was open. Nothing has been imported. Upload the "
      + "export again for a fresh preview.";
    expect(importProblem(apiError("import_changed", exact, 409), "apply")).toBe(exact);
  });

  it("names the other exits when an upload nobody can reach is in the way", () => {
    // The one state this surface cannot always get itself out of: a preview is
    // addressed by an id held only by the page that made it, so "finish or
    // cancel it first" is an instruction a reload or a second tab cannot
    // follow. It also may be a RESTORE, and the message must not claim to know.
    const answer = importProblem(
      apiError("import_busy", "another upload is already waiting for a decision on this "
        + "install; finish or cancel it first", 409),
      "preview",
    );
    expect(answer).toContain("finish or cancel it first");
    expect(answer).toContain("an import or a restore");
    expect(answer).toContain("within half an hour");
    expect(answer).toContain("restart of Conduit clears it");
  });

  it("passes the server's own actionable sentences through", () => {
    for (const code of [
      "import_file_refused", "import_disk_space", "import_tool_missing", "too_large",
      "import_owner_unknown", "validation",
    ]) {
      expect(importProblem(apiError(code, "the exact words"), "preview"), code)
        .toBe("the exact words");
    }
  });

  it("explains the write gate in the operator's terms, under the restore's code", () => {
    // app.ts's onRequest hook refuses every unsafe METHOD while a restore runs,
    // and it answers `restore_in_progress` whatever the route was. An import
    // refused there touched nothing at all.
    const answer = importProblem(
      apiError("restore_in_progress", "a restore is replacing this install's data", 503),
      "apply",
    );
    expect(answer).toContain("a restore is replacing this install's data");
    expect(answer).toContain("Nothing has been imported");
  });

  it("explains an expired preview rather than echoing a bare 404", () => {
    expect(importProblem(apiError("import_plan_unknown", "gone", 404), "apply"))
      .toContain("half an hour");
  });

  it("says a rolled-back import imported nothing, in as many words", () => {
    const answer = importProblem(
      apiError("import_failed", "the import stopped during the insert-companies step.", 500),
      "apply",
    );
    expect(answer).toContain("one transaction");
    expect(answer).toContain("rolled back");
  });

  it("reports a shape error as itself, never as a transport problem", () => {
    expect(importProblem(new ResponseShapeError("Unexpected response shape"), "preview"))
      .toBe("Unexpected response shape");
    // On an apply it gains the outcome sentence, because a 200 that failed to
    // parse came back from a route that had just been importing.
    expect(importProblem(new ResponseShapeError("Unexpected response shape"), "apply"))
      .toContain("cannot say whether the import finished");
  });

  it("translates the SSOwat 401 into something an operator can act on", () => {
    const answer = importProblem(apiError("unauthenticated", "No Ynh-User header", 401), "apply");
    expect(answer).toContain("not signed in");
    expect(answer).not.toContain("Ynh-User");
  });

  it("THE DEFAULT IS NOT A PASS-THROUGH, which is what makes the arms above instruments", () => {
    // A bare `return error.message` would mean a case label could be deleted
    // from the switch with nothing noticing. Two real shapes reach here: a body
    // that is not JSON at all (api.ts falls back to code "unknown" with the
    // status in the message), and app.ts's `internal_error` with NO message.
    const nginx = importProblem(
      apiError("unknown", "POST /import/csv/apply failed with 504", 504), "apply",
    );
    expect(nginx).toContain("failed with 504");
    expect(nginx).toContain("cannot say whether the import finished");

    const bare = importProblem(apiError("internal_error", "internal_error", 500), "apply");
    expect(bare).toBe(importProblem(new Error("x"), "apply"));
  });
});
