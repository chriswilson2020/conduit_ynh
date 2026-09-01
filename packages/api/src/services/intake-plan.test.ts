import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { destructiveEffects, planIsApplicable, plannedTotal } from "@conduit/shared";
import type { PlanFindingView, PlanSourceView } from "@conduit/shared";
import {
  applyPlan, newPlan, planSource, planView, IntakeSessionStore,
  PlanExceededError, PlanRefusedError,
  type ApplyContext, type Plan, type PlannedEffect,
} from "./intake-plan.js";
import {
  receiveIntake, stageArchive, stageVerbatim, INTAKE_WORK_PREFIX,
  IntakeRefError, type IntakeFile, type StagedMemberRef, type StagedPayload,
} from "./intake.js";
import { digestOf, writeSevenZip, writeZip, HAVE_7Z } from "../test/archives.js";

// THE PLAN, AND THE FRAME APPLY RUNS IN.
//
// Two halves. The first proves the containment property -- that a handler
// cannot do, read or count anything its effect did not describe -- with
// synthetic effects, because the property is about the frame and not about
// restore. The second proves the frame HOLDS ALL THREE SHAPES, including the
// foreign CSV that has no archive and no manifest, because a spine that only
// fitted the shape it was written for would be restore's pipeline wearing a
// general name.

const it7z = HAVE_7Z ? it : it.skip;
const PASSPHRASE = "correct horse battery staple";

/**
 * A UTF-8 byte order mark, built rather than written.
 *
 * This repository is ASCII only, and a file that demonstrated a byte order
 * mark by CARRYING one is a file in which no reviewer can see the difference
 * between the fixture that has it and the fixture that does not.
 */
const BOM = String.fromCharCode(0xFEFF);

/**
 * The error a promise rejected with, or a loud failure if it did not reject.
 *
 * NOT `.catch((e) => e as SomeError)`: that form types the value but says
 * nothing about whether the call rejected at all, so a guard that stopped
 * firing would read as an object with no `message` rather than as a failure.
 * This one has no path that returns without a rejection.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected this to be refused, and it was not");
}


let dataDir: string;
let scratch: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "conduit-plan-data-"));
  scratch = await mkdtemp(path.join(os.tmpdir(), "conduit-plan-scratch-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

async function land(content: Buffer | string, filename: string): Promise<IntakeFile> {
  return await receiveIntake({
    dataDir, source: Readable.from([Buffer.from(content)]), filename,
  });
}

const SOURCE: PlanSourceView = {
  filename: "b.7z", bytes: 10, sha256: "0".repeat(64), stagedBytes: 10, memberCount: 1,
};

// ---------------------------------------------------------------------------
// THE CONTAINMENT PROPERTY. Synthetic effects, no archive, no database: the
// frame's guarantees are about the frame.
// ---------------------------------------------------------------------------

/** A two-operation union, which is the smallest thing the mapped type can be wrong about. */
type TestEffect =
  | (PlannedEffect & { op: "count-things" })
  | (PlannedEffect & { op: "read-thing" });

function effect(over: Partial<TestEffect> & { op: TestEffect["op"] }): TestEffect {
  return {
    subject: "things", count: 1, unit: "row", destroys: false, detail: "", ...over,
  } as TestEffect;
}

/** A payload of one member called "thing", for the effects that read one. */
async function oneMember(content = "the bytes"): Promise<StagedPayload> {
  return stageVerbatim({ file: await land(content, "thing"), memberName: "thing" });
}

describe("applyPlan", () => {
  it("dispatches exactly once per effect, in plan order", async () => {
    const seen: string[] = [];
    const plan = newPlan<TestEffect>({
      kind: "import-csv",
      source: SOURCE,
      effects: [
        effect({ op: "count-things", subject: "a", count: 2 }),
        effect({ op: "count-things", subject: "b", count: 3 }),
      ],
    });
    const outcome = await applyPlan({
      plan,
      reader: await oneMember(),
      carrier: null,
      handlers: {
        "count-things": async (e, ctx) => { seen.push(e.subject); ctx.spend(e.count); },
        "read-thing": async () => { throw new Error("not in this plan"); },
      },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(outcome).toEqual({ dispatched: 2, spent: 5, opened: [] });
  });

  // A REFUSAL IS A PLAN, AND IT IS INERT. This is what makes "a corrupted
  // archive is refused before anything is destroyed" testable without a
  // corrupted archive and without anything to destroy.
  it("refuses to dispatch a plan that carries a refusal", async () => {
    let ran = false;
    const plan = newPlan<TestEffect>({
      kind: "restore",
      source: SOURCE,
      effects: [effect({ op: "count-things" })],
      refusal: { code: "newer-schema", message: "taken by a newer Conduit" },
    });
    await expect(applyPlan({
      plan, reader: await oneMember(), carrier: null,
      handlers: {
        "count-things": async (_e, ctx) => { ran = true; ctx.spend(1); },
        "read-thing": async () => { /* unused */ },
      },
    })).rejects.toBeInstanceOf(PlanRefusedError);
    expect(ran).toBe(false);
  });

  // AND THIS ONE IS THE INSTRUMENT, which the test above turned out not to be.
  // newPlan strips the effects off a refusal, so the case above is refused by
  // the EMPTY-PLAN check and passes whether or not the refusal check exists --
  // found by mutating that check away and watching nothing fail. A plan carrying
  // both is built by hand here, because that is exactly the shape a future
  // caller assembling a Plan without newPlan would produce.
  it("refuses a refusal that somehow arrived with effects attached", async () => {
    let ran = false;
    const built = newPlan<TestEffect>({
      kind: "restore", source: SOURCE, effects: [effect({ op: "count-things" })],
    });
    const smuggled: Plan<TestEffect> = {
      ...built,
      refusal: { code: "newer-schema", message: "taken by a newer Conduit" },
    };
    expect(smuggled.effects).toHaveLength(1);
    const error = await rejection(applyPlan({
      plan: smuggled, reader: await oneMember(), carrier: null,
      handlers: {
        "count-things": async (_e, ctx) => { ran = true; ctx.spend(1); },
        "read-thing": async () => { /* unused */ },
      },
    }));
    expect(error).toBeInstanceOf(PlanRefusedError);
    expect((error as PlanRefusedError).code).toBe("newer-schema");
    expect(error.message).toContain("taken by a newer Conduit");
    expect(ran).toBe(false);
  });

  it("refuses to dispatch a plan that describes nothing to do", async () => {
    const plan = newPlan<TestEffect>({ kind: "import-csv", source: SOURCE, effects: [] });
    await expect(applyPlan({
      plan, reader: await oneMember(), carrier: null,
      handlers: { "count-things": async () => { /* */ }, "read-thing": async () => { /* */ } },
    })).rejects.toBeInstanceOf(PlanRefusedError);
  });

  // UNREACHABLE THROUGH THE TYPES, AND REACHABLE ANYWAY. EffectHandlers is a
  // mapped type over the union's discriminant, so a missing handler does not
  // compile -- but the plan is a runtime value and a JavaScript caller, or a
  // half that widened its union without widening its map, arrives here. It must
  // be a refusal rather than "cannot read properties of undefined".
  it("refuses an operation its handler map does not cover", async () => {
    const plan = newPlan<TestEffect>({
      kind: "restore", source: SOURCE,
      effects: [{ ...effect({ op: "count-things" }), op: "invent-things" } as TestEffect],
    });
    const error = await rejection(applyPlan({
      plan, reader: await oneMember(), carrier: null,
      handlers: {
        "count-things": async (_e, ctx) => { ctx.spend(1); },
        "read-thing": async () => { /* */ },
      },
    }));
    expect(error).toBeInstanceOf(PlanExceededError);
    expect(error.message).toContain("no handler for");
  });

  it("gives every effect the same carrier", async () => {
    const carrier = { transaction: Symbol("tx") };
    const seen: unknown[] = [];
    const plan = newPlan<TestEffect>({
      kind: "restore", source: SOURCE,
      effects: [effect({ op: "count-things" }), effect({ op: "count-things" })],
    });
    await applyPlan({
      plan, reader: await oneMember(), carrier,
      handlers: {
        "count-things": async (_e, ctx) => { seen.push(ctx.carrier); ctx.spend(1); },
        "read-thing": async () => { /* */ },
      },
    });
    expect(seen).toEqual([carrier, carrier]);
  });

  describe("what a handler may read", () => {
    it("reads a member its own effect named", async () => {
      const payload = await oneMember("hello from the staging");
      const ref = payload.members[0]!.ref;
      const plan = newPlan<TestEffect>({
        kind: "restore", source: SOURCE,
        effects: [effect({ op: "read-thing", sources: [ref] })],
      });
      let text = "";
      const outcome = await applyPlan({
        plan, reader: payload, carrier: null,
        handlers: {
          "read-thing": async (e, ctx) => {
            text = await ctx.readText(e.sources![0]!);
            ctx.spend(1);
          },
          "count-things": async () => { /* */ },
        },
      });
      expect(text).toBe("hello from the staging");
      expect(outcome.opened).toEqual(["thing"]);
      await payload.dispose();
    });

    // THE ESCAPE THIS CLOSES: a step that reads a staged file the operator was
    // never shown. The ref exists, the payload minted it, and the frame still
    // refuses it -- because THIS effect did not name it.
    it("refuses a member the effect did not name, even one the payload minted", async () => {
      const payload = await oneMember();
      const ref = payload.members[0]!.ref;
      const plan = newPlan<TestEffect>({
        kind: "restore", source: SOURCE,
        effects: [effect({ op: "read-thing" })], // no sources at all
      });
      const error = await rejection(applyPlan({
        plan, reader: payload, carrier: null,
        handlers: {
          "read-thing": async (_e, ctx) => { await ctx.readText(ref); ctx.spend(1); },
          "count-things": async () => { /* */ },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("does not name");
      await payload.dispose();
    });

    // THE SAME ESCAPE REACHED THROUGH TIME rather than through the ref: a step
    // that stashes its context and reads during a LATER effect would put the
    // read outside the effect that declared it.
    it("refuses a read from a context whose effect has finished", async () => {
      const payload = await oneMember();
      const ref = payload.members[0]!.ref;
      let stashed: ApplyContext<null> | null = null;
      const plan = newPlan<TestEffect>({
        kind: "restore", source: SOURCE,
        effects: [
          effect({ op: "read-thing", sources: [ref] }),
          effect({ op: "count-things" }),
        ],
      });
      const error = await rejection(applyPlan({
        plan, reader: payload, carrier: null,
        handlers: {
          "read-thing": async (_e, ctx) => { stashed = ctx; ctx.spend(1); },
          "count-things": async (_e, ctx) => {
            await stashed!.readText(ref);
            ctx.spend(1);
          },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("after it had finished");
      await payload.dispose();
    });

    // TWO LAYERS, AND BOTH ARE SHOWN. The frame refuses a ref the effect did
    // not name; services/intake.ts refuses a ref the payload did not mint. A
    // plan naming a ref from a DIFFERENT staging passes the first and is caught
    // by the second, which is the shape a concurrency bug would take.
    it("refuses a named ref that belongs to a different staging", async () => {
      const mine = await oneMember("mine");
      const theirs = await oneMember("theirs");
      const foreign = theirs.members[0]!.ref;
      const plan = newPlan<TestEffect>({
        kind: "restore", source: SOURCE,
        effects: [effect({ op: "read-thing", sources: [foreign] })],
      });
      await expect(applyPlan({
        plan, reader: mine, carrier: null,
        handlers: {
          "read-thing": async (e, ctx) => { await ctx.readText(e.sources![0]!); ctx.spend(1); },
          "count-things": async () => { /* */ },
        },
      })).rejects.toBeInstanceOf(IntakeRefError);
      await mine.dispose();
      await theirs.dispose();
    });
  });

  describe("what a handler must account for", () => {
    // THE PROPERTY THAT MAKES THE PREVIEW HONEST ABOUT QUANTITY. A CSV preview
    // that promises 200,000 rows cannot be applied as 200,001, and the failure
    // arrives at the row that exceeds it rather than at the end.
    it("stops a handler that exceeds its effect's count, at the moment it does", async () => {
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE,
        effects: [effect({ op: "count-things", count: 3 })],
      });
      let reached = 0;
      const error = await rejection(applyPlan({
        plan, reader: await oneMember(), carrier: null,
        handlers: {
          "count-things": async (_e, ctx) => {
            for (let row = 0; row < 5; row += 1) { ctx.spend(1); reached = row + 1; }
          },
          "read-thing": async () => { /* */ },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("already done 4");
      expect(reached, "it must stop at the row that exceeds, not at the end").toBe(3);
    });

    // THE OTHER DIRECTION, AND IT IS THE ONE THAT CATCHES SILENCE. A handler
    // that does work without accounting for it looks exactly like a handler
    // that did less work than promised -- so requiring EQUALITY turns the
    // ordinary form of "apply did something the plan did not describe" into a
    // thrown error.
    it("refuses a handler that accounts for less than its effect promised", async () => {
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE,
        effects: [effect({ op: "count-things", count: 10, subject: "companies" })],
      });
      const error = await rejection(applyPlan({
        plan, reader: await oneMember(), carrier: null,
        handlers: {
          "count-things": async (_e, ctx) => { ctx.spend(4); },
          "read-thing": async () => { /* */ },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("accounted for 4");
    });

    // A NEGATIVE SPEND IS THE ESCAPE FROM THE COUNT, and it is the reason the
    // integer rule exists rather than being implied by the equality above.
    // Six units of work, reported as five: spend(3), spend(-1), spend(3) sums
    // to 5, the equality is satisfied, and the plan promised 5. Without this
    // rule a handler could do arbitrarily more than the preview said and the
    // arithmetic would agree with it.
    //
    // FOUND BY MUTATION, not by design: removing the rule failed nothing,
    // because -1, 1.5 and NaN are all caught by the equality on the way out.
    it("refuses a negative accounting, which would otherwise buy extra work", async () => {
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE, effects: [effect({ op: "count-things", count: 5 })],
      });
      let done = 0;
      const error = await rejection(applyPlan({
        plan, reader: await oneMember(), carrier: null,
        handlers: {
          "count-things": async (_e, ctx) => {
            done += 3;
            ctx.spend(3);      // three rows, honestly accounted for
            ctx.spend(-1);     // ... and now un-account for one of them
            done += 3;
            ctx.spend(3);      // three more: six rows done, five units spent
          },
          "read-thing": async () => { /* */ },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("is not a number of units");
      expect(done, "it must stop at the negative spend, not after the extra work").toBe(3);
    });

    it("refuses an accounting that is not a whole number of units", async () => {
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE, effects: [effect({ op: "count-things", count: 5 })],
      });
      for (const bad of [1.5, Number.NaN]) {
        const error = await rejection(applyPlan({
          plan, reader: await oneMember(), carrier: null,
          handlers: {
            "count-things": async (_e, ctx) => { ctx.spend(bad); },
            "read-thing": async () => { /* */ },
          },
        }));
        expect(error, String(bad)).toBeInstanceOf(PlanExceededError);
        expect(error.message, String(bad)).toContain("is not a number of units");
      }
    });

    it("refuses accounting from a context whose effect has finished", async () => {
      let stashed: ApplyContext<null> | null = null;
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE,
        effects: [effect({ op: "count-things" }), effect({ op: "count-things" })],
      });
      const error = await rejection(applyPlan({
        plan, reader: await oneMember(), carrier: null,
        handlers: {
          "count-things": async (_e, ctx) => {
            if (stashed === null) { stashed = ctx; ctx.spend(1); return; }
            stashed.spend(1);
            ctx.spend(1);
          },
          "read-thing": async () => { /* */ },
        },
      }));
      expect(error).toBeInstanceOf(PlanExceededError);
      expect(error.message).toContain("after it had finished");
    });

    // AND THE LARGE ONE, ASSERTED AS A VALUE. 200,000 rows is one effect with a
    // count -- not 200,000 effects -- so the plan for a large import is the
    // same size as the plan for a small one, and this runs in milliseconds
    // with no database in sight.
    it("carries a 200,000-row effect as one effect, and holds the handler to it", async () => {
      const plan = newPlan<TestEffect>({
        kind: "import-csv", source: SOURCE,
        effects: [effect({ op: "count-things", count: 200_000, subject: "contacts" })],
      });
      expect(plan.effects).toHaveLength(1);
      expect(plannedTotal(planView(plan), "row")).toBe(200_000);
      const outcome = await applyPlan({
        plan, reader: await oneMember(), carrier: null,
        handlers: {
          "count-things": async (e, ctx) => { ctx.spend(e.count); },
          "read-thing": async () => { /* */ },
        },
      });
      expect(outcome.spent).toBe(200_000);
    });
  });

  it("throws out, so the caller's transaction is the thing that rolls back", async () => {
    // The frame opens no transaction: it guarantees only that a failure leaves
    // through the caller's own wrapper. This is that guarantee, asserted.
    const plan = newPlan<TestEffect>({
      kind: "restore", source: SOURCE, effects: [effect({ op: "count-things" })],
    });
    let rolledBack = false;
    await expect((async () => {
      try {
        await applyPlan({
          plan, reader: await oneMember(), carrier: null,
          handlers: {
            "count-things": async () => { throw new Error("the load failed"); },
            "read-thing": async () => { /* */ },
          },
        });
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    })()).rejects.toThrow("the load failed");
    expect(rolledBack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE PREVIEW. It is a projection of the thing that runs, and this is the file
// that stops it becoming a second description of it.
// ---------------------------------------------------------------------------

describe("planView", () => {
  const plan = (): Plan<TestEffect> => newPlan<TestEffect>({
    kind: "restore",
    source: SOURCE,
    effects: [
      effect({
        op: "count-things", subject: "public", count: 1, unit: "schema", destroys: true,
        detail: "every table in the database is replaced",
      }),
      effect({ op: "count-things", subject: "companies", count: 42, unit: "row" }),
      effect({ op: "read-thing", subject: "mail.key", count: 1, unit: "key", destroys: true }),
    ],
    findings: [{ severity: "note", code: "extra-member", message: "one extra blob" }],
  });

  // THE ASSERTION THAT MATTERS. If this function ever gains a condition, the
  // preview has stopped being the thing that runs. It was shown failing against
  // a version that dropped destructive effects -- which is exactly the mutation
  // that turns a truthful preview into a lie about a destructive operation.
  it("carries every effect across, field for field, in order", () => {
    const source = plan();
    const view = planView(source);
    expect(view.effects).toHaveLength(source.effects.length);
    view.effects.forEach((rendered, index) => {
      const original = source.effects[index]!;
      expect(rendered).toEqual({
        op: original.op, subject: original.subject, count: original.count,
        unit: original.unit, destroys: original.destroys, detail: original.detail,
      });
    });
  });

  it("renders the destructions the confirmation has to name", () => {
    const view = planView(plan());
    expect(destructiveEffects(view).map((e) => e.subject)).toEqual(["public", "mail.key"]);
    expect(planIsApplicable(view)).toBe(true);
  });

  // THE REFS DO NOT TRAVEL, and a JSON round trip is the assertion: a
  // StagedMemberRef is an object identity, so a view carrying one would be
  // handing a client something meaningless and would be inviting apply to take
  // its instructions from the wire.
  it("is plain JSON, with no member reference anywhere in it", async () => {
    const payload = await oneMember();
    const withRefs = newPlan<TestEffect>({
      kind: "restore", source: SOURCE,
      effects: [effect({ op: "read-thing", sources: [payload.members[0]!.ref] })],
    });
    const view = planView(withRefs);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toContain("sources");
    await payload.dispose();
  });

  it("renders a refusal, with no effects beside it", () => {
    const refused = newPlan<TestEffect>({
      kind: "restore", source: SOURCE,
      effects: [effect({ op: "count-things", destroys: true })],
      refusal: { code: "newer-schema", message: "taken by a newer Conduit" },
    });
    const view = planView(refused);
    expect(view.effects).toEqual([]);
    expect(view.refusal?.code).toBe("newer-schema");
    expect(planIsApplicable(view)).toBe(false);
  });

  it("carries the findings, which are not refusals", () => {
    expect(planView(plan()).findings).toEqual([
      { severity: "note", code: "extra-member", message: "one extra blob" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// WHERE A PLAN WAITS. The mechanism that keeps the plan from travelling.
// ---------------------------------------------------------------------------

describe("IntakeSessionStore", () => {
  const heldPlan = (): Plan<TestEffect> => newPlan<TestEffect>({
    kind: "restore", source: SOURCE, effects: [effect({ op: "count-things" })],
  });

  it("hands back the same plan object it was given", async () => {
    const store = new IntakeSessionStore({ sweepIntervalMs: 0 });
    const payload = await oneMember();
    const plan = heldPlan();
    const id = store.hold({ plan, payload });
    expect(store.get(id)?.plan).toBe(plan);
    await store.close();
  });

  it("holds one at a time, because a held session is an unpacked install", async () => {
    const store = new IntakeSessionStore({ sweepIntervalMs: 0 });
    const first = await oneMember();
    const second = await oneMember();
    store.hold({ plan: heldPlan(), payload: first });
    expect(() => store.hold({ plan: heldPlan(), payload: second }))
      .toThrow(PlanRefusedError);
    // AND IT DISPOSED OF NOTHING. A store that evicted somebody's in-flight
    // restore to make room would be worse than a refusal.
    expect(store.size).toBe(1);
    await second.dispose();
    await store.close();
  });

  it("takes a session out before the work starts, so it cannot be applied twice", async () => {
    const store = new IntakeSessionStore({ sweepIntervalMs: 0 });
    const id = store.hold({ plan: heldPlan(), payload: await oneMember() });
    expect(store.take(id)).toBeDefined();
    expect(store.take(id)).toBeUndefined();
    expect(store.get(id)).toBeUndefined();
    await store.close();
  });

  // EXPIRY IS THE CREDENTIAL DISCIPLINE, not housekeeping. What expires is a
  // decrypted backup: mail.key in the clear, in $data_dir.
  it("deletes the staged files when a plan expires", async () => {
    let clock = new Date("2026-09-01T00:00:00.000Z");
    const store = new IntakeSessionStore({ sweepIntervalMs: 0, now: () => clock });
    const payload = await oneMember();
    const id = store.hold({
      plan: newPlan<TestEffect>({
        kind: "restore", source: SOURCE, effects: [effect({ op: "count-things" })],
        now: clock, ttlMs: 60_000,
      }),
      payload,
    });
    expect((await readdir(dataDir)).filter((e) => e.startsWith(INTAKE_WORK_PREFIX))).toHaveLength(1);
    clock = new Date(clock.getTime() + 61_000);
    expect(await store.sweep()).toBe(1);
    expect(store.get(id)).toBeUndefined();
    expect((await readdir(dataDir)).filter((e) => e.startsWith(INTAKE_WORK_PREFIX))).toEqual([]);
    await store.close();
  });

  it("deletes the staged files on discard and on close", async () => {
    const store = new IntakeSessionStore({ sweepIntervalMs: 0 });
    const id = store.hold({ plan: heldPlan(), payload: await oneMember() });
    expect(await store.discard(id)).toBe(true);
    expect(await store.discard(id)).toBe(false);
    expect((await readdir(dataDir)).filter((e) => e.startsWith(INTAKE_WORK_PREFIX))).toEqual([]);

    store.hold({ plan: heldPlan(), payload: await oneMember() });
    await store.close();
    expect((await readdir(dataDir)).filter((e) => e.startsWith(INTAKE_WORK_PREFIX))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE THREE SHAPES. The point of the whole exercise: the first four stages are
// one pipeline, and only the last column differs.
//
// The inspectors below are DELIBERATELY THIN. They are not restore and they are
// not the importers -- those are later tasks of this phase. They are the
// smallest thing that answers the question this task exists to answer: does the
// shape fit, or does building the second half force the first to be rebuilt?
// ---------------------------------------------------------------------------

/** Shape 1: restore, from an encrypted `.7z`. Its last column DESTROYS. */
type RestoreEffect =
  | (PlannedEffect & { op: "destroy-schema" })
  | (PlannedEffect & { op: "load-dump" })
  | (PlannedEffect & { op: "write-blobs" })
  | (PlannedEffect & { op: "replace-mail-key" });

interface InstallVersions { appVersion: string; migrationPosition: number }

async function inspectRestore(
  payload: StagedPayload, file: IntakeFile, install: InstallVersions,
): Promise<Plan<RestoreEffect>> {
  const source = planSource(file, payload);
  const refuse = (code: string, message: string): Plan<RestoreEffect> =>
    newPlan<RestoreEffect>({ kind: "restore", source, refusal: { code, message } });

  const manifestMember = payload.byName("manifest.json");
  if (manifestMember === undefined) return refuse("no-manifest", "no manifest.json");
  let manifest: {
    kind?: string; appVersion?: string; migrationPosition?: number;
    members?: { path: string }[];
  };
  try {
    manifest = JSON.parse(await payload.readText(manifestMember.ref)) as typeof manifest;
  } catch {
    return refuse("bad-manifest", "manifest.json is not readable JSON");
  }
  // THE ASYMMETRY THE SPEC SAYS MUST NOT BE BLURRED: an export is not a backup,
  // and a restore must never accept one. The backup's manifest declares
  // `kind: "backup"`; the export's manifest has no such field, by design.
  if (manifest.kind !== "backup") {
    return refuse("not-a-backup", "this is not a Conduit backup");
  }
  if ((manifest.migrationPosition ?? 0) > install.migrationPosition) {
    return refuse(
      "newer-schema",
      `this backup was taken by Conduit ${manifest.appVersion ?? "unknown"}, `
      + `which is newer than the ${install.appVersion} running here`,
    );
  }

  // THE ITEM THIS PHASE MUST NOT GET WRONG. The manifest's member list is the
  // blob walk's SNAPSHOT and 7z reads the directory again when it runs, so an
  // upload landing between the two puts a member in the archive the manifest
  // does not list. It is a WHOLE file -- blobs are content-addressed and
  // immutable -- and a restore that called it corruption would reject a
  // perfectly good backup.
  const listed = new Set((manifest.members ?? []).map((m) => m.path));
  const blobs = payload.members.filter((m) => m.name.startsWith("files/"));
  const extra = blobs.filter((m) => !listed.has(m.name));
  const findings: PlanFindingView[] = extra.map((m) => ({
    severity: "note",
    code: "extra-member",
    message:
      `the archive carries ${m.name}, which the manifest does not list. `
      + "That is an upload that landed while the backup was being written; "
      + "blobs are content-addressed, so it is a whole file and it will be restored.",
  }));

  const dump = payload.byName("database.sql");
  const key = payload.byName("mail.key");
  if (dump === undefined || key === undefined) {
    return refuse("incomplete", "the archive is missing database.sql or mail.key");
  }

  return newPlan<RestoreEffect>({
    kind: "restore",
    source,
    findings,
    effects: [
      {
        op: "destroy-schema", subject: "public", count: 1, unit: "schema", destroys: true,
        detail: "every table in this install is dropped and replaced by the backup's",
      },
      {
        op: "load-dump", subject: "database.sql", count: 1, unit: "table", destroys: false,
        detail: "the backup's pg_dump is loaded inside one transaction",
        sources: [dump.ref],
      },
      {
        op: "write-blobs", subject: "files", count: blobs.length, unit: "file", destroys: false,
        detail: `${String(blobs.length)} stored files are written into the blob store`,
        sources: blobs.map((m) => m.ref),
      },
      {
        op: "replace-mail-key", subject: "mail.key", count: 1, unit: "key", destroys: true,
        detail: "the mail key is replaced; mail passwords encrypted under the current one are lost",
        sources: [key.ref],
      },
    ],
  });
}

/** Shape 2: Conduit's own export, from a plain `.zip`. Its last column CREATES. */
type ImportExportEffect =
  | (PlannedEffect & { op: "insert-rows" })
  | (PlannedEffect & { op: "reverse-cell-transform" });

async function inspectOwnExport(
  payload: StagedPayload, file: IntakeFile, supportedFormatVersion: number,
): Promise<Plan<ImportExportEffect>> {
  const source = planSource(file, payload);
  const refuse = (code: string, message: string): Plan<ImportExportEffect> =>
    newPlan<ImportExportEffect>({ kind: "import-export", source, refusal: { code, message } });

  const manifestMember = payload.byName("manifest.json");
  if (manifestMember === undefined) return refuse("no-manifest", "no manifest.json");
  const manifest = JSON.parse(await payload.readText(manifestMember.ref)) as {
    kind?: string; formatVersion?: number;
    cellTransforms?: { name: string; version: number }[];
  };
  // THE OTHER DIRECTION OF THE SAME ASYMMETRY. An import must never accept a
  // backup: it would carry mail bodies and mail.key into an insert path that
  // has no idea what they are.
  if (manifest.kind === "backup") {
    return refuse("not-an-export", "this is a backup, not an export; use Restore");
  }
  if ((manifest.formatVersion ?? 0) > supportedFormatVersion) {
    return refuse(
      "newer-format",
      `this export is format version ${String(manifest.formatVersion)} and this `
      + `install understands ${String(supportedFormatVersion)}`,
    );
  }

  const findings: PlanFindingView[] = (manifest.cellTransforms ?? []).map((t) => ({
    severity: "note",
    code: "cell-transform",
    message: `the export declares the ${t.name} transform, version ${String(t.version)}; `
      + "it will be reversed as the rows are read",
  }));

  const effects: ImportExportEffect[] = [];
  for (const member of payload.members) {
    if (!member.name.endsWith(".csv")) continue;
    const text = await payload.readText(member.ref);
    const rows = text.split("\r\n").filter((line) => line !== "").length - 1;
    effects.push({
      op: "insert-rows",
      subject: member.name.replace(/\.csv$/, ""),
      count: Math.max(rows, 0),
      unit: "row",
      destroys: false,
      detail: `${String(Math.max(rows, 0))} rows are created; nothing existing is touched`,
      sources: [member.ref],
    });
  }
  return newPlan<ImportExportEffect>({ kind: "import-export", source, effects, findings });
}

/**
 * Shape 3: a foreign CSV. No archive, no manifest, and an INTERACTIVE STEP
 * between inspect and plan -- the column mapping, which is the reason the
 * spine's third and fourth stages are separate functions rather than one.
 */
interface CsvSniff {
  ref: StagedMemberRef;
  delimiter: string;
  hasBom: boolean;
  headers: string[];
  dataRows: number;
}

type ImportCsvEffect =
  | (PlannedEffect & { op: "insert-rows" })
  | (PlannedEffect & { op: "skip-rows" });

async function sniffCsv(payload: StagedPayload): Promise<CsvSniff> {
  const member = payload.members[0]!;
  const text = await payload.readText(member.ref);
  // Written as an escape rather than as the character: the convention in this
  // repo is ASCII only, and a file demonstrating a byte order mark by carrying
  // one is a file no reviewer can see the difference in.
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(1) : text;
  const [first = ""] = body.split(/\r?\n/);
  // Whichever candidate appears most in the header line. Crude on purpose: the
  // real sniffer is the importer's, and this file is about the spine's shape.
  const delimiter = [",", ";", "\t"].reduce(
    (best, candidate) =>
      first.split(candidate).length > first.split(best).length ? candidate : best,
    ",",
  );
  const lines = body.split(/\r?\n/).filter((line) => line !== "");
  return {
    ref: member.ref,
    delimiter,
    hasBom,
    headers: first.split(delimiter),
    dataRows: Math.max(lines.length - 1, 0),
  };
}

function planCsvImport(
  sniff: CsvSniff, source: PlanSourceView, mapping: Record<string, string>,
): Plan<ImportCsvEffect> {
  const mapped = sniff.headers.filter((header) => mapping[header] !== undefined);
  if (mapped.length === 0) {
    return newPlan<ImportCsvEffect>({
      kind: "import-csv", source,
      refusal: { code: "no-mapping", message: "no column was mapped to a Conduit field" },
    });
  }
  // A row with fewer cells than headers is skipped rather than guessed at, and
  // the count of skips is part of the preview -- an importer that silently
  // dropped rows would be one nobody could check.
  const skipped = sniff.dataRows > 0 ? 1 : 0;
  return newPlan<ImportCsvEffect>({
    kind: "import-csv",
    source,
    findings: [{
      severity: "note",
      code: "delimiter",
      message: `read as ${JSON.stringify(sniff.delimiter)}-separated`
        + `${sniff.hasBom ? ", UTF-8 with a byte order mark" : ""}`,
    }],
    effects: [
      {
        op: "insert-rows", subject: "contacts", count: sniff.dataRows - skipped, unit: "row",
        destroys: false,
        detail: `${String(sniff.dataRows - skipped)} contacts are created from `
          + `${String(mapped.length)} mapped columns`,
        sources: [sniff.ref],
      },
      {
        op: "skip-rows", subject: "contacts", count: skipped, unit: "row", destroys: false,
        detail: `${String(skipped)} rows have fewer cells than the header and are skipped`,
      },
    ],
  });
}

describe("the three shapes", () => {
  it7z("RESTORE: a .7z is staged, inspected, planned and applied", async () => {
    const blobContent = randomBytes(512);
    const blob = digestOf(blobContent);
    const archivePath = path.join(scratch, "backup.7z");
    await writeSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "pay-")),
      passphrase: PASSPHRASE,
      members: [
        {
          name: "manifest.json",
          content: JSON.stringify({
            kind: "backup", formatVersion: 1, appVersion: "1.3.0", migrationPosition: 13,
            members: [{ path: "database.sql" }, { path: "mail.key" }, { path: `files/${blob}` }],
          }),
        },
        { name: "database.sql", content: "SELECT 1;\n" },
        { name: "mail.key", content: randomBytes(32) },
        { name: `files/${blob}`, content: blobContent },
      ],
    });

    const file = await land(await readFile(archivePath), "conduit-backup.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    const plan = await inspectRestore(payload, file, {
      appVersion: "1.4.0", migrationPosition: 13,
    });

    const view = planView(plan);
    expect(view.kind).toBe("restore");
    expect(destructiveEffects(view).map((e) => e.subject)).toEqual(["public", "mail.key"]);
    expect(plannedTotal(view, "file")).toBe(1);
    expect(view.findings).toEqual([]);

    const did: string[] = [];
    const outcome = await applyPlan({
      plan, reader: payload, carrier: { transaction: "the caller's" },
      handlers: {
        "destroy-schema": async (e, ctx) => { did.push(e.op); ctx.spend(1); },
        "load-dump": async (e, ctx) => {
          expect(await ctx.readText(e.sources![0]!)).toBe("SELECT 1;\n");
          did.push(e.op); ctx.spend(1);
        },
        "write-blobs": async (e, ctx) => {
          for (const ref of e.sources ?? []) { await ctx.readBytes(ref); ctx.spend(1); }
          did.push(e.op);
        },
        "replace-mail-key": async (e, ctx) => {
          expect((await ctx.readBytes(e.sources![0]!)).length).toBe(32);
          did.push(e.op); ctx.spend(1);
        },
      },
    });
    expect(did).toEqual(["destroy-schema", "load-dump", "write-blobs", "replace-mail-key"]);
    expect(outcome.dispatched).toBe(4);
    await payload.dispose();
  }, 90_000);

  // THE ITEM THE PHASE MUST NOT GET WRONG, PROVED. An unlisted files/ member is
  // EXTRA, not damage: the plan describes it as a note and still restores it.
  it7z("RESTORE: an unlisted files/ member is described as extra, not as corruption", async () => {
    const listedContent = randomBytes(300);
    const unlistedContent = randomBytes(200);
    const listed = digestOf(listedContent);
    const unlisted = digestOf(unlistedContent);
    const archivePath = path.join(scratch, "extra.7z");
    await writeSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "extrapay-")),
      passphrase: PASSPHRASE,
      members: [
        {
          name: "manifest.json",
          content: JSON.stringify({
            kind: "backup", formatVersion: 1, appVersion: "1.3.0", migrationPosition: 13,
            // The snapshot the blob walk took. It does NOT list the second
            // blob, because that upload landed after the walk and before 7z
            // read the directory.
            members: [{ path: "database.sql" }, { path: "mail.key" }, { path: `files/${listed}` }],
          }),
        },
        { name: "database.sql", content: "SELECT 1;\n" },
        { name: "mail.key", content: randomBytes(32) },
        { name: `files/${listed}`, content: listedContent },
        { name: `files/${unlisted}`, content: unlistedContent },
      ],
    });

    const file = await land(await readFile(archivePath), "conduit-backup.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    const plan = await inspectRestore(payload, file, {
      appVersion: "1.4.0", migrationPosition: 13,
    });

    // NOT A REFUSAL. This is the whole assertion: a perfectly good backup.
    expect(plan.refusal).toBeNull();
    expect(planIsApplicable(planView(plan))).toBe(true);
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]?.severity).toBe("note");
    expect(plan.findings[0]?.code).toBe("extra-member");
    expect(plan.findings[0]?.message).toContain(unlisted);
    // AND IT IS RESTORED. Describing it as extra and then dropping it would be
    // the same data loss wearing a friendlier message.
    expect(plannedTotal(planView(plan), "file")).toBe(2);

    const written: number[] = [];
    await applyPlan({
      plan, reader: payload, carrier: null,
      handlers: {
        "destroy-schema": async (_e, ctx) => { ctx.spend(1); },
        "load-dump": async (_e, ctx) => { ctx.spend(1); },
        "write-blobs": async (e, ctx) => {
          for (const ref of e.sources ?? []) {
            written.push((await ctx.readBytes(ref)).length);
            ctx.spend(1);
          }
        },
        "replace-mail-key": async (_e, ctx) => { ctx.spend(1); },
      },
    });
    expect(written.sort((a, b) => a - b)).toEqual([200, 300]);
    await payload.dispose();
  }, 90_000);

  it7z("RESTORE: a backup from a NEWER Conduit is a refusal, with nothing staged to run", async () => {
    const archivePath = path.join(scratch, "newer.7z");
    await writeSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "newerpay-")),
      passphrase: PASSPHRASE,
      members: [
        {
          name: "manifest.json",
          content: JSON.stringify({
            kind: "backup", appVersion: "1.9.0", migrationPosition: 27, members: [],
          }),
        },
        { name: "database.sql", content: "SELECT 1;\n" },
        { name: "mail.key", content: randomBytes(32) },
      ],
    });
    const file = await land(await readFile(archivePath), "b.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    const plan = await inspectRestore(payload, file, {
      appVersion: "1.4.0", migrationPosition: 13,
    });
    expect(plan.refusal?.code).toBe("newer-schema");
    expect(plan.effects).toEqual([]);
    expect(planIsApplicable(planView(plan))).toBe(false);
    await payload.dispose();
  }, 90_000);

  it7z("IMPORT-EXPORT: a .zip is staged, inspected, planned and applied", async () => {
    const zipPath = path.join(scratch, "export.zip");
    await writeZip({
      zipPath,
      members: [
        {
          name: "manifest.json",
          content: JSON.stringify({
            formatVersion: 1, appVersion: "1.3.0",
            cellTransforms: [{ name: "leading-apostrophe-escape", version: 1 }],
          }),
        },
        { name: "companies.csv", content: BOM + "name\r\nAcme\r\nBeta\r\n" },
        { name: "contacts.csv", content: BOM + "name\r\nAda\r\n" },
      ],
    });
    const file = await land(await readFile(zipPath), "conduit-export.zip");
    const payload = await stageArchive({ file, passphrase: null });
    const plan = await inspectOwnExport(payload, file, 1);

    const view = planView(plan);
    expect(view.kind).toBe("import-export");
    // NOTHING IS DESTROYED, and it is the plan that says so rather than the
    // label on the button.
    expect(destructiveEffects(view)).toEqual([]);
    expect(plannedTotal(view, "row")).toBe(3);
    expect(view.findings.map((f) => f.code)).toEqual(["cell-transform"]);

    const inserted: Record<string, number> = {};
    await applyPlan({
      plan, reader: payload, carrier: null,
      handlers: {
        "insert-rows": async (e, ctx) => {
          const text = await ctx.readText(e.sources![0]!);
          const rows = text.split("\r\n").filter((line) => line !== "").length - 1;
          inserted[e.subject] = rows;
          ctx.spend(rows);
        },
        "reverse-cell-transform": async (_e, ctx) => { ctx.spend(1); },
      },
    });
    expect(inserted).toEqual({ companies: 2, contacts: 1 });
    await payload.dispose();
  }, 90_000);

  it7z("IMPORT-EXPORT: a BACKUP offered to the importer is refused", async () => {
    const archivePath = path.join(scratch, "backup-as-import.7z");
    await writeSevenZip({
      archivePath,
      workDir: await mkdtemp(path.join(scratch, "asimport-")),
      passphrase: PASSPHRASE,
      members: [
        { name: "manifest.json", content: JSON.stringify({ kind: "backup", formatVersion: 1 }) },
        { name: "database.sql", content: "SELECT 1;\n" },
      ],
    });
    const file = await land(await readFile(archivePath), "b.7z");
    const payload = await stageArchive({ file, passphrase: PASSPHRASE });
    const plan = await inspectOwnExport(payload, file, 1);
    expect(plan.refusal?.code).toBe("not-an-export");
    await payload.dispose();
  }, 90_000);

  // THE SHAPE THAT PROVES THE SPINE. No archive, no manifest, no passphrase,
  // nothing to unpack -- and every stage after ingest is the same code. It also
  // runs on a machine with no 7z, which is the point: the pipeline is not the
  // archiver.
  it("IMPORT-CSV: a foreign CSV is staged, sniffed, mapped, planned and applied", async () => {
    const csv = BOM + "First Name;Last Name;E-mail\r\n"
      + "Ada;Lovelace;ada@example.com\r\n"
      + "Grace;Hopper;grace@example.com\r\n"
      + "Alan\r\n";
    const file = await land(csv, "outlook-contacts.csv");
    const payload = stageVerbatim({ file });

    // INSPECT. Facts only -- no decision has been taken yet.
    const sniff = await sniffCsv(payload);
    expect(sniff.delimiter).toBe(";");
    expect(sniff.hasBom).toBe(true);
    expect(sniff.headers).toEqual(["First Name", "Last Name", "E-mail"]);
    expect(sniff.dataRows).toBe(3);

    // THE INTERACTIVE STEP. Only this shape has one, and it is the reason
    // inspect and plan are two stages rather than one: the page cannot offer a
    // mapping until it has the headers, and no plan exists until it has the
    // mapping.
    const plan = planCsvImport(sniff, planSource(file, payload), {
      "First Name": "firstName", "E-mail": "email",
    });

    const view = planView(plan);
    expect(destructiveEffects(view)).toEqual([]);
    expect(view.effects.map((e) => [e.op, e.count]))
      .toEqual([["insert-rows", 2], ["skip-rows", 1]]);
    expect(view.findings[0]?.code).toBe("delimiter");

    const inserted: string[] = [];
    const outcome = await applyPlan({
      plan, reader: payload, carrier: null,
      handlers: {
        "insert-rows": async (e, ctx) => {
          const text = await ctx.readText(e.sources![0]!);
          const body = (text.startsWith(BOM) ? text.slice(1) : text)
            .split("\r\n").filter((line) => line !== "").slice(1);
          for (const line of body) {
            const cells = line.split(";");
            if (cells.length < sniff.headers.length) continue;
            inserted.push(cells[0]!);
            ctx.spend(1);
          }
        },
        // A SKIP IS A PLANNED EFFECT TOO. It costs nothing to apply, and the
        // operator was told about it before they pressed the button.
        "skip-rows": async (e, ctx) => { ctx.spend(e.count); },
      },
    });
    expect(inserted).toEqual(["Ada", "Grace"]);
    expect(outcome.dispatched).toBe(2);
    expect(outcome.spent).toBe(3);
    await payload.dispose();
  });

  it("IMPORT-CSV: a mapping that maps nothing is a refusal, with nothing to apply", async () => {
    const file = await land(BOM + "a;b\r\n1;2\r\n", "c.csv");
    const payload = stageVerbatim({ file });
    const plan = planCsvImport(await sniffCsv(payload), planSource(file, payload), {});
    expect(plan.refusal?.code).toBe("no-mapping");
    await expect(applyPlan({
      plan, reader: payload, carrier: null,
      handlers: {
        "insert-rows": async () => { /* */ }, "skip-rows": async () => { /* */ },
      },
    })).rejects.toBeInstanceOf(PlanRefusedError);
    await payload.dispose();
  });
});
