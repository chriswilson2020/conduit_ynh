import type { ComponentPropsWithoutRef, ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-slate-900/40" />
      <RadixDialog.Content
        className={clsx(
          "fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
          "rounded-lg bg-white p-6 shadow-lg focus:outline-none",
          className,
        )}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * Right-side drawer variant of DialogContent, for the task drawer (Task 8):
 * fixed to the right edge, full viewport height, ~28rem wide, sliding in
 * from off-screen rather than scaling up from the page centre. Radix's
 * Content only mounts while `open` is true (no `forceMount`), so this only
 * animates the OPEN transition (translate-x-full -> translate-x-0) -- a
 * closing drawer simply unmounts, which is an acceptable simplification over
 * a full enter/exit Presence setup for a v1. Everything else (Overlay,
 * focus trap, Escape/outside-click close) is identical to DialogContent
 * above; this only differs in Content's own positioning classes.
 */
export function DrawerContent({
  children,
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof RadixDialog.Content>) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-slate-900/40" />
      <RadixDialog.Content
        className={clsx(
          "fixed inset-y-0 right-0 flex h-full w-full max-w-md flex-col overflow-y-auto",
          "bg-white shadow-xl focus:outline-none",
          "translate-x-full transition-transform duration-200 ease-out data-[state=open]:translate-x-0",
          className,
        )}
        {...rest}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <RadixDialog.Title className="text-lg font-semibold text-slate-900">{children}</RadixDialog.Title>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <RadixDialog.Description className="mt-1 text-sm text-slate-500">{children}</RadixDialog.Description>;
}
