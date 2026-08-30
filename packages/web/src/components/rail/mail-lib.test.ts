import { describe, it, expect } from "vitest";
import { composeGate, type ComposeHop } from "./mail-lib";

/**
 * The Compose gate's rules, exhaustively.
 *
 * WHAT THIS FILE DOES NOT COVER, said here rather than left to be discovered:
 * it pins the RULE, not the wiring. Nothing here can tell whether mail.tsx
 * passes the right `enabled` flag for each hook, or whether the button reads
 * this answer at all -- that is e2e/rail-compose.spec.ts's job, against the
 * real app with a real query chain held open. A green file here and a red one
 * there is the expected shape of a wiring mistake.
 */

/** A hop with every flag off, so each case names only what it changes. */
function hop(over: Partial<ComposeHop> = {}): ComposeHop {
  return { enabled: true, isPending: false, isError: false, ...over };
}

describe("composeGate", () => {
  it("is ready with no hops at all", () => {
    expect(composeGate([])).toBe("ready");
  });

  it("is ready when every enabled hop has answered", () => {
    expect(composeGate([hop(), hop(), hop()])).toBe("ready");
  });

  it("is resolving while an enabled hop is pending", () => {
    expect(composeGate([hop(), hop({ isPending: true })])).toBe("resolving");
  });

  it("is failed when an enabled hop errored and nothing is pending", () => {
    expect(composeGate([hop(), hop({ isError: true })])).toBe("failed");
  });

  /**
   * The button's state is the question, so anything still on the wire holds it
   * shut; the failure is reported on the render after that hop settles.
   */
  it("reports resolving rather than failed when both are present", () => {
    expect(composeGate([hop({ isError: true }), hop({ isPending: true })])).toBe("resolving");
  });

  /**
   * THE CASE THAT MAKES `enabled` LOAD-BEARING. A disabled query sits at
   * `status: "pending"` for ever in TanStack v5, so a gate that ignored this
   * flag would disable Compose permanently on a deal with no linked contact,
   * on every project tab and on every company tab.
   */
  it("ignores a disabled hop that is pending for ever", () => {
    expect(composeGate([hop(), hop({ enabled: false, isPending: true })])).toBe("ready");
  });

  it("ignores a disabled hop that carries a stale error", () => {
    expect(composeGate([hop(), hop({ enabled: false, isError: true })])).toBe("ready");
  });

  it("is ready when every hop is disabled", () => {
    expect(composeGate([
      hop({ enabled: false, isPending: true }),
      hop({ enabled: false, isPending: true }),
    ])).toBe("ready");
  });

  /** Position must not matter: the first hop is as decisive as the last. */
  it("sees a pending hop wherever it sits in the chain", () => {
    expect(composeGate([hop({ isPending: true }), hop(), hop()])).toBe("resolving");
    expect(composeGate([hop(), hop(), hop({ isPending: true })])).toBe("resolving");
  });

  it("sees a failed hop wherever it sits in the chain", () => {
    expect(composeGate([hop({ isError: true }), hop(), hop()])).toBe("failed");
    expect(composeGate([hop(), hop(), hop({ isError: true })])).toBe("failed");
  });
});
