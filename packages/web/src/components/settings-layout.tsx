import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// activeProps.className REPLACES the base className (see shell.tsx's own note
// on the same Link behaviour), so each of these is a complete class list, not
// a base plus an "active" fragment.
const tabClass =
  "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-900";
const activeTabClass = "border-b-2 border-slate-900 px-3 py-2 text-sm font-medium text-slate-900";

/**
 * The Settings area's frame: a title and the two-tab nav every settings page
 * renders inside. Deliberately plain -- router Links styled as tabs rather
 * than Radix Tabs (components/ui/tabs.tsx), because these tabs ARE routes:
 * each has its own URL, back/forward works, and a bookmark lands on the right
 * one. A Tabs component would own that selection state locally and fight the
 * router for it.
 */
export function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
      <nav data-testid="settings-nav" className="flex gap-1 border-b border-slate-200">
        <Link to="/settings/mail" className={tabClass} activeProps={{ className: activeTabClass }}>
          Mail accounts
        </Link>
        <Link to="/settings/templates" className={tabClass} activeProps={{ className: activeTabClass }}>
          Email templates
        </Link>
      </nav>
      {children}
    </div>
  );
}
