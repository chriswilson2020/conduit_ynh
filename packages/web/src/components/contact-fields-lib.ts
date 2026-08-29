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
 * them type it. "Dhr", "Senor", "she/they" and "hij/hem" store as themselves.
 *
 * THE EMPTY STRING BECOMES null, NEVER "". `cappedNullableString` in
 * @conduit/shared carries `.min(1)`, so "" is a 400 and the field could not be
 * cleared at all if this sent it; null is the shape the column and the API both
 * mean by "no value", and services/contacts.test.ts already names this function
 * as the reason it tests null.
 */
export function typedValue(text: string): string | null {
  return text === "" ? null : text;
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
