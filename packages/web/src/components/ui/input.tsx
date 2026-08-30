import type { ComponentPropsWithRef } from "react";
import { clsx } from "clsx";

// THE 44px FLOOR IS SCOPED TO BELOW THE BREAKPOINT, NOT UNSCOPED. This element
// computes to 38px, and it is the same element as the desktop header's search
// box -- an unscoped floor would grow that too, which this phase may not do.
// Every other interactive primitive in this directory carries the floor in the
// same shape, and ui/ui.test.ts holds them all to it.
// `ComponentPropsWithRef` rather than `InputHTMLAttributes` so a caller can hold
// a ref to the element. React 19 passes `ref` as an ordinary prop, so the spread
// below already delivers it; only the TYPE had to admit it. Three callers need
// it, and all three are about focus going somewhere Radix would not have put
// it: components/contact-fields.tsx, which has to take it back from a Select
// that restores it to the trigger after the box has mounted; the mail
// composer's Subject field, which a dialog's onOpenAutoFocus focuses by hand;
// and components/search.tsx, which hands this element to the task drawer so
// the drawer's CLOSE can give the caret back to the box the search ran from.
export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return (
    <input
      className={clsx(
        "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 max-md:min-h-11",
        "placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
        "disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400",
        className,
      )}
      {...props}
    />
  );
}
