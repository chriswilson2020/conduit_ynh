import type { FastifyInstance } from "fastify";
import { timerStartInputSchema, timerStopInputSchema } from "@conduit/shared";
import type { CrmRouteDeps } from "./index.js";
import { requireUser, mapDomainError, parseOrReject, idParamSchema } from "./helpers.js";
import { getRunningTimer, startTimer, stopTimer, discardTimer } from "../services/timers.js";

/**
 * **THE TIMER'S FOUR ROUTES (Phase 10 Task 5).**
 *
 * `GET /api/timer` is the one every page in the app calls, because the running
 * timer's strip is in the shell rather than on a page -- see
 * components/timer-strip.tsx for why a timer visible only on /timesheet is a
 * timer nobody notices they left running. It is one indexed lookup
 * (`timers_one_running_per_owner` serves both the constraint and this read) plus
 * the org profile, and it answers `{ timer: null }` rather than a 404 when
 * nothing is running: "no timer" is this endpoint's ordinary state, and a strip
 * that had to tell a 404 from a network failure would show a stopwatch whenever
 * the server was down.
 *
 * **NOTHING HERE TAKES AN OWNER.** The timer is the CALLING operator's, at every
 * one of these routes, and `services/timers.ts` filters by owner on the read as
 * well as the writes. A timer is personal state on a surface that is on every
 * page; somebody else's clock appearing there would be one this operator cannot
 * account for and cannot stop.
 *
 * **THE ID IS IN THE PATH FOR STOP AND DISCARD, AND THAT IS NOT DECORATION.**
 * At most one timer can be running per person, so `POST /api/timer/stop` with no
 * id would have been enough -- and would have been wrong in exactly the case
 * this feature exists to handle. Two devices: the laptop stops the timer and
 * starts a new one on another project; the phone's strip is a minute stale and
 * its Stop button fires. Without the id, the phone stops the NEW timer and books
 * its minutes to the wrong record. With it, the server answers 409 for a timer
 * that is already finished, and the phone refetches.
 *
 * **NO `.refine` ON EITHER BODY SCHEMA, WHICH IS DELIBERATE AFTER TASK 4.**
 * Measured there on zod 4.4.3: a `.refine` runs even when the object's own
 * fields have already failed, and is handed the RAW value -- so one that does
 * more than compare parsed primitives can be given rubbish, and one that throws
 * turns a 400 into a 500. `timerStartInputSchema`'s superRefine only reads
 * optional uuid fields and cannot throw on anything; `timerStopInputSchema` has
 * none at all.
 */
export function registerTimerRoutes(app: FastifyInstance, { db }: CrmRouteDeps): void {
  app.get("/api/timer", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    return getRunningTimer(db, user.id);
  });

  // 409 `conflict` when a timer is already running, from the partial unique
  // index rather than from a read-then-write: two devices pressing Start at the
  // same instant is exactly the race a check-first would lose. The message names
  // the running timer's id so a client can offer to stop THAT one.
  app.post("/api/timer", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    // A body with no link is a 400 here, from timerStartInputSchema's
    // superRefine, and never a 500 from `timers_has_link` -- and the refusal
    // arrives while the operator is still looking at the record picker rather
    // than at stop, holding hours with nothing to attach them to.
    const input = parseOrReject(timerStartInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return reply.code(201).send(await startTimer(db, user.id, input));
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  /**
   * Stop the clock and book the hours: **201, because this creates a time
   * entry**, and the entry is what it returns.
   *
   * `minutes` IS REQUIRED IN THE BODY AND THE SERVER NEVER SUBSTITUTES THE
   * ELAPSED TIME. That is the recovery interaction, and this is the route where
   * it would have been easiest to get wrong: an optional `minutes` defaulting to
   * the clock would be perfectly pleasant for the ordinary stop and would have
   * NO LEGAL VALUE for the 62-hour weekend, which is the case the whole feature
   * is about. So the client proposes (@conduit/shared's `timerProposedMinutes`
   * withholds the proposal when the clock's answer is not a storable number of
   * minutes) and the operator states.
   */
  app.post("/api/timer/:id/stop", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    const input = parseOrReject(timerStopInputSchema, request.body, reply);
    if (input === undefined) return;
    try {
      return reply.code(201).send(await stopTimer(db, user.id, params.id, input));
    } catch (error) {
      mapDomainError(reply, error);
    }
  });

  // Stop the clock and write nothing. The row is KEPT -- Conduit never expunges,
  // and a discarded timer is the only record that the clock ever ran, which is
  // why `timers.csv` is in the export. Answers the timer state, which is now
  // empty, so a client can replace its cache rather than infer.
  app.post("/api/timer/:id/discard", async (request, reply) => {
    const user = requireUser(request, reply);
    if (user === null) return;
    const params = parseOrReject(idParamSchema, request.params, reply);
    if (params === undefined) return;
    try {
      return await discardTimer(db, user.id, params.id);
    } catch (error) {
      mapDomainError(reply, error);
    }
  });
}
