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
   * asking for `max-w-3xl` computed 448px. Three of the four callers that pass a
   * width had been inert since the utility was introduced; the quote form is the
   * fourth and was born inert.
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

  /**
   * THE HYPHENATED HALF, WHICH THE VARIANT GUARD ABOVE CANNOT SEE.
   *
   * v1.1.0 wrote the BARE FORM of `max-md:overflow-clip` in a comment while the
   * code used only the variant. Tailwind emitted the bare rule, nothing rendered it,
   * and it moved the build's hash -- the fourth time this repo has paid for
   * this trap and the first the variant guard could not catch, because the
   * token carried no variant prefix.
   *
   * BOTH HALVES OF THE TOKEN ARE CHECKED, AND THE FAMILY ALONE IS NOT ENOUGH.
   * A hyphenated token in lower case is not evidence of anything: this
   * tree's prose is full of `read-only`, `hand-written`, `font-metric`,
   * `drag-to-reschedule` and `min-content`, none of which Tailwind compiles.
   * The family list below -- everything before a token's last hyphenated
   * segment -- cuts most of that, and it deliberately omits families that
   * collide with ordinary English (`font`, `text`, `border`, `list`, `object`,
   * `order`, `content`, `space`, `box`).
   *
   * IT WAS STILL NOT ENOUGH, MEASURED: the family half alone flagged twelve
   * innocent phrases across this tree -- `top-level`, `self-heals`,
   * `inline-image`, `z-indices`, `row-level`, `flex-basis`, `cursor-page` and
   * more. So the VALUE half is checked too, against what these families
   * actually take: a number, a fraction, an arbitrary bracket, or one of a
   * short list of keywords. The bare form of `max-md:overflow-clip` passes both
   * and is caught; `top-level` shares a family with `top-0` and fails on
   * `level`.
   *
   * The consequence of a wrong list is asymmetric, so it errs one way: a
   * missing value is a utility this guard does not catch, and a spurious one is
   * a red suite for a sentence. A guard that goes red because somebody
   * explained a font stack is worse than no guard, and this repo learned that
   * lesson once already from a looser comment stripper.
   *
   * WHAT IT STILL CANNOT CATCH, and this is the ruling rather than an
   * oversight: a BARE ENGLISH WORD that is also a utility. `visible`, `block`,
   * `hidden`, `sticky`, `fixed`, `truncate` and `flex` cannot be told apart
   * from prose by any regex, and `.visible{visibility:visible}` is in the
   * shipped stylesheet today for exactly that reason. Counted before this was
   * written down: the standalone word "visible" appears 195 times across 61
   * source files here, every one of them an ordinary English sentence. Closing
   * that half means banning those words from comments to save 27 bytes, which
   * is a worse trade than the rule it would enforce. The hyphenated half is
   * closable and is closed.
   */
  /**
   * EVERY ENTRY CARRIES A `_` THAT IS STRIPPED, and that is not decoration.
   *
   * This file is scanned by Tailwind exactly like every other, so a family name
   * that is ALSO a bare utility -- several below are -- becomes a real rule
   * just by being a string literal here. Measured: the first version of these
   * two lists shipped one such rule into the stylesheet with nothing rendering
   * it, which is a guard against dead rules emitting one of its own. The marker
   * makes each entry resolve to nothing, and `_` is a word character so the
   * scanner does not split on it.
   *
   * The prose has to obey the same rule, and it took a second build to learn
   * that: naming the offending utility HERE, while explaining it, put the rule
   * straight back. This paragraph names none.
   */
  const withoutMarker = (list: string): Set<string> =>
    new Set(list.split(/\s+/).filter(Boolean).map((entry) => entry.slice(1)));

  const FAMILIES = withoutMarker(`
    _overflow _overflow-x _overflow-y _overscroll
    _min-w _min-h _max-w _max-h _w _h _size
    _top _bottom _left _right _inset _inset-x _inset-y _z
    _p _px _py _pt _pb _pl _pr
    _m _mx _my _mt _mb _ml _mr
    _gap _gap-x _gap-y _flex _grid _grid-cols _col _col-span _row
    _items _justify _self _place _shrink _grow _basis
    _rounded _divide _ring _shadow _opacity _cursor _whitespace
    _inline _float _clear _aspect _columns _isolation
  `);
  /**
   * What those families take as a value: a number, a fraction, an arbitrary
   * bracket, or one of these. Short on purpose -- see the note above on which
   * way a wrong list should err.
   */
  const VALUES = withoutMarker(`
    _auto _none _full _screen _px _min _max _fit _clip _visible
    _hidden _scroll _contain _center _start _end _between _around
    _evenly _stretch _baseline _col _row _wrap _nowrap _reverse
    _pointer _default _move _grab _grabbing _wait _help _crosshair
    _block _flex _grid _table _contents _sm _md _lg _xl _2xl
    _3xl _dashed _dotted _solid _initial _first _last
  `);
  /**
   * THE LOOKBEHIND IS THE DIFFERENCE BETWEEN THIS GUARD WORKING AND NOT, and it
   * was found by mutation rather than by reasoning. Without it, the bare form
   * is harvested out of the `max-md:overflow-clip` in REAL CODE -- so the bare
   * form named in prose looked like a class the code also used, and this
   * round's actual mistake sailed straight through the guard written to catch
   * it. A variant-prefixed class is the variant guard's business; only a token
   * standing on its own counts here.
   */
  const HYPHENATED = /(?<![\w:.-])[a-z][a-z0-9]*(?:-[a-z0-9.[\]/%]+)+\b/g;

  const familyOf = (token: string): string => token.slice(0, token.lastIndexOf("-"));
  const valueOf = (token: string): string => token.slice(token.lastIndexOf("-") + 1);
  const looksLikeAValue = (value: string): boolean =>
    VALUES.has(value) || /^\d+(?:\.\d+)?$/.test(value) || /^\d+\/\d+$/.test(value)
    || /^\[.*\]$/.test(value);

  /** The rule itself, over any corpus -- so it can be driven by the test below. */
  function proseOnlyUtilities(corpus: readonly { name: string; source: string }[]): string[] {
    const inCode = new Set<string>();
    const inProse = new Map<string, string>();
    for (const { name, source } of corpus) {
      const code = withoutComments(source);
      const codeTokens = new Set([...code.matchAll(HYPHENATED)].map((m) => m[0]));
      for (const token of codeTokens) inCode.add(token);
      for (const match of source.matchAll(HYPHENATED)) {
        if (!codeTokens.has(match[0])) inProse.set(match[0], name);
      }
    }
    return [...inProse]
      .filter(([token]) =>
        !inCode.has(token) && FAMILIES.has(familyOf(token)) && looksLikeAValue(valueOf(token)))
      .map(([token, where]) => `${token} (${where})`);
  }

  it("names no hyphenated utility in prose that the code does not also use", () => {
    const corpus = sources(new URL("./", import.meta.url)).map((file) => ({
      name: file.pathname.split("/src/")[1] ?? file.pathname,
      source: readFileSync(file, "utf8"),
    }));
    expect(proseOnlyUtilities(corpus)).toEqual([]);
  });

  /**
   * THE GUARD'S OWN STRENGTH, PINNED -- because a guard that quietly stops
   * guarding is worse than none, and this one did.
   *
   * Mutation found two ways it degraded in silence: dropping the lookbehind
   * made it harvest a bare token out of a VARIANT-PREFIXED class in real code,
   * so the exact mistake it was written for stopped being caught; and a value
   * list that was too permissive turned it red over ordinary English. Neither
   * showed up in a suite run over this tree, because the tree is clean. So the
   * rule is driven over a corpus written to contain both.
   *
   * The tokens are assembled from marked strings for the same reason the lists
   * above are: this file is scanned, and spelling a utility here would emit it.
   */
  it("catches the shape that got past the variant guard, and nothing else", () => {
    const unmark = (token: string): string => token.slice(1);
    const bare = unmark("_overflow-clip");
    const variant = `max-md:${bare}`;

    // The real case: the code uses only the variant, the comment names the bare
    // form. Without the lookbehind the bare form is harvested out of the
    // variant and this comes back empty.
    expect(proseOnlyUtilities([
      { name: "a.tsx", source: `const x = "${variant}";\n/* about ${bare} */` },
    ])).toEqual([`${bare} (a.tsx)`]);

    // Named in prose AND used in code: Tailwind was going to emit it anyway.
    expect(proseOnlyUtilities([
      { name: "a.tsx", source: `const x = "${bare}";\n/* about ${bare} */` },
    ])).toEqual([]);

    // Used in one file, explained in another: still fine, the set is tree-wide.
    expect(proseOnlyUtilities([
      { name: "a.tsx", source: `const x = "${bare}";` },
      { name: "b.tsx", source: `/* about ${bare} */` },
    ])).toEqual([]);

    // AND ORDINARY ENGLISH IS NOT A UTILITY. Every one of these shares a family
    // with a real class in this tree and was flagged by an earlier version.
    const english = ["top-level", "self-heals", "row-level", "inline-image",
      "z-indices", "flex-basis", "cursor-page", "right-alignment", "min-content",
      "read-only", "hand-written", "font-metric"];
    expect(proseOnlyUtilities([
      { name: "a.tsx", source: `const x = "${bare}";\n/* ${english.join(" ")} */` },
    ])).toEqual([]);
  });
});
