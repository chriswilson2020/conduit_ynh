import { describe, it, expect } from "vitest";
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
    expect(overridableClass("max-w-md", "max-w-", "md:max-w-lg")).toBe("max-w-md");
  });

  it("is not fooled by a class that merely contains the family", () => {
    expect(overridableClass("max-w-md", "max-w-", "not-max-w-lg")).toBe("max-w-md");
  });
});
