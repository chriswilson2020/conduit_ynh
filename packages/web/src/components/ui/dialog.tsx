import type { ReactNode } from "react";
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

export function DialogTitle({ children }: { children: ReactNode }) {
  return <RadixDialog.Title className="text-lg font-semibold text-slate-900">{children}</RadixDialog.Title>;
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <RadixDialog.Description className="mt-1 text-sm text-slate-500">{children}</RadixDialog.Description>;
}
