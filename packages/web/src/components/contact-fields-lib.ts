/**
 * THE SALUTATION AND PRONOUN PICKERS, AS LOGIC A TEST CAN HOLD.
 *
 * This app has no testing-library and no jsdom, so a component is provable only
 * through e2e. Everything the two pickers decide -- which option a stored value
 * selects, what the "Other..." box is seeded with, and what a typed box commits
 * to -- lives here for exactly that reason, the same split board-lib.ts,
 * inbox-lib.ts, nav-lib.ts and document-lib.ts already make.
 *
 * NOTHING HERE INFERS ANYTHING, and the module is shaped so that it cannot.
 * Every function below takes ONE field's value and ONE preset list; not one of
 * them can see the other field, or the contact's name, because none of them is
 * given it. That is the spec's central rule ("both are optional, and neither is
 * ever inferred") expressed as a signature rather than as a promise -- a guess
 * from the name or from the other field would have to be typed into existence
 * first. nameWithSalutation below is the one function that takes more than a
 * single field, and its parameter type is the reason it still cannot guess.
 */

/**
 * THE PICKER'S PRESETS ARE A UI CONVENIENCE AND NOT A CONSTRAINT. There is no
 * enum, no CHECK on the value set and no validation against these lists
 * anywhere -- see CONTACT_FIELD_CAPS in @conduit/shared, which is a LENGTH and
 * nothing else. Dhr, Mevr, Drs, Ir, Ing, Rev, Sir, "she/they", "hij/hem" and a
 * title in a language nobody has thought of yet all reach the column unchanged
 * through "Other...".
 */
export const SALUTATION_PRESETS = ["Mr", "Mrs", "Ms", "Mx", "Dr", "Prof"] as const;
export const PRONOUN_PRESETS = ["he/him", "she/her", "they/them"] as const;

/**
 * THE TWO SENTINELS AND THE PREFIX, AND THE PREFIX IS WHAT MAKES A COLLISION
 * IMPOSSIBLE RATHER THAN UNLIKELY.
 *
 * Radix reserves the empty string for "no selection", so "cleared" needs a real
 * option value the way owner-select.tsx's UNASSIGNED does. But a picker whose
 * option values ARE the field's values has a second problem that one does not:
 * every string is a legal salutation, so a contact whose title is literally
 * "none" or "other" would select the wrong option and then be rewritten by it.
 *
 * Prefixing the preset options fixes it outright. A stored value is matched
 * against the preset LIST, never against an option value, so `optionForValue`
 * maps "other" to OTHER_OPTION with "other" in the text box -- which is exactly
 * right -- and maps "preset:Mr" the same way. The two namespaces cannot meet.
 */
export const NONE_OPTION = "none";
export const OTHER_OPTION = "other";
const PRESET_PREFIX = "preset:";

/** The Select option value for a preset. Never a bare preset -- see above. */
export function presetOption(preset: string): string {
  return PRESET_PREFIX + preset;
}

/**
 * Which option a STORED value selects.
 *
 * Anything that is not null and not one of the presets is a value somebody typed,
 * so it selects "Other..." and reappears in the box below it. That is what makes
 * the round trip survive a reload: "Dhr" saved is "Dhr" read back, still in the
 * box it was typed into, rather than a picker that has quietly forgotten it.
 */
export function optionForValue(value: string | null, presets: readonly string[]): string {
  if (value === null) return NONE_OPTION;
  return presets.includes(value) ? presetOption(value) : OTHER_OPTION;
}

/**
 * What the "Other..." box holds for a stored value: the value itself when it is
 * a custom one, and NOTHING otherwise.
 *
 * Empty for a preset on purpose. Seeding the box with "Dr" when somebody has
 * just moved off the "Dr" option would make the box disagree with the choice
 * they made, and committing it unchanged would re-save a value they were leaving.
 */
export function customText(value: string | null, presets: readonly string[]): string {
  if (value === null) return "";
  return presets.includes(value) ? "" : value;
}

/**
 * What picking an option MEANS: a value to save now, or the "Other..." box to
 * type into.
 *
 * "Other..." saves nothing by itself. The box below it does, when it is
 * committed -- and an empty box committed is a clear, which is how the picker
 * gets back to None from a value nobody wants any more.
 */
export type OptionChoice =
  | { readonly kind: "save"; readonly value: string | null }
  | { readonly kind: "other" };

export function chooseOption(option: string): OptionChoice {
  if (option === OTHER_OPTION) return { kind: "other" };
  if (option === NONE_OPTION) return { kind: "save", value: null };
  return { kind: "save", value: option.slice(PRESET_PREFIX.length) };
}

/**
 * WHAT A TYPED BOX COMMITS TO, AND THE ANSWER IS "EXACTLY WHAT WAS TYPED".
 *
 * NO TRIM, no case fix, no normalisation of any kind, and that is the whole
 * point of the "Other..." path rather than an omission: a picker that quietly
 * rewrites what somebody typed is no better than the picker that would not let
 * them type it. "Dhr", "Senor", "she/they", "hij/hem" and "  Prof  " with its
 * spaces all store as themselves.
 *
 * AN EMPTY BOX BECOMES null, NEVER "". `cappedNullableString` in
 * @conduit/shared carries `.min(1)`, so "" is a 400 and the field could not be
 * cleared at all if this sent it; null is the shape the column and the API both
 * mean by "no value", and services/contacts.test.ts already names this function
 * as the reason it tests null.
 *
 * A BOX WITH NOTHING VISIBLE IN IT IS AN EMPTY BOX, and that is a deliberate
 * ruling rather than a stray trim. It is the one place where "store exactly
 * what was typed" and "what you see is what is stored" disagree: an invisible
 * salutation clears `.min(1)`, so it STORES, reads back into a box that looks
 * empty, and reaches the contacts list where nobody can tell it from a cleared
 * one -- or find out why the row is not quite aligned with its neighbours.
 * Emptiness is a question about the box, so a box with no visible content
 * clears the field and every box with any is stored byte for byte, spaces
 * included.
 *
 * `trim()` IS NOT THAT RULE, WHICH IS WHY THIS IS A CHARACTER CLASS. JS `trim`
 * strips U+FEFF and U+00A0 but NOT U+200B or U+200F, so a zero-width space
 * survived it, stored, and rendered a measured 3.8px indent in the contacts
 * list -- precisely the invisible-value-you-cannot-tell-from-cleared this rule
 * exists to prevent. `\p{Cf}` is what covers those: U+200B through U+200F and
 * U+FEFF are all format characters.
 *
 * AND IT IS ABOUT THE WHOLE BOX, NEVER ABOUT INDIVIDUAL CHARACTERS. `Dhr\u200c`
 * has visible content and is stored with its joiner intact -- U+200C is
 * load-bearing in Persian and Indic names, and stripping or refusing it would
 * break exactly the people whose titles this field exists to record. Only a box
 * in which NOTHING is visible is treated as empty.
 *
 * FIVE SURFACES CARRY THIS VALUE AND THEY DO NOT ALL DO THE SAME THING. That is
 * deliberate, and worth writing down rather than discovering:
 *
 *   this form        an invisible box clears the field. It is the only place
 *                    that normalises, because it is the only one that can see
 *                    what the operator meant.
 *   the API          stores what it is given. `cappedNullableString` is a
 *                    LENGTH gate plus a storability refinement; deciding what a
 *                    value MEANS is not a wire concern, and a client that sends
 *                    a zero-width space has said something deliberate.
 *   the contacts list  renders it. HTML collapses leading ASCII spaces to 0px,
 *                    so a spaces-only value was never the "ragged edge" an
 *                    earlier version of this comment claimed -- it was
 *                    invisible, which is worse. A zero-width space is 3.8px.
 *   the quote merge  treats an absent salutation as nothing, via the seeded
 *                    template's {{#document.recipientSalutation}} block. An
 *                    invisible value is not absent, so it renders as itself.
 *                    (This row said "the mail merge" and named v1.1.0's
 *                    one-following-space rule until v1.2.2 removed the mail
 *                    template feature; that merge no longer exists, and the
 *                    quote's is the only one a contact field now reaches.)
 *   the quote form   trims its own salutation on submit, because that one is a
 *                    printed line on an immutable PDF rather than a record of
 *                    what somebody typed. See document-lib.ts.
 */
const NOTHING_VISIBLE = /^[\s\p{Cf}]*$/u;

export function typedValue(text: string): string | null {
  return NOTHING_VISIBLE.test(text) ? null : text;
}

/**
 * The contact list's name cell: the salutation beside the name.
 *
 * PRONOUNS ARE NOT A PARAMETER, and the type is the enforcement. A list is for
 * finding someone and a pronoun is for writing to them, so the list never shows
 * them -- and this function could not show them if it wanted to, because it is
 * never handed them. The rest of the rule is here too: a null salutation
 * contributes nothing at all rather than a placeholder or a dash, so a contact
 * without one reads exactly as it did before this release.
 */
export function nameWithSalutation(
  contact: { readonly salutation: string | null; readonly firstName: string; readonly lastName: string | null },
): string {
  return [contact.salutation, contact.firstName, contact.lastName]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
}
