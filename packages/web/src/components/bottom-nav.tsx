import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Dialog, DialogTrigger, SheetBody, SheetContent, SheetHeader } from "./ui/dialog";
import { NAV_DESTINATIONS, isAnyNavDestinationActive, isNavDestinationActive, splitNav } from "./nav-lib";
import { GlobalSearch } from "./search";

/**
 * The shell's chrome BELOW the breakpoint: the bottom tab bar, the More sheet
 * behind it, and the header's search sheet.
 *
 * The sheet itself no longer lives here. Task 1 had to keep it local because
 * components/ui was Task 2's directory; Task 2 folded it into ui/dialog.tsx
 * beside the dialog and the drawer, which is where the shared Portal >
 * Overlay > Content skeleton now lives, and this file composes it like any
 * other caller.
 *
 * Nothing here renders above the breakpoint: shell.tsx picks between this and
 * the sidebar with useIsMobile(), so the two never coexist in the DOM. That is
 * not a detail -- it is what lets the unread badge keep the single
 * `unread-badge` testid the mail journeys already address it by.
 */

// Two complete class strings rather than a base plus an "active" fragment,
// matching shell.tsx's sidebar convention. Here it is a plain ternary rather
// than TanStack's activeProps (which REPLACES className on the wire): the bar
// computes its own active state from the path so that More can light up for a
// destination inside its sheet, and mixing the two mechanisms in one bar would
// leave five tabs highlighting by two different rules.
//
// min-h-11 is 44px, the platform minimum touch target. flex-1 divides the bar
// evenly, which at five tabs is ~75px each on the narrowest phone -- wider
// than the minimum, so the height is the binding constraint and it is met.
const tabClass =
  "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-medium text-slate-500";
const activeTabClass =
  "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs font-medium text-slate-900";

// Rows in a sheet: the same 44px floor, full width, and a resting state that
// is visible on a white sheet without being a button-looking box.
const sheetRowClass =
  "flex min-h-11 items-center rounded-md px-3 py-2 text-base font-medium text-slate-700 hover:bg-slate-100";
const activeSheetRowClass =
  "flex min-h-11 items-center rounded-md px-3 py-2 text-base font-medium bg-slate-100 text-slate-900";

/**
 * The accessible half of "you are here", spread onto a tab or a row.
 *
 * The bar computes its own active state from nav-lib rather than leaning on
 * TanStack's, so the accessible marker has to come from the same rule as the
 * colour -- otherwise the two states this navigation has are conveyed to a
 * screen reader by nothing at all. The measured gap was exactly where the two
 * rules disagree: Settings matches on `/settings` while it LINKS to
 * `/settings/mail`, so on the Templates tab TanStack sets nothing.
 *
 * Returned as a spread-or-nothing rather than as `aria-current={x ?? undefined}`
 * deliberately. Link merges its own computed props with the caller's, and an
 * explicit `undefined` from the caller can win -- which would STRIP the marker
 * from the tabs TanStack gets right today. Passing the attribute only when it
 * is true can only ever add.
 */
function currentProps(active: boolean, value: "page" | "true"): { "aria-current"?: "page" | "true" } {
  return active ? { "aria-current": value } : {};
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2 L17 17" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The bottom tab bar: four primary destinations plus More.
 *
 * `fixed` with NO z-index, deliberately. Paint order then follows the DOM, and
 * every overlay in this app (dialogs, the task drawer, the sheets in
 * ui/dialog.tsx) is portalled to the end of <body> with no z-index of its own
 * -- so they land above the bar for free, while a z-index here would float the
 * bar over an open drawer. The one exception found so far is the Gantt, whose
 * sticky chart/timescale elements carry a z-index and are NOT portalled; that
 * is recorded against Task 5, which owns those files. shell.tsx pays for the
 * fixed positioning with bottom padding on <main> so the last row of a list is
 * not parked under the bar.
 *
 * The bar's own safe-area padding resolves to 0px in this app today, because
 * index.html's viewport meta has no `viewport-fit=cover` and the layout
 * viewport therefore already stops short of the home indicator. Task 2 looked
 * at adding it and deliberately did not -- index.html records why -- so the
 * term stays inert and correct, and becomes the right padding on the day
 * somebody does the full inset audit that meta demands. It is named in prose
 * WITHOUT its bracket syntax on purpose, here and in shell.tsx: Tailwind v4
 * scans this
 * file as plain text and emits ANY bracketed class it finds -- a comment is
 * not a comment to it -- so an abbreviated one compiles to CSS that
 * lightningcss rejects, and every later build carries a warning that reads
 * like a real bug. Spell such a class out in full or leave the brackets off.
 */
export function BottomNav({ unreadMail }: { unreadMail: number }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { primary, overflow } = splitNav(NAV_DESTINATIONS);
  const inOverflow = isAnyNavDestinationActive(pathname, overflow);

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      {primary.map((destination) => {
        const active = isNavDestinationActive(pathname, destination);
        return (
          <Link
            key={destination.id}
            to={destination.to}
            data-testid={`nav-${destination.id}`}
            {...currentProps(active, "page")}
            className={active ? activeTabClass : tabClass}
          >
            <span className="flex items-center gap-1">
              {destination.label}
              {destination.id === "mail" && unreadMail > 0 && (
                <span
                  data-testid="unread-badge"
                  className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                >
                  {unreadMail}
                </span>
              )}
            </span>
          </Link>
        );
      })}
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogTrigger
          data-testid="bottom-nav-more"
          {...currentProps(inOverflow, "true")}
          className={inOverflow ? activeTabClass : tabClass}
        >
          More
        </DialogTrigger>
        <SheetContent shape="bottom" data-testid="more-sheet">
          <SheetHeader title="More" closeTestId="more-sheet-close" />
          <SheetBody>
            <div className="flex flex-col gap-1">
              {overflow.map((destination) => {
                const active = isNavDestinationActive(pathname, destination);
                return (
                  <Link
                    key={destination.id}
                    to={destination.to}
                    data-testid={`nav-${destination.id}`}
                    {...currentProps(active, "page")}
                    onClick={() => setMoreOpen(false)}
                    className={active ? activeSheetRowClass : sheetRowClass}
                  >
                    {destination.label}
                  </Link>
                );
              })}
            </div>
          </SheetBody>
        </SheetContent>
      </Dialog>
    </nav>
  );
}

/**
 * The header's search, below the breakpoint: an icon that opens the same
 * GlobalSearch the desktop header shows inline.
 *
 * GlobalSearch mounts only while the sheet is open, which is what keeps
 * `search-input` a single element on the page -- the desktop header's copy and
 * this one are never both rendered, since shell.tsx picks one branch or the
 * other.
 *
 * onNavigate is what takes the sheet down when a result is chosen. Choosing a
 * result is the whole point of opening this, so it is the ONE interaction that
 * must not leave the sheet standing -- and it is invisible to Radix, which
 * only knows about Escape and clicks outside a surface that here has no
 * outside.
 */
export function MobileSearch() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="open-search"
        aria-label="Search"
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
      >
        <SearchIcon />
      </DialogTrigger>
      <SheetContent
        shape="full"
        data-testid="search-sheet"
        onOpenAutoFocus={(event) => {
          // Radix would focus the first tabbable descendant, which is Close --
          // it sits in the header, and the header precedes the content. On a
          // full-screen search surface with no keyboard that is the worst
          // possible landing: a screen reader announces "Close, button" for a
          // sheet whose entire purpose is typing, and a phone user gets no
          // keyboard until they find and tap the field themselves.
          //
          // The input is found by tag rather than through a ref because the
          // alternative is threading one through GlobalSearch and ui/input.tsx,
          // and that primitive types its props as InputHTMLAttributes with no
          // ref among them. This sheet holds exactly one input, and the
          // header's title makes which one unambiguous.
          const content = event.currentTarget;
          if (!(content instanceof HTMLElement)) return;
          const input = content.querySelector("input");
          if (input === null) return;
          event.preventDefault();
          input.focus();
        }}
      >
        <SheetHeader title="Search" closeTestId="search-sheet-close" />
        <SheetBody>
          <GlobalSearch onNavigate={() => setOpen(false)} />
        </SheetBody>
      </SheetContent>
    </Dialog>
  );
}
