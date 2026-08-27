import type { ButtonHTMLAttributes } from "react";
import { clsx } from "clsx";

export type ButtonVariant = "default" | "outline" | "danger" | "ghost";

const variantClasses: Record<ButtonVariant, string> = {
  default: "bg-slate-900 text-white hover:bg-slate-700",
  outline: "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
  danger: "bg-red-600 text-white hover:bg-red-500",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// A native <button> with no explicit `type` defaults to "submit" inside a
// <form>, so any button here that omits `type` would submit the nearest form
// the moment Task 9's dialogs put Cancel/secondary buttons inside one.
// Defaulting to "button" makes that the safe default; a real submit button
// opts in explicitly with type="submit".
export function Button({ variant = "default", type = "button", className, ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        // The 44px floor below the breakpoint, and only there -- an unscoped
        // one would grow every desktop button. Callers that shrink a button
        // with their own px/py/text-xs (the meeting form's chips, the link
        // panel's) still clear the floor on a phone, because nothing here or
        // in those callers sets a height for the floor to argue with.
        "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium max-md:min-h-11",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
