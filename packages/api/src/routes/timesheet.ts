import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { calendarDaySpan, isCalendarDay, MAX_TIMESHEET_DAY_SPAN } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject } from "./helpers.js";
import { timesheetDays, timesheetTotals } from "../services/timesheet.js";

/**
 * **BOTH DAYS ARE REQUIRED, WHICH IS THE DECISION AND NOT A CONVENIENCE.**
 *
 * `GET /api/time-entries` answers an unfiltered "every entry" list, and it should.
 * A TOTAL over every hour ever logged is a different question from "where did the
 * week go", and a caller that forgot the range would get an answer that looks
 * like a week's and is a lifetime's. So a missing bound is a 400 naming the field
 * rather than a default nobody chose -- `billable`'s arrangement on the create
 * schema, for its reason.
 *
 * INCLUSIVE BOTH ENDS, matching `timeEntryListFiltersSchema`'s `from`/`to`
 * exactly, so the timesheet's total and the list underneath it are over the same
 * days. A week is Monday to Sunday and the caller sends both.
 *
 * `z.iso.date()` RATHER THAN A COERCION, for the reason routes/time-entries.ts
 * gives at greater length: a coercion accepts "2026-09" and anything Date-shaped,
 * and would then range over something the columns are not.
 *
 * **AN INVERTED RANGE IS A 400 AND NOT AN EMPTY WEEK.** Answered with zeroes it
 * would be indistinguishable from an honest quiet week -- a number that is wrong
 * without looking wrong, which is the failure this whole phase is about.
 * `zonedDayRange` refuses it too; this is the gate and that is the backstop, the
 * standing split every invariant in this codebase is held by.
 *
 * **THE FOUR RECORD FILTERS ARE v1.9.0 TASK 4's, AND THERE ARE FOUR RATHER THAN
 * FIVE.** They narrow BOTH halves of the report -- entries and meetings -- so
 * "this project's week" is one answer rather than a project's entries beside
 * everybody's meetings. `task_id` is deliberately not among them: `meetings` has
 * no such column, so a task-filtered report would say "0m across 0 meetings" for
 * structural reasons the page could not explain, and `GET /api/tasks/:id/effort`
 * already answers that question against the task's estimate. The argument is
 * written out at `timesheetFiltersSchema`.
 *
 * SNAKE_CASE ON THE WIRE, camelCase in the service, exactly as
 * routes/time-entries.ts's list does -- the querystring convention this API has
 * used since Phase 1.
 */
const recordFilterFields = {
  company_id: z.uuid().optional(),
  contact_id: z.uuid().optional(),
  deal_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
};

const timesheetQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  ...recordFilterFields,
}).refine((v) => v.from <= v.to, {
  message: "from must be on or before to",
});

/**
 * The rows endpoint's own gate: the same range and filters, plus a SPAN BOUND
 * the aggregate deliberately does not have.
 *
 * The aggregate's answer is the same size whatever the range; this one's is a
 * row per entry and per meeting, so an unbounded span is a response nobody asked
 * for. Refused rather than truncated -- see MAX_TIMESHEET_DAY_SPAN, and
 * `timesheetWeekSchema` for why a short list under a full total is the one
 * outcome this surface may not produce.
 *
 * **THE `isCalendarDay` GUARD IS LOAD-BEARING AND IT WAS FOUND BY ITS OWN TEST
 * TURNING 400 INTO 500.** Zod 4.4.3 runs a schema-level `.refine` EVEN WHEN the
 * object's own fields have already failed, and passes the callback the RAW
 * value. Probed on the deploy target: `z.object({ from: z.iso.date(), … })
 * .refine(fn)` called `fn` with `{ from: "2026-09" }` after `from` had produced
 * an `invalid_format` issue, and a chained second refine ran too. So
 * `calendarDaySpan("2026-09", …)` -- which THROWS on anything that is not a
 * calendar day -- escaped the parse as a 500 for a request the field validators
 * had already refused. The guard makes the span check answer "not my refusal"
 * for input the fields will reject anyway.
 *
 * That is a general hazard rather than this route's quirk: **any `.refine` in
 * this codebase that does more than compare already-parsed primitives can be
 * handed rubbish**, and one that throws converts a 400 into a 500. Left recorded
 * here rather than audited in passing.
 *
 * The two refines also do not order themselves: `calendarDaySpan` over a
 * backwards range answers a NEGATIVE number, which is `<= 92` and therefore
 * silent -- so a range that is merely inverted is named by the `from <= to`
 * refine above and never mis-reported as too long.
 */
const timesheetDaysQuerySchema = timesheetQuerySchema
  .refine((v) => !isCalendarDay(v.from) || !isCalendarDay(v.to)
    || calendarDaySpan(v.from, v.to) <= MAX_TIMESHEET_DAY_SPAN, {
    message: `a timesheet may not list more than ${String(MAX_TIMESHEET_DAY_SPAN)} days at once`,
  });

type TimesheetQuery = z.infer<typeof timesheetQuerySchema>;

/** The querystring's record filters, in the service's spelling. One function so
 * the two routes cannot narrow by different sets. */
function filtersOf(query: TimesheetQuery) {
  return {
    companyId: query.company_id, contactId: query.contact_id,
    dealId: query.deal_id, projectId: query.project_id,
  };
}

export function registerTimesheetRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  /**
   * The week's answer: minutes logged by hand, minutes from meetings, how much of
   * the hand-entered half was billable, and every meeting this report could not
   * count.
   *
   * READ-ONLY AND DERIVED FROM NOTHING BUT THE TWO TABLES, so there is no cursor
   * and no archived arm. A client refetches it on the `["timesheet"]` hint that
   * both mutators publish -- see publishTimeEntryHint and publishMeetingHint, and
   * the note there about why neither `["time-entries"]` nor `["meetings"]` alone
   * could do the job.
   */
  app.get("/api/timesheet", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(timesheetQuerySchema, request.query, reply);
    if (query === undefined) return;
    try {
      return await timesheetTotals(db, { from: query.from, to: query.to }, filtersOf(query));
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * The same week, row by row: what the figure above is made of.
   *
   * ENTRIES AND MEETINGS TOGETHER, on the organisation's calendar days, each row
   * saying whether it counted and why not -- so the sentence's "2 meetings with
   * no recorded length" is something the operator can look at rather than an
   * assertion they must take on trust. See `timesheetDays`.
   */
  app.get("/api/timesheet/days", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(timesheetDaysQuerySchema, request.query, reply);
    if (query === undefined) return;
    try {
      return await timesheetDays(db, { from: query.from, to: query.to }, filtersOf(query));
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
