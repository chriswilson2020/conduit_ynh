import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { MAX_TIME_ENTRY_MINUTES, timeEntrySchema, timerStateSchema } from "@conduit/shared";
import type { SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, timeEntries, timers } from "../db/schema.js";
import { getRunningTimer, startTimer, stopTimer, discardTimer } from "./timers.js";
import { listTimeEntries } from "./time-entries.js";
import { timesheetTotals } from "./timesheet.js";
import { createProject } from "./projects.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createTask } from "./tasks.js";
import { subscribe } from "./sse.js";
import { NotFoundError, ConflictError } from "./errors.js";

const handle = openTestDatabase();
let actorId: string;

const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

async function seedProject(name = "Rollout"): Promise<string> {
  return (await createProject(handle.db, actorId, { name })).id;
}

/** services/timesheet.test.ts's helper, and for its reason: the clock that
 * decides which calendar day an instant fell on is the ORGANISATION's. */
async function setOrgTimeZone(zone: string): Promise<void> {
  await handle.db.execute(sql`
    INSERT INTO org_profile (id, time_zone) VALUES (1, ${zone})
    ON CONFLICT (id) DO UPDATE SET time_zone = EXCLUDED.time_zone
  `);
}

/**
 * Push a running timer's start back into the past.
 *
 * **THE ONLY WAY TO REACH THE RECOVERY BRANCH IN A TEST, and it writes SQL
 * rather than a Date for the reason `timers_stopped_after_start` taught the
 * schema drill:** the two instants on a timer have to come from ONE clock, so
 * anything moving `started_at` moves it relative to the database's `now()` and
 * not relative to this process's.
 */
async function backdate(id: string, minutes: number): Promise<void> {
  await handle.db.update(timers)
    .set({ startedAt: sql`now() - (${minutes} || ' minutes')::interval` })
    .where(eq(timers.id, id));
}

describe("the timer's running state", () => {
  /**
   * **THE SPEC'S FIRST REQUIREMENT, AND THE ONE A TEST CAN ACTUALLY MAKE.**
   * "Running state must survive a restart, a closed tab and a second device."
   * All three are the same property -- nothing about a running timer is held in
   * a process -- and this is that property stated as a query: a reader that
   * shares no state with the writer still sees it.
   */
  it("answers a running timer to a reader that shares nothing with the writer", async () => {
    const projectId = await seedProject();
    await startTimer(handle.db, actorId, { projectId, description: "Ingest rewrite" });

    // A SECOND CONNECTION, which is what a second device, a reloaded tab and a
    // restarted process all reduce to from the database's point of view.
    const second = openTestDatabase();
    try {
      const state = await getRunningTimer(second.db, actorId);
      expect(state.timer?.projectId).toBe(projectId);
      expect(state.timer?.description).toBe("Ingest rewrite");
      expect(() => timerStateSchema.parse(state)).not.toThrow();
    } finally {
      await second.close();
    }
  });

  it("answers nothing when nothing is running, rather than a 404", async () => {
    const state = await getRunningTimer(handle.db, actorId);
    expect(state.timer).toBeNull();
    expect(state.timeZone).toBe("UTC");
  });

  /**
   * **A TIMER IS ONE PERSON'S.** The strip is on every page, so a second
   * operator's clock appearing on this one's screen would be a running timer
   * they cannot account for and cannot stop.
   */
  it("does not answer somebody else's timer", async () => {
    const projectId = await seedProject();
    const other = await resolveUser(handle.db, { username: "sam", email: null, fullName: null });
    await startTimer(handle.db, other.id, { projectId });
    expect((await getRunningTimer(handle.db, actorId)).timer).toBeNull();
    expect((await getRunningTimer(handle.db, other.id)).timer).not.toBeNull();
  });

  /**
   * **THE DAY IS THE ORGANISATION'S, AND IT IS DECIDED HERE RATHER THAN ON THE
   * PHONE.** Task 2's rule -- `org_profile.time_zone` decides which calendar day
   * an instant fell on -- applied to the one instant this table holds. The two
   * zones below straddle midnight for the same instant, which is not a different
   * day but, at a week's end, a different WEEK.
   */
  it("puts the hours on the day the organisation's calendar has, not the device's", async () => {
    const projectId = await seedProject();
    const [timer] = await handle.db.insert(timers).values({
      ownerUserId: actorId, projectId,
      // 22:30 UTC on the 6th is the 7th in Amsterdam (UTC+2 in September).
      startedAt: new Date("2026-09-06T22:30:00.000Z"),
    }).returning();
    expect(timer).toBeDefined();

    await setOrgTimeZone("UTC");
    expect((await getRunningTimer(handle.db, actorId)).timer?.workDate).toBe("2026-09-06");

    await setOrgTimeZone("Europe/Amsterdam");
    const amsterdam = await getRunningTimer(handle.db, actorId);
    expect(amsterdam.timer?.workDate).toBe("2026-09-07");
    expect(amsterdam.timeZone).toBe("Europe/Amsterdam");
  });
});

describe("starting a timer", () => {
  it("starts one, stamps the actor as owner, and publishes the timer key", async () => {
    const projectId = await seedProject();
    const hints: SseHint[] = [];
    const off = subscribe((hint) => hints.push(hint));
    try {
      const state = await startTimer(handle.db, actorId, { projectId });
      expect(state.timer).not.toBeNull();
      const [row] = await handle.db.select().from(timers);
      expect(row?.ownerUserId).toBe(actorId);
      expect(row?.stoppedAt).toBeNull();
      expect(row?.timeEntryId).toBeNull();
    } finally { off(); }
    expect(hints.flatMap((h) => h.keys)).toContainEqual(["timer"]);
  });

  /**
   * **THE SECOND DEVICE, AND THIS IS THE DOUBLE COUNT THE SCHEMA CLOSES.** Two
   * timers running at once would each stop into an entry and book one afternoon
   * twice. The partial unique index refuses the second start, and this is the
   * service turning 23505 into a 409 rather than letting it out as a 500 -- with
   * the running timer's own id in the message, so a client can offer to stop
   * that one instead of merely saying no.
   */
  it("refuses a second timer with a conflict naming the one already running", async () => {
    const projectId = await seedProject();
    const first = await startTimer(handle.db, actorId, { projectId });
    await expect(startTimer(handle.db, actorId, { projectId })).rejects.toThrow(ConflictError);
    await expect(startTimer(handle.db, actorId, { projectId }))
      .rejects.toThrow(new RegExp(first.timer?.id ?? "never"));
    expect(await handle.db.select().from(timers)).toHaveLength(1);
  });

  it("lets a second person run their own timer at the same time", async () => {
    const projectId = await seedProject();
    const other = await resolveUser(handle.db, { username: "sam", email: null, fullName: null });
    await startTimer(handle.db, actorId, { projectId });
    await expect(startTimer(handle.db, other.id, { projectId })).resolves.toBeDefined();
  });

  /**
   * **REFUSED AT START, NOT AT STOP**, which is the recovery interaction's shape
   * showing up a day early: a timer with no link could not become an entry, and
   * finding that out at stop would hand the refusal to somebody holding hours
   * they cannot attach to anything.
   */
  it("refuses a timer attached to nothing before the clock ever starts", async () => {
    await expect(startTimer(handle.db, actorId, {})).rejects.toThrow(/at least one/);
    expect(await handle.db.select().from(timers)).toHaveLength(0);
  });

  // A 404 rather than the foreign key's 23503, which would reach a client as a
  // 500 -- assertLinkedRecordsExist's contract, shared with createTimeEntry.
  it("refuses a link naming a record that does not exist", async () => {
    await expect(startTimer(handle.db, actorId, { projectId: UNKNOWN_ID }))
      .rejects.toThrow(NotFoundError);
  });

  // ARCHIVED IS NOT DELETED, and booking time to a project that finished on
  // Friday is an ordinary thing to do -- meetings.ts's rule and
  // createTimeEntry's, inherited so the two capture paths cannot disagree about
  // what an hour may be attached to.
  it("starts against an archived record, because an hour is a record of the past", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    await archiveCompany(handle.db, actorId, company.id);
    await expect(startTimer(handle.db, actorId, { companyId: company.id })).resolves.toBeDefined();
  });

  it("stores a blank description as no description at all", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId, description: "   " });
    expect(state.timer?.description).toBeNull();
  });

  // NO TIMELINE EVENT, time-entries.ts's decision inherited: a week of honest
  // time-keeping is thirty timers, which would bury a record's actual history
  // under its own accounting.
  it("writes no timeline event", async () => {
    const projectId = await seedProject();
    const before = (await handle.db.select().from(events)).length;
    await startTimer(handle.db, actorId, { projectId });
    expect(await handle.db.select().from(events)).toHaveLength(before);
  });
});

describe("stopping a timer", () => {
  it("produces exactly one entry, on the timer's day, with the timer's links", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId, description: "Ingest rewrite" });
    const id = state.timer?.id ?? "";

    const entry = await stopTimer(handle.db, actorId, id, { minutes: 95, billable: true });
    expect(entry.minutes).toBe(95);
    expect(entry.workDate).toBe(state.timer?.workDate);
    expect(entry.projectId).toBe(projectId);
    expect(entry.billable).toBe(true);
    expect(entry.ownerUserId).toBe(actorId);
    // The timer's own words seed the entry's, so an operator who wrote what they
    // were starting does not type it again.
    expect(entry.description).toBe("Ingest rewrite");
    expect(() => timeEntrySchema.parse(entry)).not.toThrow();

    const { items } = await listTimeEntries(handle.db);
    expect(items).toHaveLength(1);
    // The timer is finished and CLAIMS the entry, which is what makes a second
    // stop impossible rather than merely unlikely.
    const [row] = await handle.db.select().from(timers);
    expect(row?.stoppedAt).not.toBeNull();
    expect(row?.timeEntryId).toBe(entry.id);
    expect((await getRunningTimer(handle.db, actorId)).timer).toBeNull();
  });

  /**
   * **THE OPERATOR STATES THE MINUTES AND THE CLOCK DOES NOT ARGUE.** The stop
   * writes what it is told, and deliberately does NOT cross-check the figure
   * against the elapsed time -- a cross-check would refuse exactly the
   * correction the recovery interaction exists to allow.
   */
  it("logs the minutes it was given rather than the minutes it measured", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    await backdate(id, 240);

    const entry = await stopTimer(handle.db, actorId, id, { minutes: 30, billable: false });
    expect(entry.minutes).toBe(30);
  });

  /**
   * **THE WEEKEND.** A timer running for 62 hours cannot become one entry --
   * `time_entries_minutes_range` is `<= 1440` because `work_date` is one day --
   * and the interaction that produces a real answer is the operator typing one.
   * What the service must guarantee is that the ONLY figure that can be written
   * is a legal one, whatever the clock says.
   */
  it("cannot be made to write a weekend, however long it ran", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    await backdate(id, 62 * 60);

    await expect(
      stopTimer(handle.db, actorId, id, { minutes: 62 * 60, billable: false }),
    ).rejects.toThrow();
    // AND THE TIMER IS STILL RUNNING after the refusal, which is the half that
    // matters: a failed stop that had already claimed the timer would leave the
    // operator with no clock and no hours.
    expect((await getRunningTimer(handle.db, actorId)).timer?.id).toBe(id);
    expect(await handle.db.select().from(timeEntries)).toHaveLength(0);

    /*
      THE ANSWER THEY GIVE INSTEAD LANDS ON THE DAY THE TIMER STARTED, WHICH IS
      THE POINT OF THE WEEKEND CASE AND NOT A DETAIL.

      Read AFTER the backdate deliberately: this same assertion written against
      the day the timer was CREATED went red here, because backdating moves the
      start day two days earlier -- which is exactly the property under test. A
      62-hour timer stopped on Monday books Friday, and the strip and the stop
      dialog say so before the operator commits, because `workDate` is on the
      running timer and not computed at stop.
    */
    const running = await getRunningTimer(handle.db, actorId);
    const entry = await stopTimer(handle.db, actorId, id, {
      minutes: MAX_TIME_ENTRY_MINUTES, billable: false,
    });
    expect(entry.minutes).toBe(MAX_TIME_ENTRY_MINUTES);
    expect(entry.workDate).toBe(running.timer?.workDate);
    expect(entry.workDate).not.toBe(state.timer?.workDate);
  });

  /**
   * **STOPPED TWICE IS STOPPED ONCE.** A double tap, a retried request, two
   * tabs: the claim is a guarded UPDATE inside the same transaction as the
   * INSERT, so the second stop finds `stopped_at` already set and writes
   * nothing at all.
   */
  it("refuses a second stop and produces no second entry", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    await stopTimer(handle.db, actorId, id, { minutes: 30, billable: false });

    await expect(stopTimer(handle.db, actorId, id, { minutes: 30, billable: false }))
      .rejects.toThrow(ConflictError);
    expect(await handle.db.select().from(timeEntries)).toHaveLength(1);
  });

  it("refuses a stop for a timer that is not this operator's", async () => {
    const projectId = await seedProject();
    const other = await resolveUser(handle.db, { username: "sam", email: null, fullName: null });
    const state = await startTimer(handle.db, other.id, { projectId });
    await expect(
      stopTimer(handle.db, actorId, state.timer?.id ?? "", { minutes: 30, billable: false }),
    ).rejects.toThrow(NotFoundError);
    expect(await handle.db.select().from(timeEntries)).toHaveLength(0);
  });

  it("refuses a stop for a timer that never existed", async () => {
    await expect(stopTimer(handle.db, actorId, UNKNOWN_ID, { minutes: 30, billable: false }))
      .rejects.toThrow(NotFoundError);
  });

  /**
   * **THE STOP IS ONE TRANSACTION, AND THIS IS WHAT THAT BUYS.** If the entry's
   * INSERT fails after the claim, the claim has to go with it -- otherwise the
   * timer is finished, no hours were written, and the operator's afternoon is
   * simply gone. Provoked with a link that vanishes, which the entry's own
   * foreign key refuses.
   */
  it("leaves the timer running when the entry cannot be written", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    // A minutes value the CHECK refuses, which is the failure that can really
    // happen here: the wire schema bounds it, and a direct service caller (this
    // one, and Task 5's own routes if the bound ever moved) does not.
    await expect(stopTimer(handle.db, actorId, id, { minutes: 99_999, billable: false }))
      .rejects.toThrow();

    const [row] = await handle.db.select().from(timers);
    expect(row?.stoppedAt).toBeNull();
    expect(row?.timeEntryId).toBeNull();
    expect((await getRunningTimer(handle.db, actorId)).timer?.id).toBe(id);
  });

  it("takes a description that replaces the timer's own", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId, description: "Guessing" });
    const entry = await stopTimer(handle.db, actorId, state.timer?.id ?? "", {
      minutes: 30, billable: false, description: "Actually the ingest rewrite",
    });
    expect(entry.description).toBe("Actually the ingest rewrite");
  });

  /**
   * The timer's keys AND the entry's, because a stop changes both halves of the
   * screen: the strip empties and the week grows. `["timesheet"]` is the one a
   * client on /timesheet needs and the one a naive implementation would miss,
   * since it publishes neither table's key on its own.
   */
  it("publishes the timer key and every key an entry write publishes", async () => {
    const projectId = await seedProject();
    const task = await createTask(handle.db, actorId, { title: "Migrate", projectId });
    const state = await startTimer(handle.db, actorId, { taskId: task.id });
    const hints: SseHint[] = [];
    const off = subscribe((hint) => hints.push(hint));
    let entryId = "";
    try {
      entryId = (await stopTimer(handle.db, actorId, state.timer?.id ?? "", {
        minutes: 30, billable: false,
      })).id;
    } finally { off(); }
    const keys = hints.flatMap((h) => h.keys);
    expect(keys).toContainEqual(["timer"]);
    expect(keys).toContainEqual(["time-entries"]);
    expect(keys).toContainEqual(["timesheet"]);
    expect(keys).toContainEqual(["time-entry", entryId]);
    // The task's booked-versus-estimated total moved, so its drawer has to hear.
    expect(keys).toContainEqual(["task", task.id]);
  });
});

describe("discarding a timer", () => {
  /**
   * **DISCARD IS THE OTHER WAY OUT OF THE WEEKEND, and it writes no hours.**
   * The row is kept, because Conduit never expunges and because this row is the
   * only record that the clock ever ran -- which is also why `timers.csv` is in
   * the export.
   */
  it("stops the clock, writes no entry, and keeps the row", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";

    const after = await discardTimer(handle.db, actorId, id);
    expect(after.timer).toBeNull();
    expect(await handle.db.select().from(timeEntries)).toHaveLength(0);
    const [row] = await handle.db.select().from(timers);
    expect(row?.id).toBe(id);
    expect(row?.stoppedAt).not.toBeNull();
    expect(row?.timeEntryId).toBeNull();
  });

  it("frees the operator to start another one", async () => {
    const projectId = await seedProject();
    const first = await startTimer(handle.db, actorId, { projectId });
    await discardTimer(handle.db, actorId, first.timer?.id ?? "");
    await expect(startTimer(handle.db, actorId, { projectId })).resolves.toBeDefined();
  });

  it("refuses a discard for a timer that is not running, or not this operator's", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    await discardTimer(handle.db, actorId, id);
    await expect(discardTimer(handle.db, actorId, id)).rejects.toThrow(ConflictError);

    const other = await resolveUser(handle.db, { username: "sam", email: null, fullName: null });
    const theirs = await startTimer(handle.db, other.id, { projectId });
    await expect(discardTimer(handle.db, actorId, theirs.timer?.id ?? ""))
      .rejects.toThrow(NotFoundError);
  });

  it("publishes the timer key", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const hints: SseHint[] = [];
    const off = subscribe((hint) => hints.push(hint));
    try {
      await discardTimer(handle.db, actorId, state.timer?.id ?? "");
    } finally { off(); }
    expect(hints.flatMap((h) => h.keys)).toContainEqual(["timer"]);
  });
});

describe("a running timer and the week's total", () => {
  /**
   * **A RUNNING TIMER IS IN NO TOTAL, AND IT CANNOT BE.** It is not a
   * `time_entries` row -- the schema has no way to hold a duration that is still
   * accruing -- and `timesheetTotals` reads `time_entries` and `meetings` and
   * nothing else. Asserted rather than argued, because "we do not count it" is
   * exactly the kind of claim that stops being true when somebody adds a third
   * source to that aggregate.
   *
   * It is the counterpart of Task 2's rule rather than a contradiction of it: an
   * hour excluded in SILENCE is that task's failure mode, and this exclusion is
   * not silent -- `timerSummary` says "nothing is counted until you stop it" in
   * a strip that is on every page, the timesheet included.
   */
  it("counts nothing while it runs, and the whole of it once it stops", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const id = state.timer?.id ?? "";
    await backdate(id, 300);
    // Read after the backdate: five hours ago can be yesterday, and the day the
    // hours will land on is the timer's START day.
    const day = (await getRunningTimer(handle.db, actorId)).timer?.workDate ?? "";

    const before = await timesheetTotals(handle.db, { from: day, to: day });
    expect(before.countedMinutes).toBe(0);
    expect(before.entryCount).toBe(0);

    await stopTimer(handle.db, actorId, id, { minutes: 300, billable: true });
    const after = await timesheetTotals(handle.db, { from: day, to: day });
    expect(after.countedMinutes).toBe(300);
    expect(after.entryCount).toBe(1);
    expect(after.billableEntryMinutes).toBe(300);
  });

  /**
   * **AND THE ENTRY IT PRODUCES IS AN ORDINARY ENTRY**, correctable the only way
   * any hour is correctable: archive it. The timer that produced it keeps its
   * claim, which is what stops the archive being read as "the timer never ran".
   */
  it("leaves an ordinary, archivable entry behind", async () => {
    const projectId = await seedProject();
    const state = await startTimer(handle.db, actorId, { projectId });
    const entry = await stopTimer(handle.db, actorId, state.timer?.id ?? "", {
      minutes: 60, billable: false,
    });
    await handle.db.update(timeEntries)
      .set({ archivedAt: new Date() }).where(eq(timeEntries.id, entry.id));
    const totals = await timesheetTotals(handle.db, { from: entry.workDate, to: entry.workDate });
    expect(totals.countedMinutes).toBe(0);
    const [timer] = await handle.db.select().from(timers);
    expect(timer?.timeEntryId).toBe(entry.id);
  });
});
