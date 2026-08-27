import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { clsx } from "clsx";
import { useUnreadMailCount } from "../queries";
import { useIsMobile } from "../use-is-mobile";
import { BottomNav, MobileSearch } from "./bottom-nav";
import { GlobalSearch } from "./search";
import { useSseInvalidation } from "./sse";

// activeProps.className replaces (rather than merges with) the base className
// on the wire, so each string below is complete on its own -- not a base plus
// an appended "active" fragment.
const navLinkClass =
  "block rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white";
const activeNavLinkClass = "block rounded-md px-3 py-2 text-sm font-medium bg-slate-800 text-white";
// The Inbox entry carries a trailing unread badge, so its box is a flex row
// rather than the plain block every other entry uses. Same two complete
// strings for the same reason -- activeProps replaces, it does not merge.
const navMailLinkClass =
  "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white";
const activeNavMailLinkClass =
  "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium bg-slate-800 text-white";

export function Shell({ children }: { children: ReactNode }) {
  // Mounted once here (Shell wraps every route, see router.tsx's
  // RootComponent), not per-page: one EventSource per browser tab, live for
  // as long as the app is open, not re-opened on every navigation.
  useSseInvalidation();

  // Threads (not messages) holding something unseen. ["mail-unread"] is
  // published by ingest AND by every thread mutation, so this follows both a
  // new arrival and a mark-read through the same SSE invalidation every other
  // key here uses -- nothing polls. Undefined while the first fetch is in
  // flight, which reads the same as zero: no badge until there is a number.
  const { data: unreadMail = 0 } = useUnreadMailCount();

  // The first of the phase's three sanctioned useIsMobile() sites, and the
  // clearest: below the breakpoint the navigation is not the sidebar re-laid
  // out, it is a different control -- a five-slot bar with a sheet behind it.
  //
  // A JS branch rather than `md:` visibility classes, and the two halves are
  // therefore MUTUALLY EXCLUSIVE IN THE DOM rather than one of them merely
  // hidden. That is what keeps `unread-badge` and `search-input` single
  // elements on the page: the mail journeys address the badge by testid and
  // would hit a strict-mode violation against two copies of it.
  //
  // Above the breakpoint every branch below resolves to exactly what this file
  // rendered before this phase, down to the class strings -- the phase must
  // not alter the desktop shell, and `false && ...` renders no node at all.
  const isMobile = useIsMobile();

  // The Settings entry links at one of its two tabs but must stay highlighted
  // on both, and activeProps only knows about the link's own target -- so its
  // active state is computed from the path instead.
  //
  // The literal "/settings" is correct at every install path, root or subpath:
  // a configured basepath installs router-core's own basepath rewrite, whose
  // input leg slices the base off before the location is ever stored, so
  // `location.pathname` is always basepath-RELATIVE ("/settings/mail", never
  // "/conduit/settings/mail"). Every other nav item's `to`/activeProps above
  // relies on exactly the same fact -- they are written basepath-relative too.
  const inSettings = useRouterState({ select: (state) => state.location.pathname.startsWith("/settings") });

  return (
    <div data-testid="shell" className="flex min-h-screen bg-slate-50">
      {/*
        THE SIDEBAR GETS ITS OWN SCROLL ON A SHORT VIEWPORT, and only there.

        A large phone in LANDSCAPE is 844px wide, above the 48rem breakpoint,
        so it keeps this sidebar by design -- but it is only ~345-350px tall,
        and the sidebar's content is 384px. As a stretched item of a
        `flex min-h-screen` row, its content set the row's height, so the
        DOCUMENT scrolled vertically on the one axis a landscape phone has none
        of, and <main>'s own scroll region had its bottom pushed off-screen.

        `overflow-y-auto` alone does NOT fix that, which is worth writing down
        because it is the obvious remedy and it was measured failing: an
        overflow container still reports its content height as its hypothetical
        cross size, so the row stayed 384px tall and the document still grew.
        The height cap is what does the work; the scroll is what keeps the
        eighth link reachable once capped; `sticky top-0` keeps the sidebar in
        place while <main> scrolls past it, which is what it did before when
        the document did not scroll at all.

        `max-lg:` rather than `max-md:` because the failure is a SHORT viewport
        and every viewport between the two breakpoints is one that a phone in
        landscape can be. Above 64rem nothing here applies, so the desktop
        shell -- including e2e/tasks.spec.ts's hard-coded 224px arithmetic --
        is untouched.

        The cap is in the same unit as the root's own `min-h-screen` on
        purpose. A dynamic-viewport cap would be the shorter of the two on iOS
        while the toolbars are showing, and the root would still hold the page
        open to the taller one -- leaving a strip of page background below a
        sidebar that is supposed to reach the bottom.

        What this does NOT change: the rows inside are 36px, under the 44px
        floor, on a landscape phone that is a touch device. They are left
        alone deliberately. This is the desktop sidebar, the floor is scoped
        to below the breakpoint everywhere else in the sweep, and raising
        these would also raise them for a 1000px-wide laptop window.
      */}
      {!isMobile && (
        <aside className="flex w-56 shrink-0 flex-col bg-slate-900 text-white max-lg:sticky max-lg:top-0 max-lg:h-screen max-lg:overflow-y-auto">
          <div className="px-4 py-5 text-lg font-semibold tracking-tight">Conduit</div>
          <nav className="flex flex-col gap-1 px-2">
            <Link to="/mail" className={navMailLinkClass} activeProps={{ className: activeNavMailLinkClass }}>
              Inbox
              {unreadMail > 0 && (
                <span
                  data-testid="unread-badge"
                  className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-900"
                >
                  {unreadMail}
                </span>
              )}
            </Link>
            <Link to="/companies" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              Companies
            </Link>
            <Link to="/contacts" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              Contacts
            </Link>
            <Link to="/pipelines" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              Pipelines
            </Link>
            <Link to="/projects" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              Projects
            </Link>
            <Link to="/my-tasks" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              My Tasks
            </Link>
            <Link to="/gantt" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
              Gantt
            </Link>
            <Link to="/settings/mail" className={inSettings ? activeNavLinkClass : navLinkClass}>
              Settings
            </Link>
          </nav>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3">
          {isMobile ? (
            <>
              <span className="flex-1 text-lg font-semibold tracking-tight text-slate-900">Conduit</span>
              <MobileSearch />
            </>
          ) : (
            <div className="max-w-md flex-1">
              <GlobalSearch />
            </div>
          )}
        </header>
        {/*
          The bottom bar is `fixed`, so it overlays the end of a scrolled page;
          the extra bottom padding below the breakpoint is what keeps the last
          row of a list out from under it.

          THE env() TERM IS 0px IN THIS APP AND STAYS THAT WAY. The reservation
          is really the flat 6rem, which clears the bar on its own.

          The reason is index.html's viewport meta, which has no
          `viewport-fit=cover`: without it the layout viewport already stops
          short of the notch and the home indicator, the browser reserves those
          strips itself, and every safe-area inset resolves to zero by
          definition. Task 2 weighed adding it and deliberately did not. It is
          not a one-line improvement -- it moves the layout viewport out under
          the hardware on ALL FOUR edges, so every full-bleed and fixed surface
          then needs its own inset: this header and <main> (px-6), the bar and
          the sheets (pinned to the edges), the task drawer's right edge, and
          -- in LANDSCAPE, which is above the breakpoint and therefore still
          renders the sidebar above -- that sidebar's left edge against the
          notch. That is a landscape audit on hardware this loop cannot test,
          bought for no visible gain, since the space is already reserved.

          So the term is inert and correct, and becomes the right padding on
          the day somebody does that audit. Whoever does it should know that
          this comment, the one in components/bottom-nav.tsx, and the
          assertion in use-is-mobile.test.ts that pins the meta all stop being
          true in the same commit.
        */}
        <main
          className={clsx(
            "flex-1 overflow-auto px-6 py-6",
            isMobile && "pb-[calc(6rem_+_env(safe-area-inset-bottom))]",
          )}
        >
          {children}
        </main>
        {isMobile && <BottomNav unreadMail={unreadMail} />}
      </div>
    </div>
  );
}
