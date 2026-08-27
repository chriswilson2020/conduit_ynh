/**
 * Touch-target class runs that more than one component needs.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, adopted in Phase 6 after the same
 * `max-md:` run had been retyped five and six times respectively: extract a
 * run to a named constant the moment it appears in a SECOND place. A class
 * string copied twice is a class string that will be edited once.
 *
 * A run that only one file uses stays in that file -- `mail/rich-text.tsx`
 * names its own toolbar run locally, because both uses are its own.
 *
 * These are `max-md:` throughout, like everything else in this phase: the
 * 44px floor is the phone's, and applying it at a desk would change the
 * desktop, which this phase may not do.
 */

/**
 * The remove control on a chip -- the times sign inside an attendee, a
 * recipient, an attachment or a thread link.
 *
 * The chip itself cannot grow to 44px without turning into a button-sized
 * box, so the TAP AREA grows instead of the chip: the negative margins let
 * the hit box overhang the chip's own padding, which leaves the painted glyph
 * exactly where it was while making the thing under a thumb the right size.
 * Used by mail/composer.tsx (three chips), mail/link-panel.tsx and
 * rail/meetings.tsx.
 */
export const CHIP_REMOVE_TOUCH =
  "max-md:-my-2 max-md:-mr-2 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center";

/**
 * A checkbox and its word, as one row.
 *
 * The target is the LABEL, not the 13px box inside it: a native checkbox
 * cannot be resized without replacing it, and the label already carries the
 * click through to it. Used by the entity tables and by the "Archived"
 * toggles on pipelines, meetings, the company page, mail settings and
 * template settings.
 */
export const CHECKBOX_LABEL =
  "flex items-center gap-2 text-sm text-slate-600 max-md:min-h-11";
