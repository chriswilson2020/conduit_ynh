import { userLabel } from "../lib";
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
   * A Radix select trigger is a <button> whose only content is the current
   * value, so without one a screen reader (and any test looking it up by
   * name) sees whichever user happens to be selected -- see SelectTrigger's
   * own doc comment. Both of these are optional so the existing callers,
   * which sit inside labelled field wrappers, are unchanged.
   */
  ariaLabel?: string;
  testId?: string;
}

/**
 * The owner/assignee FIELD: it reports who that is, including "Unassigned",
 * and every change is a new state for the record. A control that ADDS someone
 * and goes back to its invitation is a different thing and lives in
 * components/user-picker.tsx; this one was borrowed for that once, which is
 * why the null option's label used to be a prop.
 */
export function OwnerSelect({
  value, onChange, disabled = false, ariaLabel, testId,
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
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {users.map((user) => (
          <SelectItem key={user.id} value={user.id}>
            {userLabel(user, "")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
