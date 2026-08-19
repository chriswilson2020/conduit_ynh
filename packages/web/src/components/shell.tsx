import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { GlobalSearch } from "./search";
import { useSseInvalidation } from "./sse";

// activeProps.className replaces (rather than merges with) the base className
// on the wire, so each string below is complete on its own -- not a base plus
// an appended "active" fragment.
const navLinkClass =
  "block rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white";
const activeNavLinkClass = "block rounded-md px-3 py-2 text-sm font-medium bg-slate-800 text-white";

export function Shell({ children }: { children: ReactNode }) {
  // Mounted once here (Shell wraps every route, see router.tsx's
  // RootComponent), not per-page: one EventSource per browser tab, live for
  // as long as the app is open, not re-opened on every navigation.
  useSseInvalidation();

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
          <Link to="/pipelines" className={navLinkClass} activeProps={{ className: activeNavLinkClass }}>
            Pipelines
          </Link>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-6 py-3">
          <div className="max-w-md flex-1">
            <GlobalSearch />
          </div>
        </header>
        <main className="flex-1 overflow-auto px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
