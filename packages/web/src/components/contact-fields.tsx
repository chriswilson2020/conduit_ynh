import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  NONE_OPTION, OTHER_OPTION, chooseOption, customText, optionForValue, presetOption, typedValue,
} from "./contact-fields-lib";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface PresetOrOtherFieldProps {
  /** The row's visible label, and the stem of both controls' accessible names. */
  label: string;
  value: string | null;
  presets: readonly string[];
  /** CONTACT_FIELD_CAPS's figure for this field, never a number written out here. */
  maxLength: number;
  disabled?: boolean;
  /** `field-<name>` on the row, and `<name>`/`<name>-other` on the two controls. */
  name: string;
  /** null clears. See typedValue: the API's "no value" is null and never "". */
  onCommit: (next: string | null) => void;
}

/**
 * A PRESET PICKER WITH AN "Other..." THAT ACCEPTS ANYTHING.
 *
 * Both of v1.1.0's contact fields are this shape, and both are optional and
 * empty by default. The presets are a convenience: no list can anticipate every
 * honorific or pronoun set in every language, so the escape hatch is the feature
 * and the list is the shortcut.
 *
 * WHAT THIS COMPONENT DOES NOT DO is the part worth naming. It does not infer,
 * it does not normalise, it does not trim and it does not reject --
 * contact-fields-lib.ts holds every decision it makes, and not one of those
 * functions is handed the other field or the contact's name to guess from.
 *
 * THE STORED VALUE WINS WHENEVER IT CHANGES, which is what the first effect is
 * for. The picker's option has to be local state -- somebody choosing "Other..."
 * has saved nothing yet, so there is no stored value to derive it from -- but a
 * value arriving from anywhere else (a save settling, a refetch, another tab over
 * SSE) has to take the picker with it, or the controls on screen would go on
 * showing something the record no longer says.
 */
export function PresetOrOtherField({
  label, value, presets, maxLength, disabled = false, name, onCommit,
}: PresetOrOtherFieldProps) {
  const [option, setOption] = useState(() => optionForValue(value, presets));
  const [typed, setTyped] = useState(() => customText(value, presets));
  const otherRef = useRef<HTMLInputElement>(null);
  const seenValue = useRef(value);
  /**
   * THE FOCUS FLAG, AND WHY IT IS NOT `autoFocus`.
   *
   * A Radix Select RESTORES FOCUS TO ITS TRIGGER when the menu closes, and it
   * does that AFTER the chosen value has re-rendered -- so the box mounts,
   * `autoFocus` puts the caret in it, and Radix takes it straight back.
   * Measured: `document.activeElement` immediately after clicking "Other..."
   * was the trigger BUTTON, never the input, on both fields, every time.
   *
   * THAT IS NOT A COSMETIC BUG, WHICH IS WHY THIS COMMENT IS LONG. Focus on a
   * Radix trigger makes letter keys TYPEAHEAD. An operator who clicked
   * "Other..." and typed `Drs` -- the whole reason the option exists -- had the
   * `D` select the preset `Dr`, save it, and unmount the box mid-word. `p`
   * saved `Prof`; `t` on the pronoun field saved `they/them`. The keystrokes
   * never reached the box, so no unit test could see it: the functions in
   * contact-fields-lib.ts were never called at all.
   *
   * THE CONDITION IS "IS THE BOX ON SCREEN", NOT "DID THIS CLICK OPEN IT", and
   * the first version got that wrong in a way that left the same data loss one
   * click away. It set a flag inside `onValueChange` -- and Radix does not fire
   * that for a SAME-VALUE selection, so on a field already showing "Other..."
   * re-picking "Other..." set nothing, this handler returned early, and focus
   * went back to the trigger. Measured on a contact holding `Dhr`: typing `Drs`
   * after the re-pick fired typeahead on the `D`, saved `{"salutation":"Dr"}`
   * and destroyed `Dhr`. Escape reached it too, since a dismissal fires no
   * value change at all.
   *
   * Reading the ref instead answers the question that actually matters: the box
   * is rendered exactly when the field is on "Other...", so if it is there the
   * caret belongs in it, whichever gesture closed the menu. If it is not, there
   * is nothing to focus and Radix's own restore is the right behaviour -- which
   * is what every other Select in the app keeps.
   *
   * WHAT THIS DOES NOT FIX, deliberately: Escape-then-type on a field showing a
   * PRESET still commits a preset by typeahead, because the trigger really does
   * hold focus and that is Radix's behaviour app-wide (the owner picker assigns
   * an owner from a single `r`). It is handled HERE and not there because this
   * is the only Select in the app whose typeahead can destroy free text that
   * has no other home; a preset it overwrites is one click from being restored.
   */
  /**
   * THE VALUE A COMMIT IS IN FLIGHT FOR, so one edit is one request.
   *
   * The guard below cannot use `value` alone: that is the prop, and it lags the
   * mutation. Enter commits, and a blur a moment later compares against a prop
   * the server has not answered yet. MEASURED, by holding the PATCH open for
   * two seconds and pressing Return then tapping away -- which is what an
   * operator moving to the next field does: TWO identical
   * `{"salutation":"Drs"}` requests went out, and one with this guard.
   *
   * BE PRECISE ABOUT WHAT THE SECOND ONE COSTS, because the obvious answer is
   * wrong. It is NOT a second timeline entry: services/contacts.ts computes
   * `changed` against the stored row and returns early when it is empty, so a
   * duplicate that arrives after the first has landed writes no row and no
   * event. What it costs is a redundant round trip -- and the protection is the
   * SERVER's, not this component's, so it is not something to lean on from
   * here: two writes that overlap in the service both read the pre-update row.
   *
   * Cleared when the stored value arrives (the resync effect) and when the box
   * is typed into, so a fresh keystroke always re-arms it. What it does NOT do
   * is recover from a REFUSED commit: the value stays marked as sent, so
   * re-committing the identical value is suppressed until something changes.
   * The two refusals reachable here are an archived contact -- where both
   * controls are disabled anyway -- and a lost connection, which puts a message
   * in the page's banner.
   */
  const inFlight = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (seenValue.current === value) return;
    seenValue.current = value;
    inFlight.current = undefined;
    setOption(optionForValue(value, presets));
    setTyped(customText(value, presets));
  }, [value, presets]);

  /**
   * ONE EDIT, ONE REQUEST. Nothing is sent for a value the record already
   * holds, or for one already on its way -- see `inFlight` for what the
   * duplicate really costs, and for why the server's own no-op guard is not
   * something this component may rely on.
   */
  function commit(next: string | null) {
    if (next === value || next === inFlight.current) return;
    inFlight.current = next;
    onCommit(next);
  }

  function handleOption(next: string) {
    setOption(next);
    const chosen = chooseOption(next);
    if (chosen.kind === "other") return;
    setTyped("");
    commit(chosen.value);
  }

  /** The box wins the caret whenever it is on screen -- see the note above. */
  function takeFocusFromTheMenu(event: Event) {
    const box = otherRef.current;
    if (box === null) return;
    event.preventDefault();
    box.focus();
  }

  function commitTyped() {
    commit(typedValue(typed));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // The row sits inside no form today, but a stray submit is one wrapper
      // away and this box is not a submit trigger.
      event.preventDefault();
      commitTyped();
    } else if (event.key === "Escape") {
      setTyped(customText(value, presets));
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <span className="w-32 shrink-0 pt-2 text-sm font-medium text-slate-500">{label}</span>
      <div data-testid={`field-${name}`} className="flex max-w-xs flex-1 flex-col gap-2">
        <Select value={option} onValueChange={handleOption} disabled={disabled}>
          <SelectTrigger ariaLabel={label} testId={name}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent onCloseAutoFocus={takeFocusFromTheMenu}>
            <SelectItem value={NONE_OPTION}>None</SelectItem>
            {presets.map((preset) => (
              <SelectItem key={preset} value={presetOption(preset)}>
                {preset}
              </SelectItem>
            ))}
            <SelectItem value={OTHER_OPTION}>Other...</SelectItem>
          </SelectContent>
        </Select>
        {option === OTHER_OPTION && (
          <Input
            ref={otherRef}
            aria-label={`${label}, typed`}
            data-testid={`${name}-other`}
            value={typed}
            // Derived from CONTACT_FIELD_CAPS by the caller, so the cap is
            // unreachable from this box rather than restated in it.
            maxLength={maxLength}
            disabled={disabled}
            onChange={(event) => {
              // A fresh keystroke re-arms the in-flight guard; see its comment.
              inFlight.current = undefined;
              setTyped(event.target.value);
            }}
            onBlur={commitTyped}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>
    </div>
  );
}
