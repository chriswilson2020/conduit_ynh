import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MOBILE_BREAKPOINT } from "./lib";
import { mobileMediaQuery, readIsMobile, subscribeToMediaQuery } from "./use-is-mobile";
import type { MediaQueryListLike } from "./use-is-mobile";

/**
 * The pure half of useIsMobile. The browser half -- that a real viewport below
 * the breakpoint actually renders the phone shell -- belongs to the
 * phone-viewport e2e journeys; there is no testing-library here and nothing
 * about a MediaQueryList's behaviour would be proven by faking one in jsdom.
 */

/** A MediaQueryList stand-in that records what was subscribed to it. */
function fakeQuery(matches: boolean): MediaQueryListLike & { listeners: (() => void)[] } {
  const listeners: (() => void)[] = [];
  return {
    matches,
    listeners,
    addEventListener(type: "change", listener: () => void) {
      expect(type).toBe("change");
      listeners.push(listener);
    },
    removeEventListener(_type: "change", listener: () => void) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
}

describe("mobileMediaQuery", () => {
  it("is the exact negation of the breakpoint's min-width condition", () => {
    expect(mobileMediaQuery("48rem")).toBe("not all and (min-width: 48rem)");
  });

  it("defaults to the shared breakpoint constant", () => {
    expect(mobileMediaQuery()).toBe(`not all and (min-width: ${MOBILE_BREAKPOINT})`);
  });

  /**
   * The whole point of the constant: styles.css binds Tailwind's `md` variant
   * to the same value the query above is built from, so a `md:` utility and
   * this hook can never disagree about which half of the app the user is in.
   * Moving one without the other fails here rather than shipping a shell whose
   * layout and navigation belong to different breakpoints.
   */
  it("is the value styles.css binds Tailwind's md variant to", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const declared = /--breakpoint-md:\s*([^;]+);/.exec(css);
    expect(declared?.[1]?.trim()).toBe(MOBILE_BREAKPOINT);
  });
});

/**
 * The other cross-file fact the phone layer's comments rest on, pinned here
 * beside the breakpoint for the same reason: it is asserted in prose in three
 * places and enforced by nothing.
 *
 * Task 2 decided AGAINST `viewport-fit=cover` (the reasoning is in
 * components/shell.tsx). That decision is what makes every
 * env(safe-area-inset-*) in this app resolve to 0px, which in turn is why the
 * bottom bar's padding and <main>'s 6rem reservation are correct as written.
 *
 * This test exists to fail the day someone adds it. That is not a veto -- it
 * is a reasonable thing to want -- but it obliges an inset audit of every
 * fixed and full-bleed surface on all four edges, including the desktop
 * sidebar a phone still shows in landscape. Whoever takes that on updates this
 * test, and the three comments it names, in the same commit.
 */
describe("the viewport meta", () => {
  it("does not opt into the display cutout, so the safe-area insets stay 0px", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const meta = /<meta name="viewport" content="([^"]*)"/.exec(html);
    expect(meta?.[1]).toBe("width=device-width, initial-scale=1.0");
  });
});

describe("readIsMobile", () => {
  it("reads a matching query as mobile", () => {
    expect(readIsMobile(fakeQuery(true))).toBe(true);
  });

  it("reads a non-matching query as desktop", () => {
    expect(readIsMobile(fakeQuery(false))).toBe(false);
  });

  it("falls back to desktop when there is no query to read", () => {
    expect(readIsMobile(null)).toBe(false);
  });
});

describe("subscribeToMediaQuery", () => {
  it("notifies on change and detaches on unsubscribe", () => {
    const query = fakeQuery(false);
    let notified = 0;
    const unsubscribe = subscribeToMediaQuery(query, () => {
      notified += 1;
    });

    expect(query.listeners).toHaveLength(1);
    for (const listener of [...query.listeners]) listener();
    expect(notified).toBe(1);

    unsubscribe();
    expect(query.listeners).toHaveLength(0);
  });

  it("is a safe no-op when there is no query", () => {
    const unsubscribe = subscribeToMediaQuery(null, () => {
      throw new Error("a null query must never notify");
    });
    expect(() => unsubscribe()).not.toThrow();
  });
});
