import type { ReactNode } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { clsx } from "clsx";

export const Tabs = RadixTabs.Root;

/**
 * THE STRIP SCROLLS BELOW THE BREAKPOINT, because the record rail's five tabs
 * do not fit and never did.
 *
 * Measured on the live app: Timeline/Notes/Files/Mail/Meetings have a fixed
 * intrinsic width of 349px -- fixed because each label is one unbreakable
 * word, so shrinking a trigger cannot make it narrower than its text. Against
 * <main>'s 327px content box at 375px that is a 22px spill; at 360px, the
 * commonest Android width, the spill becomes a horizontal scroll of the whole
 * page and the Meetings tab leaves the screen, which is a capability the phase
 * says must not be desktop-only.
 *
 * The overflow is deliberately NOT fixed above the breakpoint even though it
 * exists there too (the rail is a third of the page: 328px at 1280px, so the
 * same 21px spills into <main>'s right padding and all five tabs stay on
 * screen). That is pre-existing desktop behaviour and this phase may not
 * change it.
 */
export function TabsList({ children }: { children: ReactNode }) {
  return (
    <RadixTabs.List className="flex gap-1 border-b border-slate-200 max-md:overflow-x-auto">
      {children}
    </RadixTabs.List>
  );
}

export function TabsTrigger({
  value, children, testId,
}: {
  value: string;
  children: ReactNode;
  /** Only where a test needs to reach one specific tab -- the trigger's own
   * text is otherwise enough to find it by role. */
  testId?: string;
}) {
  return (
    <RadixTabs.Trigger
      value={value}
      data-testid={testId}
      className={clsx(
        "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500",
        "hover:text-slate-900 data-[state=active]:border-slate-900 data-[state=active]:text-slate-900",
        // The 44px floor (a tab trigger is one of the four things the phase
        // names), plus the shrink-0 that makes the strip above actually
        // scrollable: without it a flex item in a scroll container is still
        // free to be squeezed towards its min-content width.
        "max-md:min-h-11 max-md:shrink-0",
      )}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RadixTabs.Content value={value} className="py-4 focus:outline-none">
      {children}
    </RadixTabs.Content>
  );
}
