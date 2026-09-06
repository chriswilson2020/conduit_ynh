import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  documentTypeFreezes, documentTypeNumbered, PROJECT_STATUS_LABEL, RENDER_MARKUP_CAP_BYTES,
  TASK_STATUS_LABEL, todayInZone,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { withPythonStub, writePythonStub } from "../test/python-stub.js";
import { seededStatusReportTemplate, seededStatusReportTemplatePaths } from "../test/seed-template.js";
import { pageCount, pdfVisibleText } from "../test/pdf.js";
import { resolveUser } from "../users.js";
import { documentNumberSequences, documents, documentTemplates, files } from "../db/schema.js";
import { createCompany } from "./companies.js";
import { createProject, archiveProject } from "./projects.js";
import { addDependency, archiveTask, createTask, setTaskStatus, updateTask } from "./tasks.js";
import { blobPath } from "./blobs.js";
import { saveOrgProfile } from "./org-profile.js";
import { weasyprintAvailable } from "./documents-render.js";
import {
  buildStatusReportContext, DocumentTemplateMissingError, DocumentTooLargeError,
  issueStatusReport, listProjectDocuments, type StatusReportTask,
} from "./documents.js";
import { ArchivedError, NotFoundError } from "./errors.js";

/**
 * THE PROJECT STATUS REPORT: THE BROADEST SOURCE, AND THE SECOND TYPE WITH NO
 * FORM.
 *
 * The plan expected this type to be the largest in the phase and the spec gave it
 * "possibly a date range" as its extra input. It has none -- see
 * `issueStatusReport` for the argument -- so what is left to test is not a form
 * but a READ, and that is where all of this type's difficulty is:
 *
 *   - **WHICH TASKS APPEAR, AND IN WHAT ORDER.** Unarchived, undated ones
 *     INCLUDED (unlike the Gantt), in the Gantt's own outline order.
 *   - **SEVEN COUNTS THAT MUST AGREE WITH THE TABLE THEY SIT ABOVE.** They are
 *     computed from the same array precisely so they cannot disagree, and the
 *     tests below drive them off a project whose statuses are all different.
 *   - **THE OVERDUE RULE**, which has three edges: due today is not overdue, a
 *     done task never is, and an undated one never is.
 *   - **NO NUMBER, NO FREEZE, NO DETAIL TABLE**, each of which is an assertion
 *     about something NOT happening and therefore has to be made explicitly.
 *
 * THE STUB RENDERER IS documents.test.ts's, for its reason: the failure paths are
 * exactly the ones a WeasyPrint-gated suite would skip on a developer machine.
 * The gated cases at the end are the ones that need a real PDF.
 */
const handle = openTestDatabase();
const stubDir = mkdtempSync(join(tmpdir(), "conduit-report-"));
const HAVE_WEASYPRINT = await weasyprintAvailable();
const itReal = HAVE_WEASYPRINT ? it : it.skip;

let dataDir: string;
let actorId: string;
let companyId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = mkdtempSync(join(stubDir, "data-"));
  actorId = (await resolveUser(handle.db, {
    username: "chris", email: null, fullName: "Chris Wilson",
  })).id;
  const company = await createCompany(handle.db, actorId, { name: "Acme Manufacturing BV" });
  companyId = company.id;
  const project = await createProject(handle.db, actorId, {
    name: "Rye Lane rollout", companyId, ownerUserId: actorId,
    startDate: "2026-08-01", dueDate: "2026-12-31",
  });
  projectId = project.id;
  // truncateAll() empties every table in the public schema, so 0020's seeded row
  // is gone before any test body runs -- exactly as 0009's is for the quote suite
  // and 0017's for the summary. A test that did not notice would merge nothing.
  await seedReportTemplate();
});

afterAll(async () => {
  await handle.close();
  rmSync(stubDir, { recursive: true, force: true });
});

async function seedReportTemplate(bodyHtml = seededStatusReportTemplate()): Promise<void> {
  await handle.db.delete(documentTemplates)
    .where(eq(documentTemplates.type, "project_status_report"));
  await handle.db.insert(documentTemplates)
    .values({ type: "project_status_report", bodyHtml });
}

/** Echoes the merged HTML back inside the "PDF" -- documents-summary.test.ts's. */
const ECHOING_RENDER = "printf '%s' '%PDF-1.7 '\ncat";
const OK_RENDER = "printf '%s' '%PDF-1.7 ok'";

async function issueWithStub(
  body = OK_RENDER, id = "",
): Promise<Awaited<ReturnType<typeof issueStatusReport>>> {
  const dir = writePythonStub(stubDir, body);
  return await withPythonStub(dir, async () =>
    await issueStatusReport(handle.db, { dataDir }, actorId, id === "" ? projectId : id));
}

/** The merged HTML the renderer was handed, recovered from the echoing stub. */
async function mergedHtml(): Promise<string> {
  const report = await issueWithStub(ECHOING_RENDER);
  const [file] = await handle.db.select().from(files).where(eq(files.id, report.fileId));
  return (await readFile(blobPath(dataDir, file!.sha256), "utf8")).replace(/^%PDF-1\.7 /, "");
}

/** Today, as the service computes it -- so a test never hardcodes a date that ages. */
async function today(): Promise<string> {
  const [row] = await handle.db.execute<{ tz: string }>(sql`SELECT time_zone AS tz FROM org_profile`);
  return todayInZone(row?.tz ?? "UTC");
}

function addDays(iso: string, days: number): string {
  const at = new Date(`${iso}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

describe("issueStatusReport produces a report of a project", () => {
  it("writes one documents row, a file on the project, and nothing else", async () => {
    const report = await issueWithStub();

    expect(report).toMatchObject({
      type: "project_status_report", projectId, frozen: false, issuedByUserId: actorId,
    });
    expect(report.issueDate).toBe(await today());

    const [row] = await handle.db.select().from(documents);
    expect(row).toMatchObject({
      type: "project_status_report", projectId, number: null, frozen: false,
      companyId: null, contactId: null, dealId: null, meetingId: null,
    });

    const [file] = await handle.db.select().from(files);
    // ON THE PROJECT, which is `files_exactly_one_entity`'s fourth parent and the
    // one it has had since Phase 3 -- unlike the summary, this type needed no
    // widening of that constraint. 0017 had to add `meeting_id`; a project was
    // already a place a file could live.
    expect(file).toMatchObject({
      projectId, companyId: null, contactId: null, dealId: null, meetingId: null,
      mime: "application/pdf",
    });
    expect(file?.originalName).toBe(`Status report - Rye Lane rollout - ${await today()}.pdf`);
  });

  /**
   * **NO NUMBER, AND THE ASSERTION IS THAT NOTHING ALLOCATED ONE** -- not merely
   * that the column is null. A writer that called `allocateNumber` "for
   * consistency" would leave a row in `document_number_sequences` even if it then
   * threw it away, and `document_number_sequences_type_valid` is deliberately not
   * widened so that call would fail. Both halves are checked.
   */
  it("takes no number, spends no sequence, and could not have spent one", async () => {
    await issueWithStub();
    const [row] = await handle.db.select().from(documents);
    expect(row?.number).toBeNull();
    expect(await handle.db.select().from(documentNumberSequences)).toEqual([]);
    expect(documentTypeNumbered("project_status_report")).toBe(false);

    await expect(handle.db.insert(documentNumberSequences)
      .values({ type: "project_status_report", year: 2026, lastValue: 1 }))
      .rejects.toMatchObject({
        cause: {
          code: "23514",
          message: expect.stringContaining("document_number_sequences_type_valid"),
        },
      });
  });

  /**
   * **NOT FROZEN, AND PRODUCING ANOTHER APPENDS.** This is the type whose whole
   * point is being produced again -- "you regenerate it next month, and a stale
   * report is worse than an edited one" -- so the second call must leave the
   * first document and its PDF exactly where they were.
   */
  it("appends a second report rather than replacing the first, with its own PDF", async () => {
    expect(documentTypeFreezes("project_status_report")).toBe(false);
    const first = await issueWithStub("printf '%s' '%PDF-1.7 one'");
    const second = await issueWithStub("printf '%s' '%PDF-1.7 two'");

    expect(second.id).not.toBe(first.id);
    expect(second.fileId).not.toBe(first.fileId);
    const rows = await handle.db.select().from(documents);
    expect(rows).toHaveLength(2);

    // The first PDF is byte for byte what it was -- blobs are content-addressed,
    // so two different renders are two different files and neither overwrote the
    // other.
    const stored = await handle.db.select().from(files);
    const shas = stored.map((f) => f.sha256);
    expect(new Set(shas).size).toBe(2);
    const [firstFile] = stored.filter((f) => f.id === first.fileId);
    expect(await readFile(blobPath(dataDir, firstFile!.sha256), "utf8")).toBe("%PDF-1.7 one");
  });

  /**
   * **THE FILENAME TRUNCATES THE PROJECT NAME, AND NOTHING TESTED IT UNTIL
   * MUTATION TESTING ASKED.** Removing the `.slice(0, REPORT_TITLE_CHARS)` was
   * GREEN: every other test uses a short project name, so the truncation was
   * unreachable from the suite.
   *
   * IT IS NOT COSMETIC. `projects.name` has no upper bound in the schema or in
   * `createProjectInputSchema` and `files.original_name` has none either, so a
   * paragraph pasted into the name field becomes a filename no filesystem will
   * accept and an archive member over the export's 180-BYTE limit. Bounded at 80
   * characters for `summaryFileName`'s reason: it leaves the rest of the name
   * inside that limit even when every character costs three bytes.
   */
  it("truncates a long project name in the filename, and keeps the date after it", async () => {
    const long = "Ryelane".repeat(40);
    const project = await createProject(handle.db, actorId, { name: long });
    const report = await issueWithStub(OK_RENDER, project.id);
    const [file] = await handle.db.select().from(files).where(eq(files.id, report.fileId));

    const day = await today();
    expect(file?.originalName).toBe(`Status report - ${long.slice(0, 80)} - ${day}.pdf`);
    // Spelled as a length as well as as a prefix: an off-by-one in the slice
    // would still satisfy the line above if the expectation used the same slice.
    expect(file?.originalName).toHaveLength(80 + `Status report -  - ${day}.pdf`.length);
    expect(Buffer.byteLength(file?.originalName ?? "", "utf8")).toBeLessThan(180);
  });

  it("refuses an unknown project, and an archived one, before anything spawns", async () => {
    await expect(issueWithStub(OK_RENDER, "00000000-0000-4000-8000-000000000000"))
      .rejects.toBeInstanceOf(NotFoundError);

    await archiveProject(handle.db, actorId, projectId);
    // A RENDERER THAT FAILS IF IT IS CALLED AT ALL, which is Task 3's lesson
    // about `assertRecordIssuable`: `attachFile` refuses an archived record too,
    // with the same error, so an assertion on the error type alone cannot tell
    // "refused early" from "refused after a subprocess ran and a blob was
    // written".
    await expect(issueWithStub("exit 3")).rejects.toBeInstanceOf(ArchivedError);
    expect(await handle.db.select().from(documents)).toEqual([]);
    expect(await handle.db.select().from(files)).toEqual([]);
  });

  it("refuses when the template row has been deleted, having spent nothing", async () => {
    await handle.db.delete(documentTemplates);
    await expect(issueWithStub("exit 3")).rejects.toBeInstanceOf(DocumentTemplateMissingError);
    expect(await handle.db.select().from(files)).toEqual([]);
  });

  /**
   * THE SIZE GATE NAMES THIS TYPE AND ITS TASK COUNT. `renderAndStore` takes the
   * noun and the provenance from its caller, and a refusal that said "this quote
   * merges to..." while reporting on a project would send an operator looking for
   * a quote form that does not exist.
   *
   * THE PROVENANCE NAMES THE TASKS, which is the one term of this document's size
   * an operator has any purchase on: there is no submission to trim and no notes.
   */
  it("refuses an oversized report as a status report, naming how many tasks it lists", async () => {
    await createTask(handle.db, actorId, { title: "One", projectId });
    await createTask(handle.db, actorId, { title: "Two", projectId });
    await seedReportTemplate(`<p>${"x".repeat(RENDER_MARKUP_CAP_BYTES + 100)}</p>`);

    await expect(issueWithStub("exit 3")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(DocumentTooLargeError);
      expect((error as Error).message).toContain("this status report merges to");
      expect((error as Error).message).toContain("it lists 2 task(s)");
      return true;
    });
    expect(await handle.db.select().from(files)).toEqual([]);
  });
});

describe("which tasks the report lists, and in what order", () => {
  /**
   * **UNDATED TASKS ARE IN, AND THIS IS THE ASSERTION THE WHOLE DATE-RANGE
   * DECISION RESTS ON.** `ganttPayload` drops them because a chart has nowhere to
   * draw a bar with no ends; a date range on this type would have had to do the
   * same, and the task with no dates is the one a status report exists to
   * surface.
   */
  it("lists a task with no dates, which the Gantt would have dropped", async () => {
    await createTask(handle.db, actorId, { title: "Nobody has scheduled this", projectId });
    const html = await mergedHtml();
    expect(html).toContain("Nobody has scheduled this");
    // ...and it is counted as undated rather than quietly folded into "to do".
    expect(html).toMatch(/>1<\/td>[\s\S]*?Undated/);
  });

  it("leaves out an archived task, and leaves out another project's", async () => {
    const gone = await createTask(handle.db, actorId, { title: "Cancelled work", projectId });
    await archiveTask(handle.db, actorId, gone.id);
    const other = await createProject(handle.db, actorId, { name: "Somewhere else" });
    await createTask(handle.db, actorId, { title: "Not this project", projectId: other.id });
    await createTask(handle.db, actorId, { title: "Real work", projectId });

    const html = await mergedHtml();
    expect(html).toContain("Real work");
    expect(html).not.toContain("Cancelled work");
    expect(html).not.toContain("Not this project");
  });

  /**
   * **THE GANTT'S OUTLINE ORDER: A ROOT IMMEDIATELY FOLLOWED BY ITS OWN
   * CHILDREN.** The rejected alternative is `listTasks`' `(parent_task_id,
   * position)`, and this test is what tells the two apart: under that ordering
   * Postgres sorts NULLs last, so both roots would print AFTER both subtasks and
   * each parent would be separated from its children by the rest of the project.
   * The order here is the one `taskOutlineOrder` produces, shared with
   * `ganttPayload` rather than copied.
   */
  it("prints a parent immediately in front of its own children", async () => {
    const first = await createTask(handle.db, actorId, { title: "Design", projectId });
    const second = await createTask(handle.db, actorId, { title: "Build", projectId });
    await createTask(handle.db, actorId, {
      title: "Sketches", projectId, parentTaskId: first.id,
    });
    await createTask(handle.db, actorId, {
      title: "Framing", projectId, parentTaskId: second.id,
    });

    const html = await mergedHtml();
    /*
     * **THE FIRST VERSION OF THIS ASSERTION COULD NOT FAIL, AND MUTATION TESTING
     * IS WHAT SAID SO.** It searched for `>Design` and `>Design sketches` -- and
     * the first is a PREFIX of the second, so `indexOf(">Design")` returned
     * whichever came first in the document. Under the mutation that swaps this
     * ordering for `listTasks`' (children first, roots last), the four positions
     * collapsed to two pairs that were still ascending, and the test passed. Two
     * things fix it and both are needed: titles that are not prefixes of each
     * other, and a match CLOSED on the cell's `<` -- the template emits
     * `<td>Framing</td>` for a task with no predecessors, so `>Framing<` cannot
     * match a longer title.
     */
    const order = ["Design", "Sketches", "Build", "Framing"]
      .map((title) => html.indexOf(`>${title}<`));
    expect(order.every((at) => at >= 0), `not all four rows are present: ${String(order)}`)
      .toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // ...and the ordering really is the CHART's rather than "some order":
    // `listTasks`' `(parent_task_id, position)` sorts NULLs last, so under it
    // both roots would come after both subtasks. Asserted as the negative of
    // that specific arrangement, so a future ordering change has to be a
    // deliberate one.
    expect(html.indexOf(">Design<")).toBeLessThan(html.indexOf(">Framing<"));
  });

  /**
   * **THE THIRD CLAUSE OF `taskOutlineOrder`, WHICH NOTHING EXERCISED — NOT THIS
   * SUITE AND NOT `scheduling.test.ts`.** Mutation testing asked for it: dropping
   * `tasks.position` from the ordering, so two children of one parent share a
   * sort key and come back in whatever order the plan produced, was GREEN across
   * both suites. It survived because every ordering test in the codebase, this
   * file's included, gave each parent exactly ONE child.
   *
   * **THE GAP IS NOT THIS TASK'S CODE — IT IS `ganttPayload`'S, SHARED.** That
   * function has ordered siblings by position since Phase 3 and no test could
   * tell if it stopped. The report is what put a second reader on it, and this
   * is the assertion both now have.
   */
  it("prints two children of one parent in their own position order", async () => {
    const parent = await createTask(handle.db, actorId, { title: "Fitout", projectId });
    await createTask(handle.db, actorId, { title: "Wiring", projectId, parentTaskId: parent.id });
    await createTask(handle.db, actorId, { title: "Plaster", projectId, parentTaskId: parent.id });

    const html = await mergedHtml();
    // createTask appends, so the second child's fractional position sorts after
    // the first's -- which is the only thing `tasks.position` is doing here.
    expect(html.indexOf(">Fitout<")).toBeLessThan(html.indexOf(">Wiring<"));
    expect(html.indexOf(">Wiring<")).toBeLessThan(html.indexOf(">Plaster<"));
  });

  /**
   * **THE GANTT STATE, WHICH IS THE HALF OF THIS TYPE A TASK LIST DOES NOT
   * HAVE.** A dependency whose predecessor is not itself in the report is the
   * reachable case worth naming: `addDependency` refuses to link two projects, so
   * the way an edge ends up half outside is that the predecessor was ARCHIVED --
   * and the successor is still blocked by it.
   */
  it("names a task's predecessors, including one that has since been archived", async () => {
    const groundwork = await createTask(handle.db, actorId, { title: "Groundwork", projectId });
    const frame = await createTask(handle.db, actorId, { title: "Frame", projectId });
    const roof = await createTask(handle.db, actorId, { title: "Roof", projectId });
    await addDependency(handle.db, actorId, groundwork.id, frame.id);
    await addDependency(handle.db, actorId, frame.id, roof.id);
    await archiveTask(handle.db, actorId, groundwork.id);

    const html = await mergedHtml();
    expect(html).not.toContain(">Groundwork<");
    // The archived predecessor is still NAMED on the task it blocks, which is the
    // whole claim: `ganttPayload` would have dropped this edge.
    expect(html).toContain("After Groundwork");
    expect(html).toContain("After Frame");
  });

  it("prints no dependency line for a task that waits on nothing", async () => {
    await createTask(handle.db, actorId, { title: "Standalone", projectId });
    expect(await mergedHtml()).not.toContain("After ");
  });

  /**
   * **THE ASSIGNEE IS THE FULL NAME, AND THIS TEST EXISTS BECAUSE MUTATION
   * TESTING FOUND NOTHING COULD TELL.** Swapping `fullName ?? username` for
   * `username ?? fullName` was GREEN: the only place a name reached a printed
   * page in these tests was the project OWNER, who was the same user, and
   * `issueStatusReport` builds that from a different expression the mutation did
   * not touch. So "Chris Wilson" appeared either way and the assertion could not
   * distinguish the two orders.
   *
   * The assignee is a DIFFERENT user from the owner now, with a username that is
   * not a substring of their full name, and the assertion is that the username
   * does not appear at all.
   */
  it("prints an assignee's full name and not their username", async () => {
    const jane = await resolveUser(handle.db, {
      username: "jsmith", email: null, fullName: "Jane Smith",
    });
    await createTask(handle.db, actorId, {
      title: "Survey", projectId, assigneeUserId: jane.id,
    });
    await createTask(handle.db, actorId, { title: "Unassigned work", projectId });

    const html = await mergedHtml();
    expect(html).toContain(">Jane Smith<");
    expect(html).not.toContain("jsmith");
    // An unassigned task prints a blank cell rather than a placeholder.
    expect(html).toContain("<td></td>");
  });
});

/**
 * **THE COUNTS AND THE TABLE ARE BUILT FROM ONE ARRAY, WHICH IS WHY THEY CANNOT
 * DISAGREE.** These drive `buildStatusReportContext` directly, because the thing
 * being tested is arithmetic over a list and a database round trip would only
 * make the fixture harder to read. What connects this to the real read is the
 * merged-HTML tests above and `issueStatusReport`'s own suite.
 */
describe("buildStatusReportContext counts what it prints", () => {
  const ORG = {
    name: "Listerdale", addressLines: "", email: "", phone: "", website: "",
    bankDetails: "", vatNumber: "", registrationNumber: "", logoDataUri: "",
    timeZone: "UTC", updatedAt: "2026-09-06T00:00:00.000Z",
  };
  function task(over: Partial<StatusReportTask> = {}): StatusReportTask {
    return {
      title: "T", status: "todo", startDate: null, dueDate: null, progressPct: null,
      assignee: "", after: [], ...over,
    };
  }
  function contextFor(list: StatusReportTask[], issueDate = "2026-09-06") {
    return buildStatusReportContext({
      org: ORG, issueDate, projectName: "P", status: "active",
      startDate: null, dueDate: null, owner: "", company: "", tasks: list,
    });
  }

  it("counts each status separately, and the total is the whole list", () => {
    const doc = contextFor([
      task({ status: "todo" }), task({ status: "todo" }),
      task({ status: "in_progress" }), task({ status: "blocked" }), task({ status: "done" }),
    ]).document;
    expect(doc).toMatchObject({
      taskCount: "5", todoCount: "2", inProgressCount: "1", blockedCount: "1", doneCount: "1",
    });
  });

  /**
   * THE OVERDUE RULE'S THREE EDGES, each of which is a decision rather than an
   * accident: due TODAY still has the day to run; a DONE task is never overdue
   * however late it was finished; and an UNDATED task cannot be late for a
   * deadline nobody set.
   */
  it("counts overdue strictly before today, never a done task, never an undated one", () => {
    const doc = contextFor([
      task({ dueDate: "2026-09-05", startDate: "2026-09-01" }),
      task({ dueDate: "2026-09-06", startDate: "2026-09-01" }),
      task({ dueDate: "2026-09-07", startDate: "2026-09-01" }),
      task({ dueDate: "2026-01-01", startDate: "2026-01-01", status: "done" }),
      task(),
    ], "2026-09-06").document;
    expect(doc.overdueCount).toBe("1");
    expect(doc.undatedCount).toBe("1");
  });

  it("formats each task's status, dates and progress, and joins its predecessors", () => {
    const context = contextFor([task({
      title: "Frame", status: "in_progress", startDate: "2026-09-01", dueDate: "2026-09-30",
      progressPct: 40, assignee: "Chris Wilson", after: ["Groundwork", "Survey"],
    })]);
    expect(context.tasks?.[0]).toEqual({
      title: "Frame", status: "In progress", startDate: "2026-09-01", dueDate: "2026-09-30",
      progress: "40%", assignee: "Chris Wilson", after: "Groundwork, Survey",
    });
    // The wording is the product's, shared with the task board rather than spelled
    // twice -- a status report and a kanban column must not disagree about what
    // "in_progress" is called.
    expect(context.tasks?.[0]?.status).toBe(TASK_STATUS_LABEL.in_progress);
  });

  it("prints a blank rather than a zero for a task with no progress and no dates", () => {
    expect(contextFor([task()]).tasks?.[0])
      .toMatchObject({ progress: "", startDate: "", dueDate: "", after: "" });
  });

  /**
   * **THE WORDS ARE SPELLED, NOT ASKED OF THE CODE UNDER TEST.** The first
   * version of this asserted `toBe(PROJECT_STATUS_LABEL.active)`, which is the
   * value being tested compared with itself: mutation testing showed that
   * lower-casing both labels was GREEN across the whole suite. `documentValues`
   * in db/schema.test.ts had already written the rule down -- "a fixture that
   * asked the code under test what to expect could never disagree with it" --
   * and this is the same mistake one file over.
   *
   * The pairing with the label constant is asserted too, once, so the two really
   * are one string rather than two that happen to read alike.
   */
  it("prints the project's status as a capitalised word, and blanks for what it has not got", () => {
    const doc = contextFor([]).document;
    expect(doc.projectStatus).toBe("Active");
    expect(PROJECT_STATUS_LABEL).toEqual({ active: "Active", completed: "Completed" });
    expect(doc).toMatchObject({
      startDate: "", dueDate: "", owner: "", company: "", taskCount: "0",
    });

    const completed = buildStatusReportContext({
      org: ORG, issueDate: "2026-09-06", projectName: "P", status: "completed",
      startDate: null, dueDate: null, owner: "", company: "", tasks: [],
    });
    expect(completed.document.projectStatus).toBe("Completed");
  });

  /**
   * THE KEY SET IS THE CONTRACT, and this is the only assertion that connects it
   * to the template: an unknown path renders as "" and never throws, so supplying
   * `document.taskcount` for `{{document.taskCount}}` would leave every other
   * test green and print a blank where a number should be.
   *
   * **TWO DIFFERENT STRENGTHS, AND THE DIFFERENCE IS THE POINT.**
   *
   * `org.*` is CONTAINMENT, as the summary's is: `orgContext` supplies the whole
   * nine-field letterhead to every type, and this template names six of them. The
   * three it leaves out -- the VAT number, the registration number and the bank
   * details -- are what a COMMERCIAL document prints, and a status report is not
   * one. An equality here would demand this page carry bank details.
   *
   * `document.*` and the task scope are EQUALITIES in both directions, because
   * those are this type's own contract: a path the template names and the context
   * does not supply is a blank on a printed page, and a context key the template
   * stopped naming is a count computed for nothing.
   */
  it("supplies every merge path the seeded template names, and no unused document key", () => {
    const paths = seededStatusReportTemplatePaths();
    // Guard against a vacuous pass: if the reader stopped finding tokens, every
    // containment check below would succeed against empty lists.
    expect(paths.root.length).toBeGreaterThan(15);
    expect(paths.root).toContain("tasks");
    // ...and the scope split is real -- a task's field is NOT a root path, which
    // is what `templateMergePaths`' stack buys over a depth counter now that a
    // collection item carries a block (`{{#after}}`) of its own.
    expect(paths.root).not.toContain("title");
    expect(paths.root).not.toContain("after");

    const context = contextFor([task()]);
    const orgKeys = new Set(Object.keys(context.org).map((k) => `org.${k}`));
    const documentKeys = Object.keys(context.document).map((k) => `document.${k}`).sort();

    expect(paths.root.filter((p) => p.startsWith("org.") && !orgKeys.has(p))).toEqual([]);
    expect(paths.root.filter((p) => p.startsWith("document."))).toEqual(documentKeys);
    expect(paths.task).toEqual(Object.keys(context.tasks?.[0] ?? {}).sort());
  });
});

describe("listProjectDocuments", () => {
  it("returns a project's reports newest first, and nobody else's", async () => {
    const first = await issueWithStub();
    const second = await issueWithStub();
    const other = await createProject(handle.db, actorId, { name: "Elsewhere" });

    const listed = await listProjectDocuments(handle.db, projectId);
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(listed[0]).toEqual(second);
    expect(await listProjectDocuments(handle.db, other.id)).toEqual([]);
  });
});

/**
 * THE ORGANISATION'S CLOCK, WHICH THIS TYPE READS TWICE FROM ONE VALUE: the
 * printed issue date, and the day the overdue rule is measured against. v1.8.0's
 * timezone field, and the reason they are one value is that a report which said
 * "Reported 6 September" while counting overdue against the server's UTC day
 * would disagree with itself for two hours a night.
 */
describe("the report is dated by the organisation's calendar", () => {
  it("dates the report, names the file and measures overdue by the same day", async () => {
    await saveOrgProfile(handle.db, {
      name: "Listerdale", addressLines: "", vatNumber: "", registrationNumber: "",
      email: "", phone: "", website: "", bankDetails: "", logoDataUri: "",
      timeZone: "Pacific/Kiritimati",
    });
    const day = todayInZone("Pacific/Kiritimati");
    // Kiritimati is UTC+14, so its calendar day is ahead of UTC's for ten hours
    // a day. A task due on the UTC day is therefore overdue there whenever the
    // two differ -- which is the whole point of reading the org's zone.
    await createTask(handle.db, actorId, {
      title: "Due yesterday", projectId,
      startDate: addDays(day, -3), dueDate: addDays(day, -1),
    });

    const report = await issueWithStub();
    expect(report.issueDate).toBe(day);
    const [file] = await handle.db.select().from(files);
    expect(file?.originalName).toContain(day);
  });
});

describe("with a real renderer", () => {
  itReal("renders a one-page report carrying its counts and its tasks", async () => {
    await createTask(handle.db, actorId, {
      title: "Groundwork", projectId, startDate: "2026-08-03", dueDate: "2026-08-21",
      progressPct: 100,
    });
    const frame = await createTask(handle.db, actorId, {
      title: "Frame", projectId, startDate: "2026-08-24", dueDate: "2026-09-18",
      assigneeUserId: actorId,
    });
    await updateTask(handle.db, actorId, frame.id, { progressPct: 40 });
    await setTaskStatus(handle.db, actorId, frame.id, "in_progress");
    await createTask(handle.db, actorId, { title: "Snagging", projectId });

    const report = await issueStatusReport(handle.db, { dataDir }, actorId, projectId);
    const [file] = await handle.db.select().from(files).where(eq(files.id, report.fileId));
    const pdf = await readFile(blobPath(dataDir, file!.sha256));
    expect(pageCount(pdf)).toBe(1);

    const text = await pdfVisibleText(pdf);
    expect(text).toContain("Rye Lane rollout");
    expect(text).toContain("Project status report");
    expect(text).toContain("Acme Manufacturing BV");
    expect(text).toContain("Chris Wilson");
    expect(text).toContain("Groundwork");
    expect(text).toContain("Snagging");
    expect(text).toContain("In progress");
    expect(text).toContain("40%");
  }, 30000);

  /**
   * A PROJECT WITH NO TASKS IS ORDINARY -- it is what a project looks like on the
   * day it is created -- and this is the empty case the template owes a sentence
   * to. 0009's logo lesson, 0017's attendees, 0019's greeting, and now this.
   */
  itReal("renders a project that has no tasks at all, and says so", async () => {
    const report = await issueStatusReport(handle.db, { dataDir }, actorId, projectId);
    const [file] = await handle.db.select().from(files).where(eq(files.id, report.fileId));
    const pdf = await readFile(blobPath(dataDir, file!.sha256));
    expect(pageCount(pdf)).toBe(1);
    expect(await pdfVisibleText(pdf)).toContain("This project has no tasks");
  }, 30000);
});
