import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { withoutComments } from "./test/source";
import {
  advanceCursorPages,
  cursorForKey,
  emptyCursorPages,
  FIRST_PAGE,
  flattenCursorPages,
  humanSize,
  identityKey,
  mergeCursorPage,
  overridableClass,
  parseDecimal,
  relativeTime,
  todayLocalIso,
  userLabel,
} from "./lib";

/** What the cursor-page record needs of a row, and all it needs. */
interface Row {
  id: string;
}

describe("humanSize", () => {
  it("reports bytes below a kilobyte", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(1023)).toBe("1023 B");
  });

  it("switches to KB at a kilobyte and MB at a megabyte", () => {
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(humanSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanSize(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });
});

describe("parseDecimal", () => {
  it("parses a plain dot-decimal amount", () => {
    expect(parseDecimal("1234.56")).toBe(1234.56);
  });

  it("normalises a comma decimal separator to a dot", () => {
    expect(parseDecimal("1234,56")).toBe(1234.56);
  });

  it("returns null for an empty (post-trim) string", () => {
    expect(parseDecimal("  ")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseDecimal("abc")).toBeNull();
  });
});

// The injected `now` is what makes these deterministic -- see relativeTime's
// own doc comment for why the clock is a parameter rather than read inside.
describe("relativeTime", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("reads a fresh timestamp as 'just now'", () => {
    expect(relativeTime("2026-08-20T11:59:30.000Z", now)).toBe("just now");
  });

  it("counts whole minutes", () => {
    expect(relativeTime("2026-08-20T11:45:00.000Z", now)).toBe("15m ago");
  });

  it("counts whole hours", () => {
    expect(relativeTime("2026-08-20T09:00:00.000Z", now)).toBe("3h ago");
  });

  it("counts whole days up to a week", () => {
    expect(relativeTime("2026-08-18T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("falls back to a date beyond a week", () => {
    // The exact rendering is locale-dependent; what this pins is that it is
    // no longer a relative label.
    expect(relativeTime("2026-06-01T12:00:00.000Z", now)).not.toMatch(/ago$/);
  });

  it("treats a future timestamp as 'just now' rather than a negative age", () => {
    expect(relativeTime("2026-08-20T12:05:00.000Z", now)).toBe("just now");
  });

  it("returns the placeholder for an unparseable value", () => {
    expect(relativeTime("not a date", now)).toBe(String.fromCharCode(0x2014));
  });
});

// The timezone behaviour itself (the actual reason this helper exists --
// local midnight vs. UTC midnight) needs clock injection to test properly,
// which this suite doesn't have; these two just pin the format contract
// every caller (task-board.tsx today, My Tasks/the Gantt's today line later)
// relies on: a plain YYYY-MM-DD string that round-trips through a date-only
// comparison/parse.
describe("todayLocalIso", () => {
  it("returns a zero-padded YYYY-MM-DD string", () => {
    expect(todayLocalIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("parses back as a valid date", () => {
    const iso = todayLocalIso();
    const parsed = new Date(iso);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });
});

describe("userLabel", () => {
  it("prefers the full name LDAP supplied", () => {
    expect(userLabel({ username: "chris", fullName: "Chris Wilson" }, "")).toBe("Chris Wilson");
  });

  it("falls back to the login when there is no full name", () => {
    expect(userLabel({ username: "chris", fullName: null }, "")).toBe("chris");
  });

  // The three fallbacks this replaced, each still expressible -- which is the
  // reason it is an argument rather than a constant.
  it("answers the caller's own fallback for a user it does not have", () => {
    expect(userLabel(undefined, "\u2014")).toBe(String.fromCharCode(0x2014));
    expect(userLabel(null, "...")).toBe("...");
    expect(userLabel(undefined, undefined)).toBeUndefined();
  });
});

describe("identityKey", () => {
  it("is stable across key order", () => {
    expect(identityKey({ unread: true, accountId: "a" }))
      .toBe(identityKey({ accountId: "a", unread: true }));
  });

  it("ignores undefined values", () => {
    expect(identityKey({ accountId: "a", unread: undefined })).toBe(identityKey({ accountId: "a" }));
  });

  it("distinguishes different filter sets", () => {
    expect(identityKey({ unread: true })).not.toBe(identityKey({ unread: false }));
    expect(identityKey({})).not.toBe(identityKey({ unlinked: true }));
  });
});

describe("cursor page accumulation", () => {
  // The merge and the flatten only ever read `id`; every real consumer's row
  // (a thread, an event, a meeting) carries a great deal more, and none of it
  // matters here -- which is the whole reason the record is generic.
  const row = (id: string): Row => ({ id });

  it("collects pages in load order", () => {
    let pages = emptyCursorPages<Row>("k");
    pages = mergeCursorPage(pages, "k", undefined, [row("a"), row("b")], "cursor-1");
    pages = mergeCursorPage(pages, "k", "cursor-1", [row("c")], null);
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // The whole point of keying on the filter set: a filter change must not
  // leave the previous filter's rows on screen behind the new first page.
  it("starts over when the filter key changes", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("k"), "k", undefined, [row("a")], null);
    pages = mergeCursorPage(pages, "unread", undefined, [row("z")], null);
    expect(pages.key).toBe("unread");
    expect(pages.order).toEqual([FIRST_PAGE]);
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["z"]);
  });

  it("replaces a page when that page refetches", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("k"), "k", undefined, [row("a")], "cursor-1");
    pages = mergeCursorPage(pages, "k", "cursor-1", [row("b")], null);
    pages = mergeCursorPage(pages, "k", undefined, [row("new"), row("a")], "cursor-1");
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["new", "a", "b"]);
    expect(pages.order).toEqual([FIRST_PAGE, "cursor-1"]);
  });

  // Returning a fresh object for an unchanged page would set state on every
  // render, forever: the merge runs from a render effect.
  it("returns the same object when nothing changed", () => {
    const items = [row("a")];
    const pages = mergeCursorPage(emptyCursorPages<Row>("k"), "k", undefined, items, "cursor-1");
    expect(mergeCursorPage(pages, "k", undefined, items, "cursor-1")).toBe(pages);
  });

  it("does not return the same object when the server's nextCursor moved", () => {
    const items = [row("a")];
    const pages = mergeCursorPage(emptyCursorPages<Row>("k"), "k", undefined, items, "cursor-1");
    expect(mergeCursorPage(pages, "k", undefined, items, null).nextCursor).toBeNull();
  });

  it("de-duplicates a thread that moved up to the first page", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("k"), "k", undefined, [row("a")], "cursor-1");
    pages = mergeCursorPage(pages, "k", "cursor-1", [row("b"), row("a")], null);
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("cursor page cursors", () => {
  const row = (id: string): Row => ({ id });

  it("hands a cursor back only to the key that issued it", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("a"), "a", undefined, [row("1")], "cursor-1");
    expect(cursorForKey(pages, "a")).toBeUndefined();
    pages = advanceCursorPages(pages, "a");
    expect(cursorForKey(pages, "a")).toBe("cursor-1");
    expect(cursorForKey(pages, "b")).toBeUndefined();
  });

  it("refuses to advance past the last page, or for another key", () => {
    const pages = mergeCursorPage(emptyCursorPages<Row>("a"), "a", undefined, [row("1")], null);
    expect(advanceCursorPages(pages, "a")).toBe(pages);
    const more = mergeCursorPage(emptyCursorPages<Row>("a"), "a", undefined, [row("1")], "cursor-1");
    expect(advanceCursorPages(more, "b")).toBe(more);
  });

  /**
   * THE REGRESSION (quality review, 20 Aug). Load a second page, toggle a
   * filter on, then toggle it back off. The returning key used to find the old
   * page-two cursor still sitting in the component's own state -- while the
   * accumulator had been reset by the intervening filter -- so the list
   * fetched page two, accumulated page two alone, and page ONE silently
   * disappeared. With the cursor living beside the key that issued it, the
   * returning key is page one by construction.
   */
  it("does not revive a cursor when a filter is toggled off again", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("a"), "a", undefined, [row("1")], "cursor-1");
    pages = advanceCursorPages(pages, "a");
    pages = mergeCursorPage(pages, "a", "cursor-1", [row("2")], null);
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["1", "2"]);

    // Filter toggled ON: a key this record is not holding starts at page one...
    expect(cursorForKey(pages, "b")).toBeUndefined();
    pages = mergeCursorPage(pages, "b", undefined, [row("9")], null);

    // ...and toggled back OFF, the original key is page one too -- NOT
    // "cursor-1", which is what used to lose page one.
    expect(cursorForKey(pages, "a")).toBeUndefined();
    pages = mergeCursorPage(pages, "a", cursorForKey(pages, "a"), [row("1")], "cursor-1");
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["1"]);
    expect(pages.order).toEqual([FIRST_PAGE]);
  });

  // The same toggle, fast enough that the intervening filter's page one never
  // landed: the cursor IS handed back, but the pages it belongs to are still
  // there, so the worst case is re-fetching page two -- never a vanished page
  // one.
  it("keeps page one when the toggle beats the intervening fetch", () => {
    let pages = mergeCursorPage(emptyCursorPages<Row>("a"), "a", undefined, [row("1")], "cursor-1");
    pages = advanceCursorPages(pages, "a");
    pages = mergeCursorPage(pages, "a", "cursor-1", [row("2")], null);
    expect(cursorForKey(pages, "a")).toBe("cursor-1");
    expect(flattenCursorPages(pages).map((item) => item.id)).toEqual(["1", "2"]);
  });
});

describe("overridableClass", () => {
  /**
   * THE DEFECT THIS FUNCTION WAS WRITTEN FOR, pinned as a test. ui/dialog.tsx
   * used to spell `max-w-md` in its own shape and then append the caller's
   * class, so both were emitted at equal specificity -- and Tailwind sorts
   * `max-w-*` alphabetically rather than by size, putting `.max-w-md` after
   * `.max-w-2xl` and `.max-w-3xl`. Measured at 1280 before the fix: a dialog
   * asking for `max-w-3xl` computed 448px, and all four callers that passed a
   * width had been inert since the utility was introduced.
   *
   * Nothing here can see a stylesheet. What it CAN guarantee is that the
   * conflict is never created, which is the property the fix rests on: when the
   * caller sets a class from the family, the default is not emitted at all.
   */
  it("yields the default only when the caller sets nothing from that family", () => {
    expect(overridableClass("max-w-md", "max-w-", undefined)).toBe("max-w-md");
    expect(overridableClass("max-w-md", "max-w-", "")).toBe("max-w-md");
    expect(overridableClass("max-w-md", "max-w-", "overflow-y-auto")).toBe("max-w-md");
  });

  it("stands aside for a caller's own class from that family", () => {
    expect(overridableClass("max-w-md", "max-w-", "max-w-3xl")).toBe("");
    expect(overridableClass("max-w-md", "max-w-", "max-h-[85vh] max-w-2xl overflow-y-auto")).toBe("");
  });

  /**
   * `max-md:max-w-none` MUST NOT COUNT AS AN OVERRIDE. It is the phone shape's
   * own class and it has to keep beating whatever width the caller chose --
   * which it does, because every `max-md` rule is emitted after the base layer.
   * Treating it as an override would drop the desktop default and leave a
   * dialog with no card width at a desk.
   */
  it("matches whole classes, so a variant-prefixed one is not an override", () => {
    expect(overridableClass("max-w-md", "max-w-", "max-md:max-w-none")).toBe("max-w-md");
    // ASSEMBLED FROM PARTS, NOT WRITTEN OUT, and the reason is the trap this
    // repo has now hit three times: Tailwind v4 scans source as plain text and
    // compiles any class it finds, in a comment or a test literal alike. The
    // spelled-out form of this token existed nowhere but here and in one doc
    // comment, and it was in the shipped stylesheet -- 0.06 kB of rules nothing
    // renders. Both halves below already appear in real code, so joining them
    // here adds nothing to the build.
    const variantPrefixed = ["md", "max-w-md"].join(":");
    expect(overridableClass("max-w-md", "max-w-", variantPrefixed)).toBe("max-w-md");
  });

  it("is not fooled by a class that merely contains the family", () => {
    expect(overridableClass("max-w-md", "max-w-", "not-max-w-lg")).toBe("max-w-md");
  });
});

describe("the Tailwind-in-prose trap", () => {
  /**
   * THIS REPO HAS PAID FOR THE SAME MISTAKE THREE TIMES, so it is worth a guard
   * rather than a fourth comment telling people not to make it.
   *
   * Tailwind v4 scans source as PLAIN TEXT and does not know a comment from
   * code. A class name written in prose is therefore compiled into the
   * stylesheet. Phase 6 spelled an abbreviated bracketed utility in a comment
   * and lightningcss rejected the rule it generated, so every build from then on
   * carried a warning that read like a real CSS bug. Phase 7 named a
   * variant-prefixed width in a doc comment and a test literal, and shipped
   * 0.06 kB of rules nothing renders -- proved by rebuilding without them, which
   * moved the stylesheet's hash.
   *
   * THE RULE THIS ENFORCES is not "never name a class in a comment", which would
   * be unusable -- ui/dialog.tsx's comments are largely about specific classes,
   * and every one of them is a class that file also uses. It is the narrower
   * and exactly right one: A VARIANT-PREFIXED CLASS NAMED IN A COMMENT MUST ALSO
   * APPEAR IN REAL CODE SOMEWHERE IN THIS TREE. If it does, Tailwind was going
   * to emit it anyway and the comment costs nothing; if it does not, the comment
   * is the only reason it is in the stylesheet.
   *
   * Scoped to variant-prefixed classes because those are unambiguous. A bare
   * word like `hidden` or `flex` in prose cannot be told apart from English.
   */
  const VARIANT = "(?:max-)?(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|group-hover|peer-focus|dark|print)";
  const CLASS_TOKEN = new RegExp(`\\b${VARIANT}:[a-z0-9][a-z0-9./%[\\]()_-]*`, "g");

  function sources(dir: URL): URL[] {
    const out: URL[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...sources(new URL(`${entry.name}/`, dir)));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(new URL(entry.name, dir));
      }
    }
    return out;
  }

  it("names no variant-prefixed class in prose that the code does not also use", () => {
    const files = sources(new URL("./", import.meta.url));
    const inCode = new Set<string>();
    const inProse = new Map<string, string>();

    for (const file of files) {
      const whole = readFileSync(file, "utf8");
      const code = withoutComments(whole);
      for (const match of code.matchAll(CLASS_TOKEN)) inCode.add(match[0]);
      // Whatever the comments held that the code did not.
      const codeTokens = new Set([...code.matchAll(CLASS_TOKEN)].map((m) => m[0]));
      for (const match of whole.matchAll(CLASS_TOKEN)) {
        if (!codeTokens.has(match[0])) inProse.set(match[0], file.pathname);
      }
    }

    const onlyInProse = [...inProse].filter(([cls]) => !inCode.has(cls));
    expect(onlyInProse.map(([cls, where]) => `${cls} (${where.split("/src/")[1] ?? where})`)).toEqual([]);
  });
});
