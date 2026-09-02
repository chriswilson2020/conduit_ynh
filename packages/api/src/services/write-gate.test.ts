import { describe, expect, it } from "vitest";
import {
  WriteGate, WriteGateBusyError, isWriteMethod, DEFAULT_DRAIN_TIMEOUT_MS,
} from "./write-gate.js";

// THE GATE ON ITS OWN. What it means in an app -- that a POST really is refused
// while a restore runs, and that the drain really does hold the restore back --
// is in routes/restore.test.ts, against a real Fastify instance. This file is
// about the mechanism: a bound that is only asserted through four layers of
// HTTP is a bound nobody can see fail.

describe("isWriteMethod", () => {
  it("calls the three safe methods safe and everything else a write", () => {
    for (const safe of ["GET", "HEAD", "OPTIONS"]) {
      expect(isWriteMethod(safe), safe).toBe(false);
    }
    for (const write of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND", "LOCK"]) {
      expect(isWriteMethod(write), write).toBe(true);
    }
  });

  // A METHOD IS CASE-SENSITIVE IN THE RFC AND NOT IN A BUG REPORT. Fastify
  // normalises what it routes, so this is belt to those braces -- but the
  // failure it prevents is the one that matters: a lower-cased "post" that
  // missed the set would be a WRITE ADMITTED DURING A RESTORE, which is the
  // exact hole this module exists to close, and it would look like a typo.
  it("does not let a lower-cased safe method be mistaken for a write, or the reverse", () => {
    expect(isWriteMethod("get")).toBe(false);
    expect(isWriteMethod("Head")).toBe(false);
    expect(isWriteMethod("post")).toBe(true);
  });
});

describe("WriteGate", () => {
  it("admits writes and counts them until they finish", () => {
    const gate = new WriteGate();
    expect(gate.refusing).toBe(false);
    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(true);
    expect(gate.inFlight).toBe(2);
    gate.finish("a");
    expect(gate.inFlight).toBe(1);
    // Idempotent: onResponse and onRequestAbort can both reach one request.
    gate.finish("a");
    expect(gate.inFlight).toBe(1);
  });

  it("refuses every write while it is closed, and admits again after resume", async () => {
    const gate = new WriteGate();
    expect((await gate.refuseNewWrites({ reason: "a restore is running" })).drained).toBe(true);
    expect(gate.refusing).toBe(true);
    expect(gate.reason).toBe("a restore is running");
    // Ten in one synchronous pass, because `admit` reads and writes without
    // awaiting and that is the whole reason it can be trusted: there is no
    // window between the check and the record for a burst to arrive in.
    expect([...Array(10).keys()].map((i) => gate.admit(`r${String(i)}`))).not.toContain(true);
    expect(gate.inFlight).toBe(0);
    gate.resume();
    expect(gate.refusing).toBe(false);
    expect(gate.reason).toBeNull();
    expect(gate.admit("after")).toBe(true);
  });

  it("drains at once when nothing is writing", async () => {
    const gate = new WriteGate();
    expect(await gate.refuseNewWrites({ reason: "x" }))
      .toEqual({ drained: true, stillWriting: 0 });
  });

  // THE HALF THAT IS EASY TO LEAVE OUT. Closing the gate stops the NEXT write;
  // it says nothing about the one already inside a handler with a transaction
  // open. Without the wait below, a restore would destroy the database under
  // it.
  it("waits for a write that was already in flight, and resolves when it finishes", async () => {
    const gate = new WriteGate();
    gate.admit("slow");
    let settled = false;
    const draining = gate.refuseNewWrites({ reason: "x", timeoutMs: 5_000 })
      .then((result) => { settled = true; return result; });
    // Still waiting: a turn of the event loop is enough to show it has not
    // resolved, and a drain that resolved here would be one that never looked.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    gate.finish("slow");
    expect(await draining).toEqual({ drained: true, stillWriting: 0 });
  });

  // WITHOUT `except` THE DRAIN WOULD WAIT FOR ITSELF. POST /api/restore/apply
  // passes through this gate like every other write, so it is inside the
  // in-flight set at the moment it asks the gate to close.
  it("does not wait for the request that asked for the closure", async () => {
    const gate = new WriteGate();
    gate.admit("apply");
    expect(await gate.refuseNewWrites({ reason: "x", except: "apply", timeoutMs: 50 }))
      .toEqual({ drained: true, stillWriting: 0 });
  });

  it("waits for everybody else even when the asker is in flight", async () => {
    const gate = new WriteGate();
    gate.admit("apply");
    gate.admit("someone-else");
    const draining = gate.refuseNewWrites({ reason: "x", except: "apply", timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.finish("someone-else");
    expect(await draining).toEqual({ drained: true, stillWriting: 0 });
  });

  // AND WHEN IT RUNS OUT, IT SAYS SO RATHER THAN PRETENDING. The route answers
  // this by NOT starting the restore: a restore that did not start is
  // recoverable by pressing the button again, and one that destroyed the
  // database under a live writer is not.
  it("gives up after the timeout and reports how many are still writing", async () => {
    const gate = new WriteGate();
    gate.admit("apply");
    gate.admit("one");
    gate.admit("two");
    expect(await gate.refuseNewWrites({ reason: "x", except: "apply", timeoutMs: 30 }))
      .toEqual({ drained: false, stillWriting: 2 });
    // AND THE GATE IS STILL CLOSED. Reopening it is the caller's decision, in
    // its own `finally`, because only the caller knows whether it went on.
    expect(gate.refusing).toBe(true);
    expect(gate.admit("late")).toBe(false);
  });

  // A drain still waiting when somebody reopens the gate did not drain, and is
  // told so rather than left to time out: its caller is holding a decision open
  // on the answer.
  it("answers a pending drain when the gate is reopened", async () => {
    const gate = new WriteGate();
    gate.admit("slow");
    const draining = gate.refuseNewWrites({ reason: "x", timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resume();
    expect((await draining).drained).toBe(false);
  });

  // THE SECOND CLOSER, AND WHY IT IS REFUSED RATHER THAN ALLOWED TO SUCCEED.
  // Two applies can both pass the onRequest hook while the gate is open and
  // only race in their handlers -- there is a scrypt between the two points. A
  // second caller that closed an already-closed gate, failed for its own
  // reasons, and reopened it in its `finally` would admit writes for the whole
  // of the FIRST restore. Refusing before anything is taken is what makes that
  // impossible: a caller that catches this has acquired nothing to release.
  it("refuses a second closer, and the refusal leaves the first one's closure alone", async () => {
    const gate = new WriteGate();
    await gate.refuseNewWrites({ reason: "restore one" });
    await expect(gate.refuseNewWrites({ reason: "restore two" }))
      .rejects.toBeInstanceOf(WriteGateBusyError);
    expect(gate.refusing).toBe(true);
    expect(gate.reason).toBe("restore one");
    expect(gate.admit("a-write")).toBe(false);
  });

  it("has a default drain timeout that is a real number of seconds", () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(15_000);
  });
});
