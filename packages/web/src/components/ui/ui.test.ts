import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * What components/ui promises below the breakpoint, guarded the only way a
 * repo with no testing-library can guard a class string: by reading the
 * source. These match SPELLINGS, not behaviours -- the rendering itself is
 * Task 6's phone-viewport e2e -- so they are worth exactly as much as the
 * assumption that a `max-md:` utility does what Tailwind says. They exist
 * because these particular spellings are load-bearing and easy to delete by
 * accident while tidying, not because they prove the phone UI works.
 */

const here = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("the modal skeleton", () => {
  /**
   * The fold's whole point. Before Phase 6 the Portal > Overlay > Content
   * skeleton was written out three times -- DialogContent, DrawerContent, and
   * the phone sheet stranded in components/bottom-nav.tsx -- and the ruling on
   * bringing the sheet in here was to collapse them rather than to add a
   * fourth. A future variant should extend the SHAPES table; a fourth copy of
   * the skeleton should cost a failing test.
   */
  it("is written once, however many shapes are pinned to it", () => {
    // Opening tags only -- a closing </RadixDialog.Portal> is the same copy.
    const dialog = here("dialog.tsx");
    expect(dialog.match(/<RadixDialog\.Portal/g) ?? []).toHaveLength(1);
    expect(dialog.match(/<RadixDialog\.Overlay/g) ?? []).toHaveLength(1);
    expect(dialog.match(/<RadixDialog\.Content/g) ?? []).toHaveLength(1);
  });

  /**
   * The other half of that ruling: the sheet lives WITH its neighbours. A
   * components/ui/sheet.tsx would be the fourth copy under a different name.
   */
  it("keeps the sheet in dialog.tsx rather than in a file of its own", () => {
    expect(existsSync(new URL("./dialog.tsx", import.meta.url))).toBe(true);
    expect(existsSync(new URL("./sheet.tsx", import.meta.url))).toBe(false);
    expect(here("dialog.tsx")).toContain("export function SheetContent");
  });

  /**
   * Task 1's search sheet opens focused on its own field instead of on Close,
   * and it can only do that because the sheet forwards the rest of Radix's
   * Content props through. A signature narrowed to `{ children, className }`
   * -- which is what DialogContent had before the fold -- would silently drop
   * onOpenAutoFocus and park focus back on "Close, button".
   */
  it("passes Radix's own Content props through, onOpenAutoFocus included", () => {
    const dialog = here("dialog.tsx");
    expect(dialog).toContain("ComponentPropsWithoutRef<typeof RadixDialog.Content>");
    expect(dialog).toContain("{...rest}");
    expect(here("../bottom-nav.tsx")).toContain("onOpenAutoFocus");
  });

  /**
   * The phone form of a dialog is pinned to all four edges, so it has no
   * outside to click, and a phone has no Escape key -- the two ways a dialog
   * is normally dismissed both stop existing at once. Eight of this app's
   * DialogContent callers render no Cancel of their own, so without this the
   * sweep would have turned eight working dialogs into dead ends. It is
   * asserted here rather than trusted because it is invisible at a desk: the
   * control is display:none above the breakpoint, so deleting it breaks
   * nothing a desktop test or a desktop pair of eyes would notice.
   */
  it("gives every phone-sized dialog a way out", () => {
    const dialog = here("dialog.tsx");
    const body = dialog.slice(dialog.indexOf("export function DialogContent"), dialog.indexOf("export function DrawerContent"));
    expect(body).toContain("RadixDialog.Close");
    expect(body).toContain("md:hidden");
  });

  /**
   * A caller's class and the shape's have the same specificity, so which wins
   * is decided by the order Tailwind emits them, not by the order they are
   * written. Below the breakpoint the shape wins on the three families a
   * caller currently reaches for -- the width cap, the height cap and
   * scrolling -- because every `max-md` rule is emitted after the whole base
   * utility layer. So the invariant this guards is not which VALUES the
   * callers pass but which PROPERTIES they touch: a dialog sized some other
   * way (a fixed width, its own inset, a radius) would leave the phone sheet
   * wearing half a desktop card, and has to teach the shape a matching
   * override before it gets past here.
   *
   * DO NOT READ THIS AS "the caller's cap applies at a desk", because two of
   * the three do not. Tailwind sorts `max-w-*` alphabetically, not by size, so
   * `.max-w-md` from the shape is emitted AFTER `.max-w-2xl` and `.max-w-3xl`
   * and wins in the base layer: measured at 1280, a DialogContent carrying
   * `max-w-3xl` computes `max-width: 448px`. The width caps on composer.tsx,
   * settings-mail.tsx and settings-templates.tsx are inert at every width.
   * That is PRE-EXISTING and deliberately not fixed by this phase -- widening
   * three dialogs is a desktop change -- but nothing here should imply
   * otherwise. The height caps are a different utility from the shape's and do
   * apply at a desk.
   *
   * WHAT THIS GUARD CANNOT SEE, the same caveat nav-lib.test.ts's two source
   * readers carry: it matches ONE SPELLING, a literal
   * `<DialogContent className="...">`. A caller composing its class with
   * clsx(), a template literal, or a variable slips past silently.
   */
  it("lets callers tune only the properties the phone shape undoes", () => {
    const dialog = here("dialog.tsx");
    const shape = dialog.slice(dialog.indexOf("dialog: clsx("), dialog.indexOf("drawer: clsx("));
    expect(shape).toContain("max-md:max-w-none");
    expect(shape).toContain("max-md:max-h-none");
    expect(shape).toContain("max-md:overflow-y-auto");

    const tunable = /^(max-w-|max-h-|overflow-|md:)/;
    const offenders: string[] = [];
    for (const file of walk(new URL("../../", import.meta.url))) {
      for (const match of readFileSync(file, "utf8").matchAll(/<DialogContent className="([^"]*)"/g)) {
        for (const cls of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
          if (!tunable.test(cls)) offenders.push(cls);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the 44px touch floor", () => {
  /**
   * The phase names icon buttons, tab triggers, list rows and menu items. The
   * primitives below are where all four of them are actually built, so this is
   * the one place the floor can be asserted rather than chased around the
   * pages.
   *
   * `max-md:` IS THE POINT, and a bare min-h-11 would be the bug: ui/input.tsx
   * is the same element as the desktop header's search box, ui/button.tsx is
   * every button in the app, and growing either at a desk is the one thing
   * this phase may not do. Hence both halves of each assertion.
   */
  const floored = ["button.tsx", "input.tsx", "textarea.tsx", "select.tsx", "tabs.tsx"];

  for (const name of floored) {
    it(`${name} reaches 44px below the breakpoint and nowhere else`, () => {
      const source = here(name);
      expect(source).toContain("max-md:min-h-11");
      // The bare utility, not the variant: a "min-h-11" that is not preceded
      // by "max-md:" would apply at every width.
      expect(source).not.toMatch(/(?<!max-md:)\bmin-h-11\b/);
    });
  }

  /**
   * The record rail's five tabs have a fixed 349px intrinsic width -- each
   * label is one unbreakable word, so a trigger cannot shrink below its text
   * -- against a 327px content box at 375px. Measured before the fix: at 375px
   * the strip spilled 22px out of its container, and at 360px the whole page
   * scrolled sideways and the Meetings tab left the screen. The scroll
   * container and the shrink-0 have to arrive together; either alone leaves
   * one of those two states in place.
   */
  it("lets the tab strip scroll instead of spilling, below the breakpoint only", () => {
    const tabs = here("tabs.tsx");
    expect(tabs).toContain("max-md:overflow-x-auto");
    expect(tabs).toContain("max-md:shrink-0");
    expect(tabs).not.toMatch(/(?<!max-md:)\boverflow-x-auto\b/);
  });
});

/** Every .tsx under packages/web/src, for the caller scan above. */
function walk(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(new URL(`${entry.name}/`, dir)));
    else if (entry.name.endsWith(".tsx")) out.push(new URL(entry.name, dir));
  }
  return out;
}
