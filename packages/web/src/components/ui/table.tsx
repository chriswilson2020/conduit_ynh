import type { HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes } from "react";
import { clsx } from "clsx";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className={clsx("w-full text-left text-sm text-slate-700", className)} {...props} />
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-200">{children}</tbody>;
}

// Spreads the rest of a native <tr>'s attributes (onClick, data-testid, ...)
// through: entity-table.tsx needs row click handling and per-row test ids,
// which a children/className-only signature couldn't carry.
export function TableRow({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={clsx("hover:bg-slate-50", className)} {...rest}>
      {children}
    </tr>
  );
}

export function TableHeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={clsx("px-4 py-2", className)}>{children}</th>;
}

// Spreads the rest of a native <td>'s attributes through, mirroring TableRow
// above -- entity-table.tsx's empty-state row needs colSpan to span every
// column.
export function TableCell({
  children,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { children: ReactNode }) {
  return (
    <td className={clsx("px-4 py-2", className)} {...rest}>
      {children}
    </td>
  );
}
