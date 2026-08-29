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
  /**
   * FOCUS THE BOX WHEN THE USER OPENED IT, AND ONLY THEN.
   *
   * `autoFocus` is applied at mount, and this box mounts for two different
   * reasons: somebody picked "Other...", where the caret belongs in it, and a
   * contact with a custom value already stored being opened, where it does not
   * -- an unconditional autoFocus would steal focus from the page on every load
   * of any contact whose title is not one of the six presets.
   */
  const [focusOther, setFocusOther] = useState(false);
  const seenValue = useRef(value);

  useEffect(() => {
    if (seenValue.current === value) return;
    seenValue.current = value;
    setOption(optionForValue(value, presets));
    setTyped(customText(value, presets));
    setFocusOther(false);
  }, [value, presets]);

  function handleOption(next: string) {
    setOption(next);
    setFocusOther(next === OTHER_OPTION);
    const chosen = chooseOption(next);
    if (chosen.kind === "other") return;
    setTyped("");
    if (chosen.value !== value) onCommit(chosen.value);
  }

  /**
   * COMMITTING THE BOX, AND THE NO-OP CASE IS DELIBERATE.
   *
   * A blur that would save what is already stored sends nothing: the PATCH would
   * be answered with the same record, and the contact's timeline would carry an
   * "updated" event for an edit nobody made. It also keeps the empty-box case
   * honest -- picking "Other..." on a contact that has no value yet and tabbing
   * straight past leaves the picker open with nothing written.
   */
  function commitTyped() {
    const next = typedValue(typed);
    if (next !== value) onCommit(next);
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
          <SelectContent>
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
            autoFocus={focusOther}
            aria-label={`${label}, typed`}
            data-testid={`${name}-other`}
            value={typed}
            // Derived from CONTACT_FIELD_CAPS by the caller, so the cap is
            // unreachable from this box rather than restated in it.
            maxLength={maxLength}
            disabled={disabled}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={commitTyped}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>
    </div>
  );
}
