/**
 * A LIST ROW IS A LINK TO THE RECORD, and these are the two halves that make
 * one without moving a pixel.
 *
 * WHAT WAS WRONG. Every entity list -- companies, contacts, projects,
 * pipelines, My Tasks -- opened a record from an `onClick` on the row element.
 * A `<tr>` or an `<li>` with a click handler has no role, no accessible name
 * and NO TAB STOP, so the record could not be opened from a keyboard at all,
 * at a desk or on a phone. Phase 6 recorded it as a screen-reader gap; it was
 * broader than that, and below the breakpoint the rows also stop being table
 * rows (see ui/table.tsx), which is where it was noticed.
 *
 * WHY AN ANCHOR AND NOT A BUTTON. Navigation is what a row does. An anchor is
 * the honest element for it and brings a tab stop, Enter, middle-click and
 * open-in-new-tab; a button would bring the tab stop and lose the other three.
 * The links are router `Link`s, so an ordinary left click still routes on the
 * client exactly as the handler did, and only a modifier click reaches the
 * browser's own navigation.
 *
 * WHY THE HANDLER IS GONE RATHER THAN KEPT ALONGSIDE. An anchor and a click
 * handler on the same row are TWO navigation paths, and a Cmd-click would take
 * both -- opening a tab and moving the current one. There is one path now.
 *
 * THE MECHANISM. An anchor may not wrap a row's `<td>`s, so the link lives
 * inside the FIRST cell, around the record's name, and is stretched over the
 * whole row by an absolutely positioned pseudo-element. Two halves, and they
 * are useless apart:
 *
 *   - the row carries ROW_LINK_ROW, which makes it the containing block;
 *   - the anchor spreads ROW_LINK, whose `after:inset-0` then covers the row.
 *
 * That keeps the table intact at a desk (the row is still a `<tr>` of `<td>`s
 * and each cell still has its own accessible name), keeps the card layout
 * intact below the breakpoint, and keeps the hit area exactly what it was: the
 * whole row. Measured with elementFromPoint at nine points across a COMPANIES
 * row, at 1280 and at 390: every one of them answers the anchor. My Tasks is
 * the deliberate exception -- see its done checkbox, which is lifted back out.
 *
 * THE SUITE IS A THIN NET UNDER THAT, AND THE NUMBER IS WORTH KNOWING. The
 * plan said "119 e2e tests click these rows"; measured, exactly TWO do, both on
 * companies -- e2e/crm.spec.ts at 1280 and e2e/mobile.spec.ts at 390. Two
 * further places locate a contacts row and assert its text without clicking,
 * and nothing clicked a projects, pipelines or task row at all. Playwright
 * clicks an element's CENTRE, so those two exercise the middle of the row and
 * nothing else: they catch a shrunken overlay only while the fixtures' names
 * stay short enough to leave the centre outside the first cell.
 * e2e/row-links.spec.ts is the guard that does not depend on that -- it probes
 * the row's far edges, where the first column can never reach.
 *
 * THE ACCESSIBLE NAME IS THE RECORD, not the row. Only the first cell's
 * content is inside the anchor, so a screen reader announces "Acme BV, link"
 * rather than reading out every column. The remaining cells stay ordinary row
 * content and are still reachable.
 *
 * WHAT IT COSTS, said plainly, because one of these is a real loss.
 *
 * 1. The pseudo-element sits ON TOP of the row, so anything else in it stops
 *    being hoverable and clickable unless it is lifted back out with its own
 *    stacking. My Tasks does exactly that for its done checkbox, which is a
 *    real control, and deliberately does NOT for its type badge, which gives up
 *    a `title` tooltip as a result.
 *
 * 2. TEXT IN A ROW CAN NO LONGER BE SELECTED WITH THE MOUSE, AND THAT INCLUDES
 *    THE RECORD'S NAME -- the one cell an operator is most likely to want to
 *    copy. Dragging across it yielded "Acme Holdin" before this change and ""
 *    after.
 *
 *    THE OBVIOUS FIX DOES NOT WORK, AND THE MEASUREMENT IS WHY THIS PARAGRAPH
 *    IS LONG. `draggable: false` was expected to recover the name, on the
 *    reasoning that an anchor is natively draggable and so a mousedown-drag on
 *    it starts a LINK drag rather than a selection. Measured in Chromium,
 *    dragging across the name cell:
 *
 *      as shipped                    selected ""  dragstart 0  navigated yes
 *      with draggable back to true   selected ""  dragstart 1  navigated no
 *      with the overlay removed too  selected ""  dragstart 0  navigated yes
 *
 *    THE NAME IS UNSELECTABLE WITH THE OVERLAY GONE, so the overlay is not the
 *    cause and neither is the drag: the cause is that the name is inside an
 *    anchor at all, and a drag begun on link text is never a text selection.
 *    Nothing short of taking the name out of the link recovers it, and that is
 *    the whole mechanism.
 *
 *    `draggable: false` IS STILL SET, for the one thing it does do: it takes
 *    the dragstart from 1 to 0, so a row cannot be dragged as a URL into
 *    another application -- a behaviour these rows never had before they
 *    became links. What it leaves is a drag-attempt that navigates, which is
 *    exactly what the old `onClick` did on mouseup, so the row behaves as it
 *    used to rather than in a third new way.
 *
 *    Selection was already close to futile: before this change a mouseup inside
 *    the row fired the row's own `onClick` and navigated away, discarding
 *    whatever had just been selected. But futile and impossible are not the
 *    same thing, and this says which one it is now.
 */

/**
 * Goes on the ROW -- the `<tr>` or the `<li>`. Nothing but a containing block
 * for the overlay below: no offsets, so nothing moves.
 */
export const ROW_LINK_ROW = "relative";

/**
 * SPREAD onto the ANCHOR inside the row's first cell: `<Link ... {...ROW_LINK}>`.
 *
 * A PROPS OBJECT AND NOT A CLASS STRING, which is the point rather than a
 * flourish. The overlay and the drag suppression are ONE contract -- a row that
 * covers itself with a link but can still be dragged into another application
 * as a URL is a row that gained a behaviour nobody asked for -- and a spread
 * cannot be half-remembered the way two attributes side by side can. That
 * matters here because the class had already been shown to be deletable with
 * every guard staying green.
 *
 * The anchor itself stays an ordinary inline box around the record's name, so
 * the cell renders exactly as it did; the pseudo-element is what covers the row.
 */
export const ROW_LINK = {
  className: "after:absolute after:inset-0",
  draggable: false,
} as const;
