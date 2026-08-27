import { userLabel } from "../lib";
import { useUsers } from "../queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface UserPickerProps {
  /** Already chosen, and therefore not offered: the picker prevents a
   * duplicate by not having one to click, rather than by answering with an
   * error after the fact. */
  chosenUserIds: readonly string[];
  /** The id, plus the label AS RENDERED -- so a caller's chip reads exactly
   * what was clicked instead of resolving the same user a second way. */
  onPick: (userId: string, label: string) => void;
  /** The trigger's standing text. It never changes: this control is an
   * invitation, not a value. */
  placeholder: string;
  ariaLabel: string;
  testId?: string;
}

/**
 * "Add one of your colleagues" -- an ADD control, where OwnerSelect is a
 * FIELD. The difference is the whole reason this exists: an owner select
 * reports who the owner is and changes when that changes, while this reports
 * nothing and fires once per click, including for the same person twice.
 *
 * Built on the same Radix primitives, with two departures that make the
 * semantics honest:
 *
 * `value=""` is Radix's own "no selection" (its shouldShowPlaceholder), not a
 * sentinel option standing in for one. So the combobox reports no value ever
 * -- which is true -- the trigger shows `placeholder` at all times, and
 * onValueChange fires on every pick, since a pinned "" never equals a user id
 * (useControllableState only suppresses onChange when the next value equals
 * the current prop). The option list holds users and nothing else: there is
 * no "unassigned" row to click that would do nothing.
 *
 * `position="popper"` follows from that choice rather than being decoration.
 * Radix's default lines the list up with the SELECTED item, and with none it
 * silently substitutes the first enabled one (SelectContentImpl's
 * itemRefCallback) -- so a field's positioning happens to work here, on a
 * fallback, until the list is EMPTY (every colleague already added), which is
 * the one case with no item to stand in: its whole position() body is gated
 * on `selectedItem`, so the popup keeps `position: fixed` with no offsets and
 * lands wherever its static position falls, far from the trigger. Popper
 * anchors to the trigger, the way a menu is anchored, in both cases.
 */
export function UserPicker({ chosenUserIds, onPick, placeholder, ariaLabel, testId }: UserPickerProps) {
  const { data: users = [] } = useUsers();
  const offered = users.filter((user) => !chosenUserIds.includes(user.id));

  return (
    <Select
      value=""
      onValueChange={(userId) => {
        const user = offered.find((candidate) => candidate.id === userId);
        // Unreachable through the list: every option here is one of `offered`,
        // and Radix only reports a value one of them carries.
        if (user === undefined) return;
        onPick(user.id, userLabel(user, ""));
      }}
    >
      <SelectTrigger ariaLabel={ariaLabel} testId={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {/* An empty popup would be a dead end with nothing to say. Not a
            SelectItem: it must not be clickable, typeahead-findable, or
            counted as an option by a test asking who is on offer. */}
        {offered.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-slate-400">Everyone is already here</p>
        )}
        {offered.map((user) => (
          <SelectItem key={user.id} value={user.id}>
            {userLabel(user, "")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
