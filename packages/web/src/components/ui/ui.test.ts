import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { withoutComments } from "../../test/source";

/**
 * What components/ui promises below the breakpoint, guarded the only way a
 * repo with no testing-library can guard a class string: by reading the
 * source. These match SPELLINGS, not behaviours -- the rendering itself is
 * Task 6's phone-viewport e2e -- so they are worth exactly as much as the
 * assumption that a `max-md:` utility does what Tailwind says. They exist
 * because these particular spellings are load-bearing and easy to delete by
 * accident while tidying, not because they prove the phone UI works.
 *
 * THE SCOPE OF AN ASSERTION IS ITS WHOLE VALUE, and the first version of this
 * file got that wrong four times over: a quality review mutated each guard and
 * found that deleting the floor from ONE of select.tsx's two elements, moving
 * the tab pairing from the trigger to the list, adding a fourth modal skeleton
 * under a new filename, and passing a caller class after `data-testid` all
 * left every test green. A file-scoped assertion about an element, and a
 * one-file search for a tree-wide property, are both a guard's shape without
 * its substance. Each is now scoped to the thing it is actually about.
 */

const SRC = new URL("../../", import.meta.url);

const here = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** Every .tsx under packages/web/src. */
function walk(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(new URL(`${entry.name}/`, dir)));
    else if (entry.name.endsWith(".tsx")) out.push(new URL(entry.name, dir));
  }
  return out;
}


/**
 * One exported component's source, from its `export function <Name>` to the
 * next top-level `export` -- the unit these assertions are really about. A
 * file is not: select.tsx holds two elements that need the floor
 * independently, and tabs.tsx holds a list and a trigger that need two
 * different halves of the same fix.
 */
function component(file: string, name: string): string {
  const source = withoutComments(here(file));
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `${file} has no exported ${name}`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("the modal skeleton", () => {
  /**
   * The fold's whole point. Before Phase 6 the Portal > Overlay > Content
   * skeleton was written out three times -- DialogContent, DrawerContent, and
   * the phone sheet stranded in components/bottom-nav.tsx -- and the ruling on
   * bringing the sheet in here was to collapse them rather than to add a
   * fourth. A future variant should extend the SHAPES table.
   *
   * COUNTED OVER THE WHOLE TREE, not over dialog.tsx: the mutation this failed
   * was a fourth skeleton added as its own file, which is exactly the shape
   * the ruling forbade and exactly what a one-file count cannot see.
   */
  it("is written once in the whole package, however many shapes are pinned to it", () => {
    // Opening tags only -- a closing </RadixDialog.Portal> is the same copy.
    const found: Record<string, string[]> = { Portal: [], Overlay: [], Content: [] };
    for (const file of walk(SRC)) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const part of Object.keys(found)) {
        const hits = source.match(new RegExp(`<RadixDialog\\.${part}\\b`, "g")) ?? [];
        for (const _ of hits) found[part]?.push(file.pathname.split("/src/")[1] ?? file.pathname);
      }
    }
    expect(found.Portal).toEqual(["components/ui/dialog.tsx"]);
    expect(found.Overlay).toEqual(["components/ui/dialog.tsx"]);
    expect(found.Content).toEqual(["components/ui/dialog.tsx"]);
  });

  /**
   * The other half of that ruling: the sheet lives WITH its neighbours, so a
   * second home for it is a finding wherever it is and whatever it is called.
   */
  it("keeps every sheet export in dialog.tsx", () => {
    const homes = new Set<string>();
    for (const file of walk(SRC)) {
      if (/export function Sheet\w+\(/.test(withoutComments(readFileSync(file, "utf8")))) {
        homes.add(file.pathname.split("/src/")[1] ?? file.pathname);
      }
    }
    expect([...homes]).toEqual(["components/ui/dialog.tsx"]);
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
    const body = component("dialog.tsx", "DialogContent");
    expect(body).toContain("RadixDialog.Close");
    expect(body).toContain("md:hidden");
  });

  /**
   * THE SAME PROMISE FOR SHEETS, which get theirs a different way. A sheet's
   * Close lives in SheetHeader, and the pieces are separately composable, so
   * `<SheetContent>` with a body and no header is a legal thing to write and
   * an unlabelled Radix dialog with no exit -- no Escape on a phone, and no
   * outside at all on the full shape. Task 1's configured `Sheet` made that
   * structurally impossible; composition traded that away, and this is what
   * buys it back.
   */
  it("never opens a sheet without the header that carries its Close", () => {
    const headerless: string[] = [];
    for (const file of walk(SRC)) {
      const source = withoutComments(readFileSync(file, "utf8"));
      const name = file.pathname.split("/src/")[1] ?? file.pathname;
      let at = source.indexOf("<SheetContent");
      while (at !== -1) {
        const end = source.indexOf("</SheetContent>", at);
        if (end === -1 || !source.slice(at, end).includes("<SheetHeader")) headerless.push(name);
        at = source.indexOf("<SheetContent", at + 1);
      }
    }
    expect(headerless).toEqual([]);
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
   * THE CALLER'S WIDTH CAP NOW APPLIES AT A DESK, and until Phase 7 it did
   * not. Tailwind sorts `max-w-*` alphabetically rather than by size, so the
   * `.max-w-md` the shape used to hard-code was emitted AFTER `.max-w-2xl` and
   * `.max-w-3xl` and beat them in the base layer: measured at 1280, a
   * DialogContent carrying `max-w-3xl` computed `max-width: 448px`, and the
   * caps on composer.tsx, settings-mail.tsx, settings-templates.tsx and the
   * quote form were inert at every width. The previous version of this comment
   * recorded that accurately and deferred the fix as a desktop change; Phase 7
   * hit it head-on, because the quote form's six columns overflowed a 448px
   * dialog by 83px and put its Remove button off-screen -- the same failure the
   * phone layout exists to avoid. (83, not 143: `p-6` leaves 400px of content
   * inside a 448px dialog, against a 482px min-content row. 143 was the PHONE
   * figure, measured against the 340px box inside a 390px sheet, and the two
   * cannot be the same number because the containers are not.)
   *
   * THE FIX IS THE ABSENCE OF A CONFLICT, NOT A CASCADE ARGUMENT, which is why
   * the first assertion below is a NEGATIVE one. The shape no longer spells any
   * base `max-w-` at all; DialogContent supplies the default through
   * overridableClass (src/lib.ts) only when the caller has set none, so exactly
   * one class of that family is ever emitted and stylesheet order has nothing
   * left to decide. Restore a hard-coded width to the shape and the first
   * assertion fails.
   *
   * `max-md:max-w-none` is deliberately NOT caught by that check and must not
   * be: it has to keep beating whatever the caller chose, and it does, because
   * every `max-md` rule is emitted after the whole base layer.
   *
   * WHAT THIS GUARD CANNOT SEE, the same caveat nav-lib.test.ts's two source
   * readers carry: it matches a literal `className="..."` on the element. A
   * caller composing its class with clsx(), a template literal, or a variable
   * slips past silently. It no longer requires className to be the FIRST
   * attribute, which it did until a mutation walked straight through it by
   * putting `data-testid` in front -- a likelier and likelier spelling now
   * that DialogContent forwards every Radix prop.
   */
  it("lets callers tune only the properties the phone shape undoes", () => {
    const dialog = here("dialog.tsx");
    const shape = dialog.slice(dialog.indexOf("dialog: clsx("), dialog.indexOf("drawer: clsx("));
    expect(shape).toContain("max-md:max-w-none");
    expect(shape).toContain("max-md:max-h-none");
    expect(shape).toContain("max-md:overflow-y-auto");

    // THE ASSERTION THAT MAKES A CALLER'S WIDTH REAL. Every class the shape
    // spells, with the `max-md:` overrides removed: none of what is left may
    // be a `max-w-`, or it is emitted alongside the caller's and alphabetical
    // order picks the winner. Written over the shape's own classes rather than
    // over the whole file so the default in DialogContent -- which is applied
    // only in the caller's absence -- is not mistaken for a conflict.
    const shapeClasses = [...shape.matchAll(/"([^"]*)"/g)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .filter(Boolean)
      .filter((cls) => !cls.startsWith("max-md:"));
    expect(shapeClasses.filter((cls) => cls.startsWith("max-w-"))).toEqual([]);

    // And the default still reaches a caller that asks for nothing, or every
    // dialog in the app loses its card width.
    expect(dialog).toContain('overridableClass(DIALOG_DEFAULT_MAX_WIDTH, "max-w-", className)');

    // THE DEFAULT'S VALUE, PINNED. Eight of the eleven DialogContent callers pass
    // no width at all and get this one; changing it to `max-w-xs` shrinks every
    // one of them from 448px to 320px, and nothing else in this repo would have
    // noticed. THREE callers DO pass a width -- the composer, the quote form and
    // mail settings. (Recounted at v1.2.2: it was four of twelve until the email
    // templates dialog went with the mail template feature.)
    expect(dialog).toContain('const DIALOG_DEFAULT_MAX_WIDTH = "max-w-md";');

    const tunable = /^(max-w-|max-h-|overflow-|md:)/;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/<DialogContent\b[^>]*className="([^"]*)"/g)) {
        for (const cls of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
          if (!tunable.test(cls)) offenders.push(cls);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE CALLER'S CLASS HAS TO REACH THE ELEMENT, and until this existed nothing
   * checked that it did.
   *
   * Deleting `, className` from DialogContent's clsx call discards every width,
   * height cap and scroll region all four callers pass -- mail settings becomes
   * a full-viewport-width dialog with no maximum height and no scrolling -- and
   * the whole suite stayed green, e2e included. The guard above survives it too,
   * because it reads the callers' source strings, which are still there; what
   * changed was whether anything consumed them.
   *
   * This traces the value instead: DialogContent composes `className` in, and
   * Overlaid puts its own `className` parameter on the Content element. Both
   * halves, because either one alone can be cut.
   */
  it("forwards a caller's className all the way to the rendered element", () => {
    const dialog = here("dialog.tsx");
    const content = component("dialog.tsx", "DialogContent");
    // The caller's class is composed into what is handed down...
    expect(content).toMatch(/className=\{clsx\([\s\S]*?,\s*className\)\}/);
    // ...and Overlaid is what puts a className on the Radix element.
    const overlaid = dialog.slice(dialog.indexOf("function Overlaid("), dialog.indexOf("export function DialogContent"));
    expect(overlaid).toMatch(/RadixDialog\.Content className=\{clsx\(SHAPES\[shape\], className\)\}/);
  });
});

describe("the 44px touch floor", () => {
  /**
   * The phase names icon buttons, tab triggers, list rows and menu items. The
   * elements below are where all four of them are actually built, so this is
   * the one place the floor can be asserted rather than chased around the
   * pages.
   *
   * PER ELEMENT, not per file. select.tsx holds two independent controls, and
   * a file-scoped assertion was green with the floor deleted from one of them.
   *
   * `max-md:` IS THE POINT, and an unscoped floor would be the bug: ui/input's
   * element is the same one as the desktop header's search box, ui/button's is
   * every button in the app, and growing either at a desk is the one thing
   * this phase may not do. Hence both halves of each assertion.
   */
  const FLOORED: [file: string, element: string][] = [
    ["button.tsx", "Button"],
    ["input.tsx", "Input"],
    ["textarea.tsx", "Textarea"],
    ["select.tsx", "SelectTrigger"],
    ["select.tsx", "SelectItem"],
    ["tabs.tsx", "TabsTrigger"],
  ];

  for (const [file, element] of FLOORED) {
    it(`${element} reaches 44px below the breakpoint and nowhere else`, () => {
      const source = component(file, element);
      expect(source).toContain("max-md:min-h-11");
      expect(source).not.toMatch(/(?<!max-md:)\bmin-h-11\b/);
    });
  }

  /**
   * THE REF HAS TO REACH THE ELEMENT, and a guard that only reads the props
   * TYPE cannot see that it does not.
   *
   * `Input` was widened to ComponentPropsWithRef so components/contact-fields
   * could take focus back from a Radix Select that restores it to the trigger.
   * Nothing about that type stops somebody writing
   * `function Input({ className, ref, ...props })` and never forwarding it:
   * that compiles, passes the whole suite, and silently reintroduces the exact
   * data loss this release fixed -- typing a title into a box that never has
   * the caret. So the SHAPE is asserted: className comes out, everything else
   * goes in, and `ref` is never named on the way past.
   */
  it("forwards a ref to the element rather than destructuring it away", () => {
    const source = component("input.tsx", "Input");
    expect(source).toMatch(/function Input\(\{\s*className,\s*\.\.\.props\s*\}/);
    expect(source).toContain("{...props}");
    const params = /function Input\(\{([^}]*)\}/.exec(source)?.[1] ?? "";
    expect(params.split(",").map((name) => name.trim())).toEqual(["className", "...props"]);
  });

  /**
   * The two icon buttons whose whole label is a glyph: they need the floor on
   * BOTH axes, and the height alone leaves a target as narrow as the glyph.
   * The drawer's close was measured at 34.7 x 44 that way -- and below the
   * breakpoint that drawer is full-screen, so it was the only exit from the
   * surface Task 5 opens from a Gantt bar.
   */
  it("floors a glyph-only control on both axes", () => {
    expect(component("button.tsx", "Button")).toContain("max-md:min-w-11");
    expect(component("dialog.tsx", "SheetHeader")).toContain("min-w-11");
  });

  /**
   * The record rail's five tabs have a fixed 349px intrinsic width -- each
   * label is one unbreakable word, so a trigger cannot shrink below its text
   * -- against a 327px content box at 375px. Measured before the fix: at 375px
   * the strip spilled 22px out of its container, and at 360px the whole page
   * scrolled sideways and the Meetings tab left the screen.
   *
   * THE TWO HALVES BELONG TO TWO DIFFERENT ELEMENTS and the assertion says so,
   * because a mutation moved both onto the list and stayed green: the scroll
   * container is the LIST's, the shrink-0 is the TRIGGER's, and shrink-0 on
   * the list would un-floor every trigger while re-opening the flex squeeze
   * the pairing exists to prevent.
   */
  it("lets the tab strip scroll instead of spilling, below the breakpoint only", () => {
    const list = component("tabs.tsx", "TabsList");
    const trigger = component("tabs.tsx", "TabsTrigger");
    expect(list).toContain("max-md:overflow-x-auto");
    expect(list).not.toMatch(/(?<!max-md:)\boverflow-x-auto\b/);
    expect(trigger).toContain("max-md:shrink-0");
    expect(trigger).not.toContain("overflow-x-auto");
  });
});
