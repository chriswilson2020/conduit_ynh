import { useState } from "react";
import type { ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Link, useRouterState } from "@tanstack/react-router";
import { clsx } from "clsx";
import { NAV_DESTINATIONS, isAnyNavDestinationActive, isNavDestinationActive, splitNav } from "./nav-lib";
import { GlobalSearch } from "./search";

/**
 * The shell's chrome BELOW the breakpoint: the bottom tab bar, the More sheet
 * behind it, and the header's search sheet. All three live in one file because
 * all three are the same object -- a sheet -- and this phase may not touch
 * components/ui, whose dialog primitives the next task converts to sheets
 * wholesale. When it does, Sheet below is what it should promote and this file
 * should import.
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

// Complete strings again, for the same reason: which edges a sheet is pinned
// to is not a property one composes half of.
const SHEET_SHAPE = {
  // Pinned to the bottom edge and capped, so the page behind stays partly
  // visible -- right for a short list of choices.
  bottom: "fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl",
  // Edge to edge, for a surface that needs the screen: global search opens its
  // own result list underneath the input, and a capped sheet would scroll it.
  full: "fixed inset-0",
} as const;

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
 * A modal sheet with a titled header and an explicit Close.
 *
 * The Close is not decoration. Radix dismisses on Escape and on an outside
 * click, and a phone offers neither a keyboard nor -- for the full-screen
 * shape -- an outside; without a button in the header, opening search would be
 * the one dead end this phase's definition of done forbids.
 *
 * aria-describedby is cleared explicitly because these sheets carry no
 * description element, and Radix otherwise points at an id that is not there.
 */
function Sheet({
  open,
  onOpenChange,
  testId,
  title,
  shape,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  title: string;
  shape: keyof typeof SHEET_SHAPE;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-slate-900/40" />
        <RadixDialog.Content
          data-testid={testId}
          aria-describedby={undefined}
          className={clsx(
            "flex flex-col overflow-hidden bg-white pb-[env(safe-area-inset-bottom)] shadow-xl focus:outline-none",
            SHEET_SHAPE[shape],
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <RadixDialog.Title className="text-base font-semibold text-slate-900">{title}</RadixDialog.Title>
            <RadixDialog.Close
              data-testid={`${testId}-close`}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Close
            </RadixDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * The bottom tab bar: four primary destinations plus More.
 *
 * `fixed` with NO z-index, deliberately. Paint order then follows the DOM, and
 * every overlay in this app (dialogs, the task drawer, the sheets above) is
 * portalled to the end of <body> with no z-index of its own -- so they land
 * above the bar for free, while a z-index here would float the bar over an
 * open drawer. shell.tsx pays for the fixed positioning with bottom padding on
 * <main> so the last row of a list is not parked under the bar.
 */
export function BottomNav({ unreadMail }: { unreadMail: number }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { primary, overflow } = splitNav(NAV_DESTINATIONS);

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      {primary.map((destination) => (
        <Link
          key={destination.id}
          to={destination.to}
          data-testid={`nav-${destination.id}`}
          className={isNavDestinationActive(pathname, destination) ? activeTabClass : tabClass}
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
      ))}
      <Sheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        testId="more-sheet"
        title="More"
        shape="bottom"
        trigger={
          <RadixDialog.Trigger
            data-testid="bottom-nav-more"
            className={isAnyNavDestinationActive(pathname, overflow) ? activeTabClass : tabClass}
          >
            More
          </RadixDialog.Trigger>
        }
      >
        <div className="flex flex-col gap-1">
          {overflow.map((destination) => (
            <Link
              key={destination.id}
              to={destination.to}
              data-testid={`nav-${destination.id}`}
              onClick={() => setMoreOpen(false)}
              className={isNavDestinationActive(pathname, destination) ? activeSheetRowClass : sheetRowClass}
            >
              {destination.label}
            </Link>
          ))}
        </div>
      </Sheet>
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
 */
export function MobileSearch() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      testId="search-sheet"
      title="Search"
      shape="full"
      trigger={
        <RadixDialog.Trigger
          data-testid="open-search"
          aria-label="Search"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
        >
          <SearchIcon />
        </RadixDialog.Trigger>
      }
    >
      <GlobalSearch />
    </Sheet>
  );
}
