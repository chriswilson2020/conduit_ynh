import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// activeProps.className replaces (rather than merges with) the base className
// on the wire, so each string below is complete on its own -- not a base plus
// an appended "active" fragment.
const navLinkClass =
  "block rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white";
const activeNavLinkClass = "block rounded-md px-3 py-2 text-sm font-medium bg-slate-800 text-white";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="shell" className="flex min-h-screen bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col bg-slate-900 text-white">
        <div className="px-4 py-5 text-lg font-semibold tracking-tight">Conduit</div>
        <nav className="flex flex-col gap-1 px-2">
          <Link to="/companies" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
            Companies
          </Link>
          <Link to="/contacts" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
            Contacts
          </Link>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3">
          {/* Global search lands here in Task 10 (right rail + search UI). */}
          <div data-testid="search-slot" className="max-w-md flex-1" />
        </header>
        <main className="flex-1 overflow-auto px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
