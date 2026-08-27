import type { InputHTMLAttributes } from "react";
import { clsx } from "clsx";

// THE 44px FLOOR IS SCOPED TO BELOW THE BREAKPOINT, NOT UNSCOPED. This element
// computes to 38px, and it is the same element as the desktop header's search
// box -- an unscoped floor would grow that too, which this phase may not do.
// Every other interactive primitive in this directory carries the floor in the
// same shape, and ui/ui.test.ts holds them all to it.
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
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
