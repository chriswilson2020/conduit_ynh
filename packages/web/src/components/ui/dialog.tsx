import type { ComponentPropsWithoutRef, ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

type ContentProps = ComponentPropsWithoutRef<typeof RadixDialog.Content>;

/** Which edges a sheet is pinned to. See SHAPES for what each one means. */
type SheetShape = "bottom" | "full";

/**
 * What a sheet is made of once you take away WHERE it is pinned: a column that
 * scrolls its body rather than the page, on white, over the home-indicator
 * inset. The two sheet entries in SHAPES differed by exactly one line before this
 * was named, and the "complete class string" rule below is about the PIN --
 * which edges a surface is fixed to -- not about retyping its chrome.
 */
const SHEET_CHROME =
  "flex flex-col overflow-hidden bg-white pb-[env(safe-area-inset-bottom)] shadow-xl focus:outline-none";

/**
 * WHERE A MODAL SURFACE IS PINNED -- the only thing that separates the four of
 * them. Everything else (the portal, the scrim, the focus trap, Escape and
 * outside-click dismissal) is one skeleton, written once in Overlaid below.
 *
 * Before this phase the skeleton was written out three times: DialogContent,
 * DrawerContent, and the phone sheet that Task 1 had to keep in
 * components/bottom-nav.tsx because this directory was not its to touch. The
 * phase's ruling was to fold that sheet in here rather than add a fourth copy
 * as components/ui/sheet.tsx, and folding it is what made the shared skeleton
 * worth extracting at all.
 *
 * Each entry is a COMPLETE class string rather than a base plus a fragment,
 * the same convention shell.tsx and bottom-nav.tsx state for their own link
 * classes: where a surface is pinned is not a property you compose half of,
 * and a reader should be able to see one shape's whole geometry on one screen.
 *
 * THE `max-md:` RUNS ARE THE PHONE FORM, and they are written as overrides on
 * top of the desktop string rather than the other way round (a mobile-first
 * base with `md:` restoring the desk) for one reason: this phase must not
 * change the desktop, and leaving the desktop string LITERALLY the one that
 * shipped is a stronger guarantee than re-deriving it from a phone base and
 * hoping every property came back.
 *
 * The overrides are written property-for-property -- `max-md:left-0` against
 * `left-1/2`, never a blanket `max-md:inset-0`. BE CLEAR ABOUT WHY, because
 * the obvious reason is wrong and was believed here for a round: Tailwind does
 * order the inset shorthand before the longhands, but only WITHIN the base
 * utility layer. Every `max-md` rule is emitted after that layer ends, in a
 * single media block of its own, so a blanket `max-md:inset-0` would in fact
 * have beaten `left-1/2`. The property-for-property form is kept because it is
 * the one that does not depend on knowing that -- it stays correct if the
 * shape gains a `md:` sibling, if a caller passes its own variant class, or if
 * a future Tailwind emits variants differently. It is defensive, not required.
 */
const SHAPES = {
  /**
   * A centred card at a desk. On a phone it becomes a full-screen sheet: a
   * dialog that stays centred in the LAYOUT viewport is the one thing that
   * cannot work there, because the on-screen keyboard shrinks the VISUAL
   * viewport under it and takes the fields with it.
   */
  dialog: clsx(
    "fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
    "rounded-lg bg-white p-6 shadow-lg focus:outline-none",
    "max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-0 max-md:max-h-none max-md:max-w-none",
    "max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-none",
  ),
  /**
   * The task drawer: pinned to the right edge, full viewport height, sliding
   * in from off-screen rather than scaling up from the page centre. Radix's
   * Content only mounts while `open` is true (no `forceMount`), so this only
   * animates the OPEN transition -- a closing drawer simply unmounts, an
   * acceptable simplification over a full enter/exit Presence setup.
   *
   * Below the breakpoint it is ALREADY a full-height sheet -- `w-full` beats
   * `max-w-md` at any phone width -- so the one override drops the cap for
   * the wider end of the phone range, where 28rem would otherwise leave the
   * page showing beside it.
   */
  drawer: clsx(
    "fixed inset-y-0 right-0 flex h-full w-full max-w-md flex-col overflow-y-auto",
    "bg-white shadow-xl focus:outline-none",
    "translate-x-full transition-transform duration-200 ease-out data-[state=open]:translate-x-0",
    "max-md:max-w-none",
  ),
  /**
   * Pinned to the bottom edge and capped, so the page behind stays partly
   * visible -- right for a short list of choices.
   */
  sheetBottom: clsx("fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl", SHEET_CHROME),
  /**
   * Edge to edge, for a surface that needs the screen: global search opens its
   * own result list underneath the input, and a capped sheet would scroll it.
   */
  sheetFull: clsx("fixed inset-0", SHEET_CHROME),
} as const;

/**
 * The skeleton every modal surface in this app is made of: Portal > Overlay >
 * Content, with the shape deciding where Content lands.
 *
 * Not exported. Callers pick a named variant below, so "which shapes exist" is
 * a closed set a reader can enumerate rather than a free-form class string.
 */
function Overlaid({
  shape,
  className,
  children,
  ...rest
}: { shape: keyof typeof SHAPES } & ContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-slate-900/40" />
      <RadixDialog.Content className={clsx(SHAPES[shape], className)} {...rest}>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * A DIALOG THAT FILLS A PHONE MUST CARRY ITS OWN WAY OUT, and this is where
 * that gets paid for once instead of at eleven call sites.
 *
 * On a desk a dialog needs no close button: Escape dismisses it, and so does a
 * click on the page around the card. Turn the same dialog into a full-screen
 * sheet and BOTH of those disappear -- a phone has no Escape key, and a
 * surface pinned to all four edges has no outside to click. Eight of this
 * app's DialogContent callers have no Cancel button of their own -- the create
 * dialogs on companies, contacts, projects, pipelines, the task board, the
 * board's New deal, the company page's two, and the project page's -- and
 * every one of them would have become exactly the dead end the phase's
 * definition of done forbids.
 *
 * The control is `md:hidden`, so at a desk it is display:none -- out of the
 * accessibility tree, no pixel changed, and the dialogs that DO have a Cancel
 * are not given a second one there. It sits in the flow above the caller's
 * children rather than absolutely over them, because a caller's first child is
 * usually its title and an overlay would sooner or later land on top of one.
 *
 * A HAZARD THIS CREATES FOR THE NEXT DIALOG, since it is invisible until it
 * bites: below the breakpoint this Close is the FIRST TABBABLE CHILD of every
 * dialog, and Radix's default opening focus is the first tabbable descendant.
 * That is exactly the bug Task 1 had to fix for the search sheet -- a surface
 * whose whole purpose is typing, announcing "Close, button" on open. It does
 * not bite today only because every no-Cancel caller marks its first input
 * `autoFocus`, and Radix's FocusScope skips its own autofocus once focus is
 * already inside the content. A new dialog added WITHOUT an autoFocus'd field
 * will open focused here. Give it one, or pass `onOpenAutoFocus` (the whole of
 * Radix's Content props are forwarded) and focus what the dialog is for.
 */
export function DialogContent({ children, ...rest }: ContentProps) {
  return (
    <Overlaid shape="dialog" {...rest}>
      <div className="mb-2 flex justify-end md:hidden">
        <RadixDialog.Close
          data-testid="dialog-close"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Close
        </RadixDialog.Close>
      </div>
      {children}
    </Overlaid>
  );
}

export function DrawerContent(props: ContentProps) {
  return <Overlaid shape="drawer" {...props} />;
}

/**
 * A sheet: the phone's modal surface, and the only one the phone chrome uses.
 *
 * COMPOSED, NOT CONFIGURED. The sheet Task 1 built took `title` and `trigger`
 * and assembled its own header, which is a different language from the one the
 * rest of this directory speaks -- Dialog/DialogTrigger/DialogContent/
 * DialogTitle and Tabs/TabsList/TabsTrigger all hand the caller the pieces and
 * let them be put together. The ruling was to settle on one language rather
 * than ship both, and this is the one `ui/` already spoke, so the sheet lost
 * its props and gained SheetHeader and SheetBody beside it.
 *
 * THE CONTRACT FOR ANYTHING PUT INSIDE ONE: if it can navigate, it must close
 * the sheet itself. Radix dismisses on Escape and on an outside click; a phone
 * offers no keyboard, and the full shape has no outside. A sheet left standing
 * after a navigation covers the page the user asked for with a surface that
 * looks like nothing happened. nav-lib.test.ts guards the one caller where the
 * closing has to travel out through a prop to get there.
 *
 * `aria-describedby` is cleared because these sheets carry no description
 * element and Radix otherwise points at an id that is not there. It is set
 * before the spread so a caller that does have one still wins.
 */
/**
 * A Record rather than a ternary, so a third sheet shape is a TYPE ERROR here
 * rather than a silent fallback to the bottom sheet. Adding one means editing
 * the union, the SHAPES table and this map, and the compiler now insists on
 * the third.
 */
const SHEET_SHAPES: Record<SheetShape, "sheetBottom" | "sheetFull"> = {
  bottom: "sheetBottom",
  full: "sheetFull",
};

export function SheetContent({ shape, ...rest }: { shape: SheetShape } & ContentProps) {
  return <Overlaid shape={SHEET_SHAPES[shape]} aria-describedby={undefined} {...rest} />;
}

/**
 * A sheet's title bar, with the Close that makes the sheet dismissible at all.
 *
 * The Close is not decoration and this is not the place to leave it out: on a
 * phone there is no Escape key, and the full shape has no outside to click.
 * Without a button here, opening a sheet would be the one dead end the phase's
 * definition of done forbids.
 */
export function SheetHeader({
  title,
  closeTestId,
  leading,
}: {
  title: string;
  /**
   * Required, not optional. A Close that no test can address is a Close
   * nobody proves still works, and on a full-shape sheet it is the only exit
   * there is.
   */
  closeTestId: string;
  /**
   * Anything that belongs before the title -- a Back control, most obviously.
   * Task 3's drill-in stack needs one at every level, and without a slot here
   * it would have to hand-roll the whole header and then remember the Title
   * and the Close on its own.
   */
  leading?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
      {leading}
      <RadixDialog.Title className="flex-1 text-base font-semibold text-slate-900">{title}</RadixDialog.Title>
      <RadixDialog.Close
        data-testid={closeTestId}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
      >
        Close
      </RadixDialog.Close>
    </div>
  );
}

/** A sheet's scrolling region, under the header. */
export function SheetBody({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto p-4">{children}</div>;
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <RadixDialog.Title className="text-lg font-semibold text-slate-900">{children}</RadixDialog.Title>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <RadixDialog.Description className="mt-1 text-sm text-slate-500">{children}</RadixDialog.Description>;
}
