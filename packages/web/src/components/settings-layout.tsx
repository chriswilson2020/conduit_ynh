import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// activeProps.className REPLACES the base className (see shell.tsx's own note
// on the same Link behaviour), so each of these is a complete class list, not
// a base plus an "active" fragment.
// These are tab triggers in everything but their implementation, so they take
// the same 44px floor below the breakpoint that ui/tabs.tsx gives the real
// ones. The min-height bites because these Links are children of a flex row
// and so are already blockified -- and the flex is here for the OTHER half:
// an anchor does not centre its own text in a box taller than its line, the
// way a <button> does.
// `shrink-0 whitespace-nowrap` ARRIVED WITH 7.6'S FOURTH TAB, and it is what
// makes this row a scroller rather than a squeezer. These are flex children, so
// until now they SHRANK: with three tabs there was room and nothing showed, and
// with four there is not -- measured at a phone width, each tab compressed to
// 72.7px for a label that measures 148 uncompressed, so the text was squeezed
// rather than the row scrolled. A compressed tab is also a smaller touch target
// and a less predictable one, which is how this surfaced at all: the last tab
// measured 0.9946 of itself inside the viewport where every other control in
// the phone journey measures exactly 1.
// Both classes are already in the stylesheet, so this adds no rule to it.
const tabClass =
  "shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-900 max-md:inline-flex max-md:min-h-11 max-md:items-center";
const activeTabClass =
  "shrink-0 whitespace-nowrap border-b-2 border-slate-900 px-3 py-2 text-sm font-medium text-slate-900 max-md:inline-flex max-md:min-h-11 max-md:items-center";

/**
 * The Settings area's frame: a title and the tab nav every settings page
 * renders inside. Deliberately plain -- router Links styled as tabs rather
 * than Radix Tabs (components/ui/tabs.tsx), because these tabs ARE routes:
 * each has its own URL, back/forward works, and a bookmark lands on the right
 * one. A Tabs component would own that selection state locally and fight the
 * router for it.
 */
export function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
      {/*
        THE TRAILING PADDING IS WHAT MAKES THE LAST TAB REACHABLE, and it arrived
        with 7.6's fourth tab: three tabs do not overflow this row at a phone
        width and four do.
        WHAT BREAKS WITHOUT IT, measured in CI at the moment it broke and then
        reproduced against a real Chromium at iPhone 13's viewport. Scrolled to
        the end, the last tab lands flush against this container's right edge --
        and that edge is itself a fraction of a pixel OUTSIDE the viewport,
        because the phone layout overflows the page by under a pixel and the
        journey's own page-overflow assertion tolerates up to 1px. So the tab is
        fully scrolled into view and still not fully IN VIEW: it answered a
        viewport ratio of 0.9946 in CI where every other touch target in that
        suite answers exactly 1, and scrollIntoViewIfNeeded has nothing left to
        scroll.
        Four pixels of trailing padding gives the scroller four more pixels of
        range, and the browser uses them: modelled with the same 0.74px page
        overflow, the last tab measured 0.9888 without this class and exactly
        1.000000 with it. Trailing padding was the only thing that moved it --
        scroll-padding did not, and neither did anything the browser could do on
        its own.
        `pr-1` is already in the stylesheet, so this adds no rule to it.

        `scroll-pr-1` ARRIVED IN 7.7'S ROUTES TASK, AND IT IS THE DIRECTIVE THAT
        ACTUALLY MOVES THIS ONE -- which means the sentence above about
        scroll-padding is no longer true and is corrected here rather than left
        standing. The label grew again when the two importers landed on the page
        behind it ("Export, backup and restore" -> "Export, import, backup and
        restore"), and e2e/documents.spec.ts's `toBeInViewport({ ratio: 1 })`
        went red at a ratio of 0.9998771548271179: about three HUNDREDTHS of a
        pixel of the tab clipped by the nav's own right edge.

        MEASURED, at 390px with this label, by driving the real page and reading
        an IntersectionObserver: padding-right at 0px, 4px, 8px and 16px all
        produce the IDENTICAL 0.99988 and the identical scrollLeft of 240,
        against a maximum of 248. scroll-padding-right at 1px or 4px produces
        exactly 1. So trailing padding is not what is short here and never could
        be: the browser scrolls the minimum it thinks is needed, that minimum is
        240.03125, and it lands on 240. Padding changes how far the row COULD
        scroll and not how far this call DOES. scroll-padding is the property
        that changes the target, which is why it is the one that works.

        `pr-1` IS KEPT RATHER THAN REPLACED, deliberately. The 0.9888 the
        paragraph above records was measured against a shorter label that no
        longer exists, so this task cannot reproduce the case that class was
        added for -- and removing a control on the strength of a measurement of
        a different string is how a fix becomes a regression two phases later.
      */}
      <nav data-testid="settings-nav" className="flex gap-1 overflow-x-auto scroll-pr-1 border-b border-slate-200 pr-1">
        <Link to="/settings/mail" className={tabClass} activeProps={{ className: activeTabClass }}>
          Mail accounts
        </Link>
        <Link to="/settings/templates" className={tabClass} activeProps={{ className: activeTabClass }}>
          Templates
        </Link>
        <Link to="/settings/org" className={tabClass} activeProps={{ className: activeTabClass }}>
          Organisation
        </Link>
        {/*
          RENAMED IN 7.7, TWICE, AND IT IS A PROSE SWEEP RATHER THAN A
          PREFERENCE. The tab said "Export and backup" while the page behind it
          gained a third thing that is neither -- and the one 7.7's spec says a
          person must not reach for by mistake. The routes task then put two
          IMPORTERS on the same page, and the same rule applies again in the
          same direction: a label that did not mention them would send somebody
          looking for "put a spreadsheet in" to a tab that names only the way
          out and the way back. A label that did not mention a thing on the page
          would be the navigation quietly disagreeing with it.
          IT IS THE LONGEST LABEL IN THIS ROW AND THAT IS PAID FOR RATHER THAN
          ignored: the row already overflows at a phone width, so e2e/data.spec.ts
          holds this tab to the 44px touch floor and to being WHOLLY in the
          viewport once scrolled to, and e2e/documents.spec.ts holds every tab
          to the same. Making it longer moves it further off the end of the row,
          not off the assertions.
        */}
        <Link to="/settings/data" className={tabClass} activeProps={{ className: activeTabClass }}>
          Export, import, backup and restore
        </Link>
      </nav>
      {children}
    </div>
  );
}
