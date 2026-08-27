import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogTrigger } from "./ui/dialog";
import { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "./ui/table";

export interface EntityTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export interface EntityTableProps<T extends { id: string }> {
  columns: EntityTableColumn<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  /** Called (debounced 200ms) whenever the filter input's text changes. */
  onQueryChange: (q: string) => void;
  /** Called immediately whenever the "Archived" toggle changes. */
  onArchivedChange: (archived: boolean) => void;
  /** Renders the "New" dialog's body. `close` closes the dialog on demand. */
  renderCreateDialog: (close: () => void) => ReactNode;
  /** Non-null shows a "Load more" button that calls onLoadMore. */
  nextCursor?: string | null;
  onLoadMore?: () => void;
  isLoading?: boolean;
}

/**
 * Generic list scaffold shared by the companies and contacts pages: a filter
 * input, an archived toggle, a "New" dialog, a table of rows, and pagination
 * via a "Load more" button. Pagination/query/archived state that needs to
 * survive across renders (accumulated rows, the cursor) lives in the calling
 * page, not here -- this component only owns the small, purely-local UI state
 * (draft filter text, whether the create dialog is open).
 *
 * Below the breakpoint the table reads as stacked cards. That took ONE change
 * here (the per-cell heading labels below) and one in ui/table.tsx, rather
 * than five in the pages, because the pages hand this component a `columns`
 * array and never touch the markup: companies, contacts and projects all get
 * the card layout without a line changing in any of them. See ui/table.tsx for
 * what the switch costs.
 */
export function EntityTable<T extends { id: string }>({
  columns,
  rows,
  onRowClick,
  onQueryChange,
  onArchivedChange,
  renderCreateDialog,
  nextCursor = null,
  onLoadMore,
  isLoading = false,
}: EntityTableProps<T>) {
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Debounce the filter input 200ms so a fast typist doesn't fire a network
  // request per keystroke; only the settled value is passed up.
  useEffect(() => {
    const timer = setTimeout(() => onQueryChange(q), 200);
    return () => clearTimeout(timer);
    // onQueryChange is expected to be stable enough per render that including
    // it would just re-arm the same timer; only q should reset the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div data-testid="entity-table" className="flex flex-col gap-4">
      {/*
        Below the breakpoint the filter takes the whole first line and the
        toggle and New wrap under it: at 375px the three of them share 327px,
        which leaves the field about 150px -- narrower than most of what gets
        typed into it.
      */}
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <Input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Filter..."
          aria-label="Filter"
          className="max-w-xs max-md:max-w-none"
        />
        {/* The label is the touch target, not the 13px box inside it. */}
        <label className="flex items-center gap-2 text-sm text-slate-600 max-md:min-h-11">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              onArchivedChange(event.target.checked);
            }}
          />
          Archived
        </label>
        <div className="flex-1" />
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>New</Button>
          </DialogTrigger>
          <DialogContent>{renderCreateDialog(() => setCreateOpen(false))}</DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableHeaderCell key={column.key}>{column.header}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              data-testid={`row-${row.id}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "cursor-pointer" : undefined}
            >
              {columns.map((column) => (
                <TableCell key={column.key}>
                  {/*
                    The column heading, repeated per cell and shown only where
                    the heading row is not: ui/table.tsx turns the table into
                    stacked cards below the breakpoint and hides <thead>, which
                    would otherwise leave a bare "--" or a bare date with
                    nothing saying what it is.

                    A rendered element rather than a `content: attr(...)`
                    pseudo, because a pseudo-element's generated text is read
                    by some screen readers and not others, and this IS the
                    field's name once the heading row is gone. On a desktop it
                    is display:none, which takes it out of the accessibility
                    tree entirely -- the heading row is doing the job there.
                  */}
                  <span className="text-xs font-medium uppercase text-slate-400 md:hidden">{column.header}</span>
                  {column.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell className="text-slate-400" colSpan={columns.length}>
                {isLoading ? "Loading..." : "No results"}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {nextCursor !== null && (
        <div>
          <Button variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
