import type { HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes } from "react";
import { clsx } from "clsx";

/**
 * BELOW THE BREAKPOINT THIS STOPS BEING A TABLE and becomes a list of stacked
 * cards, by turning every table box into a block. Three column headings and a
 * grid of narrow cells carry no meaning at 375px; the projects list has five
 * columns and cannot be read there at all.
 *
 * Restyling ONE DOM was chosen over rendering a table and a card list side by
 * side, each hidden at the other's width, for the same reason shell.tsx
 * branches in JS rather than in CSS: two rendered copies means two elements
 * carrying every `row-<id>` testid, and e2e/crm.spec.ts addresses those by
 * testid and would hit a Playwright strict-mode violation. One DOM, two
 * layouts, one of each testid.
 *
 * WHAT THIS COSTS, said plainly: changing `display` on a table element drops
 * its table semantics in every engine, so below the breakpoint a screen reader
 * stops hearing rows and cells. That is intended rather than tolerated -- a
 * one-column card list is not a table, and announcing it as one would be the
 * lie. The per-cell labels entity-table.tsx renders in the same breath are
 * what replace the column headings the reader can no longer reach.
 */
export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className={clsx("w-full text-left text-sm text-slate-700 max-md:block", className)} {...props} />
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500 max-md:hidden">{children}</thead>
  );
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-200 max-md:block">{children}</tbody>;
}

// Spreads the rest of a native <tr>'s attributes (data-testid, ...) through:
// entity-table.tsx needs per-row test ids, which a children/className-only
// signature couldn't carry.
//
// It needed ROW CLICK HANDLING too until v1.2.0, when the row became a link
// (see components/row-link.ts). Nothing passes an onClick now; the spread is
// kept because the test id still needs it, not because a handler might come
// back.
export function TableRow({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr className={clsx("hover:bg-slate-50 max-md:block max-md:py-2", className)} {...rest}>
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
    <td className={clsx("px-4 py-2 max-md:flex max-md:justify-between max-md:gap-3 max-md:py-1", className)} {...rest}>
      {children}
    </td>
  );
}
