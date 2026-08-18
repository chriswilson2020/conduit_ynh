import { useUsers } from "../queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// Radix Select reserves the empty string for "no selection", so null (the
// domain's "unassigned") needs a real sentinel value to round-trip through it.
const UNASSIGNED = "unassigned";

export interface OwnerSelectProps {
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
}

export function OwnerSelect({ value, onChange, disabled = false }: OwnerSelectProps) {
  const { data: users = [] } = useUsers();

  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(next) => onChange(next === UNASSIGNED ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {users.map((user) => (
          <SelectItem key={user.id} value={user.id}>
            {user.fullName ?? user.username}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
