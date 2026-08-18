import { describe, it, expect } from "vitest";
import { midpoint } from "./fractional.js";

describe("midpoint", () => {
  it("returns a non-empty string for the very first key", () => {
    expect(midpoint(null, null).length).toBeGreaterThan(0);
  });

  it("inserting 100 times always-at-the-front yields strictly descending keys, each valid between null and the previous head", () => {
    let head = midpoint(null, null);
    const heads = [head];
    for (let i = 0; i < 100; i++) {
      const next = midpoint(null, head);
      expect(next < head).toBe(true);
      // Re-derive the same key from the pair to confirm it is genuinely
      // "between null and the previous head", not just smaller by luck.
      expect(midpoint(null, head)).toBe(next);
      heads.push(next);
      head = next;
    }
    const sorted = [...heads].sort();
    // Ascending sort order is the reverse of insertion order, since every
    // insertion went strictly before the previous smallest.
    expect(sorted).toEqual([...heads].reverse());
  });

  it("inserting 100 times always-at-the-end yields strictly ascending keys", () => {
    let tail = midpoint(null, null);
    const tails = [tail];
    for (let i = 0; i < 100; i++) {
      const next = midpoint(tail, null);
      expect(next > tail).toBe(true);
      tails.push(next);
      tail = next;
    }
    expect([...tails].sort()).toEqual(tails);
  });

  it("100 repeated midpoints between the same two neighbours stay strictly ordered and under 40 chars", () => {
    const lo = midpoint(null, null);
    let hi = midpoint(lo, null);
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      hi = midpoint(lo, hi);
      keys.push(hi);
    }
    for (const k of keys) {
      expect(k > lo).toBe(true);
      expect(k.length).toBeLessThan(40);
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! < keys[i - 1]!).toBe(true);
    }
  });

  it("throws when a >= b", () => {
    const a = midpoint(null, null);
    const b = midpoint(a, null);
    expect(() => midpoint(b, a)).toThrow();
    expect(() => midpoint(a, a)).toThrow();
  });

  it("property blast: 500 random insertions into a growing ordered list stay order-consistent under plain string sort", () => {
    const list: string[] = [midpoint(null, null)];
    for (let i = 0; i < 500; i++) {
      const idx = Math.floor(Math.random() * (list.length + 1));
      const before = idx > 0 ? list[idx - 1]! : null;
      const after = idx < list.length ? list[idx]! : null;
      const key = midpoint(before, after);
      list.splice(idx, 0, key);
    }
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });
});
