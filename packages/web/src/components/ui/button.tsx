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
        "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
