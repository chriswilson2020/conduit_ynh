import type { ReactNode } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { clsx } from "clsx";

export const Tabs = RadixTabs.Root;

export function TabsList({ children }: { children: ReactNode }) {
  return <RadixTabs.List className="flex gap-1 border-b border-slate-200">{children}</RadixTabs.List>;
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
