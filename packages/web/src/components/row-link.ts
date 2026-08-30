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
 *    THE FIX PATH EXISTS AND THIS PARAGRAPH USED TO DENY IT. An earlier version
 *    said the overlay was "not the cause" and that "nothing short of taking the
 *    name out of the link recovers it". Both halves were wrong, and the error
 *    came from reading the selection only AFTER mouseup -- in most of these
 *    states the release navigates, and a navigation clears the selection, so a
 *    selection that HAD been made read back as none. Read during the drag as
 *    well, dragging across a row at 1280:
 *
 *      state                                 during mouseup   after
 *      as shipped, name cell                 ""               ""
 *      as shipped, third cell                ""               ""
 *      overlay off, name cell                ""               ""
 *      overlay off, THIRD cell               "8/30/2026"      kept
 *      overlay off + user-select:text        the name         cleared by nav
 *      overlay ON + user-select:text         ""               ""
 *
 *    THE OVERLAY IS THE LARGER CAUSE. With it on, NOTHING in the row selects --
 *    including the second and third cells, which are not inside the anchor at
 *    all -- and `user-select: text` gets nowhere against it, on the anchor or
 *    on the row. With it off, the other cells select normally.
 *
 *    THE ANCHOR IS A SECOND, INDEPENDENT CAUSE for its own text, since a drag
 *    begun on link text is not a selection. But that half IS defeatable:
 *    `user-select: text` on the anchor recovers the name with the `href` and
 *    the link intact.
 *
 *    SO THE ORDER IS: the overlay first, then `user-select` -- and then a third
 *    thing, which is why this is not a one-line change. Even with both, the
 *    recovered selection is discarded on mouseup, because the release still
 *    lands on the anchor and navigates. Making the name genuinely copyable
 *    means trading away some of the whole-row click, and that is a product
 *    decision rather than a tidy-up.
 *
 *    `draggable: false` IS NOT PART OF ANY OF THAT, and was expected to be.
 *    Measured, it changes the dragstart count from 1 to 0 and the selection not
 *    at all. It is kept for that one effect: a row cannot be dragged into
 *    another application as a URL, which is a behaviour these rows never had
 *    as `<tr>`s with a click handler.
 *
 *    Selection was already close to futile: before this change a mouseup inside
 *    the row fired the row's own `onClick` and navigated away, discarding
 *    whatever had just been selected. But futile and impossible are not the
 *    same thing, and this says which one it is now, and what it would take.
 */

/**
 * Goes on the ROW -- the `<tr>` or the `<li>`. Nothing but a containing block
 * for the overlay below: no offsets, so nothing moves.
 */
export const ROW_LINK_ROW = "relative";

/**
 * SPREAD onto the ANCHOR inside the row's first cell: `<Link ... {...ROW_LINK}>`.
 *
 * A PROPS OBJECT AND NOT A CLASS STRING, because the overlay and the drag
 * suppression are ONE contract: a row that covers itself with a link but can
 * still be dragged into another application as a URL has gained a behaviour
 * nobody asked for.
 *
 * WHAT THE SPREAD ACTUALLY PREVENTS, stated narrowly because an earlier version
 * of this comment overstated it. It prevents applying half the contract BY
 * OMISSION -- there is no second attribute to forget. It does NOT make the
 * object tamper-proof: `<Link {...ROW_LINK} draggable>` puts the link drag
 * back, `<Link {...ROW_LINK} className="x">` cancels the overlay, and both were
 * measured to pass every guard that existed when they were tried. What catches
 * those now is row-link.test.ts, which reads each Link's OPENING TAG and
 * requires the spread and no `className` or `draggable` beside it -- and which
 * also catches the spread being moved off the anchor onto a `<span>` or a cell,
 * since the file merely CONTAINING it was all the earlier guard checked.
 *
 * The anchor itself stays an ordinary inline box around the record's name, so
 * the cell renders exactly as it did; the pseudo-element is what covers the row.
 */
export const ROW_LINK = {
  className: "after:absolute after:inset-0",
  draggable: false,
} as const;
