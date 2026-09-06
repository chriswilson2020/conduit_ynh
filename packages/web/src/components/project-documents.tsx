import { useState } from "react";
import { ApiError, apiUrl } from "../api";
import { useIssueStatusReport, useProjectDocuments } from "../queries";
import { Button } from "./ui/button";

/**
 * A PROJECT'S STATUS REPORTS -- Phase 9 Task 4.
 *
 * **A SECTION ON THE PAGE, LIKE THE DEAL'S AND THE COMPANY'S AND THE CONTACT'S,
 * AND TASK 4 IS WHERE THE ARGUMENT FOR CONSOLIDATING THEM WAS SUPPOSED TO BE
 * SETTLED. IT IS SETTLED: NOT NOW, AND THE REASON IS MEASURED RATHER THAN
 * INHERITED.**
 *
 * The deal's section carried the original argument -- "the rail is SHARED by the
 * company, contact, deal and project pages and a document belongs to a deal
 * alone; a sixth tab there would be empty on three of the four" -- and Task 3
 * recorded that half of it had expired and the other half would expire here.
 * Both halves have now expired: after this task all four records carry documents.
 *
 * **AND THE SPEC AND THE PLAN BOTH SAY "a record's Documents TAB", WHICH THE
 * CODEBASE HAS NEVER HAD.** Task 3 flagged the mismatch. It is still a section,
 * on all four pages, and here is what a sixth rail tab would actually cost:
 *
 * 1. **IT WOULD BREAK A MEASURED PHONE CLAIM, NOT A GUESSED ONE.**
 *    `e2e/mobile.spec.ts`'s "reads the record rail, reaching its last tab by
 *    keyboard" arrows right FOUR times from Timeline and asserts Meetings is
 *    focused, is the last tab, and is in the viewport. Its comment records the
 *    measurement behind it: at 390px in Chrome on macOS the five labels are
 *    349px of content in a 342px box, and the test exists because below 360px
 *    that spill used to scroll the whole PAGE and take the last tab off screen.
 *    A sixth label moves the number that was measured, and the test that guards
 *    it would have to be rewritten by the same change -- which is the shape of
 *    change that quietly stops asserting what it used to.
 * 2. **IT WOULD MOVE FOUR SHIPPED SURFACES AT ONCE**, each with its own test id
 *    and e2e specs: `deal-documents` (with the quote form), `record-documents`
 *    (with three forms and the redraft dialog) on two pages, and this one.
 * 3. **AND THE FOUR ARE NOT ONE COMPONENT.** A deal's section raises quotes, a
 *    company's raises letters and agreements, a project's raises reports with no
 *    form at all. A shared tab would be a switch over the record type wrapping
 *    three different bodies -- the consolidation people picture, which is one
 *    list of mixed types on one record, is not available, because
 *    `documents_exactly_one_entity` means a record carries exactly the types its
 *    own writers produce.
 *
 * **SO IT IS REPORTED RATHER THAN ABSORBED**, which is what Task 3 asked for.
 * The work is real and it is a UI task with an e2e measurement in it, not a
 * paragraph at the end of a data-model phase.
 *
 * THERE IS NO FORM, AND FOR THIS TYPE THAT IS A FINDING RATHER THAN A GIVEN.
 * The spec gave the status report "possibly a date range"; the API's
 * `issueStatusReport` has the argument for why it has none. So the control is a
 * button, exactly as the meeting summary's is, and there is nothing to validate
 * before it is pressed.
 */
export function ProjectDocumentsSection({ projectId, archived }: {
  projectId: string;
  /** An archived project is refused by the service, so the button is disabled
   * rather than left to produce a 409 the reader has to read. */
  archived: boolean;
}) {
  const { data: reports = [], isLoading, error } = useProjectDocuments(projectId);
  const issueReport = useIssueStatusReport();
  const [banner, setBanner] = useState<string | null>(null);

  return (
    <section className="mt-6" data-testid="project-documents">
      {/* `max-md:flex-wrap` DROPS THE BUTTON ONTO ITS OWN LINE BELOW THE
          BREAKPOINT, which is this page header's own fix applied to a longer
          label. "Generate status report" is two and a half times the width of the
          "New pipeline" button in the section above it, and the phone standard
          this codebase measures against is 320px, not 390. The button is not
          `shrink-0`, so without the wrap it would compress rather than overflow --
          into a control narrower than its own text. */}
      <div className="mb-2 flex items-center justify-between gap-2 max-md:flex-wrap">
        <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
        <Button
          variant="outline"
          data-testid="project-generate-report"
          disabled={archived || issueReport.isPending}
          onClick={() => {
            setBanner(null);
            issueReport.mutate(projectId, { onError: (err) => setBanner(errorText(err)) });
          }}
        >
          {/*
            THE LABEL DOES NOT CHANGE TO "Regenerate" ONCE ONE EXISTS, which is
            the meeting summary's decision and it matters more here. A report is
            not frozen, producing another is the intended use rather than a
            recovery, and each one is its own document with its own PDF -- so the
            twelfth press does exactly what the first did, and a label that
            changed would suggest it did not.
          */}
          {issueReport.isPending ? "Generating..." : "Generate status report"}
        </Button>
      </div>
      {archived && (
        <p className="mb-2 text-xs text-slate-500">
          Unarchive this project to generate a status report.
        </p>
      )}
      {banner !== null && (
        <p role="alert" data-testid="project-report-error" className="mb-2 text-xs text-red-600">
          {banner}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mb-2 text-xs text-red-600">
          Could not load documents: {errorText(error)}
        </p>
      )}
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {reports.map((report) => (
          <li
            key={report.id}
            data-testid={`project-report-${report.id}`}
            className="flex items-center justify-between gap-2 px-4 py-2"
          >
            {/*
              THE ISSUE DATE IS THE WHOLE OF THE LABEL, and it is enough because
              of what this type is. A quote's row shows a number and a total; a
              report has neither, and what tells two reports of one project apart
              is exactly when each was taken. It is also the filename, so the row
              and the download agree.
            */}
            <span className="text-sm text-slate-900">{`Status report — ${report.issueDate}`}</span>
            <a
              className="text-xs text-blue-600 underline"
              href={apiUrl(`/files/${report.fileId}/download`)}
              data-testid={`project-report-download-${report.id}`}
            >
              Download PDF
            </a>
          </li>
        ))}
        {/* `isLoading` and not `isPending`, for the reason the Pipelines section
            on this page carries: `enabled` is false while the id is empty, and a
            disabled query is pending for ever. */}
        {isLoading && <li className="px-4 py-2 text-sm text-slate-400">Loading...</li>}
        {!isLoading && error === null && reports.length === 0 && (
          <li data-testid="project-documents-empty" className="px-4 py-2 text-sm text-slate-400">
            No documents yet
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * The server's sentence when it has one.
 *
 * `ApiError.message` is what the service said -- "this project is archived", "no
 * project_status_report template exists; add one in Settings", or the size
 * refusal naming the task count -- and every one of those is more use than
 * "Request failed". The document routes map seven distinct failures onto
 * sentences precisely so a client can show them.
 */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
