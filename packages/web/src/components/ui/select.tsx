import type { ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { clsx } from "clsx";

export const Select = RadixSelect.Root;
export const SelectValue = RadixSelect.Value;

/**
 * `ariaLabel` matters more here than on a plain input: a Radix select trigger
 * is a <button> whose only content is the CURRENT VALUE, so without one a
 * screen reader (and any test looking it up by name) sees "tls" rather than
 * "IMAP security". `testId` is optional and only used where the trigger is
 * not already inside a testid'd field wrapper.
 */
export function SelectTrigger({
  children,
  className,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <RadixSelect.Trigger
      aria-label={ariaLabel}
      data-testid={testId}
      className={clsx(
        "inline-flex w-full items-center justify-between rounded-md border border-slate-300",
        "bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-500",
        "max-md:min-h-11",
        className,
      )}
    >
      {children}
      <RadixSelect.Icon className="ml-2 text-slate-400">{"\u25BE"}</RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

/**
 * `position` is Radix's own, forwarded for the one caller that cannot use the
 * default: item-aligned positioning is computed from the SELECTED item, and
 * components/user-picker.tsx is pinned at "no selection" by design AND can
 * legitimately offer nothing, which is the case where Radix has no item to
 * position against and leaves the popup unplaced. Fields keep the default,
 * which lines the current value up with the trigger; "popper" anchors the
 * list under the trigger instead, with a small offset so it does not sit on
 * top of it.
 */
export function SelectContent({
  children,
  position,
}: {
  children: ReactNode;
  position?: "item-aligned" | "popper";
}) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position={position}
        sideOffset={position === "popper" ? 4 : undefined}
        className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-md"
      >
        <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

export function SelectItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RadixSelect.Item
      value={value}
      className={clsx(
        "cursor-pointer rounded px-2 py-1.5 text-sm text-slate-900 outline-none",
        "data-[highlighted]:bg-slate-100 data-[state=checked]:font-medium",
        // A menu item is one of the four things the phase names for the 44px
        // floor. min-h alone would leave the label pinned to the top of a
        // taller box, so the phone form is also a centring flex row.
        "max-md:flex max-md:min-h-11 max-md:items-center",
      )}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
}
