import { useUsers } from "../queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// Radix Select reserves the empty string for "no selection", so null (the
// domain's "unassigned") needs a real sentinel value to round-trip through it.
const UNASSIGNED = "unassigned";

export interface OwnerSelectProps {
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  /**
   * What the null option reads as. "Unassigned" is right for an owner or an
   * assignee, and wrong for the one caller that uses this as a plain PICKER
   * rather than a field -- the meetings attendee input (rail/meetings.tsx),
   * which holds `value` at null permanently and treats every selection as
   * "add this person", so its null option is an invitation rather than a
   * state.
   */
  unassignedLabel?: string;
  /**
   * A Radix select trigger is a <button> whose only content is the current
   * value, so without one a screen reader (and any test looking it up by
   * name) sees whichever user happens to be selected -- see SelectTrigger's
   * own doc comment. Both of these are optional so the existing callers,
   * which sit inside labelled field wrappers, are unchanged.
   */
  ariaLabel?: string;
  testId?: string;
}

export function OwnerSelect({
  value, onChange, disabled = false, unassignedLabel = "Unassigned", ariaLabel, testId,
}: OwnerSelectProps) {
  const { data: users = [] } = useUsers();

  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(next) => onChange(next === UNASSIGNED ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger ariaLabel={ariaLabel} testId={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>{unassignedLabel}</SelectItem>
        {users.map((user) => (
          <SelectItem key={user.id} value={user.id}>
            {user.fullName ?? user.username}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
