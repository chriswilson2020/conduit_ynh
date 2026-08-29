import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_FIELD_CAPS, createContactInputSchema } from "@conduit/shared";
import { withoutComments } from "../test/source";
import {
  NONE_OPTION, OTHER_OPTION, PRONOUN_PRESETS, SALUTATION_PRESETS,
  chooseOption, customText, nameWithSalutation, optionForValue, presetOption, typedValue,
} from "./contact-fields-lib";

/**
 * The two pickers v1.1.0 adds, and the rule that governs both of them.
 *
 * The behaviour tests here are ordinary pure logic. The absence test at the
 * bottom is the one the spec asks for by name, and the source guards after it
 * cover what a class string and a JSX prop cannot otherwise be held to in a
 * repo with no testing-library -- the browser half is Task 3's e2e.
 */

describe("the preset lists", () => {
  /**
   * THE SIX AND THE THREE THE SPEC NAMES. Pinned as an ordered list because
   * the order is what somebody scrolls, and because a list that quietly loses
   * Mx or gains a seventh is a product change rather than a refactor.
   */
  it("offers exactly what the spec names, in order", () => {
    expect(SALUTATION_PRESETS).toEqual(["Mr", "Mrs", "Ms", "Mx", "Dr", "Prof"]);
    expect(PRONOUN_PRESETS).toEqual(["he/him", "she/her", "they/them"]);
  });

  /**
   * A PRESET THE API WOULD REFUSE WOULD BE A PICKER OPTION THAT CANNOT BE
   * CHOSEN. Driven through the real schema rather than eyeballed against the
   * cap, so a preset added past 64 characters -- or one that trips the NUL and
   * surrogate refinement -- fails here rather than on somebody's first click.
   */
  it("offers nothing the API would refuse", () => {
    for (const preset of [...SALUTATION_PRESETS, ...PRONOUN_PRESETS]) {
      expect(preset.length).toBeLessThanOrEqual(CONTACT_FIELD_CAPS.salutation);
      expect(createContactInputSchema.safeParse({ firstName: "Ada", salutation: preset }).success)
        .toBe(true);
      expect(createContactInputSchema.safeParse({ firstName: "Ada", pronouns: preset }).success)
        .toBe(true);
    }
  });
});

describe("which option a stored value selects", () => {
  it("selects the preset it is, and Other for everything else", () => {
    expect(optionForValue(null, SALUTATION_PRESETS)).toBe(NONE_OPTION);
    expect(optionForValue("Dr", SALUTATION_PRESETS)).toBe(presetOption("Dr"));
    expect(optionForValue("Dhr", SALUTATION_PRESETS)).toBe(OTHER_OPTION);
    expect(optionForValue("she/they", PRONOUN_PRESETS)).toBe(OTHER_OPTION);
    // Each list is matched against its OWN presets: "Dr" is a preset of one
    // and a typed value of the other, and neither borrows from the other.
    expect(optionForValue("Dr", PRONOUN_PRESETS)).toBe(OTHER_OPTION);
    expect(optionForValue("he/him", SALUTATION_PRESETS)).toBe(OTHER_OPTION);
  });

  /**
   * THE COLLISION CASE, WHICH IS WHY THE PRESET OPTIONS CARRY A PREFIX.
   *
   * Every string is a legal salutation, so a picker whose option values were
   * the field's values would mis-select for a contact whose title is literally
   * "none" or "other" -- and then rewrite it on the next commit. Matching the
   * stored value against the preset LIST, and never against an option value,
   * is what makes that impossible rather than unlikely.
   */
  it("treats a value that looks like an option name as an ordinary value", () => {
    for (const value of [NONE_OPTION, OTHER_OPTION, presetOption("Mr"), "preset:", "None"]) {
      expect(optionForValue(value, SALUTATION_PRESETS)).toBe(OTHER_OPTION);
      expect(customText(value, SALUTATION_PRESETS)).toBe(value);
    }
  });

  it("seeds the typed box only from a value somebody typed", () => {
    expect(customText(null, SALUTATION_PRESETS)).toBe("");
    expect(customText("Dr", SALUTATION_PRESETS)).toBe("");
    expect(customText("Dhr", SALUTATION_PRESETS)).toBe("Dhr");
  });
});

describe("what choosing an option means", () => {
  it("saves a preset, clears on None, and defers to the box on Other", () => {
    expect(chooseOption(presetOption("Prof"))).toEqual({ kind: "save", value: "Prof" });
    expect(chooseOption(NONE_OPTION)).toEqual({ kind: "save", value: null });
    expect(chooseOption(OTHER_OPTION)).toEqual({ kind: "other" });
  });

  /**
   * CLEARING SENDS null AND NEVER "", which is not a stylistic preference:
   * `cappedNullableString` in @conduit/shared carries `.min(1)`, so the empty
   * string is a 400 and a field sent that way could not be cleared at all.
   * services/contacts.test.ts already calls null "the shape the detail form
   * sends when somebody empties the field"; this is that claim, from the form's
   * side, driven through the same schema.
   */
  it("clears with null, which is the only shape the API accepts for empty", () => {
    expect(typedValue("")).toBeNull();
    expect(chooseOption(NONE_OPTION)).toEqual({ kind: "save", value: null });
    expect(createContactInputSchema.safeParse({ firstName: "Ada", salutation: null }).success)
      .toBe(true);
    expect(createContactInputSchema.safeParse({ firstName: "Ada", salutation: "" }).success)
      .toBe(false);
  });
});

/**
 * THE "Other..." PATH IS THE FEATURE, and this is what it promises: a typed
 * value survives unchanged.
 *
 * NO TRIM is asserted explicitly, because trimming is the one rewrite that
 * looks like tidiness. It is not: the picker exists so that a title the list
 * never anticipated arrives at the column exactly as it was typed, and a form
 * that quietly edits it is only a politer version of the form that refuses it.
 */
describe("a typed value, unchanged", () => {
  const TYPED = [
    "Dhr", "Mevr", "Drs", "Ir", "Ing", "Rev", "Sir",
    "Se\u00f1or", "she/they", "hij/hem", "hen/hun",
    "  Prof  ", "dr", "DR", "Mr.", "\u0130lhan",
    "x".repeat(CONTACT_FIELD_CAPS.salutation),
  ];

  it("passes every one of them through byte for byte", () => {
    for (const value of TYPED) {
      expect(typedValue(value), value).toBe(value);
    }
  });

  /**
   * AND SURVIVES A RELOAD. Storing it is half the round trip; the other half
   * is the picker reading it back as the same value in the same box, which is
   * what these two functions do on the next page load.
   */
  it("reads back into the same box as the same string", () => {
    for (const presets of [SALUTATION_PRESETS, PRONOUN_PRESETS]) {
      for (const value of TYPED) {
        const stored = typedValue(value);
        expect(optionForValue(stored, presets), value).toBe(OTHER_OPTION);
        expect(customText(stored, presets), value).toBe(value);
      }
    }
  });

  /** And the API takes all of them, which is what makes the round trip real. */
  it("is a value the API accepts", () => {
    for (const value of TYPED) {
      expect(createContactInputSchema.safeParse({ firstName: "Ada", salutation: value }).success, value)
        .toBe(true);
      expect(createContactInputSchema.safeParse({ firstName: "Ada", pronouns: value }).success, value)
        .toBe(true);
    }
  });
});

/**
 * O5's RULING, PINNED: an empty-looking box is an empty box.
 *
 * A whitespace-only salutation clears `.min(1)`, so before this it STORED --
 * and then read back into a box that looked empty and reached the contacts list
 * as a leading run of spaces before the name, with nothing on screen to say
 * why. "Store exactly what was typed" and "what you see is what is stored" are
 * both promises this feature makes, and this is the one input where they
 * disagreed. Emptiness is a question about the BOX.
 */
describe("a box holding only whitespace", () => {
  it("clears the field, while a value with spaces around it keeps them", () => {
    for (const blank of ["", " ", "   ", "\t", "\n", " \t "]) {
      expect(typedValue(blank), JSON.stringify(blank)).toBeNull();
    }
    // Not a trim: a value with content keeps every space it was given.
    expect(typedValue("  Prof  ")).toBe("  Prof  ");
    expect(typedValue(" Dr")).toBe(" Dr");
    expect(typedValue("Dr ")).toBe("Dr ");
  });

  /**
   * AND FORMAT CHARACTERS ARE DELIBERATELY NOT POLICED. A stored U+200F can
   * reorder the visible row and `trim` does not remove it -- but the same class
   * holds U+200C, which is load-bearing in Persian and Indic names, and
   * refusing it would break exactly the people whose titles this field exists
   * to record. Recorded as a test so the decision is not re-litigated by
   * accident.
   */
  it("stores a format character rather than guessing what it was for", () => {
    expect(typedValue("\u200cDhr")).toBe("\u200cDhr");
    expect(typedValue("\u200f")).toBe("\u200f");
  });
});

describe("the contact list's name cell", () => {
  it("puts the salutation beside the name and nothing where there is none", () => {
    expect(nameWithSalutation({ salutation: "Dr", firstName: "Ada", lastName: "Lovelace" }))
      .toBe("Dr Ada Lovelace");
    expect(nameWithSalutation({ salutation: null, firstName: "Ada", lastName: "Lovelace" }))
      .toBe("Ada Lovelace");
    expect(nameWithSalutation({ salutation: null, firstName: "Ada", lastName: null })).toBe("Ada");
    expect(nameWithSalutation({ salutation: "Dhr", firstName: "Ada", lastName: null }))
      .toBe("Dhr Ada");
  });
});

/**
 * THE RULE, ASSERTED AS AN ABSENCE.
 *
 * "Both are optional, and neither is ever inferred -- not from the name, not
 * from the salutation, not from anything." The spec states it as a requirement
 * precisely because the inference is tempting and always wrong, so it needs a
 * test that fails when somebody adds one rather than a comment asking them not
 * to.
 *
 * WHAT THIS CAN AND CANNOT CATCH. It drives every function this module exports
 * over contacts built to invite a guess, and fails if any of them ever emits a
 * pronoun set or a title that was not in its own input. It would catch the
 * likely mistake -- a name-to-title table, a salutation-to-pronoun map, a
 * default. It cannot see an inference added in a component that does not go
 * through this module, which is what the source guards below are for.
 */
describe("neither field is ever inferred", () => {
  const INVITING = [
    { salutation: "Mr", pronouns: null, firstName: "Alice", lastName: "Ng" },
    { salutation: "Mrs", pronouns: null, firstName: "Bob", lastName: "Smith" },
    { salutation: null, pronouns: null, firstName: "Ada", lastName: "Lovelace" },
    { salutation: "Dr", pronouns: null, firstName: "Sir", lastName: "Mr" },
  ];

  it("emits no pronoun set for a contact that has none, however much the name suggests one", () => {
    for (const contact of INVITING) {
      const produced = [
        nameWithSalutation(contact),
        optionForValue(contact.pronouns, PRONOUN_PRESETS),
        customText(contact.pronouns, PRONOUN_PRESETS),
        optionForValue(contact.salutation, SALUTATION_PRESETS),
        customText(contact.salutation, SALUTATION_PRESETS),
      ].join(" | ");
      for (const pronouns of PRONOUN_PRESETS) {
        expect(produced, `${contact.firstName}: ${produced}`).not.toContain(pronouns);
      }
      // The pronoun picker for a contact with none is the empty state, full
      // stop: no option selected but None, and nothing in the box.
      expect(optionForValue(contact.pronouns, PRONOUN_PRESETS)).toBe(NONE_OPTION);
      expect(customText(contact.pronouns, PRONOUN_PRESETS)).toBe("");
    }
  });

  /**
   * AND THE SALUTATION IS NOT INFERRED EITHER, which is the half that is easy
   * to forget because the list shows it. A contact with pronouns and no title
   * gets no title.
   */
  it("emits no title for a contact that has none", () => {
    const contact = { salutation: null, pronouns: "she/her", firstName: "Ada", lastName: "Lovelace" };
    expect(nameWithSalutation(contact)).toBe("Ada Lovelace");
    expect(optionForValue(contact.salutation, SALUTATION_PRESETS)).toBe(NONE_OPTION);
    for (const title of SALUTATION_PRESETS) {
      expect(nameWithSalutation(contact)).not.toContain(title);
    }
  });
});

/**
 * Source guards, in this package's house style: they match a SPELLING, not a
 * behaviour, and each says what it does not catch. Comments are stripped first,
 * because every rule guarded here is also explained in prose beside it.
 */
describe("the pickers and the list, as written", () => {
  const read = (path: string) =>
    withoutComments(readFileSync(new URL(path, import.meta.url), "utf8"));
  const picker = read("./contact-fields.tsx");
  const lib = read("./contact-fields-lib.ts");
  const detail = read("../pages/contact-detail.tsx");
  const list = read("../pages/contacts.tsx");

  /**
   * THE LIST SHOWS THE SALUTATION AND NOT THE PRONOUNS -- a list is for finding
   * someone and a pronoun is for writing to them. The type already stops
   * `nameWithSalutation` from rendering one; this catches a second column added
   * beside it, which the type would not.
   */
  it("never names pronouns on the contacts list", () => {
    expect(list).toContain("nameWithSalutation");
    expect(list.toLowerCase()).not.toContain("pronoun");
  });

  /**
   * NEITHER FIELD'S CODE KNOWS THE OTHER'S VOCABULARY. A table mapping titles
   * to pronoun sets has to spell a pronoun set somewhere, and the only place
   * either list is written down is contact-fields-lib.ts's two constants.
   *
   * What it cannot see: an inference built from values it derives at runtime,
   * or one added in a component that imports neither list.
   */
  it("writes each preset list down exactly once, and pairs them nowhere", () => {
    for (const source of [picker, detail, list]) {
      for (const preset of [...SALUTATION_PRESETS, ...PRONOUN_PRESETS]) {
        expect(source).not.toContain(`"${preset}"`);
      }
    }
    for (const preset of PRONOUN_PRESETS) {
      expect(lib.split(`"${preset}"`)).toHaveLength(2);
    }
  });

  /**
   * THE FOCUS FIX, GUARDED IN THE UNIT SUITE AS A SPELLING.
   *
   * The rule itself is a browser fact and only e2e/crm.spec.ts can prove it --
   * a Radix Select restores focus to its trigger AFTER the chosen option has
   * rendered, so `autoFocus` on the revealed box was overwritten every time and
   * the operator's typing became typeahead against the preset list. This is the
   * cheap half: it fails the moment either piece of the remedy is deleted,
   * without waiting for an e2e run.
   *
   * What it cannot see: a remedy that is present but broken -- an
   * `onCloseAutoFocus` that forgets `preventDefault()`, or a ref pointed at the
   * wrong element. The e2e assertion is what covers that.
   */
  it("takes focus back from the Select rather than relying on autoFocus", () => {
    expect(picker).toContain("onCloseAutoFocus={takeFocusFromTheMenu}");
    expect(picker).toContain("ref={otherRef}");
    // autoFocus is what did not work; its return would be the regression.
    expect(picker).not.toContain("autoFocus");

    // SCOPED TO THE HANDLER, not the file. The first version of this assertion
    // looked for `preventDefault` anywhere in the source and was satisfied by
    // the Enter branch of handleKeyDown -- so deleting it from HERE, which is
    // the half that declines Radix's restore and is the whole fix, left the
    // suite green. Found by mutation.
    const handler = picker.slice(
      picker.indexOf("function takeFocusFromTheMenu"),
      picker.indexOf("function commitTyped"),
    );
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain("otherRef.current?.focus()");
  });

  /**
   * THE CAP COMES FROM THE SHARED CONSTANT, never from a number typed here.
   * CONTACT_FIELD_CAPS is exported for exactly this, and a restated 64 is how
   * a form ends up truncating at a bound the API has since moved.
   */
  it("derives the typed box's length limit rather than restating it", () => {
    expect(detail).toContain("maxLength={CONTACT_FIELD_CAPS.salutation}");
    expect(detail).toContain("maxLength={CONTACT_FIELD_CAPS.pronouns}");
    expect(picker).toContain("maxLength={maxLength}");
    expect(picker).not.toMatch(/maxLength=\{?\d/);
  });

  /**
   * THE DETAIL PAGE SENDS THE TWO FIELDS VERBATIM. Every other field on this
   * page is trimmed by buildContactPatch, and routing these two through it is
   * the single likeliest way to lose the round trip -- silently, since a value
   * with no leading or trailing space is unaffected.
   *
   * What it cannot see: a trim added inside the picker itself, which the
   * typedValue tests above cover instead.
   */
  it("keeps the two pickers out of the trimming patch builder", () => {
    expect(detail).toContain("handlePresetField({ salutation: next })");
    expect(detail).toContain("handlePresetField({ pronouns: next })");
    const builder = detail.slice(
      detail.indexOf("function buildContactPatch"),
      detail.indexOf("export function ContactDetailPage"),
    );
    expect(builder).not.toContain("salutation");
    expect(builder).not.toContain("pronouns");
  });
});
