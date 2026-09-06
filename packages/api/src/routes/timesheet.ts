import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject } from "./helpers.js";
import { timesheetTotals } from "../services/timesheet.js";

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
 */
const timesheetQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
}).refine((v) => v.from <= v.to, {
  message: "from must be on or before to",
});

export function registerTimesheetRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  /**
   * The week's answer: minutes logged by hand, minutes from meetings, and every
   * meeting this report could not count.
   *
   * READ-ONLY AND DERIVED FROM NOTHING BUT THE TWO TABLES, so there is no cursor,
   * no archived arm and no SSE key -- a client refetches it on the
   * `["time-entries"]` and `["meetings"]` hints the two mutators already publish.
   *
   * NO RECORD FILTERS, deliberately, and the reason is the plan's own: the five
   * record foreign keys on `time_entries` are unindexed (0021 builds only
   * `(work_date DESC, id DESC)`), and Task 4 is the task that gains readers for
   * them and builds them with a measurement. A filter shipped here would be an
   * unindexed scan with no page asking for it. The billable split is Task 4's for
   * the same reason.
   */
  app.get("/api/timesheet", async (request, reply) => {
    if (requireUser(request, reply) === null) return;
    const query = parseOrReject(timesheetQuerySchema, request.query, reply);
    if (query === undefined) return;
    try {
      return await timesheetTotals(db, { from: query.from, to: query.to });
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
