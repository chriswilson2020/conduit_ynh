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
        its own. THAT LAST CLAUSE IS TRUE OF THE LABEL OF THE DAY AND FALSE OF
        THIS ONE: see the correction below, which sweeps both properties
        together and finds a conjunction rather than a substitution.
        `pr-1` is already in the stylesheet, so this adds no rule to it.

        `scroll-pr-1` ARRIVED IN 7.7'S ROUTES TASK, AND THE TWO CLASSES ARE A
        CONJUNCTION RATHER THAN A SUBSTITUTION. The label grew again when the
        two importers landed on the page behind it ("Export, backup and restore"
        -> "Export, import, backup and restore"), and
        e2e/documents.spec.ts's `toBeInViewport({ ratio: 1 })` went red at a
        ratio of about 0.9998: a few hundredths of a pixel of the tab clipped by
        this container's own right edge.

        MEASURED IN CHROMIUM AT 390px, against this stylesheet and this label,
        by sweeping BOTH properties rather than one at a time -- which is the
        mistake the first version of this paragraph made and the reason it drew
        the wrong conclusion:

          padding-right 0/1/4/8/16  +  scroll-padding-right 0  ->  ratio 0.99985
          padding-right 0           +  scroll-padding-right 1/4/16 -> 0.99985
          padding-right >= 1        +  scroll-padding-right >= 1  ->  1

        NEITHER ALONE MOVES IT. The mechanism is why: the browser scrolls the
        minimum it thinks is needed and lands a fraction of a pixel short, and
        `scroll-padding` is what moves that target -- but it cannot scroll past
        a `maxScroll` that only TRAILING PADDING extends. Padding supplies the
        range; scroll-padding spends it. Take either away and the row cannot
        reach the last tab's far edge.

        SO THE PARAGRAPH ABOVE IS RIGHT AND INCOMPLETE, and the sentence this
        one replaced -- "trailing padding is not what is short here and never
        could be" -- was FALSE, and false in the direction that invites somebody
        to delete `pr-1` as a keepsake. It is not a keepsake. It is half of a
        working fix. The first measurement behind that sentence swept
        padding-right while `pr-2` was on the element and scroll-padding while
        `pr-2` was on it too, so it never saw either property alone and read a
        conjunction as a substitution.

        THE LABEL IS THE HALF THAT DOES NOT GIVE WAY. Shortening it would have
        moved the arithmetic too, and a label that does not name a thing on the
        page is the navigation quietly disagreeing with it -- which is the rule
        this tab has now been renamed twice to keep.
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
