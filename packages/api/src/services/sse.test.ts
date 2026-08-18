import { describe, it, expect, vi } from "vitest";
import type { SseHint } from "@conduit/shared";
import { publish, subscribe, subscriberCount } from "./sse.js";

describe("sse hub", () => {
  it("starts with zero subscribers", () => {
    expect(subscriberCount()).toBe(0);
  });

  it("publish reaches multiple subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    expect(subscriberCount()).toBe(2);

    const hint: SseHint = { keys: [["companies"]] };
    publish(hint);

    expect(a).toHaveBeenCalledExactlyOnceWith(hint);
    expect(b).toHaveBeenCalledExactlyOnceWith(hint);

    unsubA();
    unsubB();
  });

  it("unsubscribe stops delivery", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    unsub();
    expect(subscriberCount()).toBe(0);

    publish({ keys: [["events"]] });
    expect(fn).not.toHaveBeenCalled();
  });

  it("drops a throwing subscriber without preventing others from receiving, and does not call it again", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const unsubBad = subscribe(bad);
    const unsubGood = subscribe(good);

    expect(() => publish({ keys: [["deals", "p1"]] })).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(subscriberCount()).toBe(1);

    // Subsequent publishes do not call the dropped subscriber again.
    publish({ keys: [["deals", "p1"]] });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);

    unsubGood();
  });

  it("publish with zero subscribers is a no-op", () => {
    expect(subscriberCount()).toBe(0);
    expect(() => publish({ keys: [["search"]] })).not.toThrow();
  });
});
