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
 *   - the anchor carries ROW_LINK, whose `after:inset-0` then covers the row.
 *
 * That keeps the table intact at a desk (the row is still a `<tr>` of `<td>`s
 * and each cell still has its own accessible name), keeps the card layout
 * intact below the breakpoint, and keeps the hit area exactly what it was: the
 * whole row. That last part is load-bearing for the suite as well as for the
 * user -- e2e clicks a row by its `row-<id>` test id, and Playwright clicks an
 * element's CENTRE, which at a desk is a middle column that was never inside
 * the anchor. Measured with elementFromPoint at nine points across a row, at
 * 1280 and at 390: every one of them answers the anchor.
 *
 * THE ACCESSIBLE NAME IS THE RECORD, not the row. Only the first cell's
 * content is inside the anchor, so a screen reader announces "Acme BV, link"
 * rather than reading out every column. The remaining cells stay ordinary row
 * content and are still reachable.
 *
 * WHAT IT COSTS, said plainly. The pseudo-element sits ON TOP of the row, so
 * anything else in it stops being hoverable and clickable unless it is lifted
 * back out with its own stacking (My Tasks does exactly that for its done
 * checkbox, which is a real control). Text in the other cells can no longer be
 * selected with the mouse. Neither is new to this pattern and both were true
 * in spirit already, since the whole row was a click target before.
 */

/**
 * Goes on the ROW -- the `<tr>` or the `<li>`. Nothing but a containing block
 * for the overlay below: no offsets, so nothing moves.
 */
export const ROW_LINK_ROW = "relative";

/**
 * Goes on the ANCHOR inside the row's first cell. The anchor itself stays an
 * ordinary inline box around the record's name, so the cell renders exactly as
 * it did; the pseudo-element is what covers the row.
 */
export const ROW_LINK = "after:absolute after:inset-0";
