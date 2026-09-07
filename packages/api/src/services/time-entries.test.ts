import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  timeEntryCreateInputSchema, timeEntryUpdateInputSchema, timeEntryAtLeastOneLink,
  timeEntrySchema, MAX_TIME_ENTRY_MINUTES,
} from "@conduit/shared";
import type { SseHint } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { events, timeEntries } from "../db/schema.js";
import {
  createTimeEntry, getTimeEntry, updateTimeEntry, archiveTimeEntry, unarchiveTimeEntry,
  listTimeEntries,
} from "./time-entries.js";
import { createCompany, archiveCompany } from "./companies.js";
import { createContact } from "./contacts.js";
import { createPipeline, createStage } from "./pipelines.js";
import { createDeal } from "./deals.js";
import { createProject, archiveProject } from "./projects.js";
import { createTask } from "./tasks.js";
import { subscribe } from "./sse.js";
import { NotFoundError, ArchivedError, ConflictError } from "./errors.js";
import { decodeWorkDateCursor, decodeCursor } from "./pagination.js";

const handle = openTestDatabase();
let actorId: string;

const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(async () => {
  await truncateAll(handle);
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});
afterAll(async () => { await handle.close(); });

/** A project to hang entries on, since every entry needs at least one link. */
async function seedProject(name = "Rollout"): Promise<string> {
  return (await createProject(handle.db, actorId, { name })).id;
}

/**
 * A `Database` whose FIRST completed read runs `onRead` before the caller sees
 * its rows -- i.e. something else got in between a service's read and its write.
 *
 * WHY A PROXY AND NOT TWO CONCURRENT CALLS. The window under test is a few
 * statements wide, so `Promise.all([update, archive])` would land inside it on
 * some runs and outside it on others: a test that is green either way, and a
 * flake when it is not. This makes the interleave the ONLY thing that can
 * happen.
 *
 * `Reflect.get(t, prop)` READS FROM THE TARGET, not through the receiver, and
 * every function is applied with `this === target`. Drizzle's builders use
 * private class fields, and a method invoked with the proxy as `this` throws
 * "cannot read private member" -- which would have failed as a mysterious
 * driver error rather than as a wrong answer.
 *
 * The wrapper re-wraps whatever a method returns, because drizzle's builders are
 * chainable: `db.select()` hands back one object and `.from(...).where(...)`
 * hand back the same one, so a proxy that stopped at the first call would have
 * nothing left to intercept by the time the query is awaited.
 */
function afterFirstRead(db: Database, onRead: () => Promise<void>): Database {
  let armed = true;
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop) as unknown;
      if (prop === "then" && typeof value === "function") {
        const then = value as (
          onFulfilled: (rows: unknown) => unknown, onRejected?: (err: unknown) => unknown,
        ) => unknown;
        return (resolve: (rows: unknown) => unknown, reject?: (err: unknown) => unknown) =>
          then.call(t, (rows: unknown) => {
            if (!armed) return resolve(rows);
            armed = false;
            return onRead().then(() => resolve(rows), reject);
          }, reject);
      }
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(t, args);
          return typeof out === "object" && out !== null ? wrap(out) : out;
        };
      }
      return value;
    },
  });
  return wrap(db as unknown as object) as unknown as Database;
}

describe("time entries service", () => {
  it("creates an entry, stamps the actor as owner, and writes NO timeline event", async () => {
    const projectId = await seedProject();
    // THE BASELINE IS TAKEN AFTER THE PROJECT EXISTS, and the first version of
    // this test forgot that and asserted an empty `events` table -- red, because
    // createProject writes its own `created` row. An absolute assertion here
    // would have been testing the project service; the delta is what tests this
    // one.
    const before = (await handle.db.select().from(events)).length;
    expect(before).toBe(1);

    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 90, billable: true,
      description: "Data migration dry run", projectId,
    });

    expect(entry.minutes).toBe(90);
    expect(entry.workDate).toBe("2026-09-01");
    expect(entry.billable).toBe(true);
    expect(entry.description).toBe("Data migration dry run");
    // The owner is the actor and nothing in the input names one.
    expect(entry.ownerUserId).toBe(actorId);
    expect(entry.projectId).toBe(projectId);
    expect(entry.archivedAt).toBeNull();
    // The shape a client parses, asserted here rather than assumed: a field this
    // service forgot to map would be a parse error in the browser and nowhere
    // else.
    expect(() => timeEntrySchema.parse(entry)).not.toThrow();

    // NO EVENT, which is this file's one deliberate departure from every other
    // content writer -- see the service header. Asserted, because "we did not
    // write one" is exactly the kind of claim that quietly stops being true.
    const after = await handle.db.select().from(events);
    expect(after).toHaveLength(before);
    expect(after.map((e) => e.verb)).toEqual(["created"]);
  });

  it("writes no timeline event on a patch or an archive either", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    const before = (await handle.db.select().from(events)).length;

    await updateTimeEntry(handle.db, actorId, entry.id, { minutes: 90 });
    await archiveTimeEntry(handle.db, actorId, entry.id);
    await unarchiveTimeEntry(handle.db, actorId, entry.id);

    // Meetings DO emit archived/unarchived rows, so this is a real difference
    // between the two files rather than a gap nobody got to -- see the service
    // header for why a record's timeline is not where an hour belongs.
    expect(await handle.db.select().from(events)).toHaveLength(before);
  });

  it("stores an omitted description as null, and a blank one as null too", async () => {
    const projectId = await seedProject();
    const omitted = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 30, billable: false, projectId,
    });
    expect(omitted.description).toBeNull();

    // "   " is not "" and would otherwise be stored as a described entry that
    // renders blank everywhere -- the trim is what makes the rule bite.
    const blank = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 30, billable: false, description: "   ", projectId,
    });
    expect(blank.description).toBeNull();

    const trimmed = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 30, billable: false, description: "  Reviewed the spec  ", projectId,
    });
    expect(trimmed.description).toBe("Reviewed the spec");
  });

  it("stores billable both ways, and never decides it on the caller's behalf", async () => {
    const projectId = await seedProject();
    const billable = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    const internal = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: false, projectId,
    });
    expect(billable.billable).toBe(true);
    expect(internal.billable).toBe(false);

    // THE WIRE SHAPE REQUIRES IT. A create body with no `billable` is a 400 at
    // the route, not a row that defaulted to something nobody chose -- which is
    // the same rule the column's missing DEFAULT states in the database.
    const parsed = timeEntryCreateInputSchema.safeParse({
      workDate: "2026-09-01", minutes: 60, projectId,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("billable");
  });

  /**
   * **THE LINK RULE, THROUGH THE SERVICE**, where a client meets it as a 4xx
   * rather than as a 500 from the CHECK.
   */
  it("refuses an entry attached to nothing, at the wire and at the service", async () => {
    const parsed = timeEntryCreateInputSchema.safeParse({
      workDate: "2026-09-01", minutes: 60, billable: true,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("at least one of");

    // AND AT THE SERVICE, for a direct caller that never meets zod -- which is
    // exactly what Task 5's timer will be. Without this the CHECK raises 23514
    // and the operator sees a 500.
    await expect(createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true,
    })).rejects.toThrow(/at least one of/);
    // Nothing was written on the way to that refusal.
    expect(await handle.db.select().from(timeEntries)).toEqual([]);
  });

  it("accepts an hour that belongs to a project AND the deal it came from", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId,
      { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }, "EUR",
    );
    const projectId = await seedProject();

    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 120, billable: true, dealId: deal.id, projectId,
    });
    expect(entry.dealId).toBe(deal.id);
    expect(entry.projectId).toBe(projectId);
    // ...and it is on both records' lists, which is the point of not making the
    // operator choose.
    expect((await listTimeEntries(handle.db, { dealId: deal.id })).items.map((e) => e.id))
      .toEqual([entry.id]);
    expect((await listTimeEntries(handle.db, { projectId })).items.map((e) => e.id))
      .toEqual([entry.id]);
  });

  it("books time against a task", async () => {
    const projectId = await seedProject();
    const task = await createTask(handle.db, actorId, { title: "Migrate the data", projectId });
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 45, billable: true, taskId: task.id,
    });
    expect(entry.taskId).toBe(task.id);
    expect((await listTimeEntries(handle.db, { taskId: task.id })).items.map((e) => e.id))
      .toEqual([entry.id]);
  });

  it("404s for a record that does not exist, on each of the five links", async () => {
    const links = ["companyId", "contactId", "dealId", "projectId", "taskId"] as const;
    for (const link of links) {
      await expect(
        createTimeEntry(handle.db, actorId, {
          workDate: "2026-09-01", minutes: 60, billable: true, [link]: UNKNOWN_ID,
        }),
        `${link} did not 404`,
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  /**
   * EXISTENCE, NOT ACTIVENESS -- meetings.ts's rule, not notes.ts's. Booking the
   * hours you actually spent on a project that finished on Friday is an ordinary
   * thing to do, and a timesheet that refused them would be refusing the truth.
   */
  it("books time against an archived company and an archived project", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const projectId = await seedProject();
    await archiveCompany(handle.db, actorId, company.id);
    await archiveProject(handle.db, actorId, projectId);

    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, companyId: company.id, projectId,
    });
    expect(entry.companyId).toBe(company.id);
    expect(entry.projectId).toBe(projectId);
  });

  it("reads one entry back, and 404s for an id that is not there", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    expect((await getTimeEntry(handle.db, entry.id)).id).toBe(entry.id);
    await expect(getTimeEntry(handle.db, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("time entries update", () => {
  it("patches each field, and leaves the ones it was not given alone", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, description: "First pass", projectId,
    });

    const patched = await updateTimeEntry(handle.db, actorId, entry.id, {
      minutes: 75, workDate: "2026-09-02", billable: false, description: "Second pass",
    });
    expect(patched).toMatchObject({
      minutes: 75, workDate: "2026-09-02", billable: false, description: "Second pass",
      projectId, ownerUserId: actorId,
    });

    // Each field is separately reachable: a patch naming only one moves only it.
    const onlyMinutes = await updateTimeEntry(handle.db, actorId, entry.id, { minutes: 30 });
    expect(onlyMinutes).toMatchObject({
      minutes: 30, workDate: "2026-09-02", billable: false, description: "Second pass",
    });
  });

  it("clears a description to null through an explicit null", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, description: "Typed by mistake", projectId,
    });
    const cleared = await updateTimeEntry(handle.db, actorId, entry.id, { description: null });
    expect(cleared.description).toBeNull();
  });

  it("is a true no-op for an empty patch, down to updated_at", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    const same = await updateTimeEntry(handle.db, actorId, entry.id, {});
    expect(same.updatedAt).toBe(entry.updatedAt);
  });

  /**
   * **THE MERGED-ROW RULE**, which is the half a patch schema cannot hold.
   *
   * Clearing one link of two is legitimate; clearing the last one is a 409 with
   * a message saying what to do instead. Both go through the SAME stored row, so
   * a service that checked the patch alone would get both of them wrong.
   */
  it("lets a patch clear one link of two, and refuses the one that empties the last", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, companyId: company.id, projectId,
    });

    const stillLinked = await updateTimeEntry(handle.db, actorId, entry.id, { companyId: null });
    expect(stillLinked.companyId).toBeNull();
    expect(stillLinked.projectId).toBe(projectId);

    await expect(updateTimeEntry(handle.db, actorId, entry.id, { projectId: null }))
      .rejects.toBeInstanceOf(ConflictError);
    // The message tells the client what would work, rather than restating the
    // rule it just broke.
    await expect(updateTimeEntry(handle.db, actorId, entry.id, { projectId: null }))
      .rejects.toThrow(/set another link in the same patch, or archive/);
    // And the entry is untouched, so the refusal cost nothing.
    expect((await getTimeEntry(handle.db, entry.id)).projectId).toBe(projectId);
  });

  it("lets a patch swap the last link for a different one in the same request", async () => {
    const projectId = await seedProject();
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    const swapped = await updateTimeEntry(handle.db, actorId, entry.id, {
      projectId: null, companyId: company.id,
    });
    expect(swapped).toMatchObject({ projectId: null, companyId: company.id });
  });

  it("refuses a patch against an archived entry, and 404s for one that is not there", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    await archiveTimeEntry(handle.db, actorId, entry.id);
    await expect(updateTimeEntry(handle.db, actorId, entry.id, { minutes: 30 }))
      .rejects.toBeInstanceOf(ArchivedError);
    await expect(updateTimeEntry(handle.db, actorId, UNKNOWN_ID, { minutes: 30 }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * **THE ATOMIC GUARD, WHICH A MUTATION RUN FOUND NOTHING WAS HOLDING.**
   *
   * `updateTimeEntry` checks `existing.archivedAt` after its read AND carries
   * `archived_at IS NULL` in the UPDATE's own WHERE. Deleting the second one was
   * GREEN across every other test in this file, because the first one catches
   * every case a single-threaded test can produce -- so the guard that exists
   * for the RACE was, until this test, decoration.
   *
   * (The same guard on `updateCompany` and `updateMeeting` has no test either,
   * which is where the shape came from. This is the first one in the codebase
   * that is actually held.)
   *
   * THE INTERLEAVE IS MADE DETERMINISTIC RATHER THAN RACED FOR. `afterFirstRead`
   * hands the service a `db` whose FIRST completed read archives the row before
   * the caller sees the rows -- which is precisely the window: the service's
   * `mustGet` has already returned a live row, and by the time its UPDATE runs
   * the database says otherwise. Two `Promise.all`d calls would test the same
   * thing on the runs where the ordering happened to land, and pass on the rest.
   */
  it("refuses a patch that raced a concurrent archive, from the WHERE and not only from the read", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });

    const racing = afterFirstRead(handle.db, async () => {
      await handle.db.update(timeEntries)
        .set({ archivedAt: new Date() }).where(eq(timeEntries.id, entry.id));
    });

    await expect(updateTimeEntry(racing, actorId, entry.id, { minutes: 30 }))
      .rejects.toBeInstanceOf(ArchivedError);
    // AND NOTHING WAS WRITTEN, which is the half that matters: the refusal is
    // worth nothing if the UPDATE landed and only the report of it failed.
    const [row] = await handle.db.select().from(timeEntries).where(eq(timeEntries.id, entry.id));
    expect(row?.minutes).toBe(60);

    // The instrument, proved rather than trusted: the same wrapper with a
    // callback that changes nothing lets an ordinary patch through, so the
    // refusal above is the archive and not the proxy.
    const inert = afterFirstRead(handle.db, async () => { /* nothing races */ });
    await unarchiveTimeEntry(handle.db, actorId, entry.id);
    expect((await updateTimeEntry(inert, actorId, entry.id, { minutes: 45 })).minutes).toBe(45);
  });

  it("404s for a record that does not exist in a patch", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    await expect(updateTimeEntry(handle.db, actorId, entry.id, { companyId: UNKNOWN_ID }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  // The bound lives in the wire schema as well as in the database, so a patch of
  // 1441 minutes is a 400 rather than a 23514 wearing a 500.
  it("bounds minutes on the wire, both ways, at the same edge the column has", async () => {
    expect(timeEntryUpdateInputSchema.safeParse({ minutes: MAX_TIME_ENTRY_MINUTES }).success).toBe(true);
    expect(timeEntryUpdateInputSchema.safeParse({ minutes: MAX_TIME_ENTRY_MINUTES + 1 }).success).toBe(false);
    expect(timeEntryUpdateInputSchema.safeParse({ minutes: 0 }).success).toBe(false);
    expect(timeEntryUpdateInputSchema.safeParse({ minutes: 1.5 }).success).toBe(false);
  });
});

describe("time entries archive", () => {
  /**
   * ARCHIVING IS THE ONLY WAY AN HOUR LEAVES A TOTAL. There is no delete, and an
   * entry cannot be corrected to zero either (the CHECK refuses it), so without
   * this a duplicated afternoon would sit in the week for ever.
   */
  it("takes an entry out of the live list and puts it in the archived one, reversibly", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });

    const archived = await archiveTimeEntry(handle.db, actorId, entry.id);
    expect(archived.archivedAt).not.toBeNull();
    expect((await listTimeEntries(handle.db)).items).toEqual([]);
    expect((await listTimeEntries(handle.db, { archived: true })).items.map((e) => e.id))
      .toEqual([entry.id]);

    const restored = await unarchiveTimeEntry(handle.db, actorId, entry.id);
    expect(restored.archivedAt).toBeNull();
    expect((await listTimeEntries(handle.db)).items.map((e) => e.id)).toEqual([entry.id]);
  });

  it("is idempotent, and 404s for an entry that is not there", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    await archiveTimeEntry(handle.db, actorId, entry.id);
    const again = await archiveTimeEntry(handle.db, actorId, entry.id);
    expect(again.archivedAt).not.toBeNull();
    await expect(archiveTimeEntry(handle.db, actorId, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(unarchiveTimeEntry(handle.db, actorId, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("publishes on a real archive and stays silent on a no-op one", async () => {
    const projectId = await seedProject();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });

    const hints: SseHint[] = [];
    const stop = subscribe((hint) => hints.push(hint));
    try {
      await archiveTimeEntry(handle.db, actorId, entry.id);
      expect(hints).toHaveLength(1);
      expect(hints[0]?.keys).toContainEqual(["time-entries"]);
      expect(hints[0]?.keys).toContainEqual(["time-entry", entry.id]);
      // `["timesheet"]` (Task 4): the week's page reads time_entries AND
      // meetings, and a TanStack query has ONE key -- so it cannot be nested
      // under either table's and both mutators publish this one instead.
      // Archiving is how an hour leaves a total, so the week has to hear about
      // it as surely as the task does.
      expect(hints[0]?.keys).toContainEqual(["timesheet"]);
      // The second archive changes nothing, so it must not tell every client to
      // refetch -- companies.ts's and meetings.ts's rule.
      await archiveTimeEntry(handle.db, actorId, entry.id);
      expect(hints).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

/**
 * **THE TASK KEY (v1.9.0), WHICH IS THE RIPPLE TASK 3'S ESTIMATE PRODUCED.**
 *
 * `GET /api/tasks/:id/effort` answers a booked figure whose ONLY source is a
 * write in this file, and until v1.9.0 nothing on a task surface listened to
 * `["time-entries"]` at all. Without these keys the drawer's
 * booked-versus-estimated sentence stands still while the hours behind it change
 * -- one half of a comparison going stale, which is the failure mode this whole
 * phase is about arriving through a cache.
 *
 * `["task", id]` IS THE SAME KEY `publishTaskHint` USES, so TanStack's
 * prefix-matched invalidation reaches the deeper `["task", id, "effort"]` cache
 * without a key of its own -- exactly how the drawer's dependency list already
 * works.
 */
describe("time entries: the task an hour was booked to hears about it", () => {
  async function taskId(): Promise<string> {
    return (await createTask(handle.db, actorId, { title: "Draft the plan" })).id;
  }

  it("publishes the task's key when an entry names one, and does not invent one when it does not", async () => {
    const id = await taskId();
    const projectId = await seedProject();

    const hints: SseHint[] = [];
    const stop = subscribe((hint) => hints.push(hint));
    try {
      await createTimeEntry(handle.db, actorId, {
        workDate: "2026-09-08", minutes: 60, billable: true, taskId: id,
      });
      expect(hints[0]?.keys).toContainEqual(["task", id]);
      // The week hears about every entry, task or no task -- see the archive
      // test above for why the timesheet cannot listen to `["time-entries"]`.
      expect(hints[0]?.keys).toContainEqual(["timesheet"]);

      // An entry on a project and no task has no task key to publish -- and a
      // key for a null id would be one every drawer in the app would refetch on.
      await createTimeEntry(handle.db, actorId, {
        workDate: "2026-09-08", minutes: 60, billable: true, projectId,
      });
      expect(hints[1]?.keys.map((k) => k[0])).not.toContain("task");
    } finally {
      stop();
    }
  });

  /**
   * **RE-LINKING AN ENTRY CHANGES TWO TASKS' TOTALS**, and a drawer open on the
   * task the hour LEFT is exactly as stale as one open on the task it arrived
   * at. `publishTaskHint`'s `extraAssigneeIds` shape, one table over.
   */
  it("publishes BOTH tasks when an entry is moved from one to the other", async () => {
    const from = await taskId();
    const to = await taskId();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true, taskId: from,
    });

    const hints: SseHint[] = [];
    const stop = subscribe((hint) => hints.push(hint));
    try {
      await updateTimeEntry(handle.db, actorId, entry.id, { taskId: to });
      const keys = hints[hints.length - 1]?.keys.map((k) => k.join(":")) ?? [];
      expect(keys).toContain(`task:${from}`);
      expect(keys).toContain(`task:${to}`);
    } finally {
      stop();
    }
  });

  it("publishes the task's key when an hour is archived out of its total", async () => {
    const id = await taskId();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true, taskId: id,
    });

    const hints: SseHint[] = [];
    const stop = subscribe((hint) => hints.push(hint));
    try {
      await archiveTimeEntry(handle.db, actorId, entry.id);
      expect(hints[0]?.keys).toContainEqual(["task", id]);
      await unarchiveTimeEntry(handle.db, actorId, entry.id);
      expect(hints[1]?.keys).toContainEqual(["task", id]);
    } finally {
      stop();
    }
  });

  /** One key per task, not one per mention: the ordinary patch names the same
   * task twice (pre- and post-), and a client asked to refetch the same query
   * twice is a request nobody needed. */
  it("names a task once when a patch leaves its link alone", async () => {
    const id = await taskId();
    const entry = await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-08", minutes: 60, billable: true, taskId: id,
    });

    const hints: SseHint[] = [];
    const stop = subscribe((hint) => hints.push(hint));
    try {
      await updateTimeEntry(handle.db, actorId, entry.id, { minutes: 90 });
      const keys = hints[hints.length - 1]?.keys.filter((k) => k[0] === "task") ?? [];
      expect(keys).toEqual([["task", id]]);
    } finally {
      stop();
    }
  });
});

describe("time entries list", () => {
  /** Entries on consecutive days, oldest first, all on one project. */
  async function seedWeek(projectId: string, days: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const workDate of days) {
      ids.push((await createTimeEntry(handle.db, actorId, {
        workDate, minutes: 60, billable: true, projectId,
      })).id);
    }
    return ids;
  }

  /**
   * BY THE DAY THE WORK WAS DONE, NEWEST FIRST -- not by created_at.
   *
   * The rows are typed in an order that DISAGREES with their dates, so a service
   * ordering by creation comes out wrong here rather than passing by coincidence.
   * That mistake is the one an operator reads as "I never logged Monday".
   */
  it("orders by work date and not by the order the entries were typed", async () => {
    const projectId = await seedProject();
    await createTimeEntry(handle.db, actorId, { workDate: "2026-09-02", minutes: 60, billable: true, projectId });
    await createTimeEntry(handle.db, actorId, { workDate: "2026-09-04", minutes: 60, billable: true, projectId });
    await createTimeEntry(handle.db, actorId, { workDate: "2026-09-03", minutes: 60, billable: true, projectId });

    expect((await listTimeEntries(handle.db)).items.map((e) => e.workDate))
      .toEqual(["2026-09-04", "2026-09-03", "2026-09-02"]);
  });

  it("filters an inclusive date range, both ends", async () => {
    const projectId = await seedProject();
    await seedWeek(projectId, ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);

    const week = await listTimeEntries(handle.db, { from: "2026-09-01", to: "2026-09-03" });
    // BOTH ENDS INCLUSIVE. An exclusive upper bound silently drops the last day
    // of the range, which is the off-by-one that makes a week's total short
    // without making it look short.
    expect(week.items.map((e) => e.workDate))
      .toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
  });

  it("filters by each of the five records", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const contact = await createContact(handle.db, actorId, { firstName: "Bob" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId, { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const projectId = await seedProject();
    const task = await createTask(handle.db, actorId, { title: "Migrate", projectId });

    const byLink = {
      companyId: company.id, contactId: contact.id, dealId: deal.id,
      projectId, taskId: task.id,
    } as const;
    const ids: Record<string, string> = {};
    for (const [link, id] of Object.entries(byLink)) {
      ids[link] = (await createTimeEntry(handle.db, actorId, {
        workDate: "2026-09-01", minutes: 60, billable: true, [link]: id,
      })).id;
    }

    for (const [link, id] of Object.entries(byLink)) {
      const found = await listTimeEntries(handle.db, { [link]: id });
      expect(found.items.map((e) => e.id), `filtering by ${link}`).toEqual([ids[link]]);
    }
  });

  it("pages by (work_date, id) with a cursor no other list can mint", async () => {
    const projectId = await seedProject();
    await seedWeek(projectId, ["2026-09-01", "2026-09-02", "2026-09-03"]);

    const first = await listTimeEntries(handle.db, { limit: 2 });
    expect(first.items.map((e) => e.workDate)).toEqual(["2026-09-03", "2026-09-02"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listTimeEntries(handle.db, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((e) => e.workDate)).toEqual(["2026-09-01"]);
    expect(second.nextCursor).toBeNull();

    // THE CURSOR IS THIS ORDERING'S OWN. A created_at decoder must not accept it,
    // which is what makes a foreign cursor a 400 at the route rather than a page
    // taken from a value that means something else entirely.
    expect(decodeWorkDateCursor(first.nextCursor!)).not.toBeNull();
    expect(decodeCursor(first.nextCursor!)).toBeNull();
  });

  it("breaks a same-day tie by id, so a page boundary inside one day loses nothing", async () => {
    const projectId = await seedProject();
    // Five entries on ONE day: without the id tiebreaker the second page can
    // repeat or skip rows, and a whole day fitting in one page would hide it.
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      ids.add((await createTimeEntry(handle.db, actorId, {
        workDate: "2026-09-01", minutes: 30, billable: true, projectId,
      })).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: { items: { id: string }[]; nextCursor: string | null } =
        await listTimeEntries(handle.db, { limit: 2, cursor: cursor ?? undefined });
      seen.push(...result.items.map((e) => e.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen)).toEqual(ids);
    expect(seen).toHaveLength(5);
  });

  it("caps the page size at 100 however large a limit is asked for", async () => {
    expect((await listTimeEntries(handle.db, { limit: 1000 })).items).toEqual([]);
    // The cap is on the service, not on the schema alone: the wire schema
    // refuses > 100, and a direct caller meets the same ceiling here.
    const projectId = await seedProject();
    await createTimeEntry(handle.db, actorId, {
      workDate: "2026-09-01", minutes: 60, billable: true, projectId,
    });
    expect((await listTimeEntries(handle.db, { limit: 1000 })).items).toHaveLength(1);
  });
});

describe("the at-least-one predicate", () => {
  /**
   * ONE RULE IN TWO PLACES, and this is the one place both spellings can be
   * compared. The predicate is what the wire refine and updateTimeEntry's merge
   * both call; the CHECK is what stands behind them. A predicate that disagreed
   * with the CHECK would turn a 4xx into a 500 (or, worse, admit a row the
   * database then refuses inside a transaction that has already done work).
   */
  it("agrees with the CHECK on every combination of the five", async () => {
    const company = await createCompany(handle.db, actorId, { name: "Acme" });
    const links = ["companyId", "contactId", "dealId", "projectId", "taskId"] as const;
    const contact = await createContact(handle.db, actorId, { firstName: "Bob" });
    const pipeline = await createPipeline(handle.db, actorId, { name: "Sales", scope: "global" });
    const stage = await createStage(handle.db, actorId, pipeline.id, { name: "Lead" });
    const deal = await createDeal(
      handle.db, actorId, { title: "Acme deal", pipelineId: pipeline.id, stageId: stage.id }, "EUR",
    );
    const projectId = await seedProject();
    const task = await createTask(handle.db, actorId, { title: "Migrate", projectId });
    const idFor: Record<string, string> = {
      companyId: company.id, contactId: contact.id, dealId: deal.id,
      projectId, taskId: task.id,
    };

    // All 32 subsets of five links: the predicate's answer must be the
    // database's answer, every time.
    for (let mask = 0; mask < 32; mask += 1) {
      const values: Record<string, string | null> = {};
      for (const [i, link] of links.entries()) {
        values[link] = (mask & (1 << i)) === 0 ? null : idFor[link]!;
      }
      const predicate = timeEntryAtLeastOneLink(values);
      const inserted = await handle.db.insert(timeEntries).values({
        workDate: "2026-09-01", minutes: 60, billable: true, ownerUserId: actorId, ...values,
      }).returning().then(() => true, () => false);
      expect(inserted, `mask ${String(mask)}: predicate said ${String(predicate)}`).toBe(predicate);
    }
    // The premise: at least one of those 32 went each way, or the loop proved
    // nothing at all.
    expect(await handle.db.select().from(timeEntries).where(eq(timeEntries.ownerUserId, actorId)))
      .toHaveLength(31);
  });
});
