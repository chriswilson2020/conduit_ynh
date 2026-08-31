import { describe, it, expect } from "vitest";
import { composeGate, stalledHops, type ComposeHop } from "./mail-lib";

/**
 * The Compose gate's rules, exhaustively.
 *
 * WHAT THIS FILE DOES NOT COVER, said here rather than left to be discovered:
 * it pins the RULE, not the wiring. Nothing here can tell whether mail.tsx
 * builds its four hops from the right queries, or whether the button reads this
 * answer at all -- that is e2e/rail-compose.spec.ts's job, against the real app
 * with a real query chain held open. A green file here and a red one there is
 * the expected shape of a wiring mistake.
 *
 * THE QUERY STATES BELOW ARE MEASURED, not invented. Each was produced against
 * the installed @tanstack/query-core 5.101.4 by driving a QueryObserver through
 * useBaseQuery's own per-render sequence: a first success followed by a failing
 * refetch really does report `isError` with `data` intact; an offline fetch
 * really does sit at `fetchStatus: "paused"` with `isError: false` and the
 * queryFn never called; and a query nobody asked for really does sit at no
 * data, idle, no error -- which is why `neverAsked` is a state here and not a
 * flag on the hop.
 */

function state(over: Partial<ComposeHop> = {}): ComposeHop {
  return { data: undefined, isError: false, fetchStatus: "idle", ...over };
}

/** Arrived, and nothing on the wire. */
const answered = (): ComposeHop => state({ data: { id: "x" } });
/** First load, still going. */
const fetching = (): ComposeHop => state({ fetchStatus: "fetching" });
/** Failed with nothing to show for it, retries spent. */
const failed = (): ComposeHop => state({ isError: true });
/** Offline: pending for ever, and it never errors. */
const paused = (): ComposeHop => state({ fetchStatus: "paused" });
/** Failed, and being asked again -- which is what the Retry button produces. */
const retrying = (): ComposeHop => state({ isError: true, fetchStatus: "fetching" });
/** Cached data, refetch in flight. */
const refetching = (): ComposeHop => state({ data: { id: "x" }, fetchStatus: "fetching" });
/** Cached data, refetch failed: `isError` true and the data still there. */
const refetchFailed = (): ComposeHop => state({ data: { id: "x" }, isError: true });
/** A DISABLED query: `useContact("")`, and the project hook on every deal tab. */
const neverAsked = (): ComposeHop => state();

describe("composeGate", () => {
  it("is ready with no hops at all", () => {
    expect(composeGate([])).toBe("ready");
  });

  it("is ready when every hop has answered", () => {
    expect(composeGate([answered(), answered(), answered()])).toBe("ready");
  });

  it("is resolving while a hop is on the wire", () => {
    expect(composeGate([answered(), fetching()])).toBe("resolving");
  });

  it("is failed when a hop errored with nothing to show", () => {
    expect(composeGate([answered(), failed()])).toBe("failed");
  });

  /**
   * THE STATE THAT NEVER ERRORS. Offline, `networkMode: "online"` pauses the
   * fetch: pending for ever, `isError` false, queryFn never called. A gate
   * built on `isPending` would sit at "resolving" with no error to escape
   * through, which is the dead-button shape v1.1.0 rejected -- and it is
   * reachable, because pages/deal-detail.tsx mounts the rail inside its
   * `isLoading` branch.
   */
  it("is failed, not resolving, when a hop is paused offline", () => {
    expect(composeGate([answered(), paused()])).toBe("failed");
  });

  /**
   * THE STATE THAT RETIRED THE `enabled` FLAG. A query nobody asked for is
   * empty and idle with no error, exactly like a disabled one, so BOTH
   * predicates require a reason -- otherwise every deal tab would raise an
   * alert about the project it does not have.
   */
  it("is ready beside a hop that was never asked for", () => {
    expect(composeGate([answered(), neverAsked()])).toBe("ready");
    expect(composeGate([neverAsked(), neverAsked()])).toBe("ready");
  });

  /**
   * The button's state is the question, so anything on the wire holds it shut;
   * the failure is reported on the render after that hop settles.
   */
  it("reports resolving rather than failed when both are present", () => {
    expect(composeGate([failed(), fetching()])).toBe("resolving");
  });

  /** A single hop can be both, and that is exactly what pressing Retry makes. */
  it("reads a failed hop that is being retried as resolving", () => {
    expect(composeGate([retrying()])).toBe("resolving");
  });

  /**
   * A FAILURE THAT LOST NOTHING MUST NOT RAISE AN ALARM. Measured: a query
   * whose refetch fails keeps its data and still reports `isError`. With
   * `staleTime: 10_000` and `refetchOnWindowFocus` at its default, one
   * transient 500 on a tab refocus would otherwise paint "could not load the
   * contact" beside a composer that goes on to seed that contact correctly.
   */
  it("is ready when a failed refetch left the cached answer in place", () => {
    expect(composeGate([refetchFailed()])).toBe("ready");
  });

  it("is ready while a hop holding data refetches in the background", () => {
    expect(composeGate([refetching()])).toBe("ready");
  });

  /** Position must not matter: the first hop is as decisive as the last. */
  it("sees a hop on the wire wherever it sits in the chain", () => {
    expect(composeGate([fetching(), answered(), answered()])).toBe("resolving");
    expect(composeGate([answered(), answered(), fetching()])).toBe("resolving");
  });

  it("sees a stalled hop wherever it sits in the chain", () => {
    expect(composeGate([failed(), answered(), answered()])).toBe("failed");
    expect(composeGate([answered(), answered(), paused()])).toBe("failed");
  });
});

describe("stalledHops", () => {
  /** The caller's own fields ride along, because the retry is bound to them. */
  interface Tagged extends ComposeHop { readonly tag: string }
  const tagged = (tag: string, hop: ComposeHop): Tagged => ({ tag, ...hop });

  it("returns the hops that hold nothing and have nothing coming", () => {
    const hops = [
      tagged("deal", answered()),
      tagged("contact", failed()),
      tagged("company", paused()),
    ];
    expect(stalledHops(hops).map((hop) => hop.tag)).toEqual(["contact", "company"]);
  });

  it("leaves out a hop whose failed refetch kept its data", () => {
    expect(stalledHops([tagged("contact", refetchFailed())])).toEqual([]);
  });

  /**
   * MEASURED, AND THE REASON THIS IS SCOPED AT ALL: `refetch()` on a DISABLED
   * query goes to the network anyway -- queryFn calls went 0 to 1 against
   * query-core 5.101.4 -- so a Retry that asked every hop would send
   * `GET /contacts/` with an empty id from every deal that has no contact.
   * A hop nobody asked for is not stalled, so it is never in this list.
   */
  it("leaves out a hop that was never asked for", () => {
    expect(stalledHops([tagged("contact", neverAsked())])).toEqual([]);
  });

  it("leaves out a hop that is merely on the wire", () => {
    expect(stalledHops([tagged("deal", fetching())])).toEqual([]);
  });
});
